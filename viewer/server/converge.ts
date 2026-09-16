/**
 * The convergence loop — "converge, classify, climb" with nobody looking.
 *
 * Everything the console can decide about a STOPPED run, it decides here, on
 * a clock as well as on events: at boot, when the docs change, every
 * `convergeEveryMs`, a minute after a halt, and on the operator's Recover &
 * continue press. One orchestration, through the runner — this loop never
 * spawns a session itself; it releases what is dead, hints boardings, writes
 * errands, and hands the run back to `startRun`, which is the only thing that
 * drives phases. Before it existed the same work ran only on live ticks, on
 * HTTP reads, or sixty seconds after a halt: a plan nobody looked at healed
 * nobody, and a lane the console's own restart killed stayed dead until a
 * person pressed Continue.
 *
 * Three parts, kept apart so each can be tested without the others:
 *
 *   `planConvergence(facts)` — PURE. Reads the plan's runs, their records,
 *   the locks and the board, and returns typed actions with the reason for
 *   each — including the reasons for doing NOTHING (a run the operator
 *   stopped, a resolved run, a live run), because "the loop looked and left it
 *   alone" is an answer the Pulse must be able to show.
 *
 *   `executeConvergence(plan, deps)` — the executor: releases debris locks,
 *   relaunches the run with re-board hints, writes errands, and runs the
 *   healer (`Service.maybeAutoRecover`: classify + ladder + drive, which
 *   predates this loop and is now its rung-climbing step).
 *
 *   `ConvergeScheduler` — the clock: per-plan debounce for docs changes, the
 *   quiet minute after a halt, the periodic sweep, single-flight per plan.
 *   Timers come from an injectable clock so a test can drive five minutes in
 *   five milliseconds.
 *
 * Two promises the code is built around. **An operator's stop is respected**:
 * a run paused or stopped by a person (`stoppedBy: 'operator'`), or one a
 * person dismissed (`resolved`), is pinned — the loop reads it and leaves it,
 * and only the operator's own press overrides that. **Every act is journalled
 * and bounded**: debris releases and boot resumes each carry a journal line on
 * the run they touch, a boot resume is capped per phase, and the ladder's own
 * caps (count and dollars) bound everything the healer launches.
 */

import { LOCK_CAP_PARK_BY_CAP, LOCK_CAP_PARK_BY_LOCK, type ReboardRequest } from './runner/runner.ts';
import { autopilotRunId, debrisLocks, type LockView } from './runner/scheduler.ts';
import { sameErrand } from './runner/ladder.ts';
import {
  CONSOLE_STOPPED_NOTE, IN_FLIGHT, childrenOf, resetForRetry, pidAlive as realPidAlive,
  processState as realProcessState, waitClockOf, waitReasonOf, type ProcessState,
  type Errand, type PhaseRecord, type RunState,
} from './runner/state.ts';
import { log } from './log.ts';
import { doorActor, viaOfTrigger, type StartActor } from './actor.ts';
import { WATCH_INELIGIBLE_ROW_STATES, WATCH_INELIGIBLE_STATUSES } from './watch-refs.ts';
import type { Presence } from '../shared/run-lifecycle.js';
import type {
  ConvergeTrigger as ConvergeTriggerWord, ResumePath, ResumeTrigger,
} from '../shared/run-lifecycle.js';
import { resumeAtBootMode } from '../shared/automation-model.js';

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

export type ConvergeTrigger = ConvergeTriggerWord;

/** Trailing debounce for a docs change: a handoff commit lands as a burst of writes. */
export const CHANGE_DEBOUNCE_MS = 2_000;
/**
 * The quiet minute after a halt. The halt event fires while lanes are still
 * draining and the operator may be watching and about to act; a console that
 * launches something the same second something breaks is a console nobody
 * can get ahead of. (The value `scheduleAutoRecover` always used.)
 */
export const HALT_DELAY_MS = 60_000;
/** The periodic sweep's floor — a preference below it is read as this. */
export const MIN_SWEEP_MS = 30_000;
/** The periodic sweep's default, when the preference says nothing. */
export const DEFAULT_SWEEP_MS = 300_000;
/**
 * How many times one phase's own session is resumed after console restarts
 * killed its lane. A lane killed by three restarts in a row is a console
 * problem a person should hear about — not a loop to run for ever.
 */
export const MAX_BOOT_RESUMES = 3;

/**
 * The run-level halts nobody but a person's press relaunches (phase 9).
 *
 * `failure-streak` is the run's one "this plan is broken, stop" bound, and the
 * loop's own relaunch used to answer it — and zero the counter on the way in
 * (RCV-3: 25 resets against 3 such halts). `credential-refused` opens only
 * when a person clears the account in the breaker, so a relaunch by clock
 * meets the same wall at the preflight and parks again (RCV-1). The heal
 * pass still classifies their phases and climbs, bounded by RCV-9's
 * fingerprint; only the run-level relaunch is a person's.
 */
export const PRESS_ONLY_HALT_KINDS: readonly string[] = Object.freeze(['failure-streak', 'credential-refused']);

/**
 * How far past its own `waitUntil` a sleeping run may read before the loop
 * stops trusting "the wait re-arms itself" and resumes it. The grace is for
 * the armed timer's own fire — inside it, both would race to the same
 * `startRun`; past it, the timer is provably gone.
 */
export const WAIT_OVERDUE_GRACE_MS = 60_000;

const DEFAULT_DELAY: Record<ConvergeTrigger, number> = {
  boot: 0, button: 0, timer: 0, change: CHANGE_DEBOUNCE_MS, halt: HALT_DELAY_MS,
};

/** What the planner reads. Everything is a value; nothing here talks to a disk or a process. */
export type ConvergeFacts = {
  slug: string;
  /** Epoch ms. */
  now: number;
  trigger: ConvergeTrigger;
  /** The engine's board states for the plan, or null when it could not be read. */
  board: Record<number, string> | null;
  /** Every run of the plan, newest first, as loaded (already reconciled). */
  runs: readonly RunState[];
  /** Ids of runs this console is driving right now. */
  live: ReadonlySet<string>;
  /** Locks on disk for this plan, any phase. */
  locks: readonly LockView[];
  /**
   * Does the fleet have a lane free right now — the ONE question a session-cap
   * park has, and the reason `LOCK_CAP_PARK_BY_CAP` may be re-armed where a
   * grant park may not (D28/P8).
   *
   * Absent means no answer, which reads as NO and re-arms nothing. This pass
   * runs in fixtures and could run in a console with no scheduler, and a park
   * cleared on a guess re-boards straight back into the same full fleet.
   */
  laneFree?: () => boolean;
  prefs: { resumeAtBoot?: boolean | string };
  /**
   * What the operator has already said about picking this run back up
   * after the console restart that stopped it, for THIS console boot.
   * Absent means nobody has been asked yet.
   */
  resumeDecision?: (runId: string) => 'continue' | 'dismiss' | null;
  /** Is a recorded child pid still alive? Injectable so a fixture can say. */
  pidAlive?: (pid: number) => boolean;
  /**
   * The four-valued probe. Separate from `pidAlive` because the answer that
   * matters here is the one a boolean cannot give: a `stopped` orphan is not
   * a process to wait for, it is a process nothing will ever resume.
   */
  processState?: (pid: number) => ProcessState;
  /**
   * The session registry's word on the session a lock names (Phase 5):
   * `ended` — its SessionEnd arrived or its process is gone, so the lock is
   * debris NOW whatever the lease says; `live` — a person is in it; `unknown`
   * — nothing reports it and lease rules decide. Absent: every lock `unknown`.
   */
  presence?: (lock: LockView) => Presence;
  /**
   * The plan's gate decisions, as a cheap stamp (`gate-status.md`'s mtime and
   * size). It is in the FACTS because it is in the fingerprint: approving a
   * manual gate changes neither the run, its records, nor the board word — the
   * phase reads `ready` before and after — so without this the healer's "found
   * nothing to climb" latches forever and the person who did exactly what the
   * errand asked is never answered. Null when the file does not exist yet.
   */
  gateStamp?: string | null;
  /**
   * The QA verdicts the board reported (`--memory-block`'s `blocked:` line),
   * keyed by the phase whose verdict holds others. In the FACTS because it is
   * in the fingerprint, for exactly the reason `gateStamp` is: recording a
   * verdict changes neither the run, its records, nor the blocking phase's
   * board word.
   */
  qa?: Record<number, string> | null;
  /**
   * The fingerprint of the latest run's open records at the last pass that
   * healed nothing. The same evidence yields the same answer, so the healer —
   * and its journal lines — are not run again until something changes.
   * Ignored on the operator's press, which always asks afresh.
   */
  lastNoop?: string | null;
};

export type ConvergeAction =
  /**
   * A lock held by a run nothing is driving, or by a session the registry
   * shows ENDED: released through the runner's own owner. `runId` is the dead
   * run's for the first shape and null for a session's claim (a person's, or
   * another console's) — the journal line then goes on the plan's latest run.
   */
  | { kind: 'release-debris'; runId: string | null; phase: number; owner: string; why: string; session?: string }
  /**
   * Start the run again under normal admission: killed lanes re-board with a
   * hint (their own session where one exists), lock-cap parks whose lock is
   * gone are reset, and a run the console's own shutdown stopped simply
   * continues. ONE launch per run, whatever the reasons.
   */
  | {
    kind: 'relaunch'; runId: string; reboard: ReboardRequest[]; rearm: number[]; why: string[];
    /**
     * The phases this launch resumes automatically, beyond the killed lanes in
     * `reboard` — each is counted against `MAX_BOOT_RESUMES` and journalled
     * `phase.resume-automatic` by the executor (LFC-7).
     */
    counted?: { phase: number; path: ResumePath; sessionId?: string }[];
    /** A wait whose clock went by while nothing ran: the launch is the overdue ruling, not a bare start. */
    wait?: { until: string; lateByMs: number; phases: number[] };
    /** Launched on the operator's `continue` — spent by this launch, so the next restart asks again. */
    decided?: true;
  }
  /** A person is asked, once, with what is needed and how to give it. `phase` null = run level. */
  | { kind: 'errand'; runId: string; phase: number | null; errand: Errand; why: string }
  /** Classify the open phases and climb the ladder — the healer. */
  | { kind: 'heal'; runId: string; fingerprint: string; why: string }
  /**
   * A console restart stopped this run, and the operator has not said whether
   * to pick it up. Nothing is launched and no errand is written: the run waits,
   * and the app asks on its next load.
   *
   * This is `resumeAtBoot: 'ask'`, the shipped default since 3.5.0. A restart
   * used to mean every interrupted run started spending again the moment the
   * console came back — correct for an unattended fleet and startling for a
   * person who restarted the console to change a setting, because the first
   * thing it did was board sessions they had not asked for and could not see
   * coming. `'auto'` is the old behaviour, kept and one word away.
   */
  | { kind: 'await-decision'; runId: string; phases: number[]; sessions: string[]; why: string }
  /** Looked, and left it alone — with the reason. */
  | { kind: 'skip'; runId: string | null; why: string };

export type ConvergePlan = {
  slug: string;
  trigger: ConvergeTrigger;
  at: string;
  actions: ConvergeAction[];
};

/* ------------------------------------------------------------------ *
 * Reading a run
 * ------------------------------------------------------------------ */

/**
 * Was this run's last stop the operator's? `stoppedBy` answers when it is
 * there. Records written before the field existed fall back on the shapes the
 * operator's verbs have always written — a pause, a stop in flight, the
 * stored-run "stopped by the operator" halt — and on nothing else: a halt or
 * a park the loop wrote itself is the system's.
 */
export function stoppedByOperator(run: RunState): boolean {
  if (run.stoppedBy) return run.stoppedBy === 'operator';
  if (run.status === 'paused' || run.status === 'pausing' || run.status === 'stopping') return true;
  if (run.pause) return true;
  if (run.halt?.reason === 'stopped by the operator') return true;
  return false;
}

/**
 * Nothing is driving this run and nothing will: not this console, not a
 * process still claiming it in flight, not an orphaned session still writing.
 * Its lanes are gone and its locks are debris.
 */
export function runIsDead(
  run: RunState, live: ReadonlySet<string>, pidAlive: (pid: number) => boolean = realPidAlive,
): boolean {
  if (live.has(run.id)) return false;
  if (IN_FLIGHT.includes(run.status) || run.status === 'queued') return false;
  if (childrenOf(run).some((child) => pidAlive(child.pid))) return false;
  return true;
}

/** The run a plan is "on" — the same answer `latestRun` gives: the one still open, else the newest. */
export function latestOf(runs: readonly RunState[]): RunState | null {
  return runs.find((run) => run.status !== 'finished') ?? runs[0] ?? null;
}

/** The killed-lane records: interrupted by a console that went away, and not done since. */
export function killedLanes(run: RunState, board: Record<number, string>): PhaseRecord[] {
  return Object.values(run.phases)
    .filter((record) => record.status === 'interrupted' && CONSOLE_STOPPED_NOTE.test(record.note ?? ''))
    .filter((record) => board[record.phase] !== 'done')
    .sort((a, b) => a.phase - b.phase);
}

/** Is the phase's lock held, unexpired — and not by a session that has ended — by anyone but this run? */
function heldByAnother(
  locks: readonly LockView[], phase: number, runId: string, now: number,
  presence?: (lock: LockView) => Presence,
): boolean {
  return locks.some((lock) => lock.phase === phase
    && autopilotRunId(lock.owner) !== runId
    && !lock.expired
    && (lock.leaseUntil == null || lock.leaseUntil > now)
    && presenceOfLock(lock, presence) !== 'ended');
}

function presenceOfLock(lock: LockView, presence?: (lock: LockView) => Presence): Presence {
  if (!lock.session || !presence) return 'unknown';
  try { return presence(lock); } catch { return 'unknown'; }
}

/**
 * Locks whose SESSION the registry shows ended — a person's claim, another
 * console's, an autopilot lane's whose run is still on disk as live elsewhere
 * — minus this console's own live runs' claims (their runners release their
 * own). Only a lock that NAMES its session can be debris this way: matching a
 * session to a lock by owner and time is display, never release.
 */
export function endedSessionLocks(
  locks: readonly LockView[], live: ReadonlySet<string>,
  presence?: (lock: LockView) => Presence,
): LockView[] {
  return locks.filter((lock) => {
    if (!lock.session) return false;
    const runId = autopilotRunId(lock.owner);
    if (runId && live.has(runId)) return false;
    return presenceOfLock(lock, presence) === 'ended';
  });
}

/**
 * The evidence the healer would read, as a string: the same evidence gives the
 * same verdict, and a verdict of "nothing to climb" need not be re-derived —
 * and re-journalled — every five minutes. Locks are part of it (a holder
 * releasing IS a change); the clock is not — with ONE deliberate exception at
 * the bottom of this function, the watch schedule, which earns it by measuring
 * something outside this console rather than something inside it.
 *
 * `gateStamp` is part of it for the same reason locks are, and it is the one
 * that was missing: clearing a manual gate changes nothing else this function
 * reads — not the run, not its records, not the board word — so the healer kept
 * skipping with "nothing has changed" against a gate a person had just
 * approved.
 */
export function evidenceFingerprint(
  run: RunState, board: Record<number, string>, locks: readonly LockView[], gateStamp?: string | null,
  qa?: Record<number, string> | null, now: number = Date.now(),
): string {
  const phases = Object.values(run.phases)
    .sort((a, b) => a.phase - b.phase)
    // `halt.at` is here for the same reason `run.halt.at` is: since the
    // halt-kind split a phase-level ending writes `record.halt` and leaves the
    // RUN's status untouched, so a phase that just failed its verification
    // changed nothing else this function reads — and the loop skipped it with
    // "nothing has changed", for ever.
    .map((r) => [r.phase, r.status, r.attempts, r.endedAt ?? '', (r.note ?? '').slice(0, 120), board[r.phase] ?? '', r.halt?.at ?? '']);
  // WHO holds what, and whether it has lapsed — never `leaseUntil` itself.
  //
  // That value is a TIMER. A live lane refreshes its own claim every ten
  // minutes (`LEASE_REFRESH_MS`), which moved `leaseUntil` forward, which
  // changed this fingerprint, which told the healer "something has changed" —
  // from a lane that had done nothing at all. The keepalive exists so a long
  // phase cannot silently lose its claim mid-work; it is evidence that a
  // process is alive and never evidence that it is PROGRESSING, and the two
  // are exactly what a squatting session makes indistinguishable. The comment
  // above has always said "the clock is not" part of the evidence; this is the
  // clock.
  //
  // The transitions that genuinely matter all survive: a holder appearing or
  // releasing changes the list, a takeover changes `owner`, and a lease running
  // out changes `expired` — which `parse/folder.ts` derives from `leaseUntil`
  // against the read clock, so the lapse still registers the tick it happens.
  const held = locks
    .map((l) => [l.phase, l.owner, l.expired ? 1 : 0])
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  // The WHOLE board, not just the phases this run happens to hold a record for.
  // `phases` above samples `board[r.phase]`, so a phase that was never boarded
  // going `waiting` -> `ready` — which is precisely the event meaning "this run
  // can move again" — did not register at all, and the loop that exists to
  // notice it skipped with "nothing has changed".
  const words = Object.keys(board)
    .map(Number).filter(Number.isFinite).sort((a, b) => a - b)
    .map((p) => [p, board[p]]);
  // And the QA verdicts, for the same reason the gate stamp is here: recording
  // pass or waived for the phase whose verdict wedged the plan moves neither
  // the run, nor its records, nor that phase's board word — it reads `done`
  // before and after. Without this the healer's "found nothing to climb"
  // latches for ever against a plan a person has just repaired.
  const verdicts = Object.keys(qa ?? {})
    .map(Number).filter(Number.isFinite).sort((a, b) => a - b)
    .map((p) => [p, qa![p]]);
  // And the watch schedule — the ONE deliberate exception to "the clock is not
  // part of the evidence", and it earns the exception by being the only clock
  // here that measures something outside this console.
  //
  // The rule the lease taught is intact: a value that moves while nothing
  // happens must not enter this string. `min(nextDueAt)` does not move while
  // nothing happens — it moves when the watch scheduler probes a ref and
  // reschedules it, which IS an event. But a ref that has come DUE and has not
  // been probed yet is exactly the case the latch used to swallow: nothing
  // about the run, the board, the locks or the schedule has changed, and the
  // healer skipped with "nothing has changed" against a workflow run that had
  // finished (measured: filters p12, two days parked on a `gh run rerun`). So
  // while something is overdue the term becomes the current MINUTE, which
  // advances — the latch cannot hold across the sweep — and goes back to being
  // the stable schedule the moment the probe lands. At most one extra pass per
  // minute per plan, and only while a probe is genuinely late.
  let soonest: number | null = null;
  for (const record of Object.values(run.phases)) {
    // Only phases the scheduler will actually probe. A row left on a phase that
    // has since gone `done` or `running` is never advanced by anybody, so its
    // past `nextDueAt` would read as "due" on every pass and the term would
    // change every minute for ever — defeating the noop latch permanently,
    // which is the exact "permanent spin" the latch's own comment below exists
    // to stop (QA F3). One list, two readers: `watch-scheduler.ts` skips these
    // phases and this skips their rows.
    if (WATCH_INELIGIBLE_STATUSES.has(record.status)) continue;
    for (const row of record.watchState?.refs ?? []) {
      if (row.nextDueAt === undefined) continue;
      // …and only rows the scheduler will advance: a `refused` row is terminal,
      // and one written before its clock was dropped would move the term every
      // minute for ever (SLF-7).
      if (WATCH_INELIGIBLE_ROW_STATES.has(row.state)) continue;
      if (soonest === null || row.nextDueAt < soonest) soonest = row.nextDueAt;
    }
  }
  const watch = soonest === null ? ''
    : soonest <= now ? `due@${Math.floor(now / 60_000)}`
      : `next@${Math.floor(soonest / 60_000)}`;
  return JSON.stringify([run.id, run.status, run.halt?.at ?? '', run.halt?.reason ?? '', run.resolved?.at ?? '', phases, held, gateStamp ?? '', words, verdicts, watch]);
}

export function resumeErrand(
  phase: number, at: string, why: 'off' | 'capped', sessionId?: string, shape: 'lane' | 'wait' = 'lane',
  /** Whose word refused it: the run's own `resumeOnRestart: false` or the console's `resumeAtBoot: off`. */
  refusedBy: 'run' | 'console' = 'console',
): Errand {
  const session = sessionId ? `session ${sessionId}` : 'its session';
  const switchedOff = refusedBy === 'run'
    ? 'this run was launched with resume-on-restart off'
    : shape === 'wait'
      ? 'resuming what a restart stopped is switched off on this console'
      : 'resuming killed lanes at boot is switched off on this console';
  return {
    phase,
    situation: shape === 'wait' ? 'waiting-external' : 'work-in-progress',
    decisionKey: 'resume.on-restart',
    tried: why === 'capped' ? [`resume-at-boot ×${MAX_BOOT_RESUMES}`] : [],
    need: why === 'off'
      ? shape === 'wait'
        ? `Someone to continue phase ${phase} — its wait clock went by while the console was not running, `
          + `and ${switchedOff}.`
        : `Someone to continue phase ${phase} — its lane was cut off by a console restart, and ${switchedOff}.`
      : `A look at phase ${phase} before it is resumed again — the console has resumed ${session} after `
        + `${MAX_BOOT_RESUMES} restarts in a row and the phase still has not landed.`,
    how: why === 'off'
      ? refusedBy === 'run'
        ? 'Press Continue on the run (it resumes the session); the run\'s own answer stands for the next restart.'
        : 'Press Continue on the run (it resumes the session), or turn Settings ▸ Automation ▸ Resume at boot on '
          + 'and the console does it by itself next time.'
      : 'Open the phase (Why is this not done?), then Continue or Retry — or stop the run if it should not go on.',
    at,
  };
}

/* ------------------------------------------------------------------ *
 * The one gate every automatic resume passes
 * ------------------------------------------------------------------ */

export type ResumeGate = 'proceed' | 'ask' | 'dismissed' | 'off' | 'capped';

/**
 * May the console resume this by itself, now?
 *
 * Six paths resume a phase with no person in the loop (`RESUME_PATHS`), and
 * the shipped answer to "shall I carry on?" (`resumeAtBoot`) and its counter
 * (`MAX_BOOT_RESUMES`) bounded exactly two of them: an armed wait, a lock-cap
 * re-arm, a shutdown between lanes and a hand session's `partial` resumed with
 * no ask and no count, and the armed wait fired 581 minutes late (LFC-7). One
 * function now, so the paths cannot disagree again:
 *
 *  - a resume the console's own RESTART caused — a killed lane, a run a
 *    shutdown stopped, a wait whose clock went by while nothing ran — answers
 *    to the operator's standing word: `ask` with no decision registers the
 *    question and launches nothing, a dismissal leaves it, `off` writes the
 *    errand. A resume a live console makes on its own clock is the session's
 *    own declaration and is not asked about — gating THAT behind the shipped
 *    `ask` would stop every declared wait for a person.
 *  - every path, restart or not, is COUNTED per phase: `count` is how often
 *    this phase has already been resumed automatically, and at
 *    `MAX_BOOT_RESUMES` it is a person's errand, whatever woke it.
 */
export function automaticResumeGate(input: {
  prefs: { resumeAtBoot?: boolean | string };
  decision: 'continue' | 'dismiss' | null | undefined;
  restartCaused: boolean;
  count: number;
  /**
   * The RUN's own answer (phase 11, ZTD-8): `resumeOnRestart` as the launch
   * form answered it — `true` continues without a question, `false` writes the
   * errand, and only a run carrying NEITHER (a run from before the field, or a
   * harness that never said) falls through to the console's `resumeAtBoot`
   * preference and its ask. A person's `continue` on the boot card still
   * outranks a stored `false`: the card is answered per boot, on purpose.
   */
  run?: { resumeOnRestart?: boolean | null } | null;
}): ResumeGate {
  if (input.restartCaused) {
    if (input.decision === 'dismiss') return 'dismissed';
    const answered = input.run?.resumeOnRestart;
    if (input.decision !== 'continue' && answered === false) return 'off';
    if (input.decision !== 'continue' && typeof answered !== 'boolean') {
      const mode = resumeAtBootMode(input.prefs.resumeAtBoot);
      if (mode === 'ask') return 'ask';
      if (mode === 'off') return 'off';
    }
  }
  return input.count >= MAX_BOOT_RESUMES ? 'capped' : 'proceed';
}

/** Which word refused a restart resume: the run's own answer, or the console's preference. */
export function resumeRefusedBy(run: { resumeOnRestart?: boolean | null } | null | undefined): 'run' | 'console' {
  return run?.resumeOnRestart === false ? 'run' : 'console';
}

/** How often a phase has been resumed automatically — the counter the gate reads. */
export function automaticResumes(run: RunState, phase: number): number {
  return run.recoveries?.[String(phase)]?.bootResumes ?? 0;
}

/** The phases a run's wait clock resumes: its parks, else the lanes a wall checkpointed. */
function waitingPhasesOf(run: RunState): PhaseRecord[] {
  const records = Object.values(run.phases);
  const parked = records.filter((r) => r.status === 'waiting');
  return parked.length ? parked : records.filter((r) => r.status === 'pending' && r.resumeSessionId);
}

/**
 * Why a run's wait clock may NOT resume it by itself, or null — the pins every
 * reader of that clock honours with the same words: the boot's re-adoption, the
 * loop, and the timer's own fire.
 */
export function waitHoldWhy(run: RunState): string | null {
  // A usage wait honours `onLimit: 'pause'` — the operator chose to stay down;
  // a park on external work always resumes, and so does a person's card (its
  // clock is the card's expiry, and a usage policy has nothing to say about it).
  if (waitReasonOf(run) === 'usage-limit' && (run.onLimit ?? 'wait') === 'pause') {
    return 'the run is waiting on its own clock — its usage wall pauses for a person (onLimit: pause)';
  }
  if (stoppedByOperator(run)) return 'the operator stopped it — its own clock stays pinned until they continue it';
  if (run.resolved) return 'the stop is resolved — its own clock stays pinned';
  return null;
}

/** The phases a run's wait clock resumes — `waitingPhasesOf`, exported for the overdue ruling. */
export function waitClockPhases(run: RunState): PhaseRecord[] {
  return waitingPhasesOf(run);
}

export type WaitClockVerdict =
  | { verdict: 'not-a-wait' }
  /** The clock is ahead, or inside the grace: the armed timer owns the resume. */
  | { verdict: 'arm'; why: string }
  /** Pinned — an operator's stop, a resolved run, a wall that pauses for a person. */
  | { verdict: 'hold'; why: string }
  | { verdict: 'ask'; phases: number[]; sessions: string[]; why: string }
  | { verdict: 'errand'; phase: number; errand: Errand; why: string }
  /** Overdue past the grace and cleared to go: RULE on it (lateness, refs, budget), then resume. */
  | { verdict: 'resume'; lateByMs: number; phases: number[]; why: string };

/**
 * What to do about a run sleeping on a wait clock — ONE predicate for the
 * boot's re-adoption (`readoptQueued`) and the convergence loop, which used to
 * differ on four of five clauses: the boot armed whatever clock was on disk,
 * operator stop and resolution unread, and fired a past one on the next tick
 * (SLF-5, SLF-6, SHD-6). Both paths now give the same answer with the same
 * `why`, and an overdue clock is ruled on rather than fired.
 */
export function waitClockVerdict(
  run: RunState,
  facts: { now: number; prefs: { resumeAtBoot?: boolean | string }; decision?: 'continue' | 'dismiss' | null },
): WaitClockVerdict {
  // The clock is the run's, else the soonest waiting RECORD's (WAI-6): a loop
  // killed between a phase's park and the run's `enterRunWaiting` left the run
  // without one, and a reader that asked only the run saw no wait at all.
  const until = waitClockOf(run);
  if (!until || (run.status !== 'paused' && run.status !== 'waiting')) return { verdict: 'not-a-wait' };
  const held = waitHoldWhy(run);
  if (held) return { verdict: 'hold', why: held };
  const due = Date.parse(until);
  const lateByMs = Number.isFinite(due) ? facts.now - due : 0;
  // While the clock is AHEAD the armed timer owns the resume; within a
  // minute's grace past it, the timer's own fire still does.
  if (!Number.isFinite(due) || lateByMs <= WAIT_OVERDUE_GRACE_MS) {
    return { verdict: 'arm', why: 'the run is waiting on its own clock — the wait re-arms itself' };
  }
  const parks = waitingPhasesOf(run);
  const phases = parks.map((r) => r.phase);
  const count = Math.max(0, ...phases.map((phase) => automaticResumes(run, phase)));
  const gate = automaticResumeGate({ prefs: facts.prefs, decision: facts.decision, restartCaused: true, count, run });
  const first = parks[0];
  const sessionOf = (record: PhaseRecord | undefined) => record?.resumeSessionId ?? record?.sessionId;
  switch (gate) {
    case 'ask':
      return {
        verdict: 'ask', phases,
        sessions: parks.map((r) => sessionOf(r)).filter((s): s is string => Boolean(s)),
        why: `its wait clock (${until}) went by while nothing ran, and nobody has said whether to continue it`,
      };
    case 'dismissed':
      return { verdict: 'hold', why: 'the operator declined to pick this run up after the restart' };
    case 'off':
      return {
        verdict: 'errand', phase: first?.phase ?? 0,
        errand: resumeErrand(first?.phase ?? 0, new Date(facts.now).toISOString(), 'off', sessionOf(first), 'wait', resumeRefusedBy(run)),
        why: resumeRefusedBy(run) === 'run'
          ? 'the run was launched with resume-on-restart off'
          : 'resume at boot is switched off on this console',
      };
    case 'capped': {
      const worst = parks.find((r) => automaticResumes(run, r.phase) === count) ?? first;
      return {
        verdict: 'errand', phase: worst?.phase ?? 0,
        errand: resumeErrand(worst?.phase ?? 0, new Date(facts.now).toISOString(), 'capped', sessionOf(worst), 'wait'),
        why: `resumed ${count} times automatically`,
      };
    }
    default:
      return {
        verdict: 'resume', lateByMs, phases,
        why: `its wait clock (${until}) has passed and nothing resumed it — ${Math.round(lateByMs / 60_000)} min late`,
      };
  }
}

/* ------------------------------------------------------------------ *
 * The planner
 * ------------------------------------------------------------------ */

export function planConvergence(facts: ConvergeFacts): ConvergePlan {
  const actions: ConvergeAction[] = [];
  const at = new Date(facts.now).toISOString();
  const plan: ConvergePlan = { slug: facts.slug, trigger: facts.trigger, at, actions };
  const pidAlive = facts.pidAlive ?? realPidAlive;
  const skip = (runId: string | null, why: string): ConvergePlan => { actions.push({ kind: 'skip', runId, why }); return plan; };

  /* Debris first, across EVERY run of the plan: a relaunch below would queue
   * behind its own dead claim otherwise. Only autopilot-shaped owners of runs
   * this console can see are dead; a person's claim is never debris to us. */
  const dead = new Set(facts.runs.filter((run) => runIsDead(run, facts.live, pidAlive)).map((run) => run.id));
  const released = new Set<string>();
  for (const lock of debrisLocks(facts.locks, dead)) {
    released.add(`${lock.phase}:${lock.owner}`);
    actions.push({
      kind: 'release-debris', runId: autopilotRunId(lock.owner)!, phase: lock.phase, owner: lock.owner,
      why: `${lock.expired ? 'an expired' : 'an unexpired'} claim of run ${autopilotRunId(lock.owner)}, which nothing is driving`,
    });
  }
  /* Then the claims of sessions the registry shows ENDED — the presence channel
   * (Phase 5): a person's session that wrote its lock and closed, a lane of a
   * run some other console drove. The lease would free them in half an hour;
   * the registry knows now. A session's own run id, when it has one, labels the
   * journal line; a person's claim goes on the latest run. */
  for (const lock of endedSessionLocks(facts.locks, facts.live, facts.presence)) {
    if (released.has(`${lock.phase}:${lock.owner}`)) continue;
    released.add(`${lock.phase}:${lock.owner}`);
    const runId = autopilotRunId(lock.owner);
    actions.push({
      kind: 'release-debris', runId: runId && dead.has(runId) ? runId : null, phase: lock.phase, owner: lock.owner,
      session: lock.session!,
      why: `${lock.expired ? 'an expired' : 'an unexpired'} claim of ${lock.owner}, whose session ${lock.session} has ended`,
    });
  }

  const run = latestOf(facts.runs);
  if (!run) return skip(null, 'no run of this plan exists');
  if (facts.live.has(run.id)) return skip(run.id, 'the run is live — its own loop owns it');
  if (run.status === 'finished') return skip(run.id, 'the run is finished');
  if (run.status === 'queued') return skip(run.id, 'the run is queued — admission owns it');
  if (IN_FLIGHT.includes(run.status)) return skip(run.id, `the run reads ${run.status} under another process — not ours to touch`);
  // A run sleeping on a wait clock. While the clock is AHEAD the armed timer
  // owns the resume; once it is PAST — with a minute's grace for the timer's
  // own fire — a run still sleeping proves the timer is gone (a restart
  // between arms, an arm consumed while the loop was draining; run 258e1cc7
  // slept from 02:53Z to a hand at 06:52Z over exactly this). The same
  // predicate as the boot's re-adoption, so the two can no longer disagree
  // about an operator's stop (SLF-6), and an overdue clock is RULED ON — the
  // relaunch carries `wait`, and the executor's vehicle journals the lateness,
  // checks the refs and re-reads the budget before anything starts (SHD-6).
  const clock = waitClockVerdict(run, { now: facts.now, prefs: facts.prefs, decision: facts.resumeDecision?.(run.id) });
  switch (clock.verdict) {
    case 'not-a-wait': break;
    case 'arm':
    case 'hold':
      return skip(run.id, clock.why);
    case 'ask':
      actions.push({ kind: 'await-decision', runId: run.id, phases: clock.phases, sessions: clock.sessions, why: clock.why });
      return plan;
    case 'errand':
      actions.push({ kind: 'errand', runId: run.id, phase: clock.phase, errand: clock.errand, why: clock.why });
      return plan;
    case 'resume':
      actions.push({
        kind: 'relaunch', runId: run.id, reboard: [], rearm: [], why: [clock.why],
        wait: { until: run.waitUntil!, lateByMs: clock.lateByMs, phases: clock.phases },
        ...(facts.resumeDecision?.(run.id) === 'continue' ? { decided: true as const } : {}),
      });
      return plan;
  }

  const pressed = facts.trigger === 'button';
  if (!pressed && run.resolved) return skip(run.id, `the stop is resolved (${run.resolved.auto ? 'the board settled it' : 'a person dismissed it'}) — pinned`);
  if (!pressed && stoppedByOperator(run)) return skip(run.id, 'the operator stopped it — pinned until they continue it');
  // A halt only a person's press relaunches (RCV-3, RCV-1): the failure
  // streak is the run's one "this plan is broken" bound, and relaunching it
  // by clock was the very act that reset it (25 resets against 3 such halts);
  // a refused credential opens again only when a person clears the account
  // in the breaker, so a relaunch meets the same wall at the preflight. Both
  // still reach the HEALER below — the phases' own situations are classified
  // and their ladders climb, once per evidence — only the run-level relaunch
  // branches are closed to everything but `button`.
  const pressOnly = !pressed && run.status === 'halted'
    && PRESS_ONLY_HALT_KINDS.includes(run.halt?.kind ?? '');
  if (!facts.board) return skip(run.id, 'the board could not be read — nothing is decided on an empty board');
  const board = facts.board;

  /* An orphaned session — a child that outlived the console that started it —
   * is the one parked shape with something still writing. While its pid lives
   * the loop waits; once it is gone the run can be started again, and the
   * runner's `adopt` settles the records it left. */
  const orphan = run.status === 'parked' && run.halt?.kind === 'orphaned-session';
  if (orphan) {
    // The four-valued probe when a caller supplies one; otherwise derived from
    // the boolean seam, so every existing caller (and every test that injects
    // `pidAlive`) keeps its meaning: alive ⇒ running, not alive ⇒ gone.
    const probe: (pid: number) => ProcessState = facts.processState
      ?? (facts.pidAlive ? ((pid) => (facts.pidAlive!(pid) ? 'running' : 'gone')) : realProcessState);
    const states = childrenOf(run).map((child) => ({ child, state: probe(child.pid) }));
    const running = states.filter((entry) => entry.state === 'running');
    // `stopped` is NOT something to wait for. Nothing schedules a SIGSTOPped
    // process, so a console that waits for it to end waits until someone
    // notices — which in the incident this was written from meant three hours
    // of a run reporting "waiting for it to end" about a child that had been
    // frozen and then abandoned by the console that froze it. Say the true
    // thing instead; the halt already carries the `kill -CONT` remedy.
    const stopped = states.filter((entry) => entry.state === 'stopped');
    if (running.length) {
      return skip(run.id, 'a session from an earlier console is still running in it — waiting for it to end');
    }
    if (stopped.length) {
      return skip(run.id, stopped.length === 1
        ? `phase ${stopped[0].child.phase}'s session (pid ${stopped[0].child.pid}) is STOPPED, not running — `
          + 'nothing will resume it on its own. Continue or stop it from the run\'s halt card.'
        : `${stopped.length} sessions from an earlier console are STOPPED, not running — nothing will `
          + 'resume them on their own. Continue or stop them from the run\'s halt card.');
    }
  }

  const asked = run.onlyPhases?.length ? new Set(run.onlyPhases) : null;
  const remaining = Object.entries(board)
    .filter(([phase, word]) => word !== 'done' && (!asked || asked.has(Number(phase))))
    .map(([phase]) => Number(phase));
  const killed = killedLanes(run, board).filter((record) => !asked || asked.has(record.phase));
  const systemStop = run.stoppedBy === 'system' && (run.status === 'paused' || run.status === 'interrupted');
  const rearm = Object.values(run.phases)
    // `LOCK_CAP_PARK_BY_LOCK`, not `LOCK_CAP_PARK_NOTE` — the same narrowing
    // `rearmLockCapParks` makes, and for the same reason. Since D2 a wait-cap
    // park can be caused by a GRANT (a sibling lane that hangs), and the only
    // question this pass asks is `heldByAnother`, which reads LOCKS. It cannot
    // see a grant, so it reports the way clear, relaunches, meets the same
    // grant and parks again — with a `why` line ("the lock it waited out is
    // gone") that is simply false. Two readers of one predicate: narrowing
    // only the other one left this one to defeat it. The LIVE runner has
    // since gained the grant answer — `rearmLockCapParks`' `byGrant` arm asks
    // the scheduler's admission probe, which DOES see grants — but this
    // stopped-run pass still has no scheduler in its facts, so a stopped
    // run's grant-park keeps the Retry remedy, stated rather than guessed.
    //
    // D28/P8 adds the second answerable cause beside it — `LOCK_CAP_PARK_BY_CAP`,
    // a park the live-session cap caused. Its question is not `heldByAnother`
    // (there is no holder to find) but `facts.laneFree`, and a fleet with no
    // free lane, or no answer at all, re-arms nothing. Both readers gained it in
    // the same commit, which is the lesson of the paragraph above stated the
    // other way round: widening only one of them would leave a live run
    // recovering from a busy fleet and a stopped one stranded by it for ever.
    .filter((record) => record.status === 'parked' && (
      LOCK_CAP_PARK_BY_LOCK.test(record.note ?? '') || LOCK_CAP_PARK_BY_CAP.test(record.note ?? '')))
    .filter((record) => board[record.phase] !== 'done' && (!asked || asked.has(record.phase)))
    .filter((record) => (LOCK_CAP_PARK_BY_CAP.test(record.note ?? '')
      ? (facts.laneFree?.() ?? false)
      : !heldByAnother(facts.locks, record.phase, run.id, facts.now, facts.presence)))
    .map((record) => record.phase)
    .sort((a, b) => a - b);

  /* The killed-lane and system-stop shapes: the console's own restart stopped
   * a run that was working. With `resumeAtBoot` on, the run starts again —
   * killed lanes hinted to resume their own sessions (the brief degrades to a
   * fresh boot with a resume block when the session is gone) — bounded per
   * phase by `MAX_BOOT_RESUMES`. With it off, the run is left for a person,
   * with one errand naming exactly that. */
  // A run the console's own restart stopped, with nothing left on the board
  // for it: there is nothing to continue INTO. Not the healer's either — a
  // finished scope is not a stop to climb out of.
  if (systemStop && !remaining.length && !killed.length && !rearm.length && !orphan) {
    return skip(run.id, 'nothing remains on the board for this run');
  }

  const reboard: ReboardRequest[] = [];
  const counted: { phase: number; path: ResumePath; sessionId?: string }[] = [];
  const why: string[] = [];
  const decision = facts.resumeDecision?.(run.id) ?? null;
  if ((!pressOnly && killed.length) || orphan || (!pressOnly && systemStop && remaining.length)) {
    // Three answers, and the middle one is the default. `ask` neither launches
    // nor writes an errand — an errand is a job for a person, and "shall I
    // carry on?" is a question. It is asked once per console boot, in the app,
    // and a `continue` is spent by the launch it authorises: a restart is
    // exactly the event the question is about, so the next restart asks again.
    // The one gate (`automaticResumeGate`) answers it for every path.
    const restartGate = automaticResumeGate({ prefs: facts.prefs, decision, restartCaused: true, count: 0, run });
    if (restartGate === 'ask') {
      const phases = killed.length ? killed.map((r) => r.phase) : remaining;
      const sessions = killed
        .map((r) => r.resumeSessionId ?? r.sessionId)
        .filter((s): s is string => Boolean(s));
      actions.push({
        kind: 'await-decision',
        runId: run.id,
        phases,
        sessions,
        why: 'a console restart stopped this run and nobody has said whether to continue it',
      });
      return plan;
    }
    // "Not now" is not "switch it off". A dismissed question leaves the run
    // exactly as the restart left it and stops asking — the dialog says so in
    // those words, and writing an errand here contradicted it twice over: it
    // put a job in the inbox the operator had just declined, and it pushed a
    // notification whose text said the setting was "switched off" when it is
    // `ask`. `off` is a standing policy and keeps its errand; a dismissal is
    // one answer to one question on one boot.
    if (restartGate === 'dismissed') {
      return skip(run.id, 'the operator declined to pick this run up after the restart');
    }
    if (restartGate === 'off') {
      const refusedBy = resumeRefusedBy(run);
      const offWhy = refusedBy === 'run'
        ? 'the run was launched with resume-on-restart off'
        : 'resume at boot is switched off on this console';
      if (killed.length) {
        for (const record of killed) {
          actions.push({
            kind: 'errand', runId: run.id, phase: record.phase,
            errand: resumeErrand(record.phase, at, 'off', record.resumeSessionId ?? record.sessionId, 'lane', refusedBy),
            why: offWhy,
          });
        }
      } else {
        const phase = remaining[0] ?? 0;
        actions.push({
          kind: 'errand', runId: run.id, phase: null, errand: resumeErrand(phase, at, 'off', undefined, 'lane', refusedBy),
          why: offWhy,
        });
      }
      return plan;
    }
    for (const record of killed) {
      const count = automaticResumes(run, record.phase);
      const sessionId = record.resumeSessionId ?? record.sessionId;
      if (automaticResumeGate({ prefs: facts.prefs, decision, restartCaused: false, count }) === 'capped') {
        actions.push({
          kind: 'errand', runId: run.id, phase: record.phase,
          errand: resumeErrand(record.phase, at, 'capped', sessionId),
          why: `resumed ${count} times after console restarts`,
        });
        continue;
      }
      reboard.push({
        phase: record.phase, situation: 'work-in-progress', rung: 'resume-own-session',
        brief: sessionId ? 'continue' : 'resume',
        ...(sessionId ? { sessionId } : {}),
        by: 'converge',
      });
    }
    if (killed.length && !reboard.length && !rearm.length) return plan; // every killed lane is capped: the errands stand
    if (reboard.length) why.push(`${reboard.length === 1 ? 'a lane' : `${reboard.length} lanes`} a console restart killed resume${reboard.length === 1 ? 's' : ''}`);
    if (orphan) why.push('the session that outlived the earlier console has ended');
    if (systemStop && remaining.length && !reboard.length && !orphan) {
      // A shutdown between lanes: no lane was cut off, but a phase the
      // shutdown checkpointed still resumes its session when the run goes on.
      // Each such resume is counted like a killed lane's (LFC-7) — it used to
      // be the one restart resume with no count at all.
      for (const record of Object.values(run.phases)) {
        if (!remaining.includes(record.phase) || !record.resumeSessionId) continue;
        const count = automaticResumes(run, record.phase);
        if (automaticResumeGate({ prefs: facts.prefs, decision, restartCaused: false, count }) === 'capped') {
          actions.push({
            kind: 'errand', runId: run.id, phase: record.phase,
            errand: resumeErrand(record.phase, at, 'capped', record.resumeSessionId),
            why: `resumed ${count} times after console restarts`,
          });
          return plan;
        }
        counted.push({ phase: record.phase, path: 'system-stop', sessionId: record.resumeSessionId });
      }
      // True to the run's own record (RCV-11, phase 10). A `halt()`-stopped
      // run never reaches here — `halted` is not `systemStop` — but a run the
      // console's own checkpoint paused, or one `reconcileRun` found dead, may
      // still carry a halt of its own from before the shutdown; the sentence
      // says which of the two facts the relaunch answers.
      const own = run.halt && run.halt.kind !== 'interrupted-by-restart' ? run.halt : null;
      why.push(own
        ? `the console shut down after this run stopped on its own (${own.kind ?? 'a halt'}: ${own.reason.slice(0, 80)}) — the stop is answered, the console is back`
        : 'the console shut down while this run was working');
    }
  }
  if (rearm.length) {
    // A lock-cap park whose lock is gone resumes the phase's checkpointed
    // session with no restart involved — counted, never asked (LFC-7).
    for (const phase of rearm) {
      const count = automaticResumes(run, phase);
      if (automaticResumeGate({ prefs: facts.prefs, decision: null, restartCaused: false, count }) === 'capped') {
        actions.push({
          kind: 'errand', runId: run.id, phase,
          errand: resumeErrand(phase, at, 'capped', run.phases[String(phase)]?.resumeSessionId),
          why: `resumed ${count} times automatically`,
        });
        return plan;
      }
      const sessionId = run.phases[String(phase)]?.resumeSessionId;
      counted.push({ phase, path: 'rearm', ...(sessionId ? { sessionId } : {}) });
    }
    why.push(`the lock phase ${rearm.join(', ')} waited out is gone`);
  }
  if (!pressOnly && (reboard.length || rearm.length || (systemStop && remaining.length)) || orphan) {
    if (!remaining.length && !reboard.length && !rearm.length) return skip(run.id, 'nothing remains on the board for this run');
    actions.push({
      kind: 'relaunch', runId: run.id, reboard, rearm, why,
      ...(counted.length ? { counted } : {}),
      ...(decision === 'continue' ? { decided: true as const } : {}),
    });
    return plan;
  }

  /* The board opened up under a run that stopped because nothing was ready.
   *
   * Recovery is records-based: the healer classifies phases this run already
   * BOARDED. A phase that was never boarded has no record, so when a person
   * clears whatever was holding the plan — a QA verdict re-recorded, a gate
   * approved, a dependency finished elsewhere — the newly-ready phase is
   * invisible to every vehicle the healer owns, and the run sits parked with
   * work waiting in front of it. `systemStop` above does not cover this: it is
   * only paused/interrupted, and the runner's own "nothing is ready" park
   * writes `parked`.
   *
   * Bounded like the killed-lane relaunch: the operator's own stop is never
   * touched, and a run with nothing ready is left alone — relaunching that
   * would only re-park it, which is the oscillation this loop must not become. */
  if ((run.status === 'parked' || run.status === 'halted')
    && !stoppedByOperator(run) && !run.resolved && !pressOnly) {
    const readyNow = remaining.filter((p) => board[p] === 'ready');
    const boarded = new Set(Object.keys(run.phases).map(Number));
    if (readyNow.length && readyNow.some((p) => !boarded.has(p))) {
      actions.push({
        kind: 'relaunch', runId: run.id, reboard: [], rearm: [],
        why: [`the board has ready work again (phase ${readyNow.join(', ')}) and this run never boarded it`],
      });
      return plan;
    }
  }

  /* Everything else the loop stopped on — a halt, a park, an interrupted run
   * from before `stoppedBy` existed — goes to the healer: classify the open
   * phases, climb one rung, drive it through the runner. Once per evidence. */
  if (run.status === 'halted' || run.status === 'interrupted' || run.status === 'parked' || run.status === 'paused') {
    const fingerprint = evidenceFingerprint(run, board, facts.locks, facts.gateStamp, facts.qa);
    // The latch is the scheduler's for this process, else the RUN's — persisted
    // by the last heal that found nothing, so a restart does not heal the same
    // evidence again (SLF-7).
    const latch = facts.lastNoop ?? run.converge?.lastNoop ?? null;
    if (!pressed && latch === fingerprint) {
      return skip(run.id, 'nothing has changed since the last pass found nothing to climb');
    }
    actions.push({ kind: 'heal', runId: run.id, fingerprint, why: `the run reads ${run.status}${run.halt ? ` — ${run.halt.reason.slice(0, 100)}` : ''}` });
    return plan;
  }
  return skip(run.id, `the run reads ${run.status} — nothing to converge`);
}

/* ------------------------------------------------------------------ *
 * The executor
 * ------------------------------------------------------------------ */

/** What the healer answers — the slice of `Service.maybeAutoRecover`'s result this loop reads. */
export type HealResult = {
  launched: boolean;
  reason?: string;
  phase?: number;
  situation?: string;
  label?: string;
  rung?: string;
  vehicle?: string;
};

export type ConvergeDeps = {
  now?: () => number;
  /** Every run of the plan, newest first, board-resolved (the read path's `runsFor`). */
  runs: (slug: string) => Promise<RunState[]> | RunState[];
  live: () => ReadonlySet<string>;
  /** The board's states, or null when the engine could not read the plan. */
  board: (slug: string) => Promise<Record<number, string> | null>;
  locks: (slug: string) => LockView[];
  /** Does the fleet have a lane free right now — see `ConvergeFacts.laneFree`. */
  laneFree?: () => boolean;
  /** `gate-status.md`'s stamp for the plan — see `ConvergeFacts.gateStamp`. */
  gateStamp?: (slug: string) => string | null;
  /** The board's QA verdicts — see `ConvergeFacts.qa`. */
  qa?: (slug: string) => Promise<Record<number, string> | null> | Record<number, string> | null;
  prefs: () => { resumeAtBoot?: boolean | string };
  resumeDecision?: (runId: string) => 'continue' | 'dismiss' | null;
  /** Register that this run is waiting on the operator's boot answer. */
  /**
   * Register that this run is waiting on the operator's boot answer.
   * Returns false when the question was already registered on this boot.
   */
  awaitDecision?: (slug: string, runId: string, phases: number[], sessions: string[]) => boolean;
  /** Forget the operator's boot answer for a run — it was spent by the launch it authorised. */
  consumeDecision?: (runId: string) => void;
  /**
   * The overdue-wait vehicle (`Service.resumeOverdueWait`): rule on a wait whose
   * clock went by while nothing ran — lateness, refs, budget, the declaring
   * session's presence — count the resume, and launch. Answers whether it
   * launched. Absent (a hand-built dep set), a wait relaunch is a plain start.
   */
  resumeWait?: (slug: string, runId: string, trigger: ConvergeTrigger) => Promise<boolean>;
  pidAlive?: (pid: number) => boolean;
  /**
   * The four-valued probe. Separate from `pidAlive` because the answer that
   * matters here is the one a boolean cannot give: a `stopped` orphan is not
   * a process to wait for, it is a process nothing will ever resume.
   */
  processState?: (pid: number) => ProcessState;
  /** The session registry's presence for a lock's session — see `ConvergeFacts.presence`. */
  presence?: (lock: LockView) => Presence;
  /**
   * Classify + ladder + drive for the plan's latest run. The pass's trigger
   * and evidence fingerprint ride along (RCV-9): the healer signs every
   * `phase.situation` and `phase.rung` with them, and writes no situation
   * line for a phase whose situation the same fingerprint already produced.
   */
  heal: (slug: string, pass?: { trigger: ConvergeTrigger; fingerprint: string }) => Promise<HealResult>;
  startRun: (slug: string, options: {
    actor: StartActor; resumeRunId: string; reboard?: ReboardRequest[]; onlyPhases?: number[]; skills?: string[];
  }) => Promise<unknown>;
  /** Edit a stored (not live) run and write it back. */
  editRun: (slug: string, runId: string, apply: (state: RunState) => void) => RunState | null;
  /** Release a lock as its recorded owner — the runner's own release, `--git` never passed. */
  releaseLock: (slug: string, phase: number, owner: string) => Promise<{ ok: boolean; detail?: string }>;
  journal: (slug: string, runId: string, event: string, data: Record<string, unknown>, phase?: number) => void;
  /**
   * Push the one ask a converged errand leaves behind.
   *
   * Optional, so a test that builds deps by hand keeps working, and because
   * converging is useful with no notifier at all. The service passes its own
   * `announceErrand`, which is the same dedupe the runner and the healer use —
   * three producers of errands, one notification per ask.
   */
  announceErrand?: (slug: string, runId: string, phase: number | null, errand: Errand) => void;
  /** Something changed under the locks — poke whoever waits on them. */
  locksChanged?: (slug: string) => void;
};

export type ConvergeOutcome = {
  action: ConvergeAction;
  ok: boolean;
  detail?: string;
  /** The healer's own answer, on a `heal`. */
  heal?: HealResult;
};

export type ConvergeReport = ConvergePlan & {
  outcomes: ConvergeOutcome[];
  /** Did this pass start a run (a relaunch, or a healer that launched)? */
  launched: boolean;
  /** The errands this pass wrote or found standing, for the recover verb's answer. */
  errands: Errand[];
  /** The fingerprint to remember when the healer found nothing; null clears it. */
  noop: string | null;
};

export async function executeConvergence(plan: ConvergePlan, deps: ConvergeDeps): Promise<ConvergeReport> {
  const outcomes: ConvergeOutcome[] = [];
  const errands: Errand[] = [];
  let launched = false;
  let noop: string | null = null;
  const { slug, trigger } = plan;
  const touched = new Set<string>();

  const debris = plan.actions.filter((a): a is Extract<ConvergeAction, { kind: 'release-debris' }> => a.kind === 'release-debris');
  // A session's claim (runId null) is journalled on the plan's latest run, when there is one.
  const latestRunId = plan.actions.find((a): a is Extract<ConvergeAction, { kind: 'skip' | 'heal' | 'relaunch' | 'errand' }> =>
    a.kind !== 'release-debris' && a.runId != null)?.runId ?? null;
  for (const action of debris) {
    let result: { ok: boolean; detail?: string };
    try { result = await deps.releaseLock(slug, action.phase, action.owner); } catch (error) {
      result = { ok: false, detail: (error as Error)?.message ?? String(error) };
    }
    const journalRun = action.runId ?? latestRunId;
    if (journalRun) {
      deps.journal(slug, journalRun, 'run.lock-debris-released', {
        phase: action.phase, owner: action.owner, ok: result.ok, why: action.why, trigger, by: 'converge',
        ...(action.session ? { session: action.session } : {}),
        ...(result.detail ? { detail: result.detail.slice(0, 200) } : {}),
      }, action.phase);
    }
    outcomes.push({ action, ok: result.ok, ...(result.detail ? { detail: result.detail } : {}) });
  }
  if (debris.length) { try { deps.locksChanged?.(slug); } catch { /* the poke is a courtesy */ } }

  for (const action of plan.actions) {
    switch (action.kind) {
      case 'release-debris': case 'skip': break;

      case 'await-decision': {
        // Nothing is written to the run: the question is about this console
        // boot, not about the run, and a run file that recorded "somebody was
        // asked" would still say so after the restart that makes the question
        // new again. The register is in memory for exactly that reason, and a
        // console that dies with the question unanswered simply asks again.
        // The sink answers whether this is the FIRST time the question has been
        // registered for this run on this boot. Journalling every pass would
        // put a line in the run's history every `convergeEveryMs` for as long
        // as nobody answered — a log of the console noticing, rather than of
        // anything happening.
        const asked = deps.awaitDecision?.(slug, action.runId, action.phases, action.sessions);
        if (asked !== false) {
          deps.journal(slug, action.runId, 'run.resume-asked',
            { phases: action.phases, reason: action.why, trigger }, undefined);
        }
        outcomes.push({ action, ok: true });
        break;
      }

      case 'errand': {
        // A standing errand is not rewritten (`sameErrand`): this loop runs
        // every five minutes, and each rewrite minted a fresh `at`, which the
        // inbox read as a new "since" and the announcer as a new push. The
        // ask stands, with the clock it was first written on; the pass records
        // that it looked and found nothing to add.
        let standing: string | null = null;
        const edited = deps.editRun(slug, action.runId, (state) => {
          if (action.phase == null) {
            if (sameErrand(state.errand, action.errand)) { standing = state.errand!.at; return; }
            state.errand = action.errand; return;
          }
          const slot = ((state.recoveries ??= {})[String(action.phase)] ??= { attempts: 0, lastAt: action.errand.at });
          if (sameErrand(slot.errand, action.errand)) { standing = slot.errand!.at; return; }
          slot.errand = action.errand;
        });
        if (standing) {
          outcomes.push({ action, ok: Boolean(edited), detail: `the errand has stood since ${standing} — not rewritten` });
          break;
        }
        deps.journal(slug, action.runId, action.phase == null ? 'run.errand' : 'phase.errand',
          { ...action.errand, reason: action.why, by: 'converge', trigger }, action.phase ?? undefined);
        errands.push(action.errand);
        deps.announceErrand?.(slug, action.runId, action.phase ?? null, action.errand);
        touched.add(action.runId);
        outcomes.push({ action, ok: Boolean(edited) });
        break;
      }

      case 'relaunch': {
        const at = new Date(deps.now?.() ?? Date.now()).toISOString();
        /** The highest per-phase resume count this launch reached — the counter `run.start` names. */
        let counted = 0;
        const edited = deps.editRun(slug, action.runId, (state) => {
          for (const phase of action.rearm) {
            const record = state.phases[String(phase)];
            if (!record) continue;
            const was = record.note;
            resetForRetry(record, {
              by: 'console',
              journal: (event, data, at) => deps.journal(slug, action.runId, event, data, at),
            });
            deps.journal(slug, action.runId, 'phase.lock-cap-rearmed',
              { was, note: 'the lock it waited on is gone — the wait starts over', by: 'converge', trigger }, phase);
          }
          // Every automatic resume this launch makes, counted against the one
          // per-phase bound and journalled with what woke it and which path it
          // took (LFC-7). A wait's resumes are counted by its own vehicle
          // (`resumeWait`), which knows whether the ruling let it launch.
          const resumes: { phase: number; path: ResumePath; sessionId: string | null; brief?: string }[] = [
            ...action.reboard.map((ask) => ({ phase: ask.phase, path: 'killed-lane' as const, sessionId: ask.sessionId ?? null, brief: ask.brief })),
            ...(action.counted ?? []).map((entry) => ({ phase: entry.phase, path: entry.path, sessionId: entry.sessionId ?? null })),
            ...(action.wait && !deps.resumeWait
              ? action.wait.phases.map((phase) => ({
                phase, path: 'overdue-wait' as const,
                sessionId: state.phases[String(phase)]?.resumeSessionId ?? state.phases[String(phase)]?.sessionId ?? null,
              }))
              : []),
          ];
          for (const resume of resumes) {
            const slot = ((state.recoveries ??= {})[String(resume.phase)] ??= { attempts: 0, lastAt: at });
            slot.bootResumes = (slot.bootResumes ?? 0) + 1;
            counted = Math.max(counted, slot.bootResumes);
            slot.lastAt = at;
            delete slot.errand;
            deps.journal(slug, action.runId, 'phase.resume-automatic', {
              trigger, path: resume.path, count: slot.bootResumes, sessionId: resume.sessionId,
              ...(resume.brief ? { brief: resume.brief } : {}), by: 'converge',
            }, resume.phase);
          }
          // The run-level errand was about the stop this launch ends.
          delete state.errand;
        });
        if (!edited) { outcomes.push({ action, ok: false, detail: 'the run could not be read back' }); break; }
        deps.journal(slug, action.runId, 'run.converge', {
          trigger, action: 'relaunch', why: action.why,
          reboard: action.reboard.map((ask) => ask.phase), rearm: action.rearm, by: 'converge',
          ...(action.wait ? { wait: action.wait } : {}),
        });
        try {
          if (action.wait && deps.resumeWait) {
            // An overdue wait is ruled on by its vehicle, not started bare:
            // lateness journalled, refs checked, budget re-read — and it may
            // decide not to launch at all.
            if (await deps.resumeWait(slug, action.runId, trigger)) launched = true;
          } else {
            await deps.startRun(slug, {
              // The loop's own word on the run it relaunches: which trigger
              // woke it, what the planner saw, and the per-phase bound spent.
              actor: doorActor('converge-relaunch', {
                by: 'converge', via: viaOfTrigger(trigger), origin: `converge:${trigger}`,
                trigger: action.why[0] ?? trigger,
                guard: action.decided ? 'resumeDecision:continue' : 'automaticResumeGate',
                counter: `MAX_BOOT_RESUMES:${counted}/${MAX_BOOT_RESUMES}`,
              }),
              resumeRunId: action.runId,
              ...(action.reboard.length ? { reboard: action.reboard } : {}),
              ...(edited.onlyPhases?.length ? { onlyPhases: edited.onlyPhases } : {}),
              skills: edited.skills ?? [],
            });
            launched = true;
          }
          // The operator's `continue` answered THIS restart; spent, so the next
          // one is asked again ("the decision survives only for its trigger").
          if (action.decided) deps.consumeDecision?.(action.runId);
          outcomes.push({ action, ok: true });
        } catch (error) {
          const detail = (error as Error)?.message ?? String(error);
          deps.journal(slug, action.runId, 'run.converge-failed', { trigger, action: 'relaunch', detail: detail.slice(0, 300), by: 'converge' });
          outcomes.push({ action, ok: false, detail });
        }
        break;
      }

      case 'heal': {
        let result: HealResult;
        try { result = await deps.heal(slug, { trigger, fingerprint: action.fingerprint }); } catch (error) {
          result = { launched: false, reason: (error as Error)?.message ?? String(error) };
        }
        if (result.launched) { launched = true; noop = null; } else noop = action.fingerprint;
        // The latch rides the run, where its evidence already lives (SLF-7): a
        // heal that found nothing writes the fingerprint it found nothing in;
        // one that launched clears it.
        try {
          deps.editRun(slug, action.runId, (state) => {
            state.converge = result.launched ? null : { lastNoop: action.fingerprint, at: new Date(deps.now?.() ?? Date.now()).toISOString() };
          });
        } catch { /* the in-memory latch still holds for this process */ }
        deps.journal(slug, action.runId, 'run.converge', {
          trigger, action: 'heal', why: action.why, launched: result.launched,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.phase != null ? { phase: result.phase } : {}),
          ...(result.situation ? { situation: result.situation } : {}),
          ...(result.rung ? { rung: result.rung } : {}),
          by: 'converge',
        });
        outcomes.push({ action, ok: result.launched, heal: result, ...(result.reason ? { detail: result.reason } : {}) });
        break;
      }
    }
  }
  return { ...plan, outcomes, launched, errands, noop };
}

/** Gather, plan, act — one pass for one plan. */
export async function convergePlan(
  deps: ConvergeDeps, slug: string, trigger: ConvergeTrigger, lastNoop: string | null = null,
): Promise<ConvergeReport> {
  const now = deps.now?.() ?? Date.now();
  const runs = await deps.runs(slug);
  // No runs: nothing to converge, and no board read spent finding that out.
  const board = runs.length ? await deps.board(slug) : null;
  const facts: ConvergeFacts = {
    slug, now, trigger, board, runs,
    live: deps.live(),
    locks: deps.locks(slug),
    ...(deps.laneFree ? { laneFree: deps.laneFree } : {}),
    gateStamp: deps.gateStamp?.(slug) ?? null,
    qa: (deps.qa ? await deps.qa(slug) : null) ?? null,
    prefs: deps.prefs(),
    // The operator's boot answer. This dep existed and was never forwarded, so
    // answering "continue" re-registered the same question and launched
    // nothing — an ask with no way to say yes.
    ...(deps.resumeDecision ? { resumeDecision: deps.resumeDecision } : {}),
    ...(deps.pidAlive ? { pidAlive: deps.pidAlive } : {}),
    ...(deps.presence ? { presence: deps.presence } : {}),
    lastNoop,
  };
  const plan = planConvergence(facts);
  return executeConvergence(plan, deps);
}

/* ------------------------------------------------------------------ *
 * The clock
 * ------------------------------------------------------------------ */

export type ConvergeClock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const REAL_CLOCK: ConvergeClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export type ConvergeSchedulerDeps = {
  /** One pass for one plan; null when converging is not possible (no root, no --allow-run). */
  run: (slug: string, trigger: ConvergeTrigger, lastNoop: string | null) => Promise<ConvergeReport | null>;
  /** The plans the periodic sweep visits. */
  slugs: () => string[];
  /** The sweep interval preference; 0 disables the timer sweep entirely, anything else is clamped to `MIN_SWEEP_MS`. */
  everyMs?: () => number | undefined;
  clock?: ConvergeClock;
  onReport?: (report: ConvergeReport) => void;
  /**
   * Is the whole console frozen? Asked at FIRE time, never at request time.
   *
   * Requests keep arriving and keep being scheduled while a freeze stands —
   * the docs watcher still debounces, a halt still books its quiet minute —
   * and each one simply finds the console frozen when its moment comes. That
   * is deliberate and it is what "exact resume" means here: nothing is
   * cancelled, so nothing has to be reconstructed at the thaw.
   *
   * The operator's own press (`trigger: 'button'`) is EXEMPT. A freeze stops
   * the console from acting on its own; it is not a lock on the operator's
   * hands, and a Recover & continue that silently did nothing would be the
   * console lying to the person holding it. It journals why instead.
   */
  fleetHold?: () => { at: string; by?: string } | null | undefined;
};

type Pending = { handle: unknown; dueAt: number; trigger: ConvergeTrigger };

/**
 * When the loop runs. Per plan: a trailing debounce for docs changes, the
 * quiet minute after a halt (a change inside it does not shorten it — the
 * halt's own pass sees the change), and single-flight with one re-run queued
 * behind an in-flight pass. Plan-wide: the periodic sweep, re-armed after each
 * sweep completes, so a slow pass never stacks sweeps.
 */
export class ConvergeScheduler {
  private deps: ConvergeSchedulerDeps;
  private clock: ConvergeClock;
  private pending = new Map<string, Pending>();
  private running = new Map<string, Promise<ConvergeReport | null>>();
  private again = new Map<string, ConvergeTrigger>();
  private sweepHandle: unknown = null;
  private closed = false;
  /** The last pass per plan, for the Pulse and for tests. */
  readonly reports = new Map<string, ConvergeReport>();
  /** Per plan: the evidence fingerprint at the last pass that healed nothing. */
  private noops = new Map<string, string>();

  constructor(deps: ConvergeSchedulerDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? REAL_CLOCK;
  }

  /** A harness seam: swap the clock BEFORE `start()`. */
  setClock(clock: ConvergeClock): void { this.clock = clock; }

  /** Arm the periodic sweep (idempotent). */
  start(): void {
    if (this.closed) return;
    this.armSweep();
  }

  /**
   * The boot pass: every open plan with a run, now — one plan at a time (a
   * pass may read the board and launch a run, and a fleet of them at once is
   * how a console used to wedge), awaited, so a caller can know when the
   * console has finished picking up what its predecessor left.
   */
  async boot(slugs: string[]): Promise<void> {
    for (const slug of slugs) {
      if (this.closed) return;
      await this.converge(slug, 'boot');
    }
  }

  /**
   * Forget every remembered "nothing to climb" fingerprint.
   *
   * The latch compares EVIDENCE — the run, the board, the locks, the gate
   * stamp, the QA verdicts — and the healer also decides with things that are
   * none of those: the ladder caps, the unblock and takeover switches, gate
   * delegation. An operator who raises a spent budget or turns delegation on has
   * changed exactly the thing that would let the loop act, and the loop went on
   * skipping with "nothing has changed since the last pass found nothing to
   * climb". Clearing costs one redundant pass and is the honest answer to "the
   * rules just changed".
   */
  clearNoops(): void {
    this.noops.clear();
  }

  /**
   * Ask for a pass. `delayMs` overrides the trigger's default delay. A pending
   * request for the same plan keeps whichever is due sooner, with two
   * exceptions that exist for the same reason — the quiet minute after a halt
   * is not negotiable: a docs change never shortens a pending halt, and a halt
   * REPLACES a pending change with its own later due time.
   */
  request(slug: string, trigger: ConvergeTrigger, delayMs?: number): void {
    if (this.closed) return;
    const delay = Math.max(0, delayMs ?? DEFAULT_DELAY[trigger]);
    const dueAt = this.clock.now() + delay;
    const current = this.pending.get(slug);
    if (current) {
      if (current.trigger === 'halt' && trigger === 'change') return;
      // …and the other half of that rule: a halt OUTRANKS a pending change
      // even though it is due LATER. The ordering that loses the halt is the
      // ordinary one — the lane's session ends (a `change`, 2s: service-runs
      // `onPresenceChange`), then the run halts milliseconds later — and the
      // halt request was being DROPPED, so the pass fired two seconds after
      // the break: the console launching something the same second something
      // broke, which is the one thing HALT_DELAY_MS exists to prevent. Take
      // the halt and never shorten: this branch is only reached when the
      // halt's own dueAt is the later of the two, and a halt due sooner
      // already falls through the line below. Narrow on purpose — a halt
      // behind a pending HALT is still dropped, so repeated halts cannot keep
      // restarting the minute.
      const haltOverChange = trigger === 'halt' && current.trigger === 'change';
      if (dueAt >= current.dueAt && trigger !== 'change' && !haltOverChange) return;
      // A change is a TRAILING debounce: each write pushes the pass out again,
      // so a burst of handoff files lands as one pass after the last of them.
      if (trigger === 'change' && current.trigger !== 'change' && dueAt >= current.dueAt) return;
      this.clock.clearTimeout(current.handle);
    }
    const handle = this.clock.setTimeout(() => {
      this.pending.delete(slug);
      void this.fire(slug, trigger);
    }, delay);
    this.pending.set(slug, { handle, dueAt, trigger });
  }

  /** The operator's press: now, awaited, and with the pins off inside the planner. */
  async converge(slug: string, trigger: ConvergeTrigger = 'button'): Promise<ConvergeReport | null> {
    const current = this.pending.get(slug);
    if (current) { this.clock.clearTimeout(current.handle); this.pending.delete(slug); }
    const inFlight = this.running.get(slug);
    if (inFlight) await inFlight.catch(() => null);
    return this.fire(slug, trigger);
  }

  /** Every pass in flight, settled — a harness seam. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()].map((p) => p.catch(() => null)));
  }

  /** What the scheduler is holding, for the Pulse. */
  snapshot(): { pending: { slug: string; trigger: ConvergeTrigger; dueAt: number }[]; running: string[] } {
    return {
      pending: [...this.pending].map(([slug, p]) => ({ slug, trigger: p.trigger, dueAt: p.dueAt })),
      running: [...this.running.keys()],
    };
  }

  close(): void {
    this.closed = true;
    for (const { handle } of this.pending.values()) this.clock.clearTimeout(handle);
    this.pending.clear();
    if (this.sweepHandle != null) this.clock.clearTimeout(this.sweepHandle);
    this.sweepHandle = null;
    this.again.clear();
  }

  private fire(slug: string, trigger: ConvergeTrigger): Promise<ConvergeReport | null> {
    if (this.closed) return Promise.resolve(null);
    // The fleet freeze, at the top and before anything is read.
    //
    // Here rather than inside the planner because a pass is not free: it reads
    // the board through a subprocess, lists locks and may relaunch a session.
    // A frozen console that still spent a board read per plan per sweep would
    // be a console doing the expensive half of the work it was told to stop.
    //
    // The operator's press goes through — see `ConvergeSchedulerDeps.fleetHold`.
    if (trigger !== 'button') {
      let hold: { at: string; by?: string } | null | undefined;
      try { hold = this.deps.fleetHold?.(); } catch { hold = null; }
      if (hold) {
        log.info('converge.frozen', { slug, trigger, by: hold.by ?? null, at: hold.at });
        return Promise.resolve(null);
      }
    }
    const inFlight = this.running.get(slug);
    if (inFlight) {
      // One re-run queued behind the pass in flight, whatever asked for it —
      // the re-run re-reads everything, so the trigger kept is the strongest.
      const queued = this.again.get(slug);
      if (!queued || trigger === 'button' || (trigger === 'boot' && queued !== 'button')) this.again.set(slug, trigger);
      return inFlight;
    }
    const pass = this.deps.run(slug, trigger, this.noops.get(slug) ?? null)
      .then((report) => {
        if (report) {
          // Only a pass that actually MOVED something invalidates the latch.
          // `noop` is assigned in the heal branch alone, so a pass whose single
          // action was a skip — the guard skip included — reported null here and
          // deleted the fingerprint it had just honoured. The next sweep then had
          // nothing to compare against and healed again: one board read, one
          // healer pass and one journal line every other sweep, for ever, on a
          // run nobody could move. Keeping a stale fingerprint is harmless (the
          // comparison is exact); forgetting one is a permanent spin.
          if (report.noop) this.noops.set(slug, report.noop);
          else if (report.launched) this.noops.delete(slug);
          this.reports.set(slug, report);
          try { this.deps.onReport?.(report); } catch { /* a listener must never break the loop */ }
        }
        return report;
      })
      .catch((error) => { log.warn('converge.failed', { slug, trigger, error }); return null; })
      .finally(() => {
        this.running.delete(slug);
        const next = this.again.get(slug);
        if (next && !this.closed) { this.again.delete(slug); this.request(slug, next, 0); }
      });
    this.running.set(slug, pass);
    return pass;
  }

  private armSweep(): void {
    if (this.sweepHandle != null) this.clock.clearTimeout(this.sweepHandle);
    const raw = this.deps.everyMs?.();
    // Zero is the documented OFF switch (`config.ts` `convergeEveryMs`), and it
    // used to fall through `Math.max` into a THIRTY-SECOND sweep — the exact
    // opposite of what the operator asked for. The other doors (boot, change,
    // halt, button) are deliberately untouched: only the clock is theirs to
    // turn off.
    if (raw === 0) { this.sweepHandle = null; return; }
    const every = Math.max(MIN_SWEEP_MS, raw ?? DEFAULT_SWEEP_MS);
    this.sweepHandle = this.clock.setTimeout(() => { void this.sweep(); }, every);
  }

  private async sweep(): Promise<void> {
    this.sweepHandle = null;
    if (this.closed) return;
    let slugs: string[] = [];
    try { slugs = this.deps.slugs(); } catch { slugs = []; }
    // One plan at a time: every pass may read the board (a subprocess) and
    // launch a run, and a fleet of them at once is how a console used to wedge.
    for (const slug of slugs) {
      if (this.closed) return;
      try { await this.fire(slug, 'timer'); } catch { /* logged in fire */ }
    }
    if (!this.closed) this.armSweep();
  }
}

/* ------------------------------------------------------------------ *
 * The view a reader gets (`GET /api/converge`, SSE `run:converge`)
 * ------------------------------------------------------------------ */

/** One action of a pass, flattened for a card: what it did, to which phase, why. */
export type ConvergeActionView = {
  kind: ConvergeAction['kind'];
  /** The phase the action is about; null for a run-level errand; absent when it has none. */
  phase?: number | null;
  situation?: string;
  rung?: string;
  vehicle?: string;
  owner?: string;
  session?: string;
  /** A relaunch's re-boards: each phase with the situation and rung it boards for. */
  reboard?: { phase: number; situation: string; rung: string; brief?: string }[];
  /** A relaunch's re-armed lock-cap parks. */
  rearm?: number[];
  /** An errand's ask. */
  need?: string;
  /** A heal's answer: did it launch anything? */
  launched?: boolean;
  ok: boolean;
  why: string;
};

export type ConvergeView = {
  slug: string;
  trigger: ConvergeTrigger;
  at: string;
  launched: boolean;
  /** The pass found nothing to do (the healer's fingerprint was remembered). */
  noop: boolean;
  actions: ConvergeActionView[];
  /** How many errands the pass wrote or found standing. */
  errands: number;
};

/**
 * A report, flattened for the Pulse's convergence line and the event stream:
 * every action with its outcome (by identity — the executor appends one
 * outcome per action), the relaunch's re-boards named phase by phase, the
 * healer's own answer on a heal. Pure; `test/converge.test.ts` pins it.
 */
export function convergeView(report: ConvergeReport): ConvergeView {
  const actions = report.actions.map((action): ConvergeActionView => {
    const outcome = report.outcomes.find((o) => o.action === action);
    const ok = outcome ? outcome.ok : true;
    switch (action.kind) {
      case 'release-debris':
        return {
          kind: action.kind, phase: action.phase, owner: action.owner, ok, why: action.why,
          ...(action.session ? { session: action.session } : {}),
        };
      case 'relaunch':
        return {
          kind: action.kind, ok, why: action.why.join('; '),
          reboard: action.reboard.map((r) => ({
            phase: r.phase, situation: r.situation, rung: r.rung, ...(r.brief ? { brief: r.brief } : {}),
          })),
          rearm: [...action.rearm],
        };
      case 'errand':
        return {
          kind: action.kind, phase: action.phase, situation: action.errand.situation,
          need: action.errand.need, ok, why: action.why,
        };
      case 'heal': {
        const heal = outcome?.heal;
        return {
          kind: action.kind, ok, why: heal?.reason ?? outcome?.detail ?? action.why,
          ...(heal?.phase != null ? { phase: heal.phase } : {}),
          ...(heal?.situation ? { situation: heal.situation } : {}),
          ...(heal?.rung ? { rung: heal.rung } : {}),
          ...(heal?.vehicle ? { vehicle: heal.vehicle } : {}),
          launched: Boolean(heal?.launched),
        };
      }
      case 'await-decision':
        return { kind: action.kind, phase: action.phases[0] ?? null, ok, why: action.why };
      case 'skip':
      default:
        return { kind: action.kind, ok, why: action.why };
    }
  });
  return {
    slug: report.slug,
    trigger: report.trigger,
    at: report.at,
    launched: report.launched,
    noop: report.noop != null && !report.launched && actions.every((a) => a.kind === 'skip' || (a.kind === 'heal' && !a.launched)),
    actions,
    errands: report.errands.length,
  };
}
