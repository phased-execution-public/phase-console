/**
 * One browser, one event stream, and the runs whose partials it takes changed
 * while the stream stays open.
 *
 * A browser holds ONE `/events` stream however many tabs it has open — a
 * leader tab shares it with the rest — and a bare `/events` takes no
 * `run:stream` partial at all. So which runs' partials that one stream takes
 * has to change while its socket stays open, and when it cannot (the console
 * restarted, the socket died) the stream has to be reopened without losing an
 * event. The protocol under test:
 *
 *   - every stream is named in its `hello` (`connection`), and the name is in
 *     `sse.ts`'s registry exactly as long as the stream is open;
 *   - `POST /api/events/subscribe {connection, streams | stream}` sets the runs
 *     that one stream takes partials for, without a reopen;
 *   - a name the console does not hold is a 404 carrying `reopen: true`, and
 *     the reopened stream says what it already saw as `?last=<id>`, beside the
 *     runs it wants as `?stream=A,B`.
 *
 * Driven through the real `handleApi`, with a service holding only what the
 * two routes read, and the writer's own `flushStream` in place of a wait: a
 * test that sleeps through the coalescing tick is a test that races it.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleApi } from '../server/api/routes.ts';
import {
  SSE_MAX_RUN_ID_CHARS,
  SSE_MAX_STREAMS,
  createSseWriter,
  replayCursorOf,
  sseConnection,
  streamsOfParam,
  type SseSink,
  type SseWriter,
} from '../server/api/sse.ts';

const SUBSCRIBE = '/api/events/subscribe';

type Frame = { id: number | null; event: string; data: Record<string, unknown> };
type Hello = { generation: number; cursor: number; replayed: number; connection: string };

/** The frames written, parsed. Every write is one whole frame, the hello's included; the ping is none. */
function framesOf(chunks: readonly string[]): Frame[] {
  return chunks.flatMap((chunk) => {
    const m = /^(?:id: (\d+)\n)?event: ([^\n]+)\ndata: ([^\n]*)\n\n$/.exec(chunk);
    if (!m) return [];
    return [{ id: m[1] === undefined ? null : Number(m[1]), event: m[2]!, data: JSON.parse(m[3]!) as Record<string, unknown> }];
  });
}

/** Each partial as `[run, phase, id]` — what a transcript would paint, and the id it would resume from. */
const partials = (frames: readonly Frame[]) =>
  frames.filter((f) => f.event === 'run:stream').map((f) => [f.data.runId ?? null, f.data.phase, f.id]);

/** A socket that drains at once: which frames arrive is under test here, never the cap. */
function sink(): SseSink & { chunks: string[] } {
  const res = {
    chunks: [] as string[],
    writableLength: 0,
    writableEnded: false,
    destroyed: false,
    write(chunk: string): boolean { res.chunks.push(chunk); return true; },
    end(): void { res.writableEnded = true; },
  };
  return res;
}

type Listener = (event: string, data: unknown, id: number) => void;

/** What `/events` reads of the service — and `emit`, which feeds the log and the listeners as the real one does. */
function fakeService() {
  const listeners = new Set<Listener>();
  const history: { id: number; event: string; data: unknown }[] = [];
  let cursor = 0;
  return {
    generation: 3,
    get eventCursor(): number { return cursor; },
    eventsSince: (id: number) => history.filter((entry) => entry.id > id),
    onEvent(listener: Listener): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emit(event: string, data: unknown): number {
      const id = ++cursor;
      history.push({ id, event, data });
      for (const listener of listeners) listener(event, data, id);
      return id;
    },
    get listening(): number { return listeners.size; },
  };
}
type FakeService = ReturnType<typeof fakeService>;

type Stream = {
  status: number;
  headers: Record<string, unknown>;
  frames(event?: string): Frame[];
  hello(): Hello;
  /** The registered writer behind this stream — its `flushStream` is the tick, without the wait. */
  writer(): SseWriter;
  /** The request's own `close`, which is how a browser leaving looks to the handler. */
  close(): void;
};

/** `GET /events…` through the router, held open until `close()`. */
async function open(service: FakeService, query = '', headers: Record<string, string> = {}): Promise<Stream> {
  const closers: (() => void)[] = [];
  const chunks: string[] = [];
  let status = 0;
  let head: Record<string, unknown> = {};
  const req = {
    method: 'GET',
    url: `/events${query}`,
    headers: { host: '127.0.0.1:4130', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    on(event: string, fn: () => void) { if (event === 'close') closers.push(fn); return req; },
  };
  const res = {
    req,
    writableLength: 0,
    writableEnded: false,
    destroyed: false,
    writeHead(code: number, h?: Record<string, unknown>) { status = code; head = h ?? {}; return res; },
    write(chunk: string) { chunks.push(chunk); return true; },
    end() { res.writableEnded = true; },
    on(event: string, fn: () => void) { if (event === 'close') closers.push(fn); return res; },
  };
  await handleApi({ service } as never, req as never, res as never, new URL(`http://127.0.0.1:4130/events${query}`));
  const frames = (event?: string) => framesOf(chunks).filter((f) => event === undefined || f.event === event);
  const hello = (): Hello => {
    const [first] = frames('hello');
    assert.ok(first, `no hello frame: ${JSON.stringify(chunks)}`);
    return first.data as unknown as Hello;
  };
  return {
    status,
    headers: head,
    frames,
    hello,
    writer() {
      const writer = sseConnection(hello().connection);
      assert.ok(writer, 'the stream is registered under the name its hello carried');
      return writer;
    },
    close() { for (const fn of closers) fn(); },
  };
}

/** One JSON request through the router, as a page sends it — with the console header unless a test takes it away. */
async function call(
  service: FakeService,
  body: unknown,
  { method = 'POST', path = SUBSCRIBE, headers = { 'x-phase-console': '1' } }: {
    method?: string; path?: string; headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  const sent: Buffer[] = [];
  const req = {
    method,
    url: path,
    headers: { host: '127.0.0.1:4130', 'content-type': 'application/json', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    on() { return req; },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body), 'utf8'); },
  };
  const res = {
    req,
    writeHead(code: number) { status = code; return res; },
    setHeader() {},
    end(chunk?: Buffer | string) { if (chunk !== undefined) sent.push(Buffer.from(chunk)); },
    on() { return res; },
  };
  await handleApi({ service } as never, req as never, res as never, new URL(`http://127.0.0.1:4130${path}`));
  const text = Buffer.concat(sent).toString('utf8');
  return { status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

/* ------------------------------------------------------------------ *
 * The writer
 * ------------------------------------------------------------------ */

test('SUB-1: subscribeMany([A]) passes run A\'s partials and drops B\'s, subscribe(null) drops them all, and every other event passes whatever the set', () => {
  const res = sink();
  // A tick that never comes by itself: `flushStream` is the tick here.
  const writer = createSseWriter(res, { label: 'events', coalesceMs: 60_000 });
  try {
    writer.event('run:stream', { runId: 'A', phase: 1, text: 'unasked' }, 1);
    writer.flushStream();
    assert.deepEqual(partials(framesOf(res.chunks)), [], 'a stream that named no run takes no partial');

    writer.subscribeMany(['A']);
    assert.deepEqual(writer.streams, ['A']);
    writer.event('run:stream', { runId: 'A', phase: 1, text: 'a' }, 2);
    writer.event('run:stream', { runId: 'B', phase: 1, text: 'b' }, 3);
    writer.event('run:state', { runId: 'B', status: 'running' }, 4);
    assert.deepEqual(framesOf(res.chunks).map((f) => f.event), ['run:state'],
      'a coarse event is written at once and for any run; partials wait for the tick');
    writer.flushStream();
    assert.deepEqual(partials(framesOf(res.chunks)), [['A', 1, 2]], 'A\'s partial, and not B\'s');

    // One stream serves every tab, so it may take several runs at once.
    writer.subscribeMany(['A', 'B']);
    writer.event('run:stream', { runId: 'B', phase: 2, text: 'b2' }, 5);
    writer.event('run:stream', { runId: 'A', phase: 1, text: 'a2' }, 6);
    writer.event('run:stream', { runId: 'C', phase: 1, text: 'c' }, 7);
    writer.flushStream();
    assert.deepEqual(partials(framesOf(res.chunks)).slice(1), [['B', 2, 5], ['A', 1, 6]], 'A and B, never C');

    // A partial held for a run the stream lets go before the tick is not sent after it.
    writer.event('run:stream', { runId: 'B', phase: 2, text: 'b3' }, 8);
    writer.event('run:stream', { runId: 'A', phase: 1, text: 'a3' }, 9);
    writer.subscribeMany(['A']);
    writer.flushStream();
    assert.deepEqual(partials(framesOf(res.chunks)).slice(3), [['A', 1, 9]], 'B\'s held partial went with B');

    // A partial that names no run cannot be told apart: a stream taking any takes it.
    writer.event('run:stream', { phase: 4, text: 'unnamed' }, 10);
    writer.flushStream();
    assert.deepEqual(partials(framesOf(res.chunks)).slice(4), [[null, 4, 10]]);

    writer.subscribe(null);
    assert.deepEqual(writer.streams, []);
    const before = partials(framesOf(res.chunks)).length;
    writer.event('run:stream', { runId: 'A', phase: 1, text: 'after' }, 11);
    writer.event('run:stream', { phase: 4, text: 'unnamed' }, 12);
    writer.event('run:progress', { runId: 'A', phase: 1, spentUsd: 1 }, 13);
    writer.flushStream();
    assert.equal(partials(framesOf(res.chunks)).length, before, 'subscribe(null) takes no partial at all');
    assert.deepEqual(framesOf(res.chunks).filter((f) => f.event === 'run:progress').map((f) => f.id), [13],
      'while run:progress still arrives — it is how a stream without partials moves');

    // `subscribe` is the one-run spelling of the same set.
    writer.subscribe('A');
    assert.deepEqual(writer.streams, ['A']);
    writer.subscribeMany([]);
    assert.deepEqual(writer.streams, []);
  } finally {
    writer.close();
  }
});

test('SUB-2: ?stream= names one run or a comma-separated few; the replay cursor is the Last-Event-ID header, else ?last=, and only a whole number', () => {
  assert.deepEqual(streamsOfParam(null), []);
  assert.deepEqual(streamsOfParam(''), []);
  assert.deepEqual(streamsOfParam('A'), ['A']);
  assert.deepEqual(streamsOfParam('A,B, C,,A'), ['A', 'B', 'C'], 'blanks dropped, repeats once, a space after a comma forgiven');
  assert.deepEqual(streamsOfParam(`A,${'x'.repeat(SSE_MAX_RUN_ID_CHARS + 1)}`), ['A'], 'an id no run could have is dropped');
  const many = Array.from({ length: SSE_MAX_STREAMS + 8 }, (_, i) => `r${i}`);
  assert.deepEqual(streamsOfParam(many.join(',')), many.slice(0, SSE_MAX_STREAMS), 'cut to the cap, not refused');

  assert.equal(replayCursorOf(undefined, null), null, 'absent is no replay — Number(null) is 0, and 0 is the whole log');
  assert.equal(replayCursorOf(undefined, '12'), 12);
  assert.equal(replayCursorOf(undefined, '0'), 0, 'zero is a real answer: everything the log holds');
  assert.equal(replayCursorOf('15', '12'), 15, 'the header wins — it is the newer on the browser\'s own reconnect');
  assert.equal(replayCursorOf(['15'], null), 15);
  assert.equal(replayCursorOf(' ', '12'), 12, 'a blank header says nothing');
  assert.equal(replayCursorOf('abc', '12'), null, 'a header that is there is the one read, and a non-number replays nothing');
  for (const last of ['abc', '-1', '1.5', '1e3', '']) {
    assert.equal(replayCursorOf(undefined, last), null, `?last=${last} replays nothing`);
  }
});

/* ------------------------------------------------------------------ *
 * The stream's name
 * ------------------------------------------------------------------ */

test('SUB-3: /events sends a hello carrying a connection name, the name resolves in the registry while the stream is open, and closing the request removes it', async () => {
  const service = fakeService();
  service.emit('run:state', { runId: 'A', status: 'running' });
  const first = await open(service);
  const second = await open(service);
  const name = first.hello().connection;
  try {
    assert.equal(first.status, 200);
    assert.equal(first.headers['content-type'], 'text/event-stream');
    const hello = first.hello();
    assert.deepEqual(Object.keys(hello).sort(), ['connection', 'cursor', 'generation', 'replayed']);
    assert.equal(hello.generation, 3);
    assert.equal(hello.cursor, 1);
    assert.equal(hello.replayed, 0, 'no header and no ?last= is no replay, though the log holds an event');
    assert.equal(typeof name, 'string');
    assert.ok(name.length >= 16, `a name nobody guesses: ${name}`);
    assert.notEqual(second.hello().connection, name, 'every stream its own name');
    assert.equal(first.frames('hello')[0]!.id, null, 'the hello carries no id, so it never moves a browser\'s Last-Event-ID');
    assert.ok(sseConnection(name), 'the name resolves while the stream is open');
    assert.equal(service.listening, 2);
  } finally {
    first.close();
  }
  assert.equal(sseConnection(name), undefined, 'closing the request forgets the name');
  assert.equal(service.listening, 1, '…and retires its listener with it');
  assert.ok(sseConnection(second.hello().connection), 'the other stream is untouched');
  second.close();
  assert.equal(sseConnection(second.hello().connection), undefined);
});

/* ------------------------------------------------------------------ *
 * Subscribing, live and on a reopen
 * ------------------------------------------------------------------ */

test('SUB-4: after POST /api/events/subscribe {connection, stream: A} only run A\'s partials reach that stream — live, and in the replay a reopened ?stream=A&last=<n> asks for', async () => {
  const service = fakeService();
  const page = await open(service);
  const { connection } = page.hello();
  let seen = 0;
  try {
    service.emit('run:stream', { runId: 'A', phase: 1, text: 'before' });
    page.writer().flushStream();
    assert.deepEqual(partials(page.frames()), [], 'a bare /events takes no partial');

    const subscribed = await call(service, { connection, stream: 'A' });
    assert.equal(subscribed.status, 200, JSON.stringify(subscribed.body));
    assert.deepEqual(subscribed.body, { ok: true, connection, streams: ['A'] });

    const a1 = service.emit('run:stream', { runId: 'A', phase: 1, text: 'a1' });
    service.emit('run:stream', { runId: 'B', phase: 1, text: 'b1' });
    const state = service.emit('run:state', { runId: 'B', status: 'running' });
    page.writer().flushStream();
    assert.deepEqual(partials(page.frames()), [['A', 1, a1]], 'live: A\'s partial, never B\'s');
    assert.deepEqual(page.frames('run:state').map((f) => f.id), [state], 'and every coarse event, whichever run');

    // `streams` wins over `stream`, and the set moves on the same socket.
    const switched = await call(service, { connection, stream: 'A', streams: ['B', 'C'] });
    assert.equal(switched.status, 200);
    assert.deepEqual(switched.body.streams, ['B', 'C']);
    service.emit('run:stream', { runId: 'A', phase: 1, text: 'a2' });
    const b2 = service.emit('run:stream', { runId: 'B', phase: 1, text: 'b2' });
    page.writer().flushStream();
    assert.deepEqual(partials(page.frames()), [['A', 1, a1], ['B', 1, b2]]);

    // `stream: null`, `streams: []` and a body naming neither each take none.
    for (const body of [{ connection, stream: null }, { connection, streams: [] }, { connection }]) {
      await call(service, { connection, stream: 'A' });
      const none = await call(service, body);
      assert.equal(none.status, 200);
      assert.deepEqual(none.body.streams, [], JSON.stringify(body));
    }
    service.emit('run:stream', { runId: 'B', phase: 1, text: 'b3' });
    page.writer().flushStream();
    assert.equal(partials(page.frames()).length, 2, 'unsubscribed: nothing more');

    await call(service, { connection, stream: 'A' });
    seen = service.eventCursor;
  } finally {
    page.close();
  }

  // The socket died; while the page was away, both runs kept talking.
  const missedA1 = service.emit('run:stream', { runId: 'A', phase: 1, text: 'a-away-1' });
  service.emit('run:stream', { runId: 'B', phase: 1, text: 'b-away' });
  const phase = service.emit('run:phase', { runId: 'B', phase: 1 });
  const missedA2 = service.emit('run:stream', { runId: 'A', phase: 2, text: 'a-away-2' });

  // An EventSource the page opens itself cannot send Last-Event-ID; it says `?last=`.
  const reopened = await open(service, `?stream=A&last=${seen}`);
  try {
    const hello = reopened.hello();
    assert.equal(hello.replayed, 4, 'every event after the last one the page saw');
    assert.notEqual(hello.connection, connection, 'a reopened stream is greeted with a new name');
    assert.equal(sseConnection(connection), undefined, 'and the old one is gone');
    reopened.writer().flushStream();
    assert.deepEqual(reopened.frames('run:phase').map((f) => f.id), [phase], 'other events replay as they were');
    assert.deepEqual(partials(reopened.frames()), [['A', 1, missedA1], ['A', 2, missedA2]],
      'and among the partials, A\'s alone');
  } finally {
    reopened.close();
  }

  // Both runs on the reopen: a comma-separated ?stream= takes each.
  const both = await open(service, `?stream=A,B&last=${seen}`);
  try {
    both.writer().flushStream();
    assert.deepEqual(both.writer().streams, ['A', 'B']);
    assert.deepEqual(partials(both.frames()).map(([run]) => run).sort(), ['A', 'A', 'B']);
  } finally {
    both.close();
  }

  // The browser's own reconnect carries the header AND the stale ?last= in its URL: the header wins.
  const reconnect = await open(service, `?stream=A&last=${seen}`, { 'last-event-id': String(phase) });
  try {
    assert.equal(reconnect.hello().replayed, 1, 'only what came after the header\'s id');
    reconnect.writer().flushStream();
    assert.deepEqual(partials(reconnect.frames()), [['A', 2, missedA2]]);
  } finally {
    reconnect.close();
  }

  const nonsense = await open(service, '?stream=A&last=yesterday');
  try {
    assert.equal(nonsense.hello().replayed, 0, 'a ?last= that is not a number replays nothing');
  } finally {
    nonsense.close();
  }
});

/* ------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------ */

test('SUB-5: an unknown or closed connection is 404 with reopen: true, a body without a connection is 400, and a request failing guardCsrf is 403', async () => {
  const service = fakeService();

  const unknown = await call(service, { connection: 'no-such-stream', stream: 'A' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.reopen, true, 'the page is told to reopen, not that it erred');
  assert.equal(typeof unknown.body.error, 'string');

  const gone = await open(service);
  const goneName = gone.hello().connection;
  gone.close();
  const closed = await call(service, { connection: goneName, streams: ['A'] });
  assert.equal(closed.status, 404, 'a closed stream\'s name is nobody\'s');
  assert.equal(closed.body.reopen, true);

  const page = await open(service);
  const connection = page.hello().connection;
  try {
    for (const body of [{}, { stream: 'A' }, { connection: '', stream: 'A' }, { connection: 42, stream: 'A' }, 'a string', [connection]]) {
      const answer = await call(service, body);
      assert.equal(answer.status, 400, `${JSON.stringify(body)} → ${answer.status}`);
      assert.equal(typeof answer.body.error, 'string');
    }

    const tooMany = Array.from({ length: SSE_MAX_STREAMS + 1 }, (_, i) => `r${i}`);
    for (const body of [
      { connection, streams: 'A' },
      { connection, streams: [42] },
      { connection, streams: [''] },
      { connection, streams: ['x'.repeat(SSE_MAX_RUN_ID_CHARS + 1)] },
      { connection, streams: tooMany },
      { connection, stream: 7 },
    ]) {
      const answer = await call(service, body);
      assert.equal(answer.status, 400, `${JSON.stringify(body).slice(0, 80)} → ${answer.status}`);
    }
    assert.deepEqual(page.writer().streams, [], 'a refused list changed nothing');

    // The bounds themselves are honoured.
    const atCap = await call(service, { connection, streams: [...tooMany.slice(2), 'x'.repeat(SSE_MAX_RUN_ID_CHARS)] });
    assert.equal(atCap.status, 200);
    assert.equal((atCap.body.streams as string[]).length, SSE_MAX_STREAMS);
    await call(service, { connection, streams: [] });

    // The cross-site check: no console header, or another site's origin.
    const bare = await call(service, { connection, stream: 'A' }, { headers: {} });
    assert.equal(bare.status, 403);
    assert.equal(typeof bare.body.error, 'string');
    const crossSite = await call(service, { connection, stream: 'A' }, {
      headers: { 'x-phase-console': '1', origin: 'https://elsewhere.example' },
    });
    assert.equal(crossSite.status, 403);
    assert.deepEqual(page.writer().streams, [], 'a refused caller moved nothing');

    for (const [method, path] of [['GET', SUBSCRIBE], ['DELETE', SUBSCRIBE], ['POST', '/api/events'], ['POST', '/api/events/unsubscribe']] as const) {
      const answer = await call(service, { connection, stream: 'A' }, { method, path });
      assert.equal(answer.status, 405, `${method} ${path} → ${answer.status}`);
    }
    assert.deepEqual(page.writer().streams, []);
  } finally {
    page.close();
  }
});
