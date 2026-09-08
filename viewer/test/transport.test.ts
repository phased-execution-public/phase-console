/**
 * The wire — what the browser actually receives.
 *
 * `check-dist.mjs` gated first paint at 200 KB gzipped and passed at 192.7,
 * while `server/index.ts` compressed nothing and the browser received 641.1 KB.
 * Every assertion in this file exists so that gap cannot reopen quietly: the
 * budget is measured on one side and honoured on the other, and both sides are
 * tested here rather than inferred.
 *
 * Four promises:
 *
 *   1. A client that says it takes brotli is sent brotli, and what it decodes
 *      is byte-identical to what a client that said nothing receives.
 *   2. A client that already holds the entity is told so — 304, no body.
 *   3. `/assets/` is content-hashed, so it is `immutable` for a year; the three
 *      files that carry a new build to a running browser stay `no-store`.
 *   4. **Nothing compresses a stream.** `/events` is asserted in
 *      `static.test.ts`, against a real console, because that is the only place
 *      the whole path is real.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';

import {
  compress, etagMatches, etagOf, isCompressibleType, MIN_COMPRESS_BYTES, negotiate,
} from '../server/http/compress.ts';
import { cacheControlFor, clearEtagCache, sendFile } from '../server/http/static.ts';
import { VIEWER_DIR } from '../server/config.ts';

/* ------------------------------------------------------------------ *
 * Negotiation — the header, read the way the RFC means it
 * ------------------------------------------------------------------ */

test('brotli wins a tie, gzip is the fallback, and q=0 is a refusal', () => {
  assert.equal(negotiate('br, gzip'), 'br');
  assert.equal(negotiate('gzip, br'), 'br', 'order in the header is not a preference; q is');
  assert.equal(negotiate('gzip'), 'gzip');
  assert.equal(negotiate('gzip, br;q=0'), 'gzip', 'q=0 refuses a coding, it does not rank it last');
  assert.equal(negotiate('br;q=0, gzip;q=0'), null);
  assert.equal(negotiate('gzip;q=0.9, br;q=0.5'), 'gzip', 'a client may prefer gzip and be obeyed');
  assert.equal(negotiate('deflate'), null, 'a coding this server does not speak is not a fallback');
});

test('a missing, empty or wildcard Accept-Encoding each answer for themselves', () => {
  assert.equal(negotiate(undefined), null, 'no header means identity — never a guess');
  assert.equal(negotiate(''), null);
  assert.equal(negotiate('   '), null);
  assert.equal(negotiate('*'), 'br', '* accepts anything, so send the smallest');
  assert.equal(negotiate('*;q=0, gzip'), 'gzip');
  // Node hands a repeated header through as an array.
  assert.equal(negotiate(['gzip', 'br']), 'br');
});

test('only textual types are worth compressing', () => {
  for (const type of [
    'text/html; charset=utf-8', 'text/javascript; charset=utf-8', 'text/css',
    'application/json; charset=utf-8', 'application/manifest+json', 'image/svg+xml',
  ]) assert.ok(isCompressibleType(type), type);
  for (const type of ['image/png', 'image/x-icon', 'font/woff2', undefined]) {
    assert.ok(!isCompressibleType(type), String(type));
  }
});

/* ------------------------------------------------------------------ *
 * Validators
 * ------------------------------------------------------------------ */

test('the ETag is strong, is the body, and changes with one byte', () => {
  const tag = etagOf(Buffer.from('hello'));
  assert.match(tag, /^"[A-Za-z0-9_-]{27}"$/, 'quoted, and no W/ prefix — this is a strong validator');
  assert.equal(tag, etagOf(Buffer.from('hello')), 'the same bytes are the same tag');
  assert.notEqual(tag, etagOf(Buffer.from('hellp')));
});

test('If-None-Match is compared weakly, as RFC 9110 requires', () => {
  const tag = etagOf(Buffer.from('body'));
  assert.ok(etagMatches(tag, tag));
  assert.ok(etagMatches(`W/${tag}`, tag), 'a client echoing the weak form still holds the entity');
  assert.ok(etagMatches(`"other", ${tag}`, tag), 'any tag in the list is a match');
  assert.ok(etagMatches('*', tag));
  assert.ok(!etagMatches('"other"', tag));
  assert.ok(!etagMatches(undefined, tag));
});

test('compressing is only ever a saving — and the floor says when to bother', () => {
  const body = Buffer.from('a'.repeat(4096));
  assert.ok(compress(body, 'br').length < body.length);
  assert.ok(compress(body, 'gzip').length < body.length);
  assert.equal(brotliDecompressSync(compress(body, 'br')).toString(), body.toString());
  assert.equal(gunzipSync(compress(body, 'gzip')).toString(), body.toString());
  assert.equal(MIN_COMPRESS_BYTES, 1024);
});

/* ------------------------------------------------------------------ *
 * The API path — through the real `handleApi`
 * ------------------------------------------------------------------ */

type Reply = { status: number; headers: Record<string, string>; bytes: Buffer; text: string };

/** Everything `/api/state` needs, and a body big enough to be worth encoding. */
function stateService(rows = 200) {
  const state = {
    root: { path: '/tmp/demo' },
    plans: Array.from({ length: rows }, (_, i) => ({
      slug: `plan-${i}`,
      title: `A plan with a title long enough to be worth compressing, number ${i}`,
      status: 'active',
      phases: 11,
    })),
  };
  return { flags: { allowWrites: false }, state: () => state, _state: state };
}

async function apiGet(service: unknown, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out: Reply = { status: 0, headers: {}, bytes: Buffer.alloc(0), text: '' };
  const req = {
    method: 'GET',
    headers,
    on() { return this; },
    [Symbol.asyncIterator]: async function* () {},
  };
  const res = {
    req,
    writeHead(status: number, responseHeaders?: Record<string, string>) {
      out.status = status;
      out.headers = responseHeaders ?? {};
      return this;
    },
    end(chunk: unknown) {
      out.bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8');
      const encoding = String(out.headers['content-encoding'] ?? '');
      out.text = (encoding === 'br' ? brotliDecompressSync(out.bytes)
        : encoding === 'gzip' ? gunzipSync(out.bytes)
          : out.bytes).toString('utf8');
    },
    on() { return this; },
  };
  await handleApi({ service } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  return out;
}

test('a client that accepts brotli gets brotli, and it decodes to the identity body', async () => {
  const service = stateService();
  const plain = await apiGet(service, '/api/state');
  const packed = await apiGet(service, '/api/state', { 'accept-encoding': 'br' });

  assert.equal(plain.status, 200);
  assert.equal(plain.headers['content-encoding'], undefined, 'nothing was asked for, nothing was applied');
  assert.equal(Number(plain.headers['content-length']), plain.bytes.length);

  assert.equal(packed.status, 200);
  assert.equal(packed.headers['content-encoding'], 'br');
  assert.equal(Number(packed.headers['content-length']), packed.bytes.length,
    'content-length describes the WIRE, not the entity');
  assert.ok(packed.bytes.length < plain.bytes.length / 2, 'this payload is mostly repetition');
  assert.equal(packed.text, plain.text, 'and it is the same JSON either way');
  assert.deepEqual(JSON.parse(packed.text), JSON.parse(plain.text));
});

test('gzip is served when that is all the client takes', async () => {
  const out = await apiGet(stateService(), '/api/state', { 'accept-encoding': 'gzip' });
  assert.equal(out.headers['content-encoding'], 'gzip');
  assert.ok(out.bytes.length < Buffer.byteLength(out.text));
});

test('every compressible answer says so, whether or not this one was compressed', async () => {
  // `vary` is about the response's DEPENDENCE on the request header, not about
  // what happened this time. A cache told otherwise will hand a br body to a
  // client that cannot read one.
  const big = await apiGet(stateService(), '/api/state');
  assert.equal(big.headers['vary'], 'accept-encoding');
  const small = await apiGet(stateService(0), '/api/state', { 'accept-encoding': 'br' });
  assert.ok(small.bytes.length < MIN_COMPRESS_BYTES, 'this one is under the floor');
  assert.equal(small.headers['content-encoding'], undefined, 'and so it was sent as it was');
  assert.equal(small.headers['vary'], 'accept-encoding', 'but it still depends on the header');
});

test('a client holding the entity is told so — 304, no body, no second payload', async () => {
  const service = stateService();
  const first = await apiGet(service, '/api/state', { 'accept-encoding': 'br' });
  const etag = first.headers['etag'];
  assert.match(etag ?? '', /^"/, 'a read carries a validator');

  const again = await apiGet(service, '/api/state', { 'accept-encoding': 'br', 'if-none-match': etag });
  assert.equal(again.status, 304);
  assert.equal(again.bytes.length, 0, 'a 304 sends nothing');
  assert.equal(again.headers['content-length'], undefined, 'and describes no body it is not sending');
  assert.equal(again.headers['content-type'], undefined);
  assert.equal(again.headers['etag'], etag);

  // The validator is the BODY, so a changed body is a changed tag and a 200.
  service._state.plans.push({ slug: 'new', title: 'appeared', status: 'active', phases: 1 });
  const changed = await apiGet(service, '/api/state', { 'accept-encoding': 'br', 'if-none-match': etag });
  assert.equal(changed.status, 200);
});

test('a read may be revalidated; a write, an error and a POST may not be cached at all', async () => {
  const read = await apiGet(stateService(), '/api/state');
  assert.equal(read.headers['cache-control'], 'private, no-cache',
    'no-cache means REVALIDATE BEFORE USE — an ETag under no-store could never be sent back');

  // `/api/state` is GET-only, so anything else is the route's own refusal — a
  // response that must never be stored, and never carries a validator.
  const { handleApi } = await import('../server/api/routes.ts');
  const out: Reply = { status: 0, headers: {}, bytes: Buffer.alloc(0), text: '' };
  const req = {
    method: 'POST',
    headers: { 'accept-encoding': 'br', 'x-phase-console': '1' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from('{}'); },
  };
  const res = {
    req,
    writeHead(status: number, headers?: Record<string, string>) { out.status = status; out.headers = headers ?? {}; return this; },
    end(chunk: unknown) { out.bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? '')); },
    on() { return this; },
  };
  await handleApi(
    { service: stateService() } as never, req as never, res as never,
    new URL('http://127.0.0.1/api/state'),
  );
  assert.equal(out.headers['cache-control'], 'no-store');
  assert.equal(out.headers['etag'], undefined, 'nothing that is not a 200 GET is worth revalidating');
});

/* ------------------------------------------------------------------ *
 * Static files — against a fixture, so the assertions do not depend on
 * whether this machine happens to have a build
 * ------------------------------------------------------------------ */

const JS_BODY = 'export const answer = 42;\n'.repeat(120); // ~3 KB, well over the floor
// Deliberately DIFFERENT bytes from JS_BODY: the ETag is a hash of the body, so
// two files with identical contents share a tag — which is correct, and would
// make "a different file is a different tag" prove nothing.
const BARE_BODY = 'export const other = "no sibling was written for me";\n'.repeat(60);

function fixture(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'phase-console-static-'));
  mkdirSync(join(dir, 'assets'));
  mkdirSync(join(dir, 'fonts'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html>\n<html lang="en"><body>hi</body></html>\n');
  writeFileSync(join(dir, 'assets', 'index-B7fQ2x.js'), JS_BODY);
  writeFileSync(join(dir, 'assets', 'index-B7fQ2x.js.br'), brotliCompressSync(Buffer.from(JS_BODY)));
  writeFileSync(join(dir, 'assets', 'index-B7fQ2x.js.gz'), gzipSync(Buffer.from(JS_BODY)));
  // No siblings for this one: a build made before the precompressor existed.
  writeFileSync(join(dir, 'assets', 'bare-Zz9.js'), BARE_BODY);
  // Already compressed — running deflate over it would add bytes.
  writeFileSync(join(dir, 'assets', 'icon-Q1.png'), Buffer.from(gzipSync(Buffer.from(JS_BODY))));
  writeFileSync(join(dir, 'fonts', 'inter.woff2'), Buffer.alloc(4096, 7));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function serveFixture(dir: string): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    sendFile(res, join(dir, (req.url ?? '/').split('?')[0].replace(/^\//, '')), { 'x-fixture': '1' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        const encoding = String(res.headers['content-encoding'] ?? '');
        const plain = encoding === 'br' ? brotliDecompressSync(bytes)
          : encoding === 'gzip' ? gunzipSync(bytes)
            : bytes;
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string>,
          bytes,
          text: plain.toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('static files: precompressed siblings, immutable hashes, and 304s', async (t) => {
  clearEtagCache();
  const box = fixture();
  const server = await serveFixture(box.dir);
  t.after(async () => { await server.close(); box.cleanup(); });

  await t.test('a content-hashed asset is immutable for a year', async () => {
    const reply = await get(server.port, '/assets/index-B7fQ2x.js');
    assert.equal(reply.status, 200);
    const cache = String(reply.headers['cache-control']);
    assert.match(cache, /immutable/, 'the filename IS the version — asking again can never learn anything');
    assert.match(cache, /max-age=31536000/);
    assert.equal(reply.headers['x-fixture'], '1', "the caller's own headers still ride along");
  });

  await t.test('the three files that carry a new build stay no-store', async () => {
    assert.equal((await get(server.port, '/index.html')).headers['cache-control'], 'no-store');
    // Asserted at the source too, so the rule survives a change of fixture.
    assert.equal(cacheControlFor('/x/dist/index.html'), 'no-store');
    assert.equal(cacheControlFor('/x/dist/sw.js'), 'no-store');
    assert.equal(cacheControlFor('/x/dist/manifest.webmanifest'), 'no-store');
    assert.match(cacheControlFor('/x/dist/fonts/inter.woff2'), /max-age=86400/);
    assert.doesNotMatch(cacheControlFor('/x/dist/fonts/inter.woff2'), /immutable/,
      'unhashed files DO change at the same URL on a redeploy');
  });

  await t.test('the precompressed sibling is what goes on the wire', async () => {
    const identity = await get(server.port, '/assets/index-B7fQ2x.js');
    const br = await get(server.port, '/assets/index-B7fQ2x.js', { 'accept-encoding': 'br' });
    const gz = await get(server.port, '/assets/index-B7fQ2x.js', { 'accept-encoding': 'gzip' });

    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(identity.headers['content-encoding'], undefined);
    for (const reply of [identity, br, gz]) {
      assert.equal(reply.text, JS_BODY, 'every coding decodes to the same file');
      assert.equal(Number(reply.headers['content-length']), reply.bytes.length);
      assert.equal(reply.headers['vary'], 'accept-encoding');
    }
    assert.ok(br.bytes.length < identity.bytes.length / 3);
  });

  await t.test('no sibling means identity — a pre-precompressor build still serves', async () => {
    const reply = await get(server.port, '/assets/bare-Zz9.js', { 'accept-encoding': 'br' });
    assert.equal(reply.status, 200);
    assert.equal(reply.headers['content-encoding'], undefined,
      'nothing is compressed at request time here — that is the whole design');
    assert.equal(reply.text, BARE_BODY);
  });

  await t.test('an already-compressed type is never encoded and never varies', async () => {
    const png = await get(server.port, '/assets/icon-Q1.png', { 'accept-encoding': 'br' });
    assert.equal(png.status, 200);
    assert.equal(png.headers['content-encoding'], undefined);
    assert.equal(png.headers['vary'], undefined, 'its bytes do not depend on the request header');
    const woff = await get(server.port, '/fonts/inter.woff2', { 'accept-encoding': 'br' });
    assert.equal(woff.headers['content-encoding'], undefined);
  });

  await t.test('a second request carrying the ETag is a 304 with an empty body', async () => {
    const first = await get(server.port, '/assets/index-B7fQ2x.js', { 'accept-encoding': 'br' });
    const etag = first.headers['etag'];
    assert.match(etag ?? '', /^"/);

    const again = await get(server.port, '/assets/index-B7fQ2x.js', {
      'accept-encoding': 'br', 'if-none-match': etag,
    });
    assert.equal(again.status, 304);
    assert.equal(again.bytes.length, 0);
    assert.equal(again.headers['content-length'], undefined);
    assert.equal(again.headers['etag'], etag);

    // A different file is a different tag, so it is a 200 and not a 304.
    const other = await get(server.port, '/assets/bare-Zz9.js', { 'if-none-match': etag });
    assert.equal(other.status, 200);
  });

  await t.test('a file that vanished between the stat and the read is a 404', async () => {
    assert.equal((await get(server.port, '/assets/not-here.js')).status, 404);
  });
});

/* ------------------------------------------------------------------ *
 * The precompressor
 * ------------------------------------------------------------------ */

test('precompress writes smaller siblings, skips what is not worth it, and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase-console-precompress-'));
  try {
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), `<!doctype html>\n${'<p>hello</p>\n'.repeat(200)}`);
    writeFileSync(join(dir, 'assets', 'app-A1.js'), JS_BODY);
    writeFileSync(join(dir, 'assets', 'tiny-B2.js'), 'export const a = 1;\n'); // under the floor
    writeFileSync(join(dir, 'assets', 'icon-C3.png'), Buffer.alloc(8192, 3)); // not a text type

    const run = () => execFileSync(process.execPath, [join(VIEWER_DIR, 'scripts', 'precompress.mjs')], {
      env: { ...process.env, PC_DIST_DIR: dir },
      encoding: 'utf8',
    });
    const first = run();
    assert.match(first, /precompress: \d+ siblings? written/);

    const original = readFileSync(join(dir, 'assets', 'app-A1.js'));
    const br = readFileSync(join(dir, 'assets', 'app-A1.js.br'));
    const gz = readFileSync(join(dir, 'assets', 'app-A1.js.gz'));
    assert.ok(br.length < original.length, 'a sibling that is not smaller is not written');
    assert.ok(gz.length < original.length);
    assert.equal(brotliDecompressSync(br).toString('utf8'), JS_BODY, 'and it is the same file');
    assert.equal(gunzipSync(gz).toString('utf8'), JS_BODY);
    assert.ok(readFileSync(join(dir, 'index.html.br')).length > 0);

    assert.throws(() => readFileSync(join(dir, 'assets', 'tiny-B2.js.br')), /ENOENT/,
      'under the floor, compression costs CPU to save nothing');
    assert.throws(() => readFileSync(join(dir, 'assets', 'icon-C3.png.br')), /ENOENT/,
      'a png is already compressed');

    // Run again: the siblings are not themselves inputs (no .br.br), and the
    // result is byte-identical.
    run();
    assert.deepEqual(readFileSync(join(dir, 'assets', 'app-A1.js.br')), br);
    assert.throws(() => readFileSync(join(dir, 'assets', 'app-A1.js.br.br')), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('precompress refuses a directory that is not a build, rather than writing nothing quietly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase-console-precompress-empty-'));
  try {
    assert.throws(
      () => execFileSync(process.execPath, [join(VIEWER_DIR, 'scripts', 'precompress.mjs')], {
        env: { ...process.env, PC_DIST_DIR: dir },
        stdio: 'pipe',
      }),
      /index\.html/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
