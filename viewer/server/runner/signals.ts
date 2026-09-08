/**
 * The one way to signal a child — wake it, ask it, then insist.
 *
 * The console had six of these ladders and they did not agree. `stop()` and
 * `stopPhase()` sent SIGCONT, then SIGTERM, then SIGKILL on a grace, each with
 * a comment explaining why the wake had to come first. `escalateFreeze()` and
 * `checkpointLane()` woke the child but armed no backstop. And two paths did
 * neither: `checkpointForShutdown()` and `spawn.ts`'s abort handler sent a bare
 * SIGTERM.
 *
 * That last omission is not a style problem. **A stopped process cannot act on
 * SIGTERM** — the signal is queued against it and its handler never runs — so a
 * console shutting down while a lane was frozen left the child stopped forever.
 * It happened: a phase-9 session was frozen at 17:56:38, the console shut down
 * twelve seconds later, and the child was still sitting in state `T` three
 * hours later, holding its session id, its 218 MB and three unreaped zombies,
 * while the run that owned it had been parked and its lock released as debris.
 *
 * So: one function, and a rule with nowhere left to forget it.
 *
 *   **Wake before you ask.** Every teardown SIGCONTs first, unconditionally.
 *   It costs nothing on a process that was never stopped, and it is the
 *   difference between a graceful exit and an orphan on one that was.
 *
 *   **Talk to the group, not the pid.** The CLI spawns bash, MCP servers and
 *   subagents; signalling the bare pid leaves them behind. `spawn.ts` starts
 *   the child `detached`, which gives it a group of its own, and the ladder
 *   addresses `-pid` with a `pid` fallback — the shape `terminal.ts` had
 *   already worked out for ptys.
 *
 *   **Always leave a backstop.** A child that ignores SIGTERM gets SIGKILL
 *   after a grace. Where the console may not outlive the grace — shutdown —
 *   the caller awaits the ladder instead of arming a timer that dies with it.
 *
 * `test/invariants.test.ts` greps `server/` and asserts this file is the only
 * place `process.kill(pid, <signal>)` appears, the same shape as the
 * `sizing.env` single-source rule. (`server/pid.ts` may use `kill(pid, 0)`;
 * that is a question, not a signal.)
 */

import { forgetPid, processState } from '../pid.ts';

/** Send one signal to a pid's process GROUP, falling back to the pid alone. */
export type SignalFn = (pid: number, signal: NodeJS.Signals) => void;

/**
 * The real sender. `-pid` reaches the child and everything it started; the
 * fallback covers a child that is not a group leader (no `detached`, or a
 * platform that ignored it) and a group that has already gone.
 *
 * Deliberately silent on failure: every caller is tearing something down, and
 * "it was already gone" is a success at every one of them.
 */
export function groupSignal(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return;   // never signal pid 0/1: that is "the whole group" or init
  try { process.kill(-pid, signal); return; } catch { /* no group of that id */ }
  try { process.kill(pid, signal); } catch { /* already gone */ }
}

/** Is this pid still there, in any state? The probe, not a second opinion. */
function stillThere(pid: number): boolean {
  return processState(pid) !== 'gone';
}

export type LadderOptions = {
  /**
   * Wake the process first. On by default and effectively never off — the
   * seam exists so a test can prove the wake happens rather than to give
   * callers a way to skip it.
   */
  wake?: boolean;
  /** The polite signal. `SIGTERM` lets the CLI run its own SessionEnd hooks. */
  term?: NodeJS.Signals;
  /** How long the polite signal gets before SIGKILL. */
  killAfterMs?: number;
  /** Test seams. */
  signal?: SignalFn;
  alive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_KILL_AFTER_MS = 15_000;

const wait = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

/**
 * Wake a process, ask it to stop, and kill it if it will not — awaited, so the
 * caller can be sure the child is gone before it moves on.
 *
 * Returns how it ended, which is worth journalling: `gone` means it was
 * already over, `exited` that SIGTERM was enough, and `killed` that it was not.
 */
export async function killLadder(
  pid: number, options: LadderOptions = {},
): Promise<'gone' | 'exited' | 'killed'> {
  const send = options.signal ?? groupSignal;
  const alive = options.alive ?? stillThere;
  const sleep = options.sleep ?? wait;
  const grace = options.killAfterMs ?? DEFAULT_KILL_AFTER_MS;

  if (!alive(pid)) return 'gone';

  // The line this whole module exists for.
  if (options.wake !== false) send(pid, 'SIGCONT');
  send(pid, options.term ?? 'SIGTERM');

  await sleep(grace);
  forgetPid(pid);                       // the cached sample predates the signals
  if (!alive(pid)) return 'exited';

  send(pid, 'SIGKILL');
  forgetPid(pid);
  return 'killed';
}

/**
 * Wake a process and ask it to stop, without waiting — for callers that arm
 * their own backstop or hand the wait to somebody else.
 *
 * Still wakes first. That is the invariant; the waiting is the caller's.
 */
export function wakeAndTerm(
  pid: number, options: Pick<LadderOptions, 'term' | 'signal' | 'wake'> = {},
): void {
  const send = options.signal ?? groupSignal;
  if (options.wake !== false) send(pid, 'SIGCONT');
  send(pid, options.term ?? 'SIGTERM');
  forgetPid(pid);
}

/** Let a stopped process run again. The undo of a freeze, and nothing more. */
export function wake(pid: number, options: Pick<LadderOptions, 'signal'> = {}): void {
  (options.signal ?? groupSignal)(pid, 'SIGCONT');
  forgetPid(pid);
}

/** Stop a process where it stands. The freeze verb. */
export function stopWhereItStands(pid: number, options: Pick<LadderOptions, 'signal'> = {}): void {
  (options.signal ?? groupSignal)(pid, 'SIGSTOP');
  forgetPid(pid);
}
