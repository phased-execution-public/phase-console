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

import { INSTANCE } from '../config.ts';
import { count } from '../counters.ts';
import { log } from '../log.ts';
import { current, runTraceId } from '../trace.ts';
import { journalFile } from './run-paths.ts';

export type JournalEntry = {
  seq: number;
  time: string;
  event: string;
  phase?: number;
  /**
   * The envelope version. `2` on every line this console writes; `1` on a line
   * `withDerivedIds()` has given ids it was not written with; absent on a line
   * straight off disk that predates the columns. A reader must be able to tell
   * "written with ids" from "ids computed for it".
   */
  v?: 1 | 2;
  /** The RUN's trace — `runTraceId(instance, slug, runId)`, whoever wrote the line. */
  traceId?: string;
  /**
   * The trace the WRITER was in, when that is not the run's.
   *
   * An HTTP request, a convergence pass or another run's drive reaching in has
   * a trace of its own. The line still belongs to this run — that is the
   * question the id answers — so the crossing is recorded beside it rather than
   * one side being silently preferred.
   */
  viaTraceId?: string;
  spanId?: string;
  parentSpanId?: string;
  attempt?: number;
  sessionId?: string;
  actor?: string;
  data?: Record<string, unknown>;
};

/** A single phase can emit a lot of tool traffic; keep one run's file sane. */
const MAX_BYTES = 32 * 1024 * 1024;

/**
 * Held back so a full journal can still say how the run ended.
 *
 * The older behaviour stopped appending at the cap and wrote `journal.full` to
 * the CONSOLE log — so the journal itself simply stopped, mid-run, and the one
 * line that distinguishes "it finished" from "it was killed" never arrived. A
 * reader opening the file saw silence and no explanation in it.
 */
const RESERVE_BYTES = 256 * 1024;

/**
 * The events the reserve is for: how the run ENDED, and the marker itself.
 *
 * Deliberately no phase traffic. A full journal is full because of phase
 * traffic, and admitting any of it back would spend the reserve on exactly
 * what exhausted the file.
 */
export const RESERVE_EVENTS: ReadonlySet<string> = new Set([
  'journal.full',
  'run.finished',
  'run.halt',
  'run.settled',
  'run.console-shutdown',
]);

/** What a line needs to be given the ids it was written without. */
export type DerivedIdSource = { instanceId: string; slug: string; runId: string };

/**
 * Read a v1 line as if it carried the columns.
 *
 * A stored journal is not rewritten — it is an audit trail, and an audit trail
 * that changes under you is not one. The trace id is instead RE-DERIVED on
 * read, which it can be precisely because `runTraceId` is a pure function of
 * three facts the reader already has. Idempotent: a line that already carries
 * ids is returned untouched, so a mixed file (a run that spanned the upgrade)
 * projects consistently.
 */
export function withDerivedIds(entry: JournalEntry, source: DerivedIdSource): JournalEntry {
  if (entry.traceId) return entry;
  return { ...entry, v: 1, traceId: runTraceId(source.instanceId, source.slug, source.runId) };
}

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

/** Everything about a Journal that a test needs to move and production does not. */
export type JournalOptions = {
  /** Which console's run this is. Defaults to this process's instance. */
  instanceId?: string;
  maxBytes?: number;
  reserveBytes?: number;
};

/**
 * The one Journal per run file this process keeps — `Journal.for`'s registry.
 *
 * A `seq` is a counter, and a counter numbers ONE sequence only while it has
 * one owner (#51). Every writer used to build its own `new Journal(…)`, each
 * read the tail once at construction and counted on from there — so the watch
 * scheduler's fresh instance read 488 and wrote 489 while the live runner's,
 * still believing 488, wrote 489 too, and a reader whose cursor sat between
 * the two lines never saw one of them. Keyed by the FILE: two spellings of one
 * root resolve to one instance directory (`instanceId` is lexical), so they
 * are one file and must be one counter.
 *
 * Never pruned. An instance is a path, a trace id and three numbers; a console
 * that has touched ten thousand runs holds a few megabytes, and evicting one a
 * runner still holds would hand the next caller a second counter — the very
 * thing this exists to prevent.
 */
const journals = new Map<string, Journal>();

/**
 * Who hears every line a run's journal writes (control-tower phase 136, #213):
 * the console's turn — its handled log reads a thing the AI handled off the
 * line that says it, and a line wakes a round. A listener that throws is
 * dropped from that line, never from the run.
 */
export type JournalAppendListener = (line: { slug: string; runId: string; entry: JournalEntry }) => void;
const appendListeners = new Set<JournalAppendListener>();

/** Hear every line any run's journal writes in this process; the answer stops it. */
export function onJournalAppend(listener: JournalAppendListener): () => void {
  appendListeners.add(listener);
  return () => { appendListeners.delete(listener); };
}

export class Journal {
  readonly path: string;
  /** The run this journal is — what an append listener is told. */
  private readonly slug: string;
  private readonly runId: string;
  /** The run's trace — derived, so a restart recomputes it rather than losing it. */
  readonly traceId: string;
  private seq = 0;
  /** The file's size as this instance last left it (or read it); `follow` compares against it. */
  private seen = 0;
  private overflowed = false;
  private readonly maxBytes: number;
  private readonly reserveBytes: number;

  /**
   * THE way to reach a run's journal: the one instance this process keeps for
   * that run's file, built on first use (#51). Nothing under `server/` calls
   * the constructor — `invariants.test.ts` scans for it — because a second
   * instance is a second counter. Tests still construct one directly, which is
   * how they stand in for a writer this process does not own.
   */
  static for(root: string, slug: string, id: string): Journal {
    const path = journalFile(root, slug, id);
    let journal = journals.get(path);
    if (!journal) {
      journal = new Journal(root, slug, id);
      journals.set(path, journal);
    }
    return journal;
  }

  constructor(root: string, slug: string, id: string, options: JournalOptions = {}) {
    this.path = journalFile(root, slug, id);
    this.slug = slug;
    this.runId = id;
    this.traceId = runTraceId(options.instanceId ?? INSTANCE.id, slug, id);
    this.maxBytes = options.maxBytes ?? MAX_BYTES;
    this.reserveBytes = Math.min(options.reserveBytes ?? RESERVE_BYTES, this.maxBytes);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      // Resuming an existing run continues its numbering rather than restarting
      // at 1, so the file stays readable as one sequence. Only the LAST line
      // carries the answer, so only the tail is read: a full parse here was
      // paid by every construction, including the two read paths that then
      // read the file again themselves. The size is taken FIRST: a line landing
      // between the two reads then looks like a foreign write, and `follow`
      // re-reads — the safe direction.
      this.seen = this.size();
      this.seq = this.lastSeq();
    } catch {
      /* a journal we cannot open costs the audit trail, never the run */
    }
  }

  /** The file's size in bytes; 0 when it does not exist yet. */
  private size(): number {
    try { return statSync(this.path).size; } catch { return 0; }
  }

  /**
   * Number on from the FILE, not from this instance, when somebody else moved it.
   *
   * The registry makes this instance the only writer of its file in this
   * process; it cannot make it the only writer there is — a test's own
   * `new Journal`, another console on the same state directory. So each append
   * compares the file's size with where this instance left it, and only when
   * they differ pays the tail read construction already pays: a file that grew
   * is continued from its last `seq`, and one that shrank or vanished (a
   * deleted run, a hand edit) is numbered from what is on disk now, exactly as
   * a fresh construction would number it.
   */
  private follow(size: number): void {
    if (size === this.seen) return;
    const onDisk = size === 0 ? 0 : this.lastSeq();
    if (size > this.seen) {
      this.seq = Math.max(this.seq, onDisk);
    } else {
      this.seq = onDisk;
      // A file that shrank is sized afresh: the overflow it had is gone with it.
      this.overflowed = false;
    }
    this.seen = size;
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

  /** Build the next entry, stamping the columns from the ambient span. */
  private entryFor(event: string, data?: Record<string, unknown>, phase?: number): JournalEntry {
    const span = current();
    // A writer in another trace contributes no span POINTERS — a span id from a
    // different trace is a reference nothing can follow. Its `actor` is carried
    // anyway: that is an identity ("who caused this line"), not a pointer.
    const crossing = span !== undefined && span.traceId !== this.traceId;
    const local = crossing ? undefined : span;
    return {
      seq: ++this.seq,
      time: new Date().toISOString(),
      event,
      v: 2,
      traceId: this.traceId,
      ...(crossing ? { viaTraceId: span!.traceId } : {}),
      ...(local === undefined ? {} : { spanId: local.spanId }),
      ...(local?.parentSpanId === undefined ? {} : { parentSpanId: local.parentSpanId }),
      ...(local?.attempt === undefined ? {} : { attempt: local.attempt }),
      ...(local?.sessionId === undefined ? {} : { sessionId: local.sessionId }),
      ...(span?.actor === undefined ? {} : { actor: span.actor }),
      ...(phase === undefined ? {} : { phase }),
      ...(data && Object.keys(data).length ? { data } : {}),
    };
  }

  private writeLine(entry: JournalEntry): void {
    const line = `${JSON.stringify(entry)}\n`;
    try {
      count('journal_appends_total', []);
      try {
        appendFileSync(this.path, line, 'utf8');
      } catch (error) {
        // The directory went with the run (a deleted run, a swept state dir).
        // A fresh construction re-made it; the one instance that now outlives
        // the directory must too, once, or it would never write again.
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
        mkdirSync(dirname(this.path), { recursive: true });
        appendFileSync(this.path, line, 'utf8');
      }
      this.seen += Buffer.byteLength(line, 'utf8');
    } catch (error) {
      log.warn('journal.append', { path: this.path, error });
    }
  }

  /**
   * Mark the overflow IN BAND the moment it happens.
   *
   * The marker is a journal line so the file explains its own ending, and it
   * names `lastSeq` so a reader can tell a dropped line from one that never
   * happened. Everything after it is dropped except the reserve.
   */
  private checkOverflow(size: number): void {
    if (this.overflowed) return;
    if (size <= this.maxBytes - this.reserveBytes) return;

    this.overflowed = true;
    count('journal_overflow_total', []);
    const marker = this.entryFor('journal.full', {
      bytes: size,
      // Read before `entryFor` takes the next number, so this is the last
      // ordinary line rather than the marker's own predecessor-by-accident.
      lastSeq: this.seq,
      reserveBytes: this.reserveBytes,
      note: 'run continues; only terminal run events are appended from here',
    });
    this.writeLine(marker);
    log.warn('journal.full', { path: this.path, bytes: size, lastSeq: marker.data?.lastSeq });
  }

  append(event: string, data?: Record<string, unknown>, phase?: number): JournalEntry {
    const size = this.size();
    this.follow(size);
    this.checkOverflow(size);
    const entry = this.entryFor(event, data, phase);
    // A dropped entry still consumes its `seq`: the gap in the file is the
    // honest record that something happened and was not written down.
    if (this.overflowed && !RESERVE_EVENTS.has(event)) return entry;
    this.writeLine(entry);
    for (const listener of appendListeners) {
      try { listener({ slug: this.slug, runId: this.runId, entry }); } catch { /* a listener never costs the run */ }
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
