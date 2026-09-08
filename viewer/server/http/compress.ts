/**
 * The wire: what leaves this process, and how many bytes it costs.
 *
 * `check-dist.mjs` gates first paint at 200 KB **gzipped** and passes at 192.7 —
 * and for the whole life of the console the server sent none of that gzipped, so
 * the browser received 641.1 KB. A cold plan open moved ≈1,753 KB that would
 * have been ≈442 KB. Nothing about that budget was wrong; nobody had connected
 * it to the socket.
 *
 * So: one helper, used everywhere a body is written, that decides the wire form
 * of that body and the headers that describe it. `node:zlib` and `node:crypto`
 * only — `viewer/package.json` carries `dependencies: {}` by design and this is
 * not the change that breaks it.
 *
 * Three rules it holds:
 *
 *   1. **Never compress a stream.** `/events` is Server-Sent Events, and a
 *     compressor's buffer is exactly the thing SSE cannot tolerate — an event
 *     that sits in a flush window is an event the browser has not received.
 *     That handler writes its own head and never reaches this file;
 *     `transport.test.ts` asserts it stays that way.
 *   2. **Below the threshold, send the bytes.** Compressing 200 bytes costs a
 *     syscall's worth of CPU to save nothing, and framing overhead can make the
 *     result LARGER. `MIN_COMPRESS_BYTES` is the floor, and a body that grew is
 *     sent as-is regardless.
 *   3. **`vary: accept-encoding` on everything compressible**, including the
 *     bodies that came out identity. The response's form depends on the request
 *     header whether or not this particular one differed, and a cache that does
 *     not know that will hand a br body to a client that cannot read one.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { brotliCompressSync, constants as ZLIB, gzipSync } from 'node:zlib';

/** The two codings this server speaks, in preference order. */
export type Encoding = 'br' | 'gzip';

/**
 * Below this, compression is not worth its own CPU — and for very small bodies
 * the gzip/brotli framing can exceed what it saves. 1 KB is the conventional
 * floor (nginx's `gzip_min_length` default is 20 bytes, which is far too low;
 * every serious deployment raises it to about this).
 */
export const MIN_COMPRESS_BYTES = 1024;

/**
 * Runtime brotli quality.
 *
 * The default is 11, which is a BUILD-time setting: on a 300 KB JSON body it
 * costs hundreds of milliseconds, which would trade the transport win straight
 * back for latency. 5 is the usual serve-time choice — within a few percent of
 * 11 on text, at a small fraction of the time. The build-time precompressor
 * (`scripts/precompress.mjs`) uses 11, because there the CPU is free.
 */
const BROTLI_QUALITY = 5;

/**
 * Which content types are worth compressing.
 *
 * Everything textual, plus the few `application/*` types that are text in
 * disguise. Deliberately NOT: png, ico, woff2 — all three are already
 * compressed, and running deflate over them spends CPU to add bytes.
 */
export function isCompressibleType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (type.startsWith('text/')) return true;
  if (type.startsWith('image/svg')) return true;
  return (
    type === 'application/json'
    || type === 'application/manifest+json'
    || type === 'application/javascript'
    || type === 'application/xml'
    || type === 'application/octet-stream'
  );
}

/** `name;q=0.5, other` → `{name: 0.5, other: 1}`. A malformed q reads as 1. */
function qualities(header: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of header.split(',')) {
    const [rawName, ...params] = part.split(';');
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(param);
      if (match) {
        const parsed = Number(match[1]);
        q = Number.isFinite(parsed) ? parsed : 1;
      }
    }
    out.set(name, q);
  }
  return out;
}

/**
 * Which coding to send, given what the client said it accepts.
 *
 * Brotli when the client takes both at equal quality — it is 15–20% smaller
 * than gzip on this client's chunks and every browser that speaks it over
 * plain HTTP on loopback also speaks gzip, so the fallback is never far.
 * `q=0` is a REFUSAL, not a preference, and `*` stands in for anything the
 * header did not name.
 */
export function negotiate(header: string | string[] | undefined): Encoding | null {
  if (!header) return null;
  const value = Array.isArray(header) ? header.join(',') : header;
  if (!value.trim()) return null;
  const q = qualities(value);
  const star = q.get('*');
  const score = (name: Encoding): number => q.get(name) ?? star ?? 0;
  const br = score('br');
  const gzip = score('gzip');
  if (br > 0 && br >= gzip) return 'br';
  if (gzip > 0) return 'gzip';
  return null;
}

/** Compress once, synchronously. Bodies here are already fully in memory. */
export function compress(body: Buffer, encoding: Encoding): Buffer {
  if (encoding === 'br') {
    return brotliCompressSync(body, {
      params: {
        [ZLIB.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [ZLIB.BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    });
  }
  return gzipSync(body, { level: 6 });
}

/**
 * A strong `ETag` over the IDENTITY body — the bytes before any coding.
 *
 * Identity rather than the served bytes for one reason: a conditional request
 * can then be answered without compressing anything. A 304 is the cheapest
 * response this server can give and it would be absurd to spend a brotli pass
 * arriving at one. `vary: accept-encoding` (set on every compressible response)
 * is what keeps a cache from mixing the codings up, and it is the same
 * arrangement Express's `etag` + `compression` pair has used for a decade.
 *
 * Strong, not weak: the hash IS the body, so byte-equality is exactly what it
 * claims. 27 base64url characters of SHA-256 — 162 bits, far past any birthday
 * concern for one console's response cache.
 */
export function etagOf(body: Buffer): string {
  return `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
}

/**
 * Does the client already hold this entity?
 *
 * `If-None-Match` is compared with the WEAK function (RFC 9110 §13.1.2), so a
 * client echoing `W/"x"` matches our strong `"x"`. `*` matches anything, which
 * on a GET means "if it exists at all".
 */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const value = Array.isArray(header) ? header.join(',') : header;
  if (value.trim() === '*') return true;
  const strip = (tag: string): string => tag.trim().replace(/^W\//i, '');
  const want = strip(etag);
  return value.split(',').some((tag) => strip(tag) === want);
}

export type SendOptions = {
  /**
   * `false` for bodies that are already compressed or must not be buffered.
   * Suppresses both the coding and the `vary`.
   */
  compressible?: boolean;
  /**
   * `true` to attach an `ETag` and answer a matching `If-None-Match` with a
   * 304. Only ever acted on for a 200 response to a GET: a 304 to a POST is
   * meaningless, and a 304 to a 4xx is a lie.
   */
  revalidate?: boolean;
};

/**
 * Write one complete body, in whatever form the client can read most cheaply.
 *
 * The request comes from `res.req` (Node ≥15.7) rather than being threaded
 * through every caller — `routes.ts` alone has 243 `json(res, …)` call sites,
 * and a parameter added to all of them would be 243 chances to pass the wrong
 * one. `res.req` is the request this response belongs to, by construction.
 * A response object with no `req` (the fake in `routes.test.ts`) negotiates to
 * identity, which is the correct answer for a caller that named no encoding.
 */
export function sendBody(
  res: ServerResponse,
  status: number,
  body: Buffer,
  headers: Record<string, string | number>,
  options: SendOptions = {},
): void {
  const req = (res as ServerResponse & { req?: IncomingMessage }).req;
  const out: Record<string, string | number> = { ...headers };
  const compressible = options.compressible !== false;
  // Set before the 304 below, not inside the branch that sends a body: `vary`
  // describes what the answer DEPENDS on, and a 304 is an answer.
  if (compressible) {
    out.vary = out.vary ? `${String(out.vary)}, accept-encoding` : 'accept-encoding';
  }

  if (options.revalidate && status === 200 && req?.method === 'GET') {
    const etag = etagOf(body);
    out.etag = etag;
    if (etagMatches(req.headers['if-none-match'], etag)) {
      // A 304 carries validators and cache directives and NOTHING that
      // describes a body it is not sending — a `content-length` on a 304 has
      // made more than one proxy wait for bytes that never come.
      delete out['content-length'];
      delete out['content-type'];
      res.writeHead(304, out);
      res.end();
      return;
    }
  }

  let wire = body;
  if (compressible && body.length >= MIN_COMPRESS_BYTES) {
    const encoding = negotiate(req?.headers['accept-encoding']);
    if (encoding) {
      const packed = compress(body, encoding);
      // Rule 2: a body that grew is a body sent as it was.
      if (packed.length < body.length) {
        wire = packed;
        out['content-encoding'] = encoding;
      }
    }
  }

  out['content-length'] = wire.length;
  res.writeHead(status, out);
  res.end(wire);
}
