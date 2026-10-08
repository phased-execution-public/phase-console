/**
 * `RunnerBase` — link 1 of the `Runner` chain.
 *
 * One contiguous section of a class that outgrew one file. The chain is a
 * FILE boundary, not a design boundary: members keep their order, their
 * bodies and their single prototype, so `Runner` behaves exactly as it did
 * when this was one declaration — including for the tests that reach its
 * private members. `protected` here means "another link uses it", nothing
 * more. Read the chain in order; `runner.ts` holds the concrete class.
 */
import type { ResolvedPolicy } from '../../shared/policy-model.js';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { HANDLED_SESSION_FILE } from '../turn/handled.ts';
import { INSTANCE_STATE_DIR } from '../config.ts';
import { log } from '../log.ts';
import { holdBinds } from '../fleet-hold.ts';
import { onShutdown, offShutdown, type ShutdownContext } from '../lifecycle.ts';
import { run as engineRun, readMemoryBlock, readGateStatus, readLint, readText, type Board } from '../engine.ts';
import { mcpDirective, skillDirective } from '../skills.ts';
import { detachedRef, worktreeRootOf, WORKTREE_ROOTS, type WorktreeRoot} from '../../shared/worktree-model.js';
import {
  childEnvDecisions, classify, fallbackChain, limitBucket, nextModel, resetWaitUntil, MODEL_FALLBACK, type Disposition,
  type RetirementEvidence,
} from './errors.ts';
import { continueMcpParkedRecord, DEFAULT_MCP_REQUIRE_TIMEOUT_MS, type McpContinueResult } from './mcp-park.ts';
import {
  markFor, spawnClaude, type SpawnFn, type SpawnHandle, type SpawnOutcome, type SpawnRequest, type StreamEvent,
} from './spawn.ts';
import {
  bookedDelta, creditBooked, MAX_COST_MARKS, permissionPromptsFor, relayArmingFor, resolveCaps, sessionRecordOf, type Cap, type CapTable,
  type SessionCaps,
} from './session-record.ts';
import { loadModelsEnv } from './models.ts';
import { proofsFile } from './proofs.ts';
import { contextWindowOf, CostDrift, costMismatch, MAX_TOKEN_ATTEMPTS, priceRowOf, priceUsage, type TokenAttempt } from './usage.ts';
import type { PollLoopState } from '../../shared/poll-loop.js';
import { writeMcpConfigFile, type McpConfigDoc } from '../mcp/config.ts';
import { RELAY_HOST_SERVER, RELAY_HOST_TOOL, relayHostConfig } from '../relay-host.ts';
import { killLadder, stopWhereItStands, wake } from './signals.ts';
import {
  FREEZE_ESCALATE_MS, checkpointFrozenRecord, escalatePersistedFreeze, freezeVerdict,
  type PersistedEscalation,
} from './freeze.ts';
import { extractCommands, resolveLead, unresolvableLeads, verifyPhase } from './verify.ts';
import { loadVerifyEnv, type VerifyEnv } from './verify-env.ts';
import {
  failureContext, resumeBrief, resumeInstruction, unblockBrief, type BriefFacts,
} from './failure-context.ts';
import {
  applyEvent, evaluateStall, isProductiveEvent, livenessOf, newLaneSignals, stallThresholds,
  type LaneLiveness, type LaneSignals, type StallState, type StallThresholds,
} from './liveness.ts';
import { ingestRulings, rulingsFile, type Ruling } from './rulings.ts';
// FREE: the shared owner of the messaging words, which the free tree reads
// too — only the ledger path below it is Pro.
import { DEFAULT_MESSAGING } from '../../shared/message-model.js';
import {
  isRegistered, laneNames, realish, restoreSettledMirror, scopeConfined,
  type LaneNames, type RadarState, type RunGitView,
  managedRoots,
  stagingHome,
  stagingNames,
  worktreeHome,
  type StagingNames,
} from './worktree.ts';
import { standingBranchSync } from './tree-state.ts';
import {
  classifySituation, collectEvidence, situation as situationOf, workEvidence,
  type EvidenceDeps, type PhaseEvidence, type Situation,
} from './situation.ts';
import {
  accountRung, chargeRung, errandFor, nextRung, rungKey, rungsFor, rungSettledPayload, rungWasWithdrawn, personRetryOwed, settleRung, settleRungRecord,
  DEFAULT_LADDER_CAPS, type LadderCaps, type Rung,
} from './ladder.ts';
import type { RungRecord, Actor, WaitBeside } from './state.ts';
import type { RungCause } from './ladder.ts';
import { stoppedByOf } from '../actor.ts';
import {
  childrenOf, loadRun, newRun, phaseRecord, procIdentity, saveRun, pidAlive, processState, IN_FLIGHT, SETTLED,
  PHASE_IN_FLIGHT, reconcileRecordsAgainstBoard, mcpReasonText, resetForRetry, consoleStoppedNote,
  settleInFlightRecords, runDir, THIS_CONSOLE,
  type Autonomy, type BoardingBrief, type BoardingHint, type ChildRef, type Errand, type HaltKind, type SessionMode,
  type McpDegradation, type McpPolicy,
  type OnLimitPolicy, type PhaseOptions, type PhaseRecord, type PreflightWarning,
  type RunState, type PhaseStatus, type RunStatus, type VerifySummary,
  consoleRunsDir, type DeclarationSink,
} from './state.ts';
import { consumeOutcome, outcomeFileFor, readOutcome, type PhaseOutcome } from './outcome.ts';
import {
  AdmissionAborted, autopilotOwner, type Scheduler, type ScopeGrant,
} from './scheduler.ts';
import { formatScope, repoKeyOf, scopesIntersect } from '../../shared/scope.js';
import { Journal } from './journal.ts';
import { Transcript } from './transcript.ts';
import { checkAuth, type AuthStatus } from './auth.ts';
import {
  buildSettings, writeSettingsFile, loadPolicyFor,
  type Approvals, type PermissionProfile,
} from './approvals.ts';
import {
  CLOSEOUT_MAX_TURNS, DEFAULT_BUDGET_RAISE_PCT, LADDER_STATES, ladderClassifies, LEASE_REFRESH_MS, LIMIT_ACTION_COOLDOWN_MS, LIMIT_RETRY_BURST, LIMIT_RETRY_WINDOW_MS, LIVENESS_GIT_EVERY_MS, LIVENESS_TICK_MS, LOCK_BACKOFF_MAX_MS, LOCK_CAP_PARK_NOTE, LOCK_WAIT_CAP_MS, MAX_ATTEMPTS, MAX_INJECT_KEYS, MCP_AUTH_PARK_NOTE, MCP_PARK_NOTE, SHUTDOWN_LADDER_MS, SIGTERM_GRACE_MS, TEARDOWN_SETTLES, VERIFICATION_PARK_NOTE, VERIFY_ANSWER_MS, VERIFY_TIMEOUT_MS, DEFAULT_WAIT_BUDGET_MS, WAIT_DEFAULT_MS, WAIT_MAX_PER_PHASE, applySettings, authRefusal, briefForRung, closeoutPrompt, condenseSaid, escalateModel, fixVerificationInstruction, frameQuestion, frameSteer, prBlockText, preflight, reasonOf, survivingChildren, unattendedDirective, waitResumePrompt, wakeSignal, type AskResult, type Lane, type McpResolution, type ReboardRequest, type RecoverMode, type RecoverOptions, type RunSettingsPatch, type RunnerDeps, type RunnerEvent, type StartOptions,
  LOCK_MIRROR_ENV,
} from './runner-core.ts';
import type { Runner } from './runner.ts';
import {
  DEFAULT_WAIT_BUDGET, claimBudgetWarning, phaseBudgetFact, runBudgetFact, waitBudgetFrom, type WaitBudget,
} from './wait-budget.ts';
import { budgetApproaching, type BudgetFact } from '../../shared/budget-model.js';
import type { ResumeVerdict, SessionRequest, VettedResume } from './runner-core.ts';
import type { ConsoleSkillFacts } from './runner-core.ts';
import type { AttemptOptions } from './runner-attempt.ts';
import { dateOfRef } from '../watch-refs.ts';
import { DEFAULT_MODEL_POLICY, RUN_PROGRESS_FIELDS, runResumable, type ModelPolicy } from '../../shared/run-lifecycle.js';
import { taskSummary } from '../../shared/task-model.js';
import {
  PHASE_WORK_MODES, closeAttemptWindow, clocksDigest, openSessionWindow, phaseClocks, type PhaseClocks,
} from '../../shared/phase-clocks.js';


/* ------------------------------------------------------------------ *
 * The progress frame
 * ------------------------------------------------------------------ */

/** One `run:progress` payload — `RUN_PROGRESS_FIELDS`, and nothing else. */
export type RunProgress = {
  phase: number;
  status: string;
  attempt: number;
  attemptStartedAt: string | null;
  tasks: { total: number; done: number; active: number } | null;
  spentUsd: number | null;
  contextTokens: number | null;
  stall: string | null;
  /** The labelled clocks as of this frame (#28) — see `shared/phase-clocks.js`. */
  phaseClocks: PhaseClocks | null;
};

/**
 * Join the two halves that know what a phase is doing.
 *
 * `liveness()` carries output, tools, stalls, tokens and THIS session's
 * unbooked dollars; it knows nothing about phase status, which attempt is
 * running, when that attempt started, or how many tasks are done. The record
 * carries those and does not carry the live half. Neither alone is progress,
 * which is why this is a function and not a method on either of them.
 *
 * Pure, so the shape a client reads is asserted without a runner.
 */
export function progressFrame(live: LaneLiveness, record: PhaseRecord, nowMs = Date.now()): RunProgress {
  const tasks = record.tasks ? taskSummary(record.tasks) : null;
  return {
    phase: live.phase,
    status: record.status,
    attempt: record.attempts ?? 0,
    attemptStartedAt: record.attemptStartedAt ?? null,
    tasks: tasks ? { total: tasks.total, done: tasks.done, active: tasks.active } : null,
    spentUsd: live.spentUsd ?? null,
    contextTokens: live.tokens?.context ?? null,
    stall: live.stall?.signal ?? null,
    phaseClocks: phaseClocks(record, nowMs),
  };
}

/**
 * What makes a frame news.
 *
 * Deliberately the frame itself and nothing more. `lastOutputAt` moves on every
 * streamed line, so a digest that included it would fire on every tick forever
 * — which is the firehose again, three seconds slower and no cheaper to apply.
 * What a surface renders is what decides whether it needs to hear.
 */
export function progressDigest(frame: RunProgress): string {
  // The clocks tick every frame by construction; only their stable half —
  // the windows, the first tool call — is news (`clocksDigest`).
  return RUN_PROGRESS_FIELDS.map((field) => (field === 'phaseClocks'
    ? clocksDigest(frame.phaseClocks)
    : JSON.stringify(frame[field]))).join('|');
}

/** How long a press waits for the loop to decide whether it boarded (control-tower phase 86, RS-5). */
export const BOARDING_VERDICT_MS = 5_000;

/** `boardingVerdict`'s answer: the phase boarded at this admission, or where it waits. */
export type BoardingVerdict =
  | { boarded: true }
  | { queued: { position: number | null; behind?: { kind: string; slug: string; phase: number | null; owner: string } } };

export abstract class RunnerBase {
  /** Set while `ensureRunCheckout` is between the cap check and the finished tree. */
  protected abstract reservingCheckout: boolean;
  protected abstract applyReconcile(board: Board): Promise<void>;
  /** The drive tick's `undriven` stamp (control-tower phase 79, #114) — see `Runner.noteUndriven`. */
  protected abstract noteUndriven(board: Board, boarding: ReadonlySet<number>): void;
  protected abstract armLeaseTimer(lane: Lane, owner: string): void;
  protected abstract armLivenessTicker(): void;
  protected abstract armParkPoke(phase: number, untilIso: string): void;
  /** Re-read every usage wall this run's phases are parked on (control-tower phase 54, #78); answers how many moved. */
  abstract rereadWalls(trigger: 'reading' | 'spend' | 'reprobe'): number;
  protected abstract clearWallProbe(phase: number): void;
  protected abstract askHuman(
    phase: number,
    verification: VerifySummary,
    askable?: VerifySummary['notRun'],
  ): Promise<boolean>;
  protected abstract attempt(phase: number, prompt: string, model: string, owner: string, lane: Lane, chosen?: PhaseOptions, opts?: AttemptOptions): Promise<{ carryOn: boolean; completed: boolean; }>;
  protected abstract board(): Promise<Board>;
  protected abstract boardingBlocked(): 'stopped' | 'halted' | 'pause' | 'frozen' | null;
  protected abstract checkpointForShutdown(context?: ShutdownContext): Promise<void>;
  protected abstract clearLeaseTimer(lane: Lane): void;
  protected abstract clearParkPoke(phase: number): void;
  protected abstract climb(record: PhaseRecord, board: Board, by: string, preset?: { situation?: Situation; declared?: PhaseEvidence['declared']; sessionId?: string; }): Promise<boolean>;
  protected abstract climbLadder(board: Board, asked: Set<number> | null): Promise<void>;
  protected abstract composeBrief(phase: number, board: Board, hint: BoardingHint, engineText: string): Promise<{ prompt: string; brief: BoardingBrief; resume?: string; vetted?: VettedResume; maxTurns?: number; degraded?: string; }>;
  protected abstract confirmed(phase: number): Promise<boolean>;
  /** The phase's §Verification baseline at its first boarding (control-tower phase 83, #103) — `RunnerAttempt`. */
  protected abstract takeBaseline(phase: number): Promise<void>;
  /** Every baseline still measuring beside a session, awaited (control-tower phase 105). */
  protected abstract settleBaselines(): Promise<void>;
  protected abstract boardingWipBlock(phase: number, lane: Lane): Promise<string>;
  protected abstract disarmLivenessTicker(): void;
  protected abstract endLaneStall(phase: number): void;
  protected abstract syncGitProbe(): void;
  protected abstract disarmGitProbe(): void;
  abstract refreshGit(): Promise<boolean>;
  protected abstract drive(): Promise<void>;
  protected abstract emit(event: string, data: Record<string, unknown>): void;
  protected abstract engine(args: string[], env?: Record<string, string>): Promise<import("../engine.ts").EngineResult>;
  protected abstract enterRunWaiting(nowIso: string, asked?: Set<number> | null, beside?: WaitBeside | null): boolean;
  protected abstract evaluateLane(lane: Lane, thresholds: StallThresholds, now: number): Promise<boolean>;
  protected abstract gitOrNull(args: string[]): Promise<string | null>;
  protected abstract halt(reason: string, phase: number | undefined, kind: HaltKind, extra?: { evidence?: RetirementEvidence }): void;
  protected abstract now(): Date;
  protected abstract onStream(phase: number, event: StreamEvent): void;
  protected abstract noteContext(phase: number, event: Extract<StreamEvent, { kind: 'usage' }>): void;
  protected abstract armOutcomeFile(phase: number): string;
  /** The declaration already in the outcome file — read, journalled, consumed (#21 §3). */
  protected abstract takeArmedOutcome(phase: number): PhaseOutcome | null;
  protected abstract outcomePath(phase: number): string;
  protected abstract armTasksFile(phase: number): string;
  protected abstract tasksPath(phase: number): string;
  protected abstract drainTasks(phase: number): boolean;
  protected abstract parkWaiting(
    phase: number, declared: PhaseOutcome,
    opts?: { by?: import('./wait-budget.ts').WaitAuthor; budget?: WaitBudget; minted?: string[] },
  ): boolean;
  protected abstract persist(): void;
  /** `persist()` without the debounce — for the moments that must reach disk now. */
  protected abstract persistNow(): void;
  protected abstract preflightVerification(phase: number): Promise<string | null>;
  /** The policy answer in force for a situation's manifest row (phase 11; `runner.ts`). */
  protected abstract policyFor(situationKey: string): ResolvedPolicy | null;
  /** The phase's `Person-check:` word and its source (phase 11; `runner.ts`). */
  protected abstract personCheckFor(phase: number): { answer: string | null; source: string };
  protected abstract rearmLockCapParks(board: Board): Promise<void>;
  /** Rewrite this run's settings with the relay armed or not, keeping the token (phase 14; `runner-control.ts`). */
  protected abstract rearmRelay(armed: boolean): void;
  /** The settings file a plan-mode session with the relay's host loads, or null (control-tower phase 11). */
  protected abstract planHostSettingsPath(): string | null;
  protected abstract reboardWith(record: PhaseRecord, hint: BoardingHint): void;
  /** Withdraw the open rung a console re-brief superseded before its first turn (control-tower phase 86, #14). */
  protected abstract supersedeOpenRung(phase: number, why: string): void;
  protected abstract record(event: string, data?: Record<string, unknown>, phase?: number): number | null;
  /**
   * This run's journal as a `DeclarationSink` — what the state helpers that
   * spend testimony (`resetForRetry`, `reconcileRecordsAgainstBoard`) write
   * through. A LIVE runner always passes its own: a second `Journal` over the
   * same file would diverge the sequence numbers.
   */
  protected declarationSink(): DeclarationSink {
    return (event, data, phase) => this.record(event, data, phase);
  }

  /**
   * The runner's ONE settlement door (zero-touch-console phase 10, RCV-6):
   * settle the phase's newest open rung and write `phase.rung-settled` with
   * the whole payload — situation, params, cost, note. Every `settleRung`
   * under `runner/` goes through here (`test/invariants.test.ts` holds it; the
   * service has its own door, `settleRungOn`), which is what makes the
   * journal's settlement one shape: all 132 the audit read said only
   * `{outcome, rung}`. A no-op, answering null, when nothing is open.
   */
  protected settleOpenRung(
    phase: number, outcome: NonNullable<RungRecord['outcome']>, note?: string, costUsd?: number,
    cause?: RungCause,
  ): RungRecord | null {
    const slot = this.state?.recoveries?.[String(phase)];
    if (!slot) return null;
    const settled = settleRung(slot, outcome, costUsd, note, cause);
    if (settled) this.record('phase.rung-settled', rungSettledPayload(settled), phase);
    return settled;
  }

  /**
   * Settle whatever this phase's ladder still holds OPEN once its attempt has
   * ended — the backstop behind the outcome-driven settles, so no rung stays
   * `running` past its attempt (RCV-6: 21 of 168 records did, and
   * `chargeRung` went on booking every later attempt's spend onto them). The
   * verdict is read off the record the attempt left, the healer's sweep's own
   * table: done → `fixed`; a declared park → `no-defect`; an interruption →
   * `interrupted`; anything else `failed`, naming the status. Only rungs
   * climbed BEFORE `since` are settled: a rung the attempt itself climbed on
   * its way out — a re-board hint for the next lane — is that lane's to
   * settle, not this one's.
   */
  protected settleRungsAfterAttempt(phase: number, since: string): void {
    const state = this.state;
    const slot = state?.recoveries?.[String(phase)];
    if (!state || !slot?.rungs?.some((r) => (r.outcome === 'running' || r.outcome == null) && r.at < since)) return;
    const record = state.phases[String(phase)];
    // A lane that ended at the gate, the queue or a preflight park spawned
    // nothing. Settling its rung by the record would spend the remedy on a
    // boarding that never happened — which is exactly what scored a rung
    // `failed` over the note "the record reads pending" (#16).
    //
    // It used to return here in silence, which left the rung `running` for the
    // service's sweep to mis-score on its next pass. It settles `withdrawn`
    // instead: the rung is closed, nothing is charged, and `countedRungs`
    // ignores it, so the remedy is still there to climb on the next tick.
    if (!record?.attemptStartedAt || record.attemptStartedAt < since) {
      if (!rungWasWithdrawn(record, { at: since })) return;
      for (const open of slot.rungs!.filter((r) => (r.outcome === 'running' || r.outcome == null) && r.at < since)) {
        // A PERSON's Retry is not the ladder's to withdraw (control-tower phase
        // 91, #131): a halt that emptied the queue took its lane, not the
        // press. While the record still carries the person's hint the rung
        // stays open, and the resumed run boards it first — the retry is owed.
        if (personRetryOwed(record, open)) {
          this.record('phase.retry-kept', { rung: open.rung, at: open.at, by: open.by }, phase);
          continue;
        }
        settleRungRecord(slot, open, 'withdrawn', undefined, 'the lane never spawned — the record never moved past pending');
        this.record('phase.rung-settled', { ...rungSettledPayload(open), by: 'attempt-end' }, phase);
      }
      return;
    }
    const status = record?.status ?? 'absent';
    const verdict: { outcome: NonNullable<RungRecord['outcome']>; note: string } =
      status === 'done' ? { outcome: 'fixed', note: 'the record reads done' }
        // The console's OWN park is the watchdog's act, never the session's
        // declaration (control-tower phase 47, #52): a watchdog-ended session
        // that declared nothing used to settle `no-defect` over the note "the
        // session declared waiting-external". It is an interruption.
        : (status === 'parked' || status === 'waiting') && record?.declared?.by === 'watchdog'
          ? { outcome: 'interrupted', note: 'the watchdog ended the attempt and parked the phase; nothing was declared' }
        : (status === 'parked' || status === 'waiting') && record?.declared
          ? { outcome: 'no-defect', note: `the session declared ${record.declared.status}` }
          : status === 'interrupted'
            ? { outcome: 'interrupted', note: record?.note ? `the attempt was interrupted — ${record.note.slice(0, 120)}` : 'the attempt was interrupted' }
            : status === 'pending' && record?.boardingHint
              ? { outcome: 'interrupted', note: `the ladder re-boarded the phase (${record.boardingHint.rung}) before this rung settled` }
              : { outcome: 'failed', note: `the record reads ${status}` };
    // WHY (control-tower phase 5, #36): an attempt the API refused entry to
    // — the credential wall the runner stamped on the record during THIS
    // lane — says nothing about the remedy it was climbing. The rung is not
    // tried; it comes back when the wall does not.
    const walled = record?.cause?.kind === 'credential-refused' && record.cause.at >= since;
    const cause: RungCause | undefined = walled ? 'environment' : undefined;
    // Oldest first, every open rung older than the attempt — a phase that
    // climbed twice without settling holds two, and both are past.
    for (const open of slot.rungs.filter((r) => (r.outcome === 'running' || r.outcome == null) && r.at < since)) {
      settleRungRecord(slot, open, verdict.outcome, undefined, walled ? `${verdict.note} — the API refused the run's credential` : verdict.note, cause);
      this.record('phase.rung-settled', { ...rungSettledPayload(open), by: 'attempt-end' }, phase);
    }
  }
  /**
   * Stamp `environment` on the rungs THIS attempt was climbing, before
   * whoever settles them does (control-tower phase 5, #36) — for the arms
   * that know the machine ended it: no network past the outage budget, a wait
   * on the network cut short, a transient stop before the first turn. The
   * settlement keeps a stamped cause. Rungs opened after the attempt began
   * (a re-board hint for the NEXT lane) are that lane's, and are left alone.
   */
  protected blameEnvironment(phase: number): void {
    const state = this.state;
    const slot = state?.recoveries?.[String(phase)];
    const since = state?.phases[String(phase)]?.attemptStartedAt;
    for (const open of slot?.rungs ?? []) {
      if (open.outcome !== 'running' && open.outcome != null) continue;
      if (since && open.at >= since) continue;
      open.cause = 'environment';
    }
  }
  protected abstract release(phase: number, owner: string): Promise<void>;
  protected abstract mirrorLock(phase: number, verb: 'claim' | 'release'): Promise<void>;
  protected abstract resolveMcp(phase: number, chosen: PhaseOptions): Promise<McpResolution>;
  protected abstract resumedStatus(): RunStatus;
  protected abstract retryContext(record: PhaseRecord, halt?: string | null): string;
  protected abstract scopeDirs(phase: number): Promise<string[]>;
  protected abstract script(script: string, args: string[]): Promise<import("../engine.ts").EngineResult>;
  protected abstract settleAwaitingVerification(): void;
  /** A sleep a stop, a halt, a wake — or the caller's own `cut` — ends early. */
  protected abstract sleep(ms: number, cut?: AbortSignal): Promise<void>;
  protected abstract takeOutcome(phase: number): PhaseOutcome | null;
  /* The two halves of "act on what the session declared", implemented in
   * RunnerAttempt and called from RunnerControl's `repair` recovery — which
   * sits BELOW it in the chain (Base → Control → Loop → Attempt → Runner), so
   * the call has to travel up through an abstract exactly as `confirmed` does.
   * A recovery's tail routes its declaration through the SAME function a
   * phase's tail does; two routers would be two policies. */
  protected abstract routeOutcome(phase: number, declared: PhaseOutcome, board: Board): Promise<'waiting' | 'halted' | null>;
  protected abstract settleRungFromOutcome(phase: number, declared: PhaseOutcome | null, said?: string): void;

  protected deps: RunnerDeps;
  protected state: RunState | null = null;
  protected journal: Journal | null = null;
  protected transcript: Transcript | null = null;
  protected abort: AbortController | null = null;
  protected driving: Promise<void> | null = null;
  /**
   * Every phase this run has in flight, keyed by phase number.
   *
   * The source of truth for "what is running"; `state.child`,
   * `state.activePhase` and `state.freeze` are all derived from it.
   */
  protected lanes = new Map<number, Lane>();

  /**
   * What this run may do to phase N's model (control-tower phase 54, #91): the
   * PLAN's word — the phase's bullet, else §Session budget's line — then the
   * run's `modelPolicy`, then `ladder`. The plan outranks the run here as it
   * does for the MCP policy: "this model, or wait" is a claim about the work,
   * and a plan that pinned its model should not un-pin because a run forgot.
   */
  protected modelPolicyOf(phase: number): ModelPolicy {
    const state = this.state;
    const plan = state ? this.deps.phaseDefaults?.(state.slug, phase)?.modelPolicy : undefined;
    return plan ?? state?.modelPolicy ?? DEFAULT_MODEL_POLICY;
  }

  /**
   * The directory a phase's session runs in: its own worktree when this plan
   * opted into worktree lanes, the run's root otherwise.
   *
   * Read from the LANE rather than recomputed from the plan directive, so a
   * lane whose worktree could not be created (a refusal, a git failure) reads
   * as the root here without a second chance to disagree with the runner about
   * where the session actually is.
   *
   * 🔴 Lives HERE, on the base, and not next to the attempt that first needed
   * it. Three other spawn sites are spread across `runner-control.ts` and
   * `runner-loop.ts` — recovery, resume-with-instruction, the pull-request
   * session — and every one of them hardcoded `state.root` for as long as this
   * method was out of their reach (D7). A lane phase recovered from the wrong
   * tree finds its own edits absent and the wrong branch checked out, which is
   * indistinguishable from the work never having happened.
   */
  protected laneRoot(phase: number): string {
    return this.lanes.get(phase)?.worktree ?? this.state!.workRoot ?? this.state!.root;
  }

  /**
   * Where this phase's §Verification runs: the lane's root, moved by the
   * plan's `**Verify in:**` when that names a directory inside it — and why
   * not, when it does not (it escapes the root, or there is no such
   * directory), the root then standing in. Quiet: the verdict journals a
   * refusal (`RunnerAttempt.verifyCwd`); telling a session where its lines are
   * judged (`proofEnv`) is not a verdict.
   */
  protected async verifyDirOf(phase: number): Promise<{ dir: string; root: string; declared?: string; refused?: string }> {
    const root = resolve(this.laneRoot(phase));
    const declared = (await this.deps.verifyIn?.(this.state!.slug, phase))?.trim();
    if (!declared) return { dir: root, root };
    const target = resolve(root, declared);
    if (!(target === root || target.startsWith(`${root}/`))) {
      return { dir: root, root, declared, refused: 'it resolves outside the repository root' };
    }
    try {
      if (!statSync(target).isDirectory()) throw new Error('not a directory');
    } catch {
      return { dir: root, root, declared, refused: 'no such directory under the repository root' };
    }
    return { dir: target, root, declared };
  }

  /**
   * What a phase's session needs to record a proof the console will honour
   * (control-tower phase 106, #196): the ledger `phase-outcome.sh … verified`
   * writes, the directory this phase's lines are JUDGED in (`PE_VERIFY_DIR` —
   * the proof's tree is keyed there, whatever the session's shell stands on)
   * and the run root a relative `--in` is resolved against (`PE_RUN_ROOT`).
   * ai-builder-v7 P14 recorded `--in .` from inside a submodule; five proofs
   * were keyed by the submodule's tree and refused at the verdict.
   */
  protected async proofEnv(phase: number): Promise<Record<string, string>> {
    const { dir, root } = await this.verifyDirOf(phase);
    return {
      PE_PROOFS_FILE: proofsFile(this.state!.root, this.state!.slug),
      PE_VERIFY_DIR: dir,
      PE_RUN_ROOT: root,
      // What the session handled instead of asking (control-tower phase 136):
      // `phase-outcome.sh … handled` appends to the SESSIONS' file — never the
      // console's own ledger, whose sources a session must not be able to claim.
      PE_HANDLED_FILE: join(INSTANCE_STATE_DIR, HANDLED_SESSION_FILE),
    };
  }

  /**
   * The branch this phase's session commits on, or undefined for the shared one.
   *
   * TWO features answer here and the order is the specific one: a lane's own
   * `pe/<slug>-pN` first, then — when the RUN has a checkout of its own — the
   * run branch `pe/<slug>`, and otherwise nothing at all.
   *
   * "Nothing at all" is a real answer and the safe one. It writes an
   * UNQUALIFIED lock, which `phase-lock.sh conflicts` reads as colliding with
   * every other claim on the repository — the pre-carve-out behaviour, and the
   * truth for a session editing the tree everyone shares.
   *
   * 🔴 On the BASE, beside `laneRoot`, for the reason `laneRoot` is here (D7):
   * the sites that need it are spread across `runner.ts` (the lease refresh)
   * and `runner-attempt.ts` (the session environment), and P7 could only reach
   * `lane.branch` from where it stood. A run-level isolated run then wrote an
   * unqualified lock and got no carve-out at all — the field shipped, the rule
   * shipped, and the one run shape they existed for was not covered.
   */
  protected branchFor(phase: number): string | undefined {
    const lane = this.lanes.get(phase)?.branch;
    if (lane) return lane;
    // A DETACHED run owns no ref at all, so there is no branch name to give —
    // and `undefined` here would write an unqualified lock that collides with
    // every claim on the repository, which is the exact opposite of what the
    // detached shape exists for. `detached@<sha12>` is the honest
    // qualification: two detached claims are the same ground when they stand
    // at the same commit, and different ground when they do not, which is what
    // `claimsDisjoint` already decides by comparing branch strings.
    if (this.state?.detachAt) return detachedRef(this.state.detachAt);
    // Any `new-branch` run: its sessions commit on `pe/<slug>` wherever they
    // stand — the boot prompt says so in as many words — and the claim should
    // say what the session does. This used to be gated on `workRoot` so that a
    // shared-checkout run stayed unqualified ("claims strictly less"), because
    // a branch alone could not distinguish two runs sharing one directory.
    // The TREE dimension now carries that distinction (`treeFor`): two shared
    // runs present the same tree and still collide, so the branch may finally
    // tell the truth for everyone. A default-branch run has no branch to name.
    return this.state?.gitMode === 'new-branch' ? `pe/${this.state.slug}` : undefined;
  }

  /**
   * The working tree this phase's session edits — the second qualification
   * dimension, for the lock's `worktree=` line and the admission's `tree`.
   * ACTED ON since the carve rule grew the tree dimension: two intersecting
   * claims are disjoint only when the branches AND the trees both differ.
   * Falls all the way to `state.root`, because a shared-checkout session's
   * tree is a fact too — the SAME fact for every shared run, which is exactly
   * what keeps two of them colliding whatever branches they name.
   */
  protected treeFor(phase: number): string | undefined {
    // 🔴 An ISOLATED run never falls back to the shared root (control-tower
    // phase 90, #149). Its tree is its own checkout on EVERY admission path —
    // and on the one #149 measured, a watch-landed automatic resume admitted
    // with no lane yet and no `workRoot`, the shared root was presented, so the
    // S12 carve-out that let the same phase past a foreign grant three times
    // refused it the fourth. `ownRunTree` answers the run's own checkout path.
    const tree = this.lanes.get(phase)?.worktree ?? this.state?.workRoot ?? this.ownRunTree() ?? this.state?.root;
    // The PHYSICAL path (SCH-1). This is one half of the pair a claim is
    // decided on, and it was returned verbatim — so a run whose root is reached
    // through a symlink (`/tmp/x` for `/private/tmp/x`, which is every macOS
    // temp path, and any `~/work` behind one) presented a tree that did not
    // string-match the one a hand session derives with `pwd -P`. Two claims in
    // ONE directory then read as disjoint, which is the exact collision the
    // pair exists to refuse. `realish` resolves what exists and walks up for
    // what does not, so a tree not yet created still answers.
    return tree ? realish(tree) : undefined;
  }

  /**
   * An isolated run's own checkout when `workRoot` is not recorded — the path
   * the run's checkout lives at (`laneNamesFor(0).integration`), which the next
   * boundary rebuilds if it is gone (`checkoutBeforeBoarding`). Undefined for a
   * run whose checkout is not its own.
   *
   * …and undefined once the run is OVER (`runResumable` answers no). A settle
   * prunes a tree only then — a resumable run keeps its trees whole — and keeps
   * `checkout: 'worktree'` as history, so the word alone would claim a
   * directory the settle removed and that no boundary will rebuild. A settled
   * run's claim is the shared root (git-strategy F-1a); a run that will board
   * again claims its own path whatever its record lost (#149).
   */
  protected ownRunTree(): string | undefined {
    const state = this.state;
    return state?.checkout === 'worktree' && runResumable(state) ? this.laneNamesFor(0).integration : undefined;
  }

  /**
   * The checkout this phase's session works in when it has ONE OF ITS OWN —
   * `treeFor` without the shared-root fallback. Kept for the readers that ask
   * "does this session have its own tree" (the git card, the lane view),
   * where the shared root would be a false yes.
   */
  protected worktreeFor(phase: number): string | undefined {
    return this.lanes.get(phase)?.worktree ?? this.state?.workRoot;
  }

  /**
   * The CLAIM a phase's session makes — both qualification dimensions, or
   * neither. The one answer behind the admission request, the session's
   * `PE_BRANCH`/`PE_WORKTREE`, the lease refresh's `--branch`/`--worktree`,
   * and the honesty probe, so the four cannot disagree about one session.
   *
   * 🔴 NEITHER when the phase's scope names a tree the run root does not
   * contain. `branchFor`/`treeFor` describe the run root — the branch the
   * console told sessions to use and the directory it spawns them in — and
   * for a plan whose Repos cell names a repository elsewhere on the machine
   * (a skill checkout under the home directory, driven from a hub) the
   * session's edits land in THAT repository, on whatever it has checked out.
   * A claim of `{pe/<slug>, <root>}` is then exact about a tree nobody
   * edits and silent about the one that is edited: a hand session `--here`
   * in the real repository on its own branch presents a different pair,
   * `claimsDisjoint` carves the two apart, and both write one working tree —
   * the collision the whole apparatus exists to refuse. An unqualified claim
   * collides with everything, which is the truth the console can vouch for.
   * `scopeConfined` is the same question the worktree preamble asks before it
   * would mint a tree (`scope-outside-root`), asked here of the shared shape
   * too. (console-parallel-repaint P1, W5.)
   */
  protected qualificationFor(
    phase: number, scope: readonly string[],
  ): { branch?: string; tree?: string; repo?: string } {
    const root = this.state?.root;
    if (!root || !scopeConfined(root, scope)) return {};
    // A run that names no branch of its own (a default-branch run) commits on
    // whatever its SHARED checkout stands on, so its claim says that branch —
    // the one every repository its scope names stands on, read off disk at
    // each ask (control-tower phase 90, #149). Stating none made it collide
    // with every claim in every tree, where its new-branch sibling in the same
    // checkout was carved past an isolated run's grant. The TREE still keeps
    // it colliding with everything in the shared checkout. Never the branch
    // hold's probe: that one is handed the declared branch alone (`admit`).
    const branch = this.branchFor(phase)
      ?? (this.worktreeFor(phase) ? undefined : standingBranchSync(root, scope));
    const tree = this.treeFor(phase);
    // The repository the tree rides in — the per-repository cap's key. Derived
    // from the tree rather than from `state.root`, so it is absent for exactly
    // the admissions that state no tree, which is exactly the set that must
    // not be capped (`AdmitRequest.repo`).
    const repo = tree ? repoKeyOf(tree) : '';
    return {
      ...(branch ? { branch } : {}),
      ...(tree ? { tree } : {}),
      ...(repo ? { repo } : {}),
    };
  }

  /**
   * The four environment variables a spawned session claims its lock with —
   * and a fifth, `PE_LOCK_MIRROR` (`LOCK_MIRROR_ENV`), which makes those claims
   * file-only because the console mirrors the lock to git itself.
   *
   * `phase-lock.sh` reads all four (`PE_OWNER`, `PE_SCOPE`, `PE_BRANCH`,
   * `PE_WORKTREE`) and DECIDES on the pair: a claim that names a branch and a
   * tree carves against another that names a different pair; one missing either
   * collides with everything. Five of the six phase-scoped spawn sites injected
   * the first two only — the reviewer, the closeout, the repair and both resume
   * sites — so each of those sessions' own first claim was unqualified, and
   * stayed so until the runner's keepalive rewrote the lock up to a third of a
   * lease later. Two isolated runs that should have carved cleanly serialised
   * against each other for ten minutes, every time one of them spawned.
   *
   * One helper, because the failure was five places agreeing about two fields
   * and forgetting two. `qualificationFor` is still the single source of the
   * pair — including its refusal to state EITHER for a scope the run root does
   * not contain, which is why this returns a whole env fragment rather than
   * letting each caller assemble one.
   */
  /**
   * How many times each phase's PROVISIONAL claim has been refused this process
   * (S1-a). In memory rather than on the record: it is about this run's
   * boarding attempts, not about the phase's history, and it is only ever read
   * to stop a cycle.
   */
  protected readonly provisionalRefusals = new Map<number, number>();

  protected async claimEnv(phase: number, over: { owner?: string; scope?: readonly string[] } = {}): Promise<Record<string, string>> {
    const scope = over.scope ?? this.lanes.get(phase)?.grant?.scope ?? await this.scopeFor(phase);
    const claim = this.qualificationFor(phase, scope);
    return {
      PE_OWNER: over.owner ?? autopilotOwner(this.state!.id),
      PE_SCOPE: formatScope(scope),
      ...(claim.tree ? { PE_WORKTREE: claim.tree } : {}),
      ...(claim.branch ? { PE_BRANCH: claim.branch } : {}),
      // …and that the console, not the session, mirrors the lock to git
      // (control-tower phase 63, #85): the session's lock calls are file-only.
      ...LOCK_MIRROR_ENV,
    };
  }

  /**
   * This plan's `**Messaging:**` word; where the plan is silent, the RUN's
   * own (phase 15 — the launch form's); after both, the shipped `on`.
   */
  protected messagingOn(): boolean {
    const state = this.state;
    const own = (state?.messaging ?? DEFAULT_MESSAGING) === 'on';
    if (!state?.slug || !this.deps.messaging?.on) return own;
    // A plan read that throws must not stop a phase boarding: messaging is a
    // convenience and the default is on.
    try { return this.deps.messaging.on(state.slug) ?? own; } catch { return own; }
  }

  /**
   * The console's commit and this run's skill copy, for the boot prompt (#151)
   * — asked of the service at every boarding, so a copy updated mid-run is
   * said to the next session. A read that throws says nothing rather than
   * stopping a boarding: the directive informs, and the prompt stands without it.
   */
  protected consoleSkillFacts(): ConsoleSkillFacts | null {
    try { return this.deps.consoleSkill?.(this.state?.accountId) ?? null; } catch { return null; }
  }

  /**
   * `claimEnv`'s sibling: how a session says something to a PEER.
   *
   * One helper for the same reason `claimEnv` is one — every `sessionEnv` site
   * needs the pair, and a site that stated the ledger and forgot the token
   * would give a session a channel that 401s on every send. Both, or neither.
   *
   * `PE_MESSAGES_FILE` is per PLAN, not per attempt, and that is the one place
   * this differs from the outcome and task channels next door: those name one
   * file belonging to one attempt and are deliberately never inherited, while a
   * note left for phase 7 must outlive the run that wrote it. So it is not
   * armed (nothing is deleted) and a resumed session finds its own mail.
   *
   * Empty when the plan's `**Messaging:**` word is `off`: a session with no
   * token cannot reach the console's door, `phase-msg.sh` says so and appends
   * to the ledger instead, and nothing is silently half-on.
   */
  protected messagingEnv(): Record<string, string> {
    const state = this.state;
    if (!state || !this.messagingOn()) return {};
    const token = this.deps.messaging?.token?.(state.id) ?? null;
    return {
      ...(token ? { PE_MSG_TOKEN: token } : {}),
    };
  }

  /**
   * `messagingEnv`'s sibling (phase 12): where `phase-issue.sh` records a
   * problem the session tripped over that is not its phase's.
   *
   * Per PLAN like the mailbox, and for the mailbox's reason: the dedupe has
   * to see what an earlier run's phases already drafted, so the file is never
   * armed and a resumed session finds the plan's drafts where it left them.
   * Always stated, whatever the plan's `Issues:` word — the script reads the
   * word itself and refuses under `off`; a session with no ledger would fall
   * back to the console's own inbox, which is the same file by another route.
   *
   * Pro on both lines, the import above and this one — the defect
   * `messagingEnv` documents, not repeated: the free tree's method is a body
   * that returns `{}`, and every spawn site spreads it without knowing.
   *
   * The ledger, then the POLICY the session files under (control-tower phase
   * 114) — `issuePolicyEnv`, the same words its boot prompt was rendered from.
   */
  protected issuesEnv(): Record<string, string> {
    const state = this.state;
    if (!state) return {};
    return {
      ...this.issuePolicyEnv(),
    };
  }

  /**
   * This console's own issue word (Settings ▸ Issues, control-tower phase
   * 115) — what the tighten-only rule reads a run with no word of its own as
   * (`issuesModeLoosens`). `undefined` where there is none, which it reads as
   * `off`.
   */
  protected consoleIssueWord(): string | undefined {
    let word: string | undefined;
    return word;
  }

  /**
   * `issuesEnv`'s policy half (control-tower phase 114): the words a session
   * files under, and nothing that names a ledger — so the boot prompt can be
   * rendered from them too. `--boot-prompt` reads them through
   * `phase-graph.sh --issue-policy`, the one resolver `phase-issue.sh` itself
   * enforces, so the line a session READS and the script it RUNS cannot differ.
   *
   * - `PE_ISSUES_MODE` and `PE_ISSUES_SOURCE` — the console's part of the ONE
   *   resolver (control-tower phase 115, `pro/issues/policy.ts`): the run's own
   *   `Issues:` word (phase 15, the launch form's), else this console's
   *   Settings ▸ Issues, with the level it came from. The script reads it only
   *   where the plan said nothing, so the plan still comes first.
   * - `PE_ISSUES_SUGGEST` — whether a `--suggest` draft is taken: Settings ▸
   *   Issues ▸ "Also file improvement suggestions" (off unless a person turned
   *   it on, operator decision 16).
   * - `PE_ISSUE_REPOS` — the estate's keys as the repository page lists them
   *   (`repoInventory`: `root`, then every initialised submodule's path), which
   *   `--repo auto` resolves a `--where` against.
   */
  protected issuePolicyEnv(): Record<string, string> {
    const state = this.state;
    if (!state) return {};
    return {
    };
  }

  /**
   * The directories a phase's session may write BESIDES the one it runs in.
   *
   * Exactly one, and only when it is needed: the run's root, when the session
   * is somewhere else. Being told where work-state goes (`DOCS_ROOT`) is not
   * the same as being allowed to write it — a lane session without this fails
   * on `new-handoff.sh`, at the very end of a phase that otherwise succeeded,
   * which is the most expensive moment to discover a permission wall.
   *
   * `undefined` rather than an empty array when the cwd already IS the root,
   * so the overwhelmingly common spawn's argv is byte-identical to what it was
   * before this existed.
   */
  protected addDirsFor(phase: number): string[] | undefined {
    const root = this.state!.root;
    return resolve(this.laneRoot(phase)) === resolve(root) ? undefined : [root];
  }

  /**
   * The homes this run's trees may stand in, the configured one first.
   *
   * `active` is the home to CREATE in and to prune from: the one whose
   * `<runId>/` directory already exists — a run resumed after the operator
   * flipped *Worktree root* keeps its trees where they are, or its next lane
   * would be minted beside a branch the old tree still holds — else the
   * configured one. `all` is what a sweep and a registry read take, so nothing
   * is orphaned by a flip. Asked of the filesystem, the way every other
   * checkout question here is, so it cannot go stale.
   */
  protected worktreeHomes(): { active: string; all: string[] } {
    const state = this.state!;
    const stateDir = runDir(state.root, state.slug);
    const mode = worktreeRootOf(this.deps.worktreePrefs?.().root);
    const at = (m: WorktreeRoot): string => worktreeHome({ mode: m, root: state.root, slug: state.slug, stateDir });
    const configured = at(mode);
    const all = [...new Set([configured, ...WORKTREE_ROOTS.map(at)])];
    const active = all.find((home) => existsSync(join(home, state.id))) ?? configured;
    return { active, all };
  }

  /** `laneNames` for this run, in the home its trees stand in. */
  protected laneNamesFor(phase: number): LaneNames {
    const state = this.state!;
    return laneNames({ home: this.worktreeHomes().active, runId: state.id, slug: state.slug, phase });
  }

  /**
   * Put back the mirror branches a final phase's §Verification settled
   * (control-tower phase 62, #47): before ANY session is spawned again — a fix
   * session, a reviewer's requested changes, the pull-request session — and at
   * once on a red final verdict. A settled mount stands on a detached HEAD, and
   * a session committing there would leave its work on no branch at all. One
   * field read when nothing is settled.
   */
  protected async restoreIdleMirror(cause: 'spawn' | 'not-green'): Promise<void> {
    const state = this.state;
    const settled = state?.mirrorSettled;
    if (!state || !settled) return;
    delete state.mirrorSettled;
    const names = this.laneNamesFor(0);
    const out = await restoreSettledMirror(names.integration, names.runBranch, settled.mounts)
      .catch((error: unknown) => ({
        restored: [] as string[],
        failed: settled.mounts.map((mount) => ({ mount, reason: error instanceof Error ? error.message : String(error) })),
      }));
    this.record('run.mirror-branches-restored', {
      phase: settled.phase, cause, branch: names.runBranch, restored: out.restored,
      ...(out.failed.length ? { failed: out.failed } : {}),
    });
  }

  /**
   * The console-wide staging checkout, wherever it already is: git allows a
   * branch ONE working tree, so a `pe/integration` tree standing under the
   * other root keeps its place until an operator removes it.
   */
  protected async stagingFor(repoKey?: string): Promise<StagingNames> {
    const state = this.state!;
    const consoleDir = consoleRunsDir(state.root);
    const mode = worktreeRootOf(this.deps.worktreePrefs?.().root);
    // `repoKey` is a MOUNT's root-relative path, empty for the root itself —
    // which keeps the bare `staging/` it has always had, so an existing tree
    // is still found. One staging tree per REPOSITORY is what lets a mirror
    // run settle `integration` at all: the branch name is the same in N
    // unrelated object databases, and they never meet.
    const at = (m: WorktreeRoot): StagingNames =>
      stagingNames(stagingHome({ mode: m, root: state.root, consoleDir }), repoKey);
    // Asked of git, not of the filesystem: a directory that merely exists
    // under the other root (restored, recreated by hand) is not a checkout,
    // and pinning the settle to it would refuse every settle for ever.
    for (const other of WORKTREE_ROOTS) {
      if (other !== mode && await isRegistered(state.root, at(other).dir)) return at(other);
    }
    return at(mode);
  }

  /** Every directory a console-made tree may stand under — `managed` for the sweeps and the registry. */
  protected managedDirs(): string[] {
    const state = this.state!;
    return managedRoots({ root: state.root, consoleDir: consoleRunsDir(state.root) });
  }
  /**
   * The lane this phase HAS on disk, asked of git — or null.
   *
   * `laneRoot` reads the in-memory lane table, which is the right answer while
   * a phase is in flight and no answer at all afterwards: `this.lanes` is
   * cleared the moment a phase settles, and the two sessions that run after
   * that point — a recovery, and the last leaf's pull-request session — were
   * both spawned in the shared root as a result. This is the durable question,
   * and it never CREATES anything: an absent lane means the phase shared the
   * root, which is exactly what the caller should then do.
   *
   * `isRegistered` rather than a directory check: a directory git has forgotten
   * is not a worktree, and a session committing inside one commits where
   * nothing merges from.
   */
  protected async registeredLane(phase: number): Promise<LaneNames | null> {
    const state = this.state;
    if (!state) return null;
    try {
      const names = this.laneNamesFor(phase);
      return (await isRegistered(state.root, names.dir)) ? names : null;
    } catch (error) {
      // Never a reason to refuse a session: not knowing means the shared root,
      // which is where every one of these ran before lanes existed.
      log.warn('runner.lane-unknown', { slug: state.slug, phase, error });
      return null;
    }
  }

  /** The 60-second liveness ticker; armed with the first lane, retired with the last. */
  protected livenessTimer: NodeJS.Timeout | null = null;

  /** The 3-second `run:progress` ticker, armed and retired beside it. */
  protected progressTimer: NodeJS.Timeout | null = null;
  /**
   * The five-minute branch probe; armed only for a run that has a checkout of
   * its own, because a shared run's branch IS the base and there is nothing to
   * diverge from.
   */
  protected gitTimer: NodeJS.Timeout | null = null;
  /** The one-shot that fires the FIRST probe clear of the admission burst. */
  protected gitFirst: NodeJS.Timeout | null = null;
  /**
   * The last probe, cached — the whole point of the ticker. A run page asking
   * for it must not cost a `worktree list`, a `du` and a `merge-tree` per pair
   * per request; nor may every reader get a different answer.
   */
  protected gitView: RunGitView | null = null;
  /**
   * The radar verdict per pair as it was last JOURNALLED.
   *
   * Transitions only, and this is the memory that makes that possible. A run
   * with three live branches probes three pairs every five minutes; without
   * this the journal would gain a `run.git-radar` line per pair per tick for as
   * long as the run lives, which is a firehose of "still clean" that buries the
   * one line that was news. Cleared with the run, never persisted: the journal
   * is where a verdict is durable, and re-announcing a standing conflict once
   * after a console restart is the right amount of noise.
   */
  protected radarSeen = new Map<string, RadarState>();
  protected childPid: number | null = null;
  /** The live session, while there is one — what `/btw` talks to. */
  protected handle: SpawnHandle | null = null;
  /** Set when somebody stopped us, so exit 143 is not read as a mystery. */
  protected stopRequested = false;
  /**
   * WHO asked for the stop (LFC-6, SHD-3) — the actor `stop()` was handed,
   * kept until the loop settles so every arm that stamps `stoppedBy` and
   * writes the "stopped by …" note reads the same answer. Null between stops.
   */
  protected stopActor: Actor | null = null;
  /**
   * Fired by `halt()` so lanes sleeping on a retry backoff or a usage window
   * wake and re-check, instead of spawning another attempt on a stopped run.
   */
  protected haltSignal = new EventTarget();
  /** Path to the 0600 settings file carrying this run's deny rules and hook. */
  protected settingsPath: string | null = null;
  /** The run whose `run.permission-prompts-skipped` line is already written — once per run. */
  private promptsSkippedFor: string | null = null;
  /** `run.relay-degraded` once per run per reason (phase 14). */
  private relayDegradedFor = new Set<string>();
  /** Idempotency keys of operator messages already written, newest last. */
  protected injected = new Map<string, AskResult>();
  /**
   * The questions an operator asked a live session that are still waiting for
   * their answer, by mark (`ask:<id>`) — what pairs a `phase.asked` with its
   * `phase.answered` (TRS-6). Bounded; in memory, because the stdin a question
   * went down dies with the console that wrote to it.
   */
  protected openAsks = new Map<string, { question: string; by: string; at: number; phase?: number }>();
  /** Set while `recover` drives a single session rather than the phase loop. */
  protected recovering = false;
  /**
   * The phase a `recheck` recovery is re-checking right now, or null. While
   * set, `settlePhase`/`halt` leave an IDENTICAL standing ending untouched and
   * the paperwork charges to the failure streak skip (phase 9, RCV-4): a
   * recheck spawns nothing, so it is neither a failed attempt nor a new stop.
   */
  protected rechecking: number | null = null;
  /**
   * The docs watcher's poke. The FLAG is the truth; the promise only ends the
   * drive loop's sleep — a wake that lands between the race settling and the
   * signal re-arming is still seen, because the loop top reads the flag.
   */
  protected docsDirty = false;
  /**
   * The newest board the drive loop read (control-tower phase 86, #136) — what
   * a queued entry's `awaiting` probe answers from, because the scheduler's
   * scan cannot await an engine read. Refreshed every tick and at every grant
   * that waited; each refresh re-scans the queue (`noteBoard`).
   */
  protected lastBoard: Board | null = null;
  /** Phases whose last admission WAITED in the queue — their grant re-reads a fresh board (#136). */
  protected admittedAfterWait = new Set<number>();
  /**
   * The recovery this runner is driving, while it still waits for its scope
   * (control-tower phase 86, #149 ask 4): a Pause withdraws it and new words
   * replace its instruction, where a recovery that has spawned has no boundary.
   */
  protected recoveryQueued: { phase: number; controller: AbortController; options: { instruction?: string } } | null = null;

  /** Keep `board` as the newest read and let the queue re-scan against it. */
  protected noteBoard(board: Board): void {
    if (board.error || !board.phased) return;
    this.lastBoard = board;
    try { this.deps.scheduler?.poll(); } catch { /* a scan that throws must not stop the loop */ }
  }

  /**
   * The dependencies of `phase` the newest board says are not done, or null —
   * the `awaiting` probe (#136). A phase the board reads `waiting` is held
   * behind the phases its `blocked:` line names; any other word holds nothing.
   */
  protected awaitingOf(phase: number): number[] | null {
    const board = this.lastBoard;
    if (!board || board.states[phase] !== 'waiting') return null;
    const deps = board.blockedBy?.[phase] ?? [];
    return deps.length ? [...deps] : null;
  }
  protected wake = wakeSignal();
  /**
   * Resolutions the Service could not write because this loop owns the state
   * (`syncRecoveredRun` used to return null there and the record stayed
   * failed forever). Drained at the top of every drive tick.
   */
  protected pendingResolutions: { phase: number; outcome: 'done' | 'no-defect'; by: string }[] = [];
  /** Per-phase pokes armed at `parkedUntil`, so a live loop resumes a wait on time. */
  protected parkPokes = new Map<number, NodeJS.Timeout>();
  /**
   * Per-phase re-probes of a usage wall's account, on the `WALL_REPROBE_BACKOFF_MS`
   * back-off (control-tower phase 54, #78). Cleared with the park pokes: they
   * belong to a live loop, and a restarted one re-arms them from the record's
   * `usageWall` at its first re-read.
   */
  protected wallProbes = new Map<number, NodeJS.Timeout>();
  /**
   * Phases whose watch landed while this loop was live (`landWatch`) and which
   * have not been admitted yet: they board AHEAD of their scope — first in the
   * loop's fill, and with `AdmitRequest.reserve` at the scheduler. In memory on
   * purpose: the landing itself is on the record (`declared.landed`), and a
   * loop that dies before boarding it leaves an elapsed wait the next loop
   * resumes like any other — only the head-of-queue priority is this loop's.
   */
  protected landingReserve = new Set<number>();
  /**
   * What the loop's ladder pass last judged, per phase, as a fingerprint of the
   * record, the board and the handoff, and WHEN (`at`, this loop's clock). A
   * record the ladder left standing (deferred, or nothing to climb) is not
   * re-classified — and re-journalled — every tick; it is looked at again when
   * its status, its attempt count, the board's word or its handoff changes, and
   * in any case once the entry is older than `ladderSeenTtlMs` (control-tower
   * phase 79, #114 — it used to be trusted for the life of the process, so a
   * phase whose world moved under an unchanged record was never looked at
   * again). The age sits BESIDE the fingerprint, never in it (phase 51's rule).
   * Cleared on start and on retry, and per phase when an input the fingerprint
   * cannot see moves: walls lifting, a fresh reading with room, a lane freeing
   * on its scope (`noteLaneFreed`).
   */
  protected ladderSeen = new Map<number, { fingerprint: string; at: number }>();
  /**
   * Lanes that ended since the ladder last looked, with the scope each held
   * (control-tower phase 79, #114): a seen phase whose scope meets one is
   * looked at again — the lane may be what it was waiting on. Bounded by the
   * seen entries it can still invalidate; pruned by the pass.
   */
  protected laneFrees: { at: number; scope: readonly string[] }[] = [];
  /** The one poke that wakes the loop when the oldest seen entry expires (#114). */
  protected ladderRecheck: { timer: NodeJS.Timeout; at: number } | null = null;
  /**
   * Set by the console's shutdown checkpoint: the stop about to land on the
   * lanes is the SYSTEM's, not the operator's — the run is stamped so the
   * convergence loop may pick it back up at the next boot.
   */
  protected shuttingDown = false;

  /** The console's memory of a drifting price (control-tower phase 109, #202) — its own when the service hands none. */
  protected readonly costDrift: CostDrift;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
    this.costDrift = deps.costDrift ?? new CostDrift();
  }

  /**
   * The two facts every stop arm writes, from one source: `stoppedBy` folded
   * from the actor (`stoppedByOf`), and the note's wording. A shutdown is the
   * system's whatever actor pressed it — the run must resume at boot — and a
   * stop nobody attributed is still a person's, because the console never
   * stops a run without saying so.
   */
  protected stopStamp(): { stoppedBy: 'operator' | 'system'; by: string; note: string } {
    if (this.shuttingDown) return { stoppedBy: 'system', by: 'console', note: 'the console shut down' };
    const actor = this.stopActor;
    const by = actor?.by ?? 'unattributed';
    return {
      stoppedBy: actor ? stoppedByOf(actor) : 'operator',
      by,
      note: `stopped by ${by === 'operator' ? 'the operator' : by}`,
    };
  }

  current(): RunState | null { return this.state; }

  /**
   * Does this run hold one of the console's managed checkouts, or is it about to?
   *
   * The question `worktreeMaxConcurrent` is really asking, and `state.checkout`
   * alone answers it too late: the word is written only once the tree is made,
   * prepared and journalled, which can be minutes after the cap said yes. The
   * `reservingCheckout` half closes that window; without it two runs starting
   * together both read the pre-count and both passed a cap of one.
   */
  holdsIsolatedCheckout(): boolean {
    return this.reservingCheckout || this.state?.checkout === 'worktree';
  }
  /**
   * Is a loop behind this runner — driving, or being STARTED (control-tower
   * phase 53, #56)? `start()` holds the run it will persist from its first
   * line, across awaits, before the loop exists; a control that read that
   * window as idle wrote the file and was overwritten by the start's own save.
   */
  busy(): boolean { return this.driving !== null || this.starting; }

  /** True while `start()` is between its first line and its return. See `busy`. */
  protected starting = false;

  /**
   * Is a `claude` process of this run spending `accountId` RIGHT NOW? The
   * usage poller's active probe (ACT-3): a lane holding a live child is the
   * one account whose meters are moving, and it is polled at the active
   * cadence; everything else waits the idle ten minutes. A queued or waiting
   * lane holds no child and spends nothing.
   */
  /**
   * This run as the account forecast names it (control-tower phase 92, #141):
   * its plan, its id and the lanes spending `accountId` now — or nothing.
   */
  burningOn(accountId: string): { slug: string; runId: string; lanes: number[] }[] {
    const state = this.state;
    if (!state || !this.driving) return [];
    // Each lane's own account: a boundary switch leaves a live session on the old one.
    const lanes = [...this.lanes.values()]
      .filter((lane) => lane.pid != null && !lane.checkpointed && !lane.stopped
        && (lane.accountId ?? state.accountId ?? 'default') === accountId)
      .map((lane) => lane.phase)
      .sort((a, b) => a - b);
    return lanes.length ? [{ slug: state.slug, runId: state.id, lanes }] : [];
  }

  isSpending(accountId: string): boolean {
    const state = this.state;
    if (!state || !this.driving) return false;
    if ((state.accountId ?? 'default') !== accountId) return false;
    for (const lane of this.lanes.values()) {
      if (lane.pid != null && !lane.checkpointed && !lane.stopped) return true;
    }
    return false;
  }

  /**
   * The docs watcher saw the plan or a handoff (or a lock) change. Wakes the
   * drive loop so the board is re-read NOW rather than when the current lane
   * settles — which, on a one-lane run, used to be hours away.
   */
  noteDocsChanged(): void {
    this.docsDirty = true;
    this.wake.resolve();
  }

  /**
   * An input the ladder's fingerprint cannot see has moved (control-tower
   * phase 79, #114): forget what the pass has seen — for `phases`, else for
   * every phase — and wake the loop, so the phases it left standing are judged
   * again on THIS tick rather than when some lane next happens to end.
   */
  protected forgetSeen(phases?: Iterable<number>): boolean {
    let forgot = false;
    if (!phases) {
      forgot = this.ladderSeen.size > 0;
      this.ladderSeen.clear();
    } else {
      for (const phase of phases) forgot = this.ladderSeen.delete(phase) || forgot;
    }
    if (forgot) this.wake.resolve();
    return forgot;
  }

  /**
   * A lane of this run ended, holding `scope` (control-tower phase 79, #114).
   * A phase the ladder left standing whose scope meets it is looked at again
   * on the next pass — the lane may be exactly what it was waiting on. Kept
   * only while something seen could care.
   */
  protected noteLaneFreed(_phase: number, scope: readonly string[]): void {
    if (!this.ladderSeen.size) return;
    this.laneFrees.push({ at: this.now().getTime(), scope: [...scope] });
    this.wake.resolve();
  }

  /** Did a lane end on this phase's scope since `since`? The seen entry's invalidation for `noteLaneFreed`. */
  protected async laneFreedOnScope(phase: number, since: number): Promise<boolean> {
    const frees = this.laneFrees.filter((free) => free.at >= since);
    if (!frees.length) return false;
    const scope = await this.scopeFor(phase);
    return frees.some((free) => scopesIntersect([...free.scope], scope));
  }

  /**
   * Wake the loop when the oldest seen entry expires (#114). Without it the
   * expiry is only as prompt as the next event — and a lane can run for hours,
   * which is exactly how the measured phases sat skipped. One timer, re-armed
   * only when something earlier is due; a frozen console's poke is dropped,
   * as the park poke's is.
   */
  protected armLadderRecheck(atMs: number): void {
    if (this.ladderRecheck && this.ladderRecheck.at <= atMs) return;
    this.clearLadderRecheck();
    const delay = Math.max(0, atMs - this.now().getTime());
    const timer = setTimeout(() => {
      this.ladderRecheck = null;
      let frozen: { by?: string; plans?: readonly string[] } | null | undefined;
      try { frozen = this.deps.fleetHold?.(); } catch { frozen = null; }
      if (frozen && holdBinds(frozen, this.state?.slug)) return;
      this.wake.resolve();
    }, delay);
    timer.unref?.();
    this.ladderRecheck = { timer, at: atMs };
  }

  protected clearLadderRecheck(): void {
    if (this.ladderRecheck) clearTimeout(this.ladderRecheck.timer);
    this.ladderRecheck = null;
  }

  /**
   * A recovery finished while this loop owns the run: queue its write so the
   * loop applies it under its own ownership next tick, instead of the Service
   * skipping the write-back entirely (the stale-failed-record bug).
   */
  enqueueResolution(resolution: { phase: number; outcome: 'done' | 'no-defect'; by: string }): void {
    if (!this.state) return;
    this.pendingResolutions.push(resolution);
    this.wake.resolve();
  }

  /**
   * Rewrite this run's records from a board the caller already read. The
   * stopped-run counterpart of the drive loop's own reconcile pass — the
   * Service calls it before deciding a halt still needs a recovery.
   */
  reconcileAgainstBoard(board: Record<number, string>): { changed: boolean; closed: number[] } {
    const state = this.state;
    if (!state) return { changed: false, closed: [] };
    const result = reconcileRecordsAgainstBoard(state, board, undefined, this.declarationSink());
    if (result.changed) {
      for (const phase of result.closed) {
        this.clearParkPoke(phase);
        this.record('phase.reconciled', { by: 'the board', outcome: 'done' }, phase);
      }
      this.persist();
      this.emit('run', { state });
    }
    return result;
  }

  /* ---------------------------------------------------------------- *
   * Lanes
   * ---------------------------------------------------------------- */

  /** The phases with a live session right now. */
  livePhases(): number[] { return [...this.lanes.keys()].sort((a, b) => a - b); }

  /**
   * Every live lane's liveness, computed NOW rather than read off the last
   * tick.
   *
   * The record's own `liveness` is at most a minute old, which is right for a
   * checkpoint and wrong for a page that just asked. A caller with no runner
   * falls back to the records; a caller with one gets the current answer.
   */
  liveness(): LaneLiveness[] {
    return [...this.lanes.values()]
      .map((lane) => ({
        ...livenessOf(lane.phase, lane.signals, stallThresholds(this.deps.stallThresholds?.())),
        // The unbooked half of the run's spend (`LaneLiveness.spentUsd`).
        ...(lane.sessionUsd ? { spentUsd: lane.sessionUsd } : {}),
        // Running, and unreachable — said up front (control-tower phase 109, #170).
        ...(lane.inputClosed ? { input: { open: false, closedAt: lane.inputClosed.at, cause: lane.inputClosed.cause } } : {}),
      }))
      .sort((a, b) => a.phase - b.phase);
  }

  /**
   * One `run:progress` frame per live lane whose digest has moved.
   *
   * The tick itself is `Runner.tickProgress`; this is the part worth having
   * here, beside `liveness()`, because the frame is a JOIN of the two halves
   * and only this class holds both. It mutates `lane.progressDigest`, which is
   * what makes "only when its digest changed" a property of the lane rather
   * than of whoever happens to be asking.
   */
  progressFrames(): RunProgress[] {
    const out: RunProgress[] = [];
    for (const lane of this.lanes.values()) {
      const record = this.state?.phases[String(lane.phase)];
      if (!record) continue;
      const frame = progressFrame(
        {
          ...livenessOf(lane.phase, lane.signals, stallThresholds(this.deps.stallThresholds?.())),
          ...(lane.sessionUsd ? { spentUsd: lane.sessionUsd } : {}),
        },
        record,
        this.now().getTime(),
      );
      const digest = progressDigest(frame);
      if (lane.progressDigest === digest) continue;
      lane.progressDigest = digest;
      out.push(frame);
    }
    return out;
  }

  /**
   * Fold a freshly-read ruling ledger into this run, journalling each new one.
   *
   * Scoped to rulings written since this run STARTED. The ledger is per plan
   * and outlives every run — a plan on its fourth run would otherwise ingest
   * three runs' worth of history the first time the watcher fired, and journal
   * every line of it. `GET /api/run/:slug/rulings` reads the whole file, so
   * nothing is hidden; this is the run's own slice.
   */
  ingestRulings(ledger: readonly Ruling[]): number {
    const state = this.state;
    if (!state) return 0;
    const mine = ledger.filter((ruling) => !state.createdAt || ruling.at >= state.createdAt);
    const { rulings, added } = ingestRulings(state.rulings, mine);
    if (!added.length) return 0;
    state.rulings = rulings;
    for (const ruling of added) {
      this.record('phase.ruling', {
        id: ruling.id, kind: ruling.kind, what: ruling.what,
        ...(ruling.why ? { why: ruling.why } : {}),
        ...(ruling.costIfWrong ? { costIfWrong: ruling.costIfWrong } : {}),
        ...(ruling.sessionId ? { sessionId: ruling.sessionId } : {}),
        at: ruling.at,
      }, ruling.phase);
    }
    this.persist();
    this.emit('rulings', { added: added.length });
    return added.length;
  }

  /**
   * The lane a control is aimed at: the one named, or the mirror.
   *
   * Naming nothing means "whatever is running", which is what every caller
   * before lanes meant and still means when only one thing is.
   */
  protected laneFor(phase?: number | null): Lane | undefined {
    if (phase != null) return this.lanes.get(phase);
    return this.mirrorLane();
  }

  /**
   * The one lane the single-lane fields describe.
   *
   * Lowest phase number rather than "most recent": it has to be *stable*, or
   * `state.child` would flip between lanes on every write and a console
   * watching it would see a run bouncing between phases it is calmly running
   * in parallel.
   */
  private mirrorLane(): Lane | undefined {
    let chosen: Lane | undefined;
    for (const lane of this.lanes.values()) {
      if (!chosen || lane.phase < chosen.phase) chosen = lane;
    }
    return chosen;
  }

  /**
   * Rewrite the single-lane fields from the lane table.
   *
   * `state.child` and `state.activePhase` are **load-bearing mirrors**, not
   * leftovers: `reconcileRun`, every console built before lanes, and the run
   * header all read them to answer "is something running, and what?". Dropping
   * them in favour of `children` would make every one of those report a busy
   * run as idle. So both recordings are kept in step here, in one place, and
   * `children` is the complete one.
   */
  protected syncMirror(): void {
    const state = this.state;
    if (!state) return;

    // MERGED, never rebuilt.
    //
    // This used to project `this.lanes` wholesale over `state.children`, which
    // made the map a picture of one process's memory rather than a record of a
    // fact. A fresh console's first lane therefore erased the previous
    // generation's entry — and that entry was the only durable handle on a
    // child that had outlived its console. With it gone, `reconcileRun`'s
    // orphan branch, `adopt`, and `converge.runIsDead` all went blind at once,
    // the run was reclaimed around a live session, and its lock was released as
    // debris while the session was still holding it.
    //
    // So: this process's lanes are authoritative for their own phases, and
    // every other entry is left alone unless the PROBE says it is gone.
    const children: Record<string, ChildRef> = {};
    for (const [phase, existing] of Object.entries(state.children ?? {})) {
      if (this.lanes.has(Number(phase))) continue;          // ours; rewritten below
      if (processState(existing.pid, procIdentity(existing)) === 'gone') continue;
      children[phase] = existing;
    }
    for (const lane of this.lanes.values()) {
      if (lane.pid == null) continue;
      const previous = state.children?.[String(lane.phase)];
      children[String(lane.phase)] = {
        pid: lane.pid,
        phase: lane.phase,
        sessionId: state.phases[String(lane.phase)]?.sessionId ?? '',
        startedAt: state.phases[String(lane.phase)]?.startedAt ?? new Date().toISOString(),
        // Kept across writes: it is stamped once, when the lane's process is
        // spawned, and a later `syncMirror` has no better source for it.
        ...(lane.procStartedAt ?? previous?.procStartedAt
          ? { procStartedAt: lane.procStartedAt ?? previous!.procStartedAt }
          : {}),
        // Who launched it (control-tower phase 110, #175) — stamped with the
        // pid at spawn, and only the lane's own: a previous entry for this
        // phase may be an earlier console's child, and its launcher is not ours.
        ...(lane.launcher ? { launcher: lane.launcher } : {}),
        // WHERE this session is editing, and on WHAT branch — the lane's own
        // answer only, deliberately NOT carried forward from `previous` the way
        // `procStartedAt` is.
        //
        // The two fields look alike and their merge rules are opposites,
        // because their sources are. `procStartedAt` is stamped once at spawn
        // and no later `syncMirror` has any way to recover it, so losing it
        // means losing half the identity tuple. A worktree is decided BEFORE
        // the pid exists (`acquireWorktree` runs at lane creation) and lives as
        // long as the lane, so the lane always knows — and carrying a previous
        // attempt's answer forward would state the one thing that must never be
        // stated wrongly: a phase that DEGRADED to the shared root on its second
        // attempt would go on claiming a checkout of its own, and every reader
        // of "absent means shared" would read the opposite of the truth.
        //
        // Read through `worktreeFor`/`branchFor` so an ISOLATED RUN answers too.
        // While these read `lane.worktree` alone, a run-level isolated session's
        // durable record said "absent", which under `ChildRef.worktree`'s own
        // documented convention means "this session shared the run's root" —
        // the exact opposite of where the process actually was. Every reader of
        // a child that outlived its console (`reconcileRun`'s orphan branch,
        // `adopt`, the client's session card) was told the wrong directory.
        ...(this.worktreeFor(lane.phase) ? { worktree: this.worktreeFor(lane.phase)! } : {}),
        ...(this.worktreeFor(lane.phase) && this.branchFor(lane.phase)
          ? { branch: this.branchFor(lane.phase)! } : {}),
        // The lock the runner fastened on that tree, on git's word (phase 15).
        // Only a LANE's own — a run-level checkout locks the run tree, which
        // is not this child's to claim — and only alongside the directory.
        ...(lane.worktree && lane.lockReason ? { locked: lane.lockReason } : {}),
        // On the lane's own entry, not only the single `freeze` slot — several
        // lanes can be frozen at once, and reconcile + the client read per pid.
        ...(lane.frozen ? { frozen: lane.frozen } : {}),
      };
    }
    if (Object.keys(children).length) state.children = children;
    else delete state.children;

    const mirror = this.mirrorLane();
    state.child = mirror?.pid != null ? children[String(mirror.phase)] ?? null : null;
    this.childPid = state.child?.pid ?? null;
    this.handle = mirror?.handle ?? null;
    // A run between phases points at nothing; one driving lanes points at the
    // mirror. Left stale, a finished phase goes on rendering a "running now"
    // chip in the phases table.
    if (this.lanes.size) state.activePhase = mirror?.phase ?? state.activePhase;
    else if (!this.recovering) state.activePhase = null;
  }

  /**
   * Record a spawned child against its lane — or, with no lane, against the
   * single-lane fields directly.
   *
   * The no-lane path is not dead code: `closeout` and `resumeWithInstruction`
   * are spawns like any other, and both can be reached on a run whose lane
   * table has already been torn down.
   */
  protected attachPid(phase: number, pid: number | null): void {
    const lane = this.lanes.get(phase);
    if (lane) {
      lane.pid = pid;
      if (pid != null) {
        lane.procStartedAt = new Date().toISOString();
        lane.launcher = { ...THIS_CONSOLE };
      } else {
        delete lane.procStartedAt;
        delete lane.launcher;
      }
      this.syncMirror();
      return;
    }
    const state = this.state;
    this.childPid = pid;
    if (!state) return;
    state.child = pid == null
      ? null
      : {
        pid, phase,
        sessionId: state.phases[String(phase)]?.sessionId ?? '',
        startedAt: new Date().toISOString(),
        // Launched here, now (#175): the fact an orphan is judged by.
        launcher: { ...THIS_CONSOLE },
      };
  }

  protected attachHandle(phase: number, handle: SpawnHandle | null): void {
    const lane = this.lanes.get(phase);
    if (lane) { lane.handle = handle; delete lane.inputClosed; this.syncMirror(); return; }
    this.handle = handle;
  }

  /**
   * The caps this console measured from its own sessions (control-tower phase
   * 59, #83) — the input to every session's caps in place of the phase's
   * `Size:`, which did not separate an M's spend from an L's. Null where the
   * console has none yet, or in a harness: `capsFor` then takes the shipped
   * table, measured the same way at release.
   */
  protected capTable(): CapTable | null {
    return this.deps.sessionCaps?.() ?? null;
  }

  /** The wait budgets this runner has read — one pair of engine reads per phase. */
  protected waitBudgets = new Map<number, WaitBudget>();

  /**
   * A phase's wait budget from the plan, through the engine: `--wait-budget N`
   * (the phase's own `Waits on:` max, else the plan's `Wait budget:`) and
   * `--waits-on N`, whose `date:` refs countersign a longer wait.
   *
   * Read at EVERY park and resume, never once per phase (control-tower phase
   * 14, #40): the budget an errand tells a person to raise has to be the one
   * the next park reads, from the plan the console shows. It used to be read
   * once for the runner's whole life, so a raise written to the plan — by
   * hand, as the errand said, or by `raise-budget` — reached no live run: on
   * 2026-09-26 a phase raised from 180m to 360m parked again three minutes
   * later on "3.0 h, this phase's `Waits on:` bullet". Parks are rare and the
   * engine call is uncached by design, so the price is two short reads. The map
   * keeps the last answer for the synchronous paths (`knownWaitBudget`), and a
   * read that fails keeps it too — only a first read with nothing known falls
   * to the console default, the degradation `sizeOf` makes.
   */
  protected async waitBudgetOf(phase: number): Promise<WaitBudget> {
    let budget: WaitBudget = this.waitBudgets.get(phase) ?? DEFAULT_WAIT_BUDGET;
    try {
      const [line, refs, count] = await Promise.all([
        this.engine(['--wait-budget', String(phase)]),
        this.engine(['--waits-on', String(phase)]),
        // The plan's declared-wait count (control-tower phase 121, #40).
        this.engine(['--wait-count', String(phase)]),
      ]);
      if (line.code === 0) {
        budget = waitBudgetFrom(line.stdout, refs.code === 0 ? refs.stdout : '', dateOfRef, count.code === 0 ? count.stdout : '');
      }
    } catch { /* unreadable: the last answer stands */ }
    this.waitBudgets.set(phase, budget);
    return budget;
  }

  /** The budget already read for a phase — for a synchronous path (a watchdog tick) that cannot ask. */
  protected knownWaitBudget(phase: number): WaitBudget {
    return this.waitBudgets.get(phase) ?? DEFAULT_WAIT_BUDGET;
  }

  /**
   * THE door every `claude -p` session under the runner goes through.
   *
   * Seven sites spawn a session — a phase attempt, a resume with an
   * instruction, a repair, a QA round, a closeout, the pull-request session and
   * the reviewer — and until zero-touch-console phase 4 two of them wrote a
   * `phase.session`, one wrote three fields under another name, and four wrote
   * nothing: 50 of the 138 sessions the audit's six plans spawned were
   * invisible to every census built on the record (SES-6). A door that writes
   * the record cannot be forgotten by a site that does not know it exists, and
   * `test/invariants.test.ts` holds every spawn to this one call.
   *
   * It also puts both caps on every session with the policy that set them
   * (SES-8), and journals the two CLI-side ceilings the child runs under
   * (`phase.retry-ceiling`, DOC-2 and SES-12) before it starts.
   */
  protected async spawnSession(
    phase: number, mode: SessionMode, request: SessionRequest, ctx: { caps: SessionCaps; attempt?: number },
  ): Promise<SpawnOutcome> {
    // A mirror a final §Verification settled gets its branches back before
    // anything can commit into it (control-tower phase 62, #47).
    await this.restoreIdleMirror('spawn');
    // `--resume` only ever arrives vetted (`resumableSession`, REG-1/SLF-10):
    // the type admits nothing else, and this is the one line that unwraps it.
    const { resumeFrom, ...rest } = request;
    // The floor for a run nobody can answer (QRL-9): every session of a
    // `relay: off` run carries `--permission-prompts none`, unless the CLI is
    // known to predate the flag — which is said once, on the run.
    let version: string | undefined;
    // Asked only when there is someone to ask, so a harness spawns in the same
    // tick it always did.
    if (this.deps.cliVersion) {
      try { version = await this.deps.cliVersion(); } catch { version = undefined; }
    }
    // The relay (phase 14): armed only for the phase's own attempts — a boarding
    // and the `--resume` of its own session, both `mode: 'phase'` — on a `relay:
    // last-resort` run whose CLI read at or above the floor from `system/init`.
    // Every other session of any run (a QA round, a repair, a resume with an
    // instruction, a closeout, the PR and the reviewer), and every session of a
    // run the relay refused, keeps the floor below and its own MCP set.
    let relay: McpConfigDoc | null = null;
    if (this.state?.relay === 'last-resort' && mode === 'phase') {
      let initVersion: string | null = null;
      try { initVersion = this.deps.initVersion?.(version) ?? null; } catch { initVersion = null; }
      const arming = relayArmingFor(this.state.relay, initVersion);
      this.noteRelayArming(arming);
      if (arming.armed) relay = this.relayMcpDoc(rest.mcpConfig);
    }
    // A plan-mode phase needs a permission HOST (control-tower phase 11; spike
    // `test/fixtures/spikes/exit-plan-mode.json`, CLI 2.1.280): the CLI offers
    // `ExitPlanMode` only to a session that has one — on the floor it answers
    // "No such tool available" and the plan has nobody to be handed to, exactly
    // as spike S1 measured for `AskUserQuestion`. So the phase's own session in
    // `plan` mode carries the relay's presence-only host even on a run whose
    // relay is off, under the CLI floor the relay itself needs, and loads the
    // settings variant with the `PermissionRequest` hook — a host that never
    // answers needs the hook to answer instead. The RUN's relay is untouched:
    // a question on this session is still answered by policy (`relayArmed`).
    let planHostSettings: string | null = null;
    if (!relay && mode === 'phase' && rest.permissionMode === 'plan' && this.state) {
      let initVersion: string | null = null;
      try { initVersion = this.deps.initVersion?.(version) ?? null; } catch { initVersion = null; }
      const arming = relayArmingFor('last-resort', initVersion);
      if (arming.armed) planHostSettings = this.planHostSettingsPath();
      if (planHostSettings) relay = this.relayMcpDoc(rest.mcpConfig);
      this.record('phase.plan-host', {
        armed: Boolean(relay), version: arming.version, floor: arming.floor,
        ...(arming.refused ? { refused: arming.refused } : !planHostSettings ? { refused: 'no-settings' } : {}),
      }, phase);
    }
    const armedPath = relay && this.state ? this.writeRelayConfig(phase, relay) : null;
    const prompts = permissionPromptsFor(armedPath ? 'last-resort' : 'off', version);
    if (prompts.refused && this.state && this.promptsSkippedFor !== this.state.id) {
      this.promptsSkippedFor = this.state.id;
      this.record('run.permission-prompts-skipped', {
        version: prompts.refused.version, floor: prompts.refused.floor, relay: this.state.relay ?? 'off',
      });
    }
    // The relay's own checks (`noteSessionEvent`) belong to a relay-ARMED run;
    // a plan host borrows the transport, not the relay, and must not re-judge
    // the run's relay from its `system/init`.
    const armed = Boolean(armedPath) && !planHostSettings;
    const onEvent = rest.onEvent;
    // Every session on a lane starts from nothing: the lane must not go on
    // showing the context of the session before it until this one's first call.
    // The window goes too, because only the phase's OWN session is judged
    // against one (`noteContext` sets it) — a closeout must not read as the
    // checkpoint it is exempt from. That session's status checks count from here.
    const shared = this.lanes.get(phase);
    if (shared) {
      delete shared.signals.tokens;
      delete shared.signals.contextWindow;
      // …and the dollars shown as live (`Lane.sessionUsd`): a closeout or a
      // retry on this lane must not open showing what the session before it
      // cost — that sum is already booked (autopilot-token-drain H7). A
      // `--resume` re-reports that booked sum inside its running total, so the
      // live figure is measured from the session's mark (control-tower phase 46).
      delete shared.sessionUsd;
      shared.liveCostBase = resumeFrom ? this.costMarkOf(phase, resumeFrom.sessionId) : 0;
    }
    // Whether this session started a subagent: its calls are the subagent's own
    // context, which the stream never prices, so they explain a booked excess.
    let delegated = false;
    const lane = mode === 'phase' ? shared : undefined;
    const pollTracker = lane?.signals.pollLoop;
    const pollBefore = pollTracker ? { ...pollTracker.counts } : undefined;
    const sent: SpawnRequest = {
      ...rest,
      ...(resumeFrom ? { resume: resumeFrom.sessionId } : {}),
      ...(prompts.flag ? { permissionPrompts: prompts.flag } : {}),
      ...(armedPath ? { permissionPromptTool: RELAY_HOST_TOOL, mcpConfig: armedPath } : {}),
      ...(armedPath && planHostSettings ? { settings: planHostSettings } : {}),
      caps: ctx.caps,
      maxTurns: ctx.caps.maxTurns.value,
      budgetUsd: ctx.caps.maxBudgetUsd.value,
      // What the session's own `system/init` says is read here, at the door:
      // the version every later arming is judged on, and — on an armed session —
      // whether the relay actually has a tool to answer and a host to hold it.
      onEvent: (event) => {
        try { this.noteSessionEvent(phase, event, armed, version); } catch { /* bookkeeping never costs the stream */ }
        // The session a phase's boarding prompt was composed for has STARTED:
        // the next-attempt notes that prompt carried are delivered now, to it
        // (control-tower phase 98, #137). A spawn that died before this left
        // them held for the next boarding.
        if (event.kind === 'init' && mode === 'phase' && this.state) {
          try { this.deps.messaging?.confirmBoot?.(this.state.slug, phase, event.sessionId); } catch { /* the mailbox never costs the stream */ }
        }
        if (event.kind === 'tool' && event.delegates) delegated = true;
        onEvent?.(event);
        // The context thresholds, after the lane has taken the event, and for
        // the phase's OWN sessions only: a closeout, a QA round or a repair is
        // never told to wrap up, nor ended in the middle of its handoff.
        if (event.kind === 'usage' && mode === 'phase') this.noteContext(phase, event);
      },
    };
    const ceilings = childEnvDecisions(sent.env ?? process.env);
    this.record('phase.retry-ceiling', {
      mode,
      ceiling: Number(ceilings.maxRetries.value),
      source: ceilings.maxRetries.source,
      bgWaitCeilingMs: Number(ceilings.bgWaitCeilingMs.value),
      bgWaitSource: ceilings.bgWaitCeilingMs.source,
    }, phase);
    // Whose prompt cache this session writes — read at the spawn, because a
    // switch can move the run's account while the session is still running.
    const account = this.state?.accountId ?? 'default';
    // Every session that works the phase is worked time (control-tower phase
    // 58, #66). The attempt opens its own window before it spawns — it owns the
    // boarding's stretch — so the door opens one for every OTHER work mode: a
    // phase finished by its resume or its closeout was recorded as the attempt
    // alone, and taught the ETA a rate nobody worked at. The pull-request
    // session is the run's, not the phase's (`PHASE_WORK_MODES`).
    const worked = mode !== 'phase' && (PHASE_WORK_MODES as readonly string[]).includes(mode)
      ? this.state?.phases[String(phase)]
      : undefined;
    if (worked) openSessionWindow(worked, mode, this.now().toISOString());
    let outcome: SpawnOutcome;
    try {
      outcome = await (this.deps.spawn ?? spawnClaude)(sent);
    } finally {
      // Closed even when the spawn throws: a window left open on a record that
      // still reads `running` would count to now on every read.
      if (worked) {
        closeAttemptWindow(worked, this.now().toISOString());
        // ONE definition (#28): the stored figure is the windows' sum, as the wire's is.
        worked.durationMs = phaseClocks(worked, this.now().getTime()).workedMs ?? worked.durationMs;
      }
    }
    // Ended, so its cost is booked (below): the lane stops reporting it as
    // live, or the run view would count it twice until the next session's
    // first `result`.
    if (shared) {
      delete shared.sessionUsd;
      delete shared.liveCostBase;
    }
    // Booked HERE, once, for every session this door spawns — the run, the
    // phase, the rung and the start ceiling — and before the ledger line, which
    // carries what was booked beside what the CLI reported (control-tower
    // phase 46, #62). The eight sites that each added the reported total are gone.
    const booking = this.bookSpend(phase, mode, outcome);
    this.noteSpendProof(phase, account, sent, outcome, booking.booked, shared);
    this.noteEnding(phase, mode, sent, outcome);
    this.record('phase.session', sessionRecordOf({ mode, request: sent, outcome, attempt: ctx.attempt }), phase);
    this.noteTokens(phase, mode, sent, outcome, ctx.attempt, lane ? { lane, tracker: pollTracker, before: pollBefore } : undefined, account);
    this.corroborateSpend(phase, mode, sent, outcome, booking, delegated);
    return outcome;
  }

  /**
   * A session that SPENT under the account and ended well is proof the account
   * can pay (control-tower phase 54, #78): its shared walls, the spent model's
   * own wall and a usage cooling lift (`deps.noteSpend`), and every phase of
   * this run parked on a wall is re-read at once rather than at its reported
   * reset. Only a success that booked money and ended by itself counts — a
   * refusal books nothing, a session that errored proves nothing about the
   * window, and one the console ended (a checkpoint at the wall itself, a
   * switch, the watchdog) wrote whatever its interrupted turn left.
   */
  protected noteSpendProof(
    phase: number, account: string, request: SpawnRequest, outcome: SpawnOutcome, booked: number, lane?: Lane,
  ): void {
    if (!(booked > 0) || outcome.signal?.subtype !== 'success' || outcome.signal.isError) return;
    if ((outcome.endedBy ?? outcome.signal.endedBy ?? 'exit') !== 'exit') return;
    if (lane?.checkpointed || lane?.stopped) return;
    let moved: { lifted: string[]; cooled: boolean } | void = undefined;
    try {
      moved = this.deps.noteSpend?.(account === 'default' ? undefined : account, request.model);
    } catch (error) {
      log.warn('runner.note-spend-failed', { account, error });
    }
    if (moved && (moved.lifted.length || moved.cooled)) {
      this.record('run.walls-lifted', { account, lifted: moved.lifted, cooled: moved.cooled, model: request.model ?? null }, phase);
      // New information for every phase the ladder left standing (#114): a
      // phase deferred or classified on a wall that is gone is judged again.
      this.forgetSeen();
    }
    this.rereadWalls('spend');
  }

  /** A session's mark on the phase record: the last total booked for it, or 0. */
  protected costMarkOf(phase: number, sessionId: string | null | undefined): number {
    if (!sessionId) return 0;
    return this.state?.phases[String(phase)]?.costHighWater?.[sessionId] ?? 0;
  }

  /**
   * Book what one spawn cost — the ONE writer of the run's and the phase's
   * dollars, the rung's charge and the start ceiling's $/hour (control-tower
   * phase 46, #62, CC-1..4). Called by the spawn door and nowhere else.
   *
   * The CLI's `total_cost_usd` is the conversation's running total: from CLI
   * 2.1.278 a `--resume` spawn carries everything the session spent before it.
   * Eight sites added it whole, so observability-plane P9 booked $44.51, $58.98,
   * $62.89 and $67.31 for spawns that spent $14.48, $3.91 and $4.42, and the
   * $/hour ceiling refused three starts on $297.29 "spent" in an hour that cost
   * $129.46. A spawn now books its rise over the session's mark
   * (`bookedDelta`), and the mark is kept on the phase record, so three resumes
   * of one session book exactly the CLI's final total.
   */
  protected bookSpend(
    phase: number, mode: SessionMode, outcome: SpawnOutcome,
  ): { booked: number; reported: number; mark: number; restarted: boolean } {
    const reported = typeof outcome.costUsd === 'number' && Number.isFinite(outcome.costUsd) ? outcome.costUsd : 0;
    const known = (outcome.costSource ?? (reported ? 'result' : 'none')) !== 'none';
    const sessionId = outcome.sessionId ?? null;
    const mark = this.costMarkOf(phase, sessionId);
    const delta = bookedDelta(mark, reported, known);
    outcome.bookedUsd = delta.booked;
    const state = this.state;
    if (state) {
      const record = phaseRecord(state, phase);
      if (sessionId && known && reported > 0) {
        // Re-inserted last, so the newest marks are the ones the bound keeps.
        const marks = { ...(record.costHighWater ?? {}) };
        delete marks[sessionId];
        marks[sessionId] = delta.mark;
        record.costHighWater = Object.fromEntries(Object.entries(marks).slice(-MAX_COST_MARKS));
      }
      state.spentUsd += delta.booked;
      record.costUsd += delta.booked;
      // The part of it spent on credit (control-tower phase 93, #146): the
      // rise past the running total at which the session went on credit, and
      // never more than this spawn booked.
      const credit = creditBooked(outcome.creditFromUsd, mark, reported, delta.booked);
      if (credit > 0) {
        state.creditUsd = (state.creditUsd ?? 0) + credit;
        record.creditUsd = (record.creditUsd ?? 0) + credit;
      }
      let rung = true;
      if (rung) chargeRung(state.recoveries?.[String(phase)], delta.booked);
      // Approaching (control-tower phase 14, #40): the dollars this spawn booked
      // may carry the run, or this phase, past BUDGET_WARN_PCT of its budget —
      // said once per limit for the run and once per attempt for the phase, so
      // a raise re-arms it and a restart does not repeat it.
      if (delta.booked > 0) {
        if (state.runBudgetUsd && budgetApproaching(state.spentUsd, state.runBudgetUsd)) {
          this.noteBudgetApproaching('run', phase, runBudgetFact(state), `run:${state.runBudgetUsd}`);
        }
        const cap = state.phaseBudgetUsd;
        if (cap && budgetApproaching(record.costUsd, cap)) {
          this.noteBudgetApproaching('phase', phase, phaseBudgetFact(phase, cap, record.costUsd, sessionSpend(record)),
            `${record.attempts ?? 0}:${cap}`);
        }
      }
    }
    if (delta.booked > 0) this.deps.startCeiling?.spendUsd(delta.booked);
    return { booked: delta.booked, reported, mark, restarted: delta.restarted };
  }

  /**
   * A budget at its warning line (`BUDGET_WARN_PCT`, control-tower phase 14,
   * #40): ONE `phase.budget-approaching` line and one `budget` event per budget
   * per `key` — the attempt and the limit it was measured against, claimed on
   * the phase record (or the run, for the run's own budget) so a restart does
   * not say it twice. The service turns the event into the push.
   */
  protected noteBudgetApproaching(
    holder: 'phase' | 'run', phase: number | null, fact: BudgetFact, key: string, extra: Record<string, unknown> = {},
  ): void {
    const state = this.state;
    if (!state) return;
    const owner = holder === 'run' || phase == null ? state : phaseRecord(state, phase);
    if (!claimBudgetWarning(owner, fact.budget, key)) return;
    // The fact itself stays on the holder until a raise answers it, so a page
    // can draw the approach with its raise BEFORE the park (phase 25, #40).
    owner.budgetApproaching = { ...(owner.budgetApproaching ?? {}), [fact.budget]: fact };
    this.record('phase.budget-approaching', {
      budget: fact.budget, limit: fact.limit, spent: fact.spent, left: fact.left, unit: fact.unit, key, ...extra,
    }, phase ?? undefined);
    this.emit('budget', { phase, state: 'approaching', key, fact, ...extra });
    this.persist();
  }

  /**
   * A phase that stopped on its DOLLAR cap (control-tower phase 14, #40): its
   * last session spent the cap it was given, doubled on every resume until the
   * attempts ran out. Announced as the budget it is, with each session's share;
   * the raise the card offers writes `phaseBudgetUsd` and retries the phase.
   */
  protected notePhaseBudgetSpent(phase: number): void {
    const state = this.state;
    if (!state) return;
    const record = phaseRecord(state, phase);
    const cap = record.lastSession?.maxBudgetUsd?.value;
    if (!(typeof cap === 'number' && cap > 0)) return;
    const fact = phaseBudgetFact(phase, cap, record.costUsd, sessionSpend(record));
    this.emit('budget', { phase, state: 'spent', fact });
  }

  /**
   * How the phase's newest session ended, on its record (`lastSession`) — what
   * `closed()` reads before it calls a missing handoff a failure
   * (control-tower phase 46, #61).
   */
  protected noteEnding(phase: number, mode: SessionMode, request: SpawnRequest, outcome: SpawnOutcome): void {
    if (!this.state) return;
    const caps = outcome.caps ?? resolveCaps(request);
    const signal = outcome.signal ?? {};
    phaseRecord(this.state, phase).lastSession = {
      mode, sessionId: outcome.sessionId ?? null, at: this.now().toISOString(), endedBy: outcome.endedBy ?? 'exit',
      ...(signal.subtype ? { subtype: signal.subtype } : {}),
      ...(signal.terminalReason ? { terminalReason: signal.terminalReason } : {}),
      maxTurns: caps.maxTurns, maxBudgetUsd: caps.maxBudgetUsd,
    };
  }

  /**
   * The booked figure beside what the session's own calls are worth
   * (control-tower phase 46, #62, CC-5): `phase.cost-mismatch` when the two
   * disagree past tolerance (`costMismatch`). Journalled, never acted on — it
   * blocks nothing and corrects nothing; it is the evidence a wrong booking
   * (a re-reported total, a CLI that changes what it reports) leaves behind. A
   * session with no calls, or on a model with no measured price, is not judged.
   *
   * Each model at its OWN rates (control-tower phase 109, #202), and a ratio
   * its fresh sessions all sit at is the price drifting, not the bookings: the
   * console's `CostDrift` announces it once (`phase.cost-drift`) and is quiet
   * about the sessions it explains for the rest of the day.
   */
  protected corroborateSpend(
    phase: number, mode: SessionMode, request: SpawnRequest, outcome: SpawnOutcome,
    booking: { booked: number; reported: number; mark: number }, delegated: boolean,
  ): void {
    const tokens = outcome.tokens;
    if (!tokens || tokens.calls <= 0) return;
    const record = this.state?.phases[String(phase)];
    const model = outcome.resolvedModel ?? record?.actualModel ?? request.model ?? record?.model ?? null;
    const priced = priceUsage(model, tokens);
    const mismatch = costMismatch({ booked: booking.booked, priced, delegated });
    if (!mismatch || priced === null) return;
    const round4 = (usd: number) => Math.round(usd * 10_000) / 10_000;
    const figures = {
      mode, sessionId: outcome.sessionId ?? null, model, resumed: Boolean(request.resume),
      bookedUsd: round4(booking.booked), pricedUsd: round4(priced), reportedUsd: round4(booking.reported),
      markUsd: round4(booking.mark), direction: mismatch.direction, ratio: mismatch.ratio,
      calls: tokens.calls, delegated,
    };
    const verdict = this.costDrift.note({
      model: priceRowOf(model) ?? String(model), ratio: mismatch.ratio, direction: mismatch.direction,
      fresh: !request.resume && !delegated, at: this.now().getTime(),
    });
    if (verdict.kind === 'explained') return;
    if (verdict.kind === 'drift') {
      this.record('phase.cost-drift', {
        ...figures, model: priceRowOf(model) ?? model, ratio: verdict.ratio, sessions: verdict.sessions, since: verdict.since,
      }, phase);
      return;
    }
    this.record('phase.cost-mismatch', figures, phase);
  }

  /**
   * `phase.tokens`, and the session's entry on the phase record (`record.tokens`)
   * — once per session, as it ends (autopilot-token-drain phase 3). Only for a
   * session that made an API call: a harness's fake and a child that never
   * started report none, and a line of zeros would claim it cost nothing.
   *
   * `poll` is the phase's own lane and its poll-loop counts when this session
   * started, so the status checks booked are this session's rather than the
   * lane's since boarding; a tracker replaced mid-session counted only this
   * session's calls, so it is read whole. `account` is the one it was spawned
   * under — what the resume policy compares with the account paying later.
   */
  protected noteTokens(
    phase: number, mode: SessionMode, request: SpawnRequest, outcome: SpawnOutcome, attempt: number | undefined,
    poll: { lane: Lane; tracker: PollLoopState | undefined; before: { status: number; denied: number } | undefined } | undefined,
    account = 'default',
  ): void {
    const tokens = outcome.tokens;
    if (!tokens || tokens.calls <= 0) return;
    const record = this.state?.phases[String(phase)];
    const window = contextWindowOf([request.model, record?.actualModel], loadModelsEnv(this.deps.scriptsDir));
    let polls: { pollCalls: number; pollDenied: number } | undefined;
    if (poll) {
      const now = poll.lane.signals.pollLoop?.counts;
      const from = poll.tracker && poll.lane.signals.pollLoop === poll.tracker ? poll.before : undefined;
      polls = {
        pollCalls: Math.max(0, (now?.status ?? 0) - (from?.status ?? 0)),
        pollDenied: Math.max(0, (now?.denied ?? 0) - (from?.denied ?? 0)),
      };
    }
    const line = {
      mode,
      ...(attempt !== undefined ? { attempt } : {}),
      sessionId: outcome.sessionId ?? null,
      resumed: Boolean(request.resume),
      model: request.model ?? null,
      window,
      ...tokens,
      ...(polls ?? {}),
      account,
    };
    this.record('phase.tokens', line, phase);
    if (!record) return;
    const entry: TokenAttempt = { ...line, endedAt: this.now().toISOString() };
    record.tokens = [...(record.tokens ?? []), entry].slice(-MAX_TOKEN_ATTEMPTS);
    this.persist();
  }

  /**
   * The relay's arming for this run, recorded when it CHANGES (phase 14): the
   * run's `relayArming`, one `run.relay-refused {version, floor, reason}` for a
   * refusal and one `run.relay-armed {version, floor}` when it arms, and the
   * settings file rewritten so the next child loads — or no longer loads — the
   * `PermissionRequest` hook.
   */
  protected noteRelayArming(arming: { armed: boolean; version: string | null; floor: string; refused?: 'below-floor' | 'version-unknown' }): void {
    const state = this.state;
    if (!state) return;
    const before = state.relayArming;
    if (before && before.armed === arming.armed && before.reason === arming.refused) return;
    state.relayArming = {
      armed: arming.armed, version: arming.version, floor: arming.floor,
      ...(arming.refused ? { reason: arming.refused } : {}), at: this.now().toISOString(),
    };
    if (arming.refused) {
      this.record('run.relay-refused', { version: arming.version, floor: arming.floor, reason: arming.refused });
    } else if (arming.armed) {
      this.record('run.relay-armed', { version: arming.version, floor: arming.floor });
    }
    if (!before || before.armed !== arming.armed) {
      try { this.rearmRelay(arming.armed); } catch (error) { log.warn('runner.relay-arming-failed', { what: 'settings', error: String(error) }); }
    }
    this.persist();
  }

  /**
   * The phase's MCP document with the relay's presence-only host added — the
   * servers this phase already resolved (read back from the file `armMcp` just
   * wrote) and `pcrelay` beside them. A relay-armed session therefore always
   * runs `--strict-mcp-config`: the host has to be IN the set, and the flag is
   * what makes the resolved set the whole set.
   */
  private relayMcpDoc(existing: string | undefined): McpConfigDoc {
    let doc: McpConfigDoc = { mcpServers: {} };
    if (existing) {
      try {
        const parsed = JSON.parse(readFileSync(existing, 'utf8')) as Partial<McpConfigDoc>;
        if (parsed.mcpServers && typeof parsed.mcpServers === 'object') doc = { mcpServers: { ...parsed.mcpServers } };
      } catch { /* an unreadable phase document: the host alone, and the phase's servers are named in its prompt */ }
    }
    doc.mcpServers[RELAY_HOST_SERVER] = relayHostConfig();
    return doc;
  }

  /** Write the relay-armed document, or null — a session that cannot have its host runs on the floor. */
  private writeRelayConfig(phase: number, doc: McpConfigDoc): string | null {
    try {
      return writeMcpConfigFile(this.state!.id, phase, doc);
    } catch (error) {
      log.warn('runner.relay-arming-failed', { what: 'mcp-config', error: String(error) });
      return null;
    }
  }

  /**
   * One stream event, read at the door for the ledgers that belong to no lane:
   * the CLI version a session's `system/init` reports (every later arming is
   * judged on it), the relay's two degradations on an armed session — no
   * `AskUserQuestion` in `system/init.tools`, or its host not `connected` in
   * `system/init.mcp_servers` (the exit code never says, DOC-5) — a
   * `control_request` the CLI sent, and a turn that ended on a `defer`.
   */
  private noteSessionEvent(phase: number, event: StreamEvent, armed: boolean, binary: string | undefined): void {
    const state = this.state;
    if (!state) return;
    if (event.kind === 'init') {
      if (event.version) this.deps.noteCliInit?.(event.version, binary);
      if (!armed) return;
      if (event.version) {
        const read = relayArmingFor(state.relay, event.version);
        if (!read.armed) this.noteRelayArming(read);
      }
      const degraded = (reason: string, data: Record<string, unknown>) => {
        const key = `${state.id}:${reason}`;
        if (this.relayDegradedFor.has(key)) return;
        this.relayDegradedFor.add(key);
        this.record('run.relay-degraded', { reason, ...data }, phase);
      };
      if (event.toolNames && !event.toolNames.includes('AskUserQuestion')) {
        degraded('tool-absent', { tools: event.toolNames.length });
      }
      const host = event.mcpServers?.find((server) => server.name === RELAY_HOST_SERVER);
      if (event.mcpServers && host?.status !== 'connected') {
        degraded('host-not-connected', { status: host?.status ?? 'absent' });
      }
      return;
    }
    if (event.kind === 'control-request') {
      this.record('phase.control-request', {
        ...(event.requestId ? { requestId: event.requestId } : {}),
        ...(event.subtype ? { subtype: event.subtype } : {}),
        ...(event.tool ? { tool: event.tool } : {}),
      }, phase);
      return;
    }
    if (event.kind === 'deferred') {
      this.record('phase.tool-deferred', {
        ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
        ...(event.tool ? { tool: event.tool } : {}),
      }, phase);
    }
  }

  /**
   * Is the whole console frozen? Asked by everything in this runner that spawns.
   *
   * The scheduler's fleet holder covers every session that goes through
   * `admit()`, which is every PHASE — and the runner has three sessions that do
   * not: the auto-reviewer, the closeout, and the final pull-request session.
   * All three are paperwork spawned from inside the loop, after a phase's own
   * lane has already resolved and its pid has been nulled, so a Freeze-all
   * landing in that window used to mark the lane frozen and start a fresh
   * `claude` anyway. That is precisely the "it said frozen and kept working"
   * report, and the admission gate could never have caught it.
   *
   * A throwing dep reads as NOT frozen, the same fail-open direction the
   * scheduler and the convergence loop take: a console that wrongly believes
   * itself frozen stops silently and looks like a console with nothing to do.
   */
  protected fleetFrozen(): { at: string; by?: string; scope?: 'machine' | 'restart' } | null {
    let hold: { at: string; by?: string; scope?: 'machine' | 'restart'; plans?: readonly string[] } | null;
    try { hold = this.deps.fleetHold?.() ?? null; } catch { return null; }
    // A restart waiting for its lanes holds only the plans that meet their
    // scope (control-tower phase 48, #70); to every other run it is no hold.
    return holdBinds(hold, this.state?.slug) ? hold : null;
  }

  /** How many phases of THIS run may be in flight. The scheduler caps the fleet. */
  protected maxLanes(): number {
    const max = typeof this.deps.maxParallel === 'function'
      ? this.deps.maxParallel()
      : this.deps.maxParallel;
    const wanted = this.state?.maxParallel ?? max ?? 1;
    return Math.max(1, wanted);
  }

  /**
   * The shutdown-handler key for a run.
   *
   * Named per run because the registry is name-keyed: with a pool, two runners
   * registering `'runner'` would evict each other's checkpoint handler, and the
   * evicted one would be the run that silently failed to checkpoint on the way
   * out.
   */
  protected shutdownKey(runId: string): string { return `runner:${runId}`; }

  /** What this phase touches, for admission and for the child's `PE_SCOPE`. */
  protected async scopeFor(phase: number): Promise<string[]> {
    const state = this.state!;
    const declared = await this.deps.phaseScope?.(state.slug, phase);
    // Saying nothing means it could touch anything — the same fail-safe
    // `scopeOfRow` takes on an empty Repos cell.
    return declared?.length ? declared : ['all'];
  }

  /**
   * Whether what is driving is a recovery rather than the phase loop.
   *
   * Both set `driving`, and they answer differently to exactly one control:
   * there is no phase boundary in a recovery for a Pause to wait at. See `pause`.
   */
  recoveringNow(): boolean { return this.recovering; }

  /**
   * Why a control aimed at a named phase cannot act, or null when it can.
   *
   * Naming a phase is not decoration. A control tapped on a phone reaches this
   * server whole seconds later, by which time the phase it was aimed at may
   * have ended — and freezing whatever started next is a different act from the
   * one that was asked for. Naming nothing still means "whatever is running",
   * which is what every caller before per-phase controls did, so this answers
   * null and changes nothing for them.
   */
  phaseMismatch(phase?: number | null): string | null {
    if (phase == null) return null;
    // Asked of the lane table, not of the mirror. With several phases in
    // flight, `state.child` names one of them — so a control correctly aimed
    // at a live lane that happens not to be the mirror would be refused with
    // "phase 5 is not the one running", while phase 5 was running perfectly.
    if (this.lanes.has(phase)) return null;
    const running = this.livePhases();
    if (!running.length) {
      return this.driving
        ? `phase ${phase} has no session running just now — the run is between phases, or verifying`
        : `phase ${phase} has nothing running to act on`;
    }
    return running.length === 1
      ? `phase ${phase} is not the one running — phase ${running[0]} is`
      : `phase ${phase} is not one of the ones running — phases ${running.join(', ')} are`;
  }
  /** Resolves once the loop has stopped driving. */
  async wait(): Promise<void> { await this.driving; }

  /** What the last fill pass decided — `boardingVerdict` reads it (control-tower phase 86, RS-5). */
  protected lastFill: { at: number; order: number[]; inFlight: number[]; max: number } | null = null;

  /**
   * Did a person's press BOARD the phase, or queue it? (control-tower phase 86,
   * RS-5, #128's 2026-09-25T20:04Z comment.) A re-board is a hint, and a hint
   * is not a launch: `boarded` only when the phase's lane holds its grant — it
   * boards at this admission — else `queued`, with its 1-based position in the
   * line it waits in (the scheduler's queue, else this run's boarding order)
   * and what it is behind. `start` returns before the loop has decided
   * anything, so this waits, bounded, for the next fill pass or the recovery's
   * admission; a loop that decides nothing in time answers `position: null`.
   */
  async boardingVerdict(phase: number, waitMs = BOARDING_VERDICT_MS): Promise<BoardingVerdict> {
    const asked = Date.now();
    for (;;) {
      // A lane holding its grant boarded; so did any lane of a runner with no
      // scheduler behind it, which grants nothing and queues nothing.
      const lane = this.lanes.get(phase);
      if (lane && (lane.grant || !this.deps.scheduler)) return { boarded: true };
      const runId = this.state?.id;
      const entry = runId ? this.deps.scheduler?.snapshot().entries.find((e) => e.runId === runId && e.phase === phase) : undefined;
      if (entry) {
        const head = entry.waitingOn[0];
        return {
          queued: {
            position: (entry.order ?? 0) + 1,
            ...(head ? { behind: { kind: head.kind, slug: head.slug, phase: head.phase, owner: head.owner } } : {}),
          },
        };
      }
      const fill = this.lastFill;
      if (fill && fill.at >= asked && !fill.inFlight.includes(phase)) {
        const line = fill.order.filter((p) => !fill.inFlight.includes(p));
        const at = line.indexOf(phase);
        const serial = this.state?.phases[String(phase)]?.serialBehind;
        const slug = this.state?.slug ?? '';
        const behind = serial != null
          ? { kind: 'serial', slug, phase: serial, owner: `phase ${serial} of this run, on the same scope` }
          : fill.inFlight.length >= fill.max
            ? { kind: 'lanes', slug, phase: null, owner: `all ${fill.max} of this run's lanes are busy` }
            : null;
        return { queued: { position: at >= 0 ? at + 1 : null, ...(behind ? { behind } : {}) } };
      }
      if (Date.now() - asked >= waitMs || !this.driving) return { queued: { position: null } };
      await new Promise((done) => { setTimeout(done, 25); });
    }
  }

}

/** What each of a phase's sessions spent, from its cost high-water marks — the `spentOn` of a phase budget. */
function sessionSpend(record: { costHighWater?: Record<string, number> }): { what: string; amount: number }[] {
  return Object.entries(record.costHighWater ?? {}).map(([session, usd]) => ({ what: `session ${session.slice(0, 8)}`, amount: usd }));
}
