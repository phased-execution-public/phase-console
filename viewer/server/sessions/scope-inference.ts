/**
 * What a terminal session holds: what it TOUCHED, never where it was opened
 * (control-tower phase 82, #119).
 *
 * The REG-3 rule read a session with no declared scope from its cwd alone — a
 * session in the repository ROOT was scope `all` — and measured on hub 4123 it
 * froze every queued phase of an unrelated run for the length of a chat about
 * another docs root. A cwd is where a person typed `claude`, not evidence of
 * work. The evidence is in the session's own transcript, which the presence
 * hook already hands the console (`transcript_path`):
 *
 *  - the paths its Edit / Write / MultiEdit / NotebookEdit calls named;
 *  - the repositories it CHANGED — each edited path's repository, and every
 *    directory it ran a changing `git -C <dir> <verb>` in;
 *  - the plans its `phase-lock.sh` / `phase-graph.sh` calls named, with the
 *    `DOCS_ROOT=` the call set — a plan of ANOTHER docs root is evidence the
 *    session works there, and a lock call's `--scope` is its own word.
 *
 * Read from the transcript's tail, incrementally (`TranscriptReader`), because
 * the peer feed asks on every admission scan and a transcript only grows.
 *
 * What is NOT evidence (control-tower phase 108): a path under a Claude config
 * home — `~/.claude/**` (its memory, plans, todos), `~/.claude-*`, the
 * session's own config dir — is neither the tree nor another repository, so it
 * holds nothing, renews nothing and says nothing about "elsewhere" (#180); a
 * bare `git -C <root> …` names no path at all, so it claims nothing (#180); and
 * a lock the session released — in its own transcript, or by anybody, once its
 * file is gone — lets go of every lock call before it (#172).
 */
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

import { PHASE_IN_FLIGHT } from '../../shared/run-lifecycle.js';
import { normalizeToken, parseScope } from '../../shared/scope.js';
import { findTranscript } from '../accounts/transcripts.ts';
import { summarise } from '../runner/spawn.ts';
import { scanBack, type TranscriptEntry } from '../runner/transcript.ts';
import { PEER_CLAIM_WINDOW_MS } from './registry.ts';

/**
 * How long a session that has touched nothing here may hold what its cwd could
 * reach — the claim window REG-3 already bounds, from the session's NEWEST
 * start (a real `--resume` re-opens it; typing never does). One number, not
 * two: this is the same "it may be about to claim" question.
 */
export const UNKNOWN_LEASE_MS = PEER_CLAIM_WINDOW_MS;

/**
 * How long a `phase-lock.sh … claim` holds its scope with no lock on disk to
 * show for it (control-tower phase 108, #172): long enough for the console's
 * lock list to catch up with a claim it has not read yet, and no longer — a
 * claim whose lock has gone (released by another session, by the console, or
 * by its lease) holds nothing after it.
 */
export const CLAIM_GRACE_MS = 60_000;

/** The transcript tail read on a first look: recent work, never the whole history. */
const TAIL_BYTES = 4 * 1024 * 1024;
const MAX_PATHS = 256;
const MAX_PLANS = 64;
const MAX_EVIDENCE = 6;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** The `git` verbs that change a repository — a `git -C <dir> <verb>` touches `<dir>`. */
const GIT_CHANGING = /\bgit\s+-C\s+("([^"]+)"|'([^']+)'|([^\s;&|]+))\s+(commit|add|rm|mv|checkout|switch|merge|rebase|reset|restore|stash|apply|am|cherry-pick|revert|pull)\b/g;
const SCRIPT_CALL = /phase-(lock|graph)\.sh\s+([A-Za-z0-9][A-Za-z0-9._-]*)([^;&|\n]*)/g;
const DOCS_ROOT_SET = /\bDOCS_ROOT=("([^"]+)"|'([^']+)'|([^\s;&|]+))/;
const LOCK_PHASE = /^\s+(claim|conflicts|release|status|mirror)\s+(\d+)/;
const LOCK_SCOPE = /--scope(?:=|\s+)("([^"]*)"|'([^']*)'|([^\s;&|]+))/;

/** A `phase-lock.sh` verb that names a phase. */
export type LockVerb = 'claim' | 'conflicts' | 'release' | 'status' | 'mirror';
export type Touch = { path: string; dir?: true; at?: number };
export type PlanTouch = { slug: string; docsRoot?: string; phase?: number; verb?: LockVerb; scope?: string[]; at?: number };
export type SessionTouches = { paths: Touch[]; plans: PlanTouch[] };

/** How a session's scope was read — the words the queue and the run card show. */
export type ScopeBasis = 'declared' | 'touched' | 'unknown' | 'elsewhere' | 'nothing';

export type InferredScope = {
  /** What it holds. Empty holds nothing. */
  scope: string[];
  basis: ScopeBasis;
  /** When the hold lapses (ms epoch) — `touched` and `unknown` only. */
  leaseUntil?: number;
  /** A few lines of what it was read from, for the card. */
  evidence: string[];
};

const quoted = (m: RegExpMatchArray | null, at: number): string | undefined =>
  m ? (m[at + 1] ?? m[at + 2] ?? m[at + 3]) : undefined;

/** Every touch in a transcript's JSONL text. Lines that are not assistant tool calls are ignored. */
export function touchesOf(jsonl: string): SessionTouches {
  const out: SessionTouches = { paths: [], plans: [] };
  for (const line of jsonl.split('\n')) {
    if (!line.includes('tool_use')) continue;
    let entry: { timestamp?: string; message?: { content?: unknown } };
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    const parsed = Date.parse(entry.timestamp ?? '');
    const at = Number.isFinite(parsed) ? parsed : undefined;
    const stamp = at != null ? { at } : {};
    for (const use of content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
      if (use?.type !== 'tool_use' || !use.input) continue;
      if (EDIT_TOOLS.has(use.name ?? '')) {
        const path = use.input.file_path ?? use.input.notebook_path;
        if (typeof path === 'string' && path.startsWith('/')) out.paths.push({ path, ...stamp });
        continue;
      }
      if (use.name !== 'Bash' || typeof use.input.command !== 'string') continue;
      const command = use.input.command;
      for (const m of command.matchAll(GIT_CHANGING)) {
        const dir = quoted(m, 1);
        if (dir?.startsWith('/')) out.paths.push({ path: dir, dir: true, ...stamp });
      }
      const docsRoot = quoted(command.match(DOCS_ROOT_SET), 1);
      for (const m of command.matchAll(SCRIPT_CALL)) {
        const rest = m[3] ?? '';
        const lock = m[1] === 'lock';
        const call = lock ? LOCK_PHASE.exec(rest) : null;
        const scope = lock ? quoted(rest.match(LOCK_SCOPE), 1) : undefined;
        out.plans.push({
          slug: m[2]!,
          ...(docsRoot ? { docsRoot } : {}),
          ...(call ? { phase: Number(call[2]), verb: call[1] as LockVerb } : {}),
          ...(scope ? { scope: parseScope(scope) } : {}),
          ...stamp,
        });
      }
    }
  }
  return trim(out);
}

function trim(touches: SessionTouches): SessionTouches {
  return { paths: touches.paths.slice(-MAX_PATHS), plans: touches.plans.slice(-MAX_PLANS) };
}

/**
 * A transcript's touches, read incrementally: the first look reads the tail,
 * every later one only the bytes appended since — up to the last complete
 * line, so a line being written is read whole next time rather than lost.
 */
export class TranscriptReader {
  private readonly seen = new Map<string, { size: number; touches: SessionTouches }>();

  read(path: string | undefined): SessionTouches | null {
    if (!path) return null;
    let size: number;
    try { size = statSync(path).size; } catch { return null; }
    const hit = this.seen.get(path);
    if (hit && hit.size === size) return hit.touches;
    const grows = Boolean(hit && size > hit.size);
    const from = grows ? hit!.size : Math.max(0, size - TAIL_BYTES);
    let buffer: Buffer;
    try {
      buffer = Buffer.alloc(size - from);
      const fd = openSync(path, 'r');
      try { readSync(fd, buffer, 0, buffer.length, from); } finally { closeSync(fd); }
    } catch {
      return hit?.touches ?? null;
    }
    const end = buffer.lastIndexOf(0x0a);
    let text = end >= 0 ? buffer.subarray(0, end + 1).toString('utf8') : '';
    // A tail that starts mid-line drops its first, partial line.
    if (!grows && from > 0) text = text.slice(text.indexOf('\n') + 1);
    const fresh = touchesOf(text);
    const touches = grows ? trim({
      paths: [...hit!.touches.paths, ...fresh.paths], plans: [...hit!.touches.plans, ...fresh.plans],
    }) : fresh;
    this.seen.set(path, { size: from + (end >= 0 ? end + 1 : 0), touches });
    if (this.seen.size > 512) this.seen.delete(this.seen.keys().next().value!);
    return touches;
  }

  /**
   * The session's last `limit` events, oldest first — read from the END of its
   * log (control-tower phase 95, #138): tool calls paired with their results,
   * its own words, and the markers (a compaction, the console's wrap-up steer,
   * a person's input). Backwards through the one backward reader
   * (`scanBack`), bounded by `ACTIVITY_BUDGET`, so twenty events cost the
   * lines they are and never the file; `bytesRead` says what they cost.
   *
   * A subagent's lines (`isSidechain`) are its own and a thinking block is not
   * activity. A call whose result the tail never reached is `open` unless the
   * session spoke again in a later message — then it had come back, and
   * `endedAt` is no later than that message. Null for a log that is not there.
   */
  activity(path: string | undefined | null, opts: { limit?: number; since?: number } = {}): SessionActivity | null {
    if (!path) return null;
    try {
      if (!statSync(path).isFile()) return null;
    } catch {
      return null;
    }
    const limit = clampActivity(opts.limit);
    const { since } = opts;
    const results = new Map<string, { at: string; error: boolean; code?: number }>();
    const newest: ActivityEvent[] = [];
    // Message groups met so far, newest first: a tool call has come back once a
    // LATER message of the session exists — the model speaks after its results.
    const groups: { id: string; at: string }[] = [];
    const bytesRead = scanBack(path, ACTIVITY_BUDGET, (line) => {
      let entry: LogLine;
      try {
        entry = JSON.parse(line) as LogLine;
      } catch {
        return false;
      }
      if (!entry || typeof entry !== 'object' || entry.isSidechain === true) return false;
      const at = typeof entry.timestamp === 'string' ? entry.timestamp : '';
      const when = Date.parse(at);
      if (since != null && Number.isFinite(when) && when < since) return true;
      for (const event of eventsOfLine(entry, at, results, groups)) {
        newest.push(event);
        if (newest.length >= limit) return true;
      }
      return false;
    }, ACTIVITY_MAX_LINE);
    return { events: newest.reverse(), bytesRead };
  }
}

/* ------------------------------------------------------------------ *
 * A session's activity, from its own log (control-tower phase 95, #138)
 * ------------------------------------------------------------------ */

/** The most one activity read takes off a log: the tail, never a 16 MB file. */
const ACTIVITY_BUDGET = 4 * 1024 * 1024;
/** A line longer than this — an image read, a huge result — is skipped, not held. */
const ACTIVITY_MAX_LINE = 1024 * 1024;
export const ACTIVITY_DEFAULT_LIMIT = 20;
export const ACTIVITY_MAX_LIMIT = 200;
const ACTIVITY_TEXT = 2_000;
const INPUT_TEXT = 300;

/** One thing the session did, with the log line (`uuid`) it was read from. */
export type ActivityEvent =
  | {
    kind: 'tool'; id: string; name: string; description?: string; summary?: string;
    at: string; endedAt?: string; exit?: 'ok' | 'error'; code?: number; open?: true; line: string;
  }
  | { kind: 'text'; at: string; text: string; line: string }
  | { kind: 'marker'; at: string; marker: 'compaction' | 'wrap-up' | 'supervisor' | 'input'; text: string; line: string };

export type SessionActivity = { events: ActivityEvent[]; bytesRead: number };

/** What `GET /api/run/:slug/phase/:n/activity` answers. */
export type PhaseActivity = {
  phase: number;
  sessionId?: string;
  /** The phase is in flight, so the log is still being written. */
  live: boolean;
  source: 'session-log' | 'none';
  /**
   * Always true: these are a session's own words and a model's tool inputs.
   * A reader that hands them to a model (the supervisor, phase 101) frames
   * them as DATA — never as instructions to follow.
   */
  untrusted: true;
  events: ActivityEvent[];
  bytesRead: number;
  why?: string;
};

type LogBlock = {
  type?: string; id?: string; name?: string; input?: Record<string, unknown>; text?: string;
  tool_use_id?: string; is_error?: boolean; content?: unknown;
};
type LogLine = {
  type?: string; subtype?: string; uuid?: string; timestamp?: string; isSidechain?: boolean;
  isMeta?: boolean; isCompactSummary?: boolean;
  message?: { id?: string; content?: unknown };
};

const clampActivity = (limit: unknown): number => {
  const n = Math.floor(Number(limit));
  return Number.isFinite(n) && n > 0 ? Math.min(n, ACTIVITY_MAX_LIMIT) : ACTIVITY_DEFAULT_LIMIT;
};

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((b: LogBlock) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n')
      : '';

/** The events one log line holds, newest first — its results are filed, not returned. */
function eventsOfLine(
  entry: LogLine, at: string,
  results: Map<string, { at: string; error: boolean; code?: number }>,
  groups: { id: string; at: string }[],
): ActivityEvent[] {
  const line = String(entry.uuid ?? '');
  if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
    return [{ kind: 'marker', at, marker: 'compaction', text: 'Conversation compacted', line }];
  }
  const content = entry.message?.content;
  if (entry.type === 'user') {
    if (Array.isArray(content) && content.some((b: LogBlock) => b?.type === 'tool_result')) {
      for (const block of content as LogBlock[]) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const code = /^Exit code (\d+)/m.exec(textOf(block.content).slice(0, 400))?.[1];
        results.set(block.tool_use_id, { at, error: block.is_error === true, ...(code ? { code: Number(code) } : {}) });
      }
      return [];
    }
    if (entry.isMeta || entry.isCompactSummary) return [];
    const said = textOf(content).trim();
    if (!said) return [];
    const marker = said.startsWith('Supervisor check:') ? (/Wrap up now/.test(said) ? 'wrap-up' : 'supervisor') : 'input';
    return [{ kind: 'marker', at, marker, text: said.slice(0, INPUT_TEXT), line }];
  }
  if (entry.type !== 'assistant' || !Array.isArray(content)) return [];
  const group = entry.message?.id ?? line;
  if (groups[groups.length - 1]?.id === group) groups[groups.length - 1]!.at = at;
  else groups.push({ id: group, at });
  // The earliest line of the message after this one — when the session spoke next.
  const next = groups.length > 1 ? groups[groups.length - 2]!.at : undefined;
  const out: ActivityEvent[] = [];
  for (const block of [...(content as LogBlock[])].reverse()) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      out.push({ kind: 'text', at, text: block.text.trim().slice(0, ACTIVITY_TEXT), line });
    } else if (block?.type === 'tool_use' && typeof block.id === 'string') {
      const input = block.input ?? {};
      const description = typeof input.description === 'string' && input.description.trim()
        ? input.description.trim().slice(0, 240) : undefined;
      const summary = summarise(input) || undefined;
      const result = results.get(block.id);
      out.push({
        kind: 'tool', id: block.id, name: String(block.name ?? 'tool'),
        ...(description ? { description } : {}), ...(summary ? { summary } : {}), at,
        ...(result
          ? { endedAt: result.at, exit: result.error ? 'error' : 'ok', ...(result.code != null ? { code: result.code } : {}) }
          : next ? { endedAt: next } : { open: true as const }),
        line,
      });
    }
  }
  return out;
}

/**
 * Where a session's own log is: the path its presence hook reported (the
 * registry's `transcript`), else `<config dir>/projects/<cwd>/<id>.jsonl` in
 * the first of `configDirs` that has it — the account that recorded it first.
 */
export function locateSessionLog(
  sessionId: string,
  where: { registryPath?: string | null; configDirs: readonly string[] },
): string | null {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return null;
  if (where.registryPath) {
    try {
      if (statSync(where.registryPath).isFile()) return where.registryPath;
    } catch { /* gone: look where the accounts keep it */ }
  }
  for (const dir of where.configDirs) {
    const found = findTranscript(dir, sessionId);
    if (found) return found;
  }
  return null;
}

/** A phase's activity: its live (or latest) session's log, or why there is none. */
export function sessionActivityFor(input: {
  phase: number;
  record: { sessionId?: string; status?: string; attempts?: number } | undefined;
  locate: (sessionId: string) => string | null;
  reader: TranscriptReader;
  limit?: number;
  since?: number;
}): PhaseActivity {
  const { phase, record } = input;
  const live = (PHASE_IN_FLIGHT as readonly string[]).includes(record?.status ?? '');
  const none = (why: string, sessionId?: string): PhaseActivity =>
    ({ phase, ...(sessionId ? { sessionId } : {}), live, source: 'none', untrusted: true, events: [], bytesRead: 0, why });
  const sessionId = record?.sessionId;
  if (!sessionId) return none(`no session has started for phase ${phase}`);
  const path = input.locate(sessionId);
  const read = path ? input.reader.activity(path, { limit: input.limit, since: input.since }) : null;
  if (!read) return none(`the log of session ${sessionId} is not on this machine`, sessionId);
  return { phase, sessionId, live, source: 'session-log', untrusted: true, events: read.events, bytesRead: read.bytesRead };
}

/** `?limit=` and `?since=` as the activity route takes them — a bad value is the default, a huge one capped. */
export function activityQuery(params: URLSearchParams): { limit: number; since?: number; run?: string } {
  const since = Date.parse(params.get('since') ?? '');
  const run = params.get('run');
  return {
    limit: clampActivity(params.get('limit')),
    ...(Number.isFinite(since) ? { since } : {}),
    ...(run && /^[A-Za-z0-9._-]{1,64}$/.test(run) ? { run } : {}),
  };
}

/**
 * The session's events as replay lines, for `replayFor` — the stream shapes
 * the pane already draws (`text`, `tool`, `tool-result`, `notice`), each
 * stamped with the phase and `source: 'session-log'`.
 */
export function activityOf(events: readonly ActivityEvent[], phase: number): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  const entry = (at: string, data: Record<string, unknown>): TranscriptEntry =>
    ({ seq: 0, at, event: 'stream', data: { phase, source: 'session-log', ...data } });
  for (const event of events) {
    if (event.kind === 'text') out.push(entry(event.at, { kind: 'text', text: event.text }));
    else if (event.kind === 'marker') out.push(entry(event.at, { kind: 'notice', text: `${event.marker}: ${event.text}` }));
    else {
      out.push(entry(event.at, { kind: 'tool', id: event.id, name: event.name, summary: event.summary ?? event.description ?? '' }));
      if (event.exit) {
        out.push(entry(event.endedAt ?? event.at, {
          kind: 'tool-result', id: event.id, ok: event.exit === 'ok', ...(event.code != null ? { detail: `exit ${event.code}` } : {}),
        }));
      }
    }
  }
  return out;
}

/** Both spellings of a root — as given and physical — so a symlinked tmpdir still matches. */
function spellings(root: string): string[] {
  const given = resolve(root);
  let physical = given;
  try { physical = realpathSync(given); } catch { /* not on disk: the given spelling is all there is */ }
  return [...new Set([given, physical])];
}

/** `path` relative to the root, or null when it is not under it. */
function under(roots: readonly string[], path: string): string | null {
  const target = resolve(path);
  for (const root of roots) {
    if (target === root) return '';
    if (target.startsWith(root + sep)) return target.slice(root.length + 1);
  }
  return null;
}

/**
 * The scope token for a touched path under the root: the directory it is in,
 * two segments deep (`packages/web`, `phased-execution/viewer`), which
 * intersects the repository or path a Repos cell names and nothing beside it;
 * the root's own name for a top-level file.
 */
function tokenOf(rel: string, dir: boolean, own: string): string {
  const segments = rel.split('/').filter(Boolean);
  const dirs = dir ? segments : segments.slice(0, -1);
  if (!dirs.length) return own;
  return normalizeToken(dirs.slice(0, 2).join('/')) || normalizeToken(dirs[0]!) || own;
}

const newestStart = (record: { startedAt?: string; resumedAt?: string }): number => {
  const starts = [record.startedAt, record.resumedAt].map((iso) => Date.parse(iso ?? '')).filter(Number.isFinite);
  return starts.length ? Math.max(...starts) : Number.NaN;
};

/**
 * Claude's own files, wherever they are (control-tower phase 108, #180): a
 * config home directly under the user's home — `~/.claude` (memory, plans,
 * todos, projects), `~/.claude-<name>`, `~/.claude.json` — and the session's
 * own config dir (a profile's, under the console's state). A session writes
 * there as it works, whatever repository it works in, so a path there is no
 * evidence of the tree and none of another one either.
 */
function claudeOwn(path: string, home: string, configDir: string | undefined): boolean {
  const target = resolve(path);
  const base = resolve(home);
  if (target.startsWith(base + sep)) {
    const first = target.slice(base.length + 1).split(sep)[0] ?? '';
    if (/^\.claude(?:\.json|-[^/]*)?$/.test(first)) return true;
  }
  if (configDir) {
    const dir = resolve(configDir);
    if (target === dir || target.startsWith(dir + sep)) return true;
  }
  return false;
}

/** `HH:MMZ` — when a touch was, for the card. */
const clock = (at: number | undefined): string => (at != null && Number.isFinite(at) ? ` at ${new Date(at).toISOString().slice(11, 16)}Z` : '');

/**
 * What a session holds in `root`, and why.
 *
 * In order: a declared `PE_SCOPE` is its own word; what it touched under the
 * root, held until `PEER_CLAIM_WINDOW_MS` after its LAST touch there (an idle
 * terminal lapses, an active one keeps holding); evidence that it works
 * ELSEWHERE — every edit outside, or a plan of another docs root — holds
 * nothing; and with no evidence at all, the unknown lease: what its cwd could
 * reach (a repository's token, else `all`) until `UNKNOWN_LEASE_MS` after its
 * newest start, and nothing after. The cwd is never evidence past the lease.
 *
 * Three things are not evidence of anything (control-tower phase 108): a path
 * under a Claude config home (`claudeOwn` — #180's memory writes); a bare
 * `changed .`, a git verb at the root that names no path (#180); and a lock
 * call the session has let go of — a later `release` of the same phase, or a
 * `claim` whose lock is gone past `CLAIM_GRACE_MS` (#172). A release holds
 * nothing itself, and a session whose only lock calls were let go of holds
 * nothing rather than the unknown lease: it claimed, and let go. The evidence
 * names only what the hold rests on, newest first, with when.
 */
export function inferSessionScope(input: {
  root: string;
  record: { scope?: string; cwd: string; startedAt?: string; resumedAt?: string; configDir?: string };
  touches: SessionTouches | null;
  /** This root's plans: a phase's scope, `[]` for a plan with no phase named, undefined for a plan it does not have. */
  planScope?: (slug: string, phase?: number) => string[] | undefined;
  /** Is this directory a checkout of its own? Defaults to "has a `.git`". */
  isRepository?: (dir: string) => boolean;
  /** Is this plan phase's lock on disk right now? Absent: nobody asked, and a claim holds by its own word. */
  lockHeld?: (slug: string, phase: number) => boolean;
  /** The user's home, where the Claude config homes are. Defaults to `os.homedir()`. */
  home?: string;
  now: number;
}): InferredScope {
  const { record, now } = input;
  const declared = parseScope(record.scope ?? '');
  if (declared.length) return { scope: declared, basis: 'declared', evidence: [`declared PE_SCOPE ${declared.join(',')}`] };

  const roots = spellings(input.root);
  const own = normalizeToken(basename(roots[0]!)) || 'all';
  const home = input.home ?? homedir();
  const inside: string[] = [];
  /** What a hold rests on — touches under the root, with when. */
  const held: { line: string; at?: number }[] = [];
  /** Where else it works, for an `elsewhere` card. */
  const away: string[] = [];
  /** The lock calls it let go of, for a `nothing` card. */
  const letGo: string[] = [];
  const note = (list: string[], line: string): void => { if (list.length < MAX_EVIDENCE && !list.includes(line)) list.push(line); };
  let lastTouch = Number.NEGATIVE_INFINITY;
  let elsewhere = false;
  const hold = (token: string, at: number | undefined): void => {
    if (token && !inside.includes(token)) inside.push(token);
    if (at != null && at > lastTouch) lastTouch = at;
  };

  for (const touch of input.touches?.paths ?? []) {
    const rel = under(roots, touch.path);
    if (rel === null) {
      if (claudeOwn(touch.path, home, record.configDir)) continue;
      elsewhere = true;
      note(away, `${touch.dir ? 'changed' : 'edited'} ${touch.path}`);
      continue;
    }
    // `git -C <root> …` names no path: it is no evidence of WHERE it worked.
    if (touch.dir && rel === '') continue;
    hold(tokenOf(rel, Boolean(touch.dir), own), touch.at);
    held.push({ line: `${touch.dir ? 'changed' : 'edited'} ${rel}`, ...(touch.at != null ? { at: touch.at } : {}) });
  }

  const plans = input.touches?.plans ?? [];
  // The last release of each phase this transcript names: every lock call on
  // that phase before it has been let go of.
  const released = new Map<string, number>();
  plans.forEach((plan, i) => { if (plan.verb === 'release' && plan.phase != null) released.set(`${plan.slug}#${plan.phase}`, i); });
  plans.forEach((plan, i) => {
    if (plan.docsRoot && under(roots, plan.docsRoot) === null) {
      elsewhere = true;
      note(away, `named plan ${plan.slug} in ${plan.docsRoot}`);
      return;
    }
    const named = `${plan.slug}${plan.phase != null ? ` P${plan.phase}` : ''}`;
    const ours = plan.scope?.length ? plan.scope : input.planScope?.(plan.slug, plan.phase);
    if (plan.verb === 'release' || (plan.phase != null && (released.get(`${plan.slug}#${plan.phase}`) ?? -1) > i)) {
      if (ours === undefined) { elsewhere = true; note(away, `named plan ${plan.slug}, not a plan of this root`); return; }
      if (plan.verb === 'release') note(letGo, `released ${named}`);
      return;
    }
    if (plan.verb === 'claim' && plan.phase != null && input.lockHeld && !input.lockHeld(plan.slug, plan.phase)
      && !(plan.at != null && now - plan.at < CLAIM_GRACE_MS)) {
      if (ours !== undefined) note(letGo, `claimed ${named}, and its lock has gone`);
      return;
    }
    if (ours === undefined) { elsewhere = true; note(away, `named plan ${plan.slug}, not a plan of this root`); return; }
    for (const token of ours) hold(token, plan.at);
    if (ours.length) held.push({ line: `named ${named}`, ...(plan.at != null ? { at: plan.at } : {}) });
  });

  if (inside.length) {
    // Newest first, each line once, with when: what is keeping the hold alive leads.
    const evidence: string[] = [];
    for (const { line, at } of [...held].sort((a, b) => (b.at ?? Number.NEGATIVE_INFINITY) - (a.at ?? Number.NEGATIVE_INFINITY))) {
      if (evidence.length >= MAX_EVIDENCE) break;
      if (!evidence.some((said) => said.startsWith(`${line} at `) || said === line)) evidence.push(`${line}${clock(at)}`);
    }
    const since = Number.isFinite(lastTouch) ? lastTouch : newestStart(record);
    const leaseUntil = (Number.isFinite(since) ? since : now) + PEER_CLAIM_WINDOW_MS;
    if (now >= leaseUntil) return { scope: [], basis: 'nothing', evidence };
    return { scope: inside, basis: 'touched', leaseUntil, evidence };
  }
  if (letGo.length) return { scope: [], basis: 'nothing', evidence: letGo };
  if (elsewhere) return { scope: [], basis: 'elsewhere', evidence: away };

  const start = newestStart(record);
  const leaseUntil = start + UNKNOWN_LEASE_MS;
  if (!Number.isFinite(start) || now >= leaseUntil) {
    return { scope: [], basis: 'nothing', evidence: ['touched nothing here'] };
  }
  const isRepository = input.isRepository ?? ((dir: string) => existsSync(join(dir, '.git')));
  const rel = under(roots, record.cwd);
  const first = rel?.split('/')[0] ?? '';
  const token = first && !first.startsWith('.') && isRepository(join(roots[0]!, first)) ? normalizeToken(first) : '';
  return {
    scope: token ? [token] : ['all'], basis: 'unknown', leaseUntil,
    evidence: [token ? `opened in ${first}, nothing touched yet` : 'opened in the root, nothing touched yet'],
  };
}
