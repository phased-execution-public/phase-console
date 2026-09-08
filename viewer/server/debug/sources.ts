/**
 * The unified log index — every place this console writes down what happened,
 * behind one query.
 *
 * The console already recorded almost everything. What it never had was a way
 * to READ any of it without a terminal: the NDJSON console log had no endpoint
 * at all (`log.recent()` was exported for exactly this and called by nobody in
 * production), the launchd/systemd `console.out.log`/`console.err.log` pair had
 * no programmatic access whatsoever, and the per-run files were reachable one
 * endpoint at a time with no way to ask "what happened at 14:02" across them.
 *
 * So this module does one thing: it normalises seven differently-shaped sources
 * — four distinct NDJSON dialects among them, whose timestamp field is `time`
 * in two and `at` in two more — into ONE row type, and lets a caller filter
 * across them on time, level, plan, phase and text. It reads; it never writes,
 * never mutates, and never holds a handle open.
 *
 * **It does not re-implement a reader that exists.** Journals come from
 * `Journal.read()`, rulings from `readRulings()`, outcomes from `readOutcome()`
 * — each already bounded, already tolerant of a torn last line, and each the
 * owner of its own shape. The one bounded reader added here is `tailLines`,
 * because `log.ts` has none and its file has been observed at half a gigabyte
 * (the comment in `log.ts` says so).
 *
 * **Redacted on the way out, deliberately.** Every free-text field passes
 * through `redact()` from `webhooks.ts`, then through `maskHome`. This costs
 * the reader almost nothing — the generic rule masks 40-plus characters of
 * mixed-case-with-digits, which a commit sha, a run id, a slug and an ISO
 * timestamp all are not — and it buys the one thing that matters: the console
 * is reachable from a phone over a tailnet (`--remote`), and a log line is the
 * single most likely place for a token to have been echoed by a command. One
 * rule for the index and the bundle both, so there is no export path where a
 * secret survives. The L3 raw slot renders the redacted record and says so.
 */

import { existsSync, openSync, readSync, closeSync, fstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { recent as recentLogEntries, logFilePath, type Entry as LogEntry } from '../log.ts';
import { STATE_DIR } from '../config.ts';
import { redact } from '../webhooks.ts';
import { runDir } from '../runner/state.ts';
import { Journal, type JournalEntry } from '../runner/journal.ts';
import { readRulings, rulingsFile, type Ruling } from '../runner/rulings.ts';
import { outcomeInboxDir, inboxOutcomePhase, readOutcome } from '../runner/outcome.ts';
import type { NotificationRecord } from '../notifications.ts';

/* ------------------------------------------------------------------ *
 * The vocabulary
 * ------------------------------------------------------------------ */

/**
 * Where a row came from. This list IS the contract: `docs/debugging.md` names
 * every one of these and `debug-index.test.ts` holds the two together, so a
 * source added here without a paragraph there goes red.
 */
export const DEBUG_SOURCES = [
  'console',
  'supervisor',
  'journal',
  'outcome',
  'ruling',
  'delivery',
  'health',
] as const;

export type DebugSource = (typeof DEBUG_SOURCES)[number];

export function isDebugSource(v: unknown): v is DebugSource {
  return typeof v === 'string' && (DEBUG_SOURCES as readonly string[]).includes(v);
}

/** Three levels, the same three `log.ts` writes. Everything maps onto them. */
export const DEBUG_LEVELS = ['info', 'warn', 'error'] as const;
export type DebugLevel = (typeof DEBUG_LEVELS)[number];

export function isDebugLevel(v: unknown): v is DebugLevel {
  return typeof v === 'string' && (DEBUG_LEVELS as readonly string[]).includes(v);
}

/**
 * One row, whatever it came from.
 *
 * `event` is the machine word (a journal event kind, a log event, a delivery
 * outcome, an env-issue kind); `text` is the one line a person reads. Both are
 * always present — a row that can only be read by a machine is not a log, and
 * a row that can only be read by a person cannot be filtered.
 */
export type DebugEntry = {
  source: DebugSource;
  /** ISO 8601, or `''` when the source carried no usable time. */
  at: string;
  level: DebugLevel;
  event: string;
  text: string;
  slug?: string;
  runId?: string;
  phase?: number;
  /** The source record, redacted. The L3 raw slot renders this verbatim. */
  data?: Record<string, unknown>;
};

export type DebugQuery = {
  sources?: readonly DebugSource[];
  levels?: readonly DebugLevel[];
  /** ISO or ms-epoch; inclusive. */
  since?: string;
  /** ISO or ms-epoch; inclusive. */
  until?: string;
  /** Case-insensitive substring over `event`, `text`, `slug` and `runId`. */
  q?: string;
  slug?: string;
  phase?: number;
  runId?: string;
  limit?: number;
};

export type DebugSourceStatus = {
  source: DebugSource;
  available: boolean;
  /** Where it lives, when it is a file. Home-masked, never a person's path. */
  path?: string;
  /** How many rows this source contributed to THIS answer, before the cap. */
  count: number;
  /** Present when `available` is false: the reason, in one sentence. */
  note?: string;
};

export type DebugIndex = {
  entries: DebugEntry[];
  /** Per-source availability + why, so the UI can say "no supervisor log here". */
  sources: DebugSourceStatus[];
  /** True when the limit cut the answer — the UI says so rather than implying "all". */
  truncated: boolean;
};

/** What a gatherer hands `mergeIndex` for one source. */
export type DebugBucket = {
  entries: DebugEntry[];
  available: boolean;
  path?: string;
  note?: string;
};

/* ------------------------------------------------------------------ *
 * Bounds
 * ------------------------------------------------------------------ */

/** How much of a file's tail is ever read. 512 KB is ~4000 NDJSON lines. */
export const TAIL_BYTES = 512 * 1024;
/** Rows one source may contribute before it is cut. */
export const PER_SOURCE_CAP = 2000;
/** Rows the merged answer carries when the caller names no limit. */
export const DEFAULT_LIMIT = 500;
/** The ceiling a caller's `limit` is clamped to. */
export const MAX_LIMIT = 5000;

/* ------------------------------------------------------------------ *
 * Reading a file's tail without reading the file
 * ------------------------------------------------------------------ */

/**
 * How much of a single over-long line is kept when one line is bigger than the
 * whole window. Enough to read a stack frame and a message; not a second file.
 */
export const LONG_LINE_KEEP = 4000;

/**
 * The last `bytes` of a file, as non-empty lines.
 *
 * `readSync` at an offset rather than `readFileSync`: this is pointed at a log
 * that has been observed at half a gigabyte, and not materialising it is the
 * whole point. Every failure is an empty result — a log explorer that throws
 * because one of its seven sources is unreadable is worse than one that says
 * that source is empty.
 *
 * Two boundary rules, both of which this reader got wrong at first and both of
 * which cost a real answer:
 *
 *  - **The first line is dropped only when it really is a fragment.** The
 *    window is a fragment iff the byte BEFORE it is not a newline. Shifting
 *    unconditionally lost one genuine line every time the boundary happened to
 *    land on `\n` (measured: 185 rows reported for 186).
 *  - **A window with no complete line in it is one very long line, not an
 *    empty file.** A crashing process printing an unbroken 600 KB blob is
 *    exactly how the supervisor log fills, and reporting that as zero rows is
 *    the sentence this module's own header says must never be said —
 *    "the supervisor log is empty" — about the one source that exists to
 *    explain a crash. The tail is returned with a leading `…`, marked rather
 *    than hidden. (`runner/journal.ts` solves the same problem by widening its
 *    read; a log with no line structure has nothing to widen TO.)
 */
export function tailLines(path: string, bytes = TAIL_BYTES): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size === 0) return [];
    const want = Math.min(size, bytes);
    const start = size - want;
    const buf = Buffer.allocUnsafe(want);
    let filled = 0;
    while (filled < want) {
      const n = readSync(fd, buf, filled, want - filled, start + filled);
      if (n <= 0) break;
      filled += n;
    }
    const text = buf.subarray(0, filled).toString('utf8');
    const lines = text.split('\n');
    if (start > 0 && !endsWithNewline(fd, start - 1)) lines.shift();
    const kept = lines.filter((line) => line.trim() !== '');
    if (kept.length === 0 && text.trim() !== '') {
      return [`…${text.slice(-LONG_LINE_KEEP).trim()}`];
    }
    return kept;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/** Is the byte at `offset` a newline? Unreadable reads as "no", which shifts. */
function endsWithNewline(fd: number, offset: number): boolean {
  try {
    const one = Buffer.allocUnsafe(1);
    return readSync(fd, one, 0, 1, offset) === 1 && one[0] === 0x0a;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Redaction + shaping
 * ------------------------------------------------------------------ */

/**
 * Mask an operator's home directory.
 *
 * `redact()` catches secret SHAPES; a home path is not one, and it is the other
 * thing that must not travel — it names a person. Both the index and the bundle
 * apply it, so `/home/ada/work/x` reads `~/work/x` everywhere — and the
 * macOS `Users` prefix likewise, which this comment names rather than
 * spells because `.github/scripts/scrub.sh` refuses the literal string in
 * any committed file, comments included.
 *
 * The macOS and Linux prefixes are masked whether or not they are THIS home: a
 * journal written on one machine and read on another still names somebody, and
 * the bundle is meant to be pasted into a model's context by definition.
 */
export function maskHome(text: string): string {
  const home = process.env.HOME || '';
  let out = String(text ?? '');
  if (home) out = out.split(home).join('~');
  // A space is allowed ONLY where the path continues.
  //
  // Three attempts, and the middle one is the lesson. `[A-Za-z0-9._-]+` masked
  // `John Smith` as far as the space and left `~ Smith/work/secret-project` —
  // a leak that LOOKS masked, which is worse than one that does not. Allowing
  // any space instead ran to the end of the line: `worktree at ~/ada was
  // reused by run aaaa1111 at 2026-…` collapsed to `worktree at ~`, and it ate
  // into `redact()`'s own `[redacted]` marker on the way.
  //
  // So: consume non-space path characters freely, and consume a space only
  // when the run after it reaches a `/` before the next space — which is what
  // `Smith/work` does and what `was reused by` does not. Over-masking is the
  // safe direction for a redactor, but not at the price of the sentence around
  // the path.
  out = out.replace(/\/(?:Users|home)\/(?:[^/\s"'\n]|[ ](?=[^\s/]*\/))+/g, '~');
  // The percent-encoded form, which arrives from a URL in a journal payload.
  // Tempered on `%2F` so it stops at the encoded separator exactly where the
  // plain pattern above stops at `/` — otherwise it swallows the rest of the
  // path and the two forms mask differently. Either separator may be encoded
  // independently: a query string that encoded only the second one produced
  // `/Users%2Fada`, which matched neither branch when they were strict.
  // And the same space rule as the plain branch (round 3): a space is part
  // of the component only when the run after it reaches the next separator
  // before the next space — `John Smith%2Fwork` yes, `ada was reused` no.
  // Without it `%2FUsers%2FJohn Smith%2Fwork` masked to `~ Smith%2Fwork`,
  // which is the leak direction.
  const SEP = '(?:/|%2F)';
  const CHAR = `(?!${SEP})[^\\s"'&]`;
  return out.replace(
    new RegExp(`${SEP}(?:Users|home)${SEP}(?:${CHAR}|[ ](?=(?:${CHAR})*${SEP}))+`, 'gi'),
    '~',
  );
}

/** Both passes, in the order that matters: secrets first, then the home path. */
export function scrubText(text: unknown): string {
  return maskHome(redact(String(text ?? '')));
}

/**
 * The same two passes over an arbitrary JSON value, structure preserved.
 *
 * Keys are scrubbed as well as values: a home path in a key is not unusual —
 * a per-repo map is keyed by path. Depth and breadth are bounded because this
 * runs over records this module did not author: a journal line's `data` is
 * whatever the emitting site put there.
 */
/** Keys or elements kept at one level before the rest is marked and dropped. */
export const BREADTH = 200;

export function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const kept: unknown[] = value.slice(0, BREADTH).map((v) => scrubValue(v, depth + 1));
    // Marked, like the depth cut. The L3 slot is documented as "the source
    // record, redacted", and silently dropping the tail makes it "the source
    // record, redacted and shortened" without saying so.
    if (value.length > BREADTH) kept.push(`[…${value.length - BREADTH} more]`);
    return kept;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries.slice(0, BREADTH)) out[scrubText(k)] = scrubValue(v, depth + 1);
    if (entries.length > BREADTH) out['[…]'] = `${entries.length - BREADTH} more keys`;
    return out;
  }
  return scrubText(String(value));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  const scrubbed = scrubValue(value);
  if (!scrubbed || typeof scrubbed !== 'object' || Array.isArray(scrubbed)) return undefined;
  const record = scrubbed as Record<string, unknown>;
  return Object.keys(record).length ? record : undefined;
}

/** A path with the home directory masked, for display. */
export function displayPath(path: string): string {
  return maskHome(path);
}

/**
 * A time that sorts.
 *
 * Returns `''` rather than a guess when there is nothing usable: an invented
 * timestamp on a row whose source did not carry one is the log lying, and a
 * blank sorts to the END where a reader can see it is unplaced.
 */
export function isoOf(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value !== 'string' || !value.trim()) return '';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

/** One line of prose from a record that carries no message field of its own. */
function summarise(fallback: string, data: Record<string, unknown> | undefined): string {
  if (!data) return fallback;
  for (const key of ['message', 'reason', 'detail', 'text', 'error', 'note', 'what', 'summary']) {
    const v = data[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined || typeof v === 'object') continue;
    parts.push(`${k}=${String(v)}`);
    if (parts.length >= 4) break;
  }
  return parts.length ? parts.join(' ') : fallback;
}

/* ------------------------------------------------------------------ *
 * console.log — the ring AND the file
 * ------------------------------------------------------------------ */

function fromLogEntry(entry: LogEntry): DebugEntry {
  const data = asRecord(entry.data);
  const slug = (entry.data as Record<string, unknown> | undefined)?.slug;
  return {
    source: 'console',
    at: isoOf(entry.time),
    level: isDebugLevel(entry.level) ? entry.level : 'info',
    event: scrubText(entry.event),
    text: scrubText(summarise(entry.event, data)),
    ...(typeof slug === 'string' && slug ? { slug: scrubText(slug) } : {}),
    ...(data ? { data } : {}),
  };
}

/**
 * The console's own NDJSON log: the file first, then the in-memory ring.
 *
 * Both, because neither is complete. The ring is the newest 200 entries of THIS
 * process and is authoritative for them — the file lags it by a rotation and by
 * any write that failed. The file is the only thing that survives a restart, and
 * a restarted console has an empty ring while the file still holds the history
 * that explains why it restarted. De-duplicating on time+event+text is what
 * lets the newest lines appear immediately after a rotation, which is exactly
 * when somebody is looking.
 */
export function readConsoleLog(): { entries: DebugEntry[]; path: string | null } {
  const seen = new Set<string>();
  const entries: DebugEntry[] = [];
  const push = (entry: DebugEntry) => {
    const key = `${entry.at}|${entry.event}|${entry.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  };

  const path = logFilePath();
  if (path && existsSync(path)) {
    for (const line of tailLines(path)) {
      try {
        const parsed = JSON.parse(line) as LogEntry;
        if (parsed && typeof parsed === 'object' && typeof parsed.event === 'string') push(fromLogEntry(parsed));
      } catch { /* a torn last line during a write; the ring probably has it */ }
    }
  }
  for (const entry of recentLogEntries(PER_SOURCE_CAP)) push(fromLogEntry(entry));

  return { entries: entries.slice(-PER_SOURCE_CAP), path };
}

/* ------------------------------------------------------------------ *
 * The supervisor's raw stdout/stderr
 * ------------------------------------------------------------------ */

/** `<state>/console.out.log` and its `.err` sibling, where a supervisor puts them. */
export function supervisorLogPaths(): { out: string; err: string } {
  return { out: join(STATE_DIR, 'console.out.log'), err: join(STATE_DIR, 'console.err.log') };
}

/**
 * The supervisor pair — plain text, not NDJSON.
 *
 * launchd and systemd append the process's raw streams here; nothing structured
 * them, so a line becomes a row with the stream as its level and the whole line
 * as its text. This is where a crash BEFORE the logger opened its file ends up,
 * which is precisely the failure the NDJSON log cannot record — and it is why
 * the pair is worth indexing even though every line is unstructured.
 */
export function readSupervisorLogs(): { entries: DebugEntry[]; paths: string[]; found: boolean } {
  const { out, err } = supervisorLogPaths();
  const entries: DebugEntry[] = [];
  const paths: string[] = [];
  let found = false;
  const half = Math.floor(PER_SOURCE_CAP / 2);

  for (const [path, level] of [[out, 'info'], [err, 'error']] as const) {
    if (!existsSync(path)) continue;
    found = true;
    paths.push(path);
    let mtime = '';
    try { mtime = new Date(statSync(path).mtimeMs).toISOString(); } catch { /* unreadable stat */ }
    for (const line of tailLines(path).slice(-half)) {
      // A raw stream carries no per-line time. A leading ISO stamp is common
      // enough to be worth reading; everything else takes the file's mtime,
      // which places the block correctly without claiming per-line precision.
      const stamped = isoOf(/^\[?(\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?)/.exec(line)?.[1] ?? '');
      entries.push({
        source: 'supervisor',
        at: stamped || mtime,
        level,
        event: level === 'error' ? 'console.err' : 'console.out',
        text: scrubText(line),
      });
    }
  }
  return { entries, paths, found };
}

/* ------------------------------------------------------------------ *
 * The per-run files
 * ------------------------------------------------------------------ */

/**
 * Which journal events are worth an operator's attention as WARN or ERROR.
 *
 * The journal has a couple of hundred kinds (`docs/journal-events.md` holds the
 * table and a test pins it against the code) and no severity column — it was written for a
 * timeline, where every line is equal. A log explorer needs a level, and
 * inventing one per kind would be as many decisions that rot on the next event.
 *
 * **Segments, not suffixes.** The first cut matched `\.parked|-timeout|…`, and
 * a punctuation-sensitive pattern is wrong twice over: `\.parked` missed all
 * four `-parked` kinds, `\.halted` matched `phase.halted` but not `run.halt`,
 * and 13 of its 26 alternatives matched no kind that exists. So a kind is split
 * on `.` and `-` and its SEGMENTS are looked up. Separator asymmetry becomes
 * impossible, and `debug-index.test.ts` asserts every word below appears in at
 * least one real kind — a vocabulary that cannot go stale silently.
 *
 * `RESOLVED` wins over both, because a rung that settled is not a warning:
 * `phase.rung-settled` carries `rung` and is good news.
 *
 * Unknown ⇒ `info` on purpose. A missed warning is still in the list; a false
 * one trains the reader to filter warnings out.
 */
export const ERROR_SEGMENTS: readonly string[] = [
  'failed', 'refused', 'denied', 'lost', 'halt', 'halted',
  'unrunnable', 'mismatch', 'unsupported',
];

export const WARN_SEGMENTS: readonly string[] = [
  'stall', 'escalate', 'escalated', 'rung', 'degraded', 'parked', 'timeout',
  'wall', 'retry', 'blocked', 'unavailable', 'gated', 'overtaken', 'missing',
  'void', 'unanswered', 'storm', 'debris', 'unmanaged', 'partial', 'capped',
  'needs', 'recycled', 'nudge', 'nudged', 'superseded', 'discarded',
  'cancelled', 'ignored', 'skip', 'skipped', 'race', 'raised', 'interrupted',
];

/**
 * A segment that says the trouble ENDED. Outranks both sets above.
 *
 * `retracted` is the one that earns its place from a single kind:
 * `run.halt-retracted` carries `halt` and is a halt GOING AWAY.
 *
 * Two words are deliberately absent. `phase.outcome-no-defect` ("a repair
 * session found nothing wrong") and `run.failure-streak-reset` ("the counter
 * was cleared") both used to read as failures — but the fix for those was to
 * drop `defect` and `failure` from ERROR, where each matched that one kind and
 * nothing else. Adding `no` and `reset` here as well was belt AND braces for a
 * belt that no longer exists, and `reset` in a string array is a git verb, which
 * `never-push.test.ts` is right to refuse on sight. A severity word that
 * changes no answer is a word to delete, not to justify.
 */
export const RESOLVED_SEGMENTS: readonly string[] = [
  'settled', 'resolved', 'recovered', 'cleared', 'landed', 'done', 'finished',
  'released', 'verified', 'reconciled', 'thawed', 'retracted',
];

const ERRORS = new Set(ERROR_SEGMENTS);
const WARNS = new Set(WARN_SEGMENTS);
const RESOLVED = new Set(RESOLVED_SEGMENTS);

export function journalLevel(kind: string): DebugLevel {
  const segments = String(kind ?? '').toLowerCase().split(/[.-]/);
  if (segments.some((word) => RESOLVED.has(word))) return 'info';
  if (segments.some((word) => ERRORS.has(word))) return 'error';
  if (segments.some((word) => WARNS.has(word))) return 'warn';
  return 'info';
}

/** The run ids with a journal file under a plan's run directory, newest first. */
export function journalRunIds(root: string, slug: string): string[] {
  const dir = runDir(root, slug);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => /^run-[A-Za-z0-9_-]+\.jsonl$/.test(n))
      .map((n) => n.slice(4, -6))
      .sort()
      .reverse();
  } catch { return []; }
}

function fromJournalEntry(entry: JournalEntry, slug: string, runId: string): DebugEntry {
  const kind = typeof entry.event === 'string' ? entry.event : 'journal.line';
  const data = asRecord(entry.data);
  return {
    source: 'journal',
    at: isoOf(entry.time),
    level: journalLevel(kind),
    event: scrubText(kind),
    text: scrubText(summarise(kind, data)),
    slug,
    runId,
    ...(typeof entry.phase === 'number' ? { phase: entry.phase } : {}),
    ...(data ? { data } : {}),
  };
}

/**
 * Every run's journal for one plan, newest run first.
 *
 * `Journal.read(limit)` does the end-of-file windowing (and the ×4 widening),
 * so nothing here re-implements a tail. Newest run first means the cap keeps
 * the run somebody is looking at rather than the oldest one on disk.
 */
export function readJournals(root: string, slug: string, runId?: string): DebugEntry[] {
  const ids = runId ? [runId] : journalRunIds(root, slug);
  const entries: DebugEntry[] = [];
  for (const id of ids) {
    if (entries.length >= PER_SOURCE_CAP) break;
    const remaining = PER_SOURCE_CAP - entries.length;
    let lines: JournalEntry[] = [];
    try { lines = new Journal(root, slug, id).read(remaining); } catch { continue; }
    for (const line of lines) entries.push(fromJournalEntry(line, slug, id));
  }
  return entries;
}

/**
 * `outcomes/phase-NN.json` — what an UNSUPERVISED session declared about how it
 * ended, the one channel a hand-run session has into the autopilot.
 *
 * A file the console would refuse (`readOutcome` returns null for an unreadable,
 * unparseable, wrong-slug or unknown-status file) becomes a WARN row rather than
 * silence. That is the honest shape for a debugging surface: "there is a file
 * here and nothing will act on it" is exactly the thing somebody is looking for,
 * and dropping it is how a session's declaration disappears without a trace.
 */
export function readOutcomes(root: string, slug: string): DebugEntry[] {
  const dir = outcomeInboxDir(root, slug);
  if (!existsSync(dir)) return [];
  let names: string[];
  try { names = readdirSync(dir).filter((n) => /^phase-\d{2,}\.json$/.test(n)).sort(); } catch { return []; }

  const entries: DebugEntry[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const phase = inboxOutcomePhase(name);
    if (phase === null) continue;
    const outcome = readOutcome(path, { slug, phase });
    if (!outcome) {
      entries.push({
        source: 'outcome',
        at: '',
        level: 'warn',
        event: 'outcome.unreadable',
        text: `${name} exists and the console will not act on it — unreadable, unparseable, or for another plan or phase.`,
        slug,
        phase,
        data: { file: displayPath(path) },
      });
      continue;
    }
    const data = asRecord(outcome);
    entries.push({
      source: 'outcome',
      at: isoOf(outcome.written_at),
      // Only `complete` is good news; every other declared status is a session
      // saying it could not finish, which is the thing a reader is looking for.
      level: outcome.status === 'complete' ? 'info' : 'warn',
      event: scrubText(`outcome.${outcome.status}`),
      text: scrubText(outcome.reason || `phase ${phase} declared ${outcome.status}`),
      slug,
      phase,
      ...(data ? { data } : {}),
    });
  }
  return entries;
}

/** `rulings.ndjson` — what sessions DECIDED, per plan, append-only. */
export function readRulingEntries(root: string, slug: string): DebugEntry[] {
  const rulings: Ruling[] = readRulings(rulingsFile(root, slug));
  return rulings.slice(-PER_SOURCE_CAP).map((ruling) => {
    const data = asRecord(ruling);
    return {
      source: 'ruling' as const,
      at: isoOf(ruling.at),
      // A ruling is never a failure — it is a decision. It is `info` even when
      // it records a deviation, because the ledger's whole premise is that
      // recording one must be cheap and must not read as an alarm.
      level: 'info' as const,
      event: scrubText(`ruling.${ruling.kind}`),
      text: scrubText(ruling.what),
      slug,
      ...(Number.isFinite(ruling.phase) ? { phase: ruling.phase } : {}),
      ...(data ? { data } : {}),
    };
  });
}

/* ------------------------------------------------------------------ *
 * The delivery ledger
 * ------------------------------------------------------------------ */

/**
 * One row per DEVICE per announcement.
 *
 * The vocabulary is `shared/ops-vocab.js` `DELIVERY_OUTCOMES` and the meanings
 * are the register's table: `sent` means the push service accepted it, not that
 * anyone saw it — the browser and the OS are two more yeses; `quiet` means
 * nothing was attempted, on purpose, because the device was inside its own
 * quiet hours. Those two are working-as-intended and read `info`. The other
 * three are an announcement that did not arrive, which is a warning by itself.
 */
export function deliveryEntries(records: readonly NotificationRecord[]): DebugEntry[] {
  const entries: DebugEntry[] = [];
  for (const record of records) {
    for (const row of record.delivery ?? []) {
      const detail = row.detail ? ` — ${row.detail}` : '';
      entries.push({
        source: 'delivery',
        at: isoOf(row.at) || isoOf(record.at),
        level: row.outcome === 'sent' || row.outcome === 'quiet' ? 'info' : 'warn',
        event: scrubText(`delivery.${row.outcome}`),
        text: scrubText(`${row.label || row.device}: ${row.outcome}${detail} · ${record.title}`),
        ...(record.slug ? { slug: scrubText(record.slug) } : {}),
        ...(record.runId ? { runId: scrubText(record.runId) } : {}),
        ...(typeof record.phase === 'number' ? { phase: record.phase } : {}),
        data: {
          notification: record.id,
          category: record.category,
          urgent: record.urgent,
          device: scrubText(row.device),
          label: scrubText(row.label),
          outcome: row.outcome,
          ...(row.detail ? { detail: scrubText(row.detail) } : {}),
        },
      });
    }
  }
  // `slice(0, …)` and NOT `slice(-…)`: `notifications.list()` answers
  // newest-first, so taking from the end would keep the OLDEST rows and drop
  // exactly the announcement somebody came here to ask about. (`readConsoleLog`
  // takes from the end for the opposite and equally correct reason — a log file
  // is oldest-first.)
  return entries.slice(0, PER_SOURCE_CAP);
}

/* ------------------------------------------------------------------ *
 * Health — the env doctor's issues
 * ------------------------------------------------------------------ */

/** The shape `env-doctor.ts` produces and `service.environment.issues` holds. */
export type HealthIssue = { kind: string; detail: string; fix: string };

/**
 * Environment issues as rows.
 *
 * These have no time of their own — `environmentReport()` runs at construction
 * and the runtime ones are appended when they happen without a stamp. Rather
 * than invent one, the caller passes the console's start time: an issue found
 * at boot IS from boot, and one appended later sorts no worse than unplaced.
 */
export function healthEntries(issues: readonly HealthIssue[], at: string): DebugEntry[] {
  return issues.map((issue) => ({
    source: 'health' as const,
    at: isoOf(at),
    level: 'warn' as const,
    event: scrubText(`env.${issue.kind}`),
    text: scrubText(`${issue.detail} — ${issue.fix}`),
    data: { kind: scrubText(issue.kind), detail: scrubText(issue.detail), fix: scrubText(issue.fix) },
  }));
}

/* ------------------------------------------------------------------ *
 * The query
 * ------------------------------------------------------------------ */

function matches(entry: DebugEntry, query: DebugQuery, since: number, until: number): boolean {
  if (query.sources?.length && !query.sources.includes(entry.source)) return false;
  if (query.levels?.length && !query.levels.includes(entry.level)) return false;
  if (query.slug && entry.slug !== query.slug) return false;
  if (query.runId && entry.runId !== query.runId) return false;
  if (query.phase !== undefined && entry.phase !== query.phase) return false;
  if (Number.isFinite(since) || Number.isFinite(until)) {
    // An undated row is never excluded by a time window: it is unplaced, not
    // old, and silently dropping it would hide exactly the rows whose source
    // failed to stamp them — which is the class worth looking at.
    const ms = entry.at ? Date.parse(entry.at) : NaN;
    if (Number.isFinite(ms)) {
      if (Number.isFinite(since) && ms < since) return false;
      if (Number.isFinite(until) && ms > until) return false;
    }
  }
  if (query.q) {
    const needle = query.q.toLowerCase();
    const hay = `${entry.event}\n${entry.text}\n${entry.slug ?? ''}\n${entry.runId ?? ''}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

/** `since`/`until` accept an ISO string or a ms epoch; anything else is absent. */
export function boundary(value: string | undefined): number {
  if (!value || !value.trim()) return NaN;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  return Date.parse(value);
}

export function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit as number)), MAX_LIMIT);
}

/**
 * Merge, filter, sort newest-first, cap.
 *
 * Sources are gathered by the caller — the live ones need a `Service` — and
 * handed here as a map, so this function is pure and a test can drive it with
 * fixtures instead of with a running console.
 */
export function mergeIndex(
  gathered: ReadonlyMap<DebugSource, DebugBucket>,
  query: DebugQuery = {},
): DebugIndex {
  const since = boundary(query.since);
  const until = boundary(query.until);
  const limit = clampLimit(query.limit);

  const kept: DebugEntry[] = [];
  const counts = new Map<DebugSource, number>();
  for (const [source, bucket] of gathered) {
    for (const entry of bucket.entries) {
      if (!matches(entry, query, since, until)) continue;
      kept.push(entry);
      counts.set(source, (counts.get(source) ?? 0) + 1);
    }
  }

  // Newest first; an undated row sorts to the END rather than to 1970, so it
  // stays visible as unplaced instead of buried under every real row.
  kept.sort((a, b) => {
    const av = a.at ? Date.parse(a.at) : NaN;
    const bv = b.at ? Date.parse(b.at) : NaN;
    if (!Number.isFinite(av) && !Number.isFinite(bv)) return 0;
    if (!Number.isFinite(av)) return 1;
    if (!Number.isFinite(bv)) return -1;
    return bv - av;
  });

  const truncated = kept.length > limit;
  const entries = kept.slice(0, limit);

  const sources: DebugSourceStatus[] = DEBUG_SOURCES.map((source) => {
    const bucket = gathered.get(source);
    return {
      source,
      available: Boolean(bucket?.available),
      ...(bucket?.path ? { path: displayPath(bucket.path) } : {}),
      count: counts.get(source) ?? 0,
      ...(bucket?.note ? { note: bucket.note } : {}),
    };
  });

  return { entries, sources, truncated };
}
