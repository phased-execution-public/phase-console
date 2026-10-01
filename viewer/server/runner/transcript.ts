/**
 * What the session did, kept where a reload can find it again.
 *
 * The live console was streaming-only: events arrived over SSE and were held in
 * one React hook. Refresh the page and the window went blank; open it after a
 * phase finished and there was nothing to see at all, because the only copy of
 * a session's output had been in a browser tab that no longer existed. For a
 * page whose job is answering "what is it doing?", showing nothing is the one
 * unacceptable answer — and "it already happened" is not a reason to have
 * thrown it away.
 *
 * So the same events are appended here as they are broadcast, and the console
 * hydrates from this before subscribing. This is the server-side ring the SSE
 * literature recommends behind `Last-Event-ID`, written to disk rather than
 * held in memory so it also survives the console restarting.
 *
 * Deliberately raw: the *event* is stored, not a rendered line. Formatting
 * lives in one place in the browser (`toLine`), and duplicating it here would
 * mean a replayed run and a live one could disagree about what happened.
 *
 * ## One file per PHASE, read from its end (control-tower phase 94, #133)
 *
 * It was one file per RUN with a 16 MB hard stop. A long run crossed it within
 * days, and from then on every later phase replayed nothing — the operator
 * watching trade P43 saw "transcript full" six times and could not tell a
 * working session from a dead one. Three things changed:
 *
 *   - **Each phase appends to its own file**, `run-<id>.p<N>.log.jsonl`, with
 *     the cap below applied per file. A phase that fills its file silences only
 *     itself. `seq` still runs across the whole run, so a run-wide read merges
 *     the files in the order things happened. A line naming no phase goes to the
 *     run's own file, which is also where a run written before the split keeps
 *     every line it wrote.
 *   - **The file says what state it is in, not the writer.** `full` and
 *     `shedding` were flags on the instance, and every re-drive, restart and
 *     relaunch makes a new one — so each wrote its notice again (8 on the trade
 *     run), and a latched instance stayed full after the file was moved aside.
 *     Now the file's LAST line is the marker: the full notice ends a full file,
 *     and every line written past `SHED_BYTES` carries `shed`. A writer
 *     remembers what it last saw only against the file's inode and size, so any
 *     change to the file sends it back to read the file.
 *   - **Nothing reads a whole file.** The reader answered a 400-line tail by
 *     reading and splitting up to 16 MB, per request, and the constructor did
 *     the same to recover `seq`. Both read backwards from the end now.
 */

import { closeSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { log } from '../log.ts';
import { looksLikeSecret, redactSecrets } from '../../shared/human-step-model.js';
import { journalFile, runDir, transcriptFile, transcriptPhase } from './run-paths.ts';

export { transcriptFile } from './run-paths.ts';

/**
 * The redaction floor's TRANSCRIPT sink (control-tower phase 41): a session's
 * own stream can carry a secret — the command line of a declaration the
 * script refused, a token a tool printed — and the replay must not keep it.
 * The event is checked whole first, so an ordinary event is kept as it came;
 * one that carries a secret shape has every string redacted. A standalone
 * 6–8 digit code is redacted only in text that is a declaration
 * (`phase-outcome.sh`), because elsewhere such a number is a count.
 */
export function scrubTranscriptData(data: Record<string, unknown>): Record<string, unknown> {
  let serialized: string;
  try {
    serialized = JSON.stringify(data);
  } catch {
    return data;
  }
  if (!looksLikeSecret(serialized)) return data;
  return scrubValue(data, 0) as Record<string, unknown>;
}

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactSecrets(value, { codes: value.includes('phase-outcome.sh') });
  if (depth > 16 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = scrubValue(item, depth + 1);
  return out;
}

export type TranscriptEntry = {
  seq: number;
  at: string;
  event: string;
  data: Record<string, unknown>;
  /**
   * Written past `SHED_BYTES`. A file whose last line carries it has already
   * said it is shedding — the marker the next writer reads instead of a flag.
   */
  shed?: true;
};

/** Events worth replaying. Everything else is state the UI re-fetches anyway. */
const KEEP = new Set(['stream', 'phase', 'verify']);
/**
 * Past this, a file sheds its NOISE instead of everything.
 *
 * The old rule was a single 4 MB wall: cross it and the transcript stopped
 * dead, silently, with a `log.warn` nobody reads — and what filled those 4 MB
 * was overwhelmingly `partial`, whose every fragment is superseded by the
 * `text` block that follows it. So a long run lost its tool calls, its task
 * list and its results to make room for deltas that were already redundant.
 *
 * Now the cheap content goes first and the file keeps taking the expensive
 * content four times as far, and BOTH transitions leave a line in the
 * transcript saying what happened. The numbers are the old per-RUN ones, now
 * per PHASE: the whole 67-phase control-tower run fit in 17 MB, so a single
 * phase is not expected anywhere near them.
 */
export const SHED_BYTES = 4 * 1024 * 1024;
/** The hard stop, per file. Past here that phase's live view still streams; nothing more of it is replayed. */
export const MAX_BYTES = 16 * 1024 * 1024;
/** 80 % of the cap: crossing it is journalled (`phase.replay-limit`) and carried on the phase's record for the card. */
export const NEAR_FULL_BYTES = Math.floor(MAX_BYTES * 0.8);
/**
 * What gets dropped first: streamed fragments (superseded by their finished
 * block), the model's working, per-tool hook lifecycle, and the turn counter.
 * Everything a reader reconstructs the session FROM — text, tools, results,
 * the task list, limits, the outcome — is kept to the hard stop.
 */
const NOISE = new Set(['partial', 'thinking', 'hook', 'step']);
/** One line of console output. A pasted file is not a console line. */
const MAX_TEXT = 4_000;
/**
 * The longest array any one event may replay.
 *
 * Events carry lists now — a session's task list, most of all — and a list is
 * the one shape the string cap below cannot see. It is bounded where it is
 * produced too; this is the backstop, because the producer's bound and this
 * file's size are two different people's problem and only one of them is read
 * back into a browser months later.
 */
const MAX_ITEMS = 100;
/**
 * The longest line this writer frames. An event past it is replaced by a line
 * that says how large it was, which is what lets every read from the end stop
 * after a bounded number of bytes when it looks for a line's start.
 */
const MAX_LINE_BYTES = 256 * 1024;
/** How much one backward read takes at a time. */
const CHUNK = 64 * 1024;
/** How far back one read may go before it gives up: one file's cap and one line. */
const READ_BUDGET = MAX_BYTES + MAX_LINE_BYTES;
export const DEFAULT_LIMIT = 400;
/** The most entries one request may ask for — `?limit=` is the caller's, the bound is ours. */
export const MAX_LIMIT = 2_000;

const SHED_TEXT = 'transcript is large — streamed fragments, thinking and hook lines are no longer replayed';
const FULL_TEXT = 'transcript full — nothing further is replayed for this phase; the live view still streams and the journal has the full record';

/** A replay file crossing 80 % of its cap, or reaching it — once per file, told to whoever opened the writer. */
export type ReplayLimit = {
  /** Absent for the run's own file, which holds the lines that name no phase. */
  phase?: number;
  state: 'near-full' | 'full';
  bytes: number;
  cap: number;
  file: string;
};

/** What a file's last line says about it. `none`: empty, or nothing a writer framed. */
type LastLine = 'none' | 'plain' | 'shed' | 'full';

export class Transcript {
  /** The run's own replay — the lines that name no phase. A phase's is `pathFor(phase)`. */
  readonly path: string;
  private seq = 0;
  /**
   * What this writer last saw of each file, valid only while the file's inode
   * and size still match. It saves re-reading a line the writer itself just
   * wrote; it is never a latch — a file moved aside, truncated or appended to
   * by anyone else misses it, and the state is read from the file again.
   */
  private readonly seen = new Map<string, { ino: number; size: number; last: LastLine }>();
  private readonly onLimit: ((limit: ReplayLimit) => void) | undefined;
  private readonly root: string;
  private readonly slug: string;
  private readonly id: string;

  constructor(root: string, slug: string, id: string, options: { onLimit?: (limit: ReplayLimit) => void } = {}) {
    this.root = root;
    this.slug = slug;
    this.id = id;
    this.path = transcriptFile(root, slug, id);
    this.onLimit = options.onLimit;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      this.seq = lastSeq(root, slug, id);
    } catch {
      /* a transcript we cannot open costs the replay, never the run */
    }
  }

  pathFor(phase?: number): string {
    return phase == null ? this.path : transcriptFile(this.root, this.slug, this.id, phase);
  }

  /** Returns false when the event was not kept: not one worth keeping, shed, or past the cap. */
  append(event: string, raw: Record<string, unknown>): boolean {
    if (!KEEP.has(event)) return false;
    const data = scrubTranscriptData(raw);
    const phase = phaseOf(data);
    const path = this.pathFor(phase);
    let outcome: { kept: boolean; limit?: ReplayLimit } = { kept: false };
    let fd: number | null = null;
    try {
      // `a+`, not `a`: the writer READS the file's last line — its marker.
      fd = openSync(path, 'a+');
      outcome = this.appendTo(fd, path, phase, event, data);
    } catch (error) {
      log.warn('transcript.append', { path, error });
    } finally {
      if (fd != null) try { closeSync(fd); } catch { /* already gone */ }
    }
    // Told after the file is closed: the listener journals, and a journal line
    // must never be written from inside this file's write.
    if (outcome.limit) try { this.onLimit?.(outcome.limit); } catch { /* never at the cost of the replay */ }
    return outcome.kept;
  }

  private appendTo(
    fd: number,
    path: string,
    phase: number | undefined,
    event: string,
    data: Record<string, unknown>,
  ): { kept: boolean; limit?: ReplayLimit } {
    const { ino, size } = fstatSync(fd);
    const known = this.seen.get(path);
    const last = known && known.ino === ino && known.size === size ? known.last : size ? lastLineOf(fd, size) : 'none';
    if (last === 'full') {
      this.seen.set(path, { ino, size, last });
      return { kept: false };
    }

    const shedding = size > SHED_BYTES;
    const planned: [string, Record<string, unknown>][] = [];
    if (shedding && last !== 'shed') planned.push(['stream', notice(phase, 'shedding', SHED_TEXT)]);
    const shed = shedding && event === 'stream' && NOISE.has(String(data.kind));
    if (!shed) planned.push([event, data]);
    if (!planned.length) {
      this.seen.set(path, { ino, size, last });
      return { kept: false };
    }

    let body = planned.map(([kind, payload], i) => frame(this.seq + 1 + i, kind, payload, shedding)).join('');
    if (size + Buffer.byteLength(body) > MAX_BYTES) {
      // Written past the gate that just closed, on purpose: this is the ONE
      // line that explains why the replay ends here, and it is worth more than
      // the bytes it costs. It is also the marker every later writer reads.
      body = frame(this.seq + 1, 'stream', notice(phase, 'full', FULL_TEXT), false);
      const bytes = writeAll(fd, body);
      this.seq += 1;
      this.seen.set(path, { ino, size: size + bytes, last: 'full' });
      log.warn('transcript.full', { path, note: 'run continues; the live view still streams' });
      return { kept: false, limit: limitOf(path, phase, 'full', size + bytes) };
    }

    const bytes = writeAll(fd, body);
    this.seq += planned.length;
    this.seen.set(path, { ino, size: size + bytes, last: shedding ? 'shed' : 'plain' });
    const crossed = size < NEAR_FULL_BYTES && size + bytes >= NEAR_FULL_BYTES;
    return crossed ? { kept: !shed, limit: limitOf(path, phase, 'near-full', size + bytes) } : { kept: !shed };
  }

  /** The run's replay as a restarted console reads it: every file of the run, merged in `seq` order. */
  read(limit?: number): TranscriptEntry[] {
    return readRunTranscript(this.root, this.slug, this.id, limit == null ? {} : { limit });
  }
}

/**
 * The last `limit` entries of one replay file, oldest first — read backwards
 * from its END, never the whole of it. `keep` filters before the count.
 */
export function readTranscript(
  path: string,
  limit: number = DEFAULT_LIMIT,
  keep?: (entry: TranscriptEntry) => boolean,
): TranscriptEntry[] {
  const want = clampLimit(limit);
  const out: TranscriptEntry[] = [];
  scanBack(path, READ_BUDGET, (line) => {
    const entry = parseEntry(line);
    if (!entry || (keep && !keep(entry))) return false;
    out.push(entry);
    return out.length >= want;
  });
  return out.reverse();
}

/**
 * A run's replay: one phase's (with the lines that name no phase), or the
 * whole run's, merged across its files in `seq` order and cut to `limit`.
 *
 * The run-wide read visits files newest-first by their last `seq` and stops at
 * the first whose last line is older than everything already kept, so a run of
 * a hundred phases costs one short read per file and the tails of the few that
 * matter — not a hundred tails.
 */
export function readRunTranscript(
  root: string,
  slug: string,
  id: string,
  options: { limit?: number; phase?: number } = {},
): TranscriptEntry[] {
  const want = clampLimit(options.limit);
  const files = transcriptFiles(root, slug, id);
  const { phase } = options;
  if (phase != null) {
    // The run's own file holds the lines with no phase — and, for a run written
    // before the split, every phase's lines, which is why it is filtered.
    const mine = (entry: TranscriptEntry) => {
      const at = entry.data?.phase;
      return at == null || at === phase;
    };
    return merge(
      files.map((file) =>
        file.phase === phase ? readTranscript(file.path, want) : file.phase == null ? readTranscript(file.path, want, mine) : []),
      want,
    );
  }
  const heads = files
    .map((file) => ({ ...file, last: lastEntry(file.path)?.seq ?? 0 }))
    .sort((a, b) => b.last - a.last);
  let out: TranscriptEntry[] = [];
  for (const head of heads) {
    if (out.length >= want && head.last < out[0]!.seq) break;
    out = merge([out, readTranscript(head.path, want)], want);
  }
  return out;
}

/**
 * What the session panes read: the replay, and when the replay has nothing,
 * the journal's lines for the same phase — saying so in its first line, so a
 * pane is never only empty and never passes the journal off as the session.
 *
 * Nothing replayed is ordinary, not an accident: a phase that ran before its
 * run's file was moved aside, a run swept, a replay written before the split
 * and past the reader's budget.
 *
 * Between the two sits the session's OWN log (control-tower phase 95, #138):
 * `sessionLog` is the caller's reader of the phase's live (or latest) session
 * JSONL, already shaped as replay lines — the service's, which knows where the
 * account keeps it. It is asked only for a phase, and only when there is no
 * replay; its lines come under a first line that says where they are from, so
 * a pane never passes the session's log off as the console's replay.
 */
export function replayFor(
  root: string,
  slug: string,
  id: string,
  options: { limit?: number; phase?: number; sessionLog?: (limit: number) => TranscriptEntry[] } = {},
): TranscriptEntry[] {
  const { sessionLog, ...query } = options;
  const replay = readRunTranscript(root, slug, id, query);
  if (replay.length) return replay;
  if (sessionLog && query.phase != null) {
    let lines: TranscriptEntry[] = [];
    try {
      lines = sessionLog(Math.max(1, clampLimit(query.limit) - 1));
    } catch {
      lines = []; // an unreadable log is no log: the journal still answers
    }
    if (lines.length) {
      return [
        {
          seq: 0,
          at: lines[0]!.at,
          event: 'stream',
          data: {
            phase: query.phase, kind: 'notice', source: 'session-log',
            text: `Nothing was replayed for phase ${query.phase} — these are its session's own log lines instead`,
          },
        },
        ...lines,
      ];
    }
  }
  return fromJournal(root, slug, id, query);
}

/** `?limit=` and `?phase=` as the transcript route takes them: a bad limit is the default, a huge one is capped. */
export function transcriptQuery(params: URLSearchParams): { limit: number; phase?: number } {
  const limit = clampLimit(params.get('limit') ?? DEFAULT_LIMIT);
  const raw = params.get('phase');
  return raw != null && /^\d+$/.test(raw) ? { limit, phase: Number(raw) } : { limit };
}

/* ------------------------------------------------------------------ *
 * Reading from the end
 * ------------------------------------------------------------------ */

/**
 * Hand each complete line of a file to `accept`, LAST line first, until it
 * answers true, the start of the file, or `budget` bytes have been read.
 *
 * Lines are split on the byte 0x0A, which never occurs inside a UTF-8
 * multi-byte sequence, so a chunk boundary cannot tear a character. A line
 * longer than `maxLine` is skipped whole rather than accumulated — the budget
 * bounds the read, and this bounds the memory. Returns the bytes it read.
 */
function scanFd(
  fd: number, size: number, budget: number, accept: (line: string) => boolean, maxLine = MAX_LINE_BYTES,
): number {
  let pos = size;
  let read = 0;
  let tail = Buffer.alloc(0);
  let skipping = false;
  while (pos > 0 && read < budget) {
    const len = Math.min(CHUNK, pos);
    pos -= len;
    const chunk = Buffer.allocUnsafe(len);
    const got = readSync(fd, chunk, 0, len, pos);
    read += len;
    const buf = tail.length ? Buffer.concat([chunk.subarray(0, got), tail]) : chunk.subarray(0, got);
    let end = buf.length;
    while (end > 0) {
      const nl = buf.lastIndexOf(10, end - 1);
      if (nl === -1) break;
      if (skipping) skipping = false;
      else if (nl + 1 < end && accept(buf.toString('utf8', nl + 1, end))) return read;
      end = nl;
    }
    tail = skipping ? Buffer.alloc(0) : buf.subarray(0, end);
    if (tail.length > maxLine) {
      tail = Buffer.alloc(0);
      skipping = true;
    }
  }
  if (pos === 0 && tail.length && !skipping) accept(tail.toString('utf8'));
  return read;
}

/**
 * Every complete line of a file, LAST first, until `accept` answers true, the
 * start, or `budget` bytes — the one backward line reader of this console
 * (the replay's, and since control-tower phase 95 the session log's, #138).
 * Returns the bytes it read, which is what "never the whole file" is measured by.
 */
export function scanBack(
  path: string, budget: number, accept: (line: string) => boolean, maxLine = MAX_LINE_BYTES,
): number {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return 0;
  }
  try {
    return scanFd(fd, fstatSync(fd).size, budget, accept, maxLine);
  } catch {
    return 0; /* an unreadable replay answers what it had */
  } finally {
    closeSync(fd);
  }
}

function parseEntry(line: string): TranscriptEntry | null {
  try {
    const entry = JSON.parse(line) as TranscriptEntry;
    return entry && typeof entry === 'object' && typeof entry.event === 'string' ? entry : null;
  } catch {
    return null; // half-written tail, or bytes nobody framed
  }
}

/** The last entry a file holds — one short read. */
function lastEntry(path: string): TranscriptEntry | null {
  let found: TranscriptEntry | null = null;
  scanBack(path, 2 * MAX_LINE_BYTES, (line) => {
    found = parseEntry(line);
    return found != null;
  });
  return found;
}

/** The state a file's last framed line puts it in — the marker a writer reads instead of remembering. */
function lastLineOf(fd: number, size: number): LastLine {
  let state: LastLine = 'none';
  scanFd(fd, size, 2 * MAX_LINE_BYTES, (line) => {
    const entry = parseEntry(line);
    if (!entry) return false;
    const data = entry.data ?? {};
    const said = data.kind === 'notice' ? String(data.text ?? '') : '';
    // The text checks read a file written before the markers existed.
    if (data.marker === 'full' || said.startsWith('transcript full')) state = 'full';
    else if (entry.shed === true || data.marker === 'shedding' || said.startsWith('transcript is large')) state = 'shed';
    else state = 'plain';
    return true;
  });
  return state;
}

/** The replay files a run writes now — its own and one per phase; never an archive. */
function transcriptFiles(root: string, slug: string, id: string): { path: string; phase: number | null }[] {
  const dir = runDir(root, slug);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { path: string; phase: number | null }[] = [];
  for (const name of names) {
    const phase = transcriptPhase(name, id);
    if (phase !== undefined) out.push({ path: join(dir, name), phase });
  }
  return out;
}

/** Where `seq` carries on from: the largest last line across the run's replay files. */
function lastSeq(root: string, slug: string, id: string): number {
  let max = 0;
  for (const file of transcriptFiles(root, slug, id)) {
    const seq = Number(lastEntry(file.path)?.seq);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return max;
}

type JournalRow = { seq?: number; time?: string; event: string; phase?: number; data?: Record<string, unknown> };

/** A phase's journal lines, as replay lines under one that says where they came from. */
function fromJournal(root: string, slug: string, id: string, options: { limit?: number; phase?: number }): TranscriptEntry[] {
  const want = clampLimit(options.limit);
  const { phase } = options;
  const rows: JournalRow[] = [];
  scanBack(journalFile(root, slug, id), READ_BUDGET, (line) => {
    let row: JournalRow;
    try {
      row = JSON.parse(line) as JournalRow;
    } catch {
      return false;
    }
    if (!row || typeof row.event !== 'string' || (phase != null && row.phase !== phase)) return false;
    rows.push(row);
    return rows.length >= Math.max(1, want - 1);
  });
  if (!rows.length) return [];
  rows.reverse();
  const line = (row: JournalRow, text: string, seq: number): TranscriptEntry => ({
    seq,
    at: row.time ?? new Date().toISOString(),
    event: 'stream',
    data: { ...(row.phase != null ? { phase: row.phase } : phase != null ? { phase } : {}), kind: 'notice', source: 'journal', text },
  });
  const what = phase != null ? `phase ${phase}` : 'this run';
  return [
    line(rows[0]!, `Nothing was replayed for ${what} — these are its journal lines instead`, 0),
    ...rows.map((row) => line(row, journalText(row), Number(row.seq) || 0)),
  ];
}

function journalText(row: JournalRow): string {
  const data = row.data ?? {};
  for (const key of ['reason', 'note', 'status', 'text', 'summary', 'command']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return `${row.event} — ${value.trim().slice(0, MAX_TEXT)}`;
  }
  return row.event;
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

function phaseOf(data: Record<string, unknown>): number | undefined {
  const phase = data.phase;
  return typeof phase === 'number' && Number.isInteger(phase) && phase >= 0 ? phase : undefined;
}

function notice(phase: number | undefined, marker: 'shedding' | 'full', text: string): Record<string, unknown> {
  return { kind: 'notice', ...(phase != null ? { phase } : {}), marker, text };
}

function limitOf(path: string, phase: number | undefined, state: ReplayLimit['state'], bytes: number): ReplayLimit {
  return { ...(phase != null ? { phase } : {}), state, bytes, cap: MAX_BYTES, file: basename(path) };
}

/** One framed line. An event past `MAX_LINE_BYTES` keeps its identity and says how large it was. */
function frame(seq: number, event: string, data: Record<string, unknown>, shed: boolean): string {
  const entry: TranscriptEntry = { seq, at: new Date().toISOString(), event, data: trim(data), ...(shed ? { shed: true as const } : {}) };
  let text = JSON.stringify(entry);
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_LINE_BYTES) {
    const keep: Record<string, unknown> = {};
    for (const key of ['phase', 'kind', 'name', 'status']) if (data[key] != null) keep[key] = data[key];
    text = JSON.stringify({
      ...entry,
      data: { ...keep, truncated: true, text: `this event was ${Math.round(bytes / 1024)} KiB — too large to replay` },
    });
  }
  return `${text}\n`;
}

function writeAll(fd: number, body: string): number {
  const buf = Buffer.from(body, 'utf8');
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  return buf.length;
}

function clampLimit(limit: unknown): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/** Merge tails in `seq` order and keep the newest `want`. */
function merge(parts: TranscriptEntry[][], want: number): TranscriptEntry[] {
  const all = parts.flat();
  all.sort((a, b) => a.seq - b.seq);
  return all.length > want ? all.slice(-want) : all;
}

/** Keep long values from turning one console line into a log file. */
function trim(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' && value.length > MAX_TEXT) {
      out[key] = `${value.slice(0, MAX_TEXT)}… (${value.length - MAX_TEXT} more characters)`;
    } else if (Array.isArray(value) && value.length > MAX_ITEMS) {
      out[key] = value.slice(0, MAX_ITEMS);
    } else {
      out[key] = value;
    }
  }
  return out;
}
