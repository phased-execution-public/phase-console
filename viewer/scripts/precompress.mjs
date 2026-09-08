#!/usr/bin/env node
/**
 * The last step of `npm run build`: write the bytes the server will actually
 * send.
 *
 * `check-dist.mjs` has measured first paint gzipped since 3.0 and gated it at
 * 200 KB. The server sent it uncompressed — 641.1 KB — for the console's whole
 * life, so the budget was real and the browser never saw it. Compressing at
 * request time would fix the number and add a compressor to a process that is
 * also supervising agent sessions and holding SSE streams open, so instead it
 * happens once, here, at build time:
 *
 *   assets/index-B7fQ2x.js        →  assets/index-B7fQ2x.js.br
 *                                    assets/index-B7fQ2x.js.gz
 *
 * `server/http/static.ts` serves a sibling when the client accepts that coding
 * and the sibling is smaller; otherwise it serves the original. So a build made
 * without this step is not broken, only bigger — which is exactly the state
 * `check-dist.mjs` now gates on, since it measures the SERVED bytes.
 *
 * **Brotli quality 11 here, 5 at request time.** The CPU is free at build time
 * and the result is downloaded by every visitor forever; `compress.ts` cannot
 * make that trade for a body it composes per request.
 *
 * Not compressed: png, ico, woff2 (already compressed — deflate over them adds
 * bytes), anything under the threshold, and any file whose compressed form came
 * out no smaller. A sibling that is not smaller is deleted rather than left to
 * confuse the next reader.
 *
 *   node scripts/precompress.mjs           # PC_DIST_DIR honoured, like every other script
 */

import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as ZLIB, gzipSync } from 'node:zlib';

const VIEWER = dirname(dirname(fileURLToPath(import.meta.url)));
// Same variable and same resolution as vite.config.ts, stamp-build.mjs and
// check-dist.mjs: relative to `client/`, or absolute.
const DIST = resolve(join(VIEWER, 'client'), process.env.PC_DIST_DIR || 'dist');

/** Kept in step with `MIN_COMPRESS_BYTES` in server/http/compress.ts. */
const MIN_BYTES = 1024;

/**
 * By extension rather than by content type, because that is what a file on
 * disk has. The list is the compressible half of `MIME` in
 * `server/http/static.ts` — if a build starts emitting a new text format, both
 * lists want it.
 */
const COMPRESSIBLE = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.webmanifest',
  '.svg',
  '.txt',
  '.map',
]);

function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(full);
  }
  return out;
}

if (!exists(join(DIST, 'index.html'))) {
  process.stderr.write(
    `precompress: no ${DIST.replace(VIEWER + '/', '')}/index.html — run \`npm run build\` first.\n`,
  );
  process.exit(1);
}

let written = 0;
let skipped = 0;
let identityBytes = 0;
let brBytes = 0;

for (const file of walk(DIST)) {
  const ext = extname(file);
  // A previous run's siblings are inputs to nothing — and re-compressing a
  // `.br` would produce `.br.br`.
  if (ext === '.br' || ext === '.gz') continue;
  if (!COMPRESSIBLE.has(ext)) {
    skipped += 1;
    continue;
  }

  const body = readFileSync(file);
  if (body.length < MIN_BYTES) {
    skipped += 1;
    continue;
  }

  identityBytes += body.length;

  const forms = [
    [
      '.br',
      brotliCompressSync(body, {
        params: {
          [ZLIB.BROTLI_PARAM_QUALITY]: 11,
          [ZLIB.BROTLI_PARAM_SIZE_HINT]: body.length,
        },
      }),
    ],
    ['.gz', gzipSync(body, { level: 9 })],
  ];

  for (const [suffix, packed] of forms) {
    const sibling = `${file}${suffix}`;
    if (packed.length >= body.length) {
      // Never leave a sibling the server would refuse to use anyway.
      rmSync(sibling, { force: true });
      continue;
    }
    writeFileSync(sibling, packed);
    written += 1;
    if (suffix === '.br') brBytes += packed.length;
  }
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
process.stdout.write(
  `precompress: ${written} sibling${written === 1 ? '' : 's'} written, ${skipped} file` +
    `${skipped === 1 ? '' : 's'} left as-is ` +
    `(${kb(identityBytes)} → ${kb(brBytes)} br, ` +
    `${identityBytes ? (100 - (brBytes / identityBytes) * 100).toFixed(0) : '0'}% smaller)\n`,
);
