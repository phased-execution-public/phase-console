/**
 * One writer for every server-sent-event stream this console serves.
 *
 * `res.write()` returns false when the kernel buffer is full and node has taken
 * the bytes into memory on your behalf. Both stream handlers ignored that
 * return, which is fine for a browser on the same machine and unbounded for
 * anything else: a phone on a sleeping tailnet, a laptop that shut its lid, a
 * `curl` somebody Ctrl-Z'd. Every serialized event then lives in the write
 * buffer for as long as the socket does. That is the retention the console's
 * measured out-of-memory exits were made of — the last collections before each
 * one freed tens of megabytes out of four gigabytes, which is a buffer nobody
 * drains rather than a process allocating hard.
 *
 * So this writer does two things the handlers used to do differently or not at
 * all:
 *
 *   **It caps.** Past `SSE_MAX_BUFFERED_BYTES` of `writableLength` the client
 *   is retired: said once as `sse.slow-client`, its listener removed through
 *   `onDrop`, its socket let go. Nothing is lost by this — a browser reconnects
 *   with `Last-Event-ID` and the service replays from its event log, which is
 *   the mechanism SSE has for exactly this and which a held-open socket full of
 *   stale frames was preventing from ever running.
 *
 *   **It routes partials by request.** A `run:stream` frame is a fragment of
 *   one session's output. Two views render it; every other listener was paying
 *   for it in buffer. A listener opts in per run — `/events?stream=` names one
 *   run or a comma-separated few, and `POST /api/events/subscribe` changes the
 *   set on a stream already open — gets those partials coalesced to one frame
 *   per lane per tick, and everybody else moves on `run:progress` instead.
 *
 * Deliberately not a stream: the handlers own their own headers, ping and
 * teardown, and a writer that also owned those would have to know which of the
 * two it was.
 */

import { randomUUID } from 'node:crypto';

import { isClientDisconnect, log } from '../log.ts';

/**
 * How much a single client may have outstanding before it stops being one.
 *
 * Four mebibytes is about a minute of two lanes streaming flat out, so a client
 * that trips it is not slow — it is gone. Small enough that a hundred of them
 * cannot reach the heap limit together; large enough that a phone changing
 * towers rides through it.
 */
export const SSE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * The floor on how often a subscriber is sent the partials of one lane.
 *
 * A session talking produces frames faster than any surface can paint them, so
 * the choice is not between all of them and some of them: it is between
 * buffering the difference and dropping it. A quarter of a second reads as live
 * and turns a thousand frames a minute per lane into four.
 */
export const SSE_STREAM_COALESCE_MS = 250;

/**
 * How many runs one stream may take partials for, and how long a run id it
 * names may be.
 *
 * One browser's stream serves every tab it has open, so a few runs at once is
 * normal; thirty-two is more transcripts than any screen paints together. The
 * length is there only so a list no page would send is never held: a run id is
 * a dozen characters.
 */
export const SSE_MAX_STREAMS = 32;
export const SSE_MAX_RUN_ID_CHARS = 200;

/** The event whose frames are partial, and therefore opt-in. */
const STREAM_EVENT = 'run:stream';

/**
 * What the writer needs of a `ServerResponse`.
 *
 * Narrow on purpose: it is the whole reason a test can hold a socket full
 * without waiting for one to fill.
 */
export type SseSink = {
  write(chunk: string): boolean;
  end(): void;
  destroy?(): void;
  readonly writableLength: number;
  readonly writableEnded: boolean;
  readonly destroyed: boolean;
};

export type SseWriterOptions = {
  /** Which stream this is, for the log line. */
  label: string;
  /** The cap. Only a test has a reason to move it. */
  maxBufferedBytes?: number;
  /** Retire this client's listener — called once, when the cap is passed. */
  onDrop?: (reason: 'slow-client') => void;
  /** How long partials are held for a subscriber. */
  coalesceMs?: number;
};

export type SseWriter = {
  /** A whole pre-formatted chunk — the ping, the hello, the debug tail's rows. */
  send(chunk: string): void;
  /** One named event, routed: partials by subscription, everything else at once. */
  event(name: string, data: unknown, id?: number | string): void;
  /** Take this client's partials for one run. `null` takes none. */
  subscribe(runId: string | null): void;
  /**
   * Take this client's partials for exactly these runs. One browser's stream
   * serves every tab it has open, so it may want several at once. Empty takes
   * none.
   */
  subscribeMany(runIds: readonly string[]): void;
  /** The runs whose partials this client takes now, in the order they were named. */
  readonly streams: readonly string[];
  /** Send whatever partials are held, now. The tick calls this; a test calls it too. */
  flushStream(): void;
  /** Stop writing and let the socket go. Idempotent. */
  close(): void;
  readonly dropped: boolean;
  readonly bufferedBytes: number;
};

function frame(name: string, data: unknown, id?: number | string): string {
  const head = id === undefined ? '' : `id: ${id}\n`;
  return `${head}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The lane a partial belongs to, when it names one. */
function laneKey(data: unknown): string {
  if (!data || typeof data !== 'object') return '-';
  const record = data as Record<string, unknown>;
  const run = typeof record.runId === 'string' ? record.runId : '-';
  const phase = typeof record.phase === 'number' ? record.phase : '-';
  return `${run}:${phase}`;
}

function runOf(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const run = (data as Record<string, unknown>).runId;
  return typeof run === 'string' ? run : null;
}

export function createSseWriter(res: SseSink, opts: SseWriterOptions): SseWriter {
  const cap = opts.maxBufferedBytes ?? SSE_MAX_BUFFERED_BYTES;
  const coalesceMs = opts.coalesceMs ?? SSE_STREAM_COALESCE_MS;

  let dropped = false;
  let closed = false;
  /** The runs whose partials this client takes. Empty takes none. */
  let streams: ReadonlySet<string> = new Set();
  /** The newest partial per lane, waiting for the tick. Insertion order is lane order. */
  const held = new Map<string, { data: unknown; id?: number | string }>();
  let tick: NodeJS.Timeout | null = null;

  const disarm = (): void => {
    if (!tick) return;
    clearTimeout(tick);
    tick = null;
  };

  const retire = (reason: 'slow-client'): void => {
    if (dropped) return;
    dropped = true;
    disarm();
    held.clear();
    log.warn('sse.slow-client', {
      stream: opts.label,
      bufferedBytes: res.writableLength,
      cap,
    });
    try { opts.onDrop?.(reason); } catch { /* the listener is going either way */ }
    // Let the socket go rather than leaving it half-open holding what it never
    // read: the browser's reconnect is the recovery, and it cannot begin while
    // this one is nominally still alive.
    try { res.destroy ? res.destroy() : res.end(); } catch { /* already gone */ }
  };

  const writeRaw = (chunk: string): void => {
    if (dropped || closed || res.writableEnded || res.destroyed) return;
    try {
      res.write(chunk);
    } catch (error) {
      if (!isClientDisconnect(error)) log.warn('sse.write', { stream: opts.label, error });
      close();
      return;
    }
    // AFTER the write, not before: the question is whether this client is
    // holding more than it may, and the chunk just handed over is part of it.
    if (res.writableLength > cap) retire('slow-client');
  };

  const flushStream = (): void => {
    disarm();
    if (!held.size) return;
    const pending = [...held.entries()];
    held.clear();
    for (const [, entry] of pending) writeRaw(frame(STREAM_EVENT, entry.data, entry.id));
  };

  const arm = (): void => {
    if (tick || dropped || closed) return;
    tick = setTimeout(flushStream, coalesceMs);
    tick.unref?.();
  };

  function close(): void {
    if (closed) return;
    closed = true;
    disarm();
    held.clear();
  }

  /**
   * Does this client take a partial of this run? One that names no run cannot
   * be told apart, so it goes to every client taking any.
   */
  const wants = (run: string | null): boolean => streams.size > 0 && (run === null || streams.has(run));

  const follow = (runIds: readonly string[]): void => {
    streams = new Set(runIds.filter((id) => typeof id === 'string' && id !== ''));
    // A partial already held for a run this client has just let go must not
    // reach it at the next tick: the page that asked has moved on, and text it
    // no longer renders is buffer it will not read.
    for (const [lane, entry] of held) if (!wants(runOf(entry.data))) held.delete(lane);
    if (!held.size) disarm();
  };

  return {
    send(chunk: string): void {
      writeRaw(chunk);
    },
    event(name: string, data: unknown, id?: number | string): void {
      if (dropped || closed) return;
      if (name !== STREAM_EVENT) { writeRaw(frame(name, data, id)); return; }
      // A partial. Only for the runs this client asked for, and only the newest
      // per lane: a surface rendering a transcript wants the current text, and
      // the ones it skipped were superseded before they could be painted.
      if (!wants(runOf(data))) return;
      held.set(laneKey(data), { data, id });
      arm();
    },
    subscribe(runId: string | null): void {
      follow(runId ? [runId] : []);
    },
    subscribeMany(runIds: readonly string[]): void {
      follow(runIds);
    },
    get streams(): readonly string[] { return [...streams]; },
    flushStream,
    close,
    get dropped(): boolean { return dropped; },
    get bufferedBytes(): number { return res.writableLength; },
  };
}

/**
 * The open `/events` streams, by the name each was greeted with.
 *
 * A browser holds ONE event stream however many tabs it has open — a leader
 * tab shares it with the rest — so the runs whose partials it wants change
 * while the socket stays open. Reopening to say so would cost a reconnect and
 * a replay per change. Instead the stream's `hello` carries a name, and
 * `POST /api/events/subscribe` finds the writer here by it. A name is held
 * exactly as long as its stream is open — the handler's teardown drops it with
 * the listener — so a closed stream's name, or one another process minted, is
 * not found, and the page's answer to that is to reopen with `?stream=` and
 * `?last=`, which loses nothing.
 *
 * The name is a random UUID that only the stream's own first frame carries.
 * Knowing one lets a caller choose which partials that one socket is sent and
 * nothing more, and the route that takes it is behind the cross-site check.
 */
const connections = new Map<string, SseWriter>();

/** Name an open stream's writer, so a later request can find it. */
export function registerSseConnection(writer: SseWriter): string {
  const id = randomUUID();
  connections.set(id, writer);
  return id;
}

/** The writer of the open stream with this name, or undefined — closed, or never this process's. */
export function sseConnection(id: string): SseWriter | undefined {
  return connections.get(id);
}

/** Forget a stream's name. The handler's teardown calls it; a second call is a no-op. */
export function dropSseConnection(id: string): void {
  connections.delete(id);
}

/**
 * `/events?stream=` as the runs it names: one id, or a comma-separated few.
 *
 * Lenient where the subscribe route is strict, because the reader differs: an
 * `EventSource` cannot read an error body and does not retry a refused open,
 * so a list it got wrong is cut to what can be honoured — blanks and ids longer
 * than any run's dropped, the first `SSE_MAX_STREAMS` kept — rather than
 * refused with a status no page would ever see.
 */
export function streamsOfParam(value: string | null): string[] {
  if (!value) return [];
  const ids = value.split(',').map((id) => id.trim()).filter((id) => id !== '' && id.length <= SSE_MAX_RUN_ID_CHARS);
  return [...new Set(ids)].slice(0, SSE_MAX_STREAMS);
}

/**
 * The id a stream's replay starts after, or null for no replay.
 *
 * `Last-Event-ID` is what a browser resends when its `EventSource` reconnects
 * by itself. A page that reopens its stream on purpose cannot set that header,
 * so it names the last id it saw as `?last=` instead. When both arrive the
 * header wins: `?last=` rides the URL of every reconnect that EventSource later
 * makes on its own, by which time the header is the newer of the two.
 *
 * Absence is asked before any number is read — `Number(null)` is 0, and 0
 * replays the whole log to a page that asked for none — and anything but a
 * whole number replays nothing.
 */
export function replayCursorOf(header: string | string[] | undefined, last: string | null): number | null {
  const raw = (Array.isArray(header) ? header[0] : header)?.trim() || last?.trim();
  return raw && /^\d+$/.test(raw) ? Number(raw) : null;
}
