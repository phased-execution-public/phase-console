/**
 * Every source file is one the scrub can read.
 *
 * `.github/scripts/scrub.sh` scans the tree with `grep -I`, and grep judges a
 * file holding a single raw NUL byte to be binary: `-I` then skips it without a
 * word, so the identity, e-mail and tool-word checks never read it while the
 * scrub still counts it among the files it passed. `viewer/fleet/tls.ts` was
 * such a file (many-plans-one-repo phase 22) — a cache key joined with a
 * literal NUL made the one file that handles the CA and leaf keys the one file
 * the scrub could not see. A NUL a string needs is written as the escape
 * `\u0000`, which is the same string and leaves the file text.
 *
 * The tree is walked rather than listed with `git ls-files`, because the free
 * tree `verify-free` holds to this suite is not a git checkout.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Dependencies and build output are never source; a dot-directory is a tool's. */
const SKIP_DIRS = new Set(['node_modules', 'dist']);

/** What is read as text. An image, a font or a GIF is binary by design. */
const TEXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.sh', '.bash', '.bats', '.md', '.json',
  '.html', '.css', '.yml', '.yaml', '.txt', '.env', '.svg', '.webmanifest',
]);

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.claude-plugin') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* sources(path);
    } else if (entry.isFile() && TEXT.has(extname(entry.name))) {
      yield path;
    }
  }
}

test('no source file holds a raw NUL byte, so the scrub’s grep -I reads every one', () => {
  const unread: string[] = [];
  let read = 0;
  for (const path of sources(root)) {
    read += 1;
    if (readFileSync(path).includes(0)) unread.push(relative(root, path));
  }
  assert.ok(read > 100, `the walk found only ${read} source files — it is not looking at the tree`);
  assert.deepEqual(
    unread.sort(),
    [],
    'grep -I judges these files binary and the scrub never reads them — write the NUL as `\\u0000`:\n  '
      + unread.join('\n  '),
  );
});
