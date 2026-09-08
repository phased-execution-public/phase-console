/**
 * node-pty's prebuilt `spawn-helper`, made executable.
 *
 * Lifted out of `terminal.ts` when the broker took over loading the native
 * module: the heal has to run in the process that will actually `spawn`, and
 * that is the broker now. `terminal.ts` re-exports it, so the existing import
 * and its test are unchanged.
 */

import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * node-pty ships its `spawn-helper` prebuild **without the executable bit**
 * (1.1.0, at least through npm on macOS). The failure it produces is
 * `Error: posix_spawnp failed.` from deep inside the addon — nothing about it
 * says "chmod", and every reasonable next move (rebuild, reinstall, another
 * Node) reproduces it exactly.
 *
 * Fixing it here rather than in a `postinstall` keeps it true after any
 * `npm ci`, and the whole operation is one stat and one chmod on a file we are
 * about to execute anyway. A read-only `node_modules` just falls through to the
 * original error, which is no worse than before.
 */
export function healSpawnHelper(): string | null {
  try {
    const require_ = createRequire(import.meta.url);
    const root = dirname(dirname(require_.resolve('node-pty')));
    const candidates = [
      join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      join(root, 'build', 'Release', 'spawn-helper'),
    ];
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      const mode = statSync(path).mode;
      if (mode & 0o111) continue;
      chmodSync(path, mode | 0o755);
      return path;
    }
  } catch {
    /* a machine where node-pty is absent has nothing to heal */
  }
  return null;
}
