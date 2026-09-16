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
 *   **Ask the turn to close before you ask the process to leave.** SIGINT
 *   first, once, to the CLI itself. The CLI's own contract (chapter 09 row 57):
 *   SIGTERM leaves the turn unfinished and writes no `result`, SIGINT ends the
 *   turn. The `result` is the only place the CLI books a session's turns and
 *   dollars, so every ending the console caused used to be recorded as 0 turns
 *   and $0 — 18.99 hours of work in the audit's six plans. Measured on CLI
 *   2.1.270 (`test/fixtures/spikes/sigint.md`): SIGINT mid-tool, `result` 10 ms
 *   later, a clean exit 525 ms later. ONE SIGINT per process, whoever asks: the
 *   spawn's abort and a runner's ladder both reach for it, and the second
 *   caller waits out what is left of the first one's grace instead of asking
 *   again.
 *
 *   **Talk to the group, not the pid.** The CLI spawns bash, MCP servers and
 *   subagents; signalling the bare pid leaves them behind. `spawn.ts` starts
 *   the child `detached`, which gives it a group of its own, and the ladder
 *   addresses `-pid` with a `pid` fallback — the shape `terminal.ts` had
 *   already worked out for ptys. The interrupt is the one exception, and on
 *   purpose: it is a question for the CLI, which closes its own tool tree; the
 *   group still gets the SIGTERM and the SIGKILL.
 *
 *   **Always leave a backstop.** A child that ignores both gets SIGKILL after a
 *   grace. Where the console may not outlive the grace — shutdown — the caller
 *   awaits the ladder instead of arming a timer that dies with it. Both waits
 *   are POLLED, so a child that leaves at once releases the caller at once
 *   rather than after the whole grace.
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

/**
 * Send one signal to the process ITSELF, never its group — the interrupt's
 * sender. A SIGINT to the group would also reach the CLI's running `npm test`
 * and its MCP servers before the CLI had closed the turn around them; the CLI
 * is the one that knows how to end its own tools.
 */
export function leaderSignal(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
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
  /**
   * Ask the turn to close first (SIGINT, once per process). On by default;
   * off only for a child that has no turn to close — a verification command's
   * `bash -c` — where the interrupt would buy nothing but a delay.
   */
  interrupt?: boolean;
  /** How long the interrupt gets before SIGTERM. Defaults to `INT_GRACE_MS`. */
  interruptAfterMs?: number;
  /** The polite signal. `SIGTERM` lets the CLI run its own SessionEnd hooks. */
  term?: NodeJS.Signals;
  /** How long the polite signal gets before SIGKILL. */
  killAfterMs?: number;
  /** Test seams. `interruptSignal` falls back to `signal` when only that is given. */
  signal?: SignalFn;
  interruptSignal?: SignalFn;
  alive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** How a ladder ended, which is worth journalling. */
export type LadderEnding = 'gone' | 'interrupted' | 'exited' | 'killed';

export const DEFAULT_KILL_AFTER_MS = 15_000;

/**
 * How long a session gets to close its turn after SIGINT, before SIGTERM.
 *
 * Measured rather than guessed (`test/fixtures/spikes/sigint.md`, CLI 2.1.270,
 * three arms): the interrupted turn's `result` arrived 9–10 ms after the
 * signal and the process exited cleanly 523–525 ms after it. Five seconds is
 * ten times the exit — room for a loaded machine and for the session's own
 * SessionEnd hooks — and costs a healthy child nothing, because the wait is
 * polled. The shutdown arithmetic holds: this plus `SHUTDOWN_LADDER_MS` is
 * twenty seconds of the console's 120-second budget.
 */
export const INT_GRACE_MS = 5_000;

/** How often a ladder's wait asks whether the child has gone. */
const POLL_MS = 100;

/**
 * How long a sent SIGINT is remembered. Long enough that a second caller
 * arriving during the first one's grace — the spawn's abort and a runner's
 * ladder land in the same tick — shares it; short enough that a reused pid is
 * never refused its own interrupt. A ladder that settles forgets its pid at
 * once, so this bound only matters for a caller that never finishes one.
 */
const INTERRUPT_MEMORY_MS = 4 * INT_GRACE_MS;

/** pid → when it was last sent SIGINT. */
const interrupted = new Map<number, number>();

const wait = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

/** When this pid was sent its SIGINT, if that is still remembered. */
export function interruptedAt(pid: number, now = Date.now()): number | undefined {
  const at = interrupted.get(pid);
  if (at === undefined) return undefined;
  if (now - at > INTERRUPT_MEMORY_MS) {
    interrupted.delete(pid);
    return undefined;
  }
  return at;
}

/**
 * Wake a process and ask its turn to close — once.
 *
 * Returns true when it sent the interrupt, false when this pid was already
 * asked (and is still remembered) or is not a pid a signal may go to. The
 * waiting, and the insisting, are the caller's.
 */
export function interruptOnce(
  pid: number, options: Pick<LadderOptions, 'signal' | 'interruptSignal' | 'wake' | 'now'> = {},
): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  const now = (options.now ?? Date.now)();
  if (interruptedAt(pid, now) !== undefined) return false;
  const send = options.signal ?? groupSignal;
  if (options.wake !== false) send(pid, 'SIGCONT');
  (options.interruptSignal ?? (options.signal ? send : leaderSignal))(pid, 'SIGINT');
  for (const [known, at] of interrupted) {
    if (now - at > INTERRUPT_MEMORY_MS) interrupted.delete(known);
  }
  interrupted.set(pid, now);
  forgetPid(pid);
  return true;
}

/**
 * Forget a pid's interrupt — for an owner that has watched its process end.
 * A closed child's pid may be handed to a new process, which must be asked
 * afresh rather than refused its own interrupt.
 */
export function forgetInterrupt(pid: number | undefined): void {
  if (typeof pid === 'number') interrupted.delete(pid);
}

/** Wait up to `ms` for the pid to go, asking every `POLL_MS`. True when it went. */
async function goneWithin(
  pid: number, ms: number, alive: (pid: number) => boolean, sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  let waited = 0;
  do {
    const step = Math.min(POLL_MS, Math.max(0, ms - waited));
    await sleep(step);
    waited += step;
    forgetPid(pid);                     // the cached sample predates the signals
    if (!alive(pid)) return true;
  } while (waited < ms);
  return false;
}

/**
 * Wake a process, ask its turn to close, ask it to stop, and kill it if it
 * will not — awaited, so the caller can be sure the child is gone before it
 * moves on.
 *
 * Returns how it ended, which is worth journalling: `gone` means it was
 * already over, `interrupted` that SIGINT was enough, `exited` that SIGTERM
 * was, and `killed` that neither was.
 */
export async function killLadder(pid: number, options: LadderOptions = {}): Promise<LadderEnding> {
  const send = options.signal ?? groupSignal;
  const alive = options.alive ?? stillThere;
  const sleep = options.sleep ?? wait;
  const now = options.now ?? Date.now;
  const grace = options.killAfterMs ?? DEFAULT_KILL_AFTER_MS;
  const interruptGrace = options.interruptAfterMs ?? INT_GRACE_MS;

  if (!alive(pid)) {
    interrupted.delete(pid);
    return 'gone';
  }

  // The line this whole module exists for.
  if (options.wake !== false) send(pid, 'SIGCONT');

  try {
    if (options.interrupt !== false) {
      // Asked already — by the spawn's own abort, or a ladder a moment ago —
      // means this caller shares that grace rather than starting a second one.
      const askedAt = interruptedAt(pid, now());
      if (askedAt === undefined) {
        interruptOnce(pid, { signal: send, interruptSignal: options.interruptSignal, wake: false, now });
      }
      const remaining = askedAt === undefined ? interruptGrace : Math.max(0, interruptGrace - (now() - askedAt));
      if (await goneWithin(pid, remaining, alive, sleep)) return 'interrupted';
    }

    send(pid, options.term ?? 'SIGTERM');
    if (await goneWithin(pid, grace, alive, sleep)) return 'exited';

    send(pid, 'SIGKILL');
    forgetPid(pid);
    return 'killed';
  } finally {
    // The process is over, one way or the other; its pid may be reused.
    interrupted.delete(pid);
  }
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
