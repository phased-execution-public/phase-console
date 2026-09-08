/**
 * The run journal: append-only, one NDJSON line per thing that happened.
 *
 * It serves two jobs that pull in the same direction. It is the audit trail —
 * what ran, what it cost, which gate opened, who approved it — and it is what a
 * restarted console reads to explain a run it did not start. The checkpoint in
 * `state.ts` says where a run *is*; the journal says how it got there, which is
 * the question anyone actually asks after something goes wrong.
 *
 * Appends are synchronous for the same reason the console log is: the entries
 * worth having are the ones written just before something dies.
 */

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { log } from '../log.ts';
import { journalFile } from './state.ts';

export type JournalEntry = {
  seq: number;
  time: string;
  event: string;
  phase?: number;
  data?: Record<string, unknown>;
};

/** A single phase can emit a lot of tool traffic; keep one run's file sane. */
const MAX_BYTES = 32 * 1024 * 1024;

/**
 * How much of the tail is enough to find the last complete line.
 *
 * A journal line is one JSON object — normally a few hundred bytes, and bounded
 * well below this even when a tool result rides along. Reading a window rather
 * than the file is the whole point: recovering `seq` used to cost a full parse
 * of up to 32 MB on any request that constructed a Journal, and both
 * `runJournal` and `runTimeline` construct one before reading it.
 */
const TAIL_BYTES = 64 * 1024;

/** Bytes to read per entry when `read(limit)` is asked for a bounded tail. */
const BYTES_PER_ENTRY_GUESS = 2 * 1024;

export class Journal {
  readonly path: string;
  private seq = 0;
  private overflowed = false;

  constructor(root: string, slug: string, id: string) {
    this.path = journalFile(root, slug, id);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      // Resuming an existing run continues its numbering rather than restarting
      // at 1, so the file stays readable as one sequence. Only the LAST line
      // carries the answer, so only the tail is read: a full parse here was
      // paid by every construction, including the two read paths that then
      // read the file again themselves.
      this.seq = this.lastSeq();
    } catch {
      /* a journal we cannot open costs the audit trail, never the run */
    }
  }

  /**
   * The highest `seq` on disk, from the tail alone.
   *
   * Falls back to a full read only when the window holds no complete line —
   * which means a single entry larger than `TAIL_BYTES`, so the file is small
   * enough that reading it costs nothing anyway. Returning 0 for an unreadable
   * or absent file is the same answer the full read gave.
   */
  private lastSeq(): number {
    const tail = this.tail(TAIL_BYTES);
    if (tail === null) return 0;
    const lines = tail.text.split('\n').filter(Boolean);
    // A window that starts mid-file almost certainly starts mid-line; that
    // first fragment is dropped rather than parsed.
    if (tail.partial && lines.length) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const seq = (JSON.parse(lines[i]) as JournalEntry).seq;
        if (typeof seq === 'number') return seq;
      } catch { /* a half-written tail line, or the fragment above */ }
    }
    if (!tail.partial) return 0;
    // One entry wider than the window: pay the full read, once.
    return this.readAll().at(-1)?.seq ?? 0;
  }

  /**
   * The last `bytes` of the file, and whether anything precedes them.
   *
   * `null` when the file cannot be read at all — which is the normal state
   * before the first append and must not be confused with an empty file.
   */
  private tail(bytes: number): { text: string; partial: boolean } | null {
    let fd: number | undefined;
    try {
      const size = statSync(this.path).size;
      if (size === 0) return { text: '', partial: false };
      const take = Math.min(size, bytes);
      const buffer = Buffer.allocUnsafe(take);
      fd = openSync(this.path, 'r');
      const read = readSync(fd, buffer, 0, take, size - take);
      return { text: buffer.subarray(0, read).toString('utf8'), partial: take < size };
    } catch {
      return null;
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* already gone */ } }
    }
  }

  private readAll(): JournalEntry[] {
    let text: string;
    try { text = readFileSync(this.path, 'utf8'); } catch { return []; }
    return parseLines(text.split('\n').filter(Boolean));
  }

  append(event: string, data?: Record<string, unknown>, phase?: number): JournalEntry {
    const entry: JournalEntry = {
      seq: ++this.seq,
      time: new Date().toISOString(),
      event,
      ...(phase === undefined ? {} : { phase }),
      ...(data && Object.keys(data).length ? { data } : {}),
    };
    if (this.overflowed) return entry;
    try {
      if (statSync(this.path).size > MAX_BYTES) {
        this.overflowed = true;
        log.warn('journal.full', { path: this.path, note: 'run continues; journal stopped growing' });
        return entry;
      }
    } catch {
      /* no file yet — that is the normal first append */
    }
    try {
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      log.warn('journal.append', { path: this.path, error });
    }
    return entry;
  }

  /**
   * Every entry, oldest first — or the last `limit` of them.
   *
   * With a `limit` the file is read from the END, in a window sized to the
   * request, and widened only while the window still holds fewer entries than
   * asked for and more file remains. Both callers pass a limit (500 for the
   * Journal panel, 20,000 for the timeline), and the old code read and parsed
   * the whole file before throwing all but the tail away.
   *
   * A truncated final line is skipped, not fatal.
   */
  read(limit?: number): JournalEntry[] {
    if (!limit || limit <= 0) return this.readAll();
    let window = Math.min(MAX_BYTES, Math.max(TAIL_BYTES, limit * BYTES_PER_ENTRY_GUESS));
    for (;;) {
      const tail = this.tail(window);
      if (tail === null) return [];
      const lines = tail.text.split('\n').filter(Boolean);
      if (tail.partial && lines.length) lines.shift();
      // Enough entries, or the window already covers the file: this is the answer.
      if (lines.length >= limit || !tail.partial || window >= MAX_BYTES) {
        return parseLines(lines.length > limit ? lines.slice(-limit) : lines);
      }
      window = Math.min(MAX_BYTES, window * 4);
    }
  }
}

function parseLines(lines: string[]): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line) as JournalEntry); } catch { /* half-written tail */ }
  }
  return entries;
}
