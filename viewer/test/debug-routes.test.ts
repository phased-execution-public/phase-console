/**
 * The `/api/debug/*` routes.
 *
 * Three things are worth a test here and the rest is covered by
 * `debug-index.test.ts`:
 *
 *   1. **The routes answer with no source directory open.** That is the whole
 *      reason this block sits above the "no source directory" wall, and it is
 *      the one property a later refactor could quietly take away by moving the
 *      block ten lines down.
 *   2. **The query really reaches the facade.** A filter parsed and then
 *      dropped looks exactly like a filter that matched nothing.
 *   3. **The follow tail is a well-formed event stream that stops.** A tail
 *      whose interval outlives its request is a leaked handle on the one page
 *      an operator leaves open for hours.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

type Captured = { status: number; body: unknown; headers: Record<string, unknown> };

function decode(out: Captured, chunk: unknown): void {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8');
  const encoding = String(out.headers['content-encoding'] ?? '');
  const plain = encoding === 'br' ? brotliDecompressSync(bytes)
    : encoding === 'gzip' ? gunzipSync(bytes) : bytes;
  const asText = plain.toString('utf8');
  try { out.body = JSON.parse(asText); } catch { out.body = asText; }
}

/**
 * `sendBody` reads `res.req` to negotiate an encoding, so a fake without it
 * takes a silently different path from the server's — the same trap
 * `routes.test.ts` documents at its own `call`.
 */
async function call(service: unknown, path: string): Promise<Captured> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out: Captured = { status: 0, body: null, headers: {} };
  const req = {
    method: 'GET',
    headers: { 'x-phase-console': '1' } as Record<string, string>,
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { /* GET has no body */ },
  };
  const res = {
    req,
    writeHead(status: number, headers?: Record<string, unknown>) {
      out.status = status;
      out.headers = headers ?? {};
      return this;
    },
    end(chunk: unknown) { decode(out, chunk); },
    on() { return this; },
  };
  await handleApi({ service } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  return out;
}

/** The narrowest Service the debug block touches. No source directory. */
function fakeService(over: Record<string, unknown> = {}) {
  return {
    root: null,
    store: { list: () => [] },
    generation: 3,
    flags: {
      allowWrites: false, allowRun: false, allowTerminal: false,
      allowAgent: false, allowAccounts: false, allowMcp: false, allowWebhooks: false,
    },
    notifications: {
      list: () => ({ items: [], total: 0, unread: 0, more: false }),
      unread: () => 0,
    },
    environment: { issues: [] as { kind: string; detail: string; fix: string }[] },
    watchClock: { snapshot: () => ({ passes: 2, asked: ['gh:o/r#run/1'], open: true }) },
    metrics: async () => '# TYPE phase_console_plans gauge\nphase_console_plans{status="active"} 1\n',
    state: () => ({ supervisor: null, watcher: { ok: true }, port: 4123 }),
    ...over,
  };
}

/* ------------------------------------------------------------------ *
 * Above the wall
 * ------------------------------------------------------------------ */

test('GET /api/debug/index answers with no source directory open', async () => {
  // The console somebody debugs is very often the one that failed to open a
  // directory. A 409 here would hide the log that says why.
  const out = await call(fakeService(), '/api/debug/index');
  assert.equal(out.status, 200);
  const body = out.body as { entries: unknown[]; sources: { source: string; available: boolean }[] };
  assert.ok(Array.isArray(body.entries));
  assert.equal(body.sources.length, 7, 'every source is accounted for, present or not');
  assert.equal(body.sources.find((s) => s.source === 'journal')?.available, false);
  assert.equal(body.sources.find((s) => s.source === 'health')?.available, true);
});

test('GET /api/debug/bundle answers with no source directory open, and says so', async () => {
  const out = await call(fakeService(), '/api/debug/bundle');
  assert.equal(out.status, 200);
  const body = out.body as { schema: string; version: number; root: string | null; notes: string[] };
  assert.equal(body.schema, 'phase-console/debug-bundle');
  assert.equal(body.version, 1);
  assert.equal(body.root, null);
  assert.ok(body.notes.some((n) => /No source directory is open/.test(n)), body.notes.join(' | '));
});

/* ------------------------------------------------------------------ *
 * The query reaches the facade
 * ------------------------------------------------------------------ */

test('a source filter on the URL really narrows the answer', async () => {
  const service = fakeService({
    environment: {
      issues: [{ kind: 'path-missing-dir', detail: 'PATH names a directory that is gone', fix: 'Reinstall.' }],
    },
  });

  const all = await call(service, '/api/debug/index');
  assert.ok((all.body as { entries: unknown[] }).entries.length >= 1, 'the health issue is indexed');

  // Ask for a source the fixture has nothing under: the answer must be empty
  // rather than "everything", which is what a dropped filter would look like.
  const narrowed = await call(service, '/api/debug/index?source=delivery');
  assert.deepEqual((narrowed.body as { entries: unknown[] }).entries, []);
});

test('GET /api/debug/runs refuses without a slug rather than guessing one', async () => {
  const out = await call(fakeService(), '/api/debug/runs');
  assert.equal(out.status, 400);
  assert.match(String((out.body as { error: string }).error), /slug/);

  const ok = await call(fakeService(), '/api/debug/runs?slug=demo');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { slug: 'demo', runs: [] });
});

test('?download=1 makes the bundle a file, and the default does not', async () => {
  const plain = await call(fakeService(), '/api/debug/bundle');
  assert.equal(plain.headers['content-disposition'], undefined,
    'curl /api/debug/bundle must print, not save');

  const saved = await call(fakeService(), '/api/debug/bundle?download=1');
  assert.match(String(saved.headers['content-disposition']), /^attachment; filename="phase-console-debug-.*\.json"$/);
  assert.equal(saved.headers['cache-control'], 'no-store');
});

/* ------------------------------------------------------------------ *
 * The follow tail
 * ------------------------------------------------------------------ */

test('GET /api/debug/tail opens an event stream, greets, and stops on close', async () => {
  const { handleApi } = await import('../server/api/routes.ts');
  const written: string[] = [];
  let headers: Record<string, unknown> = {};
  const closers: (() => void)[] = [];

  const req = {
    method: 'GET',
    headers: {} as Record<string, string>,
    on(event: string, fn: () => void) { if (event === 'close') closers.push(fn); return this; },
    [Symbol.asyncIterator]: async function* () { /* GET has no body */ },
  };
  const res = {
    req,
    writableEnded: false,
    destroyed: false,
    writeHead(_status: number, h?: Record<string, unknown>) { headers = h ?? {}; return this; },
    write(chunk: string) { written.push(chunk); return true; },
    end() { (res as { writableEnded: boolean }).writableEnded = true; },
    on(event: string, fn: () => void) { if (event === 'close') closers.push(fn); return this; },
  };

  await handleApi(
    { service: fakeService() } as never, req as never, res as never,
    new URL('http://127.0.0.1/api/debug/tail?source=console'),
  );

  assert.equal(headers['content-type'], 'text/event-stream');
  assert.equal(headers['cache-control'], 'no-cache');
  // `x-accel-buffering: no` is what keeps a proxy from holding the stream —
  // the same header `/events` sends, and the reason a tail works over --remote.
  assert.equal(headers['x-accel-buffering'], 'no');

  const hello = written.find((frame) => frame.startsWith('event: hello'));
  assert.ok(hello, `no handshake frame: ${JSON.stringify(written)}`);
  const payload = JSON.parse(hello!.split('data: ')[1].trim()) as { cursor: string; intervalMs: number };
  assert.equal(typeof payload.cursor, 'string');
  assert.ok(payload.intervalMs > 0);

  // The request closing must end the response and clear the interval. If it
  // did not, this handle would keep the test runner's loop alive — which is
  // exactly how a leaked timer looks in production, only slower.
  assert.ok(closers.length > 0, 'nothing was registered to stop the tail');
  for (const close of closers) close();
  assert.equal(res.writableEnded, true, 'the tail did not end when its request closed');
});


/* ------------------------------------------------------------------ *
 * QA round 1
 * ------------------------------------------------------------------ */

test('M9 — a slug that is not a slug is refused, on every endpoint that takes one', async () => {
  for (const path of [
    '/api/debug/index?slug=..%2F..%2F..%2Fevil',
    '/api/debug/runs?slug=..%2F..%2F..%2Fevil',
    '/api/debug/bundle?slug=..%2F..%2F..%2Fevil',
  ]) {
    const out = await call(fakeService(), path);
    assert.equal(out.status, 400, path);
    assert.match(String((out.body as { error: string }).error), /slug/, path);
  }
  // A real slug is untouched.
  const ok = await call(fakeService(), '/api/debug/runs?slug=console-parallel-repaint');
  assert.equal(ok.status, 200);
});

test('M3 — a tail whose client is already gone clears its interval', async () => {
  // `stop()` is reachable from the handshake `send()`, which used to run
  // BEFORE the interval existed: `closed` was set with `timer` undefined, the
  // next line created one, and every later handler short-circuited on
  // `closed`. Measured 1 created / 0 cleared, retaining `res`, `req` and the
  // facade and firing every 2 s for the life of the process.
  //
  // Counted, not inferred: the previous guard asserted `res.writableEnded`,
  // which is true on both the correct and the broken behaviour — the timer is
  // `unref()`'d, so a leak cannot even hold the test runner open.
  const { handleApi } = await import('../server/api/routes.ts');
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  let created = 0;
  let cleared = 0;
  (globalThis as { setInterval: typeof setInterval }).setInterval = ((...args: Parameters<typeof setInterval>) => {
    created += 1;
    return realSet(...args);
  }) as typeof setInterval;
  (globalThis as { clearInterval: typeof clearInterval }).clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
    cleared += 1;
    return realClear(handle);
  }) as typeof clearInterval;

  try {
    const req = {
      method: 'GET',
      headers: {} as Record<string, string>,
      on() { return this; },
      [Symbol.asyncIterator]: async function* () { /* GET has no body */ },
    };
    // Destroyed before the handler runs: the first `send()` calls `stop()`.
    const res = {
      req,
      writableEnded: false,
      destroyed: true,
      writeHead() { return this; },
      write() { return true; },
      end() { (res as { writableEnded: boolean }).writableEnded = true; },
      on() { return this; },
    };
    await handleApi(
      { service: fakeService() } as never, req as never, res as never,
      new URL('http://127.0.0.1/api/debug/tail'),
    );
    assert.equal(created, cleared, `created ${created} intervals and cleared ${cleared}`);
  } finally {
    (globalThis as { setInterval: typeof setInterval }).setInterval = realSet;
    (globalThis as { clearInterval: typeof clearInterval }).clearInterval = realClear;
  }
});

test('M6 — a reconnecting tail resumes from Last-Event-ID', async () => {
  // Without this the server re-seeded from the current top of the log, so
  // every row written while a laptop slept was skipped with no marker and the
  // status went straight back to "live".
  const { handleApi } = await import('../server/api/routes.ts');
  const written: string[] = [];
  const req = {
    method: 'GET',
    // An id far in the past: the log's top is newer, so this stream IS behind.
    headers: { 'last-event-id': '2020-01-01T00:00:00.000Z' } as Record<string, string>,
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { /* GET has no body */ },
  };
  const res = {
    req,
    writableEnded: false,
    destroyed: false,
    writeHead() { return this; },
    write(chunk: string) { written.push(chunk); return true; },
    end() { (res as { writableEnded: boolean }).writableEnded = true; },
    on() { return this; },
  };
  // A source with a ROW in it, so the log has a top to be behind: `behind`
  // means "the log has moved past your cursor", and an empty log has not.
  const service = fakeService({
    environment: {
      issues: [{ kind: 'path-missing-dir', detail: 'PATH names a directory that is gone', fix: 'Reinstall.' }],
    },
  });
  await handleApi(
    { service } as never, req as never, res as never,
    new URL('http://127.0.0.1/api/debug/tail?source=health'),
  );

  const hello = written.find((frame) => frame.startsWith('event: hello'));
  const payload = JSON.parse(hello!.split('data: ')[1].trim()) as { cursor: string; resumed: boolean };
  assert.equal(payload.cursor, '2020-01-01T00:00:00.000Z', 'the resume point is the client’s, not the top');
  assert.equal(payload.resumed, true);
  // `behind` used to be computed here and it was FALSE: `pass()` reads
  // `since: cursor`, so a reconnect bridges its own gap. The only real loss is
  // a gap wider than one pass's row cap, which this handshake cannot know —
  // so the claim moved to the frame, where `capped` measures it.
  assert.equal((payload as { behind?: boolean }).behind, undefined);
});

test('M6 — a fresh tail is not a resume', async () => {
  const { handleApi } = await import('../server/api/routes.ts');
  const written: string[] = [];
  const req = {
    method: 'GET',
    headers: {} as Record<string, string>,
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { /* GET has no body */ },
  };
  const res = {
    req,
    writableEnded: false,
    destroyed: false,
    writeHead() { return this; },
    write(chunk: string) { written.push(chunk); return true; },
    end() { (res as { writableEnded: boolean }).writableEnded = true; },
    on() { return this; },
  };
  await handleApi(
    { service: fakeService() } as never, req as never, res as never,
    new URL('http://127.0.0.1/api/debug/tail'),
  );
  const hello = written.find((frame) => frame.startsWith('event: hello'));
  const payload = JSON.parse(hello!.split('data: ')[1].trim()) as { resumed: boolean };
  assert.equal(payload.resumed, false);
});


/* ------------------------------------------------------------------ *
 * QA round 2
 * ------------------------------------------------------------------ */

test('H-A — a run id that is not a run id is refused', async () => {
  // The twin of the slug guard, and the one that also wrote: `Journal`'s
  // constructor mkdirSyncs its parent, so a GET created a directory outside
  // the state directory.
  for (const path of [
    '/api/debug/index?run=..%2F..%2F..%2Fevil',
    '/api/debug/tail?run=..%2F..%2F..%2Fevil',
  ]) {
    const out = await call(fakeService(), path);
    assert.equal(out.status, 400, path);
    assert.match(String((out.body as { error: string }).error), /run/, path);
  }
  const ok = await call(fakeService(), '/api/debug/index?run=aaaa1111');
  assert.equal(ok.status, 200);
});

test('M-D — every entries frame carries an id, so a browser can resume itself', async () => {
  // Deleting `id: ${cursor}` — the whole browser-resume path — left the suite
  // green, because nothing asserted the frame's shape.
  const { handleApi } = await import('../server/api/routes.ts');
  const written: string[] = [];
  const service = fakeService({
    environment: {
      issues: [{ kind: 'path-missing-dir', detail: 'gone', fix: 'Reinstall.' }],
    },
  });
  const req = {
    method: 'GET',
    headers: {} as Record<string, string>,
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { /* GET has no body */ },
  };
  const res = {
    req,
    writableEnded: false,
    destroyed: false,
    writeHead() { return this; },
    write(chunk: string) { written.push(chunk); return true; },
    end() { (res as { writableEnded: boolean }).writableEnded = true; },
    on() { return this; },
  };
  // A cursor in the past, so the first pass has something to send.
  await handleApi(
    { service } as never, req as never, res as never,
    new URL('http://127.0.0.1/api/debug/tail?source=health&after=2020-01-01T00:00:00.000Z'),
  );
  // Drive one pass rather than waiting for the timer.
  await new Promise((resolve) => setTimeout(resolve, 2200));

  const frame = written.find((chunk) => chunk.includes('event: entries'));
  assert.ok(frame, `no entries frame: ${JSON.stringify(written)}`);
  assert.match(frame!, /^id: \S+\nevent: entries\n/, 'the frame must carry an id the browser can resend');
  const payload = JSON.parse(frame!.split('data: ')[1].trim()) as
    { entries: { at: string }[]; capped: boolean };
  assert.ok(payload.entries.length >= 1);
  assert.equal(payload.capped, false, 'a frame that did not fill its cap lost nothing');
});

test('M-D — an undated row reaches the tail rather than being ordered out of it', async () => {
  // `entry.at && entry.at > cursor` made a row with no time invisible to
  // follow mode forever — and the row class with no time is
  // `outcome.unreadable`, the one `readOutcomes` exists to surface. The first
  // version of this test called `Debug.index()` on empty deps and asserted an
  // array, which the filter could not fail (round 3): this one drives the
  // real `/api/debug/tail` over a real inbox holding a file the console will
  // not act on, and asserts that row is in the frame.
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { handleApi } = await import('../server/api/routes.ts');
  const { outcomeInboxDir } = await import('../server/runner/outcome.ts');

  const projectRoot = mkdtempSync(join(tmpdir(), 'debug-undated-'));
  try {
    const inbox = outcomeInboxDir(projectRoot, 'demo');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, 'phase-01.json'), '{ this is not an outcome');

    const written: string[] = [];
    const req = {
      method: 'GET',
      headers: {} as Record<string, string>,
      on() { return this; },
      [Symbol.asyncIterator]: async function* () { /* GET has no body */ },
    };
    const res = {
      req,
      writableEnded: false,
      destroyed: false,
      writeHead() { return this; },
      write(chunk: string) { written.push(chunk); return true; },
      end() { (res as { writableEnded: boolean }).writableEnded = true; },
      on() { return this; },
    };
    await handleApi(
      { service: fakeService({ root: { path: projectRoot } }) } as never, req as never, res as never,
      new URL('http://127.0.0.1/api/debug/tail?source=outcome&slug=demo&after=2020-01-01T00:00:00.000Z'),
    );
    // Drive one pass rather than waiting for the timer.
    await new Promise((resolve) => setTimeout(resolve, 2200));

    const frame = written.find((chunk) => chunk.includes('event: entries'));
    assert.ok(frame, `no entries frame: ${JSON.stringify(written)}`);
    const payload = JSON.parse(frame!.split('data: ')[1].trim()) as { entries: { at: string; event: string }[] };
    assert.ok(
      payload.entries.some((entry) => entry.event === 'outcome.unreadable' && entry.at === ''),
      `the undated row must ride the frame: ${JSON.stringify(payload.entries)}`,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
