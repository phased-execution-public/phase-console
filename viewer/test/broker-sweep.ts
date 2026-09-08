/**
 * Take a disposable instance's pty broker with it.
 *
 * Since Phase 7 a pty is a child of the **broker**, not of the console, and a
 * broker holding a live session deliberately never retires — that is the whole
 * point of it, and it is right for an operator's work. It is wrong for a test:
 * a suite that mints a session and then kills its console (which every spawned
 * console test does, and which any FAILING test does before its cleanup runs)
 * leaves a real `$SHELL -l` running on the machine, held by a broker that will
 * never let it go. Six were found alive after two suite runs, the oldest 22
 * minutes old.
 *
 * There is no message that means "you are about to become unreachable", so the
 * sandbox uses the one thing it does know: the broker writes its pid beside its
 * credential, and the directory that owns that file ends the process when it
 * ends itself. SIGTERM, so the broker's own handler runs and its sessions go
 * down with it rather than being orphaned a second time.
 *
 * Deliberately in `test/`, not `server/`: production must never do this.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SIGTERM every broker whose pid file lives anywhere under `root`.
 *
 * Synchronous and exception-free by design — it runs from `process.on('exit')`
 * handlers and from teardown, where an async call would never be awaited and a
 * throw would replace a real test failure with a cleanup one.
 */
export function sweepBrokers(root: string): number {
  let stopped = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path, depth + 1); continue; }
      if (entry.name !== 'pty.pid') continue;
      let pid = 0;
      try { pid = Number(readFileSync(path, 'utf8').trim()); } catch { continue; }
      if (!Number.isInteger(pid) || pid <= 1) continue;
      try { process.kill(pid, 'SIGTERM'); stopped++; } catch { /* already gone */ }
    }
  };
  walk(root, 0);
  return stopped;
}
