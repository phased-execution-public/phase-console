/**
 * Redirect this test process's console state somewhere disposable.
 *
 * **Import this first.** `server/config.ts` computes `STATE_DIR` and
 * `CONFIG_DIR` once, at module load, from `XDG_STATE_HOME` / `XDG_CONFIG_HOME`.
 * A module that reads them before this one runs has already resolved the
 * operator's real directories, and nothing later can move it.
 *
 * What is at stake is not tidiness. `~/.local/state/phase-console/` holds
 * `push/subscriptions.json` — the operator's actual subscribed browsers. A test
 * that constructs a real `Service`, or spawns a real console, loads that file
 * and can deliver to those devices for real. It did: a shutdown test's console
 * announced its own shutdown, and the announcement arrived on the operator's
 * phone and laptop as a notification from a console they were not running. The
 * same directory also holds the notification inbox, approvals, and every run
 * journal — a suite pointed at it leaves thousands of fixture runs in the
 * operator's history.
 *
 * Files that already redirect inline (before their own dynamic imports) do not
 * need this; `test/state-isolation.test.ts` checks that every file does one or
 * the other.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sweepBrokers } from './broker-sweep.ts';

const dir = mkdtempSync(join(tmpdir(), 'phase-console-state-'));

process.env.XDG_STATE_HOME = join(dir, 'state');
process.env.XDG_CONFIG_HOME = join(dir, 'config');

/**
 * A pty broker started by a test retires in seconds, not in five minutes.
 *
 * The broker deliberately outlives the console that started it — that is the
 * whole point of it — so a suite that opens a real shell leaves one behind,
 * holding a socket in a temp directory that has already been deleted. Its idle
 * rule still retires it (a broker with no client and no live session exits),
 * but the production window is generous for a reason a test does not have.
 * Inherited by every console and broker a test spawns, because both are given
 * this process's environment.
 *
 * The idle rule alone is not enough, which is what the sweep below is for: a
 * broker still HOLDING a session never retires at all — by design.
 */
process.env.PHASE_CONSOLE_PTY_IDLE_MS ??= '20000';

process.on('exit', () => {
  // Before the directory goes, so the pid files are still there to read.
  try { sweepBrokers(dir); } catch { /* a leftover broker is not a test failure */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* a leftover tmpdir is not a failure */ }
});

/** The sandbox root, for a test that wants to look at what was written. */
export const STATE_SANDBOX = dir;
