/**
 * `ServiceRuns` — link 3 of the `Service` chain.
 *
 * One contiguous section of a class that outgrew one file. The chain is a
 * FILE boundary, not a design boundary: members keep their order, their
 * bodies and their single prototype, so `Service` behaves exactly as it did
 * when this was one declaration — including for the tests that reach its
 * private members. `protected` here means "another link uses it", nothing
 * more. Read the chain in order; `service.ts` holds the concrete class.
 */
import { parkOnStep, stepJournalFields, type HumanStep } from './human-steps.ts';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, relative } from 'node:path';
import { availableParallelism, homedir, loadavg } from 'node:os';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { instanceId } from '../shared/instances.mjs';
import {
  INSTANCE, INSTANCE_STATE_DIR, SKILL_DIR, STATE_DIR, agentEnabled, checkRoot, distRev, rememberRoot, loadPrefs, savePrefs,
  serverIsStale, staticRoot,
  type Flags, type Prefs, type RootCheck,
  notifyCommand,
} from './config.ts';
import {
  SessionRegistry, correlate, parseHookPayload, peersSentence,
  type ChangeMeta, type RegistryChange, type RunLink, type SessionEventName, type SessionRecord, type SessionView,
} from './sessions/registry.ts';
import { hooksStatus, installHooks, uninstallHooks, type HooksStatus, type HooksWrite } from './hooks-install.ts';
import { readSkillApi, sessionSkillCopy, skillApiVerdict } from './skill-copy.ts';
import { Store, handoffFor, lockFor, qaFor, readLock, type PlanRecord } from './store.ts';
import {
  ConvergeScheduler, convergePlan, HALT_DELAY_MS, type ConvergeDeps, type ConvergeReport, type ConvergeTrigger, convergeView, type ConvergeView,
  automaticResumeGate, automaticResumes, resumeErrand, PRESS_ONLY_HALT_KINDS,
} from './converge.ts';
import { planWrite, runWrite } from './writes.ts';
import { type FleetHold } from './fleet-hold.ts';
import { forgetPid, warmPids } from './pid.ts';
import { killLadder, type LadderEnding } from './runner/signals.ts';
import {
  run, invalidate, readMemoryBlock, readQaMode, readSessionPlan, readLint, readGateStatus,
  readText, readBoardText, type Board, type QaMode, type SessionPlan, type LintResult,
  type GateStatus,
} from './engine.ts';
import { SearchIndex, type SearchResult } from './search.ts';
import { listSkills, type SkillInfo } from './skills.ts';
import { DocsWatcher } from './watch.ts';
import {
  degradedState, hasShutdownWork, onDegraded, requestRestart, requestShutdown, stopPlan, supervisor,
} from './lifecycle.ts';
import { log } from './log.ts';
import {
  CATEGORIES, Push, isPlanProgress, routeFor, sanitiseCategories, tagFor, type CategoryId,
} from './push/index.ts';
import { Notifications, type NotificationQuery, type NotificationRecord } from './notifications.ts';
import { repoInfo, lastCommit, commitsTouching, type GitRepoInfo, type GitFileInfo } from './git.ts';
import { findMemory, memoryIndexLines } from './memory.ts';
import {
  loadSizing, loadMcpSurcharge, indexGraph, routeLayout, analysePhases, criticalPath, remainingWork,
  resolveBudget, weightOf, type Sizing, type McpSizing, type PhaseAnalysis,
} from './analysis/graph.ts';
import { loadGateVocab, gateKindOf, type GateVocab, type GateKind } from './analysis/gates.ts';
import { rungsToday, spendSummary, type SpendRunView, type SpendView } from './analysis/spend.ts';
import { composePhaseReport, readPhaseJournal, type PhaseReport } from './analysis/phase-report.ts';
import { activityOf, sessionActivityFor, type PhaseActivity } from './sessions/scope-inference.ts';
import {
  buildInbox, inboxIds, pruneAcks, readAcks, removeAck, writeAck,
  INBOX_ACKS_DIR, type InboxAck, type InboxFacts, type InboxView,
} from './inbox.ts';
import { STALL_META, STALL_SIGNAL_META, inboxItemId, parseInboxItemId, SESSION_ASK_WAIT_KINDS } from '../shared/attention-model.js';
import { deriveEvidence } from '../shared/evidence-model.js';
import {
  fleetHoldSentence, runPriority, QUEUE_VERBS, LANE_MARK_VERBS, DEFAULT_SCHEDULING_POLICY, isSchedulingPolicy, loadReading,
} from '../shared/orchestration-model.js';
import {
  applyQueueControl, laneMarkRefusal, LANE_YIELDED_EVENT, QUEUE_REORDERED_EVENT, type PhaseQueueVerb, type QueueControlResult,
} from './runner/queue-control.ts';
import { isQueueAuditEvent, queueView, type QueueAuditLine } from './queue-view.ts';
import { isClosedPlanStatus, qaGateOff } from '../shared/plan-vocab.js';
import { DEFAULT_QA_FIX_STRATEGY, DEFAULT_QA_MAX_ROUNDS, type QaFixStrategy } from '../shared/run-settings.js';
import { qaRungInstruction, type QaRecoverVerb } from './runner/qa-recover.ts';
import {
  planStats, portfolio, etaSamples, etaEvidence, etaFrom, fitShape, rateFor, phaseEtaFor, healthIssues, isClosedStatus, splitRepos,
  estimateMs, holderRemaining,
  type PlanStats, type Portfolio, type PlanContext, type EtaEstimate, type EtaSample,
  type PhaseEta, type RateReading, type EtaShape, type RemainingFloor,
} from './analysis/stats.ts';
import { credentialsFor, humanStepsFor, mcpServersFor, personCheckFor, type Plan, type PhaseDetail, type PhaseRow } from './parse/plan.ts';
import { wantsDefaultCheckout } from '../shared/worktree-model.js';
import { phaseClocks } from '../shared/phase-clocks.js';
import { wallReading, withWallWhy } from '../shared/situation-model.js';
import { mergeDecisions, subKindOfNeed } from '../shared/decisions-model.js';
import { PreludeRefusal, preludeFor, resolvedManifest, scopedSteps, type DeliveryFacts, type Prelude, type PreludeDeps, type PreludeOptions } from './prelude.ts';
import type { PreludeStep, SkillApiFacts } from './prelude.ts';
import { GitStrategyRefusal, type GitStrategyLine } from './prelude.ts';
import { credentialsHeld } from './credentials-probe.ts';
import {
  doctorReport, presenceDirs, skipped, type DoctorDeps, type DoctorInstance, type DoctorReport, type PresenceDir, type UnitFacts,
} from './doctor.ts';
// The unit row is Pro by location (the free tree has no launchd unit): the
// export is stripped from doctor.ts there, so the import goes with it.
import { probeAccounts, probeCredentials, probeDelivery, probeMcp } from './prelude.ts';
import { cliVersion } from './accounts/transcripts.ts';
import { unitName, unitPath } from '../shared/instances.mjs';
import { execFile as execFileCb } from 'node:child_process';

/**
 * Is the phase's own session worth offering as a resume?
 *
 * THREE facts, not two: there must be a session, the CLI must still hold it,
 * and the resume policy must not already have written it off (checkpointed,
 * `partial --reason budget|context`, or large and cold/under another account).
 * The recovery payload used to ask only the first two, so a session the runner's
 * gate would refuse was still shown as "Resume with instruction" — and pressing
 * it came back with the policy's reason, an offer nothing could accept.
 * `resolveVehicle` already asked all three; this is that computation, named once
 * so the two callers cannot drift again. (console-open-findings O1.)
 *
 * `paying` is the account that would pay for the resume, or null when the caller
 * cannot say — the account is then not judged, exactly as `resumePolicy` documents.
 */
export function resumeOffer(
  record: RunPhaseRecord | undefined,
  paying: string | null,
  now: number = Date.now(),
): { sessionId: string | undefined; resumable: boolean; policy: ResumePolicy | null } {
  const sessionId = record?.sessionId ?? record?.resumeSessionId;
  const gone = Boolean(record && isSessionGone(record));
  const policy = record && sessionId && !gone
    ? resumePolicy(record, sessionId, { now, paying })
    : null;
  return { sessionId, resumable: Boolean(sessionId) && !gone && policy?.choice !== 'fresh', policy };
}

/**
 * A press's refusal, from whatever its door threw (control-tower phase 53):
 * 409 with the door's own sentence, and the session holding the phase when a
 * live recovery is the reason — the answer the client opens instead of erring.
 */
export function pressRefusal(error: unknown, fallback: string): { ok: false; status: number; error: string; sessionId?: string } {
  return {
    ok: false, status: 409,
    error: (error as Error)?.message || fallback,
    ...(error instanceof RecoveryBusyError && error.sessionId ? { sessionId: error.sessionId } : {}),
  };
}

/** `execFile` with stdout kept, for the unit reader — a 10 s timeout the runtime enforces. */
function execText(file: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    try {
      execFileCb(file, args, { timeout: 10_000, windowsHide: true }, (error, stdout) => {
        if (!error) { resolve({ code: 0, stdout: String(stdout ?? '') }); return; }
        const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null;
        resolve({ code, stdout: String(stdout ?? '') });
      });
    } catch { resolve({ code: null, stdout: '' }); }
  });
}
import { policyForKey, policyForPlan, policyPrefsOf } from './runner/policy.ts';
import { tailscaleStatus } from './tailscale.ts';
import {
  declarationCooldownFor, declaredClock, evaluateWait, openWaitEntry, ordinalSuffix, parkedMsOf,
  screenDeclaration, screenedFields,
} from './runner/wait-budget.ts';
import { OWN_LOCK_WATCH_REFUSAL, type SwitchWhen } from '../shared/run-lifecycle.js';
import { liveErrandHow, pollableRefs, unpollableRefs, type WatchState } from './watch-refs.ts';
import {
  Runner, applySettings, settingsBefore, VERIFICATION_PARK_NOTE, MCP_PARK_NOTE,
  type AskResult, type RecoverMode, type RunSettingsPatch, type StartOptions,
} from './runner/runner.ts';
import { spentBudgetPark } from './runner/runner-loop.ts';
import { Scheduler, isExternalWall, lockLapsed, planRemainingEta, type HolderEta, type LockView, type QueueEntry } from './runner/scheduler.ts';
import { offeredModels } from './runner/models.ts';
import {
  continueMcpParkedRecord, mcpParkDueAt, DEFAULT_MCP_REQUIRE_TIMEOUT_MS, type McpContinueResult,
} from './runner/mcp-park.ts';
import {
  classifySituation, collectEvidence, summariseEvidence,
  type EvidenceCache, type EvidenceDeps, type PhaseEvidence, type Situation,
} from './runner/situation.ts';
import {
  accountPersonRung, accountRung, boardInPersonSlot, errandFor, forgiveRungs, ladderCaps, nextRung, personSituationOf,
  replenishedPayload, retryForgives, rungsFor, settleRung, switchRungDecision, LADDER_TIMED_PARK_MS, PERSON_SLOT_BY, type Rung,
} from './runner/ladder.ts';
import type { McpDegradation, PhaseRecord as RunPhaseRecord } from './runner/state.ts';
import { formatScope, scopeOfRow, scopesIntersect } from '../shared/scope.js';
import { ISOLATED, isolationMode } from '../shared/worktree-model.js';
import { branchHolderOf, readHolds, readTrees } from './runner/tree-state.ts';
import {
  KIND_PROFILE, NO_HANDOFF_AUTO_RE, VERIFICATION_AUTO_RE, isPersonErrand, isPlanHalt, isRecoveryClass, recoveryActionsFor,
} from '../shared/recovery-model.js';
import { environmentReport, probeGit, type EnvIssue } from './env-doctor.ts';
import { shell } from './shell.ts';
import { Terminals, type SessionEvent, type SessionInfo, type SessionKind } from './terminal.ts';
import { Journal } from './runner/journal.ts';
import { journalFile } from './runner/run-paths.ts';
import type { InboxPolicyAnswer, InboxSupervisorCard } from './inbox.ts';
import { DEFAULT_REVIEWER_POLICY } from './reviewer.ts';
import { lastFinishedPhase, singleFlight, ultraReviewJob } from './runner/ultrareview.ts';
import {
  FREEZE_ESCALATE_MS, escalatePersistedFreeze, freezeVerdict, frozenEntries, thawPersistedFreeze,
  type PersistedEscalation,
} from './runner/freeze.ts';
import type { LaneLiveness } from './runner/liveness.ts';
import {
  checkAvailable, ensureErrandTree, mountsFromRepos, REFUSAL_FIX, REFUSAL_REASON, type RunGitView,
} from './runner/worktree.ts';
import { appendAck as appendRulingAck, ingestRulings, readRulings, rulingsFile, type Ruling } from './runner/rulings.ts';
// FREE: the four shared owners the launch defaults are read through (phase
// 15) — the words are free vocabulary; only the engines behind them are Pro.
import { CONFLICT_POLICIES, landPolicyOf, type ConflictPolicy, type LandPolicy } from '../shared/landing-model.js';
import { MESSAGING_WORDS, type MessagingWord } from '../shared/message-model.js';
import { ISSUE_MODES, type IssueMode } from '../shared/issues-model.js';
import {
  clearBudgetHold,
  applyErrandAnswer, autoResolveRun, childrenOf, retirePhaseHalt, latestRun, listRuns, loadRun, newRun, phaseRecord, pidAlive, pidHoldsWork, procIdentity, syncWaitClock,
  reconcileRecordsAgainstBoard, resetForRetry, resetStreak, resolveRunsAgainst, retireSettledErrands, retryOverrideFrom, saveRun,
  slugsNeedingBoard, runDir, IN_FLIGHT, PHASE_IN_FLIGHT, RESOLVABLE, isMcpPolicy, mcpReasonText, setRunState,
  type BoardingBrief, type Errand, type McpPolicy, type PhaseOptions, type PreflightWarning, type RungRecord, type RunState, type RunVerifyApprovals, type VerifySummary, clearWatchBookkeeping, isSessionGone,
  journalOf, runIsOver, prepareReboard, chargeDeclaration, consumeDeclaration, DECLARATION_REFUSED_EVENT, type DeclarationCharge,
  type Actor, type PressAnswer, type PressLaunch, accountPool, type AccountChoice,
  identityChangeWords, identityEcho, keepAccountInPool, keepNotes, RUN_NOTE_MAX, type RunNote,
  dismissedByPerson, SCRIPT_BY, type RunResolution,
} from './runner/state.ts';
import {
  RECOVER_MAX_PER_PHASE, resumePolicyInstruction, resumePolicyWhy, sessionLostInstruction,
} from './runner/runner-core.ts';
import { appendRuling } from './runner/rulings.ts';
import { resumePolicy, type ResumePolicy } from './runner/usage.ts';
import { asActor, doorActor, isAutomatic, isPersonsAct, pressActor, stoppedByOf, unattributedActor, type StartActor } from './actor.ts';
import { ceilingSentence } from './start-ceiling.ts';
import {
  consumeOutcome, ignoreOutcome, inboxOutcomePhase, outcomeFileFor, outcomeInboxDir, peekWrittenAt, readOutcome,
  type OutcomeIgnoreReason, type PhaseOutcome,
  needsOf,
} from './runner/outcome.ts';
import { readTranscript, replayFor, transcriptFile, type TranscriptEntry } from './runner/transcript.ts';
import { extractCommands, resolveLead, unresolvableLeads, verifyPhase } from './runner/verify.ts';
import { loadVerifyEnv } from './runner/verify-env.ts';
import { approvalsForPhase, resolveVerifyAnswers, reviewPhase, type PhaseReview } from './runner/verify-review.ts';
import { checkAuth, checkAuthFor, forgetAuth, openLoginTerminal, openCommandTerminal, shellQuote, type AuthStatus } from './runner/auth.ts';
import { Accounts, DEFAULT_ACCOUNT_ID, profileConfigDir, type AccountView, type RunIdentity } from './accounts/index.ts';
import { Mcp, type McpServerView } from './mcp/index.ts';
import { portTranscript } from './accounts/transcripts.ts';
import { FULL_FLAGS, installDesktopLauncher, launcherPlan } from './launcher.ts';
import {
  RECOVERY_TITLES, recoveryKey,
  type RecoveryClass, type RecoveryFacts, type RecoveryRequest,
} from './recovery.ts';
import { buildAgentLaunch, phasedExecutionSkillId } from './agent.ts';
import {
  isVerdict, qaKey, qaVerdictInstruction, type QaFacts, type QaRequest,
} from './qa-session.ts';
import { nextQaRound, parseQaHistory, qaReportPath, type QaHistoryRow } from './qa-round.ts';
import {
  Approvals, classifyTool, matchedDenyRule, loadPolicy, loadPolicyFor, policyExtras, addPolicyRules,
  editPolicy, planPolicyPath, effectivePlanPolicyPath, notifyOutOfBand, carvedPolicy, suggestedRule,
  autoApproveFor, neverAutoApproves, hitsHidden,
  parseRule, inertRules, HOOK_TOOLS, WRAPPERS_NOT_STRIPPED,
  PERMISSION_PROFILES, PROFILE_LABELS,
  DEFAULT_DENY, DEFAULT_ASK, DEFAULT_ALLOW, POLICY_PATH,
  type Evidence, type PolicyScope, type PermissionProfile,
} from './runner/approvals.ts';
import {
  AUTO_GRANT_REASONS, ETA_HINT_MS, ETA_POOL_MS, ETA_SHAPE_MS, EVENT_BUFFER, HOOK_EVENTS_PER_MINUTE, HookPayloadError, HookRateError, INBOX_SOURCES, MAX_TIMER_MS, OUTCOME_INBOX_DEBOUNCE_MS, OUTCOME_INBOX_MAX_AGE_MS, OUTCOME_INBOX_SWEEP_MS, PhaseClaimedError, RecoveryBusyError, RunBusyError, UNSUPERVISED_WAIT_DEFAULT_MS, autoRecoveryClass, bucketLabel, describeExit, describeToolInput, effortOf, gitPorcelain, gitRead, lockView, modelAlias, phaseLive, ptyClaudeSessions, recoveryActions, recoveryOwner, seedSkills, situationOfHalt, titleOf, etaPhaseFacts, remainingFloors, type AutoRecoverResult, type Cached, type ControlResult, type DriveVehicle, type EtaPool, type EvidenceView, type LiveEvent, type LiveListener, type LockRelease, type PhaseDiagnosis, type PhaseLive, type PhaseLockView, type PhaseView, type PlanDetail, type PlanSummary, type QaOutcome, type RecoveryAction, type RouteView,
} from './service-core.ts';
import type { Service } from './service.ts';
import { ServiceLive } from './service-live.ts';
import { parseWhen, WAIT_DEFAULT_S, WAIT_MAX_S } from '../shared/verb-model.js';
import {
  BUDGET_KINDS, BUDGET_SETTING, BUDGET_UNITS, LADDER_RAISE_SETTINGS, RAISE_MAX, isBudgetKind, type BudgetKind,
} from '../shared/budget-model.js';
import { invalidate as invalidateEngine } from './engine.ts';
import { TriggerEngine, holds, type Observation, type RunFacts, type Trigger, type TriggerSpec } from './triggers.ts';
import { pressVerb } from './verb-press.ts';
import { factsOf, slimRun, type SlimRun } from './runs-projection.ts';

/** Where a plan's stored triggers live — beside its mailbox and its ruling ledger. */
/**
 * The phase turning QA on anchors on — one choice for both doors that do it,
 * the launch's QA box and a live run's settings (control-tower phase 13).
 * The latest phase with a handoff is the `new-handoff.sh --qa` path, which
 * backfills every completed phase as waived; a plan with no handoffs takes
 * its first phase, which records "a review was asked for and not yet
 * answered".
 */
export function qaAnchorPhase(record: PlanRecord): number {
  const phases = (record.plan?.graph ?? []).map((row) => row.phase);
  const withHandoff = phases.filter((phase) => handoffFor(record, phase));
  return withHandoff.length ? Math.max(...withHandoff) : phases.length ? Math.min(...phases) : 1;
}

export function triggersFile(root: string, slug: string): string {
  return join(runDir(root, slug), 'triggers.json');
}

/** A long poll's answer: the predicate held, or the clock ran out. */
export type WaitAnswer =
  | { status: 200; body: { held: boolean; timedOut: boolean; for: string; waitedMs: number; run: SlimRun | null } }
  | { status: 400 | 404; body: { error: string } };

/**
 * What a Resume press did (control-tower phase 77, #102): took back a pause the
 * live loop had not reached, or started a settled one again — or the refusal,
 * with its reason, when there was no pause to act on. Since control-tower phase
 * 110 (#176) a stopped run is started again the same way, so `from` names
 * whichever status it stood in.
 */
export type ResumeAnswer =
  | {
    ok: true;
    run: RunState;
    resumed: { runId: string; from: 'pausing' | ResumableStatus; act: 'pause-cancelled' | 'relaunched' };
  }
  | { ok: false; status: number; error: string };

/**
 * The settled statuses Resume starts again through the one door: a settled
 * pause (#102), and a run that stopped — parked, halted, or interrupted by its
 * console's exit (control-tower phase 110, #176). The supervisor's remedy for
 * a parked run with ready work pressed `resume`, and every press was refused.
 */
type ResumableStatus = 'paused' | 'parked' | 'halted' | 'interrupted';
const RESUMED_FROM: readonly ResumableStatus[] = ['paused', 'parked', 'halted', 'interrupted'];

/**
 * Why an AUTOMATIC press may not start this stopped run again (#176), or null.
 * A person's press lifts every one of them; a door's never does.
 */
function automaticResumeRefusal(run: RunState): string | null {
  const kind = run.halt?.kind;
  if (run.status === 'halted' && kind && PRESS_ONLY_HALT_KINDS.includes(kind)) {
    return `its ${kind} halt is lifted by a person's press, never an automatic one.`;
  }
  if (run.stoppedBy === 'operator') return 'a person stopped it, and only a person\'s press brings it back.';
  if (dismissedByPerson(run.resolved)) {
    return `a person dismissed it (${run.resolved?.by ?? 'unnamed'} at ${run.resolved?.at}), and only a person's press brings it back.`;
  }
  return null;
}

/**
 * One queued plan's ordering advice — what it would cost to let it go first.
 *
 * Every field is nullable and that is the design: an estimate exists only once
 * something of that plan has finished, and a made-up number here would be
 * indistinguishable from a measured one on the page that renders it. See
 * `ServiceRuns.queueAdvice`.
 */
export type QueueAdvice = {
  slug: string;
  /** Plan weight still to do, or null when the plan could not be read. */
  remainingWeight: number | null;
  remainingPhases: number | null;
  /** The hedged range (`~2–4 h left`), or null when nothing has finished yet. */
  label: string | null;
};

export abstract class ServiceRuns extends ServiceLive {
  /* ---------------------------------------------------------------- *
   * Runs
   * ---------------------------------------------------------------- */

  /**
   * Refuse to start work on a phase somebody else is holding.
   *
   * Only for NAMED phases. A whole-plan run that meets a claimed phase should
   * park that one and get on with the other fourteen — refusing the run would
   * let one stale-looking claim stop a plan. But "run only this phase", a
   * retry, a recovery session and a QA session all name exactly one phase, and
   * for those the claim is the whole answer.
   *
   * An EXPIRED lease is not a holder: nobody is working a phase whose claim
   * lapsed, and treating debris as an owner is the bug this rail was built
   * around (see the runner's boarding check).
   */
  private assertNotClaimed(slug: string, phases: readonly number[] | undefined): void {
    if (!phases?.length) return;
    for (const { phase, lock } of this.claimHolders(slug, phases)) {
      throw new PhaseClaimedError(slug, phase, lock);
    }
  }

  /**
   * Every phase of a plan whose lock is held by something still there.
   *
   * The one predicate behind both the refusal above and the whole-plan
   * advisory below, so a named-phase start and a Continue cannot disagree
   * about what "claimed" means.
   *
   * **`lockPresenceFor`, not `sessions.presenceOfLock`.** This was the last
   * direct caller of the raw registry answer, and it is the one that could not
   * afford it. Our own lane holds its phase lock for the WHOLE phase —
   * boarding, session, verification, closeout — while the attempt's `claude`
   * process exits well before the end of that. So `presenceOfLock` answered
   * `ended` for a lock our own run was actively holding, the `!== 'ended'`
   * test went false, nothing threw, and a retry boarded a second session onto
   * a phase this console was still verifying. That is B2(b)'s double-spawn,
   * and `retryPhase` reaches here BEFORE its live-runner branch precisely so
   * that this check is the one that catches it. `lockPresenceFor` answers
   * `unknown` for a lock owned by a run we are driving, which is the truth —
   * the session is gone, the lane is not — and `unknown` refuses.
   */
  private claimHolders(
    slug: string, phases?: readonly number[],
  ): { phase: number; lock: NonNullable<ReturnType<typeof readLock>> }[] {
    const handoffsDir = this.root?.handoffsDir;
    if (!handoffsDir) return [];
    const wanted = phases?.length
      ? phases
      : (this.store?.get(slug)?.plan?.graph ?? []).map((row) => row.phase);
    const held: { phase: number; lock: NonNullable<ReturnType<typeof readLock>> }[] = [];
    for (const phase of wanted) {
      const lock = readLock(handoffsDir, slug, phase);
      // A claim whose session the registry shows ended is debris, not a holder.
      if (lock && !lock.expired && this.lockPresenceFor(lock) !== 'ended') held.push({ phase, lock });
    }
    return held;
  }

  /**
   * What a WHOLE-PLAN start should be told about, and deliberately not refused
   * over.
   *
   * B2(b) reads "`assertNotClaimed` early-returns on empty phases so whole-plan
   * Continue never checks locks", and the fix it asks for is that those phases
   * be checked. It is not that they be refused: a foreign unexpired lock
   * QUEUES, never terminally parks — the scheduler owns that wait, names the
   * holder, shows the lease end and is woken by the docs watcher, a lease
   * timer and the idle poll (`runner-control.ts`, `LOCK_WAIT_CAP_MS`). Turning
   * one live claim into a refusal of the entire run would stop fourteen other
   * phases to protect a fifteenth the scheduler was already protecting, and
   * would contradict that invariant outright.
   *
   * So the answer is the third thing: SAY it. Same channel as the verification
   * preflight — advisory, on the start response, at the moment the operator
   * presses the button rather than an hour later when a lane is still queued.
   */
  claimPreflight(slug: string, onlyPhases?: readonly number[]): string[] {
    if (onlyPhases?.length) return [];
    return this.claimHolders(slug).map(({ phase, lock }) =>
      `phase ${phase} is claimed by ${lock.owner} — this run will queue behind that lock rather than board it`);
  }

  /**
   * A run of this plan that this console is NOT driving and whose child is
   * still holding work.
   *
   * The second half of the Continue guard. `liveRunner(slug)` answers only for
   * loops in THIS process's memory, so a second console — or this console
   * after a restart, against a session that outlived it — sailed past it and
   * created a second run over a `claude` process still editing the tree.
   *
   * Asked of the CHILD and not of the run's status word, because the status
   * word is the claim: `listRuns` settles what it reads, so an orphaned run
   * has already been rewritten to `parked` by the time we see it while its
   * child carries on. A process is a fact; a record is a claim.
   */
  protected foreignRunHoldingWork(slug: string): { runId: string; phase: number; pid: number } | null {
    const root = this.root?.path;
    if (!root) return null;
    for (const run of listRuns(root, slug, this.liveRunIds())) {
      if (run.resolved) continue;
      for (const child of childrenOf(run)) {
        if (pidHoldsWork(child.pid, procIdentity(child))) {
          return { runId: run.id, phase: child.phase, pid: child.pid };
        }
      }
    }
    return null;
  }

  /**
   * The verification REVIEW (`runner/verify-review.ts`) of every open phase —
   * the one prediction of what boarding will do, asked by every reader here:
   * the start response, the plan page's report, the launch door and the
   * repair gate. `run` supplies a live run's answers and autonomy; a launch
   * draft passes its own. A done phase is history, and is skipped.
   */
  async verificationReviews(slug: string, opts: {
    onlyPhases?: readonly number[];
    answers?: RunVerifyApprovals;
    autonomy?: string;
    run?: RunState | null;
  } = {}): Promise<PhaseReview[]> {
    const record = this.store?.get(slug);
    if (!record?.plan?.phased) return [];
    const plan = record.plan;
    const board = await this.board(slug).catch(() => null);
    const done = new Set(board?.done ?? []);
    const prefs = policyPrefsOf(this.prefs);
    const rows = mergeDecisions(plan.decisions, record.decisionsTwin);
    const answers = opts.answers ?? opts.run?.verifyApprovals;
    const verifyEnv = loadVerifyEnv(this.flags.scriptsDir);
    const out: PhaseReview[] = [];
    for (const row of plan.graph) {
      if (done.has(row.phase)) continue;
      if (opts.onlyPhases?.length && !opts.onlyPhases.includes(row.phase)) continue;
      const detail = plan.phases[row.phase];
      out.push(reviewPhase({
        phase: row.phase,
        verification: detail?.verification,
        setup: detail?.setup,
        declared: /\*\*\s*Verification\b/i.test(detail?.raw ?? ''),
        // The order `Runner.personCheckFor` resolves in: the phase's bullet,
        // then the run's manifest (or, before a run, the plan's rows), then
        // this console's word, then the shipped `operator`.
        personCheck: personCheckFor(plan, row.phase)
          ?? (opts.run
            ? policyForKey('verification.person-check', opts.run, prefs)
            : policyForPlan('verification.person-check', rows, prefs))?.answer
          ?? null,
        autonomy: opts.autonomy ?? opts.run?.autonomy ?? 'keep-going',
        approvals: approvalsForPhase(answers, row.phase),
        allowUnverified: this.prefs.allowUnverifiedPhases === true,
        preflightSkip: verifyEnv.preflightSkip,
      }));
    }
    return out;
  }

  /**
   * The boarding preflight's answer for every open phase, at the moment the
   * operator presses Start — advisory only, and the same REVIEW boarding
   * asks, so it names exactly the phases boarding will park and why. It used
   * to ask a weaker question ("is anything runnable at all?") and called a
   * plan fine that parked at its phase 2 (run f0da619a).
   */
  async verificationPreflight(slug: string, onlyPhases?: number[]): Promise<string[]> {
    const reviews = await this.verificationReviews(slug, { onlyPhases });
    return reviews.filter((review) => review.verdict === 'parks').map((review) => review.park!);
  }

  /**
   * The boarding preflight's findings for every open phase, STRUCTURED — the
   * same review boarding asks, computed on demand so a plan page can badge
   * "N commands cannot run here" BEFORE any money is spent. The journal-only
   * string twin of this data predicted the dominant halt class 44 times and
   * was rendered by nothing. Under `Person-check: halt` a refused command now
   * reads "will PARK the run", not "a person may be asked" — the second was
   * the promise boarding broke.
   */
  async verifyPreflightReport(slug: string): Promise<
    { phases: { phase: number; warnings: PreflightWarning[] }[]; computedAt: string } | null
  > {
    const record = this.store?.get(slug);
    if (!record?.plan?.phased) return null;
    const verifyEnv = loadVerifyEnv(this.flags.scriptsDir);
    const phases: { phase: number; warnings: PreflightWarning[] }[] = [];
    for (const review of await this.verificationReviews(slug)) {
      const detail = record.plan.phases[review.phase];
      const warnings: PreflightWarning[] = [];
      const answerOf = (item: PhaseReview['items'][number]) => ({
        ...(item.fp ? { fp: item.fp } : {}),
        approvable: item.approvable === true,
      });
      if (!review.runs.length && review.verdict === 'parks') {
        warnings.push({
          kind: 'nothing-runnable',
          parks: true,
          message: /\*\*\s*Verification\b/i.test(detail?.raw ?? '')
            ? 'its §Verification yields nothing the runner can execute — it will park at boarding'
            : 'it has no §Verification — it will park at boarding',
        });
      } else if (review.verdict === 'parks' && !review.missing.length) {
        for (const held of review.items) {
          warnings.push({
            kind: 'human-check', command: held.text, parks: true, ...answerOf(held),
            message: `will PARK the run at boarding (Person-check: halt): ${held.text} — ${held.reason}`,
          });
        }
      } else {
        for (const held of review.items) {
          warnings.push({
            kind: 'human-check', command: held.text, ...answerOf(held),
            // "may", not "will": whether the card is actually raised depends
            // on the run's autonomy and on what else proves the phase —
            // `halt-on-everything` always asks, `keep-going` only when no
            // machine evidence backs the board. This probe has no run yet.
            message: `a person may be asked: ${held.text} — ${held.reason} `
              + '(asks only if nothing else proves the phase)',
          });
        }
        for (const lead of review.missing) {
          warnings.push({
            kind: 'missing-lead', lead,
            ...(review.verdict === 'parks' ? { parks: true } : {}),
            message: `\`${lead}\` is not installed here — its command will be SKIPPED at verification`,
          });
        }
        if (review.runs.length && !/\*\*\s*Verify in:?\*\*/i.test(detail?.raw ?? '')) {
          const sensitive = review.runs.filter((command) => {
            if (/^cd\s/.test(command.trim())) return false;
            const lead = resolveLead(command);
            return lead ? verifyEnv.cwdSensitive.has(lead) : false;
          });
          if (sensitive.length) {
            warnings.push({
              kind: 'cwd-unpinned',
              message: `${sensitive.length} command(s) are cwd-sensitive and the phase declares no `
                + '**Verify in:** — they run at the repository root',
            });
          }
        }
      }
      if (warnings.length) phases.push({ phase: review.phase, warnings });
    }
    return { phases, computedAt: new Date().toISOString() };
  }

  /**
   * Start or continue a run. Whether the plan is fresh or half-finished is not
   * a distinction the caller has to make — the engine derives ready phases from
   * the done-set, so both are the same code path.
   */
  async startRun(slug: string, options: Partial<StartOptions> = {}): Promise<RunState> {
    if (!this.flags.allowRun) throw new Error('Runs are disabled. Restart with --allow-run to enable them.');
    if (!this.root?.ok) throw new Error('No source directory is open.');
    const record = this.store?.get(slug);
    if (!record) throw new Error(`No plan named ${slug}.`);
    if (!record.plan?.phased) throw new Error(`${slug} has no phase graph — there is nothing to run.`);
    // The one concurrency that is never safe: two loops driving one phase
    // graph. `Runner.start` throws on its own second call, so this is the
    // message rather than the guard — but a bare "a run is already in
    // progress" would now be read as "the console is busy", which is exactly
    // the thing that stopped being true.
    if (this.liveRunner(slug)) {
      throw new Error(
        `${slug} is already running in this console. Pause or stop it first — `
        + 'another plan can start beside it, but one plan cannot run twice.');
    }
    // ...and the same refusal for a loop this console CANNOT see. The check
    // above reads `this.runners`, which is memory: a second console, or this
    // console after a restart against a session that outlived it, walked
    // straight past it and created a second run over a live `claude` process.
    // The button then answered 200 and two agents wrote one working tree —
    // the exact concurrency the whole lock system exists to prevent, reached
    // by the one door that never asked.
    const foreign = this.foreignRunHoldingWork(slug);
    if (foreign) {
      throw new Error(
        `${slug} phase ${foreign.phase} is still being worked by a live session (pid ${foreign.pid}, `
        + `run ${foreign.runId}) that this console is not driving. Stop it — or wait for it — before `
        + 'starting another run: two sessions on one working tree is what this refuses.');
    }
    // Before anything is written or minted. A claimed phase used to be
    // discovered inside the runner, after a run existed and the console had
    // already reported success.
    this.assertNotClaimed(slug, options.onlyPhases);

    // `auto` resolves here, once, against the cached meters — the run then
    // carries a concrete id, so the journal and the header say which account
    // is paying rather than "whatever looked best at some point".
    if (options.accountId === 'auto') {
      options = { ...options, accountId: this.accounts.pickAccount(null, options.model) ?? DEFAULT_ACCOUNT_ID };
    }
    // The account the run will ACTUALLY pay with, resolved in ONE place (ACT-1):
    // an explicit option is an override; a resume without one keeps the stored
    // run's account; a fresh start without one is the machine login. Nine of
    // the twelve automatic doors omitted the field, so the quota and auth doors
    // judged the machine login while the runner resumed under
    // `state.accountId` — wrong in both directions. Every door now passes
    // through this line, and `test/invariants.test.ts` holds a site that
    // passes neither `accountId` nor `resumeRunId` to naming its reason.
    if (options.accountId === undefined && options.resumeRunId) {
      const stored = loadRun(this.root.path, slug, options.resumeRunId, null);
      if (stored?.accountId) options = { ...options, accountId: stored.accountId };
    }
    // The QUOTA door is the runner's now (`RunnerDeps.accountHeadroom` →
    // `preflightAccount`), climbed beside the auth door inside `Runner.start`
    // where the run exists to be switched or parked — a refusal here used to
    // be an exception the automatic callers swallowed (ACT-2).

    // THE PRELUDE (phase 11, ZTD-2/QRL-2): the decision manifest rendered and
    // probes run before any spend, for a FRESH run — a resume answered
    // at its own door and its stored fields stand. A blocking row still
    // `outstanding`, an unacknowledged waiver or a failed blocking probe
    // refuses the start (`PreludeRefusal` → 409 at the route, every entry
    // listed); the one way past it is a recorded override. What resolved
    // rides into `Runner.start` and is echoed on `run.start`.
    // The plan's own human steps it could not pre-clear are asked for just
    // before the runner starts (`askAtTheDoor`, control-tower phase 44).
    let doorSteps: PreludeStep[] = [];
    if (!options.resumeRunId) {
      const prelude = await this.prelude(slug, options);
      if (prelude.blocking.length && !options.manifestOverride) throw new PreludeRefusal(prelude);
      doorSteps = prelude.humanSteps;
      // Probe 7's rows (control-tower phase 11, #18): every plan git line this
      // launch will not honour is answered before anything spawns. The launch
      // form answers for a person (`gitStrategyAck`, required from that door);
      // every other door — converge, a boot sweep, a webhook, `bin/` — answers
      // `override` for itself and the run journals it, because an unattended
      // door waiting on a person is how a run stalls where nobody looks.
      const gitLines = ((prelude.probes['git-strategy']?.detail as { lines?: GitStrategyLine[] } | undefined)?.lines ?? []);
      if (gitLines.length) {
        const ack = options.gitStrategyAck;
        if (!ack && options.gitStrategyAckRequired) throw new GitStrategyRefusal(gitLines, null);
        if (ack === 'honour') {
          const cannot = gitLines.filter((line) => !line.honourable);
          if (cannot.length) throw new GitStrategyRefusal(cannot, 'honour');
          // Every honourable line is one a checkout of the run's own makes
          // hold: `Worktrees: on` in a plain repository, `Checkout: main`.
          options = { ...options, isolation: ISOLATED };
        } else {
          options = {
            ...options,
            gitStrategyOverride: {
              lines: gitLines.map(({ kind, plan: said, run, phases: named }) => ({ kind, plan: said, run, ...(named ? { phases: named } : {}) })),
              ack: ack ?? 'automatic', ...(options.actor?.by ? { by: options.actor.by } : {}), at: new Date().toISOString(),
            },
          };
        }
      }
      const override = options.manifestOverride
        ? { rows: prelude.blocking.map((b) => b.key), by: options.manifestOverride.by }
        : null;
      options = {
        ...options,
        manifest: resolvedManifest(prelude, override),
        // The answers as the prelude resolved them, so a start that left one
        // out is stored with the default it ran under (the manifest says
        // `source: default` for it).
        resumeOnRestart: options.resumeOnRestart ?? (prelude.rows.find((r) => r.key === 'resume.on-restart')?.value !== 'hold'),
        relay: options.relay ?? (prelude.rows.find((r) => r.key === 'relay')?.value === 'last-resort' ? 'last-resort' : 'off'),
        accounts: prelude.accounts,
        acknowledgedWaivers: prelude.acknowledged,
        ...(override && prelude.blocking.length ? { manifestOverride: { rows: override.rows, by: override.by } } : { manifestOverride: undefined }),
        // The draft's §Verification answers as the prelude resolved them —
        // exact texts, signed — and never the raw draft: an fp that named no
        // approvable command answered nothing and is not carried.
        verifyApprovals: prelude.verifyApprovals
          ? { ...prelude.verifyApprovals, by: options.actor?.by ?? 'operator', at: prelude.at }
          : undefined,
      };
    }

    // QA on launch, resolved BEFORE the runner starts so the run's first board
    // read already sees gating. The preference speaks only for a fresh run — a
    // resume is not a new launch decision — and an explicit `qa: false` beats
    // the preference, so unticking the box means what it says.
    const wantQa = options.qa ?? (options.resumeRunId ? false : this.prefs.qaByDefault ?? false);
    if (wantQa && (await this.qaMode(slug)).mode === 'off') {
      if (!this.flags.allowWrites) {
        throw new Error(
          'QA on launch needs --allow-writes: turning QA on writes test-status.md. '
          + 'Start without QA, or restart the console with --allow-writes.');
      }
      const turned = await this.activateQa(slug, qaAnchorPhase(record));
      if (!turned.ok) throw new Error(`Could not turn QA on for ${slug}: ${turned.detail}`);
    }

    // The machine's default skills are an opt-in now, not a side effect. On a
    // fresh run the attach choice (per-launch, else the preference) decides
    // whether they ride along with whatever was picked; a resume passes the
    // picked list through untouched — the run's sticky list rules, and prefs
    // never re-seed a half-finished run. `seedSkills`' contract is unchanged
    // for its other callers: an explicit empty list still means none.
    const attach = options.attachDefaultSkills
      ?? (options.resumeRunId ? false : this.prefs.attachDefaultSkills ?? false);
    const skills = attach
      ? [...new Set([...this.flags.defaultSkills, ...(options.skills ?? [])])]
      : options.skills;

    // Auto-recovery seeds like QA above: the preference speaks only for a
    // fresh run — a resume keeps the run's own sticky choice — and an explicit
    // false beats it, so unticking the box means what it says.
    const autoRecover = options.autoRecover
      ?? (options.resumeRunId ? undefined : this.prefs.autoRecoverByDefault !== false);

    // And the MCP policy the same way again: the preference is where a fresh
    // run starts, a resume keeps whatever the run already decided (including a
    // `continue` set from a halt card, which must not be undone by a restart),
    // and an explicit choice in the dialog beats both.
    const mcpPolicy = options.mcpPolicy
      ?? (options.resumeRunId ? undefined : this.prefs.mcpPolicy ?? 'continue');

    // Isolation resolves here rather than only in the launch dialog, which is
    // the difference between "the operator's preference" and "the preference
    // of whoever happened to use the form". Every other door into `startRun` —
    // converge's resume, a boot sweep, `bin/`, a webhook — omits the field, and
    // omitting it must mean the preference and not a silent `queue`.
    //
    // The two rules above hold unchanged: a RESUME is sticky (the run's own
    // choice rules, and `runner-control` will not let a resume mint isolation
    // anyway), and an explicit value in the dialog beats the preference. The
    // extra `gitMode` clause is not belt-and-braces — `newRun` already refuses
    // to write isolation without a branch — it is so the two never disagree
    // about what was asked for when someone reads the start options back.
    const isolation = options.isolation
      ?? (options.resumeRunId || options.gitMode !== 'new-branch'
        ? undefined
        : isolationMode(this.prefs.isolation));

    // Every door names its actor and the lint holds them to it; a harness
    // calling `startRun` bare is recorded as `unattributed`, never as a door.
    const actor = options.actor ?? unattributedActor('Service.startRun');
    // The one bound over the SUM of the fourteen doors (SLF-1). Asked here,
    // after every other refusal — a claimed phase or a foreign session never
    // spends a slot — and charged only once the runner has actually started.
    const admitted = this.admitStart(actor, slug, options.resumeRunId ?? null);
    if (!admitted.ok) throw new Error(ceilingSentence(admitted));
    // Phase 15's four launch defaults resolve by isolation's rule exactly: an
    // explicit word in the dialog beats the preference, a fresh run that says
    // nothing takes the preference, and a RESUME keeps the run's own sticky
    // word. Every other door into `startRun` omits them, and omitting must
    // mean the preference rather than a silent vocabulary default. (The
    // plan's own line still outranks whatever the run carries — the runner
    // reads the plan first and the run's word only where it is silent.)
    const fresh = !options.resumeRunId;
    const landing = options.landing ?? (fresh ? landPolicyOf(this.prefs.landing) as LandPolicy : undefined);
    const conflictPolicy = options.conflictPolicy
      ?? (fresh && CONFLICT_POLICIES.includes(this.prefs.conflictPolicy as never)
        ? this.prefs.conflictPolicy as ConflictPolicy : undefined);
    const messaging = options.messaging
      ?? (fresh && MESSAGING_WORDS.includes(this.prefs.messaging as never)
        ? this.prefs.messaging as MessagingWord : undefined);
    const issuesMode = options.issuesMode
      ?? (fresh && ISSUE_MODES.includes(this.prefs.issuesMode as never)
        ? this.prefs.issuesMode as IssueMode : undefined);

    // The launch door's asks (control-tower phase 44): every plan-declared step
    // the prelude could not pre-clear is recorded now — born `plan`, one push
    // each — after every refusal the door can still make, before anything spawns.
    this.askAtTheDoor(slug, doorSteps);
    const state = await this.runnerFor(slug).start({
      ...options,
      actor,
      autoRecover,
      mcpPolicy,
      isolation,
      landing,
      conflictPolicy,
      messaging,
      issuesMode,
      skills,
      slug,
      root: this.root.path,
    });
    this.startCeiling.charge(actor, slug);
    this.emit('run:state', { state });
    return state;
  }

  /**
   * The run-start prelude for a plan (phase 11): the manifest rendered, the
   * probes run, the blocking list computed — over the console's live
   * facades. `GET /api/run/:slug/prelude` serves it for the launch form's
   * draft (the form's answers ride in as `options`); `startRun` runs it again
   * at the door. Pure in `prelude.ts`; this is the deps builder.
   */
  /**
   * Record the plan's owed human steps at the launch door (control-tower phase
   * 44): each one the prelude did not pre-clear becomes a ledger step born
   * `plan`, announced once — unless an open step of this plan already asks
   * for the same act on the same phase, so a second launch does not ask twice.
   * A step born here never parks its phase (nothing has spawned yet), so the
   * reminder clock withdraws it only when that phase closes.
   */
  private askAtTheDoor(slug: string, steps: readonly PreludeStep[]): void {
    let open: HumanStep[] = [];
    try { open = this.humanStepsNow().open().filter((step) => step.slug === slug && step.birth === 'plan'); } catch { open = []; }
    for (const step of steps) {
      if (step.state === 'pre-cleared') continue;
      if (open.some((held) => held.phase === step.phase && held.kind === step.kind && held.title === step.what.trim())) continue;
      this.recordHumanStep({
        slug, phase: step.phase, birth: 'plan',
        step: {
          kind: step.kind, title: step.what, where: step.where,
          ...(step.open && 'url' in step.open ? { open_url: step.open.url } : {}),
          ...(step.open && 'command' in step.open ? { open_command: step.open.command } : {}),
          ...(step.proof ? { proof: step.proof } : {}),
          ...(step.windowMinutes !== undefined ? { windowMinutes: step.windowMinutes } : {}),
          ...(step.autoOpen ? { auto_open: step.autoOpen } : {}),
          ...(step.credential ? { credential: step.credential } : {}),
          // Upcoming until its ref lands (control-tower phase 121).
          ...(step.due ? { due_when: step.due } : {}),
        },
      });
    }
  }

  async prelude(slug: string, options: PreludeOptions = {}): Promise<Prelude> {
    const record = this.store?.get(slug);
    const root = this.root?.path;
    if (!record?.plan || !root) throw new Error(`No plan named ${slug}.`);
    const plan = record.plan;
    const phases = plan.graph.map((r) => r.phase);
    const union = (per: (phase: number) => string[]) => [...new Set(phases.flatMap((p) => per(p)))];
    const deps: PreludeDeps = {
      decisions: () => ({
        rows: mergeDecisions(plan.decisions, record.decisionsTwin),
        present: plan.decisions.length > 0 || record.decisionsTwin.length > 0,
      }),
      planAccounts: () => plan.sessionBudget.accounts.map((a) => ({ id: a.id, minHeadroomPct: a.minHeadroom ?? 0 })),
      planCredentials: () => ({
        ids: union((p) => credentialsFor(plan, p)),
        policy: plan.sessionBudget.credentialPolicy ?? null,
      }),
      planMcp: () => ({
        ids: union((p) => mcpServersFor(plan, p)),
        policy: plan.sessionBudget.mcpPolicy ?? null,
      }),
      accounts: {
        defaultId: DEFAULT_ACCOUNT_ID,
        has: (id) => this.accounts.has(id),
        authStateFor: (id) => this.accounts.authStateFor(id),
        entitlementOf: (id) => this.accounts.entitlementOf(id),
        headroom: (id, model) => this.accounts.headroom(id, model),
        labelFor: (id) => this.accounts.labelFor(id),
      },
      mcp: { preflight: (ids) => this.mcp.preflight(ids, { cwd: root }) },
      credentials: { held: (ids) => credentialsHeld(ids, { cwd: root }) },
      delivery: async () => {
        const remote = (this.flags.remoteHosts?.length ?? 0) > 0;
        let tailscale: DeliveryFacts['tailscale'] = null;
        if (remote) {
          try {
            const status = await tailscaleStatus(this.flags.port);
            tailscale = status.state === 'running'
              ? { running: true, forOurPort: status.serve.forOurPort }
              : { running: false, forOurPort: false };
          } catch { tailscale = { running: false, forOurPort: false }; }
        }
        return {
          devices: this.push.list().length,
          notifyCommand: Boolean(notifyCommand()),
          webhooks: this.webhooks.list().length,
          remote,
          tailscale,
        };
      },
      // Probe 5: the verification review of every open phase — the same one
      // boarding asks — under the draft's answers, resolved to exact texts.
      verification: async () => {
        const autonomy = options.autonomy;
        const bare = await this.verificationReviews(slug, { ...(autonomy ? { autonomy } : {}) });
        const answers = resolveVerifyAnswers(bare, options.verifyAnswers);
        const reviews = answers
          ? await this.verificationReviews(slug, { ...(autonomy ? { autonomy } : {}), answers })
          : bare;
        return { reviews, scope: options.onlyPhases?.length ? options.onlyPhases : null, ...(answers ? { answers } : {}) };
      },
      trees: async () => {
        // Probe 6 (control-tower phase 40, #41): the plan's repositories as
        // the SHARED checkout has them, against every standing hold — and
        // whether this run would be isolated from them, by the launch door's
        // own defaults when the draft does not say.
        const scope = union((p) => scopeOfRow(plan.graph.find((row) => row.phase === p)?.repos ?? ''));
        const trees = await readTrees(root, scope);
        const self = { run: '', slug };
        const held = [];
        for (const tree of trees) {
          const view = branchHolderOf([tree], readHolds(), self, {});
          if (view) held.push({ repo: view.repo, branch: view.branch, run: view.run, slug: view.slug });
        }
        const gitMode = options.gitMode;
        const isolation = options.isolation ?? isolationMode(this.prefs.isolation);
        const preview = held.length ? await this.isolationPreflight(slug).catch(() => null) : null;
        return {
          held,
          isolated: gitMode === 'new-branch' && isolation === ISOLATED && preview?.available !== false,
          grantable: preview ? preview.available : null,
          ...(preview && !preview.available && preview.refusal ? { refusal: preview.refusal } : {}),
        };
      },
      gitStrategy: async () => {
        // Probe 7 (control-tower phase 11, #18): the plan's git lines against
        // the strategy this launch would run under — by the launch door's own
        // defaults when the draft does not say, exactly as probe 6 reads it.
        const gitMode = options.gitMode;
        const isolation = options.isolation ?? isolationMode(this.prefs.isolation);
        return {
          ...(gitMode ? { gitMode } : {}),
          runBranch: `pe/${slug}`,
          isolated: gitMode === 'new-branch' && isolation === ISOLATED,
          superproject: existsSync(join(root, '.gitmodules')),
          ...(plan.sessionBudget.branch ? { planBranch: plan.sessionBudget.branch } : {}),
          planWorktrees: plan.sessionBudget.worktrees === 'on',
          checkoutPhases: phases.filter((p) => wantsDefaultCheckout(plan.phases[p]?.checkout)).sort((a, b) => a - b),
        };
      },
      // Probe 8 (control-tower phase 98, #151): this console's interface pair,
      // and the plugin copy each account the run may spend would load — one
      // row per config dir, however many accounts share it.
      skillApi: (accountIds) => {
        const consoleApi = readSkillApi(this.flags.scriptsDir);
        const copies = new Map<string, SkillApiFacts['copies'][number]>();
        for (const id of accountIds) {
          const copy = sessionSkillCopy(this.accounts.configDirFor(id));
          if (!copy || copies.has(copy.configDir)) continue;
          const installPath = copy.install?.installPath ?? null;
          const api = installPath ? readSkillApi(join(installPath, 'scripts')) : null;
          copies.set(copy.configDir, { configDir: copy.configDir, installPath, api, mismatch: skillApiVerdict(consoleApi, api) });
        }
        return { console: consoleApi, copies: [...copies.values()] };
      },
      // Probe 9 (control-tower phase 44): the plan's own human steps for the
      // phases this run will drive, each proof run NOW through the watch
      // clock's one-ref probe — the check verb's own, so a `cmd:` proof is
      // judged here exactly as it is later — and a sign-in is asked for at
      // the door, not at three in the morning.
      humanSteps: async () => {
        const done = (await this.board(slug).catch(() => null))?.done ?? [];
        // The plan's own acts (`## Operator errands`, phase 0 — control-tower
        // phase 121) are asked of every run, scoped or not: no phase owns them.
        return [
          ...humanStepsFor(plan, 0).map((step) => ({ phase: 0, step })),
          ...scopedSteps((phase) => humanStepsFor(plan, phase), phases, { onlyPhases: options.onlyPhases, done }),
        ];
      },
      probeStep: async (ref) => {
        const verdict = await this.watchClock.probeNow(ref);
        return { landed: verdict.state === 'landed', read: `${verdict.state}${verdict.detail ? ` — ${verdict.detail}` : ''}` };
      },
      prefs: policyPrefsOf(this.prefs),
    };
    return preludeFor(slug, options, deps);
  }

  /**
   * `phase-console doctor`'s report, answered by THIS console (phase 11): the
   * prelude's four plan-free probes over the live facades (the fifth, verification, needs a plan),
   * and the machine rows read here. `GET /api/doctor` serves it; the CLI
   * prefers it to its own off-line reading whenever a console answers.
   */
  async doctor(): Promise<DoctorReport> {
    const root = this.root?.path;
    const instance: DoctorInstance = {
      id: INSTANCE.id, name: INSTANCE.name, root: INSTANCE.root ?? null, port: this.flags.port, default: INSTANCE.default,
    };
    const label = unitName({ id: INSTANCE.id, default: INSTANCE.default });
    const deps: DoctorDeps = {
      instance,
      mode: 'console',
      accounts: async () => {
        const ids = [...new Set([DEFAULT_ACCOUNT_ID, ...this.accounts.accountIds()])];
        return probeAccounts(ids.map((id) => ({
          id, minHeadroomPct: 0, registered: true, label: this.accounts.labelFor(id),
          authState: this.accounts.authStateFor(id), entitlement: this.accounts.entitlementOf(id),
          headroom: this.accounts.headroom(id),
        })));
      },
      mcp: async () => {
        const ids = this.mcp.enabledIds();
        if (!ids.length) return skipped('no MCP server registered');
        const result = await this.mcp.preflight(ids, root ? { cwd: root } : {});
        return probeMcp(ids, 'continue', result);
      },
      credentials: async () => probeCredentials(['claude'], 'require', await credentialsHeld(['claude'], root ? { cwd: root } : {})),
      delivery: async () => {
        const remote = (this.flags.remoteHosts?.length ?? 0) > 0;
        let tailscale: { running: boolean; forOurPort: boolean } | null = null;
        if (remote) {
          try {
            const status = await tailscaleStatus(this.flags.port);
            tailscale = status.state === 'running' ? { running: true, forOurPort: status.serve.forOurPort } : { running: false, forOurPort: false };
          } catch { tailscale = { running: false, forOurPort: false }; }
        }
        const verdict = probeDelivery({
          devices: this.push.list().length, notifyCommand: Boolean(notifyCommand()),
          webhooks: this.webhooks.list().length, remote, tailscale,
        });
        return { status: verdict.status, ok: verdict.ok, reason: verdict.reason, ...(verdict.warnings ? { warnings: verdict.warnings } : {}) };
      },
      hooks: async () => this.hooksStatus(),
      // Every pooled account's config dir, not the login's alone (#194).
      presence: async () => this.presenceByAccount(),
      skillCopy: () => this.skillCopy(),
      unit: async () => {
        let facts: UnitFacts | null = null;
        return facts;
      },
      cliVersion: () => cliVersion(),
      gh: async () => {
        const [verdict] = await credentialsHeld(['gh'], root ? { cwd: root } : {});
        return { status: verdict.status, ok: verdict.status !== 'fail', reason: verdict.reason };
      },
      publish: () => this.flags.allowPublish === true,
      // Under the CONSOLE's own environment, which under a launch agent is a
      // different PATH from a person's shell — that difference IS errand E7.
      git: () => probeGit(
        async (file, args, opts) => {
          const run = await shell(file, args, {
            channel: 'shell',
            intent: 'doctor git probe',
            ...(opts?.cwd ? { cwd: opts.cwd } : {}),
            timeout: 10_000,
            // A non-zero exit is this probe's ANSWER — an unaccepted Xcode
            // licence exits 69 — so it must not surface as an `info` fault.
            expectFailure: true,
          });
          return { code: run.code, stdout: run.stdout, stderr: run.stderr };
        },
        root ?? null,
      ),
      environment: () => this.environment.issues,
      console: async () => ({ healthy: degradedState().healthy, serverStale: serverIsStale(), version: distRev() ? `built at ${distRev()}` : undefined }),
    };
    return doctorReport(deps);
  }

  /**
   * The id the loop is actually driving right now, or null.
   *
   * Every read of a run passes through this. A status of `running` on disk is a
   * claim by a process that may have been killed since; only this answers
   * whether anything is behind it, and reads that skip it report corpses as
   * live runs — which is precisely what a Stop button then fails to stop.
   */
  protected liveRunId(): Set<string> {
    return this.liveRunIds();
  }

  /**
   * The run driving THIS plan right now, or null.
   *
   * Every caller was written against "the run for this slug" rather than "the
   * run" precisely so the pool could replace the body without touching one of
   * them. This is that replacement.
   */
  protected drivingRun(slug: string): RunState | null {
    return this.liveRunner(slug)?.current() ?? null;
  }

  /**
   * This console's own issue word — Settings ▸ Issues ▸ "File problems a run
   * finds outside its phase" (control-tower phase 115) — which a run with no
   * word of its own files under, and which the tighten-only rule therefore
   * reads that run as (`issuesModeLoosens`). `undefined` where there is none:
   * the rule reads that as `off`.
   */
  consoleIssueWord(): string | undefined {
    let word: string | undefined;
    return word;
  }

  /** The live run if there is one, otherwise the last one recorded on disk. */
  /**
   * The run read paths, board-aware.
   *
   * `loadRun` already reconciles a run whose writer died (`reconcileRun`); this
   * is the second half of the same idea — a stopped run whose phases the board
   * has since finished stops asking for a person. Both corrections happen on
   * read and are written back once, so nothing has to remember to do it later.
   *
   * The board read is why these are async: the classification comes from the
   * engine, which is a process. It is cached per plan revision, so a fleet of
   * two hundred runs across twelve plans costs twelve cache hits.
   */
  async runFor(slug: string): Promise<RunState | null> {
    const live = this.runners.get(slug)?.current();
    if (live && live.slug === slug) return live;
    if (!this.root) return null;
    const state = latestRun(this.root.path, slug, this.liveRunId());
    return state ? (await this.resolveAgainstBoard([state]))[0] : null;
  }

  /**
   * What every in-flight lane of this plan looks like right now.
   *
   * A live runner answers from its own lanes; without one, the records' own
   * snapshots are the honest fallback — stale by construction, and labelled as
   * such by the status they sit beside. Answering with nothing instead would
   * make a lane a console restart killed indistinguishable from a phase that
   * never started, which is the one thing this feature exists to prevent.
   */
  runLiveness(slug: string, state: RunState | null): LaneLiveness[] {
    const live = this.liveRunner(slug);
    if (live) return live.liveness();
    return Object.values(state?.phases ?? {})
      .filter((record) => record.liveness && PHASE_IN_FLIGHT.includes(record.status))
      .map((record) => record.liveness!)
      .sort((a, b) => a.phase - b.phase);
  }

  /**
   * Where this run's work is, and what it collides with — or `null`.
   *
   * Read from the live runner's CACHE and never probed here, which is the
   * whole design: `git worktree list`, a `du` per checkout and a `merge-tree`
   * per branch pair is a handful of subprocesses, and a run page open in two
   * tabs polls this endpoint. The runner refreshes on the events that move it
   * (a lane landing, a phase settling) with a five-minute floor, and pushes
   * `run:git` when the answer changes, so a reader is never the thing that
   * pays for the answer.
   *
   * `null` for three different situations that all mean the same thing to a
   * surface — a shared run, a run nobody is driving, and a run whose isolation
   * was refused. That is deliberate: the Git card is a statement about a
   * checkout of one's own, and there is nothing honest to say without one.
   */
  runGit(slug: string): RunGitView | null {
    return this.liveRunner(slug)?.gitSnapshot() ?? null;
  }

  /**
   * Every live run that has a checkout of its own, with the three facts about
   * the RUN that the probe itself does not carry.
   *
   * One gather, two readers: the inbox's conflict rows and `/api/metrics`'s
   * three worktree families. They must not each walk the runners, because the
   * radar is repository-wide — two readers taking two snapshots would let a
   * scrape and a card disagree about a conflict that resolved between them,
   * and "the numbers and the pages can never disagree" is the property
   * `analysis/metrics.ts` was built around.
   *
   * Reads the same CACHE `runGit` reads and probes nothing, so it is as cheap
   * as the poll it rides on. A run with no snapshot yet — every shared run,
   * and an isolated one in the seconds before its first probe — contributes
   * nothing at all rather than an empty view.
   */
  runGitFacts(): {
    slug: string; branch?: string; startedAt?: string; isolation?: string;
    checkout?: string; isolationRefusal?: string; mounts?: string[]; view: RunGitView;
  }[] {
    const out: {
      slug: string; branch?: string; startedAt?: string; isolation?: string;
      checkout?: string; isolationRefusal?: string; mounts?: string[]; view: RunGitView;
    }[] = [];
    for (const runner of this.liveRunners()) {
      const view = runner.gitSnapshot();
      const state = runner.current();
      if (!view || !state?.slug) continue;
      out.push({
        slug: state.slug,
        // The BRANCH the view measured, not `state.branch`: it is what the
        // radar's participants are spelled with, and a pair can only be traced
        // back to a run through the same string the probe used.
        ...(view.branch ? { branch: view.branch } : {}),
        // `createdAt` is the RUN's own clock — a `RunState` has no `startedAt`
        // (that word belongs to a PhaseRecord and to a lane's `ChildRef`, and
        // either would answer "when did this phase board", not "which of these
        // two runs is the younger").
        ...(state.createdAt ? { startedAt: state.createdAt } : {}),
        ...(state.isolation ? { isolation: state.isolation } : {}),
        // The OUTCOME beside the ask (D-C): surfaces used to show
        // `isolation: worktree` with nothing saying the checkout was refused.
        ...(state.checkout ? { checkout: state.checkout } : {}),
        ...(state.isolationRefusal ? { isolationRefusal: state.isolationRefusal } : {}),
        ...(state.mountedRepos?.length ? { mounts: state.mountedRepos } : {}),
        view,
      });
    }
    return out.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /**
   * The runs that ASKED for their own checkout and were refused — the shape
   * `runGitFacts` cannot carry, because a refused run arms no git probe and
   * has no view. The inbox reads this to raise the one row an operator needs
   * (G3): you ticked the box, the console said no, and here is why.
   */
  refusedIsolationFacts(): {
    slug: string; isolation: string; checkout: string;
    isolationRefusal?: string; refusalReason?: string; startedAt?: string;
  }[] {
    const out: {
      slug: string; isolation: string; checkout: string;
      isolationRefusal?: string; refusalReason?: string; refusalFix?: string; refusalDetail?: string;
      parked?: boolean; startedAt?: string;
    }[] = [];
    for (const runner of this.liveRunners()) {
      const state = runner.current();
      if (!state?.slug || state.isolation !== ISOLATED || state.checkout !== 'refused') continue;
      out.push({
        slug: state.slug,
        isolation: state.isolation,
        checkout: state.checkout,
        ...(state.isolationRefusal ? {
          isolationRefusal: state.isolationRefusal,
          refusalReason: REFUSAL_REASON[state.isolationRefusal],
          refusalFix: REFUSAL_FIX[state.isolationRefusal],
        } : {}),
        ...(state.isolationRefusalDetail ? { refusalDetail: state.isolationRefusalDetail } : {}),
        // Parked on it (control-tower phase 90), or running shared after a
        // structural refusal — the row says which, and offers the repair only
        // where one exists.
        ...(state.halt?.kind === 'isolation-refused' ? { parked: true } : {}),
        ...(state.createdAt ? { startedAt: state.createdAt } : {}),
      });
    }
    return out.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /**
   * The plan's whole ruling ledger, oldest first.
   *
   * Read from the FILE rather than from a run, so it answers before any run
   * exists and keeps answering after every run of the plan has been deleted: a
   * decision made in phase 3 is still the reason phase 9 looks the way it does.
   */
  runRulings(slug: string): Ruling[] {
    if (!this.root?.ok) return [];
    const file = rulingsFile(this.root.path, slug);
    // Keyed on the file's own mtime+size rather than a clock: the inbox reads
    // EVERY plan's ledger on every render, so on this hub that was 121 whole
    // NDJSON files parsed per open of a panel, and a ledger changes when a
    // session appends to it and at no other time. A file that cannot be
    // stat'd is read as before — the miss is the safe direction.
    let stamp: string;
    try {
      const info = statSync(file);
      stamp = `${info.mtimeMs}:${info.size}`;
    } catch {
      // No ledger is the common case and its answer is empty; cache that too,
      // so a plan that has never recorded a ruling costs one `stat`.
      stamp = 'absent';
    }
    const hit = this.rulingsCache.get(slug);
    if (hit && hit.stamp === stamp) return hit.rulings;
    const rulings = stamp === 'absent' ? [] : readRulings(file);
    this.rulingsCache.set(slug, { stamp, rulings });
    return rulings;
  }


  /** How much of a run's journal the policy rows read — the timeline's bound, a tenth of it. */
  private static readonly POLICY_JOURNAL_TAIL = 2_000;

  /** Each run's answers read from its journal, keyed on the journal file's stamp. */
  private readonly policyAnswersCache = new Map<string, { stamp: string; answers: InboxPolicyAnswer[] }>();

  /**
   * What the policy table answered by itself in one run (zero-touch phase 19) —
   * the inbox's `policy` rows.
   *
   * Two sources, joined: the journal's `phase.policy-answered` lines (every one
   * of the five writers journals one), read from a bounded tail, and the
   * fingerprint a run keeps on `recoveries[phase].policyAnswered` (two of them
   * do), which outlives a tail that has rolled past its line. The inbox keeps
   * the newest per phase and key, so an answer both sources hold is one row.
   * Cached on the journal file's mtime+size, like the ruling ledgers: the inbox
   * asks on every render, and a journal changes only when its run writes.
   */
  runPolicyAnswers(run: {
    id: string;
    slug: string;
    recoveries?: Readonly<
      Record<string, { policyAnswered?: { decisionKey: string; answer: string; source: string; at: string } } | undefined>
    >;
  }): InboxPolicyAnswer[] {
    if (!this.root?.ok || !run?.id || !run.slug) return [];
    const file = journalFile(this.root.path, run.slug, run.id);
    let stamp: string;
    try {
      const info = statSync(file);
      stamp = `${info.mtimeMs}:${info.size}`;
    } catch {
      stamp = 'absent';
    }
    const cacheKey = `${run.slug}/${run.id}`;
    const hit = this.policyAnswersCache.get(cacheKey);
    let fromJournal: InboxPolicyAnswer[];
    if (hit && hit.stamp === stamp) {
      fromJournal = hit.answers;
    } else {
      const entries = stamp === 'absent'
        ? []
        : Journal.for(this.root.path, run.slug, run.id).read(ServiceRuns.POLICY_JOURNAL_TAIL);
      fromJournal = entries.flatMap((entry) => {
        if (entry.event !== 'phase.policy-answered') return [];
        const data = entry.data ?? {};
        const phase = Number(entry.phase ?? data.phase);
        const decisionKey = typeof data.decisionKey === 'string' ? data.decisionKey : '';
        if (!decisionKey || !Number.isInteger(phase) || phase <= 0) return [];
        return [{
          slug: run.slug,
          runId: run.id,
          phase,
          decisionKey,
          answer: String(data.answer ?? ''),
          source: String(data.source ?? ''),
          ...(typeof data.situation === 'string' ? { situation: data.situation } : {}),
          ...(typeof data.label === 'string' ? { label: data.label } : {}),
          at: entry.time,
        }];
      });
      this.policyAnswersCache.set(cacheKey, { stamp, answers: fromJournal });
      if (this.policyAnswersCache.size > 256) {
        const oldest = this.policyAnswersCache.keys().next().value;
        if (oldest !== undefined) this.policyAnswersCache.delete(oldest);
      }
    }
    const kept = Object.entries(run.recoveries ?? {}).flatMap(([phaseKey, recovery]) => {
      const answered = recovery?.policyAnswered;
      const phase = Number(phaseKey);
      if (!answered?.decisionKey || !Number.isInteger(phase) || phase <= 0) return [];
      return [{
        slug: run.slug,
        runId: run.id,
        phase,
        decisionKey: answered.decisionKey,
        answer: answered.answer,
        source: answered.source,
        at: answered.at,
      }];
    });
    return [...fromJournal, ...kept];
  }

  /**
   * Fold what the ledger holds into the plan's run, and journal what is new.
   *
   * With the plan's runner live it is the runner's act, for the same reason
   * every other write to a live run is: two writers on one checkpoint is how a
   * run file loses a phase. Without one, the newest run on disk takes it —
   * and if there is no run at all, the ledger simply stands on its own, which
   * is the common case for a plan somebody is driving by hand.
   */
  private ingestRulingsFor(slug: string): void {
    if (!this.root?.ok) return;
    const ledger = this.runRulings(slug);
    if (!ledger.length) return;
    const live = this.liveRunner(slug);
    if (live) {
      if (live.ingestRulings(ledger)) this.emit('run:rulings', { slug });
      return;
    }
    const state = latestRun(this.root.path, slug, this.liveRunIds());
    if (!state) return;
    const mine = ledger.filter((ruling) => !state.createdAt || ruling.at >= state.createdAt);
    const { rulings, added } = ingestRulings(state.rulings, mine);
    if (!added.length) return;
    state.rulings = rulings;
    const journal = Journal.for(this.root.path, slug, state.id);
    for (const ruling of added) {
      journal.append('phase.ruling', {
        id: ruling.id, kind: ruling.kind, what: ruling.what,
        ...(ruling.why ? { why: ruling.why } : {}),
        ...(ruling.costIfWrong ? { costIfWrong: ruling.costIfWrong } : {}),
        ...(ruling.sessionId ? { sessionId: ruling.sessionId } : {}),
        at: ruling.at, by: 'unsupervised',
      }, ruling.phase);
    }
    saveRun(state);
    this.emit('run:rulings', { slug });
  }

  async runsFor(slug: string): Promise<RunState[]> {
    if (!this.root) return [];
    return this.resolveAgainstBoard(listRuns(this.root.path, slug, this.liveRunId()));
  }

  /**
   * The most recent run's id, without the board read.
   *
   * Journals and transcripts are addressed by run id and do not care whether
   * the run still wants attention — spending an engine call to find out would
   * be paying for an answer nobody asked for.
   */
  runIdFor(slug: string): string | undefined {
    const live = this.runners.get(slug)?.current();
    if (live && live.slug === slug) return live.id;
    return this.root ? latestRun(this.root.path, slug, this.liveRunId())?.id : undefined;
  }

  /**
   * Apply the board resolver to a batch of runs, writing back what changed.
   *
   * One board read per plan, and only for runs that could actually be resolved
   * by one — a fleet that is entirely `finished` costs nothing at all.
   */
  protected async resolveAgainstBoard(runs: RunState[]): Promise<RunState[]> {
    const slugs = slugsNeedingBoard(runs);
    if (!slugs.length) return runs;

    const boards = new Map<string, Record<number, string>>();
    // Per slug, the phases whose QA verdict is holding their dependents. Free:
    // the engine already reports it on `--memory-block`'s `blocked:` line (and
    // that line honours a per-phase `- **QA:** off`, so an exempt phase never
    // appears here), which the board read below has already parsed.
    const qaHeld = new Map<string, ReadonlySet<number>>();
    for (const slug of slugs) {
      // An engine failure leaves the slug out of the map, so its runs keep
      // their cards. Uncertainty must not resolve anything.
      try {
        const board = await this.board(slug);
        boards.set(slug, board.states);
        const held = Object.entries(board.qa ?? {})
          .filter(([, verdict]) => verdict !== 'pass' && verdict !== 'waived')
          .map(([phase]) => Number(phase))
          .filter(Number.isFinite);
        if (held.length) qaHeld.set(slug, new Set(held));
      } catch { /* keep the card */ }
    }

    for (const state of resolveRunsAgainst(runs, boards, qaHeld)) {
      // Same contract as `settle()`: the correction sticks, but a read must not
      // fail because the disk did.
      try { saveRun(state); } catch { /* the annotation is worth less than the read */ }
      log.info('run.resolved', { slug: state.slug, runId: state.id, reason: state.resolved?.reason });
    }
    return runs;
  }

  /**
   * Dismiss a stopped run by hand, or put it back.
   *
   * The manual half of the resolver, and the reason `RunResolution.auto`
   * exists: this one is a person's judgement, so it survives a board that
   * disagrees and it can be taken back. Goes through `editStoredRun`, so it
   * works on a run no loop is driving — which is every run this is used on.
   */
  async resolveRun(slug: string, runId: string, opts: { note?: string; by?: string; actor?: Actor } = {}): Promise<RunState | null> {
    const actor = opts.actor ?? asActor(opts.by ?? 'console', 'Service.resolveRun');
    // What the board read ready at the dismissal (control-tower phase 110,
    // #176), so work that turns ready AFTER it reads as new. Unreadable, the
    // dismissal records none — the shape every older dismissal has.
    let ready: number[] | null = null;
    try {
      const board = await this.board(slug);
      if (!board.error) ready = [...board.ready].sort((a, b) => a - b);
    } catch { /* recorded without a ready set */ }
    return this.editStoredRunById(slug, runId, (state) => {
      const resolved: RunResolution = {
        at: new Date().toISOString(),
        auto: false,
        reason: 'dismissed by the operator',
        by: opts.by ?? actor.by,
        ...(opts.note ? { note: opts.note } : {}),
        ...(ready ? { ready } : {}),
      };
      // …worded as who made it: a watchdog's API call was recorded "dismissed
      // by the operator", and converge then pinned the run as a person's.
      if (!dismissedByPerson(resolved)) {
        resolved.reason = `dismissed by ${resolved.by === SCRIPT_BY ? 'a script' : 'an unnamed caller'}, not a person`;
      }
      state.resolved = resolved;
      // A dismissal replaces an earlier "put it back" — otherwise the veto
      // would outlive the decision it was vetoing.
      state.reopenedAt = null;
      // …and it is journalled (control-tower phase 96, #142): the record keeps
      // only the latest dismissal, so its note was the one decision about a
      // run that no history could show.
      this.journalStoredEdit(state, 'run.resolved', { ...(opts.note ? { note: opts.note } : {}) }, actor);
    });
  }

  /**
   * A person's note on a run (control-tower phase 96, #142) — a decision or an
   * intervention and its why, written where the next operator, the timeline
   * and the next boarding all read it. `phase` files it on that phase's line;
   * `pinned` makes it a standing decision, read into the boot prompt of every
   * phase it applies to until somebody unpins it.
   *
   * On "the run of this plan", like every verb beside it, through
   * `editStoredRun` — so a live run's note lands on the runner's own state and
   * the next boarding reads it without a restart.
   */
  noteRun(
    slug: string, input: { text: string; pinned?: boolean; phase?: number }, actor: Actor,
  ): { ok: true; note: RunNote; run: RunState } | { ok: false; status: number; error: string } {
    const text = input.text.trim().slice(0, RUN_NOTE_MAX);
    if (!text) return { ok: false, status: 400, error: 'a note needs some text' };
    if (!this.root?.ok) return { ok: false, status: 409, error: 'No source directory is open.' };
    const note: RunNote = {
      id: randomUUID().replace(/-/g, '').slice(0, 12),
      at: new Date().toISOString(),
      by: actor.by,
      text,
      pinned: input.pinned === true,
      ...(input.phase !== undefined ? { phase: input.phase } : {}),
    };
    const run = this.editStoredRun(slug, (state) => {
      state.notes = keepNotes([...(state.notes ?? []), note]);
      journalOf(state)('run.note', { id: note.id, text, pinned: note.pinned, ...actor }, note.phase);
    });
    if (!run) return { ok: false, status: 409, error: `No run of ${slug} to write a note on — a note belongs to a run.` };
    return { ok: true, note, run };
  }

  /** Pin a note, or unpin it: a standing decision stops being one only when a person says so. */
  pinRunNote(
    slug: string, id: string, pinned: boolean, actor: Actor,
  ): { ok: true; note: RunNote; run: RunState } | { ok: false; status: number; error: string } {
    if (!this.root?.ok) return { ok: false, status: 409, error: 'No source directory is open.' };
    const hit: { note?: RunNote } = {};
    const run = this.editStoredRun(slug, (state) => {
      const note = state.notes?.find((one) => one.id === id);
      if (!note) return;
      hit.note = note;
      if (note.pinned === pinned) return;
      note.pinned = pinned;
      journalOf(state)('run.note-pinned', { id, pinned, ...actor });
    });
    if (!run) return { ok: false, status: 409, error: `No run of ${slug}.` };
    if (!hit.note) return { ok: false, status: 404, error: `no note ${id} on run ${run.id}` };
    return { ok: true, note: { ...hit.note }, run };
  }

  unresolveRun(slug: string, runId: string): RunState | null {
    return this.editStoredRunById(slug, runId, (state) => {
      // Null rather than `delete`: the field is written out, so a re-read
      // cannot resurrect the old annotation from a stale copy on disk.
      state.resolved = null;
      // And the board resolver is told to leave it alone — see `reopenedAt`.
      // Without this the card comes back and vanishes again on the next read.
      state.reopenedAt = new Date().toISOString();
    });
  }

  /**
   * How much longer this plan has, from evidence it already has.
   *
   * Computed here rather than in the browser for the same reason the board is:
   * the numbers it rests on — a phase's size, the sizing constants, which
   * phases the engine calls done — all live on this side, and a second
   * implementation of them would eventually disagree with the first.
   *
   * The samples come from **every** run of the plan, not just this one, which
   * is what lets an estimate exist before the current run's first phase has
   * finished. Null whenever nothing has finished at all, which is the honest
   * answer to "how long will this take" the first time anyone asks.
   */
  async runEta(slug: string): Promise<EtaEstimate | null> {
    const record = this.store?.get(slug);
    if (!record?.plan?.phased || !this.root) return null;

    const plan = record.plan;
    const sizes = new Map(plan.graph.map((r) => [r.phase, plan.phases[r.phase]?.size ?? 'M' as const]));
    const board = await this.board(slug);

    // A scoped run is not going to do the rest of the plan, and saying it will
    // is the same defect as not showing the scope in the header at all.
    const run = await this.runFor(slug);
    const scope = run?.onlyPhases?.length ? new Set(run.onlyPhases) : null;
    const rows = scope ? plan.graph.filter((r) => scope.has(r.phase)) : plan.graph;

    const budget = resolveBudget(plan.sessionBudget.targetModel, this.sizing);
    const remaining = remainingWork(rows, board, sizes, this.sizing, budget, this.phaseWeights(plan), this.sizingCensus()?.sessions);
    const facts = etaPhaseFacts(plan, (phase) => this.weightOfPhase(plan, phase));
    const open = rows.filter((r) => board.states[r.phase] !== 'done').map((r) => r.phase);
    return etaFrom(this.planRate(slug), { ...remaining, floors: remainingFloors(facts, open) });
  }

  /**
   * Every plan's finished phases, as evidence — this plan's own, and the pool.
   *
   * Read in one pass because the fallback chain needs both halves and because a
   * per-plan read repeated from the plans list would be 86 directory scans per
   * request. Runs live under `STATE_DIR`, not in the repo, so nothing here is
   * derived from a document and none of it invalidates on `generation` — hence
   * the time-based cache. See `ETA_POOL_MS`.
   */
  protected etaPool(): EtaPool {
    const now = Date.now();
    if (this.etaPoolCache && now - this.etaPoolCache.at < ETA_POOL_MS) return this.etaPoolCache.value;

    const bySlug = new Map<string, EtaSample[]>();
    const missing = new Map<string, number>();
    const all: EtaSample[] = [];
    const root = this.root?.ok ? this.root.path : null;

    if (root) {
      const live = this.liveRunIds();
      for (const record of this.store?.list() ?? []) {
        const plan = record.plan;
        if (!plan?.phased) continue;
        const facts = etaPhaseFacts(plan, (phase) => this.weightOfPhase(plan, phase));
        // `listRuns` rather than `runsFor`: the board resolver answers "does this
        // stopped run still want a person", which changes no finished phase's
        // duration — and asking it here would cost an engine read per plan.
        const evidence = etaEvidence(listRuns(root, record.slug, live), facts, now);
        if (evidence.samples.length) bySlug.set(record.slug, evidence.samples);
        if (evidence.missing.length) missing.set(record.slug, evidence.missing.length);
        all.push(...evidence.samples);
      }
      all.sort((a, b) => (a.at ?? '9999').localeCompare(b.at ?? '9999'));
    }

    const value: EtaPool = { bySlug, all, missing, shape: fitShape(all) };
    this.etaPoolCache = { at: now, value };
    this.etaShapeCache = { at: now, value: value.shape };
    return value;
  }

  /**
   * The pool's shape, for a plan that has evidence of its own (`ETA_SHAPE_MS`).
   *
   * A plan's level is its own phases; the SHAPE it is read against — how much
   * of a phase is the floor every session pays and how much is its size — is
   * the pool's, because one plan rarely finishes enough of every size to say.
   * The shape moves slowly, so it is kept ten minutes rather than the pool's
   * five seconds: opening a plan must not pay for every other plan's runs.
   */
  protected etaShape(): EtaShape | null {
    const now = Date.now();
    if (this.etaShapeCache && now - this.etaShapeCache.at < ETA_SHAPE_MS) return this.etaShapeCache.value;
    return this.etaPool().shape;
  }

  /**
   * The rate to estimate this plan with, and how much of a claim it is.
   *
   * `ownSamples`/`ownMissing` are this plan's evidence, for a caller that
   * already has it (the plan page reads its runs once for every figure on it).
   * The level is always the plan's own; the shape is the pool's, from the
   * long-lived `etaShape` when the plan has evidence and from a fresh pool read
   * only when it has none — the one case that needs the pool's own level too.
   */
  protected planRate(slug: string, ownSamples?: EtaSample[], ownMissing?: number): RateReading {
    if (ownSamples) {
      if (ownSamples.length) return rateFor(ownSamples, [], { shape: this.etaShape(), missing: ownMissing ?? 0 });
      const pool = this.etaPool();
      return rateFor([], pool.all, { shape: pool.shape, missing: ownMissing ?? 0 });
    }
    const pool = this.etaPool();
    return rateFor(pool.bySlug.get(slug) ?? [], pool.all, { shape: pool.shape, missing: pool.missing.get(slug) ?? 0 });
  }

  /**
   * How long each phase this run has a session on was expected to take.
   *
   * One entry per LANE, not one for "the" active phase: a run may be driving
   * three disjoint-scope phases, and a single figure would silently be whichever
   * of them the mirror happens to name. `remaining` is deliberately NOT computed
   * here — the elapsed clock ticks in the browser, so a server-side remainder
   * would be stale the moment it was serialised. The server owns the estimate;
   * the client owns the clock.
   */
  runPhaseEta(slug: string, run: RunState | null): PhaseEta[] {
    const plan = this.store?.get(slug)?.plan;
    if (!plan?.phased || !run) return [];

    const lanes = childrenOf(run).map((child) => child.phase);
    const phases = lanes.length ? lanes : run.activePhase != null ? [run.activePhase] : [];
    if (!phases.length) return [];

    const rate = this.planRate(slug);
    const floors = etaPhaseFacts(plan, (phase) => this.weightOfPhase(plan, phase));
    return [...new Set(phases)]
      .sort((a, b) => a - b)
      .map((phase) => phaseEtaFor(phase, this.weightOfPhase(plan, phase), rate, floors.get(phase)?.floorMs));
  }

  /**
   * Everything the session printed, replayed from disk.
   *
   * The live console used to exist only in whichever browser tab happened to be
   * open when the phase ran. This is the same events, kept, so a reload or a
   * console restart does not erase the only record of what a session did.
   */
  runTranscript(slug: string, id: string | undefined, limit = 400, phase?: number): TranscriptEntry[] {
    const runId = id ?? this.runIdFor(slug);
    if (!runId || !this.root?.ok) return [];
    // One phase's replay, or the whole run's merged in order — read from the
    // end of each file (control-tower phase 94, #133). A phase with none is
    // answered from its session's OWN log (phase 95, #138), and only then from
    // the journal's lines — each said so in its first line.
    return replayFor(this.root.path, slug, runId, {
      limit,
      ...(phase != null
        ? {
          phase,
          sessionLog: (want: number) => {
            const record = loadRun(this.root!.path, slug, runId, this.liveRunId())?.phases[String(phase)];
            const read = sessionActivityFor({
              phase, record, reader: this.transcripts, limit: want,
              locate: (sessionId) => this.sessionLogOf(sessionId, record?.sessionAccountId),
            });
            return activityOf(read.events, phase);
          },
        }
        : {}),
    });
  }

  /** The run a phase's own view reads: the one named, else the live one, else the newest that ran it. */
  protected phaseRunFor(slug: string, phase: number, runId?: string): RunState | null {
    const root = this.root?.ok ? this.root.path : null;
    if (!root) return null;
    if (runId) return loadRun(root, slug, runId, this.liveRunId());
    const live = this.runners.get(slug)?.current();
    if (live?.phases[String(phase)]) return live;
    return listRuns(root, slug, this.liveRunId()).find((run) => run.phases[String(phase)]) ?? null;
  }

  /**
   * A phase's recent activity — the last events of its live (or latest)
   * session, read from that session's OWN log and from its end
   * (control-tower phase 95, #138): tool calls with their descriptions, times
   * and exits, its own words, the compaction and wrap-up markers. Whatever the
   * replay's size — the replay stops at its cap, the session's log does not.
   * Marked `untrusted`: a reader handing it to a model frames it as data.
   */
  phaseActivity(slug: string, phase: number, opts: { limit?: number; since?: number; run?: string } = {}): PhaseActivity & { slug: string; runId?: string } {
    const run = this.phaseRunFor(slug, phase, opts.run);
    const record = run?.phases[String(phase)];
    const read = sessionActivityFor({
      phase, record, reader: this.transcripts, limit: opts.limit, since: opts.since,
      locate: (sessionId) => this.sessionLogOf(sessionId, record?.sessionAccountId),
    });
    return { slug, ...(run ? { runId: run.id } : {}), ...read };
  }

  /**
   * A live phase's progress report (control-tower phase 95, #163): what it is
   * doing, what is done and left, what it waits on, why it is slow and when it
   * should finish — `composePhaseReport` over the facts gathered here: the
   * phase's record and lane, its journal lines, its session's last events and
   * the machine's load. Composed by rules; every figure names its source.
   */
  phaseReport(slug: string, phase: number, opts: { run?: string } = {}): PhaseReport | { phase: number; error: string } {
    const run = this.phaseRunFor(slug, phase, opts.run);
    const record = run?.phases[String(phase)];
    if (!run || !record || !this.root?.ok) return { phase, error: `no record of phase ${phase} in any run of ${slug}` };
    const lane = this.runLiveness(slug, run).find((view) => view.phase === phase) ?? record.liveness;
    const activity = sessionActivityFor({
      phase, record, reader: this.transcripts, limit: 20,
      locate: (sessionId) => this.sessionLogOf(sessionId, record.sessionAccountId),
    });
    return composePhaseReport({
      slug, runId: run.id, phase, now: Date.now(),
      record: { ...record, ...(lane ? { liveness: lane } : {}) },
      journal: readPhaseJournal(journalFile(this.root.path, slug, run.id), phase),
      activity: activity.events,
      load: { one: loadavg()[0] ?? 0, cpus: availableParallelism() },
    });
  }

  /* ---- one verb table: triggers, the boundary re-board, the long poll (control-tower phase 98) ---- */

  private triggerEngine: TriggerEngine | null = null;
  private triggerListener: (() => void) | null = null;

  /** The one trigger engine, built lazily: its deps reach back into this service. */
  protected triggers(): TriggerEngine {
    if (!this.triggerEngine) {
      this.triggerEngine = new TriggerEngine({
        file: (slug) => triggersFile(this.root!.path, slug),
        press: (slug, verb, body, actor) => pressVerb(this, slug, verb, body, actor),
        journal: (slug, event, payload, phase) => this.journalOnPlan(slug, event, payload, phase),
        facts: (slug) => this.runFacts(slug),
        emit: (slug) => this.emit('run:triggers', { slug }),
      });
    }
    return this.triggerEngine;
  }

  /**
   * At open: read every plan's stored triggers, fire the ones already true,
   * and watch what goes by. An observation is the runner's own journal line or
   * phase change; a run WRITE (a stored edit, a pause landing) re-judges the
   * plan's state triggers.
   */
  protected startTriggers(): void {
    // A second open (another root) starts from nothing: the engine caches files.
    this.stopTriggers();
    if (!this.root?.ok) return;
    const engine = this.triggers();
    this.triggerListener = this.onEvent((event, data) => {
      const payload = data as { slug?: string; phase?: number; status?: string; event?: string; state?: RunState } | null;
      const slug = payload?.slug ?? payload?.state?.slug;
      if (!slug) return;
      let seen: Observation | null = null;
      if (event === 'run:journal' && typeof payload?.event === 'string') {
        seen = { slug, kind: 'journal', event: payload.event, ...(typeof payload.phase === 'number' ? { phase: payload.phase } : {}) };
      } else if (event === 'run:phase' && typeof payload?.phase === 'number' && typeof payload.status === 'string') {
        seen = { slug, kind: 'phase', phase: payload.phase, status: payload.status };
      }
      if (seen) engine.observe(seen);
      if (event === 'run:run' || event === 'run:state') engine.evaluate(slug);
    });
    const slugs = (this.store?.list() ?? []).map((plan) => plan.slug);
    engine.boot(slugs);
  }

  protected stopTriggers(): void {
    this.triggerListener?.();
    this.triggerListener = null;
    this.triggerEngine?.close();
    this.triggerEngine = null;
  }

  /** `POST /api/run/:slug/triggers` — arm one. */
  armTrigger(slug: string, spec: TriggerSpec, actor: Actor): ReturnType<TriggerEngine['arm']> {
    if (!this.root?.ok) return { ok: false, status: 409, error: 'No source directory is open.' };
    if (!this.store?.get(slug)) return { ok: false, status: 404, error: `no plan ${slug}` };
    return this.triggers().arm(slug, spec, actor);
  }

  /** `POST /api/run/:slug/triggers/:id/cancel`. */
  cancelTrigger(slug: string, id: string, actor: Actor): ReturnType<TriggerEngine['cancel']> {
    if (!this.root?.ok) return { ok: false, status: 409, error: 'No source directory is open.' };
    return this.triggers().cancel(slug, id, actor);
  }

  /** `GET /api/run/:slug/triggers`. */
  listTriggers(slug: string): Trigger[] {
    return this.root?.ok ? this.triggers().list(slug) : [];
  }

  /** Resolves once every firing queued so far has been pressed — for a caller that must read the result. */
  triggersSettled(): Promise<void> {
    return this.triggerEngine?.settled() ?? Promise.resolve();
  }


  /** One journal line on the plan's run — the newest, live or stored. Nothing when the plan has none. */
  /** The line's number in the run's journal, or null when no run took it. */
  private journalOnPlan(slug: string, event: string, payload: Record<string, unknown>, phase?: number): number | null {
    if (!this.root?.ok) return null;
    const runner = this.liveRunner(slug);
    if (runner?.current()) return runner.note(event, payload, phase);
    const run = latestRun(this.root.path, slug, this.liveRunIds());
    return run ? Journal.for(run.root, run.slug, run.id).append(event, payload, phase).seq : null;
  }

  /** Every plan this console holds, by slug. */
  planSlugs(): string[] {
    return (this.store?.list() ?? []).map((plan) => plan.slug);
  }

  /** The slim projection of a plan's latest run (#75): what `run status` prints. */
  slimRunFor(slug: string): SlimRun | null {
    const live = this.liveRunner(slug)?.current();
    const run = live && live.slug === slug ? live : (this.root?.ok ? latestRun(this.root.path, slug, this.liveRunIds()) : null);
    return run ? slimRun(run, this.runLiveness(slug, run)) : null;
  }

  /** The facts a trigger's `when` and a long poll's `for` are judged on. */
  runFacts(slug: string): RunFacts | null {
    const slim = this.slimRunFor(slug);
    const queued = this.queueSnapshot().entries
      .filter((entry) => entry.slug === slug)
      .map((entry) => entry.phase)
      .filter((phase): phase is number => typeof phase === 'number');
    return factsOf(slim, queued);
  }

  /**
   * `GET /api/run/:slug/wait?for=<predicate>&timeout=<s>` (#137 item 4, #144):
   * answers the moment the predicate holds, or when the clock runs out — never
   * a polling loop on either side. Re-judged on every run event this service
   * emits, and every two seconds as a backstop for a fact that emits nothing.
   */
  waitFor(slug: string, forText: string, timeoutS: number | null, signal?: AbortSignal): Promise<WaitAnswer> {
    const parsed = parseWhen(forText, { wait: true });
    if ('error' in parsed) return Promise.resolve({ status: 400, body: { error: parsed.error } });
    if (parsed.event === 'lane-boundary' || parsed.event === 'at') {
      return Promise.resolve({ status: 400, body: { error: `${parsed.event} is an event, not a state a wait can hold on` } });
    }
    if (!this.store?.get(slug)) return Promise.resolve({ status: 404, body: { error: `no plan ${slug}` } });
    const seconds = Math.min(Math.max(timeoutS ?? WAIT_DEFAULT_S, 0), WAIT_MAX_S);
    const started = Date.now();
    const answer = (held: boolean): WaitAnswer => ({
      status: 200,
      body: { held, timedOut: !held, for: forText, waitedMs: Date.now() - started, run: this.slimRunFor(slug) },
    });
    const check = () => holds(parsed, this.runFacts(slug), { wait: true }) === true;
    if (check()) return Promise.resolve(answer(true));
    if (seconds === 0) return Promise.resolve(answer(false));
    return new Promise((resolve) => {
      let queued = false;
      let done = false;
      const finish = (held: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(clock);
        clearInterval(backstop);
        off();
        resolve(answer(held));
      };
      const recheck = () => {
        if (queued || done) return;
        queued = true;
        setImmediate(() => { queued = false; if (!done && check()) finish(true); });
      };
      const off = this.onEvent((event) => { if (event.startsWith('run:')) recheck(); });
      const clock = setTimeout(() => finish(check()), seconds * 1000);
      const backstop = setInterval(recheck, 2_000);
      clock.unref?.();
      backstop.unref?.();
      signal?.addEventListener('abort', () => finish(check()), { once: true });
    });
  }

  /**
   * "Board phase N at the next boundary, with this instruction" (#137 item 3)
   * — the pause and `resume-phase` pair made ONE act. On a live run the phase
   * is hinted in the person slot AND reserved at admission (the landing's
   * reservation, `landingReserve`): first in the loop's fill, aged at birth in
   * the scheduler, and its scope's siblings wait a tick behind it — no window
   * in which another phase takes the lane (#134). No loop behind the run: the
   * boundary is now, and the press is `resume-phase`'s.
   */
  async boardAtBoundary(slug: string, phase: number, opts: { instruction?: string; actor: StartActor }): Promise<PressAnswer> {
    if (!Number.isSafeInteger(phase) || phase < 1) return { ok: false, status: 400, error: 'a phase number is required' };
    const runner = this.liveRunner(slug);
    const state = runner?.current();
    if (runner && state && !runIsOver(state)) {
      const out = runner.boardAtBoundary(phase, {
        ...(opts.instruction ? { instruction: opts.instruction } : {}), actor: opts.actor,
      });
      if (!out.ok) return { ok: false, status: 409, error: out.reason };
      return this.pressVerdict(slug, runner.current() ?? state, {
        runId: state.id, phase, session: out.sessionId, brief: out.brief,
      });
    }
    return this.pressResume(slug, phase, 'resume', opts);
  }

  /* ---- controls that must work whether or not a loop is behind them ---- */

  /**
   * Apply a change to a run the loop is not driving.
   *
   * Stop, Retry and Skip all used to begin `if (!this.state) return` inside the
   * Runner, which is true of every run after a console restart. The buttons
   * stayed on screen, the API answered 200, and nothing happened — the worst of
   * the three possible behaviours, because it is indistinguishable from working.
   */
  protected editStoredRun(slug: string, apply: (state: RunState) => void): RunState | null {
    if (!this.root?.ok) throw new Error('No source directory is open.');
    return this.writeStoredRun(latestRun(this.root.path, slug, this.liveRunId()), apply);
  }

  /**
   * The same, on a named run rather than the latest.
   *
   * Every control above acts on "the run of this plan", which is the newest one
   * — but dismissing a card is about the run that raised it, and on a plan that
   * has run since, that is not the newest. Addressing it by id is the whole
   * difference between resolving the card you pressed and resolving a different
   * run that happens to share its slug.
   */
  /**
   * An operator's Release of a phase's lock takes that phase's declared wall
   * down as a FENCE too (control-tower phase 6, #19): the phases it fenced
   * read `release` as the why on the next pass that looks — the drive loop's
   * tick (woken here; the docs watcher would wake it on the lock file anyway)
   * or the healer's. A phase that is no declared wall is left untouched.
   */
  protected noteFenceReleased(slug: string, phase: number): void {
    const stamp = (record: RunPhaseRecord | undefined): boolean => {
      const status = record?.declared?.status;
      if (!record || (status !== 'needs-human' && status !== 'blocked')) return false;
      record.fenceLifted = { why: 'release', at: new Date().toISOString() };
      return true;
    };
    const runner = this.liveRunner(slug);
    const live = runner?.current();
    if (runner && live) {
      if (stamp(live.phases[String(phase)])) runner.noteDocsChanged();
      return;
    }
    if (!this.root?.ok) return;
    const latest = latestRun(this.root.path, slug, this.liveRunIds());
    if (!latest || !stamp(latest.phases[String(phase)])) return;
    this.editStoredRunById(slug, latest.id, (stored) => { stamp(stored.phases[String(phase)]); });
  }

  protected editStoredRunById(slug: string, runId: string, apply: (state: RunState) => void): RunState | null {
    if (!this.root?.ok) throw new Error('No source directory is open.');
    return this.writeStoredRun(loadRun(this.root.path, slug, runId, this.liveRunId()), apply);
  }

  /**
   * Apply an operator's edit to a run record on disk.
   *
   * **The live owner writes it, or nobody does.** This is a read-modify-write
   * over a whole checkpoint: `latestRun`/`loadRun` parsed the file, `apply`
   * mutates that copy, and `saveRun` writes it back in full. With the plan's
   * Runner live, its own `persist()` is writing the same file from its own
   * in-memory `state` — so an operator control interleaving with it silently
   * discards whichever record lost the race, and the loser can be a whole
   * run's worth of phase records.
   *
   * `ingestRulingsFor` has always guarded exactly this way (hand the act to
   * the live runner, or take it only when there is none); this path did not,
   * and it is the one a person drives with a button. When the run IS live the
   * edit is applied to the runner's OWN state object, which is the copy that
   * will be persisted — so the control still works, and works on the record
   * that will survive.
   */
  protected writeStoredRun(state: RunState | null, apply: (state: RunState) => void): RunState | null {
    if (!state) return null;
    const live = this.liveRunner(state.slug);
    const owned = live?.current();
    if (owned && owned.id === state.id) {
      apply(owned);
      // The runner's own writer, so this write cannot race the runner's.
      saveRun(owned);
      this.emit('run:state', { state: owned });
      return owned;
    }
    apply(state);
    saveRun(state);
    this.emit('run:state', { state });
    return state;
  }

  /**
   * One line on a STORED run's own journal, for an edit no loop made.
   *
   * The live branch of every mid-run control journals through its runner, and
   * the stored branch beside it journalled nothing at all — which is #22: a run
   * whose `accountId` said one thing, whose `accounts[]` said another, and
   * whose history could not explain either value. A checkpoint edit is a
   * DECISION somebody made; the only difference from the live one is that no
   * loop was there to write it down.
   *
   * `stored: true` and the actor's four fields ride every line, so a reader can
   * tell an edit made to a checkpoint from one made to a running loop without
   * knowing which control wrote it. Call it INSIDE the `writeStoredRun` apply,
   * so the line and the value it explains are persisted by the same write.
   */
  protected journalStoredEdit(
    state: RunState, event: string, data: Record<string, unknown>, actor: Actor,
  ): void {
    journalOf(state)(event, { ...data, stored: true, ...actor });
  }

  /**
   * Stop a run, or one lane of it.
   *
   * `actor` is who asked, as the route DERIVED it from the request (SHD-3) —
   * never a literal the client chose. It reaches `run.stop-requested` whole
   * and decides `stoppedBy`; the stored-run fallback below folds it the same
   * way, so a stop that landed on a checkpoint reads like one that landed on
   * a loop.
   */
  async stopRun(slug: string, phase?: number | null, actor: Actor = unattributedActor('Service.stopRun')): Promise<RunState | null> {
    const runner = this.liveRunner(slug);
    const by = actor.by;
    if (runner) {
      // A named phase stops that lane only, and the loop carries on. The
      // runner rules on queued/verifying/unknown itself — it can see the
      // lanes; its refusal keeps the 409 shape a mismatch always had.
      if (phase != null) {
        const result = runner.stopPhase(phase, actor);
        if (!result.ok) throw new Error(result.reason);
        return runner.current();
      }
      await runner.stop(actor);
      return runner.current();
    }
    if (phase != null) {
      // No loop behind it, and a recorded child still alive belongs to a
      // console that is gone. That used to be a 409 with `kill <pid>` as the
      // advice and no other door (#21 §4) — the console knows the pid and the
      // start time it was recorded with, `signals.ts` owns the one ladder, and
      // the operator asked for the button. So it stops it, through that ladder.
      //
      // What it still will not do is signal a pid it cannot IDENTIFY: without
      // `procStartedAt`, or with one the kernel disagrees with, the pid has
      // been recycled and whatever holds it now is a stranger's.
      await this.stopForeignLane(slug, phase, actor);
      return this.editStoredRun(slug, (state) => {
        const record = state.phases[String(phase)];
        if (!record || !PHASE_IN_FLIGHT.includes(record.status)) {
          throw new Error(`phase ${phase} of ${slug} is not running`);
        }
        record.status = 'interrupted';
        record.note = `stopped by ${by}`;
        record.endedAt = new Date().toISOString();
        record.resumeSessionId ??= record.sessionId;
        if (state.children) {
          delete state.children[String(phase)];
          if (!Object.keys(state.children).length) delete state.children;
        }
        if (state.child?.phase === phase) state.child = null;
      });
    }
    // A run-level stop takes its foreign lanes with it, for the same reason
    // the named-phase branch does: a run marked `interrupted` with a child
    // still committing is the claim outliving the fact.
    const stopped = await this.stopForeignLane(slug, null, actor);
    return this.editStoredRun(slug, (state) => {
      if (!IN_FLIGHT.includes(state.status)) return;
      setRunState(state, 'interrupted');
      state.stoppedBy = stoppedByOf(actor);
      state.child = null;
      state.pause = null;
      state.halt ??= {
        at: new Date().toISOString(), kind: 'operator-stop',
        reason: `stopped by ${by === 'operator' ? 'the operator' : by}`, phase: state.activePhase ?? undefined,
      };
      if (!stopped.length) {
        journalOf(state)('run.stop-requested', { pids: [], phases: [], wasFrozen: false, stored: true, ...actor });
      }
    });
  }

  /**
   * Stop the children of a run NO CONSOLE HERE IS DRIVING — one lane, or all of
   * them — and say which were signalled.
   *
   * The refusal this replaces was honest about one thing and wrong about
   * another: signalling a pid on a guess is worse than doing nothing, but this
   * console is not guessing. It recorded the pid and the process start time at
   * spawn, `processState` compares that tuple against the kernel's own, and
   * `signals.ts` owns the wake-interrupt-term-kill ladder every other stop in
   * the tree uses. A pid the tuple does not confirm has been recycled, and that
   * is the one case that still refuses — loudly, because "the console stopped
   * an innocent process" is the failure this guard exists for.
   *
   * Returns the lanes it ended. Nothing alive is not an error: the ordinary
   * case is a child that finished while its run sat parked.
   */
  protected async stopForeignLane(slug: string, phase: number | null, actor: Actor): Promise<number[]> {
    if (!this.root?.ok) return [];
    const state = latestRun(this.root.path, slug, this.liveRunIds());
    if (!state) return [];
    const lanes = childrenOf(state).filter((child) => (phase == null || child.phase === phase));
    // The identity check below is SYNCHRONOUS, and a cold sample cache makes it
    // answer from `kill(0)` alone — which knows nothing about start times, so
    // every pid would read as confirmed. Warm first: without this the guard is
    // decoration.
    await warmPids(lanes.map((child) => child.pid));
    const ended: number[] = [];
    for (const child of lanes) {
      if (!pidAlive(child.pid)) continue;
      if (!pidHoldsWork(child.pid, procIdentity(child))) {
        throw new Error(`phase ${child.phase}'s recorded session (pid ${child.pid}) is not the process `
          + 'this console started — the identity of that pid does not match the record, so it belongs to '
          + 'something else now and will not be signalled. Clear the phase with Retry or Skip instead.');
      }
      const how = await this.killForeignChild(child.pid);
      forgetPid(child.pid);
      ended.push(child.phase);
      journalOf(state)('run.stop-requested', {
        pids: [child.pid], phases: [child.phase], wasFrozen: Boolean(child.frozen),
        stored: true, foreign: true, ending: how, ...actor,
      }, child.phase);
    }
    return ended;
  }

  /**
   * End one child this console did not start.
   *
   * The ladder lives in `signals.ts` and is never written out a second time;
   * this exists so the act has one name in this file — and so a test can watch
   * it without a real process being signalled.
   */
  protected killForeignChild(pid: number): Promise<LadderEnding> {
    return killLadder(pid);
  }

  /**
   * Pause after the current phase.
   *
   * This used to call `runner.pause()` straight from the route, and that method
   * begins `if (!this.driving) return` — true of every run after a console
   * restart, and of any run this process is not the one driving. The button
   * stayed on screen, the API answered 200, and nothing happened at all: the
   * worst of the three possible behaviours, because it is indistinguishable
   * from working. Stop, Retry and Skip were fixed for exactly this; Pause was
   * left behind. It goes through the same door they do now.
   */
  pauseRun(slug: string, actor: Actor = unattributedActor('Service.pauseRun')): RunState | null {
    const runner = this.liveRunner(slug);
    const by = actor.by;
    // A recovery is driving one session with no phase loop behind it, so there
    // is no boundary to pause at. Falling through to the checkpoint edit here
    // would write `pausing` to disk for a run that will never read it — the
    // same button-that-does-nothing this method was rewritten to eliminate,
    // arrived at from the other direction.
    // …unless that recovery is still WAITING for its scope (control-tower phase
    // 86, #149 ask 4): then there is an admission to withdraw, which is exactly
    // what a pause of it means (`Runner.pause`).
    if (runner?.recoveringNow() && runner.recoveryQueuedFor() === null) return null;
    // A LIVE runner that says no (recovering, or a halt already draining) is
    // an answer, not an invitation to edit the checkpoint underneath it — the
    // disk copy would say `pausing` while the loop drains a halt, and the next
    // persist would overwrite it anyway. The fallback is only for a run no
    // loop drives.
    if (runner) return runner.pause(actor) ? runner.current() : null;
    // D16 (console-concurrent-plans P15) looked here for an unsettleable
    // `pausing`, and did not find one. The write below is effectively DEAD:
    // every read of a stored run goes through `loadRun`, which reconciles, so
    // by the time this callback sees the state an undriven run has already been
    // settled — `interrupted`, or `parked` when a child is still working — and
    // the `IN_FLIGHT` guard is false. The guard is kept because it is the thing
    // making that true; the branch behind it is a belt for a reconcile that
    // stops settling. `test/freeze-durability.test.ts` pins the reachability,
    // so a future change that opens this path fails a test rather than shipping
    // a word no loop will ever read.
    return this.editStoredRun(slug, (state) => {
      if (!IN_FLIGHT.includes(state.status)) return;
      setRunState(state, 'pausing');
      state.stoppedBy = 'operator';
      state.pause = { requestedAt: new Date().toISOString(), afterPhase: state.activePhase, by };
    });
  }

  /**
   * Hold this run: board nothing new, leave the live lanes alone.
   *
   * The counterpart to `pauseRun`, and the comparison is the point — a pause
   * settles the run at the next phase boundary, a hold refuses the next
   * ADMISSION and touches nothing else. An operator who means "let this plan
   * finish the phases it started, then let the other one go first" has a verb
   * for exactly that, instead of a Stop and a re-Start they have to remember.
   *
   * The on-disk fallback is not a belt the way `pauseRun`'s is: holding a run
   * no loop drives is the useful case (hold it BEFORE pressing Start), and
   * both `newRun` and the resume branch carry the field through, so the run
   * boards held.
   */
  holdRun(slug: string, who: Actor | string = 'console'): RunState | null {
    const actor = asActor(who, 'Service.holdRun');
    const by = actor.by;
    const runner = this.liveRunner(slug);
    if (runner?.hold(by, actor.reason)) return runner.current();
    const state = this.editStoredRun(slug, (run) => {
      // The live verb's own rule: a second Hold is not a second decision.
      if (run.hold) return;
      run.hold = { at: new Date().toISOString(), by };
      // …and the live verb's own line (control-tower phase 96, #142): holding a
      // run BEFORE Start is the useful case, and it was the one that left no trace.
      this.journalStoredEdit(run, 'run.held', {}, actor);
    });
    // `Runner.hold` polls for itself; the stored path has no runner to do it,
    // and some OTHER run's entry may be free to move the moment this one is.
    this.scheduler.poll();
    return state;
  }

  /** Take the hold off. The next scan admits; nothing else changes. */
  releaseRun(slug: string, who: Actor | string = 'console'): RunState | null {
    const actor = asActor(who, 'Service.releaseRun');
    const runner = this.liveRunner(slug);
    if (runner?.releaseHold(actor.by, actor.reason)) return runner.current();
    const state = this.editStoredRun(slug, (run) => {
      if (run.hold) this.journalStoredEdit(run, 'run.released', {}, actor);
      run.hold = null;
    });
    this.scheduler.poll();
    return state;
  }

  /**
   * Repair checkout (control-tower phase 90, #139): a person's word that the
   * console may move DIRTY or UNPUSHED content at the run's mount paths to
   * `stale-mounts/` — never delete it — then rebuild the mounts and continue.
   * The run was parked `isolation-refused`; the press resumes it, and the
   * resume's checkout decision spends the word. Refused while the run drives
   * (its next boundary re-asks the checkout by itself) and for a run that
   * never asked for a checkout of its own.
   */
  async repairCheckout(slug: string, actor: StartActor): Promise<
    { ok: true; run: RunState } | { ok: false; status: number; error: string }
  > {
    const runner = this.liveRunner(slug);
    if (runner?.current() && ['running', 'queued', 'halting', 'pausing'].includes(runner.current()!.status)) {
      return { ok: false, status: 409, error: `${slug} is driving — its next boundary asks the checkout again by itself.` };
    }
    const stored = runner?.current() ?? (this.root?.ok ? latestRun(this.root.path, slug, this.liveRunIds()) : null);
    if (!stored || stored.isolation !== ISOLATED) {
      return { ok: false, status: 409, error: `No run of ${slug} asked for its own checkout, so there is nothing to repair.` };
    }
    const held = this.fleetHoldFor(slug);
    if (held) return { ok: false, status: 409, error: `${slug} was not repaired — ${fleetHoldSentence(held)}.` };
    try {
      // `actor: actor`, spelled out: SLF-1 reads a threaded door by its key (#156).
      const run = await this.startRun(slug, { actor: actor, resumeRunId: stored.id, repairCheckout: { by: actor.by } });
      return { ok: true, run };
    } catch (error) {
      return { ok: false, status: 409, error: (error as Error).message };
    }
  }

  /**
   * Switch a SHARED-checkout run to a checkout of its own at its next boundary
   * (control-tower phase 90, #150) — the escape from another run's run-long
   * branch hold. On a stopped run the stored record carries the ask, and the
   * next drive's first fill applies it.
   */
  isolateRun(slug: string, by = 'console'): RunState | null {
    const runner = this.liveRunner(slug);
    if (runner?.isolateAtBoundary(by)) return runner.current();
    const state = this.editStoredRun(slug, (run) => {
      if (run.gitMode !== 'new-branch' || run.checkout === 'worktree') return;
      run.isolateAtBoundary = { at: new Date().toISOString(), by };
    });
    return state?.isolateAtBoundary ? state : null;
  }

  /**
   * Give ONE phase of a shared-checkout run its own worktree for that phase
   * (`isolate-phase`, control-tower phase 90, #150). Per-phase lanes are git
   * linked worktrees, and a linked worktree of a superproject has EMPTY
   * submodule directories — so under a superproject root this is refused by
   * name, pointing at the run-level switch (`isolate`), which takes a mirror.
   */
  async isolatePhase(slug: string, phase: number, by = 'console'): Promise<
    { ok: true; run: RunState } | { ok: false; status: number; error: string }
  > {
    if (!Number.isInteger(phase) || phase < 1) return { ok: false, status: 400, error: 'a phase number is required' };
    if (!this.root?.ok) return { ok: false, status: 409, error: 'no root' };
    const refusal = await checkAvailable({ root: this.root.path, gitMode: 'new-branch', directive: 'on' });
    if (refusal === 'has-submodules') {
      return {
        ok: false, status: 409,
        error: `${slug}'s root has submodules, so one phase cannot have a worktree of its own there — `
          + 'switch the run to its own checkout at its next boundary instead (POST /api/run/<slug>/isolate), '
          + 'which takes a mirror of the scoped submodules.',
      };
    }
    if (refusal && refusal !== 'not-opted-in') {
      return { ok: false, status: 409, error: `${slug}: ${REFUSAL_REASON[refusal]}` };
    }
    const runner = this.liveRunner(slug);
    if (runner?.isolatePhase(phase, by)) return { ok: true, run: runner.current()! };
    const state = this.editStoredRun(slug, (run) => {
      const list = run.isolatePhases ??= [];
      if (!list.includes(phase)) list.push(phase);
    });
    this.scheduler.poll();
    return state ? { ok: true, run: state } : { ok: false, status: 409, error: `No run of ${slug} to isolate phase ${phase} in.` };
  }

  /**
   * Prepare phase N's ERRAND TREE (control-tower phase 90, #123): a stable
   * checkout at the pushed run branch under `.worktrees/hand/`, for the
   * commands a person's errand gives — never the run's own mirror, which is
   * pruned on the console's schedule. Named on the phase's record, which the
   * errand card reads.
   */
  async errandTree(slug: string, phase: number, by = 'console'): Promise<
    { ok: true; tree: NonNullable<RunPhaseRecord['errandTree']>; adopted: boolean } | { ok: false; status: number; error: string }
  > {
    if (!Number.isInteger(phase) || phase < 1) return { ok: false, status: 400, error: 'a phase number is required' };
    const runner = this.liveRunner(slug);
    if (runner?.current()) {
      const made = await runner.prepareErrandTree(phase, by);
      return made.ok ? made : { ok: false, status: 409, error: made.error };
    }
    if (!this.root?.ok) return { ok: false, status: 409, error: 'no root' };
    const root = this.root.path;
    const stored = latestRun(root, slug, this.liveRunIds());
    if (!stored) return { ok: false, status: 409, error: `${slug} has no run to prepare an errand tree for.` };
    // A stopped run: the same tree from the stored record's mounts, each a
    // submodule path of the root.
    const mounts = stored.mountedRepos?.length ? mountsFromRepos(root, stored.mountedRepos) : undefined;
    const made = await ensureErrandTree({ root, slug, phase, ...(mounts ? { mounts } : {}) });
    if (!made.ok) return { ok: false, status: 409, error: made.detail ?? 'the errand tree could not be made' };
    const tree = {
      dir: made.dir, at: new Date().toISOString(), by,
      mounts: made.mounts.map((mount) => ({ rel: mount.rel, sha: mount.sha, pushed: mount.pushed })),
    };
    this.editStoredRunById(slug, stored.id, (run) => { phaseRecord(run, phase).errandTree = tree; });
    return { ok: true, tree, adopted: made.adopted };
  }

  /**
   * Move ONE queued entry to the front of its class. See `Scheduler.bump`.
   *
   * By entry id rather than slug+phase, because that is what a queue page has
   * in hand and because a run may legitimately have several entries waiting —
   * bumping "the plan" would silently pick one of them.
   */
  bumpQueueEntry(entryId: string, who: Actor | string = 'console'): boolean {
    // A bump is a person's decision about ONE run's phase, and it lived in
    // `console.log` alone (#128); since control-tower phase 96 (#142) it is
    // written on that run with who and why, and since phase 99 (#135) the mark
    // is on the phase's record, so it outlives the entry.
    return this.queueControl('bump', { entryId }, asActor(who, 'Service.bumpQueueEntry')).ok;
  }

  /**
   * An operator's word on one phase's place in the queue (control-tower phase
   * 99, #135 B and E) — the ONE door `POST /api/queue/<verb>` and the verb
   * table's `bump` go through. The target is a queued entry (`entryId`) or any
   * phase of a run (`{slug, phase}`) — a hinted phase is queued from the view
   * this way, and a stopped run's phase takes the mark on its stored record,
   * so it boards carrying it. A live run's runner applies it (the record, the
   * entry, the journal, a wake); a stopped run's record is edited here with the
   * same function (`applyQueueControl`) and journalled on that run.
   */
  queueControl(
    verb: string,
    target: { entryId?: string; slug?: string; phase?: number },
    who: Actor | string,
    opts: {
      until?: string; position?: 'front'; phases?: readonly number[];
      /** `reserve`: the live lane whose end it waits for, and whether a yield made it (control-tower phase 100). */
      lane?: { slug: string; phase: number }; via?: 'yield';
    } = {},
  ): { ok: true; slug: string; phase: number | null; changed: boolean } | { ok: false; status: number; error: string } {
    const actor = asActor(who, 'Service.queueControl');
    // Phase 99's words, and the lane marks (control-tower phase 100): a pin and a kept lane.
    const verbs: readonly string[] = [...QUEUE_VERBS, ...LANE_MARK_VERBS];
    if (!verbs.includes(verb)) {
      return { ok: false, status: 404, error: `no queue verb ${verb} — one of ${verbs.join(', ')}` };
    }
    let { slug, phase } = target;
    let runId: string | undefined;
    const entryId = target.entryId;
    if (entryId) {
      const entry = this.scheduler.entry(entryId);
      if (!entry) return { ok: false, status: 404, error: `no queued entry ${entryId} — it may have started already` };
      ({ slug, runId } = entry);
      phase = entry.phase ?? undefined;
    }
    if (!slug) return { ok: false, status: 400, error: 'pass {entryId}, or {slug, phase} — the entry to act on' };
    const plan = this.store?.get(slug)?.plan;
    const inPlan = (n: number): boolean => !plan || Boolean(plan.phases[n] || titleOf(plan.graph ?? [], n));
    const runner = this.liveRunner(slug);
    const live = runner?.current();
    const onLive = Boolean(runner && live && (!runId || live.id === runId));

    if (verb === 'reorder') {
      const phases = (opts.phases ?? []).map(Number);
      const missing = phases.filter((n) => !inPlan(n));
      if (missing.length) return { ok: false, status: 404, error: `${slug} has no phase ${missing.join(', ')}` };
      if (onLive) {
        const out = runner!.reorderQueue(phases, actor);
        return out.ok ? { ok: true, slug, phase: null, changed: true } : out;
      }
      let refused: { ok: false; status: number; error: string } | null = null;
      const stored = this.editStoredRun(slug, (state) => {
        const list = [...new Set(phases)].filter((n) => Number.isInteger(n) && n > 0);
        if (!list.length) { refused = { ok: false, status: 400, error: 'pass {phases: [N, …]} — the order you want' }; return; }
        const base = this.scheduler.nextStamp();
        list.forEach((n, index) => { applyQueueControl(phaseRecord(state, n), 'bump', actor, { stamp: base + (list.length - 1 - index) }); });
        journalOf(state)(QUEUE_REORDERED_EVENT, { ...actor, stored: true, phases: list });
      });
      if (refused) return refused;
      return stored ? { ok: true, slug, phase: null, changed: true } : { ok: false, status: 404, error: `No run of ${slug} to reorder.` };
    }

    if (phase == null || !Number.isSafeInteger(phase) || phase < 1) {
      return { ok: false, status: 400, error: 'pass {entryId}, or {slug, phase} — the entry to act on' };
    }
    if (!inPlan(phase)) return { ok: false, status: 404, error: `${slug} has no phase ${phase}` };
    const act = verb as PhaseQueueVerb;
    const until = opts.until;
    const position = opts.position === 'front' ? 'front' as const : undefined;
    const lane = opts.lane;
    const via = opts.via;
    if (onLive) {
      const out = runner!.queueControl(phase, act, actor, {
        ...(until ? { until } : {}), ...(position ? { position } : {}), ...(lane ? { lane } : {}), ...(via ? { via } : {}),
      });
      return out.ok ? { ok: true, slug, phase, changed: out.changed } : out;
    }
    // A stopped run: its record takes the word, so the run boards with it.
    let result: QueueControlResult | null = null;
    const target2 = phase;
    const edit = (state: RunState): void => {
      // A pin or a kept lane never widens a scoped run (control-tower phase 100).
      const refusal = laneMarkRefusal(state, target2, act);
      if (refusal) { result = { ok: false, status: 409, error: refusal }; return; }
      result = applyQueueControl(phaseRecord(state, target2), act, actor, {
        ...(until ? { until } : {}), ...(position ? { position } : {}), ...(lane ? { lane } : {}), ...(via ? { via } : {}),
        nextStamp: () => this.scheduler.nextStamp(),
      });
      if (result.ok && result.changed) {
        journalOf(state)(result.change.event, { ...result.change.data, stored: true, ...(entryId ? { entryId } : {}) }, target2);
      }
    };
    const stored = runId ? this.editStoredRunById(slug, runId, edit) : this.editStoredRun(slug, edit);
    if (!stored || !result) return { ok: false, status: 404, error: `No run of ${slug} to act on.` };
    const done = result as QueueControlResult;
    if (!done.ok) return done;
    // An entry still waiting for this run (a console that holds it) takes the word too.
    const entry = entryId ? this.scheduler.entry(entryId) : this.scheduler.entryOf(stored.id, phase);
    if (entry && done.changed) {
      const control = done.change.control;
      if (act === 'withdraw') this.scheduler.withdrawEntry(entry.id);
      else if (control.bump && (act === 'bump' || act === 'requeue')) this.scheduler.bump(entry.id, control.bump);
      else this.scheduler.markEntry(entry.id, { hold: control.hold ?? null, defer: control.defer ?? null, pin: control.pin ?? null });
    }
    // A kept lane stands in the scheduler whether or not the phase has an entry.
    if (done.changed && (act === 'reserve' || act === 'unreserve')) {
      const kept = done.change.control.reserve;
      if (kept) {
        this.scheduler.reserveLane({
          slug, runId: stored.id, phase, at: kept.at, by: kept.by,
          ...(kept.reason ? { reason: kept.reason } : {}), ...(kept.lane ? { lane: kept.lane } : {}),
        });
      } else {
        this.scheduler.unreserveLane(stored.id, phase);
      }
    }
    return { ok: true, slug, phase, changed: done.changed };
  }

  /**
   * Hand a LIVE lane to another phase (control-tower phase 100, #135 D.15):
   * the lane is reserved for the named phase — or the head of the queue — so
   * the moment it ends it goes there in the same scan, never to a sibling's
   * re-board (#134); and the session holding it is asked to hand off at its
   * next safe point, through the same steer a person's would be. Journalled on
   * the yielding run. A phase with no live lane has nothing to yield (409).
   */
  yieldLane(
    target: { slug?: string; phase?: number },
    to: { slug: string; phase: number } | undefined,
    who: Actor | string,
  ): { ok: true; to: { slug: string; phase: number } | null; steered: boolean; why?: string } | { ok: false; status: number; error: string } {
    const actor = asActor(who, 'Service.yieldLane');
    const { slug, phase } = target;
    if (!slug || phase == null || !Number.isSafeInteger(phase)) return { ok: false, status: 400, error: 'pass {slug, phase} — the lane to yield' };
    const snapshot = this.scheduler.snapshot();
    const lane = snapshot.grants.find((grant) => grant.slug === slug && grant.phase === phase);
    if (!lane) return { ok: false, status: 409, error: `${slug} P${phase} holds no live lane on this console — there is nothing to yield` };
    let next: { slug: string; phase: number } | null = to ?? null;
    if (!next) {
      const head = [...snapshot.entries]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .find((entry) => entry.phase != null && !(entry.slug === slug && entry.phase === phase));
      if (head) next = { slug: head.slug, phase: head.phase! };
    }
    if (next) {
      const kept = this.queueControl('reserve', next, actor, { lane: { slug, phase }, via: 'yield' });
      if (!kept.ok) return kept;
    }
    const text = `The operator asked this lane to yield${next ? ` to ${next.slug} P${next.phase}` : ''}${actor.reason ? ` — ${actor.reason}` : ''}. `
      + 'Hand off at the next safe point: finish the step you are on, commit only what you have run green, write the handoff '
      + `in-progress naming what remains, declare \`phase-outcome.sh ${slug} ${phase} partial --reason other\`, and stop. `
      + `Your phase re-queues by itself${next ? `; the lane is kept for ${next.slug} P${next.phase}` : ''}.`;
    const steer = this.steerRun(slug, text, actor.by, undefined, phase, actor.reason);
    const steered = Boolean(steer.ok);
    const data = { ...actor, ...(next ? { to: next } : {}), steered, ...(steered ? {} : { why: steer.reason ?? 'not steered' }) };
    const runner = this.liveRunner(slug);
    if (runner && runner.current()?.id === lane.runId) runner.note(LANE_YIELDED_EVENT, data, phase);
    else this.editStoredRunById(slug, lane.runId, (state) => { journalOf(state)(LANE_YIELDED_EVENT, { ...data, stored: true }, phase); });
    return { ok: true, to: next, steered, ...(steered ? {} : { why: steer.reason ?? 'not steered' }) };
  }

  /**
   * Choose the scheduling policy (control-tower phase 100, #135 F.24) — the
   * console's, or one plan's over it (`slug`; `null` gives the plan back to the
   * console's) — and the machine-load guard's factor (#135 G.27; 0 is off).
   * Stored in the console's preferences; read per scan, so the next scan uses it.
   */
  setSchedulingPolicy(
    change: { policy?: string | null; slug?: string; loadFactor?: number },
    who: Actor | string,
  ): { ok: true } | { ok: false; status: number; error: string } {
    const actor = asActor(who, 'Service.setSchedulingPolicy');
    const next = { ...this.prefs };
    if (change.policy !== undefined) {
      if (change.policy !== null && !isSchedulingPolicy(change.policy)) {
        return { ok: false, status: 400, error: `no scheduling policy ${String(change.policy)} — one of seniority, blocker-first, critical-path` };
      }
      if (change.slug) {
        const plans = { ...(next.schedulingPolicies ?? {}) };
        if (change.policy === null) delete plans[change.slug]; else plans[change.slug] = change.policy;
        next.schedulingPolicies = plans;
      } else if (change.policy === null) {
        return { ok: false, status: 400, error: 'the console always has a policy: name one, or pass {slug} to give a plan back to it' };
      } else {
        next.schedulingPolicy = change.policy;
      }
    }
    if (change.loadFactor !== undefined) {
      if (typeof change.loadFactor !== 'number' || !Number.isFinite(change.loadFactor) || change.loadFactor < 0) {
        return { ok: false, status: 400, error: 'the load factor is a number ≥ 0 (0 switches the guard off)' };
      }
      next.loadGuardFactor = change.loadFactor;
    }
    this.prefs = next;
    savePrefs(this.prefs);
    log.info('queue.policy-set', {
      ...actor, ...(change.slug ? { slug: change.slug } : {}),
      ...(change.policy !== undefined ? { policy: change.policy } : {}), ...(change.loadFactor !== undefined ? { loadFactor: change.loadFactor } : {}),
    });
    // The next scan orders by it — and a guard switched off admits at once.
    this.scheduler.poll();
    return { ok: true };
  }

  /** The policies as the queue page and the API show them. */
  schedulingPolicies(): { console: string; plans: Record<string, string>; default: string } {
    const plans = Object.fromEntries(Object.entries(this.prefs.schedulingPolicies ?? {}).filter(([, word]) => isSchedulingPolicy(word)));
    return { console: this.schedulingPolicyFor(''), plans, default: DEFAULT_SCHEDULING_POLICY };
  }

  /** The machine-load guard's reading now (control-tower phase 100). */
  loadGuard(): ReturnType<typeof loadReading> {
    return loadReading(this.loadSample());
  }

  /**
   * The whole queue, seen (control-tower phase 99, #135 A, I, J) — `GET
   * /api/queue`: the scheduler's snapshot with every entry widened (its
   * reason, clocks, holder in words, account, title), the lanes and who each
   * holds up, the hinted and the withdrawn phases with their presses, and the
   * audit strip read off the runs' own journals. See `server/queue-view.ts`.
   */
  queueView(): ReturnType<typeof queueView> & Omit<ReturnType<Scheduler['snapshot']>, 'entries' | 'load'>
    & { policy: ReturnType<ServiceRuns['schedulingPolicies']>; load: ReturnType<typeof loadReading> } {
    const snapshot = this.queueSnapshot();
    const live = this.liveRunners().map((runner) => runner.current()).filter((state): state is RunState => Boolean(state));
    const liveIds = new Set(live.map((state) => state.id));
    const runs = [...live];
    // A stopped run's marks are the page's too: a phase withdrawn from a run
    // that has since parked is exactly the one an operator comes back for.
    if (this.root?.ok) {
      for (const record of this.store?.list() ?? []) {
        if (live.some((state) => state.slug === record.slug)) continue;
        const stored = latestRun(this.root.path, record.slug, this.liveRunIds());
        if (stored && !liveIds.has(stored.id) && Object.values(stored.phases).some((phase) => phase?.queueControl)) runs.push(stored);
      }
    }
    const audit: QueueAuditLine[] = [];
    for (const run of runs) {
      try {
        for (const line of Journal.for(run.root, run.slug, run.id).read(400)) {
          if (isQueueAuditEvent(line.event)) audit.push({ slug: run.slug, runId: run.id, at: line.time, event: line.event, phase: line.phase ?? null, data: line.data ?? {} });
        }
      } catch { /* a journal that cannot be read leaves the strip shorter, never the page down */ }
    }
    const view = queueView({
      snapshot, hinted: this.queueHinted(), runs, now: Date.now(), audit,
      title: (slug, phase) => {
        const plan = this.store?.get(slug)?.plan;
        return plan?.phases[phase]?.title || titleOf(plan?.graph ?? [], phase);
      },
    });
    // The policy and the load guard (control-tower phase 100): what orders the
    // queue and what may be holding all of it, beside it.
    return { ...snapshot, ...view, policy: this.schedulingPolicies(), load: this.loadGuard() };
  }

  /* ---------------------------------------------------------------- *
   * Fleet freeze — the panic button
   * ---------------------------------------------------------------- */

  /**
   * Freeze everything: every live lane where it stands, and every list.
   *
   * Three acts, and the order is load-bearing. The MARKER goes down first, so
   * that anything firing in the microseconds while the lanes are being
   * signalled already finds the console frozen — a queue entry admitted
   * between the first SIGSTOP and the last would be a session started by the
   * very act of stopping. Then every live run is frozen through the ordinary
   * per-lane verb, in its **standing** form (no `escalateAt`, so nothing
   * converts on a clock — see `Runner.freeze`). Then one poll, so the queue
   * page re-renders with the fleet holder named against every waiting entry.
   *
   * Nothing is done to the queued and waiting lists themselves, and that is
   * the design rather than an omission: a queued entry stays queued and a
   * waiting run keeps its own `waitUntil`, because the scheduler's fleet
   * holder and the fire-time gates make both of them harmless. Moving them
   * into some third state would be work the thaw then has to undo, and every
   * undo is a chance to put something back differently from how it was.
   */
  freezeFleet(by = 'console'): { ok: boolean; reason?: string; frozen: FleetHold | null; runs: number } {
    const already = this.fleetHold();
    // A machine hold (or a restart's) is not this console's freeze: it holds
    // automatic starts and leaves live sessions running, so Freeze-all still
    // has work to stop.
    if (already && !already.scope) {
      return { ok: false, reason: 'the console is already frozen', frozen: already, runs: 0 };
    }
    const hold = this.markFleetFrozen(by);
    let runs = 0;
    for (const runner of this.liveRunners()) {
      // Standing: a fleet freeze has no deadline, so it must write none.
      // `phase: undefined` means every lane of the run — freezing the mirror
      // lane of three would leave two sessions editing under a console the
      // operator had just called frozen.
      try {
        if (runner.freeze(by, undefined, { standing: true })) runs += 1;
      } catch (error) {
        log.warn('fleet.freeze-run-failed', { slug: runner.current()?.slug ?? null, error });
      }
    }
    // …and every run this console is NOT driving. A restart mid-freeze leaves a
    // clocked lane freeze on disk with a boot timer armed for it, so the
    // conversion `Runner.freeze(…, {standing})` does for live lanes has to
    // happen for those as well — otherwise one of them is `killLadder`'d
    // fifteen minutes into a freeze the banner calls standing. (The armed timer
    // is left alone: `escalateFrozenRun` reads the fleet hold at FIRE time, and
    // after the thaw a record with no `escalateAt` answers `none` anyway.)
    const converted = this.standDownStoredClocks(by);
    log.info('fleet.frozen', { by, at: hold.at, runs, converted });
    // The scan re-labels every waiting entry with the fleet holder, and the
    // announcement is what carries that to the queue page.
    this.scheduler.poll();
    this.emitFleet();
    return { ok: true, frozen: hold, runs };
  }

  /**
   * Thaw everything, exactly where it was.
   *
   * The mirror image, and the order is again the point: the marker comes UP
   * first so that the lanes waking mid-token find a console that will let them
   * carry on, then every frozen run is thawed through the ordinary verb, then
   * the three resumptions the freeze deferred:
   *
   *  - one `scheduler.poll()` — the queued entry admits, subject to the
   *    ordinary scope rules, exactly as if it had just arrived;
   *  - one `readoptQueued()` — the pass that re-arms the boot clocks. This is
   *    where an overdue wait fires: its `waitUntil` is still on disk and the
   *    re-arm computes a negative delay, which `setTimeout` runs on the next
   *    tick. Once, because the timer map is keyed per plan;
   *  - one converge kick per plan — the healer's ordinary trigger, so a run
   *    that halted during the freeze is picked up rather than waiting out a
   *    whole sweep interval.
   */
  async thawFleet(by = 'console'): Promise<{ ok: boolean; reason?: string; runs: number }> {
    const hold = this.fleetHold();
    if (!hold) return { ok: false, reason: 'the console is not frozen', runs: 0 };
    // A refusal, not a warning. `clearFleetHold` throws when the marker is
    // still on disk afterwards, and the alternative — nulling the cache anyway
    // — is a process that believes it thawed over a file the next boot reads as
    // a freeze nobody asked for. Nothing has been woken yet at this point, so
    // returning here leaves the fleet exactly as it was.
    try {
      this.markFleetThawed();
    } catch (error) {
      return { ok: false, reason: (error as Error)?.message ?? 'the freeze marker could not be removed', runs: 0 };
    }
    let runs = 0;
    for (const runner of this.liveRunners()) {
      try {
        if (runner.thaw()) runs += 1;
      } catch (error) {
        log.warn('fleet.thaw-run-failed', { slug: runner.current()?.slug ?? null, error });
      }
    }
    // …and every run this console is NOT driving. After a restart mid-freeze
    // the pool is empty by construction: the children are SIGSTOPped under
    // PPID 1, the freeze is on disk, and a standing freeze has no escalation
    // clock to end it. A thaw that only walked `liveRunners()` would clear the
    // marker and leave them stopped for ever — the original incident, reached
    // through the undo rather than the do.
    const woken = await this.thawStoredFreezes();
    log.info('fleet.thawed', { by, frozenAt: hold.at, runs, stored: woken });
    this.scheduler.poll();
    this.emitFleet();
    // Re-arm what the freeze declined to fire. Awaited so a caller — and a
    // test — can know the fleet is genuinely back rather than about to be.
    try {
      // The thaw is the operator's own press: a wait whose clock went by during
      // the freeze is still RULED ON (lateness, refs, budget, counted) — the
      // press only answers the question a restart would otherwise have asked.
      await this.readoptQueued({ trigger: 'button', operatorPress: true });
    } catch (error) {
      log.warn('fleet.thaw-readopt-failed', { error });
    }
    for (const slug of this.convergeSlugs()) this.converger.request(slug, 'timer', 0);
    return { ok: true, runs };
  }

  /**
   * Drop the escalation clock from every STORED freeze — the fleet freeze's
   * conversion, for runs no live runner owns.
   *
   * The live half lives in `Runner.freeze(…, {standing})`. This is the other
   * rail, and it exists because a console restarted over a clocked freeze arms
   * a boot timer for it: without this, a Freeze-all pressed afterwards would be
   * a standing freeze on the banner and a fifteen-minute execution order on
   * disk. Returns how many records were converted.
   */
  private standDownStoredClocks(by: string): number {
    if (!this.root?.ok) return 0;
    let converted = 0;
    for (const record of this.store?.list() ?? []) {
      if (this.liveRunner(record.slug)) continue;
      const state = latestRun(this.root.path, record.slug, this.liveRunIds());
      if (!state) continue;
      const clocked = frozenEntries(state).some((entry) => entry.freeze.escalateAt);
      if (!clocked) continue;
      this.editStoredRunById(record.slug, state.id, (run) => {
        for (const child of childrenOf(run)) {
          if (child.frozen?.escalateAt) { delete child.frozen.escalateAt; converted += 1; }
        }
        if (run.freeze?.escalateAt) { delete run.freeze.escalateAt; converted += 1; }
      });
      log.info('fleet.freeze-stand-down', { slug: record.slug, runId: state.id, by });
    }
    return converted;
  }

  /**
   * Wake every frozen session on disk that no live runner owns.
   *
   * The stored counterpart of `Runner.thaw()`, through the same module the boot
   * escalation uses (`thawPersistedFreeze` — wake first, then clear, the rule
   * phase 15 wrote in blood). Returns how many sessions were actually
   * signalled, which is the number worth journalling: it is the difference
   * between "there was nothing to wake" and "we woke four orphans".
   */
  private async thawStoredFreezes(): Promise<number> {
    if (!this.root?.ok) return 0;
    let woken = 0;
    for (const record of this.store?.list() ?? []) {
      if (this.liveRunner(record.slug)) continue;
      const state = latestRun(this.root.path, record.slug, this.liveRunIds());
      if (!state?.freeze && !frozenEntries(state ?? ({} as RunState)).length) continue;
      // WARM FIRST, and this is the one caller in the console that must.
      // `thawPersistedFreeze` signals only what the probe calls `stopped`, and
      // the synchronous `processState` answers `running` for a pid whose sample
      // it has never taken — the `kill(0)` floor, which is the safe direction
      // for a READER and exactly the wrong one for the only actor whose
      // "do nothing" is permanent. Its sibling `escalatePersistedFreeze` asks
      // `!== 'gone'`, which the floor already satisfies, so this is the single
      // path that needs a real sample: a SIGSTOPped orphan left unwoken here is
      // stopped for ever, because a standing freeze has no clock to come back.
      await warmPids(frozenEntries(state!).map((entry) => entry.pid).filter((pid): pid is number => !!pid));
      const edited = this.editStoredRunById(record.slug, state!.id, (run) => {
        for (const entry of thawPersistedFreeze(run)) if (entry.woken) woken += 1;
        // A run whose word was `frozen` has to stop saying so, or nothing can
        // move it: `thaw()`'s lane path re-derives this through
        // `syncFrozenStatus`, and there is no lane table here to do it with.
        if (run.status === 'frozen') { setRunState(run, 'paused'); run.stoppedBy = 'operator'; }
      });
      if (edited) log.info('fleet.thaw-stored', { slug: record.slug, runId: edited.id });
    }
    return woken;
  }

  /**
   * Tell every open page at once, on ONE event.
   *
   * `run:queue` and not a new event name, because it already carries exactly
   * the two invalidations a fleet freeze needs — the queue (every entry's
   * holder just changed) and `/api/state` (where the banner reads `fleet`).
   * A second event would be a second thing to keep in step for no fact the
   * first does not already deliver.
   */
  private emitFleet(): void {
    this.emit('run:queue', { ...this.concurrency(), fleet: this.fleetState() });
  }


  /**
   * What is worth knowing about the queue that costs something to work out.
   *
   * Remaining plan weight and an ETA per QUEUED run — the two figures that
   * turn "three plans are waiting" into an order worth choosing. Advisory in
   * the strict sense: nothing here reorders anything, and the scheduler never
   * reads it. The operator does, and then uses `priority` or `bump` if they
   * disagree with what they see.
   *
   * Computed on request and never stored. It is derived from each plan's board
   * and its rate history, both of which move, so a cached copy would be a
   * second answer that disagrees with the plan page.
   *
   * Deliberately NOT folded into `queueSnapshot()`: that snapshot rides the
   * `run:queue` SSE event and the whole `state` payload, both emitted on every
   * admission change, and putting a board read per queued plan on those paths
   * would charge every reader for something one page asked for. It hangs off
   * `GET /api/queue` instead, where asking IS the request.
   *
   * One row per distinct SLUG, not per entry: three phases of one plan queued
   * behind one scope share a board and an estimate, and three copies of it
   * would read as three different pieces of information.
   */
  /**
   * How much longer `slug` has, SYNCHRONOUSLY, or nothing when nobody knows yet.
   *
   * The scheduler's admission scan cannot await (see `SchedulerDeps.etaFor`),
   * and `runEta` reads a board, which is asynchronous. So this answers from a
   * memo and, on a miss or a stale entry, starts the refresh that will make the
   * NEXT scan able to answer. Self-warming: the first queue scan after a plan
   * starts blocking somebody returns nothing and asks; the second says how long.
   *
   * 🔴 `undefined` is a real answer and must stay one. A plan with nothing
   * finished has no measurable rate, and a fabricated number here would be
   * indistinguishable on the page from a measured one — the same rule
   * `QueueAdvice`'s nullable fields keep.
   */
  etaHint(slug: string): HolderEta | undefined {
    const hit = this.etaHints.get(slug);
    const fresh = hit && Date.now() - hit.at < ETA_HINT_MS;
    if (!fresh) this.refreshEtaHint(slug);
    return hit?.value;
  }

  /**
   * Fill one plan's ETA memo, at most once at a time.
   *
   * Fire-and-forget on purpose, and every failure is a stored `undefined`
   * rather than a throw: this is decoration, and decoration that can reject
   * into an admission scan is worse than no decoration. The in-flight set is
   * what stops a queue of nine entries from one plan asking nine times.
   */
  protected refreshEtaHint(slug: string): void {
    if (this.etaHintsInFlight.has(slug)) return;
    this.etaHintsInFlight.add(slug);
    void this.runEta(slug)
      .then((eta) => {
        this.etaHints.set(slug, {
          at: Date.now(),
          value: eta ? {
            remainingWeight: eta.remainingWeight, label: eta.label,
            // A branch holder is a whole run (#150): its phases left ride too.
            ...(typeof eta.remainingPhases === 'number' ? { remainingPhases: eta.remainingPhases } : {}),
          } : undefined,
        });
      })
      .catch(() => this.etaHints.set(slug, { at: Date.now(), value: undefined }))
      .finally(() => this.etaHintsInFlight.delete(slug));
  }

  /**
   * How much longer a queue HOLDER has, SYNCHRONOUSLY — `SchedulerDeps.etaFor`
   * (control-tower phase 60, #63).
   *
   * With a phase, that PHASE's remaining working time: its estimate (phase
   * 58's model — the plan's rate at its weight, never under a declared floor)
   * minus the working time its own record has already put in, never under the
   * residual `holderRemaining` measures. The scope is released when the holder
   * PHASE ends, so this is the granularity of the wait; for a sibling of the
   * waiter's own run it no longer counts the waiter and everything after it,
   * which the whole-plan figure did. Answered from memory — the live runner's
   * record, else the plan's latest stored run — memoised for `ETA_HINT_MS`.
   *
   * Without a phase, the plan's remaining (`etaHint`), labelled `plan
   * remaining` so no surface can read it as the wait.
   */
  holderEta(slug: string, phase: number | null): HolderEta | undefined {
    if (phase == null) return planRemainingEta(this.etaHint(slug));
    const key = `${slug}:${phase}`;
    const hit = this.holderEtas.get(key);
    if (hit && Date.now() - hit.at < ETA_HINT_MS) return hit.value;
    let value: HolderEta | undefined;
    try { value = this.phaseHolderEta(slug, phase); } catch { value = undefined; }
    this.holderEtas.set(key, { at: Date.now(), value });
    return value;
  }

  /** Memo behind `holderEta`, keyed `slug:phase`. */
  protected holderEtas = new Map<string, { at: number; value: HolderEta | undefined }>();

  private phaseHolderEta(slug: string, phase: number): HolderEta | undefined {
    const plan = this.store?.get(slug)?.plan;
    if (!plan?.phased || !this.root?.ok || !plan.phases[phase]) return undefined;
    const rate = this.planRate(slug);
    if (!(rate.floorMs + rate.slopeMsPerWeight > 0)) return undefined;
    const weight = this.weightOfPhase(plan, phase);
    const floorMs = etaPhaseFacts(plan, (p) => this.weightOfPhase(plan, p)).get(phase)?.floorMs ?? 0;
    const run = this.liveRunner(slug)?.current() ?? latestRun(this.root.path, slug, this.liveRunIds());
    const record = run?.phases[String(phase)];
    const workedMs = record ? (phaseClocks(record, Date.now()).workedMs ?? 0) : 0;
    const left = holderRemaining(estimateMs(rate, weight, floorMs), rate.spread, workedMs);
    return {
      of: 'phase', label: left.label,
      remainingMs: Math.round(left.remainingMs), lowMs: Math.round(left.lowMs), highMs: Math.round(left.highMs),
      ...(left.overrun ? { overrun: true as const } : {}),
    };
  }

  async queueAdvice(): Promise<QueueAdvice[]> {
    const slugs = [...new Set(this.scheduler.snapshot().entries.map((entry) => entry.slug))];
    const out: QueueAdvice[] = [];
    for (const slug of slugs) {
      // Sequential rather than `Promise.all`: each call reads that plan's
      // board, cached per plan revision, and a fan-out would race several
      // engine runs for plans about to answer from cache anyway.
      const eta = await this.runEta(slug).catch(() => null);
      out.push({
        slug,
        remainingWeight: eta?.remainingWeight ?? null,
        remainingPhases: eta?.remainingPhases ?? null,
        // The hedged range the plan page shows, or null when nothing has ever
        // finished — the honest answer the first time anyone asks.
        label: eta?.label ?? null,
      });
      // One computation, two readers: this endpoint already paid for the board
      // read, so the queue's synchronous hint takes its answer from here rather
      // than asking for the same thing again a moment later.
      this.etaHints.set(slug, {
        at: Date.now(),
        value: eta ? {
          remainingWeight: eta.remainingWeight, label: eta.label,
          ...(typeof eta.remainingPhases === 'number' ? { remainingPhases: eta.remainingPhases } : {}),
        } : undefined,
      });
    }
    // Heaviest first: the ordering an operator most often wants to act on. An
    // unknown weight sorts LAST rather than as zero, so a plan nothing is
    // known about never looks like the cheapest one to run.
    return out.sort((a, b) => (b.remainingWeight ?? -1) - (a.remainingWeight ?? -1));
  }

  /**
   * Resume: take back a pause the live loop has not reached yet, or lift one
   * that has SETTLED (control-tower phase 77, #102).
   *
   * It used to do only the first. `pause` then `resume` on a run with no live
   * lane left it `paused` — the pause settled before the press arrived, and
   * the press did nothing — and the only way back was `start {resumeRunId}`
   * with the whole settings body re-sent by hand. A settled pause is now
   * started again through the one door, naming nothing but the run: its own
   * settings stand (RS-1..3). The answer names which of the two happened.
   *
   * A STOPPED run is started again the same way (control-tower phase 110,
   * #176): parked, halted, or interrupted by its console's exit — Continue,
   * naming nothing but the run, so its own settings stand. The supervisor's
   * remedy for a parked run with ready work pressed this verb, and every press
   * read "No pause … Continue brings it back" while the run sat for 6.6 hours.
   * An automatic press still never lifts what only a person may: a halt in
   * `PRESS_ONLY_HALT_KINDS`, a run a person stopped, or one a person dismissed.
   */
  async resumeRun(slug: string, actor: StartActor): Promise<ResumeAnswer> {
    const runner = this.liveRunner(slug);
    const live = runner?.current() ?? null;
    if (runner && live && runner.resumePause()) {
      return { ok: true, run: runner.current() ?? live, resumed: { runId: live.id, from: 'pausing', act: 'pause-cancelled' } };
    }
    const stored = !runner && this.root?.ok ? latestRun(this.root.path, slug, this.liveRunIds()) : null;
    const from = stored && RESUMED_FROM.find((status) => status === stored.status);
    if (!stored || !from) {
      const is = live ?? stored;
      return {
        ok: false, status: 409,
        error: `No pause of ${slug} to take back or lift — ` + (is ? `its run is ${is.status}.` : 'it has no run.'),
      };
    }
    if (from !== 'paused' && isAutomatic(actor)) {
      const refused = automaticResumeRefusal(stored);
      if (refused) return { ok: false, status: 409, error: `${slug} was not resumed — ${refused}` };
    }
    // Under a hold that binds this plan the start below would only queue behind
    // it: a 200 that changes nothing, which is what an operator got for seven
    // minutes on 2026-09-24 (control-tower phase 81, #93). Say which hold, and
    // the one act that ends it, instead.
    const held = this.fleetHoldFor(slug);
    if (held) {
      return { ok: false, status: 409, error: `${slug} was not resumed — ${fleetHoldSentence(held)}.` };
    }
    // A run whose phases wait on parks (control-tower phase 111, #179) reads
    // `paused` with no loop behind it. A person's Continue cuts the windows
    // that have nothing real left to wait for — or refuses, saying why, when
    // the relaunch could only park the run again on the same clock, which is
    // what it did 72 s after the press. An automatic press cuts nothing.
    if (!isAutomatic(actor)) {
      const cut = await this.cutWaitsForResume(slug, stored, actor);
      if (!cut.ok) return { ok: false, status: 409, error: `${slug} was not resumed — ${cut.why}` };
    }
    try {
      const run = await this.startRun(slug, { actor: actor, resumeRunId: stored.id });
      return { ok: true, run, resumed: { runId: stored.id, from, act: 'relaunched' } };
    } catch (error) {
      return { ok: false, status: 409, error: (error as Error).message };
    }
  }

  /**
   * A person's Continue on a run waiting on parks (control-tower phase 111,
   * #179). Each phase whose window is still ahead is asked what it waits on:
   *
   *   - a WATCHDOG park is the console's own inference — cut;
   *   - a declared wait is re-asked NOW, ref by ref, through the watch clock's
   *     one-ref probe: one that has landed cuts the window (#179's second
   *     shape: a satisfied `cmd:` ref sat 12 minutes, its resume undone);
   *   - a wait still standing refuses the resume, naming the ref and what it
   *     read — when nothing was cut and nothing else is ready, since the
   *     relaunch would only park it again; the account's usage window always.
   *
   * A cut writes the window's end as NOW, which the loop admits as an expired
   * wait and resumes the phase's own session; `phase.wait-cut` says who cut
   * which park. Nothing is written when anything refuses.
   */
  private async cutWaitsForResume(
    slug: string, stored: RunState, actor: StartActor,
  ): Promise<{ ok: true } | { ok: false; why: string }> {
    const now = Date.now();
    const waiting = Object.values(stored.phases ?? {})
      .filter((record) => record?.status === 'waiting' && record.parkedUntil && Date.parse(record.parkedUntil) > now)
      .sort((a, b) => a.phase - b.phase);
    const cuts: { phase: number; was: string; parker: string; ref?: string; read?: string }[] = [];
    const standing: string[] = [];
    for (const record of waiting) {
      const declared = record.declared;
      if (declared?.by === 'watchdog') {
        cuts.push({ phase: record.phase, was: record.parkedUntil!, parker: 'watchdog' });
        continue;
      }
      if (record.usageWall) {
        return { ok: false, why: `phase ${record.phase} waits on its account's usage window until ${record.parkedUntil} — switch the run's account, or let the window open` };
      }
      const refs = pollableRefs(declared?.watch ?? record.watch ?? []);
      const reads: string[] = [];
      let landed: WatchState | null = null;
      for (const target of refs) {
        const verdict = await this.watchClock.probeNow(target.ref);
        if (verdict.state === 'landed') { landed = verdict; break; }
        reads.push(`${target.ref} (${verdict.state}${verdict.detail ? `: ${verdict.detail}` : ''})`);
      }
      if (landed) {
        cuts.push({
          phase: record.phase, was: record.parkedUntil!, parker: declared?.by ?? 'session', ref: landed.ref,
          ...(landed.detail ? { read: landed.detail } : {}),
        });
        continue;
      }
      standing.push(refs.length
        ? `phase ${record.phase} waits on ${reads.join(', ')}, which has not landed; it resumes when it does, `
          + `or at ${record.parkedUntil} — Retry the phase to board it now`
        : `phase ${record.phase} waits until ${record.parkedUntil} on a wait that names no ref the console can check — `
          + 'Retry the phase to board it now');
    }
    // Nothing cut, a wait still standing, and nothing else for the loop to
    // board: the relaunch would only park the run again. Said, not done.
    if (!cuts.length && standing.length) {
      const board = await this.board(slug).catch(() => null);
      const parked = new Set(waiting.map((record) => record.phase));
      const other = board && !board.error ? board.ready.filter((phase) => !parked.has(phase)) : [];
      if (!other.length) return { ok: false, why: standing[0]! };
    }
    if (!cuts.length || !this.root?.ok) return { ok: true };
    const at = new Date(now).toISOString();
    this.editStoredRunById(slug, stored.id, (run) => {
      for (const cut of cuts) {
        const record = run.phases[String(cut.phase)];
        if (record?.status === 'waiting') record.parkedUntil = at;
      }
      syncWaitClock(run);
    });
    const journal = Journal.for(this.root.path, slug, stored.id);
    for (const cut of cuts) {
      journal.append('phase.wait-cut', {
        by: actor.by ?? 'operator', parker: cut.parker, was: cut.was,
        ...(cut.ref ? { ref: cut.ref, read: cut.read ?? null } : {}),
      }, cut.phase);
    }
    return { ok: true };
  }

  /* ---------------- identity and login continuity (control-tower phase 91) ---------------- */

  /**
   * The identity behind `accountId` changed — the facade's `onIdentityChange`
   * (#131). Every run bound to another identity on that account parks: a live
   * one through its runner (nothing new boards; a lane keeps its session), a
   * stored one here, so no heal and no clock resumes it on somebody else's
   * login. Answers how many parked.
   */
  identityChanged(accountId: string, now: RunIdentity): number {
    let parked = 0;
    for (const runner of this.runners.values()) {
      try { if (runner.noteIdentityChange(accountId, now)) parked += 1; } catch { /* one run's park never stops another's */ }
    }
    if (!this.root?.ok) return parked;
    const live = this.liveRunIds();
    for (const plan of this.store?.list() ?? []) {
      let runs: RunState[] = [];
      try { runs = listRuns(this.root.path, plan.slug, live); } catch { continue; }
      for (const state of runs) {
        if (live.has(state.id) || runIsOver(state)) continue;
        if (this.parkStoredOnIdentity(state, now)) parked += 1;
      }
    }
    return parked;
  }

  /**
   * Park one stored run whose account answers another identity than the one
   * it is bound to — the runner's park, written where no loop is: the journal
   * line, the errand offering both ways on, the run-level `identity-changed`
   * halt only a press relaunches. False when nothing differs.
   */
  protected parkStoredOnIdentity(state: RunState, now: RunIdentity): boolean {
    const bound = state.identity;
    const account = state.accountId ?? DEFAULT_ACCOUNT_ID;
    if (!this.root?.ok || !bound || bound.account !== account || now.account !== account || bound.key === now.key) return false;
    if (state.halt?.kind === 'identity-changed') return false;
    const words = identityChangeWords(state.slug, bound, now);
    const at = new Date().toISOString();
    const phase = state.halt?.phase ?? state.activePhase ?? undefined;
    const errand: Errand = { ...errandFor('resource-wall:auth', [], phase ?? 0, at, null), need: words.need, how: words.how };
    const park = (stored: RunState) => {
      setRunState(stored, 'halted');
      stored.stoppedBy = 'system';
      stored.halt = { at, reason: words.halt, ...(phase != null ? { phase } : {}), kind: 'identity-changed' };
      stored.resolved = null;
      stored.errand = errand;
      stored.finishedReason = words.halt;
    };
    // The caller's copy too: a heal pass holding it must not write the old stop back.
    park(state);
    this.editStoredRunById(state.slug, state.id, park);
    const journal = Journal.for(this.root.path, state.slug, state.id);
    journal.append('run.identity-changed', { account, was: identityEcho(bound), now: identityEcho(now), by: 'service' });
    journal.append('run.errand', { ...errand, reason: 'the identity behind the run\'s account changed', by: 'service' });
    return true;
  }

  /**
   * A person's answer to an identity park (#131): `continue` binds the run to
   * the identity its account answers now and resumes it there; `move` moves it
   * to a registered account that answers the identity it started on (the one
   * named, else the first `sameIdentity` finds) and resumes it there. Both are
   * journalled `run.identity-accepted` with who chose; both refuse, naming why,
   * a run that is not parked on a change, and 409 under a hold that binds the plan.
   */
  async answerIdentity(
    slug: string, choice: 'continue' | 'move', actor: StartActor, accountId?: string,
  ): Promise<{ ok: boolean; status?: number; reason?: string; accountId?: string; run?: RunState }> {
    if (!this.root?.ok) return { ok: false, status: 400, reason: 'No source directory is open.' };
    if (this.liveRunner(slug)?.current()) {
      return { ok: false, status: 409, reason: `${slug} is still draining its lanes — answer once the run has stopped` };
    }
    const state = latestRun(this.root.path, slug, this.liveRunIds());
    if (!state || state.halt?.kind !== 'identity-changed') {
      return { ok: false, status: 409, reason: `${slug}'s run is not parked on an identity change (${state?.halt?.kind ?? state?.status ?? 'no run'})` };
    }
    const held = this.fleetHoldFor(slug);
    if (held) return { ok: false, status: 409, reason: `${slug} was not resumed — ${fleetHoldSentence(held)}.` };
    const bound = state.identity;
    const from = state.accountId ?? DEFAULT_ACCOUNT_ID;
    const who = (i: RunIdentity | undefined) => i?.email ?? i?.org ?? 'nobody';
    const to = choice === 'continue' ? from : accountId ?? (bound ? this.accounts.sameIdentity(bound)[0] : undefined);
    if (!to || !this.accounts.has(to)) {
      return {
        ok: false, status: 409,
        reason: `no registered account answers ${who(bound)} — register and sign in a profile as them under Settings ▸ Accounts, or continue on the new login`,
      };
    }
    const now = this.accounts.identityOf(to === DEFAULT_ACCOUNT_ID ? undefined : to);
    if (!now) return { ok: false, status: 409, reason: `${this.accounts.labelFor(to)} names nobody right now — sign it in first` };
    if (choice === 'move' && bound?.email && now.email !== bound.email) {
      return { ok: false, status: 409, reason: `${this.accounts.labelFor(to)} answers ${who(now)}, not ${who(bound)}` };
    }
    const at = new Date().toISOString();
    this.editStoredRunById(slug, state.id, (stored) => {
      if (to !== from) {
        if (to === DEFAULT_ACCOUNT_ID) delete stored.accountId;
        else stored.accountId = to;
        stored.accountChoice = { accountId: to, from, at, by: actor.by };
        keepAccountInPool(stored);
      }
      stored.identity = { ...identityEcho(now), at };
      stored.halt = null;
      stored.errand = null;
      stored.resolved = null;
    });
    Journal.for(this.root.path, slug, state.id).append('run.identity-accepted', {
      choice, ...(bound ? { was: identityEcho(bound) } : {}), now: identityEcho(now),
      ...(to !== from ? { moved: { from, to } } : {}), by: actor.by, ...(actor.via ? { via: actor.via } : {}),
    });
    try {
      const run = await this.startRun(slug, { actor: actor, resumeRunId: state.id });
      return { ok: true, accountId: to, run };
    } catch (error) {
      return { ok: false, status: 409, reason: (error as Error).message, accountId: to };
    }
  }

  /**
   * The converge fact for an expired or signed-out stop (control-tower phase
   * 91, #147, operator decision 12): has the run's own account answered
   * `claude auth status` and a usage read since the halt, on the identity the
   * run is bound to? Asked only of a `credential-refused` halt on an `auth`
   * cause; an organisation, billing or policy refusal is never asked.
   */
  loginRestoredFor(run: RunState): boolean {
    if (run.halt?.kind !== 'credential-refused') return false;
    const phase = run.halt.phase;
    const cause = phase != null ? run.phases[String(phase)]?.cause : undefined;
    if (cause?.kind !== 'credential-refused' || cause.class !== 'auth') return false;
    try {
      return this.accounts.loginRestored(run.accountId ?? undefined, run.halt.at, run.identity?.key);
    } catch {
      return false;
    }
  }

  /**
   * A login a live or queued run depends on can no longer be renewed by this
   * console (control-tower phase 91, #147 ask 4) — announced under `limits`,
   * push and the notification inbox, with the exact fix and the runs that
   * wait on it. One nobody depends on is not announced. Answers whether it was.
   */
  loginAtRisk(view: Pick<AccountView, 'id' | 'email' | 'name'>, risk: { reason: string; fix: string }): boolean {
    if (!this.root?.ok) return false;
    const live = this.liveRunIds();
    const depends: string[] = [];
    for (const plan of this.store?.list() ?? []) {
      let runs: RunState[] = [];
      try { runs = listRuns(this.root.path, plan.slug, live); } catch { continue; }
      for (const state of runs) {
        if (runIsOver(state)) continue;
        const on = state.accountId ?? DEFAULT_ACCOUNT_ID;
        if (on === view.id || (accountPool(state) ?? []).includes(view.id)) depends.push(state.slug);
      }
    }
    if (!depends.length) return false;
    const name = view.email ?? view.name ?? view.id;
    const plans = [...new Set(depends)];
    this.announce('limits', {
      title: `Login needs renewing — ${name}`,
      body: `The console could not renew ${name}'s Claude login (${risk.reason}). ${plans.join(', ')} `
        + `${plans.length === 1 ? 'depends' : 'depend'} on it. To fix it: ${risk.fix}.`,
      tag: tagFor('limits', 'login-at-risk', view.id),
    }, { slug: plans.length === 1 ? plans[0] : null });
    return true;
  }

  /**
   * Put a question to the session running this plan's current phase.
   *
   * Unlike every other control here there is no on-disk fallback, and there
   * should not be: a question needs something listening. A run this console is
   * not driving has a session belonging to another console — or to nothing at
   * all — and the honest answer is to say so rather than to write the question
   * somewhere it will never be read.
   */
  askRun(slug: string, question: string, by = 'console', key?: string, phase?: number | null): AskResult {
    const runner = this.liveRunner(slug);
    if (!runner) {
      return { ok: false, reason: `nothing is running for ${slug} in this console` };
    }
    const mismatch = runner.phaseMismatch(phase);
    if (mismatch) return { ok: false, reason: mismatch };
    // The phase goes through to the lane, so a question typed under one
    // running phase cannot be answered by a different one's session.
    return runner.ask(question, by, key, phase);
  }

  /** The same channel, said as an instruction rather than a question. */
  steerRun(
    slug: string, instruction: string, by = 'console', key?: string, phase?: number | null, reason?: string,
  ): AskResult {
    const runner = this.liveRunner(slug);
    if (!runner) {
      return { ok: false, reason: `nothing is running for ${slug} in this console` };
    }
    const mismatch = runner.phaseMismatch(phase);
    if (mismatch) return { ok: false, reason: mismatch };
    return runner.steer(instruction, by, key, phase, reason);
  }

  /**
   * Freeze and thaw the session mid-phase.
   *
   * No on-disk fallback, and for the same reason `askRun` has none: both act on
   * a live child. A run this console is not driving has a child belonging to
   * another console or to nothing, and signalling a pid we do not own is not a
   * fallback, it is a different and much worse action.
   */
  freezeRun(slug: string, by = 'console', phase?: number | null): ControlResult {
    const runner = this.liveRunner(slug);
    if (!runner) return { ok: false, reason: `nothing is running for ${slug} in this console` };
    const mismatch = runner.phaseMismatch(phase);
    if (mismatch) return { ok: false, reason: mismatch };
    // A per-run Freeze pressed while the CONSOLE is frozen writes the standing
    // form too. Without this it wrote the ordinary one — an armed fifteen-minute
    // `killLadder` inside a freeze the banner calls standing, which is the same
    // defect the conversion inside `Runner.freeze` closes from the other
    // direction. The operator has not asked for two kinds of freeze; they have
    // asked for one, twice. Only where the hold binds THIS plan: a restart
    // waiting for its lanes holds just the plans whose scope meets theirs (#70).
    const standing = this.fleetHoldFor(slug) ? ({ standing: true } as const) : undefined;
    if (!runner.freeze(by, phase, standing)) {
      return { ok: false, reason: `nothing is running for ${slug} in this console that could be frozen` };
    }
    return { ok: true, run: runner.current() };
  }

  thawRun(slug: string, phase?: number | null): ControlResult {
    const runner = this.liveRunner(slug);
    if (!runner) return { ok: false, reason: `nothing is running for ${slug} in this console` };
    const mismatch = runner.phaseMismatch(phase);
    if (mismatch) return { ok: false, reason: mismatch };
    if (!runner.thaw(phase)) {
      return { ok: false, reason: `nothing is frozen for ${slug} in this console` };
    }
    return { ok: true, run: runner.current() };
  }

  /**
   * Change a run's settings, live or stored — each field lands when
   * `SETTING_EFFECTS` says (control-tower phase 13, #31).
   *
   * `by` is the actor the route derived, whole (phase 96's note: a bare label
   * dropped the verb's `reason`); a label from an older caller is folded by
   * `asActor`. BOTH arms journal `run.reconfigured {patch, before, …actor}`:
   * the live one through the runner, the stored one through
   * `journalStoredEdit` inside the same write as the value it explains (#22's
   * rule). `extra.before` is what only the door knew — the plan's QA gate
   * before `qa` moved it.
   */
  configureRun(
    slug: string, patch: RunSettingsPatch, by: Actor | string = 'console',
    extra: { before?: Record<string, unknown> } = {},
  ): RunState | null {
    const actor = asActor(by, 'Service.configureRun');
    // `attachDefaultSkills` is a request, not a field: it is translated here
    // into the concrete skills list against the run's CURRENT one, because the
    // patch that reaches `applySettings` must say what the list is, not how to
    // derive it. On means the machine defaults ride along with what the run
    // already has; off means they come out and everything picked by hand stays.
    const translate = (state: RunState | null): RunSettingsPatch => {
      if (patch.attachDefaultSkills === undefined) return patch;
      const { attachDefaultSkills: attach, ...rest } = patch;
      const defaults = this.flags.defaultSkills;
      const base = rest.skills != null ? rest.skills : (state?.skills ?? []);
      return {
        ...rest,
        skills: attach
          ? [...new Set([...base, ...defaults])]
          : base.filter((skill) => !defaults.includes(skill)),
      };
    };
    const runner = this.liveRunner(slug);
    const applied = runner?.configure(translate(runner.current()), actor, extra)
      ? runner.current()
      : this.editStoredRun(slug, (state) => {
        const patched = translate(state);
        const before = { ...settingsBefore(state, patched), ...extra.before };
        applySettings(state, patched, this.consoleIssueWord());
        // Journalled like the live branch's `run.reconfigured` (control-tower
        // phase 77, #101 — #22's rule for an edit no loop made): a stored run
        // whose `resumeOnRestart` changed with no line saying so could not
        // explain its own next restart. Since phase 13 with what it replaced
        // and who asked, through the one stored-edit writer.
        this.journalStoredEdit(state, 'run.reconfigured', { patch: { ...patched }, before }, actor);
      });
    // The class change has to reach the entries ALREADY waiting, or an
    // operator who raises a plan's priority while three of its phases sit in
    // `admit()` gets a run file that says `high` and a queue that ignores it
    // until the next phase boards. `AdmitRequest.priority` is only the birth
    // value; this is the other half of the same setting.
    if (patch.priority !== undefined && applied) {
      this.scheduler.reprioritize(applied.id, runPriority(applied.priority));
    }
    return applied;
  }

  /**
   * The operator's mid-run account switch. Live loop: checkpoint-and-continue
   * inside the runner — every lane still working, never one only closing out
   * (#107), and none at all under `when: 'boundary'` — with the queue re-keyed
   * (#92). No loop: edit the checkpoint, so the next Continue spawns under the
   * new account. `auto` resolves against the meters here, exactly as it does
   * at start — weighed against the reset of the wall the run is under (#100).
   */
  switchAccountRun(
    slug: string, accountId: string | undefined, actor: Actor = unattributedActor('Service.switchAccountRun'),
    opts: { when?: SwitchWhen; dry?: boolean } = {},
  ): {
    ok: boolean; reason?: string; run?: RunState | null; checkpointed?: number; deferred?: number[]; rekeyed?: number;
    /** `dry` only: the live lanes the switch would checkpoint now (#107 ask 2). */
    wouldCheckpoint?: number[]; dry?: true; to?: string;
  } {
    const current = this.liveRunner(slug)?.current() ?? null;
    const run = current ?? (this.root?.ok ? latestRun(this.root.path, slug, this.liveRunIds()) : null);
    let resolved = accountId;
    if (accountId === 'auto') {
      // The wall's own picker (control-tower phase 78, #100): an account that
      // would wall before the one the run is on resets is no place to go.
      const on = run?.accountId ?? undefined;
      const wall = this.accounts.headroom(on, run?.model);
      const plan = this.accounts.switchCandidates(on, run?.model, { until: !wall.ok && wall.resetsAt ? wall.resetsAt : null });
      resolved = plan.ranked[0];
      if (!resolved) {
        return {
          ok: false,
          reason: plan.declined.length
            ? `no other account has headroom that outlasts the wall ${on ?? 'the machine login'} is under — `
              + `${plan.declined.map((row) => `${this.accounts.labelFor(row.id)}: ${row.why}`).join('; ')}`
            : 'no other account has headroom right now',
        };
      }
    }
    // A target the console already knows cannot pay is refused BEFORE anything
    // is checkpointed (control-tower phase 53, #56): a switch onto a retired
    // account ended a healthy session, and the re-board was then refused on
    // the very account the console had failed over away from an hour earlier.
    // The quota door's own verdict — retired, a learned wall, a spent window.
    const to = resolved && resolved !== DEFAULT_ACCOUNT_ID ? resolved : undefined;
    if (run && (run.accountId ?? DEFAULT_ACCOUNT_ID) !== (to ?? DEFAULT_ACCOUNT_ID)) {
      const verdict = this.accounts.headroom(to, run.model);
      if (!verdict.ok) {
        return {
          ok: false,
          reason: `${verdict.reason} The run stays on ${run.accountId ?? 'the machine login'}; nothing was checkpointed.`,
        };
      }
    }
    const runner = this.liveRunner(slug);
    // A preview (control-tower phase 25): the same refusals as the switch, then
    // what it would do to the live lanes — and nothing done.
    if (opts.dry) {
      const preview = runner ? runner.previewSwitch(opts.when ?? 'now') : { wouldCheckpoint: [], deferred: [] };
      return { ok: true, dry: true, to: to ?? DEFAULT_ACCOUNT_ID, ...preview };
    }
    if (runner) {
      const outcome = runner.switchAccount(resolved, actor, { when: opts.when });
      return outcome.ok
        ? { ok: true, run: runner.current(), checkpointed: outcome.checkpointed, deferred: outcome.deferred, rekeyed: outcome.rekeyed }
        : { ok: false, reason: outcome.reason };
    }
    // No loop behind it, so the edit lands on the checkpoint — and is written
    // down there (#22). This branch used to set the field and return: no
    // journal line, no manifest update, no `by`/`via`, leaving a record whose
    // two account fields disagreed and whose history could not explain either.
    let reverted: { from: string; to: string; choice: AccountChoice; reason: string } | null = null;
    const edited = this.editStoredRun(slug, (state) => {
      const from = state.accountId ?? DEFAULT_ACCOUNT_ID;
      const to = resolved && resolved !== DEFAULT_ACCOUNT_ID ? resolved : DEFAULT_ACCOUNT_ID;
      if (to === DEFAULT_ACCOUNT_ID) delete state.accountId;
      else state.accountId = to;
      // The manifest names what the record names. `minHeadroomPct: 0` because
      // a switch chooses a CREDENTIAL, not a requirement — a plan's own floor
      // for an account it listed is already in the row it wrote.
      const rows = (state.accounts ??= []);
      if (!rows.some((row) => row.id === to)) rows.push({ id: to, minHeadroomPct: 0 });
      // A person's choice is remembered (#106); the ladder's move back onto
      // the account they left is a reversal, and says so.
      if (isPersonsAct(actor)) {
        state.accountChoice = { accountId: to, from, at: new Date().toISOString(), by: actor.by };
      } else if (state.accountChoice?.from === to && from !== to) {
        reverted = { from, to, choice: state.accountChoice, reason: `${actor.by} switched the run` };
        journalOf(state)('run.account-switch-reverted', { ...reverted, by: actor.by });
      }
      // `checkpointed: null` — not zero. The live branch counts the lanes it
      // held a pid for, and a count of none would claim it looked.
      this.journalStoredEdit(state, 'run.account-switch', { from, to, checkpointed: null, when: opts.when ?? 'now' }, actor);
    });
    if (edited && reverted) this.announceReversal(edited, reverted);
    return edited
      ? { ok: true, run: edited }
      : { ok: false, reason: 'no run of that plan to move — start one with the account instead' };
  }

  /**
   * "Review this branch in the cloud, now" — the one-click ultrareview.
   *
   * The at-settle shape, on demand: the run's own checkout, the run's account,
   * the run's `reviewerPolicy`, and the findings hung on the last phase the run
   * finished. It is deliberately reachable when the run is finished, paused or
   * halted as well as while it drives — the moment an operator most wants a
   * second reader is when a run has stopped and they are deciding what to do
   * about it, and a verb that only worked mid-drive would be closed exactly
   * then.
   *
   * Billed cloud work, so it is a VERB rather than a setting: nothing here can
   * be left switched on by accident, and every press is one review.
   */
  async ultraReviewNow(slug: string): Promise<{
    slug: string; phase: number; state: 'landed' | 'unknown';
    verdict?: string; findings?: number; reason?: string; ms: number;
  }> {
    const state = this.liveRunner(slug)?.current()
      ?? (this.root ? latestRun(this.root.path, slug, this.liveRunIds()) : null);
    if (!state) throw new Error(`no run of ${slug} to review`);
    const phase = lastFinishedPhase(state.phases);
    if (phase == null) throw new Error(`no phase of ${slug} has finished, so there is nothing to review`);

    // The live runner's journal when it holds this very run, else one opened on
    // the run's own file. Two writers would restart the sequence; asking which
    // one owns it costs a line and keeps the file readable as one sequence.
    const live = this.runners.get(slug);
    const owned = live?.current()?.id === state.id ? live : null;
    const journal = owned ? null : Journal.for(state.root, state.slug, state.id);
    // Single-flight, because this one costs money — `singleFlight`'s own
    // comment says what a second press would buy.
    return singleFlight(this.ultraReviewsInFlight, slug,
      () => this.runUltraReviewFor(slug, state, phase, owned, journal));
  }

  /** In-flight on-demand reviews, one per plan. See `ultraReviewNow`. */
  private readonly ultraReviewsInFlight = new Map<string, Promise<{
    slug: string; phase: number; state: 'landed' | 'unknown';
    verdict?: string; findings?: number; reason?: string; ms: number;
  }>>();

  /** The body of `ultraReviewNow`, after it has decided there is one to run. */
  private async runUltraReviewFor(
    slug: string, state: RunState, phase: number,
    owned: Runner | null, journal: Journal | null,
  ): Promise<{
      slug: string; phase: number; state: 'landed' | 'unknown';
      verdict?: string; findings?: number; reason?: string; ms: number;
    }> {
    const result = await ultraReviewJob({
      occasion: 'on-demand', slug, phase,
      cwd: state.root,
      env: (await this.accounts.envFor(state.accountId, [state.root])) ?? undefined,
      policy: state.reviewerPolicy === 'may-hold' ? 'may-hold' : DEFAULT_REVIEWER_POLICY,
      record: (event, data, at) => {
        if (owned) owned.note(event, data, at);
        else journal?.append(event, data, at);
      },
      store: (on, at, report) => { this.recordReviewerReport(on, at, report); },
    });
    log.info('ultrareview.on-demand', { slug, phase, state: result.state });
    return result.state === 'landed'
      ? { slug, phase, state: 'landed', verdict: result.report.verdict, findings: result.findings, ms: result.ms }
      : { slug, phase, state: 'unknown', reason: result.reason, ms: result.ms };
  }

  /**
   * "Continue without these servers" — the door out of an MCP park.
   *
   * The park says an unattended session cannot sign a server in, which is true
   * and was the whole of the advice. But it is not the only remedy: the other
   * one is deciding the phase does not need that server after all, and until
   * now the only way to say that was to edit the plan or the run's settings and
   * then retry every parked phase by hand.
   *
   * Sets the run to `continue` and retries exactly the phases the MCP preflight
   * parked — not `failed` phases, not gated ones, not a phase parked for an
   * unrunnable §Verification. A button that says it is about MCP has to do only
   * that; the phases it releases will re-board through the same preflight and
   * simply be told to run without what they cannot reach.
   *
   * Note this cannot beat a plan that says `require`: `mcpPolicyFor` reads the
   * plan ahead of the run, deliberately. Such a phase re-parks, which is the
   * correct answer — the escape hatch for it is per-phase, where an operator
   * is overruling a versioned statement knowingly rather than in bulk.
   */
  async continueWithoutMcp(slug: string, actor: StartActor): Promise<RunState | null> {
    const state = this.liveRunner(slug)?.current()
      ?? (this.root ? latestRun(this.root.path, slug, this.liveRunIds()) : null);
    if (!state) throw new Error(`no run of ${slug} to continue`);
    const parked = Object.values(state.phases ?? {})
      .filter((record) => record.status === 'parked' && MCP_PARK_NOTE.test(record.note ?? ''))
      .map((record) => record.phase)
      .sort((a, b) => a - b);
    if (!parked.length) throw new Error('no phase of this run is parked on an MCP server');

    this.configureRun(slug, { mcpPolicy: 'continue' }, 'console');
    this.runners.get(slug)?.note('run.mcp-continue', { phases: parked });
    let run: RunState | null = null;
    // Sequential, not `Promise.all`: the FIRST retry is what restarts a stopped
    // run, and the rest have to land on the loop it started rather than racing
    // three `startRun` calls at one plan (which the pool answers 409 to).
    for (const phase of parked) run = await this.retryPhase(slug, phase, undefined, actor);
    log.info('mcp.continue-without', { slug, phases: parked });
    return run ?? this.liveRunner(slug)?.current() ?? null;
  }

  /**
   * Board this phase again — optionally with edits that apply to that ONE
   * attempt.
   *
   * `override` is what "Retry with edits…" sends: an addendum for the boot
   * prompt and/or per-phase settings. It is stamped onto the record by the same
   * `resetForRetry` both paths already share (live runner and stored run), so
   * the two cannot disagree, and it is spent at the boarding it causes. Nothing
   * here writes to `docs/plans/` — the plan is the durable statement of what
   * the phase needs, and an operator reacting to one failure is not amending
   * it.
   */
  /**
   * Retry one phase — the operator's Retry, and the vehicle four automatic
   * doors share (the healer's cheapest rung, a landed watch ref with no
   * session to resume, an MCP server healing under a `require` park, a gate
   * approved with "continue the run"). `actor` is the CALLER's: the door was
   * opened where the decision to retry was made, so this verb carries that
   * word to `run.start` rather than naming one of its own (SLF-1).
   */
  async retryPhase(
    slug: string, phase: number,
    override: { addendum?: string; options?: PhaseOptions; by?: string } | undefined,
    actor: StartActor,
  ): Promise<RunState | null> {
    // Named phase, so the claim is the whole answer — and checked before the
    // live-runner branch too, since `runner.retry` queues work the boarding
    // check would only refuse much later, after the button had said yes.
    this.assertNotClaimed(slug, [phase]);
    // Same both-directions guard as `recoverPhase`: a retry restarts the run
    // on a phase a live agent recovery may be mid-edit on.
    const busyOn = this.liveRecoveryFor({ slug, phase });
    if (busyOn) {
      throw new RecoveryBusyError(
        `A recovery session is already working on ${slug} phase ${phase} — a retry would start a `
        + 'second session on the same tree. Open it, or stop it first.',
        busyOn.id);
    }
    // Built once and handed to whichever path runs, so the live and stored
    // branches stamp the identical record. An override with nothing in it is
    // `undefined` — a plain Retry — rather than an empty object that would read
    // as "the operator chose nothing", which `resetForRetry` treats
    // differently: it CLEARS a previous unspent override.
    const edits = retryOverrideFrom(override);
    // Whose retry (RCV-3): a person's press clears the failure streak — they
    // are back in the loop — while the healer's `retry` rung, a watch landing
    // and the MCP clock carry it forward, exactly as an automatic relaunch does.
    // A harness calling with no actor is a press: `startRun` below records it
    // `unattributed`, which no production door writes.
    const press = stoppedByOf(actor ?? unattributedActor('Service.retryPhase')) === 'operator';
    const runner = this.liveRunner(slug);
    if (runner) { runner.retry(phase, edits, { press, ...(actor?.reason ? { reason: actor.reason } : {}) }); return runner.current(); }
    // No loop behind it: resetting the record used to be the WHOLE action —
    // the button answered 200, the halt banner cleared, and nothing anywhere
    // was going to run the phase. Retry on a stopped run now means what the
    // operator means by it: clear the failure AND continue the run, under
    // normal admission.
    const edited = this.editStoredRun(slug, (state) => {
      const situation = personSituationOf(phaseRecord(state, phase));
      // The ONE reset, shared with `Runner.retry` — the two had drifted twice.
      resetForRetry(phaseRecord(state, phase), { by: press ? 'operator' : 'console', override: edits, journal: journalOf(state) });
      if (press) resetStreak(state);
      state.halt = null;
      // The recover verb's ledger is the operator's to clear (RCV-4) — the
      // live twin `Runner.retry` does the same.
      if (press) delete state.recoveries?.[String(phase)]?.recovers;
      // …and the ladder is replenished, exactly as `Runner.retry` does it (#14).
      if (press) {
        const forgiven = forgiveRungs(state.recoveries?.[String(phase)], retryForgives, new Date().toISOString(), 'operator');
        if (forgiven.length) journalOf(state)('phase.ladder-replenished', replenishedPayload(forgiven, 'operator'), phase);
        // …and it boards in the PERSON slot, as `Runner.retry` does it
        // (control-tower phase 53, #56): the Continue below would otherwise
        // open with the loop's own ladder pass, which re-climbed the phase,
        // found its rung cap spent and parked it before anything ran.
        const record = phaseRecord(state, phase);
        const { rung, hint } = boardInPersonSlot((state.recoveries ??= {}), record, {
          situation, at: new Date().toISOString(),
        });
        journalOf(state)('phase.rung', {
          situation, rung: rung.rung, params: null, brief: hint.brief, vehicle: 'runner',
          attempt: state.recoveries?.[String(phase)]?.attempts ?? 1, by: PERSON_SLOT_BY, slot: 'person',
        }, phase);
      }
    });
    if (!edited) return null;
    return this.startRun(slug, {
      // The caller's door — never one of this verb's own (see the docblock).
      actor: actor ?? unattributedActor('Service.retryPhase'),
      resumeRunId: edited.id,
      // Resume CLEARS a scope it is not handed ("Continue never silently
      // inherits"), so a scoped run's retry must carry its own forward —
      // otherwise retrying one phase silently widens the run to the whole plan.
      ...(edited.onlyPhases?.length ? { onlyPhases: edited.onlyPhases } : {}),
      // Same for skills: an omission lets machine defaults overwrite the run's
      // sticky list on resume.
      skills: edited.skills ?? [],
    });
  }

  /**
   * The operator's Retry, answered with what it set in motion (control-tower
   * phase 53, #56): the run, the phase, and a fresh session boarding in the
   * person slot. A plan with no run to retry in is a refusal naming the way
   * forward — it used to be `200 {run: null}` — and a door that throws (a live
   * recovery on the phase, a claim, a live foreign run) is a refusal with its
   * own sentence rather than an error page.
   */
  async pressRetry(
    slug: string, phase: number,
    override: { addendum?: string; options?: PhaseOptions; by?: string } | undefined,
    actor: StartActor,
  ): Promise<PressAnswer> {
    let run: RunState | null;
    try {
      run = await this.retryPhase(slug, phase, override, actor);
    } catch (error) {
      return pressRefusal(error, 'the phase could not be retried');
    }
    if (!run) {
      return { ok: false, status: 409, error: `No run of ${slug} to retry phase ${phase} in — start the plan instead.` };
    }
    return this.pressVerdict(slug, run, { runId: run.id, phase, session: null, brief: 'fresh' });
  }

  /**
   * A press's answer, told the truth (control-tower phase 86, RS-5, #128's
   * 2026-09-25T20:04Z comment): `launched` only when the phase BOARDED at this
   * admission — its lane holds its grant — and `queued {position}` otherwise,
   * naming what it waits behind. The measured lie was `launched: {phase: 59}`
   * over a start that admitted a fresh phase and never queued 59 at all.
   */
  private async pressVerdict(slug: string, run: RunState, launch: PressLaunch): Promise<PressAnswer> {
    const verdict = await this.runnerFor(slug).boardingVerdict(launch.phase);
    if ('boarded' in verdict) return { ok: true, run, launched: launch };
    return { ok: true, run, queued: { ...launch, ...verdict.queued } };
  }

  /**
   * Resume a phase with an instruction (or ask its own session to close out),
   * answered with what it launched (control-tower phase 53, #54, #55).
   *
   * It used to arm a recovery and answer `200` whatever the recovery then did —
   * and when the resume policy said the session was not worth resuming (another
   * account paid for it, it went cold, it spent its context) the recovery put
   * the run back and launched NOTHING: no `phase.session`, the operator's words
   * lost, the phase still parked on the declaration it was pressed to answer.
   * The press now decides BEFORE anything is armed, from the same reading the
   * runner's gate makes (`resumeOffer`):
   *
   *   - the session can be resumed → the recovery resumes it, and the answer
   *     names the session;
   *   - it cannot (no session, gone, or the policy says fresh) → the phase is
   *     re-boarded FRESH with the resume brief carrying the operator's words
   *     and the reason, through the run's own loop, in the person slot;
   *   - it is still running, or another recovery holds the phase, or the board
   *     already reads it done → a refusal with the reason.
   */
  async pressResume(
    slug: string, phase: number, mode: 'resume' | 'closeout',
    opts: { instruction?: string; actor: StartActor },
  ): Promise<PressAnswer> {
    const root = this.root?.path;
    if (!root) return { ok: false, status: 409, error: 'No repository is open.' };
    const target = listRuns(root, slug, this.liveRunIds()).find((run) => run.phases[String(phase)]);
    const record = target?.phases[String(phase)];
    if (!target || !record) return { ok: false, status: 409, error: `No run of ${slug} has a record for phase ${phase}.` };
    // The press itself, on the run it presses, before anything acts (control-
    // tower phase 96, #142). Which of the three paths below runs is the
    // console's call; that a person asked, and why, is theirs — and a refusal
    // further down must not erase it.
    journalOf(target)('phase.resume-pressed', {
      mode, ...(opts.instruction ? { instruction: opts.instruction.slice(0, 500) } : {}), ...opts.actor,
    }, phase);
    const offer = resumeOffer(record, target.accountId ?? DEFAULT_ACCOUNT_ID);
    // A recovery of this phase still waiting for its scope takes the new words
    // where it stands — its place and its age kept (control-tower phase 86,
    // #149 ask 4). It used to be one more refusal: a recovery is live.
    const live = this.liveRunner(slug);
    if (live?.recoveryQueuedFor() === phase && mode === 'resume' && opts.instruction?.trim()
      && live.requeueRecovery(phase, opts.instruction, opts.actor.by)) {
      const state = live.current() ?? target;
      return this.pressVerdict(slug, state, { runId: state.id, phase, session: offer.sessionId ?? null, brief: 'continue' });
    }
    // A run with its loop behind it takes the press at its next boundary
    // (control-tower phase 98, #137): both paths below refuse a live run —
    // `recoverPhase` and the fresh re-board throw `RunBusyError` — so "board
    // P66 next, with this note" meant pausing the whole run and polling until
    // it read `paused`. The live runner hints and reserves the phase instead.
    const driving = live?.current();
    if (mode === 'resume' && live && driving?.id === target.id && !runIsOver(driving)) {
      const out = live.boardAtBoundary(phase, { ...(opts.instruction ? { instruction: opts.instruction } : {}), actor: opts.actor });
      if (!out.ok) return { ok: false, status: 409, error: out.reason };
      return this.pressVerdict(slug, live.current() ?? target, { runId: target.id, phase, session: out.sessionId, brief: out.brief });
    }
    if (offer.resumable && offer.sessionId) {
      // REG-1, asked before anything is armed: resuming a session that is
      // still running would put a second `claude` on its transcript.
      const seen = this.declarerPresence(offer.sessionId);
      if (seen.presence === 'live') {
        return {
          ok: false, status: 409, sessionId: offer.sessionId,
          error: `Phase ${phase}'s session ${offer.sessionId} is still running${seen.pid ? ` (pid ${seen.pid})` : ''} — `
            + 'steer it instead; the console will not resume a session on top of itself.',
        };
      }
      try {
        const run = await this.recoverPhase(slug, phase, mode, {
          ...(opts.instruction ? { instruction: opts.instruction } : {}), by: opts.actor.by, person: true,
        });
        this.continueAfterPress(slug, target.id, phase, opts.actor);
        return this.pressVerdict(slug, run ?? target,
          { runId: target.id, phase, session: offer.sessionId, brief: mode === 'closeout' ? 'closeout' : 'continue' });
      } catch (error) {
        return pressRefusal(error, 'the phase could not be recovered');
      }
    }
    return this.reboardForPerson(slug, target, phase, mode, offer, opts);
  }

  /**
   * The fresh half of `pressResume`: the resume the operator asked for, boarded
   * as a NEW session with the resume brief — the handoff, the uncommitted paths,
   * the last words — and the operator's instruction, beside the reason the
   * phase's own session was not resumed. Through `startRun({reboard})`, the
   * one seam every re-board uses, so the run's loop boards it under normal
   * admission; the rung sits in the person slot, reading no cap.
   */
  private async reboardForPerson(
    slug: string, target: RunState, phase: number, mode: 'resume' | 'closeout',
    offer: ReturnType<typeof resumeOffer>, opts: { instruction?: string; actor: StartActor },
  ): Promise<PressAnswer> {
    try {
      this.assertNotClaimed(slug, [phase]);
    } catch (error) {
      return pressRefusal(error, 'the phase is claimed');
    }
    if (this.liveRunner(slug)) return pressRefusal(new RunBusyError(slug), 'the run is busy');
    const busyOn = this.liveRecoveryFor({ slug, phase });
    if (busyOn) {
      return {
        ok: false, status: 409, sessionId: busyOn.id,
        error: `A recovery session is already working on ${slug} phase ${phase} — open it instead.`,
      };
    }
    // Resolve-first, as every recovery is: a phase the board already reads
    // done is closed here, never boarded to "finish" finished work.
    if (await this.preRecoveryGate(slug, target, phase) === 'superseded') {
      return { ok: false, status: 409, error: `Phase ${phase} of ${slug} already reads done on the board — its record is closed, and there is nothing to resume.` };
    }
    const why = offer.policy
      ? resumePolicyWhy(offer.policy)
      : offer.sessionId ? `its session ${offer.sessionId} is gone` : 'it has no session to resume';
    const note = offer.policy && offer.sessionId
      ? resumePolicyInstruction(offer.policy, offer.sessionId)
      : offer.sessionId ? sessionLostInstruction(offer.sessionId, 'gone') : null;
    const asked = mode === 'closeout'
      ? 'Close this phase out: run its §Verification, commit the work, and write the handoff — nothing else.'
      : (opts.instruction ?? '').trim();
    // The operator's words first — they are the newest fact and the reason this
    // boarding exists — then why it is a fresh session rather than a resume.
    const instruction = [asked, note].filter(Boolean).join('\n\n');
    const at = new Date().toISOString();
    const record = target.phases[String(phase)];
    const situation = personSituationOf(record);
    this.editStoredRunById(slug, target.id, (state) => {
      const rung = accountPersonRung((state.recoveries ??= {}), phase, {
        situation, rung: 'reboard-resume-brief', at, note: `a person's ${mode === 'closeout' ? 'closeout' : 'resume'}, boarded fresh`,
      });
      journalOf(state)('phase.rung', {
        situation, rung: rung.rung, params: null, brief: 'resume', vehicle: 'runner',
        attempt: state.recoveries?.[String(phase)]?.attempts ?? 1, by: PERSON_SLOT_BY, slot: 'person', why,
      }, phase);
    });
    // The press's own actor, threaded: this door is whoever pressed (SLF-1).
    const actor = opts.actor;
    try {
      const run = await this.startRun(slug, {
        actor: actor,
        resumeRunId: target.id,
        reboard: [{
          phase, situation, rung: 'reboard-resume-brief', brief: 'resume', by: PERSON_SLOT_BY,
          ...(instruction ? { instruction } : {}),
        }],
        // What `retryPhase` carries forward, for the same two reasons.
        ...(target.onlyPhases?.length ? { onlyPhases: target.onlyPhases } : {}),
        skills: target.skills ?? [],
      });
      return await this.pressVerdict(slug, run, { runId: run.id, phase, session: null, brief: 'resume', why });
    } catch (error) {
      return pressRefusal(error, 'the phase could not be boarded');
    }
  }

  /**
   * "Delegate to the session" (control-tower phase 53, #54) — the answer to a
   * phase parked on acts the plan keeps for a person (`--needs human-acts`).
   *
   * The owner's answer on the run that raised #54 was "give the plan full
   * permissions and let it run", and there was no way to say it: raising the
   * profile alone did not help, because the resumed session re-read a handoff
   * saying the acts were the owner's and declared `needs-human` again. The act
   * is two things, in this order: the phase is resumed with an instruction
   * saying the acts are the session's now — through `pressResume`, so it
   * launches or refuses exactly as a resume does — and, once something was
   * launched, a ruling goes on the plan's ledger (`deviation`, `human-acts`,
   * naming who delegated), which is what a later reader of the run will ask
   * for. The permission wall does not move: an act it refuses comes back as a
   * `blocked --needs permission`, and the widen card answers that.
   */
  async delegatePhase(slug: string, phase: number, words: string, actor: StartActor): Promise<PressAnswer & { rulingId?: string }> {
    const root = this.root?.path;
    if (!root) return { ok: false, status: 409, error: 'No repository is open.' };
    const target = listRuns(root, slug, this.liveRunIds()).find((run) => run.phases[String(phase)]);
    const declared = target?.phases[String(phase)]?.declared;
    const parked = declared && (declared.status === 'needs-human' || declared.status === 'blocked');
    if (!target || !parked || subKindOfNeed(declared.needs) !== 'human-acts') {
      return {
        ok: false, status: 409,
        error: `Phase ${phase} of ${slug} is not parked on acts kept for a person (--needs human-acts) — `
          + 'Delegate hands those to the session; use Resume with an instruction for anything else.',
      };
    }
    const by = actor.by;
    const instruction = [
      `The operator (${by}) has delegated to this session the acts this phase declared for a person`
        + `${declared.reason ? ` ("${declared.reason.slice(0, 400)}")` : ''}. They are yours now: do them yourself, `
        + "within the run's permission policy, and do not declare needs-human for them again. If the permission wall "
        + 'refuses one, declare `blocked --needs permission` naming the rule and the command, and stop.',
      words.trim() ? `Their words: ${words.trim()}` : '',
    ].filter(Boolean).join('\n\n');
    const answer = await this.pressResume(slug, phase, 'resume', { instruction, actor });
    if (!answer.ok) return answer;
    const ruling = appendRuling(rulingsFile(root, slug), {
      slug, phase, kind: 'deviation', decisionKey: 'human-acts', by,
      what: `${by} delegated the acts phase ${phase} kept for a person to its session`,
      ...(words.trim() ? { why: words.trim() } : {}),
    });
    const journal = this.runners.get(slug)?.current()?.id === answer.run.id ? this.runners.get(slug)! : null;
    // Launched or queued (RS-5), the press set the same session in motion.
    const set = 'launched' in answer ? answer.launched : answer.queued;
    const line = {
      by, rulingId: ruling?.id ?? null, session: set.session, brief: set.brief,
    };
    if (journal) journal.note('phase.delegated', line, phase);
    else journalOf(answer.run)('phase.delegated', line, phase);
    return { ...answer, ...(ruling ? { rulingId: ruling.id } : {}) };
  }

  /**
   * "Done — continue" (control-tower phase 88, #124) — the answer to a phase
   * parked on a person's errand that the person has DONE: the two Terraform
   * applies ran, the sign-in happened, the secret is in.
   *
   * Before this the only door that looked like an answer was Recover, which
   * re-read the session's declaration ("blocked until the operator applies"),
   * found nothing saying the operator had, and re-halted with the same text;
   * the real answer was Retry, named only as a buried `verb: retry`. Three
   * things, in this order: the answer is RECORDED on the run
   * (`phase.errand-answered {by, note}`, `record.errandAnswered` — evidence the
   * fingerprint reads) and the declaration it answers is spent, so nothing
   * re-derives the ask; then the phase is re-boarded with the note through
   * `pressResume` — it launches, queues at the next boundary, or refuses
   * exactly as a Resume does. The permission wall does not move.
   */
  async answerErrand(slug: string, phase: number, note: string, actor: StartActor): Promise<PressAnswer> {
    const root = this.root?.path;
    if (!root) return { ok: false, status: 409, error: 'No repository is open.' };
    const target = listRuns(root, slug, this.liveRunIds()).find((run) => run.phases[String(phase)]);
    const record = target?.phases[String(phase)];
    const errand = target?.recoveries?.[String(phase)]?.errand;
    const declared = record?.declared;
    const asked = errand ?? (declared && (declared.status === 'needs-human' || declared.status === 'blocked') ? declared : null);
    if (!target || !record || !asked || runIsOver(target)) {
      return {
        ok: false, status: 409,
        error: `Phase ${phase} of ${slug} has no open errand to answer — Retry or Resume it instead.`,
      };
    }
    const words = note.trim().slice(0, 4_000);
    const need = errand?.need ?? declared?.reason ?? record.note ?? '';
    const answer = { by: actor.by, note: words, at: new Date().toISOString(), ...(errand ? { situation: errand.situation } : {}) };
    const live = this.liveRunner(slug);
    if (live?.current()?.id === target.id) live.answerErrand(phase, answer);
    else {
      this.editStoredRunById(slug, target.id, (stored) => applyErrandAnswer(stored, phase, answer));
      journalOf(target)('phase.errand-answered', { by: answer.by, note: words, situation: answer.situation ?? null }, phase);
    }
    const instruction = [
      `The operator (${actor.by}) has done what this phase asked a person for`
        + `${need ? ` ("${need.replace(/\s+/g, ' ').slice(0, 400)}")` : ''} and answered it: Done — continue. `
        + 'Carry on from where the session stopped. Check what the errand was for before relying on it, and do not '
        + 'declare needs-human for the same thing again unless it is still not true.',
      words ? `Their note: ${words}` : '',
    ].filter(Boolean).join('\n\n');
    return this.pressResume(slug, phase, 'resume', { instruction, actor });
  }

  /**
   * Zero a run's consecutive-failure streak, live or stored.
   *
   * The verb #37 asked for by name. A run could sit at **3 of a maximum 2** —
   * past its own ceiling, its `failure-streak` halt in `PRESS_ONLY_HALT_KINDS`
   * so no clock would relaunch it — with nothing in the console able to bring
   * the number back. Retry clears it as a side effect of retrying a PHASE, and
   * that is the wrong shape when what is wrong is the counter: the failures it
   * counted were an outage, and there is no phase to retry.
   *
   * Refused on a run that is over (`409`): the streak is part of a finished
   * run's record, and editing history is not a recovery.
   */
  /**
   * Raise the budget that stopped the work, in one press (control-tower phase
   * 14, #40): write it WHERE IT WAS DECLARED, journal who raised it and by how
   * much, answer the hold it left, and retry.
   *
   * Every budget the console keeps could stop a run, and the only raise was a
   * text editor: the halt text named the plan line and a person opened the
   * file. A wait is written to the plan — the phase's `Waits on:` max, or the
   * plan's `Wait budget:` with `scope: 'plan'` — because the engine re-reads
   * the plan on every board and a run-local override would be silently lost
   * (`wait-budget.sh`, behind `--allow-writes`). The dollars and the ladder's
   * rungs are the run's own settings, patched through `configureRun`, which
   * applies to a live loop or a stored run alike. The streak is never raised:
   * it is cleared, by its own verb.
   *
   * The body names the budget, the phase it held (all but the run's dollars),
   * and either `add` (the raise) or `to` (the new whole budget) in the
   * budget's unit — minutes, dollars, rungs. `was`/`now` come back, and the
   * journal line `run.budget-raised {budget, was, now, by, via}` carries them
   * with the derived actor, the way `run.reconfigured` carries a patch.
   */
  async raiseBudget(
    slug: string,
    body: { budget?: unknown; phase?: unknown; add?: unknown; to?: unknown; scope?: unknown },
    actor: Actor,
  ): Promise<
    | { ok: true; budget: BudgetKind; phase: number | null; was: number; now: number; retried: boolean; run: RunState | null }
    | { ok: false; status: number; error: string }
  > {
    const budget = body.budget;
    if (!isBudgetKind(budget)) return { ok: false, status: 400, error: `budget must be one of ${BUDGET_KINDS.join(', ')}` };
    if (budget === 'streak') {
      return {
        ok: false, status: 400,
        error: 'The failure streak is cleared, not raised: POST /api/run/:slug/clear-streak (Clear the streak on the run page).',
      };
    }
    const phase = typeof body.phase === 'number' && Number.isInteger(body.phase) && body.phase > 0 ? body.phase : null;
    if (budget !== 'run-usd' && phase === null) {
      return { ok: false, status: 400, error: `a ${budget} budget belongs to one phase: give phase` };
    }
    const run = await this.runFor(slug);
    if (!run) return { ok: false, status: 404, error: `no run for ${slug}` };
    const unit = BUDGET_UNITS[budget];
    const errand = phase !== null ? run.recoveries?.[String(phase)]?.errand : null;

    // What the budget is now, from where it is declared.
    let was: number;
    let setting: string | null = null;
    if (budget === 'wait') {
      if (!this.flags.allowWrites) {
        return {
          ok: false, status: 403,
          error: 'Raising a wait budget writes the plan: start the console with --allow-writes, or edit the phase\'s '
            + '`Waits on:` max (or the plan\'s `Wait budget:`) by hand.',
        };
      }
      was = Math.round((await this.waitBudget(slug, phase!)).budgetMs / 60_000);
    } else if (budget === 'ladder') {
      const named = errand?.setting ?? errand?.budget?.setting;
      setting = (LADDER_RAISE_SETTINGS as readonly string[]).includes(named ?? '') ? named! : BUDGET_SETTING.ladder;
      const current = (run as unknown as Record<string, unknown>)[setting];
      was = typeof current === 'number' ? current : typeof errand?.limit === 'number' ? errand.limit : errand?.budget?.limit ?? 0;
    } else {
      setting = BUDGET_SETTING[budget];
      const current = (run as unknown as Record<string, unknown>)[setting];
      const cap = phase !== null ? run.phases[String(phase)]?.lastSession?.maxBudgetUsd?.value : undefined;
      was = typeof current === 'number' ? current : typeof cap === 'number' ? cap : 0;
    }
    const round = (n: number) => (unit === 'usd' ? Math.round(n * 100) / 100 : Math.ceil(n));
    const add = typeof body.add === 'number' && Number.isFinite(body.add) ? body.add : null;
    const to = typeof body.to === 'number' && Number.isFinite(body.to) ? body.to : null;
    if ((add === null) === (to === null)) return { ok: false, status: 400, error: 'give exactly one of add (the raise) or to (the new budget)' };
    const now = round(to ?? was + add!);
    const limit = RAISE_MAX[unit as keyof typeof RAISE_MAX] ?? Infinity;
    if (!(now > was)) return { ok: false, status: 400, error: `a raise must raise: the ${budget} budget is ${was} ${unit}, asked ${now}` };
    if (now - was > limit) return { ok: false, status: 400, error: `a raise of more than ${limit} ${unit} at once is refused as a typo` };

    // Write it where it is declared.
    let scope: 'phase' | 'plan' | 'run' = 'run';
    if (budget === 'wait') {
      scope = body.scope === 'plan' ? 'plan' : 'phase';
      const record = run.phases[String(phase)];
      const refs = scope === 'phase'
        ? (record?.declared?.watch ?? record?.watch ?? []).filter((ref) => !ref.startsWith('date:'))
        : [];
      let outcome;
      try {
        outcome = await runWrite(
          planWrite({ action: 'wait-budget', slug, ...(scope === 'phase' ? { phase: phase!, refs } : {}), minutes: now },
            { root: this.root!.path }),
          { scriptsDir: this.flags.scriptsDir, root: this.root!.path },
        );
      } catch (error) {
        return { ok: false, status: 400, error: (error as Error).message };
      }
      if (!outcome.ok) {
        return { ok: false, status: 409, error: (outcome.stderr || outcome.stdout || 'wait-budget.sh refused').trim().slice(0, 600) };
      }
      invalidateEngine(slug);
    } else {
      const patched = this.configureRun(slug, { [setting!]: now } as RunSettingsPatch, actor);
      if (!patched) return { ok: false, status: 404, error: `no run for ${slug}` };
    }

    // Journal it, and answer the hold the budget left.
    const data = {
      budget, phase, was, now, unit, via: 'raise-budget',
      ...(setting ? { setting } : {}), ...(budget === 'wait' ? { scope } : {}),
    };
    // `via` names the verb, as `run.failure-streak-reset`'s does; the actor's
    // own transport rides as `channel`, so neither word is lost.
    const who = { ...actor, channel: actor.via };
    const live = this.liveRunner(slug);
    if (live) {
      live.budgetRaised({ ...who, ...data });
    } else {
      this.editStoredRun(slug, (state) => {
        const cleared = clearBudgetHold(state, budget, phase);
        journalOf(state)('run.budget-raised', {
          ...who, ...data, ...(cleared.length ? { cleared } : {}), stored: true,
        }, phase ?? undefined);
      });
    }
    if (budget === 'wait') void this.watchClock?.tick();

    // …and retry, in the same press: the phase it held, or the run it halted.
    let retried = false;
    const press = pressActor(actor);
    if (phase !== null) {
      const answer = await this.pressRetry(slug, phase, undefined, press);
      retried = Boolean((answer as { ok?: boolean }).ok);
    } else if (!live) {
      const stored = await this.runFor(slug);
      if (stored) {
        await this.startRun(slug, {
          // The press's own door: the raise is a person's Continue.
          actor: pressActor(actor),
          resumeRunId: stored.id,
          ...(stored.onlyPhases?.length ? { onlyPhases: stored.onlyPhases } : {}),
        });
        retried = true;
      }
    }
    return { ok: true, budget, phase, was, now, retried, run: await this.runFor(slug) };
  }

  clearFailureStreak(slug: string, actor: Actor): { ok: true; was: number; run: RunState } | { ok: false; status: number; error: string } {
    const live = this.liveRunner(slug);
    if (live) {
      const state = live.current();
      if (state && runIsOver(state)) return { ok: false, status: 409, error: `run ${state.id} of ${slug} is finished` };
      const was = live.clearStreak(actor.by, 'clear-streak', actor.reason);
      return { ok: true, was, run: live.current()! };
    }
    const latest = this.root?.ok ? latestRun(this.root.path, slug, this.liveRunId()) : null;
    if (!latest) return { ok: false, status: 404, error: `no run of ${slug}` };
    if (runIsOver(latest)) return { ok: false, status: 409, error: `run ${latest.id} of ${slug} is finished` };
    let was = 0;
    const edited = this.writeStoredRun(latest, (state) => {
      was = resetStreak(state);
      journalOf(state)('run.failure-streak-reset', {
        was, by: actor.by, via: 'clear-streak', ...(actor.reason ? { reason: actor.reason } : {}),
      });
    });
    if (!edited) return { ok: false, status: 404, error: `no run of ${slug}` };
    return { ok: true, was, run: edited };
  }

  skipPhase(slug: string, phase: number): RunState | null {
    const runner = this.liveRunner(slug);
    if (runner) { runner.skip(phase); return runner.current(); }
    return this.editStoredRun(slug, (state) => {
      const record = phaseRecord(state, phase);
      record.status = 'skipped';
      record.note = 'skipped by the operator';
      state.halt = null;
      // A skipped phase is owed nothing (#43): its errand goes with it.
      retireSettledErrands(state);
      // …and the phase's own ending. Skip is PERMANENT — a skipped record is
      // never re-boarded and never retried — so a `record.halt` left standing
      // here is one the classifier (which prefers it to `state.halt`) reads for
      // the life of the run, pinning a phase nobody is coming back to.
      retirePhaseHalt(record);
    });
  }

  /**
   * Move a stuck phase forward without starting it over.
   *
   * Retry and Skip were the whole vocabulary, and both discard something: the
   * session that may have been minutes from done, or the phase itself. These
   * three are the middle — re-check what is already on disk, ask the phase's own
   * session to finish its closeout, or resume it with an instruction. See
   * `Runner.recover`.
   */
  /**
   * `settled: true` waits for the recovery to FINISH before answering.
   *
   * `recover()` returns its state synchronously and stores the driving promise
   * on the runner, so by default this answers the moment the recovery has been
   * ARMED — which is what the operator's button needs (an HTTP request must not
   * hang for a session that may run for an hour). The unattended watch-landed
   * resume needs the opposite: its `.then` decides whether to continue the run,
   * and it used to run against a run still reading `running` because the
   * recovery had not even been admitted yet (R1/R7).
   */
  async recoverPhase(
    slug: string, phase: number, mode: RecoverMode,
    opts: {
      instruction?: string; by?: string; settled?: boolean;
      /** `repair` only — the briefing class and the situation key, for the journal. */
      cls?: RecoveryClass; situation?: string;
      /** A person's press (`pressResume`) — see `RecoverOptions.person`. */
      person?: boolean;
    } = {},
  ): Promise<RunState | null> {
    // Asked of THIS plan. Another plan being mid-run is no longer a reason to
    // refuse — the scheduler admits the recovery against its scope, and holds
    // it if the trees actually overlap.
    if (this.liveRunner(slug)) {
      throw new RunBusyError(slug);
    }
    // A recovery spawns a session on this exact phase — the same collision a
    // second run would be, so the same refusal.
    this.assertNotClaimed(slug, [phase]);
    // The mirror of `resolveRecovery`'s guard 3, in the OTHER direction: an
    // agent recovery holds no runner, so `liveRunner` above cannot see it —
    // without this, "Fix with a new agent" plus "Finish in its own session"
    // was two sessions editing one tree at once.
    const busyOn = this.liveRecoveryFor({ slug, phase });
    if (busyOn) {
      throw new RecoveryBusyError(
        `A recovery session is already working on ${slug} phase ${phase} — open it instead.`,
        busyOn.id);
    }
    const root = this.root?.path;
    if (!root) throw new Error('No repository is open.');

    // The most recent run that actually reached this phase — recovery acts on a
    // real record, never on an invented one.
    const target = listRuns(root, slug, this.liveRunIds())
      .find((run) => run.phases[String(phase)]);
    if (!target) throw new Error(`No run of ${slug} has a record for phase ${phase}.`);

    // The mirror of `classifyOpenPhases`'s waiting rule, which this path never
    // had. A phase the board reads `waiting` has unmet dependencies: it has not
    // started, it cannot start, and there is no session for a recovery to
    // re-check or resume. Recovering it anyway ends in `closed()`'s
    // fall-through — "the board still reads waiting" — which is the runner
    // correctly describing work it should never have boarded, and which used to
    // settle the record `failed` and charge the streak for it. One run spent
    // its entire recovery budget that way on a phase 10 whose 7, 8 and 9 were
    // sitting ready and untouched.
    //
    // Both extra terms matter. `attempts > 0` means a session DID run for this
    // phase out of order, so there is something real to re-check whatever the
    // board says; a child on this phase means this run is driving it right now,
    // which is the same exception `classifyOpenPhases` carves out. An
    // unreadable board refuses nothing — uncertainty must not take the
    // operator's button away.
    const boardNow = await this.board(slug).catch(() => null);
    const record = target.phases[String(phase)];
    if (!boardNow?.error && boardNow?.states[phase] === 'waiting' && !(record && record.attempts > 0)
      && !childrenOf(target).some((child) => child.phase === phase)) {
      throw new Error(
        `Phase ${phase} of ${slug} has never been run and the board reads "waiting" — its `
        + 'dependencies are unmet, so there is no session to re-check and nothing a recovery '
        + 'could finish. Complete the phases it depends on first.',
      );
    }

    // Resolve-first, the same gate the unattended path runs: when the board
    // already reads this phase done, reconcile and answer with the records
    // closed — never spawn a session to "finish" finished work. A standing
    // `resolved` does NOT refuse here: an explicit click is a new instruction.
    const gate = await this.preRecoveryGate(slug, target, phase, { verb: true });
    if (gate === 'superseded') return target;
    // A phase parked on a declared EXTERNAL wall is not asked "are you done?"
    // (control-tower phase 111, #204). The three done-checks can only fail a
    // phase waiting on the outside world, and that failure re-judged the wall
    // `failed`/`no-handoff` — under the card's own recommended verb. Its
    // Recheck asks the wall's refs instead, and is not held to the RCV-4
    // ledger below: a probe of the world is new evidence every time.
    const walled = target.phases[String(phase)];
    if (mode === 'recheck' && walled && (walled.status === 'parked' || walled.status === 'waiting')
      && isExternalWall(walled, target.recoveries?.[String(phase)]?.errand)) {
      return this.recheckWall(slug, target, phase, opts.by ?? 'console');
    }
    // …but a click over evidence the LAST recovery already ran under is not a
    // new instruction (RCV-4): it cannot change anything, and 16 of 127
    // recoveries re-halted within seconds having changed nothing. Refused,
    // journalled, and the sentence names the recovery it repeats.
    if (gate === 'unchanged' || gate === 'capped') {
      const ledger = target.recoveries?.[String(phase)]?.recovers;
      journalOf(target)('run.recover.refused', {
        phase, why: gate, mode, by: opts.by ?? 'console',
        recovers: ledger?.count ?? 0, max: RECOVER_MAX_PER_PHASE, since: ledger?.lastAt ?? null,
        ...(ledger?.lastFingerprint ? { fingerprint: ledger.lastFingerprint.slice(0, 200) } : {}),
      }, phase);
      throw new Error(gate === 'unchanged'
        ? `Nothing has changed since the ${ledger?.lastMode ?? 'last'} recovery of phase ${phase} at ${ledger?.lastAt ?? '?'} — `
          + 'the board, the handoff, the locks and the gate read exactly as they did, so running it again would only '
          + 're-write the same halt. Change something (write the handoff, fix the plan, clear the account), or Retry the phase.'
        : `Phase ${phase} has been recovered ${ledger?.count ?? 0} times this run (the cap is ${RECOVER_MAX_PER_PHASE}). `
          + 'Retry the phase to start it over, which clears the count.');
    }
    // The evidence THIS recovery runs under, for the ledger the next one is
    // held to.
    const read = await this.board(slug).catch(() => null);
    const fingerprint = read && !read.error ? this.fingerprintFor(slug, target, read.states, read.qa) : undefined;

    const runner = this.runnerFor(slug);
    const armed = runner.recover({
      slug, root, runId: target.id, phase, mode,
      instruction: opts.instruction,
      ...(opts.cls ? { cls: opts.cls } : {}),
      ...(opts.situation ? { situation: opts.situation } : {}),
      ...(fingerprint ? { fingerprint } : {}),
      ...(opts.person ? { person: true } : {}),
      by: opts.by ?? 'console',
    });
    if (!opts.settled) return armed;
    await runner.wait();
    return runner.current() ?? armed;
  }

  /**
   * Recheck on a declared external wall (control-tower phase 111, #204): the
   * wall's own refs, probed NOW through the watch clock. A landing is offered
   * exactly as the scheduler offers one, so the phase's own session resumes;
   * anything else is ONE `run.recheck` line naming each ref and what it read,
   * with the wall, its halt, its errand and the record left as they were.
   */
  private async recheckWall(slug: string, target: RunState, phase: number, by: string): Promise<RunState> {
    const record = target.phases[String(phase)];
    const answer = await this.watchClock.recheck(slug, target, phase);
    const refs = answer.refs.map((r) => ({
      ref: r.ref, state: r.state, ...(r.detail ? { detail: r.detail.slice(0, 200) } : {}),
    }));
    if (answer.landed) {
      journalOf(target)('run.recheck', {
        phase, verdict: 'landed', wall: true, by, ref: answer.landed.ref,
        ...(answer.landed.detail ? { read: answer.landed.detail.slice(0, 200) } : {}),
        resumed: answer.outcome === 'resumed', refs,
      }, phase);
    } else {
      journalOf(target)('run.recheck', {
        phase, verdict: 'waiting', wall: true, by, refs,
        ...(refs.length ? {} : {
          why: record?.declared?.watch?.length
            ? 'every ref the declaration names was refused or retired — nothing will land it; Retry the phase'
            : 'the declaration names no ref the console can check — a person settles it, then Retry',
        }),
      }, phase);
    }
    const root = this.root?.path;
    return (root ? loadRun(root, slug, target.id, this.liveRunIds()) : null) ?? target;
  }

  /**
   * The tail of a person's resume (control-tower phase 53): when the recovery
   * found the session could not be resumed after all — its transcript would
   * not port, or the policy changed under the press — it left the phase hinted
   * to board fresh with the words, and this continues the run so the loop
   * boards it. Nothing happens when the recovery resumed the session, when
   * something else already drives the plan, or when runs are off.
   */
  private continueAfterPress(slug: string, runId: string, phase: number, actor: StartActor): void {
    const runner = this.runners.get(slug);
    if (!runner) return;
    void runner.wait().then(async () => {
      if (!this.flags.allowRun || this.liveRunner(slug) || this.fleetHoldFor(slug)) return;
      const state = runner.current();
      const hint = state?.id === runId ? state.phases[String(phase)]?.boardingHint : undefined;
      if (!hint || hint.by !== PERSON_SLOT_BY || state?.phases[String(phase)]?.status !== 'pending') return;
      await this.startRun(slug, {
        // Spelled out, not shorthand: SLF-1 reads the door off `actor: <name>`.
        actor: actor, resumeRunId: runId,
        ...(state.onlyPhases?.length ? { onlyPhases: state.onlyPhases } : {}),
        skills: state.skills ?? [],
      });
    }).catch((error) => log.warn('run.press-continue-failed', { slug, phase, error: (error as Error)?.message }));
  }

  /**
   * One press, the whole honest sequence — the plan-level "Recover & continue".
   *
   * Step 1 CONFIRMS the root issue instead of trusting the record: the board
   * is re-read and anything it has moved past is stood down (records closed,
   * halt dissolved, the stale alarm retracted). Step 2: nothing actually
   * wrong → the run simply continues under normal admission. Step 3: a REAL
   * halt → bounded auto-recovery is armed on the run and the healer runs NOW
   * — the same `maybeAutoRecover` the unattended path uses, budget, vehicle
   * choice, resolve-first gate and announcements included, so this button
   * cannot corrupt the orchestration it rides. Anything only a person can
   * settle comes back named, never blindly retried.
   */
  async recoverPlan(slug: string, actor: StartActor): Promise<{
    outcome: 'running' | 'waiting' | 'resumed' | 'recovering' | 'errand' | 'nothing-to-do';
    detail: string;
    steps: string[];
    run: RunState | null;
    /** The one ask for a person, when the outcome is `errand`. */
    errand?: Errand;
    /** The orphan still working, when the outcome is `waiting` (#21 §2). */
    pid?: number;
    sessionId?: string | null;
  }> {
    const steps: string[] = [];
    const root = this.root?.path;
    if (!root) throw new Error('No source directory is open.');
    // Nothing this press could launch would pass admission under a hold that
    // binds the plan — it would queue, and the answer would read as a recovery
    // (control-tower phase 81, #93). Refused by name; the route answers 409.
    const held = this.fleetHoldFor(slug);
    if (held) throw new Error(`${slug} was not recovered — ${fleetHoldSentence(held)}.`);
    const live = this.liveRunner(slug);
    if (live) {
      return {
        outcome: 'running', steps,
        detail: `${slug} is already running — nothing to recover.`,
        run: live.current(),
      };
    }
    const state = latestRun(root, slug, this.liveRunIds());
    if (!state) {
      return {
        outcome: 'nothing-to-do', steps,
        detail: 'No run of this plan exists yet — Start is the verb you want.',
        run: null,
      };
    }

    /* 0. A session from an earlier console is STILL WORKING in this run (#21 §2).
     *
     * Nothing is wrong here and nothing is recoverable: converge already skips
     * such a run ("waiting for it to end"), and the healer then read the
     * skipped phase as abandoned work and wrote an errand asking someone to
     * finish it — measured against a pid that was committing at the time. The
     * press answers what is true instead, and writes nothing.
     *
     * Asked of the PROCESS rather than the halt: step 1 below may retract the
     * halt, and the child is the fact either way. A run this console drives has
     * already returned `running` above, so an alive child here is a foreign
     * one by construction. */
    const orphan = childrenOf(state).find((child) => pidHoldsWork(child.pid, procIdentity(child)));
    if (orphan) {
      const sessionId = state.phases[String(orphan.phase)]?.sessionId ?? orphan.sessionId ?? null;
      Journal.for(root, slug, state.id).append('run.plan-recover', {
        step: 'waiting', phase: orphan.phase, pid: orphan.pid, sessionId,
      });
      return {
        outcome: 'waiting', steps, pid: orphan.pid, sessionId,
        detail: `Phase ${orphan.phase}'s session from an earlier console (pid ${orphan.pid}`
          + `${sessionId ? `, session ${sessionId}` : ''}) is still working. Nothing was changed — `
          + 'the run continues by itself when that session ends. Stop it from the run\'s halt card '
          + 'if you want it to end now.',
        run: state,
      };
    }

    /* 1. Confirm against the board — the root issue must be real.
     *
     * A board that could not be read confirms NOTHING. This step used to take
     * `boardStates`' `{}` for an answer, and the emptiness then flowed into
     * step 2's `remaining` filter — which found no non-`done` entry and told
     * the operator "Every phase reads done on the board", about a plan whose
     * board the console had just failed to read. Say what happened instead. */
    const board = await this.board(slug);
    if (board.error) {
      return {
        outcome: 'nothing-to-do', steps,
        detail: `The console could not read the board for ${slug}: ${board.error}. `
          + 'Nothing was reconciled or resumed — run scripts/phase-graph.sh yourself to see why.',
        run: state,
      };
    }
    const journal = Journal.for(root, slug, state.id);
    // A resolution this press FOUND on the run — an older reading's, which
    // step 1a re-asks — as distinct from one step 1 is about to write itself.
    const foundResolved = Boolean(state.resolved);
    const result = reconcileRecordsAgainstBoard(state, board.states, undefined, (event, data, phase) => journal.append(event, data, phase));
    if (result.changed) {
      steps.push(`the board had moved past phase${result.closed.length === 1 ? '' : 's'} `
        + `${result.closed.join(', ')} — stale record${result.closed.length === 1 ? '' : 's'} closed`);
      journal.append('run.plan-recover', { step: 'reconciled', closed: result.closed });
    }
    if (!state.resolved) autoResolveRun(state, board.states);
    if (result.changed || state.resolved) {
      try { saveRun(state); } catch { /* the verdict matters more than the write */ }
      this.emit('run:state', { state });
      this.retractHalt(state, 'Recover pressed — the board shows the stop settled', { push: false });
    }

    /* 1a. A stop about the PLAN is answered by the plan (control-tower phase 81,
     * #97) — and so is one written off as settled, which is what an older
     * console made of every plan-lint stop: its anchor reads done, so the board
     * "superseded" it, and the press then relaunched straight into the same red
     * lint without asking. The lint decides here, before 1b could read the
     * anchor: clean clears the stop and continues below (step 2's one start);
     * red keeps a plan stop and answers with what validate.sh said; a lint that
     * could not run relaunches nothing — "I could not check" is not "clean". */
    const planHalt = state.halt && isPlanHalt(state.halt.kind) ? state.halt : null;
    // Not every resolved stop: one this press's own step 1 just resolved is the
    // board's to answer (1b), and a clean lint is not why it stands down.
    if (planHalt || (foundResolved && state.resolved && !state.halt)) {
      const lint = await this.lint(slug);
      const ran = lint != null && !lint.timedOut && !lint.crashed;
      if (ran && lint.ok) {
        const kind = state.halt?.kind ?? null;
        state.halt = null;
        state.resolved = null;
        state.reopenedAt = null;
        steps.push(`the plan lints clean — the ${kind ?? 'settled'} stop is answered`);
        journal.append('run.plan-recover', { step: 'lint-clean', kind });
        try { saveRun(state); } catch { /* the verdict matters more than the write */ }
        this.emit('run:state', { state });
        this.retractHalt(state, 'Recover pressed — the plan lints clean', { push: false });
      } else if (ran) {
        // Red, whichever of the two shapes brought the press here: a run
        // relaunched now stops on this same lint after its next phase.
        const errand = errandFor('plan-broken:lint', [], planHalt?.phase ?? 0, undefined, undefined,
          { kind: 'lint', detail: lint.summary, validateOk: false });
        state.errand = errand;
        journal.append('run.plan-recover', {
          step: 'lint-red', kind: planHalt?.kind ?? null, summary: lint.summary.slice(0, 300),
        });
        try { saveRun(state); } catch { /* the verdict matters more than the write */ }
        this.emit('run:state', { state });
        // Converge relaunches a plan stop nobody pinned the moment the plan
        // lints clean; a dismissed one, or a settled mark with no stop left,
        // stays pinned until the next press — say which.
        const converges = Boolean(planHalt) && state.stoppedBy !== 'operator' && (!state.resolved || state.resolved.auto);
        return {
          outcome: 'errand', steps, errand,
          detail: `The plan still fails validate.sh — ${lint.summary}. Nothing was relaunched: the run would stop `
            + 'on the same lint after its next phase. Fix what it names; '
            + (converges ? 'the run continues by itself once it lints clean.' : 'then press Recover again.'),
          run: state,
        };
      } else {
        journal.append('run.plan-recover', {
          step: 'lint-unrun', kind: planHalt?.kind ?? null,
          why: lint == null ? 'no-plan' : lint.timedOut ? 'timeout' : 'crashed',
        });
        return {
          outcome: 'nothing-to-do', steps,
          detail: `The plan's lint could not run${lint?.timedOut ? ' (it timed out)' : ''} — nothing was relaunched. `
            + `The ${planHalt?.kind ?? 'settled'} stop is answered by a clean lint; press again once the machine is less busy.`,
          run: state,
        };
      }
    }

    /* 1b. A halt whose ANCHOR the board shows done (control-tower phase 45, #45).
     *
     * Reconcile dissolves a run halt anchored on a phase it CLOSES, and it
     * deliberately closes nothing this run adjudicated — which is exactly what
     * a `failure-streak` halt's anchor usually is. Measured: two runs halted
     * `failure-streak` on phases the board read done; this press answered
     * "superseded — nothing to launch" and left each one halted with ready
     * phases, until somebody made the start call by hand. The press IS the
     * person's considered look a press-only stop waits for: a stop anchored on
     * a phase the board shows done is superseded, so it is cleared here and the
     * run continues below. A QA verdict still holding that phase is the one
     * exception — a real blocker, which the ladder climbs in step 3. */
    const anchor = state.halt?.phase;
    if (state.halt && anchor != null && board.states[anchor] === 'done' && !(await this.qaHolds(slug, anchor))) {
      const kind = state.halt.kind ?? null;
      state.halt = null;
      steps.push(`the board shows phase ${anchor} done — the ${kind ?? 'halt'} stop anchored on it no longer stands`);
      journal.append('run.plan-recover', { step: 'superseded', phase: anchor, kind });
      try { saveRun(state); } catch { /* the verdict matters more than the write */ }
      this.emit('run:state', { state });
      this.retractHalt(state, `Recover pressed — the board shows phase ${anchor} done`, { push: false });
    }

    /* 2. Nothing wrong any more → continue, or say it is finished. */
    if (!state.halt) {
      const remaining = Object.entries(board.states).filter(([, phaseState]) => phaseState !== 'done');
      if (!remaining.length) {
        journal.append('run.plan-recover', { step: 'clean', note: 'every phase reads done' });
        return {
          outcome: 'nothing-to-do', steps,
          detail: 'Every phase reads done on the board — nothing to recover or continue.',
          run: state,
        };
      }
      steps.push(`continuing the run — ${remaining.length} phase(s) remain`);
      journal.append('run.plan-recover', { step: 'resume', remaining: remaining.length });
      const run = await this.startRun(slug, {
        actor: actor ?? unattributedActor('Service.recoverPlan'),
        resumeRunId: state.id,
        ...(state.onlyPhases?.length ? { onlyPhases: state.onlyPhases } : {}),
        skills: state.skills ?? [],
      });
      return {
        outcome: 'resumed', steps,
        detail: 'The board had moved past the stop — the run continues from here.',
        run,
      };
    }

    /* 3. A real halt: arm bounded auto-recovery and CONVERGE NOW — the same
     * pass the unattended loop runs (debris, killed lanes, the healer's
     * classify-and-climb), with the pins off because this IS the operator's
     * press. Anything only a person can settle comes back as the one Errand —
     * what is needed and how to give it — never a bare "needs you". */
    if (!state.autoRecover) {
      // Arming is a BOOLEAN — the ladder's `perPhaseRungs` is the bound, and it
      // is the operator's to set. The `2` written here used to be a second,
      // lower ceiling that silently beat the pref (P6/D5); the field survives
      // only so older consoles reading the same run file still see "armed".
      const bound = ladderCaps(this.prefs).perPhaseRungs;
      this.editStoredRun(slug, (stored) => { stored.autoRecover = {}; });
      steps.push(`armed auto-recovery on this run (${bound} bounded rungs per phase)`);
      journal.append('run.plan-recover', { step: 'armed', attempts: bound });
    }
    const report = await this.converger.converge(slug, 'button');
    // A pass that found the run already live — a boot pass or the halt's own
    // minute beat the press to it — is a run being recovered, not a refusal.
    const nowLive = this.liveRunner(slug);
    if (nowLive && !report?.launched) {
      steps.push('the run is already being driven — the loop got there first');
      journal.append('run.plan-recover', { step: 'already-live' });
      return {
        outcome: 'recovering', steps,
        detail: 'The run is already being recovered by the console. You will be notified with the verdict either way.',
        run: nowLive.current(),
      };
    }
    const after = latestRun(root, slug, this.liveRunIds()) ?? state;
    const heal = report?.outcomes.find((o) => o.action.kind === 'heal')?.heal;
    const relaunch = report?.outcomes.find((o) => o.action.kind === 'relaunch' && o.ok)?.action;
    if (relaunch?.kind === 'relaunch') {
      steps.push(`continuing the run — ${relaunch.why.join('; ') || 'the stop was the console\'s own'}`);
    }
    // The step is named: which phase, what it reads as, which rung — so the
    // answer is never about nothing in particular.
    if (heal?.phase != null && heal.label) {
      const vehicleWords = heal.vehicle === 'retry' ? 're-boarding it fresh through the runner'
        : heal.vehicle === 'reboard' ? 're-boarding it through the runner with a brief'
          : heal.vehicle === 'session' ? 'resuming its own session through the runner'
            : heal.vehicle === 'agent' ? 'briefing a fresh agent'
              : null;
      steps.push(`phase ${heal.phase} reads ${heal.label}`
        + (heal.launched && vehicleWords ? ` — ${vehicleWords}${heal.rung ? ` (rung ${heal.rung})` : ''}` : ''));
    }
    if (report?.launched) {
      steps.push('launched the recovery — the run continues by itself when the board reads fixed');
      journal.append('run.plan-recover', {
        step: 'launched', phase: heal?.phase ?? null, situation: heal?.situation ?? null,
        rung: heal?.rung ?? null, vehicle: heal?.vehicle ?? null, relaunch: Boolean(relaunch),
      });
      return {
        outcome: 'recovering', steps,
        detail: 'A bounded recovery is running. You will be notified with the verdict either way.',
        run: after,
      };
    }
    // Nothing launched: the ONE errand. The pass's own (written or standing),
    // else the healer's anchor phase's, else one composed from what the healer
    // refused on — and, with no phase to hang it on at all, from the halt.
    const phaseErrand = report?.errands[0]
      ?? (heal?.phase != null
        ? (after.recoveries?.[String(heal.phase)]?.errand
          ?? (heal.situation ? errandFor(heal.situation, after.recoveries?.[String(heal.phase)]?.rungs ?? [], heal.phase) : undefined))
        : undefined);
    // A halt that NAMES a phase can still be classified even when the healer
    // had no candidate for it. `classifyPhase` reads the board and the QA table
    // directly, so it answers correctly for the one shape `classifyOpenPhases`
    // deliberately skips: a phase the board reads DONE whose QA verdict holds
    // the plan — settled as work, unsettled as a blocker. Without this the
    // answer was `errandFor('unknown', [], 0)`: an errand anchored on phase 0,
    // telling the operator to open "Why is this not done?" on a page that does
    // not exist, about a run whose real blocker the console already knew.
    let haltErrand: Errand | undefined;
    if (!phaseErrand && !after.errand && after.halt?.phase != null) {
      try {
        // An unreadable board is not a board: classifying against `{}` would
        // read every phase as `unknown` and name a situation nobody observed.
        // Falling through to `situationOfHalt` below is the honest answer.
        const board = await this.board(slug);
        if (board.error) throw new Error(board.error);
        const { situation } = await this.classifyPhase(slug, after.halt.phase, after, board.states);
        haltErrand = errandFor(situation.key, [], after.halt.phase);
      } catch (error) {
        // Classification is an improvement on the fallback, never a
        // precondition for answering: a read that could not run must not turn
        // "here is your ask" into an exception.
        log.warn('run.halt-classify-failed', { slug, phase: after.halt.phase, error });
      }
    }
    const errand = phaseErrand ?? after.errand ?? haltErrand
      ?? errandFor(situationOfHalt(after.halt), [], after.halt?.phase ?? 0);
    if (!phaseErrand && !after.errand) {
      // A run-level stop with no phase behind it keeps its ask on the run.
      this.editStoredRunById(slug, after.id, (stored) => { stored.errand = errand; });
    }
    journal.append('run.plan-recover', { step: 'errand', reason: heal?.reason ?? null, phase: errand.phase, situation: errand.situation });
    // A person's ask is answered by the person, never by this press (control-
    // tower phase 88, #124): Recover used to re-derive it and read as broken.
    const how = liveErrandHow(errand, after.phases?.[String(errand.phase)]);
    return {
      outcome: 'errand', steps, errand,
      detail: isPersonErrand(errand.situation)
        ? `This needs your answer: phase ${errand.phase} asked a person. Needed: ${errand.need} Once it is done, press `
          + `Done — continue on phase ${errand.phase} (or Retry phase ${errand.phase}) — Recover cannot answer it for you. How: ${how}`
        : `${heal?.reason ?? 'This stop needs a person'}. Needed: ${errand.need} How: ${how}`,
      run: latestRun(root, slug, this.liveRunIds()) ?? after,
    };
  }

  /* ---------------------------------------------------------------- *
   * The convergence loop — see converge.ts
   * ---------------------------------------------------------------- */

  /**
   * The plans a sweep visits: open, phased, and with at least one run recorded.
   *
   * Open means neither closed (`close-plan.sh` wrote `closed:`) nor carrying a
   * terminal `status:` — a plan finished by hand says `status: complete` and
   * nothing else, and a sweep over it had nothing to do but journal one
   * `converge.frozen` line per pass through every freeze (control-tower phase
   * 48, #70: nearly half of one drain's lines were about finished plans).
   */
  convergeSlugs(): string[] {
    if (!this.root?.ok || !this.convergeAutomatic()) return [];
    const root = this.root.path;
    return (this.store?.list() ?? [])
      .filter((record) => record.plan?.phased && !record.plan.closed && !isClosedPlanStatus(record.plan.status)
        && existsSync(runDir(root, record.slug)))
      .map((record) => record.slug);
  }

  /** One pass of the loop for one plan — what the scheduler calls. Null when it cannot run here. */
  async convergeNow(slug: string, trigger: ConvergeTrigger, lastNoop: string | null = null): Promise<ConvergeReport | null> {
    if (!this.root?.ok) return null;
    // Reading the runs settles what needs settling (`settleWaitingRecords`, on
    // the load path) and says out loud, once, what stays overdue — before the
    // capability check, because announcing needs no flag and a read-only
    // console is the one whose clocks nothing will ever fire.
    await this.announceOverdueParks(slug);
    // The automatic triggers need the capability that makes any of it real; the
    // operator's own press still gets an answer — its refusals are named.
    if (!this.flags.allowRun && trigger !== 'button') return null;
    return convergePlan(this.convergeDeps(), slug, trigger, lastNoop);
  }

  /**
   * WAI-6 (iii): the inbox's `park-overdue` row — a `waiting` record whose
   * `parkedUntil` is past by the row's own floor — is ANNOUNCED once, on the
   * same condition the row is raised on, so "the row appears" and "the phone
   * was told" are one fact. The stamp rides the record, so a restart does not
   * repeat it; a new clock on the same phase is news again. The row used to be
   * the only surface, and nothing announced it.
   */
  private async announceOverdueParks(slug: string): Promise<void> {
    const now = Date.now();
    const floor = STALL_META['park-overdue'].afterMs;
    for (const state of await this.runsFor(slug)) {
      let changed = false;
      for (const record of Object.values(state.phases)) {
        if (record.status !== 'waiting' || !record.parkedUntil) continue;
        const lateByMs = now - Date.parse(record.parkedUntil);
        if (!Number.isFinite(lateByMs) || lateByMs < floor) continue;
        if (record.parkOverdueAnnouncedFor === record.parkedUntil) continue;
        record.parkOverdueAnnouncedFor = record.parkedUntil;
        changed = true;
        this.announce('parked', {
          title: 'A park is overdue',
          body: `${slug} phase ${record.phase} — parked until ${record.parkedUntil}, ${Math.round(lateByMs / 60_000)} min ago, `
            + 'and nothing has resumed it. The arming failed, not the waiting: Recover & continue on the run, or Retry the phase.',
          tag: tagFor('parked', slug, state.id, `park-overdue-${record.phase}`),
        }, { slug, runId: state.id, phase: record.phase });
      }
      if (changed) saveRun(state);
    }
  }

  /** The last pass per plan, for the Pulse. */
  convergeReports(): ConvergeReport[] { return [...this.converger.reports.values()]; }

  /** The last pass per plan, flattened for a reader (`GET /api/converge`, the Pulse). */
  convergeViews(): ConvergeView[] { return this.convergeReports().map(convergeView); }

  /**
   * What the convergence loop is doing: whether its automatic passes are on
   * for this console (`--no-converge` / `--allow-run`), the sweep interval,
   * what is queued and running, and the last report per plan.
   */
  convergeStatus(): {
    automatic: boolean;
    everyMs: number;
    pending: { slug: string; trigger: string; dueAt: number }[];
    running: string[];
    reports: ConvergeView[];
  } {
    const snapshot = this.converger.snapshot();
    return {
      automatic: this.convergeAutomatic(),
      everyMs: this.prefs.convergeEveryMs ?? 0,
      pending: snapshot.pending,
      running: snapshot.running,
      reports: this.convergeViews(),
    };
  }

  /**
   * One stat, so that approving a gate is evidence. `gate-approve.sh` and the
   * Gate card both write this file, and nothing else the convergence loop or
   * the healer reads moves when they do — see `ConvergeFacts.gateStamp`.
   */
  /**
   * The accounts breaker, as one stamp, so that clearing a retired account is
   * evidence (#36) — see `ConvergeFacts.accountsStamp`. Null when the read
   * fails: an unreadable breaker is no change, never a permanent one.
   */
  protected accountsStampFor(): string | null {
    try { return this.accounts.breakerStamp(); } catch { return null; }
  }

  protected gateStampFor(slug: string): string | null {
    const dir = this.root?.handoffsDir;
    if (!dir) return null;
    try {
      const stat = statSync(join(dir, slug, 'gate-status.md'));
      return `${stat.mtimeMs}:${stat.size}`;
    } catch { return null; }
  }

  private convergeDeps(): ConvergeDeps {
    const journals = new Map<string, Journal>();
    return {
      runs: (slug) => this.runsFor(slug),
      live: () => this.liveRunIds(),
      board: async (slug) => {
        try {
          const board = await this.board(slug);
          return board.error ? null : board.states;
        } catch { return null; }
      },
      locks: (slug) => this.allLocks().filter((lock) => lock.slug === slug),
      // The one question a session-cap park has (D28/P8). Asked per pass rather
      // than stored, like every other fact here: a lane freeing is precisely
      // the event such a park waits for, and a stale answer would either strand
      // the phase or re-board it into a fleet that is still full.
      laneFree: () => {
        const fleet = this.scheduler.snapshot();
        return fleet.live < fleet.max;
      },
      // One stat, so that approving a gate is evidence. `gate-approve.sh` and
      // the Gate card both write this file, and nothing else converge reads
      // moves when they do — see `ConvergeFacts.gateStamp`.
      gateStamp: (slug) => this.gateStampFor(slug),
      // The accounts breaker, for the same reason: clearing a retired account
      // moves nothing else converge reads (#36).
      accountsStamp: () => this.accountsStampFor(),
      // The board's QA verdicts, from the same read `board` already made. In
      // the fingerprint for the same reason `gateStamp` is: giving the verdict
      // a person was asked for moves nothing else the loop looks at.
      qa: async (slug) => {
        try {
          const board = await this.board(slug);
          return board.error ? null : board.qa;
        } catch { return null; }
      },
      // The automatic gates' verdicts (#48): read FRESH, with the runner's own
      // `PHASE_EXEC_GATES=1` so a `cmd` gate is judged exactly as boarding
      // judges it, and never through the per-revision cache — a cross-plan
      // gate moves with ANOTHER plan's files, which never bump this plan's
      // revision. Only an automatic Gate-check is asked: a person's gate
      // clears through `gate-status.md`, which `gateStamp` already covers.
      gates: async (slug, phases) => {
        const plan = this.store?.get(slug)?.plan;
        const verdicts: Record<number, string> = {};
        for (const phase of phases) {
          const detail = plan?.phases?.[phase];
          if (!detail || gateKindOf(detail.gateCheck, detail.gated, this.gateVocab) !== 'auto') continue;
          try {
            const gate = readGateStatus(await run(
              this.engineOpts(), 'phase-graph.sh', [slug, '--gate-status', String(phase)], undefined,
              { env: { PHASE_EXEC_GATES: '1' } },
            ));
            verdicts[phase] = gate.clear ? 'clear' : (gate.kind || 'blocked');
          } catch { /* an unreadable gate is no verdict — never a clearing */ }
        }
        return verdicts;
      },
      // The plan's own word on whether it is still open (CG-4).
      planStatus: (slug) => this.store?.get(slug)?.plan?.status ?? null,
      // The lint that answers a stop about the plan (control-tower phase 81,
      // #97) — the page's own per-revision cache, so a plan that changed on
      // disk is linted afresh and one that did not costs nothing.
      lint: (slug) => this.lint(slug),
      prefs: () => ({ resumeAtBoot: this.prefs.resumeAtBoot }),
      resumeDecision: (runId) => this.resumeDecisions.get(runId) ?? null,
      // An expired or signed-out stop whose login works again on the same
      // identity (control-tower phase 91, #147): the clock's to relaunch too.
      loginRestored: (run) => this.loginRestoredFor(run),
      awaitDecision: (slug, runId, phases, sessions) => {
        const first = !this.resumeAsks.has(runId);
        this.resumeAsks.set(runId, { slug, runId, phases, sessions, at: new Date().toISOString() });
        return first;
      },
      // A `continue` is spent by the launch it authorised: the next restart asks again.
      consumeDecision: (runId) => { this.resumeDecisions.delete(runId); this.resumeAsks.delete(runId); },
      resumeWait: (slug, runId, trigger) => this.resumeOverdueWait(slug, runId, trigger, { count: true }),
      // Through `lockPresenceFor`, never the raw registry (SCH-3) — and this is
      // the dep that DELETES a lock: converge's `endedSessionLocks` releases
      // what reads `ended`. A lane's lock outliving its attempt's session is
      // ordinary, so the raw word here released claims that runs were holding.
      presence: (lock) => this.lockPresenceFor(lock),
      // What a lane declared before it ended, still in its armed file (#21 §3).
      // The board catches up a commit later, so this is the earlier half of the
      // same fact — and the only one available to a run whose child wrote its
      // handoff into a tree the docs watcher has not read yet.
      declaredOutcome: (slug, runId, phase) => {
        if (!this.root?.ok) return null;
        try {
          return readOutcome(outcomeFileFor(this.root.path, slug, runId, phase), { slug, phase })?.status ?? null;
        } catch { return null; }
      },
      heal: (slug, pass) => this.maybeAutoRecover(slug, pass),
      startRun: (slug, options) => this.startRun(slug, options),
      editRun: (slug, runId, apply) => this.editStoredRunById(slug, runId, apply),
      releaseLock: (slug, phase, owner) => this.releaseDebrisLock(slug, phase, owner),
      journal: (slug, runId, event, data, phase) => {
        if (!this.root) return;
        const key = `${slug}/${runId}`;
        let journal = journals.get(key);
        if (!journal) { journal = Journal.for(this.root.path, slug, runId); journals.set(key, journal); }
        journal.append(event, data, phase);
      },
      // The third producer of errands. Same channel, same dedupe.
      // The third producer of errands. Same channel, same dedupe — including the
      // run-level ones (`phase: null`), which this used to discard silently.
      announceErrand: (slug, runId, phase, errand) => {
        this.announceErrand({ slug, runId, ...(phase != null ? { phase } : {}), errand });
      },
      locksChanged: (slug) => {
        // The store's lock view lags the disk by a watcher debounce, and the
        // queue may be waiting on exactly this lock. Refresh, then poll.
        const handoffsDir = this.root?.handoffsDir;
        if (handoffsDir) this.store?.refresh([join(handoffsDir, slug, '.locks')]);
        this.scheduler.poll();
      },
    };
  }

  /* ---------------------------------------------------------------- *
   * Session presence (Phase 5): the registry the user-scope hook feeds,
   * the hook installer, and the inbox of outcomes sessions nobody here
   * spawned declare.
   * ---------------------------------------------------------------- */

  /** Every lock the store holds, in the registry's correlation shape. */
  private locksForCorrelation(): { slug: string; phase: number; owner: string; session?: string; claimedAt?: number }[] {
    const out: { slug: string; phase: number; owner: string; session?: string; claimedAt?: number }[] = [];
    for (const record of this.store?.list() ?? []) {
      if (record.plan?.closed) continue;
      for (const lock of record.locks) {
        out.push({
          slug: record.slug, phase: lock.phase, owner: lock.owner,
          ...(lock.session ? { session: lock.session } : {}),
          ...(lock.claimedAt != null ? { claimedAt: lock.claimedAt } : {}),
        });
      }
    }
    return out;
  }

  /**
   * Every unresolved run's phases, in the registry's correlation shape — the
   * second source `correlate` consults, and the one that keeps a session named
   * after its lock is gone.
   *
   * Two sources unioned, because neither alone covers the case this exists
   * for. Live runners answer for free and are always current. The disk answers
   * for the run whose console DIED — which is the whole incident: the console
   * restarted, no runner is driving that run, and its record on disk still
   * names the session, the slug and the phase of a child that outlived it.
   *
   * Bounded by `resolved`: a run somebody has closed out makes no claim about
   * any session, and scanning finished runs would be a growing cost for
   * answers that are all `undefined`.
   */
  private runsForCorrelation(): RunLink[] {
    const out: RunLink[] = [];
    const seen = new Set<string>();
    const add = (run: RunState): void => {
      if (run.resolved) return;
      const runLive = IN_FLIGHT.includes(run.status);
      for (const [key, record] of Object.entries(run.phases ?? {})) {
        const phase = Number(key);
        if (!Number.isFinite(phase)) continue;
        // One entry per (run, phase); the live runner wins the tie because it
        // is reading the same record the disk copy was written from.
        const id = `${run.id}:${phase}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          runId: run.id,
          slug: run.slug,
          phase,
          ...(record.sessionId ? { sessionId: record.sessionId } : {}),
          ...(runLive && PHASE_IN_FLIGHT.includes(record.status) ? { active: true } : {}),
        });
      }
    };
    for (const run of this.runStates()) add(run);
    if (this.root) {
      for (const record of this.store?.list() ?? []) {
        if (record.plan?.closed) continue;
        for (const run of listRuns(this.root.path, record.slug, this.liveRunIds())) add(run);
      }
    }
    return out;
  }

  /** The registry as the API and the Pulse read it: every session with its presence and the plan+phase it works. */
  sessionViews(): SessionView[] {
    return this.sessions.views(this.locksForCorrelation(), this.runsForCorrelation());
  }

  /**
   * `POST /hooks/session`: validate, rate-limit, ingest. The caller is the
   * hook script on this machine — no run token (there is no run), no console
   * header (it is not a browser); the route keeps it to loopback and this
   * keeps it to a body that is a session event and a rate a person's sessions
   * can actually produce.
   */
  ingestSessionEvent(body: unknown): SessionRecord {
    const payload = parseHookPayload(body);
    if (!payload) {
      throw new HookPayloadError('not a session event — session_id, event (SessionStart|SessionEnd|Stop|Notification) and an absolute cwd are required');
    }
    const now = Date.now();
    const refill = Math.floor((now - this.hookBucket.at) / 1000) * (HOOK_EVENTS_PER_MINUTE / 60);
    if (refill >= 1) {
      this.hookBucket.tokens = Math.min(HOOK_EVENTS_PER_MINUTE, this.hookBucket.tokens + Math.floor(refill));
      this.hookBucket.at = now;
    }
    if (this.hookBucket.tokens < 1) throw new HookRateError('too many session events — try again in a moment');
    this.hookBucket.tokens -= 1;
    return this.sessions.ingest(payload);
  }

  /**
   * What a starting session is told about who else is in its repository
   * (REG-3 iv) — the SessionStart hook reads it off the POST's answer and puts
   * it in the session's `additionalContext`, beside its own id: every live
   * session the registry shows in the same root, with its pid, where it stands
   * and what it is working when that is known. Null when nobody else is there,
   * so a session alone in its repository is told nothing new.
   */
  sessionPeersSentence(record: SessionRecord): string | null {
    const root = record.root ?? this.root?.path;
    if (!root) return null;
    let present: ReturnType<SessionRegistry['inRoot']>;
    try {
      present = this.sessions.inRoot(root, { excluding: [record.sessionId] }).filter((peer) => peer.presence === 'live');
    } catch { return null; }
    if (!present.length) return null;
    const plans = new Map<string, { slug: string; phase: number } | undefined>();
    try { for (const view of this.sessionViews()) plans.set(view.sessionId, view.plan); } catch { /* names without plans */ }
    return peersSentence(root, present, plans);
  }

  /** The runs each session has already been told it blocks — one notice per (session, run). */
  private readonly blockNoticed = new Set<string>();

  /**
   * The one line a terminal's own presence hook prints when that session has
   * started blocking a run (control-tower phase 82, #119, SS-4). The session
   * could not know: the scheduler named it a holder, the Runs page said
   * "queued", and the person in it kept chatting about something else. Read
   * off the queue as it stands — any entry waiting on this session — and said
   * once per run, never once per turn. Null when it blocks nothing new.
   */
  sessionBlockingNotice(record: SessionRecord): string | null {
    let entries: QueueEntry[];
    try { entries = this.scheduler.snapshot().entries; } catch { return null; }
    for (const entry of entries) {
      const holder = entry.waitingOn.find((h) => h.kind === 'session' && h.session === record.sessionId);
      if (!holder) continue;
      const key = `${record.sessionId}:${entry.runId}`;
      if (this.blockNoticed.has(key)) continue;
      this.blockNoticed.add(key);
      log.info('session.blocking-noticed', {
        sessionId: record.sessionId, runId: entry.runId, slug: entry.slug, phase: entry.phase, scope: holder.scope,
      });
      const where = entry.phase != null ? `${entry.slug} P${entry.phase}` : entry.slug;
      const how = holder.scopeBasis === 'touched' ? 'read from what this session edited'
        : holder.scopeBasis === 'declared' ? 'its declared PE_SCOPE'
          : 'nothing touched yet, so it may be anything until its lease ends';
      return `Phase Console: this session is holding ${where} (run ${entry.runId.slice(0, 8)}) — `
        + `the autopilot is waiting on scope ${holder.scope.join(', ')} (${how}). `
        + 'If you are not working there, release it from the queued phase on the Runs page.';
    }
    return null;
  }

  /**
   * Release a terminal session's hold on the queue (control-tower phase 82,
   * #119, SS-3) — "not touching this repository" (no hours: while it lives) or
   * for `hours`. Null for a session the registry does not know. The queue is
   * polled at once, so a phase that was waiting only on this session boards.
   */
  releaseSessionHold(sessionId: string, opts: { hours?: number; by: string }): SessionRecord | null {
    const record = this.sessions.releaseHold(sessionId, opts);
    if (!record) return null;
    log.info('session.hold-released', { sessionId, by: opts.by, until: record.holdReleased?.until ?? null });
    this.scheduler.poll();
    return record;
  }

  /**
   * A record in the registry moved. Every move reaches the browser on the
   * `sessions` event (the Pulse lists foreign sessions beside the lanes); an
   * ENDED session is the one that changes what may run — its lock is debris
   * now — so the queue is polled and the convergence loop asked to look at
   * the plan it was working (or every open one, when no lock says which).
   */
  protected onPresenceChange(record: SessionRecord, event: RegistryChange, meta?: ChangeMeta): void {
    const presence = this.sessions.presence(record.sessionId);
    // HISTORY (REG-2 ii): an event the inbox held past the horizon is a fact
    // the record learns, never news. A move with no meta of its own (the probe's
    // synthesized end, the wait settlements) inherits it from the event that
    // put the record where it is, so a two-hour-old ask closed "unanswered" by
    // the same boot is not pushed either.
    const history = meta ? meta.history : record.lastEvent?.history === true;
    const views = this.sessionViews();
    this.emit('sessions', {
      type: 'presence',
      event,
      presence: { ...record, presence },
      sessions: this.terminals.state().sessions,
      live: this.terminals.live(),
      foreign: views,
    });

    // The session-ask push: a session stopped waiting on a person, and only a
    // LIVE one — ended is over, unknown is a claim nobody can vouch for.
    //
    // Autopilot lanes too, since 5.0.0 (REG-5, TRS-6). They used to be excluded
    // on the ground that a lane's asks arrive as approval cards, and on the
    // measured machine that channel had never carried one — so the one session
    // class the console pays for was the one whose wait reached no surface. A
    // lane is now deduplicated against a pending card for its own phase instead
    // of suppressed by kind, and that one suppression is logged.
    //
    // `SESSION_ASK_WAIT_KINDS`, not "any waiting record": the registry records
    // an `idle_prompt` as `waiting` too — the sessions page shows it — but a
    // finished turn is what a terminal at rest looks like, and pushing for it
    // is how the urgent channel gets muted for the permission card underneath.
    // The list is the inbox's, so the row and the push cannot disagree about
    // which notifications are an ask.
    const waiting = record.waiting;
    const asks = waiting && SESSION_ASK_WAIT_KINDS.includes(waiting.kind);
    const works = views.find((view) => view.sessionId === record.sessionId)?.plan;
    if (event === 'prune' || !waiting || !asks || presence !== 'live') {
      // The wait is over — however it ended — so a row that asked about it
      // is resolved rather than left an urgent card nobody can close (REG-4).
      if (this.waitingAnnounced.has(record.sessionId)) {
        this.resolveSessionAsk(record, event);
        this.waitingAnnounced.delete(record.sessionId);
      }
      // …and a wait that stood past the cap unanswered is said once more.
      if (event === 'wait-unanswered' && presence === 'live' && record.lastWait?.outcome === 'unanswered' && !history) {
        this.announceSessionAsk(record, works, 'unanswered');
      }
    } else if (this.waitingAnnounced.get(record.sessionId) !== waiting.since) {
      this.waitingAnnounced.set(record.sessionId, waiting.since);
      const card = record.kind === 'autopilot' && works
        ? this.approvals.pending().find((approval) => approval.slug === works.slug && approval.phase === works.phase)
        : undefined;
      if (history) {
        // Remembered as said (a later repeat of the same episode stays quiet),
        // and never pushed: the ask is hours old and the page shows it.
        log.info('sessions.ask-suppressed', {
          sessionId: record.sessionId, ...(works ? { slug: works.slug, phase: works.phase } : {}),
          reason: 'history', lateMs: record.lastEvent?.lateMs ?? null,
        });
      } else if (card && works) {
        log.info('sessions.ask-suppressed', {
          sessionId: record.sessionId, slug: works.slug, phase: works.phase, approvalId: card.id,
          reason: 'approval-card-pending',
        });
      } else {
        this.announceSessionAsk(record, works, 'asking');
      }
    }

    if (event === 'prune' || presence !== 'ended') return;
    // An end the inbox held past the horizon is still an end — its lock is
    // debris by the registry's word, and the next sweep acts on it — but it is
    // not a reason to decide anything NOW (REG-2 ii).
    if (history) return;
    this.scheduler.poll();
    const plan = correlate(record, this.locksForCorrelation(), Date.now(), this.runsForCorrelation());
    const slugs = plan ? [plan.slug] : this.convergeSlugs();
    for (const slug of slugs) {
      this.runners.get(slug)?.noteDocsChanged();
      if (this.convergeAutomatic()) this.converger.request(slug, 'change');
    }
  }

  /**
   * The one `session-ask` announcement: a session stopped at a prompt
   * (`asking`), or one whose wait just passed the cap with nobody answering
   * (`unanswered`). The body is the QUESTION — the notification's own words —
   * and the plan and phase when the session is correlated, never the cwd: the
   * audit's one real question reached the phone as a directory (TRS-6).
   */
  private announceSessionAsk(
    record: SessionRecord, plan: { slug: string; phase: number } | undefined, moment: 'asking' | 'unanswered',
  ): void {
    const wait = moment === 'asking' ? record.waiting : record.lastWait;
    if (!wait) return;
    const what = wait.kind === 'permission' ? 'permission' : 'answer';
    const where = plan ? ` (${plan.slug} phase ${plan.phase})` : '';
    const question = wait.note || (record.kind === 'autopilot'
      ? 'A lane of the autopilot is stopped until it is answered.'
      : 'A Claude session is stopped until it is answered.');
    this.announce('session-ask', {
      title: moment === 'asking'
        ? `A Claude session is waiting on your ${what}`
        : `A Claude session waited an hour on your ${what}, unanswered`,
      body: `${question}${where}`,
      // One tag per session: a session cannot reach its second prompt until
      // the first was answered, so a new episode REPLACES the stale card
      // rather than standing beside it. `replace` is what makes that true
      // inside the 5-second dedupe — answer one prompt, hit the next, and
      // the second push used to be dropped as a re-render.
      tag: tagFor('session-ask', record.sessionId),
    }, {
      sessionId: record.sessionId,
      ...(plan ? { slug: plan.slug, phase: plan.phase } : {}),
    }, { replace: true });
  }

  /** Mark the `session-ask` rows about this session's wait resolved — the wait is over (REG-4). */
  private resolveSessionAsk(record: SessionRecord, event: RegistryChange): void {
    const outcome = record.lastWait?.outcome;
    const reason = event === 'prune' ? 'the session record was pruned'
      : outcome === 'ended' || record.endedAt ? 'the session ended'
        : outcome === 'unanswered' ? 'nobody answered within the hour — the wait was closed unanswered'
          : 'the session moved on — its wait was answered';
    const changed = this.notifications.resolveWhere({ category: 'session-ask', sessionId: record.sessionId }, reason);
    for (const row of changed) this.emit('notification', row);
  }

  /** The session-presence hook, as `~/.claude/settings.json` has it. */
  hooksStatus(): HooksStatus {
    return hooksStatus({ skillDir: SKILL_DIR });
  }

  /**
   * The presence hook in every config dir this console's pooled accounts run
   * sessions from (control-tower phase 108, #194) — the login's for the
   * machine login and a token, each profile's own. What `doctor`'s presence
   * row reads; a profile is provisioned at its next spawn (`envFor`).
   */
  presenceByAccount(): PresenceDir[] {
    return presenceDirs(
      this.accounts.accountIds().map((id) => ({ id, dir: this.accounts.configDirFor(id) })),
      (settingsPath) => hooksStatus({ skillDir: SKILL_DIR, settingsPath }),
    );
  }

  /** Write the four entries (behind `--allow-writes` — the file is outside the console's own state). */
  installSessionHook(): HooksWrite {
    if (!this.flags.allowWrites) throw new Error('Installing the session hook edits ~/.claude/settings.json — restart with --allow-writes.');
    const out = installHooks({ skillDir: SKILL_DIR });
    log.info('hooks.installed', { path: out.path, changed: out.changed });
    return out;
  }

  uninstallSessionHook(): HooksWrite {
    if (!this.flags.allowWrites) throw new Error('Removing the session hook edits ~/.claude/settings.json — restart with --allow-writes.');
    const out = uninstallHooks({ skillDir: SKILL_DIR });
    log.info('hooks.uninstalled', { path: out.path, changed: out.changed });
    return out;
  }

  /**
   * Watch `runs/<instance>/` for the two things a session writes there itself.
   *
   *   - `<slug>/outcomes/phase-NN.json` — what `phase-outcome.sh` writes when
   *     no runner injected `PE_OUTCOME_FILE`, i.e. a session nobody here
   *     spawned. Read once, acted on, consumed;
   *   - `<slug>/rulings.ndjson` — the append-only ledger of what sessions
   *     DECIDED. Never consumed; re-read whole and deduped by ruling id, which
   *     is what makes "ingests once" a property rather than a claim about how
   *     often a watcher fires.
   *
   * One recursive watcher for both, because it is the same directory and a
   * second one would double the fd cost to answer the same events. What landed
   * while the console was away is read first; the watcher (debounced per file)
   * takes it from there.
   */
  protected armSessionInbox(root: string): void {
    this.disarmSessionInbox();
    const dir = join(STATE_DIR, 'runs', instanceId(root));
    try { mkdirSync(dir, { recursive: true }); } catch { return; }
    this.sweepSessionInbox(root);
    // …and again on a clock. The watcher below is the fast path, not the only
    // one: see `OUTCOME_INBOX_SWEEP_MS`.
    this.outcomeSweep = setInterval(() => {
      try { this.sweepSessionInbox(root); }
      catch (error) { log.warn('outcome-inbox.sweep-failed', { error }); }
    }, OUTCOME_INBOX_SWEEP_MS);
    this.outcomeSweep.unref?.();
    try {
      this.outcomeWatcher = watch(dir, { recursive: true }, (_event, filename) => {
        const name = String(filename ?? '');
        const ruling = /^([^/]+)\/rulings\.ndjson$/.exec(name);
        if (ruling) {
          const key = name;
          const prev = this.outcomeTimers.get(key);
          if (prev) clearTimeout(prev);
          const timer = setTimeout(() => {
            this.outcomeTimers.delete(key);
            try { this.ingestRulingsFor(ruling[1]); }
            catch (error) { log.warn('rulings.ingest-failed', { slug: ruling[1], error }); }
          }, OUTCOME_INBOX_DEBOUNCE_MS);
          timer.unref?.();
          this.outcomeTimers.set(key, timer);
          return;
        }
        // `inboxOutcomePhase` owns the name shape — both the legacy
        // `phase-NN.json` and the stamped `phase-NN-<written_at>.json` S9-a
        // introduced. A regex spelled here instead is how the WATCHER went on
        // ignoring every stamped declaration while the sweep read them fine:
        // the inbox still worked, but only once a minute, and the "resume this
        // session now" path it exists for is not a once-a-minute path. The
        // `[^/]+` also keeps `outcomes/ignored/…` out, as the old literal did.
        const m = /^([^/]+)\/outcomes\/([^/]+)$/.exec(name);
        if (!m || inboxOutcomePhase(m[2]) === null) return;
        const key = `${m[1]}/${m[2]}`;
        const prev = this.outcomeTimers.get(key);
        if (prev) clearTimeout(prev);
        const timer = setTimeout(() => {
          this.outcomeTimers.delete(key);
          this.dropClock('outcome-inbox', key);
          this.ingestOutcomeFile(m[1], join(dir, name));
        }, OUTCOME_INBOX_DEBOUNCE_MS);
        timer.unref?.();
        this.outcomeTimers.set(key, timer);
        this.noteClock('outcome-inbox', key, Date.now() + OUTCOME_INBOX_DEBOUNCE_MS, { slug: m[1] });
      });
      // Never what keeps the process alive (shutdown, or a harness that never closes).
      this.outcomeWatcher.unref?.();
      this.outcomeWatcher.on('error', (error) => {
        log.warn('outcome-inbox.watcher-error', { dir, error: (error as Error).message });
        try { this.outcomeWatcher?.close(); } catch { /* gone */ }
        this.outcomeWatcher = null;
      });
    } catch (error) {
      log.warn('outcome-inbox.watch-failed', { dir, error: (error as Error).message });
      this.outcomeWatcher = null;
    }
  }

  /**
   * Read whatever is sitting in the inbox right now, for every plan.
   *
   * The boot pass and the periodic floor are the same act — a declaration that
   * arrived while the console was away and one whose watcher event was dropped
   * are indistinguishable on disk, and both are read here. `ingestOutcomeFile`
   * consumes what it reads, so a file the watcher ALSO delivers is a no-op the
   * second time (`existsSync` guards it).
   */
  private sweepSessionInbox(root: string): void {
    for (const slug of this.store?.list().map((r) => r.slug) ?? []) {
      try { this.ingestRulingsFor(slug); } catch (error) { log.warn('rulings.boot-ingest', { slug, error }); }
      let names: string[] = [];
      try { names = readdirSync(outcomeInboxDir(root, slug)); } catch { continue; }
      // OLDEST FIRST. Since S9-a a phase can have several declarations waiting
      // — `partial` then `blocked`, say — and applying them in `readdir` order
      // is applying them in whatever order the filesystem hands back, which for
      // two declarations of one phase means the newest can be overwritten by
      // the older one. The stamp in the name is fixed-width and colon-free
      // precisely so this sort is chronological without opening anything; a
      // legacy `phase-NN.json` sorts before every stamped sibling, which is the
      // right place for it (it was written by an older script, so it IS older).
      for (const name of [...names].sort()) {
        this.ingestOutcomeFile(slug, join(outcomeInboxDir(root, slug), name));
      }
    }
  }

  protected disarmSessionInbox(): void {
    for (const timer of this.outcomeTimers.values()) clearTimeout(timer);
    for (const key of this.outcomeTimers.keys()) this.dropClock('outcome-inbox', key);
    this.outcomeTimers.clear();
    if (this.outcomeSweep) clearInterval(this.outcomeSweep);
    this.outcomeSweep = null;
    try { this.outcomeWatcher?.close(); } catch { /* gone */ }
    this.outcomeWatcher = null;
  }

  /**
   * Read, decide, consume LAST (WAI-7). One inbox file: read and validated,
   * age-checked, presence-checked, then ACTED ON — and only once the act has
   * settled is the file consumed. A file the reader rejects, one past the 24 h
   * rule, or one whose act threw is set aside under `outcomes/ignored/` and
   * journalled `phase.outcome-ignored {reason, writtenAt, ageMs}` on the plan's
   * latest run, never deleted: it used to be destroyed before any of that was
   * decided, so the one channel a hand session has into the autopilot lost its
   * message exactly when the console had been away long enough to need it. One
   * that would resume a session still running is KEPT in place (REG-1).
   */
  private ingestOutcomeFile(slug: string, file: string): void {
    const phase = inboxOutcomePhase(file);
    if (phase == null || !existsSync(file)) return;
    // The act is asynchronous and the sweep is not: a file whose act is still
    // in flight is neither re-read nor re-applied by the next sweep.
    if (this.outcomesInFlight.has(file)) return;
    const declared = readOutcome(file, { slug, phase });
    if (!declared) {
      log.warn('outcome-inbox.rejected', { slug, phase, file });
      this.ignoreOutcomeFile(slug, phase, file, 'invalid', { writtenAt: peekWrittenAt(file) });
      return;
    }
    const ageMs = Date.now() - Date.parse(declared.written_at);
    if (ageMs > OUTCOME_INBOX_MAX_AGE_MS) {
      log.info('outcome-inbox.stale', { slug, phase, writtenAt: declared.written_at });
      this.ignoreOutcomeFile(slug, phase, file, 'stale', { writtenAt: declared.written_at, ageMs, status: declared.status });
      return;
    }
    // Presence BEFORE the file is spent (REG-1). `waiting-external` arms a
    // `--resume` of the declaring session and `partial` boards one; if that
    // session is still running, either would put a second `claude` on its
    // transcript. The file stays where it is — the next sweep reads it again —
    // so the declaration is acted on the moment its author ends, and not before.
    if (declared.status === 'waiting-external' || declared.status === 'partial') {
      const hold = this.declarerHold(slug, phase, declared.session_id);
      if (hold) { this.refuseHeldResume(slug, phase, declared, hold); return; }
    }
    this.resumeRefusals.delete(`${slug}:${phase}`);
    this.outcomesInFlight.add(file);
    void this.applyUnsupervisedOutcome(slug, phase, declared)
      .then(
        () => consumeOutcome(file),
        (error) => {
          const message = (error as Error)?.message ?? String(error);
          log.warn('outcome-inbox.apply-failed', { slug, phase, error: message });
          // Set aside, not left: a file whose act throws would otherwise be
          // re-applied every sweep, and an act that journalled `phase.outcome`
          // before throwing would journal it again each time.
          this.ignoreOutcomeFile(slug, phase, file, 'failed', {
            writtenAt: declared.written_at, ageMs, status: declared.status, error: message,
          });
        },
      )
      .finally(() => this.outcomesInFlight.delete(file));
  }

  /** Inbox files whose act has not settled — neither re-read nor re-applied meanwhile. */
  private readonly outcomesInFlight = new Set<string>();

  /**
   * Set an inbox declaration aside and journal it on the plan's latest run —
   * the live runner's journal when the plan has one, else the stored run's.
   * With no run at all the log line is the record (and the file is still kept).
   */
  private ignoreOutcomeFile(
    slug: string, phase: number, file: string, reason: OutcomeIgnoreReason,
    detail: { writtenAt: string | null; ageMs?: number; status?: string; error?: string },
  ): void {
    const kept = ignoreOutcome(file, reason);
    if (!kept) consumeOutcome(file);
    const ageMs = detail.ageMs ?? (detail.writtenAt ? Date.now() - Date.parse(detail.writtenAt) : null);
    const data = {
      reason, writtenAt: detail.writtenAt, ageMs: Number.isFinite(ageMs) ? ageMs : null,
      file: basename(file), kept: kept ? relative(dirname(file), kept) : null, by: 'inbox',
      ...(detail.status ? { status: detail.status } : {}),
      ...(detail.error ? { error: detail.error } : {}),
    };
    if (!this.root?.ok) return;
    const live = this.liveRunner(slug);
    if (live) {
      try { live.noteOutcomeIgnored(phase, data); } catch (error) { log.warn('outcome-inbox.apply-failed', { slug, phase, error: String(error) }); }
      return;
    }
    const state = latestRun(this.root.path, slug, this.liveRunIds());
    if (state) Journal.for(this.root.path, slug, state.id).append('phase.outcome-ignored', data, phase);
  }

  /** The declaration each refused resume was about, so a kept inbox file is refused ONCE, not every sweep. */
  private readonly resumeRefusals = new Map<string, string>();

  /**
   * A declaration that would resume a session still running: journalled on the
   * plan's run and announced, once per declaration, naming the session, its pid
   * and the lock that held it — and nothing armed (REG-1). A recorded refusal,
   * not a halt: nothing is wrong with the phase, somebody is working it.
   */
  private refuseHeldResume(
    slug: string, phase: number, declared: PhaseOutcome,
    hold: { why: 'session-live' | 'session-lease'; sessionId: string; pid?: number; lock?: string },
  ): void {
    const key = `${slug}:${phase}`;
    const stamp = `${hold.sessionId}@${declared.written_at}`;
    if (this.resumeRefusals.get(key) === stamp) return;
    this.resumeRefusals.set(key, stamp);
    const refusal = {
      sessionId: hold.sessionId, why: hold.why, status: declared.status, by: 'unsupervised',
      writtenAt: declared.written_at, ...(hold.pid ? { pid: hold.pid } : {}), ...(hold.lock ? { lock: hold.lock } : {}),
    };
    log.warn('outcome-inbox.resume-refused', { slug, phase, ...refusal });
    const live = this.liveRunner(slug);
    if (live) {
      // A refusal that cannot be journalled is still a refusal: the file is kept either way.
      try { live.noteResumeRefused(phase, refusal); } catch (error) { log.warn('outcome-inbox.resume-refused', { slug, phase, error: String(error) }); }
    } else if (this.root?.ok) {
      const state = latestRun(this.root.path, slug, this.liveRunIds());
      if (state) Journal.for(this.root.path, slug, state.id).append('phase.resume-refused', refusal, phase);
    }
    const holder = `session ${hold.sessionId.slice(0, 8)}${hold.pid ? ` (pid ${hold.pid})` : ''}`;
    this.announce('parked', {
      title: 'A resume is held — its session is still running',
      body: `${slug} phase ${phase} — ${holder} declared ${declared.status} and is still `
        + `${hold.why === 'session-live' ? 'running' : `holding the phase lock (${hold.lock})`}. `
        + 'The console will not resume a session on top of itself; it acts on the declaration once that session ends.',
      tag: tagFor('parked', slug, String(phase), 'resume-refused'),
    }, { slug, phase });
  }

  /**
   * A declared outcome from a session nobody here spawned — the same
   * vocabulary as a lane's own, read the same way (`Runner.declareOutcome`).
   * With the plan's runner live, it is the runner's act. Otherwise the record
   * is written into the plan's latest run — created, paused and scoped to the
   * phase, when there is none — and the resume is armed: `waiting-external`
   * parks the phase `waiting` and the service's own clock resumes the session
   * at the window (restart-safe, like a usage-window sleep); `partial` boards
   * it now through normal admission. `blocked` / `needs-human` / `complete`
   * are kept as the classifier's `declared` evidence and announced once.
   */
  private async applyUnsupervisedOutcome(slug: string, phase: number, raw: PhaseOutcome): Promise<void> {
    if (!this.root?.ok) return;
    const record = this.store?.get(slug);
    if (!record?.plan?.phased) return;
    // The screen every declaration gets before it is acted on (#42) — a file an
    // older script wrote is refused here exactly as `phase-outcome.sh` now
    // refuses it at the flag. A live runner screens (and journals) its own copy.
    const screened = screenDeclaration(raw, slug, phase);
    const declared = screened.outcome;
    const journalScreen = (journal: Journal): void => {
      for (const ref of screened.ownLock) {
        journal.append('phase.watch-refused', { ref, why: 'own-lock', reason: OWN_LOCK_WATCH_REFUSAL, by: 'unsupervised' }, phase);
      }
    };
    this.declaredOutcomes.set(`${slug}:${phase}`, {
      status: declared.status,
      ...(declared.reason ? { reason: declared.reason } : {}),
      ...(declared.watch.length ? { watch: declared.watch } : {}),
      ...(declared.needs ? { needs: declared.needs } : {}),
      writtenAt: declared.written_at,
      ...(declared.session_id ? { sessionId: declared.session_id } : {}),
    });
    log.info('outcome-inbox.declared', { slug, phase, status: declared.status, sessionId: declared.session_id ?? null });
    let verdict: 'parked' | 'boarding' | 'noted' | 'ignored' | null = 'noted';
    const live = this.liveRunner(slug);
    if (live) {
      verdict = await live.declareOutcome(phase, raw, 'unsupervised');
    } else if (this.flags.allowRun && (declared.status === 'waiting-external' || declared.status === 'partial')) {
      // The plan's allowance, read before anything is written — both twins
      // answer a wait with the same `evaluateWait` over the same budget.
      const budget = declared.status === 'waiting-external' ? await this.waitBudget(slug, phase) : undefined;
      const board = await this.board(slug).catch(() => null);
      if (board && !board.error && board.states[phase] === 'done') { verdict = 'ignored'; } else {
        let state = latestRun(this.root.path, slug, this.liveRunIds());
        const created = !state;
        if (!state) {
          state = newRun({ slug, root: this.root.path, onlyPhases: [phase], autoRecover: this.prefs.autoRecoverByDefault !== false });
          setRunState(state, 'paused');
          state.stoppedBy = 'system';
          state.activePhase = null;
        }
        const journal = Journal.for(this.root.path, slug, state.id);
        const rec = phaseRecord(state, phase);
        if (created) {
          journal.append('run.start', {
            ...doorActor('outcome-inbox', {
              by: 'unsupervised', via: 'event', origin: 'outcome-inbox',
              trigger: `${declared.status}:${declared.session_id ?? 'no-session'}`, guard: 'plan.phased,!done',
            }),
            minted: true,
            reason: `phase ${phase} declared ${declared.status} from a session the console did not start`,
            onlyPhases: [phase],
          });
        }
        journalScreen(journal);
        journal.append('phase.outcome', {
          status: declared.status, reason: declared.reason ?? null, resumeAfter: declared.resume_after ?? null,
          watch: declared.watch, ...screenedFields(screened), sessionId: declared.session_id ?? null, by: 'unsupervised',
        }, phase);
        if (declared.session_id) { rec.sessionId = declared.session_id; delete rec.sessionAccountId; }
        const now = Date.now();
        const at = new Date(now).toISOString();
        // The declarations ledger (WAI-8, SLF-4): every word counted; a repeat
        // inside the cooldown collapses into the act that already stands; a word
        // past its cap is recorded and not acted on — the rule the wait budget
        // states for one word, for all six. The unsupervised paths are the ones
        // a hand session (or a loop in one) can drive for free, so the cooldown
        // is theirs.
        const charge = chargeDeclaration(rec, declared.status, { now, cooldownMs: declarationCooldownFor(declared.status) });
        if (charge.verdict !== 'act') {
          this.refuseDeclaration(slug, phase, state, journal, charge, declared);
          verdict = 'ignored';
        } else {
        // A NEW declaration supersedes the last one — the `new-outcome` licence,
        // journalled through the run's own journal (WAI-9).
        consumeDeclaration(rec, 'new-outcome', (event, data, at2) => journal.append(event, { ...data, next: declared.status, by: 'unsupervised' }, at2));
        // The same answer the SUPERVISED park gets (`Runner.parkWaiting`): one
        // expression, the plan's budget, the per-phase cap. This path once had
        // neither — a `--until` a week out parked the plan past `setTimeout`'s
        // reach with nothing to wake it — and then had a clamp that cut a
        // declared window to what was left in silence. A window past the budget
        // is now refused with the arithmetic, never shortened (WAI-1).
        const unpollable = declared.status === 'waiting-external' ? unpollableRefs(declared.watch) : [];
        const wait = declared.status === 'waiting-external' ? evaluateWait({
          now,
          requestedUntil: declared.resume_after ? Date.parse(declared.resume_after) : undefined,
          parkedMs: parkedMsOf(rec, now),
          waits: rec.waits ?? 0,
          budget: budget!,
          ledger: 'session',
          defaultWindowMs: UNSUPERVISED_WAIT_DEFAULT_MS,
          dates: pollableRefs(declared.watch).flatMap((target) => (target.kind === 'date' ? [[target.ref, target.at] as const] : [])),
          // Rule 7 (control-tower phase 45, #59): past the budget, a window
          // naming a ref the clock can poll is granted what is left.
          pollable: pollableRefs(declared.watch).length > 0,
        }) : null;
        for (const { ref, reason } of unpollable) journal.append('phase.watch-unpollable', { ref, reason, by: 'unsupervised' }, phase);
        if (wait && wait.verdict !== 'park') {
          // Not failed, and not a halt: unsupervised, no run is driving this,
          // and a stop card on a phase nobody is running would sit on work the
          // operator may be doing by hand. And since control-tower phase 45
          // (#59) not DROPPED either — it used to record the refusal and leave
          // the refs unwatched, and a pull request it named merged twelve
          // minutes later with nothing looking. The phase waits on its refs
          // with no clock and a `budgets` errand, the supervised park's exact
          // shape (`spentBudgetPark`), and a landing resumes its session.
          const requested = declared.resume_after && Number.isFinite(Date.parse(declared.resume_after))
            ? new Date(Date.parse(declared.resume_after)).toISOString()
            : undefined;
          clearWatchBookkeeping(rec);
          if (unpollable.length) rec.watchUnpollable = unpollable; else delete rec.watchUnpollable;
          rec.resumeSessionId = declared.session_id ?? rec.sessionId;
          const spent = spentBudgetPark(state, phase, {
            ledger: wait.ledger, refusal: wait.reason, budget: budget!, at,
            declared: {
              status: 'waiting-external',
              ...(declared.reason ? { reason: declared.reason } : {}),
              ...(declared.watch.length ? { watch: declared.watch } : {}),
              by: 'unsupervised',
              ...(requested ? { requested } : {}),
              budget: { ms: budget!.budgetMs, source: budget!.source },
              at,
            },
          });
          journal.append('phase.wait-budget-spent', {
            ...spent.data, reason: declared.reason ?? null, requested: new Date(wait.requested).toISOString(),
            budgetRemainingMs: wait.budgetRemainingMs,
          }, phase);
          if (spent.errand) journal.append('phase.errand', { ...spent.errand }, phase);
          saveRun(state);
          this.emit('run:state', { state });
          // A spent budget announces as one (control-tower phase 14, #40).
          this.announceBudget({ slug, runId: state.id, phase, state: 'spent', fact: spent.fact });
          verdict = 'parked';
        } else if (wait?.verdict === 'park') {
          const until = new Date(wait.until).toISOString();
          const requested = wait.requestedSource === 'declared' || wait.extendedBy
            ? new Date(wait.requested).toISOString()
            : undefined;
          rec.status = 'waiting';
          rec.parkedUntil = until;
          rec.parkReason = declared.reason;
          rec.watch = declared.watch.length ? declared.watch : undefined;
          if (unpollable.length) rec.watchUnpollable = unpollable; else delete rec.watchUnpollable;
          rec.declared = {
            status: 'waiting-external',
            ...(declared.reason ? { reason: declared.reason } : {}),
            ...(declared.watch.length ? { watch: declared.watch } : {}),
            by: 'unsupervised',
            ...(requested ? { requested } : {}),
            at,
          };
          clearWatchBookkeeping(rec);
          rec.waits = (rec.waits ?? 0) + 1;
          rec.parkedFrom = at;
          openWaitEntry(rec, { parkedFrom: at, parkedUntil: until, ...(requested ? { requested } : {}), by: 'unsupervised' }, now);
          rec.parkedMs = parkedMsOf(rec, now);
          // Presence was read before this file was consumed (`ingestOutcomeFile`):
          // a declaring session still running never reaches this line.
          rec.resumeSessionId = declared.session_id ?? rec.sessionId;
          delete rec.boardingHint;
          state.waitUntil = until;
          if (state.status !== 'finished') {
            setRunState(state, 'paused', { kind: 'external', until });
            state.stoppedBy = 'system';
          } else {
            state.waitReason = 'external';
          }
          state.finishedReason = `phase ${phase} declared itself waiting on external work`
            + `${declared.reason ? ` (${declared.reason})` : ''}; its own session resumes at ${until}.`;
          journal.append('phase.waiting', {
            until, reason: declared.reason ?? null, watch: declared.watch, waits: rec.waits,
            requested: new Date(wait.requested).toISOString(), requestedSource: wait.requestedSource,
            granted: wait.granted, capped: wait.capped,
            budgetMs: wait.budgetMs, budgetSource: wait.budgetSource, budgetRemainingMs: wait.budgetRemainingMs,
            parkedMs: wait.parkedMs, by: 'unsupervised',
            ...(wait.extendedBy ? { extendedBy: wait.extendedBy } : {}),
            ...(unpollable.length ? { unpollable: unpollable.map((entry) => entry.ref) } : {}),
          }, phase);
          journal.append('run.waiting-external', { phases: [phase], waitUntil: until, by: 'unsupervised' }, phase);
          saveRun(state);
          this.emit('run:state', { state });
          this.armLimitResume(slug, state);
          verdict = 'parked';
        } else {
          // A re-board of the SAME work, unattended: the attempt-scoped state
          // goes, the phase's bounds stay — `stallRemedy` above all, which
          // `resetForRetry` used to wipe here on every `partial` (SLF-4), so
          // the phase that went silent bought itself a fresh watchdog each time.
          prepareReboard(rec);
          const brief = declared.session_id ? 'continue' : 'resume';
          rec.boardingHint = {
            situation: 'work-in-progress', rung: 'resume-own-session', brief,
            ...(declared.session_id ? { sessionId: declared.session_id } : {}),
            at: new Date(now).toISOString(), by: 'unsupervised',
          };
          journal.append('phase.reboard-requested', { situation: 'work-in-progress', rung: 'resume-own-session', brief, by: 'unsupervised' }, phase);
          saveRun(state);
          this.emit('run:state', { state });
          // The DECLARATION is recorded either way — `saveRun` above already
          // wrote the boarding hint — and only the BOARDING waits for a thaw.
          // That split is the whole discipline: a frozen console still hears
          // what a session says about itself, and still starts nothing.
          const frozen = this.fleetHoldFor(slug);
          // One of the six automatic resumes, and one of the four that had no
          // counter (LFC-7): a hand session re-declaring `partial` re-boarded
          // itself for ever. Counted per phase like the rest; at the bound the
          // phase is a person's errand instead of another boarding.
          const count = automaticResumes(state, phase);
          const capped = automaticResumeGate({ prefs: this.prefs, decision: null, restartCaused: false, count }) === 'capped';
          if (frozen) {
            log.info('outcome-inbox.board-frozen', { slug, phase, by: frozen.by });
          } else if (capped && this.convergeAutomatic()) {
            const errand = resumeErrand(phase, new Date(now).toISOString(), 'capped', declared.session_id);
            ((state.recoveries ??= {})[String(phase)] ??= { attempts: 0, lastAt: errand.at }).errand = errand;
            journal.append('phase.errand', { ...errand, reason: `resumed ${count} times automatically`, by: 'unsupervised' }, phase);
            saveRun(state);
            this.announceErrand({ slug, runId: state.id, phase, errand });
          } else if (this.convergeAutomatic()) {
            const slot = ((state.recoveries ??= {})[String(phase)] ??= { attempts: 0, lastAt: new Date(now).toISOString() });
            slot.bootResumes = count + 1;
            slot.lastAt = new Date(now).toISOString();
            journal.append('phase.resume-automatic', {
              trigger: 'inbox', path: 'inbox-partial', count: slot.bootResumes,
              sessionId: declared.session_id ?? null, by: 'unsupervised',
            }, phase);
            saveRun(state);
            try {
              await this.startRun(slug, {
                // A declaration LANDING in the inbox is an observation — the
                // session wrote a file, the console noticed — never a clock.
                actor: doorActor('outcome-inbox', {
                  by: 'unsupervised', via: 'event', origin: 'outcome-inbox',
                  trigger: `${declared.status}:${declared.session_id ?? 'no-session'}`,
                  guard: 'automaticResumeGate,convergeAutomatic,!fleetHold',
                  counter: `MAX_BOOT_RESUMES:${slot.bootResumes}`,
                }),
                resumeRunId: state.id,
                ...(state.onlyPhases?.length ? { onlyPhases: state.onlyPhases } : {}),
                skills: state.skills ?? [],
              });
              verdict = 'boarding';
            } catch (error) {
              log.warn('outcome-inbox.board-failed', { slug, phase, error: (error as Error)?.message ?? String(error) });
            }
          }
        }
        }
      }
    }
    if (!live && (declared.status === 'needs-human' || declared.status === 'blocked')) {
      const state = latestRun(this.root.path, slug, this.liveRunIds());
      if (state) {
        const rec = phaseRecord(state, phase);
        const journal = Journal.for(this.root.path, slug, state.id);
        const charge = chargeDeclaration(rec, declared.status, { cooldownMs: declarationCooldownFor(declared.status) });
        if (charge.verdict !== 'act') {
          this.refuseDeclaration(slug, phase, state, journal, charge, declared);
          verdict = 'ignored';
        } else {
        consumeDeclaration(rec, 'new-outcome', (event, data, at) => journal.append(event, { ...data, next: declared.status, by: 'unsupervised' }, at));
        rec.declared = {
          status: declared.status,
          ...(declared.reason ? { reason: declared.reason } : {}),
          ...(declared.watch.length ? { watch: declared.watch } : {}),
          ...needsOf(declared),
          at: new Date().toISOString(),
        };
        if (declared.watch.length) rec.watch = declared.watch;
        clearWatchBookkeeping(rec);
        // A HUMAN STEP with no runner live (control-tower phase 41): the same
        // ledger, the same one push, the same person-wait as a lane's.
        const step = declared.status === 'needs-human' && declared.step
          ? this.recordHumanStep({
            slug, phase, birth: 'session', step: declared.step, runId: state.id,
            ...(declared.session_id ? { sessionId: declared.session_id } : {}),
          })
          : null;
        if (step) {
          parkOnStep(rec, step, 'unsupervised', rec.declared.at);
          journal.append('phase.human-step', stepJournalFields(step), phase);
        }
        // The same clock the supervised arm arms (`runner-attempt.ts`'s
        // `armDeclaredClock`), with the same ceiling (`DECLARED_CLOCK_MAX_MS`,
        // WAI-8). A hand-driven session that named a moment must get the same
        // answer as a supervised one — a rule that holds on one path only is
        // not a rule, it is a coincidence of which code read the file. No park
        // poke here: there is no live runner to poke, and the convergence
        // request at the bottom of this method is what brings it up.
        const clock = declaredClock(declared.resume_after);
        if (clock) rec.parkedUntil = clock.until;
        try { saveRun(state); } catch { /* the map still has it for this process */ }
        journalScreen(journal);
        journal.append('phase.outcome', {
          status: declared.status, reason: declared.reason ?? null, watch: declared.watch,
          resumeAfter: rec.parkedUntil ?? null,
          ...(clock ? { requested: clock.requested, granted: clock.until, capped: clock.capped } : {}),
          ...screenedFields(screened),
          sessionId: declared.session_id ?? null, by: 'unsupervised',
        }, phase);
        this.emit('run:state', { state });
        }
      }
    }
    this.announceDeclared(slug, phase, declared, verdict);
    if (this.convergeAutomatic()) this.converger.request(slug, 'change', 0);
  }

  /**
   * A declaration recorded and NOT acted on (WAI-8): past its cap, or inside
   * the cooldown of the act that already stands. Journalled on the run,
   * announced once per refusal — the count is in the body — and the record is
   * otherwise untouched: the word that stands is the earlier one.
   */
  private refuseDeclaration(
    slug: string, phase: number, state: RunState, journal: Journal, charge: DeclarationCharge, declared: PhaseOutcome,
  ): void {
    journal.append(DECLARATION_REFUSED_EVENT, {
      status: charge.status, why: charge.verdict === 'cooled' ? 'cooldown' : 'cap', count: charge.count, max: charge.max,
      refused: charge.refused, ...(charge.cooldownMs !== undefined ? { cooldownMs: charge.cooldownMs } : {}),
      reason: declared.reason ?? null, sessionId: declared.session_id ?? null, by: 'unsupervised',
    }, phase);
    saveRun(state);
    log.info('outcome-inbox.declaration-refused', { slug, phase, status: charge.status, why: charge.verdict, count: charge.count });
    const why = charge.verdict === 'cooled'
      ? `declared ${charge.status} again inside ${Math.round((charge.cooldownMs ?? 0) / 60_000)} min of the last one — the act that stands is the earlier one`
      : `declared ${charge.status} for the ${charge.count + charge.refused}${ordinalSuffix(charge.count + charge.refused)} time; ${charge.max} were acted on — the console will not act on it again`;
    this.announce('parked', {
      title: 'A declaration was recorded, not acted on',
      body: `${slug} phase ${phase} — ${why}. Retry the phase to clear the count.`,
      tag: tagFor('parked', slug, String(phase), `declaration-refused-${charge.status}`),
    }, { slug, phase, runId: state.id });
  }

  private announceDeclared(slug: string, phase: number, declared: PhaseOutcome, verdict: string | null): void {
    const who = declared.session_id ? `session ${declared.session_id.slice(0, 8)}` : 'a session the console did not start';
    const where = `${slug} phase ${phase}`;
    if (declared.status === 'waiting-external') {
      this.announce('parked', {
        title: 'A hand-run phase is waiting on external work',
        body: `${where} — ${who} declared it is waiting${declared.reason ? `: ${declared.reason}` : ''}`
          + `${verdict === 'parked' ? '; the console resumes that session at the window' : ''}.`,
        tag: tagFor('parked', slug, String(phase), 'unsupervised'),
      }, { slug, phase });
    } else if (declared.status === 'blocked' || declared.status === 'needs-human') {
      this.announce('needs-you', {
        title: declared.status === 'blocked' ? 'A hand-run phase declared itself blocked' : 'A hand-run phase needs you',
        body: `${where} — ${who} declared ${declared.status}${declared.reason ? `: ${declared.reason}` : ''}.`,
        tag: tagFor('needs-you', slug, String(phase), 'unsupervised'),
      }, { slug, phase });
    }
  }

  /**
   * Release a lock as the owner the lock file names — the runner's own release
   * (`phase-lock.sh release --owner autopilot/<runId>`, `--git` never passed),
   * for claims of runs this console knows are dead. Deliberately not
   * `releaseLock`: that is the operator's write-class verb with its force
   * semantics; this frees what the autopilot itself left behind, under the
   * capability that let it claim in the first place.
   */
  private async releaseDebrisLock(slug: string, phase: number, owner: string): Promise<{ ok: boolean; detail?: string }> {
    if (!this.flags.allowRun) return { ok: false, detail: 'releasing autopilot debris needs --allow-run' };
    try {
      const out = await run(this.engineOpts(), 'phase-lock.sh', [slug, 'release', String(phase), '--owner', owner]);
      const text = (out.stdout + out.stderr).trim();
      const ok = out.code === 0 || /no lock|not held|free/i.test(text);
      log.info('lock.debris-released', { slug, phase, owner, ok, code: out.code });
      return { ok, ...(text ? { detail: text.slice(0, 200) } : {}) };
    } catch (error) {
      return { ok: false, detail: (error as Error)?.message ?? String(error) };
    }
  }

  /**
   * Re-run ONE recorded §Verification command in the operator's own shell —
   * the integrated terminal, in the phase's own directory — and reflect the
   * exit back onto the record (`reflectVerifyCommand`, below, on session
   * exit). Only commands the record itself holds may run: the browser names
   * a command, the server checks it against what the runner recorded, and
   * anything else is refused — a page must never become a shell.
   */
  async verifyInTerminal(slug: string, phase: number, command: string): Promise<
    { ok: true; sessionId: string; token: string; expiresAt: number }
    | { ok: false; status: number; error: string }
  > {
    const root = this.root?.path;
    if (!root) return { ok: false, status: 409, error: 'No source directory is open.' };
    const state = this.runners.get(slug)?.current()
      ?? listRuns(root, slug, this.liveRunIds()).find((run) => run.phases[String(phase)]);
    const record = state?.phases[String(phase)];
    const verification = record?.verification;
    if (!state || !record || !verification) {
      return { ok: false, status: 404, error: `No run of ${slug} has a verification record for phase ${phase}.` };
    }
    const recorded = [
      ...verification.ran.map((entry) => entry.command),
      ...(verification.skipped ?? []).map((entry) => entry.command),
    ];
    if (!recorded.includes(command)) {
      return {
        ok: false, status: 400,
        error: 'That command is not one this phase recorded — only recorded §Verification commands can be re-run here.',
      };
    }
    const cwd = record.verifiedIn && record.verifiedIn !== '.'
      ? join(root, record.verifiedIn)
      : root;
    const shell = process.env.SHELL || '/bin/bash';
    const mint = await this.terminals.mint(undefined, undefined, {
      kind: 'shell',
      file: shell,
      // -i loads the operator's interactive config (aliases, functions — the
      // `rg`-is-a-shell-function case is exactly why the runner could not run
      // this and the person can); -l the login PATH; -c runs and exits with
      // the command's own code, which is what the reflection reads.
      args: ['-ilc', command],
      label: `Verify P${phase} · ${command.slice(0, 48)}`,
      cwd,
      meta: { verify: { slug, phase, runId: state.id, command } },
    });
    if (!mint.ok) return mint;
    log.info('verify.terminal', { slug, phase, command: command.slice(0, 120), sessionId: mint.sessionId });
    return { ok: true, sessionId: mint.sessionId, token: mint.token, expiresAt: mint.expiresAt };
  }

  /**
   * The exit of a verify-command terminal, written back where it belongs.
   *
   * The record's entry gains the code, the tail of the session's own output
   * and `via: 'terminal'`; a skipped-lead entry that ran moves into `ran`
   * (the machine could not check it — the person just did). All green with
   * no live runner → the existing `recheck` fires so the board, the lint and
   * the halt machinery settle it the honest way. A live run is never edited
   * under its driver — the exit is announced and the run re-verifies itself.
   */
  protected reflectVerifyCommand(
    verify: { slug: string; phase: number; runId?: string; command: string },
    code: number,
    output: string,
  ): void {
    const root = this.root?.path;
    if (!root) return;
    const { slug, phase, command } = verify;
    if (this.liveRunner(slug)) {
      this.announce('phase', {
        title: `P${phase} check ran in the terminal · exit ${code}`,
        body: `${slug} is live — the run re-verifies the phase itself. (${command.slice(0, 80)})`,
        tag: tagFor('phase', slug, `verify-terminal-${phase}`),
      }, { slug, phase });
      return;
    }
    const state = (verify.runId ? loadRun(root, slug, verify.runId, this.liveRunIds()) : null)
      ?? latestRun(root, slug, this.liveRunIds());
    const record = state?.phases[String(phase)];
    const verification = record?.verification;
    if (!state || !record || !verification) return;

    const ok = code === 0;
    const tail = output.slice(-8_000);
    const hit = verification.ran.find((entry) => entry.command === command);
    if (hit) {
      hit.ok = ok; hit.code = code; hit.output = tail; hit.via = 'terminal';
    } else {
      verification.ran.push({ command, ok, code, ms: 0, output: tail, via: 'terminal' });
      if (verification.skipped) {
        verification.skipped = verification.skipped.filter((entry) => entry.command !== command);
        if (!verification.skipped.length) delete verification.skipped;
      }
    }
    const red = verification.ran.filter((entry) => !entry.ok).length;
    verification.ok = red === 0;
    verification.reason = ok
      ? `\`${command.slice(0, 80)}\` confirmed in the terminal (exit 0)`
        + (red ? ` — ${red} command(s) still red` : '')
      : `\`${command.slice(0, 80)}\` still fails in the terminal (exit ${code})`;
    try { saveRun(state); } catch { /* reflected next read */ }
    Journal.for(root, slug, state.id).append('phase.verify-command', {
      command: command.slice(0, 240), code, ok, via: 'terminal',
    }, phase);
    this.emit('run:state', { state });

    if (ok && verification.ok && record.status !== 'done') {
      this.announce('phase', {
        title: `P${phase} verification green in the terminal — re-checking`,
        body: 'Every recorded command now reads green; the board, verification and validate.sh run again to settle it.',
        tag: tagFor('phase', slug, `verify-terminal-${phase}`),
      }, { slug, phase, runId: state.id });
      void this.recoverPhase(slug, phase, 'recheck', { by: 'verify-terminal' })
        .catch((error) => {
          this.announce('phase', {
            title: `P${phase} confirmed in the terminal — press Re-check to settle it`,
            body: String((error as Error).message ?? error),
            tag: tagFor('phase', slug, `verify-terminal-${phase}`),
            // `recoverPhase` refuses on its first lines — a claim, a busy lane,
            // a never-run board — so this follows "re-checking" within
            // milliseconds on the same tag, and the push dedupe dropped it.
          }, { slug, phase, runId: state.id }, { replace: true });
        });
    } else {
      this.announce('phase', {
        title: ok
          ? `P${phase} check green in the terminal — ${red} still red`
          : `P${phase} check still failing in the terminal (exit ${code})`,
        body: `${command.slice(0, 100)} — the phase record now carries this result.`,
        tag: tagFor('phase', slug, `verify-terminal-${phase}`),
      }, { slug, phase, runId: state.id });
    }
  }

  /**
   * Everything known about why a phase is not done, in one payload.
   *
   * All of it was already being captured and none of it was reachable: the
   * output of the command that failed, the session's closing words, the lint
   * summary, whether a handoff exists at all. The page rendered a one-line
   * reason and the rest lived in NDJSON, so diagnosing a stuck phase meant
   * leaving the console — which is the one thing the console exists to prevent.
   */
  async phaseDiagnosis(slug: string, phase: number): Promise<PhaseDiagnosis | null> {
    const root = this.root?.path;
    if (!root) return null;
    const run = this.runners.get(slug)?.current()
      ?? listRuns(root, slug, this.liveRunIds()).find((r) => r.phases[String(phase)]);
    if (!run) return null;

    const record = run.phases[String(phase)];
    if (!record) return null;

    const read = await this.board(slug);
    // Displaying "unknown" for a board we could not read is already right, and
    // that is all `states` is used for below. CLASSIFYING against it is not: a
    // situation derived from a fabricated board gets CACHED onto the record a
    // few lines down and read back by the phase table, so an unreadable board
    // would leave a durable claim nobody observed. No board, no classification.
    const states = read.error ? {} : read.states;
    const [dirty, lock, classified] = await Promise.all([
      gitPorcelain(run.root),
      this.phaseLock(slug, phase),
      read.error ? null : this.classifyPhase(slug, phase, run, states).catch(() => null),
    ]);
    // The classification is cached on the record for the phase table; the
    // read path writes it only when the run is not being driven (the loop
    // owns the file then) and only when it changed.
    if (classified && !this.liveRunner(slug)) {
      const cached = record.situation;
      if (!cached || cached.key !== classified.situation.key) {
        this.writeStoredRun(run, (stored) => {
          const r = stored.phases[String(phase)];
          if (r) r.situation = { key: classified.situation.key, at: classified.evidence.at, why: classified.situation.why };
        });
      }
    }

    // The plan record, resolved once and allowed to be absent: `run` came from
    // `listRuns`, which reads the run files, so a plan whose markdown was
    // deleted or renamed still has runs on disk and no store record. Same
    // predicate as `evidenceDeps` below.
    const planRecord = this.store?.get(slug);
    const qaRow = planRecord ? qaFor(planRecord, phase) : undefined;

    // The three witnesses, in the same shape `detail()` builds them from —
    // this panel and the phase row must not disagree about whether anything is
    // running the phase. `lock` here is the STORE's parsed lock, not the
    // `phaseLock` string above, which is `phase-lock.sh status` output for a
    // human to read and carries no session id.
    const parsedLock = planRecord ? lockFor(planRecord, phase) : undefined;
    const session = record.sessionId ?? record.resumeSessionId;
    const childPid = childrenOf(run).find((child) => child.phase === phase)?.pid;
    const live = phaseLive({
      run: {
        inFlight: PHASE_IN_FLIGHT.includes(record.status),
        ...(session ? { session } : {}),
        ...(childPid ? { pid: childPid } : {}),
      },
      lock: parsedLock
        ? {
          expired: parsedLock.expired,
          presence: this.lockPresenceFor(parsedLock),
          ...(parsedLock.session ? { session: parsedLock.session } : {}),
          ...(parsedLock.session ? { kind: this.sessions.get(parsedLock.session)?.kind } : {}),
        }
        : null,
      registry: session
        ? { session, presence: this.sessions.presence(session), kind: this.sessions.get(session)?.kind }
        : null,
      ptySessions: ptyClaudeSessions(this.terminals.state().sessions),
    });

    // One computation for both `resumable` and the actions it gates — the two
    // used to carry the same expression twice, and both omitted the policy.
    const offer = resumeOffer(record, run.accountId ?? 'default');

    return {
      runId: run.id,
      phase,
      status: record.status,
      // Which of the three checks is the one standing in the way. Named rather
      // than left for the reader to infer from four unrelated fields.
      blockedOn: states[phase] !== 'done' ? 'board'
        : record.verification && !record.verification.ok ? 'verification'
          : record.lint && !record.lint.ok ? 'lint'
            : null,
      boardState: states[phase] ?? 'unknown',
      said: record.said ?? null,
      verification: record.verification ?? null,
      // Where they ran, so "it passes on my machine" can be answered without
      // guessing which directory the console was standing in.
      verifiedIn: record.verifiedIn ?? null,
      lint: record.lint ?? null,
      closeout: record.closeout ?? null,
      sessionId: offer.sessionId ?? null,
      resumable: offer.resumable,
      note: record.note ?? null,
      workingTree: dirty ? dirty.split('\n').slice(0, 40) : [],
      lock,
      actions: recoveryActions(record.status, offer.resumable, classified?.situation ?? null),
      // A usage wall's first line is read NOW, as `/api/runs` reads it (control-tower
      // phase 86, #78): the classifier quotes the note written at the park.
      situation: withWallWhy(classified?.situation ?? null, wallReading(record, Date.now())),
      evidence: classified ? summariseEvidence(classified.evidence) : [],
      // Claimed versus evidenced, from the same four facts the board, the
      // handoff, the run record and the QA table already hold. The panel that
      // says "done" is the one place it matters most that "done" is a claim.
      proof: deriveEvidence({
        phase,
        board: states[phase],
        // `null`, never absent — ambiguity 9: this caller looked.
        live: live ?? null,
        handoff: (() => {
          // Same predicate, same reason as the one in `detail` above: the store
          // returning a handoff is what "it exists" means.
          const h = planRecord ? handoffFor(planRecord, phase) : undefined;
          return h
            ? { exists: true, status: h.status, ...(h.outstanding ? { outstanding: h.outstanding } : {}) }
            : { exists: false };
        })(),
        verification: record.verification ?? null,
        qa: { mode: (await this.qaMode(slug)).mode, ...(qaRow?.result ? { result: qaRow.result } : {}) },
        record: {
          status: record.status,
          ...(record.attempts != null ? { attempts: record.attempts } : {}),
          ...(record.verifiedIn ? { verifiedIn: record.verifiedIn } : {}),
          runId: run.id,
        },
      }),
      // The whole plan's ledger, filtered to this phase — not the run's own
      // slice. A phase re-run three runs later is still answering the ruling
      // its first attempt made.
      rulings: this.runRulings(slug).filter((ruling) => ruling.phase === phase),
    };
  }

  /* ---------------------------------------------------------------- *
   * Situations — what the healer and the diagnosis panel read first
   * ---------------------------------------------------------------- */

  /**
   * The dependencies `collectEvidence` reads through, built from what this
   * service already holds: the store's parsed handoff and lock, the engine for
   * the phase's scope, QA mode and result, the plan's health issues. Nothing
   * here invents a fact; a dependency the console lacks stays absent.
   */
  protected evidenceDeps(slug: string): EvidenceDeps {
    const root = this.root?.path ?? '';
    const record = this.store?.get(slug);
    const ours = (owner: string) => /^(autopilot|console)\//.test(owner);
    return {
      root,
      handoff: (_slug, phase) => {
        const h = record ? handoffFor(record, phase) : undefined;
        return h ? { status: h.status, outstanding: h.outstanding } : null;
      },
      lock: async (_slug, phase) => {
        const l = record ? lockFor(record, phase) : undefined;
        if (l) {
          // The scheduler's own reader (#49), for the reason the clock below
          // is the scheduler's: the healer must not call a claim stale that
          // admission, in the same second, is queueing behind.
          const presence = this.lockPresenceFor(l);
          return {
            holder: l.owner, ours: ours(l.owner),
            // THE lock clock (`runner/scheduler.ts`), not the store's frozen
            // bit. Forwarding `l.expired` meant the classifier answered
            // `foreign-live` — a situation with no rung — for the same lock, in
            // the same second, that the scheduler was already treating as
            // lapsed; `foreign-stale` is the one with a takeover rung, and the
            // healer could not reach it until an unrelated file changed.
            expired: lockLapsed(l, Date.now(), presence),
            ...(l.leaseUntil ? { leaseUntil: l.leaseUntil } : {}),
            ...(l.scope?.length ? { scope: l.scope } : {}),
            ...(l.session ? { session: l.session } : {}),
            // Three-valued on purpose: `unknown` leaves the field absent, and
            // the classifier keeps its lease-based reading.
            ...(presence === 'live' ? { live: true } : presence === 'ended' ? { live: false } : {}),
          };
        }
        return null;
      },
      /**
       * The gate, read LIVE from the engine rather than off the phase record.
       *
       * Without this the classifier fell back to `record.gate` — the snapshot
       * the runner stored the last time it looked, which by definition was
       * BEFORE the person approved. So a phase parked on a manual gate kept
       * classifying as `gated-manual` for as long as that record lived, the
       * ladder kept writing "a person must clear the gate" at somebody who
       * already had, and the run never moved. The engine is the authority on
       * gate state everywhere else in this system; it is the authority here too.
       *
       * A read that fails still falls back to the record (`collectEvidence`
       * catches to null): "I could not check" degrades to the last thing we
       * knew, the same shape the MCP probe uses.
       */
      gate: (_slug, phase) => this.gateStatus(slug, phase),
      // The run's CURRENT account, judged now by the quota door (control-tower
      // phase 79, #106) — the drive loop's own evidence, so the healer and the
      // loop classify one usage wall alike: a wall whose account has room is
      // no wall, whatever the checkpoint note remembers.
      account: (run, phase) => {
        const id = run?.accountId ?? 'default';
        const model = run?.phases?.[String(phase)]?.model ?? run?.model;
        const verdict = this.preflightAccount(id === 'default' ? undefined : id, model);
        return { id, ok: verdict.ok, ...(!verdict.ok && verdict.resetsAt ? { resetsAt: verdict.resetsAt } : {}) };
      },
      // The plan's word on the phase's MCP policy — the ONE resolution where
      // the plan outranks the run, because a phase saying it REQUIRES a server
      // is describing the work rather than stating a preference. Nothing
      // populated `PhaseEvidence.mcp.policy` before this, so the classifier's
      // `policy === 'require'` disjunct was unreachable code.
      mcpPolicy: (_slug, phase) => {
        const plan = this.store?.get(slug)?.plan;
        return plan?.phases[phase]?.mcpPolicy ?? plan?.sessionBudget.mcpPolicy;
      },
      // The same answer the runner reads at boarding (phase 11: the plan's
      // `gates` row, else this console's word, else the shipped `delegated`).
      // Without it the classifier called a delegated gate a person's, so the
      // ladder wrote an errand for a phase the runner would happily have booted.
      // Never for a gate the plan marks MANUAL (control-tower phase 107, #174):
      // that one is a person's whatever the row says, exactly as the runner
      // reads it — the kind from the plan text, `gates.env`'s split.
      gateDelegated: (_slug, phase) => {
        const detail = record?.plan?.phases[phase];
        if (gateKindOf(detail?.gateCheck, detail?.gated ?? false, this.gateVocab) === 'human') return false;
        return policyForPlan(
          'gates', mergeDecisions(record?.plan?.decisions ?? [], record?.decisionsTwin ?? []), policyPrefsOf(this.prefs),
        )?.answer === 'delegated';
      },
      // The registry hit for the phase's lock holder: a live or ended session it names.
      registry: (_slug, phase, run) => {
        const l = record ? lockFor(record, phase) : undefined;
        if (l) {
          if (!l.session) return null;
          const presence = this.lockPresenceFor(l);
          if (presence === 'unknown') return null;
          return { live: presence === 'live', sessionId: l.session, owner: l.owner };
        }
        // No lock at all: the registry still has a witness when a live session
        // is in the repository and could be about to work this phase (REG-3).
        // The run's own sessions for the phase are never its peers.
        const own = run?.phases?.[String(phase)];
        const peers = this.peersInRepository(root, { slug, phase }, [own?.sessionId, own?.resumeSessionId]);
        const peer = peers.find((p) => p.presence === 'live');
        if (!peer) return null;
        return {
          live: true, peer: true, sessionId: peer.sessionId, owner: peer.owner,
          ...(peer.pid ? { pid: peer.pid } : {}), cwd: peer.cwd,
        };
      },
      // What a session nobody here spawned declared for the phase (the inbox).
      declared: (_slug, phase) => {
        const d = this.declaredOutcomes.get(`${slug}:${phase}`);
        return d ? { status: d.status, ...(d.reason ? { reason: d.reason } : {}), ...(d.watch ? { watch: d.watch } : {}), ...(d.needs ? { needs: d.needs } : {}), ...(d.writtenAt ? { writtenAt: d.writtenAt } : {}) } : null;
      },
      qa: async (_slug, phase) => {
        const mode = await this.qaMode(slug, phase).catch((): QaMode => ({ mode: 'off' }));
        if (mode.mode === 'off') return { mode: 'off' };
        // Live, not the store's parse: classifying a phase whose verdict is
        // `fail` as `qa-pending` sends the ladder up the wrong rung (dispatch a
        // review, rather than fix what the review already found) and tells the
        // operator the wrong thing on the phase card.
        const verdict = await this.qaVerdict(slug, phase);
        return { mode: mode.mode, ...(verdict !== 'none' ? { result: verdict } : {}) };
      },
      health: async () => {
        if (!record) return [];
        try {
          return healthIssues(await this.context(record)).map((issue) => ({
            kind: issue.kind, severity: issue.severity,
            ...(issue.phase != null ? { phase: issue.phase } : {}),
            ...((issue as { message?: string }).message ? { detail: (issue as { message?: string }).message } : {}),
          }));
        } catch { return []; }
      },
      repos: async (_slug, phase) => {
        // The phase's SCOPE, as directories under the root that exist — the
        // repos whose trees say whether the phase did anything. `all`, or a
        // scope naming nothing that is here, falls back to the root itself.
        try {
          const out = await run(this.engineOpts(), 'phase-graph.sh', [slug, '--repos', String(phase)]);
          const names = out.stdout.trim().split(',').map((n) => n.trim()).filter(Boolean);
          if (!names.length || names.includes('all')) return ['.'];
          const dirs = names.filter((n) => n !== '.' && !n.includes('..') && existsSync(join(root, n)));
          return dirs.length ? dirs : ['.'];
        } catch { return ['.']; }
      },
    };
  }

  /** Evidence + situation for ONE phase of a run, against the board already read. */
  async classifyPhase(
    slug: string, phase: number, run: RunState | null, board: Record<number, string>, cache?: EvidenceCache,
  ): Promise<{ evidence: PhaseEvidence; situation: Situation }> {
    const evidence = await collectEvidence(this.evidenceDeps(slug), slug, phase, run, board, cache);
    const live = run ? this.liveRunner(slug)?.current()?.id === run.id && Boolean(childrenOf(run).find((c) => c.phase === phase)) : false;
    if (live && evidence.record) evidence.record.live = true;
    return { evidence, situation: classifySituation(evidence) };
  }

  /**
   * Is this DONE phase's QA verdict holding its dependents?
   *
   * Cheap and fail-safe: the mode read is cached by revision, and anything it
   * cannot answer is `false` — a phase wrongly kept out of the candidate list
   * costs a slower recovery, one wrongly let in costs a session.
   */
  /**
   * A phase's QA verdict, from the ENGINE rather than the store's parse.
   *
   * The store lags a watcher debounce, and both callers ask precisely because
   * somebody may have just recorded a verdict — the same reason the gate dep is
   * a live `--gate-status` read and not `record.gate`. A read that could not run
   * answers `none`, which is the fail-safe direction for both: it keeps a phase
   * IN the candidate list (a slower recovery) rather than declaring work settled
   * on a read that failed.
   */
  async qaVerdict(slug: string, phase: number): Promise<string> {
    try {
      const out = await run(this.engineOpts(), 'phase-graph.sh', [slug, '--qa-result', String(phase)]);
      return out.stdout.trim().toLowerCase() || 'none';
    } catch { return 'none'; }
  }

  /** The rounds `test-status.md` records for a phase, oldest first — empty on any failure. */
  async qaHistory(slug: string, phase: number): Promise<QaHistoryRow[]> {
    try {
      const out = await run(this.engineOpts(), 'phase-graph.sh', [slug, '--qa-history', String(phase)]);
      return parseQaHistory(out.stdout);
    } catch { return []; }
  }

  /* ------------------------------------------------------------------ *
   * QA recovery — the three verbs behind issue #11
   * ------------------------------------------------------------------ */

  /**
   * Fix & re-QA, or Re-run QA.
   *
   * With a run present this re-arms THAT run on the phase; with none it mints
   * one scoped to the phase (`onlyPhases: [N]`), which is what makes the verb
   * work on a hand-driven plan — the case issue #11 names explicitly and the
   * one the ladder could never reach, because the ladder only ever climbs
   * inside a run somebody had already started.
   *
   * Every setting resolves operator choice → the phase's plan bullet → the
   * run's own value, per field, which is `optionsFor`'s ordering and not a new
   * one; the settings the caller does not name are simply left alone, so a
   * recovery started from a card with nothing filled in runs exactly as the run
   * itself would.
   */
  async qaRecover(
    slug: string, phase: number,
    opts: {
      verb?: QaRecoverVerb;
      strategy?: QaFixStrategy;
      settings?: RunSettingsPatch;
      qaMaxRounds?: number;
      qaRoundBudgetUsd?: number | null;
      by?: string;
      /** Who asked, whole — the route's derived actor, or the healer's door. Falls back to `by`. */
      actor?: Actor;
      /** Wait for the whole loop, for a test or an unattended caller. */
      settled?: boolean;
    } = {},
  ): Promise<RunState | null> {
    const verb: QaRecoverVerb = opts.verb === 'qa-rerun' ? 'qa-rerun' : 'qa-recover';
    if (!this.flags.allowRun) {
      throw new Error('Runs are disabled. Restart the console with --allow-run.');
    }
    const root = this.root?.path;
    if (!root) throw new Error('No repository is open.');
    if (this.liveRunner(slug)) {
      throw new RunBusyError(slug, "a phase's QA");
    }
    this.assertNotClaimed(slug, [phase]);
    const busyOn = this.liveRecoveryFor({ slug, phase });
    if (busyOn) {
      throw new RecoveryBusyError(
        `A recovery session is already working on ${slug} phase ${phase} — open it instead.`, busyOn.id);
    }

    // Both verbs refuse on a phase with no recorded verdict, and the refusal is
    // the point rather than politeness: `qa-record.sh` would happily write a
    // round for a phase nobody has reviewed, and a "re-run" of a review that
    // never happened is a first review wearing the wrong name — which the
    // budget would then count as a failed round.
    const verdict = await this.qaVerdict(slug, phase);
    if (verdict === 'none') {
      // The healer's fresh review is the ONE first review this door takes: a
      // QA-on phase whose row never landed (a `pending` row written into the
      // wrong table, a handoff written by hand) is exactly the `qa-pending`
      // the ladder is climbing, and refusing it re-parks the plan on a review
      // the console can board itself. The chooser numbers it round 1.
      const firstReview = opts.by === 'auto-recovery'
        && (await this.qaMode(slug, phase).catch(() => ({ mode: 'unknown' }))).mode === 'on';
      if (!firstReview) {
        throw new Error(
          `Phase ${phase} of ${slug} has no recorded QA verdict, so there is nothing to re-run or fix. `
          + 'Start a review from the phase page (QA this phase) instead.');
      }
    }
    if (verdict === 'pass' || verdict === 'waived') {
      throw new Error(
        `Phase ${phase} of ${slug} already reads ${verdict} — its dependents are not held. `
        + 'Start a fresh review from the phase page if you want another opinion.');
    }
    // …and the PLAN's regime. The door read the raw verdict alone, so a plan
    // whose gate had since been turned off (`**QA gate:** off` → mode `waived`)
    // but which still carried a stale `fail` row would spawn a real, billable
    // session loop for a phase the engine is holding nothing behind (QA round
    // 1, M1). THIS phase's regime, not the plan's: a phase that exempted itself
    // with `- **QA:** off` is finished work.
    //
    // `qaGateOff`, NOT `!qaGateHolds`. The first shipping of this guard used the
    // display predicate, under which `unknown` — what `readQaMode` resolves to
    // when the engine could not be run — reads exactly like `off`, so a plan
    // whose mode simply could not be determined got a hard refusal carrying a
    // confidently false sentence. `Service.qaMode` caches by revision with no
    // TTL, so that wrong answer then stuck. A refusal must rest on a claim, not
    // on the absence of one (QA round 2, M1).
    await this.assertGateHolds(slug, phase);

    // The run this acts on: the newest that reached the phase, else one scoped
    // to it. A minted run is `paused` with no active phase, exactly as the
    // unsupervised-outcome path mints one, so nothing about it looks live until
    // the recovery arms it.
    let state = listRuns(root, slug, this.liveRunIds()).find((run) => run.phases[String(phase)]);
    if (!state) {
      state = newRun({
        slug, root, onlyPhases: [phase],
        autoRecover: this.prefs.autoRecoverByDefault !== false,
      });
      setRunState(state, 'paused');
      state.stoppedBy = 'system';
      state.activePhase = null;
      phaseRecord(state, phase);
      const journal = Journal.for(root, slug, state.id);
      journal.append('run.start', {
        ...(opts.actor ?? asActor(opts.by, 'Service.qaRecover')),
        minted: true,
        reason: `${verb} on phase ${phase}, which no run of this plan had reached`,
        onlyPhases: [phase],
      }, phase);
      saveRun(state);
    }

    const runner = this.runnerFor(slug);
    // The settings patch lands on the run BEFORE the loop arms, so the first
    // round already runs under them — a patch applied after would have the
    // operator's model take effect from round two.
    if (opts.settings) applySettings(state, opts.settings);
    if (typeof opts.qaMaxRounds === 'number') state.qaMaxRounds = opts.qaMaxRounds;
    if (opts.qaRoundBudgetUsd !== undefined) state.qaRoundBudgetUsd = opts.qaRoundBudgetUsd;
    if (opts.strategy) state.qaFixStrategy = opts.strategy;
    saveRun(state);

    const armed = await runner.qaRecover({
      slug, root, runId: state.id, phase, verb,
      strategy: opts.strategy ?? state.qaFixStrategy ?? DEFAULT_QA_FIX_STRATEGY,
      maxRounds: opts.qaMaxRounds ?? state.qaMaxRounds ?? DEFAULT_QA_MAX_ROUNDS,
      roundBudgetUsd: opts.qaRoundBudgetUsd ?? state.qaRoundBudgetUsd ?? null,
      by: opts.by ?? 'console',
    });
    if (!opts.settled) return armed;
    await runner.wait();
    return runner.current() ?? armed;
  }

  /**
   * Waive a verdict with a reason — the third verb, and the only one that
   * starts nothing.
   *
   * `--allow-writes` rather than `--allow-run`, because that is what it is: one
   * row in `test-status.md` and the reason beside it. It refuses on a phase
   * with no recorded verdict for `qaRecover`'s reason, and it does NOT refuse
   * on `pending` — waiving a review nobody ever ran is the honest end of a
   * phase whose gate holds for a plan that has decided not to review it.
   */
  async qaWaive(
    slug: string, phase: number,
    opts: { reason?: string; by?: string } = {},
  ): Promise<{ ok: boolean; verdict: string; round?: number; report?: string; detail: string }> {
    if (!this.flags.allowWrites) {
      return { ok: false, verdict: 'none', detail: 'Writes are disabled. Restart the console with --allow-writes.' };
    }
    const root = this.root?.path;
    const record = this.store?.get(slug);
    if (!root || !record) return { ok: false, verdict: 'none', detail: `No plan named ${slug}.` };

    const before = await this.qaVerdict(slug, phase);
    if (before === 'none') {
      return {
        ok: false, verdict: before,
        detail: `Phase ${phase} of ${slug} has no recorded QA verdict, so there is nothing to waive.`,
      };
    }
    // The gate's own regime, which round 1 prescribed for BOTH verbs and which
    // round 1's fix reached only one of — inside the very commit whose message
    // claimed "both now ask". That is the "listed five sites, changed four"
    // shape this whole phase is about, recurring one level in (QA round 2, M2).
    // Lower blast radius than `qaRecover`'s — a waiver writes a row rather than
    // spending a session — and wrong for the same reason: it would record a
    // decision about a gate that is not there.
    try {
      await this.assertGateHolds(slug, phase);
    } catch (error) {
      return { ok: false, verdict: before, detail: (error as Error).message };
    }
    // A waiver over a `pass` is a DOWNGRADE — it replaces a review that happened
    // with a decision that no review is needed — and a stale browser tab or a
    // repeated POST is enough to do it silently. `waived` is refused for the
    // same reason plus idempotence: re-waiving would bump the round and write a
    // second reason over the first.
    if (before === 'pass' || before === 'waived') {
      return {
        ok: false, verdict: before,
        detail: `Phase ${phase} of ${slug} already reads ${before} — its dependents are not held, and `
          + 'waiving would replace a recorded review with a decision not to review.',
      };
    }
    // A reason is REQUIRED here even though `qa-record.sh` accepts a waiver
    // without one: the script serves the hand-driven path, where the operator
    // is the one typing, and a console button that writes an unexplained waiver
    // into a versioned file is how a plan forgets what it decided not to fix.
    const reason = (opts.reason ?? '').trim();
    if (!reason) {
      return { ok: false, verdict: before, detail: 'A waiver needs a reason — it is the only record of why.' };
    }

    // The round and its report from the ONE chooser, like every other site.
    const { round, report } = nextQaRound(record.handoffDir, phase);
    let outcome;
    try {
      outcome = await runWrite(
        planWrite(
          { action: 'qa-record', slug, phase, result: 'waived', report, round, reason },
          { root, docsDir: this.root?.docsDir },
        ),
        { scriptsDir: this.flags.scriptsDir, root },
      );
    } catch (error) {
      return { ok: false, verdict: before, detail: `The waiver was not recorded: ${(error as Error).message}` };
    }

    // The postcondition, read back — never the exit code. The whole point of a
    // waiver is that the gate stops holding, and only the engine can say so.
    this.reread(slug);
    const after = await this.qaVerdict(slug, phase);
    const ok = after === 'waived';
    log.info('qa.waive', { slug, phase, ok, round, by: opts.by ?? 'console' });
    if (ok) {
      // Journalled on the run that reached this phase, when one has, so the
      // waiver appears on the run page beside the rounds it answers. A plan
      // with no run loses nothing: `test-status.md` is the record that gates.
      const state = listRuns(root, slug, this.liveRunIds()).find((run) => run.phases[String(phase)]);
      if (state) {
        Journal.for(root, slug, state.id).append('phase.qa-waived', {
          round, report, reason, by: opts.by ?? 'console', was: before,
        }, phase);
      }
      this.invalidateAll();
    }
    return {
      ok, verdict: after, round, report,
      detail: ok
        ? `Phase ${phase} is waived — its dependents are released on the next board read.`
        : (outcome.stderr || outcome.stdout).trim() || 'The waiver did not take.',
    };
  }

  /**
   * Refuse a QA verb when the gate is DEMONSTRABLY not there — and only then.
   *
   * One method because round 1 prescribed the check for both verbs and round
   * 1's fix reached one; a shared assertion is the only shape in which "both"
   * is checkable. `qaGateOff` rather than `!qaGateHolds` for the reason in its
   * own docblock: uncertainty must not become a refusal.
   */
  protected async assertGateHolds(slug: string, phase: number): Promise<void> {
    const mode = (await this.qaMode(slug, phase).catch(() => ({ mode: 'unknown' }))).mode;
    if (qaGateOff(mode)) {
      throw new Error(
        `The QA gate is not holding phase ${phase} of ${slug} (its QA mode is ${mode}), so this would `
        + 'act on a verdict nothing is waiting for.');
    }
  }

  protected async qaHolds(slug: string, phase: number): Promise<boolean> {
    try {
      // THIS phase's regime, not the plan's: a phase that exempted itself is
      // finished work, and admitting it as a blocker would have the ladder
      // resume a session to produce a verdict nothing is waiting for.
      if ((await this.qaMode(slug, phase)).mode !== 'on') return false;
      const verdict = await this.qaVerdict(slug, phase);
      return verdict !== 'pass' && verdict !== 'waived';
    } catch { return false; }
  }

  /**
   * Every open phase of a run, classified — the healer's candidate list. Order
   * is the halt's phase, the active phase, live lanes, then ascending: the
   * first one whose ladder has a rung this console can climb is the anchor.
   * Phases the board reads done are not candidates; their records are closed
   * by the reconcile pass, not diagnosed.
   *
   * Nor is a phase the board reads `waiting`: its dependencies are unmet, so it
   * has not started and cannot start, and there is no session a rung could
   * usefully launch for it. That cost was measured rather than imagined — a run
   * spent its ENTIRE recovery budget (5 launches) on a phase 10 whose 7, 8 and
   * 9 were sitting ready and untouched, halting each time with "the session for
   * phase 10 ended cleanly but the board still reads waiting", which is the
   * runner correctly describing work it should never have boarded. The one
   * exception is a phase this run is driving right now: out-of-order work is
   * still real work, and it stays diagnosable.
   */
  async classifyOpenPhases(
    slug: string, state: RunState, board: Record<number, string>, cache?: EvidenceCache,
    /** Phases the caller has already judged unchanged — never classified (#84). */
    skip?: ReadonlySet<number>,
  ): Promise<Array<{ phase: number; evidence: PhaseEvidence; situation: Situation }>> {
    const seen = new Set<number>();
    const order: number[] = [];
    const add = (phase: number | null | undefined) => {
      if (phase == null || seen.has(phase)) return;
      seen.add(phase); order.push(phase);
    };
    add(state.halt?.phase);
    add(state.activePhase);
    for (const child of childrenOf(state)) add(child.phase);
    for (const key of Object.keys(state.phases).map(Number).sort((a, b) => a - b)) add(key);
    const out: Array<{ phase: number; evidence: PhaseEvidence; situation: Situation }> = [];
    for (const phase of order) {
      if (!state.phases[String(phase)] || skip?.has(phase)) continue;
      // A phase the board reads `done` is settled work — its record is closed by
      // the reconcile pass, not diagnosed, and classifying every finished phase
      // on every pass would cost a board read and a classify per phase for ever.
      //
      // The one exception is a done phase QA is HOLDING. It is settled as work
      // and unsettled as a blocker: the engine keeps every dependent behind it,
      // and since `qa-failed`/`qa-pending` gained rungs there is something real
      // to climb — the session that built it can fix what the report named, or
      // dispatch the verdict nobody ever asked for. Admitting it bought nothing
      // while those rung lists were empty; it buys the whole plan now.
      if (board[phase] === 'done' && !(await this.qaHolds(slug, phase))) continue;
      if (board[phase] === 'waiting' && !childrenOf(state).some((child) => child.phase === phase)) continue;
      try {
        out.push({ phase, ...(await this.classifyPhase(slug, phase, state, board, cache)) });
      } catch (error) {
        log.warn('run.situation-failed', { slug, phase, error });
      }
    }
    return out;
  }

  /**
   * Which of the vehicles THIS console can drive today a rung maps to — or
   * null when the rung cannot be driven here (the ladder then skips it). The
   * thin reading of `resolveVehicle`; `rungRefusals` is the other, which keeps
   * the REASON each rung was refused so the errand can name it (RCV-7).
   */
  protected vehicleForRung(
    rung: Rung, situation: Situation, record: RunPhaseRecord | undefined, evidence: PhaseEvidence | null,
    slug = '<slug>', state?: RunState | null,
  ): DriveVehicle | null {
    const resolved = this.resolveVehicle(rung, situation, record, evidence, slug, state ?? null);
    return 'vehicle' in resolved ? resolved.vehicle : null;
  }

  /**
   * Every rung of `situationKey`'s table this console cannot drive, each with
   * why — the healer's half of `unavailableRungHint` (phase 10, RCV-7). Empty
   * when some rung is drivable, because then the ladder climbs and no
   * sentence is owed.
   */
  protected rungRefusals(
    situation: Situation, record: RunPhaseRecord | undefined, evidence: PhaseEvidence | null,
    slug: string, state: RunState | null,
  ): { rung: Rung; why: string }[] {
    const out: { rung: Rung; why: string }[] = [];
    for (const rung of rungsFor(situation.key)) {
      const resolved = this.resolveVehicle(rung, situation, record, evidence, slug, state);
      if ('refused' in resolved) out.push({ rung, why: resolved.refused });
    }
    return out;
  }

  /**
   * A rung, translated to what this console can launch today — the vehicle,
   * or the reason there is none (phase 10, LFC-2/RCV-10). Before this the
   * resource walls, the parks and the watch row were refused BY NAME (eight
   * `case`s answering `null`), so six whole tables could not be climbed and
   * the drive loop deferred them for ever with `phase.ladder-deferred`. Every
   * refusal now names what is in the way — a flag, a preference, a clock, an
   * account, a missing ref — and every table has at least one row the
   * console can drive (`shared/ladder-model.js` `VEHICLE_DRIVERS`).
   *
   * `state` is the run the phase belongs to, for the vehicles that act on the
   * RUN (its account, its budget, its clock); a caller with only a record —
   * the drive loop's availability probe — passes null and those vehicles
   * answer from the record and the meters alone.
   */
  protected resolveVehicle(
    rung: Rung, situation: Situation, record: RunPhaseRecord | undefined, evidence: PhaseEvidence | null,
    slug: string, state: RunState | null,
  ): { vehicle: DriveVehicle } | { refused: string } {
    const drive = (vehicle: DriveVehicle): { vehicle: DriveVehicle } => ({ vehicle });
    const refuse = (why: string): { refused: string } => ({ refused: why });
    // Capability flags (`--allow-run`, `--allow-agent`, node-pty) are NOT
    // consulted here: a vehicle the console has but may not use is still the
    // right vehicle, and the launch path refuses it BY NAME ("needs
    // --allow-agent") — a rung skipped silently would read as "nothing to
    // climb" and hide the flag that was actually in the way.
    // …and a session the CLI has refused to resume is no session either: the
    // own-session rungs skip, and the ladder reaches the fresh one.
    // …and neither is one not worth resuming (autopilot-token-drain phase 4): the
    // runner's gate would refuse it (`resumePolicy`), so the own-session rungs
    // skip by name here and the ladder reaches the fresh one without spending
    // a rung on a refusal. The account is judged only when the run is known.
    const { sessionId: ownSession, resumable, policy: notWorth } =
      resumeOffer(record, state ? state.accountId ?? 'default' : null);
    const noSession = record && isSessionGone(record)
      ? 'the CLI holds no conversation under the phase\'s session id here'
      : notWorth?.choice === 'fresh'
        ? `the phase's session ${ownSession} is not worth resuming — ${resumePolicyWhy(notWorth)} — `
          + 'a fresh session with the resume brief is cheaper'
        : 'the phase has no session to resume';
    const agent = true;
    // The drive loop's availability probe may carry no evidence (a preset
    // situation skips the gather); the healer always does.
    const outstanding = evidence?.handoff.outstanding?.trim();
    switch (rung.vehicle) {
      case 'reboard-fresh':
      case 'queue':
        return drive({ kind: 'retry' });
      // The permission wall's one rung (phase 9): drivable only from the
      // console's OWN denial — a deny-list rule on the record. A denial with
      // no rule (a hidden file, a wrapper) or by the wait guard names nothing a
      // person can widen, and a declaration read from prose alone is not the
      // evidence this card asks about.
      case 'widen-rule': {
        const denied = record?.toolDenied;
        if (!denied?.rule || denied.rule === 'in-turn-wait') {
          return refuse('the console recorded no deny-list rule for this phase — the wall was read from prose, and there is no rule to widen');
        }
        return drive({ kind: 'card', offer: 'widen-rule', denied: { tool: denied.tool, rule: denied.rule, ...(denied.command ? { command: denied.command } : {}), at: denied.at } });
      }
      case 'resume-own-session': {
        if (!resumable) return refuse(noSession);
        const mode = String(rung.params?.mode ?? 'continue');
        // The QA modes. Both resume the phase's OWN session, which looks wrong
        // for a review until you read SKILL.md §QA: the independence comes from
        // the fresh-context SUBAGENT the session dispatches, not from the
        // session being a different one. `--qa-prompt N` prints that subagent's
        // brief, and `qa-record.sh` is its only writer. Resuming is also what
        // makes the fix half cheap — the session that built the phase already
        // holds the context the report is about.
        // The real slug, phase and report path — never `<slug>`/`<N>`. A resumed
        // session is mid-conversation and will paste what it is given; handing
        // it a placeholder is handing it a guess.
        const n = evidence?.phase ?? record?.phase ?? 0;
        // The round, its filename and the findings come from the ONE builder
        // (`qaRungInstruction`, shared with the drive loop's own hint), which
        // asks the ONE chooser. This rung is the only one `qa-pending` had, it
        // is `auto`, and it was still briefing round 1 forever after three QA
        // rounds had fixed every other site — so a resumed session recorded
        // over a committed report and flipped the gate open (QA round 4). The
        // inline `qa-fix` paragraph that lived here carried no findings and
        // was the second copy of the fix brief; both are gone.
        const instruction = mode === 'qa-verdict' || mode === 'qa-fix'
          ? qaRungInstruction(mode, slug, n, this.store?.get(slug)?.handoffDir)
          : mode === 'fix-verification'
            ? 'Your phase\'s §Verification is RED. Read the failing commands and their output below, fix the cause, '
              + 're-run the verification until it is green, then commit and write the handoff.'
            : 'You are RESUMING this phase — it is not finished. Read `git status` and `git diff` FIRST: anything '
            + 'uncommitted is your own earlier work; never stash, checkout or reset it away. Then carry the phase to '
            + 'its exit criteria (the Outstanding section of your handoff says what is left), verify, commit, and '
            + 'write the handoff as complete.'
            + (outstanding ? `\n\nOutstanding, as you left it:\n${outstanding.slice(0, 4_000)}` : '');
        return drive({ kind: 'session', mode: 'resume', instruction });
      }
      case 'unblock-session': {
        if (this.prefs.unblockAttempts === false) {
          return refuse('Unblock attempts are off in Settings ▸ Automation: turn them on and Retry to spend one bounded session on it');
        }
        // No session left: the runner boards fresh with the unblock brief
        // (the engine's boot prompt + the Outstanding text + "you MAY do the work").
        if (!resumable) return drive({ kind: 'reboard', brief: 'unblock' });
        return drive({
          kind: 'session', mode: 'resume',
          instruction: 'You declared this phase BLOCKED. This is ONE bounded unblock session: you are explicitly '
            + 'allowed — asked — to do the work that unblocks it yourself where a machine can (build what is '
            + 'unbuilt, fix what is red, finish what is partial). Read `git status` and `git diff` first; never '
            + 'discard earlier work. If the blocker is genuinely outside your reach (a credential nobody holds, a '
            + 'person\'s approval, a third party), say exactly what is needed with `phase-outcome.sh … blocked '
            + '--reason` and stop. Otherwise carry the phase to its exit criteria, verify, commit and hand off.'
            + (outstanding ? `\n\nYour Outstanding section, as you left it:\n${outstanding.slice(0, 4_000)}` : ''),
        });
      }
      case 'closeout-own-session':
        return resumable ? drive({ kind: 'session', mode: 'closeout' }) : refuse(noSession);
      // The four "a fresh briefed agent" rungs. Under `--allow-run` they are
      // RUNNER SESSIONS (`mode: 'repair'`): the run's settings file and deny
      // wall, its hooks, its journal, its lane, its grant, its lease, its
      // account, and its tree. The pty `agent` kind survives as the fallback
      // for a console allowed to mint agents but not to run sessions — and as
      // the operator's own button, which never comes through here.
      //
      // This is the ONE place a capability flag is read (the comment at the top
      // of this function says they are not, and it stays true in spirit): the
      // flag CHOOSES between two vehicles rather than skipping the rung, so the
      // "refused by name" property is untouched — a console with neither flag
      // still lands on the agent path and is told which flag it wants.
      case 'closeout-agent':
        return drive(this.repairVehicle('halted-missing-handoff', situation));
      case 'fix-agent':
        // `qa-pending`'s fresh review rides the QA loop, not a repair session:
        // the review is boarded from the boot prompt and the verdict it
        // records is read back from the ledger, exactly as the operator's
        // Re-run QA does when no session exists.
        if (rung.params?.mode === 'qa-review') return drive({ kind: 'qa-rerun' });
        return drive(this.repairVehicle('halted-verification', situation));
      case 'plan-repair-agent':
        return drive(this.repairVehicle('plan-repair', situation));
      case 'stale-claim-takeover':
        return this.prefs.staleClaimTakeover === false
          ? refuse('Take over stale claims is off in Settings ▸ Automation: turn it on and Retry, or release the claim from the phase page')
          : drive(this.repairVehicle('stale-claim-takeover', situation));
      // The free rung `plan-broken` starts on: a deterministic script, no
      // session and no money. It was undrivable until the script existed, so
      // every `plan-broken` began at the paid agent rung (R19).
      // 🔴 Conditional, unlike the four above, and for a reason the `available`
      // predicate makes load-bearing: an unconditional vehicle told `nextRung`
      // this rung was climbable, and the `--allow-writes` refusal then returned
      // BEFORE `climb()` — so the rung was never recorded as tried, `nextRung`
      // picked it again every sweep, and `plan-repair-agent` behind it became
      // unreachable. A console without the flag reached NO remedy at all, where
      // before this phase it fell through to the agent. Answering null here
      // restores the fall-through; the flag is still named by the errand.
      case 'plan-repair-script':
        return this.flags.allowWrites
          ? drive({ kind: 'script', script: 'repair-artefacts' })
          : refuse(`the free deterministic rung (scripts/repair-artefacts.sh ${slug} --apply) needs a console started with --allow-writes: run it by hand, or restart with the flag and Retry`);
      // The runner's own re-board with a RESUMING brief: the engine's boot
      // prompt plus the evidence (handoff, uncommitted paths, last
      // verification, last words). Through `start({resumeRunId, reboard})`,
      // never a second orchestration.
      case 'reboard-resume-brief':
        return drive({ kind: 'reboard', brief: 'resume', ...(rung.params?.escalate === 'model' ? { escalate: 'model' as const } : {}) });
      // The `require` park's two rungs. The wait is the service's TIMER — the
      // vehicle holds the park on its clock, re-arming the timer a crash may
      // have lost, and the healer accounts the rung ONCE per park (phase 10:
      // it used to be refused by name, so `wait-heal` was a row in the docs
      // that nothing ever climbed — 0 against 104 `phase.mcp`). Drivable only
      // while the clock runs; the continue is driven once it has run out —
      // belt and braces for a timer lost to a crash — and never when the
      // operator set the timeout to 0 (wait indefinitely).
      case 'wait-heal': {
        const due = mcpParkDueAt(record, this.mcpRequireTimeoutMs());
        if (due === null) {
          return refuse(record?.mcpPark
            ? 'the park has no clock — mcpRequireTimeoutMs is 0 (wait indefinitely), so only the server healing or a Continue moves it'
            : 'the phase is not parked on an MCP server any more');
        }
        if (due <= Date.now()) return refuse(`the park's clock ran out at ${new Date(due).toISOString()} — the next rung continues without the server`);
        return drive({ kind: 'wait-heal', until: new Date(due).toISOString() });
      }
      case 'mcp-continue': {
        const due = mcpParkDueAt(record, this.mcpRequireTimeoutMs());
        if (due === null) {
          return refuse(record?.mcpPark
            ? 'the park has no clock — mcpRequireTimeoutMs is 0 (wait indefinitely); press Continue without these servers on the run page'
            : 'the phase is not parked on an MCP server any more');
        }
        return due <= Date.now()
          ? drive({ kind: 'mcp-continue' })
          : refuse(`the park's clock has not run out — it continues without the server at ${new Date(due).toISOString()} unless the server heals first`);
      }
      /* The resource walls. The RUNNER climbs each inline at the wall (auth
       * and usage → switch-account / wait-window, budget → raise-budget,
       * models → switch-model / wait-window), so by the time a stopped run
       * reaches this healer the inline try has usually been made — but a
       * person's sign-in since, an account registered since, a preference
       * flipped since, or a run written by an older console are exactly the
       * cases a stopped run can only recover from HERE. Each vehicle is
       * resolved from the meters and the run's own record before the rung is
       * accounted; what cannot be resolved is refused with the reason. */
      case 'switch-account': {
        const from = state?.accountId ?? DEFAULT_ACCOUNT_ID;
        // The identity the run started on (control-tower phase 91, #131): the
        // measured heal resumed a run on `default` after the machine login was
        // signed in as somebody else — "room" and a breaker the new
        // organisation id had opened were all it looked at. On a changed
        // identity the rung neither stays nor moves: the stop is re-said as
        // what it is and a person chooses.
        const bound = state?.identity;
        const answers = state && bound && bound.account === from
          ? this.accounts.identityOf?.(from === DEFAULT_ACCOUNT_ID ? undefined : from)
          : undefined;
        if (state && bound && answers && answers.key !== bound.key) {
          this.parkStoredOnIdentity(state, answers);
          return refuse(`${this.accounts.labelFor(from === DEFAULT_ACCOUNT_ID ? undefined : from)} changed identity — it answers `
            + `${answers.email ?? answers.org ?? 'another login'} now, not ${bound.email ?? bound.org ?? 'the login this run started on'}; `
            + 'a person chooses whether the run continues on the new login or moves to the profile of the identity it started on — '
            + 'the heal never resumes it by itself');
        }
        // Inside the run's pool when it declared one (control-tower phase 53,
        // #55) — the same rule the runner's failover climbs by.
        const pool = state ? accountPool(state) : null;
        const forModel = state?.model ?? record?.model;
        // The run's OWN account signed in again (control-tower phase 5, #36):
        // "continue under a signed-in account" is already true of it, and on a
        // machine with one login there is nothing else to switch to — so the
        // rung continues under it rather than refusing into the errand the
        // clearance was meant to answer. Only on EVIDENCE of that: the wall
        // was the breaker's own (the runner stamped it on the record), and the
        // breaker has written a usable word for the account SINCE. A sign-in
        // halt read from prose has no such evidence — the same account would
        // only meet the same wall — and still refuses.
        const wall = record?.cause?.kind === 'credential-refused' ? record.cause : null;
        const word = wall ? this.accounts.entitlementOf(from) : null;
        const cleared = Boolean(wall && word && word.state !== 'retired' && word.at && word.at > wall.at);
        // Judged NOW, from the live meters (control-tower phase 78, #106): the
        // wall this rung answers was read off a stored checkpoint, and an
        // earlier attempt's wall on another account is not a wall on this one.
        const current = this.accounts.roomOf(from === DEFAULT_ACCOUNT_ID ? undefined : from, forModel);
        const plan = this.accounts.switchCandidates(from === DEFAULT_ACCOUNT_ID ? undefined : from, forModel, {
          // A refused credential is not a usage wall (control-tower phase 92):
          // an unmetered account is still somewhere the run can go.
          until: current.resetsAt, pool, usage: situation.sub !== 'auth',
        });
        const decision = switchRungDecision({
          from,
          wall: situation.sub === 'auth' ? 'auth' : 'usage',
          current,
          candidates: plan.ranked.map((id) => ({ id, headroomPct: this.accounts.roomOf(id, forModel).headroomPct })),
          choice: state?.accountChoice ?? null,
          cleared,
        });
        if (decision.act === 'stay') return drive({ kind: 'switch-account', accountId: from, from, why: decision.why });
        if (decision.act === 'switch') {
          return drive({ kind: 'switch-account', accountId: decision.accountId, from, ...(decision.reverts ? { reverts: decision.reverts } : {}) });
        }
        if (decision.code === 'less-headroom') return refuse(decision.why);
        if (plan.declined.length) {
          return refuse(`every account that could take the run would wall before ${this.accounts.labelFor(from)}'s own wall resets `
            + `(${plan.declined.map((row) => `${this.accounts.labelFor(row.id)}: ${row.why}`).join('; ')}) — waiting is cheaper`);
        }
        if (pool) {
          return refuse(`no account in this run's pool (${pool.join(', ')}) has headroom right now — switch the run to another `
            + 'account under Settings ▸ Accounts (it joins the pool); failover never leaves the pool by itself');
        }
        const others = this.accounts.accountIds().filter((id) => id !== from).length;
        return refuse(others
          ? `no other registered account has headroom right now (${others} registered; each is retired, cooling, walled or signed out)`
          : 'no other account is registered — register or sign one in under Settings ▸ Accounts');
      }
      // Fails over in the runner's attempt loop, at the wall, on the model
      // fallback chain (`phase.model-switch`); a stopped run has no attempt to
      // fail over inside, and the halt it stopped on says every model was
      // exhausted — the wait for the first model's window is the next rung.
      case 'switch-model':
        return refuse(state?.halt?.kind === 'models-exhausted'
          ? 'every model in the fallback chain was limited when the run halted (the runner fails over inline; there is no next model to switch to)'
          : 'the model fallback chain is the runner\'s to climb, inline at the wall');
      case 'wait-window': {
        const accountId = state?.accountId ?? undefined;
        const model = state?.model ?? record?.model;
        const verdict = this.accounts.headroom(accountId, model);
        const resets = !verdict.ok && verdict.kind === 'wall' ? verdict.resetsAt : undefined;
        const limits = state?.limits?.resetsAt;
        const fromLimits = typeof limits === 'number' && Number.isFinite(limits) ? new Date(limits * 1000).toISOString() : undefined;
        const until = [resets, fromLimits].filter((u): u is string => Boolean(u) && Date.parse(u!) > Date.now()).sort()[0];
        if (!until) {
          return refuse(verdict.ok
            ? `${this.accounts.labelFor(accountId)} reads no wall on its meters now — nothing to wait for; Retry re-boards the phase`
            : `the wall on ${this.accounts.labelFor(accountId)} reported no reset time (${verdict.reason.slice(0, 120)}) — nothing here can wait it out`);
        }
        return drive({
          kind: 'timed-park', until, wait: 'usage-limit',
          why: `${situation.label} — waits for ${this.accounts.labelFor(accountId)}'s window, which reopens at ${until}`,
        });
      }
      case 'raise-budget': {
        if (!state) return refuse('the run is not to hand — the budget is the run\'s to raise');
        if (!state.runBudgetUsd) return refuse('the run has no dollar budget set, so there is nothing to raise');
        if (state.budgetRaise) {
          return refuse(`the budget was already raised once, $${state.budgetRaise.from} → $${state.budgetRaise.to} (${state.budgetRaise.pct}%) at ${state.budgetRaise.at}, and spent again — a second raise is a person's`);
        }
        const pct = this.prefs.budgetAutoRaisePct ?? 25;
        if (!(pct > 0)) return refuse('budgetAutoRaisePct is 0 in Settings ▸ Automation — the automatic raise is switched off');
        const cap = ladderCaps(this.prefs).perRunUsd;
        const from = state.runBudgetUsd;
        const to = Math.round(Math.min(from * (1 + pct / 100), Math.max(cap, from)) * 100) / 100;
        if (to <= from) return refuse(`the run budget of $${from} is already at the ladder's $${cap} per-run cap — raise the cap (ladderPerRunUsd) or the budget on the run page`);
        if (to <= state.spentUsd) return refuse(`a ${pct}% raise to $${to} would still be under the $${state.spentUsd.toFixed(2)} already spent`);
        return drive({ kind: 'raise-budget', from, to, pct, cap });
      }
      /* The external parks (`blocked-declared:external`). A declared blocker
       * WITH machine-checkable refs is stood down before any climb — the
       * watch clock owns it — so `poll-park` is reachable only when the
       * session named none; it is drivable on exactly the refs it did name.
       * `timed-park` is always drivable: a bounded clock, then the phase's own
       * session re-checks. */
      case 'poll-park': {
        const refs = pollableRefs(record?.declared?.watch ?? record?.watch).map((target) => target.ref);
        if (!refs.length) {
          return refuse('the session named no machine-checkable watch ref (a `gh:` run or PR, a `date:`, a `lock:`, a `cmd:`) — there is nothing to poll');
        }
        const until = new Date(Date.now() + LADDER_TIMED_PARK_MS).toISOString();
        return drive({
          kind: 'timed-park', until, wait: 'external', refs,
          why: `${situation.label} — parked on ${refs.join(', ')}; the watch clock resumes the session when one lands, else at ${until}`,
        });
      }
      case 'timed-park': {
        const until = new Date(Date.now() + LADDER_TIMED_PARK_MS).toISOString();
        return drive({
          kind: 'timed-park', until, wait: 'external',
          why: `${situation.label} — parked until ${until}, when the phase's own session re-checks the blocker`,
        });
      }
      // The `waiting-external` row is the watch clock itself: one pass now,
      // outside the cadence. A `wait` actor's table is never climbed by the
      // healer (`nextRung` is not asked), so this answers the drive loop's
      // availability probe and the operator's Re-check, honestly.
      case 'watch-clock': {
        const refs = pollableRefs(record?.declared?.watch ?? record?.watch);
        return refs.length
          ? drive({ kind: 'watch-clock' })
          : refuse('the session declared no machine-checkable watch ref — the clock has nothing to poll; the wait ends at its own window');
      }
      default:
        return refuse(`no vehicle drives ${String(rung.vehicle)} on this console`);
    }
  }

  /**
   * A briefed remediation, as the best vehicle this console may actually use.
   *
   * `--allow-run` ⇒ a runner session under the whole frame; otherwise the pty
   * agent, which the launch path then refuses BY NAME if `--allow-agent` is
   * missing too. Never null FOR THESE FOUR: both vehicles exist on every
   * console, so a rung skipped here would read as "nothing to climb" and hide
   * the flag that was in the way.
   *
   * (`plan-repair-script` is the deliberate exception and answers null without
   * `--allow-writes` — see its case. The difference is that it has no second
   * vehicle to fall back to, so "unavailable" is the truth rather than a hidden
   * refusal, and the ladder must be free to reach the rung behind it.)
   */
  private repairVehicle(cls: RecoveryClass, situation: Situation): DriveVehicle {
    return this.flags.allowRun
      ? { kind: 'session', mode: 'repair', cls, situation: situation.key }
      : { kind: 'agent', cls };
  }

  protected async phaseLock(slug: string, phase: number): Promise<string | null> {
    try {
      const out = await run(this.engineOpts(), 'phase-lock.sh', [slug, 'status', String(phase)]);
      return out.stdout.trim() || null;
    } catch { return null; }
  }

  /*
   * There is no `boardStates(slug)` here any more (P6/D2).
   *
   * It wrapped `board(slug).states` in `try/catch { return {} }`, which made
   * "the console could not read the board" and "no phase is done" the SAME
   * value — and its callers decided on it. `recoverPlan` answered "Every phase
   * reads done on the board — nothing to recover or continue" about a board it
   * had failed to read (an empty object has no non-`done` entries);
   * `maybeAutoRecover` derived its anchor, and could spend a billed rung, from
   * the same emptiness; `preRecoveryGate`'s `if (board)` was dead, because a
   * function that catches internally never returns null.
   *
   * `board(slug)` is the one reader: it is cached per plan revision, and it
   * reports failure as `board.error` — the fail-safe shape `convergeDeps.board`
   * already takes. Every caller below refuses to ACT on an unreadable board;
   * refusing is not the same as failing, so a read that could not run never
   * takes the operator's button away either.
   */

}
