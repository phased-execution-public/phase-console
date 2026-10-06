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

/**
 * The machine reads quiet (control-tower phase 34). The scheduler holds every
 * NEW admission while the 5-minute load is above its guard (phase 100), and a
 * `Service` a test builds reads the real `os.loadavg()` — so on a busy machine
 * every `admit()` a test awaited queued for ever. This is the e2e fixture's
 * shim, held for the whole process; `spawn-console.ts` hands it to every
 * console a test starts. A test of the guard injects its own reading.
 */
import '../e2e/fixture/steady-load.mjs';
import { sweepBrokers } from './broker-sweep.ts';

const dir = mkdtempSync(join(tmpdir(), 'phase-console-state-'));

process.env.XDG_STATE_HOME = join(dir, 'state');
process.env.XDG_CONFIG_HOME = join(dir, 'config');
// …and which Claude Code config dirs the skill-copy reader counts (#151): an
// empty sandbox, so a console a test builds never reads the machine's plugins
// into its prompts, its inbox or its doctor.
process.env.PE_CLAUDE_CONFIG_DIRS = join(dir, 'claude');
// …and never a supervising console's idea of where a phase is judged
// (control-tower phase 106, #196): `phase-outcome.sh verified` keys a proof by
// `PE_VERIFY_DIR` and resolves `--in` against `PE_RUN_ROOT`, and a suite run
// by a session would otherwise refuse its fixtures' proofs against the
// session's own tree. A test that means them sets them.
delete process.env.PE_VERIFY_DIR;
delete process.env.PE_RUN_ROOT;

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

/**
 * A restart never updates the repository under test. A console restarts onto
 * the latest version of its copy since 2026-09-18 — fetch, fast-forward,
 * build — and a console a test starts runs FROM this repository, so a test that
 * pressed Restart once asked the real updater to move and rebuild the tree the
 * suite was running from. Off for every test and every console a test spawns
 * (they inherit this environment); a test that exercises the update injects a
 * stand-in for the updater and turns it back on for itself.
 */
process.env.PHASE_CONSOLE_SELF_UPDATE = '0';

/**
 * A declaration a test writes never asks a real console (control-tower phase
 * 50). `phase-outcome.sh` asks the console its repository resolves to whether
 * a watched ref has already landed, and a root nothing registered resolves to
 * the DEFAULT instance — port 4123, the operator's own console. Off for every
 * test and every script a test spawns; `declare-already-landed.test.ts` turns
 * it on against a console of its own.
 */
process.env.PHASE_OUTCOME_PROBE = '0';

/**
 * No test reaches the operator's login keychain (control-tower phase 116,
 * #200). A real `Service` builds its `Accounts` on the real `security`, and a
 * test that registered a token account through one wrote that token into the
 * keychain — and went red whenever the keychain was locked. `realExec` refuses
 * every keychain write, replace and delete in any test process; this arms the
 * same refusal for a test file run with plain `node`, which carries no test
 * marker, and for every console a test spawns. A test that needs a secret
 * stored gives the store a stub exec and `platform: 'linux'`, whose backend is
 * a 0600 file under this sandbox.
 */
process.env.PHASE_CONSOLE_KEYCHAIN = '0';

process.on('exit', () => {
  // Before the directory goes, so the pid files are still there to read.
  try { sweepBrokers(dir); } catch { /* a leftover broker is not a test failure */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* a leftover tmpdir is not a failure */ }
});

/** The sandbox root, for a test that wants to look at what was written. */
export const STATE_SANDBOX = dir;
