/**
 * The API surface.
 *
 * Reads are plain GETs. Writes are POSTs that require the `--allow-writes`
 * flag, a same-origin request and an `x-phase-console` header — a browser will
 * not send that header cross-origin without a CORS preflight, and no CORS
 * headers are ever sent, so another site cannot drive this server.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

import { HookPayloadError, HookRateError, PhaseClaimedError, RecoveryBusyError, type Service } from '../service.ts';
import { classify as classifyAccess } from './access.ts';
import { agentEnabled, checkRoot, gitDoorRefusal, listDirs } from '../config.ts';
import { fromAutomation } from '../../shared/automation-model.js';
import { buildAgentLaunch, type ResumeTarget } from '../agent.ts';
import { parseRecoveryRequest, type RecoveryFacts } from '../recovery.ts';
import { parseQaRequest, type QaFacts } from '../qa-session.ts';
import { isClientDisconnect, log } from '../log.ts';
import { EFFORTS, isEffort, PERMISSION_MODES } from '../runner/spawn.ts';
import {
  DEFAULT_PERMISSION_PROFILE, isPermissionProfile, type PolicyScope,
} from '../runner/approvals.ts';
import { QA_FIX_STRATEGIES, type QaFixStrategy } from '../../shared/run-settings.js';
import { PUSH_ACTION_TTL_MS, readActionToken } from '../push/actions.ts';
import { MODEL_FALLBACK as MODELS } from '../runner/errors.ts';
import { isKnownModel } from '../runner/models.ts';
import { planWrite, runWrite, openInEditor, WriteError, type WriteRequest } from '../writes.ts';
import { TERMINAL_PATH, type LaunchSpec } from '../terminal.ts';
import { tailscaleStatus } from '../tailscale.ts';
import { ACCOUNT_ID_RE, DEFAULT_ACCOUNT_ID } from '../accounts/index.ts';
import { searchCatalog } from '../mcp/index.ts';
import { MCP_ID_RE } from '../mcp/store.ts';
import { isMcpPolicy, isOnLimitPolicy, type PhaseOptions } from '../runner/state.ts';
import { METRICS_CONTENT_TYPE } from '../analysis/metrics.ts';
import { debugFor } from '../debug/deps.ts';
import { isRunId, isSlug, parseDebugQuery } from '../debug/index.ts';
import type { DebugEntry } from '../debug/sources.ts';
import { sendBody } from '../http/compress.ts';
import { RUN_PRIORITIES, type RunPriority } from '../../shared/orchestration-model.js';
import { ULTRA_REVIEW_MODES, type UltraReviewMode } from '../../shared/run-lifecycle.js';
import { PLAN_INCLUDES, STATE_INCLUDES, parseInclude } from '../../shared/projection.js';
import {
  ISOLATED, ISOLATION_MODES, SETTLE_STRATEGIES,
  type IsolationMode, type SettleStrategy,
} from '../../shared/worktree-model.js';
import { QA_DIRECTIVES } from '../../shared/plan-vocab.js';

export type ApiContext = { service: Service };

/**
 * How often a follow-tail looks for new rows, and how many it may send per
 * pass.
 *
 * Two seconds is under the threshold where a log stops feeling live and well
 * over the cost of one bounded tail read; the row cap keeps a burst (a lane
 * that just wrote four hundred journal lines) from arriving as one frame the
 * client renders in a single paint.
 */
const DEBUG_TAIL_MS = 2000;
const DEBUG_TAIL_ROWS = 200;

/**
 * What a reader may keep, and for how long.
 *
 * `no-store` was the blanket answer, and it is the right one for a mutation's
 * receipt, an error, or anything carrying a token. It is the wrong one for a
 * read: `no-store` forbids the browser from keeping the body at all, so it can
 * never send an `If-None-Match`, so the `ETag` below could never be acted on
 * and `GET /api/plans/<slug>` would keep costing 288 KB to answer "nothing
 * changed".
 *
 * `private, no-cache` is the pair that fixes it without loosening freshness by
 * one millisecond: `no-cache` means REVALIDATE BEFORE EVERY USE — the browser
 * still asks on every read and still shows only what this server just
 * confirmed — and `private` keeps the body out of any shared cache, which
 * matters on `--remote`, where the reader is a phone across a tailnet.
 *
 * Applied only to a 200 answering a GET. A POST's response is a receipt for
 * something that already happened; a 4xx is not an entity worth revalidating.
 */
function cacheControl(res: ServerResponse, status: number): string {
  const req = (res as ServerResponse & { req?: IncomingMessage }).req;
  return status === 200 && req?.method === 'GET' ? 'private, no-cache' : 'no-store';
}

function json(res: ServerResponse, status: number, body: unknown): void {
  // `?? 'null'`: `JSON.stringify(undefined)` is `undefined`, and the old
  // `Buffer.byteLength` of that threw a TypeError from inside the responder —
  // a 500 with no body, for a route that meant to answer 200.
  const encoded = JSON.stringify(body) ?? 'null';
  sendBody(res, status, Buffer.from(encoded, 'utf8'), {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cacheControl(res, status),
  }, { revalidate: true });
}

function text(res: ServerResponse, status: number, body: string): void {
  sendBody(res, status, Buffer.from(String(body ?? ''), 'utf8'), {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': cacheControl(res, status),
  }, { revalidate: true });
}

/**
 * A file from disk, as a download.
 *
 * `application/octet-stream` for everything, deliberately: a `.patch` is text
 * and a browser would happily render it, but the point of the landing packet
 * is that the operator ends up with FILES they can hand to git. The caller has
 * already checked the path against the packet's manifest — this function does
 * no resolution of its own, so there is exactly one place where "is this name
 * allowed" is decided.
 */
function sendFile(res: ServerResponse, file: string, name: string): void {
  let body: Buffer;
  try {
    body = readFileSync(file);
  } catch {
    json(res, 404, { error: 'That file is no longer on disk. Compose the packet again.' });
    return;
  }
  // Only the basename reaches the header, and only characters a filename can
  // safely carry: a header value cannot contain a newline or a quote without
  // becoming a different header.
  const filename = (name.split('/').pop() ?? 'download').replace(/[^A-Za-z0-9._-]+/g, '-');
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
    'content-length': body.length,
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

/** A write must come from this app, in this browser, with writes enabled. */
function guardWrite(req: IncomingMessage, service: Service): string | null {
  return guardMutation(req, service.flags.allowWrites
    ? null
    : 'Writes are disabled. Restart with --allow-writes to enable them.');
}

/**
 * Starting a run is its own decision. `--allow-writes` scaffolds a file;
 * `--allow-run` spawns agent sessions that edit a repository unattended, so it
 * is a separate flag and a separate guard rather than a wider reading of one.
 */
function guardRun(req: IncomingMessage, service: Service): string | null {
  return guardMutation(req, service.flags.allowRun
    ? null
    : 'Runs are disabled. Restart with --allow-run to enable the autopilot.');
}

/**
 * The shell gate — a third capability, not a wider reading of the other two.
 *
 * `--allow-run` spawns an agent inside a permission policy this console
 * enforces and can revoke; `--allow-terminal` hands over a shell where the only
 * policy is the person typing. Minting a ticket is also the only place the
 * cross-site check can be made — the WebSocket upgrade that follows cannot make
 * it, because CORS does not apply to upgrades and Origin is forgeable there.
 */
function guardTerminal(req: IncomingMessage, service: Service): string | null {
  return guardMutation(req, service.flags.allowTerminal
    ? null
    : 'The terminal is disabled. Restart with --allow-terminal to enable it.');
}

/**
 * The agent gate — a fourth capability, again not a wider reading of any
 * other. An agent session is an interactive `claude` under the person's own
 * eyes: its argv is server-built from allowlisted fields (`agent.ts`) and the
 * CLI asks before it acts, which is less than a raw shell hands over and more
 * than the autopilot's policy allows. `agentEnabled()` rather than the flag,
 * so folding the capability into `--allow-terminal` stays a one-line change.
 */
function guardAgent(req: IncomingMessage, service: Service): string | null {
  return guardMutation(req, agentEnabled(service.flags)
    ? null
    : 'Agent sessions are disabled. Restart with --allow-agent to enable them.');
}

/**
 * The accounts gate — a fifth capability. Registering a Claude account stores
 * a credential (a profile login, a pasted token) that runs can then spend
 * quota as; holding credentials is its own decision, so it is its own flag.
 * READING the list and the meters is deliberately not behind it.
 */
function guardAccounts(req: IncomingMessage, service: Service): string | null {
  return guardMutation(req, service.flags.allowAccounts
    ? null
    : 'Account registration is disabled. Restart with --allow-accounts to enable it.');
}

/**
 * For verbs on an EXISTING session of either kind — reattach, close. Either
 * capability opens the door; `mint()` still gates by the session's own kind,
 * so an agent-only console can never be talked into handing out a live shell.
 */
function guardAnySession(req: IncomingMessage, service: Service): string | null {
  // `allowAccounts` opens this door too, because a login terminal is a session
  // an accounts-only console legitimately minted. The per-KIND decision still
  // happens inside `mint()` — a shell or a free-form agent session is refused
  // there regardless of which flag admitted the caller here.
  return guardMutation(
    req,
    (service.flags.allowTerminal || agentEnabled(service.flags) || service.flags.allowAccounts)
      ? null
      : 'The terminal is disabled. Restart with --allow-terminal to enable it.',
  );
}

/**
 * Registering an MCP server points this console's sessions at somebody else's
 * tools, whose descriptions enter the prompt and whose results a model acts on.
 * Its own flag, for the same reason accounts have one. READING the registry,
 * the catalog and the connection statuses is not gated — seeing what your own
 * sessions connect to is display.
 */
function guardMcp(req: IncomingMessage, service: Service): string | null {
  return guardMutation(req, service.flags.allowMcp
    ? null
    : 'MCP registration is disabled. Restart with --allow-mcp to enable it.');
}

/**
 * The webhook gate — a seventh capability, and the only one that points OUT.
 *
 * The other six widen what may happen on this machine. This one makes the
 * console POST to a URL somebody typed, unattended, on every matching event,
 * from inside whatever network the laptop is on. Registering the URL is
 * therefore the gated act; READING the registered list is not, for the same
 * reason the MCP registry and the account list are readable — seeing where your
 * own console would speak is display, and the URLs are never served back.
 *
 * The flag is checked again at delivery (`Webhooks#announce`), so this guard
 * being wrong could at worst let a row be written, never let one be sent.
 */
function guardWebhooks(req: IncomingMessage, service: Service): string | null {
  return guardMutation(req, service.flags.allowWebhooks
    ? null
    : 'Webhooks are disabled. Restart with --allow-webhooks to enable them.');
}

/**
 * The cross-site check on its own, for POSTs that are not a capability.
 *
 * Choosing a source directory and saving a theme both have to work in a
 * read-only console, so neither belongs behind `--allow-writes`. They still
 * must not be drivable by another page, which is what this is.
 */
function guardCsrf(req: IncomingMessage): string | null {
  return guardMutation(req, null);
}

function guardMutation(req: IncomingMessage, disabled: string | null): string | null {
  if (disabled) return disabled;
  if (req.headers['x-phase-console'] !== '1') return 'Missing console header.';
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers.host ?? '';
    try {
      if (new URL(origin).host !== host) return 'Cross-origin write refused.';
    } catch { return 'Bad origin.'; }
  }
  return null;
}

/**
 * The keys that make a mark-read request *scoped*.
 *
 * Presence, not usefulness: see the note at the call site. A body carrying any
 * of these is asking about something in particular, and must never be answered
 * by clearing the whole inbox.
 */
const SCOPE_KEYS = ['slug', 'category', 'runId', 'sessionId', 'phase'] as const;

/**
 * An account choice a browser sent. Checked against the instance's own
 * registry rather than passed through, because the value becomes a child
 * process's environment: a known id, the literal `auto` (the service resolves
 * it against the cached meters), or nothing — never an arbitrary string.
 */
function accountChoice(value: unknown, service: Service): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  if (value === 'auto') return 'auto';
  if (value === DEFAULT_ACCOUNT_ID) return DEFAULT_ACCOUNT_ID;
  return ACCOUNT_ID_RE.test(value) && service.accounts.has(value) ? value : undefined;
}

/**
 * MCP server ids from the browser, checked against the LIVE registry.
 *
 * Never passed through, for the same reason `accountChoice` is not: the value
 * becomes part of a child process's configuration. An id that no longer
 * resolves is dropped here rather than parked on later — the browser's list may
 * simply be a few seconds stale, and silently attaching nothing would be worse
 * than either. What a PLAN names is a different matter and is checked at
 * boarding, where the operator can be told which server is missing.
 */
function mcpList(value: unknown, service: Service): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value
    .filter((id): id is string => typeof id === 'string' && MCP_ID_RE.test(id))
    .filter((id) => service.mcp.isEnabled(id));
  return [...new Set(ids)];
}

/** Env maps cross into `LaunchSpec.env`, which is `Record<string, string>`. */
function toStringEnv(env: NodeJS.ProcessEnv | null): Record<string, string> | null {
  if (!env) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The phase a run control was aimed at, when it named one.
 *
 * Absent means "whatever is running", which is what every control meant before
 * they could be aimed — so an omitted or unusable value must read as null and
 * never as phase 0. The service compares it against the live child and refuses
 * by name rather than acting on whichever phase happens to be running now.
 */
function targetPhase(body: Record<string, unknown>): number | null {
  const n = Number(body.phase);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** A phase list from a browser: whole positive integers only, deduped, capped. */
function phaseList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const phases = [...new Set(value.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  return phases.slice(0, 500);
}

/**
 * The client's idempotency key for a write to a live session.
 *
 * Read from the header first because that is where the convention lives, and
 * from the body as a fallback so a `curl` or `bin/btw` can send one too. Kept
 * short and to a safe alphabet: it is used as a map key and echoed back.
 */
function idempotencyKey(req: IncomingMessage, body: Record<string, unknown>): string | undefined {
  const raw = req.headers['idempotency-key'] ?? body.key;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const key = value.trim().slice(0, 100);
  return /^[\w.:-]{8,100}$/.test(key) ? key : undefined;
}

/** A skill id: what `/name` or `/plugin:name` accepts, and nothing else. */
const SKILL_ID = /^[a-z0-9][\w.-]{0,63}(:[a-z0-9][\w.-]{0,63})?$/i;

function skillList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((v): v is string => typeof v === 'string' && SKILL_ID.test(v)))].slice(0, 40);
}

/**
 * A model name from a browser, or the reason it is not one.
 *
 * `isKnownModel` and not membership of `MODELS`. `MODELS` is the escalation
 * ladder — four bare aliases, strongest first — and using it as the door's
 * allow-list rejected `claude-opus-5`, the spelling the CLI's own `--help`
 * offers as its example, and `opus[1m]`, the only way to ask for the 1M
 * window. Worse, the two doors disagreed about the refusal: the agent launcher
 * answered 400 while a per-phase override was dropped in silence and the phase
 * ran on the run's default, with nothing anywhere saying so.
 */
function modelProblem(value: unknown, field = 'model'): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return `${field} must be a string.`;
  if (!isKnownModel(value)) {
    return `${field} must name a Claude model: an alias (${MODELS.join(', ')}), a full id `
      + `(claude-opus-5), or either with the 1M window suffix (opus[1m]).`;
  }
  return null;
}

/** An effort level from a browser, or the reason it is not one. */
function effortProblem(value: unknown, field = 'effort'): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (!isEffort(value)) return `${field} must be one of: ${EFFORTS.join(', ')}.`;
  return null;
}

/**
 * A whole number in range, or the reason it is not one.
 *
 * Explicitly rejecting rather than coercing, because `Number(undefined)` is
 * NaN and `Number('')` is 0 — both of which used to reach the runner as a
 * setting the operator never chose.
 */
function intProblem(value: unknown, field: string, min: number, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  // `max` guarded: it comes from `flags.maxSessions`, and a comparison against
  // an undefined ceiling is silently `false` — i.e. no ceiling at all, which
  // is the opposite of what a clamp is for.
  const ceiling = Number.isFinite(max) ? max : min;
  if (!Number.isInteger(n) || n < min || n > ceiling) {
    return `${field} must be a whole number between ${min} and ${ceiling}.`;
  }
  return null;
}

/**
 * How much operator prose one attempt's addendum may carry.
 *
 * Generous — it is a paragraph or two of instruction, not a document — but
 * bounded, because it is written into a run checkpoint that is re-read and
 * re-serialised on every tick, and an unbounded string on that path is a way to
 * make a console slow that nobody would ever look for.
 */
const ADDENDUM_MAX = 8_000;

/**
 * The first thing wrong with a per-phase options object, or null.
 *
 * `phaseOptions()` below still filters — defence in depth, since it is what
 * actually builds the argv — but a filter alone means a typo disappears
 * quietly. This runs first so the browser is told.
 */
function phaseOptionsProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 500)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const problem = modelProblem(item.model, `phase ${key} model`)
      ?? effortProblem(item.effort, `phase ${key} effort`);
    if (problem) return problem;
    if (item.autoApprove !== undefined && typeof item.autoApprove !== 'boolean') {
      return `phase ${key} autoApprove must be true or false.`;
    }
  }
  return null;
}

/**
 * Per-phase choices from a browser.
 *
 * Everything is checked against a known set rather than passed through: these
 * values end up in a child process's argv, so "whatever the client sent" is not
 * an acceptable definition of any of them.
 */
function phaseOptions(value: unknown, service: Service): Record<string, PhaseOptions> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, PhaseOptions> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 500)) {
    const phase = Number(key);
    if (!Number.isInteger(phase) || phase <= 0) continue;
    const option = onePhaseOptions(raw, service);
    if (Object.keys(option).length) out[String(phase)] = option;
  }
  return out;
}

/**
 * ONE phase's choices, coerced.
 *
 * Lifted out of `phaseOptions` when Retry-with-edits arrived needing exactly
 * this and nothing else. Not duplicated: a second copy of a coercion table
 * whose whole job is to keep unvetted values out of a child's argv is a second
 * place for a field to be forgotten, and the field that gets forgotten is the
 * one nobody thought was dangerous.
 */
function onePhaseOptions(raw: unknown, service: Service): PhaseOptions {
  const option: PhaseOptions = {};
  if (!raw || typeof raw !== 'object') return option;
  const item = raw as Record<string, unknown>;
  if (typeof item.model === 'string' && isKnownModel(item.model)) option.model = item.model;
  if (isEffort(item.effort)) option.effort = item.effort;
  if (typeof item.permissionMode === 'string'
      && (PERMISSION_MODES as readonly string[]).includes(item.permissionMode)) {
    option.permissionMode = item.permissionMode;
  }
  if (Array.isArray(item.tools)) {
    const tools = item.tools.filter((t): t is string => typeof t === 'string' && /^[A-Za-z_][\w]{0,63}$/.test(t));
    if (tools.length) option.tools = [...new Set(tools)].slice(0, 40);
  }
  const skills = skillList(item.skills);
  if (skills?.length) option.skills = skills;
  // Only ever written when true: `skillsOff: false` and absent mean the same
  // thing, and storing the false would put a key in every phase's options and
  // make the emptiness check in `phaseOptions` claim the operator chose something.
  if (item.skillsOff === true) option.skillsOff = true;
  const servers = mcpList(item.mcpServers, service);
  if (servers?.length) option.mcpServers = servers;
  // Only ever written when true, exactly as `skillsOff` is and for the same
  // reason: a stored `false` would claim the operator chose something.
  if (item.mcpOff === true) option.mcpOff = true;
  // Both values are stored here, unlike `mcpOff` — because this is the ONE
  // level that can overrule the plan, and "the operator said continue for
  // this phase" has to be distinguishable from "nobody said anything", which
  // would fall through to a plan that says require.
  if (isMcpPolicy(item.mcpPolicy)) option.mcpPolicy = item.mcpPolicy;
  // Both values stored, same reasoning as `mcpPolicy` one line up: the phase
  // is the one level that can overrule the plan's and the console's answer,
  // so "ask me in this phase" (false) is a choice, never silence.
  if (typeof item.autoApprove === 'boolean') option.autoApprove = item.autoApprove;
  // Both values again, and for `autoApprove`'s reason: "fan out in this phase"
  // and "not in this phase" are each a choice about one phase's work, and
  // silence is what inherits the run's answer.
  if (typeof item.ultracode === 'boolean') option.ultracode = item.ultracode;
  return option;
}

/**
 * One of the words the run's cloud-review vocabulary holds, or nothing.
 *
 * Membership rather than a ternary chain, because the list is the owner's
 * (`shared/run-lifecycle.js`) and a route that spelled the words again would be
 * the copy `vocab-owners.test.ts` exists to prevent.
 */
function ultraReviewMode(value: unknown): UltraReviewMode | undefined {
  return typeof value === 'string' && (ULTRA_REVIEW_MODES as readonly string[]).includes(value)
    ? value as UltraReviewMode
    : undefined;
}

export async function handleApi(
  ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL,
): Promise<boolean> {
  const { service } = ctx;
  const path = url.pathname;
  if (!path.startsWith('/api/') && path !== '/events' && !path.startsWith('/hooks/')) return false;

  /* ---------------- the approval hook ---------------- */
  if (path === '/hooks/pre-tool-use') {
    // Deliberately not `guardWrite`: the caller is a `claude` child process,
    // which sends neither the console header nor an origin. Its credential is
    // the per-run bearer token, compared in constant time and dead the moment
    // the run ends.
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only' }); return true; }
    if (!service.approvals.verify(req.headers.authorization)) {
      log.warn('hook.rejected', { reason: service.approvals.armed() ? 'bad token' : 'no run is armed' });
      json(res, 401, { error: 'bad or expired run token' });
      return true;
    }
    // Authentication is unchanged — `verify` above still decides that. This
    // asks the second question the same token can answer: WHICH run sent it, so
    // the decision is made under that run's profile rather than under whichever
    // run happens to be current. One runner makes those the same; a pool does
    // not, and threading the id now is what keeps that change to one place.
    const hookRunId = service.approvals.runIdFor(req.headers.authorization);
    json(res, 200, await service.decideToolUse(await readBody(req), hookRunId));
    return true;
  }

  /* ---------------- the closeout (Stop) hook ---------------- */
  if (path === '/hooks/stop') {
    // Same trust model as the approval hook above: the caller is a `claude`
    // child, its credential is the per-run bearer token, and `guardWrite`
    // deliberately does not apply.
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only' }); return true; }
    if (!service.approvals.verify(req.headers.authorization)) {
      log.warn('hook.rejected', { reason: service.approvals.armed() ? 'bad token' : 'no run is armed' });
      json(res, 401, { error: 'bad or expired run token' });
      return true;
    }
    const stopRunId = service.approvals.runIdFor(req.headers.authorization);
    json(res, 200, await service.decideStop(await readBody(req), stopRunId));
    return true;
  }

  /* ---------------- the session-presence hook ---------------- */
  if (path === '/hooks/session') {
    // The caller is `scripts/session-hook.sh`, run by Claude Code for ANY
    // session on this machine — there is no run, so no run token; it is not a
    // browser, so no console header or origin. What it has instead: it is on
    // this machine. The console binds to 127.0.0.1, so every socket is
    // loopback; the one other way in is the `--remote` proxy, and a request
    // that arrived through it (the proxy's identity header, or a non-local
    // Host) is refused — presence forged from a phone could release a lock a
    // real session holds. Then the service caps the body and the rate.
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only' }); return true; }
    const remote = req.socket?.remoteAddress ?? '';
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === '';
    const verdict = classifyAccess(req, service.flags);
    if (!loopback || !verdict.ok || verdict.scope !== 'local') {
      log.warn('hook.session-rejected', { reason: !loopback ? 'not loopback' : 'not local', remote });
      json(res, 403, { error: 'session presence is accepted from this machine only' });
      return true;
    }
    try {
      const record = service.ingestSessionEvent(await readBody(req));
      json(res, 200, { ok: true, session: { sessionId: record.sessionId, presence: service.sessions.presence(record.sessionId) } });
    } catch (error) {
      if (error instanceof HookPayloadError) json(res, 400, { error: error.message });
      else if (error instanceof HookRateError) json(res, 429, { error: error.message });
      else throw error;
    }
    return true;
  }

  /* ---------------- live updates ---------------- */
  if (path === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    let closed = false;
    // Declared before `stop` can run: a client that vanishes between the header
    // and the first write makes `send` call `stop` immediately, and reaching a
    // `const` declared further down would be a ReferenceError inside the very
    // handler whose job is to survive dead clients.
    let ping: NodeJS.Timeout | undefined;
    let off: (() => void) | undefined;
    const stop = () => {
      if (closed) return;
      closed = true;
      if (ping) clearInterval(ping);
      off?.();
    };

    /**
     * A browser that navigated away, slept, or crashed leaves a socket that
     * fails under the next write. Unhandled, that is an uncaught exception per
     * dead client — so a write failure just retires this listener.
     */
    const send = (chunk: string): void => {
      if (closed || res.writableEnded || res.destroyed) { stop(); return; }
      try {
        res.write(chunk);
      } catch (error) {
        if (!isClientDisconnect(error)) log.warn('sse.write', { error });
        stop();
      }
    };

    // Replay anything the client missed while reconnecting. Browsers resend the
    // last id automatically, so a dropped connection costs no events — which
    // matters once a run is streaming phase progress through here.
    const lastSeen = Number(req.headers['last-event-id']);
    const missed = Number.isFinite(lastSeen) ? service.eventsSince(lastSeen) : [];

    send(`event: hello\ndata: ${JSON.stringify({
      generation: service.generation,
      cursor: service.eventCursor,
      replayed: missed.length,
    })}\n\n`);
    for (const item of missed) {
      send(`id: ${item.id}\nevent: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`);
    }

    off = service.onEvent((event, data, id) => {
      send(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
    ping = setInterval(() => send(': ping\n\n'), 25_000);
    // The client may already have gone during the replay above, in which case
    // `stop` ran before either of these existed. Retire them now.
    if (closed) { clearInterval(ping); off(); }

    res.on('error', (error) => {
      if (!isClientDisconnect(error)) log.warn('sse.socket', { error });
      stop();
    });
    res.on('close', stop);
    req.on('close', stop);
    req.on('error', stop);
    return true;
  }

  const segments = path.replace(/^\/api\//, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [head, ...rest] = segments;

  try {
    /* ---------------- session + source directory ---------------- */
    if (head === 'state' && req.method === 'GET') {
      json(res, 200, service.state(parseInclude(url.searchParams.get('include'), STATE_INCLUDES)));
      return true;
    }

    /* ---------------- session presence: the registry + the hook installer ---------------- */
    // `GET /api/sessions/registry`: every Claude session the hook reported for
    // this instance, with its presence and the plan+phase it works. Reading it
    // needs no flag — seeing who is in your repository is display.
    if (head === 'sessions' && rest[0] === 'registry' && req.method === 'GET') {
      json(res, 200, { sessions: service.sessionViews() });
      return true;
    }
    // `GET /api/converge`: the convergence loop's standing — on or off for this
    // console, the sweep interval, what is queued, and its last pass per plan
    // (the Pulse's convergence line). Display only: no flag.
    if (head === 'converge' && req.method === 'GET') {
      json(res, 200, service.convergeStatus());
      return true;
    }
    // `GET /api/hooks-install`: is the session-presence hook in ~/.claude/settings.json?
    // `POST /api/hooks-install {action: install|uninstall}`: write it (or take it out) —
    // a write OUTSIDE the console's own state, so `--allow-writes` gates it.
    if (head === 'hooks-install') {
      if (req.method === 'GET') { json(res, 200, service.hooksStatus()); return true; }
      if (req.method === 'POST') {
        const refused = guardWrite(req, service);
        if (refused) { json(res, 403, { error: refused }); return true; }
        const body = await readBody(req) as { action?: string };
        const action = body.action === 'uninstall' ? 'uninstall' : body.action === 'install' ? 'install' : null;
        if (!action) { json(res, 400, { error: 'action must be install or uninstall' }); return true; }
        try {
          json(res, 200, action === 'install' ? service.installSessionHook() : service.uninstallSessionHook());
        } catch (error) {
          json(res, 409, { error: (error as Error).message });
        }
        return true;
      }
      json(res, 405, { error: 'GET or POST' });
      return true;
    }

    if (head === 'fs' && req.method === 'GET') {
      json(res, 200, listDirs(url.searchParams.get('path') ?? ''));
      return true;
    }

    /* ---------------- the repository browse surface ---------------- */
    // `GET /api/repo/<surface>`: the git facts the Repo destination renders —
    // `targets` (which repositories may be asked about at all), `graph`,
    // `branches`, `checkouts`, `diff` and `settles`.
    //
    // No flag, for the same reason `sessions/registry` needs none: seeing the
    // history of the repository you pointed this console at is DISPLAY. The
    // reads themselves are fenced in `server/git-browse.ts` — an allowlist of
    // directories chosen from the console's own state rather than from the
    // query string, validation of every ref and path, argv arrays, a built
    // environment, and a truncation flag beside every list.
    //
    // `repo=` names a target BY KEY (`root`, or a path relative to it), never
    // by directory. An unknown key is a 404 rather than a silent fall back to
    // the root, which would render one repository's history under another's
    // name.
    if (head === 'repo' && req.method === 'GET') {
      const surface = rest[0] ?? '';
      const query = url.searchParams;
      const repo = query.get('repo') ?? undefined;
      const count = (name: string, floor = 1): number | undefined => {
        // 🔴 ABSENCE is tested BEFORE the coercion, and that order is the whole
        // point: `query.get` answers `null` for a parameter nobody sent, and
        // `Number(null)` is `0`. With a floor of 1 that fell out as `undefined`
        // by luck — but the moment `unified` was given a floor of 0 to let an
        // explicit `unified=0` through, an ABSENT `unified` became `0` too, and
        // every default patch came back with no context lines at all. Fixing a
        // Low created a High. (P8 QA round 2.) An empty value is absence for
        // the same reason: `Number('')` is also 0.
        const raw = query.get(name);
        if (raw === null || raw.trim() === '') return undefined;
        const value = Number(raw);
        return Number.isFinite(value) && value >= floor ? value : undefined;
      };

      if (surface === 'targets') {
        json(res, 200, { targets: await service.repoTargets() });
        return true;
      }

      if (surface === 'graph') {
        const graph = await service.repoGraph({
          repo,
          // Repeatable, and each one is checked for MEMBERSHIP of the
          // repository's own ref list downstream — a shape check alone would
          // still admit an arbitrary revision.
          refs: query.getAll('ref'),
          all: query.get('all') === '1',
          limit: count('limit'),
          cursor: query.get('cursor') ?? undefined,
        });
        if (graph === 'unknown-repo') { json(res, 404, { error: 'unknown repository' }); return true; }
        // Named refs, none of which this repository has. A 200 carrying the
        // DEFAULT graph would be a picture of something the caller did not ask
        // about. Partial resolution is a 200 — see `commitGraph`.
        if (!graph) { json(res, 400, { error: 'no such ref here' }); return true; }
        json(res, 200, graph);
        return true;
      }

      if (surface === 'branches') {
        const branches = await service.repoBranches(repo);
        if (!branches) { json(res, 404, { error: 'unknown repository' }); return true; }
        json(res, 200, branches);
        return true;
      }

      // Deliberately repository-WIDE and takes no `repo=`: the registry is one
      // fact about one object database, and asking it from a linked checkout
      // would return the same list under a different name.
      if (surface === 'checkouts') {
        const checkouts = await service.repoCheckouts();
        if (!checkouts) { json(res, 404, { error: 'no source directory' }); return true; }
        json(res, 200, checkouts);
        return true;
      }

      if (surface === 'diff') {
        const diff = await service.repoDiff({
          repo,
          base: query.get('base') ?? undefined,
          tip: query.get('tip') ?? undefined,
          path: query.get('path') ?? undefined,
          bytes: count('bytes'),
          // Floor ZERO, unlike every other count here: `--unified=0` is a real
          // and useful request (hunks with no context), and a `> 0` reader
          // dropped it as if it were a typo. (P8 QA round 1, Low.)
          unified: count('unified', 0),
        });
        if (diff === 'unknown-repo') { json(res, 404, { error: 'unknown repository' }); return true; }
        // One 400 for two causes — a ref that did not validate and a ref that
        // does not resolve here — on purpose: telling a caller WHICH of its
        // guesses had the right shape is an oracle for the next guess.
        if (!diff) { json(res, 400, { error: 'unusable range or path' }); return true; }
        json(res, 200, diff);
        return true;
      }

      if (surface === 'settles') {
        json(res, 200, service.repoSettles({
          limit: count('limit'),
          slug: query.get('slug') ?? undefined,
          runs: count('runs'),
          entries: count('entries'),
        }));
        return true;
      }

      json(res, 404, { error: 'unknown repository surface' });
      return true;
    }

    /* ---------------- the issue estate ---------------- */
    // `GET /api/issues` — every repository this console stands on with whatever
    // issues are cached for it, and `POST /api/issues/refresh` to go and ask.
    //
    // No flag on either, for the same reason the repo surface needs none:
    // reading the issues of the repositories you pointed this console at is
    // DISPLAY, and a refresh reaches GitHub read-only through `gh`, which holds
    // its own credentials. Minting a plan session FROM these issues is a
    // different act and stays behind the ticket door's `--allow-agent`.
    //
    // The GET never fetches, so it never blocks on the network: a board renders
    // at whatever age its data has, and that age is in the payload. The POST is
    // header-guarded like every other state-changing verb here, and single-
    // flighted downstream, so two browsers pressing Refresh is one `gh` call.
    if (head === 'issues') {
      if (req.method === 'GET') {
        json(res, 200, service.issues.list());
        return true;
      }
      if (req.method === 'POST' && rest[0] === 'refresh') {
        const refusal = guardCsrf(req);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        // A repository is named by its INVENTORY KEY — `root`, or the
        // root-relative submodule path — never by a directory and never by an
        // `owner/repo` the caller made up. An unknown key is a 404 rather than
        // a silent refresh of everything, which is the same rule the repo
        // surface follows and for the same reason.
        const key = typeof body.repo === 'string' && body.repo ? body.repo : undefined;
        const payload = await service.issues.refresh(key);
        if (payload === 'unknown-repo') { json(res, 404, { error: 'unknown repository' }); return true; }
        json(res, 200, payload);
        return true;
      }
      json(res, 405, { error: 'GET /api/issues or POST /api/issues/refresh' });
      return true;
    }

    if (head === 'root') {
      if (req.method === 'GET') {
        json(res, 200, checkRoot(url.searchParams.get('path') ?? ''));
        return true;
      }
      if (req.method === 'POST') {
        const refusal = guardCsrf(req);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        const path = String(body.path ?? '');
        // 409, not 400: the request is well-formed and the directory may be
        // perfectly valid. What is wrong is the state of THIS console — it
        // already belongs to another project — and a conflict is the status
        // that says so.
        const pinned = service.pinnedRefusal(path);
        if (pinned) { json(res, 409, { error: pinned, state: service.state() }); return true; }
        const check = service.open(path);
        json(res, check.ok ? 200 : 400, { check, state: service.state() });
        return true;
      }
    }

    if (head === 'prefs' && req.method === 'POST') {
      const refusal = guardCsrf(req);
      if (refusal) { json(res, 403, { error: refusal }); return true; }
      const body = await readBody(req);
      // The git door, asked of the RESULTING shape — but only when this patch
      // is about the git shape at all.
      //
      // 🔴 Judging every patch against the merged shape locked an install that
      // was ALREADY in the bad pair out of its own settings page: with
      // `isolation: worktree` and `default-branch` on disk, a patch changing
      // the QA default, a ladder cap or a notify category merged into a
      // refusable shape and 400'd, so the one population this door exists for
      // could change nothing at all. A door that refuses a setting nobody was
      // editing is not a guard, it is a lock.
      // Flattened FIRST, so the door sees an `automation.git` edit exactly as
      // it sees a flat one — `savePreferences` accepts either shape, and a
      // guard that only knew the flat spelling would be a wall with a gate
      // beside it.
      const raw = body as Record<string, unknown>;
      const patch = { ...fromAutomation(raw.automation), ...raw };
      if ('isolation' in patch || 'gitMode' in patch) {
        const shape = { ...service.prefs, ...patch };
        const bad = gitDoorRefusal(shape as { isolation?: string; gitMode?: string });
        if (bad) { json(res, 400, { error: bad }); return true; }
      }
      json(res, 200, service.savePreferences(body));
      return true;
    }

    /**
     * The answer to "your restart stopped these runs — shall I pick them up?"
     *
     * Run-class, like every other door that can start a session: answering
     * `continue` is asking this console to spend money, and the flag that
     * governs that is `--allow-run`. Answering `dismiss` needs the same flag
     * for a duller reason — a console that cannot run has nothing to dismiss,
     * so the question is never asked there in the first place.
     */
    if (head === 'boot-resume' && req.method === 'POST') {
      const refusal = guardRun(req, service);
      if (refusal) { json(res, 403, { error: refusal }); return true; }
      // `?? {}` because `readBody` answers `null` for an empty or unparseable
      // body, and a door that 500s on one is a door that reports a client's
      // typo as a server fault. (The same shape is reachable on many other
      // doors here and is not this phase's to fix; this one is new, so it
      // starts correct.)
      const body = (await readBody(req) ?? {}) as { decision?: unknown; runId?: unknown };
      const decision = body.decision === 'continue' ? 'continue'
        : body.decision === 'dismiss' ? 'dismiss' : null;
      if (!decision) {
        json(res, 400, { error: "decision must be 'continue' or 'dismiss'" });
        return true;
      }
      // A named run, or every run still waiting. "Continue all" is the answer
      // an operator gives most often and it must not be four presses.
      const asks = typeof body.runId === 'string'
        ? [...service.resumeAsks.values()].filter((a) => a.runId === body.runId)
        : [...service.resumeAsks.values()];
      for (const ask of asks) service.resumeDecisions.set(ask.runId, decision);
      // Converge again for the ones being picked up: the decision is a fact the
      // planner reads, so the same pass that deferred now relaunches. Dismissed
      // runs need no pass — nothing about them changed except that nobody is
      // being asked any more.
      if (decision === 'continue') {
        for (const slug of new Set(asks.map((a) => a.slug))) {
          void service.converger.converge(slug, 'button').catch(() => { /* reported on the run */ });
        }
      }
      json(res, 200, { answered: asks.map((a) => a.runId), decision });
      return true;
    }

    /* ---------------- push notifications ---------------- */
    if (head === 'push') {
      // Reading the catalogue and the public key is harmless. Everything that
      // changes who gets woken is a mutation, and gets the cross-site check —
      // but not `--allow-writes`: subscribing a device writes nothing in a
      // repository, and a read-only console is exactly where you would want
      // to be told a run needs you.
      if (req.method === 'GET' && rest.length === 0) { json(res, 200, service.push.state()); return true; }

      if (req.method === 'POST') {
        const refusal = guardCsrf(req);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        const action = rest[0] ?? '';

        if (action === 'subscribe') {
          const result = service.push.subscribe(body.subscription, body.categories, body.label);
          if ('error' in result) { json(res, 400, result); return true; }
          json(res, 200, { device: result, state: service.push.state() });
          return true;
        }
        if (action === 'unsubscribe') {
          json(res, 200, { removed: service.push.unsubscribe(body.id ?? body.endpoint), state: service.push.state() });
          return true;
        }
        if (action === 'categories') {
          const device = service.push.setCategories(body.id, body.categories);
          if (!device) { json(res, 404, { error: 'no such device' }); return true; }
          json(res, 200, { device, state: service.push.state() });
          return true;
        }
        if (action === 'quiet') {
          // Delivery quiet hours for one device: `quiet` is `{ start, end,
          // allowUrgent }` or null to clear. Validation lives with the
          // register (`parseQuietHours`); a bad shape is a 400, not a coerce.
          const device = service.push.setQuiet(body.id, body.quiet);
          if (!device) { json(res, 404, { error: 'no such device' }); return true; }
          if ('error' in device) { json(res, 400, device); return true; }
          json(res, 200, { device, state: service.push.state() });
          return true;
        }
        if (action === 'test') {
          json(res, 200, await service.push.test(String(body.id ?? '')));
          return true;
        }

        /* Answering from the notification itself.
         *
         * The ONE route a service worker may act through, and the reason the
         * payload can carry buttons at all. What arrives is a signed token —
         * minted over `(inbox item id, allowed verbs, expiry)` by
         * `push/actions.ts` — and the verb that was pressed. What does NOT
         * arrive is an endpoint, a method or a body: a worker that could be
         * told where to POST would be a request generator sitting in a
         * notification shade for as long as the operator left the card there.
         *
         * The capability check is deliberately NOT here. `performInboxAction`
         * reads the `flag` off the inbox action itself, so this route cannot
         * disagree with the card the same action is rendered on. It takes the
         * cross-site check like every other push mutation and nothing more.
         *
         * Every refusal is a plain status the worker treats identically — it
         * opens the console — so the sentences are for the log and for a
         * person reading it, not for a branch in the worker. */
        if (action === 'action') {
          const grant = readActionToken(body.token);
          if ('error' in grant) { json(res, 403, { error: grant.error }); return true; }

          const verb = String(body.action ?? '');
          if (!grant.verbs.includes(verb as never)) {
            // Signed, unexpired, and asking for something it was not minted
            // for. The token names its own verbs precisely so this is a
            // refusal rather than a lookup.
            json(res, 403, { error: 'that button was not offered by this notification' });
            return true;
          }
          if (!service.pushActions.claim(grant.nonce, Date.now() + PUSH_ACTION_TTL_MS)) {
            // A double-tap, or a notification answered on two devices. The
            // operations underneath refuse a second answer on their own; this
            // just makes the second one cheap and gives it an honest word.
            json(res, 409, { error: 'this notification has already been answered' });
            return true;
          }

          const outcome = await service.performInboxAction(grant.item, verb);
          if (outcome.ok) { json(res, 200, outcome); return true; }
          json(res, outcome.status, { error: outcome.error });
          return true;
        }
      }
    }

    /* ---------------- outbound webhooks ---------------- */
    if (head === 'webhooks') {
      // Reading is ungated, like the MCP registry and the account list. What
      // comes back carries origins and masked tails, never a URL: each one is a
      // bearer credential for somebody's chat channel, and a console that hands
      // it back to any caller who can reach the port has leaked it.
      if (req.method === 'GET' && rest.length === 0) { json(res, 200, service.webhooks.state()); return true; }

      if (req.method === 'POST') {
        const refusal = guardWebhooks(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        const action = rest[0] ?? '';

        if (action === 'add') {
          const result = service.webhooks.add(body.url, body.label, body.categories);
          if ('error' in result) { json(res, 400, result); return true; }
          json(res, 200, { hook: result, state: service.webhooks.state() });
          return true;
        }
        if (action === 'remove') {
          json(res, 200, {
            removed: service.webhooks.remove(body.id),
            state: service.webhooks.state(),
          });
          return true;
        }
        if (action === 'categories') {
          const hook = service.webhooks.setCategories(body.id, body.categories);
          if (!hook) { json(res, 404, { error: 'no such webhook' }); return true; }
          json(res, 200, { hook, state: service.webhooks.state() });
          return true;
        }
        if (action === 'test') {
          json(res, 200, await service.webhooks.test(body.id));
          return true;
        }
      }
    }

    /* ---------------- the notification inbox ---------------- */
    if (head === 'notifications') {
      // Reads are unguarded like the rest of the read API. Mutations take the
      // cross-site check but NOT `--allow-writes`: marking a notification read
      // writes nothing in a repository, and a read-only console is exactly
      // where you would want to clear an inbox.
      if (req.method === 'GET') {
        json(res, 200, service.inbox({
          category: url.searchParams.get('category'),
          unreadOnly: url.searchParams.get('unread') === '1',
          limit: Number(url.searchParams.get('limit') ?? 50),
          before: url.searchParams.get('before'),
        }));
        return true;
      }

      if (req.method === 'POST' && rest[0] === 'read') {
        const refusal = guardCsrf(req);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);

        // A scope marks read only what it matches — this is the auto-read a
        // run or plan page fires when you open it.
        //
        // The branch is chosen by which KEYS the body carries, never by whether
        // their values are usable. `{slug: ""}` is a page whose route has not
        // parsed yet, and reading it as "no scope" sends it down the bulk path,
        // where it clears the entire inbox — observed doing exactly that on a
        // scratch console. Asking to read *something* can never be answered by
        // reading *everything*: a blank scope reaches `markReadWhere`, which
        // matches nothing, and 0 records change.
        const scoped = SCOPE_KEYS.some((key) => key in body);
        if (scoped) {
          const str = (value: unknown) => (typeof value === 'string' && value ? value.slice(0, 128) : undefined);
          json(res, 200, service.markNotificationsReadFor({
            ...(str(body.slug) ? { slug: str(body.slug) } : {}),
            ...(str(body.category) ? { category: str(body.category) } : {}),
            ...(str(body.runId) ? { runId: str(body.runId) } : {}),
            ...(str(body.sessionId) ? { sessionId: str(body.sessionId) } : {}),
            ...(Number.isInteger(body.phase) ? { phase: Number(body.phase) } : {}),
          }));
          return true;
        }

        // No `ids` means every unread one — "mark all read" is the common case
        // and does not deserve the client enumerating an inbox to express it.
        const ids = Array.isArray(body.ids)
          ? body.ids.filter((v): v is string => typeof v === 'string').slice(0, 1_000)
          : null;
        json(res, 200, service.markNotificationsRead(ids));
        return true;
      }

      if (req.method === 'DELETE') {
        const refusal = guardCsrf(req);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const id = url.searchParams.get('id');
        const scope = url.searchParams.get('scope');
        // Explicit or nothing: an unrecognised scope clears nothing rather than
        // falling through to the most destructive reading of it.
        if (id) { json(res, 200, service.clearNotifications({ id })); return true; }
        if (scope === 'read' || scope === 'all') { json(res, 200, service.clearNotifications(scope)); return true; }
        json(res, 400, { error: 'pass ?id=<id>, ?scope=read or ?scope=all' });
        return true;
      }
    }

    /* ---------------- restarting the console itself ---------------- */
    if (head === 'restart') {
      if (req.method === 'GET') { json(res, 200, service.restartReadiness()); return true; }
      if (req.method === 'POST') {
        // Run-class, not write-class: this ends a process that may be
        // supervising agent sessions.
        const refusal = guardRun(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        const by = typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console';
        const outcome = service.restart(by, body.force === true);
        json(res, outcome.ok ? 200 : 409, outcome);
        return true;
      }
    }

    /* ---------------- stopping the console itself ---------------- */
    if (head === 'shutdown') {
      if (req.method === 'GET') { json(res, 200, service.shutdownReadiness()); return true; }
      if (req.method === 'POST') {
        // Deliberately `guardCsrf` and NOT `guardRun`, unlike restart. Turning
        // a process off is the one verb every console must have: gating it on
        // `--allow-run` would mean a read-only console — the common case — has
        // no off switch at all, which is the bug. The cross-site check still
        // applies, so another page cannot press it for you.
        const refusal = guardCsrf(req);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        // An explicit confirmation in the body, so a bare POST — a stray curl, a
        // replayed request — cannot end the console by accident.
        if (body.confirm !== true) {
          json(res, 400, { error: 'pass {"confirm":true} — shutting the console down is not a default.' });
          return true;
        }
        const by = typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console';
        const outcome = service.shutdown(by);
        json(res, outcome.ok ? 200 : 409, outcome);
        return true;
      }
    }

    /* ---------------- the terminal ---------------- */
    if (head === 'terminal') {
      // Deliberately above the "no source directory is open" wall below: a
      // shell is exactly what you want on a machine where there is nothing to
      // open yet.
      if (req.method === 'GET') { json(res, 200, service.terminalState()); return true; }

      // Freeze / continue / stop one session — the runner's lane verbs at
      // session size, so a recovery agent mid-flight can be held or ended
      // politely instead of only killed. Same gate as DELETE: any session
      // capability admits the controls for sessions that exist.
      if (req.method === 'POST' && rest.length === 2 && ['freeze', 'thaw', 'stop'].includes(rest[1])) {
        const refusal = guardAnySession(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        const by = typeof body.by === 'string' ? body.by.slice(0, 80) : 'console';
        const outcome = rest[1] === 'freeze' ? service.terminals.freeze(rest[0], by)
          : rest[1] === 'thaw' ? service.terminals.thaw(rest[0])
          : service.terminals.stop(rest[0], by);
        json(res, outcome.ok ? 200 : 409, { ...outcome, state: service.terminalState() });
        return true;
      }

      if (req.method === 'POST') {
        // The body decides which gate applies, so it is read first; the
        // guards still run before anything is created or looked up.
        const body = await readBody(req);
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 64) : undefined;
        const kind = body.kind === 'claude' ? 'claude'
          : body.kind == null || body.kind === 'shell' ? 'shell'
          : null;
        if (kind === null) { json(res, 400, { error: "unknown session kind — 'shell' or 'claude'." }); return true; }

        // A briefing intent is a CLAUDE session's word, and `kind` DEFAULTS to
        // shell — so a caller that names an intent and forgets the kind was
        // handed a bare login shell with its briefing dropped on the floor.
        // The inbox's own "Start a QA session" shipped exactly that body and
        // toasted "done" over a `$SHELL -l` while the phase went unreviewed.
        // Refused rather than upgraded: a mint that guessed the kind from a
        // field would be spending --allow-agent on the strength of something
        // the shell path never reads. Answered HERE, beside the unknown-kind
        // 400 and ahead of the guards for the same reason it is — a body-shape
        // refusal reads nothing, creates nothing, and naming the real mistake
        // beats a 403 about a flag that was never the point.
        if (kind !== 'claude' && body.intent != null && body.intent !== '') {
          json(res, 400, {
            error: "intent ('plan', 'recovery', 'qa') is a claude-session field — send kind: 'claude'.",
          });
          return true;
        }

        // Reattach goes by the session's own kind (mint checks it); a fresh
        // session goes by the kind being asked for.
        const refusal = sessionId ? guardAnySession(req, service)
          : kind === 'claude' ? guardAgent(req, service)
          : guardTerminal(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }

        let launch: LaunchSpec | undefined;
        if (!sessionId && kind === 'claude') {
          // A recovery names its target; the SERVER reads the board, the run,
          // the diagnosis and the lock and composes the briefing from those.
          // The browser never dictates what an agent session is told, and the
          // three guards (autopilot driving, already recovering, signed out)
          // live with the facts they are about.
          let recovery: RecoveryFacts | undefined;
          if (body.intent === 'recovery') {
            const parsed = parseRecoveryRequest(body);
            if (!parsed.ok) { json(res, parsed.status, { error: parsed.error }); return true; }
            const resolved = await service.resolveRecovery(parsed.request);
            if (!resolved.ok) {
              json(res, resolved.status, {
                error: resolved.error,
                ...(resolved.sessionId ? { sessionId: resolved.sessionId } : {}),
              });
              return true;
            }
            recovery = resolved.facts;
          }

          // Same split for a review, and the same reason: the browser names the
          // phase, the SERVER reads the plan, the handoff, the history and the
          // board. The guard that keeps a review independent lives with those
          // facts, not in the page that offered the button.
          let qa: QaFacts | undefined;
          if (body.intent === 'qa') {
            const parsed = parseQaRequest(body);
            if (!parsed.ok) { json(res, parsed.status, { error: parsed.error }); return true; }
            const resolved = await service.resolveQa(parsed.request);
            if (!resolved.ok) {
              json(res, resolved.status, {
                error: resolved.error,
                ...(resolved.sessionId ? { sessionId: resolved.sessionId } : {}),
              });
              return true;
            }
            qa = resolved.facts;
          }

          // The account, resolved HERE like the briefings above: the browser
          // names an id, the id is checked against the registry, and only the
          // environment the accounts module answers travels onto the spec.
          //
          // `auto` resolves against the meters exactly as `startRun` does, and
          // for the same reason: a recovery or a review is a session that
          // spends a window, so "the one with headroom" has to mean something
          // here too. It used to fall through to `undefined` — the machine
          // login — which is the WORST answer on the day you reach for auto,
          // because the machine login is usually the account you just spent.
          const chosen = accountChoice(body.accountId, service);
          const accountId = chosen === 'auto'
            ? service.accounts.pickAccount(null, typeof body.model === 'string' ? body.model : undefined)
              ?? undefined
            : chosen;
          const account = accountId
            ? { id: accountId, env: toStringEnv(await service.accounts.envFor(accountId)) }
            : undefined;

          // A resume names a CONVERSATION, and a conversation was had somewhere.
          // `--resume` resolves the id globally, so a resume started from the
          // console's own root does not fail — it succeeds in the wrong
          // directory, which is worse. The browser sends the id; the registry —
          // the same read-only view `GET /api/sessions/registry` serves —
          // answers where the session was working. An id the registry does not
          // know resolves to nothing and the mint behaves as it did before.
          const resumeId = typeof body.resume === 'string' ? body.resume : undefined;
          const known = resumeId
            ? service.sessionViews().find((view) => view.sessionId === resumeId)
            : undefined;
          const resumeTarget: ResumeTarget | undefined = known
            ? {
                ...(known.cwd ? { cwd: known.cwd } : {}),
                ...(known.plan ? { plan: { slug: known.plan.slug, phase: known.plan.phase } } : {}),
                ...(known.owner ? { owner: known.owner } : {}),
                ...(known.kind ? { kind: known.kind } : {}),
              }
            : undefined;

          // The issues, resolved HERE like the briefings and the account above:
          // the browser sends `owner/repo#12` refs, the inventory is the
          // allowlist they are looked up in, and only text this console already
          // held travels onto the prompt. A ref that resolves to nothing comes
          // back in `unknown` and the validator turns it into a 400 that names
          // it — never a session quietly briefed on fewer issues than were
          // chosen. Resolution is skipped entirely for a non-plan ticket, whose
          // validator refuses the field anyway.
          const issues = body.intent === 'plan' && Array.isArray(body.issues) && body.issues.length
            ? await service.issues.resolve(body.issues.map((ref) => String(ref)))
            : undefined;

          const built = buildAgentLaunch(body, {
            skills: () => service.skills(),
            scriptsDir: service.flags.scriptsDir,
            rootOpen: Boolean(service.store),
            // The root's PATH beside the fact that one is open: a QA session
            // derives its task inbox from it (`PE_TASKS_FILE`), and the healer's
            // mint already hands it over — a reviewer minted from the button
            // used to be the one session with no channel.
            ...(service.root?.ok ? { root: service.root.path } : {}),
            ...(recovery ? { recovery } : {}),
            ...(qa ? { qa } : {}),
            ...(issues ? { issues } : {}),
            ...(account ? { account } : {}),
            ...(resumeTarget ? { resumeTarget } : {}),
          });
          if (!built.ok) { json(res, built.status, { error: built.error }); return true; }
          launch = built.launch;
        }

        const minted = await service.terminals.mint(sessionId, {
          cols: Number(body.cols), rows: Number(body.rows),
        }, launch);
        if (!minted.ok) { json(res, minted.status, { error: minted.error }); return true; }
        // The socket path travels with the ticket so the client never has to
        // hard-code it — one source of truth for where the terminal lives.
        json(res, 200, { ...minted, path: TERMINAL_PATH });
        return true;
      }

      if (req.method === 'DELETE') {
        const refusal = guardAnySession(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const id = url.searchParams.get('id') ?? rest[0] ?? '';
        // Two different verbs on the same record, and conflating them is how a
        // "tidy the list" button ends up killing a working session. `dismiss`
        // drops a record whose process is already gone and refuses on a live
        // one; the default closes the session.
        if (url.searchParams.get('action') === 'dismiss') {
          const outcome = service.terminals.dismiss(id);
          json(res, outcome.ok ? 200 : 409, { ...outcome, state: service.terminalState() });
          return true;
        }
        json(res, 200, { closed: service.terminals.kill(id), state: service.terminalState() });
        return true;
      }
    }

    /* ---------------- reaching this console from a phone ----------------
     * Above the source-directory guard on purpose: whether Tailscale can reach
     * this machine has nothing to do with whether a docs root is open, and
     * Settings — where this renders — is the page you are on precisely when no
     * root is chosen yet. Behind the standard access gate like every other
     * read, which is the part worth stating: on a `--remote` console it answers
     * only to the proxy carrying an allowlisted login, so the device list is
     * not something an unauthenticated caller can ask for. It shells out, so it
     * can take a moment; Settings polls it only while it is open. */
    if (head === 'tailscale' && req.method === 'GET') {
      json(res, 200, await tailscaleStatus(service.flags.port));
      return true;
    }

    /* ---------------- MCP servers ----------------
     * Above the source-directory guard for the same reason as accounts: the
     * registry is an INSTANCE fact, not a project one, and Settings — where
     * registration lives — is exactly where you are before a root is open. The
     * list is redacted by construction (`McpServerView` carries no secret and
     * no path); the mutating verbs are behind `--allow-mcp`. */
    if (head === 'mcp') {
      if (req.method === 'GET' && rest.length === 0) {
        json(res, 200, {
          servers: await service.listMcp(),
          allowMcp: service.flags.allowMcp,
        });
        return true;
      }
      // The catalog is a read, and deliberately ungated: browsing what exists
      // is how somebody decides whether to turn the flag on at all.
      if (req.method === 'GET' && rest[0] === 'catalog') {
        const query = url.searchParams.get('q') ?? '';
        const registry = url.searchParams.get('registry') !== '0';
        try {
          json(res, 200, await searchCatalog(query, { includeRegistry: registry }));
        } catch (error) {
          json(res, 502, { error: (error as Error).message });
        }
        return true;
      }
      if (req.method === 'POST' && rest[0] === 'refresh') {
        // A probe spawns a process per distinct server set, so it is a POST and
        // it is CSRF-guarded — but it is not behind `--allow-mcp`: re-checking
        // whether your own servers are up changes nothing.
        const refusal = guardCsrf(req);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        try {
          json(res, 200, { servers: await service.refreshMcp(true) });
        } catch (error) {
          json(res, 500, { error: (error as Error).message });
        }
        return true;
      }
      if (req.method === 'POST' && rest.length === 0) {
        const refusal = guardMcp(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        try {
          json(res, 200, { server: await service.addMcpServer(body) });
        } catch (error) {
          json(res, 400, { error: (error as Error).message });
        }
        return true;
      }
      if (rest.length >= 1) {
        const id = rest[0];
        if (!MCP_ID_RE.test(id)) { json(res, 400, { error: 'not an MCP server id' }); return true; }

        if (req.method === 'DELETE' && rest.length === 1) {
          const refusal = guardMcp(req, service);
          if (refusal) { json(res, 403, { error: refusal }); return true; }
          json(res, 200, { removed: await service.removeMcpServer(id) });
          return true;
        }
        if (req.method === 'PATCH' && rest.length === 1) {
          const refusal = guardMcp(req, service);
          if (refusal) { json(res, 403, { error: refusal }); return true; }
          const body = await readBody(req);
          try {
            const server = await service.patchMcpServer(id, body);
            if (!server) { json(res, 404, { error: `no MCP server called ${id}` }); return true; }
            json(res, 200, { server });
          } catch (error) {
            json(res, 400, { error: (error as Error).message });
          }
          return true;
        }
        if (req.method === 'POST' && rest[1] === 'login') {
          const refusal = guardMcp(req, service);
          if (refusal) { json(res, 403, { error: refusal }); return true; }
          // `accountId` is optional and names the PROFILE whose config dir the
          // token should land in — the operator saying "sign it in for the
          // identity my runs spend" rather than for this console's own. Absent
          // means the console's own dir, which is the one the health probe
          // reads, so the default keeps sign-in and status agreeing.
          const body = await readBody(req);
          try {
            json(res, 200, await service.beginMcpLogin(
              id,
              typeof body.accountId === 'string' && body.accountId ? { accountId: body.accountId } : {},
            ));
          } catch (error) {
            json(res, 400, { error: (error as Error).message });
          }
          return true;
        }
        if (req.method === 'POST' && rest[1] === 'acknowledge') {
          const refusal = guardCsrf(req);
          if (refusal) { json(res, 403, { error: refusal }); return true; }
          json(res, 200, { acknowledged: service.mcp.acknowledgeDrift(id) });
          return true;
        }
      }
      json(res, 405, { error: 'method not allowed' });
      return true;
    }

    /* ---------------- Claude accounts ----------------
     * Also above the source-directory guard, for the same reason as tailscale:
     * accounts are an instance fact, the header meters render on every page,
     * and Settings — where registration lives — is exactly where you are when
     * no root is open yet. The list is redacted by construction (`AccountView`
     * carries no token and no credential path); the mutating verbs are behind
     * `--allow-accounts`. */
    if (head === 'accounts') {
      if (req.method === 'GET' && rest.length === 0) {
        json(res, 200, {
          accounts: await service.listAccounts(),
          allowAccounts: service.flags.allowAccounts,
        });
        return true;
      }
      if (req.method === 'POST' && rest[0] === 'login') {
        const refusal = guardAccounts(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        const accountId = typeof body.accountId === 'string' && ACCOUNT_ID_RE.test(body.accountId)
          ? body.accountId : undefined;
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 64) : '';
        try {
          json(res, 200, await service.beginAccountLogin({
            ...(accountId ? { accountId } : {}),
            ...(name ? { name } : {}),
          }));
        } catch (error) {
          json(res, 400, { error: (error as Error).message });
        }
        return true;
      }
      if (req.method === 'POST' && rest[0] === 'refresh') {
        // A re-read, not a registration — CSRF only, so "I signed in over
        // there, look again" works on a read-mostly console too.
        const refusal = guardCsrf(req);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        // No id means EVERY account. The panels ask that way — one press to
        // re-read the whole picture is the question an operator actually has,
        // and asking per-account in a loop is how a five-account console
        // spends its courtesy budget on a rate limit.
        if (body.accountId === undefined || body.accountId === null || body.accountId === '') {
          json(res, 200, { accounts: await service.refreshAllAccounts() });
          return true;
        }
        const id = typeof body.accountId === 'string' && ACCOUNT_ID_RE.test(body.accountId)
          ? body.accountId : DEFAULT_ACCOUNT_ID;
        const view = await service.refreshAccount(id);
        if (!view) { json(res, 404, { error: 'No such account.' }); return true; }
        json(res, 200, { account: view });
        return true;
      }
      if (req.method === 'POST' && rest.length === 0) {
        const refusal = guardAccounts(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 64) : '';
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        if (!name) { json(res, 400, { error: 'Name the account — a token has no email to show.' }); return true; }
        if (!token) { json(res, 400, { error: 'Paste the token from `claude setup-token`.' }); return true; }
        try {
          json(res, 200, { account: await service.addTokenAccount(name, token) });
        } catch (error) {
          json(res, 400, { error: (error as Error).message });
        }
        return true;
      }
      if (req.method === 'DELETE') {
        const refusal = guardAccounts(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const id = rest[0] ?? url.searchParams.get('id') ?? '';
        if (!ACCOUNT_ID_RE.test(id)) { json(res, 400, { error: 'Not an account id.' }); return true; }
        try {
          const removed = await service.removeAccount(id);
          json(res, removed ? 200 : 404, removed ? { removed: true } : { error: 'No such account.' });
        } catch (error) {
          json(res, 400, { error: (error as Error).message });
        }
        return true;
      }
      // Rename — the display name only, and the same registration-class gate
      // as add/remove: what an account is CALLED is part of how work gets
      // attributed, not a cosmetic read.
      if (req.method === 'PATCH' && rest.length === 1) {
        const refusal = guardAccounts(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const id = rest[0] ?? '';
        if (!ACCOUNT_ID_RE.test(id)) { json(res, 400, { error: 'Not an account id.' }); return true; }
        const body = await readBody(req);
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 64) : '';
        try {
          const view = await service.renameAccount(id, name);
          if (!view) { json(res, 404, { error: 'No such account.' }); return true; }
          json(res, 200, { account: view });
        } catch (error) {
          json(res, 400, { error: (error as Error).message });
        }
        return true;
      }
    }

    /* ---------------- the desktop launcher ----------------
     * Above the wall like tailscale and accounts: Settings is where this
     * renders, and the PLAN (where would it land, is this platform supported)
     * is answerable with no root open. Only creating one needs a root, and
     * that refusal names what to do. */
    if (head === 'launcher') {
      if (req.method === 'GET') {
        json(res, 200, service.launcherPlan());
        return true;
      }
      if (req.method === 'POST') {
        // A write gate, not only CSRF: this puts a 0755 executable on the
        // Desktop that starts a console with every capability on. A console
        // running read-only should refuse to mint that from a browser exactly
        // as it refuses every other write.
        const refusal = guardWrite(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        try {
          json(res, 200, service.createDesktopLauncher());
        } catch (error) {
          // 409 when a root is simply not open (well-formed ask, nothing to
          // bake); 400 for an unsupported platform or a template problem.
          const message = (error as Error).message;
          json(res, /source directory/i.test(message) ? 409 : 400, { error: message });
        }
        return true;
      }
    }

    /* ---------------- the permission policy ----------------
     * Above the source-directory wall, beside launcher/tailscale/accounts and
     * for the same reason: the GLOBAL policy is an instance fact that exists
     * with no root open, and the Settings card that renders it used to vanish
     * silently — the whole strike-and-restore surface gone with no banner —
     * on any console that had not opened a root. Plan-scoped reads degrade
     * honestly (the plan list is empty until a root opens). */
    if (head === 'policy') {
      if (req.method === 'GET') {
        json(res, 200, service.policy(url.searchParams.get('slug')));
        return true;
      }
      if (req.method === 'POST') {
        const refusal = guardWrite(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);

        // `add`/`remove` is the editor's shape and may widen — deliberately,
        // named, scoped and journaled (see `editPolicy`). `set` rides the same
        // shape for the scalars (auto-grant), because it moves through the same
        // door with the same attribution. A bare `{deny, ask}` body is the old
        // tightening-only contract and still means what it did.
        if ('add' in body || 'remove' in body || 'reset' in body || 'restore' in body
            || 'set' in body) {
          const rules = (value: unknown) => (Array.isArray(value)
            ? value.filter((v): v is string => typeof v === 'string') : []);
          const lists = (value: unknown) => {
            const part = (value ?? {}) as Record<string, unknown>;
            return { deny: rules(part.deny), ask: rules(part.ask), allow: rules(part.allow) };
          };
          // Only the three part names mean anything; a typo resets nothing
          // rather than something unexpected.
          const resets = rules(body.reset)
            .filter((part): part is 'deny' | 'ask' | 'allow' => part === 'deny' || part === 'ask' || part === 'allow');
          const slug = typeof body.slug === 'string' ? body.slug : null;
          const scope: PolicyScope = body.scope === 'plan' ? 'plan' : 'global';
          if (scope === 'plan' && !slug) {
            json(res, 400, { error: 'a plan-scoped rule needs a plan' });
            return true;
          }
          const restorePart = (body.restore ?? {}) as Record<string, unknown>;
          const restore = {
            deny: rules(restorePart.deny), ask: rules(restorePart.ask), allow: rules(restorePart.allow),
          };
          // set.autoApprove: true|false writes the scalar at the chosen scope,
          // null clears it back to inheriting. Anything else is a typo told out
          // loud rather than a silent no-op.
          let set: { autoApprove?: boolean | null } | undefined;
          if ('set' in body) {
            const part = (body.set ?? {}) as Record<string, unknown>;
            if ('autoApprove' in part) {
              if (part.autoApprove !== null && typeof part.autoApprove !== 'boolean') {
                json(res, 400, { error: 'set.autoApprove must be true, false or null (inherit)' });
                return true;
              }
              set = { autoApprove: part.autoApprove as boolean | null };
            }
          }
          json(res, 200, service.editPolicy({
            scope,
            slug,
            add: lists(body.add),
            remove: lists(body.remove),
            ...(resets.length ? { reset: resets } : {}),
            ...(restore.deny.length || restore.ask.length || restore.allow.length ? { restore } : {}),
            ...(set ? { set } : {}),
            by: typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console',
          }));
          return true;
        }

        if ('allow' in body) {
          json(res, 400, {
            error: 'to widen, post {add:{allow:[…]}, scope:"plan"|"global"} — a bare allow list is '
              + 'the old tightening-only shape and cannot say who asked or at what scope',
          });
          return true;
        }
        json(res, 200, service.addPolicy({
          deny: Array.isArray(body.deny) ? body.deny.filter((v): v is string => typeof v === 'string') : [],
          ask: Array.isArray(body.ask) ? body.ask.filter((v): v is string => typeof v === 'string') : [],
        }));
        return true;
      }
    }

    // What this console has spent, and against which ceilings.
    //
    // Above the "no source directory" wall on purpose, like the notification
    // inbox: a console with no plan directory open has spent nothing, and
    // "nothing" is a true and renderable answer. A 409 here would put an error
    // in a header widget that is meant to be quietly correct.
    if (head === 'spend' && req.method === 'GET') { json(res, 200, service.spend()); return true; }

    // The scrape endpoint. Above the wall for the same reason as `spend`: a
    // console with no plan directory open still has a version, an instance and
    // a day's spend, and a 409 in a scrape loop is an alert about nothing.
    //
    // Its own writer rather than `text()` — a Prometheus scraper reads the
    // `version=0.0.4` parameter off the content type to decide which parser to
    // use, and `text/plain; charset=utf-8` is not the same declaration.
    if (head === 'metrics' && req.method === 'GET') {
      const body = await service.metrics();
      // Its own headers, `sendBody`'s wire: a scrape loop is the highest-rate
      // reader this console has, and exposition text compresses roughly 10:1.
      // `no-store` stays — a scraper must never be handed a cached sample —
      // which is exactly why `revalidate` is off here: an ETag it can never
      // send back is decoration.
      sendBody(res, 200, Buffer.from(body, 'utf8'), {
        'content-type': METRICS_CONTENT_TYPE,
        'cache-control': 'no-store',
      });
      return true;
    }

    /* ---------------- debug: the logs, the journals, and one bundle ---------------- */
    //
    // Above the "no source directory" wall, deliberately and for the strongest
    // reason on this page: a console with no plan directory open is EXACTLY the
    // console somebody debugs. Its own log, the supervisor's stdout/stderr pair
    // and the environment doctor's findings are all still there, and they are
    // the three things that explain why no directory opened.
    if (head === 'debug' && req.method === 'GET') {
      const debug = debugFor(service);

      // A slug reaches `runDir()`, which is a bare `join` — so an unchecked
      // one is a path traversal, and these are the first endpoints that return
      // file CONTENTS through a query-parameter slug. Same shape `recovery.ts`
      // and `qa-session.ts` enforce. Refused with a 400 rather than silently
      // ignored: a filter that does nothing is the defect one rung up.
      const slugParam = url.searchParams.get('slug');
      if (slugParam !== null && !isSlug(slugParam)) {
        json(res, 400, { error: 'slug must be a plan slug: letters, digits, dot, dash, underscore' });
        return true;
      }
      // `?run=` reaches the SAME bare `join` the slug does, and guarding one of
      // a pair is the shape of most traversal fixes that do not work. This one
      // also WROTE: `Journal`'s constructor `mkdirSync`s its parent, so a GET
      // with `?run=../../../x` created a directory outside the state dir.
      const runParam = url.searchParams.get('run');
      if (runParam !== null && !isRunId(runParam)) {
        json(res, 400, { error: 'run must be a run id: eight hex characters' });
        return true;
      }

      // The log explorer's read: every source, merged and filtered.
      if (rest[0] === 'index') {
        json(res, 200, debug.index(parseDebugQuery(url.searchParams)));
        return true;
      }

      // Which runs a plan has a journal for. Its own endpoint rather than a
      // field on `index`, because the run picker must offer every run even
      // when the row cap dropped the older ones' entries.
      if (rest[0] === 'runs') {
        if (!slugParam) { json(res, 400, { error: 'a slug is required' }); return true; }
        json(res, 200, { slug: slugParam, runs: debug.runIds(slugParam) });
        return true;
      }

      // One redacted snapshot, for a model. `?download=1` makes it a file the
      // browser saves rather than renders; the default is a plain read so
      // `curl /api/debug/bundle` is the one-liner the docs can promise.
      if (rest[0] === 'bundle') {
        const bundle = await debug.bundle(slugParam ? { slug: slugParam } : {});
        if (url.searchParams.get('download') === '1') {
          const body = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
          const stamp = bundle.generatedAt.replace(/[:.]/g, '-');
          sendBody(res, 200, body, {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="phase-console-debug-${stamp}.json"`,
            'cache-control': 'no-store',
          });
          return true;
        }
        json(res, 200, bundle);
        return true;
      }

      // Follow mode. Its own event stream rather than a name on `/events`,
      // because a tail is per-QUERY — two tabs following different sources are
      // two different subscriptions — and because it must stop costing anything
      // the moment the tab closes. The shape below is `/events`'s, including
      // the ordering that keeps `stop` reachable from `send`.
      if (rest[0] === 'tail') {
        const query = parseDebugQuery(url.searchParams);
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });

        let closed = false;
        let timer: NodeJS.Timeout | undefined;
        const stop = () => {
          if (closed) return;
          closed = true;
          if (timer) { clearInterval(timer); timer = undefined; }
          try { res.end(); } catch { /* already gone */ }
        };
        const send = (chunk: string): void => {
          if (res.writableEnded || res.destroyed) { stop(); return; }
          try {
            res.write(chunk);
          } catch (error) {
            if (!isClientDisconnect(error)) log.warn('debug.tail-write', { error: String(error) });
            stop();
          }
        };

        // The newest row already on screen. Everything strictly newer than
        // this is news; everything at or before it the client already has.
        //
        // `Last-Event-ID` first, then `?after=`, then the current top of the
        // log. The header is what makes a RECONNECT continue rather than skip:
        // the browser resends the last id it saw by itself, and without it the
        // server re-seeded from the top and every row written while a laptop
        // slept was dropped with no marker. `?after=` is the same value for a
        // caller that is not a browser.
        const resumeFrom = String(req.headers['last-event-id'] ?? '')
          || url.searchParams.get('after')
          || '';
        const top = debug.index({ ...query, limit: 1 }).entries[0]?.at;
        let cursor = resumeFrom || top || new Date().toISOString();
        // A resumed stream says whether it can still bridge the gap. It cannot
        // know what it missed — it can know that it is starting behind, which
        // is the difference between a tail that resumed and a tail that lied.
        // `resumed` is a FACT about this connection and nothing more.
        //
        // The first cut also sent `behind`, computed here, and the client drew
        // "rows were written while it was away — they are not below". That was
        // false: `pass()` reads `since: cursor`, so the gap IS bridged on the
        // next tick. The only real loss is a gap wider than one pass's row cap,
        // which this handshake cannot know and the pass below can — so the
        // claim moved there, where it is measured instead of guessed.
        const resumed = Boolean(resumeFrom);
        send(`event: hello\ndata: ${JSON.stringify({
          cursor, intervalMs: DEBUG_TAIL_MS, resumed,
        })}\n\n`);

        const pass = () => {
          if (closed) return;
          let fresh: DebugEntry[] = [];
          try {
            fresh = debug.index({ ...query, since: cursor, limit: DEBUG_TAIL_ROWS }).entries
              // An UNDATED row (`at: ''`) can never be ordered against a cursor,
              // so it would be invisible to follow mode forever — and the row
              // class that has no time is `outcome.unreadable`, the one
              // `readOutcomes` exists to surface. It rides every pass; the
              // client de-duplicates.
              .filter((entry) => !entry.at || entry.at > cursor);
          } catch (error) {
            log.warn('debug.tail-read', { error: String(error) });
            return;
          }
          if (!fresh.length) { send(': ping\n\n'); return; }
          // Oldest first on the wire: the client appends, and a reader
          // watching a tail scroll upward is reading history backwards.
          const ordered = [...fresh].reverse();
          const dated = ordered.filter((entry) => entry.at);
          if (dated.length) cursor = dated[dated.length - 1].at;
          // A pass that filled its row cap means rows between this frame and
          // the last one were dropped. This is the ONLY loss a tail actually
          // has, and it is measured here rather than guessed at the handshake.
          const capped = ordered.length >= DEBUG_TAIL_ROWS;
          // The frame's `id:` is the cursor, so the browser resends it as
          // `Last-Event-ID` on a reconnect without the client doing anything.
          send(`id: ${cursor}\nevent: entries\ndata: ${JSON.stringify({ entries: ordered, cursor, capped })}\n\n`);
        };

        timer = setInterval(pass, DEBUG_TAIL_MS);
        timer.unref?.();
        // The one line that stops this leaking, and it is not defensive.
        //
        // `stop()` is reachable from `send()`, and the handshake `send()` above
        // runs BEFORE this interval exists. A client already gone at that
        // moment sets `closed` with `timer` still undefined; `stop()` has
        // nothing to clear, this line then creates an interval, and every
        // later close/error handler short-circuits on `closed`. Measured
        // 1 created / 0 cleared, retaining `res`, `req`, the query and the
        // facade, firing every 2 s for the life of the process. A `stop()`
        // that cleared unconditionally would NOT fix it — the clear has to
        // happen after the create, which is here.
        if (closed) { clearInterval(timer); timer = undefined; }
        res.on('error', stop);
        res.on('close', stop);
        req.on('close', stop);
        req.on('error', stop);
        return true;
      }
    }

    /* ---------------- the attention inbox ---------------- */
    //
    // Above the wall for the same reason as the notification inbox: a sign-in,
    // an MCP server that needs authenticating and a failing watcher all need a
    // person whether or not a plan directory happens to be open.
    if (head === 'inbox') {
      // Reads are unguarded like the rest of the read API.
      if (req.method === 'GET') {
        json(res, 200, await service.attention(url.searchParams.get('all') === '1'));
        return true;
      }

      // Mutations take the cross-site check but NOT `--allow-writes`: an ack is
      // an annotation on a view, it writes nothing in a repository, and a
      // read-only console is exactly where someone would want to tidy a list
      // they cannot otherwise act on.
      if (req.method === 'POST' && rest[0] === 'ack') {
        const refusal = guardCsrf(req);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        const by = typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : undefined;

        // `{ids}` is the bulk form. It answers per item, the way
        // `/api/locks/release {expired:true}` does — seventeen acknowledgements
        // where one refuses is not a failed call, and it is not a clean one
        // either; the caller has to be able to see which. The 1000 cap is the
        // notification inbox's, and is here for the same reason.
        if (Array.isArray(body.ids)) {
          const ids = body.ids
            .filter((v: unknown): v is string => typeof v === 'string' && v.length > 0)
            .slice(0, 1000)
            .map((v: string) => v.slice(0, 256));
          if (!ids.length) { json(res, 400, { error: 'pass {"ids": ["<inbox item id>", …]}' }); return true; }
          const results = service.ackInboxMany(ids, by);
          json(res, 200, { results, acked: results.filter((r) => r.ok).length });
          return true;
        }

        const id = typeof body.id === 'string' ? body.id.slice(0, 256) : '';
        if (!id) { json(res, 400, { error: 'pass {"id": "<inbox item id>"}' }); return true; }
        json(res, 200, { ok: service.ackInbox(id, by) });
        return true;
      }

      if (req.method === 'DELETE' && rest[0] === 'ack') {
        const refusal = guardCsrf(req);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        // `?id=` repeated is the bulk form, and it is what Undo presses. A
        // repeated parameter rather than a body because DELETE bodies are
        // widely allowed and nowhere guaranteed.
        const many = url.searchParams.getAll('id').filter(Boolean).slice(0, 1000);
        // No id means no clear-everything. The most destructive reading must
        // never be the default — the notification inbox pins the same rule.
        if (!many.length) { json(res, 400, { error: 'pass ?id=<inbox item id>' }); return true; }
        if (many.length === 1) { json(res, 200, { ok: service.unackInbox(many[0]) }); return true; }
        const results = service.unackInboxMany(many.map((v) => v.slice(0, 256)));
        json(res, 200, { results, unacked: results.filter((r) => r.ok).length });
        return true;
      }
    }

    if (!service.store) { json(res, 409, { error: 'No source directory is open.' }); return true; }

    /* ---------------- portfolio ---------------- */
    if (head === 'plans' && rest.length === 0) { json(res, 200, await service.summaries()); return true; }
    if (head === 'stats') { json(res, 200, await service.portfolio()); return true; }

    if (head === 'search') {
      json(res, 200, service.searchAll(url.searchParams.get('q') ?? ''));
      return true;
    }
    if (head === 'skills' && req.method === 'GET') { json(res, 200, service.skills()); return true; }

    /* ---------------- one plan ---------------- */
    if (head === 'plans' && rest.length >= 1) {
      const slug = rest[0];
      const sub = rest[1];
      const arg = rest[2];

      if (!sub) {
        const detail = await service.detail(
          slug,
          url.searchParams.get('model') ?? undefined,
          parseInclude(url.searchParams.get('include'), PLAN_INCLUDES),
        );
        if (!detail) { json(res, 404, { error: `No plan named ${slug}` }); return true; }
        json(res, 200, detail);
        return true;
      }

      if (sub === 'raw') {
        const record = service.store.get(slug);
        text(res, record?.plan ? 200 : 404, record?.plan?.body ?? 'not found');
        return true;
      }

      if (sub === 'handoff' && arg) {
        const handoff = service.handoff(slug, Number(arg));
        if (!handoff) { json(res, 404, { error: 'No handoff for that phase' }); return true; }
        json(res, 200, handoff);
        return true;
      }

      // The QA report itself — the one document every QA surface only ever
      // showed as a path. Read-only, and the service reads only the file the
      // chooser mints for (phase, round); anything else is a 404, never a read.
      if (sub === 'qa-report' && arg) {
        const phase = Number(arg);
        const roundParam = url.searchParams.get('round');
        const round = roundParam == null || roundParam === '' ? undefined : Number(roundParam);
        if (!Number.isInteger(phase) || phase < 1 || (round !== undefined && (!Number.isInteger(round) || round < 1))) {
          json(res, 400, { error: 'phase and round are whole numbers from 1' });
          return true;
        }
        const report = service.qaReport(slug, phase, round);
        if (!report) { json(res, 404, { error: 'No QA report on file for that phase and round' }); return true; }
        json(res, 200, report);
        return true;
      }

      if (sub === 'prompt' && arg) { text(res, 200, await service.bootPrompt(slug, Number(arg))); return true; }
      if (sub === 'next-prompt') {
        text(res, 200, await service.nextPhasePrompt(slug, arg ?? 'none'));
        return true;
      }
      if (sub === 'qa-prompt' && arg) { text(res, 200, await service.qaPrompt(slug, Number(arg))); return true; }
      if (sub === 'memory-block') { text(res, 200, await service.memoryBlock(slug)); return true; }
      // Read-only: what boarding will find before any money is spent —
      // missing leads, cwd-unpinned commands, human-only fragments, phases
      // that would park. The plan page badges from this.
      if (sub === 'verify-preflight') {
        const report = await service.verifyPreflightReport(slug);
        if (!report) { json(res, 404, { error: `No phased plan named ${slug}` }); return true; }
        json(res, 200, report);
        return true;
      }
      // Read-only: what "Give this run its own checkout" would DO — granted
      // (and for a superproject, which repositories the mirror would mount),
      // or refused by name. The launch dialog renders this instead of a
      // checkbox that is guaranteed to be refused (G6).
      if (sub === 'isolation-preflight') {
        const report = await service.isolationPreflight(slug);
        if (!report) { json(res, 404, { error: `No phased plan named ${slug}` }); return true; }
        json(res, 200, report);
        return true;
      }
      if (sub === 'board') { text(res, 200, await service.boardText(slug)); return true; }
      /* The review surface: a phase's diff, and the verdict on it.
       *
       * Mounted under the plan like `gate` and `qa-prompt` rather than at a
       * top-level `/api/review`, because every other per-phase resource in
       * this console is addressed `plans/<slug>/<thing>/<phase>` and the
       * client's plan module, its query keys and `route-contract.test.ts` are
       * all built on that shape. Recorded as a deviation in the phase handoff.
       *
       * GET is unflagged — reading what a session changed is display, the same
       * class as reading its handoff, and a console started with no flags is
       * exactly where an operator wants to check the work before turning
       * anything on. POST is `--allow-writes`, because `requested-changes`
       * holds every dependent phase from boarding. */
      if (sub === 'review' && arg) {
        const phase = Number(arg);
        if (!Number.isInteger(phase) || phase < 1) {
          json(res, 400, { error: 'the review route needs a phase number' });
          return true;
        }
        if (req.method === 'POST') {
          const refusal = guardMutation(req, guardWrite(req, service));
          if (refusal) { json(res, 403, { error: refusal }); return true; }
          const body = await readBody(req);
          const outcome = await service.setReview(slug, phase, {
            verdict: String(body.verdict ?? '') as never,
            ...(typeof body.note === 'string' ? { note: body.note } : {}),
            ...(typeof body.by === 'string' ? { by: body.by } : {}),
            ...(typeof body.base === 'string' ? { base: body.base } : {}),
            ...(typeof body.tip === 'string' ? { tip: body.tip } : {}),
          });
          // On refusal `error` carries the detail, so ApiError.message says WHY
          // rather than "Request failed (409)" — the same shape as the gate.
          json(res, outcome.ok ? 200 : 409, outcome.ok ? outcome : { ...outcome, error: outcome.detail });
          return true;
        }
        if (req.method !== 'GET') { json(res, 405, { error: 'GET or POST' }); return true; }
        const view = await service.phaseReview(slug, phase, {
          ...(url.searchParams.get('base') ? { base: String(url.searchParams.get('base')) } : {}),
          ...(url.searchParams.get('tip') ? { tip: String(url.searchParams.get('tip')) } : {}),
        });
        if (!view) { json(res, 404, { error: `No plan named ${slug}` }); return true; }
        json(res, 200, view);
        return true;
      }
      /* A phase's inline comments. Split from the verdict route rather than
       * folded into it because the two are different acts with different
       * consequences: a verdict can HOLD dependents, a comment cannot, and one
       * endpoint that does both would have to be documented as the stronger
       * one. Write-class — see the service method for why a read-only console
       * must not be able to reach Send back. */
      if (sub === 'review-comment' && arg) {
        const phase = Number(arg);
        if (!Number.isInteger(phase) || phase < 1) {
          json(res, 400, { error: 'the review-comment route needs a phase number' });
          return true;
        }
        if (req.method !== 'POST') { json(res, 405, { error: 'POST' }); return true; }
        const refusal = guardMutation(req, guardWrite(req, service));
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        const action = String(body.action ?? 'add');
        if (action !== 'add' && action !== 'resolve' && action !== 'unresolve' && action !== 'delete') {
          json(res, 400, { error: 'action must be add, resolve, unresolve or delete' });
          return true;
        }
        const outcome = await service.commentOnReview(slug, phase, action === 'add'
          ? {
            action: 'add',
            path: String(body.path ?? ''),
            body: String(body.body ?? ''),
            ...(Number.isInteger(body.line) ? { line: Number(body.line) } : {}),
            ...(body.side === 'old' || body.side === 'new' ? { side: body.side } : {}),
            ...(typeof body.hunk === 'string' ? { hunk: body.hunk } : {}),
            ...(typeof body.code === 'string' ? { code: body.code } : {}),
            ...(typeof body.by === 'string' ? { by: body.by } : {}),
          }
          : { action, id: String(body.id ?? '') });
        json(res, outcome.ok ? 200 : 409, outcome.ok ? outcome : { ...outcome, error: outcome.detail });
        return true;
      }

      /* Send a reviewed phase back to work with its comments.
       *
       * `--allow-run`, not `--allow-writes`: this re-boards a phase, which
       * spawns a session that edits a repository. The body names the phase and
       * nothing else — the follow-up prompt is composed server-side from the
       * stored comments, so this cannot be used to put arbitrary words in
       * front of a session. */
      if (sub === 'review-send-back' && arg) {
        const phase = Number(arg);
        if (!Number.isInteger(phase) || phase < 1) {
          json(res, 400, { error: 'the send-back route needs a phase number' });
          return true;
        }
        if (req.method !== 'POST') { json(res, 405, { error: 'POST' }); return true; }
        const refusal = guardMutation(req, guardRun(req, service));
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        const outcome = await service.sendBackReview(slug, phase, {
          ...(typeof body.by === 'string' ? { by: body.by } : {}),
        });
        json(res, outcome.ok ? 200 : 409, outcome.ok ? outcome : { ...outcome, error: outcome.detail });
        return true;
      }

      /* The landing packet: what a finished plan hands the operator.
       *
       * GET is unflagged for the same reason the review's is — "which branch
       * is this work on, is it pushed anywhere, how many commits is it" is
       * display, and a console with no flags is exactly where somebody checks
       * before turning anything on. POST is `--allow-writes`: it writes files
       * under the run's state directory. Neither one can push; see
       * `server/landing.ts` and `viewer/test/never-push.test.ts`.
       *
       * With a trailing name — `landing/<slug>.bundle`, `landing/patches/0001-….patch`
       * — it serves that artefact. The name is matched against the manifest's
       * own file list rather than sanitised, so a traversal is not a
       * near-miss: it is a name the packet does not contain. */
      if (sub === 'landing') {
        if (req.method === 'POST') {
          if (arg) { json(res, 405, { error: 'compose posts to /landing, without a file name' }); return true; }
          const refusal = guardMutation(req, guardWrite(req, service));
          if (refusal) { json(res, 403, { error: refusal }); return true; }
          const body = await readBody(req);
          const outcome = await service.composeLandingPacket(slug, {
            ...(typeof body.base === 'string' ? { base: body.base } : {}),
            ...(typeof body.tip === 'string' ? { tip: body.tip } : {}),
          });
          json(res, outcome.ok ? 200 : 409, outcome.ok ? outcome : { ...outcome, error: outcome.detail });
          return true;
        }
        if (req.method !== 'GET') { json(res, 405, { error: 'GET or POST' }); return true; }

        // Everything after `landing/` is the artefact name, joined back
        // together: a patch lives one directory down, so `rest` has four
        // segments and `arg` alone would name the directory.
        const name = rest.slice(2).join('/');
        if (name) {
          const file = service.landingArtifact(slug, name);
          if (!file) { json(res, 404, { error: 'That file is not in this plan\'s landing packet.' }); return true; }
          sendFile(res, file, name);
          return true;
        }
        const view = await service.landing(slug);
        if (!view) { json(res, 404, { error: `No plan named ${slug}` }); return true; }
        json(res, 200, view);
        return true;
      }

      if (sub === 'gate' && arg) {
        if (req.method === 'POST') {
          /* Approve (or revoke) a phase's gate — the clearance record every
           * gate kind honours. Write-class: it writes gate-status.md, so it
           * sits behind --allow-writes like the other plan writes. */
          const refusal = guardWrite(req, service);
          if (refusal) { json(res, 403, { error: refusal }); return true; }
          const phase = Number(arg);
          if (!Number.isInteger(phase) || phase < 1) {
            json(res, 400, { error: 'the gate route needs a phase number' });
            return true;
          }
          const body = await readBody(req);
          const outcome = await service.approveGate(slug, phase, {
            approve: body.approve !== false,
            by: typeof body.by === 'string' ? body.by : undefined,
            note: typeof body.note === 'string' ? body.note : undefined,
            continueRun: body.continueRun === true,
          });
          // On refusal, `error` carries the detail so ApiError.message says
          // WHY rather than "Request failed (409)".
          json(res, outcome.ok ? 200 : 409, outcome.ok ? outcome : { ...outcome, error: outcome.detail });
          return true;
        }
        json(res, 200, await service.gateStatus(slug, Number(arg)));
        return true;
      }
      if (sub === 'session-plan') {
        json(res, 200, await service.sessionPlan(slug, url.searchParams.get('model') ?? undefined));
        return true;
      }
      if (sub === 'lint') { json(res, 200, await service.lint(slug)); return true; }
      if (sub === 'work') { json(res, 200, await service.work(slug)); return true; }

      /* Turn QA on for a plan that has it off. Write-class — it creates
       * `test-status.md` and backfills the already-complete phases — so it sits
       * behind `--allow-writes`, not behind the agent flag: activating QA and
       * minting a reviewer are two different permissions. */
      if (sub === 'qa-mode' && req.method === 'POST') {
        const refusal = guardWrite(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        const phase = body.phase == null || body.phase === '' ? undefined : Number(body.phase);
        if (phase !== undefined && (!Number.isInteger(phase) || phase < 1)) {
          json(res, 400, { error: 'phase must be a whole number from 1' });
          return true;
        }
        // `{mode, phase?}` SETS the regime — plan-wide or for one phase — through
        // `qa-mode.sh` (2026-09-07). A body with a phase and no mode keeps
        // meaning "activate": the older client's only verb, still honoured.
        if (body.mode != null && body.mode !== '') {
          const mode = typeof body.mode === 'string' ? body.mode : '';
          if (!(QA_DIRECTIVES as readonly string[]).includes(mode)) {
            json(res, 400, { error: `mode must be one of ${QA_DIRECTIVES.join(', ')}` });
            return true;
          }
          const outcome = await service.setQaMode(slug, {
            mode: mode as (typeof QA_DIRECTIVES)[number], ...(phase !== undefined ? { phase } : {}),
          });
          json(res, outcome.ok ? 200 : 409, outcome);
          return true;
        }
        if (phase === undefined) {
          json(res, 400, { error: 'pass {mode, phase?} to set the QA regime, or {phase} to activate QA — activation records that phase and waives the rest' });
          return true;
        }
        const outcome = await service.activateQa(slug, phase);
        json(res, outcome.ok ? 200 : 409, outcome);
        return true;
      }

      /* Waive a recorded verdict with a reason — the third QA-recovery verb
       * (issue #11), and the only one that starts nothing. Write-class for
       * `qa-mode`'s reason and sited beside it rather than with the two run
       * verbs: what it does is write one row of `test-status.md`, and a console
       * that may write but may not run must still be able to release a gate. */
      if (sub === 'qa-waive' && req.method === 'POST') {
        const refusal = guardWrite(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        const phase = Number(body.phase);
        if (!Number.isInteger(phase) || phase < 1) {
          json(res, 400, { error: 'pass {phase, reason} — a waiver names the phase and why' });
          return true;
        }
        const outcome = await service.qaWaive(slug, phase, {
          reason: typeof body.reason === 'string' ? body.reason.slice(0, 280) : '',
          by: typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console',
        });
        json(res, outcome.ok ? 200 : 409, outcome);
        return true;
      }
    }

    /* ---------------- the admission queue ----------------
     * Read-only, and unauthenticated like every other read: it says what is
     * holding a scope and what is waiting on it. `waitingOn` is the part that
     * matters — "queued" alone is the same non-answer `pausing` used to be,
     * naming a thing that is not happening without naming what would have to
     * change for it to happen. */
    if (head === 'queue' && req.method === 'GET') {
      // The snapshot, plus the ordering ADVICE — remaining weight and an ETA
      // per queued plan. It rides this GET rather than the `run:queue` event
      // or the `state` payload deliberately: both of those are emitted on
      // every admission change, and a board read per queued plan on those
      // paths would charge every reader for what one page asked for. Here,
      // asking is the request. See `ServiceRuns.queueAdvice`.
      json(res, 200, { ...service.queueSnapshot(), advice: await service.queueAdvice() });
      return true;
    }

    /* ---------------- one entry to the front of its class ----------------
     * Run-class, not write-class: it changes what STARTS, which is the same
     * authority `start` and `stop` need and a different one from editing a
     * file in the repository. See `Scheduler.bump` for why it is by entry id
     * and why it never crosses a class boundary. */
    if (head === 'queue' && req.method === 'POST' && rest[0] === 'bump') {
      const refusal = guardRun(req, service);
      if (refusal) { json(res, 403, { error: refusal }); return true; }
      const body = await readBody(req);
      const entryId = typeof body.entryId === 'string' ? body.entryId : '';
      if (!entryId) { json(res, 400, { error: 'pass {entryId} — the queue entry to move' }); return true; }
      // 404, not 200-with-a-false: an entry id from a page that has been open
      // a while names something that has since been admitted or cancelled, and
      // "we moved nothing" and "we moved it" must not be the same response.
      const moved = service.bumpQueueEntry(entryId);
      if (!moved) {
        json(res, 404, { error: `no queued entry ${entryId} — it may have started already` });
        return true;
      }
      json(res, 200, service.queueSnapshot());
      return true;
    }

    /* ---------------- the panic button ----------------
     * Run-class, and deliberately not write-class: a console with
     * `--allow-run` off starts nothing on its own, so there is nothing for a
     * fleet freeze to stop and the button would be theatre. The same authority
     * that lets this console spawn sessions is the one that may stop them all.
     *
     * `GET` is unguarded — reading whether your own console is frozen is
     * display, exactly as reading the account meters and the webhook list are.
     *
     * 409 with a reason when there is nothing to do, rather than a cheerful
     * 200: pressing Freeze on an already-frozen console must not read as
     * having just frozen it, because the `at` an operator then quotes would be
     * the wrong moment. */
    if (head === 'fleet') {
      if (req.method === 'GET' && rest.length === 0) {
        json(res, 200, { fleet: service.fleetState(), allowRun: service.flags.allowRun });
        return true;
      }
      if (req.method === 'POST' && (rest[0] === 'freeze' || rest[0] === 'thaw')) {
        const refusal = guardRun(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        const by = typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console';
        const outcome = rest[0] === 'freeze'
          ? service.freezeFleet(by)
          : await service.thawFleet(by);
        json(res, outcome.ok ? 200 : 409, outcome.ok
          ? { fleet: service.fleetState(), runs: outcome.runs }
          : { error: outcome.reason, fleet: service.fleetState() });
        return true;
      }
      json(res, 405, { error: 'method not allowed' });
      return true;
    }

    /* ---------------- stale claims ----------------
     * Release reads the owner out of the lock file rather than asking a person
     * to retype it — see `Service.releaseLock`. Write-class, because it removes
     * a file inside the repository. */
    if (head === 'locks' && req.method === 'POST' && rest[0] === 'release') {
      const refusal = guardWrite(req, service);
      if (refusal) { json(res, 403, { error: refusal }); return true; }
      const body = await readBody(req);

      // `{expired: true}` is the bulk verb: every stale claim in the source, one
      // result per lock so a single refusal cannot hide the rest.
      if (body.expired === true) {
        const results = await service.releaseExpiredLocks();
        json(res, 200, { results, released: results.filter((r) => r.ok).length });
        return true;
      }

      const slug = typeof body.slug === 'string' ? body.slug : '';
      const phase = Number(body.phase);
      if (!slug || !Number.isInteger(phase)) {
        json(res, 400, { error: 'pass {slug, phase} for one lock, or {expired: true} for every stale one' });
        return true;
      }
      // `force` takes a claim whose lease is still running — the only way past a
      // live claim, now that one refuses a run. Still write-guarded above; the
      // console confirms it with the operator before it ever gets here.
      const result = await service.releaseLock(slug, phase, body.force === true);
      // 409 rather than 400 on a live lease: the request is well formed, the
      // phase is simply still being worked. `error` carries the explanation
      // because that is the field `lib/api.ts` turns into the thrown message —
      // without it a refusal reads as "Request failed (409)".
      json(res, result.ok ? 200 : 409, result.ok ? result : { ...result, error: result.detail });
      return true;
    }

    /* ---------------- runs + approvals ---------------- */
    if (head === 'runs' && req.method === 'GET') { json(res, 200, await service.allRuns()); return true; }

    // Signing in. The GET is a read of `claude auth status` — memoised, free,
    // and safe to poll. The POST opens a terminal, so it is a run-class action.
    if (head === 'auth') {
      if (req.method === 'GET') {
        json(res, 200, await service.authStatus(url.searchParams.get('force') === '1'));
        return true;
      }
      if (req.method === 'POST' && rest[0] === 'login') {
        const refusal = guardRun(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        json(res, 200, await service.startLogin());
        return true;
      }
    }

    if (head === 'approvals') {
      if (req.method === 'GET') { json(res, 200, service.approvals.all()); return true; }
      if (req.method === 'POST' && rest[0]) {
        const refusal = guardRun(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);
        const decision = body.decision === 'allow' ? 'allow' : 'deny';
        // `remember: "plan" | "global"` turns this one answer into a rule. Any
        // other value is just an answer — a typo must not widen anything.
        const scope = body.remember === 'plan' ? 'plan'
          : body.remember === 'global' ? 'global' : null;
        const answered = service.decideApproval(
          rest[0], decision,
          typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console',
          typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined,
          scope && typeof body.rule === 'string' && body.rule
            ? { scope, rule: body.rule.slice(0, 200) } : undefined,
        );
        json(res, answered.ok ? 200 : 404, answered);
        return true;
      }
    }

    if (head === 'run' && rest.length >= 1) {
      const slug = rest[0];
      const verb = rest[1];

      if (req.method === 'GET') {
        if (verb === 'journal') {
          const id = rest[2] ?? service.runIdFor(slug);
          json(res, 200, id ? service.runJournal(slug, id, Number(url.searchParams.get('limit') ?? 500)) : []);
          return true;
        }
        // The run on a time axis. Read from the journal rather than the
        // checkpoint: the checkpoint holds one row per phase and cannot say
        // when attempt 2 started, which is the whole question a Gantt answers.
        if (verb === 'timeline') {
          json(res, 200, service.runTimeline(slug, rest[2]));
          return true;
        }
        // One phase's boardings, with each consecutive pair diffed. `?run=` to
        // read a finished run rather than the newest one.
        if (verb === 'attempts') {
          const phase = Number(rest[2] ?? url.searchParams.get('phase'));
          if (!Number.isFinite(phase)) { json(res, 400, { error: 'a phase number is required' }); return true; }
          json(res, 200, service.phaseAttempts(slug, phase, url.searchParams.get('run') ?? undefined));
          return true;
        }
        if (verb === 'transcript') {
          json(res, 200, service.runTranscript(slug, rest[2], Number(url.searchParams.get('limit') ?? 400)));
          return true;
        }
        // Why a phase is not done, in one payload: the command output, the
        // session's closing words, the lint summary, the board-vs-handoff
        // disagreement, and what can still be done about it. All of it was
        // already on disk; none of it was reachable from the page.
        if (verb === 'diagnosis') {
          const phase = Number(rest[2] ?? url.searchParams.get('phase'));
          if (!Number.isFinite(phase)) { json(res, 400, { error: 'a phase number is required' }); return true; }
          const diagnosis = await service.phaseDiagnosis(slug, phase);
          json(res, diagnosis ? 200 : 404, diagnosis ?? { error: `no record of phase ${phase} in any run of ${slug}` });
          return true;
        }
        // What each phase of this plan touches, and what that collides with
        // right now. Read from the same Repos column and the same live locks
        // admission uses, so the page cannot show one answer while the
        // scheduler acts on another.
        if (verb === 'scopes') {
          json(res, 200, { scopes: service.phaseScopes(slug) });
          return true;
        }
        // What this plan's sessions DECIDED, oldest first. Read from the
        // ledger file rather than from a run, so it answers for a plan nobody
        // has ever started a run on — which is every plan somebody is driving
        // by hand.
        if (verb === 'rulings') {
          json(res, 200, { rulings: service.runRulings(slug) });
          return true;
        }
        // `eta` rides along rather than getting an endpoint of its own: it is
        // derived from exactly this run plus the plan's board, and a second
        // request could be answered against a board that had moved on.
        // `phaseEta` is the same estimate per open lane; the run is read once
        // and handed to it, so the three figures cannot describe different runs.
        const current = await service.runFor(slug);
        json(res, 200, {
          run: current,
          history: await service.runsFor(slug),
          eta: await service.runEta(slug),
          phaseEta: service.runPhaseEta(slug, current),
          // Per live lane: last output, last tool call, turns since one,
          // commits and tree state, the call open longest, and the stall
          // episode if it is in one. Rides along for the same reason `eta`
          // does — a second request could be answered against a different
          // moment, and "is this lane working" is a question about one.
          liveness: service.runLiveness(slug, current),
          // Where this run's branch stands and what it would collide with, from
          // the runner's cache. Rides along for `eta`'s reason and one more:
          // it is `null` far more often than not (every shared run), and an
          // endpoint that mostly 404s teaches a client to stop asking.
          git: service.runGit(slug),
        });
        return true;
      }

      if (req.method === 'POST') {
        const refusal = guardRun(req, service);
        if (refusal) { json(res, 403, { error: refusal }); return true; }
        const body = await readBody(req);

        switch (verb) {
          case 'start': {
            // Everything the operator can get wrong, answered before a run
            // exists. These used to be coerced away one by one — an unknown
            // model passed straight through to argv, an unknown effort became
            // `undefined`, a per-phase typo vanished — so the run started,
            // looked healthy, and simply was not the run that was asked for.
            const problem = modelProblem(body.model)
              ?? effortProblem(body.effort)
              // QA's own tier is judged exactly as hard as the builder's, and
              // for the same reason: an unknown model would go straight to argv
              // and an unknown effort would be dropped, so the reviewing would
              // silently not be the reviewing that was asked for.
              ?? modelProblem(body.qaModel, 'qaModel')
              ?? effortProblem(body.qaEffort, 'qaEffort')
              ?? intProblem(body.maxParallel, 'maxParallel', 1, service.flags.maxSessions)
              ?? intProblem(body.maxConsecutiveFailures, 'maxConsecutiveFailures', 1, 50)
              // At least one round, or QA could never run at all; the ceiling is
              // arbitrary but finite, because "keep reviewing forever" is the
              // behaviour this budget exists to end.
              ?? intProblem(body.qaMaxRounds, 'qaMaxRounds', 1, 20)
              ?? phaseOptionsProblem(body.phaseOptions);
            if (problem) { json(res, 400, { error: problem }); return true; }

            // The git door. Asked of the RESOLVED pair, because `undefined` on
            // this door means "you did not say" and the stored preference then
            // decides — so the combination that would actually run is the one
            // that has to be judged, not the half of it the body carries.
            // `?.` on the preferences, not because they are ever missing on a
            // real console but because this door must not be the reason a
            // request 500s: a refusal is a judgement about the operator's
            // input, and it has nothing to say when there is no stored
            // preference to resolve against.
            const gitBad = gitDoorRefusal({
              isolation: (body.isolation as string) ?? service.prefs?.isolation,
              gitMode: (body.gitMode as string) ?? service.prefs?.gitMode,
            });
            if (gitBad) { json(res, 400, { error: gitBad }); return true; }

            const state = await service.startRun(slug, {
              model: typeof body.model === 'string' && body.model ? body.model : undefined,
              // Checked above rather than passed through: the CLI only *warns*
              // on an unknown effort and carries on at its own default, so a
              // typo would quietly run every phase of a plan at the wrong one.
              effort: isEffort(body.effort) ? body.effort : undefined,
              // Lanes this run may hold at once. Clamped to the console's own
              // ceiling as well as validated, because `--max-sessions` is a
              // machine-level promise about this host and a run may not
              // outbid it.
              maxParallel: body.maxParallel === undefined || body.maxParallel === null || body.maxParallel === ''
                ? undefined
                : Math.min(Number(body.maxParallel), service.flags.maxSessions || Number(body.maxParallel)),
              maxConsecutiveFailures: body.maxConsecutiveFailures === undefined
                || body.maxConsecutiveFailures === null || body.maxConsecutiveFailures === ''
                ? undefined
                : Number(body.maxConsecutiveFailures),
              // Flipped with the run defaults (see `runner/state.ts` newRun).
              autonomy: body.autonomy === 'halt-on-everything' ? 'halt-on-everything' : 'keep-going',
              phaseBudgetUsd: numberOrNull(body.phaseBudgetUsd),
              runBudgetUsd: numberOrNull(body.runBudgetUsd),
              resumeRunId: typeof body.resumeRunId === 'string' ? body.resumeRunId : undefined,
              onlyPhases: phaseList(body.onlyPhases),
              phaseOptions: phaseOptions(body.phaseOptions, service),
              skills: skillList(body.skills),
              mcpServers: mcpList(body.mcpServers, service),
              // Absent lets the stored preference (fresh run) or the run's own
              // sticky choice (resume) decide, like `autoRecover` below. A typo
              // reads as absent rather than as `require`: the fail-safe here is
              // the side that keeps plans moving.
              mcpPolicy: isMcpPolicy(body.mcpPolicy) ? body.mcpPolicy : undefined,
              // Anything unrecognised is `guarded`. A typo must not be the
              // reason a run takes the guard rails off.
              permissionProfile: isPermissionProfile(body.permissionProfile)
                ? body.permissionProfile : DEFAULT_PERMISSION_PROFILE,
              // Same posture for the git strategy: only the two exact literals
              // mean anything; everything else is `undefined`, which lets the
              // stored preference decide. A typo must never mint a branch.
              gitMode: body.gitMode === 'new-branch' ? 'new-branch'
                : body.gitMode === 'default-branch' ? 'default-branch' : undefined,
              openPr: typeof body.openPr === 'boolean' ? body.openPr : undefined,
              // And isolation once more: only the two exact words are read, and
              // anything else is `undefined` so the stored preference decides.
              // Note this door does NOT use `isolationMode()` — that coercer
              // folds a typo to `queue`, which would silently override the
              // operator's preference with the very value they turned off.
              // Unrecognised means "you did not say", not "you said queue".
              isolation: ISOLATION_MODES.includes(body.isolation as never)
                ? body.isolation as IsolationMode : undefined,
              // And settle by the same posture, for the same reason: the door
              // reads only a word the vocabulary knows, and `undefined` means
              // "you did not say" so the stored preference decides. Note it
              // does NOT use `settleStrategy()` here — that coercer folds a
              // typo to `pr`, which would override an operator whose
              // preference is `keep` with the one strategy that pushes.
              settle: SETTLE_STRATEGIES.includes(body.settle as never)
                ? body.settle as SettleStrategy : undefined,
              // The same posture once more: only the three exact words are
              // read. A typo is `undefined` — "you did not say" — so a fresh
              // run lands in `normal` and a resume keeps the class it already
              // had, rather than being silently demoted by a stale client.
              priority: RUN_PRIORITIES.includes(body.priority as never)
                ? body.priority as RunPriority : undefined,
              // A plan slug to begin after. Trimmed and length-capped like
              // every other free text that reaches a run file. Whether the
              // plan EXISTS is deliberately not checked: the chain resolves
              // against the fleet at every scan, so a slug that names nothing
              // settles at once (`planRunSettled`) rather than 400ing a start
              // over a plan the operator is about to create.
              // `''` is passed THROUGH rather than folded to `undefined`: on a
              // resume, absent means "keep the chain this run already has", so
              // an empty string is the only way an operator can take one off.
              // `newRun` ignores a falsy value, so it is still no chain on a
              // fresh run.
              startAfter: typeof body.startAfter === 'string'
                ? body.startAfter.trim().slice(0, 128) : undefined,
              // `undefined` lets the stored preference decide, exactly like
              // `gitMode` above. The POLICY takes only its one exact word —
              // a typo must never turn a reviewer into something that can
              // park every phase behind the one it read.
              reviewEachPhase: typeof body.reviewEachPhase === 'boolean' ? body.reviewEachPhase : undefined,
              reviewerPolicy: body.reviewerPolicy === 'may-hold' ? 'may-hold'
                : body.reviewerPolicy === 'comment-only' ? 'comment-only' : undefined,
              // The two ultra opt-ins, read the same cautious way: a boolean or
              // nothing, and for the mode only a word the vocabulary holds. A
              // typo must never be the reason a run starts fanning out dozens
              // of agents or billing cloud reviews the operator did not ask for.
              ultracode: typeof body.ultracode === 'boolean' ? body.ultracode : undefined,
              ultraReview: ultraReviewMode(body.ultraReview),
              attachDefaultSkills: typeof body.attachDefaultSkills === 'boolean' ? body.attachDefaultSkills : undefined,
              qa: typeof body.qa === 'boolean' ? body.qa : undefined,
              // QA's own three. `undefined` means "you did not say", so the
              // reviewer keeps inheriting the builder's model and effort and
              // the round budget falls back to its default — which is exactly
              // what every run before these existed did.
              qaModel: typeof body.qaModel === 'string' && body.qaModel ? body.qaModel : undefined,
              qaEffort: isEffort(body.qaEffort) ? body.qaEffort : undefined,
              qaMaxRounds: body.qaMaxRounds === undefined || body.qaMaxRounds === null || body.qaMaxRounds === ''
                ? undefined
                : Number(body.qaMaxRounds),
              // QA recovery's two. A word off the vocabulary is `undefined`,
              // which means "you did not say" and lets the shipped default
              // (`resume`) decide — a typo must never be the reason a recovery
              // stops resuming and starts paying for fresh sessions.
              qaFixStrategy: QA_FIX_STRATEGIES.includes(body.qaFixStrategy as never)
                ? body.qaFixStrategy as QaFixStrategy : undefined,
              qaRoundBudgetUsd: body.qaRoundBudgetUsd === undefined
                ? undefined : numberOrNull(body.qaRoundBudgetUsd),
              // Checked against the instance's own registry, never passed
              // through — this value becomes a child's environment. Unknown
              // ids (a removed account, a typo) read as "the machine login";
              // `auto` resolves in the service against the cached meters.
              accountId: accountChoice(body.accountId, service),
              onLimit: isOnLimitPolicy(body.onLimit) ? body.onLimit : undefined,
              // A boolean or nothing: absent lets the stored preference (fresh
              // run) or the run's own sticky choice (resume) decide.
              autoRecover: typeof body.autoRecover === 'boolean' ? body.autoRecover : undefined,
            });
            // Advisory, best-effort: which phases will park at boarding for an
            // unrunnable §Verification, and which are claimed by a live holder
            // this run will have to queue behind. The run is already created
            // either way — these lines are why the operator hears it now and
            // not hours in. A claim never REFUSES a whole-plan start: a foreign
            // unexpired lock queues, and the scheduler owns that wait.
            //
            // ONE try EACH, deliberately: they are independent advisories, and
            // wrapping both in a single catch meant a throw in the second
            // silently erased the first. Advisory means "may be missing", not
            // "may take another warning down with it".
            const only = phaseList(body.onlyPhases);
            const preflight: string[] = [];
            try {
              preflight.push(...await service.verificationPreflight(slug, only));
            } catch { /* advisory only — a start never fails over its warning */ }
            try {
              preflight.push(...service.claimPreflight(slug, only));
            } catch { /* ditto */ }
            json(res, 200, { run: state, preflight });
            return true;
          }
          // Every one of these goes through the service, not the runner: after a
          // console restart there is no in-memory run to act on, and the
          // runner's own methods return silently — a button that answers 200
          // and does nothing. The service edits the checkpoint on disk instead.
          case 'ask':
          case 'steer': {
            // 409 rather than 400: the request is well formed, there is simply
            // nothing listening — and the difference is what tells the console
            // to say "no session is running" instead of "bad request".
            const by = typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console';
            const key = idempotencyKey(req, body);
            const sent = verb === 'ask'
              ? service.askRun(slug, String(body.question ?? ''), by, key, targetPhase(body))
              : service.steerRun(
                slug, String(body.instruction ?? body.question ?? ''), by, key, targetPhase(body),
              );
            json(res, sent.ok ? 200 : 409, sent);
            return true;
          }
          case 'pause': json(res, 200, { run: service.pauseRun(slug) }); return true;
          case 'resume': json(res, 200, { run: service.resumePause(slug) }); return true;
          // Their own verbs and NOT `settings` fields, for the reason
          // `switch-account` is one: a hold is an act with a moment and an
          // author, not a value the next phase reads. Beside Pause/Resume
          // because that is the pair an operator compares them with — pause
          // settles the run at the next boundary, hold refuses the next
          // ADMISSION and lets the running phases finish.
          case 'hold': {
            json(res, 200, {
              run: service.holdRun(slug, typeof body.by === 'string' && body.by
                ? body.by.slice(0, 64) : 'console'),
            });
            return true;
          }
          case 'release': json(res, 200, { run: service.releaseRun(slug) }); return true;
          // Its own verb, not a `settings` field: settings say what the NEXT
          // phase uses; this acts now — a live session is checkpointed and the
          // phase re-attempted under the other account without waiting.
          case 'switch-account': {
            const choice = accountChoice(body.accountId, service) ?? DEFAULT_ACCOUNT_ID;
            const outcome = service.switchAccountRun(
              slug, choice, typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console',
            );
            json(res, outcome.ok ? 200 : 409, outcome);
            return true;
          }
          // Freeze/thaw act on a live child, so unlike pause they have no
          // on-disk fallback: a null run here means this console is not the one
          // driving, which the client reports rather than papering over.
          case 'freeze': {
            const done = service.freezeRun(
              slug,
              typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console',
              targetPhase(body),
            );
            // `?.ok === false` rather than `!done.ok`: a refusal now carries the
            // reason the operator needs, and the optional chain keeps a service
            // that answers nothing at all reading as "it happened" exactly as
            // it did before this returned a result object.
            json(res, done?.ok === false ? 409 : 200,
              done?.ok === false ? { error: done.reason } : { run: done?.run });
            return true;
          }
          case 'thaw': {
            const done = service.thawRun(slug, targetPhase(body));
            json(res, done?.ok === false ? 409 : 200,
              done?.ok === false ? { error: done.reason } : { run: done?.run });
            return true;
          }
          case 'stop': {
            // The one control that cannot be taken back, so a phase named in
            // the body is ruled on before anything is signalled — see
            // `Service.stopRun`: named, it stops that lane only and the run
            // carries on. Same 409-with-a-reason shape the recovery verbs use.
            try {
              json(res, 200, {
                run: await service.stopRun(
                  slug,
                  targetPhase(body),
                  typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console',
                ),
              });
            } catch (error) {
              json(res, 409, { error: (error as Error)?.message ?? 'the run could not be stopped' });
            }
            return true;
          }
          // Dismissing a stopped run's card, and taking that back. Addressed by
          // run id rather than "this plan's run": the card belongs to the run
          // that raised it, which on a plan that has run since is not the
          // latest one. Nothing is deleted — see `RunResolution`.
          case 'resolve':
          case 'unresolve': {
            const runId = typeof body.runId === 'string' ? body.runId.slice(0, 64) : '';
            if (!runId) { json(res, 400, { error: 'a runId is required' }); return true; }
            const run = verb === 'resolve'
              ? service.resolveRun(slug, runId, {
                note: typeof body.note === 'string' ? body.note.slice(0, 500) : undefined,
                by: typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console',
              })
              : service.unresolveRun(slug, runId);
            json(res, run ? 200 : 404, run ? { run } : { error: `no run ${runId} of ${slug}` });
            return true;
          }
          case 'skip': json(res, 200, { run: service.skipPhase(slug, Number(body.phase)) }); return true;
          case 'retry': {
            // Retry-with-edits: an addendum for the boot prompt and/or settings
            // for this one attempt. Both optional — a bare `{phase}` is the
            // plain Retry this route has always answered, and must stay
            // byte-identical to it (`retryOverrideFrom` returns undefined).
            //
            // The options go through the SAME coercer the run-setup form's do:
            // these values reach a child process's argv, and a second door into
            // that argv with its own idea of what is allowed is how the first
            // one stops being a wall.
            const problem = body.addendum !== undefined && typeof body.addendum !== 'string'
              ? 'addendum must be a string.'
              : phaseOptionsProblem({ [String(body.phase)]: body.options });
            if (problem) { json(res, 400, { error: problem }); return true; }
            const addendum = typeof body.addendum === 'string' ? body.addendum.slice(0, ADDENDUM_MAX) : undefined;
            json(res, 200, {
              run: await service.retryPhase(slug, Number(body.phase), {
                ...(addendum ? { addendum } : {}),
                options: onePhaseOptions(body.options, service),
                by: 'console',
              }),
            });
            return true;
          }
          // One verb rather than "set the policy, then retry these three
          // phases": the two halves are useless apart, and a browser that
          // managed only the first would leave the run parked under a setting
          // saying it should not be.
          // One press, three honest steps — confirm against the board, stand
          // down what it settled, recover or continue what is real. See
          // Service.recoverPlan for why this cannot corrupt the orchestration.
          case 'recover': {
            try {
              json(res, 200, await service.recoverPlan(slug));
            } catch (error) {
              json(res, 409, { error: (error as Error)?.message ?? 'the plan could not be recovered' });
            }
            return true;
          }
          // Re-run ONE recorded verification command in the operator's own
          // shell; the exit reflects back onto the record on session exit.
          case 'verify-command': {
            const result = await service.verifyInTerminal(
              slug, Number(body.phase),
              typeof body.command === 'string' ? body.command.slice(0, 2_000) : '');
            if (!result.ok) { json(res, result.status, { error: result.error }); return true; }
            json(res, 200, result);
            return true;
          }
          case 'mcp-continue': {
            try {
              json(res, 200, { run: await service.continueWithoutMcp(slug) });
            } catch (error) {
              json(res, 409, { error: (error as Error)?.message ?? 'the run could not be continued' });
            }
            return true;
          }
          // The three QA-recovery verbs (issue #11). A recorded `fail` — and a
          // `pending` — holds every dependent phase, and until these existed
          // there was nothing any surface could POST: the ladder climbed inside
          // a run somebody had already started, spent its caps and parked with
          // an errand naming no action, and a hand-driven plan had no rung at
          // all.
          //
          // `qa-recover` and `qa-rerun` share a door because they share a loop
          // and differ by one word — whether a FIX session runs before the
          // review. `qa-waive` is deliberately separate: it starts nothing,
          // writes one row, and is gated on `--allow-writes` rather than
          // `--allow-run`.
          case 'qa-recover':
          case 'qa-rerun': {
            // The same coercer the run door's fields get, and for the same
            // reason: these values reach a child process's argv, and a second
            // door into that argv with its own idea of what is allowed is how
            // the first one stops being a wall.
            const problem = modelProblem(body.model)
              ?? effortProblem(body.effort)
              ?? modelProblem(body.qaModel, 'qaModel')
              ?? effortProblem(body.qaEffort, 'qaEffort')
              ?? intProblem(body.qaMaxRounds, 'qaMaxRounds', 1, 20);
            if (problem) { json(res, 400, { error: problem }); return true; }
            const phase = Number(body.phase);
            if (!Number.isInteger(phase) || phase < 1) {
              json(res, 400, { error: 'a phase number is required' }); return true;
            }
            try {
              const run = await service.qaRecover(slug, phase, {
                verb: verb === 'qa-rerun' ? 'qa-rerun' : 'qa-recover',
                // A word off the vocabulary is `undefined`, which lets the
                // run's own choice decide — a typo must never be the reason a
                // loop stops resuming and starts paying for fresh sessions.
                ...(QA_FIX_STRATEGIES.includes(body.strategy as never)
                  ? { strategy: body.strategy as QaFixStrategy } : {}),
                ...(body.qaMaxRounds === undefined || body.qaMaxRounds === null || body.qaMaxRounds === ''
                  ? {} : { qaMaxRounds: Number(body.qaMaxRounds) }),
                // `null` is a real value here — "no per-round stop" — so this
                // reads `undefined` rather than truthiness.
                ...(body.qaRoundBudgetUsd === undefined
                  ? {} : { qaRoundBudgetUsd: numberOrNull(body.qaRoundBudgetUsd) }),
                settings: {
                  ...(typeof body.model === 'string' ? { model: body.model } : {}),
                  ...(body.effort !== undefined ? { effort: String(body.effort ?? '') } : {}),
                  ...(typeof body.qaModel === 'string' ? { qaModel: body.qaModel } : {}),
                  ...(body.qaEffort !== undefined ? { qaEffort: String(body.qaEffort ?? '') } : {}),
                  ...(body.skills !== undefined ? { skills: skillList(body.skills) } : {}),
                  ...(body.mcpServers !== undefined ? { mcpServers: mcpList(body.mcpServers, service) } : {}),
                  ...(isMcpPolicy(body.mcpPolicy) ? { mcpPolicy: body.mcpPolicy } : {}),
                  ...(isPermissionProfile(body.permissionProfile)
                    ? { permissionProfile: body.permissionProfile } : {}),
                },
                by: typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console',
              });
              json(res, 200, { run });
            } catch (error) {
              json(res, 409, {
                error: (error as Error)?.message ?? 'the QA recovery could not be started',
                ...(error instanceof RecoveryBusyError ? { sessionId: error.sessionId } : {}),
              });
            }
            return true;
          }
          // One cloud review of this run's branch, now. Guarded like every run
          // verb above it and deliberately not a setting: it is billed work on
          // the operator's own account, so each press is exactly one review and
          // nothing here can be left switched on by accident. The answer is the
          // review's own three-state result, never a run — a review that could
          // not happen must not read as one that found nothing.
          case 'ultrareview': {
            try {
              json(res, 200, await service.ultraReviewNow(slug));
            } catch (error) {
              json(res, 409, { error: (error as Error)?.message ?? 'the review could not be started' });
            }
            return true;
          }
          // The middle ground between Retry and Skip: re-check what is on disk,
          // or ask the phase's own session to finish what it started. Every one
          // of these ends in the same three checks, so none of them can mark a
          // phase done that the board does not agree about.
          case 'recheck':
          case 'closeout':
          case 'resume-phase': {
            const mode = verb === 'resume-phase' ? 'resume' : verb;
            try {
              const run = await service.recoverPhase(slug, Number(body.phase), mode, {
                instruction: typeof body.instruction === 'string' ? body.instruction.slice(0, 8_000) : undefined,
                by: typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console',
              });
              json(res, 200, { run });
            } catch (error) {
              json(res, 409, {
                error: (error as Error)?.message ?? 'the phase could not be recovered',
                ...(error instanceof RecoveryBusyError ? { sessionId: error.sessionId } : {}),
              });
            }
            return true;
          }
          case 'settings': {
            // Read once: the coercer folds a typo to `undefined`, and two reads of it in one
            // expression were two chances to disagree. (P14 QA round 1, Low.)
            const ultraReview = ultraReviewMode(body.ultraReview);
            // The same door as `start`, and for the same reason: a settings
            // patch reaches the very next phase to board, so a value nobody
            // checked is a value that quietly changes the rest of the run.
            const problem = modelProblem(body.model)
              ?? effortProblem(body.effort)
              // QA's own tier is judged exactly as hard as the builder's, and
              // for the same reason: an unknown model would go straight to argv
              // and an unknown effort would be dropped, so the reviewing would
              // silently not be the reviewing that was asked for.
              ?? modelProblem(body.qaModel, 'qaModel')
              ?? effortProblem(body.qaEffort, 'qaEffort')
              ?? intProblem(body.maxParallel, 'maxParallel', 1, service.flags.maxSessions)
              ?? intProblem(body.maxConsecutiveFailures, 'maxConsecutiveFailures', 1, 50)
              // At least one round, or QA could never run at all; the ceiling is
              // arbitrary but finite, because "keep reviewing forever" is the
              // behaviour this budget exists to end.
              ?? intProblem(body.qaMaxRounds, 'qaMaxRounds', 1, 20)
              ?? phaseOptionsProblem(body.phaseOptions);
            if (problem) { json(res, 400, { error: problem }); return true; }

            // Isolation goes ONE WAY mid-run, and this is where the other way
            // is refused out loud rather than dropped. `applySettings` ignores
            // a raise, which is the right behaviour for a machine and the wrong
            // answer for a person: an operator who ticked the box and got a 200
            // would believe the run had moved. A 409 that names the way forward
            // is the difference. See `RunSettingsPatch.isolation` for why the
            // raise cannot be honoured at all.
            if (body.isolation === ISOLATED) {
              const live = await service.runFor(slug);
              if (live?.isolation !== ISOLATED) {
                json(res, 409, {
                  error: 'A run cannot be moved into its own checkout while it is running — '
                    + 'its commits are on the branch in the checkout it started in. '
                    + 'Stop the run and start it again with isolation on.',
                });
                return true;
              }
            }

            const run = service.configureRun(slug, {
              ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
              // `''` is not a failed check here — it is the operator asking for
              // this machine's own default, which `newRun` stores as no key at
              // all. An unknown value never reaches this line any more; it 400s
              // above, where it can still be explained.
              ...('effort' in body ? { effort: isEffort(body.effort) ? body.effort : '' } : {}),
              // Both already understood by `applySettings`; only the door was
              // missing, so a browser could not change either mid-run.
              ...('maxParallel' in body
                ? { maxParallel: body.maxParallel === null || body.maxParallel === ''
                    ? 0
                    : Math.min(Number(body.maxParallel), service.flags.maxSessions || Number(body.maxParallel)) } : {}),
              ...(typeof body.autoRecover === 'boolean' ? { autoRecover: body.autoRecover } : {}),
              ...(body.autonomy === 'keep-going' || body.autonomy === 'halt-on-everything'
                ? { autonomy: body.autonomy } : {}),
              ...('phaseBudgetUsd' in body ? { phaseBudgetUsd: numberOrNull(body.phaseBudgetUsd) } : {}),
              ...('runBudgetUsd' in body ? { runBudgetUsd: numberOrNull(body.runBudgetUsd) } : {}),
              // Was a bare `Number(...)`, which turned an absent or empty value
              // into NaN and a garbage string into NaN too — a run could be
              // told its failure ceiling was NaN and compare against it forever.
              ...('maxConsecutiveFailures' in body && body.maxConsecutiveFailures !== null
                && body.maxConsecutiveFailures !== ''
                ? { maxConsecutiveFailures: Number(body.maxConsecutiveFailures) } : {}),
              ...('onlyPhases' in body ? { onlyPhases: phaseList(body.onlyPhases) ?? null } : {}),
              ...('phaseOptions' in body ? { phaseOptions: phaseOptions(body.phaseOptions, service) ?? null } : {}),
              ...('skills' in body ? { skills: skillList(body.skills) ?? null } : {}),
              ...('mcpServers' in body ? { mcpServers: mcpList(body.mcpServers, service) ?? null } : {}),
              ...(isMcpPolicy(body.mcpPolicy) ? { mcpPolicy: body.mcpPolicy } : {}),
              ...(isPermissionProfile(body.permissionProfile)
                ? { permissionProfile: body.permissionProfile } : {}),
              ...(body.gitMode === 'new-branch' || body.gitMode === 'default-branch'
                ? { gitMode: body.gitMode } : {}),
              ...(typeof body.openPr === 'boolean' ? { openPr: body.openPr } : {}),
              // Only a value the vocabulary knows is passed on; the raise has
              // already 409'd above, so what reaches `applySettings` here is
              // either a drop or the no-op of re-asserting what the run is.
              ...(ISOLATION_MODES.includes(body.isolation as never)
                ? { isolation: body.isolation as IsolationMode } : {}),
              // Both directions here, unlike isolation — and with no 409 above
              // it, because there is no impossible direction to refuse: settle
              // decides what happens to the branch when the run ENDS, and that
              // has not happened yet whichever way it is moved.
              ...(SETTLE_STRATEGIES.includes(body.settle as never)
                ? { settle: body.settle as SettleStrategy } : {}),
              // Both directions here, unlike isolation: `normal` is a real
              // instruction ("put this back in the ordinary queue"), not the
              // absence of one, and `applySettings` stores it as the omission
              // it has always been.
              ...(RUN_PRIORITIES.includes(body.priority as never)
                ? { priority: body.priority as RunPriority } : {}),
              ...(typeof body.reviewEachPhase === 'boolean' ? { reviewEachPhase: body.reviewEachPhase } : {}),
              ...(body.reviewerPolicy === 'may-hold' || body.reviewerPolicy === 'comment-only'
                ? { reviewerPolicy: body.reviewerPolicy } : {}),
              ...(typeof body.ultracode === 'boolean' ? { ultracode: body.ultracode } : {}),
              // `off` IS a value here, unlike on `start`: a patch that omits the
              // field means "leave it alone", so an operator turning the cloud
              // reviewer back off has to be able to say the word.
              ...(ultraReview ? { ultraReview } : {}),
              ...(typeof body.attachDefaultSkills === 'boolean'
                ? { attachDefaultSkills: body.attachDefaultSkills } : {}),
              // QA's own three, mid-run and in both directions. An operator who
              // sees a run burning rounds on one phase must be able to stop
              // THAT without stopping the run — the same reason
              // `reviewEachPhase` is patchable. Omitting a field still means
              // "leave it alone"; the validation above has already refused an
              // unknown model, an unknown effort or a round budget out of range.
              // Presence, not truthiness — for the reason `effort` above has:
              // `''` is the operator taking the override OFF, which
              // `applySettings` stores as no key at all, and a truthiness test
              // could never deliver it. `qaEffort` had exactly that dead branch
              // (QA F6): it could be set mid-run and never cleared.
              //
              // Do not write the `in body` idiom with a placeholder name in a
              // comment here: `run-settings-parity.test.ts` reads this file as
              // TEXT, and it read the placeholder as a field the door accepts.
              ...('qaModel' in body
                ? { qaModel: typeof body.qaModel === 'string' ? body.qaModel : '' } : {}),
              ...('qaEffort' in body
                ? { qaEffort: isEffort(body.qaEffort) ? body.qaEffort : '' } : {}),
              ...(body.qaMaxRounds === undefined || body.qaMaxRounds === null || body.qaMaxRounds === ''
                ? {} : { qaMaxRounds: Number(body.qaMaxRounds) }),
              // Both directions mid-run, like `qaModel`/`qaEffort` above: a
              // value off the vocabulary clears the override rather than
              // setting one, and `null` on the round budget is a real value
              // ("no per-round stop") rather than an absence.
              ...('qaFixStrategy' in body
                ? {
                  qaFixStrategy: QA_FIX_STRATEGIES.includes(body.qaFixStrategy as never)
                    ? body.qaFixStrategy as QaFixStrategy : undefined,
                }
                : {}),
              ...(body.qaRoundBudgetUsd === undefined
                ? {} : { qaRoundBudgetUsd: numberOrNull(body.qaRoundBudgetUsd) }),
              ...(isOnLimitPolicy(body.onLimit) ? { onLimit: body.onLimit } : {}),
            }, typeof body.by === 'string' && body.by ? body.by.slice(0, 64) : 'console');
            json(res, 200, { run });
            return true;
          }
          default:
            json(res, 404, { error: `No run verb "${verb}"` });
            return true;
        }
      }
    }

    /* ---------------- guarded writes ---------------- */
    if (head === 'write' && req.method === 'POST') {
      const refusal = guardWrite(req, service);
      if (refusal) { json(res, 403, { error: refusal }); return true; }

      const body = (await readBody(req)) as WriteRequest;
      const root = service.root!;

      if (body.action === 'open-editor') {
        const outcome = await openInEditor(String(body.path ?? ''), root.docsDir ?? root.path);
        json(res, outcome.ok ? 200 : 500, outcome);
        return true;
      }

      const plan = planWrite(body, { root: root.path, docsDir: root.docsDir });
      if (url.searchParams.get('dry') === '1') {
        json(res, 200, { dryRun: true, command: `${plan.script} ${plan.args.join(' ')}`, description: plan.description });
        return true;
      }
      const outcome = await runWrite(plan, { scriptsDir: service.flags.scriptsDir, root: root.path });
      service.invalidateAll();
      json(res, outcome.ok ? 200 : 500, { ...outcome, description: plan.description });
      return true;
    }

    json(res, 404, { error: `No API route for ${path}` });
    return true;
  } catch (error) {
    const message = error instanceof WriteError ? error.message : String((error as Error)?.message ?? error);
    // 409 for a claimed phase: the request is well formed and the caller did
    // nothing wrong — somebody else is simply working that phase. 500 would
    // read as a console fault and send the operator looking for the wrong bug.
    const status = error instanceof PhaseClaimedError || error instanceof RecoveryBusyError ? 409
      : error instanceof WriteError ? 400
        : 500;
    json(res, status, {
      error: message,
      ...(error instanceof PhaseClaimedError
        ? { claimed: { slug: error.slug, phase: error.phase, ...error.lock } }
        : {}),
      // The same 409-with-sessionId shape `resolveRecovery` refusals use, so
      // the client navigates to the live session instead of erroring.
      ...(error instanceof RecoveryBusyError ? { sessionId: error.sessionId } : {}),
    });
    return true;
  }
}
