/**
 * The session registry — who is in this repository right now.
 *
 * Until this existed an interactive `claude`, a console agent and an autopilot
 * lane could see each other only through lock files and leases: a person's
 * session that ended with its lock still on disk held the queue for the rest
 * of the lease, and a live one read no differently from a dead one. The
 * user-scope hook (`scripts/session-hook.sh`, installed from Settings or
 * `phase-console install-hooks`) now reports SessionStart / Stop / SessionEnd
 * for every Claude session on the machine whose working directory a console
 * owns — by POST while the console is up, by a file in the instance's inbox
 * while it is not — and this module keeps the answer.
 *
 * Three rules the code is built around. **Presence is a three-valued answer**:
 * `ended` (the hook said so, or the session's process is gone), `live` (seen
 * recently and nothing says otherwise), `unknown` (nobody reports it; lease
 * rules apply) — a reader that cannot tell `unknown` from `ended` would turn
 * an un-hooked machine into a machine where every lock is debris. **Only a
 * STRONG correlation may make a lock debris**: the lock's own `session=` line
 * naming the session. Matching by `<user>@<host>` and time is for display —
 * a person with two sessions ends one, and the other still holds its lock.
 * **The hook is the writer and this is the reader**: nothing here invents a
 * session; a payload is validated, capped and applied, never trusted.
 *
 * State lives under `INSTANCE_STATE_DIR/sessions/` — per instance, like the
 * accounts and MCP registries and for the same reason: two consoles on one
 * machine are two projects. `<id>.json` is the record; `inbox/` is where the
 * hook drops events it could not POST, ingested at boot, on a watcher event
 * and on a slow poll, then deleted.
 */

import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync,
  writeSync, type FSWatcher,
} from 'node:fs';
import { join } from 'node:path';

import { CLAUDE_COMM, processState, type ProcessState } from '../pid.ts';
import type { Presence, PresenceEndSource } from '../../shared/run-lifecycle.js';

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

export type SessionEventName = 'SessionStart' | 'SessionEnd' | 'Stop' | 'Notification';

/**
 * What a session can be stopped waiting FOR.
 *
 * Three words, one per notification the CLI actually sends that stops a
 * session, deliberately NOT one word per `notification_type`: `permission` and
 * `elicitation` are both "answer this or nothing proceeds" and the console
 * offers the same nothing for either, while `input` is a finished turn, which
 * is what a terminal at rest looks like. Anything else is not a wait at all
 * (`NOTIFICATION_WAIT_KINDS` maps only the types that stop a session), and a
 * type in none of the maps leaves the record untouched.
 */
export type WaitingKind = 'permission' | 'elicitation' | 'input';

/**
 * The CLI's `notification_type` → what the session is waiting for.
 *
 * ⚠️ Every key here is a payload the CLI documents, and the map is
 * deliberately CLOSED: an unlisted type raises nothing, which is the safe
 * direction (a missed row costs an operator a glance at the sessions page; a
 * spurious urgent push costs the channel). `tests/unit/session-hook.bats` pins
 * the payloads against real hook input.
 *
 * The CLI's hooks reference lists twelve types (2026-09, CLI 2.1.272); every
 * one is in exactly one of `NOTIFICATION_WAIT_KINDS`, `NOTIFICATION_ANSWERS`
 * and `NOTIFICATION_IGNORED`, and `test/docs-parity.test.ts` holds the list to
 * the three maps. A URL elicitation is an elicitation; a background agent that
 * needs input is a turn waiting on its person, like an idle prompt.
 */
export const NOTIFICATION_WAIT_KINDS: Readonly<Record<string, WaitingKind>> = Object.freeze({
  permission_prompt: 'permission',
  elicitation_dialog: 'elicitation',
  elicitation_url_dialog: 'elicitation',
  idle_prompt: 'input',
  agent_needs_input: 'input',
});

/**
 * The types that ANSWER an open wait of their kind (REG-4): the CLI documents
 * an elicitation completing or being responded to, and a background agent
 * completing — the closest thing to the "answered" hook the registry was built
 * without. A type here clears a wait of the kind it names and nothing else.
 */
export const NOTIFICATION_ANSWERS: Readonly<Record<string, WaitingKind>> = Object.freeze({
  elicitation_complete: 'elicitation',
  elicitation_response: 'elicitation',
  agent_completed: 'input',
});

/**
 * The documented types that are not a wait and answer none: a sign-in that
 * succeeded, and the quota family's automatic resume (2.1.234+). Listed so the
 * console's silence about them is a decision, not a gap — a type in NONE of the
 * three maps is new, and is warned once per value (`sessions.notification-unmapped`).
 */
export const NOTIFICATION_IGNORED: readonly string[] = Object.freeze([
  'auth_success',
  'quota_auto_resume_fired',
  'quota_auto_resume_stale',
  'quota_auto_resume_disabled',
]);

/** Does this build act on a declared `notification_type` at all? */
export function actsOnNotification(type: string): boolean {
  return type in NOTIFICATION_WAIT_KINDS || type in NOTIFICATION_ANSWERS;
}

/** How a wait ended: answered (a turn ended, progress, an answer type), the session ended, or nobody answered in time. */
export type WaitOutcome = 'answered' | 'ended' | 'unanswered';

/**
 * How long a wait may stand before the episode is closed as UNANSWERED (REG-4).
 * An hour — the hook's own patience (`approvals.ts` `HOOK_TIMEOUT_SECONDS`): a
 * wait used to have no exit but three hook events, and one stood 13 hours
 * across an answer, a day's work and a clean exit. A prompt still really up
 * re-notifies, and that opens a new episode.
 */
export const WAIT_ANSWER_CAP_MS = 60 * 60_000;

/** A transcript written this much after the latest ask is evidence the session moved on — slack for two clocks. */
export const TRANSCRIPT_GRACE_MS = 2_000;

/** Loudest first, so a sharpening episode can only move one way. */
const WAITING_RANK: Readonly<Record<WaitingKind, number>> = Object.freeze({
  permission: 0, elicitation: 1, input: 2,
});

/**
 * What this Notification is waiting for, or `null` for "not a wait".
 *
 * `notification_type` is authoritative when the payload carries one. Without
 * it — a CLI predating the field — the old `/permission/i` sniff stands, and
 * only for permission: guessing that an unknown message is an idle prompt is
 * how the sniff came to call everything an ask in the first place.
 */
/** Evidence of life after an end: the end, its reason and its provenance go (a resume keeps its id). */
function revive(record: SessionRecord): void {
  delete record.endedAt;
  delete record.reason;
  delete record.endedBy;
  delete record.endedDetectedAt;
}

/** End a wait episode, leaving the record of how it ended. */
function closeWait(record: SessionRecord, at: string, outcome: WaitOutcome): void {
  const waiting = record.waiting;
  if (!waiting) return;
  record.lastWait = {
    since: waiting.since, kind: waiting.kind, ...(waiting.note ? { note: waiting.note } : {}), clearedAt: at, outcome,
  };
  delete record.waiting;
}

function waitingKindOf(p: { notification_type?: string; message?: string }): WaitingKind | null {
  const declared = p.notification_type;
  if (declared) return NOTIFICATION_WAIT_KINDS[declared] ?? null;
  return /permission/i.test(p.message ?? '') ? 'permission' : null;
}
/** autopilot — a lane this console (or another) spawned; agent — a console pty session; foreign — a person's own `claude`. */
export type SessionKind = 'autopilot' | 'agent' | 'foreign';
export type SessionPresence = Presence;

/** What `scripts/session-hook.sh` sends (and drops into the inbox). Every field but the first three is optional. */
export type HookPayload = {
  session_id: string;
  event: SessionEventName;
  cwd: string;
  transcript_path?: string;
  source?: string;
  reason?: string;
  owner?: string;
  scope?: string;
  user?: string;
  host?: string;
  pid?: number;
  root?: string;
  at?: string;
  /** Notification only: the CLI's own words for what it is waiting on. */
  message?: string;
  /**
   * Notification only: WHICH notification this is, in the CLI's own vocabulary
   * (`permission_prompt`, `elicitation_dialog`, `idle_prompt`, and whatever it
   * adds next). Read rather than sniffed: the message text was matched
   * `/permission/i` for want of anything better, which called every hook event
   * an ask and made the urgent push fire for the CLI talking to itself.
   * Absent on payloads from a CLI that predates the field — those fall back to
   * the sniff, which is the old behaviour and no worse.
   */
  notification_type?: string;
  /**
   * The console's own MCP health probe (`PHASE_CONSOLE_PROBE=1` in its
   * environment, forwarded by the hook). Kept as a record — it registers as
   * `agent` through its `console/mcp-probe` owner and ends with a real
   * SessionEnd — but flagged, so it is left out of every operator-facing list
   * and never weakly correlated with anybody's lock (SLF-2, REG-6).
   */
  probe?: boolean;
};

export type SessionRecord = {
  sessionId: string;
  kind: SessionKind;
  /** The console's own probe — see `HookPayload.probe`. */
  probe?: true;
  cwd: string;
  /** The project root the hook resolved for `cwd`, when it could. */
  root?: string;
  transcript?: string;
  /** `PE_OWNER` in the session's environment — `autopilot/<runId>` for a lane. */
  owner?: string;
  scope?: string;
  user?: string;
  host?: string;
  /** The `claude` process, for the liveness probe. */
  pid?: number;
  /** ISO — the first SessionStart seen (or the first event, when it was not a start). */
  startedAt: string;
  /** ISO — the newest event seen. */
  lastSeen: string;
  /**
   * ISO — when the session ended. For a REPORTED end (`endedBy: 'hook'`) the
   * moment its SessionEnd gave; for an INFERRED one (`endedBy: 'probe'`) the
   * last evidence of life, `lastSeen` — never the moment somebody happened to
   * look, which is how a record once claimed 17.3 hours it did not live (REG-9).
   */
  endedAt?: string;
  /** Who said it ended: the session's own SessionEnd, or the probe finding its process gone. */
  endedBy?: PresenceEndSource;
  /** ISO — when the probe noticed an inferred end (`endedBy: 'probe'` only). */
  endedDetectedAt?: string;
  reason?: string;
  source?: string;
  /** Stop events seen — one per finished turn; a heartbeat. */
  turns: number;
  /**
   * Hook events applied to this record (zero-touch phase 16, REG-9 ii). A
   * foreign session with many events and `turns 0` has a Stop hook that is not
   * reaching the console, so its turn count is UNKNOWN rather than zero —
   * `turnsSourceOf` says which.
   */
  events?: number;
  /**
   * The last event applied, and how late (REG-2): `at` is the session's own
   * clock, `appliedAt` the console's, `lateMs` the gap. `via` says which door
   * it came through — the hook's POST, the inbox a console drained, or the
   * `phase-console sessions ingest` verb with no console up — and `history`
   * marks one older than `INBOX_HISTORY_HORIZON_MS`, applied as a fact and
   * never as a reason to push or to decide about a lock.
   */
  lastEvent?: { event: SessionEventName; at: string; appliedAt: string; lateMs: number; via: IngestVia; history?: true };
  /**
   * Turn-ends the RUNNER's own stream observed (`{kind:'step'}`), written only
   * by `heartbeat()`.
   *
   * A second field rather than a second writer of `turns`, and that is the
   * whole point: an autopilot session has two possible turn reporters — the
   * user-scope Stop hook and this — and adding them would count every turn
   * twice on a machine where both happen to fire. They are kept apart and
   * `turnsOf` takes the larger, so the answer is right whether one reports,
   * the other does, or both do.
   */
  streamTurns?: number;
  /**
   * Set by a Notification hook event: the session is stopped waiting on a
   * person — a permission prompt, or idle waiting for input. `since` is the
   * episode's start and never moves within one episode; it is the inbox item's
   * clock, and what makes an old ack stale when a NEW episode begins. Cleared
   * by Stop (the turn the answer arrived in ends), SessionEnd, a reviving
   * SessionStart, an answering notification type (`NOTIFICATION_ANSWERS`),
   * and — since 5.0.0, needing no hook at all (REG-4) — progress past the
   * latest ask (a runner heartbeat, the transcript written), the session's
   * process being gone, and `WAIT_ANSWER_CAP_MS` passing unanswered. Each clear
   * leaves `lastWait`.
   */
  waiting?: {
    since: string;
    kind: WaitingKind;
    note?: string;
    /**
     * ISO — the LATEST ask of the episode (each mapped Notification moves it;
     * `since` never moves). Progress after it — a runner heartbeat, the
     * transcript being written — is what clears a wait no hook reported
     * answered (REG-4). Absent on a record written before 5.0.0: `since` stands in.
     */
    at?: string;
  };
  /** How the last wait ended, and when — written by every clear, so an answered wait still says it waited. */
  lastWait?: { since: string; kind: WaitingKind; note?: string; clearedAt: string; outcome: WaitOutcome };
};

/**
 * Where a view's `turns` came from (REG-9 iii): `stream` — the runner's own
 * stream counted them, because the run's `--settings` file displaces the
 * machine-global Stop hook for exactly the sessions the console pays for;
 * `hook` — the Stop hook counted them; `unknown` — a foreign session whose
 * record has moved many times and never seen a Stop, so its `0` is not a count.
 */
export type TurnsSource = 'stream' | 'hook' | 'unknown';

/** A record as the API serves it: the record plus the answers readers want. */
export type SessionView = SessionRecord & {
  presence: SessionPresence;
  /** See `TurnsSource`. */
  turnsSource: TurnsSource;
  /**
   * The plan and phase the session works, when a lock says so or a run record
   * does (strong), or the owner+time suggest it (weak). `runId` is set when a
   * run is what answered.
   */
  plan?: { slug: string; phase: number; strong: boolean; runId?: string };
  /** `max(turns, streamTurns)` — see `turnsOf`. Never their sum. */
  turns: number;
};

/**
 * One phase of one unresolved run, as `correlate` reads it.
 *
 * `sessionId` is the session that run recorded for the phase — the fact that
 * makes this authoritative. `active` marks a phase the run still has in
 * flight, and only orders the `autopilot/<runId>` fallback.
 */
export type RunLink = {
  runId: string;
  slug: string;
  phase: number;
  sessionId?: string;
  active?: boolean;
};

/**
 * How many turns a session has taken, from whichever writer saw them.
 *
 * The MAXIMUM of the two counters, never the sum. The hook counts `Stop`
 * events; the runner counts the `step` events its own stream carries. On an
 * autopilot session the run's `--settings` file displaces the machine-global
 * Stop hook, so the hook's count stays at 0 or 1 for hundreds of real turns
 * and the stream's is the true one; on a person's session no runner is
 * watching and the hook's is. When both report they report the same turns, so
 * the larger is the answer and adding them would be double-counting by
 * construction.
 */
export function turnsOf(record: Pick<SessionRecord, 'turns' | 'streamTurns'>): number {
  return Math.max(record.turns ?? 0, record.streamTurns ?? 0);
}

/** A foreign record this many events deep with no Stop has a turn count nobody is reporting. */
export const TURNS_UNKNOWN_AFTER_EVENTS = 5;

/** Which writer `turnsOf` is quoting — see `TurnsSource`. */
export function turnsSourceOf(record: Pick<SessionRecord, 'turns' | 'streamTurns' | 'events' | 'kind'>): TurnsSource {
  if ((record.streamTurns ?? 0) > 0 && (record.streamTurns ?? 0) >= (record.turns ?? 0)) return 'stream';
  if ((record.turns ?? 0) === 0 && record.kind === 'foreign' && (record.events ?? 0) >= TURNS_UNKNOWN_AFTER_EVENTS) {
    return 'unknown';
  }
  return 'hook';
}

export const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const EVENTS: readonly string[] = ['SessionStart', 'SessionEnd', 'Stop', 'Notification'];
// Same-timestamp inbox drains fold in this order: a start before the ask it
// raised, the ask before the turn-end that clears it, the end last.
const EVENT_RANK: Record<string, number> = { SessionStart: 0, Notification: 1, Stop: 2, SessionEnd: 3 };

/** A never-ended session unseen this long reads `unknown`, not `live` — the hook may simply be gone. */
export const LIVE_WINDOW_MS = 24 * 60 * 60_000;
/** Ended records are kept this long (the Pulse's "just finished"), silent ones this long. */
export const RETAIN_ENDED_MS = 24 * 60 * 60_000;
export const RETAIN_SILENT_MS = 7 * 24 * 60 * 60_000;
/** Weak correlation: a lock claimed this long before the session's first event may still be its own. */
const WEAK_CLAIM_SLACK_MS = 5 * 60_000;

/**
 * The floor under weak correlation (REG-6 iii): a session that lived under a
 * minute and completed no turn is not a person's session, whatever lock its
 * `<user>@<host>` happens to match. The console's own probe is exactly that
 * shape — `turns 0`, sub-minute, spawned in the operator's name — and a hand
 * lock claimed without `--session` used to weakly correlate to a dozen probe
 * corpses an hour. A record flagged `probe` is refused outright; an unflagged
 * one (an older hook) is refused by its lifetime.
 */
export const WEAK_MIN_LIFETIME_MS = 60_000;

export function weaklyCorrelatable(record: SessionRecord, nowMs: number): boolean {
  if (record.probe) return false;
  if (turnsOf(record) > 0) return true;
  const until = record.endedAt ? Date.parse(record.endedAt) : nowMs;
  return until - Date.parse(record.startedAt) >= WEAK_MIN_LIFETIME_MS;
}
const INBOX_DEBOUNCE_MS = 100;
export const INBOX_POLL_MS = 30_000;

/** Which door an event came through — the hook's POST, a console's inbox drain, or the verb with no console up. */
export type IngestVia = 'post' | 'inbox' | 'cli';

/**
 * An inbox event older than this is applied as HISTORY (REG-2 ii): the record
 * learns it — a session that ended thirteen hours ago did end — but nothing
 * reacts to it as if it were news: no `session-ask` push for an ask answered
 * hours ago, no lock decision taken on a record the drain just caught up.
 * Ten minutes: past a restart, well short of a stale ask.
 */
export const INBOX_HISTORY_HORIZON_MS = 10 * 60_000;

/**
 * An inbox this deep is announced (REG-2 iii) — once per crossing, re-armed
 * when it falls back under half. A queue that deep means nothing has been
 * draining it for a long time.
 */
export const INBOX_DEPTH_WATERMARK = 200;

/**
 * An inbox event older than this is REFUSED (REG-2 iii): not applied, removed,
 * and reported. A week — `RETAIN_SILENT_MS` — is past the point where the
 * record it would create is pruned on sight, so applying it would conjure a
 * session only to forget it.
 */
export const INBOX_AGE_REFUSE_MS = 7 * 24 * 60 * 60_000;

/** A drain lock whose holder is gone, or older than this, is reclaimed. */
const INBOX_LOCK_STALE_MS = 60_000;
/** How long `load()` waits for another process's drain to finish before reading the records. */
const INBOX_LOCK_WAIT_MS = 3_000;

/** How a change reached `onChange` — only an event from the inbox (or the verb) carries lateness. */
export type ChangeMeta = { via: IngestVia; lateMs: number; history: boolean };
/**
 * How often a heartbeat may reach the disk and the browser.
 *
 * The runner calls `heartbeat()` for EVERY stream event — many per second on a
 * working lane — and every one of them updates the in-memory record, because
 * that is free and it is what `presence` and `views` read. Persisting and
 * announcing are what cost: a write per token, and an SSE frame per token,
 * each of which fans out into a `sessionViews()` rebuild. So those two are
 * throttled to this, per session. The granularity that buys is 15 seconds on
 * `lastSeen`, which no reader of it can tell: presence measures it against a
 * 24-hour window and `prune` against a week.
 */
export const HEARTBEAT_PERSIST_MS = 15_000;

/* ------------------------------------------------------------------ *
 * Pure pieces
 * ------------------------------------------------------------------ */

/** Block this thread for `ms` — the drain lock's wait. `Atomics.wait` sleeps without spinning. */
function sleepSync(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB: do not wait */ }
}

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Control characters become spaces: one line per value, nothing that can
  // break a log line or a key=value file downstream.
  const s = value.replace(/[\u0000-\u001f]/g, ' ').trim();
  return s ? s.slice(0, max) : undefined;
}

/**
 * Validate and cap a hook body. Null for anything that is not a session event
 * — the route answers 400 and the inbox file is dropped. Only id characters
 * survive in `session_id`; every string is bounded; `pid` must be a positive
 * integer; `at` must parse as a date (else the receiver's clock is used).
 */
export function parseHookPayload(body: unknown): HookPayload | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const sessionId = str(b.session_id, 128);
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return null;
  const event = str(b.event, 32) ?? str(b.hook_event_name, 32);
  if (!event || !EVENTS.includes(event)) return null;
  const cwd = str(b.cwd, 1024);
  if (!cwd || !cwd.startsWith('/')) return null;
  const pidRaw = typeof b.pid === 'number' ? b.pid : typeof b.pid === 'string' ? Number(b.pid) : NaN;
  const pid = Number.isInteger(pidRaw) && pidRaw > 0 && pidRaw < 2 ** 31 ? pidRaw : undefined;
  const at = str(b.at, 40);
  const out: HookPayload = { session_id: sessionId, event: event as SessionEventName, cwd };
  const transcript = str(b.transcript_path, 1024);
  if (transcript) out.transcript_path = transcript;
  const source = str(b.source, 64); if (source) out.source = source;
  const reason = str(b.reason, 64); if (reason) out.reason = reason;
  const message = str(b.message, 256); if (message) out.message = message;
  const notificationType = str(b.notification_type, 64);
  if (notificationType) out.notification_type = notificationType;
  const owner = str(b.owner, 128); if (owner) out.owner = owner;
  const scope = str(b.scope, 256); if (scope) out.scope = scope;
  const user = str(b.user, 64); if (user) out.user = user;
  const host = str(b.host, 64); if (host) out.host = host;
  if (pid) out.pid = pid;
  const root = str(b.root, 1024); if (root && root.startsWith('/')) out.root = root;
  if (at && Number.isFinite(Date.parse(at))) out.at = at;
  if (b.probe === true || b.probe === 1 || b.probe === '1') out.probe = true;
  return out;
}

/** The kind, from the owner the session's environment carried — the same vocabulary the locks use. */
export function kindOf(owner: string | undefined): SessionKind {
  if (!owner) return 'foreign';
  if (/^autopilot\//.test(owner)) return 'autopilot';
  if (/^console\//.test(owner)) return 'agent';
  return 'foreign';
}

/**
 * Fold one event into a record. Pure: the caller decides the clock.
 *
 * A SessionStart for an id that had ENDED revives it — `claude --resume <id>`
 * keeps the id, and its SessionEnd(reason: resume) preceded the new start. An
 * event older than the end it would undo (inbox replay out of order) updates
 * nothing about liveness.
 */
export function applyEvent(prev: SessionRecord | undefined, p: HookPayload, nowIso: string): SessionRecord {
  const at = p.at && Number.isFinite(Date.parse(p.at)) ? new Date(Date.parse(p.at)).toISOString() : nowIso;
  const base: SessionRecord = prev
    ? { ...prev }
    : { sessionId: p.session_id, kind: kindOf(p.owner), cwd: p.cwd, startedAt: at, lastSeen: at, turns: 0 };
  // Facts the payload carries replace what was known; absent ones are kept.
  base.cwd = p.cwd;
  if (p.transcript_path) base.transcript = p.transcript_path;
  if (p.owner) { base.owner = p.owner; base.kind = kindOf(p.owner); }
  if (p.probe) base.probe = true;
  if (p.scope) base.scope = p.scope;
  if (p.user) base.user = p.user;
  if (p.host) base.host = p.host;
  if (p.pid) base.pid = p.pid;
  if (p.root) base.root = p.root;
  base.events = (base.events ?? 0) + 1;
  const stale = base.endedAt != null && Date.parse(at) < Date.parse(base.endedAt);
  if (Date.parse(at) > Date.parse(base.lastSeen)) base.lastSeen = at;
  switch (p.event) {
    case 'SessionStart':
      if (!prev) base.startedAt = at;
      if (p.source) base.source = p.source;
      // A fresh start (or a resume) is not waiting on anything yet.
      if (!stale) { revive(base); closeWait(base, at, 'answered'); }
      break;
    case 'Stop':
      base.turns += 1;
      // The turn ended, so whatever it was waiting on was answered (or given
      // up on) — the finest granularity the CLI's hooks can offer.
      if (!stale) { revive(base); closeWait(base, at, 'answered'); }
      break;
    case 'SessionEnd':
      if (!base.endedAt || Date.parse(at) >= Date.parse(base.endedAt)) {
        base.endedAt = at;
        // REPORTED: the session said so, at the moment it gave (REG-9).
        base.endedBy = 'hook';
        delete base.endedDetectedAt;
        if (p.reason) base.reason = p.reason; else delete base.reason;
        closeWait(base, at, 'ended');
      }
      break;
    case 'Notification': {
      // A dead record is never resurrected by an out-of-order ask.
      if (stale) break;
      // An answering type ends a wait of its own kind — an elicitation
      // completed answers an elicitation, never a permission prompt.
      const answers = p.notification_type ? NOTIFICATION_ANSWERS[p.notification_type] : undefined;
      if (answers) {
        if (base.waiting?.kind === answers) closeWait(base, at, 'answered');
        break;
      }
      const kind = waitingKindOf(p);
      // A notification this build does not classify is NOT a wait. The hook
      // fires for more than a prompt, and treating every one of them as an ask
      // is what made the urgent channel fire for the CLI talking to itself —
      // and a channel that fires for everything is a channel that gets muted.
      // The record is left exactly as it was: not waiting, and not resurrected.
      if (!kind) break;
      // Waiting IS liveness evidence — the process is up, asking.
      revive(base);
      if (!base.waiting) {
        base.waiting = { since: at, at, kind, ...(p.message ? { note: p.message } : {}) };
      } else {
        // Same episode: what it says may sharpen (input → permission), when it
        // began may not — `since` is the ack clock. Sharpening is one-way and
        // toward the loudest word, because a session that asked for input and
        // then for permission is parked on the permission. `at` follows the
        // latest ask, so progress is measured from the last thing it asked.
        if (WAITING_RANK[kind] < WAITING_RANK[base.waiting.kind]) base.waiting.kind = kind;
        if (p.message) base.waiting.note = p.message;
        if (!base.waiting.at || Date.parse(at) > Date.parse(base.waiting.at)) base.waiting.at = at;
      }
      break;
    }
  }
  return base;
}

/**
 * A probe of a session's process. `boolean` is the old shape and still works
 * (`false` ⇒ gone); `ProcessState` is the one that can say `stopped`.
 */
export type PresenceProbe = (pid: number) => boolean | ProcessState;

/** Three-valued, by the rules in the header. `probe` absent ⇒ the process is not consulted. */
export function presenceOf(
  record: SessionRecord, nowMs: number, probe?: PresenceProbe,
): SessionPresence {
  if (record.endedAt) return 'ended';
  if (record.pid && probe) {
    let answer: boolean | ProcessState = true;
    try { answer = probe(record.pid); } catch { answer = true; }
    const state: ProcessState = answer === true ? 'running' : answer === false ? 'gone' : answer;
    if (state === 'gone') return 'ended';
    // A stopped or zombie process is emphatically NOT `live`, and this is the
    // line the Sessions page was missing: a SIGSTOPped orphan satisfied both
    // `kill(0)` and `ps -o comm=`, so it was painted live for three hours
    // while nothing was scheduling it and no console was coming back for it.
    //
    // `unknown` rather than `ended`, deliberately. `ended` would make the
    // session's lock debris, and releasing that lock is exactly what
    // anonymised the live session in the incident — a stopped process still
    // holds its files, its session id and its working tree. `unknown` says
    // what is true: nobody can vouch for it, so lease rules apply.
    if (state === 'stopped' || state === 'zombie') return 'unknown';
  }
  const seen = Date.parse(record.lastSeen);
  if (!Number.isFinite(seen) || nowMs - seen > LIVE_WINDOW_MS) return 'unknown';
  return 'live';
}

export type LockLike = { slug: string; phase: number; owner: string; session?: string; claimedAt?: number };

/** `autopilot/<runId>` — the owner a lane carries in `PE_OWNER`. */
const AUTOPILOT_OWNER_RE = /^autopilot\/([A-Za-z0-9._-]{1,64})$/;

/**
 * Which plan+phase a session is working, from four sources in falling order of
 * authority.
 *
 *   1. STRONG — a lock whose `session=` is this session (newest claim wins).
 *   2. STRONG — an unresolved RUN whose `phases[N].sessionId` is this session.
 *      A run naming its own session is at least as authoritative as a lock
 *      file, and it is the source that was missing: `correlate` reached a plan
 *      ONLY through locks, so releasing a lock anonymised a live session. That
 *      is precisely the incident — the row rendered `plan: null` and linked at
 *      the page it was already on, while the run record three feet away named
 *      the session, the slug and the phase.
 *   3. WEAK — a lock owned by `<user>@<host>` (phase-lock.sh's default owner
 *      for a person) claimed while the session was alive.
 *   4. WEAK — the session's own `PE_OWNER` reading `autopilot/<runId>`. It
 *      names the run but not the phase, so the run's in-flight phase answers;
 *      last because it is the only one of the four that has to guess.
 *
 * Weak answers are for display. Nothing releases a lock on one — that rule is
 * unchanged, and the two new sources sit on either side of it deliberately: a
 * run record is evidence about the session, an owner string is evidence about
 * the process that spawned it.
 */
export function correlate(
  record: SessionRecord,
  locks: readonly LockLike[],
  nowMs: number,
  runs: readonly RunLink[] = [],
): SessionView['plan'] | undefined {
  const strong = locks
    .filter((lock) => lock.session === record.sessionId)
    .sort((a, b) => (b.claimedAt ?? 0) - (a.claimedAt ?? 0))[0];
  if (strong) return { slug: strong.slug, phase: strong.phase, strong: true };

  // The run's own record of which session it gave the phase to.
  const owned = runs.filter((run) => run.sessionId === record.sessionId);
  const byRun = owned.find((run) => run.active) ?? owned[0];
  if (byRun) return { slug: byRun.slug, phase: byRun.phase, strong: true, runId: byRun.runId };

  // Weak answers need a session a person could plausibly have run (REG-6).
  if (!weaklyCorrelatable(record, nowMs)) return undefined;
  if (!record.user || !record.host) return weakByOwner(record, runs);
  const owner = `${record.user}@${record.host}`;
  const from = Date.parse(record.startedAt) - WEAK_CLAIM_SLACK_MS;
  const until = record.endedAt ? Date.parse(record.endedAt) : nowMs;
  const weak = locks
    .filter((lock) => lock.owner === owner && !lock.session)
    .filter((lock) => lock.claimedAt == null || (lock.claimedAt >= from && lock.claimedAt <= until))
    .sort((a, b) => (b.claimedAt ?? 0) - (a.claimedAt ?? 0))[0];
  if (weak) return { slug: weak.slug, phase: weak.phase, strong: false };
  return weakByOwner(record, runs);
}

/**
 * The last fallback: `PE_OWNER` reads `autopilot/<runId>` and that run is one
 * we can still see. In flight first, else the newest phase the run touched —
 * the owner names a run, and a run is not a phase.
 */
function weakByOwner(record: SessionRecord, runs: readonly RunLink[]): SessionView['plan'] | undefined {
  const runId = AUTOPILOT_OWNER_RE.exec(record.owner ?? '')?.[1];
  if (!runId) return undefined;
  const mine = runs
    .filter((run) => run.runId === runId)
    .sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || b.phase - a.phase)[0];
  return mine ? { slug: mine.slug, phase: mine.phase, strong: false, runId: mine.runId } : undefined;
}

/**
 * What a starting session is told about who else is in its repository
 * (REG-3 iv), in one sentence: each live peer with its pid, where it stands
 * relative to the root and what it works when that is known. `null` for
 * nobody. One copy, read by the console's hook route and by the
 * `phase-console sessions ingest --peers-of` verb a console-less hook runs.
 */
export function peersSentence(
  root: string,
  peers: readonly Pick<SessionRecord, 'sessionId' | 'pid' | 'cwd' | 'kind'>[],
  plans: ReadonlyMap<string, { slug: string; phase: number } | undefined> = new Map(),
): string | null {
  if (!peers.length) return null;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const named = peers.slice(0, 5).map((peer) => {
    const plan = plans.get(peer.sessionId);
    const where = peer.cwd === root
      ? 'at the repository root'
      : `in ${peer.cwd.startsWith(prefix) ? peer.cwd.slice(prefix.length) : peer.cwd}`;
    const facts = [
      peer.pid ? `pid ${peer.pid}` : null,
      where,
      plan ? `working ${plan.slug} phase ${plan.phase}` : null,
      peer.kind === 'autopilot' ? 'an autopilot lane' : peer.kind === 'agent' ? 'a console agent' : null,
    ].filter(Boolean);
    return `${peer.sessionId.slice(0, 8)} (${facts.join(', ')})`;
  });
  const count = peers.length === 1 ? 'one other live Claude session' : `${peers.length} other live Claude sessions`;
  return `The session registry shows ${count} in this repository: ${named.join('; ')}${peers.length > 5 ? '; and more' : ''}. `
    + 'Before claiming a phase, check scripts/phase-lock.sh <slug> conflicts <N> — one of them may be about to work it.';
}

/* ------------------------------------------------------------------ *
 * Liveness probe
 * ------------------------------------------------------------------ */

/**
 * Is this pid a live `claude` (or node, for an npm-installed CLI)?
 *
 * A thin re-export now. This used to be the second of two process probes in
 * the tree — the one that checked identity against pid reuse but, like the
 * other, never read the process STATE, so it called a SIGSTOPped child alive.
 * `server/pid.ts` is the single implementation; it keeps the identity check
 * and adds the three answers this one could not give.
 *
 * Kept boolean-shaped for callers that only ask "is anything there". The
 * registry itself uses `processState` directly, because the difference
 * between `running` and `stopped` is the whole point.
 */
export function claudePidAlive(pid: number): boolean {
  return processState(pid, { expect: CLAUDE_COMM }) !== 'gone';
}

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

/** What `onChange` is told happened to a record. */
export type RegistryChange = SessionEventName | 'prune' | 'heartbeat' | 'wait-cleared' | 'wait-unanswered';

/** At most this many distinct unmapped notification types are remembered for the once-per-value warning. */
const UNMAPPED_SEEN_MAX = 64;

export type RegistryOptions = {
  /** `INSTANCE_STATE_DIR/sessions` — records as `<id>.json`, the hook's drops under `inbox/`. */
  dir: string;
  now?: () => Date;
  /** The liveness probe; `null` switches the process check off (tests). */
  pidAlive?: ((pid: number) => boolean) | null;
  /**
   * Every change to a record: an ingested event, a prune, a throttled
   * heartbeat, and a wait cleared by no hook — progress past the ask
   * (`wait-cleared`) or the cap passing (`wait-unanswered`).
   */
  onChange?: (record: SessionRecord, event: RegistryChange, meta?: ChangeMeta) => void;
  /** A problem worth a log line (a corrupt file, a watcher error). */
  onWarn?: (what: string, detail: Record<string, unknown>) => void;
  /** A fact worth a log line that is not a problem — a drain's summary. Falls back to nothing. */
  onInfo?: (what: string, detail: Record<string, unknown>) => void;
  /** Called at the end of every poll — the service re-applies what its construction backlog deferred. */
  onPoll?: () => void;
};

export class SessionRegistry {
  private readonly records = new Map<string, SessionRecord>();
  /** Per session: when a heartbeat last reached the disk. See `HEARTBEAT_PERSIST_MS`. */
  private readonly beatAt = new Map<string, number>();
  /** The unmapped `notification_type` values already warned about — once per value (REG-8). */
  private readonly unmappedSeen = new Set<string>();
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  /** When the armed debounce drains the inbox (epoch ms) — the shutdown inventory's `session-inbox` clock. */
  private debounceAt: number | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  /** The depth watermark was crossed and said; re-armed below half (REG-2 iii). */
  private deepSaid = false;
  /** What the last drain did — the verb prints it. */
  private drained: { applied: number; history: number; refused: number; lateMsMax: number } = {
    applied: 0, history: 0, refused: 0, lateMsMax: 0,
  };
  private closed = false;

  private readonly opts: RegistryOptions;

  constructor(opts: RegistryOptions) { this.opts = opts; }

  get dir(): string { return this.opts.dir; }
  get inboxDir(): string { return join(this.opts.dir, 'inbox'); }

  private now(): Date { return this.opts.now?.() ?? new Date(); }

  /**
   * Read what is on disk: the records, then whatever the hook dropped while
   * the console was away. `via` is who is reading — a console booting
   * (`inbox`), or the `phase-console sessions ingest` verb (`cli`).
   *
   * Under the drain lock (see `lockInbox`): a verb draining the same inbox in
   * the instant this console boots would otherwise write records this read
   * misses. A live holder is waited for, briefly; past that the records are
   * read and the drops left to the next poll — a boot is never blocked on
   * another process, and no drop is applied twice.
   */
  load(opts: { via?: IngestVia } = {}): this {
    try { mkdirSync(this.inboxDir, { recursive: true }); } catch { /* a read-only state dir keeps an in-memory registry */ }
    const lock = this.lockInbox(INBOX_LOCK_WAIT_MS);
    try {
      this.readRecords();
      // Still held after the wait: the records are read, and the drops are
      // left for the next pass rather than applied twice beside the holder.
      if (lock !== 'held') this.ingestInbox({ via: opts.via ?? 'inbox', locked: true });
    } finally {
      this.unlockInbox(lock);
    }
    this.settleWaits();
    this.prune();
    return this;
  }

  private readRecords(): void {
    let names: string[] = [];
    try { names = readdirSync(this.opts.dir); } catch { names = []; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = join(this.opts.dir, name);
      try {
        if (!statSync(file).isFile()) continue;
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SessionRecord>;
        if (typeof parsed.sessionId !== 'string' || !SESSION_ID_RE.test(parsed.sessionId)) throw new Error('not a session record');
        if (typeof parsed.startedAt !== 'string' || typeof parsed.lastSeen !== 'string' || typeof parsed.cwd !== 'string') {
          throw new Error('incomplete record');
        }
        this.records.set(parsed.sessionId, {
          ...parsed,
          sessionId: parsed.sessionId, cwd: parsed.cwd, startedAt: parsed.startedAt, lastSeen: parsed.lastSeen,
          kind: parsed.kind ?? kindOf(parsed.owner), turns: typeof parsed.turns === 'number' ? parsed.turns : 0,
          ...(typeof parsed.streamTurns === 'number' ? { streamTurns: parsed.streamTurns } : {}),
        } as SessionRecord);
      } catch (error) {
        this.opts.onWarn?.('sessions.record-unreadable', { file, error: (error as Error).message });
        try { rmSync(file, { force: true }); } catch { /* best effort */ }
      }
    }
  }

  /** Watch the inbox (the hook's fallback) and poll it slowly in case the watcher is deaf. */
  start(): this {
    if (this.closed) return this;
    this.arm();
    this.pollTimer = setInterval(() => this.poll(), INBOX_POLL_MS);
    this.pollTimer.unref?.();
    return this;
  }

  /**
   * One slow pass — what the 30 s clock runs, public so a caller (and a test)
   * can run it now: drain the inbox, settle waits, prune, then `onPoll`.
   */
  poll(): void {
    if (this.closed) return;
    this.ingestInbox();
    this.settleWaits();
    this.prune();
    try { this.opts.onPoll?.(); } catch (error) {
      this.opts.onWarn?.('sessions.poll-hook-failed', { error: (error as Error).message });
    }
  }

  /** Presence drops waiting in the inbox — the shutdown inventory's depth (REG-2 iv). */
  depth(): number {
    try { return readdirSync(this.inboxDir).filter((name) => name.endsWith('.json')).length; } catch { return 0; }
  }

  /** When the armed debounce will drain the inbox, or null when none is armed. */
  pendingDrainAt(): number | null {
    return this.debounce ? this.debounceAt : null;
  }

  private arm(): void {
    if (this.watcher || this.closed) return;
    try {
      if (!existsSync(this.inboxDir)) mkdirSync(this.inboxDir, { recursive: true });
      this.watcher = watch(this.inboxDir, () => {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounceAt = Date.now() + INBOX_DEBOUNCE_MS;
        this.debounce = setTimeout(() => { this.debounce = null; this.debounceAt = null; this.ingestInbox(); }, INBOX_DEBOUNCE_MS);
        this.debounce.unref?.();
      });
      // The watcher must never be what keeps the process alive: a console
      // shutting down, or a test that built a Service and never closed it.
      this.watcher.unref?.();
      this.watcher.on('error', (error) => {
        this.opts.onWarn?.('sessions.watcher-error', { dir: this.inboxDir, error: (error as Error).message });
        try { this.watcher?.close(); } catch { /* already gone */ }
        this.watcher = null;
        // Re-armed by the poll (which also ingests), so a lost watcher degrades to 30 s latency, never to silence.
      });
    } catch (error) {
      this.opts.onWarn?.('sessions.watch-failed', { dir: this.inboxDir, error: (error as Error).message });
      this.watcher = null;
    }
  }

  close(): void {
    this.closed = true;
    if (this.debounce) { clearTimeout(this.debounce); this.debounce = null; this.debounceAt = null; }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    try { this.watcher?.close(); } catch { /* already gone */ }
    this.watcher = null;
  }

  /**
   * Apply one event (from the route or the inbox), persist, announce.
   *
   * Every event carries its lateness onto the record (`lastEvent`) and into
   * `onChange`: the session's own `at` against this process's clock. One from
   * the inbox or the verb older than `INBOX_HISTORY_HORIZON_MS` is HISTORY —
   * the record learns it, and the meta tells the listener not to treat it as
   * news (REG-2 ii).
   */
  ingest(payload: HookPayload, via: IngestVia = 'post'): SessionRecord {
    const prev = this.records.get(payload.session_id);
    // A notification type this build does not act on changes NO record — not
    // `lastSeen`, not a resurrection, no write, no event — and a type in none
    // of the three maps is new: warned once per value, so a family the CLI
    // adds is visible without being announced (REG-8). Answered with what is
    // known, and never stored.
    if (payload.event === 'Notification' && payload.notification_type && !actsOnNotification(payload.notification_type)) {
      const type = payload.notification_type;
      if (!NOTIFICATION_IGNORED.includes(type) && !this.unmappedSeen.has(type) && this.unmappedSeen.size < UNMAPPED_SEEN_MAX) {
        this.unmappedSeen.add(type);
        this.opts.onWarn?.('sessions.notification-unmapped', { type, sessionId: payload.session_id });
      }
      return prev ?? applyEvent(undefined, { ...payload, notification_type: undefined, message: undefined }, this.now().toISOString());
    }
    const appliedAt = this.now();
    const next = applyEvent(prev, payload, appliedAt.toISOString());
    const at = payload.at && Number.isFinite(Date.parse(payload.at)) ? Date.parse(payload.at) : appliedAt.getTime();
    const lateMs = Math.max(0, appliedAt.getTime() - at);
    const history = via !== 'post' && lateMs > INBOX_HISTORY_HORIZON_MS;
    next.lastEvent = {
      event: payload.event, at: new Date(at).toISOString(), appliedAt: appliedAt.toISOString(), lateMs, via,
      ...(history ? { history: true as const } : {}),
    };
    this.records.set(next.sessionId, next);
    this.persist(next);
    this.opts.onChange?.(next, payload.event, { via, lateMs, history });
    return next;
  }

  /**
   * The runner's own report that a session it spawned is alive and working.
   *
   * The registry's other writer is the hook, and for an autopilot session the
   * hook is not there: the run's `--settings` file carries a `Stop` hook of its
   * own (the nudge at `/hooks/stop`), which displaces the machine-global one at
   * `/hooks/session`, so a lane that took four hundred turns was recorded as
   * having taken none. The runner already reads authoritative per-lane liveness
   * off the stream; this is that fact fed back rather than a second guess at it.
   *
   * `turnEnded` marks a `{kind:'step'}` event — one assistant turn of the
   * PHASE's own conversation, subagents excluded, which is the only event in
   * the stream that means a turn happened. Everything else merely advances
   * `lastSeen`.
   *
   * Update-only, deliberately: an id this registry has never seen is left
   * alone rather than conjured into a record. "Nothing here invents a
   * session" is the module's rule and a heartbeat carries no cwd to invent one
   * with. Returns whether a record was there to advance.
   */
  heartbeat(sessionId: string, opts: { turnEnded?: boolean } = {}): boolean {
    const record = this.records.get(sessionId);
    if (!record) return false;
    const now = this.now();
    const nowMs = now.getTime();
    // A heartbeat is evidence of life, so it undoes a death only the ABSENCE
    // of evidence had concluded — `process-gone`, written by the probe. A hook
    // that said SessionEnd said it on better authority than a stream event
    // that may be arriving late, and is left standing.
    if (record.endedAt && (record.endedBy === 'probe' || record.reason === 'process-gone')) {
      revive(record);
    }
    if (record.endedAt) return false;
    const iso = now.toISOString();
    if (Date.parse(iso) > Date.parse(record.lastSeen)) record.lastSeen = iso;
    if (opts.turnEnded) record.streamTurns = (record.streamTurns ?? 0) + 1;
    // The session is producing again after its latest ask, so the ask was
    // answered (REG-4) — the clearing rule that needs no hook the CLI does not
    // send. Written at once, whatever the throttle says: a wait that ended is
    // a transition, not a heartbeat.
    if (record.waiting && nowMs > Date.parse(record.waiting.at ?? record.waiting.since)) {
      closeWait(record, iso, 'answered');
      this.beatAt.set(sessionId, nowMs);
      this.persist(record);
      this.opts.onChange?.(record, 'wait-cleared');
      return true;
    }

    const last = this.beatAt.get(sessionId);
    if (last != null && nowMs - last < HEARTBEAT_PERSIST_MS) return true;
    this.beatAt.set(sessionId, nowMs);
    this.persist(record);
    this.opts.onChange?.(record, 'heartbeat');
    return true;
  }

  /**
   * Drain the inbox: every drop, oldest first (by its own `at`, then the event
   * order start < stop < end, then the name), applied and deleted. A drop that
   * is not a payload is deleted too — junk in the inbox is nobody's.
   *
   * Orphans too (REG-7): the hook writes `<name>.json.tmp.<pid>` and renames it,
   * so a hook killed between the write and the rename leaves a COMPLETE payload
   * matching no glob, deleted by no sweep, reported by no warning — two sessions
   * the console never knew existed were found that way. A tmp whose pid is gone
   * is reclaimed: parsed and applied like any drop, else deleted; either way
   * warned `sessions.inbox-orphan`. A tmp whose pid is live is a hook mid-write
   * and is left alone.
   *
   * And bounded in time and depth (REG-2): a drop older than
   * `INBOX_AGE_REFUSE_MS` is refused (removed, `sessions.inbox-refused`); an
   * inbox `INBOX_DEPTH_WATERMARK` deep is announced once (`sessions.inbox-deep`);
   * every applied event carries its lateness, and one past
   * `INBOX_HISTORY_HORIZON_MS` applies as history. One drain at a time across
   * processes — the console's and the verb's — under the drain lock; a drain
   * that finds another process holding it leaves the drops for its next pass.
   */
  ingestInbox(opts: { via?: IngestVia; locked?: boolean } = {}): number {
    const via = opts.via ?? 'inbox';
    if (via !== 'cli' && !this.watcher && !this.closed) this.arm();
    const lock = opts.locked ? 'caller' : this.lockInbox(0);
    if (lock === 'held') return 0;
    try {
      return this.drainInbox(via);
    } finally {
      if (lock === 'taken') this.unlockInbox(lock);
    }
  }

  private drainInbox(via: IngestVia): number {
    let names: string[] = [];
    try { names = readdirSync(this.inboxDir); } catch { return 0; }
    const drops: { file: string; payload: HookPayload; at: number; rank: number }[] = [];
    for (const orphan of names.filter((n) => /\.json\.tmp\.\d+$/.test(n))) {
      const pid = Number(/\.tmp\.(\d+)$/.exec(orphan)![1]);
      if (this.pidLive(pid)) continue;
      const file = join(this.inboxDir, orphan);
      let payload: HookPayload | null = null;
      try { payload = parseHookPayload(JSON.parse(readFileSync(file, 'utf8'))); } catch { payload = null; }
      if (payload) {
        // Its proper name, so the ordinary sorted apply below takes it and the
        // tie-break reads the same as a drop the hook finished.
        const target = file.replace(/\.tmp\.\d+$/, '');
        try { renameSync(file, target); } catch { try { rmSync(file, { force: true }); } catch { /* best effort */ } }
        this.opts.onWarn?.('sessions.inbox-orphan', { name: orphan, pid, applied: true, event: payload.event, sessionId: payload.session_id });
      } else {
        try { rmSync(file, { force: true }); } catch { /* best effort */ }
        this.opts.onWarn?.('sessions.inbox-orphan', { name: orphan, pid, applied: false });
      }
    }
    try { names = readdirSync(this.inboxDir).filter((n) => n.endsWith('.json')); } catch { return 0; }
    const nowMs = this.now().getTime();
    let refused = 0;
    let oldest: number | null = null;
    for (const name of names) {
      const file = join(this.inboxDir, name);
      let payload: HookPayload | null = null;
      try { payload = parseHookPayload(JSON.parse(readFileSync(file, 'utf8'))); } catch { payload = null; }
      if (!payload) {
        this.opts.onWarn?.('sessions.inbox-junk', { file });
        try { rmSync(file, { force: true }); } catch { /* best effort */ }
        continue;
      }
      const at = payload.at ? Date.parse(payload.at) : Number.MAX_SAFE_INTEGER;
      if (Number.isFinite(at) && at !== Number.MAX_SAFE_INTEGER) {
        if (nowMs - at > INBOX_AGE_REFUSE_MS) {
          refused++;
          this.opts.onWarn?.('sessions.inbox-refused', {
            file, sessionId: payload.session_id, event: payload.event, at: payload.at, ageMs: nowMs - at, via,
          });
          try { rmSync(file, { force: true }); } catch { /* best effort */ }
          continue;
        }
        oldest = oldest == null ? at : Math.min(oldest, at);
      }
      drops.push({ file, payload, at, rank: EVENT_RANK[payload.event] ?? 9 });
    }
    // The depth watermark, said once per crossing and re-armed under half.
    if (drops.length >= INBOX_DEPTH_WATERMARK && !this.deepSaid) {
      this.deepSaid = true;
      this.opts.onWarn?.('sessions.inbox-deep', {
        depth: drops.length, watermark: INBOX_DEPTH_WATERMARK, oldestAt: oldest != null ? new Date(oldest).toISOString() : null, via,
      });
    } else if (drops.length < INBOX_DEPTH_WATERMARK / 2) {
      this.deepSaid = false;
    }
    drops.sort((a, b) => a.at - b.at || a.rank - b.rank || a.file.localeCompare(b.file));
    let n = 0;
    let history = 0;
    let lateMsMax = 0;
    for (const drop of drops) {
      try {
        const record = this.ingest(drop.payload, via);
        n++;
        const late = record.lastEvent?.lateMs ?? 0;
        if (record.lastEvent?.history) history++;
        if (late > lateMsMax) lateMsMax = late;
      } catch (error) {
        this.opts.onWarn?.('sessions.inbox-apply-failed', { file: drop.file, error: (error as Error).message });
      }
      try { rmSync(drop.file, { force: true }); } catch { /* best effort */ }
    }
    this.drained = { applied: n, history, refused, lateMsMax };
    if (n || refused) {
      this.opts.onInfo?.('sessions.inbox-drained', { via, applied: n, history, refused, lateMsMax });
    }
    return n;
  }

  /** What the most recent drain applied, applied as history, and refused. */
  lastDrain(): { applied: number; history: number; refused: number; lateMsMax: number } {
    return { ...this.drained };
  }

  /* ---------------- the drain lock ---------------- */

  private get lockFile(): string { return join(this.opts.dir, 'inbox.lock'); }

  /**
   * Take the drain lock — `O_EXCL`, holding `<pid> <epoch ms>` — waiting up to
   * `waitMs` for a live holder. `taken`: ours, release it; `held`: another
   * process is draining right now; `unavailable`: the lock cannot be made (a
   * read-only state directory), so the caller proceeds as it always did. A lock
   * whose holder is gone, or older than a minute, is reclaimed.
   */
  private lockInbox(waitMs: number): 'taken' | 'held' | 'unavailable' {
    const deadline = Date.now() + waitMs;
    for (let attempt = 0; attempt < 1_000; attempt++) {
      try {
        mkdirSync(this.opts.dir, { recursive: true });
        const fd = openSync(this.lockFile, 'wx', 0o600);
        try { writeSync(fd, `${process.pid} ${Date.now()}\n`); } finally { closeSync(fd); }
        return 'taken';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return 'unavailable';
      }
      if (this.lockStale()) {
        try { rmSync(this.lockFile, { force: true }); } catch { return 'unavailable'; }
        continue;
      }
      const left = deadline - Date.now();
      if (left <= 0) return 'held';
      sleepSync(Math.min(25, left));
    }
    return 'held';
  }

  private lockStale(): boolean {
    let text = '';
    let mtime = 0;
    try {
      text = readFileSync(this.lockFile, 'utf8');
      mtime = statSync(this.lockFile).mtimeMs;
    } catch { return false; }
    const [pidText, atText] = text.trim().split(/\s+/);
    const pid = Number(pidText);
    const at = Number(atText) || mtime;
    if (Date.now() - at > INBOX_LOCK_STALE_MS) return true;
    if (!Number.isInteger(pid) || pid <= 0) return Date.now() - mtime > INBOX_LOCK_STALE_MS;
    if (pid === process.pid) return false;
    if (this.opts.pidAlive) return !this.opts.pidAlive(pid);
    return processState(pid) === 'gone';
  }

  private unlockInbox(lock: 'taken' | 'held' | 'unavailable' | 'caller'): void {
    if (lock !== 'taken') return;
    try {
      const [pidText] = readFileSync(this.lockFile, 'utf8').trim().split(/\s+/);
      if (Number(pidText) === process.pid) rmSync(this.lockFile, { force: true });
    } catch { /* already gone */ }
  }

  /** Is the process that owns an inbox tmp still alive? The registry's one probe, else `pid.ts`'s. */
  private pidLive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    if (this.opts.pidAlive === null) return false;
    if (this.opts.pidAlive) return this.opts.pidAlive(pid);
    return processState(pid) !== 'gone';
  }

  /**
   * The clearing rules that need no hook (REG-4), run at load and on the poll:
   * a session whose transcript was written after its latest ask has moved on
   * (`answered`), and a wait older than `WAIT_ANSWER_CAP_MS` is closed as
   * `unanswered` — told once through `onChange('wait-unanswered')`. A prompt
   * still genuinely up re-notifies, and that is a new episode. Returns how many
   * waits it closed.
   */
  settleWaits(): number {
    const nowMs = this.now().getTime();
    const iso = new Date(nowMs).toISOString();
    let n = 0;
    for (const record of this.records.values()) {
      const waiting = record.waiting;
      if (!waiting || record.endedAt) continue;
      const askedMs = Date.parse(waiting.at ?? waiting.since);
      let written = 0;
      if (record.transcript) {
        try { written = statSync(record.transcript).mtimeMs; } catch { written = 0; }
      }
      if (written > askedMs + TRANSCRIPT_GRACE_MS) {
        closeWait(record, iso, 'answered');
        this.persist(record);
        this.opts.onChange?.(record, 'wait-cleared');
        n++;
        continue;
      }
      if (nowMs - Date.parse(waiting.since) > WAIT_ANSWER_CAP_MS) {
        closeWait(record, iso, 'unanswered');
        this.persist(record);
        this.opts.onChange?.(record, 'wait-unanswered');
        n++;
      }
    }
    return n;
  }

  /** Forget ended records past their keep, and silent ones nobody has reported for a week. */
  prune(): number {
    const nowMs = this.now().getTime();
    let n = 0;
    for (const record of [...this.records.values()]) {
      const endedAgo = record.endedAt ? nowMs - Date.parse(record.endedAt) : null;
      const silentFor = nowMs - Date.parse(record.lastSeen);
      if ((endedAgo != null && endedAgo > RETAIN_ENDED_MS) || silentFor > RETAIN_SILENT_MS) {
        this.records.delete(record.sessionId);
        this.beatAt.delete(record.sessionId);
        try { rmSync(join(this.opts.dir, `${record.sessionId}.json`), { force: true }); } catch { /* best effort */ }
        this.opts.onChange?.(record, 'prune');
        n++;
      }
    }
    return n;
  }

  get(sessionId: string): SessionRecord | undefined { return this.records.get(sessionId); }

  /** Live first, then by most recently seen. */
  list(): SessionRecord[] {
    const nowMs = this.now().getTime();
    return [...this.records.values()].sort((a, b) => {
      const la = this.presenceOfRecord(a, nowMs) === 'live' ? 0 : 1;
      const lb = this.presenceOfRecord(b, nowMs) === 'live' ? 0 : 1;
      return la - lb || Date.parse(b.lastSeen) - Date.parse(a.lastSeen);
    });
  }

  /**
   * The sessions IN a repository right now (REG-3): records whose resolved
   * `root` is this one (or, for a record the hook could not resolve, whose cwd
   * is inside it), whose presence is `live` — or `unknown` with a process
   * behind it (a stopped one still holds its tree; a record with no pid past
   * the live window is no evidence of anybody). Probes and the named session
   * are left out. The caller decides what counts as a peer of what.
   */
  inRoot(root: string, opts: { excluding?: readonly (string | undefined)[] } = {}): Array<SessionRecord & { presence: 'live' | 'unknown' }> {
    const nowMs = this.now().getTime();
    const excluded = new Set((opts.excluding ?? []).filter(Boolean));
    const prefix = root.endsWith('/') ? root : `${root}/`;
    const out: Array<SessionRecord & { presence: 'live' | 'unknown' }> = [];
    for (const record of this.records.values()) {
      if (record.probe || excluded.has(record.sessionId)) continue;
      const inside = record.root
        ? record.root === root
        : record.cwd === root || record.cwd.startsWith(prefix);
      if (!inside) continue;
      const presence = this.presenceOfRecord(record, nowMs);
      if (presence === 'ended') continue;
      if (presence === 'unknown' && !record.pid) continue;
      out.push({ ...record, presence });
    }
    return out;
  }

  presence(sessionId: string): SessionPresence {
    const record = this.records.get(sessionId);
    return record ? this.presenceOfRecord(record, this.now().getTime()) : 'unknown';
  }

  /**
   * `presence`, with the pid it probed when the record carries one — what a
   * refused resume names, so an operator can see WHICH process held it (REG-1).
   */
  presenceDetail(sessionId: string): { presence: SessionPresence; pid?: number } {
    const record = this.records.get(sessionId);
    if (!record) return { presence: 'unknown' };
    return { presence: this.presenceOfRecord(record, this.now().getTime()), ...(record.pid ? { pid: record.pid } : {}) };
  }

  /** The scheduler's question: the presence of the session a lock names; `unknown` for a lock that names none. */
  presenceOfLock(lock: { session?: string }): SessionPresence {
    return lock.session ? this.presence(lock.session) : 'unknown';
  }

  /**
   * The API's answer: every record with its presence, the turns whichever
   * writer counted, and the plan+phase it works — from the locks AND from the
   * unresolved runs, so a session whose lock was released is still named.
   */
  views(locks: readonly LockLike[] = [], runs: readonly RunLink[] = [], opts: { probes?: boolean } = {}): SessionView[] {
    const nowMs = this.now().getTime();
    // The console's own probes are kept as records and left out of the list
    // an operator reads (SLF-2 iv): "who is working on this machine" was four
    // fifths the console talking to itself. `probes: true` shows them.
    return this.list().filter((record) => opts.probes || !record.probe).map((record) => {
      const plan = correlate(record, locks, nowMs, runs);
      return {
        ...record,
        turns: turnsOf(record),
        turnsSource: turnsSourceOf(record),
        presence: this.presenceOfRecord(record, nowMs),
        ...(plan ? { plan } : {}),
      };
    });
  }

  private presenceOfRecord(record: SessionRecord, nowMs: number): SessionPresence {
    // The default probe is the four-valued one, NOT `claudePidAlive`: a
    // boolean cannot express `stopped`, and `stopped` is the answer that keeps
    // an orphan off the live list. An injected seam (tests) may still be
    // boolean — `presenceOf` accepts both.
    //
    // And NO `expect`. `pid.ts` states the rule in its own words: `expect` may
    // produce a false `gone` for a process whose `comm` is a long path
    // truncated to MAXCOMLEN (16) by a multi-column `ps`, "which is why no
    // caller deciding whether to RECLAIM something passes it". This probe is
    // exactly such a caller, by two paths: `presenceOf` maps `gone` to
    // `ended`, `ended` is the one answer that makes a foreign lock debris
    // (`lockLapsed`), and both the scheduler and boarding's belt-check then
    // shell `phase-lock.sh release --owner <holder>` and board anyway. So a
    // person running an npm-installed `claude` from a long nvm prefix — whose
    // `comm` truncates to `/home/dev/.nvm/v` and matches none of
    // /claude|node|bun/ — had their live session declared ended and their
    // phase lock force-released under them, which is precisely the
    // two-sessions-one-tree case the lock exists to prevent.
    //
    // Dropping it trades that for pid reuse: a recycled pid now reads
    // `running`, so a dead session's lock is held until its lease expires
    // rather than released early. That is the safe direction and `pid.ts`
    // says so — a recycled pid called `running` "merely leaves a run parked
    // until a person looks", where a false `gone` starts a second session
    // beside a live one. Identity belongs in a `(pid, procStartedAt)` tuple
    // the way `state.ts` carries it for children; the registry has no process
    // start time to compare against yet (`SessionRecord.startedAt` is the
    // SESSION's clock, not the process's, and using it here would repeat the
    // bug orphans-P3 fixed).
    const probe: PresenceProbe | undefined = this.opts.pidAlive === null
      ? undefined
      : (this.opts.pidAlive ?? ((pid: number) => processState(pid)));
    const presence = presenceOf(record, nowMs, probe);
    // A death the PROBE found is a death, and it is written down.
    //
    // `presenceOf` answered `ended` for a gone process and nothing recorded it,
    // so `endedAt` stayed unset and `prune()` had no ended-time to measure:
    // the record fell through to the seven-day silence rule instead of the
    // 24-hour ended rule, and a session that finished this morning was still
    // on the page a week later. Guarded on `!record.endedAt`, so this fires at
    // most once per record — every later read short-circuits on the first line
    // of `presenceOf`.
    if (presence === 'ended' && !record.endedAt) {
      // INFERRED, and written as an inference (REG-9): the process is gone, so
      // the session ended somewhere after the last evidence of life — `endedAt`
      // is that evidence (`lastSeen`), `endedDetectedAt` the moment the probe
      // noticed, `endedBy` who concluded it. Stamping `now` claimed life the
      // session never had: 17.3 hours of it on one measured record.
      const detectedAt = new Date(nowMs).toISOString();
      record.endedAt = Number.isFinite(Date.parse(record.lastSeen)) ? record.lastSeen : detectedAt;
      record.endedDetectedAt = detectedAt;
      record.endedBy = 'probe';
      record.reason ??= 'process-gone';
      // A session whose process is gone is waiting on nobody (REG-4): the
      // episode ends with it, rather than standing as a badge on a dead record.
      closeWait(record, detectedAt, 'ended');
      this.persist(record);
      // The same event the hook would have raised had it been there to raise
      // it — because this is exactly the case where it was not.
      this.opts.onChange?.(record, 'SessionEnd');
    }
    return presence;
  }

  private persist(record: SessionRecord): void {
    const file = join(this.opts.dir, `${record.sessionId}.json`);
    try {
      mkdirSync(this.opts.dir, { recursive: true });
      const tmp = `${file}.tmp.${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, file);
    } catch (error) {
      this.opts.onWarn?.('sessions.persist-failed', { file, error: (error as Error).message });
    }
  }
}
