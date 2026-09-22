/**
 * The access log — one line per request, and the span every other line inherits.
 *
 * The console had no record of being ASKED anything. A page that rendered
 * wrong, a route that 500'd once, a phone that got a 421 — none of them left a
 * trace, so the only way to know what a browser had done was to reproduce it.
 *
 * Volume is the whole reason this is at `debug`: an open Now page polls, and a
 * console logging every poll at `info` would drown the run. Two exceptions
 * earn `info` on their own — a status at or past 400, and anything slower than
 * a second — because those are the requests somebody is going to come looking
 * for, and needing to have turned a channel on BEFORE the incident is the same
 * as having no record at all.
 *
 * The request is also a SPAN, which is what makes the line worth more than its
 * own fields: everything the handler does — every engine call, every git
 * command, every journal line it causes — carries the same id.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';

import { VIEWER_DIR } from '../server/config.ts';
import type { Entry } from '../server/log.ts';
import { sandbox, spawnConsole } from './spawn-console.ts';

/* The three shapes every spawned-console test needs. Local, like access.test.ts's. */

function http(
  port: number,
  path: string,
  opts: { headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: opts.headers ?? {} },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(port: number, tries = 100): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      await http(port, '/api/state');
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}

/** Every line the console wrote, newest last. */
function logLines(path: string): Entry[] {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return []; }
  return raw.trimEnd().split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Entry]; } catch { return []; }
  });
}

function requests(path: string): Entry[] {
  return logLines(path).filter((e) => e.event === 'http.request');
}

test('every request leaves one line, and it is a span the rest of the handler joins', async (t) => {
  const port = await freePort();
  const box = sandbox('access-span');
  const logFile = join(box.stateHome, 'access.ndjson');
  const { child } = spawnConsole(VIEWER_DIR, port, ['--log-file', logFile], {
    sandbox: box, withRoot: true, env: { PHASE_CONSOLE_DEBUG: 'http' },
  });
  t.after(() => { child.kill('SIGKILL'); box.cleanup(); });

  if (!await waitFor(port)) assert.fail('the console did not come up');

  const ok = await http(port, '/api/state');
  assert.equal(ok.status, 200);

  // The console writes synchronously, but the response is flushed before the
  // 'finish' handler that writes the line has necessarily run.
  await new Promise((r) => setTimeout(r, 300));

  const line = requests(logFile).find((e) => e.data?.path === '/api/state');
  assert.ok(line, `no http.request line for /api/state; saw ${JSON.stringify(requests(logFile).map((e) => e.data?.path))}`);

  assert.equal(line.level, 'debug', 'a healthy, fast request is debug — an open page polls');
  assert.equal(line.data?.method, 'GET');
  assert.equal(line.data?.status, 200);
  assert.equal(line.data?.route, '/api/state');
  assert.equal(typeof line.data?.ms, 'number');
  assert.equal(typeof line.data?.bytes, 'number');
  assert.match(String(line.data?.requestId), /^[0-9a-f]{16}$/);
  assert.equal(line.data?.agentClass, 'none',
    'a caller that sends no user-agent is `none` — not a guess at what it might be');

  // The span: the line carries ids, and so does anything the handler caused.
  assert.match(String(line.traceId), /^[0-9a-f]{32}$/);
  assert.equal(line.spanId, line.data?.requestId, 'the request id IS the span id — one identifier, not two');

  const sameSpan = logLines(logFile).filter((e) => e.spanId === line.spanId);
  assert.ok(sameSpan.length >= 1);
  for (const entry of sameSpan) assert.equal(entry.traceId, line.traceId);
});

test('a 404 is written at info, so nobody has to have turned a channel on first', async (t) => {
  const port = await freePort();
  const box = sandbox('access-404');
  const logFile = join(box.stateHome, 'access.ndjson');
  const { child } = spawnConsole(VIEWER_DIR, port, ['--log-file', logFile], { sandbox: box, withRoot: true });
  t.after(() => { child.kill('SIGKILL'); box.cleanup(); });

  if (!await waitFor(port)) assert.fail('the console did not come up');

  assert.equal((await http(port, '/api/no-such-route')).status, 404);
  await new Promise((r) => setTimeout(r, 300));

  // No PHASE_CONSOLE_DEBUG here on purpose: this line has to arrive anyway.
  const line = requests(logFile).find((e) => e.data?.status === 404);
  assert.ok(line, 'a 404 must be on record with no debug channel turned on');
  assert.equal(line.level, 'info');
  assert.equal(line.data?.path, '/api/no-such-route');
});

test('x-request-id is answered, and a caller\'s own id is honoured', async (t) => {
  const port = await freePort();
  const box = sandbox('access-reqid');
  const logFile = join(box.stateHome, 'access.ndjson');
  const { child } = spawnConsole(VIEWER_DIR, port, ['--log-file', logFile], {
    sandbox: box, withRoot: true, env: { PHASE_CONSOLE_DEBUG: 'http' },
  });
  t.after(() => { child.kill('SIGKILL'); box.cleanup(); });

  if (!await waitFor(port)) assert.fail('the console did not come up');

  const minted = await http(port, '/api/state');
  assert.match(String(minted.headers['x-request-id'] ?? ''), /^[0-9a-f]{16}$/,
    'a caller that sent none is told which id its request got');

  const mine = 'abcdef0123456789';
  const echoed = await http(port, '/api/state', { headers: { 'x-request-id': mine } });
  assert.equal(echoed.headers['x-request-id'], mine, "a caller's own id is what comes back");

  await new Promise((r) => setTimeout(r, 300));
  assert.ok(
    requests(logFile).some((e) => e.data?.requestId === mine),
    'and it is the id the line is filed under, so a client can find its own request',
  );
});

test('a stream says open and close ONCE each, because it has no status to report at the end', async (t) => {
  const port = await freePort();
  const box = sandbox('access-stream');
  const logFile = join(box.stateHome, 'access.ndjson');
  const { child } = spawnConsole(VIEWER_DIR, port, ['--log-file', logFile], {
    sandbox: box, withRoot: true, env: { PHASE_CONSOLE_DEBUG: 'http' },
  });
  t.after(() => { child.kill('SIGKILL'); box.cleanup(); });

  if (!await waitFor(port)) assert.fail('the console did not come up');

  // Opened and dropped by hand: an SSE stream never "finishes", so the close
  // has to come from the socket going away.
  await new Promise<void>((done) => {
    const socket = createConnection({ port, host: '127.0.0.1' }, () => {
      socket.write('GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      setTimeout(() => { socket.destroy(); done(); }, 400);
    });
    socket.on('error', () => done());
  });
  await new Promise((r) => setTimeout(r, 400));

  const streams = logLines(logFile).filter((e) => e.event === 'http.stream');
  const opens = streams.filter((e) => e.data?.phase === 'open' && e.data?.path === '/events');
  const closes = streams.filter((e) => e.data?.phase === 'close' && e.data?.path === '/events');

  assert.equal(opens.length, 1, `one open, saw ${opens.length}`);
  assert.equal(closes.length, 1, `one close, saw ${closes.length}`);
  assert.equal(opens[0].spanId, closes[0].spanId, 'both halves are the same span');
  assert.equal(typeof closes[0].data?.ms, 'number', 'and the close says how long it was held');
});
