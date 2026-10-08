/**
 * The phase loop.
 *
 * For each ready phase: check its gate, claim its lock, ask the engine for the
 * boot prompt, run it as one `claude -p` process, and then — the part that
 * matters — **check the work independently**. The session's own report is
 * evidence, not proof: it is the same session whose job it was to succeed. So
 * the runner re-runs the plan's verification commands, re-lints, and re-reads
 * the board from disk. A phase advances only when all three agree.
 *
 * Two resumes, both required and quite different:
 *
 *   **Plan-level** — fresh or half-finished is the same code path. `--memory-block`
 *   derives ready from the done-*set*, so a plan with 1, 4 and 5 done and 2, 3
 *   outstanding needs no cursor and no special case. There is deliberately no
 *   "current phase" stored anywhere; the board is the truth.
 *
 *   **Run-level** — a console that died mid-phase left a child behind. That is
 *   reconciled explicitly (`adopt`) and never guessed at: a phase that may have
 *   half-committed is parked for a person, not silently re-run.
 *
 * Concurrency is deliberately one run at a time. Two sessions editing one
 * working tree is not parallelism, it is a merge conflict with extra steps.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

import { log } from '../log.ts';
import { holdBinds } from '../fleet-hold.ts';
import { ACCOUNT_HALT_KINDS, isPhaseHalt } from '../../shared/recovery-model.js';
import { noteFirstTool } from '../../shared/phase-clocks.js';
import { DEFAULT_QA_MAX_ROUNDS } from '../../shared/run-settings.js';
import { policyAnsweredPayload, type ResolvedPolicy } from '../../shared/policy-model.js';
import { policyForKey, policyForSituation } from './policy.ts';
import { onShutdown, offShutdown, type ShutdownContext } from '../lifecycle.ts';
import { run as engineRun, readMemoryBlock, readGateStatus, readLint, readText, runOutsidePool, type Board } from '../engine.ts';
import { leaseAction } from './lease.ts';
import { mcpDirective, skillDirective } from '../skills.ts';
import { SCRIPTS_REF } from '../skill-copy.ts';
import {
  classify, fallbackChain, limitBucket, nextModel, resetWaitUntil, MODEL_FALLBACK, type Disposition, type RetirementEvidence,
} from './errors.ts';
import { continueMcpParkedRecord, DEFAULT_MCP_REQUIRE_TIMEOUT_MS, type McpContinueResult } from './mcp-park.ts';
import { markFor, spawnClaude, type SpawnFn, type SpawnHandle, type StreamEvent } from './spawn.ts';
import { INT_GRACE_MS, killLadder, stopWhereItStands, wake } from './signals.ts';
import {
  FREEZE_ESCALATE_MS, checkpointFrozenRecord, escalatePersistedFreeze, freezeVerdict,
  type PersistedEscalation,
} from './freeze.ts';
import { extractCommands, resolveLead, unresolvableLeads, verifyPhase } from './verify.ts';
import { loadVerifyEnv, type VerifyEnv } from './verify-env.ts';
import { knownEndOf, localNudgeAfterMs, mintWatchRef, ownBackgroundWork, probeSignature, unmintedReason } from './liveness.ts';
import {
  failureContext, resumeBrief, resumeInstruction, unblockBrief, type BriefFacts,
} from './failure-context.ts';
import {
  applyEvent, awaitingBackground, evaluateStall, isDurableProgress, isProductiveEvent, livenessOf, newLaneSignals, noteWaitDenied,
  stallThresholds, type BackgroundTask, type LaneLiveness, type LaneSignals, type StallState, type StallThresholds,
} from './liveness.ts';
import { ingestRulings, rulingsFile, type Ruling } from './rulings.ts';
import {
  classifySituation, collectEvidence, situation as situationOf, workEvidence,
  type EvidenceDeps, type PhaseEvidence, type Situation,
} from './situation.ts';
import { answeredByItem, grantedByItem, strikeLabel, wallOfCliDenial, wallOfHookDenial } from '../permissions/walls.ts';
import {
  accountRung, capErrand, capRefusal, chargeRung, countedRungs, errandFor, errandSaid, widenCard, widenInstruction, nextRung, openRunRungs,
  retryForgives, runCapOverrides, rungKey, rungsFor, switchRungDecision, untriedRungs, DEFAULT_LADDER_CAPS, PERSON_SLOT_BY, type LadderCaps, type Rung,
} from './ladder.ts';
import { qaRungInstruction } from './qa-recover.ts';
import type { RungRecord, UsageDecisionAction, WaitBeside } from './state.ts';
import type { AccountSessions } from '../sessions/registry.ts';
import { ALERT_PCT, WALL_PCT, WARN_PCT } from '../../shared/ops-vocab.js';
import {
  childrenOf, consumeDeclaration, DECLARATION_CONSUMED_EVENT, loadRun, newRun, phaseRecord, prepareReboard, procIdentity, saveRun, saveRunSoon, pidAlive, processState, IN_FLIGHT, SETTLED, setRunState, waitClockOf,
  PHASE_IN_FLIGHT, RECONCILABLE, reconcileRecordsAgainstBoard, reopenRegressedRecords, resetStreak, streakSentence, mcpReasonText, resetForRetry, consoleStoppedNote,
  settleInFlightRecords, type UndrivenStamp, type Autonomy, type BoardingBrief, type BoardingHint, type ChildRef, type Errand, type HaltKind,
  type McpDegradation, type McpPolicy,
  type OnLimitPolicy, type PhaseOptions, type PhaseRecord, type PreflightWarning,
  type RunState, type PhaseStatus, type RunStatus, type VerifySummary, isSessionGone, mergeQaHistory,
  syncWaitClock, accountPool, type AccountChoice, retirePhaseHalt, owesVerification, THIS_CONSOLE,
} from './state.ts';
import { consumeOutcome, outcomeFileFor, readOutcome, type PhaseOutcome } from './outcome.ts';
import { liveRefs, pollableRefs, stillLiveRefs } from '../watch-refs.ts';
import {
  boundedPlan, planDigest, planHoldOutcome, planTextFile, PLAN_HOLD_GRACE_MS,
  type PlanPresented, type PresentedPlan,
} from './plan-approval.ts';
import { REF_WAIT_LOOK_AGAIN_MS, runBudgetFact, screenDeclaration, screenedFields, streakFact, type ScreenedDeclaration } from './wait-budget.ts';
import { OWN_LOCK_WATCH_REFUSAL, UNDRIVEN_STATUSES } from '../../shared/run-lifecycle.js';
import { consumeTasks, foldTasks, readTaskEvents, tasksFileFor } from './tasks.ts';
import {
  AdmissionAborted, autopilotOwner, isCappableBlocker, LEARNED_WALL_BUCKET, type Scheduler, type ScopeGrant,
} from './scheduler.ts';
import type { LeaveResult } from '../accounts/index.ts';
import { RETRY_STORM_PARK_MS, STALL_NUDGE_GRACE_MS } from '../../shared/attention-model.js';
import { formatScope } from '../../shared/scope.js';
import { TASK_TOOLS, adoptTaskId, foldTaskEvent, tasksFromList, taskSummary } from '../../shared/task-model.js';
import { newPollLoop, observeCall, type PollCall, type PollVerdict } from '../../shared/poll-loop.js';
import { processResources } from '../pid.ts';
import { Journal } from './journal.ts';
import { Transcript } from './transcript.ts';
import { checkAuth, type AuthStatus } from './auth.ts';
import {
  buildSettings, writeSettingsFile, loadPolicyFor,
  type Approvals, type PermissionProfile,
} from './approvals.ts';

import {
  CLOSEOUT_MAX_TURNS, DEFAULT_BUDGET_RAISE_PCT, GIT_FIRST_PROBE_MS, GIT_PROBE_MS, LADDER_SEEN_TTL_MS, LADDER_STATES, ladderClassifies, LEASE_REFRESH_MS, LIMIT_ACTION_COOLDOWN_MS, LIMIT_NONE_MAX, LIMIT_NONE_WINDOW_MS, WALL_REPROBE_BACKOFF_MS, LIMIT_RETRY_BURST, LIMIT_RETRY_WINDOW_MS, LIVENESS_GIT_EVERY_MS, LIVENESS_RESOURCES_EVERY_MS, LIVENESS_TICK_MS, RUN_PROGRESS_TICK_MS, LOCK_BACKOFF_MAX_MS, LOCK_CAP_PARK_BY_CAP, LOCK_CAP_PARK_BY_LOCK, LOCK_CAP_PARK_NOTE, LOCK_WAIT_CAP_MS, RUNNER_LEASE_S, lockStatusHolder, MAX_ATTEMPTS, MAX_INJECT_KEYS, MCP_AUTH_PARK_NOTE, EXTERNAL_PARK_GRACE_MS, EXTERNAL_WAIT_NUDGE, LOCAL_JOB_NUDGE, MCP_PARK_NOTE, SHUTDOWN_LADDER_MS, SIGTERM_GRACE_MS, SILENT_NUDGE, TEARDOWN_SETTLES, VERIFICATION_PARK_NOTE, VERIFY_ANSWER_MS, VERIFY_TIMEOUT_MS, DEFAULT_WAIT_BUDGET_MS, WAIT_DEFAULT_MS, WAIT_MAX_PER_PHASE, applySettings, authRefusal, briefForRung, closeoutPrompt, condenseSaid, escalateModel, fixVerificationInstruction, frameQuestion, frameSteer, prBlockText, preflight, reasonOf, survivingChildren, unattendedDirective, waitResumePrompt, wakeSignal, type AskResult, type Lane, type McpResolution, type ReboardRequest, type RecoverMode, type RecoverOptions, type RunSettingsPatch, type RunnerDeps, type RunnerEvent, type StartOptions,
} from './runner-core.ts';
import { contextCheckpointInstruction, contextWrapupNotice, resumePolicyInstruction, resumePolicyWhy, type VettedResume } from './runner-core.ts';
import { loadModelsEnv, sameModel } from './models.ts';
import { CONTEXT_CHECKPOINT_FRACTION, CONTEXT_WRAPUP_FRACTION, contextStage, contextWindowOf, tokensLabel } from './usage.ts';
import { RunnerAttempt } from './runner-attempt.ts';
import {
  pairKey, probeMirrorGit, probeRunGit, sameGitFacts, type RunGitView,
} from './worktree.ts';

export {
  LEASE_REFRESH_MS,
  RUNNER_LEASE_S,
  LOCK_BACKOFF_MAX_MS,
  LOCK_CAP_PARK_BY_CAP,
  LOCK_CAP_PARK_BY_LOCK,
  LOCK_CAP_PARK_NOTE,
  LOCK_WAIT_CAP_MS,
  MCP_AUTH_PARK_NOTE,
  MCP_PARK_NOTE,
  VERIFICATION_PARK_NOTE,
  DEFAULT_WAIT_BUDGET_MS,
  WAIT_DEFAULT_MS,
  WAIT_MAX_PER_PHASE,
  applySettings,
  lockedSettingRefusals,
  settingsBefore,
  briefForRung,
  escalateModel,
  frameQuestion,
  frameRelayAnswer,
  frameRelayNotice,
  frameSteer,
  preflight,
} from './runner-core.ts';
export type {
  AskResult,
  McpResolution,
  ReboardRequest,
  RecoverMode,
  RecoverOptions,
  RefusedSetting,
  RunSettingsPatch,
  RunnerDeps,
  RunnerEvent,
  StartOptions,
} from './runner-core.ts';
import { shell } from '../shell.ts';

/** `2 h 48 min`, `7 min` — a wait as the live wall's situation line states it. */
function hoursAndMinutes(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

/**
 * Who enacts a `run.usage-decision {action: switch}` (control-tower phase 92,
 * #100): the runner, on a session's own usage event — an automatic act, never
 * a person's, so it is not remembered as a choice and never clears one.
 */
/**
 * When this console process started, by its own clock — the half of its
 * `(pid, start time)` identity a lane beat records (control-tower phase 105),
 * compared with the kernel's start time for the pid by any reader. The same
 * boot every child this console launches names (`THIS_CONSOLE`, phase 110).
 */
const CONSOLE_STARTED_AT = THIS_CONSOLE.bootedAt;

const USAGE_DECISION_ACTOR = Object.freeze({ by: 'runner', via: 'event', origin: 'run.usage-decision', remoteUser: null } as const);

/**
 * What one of this runner's own vehicles does for a rung (control-tower phase
 * 79, #98): board the phase with a hint, move the run's account and then board,
 * or park the phase on a usage window's reset. `why` is the decision in words,
 * for `phase.rung`.
 */
type RunnerAct =
  | { kind: 'board'; hint: BoardingHint; why?: string }
  | { kind: 'switch'; from: string; to: string; reverts: AccountChoice | null; hint: BoardingHint; why?: string }
  | { kind: 'park'; until: string; why: string };

/** Why a deferred phase is undriven, for its card (#98). */
function deferredWhy(next: string | null): string {
  return `the ladder's next rung${next ? ` (${next})` : ''} is the healer's to drive, and the healer climbs only a `
    + 'stopped run — this one is still driving other phases, so nothing picks it up until a person does';
}

/**
 * A handoff's own contribution to the ladder's fingerprint (#114): its status
 * and a digest of its Outstanding section. An input, not a clock — it moves
 * exactly when the handoff does.
 */
function handoffStamp(handoff: { exists?: boolean; status?: string; outstanding?: string } | null | undefined): string {
  if (!handoff || handoff.exists === false) return '';
  const text = handoff.outstanding ?? '';
  // FNV-1a, 32-bit: cheap, and a fingerprint only has to tell two texts apart.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${handoff.status ?? ''}:${text.length}:${hash.toString(16)}`;
}

export class Runner extends RunnerAttempt {
  /* ---------------------------------------------------------------- *
   * The outcome protocol, the reconcile pass, and the park machinery
   * ---------------------------------------------------------------- */

  /** Where this run+phase's outcome file lives — the value of `PE_OUTCOME_FILE`. */
  protected outcomePath(phase: number): string {
    const state = this.state!;
    return outcomeFileFor(state.root, state.slug, state.id, phase);
  }

  /**
   * Arm `PE_OUTCOME_FILE` for a spawn: return the path, having deleted
   * whatever was there.
   *
   * CLAUDE.md says the outcome protocol is "staleness-guarded twice (deleted
   * pre-spawn; `written_at` checked against the attempt)", and the deletion
   * was written out by hand at each spawn site — so the third site, added
   * later, simply did not have it and leaned on the `notBefore` half alone.
   * One helper that does both jobs at once, so a fourth spawn site cannot
   * inject the variable without arming it: the path and the deletion are the
   * same expression now.
   */
  protected armOutcomeFile(phase: number): string {
    this.takeArmedOutcome(phase);
    return this.outcomePath(phase);
  }

  /**
   * Whatever declaration was ALREADY in the outcome file when a spawn came to
   * arm it — read, journalled `via: 'armed-file'`, and then consumed.
   *
   * The deletion is the point of `armOutcomeFile` and stays; what changed is
   * that the file is no longer destroyed unread (#21 §3). An orphan that
   * declared `complete` and exited left its last word here, and the ladder's
   * `resume-own-session` rung deleted it on the way to the `--resume` — so the
   * resumed session had to rediscover and re-declare a phase it had already
   * finished, and if it did not, nothing anywhere said it ever had.
   *
   * No `notBefore`: the writer of an armed file is by definition an earlier
   * session, and the whole reason to read it is that it is not this one's. The
   * staleness contract is unchanged for `takeOutcome`, which is the reader
   * that asks whether a declaration belongs to THIS attempt.
   */
  protected takeArmedOutcome(phase: number): PhaseOutcome | null {
    const state = this.state!;
    const path = this.outcomePath(phase);
    const read = readOutcome(path, { slug: state.slug, phase });
    const screened = read ? this.screenOutcome(phase, read, 'armed-file') : null;
    const declared = screened?.outcome ?? null;
    if (declared && screened) {
      this.record('phase.outcome', {
        via: 'armed-file',
        status: declared.status, reason: declared.reason ?? null,
        needs: declared.needs ?? null,
        resumeAfter: declared.resume_after ?? null, watch: declared.watch,
        ...screenedFields(screened),
        sessionId: declared.session_id ?? null,
      }, phase);
    }
    consumeOutcome(path);
    return declared;
  }

  /**
   * One screen for a declaration before anything acts on it (#42,
   * `screenDeclaration`): a watch on this phase's OWN lock is refused and
   * journalled with the sentence the script refuses it with, and a block on a
   * person keeps no watch and no clock.
   */
  protected screenOutcome(phase: number, outcome: PhaseOutcome, by: string): ScreenedDeclaration {
    const screened = screenDeclaration(outcome, this.state!.slug, phase);
    for (const ref of screened.ownLock) {
      this.record('phase.watch-refused', { ref, why: 'own-lock', reason: OWN_LOCK_WATCH_REFUSAL, by }, phase);
    }
    return screened;
  }

  /**
   * Read, journal and consume the session's declared outcome. Null means the
   * session declared nothing (or the file was stale/invalid), which degrades
   * to every legacy path unchanged.
   */
  protected takeOutcome(phase: number): PhaseOutcome | null {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const path = this.outcomePath(phase);
    const read = readOutcome(path, {
      // THIS attempt's start, never the phase's first: a file written by an
      // earlier attempt must not speak for the one that just ended.
      slug: state.slug, phase, notBefore: record.attemptStartedAt ?? record.startedAt,
    });
    consumeOutcome(path);
    if (!read) return null;
    const screened = this.screenOutcome(phase, read, 'ingest');
    const declared = screened.outcome;
    this.record('phase.outcome', {
      status: declared.status, reason: declared.reason ?? null,
      needs: declared.needs ?? null,
      resumeAfter: declared.resume_after ?? null, watch: declared.watch,
      ...screenedFields(screened),
    }, phase);
    return declared;
  }

  /* ---------------------------------------------------------------- *
   * The task-list channel — `PE_TASKS_FILE`, tailed while the session works
   * ---------------------------------------------------------------- */

  /** Where this run+phase's task file lives — the value of `PE_TASKS_FILE`. */
  protected tasksPath(phase: number): string {
    const state = this.state!;
    return tasksFileFor(state.root, state.slug, state.id, phase);
  }

  /**
   * Arm `PE_TASKS_FILE` for a spawn: return the path, having deleted whatever
   * was there and forgotten how far we had read.
   *
   * The two must move together. Deleting the file while keeping the offset
   * would leave the tail reading past the end of a shorter file for ever; the
   * offset alone is what `readTaskEvents` resumes from.
   *
   * The FOLD is deliberately left standing. A resume (`resumeWithInstruction`,
   * a closeout, a wait-resume) is the same phase continuing, and its session
   * updates rows by ids that only exist in `record.tasks` — dropping them would
   * turn every later update into an orphan. A retry is the other case, and
   * `resetForRetry` clears the list there; a fresh session's own first call is
   * `phase-tasks.sh <slug> <N> reset`, which the boot prompt asks for.
   */
  protected armTasksFile(phase: number): string {
    const path = this.tasksPath(phase);
    consumeTasks(path);
    delete phaseRecord(this.state!, phase).tasksAt;
    return path;
  }

  /**
   * Read whatever the session has appended since last time: fold it into the
   * record, broadcast each transition, journal the shape of the list.
   *
   * Returns whether the checkpoint is worth rewriting. Cheap enough to call on
   * a stream event — a `stat` and, when the file has grown, one read of the new
   * bytes — which is why it is called from there rather than on a timer of its
   * own: a session that writes a task line has just made a tool call, so the
   * result of that very call is the trigger.
   *
   * Never throws. A task list is worth strictly less than the run.
   */
  protected drainTasks(phase: number): boolean {
    const state = this.state;
    if (!state) return false;
    const record = phaseRecord(state, phase);
    const from = record.tasksAt ?? 0;
    let events, progress, at;
    try {
      ({ events, progress, at } = readTaskEvents(this.tasksPath(phase), {
        slug: state.slug, phase,
        // THIS attempt's start, exactly as the outcome protocol reads it: a
        // list written by an earlier attempt must not speak for this one.
        notBefore: record.attemptStartedAt ?? record.startedAt,
      }, from));
    } catch (error) {
      log.warn('runner.tasks', { phase, error: (error as Error)?.message ?? String(error) });
      return false;
    }
    if (at !== from) record.tasksAt = at;
    if (!events.length && !progress.length) return at !== from;

    // Broadcast BEFORE folding decides whether anything changed: an event the
    // fold treats as a no-op is still what the browser's own fold needs to see,
    // and the transcript is what replays it after a reload.
    for (const event of events) this.emit('stream', { phase, kind: 'task', ...event });

    // A progress line is said ON the task in progress at that point of the
    // file (control-tower phase 95, #163): fold up to it, name that task, and
    // journal it — `phase.progress`, kept on the record for the report.
    const before = record.tasks;
    let list = before;
    let cursor = 0;
    for (const said of progress) {
      list = foldTasks(list, events.slice(cursor, said.after));
      cursor = said.after;
      const active = list?.find((task) => task.status === 'in_progress');
      const task = active ? (active.id ?? active.key) : undefined;
      const line = { label: said.label, done: said.done, of: said.of, at: said.at, ...(task ? { task } : {}) };
      record.progress = line;
      this.record('phase.progress', line, phase);
    }
    // A list reset after the last progress line leaves nothing it measured.
    if (events.slice(cursor).some((event) => event.op === 'reset')) delete record.progress;
    const after = foldTasks(list, events.slice(cursor));
    if (after === before) return true;
    record.tasks = after;
    const summary = taskSummary(after);
    this.record('phase.tasks', { total: summary.total, done: summary.done, active: summary.active }, phase);
    return true;
  }

  /**
   * The drive loop's record-truth pass, run at the top of every tick: apply
   * resolutions recoveries queued while this loop owned the state, then close
   * whatever the board has overtaken. This is what lets a phase finished by a
   * manual session flip to done mid-run, and a halt about it dissolve, without
   * anyone pressing anything.
   */
  protected async applyReconcile(board: Board): Promise<void> {
    const state = this.state;
    if (!state) return;
    let touched = false;
    const now = new Date().toISOString();
    for (const resolution of this.pendingResolutions.splice(0)) {
      const record = phaseRecord(state, resolution.phase);
      const slot = ((state.recoveries ??= {})[String(resolution.phase)] ??= { attempts: 0, lastAt: now });
      slot.lastAt = now;
      if (resolution.outcome === 'done') {
        if (record.status !== 'done' && !PHASE_IN_FLIGHT.includes(record.status)) {
          record.status = 'done';
          record.endedAt ??= now;
          record.note = `closed by ${resolution.by}`;
        }
        slot.fixed = true;
        slot.lastOutcome = 'fixed';
        delete slot.lastReason;
      } else {
        slot.lastOutcome = 'no-defect';
        state.resolved ??= {
          at: now, auto: true,
          reason: `a recovery by ${resolution.by} found nothing wrong`,
        };
      }
      if (state.halt?.phase === resolution.phase) {
        state.halt = null;
        resetStreak(state);
      }
      this.record('phase.reconciled', { by: resolution.by, outcome: resolution.outcome }, resolution.phase);
      touched = true;
    }
    // A close whose reason is gone is not a close (control-tower phase 79,
    // #113): every record reconcile closed on the board's word is re-read, and
    // one the board no longer reads done goes back to `pending` — its session
    // kept, so the ladder pass below resumes it on this very tick.
    const back = reopenRegressedRecords(state, board.states);
    for (const row of back.reopened) {
      this.ladderSeen.delete(row.phase);
      this.record('phase.reopened', {
        by: 'reconcile', board: row.board, closedAt: row.closedAt, resumeSessionId: row.resumeSessionId,
      }, row.phase);
      this.emit('phase', { phase: row.phase, status: 'pending', note: state.phases[String(row.phase)]?.note });
      touched = true;
    }
    // …and only COMMITTED handoff content closes one (#113): the board reads
    // whatever file is newest, an untracked scaffold included.
    const hold = await this.uncommittedHandoffs(board);
    const { changed, closed, held } = reconcileRecordsAgainstBoard(
      state, board.states, undefined, this.declarationSink(), { hold },
    );
    if (changed) {
      for (const phase of closed) {
        this.clearParkPoke(phase);
        this.reconcileHeld.delete(phase);
        this.record('phase.reconciled', { by: 'the board', outcome: 'done' }, phase);
        this.emit('phase', { phase, status: 'done' });
      }
      touched = true;
    }
    for (const phase of held) {
      // Said once per file state, not once per tick: the next change to the
      // handoff (a commit, an edit) is what makes it worth saying again.
      const stamp = hold.stamp.get(phase) ?? '';
      if (this.reconcileHeld.get(phase) === stamp) continue;
      this.reconcileHeld.set(phase, stamp);
      this.record('phase.reconcile-held', {
        reason: 'the board reads it done off a handoff that is not committed — untracked or changed in the working tree',
        files: hold.files.get(phase) ?? [],
      }, phase);
    }
    if (touched) {
      this.persist();
      this.emit('run', { state });
    }
  }

  /**
   * Stamp `undriven` on every phase nothing of this live run drives
   * (control-tower phase 79, #114), and clear it the tick one is driven again.
   * Undriven: its record is one nothing drives by being (`UNDRIVEN_STATUSES`),
   * it has no lane, no boarding hint, no standing errand and no owed
   * re-verification, this tick is not boarding it — and either the board reads
   * it `in-progress`/`stuck` (a pending or queued record the board says someone
   * is on), or the ladder DEFERRED it to a healer that only climbs a stopped
   * run. `since` holds for the episode; `phase.undriven` is journalled once per
   * episode.
   */
  protected noteUndriven(board: Board, boarding: ReadonlySet<number>): void {
    const state = this.state;
    if (!state) return;
    const now = this.now().toISOString();
    const asked = state.onlyPhases?.length ? new Set(state.onlyPhases) : null;
    let changed = false;
    for (const record of Object.values(state.phases)) {
      const phase = record.phase;
      const word = board.states[phase];
      const stamp = record.undriven;
      // A hint alone is not being driven (control-tower phase 86, #114): it is
      // a request, and a request no candidate pass takes is exactly the phase
      // that sat "in progress" for hours. Driven means boarded, a candidate of
      // this tick (queued, serial or waiting for a lane), parked or asked.
      const driven = !(UNDRIVEN_STATUSES as readonly string[]).includes(record.status) || this.lanes.has(phase)
        || boarding.has(phase) || owesVerification(record)
        || Boolean(state.recoveries?.[String(phase)]?.errand) || Boolean(asked && !asked.has(phase));
      const onBoard = (word === 'in-progress' || word === 'stuck') && (record.status === 'pending' || record.status === 'queued');
      const deferred = Boolean(stamp?.deferred) && Boolean(word) && !['done', 'waiting', 'unknown'].includes(word);
      if (driven || !(onBoard || deferred)) {
        if (stamp) { delete record.undriven; changed = true; }
        continue;
      }
      const situation = record.situation?.key ?? null;
      const why = stamp?.deferred ? stamp.why
        : record.boardingHint
          ? `hinted ${record.boardingHint.rung} since ${record.boardingHint.at}, and no candidate pass of this run takes it`
        : record.status === 'queued'
          ? 'the record reads queued, and no lane of this run is waiting on the scheduler for it — there is no queue entry to admit it'
          : !state.autoRecover
            ? 'auto-recovery is off for this run, so the ladder climbs nothing for it by itself'
            : situation
              ? `last classified ${situation}; no rung this run drives has picked it up`
              : 'no lane, queue entry, boarding hint, park or errand of this run holds it';
      if (stamp && stamp.board === word && stamp.why === why && stamp.situation === situation) continue;
      const next: UndrivenStamp = { since: stamp?.since ?? now, board: word, situation, why, ...(stamp?.deferred ? { deferred: stamp.deferred } : {}) };
      record.undriven = next;
      if (!stamp) this.record('phase.undriven', { board: word, situation, why }, phase);
      changed = true;
    }
    if (changed) this.persist();
  }

  /** The last uncommitted handoff each held close was about — see `phase.reconcile-held`. */
  private reconcileHeld = new Map<number, string>();

  /**
   * The phases whose board `done` rests on handoff content git does not have
   * committed (control-tower phase 79, #113) — asked only when reconcile would
   * close something, in ONE `git status` of the plan's handoff directory in the
   * docs root (the run's `root`, never its code checkout). A root git cannot
   * answer for is not a finding: the set comes back empty and the board's word
   * closes records as it always did.
   */
  private async uncommittedHandoffs(board: Board): Promise<Set<number> & { files: Map<number, string[]>; stamp: Map<number, string> }> {
    const out = Object.assign(new Set<number>(), { files: new Map<number, string[]>(), stamp: new Map<number, string>() });
    const state = this.state!;
    const closing = Object.values(state.phases)
      .filter((record) => RECONCILABLE.includes(record.status) && board.states[record.phase] === 'done')
      .map((record) => record.phase);
    if (!closing.length) return out;
    const dir = join('docs', 'handoffs', state.slug);
    const status = await this.gitOrNull(['-C', state.root, 'status', '--porcelain', '--untracked-files=all', '--', dir]);
    if (!status) return out;
    for (const line of status.split('\n')) {
      if (line.trim().length < 4) continue;
      const path = line.slice(3).trim().replace(/^"|"$/g, '');
      const match = /(?:^|\/)phase-0*(\d+)-[^/]*\.md$/.exec(path);
      if (!match) continue;
      const phase = Number(match[1]);
      if (!closing.includes(phase)) continue;
      out.add(phase);
      out.files.set(phase, [...(out.files.get(phase) ?? []), path]);
      out.stamp.set(phase, `${out.stamp.get(phase) ?? ''}${line.slice(0, 2)}${path};`);
    }
    return out;
  }

  /**
   * A phase parked at the two-hour lock cap re-arms by itself once the lock it
   * waited on is gone.
   *
   * The park was honest — a dead-but-unexpired claim must not hold a lane for
   * ever — but it used to be TERMINAL: `parked` is settled, so the phase never
   * boarded again for the life of the run, and the only remedy was a person's
   * Retry long after the holder had released. The holder releasing is exactly
   * the event the wait was for, and the docs watcher already wakes this loop
   * on it. The stopped-run half of the same promise — the loop ended with the
   * park as the last word — lives in the convergence loop (`converge.ts`,
   * `lock-cap-rearm`).
   */
  protected async rearmLockCapParks(board: Board): Promise<void> {
    const state = this.state!;
    const own = autopilotOwner(state.id);
    for (const record of Object.values(state.phases)) {
      // Narrower than `LOCK_CAP_PARK_NOTE`, deliberately: a wait-cap park has
      // three possible causes and only two of them have a question this pass
      // can answer. A LOCK park asks `phase-lock.sh status`. A CAP park asks
      // the scheduler whether a lane is free — D28 made the session cap an
      // honest holder, so a merely BUSY fleet can park a phase, and without
      // this that park was a dead end (`LOCK_CAP_PARK_BY_CAP`; the two
      // predicates are disjoint by construction). A GRANT park — since
      // tree-qualified claims made a FOREIGN run's grant a normal holder, not
      // only a hung sibling — asks the scheduler's own admission probe, the
      // one oracle that sees grants AND locks (`wouldBlock`).
      if (record.status !== 'parked') continue;
      const byLock = LOCK_CAP_PARK_BY_LOCK.test(record.note ?? '');
      const byCap = !byLock && LOCK_CAP_PARK_BY_CAP.test(record.note ?? '');
      const byGrant = !byLock && !byCap && LOCK_CAP_PARK_NOTE.test(record.note ?? '');
      if (!byLock && !byCap && !byGrant) continue;
      if (board.states[record.phase] === 'done') continue;
      let free = false;
      if (byCap) {
        // No scheduler wired ⇒ no answer ⇒ no re-arm. The fail-safe direction:
        // a park that stays is a phase a person can Retry, where a park cleared
        // on a guess is a re-board straight back into the same full fleet.
        const fleet = this.deps.scheduler?.snapshot();
        free = fleet ? fleet.live < fleet.max : false;
      } else if (byGrant) {
        // Asked with this phase's exact claim (scope, branch, tree) — the
        // SAME probe a real admission would face — so a hung sibling's
        // standing grant still blocks it and D2's re-park loop cannot recur,
        // while a released foreign run reads as the empty answer it is. No
        // scheduler wired ⇒ no answer ⇒ no re-arm, like the cap arm.
        const scheduler = this.deps.scheduler;
        if (scheduler) {
          try {
            // `qualificationFor`, not `branchFor`/`treeFor` (SCH-4). The pair
            // has one extra rule those two do not: NEITHER dimension is stated
            // for a scope the run root does not contain, because a claim about
            // a tree the session never edits is a false carve. Probing with the
            // raw pair asked a question no real admission would ever ask, so an
            // unconfined scope answered "free" when admission would refuse —
            // and the phase re-boarded, re-parked, and did it again for two
            // hours. The probe must present the claim the admission presents.
            const scope = await this.scopeFor(record.phase);
            free = scheduler.wouldBlock({
              slug: state.slug, phase: record.phase, runId: state.id,
              scope,
              ...this.qualificationFor(record.phase, scope),
            }).length === 0;
          } catch { free = false; }
        }
      } else {
        try {
          const status = await this.script('phase-lock.sh', [state.slug, 'status', String(record.phase)]);
          const expired = status.stdout.includes('EXPIRED');
          const holder = expired ? undefined : lockStatusHolder(status.stdout);
          free = !holder || holder === own;
        } catch { free = false; }
        // 🔴 …and nothing cappable holds its SCOPE any more (#82). `status` asks
        // about this phase's own lock, which a cross-plan wait never touched:
        // the claim it was capped behind belongs to another plan, so this read
        // came back free seconds after the park and the wait "started over"
        // behind the very lock that parked it. The scheduler's probe names the
        // claims that actually meet this phase's scope.
        const scheduler = this.deps.scheduler;
        if (free && scheduler) {
          try {
            const scope = await this.scopeFor(record.phase);
            free = !scheduler.wouldBlock({
              slug: state.slug, phase: record.phase, runId: state.id, scope, ...this.qualificationFor(record.phase, scope),
            }).some(isCappableBlocker);
          } catch { free = false; }
        }
      }
      if (!free) continue;
      const was = record.note;
      resetForRetry(record, { by: 'console', journal: this.declarationSink() });
      this.record('phase.lock-cap-rearmed', {
        was,
        note: byCap
          ? 'a lane has freed up — the wait starts over'
          : byGrant
            ? 'nothing holds its scope any more — the wait starts over'
            : 'the lock it waited on is gone — the wait starts over',
      }, record.phase);
      this.emit('phase', { phase: record.phase, status: record.status });
      this.persist();
    }
  }

  /** Poke the drive loop when a park's window elapses, so the resume is on time. */
  protected armParkPoke(phase: number, untilIso: string): void {
    this.clearParkPoke(phase);
    const delay = Math.max(0, Date.parse(untilIso) - Date.now());
    const timer = setTimeout(() => {
      this.parkPokes.delete(phase);
      // A frozen console does not wake its own loops. The poke is a pure
      // nudge — the park's `until` lives on the phase record and the loop
      // re-reads it — so dropping it costs the promptness and nothing else,
      // and the thaw's poll supplies that back. Gated at FIRE time, so no
      // clock has to be rewound and the park is not rewritten.
      let frozen: { by?: string; plans?: readonly string[] } | null | undefined;
      try { frozen = this.deps.fleetHold?.(); } catch { frozen = null; }
      if (frozen && holdBinds(frozen, this.state?.slug)) {
        log.info('runner.park-poke-frozen', { slug: this.state?.slug ?? null, phase, by: frozen.by ?? null });
        return;
      }
      this.wake.resolve();
    }, delay);
    timer.unref?.();
    this.parkPokes.set(phase, timer);
  }

  protected clearParkPoke(phase: number): void {
    const timer = this.parkPokes.get(phase);
    if (timer) clearTimeout(timer);
    this.parkPokes.delete(phase);
  }

  /**
   * Re-read every usage wall this run's phases are parked on (control-tower
   * phase 54, #78). A wall's reset is "until at the latest": the quota door
   * (`deps.accountHeadroom`) is asked about the account the phase would board
   * under — the run's, which a switch may have moved since the park — and
   *
   *  - a yes lifts the park now (`phase.wall-lifted`): the clock is set to
   *    this instant and the poke fires, so the loop resumes it as it resumes
   *    any elapsed park;
   *  - an earlier reset shortens it (`phase.wall-reread`); a later one never
   *    lengthens it — the wall's own clock stays the bound;
   *  - a retirement leaves it alone: that is the breaker's to settle.
   *
   * A lane asleep on a usage window inside its attempt (`waitOutWindow`) is
   * woken the same way when the run's account can pay. `trigger` names what
   * asked: a fresh meter reading (the service, on every accounts change), a
   * spend that went through (`noteSpendProof`), or this phase's own back-off
   * re-probe. Answers how many parks moved.
   */
  rereadWalls(trigger: 'reading' | 'spend' | 'reprobe'): number {
    const state = this.state;
    const headroom = this.deps.accountHeadroom;
    if (!state || !headroom) return 0;
    const now = this.now().getTime();
    const at = new Date(now).toISOString();
    const account = state.accountId ?? 'default';
    let moved = 0;
    // A reading with room is new information for every phase the ladder left
    // standing on a wall (#114): judged again now, not at the fingerprint's expiry.
    const walled = Object.values(state.phases)
      .filter((record) => this.ladderSeen.has(record.phase) && String(record.situation?.key ?? '').startsWith('resource-wall:'))
      .map((record) => record.phase);
    if (walled.length) {
      let open = false;
      try { open = headroom(account === 'default' ? undefined : account, state.model).ok; } catch { open = false; }
      if (open) this.forgetSeen(walled);
    }
    for (const record of Object.values(state.phases)) {
      const wall = record.usageWall;
      if (!wall) continue;
      if (record.status !== 'waiting' || !record.parkedUntil) continue;
      const phase = record.phase;
      const until = Date.parse(record.parkedUntil);
      if (!Number.isFinite(until) || until <= now) continue;
      let verdict: ReturnType<NonNullable<RunnerDeps['accountHeadroom']>>;
      try {
        verdict = headroom(account === 'default' ? undefined : account, record.model ?? state.model);
      } catch {
        continue;
      }
      const resetsAt = !verdict.ok && verdict.resetsAt && Number.isFinite(Date.parse(verdict.resetsAt)) ? verdict.resetsAt : undefined;
      wall.lastReading = { at, by: trigger, ok: verdict.ok, ...(resetsAt ? { resetsAt } : {}) };
      if (verdict.ok) {
        const was = record.parkedUntil;
        record.parkedUntil = at;
        syncWaitClock(state);
        record.parkReason = `the usage wall lifted — ${account} has headroom again (${trigger}), `
          + `before the reset it reported (${was}).`;
        record.note = record.parkReason;
        this.record('phase.wall-lifted', {
          account, bucket: wall.bucket, by: trigger, was, probes: wall.probes,
          ...(account !== wall.account ? { walled: wall.account } : {}),
        }, phase);
        this.emit('phase', { phase, status: 'waiting', note: record.parkReason, parkedUntil: at });
        this.clearWallProbe(phase);
        this.armParkPoke(phase, at);
        moved += 1;
        continue;
      }
      if (resetsAt && Date.parse(resetsAt) < until) {
        const from = record.parkedUntil;
        record.parkedUntil = new Date(Date.parse(resetsAt)).toISOString();
        syncWaitClock(state);
        record.parkReason = `${record.parkReason ?? 'a usage wall'} Re-read (${trigger}): the window now resets at `
          + `${record.parkedUntil}, sooner than ${from}.`;
        record.note = record.parkReason;
        this.record('phase.wall-reread', { account, bucket: wall.bucket, by: trigger, from, to: record.parkedUntil }, phase);
        this.emit('phase', { phase, status: 'waiting', note: record.parkReason, parkedUntil: record.parkedUntil });
        this.armParkPoke(phase, record.parkedUntil);
        moved += 1;
      }
      // A park that outlived its loop (a restart) is re-probed from here on.
      if (!this.wallProbes.has(phase)) this.armWallProbe(phase);
    }
    // The in-attempt wait: the run itself sleeps on a usage window.
    if (state.status === 'waiting' && state.waitReason === 'usage-limit') {
      let verdict: ReturnType<NonNullable<RunnerDeps['accountHeadroom']>> | null = null;
      try { verdict = headroom(account === 'default' ? undefined : account, state.model); } catch { verdict = null; }
      if (verdict?.ok) {
        this.record('run.window-lifted', { account, by: trigger, was: state.waitUntil ?? null });
        this.haltSignal.dispatchEvent(new Event('wake'));
        moved += 1;
      }
    }
    if (moved) {
      // A lifted wall may be what a queued boarding waits on — the scheduler
      // reads the same walls, so a rescan admits it now. And the run's clock
      // moved with the park: a loop that settled `waiting` is resumed by the
      // service from that clock, re-armed off this emit.
      this.deps.scheduler?.poll();
      this.persist();
      this.emit('run', { state });
    }
    return moved;
  }

  /**
   * Arm the next back-off re-probe of a walled phase's account (#78): one
   * usage read (`deps.refreshUsage`), then `rereadWalls('reprobe')`, then the
   * next step of `WALL_REPROBE_BACKOFF_MS` while the phase is still parked on
   * the wall. A probe never spawns a session and never fights a freeze — the
   * read is harmless, and the park poke already holds itself to a freeze.
   */
  protected armWallProbe(phase: number): void {
    this.clearWallProbe(phase);
    const record = this.state?.phases[String(phase)];
    const wall = record?.usageWall;
    if (!record || !wall || record.status !== 'waiting') return;
    // A lifted park (its clock at or before now) is the loop's to resume, not a wall to probe.
    if (!record.parkedUntil || Date.parse(record.parkedUntil) <= this.now().getTime()) return;
    const steps = this.deps.wallReprobeBackoffMs ?? WALL_REPROBE_BACKOFF_MS;
    if (!steps.length) return;
    const delay = steps[Math.min(wall.probes, steps.length - 1)];
    const timer = setTimeout(() => {
      this.wallProbes.delete(phase);
      void this.reprobeWall(phase);
    }, delay);
    timer.unref?.();
    this.wallProbes.set(phase, timer);
  }

  private async reprobeWall(phase: number): Promise<void> {
    const state = this.state;
    const record = state?.phases[String(phase)];
    if (!state || !record?.usageWall || record.status !== 'waiting') return;
    // Only a run that means to go on is worth a read: one a person stopped
    // resumes by their press, and asks nothing of the account meanwhile.
    if (state.status !== 'running' && state.status !== 'waiting') return;
    const account = state.accountId ?? 'default';
    try {
      await this.deps.refreshUsage?.(account === 'default' ? undefined : account);
    } catch (error) {
      log.warn('runner.wall-reprobe-failed', { phase, account, error });
    }
    // The read may have been long enough for the phase to move on.
    const now = this.state?.phases[String(phase)];
    if (!now?.usageWall || now.status !== 'waiting') return;
    now.usageWall.probes += 1;
    this.rereadWalls('reprobe');
    const after = this.state?.phases[String(phase)];
    if (after?.usageWall && after.status === 'waiting' && !this.wallProbes.has(phase)) this.armWallProbe(phase);
  }

  protected clearWallProbe(phase: number): void {
    const timer = this.wallProbes.get(phase);
    if (timer) clearTimeout(timer);
    this.wallProbes.delete(phase);
  }

  /** Start the lane's lease keepalive. See `Lane.leaseTimer`. */
  protected armLeaseTimer(lane: Lane, owner: string): void {
    this.clearLeaseTimer(lane);
    this.beatLane();
    const cadence = this.deps.leaseRefreshMs ?? LEASE_REFRESH_MS;
    const timer = setInterval(() => { void this.refreshLease(lane, owner); }, cadence);
    timer.unref?.();
    lane.leaseTimer = timer;
  }

  /**
   * The lane's beat (control-tower phase 105, #173): a lock this console holds
   * for a lane and keeps refreshing is a lane at work, and the run says so in
   * a fact any reader can check — this console's own `(pid, start time)` and
   * when — so a read that does not know the run is live never reclaims it as
   * `interrupted` mid-Setup, mid-baseline or mid-lint (`laneInFlight`).
   */
  private beatLane(): void {
    const state = this.state;
    if (!state) return;
    state.laneBeat = { at: new Date().toISOString(), pid: process.pid, procStartedAt: CONSOLE_STARTED_AT };
    this.persist();
  }

  protected clearLeaseTimer(lane: Lane): void {
    if (lane.leaseTimer) clearInterval(lane.leaseTimer);
    lane.leaseTimer = null;
  }

  /**
   * Refresh the lane's phase lock under the shared owner. Same-owner `claim`
   * moves the lease forward (phase-lock.sh treats it as a refresh); `--scope`
   * must ride along or the rewrite drops the `scope=` line and the lock starts
   * colliding with everything. A refusal means a foreign `--force` takeover:
   * journal it and stand down — the console never fights a person for a lock.
   */
  private async refreshLease(lane: Lane, owner: string): Promise<void> {
    const state = this.state;
    if (!state || !this.lanes.has(lane.phase)) return;
    // One tick at a time. A starved event loop delivers interval callbacks
    // back-to-back, and two overlapping ticks would BOTH pass this point,
    // both get refused by a foreign takeover, and journal one stand-down
    // twice. The timer check catches the queued tick that arrives after a
    // refusal already cleared the interval.
    if (lane.leaseBusy || !lane.leaseTimer) return;
    lane.leaseBusy = true;
    try {
      const tokens = lane.grant?.scope ?? await this.scopeFor(lane.phase);
      const scope = formatScope(tokens);
      // The session id rides along when the record knows it, so the refreshed
      // lock keeps naming the session the registry answers presence for (a
      // refresh that names none keeps the line anyway — this is belt and braces).
      const sessionId = phaseRecord(state, lane.phase).sessionId;
      // Both read through the BASE rather than off the lane, so the two shapes
      // that have a checkout of their own answer here: a worktree LANE
      // (`Lane.worktree`/`branch`) and an isolated RUN (`state.workRoot`, on
      // `pe/<slug>`). P7 shipped this reading `lane.branch` alone, which left
      // the run shape writing an unqualified lock and collecting no carve-out.
      // BOTH dimensions, from the same functions that fill the session's env —
      // `conflicts` DECIDES on the pair, so a refresh that let either line
      // fall off would re-qualify a lock as colliding-with-everything a third
      // of a lease into the run. `treeFor` falls to the shared root: a shared
      // session's tree is a fact, and it is the fact that keeps two shared
      // runs colliding whatever branches they name.
      // …and NEITHER for a scope the root does not contain, exactly as the
      // admission and the session's env answered (`qualificationFor`): a
      // refresh that re-qualified such a lock would re-open the false carve.
      const { tree: worktree, branch } = this.qualificationFor(lane.phase, tokens);
      // Outside the engine pool (#77): eight plan-page reads must not be able
      // to hold the one write that keeps a live session's claim alive.
      const result = await this.lockScript('phase-lock.sh', [
        state.slug, 'claim', String(lane.phase), '--owner', owner, '--scope', scope,
        // STATED rather than left to the script's default. 🔴 It was written
        // as `3 × LEASE_REFRESH_MS` under a comment claiming 5400 seconds —
        // which is 30 MINUTES, because that constant is in milliseconds. Two
        // units in one expression, and the shipped argv said 1800. The number
        // is a named constant in its own unit now (`RUNNER_LEASE_S`), and the
        // relationship to the refresh cadence is stated there in words.
        '--lease', String(RUNNER_LEASE_S),
        ...(sessionId ? ['--session', sessionId] : []),
        ...(worktree ? ['--worktree', worktree] : []),
        ...(branch ? ['--branch', branch] : []),
      ]);
      // What the script SAID decides, never how its process ended (#77): a
      // refresh killed at its ceiling after printing "lock refreshed" once
      // stopped the live session holding that very lock. See `leaseAction`.
      const action = leaseAction(result, owner);
      if (action.act === 'keep') {
        this.record('phase.lock-refreshed', { detail: action.detail.slice(0, 120) }, lane.phase);
        this.beatLane();
      } else if (action.act === 'retry') {
        // No verdict is not a refusal. The lease has eight missable cadences
        // of headroom, so the next tick is the retry; a lock somebody really
        // took is learned from the first refresh that answers.
        this.record('phase.lock-refresh-unanswered', {
          why: action.why, code: action.code, timedOut: action.timedOut, detail: action.detail,
        }, lane.phase);
      } else {
        // LOST IT — and losing it is not news, it is an instruction.
        //
        // This used to journal the line and clear its own timer, and let the
        // lane carry on editing a working tree whose claim another session now
        // holds. The journal entry was written for a person who was not there;
        // the whole point of the cooperative guard is that the loser STANDS
        // DOWN, and this is the only place that ever learns it lost.
        //
        // Through `stopPhase`, not a bespoke settle: it is the one door that
        // names the session before signalling, takes the kill ladder, keeps the
        // session id so a Retry can resume, and settles the record
        // `interrupted` without touching the failure streak — which is right,
        // because losing a lock is not a diagnosis of this phase's work.
        const stopped = this.stopPhase(lane.phase, `a foreign takeover of the phase lock`);
        // The exit code and `timedOut` it acted on ride the line, so a
        // stand-down can always be checked against what the script answered.
        this.record('phase.lock-lost', {
          detail: action.detail, holder: action.holder, code: action.code, timedOut: action.timedOut,
          stopped: stopped.ok,
          ...(stopped.ok ? {} : { why: stopped.reason }),
        }, lane.phase);
        this.clearLeaseTimer(lane);
      }
    } catch (error) {
      log.warn('runner.lease-refresh', { phase: lane.phase, error });
    } finally {
      lane.leaseBusy = false;
    }
  }

  /** Read-only git against the run's root. Empty string on any failure. */
  private async git(args: string[]): Promise<string> {
    const state = this.state!;
    const run = await shell('git', args, {
      channel: 'git', intent: 'run-root', cwd: state.root, timeout: 15_000,
      capture: { keep: 4 * 1024 * 1024, mode: 'head' },
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
      expectFailure: true,
    });
    return run.ok ? run.stdout.trim() : '';
  }

  /**
   * A question nobody can answer any more is not a question — it is a phantom.
   *
   * When the loop ends, the approval broker is disarmed, so any card still up is
   * unanswerable. The phase record kept saying `awaiting-verification` anyway,
   * and the dashboard kept rendering it as "Waiting on you" against a run that
   * had halted hours earlier.
   */
  protected settleAwaitingVerification(): void {
    const state = this.state;
    if (!state) return;
    // Only where there was a broker to disarm. A console configured without one
    // never raised a card, so its `awaiting-verification` is not a phantom — it
    // is the honest statement that this phase needs a person and there was no
    // way to ask. Rewriting that would erase the reason the run stopped.
    if (!this.deps.approvals) return;
    for (const record of Object.values(state.phases)) {
      if (record.status !== 'awaiting-verification') continue;
      record.status = 'interrupted';
      record.note ??= 'the run ended while this was waiting to be verified, so the question went away with it';
      record.endedAt ??= new Date().toISOString();
      record.resumeSessionId ??= record.sessionId;
      this.emit('phase', { phase: record.phase, status: record.status });
    }
  }

  /**
   * Put the checks the runner could not make in front of a person, and wait.
   *
   * Refusing to execute prose out of a markdown file is correct — a plan that
   * says "run those commands" is not a command, and executing what a document
   * tells you to is how a document becomes an exploit. But refusing and then
   * stopping with no way to say "I have checked it" left the run wedged: the
   * only controls offered were Retry, which re-runs a session that was never
   * the problem, and Skip, which discards a phase that had in fact succeeded.
   *
   * So the fragments become a card carrying the plan's own words, and a person
   * decides. Allow records the verification as satisfied by hand — attributed,
   * not silently rewritten. Deny halts, which is what Retry was pretending to
   * offer. Returns false when the run must stop.
   */
  protected async askHuman(
    phase: number, verification: VerifySummary,
    // The entries that are genuinely QUESTIONS — `confirm()` filters out the
    // machine's own reasons (cascade skips, stop skips) before asking. The
    // stored record keeps the full summary either way.
    askable: VerifySummary['notRun'] = verification.notRun,
  ): Promise<boolean> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const { approvals } = this.deps;
    const suppressed = verification.notRun.length - askable.length;

    // The plan's answer for a check written as prose (phase 11, ZTD-6): the
    // phase's `- **Person-check:**` bullet, else this console's policy, else the
    // shipped `operator` (today's card). `allow` waives the checks by policy —
    // recorded as such, no card, no wait; `halt` was answered at boarding
    // (`preflightVerification`), so a phase reaching here under it is one whose
    // prose arrived through a refused command rather than the plan text, and
    // it is treated as the owner's; any other word names who is asked.
    const personCheck = this.personCheckFor(phase);
    if (personCheck.answer === 'allow') {
      const redStands = !verification.ok && verification.ran.length > 0;
      const waived = `${askable.length} manual check(s) waived by policy (Person-check: allow, from the ${personCheck.source})`;
      record.verification = {
        ...verification,
        ok: !redStands,
        reason: redStands ? `${verification.reason}; ${waived}` : waived,
      };
      this.record('phase.verify-waived', {
        stage: 'verify', by: 'policy', decisionKey: 'verification.person-check', source: personCheck.source,
        notRun: askable, ...(suppressed ? { suppressed } : {}),
      }, phase);
      this.record('phase.policy-answered', {
        situation: 'verify-red', decisionKey: 'verification.person-check', answer: 'allow', source: personCheck.source,
        label: 'Verification prose', reason: `${askable.length} check(s) written as prose`, by: 'verify',
      }, phase);
      this.persist();
      return true;
    }

    record.status = 'awaiting-verification';
    this.record('phase.awaiting-verification', { notRun: askable, ...(suppressed ? { suppressed } : {}) }, phase);
    this.emit('phase', { phase, status: 'awaiting-verification', notRun: askable.length });
    this.persist();

    if (!approvals) {
      record.note = `${askable.length} verification step(s) need a person, and this console has no `
        + 'approval broker to ask with.';
      this.halt(`phase ${phase} needs a person to verify it, and there is no way to ask`, phase, 'needs-human');
      return false;
    }

    const { approval, decided } = approvals.request({
      runId: state.id,
      slug: state.slug,
      phase,
      kind: 'verify',
      title: `Phase ${phase}: ${askable.length} check${askable.length === 1 ? '' : 's'} only you can make`
        + (personCheck.answer && !['halt', 'operator'].includes(personCheck.answer) ? ` (Person-check: ${personCheck.answer})` : ''),
      detail: verification.ran.length
        ? `${verification.ran.length} command(s) ran and passed. The rest is written as prose in the plan, so the runner will not execute it.`
        : 'Nothing in this phase\'s verification is a command the runner can execute, so nothing has been proven either way.',
      evidence: [
        ...askable.map((n, i) => ({
          label: `Check ${i + 1} — ${n.reason}`,
          body: n.text,
        })),
        ...(verification.ran.length ? [{
          label: `${verification.ran.length} command(s) that did run`,
          body: verification.ran.map((r) => `$ ${r.command}\n${r.output || '(no output)'}`).join('\n\n'),
        }] : []),
      ],
    }, this.deps.verifyAnswerMs ?? VERIFY_ANSWER_MS);
    // The run is waiting on a PERSON from here until the card is decided — a
    // wait like any other (WAI-10): `waitReason: 'person'` (`WAIT_REASONS`'
    // fifth word, and this is its production writer, LFC-5), `waitUntil` at
    // the card's expiry, the status `waiting`. It used to keep `running` with
    // no child and no spend for up to twelve hours.
    this.enterPersonWait(phase, { id: approval.id, until: approval.expiresAt, on: `phase ${phase} verification card` });

    const outcome = await decided;
    // The card is down: whatever happens next, the run is no longer waiting on
    // a person's answer to it.
    this.leavePersonWait(approval.id);
    this.record('phase.human-verified', { decision: outcome.decision, by: outcome.by, reason: outcome.reason }, phase);

    // Nobody answered, or the run ended under the card. Neither is a person
    // saying the checks failed — it is the same "nobody is awake" the tool
    // card's timeout means, and it takes the same disposition (`Service.
    // decideToolUse` → `park`): the phase parks with the question standing,
    // the streak is untouched, and the run parks for a person instead of
    // counting an unanswered card as a failure. It used to be `failed` plus a
    // streak increment, so two quiet evenings halted a plan with
    // `failure-streak` about work nobody had found fault with.
    if (outcome.by === 'timeout' || outcome.by === 'run ended') {
      record.status = 'parked';
      record.note = `${askable.length} verification check(s) need a person and the card `
        + `${outcome.by === 'timeout' ? 'went unanswered' : 'was still up when the run ended'} — `
        + 'confirm them on the phase page (Verify), then Retry.';
      record.endedAt = new Date().toISOString();
      this.record('phase.verify-unanswered', { by: outcome.by, notRun: askable.length }, phase);
      this.emit('phase', { phase, status: 'parked', note: record.note });
      // `awaiting-person`, not `needs-human`: a person was ASKED and did not
      // answer, which is a different situation from an errand nobody has been
      // asked about yet (WAI-10).
      this.park(`phase ${phase}'s verification card went unanswered: ${askable.length} `
        + 'check(s) only a person can make', phase, 'awaiting-person');
      return false;
    }

    if (outcome.decision === 'allow') {
      // The person confirmed the CHECKS nobody could run — not the command
      // that ran and exited red. A tap on "the docker line is fine" used to
      // repaint a measured red green: `ok` flipped to true wholesale, erasing
      // the verdict the overtaken rule had deliberately kept on the record.
      // `ok: false` with `ran` non-empty can only mean a final red stands
      // (a stop returns before this card; "nothing ran" has an empty `ran`),
      // so that red survives the confirmation, named in the reason.
      const redStands = !verification.ok && verification.ran.length > 0;
      const confirmed = `${askable.length} manual check(s) confirmed by ${outcome.by}`
        + (outcome.reason ? ` — ${outcome.reason}` : '');
      record.verification = {
        ...verification,
        ok: !redStands,
        reason: redStands ? `${verification.reason}; ${confirmed}` : confirmed,
      };
      return true;
    }

    record.status = 'failed';
    this.chargeFailure(phase, 'checks-failed', 'a person marked the manual checks failed');
    this.halt(
      `phase ${phase} was not verified: ${outcome.reason || `${outcome.by} marked the manual checks as failed`}`,
      phase,
      'needs-human',
    );
    return false;
  }

  /* ---------------------------------------------------------------- *
   * The ladder in the loop — classify, climb, brief
   *
   * The runner's own vehicles for the remediation ladder (`runner/ladder.ts`):
   * a fresh re-board, a re-board with a RESUMING or UNBLOCK brief appended to
   * the engine's boot prompt, the phase's own session continued, the phase's
   * own session asked to close out, and the queue behind a lock. Every other
   * rung (a fresh briefed agent, a plan-repair script, the resource walls) is
   * the service's — this loop skips them and leaves the record for the healer
   * that runs when the run stops. One ladder, one history
   * (`recoveries[phase].rungs`), whichever of the two climbs.
   * ---------------------------------------------------------------- */

  /**
   * The drive loop's ladder pass. Which phases: records the last boarding
   * settled badly (`interrupted`, `failed`), phases whose handoff exists but
   * is not complete (`stuck`, `in-progress` on the board) that this run has
   * not boarded, and — the one deliberate exception to the done-skip below —
   * phases the board reads DONE whose recorded QA verdict is still holding
   * their dependents. Not: anything in flight, anything already hinted, a
   * phase the board reads done for any other reason (reconcile closed it) or
   * waiting (its deps are not done), and not the same unchanged record twice
   * in a row.
   */
  protected async climbLadder(board: Board, asked: Set<number> | null): Promise<void> {
    const state = this.state!;
    const wordOf = (p: number) => board.states[p] ?? 'unknown';
    // The phases whose recorded QA verdict is holding their dependents.
    //
    // A QA situation is DEFINED by the board reading `done` — `qa-failed` is
    // "the phase finished and then the verdict came back fail" — so the `done`
    // skip below made `qa-failed` and `qa-pending` unreachable from the drive
    // loop, and the rungs the ladder holds for them dead code on this path.
    // The only way either was ever climbed was the long way round: no
    // candidate left, so the loop halts the run `plan-deadlocked`, and the
    // service's convergence pass picks the stopped run up on a later tick and
    // heals it out of band. Measured on phase-console-commerce: a round-1
    // `fail` on phase 8 stopped the run under "nothing left to run on its
    // own", the operator read that as a summons and intervened by hand — for a
    // phase the loop had the board for and could have re-boarded in the same
    // pass. Every QA rung anchors on a phase the board reads done: that is
    // what admitting one as a candidate MEANS (`autoResolveRun` says so in as
    // many words), so the skip has to know about them.
    const qaHeld = new Set(Object.entries(board.qa ?? {})
      .filter(([, verdict]) => verdict !== 'pass' && verdict !== 'waived')
      .map(([p]) => Number(p))
      .filter((p) => Number.isFinite(p)));
    const phases = new Set<number>();
    for (const record of Object.values(state.phases)) {
      if (ladderClassifies(record)) phases.add(record.phase);
    }
    for (const p of [...board.stuck, ...board.inProgress]) {
      const record = state.phases[String(p)];
      if (!record || record.status === 'pending') phases.add(p);
    }
    // …and every QA holder, unconditionally. Its record reads `done`, which is
    // neither `ladderClassifies` nor `pending`, so neither loop above finds it.
    for (const p of qaHeld) phases.add(p);
    // How long "unchanged since I last climbed it" is trusted (#114), and the
    // phases left standing — skipped as seen, or climbed to no boarding — whose
    // entry the re-check poke must come back for.
    const ttl = Math.max(0, this.deps.ladderSeenTtlMs?.() ?? LADDER_SEEN_TTL_MS);
    const nowMs = this.now().getTime();
    const standing: number[] = [];
    const stillStanding = (p: number): boolean => {
      const r = state.phases[String(p)];
      return Boolean(r) && !r!.boardingHint && !this.lanes.has(p)
        && (r!.status === 'pending' || ladderClassifies(r!));
    };
    for (const phase of [...phases].sort((a, b) => a - b)) {
      if (asked && !asked.has(phase)) continue;
      const heldByQa = qaHeld.has(phase);
      if (wordOf(phase) === 'waiting') continue;
      // The second deliberate exception to the done-skip (control-tower phase
      // 62, #68): a phase this run RE-OPENED on a red final verdict. The board
      // reads the handoff the verdict was about; `verify-red:reopened` is
      // defined by the board reading done, exactly as the QA situations are.
      const reopened = Boolean(state.phases[String(phase)]?.reopened);
      if (wordOf(phase) === 'done' && !heldByQa && !reopened) continue;
      if (this.lanes.has(phase)) continue;
      const record = phaseRecord(state, phase);
      if (record.boardingHint) continue;
      // A verification a restart cut is owed before anything is climbed: the
      // loop re-runs it first (`phase.reverify-after-restart`, #69).
      if (owesVerification(record)) continue;
      // A QA holder whose own session is still in flight is not stalled: the
      // lane is finishing, or `maybeQaVerdict` is chasing the verdict warm
      // inside it. Climbing over that would put a second session on the phase
      // lock the first one holds.
      if (heldByQa && PHASE_IN_FLIGHT.includes(record.status)) continue;
      if (!heldByQa) {
        if (record.status === 'pending' && !['stuck', 'in-progress'].includes(wordOf(phase))) continue;
        if (record.status !== 'pending' && !ladderClassifies(record)) continue;
      }
      // The verdict rides the fingerprint: for a QA holder every other field
      // is stable across a round, so a fail that came back fail again would
      // otherwise read as "the same unchanged record" and never climb twice.
      //
      // The handoff rides it too (#114): its status and its Outstanding are
      // what a session left for the next one, and a docs change to them is new
      // evidence even when the board's word stays `in-progress`.
      const fingerprint = [
        record.status, wordOf(phase), record.attempts, record.endedAt ?? '', record.note ?? '', board.qa?.[phase] ?? '',
        handoffStamp(this.deps.handoffFor?.(state.slug, phase)),
      ].join('|');
      // Unchanged, and seen recently enough to trust (#114): the entry expires
      // after `ttl`, and a lane that ended on the phase's scope since it was
      // written invalidates it — the two inputs the record cannot show.
      const seen = this.ladderSeen.get(phase);
      if (seen && seen.fingerprint === fingerprint && nowMs - seen.at < ttl
        && !(await this.laneFreedOnScope(phase, seen.at))) {
        standing.push(phase);
        continue;
      }
      this.ladderSeen.set(phase, { fingerprint, at: nowMs });
      try {
        await this.climb(record, board, 'drive');
      } catch (error) {
        log.warn('runner.ladder', { slug: state.slug, phase, error });
      }
      if (stillStanding(phase)) standing.push(phase);
    }
    // The lane frees that can no longer invalidate anything seen are dropped.
    const oldest = Math.min(...[...this.ladderSeen.values()].map((entry) => entry.at));
    this.laneFrees = Number.isFinite(oldest) ? this.laneFrees.filter((free) => free.at >= oldest) : [];
    // Come back for what was left standing when its entry expires, whatever
    // else does or does not wake the loop meanwhile (#114).
    const due = standing
      .map((p) => this.ladderSeen.get(p)?.at)
      .filter((at): at is number => typeof at === 'number')
      .map((at) => at + ttl);
    if (due.length) this.armLadderRecheck(Math.min(...due));
  }

  /**
   * Classify one phase and climb its ladder one rung, through this runner's
   * own vehicles. True when the record was reset to `pending` with a boarding
   * hint (it is a candidate now); false when the ladder parked it with an
   * errand, deferred it (a rung remains that only the service can drive), or
   * had nothing to climb.
   *
   * `preset.situation` skips the evidence gathering — a declared `partial`
   * outcome IS the evidence; `preset.declared` feeds a declaration into it.
   */
  protected async climb(
    record: PhaseRecord, board: Board, by: string,
    preset: { situation?: Situation; declared?: PhaseEvidence['declared']; sessionId?: string } = {},
  ): Promise<boolean> {
    const state = this.state!;
    const phase = record.phase;
    const now = new Date().toISOString();
    const evidence = preset.situation ? null : await this.evidenceOf(phase, board, preset.declared ?? null);
    const situation = preset.situation ?? classifySituation(evidence!);
    record.situation = { key: situation.key, at: now, why: situation.why };
    this.record('phase.situation', {
      situation: situation.key, sub: situation.sub ?? null, label: situation.label, why: situation.why, by,
    }, phase);

    if (situation.actor === 'wait' || situation.actor === 'none') return false;
    // A declared block naming refs the watch clock can poll is a WAIT the
    // session planned (control-tower phase 87, #122, #126), not a remedy the
    // ladder spends. Its table's first rung, `poll-park`, used to be the
    // healer's alone, and the healer acts only on a STOPPED run: on a live one
    // the rung deferred, `closedBlocked` settled the phase `failed`, charged the
    // streak and halted it `phase-blocked` — and the landing that could have
    // resumed it was thrown away. The loop drives it itself, ahead of the
    // healing opt-in, the caps and the same-rung-once rule, none of which a
    // wait spends: the phase parks `waiting` (`parkWaiting` — phase 45's budget,
    // phase 50's window) and its landing or its window resumes its own session.
    if (situation.key === 'blocked-declared:external' && await this.pollParkDeclared(record)) return false;
    // The ladder is the run's healing opt-in (the launch dialog's "heal halts"
    // switch, on by default), with ONE exemption: a never-started phase
    // boarding fresh is not healing, it is the run doing its job — and it is
    // the measured dead end this pass exists for.
    if (!state.autoRecover && situation.id !== 'never-started') {
      this.record('phase.ladder-skipped', { situation: situation.key, reason: 'auto-recovery is off for this run' }, phase);
      return false;
    }

    const slot = ((state.recoveries ??= {})[String(phase)] ??= { attempts: 0, lastAt: now });
    const history = slot.rungs ?? [];
    // The ONE run-wide counter (#14): counted rungs on phases the board does
    // not read done — the healer's gate reads the same helper.
    const run = openRunRungs(state.recoveries, (p) => board.states?.[p] === 'done');
    // The console's caps, with the run's own rung caps over them.
    const caps = { ...(this.deps.ladderCaps?.() ?? {}), ...runCapOverrides(state) };
    const unblockOk = this.deps.unblockAttempts?.() !== false;
    // A session the CLI has already refused to resume is no session: the
    // own-session rungs read as unavailable and the ladder climbs past them.
    const known = preset.sessionId ?? record.sessionId ?? record.resumeSessionId;
    const sessionId = known && !isSessionGone(record, known) ? known : undefined;
    // Which of THIS runner's vehicles a rung maps to: a boarding hint, or — for
    // a usage wall, whose rungs used to be the healer's alone (#98) — a switch
    // of the run's account, or a park on the wall's reset. Pure: it is also
    // the availability predicate `nextRung` asks of every rung.
    const actOf = (rung: Rung): RunnerAct | null => {
      const hint = this.hintFor(phase, rung, situation, evidence, sessionId, now, by);
      if (hint) return { kind: 'board', hint };
      return situation.key === 'resource-wall:usage' ? this.usageWallAct(phase, rung, situation, sessionId, now, by) : null;
    };
    // Two questions: is there ANY rung left (caps, history, the table), and is
    // there one THIS runner can drive. Only the first being "no" is exhaustion.
    const dayHistory = this.deps.dayHistory?.();
    // QA's own budget travels with the caps. The default is resolved HERE
    // rather than stored on the run, so a run file written before the budget
    // existed and one written by an operator who cleared the field mean the
    // same thing, and changing the shipped number changes both.
    // Re-read the rounds from `test-status.md` before counting them. `record.qa`
    // has exactly one writer — `maybeQaVerdict`, which returns early the moment
    // a verdict exists — so every round AFTER the first was invisible to it: a
    // `qa-fix` rung resumes the session, the session records a new verdict, and
    // nothing put that round on the record. The budget therefore could not bind
    // in the fail → fix → fail loop it was written for (QA round 2). The FILE is
    // the shared truth here, and it also counts rounds recorded by hand or from
    // another clone. A read that fails leaves the record as it stands.
    if (situation.id === 'qa-failed' || situation.id === 'qa-pending') {
      // The one fold (`mergeQaHistory`): merge, never replace — see its note.
      mergeQaHistory(record, await this.qaHistory(phase));
    }
    // FAILED rounds, not all of them. The setting is "QA may FAIL N rounds on a
    // phase", and `qa[]` holds every round there was — passes, waivers, and the
    // synthetic entry pushed when a reviewer recorded nothing at all. Counting
    // those spent the budget on reviews that went fine, and because `qa[]`
    // deliberately survives `resetForRetry`, a phase could park on its FIRST
    // real fail under a message claiming three had failed (QA F3).
    const qaRounds = (record.qa ?? []).filter((entry) => entry.verdict === 'fail').length;
    const qaMaxRounds = state.qaMaxRounds ?? DEFAULT_QA_MAX_ROUNDS;
    const climb = { situation: situation.key, history, run, dayHistory, caps, qaRounds, qaMaxRounds };
    const any = nextRung(climb);
    const mine = nextRung({ ...climb, available: (rung) => actOf(rung) !== null });
    // …and the THIRD question (LFC-2, phase 10): is there a rung ANY driver
    // can climb — this loop's own vehicles, or the healer's on a stopped run.
    // The same `nextRung(available)` the healer asks, over the union of the
    // two availability predicates; its exhaustion is the loop's exhaustion.
    const drivable = (rung: Rung) => actOf(rung) !== null
      || this.deps.rungDrivable?.(state.slug, rung, situation, record, evidence, state) === true;
    const theirs = nextRung({ ...climb, available: drivable });

    if (mine.ok) {
      const act = actOf(mine.rung)!;
      // A park on the wall's reset boards nothing now (#98): the phase waits on
      // the window, and the park poke brings it back — sooner if a re-read of
      // the account finds room.
      if (act.kind === 'park') return this.parkOnWindow(record, situation, slot, mine.rung, act, by, now);
      const hint = act.hint;
      // Recorded BEFORE the spend, so a console that dies mid-boarding still
      // remembers it climbed — `attempts`/`lastAt` move with it for the
      // readers that predate rungs.
      accountRung(slot, {
        situation: situation.key, rung: mine.rung.vehicle, params: mine.rung.params, at: now, note: mine.rung.label,
      });
      // The whole run moves first, its queue with it, so the boarding below is
      // already on the account that can pay (#98, phase 78's one mover).
      if (act.kind === 'switch') this.switchForRung(record, situation, act);
      this.reboardWith(record, hint);
      this.record('phase.rung', {
        situation: situation.key, rung: mine.rung.vehicle, params: mine.rung.params ?? null,
        brief: hint.brief, vehicle: 'runner', attempt: slot.attempts, by,
        ...(hint.sessionId ? { sessionId: hint.sessionId } : {}),
        ...(act.kind === 'switch' ? { from: act.from, to: act.to } : {}),
        ...(act.why ? { why: act.why } : {}),
      }, phase);
      this.emit('phase', { phase, status: record.status, situation: situation.key, rung: mine.rung.vehicle, brief: hint.brief });
      this.persist();
      return true;
    }

    // A rung this loop drives without a boarding: the `widen-rule` card
    // (phase 9, TRS-10). Offered here rather than deferred to the healer,
    // because a deferred rung made `closedBlocked` settle the phase `failed`
    // and charge the streak — a permission wall read as two failures.
    if (any.ok && any.rung.vehicle === 'widen-rule' && this.offerWidenRule(record, situation, slot, any.rung, by, now)) {
      return true;
    }

    // The THIRD reader of the same-rung-once rule, and it read no filter at
    // all — so its "every rung tried" could disagree with the `nextRung` it
    // had just called. One helper now (`shared/ladder-model.js`).
    const untried = untriedRungs(situation.key, history);
    const switchedOff = (rung: Rung) => rung.vehicle === 'unblock-session' && !unblockOk;
    // Exhaustion is computed WITH the availability predicate — the same
    // `nextRung(available)` the healer uses — so an empty available table
    // escalates exactly as a spent one does (LFC-2): one `phase.errand`
    // naming the vehicle and why it is unavailable, never a bare
    // `phase.ladder-deferred` for a table nothing will ever climb.
    const exhausted = !theirs.ok || situation.actor === 'person' || (untried.length > 0 && untried.every(switchedOff));
    if (exhausted) {
      const reason = !any.ok ? any.reason
        : situation.actor === 'person' ? `${situation.label} is a person's to settle`
          : !theirs.ok ? theirs.reason
            : 'the unblock session is switched off on this console';
      // A cap refusal is a journal line, not only a sentence (RCV-6) — written
      // once here; `climbLadder`'s fingerprint keeps the pass from repeating it.
      const cap = capRefusal(any);
      if (cap) this.record('phase.ladder-refused', { situation: situation.key, ...cap, by }, phase);
      // The rungs were there and no driver could climb them: the errand names
      // each and why (RCV-7), or the card reads as if no rung existed.
      const hint = any.ok && !theirs.ok && /^no rung for /.test(theirs.reason)
        ? this.deps.rungUnavailable?.(state.slug, situation, record, evidence, state) ?? null
        : null;
      // A spent CAP is not the situation's errand (#14 ask 5): it names the
      // cap, the arithmetic and the setting, never "the ladder's sessions".
      const built = cap
        ? capErrand(any, {
          phase, tried: slot.rungs ?? [], at: now, onDonePhases: run.onDonePhases,
          replenishes: !cap.cap.endsWith('usd') && countedRungs(slot.rungs ?? []).some(retryForgives),
        })
        : null;
      this.parkWithErrand(record, situation, slot, reason, by, hint, built);
      return false;
    }
    // Deferred: a rung remains for a vehicle this loop does not have but the
    // service does (a fresh briefed agent, a repair script, a park). The record
    // stands as it is; the service's healer climbs it when the run stops —
    // which, on a run that keeps driving other phases, may be never. So the
    // deferral is a CARD now (control-tower phase 79, #98): the record says it
    // is undriven and why, at once, and the inbox raises it with the verb that
    // boards it now. Journalled once per deferral, not once per look (#114's
    // expiry looks again every convergence cadence).
    const remaining = untried.map((rung) => rung.vehicle);
    const next = theirs.ok ? theirs.rung.vehicle : null;
    const was = record.undriven?.deferred;
    const same = Boolean(was && was.situation === situation.key && was.next === next
      && was.remaining.join(',') === remaining.join(','));
    record.undriven = {
      since: record.undriven?.since ?? now,
      board: board.states[phase] ?? 'unknown',
      situation: situation.key,
      why: deferredWhy(next),
      deferred: { at: same ? was!.at : now, situation: situation.key, next, remaining, reason: mine.reason },
    };
    if (!same) {
      this.record('phase.ladder-deferred', { situation: situation.key, reason: mine.reason, remaining, next }, phase);
      this.emit('phase', { phase, status: record.status, undriven: record.undriven });
    }
    this.persist();
    return false;
  }

  /**
   * `poll-park`, driven by this loop (control-tower phase 87) — see `climb`.
   * The declaration is the RECORD's (`routeOutcome` wrote it; a record the old
   * build settled `failed` still carries it), so a fresh block, a recheck and
   * the drive loop's pass over a legacy `failed` record park alike. False when
   * it is no block or names nothing the clock will poll — a retired ref is never
   * polled again — and the ladder reads on as before.
   */
  private async pollParkDeclared(record: PhaseRecord): Promise<boolean> {
    const state = this.state!;
    const phase = record.phase;
    const declared = record.declared;
    // A block whose ref already LANDED was waited out: blocked again with no
    // new word, it is not waiting on that ref any more, and parking it there
    // would only resume it into the same block.
    if (declared?.status !== 'blocked' || declared.landed) return false;
    const watch = declared.watch ?? [];
    const retired = new Set(record.watchRetired ?? []);
    if (!pollableRefs(watch).some((target) => !retired.has(target.ref))) return false;
    const budget = await this.waitBudgetOf(phase);
    // What it asked: its own instant, else the clock it armed while still ahead.
    const asked = declared.requested
      ?? (record.parkedUntil && Date.parse(record.parkedUntil) > Date.now() ? record.parkedUntil : undefined);
    const outcome: PhaseOutcome = {
      version: 1, slug: state.slug, phase, status: 'blocked', watch,
      ...(declared.reason ? { reason: declared.reason } : {}),
      ...(declared.needs ? { needs: declared.needs } : {}),
      ...(declared.rule ? { rule: declared.rule } : {}),
      ...(declared.command ? { command: declared.command } : {}),
      ...(asked ? { resume_after: asked } : {}),
      written_at: declared.at,
    };
    // A record the old build settled `failed` (#126) carries that ending; a
    // wait's card reads neither a halt nor an undriven deferral.
    retirePhaseHalt(record);
    delete record.undriven;
    this.ladderSeen.delete(phase);
    const parked = this.parkWaiting(phase, outcome, { budget, blocked: true });
    if (parked) this.persist();
    return parked;
  }

  /**
   * The runner's own vehicles for `resource-wall:usage` (control-tower phase
   * 79, #98), judged from the LIVE meters of the account the run is on:
   *
   *  - `switch-account` — phase 78's `switchRungDecision`: room on the run's own
   *    account is a resume in place (#106 — never re-move an account the rung
   *    just judged live); a walled one moves the run to the first candidate
   *    with MORE room, horizon-aware (`switchCandidates`); nothing better is
   *    unavailable, and the ladder reaches the wait;
   *  - `switch-model` — unavailable: the model chain is the attempt loop's to
   *    climb, inline at the wall; a pending phase has no attempt to fail over;
   *  - `wait-window` — a wall with a reset parks the phase on it, the shape
   *    `escalateLiveWall` parks a live wall in (`usageWall`, "until at the
   *    latest"); a window that has already reopened is a resume now; a wall
   *    with no reset is nothing a clock can wait out.
   *
   * Pure — it is the availability predicate as well as the act's plan. No
   * quota door (a harness) is no answer at all: every rung stays the healer's.
   */
  private usageWallAct(
    phase: number, rung: Rung, situation: Situation, sessionId: string | undefined, at: string, by: string,
  ): RunnerAct | null {
    const state = this.state!;
    const headroom = this.deps.accountHeadroom;
    if (!headroom) return null;
    const record = phaseRecord(state, phase);
    const from = state.accountId ?? 'default';
    const model = record.model ?? state.model;
    let verdict: ReturnType<NonNullable<RunnerDeps['accountHeadroom']>>;
    try { verdict = headroom(from === 'default' ? undefined : from, model); } catch { return null; }
    const resume = (why: string): Extract<RunnerAct, { kind: 'board' }> => ({
      kind: 'board',
      hint: { situation: situation.key, rung: rung.vehicle, at, by, ...(sessionId ? { brief: 'continue', sessionId } : { brief: 'resume' }) },
      why,
    });
    const room = (id: string) => {
      try { return this.deps.accountRoom?.(id === 'default' ? undefined : id, model) ?? null; } catch { return null; }
    };
    switch (rung.vehicle) {
      case 'switch-account': {
        const pool = accountPool(state);
        let candidates: { id: string; headroomPct: number | null }[] = [];
        if (!verdict.ok && this.deps.switchCandidates) {
          try {
            const plan = this.deps.switchCandidates(from === 'default' ? undefined : from, model, {
              until: this.wallResetMs(null, from === 'default' ? undefined : from, model), pool,
            });
            candidates = plan.ranked
              .filter((id) => id !== from && (!pool || pool.includes(id)))
              .map((id) => ({ id, headroomPct: room(id)?.headroomPct ?? null }));
          } catch { candidates = []; }
        }
        const decision = switchRungDecision({
          from, wall: 'usage',
          // Walled means no room, whatever the last meter read.
          current: { ok: verdict.ok, headroomPct: verdict.ok ? room(from)?.headroomPct ?? null : 0 },
          candidates,
          choice: state.accountChoice ?? null,
        });
        if (decision.act === 'stay') return resume(decision.why);
        if (decision.act === 'switch') {
          const board = resume(`${decision.accountId} has room and ${from} is walled`);
          return { kind: 'switch', from, to: decision.accountId, reverts: decision.reverts, hint: board.hint, why: board.why };
        }
        return null;
      }
      case 'wait-window': {
        if (verdict.ok) return resume(`${from}'s window has reopened — nothing is left to wait for`);
        const resets = verdict.resetsAt && Date.parse(verdict.resetsAt) > this.now().getTime() ? verdict.resetsAt : null;
        if (!resets) return null;
        return {
          kind: 'park', until: resets,
          why: `${from} is walled (${verdict.reason.slice(0, 160)}) and no account with more room can take the run`,
        };
      }
      default:
        return null;
    }
  }

  /**
   * The `wait-window` rung, driven by this loop (#98): park the phase on the
   * wall's reset exactly as `escalateLiveWall` parks a live wall — `waiting`,
   * `parkedUntil`, the run's clock synced, `usageWall` so every fresh reading,
   * every spend and the back-off re-probe can lift it sooner, and the poke that
   * boards it at the reset into the session it was checkpointed from. The rung
   * stays open until that boarding settles it.
   */
  private parkOnWindow(
    record: PhaseRecord, situation: Situation, slot: NonNullable<RunState['recoveries']>[string],
    rung: Rung, act: Extract<RunnerAct, { kind: 'park' }>, by: string, now: string,
  ): boolean {
    const state = this.state!;
    const phase = record.phase;
    accountRung(slot, { situation: situation.key, rung: rung.vehicle, params: rung.params, at: now, note: `waits until ${act.until}` });
    record.status = 'waiting';
    record.parkedUntil = act.until;
    syncWaitClock(state);
    record.usageWall = {
      account: state.accountId ?? 'default',
      bucket: state.limits?.window ?? LEARNED_WALL_BUCKET,
      latest: act.until, probes: 0,
    };
    record.parkReason = `${situation.label} — ${act.why}. Waiting until ${act.until} at the latest, when the window resets — `
      + 'sooner if the account shows headroom again.';
    record.note = record.parkReason;
    record.parkedFrom = now;
    delete record.stall;
    delete record.undriven;
    this.ladderSeen.delete(phase);
    this.record('phase.rung', {
      situation: situation.key, rung: rung.vehicle, params: rung.params ?? null,
      vehicle: 'runner', attempt: slot.attempts, by, until: act.until, why: act.why,
    }, phase);
    this.emit('phase', { phase, status: 'waiting', note: record.parkReason, parkedUntil: act.until, situation: situation.key, rung: rung.vehicle });
    this.armParkPoke(phase, act.until);
    this.armWallProbe(phase);
    this.persist();
    return false;
  }

  /**
   * The `switch-account` rung's move (#98): the run goes to the account the
   * decision picked through phase 78's one mover (`moveAccount` — the record,
   * the pool and the queue together), the phase's transcript is carried when it
   * can be so its own session resumes there, and a move back over a person's
   * choice is named (`noteReversal`). The account being left is already marked
   * — the quota door read it walled — so nothing is marked again here.
   */
  private switchForRung(record: PhaseRecord, situation: Situation, act: Extract<RunnerAct, { kind: 'switch' }>): void {
    const state = this.state!;
    const reason = `${situation.label}: the ladder's switch-account rung — ${act.why ?? `${act.to} has room`}`;
    const sessionId = record.resumeSessionId ?? record.sessionId;
    let port: ReturnType<NonNullable<RunnerDeps['portTranscript']>> | null = null;
    if (sessionId) {
      try { port = this.deps.portTranscript?.(sessionId, record.sessionAccountId, act.to) ?? null; } catch { port = null; }
      if (port?.findable) {
        if (act.to === 'default') delete record.sessionAccountId;
        else record.sessionAccountId = act.to;
      }
    }
    const rekeyed = this.moveAccount(act.to);
    this.record('phase.account-switch', {
      from: act.from, to: act.to, reason, by: 'ladder',
      ported: port?.ported ?? false, findable: port?.findable ?? false, why: port?.why ?? null,
      cliVersion: port?.cliVersion ?? null, rekeyed,
    }, record.phase);
    this.noteReversal(act.from, act.to, 'ladder', reason, record.phase);
    this.persistNow();
    this.emit('run', { state });
  }

  /** Park a phase with the ONE ask for a person the ladder leaves behind. */
  /**
   * The `widen-rule` rung, driven by this loop (phase 9, TRS-10): the deny
   * rule the console's own hook refused goes on a standing approval card, the
   * phase parks behind it — spending nothing — and the run drives its other
   * candidates. A person's Allow strikes the rule for this plan
   * (`deps.widenRule`) and re-boards the phase into its OWN session with the
   * command to re-run; Deny, or the card's clock, settles the rung `failed`
   * and leaves the errand. False when nothing can be offered: no broker, no
   * denial on the record, or a denial by the wait guard (not a permission
   * wall) — the caller then takes the exhausted path.
   */
  private offerWidenRule(
    record: PhaseRecord, situation: Situation,
    slot: NonNullable<RunState['recoveries']>[string], rung: Rung, by: string, now: string,
  ): boolean {
    const state = this.state;
    const approvals = this.deps.approvals;
    const denied = record.toolDenied;
    if (!state || !approvals || !this.deps.widenRule || !denied?.rule || denied.rule === 'in-turn-wait') return false;
    const { approval, decided } = approvals.offer(widenCard({ runId: state.id, slug: state.slug, phase: record.phase, denied }));
    // The widen rung raises the permission ITEM (control-tower phase 135): the
    // card is its Grant's mechanism — today's permanent plan strike, labelled
    // so — and Your turn shows one item, never a card of its own.
    const wall = [...(record.walls ?? [])].reverse().find((kept) => kept.rule === denied.rule) ?? wallOfHookDenial(denied, denied.at);
    let itemId: string | null = null;
    try {
      itemId = this.deps.raisePermission?.({
        slug: state.slug, runId: state.id, phase: record.phase,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        wall, need: record.declared?.reason ?? null,
        grant: { effect: 'strike', approvalId: approval.id, label: strikeLabel(denied.rule) },
      }) ?? null;
    } catch (error) { log.warn('runner.widen-rule.failed', { runId: state.id, phase: record.phase, error }); }
    const climbed = accountRung(slot, {
      situation: situation.key, rung: rung.vehicle, params: rung.params, at: now, note: rung.label,
    });
    climbed.cardId = approval.id;
    record.status = 'parked';
    record.note = `${situation.label} — a person is asked to widen \`${denied.rule}\` (approval card ${approval.id}); nothing spends until they answer`;
    record.endedAt ??= now;
    this.record('phase.rung', {
      situation: situation.key, rung: rung.vehicle, params: rung.params ?? null,
      vehicle: 'card', cardId: approval.id, attempt: slot.attempts, by,
      ...(itemId ? { item: itemId } : {}),
    }, record.phase);
    this.emit('phase', { phase: record.phase, status: 'parked', note: record.note, situation: situation.key, rung: rung.vehicle });
    this.persist();
    const phase = record.phase;
    const rule = denied.rule;
    const command = denied.command;
    void decided.then((outcome) => {
      try { this.widenDecided(phase, approval.id, { rule, command }, outcome); }
      catch (error) { log.warn('runner.widen-rule.failed', { runId: state.id, phase, error }); }
    });
    return true;
  }

  /**
   * A plan-mode session handed its plan over (control-tower phase 11, #34) —
   * called from the hook (`Service.holdPlan`) before it answers. Keeps the
   * text beside the run's outcome files, journals `phase.plan-presented
   * {bytes, sha}` and stamps the record `pending`. Null when this runner does
   * not hold the run or the text could not be kept — the hook then lets the
   * call through rather than hold a plan nobody could read.
   */
  presentPlan(phase: number, plan: PresentedPlan, sessionId?: string): PlanPresented | null {
    const state = this.state;
    if (!state) return null;
    const kept = boundedPlan(plan.text);
    const sha = planDigest(plan.text);
    const bytes = Buffer.byteLength(plan.text, 'utf8');
    const path = planTextFile(state.root, state.slug, state.id, phase, sha);
    try {
      mkdirSync(join(path, '..'), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, kept.text.endsWith('\n') ? kept.text : `${kept.text}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, path);
    } catch (error) {
      log.warn('runner.plan-keep-failed', { runId: state.id, phase, error: String(error) });
      return null;
    }
    const record = phaseRecord(state, phase);
    const at = new Date(this.now().getTime()).toISOString();
    record.planApproval = {
      sha, bytes, path, at, state: 'pending',
      ...(sessionId ? { sessionId } : {}),
      ...(kept.truncated ? { truncated: true } : {}),
    };
    this.record('phase.plan-presented', {
      bytes, sha, path,
      ...(plan.planFilePath ? { planFilePath: plan.planFilePath } : {}),
      ...(kept.truncated ? { truncated: true } : {}),
    }, phase);
    this.persist();
    return { sha, bytes, path, truncated: kept.truncated };
  }

  /**
   * A presented plan answered by the plan's own `plan-approval: continue` —
   * approved by policy, no park, the journal keeping what was approved.
   */
  continuePlan(phase: number, presented: PlanPresented, source: string): void {
    const state = this.state;
    if (!state) return;
    const record = phaseRecord(state, phase);
    if (record.planApproval?.sha === presented.sha) {
      record.planApproval = { ...record.planApproval, state: 'continued', by: 'policy', decidedAt: new Date(this.now().getTime()).toISOString() };
    }
    this.record('phase.plan-approved', { by: 'policy', sha: presented.sha, source }, phase);
    this.persist();
  }

  /**
   * Hold a presented plan for a person. The console declares the session's
   * outcome on its behalf — `needs-human --needs plan-approval`, in the file
   * `phase-outcome.sh` writes — so the Stop hook lets the turn end and the
   * declared-outcome path parks the phase with the halt kind `plan-approval`
   * (`routeOutcome`), restart-safe like every declared park. A session still
   * running after `PLAN_HOLD_GRACE_MS` is interrupted through the signal
   * ladder, and its attempt ends into the same declaration.
   */
  holdPlan(phase: number, presented: PlanPresented, sessionId?: string): void {
    const state = this.state;
    if (!state) return;
    const path = this.outcomePath(phase);
    try {
      mkdirSync(join(path, '..'), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(planHoldOutcome({
        slug: state.slug, phase, sha: presented.sha, bytes: presented.bytes,
        ...(sessionId ? { sessionId } : {}), now: new Date(this.now().getTime()),
      }))}\n`, 'utf8');
      renameSync(tmp, path);
    } catch (error) {
      log.warn('runner.plan-hold-failed', { runId: state.id, phase, error: String(error) });
      return;
    }
    const pid = this.lanes.get(phase)?.pid ?? null;
    if (!pid) return;
    const timer = setTimeout(() => {
      const lane = this.lanes.get(phase);
      if (!lane || lane.pid !== pid || !pidAlive(pid)) return;
      this.record('phase.plan-hold-interrupted', { sha: presented.sha, pid, graceMs: PLAN_HOLD_GRACE_MS }, phase);
      void killLadder(pid, { killAfterMs: SIGTERM_GRACE_MS });
    }, PLAN_HOLD_GRACE_MS);
    timer.unref?.();
  }

  /**
   * Write a person's answer to a held plan onto the run this runner holds
   * (`Service.decidePlan`): the record, the journal line, one save.
   */
  recordPlanDecision(
    phase: number, decide: (state: RunState) => void, event: 'phase.plan-approved' | 'phase.plan-rejected',
    data: Record<string, unknown>,
  ): void {
    const state = this.state;
    if (!state) return;
    decide(state);
    this.record(event, data, phase);
    this.persistNow();
  }

  /** The card's answer: strike and re-board, or settle the rung and leave the errand. */
  private widenDecided(
    phase: number, cardId: string, denied: { rule: string; command?: string },
    answered: { decision: 'allow' | 'deny'; by: string; reason?: string; door?: string; fresh?: boolean },
  ): void {
    let outcome = answered;
    const state = this.state;
    if (!state || !state.phases[String(phase)]) return;
    const record = phaseRecord(state, phase);
    const slot = state.recoveries?.[String(phase)];
    const open = slot?.rungs?.find((r) => r.cardId === cardId && r.outcome === 'running');
    if (!slot || !open) return;
    this.record('phase.widen-decided', {
      decision: outcome.decision, by: outcome.by, rule: denied.rule, cardId,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    }, phase);
    // Granted on its permission ITEM (control-tower phase 149): the engine
    // applied the grant at the scope a person chose — no plan strike here —
    // and the item's road back resumes the session. The rung is superseded.
    if (outcome.decision === 'allow' && grantedByItem(outcome.reason)) {
      this.settleOpenRung(phase, 'superseded', 'granted on its permission item');
      this.persist();
      return;
    }
    // The card's own Allow is a grant too (phase 149) — refused for a never
    // rule, and on a console with an owner key unless the owner's fresh touch
    // came with the answer.
    const widened = outcome.decision === 'allow'
      ? this.deps.widenRule?.(state.slug, denied.rule, outcome.by, {
        runId: state.id, phase, card: cardId, door: outcome.door ?? null,
        ...(typeof outcome.fresh === 'boolean' ? { fresh: outcome.fresh } : {}),
      })
      : undefined;
    if (widened === false || typeof widened === 'string') {
      outcome = {
        decision: 'deny', by: outcome.by,
        reason: typeof widened === 'string' ? `no grant was made — ${widened}` : 'the rule is on the never list — no grant is offered through any door',
      };
    }
    if (outcome.decision === 'allow') {
      // The loop that offered the card has ended (the run parked or halted
      // meanwhile): the stopped-run door — the recover verb — resumes the
      // phase's own session, which is the door a person's Resume takes too.
      if (!this.driving) {
        this.persist();
        this.deps.resumeOwnSession?.(state.slug, phase, widenInstruction(denied), outcome.by);
        return;
      }
      // Back into its own session, with the command to re-run: the rung
      // settles when that attempt does, as every rung does.
      const sessionId = record.resumeSessionId ?? record.sessionId;
      this.reboardWith(record, {
        situation: 'blocked-declared:permission', rung: 'widen-rule',
        brief: sessionId ? 'continue' : 'resume',
        ...(sessionId ? { sessionId } : {}),
        instruction: widenInstruction(denied),
        at: new Date(this.now().getTime()).toISOString(), by: 'console',
      });
      this.persist();
      this.emit('phase', { phase, status: record.status, note: record.note });
      this.wake.resolve();
      return;
    }
    this.settleOpenRung(phase, 'failed', `the widen card was ${outcome.by === 'timeout' ? 'not answered' : `denied by ${outcome.by}`}`);
    // Answered on its permission ITEM (control-tower phase 135): Deny and I'll
    // do it myself resume the session on the item's own road back — an errand
    // here would ask a person a second time what they have just answered.
    if (answeredByItem(outcome.reason)) {
      this.persist();
      return;
    }
    const situation: Situation = {
      id: 'blocked-declared', sub: 'permission', key: 'blocked-declared:permission',
      label: 'Declared blocked · permission', blurb: '', actor: 'machine', why: [],
    };
    this.parkWithErrand(record, situation, slot, `the widen card was ${outcome.by === 'timeout' ? 'not answered' : 'denied'}`, 'drive');
  }

  private parkWithErrand(
    record: PhaseRecord, situation: Situation,
    slot: NonNullable<RunState['recoveries']>[string], reason: string, by: string,
    /** Why no rung could be driven, rung by rung, when that is the reason (RCV-7). */
    hint: string | null = null,
    /** An errand the caller already built — a spent cap's (`capErrand`), which no policy row answers. */
    built: Errand | null = null,
  ): void {
    // The session's own words go with the errand when they ARE the evidence —
    // a refusal or an "Unknown command" is unactionable without them (D26).
    const rounds = record.qa ?? [];
    const errand: Errand = built ?? errandFor(
      situation.key, slot.rungs ?? [], record.phase, undefined,
      // …the one rule for both paths (RCV-7, `errandSaid`): a refusal, a
      // skill that would not load, the organisation that said no.
      errandSaid(situation, record.said),
      null,
      // Which report describes the code as it stands — the newest round's. An
      // errand that says "fix what the QA report names" after three rounds has
      // named nothing a person can open.
      rounds.length
        ? {
          // The FAILED count and the budget actually in force — the same two
          // numbers `nextRung` refused on. Reading `state.qaMaxRounds` raw left
          // the headline as the generic ask on every run that never set the
          // field, which is most of them (QA F4).
          rounds: rounds.filter((entry) => entry.verdict === 'fail').length,
          max: this.state?.qaMaxRounds ?? DEFAULT_QA_MAX_ROUNDS,
          ...(rounds[rounds.length - 1].reportPath ? { report: rounds[rounds.length - 1].reportPath } : {}),
        }
        : null,
      // The console's own denial, so a permission errand names the rule and
      // the command rather than "a tool" (LFC-3).
      record.toolDenied && record.toolDenied.rule !== 'in-turn-wait' ? record.toolDenied : null,
      // The answer in force for this situation's manifest row (phase 11,
      // ZTD-10): the run's manifest (the plan's `## Decisions` as resolved at
      // the door), this console's `policy.<key>`, the shipped default.
      this.policyFor(situation.key),
      // …and, where the console recorded no rule, what the session declared:
      // the act and the path its errand then names (#43).
      record.declared ?? null,
    );
    // A class whose row answered AUTOMATICALLY is not a person's: the ruling
    // is journalled under its decision key, no card is raised, and the answer
    // is acted on where the console can act (a spent QA budget under
    // `qa.exhausted: waive` records the waiver through the operator's own
    // door). `blocked-declared:unknown` never takes this branch — its row is
    // pinned, because a block whose key the manifest lacks IS the ask.
    // …provided this loop can ACT on the word: a waiver needs the service's
    // door (`deps.qaWaive`); a harness without one, or a console that cannot
    // write, leaves the ask standing rather than journalling an answer nobody
    // carried out.
    const actable = !(errand.decisionKey === 'qa.exhausted' && !this.deps.qaWaive);
    if (errand.policy && actable) {
      this.answerByPolicy(record, situation, slot, errand, reason, by);
      return;
    }
    if (errand.policy) delete errand.policy;
    if (hint) errand.how = `${errand.how} ${hint}`;
    slot.errand = errand;
    record.status = 'parked';
    record.note = `${situation.label} — ${errand.need}`;
    record.endedAt ??= errand.at;
    // Not counted against the failure budget: a phase that needs a person is
    // not a phase that failed twice.
    this.record('phase.errand', { ...errand, label: situation.label, reason, by }, record.phase);
    this.emit('phase', { phase: record.phase, status: 'parked', note: record.note, errand });
    this.persist();
  }

  /**
   * The phase's `Person-check:` word and where it came from (phase 11,
   * ZTD-6): the plan's bullet, else the policy table's answer for
   * `verification.person-check` (this console's override, then the shipped
   * `operator`).
   */
  protected personCheckFor(phase: number): { answer: string | null; source: string } {
    const state = this.state;
    const fromPlan = state ? this.deps.personCheck?.(state.slug, phase) : undefined;
    if (fromPlan) return { answer: fromPlan, source: 'plan' };
    const resolved = policyForKey('verification.person-check', state, this.deps.policyPrefs?.() ?? null);
    return resolved ? { answer: resolved.answer, source: resolved.source } : { answer: null, source: 'default' };
  }

  /**
   * The policy answer for a situation's decision key — the run's manifest
   * first (what the door resolved from the plan and the twin), then this
   * console's preferences, then the shipped default. A run from before the
   * manifest existed resolves from the console and the defaults alone.
   */
  protected policyFor(situationKey: string): ResolvedPolicy | null {
    return policyForSituation(situationKey, this.state, this.deps.policyPrefs?.() ?? null);
  }

  /**
   * The ladder's answer when the class resolved to an automatic policy word
   * (phase 11, ZTD-10/QRL-3): one `phase.policy-answered` line naming the
   * decision key, the answer and its source — never `phase.errand`, never a
   * card — and the act the word asks for. Written once per answer per phase:
   * `slot.policyAnswered` is the fingerprint, so a re-classification on the
   * next tick does not repeat the line.
   */
  private answerByPolicy(
    record: PhaseRecord, situation: Situation,
    slot: NonNullable<RunState['recoveries']>[string], errand: Errand, reason: string, by: string,
  ): void {
    const state = this.state!;
    const answer = errand.policy!;
    const already = slot.policyAnswered;
    if (already && already.decisionKey === errand.decisionKey && already.answer === answer.answer) return;
    slot.policyAnswered = { decisionKey: errand.decisionKey!, answer: answer.answer, source: answer.source, at: errand.at };
    record.note = `${situation.label} — answered by policy: ${errand.decisionKey} = ${answer.answer} (${answer.source})`;
    this.record('phase.policy-answered', {
      ...policyAnsweredPayload({ ...errand, decisionKey: errand.decisionKey! }), label: situation.label, reason, by,
    }, record.phase);
    // The act. `qa.exhausted: waive` records the waiver through the operator's
    // own door, so the report, the round and the reason are written the one
    // way and the next board read releases the dependents. `waits: window`
    // (a peer holding the scope) needs nothing more: the scheduler already
    // queues behind the holder. Anything else the word names is acted on
    // where it lives (a resume in `converge.ts`, a ruling by the session).
    if (errand.decisionKey === 'qa.exhausted' && answer.answer === 'waive' && this.deps.qaWaive) {
      const rounds = (record.qa ?? []).filter((entry) => entry.verdict === 'fail').length;
      const declined = (detail: string) => {
        // The policy could not act, so the ask stands after all — the person's
        // errand, with the reason the console could not take it for them.
        const { policy: _policy, ...asked } = errand;
        slot.errand = asked;
        slot.policyAnswered = undefined;
        record.status = 'parked';
        record.note = `${situation.label} — ${asked.need}`;
        record.endedAt ??= asked.at;
        this.record('phase.errand', {
          ...asked, label: situation.label, by,
          reason: `qa.exhausted: waive could not record the verdict — ${detail}`,
        }, record.phase);
        this.emit('phase', { phase: record.phase, status: 'parked', note: record.note, errand: asked });
        this.persist();
      };
      void this.deps.qaWaive(state.slug, record.phase, {
        reason: `QA exhausted after ${rounds} failed round${rounds === 1 ? '' : 's'} — waived by policy `
          + `(qa.exhausted: waive, from the ${answer.source})`,
        by: 'policy',
      }).then((result) => {
        if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
          declined(String((result as { detail?: unknown }).detail ?? 'the waiver was refused'));
          return;
        }
        this.record('phase.qa-waived', {
          by: 'policy', decisionKey: errand.decisionKey, source: answer.source, rounds,
        }, record.phase);
      }, (error: unknown) => declined(String((error as Error)?.message ?? error)));
    }
    this.emit('phase', { phase: record.phase, status: record.status, note: record.note });
    this.persist();
  }

  /** Which of this runner's vehicles a rung maps to, as the hint boarding reads — or null. */
  private hintFor(
    phase: number, rung: Rung, situation: Situation, evidence: PhaseEvidence | null,
    sessionId: string | undefined, at: string, by: string,
  ): BoardingHint | null {
    const base = { situation: situation.key, rung: rung.vehicle, at, by };
    switch (rung.vehicle) {
      case 'reboard-fresh':
        return { ...base, brief: 'fresh' };
      case 'queue':
        // Back to the queue behind the lock; a handoff on disk means the
        // session that boards should read it as a resume.
        return { ...base, brief: evidence?.handoff.exists ? 'resume' : 'fresh' };
      case 'reboard-resume-brief':
        return { ...base, brief: 'resume', ...(rung.params?.escalate === 'model' ? { escalate: 'model' as const } : {}) };
      case 'resume-own-session': {
        if (!sessionId) return null;
        // The QA modes resume a phase that has FINISHED. Without their brief
        // the session got "you were interrupted, carry on", read its own
        // complete handoff, and exited in one turn — the rung was spent and
        // nothing was reviewed. Same builder as the healer's vehicle.
        const mode = rung.params?.mode;
        const state = this.state!;
        const instruction = mode === 'fix-verification'
          ? fixVerificationInstruction(phase)
          : mode === 'qa-fix' || mode === 'qa-verdict'
            ? qaRungInstruction(mode, state.slug, phase, join(state.root, 'docs', 'handoffs', state.slug))
            : undefined;
        return { ...base, brief: 'continue', sessionId, ...(instruction ? { instruction } : {}) };
      }
      case 'unblock-session':
        if (this.deps.unblockAttempts?.() === false) return null;
        return { ...base, brief: 'unblock', ...(sessionId ? { sessionId } : {}) };
      case 'closeout-own-session':
        if (!sessionId) return null;
        return { ...base, brief: 'closeout', sessionId };
      default:
        // Agent rungs, the repair script, the resource walls: not this loop's.
        return null;
    }
  }

  /**
   * Reset a record for the boarding the ladder chose, and leave the hint on it.
   *
   * …and wake the drive loop (control-tower phase 86, #128): a hint set while
   * the loop sleeps on a live lane used to wait for that lane to END before any
   * fill pass read it — on a one-lane-at-a-time run, hours — even with a free
   * lane on a disjoint scope. The loop top re-reads the board and boards it by
   * seniority; a wake landing inside a tick costs one extra board read.
   */
  protected reboardWith(record: PhaseRecord, hint: BoardingHint): void {
    resetForRetry(record, { by: 'console', journal: this.declarationSink() });
    record.boardingHint = hint;
    // The queue rung is a lock wait: the two-hour cap measures from here.
    if (hint.rung === 'queue') record.lockWaitSince ??= hint.at;
    this.ladderSeen.delete(record.phase);
    if (this.driving) this.wake.resolve();
  }

  /**
   * The rung this boarding was climbing, superseded by the console's OWN change
   * of brief before its first turn (control-tower phase 86, #14's comment of
   * 2026-09-22T23:49:55Z): the resume policy turned a `continue` into a fresh
   * boarding. It never ran, so it settles `withdrawn` — `countedRungs` skips it
   * and no errand lists it as tried — and the boarding that DOES run is
   * accounted as what it is, `reboard-resume-brief`, so the ladder's cap still
   * bounds it. A person's press stays in the person slot either way.
   */
  protected supersedeOpenRung(phase: number, why: string): void {
    const slot = this.state?.recoveries?.[String(phase)];
    const open = slot?.rungs?.filter((r) => r.outcome === 'running' || r.outcome == null).at(-1);
    if (!slot || !open || open.rung === 'reboard-resume-brief') return;
    if (!this.settleOpenRung(phase, 'withdrawn', `superseded before its first turn — ${why}`)) return;
    // It takes the superseded rung's PLACE in time, so the attempt-end settle
    // (which settles only rungs climbed before the lane began) settles it by
    // what this boarding did.
    const next = accountRung(slot, {
      situation: open.situation, rung: 'reboard-resume-brief', at: open.at, note: `in place of ${open.rung}, which never ran`,
    });
    if (open.by === PERSON_SLOT_BY) next.by = PERSON_SLOT_BY;
    this.record('phase.rung', {
      situation: open.situation, rung: next.rung, params: null, brief: 'resume', vehicle: 'runner',
      attempt: slot.attempts, by: open.by === PERSON_SLOT_BY ? PERSON_SLOT_BY : 'console', supersedes: open.rung,
    }, phase);
  }

  /**
   * The facts the situation classifier weighs.
   *
   * The console's own builder (`deps.evidenceDeps` → `Service.evidenceDeps`)
   * supplies everything that is a fact about the PLAN — the store's handoff,
   * the lock under the one lock clock, the live gate, whether human gates are
   * delegated, the registry's word on the holder's session, QA, plan health.
   * This method overlays only what is a fact about THIS RUN: its own root, the
   * outcome the loop was handed, its clock, its scope directories, its git.
   *
   * That split is the point (P6/D4). Two builders answering the same question
   * drifted, and each drift was a real defect: no `gateDelegated` here meant a
   * delegated gate parked with an errand for a gate nobody needed to clear.
   *
   * `handoff` is COMPOSED rather than replaced: the shared builder reads the
   * store, and where the store has nothing (or lags the engine) the board's own
   * word still says whether a handoff exists and what it reads. That is a fact
   * the runner has and the service does not — extending an answer is not the
   * same as keeping a second copy of it.
   */
  private async evidenceOf(
    phase: number, board: Board, declared: PhaseEvidence['declared'],
  ): Promise<PhaseEvidence> {
    const state = this.state!;
    const shared = this.deps.evidenceDeps?.(state.slug);
    const fromBoard = (p: number): { status?: string } | null => {
      const word = board.states[p];
      if (word === 'stuck') return { status: 'blocked' };
      if (word === 'in-progress') return { status: 'in-progress' };
      return null;
    };
    const deps: EvidenceDeps = {
      ...shared,
      root: state.root,
      handoff: (slug, p) => {
        const stored = shared?.handoff?.(slug, p) ?? (() => {
          const own = this.deps.handoffFor?.(slug, p);
          return own && own.exists !== false ? { status: own.status, outstanding: own.outstanding } : null;
        })();
        return stored ?? fromBoard(p);
      },
      repos: (_slug, p) => this.scopeDirs(p),
      git: (args) => this.gitOrNull(args),
      declared: () => declared,
      // The RESOLVED policy, which only this side can finish: the shared
      // builder knows the plan's word, and the run's own setting is a fact
      // about this run. Same precedence `mcpPolicyFor` uses at boarding —
      // plan first, then the run, then the default — so the classifier and the
      // spawn cannot disagree about whether a server was required.
      mcpPolicy: (slug, p) => this.deps.planMcpPolicy?.(slug, p) ?? state.mcpPolicy ?? 'continue',
      // The run's CURRENT account, live (#106): a fact about this run, which a
      // switch moves. The shared builder's reading when the service supplies
      // one — the healer's exact fact (D4); a harness with none asks its own
      // quota door, and with no door there is no evidence at all.
      account: (run, p) => {
        if (shared?.account) return shared.account(run, p);
        const door = this.deps.accountHeadroom;
        if (!door) return null;
        const id = state.accountId ?? 'default';
        const verdict = door(id === 'default' ? undefined : id, phaseRecord(state, phase).model ?? state.model);
        return { id, ok: verdict.ok, ...(!verdict.ok && verdict.resetsAt ? { resetsAt: verdict.resetsAt } : {}) };
      },
      // The board's own word on QA when the shared builder has none: a
      // `blocked:` reason of `qa:<verdict>` exists only under a gating regime,
      // so a holder the board names IS `mode: on` with that verdict. Without
      // this the drive loop admitted the holder (`climbLadder`), classified
      // it `superseded` for want of a QA fact, and spent a rung on nothing.
      qa: async (slug, p) => {
        const known = await Promise.resolve(shared?.qa?.(slug, p)).catch(() => null);
        if (known) return known;
        const verdict = board.qa?.[p];
        return verdict ? { mode: 'on', result: verdict } : null;
      },
      now: () => this.now(),
    };
    return collectEvidence(deps, state.slug, phase, state, board.states);
  }

  /**
   * The directories under the root the phase's Repos column names and that
   * exist — where the working tree is asked about THIS phase's work. `all`,
   * or names that are not here, fall back to the root itself.
   *
   * FULL paths (`phaseRepoDirs`, control-tower phase 45, #60): the name view
   * `phaseRepos` truncates every token to its first segment, so
   * `shop/shop-api, shop/shop-web` was asked at `shop` — a
   * superproject whose own tree ignores the commits of the two repositories
   * the phase worked in.
   */
  protected async scopeDirs(phase: number): Promise<string[]> {
    const state = this.state!;
    let names: string[] = [];
    try {
      names = [...((await (this.deps.phaseRepoDirs ?? this.deps.phaseRepos)?.(state.slug, phase)) ?? [])];
    } catch { names = []; }
    if (!names.length || names.includes('all')) return ['.'];
    const dirs = names.filter((name) =>
      name && name !== '.' && !name.includes('..') && !name.startsWith('/') && existsSync(join(state.root, name)));
    return dirs.length ? dirs : ['.'];
  }

  /** The first uncommitted paths across the scope directories, for a brief. */
  private async dirtyPaths(dirs: string[], limit = 12): Promise<string[]> {
    const paths: string[] = [];
    for (const dir of dirs) {
      const prefix = dir === '.' ? [] : ['-C', dir];
      const out = await this.gitOrNull([...prefix, 'status', '--porcelain', '--ignore-submodules=all']);
      if (!out) continue;
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const path = line.slice(3).trim();
        paths.push(dir === '.' ? path : `${dir}/${path}`);
        if (paths.length >= limit) return paths;
      }
    }
    return paths;
  }

  /** Everything a re-board brief may quote about this phase. */
  private async briefFacts(phase: number, board: Board): Promise<BriefFacts> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const evidence = await this.evidenceOf(phase, board, null);
    const paths = evidence.work.did ? await this.dirtyPaths(await this.scopeDirs(phase)) : [];
    return {
      phase,
      slug: state.slug,
      // A brief goes to a session this runner spawns, which carries
      // `PE_SCRIPTS` — so it names the variable, never a clone's path (#151).
      scriptsDir: SCRIPTS_REF,
      attempts: record.attempts,
      verification: record.verification,
      lint: record.lint,
      said: record.said,
      halt: state.halt?.phase === phase ? state.halt.reason : null,
      handoff: evidence.handoff,
      work: { ...evidence.work, ...(paths.length ? { paths } : {}) },
    };
  }

  /**
   * Assemble the prompt a hinted boarding sends. `fresh` is the engine's text
   * alone; `resume`/`unblock` append their brief to it; `continue`/`closeout`
   * resume the phase's own session and carry no engine text — unless that
   * session cannot be resumed here, in which case they DEGRADE to the
   * self-contained `resume` rather than sending a continuation to a session
   * that has no context to continue from.
   */
  protected async composeBrief(
    phase: number, board: Board, hint: BoardingHint, engineText: string,
  ): Promise<{ prompt: string; brief: BoardingBrief; resume?: string; vetted?: VettedResume; maxTurns?: number; degraded?: string }> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const facts = await this.briefFacts(phase, board);
    const wantsSession = hint.brief === 'continue' || hint.brief === 'closeout' || (hint.brief === 'unblock' && Boolean(hint.sessionId));
    // The ONE ask of the resume gate for this boarding (control-tower phase 86,
    // #134): its verdict rides to the attempt as `vetted`, which spawns on it
    // rather than asking again — two asks a second apart once disagreed, and
    // the second re-boarded a phase that already held its lane.
    const gate = wantsSession ? this.resumableSession(record, hint.sessionId) : null;
    const vetted = gate?.ok ? gate.resume : undefined;
    // A session still RUNNING is not degraded to a fresh boot — that would put a
    // second session in its working tree. The brief keeps asking for it, and the
    // boarding's own gate (`attemptSession`) holds the phase until it ends.
    const resume = gate?.ok ? gate.resume.sessionId : gate?.why === 'session-live' ? hint.sessionId : undefined;
    // The session is there and not worth resuming (`resumePolicy`, autopilot-token-drain
    // phase 4): the fresh boarding's brief opens with why it starts over.
    const notWorth = gate && !gate.ok && gate.why === 'fresh' && gate.policy && hint.sessionId
      ? { policy: gate.policy, words: resumePolicyInstruction(gate.policy, hint.sessionId) }
      : null;
    let brief = hint.brief;
    let degraded: string | undefined;
    if ((hint.brief === 'continue' || hint.brief === 'closeout') && !resume) {
      degraded = notWorth
        ? `session ${hint.sessionId} is not worth resuming — ${resumePolicyWhy(notWorth.policy)} — boarding fresh with the resume brief`
        : hint.sessionId
          ? `session ${hint.sessionId} cannot be resumed under this account — boarding fresh with the resume brief`
          : 'no session to resume — boarding fresh with the resume brief';
      brief = 'resume';
      this.record('phase.brief-degraded', { asked: hint.brief, reason: degraded }, phase);
      // The rung that asked for the session never gets a turn (#14): the
      // console itself superseded it, so it is withdrawn, not scored.
      this.supersedeOpenRung(phase, degraded);
    }
    switch (brief) {
      case 'fresh':
        return { prompt: engineText, brief };
      case 'resume': {
        // `instruction` used to ride the own-session briefs only, so a `resume`
        // that carried one silently dropped it and boarded the phase with the
        // generic "you were interrupted, carry on" text. That is the exact
        // shape a review follow-up needs — a self-contained boot prompt plus
        // the evidence block plus WORDS — and dropping the words would
        // re-board the phase to do nothing in particular.
        const instruction = hint.instruction ?? resumeInstruction(facts);
        return {
          prompt: `${engineText}\n\n${resumeBrief(facts, notWorth ? `${notWorth.words}\n\n${instruction}` : instruction)}`,
          brief, ...(degraded ? { degraded } : {}),
        };
      }
      case 'unblock':
        return resume
          ? { prompt: unblockBrief(facts), brief, resume, ...(vetted ? { vetted } : {}) }
          : { prompt: `${engineText}\n\n${unblockBrief(facts)}`, brief };
      case 'continue':
        return { prompt: resumeBrief(facts, hint.instruction ?? resumeInstruction(facts)), brief, resume, ...(vetted ? { vetted } : {}) };
      case 'closeout':
        return {
          prompt: closeoutPrompt(state.slug, phase, board.states[phase] ?? 'unknown',
            state.gitMode === 'new-branch' ? `pe/${state.slug}` : undefined),
          brief, resume, ...(vetted ? { vetted } : {}), maxTurns: CLOSEOUT_MAX_TURNS,
        };
    }
  }

  /**
   * Read-only git against the run's WORK tree; null when git could not answer
   * (the evidence reader's contract).
   *
   * `workRoot` before `root`, because every caller is an evidence reader and
   * the evidence is where the sessions work: for an isolated run the commits
   * and the dirt are in its own checkout (a mirror's mounts resolve by the
   * same relative paths), and asking the shared root answered for a tree the
   * run never touches — a false "changed nothing" about work that plainly
   * exists (G10).
   */
  protected async gitOrNull(args: string[]): Promise<string | null> {
    const state = this.state!;
    const run = await shell('git', args, {
      channel: 'git', intent: 'run-work', cwd: state.workRoot ?? state.root, timeout: 15_000,
      capture: { keep: 4 * 1024 * 1024, mode: 'head' },
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb', GIT_OPTIONAL_LOCKS: '0' },
      expectFailure: true,
    });
    return run.ok ? run.stdout : null;
  }

  /* ---------------------------------------------------------------- *
   * Plumbing
   * ---------------------------------------------------------------- */

  protected now(): Date { return this.deps.now?.() ?? new Date(); }

  /* ---------------------------------------------------------------- *
   * Liveness: is the lane that is nominally working actually working?
   * ---------------------------------------------------------------- */

  /**
   * Start the ticker if it is not already running.
   *
   * Armed by lane creation and retired by the first tick that finds no lanes,
   * rather than by the drive loop's own lifecycle — because a recovery session
   * gets a lane without one, and because a runner that halts mid-phase leaves
   * its `finally` blocks to unwind at their own pace. Self-limiting: at most
   * one idle tick is ever paid for.
   *
   * `unref` so it is never what keeps the process alive. A console shutting
   * down must not wait a minute for a heartbeat.
   */
  protected armLivenessTicker(): void {
    this.armProgressTicker();
    if (this.livenessTimer) return;
    this.livenessTimer = setInterval(() => { void this.tickLiveness(); }, LIVENESS_TICK_MS);
    this.livenessTimer.unref?.();
  }

  protected disarmLivenessTicker(): void {
    if (!this.livenessTimer) return;
    clearInterval(this.livenessTimer);
    this.livenessTimer = null;
    this.disarmProgressTicker();
  }

  /**
   * The three-second half of the same heartbeat.
   *
   * Separate from the liveness ticker rather than a faster version of it: that
   * tick journals, samples processes, evaluates stalls and drives remedies, and
   * running all of it twenty times more often would be twenty times the journal
   * for the same run. This one reads what is already in memory, digests it, and
   * emits only for a lane whose digest moved — so a run with three live lanes
   * all thinking costs three string comparisons every three seconds and sends
   * nothing.
   *
   * Armed and retired with the liveness ticker, so a runner with no lanes has
   * neither.
   */
  protected armProgressTicker(): void {
    if (this.progressTimer) return;
    this.progressTimer = setInterval(() => this.tickProgress(), RUN_PROGRESS_TICK_MS);
    this.progressTimer.unref?.();
  }

  protected disarmProgressTicker(): void {
    if (!this.progressTimer) return;
    clearInterval(this.progressTimer);
    this.progressTimer = null;
  }

  /** Emit a `run:progress` frame for every live lane whose digest has moved. */
  tickProgress(): void {
    try {
      for (const frame of this.progressFrames()) this.emit('progress', { ...frame });
    } catch (error) {
      // A heartbeat must never be able to stop a run.
      log.warn('run.progress-tick-failed', { error: String(error) });
    }
  }

  /* ---------------------------------------------------------------- *
   * The branch probe: where is this run's work, and what does it
   * collide with?
   * ---------------------------------------------------------------- */

  /**
   * The last probe, or null for a run that has never had a checkout.
   *
   * `null` is the honest answer for a shared run and the service passes it
   * straight through: the Git card is a statement about an isolated run's
   * branch, and inventing an empty one for a run that shares the operator's
   * checkout would be a card saying "0 ahead, 0 behind" about the tree the
   * operator is sitting in.
   */
  gitSnapshot(): RunGitView | null {
    return this.gitView;
  }

  /**
   * Arm the probe if this run has a checkout of its own.
   *
   * Gated on `workRoot` — the DIRECTORY — and not on `state.checkout`, which
   * is P6's rule and the reason a resumed run does not report on a tree that
   * was swept up behind it: `checkout` records what the run GOT and stays
   * `worktree` after a clean settle removed the tree, while `workRoot` is
   * deleted with it. The pair is the fact; the word alone is history.
   *
   * `unref` for the liveness ticker's reason: a probe must never be what keeps
   * a shutting-down console alive.
   */
  /**
   * The tree the git card and the radar measure — `workRoot`, else the LANES'
   * own integration tree (RAD-1).
   *
   * 🔴 `workRoot` is set only for a RUN-level isolated checkout. A plan with
   * `Worktrees: on` and no run isolation has one tree per phase and a real
   * `integration/` they all merge into — several branches diverging at once,
   * which is the exact shape the radar exists for — and the probe was off for
   * every one of them, because the field it gated on was empty. The pair rule
   * still holds (`Lane.worktree`/`branch`): the integration tree is only named
   * when a lane has actually been taken, so a run with neither reports nothing,
   * exactly as before.
   */
  protected gitWorkRoot(): string | undefined {
    const state = this.state;
    if (!state) return undefined;
    if (state.workRoot) return state.workRoot;
    // The DIRECTORY, not a flag — the rule `pruneWorktrees` already follows.
    // `<home>/<runId>/integration` is this run's alone (the id is in the path),
    // so its existence is proof the console made it for these lanes and cannot
    // go stale the way an in-memory phase set does.
    const integration = this.laneNamesFor(0).integration;
    return existsSync(integration) ? integration : undefined;
  }

  protected syncGitProbe(): void {
    if (!this.gitWorkRoot()) {
      // Not "leave the timer running and let the probe no-op": isolation goes
      // one way mid-run (`RunSettingsPatch.isolation`) and the release deletes
      // `workRoot`, so this is a real transition and the CACHE has to go with
      // the timer. A run that dropped isolation showing its old branch card is
      // the same class of lie as the `workRoot` that outlived its directory.
      this.disarmGitProbe();
      this.gitView = null;
      this.radarSeen.clear();
      return;
    }
    if (this.gitTimer) return;
    this.gitTimer = setInterval(() => { void this.refreshGit(); }, GIT_PROBE_MS);
    this.gitTimer.unref?.();
    // 🔴 The first probe is DELAYED, not immediate, and the delay is the
    // point. `syncGitProbe` is called from the drive preamble — the instant
    // before the loop admits its first lanes — and a probe there is half a
    // dozen subprocesses (`worktree list`, a `du` per checkout, a `merge-tree`
    // per pair) competing with the spawns for the same cores. It also has
    // nothing to say: the run branch was just created from HEAD, so it is 0
    // ahead of 0 behind. Waiting a couple of seconds costs an operator
    // nothing, keeps the card from arriving an hour late on a long first
    // phase, and keeps the probe out of the admission burst entirely.
    this.gitFirst = setTimeout(() => { this.gitFirst = null; void this.refreshGit(); }, GIT_FIRST_PROBE_MS);
    this.gitFirst.unref?.();
  }

  protected disarmGitProbe(): void {
    if (this.gitFirst) { clearTimeout(this.gitFirst); this.gitFirst = null; }
    if (!this.gitTimer) return;
    clearInterval(this.gitTimer);
    this.gitTimer = null;
  }

  /**
   * Probe once: cache the answer, journal only what changed, emit once.
   *
   * Three properties, each of which something already got wrong once:
   *
   *  - **It never throws.** Called from a settle, from a `finally`, and from a
   *    timer — three places where a rejection is an unhandled one. A repository
   *    that has moved under us is not news about the run.
   *  - **It journals TRANSITIONS.** A pair whose verdict has not moved since it
   *    was last written produces nothing at all, so the journal keeps saying
   *    what a five-minute tick would otherwise drown.
   *  - **It emits at most one event.** `run:git` carries the whole view, so the
   *    page is a cache write rather than a refetch — and a probe that found
   *    nothing new emits nothing, because a stream that fires every five
   *    minutes trains an operator to ignore it.
   */
  async refreshGit(): Promise<boolean> {
    const state = this.state;
    // `gitWorkRoot()`, not `workRoot` — a lanes-only run has no run-level
    // checkout and every branch the radar exists to compare (RAD-1).
    const workRoot = this.gitWorkRoot();
    if (!state || !workRoot) { this.gitView = null; return false; }
    // Every home a console-made tree may stand in, so a tree under the other
    // worktree root still reads as ours.
    const stateRoot = this.worktreeHomes().all;
    let view: RunGitView;
    try {
      // The RUN branch, from the same pure function every other caller names
      // a branch with — not `branchFor`, which answers per PHASE and would
      // report a lane's branch as the run's the moment one is in flight. The
      // card is about the run; the lanes appear in the radar on their own.
      const branch = this.laneNamesFor(0).runBranch;
      // A mirror is N repositories; measuring the superproject would answer
      // for a tree the run never touches and a branch that is not in it.
      // `live`: this probe runs while the run drives, and a tree a session is
      // writing into is never handed to `du` (#171) — the card's size waits
      // for the retention inventory, which measures a kept tree once it rests.
      view = state.mountedRepos?.length
        ? await probeMirrorGit({
          root: state.root, branch, workRoot,
          mounts: state.mountedRepos, stateRoot, live: true,
        })
        : await probeRunGit({
          root: state.root, branch, workRoot, stateRoot, live: true,
        });
    } catch (error) {
      log.warn('runner.git-probe', { slug: state.slug, error: (error as Error)?.message ?? String(error) });
      return false;
    }
    // The run may have ended, or restarted as a different run, while the probe's
    // subprocesses were in flight. Writing then would attach one run's checkout
    // facts to another's page — the same identity guard `pruneWorktrees` needed.
    if (this.state !== state) return false;

    let news = false;
    const seen = new Set<string>();
    for (const pair of view.radar) {
      const key = pairKey(pair.a, pair.b);
      seen.add(key);
      if (this.radarSeen.get(key) === pair.state) continue;
      this.radarSeen.set(key, pair.state);
      news = true;
      this.record('run.git-radar', { pair: key, state: pair.state, files: pair.files });
    }
    // A pair that has GONE — a branch whose checkout was removed — is dropped
    // rather than remembered, so if it comes back its verdict is news again.
    // Remembering it forever would silence exactly the re-announcement an
    // operator wants after they thought they had dealt with it.
    for (const key of [...this.radarSeen.keys()]) {
      if (!seen.has(key)) this.radarSeen.delete(key);
    }

    const moved = news || !sameGitFacts(this.gitView, view);
    this.gitView = view;
    // `emit` prefixes `run:` itself and adds the run id and slug — so the name
    // here is `git`, not `run:git`. Passing the wire name would emit
    // `run:run:git`, which no client listens for and nothing would report: the
    // page simply stops updating, which is the exact failure `EVENT_EFFECTS`
    // totality exists to catch and cannot, because the name never reaches it.
    if (moved) this.emit('git', { git: view });
    return moved;
  }

  /**
   * Stop every clock this runner owns. Called by `Service.close()`.
   *
   * The pool retains a Runner per plan for the process's life, so without this
   * a console that had driven twelve plans closed with twelve liveness tickers
   * and every lane's lease keepalive still armed — `unref`'d, so invisible, and
   * firing into a Service nobody was listening to. It does NOT stop the run:
   * killing lanes is `stopRun`'s job and shutdown has its own checkpoint path.
   * Idempotent, because close paths get called twice.
   */
  close(): void {
    this.disarmLivenessTicker();
    for (const lane of this.lanes.values()) this.clearLeaseTimer(lane);
    for (const phase of [...this.parkPokes.keys()]) this.clearParkPoke(phase);
    for (const phase of [...this.wallProbes.keys()]) this.clearWallProbe(phase);
    this.clearLadderRecheck();
  }

  /**
   * Evaluate every live lane once.
   *
   * Public because the ticker is the only thing that calls it in production
   * and a test must be able to call it instead: the whole point of
   * `liveness.ts` being pure is that the interesting behaviour — an episode
   * opening, an episode clearing, an episode not re-announcing itself — is
   * driven by a fake clock plus explicit ticks rather than by waiting a
   * minute per assertion.
   *
   * Never throws: a `git` that will not run, a journal that will not write and
   * a listener that throws are all worth less than the run.
   */
  async tickLiveness(): Promise<void> {
    if (!this.lanes.size) { this.disarmLivenessTicker(); return; }
    const state = this.state;
    if (!state) return;
    const thresholds = stallThresholds(this.deps.stallThresholds?.());
    const now = this.now().getTime();
    let changed = false;
    for (const lane of [...this.lanes.values()]) {
      try {
        changed = await this.evaluateLane(lane, thresholds, now) || changed;
      } catch (error) {
        log.warn('runner.liveness', { phase: lane.phase, error: (error as Error)?.message ?? String(error) });
      }
    }
    if (changed) this.persist();
  }

  /**
   * One lane: refresh what is cheap, refresh what is not on its own cadence,
   * decide, and journal only the transitions.
   *
   * Returns whether the checkpoint is worth rewriting — the liveness snapshot
   * itself moves every tick and is not, on its own, a reason to fsync a run
   * file once a minute per lane.
   */
  protected async evaluateLane(lane: Lane, thresholds: StallThresholds, now: number): Promise<boolean> {
    const state = this.state!;
    const record = phaseRecord(state, lane.phase);

    // The suppression that keeps this feature from crying wolf on every plan
    // with a real test suite: while the phase's own §Verification is running
    // the session has exited and nothing will be produced until the commands
    // finish, which is exactly what `silent` looks like.
    lane.signals.verifying = record.status === 'verifying' || Boolean(record.verifyingSince) || Boolean(record.baselineSince);
    // The same suppression, for the same reason, on the operator's own act: a
    // SIGSTOPped session produces nothing, so every silence detector fires on
    // it within a minute or two. Pressing Freeze raised a stall card, a
    // `needs-you` row and a lane ranked as if something had broken. Nothing
    // had — the silence IS the feature.
    lane.signals.frozen = Boolean(lane.frozen);

    if (lane.gitAt === undefined || now - lane.gitAt >= LIVENESS_GIT_EVERY_MS) {
      lane.gitAt = now;
      const work = await workEvidence(
        // THIS attempt's window, not the phase's. `startedAt` is stamped once at
        // the first boarding, so a phase that committed on attempt one reported
        // those commits for ever — making "has this lane done anything" a
        // permanent yes from attempt two onwards, the same cumulative defect
        // `record.costUsd` had. `settleIdleAttempt` already measures from
        // `attemptStartedAt`; the liveness half was the one that did not.
        (args) => this.gitOrNull(args),
        record.attemptStartedAt ?? record.startedAt ?? null,
        await this.scopeDirs(lane.phase),
      ).catch(() => null);
      if (work) {
        lane.signals.commitsSinceStart = work.commits ?? 0;
        lane.signals.treeDirty = (work.dirty ?? 0) > 0;
      }
    }

    const before = lane.signals.stall;
    // Only a RUNNING record is judged (control-tower phase 47, #80). The lane
    // outlives its phase — it is kept through the landing after `phase.done` —
    // and a `done` phase's §Verification time used to read as session silence:
    // a "silent" stall 20 s after the phase finished, escalated URGENT 45
    // minutes later. Anything but `running` clears the episode instead.
    const after = record.status !== 'running' ? null : evaluateStall(lane.signals, thresholds, now, {
      // The shared external-clock vocabulary (scripts/verify.env), the same
      // list lint F16 warns from at plan time. Read through the cached loader,
      // so this costs a map lookup per lane per tick.
      verifyEnv: this.verifyEnv(),
    });
    lane.signals.stall = after;
    record.liveness = livenessOf(lane.phase, lane.signals, thresholds);

    // The evidence half of the loop detector, when this console has it (the
    // free tree is handed no `suspect` dep and simply never writes the record;
    // the `looping` signal above is free and fires either way). It NOTICES and
    // does nothing — no rung, no park, no signal — so the whole of its effect
    // is this record and the one journal line, said once per (phase, attempt,
    // call). The key is compared against the record rather than kept in memory,
    // so a console restarted mid-loop does not announce the same three calls
    // again; a fresh boarding changes the attempt and so is news again, which
    // is right — the ladder changed something and it did not help.
    // What this lane's process is COSTING, from the sample the liveness probe
    // has already taken — `processResources` never shells anything of its own,
    // so this is a map lookup. Journalled on CHANGE or at most once a minute,
    // whichever comes first: a lane's memory is the evidence for "the session
    // that died had 6 GB resident", and a line per tick per lane would be four
    // an hour per lane of pure noise in the one file that has to stay readable
    // months later. Rounded to whole megabytes and whole percent for the same
    // reason — the third decimal of a CPU reading changes every tick and is a
    // change nobody wants told.
    if (lane.pid) {
      const cost = processResources(lane.pid);
      if (cost) {
        const rssMb = Math.round(cost.rssKb / 1024);
        const cpuPct = Math.round(cost.cpuPct);
        const held = lane.resources;
        const moved = !held || held.rssMb !== rssMb || held.cpuPct !== cpuPct;
        const aged = !held || now - held.at >= LIVENESS_RESOURCES_EVERY_MS;
        if (moved || aged) {
          lane.resources = { rssMb, cpuPct, at: now };
          this.record('phase.resources', { rssMb, cpuPct, pid: lane.pid }, lane.phase);
        }
      }
    }

    let suspected = false;
    const noted = this.deps.suspect?.(record.suspect, lane.signals, thresholds) ?? null;
    if (noted) {
      record.suspect = noted.suspect;
      if (noted.fresh) {
        this.record('phase.suspect', { ...noted.suspect, attempt: record.attempts ?? 0 }, lane.phase);
        suspected = true;
      }
    }

    // Only TRANSITIONS are news. A lane that was fine and is still fine is the
    // overwhelmingly common tick and must cost nothing but the snapshot above;
    // a signal that is simply still true is one episode, one journal line and
    // one announcement — the dedupe on the announcing side is keyed the same
    // way, so a console restart mid-episode is the only thing that can say it
    // twice, and saying it once more after a restart is right.
    if (!after && !before) return suspected;
    if (after && sameStallEpisode(before, after)) {
      // Not news — and for every signal but one, not anything. The silent
      // watchdog's SECOND clock runs on exactly these ticks: the episode is
      // still open, the lane has still said nothing, and "still true" is
      // precisely the evidence the recycle needs. Reaching it only on the
      // transition would mean the nudge could fire and the recycle never could.
      if (after.signal === 'silent') this.silentRemedy(lane, after, now);
      // Same second clock, same reason: the retry ladder's recycle needs the
      // evidence that the storm is STILL happening, which only a repeat tick
      // carries. Reaching it on the transition alone would mean the first rung
      // could fire and the second never could.
      if (after.signal === 'retrying') this.retryStormRemedy(lane, after, now);
      // And the same second clock again, for the reason the other two have it
      // and for one more: a LOCAL wait's remedy is two-staged (nudge now, park
      // much later), so the later stage can only ever be reached on a repeat
      // tick. Reaching it on the transition alone would mean the nudge fired
      // and the park never could — the shape `silentRemedy`'s own comment
      // warns about, one signal over.
      if (after.signal === 'external-wait') this.externalWaitRemedy(lane, after, thresholds, now);
      return suspected;
    }

    if (after) {
      record.stall = after;
      this.record('phase.stall', { ...after, attempt: record.attempts ?? 0 }, lane.phase);
      // A silent lane whose last output reads as a person's turn (control-tower
      // phase 44): said once per episode, on its own line, so a reader can find
      // every suspected step without parsing stalls. Nothing acts on it here —
      // a person converts it from the inbox, or it goes when the lane speaks.
      if (after.suspectedStep) {
        this.record('phase.human-step-suspected', {
          ...after.suspectedStep, since: after.since, attempt: record.attempts ?? 0,
        }, lane.phase);
      }
    } else {
      delete record.stall;
      // The episode is over, so the once-per-episode nudge-refusal latch is too
      // — it said "per episode" and was per LANE, which meant a lane whose wait
      // cleared and returned got no second line however long the gap.
      delete lane.localNudgeRefused;
      delete lane.automaticParkDeclined;
      this.record('phase.liveness', {
        cleared: before?.signal ?? null,
        turnsSinceLastTool: lane.signals.turnsSinceLastTool,
        commitsSinceStart: lane.signals.commitsSinceStart,
        treeDirty: lane.signals.treeDirty,
      }, lane.phase);
    }
    this.emit('liveness', {
      phase: lane.phase,
      liveness: record.liveness,
      stall: after ?? null,
      attempt: record.attempts ?? 0,
    });
    // The one signal with an action rather than a card. Announced FIRST (the
    // journal line and the `liveness` emit above), so the record says what was
    // seen even if the park is refused — a phase that hit its wait budget must
    // still leave the evidence that produced the halt.
    if (after?.signal === 'external-wait') this.externalWaitRemedy(lane, after, thresholds, now);
    // The other signal with an action rather than a card, on the same
    // journal-then-act order and for the same reason. Its FIRST tick is a
    // transition, so it arrives here; every tick after it arrives at the
    // dedupe above.
    if (after?.signal === 'silent') this.silentRemedy(lane, after, now);
    // The third signal with an action rather than a card, on the same
    // journal-then-act order as the two above.
    if (after?.signal === 'retrying') this.retryStormRemedy(lane, after, now);
    return true;
  }

  /**
   * A lane that booted and then said nothing: nudge it, then recycle it, then
   * stop and ask for a person.
   *
   * The measured failure (register D20/D21). Detection worked — the 10-minute
   * `silent` signal fired in 7 of 8 boarding gaps over fifteen minutes — and
   * nothing consumed it: the signal's branch was card-only, `converge` skips a
   * run that is `IN_FLIGHT`, the ladder skips a phase that still has a lane
   * (`if (this.lanes.has(phase)) continue`), and the only thing that ever
   * recovered one was an operator typing a steer by hand. So this is that
   * operator, on a clock.
   *
   * ## The envelope is the whole safety argument
   *
   * A recycle kills a process. The one class where that provably loses nothing
   * is a session that has not yet done anything: no tool call has ever opened,
   * no turn has ended, nothing has been spent on THIS attempt, no task list was
   * published by it, and the tree is clean with no commits. Anything outside
   * that is a session with work in it and stays a person's card — Phase 21
   * escalates it, this does not touch it. See `preFirstTurn`.
   *
   * ## The bound is PER RUNG, and it lives on the record
   *
   * The ladder's one hard promise is never the same rung twice for one
   * situation on one phase, and that is exactly the promise here: **at most one
   * nudge and at most one recycle for this phase, ever** (until a person
   * presses Retry). Two properties fall out of counting rungs rather than
   * episodes, and QA found both by breaking an earlier version that counted
   * episodes:
   *
   *   - **a recycle cannot buy itself another recycle.** A recycle re-boards
   *     the phase, which is a NEW attempt; a ledger keyed on the attempt would
   *     hand every recycle a clean slate and recycle for ever. `stallRemedy`
   *     survives the checkpoint, so the re-boarded attempt finds the spent
   *     rungs and parks;
   *   - **a rung that was never climbed is not skipped.** The version that
   *     counted episodes parked a phase whose nudge had been ANSWERED and which
   *     then wedged again — the recycle, the rung that might have fixed it, was
   *     never reached, and the errand still told the operator it had been. Any
   *     bookkeeping that can close an episode without spending a rung has that
   *     bug; counting rungs cannot.
   *
   * Never `resumeWithInstruction`/`recover()`: their guards assume a halted
   * phase, and this one is live. `checkpointLane(…, { carryOn: true })` is the
   * `switchAccount` primitive — CONT-first kill ladder, `resumeSessionId` kept,
   * record back to `pending`, and the ordinary drive loop re-boards it through
   * admission with the lock and the lease undisturbed.
   */
  private silentRemedy(lane: Lane, stall: StallState, now: number): void {
    const state = this.state;
    if (!state) return;
    // The same standing-down guards as `externalWaitPark`, plus the fleet.
    // A frozen, pausing or fleet-held lane is silent BY CONSTRUCTION — acting
    // on that silence is the watchdog mistaking the console's own act for the
    // failure it exists to catch, which is the whole reason this mechanism has
    // a row in the fleet-freeze inventory.
    if (lane.checkpointed || lane.stopped || lane.frozen) return;
    if (this.stopRequested || this.abort?.signal.aborted || state.halt) return;
    if (state.status === 'pausing' || state.status === 'halting' || state.status === 'stopping') return;
    if (state.status === 'frozen' || state.freeze) return;
    const fleet = this.fleetFrozen();
    if (fleet) {
      log.info('runner.silent-watchdog-frozen', {
        slug: state.slug, phase: lane.phase, by: fleet.by ?? null,
      });
      return;
    }

    const phase = lane.phase;
    const record = phaseRecord(state, phase);
    const attempt = record.attempts ?? 0;
    if (!this.preFirstTurn(lane, record)) return;

    // Read through `?? 0`, never straight off the record. A checkpoint written
    // by an older build carries a DIFFERENT ledger shape (it counted episodes),
    // and `undefined + 1` is `NaN` — a counter that is never greater than zero,
    // so every rung stays "unclimbed" and the ladder never ends. Measured: four
    // ticks, four nudges, no recycle, no park. A missing counter reads as "this
    // phase has climbed nothing", which is the safe answer and bounded either
    // way, because both rungs are then climbed exactly once from here.
    const nudges = record.stallRemedy?.nudges ?? 0;
    const recycles = record.stallRemedy?.recycles ?? 0;

    // Rung 3 — both rungs are spent and it is silent again. The honest answer
    // is that this console cannot fix it: the ladder's exhaustion shape,
    // without inventing a rung. One errand, and the run keeps driving its
    // other lanes.
    if (recycles) { this.stallPark(lane, record, stall); return; }

    // Rung 1 — the nudge. One line into the stdin that is already open, which
    // is the only thing that has ever recovered one of these by hand. It does
    // NOT touch the silence clock: `applyEvent` is fed by the child's stream
    // alone, and the `injected` frame emitted here goes outward to the client.
    // If the CLI echoes the message back, that echo IS a stream event and the
    // stall clears — correctly, because a session echoing is a session reading.
    // If it then wedges again, rung 2 is still waiting for it.
    if (!nudges) {
      const at = new Date(now).toISOString();
      // No idempotency key. That parameter exists for a double-clicked POST
      // from a browser; here the ledger IS the idempotency, and a key would
      // let `inject` answer `repeated: true` from its cache — a write that
      // never reached the child, reported as one that did.
      const sent = this.steer(SILENT_NUDGE, 'watchdog', undefined, phase);
      // One journal line per outcome, and NEITHER of them before the write.
      // The `externalWaitPark` order is journal-then-act so the evidence
      // survives a refusal — but a line that says the console nudged the
      // session when it did not is not evidence, it is the record lying, and
      // this phase's whole defect class is a sentence that is not true. So the
      // refusal gets a line of its own instead.
      if (!sent.ok) {
        this.record('phase.auto-nudge-refused', {
          detail: stall.detail, since: stall.since, attempt, reason: sent.reason ?? null,
        }, phase);
        // No rung counted AND no ledger written: a bound spent on a write that
        // did not happen is the watchdog lying to its own ledger, and an empty
        // ledger would make `stallRemedy`'s "absent means never" inexact for
        // every reader of the checkpoint. No spin — a lane whose stdin has gone
        // is a lane whose child has gone, and it settles in seconds.
        log.info('runner.silent-nudge-refused', { slug: state.slug, phase, reason: sent.reason });
        return;
      }
      const remedy = (record.stallRemedy ??= { nudges: 0, recycles: 0 });
      remedy.nudges = nudges + 1;
      remedy.recycles = recycles;
      remedy.nudgedAt = at;
      (remedy.attempts ??= []).push(attempt);
      this.record('phase.auto-nudged', {
        detail: stall.detail, since: stall.since, attempt, nudges: remedy.nudges,
      }, phase);
      this.emit('watchdog', {
        phase, action: 'nudged', attempt, nudges: remedy.nudges, detail: stall.detail,
      });
      this.persist();
      return;
    }
    const remedy = (record.stallRemedy ??= { nudges, recycles });

    // Rung 2 — the recycle, once the nudge has had its grace and the lane is
    // STILL (or once more) silent. `carryOn: true`, so the loop re-boards this
    // phase itself. The grace is measured from the nudge whenever that was:
    // a lane that answered the nudge and wedged again has already shown that
    // rung 1 did not hold, so it does not buy a second grace period.
    if (remedy.nudgedAt && now - Date.parse(remedy.nudgedAt) < STALL_NUDGE_GRACE_MS) return;
    remedy.recycles = recycles + 1;
    remedy.recycledAt = new Date(now).toISOString();
    (remedy.attempts ??= []).push(attempt);
    this.record('phase.auto-recycled', {
      detail: stall.detail, since: stall.since, attempt, recycles: remedy.recycles,
      nudgedAt: remedy.nudgedAt ?? null, graceMs: STALL_NUDGE_GRACE_MS,
      sessionId: record.sessionId ?? null,
    }, phase);
    this.checkpointLane(lane, 'silent before its first tool call, and a nudge did not wake it', { endedBy: 'watchdog' });
    // The card was about a session that no longer exists. Cleared here rather
    // than left for a liveness tick that will never come — the ticker stops
    // with the lane — which is how a stall card came to outlive its subject.
    delete record.stall;
    this.emit('watchdog', {
      phase, action: 'recycled', attempt, recycles: remedy.recycles,
      sessionId: record.sessionId ?? null,
    });
    this.persist();
  }

  /**
   * A lane that is doing nothing but retrying: recycle it once, then park it on
   * the wall it is actually hitting.
   *
   * ## The measured failure
   *
   * A lane emitted `api_retry` for eleven hours having never opened a tool
   * call, and every clock in the console was satisfied. The first-event
   * backstop cleared itself on the first retry (a retry was an event —
   * `spawn.ts`'s `sawProductive` split is the other half of this fix). The
   * `retrying` stall signal fired correctly and was card-only. And `liveWall`,
   * the one thing that DOES act, only acts on a category of `rate_limit` —
   * which the CLI often does not send (hence `inferRetryCategory`), and which
   * an `overloaded` storm never has, because capacity is not quota and another
   * account does not fix it.
   *
   * So `liveWall` is rung 0 of this ladder and it stays exactly as it is: a
   * quota wall with somewhere to go is an account switch, per the run's own
   * `onLimit`, and that is the best possible outcome. This picks up the storms
   * it cannot help — no category, the wrong category, or nowhere to switch to.
   *
   * ## Rung 1, the recycle — bounded by the same envelope as the silent one
   *
   * A recycle kills a process, so it is allowed only where it provably loses
   * nothing: `preFirstTurn`. A session six hours into its work that starts
   * retrying is a person's card, not this. Once, ever, per phase — and on its
   * OWN counter (`stallRemedy.retryRecycles`), because a rung spent for silence
   * is not a rung spent for a storm.
   *
   * ## Rung 2, the park — with the meter's own clock
   *
   * The park's NOTE is what makes the classifier answer `resource-wall:usage`
   * instead of "the session went quiet" — the difference between an errand that
   * says "wait for the window" and one that says "go and look at it". It steers
   * `situation.ts` through `USAGE_RE`, phase-scoped. It used to steer it by
   * writing `state.limits.status = 'limited'` on the RUN, which worked and also
   * relabelled every OTHER phase of that run a usage wall until a live limits
   * event arrived, because nothing else clears that field and the arm outranks
   * `blocked-declared`. One phase's wall is not the account's.
   *
   * `parkedUntil` is the CLI's reported reset when there is one; for
   * `overloaded` there is no window to report, and ten minutes is the shortest
   * wait that is worth a resume rather than a spin.
   */
  private retryStormRemedy(lane: Lane, stall: StallState, now: number): void {
    const state = this.state;
    if (!state) return;
    // The same standing-down guards as `silentRemedy`. A lane the console is
    // itself ending, pausing or holding is not storming; it is being stopped.
    if (lane.checkpointed || lane.stopped || lane.frozen) return;
    if (this.stopRequested || this.abort?.signal.aborted || state.halt) return;
    if (state.status === 'pausing' || state.status === 'halting' || state.status === 'stopping') return;
    if (state.status === 'frozen' || state.freeze) return;
    const fleet = this.fleetFrozen();
    if (fleet) {
      log.info('runner.retry-storm-frozen', { slug: state.slug, phase: lane.phase, by: fleet.by ?? null });
      return;
    }

    const phase = lane.phase;
    const record = phaseRecord(state, phase);
    const attempt = record.attempts ?? 0;
    if (!this.preFirstTurn(lane, record)) return;

    const category = lane.signals.lastRetryCategory;
    // Read through `?? 0` for the reason the silent ladder does: an older
    // checkpoint has no such field, and `undefined + 1` is `NaN` — a counter
    // that is never greater than zero, so the rung would be climbed for ever.
    const recycles = record.stallRemedy?.retryRecycles ?? 0;
    const remedy = (record.stallRemedy ??= { nudges: 0, recycles: 0 });

    // Rung 1 — one recycle. `carryOn: true` (the default), so the drive loop
    // re-boards the phase itself, with the lock and the lease undisturbed.
    if (!recycles) {
      remedy.retryRecycles = 1;
      remedy.retryRecycledAt = new Date(now).toISOString();
      (remedy.attempts ??= []).push(attempt);
      this.record('phase.retry-storm-recycled', {
        detail: stall.detail, since: stall.since, attempt, category: category ?? null,
        sessionId: record.sessionId ?? null,
      }, phase);
      this.checkpointLane(lane, `nothing but API retries before its first tool call${category ? ` (${category})` : ''}`, { endedBy: 'watchdog' });
      // The card was about a session that no longer exists — cleared here for
      // the same reason the silent recycle clears it: the liveness ticker stops
      // with the lane, so nothing else ever will.
      delete record.stall;
      this.emit('watchdog', {
        phase, action: 'retry-recycled', attempt, recycles: 1, detail: stall.detail,
      });
      this.persist();
      return;
    }

    // Rung 2 — the park. Once: a phase already parked on this stays parked
    // until something re-boards it, and re-parking on every tick would rewrite
    // `parkedUntil` forward for ever, which is a wait that never ends.
    if (remedy.retryParkedAt) return;

    const resetsAt = state.limits?.resetsAt;
    // The CLI reports it in epoch SECONDS. `overloaded` is capacity, which has
    // no window to report at all, so it gets a short fixed one instead.
    const wall = typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt * 1000 > now
      ? resetsAt * 1000
      : now + RETRY_STORM_PARK_MS;
    const until = new Date(wall).toISOString();
    remedy.retryParkedAt = new Date(now).toISOString();
    // The classifier is steered through the PHASE's note, not through a
    // fabricated run-level `limits.status`.
    //
    // Writing `state.limits.status = 'limited'` did answer `resource-wall:usage`
    // — and it answered it for every OTHER phase of the run too, since nothing
    // clears that field but a live `limits` event from a running session, and
    // arm 9 of the classifier outranks `blocked-declared` (arm 10). A sibling
    // that had honestly declared a blocker was relabelled a usage wall and
    // stayed that way; the spread also carried a stale `resetsAt`/`utilization`
    // forward into a real usage banner on the status strip (QA F7). One phase's
    // wall is not the account's.
    //
    // `USAGE_RE` (`runner/situation.ts`) reads the note, and "the window resets"
    // is the phrase it matches — true of BOTH walls, which the alternatives are
    // not: "rate limited" is false of a 529 and "usage limit" is false of
    // capacity. The park's window is a real window and it really does reset.
    const why = `nothing but API retries${category ? ` (${category})` : ''} — ${stall.detail}`;
    // The checkpoint FIRST, and the park written over what it leaves behind.
    //
    // `checkpointLane` ends every lane the same way — `status: 'pending'`,
    // `resumeSessionId` kept, a note saying what happened — because its job is
    // to end the child, not to decide what the phase now IS. Writing the park
    // before it would have the checkpoint quietly undo it: the record would read
    // `pending` with a `parkedUntil` nobody honours, and the phase would re-board
    // straight back into the same wall — measured on the first draft of this
    // function, which is why `test/runner.test.ts`'s "recycled once, then parked
    // on the wall it is hitting" asserts the record's WORD and not just its
    // clock. `carryOn: false` because a phase parked on a window must not be
    // re-boarded by the drive loop — the park poke is what brings it back.
    this.checkpointLane(lane, why, { carryOn: false, endedBy: 'watchdog' });
    record.status = 'waiting';
    record.parkedUntil = until;
    syncWaitClock(this.state!);
    record.parkReason = `${why}. Waiting until ${until}, when the window resets.`;
    record.note = record.parkReason;
    // When this park began, on its own field — not `endedAt`, which meant three
    // things (WAI-4). It is the console's park, not a declared wait: it writes
    // no declaration, spends nothing from the wait budget, and boards again with
    // the engine's own prompt rather than "the wait window you declared".
    record.parkedFrom = new Date(now).toISOString();
    delete record.stall;
    this.record('phase.retry-storm-parked', {
      until, detail: stall.detail, since: stall.since, attempt, category: category ?? null,
      resetsAt: typeof resetsAt === 'number' ? resetsAt : null,
    }, phase);
    this.emit('watchdog', { phase, action: 'retry-parked', attempt, until, detail: stall.detail });
    this.emit('phase', { phase, status: 'waiting', note: record.parkReason, parkedUntil: until });
    this.armParkPoke(phase, until);
    this.persist();
  }

  /**
   * Is this lane provably before its first turn — nothing done, nothing spent,
   * nothing to lose?
   *
   * Every clause is a separate way for work to exist, and the watchdog acts
   * only when all of them say there is none. `lastToolUseAt` is the load-bearing
   * one: `turnsSinceLastTool` is reset to zero by every tool call, so on its own
   * it reads "no turns since the last tool" — which is true of a session six
   * hours into its work — and would have let the watchdog kill exactly the
   * sessions it must never touch.
   *
   * **Every clause is about THIS ATTEMPT, and THREE of them had to be rewritten
   * to be** — the third was found only after the first two were fixed, which is
   * the useful part of the story. The obvious spellings — `record.costUsd`,
   * `record.tasks`, and `commitsSinceStart` measured from `record.startedAt` —
   * are all PHASE-cumulative, so on a phase's second attempt they are non-zero
   * because of what the FIRST one did. Read literally they would have made the
   * watchdog fire once in a run's life and then never again, silently, which is
   * a defect no test that boards a single attempt can see. The per-attempt facts
   * are `lane.spentUsd` (folded from the CLI's own `result` messages, and the
   * lane IS the attempt), `record.tasksAt` (the task-file offset, which
   * `armTasksFile` deletes at every spawn), and `commitsSinceStart` measured
   * from `record.attemptStartedAt` (see `evaluateLane`). If you add a clause
   * here, the first question is whose fact it is.
   */
  private preFirstTurn(lane: Lane, record: PhaseRecord): boolean {
    if (lane.signals.lastToolUseAt !== undefined) return false;
    if (lane.signals.turnsSinceLastTool !== 0) return false;
    if (lane.signals.openTools.length) return false;
    if (lane.signals.commitsSinceStart > 0 || lane.signals.treeDirty) return false;
    // `sessionUsd`, not `spentUsd`: the latter is replaced from the CLI's running
    // total and nothing clears it between sessions, so once a lane had spent a
    // cent no later session on it could ever read as pre-first-turn. Its sibling
    // is cleared when `spawnSession` starts and again when it returns — which is
    // what "this attempt" means, as every other clause here already does.
    // (console-open-findings O11.)
    if ((lane.sessionUsd ?? 0) > 0) return false;
    if (record.tasksAt !== undefined) return false;
    return true;
  }

  /**
   * Both remedies were spent on this phase and it went silent again: stop, and
   * leave one ask for a person.
   *
   * Deliberately a park and not a halt. A halt stops the run; this phase is one
   * lane of possibly several and the others are working — the ladder's own
   * exhaustion shape, which parks the phase, records what was tried so nobody
   * repeats it by hand, and lets the loop carry on.
   */
  private stallPark(lane: Lane, record: PhaseRecord, stall: StallState): void {
    const phase = record.phase;
    const at = new Date(this.now().getTime()).toISOString();
    const remedy = record.stallRemedy;
    // Built from what the ledger says ACTUALLY happened, never from what this
    // path assumes must have. An earlier version hardcoded both rungs and could
    // be reached with the recycle never climbed, so the one line whose job is
    // "nobody repeats this by hand" told the operator not to try the only rung
    // that had not been tried. The session-id clause is guarded for the same
    // reason `checkpointLane`'s own note and the push body are: a lane recycled
    // before its `init` frame arrived has no id to have been resumed on.
    const tried: string[] = [];
    if (remedy?.nudges) {
      tried.push(`nudged the session on attempt ${remedy.attempts?.[0] ?? record.attempts ?? 0}`);
    }
    if (remedy?.recycles) {
      tried.push(
        record.resumeSessionId ?? record.sessionId
          ? 'recycled it (the session was ended and the phase re-boarded on its own session id)'
          : 'recycled it (the session was ended; it had no id yet, so the phase re-boarded from '
            + 'its boot prompt)',
      );
    }
    tried.push(`it went silent again before its first tool call on attempt ${record.attempts ?? 0}`);
    // A `SITUATIONS` member (RCV-11, phase 10): the classifier's own answer
    // for this record — no handoff, no work, a session that produced nothing —
    // is `never-started` (arm 14), and the errand files under the same word,
    // so every reader parses it. It used to say `silent-session:unfixable`, a
    // key in no vocabulary, which `parseSituationKey` read as `unknown`; a
    // `stalled` situation of its own is the deliberately untaken v2 path
    // (`docs/loop.md` §Liveness), so the park keeps its own journal line
    // (`phase.stall-parked`) for what the watchdog knows and the situation
    // vocabulary says what the phase IS.
    const errand: Errand = {
      phase,
      situation: 'never-started',
      tried,
      need: 'a person to look at why this phase boots and then says nothing',
      how: 'Open the phase, read the journal from `phase.boarded` onwards, and check the '
        + 'session by hand (`claude --resume <session>`). The two automatic remedies are spent; '
        + 'pressing Retry clears them and lets the watchdog try once more.',
      at,
    };
    this.record('phase.stall-parked', {
      ...errand, detail: stall.detail,
      nudges: remedy?.nudges ?? 0, recycles: remedy?.recycles ?? 0,
    }, phase);
    // End the child first: parking a phase whose session is still spending is
    // the accounting fixed and none of the harm. `carryOn: true` because the
    // run must keep driving its OTHER lanes — the settle reads the note, and a
    // `parked` record is not boardable, so the loop moves on rather than
    // re-boarding this one.
    this.checkpointLane(lane, 'silent twice before its first tool call — parked for a person', { endedBy: 'watchdog' });
    record.status = 'parked';
    record.note = errand.need;
    record.endedAt ??= at;
    delete record.stall;
    this.emit('phase', { phase, status: 'parked', note: record.note, errand });
    this.emit('watchdog', {
      phase, action: 'parked', attempt: record.attempts ?? 0,
      nudges: remedy?.nudges ?? 0, recycles: remedy?.recycles ?? 0,
    });
    this.persist();
  }

  /**
   * A lane that is waiting rather than working: park it, and let go of the lock.
   *
   * The measured failure. A phase sat 35+ minutes inside two concurrent
   * `until … sleep` loops polling a GitHub Actions build, while holding
   * `scope=all` — an exclusive claim on the entire tree. Nothing could see it:
   * the lease keepalive refreshed the claim every ten minutes on a timer, so
   * the lock looked healthy, and `lastOutputAt` had not moved since the Bash
   * call opened, so the lane looked like every other quiet lane. That one lock
   * blocked two other pieces of work for the whole window.
   *
   * The skill already documents the right answer and the session simply did not
   * take it — commit, hand off `in-progress`, declare `waiting-external`, stop,
   * and be resumed when the window elapses. So this does what the operator
   * would have done on the session's behalf. **The waiting is fine; the
   * squatting is not**, and the difference between them is entirely the lock.
   *
   * Three properties, in the order they matter:
   *
   *   - **the lock is released.** `checkpointLane` settles the lane without a
   *     re-attempt, and the settle path releases the phase lock — the whole
   *     point. A park that kept the claim would fix the accounting and none of
   *     the harm;
   *   - **the session is kept.** `checkpointLane` writes `resumeSessionId`, and
   *     `parkWaiting` re-arms the resume on it. The context that knows what it
   *     was waiting for is the context that should read the answer, which is
   *     the same reason a declared `waiting-external` resumes its own session;
   *   - **it reuses the declared-outcome path exactly.** `parkWaiting` carries
   *     the wait cap, the budget, the floor and the park poke. A second parking
   *     mechanism would drift from the first, and this one is reached without a
   *     session's cooperation — precisely when the caps matter most.
   *
   * And the run itself is told, which is the fourth property and the one this
   * path was missing. `carryOn: false` is load-bearing — it is what stops the
   * drive loop instead of letting it re-board a phase that is deliberately
   * parked — but it stops the loop by breaking out of the `while` BEFORE any
   * branch has written a run status. So the checkpoint on disk said a run was
   * `running` with no loop behind it, and the next read reconciled that into
   * `interrupted` under a halt blaming a console crash that never happened: a
   * park, the gentlest thing the supervisor does, presented as the run dying.
   * `enterRunWaiting` is the DECLARED path's own bookkeeping, extracted so
   * both reach it — a second copy here would drift from the first, which is
   * the same reason this reuses `parkWaiting` rather than parking by hand.
   */
  /**
   * The `external-wait` signal's action, routed by WHOSE clock it is.
   *
   * One entry point reached from both the transition arm and the repeat-tick
   * arm of `evaluateLane`, because the local branch is two-staged and its
   * second stage can only ever land on a repeat tick.
   *
   * `external` is unchanged and immediate: a session holding an exclusive lock
   * to watch somebody else's CI is pure loss, and five minutes of it is
   * already generous.
   *
   * `local` is a nudge first — the session IS working, it has just put the
   * waiting in the wrong place — and the park only once even a long local job
   * has had `stallLocalJobMs`. That ordering is the whole point of the split:
   * parking a lane 40 minutes into its own suite throws the suite away and
   * runs it again, which is what the measured 26 park→resume cycles were.
   */
  private externalWaitRemedy(
    lane: Lane, stall: StallState, thresholds: StallThresholds, now: number,
  ): void {
    // The session's OWN background work is running (control-tower phase 111,
    // #206): a checkpoint signals its whole process group, and two release
    // preflights died with one. A wait it holds over that work is judged on the
    // own-job rungs — a nudge at ten minutes, the park at the local budget —
    // and the park, when it comes, names the work it ends.
    if (stall.scope !== 'local' && ownBackgroundWork(lane.signals).length) stall = { ...stall, scope: 'local' };
    if (stall.scope !== 'local') { this.externalClockRemedy(lane, stall, thresholds, now); return; }

    const state = this.state;
    if (!state) return;
    // The same standing-down guards as every other watchdog act, and for the
    // same reason: a frozen, stopping or held lane is quiet BY CONSTRUCTION,
    // and acting on that is the console mistaking its own hand for a fault.
    if (lane.checkpointed || lane.stopped || lane.frozen) return;
    if (this.stopRequested || this.abort?.signal.aborted || state.halt) return;
    if (state.status === 'pausing' || state.status === 'halting' || state.status === 'stopping') return;
    if (state.status === 'frozen' || state.freeze) return;
    const fleet = this.fleetFrozen();
    if (fleet) {
      log.info('runner.local-job-watchdog-frozen', {
        slug: state.slug, phase: lane.phase, by: fleet.by ?? null,
      });
      return;
    }

    const phase = lane.phase;
    const record = phaseRecord(state, phase);
    // Read through `?? 0` — a checkpoint written before this ladder existed
    // carries no counter, and `undefined + 1` is `NaN`, a number never greater
    // than zero, so every rung would stay unclimbed for ever. Same defect the
    // silent ladder's own comment is a monument to.
    const nudges = record.stallRemedy?.localNudges ?? 0;
    const openedAt = Date.parse(stall.since);
    const age = Number.isFinite(openedAt) ? now - openedAt : 0;

    // Rung 2 — it is still inside the turn well past the local budget. At that
    // point the distinction has stopped paying: park it like any other wait,
    // but with a `cmd:` ref (below) so the console can bring it back the moment
    // the job it was watching is actually done.
    //
    // ⚠️ Deliberately NOT gated on `nudges`. It was, and QA found the hole: a
    // `steer()` the child refuses counts no rung (correctly — a ledger that
    // records a write which never happened is the record lying), so a lane with
    // closed stdin could never reach rung 2, and `external-wait` outranks
    // `silent`, so the silent ladder could not rescue it either. That lane
    // parked at five minutes BEFORE this split existed and would have waited
    // for ever after it. The budget is the session's, not the nudge's.
    if (age >= thresholds.stallLocalJobMs) {
      this.externalWaitPark(lane, stall, thresholds);
      return;
    }
    if (nudges) return;
    // …and not before the window the wait procedure itself grants this session
    // on its own job. The `external-wait` signal opens at `stallExternalWaitMs`
    // (5 min by default); rule 3 allows one foreground call per TEN. Nudging in
    // between is the console interrupting a session for obeying it.
    // (console-open-findings O6.)
    if (age < localNudgeAfterMs(thresholds.stallExternalWaitMs)) return;

    // Rung 1 — the nudge. Write FIRST, journal after, and journal the refusal
    // separately: a line saying the console nudged a session it did not reach
    // is not evidence, it is the record lying.
    const sent = this.steer(LOCAL_JOB_NUDGE, 'watchdog', undefined, phase);
    if (!sent.ok) {
      // Once per episode, not once per tick. This method is reached on every
      // repeat tick of an open `external-wait` (that is what makes rung 2
      // reachable at all), so an unguarded line here writes a journal entry a
      // minute for as long as the call stays open.
      if (!lane.localNudgeRefused) {
        lane.localNudgeRefused = true;
        this.record('phase.auto-nudge-refused', {
          detail: stall.detail, since: stall.since, scope: 'local', reason: sent.reason ?? null,
        }, phase);
        log.info('runner.local-job-nudge-refused', {
          slug: state.slug, phase, reason: sent.reason ?? null,
        });
      }
      return;
    }
    record.stallRemedy = {
      ...(record.stallRemedy ?? { nudges: 0, recycles: 0 }),
      localNudges: nudges + 1,
      localNudgedAt: new Date(now).toISOString(),
    };
    this.record('phase.auto-nudged', {
      detail: stall.detail,
      since: stall.since,
      scope: 'local',
      parkAfterMs: thresholds.stallLocalJobMs,
    }, phase);
    this.persist();
  }

  /**
   * An external-clock wait (control-tower phase 111, #179): the session is
   * told first, and parked only if the call is still open once
   * `EXTERNAL_PARK_GRACE_MS` has passed since a nudge it RECEIVED in this
   * episode — the own-job nudge counts too, it said the same thing. A session
   * that cannot be told is parked at once, as before: nothing else reaches it.
   * The park used to come at minute five with no word to the session at all.
   */
  private externalClockRemedy(
    lane: Lane, stall: StallState, thresholds: StallThresholds, now: number,
  ): void {
    const state = this.state;
    if (!state) return;
    if (lane.checkpointed || lane.stopped || lane.frozen) return;
    if (this.stopRequested || this.abort?.signal.aborted || state.halt) return;
    if (state.status === 'pausing' || state.status === 'halting' || state.status === 'stopping') return;
    if (state.status === 'frozen' || state.freeze) return;
    const phase = lane.phase;
    const record = phaseRecord(state, phase);
    const opened = Date.parse(stall.since);
    const told = [record.stallRemedy?.externalNudgedAt, record.stallRemedy?.localNudgedAt]
      .map((at) => (at ? Date.parse(at) : Number.NaN))
      .filter((at) => Number.isFinite(at) && (!Number.isFinite(opened) || at >= opened))
      .sort((a, b) => b - a)[0];
    if (told !== undefined) {
      if (now - told >= EXTERNAL_PARK_GRACE_MS) this.externalWaitPark(lane, stall, thresholds);
      return;
    }
    const sent = this.steer(EXTERNAL_WAIT_NUDGE, 'watchdog', undefined, phase);
    if (!sent.ok) {
      this.record('phase.auto-nudge-refused', {
        detail: stall.detail, since: stall.since, scope: 'external', reason: sent.reason ?? null,
      }, phase);
      this.externalWaitPark(lane, stall, thresholds);
      return;
    }
    record.stallRemedy = {
      ...(record.stallRemedy ?? { nudges: 0, recycles: 0 }),
      externalNudges: (record.stallRemedy?.externalNudges ?? 0) + 1,
      externalNudgedAt: new Date(now).toISOString(),
    };
    this.record('phase.auto-nudged', {
      detail: stall.detail, since: stall.since, scope: 'external', parkAfterMs: EXTERNAL_PARK_GRACE_MS,
    }, phase);
    this.persist();
  }

  /**
   * The console's in-turn-wait guard refused a Bash call on this phase's lane
   * (`Service.decideToolUse`). Fed to the lane's signals so the local-job ladder
   * can reach the one wait it could never see — a call denied before it opened
   * (RCV-5's firing half; the situation and its rung are phase 9's).
   */
  /**
   * A lane is ending — its phase finished, failed, parked or was recovered —
   * so its stall episode ends with it (control-tower phase 47, #80): the record
   * forgets the stall and the card is retracted. `lanes.delete` used to do
   * neither, and the escalation timer found the stall still set 45 minutes
   * later and pushed an URGENT card about a phase that had finished.
   */
  protected endLaneStall(phase: number): void {
    const state = this.state;
    const record = state?.phases[String(phase)];
    const lane = this.lanes.get(phase);
    const stall = lane?.signals.stall ?? record?.stall;
    // `stalemate` is the one signal about the PHASE rather than the session:
    // it is raised as an attempt ends ("3 attempts in a row changed nothing"),
    // so ending the lane is its evidence, not its end. It clears when an
    // attempt commits something.
    if (!state || !record || !stall || stall.signal === 'stalemate') return;
    if (lane) lane.signals.stall = null;
    delete record.stall;
    this.record('phase.liveness', { cleared: stall.signal, reason: 'lane-ended' }, phase);
    this.emit('liveness', {
      phase, liveness: record.liveness, stall: null, attempt: record.attempts ?? 0, ended: true,
    });
  }

  /**
   * The pids this phase's live session announced itself with `$!` — what the
   * in-turn-wait guard reads to tell a probe of the session's own job from a
   * probe of a process it found (control-tower phase 47, AUD-34).
   */
  ownPids(phase: number): readonly number[] | undefined {
    return this.lanes.get(phase)?.signals.ownPids;
  }

  noteWaitDenied(phase: number, denial: { command: string; matched: string }): void {
    const lane = this.lanes.get(phase);
    if (!lane) return;
    const thresholds = stallThresholds(this.deps.stallThresholds?.());
    noteWaitDenied(lane.signals, denial, this.now().getTime(), thresholds.stallLocalJobMs);
    // …and on the RECORD, where a restart cannot lose it and the declaration
    // path can read it: `applyEvent` deletes the lane's episode on the very
    // `phase-outcome.sh` call that declares the wait, so the persisted stamp
    // is the only witness a ref-less `waiting-external` is judged against
    // (TRS-3). Not a permission block — `rule` says which guard.
    this.noteToolDenied(phase, { tool: 'Bash', rule: 'in-turn-wait', command: denial.command, matched: denial.matched });
  }

  /**
   * The subagents and monitors this phase's live session has running in the
   * background — the tasks whose notification will start its next turn, so a
   * turn that ends while they run is a wait, not an exit (`Service.decideStop`;
   * autopilot-token-drain phase 1). Empty for a phase with no live lane.
   */
  awaitingBackground(phase: number): BackgroundTask[] {
    const lane = this.lanes.get(phase);
    return lane ? awaitingBackground(lane.signals) : [];
  }

  /**
   * The poll-loop guard's question for one of this phase's own calls, asked by
   * the PreToolUse hook (`Service.decideToolUse`, autopilot-token-drain phase 2):
   * is it a status check, and one too many? The stream folds the session's other
   * calls into the same tracker (`applyEvent`), so the hook sees the streaks they
   * broke. `null` with no live lane — there is nothing to ask.
   */
  observeToolCall(phase: number, call: PollCall): PollVerdict | null {
    const lane = this.lanes.get(phase);
    if (!lane) return null;
    return observeCall((lane.signals.pollLoop ??= newPollLoop()), call, this.now().getTime());
  }

  /**
   * Write the poll-loop notice into this phase's session — once per lane: a loop
   * the refusal did not break will not break for hearing it twice. A write the
   * session refuses still spends it, since stdin that has closed stays closed.
   * True only when the notice was delivered.
   */
  nudgePollLoop(phase: number, text: string): boolean {
    const lane = this.lanes.get(phase);
    if (!lane || lane.signals.pollNudged) return false;
    lane.signals.pollNudged = true;
    return this.steer(text, 'watchdog', undefined, phase).ok;
  }

  /**
   * The context thresholds, judged on each API call of the phase's OWN session
   * (`spawnSession` calls this for `mode: 'phase'` only; autopilot-token-drain
   * phase 3, `runner/usage.ts`).
   *
   * At `CONTEXT_WRAPUP_FRACTION` of the window the session is told once to finish
   * its step, commit, hand off `in-progress` and declare `partial --reason
   * context`. At `CONTEXT_CHECKPOINT_FRACTION` the console checkpoints the lane
   * itself and the next attempt boards FRESH with the resume brief — never
   * `--resume` of that session, because resuming it is the whole-context bill
   * this exists to stop. Each is spent once per SESSION id and kept on the record
   * (`contextWrapup`, `contextCheckpoint`), so a `--resume` of a session already
   * told is not told again, and a session no model is known for is never judged.
   * A wrap-up the session did not receive is not spent: it is tried again on each
   * usage event until it arrives or the checkpoint fires, and each refusal
   * reason is journalled once (`phase.wrapup-undelivered`, control-tower phase 46).
   */
  protected noteContext(phase: number, event: Extract<StreamEvent, { kind: 'usage' }>): void {
    const state = this.state;
    const lane = this.lanes.get(phase);
    if (!state || !lane) return;
    const record = phaseRecord(state, phase);
    const window = contextWindowOf([record.model, record.actualModel], loadModelsEnv(this.deps.scriptsDir));
    if (!window) return;
    lane.signals.contextWindow = window;
    const context = event.totals.lastContext;
    const stage = contextStage(context, window);
    // A lane the console is already ending has nothing left to be told.
    if (stage === 'ok' || lane.checkpointed || lane.stopped || this.stopRequested) return;
    const sessionId = record.sessionId ?? null;
    const at = this.now().toISOString();

    if (stage === 'checkpoint') {
      if (record.contextCheckpoint?.sessionId === sessionId) return;
      record.contextCheckpoint = { sessionId, at, context, window };
      this.record('phase.context-wrapup', {
        stage, context, window, fraction: CONTEXT_CHECKPOINT_FRACTION, sessionId,
      }, phase);
      this.checkpointLane(lane, `context ${tokensLabel(context)} of a ${tokensLabel(window)} window`, {
        carryOn: true, endedBy: 'checkpoint',
      });
      // Fresh, not resumed. `checkpointLane` keeps the session for `--resume` —
      // right for an account switch, wrong here: its context is the bill. The
      // re-board is the same one a `partial` with no session to resume gets.
      prepareReboard(record);
      record.resumeSessionId = undefined;
      const hint: BoardingHint = {
        situation: 'work-in-progress', rung: 'resume-own-session', brief: 'resume',
        instruction: contextCheckpointInstruction(context, window), at, by: 'watchdog',
      };
      record.boardingHint = hint;
      record.note = `checkpointed at ${tokensLabel(context)} of a ${tokensLabel(window)} context window — `
        + 'the next attempt boards fresh with the resume brief';
      this.record('phase.reboard-requested', {
        situation: hint.situation, rung: hint.rung, brief: hint.brief, by: 'watchdog',
      }, phase);
      this.persist();
      this.emit('phase', { phase, status: record.status, note: record.note });
      return;
    }

    const mark = record.contextWrapup?.sessionId === sessionId ? record.contextWrapup : undefined;
    // Told once per session. A mark written before 6.0 has no `delivered: false`
    // to retry on, and reads as told.
    if (mark && mark.delivered !== false) return;
    // …and until it is told, it is tried again on every usage event (control-tower
    // phase 46, #79). The steer used to be spent "whether or not it arrived",
    // with its refusal thrown away: 3 of the audit week's 17 wrap-ups never
    // arrived, and both of its checkpoints followed one of them (many-plans P15
    // ran 41 minutes from 0.6 to 0.8 of its window). The checkpoint above is
    // where the retries end — a lane it has cut is never reached again.
    const attempt = (mark?.attempts ?? 0) + 1;
    const told = this.steer(
      // Which commit step applies (control-tower phase 89, #127): a lane of its
      // own, or the run's shared branch with the fast gate the boarding read.
      contextWrapupNotice(context, window, `bash ${SCRIPTS_REF}/phase-outcome.sh ${state.slug} ${phase}`, {
        shared: !lane.worktree, ...(lane.fastGate ? { fastGate: lane.fastGate } : {}),
        // …and its own agents still at work, named (control-tower phase 109, #188).
        background: awaitingBackground(lane.signals), now: Date.now(),
      }),
      'watchdog', undefined, phase,
    );
    if (told.ok) {
      record.contextWrapup = { sessionId, at, context, window, delivered: true, attempts: attempt };
      this.record('phase.context-wrapup', {
        stage, context, window, fraction: CONTEXT_WRAPUP_FRACTION, sessionId, delivered: true, attempt,
      }, phase);
    } else {
      const reason = told.reason ?? 'the steer was refused';
      record.contextWrapup = { sessionId, at: mark?.at ?? at, context, window, delivered: false, attempts: attempt, reason };
      // One line per refusal REASON, not per call: a session calling every few
      // seconds would otherwise write a line a call until the checkpoint.
      if (mark?.reason !== reason) {
        this.record('phase.wrapup-undelivered', { sessionId, context, window, reason, attempt }, phase);
      }
    }
    this.persist();
  }

  /**
   * A tool call THIS console refused for the phase — the hook's decision
   * (`Service.decideToolUse`), stamped on the record as first-class evidence
   * (LFC-3): the situation classifier reads a deny-list denial as
   * `blocked-declared:permission` above any prose, and the errand quotes the
   * rule and the command from here rather than from what the session made of
   * them. Only the newest denial is kept; a boarding clears it.
   */
  noteToolDenied(phase: number, denial: { tool: string; rule: string; command?: string; matched?: string }): void {
    const state = this.state;
    if (!state) return;
    const record = state.phases[String(phase)];
    if (!record) return;
    record.toolDenied = {
      tool: denial.tool, rule: denial.rule, at: this.now().toISOString(),
      ...(denial.command ? { command: denial.command.replace(/\s+/g, ' ').slice(0, 400) } : {}),
      ...(denial.matched ? { matched: denial.matched } : {}),
    };
    this.persist();
  }

  private externalWaitPark(lane: Lane, stall: StallState, thresholds: StallThresholds): void {
    const state = this.state;
    if (!state) return;
    // The same standing-down guards as the live wall: the lane is already
    // ending, an operator holds it, or the run itself is on its way down.
    if (lane.checkpointed || lane.stopped || lane.frozen) return;
    if (this.stopRequested || this.abort?.signal.aborted || state.halt) return;
    if (state.status === 'pausing' || state.status === 'halting' || state.status === 'stopping') return;
    // The off switch (SLF-9, KNOWN-SINCE): the stall card still stands, and the
    // local job's nudge still went, but the console does not take the turn away
    // from the session by itself. Said once per episode, not once per tick.
    if (this.deps.stallAutomaticPark && !this.deps.stallAutomaticPark()) {
      if (!lane.automaticParkDeclined) {
        lane.automaticParkDeclined = true;
        log.info('runner.automatic-park-off', { slug: state.slug, phase: lane.phase, detail: stall.detail });
      }
      return;
    }

    const phase = lane.phase;
    // Whose clock, in the sentence a person reads on the park card. The same
    // correction `4b950e9` made to the stall blurb: a local park that calls
    // itself external is the phase's own defect class, one layer down.
    const said = stall.scope === 'local'
      ? `still waiting inside the turn on a job this session started — ${stall.detail}`
      : `waiting on an external clock inside the turn — ${stall.detail}`;
    // The tool's own text is the best `watch` reference available: it is
    // literally the command whose completion the phase is waiting for, and it
    // is what a person reading the park card needs in order to check it.
    // A DENIED wait opened no call: its command is the one the guard refused.
    const denied = stall.source === 'denied' ? lane.signals.waitDenied : undefined;
    // …and between two calls of a chain, the chain's newest wait (#67).
    const chained = stall.chain ? lane.signals.waitChains?.find((chain) => chain.key === stall.chain!.key) : undefined;
    const watching = denied
      ? { name: 'Bash', summary: denied.command }
      : lane.signals.openTools.find((tool) => tool.name === 'Bash' && tool.summary)
        ?? (chained ? { name: 'Bash', summary: chained.summary } : undefined);
    // The command carries its own landing condition, and a ref makes the
    // console able to act on it: the lane comes back when the job is actually
    // done rather than at the end of a guessed window. `mintWatchRef` reads
    // every shape the guard refuses (phase 9, RCV-5) — a poll loop's condition,
    // a `--watch` runner's one-shot form, a `sleep`'s clock, a `gh` watch's
    // run or PR — and answers null for a command with no honest landing
    // (`tail -f`), whose summary then stays on the card as the sentence a
    // person reads.
    const minted = watching?.summary ? mintWatchRef(watching.summary, this.now().getTime()) : null;
    // A clock loop says when it ends (control-tower phase 111, #179): the park
    // is bounded by that, not by a fixed window over a target seconds away.
    const knownEnd = watching?.summary ? knownEndOf(watching.summary, this.now().getTime()) : null;
    // …and the session's own background work this checkpoint ends (#206).
    const ownWork = ownBackgroundWork(lane.signals);
    // A minted `cmd:` ref RUNS only on the operator's yes (`watchMintedCmdRefs`,
    // SLF-8). Armed anyway, it read `unknown — not run` for the whole park and
    // its only exit was the window (#121 item 3), so a park never arms a ref
    // nothing will run (control-tower phase 88): it parks on its window, saying so.
    const held = Boolean(minted?.startsWith('cmd:')) && !this.deps.mintedCmdRefs?.();
    // The session's OWN job (control-tower phase 89, #121 ask 2): the
    // checkpoint below signals the session's whole process group, and a job it
    // started with `&` is in that group — so the job ends with the session,
    // and a ref on its output would wait for a file nothing will ever write
    // (vca P11: an Android sweep at route 27 of 68, killed, its marker watched
    // for 30 minutes). No ref is armed; the record owes the job a re-run.
    const ownJob = stall.scope === 'local';
    const cmdRef = held || ownJob ? null : minted;
    // …and a loop whose condition could not be minted says WHY (control-tower
    // phase 89, #52 ask 3 via #121): vca P10's `"$L"` is the session's variable.
    const unminted = !minted && watching?.summary ? unmintedReason(watching.summary) : null;
    // A park with nothing the console can poll SAYS so, and parks on its
    // window alone (control-tower phase 47, #52). It used to record the
    // command itself as the watch — a ref the scheduler already knew it could
    // never poll, journalled as unpollable on the same second.
    const parked = cmdRef
      ? said
      : ownJob
        ? `${said} — the checkpoint ends that job with the session (the whole process group), so no watch is armed on its output; the next session re-runs it`
        : held
          ? `${said} — the ref it could watch (${minted}) is not run on this console (watchMintedCmdRefs is off), so it resumes at the window`
          : unminted
            ? `${said} — its condition cannot succeed as a watch (${unminted}), so it parks with no ref and resumes at the window`
            : `${said} — no ref the console can poll, so it resumes at the window`;
    const reason = !cmdRef && knownEnd !== null
      ? `${parked}; its loop ends at ${new Date(knownEnd).toISOString()}, so that is the window`
      : parked;
    this.record('phase.external-wait', {
      detail: stall.detail,
      since: stall.since,
      scope: stall.scope ?? 'external',
      source: stall.source ?? 'open',
      command: watching?.summary ?? null,
      watch: cmdRef,
      ...(knownEnd !== null && !cmdRef ? { until: new Date(knownEnd).toISOString() } : {}),
      ...(ownWork.length ? { background: ownWork.map((task) => ({ id: task.id, description: task.description ?? null })) } : {}),
      thresholdMs: stall.scope === 'local'
        ? thresholds.stallLocalJobMs
        : thresholds.stallExternalWaitMs,
    }, phase);

    this.checkpointLane(lane, reason, { carryOn: false, endedBy: 'watchdog' });
    if (ownJob) {
      // Owed by the SESSION, not the console (`owesVerification` tells the two
      // apart): the next boarding's brief names the job and asks for it again.
      const record = phaseRecord(state, phase);
      const jobs = [
        stall.chain?.key ?? (watching?.summary ? probeSignature(watching.summary) : null),
        ...ownWork.map((task) => task.description ?? task.id),
      ].filter((job): job is string => Boolean(job));
      record.reverify = { at: this.now().toISOString(), cause: 'checkpoint', ...(jobs.length ? { jobs } : {}) };
    }
    // No `resume_after`: the session never named a window, so `parkWaiting`'s
    // own default (WAIT_DEFAULT_MS) applies — inventing a shorter one here
    // would be the console guessing at somebody else's build time.
    //
    // `by: 'watchdog'` (SLF-9, WAI-5): this is the CONSOLE's park, in the
    // console's name — its own ledger, never the session's declared waits or
    // its budget — and the `cmd:` ref it lifted out of the loop is marked as
    // minted, so nothing reads it as the session's instruction.
    delete lane.signals.waitDenied;
    this.parkWaiting(phase, {
      version: 1,
      slug: state.slug,
      phase,
      status: 'waiting-external',
      reason,
      watch: cmdRef ? [cmdRef] : [],
      ...(knownEnd !== null && !cmdRef ? { resume_after: new Date(knownEnd).toISOString() } : {}),
      written_at: new Date(this.now().getTime()).toISOString(),
      ...(phaseRecord(state, phase).sessionId ? { session_id: phaseRecord(state, phase).sessionId } : {}),
    }, { by: 'watchdog', budget: this.knownWaitBudget(phase), ...(cmdRef ? { minted: [cmdRef] } : {}) });
    // The run, not only the record. `carryOn: false` breaks the loop before
    // any ending branch runs, so unless this says what the run is doing the
    // checkpoint reads `running` with nothing driving it.
    this.enterRunWaiting(new Date(this.now().getTime()).toISOString());
    this.haltSignal.dispatchEvent(new Event('wake'));
    this.persist();
    this.emit('run', { state });
  }

  /**
   * "Every phase that could start is parked on somebody else's clock" — as a
   * run status, from whichever path parked the last one.
   *
   * One method with two callers, deliberately. The drive loop reaches it when
   * a DECLARED `waiting-external` outcome leaves nothing else to admit; the
   * automatic park (`externalWaitPark`) reaches it because `carryOn: false`
   * ends the loop before the loop can. Those two used to end differently —
   * the declared one `waiting` with a clock, the automatic one `running` with
   * no loop behind it, which reconciled to `interrupted` on the next read.
   * The park is the same event either way and the run must say the same thing
   * about it, so the sentence is composed once.
   *
   * Returns whether it applied: a caller that parked nothing (or whose parks
   * have all lapsed) is not waiting on anything and must fall through to its
   * own ending.
   */
  protected enterRunWaiting(nowIso: string, asked?: Set<number> | null, beside?: WaitBeside | null): boolean {
    const state = this.state;
    if (!state) return false;
    // Only waits whose clock is still AHEAD: an expired one is either a
    // candidate the loop is about to board, or — when its board state cannot
    // board — not a reason to hold the run on a clock that has passed.
    // A spent park whose every live ref the watch clock has since REFUSED waits
    // on nothing: it is a person's again, with its `budgets` errand (control-
    // tower phase 121) — filed once, here, where the run decides it waits.
    for (const r of Object.values(state.phases)) {
      const spent = r.declared?.budgetSpent;
      if (r.status !== 'waiting' || r.parkedUntil || !spent || (asked && !asked.has(r.phase))) continue;
      const named = liveRefs(r.watch ?? []);
      if (!named.length || stillLiveRefs(r).length || state.recoveries?.[String(r.phase)]?.errand) continue;
      const stamped = r.declared?.budget;
      this.parkOnSpentBudget(r.phase, {
        ledger: spent.ledger,
        refusal: `every ref it waited on was refused (${named.map((t) => t.ref).join(', ')}), so nothing it named can be watched any more`,
        budget: {
          budgetMs: stamped?.ms ?? DEFAULT_WAIT_BUDGET_MS, source: stamped?.source ?? 'default', countersignedUntil: null, refs: [],
          ...(stamped?.waits !== undefined ? { waitsMax: stamped.waits, waitsSource: stamped.waitsSource ?? 'default' } : {}),
        },
      });
    }
    const waiting = Object.values(state.phases)
      .filter((r) => r.status === 'waiting' && r.parkedUntil && r.parkedUntil > nowIso)
      .filter((r) => !asked || asked.has(r.phase));
    // A phase waiting on its REFS alone — its wait budget spent, a ref still
    // polling (control-tower phase 121, #40): the run waits on that ref, never
    // `parked` with nothing ready. Its landing resumes the phase; the run's
    // clock is only a look-again (`REF_WAIT_LOOK_AGAIN_MS`).
    const onRefs = Object.values(state.phases)
      .filter((r) => r.status === 'waiting' && !r.parkedUntil && Boolean(r.declared?.budgetSpent)
        && stillLiveRefs(r).length > 0)
      .filter((r) => !asked || asked.has(r.phase));
    if (!waiting.length && !onRefs.length) return false;
    const refs = [...new Set(onRefs.flatMap((r) => stillLiveRefs(r).map((target) => target.ref)))];
    const soonest = waiting.length
      ? [...waiting].map((r) => r.parkedUntil!).sort()[0]!
      : new Date(Date.parse(nowIso) + REF_WAIT_LOOK_AGAIN_MS).toISOString();
    const all = [...waiting, ...onRefs];
    const names = all.map((r) => r.phase).sort((a, b) => a - b).join(', ');
    state.stoppedBy = 'system';
    // The same clock `syncWaitClock` keeps on every park — restated here because
    // this is the transition that makes it the RUN's wait.
    state.waitUntil = soonest;
    setRunState(state, 'waiting', { kind: 'external', until: soonest, ...(refs.length ? { on: refs[0]! } : {}) });
    state.finishedReason = `waiting on external work — phase${all.length === 1 ? '' : 's'} `
      + `${names} parked (${all.map((r) => r.parkReason).filter(Boolean).join('; ') || 'declared waits'}); `
      + (waiting.length
        ? `resumes at ${soonest}${refs.length ? `, or when ${refs.join(' or ')} lands` : ''}.`
        : `resumes when ${refs.join(' or ')} lands — its wait budget is spent, so the ref is its clock.`)
      // The stop a sibling phase ended on stands beside the wait (#53): its
      // errand is its own phase's, and the run says so rather than hiding it.
      + (beside ? ` Meanwhile phase ${beside.phase} stopped and stands as it is: ${beside.reason}` : '');
    this.record('run.waiting-external', {
      phases: all.map((r) => r.phase), waitUntil: soonest, ...(refs.length ? { on: refs } : {}),
      ...(beside ? { beside } : {}),
    });
    return true;
  }

  protected engine(args: string[], env?: Record<string, string>) {
    const state = this.state!;
    // No cache key on purpose. The board is read moments after a child wrote a
    // handoff, and the watcher that invalidates the cache may not have fired
    // yet — a cached "not done" here would fail a phase that succeeded.
    return engineRun(
      { scriptsDir: this.deps.scriptsDir, root: state.root, mcpServers: this.deps.mcpIds?.() },
      'phase-graph.sh', [state.slug, ...args],
      undefined, env ? { env } : undefined,
    );
  }

  protected script(script: string, args: string[]) {
    const state = this.state!;
    return engineRun(
      { scriptsDir: this.deps.scriptsDir, root: state.root, mcpServers: this.deps.mcpIds?.() },
      script, args,
    );
  }

  /** The lease keepalive's door: the same script, outside the engine pool (#77). */
  protected lockScript(script: string, args: string[]) {
    const state = this.state!;
    return runOutsidePool(
      { scriptsDir: this.deps.scriptsDir, root: state.root, mcpServers: this.deps.mcpIds?.() },
      script, args,
    );
  }

  protected async board(): Promise<Board> {
    return readMemoryBlock(await this.engine(['--memory-block']));
  }

  /**
   * Release the phase lock the session took. A session that finished cleanly
   * has usually released it already, so a refusal here is normal rather than a
   * fault — it is only worth a line in the log when the lock turns out to
   * belong to somebody else entirely.
   */
  protected async release(phase: number, owner: string): Promise<void> {
    // `--git` is never passed: the console's one commit is the mirror below —
    // this lock's path alone, outside any session's turn, never pushed.
    const result = await this.script('phase-lock.sh', [this.state!.slug, 'release', String(phase), '--owner', owner]);
    if (result.code !== 0 && !/no lock|not held|free/i.test(result.stdout + result.stderr)) {
      log.warn('runner.release', { phase, detail: (result.stdout || result.stderr).trim().slice(0, 200) });
    }
    // Whatever the release said: a session that released its own lock
    // file-only left the deletion for this mirror to commit.
    void this.mirrorLock(phase, 'release');
  }

  /** The lock mirrors in flight, in order — see `mirrorLock`. */
  private lockMirrors: Promise<void> = Promise.resolve();

  /**
   * Mirror a phase's lock to git — the CONSOLE's work, done outside every
   * session's turn (control-tower phase 63, #85). Sessions carry
   * `LOCK_MIRROR_ENV`, so their own claims and releases are file-only;
   * `phase-lock.sh mirror` commits where the lock stands now (the file, or its
   * deletion) as one commit of that path alone, inside the docs root's
   * critical section, and never pulls and never pushes — the next push of the
   * docs root carries it.
   *
   * Chained and never awaited by its callers: a boarding must not wait on the
   * docs root's hooks, and a claim's mirror must land before its release's.
   * Never fatal — an unmirrored lock is still on disk, where every reader on
   * this machine looks, and the next mirror of that phase commits it.
   */
  protected mirrorLock(phase: number, verb: 'claim' | 'release'): Promise<void> {
    const state = this.state;
    if (!state?.slug) return this.lockMirrors;
    const opts = { scriptsDir: this.deps.scriptsDir, root: state.root, mcpServers: this.deps.mcpIds?.() };
    const asked = this.now().getTime();
    this.lockMirrors = this.lockMirrors.then(async () => {
      const result = await runOutsidePool(opts, 'phase-lock.sh', [state.slug, 'mirror', String(phase)]);
      const detail = (result.stdout + result.stderr).trim().split('\n').pop()?.trim().slice(0, 160) ?? '';
      // One Runner serves every run of its slug, and a mirror can outlast the
      // run that asked for it (the section's wait, a hook-heavy commit): its
      // line belongs to THAT run's journal or to none.
      if (this.state?.id !== state.id) return;
      this.record('phase.lock-mirror', {
        verb,
        ok: result.code === 0 && !/^UNMIRRORED/.test(detail),
        ms: Math.max(0, this.now().getTime() - asked),
        detail,
      }, phase);
    }).catch((error: unknown) => {
      log.warn('runner.lock-mirror', { phase, verb, error: String(error) });
    });
    return this.lockMirrors;
  }

  protected onStream(phase: number, event: StreamEvent): void {
    // Liveness first and unconditionally: every event is evidence the session
    // is alive, including the ones nothing below cares about.
    const lane = this.lanes.get(phase);
    if (lane) {
      applyEvent(lane.signals, event, this.now().getTime(), this.verifyEnv());
      // #28: the attempt window's first tool call — `timeToFirstToolMs`.
      if (event.kind === 'tool' && this.state) noteFirstTool(phaseRecord(this.state, phase), this.now().toISOString());
      // The moment the session became unreachable, and why (control-tower
      // phase 109, #170): what a refused steer names, and the journal's record
      // of a live session going deaf — there was none, so nobody could say why.
      if (event.kind === 'input-closed') {
        lane.inputClosed = { at: event.at, cause: event.cause };
        this.record('phase.input-closed', {
          cause: event.cause, pid: lane.pid ?? lane.handle?.pid ?? null,
          sessionId: this.state?.phases[String(phase)]?.sessionId ?? null,
        }, phase);
      }
      // The commits this lane's own git printed — what the scope-drift credit
      // may name as the phase's (control-tower phase 63, #88).
      if (event.kind === 'tool-result' && event.commits?.length) {
        const own = lane.sessionCommits ?? (lane.sessionCommits = new Set());
        for (const sha of event.commits) own.add(sha);
      }
      // The live per-attempt spend. The CLI reports a running total on every
      // `result`, so this is a replace and not an addition — see `Lane.spentUsd`
      // for why `record.costUsd` cannot answer the question this one does.
      if (event.kind === 'result' && typeof event.costUsd === 'number') {
        lane.spentUsd = event.costUsd;
        // …less what a resumed conversation had already booked (`liveCostBase`).
        lane.sessionUsd = Math.max(0, event.costUsd - (lane.liveCostBase ?? 0));
      }
      // The live wall's evidence is CONSECUTIVE, by the same rule the stall
      // signal uses: one turn, token or tool call between two 429s means the
      // watchdog got through, and a wall the CLI is absorbing must never
      // accumulate toward killing a session that is working.
      if (isProductiveEvent(event)) {
        delete lane.limitHits;
        // …and the session's own declaration is spent HERE — by the session
        // producing something, not by the boarding that hoped it would (R1).
        // Boarding used to delete `record.declared` before the spawn, so a
        // resume that queued, capped or failed to spawn lost the testimony for
        // good: the watch-landed resume's whole point is to hand the session
        // back its own declared wait, and the console threw it away one line
        // before finding out whether the session existed.
        //
        // And not by ANY productive event either (WAI-4): a turn or a `git
        // status` proves the session exists, not that it said anything about
        // the wait — the measured resume spent its declaration 0.8 s in and
        // then produced nothing, leaving a record that could no longer say what
        // it had been waiting for. A commit or a declared outcome is the
        // session speaking to it (`isDurableProgress`).
        if (this.state && isDurableProgress(event)) {
          const record = phaseRecord(this.state, phase);
          const spent = consumeDeclaration(record, 'session-productive');
          if (spent) {
            this.record(DECLARATION_CONSUMED_EVENT, { ...spent }, phase);
            this.persist();
          }
        }
      }
    }

    // ...and the same fact to the session registry, which has no other way to
    // learn it for a lane. Every event, `retry` included: the clock this feeds
    // is a PRESENCE clock (24 hours to `unknown`, a week to a prune), not a
    // silence clock — the thresholds that must not be reset by the CLI's own
    // watchdog are the ones in `liveness.ts` above, and they still are not.
    // `step` is the only event that means a turn ended; see `SessionRecord
    // .streamTurns` for why it is counted apart from the hook's `turns`.
    if (this.deps.sessionHeartbeat && this.state) {
      const sessionId = event.kind === 'init' ? event.sessionId : phaseRecord(this.state, phase).sessionId;
      if (sessionId) this.deps.sessionHeartbeat(sessionId, { turnEnded: event.kind === 'step' });
    }

    if (event.kind === 'retry') this.record('phase.api-retry', { ...event }, phase);

    // What the CLI's own permission system refused, one line per denial
    // (SES-5; chapter 09 row 2): the stream's announcement when it made one —
    // the only form that carries a reason — else the result's authoritative
    // ledger; `spawn.ts` never emits one denial twice. Distinct from
    // `phase.tool-denied` (the console's OWN hook said no) and from
    // `phase.tool-refused` (the words the session read when the CLI did).
    // The session's reply to an operator's question, beside the question (TRS-6).
    if (event.kind === 'answer') this.noteAnswer(phase, event);
    if (event.kind === 'permission-denied') {
      this.record('phase.permission-denied', {
        tool: event.tool,
        source: event.source,
        ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
        ...(event.target ? { target: event.target } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.reasonType ? { reasonType: event.reasonType } : {}),
      }, phase);
      // …and the wall it is, on the lane's record (control-tower phase 135):
      // a tool outside the allow list, an MCP tool not granted, the CLI's copy
      // of a deny rule — what a permission declaration then cites (G5).
      const wall = wallOfCliDenial(event, this.now().toISOString());
      if (wall) this.noteWall(phase, wall);
    }
    if (event.kind === 'tool-result' && event.refused) {
      this.record('phase.tool-refused', {
        tool: event.tool ?? 'tool', toolUseId: event.id,
        ...(event.target ? { target: event.target } : {}),
        detail: event.detail ?? '',
      }, phase);
    }

    // The task channel, tailed on the events that mean a tool call finished or
    // a turn ended — which is exactly when `phase-tasks.sh` has just run. No
    // timer: a session writing its list is a session making tool calls, so the
    // trigger is already on the wire, and a silent session has nothing to read.
    if (event.kind === 'tool-result' || event.kind === 'step') {
      if (this.drainTasks(phase)) this.persist();
    }

    // The CLI's OWN task tools, folded into the same record as the script's
    // channel and through the same `foldTaskEvent`.
    //
    // They were carried to the browser and nowhere else: `onStream` had no
    // case for either, so nothing about a session's task list ever became
    // server state — not in the record, not in the journal, not on any surface
    // outside one React hook. That is why a reload showed an empty panel even
    // in the days when the tools still fired. Kept as a FALLBACK rather than
    // removed: the tools may come back, another harness may provide them, and
    // a session that has them should not have a worse list than one that does
    // not.
    if ((event.kind === 'task' || event.kind === 'todos' || event.kind === 'tool-result') && this.state) {
      const record = phaseRecord(this.state, phase);
      const before = record.tasks ?? [];
      let after = before;
      if (event.kind === 'task') {
        after = foldTaskEvent(before, event) as typeof before;
      } else if (event.kind === 'todos') {
        // A whole-list rewrite REPLACES. An empty array is a legitimate write —
        // the session finished or abandoned its plan — so it clears rather than
        // being read as "nothing to see" (r2 client-15, the same fix the
        // browser's fold carries).
        const listed = tasksFromList(event.items);
        if (listed && (listed.length || before.length)) after = listed;
      } else {
        after = adoptTaskId(before, event.id, event.detail) as typeof before;
      }
      if (after !== before) {
        record.tasks = after;
        const summary = taskSummary(after);
        this.record('phase.tasks', { total: summary.total, done: summary.done, active: summary.active }, phase);
        this.persist();
      }
    }

    // Which attached servers this phase actually reached for. Counted here
    // because the stream is already being read and the name is already parsed;
    // the alternative is asking the operator to guess, which is how a run ends
    // up paying for six servers it used two of.
    if (event.kind === 'tool' && event.name.startsWith('mcp__') && this.state) {
      const rest = event.name.slice(5);
      const split = rest.indexOf('__');
      if (split > 0) {
        const record = phaseRecord(this.state, phase);
        const id = rest.slice(0, split);
        record.mcpCalls = { ...record.mcpCalls, [id]: (record.mcpCalls?.[id] ?? 0) + 1 };
      }
    }

    // What the session says it is running on, which is not always what we
    // asked for: `--fallback-model` demotes in-place and tells nobody. A
    // journal that records the request rather than the reality is a journal
    // that cannot explain why a phase went badly.
    if (event.kind === 'init' && this.state) {
      const record = phaseRecord(this.state, phase);
      let changed = false;
      // The session id used to be learned only when the spawn resolved, which
      // is far too late for anything that acts on a session while it is alive:
      // a freeze checkpointed mid-phase had nothing to hand to `--resume`, and
      // the checkpoint on disk carried an empty id. The `init` message has it
      // within the first second, so take it there.
      if (event.sessionId && record.sessionId !== event.sessionId) {
        record.sessionId = event.sessionId;
        // Which account's config dir this transcript is being written into —
        // the fact a cross-account resume needs to find the file later.
        if (this.state.accountId) record.sessionAccountId = this.state.accountId;
        else delete record.sessionAccountId;
        // Rewrites `children[phase]` and the mirror together, so a checkpoint
        // taken a moment later can hand this id to `--resume` whichever of the
        // two a reader consults.
        if (this.lanes.has(phase)) this.syncMirror();
        else if (this.state.child?.phase === phase) this.state.child.sessionId = event.sessionId;
        changed = true;
      }
      // WHICH task tools this session was given — the fact whose absence went
      // unnoticed for ten days because the init event counted tools instead of
      // naming them. An empty list here is B1 recurring, and the session's own
      // `scripts/phase-tasks.sh` channel is what carries the list regardless.
      if (Array.isArray(event.toolNames)) {
        this.record('phase.tools', {
          count: event.tools ?? event.toolNames.length,
          taskTools: TASK_TOOLS.filter((name) => event.toolNames!.includes(name)),
        }, phase);
      }
      if (event.model && record.actualModel !== event.model) {
        record.actualModel = event.model;
        if (record.model && !event.model.includes(record.model)) {
          this.record('phase.model-differs', { asked: record.model, running: event.model }, phase);
        }
        changed = true;
      }
      if (event.model && this.noteResolvedModel(phase, record, event.model)) changed = true;
      if (changed) this.persist();
      // A PINNED phase whose session the CLI started on another model is ended
      // here, at its init frame, before it spends (#91).
      if (event.model) this.holdPinnedModel(phase, record, event.model);
    }

    // The account this reading is about: the one the lane's session spends
    // (control-tower phase 92), else the run's.
    const spendsOn = (() => {
      const id = lane?.accountId ?? this.state?.accountId ?? 'default';
      return id === 'default' ? undefined : id;
    })();
    // Do credits carry that account past the window (control-tower phase 93,
    // #146)? Never when this very reading says they stopped.
    let carried = false;
    if (event.kind === 'limits' && this.state) {
      this.state.limits = {
        status: event.status,
        window: event.window,
        utilization: event.utilization,
        ...(event.utilizationPct !== undefined ? { utilizationPct: event.utilizationPct } : {}),
        resetsAt: event.resetsAt,
        at: new Date().toISOString(),
        ...(event.usingOverage !== undefined ? { usingOverage: event.usingOverage } : {}),
        ...(event.overageStatus ? { overageStatus: event.overageStatus } : {}),
        ...(event.overageDisabledReason ? { overageDisabledReason: event.overageDisabledReason } : {}),
      };
      // The session's word on credit goes to the account it spends — a refusal
      // stops the carry there at once, before any poll (#146).
      if (event.usingOverage !== undefined || event.overageStatus || event.overageDisabledReason) {
        try {
          this.deps.noteSessionCredit?.(spendsOn, {
            ...(event.usingOverage !== undefined ? { usingOverage: event.usingOverage } : {}),
            ...(event.overageStatus ? { overageStatus: event.overageStatus } : {}),
            ...(event.overageDisabledReason ? { overageDisabledReason: event.overageDisabledReason } : {}),
            ...(event.overageResetsAt !== undefined ? { overageResetsAt: event.overageResetsAt } : {}),
          });
        } catch { /* the account's bookkeeping never breaks a session's stream */ }
      }
      const stopped = event.overageStatus === 'rejected' || Boolean(event.overageDisabledReason);
      try { carried = !stopped && this.deps.creditCarries?.(spendsOn) === true; } catch { carried = false; }
      // Worth a journal line only when the account is being warned, not on
      // every routine "you are fine" heartbeat.
      if (event.status !== 'allowed') this.record('run.usage-window', { ...event });
      this.decideOnUsageWarning(event, carried ? spendsOn ?? 'default' : null);
      this.persist();
    }

    // The live wall, LAST — after `state.limits` above has taken this event,
    // so a pause that quotes the reset time quotes the one that just arrived
    // rather than the one before it. A rate limit used to be read only from a
    // session's CORPSE (`state.onLimit` is consulted inside
    // `switch (disposition.kind)`, after `await spawn(…)` resolves), and with
    // the CLI's retry watchdog on a 429 the child never exits — so the one
    // policy that existed for exactly this wall was unreachable for exactly
    // this wall.
    if (lane && (event.kind === 'retry' || event.kind === 'limits')) {
      const walled = event.kind === 'limits'
        // The CLI's own structured verdict on the account's window — by the
        // WORD, and by the NUMBER (ACT-7). `rejected`, the one word this arm
        // used to act on, arrived zero times in 7 326 lifetime events; what
        // arrives is `allowed_warning` with a utilization. So a warning is a
        // heads-up (journalled as `run.usage-window`, decided at `ALERT_PCT`)
        // right up to `WALL_PCT`, where the meter itself says the window is
        // spent and a request going through is the exception, not the rule.
        // Compared in PERCENT (`utilizationPct`), never the wire's fraction.
        // With credits carrying the account (#146) the number is no wall, and
        // neither is a `rejected` window the CLI says it is paying past on
        // overage — only a refusal of the credit itself is.
        ? carried
          ? event.status === 'rejected' ? event.usingOverage !== true
            : event.status !== 'allowed' && event.status !== 'allowed_warning'
          : (event.status !== 'allowed' && event.status !== 'allowed_warning')
            || (typeof event.utilizationPct === 'number' && event.utilizationPct >= WALL_PCT)
        // A retry the CLI categorised as a rate limit. `overloaded` is
        // capacity rather than quota and another ACCOUNT does not fix it —
        // that one stays the model ladder's business, on exit, as it was.
        : event.category === 'rate_limit' || event.category === 'rate_limit_error';
      if (walled) {
        this.liveWall(lane, phase, event.kind,
          event.kind === 'limits'
            ? `${event.status}${typeof event.utilizationPct === 'number' ? ` at ${Math.round(event.utilizationPct)} %` : ''}`
            : event.category,
          event.kind === 'retry' ? event.retryDelayMs : undefined);
      }
    }

    this.emit('stream', { phase, ...event });
  }

  /** The `run:window:reset` warnings this runner has already decided about. */
  private usageDecided = new Set<string>();

  /**
   * An in-session usage warning past the alert threshold, DECIDED rather than
   * merely recorded (SES-9).
   *
   * The CLI's `rate_limit_event` says `allowed_warning`, with the window's
   * utilization, long before it says `rejected` — and in the audit's six plans
   * 3 150 such lines were journalled, every one of them `allowed_warning`, up
   * to 0.99, and acted on by nothing: the live wall excludes the status by
   * design and no threshold existed. The run's `onLimit` decides here what the
   * warning calls for, once per window and reset, against `ALERT_PCT` — the
   * percent the account meters announce at, compared in their unit
   * (`utilizationPct`), never the wire's fraction.
   *
   * The action itself is carried out where it can be: the switch and the park
   * at `WALL_PCT` by the live wall, because enacting either at 95 % would give
   * up an account with 5 % left. What this decision DOES enact is the usage
   * brake (autopilot-token-drain phase 6, H6) — unless the run can move to an
   * account with headroom, the account admits no new lane while one is live on
   * it (`Scheduler.brake`). Run deadaff9 journalled `enacted: false` at 95 %
   * and went on boarding lanes: 90 → 99 % in 23 minutes. So the line says what
   * was done: `enacted` is true only for a `throttle` the brake carries out,
   * `brake` whether the account is braked, `headroom` which account a `switch`
   * could move to (null: none), and `nonRunSessions` who else is spending it.
   */
  private decideOnUsageWarning(event: Extract<StreamEvent, { kind: 'limits' }>, carriedOn: string | null = null): void {
    const state = this.state;
    if (!state) return;
    // Every reading may end a brake; only a warning past the threshold decides.
    this.noteUsageReading(event);
    if (event.status !== 'allowed_warning') return;
    const pct = event.utilizationPct;
    if (typeof pct !== 'number' || pct < ALERT_PCT) return;
    const key = `${state.id}:${event.window ?? 'window'}:${event.resetsAt ?? 'unknown'}`;
    if (this.usageDecided.has(key)) return;
    // Credits carry the account past this window (control-tower phase 93,
    // #146): nothing to switch away from and nothing to brake. Said once per
    // window and reset — and NOT marked decided, so the first warning after
    // the credits stop is decided as ever.
    if (carriedOn) {
      const said = `carried:${key}`;
      if (!this.usageDecided.has(said)) {
        this.usageDecided.add(said);
        this.record('run.usage-carried', {
          accountId: carriedOn, utilizationPct: pct, thresholdPct: ALERT_PCT,
          ...(event.window ? { window: event.window } : {}),
          ...(event.resetsAt !== undefined ? { resetsAt: event.resetsAt } : {}),
          ...(event.usingOverage !== undefined ? { usingOverage: event.usingOverage } : {}),
        });
      }
      return;
    }
    this.usageDecided.add(key);
    const policy = state.onLimit ?? 'wait';
    // The same reading `liveWall` gives the policy: `switch` always moves, and
    // `wait` moves too unless automatic switching is off, when all it can do
    // is hold new work for the window.
    const action: UsageDecisionAction = policy === 'pause'
      ? 'park'
      : policy === 'switch' || this.deps.autoAccountSwitch?.() !== false ? 'switch' : 'throttle';
    // Where a switch could go — the forecast picker's answer (control-tower
    // phase 92, #100 ask 3): an account that carries the work past THIS
    // window's reset and clears the run's own floor. Taken at the lanes'
    // boundary: a live session spends what is left here, and every next spawn
    // pays with the new account. `why` says what stood in the way when it was not.
    let headroom: string | null = null;
    let enacted = false;
    let why: string | null = null;
    if (action === 'switch') {
      const from = state.accountId;
      const resetsMs = typeof event.resetsAt === 'number' && Number.isFinite(event.resetsAt) ? event.resetsAt * 1000 : null;
      try {
        if (this.deps.switchCandidates) {
          const plan = this.deps.switchCandidates(from, state.model, { until: resetsMs, pool: accountPool(state), floors: this.accountFloors() });
          headroom = plan.ranked.find((id) => id !== (from ?? 'default')) ?? null;
          if (!headroom) {
            why = plan.declined.length
              ? `no account carries the work past this window's reset — ${plan.declined.map((row) => `${row.id}: ${row.why}`).join('; ')}`
              : 'no other account in the run\'s pool has room';
          }
        } else {
          const next = this.deps.pickAccount?.(from, state.model) ?? null;
          headroom = next && next !== (from ?? 'default') ? next : null;
          if (!headroom) why = 'no other account has headroom';
        }
      } catch {
        headroom = null;
        why = 'the switch picker could not answer';
      }
      if (headroom) {
        const moved = this.switchAccount(headroom, USAGE_DECISION_ACTOR, {
          when: 'boundary', origin: { resetsAt: resetsMs, reason: `${event.window ?? 'a window'} at ${Math.round(pct)} %` },
        });
        enacted = moved.ok;
        if (!moved.ok) why = moved.reason;
      }
    }
    const brake = action === 'switch' && enacted ? false : this.engageUsageBrake(event, pct);
    // Who else is on the window: counted where a hook named the account, and
    // `unknown` — never zero — when this runner cannot see sessions at all.
    let nonRunSessions: AccountSessions | 'unknown' = 'unknown';
    try { nonRunSessions = this.deps.nonRunSessions?.() ?? 'unknown'; } catch { nonRunSessions = 'unknown'; }
    this.record('run.usage-decision', {
      action,
      thresholdPct: ALERT_PCT,
      utilizationPct: pct,
      ...(event.window ? { window: event.window } : {}),
      ...(event.resetsAt !== undefined ? { resetsAt: event.resetsAt } : {}),
      policy,
      enacted: action === 'throttle' ? brake : enacted,
      brake,
      ...(action === 'switch' ? { headroom, ...(enacted ? { when: 'boundary' } : {}), ...(why ? { why } : {}) } : {}),
      nonRunSessions,
    });
  }

  /**
   * Brake the run's account (`Scheduler.brake`). True when the account is braked
   * after this — engaged now, or already by an earlier reading, here or in
   * another run of this console — and false when there is no scheduler to hold
   * anything. `run.usage-brake` is written only by the reading that engaged it.
   */
  private engageUsageBrake(event: Extract<StreamEvent, { kind: 'limits' }>, pct: number): boolean {
    const state = this.state!;
    const scheduler = this.deps.scheduler;
    if (!scheduler) return false;
    const untilMs = typeof event.resetsAt === 'number' && Number.isFinite(event.resetsAt) ? event.resetsAt * 1000 : null;
    const engaged = scheduler.brake(state.accountId, { untilMs, pct, ...(event.window ? { window: event.window } : {}) });
    if (engaged) {
      this.record('run.usage-brake', {
        accountId: state.accountId ?? 'default',
        utilizationPct: pct,
        thresholdPct: ALERT_PCT,
        ...(event.window ? { window: event.window } : {}),
        until: untilMs === null ? null : new Date(untilMs).toISOString(),
        live: scheduler.liveOn(state.accountId),
      });
    }
    return true;
  }

  /**
   * The brake's release rule, applied to every usage reading of the run's
   * account: a reading of the brake's own window under `WARN_PCT` releases it
   * (`below-warn`), and the first reading after its reset clears the lapsed
   * entry (`reset` — the scheduler already stopped honouring it at the reset;
   * this is where the run's journal learns so). A reading of ANOTHER window
   * says nothing about this one and releases nothing.
   */
  private noteUsageReading(event: Extract<StreamEvent, { kind: 'limits' }>): void {
    const state = this.state;
    const scheduler = this.deps.scheduler;
    if (!state || !scheduler) return;
    const accountId = state.accountId ?? 'default';
    const now = this.now().getTime();
    const engaged = scheduler.brakeOf(state.accountId);
    if (!engaged) {
      const lapsed = scheduler.releaseBrake(state.accountId);
      if (lapsed) this.record('run.usage-brake-released', { accountId, reason: 'reset', heldMs: now - lapsed.since });
      return;
    }
    if (engaged.window && event.window && engaged.window !== event.window) return;
    if (typeof event.utilizationPct !== 'number' || event.utilizationPct >= WARN_PCT) return;
    scheduler.releaseBrake(state.accountId);
    this.record('run.usage-brake-released', {
      accountId, reason: 'below-warn', utilizationPct: event.utilizationPct, heldMs: now - engaged.since,
    });
  }

  /**
   * Apply the run's `onLimit` to a wall that is happening RIGHT NOW, to a
   * child that has not exited and may never exit.
   *
   * The measured failure this exists for: a session hit the five-hour wall at
   * 0.97 utilization and entered the CLI's own retry watchdog, which retried
   * every thirty seconds indefinitely. `state.onLimit` was read in exactly one
   * place — inside `switch (disposition.kind)`, after `await spawn(…)`
   * resolves — so `switch`, the policy whose entire purpose is that wall, was
   * unreachable for that wall. The lane sat there for three and a half hours.
   *
   * Three rules, each of which is what keeps this from being worse than the
   * bug it fixes:
   *
   *   - **the same switch rule as the two post-exit sites.** `switch` always
   *     moves; `wait` moves when `autoAccountSwitch` is on, because `wait`
   *     cannot wait out a wall with no parseable reset; `pause` keeps its
   *     word. Those two sites were deliberately unified once already, and a
   *     third that disagreed would put us back where whether a wall moved a
   *     run depended on which code path noticed it;
   *   - **debounced.** `LIMIT_RETRY_BURST` hits inside `LIMIT_RETRY_WINDOW_MS`,
   *     where anything productive between two retries clears the count. One
   *     unlucky 429 the watchdog absorbs never reaches here;
   *   - **nowhere to go means do nothing — while doing nothing can pay.**
   *     `trySwitchAccount` answering false leaves the session exactly as it
   *     was — still retrying, still able to succeed — because killing a child
   *     that has no better account to move to only loses work. The post-exit
   *     path still settles it if the child ever does exit. But when the wall's
   *     reset is further off than `LIMIT_ACTION_COOLDOWN_MS`, no retry can get
   *     through before it, and the first burst waits on the window at once
   *     (`escalateLiveWall`, `trigger: 'far-reset'`) — P2 of run deadaff9 sat
   *     through 47 retries and two `none` decisions, 13:41 → 14:04, on a
   *     reset 2 h 48 min away (autopilot-token-drain H6).
   *
   * `retryDelayMs` is the burst's own retry event's, when it carried one: the
   * reset's evidence when no `rate_limit_event` has reported the window's.
   */
  private liveWall(lane: Lane, phase: number, source: 'retry' | 'limits', detail?: string, retryDelayMs?: number): void {
    const state = this.state;
    if (!state) return;
    // Nothing to act on, or somebody with more authority already has: the lane
    // is ending, an operator holds it frozen, or the run is stopping.
    if (lane.checkpointed || lane.stopped || lane.frozen) return;
    if (this.stopRequested || this.abort?.signal.aborted || state.halt) return;
    if (state.status === 'pausing' || state.status === 'halting' || state.status === 'stopping') return;

    const now = this.now().getTime();
    if (lane.limitActedAt !== undefined && now - lane.limitActedAt < LIMIT_ACTION_COOLDOWN_MS) return;

    const hits = (lane.limitHits ??= []);
    hits.push(now);
    while (hits.length && now - hits[0] > LIMIT_RETRY_WINDOW_MS) hits.shift();
    // One threshold for both sources. A `limits` rejection is the stronger
    // evidence of the two and could arguably act alone, but a rejection never
    // arrives without the retries that follow it, so the burst is reached in
    // seconds either way — and one rule is one thing to reason about.
    if (hits.length < LIMIT_RETRY_BURST) return;

    const record = phaseRecord(state, phase);
    const reason = `rate limited mid-session (${detail ?? source}) — `
      + `${hits.length} rate-limit events in ${Math.round((now - hits[0]) / 1000)}s with no work between them`;
    const policy = state.onLimit ?? 'wait';
    const wantSwitch = policy === 'switch'
      || (policy === 'wait' && this.deps.autoAccountSwitch?.() !== false);

    // The wall is the ACCOUNT's fact before it is this run's move (ACT-5):
    // marked machine-wide under the window's own name, with the reset the CLI
    // reported when it did, BEFORE any switch — so `pickAccount` on the next
    // burst, here or in another console, never sends the run straight back.
    // The live wall used to be the one mover that skipped this, and 16 of 17
    // lifetime switches were a reciprocal A→B→A pair.
    const reported = typeof state.limits?.resetsAt === 'number' && Number.isFinite(state.limits.resetsAt)
      && state.limits.resetsAt * 1000 > now
      ? new Date(state.limits.resetsAt * 1000) : null;
    // No window reported, but the CLI's own retry says how long to stay away:
    // past the action cooldown that is the window's reset, not a backoff (a
    // backoff is seconds), and the account is walled on it rather than on a
    // guessed cool-down. In run deadaff9 the two agreed to the second.
    const delayed = !reported && typeof retryDelayMs === 'number' && Number.isFinite(retryDelayMs)
      && retryDelayMs > LIMIT_ACTION_COOLDOWN_MS
      ? new Date(now + retryDelayMs) : null;
    const resetsAt = reported ?? delayed;
    // The account THIS session spends (control-tower phase 92): a switch taken
    // at the lanes' boundary — an enacted usage decision — has already moved the
    // run, and the wall is the old account's, never the one the run moved to.
    const laneAccount = lane.accountId ?? state.accountId ?? 'default';
    const left = this.leaveAccount(phase, {
      kind: 'usage', bucket: state.limits?.window ?? LEARNED_WALL_BUCKET, resetsAt, reason, by: 'live-wall',
    }, laneAccount === 'default' ? undefined : laneAccount);

    if (wantSwitch && laneAccount !== (state.accountId ?? 'default')) {
      // The run is already on another account: this lane was left to finish
      // where it was, and the wall ends that. Checkpointed with `carryOn`, its
      // next attempt spawns under the run's account.
      lane.limitActedAt = now;
      hits.length = 0;
      this.record('phase.live-wall', { action: 'switch', source, detail: detail ?? null, policy, reason, movedAt: 'boundary' }, phase);
      this.checkpointLane(lane, reason, { endedBy: 'account-switch' });
      this.haltSignal.dispatchEvent(new Event('wake'));
      this.persist();
      this.emit('run', { state });
      return;
    }

    if (wantSwitch && this.trySwitchAccount(phase, record, reason, record.model ?? state.model, left?.until ?? resetsAt)) {
      lane.limitActedAt = now;
      hits.length = 0;
      this.record('phase.live-wall', { action: 'switch', source, detail: detail ?? null, policy, reason }, phase);
      // `carryOn: true` — the next attempt spawns under the account that can
      // pay, resuming the same session when its transcript came along.
      this.checkpointLane(lane, reason, { endedBy: 'account-switch' });
      // The lane may be asleep on a queue or a window rather than in `spawn`;
      // the same wake the operator's switch verb uses ends that sleep.
      this.haltSignal.dispatchEvent(new Event('wake'));
      this.persist();
      this.emit('run', { state });
      return;
    }

    if (policy === 'pause') {
      lane.limitActedAt = now;
      hits.length = 0;
      // The `waitOutWindow('pause')` shape, written here because that helper
      // lives inside the attempt loop and this runs on the stream callback:
      // the phase goes back to `pending` with a session to resume, and the run
      // stops for a person with the reset time on it when the CLI told us one.
      this.checkpointLane(lane, reason, { carryOn: false, endedBy: 'checkpoint' });
      const resetsAt = state.limits?.resetsAt;
      const at = typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? new Date(resetsAt * 1000) : null;
      state.waitUntil = at ? at.toISOString() : null;
      setRunState(state, 'paused', { kind: 'usage-limit', until: state.waitUntil });
      state.finishedReason = at
        ? `usage limit hit mid-session — resets ${at.toLocaleString()}. `
          + 'Continue now under another account, or wait for the window.'
        : 'usage limit hit mid-session, with no reset time reported. '
          + 'Continue under another account, or once the window reopens.';
      this.record('phase.live-wall', { action: 'pause', source, detail: detail ?? null, policy, reason }, phase);
      this.record('run.limit-paused', { until: state.waitUntil, reason }, phase);
      this.haltSignal.dispatchEvent(new Event('wake'));
      this.persist();
      this.emit('run', { state });
      return;
    }

    // `wait` with auto-switch off, or a switch with nowhere to go. Journalled
    // once per cooldown so the run's own record says the console SAW the wall
    // and had no move — the difference between a policy that did not fire and
    // one that fired and found the door shut.
    //
    // …but not for ever (ACT-6: 85 of 102 lifetime walls ended here, 52 under
    // `switch`, and nothing escalated — the child sat in the CLI's retry loop
    // and nobody was told). After `LIMIT_NONE_MAX` such decisions inside
    // `LIMIT_NONE_WINDOW_MS`, the wall is real and the account has no move, so
    // the run does one of three things instead of a third `none`: waits out
    // the window when a reset is known (the retry-storm park's own shape, the
    // phase `waiting` on the clock and the park poke bringing it back), or
    // parks with the one errand — and announces under `limits` either way.
    // The climb is recorded in the `phase.situation`/`phase.rung` vocabulary
    // so the ladder card exists for it.
    lane.limitActedAt = now;
    hits.length = 0;
    const nones = (lane.limitNones ??= []);
    nones.push(now);
    while (nones.length && now - nones[0] > LIMIT_NONE_WINDOW_MS) nones.shift();
    // A reset past the cooldown cannot be retried through: two more `none`
    // decisions ten minutes apart would only hold the lane and its lock for
    // twenty minutes of retries before the same wait (H6).
    const farReset = resetsAt !== null && resetsAt.getTime() - now > LIMIT_ACTION_COOLDOWN_MS;
    if (!farReset && nones.length <= LIMIT_NONE_MAX) {
      this.record('phase.live-wall', { action: 'none', source, detail: detail ?? null, policy, reason, nones: nones.length }, phase);
      return;
    }
    this.escalateLiveWall(lane, record, source, detail, policy, reason, left, now,
      farReset ? { trigger: 'far-reset', resetsAt: resetsAt! } : { trigger: 'repeated' });
  }

  /**
   * What the request resolved to, kept on the run (control-tower phase 54,
   * #91): `resolvedModels[<request>]`, and `run.model-resolved {requested,
   * from, to}` the first time a request resolves at all and each time what it
   * resolves to MOVES — so `opus[1m]` turning from Opus 5 into Opus 5.5 under
   * a live plan is one line, not a line per session. Answers whether the run
   * record changed.
   */
  private noteResolvedModel(phase: number, record: PhaseRecord, resolved: string): boolean {
    const state = this.state!;
    const requested = record.model ?? state.model ?? 'default';
    const kept = (state.resolvedModels ??= {});
    const prior = kept[requested];
    if (prior?.resolved === resolved) return false;
    kept[requested] = { resolved, at: this.now().toISOString(), ...(prior ? { from: prior.resolved } : {}) };
    this.record('run.model-resolved', { requested, from: prior?.resolved ?? null, to: resolved }, phase);
    return true;
  }

  /**
   * `**Model policy:** pinned` at the init frame (control-tower phase 54,
   * #91): the session reports the model it is running on before its first
   * call is paid for. Another model than the one the phase pins — an alias
   * that moved, an id the CLI no longer serves as asked, a window dropped —
   * journals `phase.model-mismatch {requested, resolved}`, ends the session
   * and parks the phase with the one errand, instead of spending on a model
   * nobody chose. Under `ladder` the fact is recorded and nothing more.
   */
  private holdPinnedModel(phase: number, record: PhaseRecord, resolved: string): void {
    const state = this.state!;
    const requested = record.model ?? state.model;
    if (!requested || this.modelPolicyOf(phase) !== 'pinned') return;
    if (sameModel(requested, resolved, loadModelsEnv(this.deps.scriptsDir))) return;
    const lane = this.lanes.get(phase);
    if (!lane || lane.checkpointed) return;
    const at = this.now().toISOString();
    const reason = `the phase is pinned to ${requested}, and the CLI started its session on ${resolved}`;
    this.record('phase.model-mismatch', { requested, resolved, sessionId: record.sessionId ?? null }, phase);
    const slot = ((state.recoveries ??= {})[String(phase)] ??= { attempts: 0, lastAt: at });
    const errand: Errand = {
      ...errandFor('blocked-declared', slot.rungs ?? [], phase, at),
      need: `A model this run may pin: it asked for ${requested} and the CLI resolved it to ${resolved}.`,
      how: `Name the model the CLI now serves in the plan's - **Model:** bullet (or scripts/models.env for an alias), `
        + "or set the run's model policy to ladder to accept whatever it resolves to — then Retry the phase.",
    };
    slot.errand = errand;
    this.checkpointLane(lane, reason, { carryOn: false, endedBy: 'checkpoint' });
    record.status = 'parked';
    record.modelMismatch = { requested, resolved, at };
    record.note = `Model mismatch — ${reason}. ${errand.need}`;
    record.endedAt ??= at;
    this.record('phase.errand', { ...errand, label: 'Model mismatch', reason, by: 'drive' }, phase);
    this.emit('phase', { phase, status: 'parked', note: record.note, errand });
    this.persist();
  }

  /**
   * The third `none` (ACT-6). The account has been left (`leaveAccount` ran
   * above), so the earliest reset is what it answered — the wall's own clock
   * when the CLI reported one, the cool-down when it did not — and the run:
   *
   *  - WAITS on it (`wait-window`): the phase is checkpointed and parked on the
   *    window exactly as the retry-storm watchdog parks one — `waiting`,
   *    `parkedUntil`, the run clock synced, the poke armed — so a restart
   *    resumes it and the classifier reads `resource-wall:usage` off the
   *    phase's own note; or
   *  - PARKS with the one errand when there is no clock at all.
   *
   * Announced under `limits` either way, and written in the ladder's words
   * (`phase.situation` → `phase.rung` / `phase.errand`, `by: 'drive'`) so the
   * `switch-account` and `wait-window` rungs the card advertises are rungs
   * that have been climbed rather than words.
   */
  private escalateLiveWall(
    lane: Lane, record: PhaseRecord, source: 'retry' | 'limits', detail: string | undefined,
    policy: string, reason: string, left: LeaveResult | null, now: number,
    cause: { trigger: 'repeated' } | { trigger: 'far-reset'; resetsAt: Date } = { trigger: 'repeated' },
  ): void {
    const state = this.state!;
    const phase = lane.phase;
    const key = 'resource-wall:usage';
    const why = [
      cause.trigger === 'far-reset'
        // The ABSOLUTE reset (control-tower phase 86, #132): a relative "resets
        // in 14 min" stored here read true for fourteen minutes and false for
        // every hour after. Readers re-derive the countdown (`wallReading`).
        ? `a live wall with no account to move to, and the window resets at ${cause.resetsAt.toISOString()} `
          + `(in ${hoursAndMinutes(cause.resetsAt.getTime() - now)} at the park)`
        : `${LIMIT_NONE_MAX + 1} live walls inside ${Math.round(LIMIT_NONE_WINDOW_MS / 60_000)} minutes with no account to move to`,
      reason,
    ];
    record.situation = { key, at: new Date(now).toISOString(), why, by: 'drive' };
    this.record('phase.situation', { situation: key, sub: 'usage', label: 'Resource wall', why, by: 'drive' }, phase);
    const slot = ((state.recoveries ??= {})[String(phase)] ??= { attempts: 0, lastAt: new Date(now).toISOString() });
    // `switch-account` was climbed by `trySwitchAccount` and found nothing;
    // recorded as tried so the errand can say so, then the wait rung.
    accountRung(slot, { situation: key, rung: 'switch-account', at: new Date(now).toISOString(), note: 'no other account had headroom' });
    this.record('phase.rung', {
      situation: key, rung: 'switch-account', params: null, vehicle: 'runner', attempt: slot.attempts, by: 'drive', inline: true,
    }, phase);
    // Nowhere to switch TO is the machine's state, not the remedy's verdict:
    // the rung comes back when an account does (#36).
    this.settleOpenRung(phase, 'failed', 'no other account had headroom', undefined, 'environment');
    // The facade's answer when there is one (the reset it walled on, else its
    // cool-down); with no facade, the reset this burst knew about.
    const until = left?.until ?? (cause.trigger === 'far-reset' ? cause.resetsAt.toISOString() : null);
    if (until && Date.parse(until) > now) {
      accountRung(slot, { situation: key, rung: 'wait-window', at: new Date(now).toISOString(), note: `waits until ${until}` });
      this.record('phase.rung', {
        situation: key, rung: 'wait-window', params: null, vehicle: 'runner', attempt: slot.attempts, by: 'drive',
        inline: true, until,
      }, phase);
      this.checkpointLane(lane, reason, { carryOn: false, endedBy: 'checkpoint' });
      record.status = 'waiting';
      record.parkedUntil = until;
      syncWaitClock(state);
      // "Until at the latest" (control-tower phase 54, #78): the reset bounds
      // the park and nothing more. The account's headroom is re-read on every
      // fresh usage reading, on every spend under it and on a back-off
      // re-probe, and any of them brings the phase back sooner.
      record.usageWall = {
        account: state.accountId ?? 'default',
        bucket: left?.wall?.bucket ?? state.limits?.window ?? LEARNED_WALL_BUCKET,
        latest: until, probes: 0,
      };
      record.parkReason = `${reason}. Waiting until ${until} at the latest, when the window resets — `
        + 'sooner if the account shows headroom again.';
      record.note = record.parkReason;
      record.parkedFrom = new Date(now).toISOString();
      delete record.stall;
      this.record('phase.live-wall', { action: 'wait', source, detail: detail ?? null, policy, reason, until, trigger: cause.trigger }, phase);
      this.deps.onLiveWallEscalated?.(state, phase, { action: 'wait', reason, until });
      this.emit('phase', { phase, status: 'waiting', note: record.parkReason, parkedUntil: until });
      this.armParkPoke(phase, until);
      this.armWallProbe(phase);
      this.persist();
      return;
    }
    // No clock anywhere: the ladder is exhausted, and the one ask stands.
    const errand: Errand = {
      ...errandFor(key, slot.rungs ?? [], phase),
      how: 'Register or sign in another Claude account under Settings ▸ Accounts and switch the run to it; '
        + 'the wall reported no reset time, so nothing here can wait it out.',
    };
    slot.errand = errand;
    this.checkpointLane(lane, reason, { carryOn: false, endedBy: 'checkpoint' });
    record.status = 'parked';
    // The wall's own words lead the note — `USAGE_RE` (`situation.ts`) reads
    // "rate limited" off it, so the classifier answers `resource-wall:usage`
    // from the record alone.
    record.note = `Resource wall — ${reason}. ${errand.need}`;
    record.endedAt ??= errand.at;
    this.record('phase.live-wall', { action: 'park', source, detail: detail ?? null, policy, reason }, phase);
    this.record('phase.errand', { ...errand, label: 'Resource wall', reason, by: 'drive' }, phase);
    this.deps.onLiveWallEscalated?.(state, phase, { action: 'park', reason, until: null });
    this.emit('phase', { phase, status: 'parked', note: record.note, errand });
    this.persist();
  }

  /**
   * The status a lane restores after a wait it initiated (queue, usage window,
   * thaw). Derived from the durable records — `halt` and `pause` — never
   * assumed: writing `running` unconditionally after a wait is how a halt from
   * another lane got erased on a real run (status `running` WITH a halt set,
   * phase admitted 206 ms after the stop).
   */
  protected resumedStatus(): RunStatus {
    const state = this.state!;
    if (state.halt) return 'halting';
    return state.pause ? 'pausing' : 'running';
  }

  /**
   * Why this phase must not board right now, or `null`.
   *
   * Boarding is three subprocesses and possibly a queue wait; every await in it
   * is a window where a pause, a halt from another lane, or a stop can arrive.
   * One predicate, asked at each of those boundaries, so the answer cannot
   * drift between them.
   *
   * A freeze is one of those arrivals and was not one of these answers. The
   * loop's `stopAdmitting` stops the NEXT lane from being admitted, but a lane
   * already past admission and waiting on its scope kept going: it read the
   * board, took its lock, built its boot prompt and spawned a session — under a
   * run whose status, card and badge all said frozen. Refusing here is the
   * semantic this plan picked over the alternative (letting the new lane quietly
   * un-freeze the run): the phase is left `pending` and startable, so the thaw
   * is what starts it, which is what the operator asked for by freezing.
   */
  protected boardingBlocked(): 'stopped' | 'halted' | 'pause' | 'frozen' | null {
    const state = this.state!;
    if (this.abort?.signal.aborted || this.stopRequested) return 'stopped';
    if (state.halt) return 'halted';
    if (state.status === 'pausing') return 'pause';
    if (state.status === 'frozen') return 'frozen';
    return null;
  }

  /**
   * Settle ONE PHASE with its reason and kind, leaving the run alone.
   *
   * The other half of `halt()`. A halt kind is either a fact about one phase
   * (this verification failed, this session wrote no handoff, this recovery
   * could not run) or a fact about the run (the money is gone, the plan file
   * will not parse, the runner itself threw) — `shared/recovery-model.js`
   * decides which, exhaustively. Until 2026-08-30 both wrote `state.halt`, so
   * one phase's red verification stopped the run and DRAINED every queued
   * sibling lane: `phase.not-started` "the run was stopped / halted while this
   * phase waited for its scope" 125 times in the corpus, re-read later as
   * `never-started` and answered by re-boarding phases that had never had a
   * chance.
   *
   * Precisely what changed. **Queued and in-flight siblings are no longer
   * drained:** `boardingBlocked()` keys on `state.halt`, which a phase-level
   * kind leaves empty, so a lane already waiting on its scope keeps its place
   * and boards instead of being written off `phase.not-started`. That half holds
   * for every phase-level kind, whatever the autonomy, and it is what exit
   * criterion 3 measures (`test/runner-parallel.test.ts`).
   *
   * Whether the loop then admits a NEW candidate is NOT uniform, and the two
   * halves are worth keeping straight:
   *
   *   - the **verification** path (`drivePhase` → `confirmed()`, so
   *     `verify-failed` and a rejected `needs-human` sign-off) returns the run's
   *     autonomy: `keep-going` moves on to the other candidates, and
   *     `halt-on-everything` stops, which is what asking for it means.
   *   - every OTHER site that reaches here — `no-handoff`, `phase-crashed`,
   *     `worktree-merge`, `recovery-failed` — still returns `carryOn: false`,
   *     which sets `stopping` and breaks the loop once the lanes have drained.
   *     Widening those is a separate decision, and not this phase's.
   *
   * What still stops the run is the STREAK. A single failure is a phase's
   * business; N in a row is the plan's, and `failure-streak` is run-level, so a
   * genuinely broken plan halts exactly as it did — just after the second or
   * third phase rather than the first.
   */
  protected settlePhase(phase: number, reason: string, kind: HaltKind): void {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    // A recheck that met the SAME ending is not a new fact (RCV-4): the halt
    // keeps its clock, no second `phase.halted` is written, and the streak is
    // not asked — a recovery that spawned nothing failed no attempt. The reason
    // is prose that legitimately varies (the closeout note rides in it), so
    // the KIND is the identity. `runRecovery` reports the verdict.
    if (this.rechecking === phase && record.halt?.kind === kind) return;
    record.halt = { at: new Date().toISOString(), reason, phase, kind };
    // The card's sentence, when the caller did not already write a better one.
    record.note ??= reason;
    // A new ending is a new fact at EITHER level: a resolution recorded about an
    // earlier stop must not dismiss this one's card. `halt()` has always done
    // this; a phase-level ending that skipped it let a stale "superseded" note
    // silently swallow the next real failure. `reopenedAt` deliberately stays —
    // it is a person's veto on auto-resolution, never re-inferred away.
    state.resolved = null;
    this.record('phase.halted', { reason, kind }, phase);
    this.emit('phase', { phase, status: record.status, note: record.note });
    // …and the run's own bound, asked HERE because most of the call sites that
    // charge `consecutiveFailures` used to rely on the halt itself to stop
    // everything and so never asked. Asked once, in the one place every
    // phase-level ending passes through.
    if (state.consecutiveFailures >= state.maxConsecutiveFailures) {
      this.halt(streakSentence(state), phase, 'failure-streak');
      return;
    }
    this.persist();
    this.emit('run', { state });
    log.warn('runner.phase-halted', { slug: state.slug, runId: state.id, reason, phase, kind });
  }

  protected halt(reason: string, phase: number | undefined, kind: HaltKind, extra: { evidence?: RetirementEvidence } = {}): void {
    const state = this.state!;
    // A phase-level kind settles the phase and returns the run to its other
    // candidates. Every existing call site keeps its shape: what changed is
    // where the ending is WRITTEN, which is what stopped it from draining the
    // siblings. The kind is REQUIRED since LFC-1 — a kindless halt used to
    // "stay run-level, the conservative side of an ambiguity", and the
    // ambiguity was that nothing could classify it afterwards.
    if (phase != null && isPhaseHalt(kind)) { this.settlePhase(phase, reason, kind); return; }
    // The run-level twin of `settlePhase`'s recheck rule (RCV-4).
    if (phase != null && this.rechecking === phase && state.halt?.kind === kind) return;
    // With lanes still live the run is DRAINING, not stopped: `halting` keeps
    // it in IN_FLIGHT (a dead console mid-drain must still pid-check those
    // children) and the drive loop flips it to `halted` when the last lane
    // settles. A verified live run once read `running` WITH a halt attached —
    // admission bookkeeping overwrote `halted` — and this is the honest shape:
    // the halt is a fact the moment it happens, the "stopped" claim only when
    // nothing is running any more.
    setRunState(state, this.lanes.size ? 'halting' : 'halted');
    state.stoppedBy = 'system';
    // `kind` is the machine-readable class the auto-recovery classifier reads;
    // the sentence stays for people. Old records without one are given a word
    // on load (`healLegacyHalt`).
    // The accounts fact rides the halt when the halt's remedy might be "use
    // another account" — so the card can say whether there IS another one,
    // rather than leaving the operator to find it on the accounts page.
    const accounts = ACCOUNT_HALT_KINDS.includes(kind) ? this.deps.accountsUsable?.() : undefined;
    // The budget a budget-shaped halt spent (control-tower phase 14, #40): the
    // run's dollars, or the failure streak — its arithmetic and what spent it
    // ride the halt for the card's raise, and it announces under `budget`.
    const budget = kind === 'budget' ? runBudgetFact(state)
      : kind === 'failure-streak' ? streakFact(state, phase ?? null)
        : undefined;
    state.halt = {
      at: new Date().toISOString(), reason, phase, kind, ...(accounts ? { accounts } : {}),
      // What a credential refusal stood on (#57): the halt card says why.
      ...(extra.evidence ? { evidence: extra.evidence } : {}),
      ...(budget ? { budget } : {}),
    };
    // Wake any lane sleeping on a retry backoff or a usage window: each
    // re-checks `state.halt` on waking and stands down instead of spawning
    // another attempt hours later on a run that has already stopped.
    this.haltSignal.dispatchEvent(new Event('halt'));
    // A new halt is a new fact: a resolution recorded about an EARLIER stop must
    // not dismiss this one's card. `reopenedAt` deliberately stays — it is a
    // person's veto on auto-resolution, and an override a person made is never
    // re-inferred away.
    state.resolved = null;
    // One field the console can always read for "why did this stop", whichever
    // of the several endings it was.
    state.finishedReason = reason;
    this.record('run.halt', { reason, phase, kind, ...(extra.evidence ? { evidence: extra.evidence } : {}) });
    if (budget) this.emit('budget', { phase: phase ?? null, state: 'spent', fact: budget });
    // A halt drains the siblings, so its queue is cancelled with it. Issue #6
    // asked this of `halting` in the same breath as `pausing`, and for the same
    // reason: the sibling lanes are already refused, only the queue and the
    // three surfaces reading it do not know yet.
    //
    // …and it must reach DISK, which is why this is the one place `halt()`
    // writes. `queued` is not in `PHASE_IN_FLIGHT`, so a console that died
    // between here and the drive loop's next write would leave `queued` on disk
    // for phases whose scheduler entries are gone, and `settleInFlightRecords`
    // would not repair it. `persistNow`, not `persist`: the debounce is 150 ms
    // and a halt is exactly the moment a console may not survive — the same
    // reasoning the terminal checkpoint and the WRITTEN marker use.
    if (this.withdrawQueued('halt')) this.persistNow();
    this.emit('run', { state });
    log.warn('runner.halt', { slug: state.slug, runId: state.id, reason, phase });
  }

  /** The line's number in the journal, or null when this run has none yet. */
  protected record(event: string, data?: Record<string, unknown>, phase?: number): number | null {
    const entry = this.journal?.append(event, data, phase);
    this.emit('journal', { event, phase, data });
    return entry?.seq ?? null;
  }

  protected emit(event: string, data: Record<string, unknown>): void {
    // Broadcast and record are the same act. A console opened after the fact,
    // or reloaded mid-phase, replays this file and sees what a console that had
    // been watching all along would have seen.
    try { this.transcript?.append(event, data); } catch { /* never at the cost of the run */ }
    try { this.deps.onEvent?.(`run:${event}`, { runId: this.state?.id, slug: this.state?.slug, ...data }); }
    catch { /* the UI channel must never break the run */ }
  }

  /**
   * Checkpoint the run — coalesced, because 61 call sites funnel through here.
   *
   * Several of them are per-stream-event, and `saveRun` rewrites the whole
   * record with an fsync, so a talkative phase wrote O(N²) bytes. Every save
   * still happens; the ones that would have landed within a debounce of each
   * other land as one, holding the LATEST state rather than an intermediate.
   * `persistNow()` is the escape hatch for the moments that must be durable
   * before the next statement — a halt, a hand-off, a shutdown.
   */
  protected persist(): void {
    if (!this.state) return;
    this.dropFinishedLaneMarks();
    try { saveRunSoon(this.state); } catch (error) { log.warn('runner.persist', { error }); }
  }

  /** Checkpoint synchronously and durably, flushing anything else owed. */
  protected persistNow(): void {
    if (!this.state) return;
    this.dropFinishedLaneMarks();
    try { saveRun(this.state); } catch (error) { log.warn('runner.persist', { error }); }
  }

  /**
   * A sleep that a stop — or a halt from another lane — can cut short, and so
   * can the caller's own `cut`: an outage's wait ends the moment the probe
   * hears the API (control-tower phase 80, #108) rather than at its backstop.
   */
  protected sleep(ms: number, cut?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    // A halt that landed BEFORE this sleep began would otherwise be waited out
    // in full — the wake event below fires once, at halt time, and a listener
    // attached after that hears nothing.
    if (this.state?.halt) return Promise.resolve();
    if (cut?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const signal = this.abort?.signal;
      const halts = this.haltSignal;
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        cut?.removeEventListener('abort', done);
        halts.removeEventListener('halt', done);
        resolve();
      }
      signal?.addEventListener('abort', done, { once: true });
      cut?.addEventListener('abort', done, { once: true });
      // Without this, a run could read `halting` for hours behind a lane that
      // holds no session at all — just a timer waiting for a usage window.
      halts.addEventListener('halt', done, { once: true });
      // And an account switch must not wait out the OLD account's reset: the
      // wake ends the sleep, the loop re-checks, the next spawn pays with the
      // account that can.
      halts.addEventListener('wake', done, { once: true });
    });
  }

  /**
   * Shutdown: write the checkpoint and let the child settle. The console's
   * shutdown budget is generous for exactly this reason — a phase killed
   * halfway through leaves a repo nobody can reason about.
   *
   * Both records say WHY now (SHD-8): `run.console-shutdown` carries the intent
   * (a Shut down press, a Restart, a signal nobody explained), every lane and
   * the run's wait clock it discards; each `run.shutdown-child` names the phase,
   * the session, the grace the ladder gave it and the tool call that was open
   * when it went — a `gh pr merge` cut at 28 s is where "which side of the
   * merge" is the only question that matters, and the record used to be
   * `{pid, how}`.
   */
  protected async checkpointForShutdown(context?: ShutdownContext): Promise<void> {
    if (!this.state) return;
    const intent = context?.intent ?? 'signal';
    const why = intent === 'restart' ? 'restart' : 'console-shutdown';
    const lanes = this.livePhases().map((phase) => {
      const lane = this.lanes.get(phase);
      return { phase, pid: lane?.pid ?? null, sessionId: this.state?.phases[String(phase)]?.sessionId ?? null };
    });
    const clock = waitClockOf(this.state) ?? null;
    this.record('run.console-shutdown', {
      pids: lanes.map((lane) => lane.pid).filter(Boolean),
      phases: this.livePhases(),
      intent,
      ...(context?.reason ? { reason: context.reason } : {}),
      ...(context?.mode ? { mode: context.mode } : {}),
      live: true,
      status: this.state.status,
      lanes,
      waitUntil: clock,
      discards: clock ? `the wait clock due ${clock}` : null,
    });
    this.persist();
    if (!this.livePhases().length && !this.childPid) return;
    this.shuttingDown = true;

    // The bug this whole module was rewritten around.
    //
    // `abort()` reaches `spawn.ts`'s handler, which sends SIGTERM. A lane the
    // operator had frozen cannot act on it — the signal is queued against a
    // stopped process — so `await this.driving` never settled, the console's
    // 120-second shutdown budget expired, and the child was left in state `T`
    // with no console coming back for it. It sat there for three hours.
    //
    // So the ladder runs HERE, awaited, before the drain: every live lane is
    // woken, asked, and killed if it will not go. Awaited rather than armed on
    // a timer, because a `setTimeout` backstop dies with the process that set
    // it — which is precisely the process that is exiting.
    const grace = Math.min(SIGTERM_GRACE_MS, SHUTDOWN_LADDER_MS);
    // Named on every live session before anything signals it, so each record
    // says the console's shutdown ended it — not an exit nobody explains.
    for (const lane of this.lanes.values()) lane.handle?.markEnding?.('shutdown', 'the console shut down');
    this.handle?.markEnding?.('shutdown', 'the console shut down');
    const ladders = [...this.lanes.values()]
      .filter((lane) => lane.pid != null)
      .map((lane) => {
        const pid = lane.pid as number;
        const record = this.state?.phases[String(lane.phase)];
        // The tool call open when the signal went — read BEFORE the ladder, whose
        // ending closes nothing the stream would report.
        const openTool = livenessOf(lane.phase, lane.signals).openTool ?? null;
        const started = Date.now();
        return killLadder(pid, { killAfterMs: grace }).then((how) => {
          this.record('run.shutdown-child', {
            pid,
            phase: lane.phase,
            sessionId: record?.sessionId ?? null,
            how,
            graceMs: grace,
            interruptGraceMs: INT_GRACE_MS,
            ms: Date.now() - started,
            why,
            intent,
            ...(context?.reason ? { reason: context.reason } : {}),
            openTool: openTool ? { name: openTool.name, since: openTool.since, ...(openTool.summary ? { summary: openTool.summary } : {}) } : null,
          }, lane.phase);
          return how;
        });
      });
    this.abort?.abort('shutdown');
    await Promise.allSettled(ladders);
    await this.driving;
    this.persist();
  }
}

/**
 * Is `after` the SAME stall episode as `before` — "still true", not news?
 *
 * The same signal, and for `external-wait` the same chain (its first call,
 * `since`) at the same stage (`overBudget`): a new chain is a new wait, and a
 * local chain passing its budget is the one moment a silent wait is announced
 * (control-tower phase 47, #67). Every other signal is one episode for as long
 * as it holds, as before — their `since` moves with the lane on some of them.
 */
export function sameStallEpisode(before: StallState | null | undefined, after: StallState): boolean {
  if (!before || before.signal !== after.signal) return false;
  if (after.signal !== 'external-wait') return true;
  return before.since === after.since && Boolean(before.overBudget) === Boolean(after.overBudget);
}
