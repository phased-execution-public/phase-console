/**
 * `RunnerControl` — link 2 of the `Runner` chain.
 *
 * One contiguous section of a class that outgrew one file. The chain is a
 * FILE boundary, not a design boundary: members keep their order, their
 * bodies and their single prototype, so `Runner` behaves exactly as it did
 * when this was one declaration — including for the tests that reach its
 * private members. `protected` here means "another link uses it", nothing
 * more. Read the chain in order; `runner.ts` holds the concrete class.
 */
import { parkOnStep, stepJournalFields } from '../human-steps.ts';
import { refusalFields } from '../turn/guard.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { cpus, homedir, loadavg } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { log } from '../log.ts';
import { onShutdown, offShutdown } from '../lifecycle.ts';
import type { ConnectivityProbe } from '../connectivity-probe.ts';
import { run as engineRun, readMemoryBlock, readGateStatus, readLint, readText, type Board } from '../engine.ts';
import { mcpDirective, skillDirective } from '../skills.ts';
import { FOLLOW_UP_RUNG, FOLLOW_UP_SITUATION, MAX_FOLLOW_UP_BYTES } from '../review.ts';
import {
  classify, fallbackChain, limitBucket, nextModel, resetWaitUntil, MODEL_FALLBACK, type Disposition, lostResume,
} from './errors.ts';

/**
 * `resumeWithInstruction`'s third answer: the session it was asked to resume is
 * gone — or, with `policy`, there and not worth resuming (the gate's `fresh`).
 */
type ResumeLost = { lost: string; policy?: ResumePolicy };
import { continueMcpParkedRecord, DEFAULT_MCP_REQUIRE_TIMEOUT_MS, type McpContinueResult } from './mcp-park.ts';
import { markFor, spawnClaude, type SpawnFn, type SpawnHandle, type StreamEvent } from './spawn.ts';
import { killLadder, stopWhereItStands, wake } from './signals.ts';
import { capsFor, consoleEnded, type SessionCaps } from './session-record.ts';
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
  applyEvent, creditHeldTime, evaluateStall, isProductiveEvent, livenessOf, newLaneSignals, stallThresholds,
  type LaneLiveness, type LaneSignals, type StallState, type StallThresholds,
} from './liveness.ts';
import { ingestRulings, rulingsFile, type Ruling } from './rulings.ts';
import {
  classifySituation, collectEvidence, situation as situationOf, workEvidence,
  type EvidenceDeps, type PhaseEvidence, type Situation,
} from './situation.ts';
import {
  accountPersonRung, accountRung, boardInPersonSlot, budgetFirst, errandFor, forgiveRungs, nextRung, personSituationOf, replenishedPayload, retryForgives,
  rungKey, rungsFor, settleRung, DEFAULT_LADDER_CAPS, PERSON_SLOT_BY, type LadderCaps, type Rung,
} from './ladder.ts';
import { checkouts, ensureErrandTree, mountsFromRepos, readMirror } from './worktree.ts';
import { closeQueueEpisode, foldRunBlocked, noteQueueHead, openQueueEpisode, seniorityOf } from './queue-episodes.ts';
import { branchHoldNow, readHolds, TREE_POLL_MS, type BranchHoldView, type TreeHold } from './tree-state.ts';
import { resumePolicy, type ResumePolicy } from './usage.ts';
import {
  clockOf, ENGINE_BUSY_BACKOFF_MS, inputCloseWords, reboardResumeBrief, resumePolicyInstruction, resumePolicyWhy, sessionLostInstruction,
} from './runner-core.ts';
import type { RungRecord } from './state.ts';
import { wallOfHookDenial, withWall, type RecordedWall } from '../permissions/walls.ts';
import { accountPool, applyErrandAnswer, identityChangeWords, identityEcho, keepAccountInPool, launcherAlive, manifestEcho, rankInPool, type ErrandAnswer } from './state.ts';
import {
  childrenOf, endLockWait, loadRun, newRun, orphanAdvice, phaseRecord, procIdentity, retirePhaseHalt, retireSettledErrands, runDir, saveRun, pidAlive, pidHoldsWork, IN_FLIGHT, SETTLED,
  setPhaseState, setRunState,
  PHASE_IN_FLIGHT, reconcileRecordsAgainstBoard, resetStreak, streakPhases, clearBudgetHold, mcpReasonText, resetForRetry, consoleStoppedNote,
  settleInFlightRecords,
  type Autonomy, type BoardingBrief, type BoardingHint, type ChildRef, type EndedBy, type Errand, type HaltKind,
  type McpDegradation, type RunArtefact, type McpPolicy,
  type OnLimitPolicy, type PhaseOptions, type PhaseRecord, type PreflightWarning,
  type RetryOverride,
  type RunState, type PhaseStatus, type RunStatus, type VerifySummary, clearWatchBookkeeping, isSessionGone,
  chargeDeclaration, consumeDeclaration, prepareReboard, syncWaitClock, retireSpentBudget, DECLARATION_REFUSED_EVENT,
  type Actor, type FailureRoot,
} from './state.ts';
import { asActor, isPersonsAct, stoppedByOf, unattributedActor, type StartActor } from '../actor.ts';
import { consumeOutcome, outcomeFileFor, readOutcome, type PhaseOutcome, needsOf } from './outcome.ts';
import {
  applyQueueControl, entryControlOf, laneMarkRefusal, QUEUE_REORDERED_EVENT, type PhaseQueueVerb, type QueueControlOptions,
} from './queue-control.ts';
import { DEFAULT_SCHEDULING_POLICY, schedulingPolicy, type SchedulingPolicy } from '../../shared/orchestration-model.js';
import {
  AdmissionAborted, AdmissionCapped, AdmissionSerial, AdmissionWithdrawn, LEARNED_WALL_BUCKET, SCHEDULE_HOLDER, autopilotOwner, holderClass,
  holdersKey, isCappableBlocker, isOwnLiveLane,
  type AdmitRequest, type Holder, type Promotion, type Scheduler, type ScopeGrant,
} from './scheduler.ts';
import type { LeaveReason, LeaveResult } from '../accounts/index.ts';
import type { PortResult } from '../accounts/transcripts.ts';
import { formatScope, SHARED_CHECKOUT_TOKEN } from '../../shared/scope.js';
import { ISOLATED, SETTLE_PUSHES, settleOf } from '../../shared/worktree-model.js';
import { Journal } from './journal.ts';
import { type ReplayLimit, Transcript } from './transcript.ts';
import { checkAuth, type AuthStatus } from './auth.ts';
import {
  buildSettings, writeSettingsFile, loadPolicyFor, dropSettingsFileFor, PLAN_HOST_SETTINGS_SUFFIX,
  type Approvals, type PermissionProfile,
} from './approvals.ts';
import { dropMcpConfigsFor } from '../mcp/config.ts';
import {
  CLOSEOUT_MAX_TURNS, DEFAULT_BUDGET_RAISE_PCT, LADDER_STATES, declarationCooldownFor, declaredClock, ladderClassifies, RECOVER_MAX_PER_PHASE, REPAIR_MAX_TURNS, LEASE_REFRESH_MS, LIMIT_ACTION_COOLDOWN_MS, LIMIT_RETRY_BURST, LIMIT_RETRY_WINDOW_MS, LIVENESS_GIT_EVERY_MS, LIVENESS_TICK_MS, LOCK_BACKOFF_MAX_MS, LOCK_CAP_PARK_NOTE, LOCK_WAIT_CAP_MS, QUEUE_SEEN_PERSIST_MS, MAX_ATTEMPTS, MAX_INJECT_KEYS, MAX_OPEN_ASKS, MCP_AUTH_PARK_NOTE, MCP_PARK_NOTE, SHUTDOWN_LADDER_MS, SIGTERM_GRACE_MS, TEARDOWN_SETTLES, VERIFICATION_PARK_NOTE, VERIFY_ANSWER_MS, VERIFY_TIMEOUT_MS, DEFAULT_WAIT_BUDGET_MS, WAIT_DEFAULT_MS, WAIT_MAX_PER_PHASE, applyRungCaps, applySettings, authRefusal, briefForRung, closeoutPrompt, condenseSaid, escalateModel, fixVerificationInstruction, frameQuestion, frameRelayNotice, frameSteer, prBlockText, preflight, reasonOf, settingsBefore, settingsOverridden, settingsSnapshot, survivingChildren, unattendedDirective, waitResumePrompt, wakeSignal, type AskResult, type Lane, type McpResolution, type ReboardRequest, type RecoverMode, type RecoverOptions, type RunSettingsPatch, type RunnerDeps, type RunnerEvent, type StartOptions, type ResumeVerdict, type VettedResume,
} from './runner-core.ts';
import { answeredByPhrase, type QuestionAnsweredBy } from '../../shared/relay-model.js';
import type { Runner } from './runner.ts';
import { RunnerBase } from './runner-base.ts';
import type { QueueKind } from '../../shared/run-lifecycle.js';
import {
  DEFAULT_MODEL_POLICY, OWN_LOCK_WATCH_REFUSAL, isMeritFailure, type FailureCause, type SwitchWhen,
} from '../../shared/run-lifecycle.js';
import { closeWaitEntry, parkedMsOf, runBudgetFact, screenDeclaration, screenedFields } from './wait-budget.ts';
import { budgetHeadline, type BudgetKind } from '../../shared/budget-model.js';
import { envCarrier } from '../trace.ts';

/**
 * Run words that already say the run stopped — so a repair's own ending does
 * not overwrite one somebody else wrote. `halting` is a DRAIN: the finalizer
 * lands it on `parked`/`halted` itself, and jumping it here would let a
 * console that died mid-drain read the run as final with children still live.
 */
const RUN_ALREADY_ENDED: readonly RunStatus[] = [
  'parked', 'halted', 'halting', 'finished', 'paused', 'waiting',
  // 🔴 `stopping` and `pausing` belong here for a different reason from the
  // rest, and leaving them out was measurably wrong: they mean SOMEBODY WITH
  // MORE AUTHORITY already has this run. Writing `parked` over one erases the
  // press — `stoppedByOperator` reads `stopping` as true and `parked` as false,
  // so the convergence loop stops treating the run as pinned, may relaunch it
  // ("the operator's own stop is never touched"), and pushes a heal. The same
  // pair every other authority check in the loop uses.
  'stopping', 'pausing',
];

/** One repository's checkouts and `pe/*` branches at a moment in time. */
type ArtefactSnapshot = { repo: string; trees: Map<string, string | undefined>; branches: Set<string> }[];

export abstract class RunnerControl extends RunnerBase {
  /* ---------------------------------------------------------------- *
   * Starting, and picking up where something left off
   * ---------------------------------------------------------------- */

  async start(options: StartOptions): Promise<RunState> {
    if (this.driving || this.starting) throw new Error('A run is already in progress. Pause or stop it first.');
    // The runner is BUSY from here until the loop is driving or the start has
    // returned (control-tower phase 53, #56). `begin` awaits — the auth probe,
    // the account doors — with `this.state` already the run it will persist;
    // while `busy()` read false across that window, a person's switch (or any
    // control) took the stored-run path, wrote the file, and was overwritten
    // by this method's own next save. Busy, the control lands on the state
    // object that is persisted.
    this.starting = true;
    try {
      return await this.begin(options);
    } finally {
      this.starting = false;
    }
  }

  private async begin(options: StartOptions): Promise<RunState> {
    const state = options.resumeRunId
      // No live id: by definition nothing is driving anything, or the guard
      // above would have thrown. Reconciling here is what turns a run left
      // claiming "running" by a killed console into one that can be continued.
      ? loadRun(options.root, options.slug, options.resumeRunId, null)
      : null;
    if (options.resumeRunId && !state) throw new Error(`No run ${options.resumeRunId} for ${options.slug}.`);
    let resumedStreak = 0;
    /** The stored run's settings before a resume applied its own (`run.resume-settings`). */
    let resumedFrom: Partial<RunState> | null = null;
    /** The freezes this start ruled on, held until the journal exists to say so. */
    const ruledFreeze: (PersistedEscalation & { overdue: boolean })[] = [];

    this.state = state ?? newRun({
      slug: options.slug,
      root: options.root,
      model: options.model,
      effort: options.effort,
      // QA's own three. Listed here for `maxConsecutiveFailures`' reason, three
      // lines down: this copy is by hand, so a field the door accepts and this
      // list forgets reaches the run as silence — the run starts, looks healthy
      // and simply is not the run that was asked for.
      qaModel: options.qaModel,
      qaEffort: options.qaEffort,
      qaMaxRounds: options.qaMaxRounds,
      // The run's own ladder rung caps (control-tower phase 5, #14) — by
      // hand, for the reason above.
      ladderPerRunRungs: options.ladderPerRunRungs,
      ladderPerPhaseRungs: options.ladderPerPhaseRungs,
      autonomy: options.autonomy,
      phaseBudgetUsd: options.phaseBudgetUsd,
      runBudgetUsd: options.runBudgetUsd,
      maxConsecutiveFailures: options.maxConsecutiveFailures,
      // The run's own lane cap — by hand, for the same reason. It was the one
      // field the list forgot: a Continue applied it (below) and a fresh start
      // did not, which the fifth live rehearsal read as `--max-sessions 6` on
      // the console and nothing on the run (many-plans-one-repo phase 17).
      maxParallel: options.maxParallel,
      onlyPhases: options.onlyPhases,
      phaseOptions: options.phaseOptions,
      skills: options.skills,
      mcpServers: options.mcpServers,
      mcpPolicy: options.mcpPolicy,
      permissionProfile: options.permissionProfile,
      // The run's default permission mode (control-tower phase 11) — by hand,
      // and on the Continue branch below too, for `maxParallel`'s reason.
      permissionMode: options.permissionMode,
      gitMode: options.gitMode,
      openPr: options.openPr,
      isolation: options.isolation,
      settle: options.settle,
      priority: options.priority,
      startAfter: options.startAfter,
      reviewEachPhase: options.reviewEachPhase,
      reviewerPolicy: options.reviewerPolicy,
      ultracode: options.ultracode,
      ultraReview: options.ultraReview,
      // Phase 15's seven — by hand, for `maxConsecutiveFailures`' reason above.
      baseBranch: options.baseBranch,
      maxConcurrentPerRepo: options.maxConcurrentPerRepo,
      worktreeRetention: options.worktreeRetention,
      landing: options.landing,
      conflictPolicy: options.conflictPolicy,
      messaging: options.messaging,
      issuesMode: options.issuesMode,
      accountId: options.accountId,
      onLimit: options.onLimit,
      modelPolicy: options.modelPolicy,
      autoRecover: options.autoRecover,
      // The prelude's answers and the manifest it resolved (phase 11) — by
      // hand, for the reason above.
      resumeOnRestart: options.resumeOnRestart,
      relay: options.relay,
      accounts: options.accounts,
      acknowledgedWaivers: options.acknowledgedWaivers,
      manifest: options.manifest,
      verifyApprovals: options.verifyApprovals,
      // The plan git lines this run runs over (control-tower phase 11, #18) —
      // a fresh run's only; a Continue keeps what its launch answered.
      gitStrategyOverride: options.gitStrategyOverride,
    });

    // Who is starting this — read here because the two rules below turn on
    // it (RCV-3): a PRESS is a person back in the loop; a door opened by a
    // clock, a boot or an observation is the console talking to itself.
    const actor: Actor = options.actor ?? unattributedActor('Runner.start');
    const press = stoppedByOf(actor) === 'operator';

    if (state) {
      // A run that stopped on its failure streak is relaunched by nobody but a
      // person (RCV-3). The convergence loop's own relaunch used to be the
      // thing that answered a `failure-streak` halt — the one run-level "this
      // plan is broken, stop" bound — and it zeroed the counter on the way in:
      // 25 resets against 3 such halts, a plan failing indefinitely two phases
      // at a time. The planner now never proposes the relaunch (`converge.ts`
      // `PRESS_ONLY_HALT_KINDS`); this is the belt beneath it, for the door
      // that carries the loop's own word. Every other door — the healer's
      // rungs, a watch landing, a recovery's continue — passes, streak intact.
      const spent = state.halt?.kind === 'failure-streak'
        || (state.maxConsecutiveFailures > 0 && state.consecutiveFailures >= state.maxConsecutiveFailures);
      if (spent && !press && actor.door === 'converge-relaunch') {
        this.journal = Journal.for(state.root, state.slug, state.id);
        this.record('run.relaunch-refused', {
          reason: 'failure-streak',
          consecutiveFailures: state.consecutiveFailures, max: state.maxConsecutiveFailures,
          ...(state.halt ? { halt: state.halt.kind } : {}),
          ...actor,
        });
        log.warn('runner.relaunch-refused', {
          runId: state.id, slug: state.slug, door: actor.door, consecutiveFailures: state.consecutiveFailures,
        });
        this.journal = null;
        this.state = null;
        return state;
      }
      // Resuming: the halt that stopped it has been seen, and anything left
      // mid-flight is reconciled before a new child is started.
      this.state.halt = null;
      // A person's Repair checkout press rides this resume into the drive's
      // checkout decision, which spends it (control-tower phase 90, #139).
      if (options.repairCheckout) {
        this.state.repairCheckout = { at: new Date().toISOString(), by: options.repairCheckout.by };
      }
      this.state.waitUntil = null;
      this.state.waitReason = null;
      // A pause recorded by a console that is no longer here would otherwise
      // stop this loop before it ran anything.
      this.state.pause = null;
      // Same for the last run's closing words: they describe the run that
      // stopped, not the one about to start.
      //
      // The freeze is NOT in that class, and treating it as one is how the
      // console retracted a promise it had drawn on screen. `escalateAt` is
      // rendered to the operator as a durable commitment ("left frozen past
      // 18:11 it converts to a checkpoint"); an unconditional erase here meant
      // that pressing Continue after a restart threw away both the deadline
      // and the pid of a child that may still be stopped in the background —
      // the orphan, with nothing left pointing at it. So it is RULED on, and
      // the null is the outcome of the ruling rather than a reflex: a freeze
      // still inside its window is escalated only because starting the run
      // ends it either way, and one past its window escalates properly, waking
      // the child before asking it to stop.
      // `scope: 'slot'` — the RUN's freeze, which starting the run ends either
      // way. A frozen CHILD is deliberately NOT this method's case: `adopt`
      // parks the run and prints the `kill -CONT` remedy, which is the better
      // answer for a session somebody may still want back. See
      // `PersistedEscalationDeps.scope`.
      if (this.state.freeze) {
        const overdue = freezeVerdict(this.state.freeze, this.now().getTime()).kind === 'escalate';
        // Journalled below rather than here: `this.journal` is not constructed
        // until further down this same method, and `record()` is null-safe, so
        // writing the line at this point would drop it in silence.
        for (const outcome of escalatePersistedFreeze(this.state, { scope: 'slot' })) {
          if (outcome.escalated) ruledFreeze.push({ ...outcome, overdue });
        }
      }
      delete this.state.finishedReason;
      // And for the stop's paperwork. A resolution — auto or manual — annotates
      // the stop that was showing, and a reopen-veto protects that annotation;
      // resuming ends the stop they were both about. Left in place, a stale
      // `resolved` made a resumed run's SECOND halt raise no card at all
      // (autoResolveRun short-circuits on it, and the UI reads resolved as
      // dismissed) — a real run halted twice and said nothing the second time.
      this.state.resolved = null;
      this.state.reopenedAt = null;
      // Whoever stopped it last, the run is being started again now — and the
      // run-level errand was about that stop.
      delete this.state.stoppedBy;
      delete this.state.errand;
      const blocked = this.adopt(this.state);
      if (blocked) { this.persist(); return this.state; }
      // An operator pressing Start/Continue is a person back in the loop — the
      // same signal `park()` treats as clearing the slate. Carried across the
      // resume, a spent failure budget meant the continued run halted on its
      // first stumble, however long ago the failures it inherited were.
      // ONLY a person's press, though (RCV-3): an automatic relaunch — the
      // convergence loop, a watch landing, a boot re-adoption — carries the
      // streak forward, because it is the loop reacting to the very failures
      // the streak counts, and a reset there let a broken plan fail for ever.
      if (press) {
        resumedStreak = resetStreak(this.state);
      }
      // What the run WAS, before this start applies anything it names — the
      // other half of `run.resume-settings`, written once the journal exists.
      resumedFrom = settingsSnapshot(this.state);
      if (options.model) this.state.model = options.model;
      if (options.effort) this.state.effort = options.effort;
      if (options.permissionMode) this.state.permissionMode = options.permissionMode;
      if (options.autonomy) this.state.autonomy = options.autonomy;
      if (options.phaseBudgetUsd !== undefined) this.state.phaseBudgetUsd = options.phaseBudgetUsd;
      if (options.runBudgetUsd !== undefined) this.state.runBudgetUsd = options.runBudgetUsd;
      // Continuing with a phase list replaces the old one; continuing without
      // one clears it, so "Continue" never silently inherits a single-phase run.
      if (options.onlyPhases?.length) this.state.onlyPhases = [...options.onlyPhases];
      else delete this.state.onlyPhases;
      // Per-phase choices and skills are sticky across a continue: they belong
      // to the run, not to one press of the button.
      if (options.phaseOptions) this.state.phaseOptions = { ...options.phaseOptions };
      if (options.skills) this.state.skills = [...options.skills];
      if (options.maxParallel !== undefined) {
        if (options.maxParallel > 0) this.state.maxParallel = options.maxParallel;
        else delete this.state.maxParallel;
      }
      // Sticky like the rest: absent on a Continue keeps what the run already
      // is. Not deleted when zero — `maxConsecutiveFailures` is a required
      // field on `RunState`, so the guard matches `applySettings`' own
      // (`!== undefined && > 0`) rather than the delete-on-falsy shape above.
      if (options.maxConsecutiveFailures !== undefined && options.maxConsecutiveFailures > 0) {
        this.state.maxConsecutiveFailures = options.maxConsecutiveFailures;
      }
      // The run's own rung caps (#14), sticky like the rest — and `null`, an
      // emptied box, hands the run back to the console's preference. The
      // settings door's own rule: the Continue form offers the same boxes.
      applyRungCaps(this.state, options);
      // Account and on-limit policy are sticky like skills: absent on a
      // continue means "keep what the run already is", and naming the machine
      // login or `wait` explicitly returns the run to the omission state.
      if (options.accountId !== undefined) {
        if (options.accountId && options.accountId !== 'default') this.state.accountId = options.accountId;
        else delete this.state.accountId;
        // …and into its pool, the way every other mover puts it there (#100).
        keepAccountInPool(this.state);
      }
      if (options.onLimit !== undefined) {
        if (options.onLimit !== 'wait') this.state.onLimit = options.onLimit;
        else delete this.state.onLimit;
      }
      // …and the model policy, the same way (#91) — a Continue that names one applies it.
      if (options.modelPolicy !== undefined) {
        if (options.modelPolicy !== DEFAULT_MODEL_POLICY) this.state.modelPolicy = options.modelPolicy;
        else delete this.state.modelPolicy;
      }
      // Auto-recovery is sticky the same way: absent means "keep what the run
      // already is", and an explicit false returns it to the omission state.
      if (options.autoRecover !== undefined) {
        if (options.autoRecover) {
          // Arming only — see `newRun`. Carrying the old `attempts` forward was
          // the last thing keeping a dead ceiling alive across a settings patch.
          this.state.autoRecover = {};
        } else {
          delete this.state.autoRecover;
        }
      }
      // The git strategy is sticky the same way: absent means "keep what the
      // run already is" — a resume must never re-read the machine defaults and
      // silently move a half-finished run onto (or off) its branch.
      if (options.gitMode === 'new-branch') {
        this.state.gitMode = 'new-branch';
        this.state.openPr = options.openPr ?? this.state.openPr ?? true;
      } else if (options.gitMode === 'default-branch') {
        delete this.state.gitMode;
        delete this.state.openPr;
      } else if (options.openPr !== undefined && this.state.gitMode === 'new-branch') {
        this.state.openPr = options.openPr;
      }
      // Settle is sticky the same way — absent keeps the run's own strategy, so
      // a Continue that says nothing never silently re-reads the machine
      // preference and changes where a half-finished branch ends up. Unlike
      // isolation it moves in BOTH directions, because nothing about the run's
      // past depends on it; `applySettings` is the single rule for that, so
      // this delegates rather than repeating it — the third-reader trap P1 was
      // defeated by.
      if (options.settle !== undefined || options.gitMode === 'new-branch') {
        applySettings(this.state, { settle: options.settle ?? this.state.settle ?? settleOf(this.state) });
      }
      // Isolation is sticky for exactly the reason the git strategy is, and it
      // matters more: re-reading the machine preference on a resume could move
      // a half-finished run into a checkout its earlier phases never used, and
      // the earlier phases' commits are in the OTHER one. Absent keeps the run
      // as it is; an explicit non-isolating value returns it to the omission
      // state. The one-way rule from `applySettings` holds here too — a resume
      // cannot mint isolation a running run never had.
      if (options.isolation !== undefined && options.isolation !== ISOLATED) {
        delete this.state.isolation;
      }
      // Dropping the branch drops isolation with it, same as `applySettings`.
      if (options.gitMode === 'default-branch') delete this.state.isolation;
      // Priority is sticky the same way — absent keeps the run's class — but
      // it moves in BOTH directions, because unlike isolation nothing about a
      // run's past depends on it. `applySettings` is the single rule for that,
      // so the resume branch delegates rather than repeating it: this is the
      // third reader of a run setting, and the third reader is exactly where
      // P1's `LOCK_CAP_PARK` narrowing shipped a fix and its own defeat.
      if (options.priority !== undefined) {
        applySettings(this.state, { priority: options.priority });
      }
      // A chain is sticky and start-only: `startAfter` on a RESUME still means
      // "begin after that plan", so an explicit value replaces it and an empty
      // string clears it. Absent keeps what the run has, so a Continue that
      // says nothing never silently unchains a run.
      if (options.startAfter !== undefined) {
        if (options.startAfter) this.state.startAfter = options.startAfter;
        else delete this.state.startAfter;
      }
      // The reviewer is sticky for the same reason, and the same way: absent
      // means keep the run as it is. A resume that re-read the machine
      // preference could switch a half-finished run's reviewer on — and, with
      // `may-hold`, start parking phases the earlier half never had to pass.
      if (options.reviewEachPhase !== undefined) {
        if (options.reviewEachPhase) this.state.reviewEachPhase = true;
        else delete this.state.reviewEachPhase;
      }
      if (options.reviewerPolicy !== undefined) {
        if (options.reviewerPolicy === 'may-hold') this.state.reviewerPolicy = 'may-hold';
        else delete this.state.reviewerPolicy;
      }
      // Both ultra opt-ins are sticky the same way, and the cloud one is the
      // case that makes the rule matter: a resume that re-read a preference
      // could start billing an operator for cloud reviews on the second half of
      // a run whose first half never asked for one.
      if (options.ultracode !== undefined) {
        if (options.ultracode) this.state.ultracode = true;
        else delete this.state.ultracode;
      }
      if (options.ultraReview !== undefined) {
        if (options.ultraReview && options.ultraReview !== 'off') this.state.ultraReview = options.ultraReview;
        else delete this.state.ultraReview;
      }
      // Everything else a run carries, which this branch never read (#101
      // #102): a Continue naming `resumeOnRestart: true` answered a run still
      // reading `false`, and a relaunch naming a new account pool kept the old
      // one. The stored run is the source of truth (#21), so a setting the
      // start does not name is kept, and one it names is applied by the
      // settings verb's own rule — `applySettings`, the one reader, so a
      // resume cannot loosen `issuesMode` or re-cut a branch a patch could not.
      const named: RunSettingsPatch = {
        ...(options.permissionProfile !== undefined ? { permissionProfile: options.permissionProfile } : {}),
        ...(typeof options.resumeOnRestart === 'boolean' ? { resumeOnRestart: options.resumeOnRestart } : {}),
        ...(options.relay !== undefined ? { relay: options.relay } : {}),
        ...(options.accounts?.length ? { accounts: options.accounts } : {}),
        ...(options.mcpServers !== undefined ? { mcpServers: options.mcpServers } : {}),
        ...(options.mcpPolicy !== undefined ? { mcpPolicy: options.mcpPolicy } : {}),
        ...(options.qaModel !== undefined ? { qaModel: options.qaModel } : {}),
        ...(options.qaEffort !== undefined ? { qaEffort: options.qaEffort } : {}),
        ...(options.qaMaxRounds !== undefined ? { qaMaxRounds: options.qaMaxRounds } : {}),
        ...(options.baseBranch !== undefined ? { baseBranch: options.baseBranch } : {}),
        ...(options.maxConcurrentPerRepo !== undefined ? { maxConcurrentPerRepo: options.maxConcurrentPerRepo } : {}),
        ...(options.worktreeRetention !== undefined ? { worktreeRetention: options.worktreeRetention } : {}),
        ...(options.landing !== undefined ? { landing: options.landing } : {}),
        ...(options.conflictPolicy !== undefined ? { conflictPolicy: options.conflictPolicy } : {}),
        ...(options.messaging !== undefined ? { messaging: options.messaging } : {}),
        ...(options.issuesMode !== undefined ? { issuesMode: options.issuesMode } : {}),
      };
      applySettings(this.state, named, this.consoleIssueWord());
      // A run resumed from disk may carry lanes recorded by the console that
      // died. `adopt` has already ruled on the dangerous case, so the entries
      // it left behind are gone — but "adopt ruled on it" is a claim about
      // adopt, and this line used to be reached on paths where adopt had never
      // run at all. Ask the probe instead, and keep whatever is still there.
      this.state.children = survivingChildren(this.state);
      if (!Object.keys(this.state.children).length) delete this.state.children;
    }

    this.journal = Journal.for(this.state.root, this.state.slug, this.state.id);
    this.transcript = this.openTranscript(this.state);
    this.ladderSeen.clear();

    // What this resume changed over the stored run, now that there is somewhere
    // to write it (#101 #102). One line naming each override from → to, and
    // nothing when the start named nothing new: inheriting is the default and
    // needs no record. The profile keeps its own line too, as a mid-run change
    // does (`configure`): it is the one setting that changes what a session
    // may DO, and "who widened this run" must be answerable without a diff.
    if (resumedFrom) {
      const overridden = settingsOverridden(resumedFrom, this.state);
      if (Object.keys(overridden).length) this.record('run.resume-settings', { overridden, ...actor });
      if (overridden.permissionProfile) {
        const from = (resumedFrom.permissionProfile ?? 'guarded') as PermissionProfile;
        this.record('run.permission-profile', { from, to: this.profile(), by: actor.by });
        log.warn('runner.permission-profile', { runId: this.state.id, from, to: this.profile(), by: actor.by });
      }
    }

    // The freeze ruled on above, now that there is somewhere to write it.
    for (const ruled of ruledFreeze) {
      this.record('run.freeze-escalated', {
        pid: ruled.pid, phase: ruled.phase, sessionId: ruled.sessionId ?? null,
        afterMs: FREEZE_ESCALATE_MS, at: 'start', overdue: ruled.overdue,
        signalled: ruled.signalled,
      }, ruled.phase ?? undefined);
    }

    // Re-boards asked of this resume (the convergence loop's seam): the record
    // is reset and hinted here, journalled, and boards under normal admission
    // like any candidate. Only on a resume — a fresh run has no history to
    // re-board — and only for phases the run knows.
    if (state && options.reboard?.length) {
      for (const ask of options.reboard) {
        const record = phaseRecord(this.state, ask.phase);
        if (PHASE_IN_FLIGHT.includes(record.status)) continue;
        const hint: BoardingHint = {
          situation: ask.situation, rung: ask.rung,
          brief: ask.brief ?? briefForRung(ask.rung, Boolean(ask.sessionId)),
          ...(ask.sessionId ? { sessionId: ask.sessionId } : {}),
          ...(ask.instruction ? { instruction: ask.instruction } : {}),
          ...(ask.escalate ? { escalate: ask.escalate } : {}),
          at: new Date().toISOString(),
          ...(ask.by ? { by: ask.by } : {}),
        };
        this.reboardWith(record, hint);
        this.record('phase.reboard-requested', {
          situation: hint.situation, rung: hint.rung, brief: hint.brief,
          sessionId: hint.sessionId ?? null, by: ask.by ?? 'console',
        }, ask.phase);
      }
    }

    // Both refusals cost about a second and save a session each. The auth one
    // saves considerably more than that: without it an expired login is
    // discovered once per phase, each time as a session that reports success,
    // spends nothing and does nothing.
    // The probe runs as the RUN's account: a run pinned to a profile used to
    // pass preflight on the machine login's health and burn a session per
    // phase finding out the profile had expired.
    const auth = this.deps.checkAuth
      ? await this.deps.checkAuth(this.state.accountId)
      : await checkAuth(this.state.root, true);
    let refusal = preflight(this.state.root) ?? (auth.loggedIn ? null : authRefusal(auth.detail));
    let tried: string[] = [];
    let wall: 'auth' | 'quota' | null = auth.loggedIn ? null : 'auth';
    if (refusal && !auth.loggedIn) {
      // The auth wall's first rung, climbed before anyone is told: a signed-in
      // account that can pay takes the run. Only when none will does this
      // become the park it always was — now with the errand named on it.
      const climbed = await this.switchAccountAtPreflight('auth', auth.detail);
      tried = climbed.tried;
      if (climbed.switched) { refusal = null; wall = null; }
    }
    // The QUOTA door, climbing beside the auth door instead of throwing above
    // it (ACT-2). The service's verdict reads `liveBuckets`, the machine-wide
    // walls and the breaker; a refusal walks `rankAccounts` for an account
    // with headroom that also signs in, and only when none does is the run
    // parked — a journalled state with ONE errand, never an exception a
    // `log.warn` swallows on the nine automatic doors.
    if (!refusal && this.deps.accountHeadroom) {
      const quota = this.deps.accountHeadroom(this.state.accountId, this.state.model);
      if (!quota.ok) {
        const climbed = await this.switchAccountAtPreflight('quota', quota.reason);
        tried = climbed.tried;
        if (!climbed.switched) { refusal = quota.reason; wall = 'quota'; }
      }
    }
    if (refusal) {
      setRunState(this.state, 'parked');
      this.state.stoppedBy = 'system';
      this.state.halt = { at: new Date().toISOString(), reason: refusal, kind: 'run-preflight' };
      // The run's pool, named in the ask when it declared one (#55): the
      // failover above never left it, so the person is told which accounts
      // were the candidates and how to widen them.
      const pool = accountPool(this.state);
      const poolNote = pool
        ? ` Failover stays inside this run's pool (${pool.join(', ')}) and none of its accounts could take the run.`
        : '';
      const poolHow = pool
        ? ' Switching the run to an account outside the pool adds it to the pool — failover never leaves the pool by itself.'
        : '';
      if (wall === 'auth') {
        // The one ask, with what was already tried so nobody repeats it by
        // hand. `how` is the console's own sign-in sentence when it composed
        // one (it names the account and the exact command); the generic
        // errand otherwise.
        const paying = this.state.accountId ?? 'the machine login';
        const base = errandFor('resource-wall:auth', tried, 0);
        const errand: Errand = {
          ...base,
          need: `A signed-in Claude account for this run — it is set to pay as ${paying}, whose login is expired or signed out.${poolNote}`,
          how: `${auth.detail && /sign|login|setup-token/i.test(auth.detail) ? auth.detail : base.how}${poolHow}`,
        };
        this.state.errand = errand;
        this.record('run.errand', { ...errand, reason: 'no signed-in account could take the run', by: 'runner' });
      } else if (wall === 'quota') {
        const paying = this.state.accountId ?? 'the machine login';
        const base = errandFor('resource-wall:usage', tried, 0);
        const errand: Errand = {
          ...base,
          need: `A Claude account with headroom for this run — it is set to pay as ${paying}: ${refusal}${poolNote}`,
          how: 'Register or sign in another Claude account under Settings ▸ Accounts and switch the run to it, '
            + `clear a retired account there once its organisation allows it again, or wait for the window and Continue.${poolHow}`,
        };
        this.state.errand = errand;
        this.record('run.errand', { ...errand, reason: 'no account with headroom could take the run', by: 'runner' });
      }
      this.record('run.preflight-refused', {
        reason: refusal, ...(wall ? { wall } : {}), ...(tried.length ? { tried } : {}), ...(pool ? { pool } : {}),
      });
      this.persist();
      log.warn('runner.preflight', { root: this.state.root, reason: refusal });
      return this.state;
    }

    // A resume past a credential wall re-boards what the wall stopped (RCV-1).
    // The preflight above just proved the account can pay again — a person
    // cleared it, or the run was switched to another — and a `parked` record
    // is SETTLED to the drive loop, so without this Continue would find nothing
    // to do and park the run on "outstanding". The reset is the console's
    // (bounds and ledgers carried forward); the cause goes, because it is no
    // longer true.
    if (state) {
      for (const record of Object.values(this.state.phases)) {
        if (record.status !== 'parked' || record.cause?.kind !== 'credential-refused') continue;
        const wall = record.cause;
        resetForRetry(record, { by: 'console', journal: this.declarationSink() });
        delete record.cause;
        this.record('phase.retry-requested', {
          by: 'console',
          reason: `the credential wall this phase stopped on (${wall.class}: ${wall.reason}) no longer refuses `
            + `${this.state.accountId ?? 'the machine login'} — re-boarding`,
        }, record.phase);
      }
    }

    setRunState(this.state, 'running');
    this.abort = new AbortController();
    this.stopRequested = false;
    this.stopActor = null;
    this.settingsPath = this.armSettings(this.state.id);
    // Who opened this start, from where, through which door — the actor as
    // the site built it, every field (SLF-1: 324 of 326 lines carried no
    // `by`). `unattributedActor` is the harness fallback and never a door's
    // word; `test/invariants.test.ts` holds every `startRun(` site to naming
    // one, so a production line reading `unattributed` is a defect to chase.
    this.record('run.start', {
      runId: this.state.id, slug: this.state.slug, model: this.state.model,
      autonomy: this.state.autonomy, resumed: Boolean(state),
      // Named even when it is the default — argv never shows an account, so
      // the journal is the audit trail for whose quota a run spends.
      account: this.state.accountId ?? 'default',
      ...(this.state.onLimit ? { onLimit: this.state.onLimit } : {}),
      ...(this.state.modelPolicy ? { modelPolicy: this.state.modelPolicy } : {}),
      ...(this.state.onlyPhases?.length ? { onlyPhases: this.state.onlyPhases } : {}),
      // The manifest as the door resolved it (phase 11, ZTD-2/QRL-2): every
      // row with its state and source, the probes, the accounts clause, the
      // credentials held and missing, the delivery channel — so the line that
      // says a run started also says what was answered before it did. Row
      // values are cut to 200 characters; a row's evidence is the plan's.
      ...(this.state.manifest ? { manifest: manifestEcho(this.state.manifest) } : {}),
      ...(typeof this.state.resumeOnRestart === 'boolean' ? { resumeOnRestart: this.state.resumeOnRestart } : {}),
      ...(this.state.relay ? { relay: this.state.relay } : {}),
      ...actor,
    });
    // The identity behind the account (control-tower phase 91, #131): bound
    // once, at the first start — a resume keeps the binding it had, and every
    // boarding compares against it (`identityDrifted`).
    if (!this.state.identity) this.bindIdentity('start');
    // The one recorded way past a blocking row (ZTD-2): who took it, over
    // which rows. Written here and not in the Service because the journal did
    // not exist a line ago.
    if (!state && options.manifestOverride) {
      this.record('run.manifest-override', {
        rows: options.manifestOverride.rows, by: options.manifestOverride.by,
      });
    }
    // …and the plan git lines it runs over (#18), for the same reason: a
    // launch that overrode the plan is a decision somebody (or some door)
    // made, and the sessions are told the concrete branch from here on.
    if (!state && options.gitStrategyOverride?.lines.length) {
      this.record('run.git-strategy-overridden', {
        lines: options.gitStrategyOverride.lines, ack: options.gitStrategyOverride.ack,
        ...(options.gitStrategyOverride.by ? { by: options.gitStrategyOverride.by } : {}),
      });
    }
    // The start door's §Verification answers, counted and signed — the texts
    // themselves ride on the run file, where a person reading a stopped run
    // later sees exactly what was approved.
    const answers = this.state.verifyApprovals;
    if (!state && answers) {
      this.record('run.verify-approvals', {
        approve: answers.approve.length, waive: answers.waive.length, ...(answers.by ? { by: answers.by } : {}),
      });
    }
    // The journal only exists from a few lines up; `was` keeps the audit
    // trail the counter itself loses.
    if (resumedStreak) this.record('run.failure-streak-reset', { was: resumedStreak });
    this.persist();

    const runId = this.state.id;
    // Every lane this run's records keep for a phase stands again in the
    // scheduler (control-tower phase 100): a reservation outlives a restart.
    for (const key of Object.keys(this.state.phases)) {
      if (this.state.phases[key]?.queueControl?.reserve) this.syncReservation(Number(key));
    }
    onShutdown(this.shutdownKey(runId), (context) => this.checkpointForShutdown(context));
    this.driving = this.drive().finally(() => {
      this.driving = null;
      offShutdown(this.shutdownKey(runId));
      // Every grant and every pending admission this run held. The loop was
      // the only thing making them real, and it has ended — leaving them would
      // hold this run's scope against every other plan until the process died.
      this.deps.scheduler?.releaseRun(runId);
      // The token outlives the loop while a child launched under it lives (#74).
      if (this.state?.id === runId) this.releaseRunToken(this.state);
      else this.deps.approvals?.release(runId, []);
      // …and the two files that carry this run's secrets: its resolved
      // `--mcp-config` (bearer tokens, API keys) and its `--settings` (the
      // approval-hook run token). The loop ending is what "left flight" means
      // for a run, whichever status it landed on: a resume re-boards through
      // `armMcp` and `writeSettingsFile`, which rewrite both from the registry.
      // `keep` is every OTHER run this console is driving, so a concurrent run
      // never has its own files swept out from under it.
      this.pruneRunSecrets(runId);
    });
    return this.state;
  }

  /**
   * The two files this run's spawns left on disk that carry secrets.
   *
   * Guarded on liveness, not merely on the loop having ended. Both files are
   * read by the CLI at startup, so a session that is STILL RUNNING has already
   * consumed them — but "already consumed" is a claim about the CLI's internals
   * and the cost of being wrong is an orphaned session losing its MCP servers
   * or its approval hook mid-phase. A process is a fact; wait for the fact.
   * The boot sweep collects whatever this declines to.
   *
   * The fact to wait for is WORK, not existence. A `zombie` child has exited
   * and closed its files, so holding a resolved `--mcp-config` (bearer tokens)
   * and a settings file (the approval run token) on disk for it buys nothing
   * and costs exactly what those files cost. `stopped` still defers: a
   * `kill -CONT` away from re-reading them.
   */
  protected pruneRunSecrets(runId: string): void {
    const state = this.state;
    if (state && childrenOf(state).some((child) => pidHoldsWork(child.pid, procIdentity(child)))) {
      return;
    }
    const removed = [...dropMcpConfigsFor(runId), ...dropSettingsFileFor(runId)];
    if (removed.length) log.info('run.secrets-pruned', { runId, files: removed.length });
  }

  /**
   * The run's replay writer — the one place one is made, for `start` and
   * `recover` alike (control-tower phase 94, #133). A phase's replay is its own
   * file now, and the writer says when one crosses 80 % of its cap or reaches
   * it: once per file, read from the file, so a re-drive does not say it again.
   */
  protected openTranscript(state: RunState): Transcript {
    return new Transcript(state.root, state.slug, state.id, { onLimit: (limit) => this.noteReplayLimit(limit) });
  }

  /**
   * Journal a replay limit and keep it on the phase's record, where the card
   * reads it. The run's own file (lines that name no phase) is journalled and
   * belongs to no record.
   */
  protected noteReplayLimit(limit: ReplayLimit): void {
    const state = this.state;
    if (!state) return;
    const { phase, ...rest } = limit;
    this.record('phase.replay-limit', rest, phase);
    const record = phase == null ? undefined : state.phases[String(phase)];
    if (!record) return;
    record.replay = { state: limit.state, bytes: limit.bytes, cap: limit.cap, at: this.now().toISOString() };
    this.persist();
  }

  /**
   * Drive one stuck phase forward, without re-running it.
   *
   * The console had exactly two verbs for a phase that stopped: Retry, which
   * starts it again from its boot prompt and throws away however long the
   * session had been working, and Skip, which marks it abandoned. Neither fits
   * the common case — a phase that did the work and stopped short of recording
   * it — so the operator's only honest option was to open a terminal.
   *
   * The three modes here are the missing middle:
   *
   *   `recheck`  re-runs the three checks and spawns nothing. For "I fixed it
   *              by hand, look again".
   *   `closeout` asks the phase's own session to finish its closeout — the same
   *              continuation the runner attempts by itself, on demand and
   *              without the "only once" guard, because a person asking for it
   *              is a new fact.
   *   `resume`   the same, carrying an instruction the operator typed. This is
   *              `/btw` for a session that has already exited.
   *
   * All three end in `confirm()`, so nothing here can mark a phase done that the
   * board, the verification and `validate.sh` do not all agree about.
   */
  async recover(options: RecoverOptions): Promise<RunState> {
    // The verb's own ledger (RCV-4): refused over the fingerprint the last
    // recovery of this phase ran under — it cannot have changed anything — and
    // bounded per phase. The service asks the same question with a live board
    // before it reaches here (`preRecoveryGate` answers `unchanged`/`capped`);
    // this is the belt for a caller that passed a fingerprint and no board.
    const refusal = this.recoverRefusal(options);
    if (refusal) return refusal;
    const ledger = this.recoverLedgerFor(options);
    const armed = this.armRecovery({
      ...options,
      kind: 'run.recover',
      payload: { mode: options.mode, ...ledger },
    });
    if ('refused' in armed) return armed.refused;
    const { state, haltedWith, was } = armed;
    // Charged once the recovery is genuinely armed — an orphan refusal above
    // spends nothing — on the state the loop now holds, so `disarmRecovery`'s
    // persist writes it.
    const slot = (state.recoveries ??= {})[String(options.phase)] ??= { attempts: 0, lastAt: new Date().toISOString() };
    slot.recovers = {
      count: ledger.recovers, lastAt: new Date().toISOString(), lastFingerprint: ledger.fingerprint, lastMode: options.mode,
    };
    this.persist();

    // A `.catch` before the `.finally`, because `this.driving` is STORED, never
    // awaited: `recover()` returns `state` synchronously and the promise lives
    // on the runner. Anything `runRecovery` threw past its own handlers — the
    // lock-wait cap being the measured one (R7) — was an unhandled rejection,
    // which node reports on stderr and the console never hears. A recovery that
    // could not run is a settled fact about the phase, so it is recorded as one.
    this.driving = this.runRecovery({ ...options, haltedWith, was }).catch((error) => {
      log.error('runner.recover.unhandled', { error });
      this.halt(
        `the recovery of phase ${options.phase} could not run: ${(error as Error)?.message ?? String(error)}`,
        options.phase, 'recovery-failed',
      );
    }).finally(() => this.disarmRecovery(state));
    return state;
  }

  /**
   * The recover verb refused — over unchanged evidence, or past the per-phase
   * cap — as a journalled state on the stored run, or null to proceed.
   */
  private recoverRefusal(options: RecoverOptions): RunState | null {
    const state = loadRun(options.root, options.slug, options.runId, null);
    const ledger = state?.recoveries?.[String(options.phase)]?.recovers;
    if (!state || !ledger) return null;
    const why = ledger.count >= RECOVER_MAX_PER_PHASE
      ? 'capped'
      : options.fingerprint && ledger.lastFingerprint === options.fingerprint ? 'unchanged' : null;
    if (!why) return null;
    Journal.for(state.root, state.slug, state.id).append('run.recover.refused', {
      phase: options.phase, why, mode: options.mode, by: options.by ?? 'console',
      recovers: ledger.count, max: RECOVER_MAX_PER_PHASE, since: ledger.lastAt,
      ...(options.fingerprint ? { fingerprint: options.fingerprint.slice(0, 200) } : {}),
    }, options.phase);
    log.warn('runner.recover.refused', { runId: state.id, slug: state.slug, phase: options.phase, why, recovers: ledger.count });
    return state;
  }

  /** The fields `run.recover` carries — this recovery's count against the cap, and the evidence it ran under. */
  private recoverLedgerFor(options: RecoverOptions): { fingerprint: string | null; recovers: number; max: number } {
    const state = loadRun(options.root, options.slug, options.runId, null);
    const count = (state?.recoveries?.[String(options.phase)]?.recovers?.count ?? 0) + 1;
    return { fingerprint: options.fingerprint ?? null, recovers: count, max: RECOVER_MAX_PER_PHASE };
  }

  /**
   * Everything a recovery does BEFORE its own work starts, done once.
   *
   * Two callers now — `recover()` above and `qaRecover()` (`runner-attempt.ts`),
   * whose QA round loop is a recovery in every respect that matters here: it
   * spawns sessions that edit the tree, it must refuse beside an adopted
   * orphan, it needs a journal, a transcript, an abort controller, a settings
   * file and a shutdown checkpoint, and it must flip the run to `running` before
   * the first spawn rather than after the last. Duplicating this was the
   * alternative, and the half a second reader would have spent finding the
   * difference between the two copies is exactly the cost this file exists to
   * avoid.
   *
   * `{ refused }` is the adopted-orphan answer — a live child from an earlier
   * console — and it is a RETURN rather than a throw because the caller's
   * contract is to hand that state straight back to the operator.
   */
  protected armRecovery(options: {
    slug: string; root: string; runId: string; phase: number; by?: string;
    /** The journal line this arming writes, and what rides on it. */
    kind: string; payload?: Record<string, unknown>;
  }): { state: RunState; haltedWith: string | null; was: { status: RunState['status']; finishedReason?: string } } | { refused: RunState } {
    if (this.driving) throw new Error('A run is already in progress. Pause or stop it first.');

    const state = loadRun(options.root, options.slug, options.runId, null);
    if (!state) throw new Error(`No run ${options.runId} for ${options.slug}.`);
    const record = state.phases[String(options.phase)];
    if (!record) throw new Error(`Run ${options.runId} never reached phase ${options.phase}.`);

    this.state = state;

    // Adopt BEFORE driving, exactly as `start()` does. Until this line existed
    // `recover()` was the one way into the runner that never asked whether a
    // previous console's child was still alive — so a `recheck` could be run
    // against a plan whose other phase still had a session editing the tree,
    // and its own teardown would then erase the record of that session.
    //
    // The refusal is the point: a recovery is a small, deliberate act, and
    // there is no version of it that is safe to perform beside an unsupervised
    // agent writing the same repository.
    const orphan = this.adopt(state);
    if (orphan) {
      this.persist();
      this.record('run.recover.refused', { phase: options.phase, why: orphan }, options.phase);
      this.emit('run', { state });
      this.state = null;
      return { refused: state };
    }

    // Only this phase's own halt explains anything here: a stop recorded
    // against another phase is not this recovery's story.
    const haltedWith = state.halt?.phase === options.phase ? state.halt.reason : null;
    // What the run READ before this recovery flipped it, so a recheck that
    // changes nothing can put it back exactly (RCV-4): `park()` writes both
    // `state.halt` and `parked`, and mapping the return through the halt alone
    // sent a parked run back as `halted`.
    const was = { status: state.status, ...(state.finishedReason ? { finishedReason: state.finishedReason } : {}) };
    // The halt is NOT cleared here. It used to be — "a run being worked on
    // must not go on looking stopped" — and the cost was worse than the look:
    // a recovery that crashed re-halted with a generic message and the
    // original reason was gone, and a recovery skipped mid-way left the run
    // looking unstopped over a phase still reading failed. The status flip to
    // `running` below is what tells the console work is happening; the halt
    // stands as the record of why until the recovery SUCCEEDS, and the
    // success path (and only it) clears halt, resolution and reopen-veto
    // together.
    delete state.finishedReason;
    setRunState(state, 'running');
    state.activePhase = options.phase;

    this.journal = Journal.for(state.root, state.slug, state.id);
    this.transcript = this.openTranscript(state);
    this.abort = new AbortController();
    this.stopRequested = false;
    this.stopActor = null;
    this.settingsPath = this.armSettings(state.id);
    this.record(
      options.kind,
      { phase: options.phase, by: options.by ?? 'console', ...(options.payload ?? {}) },
      options.phase,
    );
    this.persist();
    // Before the work starts, not after it finishes. `runRecovery` can spend
    // minutes inside a spawn, and until this emit existed the console showed
    // the halted run — cleared status, cleared halt, all of it invisible —
    // for the whole of that. The `finally` emit below still reports the end.
    this.emit('run', { state });

    onShutdown(this.shutdownKey(state.id), (context) => this.checkpointForShutdown(context));
    this.recovering = true;
    return { state, haltedWith, was };
  }

  /**
   * The token's half of a loop's ending (#74) — every ending's, said once.
   *
   * A child launched under the run that still lives keeps the token armed: its
   * `--settings` carries the token and cannot be reloaded, so disarming under
   * it answered every PreToolUse call it made 401 — and the CLI does not treat
   * that as a refusal. The loop ADOPTS such a child rather than cutting it off:
   * its ChildRef stays in `state.children` (the loop's ending keeps survivors),
   * `reconcileRun`'s orphan branch owns it from there, and `Approvals.sweepHeld`
   * retires the token once the last holder has gone.
   */
  protected releaseRunToken(state: RunState): void {
    const approvals = this.deps.approvals;
    if (!approvals) return;
    const holders = Object.values(survivingChildren(state)).map((child) => ({ pid: child.pid, ...procIdentity(child) }));
    const already = approvals.heldTokens().some((held) => held.runId === state.id);
    if (approvals.release(state.id, holders) === 'kept' && !already) {
      this.record('run.token-kept', { pids: holders.map((holder) => holder.pid) });
    }
  }

  /** The other half of `armRecovery` — every caller's `.finally`, said once. */
  protected disarmRecovery(state: RunState): void {
    this.driving = null;
    this.recovering = false;
    offShutdown(this.shutdownKey(state.id));
    this.releaseRunToken(state);
    this.deps.scheduler?.releaseRun(state.id);
    this.persist();
    this.emit('run', { state });
  }

  /**
   * Does the checkout a boarding is about to use still stand? The loop answers
   * this (`RunnerLoop.checkoutBeforeBoarding`, control-tower phase 90, #123):
   * true to board, false when the run parked instead. A runner with no loop
   * boards as it always did.
   */
  protected async checkoutBeforeBoarding(): Promise<boolean> {
    return true;
  }

  private async runRecovery(
    options: RecoverOptions & { haltedWith?: string | null; was?: { status: RunState['status']; finishedReason?: string } },
  ): Promise<void> {
    const state = this.state!;
    const record = phaseRecord(state, options.phase);
    const owner = autopilotOwner(state.id);
    // A recovery boards a session exactly as a phase does, and it is the path
    // #123's resumed P27 took into a mirror the prune had removed: the checkout
    // is asked first, and a refused isolation parks rather than recovering in
    // the shared tree.
    if (!(await this.checkoutBeforeBoarding())) return;

    // A recovery spawns a session that edits the working tree exactly as a
    // phase does, and until now it was the one path that started one without
    // asking anybody. That was invisible while a single runner made it
    // impossible for anything else to be running; with a pool it is a second
    // agent in a tree another plan is mid-phase on.
    let grant: ScopeGrant | null = null;
    try {
      // Named rather than inline: `admit(options.phase, 'recovery')` puts an
      // identifier called `phase` next to the word `recovery`, which is the
      // two-member queue-kind vocabulary spelled out as far as
      // `vocab-owners.test.ts`'s scan can tell. A whole-file allowance to
      // silence one call site would license the real thing everywhere in a
      // three-thousand-line file, so the constant is the cheaper honesty.
      const kind: QueueKind = 'recovery';
      const controller = new AbortController();
      this.recoveryQueued = { phase: options.phase, controller, options };
      try {
        grant = await this.admit(options.phase, kind, { signal: controller.signal });
      } finally {
        this.recoveryQueued = null;
      }
    } catch (error) {
      // Capped BEFORE aborted — since R7 the one is a subclass of the other,
      // and the two mean opposite things: capped is "this phase waited two
      // hours behind somebody else's dead claim and admission has already
      // parked it", aborted is "the run stopped, nothing is owed".
      if (error instanceof AdmissionCapped) {
        // The wait is over however it ended, so the clock stops with it — a
        // stamp left standing makes the NEXT admission compute a negative
        // remainder and fire its cap immediately (R8).
        endLockWait(record);
        this.halt(
          `the recovery of phase ${options.phase} could not take its scope: it waited `
          + `${Math.round(error.waitedMs / 60_000)} minutes behind another claim`,
          options.phase, 'recovery-failed',
        );
        return;
      }
      if (error instanceof AdmissionAborted) {
        this.record('phase.recovery-cancelled', { phase: options.phase }, options.phase);
        // Compare-and-set, not a write. A run-level `halt()` now withdraws every
        // entry the run owns — this recovery's admission included — and its
        // rejection lands a microtask AFTER `halt()` wrote `halting`/`halted`.
        // An unguarded `paused` here left a halted run reading `paused` with
        // `state.halt` set: the card would have shown a tidy operator pause over
        // a stop that needs a person. `stop()` could already reach this window;
        // the halt door is what made it ordinary.
        if (!state.halt) setRunState(state, 'paused');
        return;
      }
      throw error;
    }

    // A recovery is one session, but it is still a session: giving it a lane
    // is what lets Freeze and Stop reach it, and what puts its child in
    // `children` so a console restart reconciles it like any other.
    const lane: Lane = {
      phase: options.phase, pid: null, handle: null, grant,
      frozen: null, freezeTimer: null, stopped: null, checkpointed: false, checkpointNote: null, leaseTimer: null,
      // No `idleAttempts` carry-over: a recovery is not another attempt at the
      // phase, and counting it as one would let three recoveries — each of
      // which may legitimately change nothing — declare a stalemate.
      signals: newLaneSignals(this.now().getTime()),
    };
    // …and it runs where the phase ran. A recovery of a lane phase built its
    // Lane with no worktree at all, so `laneRoot` answered `state.root` and
    // every session below opened the operator's checkout instead of the lane:
    // the phase's own commits absent, the wrong branch out, and a closeout that
    // would have written its handoff against work it could not see (D7).
    await this.adoptLane(lane);
    this.lanes.set(options.phase, lane);
    this.armLivenessTicker();
    // A recovery session holds the phase lock exactly as a phase session does,
    // and can run just as long — the keepalive applies equally.
    this.armLeaseTimer(lane, autopilotOwner(state.id));

    try {
      // A recovery that DRIVES does not carry a halt its own read contradicts
      // (control-tower phase 81, #105). `armRecovery` keeps the halt on purpose
      // — a recovery that crashes must not lose why the run stopped — but a
      // `plan-unreadable` stop claims only that the engine could not read the
      // plan, and this read answering disproves it: the run then drove for
      // twenty minutes under "the engine could not read the plan". Cleared, and
      // said so on the run's record.
      if (state.halt?.kind === 'plan-unreadable') {
        const board = await this.board();
        if (!board.error && state.halt?.kind === 'plan-unreadable') {
          this.record('run.halt-cleared', {
            kind: state.halt.kind, reason: state.halt.reason, why: 'the engine reads the plan again',
          });
          state.halt = null;
          state.resolved = null;
          this.persist();
          this.emit('run', { state });
        }
      }
      if (options.mode !== 'recheck') {
        // An operator asking again is a new fact, not a repeat of the automatic
        // attempt — so the once-only guard is cleared rather than honoured.
        record.closeout = undefined;
      }

      if (options.mode === 'resume') {
        const said = await this.resumeWithInstruction(
          options.phase, options.instruction ?? '', options.haltedWith);
        if (said && typeof said === 'object') {
          // A resume that could not resume. Nothing ran, so nothing is
          // confirmed and nothing is halted anew — `armRecovery` flipped the
          // run to `running`, and left there it reads as still driving to the
          // healer, whose next sweep would score the rung `interrupted` and
          // climb it again. Back to the word the run had, which is drivable.
          setRunState(state, state.halt ? 'halted' : 'parked');
          // A PERSON's resume keeps its words (control-tower phase 53, #54,
          // #55): the phase is left hinted to board FRESH with the resume brief
          // carrying the instruction and why, and the press continues the run,
          // so it boards exactly what was asked. It used to answer 200 here and
          // launch nothing at all. A rung's resume leaves the next move to the
          // ladder, as it always did.
          if (options.person) {
            const note = said.policy
              ? resumePolicyInstruction(said.policy, said.lost)
              : sessionLostInstruction(said.lost, 'unported');
            const hint = reboardResumeBrief(
              [options.instruction?.trim(), note].filter(Boolean).join('\n\n'),
              { situation: record.situation?.key ?? 'work-in-progress' },
            );
            this.reboardWith(record, { ...hint, by: PERSON_SLOT_BY });
            this.record('phase.reboard-requested', {
              situation: hint.situation, rung: hint.rung, brief: hint.brief, sessionId: said.lost, by: PERSON_SLOT_BY,
            }, options.phase);
          }
          const next = options.person
            ? 'It boards fresh with the resume brief and the instruction as the run continues.'
            : 'The next rung is a fresh session with the resume brief.';
          state.finishedReason = said.policy
            ? `phase ${options.phase}'s session ${said.lost} is not worth resuming — ${resumePolicyWhy(said.policy)}. ${next}`
            : `phase ${options.phase}'s session ${said.lost} cannot be resumed under this `
              + `account — its transcript is not there. ${options.person ? next : 'The next rung is a fresh session.'}`;
          return;
        }
        if (said) { this.halt(said, options.phase, 'recovery-failed'); return; }
      }

      // A remediation as a SESSION under this run, not a pty nobody watches.
      // It owns its whole tail — the outcome, the rung, the run's ending — and
      // deliberately never reaches `confirmed()` below: that asks "is this
      // phase DONE", which a plan-wide repair can never satisfy however well it
      // worked, and answering it was how nine of ten repair rungs came to be
      // recorded as failures (R17).
      if (options.mode === 'repair') {
        await this.repairSession(options.phase, options);
        return;
      }

      // A recheck re-runs the three checks and spawns nothing, so it is never a
      // failed ATTEMPT and never a new ENDING when it finds the same one (RCV-4:
      // 16 of 127 recoveries re-halted within seconds having changed nothing,
      // each re-writing `phase.halted` with a fresh clock and charging the
      // streak). While `rechecking` names the phase, `settlePhase`/`halt` keep an
      // identical standing halt untouched and the paperwork charges skip; the
      // verdict is one `run.recheck` line.
      const before = { run: state.halt?.kind ?? null, phase: record.halt?.kind ?? null, at: record.halt?.at ?? state.halt?.at ?? null };
      if (options.mode === 'recheck') this.rechecking = options.phase;
      let ok: boolean;
      try {
        ok = await this.confirmed(options.phase);
      } finally {
        this.rechecking = null;
      }
      if (options.mode === 'recheck') {
        const after = { run: state.halt?.kind ?? null, phase: record.halt?.kind ?? null, at: record.halt?.at ?? state.halt?.at ?? null };
        const unchanged = !ok && after.run === before.run && after.phase === before.phase && after.at === before.at;
        const verdict = ok ? (record.status === 'done' ? 'confirmed' : 'changed') : unchanged ? 'unchanged' : 'changed';
        this.record('run.recheck', {
          phase: options.phase, verdict,
          ...(options.fingerprint ? { fingerprint: options.fingerprint.slice(0, 200) } : {}),
          ...(after.phase || after.run ? { halt: { kind: after.phase ?? after.run, reason: (record.halt?.reason ?? state.halt?.reason ?? '').slice(0, 200) } } : {}),
        }, options.phase);
        if (unchanged && options.was) {
          // Exactly what it read before — the status word included, and the
          // sentence the card showed.
          setRunState(state, options.was.status);
          if (options.was.finishedReason) state.finishedReason = options.was.finishedReason;
          else delete state.finishedReason;
          return;
        }
      }
      if (!ok) {
        // confirm() halted (or re-halted) and said why — at the PHASE when the
        // ending was phase-level, which writes no run status. `armRecovery`
        // flipped the run to `running`; left there it reads as still driving.
        if (state.status === 'running') {
          setRunState(state, state.halt ? 'halted' : 'parked');
          state.finishedReason ??= record.halt?.reason ?? state.halt?.reason ?? `phase ${options.phase} did not confirm`;
        }
        return;
      }

      // Success — and only success — retires the stop this recovery was
      // about: the halt, its resolution, and any reopen-veto go together,
      // exactly as `start` does on resume.
      state.halt = null;
      state.resolved = null;
      state.reopenedAt = null;
      // …and the streak (RCV-3): a phase confirmed done breaks "N in a row" by
      // definition — the attempt loop resets on the same fact — and it is what
      // lets `recovery-continue` relaunch a run the healer just mended, now
      // that an automatic relaunch of a SPENT streak is refused.
      resetStreak(state);
      // …and the PHASE's own ending, which since the halt-kind split is where a
      // `verify-failed`/`no-handoff`/`phase-blocked` recovery's subject actually
      // lives. Left standing it would out-rank `state.halt` in the classifier
      // and keep describing a stop this recovery just retired (QA F1).
      retirePhaseHalt(record);

      if (record.status === 'waiting' && record.parkedUntil) {
        // The recovery session declared waiting-external instead of closing —
        // the honest outcome for a phase whose external clock has not landed.
        // The run waits with the phase; the service re-arms the resume.
        state.waitUntil = record.parkedUntil;
        setRunState(state, 'waiting', { kind: 'external', until: state.waitUntil });
        state.finishedReason = `phase ${options.phase} is waiting on external work`
          + `${record.parkReason ? ` (${record.parkReason})` : ''}; resumes at ${record.parkedUntil}.`;
        this.record('run.waiting-external', {
          phases: [options.phase], waitUntil: record.parkedUntil,
        }, options.phase);
        return;
      }
      if (record.status === 'waiting') {
        // A wait with NO clock — its declaration met a spent wait budget and
        // parked on its refs (control-tower phase 14, #40's 2026-09-28 thread).
        // It is a park, as the drive loop's own ending makes it: a `waiting` run
        // with no clock read "resumes at undefined" and was later mistaken for
        // an interrupted one. The sentence says BUDGET, and what moves it.
        setRunState(state, 'parked');
        const spent = state.recoveries?.[String(options.phase)]?.errand?.budget;
        state.finishedReason = `phase ${options.phase} waits on its refs with no clock of its own`
          + `${record.parkReason ? ` (${record.parkReason})` : ''}: `
          + (spent ? `${budgetHeadline(spent, 'spent')}. ` : 'its wait budget is spent. ')
          + 'A landing resumes it; raising the budget gives it a clock again.';
        this.record('run.recovered', { phase: options.phase, mode: options.mode, parked: 'wait-budget' }, options.phase);
        return;
      }

      setRunState(state, 'parked');
      state.finishedReason = `phase ${options.phase} was closed by ${options.by ?? 'console'}. `
        + 'Continue to carry on through the rest of the plan.';
      this.record('run.recovered', { phase: options.phase, mode: options.mode }, options.phase);
    } catch (error) {
      log.error('runner.recover.crashed', { error });
      this.halt(`the recovery of phase ${options.phase} failed: ${(error as Error)?.message ?? error}`, options.phase, 'recovery-failed');
    } finally {
      this.clearLeaseTimer(lane);
      await this.release(options.phase, owner);
      this.deps.scheduler?.release(lane.grant);
      this.clearFreezeTimer(lane);
      this.endLaneStall(options.phase);
      this.lanes.delete(options.phase);
      // A recovery has no drive loop to finalize a drain: its halt above was
      // written while its own lane was still in the table, so with that lane
      // gone the run lands on the final word here.
      if (state.status === 'halting') {
        setRunState(state, this.parkPending ? 'parked' : 'halted');
        this.parkPending = false;
      }
      // This recovery's own lane is finished; ANOTHER phase's child may not be.
      // Unfiltered, this block deleted the whole map — so a `recheck` on phase
      // 10, which spawns nothing at all, erased the handle on phase 9's live
      // orphan. Everything after that followed: the run read as dead, its lock
      // was released as debris, and the session went on writing the tree with
      // nothing in the console pointing at it.
      this.syncMirror();
      this.childPid = null;
      this.handle = null;
      const survivors = survivingChildren(state);
      if (Object.keys(survivors).length) {
        state.children = survivors;
        state.child = survivors[String(Math.min(...Object.keys(survivors).map(Number)))] ?? null;
      } else {
        state.child = null;
        delete state.children;
      }
      // The same settle `drive()` does, for the same reason: a recovery that
      // crashed inside `confirm()` leaves its phase reading `verifying` with
      // nothing verifying it. Per-phase, so a `recheck` on phase 10 still does
      // not touch phase 9's surviving orphan — the exact filter this block's
      // `children` handling needed for the same reason.
      for (const phase of settleInFlightRecords(
        state, this.now().toISOString(), TEARDOWN_SETTLES,
      )) {
        this.emit('phase', { phase, status: 'interrupted' });
      }
    }
  }

  /**
   * Ask the scheduler for this phase's scope, recording the wait.
   *
   * With no scheduler wired the answer is immediate and unconditional, which
   * is what every test harness that is not about concurrency wants — and what
   * this runner did before admission existed.
   */
  /**
   * The synchronous probe a SHARED-checkout phase admission carries
   * (`AdmitRequest.branchHold`, control-tower phase 40, #41): does a
   * repository of this scope stand on a branch another open run holds? Read
   * fresh at every scan — the hold records, and the HEAD of each held
   * repository the scope reaches, off disk (`branchHoldNow`) — so a holder
   * settling or a tree moved back is seen at the next scan, and `arm` pokes a
   * scan every `TREE_POLL_MS` while the phase waits. Null for a run whose
   * trees are its own: a mirror, an isolated run, a lane worktree.
   */
  protected treeWatch(
    phase: number, scope: string[], claim: { branch?: string; tree?: string },
  ): { hold: () => BranchHoldView | null; arm: (poke: () => void) => void; stop: () => void } | null {
    const state = this.state!;
    if (state.checkout === 'worktree' || this.lanes.get(phase)?.worktree) return null;
    // A phase the operator gave its own worktree (`isolate-phase`, #150) will
    // board in a lane of its own: no other run's branch stands in its tree.
    const ownTree = (): boolean => Boolean(this.state?.isolatePhases?.includes(phase));
    if (ownTree()) return null;
    const self = { run: state.id, slug: state.slug };
    const holds = (): readonly TreeHold[] => {
      try { return this.deps.treeHolds?.() ?? readHolds(); } catch { return []; }
    };
    // No await anywhere: joining the queue must not wait on a read, or two of
    // this run's own admissions would join in the order their reads finished.
    // Re-asked at every scan, so an `isolate-phase` pressed while the entry
    // waits releases it at the very next one.
    const hold = (): BranchHoldView | null => {
      if (ownTree()) return null;
      try { return branchHoldNow(state.root, scope, holds(), self, claim); } catch { return null; }
    };
    const keyOf = (view: BranchHoldView | null): string => (view ? `${view.run}|${view.repo}|${view.branch}` : '');
    let timer: NodeJS.Timeout | null = null;
    return {
      hold,
      arm: (poke) => {
        if (timer) return;
        let last = keyOf(hold());
        timer = setInterval(() => {
          const now = keyOf(hold());
          if (now === last) return;
          last = now;
          poke();
        }, this.deps.treePollMs ?? TREE_POLL_MS);
        timer.unref?.();
      },
      stop: () => {
        if (timer) clearInterval(timer);
        timer = null;
      },
    };
  }

  /**
   * The claim a phase admission presents: its scope as the plan states it,
   * the scope it is ADMITTED on (plus the whole-checkout token a shared
   * new-branch run takes, S11-c), and the branch, tree and repository
   * qualifying it. One answer for `admit` and for the drive loop's serial
   * check (#64), so the two can never disagree about which lanes meet.
   */
  protected async admissionClaim(phase: number): Promise<{
    phase: number; scope: string[]; admitScope: string[]; branch?: string; tree?: string; repo?: string;
  }> {
    const state = this.state!;
    const scope = await this.scopeFor(phase);
    // Both dimensions or neither — a scope the root does not contain makes the
    // pair a claim about the wrong tree (`RunnerBase.qualificationFor`).
    // 🔴 `repo` is the third answer, and until phase 15 it was computed here
    // and never carried: the per-repository cap phase 7 built engaged only
    // from a hand-built request, and never from a run.
    const { branch, tree, repo } = this.qualificationFor(phase, scope);
    const claimsWholeCheckout = state.gitMode === 'new-branch' && state.checkout !== 'worktree';
    return {
      phase, scope, admitScope: claimsWholeCheckout ? [...scope, SHARED_CHECKOUT_TOKEN] : scope,
      ...(branch ? { branch } : {}), ...(tree ? { tree } : {}), ...(repo ? { repo } : {}),
    };
  }

  protected async admit(phase: number, kind: QueueKind, opts: { signal?: AbortSignal } = {}): Promise<ScopeGrant | null> {
    const state = this.state!;
    const scheduler = this.deps.scheduler;
    if (!scheduler) return null;

    const { scope, admitScope, branch, tree, repo } = await this.admissionClaim(phase);
    // 🔴 A shared-root NEW-BRANCH run takes the whole checkout, whatever its
    // Repos cell says (S11-c). Its boot prompt tells the session to stand the
    // ONE shared checkout on `pe/<slug>` — so two such runs with disjoint
    // scopes were admitted side by side and then each told to check out a
    // different branch in the same directory. git allows one; the second
    // session finds the tree on somebody else's branch and commits there.
    // Disjoint SCOPES do not make two branches fit in one tree, and the tree
    // dimension cannot say so either: both runs name the same tree, so the
    // pair carves nothing — it is the BRANCH REQUIREMENT that collides, and
    // nothing in the vocabulary expressed it. An implicit token does: every
    // shared-root new-branch run claims it, so they serialise against each
    // other and against nobody else (a run with its own checkout never asks
    // for it, and neither does a run that commits on the branch it found).
    // (`admissionClaim` adds that token.)
    // 🔴 Admit on the BRANCH, not just the lock (control-tower phase 40, #41).
    // A lock is per phase; the branch another run checked a shared repository
    // onto is per RUN, and it outlives every lock that run takes. A phase in
    // the SHARED checkout waits while a repository of its scope stands on
    // another open run's branch — it would build and verify that run's work.
    // The hold's probe takes the DECLARED branch only. A default-branch run's
    // claim names the branch its checkout stands on (`qualificationFor`), and a
    // scope standing on another run's held branch would then read as "already
    // on the held branch" — carved past the very hold that exists to stop it.
    const declared = branch && branch === this.branchFor(phase) ? branch : undefined;
    const trees = kind === 'phase'
      ? this.treeWatch(phase, scope, { ...(declared ? { branch: declared } : {}), ...(tree ? { tree } : {}) })
      : null;
    const request: AdmitRequest = {
      slug: state.slug,
      phase,
      runId: state.id,
      scope: admitScope,
      // The branch AND the tree this session will edit — the SAME calls that
      // answer the lock's `branch=`/`worktree=` lines and the session's
      // `PE_BRANCH`/`PE_WORKTREE`, deliberately: admission weighs this request
      // against locks on disk, so a request that disagreed with its own lock
      // would be one session making two claims. The claim is now EXACT rather
      // than "strictly less": a shared new-branch run states `pe/<slug>` plus
      // the shared root, and safety rides the tree dimension — two shared runs
      // present the same tree and collide however their branches differ, while
      // an isolated run's own tree is what carves it out.
      //
      // 🔴 In PRACTICE the branch is the RUN branch or nothing, never a
      // lane's. Admission runs before the lane exists — `drivePhase` admits,
      // THEN `lanes.set`, then `acquireWorktree` — so the lane arms cannot
      // fire here, and two lanes of one run present the same pair and are not
      // carved apart from one another (their concurrency still rests on
      // disjoint scopes, exactly as it always has).
      ...(branch ? { branch } : {}),
      ...(tree ? { tree } : {}),
      // The repository the tree rides in — the per-repository cap's key — and
      // the run's own threshold in it, which can only lower the console's
      // number (`AdmitRequest.repoCap`). Absent for a run stating no tree,
      // which is exactly the set that must not be capped.
      ...(repo ? { repo } : {}),
      ...(repo && state.maxConcurrentPerRepo ? { repoCap: state.maxConcurrentPerRepo } : {}),
      // What the boarding schedule reads: a phase is the autopilot choosing to
      // start work and is governed; a recovery is an operator's button and is
      // not. See `AdmitRequest.kind`.
      kind,
      // The scan class this admission joins the queue in. Absent reads as
      // `normal` in the scheduler, so a run that never said anything queues
      // exactly as it always did. An operator who changes the class while
      // entries are already waiting is served by `Scheduler.reprioritize`,
      // which the settings door calls — the seed here is only the birth value.
      ...(state.priority ? { priority: state.priority } : {}),
      // The account the lane would spend, so a throttle on someone ELSE'S
      // window never queues this run — and one on ours does.
      ...(state.accountId ? { accountId: state.accountId } : {}),
      // A phase whose watch landed while this loop was live goes AHEAD of its
      // scope's queue (`landWatch`, control-tower phase 6) — spent below.
      ...(kind === 'phase' && this.landingReserve.has(phase) ? { reserve: true } : {}),
      ...(trees ? { branchHold: trees.hold } : {}),
      // A phase whose dependency the board took back from done waits on it,
      // held in its place (control-tower phase 86, #136).
      ...(kind === 'phase' ? { awaiting: () => this.awaitingOf(phase) } : {}),
      // An operator's standing word on this phase (control-tower phase 99,
      // #135): the entry is born carrying it, so it survives the entry.
      ...(kind === 'phase' && entryControlOf(phaseRecord(state, phase).queueControl)
        ? { control: entryControlOf(phaseRecord(state, phase).queueControl)! } : {}),
      // The scheduling policy's word on it, asked at every scan (control-tower phase 100).
      ...(kind === 'phase' ? { promotion: () => this.promotionOf(phase) } : {}),
      signal: this.abort?.signal,
    };

    // Asked BEFORE joining the queue, so "queued" is visible for the whole
    // wait rather than inferred afterwards. Only when it genuinely blocks —
    // announcing a queue for an admission that is free would put a `queued`
    // badge on every phase the console ever starts.
    const blockers = scheduler.wouldBlock(request);
    const record = phaseRecord(state, phase);
    /**
     * Is this PHASE admission serial behind a live lane of its own run (#64)?
     * Any own live lane among the holders makes it so, foreign holders or not:
     * it could not board before its sibling ends whatever else released, and
     * a sibling finishing is pipelining — no queue, no `waitedMs`, no badge.
     */
    const serialOf = (holders: readonly Holder[]): number | null => {
      if (kind !== 'phase') return null;
      const own = holders.filter((holder) => isOwnLiveLane(holder, state.id)).map((holder) => holder.phase!);
      return own.length ? Math.min(...own) : null;
    };
    const behindAtEntry = serialOf(blockers);
    if (behindAtEntry !== null) {
      trees?.stop();
      this.markSerial(phase, behindAtEntry);
      this.persist();
      throw new AdmissionSerial(state.slug, phase, behindAtEntry);
    }
    // A phase that is admitted, or queues for anything else, is no longer
    // behind a sibling of its own.
    this.clearSerial(phase);

    /** When THIS wait started. See `phase.admitted`'s `waitedMs` below (D25). */
    const queuedSince = new Date(this.now().getTime()).toISOString();
    // The entry is born as old as the wait a withdrawal or a restart
    // interrupted, and as reserved as it had aged (#81) — never at the back.
    // Since control-tower phase 86 (#128) "as old as" is the phase's SENIORITY:
    // the oldest of its queue age, its hint and an expired park, so a wrap-up's
    // or a checkpoint's re-board takes the place the phase already earned.
    const senior = seniorityOf(record, new Date(this.now().getTime()).toISOString());
    const age = Date.parse(senior?.at ?? '');
    if (Number.isFinite(age)) request.since = age;
    if (record.queueReserving) request.aged = true;

    // The durable shadow of WHO blocks, beside `lockWaitSince`'s WHEN. The
    // journal line already names the holders, but a pure reader (the inbox)
    // cannot reach a journal — and it needs the owner to tell another plan's
    // claim from this run's own sibling lane. …and HOW LONG, when the holder's
    // phase has enough history to say (the Now lane's card is a pure reader).
    // A `branch` holder names what the queue page needs to say it: the
    // repository, the branch it stands on and the run that put it there.
    const shadow = (holders: readonly Holder[]): NonNullable<PhaseRecord['waitingOn']> => holders.map((holder) => ({
      slug: holder.slug, owner: holder.owner,
      ...(holder.phase == null ? {} : { phase: holder.phase }),
      ...(holder.eta ? { eta: holder.eta } : {}),
      ...(holder.kind === 'branch' ? { kind: holder.kind, repo: holder.repo, branch: holder.branch, run: holder.run } : {}),
    }));
    const journalled = (holders: readonly Holder[]): Record<string, unknown>[] => holders.map((holder) => ({
      slug: holder.slug, phase: holder.phase, owner: holder.owner, overlaps: holder.overlaps,
      ...(holder.eta ? { eta: holder.eta } : {}),
      ...(holder.kind === 'branch' ? { kind: holder.kind, repo: holder.repo, branch: holder.branch, run: holder.run } : {}),
    }));

    /**
     * The phase is seen queued: its episode opens (`queue-episodes.ts`), the
     * record says `queued` with its holders, and `phase.queued` is written —
     * at entry, or later when a scan finds it held after joining free.
     */
    const announceQueued = (holders: readonly Holder[], at: string): void => {
      if (kind === 'phase') record.status = 'queued';
      openQueueEpisode(record, at, holderClass(holders[0]!, state.id));
      // …and the RUN is blocked from here, once however many of its phases wait (#64).
      foldRunBlocked(state, at);
      record.waitingOn = shadow(holders);
      // The run's own durable shadow of the queue. Deliberately NOT in
      // `IN_FLIGHT`: a queued run has done nothing, so a console restart may
      // re-adopt it rather than reconciling it into `interrupted`.
      // Only when NOTHING of this run is live: with another lane mid-session,
      // stamping the RUN `queued` repaints a working run as waiting for the
      // whole of that phase (seen live — phase 4 driving, run reading
      // `queued` because phases 5–6 sat behind its scope). The queued LANE
      // is already honest in `record.status` and the tabs.
      // The HEAD blocker's kind and, when it can be known, when it should end.
      // Two different waits look identical in `phase.queued` without them — a
      // sibling lane pipelining (`grant`, ends when it finishes) and a dead
      // foreign claim (`lock`, ends at its lease) — and the cap treats them as
      // opposites. `eta` is the head lock's lease; a grant has no deadline to
      // report yet, and inventing one would be worse than saying nothing.
      const head: Holder | undefined = holders[0];
      // Through the named writer, with the reason: `scope` unless the head
      // holder is the operator's boarding schedule. Both are spelled `queued`
      // and the recorded reason is the only thing that tells them apart —
      // `schedule` had no production writer at all (LFC-5).
      if (!this.livePhases().length) {
        setRunState(state, 'queued', {
          kind: head?.slug === SCHEDULE_HOLDER ? 'schedule' : 'scope',
          until: head?.leaseUntil ? new Date(head.leaseUntil).toISOString() : null,
          ...(head ? { on: head.phase == null ? head.slug : `${head.slug} phase ${head.phase}` } : {}),
        });
      }
      this.record('phase.queued', {
        scope: formatScope(scope),
        // The claim this admission presented (control-tower phase 90, #149):
        // a carve-out that did not happen is diagnosable from the journal alone.
        ...(tree ? { tree } : {}), ...(branch ? { branch } : {}),
        ...(head ? { headKind: head.kind, headClass: holderClass(head, state.id) } : {}),
        ...(head?.leaseUntil ? { eta: new Date(head.leaseUntil).toISOString() } : {}),
        ...(record.queueSince && record.queueSince !== at ? { age: record.queueSince } : {}),
        waitingOn: journalled(holders),
      }, phase);
      this.emit('phase', { phase, status: 'queued', scope, waitingOn: holders });
      this.persist();
      this.emit('run', { state });
    };

    // The admission's own exit: a stop, the cap, or the sibling it turned out
    // to be serial behind all leave the queue the way a stop leaves it — the
    // scheduler's own cancellation path — rather than a second exit that
    // would strand the entry on the queue it was supposed to remove it from.
    const admission = new AbortController();
    const onRunAbort = (): void => admission.abort();
    this.abort?.signal.addEventListener('abort', onRunAbort, { once: true });
    // …and a recovery's own controller (control-tower phase 86, #149 ask 4): a
    // Pause withdraws a recovery still waiting for its scope, and nothing else.
    opts.signal?.addEventListener('abort', onRunAbort, { once: true });
    if (this.abort?.signal.aborted || opts.signal?.aborted) admission.abort();
    request.signal = admission.signal;

    // The two-hour lock-wait cap, applied where the wait ACTUALLY happens.
    //
    // CLAUDE.md has always said "the scheduler owns the wait … bounded by the
    // 2-hour lock-wait cap", and the bound was implemented only in boarding's
    // belt-check — which runs AFTER this resolves. The clock starts when a
    // CAPPABLE blocker first stands in the way and is cleared by the belt-check
    // after a SUCCESSFUL claim, so it measures the whole wait on such a claim
    // — queue plus race — rather than restarting at the handover.
    // `isCappableBlocker` narrows it to the one shape the cap was ever for: a
    // foreign LOCK (or a claimless session) whose presence is not live. D2
    // brought grants under it and, measured over 34 runs, the cure cost more
    // than the disease; the hung-sibling case keeps its own bounds (the lane
    // watchdog and the grant lease). Clock holders are never capped.
    //
    // 🔴 The CURRENT blockers, not the ones at entry (#82). The cap used to be
    // armed once from `wouldBlock`'s answer and fire two hours later whatever
    // held the scope then — against a live refreshed lock, or naming a lock
    // that was gone while the real blocker was a sibling. Now every scan's
    // holders arm or disarm it, and when it fires it re-scans first.
    // A box, not a bare `let`: the only assignment is inside the timer
    // callback below, which TypeScript's flow analysis does not walk.
    const cap: { fired: AdmissionCapped | null; holder: Holder | null } = { fired: null, holder: null };
    const serial: { behind: number | null } = { behind: null };
    let current: readonly Holder[] = blockers;
    let capTimer: NodeJS.Timeout | null = null;
    const disarmCap = (): void => {
      if (capTimer) clearTimeout(capTimer);
      capTimer = null;
    };
    const fireCap = (): void => {
      capTimer = null;
      // A fresh scan first: its holders reach `listen` below synchronously.
      try { scheduler.poll(); } catch { /* the stale answer is still an answer */ }
      if (admission.signal.aborted) return;
      const still = current.filter(isCappableBlocker);
      if (!still.length) {
        // Nothing cappable stands in the way any more: that wait is over, and
        // the next cappable holder starts its own two hours.
        record.lockWaitSince = undefined;
        return;
      }
      const since = Date.parse(record.lockWaitSince ?? '');
      cap.fired = new AdmissionCapped(state.slug, phase, Number.isFinite(since) ? this.now().getTime() - since : LOCK_WAIT_CAP_MS);
      cap.holder = still[0]!;
      admission.abort();
    };
    /** Arm (or disarm) the cap against these holders. */
    const armCap = (holders: readonly Holder[]): void => {
      if (!holders.some(isCappableBlocker)) {
        disarmCap();
        // D25's cumulative clock survives a re-arm of the SAME wait on a dead
        // claim; a scan that finds no such claim ends that wait.
        if (capTimer === null && record.lockWaitSince && holders.length) record.lockWaitSince = undefined;
        return;
      }
      record.lockWaitSince ??= new Date(this.now().getTime()).toISOString();
      if (capTimer) return;
      const since = Date.parse(record.lockWaitSince);
      const remaining = Number.isFinite(since)
        ? Math.max(0, LOCK_WAIT_CAP_MS - (this.now().getTime() - since))
        : LOCK_WAIT_CAP_MS;
      // Deliberately NOT unref'd, unlike the scheduler's own wake timers. While
      // a phase is queued behind a foreign lock this timer is the ONLY thing
      // that can end the wait — everything else is a promise waiting on it — so
      // unref'ing it lets the process fall out from under a run that is still
      // claiming `queued`. It is cleared on every exit below, so it never
      // outlives the admission it bounds.
      capTimer = setTimeout(fireCap, remaining);
    };

    let told = holdersKey(blockers);
    let seenPersisted = 0;
    // Every scan's holders (#82): a change is journalled and the durable
    // shadow follows it; the cap follows the CURRENT set; a reservation the
    // entry earned is kept on the record; and a phase whose holders become a
    // live lane of its own run leaves the queue for `ready (behind P<n>)`.
    request.onHolders = (holders, scan) => {
      if (admission.signal.aborted) return;
      const nowMs = this.now().getTime();
      const at = new Date(nowMs).toISOString();
      if (scan.reserving && !record.queueReserving) {
        record.queueReserving = true;
        this.persist();
      }
      const key = holdersKey(holders);
      const before = current[0];
      // Always the scan's own objects: a holder's presence or lease can move
      // without the holder changing, and the cap judges what is true NOW.
      if (holders.length) current = holders;
      if (key !== told && holders.length) {
        told = key;
        const behind = serialOf(holders);
        if (behind !== null) {
          serial.behind = behind;
          admission.abort();
          return;
        }
        if (!record.queuedAt) {
          // It joined the queue free (`wouldBlock` answered nothing) and a scan
          // found it held: it is queued now, and says so like any other wait.
          announceQueued(holders, at);
        } else {
          noteQueueHead(record, holderClass(holders[0]!, state.id), at);
          foldRunBlocked(state, at);
          record.waitingOn = shadow(holders);
          this.record('phase.queue-holder-changed', {
            ...(before ? { from: { slug: before.slug, phase: before.phase, owner: before.owner, kind: before.kind } } : {}),
            to: { slug: holders[0]!.slug, phase: holders[0]!.phase, owner: holders[0]!.owner, kind: holders[0]!.kind },
            headClass: holderClass(holders[0]!, state.id),
            waitingOn: journalled(holders),
          }, phase);
          this.emit('phase', { phase, status: record.status, scope, waitingOn: holders });
          this.persist();
        }
      }
      // Every scan arms or disarms the cap against the CURRENT set (#82).
      if (holders.length) armCap(holders);
      // Seen waiting — where a restart will end this episode (#81). Written at
      // most every few minutes; the next change or close writes it anyway.
      if (record.queuedAt) {
        record.queueSeenAt = at;
        if (nowMs - seenPersisted >= QUEUE_SEEN_PERSIST_MS) {
          seenPersisted = nowMs;
          this.persist();
        }
      }
    };

    if (blockers.length) {
      announceQueued(blockers, queuedSince);
      // A tree moved back by hand is only seen by reading git again.
      trees?.arm(() => scheduler.poll());
    }
    armCap(blockers);

    let grant: ScopeGrant;
    try {
      grant = await scheduler.admit(request);
    } catch (error) {
      const at = new Date(this.now().getTime()).toISOString();
      if (serial.behind !== null && error instanceof AdmissionAborted) {
        // Its holders became a live lane of its own run (#64): the wait on
        // others is over, and what is left is serial work behind a sibling.
        const closed = closeQueueEpisode(record, 'withdrawn', at, 'serial');
        if (closed) this.record('phase.queue-closed', closed, phase);
        foldRunBlocked(state, at);
        endLockWait(record);
        if (kind === 'phase' && record.status === 'queued') record.status = 'pending';
        if (state.status === 'queued') setRunState(state, this.resumedStatus());
        this.markSerial(phase, serial.behind);
        this.persist();
        this.emit('run', { state });
        throw new AdmissionSerial(state.slug, phase, serial.behind);
      }
      // Our cap fired, not the operator's stop. The phase is PARKED with the
      // holder named — the same sentence and the same journal line boarding's
      // belt-check writes, so the two paths to this ending are indistinguishable
      // to everything downstream (`LOCK_CAP_PARK_NOTE` matches both).
      const fired = cap.fired;
      if (fired && error instanceof AdmissionAborted) {
        // The holder a re-scan found blocking NOW, with its lease as it stands
        // now — never the entry-time snapshot (#82).
        const holder = cap.holder!;
        const waitedMs = fired.waitedMs;
        const closed = closeQueueEpisode(record, 'capped', at);
        if (closed) this.record('phase.queue-closed', closed, phase);
        foldRunBlocked(state, at);
        // Stated, for the reason the belt-check states it: `endLockWait` below
        // clears the evidence, so a fold run afterwards cannot tell this park
        // from one that needs a person.
        setPhaseState(record, 'parked', { kind: 'scope-cap' });
        // The holder is named whatever KIND it was.
        const what = holder.kind === 'lock'
          ? `locked by ${holder.owner}`
          : `held by ${holder.owner} (${holder.slug}${holder.phase == null ? '' : ` phase ${holder.phase}`})`;
        record.note = `phase ${phase} is ${what} and has waited `
          + `${Math.round(waitedMs / 60_000)} minutes for it`
          + (holder.leaseUntil ? ` (its lease ends ${new Date(holder.leaseUntil).toISOString()})` : '');
        this.record('phase.lock-wait-capped', {
          holder: holder.owner, waitedMs, by: 'admission', kind: holder.kind,
          ...(holder.session ? { session: holder.session } : {}),
          slug: holder.slug, ...(holder.phase == null ? {} : { phase: holder.phase }),
        }, phase);
        this.emit('phase', { phase, status: 'parked', note: record.note });
        // Retry means the two hours start over — the only thing it could
        // sensibly mean, and the same reasoning the belt-check records. The
        // queue's own clock and the entry's age are the episode's, and stay.
        endLockWait(record);
        if (state.status === 'queued') setRunState(state, this.resumedStatus());
        this.persist();
        this.emit('run', { state });
        throw fired;
      }
      // Stopped, paused, halted or parked while it waited: the episode ends
      // `withdrawn` (the withdrawal itself may already have closed it, with
      // its reason — then this is a no-op), and the entry keeps its age.
      if (error instanceof AdmissionAborted) {
        // An operator's withdrawal of this one entry (control-tower phase 99)
        // is not the run stopping, and the episode says which it was.
        const closed = closeQueueEpisode(record, 'withdrawn', at, error instanceof AdmissionWithdrawn ? 'operator' : 'stop');
        if (closed) this.record('phase.queue-closed', closed, phase);
        foldRunBlocked(state, at);
      }
      throw error;
    } finally {
      disarmCap();
      this.abort?.signal.removeEventListener('abort', onRunAbort);
      opts.signal?.removeEventListener('abort', onRunAbort);
      trees?.stop();
    }

    // 🔴 JOURNALLED UNCONDITIONALLY (S12). An admission that waited for
    // nothing — the ordinary case, and the one where the CARVE-OUT does its
    // work — is still an admission, and `waitedMs: 0` is a fact, not noise.
    const carvedPast = (this.deps.scheduler?.carvedFor(request) ?? []).map((holder) => ({
      slug: holder.slug,
      ...(holder.phase == null ? {} : { phase: holder.phase }),
      owner: holder.owner,
      kind: holder.kind,
      ...(holder.branch ? { branch: holder.branch } : {}),
      ...(holder.tree ? { tree: holder.tree } : {}),
    }));
    // D25 + #81: how long this phase ACTUALLY waited — the whole wait, across
    // every episode a withdrawal or a restart cut it into, not the last leg.
    // `state.updatedAt` was once used here and measured the newest write to
    // the run instead (a 653-minute queue self-reported as 20 seconds).
    const at = new Date(this.now().getTime()).toISOString();
    const closed = closeQueueEpisode(record, 'admitted', at);
    if (closed) this.record('phase.queue-closed', closed, phase);
    foldRunBlocked(state, at);
    // What RELEASED it (#82): the last holder a scan named, when there was one.
    const releaser = current[0];
    // A wait banked on the cap's clock before episodes existed (a record
    // written by an older console) still counts: the larger of the two.
    const banked = Date.parse(record.lockWaitSince ?? '');
    const waitedMs = Math.max(
      closed ? closed.waitedMs : Math.max(0, this.now().getTime() - Date.parse(queuedSince)),
      Number.isFinite(banked) ? Math.max(0, this.now().getTime() - banked) : 0,
    );
    this.record('phase.admitted', {
      scope: formatScope(scope),
      waitedMs,
      // …and the claim it was admitted ON — the same pair the queue line names.
      ...(tree ? { tree } : {}), ...(branch ? { branch } : {}),
      ...(releaser ? {
        releasedBy: {
          slug: releaser.slug, owner: releaser.owner, kind: releaser.kind,
          ...(releaser.phase == null ? {} : { phase: releaser.phase }),
          class: holderClass(releaser, state.id),
        },
      } : {}),
      ...(carvedPast.length ? { carvedPast } : {}),
      // At birth, or given to an entry already queued (`reserveQueued`).
      ...(request.reserve || this.landingReserve.has(phase) ? { reserved: true } : {}),
      // An operator's lane marks, spent below (control-tower phase 100).
      ...(record.queueControl?.pin ? { pinned: true } : {}),
      ...(record.queueControl?.reserve ? { laneReserved: true } : {}),
    }, phase);
    // The reservation is spent: it bought the admission, not the phase.
    this.landingReserve.delete(phase);
    // …and so is an operator's bump, and a deferral whose clock has passed
    // (control-tower phase 99, #135): the phase has boarded, which is what both
    // asked for. A hold cannot be here — a held entry is never admitted.
    // …and so are a pin and a kept lane (control-tower phase 100): each asked
    // for exactly this boarding. The scheduler spent its reservation at the grant.
    if (record.queueControl?.bump || record.queueControl?.defer || record.queueControl?.pin || record.queueControl?.reserve) {
      delete record.queueControl.bump;
      delete record.queueControl.defer;
      delete record.queueControl.pin;
      delete record.queueControl.reserve;
      if (!Object.keys(record.queueControl).length) delete record.queueControl;
    }

    if (current.length) {
      // It WAITED: the board its lane was about to board with is as old as the
      // wait, so the grant re-reads a fresh one first (`runPhase`, #136).
      if (kind === 'phase') this.admittedAfterWait.add(phase);
      // Back to running: the wait is over, and a run left reading `queued`
      // while its session works would be the same lie in the other direction.
      // Compare-and-set: the wait can be minutes, and a status someone ELSE
      // wrote during it — a halt from another lane erased exactly here on a
      // real run, a freeze, a stop — is a fact this lane must not overwrite.
      if (state.status === 'queued') setRunState(state, this.resumedStatus());
      // The wait is over, so the holders it recorded are history — kept, the
      // inbox would keep naming a queue this lane already left.
      delete record.waitingOn;
      this.emit('phase', { phase, status: 'running', scope });
      this.persist();
      this.emit('run', { state });
    }
    return grant;
  }

  /**
   * This phase is serial behind its own run's live lane `behind` (#64). It
   * keeps its word — `pending`, which the board reads ready — carries
   * `serialBehind`, and `phase.serial-behind` is written once per change of the
   * lane it is behind. Never `queued`, never a `waitedMs`: that is the point.
   */
  protected markSerial(phase: number, behind: number): void {
    const record = phaseRecord(this.state!, phase);
    if (record.serialBehind === behind) return;
    record.serialBehind = behind;
    this.record('phase.serial-behind', { behind }, phase);
    this.emit('phase', { phase, status: record.status, serialBehind: behind });
  }

  /** No longer behind a lane of its own: it boarded, or stopped being a candidate. */
  protected clearSerial(phase: number): void {
    const record = this.state?.phases[String(phase)];
    if (record?.serialBehind == null) return;
    delete record.serialBehind;
    this.emit('phase', { phase, status: record.status });
  }

  /** Resume the phase's session with the operator's own words. Returns a refusal. */
  /**
   * The environment every child session starts from: the console's own, the
   * run's ACCOUNT layered over it (a profile's `CLAUDE_CONFIG_DIR`, a token's
   * `CLAUDE_CODE_OAUTH_TOKEN`, nothing for the machine login), then the
   * run-specific facts on top so they always win.
   *
   * ONE composer for all three spawn sites — attempt, closeout, and the
   * resume-with-instruction path recovery rides on. A switched run whose
   * closeout missed the account env would resume its transcript under the
   * wrong credentials, which is precisely the quiet kind of wrong. Resolved
   * per spawn, so an account switch lands on the very next session; a
   * resolution failure degrades to the machine login rather than blocking the
   * phase, and says so in the journal.
   */
  protected async sessionEnv(extra: Record<string, string>): Promise<NodeJS.ProcessEnv> {
    const accountId = this.state?.accountId;
    let account: NodeJS.ProcessEnv | null = null;
    if (this.deps.accountEnv) {
      try {
        // The roots this run spawns sessions in — a profile's config dir must
        // trust them, or the CLI ignores the workspace's own allow rules.
        account = await this.deps.accountEnv(accountId, this.state?.root ? [this.state.root] : []);
        if (accountId && !account) {
          this.record('run.account-env-missing', { accountId });
        }
      } catch (error) {
        this.record('run.account-env-failed', { accountId, error: (error as Error).message });
      }
    }
    return {
      ...process.env,
      // WHERE WORK-STATE GOES, stated rather than inferred.
      //
      // Every skill script resolves its docs root as `$DOCS_ROOT` first and a
      // cwd-upward git walk second — and in a linked worktree that walk answers
      // the WORKTREE, not the run's root. A lane session therefore wrote its
      // handoff, its `.locks/` and its QA row inside the worktree, where the
      // engine, the store and the scheduler (all reading `state.root`) never
      // look: the phase landed cleanly and the board still read `no-handoff`.
      //
      // So it is set for EVERY spawned session, not only lane ones. A session
      // whose cwd already is the root gets the value its own fallback would
      // have computed, which is a no-op; a session anywhere else gets the truth
      // instead of a guess. `extra` still wins, because a caller that names a
      // root means it.
      ...(this.state ? { DOCS_ROOT: this.state.root } : {}),
      // WHICH SCRIPTS, stated the same way (control-tower phase 98, #151): the
      // console's own `scriptsDir`, which every prompt it composes names as
      // `$PE_SCRIPTS/<script>`. A session used to run whatever path it last
      // saw — the plugin's clone, or one an old handoff wrote down — while the
      // console that launched it enforced its own newer copy.
      PE_SCRIPTS: this.deps.scriptsDir,
      // Sessions run `validate.sh`/`phase-graph.sh` themselves per the skill's
      // protocol; under launchd the parent env has no registry, so F15's MCP
      // advisory was silently dead inside every unattended session. Resolved
      // per spawn — a registry change lands on the next session. Set-but-empty
      // is a real answer (a console with nothing registered); ABSENT deps mean
      // no registry is wired at all, and the advisory stays off.
      ...(this.deps.mcpIds ? { PE_MCP_SERVERS: this.deps.mcpIds().join(' ') } : {}),
      // The per-attempt CHANNELS are never inherited — only ever stated.
      //
      // `...process.env` above carries whatever this console was started with,
      // and a console started BY a phase session (this repository's own plans
      // are driven that way) inherits that session's `PE_OUTCOME_FILE`,
      // `PE_TASKS_FILE` and `PE_RULINGS_FILE`. Each of those names ONE file
      // belonging to ONE attempt: a reviewer, a closeout or a QA round that
      // inherited the supervisor's would write its task list into the phase's
      // panel, and — worse — could file a declaration the runner reads as the
      // PHASE's own outcome and acts on. `undefined` deletes the key from the
      // spread, so a caller that states one still wins through `extra` below;
      // a caller that states none gets a session with no channel at all, which
      // is exactly what a reviewer is supposed to have.
      PE_OUTCOME_FILE: undefined,
      PE_TASKS_FILE: undefined,
      PE_RULINGS_FILE: undefined,
      // The proof ledger (control-tower phase 62): per plan like the rulings,
      // and a reviewer's run of a suite is not the phase's proof of it — nor
      // is the judging directory that keys one (phase 106, `proofEnv`).
      PE_PROOFS_FILE: undefined,
      PE_VERIFY_DIR: undefined,
      PE_RUN_ROOT: undefined,
      // The sessions' handled file (control-tower phase 136): what a reviewer
      // did is not what the phase's session handled instead of asking.
      PE_HANDLED_FILE: undefined,
      // The issue ledger too (phase 12): per PLAN rather than per attempt, but
      // a console started by a session of plan A must not hand plan A's
      // ledger to a reviewer of plan B — every site that wants it states it
      // through `issuesEnv()`.
      PE_ISSUES_FILE: undefined,
      // …and the policy beside it (control-tower phase 114): the run's word,
      // the suggestions switch and the estate's keys are THIS run's, stated by
      // `issuePolicyEnv()`, never a value inherited from whoever started us.
      PE_ISSUES_MODE: undefined,
      PE_ISSUES_SOURCE: undefined,
      PE_ISSUES_SUGGEST: undefined,
      PE_ISSUE_REPOS: undefined,
      // The trace, stated on exactly the same terms and for the same reason:
      // an inherited `PE_TRACE_ID` belongs to whichever session started this
      // console, and a session that joined THAT trace would file its evidence
      // under a run nobody is looking at. `envCarrier()` states all four keys
      // as `undefined` outside a span, so the delete happens either way.
      ...envCarrier(),
      ...account,
      ...extra,
    };
  }

  /**
   * Move this run onto the account with the most headroom, mid-phase.
   *
   * True when a switch happened: `state.accountId` now names the account every
   * next spawn pays with, and — when the interrupted session's transcript
   * could be carried into that account's config dir — `sessionAccountId` says
   * the conversation went along. False means there was nowhere better to go,
   * and the caller falls back to waiting exactly as if no second account
   * existed.
   */
  protected trySwitchAccount(
    phase: number, record: PhaseRecord, reason: string, model?: string, horizon?: Date | string | null,
  ): boolean {
    const state = this.state!;
    const from = state.accountId;
    // Named so per-model walls disqualify only where they bind: an account
    // exhausted on Opus still takes this phase when it runs on Sonnet.
    const forModel = model ?? record.model ?? state.model;
    // …and inside the run's pool when it declared one (control-tower phase
    // 53, #55): the best-ranked account the pool names, never one outside it.
    // Nothing in the pool → no switch, and the caller waits or pauses exactly
    // as if no second account existed.
    const pool = accountPool(state);
    const until = this.wallResetMs(horizon, from, forModel);
    // The account an automatic switch took the run off has reset (control-tower
    // phase 92, #100): back to it first. Past the horizon rule on purpose — it
    // would weigh a window that just reset against this account's wall, which
    // may be days off, and decline the run's own account for it.
    const back = this.switchBackTarget(forModel);
    let next: string | null | undefined;
    if (back) {
      next = back;
    } else if (this.deps.switchCandidates) {
      // Weighed against WHEN the wall being left resets (control-tower phase
      // 78, #100): an account that would wall before then is passed over, and
      // with none left the caller waits on the soonest reset instead of moving
      // the work somewhere it would be held for days.
      const plan = this.deps.switchCandidates(from, forModel, { until, pool, floors: this.accountFloors() });
      next = plan.ranked.find((id) => (!pool || pool.includes(id)) && id !== (from ?? 'default'));
      if (!next) {
        this.noteSwitchDeclined(phase, from, until, plan);
        return false;
      }
    } else {
      next = pool
        ? (this.deps.rankAccounts?.(from, forModel)
          ?? [this.deps.pickAccount?.(from, forModel)].filter((id): id is string => Boolean(id)))
          .find((id) => pool.includes(id))
        : this.deps.pickAccount?.(from, forModel);
    }
    if (!next || next === (from ?? 'default')) return false;
    let port: PortResult | null = null;
    if (record.sessionId) {
      port = this.deps.portTranscript?.(record.sessionId, record.sessionAccountId, next) ?? null;
      if (port?.findable) {
        if (next === 'default') delete record.sessionAccountId;
        else record.sessionAccountId = next;
      }
    }
    // The whole run moves — its queue with it (#92) — before the line that says so.
    const rekeyed = this.moveAccount(next);
    if (back) this.noteSwitchedBack(from ?? 'default', back, phase);
    else this.noteSwitchedFrom(from ?? 'default', until, reason);
    // `ported` is BYTES MOVED; `findable` is what the resume relies on. A
    // same-directory switch (the machine login → a token) reads
    // `ported: false, why: 'nothing to carry'` and still resumes (ACT-12).
    this.record('phase.account-switch', {
      from: from ?? 'default', to: next, reason,
      ported: port?.ported ?? false, findable: port?.findable ?? false, why: port?.why ?? null,
      cliVersion: port?.cliVersion ?? null, rekeyed,
    }, phase);
    this.emit('phase', { phase, status: 'running', accountSwitch: { from: from ?? 'default', to: next } });
    this.noteReversal(from ?? 'default', next, 'runner', reason, phase);
    return true;
  }

  /**
   * Put the run on `target` — the one place its account moves while a loop
   * drives it (control-tower phase 78, #92). The record, the pool
   * (`keepAccountInPool`) and the scheduler's queue move TOGETHER: every entry
   * this run has waiting is re-keyed to the new account keeping its age, and
   * the scan runs at once, so a phase that waited only on the old account's
   * window or brake boards in this very call. The switch used to move the
   * record alone, and each queued phase stayed behind the account the run had
   * just left — for days, behind a weekly wall. Answers how many entries moved.
   */
  protected moveAccount(target: string | undefined): number {
    const state = this.state!;
    const to = target && target !== 'default' ? target : undefined;
    if (to) state.accountId = to;
    else delete state.accountId;
    keepAccountInPool(state);
    // A move is a choice of account, and so of whose login spends (phase 91):
    // the run is bound to what the new account answers.
    this.bindIdentity('switch');
    return this.deps.scheduler?.rekeyRun(state.id, to) ?? 0;
  }

  /* ---------------- identity continuity (control-tower phase 91, #131) ---------------- */

  /** Who the run's account answers now, or undefined when nothing can say. */
  protected currentIdentity(): { account: string; key: string; email?: string; org?: string } | undefined {
    if (!this.state || !this.deps.identityOf) return undefined;
    try {
      return this.deps.identityOf(this.state.accountId) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Bind the run to the identity its account answers now — at a start that
   * has none, after a move to another account, and when a person accepts a
   * new login. Journalled `run.identity`; nothing when no registry can say.
   */
  protected bindIdentity(reason: 'start' | 'switch' | 'accepted'): void {
    const state = this.state;
    const now = this.currentIdentity();
    if (!state || !now) return;
    if (reason !== 'start' && state.identity?.key === now.key && state.identity.account === now.account) return;
    state.identity = { ...identityEcho(now), at: new Date().toISOString() };
    this.record('run.identity', { ...identityEcho(now), reason });
  }

  /**
   * Does the run's account answer somebody other than the identity the run is
   * bound to? Asked before every boarding and at a refused login. When it does,
   * the run is parked on it here (`parkOnIdentity`) and this answers true —
   * the caller boards nothing. A binding made on another account than the one
   * the run is on now is not compared: the move re-binds.
   */
  protected identityDrifted(phase?: number): boolean {
    const state = this.state;
    const bound = state?.identity;
    if (!state || !bound || bound.account !== (state.accountId ?? 'default')) return false;
    const now = this.currentIdentity();
    if (!now || now.key === bound.key) return false;
    this.parkOnIdentity(bound, now, phase);
    return true;
  }

  /**
   * The service's door: the identity behind `accountId` changed (the facade's
   * `onIdentityChange`). A run on that account, bound to another identity,
   * parks now — a live lane keeps its session, nothing new boards. Answers
   * whether it parked.
   */
  noteIdentityChange(accountId: string, now: { account: string; key: string; email?: string; org?: string }): boolean {
    const state = this.state;
    const bound = state?.identity;
    if (!state || !bound || (state.accountId ?? 'default') !== accountId || bound.account !== accountId) return false;
    if (bound.key === now.key || state.halt?.kind === 'identity-changed') return false;
    this.parkOnIdentity(bound, now, state.activePhase ?? undefined);
    return true;
  }

  /**
   * Park the run on an identity change: `run.identity-changed {was, now}`, the
   * errand offering both ways on, and the run-level halt `identity-changed`,
   * which only a person's press relaunches (`PRESS_ONLY_HALT_KINDS`). The
   * binding stays what it was — moving it is the person's choice.
   */
  protected parkOnIdentity(
    was: { account: string; key: string; email?: string; org?: string },
    now: { account: string; key: string; email?: string; org?: string },
    phase?: number,
  ): void {
    const state = this.state!;
    if (state.halt?.kind === 'identity-changed') return;
    this.record('run.identity-changed', {
      account: now.account, was: identityEcho(was), now: identityEcho(now), ...(phase != null ? { phase } : {}),
    });
    const words = identityChangeWords(state.slug, was, now);
    const errand: Errand = { ...errandFor('resource-wall:auth', [], phase ?? 0, new Date().toISOString(), null), need: words.need, how: words.how };
    state.errand = errand;
    this.record('run.errand', { ...errand, reason: 'the identity behind the run\'s account changed', by: 'runner' });
    if (phase != null) this.emit('phase', { phase, status: state.phases[String(phase)]?.status ?? 'parked', errand });
    this.halt(words.halt, phase, 'identity-changed');
  }

  /**
   * When the wall this run is leaving resets, ms epoch — the horizon the switch
   * picker weighs a target against (#100). The caller's reset when it knows one
   * (the CLI's, the live wall's), else the reset the quota door now reads on the
   * account after `leaveAccount` marked it; null when neither says.
   */
  protected wallResetMs(horizon: Date | string | null | undefined, from: string | undefined, forModel?: string): number | null {
    const given = horizon instanceof Date ? horizon.getTime() : typeof horizon === 'string' ? Date.parse(horizon) : Number.NaN;
    if (Number.isFinite(given)) return given;
    const verdict = this.deps.accountHeadroom?.(from, forModel);
    const read = verdict && !verdict.ok && verdict.resetsAt ? Date.parse(verdict.resetsAt) : Number.NaN;
    return Number.isFinite(read) ? read : null;
  }

  /**
   * The account the run is owed a move back to, now (control-tower phase 92,
   * #100): the origin an automatic switch recorded (`state.switchedFrom`), once
   * its wall's reset has passed and the facade reads room on it. Null while it
   * is still walled, when the run is already on it, or when nothing is owed.
   */
  protected switchBackTarget(forModel?: string): string | null {
    const state = this.state;
    const origin = state?.switchedFrom;
    if (!state || !origin || origin.accountId === (state.accountId ?? 'default')) return null;
    const resets = Date.parse(origin.resetsAt);
    if (Number.isFinite(resets) && this.now().getTime() < resets) return null;
    let room: { ok: boolean } | undefined;
    try {
      room = this.deps.accountRoom?.(origin.accountId === 'default' ? undefined : origin.accountId, forModel);
    } catch {
      room = { ok: false };
    }
    return room && !room.ok ? null : origin.accountId;
  }

  /**
   * The run's own `minHeadroomPct` per account, as the switch picker reads it
   * (control-tower phase 92, #100 ask 1) — null when the run names no floor.
   */
  protected accountFloors(): Record<string, number> | null {
    const floors: Record<string, number> = {};
    for (const row of this.state?.accounts ?? []) {
      if (row.minHeadroomPct > 0) floors[row.id] = row.minHeadroomPct;
    }
    return Object.keys(floors).length ? floors : null;
  }

  /**
   * An automatic move off `from` under a wall that resets at `until`: the run
   * owes `from` a move back then. The FIRST origin is kept — a run moved a → b
   * → c goes back to a, the account it was started on or a person chose.
   */
  protected noteSwitchedFrom(from: string, until: number | null, reason: string): void {
    const state = this.state!;
    if (state.switchedFrom || until === null || !Number.isFinite(until)) return;
    state.switchedFrom = { accountId: from, resetsAt: new Date(until).toISOString(), at: this.now().toISOString(), reason };
  }

  /** The move back happened: said once, and nothing is owed any more. */
  protected noteSwitchedBack(from: string, to: string, phase?: number): void {
    const state = this.state!;
    const origin = state.switchedFrom;
    delete state.switchedFrom;
    this.record('run.account-switch-back', {
      from, to, resetsAt: origin?.resetsAt ?? null, movedAt: origin?.at ?? null,
      ...(phase != null ? { phase } : {}),
    }, phase);
  }

  /**
   * At a boarding — the lanes' boundary — move the run back onto the account
   * an automatic switch took it off, once that account has reset (#100's ask
   * 2). Nothing live is interrupted: the phase about to board is the first to
   * spawn there. Answers whether it moved.
   */
  protected switchBackAtBoundary(phase: number): boolean {
    const state = this.state;
    if (!state?.switchedFrom) return false;
    const target = this.switchBackTarget(phaseRecord(state, phase).model ?? state.model);
    if (!target) return false;
    const from = state.accountId ?? 'default';
    this.moveAccount(target);
    this.noteSwitchedBack(from, target, phase);
    this.persist();
    this.emit('run', { state });
    return true;
  }

  /** The soonest a pool member frees up, per phase, from the last declined switch — see `soonestReset`. */
  private readonly switchWakes = new Map<number, number>();

  /**
   * Nowhere to switch to that carries the work past the wall (#100): said once,
   * naming every account the horizon rule passed over, and the soonest moment a
   * pool member frees up is kept for the caller's wait (`soonestReset`).
   */
  private noteSwitchDeclined(
    phase: number, from: string | undefined, until: number | null,
    plan: { declined: readonly { id: string; bucket: string; pct: number | null; resetsAt: string | null; why: string }[]; wake: string | null },
  ): void {
    const wake = plan.wake ? Date.parse(plan.wake) : Number.NaN;
    if (Number.isFinite(wake)) this.switchWakes.set(phase, wake);
    else this.switchWakes.delete(phase);
    this.record('phase.switch-declined', {
      from: from ?? 'default', until: until === null ? null : new Date(until).toISOString(),
      declined: plan.declined.map((row) => ({ id: row.id, bucket: row.bucket, pct: row.pct, resetsAt: row.resetsAt, why: row.why })),
      wake: plan.wake,
    }, phase);
  }

  /**
   * The moment a wall with no account to move to should be waited on (#100,
   * SH-2): its own reset, or sooner when the declined switch found a pool
   * member that frees up first — the soonest reset, never the latest.
   */
  protected soonestReset(phase: number, at: Date): Date {
    const wake = this.switchWakes.get(phase);
    this.switchWakes.delete(phase);
    // …and the account an automatic switch took the run off, when it resets
    // first (control-tower phase 92, #100): a wall on the account it moved to
    // is waited on only until the run can go back.
    const state = this.state;
    const origin = state?.switchedFrom && state.switchedFrom.accountId !== (state.accountId ?? 'default')
      ? Date.parse(state.switchedFrom.resetsAt) : Number.NaN;
    const nowMs = this.now().getTime();
    let best = at.getTime();
    for (const t of [wake ?? Number.NaN, origin]) {
      if (Number.isFinite(t) && t < best && t > nowMs) best = t;
    }
    return new Date(best);
  }

  /**
   * A switch that moves the run back onto the account a PERSON moved it away
   * from reverses that person (#106): journalled `run.account-switch-reverted`
   * and handed to the service to announce. Only ever under a live wall on the
   * person's choice — every mover checks the account it is leaving first — so
   * this names the reversal rather than preventing it.
   */
  protected noteReversal(from: string, to: string, by: string, reason: string, phase?: number): void {
    const state = this.state!;
    const choice = state.accountChoice;
    if (!choice || choice.from !== to || from === to) return;
    this.record('run.account-switch-reverted', { from, to, choice, by, reason }, phase);
    try { this.deps.onAccountSwitchReverted?.(state, { from, to, choice, by, reason }); } catch { /* an announcement never stops a switch */ }
  }

  /**
   * Is this live lane only closing out (control-tower phase 78, #107)? Its
   * phase's handoff already reads `complete` — the board's word for done — or
   * its session has declared its outcome for this attempt. The work is
   * finished either way, and what is left is the landing, the lock and the
   * handoff commits: checkpointing it cut a closeout mid-tool and moved nothing
   * worth moving. Answers why, or null for a lane still working.
   */
  protected closingLane(lane: Lane): 'handoff-complete' | 'outcome-declared' | null {
    const state = this.state!;
    if (this.deps.handoffFor?.(state.slug, lane.phase)?.status === 'complete') return 'handoff-complete';
    const record = phaseRecord(state, lane.phase);
    const declared = readOutcome(outcomeFileFor(state.root, state.slug, state.id, lane.phase), {
      slug: state.slug, phase: lane.phase, notBefore: record.attemptStartedAt ?? record.startedAt,
    });
    return declared ? 'outcome-declared' : null;
  }

  /**
   * A run is leaving `accountId` (the run's own account unless named) — the
   * ONE runner door onto `accounts.leaveAccount` (ACT-5, SES-2): the account
   * is marked machine-wide BEFORE any switch, the scheduler holds it for what
   * the answer says, and the departure is journalled as the account's fact
   * (`run.account-cooling` for a window, `run.account-retired` for a
   * refusal; a person's switch has `run.account-switch` already). Every
   * `trySwitchAccount` is paired with a call to this — `test/invariants.test.ts`
   * holds the pair — because the live wall once switched without marking, and
   * the picker sent the run straight back.
   */
  protected leaveAccount(phase: number | undefined, leaving: LeaveReason, accountId = this.state?.accountId): LeaveResult | null {
    const result = this.deps.leaveAccount?.(accountId, leaving) ?? null;
    if (!result) return null;
    if (result.throttleUntilMs) {
      this.deps.scheduler?.throttle(result.throttleUntilMs, result.accountId, result.wall?.bucket ?? LEARNED_WALL_BUCKET);
    }
    if (leaving.kind !== 'operator') {
      this.record(leaving.kind === 'credential' ? 'run.account-retired' : 'run.account-cooling', {
        id: result.accountId, orgId: result.orgIdHash ?? null, reason: leaving.reason, by: leaving.by,
        state: result.state, until: result.until ?? null, wall: result.wall ?? null,
        ...(leaving.class ? { class: leaving.class } : {}),
        ...(leaving.bucket ? { bucket: leaving.bucket } : {}),
      }, phase);
    }
    return result;
  }

  /** Is the recorded session's transcript where the CURRENT account will look? */
  protected transcriptFollows(record: PhaseRecord): boolean {
    return (record.sessionAccountId ?? 'default') === (this.state?.accountId ?? 'default');
  }

  /**
   * May THIS session be handed to `--resume`, under the run's account, now?
   *
   * ONE check for every `--resume` this runner spawns — and since
   * zero-touch-console phase 5 the only thing that can mint the `VettedResume`
   * the spawn door takes, so a site that skips it does not compile. It once
   * lived on the drive loop's boarding alone, so the healer's resume and the QA
   * round asked nothing (three runs spent a rung every two minutes on `No
   * conversation found`); then the boarding, the closeout and the PR session
   * each kept a copy of half of it (SLF-10).
   *
   * Four questions, in the order that matters:
   *  1. Is it stamped gone? A resume the CLI already refused is never offered
   *     again — journalled `phase.resume-lost` once per session, wherever the
   *     stamp is met.
   *  2. Is it still RUNNING? The registry's presence (REG-1): `live` is refused
   *     and recorded (`phase.resume-refused`, announced once) — resuming it
   *     would put a second `claude` on its transcript in its working tree.
   *     `unknown` proceeds: the boarding's own lock claim is the lease rule.
   *  3. Is it worth resuming? (autopilot-token-drain phase 4, `resumePolicy`) A
   *     large session gone cold, or under another account, writes its whole
   *     context again on its first call; one the console checkpointed or that
   *     declared `partial --reason budget|context` said it is spent. `fresh` —
   *     the caller boards the phase fresh with the resume brief. Journalled
   *     `phase.resume-policy` either way. Asked before the port: a transcript
   *     nobody will resume is not carried anywhere.
   *  4. Is its transcript where the paying account looks? Carried over when it
   *     can be; when it cannot, a self-contained boot beats a resume that finds
   *     nothing.
   */
  protected resumableSession(record: PhaseRecord, sessionId: string | undefined): ResumeVerdict {
    if (!sessionId) return { ok: false, why: 'none' };
    if (isSessionGone(record, sessionId)) {
      this.noteGoneResume(record, sessionId);
      return { ok: false, why: 'gone', sessionId };
    }
    const seen = this.deps.sessionPresence?.(sessionId) ?? { presence: 'unknown' as const };
    if (seen.presence === 'live') {
      this.refuseLiveResume(record, sessionId, seen.pid);
      return { ok: false, why: 'session-live', sessionId, ...(seen.pid ? { pid: seen.pid } : {}) };
    }
    const policy = this.resumePolicyFor(record, sessionId);
    if (policy.choice === 'fresh') return { ok: false, why: 'fresh', sessionId, policy };
    const state = this.state!;
    if (!this.transcriptFollows(record)) {
      const port = this.deps.portTranscript?.(sessionId, record.sessionAccountId, state.accountId) ?? null;
      this.record('phase.transcript-port', {
        sessionId, from: record.sessionAccountId ?? 'default', to: state.accountId ?? 'default',
        ported: port?.ported ?? false, findable: port?.findable ?? false, why: port?.why ?? null,
        cliVersion: port?.cliVersion ?? null,
      }, record.phase);
      if (!port?.findable) return { ok: false, why: 'unported', sessionId };
    }
    if (record.resumeRefused?.sessionId === sessionId) delete record.resumeRefused;
    return { ok: true, resume: { sessionId, presence: seen.presence } as VettedResume };
  }

  /**
   * The resume policy's answer for this session, under the account paying now —
   * journalled `phase.resume-policy` once per decision about one run of it: the
   * boarding and the spawn door both ask, a second or two apart, and a session
   * that ran again (or went cold since) is a new decision. `quiet` looks ahead
   * without journalling: the boarding asks it before deciding to ask the gate.
   */
  protected resumePolicyFor(record: PhaseRecord, sessionId: string, opts: { quiet?: boolean } = {}): ResumePolicy {
    const policy = resumePolicy(record, sessionId, {
      now: this.now().getTime(), paying: this.state ? this.state.accountId ?? 'default' : null,
    });
    if (opts.quiet) return policy;
    const ran = [...(record.tokens ?? [])].reverse().find((row) => row.sessionId === sessionId)?.endedAt ?? '';
    const key = `${record.phase}:${sessionId}:${ran}:${policy.choice}:${policy.reason}`;
    if (!this.policyJournalled.has(key)) {
      this.policyJournalled.add(key);
      this.record('phase.resume-policy', { sessionId, ...policy }, record.phase);
    }
    return policy;
  }

  /** The resume decisions this runner already journalled, by `phase:session:run:choice:reason`. */
  private readonly policyJournalled = new Set<string>();

  /** The sessions this runner already journalled `phase.resume-lost` for, by `phase:session`. */
  private readonly lostJournalled = new Set<string>();

  /**
   * A resume that met a session already stamped gone: journalled `phase.resume-lost`
   * once per session, wherever it is met (SLF-10) — the record already says it,
   * and the journal said nothing when the stamp was met a second time.
   */
  protected noteGoneResume(record: PhaseRecord, sessionId: string): void {
    const key = `${record.phase}:${sessionId}`;
    if (this.lostJournalled.has(key)) return;
    this.lostJournalled.add(key);
    this.record('phase.resume-lost', {
      sessionId, account: this.state?.accountId ?? 'default',
      reason: `already marked gone (${record.sessionGone?.reason ?? 'no reason recorded'}) — not offered to --resume again`,
    }, record.phase);
  }

  /**
   * A resume refused because its session is still running: on the record (the
   * page shows it), on the journal, and announced — once per session, however
   * many boardings meet it (REG-1).
   */
  private refuseLiveResume(record: PhaseRecord, sessionId: string, pid: number | undefined): void {
    if (record.resumeRefused?.sessionId === sessionId) return;
    this.noteResumeRefused(record.phase, {
      sessionId, why: 'session-live', by: 'runner', ...(pid ? { pid } : {}),
    });
  }

  /**
   * A session `--resume` cannot reach any more: say so once, on the record and
   * in the journal, and score the rung that tried it FAILED.
   *
   * `failed`, never `interrupted`. An interrupted rung "never effectively ran
   * and may run again" — the reading under which the same dead `--resume` was
   * offered nineteen times. A resume the CLI refuses will be refused the next
   * time too: the rung was tried, and the ladder's next rung is a fresh
   * session that needs no transcript.
   */
  protected markSessionGone(record: PhaseRecord, sessionId: string, reason: string): void {
    const state = this.state!;
    const at = this.now().toISOString();
    record.sessionGone = { sessionId, at, reason };
    this.record('phase.resume-lost', {
      sessionId, account: state.accountId ?? 'default', reason,
    }, record.phase);
    this.settleOpenRung(record.phase, 'failed', `session ${sessionId} cannot be resumed under this account — ${reason}`);
    this.persist();
  }

  /**
   * The auth wall's first rung: move a run whose account will not sign in
   * onto one that will, before anything is spent. Each candidate is PROBED
   * in ranking order (`checkAuth` — headroom says nothing about a login) and
   * the first that answers signed-in takes the run; `tried` names the ones
   * that did not, for the errand. Off under `autoAccountSwitch: false`, and
   * impossible without the account-aware probe (the legacy one answers only
   * for the machine login).
   */
  private async switchAccountAtPreflight(reason: 'auth' | 'quota', detail?: string): Promise<{ switched: boolean; tried: string[] }> {
    const state = this.state!;
    const tried: string[] = [];
    if (this.deps.autoAccountSwitch?.() === false || !this.deps.checkAuth) return { switched: false, tried };
    const from = state.accountId;
    // Ranked INSIDE the run's pool, its members probed first (control-tower
    // phase 53, #55): a run that declared three accounts failed over onto a
    // fourth nobody had named, with `tried: []` — the pool it had never asked.
    // With the pool spent the caller parks with an errand naming the pool;
    // failover never leaves it by itself.
    const pool = accountPool(state);
    // A spent window is a wall with a reset like any other (control-tower phase
    // 78, #100): the same picker the mid-run wall uses, so an account that
    // would wall before this one resets is never probed, only named in `tried`.
    const plan = reason === 'quota' && this.deps.switchCandidates
      ? this.deps.switchCandidates(from, state.model, { until: this.wallResetMs(null, from, state.model), pool, floors: this.accountFloors() })
      : null;
    const passedOver = new Set(plan?.declined.map((row) => row.id) ?? []);
    for (const row of plan?.declined ?? []) tried.push(`switch-account → ${row.id}: ${row.why}`);
    const ranked = rankInPool(
      plan?.ranked ?? this.deps.rankAccounts?.(from, state.model)
        ?? [this.deps.pickAccount?.(from, state.model)].filter((id): id is string => Boolean(id)),
      pool, from ?? 'default',
    ).filter((id) => !passedOver.has(id));
    for (const next of ranked) {
      if (next === (from ?? 'default')) continue;
      // Both doors, in the cheap order: the quota verdict is a cache read, the
      // login probe is a process. A candidate with no headroom is never probed.
      const quota = this.deps.accountHeadroom?.(next === 'default' ? undefined : next, state.model);
      if (quota && !quota.ok) { tried.push(`switch-account → ${next}: ${quota.reason}`); continue; }
      const probe = await this.deps.checkAuth(next === 'default' ? undefined : next);
      if (!probe.loggedIn) { tried.push(`switch-account → ${next}: not signed in`); continue; }
      if (reason === 'quota') {
        // The wall the run is walking away from, written before the walk —
        // the same rule as every mid-run mover: a retired account stays
        // retired, a spent window is a wall until its reset.
        const verdict = this.deps.accountHeadroom?.(from, state.model);
        const resetsAt = verdict && !verdict.ok && verdict.resetsAt ? new Date(verdict.resetsAt) : null;
        if (!(verdict && !verdict.ok && verdict.kind === 'retired')) {
          this.leaveAccount(undefined, {
            kind: 'usage', reason: detail ?? 'no headroom at preflight', by: 'preflight',
            ...(resetsAt ? { bucket: 'five_hour', resetsAt } : {}),
          }, from);
        }
      }
      // The retirement the run is leaving, when that is why (#57): what it
      // stood on, so the switch says why it happened and not only that it did.
      const leaving = this.deps.accountHeadroom?.(from, state.model);
      const evidence = leaving && !leaving.ok && leaving.kind === 'retired' ? leaving.evidence : undefined;
      this.record('run.account-switched', {
        from: from ?? 'default', to: next, at: 'preflight', reason,
        detail: detail ?? null, tried, ...(pool ? { pool } : {}),
        ...(evidence ? { evidence } : {}),
      });
      // Through the one mover (#92): the record, the pool and anything already
      // queued go together.
      const walledUntil = reason === 'quota' ? this.wallResetMs(null, from, state.model) : null;
      this.moveAccount(next);
      // A spent window resets like any wall: the run is owed a move back then (#100).
      if (reason === 'quota') this.noteSwitchedFrom(from ?? 'default', walledUntil, detail ?? 'no headroom at preflight');
      this.emit('run', { state });
      return { switched: true, tried };
    }
    return { switched: false, tried };
  }

  /**
   * Sit out a usage window. `pause` checkpoints the phase and stops for a
   * person (the `escalateFreeze` shape: phase back to pending with a session
   * to resume, run paused, reason on the run); `wait` — the default — puts
   * the RUN to `waiting` on the clock and sleeps. Restart-safe either way:
   * reconcile keeps `waitUntil`, the service re-arms the resume at boot.
   *
   * `errand` is the one ask left on the run while it waits (a reset too far
   * out and no other account), cleared when the wait ends; `policy` overrides
   * the run's `onLimit` for a wall the policy does not speak for (a model
   * window is not the shared window). Answers what the attempt loop does
   * next: `continue` (the window passed, try again) or `stop` (paused,
   * aborted, or the run halted meanwhile).
   */
  protected async waitOutWindow(
    phase: number, record: PhaseRecord, at: Date, reason: string,
    opts: { errand?: Errand; policy?: 'wait' | 'pause' } = {},
  ): Promise<'continue' | 'stop'> {
    const state = this.state!;
    const policy = opts.policy ?? ((state.onLimit ?? 'wait') === 'pause' ? 'pause' : 'wait');
    if (policy === 'pause') {
      record.status = 'pending';
      if (record.sessionId) record.resumeSessionId = record.sessionId;
      setRunState(state, 'paused');
      // The POLICY stopped this run, not a person, and the record should say so
      // rather than leave it to be guessed. `stoppedByOperator` answers from
      // `stoppedBy` when it is there and from a pre-field heuristic when it is
      // not — and that heuristic reads `status === 'paused'` as somebody's
      // press, which this is not.
      //
      // ⚠️ Scope, honestly: the symptom D17 was written up as — convergence
      // reporting "the operator stopped it" about this run — is NOT reachable,
      // and QA was right to say so. `waitUntil` is set on the next line, and
      // `converge.ts`'s `waitUntil && (paused|waiting)` skip fires BEFORE
      // `stoppedByOperator` is ever consulted. So this line fixes an
      // attribution that was wrong in the record rather than a misreport anyone
      // has seen. It is still worth writing: every other reader of `stoppedBy`
      // gets the truth, `systemStop` becomes true for exactly the shape that
      // predicate exists for, and the next reader is not left inferring intent
      // from a status word. Verified side-effect-free at the time: `inbox.ts`'s
      // stop rows and `SETTLEABLE` both require halted/interrupted/parked, and
      // this path writes `paused`.
      state.stoppedBy = 'system';
      state.waitUntil = at.toISOString();
      setRunState(state, 'paused', { kind: 'usage-limit', until: state.waitUntil });
      state.finishedReason = `usage limit — resets ${at.toLocaleString()}. `
        + 'Continue now under another account, or wait for the window.';
      if (opts.errand) {
        state.errand = opts.errand;
        this.record('run.errand', { ...opts.errand, reason, by: 'runner' });
      }
      this.record('run.limit-paused', { until: state.waitUntil, reason }, phase);
      this.persist();
      this.emit('run', { state });
      return 'stop';
    }

    state.waitUntil = at.toISOString();
    setRunState(state, 'waiting', { kind: 'usage-limit', until: state.waitUntil });
    if (opts.errand) {
      state.errand = opts.errand;
      this.record('run.errand', { ...opts.errand, reason, by: 'runner' });
    }
    this.record('run.waiting', { until: state.waitUntil, reason });
    this.persist();
    await this.sleep(Math.max(0, at.getTime() - this.now().getTime()));
    if (this.abort?.signal.aborted) return 'stop';
    // A wait can be hours, which makes it the likeliest place for a pause
    // to be armed — and writing `running` unconditionally is how one got
    // thrown away. `state.pause` is the durable record of the request;
    // the status word is derived from it, never the other way round.
    // Compare-and-set for the same reason as after the queue wait: a
    // status another lane wrote while this one slept is not this lane's
    // to overwrite.
    if (state.status === 'waiting') setRunState(state, this.resumedStatus());
    state.waitUntil = null;
    state.waitReason = null;
    // The ask was about this wait; the wait is over.
    if (opts.errand && state.errand === opts.errand) delete state.errand;
    // And a lane woken into a halted run must stand down, not spawn
    // attempt N+1 hours after the run stopped.
    if (state.halt) {
      record.status = 'interrupted';
      record.note = 'the run halted while this phase waited for a usage window';
      return 'stop';
    }
    return 'continue';
  }

  /**
   * Sit out an outage. The `waitOutWindow` shape with everything policy-shaped
   * removed: a usage window belongs to an ACCOUNT and the run's `onLimit` says
   * what to do about it, but no policy has an opinion about the network being
   * down. So the run waits, always, and says what it is waiting on.
   *
   * `connectivity` rather than `external` because the two answer an operator's
   * question differently: `external` means somebody else's clock is running
   * and there is nothing to do, this means the network is the thing to look at
   * — and the run will come back by itself either way.
   *
   * Since control-tower phase 80 (#108) the wait is the connectivity probe's
   * (phase 76's helper): a look at the API every `CONNECTIVITY_PROBE_MS`, and
   * the lane wakes the moment one answers. `at` is only the latest it sleeps —
   * the backstop, `CONNECTIVITY_BACKOFF_MS` — which is still the run's `until`,
   * so a restart re-arms the same clock it always did. Answers how the wait
   * ended: `recovered` (the probe heard the API), `elapsed` (the backstop),
   * or `stop`.
   */
  protected async waitOutOutage(
    phase: number, record: PhaseRecord, at: Date, reason: string,
  ): Promise<'recovered' | 'elapsed' | 'stop'> {
    const state = this.state!;
    state.waitUntil = at.toISOString();
    setRunState(state, 'waiting', { kind: 'connectivity', until: state.waitUntil });
    this.record('run.waiting', { until: state.waitUntil, reason }, phase);
    this.persist();
    this.emit('run', { state });
    // Listening before the probe is armed, so no answer can land unheard.
    const probe = this.connectivityProbe();
    const heard = new AbortController();
    const unsubscribe = probe?.onRecovered(() => heard.abort());
    probe?.noteUnreachable();
    try {
      await this.sleep(Math.max(0, at.getTime() - this.now().getTime()), heard.signal);
    } finally {
      unsubscribe?.();
    }
    if (this.abort?.signal.aborted) return 'stop';
    if (state.status === 'waiting') setRunState(state, this.resumedStatus());
    state.waitUntil = null;
    state.waitReason = null;
    if (state.halt) {
      record.status = 'interrupted';
      record.note = 'the run halted while this phase waited for the network';
      return 'stop';
    }
    // A per-lane stop landing during the wait is consumed by the attempt
    // loop's own guard on the next iteration, before anything is spawned.
    return heard.signal.aborted ? 'recovered' : 'elapsed';
  }

  /**
   * Wait out an engine that timed out reading the plan (control-tower phase 81,
   * #104). The `waitOutOutage` shape for the MACHINE: the run reads `waiting`
   * on `engine-busy` with the clock it resumes on, the wait is journalled with
   * the machine's load beside it, and nothing is charged — no failure, no halt,
   * no rung. `attempt` is 1-based and picks the step of the back-off series.
   * Answers `stop` when the run was stopped or halted during the wait.
   */
  protected async waitOutEngineBusy(attempt: number, error: string): Promise<'elapsed' | 'stop'> {
    const state = this.state!;
    const series = this.deps.engineBusyBackoffMs ?? ENGINE_BUSY_BACKOFF_MS;
    const delayMs = series[Math.min(attempt, series.length) - 1] ?? 0;
    const until = new Date(this.now().getTime() + delayMs).toISOString();
    state.waitUntil = until;
    setRunState(state, 'waiting', { kind: 'engine-busy', until });
    this.record('run.engine-busy', {
      attempt, delayMs, until, error: error.slice(0, 300),
      load: Math.round(loadavg()[0] * 100) / 100, cpus: cpus().length,
    });
    this.persist();
    this.emit('run', { state });
    await this.sleep(delayMs);
    // A stop that landed during the wait is the loop top's to settle — writing
    // `running` here first would broadcast a word the run never had
    // (`waitOutOutage`'s and `waitOutWindow`'s rule, and `resumedStatus`'s).
    if (this.abort?.signal.aborted) return 'stop';
    if (state.status === 'waiting') setRunState(state, this.resumedStatus());
    state.waitUntil = null;
    state.waitReason = null;
    this.persist();
    this.emit('run', { state });
    return state.halt ? 'stop' : 'elapsed';
  }

  /**
   * The probe an outage's wait listens to — `deps.connectivity`, which the
   * service shares with every run it starts. A runner handed none (a test
   * harness) waits on its backstop clock alone and never touches the network.
   */
  protected connectivityProbe(): ConnectivityProbe | null {
    return this.deps.connectivity ?? null;
  }

  /* ---------------------------------------------------------------- *
   * The failure streak — one writer
   * ---------------------------------------------------------------- */

  /**
   * Charge one failure against the run's consecutive-failure bound, and answer
   * where the counter now stands. **The only place `consecutiveFailures` is
   * incremented**, which `outage-classifier.test.ts` OC-6 holds by scanning
   * this directory's source.
   *
   * The counter is the run's single "this plan is broken, stop" bound, and
   * `failure-streak` is in `PRESS_ONLY_HALT_KINDS` because spending it is
   * meant to be a considered stop a person reviews. That makes WHAT may spend
   * it the whole question, and it used to be answered in nine places that did
   * not know about each other. Measured: one transient network event produced
   * three halts in 39 seconds, each charged, leaving a run reading **3 of a
   * maximum 2** — over its own ceiling, with no automatic path back, and with
   * the signal destroyed, since the number no longer meant "this plan keeps
   * failing".
   *
   * Two refusals, both of them about facts rather than policy:
   *
   *  - **Nothing charges while the run is already stopped on a wall it did not
   *    cause.** A second lane meeting the same refused credential is the same
   *    event reaching a second reader, not the next failure.
   *  - **The counter never exceeds its maximum.** At the bound the run has
   *    already said everything it can say; 3 of 2 is not a stronger verdict
   *    than 2 of 2, it is an unreadable number.
   *
   * What does NOT charge is decided by the callers, and the rule the arms
   * follow is: a wall between this machine and the API is not a claim about
   * the plan. `credential-refused` and `connectivity` both halt or wait
   * without calling this at all.
   *
   * **Since control-tower phase 45 (#45, #59) the streak is a SET, not a
   * tally**: the ordered DISTINCT phases whose ending was a merit failure
   * (`MERIT_FAILURE_CAUSES`), and `consecutiveFailures` is its size. Three
   * more refusals follow from that, each journalled as held with the cause:
   *
   *  - **A cause that is not a merit failure** — work on disk with the
   *    paperwork missing, the network for half a day — says nothing about the
   *    plan and moves nothing.
   *  - **A phase already in the set** is the same failure ending again (a
   *    recheck, a second declared block, a retry that met the same wall): the
   *    week this was measured, two of the six streak halts counted ONE phase as
   *    "2 phases failed in a row".
   *  - **The bound**, as before.
   *
   * **Since control-tower phase 87 (#122) it counts ROOT CAUSES too.** A charge
   * may name what it is blamed on (`root`, from `failureRootOf`: the blamed
   * commit, else the refs a block watched), and a second charge on a cause a
   * counted phase already carries is held, naming that phase — one sibling's red
   * WIP stopping four honest phases is one failure, not four. A charge that
   * names nothing counts per phase, as it always did.
   */
  protected chargeFailure(phase: number, cause: FailureCause, reason?: string, root?: FailureRoot | null): number {
    const state = this.state!;
    if (!state) return 0;
    const max = state.maxConsecutiveFailures;
    const counted = streakPhases(state);
    const was = state.consecutiveFailures;
    const same = root ? (state.failureRoots ?? []).find((entry) => entry.key === root.key && counted.includes(entry.phase)) : undefined;
    const why = !isMeritFailure(cause) ? `not a merit failure (${cause}) — it says nothing about the plan`
      : state.halt?.kind === 'credential-refused' ? 'the run is already halted on a refused credential'
        : counted.includes(phase) ? `phase ${phase} is already counted — a second ending of one phase is one failure`
          : same ? `the same root cause is already counted — ${same.label}, charged to phase ${same.phase}`
            : max > 0 && was >= max ? 'the counter is at its maximum'
              : null;
    if (why) {
      this.record('run.failure-streak-held', {
        consecutiveFailures: was, max, why, cause, phases: counted,
        ...(reason ? { reason } : {}),
        ...(root ? { root: root.key } : {}),
        ...(same ? { sameAs: same.phase } : {}),
      }, phase);
      return was;
    }
    // A count the set cannot name (a run written before it existed) is carried
    // as the head of the new set's size, never silently dropped.
    const unnamed = Math.max(0, was - counted.length);
    state.failureStreak = [...counted, phase];
    state.consecutiveFailures = unnamed + state.failureStreak.length;
    if (root) {
      state.failureRoots = [
        ...(state.failureRoots ?? []).filter((entry) => counted.includes(entry.phase)),
        { phase, key: root.key, label: root.label },
      ];
    }
    this.record('run.failure-charged', {
      consecutiveFailures: state.consecutiveFailures, max, cause, phases: state.failureStreak,
      ...(reason ? { reason } : {}),
      ...(root ? { root: root.key } : {}),
    }, phase);
    return state.consecutiveFailures;
  }

  /**
   * Zero the streak, and say who did it and through what. The verb #37 asked
   * for: a run could sit at 3 of a maximum 2 with nothing in the console able
   * to bring it back, because the one thing that used to reset the counter —
   * the convergence loop's relaunch — was removed for resetting it 25 times
   * against 3 such halts. Answers what the counter was.
   */
  /**
   * An operator's raise has landed where the budget was declared
   * (control-tower phase 14, #40): journal `run.budget-raised` on this run and
   * answer the hold the budget left (`clearBudgetHold`). The service wrote the
   * plan or the setting first and retries after; this is the part only the
   * loop may touch while it runs. Answers what it cleared.
   */
  budgetRaised(data: { budget: BudgetKind; phase: number | null; was: number; now: number } & Record<string, unknown>): string[] {
    const state = this.state!;
    const cleared = clearBudgetHold(state, data.budget, data.phase);
    // A raise answers the approach too: the card that offered it goes (phase 25).
    const holder = data.phase == null ? state : state.phases[String(data.phase)];
    if (holder?.budgetApproaching?.[data.budget]) {
      const { [data.budget]: _answered, ...rest } = holder.budgetApproaching;
      holder.budgetApproaching = rest;
    }
    this.record('run.budget-raised', { ...data, ...(cleared.length ? { cleared } : {}) }, data.phase ?? undefined);
    this.persist();
    this.emit('run', { state });
    return cleared;
  }

  clearStreak(by: string, via: string, reason?: string): number {
    const state = this.state!;
    const phases = streakPhases(state);
    const was = resetStreak(state);
    this.record('run.failure-streak-reset', {
      was, by, via, ...(phases.length ? { phases } : {}), ...(reason ? { reason } : {}),
    });
    this.persist();
    this.emit('run', { state });
    return was;
  }

  /**
   * The budget wall's first rung: a spent run budget is raised ONCE, by
   * `budgetAutoRaisePct` and never past the ladder's per-run USD cap, so a
   * run a few dollars short of done does not stop for a person over the
   * rounding. Journalled; the second exhaustion is the errand. False when
   * there is nothing to raise to: already raised, the raise switched off, the
   * budget at or above the cap, or a raise the run has already overspent.
   */
  protected raiseBudgetOnce(): boolean {
    const state = this.state!;
    if (!state.runBudgetUsd || state.budgetRaise) return false;
    const pct = this.deps.budgetAutoRaisePct?.() ?? DEFAULT_BUDGET_RAISE_PCT;
    if (!(pct > 0)) return false;
    const cap = this.deps.ladderCaps?.().perRunUsd ?? DEFAULT_LADDER_CAPS.perRunUsd;
    const from = state.runBudgetUsd;
    const to = Math.round(Math.min(from * (1 + pct / 100), Math.max(cap, from)) * 100) / 100;
    if (to <= from || to <= state.spentUsd) return false;
    state.budgetRaise = { from, to, pct, at: new Date().toISOString() };
    state.runBudgetUsd = to;
    if (state.budgetApproaching?.['run-usd']) {
      const { 'run-usd': _answered, ...rest } = state.budgetApproaching;
      state.budgetApproaching = rest;
    }
    // One event for every raise (control-tower phase 14, #40): the operator's
    // `raise-budget` writes `{budget, was, now, by, via}`, and so does this one.
    this.record('run.budget-raised', {
      from, to, pct, cap, spentUsd: state.spentUsd,
      budget: 'run-usd', was: from, now: to, by: 'runner', via: 'auto-raise',
    });
    this.emit('run', { state });
    this.persist();
    return true;
  }

  /** The budget halt, with the errand naming what was already tried. */
  protected haltOnBudget(): void {
    const state = this.state!;
    const raise = state.budgetRaise;
    const cap = this.deps.ladderCaps?.().perRunUsd ?? DEFAULT_LADDER_CAPS.perRunUsd;
    const pct = this.deps.budgetAutoRaisePct?.() ?? DEFAULT_BUDGET_RAISE_PCT;
    const tried = raise
      ? [`raise-budget → raised $${raise.from} → $${raise.to} (${raise.pct}%), spent again`]
      : !(pct > 0)
        ? ['raise-budget → switched off (budgetAutoRaisePct is 0)']
        : [`raise-budget → not possible within the $${cap} per-run ladder cap`];
    // Budget FIRST (control-tower phase 14, #40): the errand and the halt open
    // on the budget and its arithmetic; the halt carries the fact and
    // announces it under `budget` (`halt`), and the card beside it raises it.
    const fact = runBudgetFact(state);
    const errand = budgetFirst(errandFor('resource-wall:budget', tried, 0), fact,
      'Raise the run budget on the run page — the raise continues the run in the same press — or under its settings.');
    state.errand = errand;
    this.record('run.errand', { ...errand, reason: `the run budget of $${state.runBudgetUsd} is spent`, by: 'runner' });
    this.halt(
      `${budgetHeadline(fact, 'spent')} — the run budget of $${state.runBudgetUsd} is spent`
        + `${raise ? ` (raised once from $${raise.from})` : ''}`,
      undefined, 'budget',
    );
  }

  /**
   * Point a recovery's lane at the worktree the phase already has — and never
   * make one.
   *
   * The asymmetry is the whole design. Boarding a phase MAY create a lane
   * (`acquireWorktree`); recovering one may not. A recovery is a single session
   * asked to finish or explain work that already happened, and a fresh empty
   * checkout is the one place that work is guaranteed not to be — so an absent
   * lane means "this phase shared the root", which is exactly what `laneRoot`
   * answers when `lane.worktree` stays unset.
   *
   * `isRegistered` rather than `existsSync`: a directory git no longer knows
   * about is not a worktree, and running a session in one would put its commits
   * somewhere nothing merges from.
   */
  private async adoptLane(lane: Lane): Promise<void> {
    const names = await this.registeredLane(lane.phase);
    if (!names) return;
    lane.worktree = names.dir;
    // Both or neither, exactly as `acquireWorktree` writes them: `syncMirror`
    // records a branch only alongside a directory.
    lane.branch = names.laneBranch;
    this.record('phase.worktree-adopted', {
      dir: names.dir, branch: names.laneBranch,
    }, lane.phase);
  }

  /* ---------------------------------------------------------------- *
   * Artefacts a session leaves behind
   * ---------------------------------------------------------------- */

  /**
   * Every checkout and every `pe/*` branch of every repository this PHASE is
   * scoped to, right now.
   *
   * 🔴 Per scope directory, not once against the docs root. Worktrees and
   * branches are per-REPOSITORY facts: a superproject scan sees neither a
   * submodule's branch nor a worktree made inside it, so a scan of the hub root
   * would have reported "nothing appeared" about a `pe/*` branch created in a
   * submodule — which is precisely where the incident that motivated this
   * register happened. "Nothing appeared" and "nothing was looked at" must not
   * be the same answer.
   *
   * Cheap (one `worktree list --porcelain` and one `for-each-ref` per repo) and
   * best-effort: a scan that fails answers `null`, and a diff against `null`
   * reports nothing rather than reporting everything as new.
   *
   * `for-each-ref`, not `branch --list`: `branch` is a verb that also CREATES
   * and DELETES, so admitting it to `never-push.test.ts`'s allow-list to run one
   * read would license every other use of it. This answers the identical
   * question and can do nothing else.
   */
  protected async artefactScan(phase: number): Promise<ArtefactSnapshot | null> {
    const state = this.state;
    if (!state) return null;
    try {
      const dirs = await this.scopeDirs(phase);
      const snapshot: ArtefactSnapshot = [];
      for (const dir of dirs) {
        const abs = dir === '.' ? state.root : join(state.root, dir);
        const prefix = dir === '.' ? [] : ['-C', dir];
        const entries = await checkouts(abs, runDir(state.root, state.slug));
        const listed = await this.gitOrNull(
          [...prefix, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/pe/']);
        const trees = new Map<string, string | undefined>();
        for (const entry of entries) trees.set(entry.dir, entry.branch);
        snapshot.push({
          repo: dir,
          trees,
          branches: new Set((listed ?? '').split('\n').map((line) => line.trim()).filter(Boolean)),
        });
      }
      return snapshot;
    } catch { return null; }
  }

  /**
   * Register what appeared between two scans, and say so once in the journal.
   *
   * The console cannot stop a session running `git worktree add` — the deny
   * wall is about damage, and a worktree is not damage — so the contract is
   * that nothing it makes is INVISIBLE. Nothing here removes anything: a
   * checkout may hold uncommitted work, and deciding its fate is a person's.
   */
  protected async noteArtefacts(before: ArtefactSnapshot | null, phase: number): Promise<void> {
    const state = this.state;
    if (!state || !before) return;
    const after = await this.artefactScan(phase);
    if (!after) return;
    const at = new Date().toISOString();
    const made: RunArtefact[] = [];
    for (const now of after) {
      // Matched by REPO. A scope that appeared or vanished between the two
      // scans is compared against nothing rather than against a neighbour's
      // refs, which would report every one of them as new.
      const was = before.find((b) => b.repo === now.repo);
      if (!was) continue;
      for (const [dir, branch] of now.trees) {
        if (was.trees.has(dir)) continue;
        made.push({ kind: 'worktree', name: dir, repo: now.repo, ...(branch ? { branch } : {}), phase, at });
      }
      for (const name of now.branches) {
        if (was.branches.has(name)) continue;
        made.push({ kind: 'branch', name, repo: now.repo, phase, at });
      }
    }
    if (!made.length) return;
    // Deduped by repo+kind+name: a branch this run's own lane machinery made and
    // then re-made is one artefact, and a register that repeated it would read
    // as a leak that is not there. Two repositories may legitimately carry the
    // same branch name, so the repo is part of the identity. Capped so a
    // pathological run cannot grow the run file without bound.
    const key = (a: RunArtefact) => `${a.repo ?? '.'}\u0000${a.kind}\u0000${a.name}`;
    const seen = new Set((state.artefacts ?? []).map(key));
    const fresh = made.filter((a) => !seen.has(key(a)));
    if (!fresh.length) return;
    state.artefacts = [...(state.artefacts ?? []), ...fresh].slice(-64);
    this.record('run.agent-artefacts', {
      phase,
      repos: [...new Set(fresh.map((a) => a.repo ?? '.'))],
      worktrees: fresh.filter((a) => a.kind === 'worktree').map((a) => a.name),
      branches: fresh.filter((a) => a.kind === 'branch').map((a) => a.name),
    }, phase);
    this.persist();
  }

  /**
   * The `repair` recovery: a FRESH `claude -p` inside the run's own frame.
   *
   * Everything the pty agent it replaces did not have, and every one of these
   * is why it is here rather than there: `--settings` (so the deny wall and the
   * PreToolUse/Stop hooks apply — `approvals.ts` is armed only by
   * `Runner.armSettings`), the run's permission profile, its lane (so Freeze
   * and Stop can reach it and a console restart reconciles its child), its
   * scope grant and lease, its journal, its account, its budget, and the four
   * `PE_*` channels a session needs to say what it did. It runs in
   * `laneRoot(phase)` — the tree the phase itself worked in — instead of the
   * console's own root, which is how sessions came to invent branches and
   * worktrees nobody asked for (R15).
   *
   * NO `resume`. The three older modes all act on the phase's own session and
   * are unavailable the moment it is gone; a repair is briefed from the outside
   * (`recovery.ts`'s prompt builders, resolved by the service, handed here as
   * `instruction`) precisely so it does not need one.
   *
   * The tail is the point: the session's DECLARED outcome routes through the
   * same `routeOutcome` a phase's does, which settles the ladder rung from what
   * the session said rather than from whether the phase reads done.
   */
  private async repairSession(phase: number, options: RecoverOptions): Promise<void> {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const brief = (options.instruction ?? '').trim();
    if (!brief) {
      this.endRepair(phase,
        `the repair of phase ${phase} had no briefing to give its session`, 'interrupted');
      return;
    }

    // The freeze reaches every family, this one included: a repair spawns a
    // session, and the operator stopping the fleet means nothing starts. The
    // rung stays OPEN and the halt stands, so the thaw's converge picks it up.
    const frozen = this.fleetFrozen();
    if (frozen) {
      // …and the rung is settled `interrupted`, exactly as the spawn-failure
      // path below settles it. `nextRung` counts an OPEN rung as TRIED (only
      // `interrupted` is exempt), so leaving it open would spend this remedy on
      // the freeze itself and send the thaw's converge to the NEXT, more
      // expensive rung — the opposite of what the comment above promises.
      this.settleOpenRung(phase, 'interrupted', `the console was frozen${frozen.by ? ` by ${frozen.by}` : ''}, so this rung never ran`);
      const why = `the repair of phase ${phase} did not start: the console is frozen`
        + `${frozen.by ? ` by ${frozen.by}` : ''}. It is climbed again after the thaw.`;
      this.record('phase.repair-skipped', { reason: why, frozen: true }, phase);
      if (!RUN_ALREADY_ENDED.includes(state.status)) {
        setRunState(state, 'parked');
        // Said, not left empty: a run card with no reason is a run whose stop
        // an operator has to go and reconstruct from NDJSON.
        state.finishedReason = why;
      }
      return;
    }

    // The phase IS running again, and nothing else says so — the same gap the
    // resume path had. `startedAt` is left alone when the phase already has
    // one; `attemptStartedAt` moves, because `takeOutcome`'s staleness floor is
    // read from it and a file written by the FAILED attempt must not speak for
    // this repair.
    record.status = 'running';
    record.startedAt ??= new Date().toISOString();
    record.attemptStartedAt = new Date().toISOString();
    // A usage wall ends with its park (control-tower phase 54, #78).
    delete record.usageWall;
    this.clearWallProbe(phase);
    this.persist();
    this.record('phase.repair', {
      cls: options.cls ?? null, situation: options.situation ?? null,
      by: options.by ?? 'console', cwd: this.laneRoot(phase),
    }, phase);
    this.emit('phase', { phase, status: 'running', model: record.model ?? state.model });
    this.emit('run', { state });

    const artefactsBefore = await this.artefactScan(phase);
    let outcome;
    try {
      outcome = await this.spawnSession(phase, 'repair', {
        prompt: brief,
        // The tree the phase worked in — its lane when it had one, the run's
        // own checkout otherwise. NEVER the console's root.
        cwd: this.laneRoot(phase),
        addDirs: this.addDirsFor(phase),
        model: record.model ?? state.model,
        effort: record.effort ?? state.effort,
        name: `${state.slug} p${phase} repair`,
        settings: this.settingsPath ?? undefined,
        permissionProfile: this.profile(),
        partialMessages: this.deps.stream?.partialMessages ?? true,
        subagentText: this.deps.stream?.subagentText ?? true,
        hookEvents: this.deps.stream?.hookEvents ?? true,
        onHandle: (handle) => { this.attachHandle(phase, handle); },
        env: await this.sessionEnv({
          ...(await this.claimEnv(phase)),   // all four claim fields (LCK-6)
          ...this.messagingEnv(),
          // Armed, not merely named — the same two-guard staleness contract
          // every other spawn site keeps.
          PE_OUTCOME_FILE: this.armOutcomeFile(phase),
          PE_RULINGS_FILE: rulingsFile(state.root, state.slug),
          // Where `phase-outcome.sh … verified` records what this session proved (control-tower phase 62),
          // and where its lines are judged — the proof is keyed there (phase 106, `proofEnv`).
          ...(await this.proofEnv(phase)),
          PE_TASKS_FILE: this.armTasksFile(phase),
        }),
        signal: this.abort?.signal,
        onPid: (pid) => {
          this.attachPid(phase, pid);
          this.persist();
          this.emit('run', { state });
        },
        onEvent: (event) => this.onStream(phase, event),
      }, {
        // A repair is a bounded errand: a quarter of the phase's dollars and
        // its own turn cap, so a session that misreads the ask and starts
        // building runs out rather than running on.
        caps: capsFor({ mode: 'repair', table: this.capTable(), phaseBudgetUsd: state.phaseBudgetUsd }),
      });
    } catch (error) {
      // A rung whose session could not START never ran, so it is settled
      // `interrupted` rather than `failed`: the ladder may climb it again.
      const why = (error as Error)?.message ?? String(error);
      this.record('phase.repair-done', { ok: false, reason: why }, phase);
      this.endRepair(phase, `the repair session for phase ${phase} could not be started: ${why}`, 'interrupted');
      return;
    } finally {
      this.attachPid(phase, null);
      this.attachHandle(phase, null);
      await this.noteArtefacts(artefactsBefore, phase);
    }

    // The dollars were booked by the spawn door (`bookSpend`).
    record.turns = (record.turns ?? 0) + outcome.turns;
    // The repair's words live on the RUNG, never over `record.said`: the phase
    // session's sign-off is what explains why the phase stopped, and a repair's
    // "I could not" overwriting it is the same defect the closeout path fixed.
    const said = outcome.resultText ? outcome.resultText.replace(/\s+/g, ' ').slice(0, 1_200) : undefined;
    // The SAME `phase.session` every other session writes — `mode: 'repair'`
    // tells the two apart — was written by `spawnSession` as the child exited.

    const declared = this.takeOutcome(phase);
    this.record('phase.repair-done', {
      ok: Boolean(declared), declared: declared?.status ?? null,
      costUsd: outcome.bookedUsd ?? outcome.costUsd, turns: outcome.turns, said,
    }, phase);

    // 🔴 ASKED FIRST, on every exit that reads an outcome: an operator Stop and
    // a console shutdown both land HERE, not in the catch, because `spawnClaude`
    // does not throw on abort — it SIGTERMs and RESOLVES. Without this the
    // session's silence was read as its own failure: the rung settled `failed`,
    // the run was stamped `parked` over the operator's `stopping`, and because
    // `stoppedByOperator` reads `stopping` as true and `parked` as false, the
    // press was erased — the convergence loop then relaunched the run and
    // climbed the next, more expensive rung. `attempt()` has asked this since
    // the loop was written; `repairSession` asked on no exit at all.
    if (this.stopRequested || this.abort?.signal.aborted) {
      this.settleOpenRung(phase, 'interrupted',
        this.shuttingDown ? 'the console stopped while this rung was running' : 'the operator stopped this rung');
      record.status = 'interrupted';
      record.endedAt = new Date().toISOString();
      if (this.shuttingDown) {
        record.note = consoleStoppedNote(phase);
        state.stoppedBy = 'system';
      } else {
        const stamp = this.stopStamp();
        record.note = stamp.note;
        state.stoppedBy = stamp.stoppedBy;
      }
      // 🔴 UNGUARDED, unlike every other ending in this method, and that is the
      // point. `RUN_ALREADY_ENDED` means "somebody with more authority already
      // ended this run" — but HERE we are that somebody's own handler, and the
      // status it left is `stopping`, which is IN the list. Guarding this write
      // therefore skipped it in exactly the case it exists for: the run stayed
      // `stopping` with an empty `finishedReason`, `isLiveStatus` stayed true,
      // and `planRunSettled` held any `startAfter` chain behind a run nothing
      // was driving. `stopping → paused` is the transition, and it is what the
      // sibling in `attempt()` writes unguarded for the same event.
      // …and, as everywhere since the e44c15da report, a halt that stands
      // keeps the run `halted`: the repair was sent to fix it, and stopping
      // the repair does not unsay it.
      setRunState(state, state.halt ? 'halted' : 'paused');
      state.finishedReason = this.shuttingDown
        ? `the console stopped while the repair of phase ${phase} was running.`
        : `the operator stopped the repair of phase ${phase}.`;
      this.record('phase.repair-stopped', { shuttingDown: Boolean(this.shuttingDown) }, phase);
      return;
    }

    if (!declared) {
      // Nothing declared: the rung is settled `failed` with the session's own
      // last words, the halt this repair was sent to fix stands, and the ladder
      // climbs its next rung on the next sweep.
      this.settleRungFromOutcome(phase, null, said);
      record.status = 'interrupted';
      record.endedAt = new Date().toISOString();
      if (!RUN_ALREADY_ENDED.includes(state.status)) setRunState(state, 'parked');
      state.finishedReason = `the repair of phase ${phase} declared no outcome`
        + (said ? `. It signed off: "${condenseSaid(said)}"` : '.');
      return;
    }

    const board = await this.board();
    const routed = await this.routeOutcome(phase, declared, board);
    if (routed === 'halted') {
      // 🔴 `halted` here means the PHASE was settled, and NEITHER of the two
      // paths that get there touches the run. `halt()` routes a phase-level
      // kind (`phase-blocked`) to `settlePhase()`, which deliberately writes
      // only `record.halt`; and `park()` (the `needs-human` path) refuses
      // outright while a halt already stands — which it does, because a halt is
      // why this repair was launched. So without this the run kept whatever
      // `recover()` set it to and read `running` with nothing running: the
      // zombie shape this whole plan exists to end. Measured across all six
      // declarations; `blocked` and `needs-human` are the two likeliest from a
      // repair that cannot fix its target.
      this.settleRepairRecord(record, declared.status);
      // Only when nothing else already gave the run an ending: `closedBlocked`
      // may have parked or halted it on the way here, and `halting` is a drain
      // the finalizer owns. A run word this repair did not write is not this
      // repair's to overwrite.
      if (!RUN_ALREADY_ENDED.includes(state.status)) {
        setRunState(state, 'parked');
        state.finishedReason = `the repair of phase ${phase} declared ${declared.status}`
          + `${declared.reason ? `: ${declared.reason}` : ''}.`;
      }
      return;
    }
    if (routed === 'waiting') {
      // `waiting` covers three shapes, and only one of them has a CLOCK. A
      // declared external wait parks until `parkedUntil`; a `blocked` on a
      // foreign lock goes back to the queue (`record.status = 'pending'`), and
      // a `partial` has already been climbed by the ladder. Putting the run
      // into `waiting` with a null `waitUntil` for the last two would be the
      // console announcing a deadline it does not have — and `armLimitResume`
      // has nothing to arm against it.
      // Guarded like every other ending here. Unreachable today — no path that
      // returns `waiting` can run with the run already ended — but the rule
      // this phase earned three times over is *enumerate the branches*, and a
      // guard that is present everywhere except two lines is a guard somebody
      // will later read as deliberate.
      if (RUN_ALREADY_ENDED.includes(state.status)) return;
      if (record.parkedUntil) {
        state.waitUntil = record.parkedUntil;
        setRunState(state, 'waiting', { kind: 'external', until: state.waitUntil });
        state.finishedReason = `phase ${phase} is waiting on external work`
          + `${record.parkReason ? ` (${record.parkReason})` : ''}; resumes at ${record.parkedUntil}.`;
        this.record('run.waiting-external', {
          phases: [phase], waitUntil: record.parkedUntil,
        }, phase);
      } else {
        setRunState(state, 'parked');
        state.finishedReason = `the repair of phase ${phase} declared ${declared.status}`
          + `${declared.reason ? `: ${declared.reason}` : ''}; the phase is back in the queue.`;
      }
      return;
    }

    // Only `complete` retires the stop. "Found nothing wrong" is explicitly NOT
    // "fixed it" (`RUNG_OUTCOME_LABELS`), and clearing a halt on it would send
    // the run straight back into the same wall to re-discover it — spending a
    // boarding to learn what the rung just reported. The already-fine case is
    // caught earlier and for free, by `preRecoveryGate`'s superseded check.
    this.settleRepairRecord(record, declared.status);
    if (declared.status === 'complete') {
      state.halt = null;
      state.resolved = null;
      state.reopenedAt = null;
      retirePhaseHalt(record);
      state.finishedReason = `phase ${phase} was repaired by ${options.by ?? 'console'}. `
        + 'Continue to carry on through the rest of the plan.';
      this.record('run.recovered', { phase, mode: options.mode }, phase);
    } else {
      state.finishedReason = `the repair of phase ${phase} declared ${declared.status}`
        + `${declared.reason ? `: ${declared.reason}` : ''}.`;
    }
    // The same guard every other ending in this method uses: a run somebody
    // with more authority already stopped is not this repair's to re-label.
    if (!RUN_ALREADY_ENDED.includes(state.status)) setRunState(state, 'parked');
  }

  /**
   * End a repair that never got to declare anything.
   *
   * 🔴 `halt()` alone is not an ending for the RUN. `recovery-failed` is a
   * `PHASE_HALT_KIND`, so it routes to `settlePhase()`, which writes
   * `record.halt` and deliberately touches neither `state.status` nor
   * `state.halt` — while `recover()` has already set the run `running` and the
   * teardown converts only `halting`. Both sibling exits of `repairSession`
   * left exactly that: `running`, no lane, no child, no driving promise. The
   * same zombie H-1 closed on the declared path, one method over — which is why
   * all three exits now go through one helper instead of three shapes.
   *
   * The rung goes with it: a repair that could not start never effectively ran,
   * so `interrupted` (which `nextRung` exempts from the same-rung-once rule) is
   * the honest word and the ladder may climb it again.
   */
  private endRepair(phase: number, reason: string, outcome: 'interrupted' | 'failed'): void {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    this.settleOpenRung(phase, outcome, reason);
    this.settleRepairRecord(record, 'no-defect');
    // The run's OWN ending first, then the halt. `halt()` emits a `run` frame
    // of its own, and with the status written afterwards that frame carried
    // `running` — one paint of a live run for a run that had just stopped.
    if (!RUN_ALREADY_ENDED.includes(state.status)) {
      setRunState(state, 'parked');
      state.finishedReason = reason;
    }
    this.halt(reason, phase, 'recovery-failed');
    this.persist();
    this.emit('run', { state });
  }

  /**
   * Settle the phase record a repair left `running`.
   *
   * `repairSession` stamps `record.status = 'running'` so the header clock and
   * the runs list stop reading the run as stopped while a session is alive —
   * and nothing settled it again on the way out. `runRecovery`'s teardown then
   * ran `settleInFlightRecords`, which writes `interrupted` and the note "the
   * console stopped while phase N was running": a falsehood on the SUCCESS
   * path, and one that re-arms a "continue this phase" offer against the
   * pre-repair session.
   *
   * The word is the phase's, not the repair's: a repair does not finish a
   * phase, so `complete` and `no-defect` return it to `pending` (the board
   * decides what it is) rather than claiming `done`.
   */
  private settleRepairRecord(record: PhaseRecord, declared: string): void {
    if (record.status !== 'running') return;
    record.status = declared === 'blocked' || declared === 'needs-human' ? 'parked' : 'pending';
    record.endedAt = new Date().toISOString();
    // The floor `takeOutcome` reads. Left standing, the NEXT thing to look for
    // a declaration on this phase would accept this repair's file as its own.
    record.attemptStartedAt = undefined;
  }

  protected async resumeWithInstruction(
    phase: number, instruction: string, haltedWith?: string | null,
    opts: {
      /**
       * Append the retry context and the closeout procedure (the default — a
       * ladder rung resuming a phase that never closed). `false` sends the
       * instruction ALONE: the landing's rebase session (phase 8) resumes a
       * phase whose handoff is written and whose board reads done, and a
       * closeout prompt telling it otherwise would be false.
       */
      closeout?: boolean;
      /** The session's name on the Pulse; default `<slug> p<N> recover`. */
      name?: string;
      /**
       * Caps the caller decided — `closed()`'s resume-and-raise, carrying on a
       * resume that spent its cap under double that cap. Absent, a resume gets
       * the phase's whole dollar row and what is left of its turns (#61).
       */
      caps?: SessionCaps;
    } = {},
  ): Promise<string | ResumeLost | null> {
    const state = this.state!;
    const record = phaseRecord(state, phase);

    /* The session's own last word, still in the armed file (#21 §3).
     *
     * A child that outlived its console declares and exits like any other
     * session; the ladder then relaunches the run on `resume-own-session`, and
     * the arming deleted the declaration on the way past. `complete` and
     * `waiting-external` are APPLIED here instead, and this rung does not run:
     * the phase ended the way it said it did, and resuming it would ask a
     * session to rediscover a verdict it had already reached. `partial`,
     * `blocked` and `needs-human` are left alone — a resume is exactly what
     * those three are asking for, and `takeArmedOutcome` has journalled them
     * either way. */
    const armed = this.takeArmedOutcome(phase);
    if (armed && (armed.status === 'complete' || armed.status === 'waiting-external')) {
      // A declaration means the session that wrote it has ended, so a record
      // still reading `running` is a claim about a process that is gone.
      // `complete` goes back to `pending` and lets the BOARD say whether the
      // work is done — this console did not watch it happen and must not vouch
      // for it, which is the same judgement `settleRepairRecord` makes.
      // `waiting-external` is parked by `declareOutcome` itself.
      // Before the declaration, so its own persist carries both.
      if (armed.status === 'complete' && record.status === 'running') {
        record.status = 'pending';
        record.endedAt = new Date().toISOString();
        record.attemptStartedAt = undefined;
      }
      await this.declareOutcome(phase, armed, 'armed-file');
      return null;
    }

    const sessionId = record.sessionId ?? record.resumeSessionId;
    if (!sessionId) {
      return `phase ${phase} has no session left to resume — retry it instead, or close it by hand`;
    }
    // Before the record is flipped to `running`: can `--resume` reach this
    // conversation under the account paying, and is the session not still
    // running? A transcript that cannot be carried over is a resume that will
    // fail in three seconds, and the ladder's next rung — a fresh session — is
    // the answer, not a spawn. A session still RUNNING is a refusal with a
    // reason, never a lost session: nothing is wrong with it (REG-1).
    const gate = this.resumableSession(record, sessionId);
    if (!gate.ok) {
      if (gate.why === 'session-live') {
        return `phase ${phase}'s session ${sessionId} is still running${gate.pid ? ` (pid ${gate.pid})` : ''} — `
          + 'the console will not resume a session on top of itself; this is tried again once it ends';
      }
      // There, and not worth resuming (`resumePolicy`): nothing is wrong with
      // the session, so nothing is stamped — the next rung boards fresh.
      if (gate.why === 'fresh' && gate.policy) return { lost: sessionId, policy: gate.policy };
      if (gate.why === 'unported') {
        this.markSessionGone(record, sessionId, 'its transcript is not under the account this run pays with');
      }
      return { lost: sessionId };
    }

    const board = await this.board();
    // The operator's words first — they are the newest fact and the reason this
    // resume exists — then what the phase already knows went wrong, then the
    // closeout procedure. A resumed session has the earlier transcript in its
    // own context, but not the runner's verdict on it: the verification ran
    // AFTER that session exited, so the failure it is being asked to fix is
    // something it has never seen.
    const prompt = [
      instruction.trim(),
      ...(opts.closeout === false ? [] : [
        this.retryContext(record, haltedWith),
        closeoutPrompt(state.slug, phase, board.states[phase] ?? 'unknown',
          state.gitMode === 'new-branch' ? `pe/${state.slug}` : undefined),
      ]),
    ].filter(Boolean).join('\n\n---\n\n');

    this.record('phase.resume-instruction', { sessionId, instruction: instruction.slice(0, 2_000) }, phase);
    // A park this resume ENDS is closed on its own stamps first (control-tower
    // phase 45, #59): the wait-resume path always did this, and this one did
    // not, so a phase resumed here — a watch landing on a run nobody was
    // driving, a recovery rung — kept its park entry open, and every minute
    // the resumed session WORKED was charged to its wait budget until the
    // declaration was spent (measured: 38.9 of 42 minutes "already parked").
    // A park on a spent budget ends with it, errand and all.
    const resumedAt = new Date().toISOString();
    closeWaitEntry(record, resumedAt);
    record.parkedMs = parkedMsOf(record, Date.parse(resumedAt));
    if (record.parkedUntil) {
      record.parkedUntil = undefined;
      syncWaitClock(state);
      this.clearParkPoke(phase);
    }
    retireSpentBudget(state, phase);
    // A resumed phase IS running, and nothing said so. The record kept whatever
    // terminal status it had halted on, so the header clock never started, the
    // dashboard counted the run as stopped, and the runs list showed a finished
    // run with a live session underneath it. The phase clock reads `startedAt`,
    // which is left alone when the phase already has one — this is a second
    // stretch of the same phase, not a new one.
    const wasStatus = record.status;
    record.status = 'running';
    record.startedAt ??= new Date().toISOString();
    record.attemptStartedAt = new Date().toISOString();
    // A usage wall ends with its park (control-tower phase 54, #78).
    delete record.usageWall;
    this.clearWallProbe(phase);
    this.persist();
    this.emit('phase', { phase, status: 'running', model: record.model ?? state.model });
    this.emit('run', { state });

    let outcome;
    try {
      outcome = await this.spawnSession(phase, 'resume', {
        resumeFrom: gate.resume,
        prompt,
        // The tree the phase worked in — its lane when it had one. Resuming a
        // lane session in the shared root hands it a checkout without its own
        // commits and on the wrong branch, and it would then "fix" a phase it
        // cannot see. `addDirs` is the other half: the work-state it is being
        // asked to write lives at the run root (D6).
        cwd: this.laneRoot(phase),
        addDirs: this.addDirsFor(phase),
        model: record.model ?? state.model,
        effort: record.effort ?? state.effort,
        name: opts.name ?? `${state.slug} p${phase} recover`,
        settings: this.settingsPath ?? undefined,
        permissionProfile: this.profile(),
        // A plan a person just approved (control-tower phase 11, #34): the SAME
        // session resumes OUT of plan mode, by name rather than by the spawn's
        // default, so the approval means one thing whatever that default becomes.
        ...(record.planApproval?.state === 'approved' ? { permissionMode: 'acceptEdits' as const } : {}),
        partialMessages: this.deps.stream?.partialMessages ?? true,
        subagentText: this.deps.stream?.subagentText ?? true,
        hookEvents: this.deps.stream?.hookEvents ?? true,
        onHandle: (handle) => { this.attachHandle(phase, handle); },
        env: await this.sessionEnv({
          ...(await this.claimEnv(phase)),   // all four claim fields (LCK-6)
          ...this.messagingEnv(),
          // `resumeWithInstruction` was the one spawn site that injected this
          // without deleting first, so a stale outcome from the attempt that
          // FAILED could be read as this resume's own declaration.
          PE_OUTCOME_FILE: this.armOutcomeFile(phase),
          // Where a decision goes. Separate from the outcome file on purpose:
          // an outcome is read once and consumed, a ruling is appended and
          // kept, and a session must be able to record the second without
          // touching the first.
          PE_RULINGS_FILE: rulingsFile(this.state!.root, this.state!.slug),
          // Where `phase-outcome.sh … verified` records what this session proved (control-tower phase 62),
          // and where its lines are judged — the proof is keyed there (phase 106, `proofEnv`).
          ...(await this.proofEnv(phase)),
          // Where the session publishes its TASK LIST. A clone of the outcome
          // channel next door, for the same reason: the CLI stopped
          // provisioning TodoWrite/TaskCreate to `-p` sessions in August 2026,
          // so the panel that says what a run is doing went blank. A shell
          // script cannot be un-provisioned. Armed, not merely named.
          PE_TASKS_FILE: this.armTasksFile(phase),
        }),
        signal: this.abort?.signal,
        // The same wiring `attempt` uses, and for the same reason: `state.child`
        // is what Freeze and Stop signal, and what the console reads to know a
        // session is alive. Recorded here it was a bare pid nobody else could
        // see, so a recovery could not be frozen or stopped at all.
        onPid: (pid) => {
          this.attachPid(phase, pid);
          this.persist();
          this.emit('run', { state });
        },
        onEvent: (event) => this.onStream(phase, event),
      }, {
        // The phase's own session carrying on with an instruction: it does the
        // phase's work, so it runs under the phase's allowance — the whole
        // dollar row, and the turns the phase has left (control-tower phase 46,
        // #61). It used to get a closeout's 60, "finishing, not starting", and
        // 4 of the audit week's 5 max_turns endings were resumes cut there.
        caps: opts.caps ?? capsFor({
          mode: 'resume', table: this.capTable(), phaseBudgetUsd: state.phaseBudgetUsd, spentTurns: record.turns ?? 0,
        }),
      });
    } finally {
      this.attachPid(phase, null);
      this.attachHandle(phase, null);
    }

    // The dollars — the run's, the phase's, the rung's — were booked by the
    // spawn door (`bookSpend`), as this spawn's rise over its session's mark:
    // the `--resume` re-reported the conversation's whole running total.
    // The CLI refused the `--resume` (the transcript is under another cwd's
    // project folder, or gone): nothing ran, so nothing is confirmed. The
    // record goes back to the word it had — `running` with no driver is the
    // state the healer reads as "still driving" and leaves alone for ever.
    if (!outcome.turns && lostResume(outcome.signal)) {
      record.status = wasStatus;
      this.emit('phase', { phase, status: record.status });
      this.markSessionGone(record, sessionId, 'the CLI holds no conversation under that id here');
      return { lost: sessionId };
    }
    // And the turns, so the sweep can tell "tried and failed" from "never
    // effectively ran" — a shutdown-killed zero-turn resume must not consume
    // its rung. When the abort cut this resume off, settle the rung as
    // interrupted HERE, where the fact is first known; the healer's sweep
    // reaches the same verdict for a console that died before this line ran.
    {
      const slot = state.recoveries?.[String(record.phase)];
      const open = slot?.rungs ? [...slot.rungs].reverse().find((r) => r.outcome === 'running' || r.outcome == null) : null;
      if (open) {
        open.turns = (open.turns ?? 0) + outcome.turns;
        if (outcome.endedBy) open.endedBy = outcome.endedBy;
      }
      // Cut off by the console — a shutdown, an operator's stop — rather than
      // ended by its own work. Zero turns used to be the only witness for that;
      // with interrupted turns booked honestly, the ending itself is.
      if (slot && this.abort?.signal.aborted && (!outcome.turns || consoleEnded(outcome.endedBy))) {
        this.settleOpenRung(record.phase, 'interrupted', 'the console stopped while this rung was climbing');
      }
    }
    record.turns = (record.turns ?? 0) + outcome.turns;
    if (outcome.sessionId) record.sessionId = outcome.sessionId;
    if (outcome.resultText) record.said = outcome.resultText.replace(/\s+/g, ' ').slice(0, 1_200);
    // No closeout marker: none ran (control-tower phase 46, #61, RC-7). This
    // used to stamp one "so `confirm()` does not immediately spawn a second
    // one" — and `closed()`, believing a closeout had been tried, then halted
    // `no-handoff` over a resume that had merely spent its cap or been cut by a
    // shutdown. How the resume ended is on the record (`lastSession`), and
    // `closed()` reads that; a clean ending with no handoff gets a real closeout.
    this.record('phase.resume-done', {
      costUsd: outcome.bookedUsd ?? outcome.costUsd, turns: outcome.turns, said: record.said,
    }, phase);
    return null;
  }

  /**
   * Mint this run's token and write the settings the children will load.
   *
   * The settings carry two things that must not be confused: `permissions.deny`,
   * which the CLI enforces itself and which was measured holding with this
   * console unreachable, and the HTTP hook, which fails open and therefore
   * carries workflow rather than safety.
   */
  private armSettings(runId: string): string | null {
    const { approvals, origin } = this.deps;
    if (!approvals || !origin) {
      log.warn('runner.no-approvals', {
        note: 'no approval broker configured — sessions run on the deny rules alone',
      });
      return null;
    }
    try {
      // The token this run already holds, when it holds one — adopted at boot
      // from a child that outlived the last console (TRS-11) — and a fresh one
      // only when it does not. A re-mint under a surviving child makes its
      // next hook call unauthorised, and this hook fails open. Asked as an
      // optional call: a broker shape without `liveToken` (an older harness)
      // must still arm, never lose the settings file.
      const token = approvals.liveToken?.(runId) ?? approvals.arm(runId);
      const path = this.writeSettings(runId, token, origin);
      this.record('run.settings', { path, profile: this.profile() });
      return path;
    } catch (error) {
      log.error('runner.settings', { error });
      return null;
    }
  }

  /** This run's profile. Absent on every run written before profiles existed. */
  protected profile(): PermissionProfile {
    return this.state?.permissionProfile ?? 'guarded';
  }

  private writeSettings(
    runId: string, token: string, origin: string, variant: { relay?: boolean; file?: string } = {},
  ): string {
    return writeSettingsFile(variant.file ?? runId, buildSettings({
      runId,
      token,
      origin,
      policy: loadPolicyFor(this.state?.slug ?? null),
      profile: this.profile(),
      openPrCarveOut: this.openPrCarveOut(),
      publishCarveOut: this.publishCarveOut(),
      // The relay's `PermissionRequest` hook rides only an ARMED run (phase
      // 14): `--permission-prompts none` does not switch the hook off, so a run
      // on the floor must simply not register one.
      relay: variant.relay ?? this.state?.relayArming?.armed === true,
      // `crossSessionInbound: "accept"` — see `SettingsOptions.messaging`. On
      // unless the plan says otherwise, because an accepted inbox nobody sends
      // to costs the session nothing.
      messaging: this.messagingOn(),
      // This run's live grants below plan scope (control-tower phase 149): the
      // rule lowered for this run only while the grant lives; the next write
      // after it ends raises it again.
      ...(this.deps.grantsLowered ? { lowered: this.deps.grantsLowered(runId) } : {}),
    }));
  }

  /**
   * Write this run's settings again from what holds NOW (control-tower phase
   * 149): a grant applied or ended, a policy file a grant edited. The child
   * already running keeps what it loaded — the hook enforces a grant's scope
   * for it — and the next one loads this.
   */
  refreshSettings(): void {
    this.rearmSettings();
  }

  /**
   * The relay armed or disarmed for this run (phase 14, `noteRelayArming`): the
   * settings file rewritten with the same token, so the NEXT child loads the
   * `PermissionRequest` hook or goes without it. The running one keeps what it
   * loaded — which is why arming is decided at the spawn door, before it.
   */
  protected rearmRelay(_armed: boolean): void {
    this.rearmSettings();
  }

  /**
   * The settings a plan-mode session loads (control-tower phase 11): the run's
   * own, plus the relay's `PermissionRequest` hook, in a file of its own so the
   * run's other sessions keep exactly what they had. The session carries the
   * relay's silent host so the CLI offers `ExitPlanMode` (`spawnSession`), and a
   * host that never answers needs the hook to answer every call that prompts,
   * or one would sit on it for an hour. Same token as the run's file.
   */
  protected planHostSettingsPath(): string | null {
    const { approvals, origin } = this.deps;
    if (!approvals || !origin || !this.state) return null;
    const token = approvals.liveToken?.(this.state.id);
    if (!token) return null;
    try {
      return this.writeSettings(this.state.id, token, origin, {
        relay: true, file: `${this.state.id}${PLAN_HOST_SETTINGS_SUFFIX}`,
      });
    } catch (error) {
      log.error('runner.settings', { error });
      return null;
    }
  }

  /**
   * Whether this run gets the push/PR carve-out — new-branch runs that will
   * open a PR, and nothing else. `rearmSettings` already rebuilds the settings
   * file when the run's git mode is patched mid-run.
   */
  private openPrCarveOut(): boolean {
    // The ONE hole in the push wall, and since P12 it asks the settle strategy
    // rather than `openPr` directly. Two strategies end at a remote (`pr` and
    // `merge-queue`); `integration` merges locally and `keep` does nothing, and
    // neither may be handed a `git push` the deny list would otherwise refuse.
    // `SETTLE_PUSHES` is where that judgement lives, once — a strategy added
    // later gets no carve-out unless somebody puts it there on purpose.
    return this.state?.gitMode === 'new-branch' && SETTLE_PUSHES.has(settleOf(this.state));
  }

  /**
   * Whether this run gets the PUBLISH carve-out (phase 8): the plan lands by
   * pull request somewhere, so a landing session will be boarded whose
   * `gh pr create`/`gh pr merge` must ask under every profile. A plan
   * question, not a run one — the settle strategy above is about the RUN's
   * own branch; this is about each phase's.
   */
  private publishCarveOut(): boolean {
    return Boolean(this.state) && this.deps.planPublishes?.(this.state!.slug) === true;
  }

  /**
   * Rewrite this run's settings after a profile change, keeping the token.
   *
   * The file is read by the *next* phase's child — the one already running
   * loaded it at startup and cannot reload it, which is why this is honest
   * about applying from the next phase. What does change immediately is the
   * hook classifier: it reads the profile off the live state on every call, so
   * the running phase stops being asked from its very next tool use.
   */
  private rearmSettings(): void {
    const { approvals, origin } = this.deps;
    if (!approvals || !origin || !this.state) return;
    // This run's token, named. With a pool, "the live token" is a question with
    // several answers, and rewriting our settings file with a neighbour's would
    // make every subsequent hook call from our child unauthorised — which this
    // hook reads as silence, and silence fails open.
    const token = approvals.liveToken(this.state.id);
    if (!token) return;
    try {
      this.settingsPath = this.writeSettings(this.state.id, token, origin);
      this.record('run.settings', { path: this.settingsPath, profile: this.profile() });
    } catch (error) {
      log.error('runner.settings', { error });
    }
  }

  /**
   * Reconcile a run whose console went away mid-phase. Returns a reason when
   * the run must not proceed on its own.
   *
   * The dangerous case is a child that outlived us: it was reparented, it is
   * still editing the repo, and we cannot see its output any more. Starting a
   * second session on that phase would have two agents writing one tree. So it
   * parks, loudly, with the pid to look at.
   */
  private adopt(state: RunState): string | null {
    // Every lane the last console recorded, however it spelled them. Checking
    // only `state.child` would let a run whose mirror happened to have exited
    // start a second session on a phase another child is still writing.
    const children = childrenOf(state);
    if (!children.length) return null;

    // Same question, same identity rule as `survivingChildren`: the tuple when
    // the record carries one (so a recycled pid does not park a run forever
    // against an innocent process), and bare existence when it does not.
    //
    // And the same rule as `reconcileRun`'s orphan branch — `pidHoldsWork`, not
    // `!== 'gone'`. The dangerous case this parks for is "it was reparented and
    // is still editing the repo"; a `zombie` is neither, so parking a run over
    // one printed a pid to look at that had already exited.
    const alive = children.filter((child) => pidHoldsWork(child.pid, procIdentity(child)));
    // A session the LIVE console launched is not an orphan (control-tower phase
    // 110, #175): whichever of this console's loops started it has let go, but
    // its console has not, and a halt calling it "a session from an earlier
    // console" would be false. The start is refused instead — never a second
    // session beside it, and nothing written about the run.
    const own = alive.filter((child) => launcherAlive(child) === true);
    if (own.length) {
      if (this.state === state && !this.driving) this.state = null;
      throw new Error(
        `${own.length === 1 ? 'A session' : `${own.length} sessions`} this console started `
        + `${own.length === 1 ? 'is' : 'are'} still running (`
        + `${own.map((child) => `pid ${child.pid}, phase ${child.phase}`).join('; ')}) — `
        + 'let it end, or stop it, before this run starts again.',
      );
    }
    if (alive.length) {
      // ONE composer with `reconcileRun` (`orphanAdvice`). This path used to
      // have no frozen/running split at all: a SIGSTOPped orphan is not `gone`,
      // so it counted as alive and was told "let it finish or stop it" — advice
      // nobody can take, because nothing is scheduling it and the console that
      // stopped it is not coming back.
      const advice = orphanAdvice(state, alive, 'start this run again');
      setRunState(state, 'parked');
      state.halt = {
        at: new Date().toISOString(),
        reason: advice.reason,
        phase: advice.phase,
        kind: 'orphaned-session',
      };
      // A stopped process is not running, and saying so was the other half of
      // the same mistake — the phase card claimed work was in progress over a
      // child the kernel was not scheduling.
      for (const child of advice.running) phaseRecord(state, child.phase).status = 'running';
      for (const child of advice.frozen) {
        const record = phaseRecord(state, child.phase);
        record.status = 'interrupted';
        record.note = `frozen by the operator (pid ${child.pid}) and left behind by the console that stopped it`;
        record.resumeSessionId ??= record.sessionId;
      }
      state.stoppedBy = 'system';
      this.record('run.adopt.alive', {
        pids: alive.map((child) => child.pid), phases: alive.map((child) => child.phase),
        ...(advice.frozen.length ? { frozen: advice.frozen.map((child) => child.pid) } : {}),
      }, advice.phase);
      return state.halt.reason;
    }

    state.child = null;
    delete state.children;
    // The phase may in fact have completed — the child could have written its
    // handoff and exited in the moment the console was gone. The board says so
    // or it does not; either way this is checked, never assumed.
    for (const child of children) {
      const record = phaseRecord(state, child.phase);
      record.status = 'interrupted';
      record.note = `the console stopped while phase ${child.phase} was running (pid ${child.pid})`;
      this.record('run.adopt.interrupted', { pid: child.pid, phase: child.phase }, child.phase);
    }
    return null;
  }

  /* ---------------------------------------------------------------- *
   * Control
   * ---------------------------------------------------------------- */

  /**
   * Stop boarding anything new, and leave the live lanes alone.
   *
   * Not a pause and not a stop, and the difference is the whole point. Pause
   * waits for a phase boundary and then SETTLES the run — the loop exits, the
   * status becomes `paused`, and Start is what brings it back. A hold changes
   * one thing: the next `admit()` is refused, with a named holder on the queue
   * page saying who did it. Phases already running run to their ends and their
   * handoffs get written, which is exactly what an operator wants when they
   * mean "let this one finish, let the other plan go first".
   *
   * Deliberately no `driving` guard, unlike `pause`: a hold is a fact about the
   * checkpoint rather than an instruction to a loop, and a run this console
   * adopted a moment later must still be held. `Runner.hold` and the on-disk
   * fallback in `service-runs.ts` therefore write the same field.
   */
  /**
   * Make (or adopt) phase N's ERRAND TREE and name it on the phase's record
   * (control-tower phase 90, #123) — `ensureErrandTree`, for this run's mounts:
   * the manifest's sources for a mirror, the root for a single checkout. The
   * errand card reads `record.errandTree`; `phase.errand-tree` says so once.
   */
  async prepareErrandTree(phase: number, by = 'console'): Promise<
    { ok: true; tree: NonNullable<PhaseRecord['errandTree']>; adopted: boolean } | { ok: false; error: string }
  > {
    const state = this.state;
    if (!state) return { ok: false, error: 'no run' };
    const manifest = state.mountedRepos?.length ? await readMirror(this.laneNamesFor(0).integration) : null;
    const mounts = manifest?.mounts.length ? manifest.mounts
      : state.mountedRepos?.length ? mountsFromRepos(state.root, state.mountedRepos) : undefined;
    const made = await ensureErrandTree({ root: state.root, slug: state.slug, phase, ...(mounts ? { mounts } : {}) });
    if (!made.ok) return { ok: false, error: made.detail ?? 'the errand tree could not be made' };
    const tree = {
      dir: made.dir, at: new Date().toISOString(), by,
      mounts: made.mounts.map((mount) => ({ rel: mount.rel, sha: mount.sha, pushed: mount.pushed })),
    };
    phaseRecord(state, phase).errandTree = tree;
    this.record('phase.errand-tree', { dir: made.dir, by, adopted: made.adopted, mounts: tree.mounts }, phase);
    this.persist();
    this.emit('run', { state });
    return { ok: true, tree, adopted: made.adopted };
  }

  /**
   * Switch this SHARED-checkout run to a checkout of its own at its next
   * boundary (control-tower phase 90, #150) — the escape from another run's
   * run-long branch hold that a resume could never offer ("a resume cannot
   * mint isolation a running run never had"). An explicit act by a named
   * person, applied by the loop's first fill with no lane of this run live
   * (`RunnerLoop.checkoutBeforeBoarding`), so nothing is moved under a working
   * session. False when there is nothing to switch.
   */
  isolateAtBoundary(by = 'console'): boolean {
    const state = this.state;
    if (!state || state.gitMode !== 'new-branch' || state.checkout === 'worktree') return false;
    if (state.isolateAtBoundary) return true;
    state.isolateAtBoundary = { at: new Date().toISOString(), by };
    this.record('run.isolate-requested', { by, at: 'next-boundary' });
    this.persist();
    this.emit('run', { state });
    this.wake.resolve();
    return true;
  }

  /**
   * Give ONE phase of a shared-checkout run its own worktree (`isolate-phase`,
   * control-tower phase 90, #150): the phase boards in a lane worktree on
   * `pe/<slug>-p<N>`, merged back when it settles — `phase-lane.sh`'s shape,
   * made by the console — and no run-long branch hold reaches it, so a waiter
   * queued behind one is re-scanned at once. False when there is no run.
   */
  isolatePhase(phase: number, by = 'console'): boolean {
    const state = this.state;
    if (!state) return false;
    const list = state.isolatePhases ??= [];
    if (!list.includes(phase)) list.push(phase);
    this.record('phase.isolate-requested', { by }, phase);
    this.persist();
    this.emit('run', { state });
    this.deps.scheduler?.poll();
    this.wake.resolve();
    return true;
  }

  hold(by = 'console', reason?: string): boolean {
    if (!this.state) return false;
    if (this.state.hold) return true;
    this.state.hold = { at: new Date().toISOString(), by };
    // The why rides the line, never the record: `hold` is a fact the next
    // admission reads, and the reason is history (control-tower phase 96, #142).
    this.record('run.held', { by, ...(reason ? { reason } : {}) });
    this.persist();
    this.emit('run', { state: this.state });
    // The queue is holding entries this run owns; nothing else would look
    // again until the idle poll, so a held run would keep a lane it was about
    // to be granted for up to a minute after the operator said stop.
    this.deps.scheduler?.poll();
    return true;
  }

  /**
   * Take the hold off. The next scan admits; nothing else changes.
   *
   * `releaseHold`, not `release`: `Runner.release(phase, owner)` is the LOCK
   * release and has been since admission existed. Two verbs named `release`
   * one class apart is how a phase-lock release becomes an admission release
   * in somebody's call site at 2am.
   */
  releaseHold(by?: string, reason?: string): boolean {
    if (!this.state?.hold) return false;
    this.state.hold = null;
    this.record('run.released', { ...(by ? { by } : {}), ...(reason ? { reason } : {}) });
    this.persist();
    this.emit('run', { state: this.state });
    this.deps.scheduler?.poll();
    return true;
  }

  /**
   * An operator's word on ONE phase's place in the queue (control-tower phase
   * 99, #135 B and E): `bump`, `hold`, `release`, `defer`, `withdraw`,
   * `requeue`. The mark goes on the phase's record — so it survives the entry
   * — and on its waiting entry when it has one; the line goes in the journal
   * with who and why, and a move with its place before and after. The loop is
   * woken, because a bump or a re-queue may change what boards next.
   */
  queueControl(phase: number, verb: PhaseQueueVerb, actor: Actor, opts: Pick<QueueControlOptions, 'until' | 'stamp' | 'position' | 'lane' | 'via'> = {}):
    { ok: true; changed: boolean } | { ok: false; status: number; error: string } {
    const state = this.state;
    if (!state) return { ok: false, status: 409, error: 'no run' };
    // A pin or a kept lane never widens a scoped run (control-tower phase 100).
    const refusal = laneMarkRefusal(state, phase, verb);
    if (refusal) return { ok: false, status: 409, error: refusal };
    const scheduler = this.deps.scheduler;
    const record = phaseRecord(state, phase);
    const entry = scheduler?.entryOf(state.id, phase);
    const before = entry ? scheduler!.positions().get(entry.id) : undefined;
    const applied = applyQueueControl(record, verb, actor, {
      ...opts, now: () => this.now(), ...(scheduler ? { nextStamp: () => scheduler.nextStamp() } : {}),
    });
    if (!applied.ok || !applied.changed) return applied.ok ? { ok: true, changed: false } : applied;
    const { change } = applied;
    // The waiting entry, if there is one, takes the same word at once.
    if (entry && scheduler) {
      if (verb === 'withdraw') scheduler.withdrawEntry(entry.id);
      else if (change.control.bump && (verb === 'bump' || verb === 'requeue')) scheduler.bump(entry.id, change.control.bump);
      else scheduler.markEntry(entry.id, { hold: change.control.hold ?? null, defer: change.control.defer ?? null, pin: change.control.pin ?? null });
    }
    // A kept lane is the scheduler's own registry — it stands with no entry at all.
    if (verb === 'reserve' || verb === 'unreserve') this.syncReservation(phase);
    const after = entry && verb !== 'withdraw' ? scheduler!.positions().get(entry.id) : undefined;
    this.record(change.event, {
      ...change.data,
      ...(entry ? { entryId: entry.id } : {}),
      ...(before !== undefined && after !== undefined && verb === 'bump' ? { order: { before, after } } : {}),
    }, phase);
    this.persist();
    this.emit('phase', { phase, status: record.status, queueControl: record.queueControl ?? null });
    this.emit('run', { state });
    this.wake.resolve();
    return { ok: true, changed: true };
  }

  /**
   * A plan's phases as a LIST (control-tower phase 99, #135 B.9): the listed
   * phases first, in that order, then the rest where they stood — each listed
   * phase bumped with a stamp that orders it behind the one before it, so the
   * list is the bump order and outlives every entry, like any bump. One journal
   * line for the whole list, with the scan order before and after.
   */
  reorderQueue(phases: readonly number[], actor: Actor):
    { ok: true } | { ok: false; status: number; error: string } {
    const state = this.state;
    if (!state) return { ok: false, status: 409, error: 'no run' };
    const list = [...new Set(phases)].filter((phase) => Number.isInteger(phase) && phase > 0);
    if (!list.length) return { ok: false, status: 400, error: 'pass {phases: [N, …]} — the order you want' };
    const finished = list.filter((phase) => ['done', 'skipped'].includes(phaseRecord(state, phase).status));
    if (finished.length) return { ok: false, status: 409, error: `phase ${finished.join(', ')} is already finished` };
    const scheduler = this.deps.scheduler;
    const orderNow = (): number[] => {
      const positions = scheduler?.positions();
      if (!positions) return [];
      return scheduler!.snapshot().entries
        .filter((entry) => entry.runId === state.id && entry.phase != null)
        .sort((a, b) => (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0))
        .map((entry) => entry.phase!);
    };
    const before = orderNow();
    // The first listed takes the highest stamp: most recent bump first.
    const base = scheduler?.nextStamp() ?? this.now().getTime();
    list.forEach((phase, index) => {
      const stamp = base + (list.length - 1 - index);
      const record = phaseRecord(state, phase);
      applyQueueControl(record, 'bump', actor, { stamp, now: () => this.now() });
      const entry = scheduler?.entryOf(state.id, phase);
      if (entry && record.queueControl?.bump) scheduler!.bump(entry.id, record.queueControl.bump);
    });
    this.record(QUEUE_REORDERED_EVENT, { ...actor, phases: list, before, after: orderNow() });
    this.persist();
    this.emit('run', { state });
    this.wake.resolve();
    return { ok: true };
  }

  /**
   * Tell the scheduler what this phase's record says about a lane kept for it
   * (control-tower phase 100): reserve it, or lift it when the mark is gone.
   */
  syncReservation(phase: number): void {
    const state = this.state;
    const scheduler = this.deps.scheduler;
    if (!state || !scheduler) return;
    const kept = state.phases[String(phase)]?.queueControl?.reserve;
    if (!kept) { scheduler.unreserveLane(state.id, phase); return; }
    scheduler.reserveLane({
      slug: state.slug, runId: state.id, phase, at: kept.at, by: kept.by,
      ...(kept.reason ? { reason: kept.reason } : {}), ...(kept.lane ? { lane: kept.lane } : {}),
    });
  }

  /**
   * A phase that FINISHED — done or skipped, whoever closed it (a board
   * reconcile, a Skip, a hand) — keeps no pin and no kept lane (control-tower
   * phase 100): a reservation for it would hold its scope against everything,
   * for good, since no grant will ever spend it. Cheap; run with every save.
   */
  protected dropFinishedLaneMarks(): void {
    const state = this.state;
    if (!state) return;
    for (const record of Object.values(state.phases)) {
      const control = record?.queueControl;
      if (!control || (record.status !== 'done' && record.status !== 'skipped')) continue;
      if (!control.reserve && !control.pin) continue;
      const kept = Boolean(control.reserve);
      delete control.reserve;
      delete control.pin;
      if (!Object.keys(control).length) delete record.queueControl;
      if (kept) this.deps.scheduler?.unreserveLane(state.id, record.phase);
    }
  }

  /** This run's scheduling policy — the plan's own, else the console's (control-tower phase 100). */
  protected schedulingPolicy(): SchedulingPolicy {
    const slug = this.state?.slug;
    if (!slug) return DEFAULT_SCHEDULING_POLICY;
    try { return schedulingPolicy(this.deps.schedulingPolicy?.(slug)); } catch { return DEFAULT_SCHEDULING_POLICY; }
  }

  /**
   * The scheduling policy's word on one phase (control-tower phase 100, #135
   * F.24–25; #128 asks 2–3), or null — what its queue entry carries into the
   * cross-plan scan and what this run's own boarding order reads.
   *
   *   - `blocker-first`: a phase whose committed WIP is red on the shared
   *     branch (`wipRed`) goes first and holds its siblings — their gate is its
   *     red; a phase a sibling's `blocked` declaration names (a `phase:` or
   *     `lock:` watch ref on this plan) goes first;
   *   - `critical-path`: a phase on the plan's critical path, the one furthest
   *     from the plan's end first;
   *   - `seniority`: nothing — first come, first served.
   */
  protected promotionOf(phase: number): Promotion | null {
    const state = this.state;
    if (!state) return null;
    const policy = this.schedulingPolicy();
    if (policy === 'blocker-first') {
      const red = state.phases[String(phase)]?.wipRed;
      if (red) {
        const files = red.files?.length ? `, ${red.files.length} file${red.files.length === 1 ? '' : 's'}` : '';
        return {
          policy, rank: 2, holdsSiblings: true,
          text: `blocker-first — its committed WIP is red on the shared branch (${red.sha.slice(0, 8)}${files}), so it boards before the siblings whose gate it is`,
        };
      }
      const refs = new Set([`phase:${state.slug}/${phase}`, `lock:${state.slug}/${phase}`]);
      const named = Object.values(state.phases)
        .filter((record) => record && record.phase !== phase && record.declared?.status === 'blocked'
          && (record.declared.watch ?? []).some((ref) => refs.has(ref.trim())))
        .map((record) => record!.phase)
        .sort((a, b) => a - b);
      if (!named.length) return null;
      return {
        policy, rank: 1,
        text: `blocker-first — ${named.map((n) => `P${n}`).join(', ')} declared ${named.length === 1 ? 'itself' : 'themselves'} blocked on it`,
      };
    }
    if (policy === 'critical-path') {
      let path: readonly number[] = [];
      try { path = this.deps.criticalPath?.(state.slug, this.lastBoard) ?? []; } catch { path = []; }
      const at = path.indexOf(phase);
      if (at < 0) return null;
      const left = path.length - at;
      return {
        policy, rank: left,
        text: `critical path — ${left} phase${left === 1 ? '' : 's'} to the plan's end, the longest chain left`,
      };
    }
    return null;
  }

  /**
   * Finish the current phase, then stop.
   *
   * Returns whether it took effect here. It does not when nothing is driving
   * this run — after a console restart there is no loop to tell — and the
   * caller then edits the checkpoint instead. Answering `false` rather than
   * returning silently is the whole point: a Pause that quietly does nothing
   * is indistinguishable from one that worked.
   */
  /**
   * Withdraw what this run has QUEUED — the scheduler's entries, and the
   * `queued` word on the records that were sitting behind them.
   *
   * Every run-level stop arms a block `boardingBlocked()` reads, and until this
   * existed none of them told the queue. So a run that had decided to stop went
   * on reporting later phases as `queued`/`waiting` with multi-hour ETAs on the
   * Runs page, the Sessions page and the plan's Autopilot tab — because the
   * only thing that cleared the word was the arrival check, and that is not
   * reached until the entry gets to the head of a queue whose own ETA says
   * hours. Two more costs rode with it: the lane was still inside `admit()` and
   * therefore still in `inFlight`, so `draining()` stayed true and the stop
   * could not finalize at the boundary it was asked for; and every doomed lane
   * still won its scope, ran the arrival check and handed the scope straight
   * back.
   *
   * The RECORD is what the three surfaces read — which is why one act here
   * fixes all three — and `endLockWait` takes the ETA-bearing `waitingOn` with
   * it, so a withdrawn phase stops advertising how long it has left to wait for
   * a scope it is no longer waiting for.
   *
   * Nothing granted is touched: `Scheduler.withdrawRun` is deliberately not
   * `releaseRun`, and the phase in flight keeps its scope until it ends.
   *
   * Idempotent — a second call finds no entries and no `queued` record — and
   * safe to race the rejection it causes: `admit()`'s catch in the lane also
   * restores the record, and finds the work already done.
   */
  protected withdrawQueued(why: 'pause' | 'halt' | 'park'): number {
    const state = this.state;
    if (!state) return 0;
    const entries = this.deps.scheduler?.withdrawRun(state.id) ?? 0;
    let phases = 0;
    const at = new Date(this.now().getTime()).toISOString();
    for (const record of Object.values(state.phases)) {
      if (record.status !== 'queued') continue;
      // `pending` rather than a settled word: nothing was tried, so the phase
      // stays startable — the same restoration the arrival check makes, and the
      // reason a resumed run picks these up again with no repair.
      setPhaseState(record, 'pending');
      // The episode closes with its length and why (#81); the entry's AGE and
      // reservation stay on the record, so the heal loop's re-board minutes
      // later is born where this entry stood rather than at the back.
      const closed = closeQueueEpisode(record, 'withdrawn', at, why);
      if (closed) this.record('phase.queue-closed', closed, record.phase);
      endLockWait(record);
      phases++;
    }
    // The run's blocked stretch ends with its waits (#64).
    foldRunBlocked(state, at);
    if (entries || phases) {
      // Three literals, never a template: `test/docs-parity.test.ts` reads
      // event names off the source, and a composed name is one the table can
      // never hold — `run.park-withdrew` reached the hub's journal undocumented
      // exactly this way (LFC-4).
      const event = {
        pause: 'run.pause-withdrew', halt: 'run.halt-withdrew', park: 'run.park-withdrew',
      } as const;
      this.record(event[why], { entries, phases });
      log.info('runner.withdrew-queued', { runId: state.id, slug: state.slug, why, entries, phases });
    }
    return entries + phases;
  }

  pause(who: Actor | string = unattributedActor('Runner.pause')): boolean {
    if (!this.state || !this.driving) return false;
    const actor = asActor(who, 'Runner.pause');
    const by = actor.by;
    // A recovery is one session, not the phase loop — and `pausing` is a word
    // only the loop reads. Arming it here lit the Pause button, changed the
    // badge to "pausing", and stopped precisely nothing, which is the failure
    // this method's own comment calls the worst of the three. Freeze stops a
    // recovery where it stands, and Stop ends it; there is no boundary for a
    // Pause to wait for, so saying no is the honest answer.
    if (this.recovering) return this.pauseQueuedRecovery(actor);
    // A halt outranks a pause: the run is already stopping for a stronger
    // reason, and writing `pausing` over a draining `halting` would repaint
    // the stop as an operator's tidy boundary pause — card urgency lost.
    if (this.state.halt) return false;
    if (this.state.status === 'pausing') return true;
    setRunState(this.state, 'pausing');
    this.state.pause = {
      requestedAt: new Date().toISOString(),
      afterPhase: this.state.activePhase,
      by,
    };
    this.record('run.pause-requested', { afterPhase: this.state.pause.afterPhase, ...actor });
    // Before the persist and the emit, so the state that reaches disk and the
    // state that reaches the browser are the withdrawn one. Armed-then-emitted
    // was the shape that let a reload of a pausing run read the stale queue
    // back out of the file.
    this.withdrawQueued('pause');
    this.persist();
    this.emit('run', { state: this.state });
    return true;
  }

  /**
   * A Pause of a recovery that is still WAITING for its scope (control-tower
   * phase 86, #149 ask 4) — the queued automatic resume an isolated run's watch
   * landing started, measured queued for hours behind another plan's lane with
   * Pause answering 409. A recovery that has spawned has no boundary to pause
   * at (Freeze and Stop reach it); one that has not has an admission, and
   * withdrawing it is the pause: the run reads `paused` with the phase's
   * declaration intact, and a Resume boards it again.
   */
  private pauseQueuedRecovery(actor: Actor): boolean {
    const queued = this.recoveryQueued;
    if (!queued || !this.state) return false;
    this.state.pause = { requestedAt: new Date().toISOString(), afterPhase: queued.phase, by: actor.by };
    this.record('run.pause-requested', { afterPhase: queued.phase, ...actor, recovery: true });
    queued.controller.abort();
    this.persist();
    this.emit('run', { state: this.state });
    return true;
  }

  /**
   * New words for a recovery still waiting for its scope (control-tower phase
   * 86, #149 ask 4): it keeps its queue entry — its place and its age — and
   * boards with this instruction instead of the one it was queued with.
   * Answers false when no recovery of `phase` is queued here.
   */
  requeueRecovery(phase: number, instruction: string, by: string): boolean {
    const queued = this.recoveryQueued;
    if (!queued || queued.phase !== phase || !instruction.trim()) return false;
    queued.options.instruction = instruction;
    this.record('phase.recovery-requeued', { by, bytes: Buffer.byteLength(instruction) }, phase);
    this.persist();
    return true;
  }

  /** The phase whose recovery is waiting for its scope right now, or null. */
  recoveryQueuedFor(): number | null { return this.recoveryQueued?.phase ?? null; }

  /* ---- freezing the phase itself, rather than waiting for its boundary ---- */

  /**
   * Stop the running session where it stands.
   *
   * The existing Pause waits for a phase boundary, which is correct and is
   * often not what is wanted: watching a phase walk into something wrong, the
   * useful control is the one that stops it *now*, before it writes the next
   * file — and `SIGSTOP` does that between one syscall and the next, losing
   * nothing. The session is not killed, not asked to wrap up, not told
   * anything: it is simply not scheduled until `thaw()`.
   *
   * Held too long it converts to a checkpoint instead — see `FREEZE_ESCALATE_MS`.
   *
   * …unless it is a STANDING freeze (`opts.standing`), which is the fleet
   * freeze's form. There the escalation would be actively wrong: the operator
   * did not step away from one lane, they switched the console off at the wall,
   * and a clock that converted their fleet into checkpoints after fifteen
   * minutes would undo the exact thing they asked for. So a standing freeze
   * writes NO `escalateAt` and arms no timer, which `freezeVerdict` already
   * reads as "leave the operator's freeze standing" — the same answer it gives
   * a deadline it cannot parse, and for the same reason.
   */
  freeze(by = 'console', phase?: number | null, opts?: { standing?: boolean }): boolean {
    const state = this.state;
    if (!state || !this.driving) return false;
    // The lane named — or, with nothing named, EVERY lane holding a live
    // session. "Freeze" from the run's own controls means "stop the run where
    // it stands", and freezing only the mirror lane of three left two sessions
    // editing under a run the console then called frozen.
    const targets = phase != null
      ? [this.lanes.get(phase)].filter((lane): lane is Lane => Boolean(lane))
      : [...this.lanes.values()];
    // A lane with no pid yet is admitted-but-not-spawned, and it is covered.
    // Leaving it out is what let a freeze race a spawn: the lane sailed through
    // boarding and started a session a few hundred milliseconds after the
    // operator stopped the run, and because `syncFrozenStatus` could not see it
    // either, the run went on calling itself frozen. Marking it costs no signal
    // — there is no process to stop — and `boardingBlocked` turns the mark into
    // a refusal, so the spawn is DEFERRED to the thaw rather than raced.
    const eligible = targets.filter(
      (lane) => !lane.frozen && !lane.checkpointed && !lane.stopped
        && (lane.pid == null || pidAlive(lane.pid)),
    );
    // A lane the operator froze a minute BEFORE the fleet freeze is excluded
    // above — it is already frozen, and re-signalling it would be wrong. But it
    // still carries the ordinary form's `escalateAt` and its armed timer, so
    // fifteen minutes into a freeze the operator believes is standing, that one
    // lane gets `killLadder`'d. A standing freeze must make every lane it
    // covers standing, including the ones it did not have to signal.
    let converted = 0;
    if (opts?.standing) {
      for (const lane of targets) {
        if (!lane.frozen?.escalateAt) continue;
        this.clearFreezeTimer(lane);
        lane.frozen = { at: lane.frozen.at, by: lane.frozen.by };
        converted++;
        this.record('run.freeze-standing', {
          phase: lane.phase, by,
          note: 'the console was frozen, so this lane’s escalation clock was dropped',
        }, lane.phase);
      }
    }
    if (!eligible.length) {
      // Everything asked for is already frozen: truthful success. Nothing
      // freezable at all: refusal, so the button can say so.
      //
      // A conversion still has to be WRITTEN, though — the run-level mirror
      // carries its own copy of `escalateAt`, and the boot clock reads that
      // copy. Dropping the timer without persisting would leave a standing
      // freeze that a restart re-arms.
      if (converted) { this.syncFreezeMirror(); this.persist(); this.emit('run', { state }); }
      return targets.some((lane) => lane.frozen);
    }

    let frozenCount = 0;
    for (const lane of eligible) {
      const pid = lane.pid;
      // The GROUP, not the pid. A freeze that stopped only the CLI left its
      // bash children running — a poll loop kept polling, a build kept
      // building — under a lane the console was calling frozen.
      if (pid != null) {
        try { stopWhereItStands(pid); } catch (error) {
          log.warn('runner.freeze', { pid, error });
          continue;
        }
      }
      const at = new Date().toISOString();
      const escalateAt = opts?.standing
        ? null
        : new Date(this.now().getTime() + FREEZE_ESCALATE_MS).toISOString();
      // Before the timer, not after: the idle watchdog measures silence, and a
      // stopped child is silent from this instant. Ten minutes of it used to
      // close stdin under the freeze — five minutes before the escalation that
      // is meant to be the only clock allowed to end one.
      lane.handle?.setFrozen(true);
      lane.frozen = escalateAt ? { at, by, escalateAt } : { at, by };
      if (escalateAt) {
        lane.freezeTimer = setTimeout(() => this.escalateFreeze(lane), FREEZE_ESCALATE_MS);
        lane.freezeTimer.unref?.();
      }
      frozenCount++;
      this.record('run.frozen', { pid, phase: lane.phase, by, escalateAt, standing: Boolean(opts?.standing) }, lane.phase);
    }
    if (!frozenCount) {
      if (converted) { this.syncFreezeMirror(); this.persist(); this.emit('run', { state }); }
      return converted > 0;
    }

    this.syncFrozenStatus();
    this.syncMirror();
    this.syncFreezeMirror();
    this.persist();
    this.emit('run', { state });
    return true;
  }

  /** Let a frozen session carry on, mid-token, in the same process. */
  thaw(phase?: number | null): boolean {
    const state = this.state;
    if (!state) return false;
    // The lane named, or every frozen lane — thaw-all is the undo of
    // freeze-all, and thawing only the first of two frozen lanes left the
    // other stopped behind a run that had gone back to `running`.
    const targets = phase != null
      ? [this.lanes.get(phase)].filter((lane): lane is Lane => Boolean(lane?.frozen))
      : [...this.lanes.values()].filter((lane) => lane.frozen);
    if (!targets.length) {
      // A freeze can OUTLIVE every lane it named. A lane frozen between
      // admission and spawn is refused at boarding and then deleted by
      // `runPhase`'s `finally`, which leaves the run reading `frozen` with
      // nothing in the lane table — and a `thaw()` that only knows about lanes
      // answers `false` to the one verb that is supposed to undo this. The run
      // was then escapable only by Stop, which is precisely the "no frozen
      // thing is ever left without an owner" promise this phase exists to keep.
      //
      // So the run-level slot is thawable on its own.
      //
      // WAKE FIRST, and on any live pid. The lane-less case is USUALLY the
      // pid-less one — a phase that never started, already back at `pending`,
      // where releasing the slot is the whole of the undo — but the slot is a
      // mirror of whichever lane was frozen, so it can perfectly well name a
      // process that is still stopped. Clearing the record without the SIGCONT
      // would leave that child SIGSTOPped forever AND erase the one fact
      // (`state.freeze`) that `orphanAdvice`, `reconcileRun` and `converge` all
      // read to find it and tell the operator to `kill -CONT` — the original
      // incident, re-created by its own fix.
      const slot = state.freeze;
      if (!slot || (phase != null && slot.phase !== phase)) return false;
      const slotPid = slot.pid || 0;
      if (slotPid && pidAlive(slotPid)) {
        try { wake(slotPid); } catch (error) {
          // Refuse rather than clear: a freeze whose child could not be woken
          // must KEEP its record, or nothing is left pointing at the process.
          log.warn('runner.thaw', { pid: slotPid, error });
          return false;
        }
      }
      // Q-2: the slot knows when it was frozen, so charge the stretch back the
      // way the lane path four lines below does. It recorded a flat `0`, which
      // on the case that matters — a slot naming a child that really was
      // stopped — books the stopped time as work and quietly wrongs every
      // throughput figure built on it. On the ordinary lane-less case the
      // phase never started, `phaseRecord` is untouched because there is no
      // phase to touch, and 0 is still what the journal says.
      const slotFrozenMs = Math.max(0, this.now().getTime() - Date.parse(slot.at));
      if (slotFrozenMs && slot.phase != null) {
        const record = phaseRecord(state, slot.phase);
        record.frozenMs = (record.frozenMs ?? 0) + slotFrozenMs;
      }
      state.freeze = null;
      this.syncFrozenStatus();
      this.record('run.thawed', { pid: slotPid || null, frozenMs: slotFrozenMs }, slot.phase ?? undefined);
      this.syncMirror();
      this.persist();
      this.emit('run', { state });
      return true;
    }

    let thawed = 0;
    for (const lane of targets) {
      const pid = lane.pid;
      this.clearFreezeTimer(lane);
      if (pid && pidAlive(pid)) {
        try { wake(pid); } catch (error) {
          log.warn('runner.thaw', { pid, error });
          continue;
        }
      }
      // Symmetric with `freeze()` — and after the wake, so the watchdog's fresh
      // silence clock starts from the moment the session can actually speak.
      lane.handle?.setFrozen(false);
      // Frozen time is not work time. Left in, an hour on the kitchen table
      // would show up as an hour the phase spent thinking, and every
      // throughput figure built on it would be wrong.
      const frozenMs = Math.max(0, this.now().getTime() - Date.parse(lane.frozen!.at));
      if (frozenMs) {
        const record = phaseRecord(state, lane.phase);
        record.frozenMs = (record.frozenMs ?? 0) + frozenMs;
      }
      lane.frozen = null;
      thawed++;
      this.record('run.thawed', { pid, frozenMs }, lane.phase);
    }
    if (!thawed) return false;

    // Same rule as the wait-until disposition: a pause armed while the session
    // was frozen is still a pause, and thawing is not taking it back — that is
    // what `resumePause` is for. Only back to `running` once NOTHING is frozen:
    // with lanes, thawing one of two still leaves a session stopped.
    this.syncFrozenStatus();
    this.syncMirror();
    this.syncFreezeMirror();
    this.persist();
    this.emit('run', { state });
    return true;
  }

  /** Any lane the operator has stopped where it stands. */
  private frozenLane(): Lane | undefined {
    for (const lane of this.lanes.values()) if (lane.frozen) return lane;
    return undefined;
  }

  /**
   * `frozen` is the run's word only while NOTHING is left running: with lanes,
   * a freeze can cover one session of three, and the run is still running.
   * `state.pause` survives underneath — `resumedStatus()` restores `pausing`
   * when the last freeze lifts.
   */
  protected syncFrozenStatus(): void {
    const state = this.state;
    if (!state) return;
    // Every lane the run still owes a session to: one with a live child, AND
    // one admitted but not yet spawned. The pid-less half is the fix — the set
    // used to be `pid != null`, so a lane between admission and spawn was
    // invisible here, and a run whose only lane was in that gap could not read
    // `frozen` at all while a lane that spawned into a frozen run left the word
    // standing over a session that was spending. A lane that has been
    // checkpointed or stopped is owed nothing and must not hold the run out of
    // `frozen` — that is the two-frozen-lanes case, where escalating one used
    // to thaw the run's status out from under the other.
    const open = [...this.lanes.values()].filter((lane) => !lane.checkpointed && !lane.stopped);
    const allFrozen = open.length > 0 && open.every((lane) => lane.frozen);
    if (allFrozen) setRunState(state, 'frozen');
    else if (state.status === 'frozen') setRunState(state, this.resumedStatus());
  }

  /**
   * Recompute the single-slot `state.freeze` from the lane table.
   *
   * Lowest frozen phase, the same stability rule as `mirrorLane()`: the slot
   * is what pre-lanes readers watch, and it must not flip between lanes on
   * every write. Null when nothing is frozen — a stale block would make a live
   * run look held.
   */
  private syncFreezeMirror(): void {
    const state = this.state;
    if (!state) return;
    let chosen: Lane | undefined;
    for (const lane of this.lanes.values()) {
      if (!lane.frozen) continue;
      if (!chosen || lane.phase < chosen.phase) chosen = lane;
    }
    state.freeze = chosen
      ? {
        at: chosen.frozen!.at,
        phase: chosen.phase,
        pid: chosen.pid ?? 0,
        by: chosen.frozen!.by,
        escalateAt: chosen.frozen!.escalateAt,
      }
      : null;
  }

  /**
   * A freeze nobody came back to. Convert it into something that survives a
   * closed laptop: stop the child, keep its session id, and leave the phase
   * pending so Continue re-runs it with `--resume` rather than from scratch.
   */
  private escalateFreeze(target?: Lane): void {
    const state = this.state;
    // The timer names its lane; a caller that does not — the test that drives
    // this directly rather than waiting fifteen real minutes — means "the one
    // that is frozen", which is what it meant when there could only be one.
    const lane = target ?? this.frozenLane();
    if (!lane) return;
    lane.freezeTimer = null;
    if (!state || !lane.frozen) return;
    const pid = lane.pid;
    const phase = lane.phase;
    const record = phaseRecord(state, phase);
    const sessionId = record?.sessionId;

    lane.checkpointed = true;
    lane.frozen = null;
    // Named before it is signalled, so the session's record says a freeze
    // clock checkpointed it rather than an exit nobody explains.
    lane.handle?.markEnding?.('checkpoint', `frozen past ${Math.round(FREEZE_ESCALATE_MS / 60_000)} minutes`);
    if (pid && pidAlive(pid)) {
      // Wake, then ask, then insist — all from `signals.ts`, which is the
      // only place in `server/` allowed to signal a child. This lane is
      // BY DEFINITION stopped, so the wake is not a precaution here: without it
      // the interrupt is queued and the escalation escalates nothing.
      void killLadder(pid, { killAfterMs: SIGTERM_GRACE_MS });
    }

    // One wording, shared with the boot pass. A freeze that escalated in a
    // live console and one that escalated after a restart must leave the same
    // record — the operator cannot tell which happened, and should not have to.
    checkpointFrozenRecord(record);
    lane.pid = null;
    this.syncMirror();
    this.syncFreezeMirror();
    // Only when this was the last thing running. With another lane still
    // OPEN — live or not yet spawned or itself checkpointed — writing `paused`
    // here would tell the console the run had stopped while a session carried
    // on under it, and nulling the halt would erase a stop another lane wrote.
    // The old test was "every other lane has no pid", which a lane between
    // admission and spawn, or one just checkpointed, passes.
    const others = [...this.lanes.values()].filter((other) => other !== lane);
    if (!others.length) {
      setRunState(state, 'paused');
      // The freeze was the operator's act; its escalation is their stop.
      state.stoppedBy = 'operator';
      state.halt = null;
    } else {
      this.syncFrozenStatus();
    }
    this.record('run.freeze-escalated', {
      pid, phase, sessionId: sessionId ?? null, afterMs: FREEZE_ESCALATE_MS,
    }, phase ?? undefined);
    this.persist();
    this.emit('run', { state });
  }

  protected clearFreezeTimer(lane: Lane): void {
    if (!lane.freezeTimer) return;
    clearTimeout(lane.freezeTimer);
    lane.freezeTimer = null;
  }

  /**
   * Move this run onto another account NOW — the operator's verb, distinct
   * from the on-limit policy doing it by itself.
   *
   * A live lane is checkpointed the way an escalated freeze checkpoints one
   * (SIGCONT+SIGTERM, session id kept, phase back to `pending`) but with
   * `carryOn` set, so the loop keeps driving and the very next attempt spawns
   * under the new account — porting the transcript on its way in. A lane
   * asleep on a usage window holds no process at all; the wake event ends its
   * sleep so it, too, re-attempts now instead of at the old account's reset.
   */
  /**
   * What `switchAccount` would do to the live lanes, doing none of it
   * (control-tower phase 25, #107 ask 2): the lanes it would checkpoint now,
   * and the ones it would leave to finish — the same test the switch applies,
   * `closingLane`, read without acting. Under `boundary` nothing is cut.
   */
  previewSwitch(when: SwitchWhen = 'now'): { wouldCheckpoint: number[]; deferred: number[] } {
    const wouldCheckpoint: number[] = [];
    const deferred: number[] = [];
    for (const lane of this.lanes.values()) {
      if (lane.pid == null || !pidAlive(lane.pid)) continue;
      if (when === 'boundary' || this.closingLane(lane)) deferred.push(lane.phase);
      else wouldCheckpoint.push(lane.phase);
    }
    return { wouldCheckpoint: wouldCheckpoint.sort((a, b) => a - b), deferred: deferred.sort((a, b) => a - b) };
  }

  switchAccount(
    accountId: string | undefined, who: Actor | string = unattributedActor('Runner.switchAccount'),
    opts: {
      when?: SwitchWhen;
      /** An automatic mover's origin (control-tower phase 92): the reset the run is owed a move back at. */
      origin?: { resetsAt: number | null; reason: string };
    } = {},
  ): { ok: true; checkpointed: number; deferred: number[]; rekeyed: number } | { ok: false; reason: string } {
    const state = this.state;
    const actor = asActor(who, 'Runner.switchAccount');
    const by = actor.by;
    if (!state) return { ok: false, reason: 'this console holds no run for that plan' };
    const target = accountId && accountId !== 'default' ? accountId : undefined;
    if ((state.accountId ?? 'default') === (target ?? 'default')) {
      return { ok: false, reason: `the run is already on ${target ?? 'the machine login'}` };
    }
    const from = state.accountId ?? 'default';
    const when = opts.when ?? 'now';
    // Through the one helper like every automatic mover — recorded on the
    // account as a person's departure, held against nobody (no wall, no
    // cool-down): the operator may be moving TO a fuller quota, not away from
    // a wall, and the picker must not learn otherwise.
    const persons = isPersonsAct(actor);
    this.leaveAccount(undefined, { kind: 'operator', reason: `account switch by ${by}`, by: persons ? 'operator' : 'runner' }, state.accountId);
    // A person's choice is remembered for the ladder (#106): a later automatic
    // move back onto `from` reverses it, and says so. The machine's own moves
    // (the ladder's rung reaching this verb) leave the memory as it was.
    if (persons) {
      state.accountChoice = { accountId: target ?? 'default', from, at: this.now().toISOString(), by };
      // …and it replaces whatever move back an automatic switch was owed (#100).
      delete state.switchedFrom;
    } else if (opts.origin) {
      this.noteSwitchedFrom(from, opts.origin.resetsAt, opts.origin.reason);
    }
    // The manifest names what the record names, exactly as the stored-run
    // switch writes it (#22, control-tower phase 53, #56): the account a person
    // moved the run to joins its pool, so failover — which ranks inside the
    // pool — never walks the run straight back off it.
    const rows = (state.accounts ??= []);
    const joined = target ?? 'default';
    if (!rows.some((row) => row.id === joined)) rows.push({ id: joined, minHeadroomPct: 0 });
    // …and the queue moves with it (#92): every phase already waiting boards
    // on the new account, as old as it was.
    const rekeyed = this.moveAccount(target);

    // Which live lanes move NOW. A lane only closing out — its handoff reads
    // complete, or its session has declared how it ends — finishes where it is
    // (#107): its next session, if it has one, is spawned under the new account
    // like everything else. `when: 'boundary'` defers every live lane.
    let checkpointed = 0;
    const deferred: number[] = [];
    for (const lane of this.lanes.values()) {
      if (lane.pid == null || !pidAlive(lane.pid)) continue;
      if (when === 'boundary' || this.closingLane(lane)) {
        deferred.push(lane.phase);
        continue;
      }
      this.checkpointLane(lane, `account switch by ${by}`, { endedBy: 'account-switch' });
      checkpointed++;
    }
    deferred.sort((a, b) => a - b);
    this.haltSignal.dispatchEvent(new Event('wake'));
    // The actor as derived (ACT-11): 20 of 21 lifetime switches read
    // `by: "console"` because the route defaulted what the client never sent.
    this.record('run.account-switch', { from, to: target ?? 'default', checkpointed, deferred, when, rekeyed, ...actor });
    if (!isPersonsAct(actor)) this.noteReversal(from, target ?? 'default', by, `${actor.by} switched the run`);
    // Durable NOW, not on the debounce: a switch is a person's decision, and
    // the next thing to read the account may be a Continue that loads the run
    // off disk (#56 — the stored run still read the old account when the
    // runner parked, and the next start used it).
    this.persistNow();
    this.emit('run', { state });
    return { ok: true, checkpointed, deferred, rekeyed };
  }

  /**
   * The switch's half of `escalateFreeze`: end the child, keep the session.
   *
   * `carryOn` (default true) is what the settle guard reads: true re-attempts
   * the phase immediately — an account switch, whose whole point is to keep
   * going on the account that can pay — and false stops the loop, for a
   * checkpoint whose caller has already written what the run is now waiting
   * on (the live wall under `onLimit: 'pause'`).
   */
  protected checkpointLane(lane: Lane, why: string, opts: { carryOn?: boolean; endedBy: EndedBy }): void {
    const state = this.state!;
    const record = phaseRecord(state, lane.phase);
    const sessionId = record.sessionId;
    this.clearFreezeTimer(lane);
    lane.frozen = null;
    lane.checkpointed = true;
    lane.checkpointNote = { carryOn: opts.carryOn ?? true };
    // WHO is ending it, named on the session before anything signals it: an
    // account switch, a usage pause and a watchdog recycle all arrive at the
    // child as the same interrupt, and its record is the one place that can
    // say which.
    lane.handle?.markEnding?.(opts.endedBy, why);
    if (lane.pid && pidAlive(lane.pid)) {
      // Same ladder as the freeze escalation, and for the same reason — this
      // lane may be frozen too (an account switch under a freeze).
      void killLadder(lane.pid, { killAfterMs: SIGTERM_GRACE_MS });
    }
    record.status = 'pending';
    record.resumeSessionId = sessionId;
    record.note = sessionId
      ? `checkpointed (${why}) — the next attempt resumes session ${sessionId}`
      : `checkpointed (${why}); the session had no id yet, so the next attempt starts from its boot prompt`;
    // Recomputed, not nulled: another lane may still be frozen, and its mirror
    // must survive this lane's checkpoint.
    this.syncFreezeMirror();
    this.record('phase.checkpointed', { sessionId: sessionId ?? null, why }, lane.phase);
  }

  /** Take back a pause that has not been reached yet. */
  resumePause(): boolean {
    if (!this.state || !this.driving) return false;
    if (this.state.status !== 'pausing') return false;
    setRunState(this.state, 'running');
    this.state.pause = null;
    this.record('run.pause-cancelled');
    this.persist();
    this.emit('run', { state: this.state });
    return true;
  }

  /**
   * Stop now: the child gets SIGTERM so its own SessionEnd hooks still run.
   *
   * `actor` is who asked (LFC-6, SHD-3): it rides `run.stop-requested` as it
   * is, and `stoppedBy` is folded from it (`stoppedByOf`) rather than
   * hardcoded `'operator'` — so a stop the console's own machinery makes is
   * the system's on the record, and a person's is a person's, with the
   * transport and origin beside the word. A bare call is a harness's, and is
   * written as `unattributed` rather than as anybody in particular.
   */
  async stop(who: Actor | string = unattributedActor('Runner.stop')): Promise<void> {
    if (!this.state) return;
    const actor = asActor(who, 'Runner.stop');
    this.stopActor = actor;
    // Nothing is driving: the loop already ended and left a status behind. A
    // Stop that quietly does nothing here is worse than no Stop at all — the
    // operator presses it, the badge still says `running`, and the console has
    // told them a lie about its own state.
    if (!this.driving) {
      if (IN_FLIGHT.includes(this.state.status)) {
        // Read the status BEFORE overwriting it. This line exists to record
        // what was interrupted, and taking it afterwards made it record the
        // word "interrupted" every single time — the one fact it was for.
        const was = this.state.status;
        const stamp = this.stopStamp();
        setRunState(this.state, 'interrupted');
        this.state.stoppedBy = stamp.stoppedBy;
        this.state.child = null;
        this.state.pause = null;
        this.state.halt ??= { at: new Date().toISOString(), kind: 'operator-stop', reason: stamp.note, phase: this.state.activePhase ?? undefined };
        this.record('run.stopped-while-idle', { was, ...actor });
        this.persist();
        this.emit('run', { state: this.state });
      }
      return;
    }
    this.stopRequested = true;
    // Every lane, not just the mirror. A Stop that killed one of three sessions
    // and reported the run stopped would leave two agents editing a tree with
    // no supervisor and no console claiming responsibility for them.
    const lanes = [...this.lanes.values()];
    let wasFrozen = false;
    for (const lane of lanes) {
      this.clearFreezeTimer(lane);
      // A stopped process cannot act on SIGTERM: the signal is queued and its
      // own SessionEnd hooks never run, so a frozen phase stopped from the
      // console would sit there until SIGKILL. Wake it first, then ask it to
      // stop.
      if (lane.frozen) wasFrozen = true;
      lane.frozen = null;
      // The stop, named on the session before anything signals it.
      lane.handle?.markEnding?.('stop', `${actor.by === 'operator' ? 'the operator' : actor.by} stopped the run`);
      if (lane.pid && pidAlive(lane.pid)) wake(lane.pid);
    }
    // A session with no lane — a QA round, the pull-request session — is
    // reached only through the abort below; it gets the same word.
    this.handle?.markEnding?.('stop', `${actor.by === 'operator' ? 'the operator' : actor.by} stopped the run`);
    // The persisted `children[].frozen` flags must clear with the lanes they
    // describe, or the checkpoint says two contradictory things about one pid.
    this.syncMirror();
    this.state.freeze = null;
    setRunState(this.state, 'stopping');
    this.record('run.stop-requested', {
      pids: lanes.map((lane) => lane.pid).filter((pid): pid is number => pid != null),
      phases: lanes.map((lane) => lane.phase),
      wasFrozen,
      ...actor,
    });
    this.persist();
    // Aborts the spawns AND every admission still queued — a stopped run must
    // not leave an entry in the queue that would start a session later. The
    // reason is the session ledger's word for this ending (`ENDED_BY`).
    this.abort?.abort('stop');
    // The backstop, one per lane. `killLadder` re-sends the wake, shares the
    // interrupt the abort above already sent (one SIGINT per process) and
    // insists after the grace — the safety net for a child the abort did not
    // reach — then kills.
    const backstops = lanes
      .map((lane) => lane.pid)
      .filter((pid): pid is number => pid != null)
      .map((pid) => killLadder(pid, { killAfterMs: SIGTERM_GRACE_MS }).then((how) => {
        if (how === 'killed') log.warn('runner.sigkill', { pid, note: 'child ignored SIGTERM' });
      }));
    await this.driving;
    // Awaited, not fired and forgotten: `stop()` resolving while a child is
    // still being killed is what let the next thing start beside it.
    await Promise.allSettled(backstops);
  }

  /**
   * Stop ONE lane's session and let the rest of the run carry on.
   *
   * `stop()` is the whole-run verb: it aborts every spawn and drains the loop.
   * Watching one phase go wrong in a three-lane run, that is a bigger hammer
   * than the situation calls for — this ends a single session (SIGCONT first
   * for the same reason `stop()` sends it, then SIGTERM, then the same
   * grace-then-SIGKILL backstop), records the phase `interrupted`, and hands
   * the loop back to its scheduling. It is neither a failure (the streak is
   * untouched) nor an endorsement; dependents of the stopped phase never
   * become ready, so the run parks at its end naming them honestly.
   */
  stopPhase(phase: number, who: Actor | string = unattributedActor('Runner.stopPhase')): { ok: true } | { ok: false; reason: string } {
    const state = this.state;
    if (!state || !this.driving) return { ok: false, reason: 'nothing is driving this run' };
    const actor = asActor(who, 'Runner.stopPhase');
    const by = actor.by;
    const record = state.phases[String(phase)];
    const lane = this.lanes.get(phase);
    if (!lane) {
      // No lane yet: a record can still be settled out of the admission queue.
      // The arrival guard in `runPhaseAdmitted` abandons a settled phase, so
      // the eventually-granted admission releases without spawning.
      if (record?.status === 'queued') {
        record.status = 'interrupted';
        record.note = `stopped by ${by} before it started — the rest of the run carries on`;
        record.endedAt = new Date().toISOString();
        this.record('phase.stopped', { ...actor, before: 'admission' }, phase);
        this.persist();
        this.emit('phase', { phase, status: record.status });
        return { ok: true };
      }
      return { ok: false, reason: this.phaseMismatch(phase) ?? `phase ${phase} is not running` };
    }
    if (record?.status === 'verifying' || record?.status === 'awaiting-verification') {
      return {
        ok: false,
        reason: `phase ${phase} is being verified — its session already ended, so there is nothing to stop`,
      };
    }

    this.clearFreezeTimer(lane);
    if (lane.frozen) {
      // Credit the held time before the record settles, exactly as a thaw would.
      const frozenMs = Math.max(0, this.now().getTime() - Date.parse(lane.frozen.at));
      if (frozenMs && record) record.frozenMs = (record.frozenMs ?? 0) + frozenMs;
      lane.frozen = null;
    }
    lane.stopped = { at: new Date().toISOString(), by };
    // Named on the session before anything signals it.
    lane.handle?.markEnding?.('stop', `stopped by ${by}`);
    const pid = lane.pid;
    if (pid && pidAlive(pid)) {
      void killLadder(pid, { killAfterMs: SIGTERM_GRACE_MS }).then((how) => {
        if (how === 'killed') {
          log.warn('runner.sigkill', { pid, note: 'child ignored SIGTERM after a phase stop' });
        }
      });
    }
    this.syncMirror();
    this.syncFreezeMirror();
    this.syncFrozenStatus();
    // The same attribution field as the run-level stop (LFC-6): a lane's stop
    // and a run's carry the one actor shape, whichever verb was pressed.
    this.record('phase.stop-requested', { pid: pid ?? null, ...actor }, phase);
    this.persist();
    this.emit('run', { state });
    return { ok: true };
  }

  /**
   * A per-lane stop, consumed: settle the record and hand the loop back.
   *
   * `interrupted` rather than `failed`, and the failure streak untouched — a
   * stop is the operator's decision, not a diagnosis. The session id is kept
   * so Retry can offer to resume rather than restart.
   */
  protected settleStoppedLane(
    lane: Lane, phase: number, before?: string,
  ): { carryOn: boolean; completed: boolean } {
    const state = this.state!;
    const record = phaseRecord(state, phase);
    const by = lane.stopped?.by ?? 'console';
    lane.stopped = null;
    record.status = 'interrupted';
    record.note = `stopped by ${by} — the rest of the run carries on`;
    record.endedAt = new Date().toISOString();
    record.resumeSessionId ??= record.sessionId;
    this.record('phase.stopped', { by, ...(before ? { before } : {}) }, phase);
    this.emit('phase', { phase, status: record.status });
    return { carryOn: true, completed: false };
  }

  /**
   * Put a question to the phase that is running right now.
   *
   * A phase is otherwise a process you can watch and cannot speak to: the only
   * way to ask it anything was to stop it, which throws away the session. The
   * session's stdin is held open for exactly this, so the question becomes one
   * more turn in the same conversation — same context, same warm cache — and
   * the phase carries on afterwards.
   *
   * The framing is not decoration. Dropped in bare, "why did you skip the
   * cache?" reads as a new instruction and can quietly redirect the phase; the
   * preamble says what it is and what to do after answering.
   */
  ask(question: string, by = 'console', key?: string, phase?: number | null): AskResult {
    return this.inject('ask', question, by, key, phase);
  }

  /**
   * Tell the phase to do something differently. See `frameSteer` for why this
   * is a separate verb rather than an Ask with different words.
   */
  steer(instruction: string, by = 'console', key?: string, phase?: number | null, reason?: string): AskResult {
    return this.inject('steer', instruction, by, key, phase, undefined, reason);
  }

  /**
   * One write to a live session's stdin, whatever it is called on the button.
   *
   * `key` is the caller's idempotency key. Two POSTs carrying the same one — a
   * double click, a retried fetch, a phone that reconnected mid-request — are
   * one write and one journal line. Without it the second POST is a second turn
   * for the model to answer and, before the close rule was rewritten, a
   * permanent leak in the counter that decided when stdin closed.
   */
  /**
   * The relay answered a question nobody else did (phase 14, QRL-6): the session
   * is told so down its own stdin, one `frameRelayAnswer` sentence per answer —
   * the answer, the rule that chose it, that it is NOT a change to the phase,
   * and to declare `blocked --needs ambiguity` rather than ask again. A person's
   * answer needs no notice: the tool result already says what they chose.
   */
  /**
   * A PEER's message, down a lane's own stdin (5.1.0).
   *
   * The fourth `inject` kind, and the only one whose text this console did not
   * write: `frameMessage` has already framed it — as information from a peer
   * with no authority, tagged `[[msg:<id>]]` — and this only carries it. So
   * `frame` is the identity: re-framing it here would wrap one frame in
   * another, and the mark the recipient is told to watch for would no longer be
   * the mark it opens with.
   *
   * No journal line of its own either: `Mailbox` writes the delivery ledger and
   * the `phase.message-*` events, and a second record of the same fact from the
   * other side is how two surfaces come to disagree about one message.
   */
  tellMessage(phase: number, framed: string): boolean {
    return this.inject('msg', framed, 'peer', undefined, phase, () => framed).ok;
  }

  /** Is there a lane with open stdin for that phase? — the `stdin` transport's precondition. */
  canTell(phase: number): boolean {
    return this.laneFor(phase)?.handle?.open() === true;
  }

  /**
   * Why a phase's LIVE session cannot take a message, in one sentence — or
   * null when no session of that phase lives (control-tower phase 109, #170).
   * Three shapes: this console's lane whose input closed (the cause the
   * spawn reported — `phase.input-closed`), its lane still starting, and a
   * child another console started, adopted from the run record with no pipe
   * at all. The Pro mailbox reaches the last two over the CLI's own inbox
   * socket when the hook captured one; steer and ask have only the pipe.
   */
  liveButUnreachable(lane: Lane | null | undefined, phase: number | null): string | null {
    if (phase == null) return null;
    const who = `phase ${phase}'s session`;
    if (lane) {
      // Only while a session process lives: between sessions — verifying, a
      // closeout to come, a retry's back-off — the lane stands with no pid, and
      // the old words are the true ones.
      const pid = lane.pid ?? lane.handle?.pid ?? null;
      if (!pid) return null;
      if (lane.inputClosed) {
        return `${who} (pid ${pid}) is running, but its input closed at ${clockOf(lane.inputClosed.at)} `
          + `(${inputCloseWords(lane.inputClosed.cause)}) — it cannot take messages now, and ends at the end of its turn`;
      }
      if (!lane.handle) return `${who} (pid ${pid}) is starting — its input is not open yet; send it again in a moment`;
      return null;
    }
    const child = this.state?.children?.[String(phase)];
    if (!child?.pid || !pidHoldsWork(child.pid, procIdentity(child))) return null;
    return `${who} (pid ${child.pid}) is running, but this console did not start it — it was adopted from the run record `
      + `with no input pipe (${inputCloseWords('adopted')}), so it cannot take messages; it ends at the end of its turn`;
  }

  tellRelayAnswer(phase: number, answers: readonly { question: string; label: string; by: string; ruleId?: string }[]): AskResult {
    if (!answers.length) return { ok: false, reason: 'nothing to tell' };
    const told = answers.map((answer) => ({
      question: answer.question.replace(/\s+/g, ' ').slice(0, 300),
      label: answer.label,
      rule: answeredByPhrase(answer.by as Exclude<QuestionAnsweredBy, 'human'>, answer.ruleId),
    }));
    return this.inject('relay', told.map((answer) => answer.label).join(' · '), 'relay', undefined, phase,
      (mark) => frameRelayNotice(told, mark, 'ambiguity'));
  }

  private inject(
    kind: 'ask' | 'steer' | 'relay' | 'msg', body: string, by: string, key?: string, targetPhase?: number | null,
    frame?: (mark: string) => string,
    /** The operator's why, for the journal line only — the session is told the instruction, not the reason. */
    reason?: string,
  ): AskResult {
    const text = body.trim();
    if (!text) return { ok: false, reason: kind === 'ask' ? 'nothing to ask' : 'nothing to say' };
    if (text.length > 8_000) return { ok: false, reason: 'that is longer than a message' };

    if (key) {
      const seen = this.injected.get(key);
      // Answered from the record rather than re-sent. The caller cannot tell the
      // difference, which is the point of an idempotency key.
      if (seen) return { ...seen, repeated: true };
    }

    // The named lane's stdin, not "the" session's. With three phases running,
    // a question typed under phase 5 that arrived at phase 2's session would
    // be answered confidently by the wrong agent about the wrong work.
    const lane = this.laneFor(targetPhase);
    const handle = lane?.handle ?? (targetPhase == null ? this.handle : null);
    if (!handle?.open()) {
      // Named for the act that was refused, not for Ask. A Steer that comes
      // back "nothing is running to ask" reads as the console having
      // misunderstood which button was pressed — which is the one moment an
      // operator most needs to believe the refusal is about the session and
      // not about the request.
      const act = kind === 'ask' ? 'ask' : kind === 'msg' ? 'tell' : 'steer';
      // …and for the session as it REALLY is (control-tower phase 109, #170):
      // "no session is running" over a live child whose input had closed sent
      // a watchdog looking for a session that was there all along.
      const live = this.liveButUnreachable(lane, targetPhase ?? lane?.phase ?? this.state?.activePhase ?? null);
      if (live) return { ok: false, reason: live, unreachable: true };
      return {
        ok: false,
        reason: this.driving
          ? 'no session is running just now — the run is between phases, or verifying'
          : `nothing is running to ${act}`,
      };
    }

    const id = randomUUID().replace(/-/g, '').slice(0, 8);
    const mark = markFor(kind, id);
    const framed = frame ? frame(mark) : kind === 'ask' ? frameQuestion(text, mark) : frameSteer(text, mark);
    if (!handle.send(framed)) {
      return { ok: false, reason: 'the session stopped accepting input as the message was sent' };
    }

    const result: AskResult = { ok: true, mark: `${kind}:${id}` };
    if (key) this.remember(key, result);

    const phase = lane?.phase ?? this.state?.activePhase ?? undefined;
    // Two event names, on purpose: a journal that records a course correction
    // as a question cannot later explain why the phase changed direction. The
    // relay's notice writes neither — its `phase.question-answered` lines are
    // the record, and a third name for the same fact would be a copy of them.
    // `relay` and `msg` write neither: the relay's `phase.question-answered`
    // lines are its record, and a message's are `Mailbox`'s delivery ledger. A
    // third name for the same fact would be a copy of them.
    if (kind !== 'relay' && kind !== 'msg') {
      this.record(kind === 'ask' ? 'phase.asked' : 'phase.steered', {
        by, mark: result.mark, [kind === 'ask' ? 'question' : 'instruction']: text.slice(0, 500),
        ...(reason ? { reason } : {}),
      }, phase);
    }
    // A question is owed an answer, and the answer is owed a record (TRS-6):
    // kept by its mark until the session replies with it.
    if (kind === 'ask' && result.mark) {
      this.openAsks.set(result.mark, { question: text.slice(0, 500), by, at: Date.now(), ...(phase != null ? { phase } : {}) });
      while (this.openAsks.size > MAX_OPEN_ASKS) {
        const oldest = this.openAsks.keys().next().value;
        if (oldest === undefined) break;
        this.openAsks.delete(oldest);
      }
    }
    // Shown immediately rather than waiting for the CLI's echo: the operator
    // pressed a key and is owed the evidence of it. The echo arrives a moment
    // later carrying the same mark, and the console folds it into this line as
    // a delivery tick rather than printing the message a second time.
    this.emit('stream', {
      phase,
      kind: 'injected',
      text,
      mark: result.mark,
      steer: kind === 'steer',
      ...(kind === 'relay' ? { relay: true } : {}),
      ...(kind === 'msg' ? { peer: true } : {}),
    });
    return result;
  }

  /** Bounded, and oldest-first: an idempotency key is only interesting briefly. */
  /**
   * The return leg of an operator's question (TRS-6): the session's reply,
   * recognised by the mark it was asked to open with, journalled beside the
   * question as `phase.answered {question, options, chosen, by, ms}` — the
   * shape a relayed question's answer takes too, so one reader serves both.
   * An operator's question is free text, so `options` is empty and `chosen` is
   * the reply itself. Once per question: a mark the session repeats, or one
   * this console never asked (a restart lost the stdin it went down), writes
   * nothing. A steer's acknowledgement is not an answer.
   */
  protected noteAnswer(phase: number, event: { text: string; mark: string }): void {
    if (!event.mark.startsWith('ask:')) return;
    const asked = this.openAsks.get(event.mark);
    if (!asked) return;
    this.openAsks.delete(event.mark);
    const sessionId = this.state?.phases[String(phase)]?.sessionId;
    this.record('phase.answered', {
      question: asked.question,
      options: [],
      chosen: event.text.replace(/\s+/g, ' ').trim().slice(0, 500),
      by: 'session',
      ...(sessionId ? { sessionId } : {}),
      askedBy: asked.by,
      mark: event.mark,
      ms: Math.max(0, Date.now() - asked.at),
    }, asked.phase ?? phase);
  }

  private remember(key: string, result: AskResult): void {
    this.injected.set(key, result);
    while (this.injected.size > MAX_INJECT_KEYS) {
      const oldest = this.injected.keys().next().value;
      if (oldest === undefined) break;
      this.injected.delete(oldest);
    }
  }

  /**
   * Stop the run and say a person is needed — without calling it a failure.
   *
   * The case this exists for is an approval nobody answered. That used to
   * resolve as a plain `deny`, and a denial is a *verdict*: the session reads
   * "no" as a decision about the work and adapts around it, so a `git commit`
   * refused because everyone was asleep became a phase that carried on with an
   * uncommitted tree and its `consecutiveFailures` climbing. Parking says the
   * true thing instead — the question is still open, nothing is wrong with the
   * work, and the phase can be retried the moment someone answers.
   */
  /** A park that is draining: the finalizer lands on `parked`, not `halted`. */
  protected parkPending = false;

  park(reason: string, phase: number | null, kind: HaltKind, opts: { approvalId?: string } = {}): boolean {
    if (!this.state) return false;
    if (this.state.halt) return false;
    const at = phase ?? this.state.activePhase;
    // `kind` is the machine-readable class, exactly as `halt()` carries one,
    // and REQUIRED since LFC-1: a needs-human park was indistinguishable from
    // any other park at the halt level, so the situation classifier had to
    // guess from prose. `approvalId` names the card whose timeout parked the
    // run (#140), so the park can lift with the phase — `liftApprovalPark`.
    this.state.halt = {
      at: new Date().toISOString(), reason, ...(at !== null ? { phase: at } : {}), kind,
      ...(opts.approvalId ? { approvalId: opts.approvalId } : {}),
    };
    // With lanes still live the run is DRAINING, not stopped — the same reason
    // `halt()` uses `halting`, and for the same cost when it is got wrong:
    // `parked` is not IN_FLIGHT, so a console that died mid-drain would never
    // pid-check those children. `park` is also what the approval-timeout hook
    // calls, from OUTSIDE the loop, while a lane is live: measured on a real
    // run, 17 minutes of sessions editing trees under a `parked` status.
    // `parkPending` carries the intended terminal word through the drain, so
    // the finalizer lands on `parked` rather than `halted` — a park and a halt
    // are different facts and the operator is shown different things for them.
    this.parkPending = this.lanes.size > 0;
    setRunState(this.state, this.lanes.size ? 'halting' : 'parked');
    this.state.stoppedBy = 'system';
    // Not counted against the failure budget: nobody being awake is not the
    // phase going wrong twice.
    resetStreak(this.state);
    this.record('run.parked', { reason }, at ?? undefined);
    log.warn('runner.parked', { runId: this.state.id, slug: this.state.slug, reason, phase: at });
    // A park is a stop, so its queue is cancelled too — the same reasoning as
    // `pause`, and the same three surfaces.
    this.withdrawQueued('park');
    this.persist();
    this.emit('run', { state: this.state });
    return true;
  }

  /**
   * Lift the park a timed-out approval card raised, once the phase the card was
   * about has completed (control-tower phase 97, #140 — AP-5).
   *
   * The card asked about ONE call of ONE phase. Its timeout parks the run while
   * that phase's own session is still working — told no, it carries on — and
   * when the phase completes the question the park stood for is gone. vca P22
   * completed with §Verification green at 23:29 and its run sat parked on the
   * 21:09 card, P10 ready, until a watchdog retried it at 02:15. A park no card
   * raised (`approvalId` absent) is never lifted here, and neither is one whose
   * phase did not complete: that one still waits for Retry.
   */
  protected liftApprovalPark(): boolean {
    const state = this.state;
    const halt = state?.halt;
    if (!state || !halt?.approvalId || halt.kind !== 'awaiting-person' || halt.phase == null) return false;
    if (state.phases[String(halt.phase)]?.status !== 'done') return false;
    state.halt = null;
    this.parkPending = false;
    setRunState(state, this.resumedStatus());
    this.record('run.park-lifted', {
      approvalId: halt.approvalId, reason: halt.reason, why: 'the phase the card was about completed',
    }, halt.phase);
    this.persist();
    this.emit('run', { state });
    return true;
  }

  /** Take a phase off this run's list without running it. */
  skip(phase: number): void {
    if (!this.state) return;
    const record = phaseRecord(this.state, phase);
    record.status = 'skipped';
    record.note = 'skipped by the operator';
    // The twin of `Service.skipPhase`'s stored path, and for the same reason:
    // skip is permanent, so an ending left on the record outlives every chance
    // to retire it.
    retirePhaseHalt(record);
    // …and so is its errand: a skipped phase is owed nothing (#43), and an ask
    // left standing would hold a scoped run open over it for ever.
    retireSettledErrands(this.state, (event, data, at) => this.record(event, data, at));
    this.record('phase.skip', {}, phase);
    this.persist();
    // `record()` alone reaches the console as `run:journal`, which is
    // stream-only and invalidates nothing: the row this just changed went on
    // showing its old status until something else happened to emit. Every
    // action that edits the record says so at the moment it acts.
    this.emit('run', { state: this.state });
  }

  /**
   * Change how the rest of the run behaves, without stopping it.
   *
   * Not everything here waits for the next phase (control-tower phase 13,
   * #31): the running child was started with a model, an effort and a budget
   * fixed in its argv, and those land on the next spawn — but the lane cap,
   * the budgets the loop checks, the failure ceiling and the permission
   * profile the hook reads are read at the loop's next decision.
   * `SETTING_EFFECTS` says which, per field.
   *
   * `by` is the actor the route DERIVED (a bare label from an older caller is
   * folded through `asActor`), and the line records what each field was
   * before as well as what it became; `extra.before` carries what only the
   * door knew — the plan's QA gate before `qa` moved it.
   */
  configure(
    patch: RunSettingsPatch, by: Actor | string = 'console', extra: { before?: Record<string, unknown> } = {},
  ): boolean {
    if (!this.state) return false;
    const actor = asActor(by, 'Runner.configure');
    const before = this.profile();
    const carveBefore = this.openPrCarveOut();
    const was = { ...settingsBefore(this.state, patch), ...extra.before };
    applySettings(this.state, patch, this.consoleIssueWord());
    const after = this.profile();

    if (after !== before) {
      // Its own journal line, separate from the generic reconfigure: this is
      // the one setting that changes what a session is *permitted* to do, and
      // "who widened this run, and when" has to be answerable later without
      // reading a diff of the whole patch.
      this.record('run.permission-profile', { from: before, to: after, ...actor });
      log.warn('runner.permission-profile', { runId: this.state.id, from: before, to: after, by: actor.by });
      this.rearmSettings();
    } else if (this.openPrCarveOut() !== carveBefore) {
      // The carve-out is part of the settings file too — a git-mode change is
      // a permission change by another name, and gets the same rebuild.
      this.record('run.push-carve-out', { on: this.openPrCarveOut(), ...actor });
      this.rearmSettings();
    }

    this.record('run.reconfigured', { patch: { ...patch }, before: was, ...actor });
    this.persist();
    this.emit('run', { state: this.state });
    return true;
  }

  /**
   * Put a line in the live run's journal from outside the runner.
   *
   * Used for things that are *about* a run without being decisions it made — a
   * rule an operator wrote while watching it. Silently does nothing when no run
   * is live, because the alternative is a caller that has to check first and
   * will eventually forget to.
   */
  /** The line's number in the run's journal (the chat's action card links to it), or null. */
  note(event: string, data: Record<string, unknown> = {}, phase?: number): number | null {
    if (!this.state) return null;
    const line = this.record(event, data, phase);
    // Every refusal this console's hook makes — a deny rule, every guard — is
    // a wall the lane met (control-tower phase 135, #212): kept on its record
    // beside the journal line, so a permission declaration can cite it (G5).
    if (event === 'phase.tool-denied' && typeof phase === 'number' && typeof data.tool === 'string') {
      try {
        this.noteWall(phase, wallOfHookDenial({
          tool: data.tool, rule: typeof data.rule === 'string' ? data.rule : null, command: data.command,
        }, this.now().toISOString()));
      } catch { /* the refusal stands; the record is bookkeeping */ }
    }
    return line;
  }

  /**
   * A wall this console recorded for one lane (control-tower phase 135, #212)
   * — the evidence a `permission` item cites: newest last, a repeat moved to
   * the end, at most `WALLS_KEPT`, cleared at a boarding with `toolDenied`.
   */
  noteWall(phase: number, wall: RecordedWall): void {
    const record = this.state?.phases[String(phase)];
    if (!record) return;
    record.walls = withWall(record.walls, wall);
    this.persist();
  }

  /**
   * A person answered the errand this live run's phase is parked on
   * (control-tower phase 88, #124): `applyErrandAnswer` on the live record,
   * journalled and persisted here, because only the runner writes its state.
   */
  answerErrand(phase: number, answer: ErrandAnswer): boolean {
    const state = this.state;
    if (!state?.phases[String(phase)]) return false;
    applyErrandAnswer(state, phase, answer);
    this.record('phase.errand-answered', { by: answer.by, note: answer.note, situation: answer.situation ?? null }, phase);
    this.persist();
    this.emit('run', { state });
    return true;
  }

  /**
   * "Continue without these servers" for ONE `require`-parked phase — by the
   * clock (`mcpRequireTimeoutMs`, the service's timer) or by the ladder. The
   * phase's own MCP policy becomes `continue`, the record is reset to board
   * fresh with the hint on it, the errand is recorded, and the loop is woken
   * so it boards on the next tick under normal admission. Null when the
   * phase is not such a park any more (healed, retried, or never parked) —
   * every caller's race lands here and answers "nothing to do".
   *
   * Only a live loop boards it; for a stopped run the service flips the
   * stored record with the same function and restarts the run.
   */
  continueMcpPark(phase: number, by = 'timeout'): McpContinueResult | null {
    if (!this.state) return null;
    const result = continueMcpParkedRecord(this.state, phase, { by, now: this.now(), journal: this.declarationSink() });
    if (!result) return null;
    this.record('phase.mcp-require-timeout', {
      servers: result.servers, waitedMs: result.waitedMs, by,
    }, phase);
    this.record('phase.errand', {
      ...result.errand, label: 'MCP server unavailable',
      reason: `waited ${Math.round(result.waitedMs / 60_000)} min under the require policy`, by,
    }, phase);
    this.ladderSeen.delete(phase);
    this.emit('phase', { phase, status: 'pending', note: null, errand: result.errand, mcpContinue: result.servers });
    this.persist();
    this.wake.resolve();
    this.deps.onMcpRequireTimeout?.(this.state, phase, result);
    return result;
  }

  /**
   * A declared outcome that arrived from OUTSIDE a lane: `phase-outcome.sh`
   * run by a session nobody here spawned — a person's `claude`, whose file
   * landed in the console's inbox (`runs/<instance>/<slug>/outcomes/`). The
   * same vocabulary as a lane's own declaration, read the same way:
   *
   *   waiting-external  the record is parked `waiting` until `resume_after`
   *                     (the session's own clock; floored and budgeted like a
   *                     lane's) and THAT session is what resumes — the phase's
   *                     context is the whole point;
   *   partial           the record is reset with a resume hint and the loop
   *                     boards it at once — continuing the session when it can
   *                     be reached, a fresh boot with the resume brief when not;
   *   blocked / needs-human / complete
   *                     journalled; the classifier reads the declaration as
   *                     evidence and the ladder takes it from there.
   *
   * A phase a lane of this run is working, or whose record is done, is left
   * alone — the declaration is journalled as ignored and the file was consumed.
   */
  /**
   * A resume the console refused because the session it would resume is still
   * running (REG-1) — written on this run's journal and on the phase, where the
   * page shows it. Called by the inbox, which read the presence before it
   * consumed the declaration; the runner's own `resumableSession` writes the
   * same record when the refusal happens at boarding.
   */
  noteResumeRefused(
    phase: number,
    refusal: { sessionId: string; why: 'session-live' | 'session-lease'; pid?: number; lock?: string; [key: string]: unknown },
  ): void {
    const state = this.state;
    if (!state) return;
    const record = phaseRecord(state, phase);
    record.resumeRefused = {
      sessionId: refusal.sessionId, at: this.now().toISOString(), why: refusal.why,
      ...(refusal.pid ? { pid: refusal.pid } : {}), ...(refusal.lock ? { lock: refusal.lock } : {}),
    };
    this.record('phase.resume-refused', refusal, phase);
    this.emit('phase', { phase, status: record.status, note: record.note ?? null, resumeRefused: record.resumeRefused });
    this.persist();
  }

  /** The person cards this run is waiting on — `cardId → {phase, until}` (WAI-10). */
  private readonly personCards = new Map<string, {
    phase: number; until: string;
    /** A TOOL card: when it went up and the call it holds — credited back to that call's wait (#206). */
    held?: { since: number; toolUseId?: string };
  }>();

  /**
   * A card is a WAIT (WAI-10). While a verification card or a tool approval
   * card stands, the run is waiting on a person: `waitReason: 'person'`, the
   * run's clock at the soonest card's expiry, the status `waiting` — so every
   * surface, the budget and the boot re-arm treat the commonest human-shaped
   * wait as a wait. It used to be `running` with no child and no spend for up
   * to twelve hours, and the park a timeout produced had no kind. Restart-safe
   * like every wait: `reconcileRun` turns it `paused` with the clock intact,
   * the boot re-arm fires at the card's expiry and the resume re-raises it.
   */
  enterPersonWait(phase: number, card: { id: string; until: string; on: string; tool?: boolean; toolUseId?: string }): void {
    const state = this.state;
    if (!state) return;
    this.personCards.set(card.id, {
      phase, until: card.until,
      ...(card.tool ? { held: { since: this.now().getTime(), ...(card.toolUseId ? { toolUseId: card.toolUseId } : {}) } } : {}),
    });
    const soonest = [...this.personCards.values()].map((c) => c.until).sort()[0];
    state.waitUntil = soonest;
    setRunState(state, 'waiting', { kind: 'person', until: soonest, on: card.on });
    this.record('run.waiting-person', { phase, cardId: card.id, until: card.until, on: card.on, cards: this.personCards.size });
    this.persist();
    this.emit('run', { state });
  }

  /** The card is down — answered, expired or the run ended. The wait ends with the LAST card. */
  leavePersonWait(cardId: string): void {
    const state = this.state;
    const card = this.personCards.get(cardId);
    if (!this.personCards.delete(cardId) || !state) return;
    // The call a tool card held did not wait while it was held (control-tower
    // phase 111, #206): 2 min 45 s on a card counted toward a "5 minute" wait
    // and the checkpoint followed. Credited back to that call's clock.
    const lane = card?.held ? this.lanes.get(card.phase) : undefined;
    if (lane && card?.held) {
      creditHeldTime(lane.signals, { ...card.held, until: this.now().getTime() });
    }
    if (this.personCards.size) {
      state.waitUntil = [...this.personCards.values()].map((c) => c.until).sort()[0];
      this.persist();
      return;
    }
    state.waitReason = null;
    state.waitUntil = null;
    // A phase parked on external work meanwhile keeps its clock on the run.
    syncWaitClock(state);
    // Compare-and-set, as the usage wait does: a status another lane wrote
    // while this one waited is not this lane's to overwrite.
    if (state.status === 'waiting') setRunState(state, this.resumedStatus());
    this.persist();
    this.emit('run', { state });
  }

  /**
   * An inbox declaration the console set aside without acting on it (WAI-7) —
   * stale, unparseable, or one whose act threw — written on THIS run's journal
   * because the plan's runner is live. The inbox keeps the file under
   * `outcomes/ignored/`; this is the line that says so.
   */
  noteOutcomeIgnored(phase: number, data: Record<string, unknown>): void {
    this.record('phase.outcome-ignored', data, phase);
  }

  /**
   * A declared watch ref LANDED while this run's loop is live (control-tower
   * phase 6, #15). The healer's `resumeOnWatchLanded` hands the landing here
   * instead of to `recoverPhase`, whose "is in progress" refusal spent the
   * landing three times and then wrote it off as a person's errand — measured:
   * a green CI run on a phase waiting to merge, refused for as long as any
   * sibling lane of the same run was live, which under `keep-going` is always.
   *
   * The contract:
   *  - the phase is this run's, holding its declaration (`waiting`, `parked`
   *    on `needs-human`/`blocked`, or already a `pending`/`queued` candidate),
   *    and not already in a lane;
   *  - its clock is set to NOW (`parkedUntil`) — a `parked` declaration
   *    becomes a `waiting` one whose window has elapsed — so the loop's own
   *    candidate set picks it up as an elapsed wait and resumes its OWN session,
   *    the landing as the resume's words (`waitResumePrompt`, cause `landed`);
   *  - it boards AHEAD of its scope: first in the loop's fill, and admitted
   *    with `AdmitRequest.reserve` (`landingReserve`, spent at admission);
   *  - the loop is woken, so the landing does not wait on whichever lane
   *    settles next;
   *  - `phase.resume-automatic {trigger: watch, path: live-lane}` says so.
   * Nothing here is `recoverPhase`, and nothing here can be refused as busy.
   * Returns false and touches nothing when any of that does not hold; the
   * caller then treats the landing as it always did.
   */
  landWatch(
    phase: number, landed: { ref: string; detail?: string },
    opts: { count: number; sessionId?: string | null },
  ): boolean {
    const state = this.state;
    if (!state || !this.driving) return false;
    const record = state.phases[String(phase)];
    const declared = record?.declared;
    if (!record || !declared || !['waiting-external', 'needs-human', 'blocked'].includes(declared.status)) return false;
    if (this.lanes.has(phase) || !['waiting', 'parked', 'pending', 'queued'].includes(record.status)) return false;
    // A person's park the world has answered waits for its lane like any
    // elapsed wait; `parkedFrom` keeps the park's own start for `parkedMsOf`.
    // A `pending`/`queued` one is already a candidate and needs only the
    // reservation and the wake.
    if (record.status === 'parked') record.status = 'waiting';
    if (record.status === 'waiting') {
      record.parkedUntil = this.now().toISOString();
      syncWaitClock(state);
      this.clearParkPoke(phase);
    }
    this.landingReserve.add(phase);
    // Already waiting in `admit()` — an elapsed wait queued behind its scope?
    // Its entry was born without the reservation; it gets one now.
    this.deps.scheduler?.reserveQueued(state.id, phase);
    this.record('phase.resume-automatic', {
      trigger: 'watch', path: 'live-lane', count: opts.count, sessionId: opts.sessionId ?? null, ref: landed.ref, by: 'watch',
    }, phase);
    this.persist();
    this.emit('phase', { phase, status: record.status });
    this.emit('run', { state });
    this.wake.resolve();
    return true;
  }

  /** Is a landing handed to `landWatch` still waiting for its lane? The watch clock's hold. */
  landingPending(phase: number): boolean {
    return this.landingReserve.has(phase) || this.lanes.has(phase);
  }

  async declareOutcome(
    phase: number, declared: PhaseOutcome, by = 'unsupervised',
  ): Promise<'parked' | 'boarding' | 'noted' | 'ignored' | null> {
    // The plan's allowance first, while nothing has been written: the park below
    // is answered by the same `evaluateWait` a lane's own declaration gets.
    const budget = declared.status === 'waiting-external' ? await this.waitBudgetOf(phase) : undefined;
    const state = this.state;
    if (!state) return null;
    const record = phaseRecord(state, phase);
    const ignore = (reason: string): 'ignored' => {
      this.record('phase.outcome-ignored', { status: declared.status, reason, by, sessionId: declared.session_id ?? null }, phase);
      return 'ignored';
    };
    if (this.lanes.has(phase)) return ignore('a lane of this run is working the phase');
    if (record.status === 'done') return ignore('the record is already done');
    // The screen every declaration gets before it is acted on (#42): a watch on
    // this phase's own lock is refused, and a block on a person keeps no watch
    // and no clock — for a hand session's file exactly as for a lane's.
    const screened = screenDeclaration(declared, state.slug, phase);
    for (const ref of screened.ownLock) {
      this.record('phase.watch-refused', { ref, why: 'own-lock', reason: OWN_LOCK_WATCH_REFUSAL, by }, phase);
    }
    declared = screened.outcome;
    // The moment a `blocked`/`needs-human` session named, floored and capped
    // like every other path's (`declaredClock`, WAI-8) — computed here so the
    // `phase.outcome` line carries the cap, armed below only if acted on. This
    // twin used to arm no clock at all, so a hand session's `--until` was
    // dropped whenever the plan's runner happened to be live.
    const clock = declared.status === 'blocked' || declared.status === 'needs-human'
      ? declaredClock(declared.resume_after, { now: this.now().getTime(), floorMs: this.deps.waitFloorMs })
      : null;
    this.record('phase.outcome', {
      status: declared.status, reason: declared.reason ?? null,
      resumeAfter: declared.resume_after ?? null, watch: declared.watch,
      ...(clock ? { requested: clock.requested, granted: clock.until, capped: clock.capped } : {}),
      ...screenedFields(screened),
      sessionId: declared.session_id ?? null, by,
    }, phase);
    // The declarations ledger (WAI-8, SLF-4) — the live twin of the stored
    // arm's, same knobs: every word counted, a repeat inside the cooldown
    // collapsed into the act that stands, a word past its cap recorded and not
    // acted on. The record is otherwise untouched.
    const charge = chargeDeclaration(record, declared.status, { now: this.now().getTime(), cooldownMs: declarationCooldownFor(declared.status) });
    if (charge.verdict !== 'act') {
      this.record(DECLARATION_REFUSED_EVENT, {
        status: charge.status, why: charge.verdict === 'cooled' ? 'cooldown' : 'cap', count: charge.count, max: charge.max,
        refused: charge.refused, ...(charge.cooldownMs !== undefined ? { cooldownMs: charge.cooldownMs } : {}),
        reason: declared.reason ?? null, sessionId: declared.session_id ?? null, by,
      }, phase);
      this.persist();
      return 'ignored';
    }
    // A NEW declaration supersedes the last one — the `new-outcome` licence,
    // as the supervised `routeOutcome` spends it (WAI-9).
    consumeDeclaration(record, 'new-outcome', (event, data, at) => this.record(event, { ...data, next: declared.status, by }, at));
    if (declared.session_id) {
      // The declaring session is the one to resume. A session nobody here
      // spawned lives under the machine's own login — `resumableSession` ports
      // its transcript when the run pays as somebody else.
      record.sessionId = declared.session_id;
      delete record.sessionAccountId;
    }
    let verdict: 'parked' | 'boarding' | 'noted';
    switch (declared.status) {
      case 'waiting-external': {
        // Presence was read at the inbox, before this file was consumed
        // (`ServiceRuns.ingestOutcomeFile`): a declaring session that is still
        // live never reaches here. `resumableSession` reads it again at boarding.
        record.resumeSessionId = declared.session_id ?? record.sessionId;
        verdict = this.parkWaiting(phase, declared, { by: by === 'unsupervised' ? 'unsupervised' : 'session', budget })
          ? 'parked' : 'noted';
        break;
      }
      case 'partial': {
        // A re-board of the SAME work, unattended: `prepareReboard`, never
        // `resetForRetry` — the watchdog's bound and the ledger stay (SLF-4).
        prepareReboard(record);
        // What the gate reads when the `continue` below asks for this session.
        record.lastPartial = {
          sessionId: declared.session_id ?? record.sessionId ?? null, reason: declared.reason ?? null, at: new Date().toISOString(),
        };
        const brief = declared.session_id ? 'continue' : 'resume';
        record.boardingHint = {
          situation: 'work-in-progress', rung: 'resume-own-session', brief,
          ...(declared.session_id ? { sessionId: declared.session_id } : {}),
          at: new Date().toISOString(), by,
        };
        this.record('phase.reboard-requested', { situation: 'work-in-progress', rung: 'resume-own-session', brief, by }, phase);
        this.emit('phase', { phase, status: record.status, note: record.note ?? null });
        verdict = 'boarding';
        break;
      }
      default:
        // `blocked`/`needs-human` do not park a run over a hand-run session's
        // word — but the declaration itself persists, so the classifier and
        // the healer's watch poll read the same testimony a supervised
        // session would have left.
        if (declared.status === 'blocked' || declared.status === 'needs-human') {
          record.declared = {
            status: declared.status,
            ...(declared.reason ? { reason: declared.reason } : {}),
            ...(declared.watch.length ? { watch: declared.watch } : {}),
            ...needsOf(declared),
            at: new Date().toISOString(),
          };
          if (declared.watch.length) record.watch = declared.watch;
          clearWatchBookkeeping(record);
          if (clock) {
            record.parkedUntil = clock.until;
            this.armParkPoke(phase, clock.until);
          }
          // A HUMAN STEP from a session this run did not spawn (control-tower
          // phase 41): recorded and announced once, and the phase waits on a
          // PERSON — no external-wait budget charged (`parkOnStep`).
          const raised = declared.status === 'needs-human' && declared.step
            ? this.deps.humanStep?.({
              slug: state.slug, phase, birth: 'session', step: declared.step, runId: state.id,
              ...(declared.session_id ? { sessionId: declared.session_id } : {}),
            }) ?? null
            : null;
          // Refused by the guard at ingest (control-tower phase 130): no item.
          const step = raised && !('refused' in raised) ? raised : null;
          if (raised && 'refused' in raised) {
            record.note = `${record.note ?? 'the session asked for a person'} — the guard refused it (${raised.refused.rule}): ${raised.refused.sentence}`;
            this.record('phase.turn-refused', { ...refusalFields(raised.refused) }, phase);
          }
          if (step) {
            parkOnStep(record, step, by === 'unsupervised' ? 'unsupervised' : 'session', record.declared.at);
            this.record('phase.human-step', stepJournalFields(step), phase);
          }
        }
        verdict = 'noted';
    }
    this.persist();
    this.wake.resolve();
    return verdict;
  }

  /**
   * Send a reviewed phase back to work with the reviewer's comments.
   *
   * This is the other half of P13's review surface: a verdict that HOLDS
   * dependents was only ever half a loop, because the thing that must change is
   * the phase itself, and re-boarding it by hand meant a person reading the
   * comments, writing a prompt from them, and hoping they quoted all five.
   *
   * What it does is exactly a Retry that carries words. The record is reset
   * through the ONE reset (`resetForRetry`, shared with Retry and the ladder —
   * the two copies that once existed drifted twice), and the boarding hint that
   * survives it is a `resume` brief with the follow-up as its instruction. That
   * reuse is deliberate and it is the same judgement P13 made about `gated`:
   * a new `BoardingBrief` would have to be taught to the ladder, the situation
   * classifier, `briefForRung` and every "what is this phase doing" summary,
   * to describe a boarding those readers already handle correctly. What tells
   * a follow-up apart from an ordinary resume is its `situation` and `rung`,
   * which is precisely the pair the journal and the rung history index on.
   *
   * Refuses rather than throws, and names why: the caller is an HTTP route.
   */
  sendBack(
    phase: number, followUp: string, by = 'console',
  ): { ok: true; boarded: boolean } | { ok: false; reason: string } {
    if (!this.state) return { ok: false, reason: 'this run is not loaded.' };
    const text = followUp.trim();
    if (!text) {
      // An empty follow-up would re-board the phase with the plain resume
      // brief — indistinguishable from a Retry, while the operator believes
      // they sent comments.
      return { ok: false, reason: 'a follow-up needs something to say.' };
    }
    if (Buffer.byteLength(text) > MAX_FOLLOW_UP_BYTES) {
      return { ok: false, reason: 'that follow-up is too long (16 KB max).' };
    }
    const record = phaseRecord(this.state, phase);
    if (record.status === 'running') {
      // The phase is mid-session. Re-boarding it now would reset the record out
      // from under a live child, and the comments are about a diff that is
      // still moving. `steer` is the verb for talking to a running session.
      return { ok: false, reason: 'that phase is running — steer its session instead of sending it back.' };
    }

    const at = new Date().toISOString();
    resetForRetry(record, { by: 'operator', journal: this.declarationSink() });
    record.boardingHint = {
      situation: FOLLOW_UP_SITUATION,
      rung: FOLLOW_UP_RUNG,
      brief: 'resume',
      instruction: text,
      at,
      by,
    };
    this.ladderSeen.delete(phase);
    // A follow-up is not a failure: the phase did the work and a reader asked
    // for more. Counting it would walk the run toward a halt for being
    // reviewed thoroughly.
    resetStreak(this.state);
    this.state.halt = null;
    this.record('phase.review-follow-up', { by, bytes: Buffer.byteLength(text) }, phase);
    this.persist();
    // Same reason Retry emits `run` rather than `phase`: the halt banner and
    // the phase row both have to move, and only a run event moves both.
    this.emit('run', { state: this.state });
    this.wake.resolve();
    return { ok: true, boarded: this.state.status === 'running' };
  }

  /**
   * Board `phase` at this run's next boundary, with the words a person gave
   * (control-tower phase 98, #137 item 3) — the pause and `resume-phase` pair
   * made one act, on a run that keeps driving.
   *
   * A person's re-board, so it sits in the PERSON slot (rank 0 of
   * `boardingOrder`, reading no rung cap) — and it is RESERVED at admission,
   * the landing's reservation (`landingReserve`): admitted with
   * `AdmitRequest.reserve`, aged at birth, first in the scan, and every
   * sibling sharing its scope waits a tick behind it (`landingHeld`). A lane
   * that frees is this phase's; nothing boards into the gap (#134). The
   * phase's own session is resumed when it has one (`continue`, through the
   * boarding's own gate, which boards fresh with the resume brief when the
   * session is not worth resuming); else it boards fresh with the brief.
   *
   * Refused, touching nothing, for a phase in a lane (steer it, or leave a note
   * for its next attempt) and for one the record already calls done.
   */
  boardAtBoundary(
    phase: number, opts: { instruction?: string; actor: StartActor },
  ): { ok: true; brief: BoardingBrief; sessionId: string | null } | { ok: false; reason: string } {
    const state = this.state;
    if (!state) return { ok: false, reason: 'no run is loaded' };
    const record = phaseRecord(state, phase);
    if (this.lanes.has(phase) || PHASE_IN_FLIGHT.includes(record.status)) {
      return {
        ok: false,
        reason: `phase ${phase} is running now — steer it, or leave a note for its next attempt (deliver: next-attempt)`,
      };
    }
    if (record.status === 'done') return { ok: false, reason: `phase ${phase} is done — there is nothing to board` };
    const at = new Date().toISOString();
    const situation = personSituationOf(record);
    const own = record.resumeSessionId ?? record.sessionId ?? null;
    const instruction = opts.instruction?.trim() || undefined;
    const hint: BoardingHint = own
      ? { situation, rung: 'resume-own-session', brief: 'continue', sessionId: own, ...(instruction ? { instruction } : {}), at, by: PERSON_SLOT_BY }
      : { situation, rung: 'reboard-resume-brief', brief: 'resume', ...(instruction ? { instruction } : {}), at, by: PERSON_SLOT_BY };
    accountPersonRung((state.recoveries ??= {}), phase, {
      situation, rung: hint.rung as Parameters<typeof accountPersonRung>[2]['rung'], at, note: "a person's board-at-boundary",
    });
    this.reboardWith(record, hint);
    this.landingReserve.add(phase);
    // Already waiting in `admit()`? Its entry takes the reservation where it stands.
    this.deps.scheduler?.reserveQueued(state.id, phase);
    this.record('phase.board-at-boundary', {
      brief: hint.brief, sessionId: own, ...(instruction ? { instruction: instruction.slice(0, 500) } : {}), ...opts.actor,
    }, phase);
    this.persist();
    this.emit('phase', { phase, status: record.status });
    this.emit('run', { state });
    this.haltSignal.dispatchEvent(new Event('wake'));
    if (this.driving) this.wake.resolve();
    return { ok: true, brief: hint.brief, sessionId: own };
  }

  /**
   * Clear a phase's terminal state so the loop will pick it up again.
   *
   * `press` says whose retry it is (RCV-3, phase 9): a person's clears the
   * failure streak and the recover ledger — they are back in the loop — while
   * an automatic retry (the healer's rung, a watch landing) carries both
   * forward. Absent means a press: every caller that predates the word is a
   * button or a harness.
   */
  retry(phase: number, override?: RetryOverride, opts: { press?: boolean; reason?: string } = {}): void {
    if (!this.state) return;
    const press = opts.press ?? true;
    const record = phaseRecord(this.state, phase);
    // Read before the reset, which is the start of a new attempt: the person
    // slot's rung is labelled with what the classifier last said.
    const situation = personSituationOf(record);
    // The ONE reset — `state.ts` `resetForRetry`, shared with the stored-run
    // Retry in the service. The two used to carry their own copies and
    // drifted twice (a retried phase kept the preflight and the missing
    // servers of an attempt that was no longer going to happen; the lock-cap
    // clock survived into the retry and re-parked it instantly).
    // The override rides the same one reset for the same reason — the live and
    // stored paths must not disagree about what a Retry-with-edits leaves
    // behind, and this is the third time that class of drift has cost a day.
    resetForRetry(record, { by: press ? 'operator' : 'console', override, journal: this.declarationSink() });
    this.ladderSeen.delete(phase);
    if (press) resetStreak(this.state);
    this.state.halt = null;
    // The recover verb's ledger is the operator's to clear, and Retry is how
    // they say "from the top" (RCV-4).
    if (press) delete this.state.recoveries?.[String(phase)]?.recovers;
    // …and it REPLENISHES the phase's ladder (control-tower phase 5, #14 ask
    // 3): the interruptions and environment records it counted are forgiven,
    // never a verdict and never a dollar. Before this, the errand's own advice
    // — "take that errand, then Retry" — re-parked the phase one second later.
    if (press) {
      const forgiven = forgiveRungs(this.state.recoveries?.[String(phase)], retryForgives, new Date().toISOString(), 'operator');
      if (forgiven.length) this.record('phase.ladder-replenished', replenishedPayload(forgiven, 'operator'), phase);
    }
    // A phase still WAITING for admission is re-requested under the run's
    // current account (control-tower phase 78, #92): its entry kept the account
    // it was queued under, so a Retry that only reset the record left it held
    // by a window the run no longer pays with. Same entry, same age.
    this.deps.scheduler?.rekeyRun(this.state.id, this.state.accountId, { phase });
    this.record('phase.retry-requested', {
      ...(override?.addendum ? { addendum: override.addendum } : {}),
      ...(override?.options && Object.keys(override.options).length ? { options: override.options } : {}),
      ...(override?.by ? { by: override.by } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
    }, phase);
    // …and a person's press boards in the PERSON slot (control-tower phase 53,
    // #56): outside the automatic ladder, reading no rung cap. Without the hint
    // the loop's own ladder pass re-climbed the phase on its next tick, found
    // the cap spent and parked it again — twelve seconds after the button said
    // yes. An automatic retry (the healer's rung, a watch landing) accounted
    // its own rung and stays the ladder's.
    if (press) this.boardForPerson(record, situation);
    this.persist();
    // See `skip`. Retry is the one this was reported against: the halt banner
    // stayed on screen, the phase still read `failed`, and the only way to
    // learn the retry had been accepted was to reload the page.
    this.emit('run', { state: this.state });
    // A loop asleep between ticks boards the phase now, not at its next poll.
    this.haltSignal.dispatchEvent(new Event('wake'));
    // …and a loop asleep on a LIVE lane reads the hint now too (control-tower
    // phase 86, #128): the Retry used to re-set the hint and wait for that lane
    // to end, so a phase a person pressed for sat unqueued for the whole of it.
    if (this.driving) this.wake.resolve();
  }

  /**
   * Board `record` in the person slot — the rung recorded `by: operator`, the
   * `fresh` hint left on the record — and journal the rung like any other,
   * naming the slot. Shared by the live Retry and nothing else on the runner;
   * the stored-run Retry calls the same `boardInPersonSlot` in the service.
   */
  protected boardForPerson(record: PhaseRecord, situation: string): void {
    const state = this.state!;
    const { rung, hint } = boardInPersonSlot((state.recoveries ??= {}), record, {
      situation, at: new Date().toISOString(),
    });
    this.ladderSeen.delete(record.phase);
    this.record('phase.rung', {
      situation, rung: rung.rung, params: null, brief: hint.brief, vehicle: 'runner',
      attempt: state.recoveries?.[String(record.phase)]?.attempts ?? 1, by: PERSON_SLOT_BY, slot: 'person',
    }, record.phase);
  }

}
