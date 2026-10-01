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
 * Where node-pty is installed for this copy, or null when it is not.
 *
 * Resolved from this file, so it is the `node_modules` of the copy the process
 * runs from — the broker's, the console's, or the doctor's own.
 */
export function nodePtyRoot(): string | null {
  try {
    return dirname(dirname(createRequire(import.meta.url).resolve('node-pty')));
  } catch {
    return null;
  }
}

/**
 * The directories node-pty loads its native half from, in its own order
 * (`lib/utils.js`: a local build first, then the platform's prebuild). The
 * helper it executes is the one beside the `pty.node` it loaded.
 */
function nativeDirs(root: string): string[] {
  return [
    join(root, 'build', 'Release'),
    join(root, 'build', 'Debug'),
    join(root, 'prebuilds', `${process.platform}-${process.arch}`),
  ];
}

/**
 * What the doctor reports about the helper (control-tower #89).
 *
 * `absent` — node-pty is not installed, so there is no terminal to break;
 * `no-helper` — it is, and its build carries no helper; otherwise the helper
 * node-pty will execute (the one beside the `pty.node` it loads), with its mode
 * and whether anything may execute it.
 */
export type SpawnHelperFacts =
  | { state: 'absent' }
  | { state: 'no-helper'; root: string }
  | { state: 'executable' | 'not-executable'; path: string; mode: number };

export function spawnHelperFacts(root: string | null = nodePtyRoot()): SpawnHelperFacts {
  if (!root) return { state: 'absent' };
  const dirs = nativeDirs(root);
  const loaded = dirs.find((dir) => existsSync(join(dir, 'pty.node')));
  for (const dir of loaded ? [loaded] : dirs) {
    const path = join(dir, 'spawn-helper');
    let mode: number;
    try { mode = statSync(path).mode; } catch { continue; }
    return { state: mode & 0o111 ? 'executable' : 'not-executable', path, mode: mode & 0o7777 };
  }
  return { state: 'no-helper', root };
}

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
 *
 * It is asked before EVERY spawn, not once per process (#89): an `npm ci` run
 * underneath a live broker — the update path's, and npm 11 skips node-pty's
 * install scripts — puts the bit back the way it shipped, and a broker that
 * healed only at its first load then failed every terminal until it restarted.
 * `root` is the node-pty package root; a test points it at a helper of its own.
 */
export function healSpawnHelper(root: string | null = nodePtyRoot()): string | null {
  if (!root) return null; // a machine where node-pty is absent has nothing to heal
  let healed: string | null = null;
  for (const dir of nativeDirs(root)) {
    const path = join(dir, 'spawn-helper');
    try {
      if (!existsSync(path)) continue;
      const mode = statSync(path).mode;
      if (mode & 0o111) continue;
      chmodSync(path, mode | 0o755);
      healed ??= path;
    } catch {
      /* unreadable or read-only: the spawn reports its own error, as before */
    }
  }
  return healed;
}
