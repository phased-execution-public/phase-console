/**
 * The service layer: one open source directory, everything the API serves.
 *
 * It owns the store, the engine cache, the search index and the live watcher,
 * and it is the only place that decides what is cached and for how long — a
 * plan's cached engine answers are keyed by its revision, which the watcher
 * bumps whenever one of its files changes.
 */

import { basename, join, resolve as resolvePath } from 'node:path';
import { DECISION_ANSWERS, OWNER_KEYS, destructiveExceptions, isAnswerWord, sanitisePolicyPrefs } from '../shared/policy-model.js';
import { DECISION_KEYS, mergeDecisions } from '../shared/decisions-model.js';
import { policyForKey, policyPrefsOf } from './runner/policy.ts';
import {
  planApprovedInstruction, planContinueReason, planHeldReason, planOf, planTextFile, type PlanDecision,
} from './runner/plan-approval.ts';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';

import { configDir, instanceId, stateHome } from '../shared/instances.mjs';
import {
  INSTANCE, INSTANCE_STATE_DIR, SKILL_DIR, STATE_DIR, agentEnabled, checkRoot, distRev, rememberRoot, loadPrefs, prefDefault,
  savePrefs, serverIsStale, staticRoot, withAutomation,
  type Flags, type Prefs, type RootCheck,
} from './config.ts';
import {
  SessionRegistry, correlate, parseHookPayload,
  type RunLink, type SessionEventName, type SessionRecord, type SessionView,
} from './sessions/registry.ts';
import { hooksStatus, installHooks, uninstallHooks, type HooksStatus, type HooksWrite } from './hooks-install.ts';
import { Store, handoffFor, lockFor, qaFor, readLock, type PlanRecord } from './store.ts';
import {
  ConvergeScheduler, convergePlan, HALT_DELAY_MS, type ConvergeDeps, type ConvergeReport, type ConvergeTrigger, convergeView, type ConvergeView } from './converge.ts';
import { planWrite, runWrite, insideDir } from './writes.ts';
import type { PlanFacts } from './agent.ts';
import {
  run, invalidate, readMemoryBlock, readQaMode, readSessionPlan, readLint, readGateStatus,
  readText, readBoardText, type Board, type QaMode, type SessionPlan, type LintResult,
  type GateStatus,
} from './engine.ts';
import { QA_DIRECTIVES } from '../shared/plan-vocab.js';
import { QA_CONFIRM } from '../shared/run-settings.js';
import { RELOGIN_CONFIRM } from '../shared/ops-vocab.js';
import { SearchIndex, type SearchResult } from './search.ts';
import { listSkills, type SkillInfo } from './skills.ts';
import { SCRIPTS_REF } from './skill-copy.ts';
import { DocsWatcher } from './watch.ts';
import {
  degradedState, hasShutdownWork, onDegraded, requestRestart, requestShutdown, stopPlan, supervisor,
} from './lifecycle.ts';
import { log } from './log.ts';
import {
  CATEGORIES, Push, isPlanProgress, parseQuietHours, routeFor, sanitiseCategories, tagFor, type CategoryId,
} from './push/index.ts';
import { isPushActionVerb } from './push/actions.ts';
import { Notifications, type NotificationQuery, type NotificationRecord } from './notifications.ts';
import { repoInfo, lastCommit, commitsTouching, type GitRepoInfo, type GitFileInfo } from './git.ts';
import { findMemory, memoryIndexLines } from './memory.ts';
import {
  loadSizing, loadMcpSurcharge, indexGraph, routeLayout, analysePhases, criticalPath, remainingWork,
  resolveBudget, weightOf, type Sizing, type McpSizing, type PhaseAnalysis,
} from './analysis/graph.ts';
import { loadGateVocab, gateKindOf, type GateVocab, type GateKind } from './analysis/gates.ts';
import {
  planCost, rungsToday, spendSummary, type SpendRunView, type SpendView,
} from './analysis/spend.ts';
import { renderMetrics, type MetricsProcess } from './analysis/metrics.ts';
import { etagOf, type Encoding } from './http/compress.ts';
import { getHeapStatistics } from 'node:v8';
import { activeHandles, eventLoopDelay } from './runtime-probe.ts';
import {
  projectTimeline, attemptsOf, compareConsecutive,
  type RunTimeline, type AttemptSummary, type AttemptComparison,
} from './analysis/timeline.ts';
import {
  buildInbox, inboxIds, pruneAcks, readAcks, removeAck, removeAckMany, writeAck, writeAckMany,
  INBOX_ACKS_DIR, type InboxAck, type InboxFacts, type InboxView,
} from './inbox.ts';
import { STALL_SIGNAL_META, inboxItemId, parseInboxItemId } from '../shared/attention-model.js';
import { deriveEvidence } from '../shared/evidence-model.js';
import {
  planStats, portfolio, etaSamples, etaFrom, rateFor, phaseEtaFor, healthIssues, isClosedStatus, splitRepos,
  type PlanStats, type Portfolio, type PlanContext, type EtaEstimate, type EtaSample,
  type PhaseEta, type RateReading,
} from './analysis/stats.ts';
import { mcpServersFor, type Plan, type PhaseDetail, type PhaseRow } from './parse/plan.ts';
import {
  Runner, applySettings, VERIFICATION_PARK_NOTE, MCP_PARK_NOTE,
  type AskResult, type RecoverMode, type RunSettingsPatch, type StartOptions,
} from './runner/runner.ts';
import { Scheduler, lockLapsed, type LockView } from './runner/scheduler.ts';
import { offeredModels } from './runner/models.ts';
import {
  continueMcpParkedRecord, mcpParkDueAt, DEFAULT_MCP_REQUIRE_TIMEOUT_MS, type McpContinueResult,
} from './runner/mcp-park.ts';
import {
  classifySituation, collectEvidence, summariseEvidence,
  type EvidenceDeps, type PhaseEvidence, type Situation,
} from './runner/situation.ts';
import {
  accountRung, errandFor, ladderCaps, nextRung, rungsFor, settleRung, type Rung,
} from './runner/ladder.ts';
import type { Actor, McpDegradation, PhaseRecord as RunPhaseRecord } from './runner/state.ts';
import { asActor, doorActor, pressActor } from './actor.ts';
import { sanitiseSchedule } from '../shared/schedule-policy.js';
import { sanitiseRelayRules, type RelayMechanism } from '../shared/relay-model.js';
import type { RelayReply } from './relay.ts';
import { formatScope, scopeOfRow, scopesIntersect } from '../shared/scope.js';
import { ISOLATION_MODES, ISOLATION_RECLAIM, pairKey, retentionOf, SETTLE_STRATEGIES, WORKTREE_ROOTS} from '../shared/worktree-model.js';
import {
  RESUME_AT_BOOT_MODES, fromAutomation, resumeAtBootMode,
} from '../shared/automation-model.js';
import {
  KIND_PROFILE, NO_HANDOFF_AUTO_RE, VERIFICATION_AUTO_RE, isRecoveryClass, recoveryActionsFor,
} from '../shared/recovery-model.js';
import { environmentReport, type EnvIssue } from './env-doctor.ts';
import { Terminals, type SessionEvent, type SessionInfo, type SessionKind } from './terminal.ts';
import { foldInboxTasks, type TaskItem } from './runner/tasks.ts';
import { Journal } from './runner/journal.ts';
import { journalFile } from './runner/run-paths.ts';
import { projectLedger, summariseLedgers, type LedgerSummary, type RunLedger } from './analysis/ledger.ts';
import {
  branchList, checkoutList, commitGraph, pickTarget,
  repoDiff as diffOf, repoTargets as targetsOf, rootTarget, settleHistory,
  type RepoBranches, type RepoCheckout, type RepoDiff, type RepoGraph,
  type RepoTarget, type SettleEvent,
} from './git-browse.ts';
import {
  FREEZE_ESCALATE_MS, escalatePersistedFreeze, runFreezeVerdict, type PersistedEscalation,
} from './runner/freeze.ts';
import type { BackgroundTask, LaneLiveness } from './runner/liveness.ts';
import { inTurnWait, waitScope } from './runner/liveness.ts';
import { backgroundExitRefusal, pollLoopNotice, waitProcedure } from './runner/runner-core.ts';
import { isStatusCapable, type PollVerdict } from '../shared/poll-loop.js';
import { appendAck as appendRulingAck, ingestRulings, readRulings, rulingsFile, type Ruling } from './runner/rulings.ts';
import {
  autoResolveRun, childrenOf, latestRun, listRuns, loadRun, newRun, phaseRecord, pidAlive,
  reconcileRecordsAgainstBoard, resetForRetry, resolveRunsAgainst, retirePhaseHalt, runsGeneration, saveRun,
  slugsNeedingBoard, runDir, consoleRunsDir, IN_FLIGHT, PHASE_IN_FLIGHT, RESOLVABLE, isMcpPolicy, mcpReasonText,
  type BoardingBrief, type Errand, type McpPolicy, type PreflightWarning, type RungRecord, type RunState, type VerifySummary,
  journalOf,
  setRunState,
} from './runner/state.ts';
import {
  consumeOutcome, inboxOutcomePhase, outcomeFileFor, outcomeInboxDir, readOutcome, type PhaseOutcome,
} from './runner/outcome.ts';
import { readTranscript, transcriptFile, type TranscriptEntry } from './runner/transcript.ts';
import { extractCommands, resolveLead, unresolvableLeads, verifyPhase } from './runner/verify.ts';
import { loadVerifyEnv } from './runner/verify-env.ts';
import { checkAuth, checkAuthFor, forgetAuth, openLoginTerminal, openCommandTerminal, shellQuote, type AuthStatus } from './runner/auth.ts';
import { hashedOrgId } from './accounts/learned.ts';
import {
  AccountInUseError, Accounts, DEFAULT_ACCOUNT_ID, profileConfigDir,
  type AccountView, type EntitlementProbeResult, type HeadroomVerdict, type TombstoneView,
} from './accounts/index.ts';
import { realExec, type Exec } from './accounts/credentials.ts';
import { Mcp, type McpServerView } from './mcp/index.ts';
import {
  bridgeDefinition, consoleConfigDir, isLoginBlock, loginEnv, planMcpLogin, unbridgeDefinition,
  type McpLoginPlan, type McpLoginTarget,
} from './mcp/login.ts';
import { portTranscript } from './accounts/transcripts.ts';
import { FULL_FLAGS, installDesktopLauncher, launcherPlan } from './launcher.ts';
import {
  RECOVERY_TITLES, recoveryKey,
  type RecoveryClass, type RecoveryFacts, type RecoveryRequest,
} from './recovery.ts';
import { buildAgentLaunch, phasedExecutionSkillId } from './agent.ts';
import {
  isVerdict, qaKey, type QaFacts, type QaRequest,
} from './qa-session.ts';
import { nextQaRound, qaReportPath, highestQaRound } from './qa-round.ts';
import {
  Approvals, classifyTool, matchedDenyRule, loadPolicy, loadPolicyFor, policyExtras, addPolicyRules, treeGuard,
  signInCall, signInJournalCommand, signInRefusal, type SignInCall,
  editPolicy, planPolicyPath, effectivePlanPolicyPath, notifyOutOfBand, carvedPolicy, suggestedRule,
  autoApproveFor, neverAutoApproves, hitsHidden, matchedAskRule, publishingRule, questionRule, questionsOf, planRule, reshapeReason,
  gateForgeCall, GATE_FORGE_RULE,
  consoleForgeCall, consoleForgeException, consoleForgeRefusal, consolePorts, CONSOLE_FORGE_RULE, type ConsoleForge,
  parseRule, inertRules, HOOK_TOOLS, WRAPPERS_NOT_STRIPPED, EXTEND_CHOICES_MIN,
  PERMISSION_PROFILES, PROFILE_LABELS,
  DEFAULT_DENY, DEFAULT_ASK, DEFAULT_ALLOW, POLICY_PATH, PUSH_DENY,
  type Approval, type Evidence, type ManifestCheck, type PolicyScope, type PermissionProfile,
} from './runner/approvals.ts';
import { manifestVerdict } from './runner/manifest-verdict.ts';

import {
  AUTO_GRANT_REASONS, ETA_POOL_MS, EVENT_BUFFER, HOOK_EVENTS_PER_MINUTE, HookPayloadError, HookRateError, INBOX_SOURCES, MAX_TIMER_MS, OUTCOME_INBOX_DEBOUNCE_MS, OUTCOME_INBOX_MAX_AGE_MS, PhaseClaimedError, RecoveryBusyError, UNSUPERVISED_WAIT_DEFAULT_MS, autoRecoveryClass, bucketLabel, describeExit, describeToolInput, effortOf, gitPorcelain, gitRead, lockView, modelAlias, recoveryActions, recoveryOwner, seedSkills, situationOfHalt, titleOf, type AutoRecoverResult, type Cached, type ControlResult, type DriveVehicle, type EtaPool, type EvidenceView, type LiveEvent, type LiveListener, type LockRelease, type PhaseDiagnosis, type PhaseLockView, type PhaseView, type PlanDetail, type PlanSummary, type QaOutcome, type RecoveryAction, type RouteView,
} from './service-core.ts';
import { ServiceRecovery } from './service-recovery.ts';
import { qaAnchorPhase } from './service-runs.ts';
import { trimOldest, NOTIFIED_CAP } from './service-base.ts';
import type { Presence } from '../shared/run-lifecycle.js';
import { managedRoots, stagingHome, stagingNames } from './runner/worktree.ts';
// The four launch-default vocabularies (phase 15) are read on a FREE line —
// the settings door stores the words in both trees, and their owners ship in
// both (the contracts, phase 2) — so their import sits outside the region
// below. Inside it, the free tree's typecheck read `LAND_POLICIES` and its three
// siblings as undeclared names from 5.0.0 until this release.
import { CONFLICT_POLICIES, LAND_POLICIES } from '../shared/landing-model.js';
import { MESSAGING_WORDS } from '../shared/message-model.js';
import { ISSUE_MODES, issueReposOf } from '../shared/issues-model.js';

export {
  HOOK_EVENTS_PER_MINUTE,
  HookPayloadError,
  HookRateError,
  PhaseClaimedError,
  RecoveryBusyError,
  autoRecoveryClass,
  effortOf,
  modelAlias,
  recoveryActions,
  seedSkills,
} from './service-core.ts';
export type {
  AutoRecoverResult,
  ControlResult,
  EvidenceView,
  LiveEvent,
  LiveListener,
  LockRelease,
  PhaseDiagnosis,
  PhaseLockView,
  PhaseView,
  PlanDetail,
  PlanSummary,
  QaOutcome,
  RecoveryAction,
  RouteView,
} from './service-core.ts';

/** The shortest a spend answer is reused for, even across a write of our own. */
const SPEND_POOL_MIN_MS = 5_000;

/**
 * The longest one is reused when NOTHING has been written.
 *
 * The only thing this bounds is a write by ANOTHER console on the same state
 * directory, which this process cannot see. A minute is far inside any window
 * where that would matter to a header widget, and it is twelve times fewer
 * whole-portfolio scans than the bare clock that used to be the whole key.
 */
const SPEND_POOL_MAX_MS = 60_000;

/**
 * How long a memoised inbox may be served at an unchanged revision
 * (control-tower phase 56, #75). The revision catches every change that
 * announces itself; this bounds the ones that do not — a clock crossing a
 * threshold, a ledger line a session appended — at one refetch beat's worth.
 */
export const INBOX_MAX_AGE_MS = 10_000;

/** `GET /api/inbox`'s body as the route sends it — built once per memo. */
export type InboxEntity = {
  etag: string;
  body: Buffer;
  /** Each coding packed at most once, on first ask. */
  packed: Partial<Record<Encoding, Promise<Buffer>>>;
};

/** One memoised inbox: the view, the key it was built at, and when. */
type InboxMemo = { key: string; at: number; view: InboxView; entity?: InboxEntity };

/** What a QA directive may be set to — `shared/plan-vocab.js` `QA_DIRECTIVES`. */
export type QaDirective = (typeof QA_DIRECTIVES)[number];

/** `setQaMode`'s answer: the regime the engine reads back, never the directive echoed. */
export type QaModeSetOutcome = {
  ok: boolean;
  detail: string;
  /** The plan-wide regime after the write. Absent on a refusal that wrote nothing. */
  plan?: QaMode;
  /** The named phase's own regime after the write, when the switch was per phase. */
  phase?: { phase: number; regime: QaMode };
};

/** `terminals.state()` with each QA reviewer's task list folded on — `GET /api/terminal`'s body. */
export type TerminalStateView = Omit<ReturnType<Terminals['state']>, 'sessions'> & {
  sessions: (SessionInfo & { tasks?: TaskItem[] })[];
};

/**
 * A relay reply in the `PreToolUse` wire shape (phase 14). `answered` is `allow`
 * with `updatedInput` — the call's `questions` echoed and `answers` keyed by each
 * question's text, what spike S1 measured honoured; `deferred` is `defer`, which
 * spike S3 measured honoured and which only this hook can say; everything else
 * is `deny` with the words the session needs. `decidePermissionRequest`
 * re-shapes the same object for its own event.
 */
function relayHookReply(reply: Exclude<RelayReply, { kind: 'not-relayed' }>): Record<string, unknown> {
  if (reply.kind === 'answered') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: reply.reason,
        updatedInput: reply.updatedInput,
      },
    };
  }
  if (reply.kind === 'deferred') {
    return {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer', permissionDecisionReason: reply.reason },
    };
  }
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reply.message },
  };
}

/** A decision key's place in the manifest's own order; an unknown key sorts last. */
function keyRank(key: string): number {
  const at = (DECISION_KEYS as readonly string[]).indexOf(key);
  return at < 0 ? DECISION_KEYS.length : at;
}

export class Service extends ServiceRecovery {
  /** The attention inbox, memoised per shape (`all` or not) — see `attention`. */
  private inboxMemo = new Map<boolean, InboxMemo>();
  /** The build in flight per shape, and the key it is building. */
  private inboxFlight = new Map<boolean, { key: string; promise: Promise<InboxMemo> }>();
  /** Each plan's gate answers as the inbox last read them — see `inboxGates`. */
  private inboxGateAnswers = new Map<string, { revision: number; gates: Map<number, GateStatus | null> }>();
  /** The refills in flight, as `<slug>@<revision>`. */
  private inboxGateFills = new Set<string>();

  /**
   * Sign-ins whose definition this console wrote and has not taken back.
   *
   * Only the no-pty flows land here: an embedded one carries `mcpBridged` on
   * its session and is answered by the exit hook, which survives a restart in a
   * way this map does not. Losing an entry costs one stale definition in a
   * config dir — visible, harmless, and removable by hand — which is the right
   * side to fail on when the alternative is deleting an entry that was never
   * ours.
   */
  private readonly pendingMcpBridges = new Map<string, McpLoginPlan>();

  /**
   * How the sign-in bridge runs `claude`. Injected in tests, exactly as `Mcp`
   * injects its probe and for the same rule: no suite ever spawns a real CLI.
   */
  mcpExec: Exec = realExec;

  /* ---------------------------------------------------------------- *
   * QA sessions
   * ---------------------------------------------------------------- */

  /**
   * The live QA session already reviewing a phase, if there is one.
   *
   * Keyed by `(slug, phase)` like a recovery's, and for a sharper reason: two
   * reviewers of one phase write the same report path and race each other's
   * `qa-record.sh` row, so the second one does not merely duplicate work — it
   * can overwrite a verdict nobody read.
   */
  liveQaFor(link: { slug?: string; phase?: number }): SessionInfo | undefined {
    const key = qaKey(link);
    return this.terminals.state().sessions.find((session) =>
      !session.exited && session.meta?.qa && qaKey(session.meta.qa) === key);
  }

  /**
   * What `GET /api/terminal` serves: the registry's state with each QA
   * reviewer's task list folded from the inbox its `PE_TASKS_FILE` names
   * (`foldInboxTasks`). The registry knows processes and never reads files;
   * the fold needs the open root, which is the service's to know — so the
   * door asks here rather than the registry, and a console with no root open
   * serves the state exactly as the registry holds it.
   */
  terminalState(): TerminalStateView {
    const state = this.terminals.state();
    return { ...state, sessions: foldInboxTasks(state.sessions, this.root?.ok ? this.root.path : undefined) };
  }

  /**
   * Turn "QA this phase" into the brief a reviewer can act on — or say why not.
   *
   * The browser names the phase; every fact in the brief is read here, from the
   * plan, the handoff, the repository's own history and the board. Same split
   * as a recovery, for the same two reasons: a page cannot dictate what a
   * session is told, and a brief cannot quote an exit criterion the plan does
   * not hold.
   *
   * Three refusals live here (the fourth, `--allow-agent`, is the route's, so
   * that a console without the flag never even resolves a brief):
   *
   *  1. **the autopilot is driving** — a review reads the working tree and runs
   *     the phase's tests, and both are meaningless while another session is
   *     editing underneath. Broader than "holds that phase" on purpose: the
   *     tree is shared, so a run on *any* phase invalidates the reading;
   *  2. **the phase is being built right now** — a recovery session on this
   *     exact phase is its author, and reviewing a moving target is not a
   *     review. This is the guard that keeps "independent" true;
   *  3. **a review is already running** for this `(slug, phase)`, whose id the
   *     refusal carries so the client can open it rather than only refuse.
   */
  async resolveQa(
    request: QaRequest,
  ): Promise<
    { ok: true; facts: QaFacts }
    | { ok: false; status: number; error: string; sessionId?: string }
  > {
    const refuse = (status: number, error: string, sessionId?: string) =>
      ({ ok: false as const, status, error, ...(sessionId ? { sessionId } : {}) });

    const root = this.root?.path;
    if (!root) return refuse(409, 'No source directory is open.');

    let record = this.store?.get(request.slug);
    if (!record) return refuse(404, `No plan named ${request.slug}.`);
    if (!record.plan?.graph.some((row) => row.phase === request.phase)) {
      return refuse(404, `${request.slug} has no phase ${request.phase}.`);
    }

    // Same reasoning as `resolveRecovery`: only a run whose scope overlaps the
    // phase under review actually threatens it. A review runs the phase's
    // tests in its tree, so an overlapping run is a genuine refusal — and a
    // disjoint one is not the console's business.
    const reviewing = this.scopeOf(request.slug, request.phase) ?? ['all'];
    for (const live of this.runStates()) {
      const overlapping = this.scheduler.granted(live.id)
        .filter((grant) => scopesIntersect(grant.scope, reviewing));
      if (!overlapping.length) continue;
      return refuse(409,
        `${live.slug} is mid-run (${live.status}) in ${formatScope(overlapping[0].scope)} — a review `
        + 'reads the working tree and runs the phase\'s tests, so pause or stop it first.');
    }

    const building = this.liveRecoveryFor({ slug: request.slug, phase: request.phase });
    if (building) {
      return refuse(409,
        `${request.slug} P${request.phase} is being worked on by a live session — a review of a `
        + 'phase still being changed is not a review. Wait for it to finish.',
        building.id);
    }

    const already = this.liveQaFor(request);
    if (already) {
      return refuse(409,
        `A QA session for ${request.slug} P${request.phase} is already running.`, already.id);
    }

    // A claim this console cannot see the session behind. `building` above only
    // knows about sessions THIS console started; a phase claimed from a
    // terminal, or by an agent in another Claude home, is invisible to it and
    // is exactly the case the lock file exists to cover.
    const handoffsDir = this.root?.handoffsDir;
    const claim = handoffsDir ? readLock(handoffsDir, request.slug, request.phase) : null;
    if (claim && !claim.expired) {
      return refuse(409,
        `${request.slug} P${request.phase} is claimed by ${claim.owner}`
        + (claim.host ? ` on ${claim.host}` : '')
        + ' — a review of a phase still being changed is not a review. Wait for that session, '
        + 'or release the claim.');
    }

    // Activation before the facts are read, so the brief reports the qa-mode
    // the session will actually be gated by rather than the one it replaced.
    if (request.activate) {
      const turned = await this.activateQa(request.slug, request.phase);
      if (!turned.ok) return refuse(409, turned.detail);
      record = this.store?.get(request.slug) ?? record;
    }

    const handoff = handoffFor(record, request.phase);
    const detail = record.plan?.phases[request.phase];
    // Which round this reviewer is, and therefore which report it must write —
    // from the ONE chooser, which is also what the engine, the warm chase and
    // both ladder rungs ask. This site had its own copy of that arithmetic for
    // three QA rounds and disagreed with the engine in a different way each
    // time; `test/qa-round.test.ts` now holds every caller to one answer.
    const recorded = qaFor(record, request.phase);
    const { round: qaRound, report: reportArg } = nextQaRound(record.handoffDir, request.phase);

    const [board, engineBrief, qaMode, commits, latestRun] = await Promise.all([
      this.board(request.slug),
      this.qaPrompt(request.slug, request.phase).catch(() => ''),
      // THIS phase's regime, not the plan's. A phase carrying `- **QA:** off`
      // under a plan-wide `on` was briefed "your verdict gates dependents" when
      // it gates nothing — and, worse, a phase carrying `- **QA:** on` under a
      // plan-wide `off` was told "nothing is gated on your verdict yet" and
      // that recording one would turn gating on, both false. The engine has
      // answered per phase since `qa_mode_for_phase` landed; only this caller
      // was still asking the plan-wide question.
      this.qaMode(request.slug, request.phase),
      handoff?.path ? commitsTouching(root, handoff.path, 5) : Promise.resolve([]),
      this.runFor(request.slug).catch(() => null),
    ]);

    const rows = record.plan?.graph ?? [];
    const previous = recorded;

    return {
      ok: true,
      facts: {
        slug: request.slug,
        phase: request.phase,
        scriptsDir: this.flags.scriptsDir,
        skillId: phasedExecutionSkillId(this.skills()),
        reportPath: `docs/handoffs/${request.slug}/${reportArg}`,
        reportArg,
        round: qaRound,
        qaMode: qaMode.mode,
        ...(titleOf(rows, request.phase) ? { phaseTitle: titleOf(rows, request.phase) } : {}),
        ...(engineBrief ? { engineBrief } : {}),
        ...(handoff
          ? {
            handoffPath: `docs/handoffs/${request.slug}/${handoff.file}`,
            handoffStatus: handoff.status,
            ...(handoff.keyFiles.length ? { keyFiles: handoff.keyFiles } : {}),
          }
          : {}),
        ...(commits.length ? { commits } : {}),
        ...(detail?.goal ? { goal: detail.goal } : {}),
        ...(detail?.exitCriteria ? { exitCriteria: detail.exitCriteria } : {}),
        ...(detail?.verification ? { verification: detail.verification } : {}),
        ...(record.plan?.sessionBudget.skills?.length
          ? { skills: record.plan.sessionBudget.skills } : {}),
        // A reviewer told nothing about the branch runs the suite on the wrong
        // tree; the brief names it when the plan's latest run is branched.
        ...(latestRun?.gitMode === 'new-branch'
          ? {
            gitStrategy: {
              branch: `pe/${request.slug}`,
              // Only a run that GOT a checkout, and only while the directory is
              // still there: `workRoot` is deleted when a settle removes the
              // tree, so a review of a finished isolated run reads the branch
              // rule and no path — which is right, because there is no path.
              ...(latestRun.checkout === 'worktree' && latestRun.workRoot
                ? { workRoot: latestRun.workRoot } : {}),
              ...(latestRun.checkout === 'worktree' && latestRun.workRoot
                && latestRun.mountedRepos?.length
                ? { mounts: latestRun.mountedRepos } : {}),
            },
          }
          : {}),
        board: rows.length
          ? rows.map((row) => ({
            phase: row.phase,
            state: board.states[row.phase] ?? 'unknown',
            ...(row.title ? { title: row.title } : {}),
          }))
          : Object.entries(board.states).map(([phase, state]) => ({ phase: Number(phase), state })),
        ...(previous && previous.result !== 'unknown'
          ? {
            previous: {
              result: previous.result,
              ...(previous.report ? { report: previous.report } : {}),
              ...(previous.round ? { round: previous.round } : {}),
            },
          }
          : {}),
      },
    };
  }

  /**
   * The snapshot a QA session is judged against, taken at mint time.
   *
   * Both halves matter: a re-review that lands the same verdict still writes a
   * new report, and without the report path that session would be reported as
   * having recorded nothing.
   */
  qaSnapshot(slug: string, phase: number): { before?: string; beforeReport?: string } {
    const record = this.store?.get(slug);
    const row = record ? qaFor(record, phase) : undefined;
    if (!row) return {};
    return {
      ...(row.result ? { before: row.result } : {}),
      ...(row.report && row.report !== '-' ? { beforeReport: row.report } : {}),
    };
  }

  /**
   * Turn QA on for a plan that has it off.
   *
   * This delegates to the skill's own `--qa` activation (`new-handoff.sh --qa`)
   * rather than writing `test-status.md` here, because activation is not one
   * row — it also **backfills every already-complete phase as `waived`**. Skip
   * that and gating turns on plan-wide, every finished phase reads "no QA
   * result", and their dependents flip ready → waiting: the board would break
   * as a side effect of asking for one review.
   *
   * ⚠️ The script exits **1** in the normal case here, and that is correct: it
   * writes `test-status.md` and *then* refuses to overwrite the phase's
   * existing handoff. Refusing is what protects the handoff, so the exit code
   * is not the verdict — the postcondition is, read back from the engine. A
   * server test pins this, so a future reordering of that script fails the
   * suite rather than silently doing nothing here.
   *
   * With no handoff to protect there is nothing to backfill either, so the
   * lighter `qa-record.sh <phase> pending` is used: it creates the file and
   * says, truthfully, that a review has been asked for and not yet answered.
   */
  async activateQa(slug: string, phase: number): Promise<{ ok: boolean; mode: string; detail: string }> {
    if (!this.flags.allowWrites) {
      return { ok: false, mode: 'off', detail: 'Writes are disabled. Restart with --allow-writes to enable them.' };
    }
    const record = this.store?.get(slug);
    if (!record || !this.root) return { ok: false, mode: 'off', detail: `No plan named ${slug}.` };

    const current = await this.qaMode(slug);
    if (current.mode !== 'off') {
      return { ok: true, mode: current.mode, detail: `QA is already ${current.mode} for ${slug}.` };
    }

    const handoff = handoffFor(record, phase);
    // `unknown` is a parse outcome, not a status the scripts accept — a handoff
    // whose frontmatter the parser could not read must not turn activation into
    // a validation error about a field nobody asked about.
    const status = handoff && handoff.status !== 'unknown' ? handoff.status : 'complete';
    const request = handoff
      ? { action: 'new-handoff' as const, slug, phase, title: handoff.title, status, qa: true }
      // A `pending` row is roundless, so round 1's plain name is the right
      // one here — but it still comes from the chooser rather than a literal,
      // because a literal is exactly how five other sites drifted apart.
      : { action: 'qa-record' as const, slug, phase, result: 'pending', report: qaReportPath(phase) };

    let outcome;
    try {
      outcome = await runWrite(
        planWrite(request, { root: this.root.path, docsDir: this.root.docsDir }),
        { scriptsDir: this.flags.scriptsDir, root: this.root.path },
      );
    } catch (error) {
      // A handoff whose title the write layer will not accept is a reason QA
      // could not be turned on, not a 500 — say which and let the operator use
      // the write menu, where the field is editable.
      return { ok: false, mode: 'off', detail: `Could not turn QA on: ${(error as Error).message}` };
    }

    // Read the postcondition rather than the exit code — see the note above.
    this.reread(slug);
    const mode = (await this.qaMode(slug)).mode;
    const ok = mode !== 'off';
    log.info('qa.activate', { slug, phase, ok, mode, code: outcome.code });
    if (ok) this.invalidateAll();
    return {
      ok,
      mode,
      detail: ok
        ? `QA is now ${mode} for ${slug} — earlier completed phases were recorded as waived.`
        : (outcome.stderr || outcome.stdout).trim() || 'The activation did not turn QA on.',
    };
  }

  /**
   * The text of one QA report — `GET /api/plans/:slug/qa-report/:phase?round=N`.
   *
   * Every surface showed the report as a PATH and nothing served the file
   * (`docs/handoffs/<slug>/reports/` was reachable by no route), so the one
   * document a QA verdict rests on could be read only in an editor. This reads
   * ONLY `join(record.handoffDir, qaReportPath(phase, round))` — the shape the
   * one chooser mints — and refuses anything that resolves outside the handoff
   * folder with the same containment check `openInEditor` keeps. No round
   * means the latest the ledger records (round 1 when it records none).
   */
  qaReport(slug: string, phase: number, round?: number): { path: string; round: number; text: string } | null {
    const record = this.store?.get(slug);
    if (!record?.handoffDir) return null;
    if (!Number.isInteger(phase) || phase < 1 || phase > 999) return null;
    let which = round;
    if (which == null) {
      let ledger = '';
      try { ledger = readFileSync(join(record.handoffDir, 'test-status.md'), 'utf8'); } catch { ledger = ''; }
      which = Math.max(1, highestQaRound(ledger, phase));
    }
    if (!Number.isInteger(which) || which < 1 || which > 999_999) return null;
    const path = qaReportPath(phase, which);
    const file = join(record.handoffDir, path);
    if (!insideDir(record.handoffDir, file)) return null;
    try {
      return { path, round: which, text: readFileSync(file, 'utf8') };
    } catch {
      return null;
    }
  }

  /**
   * The plan's QA gate, moved from a live run's settings sheet (control-tower
   * phase 13, #31). It was start-only beside three live QA fields — a reviewer
   * an operator could tune and not switch on — for a reason that was a side
   * effect rather than an impossibility: turning it on writes `test-status.md`.
   *
   * On needs the person's `QA_CONFIRM` (the sheet says what it writes before
   * it posts) and `--allow-writes`; it creates the ledger the way the launch
   * box does (`activateQa`, finished phases backfilled `waived`) and then
   * writes the plan's QA-gate line `on`, because a plan whose line says `off`
   * reads a fresh ledger as `waived`. `new-handoff --qa` records the phase it
   * is handed as OWING a review — right at a phase-finish, wrong for a phase
   * that finished before the gate existed, whose dependents a `pending` row
   * would hold — so a finished anchor is waived with that reason, through
   * the one waiver door. Off writes the line `off`. A move to where the gate
   * already is writes nothing. The answer names the regime before and after,
   * in the engine's words.
   */
  async setRunQa(
    slug: string, on: boolean, opts: { confirm?: unknown; by?: string } = {},
  ): Promise<{ ok: true; from: string; to: string } | { ok: false; why: string }> {
    const from = (await this.qaMode(slug)).mode;
    if (on ? from === 'on' : from !== 'on') return { ok: true, from, to: from };
    if (on && opts.confirm !== QA_CONFIRM) {
      return {
        ok: false,
        why: 'turning QA on creates test-status.md and holds each dependent on its phase\'s verdict — '
          + `send confirm: "${QA_CONFIRM}" to go ahead`,
      };
    }
    if (!this.flags.allowWrites) {
      return { ok: false, why: 'the QA gate is written into the plan, and writes are disabled — restart the console with --allow-writes' };
    }
    let finished: number | null = null;
    if (on && from === 'off') {
      const record = this.store?.get(slug);
      if (!record) return { ok: false, why: `No plan named ${slug}.` };
      const anchor = qaAnchorPhase(record);
      const turned = await this.activateQa(slug, anchor);
      if (!turned.ok) return { ok: false, why: turned.detail };
      if (handoffFor(record, anchor)?.status === 'complete') finished = anchor;
    }
    if (!on || (await this.qaMode(slug)).mode !== 'on') {
      const set = await this.setQaMode(slug, { mode: on ? 'on' : 'off' });
      if (!set.ok) return { ok: false, why: set.detail };
    }
    if (finished != null && (await this.qaVerdict(slug, finished)) === 'pending') {
      const waived = await this.qaWaive(slug, finished, {
        reason: 'finished before QA was turned on mid-run', ...(opts.by ? { by: opts.by } : {}),
      });
      if (!waived.ok) return { ok: false, why: waived.detail };
    }
    return { ok: true, from, to: (await this.qaMode(slug)).mode };
  }

  /**
   * Switch the QA regime from the console — for the plan, or for ONE phase.
   *
   * `activateQa` above can only turn the gate on. The plan file has carried
   * both switches for as long as the engine has read them; what was missing
   * was a writer, so "turn QA off for this plan" and "exempt this phase" were
   * hand edits the inbox described in prose. `scripts/qa-mode.sh` is that
   * writer, and this is its door: the postcondition is read back from the
   * engine rather than trusted from the exit code, the same rule activation
   * keeps — and note the engine's own words come back, not the directive's:
   * writing `off` to a plan whose ledger exists reads as `waived`.
   *
   * Every cache that holds a regime is dropped by `reread` (`forget` clears
   * the per-phase `qaModes` entries too), and `invalidateAll` re-derives the
   * board-shaped views, because a directive moves which verdicts hold whom.
   */
  async setQaMode(
    slug: string,
    request: { mode: QaDirective; phase?: number },
  ): Promise<QaModeSetOutcome> {
    if (!this.flags.allowWrites) {
      return { ok: false, detail: 'Writes are disabled. Restart with --allow-writes to enable them.' };
    }
    const record = this.store?.get(slug);
    if (!record || !this.root) return { ok: false, detail: `No plan named ${slug}.` };
    const phase = request.phase;

    let outcome;
    try {
      outcome = await runWrite(
        planWrite({ action: 'qa-mode', slug, mode: request.mode, ...(phase != null ? { phase } : {}) },
          { root: this.root.path, docsDir: this.root.docsDir }),
        { scriptsDir: this.flags.scriptsDir, root: this.root.path },
      );
    } catch (error) {
      return { ok: false, detail: `Could not set the QA regime: ${(error as Error).message}` };
    }

    this.reread(slug);
    const plan = await this.qaMode(slug);
    const regime = phase != null ? await this.qaMode(slug, phase) : undefined;
    const ok = outcome.ok;
    log.info('qa.mode', { slug, phase, directive: request.mode, ok, code: outcome.code, plan: plan.mode, regime: regime?.mode });
    if (ok) {
      this.invalidateAll();
      // On the live run's record too, so a verdict that starts (or stops)
      // holding dependents mid-run has its reason in the journal.
      this.runners.get(slug)?.note('phase.qa-mode',
        { directive: request.mode, ...(phase != null ? { phase } : {}), plan: plan.mode, ...(regime ? { regime: regime.mode } : {}) },
        phase);
    }
    const where = phase != null ? `phase ${phase} of ${slug}` : slug;
    const said = (regime ?? plan).mode + ((regime ?? plan).reason ? ` (${(regime ?? plan).reason})` : '');
    return {
      ok,
      plan,
      ...(phase != null && regime ? { phase: { phase, regime } } : {}),
      detail: ok
        ? `QA now reads ${said} for ${where}.`
        : (outcome.stderr || outcome.stdout).trim() || 'The QA regime did not change.',
    };
  }

  /**
   * What the QA session recorded, read back rather than assumed.
   *
   * "The session ended" is not an outcome — every session ends. The question a
   * review is opened to answer is whether a verdict now exists, and the only
   * evidence for that is `test-status.md` having changed for this phase. A
   * session that argues convincingly in its final message and never runs
   * `qa-record.sh` has produced nothing the engine can gate on, and this says
   * so in those words.
   */
  async qaOutcome(link: {
    slug: string; phase: number; before?: string; beforeReport?: string;
  }): Promise<QaOutcome> {
    const { slug, phase } = link;
    if (!this.root) {
      return { recorded: false, headline: `QA for ${slug} P${phase} finished`, detail: 'Nothing to check it against.' };
    }

    // The watcher is debounced and every engine answer is cached by revision,
    // so the session's last commit would otherwise be judged against the table
    // as it stood before the review — P4's `reread` exists for exactly this.
    this.reread(slug);

    const record = this.store?.get(slug);
    const row = record ? qaFor(record, phase) : undefined;
    const result = row?.result;
    const report = row?.report && row.report !== '-' ? row.report : undefined;

    const moved = result !== link.before || report !== link.beforeReport;
    if (isVerdict(result) && moved) {
      return {
        recorded: true,
        result,
        ...(report ? { report } : {}),
        headline: `${slug} P${phase} recorded ${result}`,
        detail: result === 'fail'
          ? `The review recorded FAIL — every dependent of P${phase} stays gated until it is fixed `
            + `and re-reviewed.${report ? ` Report: ${report}` : ''}`
          : `The review recorded ${result}.${report ? ` Report: ${report}` : ''}`,
      };
    }

    return {
      recorded: false,
      ...(result && result !== 'unknown' ? { result } : {}),
      headline: `${slug} P${phase} — no verdict recorded`,
      detail: isVerdict(result)
        ? `test-status.md still reads ${result}, exactly as it did before the session started — `
          + 'nothing new was recorded. Open the session and see what it concluded.'
        : 'The session ended without running qa-record.sh, so the phase has no QA verdict. '
          + 'Open the session and see how far it got.',
    };
  }

  /* ---- signing in ---- */

  /**
   * Free, non-interactive, and about a second — cheap enough to poll.
   *
   * REDACTED on the way to the browser: `parseAuth` now keeps `orgId` and
   * `configDirectory` (the breaker's key and the probe's proof), and neither
   * belongs in a page — the id is hashed to the same eight hex the accounts
   * view shows, the `$HOME`-rooted directory is dropped (ACT-12's second gap).
   */
  async authStatus(force = false): Promise<AuthStatus> {
    const { configDirectory: _dir, orgId, ...status } = await checkAuth(this.root?.path ?? process.cwd(), force);
    void _dir;
    return { ...status, ...(orgId ? { orgId: hashedOrgId(orgId) } : {}) };
  }

  /**
   * Open a real terminal on `claude auth login`.
   *
   * The OAuth flow needs a TTY and a browser, so a web page cannot host it. It
   * can, however, remove every step between reading "authentication failed" and
   * being signed in, which is the actual complaint.
   */
  async startLogin(): Promise<{ opened: boolean; command: string; detail?: string }> {
    if (!this.flags.allowRun) throw new Error('Runs are disabled. Restart with --allow-run to enable them.');
    const result = openLoginTerminal(this.root?.path ?? process.cwd());
    forgetAuth();
    return result;
  }

  /* ---- accounts ---- */

  /** Redacted views, always readable — the meters are display, not capability. */
  listAccounts(): Promise<AccountView[]> {
    return this.accounts.list();
  }

  /** The registrations this console removed that the learned store still remembers — display, like the list. */
  accountTombstones(): TombstoneView[] {
    return this.accounts.tombstones();
  }

  /**
   * A person asked whether an account may run work: one declared one-turn
   * session under it (`Accounts.probeEntitlement`, zero-touch-console phase
   * 15). Registration-class like the clearance beside it — its answer can
   * RETIRE an organisation for every future run on the machine — so it rides
   * `--allow-accounts`.
   *
   * The door is the press (`pressActor`): a person asked, so the per-instance
   * start ceiling never refuses it and never counts the start. What the
   * session SPENT still reaches the ceiling's dollars, like every session's.
   */
  async probeAccountEntitlement(id: string, actor: Actor): Promise<EntitlementProbeResult | undefined> {
    this.assertAccountsAllowed();
    if (!this.accounts.has(id)) return undefined;
    const result = await this.accounts.probeEntitlement(id, {
      actor: { ...pressActor(actor), trigger: 'entitlement-probe' },
    });
    if (result?.probe.costUsd) this.startCeiling.spendUsd(result.probe.costUsd);
    return result;
  }

  async addTokenAccount(name: string, token: string): Promise<AccountView> {
    this.assertAccountsAllowed();
    return this.accounts.addToken(name, token);
  }

  /**
   * Replace a token account's credential, keeping its id (control-tower phase
   * 13, #33) — `PUT /api/accounts/:id/credential`. The same registration-class
   * gate as adding one: it decides whose money a run may spend.
   */
  async replaceTokenAccount(id: string, token: string): Promise<AccountView | undefined> {
    this.assertAccountsAllowed();
    return this.accounts.replaceToken(id, token);
  }

  async removeAccount(id: string): Promise<boolean> {
    this.assertAccountsAllowed();
    // Refuse while a LIVE run pays as this account: its very next spawn would
    // silently land on the machine login — the quiet-wrong the accounts seam
    // exists to prevent. Stored/paused runs already degrade safely (an absent
    // env means the machine login, by design).
    for (const [slug, runner] of this.runners) {
      const state = runner.busy() ? runner.current() : null;
      if (state && (state.accountId ?? DEFAULT_ACCOUNT_ID) === id) {
        throw new AccountInUseError(`${slug} is running as this account — pause it, or switch its account first.`);
      }
    }
    // …and refuse while any LIVE SESSION on this machine is signed into the
    // profile's config directory (#22). `remove` does not merely forget a row:
    // it deletes that directory, and the session holding it would lose its
    // transcripts, its settings and its login mid-phase — measured three
    // minutes from happening on 2026-09-21. The registry knows the live pids
    // and each one's `CLAUDE_CONFIG_DIR`, so the answer is one read away.
    const signedIn = this.sessionsSignedInto(id);
    if (signedIn.length) {
      throw new AccountInUseError(
        `${signedIn.length} live session${signedIn.length === 1 ? ' is' : 's are'} signed into this `
        + `account (${signedIn.join(', ')}) — removing it deletes the config directory they are `
        + 'using. Let them end, or stop them, and try again.',
      );
    }
    return this.accounts.remove(id);
  }

  /**
   * The live sessions whose `CLAUDE_CONFIG_DIR` is this account's own directory.
   *
   * Only a `profile` account has one — a token's session reads `~/.claude` like
   * the machine login's does, which is why `sessionsByAccount` leaves tokens
   * out too — and a session carrying an env credential is not signed into the
   * DIRECTORY whatever its cwd says (`SessionView.authEnv`, the same precedence
   * that function uses).
   */
  private sessionsSignedInto(id: string): string[] {
    if (this.accounts.meta(id)?.kind !== 'profile') return [];
    const lexical = (dir: string): string => resolvePath(dir).replace(/\/+$/, '') || '/';
    const target = lexical(profileConfigDir(id, this.accounts.dir));
    let views: SessionView[] = [];
    try { views = this.sessionViews(); } catch { return []; }
    return views
      .filter((view) => view.presence === 'live' && !view.probe && !view.authEnv
        && view.configDir && lexical(view.configDir) === target)
      .map((view) => view.sessionId);
  }

  /**
   * "Use credits past plan limits" for one account (control-tower phase 93,
   * #146; operator decision 12) — verified against the account's own credit
   * state when switched on, refused with the reason when it is not there.
   * The same registration-class gate as a rename: it decides whose money a
   * run may spend.
   */
  async setAccountOverage(
    id: string, allowed: boolean, capUsd: number | null | undefined,
  ): Promise<{ ok: true; account: AccountView | undefined } | { ok: false; reason: string }> {
    this.assertAccountsAllowed();
    const result = this.accounts.setOverage(id, allowed, { capUsd, by: 'operator' });
    if (!result.ok) return result;
    // Allowed and confirmed: the brake a plan window put on it is lifted now,
    // not at the next warning (the rules read the carry from here on).
    if (result.credits.carrying) this.scheduler.releaseBrake(id === DEFAULT_ACCOUNT_ID ? undefined : id);
    return { ok: true, account: (await this.accounts.list()).find((view) => view.id === id) };
  }

  /** Display-name only — ids are journal keys, path segments and keychain hashes. */
  async renameAccount(id: string, name: string): Promise<AccountView | undefined> {
    this.assertAccountsAllowed();
    return this.accounts.rename(id, name);
  }

  /**
   * Put a login in front of the operator for a profile account.
   *
   * Two shapes, tried in order. The embedded terminal (a pty running exactly
   * `claude auth login` under the profile's `CLAUDE_CONFIG_DIR`) is the flow
   * that completes itself — its exit triggers `completeLogin`. When there is
   * no pty to be had (node-pty missing, headless), the same command is opened
   * in Terminal.app or handed back for the operator to paste; `completeLogin`
   * then runs on the next accounts read instead of on an exit event.
   */
  async beginAccountLogin(options: { accountId?: string; name?: string; confirm?: unknown }): Promise<{
    accountId: string;
    command: string;
    mode: 'embedded' | 'external' | 'command' | 'replace-token' | 'warn';
    terminal?: { sessionId: string; token: string; expiresAt: number };
    detail?: string;
    /** `warn` only: what a re-login would do, and the live runs it would end. */
    warning?: string;
    runs?: string[];
  }> {
    this.assertAccountsAllowed();
    let accountId = options.accountId;
    // Every kind has a way back now (control-tower phase 13, #33). A TOKEN is
    // not signed in — its credential is replaced, keeping its id — so the door
    // answers with that verb and the command that mints the new token.
    const meta = accountId ? this.accounts.meta(accountId) : undefined;
    if (accountId && !meta) throw new Error('No such account.');
    if (accountId && meta?.kind === 'token') {
      return { accountId, command: 'claude setup-token', mode: 'replace-token' };
    }
    // The MACHINE login signs in with the CLI's own `claude auth login` and no
    // CLAUDE_CONFIG_DIR — the CLI logging itself in is not a second writer of
    // its store. A re-login that changes its identity ends every session on it
    // (#131), so while a live run pays as it the door WARNS first, naming the
    // runs and the identity they are bound to (phase 91), and runs nothing
    // until the person answers with `RELOGIN_CONFIRM`.
    const machine = accountId === DEFAULT_ACCOUNT_ID;
    if (machine && options.confirm !== RELOGIN_CONFIRM) {
      const paying = this.payingAs(DEFAULT_ACCOUNT_ID);
      if (paying.length) {
        const bound = paying
          .map(({ slug }) => this.runners.get(slug)?.current()?.identity)
          .find((identity) => identity?.account === DEFAULT_ACCOUNT_ID);
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          command: 'claude auth login',
          mode: 'warn',
          runs: paying.map(({ slug }) => slug),
          warning: `${paying.map(({ slug }) => slug).join(', ')} ${paying.length === 1 ? 'is' : 'are'} running on the machine login`
            + `${bound?.email ? `, bound to ${bound.email}` : ''}. Signing it in again as anyone else ends `
            + `${paying.length === 1 ? 'that run\'s sessions' : 'their sessions'}, and the run parks until you say `
            + 'which login it continues on. Stop or switch those runs first, or go ahead knowing that.',
        };
      }
    }
    if (!accountId) accountId = this.accounts.beginProfile(options.name).id;
    const dir = machine ? null : profileConfigDir(accountId);
    const command = dir ? `CLAUDE_CONFIG_DIR=${shellQuote(dir)} claude auth login` : 'claude auth login';

    const minted = await this.terminals.mint(undefined, undefined, {
      kind: 'claude',
      file: 'claude',
      args: ['auth', 'login'],
      label: `Sign in — ${this.accounts.labelFor(accountId)}`,
      // `undefined` DELETES an inherited value (`{...process.env, ...env}`):
      // a console started under a profile must not sign that profile in when
      // the operator asked for the machine's own login.
      env: { CLAUDE_CONFIG_DIR: dir ?? undefined },
      meta: { intent: 'login', accountId },
    });
    if (minted.ok) {
      return {
        accountId,
        command,
        mode: 'embedded',
        terminal: { sessionId: minted.sessionId, token: minted.token, expiresAt: minted.expiresAt },
      };
    }

    const external = openCommandTerminal(command);
    const detail = external.detail ?? minted.error;
    return {
      accountId,
      command,
      mode: external.opened ? 'external' : 'command',
      ...(detail ? { detail } : {}),
    };
  }

  /** A profile the operator signed in outside the exit hook — re-read it. */
  /**
   * Re-read one account — its login state AND its meters — and answer with
   * what came back.
   *
   * It used to `kick` the poller and then read the cache, which the poll had
   * not replaced yet: the button answered 200 with the same numbers it was
   * pressed to replace, so refreshing appeared to do nothing at all. The fix
   * is to AWAIT the poll (`accounts.refreshUsage`) before building the view.
   */
  async refreshAccount(id: string): Promise<AccountView | undefined> {
    const meta = this.accounts.meta(id);
    if (!meta) return undefined;
    // A profile re-probes its login first — a signed-out profile has no
    // credential to ask the usage endpoint with, and saying "signed out" is
    // more useful than a meter that failed for an unexplained reason.
    if (meta.kind === 'profile') await this.accounts.completeLogin(id);
    await this.accounts.refreshUsage(id);
    const views = await this.accounts.list();
    return views.find((v) => v.id === id);
  }

  /** Every account at once — what a panel's "Refresh" asks for. */
  async refreshAllAccounts(): Promise<AccountView[]> {
    await this.accounts.refreshAllUsage();
    return this.accounts.list();
  }

  /* ---- the desktop launcher ---- */

  /** Where a one-click launcher would land on THIS platform, and whether it can. */
  launcherPlan() {
    return {
      ...launcherPlan({ instanceName: INSTANCE.name, isDefault: INSTANCE.default }),
      rootOpen: Boolean(this.root?.ok),
      ...(this.root?.ok ? { root: this.root.path } : {}),
      fullFlags: FULL_FLAGS,
    };
  }

  /** Write the desktop artifact named for THIS console, every switch on. */
  createDesktopLauncher(): { ok: true; path: string; note: string } {
    // No open root needed, and none of this console's settings passed (launcher
    // rev 12): the macOS file bakes in no root, port or login — it picks its
    // console when it runs and reads the rest from the registry — the Linux
    // entry names this console by id, and remote access is the machine
    // profile's, read by every console at boot.
    return installDesktopLauncher({
      instanceId: INSTANCE.id,
      instanceName: INSTANCE.name,
      isDefault: INSTANCE.default,
    });
  }

  private assertAccountsAllowed(): void {
    if (!this.flags.allowAccounts) {
      throw new Error('Account registration is disabled. Restart with --allow-accounts to enable it.');
    }
  }

  /**
   * The pre-flight quota gate — a VERDICT, never an exception (ACT-2). It used
   * to throw, and on the nine automatic doors the throw was caught into a
   * `log.warn` and nothing else: a recovery convergence had judged fixed was
   * abandoned at this door with no journal line, no errand and no
   * notification. Now the runner asks it (`RunnerDeps.accountHeadroom`) beside
   * the auth door, climbs `rankAccounts` on a refusal and parks with one
   * errand when nothing has headroom.
   *
   * The reading is the facade's `headroom`: the breaker (a retired credential
   * is refused by name), the machine-wide walls, and `liveBuckets` — a meter
   * past its reset or its staleness bound is not evidence, which is the rule
   * this door used to break by reading the raw snapshot. A busy window on the
   * way up is announced here, as before.
   */
  protected preflightAccount(accountId: string | undefined, forModel?: string): HeadroomVerdict {
    const verdict = this.accounts.headroom(accountId, forModel);
    if (verdict.ok && verdict.warn) {
      this.announce('limits', {
        title: 'Starting against a busy window',
        body: `${this.accounts.labelFor(accountId)} is at ${Math.round(verdict.warn.pct)}% of its 5-hour window `
          + `(resets ${new Date(verdict.warn.resetsAt).toLocaleString()}).`,
        tag: tagFor('limits', 'preflight', accountId ?? 'default', verdict.warn.resetsAt),
      });
    }
    return verdict;
  }

  /**
   * How many registered accounts this console cannot spend under, out of how
   * many it has. Read from the breaker through the quota door, so it answers
   * the same question boarding does — "would a run be refused on this?" —
   * rather than a second, parallel opinion about the same accounts.
   */
  protected accountsUsable(): { unusable: number; total: number } {
    const ids = this.accounts.accountIds();
    const unusable = ids.filter((id: string) => !this.accounts.headroom(id).ok).length;
    return { unusable, total: ids.length };
  }

  /**
   * The operator's clearance of a retired account — the one transition out of
   * `retired`, for the credential and its organisation. A registration-class
   * act (it widens what every future run may spend), so it rides the same
   * `--allow-accounts` gate as add/remove.
   */
  async clearRetiredAccount(id: string, actor: Actor): Promise<AccountView | undefined> {
    this.assertAccountsAllowed();
    if (!this.accounts.has(id)) return undefined;
    const cleared = this.accounts.clearRetired(id, 'operator');
    log.info('accounts.retired.clear-requested', { account: id, cleared, ...actor });
    // The clearance lifted the retirement's scheduler hold with it: an entry
    // queued on that hold admits on this scan, not when the hold's timer fires.
    if (cleared) this.scheduler.poll();
    const views = await this.accounts.list();
    return views.find((view) => view.id === id);
  }

  /**
   * The accounts stream, debounced: a poller sweep touches every account in a
   * burst, and one event carrying the whole list is what the header wants.
   */
  /* ---------------- MCP servers ---------------- */

  /** The registry, already redacted by the facade. Never gated — this is display. */
  async listMcp(): Promise<McpServerView[]> {
    // A person is reading the health answer, so the clock keeps its pace (#73).
    // Only here and at Refresh: the clock's own announcement lists too.
    this.mcp.consumed();
    return this.mcp.list();
  }

  /**
   * Registering a server is a credential-holding, supply-chain-widening act, so
   * it is behind its own flag — and refused HERE as well as at the route, because
   * the route guard is not the only wall (see `assertAccountsAllowed`).
   */
  assertMcpAllowed(): void {
    if (!this.flags.allowMcp) {
      throw new Error('MCP registration is disabled. Restart with --allow-mcp to enable it.');
    }
  }

  /**
   * Re-probe, then tell every browser. A registry change also invalidates the
   * engine cache: F15's verdict is a function of what is registered, so a plan
   * that linted clean a moment ago may not now.
   */
  async refreshMcp(force = false): Promise<McpServerView[]> {
    this.mcp.consumed();
    await this.mcp.refresh({ force, ...(this.root ? { cwd: this.root.path } : {}) });
    invalidate();
    const servers = await this.mcp.list();
    // A sign-in with no pty had no exit to hook, so this is where its bridged
    // definition goes back: the server answering `connected` is the evidence
    // the flow finished, and it is the only evidence this shape ever gets.
    // Fire-and-forget — a registry entry we failed to remove must not turn a
    // read of the server list into an error.
    for (const server of servers) {
      if (server.status !== 'connected' || !this.pendingMcpBridges.has(server.id)) continue;
      void this.releaseMcpBridge(server.id)
        .catch((error) => log.warn('mcp.login.release-failed', { server: server.id, error }));
    }
    return servers;
  }

  /**
   * Register a server from a browser payload.
   *
   * Validation lives in the facade (`Mcp.add`) rather than here or in the
   * route: it is the layer that knows the registry, and a URL that carries its
   * own credential must be refused whoever asks. This is the shape-narrowing
   * step — turning `unknown` from the wire into the facade's argument.
   */
  async addMcpServer(body: Record<string, unknown>): Promise<McpServerView> {
    this.assertMcpAllowed();
    const strings = (value: unknown): string[] | undefined =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;
    const record = (value: unknown): Record<string, string> | undefined => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const out: Record<string, string> = {};
      for (const [key, item] of Object.entries(value)) if (typeof item === 'string') out[key] = item;
      return out;
    };
    const server = await this.mcp.add({
      ...(typeof body.id === 'string' ? { id: body.id } : {}),
      label: typeof body.label === 'string' ? body.label : '',
      transport: typeof body.transport === 'string' ? body.transport : '',
      ...(typeof body.url === 'string' ? { url: body.url } : {}),
      ...(typeof body.command === 'string' ? { command: body.command } : {}),
      ...(strings(body.args) ? { args: strings(body.args)! } : {}),
      ...(record(body.env) ? { env: record(body.env)! } : {}),
      ...(record(body.headers) ? { headers: record(body.headers)! } : {}),
      ...(Array.isArray(body.secretRefs) ? { secretRefs: body.secretRefs as never } : {}),
      ...(record(body.secrets) ? { secrets: record(body.secrets)! } : {}),
      ...(body.alwaysLoad === true ? { alwaysLoad: true } : {}),
      ...(typeof body.timeoutMs === 'number' ? { timeoutMs: body.timeoutMs } : {}),
      source: body.source === 'catalog' ? 'catalog' : 'manual',
    });
    // A new server can only be reachable or not; find out rather than showing
    // `unknown` until something else happens to probe.
    void this.refreshMcp(true).catch((error) => log.warn('mcp.refresh-failed', { error }));
    return server;
  }

  /** Rename, enable/disable, or replace a secret. One verb per call. */
  async patchMcpServer(id: string, body: Record<string, unknown>): Promise<McpServerView | undefined> {
    this.assertMcpAllowed();
    if (typeof body.enabled === 'boolean') {
      if (!this.mcp.setEnabled(id, body.enabled)) return undefined;
      // Switching a server OFF is an answer to the phases parked on it, and it
      // used to be treated as unrelated. The operator has said this run does
      // not get that server; the run should stop waiting to be told again.
      if (!body.enabled) void this.healMcpParks(id);
    }
    if (typeof body.secret === 'string' && body.secretRef && typeof body.secretRef === 'object') {
      await this.mcp.setSecret(id, body.secretRef as never, body.secret);
    }
    if (typeof body.label === 'string') return this.mcp.rename(id, body.label);
    return (await this.mcp.list()).find((server) => server.id === id);
  }

  async removeMcpServer(id: string): Promise<boolean> {
    this.assertMcpAllowed();
    const removed = await this.mcp.remove(id);
    // Same reasoning as disabling, more so: the thing the phase was waiting for
    // no longer exists on this console, so waiting is the one wrong answer.
    if (removed) void this.healMcpParks(id);
    return removed;
  }

  /**
   * Start `claude mcp login <name>` where a person can answer it.
   *
   * The same multi-modal shape as an account login, and for the same reason:
   * OAuth needs a browser and a paste-back, which is a terminal's job. The
   * console never sees the resulting token — `claude mcp login` writes it into
   * the CLI's own store, which is the one credential store we never touch.
   *
   * What it does now that it did not is make the name RESOLVE. `mcp login`
   * takes a name and no config flag, so for a server only this console knew
   * about it answered `No MCP server named "<id>"` and listed the CLI's own
   * servers — a button that could never work (issue #8). `mcp/login.ts` bridges
   * the definition into the config dir the flow runs in, and the exit hook
   * takes it away again. Everything about WHY lives there; this method is the
   * three decisions the service owns: which config dir, whether a terminal may
   * open at all, and what the card is told when it may not.
   */
  async beginMcpLogin(id: string, options: { accountId?: string } = {}): Promise<{
    id: string;
    command: string;
    mode: 'embedded' | 'external' | 'command';
    terminal?: { sessionId: string; token: string; expiresAt: number };
    detail?: string;
    /** Where the token will land, so the card can say it out loud. */
    configDir?: string;
    accountLabel?: string;
    /** Set only when no flow could start: the commands that would work by hand. */
    commands?: string[];
  }> {
    this.assertMcpAllowed();
    const meta = this.mcp.meta(id);
    if (!meta) throw new Error(`no MCP server called ${id}`);

    // Which config dir the token must land in. The default is the console's
    // own, because that is the one the health probe reads (`health.ts` spawns
    // under `process.env`) and a sign-in the probe cannot see would report
    // `connected` to nobody. Naming a profile account is how an operator signs
    // a server in for the identity their RUNS spend, which is the second hole
    // issue #8 describes — and it stays an explicit choice rather than a guess,
    // since the account a run uses is resolved per run and not console-wide.
    const target: McpLoginTarget = { configDir: consoleConfigDir() };
    if (options.accountId) {
      const account = this.accounts.meta(options.accountId);
      if (!account) throw new Error(`no account called ${options.accountId}`);
      if (account.kind !== 'profile') {
        throw new Error('Only a profile account has a config dir of its own to sign a server into.');
      }
      target.configDir = profileConfigDir(account.id);
      target.accountLabel = this.accounts.labelFor(account.id);
    }

    const plan = planMcpLogin(meta, target);
    // No path exists. Say which commands would, and open nothing — a second
    // button that prints somebody else's server list is the bug, not the fix.
    if (isLoginBlock(plan)) {
      return {
        id,
        command: plan.commands.join(' && '),
        mode: 'command',
        detail: plan.reason,
        commands: plan.commands,
        ...(target.configDir ? { configDir: target.configDir } : {}),
      };
    }

    // Bridge BEFORE minting: a terminal opened over a registry the CLI would
    // not take is the issue-8 failure again, one step later.
    const bridged = await bridgeDefinition(plan, this.mcpExec);
    if (!bridged.ok) {
      return {
        id,
        command: plan.command,
        mode: 'command',
        detail:
          'The Claude CLI would not register this server, so the sign-in cannot start here. '
          + `Run these by hand and press Re-check: ${bridged.detail}`,
        commands: [plan.command],
        ...(plan.configDir ? { configDir: plan.configDir } : {}),
        ...(plan.accountLabel ? { accountLabel: plan.accountLabel } : {}),
      };
    }

    const env = loginEnv(plan);
    const minted = await this.terminals.mint(undefined, undefined, {
      kind: 'claude',
      file: 'claude',
      args: plan.login,
      label: `Sign in — ${meta.label ?? id}`,
      ...(env ? { env } : {}),
      // `mcpBridged` is what the exit hook reads to decide whether the registry
      // entry is ours to take away. Carried on the session rather than held in
      // memory here because the console may be restarted between the mint and
      // the exit, and an entry nobody remembers writing is one nobody removes.
      meta: {
        intent: 'login',
        mcpServer: id,
        ...(bridged.wrote ? { mcpBridged: true } : {}),
        ...(plan.configDir ? { mcpConfigDir: plan.configDir } : {}),
      },
    });
    if (minted.ok) {
      return {
        id,
        command: plan.loginCommand,
        mode: 'embedded',
        terminal: { sessionId: minted.sessionId, token: minted.token, expiresAt: minted.expiresAt },
        ...(plan.configDir ? { configDir: plan.configDir } : {}),
        ...(plan.accountLabel ? { accountLabel: plan.accountLabel } : {}),
      };
    }

    // No pty. The operator finishes it in a terminal of their own, so the
    // command they are handed has to carry the config dir — and the definition
    // has to survive until they have used it. There is no exit to hook, so the
    // release happens on the next refresh that finds the server connected,
    // which is the same shape the account login degrades to.
    const external = openCommandTerminal(plan.loginCommand);
    const detail = external.detail ?? minted.error;
    if (bridged.wrote) this.pendingMcpBridges.set(id, plan);
    return {
      id,
      command: plan.loginCommand,
      mode: external.opened ? 'external' : 'command',
      ...(detail ? { detail } : {}),
      ...(plan.configDir ? { configDir: plan.configDir } : {}),
      ...(plan.accountLabel ? { accountLabel: plan.accountLabel } : {}),
    };
  }

  /**
   * Take back a definition this console wrote so a sign-in could resolve.
   *
   * Two callers, one per shape the flow can take: the login session's exit hook
   * (which reads `mcpBridged` off the session, so it works across a restart),
   * and `refreshMcp` for a no-pty flow that has no exit to hook. Idempotent.
   *
   * **The "did we write it?" test lives in the CALLERS, not here.** This method
   * removes what it is asked to remove; it is the exit hook's `mcpBridged` and
   * `refreshMcp`'s `pendingMcpBridges.has()` that establish the entry was ours.
   * Said plainly because the comment here once claimed the guard was in this
   * method, which would have made a direct call look safe when it is not: call
   * it only where you already know the answer.
   *
   * The plan is rebuilt from the registry rather than remembered, because the
   * exit may arrive after a restart that emptied every map in this process.
   * `configDir` comes from the session for the same reason: the entry has to be
   * removed from the registry it was added to, and the console's own default
   * would be the wrong one for a profile-account sign-in.
   */
  async releaseMcpBridge(id: string, configDir?: string): Promise<void> {
    const pending = this.pendingMcpBridges.get(id);
    if (pending) {
      this.pendingMcpBridges.delete(id);
      await unbridgeDefinition(pending, this.mcpExec);
      return;
    }
    const meta = this.mcp.meta(id);
    if (!meta) return;
    const plan = planMcpLogin(meta, configDir ? { configDir } : {});
    if (isLoginBlock(plan)) return;
    await unbridgeDefinition(plan, this.mcpExec);
  }

  /**
   * A server came back — re-arm every phase that parked waiting for it.
   *
   * This is the whole point of parking BEFORE the spawn rather than failing
   * after it. The park cost nothing but a probe, it named the server, and the
   * moment somebody signs that server in the run can simply carry on. Nobody
   * has to remember which of six plans was blocked on the thing they just fixed.
   *
   * Deliberately narrow in WHAT it touches: only records parked by the MCP
   * preflight, and only when the note names THIS server. A phase parked for any
   * other reason is left exactly where it is.
   *
   * Deliberately WIDE in when it fires, which it was not. It used to run on one
   * trigger — a `claude mcp login` terminal exiting for that id — and that
   * misses the shapes people actually hit. A server that reports `failed`
   * because its command holds an unfilled `${VAR}` has no login to complete, so
   * it never fired. A server the operator gives up on and switches off or
   * removes stops blocking anything, and it never fired for that either. It is
   * called now on any transition INTO `connected`, and on disable and removal,
   * because in all three cases the reason the phase parked has gone.
   *
   * A halted run is still healable and that is not an accident: `drive()`'s
   * teardown leaves `this.state` in place, the runner stays in the pool, and
   * `retryPhase` restarts a stopped run rather than only resetting a record.
   * Which matters most in exactly the case that motivated all of this — where
   * the MCP park was what halted the run in the first place.
   */
  /* ---- the `require` park's clock ---- */

  /** One armed clock per (plan, phase): the newest due time wins, restarts survive. */
  /** Announced once per (run, phase): the clock may fire on both sides of a restart. */
  private mcpTimeoutAnnounced = new Set<string>();

  /** The operator's timeout for a `require` park, in ms; 0 = wait indefinitely. */
  protected mcpRequireTimeoutMs(): number {
    const value = this.prefs.mcpRequireTimeoutMs;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_MCP_REQUIRE_TIMEOUT_MS;
  }

  /** Arm (or re-arm) the continue-without clock for one parked phase. */
  protected armMcpRequireTimer(slug: string, phase: number, dueAt: number): void {
    const key = `${slug}:${phase}`;
    const delay = Math.max(0, dueAt - Date.now());
    if (delay > MAX_TIMER_MS) return;
    const existing = this.mcpRequireTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.mcpRequireTimers.delete(key);
      this.dropClock('mcp-require', key);
      // Fire time, not arm time. "Continue without these servers" re-boards the
      // phase, which is an auto-START, so a frozen console must not do it —
      // and must not lose it either: the park record and its `at` stay on
      // disk, so `thawFleet`'s re-arm pass finds the clock overdue and
      // continues the phase then. Read for THIS plan: a restart waiting for its
      // lanes holds only the plans whose scope meets theirs (#70).
      const frozen = this.fleetHoldFor(slug);
      if (frozen) {
        log.info('mcp.require-timeout-frozen', { slug, phase, by: frozen.by });
        return;
      }
      void this.continueMcpParkedPhase(slug, phase, 'timeout')
        .catch((error) => { log.warn('mcp.require-timeout-failed', { slug, phase, error }); });
    }, delay);
    timer.unref?.();
    this.mcpRequireTimers.set(key, timer);
    this.noteClock('mcp-require', key, Date.now() + delay, { slug, phase });
  }

  /** Every `require` park of a run re-arms its clock — at boot, and for a run that stopped on one. */
  protected armMcpRequireTimersFor(state: RunState): void {
    const timeout = this.mcpRequireTimeoutMs();
    for (const record of Object.values(state.phases ?? {})) {
      const due = mcpParkDueAt(record, timeout);
      if (due !== null) this.armMcpRequireTimer(state.slug, record.phase, due);
    }
  }

  /**
   * The fourth boot clock: a freeze that outlived the console which armed it.
   *
   * `state.freeze.escalateAt` is written to the run file and rendered on the
   * lane card as a commitment — "left frozen past 18:11 it converts to a
   * checkpoint". Nothing on the server ever read it back. The timer that kept
   * that promise lived in the Runner and died with the process, so a console
   * restarted after the deadline simply never escalated, and the frozen child
   * — which a freeze leaves SIGSTOPped, holding its memory and its working
   * tree — stayed stopped with no handle on it. Two answers, from
   * `freezeVerdict`:
   *
   *  - past due ⇒ escalate NOW, on this pass;
   *  - still inside its window ⇒ arm a timer for the remainder, so the promise
   *    is kept at the time it was made for rather than at the next restart.
   *
   * A LIVE run is left alone: its Runner owns the lane and holds its own
   * timer, and two escalations of one freeze would signal a pid twice.
   */
  protected armFreezeEscalation(slug: string, state: RunState): void {
    const key = `${slug}:${state.id}`;
    const existing = this.freezeTimers.get(key);
    if (existing) { clearTimeout(existing); this.freezeTimers.delete(key); this.dropClock('freeze-escalation', key); }
    if (this.liveRunner(slug)) return;
    // The EARLIEST deadline under this run, across every frozen child — one
    // timer per run, so it has to be the one that comes due first.
    const verdict = runFreezeVerdict(state, Date.now());
    if (verdict.kind === 'none') return;
    if (verdict.kind === 'escalate') { this.escalateFrozenRun(slug, state.id); return; }
    // Only a delay `setTimeout` can hold; anything longer is the next boot's,
    // which is exactly the pass this method is.
    if (verdict.inMs > MAX_TIMER_MS) return;
    const timer = setTimeout(() => {
      this.freezeTimers.delete(key);
      this.dropClock('freeze-escalation', key);
      this.escalateFrozenRun(slug, state.id);
    }, Math.max(0, verdict.inMs));
    timer.unref?.();
    this.freezeTimers.set(key, timer);
    this.noteClock('freeze-escalation', key, Date.now() + Math.max(0, verdict.inMs), { slug, runId: state.id });
    log.info('run.rearmed-freeze', { slug, runId: state.id, escalateAt: state.freeze?.escalateAt });
  }

  /**
   * Carry out an escalation against the STORED run — no lanes, no Runner.
   *
   * Re-read before acting, the same discipline `resumeLimitPaused` takes: the
   * operator may have thawed it, stopped the run, or started a fresh console
   * that adopted the lane in the minutes this timer slept, and every one of
   * those wins over a decision made when it was armed.
   */
  private escalateFrozenRun(slug: string, runId: string): void {
    if (!this.root?.ok) return;
    // A console that came back and adopted the lane owns the freeze again.
    if (this.liveRunner(slug)) return;
    // …and a FLEET freeze outranks any lane clock underneath it. The other rail
    // of the same defect the standing conversion fixes for live lanes: a
    // console restarted over a clocked freeze arms this timer at boot, and if
    // the operator then presses Freeze all, fifteen minutes later it would
    // `killLadder` a child inside a freeze the banner calls standing.
    //
    // A refusal, not a deferral: the timer that brought us here deleted itself
    // on the way in. The promise is restored by the next boot pass, or by
    // `armFreezeEscalation` when a thawed console next reads this run —
    // deliberately NOT re-armed here, because a clock re-armed inside a freeze
    // is a clock the operator cannot see and did not ask for. Read for THIS
    // plan, as `freezeRun` writes the standing form (#70).
    const held = this.fleetHoldFor(slug);
    if (held) {
      log.info('run.freeze-escalate-frozen', { slug, runId, by: held.by });
      return;
    }
    const ruled: PersistedEscalation[] = [];
    const edited = this.editStoredRunById(slug, runId, (state) => {
      if (runFreezeVerdict(state, Date.now()).kind !== 'escalate') return;
      // Every frozen child, not just the mirror slot's: two lanes frozen and a
      // console restart used to escalate one and orphan the other.
      ruled.push(...escalatePersistedFreeze(state));
      // Nothing else is running under it — a stored run has no lanes by
      // definition — so the run itself is now stopped, and the freeze that
      // stopped it was the operator's act.
      setRunState(state, 'paused');
      state.stoppedBy = 'operator';
      state.halt = null;
    });
    if (!edited || !ruled.length) return;
    const journal = Journal.for(this.root.path, slug, edited.id);
    for (const escalated of ruled) {
      if (!escalated.escalated) continue;
      journal.append('run.freeze-escalated', {
        pid: escalated.pid, phase: escalated.phase, sessionId: escalated.sessionId ?? null,
        afterMs: FREEZE_ESCALATE_MS, at: 'boot', signalled: escalated.signalled,
      }, escalated.phase ?? undefined);
      log.info('run.freeze-escalated', {
        slug, runId: edited.id, phase: escalated.phase, pid: escalated.pid,
        signalled: escalated.signalled,
      });
    }
  }

  /**
   * "Continue without these servers" for ONE `require`-parked phase — the
   * clock's act (`mcpRequireTimeoutMs`), the healer's when a lost clock is
   * found overdue, or a caller's by name. Live run: the runner's own verb
   * (flip, wake, announce through the dep). Stopped run: the stored record is
   * flipped with the same function, journalled in the service's voice, the
   * halt about it cleared, the operator told once — and the run restarted so
   * the loop boards the phase under normal admission. Null when the phase is
   * not (or no longer) such a park; a `timeout` fire against a park that is
   * not yet due (a newer run parked the same phase) re-arms instead.
   */
  async continueMcpParkedPhase(slug: string, phase: number, by = 'timeout'): Promise<McpContinueResult | null> {
    const key = `${slug}:${phase}`;
    const armed = this.mcpRequireTimers.get(key);
    if (armed) { clearTimeout(armed); this.mcpRequireTimers.delete(key); this.dropClock('mcp-require', key); }
    const runner = this.liveRunner(slug);
    if (runner) {
      const record = runner.current()?.phases?.[String(phase)];
      const due = mcpParkDueAt(record, this.mcpRequireTimeoutMs());
      if (by === 'timeout' && due !== null && due > Date.now()) { this.armMcpRequireTimer(slug, phase, due); return null; }
      return runner.continueMcpPark(phase, by);
    }
    if (!this.root?.ok) return null;
    let result: McpContinueResult | null = null;
    let pending: number | null = null;
    const edited = this.editStoredRun(slug, (state) => {
      const record = state.phases?.[String(phase)];
      const due = mcpParkDueAt(record, this.mcpRequireTimeoutMs());
      if (by === 'timeout' && due !== null && due > Date.now()) { pending = due; return; }
      result = continueMcpParkedRecord(state, phase, { by, journal: journalOf(state) });
      if (!result) return;
      // The park was what stopped this run: the halt about it ends here. A
      // halt about some OTHER phase stands.
      if (state.halt && (state.halt.kind === 'mcp-preflight' || state.halt.phase === phase)) state.halt = null;
      // The phase's own ending goes with it: since the halt-kind split that is
      // where an `mcp-preflight` stop lives when `halt()` wrote it, and the
      // classifier prefers it to `state.halt` (QA F1).
      retirePhaseHalt(record);
    });
    if (pending !== null) { this.armMcpRequireTimer(slug, phase, pending); return null; }
    if (!edited || !result) return null;
    const flipped: McpContinueResult = result;
    const journal = Journal.for(this.root.path, slug, edited.id);
    journal.append('phase.mcp-require-timeout', { servers: flipped.servers, waitedMs: flipped.waitedMs, by }, phase);
    journal.append('phase.errand', {
      ...flipped.errand, label: 'MCP server unavailable',
      reason: `waited ${Math.round(flipped.waitedMs / 60_000)} min under the require policy`, by,
    }, phase);
    log.info('mcp.require-timeout', { slug, runId: edited.id, phase, servers: flipped.servers, by });
    this.announceMcpTimeout(edited, phase, flipped);
    this.emit('run:state', { state: edited });
    // Nothing drives a stopped run but a start. `queued` and in-flight runs
    // (under another process) are left to whoever owns them.
    if (this.flags.allowRun && !IN_FLIGHT.includes(edited.status) && edited.status !== 'queued') {
      await this.startRun(slug, {
        // The `require` park's clock ran out (or the healer's `mcp-continue`
        // rung flipped it early — `by` says which): the run goes on without
        // the servers it named.
        actor: doorActor('mcp-require-timeout', {
          by, via: by === 'timeout' ? 'timer' : 'event', origin: 'armMcpRequireTimer',
          trigger: `require-timeout:${flipped.servers.join(',')}`,
          guard: 'allowRun,!IN_FLIGHT,!queued', counter: 'one per phase per park',
        }),
        resumeRunId: edited.id,
        ...(edited.onlyPhases?.length ? { onlyPhases: edited.onlyPhases } : {}),
        skills: edited.skills ?? [],
      });
    }
    return flipped;
  }

  /** A `require` park timed out and the phase went ahead: say so, once per run per phase. */
  protected announceMcpTimeout(state: RunState, phase: number, result: McpContinueResult): void {
    const key = `${state.id}:${phase}`;
    if (this.mcpTimeoutAnnounced.has(key)) return;
    this.mcpTimeoutAnnounced.add(key);
    const one = result.servers.length === 1;
    const minutes = Math.round(result.waitedMs / 60_000);
    // `parked` is the category that announced the park; its ending is the
    // same conversation, so it goes to the same subscribers.
    this.announce('parked', {
      title: `Phase ${phase} continues without ${one ? 'an MCP server' : 'some MCP servers'} — ${state.slug}`,
      body: `${result.servers.join(', ')} did not connect within ${minutes} min under the require policy, so the `
        + 'phase goes ahead without it and was told to record what it could not do. Sign '
        + `${one ? 'it' : 'them'} in under Settings ▸ MCP, or drop the name from the plan.`,
      tag: tagFor('run', 'mcp-timeout', state.slug, String(phase)),
    }, { slug: state.slug, runId: state.id, phase });
  }

  protected async healMcpParks(serverId: string): Promise<void> {
    for (const runner of this.runners.values()) {
      const state = runner.current();
      if (!state) continue;
      for (const record of Object.values(state.phases ?? {})) {
        if (record.status !== 'parked') continue;
        const note = record.note ?? '';
        if (!MCP_PARK_NOTE.test(note) || !note.includes(serverId)) continue;
        log.info('mcp.park-healed', { slug: state.slug, phase: record.phase, server: serverId });
        // `parked` is the category that announced the park; its unparking is
        // the same conversation, so it goes to the same subscribers.
        this.announce('parked', {
          title: `Phase ${record.phase} unblocked — ${state.slug}`,
          body: `${serverId} is connected again, so the phase that parked waiting for it has been `
            + 'requeued.',
          tag: tagFor('run', 'mcp-healed', state.slug, String(record.phase)),
          // With its subject: the run page marks it read, the link lands on the
          // run, and the webhook leg carries the slug instead of null.
        }, { slug: state.slug, runId: state.id, phase: record.phase });
        try {
          // The `require` park's other exit: the server came back before the
          // clock ran out. The same door, with the trigger saying which.
          await this.retryPhase(state.slug, record.phase, undefined, doorActor('mcp-require-timeout', {
            by: 'console', via: 'event', origin: 'mcp-health-clock',
            trigger: `healed:${serverId}`, guard: 'parked-on-require', counter: 'one per park',
          }));
        } catch (error) {
          // A claimed phase refuses; that is correct and not our business to
          // force. The park stays, and the operator's own Retry still works.
          log.warn('mcp.park-heal-refused', { slug: state.slug, phase: record.phase, error });
        }
      }
    }
  }

  /**
   * A phase ran without servers it asked for. Say so, once.
   *
   * Once per run per SERVER, not per phase: a plan with three unreachable
   * servers and seven phases would otherwise be twenty-one notifications for
   * one fact the operator can act on exactly once. The `health` category is
   * right for it — this is the console reporting on its own equipment, not the
   * run asking for anything, and the run is not stopping.
   */
  protected announceMcpDegraded(state: RunState, phase: number, degraded: McpDegradation[]): void {
    const fresh = degraded.filter((row) => {
      const key = `${state.id}:${row.id}`;
      if (this.degradedAnnounced.has(key)) return false;
      this.degradedAnnounced.add(key);
      return true;
    });
    // `<runId>:<serverId>` and never removed — one entry per server per run for
    // the process's life, on the same axis as `notifiedErrand`, which has
    // always trimmed. Re-announcing a degraded server 500 runs later is the
    // right side of this trade.
    trimOldest(this.degradedAnnounced, NOTIFIED_CAP);
    if (!fresh.length) return;
    const named = fresh.map((row) => `${row.id} (${row.detail ?? mcpReasonText(row.reason)})`).join(', ');
    const one = fresh.length === 1;
    this.announce('health', {
      title: `${state.slug} is running without ${one ? 'an MCP server' : 'some MCP servers'}`,
      body: `Phase ${phase} started without ${named}. The run is carrying on and the session was told `
        + `to record what it could not do. Sign ${one ? 'it' : 'them'} in from Settings ▸ MCP, or drop `
        + `${one ? 'the name' : 'the names'} from the plan.`,
      // Per set of servers: server B at phase 3 must not replace the card
      // about server A at phase 1 — they are two facts, each acted on once.
      tag: tagFor('run', 'mcp-degraded', state.slug, fresh.map((row) => row.id).join(',')),
    }, { slug: state.slug, runId: state.id, phase });
  }

  protected emitMcp(): void {
    // A registry change moves F15, which the lint panel reads from the engine.
    invalidate();
    if (this.mcpEmitTimer) return;
    this.mcpEmitTimer = setTimeout(() => {
      this.mcpEmitTimer = null;
      void this.mcp.list()
        .then((servers) => this.emit('mcp', { servers }))
        .catch((error) => log.warn('mcp.emit-failed', { error }));
    }, 150);
    this.mcpEmitTimer.unref?.();
  }

  protected emitAccounts(): void {
    if (this.accountsEmitTimer) return;
    this.accountsEmitTimer = setTimeout(() => {
      this.accountsEmitTimer = null;
      // Every accounts change is a fresh reading as far as a usage wall is
      // concerned (#78): a meter read under the wall, a spend that lifted it, a
      // switch to an account that can pay. Each runner re-reads the walls its
      // phases are parked on — cheap, answered from cache, never a session.
      for (const runner of this.runners.values()) {
        try { runner.rereadWalls('reading'); } catch (error) { log.warn('accounts.walls-reread-failed', { error }); }
      }
      void this.accounts.list()
        .then((accounts) => this.emit('accounts', { accounts }))
        .catch((error) => log.warn('accounts.emit-failed', { error }));
    }, 150);
    this.accountsEmitTimer.unref?.();
  }

  /**
   * Everything that needs a person, across everything, in one answer.
   *
   * Deliberately NOT named `inbox()`: that method is already the NOTIFICATION
   * inbox (`notifications.list`), and quietly taking its name would have
   * broken `GET /api/notifications` with no test to catch it. The two are
   * different things — that one is a log of what happened, this one is a list
   * of what is still owed.
   *
   * Every gatherer is individually guarded. A console whose MCP registry
   * cannot be read should still show its errands: an inbox that throws because
   * one source failed is strictly worse than one missing a row, which is why
   * every field of `InboxFacts` is optional and absent means "nothing to say".
   *
   * Computed at most once per change (control-tower phase 56, #75): the view is
   * memoised on its inputs' revision (`inboxKey`) and built single-flight, so
   * N tabs asking at one revision cost one build — the hub measured 3.4 s p50
   * and 29 s p90 with every request building its own. The memo also lapses
   * after `INBOX_MAX_AGE_MS`, for the inputs that announce no change of their
   * own (the clocks, a ledger a session appended to).
   */
  async attention(all = false): Promise<InboxView> {
    return (await this.inboxMemoFor(all)).view;
  }

  /**
   * The inbox as an HTTP entity — its body and validator, built once per memo
   * rather than once per request, and its coded forms packed once each.
   */
  async attentionEntity(all = false): Promise<InboxEntity> {
    const memo = await this.inboxMemoFor(all);
    if (!memo.entity) {
      const body = Buffer.from(JSON.stringify(memo.view), 'utf8');
      memo.entity = { etag: etagOf(body), body, packed: {} };
    }
    return memo.entity;
  }

  /**
   * The validator of the inbox a request would be served RIGHT NOW, or null
   * when that would take a build — so a conditional GET is answered 304 from
   * the input revisions alone, before any body exists (#75).
   */
  inboxEtag(all = false): string | null {
    const memo = this.inboxMemo.get(all);
    if (!memo?.entity || memo.key !== this.inboxKey(all) || Date.now() - memo.at >= INBOX_MAX_AGE_MS) return null;
    return memo.entity.etag;
  }

  /** What the inbox is a function of, as one comparable string. */
  private inboxKey(all: boolean): string {
    const plans = (this.store?.list() ?? []).map((record) => `${record.slug}@${record.revision}`).join(',');
    return `${all ? 'all' : 'open'}|g${this.generation}|r${this.inboxRevision}|${plans}`;
  }

  /**
   * One build at a time per shape. A request whose key moved while a build
   * ran waits for it and asks again, rather than starting a second build
   * beside it — under a busy run the revision moves constantly, and a build
   * per revision per request was the pile-up the audit measured.
   */
  private async inboxMemoFor(all: boolean): Promise<InboxMemo> {
    for (;;) {
      const key = this.inboxKey(all);
      const memo = this.inboxMemo.get(all);
      if (memo && memo.key === key && Date.now() - memo.at < INBOX_MAX_AGE_MS) return memo;
      const flight = this.inboxFlight.get(all);
      if (flight?.key === key) return flight.promise;
      if (flight) { await flight.promise.catch(() => undefined); continue; }
      const promise = this.buildAttention(all).then((view) => {
        const built: InboxMemo = { key, at: Date.now(), view };
        this.inboxMemo.set(all, built);
        return built;
      }).finally(() => {
        if (this.inboxFlight.get(all)?.promise === promise) this.inboxFlight.delete(all);
      });
      this.inboxFlight.set(all, { key, promise });
      return promise;
    }
  }

  /**
   * The inbox's gate answers for one plan: the last set read, never a read of
   * its own (#75 — "a request never shells the engine per gated phase"). A
   * plan whose revision moved past the held set gets ONE background refill,
   * one phase at a time so a gated plan cannot take the whole engine pool to
   * paint a row; when it lands the inbox revision moves and the page is
   * nudged, so the rows follow within a beat of the refill.
   */
  private inboxGates(slug: string, revision: number, phases: readonly number[]): Map<number, GateStatus | null> {
    const held = this.inboxGateAnswers.get(slug);
    if (phases.length && (!held || held.revision !== revision)) this.refillInboxGates(slug, revision, phases);
    return held?.gates ?? new Map();
  }

  private refillInboxGates(slug: string, revision: number, phases: readonly number[]): void {
    const fill = `${slug}@${revision}`;
    if (this.inboxGateFills.has(fill)) return;
    this.inboxGateFills.add(fill);
    void (async () => {
      const gates = new Map<number, GateStatus | null>();
      for (const phase of phases) gates.set(phase, await this.gateStatus(slug, phase).catch(() => null));
      const held = this.inboxGateAnswers.get(slug);
      if (held && held.revision > revision) return;
      this.inboxGateAnswers.set(slug, { revision, gates });
      this.emit('inbox', { at: new Date().toISOString() });
    })()
      .catch((error) => log.warn('inbox.source-failed', { what: 'gates', error }))
      .finally(() => this.inboxGateFills.delete(fill));
  }

  private async buildAttention(all: boolean): Promise<InboxView> {
    const ok = async <T>(what: string, get: () => Promise<T> | T, fallback: T): Promise<T> => {
      try { return await get(); } catch (error) { log.warn('inbox.source-failed', { what, error }); return fallback; }
    };

    const records = this.store?.list() ?? [];
    const [runs, accounts, auth, mcp, plans] = await Promise.all([
      ok('runs', () => this.allRuns(), [] as RunState[]),
      ok('accounts', () => this.listAccounts(), [] as AccountView[]),
      ok('auth', () => this.authStatus(), { loggedIn: false } as AuthStatus),
      ok('mcp', () => this.listMcp(), [] as McpServerView[]),
      ok('plans', async () => Promise.all(records.map(async (record) => {
        const ctx = await this.context(record);
        const phases = (record.plan?.graph ?? []).map((row) => {
          const detail = record.plan?.phases[row.phase];
          return {
            phase: row.phase,
            title: detail?.title || row.title,
            state: ctx.board.states[row.phase] ?? 'waiting',
            gated: detail?.gated ?? false,
            gateCheck: detail?.gateCheck,
            gateKind: gateKindOf(detail?.gateCheck, detail?.gated ?? false, this.gateVocab),
          };
        });
        // `gateStatus` shells the engine, so it is asked ONLY for the handful
        // of phases whose answer can produce a row — gated, and not already
        // done — and never by the build itself: `inboxGates` answers from the
        // last set read and refills it off the request path (#75).
        const gateBy = this.inboxGates(record.slug, record.revision, phases
          .filter((ph) => ph.gated && ph.state !== 'done')
          .map((ph) => ph.phase));
        // Per-phase QA regimes, by the plan-detail precedent (service-live.ts
        // `detail()`): the JS parse decides only WHETHER to ask — phases
        // stating their own `- **QA:**` — and the engine answers, cached by
        // revision. Asked only where the answer can change a row: a pending
        // verdict on a phase the board reads done, under a plan whose own
        // word would suppress it. Zero extra shells everywhere else.
        const planQa = await this.qaMode(record.slug).catch(() => ({ mode: 'off' }));
        const qaModes: Record<number, string> = {};
        if (planQa.mode !== 'on') {
          await Promise.all((record.qa ?? [])
            .filter((row) => row.result === 'pending'
              && (ctx.board.states[row.phase] ?? 'waiting') === 'done'
              && record.plan?.phases[row.phase]?.qa)
            .map(async (row) => {
              const m = await this.qaMode(record.slug, row.phase).catch(() => null);
              if (m) qaModes[row.phase] = m.mode;
            }));
        }
        return {
          slug: record.slug,
          title: record.plan?.title ?? record.slug,
          closed: this.isClosedPlan(record.slug),
          // `PlanRecord` has no `updatedAt` — the plan's last write is
          // `activity` (store.ts:31), epoch ms, the newest mtime across the
          // plan file and every handoff artefact. Reading a field that does
          // not exist handed every gate, QA, plan-health and idle row an
          // EMPTY `since`: no clock on the card, last place inside its own
          // severity band (`sortInbox` ranks an unclocked item `Infinity`),
          // and an ack that could never go stale when the ask came back —
          // which is rule 2 of inbox.ts's header, silently unenforceable for
          // four of the eight kinds. `0` is the never-stat'd record, and that
          // is genuinely no clock, not 1970.
          updatedAt: record.activity > 0 ? new Date(record.activity).toISOString() : undefined,
          // No `gatesDelegated` (control-tower phase 107, #174): a gate row is
          // raised only for a MANUAL gate, and a manual gate is a person's
          // whatever the plan's `gates` row answers — delegation never hides it.
          qaMode: planQa,
          qaModes,
          qa: record.qa ?? [],
          issues: healthIssues(ctx),
          phases: phases.map((ph) => ({ ...ph, gate: gateBy.get(ph.phase) ?? undefined })),
        };
      })), [] as unknown[]),
    ]);

    // The ruling ledgers, and the plans Insights already calls stalled. The
    // portfolio is cached per generation and `attention` has just built every
    // plan's context anyway, so this costs the pure computation and not a
    // second pass over the store.
    const rulings = await ok('rulings', () => this.store?.list().flatMap((record) =>
      (this.isClosedPlan(record.slug) ? [] : this.runRulings(record.slug))) ?? [], [] as Ruling[]);
    const stalledPlans = await ok('stalled-plans', async () => (await this.portfolio()).stalled, []);

    // What the policy table answered by itself (phase 19): each open plan's
    // newest run — its journal's `phase.policy-answered` lines and the
    // fingerprints the run keeps — cached on the journal file's own stamp.
    const policyAnswers = await ok('policy-answers', () => {
      const newest = new Map<string, RunState>();
      for (const run of runs) {
        const held = newest.get(run.slug);
        if (!held || String(run.createdAt ?? '') > String(held.createdAt ?? '')) newest.set(run.slug, run);
      }
      return [...newest.values()]
        .filter((run) => !this.isClosedPlan(run.slug))
        .flatMap((run) => this.runPolicyAnswers(run));
    }, [] as ReturnType<Service['runPolicyAnswers']>);

    // The registry, waiting flags included — the session-ask drafts' one fact.
    const sessionFacts = await ok('sessions', () => this.sessionViews(), [] as SessionView[]);

    // The isolated runs' git probes, from the runner caches. `ok()` for every
    // other gatherer's reason: a conflict row is a diagnostic, and an inbox
    // that throws because one cache was mid-write is worse than one missing a
    // row.
    const gitFacts = await ok('git', () => this.runGitFacts(), [] as ReturnType<Service['runGitFacts']>);

    const locks = await ok('locks', () => this.allLocks(), [] as LockView[]);
    const lockPresence: Record<string, Presence> = {};
    for (const lock of locks) {
      // The same verdict the release path reaches — a verifying lane's claim
      // must not be raised as debris by a row whose button would then refuse
      // it, which is the mismatch this pair of call sites exists to prevent.
      lockPresence[`${lock.slug}:${lock.phase}`] =
        await ok('lock-presence', () => this.lockPresenceFor(lock), 'unknown' as Presence);
    }

    // This console's reach and its siblings — the instance-health rows (FLT-1 iv, FLT-6).
    const fleet = await ok('fleet', () => this.inboxFleetFacts(), undefined);

    // The sessions' issue drafts a person owes a decision on (phase 12) —
    // every open plan's ledger, through the base's default (nothing) or the
    // Pro override.
    const issueDrafts = await ok('issue-drafts', () => this.inboxIssueDrafts(), []);
    // …and what the sessions said to the operator (phase 15), through the
    // same base default (nothing) or the Pro override.
    const messages = await ok('messages', () => this.inboxMessages(), []);
    // …and what the supervisor holds standing (control-tower phase 101, #145).
    const supervisorCards = await ok('supervisor', () => this.inboxSupervisorCards(), []);
    // …and every person's turn still open (control-tower phase 41).
    const humanSteps = await ok('human-steps', () => this.humanStepsNow().open(), []);

    const facts = {
      runs, approvals: this.approvals.all(), plans, locks, lockPresence, fleet,
      sessions: sessionFacts,
      queue: this.queueSnapshot(),
      accounts, auth, mcp,
      environment: this.environment.issues,
      watcher: this.watcher.status(),
      // The skill copy each config dir loads, against this console (#151).
      skillCopy: await ok('skill-copy', () => this.skillCopy(), undefined),
      hookFaults: this.hookFaultFacts(),
      flags: {
        allowWrites: this.flags.allowWrites, allowRun: this.flags.allowRun,
        allowTerminal: this.flags.allowTerminal, allowAgent: this.flags.allowAgent,
        allowAccounts: this.flags.allowAccounts, allowMcp: this.flags.allowMcp,
        allowPublish: this.flags.allowPublish,
      },
      rulings,
      policyAnswers,
      issueDrafts,
      messages,
      supervisorCards,
      humanSteps,
      stalledPlans,
      // The isolated runs' branch facts, read from the runner caches — the
      // conflict rows' one fact. Nothing is probed here; see `runGitFacts`.
      git: [
        ...gitFacts.map((entry) => ({
          slug: entry.slug,
          ...(entry.branch ? { branch: entry.branch } : {}),
          ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
          ...(entry.isolation ? { isolation: entry.isolation } : {}),
          ...(entry.checkout ? { checkout: entry.checkout } : {}),
          ...(entry.isolationRefusal ? { isolationRefusal: entry.isolationRefusal } : {}),
          ...(entry.mounts ? { mounts: entry.mounts } : {}),
          // …with the repository radar's clash zones joined on. The per-run
          // probe measures the VERDICT; only the repository radar knows the
          // zones, because only it reads `.phase-console/clash-zones` and the
          // open plans' lines. Joined here by `pairKey`, through a map the Pro
          // half fills and this half merely reads — see `radarZones`, and the
          // free tree, where it is empty and this line is a no-op.
          radar: entry.view.radar.map((pair) => {
            const zones = this.radarZones.get(pairKey(pair.a, pair.b));
            return zones?.length ? { ...pair, zones } : pair;
          }),
        })),
        // The runs that asked for a checkout and were refused: no probe, no
        // radar — one fact and its reason, for the row that says so (G3).
        ...this.refusedIsolationFacts(),
      ],
      // Two ack stores, one map. The ledger's acks are the durable half — they
      // travel with the plan and survive a console reinstall — and this
      // instance's acks file is the local half, which is where every other
      // kind's ack lives and which wins on a conflict because it is the one a
      // person just wrote.
      acks: { ...Service.rulingAcksOf(rulings), ...readAcks(INBOX_ACKS_DIR) },
    } as unknown as InboxFacts;

    const now = Date.now();
    const view = buildInbox(facts, now, { all });
    // What the heartbeat tells a fleet reader: this console's asks, unacked,
    // at their last build (FLT-6) — never a second build of its own.
    this.needsYouCount = {
      count: view.items.filter((item) => (item.severity === 'urgent' || item.severity === 'needs-you') && !item.ack).length,
      at: now,
    };
    // An ack for something that is no longer asking is dead weight, and — for
    // the items that have no clock of their own — pruning is the ONLY thing
    // that makes a gone-and-came-back item read as new again.
    try { pruneAcks(INBOX_ACKS_DIR, inboxIds(facts, now)); }
    catch (error) { log.warn('inbox.prune-failed', { error }); }
    return view;
  }

  /**
   * The ledger's own acknowledgements, keyed by the inbox id they belong to.
   *
   * Minted here with `inboxItemId` and never re-derived on the client, so the
   * two halves of the ack story cannot disagree about what an item is called.
   */
  private static rulingAcksOf(rulings: readonly Ruling[]): Record<string, InboxAck> {
    const out: Record<string, InboxAck> = {};
    for (const ruling of rulings) {
      if (!ruling.ack) continue;
      out[inboxItemId({ kind: 'ruling', slug: ruling.slug, phase: ruling.phase, subject: ruling.id })] = ruling.ack;
    }
    return out;
  }

  /**
   * Annotate an inbox item as seen. Never resolution — the ask still stands.
   * `by` names who saw it: the route derives it from the request, so a ruling's
   * ledger ack (which refuses an empty name) is always attributed.
   */
  ackInbox(id: string, by: string): boolean {
    try {
      writeAck(INBOX_ACKS_DIR, id, by);
      // A RULING's acknowledgement belongs in the ledger too, as a further
      // appended line. The acks file is this instance's state and the ledger
      // is the plan's record: an ack that lived only in the first would vanish
      // with a reinstall, and `GET /api/run/:slug/rulings` — which reads the
      // file and not the acks — would keep showing the row as unseen.
      const parsed = parseInboxItemId(id);
      if (parsed?.kind === 'ruling' && parsed.slug && parsed.subject && this.root?.ok) {
        appendRulingAck(rulingsFile(this.root.path, parsed.slug), parsed.subject, by);
      }
      this.emit('inbox', { at: new Date().toISOString() });
      return true;
    } catch (error) { log.warn('inbox.ack-failed', { id, error }); return false; }
  }

  /** Undo an annotation. */
  unackInbox(id: string): boolean {
    const gone = removeAck(INBOX_ACKS_DIR, id);
    if (gone) this.emit('inbox', { at: new Date().toISOString() });
    return gone;
  }

  /**
   * Acknowledge many at once.
   *
   * One result per id rather than one boolean for the batch, which is the
   * shape `/api/locks/release {expired:true}` already settled on: a single
   * refusal must not be able to hide behind fifteen successes. The write is
   * one file write for the whole set; the ruling ledger still takes its own
   * appended line per ruling, because that file is the plan's record and a
   * batch is this console's convenience, not a fact about the plan.
   */
  ackInboxMany(ids: string[], by: string): { id: string; ok: boolean; error?: string }[] {
    const unique = [...new Set(ids)];
    const results: { id: string; ok: boolean; error?: string }[] = [];
    try {
      writeAckMany(INBOX_ACKS_DIR, unique, by);
    } catch (error) {
      log.warn('inbox.ack-many-failed', { count: unique.length, error });
      return unique.map((id) => ({ id, ok: false, error: 'could not be written' }));
    }
    for (const id of unique) {
      try {
        const parsed = parseInboxItemId(id);
        if (parsed?.kind === 'ruling' && parsed.slug && parsed.subject && this.root?.ok) {
          appendRulingAck(rulingsFile(this.root.path, parsed.slug), parsed.subject, by);
        }
        results.push({ id, ok: true });
      } catch (error) {
        log.warn('inbox.ack-ledger-failed', { id, error });
        results.push({ id, ok: false, error: 'acknowledged, but the ruling ledger refused the line' });
      }
    }
    if (unique.length) this.emit('inbox', { at: new Date().toISOString() });
    return results;
  }

  /** Undo many annotations — the other end of the bulk press. */
  unackInboxMany(ids: string[]): { id: string; ok: boolean }[] {
    const unique = [...new Set(ids)];
    let removed: Record<string, boolean> = {};
    try {
      removed = removeAckMany(INBOX_ACKS_DIR, unique);
    } catch (error) {
      log.warn('inbox.unack-many-failed', { count: unique.length, error });
      return unique.map((id) => ({ id, ok: false }));
    }
    if (Object.values(removed).some(Boolean)) this.emit('inbox', { at: new Date().toISOString() });
    return unique.map((id) => ({ id, ok: Boolean(removed[id]) }));
  }

  /**
   * Perform an answer that arrived from a notification button.
   *
   * The route has already proved the token: this is handed an inbox item id and
   * a verb the token authorised. What it does NOT do is trust either one to
   * mean anything on its own — it re-reads the live inbox, finds the item, and
   * finds the action the inbox itself declares for that verb. Three properties
   * come out of that, and they are the reason this is not a switch on the verb:
   *
   *   - **an item that has been cleared cannot be acted on.** Answered,
   *     expired, superseded, or on a plan somebody closed since — it is not in
   *     the inbox, so the answer is `gone` and the worker opens the app;
   *   - **the capability check is not restated.** Each `InboxAction` carries
   *     the `flag` that gates it, and the route reads that rather than
   *     guessing which of `--allow-run` / `--allow-writes` a verb wants;
   *   - **a verb the item does not offer is refused**, even when the token is
   *     perfectly valid. A token minted for a gate cannot answer an approval.
   *
   * `PUSH_ACTION_VERBS` is the other half of the restraint (`push/actions.ts`):
   * a notification button may ANSWER a question, never start or kill work.
   */
  async performInboxAction(
    itemId: string,
    verb: string,
    by = 'notification',
    actor: Actor = asActor(by, 'Service.performInboxAction'),
  ): Promise<{ ok: true; verb: string; item: string } | { ok: false; status: number; error: string }> {
    if (!isPushActionVerb(verb)) {
      return { ok: false, status: 400, error: `${verb} is not answerable from a notification` };
    }

    const view = await this.attention(true);
    const item = view.items.find((candidate) => candidate.id === itemId);
    if (!item) {
      return { ok: false, status: 410, error: 'this is no longer waiting on you' };
    }
    const action = item.actions.find((candidate) => candidate.verb === verb);
    if (!action) {
      return { ok: false, status: 409, error: `${item.kind} does not offer ${verb}` };
    }
    // The inbox marks a gated action with the flag that gates it and leaves it
    // in the list, so the card can say WHY a button is dead rather than hiding
    // it. From a notification there is nothing to grey out — the press has
    // already happened — so the same fact becomes the refusal.
    if (action.flag) {
      const enabled = action.flag === 'run' ? this.flags.allowRun
        : action.flag === 'writes' ? this.flags.allowWrites
          : action.flag === 'agent' ? agentEnabled(this.flags)
            : action.flag === 'accounts' ? this.flags.allowAccounts
              : action.flag === 'terminal' ? this.flags.allowTerminal
                : true;
      if (!enabled) {
        return {
          ok: false,
          status: 403,
          error: `this console was started without --allow-${action.flag}`,
        };
      }
    }

    switch (verb) {
      case 'allow':
      case 'deny': {
        const parsed = parseInboxItemId(itemId);
        const approvalId = parsed?.subject;
        if (!approvalId) return { ok: false, status: 409, error: 'this card has no id to answer' };
        const answered = this.decideApproval(approvalId, verb, by, undefined, undefined, actor);
        return answered.ok
          ? { ok: true, verb, item: itemId }
          : { ok: false, status: 409, error: answered.error ?? 'the card could not be answered' };
      }
      // The expiry warning's second button (control-tower phase 97, #140).
      case 'extend': {
        const approvalId = parseInboxItemId(itemId)?.subject;
        if (!approvalId) return { ok: false, status: 409, error: 'this card has no id to extend' };
        const extended = this.extendApproval(approvalId, EXTEND_CHOICES_MIN[1], by);
        return extended.ok
          ? { ok: true, verb, item: itemId }
          : { ok: false, status: extended.status, error: extended.error };
      }
      case 'approve': {
        if (!item.slug || typeof item.phase !== 'number') {
          return { ok: false, status: 409, error: 'this gate has no phase to approve' };
        }
        const outcome = await this.approveGate(item.slug, item.phase, {
          approve: true,
          by,
          actor,
          // A notification's Approve is a person's press (#174): its action
          // token was minted for the push a person's device received.
          person: true,
          // The receipt an operator reads six weeks later in gate-status.md has
          // to say HOW it was cleared: a tap on a lock screen is a different
          // act from a person sitting in front of the Gate card with the
          // conditions on screen, and only the note can carry that.
          note: 'approved from a push notification',
          continueRun: true,
        });
        return outcome.ok
          ? { ok: true, verb, item: itemId }
          : { ok: false, status: 409, error: outcome.detail ?? 'the gate could not be approved' };
      }
      // A person's turn (control-tower phase 43): *I did it* from the lock
      // screen runs the step's proof — the same check the card's button runs.
      case 'check': {
        const stepId = parseInboxItemId(itemId)?.subject;
        if (!stepId) return { ok: false, status: 409, error: 'this card names no step to check' };
        const checked = await this.checkHumanStep(stepId, { by });
        return checked.ok
          ? { ok: true, verb, item: itemId }
          : { ok: false, status: checked.status, error: checked.error };
      }
      default: {
        // Exhaustiveness: a fourth member of PUSH_ACTION_VERBS with no arm here
        // is a compile error rather than a button that silently does nothing.
        const unreachable: never = verb;
        return { ok: false, status: 400, error: `unhandled ${String(unreachable)}` };
      }
    }
  }

  /**
   * Every run on disk, unresolved, for the read-only money questions.
   *
   * Deliberately NOT `allRuns()`: that one calls `resolveAgainstBoard`, which
   * shells `phase-graph.sh` once per plan. Spend is a header widget and the
   * day cap is asked on every ladder climb, so both must be answerable without
   * starting a process. The TTL is short because the only readers are a poll
   * and a climb, and both would rather be a second stale than a scan late.
   */
  private runsForSpend(): SpendRunView[] {
    const now = Date.now();
    const gen = runsGeneration();
    const pool = this.spendPool;
    // Keyed on the run-write generation, with the clock as a FLOOR rather than
    // the whole key. The 5 s TTL alone meant a whole-portfolio directory scan
    // — every plan, every run file, each one parsed and settled — twelve times
    // a minute for the life of the process, to feed a header widget and the
    // ladder's day cap. Nothing having been written is now a reason to keep the
    // answer; the TTL survives only to notice a write by ANOTHER console, which
    // the generation cannot see.
    if (pool && pool.gen === gen && now - pool.at < SPEND_POOL_MAX_MS) return pool.runs;
    if (pool && now - pool.at < SPEND_POOL_MIN_MS) return pool.runs;
    if (!this.root) return [];
    const slugs = this.store?.list().map((r) => r.slug) ?? [];
    const runs = slugs.flatMap((slug) => listRuns(this.root!.path, slug, this.liveRunId())) as SpendRunView[];
    this.spendPool = { at: now, gen: runsGeneration(), runs };
    return runs;
  }

  /**
   * Every ladder rung this console climbed today, across every run.
   *
   * The denominator of `ladderPerDayUsd`, which no single run can see: the cap
   * is a promise about the machine, so three runs healing at once must count
   * against one budget rather than three.
   */
  dayRungs(): RungRecord[] {
    return rungsToday(this.runsForSpend(), new Date());
  }

  /** What this console has spent, and against which ceilings. */
  spend(): SpendView {
    return spendSummary(
      { runs: this.runsForSpend(), capUsd: ladderCaps(this.prefs).perDayUsd },
      new Date(),
    );
  }

  /**
   * The same numbers every page reads, in Prometheus text — `GET /api/metrics`.
   *
   * Assembled from `summaries()` and `runsForSpend()`, both of which the
   * console already keeps warm, so a scrape costs one board read per plan and
   * no extra directory scan. The rendering itself is pure
   * (`analysis/metrics.ts`), which is what lets the family list be pinned by
   * test rather than by a running server.
   *
   * The names are a CONTRACT the moment anyone scrapes this — see that module.
   */
  async metrics(): Promise<string> {
    const startedAt = Date.now();
    const summaries = await this.summaries();
    const runs = this.runsForSpend();

    const byPlan = new Map<string, SpendRunView[]>();
    for (const run of runs) {
      const slug = typeof run.slug === 'string' ? run.slug : '';
      if (!slug) continue;
      const list = byPlan.get(slug) ?? [];
      list.push(run);
      byPlan.set(slug, list);
    }

    return renderMetrics({
      plans: summaries.map((plan) => ({
        slug: plan.slug,
        status: plan.status,
        closed: plan.closed,
        phases: plan.phases,
        // An unreadable board (#96) exports its last good reading, else NaN —
        // Prometheus's "unknown" — never a 0 nobody read.
        done: plan.done ?? plan.lastGood?.done ?? Number.NaN,
        ready: plan.ready.length,
        waiting: plan.waiting,
        inProgress: plan.inProgress.length,
        stuck: plan.stuck.length,
        remainingWeight: plan.remainingWeight,
        percent: plan.percent ?? plan.lastGood?.percent ?? Number.NaN,
      })),
      runs: runs.map((run) => {
        const records = Object.values(run.phases ?? {});
        return {
          slug: typeof run.slug === 'string' ? run.slug : '',
          // A run file written before `status` existed is `unknown`, never
          // silently folded into `running` — a scrape that invents a state is
          // how an alert fires on a run nobody is driving.
          status: typeof (run as { status?: string }).status === 'string'
            ? (run as { status?: string }).status! : 'unknown',
          spentUsd: typeof run.spentUsd === 'number' ? run.spentUsd : 0,
          attempts: records.reduce((sum, rec) => sum + (rec?.attempts ?? 0), 0),
          phaseSeconds: records.reduce((sum, rec) => sum + (rec?.durationMs ?? 0), 0) / 1000,
          // The run's blocked WALL-CLOCK (#64) — never its phases' queued time summed.
          blockedSeconds: Object.fromEntries(
            Object.entries(run.blockedMs ?? {}).map(([klass, ms]) => [klass, (ms ?? 0) / 1000]),
          ),
        };
      }),
      cost: [...byPlan.entries()].map(([slug, list]) => {
        const view = planCost({ slug, runs: list });
        return {
          slug,
          totalUsd: view.totalUsd,
          attributedUsd: view.attributedUsd,
          residualUsd: view.residualUsd,
          ladderUsd: view.ladderUsd,
        };
      }),
      rungs: runs.flatMap((run) =>
        Object.values(run.recoveries ?? {}).flatMap((slot) =>
          (slot?.rungs ?? []).map((rung) => ({ rung: rung.rung, outcome: rung.outcome })))),
      // The isolated runs' checkout load — the same cached probes the inbox's
      // conflict rows read, so a scrape and a card cannot disagree.
      //
      // `managed` already means "under THIS plan's run directory"
      // (`probeRunGit` is handed `runDir(root, slug)` as its `stateRoot`), so
      // the count needs no attribution pass — and `prunable` entries are
      // excluded because `worktree list` still prints a checkout whose
      // directory has gone, which is a tree nobody is holding.
      git: this.runGitFacts().map(({ slug, view }) => {
        const mine = view.checkouts.filter((entry) => entry.managed && !entry.prunable);
        const measured = mine.filter((entry) => typeof entry.disk === 'number');
        const conflicted = new Set<string>();
        for (const pair of view.radar) {
          if (pair.state !== 'conflicted') continue;
          for (const file of pair.files) conflicted.add(file);
        }
        return {
          slug,
          worktrees: mine.length,
          // Absent, not zero, when `du` answered for none of them: a machine
          // without `du` uses disk like any other, and a 0 here would read as
          // an empty checkout.
          ...(measured.length
            ? { diskBytes: measured.reduce((sum, entry) => sum + (entry.disk ?? 0), 0) }
            : {}),
          conflictedFiles: conflicted.size,
        };
      }),
      today: this.spend().today,
      version: distRev() ?? 'unbuilt',
      instanceId: INSTANCE.name,
      scrapeSeconds: (Date.now() - startedAt) / 1000,
      process: this.processFacts(),
      // The account forecast (control-tower phase 92, #141), by account id.
      accounts: this.accounts.forecasts().flatMap(({ id, buckets }) =>
        Object.entries(buckets).map(([window, forecast]) => ({
          account: id, window, utilization: forecast.pct, burnPctPerHour: forecast.burnPctPerHour,
          wallsInSeconds: forecast.wallsAt ? Math.max(0, (Date.parse(forecast.wallsAt) - Date.now()) / 1000) : null,
        }))),
      // What each account spent on credit this month (control-tower phase 93, #146).
      // The load guard and the kept lanes (control-tower phase 100).
      load: (() => { const reading = this.loadGuard(); return { avg5: reading.avg5, threshold: reading.threshold }; })(),
      reservations: (() => {
        const kept = this.scheduler.reservationsView();
        return { armed: kept.filter((r) => r.armed).length, waiting: kept.filter((r) => !r.armed).length };
      })(),
      credits: this.accounts.accountIds().flatMap((id) => {
        const credit = this.accounts.creditOf(id);
        return credit.used !== null && credit.currency ? [{ account: id, currency: credit.currency, used: credit.used }] : [];
      }),
    });
  }

  /**
   * This console's own runtime, for the ten `phase_console_process_*` gauges.
   *
   * Every other family here is about the WORK. None was about the supervisor,
   * which is how a console climbed to V8's default heap over 23.7 hours with
   * no sample anywhere that would have shown the climb — and then parked two
   * live runs on its way down. All of it is already in this process; the only
   * cost is reading it.
   */
  private processFacts(): MetricsProcess {
    const memory = process.memoryUsage();
    const sessions = this.sessionInventory();
    // One reading for all three: the last complete window's (#75).
    const loop = eventLoopDelay();
    return {
      heapUsedBytes: memory.heapUsed,
      heapLimitBytes: getHeapStatistics().heap_size_limit,
      residentBytes: memory.rss,
      externalBytes: memory.external,
      eventLoopDelaySeconds: loop?.meanSeconds,
      eventLoopDelayMaxSeconds: loop?.maxSeconds,
      eventLoopDelayP99Seconds: loop?.p99Seconds,
      // `_getActiveHandles` is internal and undocumented, so it is asked for
      // rather than assumed: a build without it reports no handle count, which
      // is a different fact from "none open" and the gauge simply does not emit.
      handles: activeHandles(),
      uptimeSeconds: process.uptime(),
      sseClients: this.sseClients(),
      sessions: sessions.agent,
      ptySessions: sessions.terminal,
    };
  }

  /** Every run across every plan, for the runs list. */
  async allRuns(): Promise<(RunState & { pendingDrafts?: number })[]> {
    const slugs = this.store?.list().map((r) => r.slug) ?? [];
    if (!this.root) return [];
    const runs = slugs.flatMap((slug) => listRuns(this.root!.path, slug, this.liveRunId()));
    await this.resolveAgainstBoard(runs);
    runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    // The run card counts its plan's drafts waiting on a person (#118) — on the
    // plan's NEWEST run only, since the drafts are the plan's, not every run's.
    const pending = new Map<string, number>();
    for (const draft of this.inboxIssueDrafts()) {
      if (draft.state === 'pending-approval') pending.set(draft.slug, (pending.get(draft.slug) ?? 0) + 1);
    }
    return runs.map((run) => {
      const count = pending.get(run.slug);
      if (!count) return run;
      pending.delete(run.slug);
      return { ...run, pendingDrafts: count };
    });
  }

  /**
   * Answer one PreToolUse hook call.
   *
   * The reply shape is the one a live session was measured accepting:
   * `hookSpecificOutput.permissionDecision`, with the reason handed to the
   * model so a denial reads as a decision it can work around rather than an
   * unexplained failure.
   */
  /** Per-session Stop-hook block counter — the loop guard. Bounded; cleared wholesale. */
  private stopBlocks = new Map<string, number>();

  /**
   * The Stop hook's decision: may this session end its turn?
   *
   * Yes when the phase's board reads done, or a valid outcome file is
   * declared, or the session's own subagents or monitors are still working in
   * the background (their notification wakes it), or the session was already blocked
   * twice (the loop guard), or anything about the question cannot be
   * answered — fail open, always: this
   * hook carries workflow, never safety, and the runner's own exit-time
   * check is the load-bearing layer. A block carries the precise
   * instructions: finish the closeout, or declare the wait.
   *
   * `hook.stop-seen` in the log doubles as the runtime probe for whether the
   * CLI fires Stop hooks in `-p` at all — designed not to matter either way.
   */
  async decideStop(body: Record<string, unknown>, runId?: string | null): Promise<Record<string, unknown>> {
    const allow = {};
    const sessionId = typeof body.session_id === 'string' ? body.session_id : null;
    if (!runId || !sessionId || !this.root?.ok) return allow;

    const state = this.runForToken(runId);
    if (!state) return allow;
    // WHICH phase this session belongs to — matched by session id against the
    // run's own records, never guessed from "the current phase".
    const entry = Object.values(state.phases).find((record) => record.sessionId === sessionId);
    const phase = entry?.phase ?? state.activePhase;
    if (phase == null) return allow;

    log.info('hook.stop-seen', { slug: state.slug, runId: state.id, phase });

    // The session's own agents and monitors still at work (autopilot-token-
    // drain phase 1). A lookup that throws is no evidence either way.
    let awaiting: BackgroundTask[] = [];
    try { awaiting = this.runnerByRunId(state.id)?.awaitingBackground?.(phase) ?? []; } catch { awaiting = []; }
    // A session ends when its agents do (control-tower phase 109, #188): an
    // EXIT — the board done, or a `partial`/`complete` declared — while one of
    // them still writes the tree is refused through the same refuse-twice
    // channel, with the two ways out. Waved through, the agent ran on for the
    // CLI's ten-minute ceiling and was killed mid-edit: 14 uncommitted paths
    // no handoff explained (ai-builder-v7 P16).
    const refuseExit = (): Record<string, unknown> | null => {
      if (!awaiting.length) return null;
      const blocks = this.stopBlocks.get(sessionId) ?? 0;
      if (blocks >= 2) return null;
      if (this.stopBlocks.size > 512) this.stopBlocks.clear();
      this.stopBlocks.set(sessionId, blocks + 1);
      log.info('hook.stop-background', {
        slug: state.slug, phase, sessionId, blocks: blocks + 1,
        tasks: awaiting.map((task) => ({ id: task.id, type: task.taskType ?? null, tool: task.tool ?? null })),
      });
      return {
        hookSpecificOutput: {
          hookEventName: 'Stop', decision: 'block',
          reason: backgroundExitRefusal(phase, state.slug, awaiting, Date.now()),
        },
      };
    };

    let qaOwed = false;
    try {
      const board = await this.board(state.slug);
      // Fail OPEN, the same way the catch below does: this hook decides whether
      // to hold a session's turn, and holding one on a board we could not read
      // is a worse error than letting a finished session stop.
      if (board.error) return allow;
      if (board.states[phase] === 'done') {
        // Done on the board is the finish line — unless this phase's own QA
        // regime still OWES a verdict: a `pending` row holds every dependent
        // exactly as a failure does, and this session is the one the boot
        // prompt told to dispatch it. A recorded verdict — a fail included —
        // means QA ran; the fix cycle belongs to the ladder and the finish
        // dispatcher, never to this hook. Fail open on any read that breaks.
        try {
          if ((await this.qaMode(state.slug, phase)).mode === 'on') {
            const verdict = await this.qaVerdict(state.slug, phase);
            qaOwed = verdict === 'pending' || verdict === 'none' || verdict === '';
          }
        } catch { qaOwed = false; }
        if (!qaOwed) return refuseExit() ?? allow;
      }
    } catch {
      return allow;
    }

    const declared = readOutcome(outcomeFileFor(state.root, state.slug, state.id, phase), {
      slug: state.slug, phase, ...(entry?.startedAt ? { notBefore: entry.startedAt } : {}),
    });
    if (declared) return (declared.status === 'partial' || declared.status === 'complete' ? refuseExit() : null) ?? allow;

    // A turn that ends while this session's own agents or monitors are still
    // working is a WAIT, not an exit (autopilot-token-drain phase 1): measured
    // under `-p`, an Agent or Monitor running in the background keeps the process alive and its
    // completion starts a new turn. Holding that turn instead is what left a
    // session nothing to do but poll its reviewer — 311 status-only calls in
    // one phase. A background SHELL is not in the list: it dies with the turn,
    // so a session ending on one is still told to finish or declare.
    if (awaiting.length) {
      log.info('hook.stop-awaiting', {
        slug: state.slug, phase, sessionId,
        tasks: awaiting.map((task) => ({ id: task.id, type: task.taskType ?? null, tool: task.tool ?? null })),
      });
      return allow;
    }

    const blocks = this.stopBlocks.get(sessionId) ?? 0;
    if (blocks >= 2) return allow;
    if (this.stopBlocks.size > 512) this.stopBlocks.clear();
    this.stopBlocks.set(sessionId, blocks + 1);
    log.info('hook.stop-blocked', { slug: state.slug, phase, sessionId, blocks: blocks + 1 });
    if (qaOwed) {
      // The report this session is being asked for, from the one chooser: the
      // Stop hook names a filename to a live session, and naming an occupied
      // one is how a committed report gets overwritten.
      const owed = nextQaRound(this.store?.get(state.slug)?.handoffDir, phase);
      return {
        hookSpecificOutput: {
          hookEventName: 'Stop',
          decision: 'block',
          reason: `Phase ${phase} of ${state.slug} is done on the board but its QA verdict is still owed — `
            + 'this plan gates on QA, and a pending row holds every dependent phase exactly as a '
            + 'failure does. Dispatch a FRESH-context QA subagent now, in the FOREGROUND, so the call '
            + 'returns with its verdict — get its brief with '
            + `\`bash ${SCRIPTS_REF}/phase-graph.sh ${state.slug} --qa-prompt ${phase}\` — and `
            + `record what it finds with \`bash ${SCRIPTS_REF}/qa-record.sh ${state.slug} ${phase} `
            + `<pass|fail|waived> --report ${owed.report} --round ${owed.round}\`. Then stop.`,
        },
      };
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'Stop',
        decision: 'block',
        reason: `Phase ${phase} of ${state.slug} is not closed: the board does not read done and no `
          + 'outcome is declared. If you are WAITING on an external process (a CI build, a deploy '
          + 'window), declare it now and stop — prose is invisible to the supervisor: '
          + `\`bash ${SCRIPTS_REF}/phase-outcome.sh ${state.slug} ${phase} `
          + 'waiting-external --wait-minutes <M> --reason "<what>" --watch <ref>` '
          + '(write the handoff `in-progress` first). Otherwise finish the closeout — run the '
          + 'plan\'s §Verification commands, commit with explicit paths, then run '
          + `\`bash ${SCRIPTS_REF}/new-handoff.sh ${state.slug} ${phase} <kebab-title> complete\` `
          + 'and fill it in.',
      },
    };
  }

  async decideToolUse(
    body: Record<string, unknown>, runId?: string | null,
    opts: { mechanism?: RelayMechanism } = {},
  ): Promise<Record<string, unknown>> {
    // The token says WHICH run this call came from, and with a pool that is the
    // only thing that does. Answering under "the current run" would classify a
    // call from a `guarded` run against a `bypass` neighbour's profile — a bug
    // that appears only when two things run at once, and is close to
    // unreadable when it does.
    const run = this.runForToken(runId);
    if (runId && !run) {
      log.warn('hook.run-unknown', {
        runId, note: 'no record on this machine explains this token — answered as guarded',
      });
    } else if (run && !this.runnerByRunId(run.id) && !this.storedTokenNamed.has(run.id)) {
      // A child that outlived its console (#21). Said ONCE per run: the call
      // that says it is one of ninety in forty-five minutes, and a line per
      // tool call is a line nobody reads.
      this.storedTokenNamed.add(run.id);
      if (this.storedTokenNamed.size > 256) this.storedTokenNamed.clear();
      log.info('hook.run-stored', {
        runId: run.id, slug: run.slug, profile: run.permissionProfile ?? 'guarded',
        note: 'nothing drives this run here — answered from its stored record',
      });
    }
    const toolName = String(body.tool_name ?? 'unknown');
    const input = body.tool_input;
    // WHICH lane asked — matched by session id the way `decideStop` does,
    // because a run may drive several phases at once and `activePhase` is only
    // the mirror lane. The phase decides whose per-phase options apply and
    // what the card is stamped with.
    const sessionId = typeof body.session_id === 'string' ? body.session_id : null;
    const lane = sessionId && run
      ? Object.values(run.phases).find((record) => record.sessionId === sessionId)
      : undefined;
    const phase = lane?.phase ?? run?.activePhase ?? null;

    // What this console has ever been asked about, which is what makes the
    // editor's "learn from the queue" list real rather than a guess.
    this.toolsSeen.add(toolName);

    // Read per call, not per run: a profile switched mid-run has to change the
    // very next classification, and the settings file the child already loaded
    // cannot be reloaded. This is the path that makes the switch immediate.
    const { profile, policy } = this.policyForRun(run);

    // The hook fires on every matching tool, so most calls have to be answered
    // here without troubling anyone. Only what the policy marks `ask` becomes a
    // card — a queue that fills up with `find docs -type f` is a queue nobody
    // reads, and one nobody reads trains the answer "yes".
    // The PATH-aware half (control-tower phase 90, #139): a clone into a run
    // worktree is the wall, and `git submodule` asks inside one and is allowed
    // in the run root. Read before the prefix rules, which cannot see a path.
    // A run with no root has no trees to guard — and this hook must answer,
    // never throw: `managedRoots` of an undefined root threw here and took the
    // whole decision with it (control-tower phase 104, #156).
    const guard = run?.root ? treeGuard(toolName, input, {
      cwd: typeof body.cwd === 'string' ? body.cwd : null,
      runRoot: run.root,
      runTrees: managedRoots({ root: run.root, consoleDir: consoleRunsDir(run.root) }),
      // The run's OWN checkout, for the detach rule (control-tower phase 112,
      // #183): only an isolated run has one, and a detached-by-design one owns
      // no branch a detach could break.
      ...(run.checkout === 'worktree' && run.workRoot ? {
        ownTree: run.workRoot,
        runBranch: run.gitMode === 'new-branch' ? `pe/${run.slug}` : null,
        detached: Boolean(run.detachAt),
      } : {}),
    }) : null;
    if (guard?.verdict === 'deny') {
      const bashCommand = (input as { command?: unknown } | null)?.command;
      this.runnerByRunId(run?.id ?? '')?.note('phase.tool-denied', {
        tool: toolName, rule: guard.rule,
        ...(typeof bashCommand === 'string' ? { command: bashCommand.replace(/\s+/g, ' ').slice(0, 400) } : {}),
      }, phase ?? undefined);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `blocked by the console (rule: ${guard.rule}): ${guard.reason} `
            + 'This is standing policy, not a person rejecting your work — do not retry it; read where it says instead.',
        },
      };
    }
    const verdict = guard?.verdict === 'allow'
      ? classifyTool(toolName, input, { ...policy, ask: policy.ask.filter((rule) => rule !== guard.rule) }, profile)
      : classifyTool(toolName, input, policy, profile);

    // The sign-in guard (control-tower phase 44, §Architecture 12's third birth
    // channel): an interactive sign-in in a supervised session waits on a
    // browser or a prompt nobody sees, so it is denied BEFORE it runs, with the
    // human step to declare instead. Outside `policy` like the in-turn-wait
    // guard below — identical on every profile, never a deny rule a strike
    // could remove — and on an `ask` as well as an `allow`: a person approving
    // the card would still leave the prompt where nobody can answer it. Only a
    // call this console can place is judged: with no run (an operator's own
    // terminal, a CLI this console does not drive) the hook stays out of it.
    // Journalled, never stamped on the record: `record.toolDenied` is the
    // permission wall's evidence, and there is nothing here to widen.
    if (verdict !== 'deny' && toolName === 'Bash' && run) {
      const bashCommand = (input as { command?: unknown } | null)?.command;
      let call: SignInCall | null = null;
      try { call = signInCall(bashCommand); } catch { call = null; }
      if (call) {
        try {
          this.runnerByRunId(run.id)?.note('phase.tool-denied', {
            tool: toolName, rule: 'sign-in', shape: call.shape, step: call.step.kind,
            command: signInJournalCommand(String(bashCommand)),
          }, phase ?? undefined);
        } catch { /* the deny stands */ }
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: signInRefusal(
              call, `bash ${this.flags.scriptsDir}/phase-outcome.sh ${run.slug} ${phase ?? '<N>'}`,
            ),
          },
        };
      }
    }

    // The gate-forge guard (control-tower phase 107, #174): a manual gate is a
    // person's, and its approval counts only from a person's door. A session
    // setting the console's own door, or writing the gate file with the file
    // tools, is denied before it runs — outside `policy` like the sign-in
    // guard, so no profile, strike or allow rule reaches it — and journalled,
    // never stamped on the record: there is nothing here a person may widen.
    if (verdict !== 'deny' && run) {
      let forged: string | null = null;
      try { forged = gateForgeCall(toolName, input); } catch { forged = null; }
      if (forged) {
        const bashCommand = (input as { command?: unknown } | null)?.command;
        try {
          this.runnerByRunId(run.id)?.note('phase.tool-denied', {
            tool: toolName, rule: GATE_FORGE_RULE, why: forged,
            ...(typeof bashCommand === 'string' ? { command: bashCommand.replace(/\s+/g, ' ').slice(0, 400) } : {}),
          }, phase ?? undefined);
        } catch { /* the deny stands */ }
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `blocked by the console (rule: ${GATE_FORGE_RULE}): ${forged}. `
              + 'A session never clears a manual gate: hand off and declare it — '
              + `\`bash ${this.flags.scriptsDir}/phase-outcome.sh ${run.slug} ${phase ?? '<N>'} needs-human --needs gates --reason "<what the gate needs>"\`.`,
          },
        };
      }
    }

    // The console-forge guard (control-tower phase 129, #218): a session never
    // presses its own console. A supervised call to a route or CLI verb in
    // `AUTHORITY_ROUTES` — answering a card, editing the policy, raising its
    // run's permissions, approving a gate, proving a person's step — or a write
    // into the console's state or config directories is denied before it runs.
    // Outside `policy` like `gate-forge`, so no profile, strike or allow rule
    // reaches it; the one door through is the plan's own `permission.destructive`
    // row naming the press for this phase, read as phase 107's auto-grant reads
    // it. Journalled, never stamped on the record: nothing here is a person's
    // to widen from a card.
    if (verdict !== 'deny' && run) {
      let forged: ConsoleForge | null = null;
      try {
        forged = consoleForgeCall(toolName, input, {
          stateDir: stateHome(), configDir: configDir(), ports: consolePorts(this.flags.port),
          cwd: typeof body.cwd === 'string' ? body.cwd : null,
        }, (forge) => this.forgeExcepted(run, phase, forge));
      } catch { forged = null; }
      if (forged) {
        const bashCommand = (input as { command?: unknown } | null)?.command;
        try {
          this.runnerByRunId(run.id)?.note('phase.tool-denied', {
            tool: toolName, rule: CONSOLE_FORGE_RULE, verb: forged.verb, why: forged.why,
            ...(forged.path ? { path: forged.path } : {}),
            ...(typeof bashCommand === 'string' ? { command: bashCommand.replace(/\s+/g, ' ').slice(0, 400) } : {}),
          }, phase ?? undefined);
        } catch { /* the deny stands */ }
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: consoleForgeRefusal(
              forged, `bash ${this.flags.scriptsDir}/phase-outcome.sh ${run.slug} ${phase ?? '<N>'}`,
            ),
          },
        };
      }
    }

    // The question class (TRS-1): a question, not a permission — held on every
    // profile. On a run whose relay is ARMED (phase 14) the relay answers it,
    // and the relay consults the deny list FIRST — the call's tool and every
    // option — so a question the wall would refuse is a question for a person,
    // never a window. Anywhere else the policy table answers a hold, and the
    // wall's own `deny` answers the rest below exactly as it always has.
    // The plan class (control-tower phase 11, #34): a plan-mode session
    // presenting its plan. Answered before the question block, which would
    // otherwise read any `hold` as a question for the relay.
    if (verdict === 'hold' && planRule(toolName, input)) return this.holdPlan(run, phase, input, sessionId);

    if (verdict === 'hold' || (verdict === 'deny' && questionRule(toolName, input))) {
      if (run && this.relayArmed(run)) {
        const reply = await this.relay.relayQuestion(run, phase, {
          mechanism: opts.mechanism ?? 'pre-tool-use',
          tool: toolName,
          input,
          ...(typeof body.tool_use_id === 'string' && body.tool_use_id ? { toolUseId: body.tool_use_id } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {}),
          policy,
          profile,
        });
        if (reply.kind !== 'not-relayed') return relayHookReply(reply);
      }
      if (verdict === 'hold') return this.holdQuestion(run, phase, toolName, input);
    }

    // Both guards below stand down while the lane verifies: `§Verification`
    // runs the phase's own commands, and a plan is entitled to a slow one there.
    const verifying = lane ? lane.status === 'verifying' || Boolean(lane.verifyingSince) || Boolean(lane.baselineSince) : false;

    // The poll-loop guard (autopilot-token-drain phase 2). The session's OWN
    // status checks go to its lane's tracker — never a subagent's: the CLI sets
    // `agent_id` only on a call made inside one — and the stream feeds that
    // tracker every other call the session makes, so six checks inside two
    // minutes with nothing between is a loop, and each check of the episode is
    // refused with what was seen and the wait procedure. Measured: 311 status
    // checks in one phase, 79 % of its context tokens.
    //
    // Shaped like the in-turn wait guard: outside `policy`, identical on every
    // profile, only ever turning an `allow` into a deny (a call the wall or a
    // person decides is neither counted nor refused here), and failing open — a
    // tracker that throws must not cost the session its call.
    //
    // Journalled, never stamped on the record: `record.toolDenied` is the
    // permission wall's evidence (the widen card, `blocked:permission`), and a
    // loop is not a wall. There is nothing to widen.
    if (verdict === 'allow' && run && typeof phase === 'number' && !verifying && !body.agent_id && isStatusCapable(toolName)) {
      const runner = this.runnerByRunId(run.id);
      let poll: PollVerdict | null = null;
      try { poll = runner?.observeToolCall?.(phase, { name: toolName, input }) ?? null; } catch { poll = null; }
      if (poll?.deny && poll.episode) {
        const notice = pollLoopNotice(poll.episode, `bash ${this.flags.scriptsDir}/phase-outcome.sh ${run.slug} ${phase}`);
        const command = (input as { command?: unknown } | null)?.command;
        try {
          runner?.note('phase.tool-denied', {
            tool: toolName, rule: 'poll-loop',
            ...(typeof command === 'string' ? { command: command.replace(/\s+/g, ' ').slice(0, 400) } : {}),
          }, phase);
          // The episode's first refusal also writes the notice into the session
          // — once per lane, the runner's rule — and says whether it landed.
          if (poll.episodeStart) {
            const nudged = runner?.nudgePollLoop?.(phase, notice) ?? false;
            runner?.note('phase.poll-loop', {
              ...poll.episode, firstAt: new Date(poll.episode.firstAt).toISOString(), nudged,
            }, phase);
          }
        } catch { /* the deny stands */ }
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: notice,
          },
        };
      }
    }

    // The in-turn wait guard. Deliberately OUTSIDE `policy` — not a deny rule,
    // not a profile, not a strike: `policy.deny` and all three profiles are
    // byte-identical before and after this block, and every profile gets the
    // guard, because a `bypass` run squatting a turn on `until … sleep` costs
    // exactly as much as a `guarded` one.
    //
    // Only on `allow`. An `ask` still goes to a person — a human looking at
    // the card is a better judge than this rule — and a `deny` is already
    // stopped with a better reason.
    //
    // Not while the lane is verifying: `§Verification` runs the phase's own
    // commands and a plan is entitled to a slow one there. That path has its
    // own bound (30 min per command) and its own signal (`verify-hanging`).
    //
    // A call this console cannot place — no run, no token — is allowed: the
    // hook fails open everywhere else and inventing a deny for a session we
    // are not driving would break an unsupervised CLI that happens to point at
    // this port.
    //
    // And a wait on the session's OWN job is allowed (autopilot-token-drain
    // phase 1, reversing part of RCV-5): one foreground call bounded by the
    // Bash timeout costs one call, and refusing it left a session with nothing
    // but a background job and a poll — measured at 311 status-only calls in
    // one phase. `waitScope` is the split the stall ladder already makes, read
    // off the same command: `REMOTE_WAIT` outranks, so `gh run watch … >
    // /tmp/ci.log` is still somebody else's clock, and anything that names
    // nothing local stays external — the refusal is the default.
    if (verdict === 'allow' && toolName === 'Bash' && run) {
      const bashCommand = (input as { command?: unknown } | null)?.command;
      const matched = verifying || typeof bashCommand !== 'string'
        ? null
        : inTurnWait(bashCommand, loadVerifyEnv(this.flags.scriptsDir));
      // The pids the session announced itself (`$!`) make a probe of one its own
      // clock (control-tower phase 47, AUD-34); any other pid is one it found.
      // Read defensively: a throw in this hook reaches the CLI as a failed hook,
      // and a failed hook is fail-open — the wait would run.
      const laneRunner = this.runnerByRunId(run.id);
      const ownPids = typeof phase === 'number' && typeof laneRunner?.ownPids === 'function'
        ? laneRunner.ownPids(phase) : undefined;
      if (matched && waitScope(bashCommand as string, { ownPids }) === 'external') {
        const runner = this.runnerByRunId(run.id);
        runner?.note('phase.tool-denied', { tool: toolName, rule: 'in-turn-wait', matched }, phase ?? undefined);
        // …and to the lane's own signals: a denied wait opens no call, so this is
        // the only way the local-job ladder learns the lane is still waiting on
        // what it was refused (RCV-5's firing half).
        // Bookkeeping never costs the refusal: a throw here would reach the CLI as
        // a failed hook, and a failed hook is fail-open — the wait would run.
        if (typeof phase === 'number' && typeof bashCommand === 'string') {
          try { runner?.noteWaitDenied(phase, { command: bashCommand, matched }); } catch { /* the deny stands */ }
        }
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              'the console does not let a supervised session wait inside a turn on somebody else\'s '
              + `clock (matched \`${matched}\`); a wait on a job this session started itself is allowed.\n`
              + waitProcedure(`bash ${this.flags.scriptsDir}/phase-outcome.sh ${run.slug} ${phase ?? '<N>'}`),
          },
        };
      }
    }

    // The guard's recipe, followed without its last step (TRS-3): the denial
    // above told the session to declare `waiting-external … --watch <ref>`,
    // and the measured session declared 37 s later with no ref at all — a
    // blind park, resumed 581 minutes late. The call is ALLOWED (a declaration
    // is never refused at the hook) and the gap is journalled here, where the
    // hook sees it first; the runner's ingestion then adopts a ref it can mint
    // or refuses the declaration (`parkWaiting`). Read from the persisted
    // denial on the record, not the lane's episode, which the declaring call
    // itself retires.
    if (verdict === 'allow' && toolName === 'Bash' && run && typeof phase === 'number') {
      const bashCommand = (input as { command?: unknown } | null)?.command;
      const declaring = typeof bashCommand === 'string'
        && /phase-outcome\.sh\s+\S+\s+\d+\s+waiting-external\b/.test(bashCommand)
        && !/\s--watch(?:[=\s]|$)/.test(bashCommand);
      const denied = (run.phases as Record<string, { toolDenied?: { rule: string; command?: string; matched?: string; at: string } } | undefined> | undefined)
        ?.[String(phase)]?.toolDenied;
      if (declaring && denied?.rule === 'in-turn-wait') {
        try {
          this.runnerByRunId(run.id)?.note('phase.watch-missing', {
            command: denied.command ?? null, matched: denied.matched ?? null, deniedAt: denied.at,
            declaration: (bashCommand as string).replace(/\s+/g, ' ').slice(0, 400), source: 'hook',
          }, phase);
        } catch { /* bookkeeping never costs the call */ }
      }
    }

    if (verdict !== 'ask') {
      // A veto is a decision this console made, and it was the one decision it
      // never wrote down: the deny happened inside a hook reply and left no
      // trace, so a phase that quietly worked around a blocked command was
      // unexplainable afterwards. Named rule included — "which line stopped
      // this" is the only question an operator asks next.
      const rule = verdict === 'deny' ? matchedDenyRule(toolName, input, policy) : null;
      if (verdict === 'deny') {
        // What was refused, bounded — the errand for a permission wall quotes
        // it verbatim (LFC-3), and a rule alone ("Bash(git push:*)") does not
        // say which push. A non-Bash tool's target rides `input` in a shape
        // this hook does not read; the tool name still says what it was.
        const bashCommand = (input as { command?: unknown } | null)?.command;
        const command = typeof bashCommand === 'string' ? bashCommand.replace(/\s+/g, ' ').slice(0, 400) : undefined;
        const runner = this.runnerByRunId(run?.id ?? '');
        // The journal of the run that was actually denied, found by token…
        runner?.note('phase.tool-denied', {
          tool: toolName, rule, ...(command ? { command } : {}),
        }, phase ?? undefined);
        // …and the record, which is what the classifier reads (LFC-3). Only a
        // RULE is a permission wall a person can widen; a deny the policy made
        // by shape alone (a hidden file, a wrapper) names none, and is left to
        // the session's declaration. Bookkeeping never costs the refusal.
        if (typeof phase === 'number' && rule) {
          try { runner?.noteToolDenied(phase, { tool: toolName, rule, ...(command ? { command } : {}) }); } catch { /* the deny stands */ }
        }
      }
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: verdict,
          permissionDecisionReason: verdict === 'allow'
            ? (profile === 'guarded'
              ? 'not on the autopilot ask list'
              : `this run is on the ${profile} profile — only the deny list stops it`)
            // Worded against what the model does with it. The old text was
            // close enough to the CLI's own rejection wording that a session
            // read standing policy as a person refusing its work, apologised,
            // and tried a way around it. This says whose decision it is, that
            // it will not change on a retry, and what to do instead.
            : `blocked by the console's deny list${rule ? ` (rule: ${rule})` : ''}. `
              + 'This is standing policy, not a person rejecting your work — do not retry the '
              + 'command or look for a way around it; note it in your handoff and carry on.',
        },
      };
    }

    // The ask still happened — the classifier said ask and the hook is open —
    // but a standing setting may hold the answering hand. Resolution:
    // phase option ?? plan policy file ?? global policy file ?? ON. A call the
    // token cannot place (no run) never auto-grants: an anomaly stays on a
    // card a person sees. Two shapes are held back even with auto on: a
    // wrapper whose hidden payload the deny list would stop (a silent yes
    // there is the wall failing), and nothing else — the operator chose the
    // fully hands-free reading, pushes included.
    // A person's answer on a card recovered after a restart, for this exact
    // call (TRS-11): the card's hook died with the console, and the session
    // asking again is the one moment that answer can still land. One-shot.
    const recoveredAnswer = run ? this.approvals.takeRecoveredAnswer(run.id, phase, toolName, input) : null;
    if (recoveredAnswer) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: recoveredAnswer.decision,
          permissionDecisionReason: recoveredAnswer.decision === 'allow'
            ? `approved by ${recoveredAnswer.by}, on a card recovered after the console restarted`
            : `not approved (${recoveredAnswer.by}), on a card recovered after the console restarted`
              + `${recoveredAnswer.reason ? `: ${recoveredAnswer.reason}` : ''}`,
        },
      };
    }

    // Which line of policy asked (LFC-9) — carried on the card and the grant.
    const matched = matchedAskRule(toolName, input, policy);
    // The publishing asks (TRS-4). The carve-out pins `git push` and
    // `gh pr create` so that publishing takes one human tap, and auto-grant
    // answered them 189 times with nobody asked. They are never auto-granted
    // unless the plan's `permission.destructive` row names the rule as an
    // exception — and a grant under one is announced.
    const publishing = publishingRule(toolName, input);
    // What the plan's `permission.destructive` row answers for this exact call
    // (#112): the whole rule, or — for a push — the branches it names. Its
    // `allow` is the plan's written answer, so it stands whatever auto-grant is
    // set to; a row that did not match rides the card, naming itself and why.
    const manifest = publishing && run ? this.manifestAnswerFor(run, phase, toolName, input) : null;
    const exception = manifest?.answer === 'allow' ? manifest : null;

    const scoped = run ? autoApproveFor(run.slug) : null;
    const phaseChoice = phase != null
      ? run?.phaseOptions?.[String(phase)]?.autoApprove
      : undefined;
    const autoOn = run != null && (phaseChoice ?? scoped?.effective ?? false);
    const level: keyof typeof AUTO_GRANT_REASONS = exception && !autoOn ? 'manifest'
      : phaseChoice !== undefined ? 'phase'
        : scoped?.plan != null ? 'plan'
          : scoped?.global != null ? 'global'
            : 'default';
    const command = toolName === 'Bash' ? (input as { command?: unknown } | null)?.command : null;
    const wrapperHeld = typeof command === 'string'
      && neverAutoApproves(command)
      && hitsHidden(command, toolName, policy.deny);
    if (run && !wrapperHeld && (publishing ? exception : autoOn)) {
      const rule = suggestedRule(toolName, input, policy);
      const approval = this.approvals.grant({
        runId: run.id,
        slug: run.slug,
        phase,
        kind: 'tool',
        title: `${toolName}: ${describeToolInput(input)}`,
        detail: `Phase ${phase ?? '?'} of ${run.slug} wants to use ${toolName}.`,
        evidence: await this.evidenceFor(phase),
        tool: { name: toolName, input, cwd: typeof body.cwd === 'string' ? body.cwd : undefined },
        suggestedRule: rule,
        matched,
        ...(exception ? { manifest: exception } : {}),
      }, 'auto-grant', exception
        ? `${AUTO_GRANT_REASONS[level]} — under this plan's permission.destructive exception for ${exception.rule}: ${exception.why}`
        : AUTO_GRANT_REASONS[level], { notify: Boolean(exception) });
      // The run journal's twin of `approval.auto-granted`, written HERE rather
      // than by the broker's record hook: this is the one grant site, and the
      // only place that knows which scope answered and under what exception.
      this.runnerByRunId(run.id)?.note(
        'phase.approval-auto-granted',
        {
          tool: toolName, rule, matched, level, approvalId: approval.id,
          ...(exception ? {
            answeredBy: exception.key,
            exception: {
              rule: exception.rule, value: exception.value, source: exception.source, why: exception.why,
              ...(exception.branch ? { branch: exception.branch } : {}),
            },
          } : {}),
        },
        phase ?? undefined,
      );
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: exception
            ? `approved by auto-grant from this plan's permission.destructive row (${exception.why}) — the plan's written answer, not a person reviewing this call`
            : 'approved by auto-grant — a standing console setting, not a person reviewing this call',
        },
      };
    }

    // A call a person allowed on a standing card after its hook call ended
    // (control-tower phase 97, #140): granted once, then it asks as usual.
    const granted = run && phase != null ? this.takeOneTimeGrant(run.id, phase, toolName, input) : false;
    if (granted) {
      this.runnerByRunId(run!.id)?.note('phase.approval-granted-once', { tool: toolName, approvalId: granted }, phase!);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'approved once by a person on its standing approval card — the next such call asks again',
        },
      };
    }

    // The row allows this push in its bare form, and this call is not that
    // form (control-tower phase 107, #186): a `git add` beside it, a `$( … )`
    // that writes, a branch the shell computes, a bare `git push`, a push in a
    // here-doc. Answered AT ONCE, naming the form to re-run alone — a card here
    // sat an hour, three times in two hours of one release phase, for an act
    // the plan permits in writing. Never a card, never the timeout.
    if (run && manifest?.answer === 'deny') {
      const bashCommand = (input as { command?: unknown } | null)?.command;
      this.runnerByRunId(run.id)?.note('phase.approval-reshaped', {
        tool: toolName, rule: manifest.rule, why: manifest.why, bareForm: manifest.bareForm ?? null,
        answeredBy: manifest.key, row: { value: manifest.value, source: manifest.source },
        ...(typeof bashCommand === 'string' ? { command: bashCommand.replace(/\s+/g, ' ').slice(0, 400) } : {}),
      }, phase ?? undefined);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reshapeReason(manifest),
        },
      };
    }

    const { approval, decided } = this.approvals.request({
      runId: run?.id ?? 'unknown',
      slug: run?.slug ?? 'unknown',
      phase,
      kind: 'tool',
      title: `${toolName}: ${describeToolInput(input)}`,
      detail: `Phase ${phase ?? '?'} of ${run?.slug ?? 'a run'} wants to use ${toolName}.`,
      evidence: await this.evidenceFor(phase),
      tool: { name: toolName, input, cwd: typeof body.cwd === 'string' ? body.cwd : undefined },
      suggestedRule: suggestedRule(toolName, input, policy),
      matched,
      // The row this call was checked against and why it did not answer it
      // (#112): a person sees the plan spoke, and what it did not cover.
      ...(manifest ? { manifest } : {}),
    // The run's own default (#140); absent, the hook call's hour. The broker
    // never lets it pass the hook's hard limit either way.
    }, run?.approvalTimeoutMinutes ? run.approvalTimeoutMinutes * 60_000 : undefined);

    // The card is a WAIT on the run that asked (WAI-10): `waitReason 'person'`,
    // the clock at the card's hour, the status `waiting` — until the card is
    // down, however it comes down. The run used to read `running` under it.
    // Inside a try, like every runner call on the hook path: a bookkeeping
    // failure must never cost the decision (a hook that throws fails OPEN).
    const asking = run && phase != null ? this.runnerByRunId(run.id) : null;
    try {
      asking?.enterPersonWait(phase!, {
        id: approval.id, until: approval.expiresAt, on: `approval card: ${toolName}`, tool: true,
        ...(typeof body.tool_use_id === 'string' && body.tool_use_id ? { toolUseId: body.tool_use_id } : {}),
      });
    } catch (error) { log.warn('hook.person-wait-failed', { runId: run?.id ?? null, phase, error: String(error) }); }
    let outcome: Awaited<typeof decided>;
    try {
      outcome = await decided;
    } finally {
      try { asking?.leavePersonWait(approval.id); } catch { /* the wait's end is bookkeeping too */ }
    }
    const { decision, by, reason } = outcome;

    // Nobody answered. The hook still has to be told something — silence fails
    // open — so it is told no, and the run is parked rather than left to treat
    // that no as a judgement about the work. See `Runner.park`.
    if (by === 'timeout' || by === 'standing') {
      // The run that asked, not whichever one happens to be first. Parking a
      // neighbour because this one's card timed out would stop a plan that had
      // done nothing wrong.
      // `awaiting-person`: a person was asked and did not answer (WAI-10).
      // The card's id rides the halt (#140): the park lifts when this phase
      // completes, and a card that STANDS is still the answer it waits for.
      this.runnerByRunId(run?.id ?? '')?.park(
        by === 'standing'
          ? `an approval stands past its hook call until ${approval.expiresAt.slice(11, 16)}Z: ${toolName} — `
            + `${describeToolInput(input)}; allowing it resumes the phase with a one-time grant`
          : `an approval went unanswered: ${toolName} — ${describeToolInput(input)}`,
        phase,
        'awaiting-person',
        { approvalId: approval.id },
      );
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: decision === 'allow'
          ? `approved by ${by}`
          : `not approved (${by})${reason ? `: ${reason}` : ''}`,
      },
    };
  }

  /**
   * The relay's transport (phase 14, spike S2): a `PermissionRequest` hook call.
   * Journalled as it arrived — the tool and what it was aimed at, never a secret
   * — then classified by exactly the path a `PreToolUse` call takes, the relay
   * included, and answered in this event's own wire shape:
   * `decision.behavior` is `allow` or `deny` and nothing else (chapter 09 row
   * 25), `updatedInput` rides an `allow`, `message` a `deny`. Never `ask`: this
   * event has no such answer, and a host that never answers is waiting behind it.
   */
  async decidePermissionRequest(
    body: Record<string, unknown>, runId?: string | null,
  ): Promise<Record<string, unknown>> {
    const run = this.runForToken(runId);
    const toolName = String(body.tool_name ?? 'unknown');
    const sessionId = typeof body.session_id === 'string' ? body.session_id : null;
    const lane = sessionId && run
      ? Object.values(run.phases).find((record) => record.sessionId === sessionId)
      : undefined;
    const phase = lane?.phase ?? run?.activePhase ?? null;
    if (run) {
      try {
        this.runnerByRunId(run.id)?.note('phase.permission-request', {
          tool: toolName,
          target: describeToolInput(body.tool_input).slice(0, 200),
          ...(sessionId ? { sessionId } : {}),
          ...(typeof body.permission_mode === 'string' ? { permissionMode: body.permission_mode } : {}),
          suggestions: Array.isArray(body.permission_suggestions) ? body.permission_suggestions.length : 0,
        }, phase ?? undefined);
      } catch { /* bookkeeping never costs the decision */ }
    }
    log.info('hook.permission-request', { runId: run?.id ?? null, tool: toolName, phase });
    const reply = await this.decideToolUse(body, runId, { mechanism: 'permission-request' });
    const said = (reply as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: unknown } })
      .hookSpecificOutput ?? {};
    const behavior = said.permissionDecision === 'allow' ? 'allow' : 'deny';
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior,
          ...(behavior === 'allow' && said.updatedInput ? { updatedInput: said.updatedInput } : {}),
          ...(behavior === 'deny' && said.permissionDecisionReason ? { message: said.permissionDecisionReason } : {}),
        },
      },
    };
  }

  /**
   * Is the relay armed for this run — `relay: last-resort`, and armed at the
   * spawn door against the CLI's `system/init` version (`run.relayArming`)?
   * A run on the floor answers a question by policy instead (`holdQuestion`).
   */
  protected relayArmed(run: RunState): boolean {
    return run.relay === 'last-resort' && run.relayArming?.armed === true;
  }

  /**
   * A person's answer to a relayed question (`POST /api/run/:slug/answer`):
   * one pick or several, by question key (or text) and option label, landing
   * inside the window. The relay says whether it took them.
   */
  answerQuestion(
    slug: string, approvalId: string, picks: readonly { key?: string; question?: string; label: string }[], by: string,
  ): { ok: true; answered: string[]; remaining: number } | { ok: false; status: number; error: string } {
    const card = this.approvals.pending().find((approval) => approval.id === approvalId);
    if (card && card.slug !== slug) return { ok: false, status: 404, error: `no question under that id on ${slug}` };
    return this.relay.answer(approvalId, picks, by);
  }

  /**
   * Answer a call in the question class (TRS-1) on a run whose relay is not
   * armed — `relay: off`, a CLI below the floor, or no version read yet.
   *
   * A question for a person, on a run nobody is watching, is answered by the
   * plan's `ambiguity` row (the policy table; default `ruling`): the session is
   * told to decide from the plan and record the call, or — when the plan wants
   * a person — to declare `needs-human` and stop. The hook itself is told
   * `deny`, because the CLI takes only allow or deny here and a bare `allow`
   * carries no answer; the reason is the policy's answer, in the register of
   * `frameQuestion`, so it is never read as a person rejecting the work. The
   * question and the answer go on the run's journal as
   * `phase.policy-answered {decision: 'hold'}`. Phase 14 put the relay IN
   * FRONT of this (`relayArmed`) and kept it as the answer when the relay is off.
   */
  private holdQuestion(
    run: RunState | null, phase: number | null, toolName: string, input: unknown,
  ): Record<string, unknown> {
    const resolved = policyForKey('ambiguity', run, policyPrefsOf(this.prefs));
    const answer = resolved?.answer ?? 'ruling';
    const questions = questionsOf(input);
    if (run && typeof phase === 'number') {
      try {
        this.runnerByRunId(run.id)?.note('phase.policy-answered', {
          decisionKey: 'ambiguity', answer, source: resolved?.source ?? 'default', phase,
          decision: 'hold', class: 'question', tool: toolName, by: 'policy',
          ...(questions.length ? { questions } : {}),
        }, phase);
      } catch { /* bookkeeping never costs the answer */ }
    }
    const outcome = `bash ${this.flags.scriptsDir}/phase-outcome.sh ${run?.slug ?? '<slug>'} ${phase ?? '<N>'}`;
    const reason = answer === 'ruling'
      ? 'No one can answer a question mid-run on this run — the console answered it by policy '
        + '(ambiguity: ruling). This is NOT a refusal of your work and NOT a change to the phase: decide it '
        + `yourself from the plan, record the call with \`${outcome} ruling --kind ambiguity --what "<what you `
        + 'decided>" --why "<why>"`, and carry on. If it genuinely needs a person, declare '
        + `\`${outcome} blocked --needs <key> --reason "<what you need>"\` and stop.`
      : `This plan wants a person to settle a question like this (ambiguity: ${answer}), and no relay is armed `
        + 'on this run to ask one. Do not guess and do not ask again: hand off `in-progress`, declare '
        + `\`${outcome} needs-human --needs ambiguity --reason "<the question>"\`, and stop — the operator `
        + 'answers the errand.';
    return {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    };
  }

  /**
   * Answer `ExitPlanMode` (control-tower phase 11, #34) — a plan-mode session
   * handing its plan over. The plan is captured under the run's directory and
   * journalled (`phase.plan-presented {bytes, sha}`), then the plan's
   * `plan-approval` decision answers: `continue` approves it here and lets the
   * call through (the journal keeps what was approved); `hold`, the default,
   * declares the session's `needs-human --needs plan-approval` for it, denies
   * with the instruction to end the turn, and leaves the park to the
   * declared-outcome path — kind `plan-approval`, an errand, an inbox row with
   * Approve and Reject (`decidePlan`).
   *
   * A call this console cannot place — no run, no lane, no plan text, no
   * runner holding the run — is let through: the hook fails open everywhere
   * else, and holding a plan nobody can decide would strand the session.
   */
  private holdPlan(
    run: RunState | null, phase: number | null, input: unknown, sessionId: string | null,
  ): Record<string, unknown> {
    const allow = (reason: string) => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: reason },
    });
    const plan = planOf(input);
    const runner = run ? this.runnerByRunId(run.id) : null;
    if (!run || typeof phase !== 'number' || !plan || !runner) {
      return allow('no run this console drives holds this plan, so it is not held');
    }
    const presented = runner.presentPlan(phase, plan, sessionId ?? undefined);
    if (!presented) return allow('the console could not keep this plan, so it is not held');
    const resolved = policyForKey('plan-approval', run, policyPrefsOf(this.prefs));
    if (resolved?.answer === 'continue') {
      runner.continuePlan(phase, presented, resolved.source);
      return allow(planContinueReason(presented));
    }
    runner.holdPlan(phase, presented, sessionId ?? undefined);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: planHeldReason(presented),
      },
    };
  }

  /**
   * The plan a plan-mode phase presented, as the console kept it (control-tower
   * phase 17, #34) — `GET /api/run/:slug/plan-text?phase=N`. The halt card's
   * reader draws THIS, not a byte count: a person cannot approve a plan they
   * were only told the size of. The file is found where the runner writes it
   * (`planTextFile`, from the record's own sha) rather than at the path the run
   * file names, so a hand-edited run file cannot point the read anywhere else.
   */
  planText(slug: string, phase: number): (
    | { ok: true; phase: number; sha: string; bytes: number; at: string; state: string; truncated: boolean; text: string }
    | { ok: false; status: number; error: string }
  ) {
    if (!this.root?.ok) return { ok: false, status: 409, error: 'No source directory is open.' };
    const stored = this.liveRunner(slug)?.current() ?? latestRun(this.root.path, slug, this.liveRunId());
    const held = stored?.phases[String(phase)]?.planApproval;
    if (!stored || !held) return { ok: false, status: 404, error: `phase ${phase} of ${slug} presented no plan` };
    let text: string;
    try {
      text = readFileSync(planTextFile(stored.root, slug, stored.id, phase, held.sha), 'utf8');
    } catch {
      return { ok: false, status: 404, error: `the plan phase ${phase} presented is no longer on disk` };
    }
    return {
      ok: true, phase, sha: held.sha, bytes: held.bytes, at: held.at, state: held.state,
      truncated: Boolean(held.truncated), text,
    };
  }

  /**
   * A person's answer to a held plan (control-tower phase 11, #34) —
   * `POST /api/run/:slug/plan-approval`. Approve journals `phase.plan-approved
   * {by}` and resumes the SAME session through the recover verb, whose spawn
   * runs `acceptEdits` (`resumeWithInstruction` names no mode). Reject
   * journals `phase.plan-rejected` and leaves the phase parked, its errand
   * standing, for the person's next move — Resume with an instruction, or
   * Retry, which boards a fresh plan-mode session.
   */
  async decidePlan(
    slug: string, phase: number, decision: PlanDecision, by: string, reason?: string,
  ): Promise<{ ok: true; decision: PlanDecision; sha: string } | { ok: false; status: number; error: string }> {
    if (!this.root?.ok) return { ok: false, status: 409, error: 'No source directory is open.' };
    const live = this.liveRunner(slug);
    const stored = live?.current() ?? latestRun(this.root.path, slug, this.liveRunId());
    const held = stored?.phases[String(phase)]?.planApproval;
    if (!stored || held?.state !== 'pending') {
      return { ok: false, status: 409, error: `no plan waits for a decision on phase ${phase} of ${slug}` };
    }
    const at = new Date().toISOString();
    const event = decision === 'approve' ? 'phase.plan-approved' : 'phase.plan-rejected';
    const data = { by, sha: held.sha, ...(reason ? { reason: reason.slice(0, 2000) } : {}) };
    const decide = (state: RunState) => {
      const record = phaseRecord(state, phase);
      if (record.planApproval?.sha !== held.sha) return;
      record.planApproval = {
        ...record.planApproval,
        state: decision === 'approve' ? 'approved' : 'rejected',
        by, decidedAt: at, ...(reason ? { reason: reason.slice(0, 2000) } : {}),
      };
    };
    const runner = this.runnerByRunId(stored.id);
    if (runner?.current()?.id === stored.id) {
      runner.recordPlanDecision(phase, decide, event, data);
    } else {
      this.editStoredRunById(slug, stored.id, (state) => {
        decide(state);
        this.journalStoredEdit(state, event, { ...data, phase }, asActor(by, 'Service.decidePlan'));
      });
    }
    if (decision === 'approve') {
      await this.recoverPhase(slug, phase, 'resume', { instruction: planApprovedInstruction(by, held), by });
    }
    return { ok: true, decision, sha: held.sha };
  }

  /**
   * May the console push THIS run's branches (many-plans-one-repo phase 8)?
   * Two gates, both required: the console was started with `--allow-publish`,
   * and the plan's `permission.destructive` row names `git push` as an
   * exception for this phase (a per-phase row outranks the plan-wide one,
   * exactly as the carve-out's auto-grant reads it). A preference is not a
   * plan's decision, so nothing in Settings can widen this.
   */
  protected override publishAllowedFor(state: RunState, phase: number): boolean {
    if (!this.flags.allowPublish) return false;
    return this.destructiveException(state, phase, PUSH_DENY) !== null;
  }

  /**
   * The plan's `permission.destructive` exception for one publishing rule, or
   * null (TRS-4). Read from the plan's own rows merged for this phase — a
   * per-phase row outranks the plan-wide one — and from the run's manifest when
   * the plan is not in this console's store. Only the manifest may carve the
   * exception: a console preference is not a plan's decision.
   */
  private destructiveException(
    run: RunState, phase: number | null, rule: string,
  ): { rule: string; value: string; source: string } | null {
    const row = this.destructiveRow(run, phase);
    // Read for THIS phase (control-tower phase 107, #205): a rule the row
    // names for other phases only is no exception here.
    if (!row || !destructiveExceptions(row.value, { phase }).includes(rule)) return null;
    return { rule, value: row.value.slice(0, 200), source: row.source };
  }

  /**
   * Does the plan's `permission.destructive` row name this forged press for
   * the running phase (control-tower phase 129)? Read for THIS phase, as the
   * auto-grant reads the row (`destructiveExceptions`), by the press's own CLI
   * form; never the console's own files. Every press on a line is asked.
   */
  private forgeExcepted(run: RunState, phase: number | null, forged: ConsoleForge): boolean {
    const row = this.destructiveRow(run, phase);
    if (!row) return false;
    return consoleForgeException(destructiveExceptions(row.value, { phase }), forged) !== null;
  }

  /**
   * The answered `permission.destructive` row for one phase of a run — the
   * plan's own rows merged for this phase (a per-phase row outranks the
   * plan-wide one), else the run's stored manifest when the plan is not in this
   * console's store.
   */
  private destructiveRow(run: RunState, phase: number | null): { value: string; source: string } | null {
    const record = this.store?.get(run.slug);
    const rows: readonly { key: string; state: string; value: string; source?: string }[] = record
      ? mergeDecisions(record.plan?.decisions ?? [], record.decisionsTwin ?? [], phase)
      : (run.manifest?.decisions ?? []);
    const row = rows.find((r) => r.key === 'permission.destructive' && r.state === 'answered');
    return row ? { value: row.value, source: row.source ?? (record ? 'plan' : 'run') } : null;
  }

  /**
   * What this plan's `permission.destructive` row answers for ONE publishing
   * call (control-tower phase 84, #112; phase 107, #186, #205) — or null when
   * the call publishes nothing or no row is answered. Judged by
   * `manifestVerdict` on what the line RUNS, for THIS phase: a whole rule or a
   * command the row names for the phase answers `allow`; a push of a branch
   * it names, with read-only company, answers `allow`; the same push in a
   * shape the row cannot answer as it stands answers `deny`, naming the bare
   * form; anything else is null, a person's card. The run branch is
   * `pe/<slug>` under the new-branch strategy, so "the run branch" in a row
   * reads as that.
   */
  private manifestAnswerFor(run: RunState, phase: number | null, toolName: string, input: unknown): ManifestCheck | null {
    const rule = publishingRule(toolName, input);
    if (!rule) return null;
    const row = this.destructiveRow(run, phase);
    if (!row) return null;
    const base = { key: 'permission.destructive' as const, rule, value: row.value.slice(0, 200), source: row.source };
    const command = toolName === 'Bash' ? (input as { command?: unknown } | null)?.command : null;
    if (typeof command !== 'string') {
      return destructiveExceptions(row.value, { phase }).includes(rule)
        ? { ...base, answer: 'allow', why: `the row allows ${rule}` }
        : { ...base, answer: null, why: `the row does not name ${rule} as an exception` };
    }
    const verdict = manifestVerdict(command, row.value, {
      runBranch: run.gitMode === 'new-branch' ? `pe/${run.slug}` : null, phase,
    });
    // The row answers the publishing act ALONE. What else the line runs is
    // judged as if it ran on its own: one this run's policy would not simply
    // allow — an ask, a hold — makes the answer a `deny` naming the bare form,
    // so a manifest exception never carries an unrelated command past the ask
    // list (control-tower phase 107).
    if (verdict.answer === 'allow' && verdict.companions?.length) {
      const { profile, policy } = this.policyForRun(run);
      const asked = verdict.companions.find((text) => classifyTool('Bash', { command: text }, policy, profile) !== 'allow');
      if (asked) {
        return {
          ...base, rule: verdict.rule ?? rule, answer: 'deny',
          why: `a command beside it is one this run asks about on its own: ${asked.slice(0, 120)}`,
          ...(verdict.bareForm ? { bareForm: verdict.bareForm } : {}),
        };
      }
    }
    return {
      ...base, rule: verdict.rule ?? rule, answer: verdict.answer, why: verdict.why,
      ...(verdict.branch ? { branch: verdict.branch } : {}),
      ...(verdict.bareForm ? { bareForm: verdict.bareForm } : {}),
    };
  }

  /**
   * The policy one run's calls are classified under, read per call: its
   * profile, with the openPr carve-out — for a new-branch run that will open a
   * PR, bare `git push` is an ask (a card, one human tap) instead of a deny,
   * and `gh pr create` stays an ask even under `trusted` — and the publish
   * carve-out (phase 8): a plan that lands by pull request boards landing
   * sessions whose `gh pr create`/`gh pr merge` ask under every profile. The
   * push is never theirs — the wall stands. A call with no run is `guarded`.
   */
  private policyForRun(run: RunState | null | undefined): { profile: PermissionProfile; policy: ReturnType<typeof carvedPolicy> } {
    const profile: PermissionProfile = run?.permissionProfile ?? 'guarded';
    const policy = carvedPolicy(
      loadPolicyFor(run?.slug ?? null), profile,
      run?.gitMode === 'new-branch' && run.openPr !== false,
      run ? this.planPublishes(run.slug) : false,
    );
    return { profile, policy };
  }

  /** The broker's re-read at settle time (#112): the run that raised the card, live or stored. */
  protected override manifestAnswerForCard(approval: Approval): ManifestCheck | null {
    if (!approval.tool) return null;
    const run = this.runForToken(approval.runId);
    return run ? this.manifestAnswerFor(run, approval.phase, approval.tool.name, approval.tool.input) : null;
  }

  /**
   * What a person would have gone and looked up before answering. A bare
   * "allow this?" automates the ceremony of approval and deletes its substance.
   */
  private async evidenceFor(phase: number | null): Promise<Evidence[]> {
    const evidence: Evidence[] = [];
    const root = this.root?.path;
    if (!root) return evidence;

    const [status, diff] = await Promise.all([
      gitRead(root, ['status', '--short']),
      gitRead(root, ['diff', '--stat']),
    ]);
    if (status) evidence.push({ label: 'Working tree', body: status });
    if (diff) evidence.push({ label: 'Uncommitted changes', body: diff });

    const run = this.runStates()[0] ?? null;
    const record = phase === null ? undefined : run?.phases[String(phase)];
    if (record?.verification?.ran.length) {
      evidence.push({
        label: 'Verification so far',
        body: record.verification.ran.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.command}`).join('\n'),
      });
    }
    if (record?.gate) {
      evidence.push({ label: 'Phase gate', body: `${record.gate.kind}: ${record.gate.detail}` });
    }
    return evidence;
  }

  runJournal(slug: string, id: string, limit = 500) {
    if (!this.root) return [];
    return Journal.for(this.root.path, slug, id).read(limit);
  }

  /**
   * How many journal entries the timeline reads.
   *
   * Far above the 500 the Journal panel takes, because the two want opposite
   * ends of the file: the panel wants the newest lines, the projection needs
   * the OPENING of every lane it draws. A tail that starts mid-boarding yields
   * a confident, wrong picture, so the read is generous and whatever it still
   * cuts is reported as `truncated` rather than smoothed over.
   */
  static readonly TIMELINE_ENTRIES = 20_000;

  /**
   * The run as lanes on one absolute axis, from the journal.
   *
   * The plan's own dependency rows ride along so the projection can overlay
   * the MEASURED critical path — the longest dependency chain weighted by what
   * each lane actually took, which is a different question from the estimated
   * one on the plan page and is only answerable after the fact.
   */
  runTimeline(slug: string, id?: string): RunTimeline {
    const runId = id ?? this.runIdFor(slug);
    const limit = Service.TIMELINE_ENTRIES;
    if (!this.root || !runId) return projectTimeline([], { now: Date.now() });
    const entries = Journal.for(this.root.path, slug, runId).read(limit);
    const rows = this.store?.get(slug)?.plan?.graph ?? [];
    return projectTimeline(entries, {
      now: Date.now(),
      deps: new Map(rows.map((row) => [row.phase, row.dependsOn])),
      // `read` returns the LAST n lines, so a full basket means there was more
      // above it. Equality, not `>`: the reader cannot return more than it took.
      truncated: entries.length >= limit,
      // What the LIVE lanes have spent and reached so far. The journal learns
      // a session's cost when it ENDS, so an open attempt read from the file
      // alone draws $0.00 for as long as it lasts — which is precisely the
      // minute an operator is asking the cost axis about.
      live: (this.liveRunner(slug)?.liveness() ?? []).map((lane) => ({
        phase: lane.phase,
        ...(typeof lane.spentUsd === 'number' ? { spentUsd: lane.spentUsd } : {}),
        ...(typeof lane.tokens?.context === 'number' ? { contextTokens: lane.tokens.context } : {}),
      })),
    });
  }


  /**
   * One phase's boardings, and what changed between each consecutive pair.
   *
   * Both halves come from the same journal read: a comparison assembled from
   * two reads could straddle an append and report a difference that is really
   * a race.
   */
  phaseAttempts(slug: string, phase: number, id?: string): {
    runId: string | null;
    attempts: AttemptSummary[];
    comparisons: AttemptComparison[];
  } {
    const runId = id ?? this.runIdFor(slug);
    if (!this.root || !runId) return { runId: null, attempts: [], comparisons: [] };
    const entries = Journal.for(this.root.path, slug, runId).read(Service.TIMELINE_ENTRIES);
    const attempts = attemptsOf(entries, phase);
    return { runId, attempts, comparisons: compareConsecutive(attempts) };
  }

  /**
   * The run's ledger (zero-touch phase 19) — why each start happened, what every
   * session cost and ran, what each rung spent — held to the run's own spend.
   *
   * Read as generously as the timeline, and for its reason: the ledger needs the
   * OPENING of the run (its first `run.start`, its early sessions), which the
   * Journal panel's tail would not hold. Whatever the read still cuts is
   * reported as `truncated` on the totals.
   */
  runLedger(slug: string, id?: string): RunLedger {
    const runId = id ?? this.runIdFor(slug);
    if (!this.root || !runId) return projectLedger([], null);
    const entries = Journal.for(this.root.path, slug, runId).read(Service.TIMELINE_ENTRIES);
    const run = loadRun(this.root.path, slug, runId, this.liveRunId());
    return projectLedger(entries, { id: runId, spentUsd: run?.spentUsd ?? null }, {
      truncated: entries.length >= Service.TIMELINE_ENTRIES,
    });
  }

  /** How many of a plan's newest runs the summary reads — history beyond them is the run pages'. */
  static readonly LEDGER_SUMMARY_RUNS = 20;

  /** Each run's projection for the summary, keyed on its journal's stamp and the run's spend. */
  private readonly ledgerCache = new Map<string, { stamp: string; ledger: RunLedger }>();

  /**
   * Every open plan's newest runs, their ledgers aggregated per plan and per
   * account — what Insights draws. A run's projection is cached on its journal
   * file's mtime+size (and the run's spend), so a refresh re-reads only the
   * journals that moved.
   */
  ledgerSummary(): LedgerSummary {
    if (!this.root?.ok) return summariseLedgers([]);
    const root = this.root.path;
    const slugs = (this.store?.list() ?? []).map((record) => record.slug).filter((slug) => !this.isClosedPlan(slug));
    const ledgers = slugs.flatMap((slug) =>
      listRuns(root, slug, this.liveRunId())
        .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
        .slice(0, Service.LEDGER_SUMMARY_RUNS)
        .map((run) => {
          let stamp = 'absent';
          try {
            const info = statSync(journalFile(root, slug, run.id));
            stamp = `${info.mtimeMs}:${info.size}:${run.spentUsd ?? ''}`;
          } catch {
            /* no journal yet: nothing to count */
          }
          const key = `${slug}/${run.id}`;
          const hit = this.ledgerCache.get(key);
          if (hit && hit.stamp === stamp) return { slug, ledger: hit.ledger };
          const entries = stamp === 'absent' ? [] : Journal.for(root, slug, run.id).read(Service.TIMELINE_ENTRIES);
          const ledger = projectLedger(entries, { id: run.id, spentUsd: run.spentUsd ?? null }, {
            truncated: entries.length >= Service.TIMELINE_ENTRIES,
          });
          this.ledgerCache.set(key, { stamp, ledger });
          return { slug, ledger };
        }));
    return summariseLedgers(ledgers);
  }

  /* ------------------------------------------------------------------ *
   * The repository browse surface
   *
   * `git-browse.ts` holds the git and the parsing; this layer holds the two
   * things it deliberately does not know — WHICH directories exist (the
   * allowlist is assembled from the console's own state, never from a caller)
   * and WHICH runs to join against.
   *
   * The join is over `listRuns`, not over the live runners, and that is the
   * whole reason this surface exists: `runGit` reads a live runner's cache and
   * answers `null` for a shared run, an unowned run and a refused one alike,
   * so the moment a run stops, every directory and branch it left behind
   * becomes unattributable. A record outlives its runner.
   * ------------------------------------------------------------------ */

  /** How many runs' journals the settle history reads, newest first. */
  static readonly SETTLE_RUNS = 25;

  /**
   * Journal entries read per run for the settle history.
   *
   * A TAIL, and the response says so (`scanned`). Settling is the last thing a
   * run does, so the tail is where its own settle rows are; a lane that landed
   * early in a long run can fall off the end, and a surface that did not
   * report the window would show that as "never landed".
   */
  static readonly SETTLE_ENTRIES = 500;

  /** Every run record this console holds, newest first, with liveness. */
  private repoRuns(): { state: RunState; live: boolean }[] {
    if (!this.root) return [];
    const live = this.liveRunIds();
    const root = this.root.path;
    return (this.store?.list() ?? [])
      .flatMap((record) => listRuns(root, record.slug, live))
      .map((state) => ({ state, live: live.has(state.id) }))
      .sort((a, b) => (a.state.createdAt < b.state.createdAt ? 1 : -1));
  }

  /**
   * Every directory the checkout registry decides `managed` against — each
   * home a console-made tree may stand in, whichever root is configured.
   */
  private repoManagedRoots(): string[] | undefined {
    return this.root
      ? managedRoots({ root: this.root.path, consoleDir: consoleRunsDir(this.root.path) })
      : undefined;
  }

  /** The trees `pe/integration` may live in — one per worktree root, by identity. */
  private repoStagingDirs(): string[] | undefined {
    if (!this.root) return undefined;
    const root = this.root.path;
    const consoleDir = consoleRunsDir(root);
    return [...new Set(WORKTREE_ROOTS.map((mode) => stagingNames(stagingHome({ mode, root, consoleDir })).dir))];
  }

  /** The directories this console will answer repository questions about. */
  async repoTargets(): Promise<RepoTarget[]> {
    if (!this.root) return [];
    const mounts = [...new Set(this.repoRuns().flatMap(({ state }) => state.mountedRepos ?? []))];
    return targetsOf({ root: this.root.path, managed: this.repoManagedRoots(), mounts });
  }

  /**
   * A caller's repository key, resolved against the allowlist.
   *
   * `null` is a refusal and the routes answer 404 with it. Never a fallback to
   * the root: a client that asked about a checkout and silently got the root
   * would render one repository's history under another's name.
   */
  private async repoTarget(key?: string | null): Promise<RepoTarget | null> {
    if (!this.root) return null;
    // The common ask short-circuits: assembling the allowlist costs a
    // `worktree list` AND a `listRuns` scan of every plan (for the mirror
    // mounts), which is a lot of disk to resolve the absence of a parameter.
    if (!key || key === 'root') return rootTarget(this.root.path);
    return pickTarget(await this.repoTargets(), key);
  }

  /**
   * The commit graph, or WHY not — the same two refusals the diff surface has.
   *
   * `unknown-repo` is a 404; `null` is a 400, and it means the caller named
   * refs and this repository has none of them. Quietly answering the DEFAULT
   * graph instead — which is what it used to do — hands a client a picture of
   * something it did not ask about. (P8 QA round 4, Low.)
   */
  async repoGraph(opts: {
    repo?: string; refs?: string[]; all?: boolean; limit?: number; cursor?: string;
  } = {}): Promise<RepoGraph | 'unknown-repo' | null> {
    const target = await this.repoTarget(opts.repo);
    if (!target) return 'unknown-repo';
    return commitGraph(target.dir, opts);
  }

  async repoBranches(repo?: string): Promise<RepoBranches | null> {
    const target = await this.repoTarget(repo);
    return target ? branchList(target.dir, { managed: this.repoManagedRoots() }) : null;
  }

  async repoCheckouts(): Promise<{ checkouts: RepoCheckout[]; truncated: boolean } | null> {
    if (!this.root) return null;
    return checkoutList({
      root: this.root.path,
      managed: this.repoManagedRoots(),
      staging: this.repoStagingDirs(),
      runs: this.repoRuns(),
    });
  }

  /**
   * A bounded diff, or WHY not — the two refusals answer different statuses.
   *
   * `unknown-repo` is a 404 (that repository is not one we answer about);
   * `null` is a 400 (the range or the path did not validate, or does not
   * resolve here). Collapsing them would make an unknown key and an
   * unparseable ref indistinguishable to a client trying to show a useful
   * message.
   */
  async repoDiff(opts: {
    repo?: string; base?: string; tip?: string; path?: string;
    bytes?: number; unified?: number;
  } = {}): Promise<RepoDiff | 'unknown-repo' | null> {
    const target = await this.repoTarget(opts.repo);
    if (!target) return 'unknown-repo';
    return diffOf(target.dir, {
      base: opts.base, tip: opts.tip, path: opts.path,
      maxBytes: opts.bytes, unified: opts.unified,
    });
  }

  /** Where each run's work ended up, newest first, over a stated window. */
  repoSettles(opts: { limit?: number; slug?: string; runs?: number; entries?: number } = {}): {
    events: SettleEvent[];
    truncated: boolean;
    scanned: { runs: number; entriesPerRun: number };
  } {
    const runCap = Math.max(1, Math.min(opts.runs ?? Service.SETTLE_RUNS, 50));
    const entryCap = Math.max(50, Math.min(opts.entries ?? Service.SETTLE_ENTRIES, 5_000));
    if (!this.root) {
      return { events: [], truncated: false, scanned: { runs: 0, entriesPerRun: entryCap } };
    }
    const root = this.root.path;
    const runs = this.repoRuns()
      .filter(({ state }) => !opts.slug || state.slug === opts.slug)
      .slice(0, runCap);
    const history = settleHistory(
      runs.map(({ state }) => ({
        state,
        entries: Journal.for(root, state.slug, state.id).read(entryCap),
      })),
      { limit: opts.limit },
    );
    return { ...history, scanned: { runs: runs.length, entriesPerRun: entryCap } };
  }


  savePreferences(input: Partial<Prefs> & { automation?: unknown }, opts: { by?: string } = {}): Prefs {
    // 🔑 **Either shape, one allowlist.** 3.5.0's `automation` object is
    // FLATTENED here and then picked apart exactly as a flat patch is, so the
    // object can never become a second door with its own coercion rules — or,
    // as it was until this was written, a door that answered 200 and wrote
    // nothing at all, because every branch below reads `patch.<flatKey>` and
    // an object patch has none of them.
    //
    // The flat keys win where a patch carries both, which is the opposite of
    // the LOADER's precedence and deliberately so: on disk the object is the
    // newer shape and speaks for the file, but in a patch a flat key is what
    // the settings page sends for the one control the operator just touched.
    const patch: Partial<Prefs> = { ...fromAutomation(input.automation), ...input };

    // The patch arrives straight off an HTTP body, so it is picked apart
    // allowlist-style: only keys this type has, with the types they take. A
    // client must not write arbitrary JSON into config.json, and a mistyped
    // value is dropped — the stored value survives — rather than persisted.
    const picked: Partial<Prefs> = {};
    if (Array.isArray(patch.recentRoots)) picked.recentRoots = patch.recentRoots.filter((r): r is string => typeof r === 'string');
    if (typeof patch.lastRoot === 'string') picked.lastRoot = patch.lastRoot;
    if (patch.theme === 'dark' || patch.theme === 'light' || patch.theme === 'system') picked.theme = patch.theme;
    if (patch.density === 'comfortable' || patch.density === 'compact') picked.density = patch.density;
    if (typeof patch.model === 'string') picked.model = patch.model;
    if (typeof patch.sort === 'string') picked.sort = patch.sort;
    // The Issues desk's added repositories (control-tower phase 118): an array
    // REPLACES the list, filtered through the one gate a name must pass before
    // `gh --repo` sees it. Anything that is not an array is dropped.
    if (Array.isArray(patch.issueRepos)) picked.issueRepos = issueReposOf(patch.issueRepos);
    if (typeof patch.attachDefaultSkills === 'boolean') picked.attachDefaultSkills = patch.attachDefaultSkills;
    if (typeof patch.qaByDefault === 'boolean') picked.qaByDefault = patch.qaByDefault;
    if (patch.gitMode === 'default-branch' || patch.gitMode === 'new-branch') picked.gitMode = patch.gitMode;
    if (typeof patch.openPrOnComplete === 'boolean') picked.openPrOnComplete = patch.openPrOnComplete;
    if (typeof patch.reviewEachPhaseByDefault === 'boolean') picked.reviewEachPhaseByDefault = patch.reviewEachPhaseByDefault;
    if (patch.reviewerPolicy === 'may-hold' || patch.reviewerPolicy === 'comment-only') {
      picked.reviewerPolicy = patch.reviewerPolicy;
    }
    if (typeof patch.repoGuard === 'boolean') picked.repoGuard = patch.repoGuard;
    if (typeof patch.radarSerialize === 'boolean') picked.radarSerialize = patch.radarSerialize;
    // Membership from the owner list rather than a local pair of `===`. Note
    // this is a DROP and not a coercion: `isolationMode()` would turn a typo
    // into a stored `queue`, and the rule on this door is that a value it
    // cannot read leaves the operator's setting exactly as they left it.
    if (ISOLATION_MODES.includes(patch.isolation as never)) picked.isolation = patch.isolation;
    // 🔴 `settle` was in the loader and NOT here until 3.5.0 — which is exactly
    // the failure this method's own comment below names: a setting that
    // survives a restart and can never be changed. It went unnoticed for two
    // releases because `prefs.test.ts`'s parity test "flips" a value to prove
    // the writer accepts it, and its flip of a STRING is the same string, so
    // the assertion passed against a door that dropped every word-valued key.
    // Settle was only ever settable per-run. Same DROP-not-coerce rule as the
    // two neighbours.
    if (SETTLE_STRATEGIES.includes(patch.settle as never)) picked.settle = patch.settle;
    if (typeof patch.worktreeMaxConcurrent === 'number'
      && Number.isFinite(patch.worktreeMaxConcurrent) && patch.worktreeMaxConcurrent > 0) {
      picked.worktreeMaxConcurrent = patch.worktreeMaxConcurrent;
    }
    if (typeof patch.worktreeSetup === 'string') picked.worktreeSetup = patch.worktreeSetup;
    if (typeof patch.worktreeCopyEnv === 'boolean') picked.worktreeCopyEnv = patch.worktreeCopyEnv;
    // Same DROP-not-coerce rule: a word this door cannot read leaves the
    // operator's placement exactly where it was.
    if (WORKTREE_ROOTS.includes(patch.worktreeRoot as never)) picked.worktreeRoot = patch.worktreeRoot;
    // The per-REPOSITORY cap, by `worktreeMaxConcurrent`'s rule exactly: a
    // zero would refuse every isolated run in a repository while the setting
    // still reads "isolation is on", so it is dropped rather than stored.
    if (typeof patch.maxConcurrentPerRepo === 'number'
      && Number.isFinite(patch.maxConcurrentPerRepo) && patch.maxConcurrentPerRepo > 0) {
      picked.maxConcurrentPerRepo = patch.maxConcurrentPerRepo;
    }
    // Retention is the one word-valued setting whose vocabulary is OPEN —
    // `ttl:<h>` is a member with a parameter — so membership is asked of the
    // owner's coercer, and a word it had to fall back on is DROPPED rather
    // than stored. A typo must never become the reason a tree was deleted, and
    // silently storing `keep-on-failure` for `prun` would hide the typo too.
    if (typeof patch.worktreeRetention === 'string'
      && retentionOf(patch.worktreeRetention) === patch.worktreeRetention.trim().toLowerCase()) {
      picked.worktreeRetention = patch.worktreeRetention.trim().toLowerCase();
    }
    // A base branch is free text — it is a ref name — so the only question is
    // whether anything was said at all. An empty string is not a ref.
    if (typeof patch.baseBranch === 'string' && patch.baseBranch.trim()) {
      picked.baseBranch = patch.baseBranch.trim();
    }
    // Phase 15's four launch defaults — membership from each owner list, and
    // a DROP rather than a coercion, the rule every word-valued neighbour
    // follows: a value this door cannot read leaves the operator's setting
    // exactly as they left it.
    if (LAND_POLICIES.includes(patch.landing as never)) picked.landing = patch.landing;
    if (CONFLICT_POLICIES.includes(patch.conflictPolicy as never)) picked.conflictPolicy = patch.conflictPolicy;
    if (MESSAGING_WORDS.includes(patch.messaging as never)) picked.messaging = patch.messaging;
    if (ISSUE_MODES.includes(patch.issuesMode as never)) picked.issuesMode = patch.issuesMode;
    // Membership from the owner list, and a DROP rather than a coercion —
    // the same rule `isolation` above follows: a value this door cannot read
    // leaves the operator's setting exactly as they left it, where
    // `reclaimModeOf` would silently store `clean-only` for a typo.
    if (ISOLATION_RECLAIM.includes(patch.isolationReclaim as never)) {
      picked.isolationReclaim = patch.isolationReclaim;
    }
    if (typeof patch.deleteMergedRunBranches === 'boolean') {
      picked.deleteMergedRunBranches = patch.deleteMergedRunBranches;
    }
    if (typeof patch.autoRecoverByDefault === 'boolean') picked.autoRecoverByDefault = patch.autoRecoverByDefault;
    if (typeof patch.autoContinueRecovery === 'boolean') picked.autoContinueRecovery = patch.autoContinueRecovery;
    if (typeof patch.watchCmdRefs === 'boolean') picked.watchCmdRefs = patch.watchCmdRefs;
    if (typeof patch.watchMintedCmdRefs === 'boolean') picked.watchMintedCmdRefs = patch.watchMintedCmdRefs;
    if (isMcpPolicy(patch.mcpPolicy)) picked.mcpPolicy = patch.mcpPolicy;
    // The ladder caps and toggles: numbers must be finite and non-negative,
    // booleans booleans — the same rule `sanitiseAutomation` applies on load.
    const cap = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (cap(patch.ladderPerPhaseRungs)) picked.ladderPerPhaseRungs = patch.ladderPerPhaseRungs;
    if (cap(patch.ladderPerPhaseUsd)) picked.ladderPerPhaseUsd = patch.ladderPerPhaseUsd;
    if (cap(patch.ladderPerRunRungs)) picked.ladderPerRunRungs = patch.ladderPerRunRungs;
    if (cap(patch.ladderPerRunUsd)) picked.ladderPerRunUsd = patch.ladderPerRunUsd;
    if (cap(patch.ladderPerDayUsd)) picked.ladderPerDayUsd = patch.ladderPerDayUsd;
    if (cap(patch.ceilingStartsPerHour)) picked.ceilingStartsPerHour = patch.ceilingStartsPerHour;
    if (cap(patch.ceilingUsdPerHour)) picked.ceilingUsdPerHour = patch.ceilingUsdPerHour;
    if (cap(patch.usageForecastLeadHours)) picked.usageForecastLeadHours = patch.usageForecastLeadHours;
    if (typeof patch.usageForecastHold === 'boolean') picked.usageForecastHold = patch.usageForecastHold;
    if (cap(patch.convergeEveryMs)) picked.convergeEveryMs = patch.convergeEveryMs;
    if (cap(patch.budgetAutoRaisePct)) picked.budgetAutoRaisePct = patch.budgetAutoRaisePct;
    if (cap(patch.mcpRequireTimeoutMs)) picked.mcpRequireTimeoutMs = patch.mcpRequireTimeoutMs;
    // Strictly positive, matching `sanitiseAutomation`: a zero threshold would
    // stall-flag every lane on its first tick, which is not a setting anybody
    // means.
    const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
    if (positive(patch.stallSilentMs)) picked.stallSilentMs = patch.stallSilentMs;
    if (positive(patch.stallSpinTurns)) picked.stallSpinTurns = patch.stallSpinTurns;
    if (positive(patch.stallStalemateAttempts)) picked.stallStalemateAttempts = patch.stallStalemateAttempts;
    if (positive(patch.stallRetryBurst)) picked.stallRetryBurst = patch.stallRetryBurst;
    // Zero is a real answer for this one — "never call a lane waiting" — and the
    // Settings row has promised it; only the other detector thresholds refuse it.
    if (cap(patch.stallExternalWaitMs)) picked.stallExternalWaitMs = patch.stallExternalWaitMs;
    if (typeof patch.stallAutomaticPark === 'boolean') picked.stallAutomaticPark = patch.stallAutomaticPark;
    if (positive(patch.stallLocalJobMs)) picked.stallLocalJobMs = patch.stallLocalJobMs;
    // The sixth signal's run length (phase 13) — in the loader since it
    // shipped and NOT here until phase 15: the Settings control saved nothing.
    if (positive(patch.stallLoopRun)) picked.stallLoopRun = patch.stallLoopRun;
    // …and the escalation clock takes `cap` on both sides, because 0 means
    // "never re-say it" rather than "every tick". Two lists of the same keys:
    // a key in the loader and not here is a setting that survives a restart
    // and can never be changed — `delegateHumanGates` shipped exactly that way.
    if (cap(patch.stallEscalateMs)) picked.stallEscalateMs = patch.stallEscalateMs;
    if (typeof patch.unblockAttempts === 'boolean') picked.unblockAttempts = patch.unblockAttempts;
    if (typeof patch.delegateHumanGates === 'boolean') picked.delegateHumanGates = patch.delegateHumanGates;
    // This console's answers to the manifest's rows (phase 11): an OBJECT keyed
    // by decision key, coerced by the table's own rule — an unknown key or a
    // word outside the row's vocabulary is dropped, never defaulted — and
    // replaced wholesale, like the schedule: a merge would leave an answer the
    // operator meant to clear.
    if (patch.policy && typeof patch.policy === 'object' && !Array.isArray(patch.policy)) {
      picked.policy = sanitisePolicyPrefs(patch.policy);
    }
    if (typeof patch.allowUnverifiedPhases === 'boolean') picked.allowUnverifiedPhases = patch.allowUnverifiedPhases;
    if (typeof patch.ladderExtendOnProgress === 'boolean') picked.ladderExtendOnProgress = patch.ladderExtendOnProgress;
    if (typeof patch.staleClaimTakeover === 'boolean') picked.staleClaimTakeover = patch.staleClaimTakeover;
    // A WORD since 3.5.0, and a drop-not-coerce door like its neighbours: a
    // value this cannot read leaves the operator's setting as they left it.
    // The boolean is still accepted, because a client from before the change
    // sends one and `resumeAtBootMode` is the one place that reading lives.
    if (RESUME_AT_BOOT_MODES.includes(patch.resumeAtBoot as never)
      || typeof patch.resumeAtBoot === 'boolean') {
      picked.resumeAtBoot = resumeAtBootMode(patch.resumeAtBoot);
    }
    if (typeof patch.autoAccountSwitch === 'boolean') picked.autoAccountSwitch = patch.autoAccountSwitch;
    // The boarding schedule is an OBJECT, so it goes through its own coercer —
    // which drops what it cannot read rather than defaulting it. Replaced
    // wholesale rather than merged (unlike `notify` below): its parts are
    // lists, and a merge of two lists has no meaning an operator could predict
    // when the thing they did was delete a window.
    if (patch.boardingSchedule !== undefined) {
      picked.boardingSchedule = sanitiseSchedule(patch.boardingSchedule);
    }
    // The relay's rules (phase 14): a LIST, replaced wholesale for the reason
    // the schedule is — an operator who deleted a rule meant it gone.
    if (patch.relayRules !== undefined) picked.relayRules = sanitiseRelayRules(patch.relayRules);
    // The reminder quiet hours (control-tower phase 43): `{start, end}`, or null
    // to clear — through the push register's own parser, so one bad shape is
    // refused in one place, and DROPPED here rather than coerced.
    if ('reminderQuiet' in patch) {
      const quiet = parseQuietHours(patch.reminderQuiet);
      if (quiet === null) picked.reminderQuiet = undefined;
      else if (!('error' in quiet)) picked.reminderQuiet = { start: quiet.start, end: quiet.end };
    }
    // `notify` is a map inside a patch, so a shallow spread alone would let a
    // client sending one toggle reset every other category to its default.
    // Merged off the *current* map (captured before the spread overwrites it),
    // then sanitised: unknown keys are dropped and a category this client has
    // never heard of keeps the value it already had.
    // `null` returns a key to its shipped default (control-tower phase 53, #56)
    // — the one way to take an override back. It used to be dropped like a
    // typo: `{"ladderPerPhaseRungs": null}` answered 200 and the raised cap
    // stayed, so only another explicit number could ever undo one. A key with
    // no shipped default, or one this door does not know, is still dropped.
    const reset: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== null) continue;
      const shipped = prefDefault(key);
      if (shipped.known) reset[key] = shipped.value;
    }
    const notify = patch.notify === null
      ? reset.notify as Prefs['notify']
      : patch.notify === undefined
        ? this.prefs.notify
        : sanitiseCategories({ ...this.prefs.notify, ...patch.notify });
    // Re-DERIVED, never carried: the flat keys are the truth and the object
    // is a view of them, so a write that moves one must move the other.
    const policyBefore = this.prefs.policy ?? {};
    this.prefs = withAutomation({ ...this.prefs, ...(reset as Partial<Prefs>), ...picked, notify });
    savePrefs(this.prefs);
    if (picked.policy) this.journalPolicyAnswers(policyBefore, picked.policy, opts.by ?? 'console');
    // The healer decides with these — the ladder caps, the unblock and takeover
    // switches, gate delegation — and none of them are in the convergence
    // fingerprint, which reads the run, the board, the locks, the gate stamp and
    // the QA verdicts. So an operator who raised a spent budget or turned
    // delegation on changed exactly the thing that would let the loop act, and
    // the loop went on skipping with "nothing has changed since the last pass
    // found nothing to climb". Clearing the latch is the whole fix: the next
    // sweep asks again.
    if (Object.keys(picked).length) this.converger.clearNoops();
    // The sweep clock reads `convergeEveryMs` only when it re-arms, so a change
    // (0 -> N, or N -> 0) would otherwise wait for the OLD interval to fire
    // once more — or, at 0, never be read again. `start()` is idempotent and
    // re-arms under the new value.
    if (picked.convergeEveryMs !== undefined) this.converger.start();
    return this.prefs;
  }

  /**
   * Every changed policy answer, one record each — `policy.changed {key, from,
   * to, by}` (phase 12). The console's own log is its record; every LIVE run's
   * journal takes the line too, the way a permission-policy edit does
   * (`policy.edited`), because the answer in force is what the ladder reads
   * at each run's very next park and a run whose journal never said the
   * answer moved is a run nobody can explain.
   */
  private journalPolicyAnswers(
    before: Readonly<Partial<Record<string, string>>>,
    after: Readonly<Partial<Record<string, string>>>,
    by: string,
  ): void {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const from = before[key] ?? null;
      const to = after[key] ?? null;
      if (from === to) continue;
      const record = { key, from, to, by };
      log.info('policy.changed', record);
      for (const runner of this.liveRunners()) runner.note('policy.changed', record);
    }
  }

  /**
   * What this repository's ledgers say, for the plan wizard's opening (phase
   * 12, ZTD-11): every open plan's manifest merged with its twin, the keys
   * some plan still leaves `outstanding`, the newest rulings that named a key,
   * and how many answers were promoted from rulings. Bounded by the prompt's
   * digest, not here — the wizard shows the first few and says where the rest
   * are; the numbers are the whole estate.
   */
  planFacts(): PlanFacts {
    const records = (this.store?.list() ?? []).filter((record) => !this.isClosedPlan(record.slug));
    const outstanding = new Map<string, string[]>();
    let promoted = 0;
    for (const record of records) {
      for (const row of mergeDecisions(record.plan?.decisions ?? [], record.decisionsTwin ?? [])) {
        if (row.state === 'outstanding') {
          const plans = outstanding.get(row.key) ?? [];
          if (!plans.includes(record.slug)) plans.push(record.slug);
          outstanding.set(row.key, plans);
        }
        if (row.source === 'ruling') promoted += 1;
      }
    }
    const rulings = records
      .flatMap((record) => this.runRulings(record.slug))
      .filter((ruling): ruling is Ruling & { decisionKey: string } => Boolean(ruling.decisionKey))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, 12)
      .map((ruling) => ({ slug: ruling.slug, phase: ruling.phase, key: ruling.decisionKey, what: ruling.what, at: ruling.at }));
    return {
      plans: records.length,
      // Keys in manifest order, so two consoles digest one estate the same way.
      outstanding: [...outstanding.entries()]
        .sort((a, b) => keyRank(a[0]) - keyRank(b[0]))
        .map(([key, plans]) => ({ key, plans })),
      rulings,
      promoted,
    };
  }

  /**
   * A ruling becomes a standing answer (phase 12, chapter 10 ZTD-7).
   *
   * `plan` writes a `## Decisions` row for the ruling's key into the plan's
   * twin through `decisions.sh promote` — the one writer of that file — with
   * `source: ruling` and the ruling id as evidence. `global` sets this
   * console's own `policy.<key>` answer to the ruling's words, which must be
   * an answer the key can hold (the closed words, an owner name, or a line
   * of text for the free-text keys). Either way the ruling is then acked in
   * the ledger, attributed, so every clone that reads the ledger sees it
   * handled. `plan` needs `--allow-writes` (it edits a versioned file);
   * `global` is a preference, which no capability flag guards.
   */
  async rememberRuling(
    slug: string, id: string, scope: 'plan' | 'global' | 'rule', by: string,
  ): Promise<{ ok: true; scope: 'plan' | 'global' | 'rule'; key: string; value: string; ack: boolean; detail: string }
    | { ok: false; status: 400 | 403 | 404 | 409; error: string }> {
    const root = this.root?.ok ? this.root.path : null;
    if (!root || !this.store?.get(slug)) return { ok: false, status: 404, error: `No plan named ${slug}.` };
    const ruling = this.runRulings(slug).find((row) => row.id === id);
    if (!ruling) return { ok: false, status: 404, error: `No ruling ${id} in the ${slug} ledger.` };
    // A relayed answer (phase 14) is remembered as a RELAY RULE — "this
    // question, this answer" — never as a `## Decisions` row, whose `ambiguity`
    // value is a policy word and not an option label.
    if (scope === 'rule') {
      if (!ruling.relay) {
        return { ok: false, status: 400, error: `Ruling ${id} is not a relayed answer — only a question the relay answered becomes a relay rule.` };
      }
      const who = by.trim().slice(0, 64);
      if (!who) return { ok: false, status: 400, error: 'Who remembers it must be named.' };
      const [rule] = sanitiseRelayRules([{ tool: ruling.relay.tool, key: ruling.relay.key, profile: '*', answer: ruling.relay.answer }]);
      if (!rule) return { ok: false, status: 400, error: `Ruling ${id} carries no answer a rule can hold.` };
      const current = sanitiseRelayRules(this.prefs.relayRules);
      this.savePreferences({ relayRules: [...current.filter((existing) => existing.id !== rule.id), rule] }, { by: who });
      const ack = appendRulingAck(rulingsFile(root, slug), id, who);
      log.info('rulings.remembered', { slug, id, scope, key: rule.key, by: who });
      this.emit('inbox', { at: new Date().toISOString() });
      return {
        ok: true, scope, key: rule.key, value: rule.answer, ack,
        detail: `Remembered as relay rule ${rule.id}: the console answers "${rule.answer}" to this question on every run.`,
      };
    }
    const key = ruling.decisionKey;
    if (!key) {
      return {
        ok: false, status: 400,
        error: `Ruling ${id} names no decision key — a ruling is remembered under the key it answers (phase-outcome.sh … ruling --needs <key>).`,
      };
    }
    const who = by.trim().slice(0, 64);
    if (!who) return { ok: false, status: 400, error: 'Who remembers it must be named.' };
    const ledger = rulingsFile(root, slug);

    if (scope === 'plan') {
      if (!this.flags.allowWrites) {
        return { ok: false, status: 403, error: 'Writes are disabled. Restart with --allow-writes to enable them.' };
      }
      let outcome;
      try {
        outcome = await runWrite(
          planWrite({ action: 'decisions-promote', slug, rulingId: id, key, by: who, ledger }, { root, docsDir: this.root?.docsDir }),
          { scriptsDir: this.flags.scriptsDir, root },
        );
      } catch (error) {
        return { ok: false, status: 400, error: (error as Error).message };
      }
      if (!outcome.ok) {
        return { ok: false, status: 409, error: (outcome.stderr || outcome.stdout).trim() || 'decisions.sh refused the row.' };
      }
      // The twin changed under the store: re-read the plan so the prelude, the
      // Source tab and the next boot prompt carry the promoted row now, not on
      // the watcher's next tick.
      this.reread(slug);
      const ack = appendRulingAck(ledger, id, who);
      log.info('rulings.remembered', { slug, id, scope, key, by: who });
      this.emit('inbox', { at: new Date().toISOString() });
      return {
        ok: true, scope, key, value: ruling.what, ack,
        detail: `Remembered for ${slug}: ${key} = "${ruling.what}" (source ruling, evidence ruling ${id}).`,
      };
    }

    if (!isAnswerWord(key, ruling.what)) {
      const words = DECISION_ANSWERS[key];
      return {
        ok: false, status: 400,
        error: `"${ruling.what}" is not an answer this console can hold for ${key}`
          + (words ? ` — it takes one of: ${words.join(', ')}${(OWNER_KEYS as readonly string[]).includes(key) ? ', or an owner name' : ''}.` : '.'),
      };
    }
    this.savePreferences({ policy: { ...(this.prefs.policy ?? {}), [key]: ruling.what } }, { by: who });
    const ack = appendRulingAck(ledger, id, who);
    log.info('rulings.remembered', { slug, id, scope, key, by: who });
    this.emit('inbox', { at: new Date().toISOString() });
    return {
      ok: true, scope, key, value: ruling.what, ack,
      detail: `Remembered on this console: policy.${key} = "${ruling.what}" — in force for every plan whose manifest is silent on it.`,
    };
  }

  /** Remaining-work arithmetic for one plan, used by the analysis panel. */
  async work(slug: string) {
    const record = this.store?.get(slug);
    if (!record?.plan) return null;
    const board = await this.board(slug);
    const sizes = new Map(record.plan.graph.map((r) => [r.phase, record.plan!.phases[r.phase]?.size ?? 'M' as const]));
    const budget = resolveBudget(record.plan.sessionBudget.targetModel, this.sizing);
    return remainingWork(record.plan.graph, board, sizes, this.sizing, budget,
      this.phaseWeights(record.plan), this.sizingCensus()?.sessions);
  }
}
