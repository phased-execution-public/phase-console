/**
 * Serving `client/dist` — the built client, and the only thing on this server
 * that is the same bytes on every request.
 *
 * Which is the whole opportunity. A Vite build under `/assets/` is
 * CONTENT-HASHED: the filename changes when the bytes change, so the old name
 * can never name new content and the browser never has to ask again. Until now
 * it was told to ask again every day (`max-age=86400`) and handed the answer
 * uncompressed — 641.1 KB of first paint that `check-dist.mjs` had already
 * measured, gzipped, at 192.7.
 *
 * Two changes close that, and neither costs the server any work per request:
 *
 *   - **Precompressed siblings.** `scripts/precompress.mjs` writes `<file>.br`
 *     and `<file>.gz` beside every compressible build output, at brotli
 *     quality 11, once, at build time. Serving one is a `stat` and a stream —
 *     the same cost as serving the original. Nothing is compressed at request
 *     time here, deliberately: a console holding a stream open for a phone on a
 *     tailnet should not also be running a compressor.
 *   - **`immutable` on the content-hashed assets.** A year, and no revalidation
 *     at all. `index.html`, `sw.js` and the manifest deliberately stay
 *     `no-store` — those three are how a new build reaches a running browser,
 *     and a stale one is a puzzle rather than a saving.
 *
 * A build made before `precompress.mjs` existed simply has no siblings, and
 * every file is served identity. That is the correct fallback and it is why
 * this file never compresses on the fly: "the sibling is missing" and "the
 * client did not ask" arrive at the same, cheap answer.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, readFileSync, statSync, type Stats } from 'node:fs';
import { extname } from 'node:path';

import { trimOldest } from '../service-base.ts';
import { isClientDisconnect, log } from '../log.ts';
import {
  etagMatches, etagOf, isCompressibleType, MIN_COMPRESS_BYTES, negotiate,
} from './compress.ts';

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // iOS ignores a manifest served as anything else, and ignoring it silently is
  // the whole difference between a home-screen app and a bookmark.
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * How long a reader may keep this file, by where it lives.
 *
 * `/assets/` is Vite's content-hashed output — `index-B7fQ2x.js` cannot ever
 * mean different bytes, so `immutable` is not an optimism, it is a statement of
 * fact, and a year is the longest value the spec allows anyone to mean by it.
 *
 * `/vendor/` and `/fonts/` are copied through unhashed: a redeploy DOES change
 * them at the same URL, so they keep the old day-long `max-age` and must never
 * be given `immutable`.
 *
 * Everything else — `index.html`, `sw.js`, `manifest.webmanifest` — is how a
 * new build reaches a browser that is already running the old one, and stays
 * `no-store`. That rule is deliberate; do not "optimise" it.
 */
export function cacheControlFor(path: string): string {
  if (/[/\\]assets[/\\]/.test(path)) return 'public, max-age=31536000, immutable';
  if (/[/\\](vendor|fonts)[/\\]/.test(path)) return 'public, max-age=86400';
  return 'no-store';
}

/**
 * File validators, computed once per version of a file.
 *
 * The tag is a hash of the file's bytes (see `etagOf`), so it costs one read —
 * and then never again until the file changes, because the key carries the
 * size and mtime that would change with it. A build replaces every name under
 * `/assets/`, so the stale entries age out rather than needing invalidation.
 * `trimOldest` is the fleet's shared bound (`service-base.ts`); insertion-order
 * eviction is right here for the same reason it is right there — a re-read is a
 * cost, never a wrong answer.
 */
const ETAG_CAP = 256;
const etagCache = new Map<string, string>();

function etagForFile(path: string, stat: Stats): string | null {
  const key = `${path}:${stat.size}:${stat.mtimeMs}`;
  const known = etagCache.get(key);
  if (known) return known;
  let tag: string;
  try { tag = etagOf(readFileSync(path)); } catch { return null; }
  etagCache.set(key, tag);
  trimOldest(etagCache, ETAG_CAP);
  return tag;
}

/** Test seam: a build in a temp directory must not read another test's tags. */
export function clearEtagCache(): void {
  etagCache.clear();
}

/**
 * Send one file from disk.
 *
 * `extra` is the caller's fixed header set — in practice `securityHeaders()`,
 * which closes over the console's flags and so cannot live down here.
 */
export function sendFile(
  res: ServerResponse,
  path: string,
  extra: Record<string, string> = {},
): void {
  const req = (res as ServerResponse & { req?: IncomingMessage }).req;
  const type = MIME[extname(path)] ?? 'application/octet-stream';
  const headers: Record<string, string | number> = {
    'content-type': type,
    'cache-control': cacheControlFor(path),
    ...extra,
  };

  let stat: Stats;
  try {
    stat = statSync(path);
  } catch (error) {
    // The caller stat'ed this path already; arriving here means it went away in
    // between, which is a 404 and not a crash.
    if (!isClientDisconnect(error)) log.warn('static.missing', { path });
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }

  const compressible = isCompressibleType(type);
  if (compressible) headers.vary = 'accept-encoding';

  const etag = etagForFile(path, stat);
  if (etag) {
    headers.etag = etag;
    if (req?.method === 'GET' && etagMatches(req.headers['if-none-match'], etag)) {
      // Validators and cache directives only — see the note in `sendBody`.
      delete headers['content-type'];
      res.writeHead(304, headers);
      res.end();
      return;
    }
  }

  let file = path;
  let size = stat.size;
  if (compressible && stat.size >= MIN_COMPRESS_BYTES) {
    const encoding = negotiate(req?.headers['accept-encoding']);
    if (encoding) {
      const alt = `${path}.${encoding === 'br' ? 'br' : 'gz'}`;
      let altStat: Stats | null = null;
      try { altStat = statSync(alt); } catch { altStat = null; }
      // Smaller, or there was no point precompressing it.
      if (altStat?.isFile() && altStat.size < stat.size) {
        file = alt;
        size = altStat.size;
        headers['content-encoding'] = encoding;
      }
    }
  }

  headers['content-length'] = size;
  res.writeHead(200, headers);
  const stream = createReadStream(file);
  // A file deleted between the stat above and this read, or a client that
  // navigates away mid-transfer, both arrive here rather than as a crash.
  stream.on('error', (error) => {
    if (!isClientDisconnect(error)) log.warn('static.error', { path: file, error });
    res.destroy();
  });
  stream.pipe(res);
}
