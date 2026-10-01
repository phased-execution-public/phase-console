/**
 * Spawning a real console, without spending the operator's own machine to do it.
 *
 * Four test files boot `server/index.ts` for real, because a console is the only
 * honest way to test static serving, access rules, the terminal socket and
 * shutdown. Each of them used to spawn it bare — inheriting the environment,
 * which means:
 *
 *   - the console read and wrote `~/.config/phase-console/config.json`, the
 *     operator's actual preferences, remembered roots and notification switches;
 *   - with no `--root`, it opened whatever plan library that config remembered —
 *     on a working machine, the operator's real one — and started a file watcher,
 *     a scheduler and a runner against it.
 *
 * A test suite that boots live machinery against real work is one accident away
 * from writing to it, and a stray phase lock in a real handoff folder blocks
 * real sessions on plans that have nothing to do with the test. (One did: a
 * `test…/test` claim, found in a real `.locks/` directory and blamed
 * on "a test run".)
 *
 * So every spawned console gets its own `XDG_CONFIG_HOME` — the whole of what a
 * console persists — and, when it needs a plan library at all, a throwaway one.
 * `--root` stays opt-in on purpose: a console started without it opens nothing,
 * which is the state several of these tests are specifically about, and handing
 * one a library by default would quietly delete that case.
 * `test/state-isolation.test.ts` keeps both rules honest.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sweepBrokers } from './broker-sweep.ts';

/**
 * The machine load a console under test reads: held still, as the e2e fixture
 * holds its own (`steady-load.mjs`, loaded first through NODE_OPTIONS). On a
 * busy machine the load guard holds every new admission (control-tower phase
 * 100), so a spawned console asked to run a phase never boarded it.
 */
const STEADY_LOAD = `--import=${new URL('../e2e/fixture/steady-load.mjs', import.meta.url).href}`;

export type ConsoleSandbox = {
  /** `XDG_CONFIG_HOME` — preferences, remembered roots, notification switches. */
  configHome: string;
  /**
   * `XDG_STATE_HOME` — and the one that actually reaches people. The console's
   * state directory holds `push/subscriptions.json`, the operator's real
   * subscribed browsers and phones, so a spawned console that inherits it can
   * and does deliver push notifications to them. A shutdown test's console
   * announcing its own shutdown is not a test artefact once it lands on
   * someone's phone. It also holds the notification inbox, approvals and every
   * run journal.
   */
  stateHome: string;
  /** A throwaway plan library, so the console never opens a real one. */
  root: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
};

/**
 * A temporary home and a one-plan library for a console under test.
 *
 * The plan is minimal but real: a console pointed at an empty directory reports
 * "not a plan library" and half its routes answer 404, which is not the console
 * any of these tests mean to be testing.
 */
export function sandbox(label = 'console'): ConsoleSandbox {
  const dir = mkdtempSync(join(tmpdir(), `phase-console-${label}-`));
  const configHome = join(dir, 'config');
  const stateHome = join(dir, 'state');
  const root = join(dir, 'root');
  mkdirSync(configHome, { recursive: true });
  mkdirSync(stateHome, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), DEMO_PLAN);

  return {
    configHome,
    stateHome,
    root,
    // A console a test starts never updates the repository it runs from, and
    // reads a quiet machine (see state-sandbox.ts) — restated here, where the
    // environment is handed over.
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
      PHASE_CONSOLE_SELF_UPDATE: '0',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, STEADY_LOAD].filter(Boolean).join(' '),
    },
    cleanup: () => {
      // A console under test is KILLED, not shut down, and since Phase 7 its
      // ptys belong to a broker that survives exactly that. Right in
      // production, a leaked login shell here — the broker never retires while
      // it holds one, so nothing would ever end it. Swept before the directory
      // goes, because the pid file is inside it.
      try { sweepBrokers(dir); } catch { /* a leftover broker is not a test failure */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Spawn `server/index.ts` inside a sandbox. `args` is whatever the test is
 * actually about; pass `withRoot` when it needs a plan library open, and the
 * sandbox's throwaway one is used — never `--root` by hand.
 */
export function spawnConsole(
  viewerDir: string,
  port: number,
  args: string[] = [],
  opts: {
    env?: NodeJS.ProcessEnv;
    sandbox?: ConsoleSandbox;
    withRoot?: boolean;
    /**
     * `'pipe'` when the test is about what the console SAYS — the port-collision
     * message is the one whose whole content is the behaviour under test, and
     * `'ignore'` would throw it away. Everything else stays silent by default:
     * a suite that prints every console's startup banner is unreadable.
     */
    stdio?: 'ignore' | 'pipe';
    /**
     * The script node runs — this tree's `server/index.ts` unless a test is
     * about another build of it: the Pro package's bundled `server/index.js`, or
     * the `phase-console` bin an install put on PATH (control-tower phase 68).
     * Same sandbox, same arguments, whichever it is.
     */
    entry?: string;
    /**
     * Give the child its OWN process group (pgid = its own pid) rather than
     * inheriting this one's. Pass this when `entry` is a shim that may fork a
     * server of its own (the `phase-console` bin does, at the end of
     * `bin/phase-console.mjs`): a bare `child.kill('SIGKILL')` on a
     * non-detached shim only ever reaches the shim itself, and the server it
     * forked survives it as an orphan (#155) — `stopConsole` below is the
     * teardown that goes with this flag.
     */
    detached?: boolean;
  } = {},
): { child: ChildProcess; box: ConsoleSandbox } {
  const box = opts.sandbox ?? sandbox();
  const child = spawn(process.execPath, [
    opts.entry ?? join(viewerDir, 'server', 'index.ts'),
    '--port', String(port), '--no-open', '--no-log-file',
    ...(opts.withRoot ? ['--root', box.root] : []),
    ...args,
  ], { stdio: opts.stdio ?? 'ignore', env: { ...box.env, ...opts.env }, detached: opts.detached ?? false });
  return { child, box };
}

/**
 * Stop a console spawned with `detached: true` — the process GROUP, TERM
 * then KILL, so a shim that forked a server of its own takes it down too
 * (#155: `child.kill('SIGKILL')` alone only ever reached the shim, whose
 * SIGCONT/SIGTERM/SIGHUP forwarding — the end of `bin/phase-console.mjs` —
 * never runs for a signal it cannot catch, and the server it forked lived on
 * as an orphan). Safe to call on a child that has already exited: signalling
 * a group nobody is left in is not an error here, it is the point.
 */
export async function stopConsole(child: ChildProcess, opts: { graceMs?: number } = {}): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const alive = (): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
  const graceMs = opts.graceMs ?? 2000;
  const deadline = Date.now() + graceMs;
  while (alive() && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  if (alive()) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

const DEMO_PLAN = `---
slug: demo
created: 2026-01-01
status: active
phases: 2
handoffs: docs/handoffs/demo/
memory: project_demo
---

# Demo

## Session budget

- **Target model:** \`claude-opus-5\` · **budget:** ~200K phase weight per session.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|---|---|---|---|---|---|
| 1 | First | — | — | demo | it works |
| 2 | Second | 1 | — | demo | it still works |

## Phases

### Phase 1 — First

- **Size:** S

### Phase 2 — Second

- **Size:** S
`;
