/**
 * What the console serves — built or not.
 *
 * The client is built output (`client/dist`, gitignored), so a fresh clone
 * answers requests before any build exists, and a machine mid-build answers
 * them while `dist/` is empty. Two promises must hold in BOTH states, and this
 * file spawns the real server to hold them:
 *
 *   1. `GET /` is 200 with a real HTML document — never a hang, never a 404.
 *      Built, that is the app shell; not built, a page naming the two commands.
 *      (`access.test.ts` asserts 200 on `/` too, but only ever sees the state
 *      this machine happens to be in; this file is why both states pass.)
 *
 *   2. `GET /sw.js` is 200 with a PUSH-CAPABLE service worker. A registered
 *      worker whose script URL 404s on update is UNREGISTERED by the browser,
 *      and the push subscriptions bound to it die silently with it — and two
 *      real devices are subscribed to this exact URL. Built, the precaching
 *      worker answers; not built, `server/fallback-sw.js` (the retired legacy
 *      worker, verbatim) does. Either way the push listener must be present —
 *      the built output backtick-quotes its strings, so the pattern accepts
 *      any quote.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { request } from 'node:http';

import { VIEWER_DIR } from '../server/config.ts';
import { spawnConsole } from './spawn-console.ts';

type Reply = { status: number; type: string; body: string; headers: NodeJS.Dict<string | string[]> };

/**
 * A stream never ends, so a helper that waits for `end` would hang on it.
 *
 * Resolves on the FIRST chunk instead — which for `/events` is the `hello`
 * frame the handler writes before it registers a listener — then hangs up.
 */
function firstChunk(port: number, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.setEncoding('utf8');
      res.once('data', (chunk: string) => {
        resolve({
          status: res.statusCode ?? 0,
          type: String(res.headers['content-type'] ?? ''),
          headers: res.headers,
          body: chunk,
        });
        req.destroy();
      });
      res.on('error', () => { /* the hang-up above lands here */ });
    });
    req.on('error', reject);
    req.end();
  });
}

function http(port: number, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const status = res.statusCode ?? 0;
      const type = String(res.headers['content-type'] ?? '');
      const headers = res.headers;
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status, type, headers, body }));
      res.on('error', () => resolve({ status, type, headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(port: number, tries = 100): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { if ((await http(port, '/api/state')).status === 200) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test('the console answers in both build states', async (t) => {
  const port = await freePort();
  const { child, box } = spawnConsole(VIEWER_DIR, port);
  t.after(() => { child.kill('SIGKILL'); box.cleanup(); });

  if (!await waitFor(port)) assert.fail('the console did not come up');

  await t.test('GET / is a real HTML document', async () => {
    const reply = await http(port, '/');
    assert.equal(reply.status, 200);
    assert.match(reply.type, /text\/html/);
    assert.match(reply.body.trimStart().slice(0, 40).toLowerCase(), /^<!doctype html>/,
      'without a doctype every browser renders in quirks mode');
    assert.match(reply.body, /<html[^>]+lang=/, 'the document must declare its language');
  });

  await t.test('every served document carries the full CSP', async () => {
    // The header is the only thing standing between agent-written plan and
    // handoff text and script execution on a console that can spawn shells —
    // the markdown sanitiser in `components/markdown.tsx` was the whole of it.
    // A HEADER and never a `<meta>`: the meta would apply on the Vite dev
    // server too, where `@vitejs/plugin-react` injects React Refresh as an
    // inline module script and `npm run dev` would refuse its own preamble.
    const page = await http(port, '/');
    const policy = String(page.headers['content-security-policy'] ?? '');
    for (const directive of [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:", "font-src 'self'", "worker-src 'self'",
      "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'",
    ]) assert.ok(policy.includes(directive), `CSP is missing ${directive} — got: ${policy}`);
    assert.match(policy, /connect-src [^;]*'self'/, 'the SSE stream and the API are same-origin');
    // `script-src` is the whole point of the change; `check-dist.mjs` holds the
    // built page to no inline script so no hash or nonce is needed here.
    assert.doesNotMatch(policy, /script-src[^;]*'unsafe-(inline|eval)'/);
    // `style-src` KEEPS 'unsafe-inline' and cannot drop it: xterm writes its
    // scrollbar, cell-metric and theme CSS into <style> elements it creates and
    // offers no nonce, and react-remove-scroll does the same behind every Radix
    // dialog. Cheap, because markdown.tsx deletes <style>, <link> and style=.
    assert.match(policy, /style-src [^;]*'unsafe-inline'/);
  });

  await t.test('GET /sw.js is a push-capable worker', async () => {
    const reply = await http(port, '/sw.js');
    assert.equal(reply.status, 200, 'a 404 here UNREGISTERS every subscribed device');
    assert.match(reply.type, /javascript/);
    assert.match(reply.body, /addEventListener\((["'`])push\1/,
      'the worker at /sw.js must handle push, built or not');
  });

  await t.test('an unknown asset is a 404, an unknown page is the shell', async () => {
    assert.equal((await http(port, '/assets/definitely-not-here.js')).status, 404);
    const page = await http(port, '/no-such-page');
    assert.equal(page.status, 200, 'extensionless paths fall through to the SPA entry');
    assert.match(page.type, /text\/html/);
  });

  /*
   * The transport rules, on a REAL socket.
   *
   * `transport.test.ts` proves the negotiation, the validators and the
   * precompressed siblings against fixtures, which is where the detail belongs.
   * What only a real console can prove is that `res.req` — the request
   * `sendBody` reads the client's headers off, instead of threading a second
   * argument through 243 call sites — is actually populated by Node on a
   * response it created itself. A fake that sets it by hand cannot fail that
   * way, and if it ever stopped being true every response would silently fall
   * back to identity with no test anywhere going red.
   */
  await t.test('/events is never compressed, and still streams', async () => {
    // A compressor's buffer is exactly what SSE cannot tolerate: an event
    // sitting in a flush window is an event the browser has not received. The
    // handler writes its own head and never reaches `sendBody` — this is the
    // assertion that keeps it that way.
    const stream = await firstChunk(port, '/events', { 'accept-encoding': 'br, gzip' });
    assert.equal(stream.status, 200);
    assert.match(stream.type, /text\/event-stream/);
    assert.equal(stream.headers['content-encoding'], undefined,
      'an encoded SSE stream is a stream the browser reads late or not at all');
    assert.match(stream.body, /^event: hello/, 'and it still streams — this frame arrived unprompted');
  });

  await t.test('an API read carries a validator and says what it varies on', async () => {
    // The headers, not the round trip — the next subtest says why that is
    // asserted against a FILE instead.
    const reply = await http(port, '/api/state', { 'accept-encoding': 'br' });
    assert.equal(reply.status, 200);
    assert.match(String(reply.headers.etag ?? ''), /^"/, 'a 200 GET offers a strong ETag');
    assert.equal(reply.headers.vary, 'accept-encoding');
    assert.equal(reply.headers['cache-control'], 'private, no-cache',
      'no-store would forbid the browser from keeping the body, so the tag could never come back');
  });

  await t.test('a file the client already holds comes back as a 304', async () => {
    /*
     * `/sw.js` and not `/api/state`, deliberately.
     *
     * `/api/state` is a snapshot of a LIVE process — `runs`, `watcher`,
     * `health`, `generation`, `serverStale` — and two reads a millisecond
     * apart are entitled to differ. The ETag is a hash of the body, so a
     * conditional read of it is a coin toss: this assertion passed in one
     * checkout and returned 200 in the next, which is a flaky test rather than
     * a broken server. A file on disk is the stable entity, and it exercises
     * the same `etagMatches` path.
     *
     * `/sw.js` also answers in BOTH build states (the built worker, or
     * `server/fallback-sw.js`), which is what the rest of this file is about.
     */
    const first = await http(port, '/sw.js', { 'accept-encoding': 'br' });
    assert.equal(first.status, 200);
    const etag = String(first.headers.etag ?? '');
    assert.match(etag, /^"/, 'a static file carries a strong validator too');

    const again = await http(port, '/sw.js', { 'accept-encoding': 'br', 'if-none-match': etag });
    assert.equal(again.status, 304, 'the file did not change between these two requests');
    assert.equal(again.body, '', 'a 304 sends no body');
    assert.equal(again.headers['content-length'], undefined);
  });
});
