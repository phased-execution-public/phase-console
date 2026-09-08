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
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { log } from '../log.ts';
import { runDir } from './state.ts';

export type TranscriptEntry = {
  seq: number;
  at: string;
  event: string;
  data: Record<string, unknown>;
};

/** Events worth replaying. Everything else is state the UI re-fetches anyway. */
const KEEP = new Set(['stream', 'phase', 'verify']);
/**
 * Past this, the file sheds its NOISE instead of everything.
 *
 * The old rule was a single 4 MB wall: cross it and the transcript stopped
 * dead, silently, with a `log.warn` nobody reads — and what filled those 4 MB
 * was overwhelmingly `partial`, whose every fragment is superseded by the
 * `text` block that follows it. So a long run lost its tool calls, its task
 * list and its results to make room for deltas that were already redundant.
 *
 * Now the cheap content goes first and the file keeps taking the expensive
 * content four times as far, and BOTH transitions leave a line in the
 * transcript saying what happened.
 */
const SHED_BYTES = 4 * 1024 * 1024;
/** The hard stop. Past here the live view still streams; nothing is replayed. */
const MAX_BYTES = 16 * 1024 * 1024;
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

export function transcriptFile(root: string, slug: string, id: string): string {
  return join(runDir(root, slug), `run-${id}.log.jsonl`);
}

export class Transcript {
  readonly path: string;
  private seq = 0;
  private full = false;
  private shedding = false;

  constructor(root: string, slug: string, id: string) {
    this.path = transcriptFile(root, slug, id);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      this.seq = this.read().at(-1)?.seq ?? 0;
    } catch {
      /* a transcript we cannot open costs the replay, never the run */
    }
  }

  /** Returns false when the event was not one worth keeping. */
  append(event: string, data: Record<string, unknown>): boolean {
    if (!KEEP.has(event) || this.full) return false;

    let size = 0;
    try {
      size = statSync(this.path).size;
    } catch {
      /* no file yet — the normal first append */
    }

    if (size > MAX_BYTES) {
      this.full = true;
      log.warn('transcript.full', { path: this.path, note: 'run continues; the live view still streams' });
      // Written past the gate that just closed, on purpose: this is the ONE
      // line that explains why the replay ends here, and it is worth more than
      // the byte it costs.
      this.write('stream', {
        kind: 'notice',
        text: 'transcript full — nothing further is replayed; the live view still streams and the journal has the full record',
      });
      return false;
    }

    if (size > SHED_BYTES) {
      if (!this.shedding) {
        this.shedding = true;
        this.write('stream', {
          kind: 'notice',
          text: 'transcript is large — streamed fragments, thinking and hook lines are no longer replayed',
        });
      }
      if (event === 'stream' && NOISE.has(String(data.kind))) return false;
    }

    return this.write(event, data);
  }

  /** The append itself, past every gate. Only `append` and its notices call it. */
  private write(event: string, data: Record<string, unknown>): boolean {
    const entry: TranscriptEntry = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      event,
      data: trim(data),
    };
    try {
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
      return true;
    } catch (error) {
      log.warn('transcript.append', { path: this.path, error });
      return false;
    }
  }

  read(limit?: number): TranscriptEntry[] {
    return readTranscript(this.path, limit);
  }
}

export function readTranscript(path: string, limit = 400): TranscriptEntry[] {
  let lines: string[];
  try {
    lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  if (limit && lines.length > limit) lines = lines.slice(-limit);
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line) as TranscriptEntry); } catch { /* half-written tail */ }
  }
  return entries;
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
