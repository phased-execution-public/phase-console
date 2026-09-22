/**
 * Structured logging and the exit record.
 *
 * The console has to survive an unattended multi-hour run, and a supervisor
 * that dies silently is worse than no supervisor at all — so every exit writes
 * down why. Lines are NDJSON in `~/.local/state/phase-console/console.log`
 * (never inside a repo, the same rule preferences follow), rotated at 8 MB so
 * a long-lived process cannot fill a disk.
 *
 * Writes are synchronous on purpose: the records that matter most are the ones
 * emitted microseconds before the process dies, and an async write loses
 * exactly those. Every call is wrapped — logging must never be the thing that
 * takes the server down.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { STATE_DIR, defaultLogFile } from './config.ts';
import { count } from './counters.ts';
import { current } from './trace.ts';

/** Worst last, so a numeric rank is just the index. */
export const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type Level = (typeof LEVELS)[number];

const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * One line of the console log.
 *
 * `v: 2` is the envelope version and is on EVERY line, traced or not — a reader
 * must be able to tell "this file predates the ids" from "this line was written
 * outside a span", and a version that only appeared on traced lines could not
 * say either. v1 lines have no `v` at all and are read by `withDerivedIds()`
 * in the journal's twin of this shape.
 */
export type Entry = {
  v?: 2;
  time: string;
  level: Level;
  event: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  phase?: number;
  attempt?: number;
  sessionId?: string;
  actor?: string;
  data?: Record<string, unknown>;
};

/**
 * Env-tunable so a test can rotate with kilobytes instead of megabytes.
 *
 * 16 MB, doubled from 8 in 5.1.0: a console that logs every git command, every
 * engine call and every HTTP request writes several times what one that logged
 * none of them did, and the pair (live + `.1`) is still bounded at ~32 MB.
 */
export const LOG_MAX_BYTES = Number(process.env.PHASE_CONSOLE_LOG_MAX_BYTES) || 16 * 1024 * 1024;
/** Enough recent history for the UI to explain a degraded state, not a second log. */
const RING_SIZE = 200;

let file: string | null = null;
let ready = false;
/**
 * Bytes in the live file, counted in the write path. Rotation used to happen
 * only at `open()` — once per process — so a long-lived console grew the live
 * file without bound between restarts, and the rename at the NEXT boot turned
 * all of it into a `.1` as big as the process was long (522 MB seen in the
 * wild). Counting here keeps the pair bounded at ~2 × MAX_BYTES total.
 */
let bytes = 0;
const ring: Entry[] = [];

/**
 * Set once the terminal that owned this process has gone.
 *
 * The console deliberately survives its terminal closing, so a run in progress
 * is not killed by someone tidying up windows. What it did not survive was the
 * consequence: macOS revokes the tty, every write to stderr then fails
 * *asynchronously* — past any try/catch around the call — and that surfaces as
 * an uncaughtException, which the crash handler dutifully reports by writing to
 * stderr. A process that logs its own logging failure forever.
 *
 * Seen in the wild: six identical `write EIO` degradations in the same second,
 * a server still answering /api/state but hanging on every static file, and a
 * blank page with no explanation anywhere.
 */
let consoleGone = false;

// The throw arrives on the stream, not from the write call, so it has to be
// caught here rather than at the call site.
for (const stream of [process.stderr, process.stdout]) {
  try {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EIO' || error.code === 'EPIPE' || error.code === 'EBADF') consoleGone = true;
    });
  } catch { /* a stream that cannot even take a listener is already gone */ }
}

/** Has the owning terminal gone away? Exposed so `/api/state` can say so. */
export function consoleDetached(): boolean {
  return consoleGone;
}

/** Point the log at a file. Called once at startup; `null` disables file output. */
export function configureLog(target?: string | null): string | null {
  file = target === null ? null : (target ?? defaultLogFile());
  ready = false;
  if (file) open();
  return file;
}

function open(): void {
  if (!file || ready) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    rotateIfLarge();
    try { bytes = statSync(file).size; } catch { bytes = 0; }
    ready = true;
    removeOversizedRelic();
  } catch {
    // An unwritable state directory costs us the file log, not the server.
    file = null;
  }
}

function rotateIfLarge(): void {
  if (!file) return;
  try {
    if (statSync(file).size > LOG_MAX_BYTES) rotate();
  } catch {
    /* no file yet, or a rotation race — either way, keep going */
  }
}

/** Rename replaces any previous `.1`, so the pair never exceeds ~2 × MAX_BYTES. */
function rotate(): void {
  if (!file) return;
  try { renameSync(file, `${file}.1`); } catch { /* a rotation race loses nothing */ }
  bytes = 0;
}

/**
 * A `.1` more than twice the cap cannot be a product of this code — rotation
 * replaces it wholesale with a live file the write path keeps under the cap.
 * It can only be the older bug's leftovers (rotation ran once per process, so
 * the live file grew for as long as the console did). Remove it once, and say
 * so, instead of letting half a gigabyte sit under a file nobody reads.
 */
function removeOversizedRelic(): void {
  if (!file) return;
  try {
    const relic = `${file}.1`;
    const size = statSync(relic).size;
    if (size > 2 * LOG_MAX_BYTES) {
      rmSync(relic);
      write('info', 'log.relic-removed', { bytes: size });
    }
  } catch {
    /* no relic — the usual case */
  }
}

/** Errors do not survive JSON.stringify; unwrap them into something readable. */
function plain(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      code: (value as { code?: unknown }).code,
      stack: value.stack?.split('\n').slice(0, 8).join('\n'),
    };
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * Volume — the level floor, the per-channel opt-in, and the override
 * ------------------------------------------------------------------ */

/** How long a runtime override lasts when the caller does not say. */
const DEFAULT_OVERRIDE_MS = 30 * 60_000;
/** And the longest it may last at all — an override that never reverts is a setting. */
const MAX_OVERRIDE_MS = 24 * 60 * 60_000;

export type LevelState = {
  level: Level;
  /** The raw `PHASE_CONSOLE_DEBUG` spec in force: a csv of channels, or `*`. */
  debug: string;
  source: 'env' | 'override';
  /** When an override lapses. Absent when the env is answering. */
  until?: number;
};

let override: { level?: Level; debug?: string; until: number } | null = null;

function envLevel(): Level {
  const raw = (process.env.PHASE_CONSOLE_LOG_LEVEL ?? '').trim().toLowerCase();
  return (LEVELS as readonly string[]).includes(raw) ? (raw as Level) : 'info';
}

function envDebug(): string {
  return process.env.PHASE_CONSOLE_DEBUG ?? '';
}

/**
 * What the log is admitting right now.
 *
 * The deadline is compared against a clock rather than armed on a `setTimeout`:
 * a timer would hold the event loop open, would die with the process that set
 * it, and could not be tested without really sleeping.
 */
export function levelState(now: number = Date.now()): LevelState {
  if (override && now <= override.until) {
    return {
      level: override.level ?? envLevel(),
      debug: override.debug ?? envDebug(),
      source: 'override',
      until: override.until,
    };
  }
  return { level: envLevel(), debug: envDebug(), source: 'env' };
}

/**
 * Turn the level (or a debug channel) up for a while.
 *
 * Behind `POST /api/debug/level`, which is why it reverts by itself: the point
 * is to catch one misbehaving run, not to leave a console writing debug lines
 * until somebody remembers.
 */
export function setLevel(
  opts: { level?: Level; debug?: string; ttlMs?: number },
  now: number = Date.now(),
): LevelState {
  if (opts.level !== undefined && !(LEVELS as readonly string[]).includes(opts.level)) {
    throw new Error(`unknown log level ${JSON.stringify(opts.level)} — one of ${LEVELS.join(', ')}`);
  }
  const ttl = Math.min(Math.max(opts.ttlMs ?? DEFAULT_OVERRIDE_MS, 0), MAX_OVERRIDE_MS);
  override = { level: opts.level, debug: opts.debug, until: now + ttl };
  return levelState(now);
}

/** Drop the override; the environment answers again. */
export function revertLevel(): void {
  override = null;
}

/** `git.command` → `git`. The channel is the event name's first segment. */
function channelOf(event: string): string {
  const dot = event.indexOf('.');
  return dot === -1 ? event : event.slice(0, dot);
}

function channelOn(channel: string, spec: string): boolean {
  if (!spec) return false;
  for (const token of spec.split(/[\s,]+/)) {
    if (token === '*' || token === channel) return true;
  }
  return false;
}

/**
 * Would a `debug` line on this channel be written?
 *
 * Asked BEFORE building an expensive payload — a command's output tail, a
 * diff's byte count — so the cost of the detail is only paid when somebody
 * asked for it.
 */
function enabled(channel: string, state: LevelState = levelState()): boolean {
  return RANK.debug >= RANK[state.level] || channelOn(channel, state.debug);
}

/**
 * The level floor, with one deliberate exception.
 *
 * A named debug channel OUTRANKS the floor. "Show me every git command" that
 * also required lowering the global level would flood the log with everything
 * else at the same moment — which is the log you are trying to read.
 */
function admits(level: Level, event: string, state: LevelState): boolean {
  if (RANK[level] >= RANK[state.level]) return true;
  return level === 'debug' && channelOn(channelOf(event), state.debug);
}

function write(level: Level, event: string, data?: Record<string, unknown>): void {
  if (!admits(level, event, levelState())) return;

  const span = current();
  const entry: Entry = {
    v: 2,
    time: new Date().toISOString(),
    level,
    event,
    // Read from the ambient span at WRITE time: the call sites are hundreds of
    // lines over thirty files, and a parameter every one had to remember is a
    // parameter most would forget.
    ...(span
      ? {
          traceId: span.traceId,
          spanId: span.spanId,
          ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
          ...(span.phase === undefined ? {} : { phase: span.phase }),
          ...(span.attempt === undefined ? {} : { attempt: span.attempt }),
          ...(span.sessionId === undefined ? {} : { sessionId: span.sessionId }),
          ...(span.actor === undefined ? {} : { actor: span.actor }),
        }
      : {}),
  };
  if (data && Object.keys(data).length) {
    entry.data = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, plain(v)])) as Record<string, unknown>;
  }

  // Counted where it is ADMITTED, not where it is called: a line the level
  // dropped is not a line this console wrote, and counting it would make the
  // meter answer a question nobody asked (how loud would it be at debug).
  count('log_lines_total', [level]);

  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();

  // launchd captures stderr, so a problem is visible even without the file.
  // `debug` stays out of it: its whole reason to exist is volume nobody wants
  // on a terminal.
  if ((level === 'warn' || level === 'error') && !consoleGone) {
    try {
      process.stderr.write(`[phase-console] ${level} ${event}${entry.data ? ` ${JSON.stringify(entry.data)}` : ''}\n`);
    } catch { consoleGone = true; }
  }

  if (!file) return;
  open();
  if (!file) return;
  try {
    if (bytes > LOG_MAX_BYTES) rotate();
    const line = `${JSON.stringify(entry)}\n`;
    appendFileSync(file, line, 'utf8');
    bytes += Buffer.byteLength(line);
  } catch {
    /* disk full, permissions, a deleted directory — never propagate */
  }
}

export const log = {
  /**
   * High-volume detail — every git command, every engine call, every request.
   *
   * Dropped at the default level and admitted either by lowering the floor or,
   * far more usefully, by naming its channel in `PHASE_CONSOLE_DEBUG`.
   */
  debug: (event: string, data?: Record<string, unknown>) => write('debug', event, data),
  /** Is this debug channel on? Ask before building a payload you would throw away. */
  enabled: (channel: string) => enabled(channel),
  info: (event: string, data?: Record<string, unknown>) => write('info', event, data),
  warn: (event: string, data?: Record<string, unknown>) => write('warn', event, data),
  error: (event: string, data?: Record<string, unknown>) => write('error', event, data),
};

const DISCONNECT_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECANCELED', 'ERR_STREAM_PREMATURE_CLOSE']);

/**
 * Closing a tab, navigating away, or sleeping a laptop all abort an in-flight
 * response. These have to be *handled* — unhandled they end the process — but
 * they are not worth recording: a browser reload used to produce a dozen stack
 * traces, and a log that noisy is a log nobody reads.
 */
export function isClientDisconnect(error: unknown): boolean {
  if (!error) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && DISCONNECT_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message === 'aborted' || message.includes('premature close');
}

/** The last few hundred entries, newest last — for `/api/state` and the UI. */
export function recent(limit = 50): Entry[] {
  return ring.slice(-Math.max(1, limit));
}

export function logFilePath(): string | null {
  return file;
}

/**
 * Did the previous run end without writing an exit record?
 *
 * `SIGKILL`, an OOM kill and a hard power loss all leave `start` as the last
 * entry — nothing can be logged from a process that is already gone. So two
 * consecutive `start` records with no `exit` between them *are* the crash
 * signature, and saying so at boot beats hoping someone notices the gap.
 * Returns null when there is no prior run to judge.
 */
export function previousRunEndedCleanly(): boolean | null {
  if (!file) return null;
  try {
    // The last few KB is plenty; the records we care about are one line each.
    const raw = readFileSync(file, 'utf8');
    const lines = raw.trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0 && i > lines.length - 400; i--) {
      const event = (JSON.parse(lines[i]) as Entry).event;
      if (event === 'exit') return true;
      if (event === 'start') return false;
    }
  } catch {
    /* no log yet, or a truncated line — nothing to conclude */
  }
  return null;
}

export function stateDir(): string {
  return STATE_DIR;
}

/* ------------------------------------------------------------------ *
 * The exit record
 * ------------------------------------------------------------------ */

let exitReason: { reason: string; detail?: Record<string, unknown> } | null = null;
let exitInstalled = false;

/**
 * Declare why the process is about to end, so the exit record says something
 * better than "code 0". A deliberate shutdown calls this; anything that does
 * not is reported as `unknown`, which is precisely the case worth chasing.
 */
export function noteExit(reason: string, detail?: Record<string, unknown>): void {
  exitReason = { reason, detail };
}

/**
 * Record how this process ended.
 *
 * An exit with no declared reason is logged at `error` even when the code is 0,
 * because a silent clean exit is exactly the failure we are hunting: the
 * console "just stopped" and nothing said why. Disposition — which signals
 * actually end the process — belongs to `index.ts`; this only writes it down.
 */
export function installExitLogging(): void {
  if (exitInstalled) return;
  exitInstalled = true;

  const started = Date.now();

  process.on('exit', (code) => {
    write(exitReason ? 'info' : 'error', 'exit', {
      code,
      reason: exitReason?.reason ?? 'unknown — no shutdown path ran',
      uptimeSeconds: Math.round((Date.now() - started) / 1000),
      ...(exitReason?.detail ?? {}),
    });
  });
}
