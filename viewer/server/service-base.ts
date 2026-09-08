/**
 * `ServiceBase` — link 1 of the `Service` chain.
 *
 * One contiguous section of a class that outgrew one file. The chain is a
 * FILE boundary, not a design boundary: members keep their order, their
 * bodies and their single prototype, so `Service` behaves exactly as it did
 * when this was one declaration — including for the tests that reach its
 * private members. `protected` here means "another link uses it", nothing
 * more. Read the chain in order; `service.ts` holds the concrete class.
 */
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { instanceId, instanceUrl } from '../shared/instances.mjs';
import {
  INSTANCE,
  INSTANCE_STATE_DIR,
  SKILL_DIR,
  STATE_DIR,
  agentEnabled,
  checkRoot,
  distRev,
  rememberRoot,
  loadPrefs,
  savePrefs,
  serverIsStale,
  staticRoot,
  type Flags,
  type Prefs,
  type RootCheck,
} from './config.ts';
import {
  SessionRegistry,
  correlate,
  parseHookPayload,
  type RunLink,
  type SessionEventName,
  type SessionRecord,
  type SessionView,
} from './sessions/registry.ts';
import {
  hooksStatus,
  installHooks,
  uninstallHooks,
  type HooksStatus,
  type HooksWrite,
} from './hooks-install.ts';
import { Store, handoffFor, lockFor, qaFor, readLock, type PlanRecord } from './store.ts';
import {
  ConvergeScheduler,
  convergePlan,
  HALT_DELAY_MS,
  type ConvergeDeps,
  type ConvergeReport,
  type ConvergeTrigger,
  convergeView,
  type ConvergeView,
} from './converge.ts';
import { WatchScheduler, type WatchLandingOutcome } from './watch-scheduler.ts';
import type { WatchState as WatchStateView } from './watch-refs.ts';
import { runSingleCommand } from './runner/verify.ts';
import { planWrite, runWrite } from './writes.ts';
import { readFleetHold, writeFleetHold, clearFleetHold, type FleetHold } from './fleet-hold.ts';
import {
  run,
  invalidate,
  readMemoryBlock,
  readQaMode,
  readSessionPlan,
  readLint,
  readGateStatus,
  readText,
  readBoardText,
  type Board,
  type QaMode,
  type SessionPlan,
  type LintResult,
  type GateStatus,
} from './engine.ts';
import { ReviewStore, reviewHold } from './review.ts';
import { SearchIndex, type SearchResult } from './search.ts';
import { listSkills, type SkillInfo } from './skills.ts';
import { DocsWatcher } from './watch.ts';
import {
  degradedState,
  hasShutdownWork,
  onDegraded,
  requestRestart,
  requestShutdown,
  restartVerdict,
  stopPlan,
  supervisor,
} from './lifecycle.ts';
import { log } from './log.ts';
import {
  CATEGORIES,
  Push,
  isPlanProgress,
  routeFor,
  sanitiseCategories,
  tagFor,
  type CategoryId,
} from './push/index.ts';
import { SpentTokens, mintActionToken, notificationButtons } from './push/actions.ts';
import { Notifications, type NotificationQuery, type NotificationRecord } from './notifications.ts';
import { repoInfo, lastCommit, commitsTouching, type GitRepoInfo, type GitFileInfo } from './git.ts';
import { findMemory, memoryIndexLines } from './memory.ts';
import {
  loadSizing,
  loadMcpSurcharge,
  indexGraph,
  routeLayout,
  analysePhases,
  criticalPath,
  remainingWork,
  resolveBudget,
  weightOf,
  type Sizing,
  type McpSizing,
  type PhaseAnalysis,
} from './analysis/graph.ts';
import { loadGateVocab, gateKindOf, type GateVocab, type GateKind } from './analysis/gates.ts';
import { rungsToday, spendSummary, type SpendRunView, type SpendView } from './analysis/spend.ts';
import {
  buildInbox,
  inboxIds,
  pruneAcks,
  readAcks,
  removeAck,
  writeAck,
  INBOX_ACKS_DIR,
  type InboxAck,
  type InboxFacts,
  type InboxView,
} from './inbox.ts';
import { STALL_SIGNAL_META, inboxItemId, parseInboxItemId } from '../shared/attention-model.js';
import { deriveEvidence } from '../shared/evidence-model.js';
import {
  planStats,
  portfolio,
  etaSamples,
  etaFrom,
  rateFor,
  phaseEtaFor,
  healthIssues,
  isClosedStatus,
  splitRepos,
  type PlanStats,
  type Portfolio,
  type PlanContext,
  type EtaEstimate,
  type EtaSample,
  type PhaseEta,
  type RateReading,
} from './analysis/stats.ts';
import {
  detachRequestedIn,
  mcpServersFor,
  type Plan,
  type PhaseDetail,
  type PhaseRow,
} from './parse/plan.ts';
import {
  Runner,
  applySettings,
  VERIFICATION_PARK_NOTE,
  MCP_PARK_NOTE,
  type AskResult,
  type RecoverMode,
  type RunSettingsPatch,
  type StartOptions,
} from './runner/runner.ts';
import { Scheduler, autopilotRunId, lockLapsed, type HolderEta, type LockView } from './runner/scheduler.ts';
import { offeredModels } from './runner/models.ts';
import {
  continueMcpParkedRecord,
  mcpParkDueAt,
  DEFAULT_MCP_REQUIRE_TIMEOUT_MS,
  type McpContinueResult,
} from './runner/mcp-park.ts';
import {
  classifySituation,
  collectEvidence,
  summariseEvidence,
  type EvidenceDeps,
  type PhaseEvidence,
  type Situation,
} from './runner/situation.ts';
import {
  accountRung,
  errandFor,
  ladderCaps,
  nextRung,
  rungsFor,
  settleRung,
  type Rung,
} from './runner/ladder.ts';
import type { McpDegradation, PhaseRecord as RunPhaseRecord } from './runner/state.ts';
import { formatScope, scopeOfRow, scopesIntersect } from '../shared/scope.js';
import {
  KIND_PROFILE,
  NO_HANDOFF_AUTO_RE,
  VERIFICATION_AUTO_RE,
  isRecoveryClass,
  recoveryActionsFor,
} from '../shared/recovery-model.js';
import { isLiveStatus } from '../shared/status-vocab.js';
import { environmentReport, type EnvIssue } from './env-doctor.ts';
import { Terminals, type SessionEvent, type SessionInfo, type SessionKind } from './terminal.ts';
import { Journal } from './runner/journal.ts';
import {
  FREEZE_ESCALATE_MS,
  escalatePersistedFreeze,
  freezeVerdict,
  type PersistedEscalation,
} from './runner/freeze.ts';
import type { LaneLiveness } from './runner/liveness.ts';
import {
  appendAck as appendRulingAck,
  ingestRulings,
  readRulings,
  rulingsFile,
  type Ruling,
} from './runner/rulings.ts';
import {
  autoResolveRun,
  childrenOf,
  flushRunSaves,
  latestRun,
  listRuns,
  loadRun,
  newRun,
  phaseRecord,
  pidAlive,
  pidHoldsWork,
  pruneRuns,
  reconcileRecordsAgainstBoard,
  resetForRetry,
  resolveRunsAgainst,
  saveRun,
  slugsNeedingBoard,
  runDir,
  waitReasonOf,
  IN_FLIGHT,
  PHASE_IN_FLIGHT,
  RESOLVABLE,
  isMcpPolicy,
  mcpReasonText,
  type BoardingBrief,
  type Errand,
  type McpPolicy,
  type PhaseOptions,
  type PreflightWarning,
  type RungRecord,
  type RunState,
  type VerifySummary,
  consoleRunsDir,
} from './runner/state.ts';
import {
  consumeOutcome,
  inboxOutcomePhase,
  outcomeFileFor,
  outcomeInboxDir,
  readOutcome,
  type PhaseOutcome,
} from './runner/outcome.ts';
import { readTranscript, transcriptFile, type TranscriptEntry } from './runner/transcript.ts';
import {
  previewIsolation,
  sweepStale,
  sweepUnmanaged,
  type IsolationPreview,
  type OccupiedTree,
  managedRoots,
  worktreeHome,
  worktreesRoot,
} from './runner/worktree.ts';
import { reclaimModeOf, WORKTREE_ROOTS } from '../shared/worktree-model.js';
import { extractCommands, resolveLead, unresolvableLeads, verifyPhase } from './runner/verify.ts';
import { loadVerifyEnv } from './runner/verify-env.ts';
import {
  checkAuth,
  checkAuthFor,
  forgetAuth,
  openLoginTerminal,
  openCommandTerminal,
  shellQuote,
  type AuthStatus,
} from './runner/auth.ts';
import { Accounts, DEFAULT_ACCOUNT_ID, profileConfigDir, type AccountView } from './accounts/index.ts';
import { HEALTH_TTL_MS, Mcp, type McpServerView } from './mcp/index.ts';
import { IDLE_POLL_MS as ISSUES_SWEEP_MS } from './issues/fetch.ts';
import { IssuesStore } from './issues/index.ts';
import { pruneMcpConfigs } from './mcp/config.ts';
import { pruneSettingsFiles } from './runner/approvals.ts';
import { portTranscript } from './accounts/transcripts.ts';
import { FULL_FLAGS, installDesktopLauncher, launcherPlan } from './launcher.ts';
import { Webhooks } from './webhooks.ts';
import {
  RECOVERY_TITLES,
  recoveryKey,
  type RecoveryClass,
  type RecoveryFacts,
  type RecoveryRequest,
} from './recovery.ts';
import { buildAgentLaunch, phasedExecutionSkillId } from './agent.ts';
import { isVerdict, qaKey, type QaFacts, type QaRequest } from './qa-session.ts';
import type { ReviewerFacts, ReviewerReport, ReviewerVerdictPolicy } from './reviewer.ts';
import {
  Approvals,
  classifyTool,
  matchedDenyRule,
  loadPolicy,
  loadPolicyFor,
  policyExtras,
  addPolicyRules,
  editPolicy,
  planPolicyPath,
  effectivePlanPolicyPath,
  notifyOutOfBand,
  carvedPolicy,
  suggestedRule,
  autoApproveFor,
  neverAutoApproves,
  hitsHidden,
  parseRule,
  inertRules,
  HOOK_TOOLS,
  WRAPPERS_NOT_STRIPPED,
  PERMISSION_PROFILES,
  PROFILE_LABELS,
  DEFAULT_DENY,
  DEFAULT_ASK,
  DEFAULT_ALLOW,
  POLICY_PATH,
  type Evidence,
  type PolicyScope,
  type PermissionProfile,
} from './runner/approvals.ts';
import {
  AUTO_GRANT_REASONS,
  ETA_POOL_MS,
  EVENT_BUFFER,
  HOOK_EVENTS_PER_MINUTE,
  HookPayloadError,
  HookRateError,
  INBOX_SOURCES,
  LIMIT_RESUME_RETRY_MS,
  MAX_TIMER_MS,
  OUTCOME_INBOX_DEBOUNCE_MS,
  OUTCOME_INBOX_MAX_AGE_MS,
  PRESENCE_BACKLOG_MAX,
  PhaseClaimedError,
  RecoveryBusyError,
  UNSUPERVISED_WAIT_DEFAULT_MS,
  autoRecoveryClass,
  bucketLabel,
  describeExit,
  describeToolInput,
  effortOf,
  gitPorcelain,
  gitRead,
  lockView,
  modelAlias,
  recoveryActions,
  recoveryOwner,
  seedSkills,
  situationOfHalt,
  titleOf,
  type AutoRecoverResult,
  type Cached,
  type ControlResult,
  type DriveVehicle,
  type EtaPool,
  type EvidenceView,
  type LiveEvent,
  type LiveListener,
  type LockRelease,
  type PhaseDiagnosis,
  type PhaseLockView,
  type PhaseView,
  type PlanDetail,
  type PlanSummary,
  type QaOutcome,
  type RecoveryAction,
  type RouteView,
} from './service-core.ts';
import type { Service } from './service.ts';
import type { Presence } from '../shared/run-lifecycle.js';

/**
 * The cap the "already announced" collections share.
 *
 * `notifiedErrand` has always trimmed at 500; its siblings were written the
 * same way and simply never trimmed. One number, so a reader does not have to
 * work out whether three different bounds mean three different intentions.
 */

/**
 * How many boards `warm()` reads at a time.
 *
 * Eight, to match `engine.ts`'s own subprocess semaphore: warming has never
 * been able to run more than eight `phase-graph.sh` processes anyway, so this
 * costs no wall-clock and is not a throttle — it stops the QUEUE existing.
 */
const WARM_LANES = 8;

/**
 * `fn` over `items`, at most `lanes` in flight — `Promise.all` with a bound.
 *
 * `Promise.all(items.map(fn))` calls `fn` for every item BEFORE awaiting any of
 * them, so every pending result is live at once even when the work underneath
 * is already capped. On a 138-plan root that was the difference between a
 * console that boots and one that does not: measured on the hub instance,
 * **1.9 GB of RSS and still climbing nine minutes into a boot**, against 93 MB
 * after fifteen hours on a four-plan root running the same build — 138 pending
 * boards, their stdout buffers and their parsed results, held together. The
 * subprocess cap made the machine look fine while the heap did not; the unit's
 * `LastExitStatus` was 9 and the console's own log said the previous run wrote
 * no exit record.
 *
 * Rejections are the caller's to handle, exactly as with `Promise.all` — every
 * caller here passes a `fn` that already catches.
 */
async function inLanes<T>(
  lanes: number,
  items: readonly T[],
  fn: (item: T) => Promise<unknown>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(lanes, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) await fn(items[i] as T);
    }),
  );
}

export const NOTIFIED_CAP = 500;

/**
 * Drop insertion-order-oldest entries until the collection fits.
 *
 * Both `Map` and `Set` iterate in insertion order, which is what makes this an
 * eviction policy rather than an arbitrary one. Deliberately NOT an LRU: these
 * collections answer "have I already said this?", where the useful entries are
 * the recent ones and re-announcing something evicted 500 events ago is a
 * cosmetic cost, not a correctness one.
 */
export function trimOldest(collection: Map<string, unknown> | Set<string>, cap: number): void {
  while (collection.size > cap) {
    const oldest = collection.keys().next();
    if (oldest.done) return;
    collection.delete(oldest.value);
  }
}

export abstract class ServiceBase {
  /**
   * The fleet freeze, cached.
   *
   * `undefined` means "not read yet" and `null` means "read, and there is no
   * freeze" — two different facts, which is why this is not a plain `| null`.
   * The marker is instance state written by this process alone, so a cache is
   * exact rather than merely cheap; and it has to be cheap, because
   * `Scheduler.poll` asks on every scan and a file read per queue entry per
   * poll is a syscall storm on the hot path of the thing this freeze exists to
   * stop.
   */
  private fleetHoldCache: FleetHold | null | undefined;

  protected mcpRequireTimers = new Map<string, NodeJS.Timeout>();
  /** The MCP health clock — see `startMcpHealthClock`. Replaced on re-open. */
  protected mcpHealthTimer: NodeJS.Timeout | null = null;

  abstract activateQa(slug: string, phase: number): Promise<{ ok: boolean; mode: string; detail: string }>;
  protected abstract announceMcpDegraded(state: RunState, phase: number, degraded: McpDegradation[]): void;
  protected abstract announceMcpTimeout(state: RunState, phase: number, result: McpContinueResult): void;
  protected abstract armFreezeEscalation(slug: string, state: RunState): void;
  protected abstract armMcpRequireTimer(slug: string, phase: number, dueAt: number): void;
  protected abstract armMcpRequireTimersFor(state: RunState): void;
  protected abstract armSessionInbox(root: string): void;
  abstract authStatus(force?: boolean): Promise<AuthStatus>;
  abstract board(slug: string): Promise<Board>;
  abstract continueMcpParkedPhase(
    slug: string,
    phase: number,
    by?: string,
  ): Promise<McpContinueResult | null>;
  abstract convergeNow(
    slug: string,
    trigger: ConvergeTrigger,
    lastNoop?: string | null,
  ): Promise<ConvergeReport | null>;
  abstract convergeSlugs(): string[];
  abstract dayRungs(): RungRecord[];
  protected abstract disarmSessionInbox(): void;
  abstract emit(event: string, data: unknown): void;
  protected abstract emitAccounts(): void;
  protected abstract emitMcp(): void;
  /**
   * A queue holder's remaining work, synchronously — `ServiceRuns.etaHint`.
   *
   * Abstract because the scheduler is built HERE and the memo is filled from
   * `runEta`, which lives two subclasses down. A superclass reaching into a
   * subclass needs the declaration; without it the call compiles against
   * nothing and the queue silently never gets an estimate.
   */
  protected abstract etaHint(slug: string): HolderEta | undefined;
  protected abstract etaPool(): EtaPool;
  protected abstract evidenceDeps(slug: string): EvidenceDeps;
  protected abstract healMcpParks(serverId: string): Promise<void>;
  abstract liveRecoveryFor(link: { slug?: string; phase?: number }): SessionInfo | undefined;
  /**
   * Is a watch-landed delivery of this phase still being driven? The scheduler
   * holds a landed offer back while this answers true — the service's own
   * un-settled drive promise is the one thing that settles exactly when the
   * drive does (`service-recovery.ts`, QA round 3 H1).
   */
  abstract watchResumeInFlight(slug: string, phase: number): boolean;
  protected abstract liveRunId(): Set<string>;
  /**
   * A watched ref landed. Implemented by the healer (`service-recovery.ts`),
   * which owns whether that resumes a session and how often it may — the
   * scheduler only reports the world.
   */
  protected abstract onWatchLanded(
    slug: string,
    state: RunState,
    phase: number,
    landed: WatchStateView,
  ): Promise<WatchLandingOutcome>;
  abstract maybeAutoRecover(slug: string): Promise<AutoRecoverResult>;
  protected abstract mcpRequireTimeoutMs(): number;
  protected abstract onChange(paths: string[]): void;
  protected abstract onPresenceChange(
    record: SessionRecord,
    event: SessionEventName | 'prune' | 'heartbeat',
  ): void;
  protected abstract onRunnerEvent(event: string, data: unknown): void;
  protected abstract planRate(slug: string, ownSamples?: EtaSample[]): RateReading;
  protected abstract preRecoveryGate(
    slug: string,
    state: RunState,
    phase: number,
  ): Promise<'proceed' | 'superseded' | 'resolved'>;
  protected abstract preflightAccount(accountId: string | undefined): void;
  abstract qaOutcome(link: {
    slug: string;
    phase: number;
    before?: string;
    beforeReport?: string;
  }): Promise<QaOutcome>;
  abstract recoveryOutcome(link: {
    kind: string;
    slug?: string;
    phase?: number;
    runId?: string;
  }): Promise<{ fixed: boolean; noDefect?: boolean; headline: string; detail: string }>;
  protected abstract reflectVerifyCommand(
    verify: { slug: string; phase: number; runId?: string; command: string },
    code: number,
    output: string,
  ): void;
  abstract refreshMcp(force?: boolean): Promise<McpServerView[]>;
  abstract releaseMcpBridge(id: string, configDir?: string): Promise<void>;
  abstract retryPhase(
    slug: string,
    phase: number,
    override?: { addendum?: string; options?: PhaseOptions; by?: string },
  ): Promise<RunState | null>;
  abstract sessionViews(): SessionView[];
  abstract startRun(slug: string, options?: Partial<StartOptions>): Promise<RunState>;
  abstract syncRecoveredRun(
    link: { kind: string; slug?: string; phase?: number; runId?: string },
    outcome: { fixed: boolean; noDefect?: boolean; headline?: string; detail?: string },
    by?: string,
  ): RunState | null;

  readonly flags: Flags;
  prefs: Prefs;
  /**
   * Runs this console's own restart stopped, waiting on the operator's answer
   * — `resumeAtBoot: 'ask'`, the shipped default since 3.5.0.
   *
   * 🔑 **Both of these are in MEMORY on purpose, and it is the whole design.**
   * The question is about this console boot: "your restart stopped these runs,
   * shall I pick them up?" A decision written to disk would still be there
   * after the next restart, which is precisely the event that makes the
   * question new again — so the console would ask once, ever, and then resume
   * silently for the rest of its life, which is the behaviour being fixed.
   *
   * A console that dies with the question unanswered asks again when it comes
   * back, which is right: nothing was resumed, so nothing was missed.
   */
  readonly resumeAsks = new Map<
    string,
    { slug: string; runId: string; phases: number[]; sessions: string[]; at: string }
  >();

  /** The answers, for this boot only. */
  readonly resumeDecisions = new Map<string, 'continue' | 'dismiss'>();
  /** The environment doctor's findings; push health appends at runtime. */
  readonly environment: { issues: EnvIssue[] };
  /** Push-health announcements already made this process, per service|reason. */
  private readonly pushHealthAnnounced = new Set<string>();
  root: RootCheck | null = null;
  store: Store | null = null;
  readonly search = new SearchIndex();
  readonly sizing: Sizing;
  /** `scripts/mcp.env` — the per-attached-server surcharge, F5's other half. */
  readonly mcpSizing: McpSizing;
  readonly gateVocab: GateVocab;
  generation = 0;

  protected watcher: DocsWatcher;
  protected boards = new Map<string, Cached<Board>>();
  protected qaModes = new Map<string, Cached<QaMode>>();
  protected lints = new Map<string, Cached<LintResult>>();
  protected sessionPlans = new Map<string, Cached<SessionPlan>>();
  protected portfolioCache: { generation: number; value: Portfolio } | null = null;
  protected etaPoolCache: { at: number; value: EtaPool } | null = null;

  /**
   * The queue's *how long* answers, per plan, refreshed in the background.
   *
   * The scheduler's admission scan is SYNCHRONOUS by design — an await between
   * deciding and granting is the one window an admission check may not open —
   * and `runEta` reads a board, which is not. So the answer is memoised here
   * and read synchronously (`etaHint`), with a miss kicking off a refresh that
   * lands for the next scan. A cold read is `undefined`, which is honest and
   * changes nothing: this decorates a holder, it decides nothing.
   */
  protected etaHints = new Map<string, { at: number; value: HolderEta | undefined }>();

  /** Plans whose ETA refresh is in flight, so a busy queue asks once. */
  protected etaHintsInFlight = new Set<string>();
  /** Short-TTL cache behind `runsForSpend()` — see the note there. */
  protected spendPool: { at: number; gen: number; runs: SpendRunView[] } | null = null;
  /**
   * One plan's ruling ledger, keyed by the file's own mtime+size.
   *
   * Bounded by the plan count, which the store already bounds — a slug is only
   * ever a key here because the store listed it.
   */
  protected rulingsCache = new Map<string, { stamp: string; rulings: Ruling[] }>();
  protected listeners = new Set<LiveListener>();
  protected repo: GitRepoInfo = { available: false, dirty: [] };

  /** Monotonic id per emitted event, so a client can say what it already saw. */
  eventCursor = 0;
  protected eventLog: LiveEvent[] = [];
  /**
   * The last status announced per run, so a halt is not announced on every poll.
   *
   * Keyed by run id rather than a single slot: with two runs live, one halting
   * and the other merely persisting would take turns overwriting the slot, and
   * every write would look like a change worth waking somebody for.
   */
  protected notifiedRun = new Map<string, string>();
  /** Per phase, the last status pushed — a re-render is not a second event. */
  protected notifiedPhase = new Map<string, string>();
  /**
   * Errands already pushed, keyed `runId:phase:errand.at`.
   *
   * Keyed on the errand's own timestamp and not on the phase, because an
   * errand is re-derived every time the ladder parks the phase again: the same
   * phase asking the same person for the same thing must push ONCE, but a
   * genuinely new ask — a later `at` — is a new notification.
   */
  protected notifiedErrand = new Set<string>();
  protected notifiedQaHold = new Set<string>();
  /**
   * Stall episodes already announced, keyed `runId:phase:signal:attempt`.
   *
   * The attempt is in the key on purpose. One episode is one card: a lane that
   * stays silent for an hour ticks sixty times and is announced once, because
   * the runner only journals a transition and this only fires on what the
   * runner journalled. But the SAME phase going silent again on its next
   * attempt is a different fact — the first one ended, something re-boarded
   * it, and it has stopped again — and an operator needs to hear that.
   */
  protected notifiedStall = new Set<string>();
  /**
   * The escalation clock of every stall episode that is still open, keyed the
   * same way `notifiedStall` is.
   *
   * A stall that is merely still true produces no further runner event —
   * the ticker journals transitions only — so the second look has to be a
   * timer here rather than a re-read of an event that never comes. Cleared
   * when the episode resolves (liveness clear, the phase ending, the run
   * settling), so a lane that got going again is never escalated. See
   * `escalateStall`.
   */
  protected stallEscalations = new Map<
    string,
    {
      timer: NodeJS.Timeout;
      slug: string;
      phase: number;
      runId?: string;
      signal: string;
      title: string;
      body: string;
      at: number;
    }
  >();
  /**
   * The stall episodes that actually ESCALATED — the only ones that buzzed.
   *
   * Kept apart from `stallEscalations`, which holds armed clocks and empties
   * itself when one fires. An all-clear is owed to a card the operator was
   * interrupted for and to no other, so "did this one buzz?" has to survive
   * the timer that answered it.
   */
  protected escalatedStalls = new Map<
    string,
    {
      slug: string;
      phase: number;
      runId?: string;
      signal: string;
    }
  >();
  /** Debounce behind `nudgeInbox` — see the note there. */
  protected inboxTimer: ReturnType<typeof setTimeout> | null = null;
  /** Which phases were ready last time, so "became ready" means became. */
  protected readySnapshot: Set<string> | null = null;
  /**
   * Every tool this console has been asked about, this process.
   *
   * The rule editor's most useful list is not the taxonomy — it is "the things
   * that actually interrupted you", because those are the rules a person came
   * to write. In memory on purpose: it is a convenience, and a file that
   * accumulated every tool name ever seen would outlive its usefulness.
   */
  protected toolsSeen = new Set<string>();

  /**
   * One runner per plan, created on demand and kept.
   *
   * Keyed by slug because that is what every control is addressed by, and
   * because it is the guard: a second run of the SAME plan is the one kind of
   * concurrency that is never safe — two loops driving one phase graph, both
   * reading the same handoffs — so it answers 409, while a second run of a
   * DIFFERENT plan is exactly what the scheduler exists to allow.
   *
   * Kept after the run ends rather than deleted: the runner holds the last
   * `RunState` it drove, which is what the console reads between runs.
   */
  protected runners = new Map<string, Runner>();
  /**
   * `<runId>:<serverId>` pairs already announced as degraded. See
   * `announceMcpDegraded` — the fact is worth saying once and not once per
   * phase. Process-lifetime only, deliberately: a console restart is a fair
   * moment to be told again about a server that is still missing.
   */
  protected degradedAnnounced = new Set<string>();
  /** Admission control shared by every runner in the pool. See `scheduler.ts`. */
  readonly scheduler: Scheduler;
  /** The convergence loop's clock — boot, change, timer, halt, button. See `converge.ts`. */
  readonly converger: ConvergeScheduler;
  /**
   * The watch scheduler — the OTHER clock (`watch-scheduler.ts`). Separate from
   * `converger` because it answers a different question on a different cadence:
   * convergence asks whether the situation changed, this asks whether the world
   * did. Opened and closed with the convergence loop, so one switch still turns
   * the console's autonomy off.
   */
  readonly watchClock: WatchScheduler;
  /**
   * Settles when this `open()`'s boot work is done: queued runs re-adopted and
   * the convergence loop's boot pass over every plan complete. What a harness
   * awaits instead of guessing how long the console takes to look around.
   */
  bootSettled: Promise<void> = Promise.resolve();
  readonly approvals: Approvals;
  readonly push: Push;
  /**
   * The fourth leg out of `announce` — the same events, to a channel the
   * operator already watches. Constructed unconditionally so the registry can
   * be READ on a console without `--allow-webhooks`; it refuses to deliver by
   * itself (`Webhooks#announce` returns at its first line when the flag is off).
   */
  readonly webhooks: Webhooks;
  /**
   * Notification action tokens already spent.
   *
   * In-memory on purpose: a restart forgetting them is safe, because the
   * operations a token can reach refuse a second answer on their own. This
   * only makes the double-tap cheap and gives it an honest word instead of a
   * second attempt at an answered card. `push/actions.ts` has the reasoning.
   */
  readonly pushActions = new SpentTokens();
  readonly notifications: Notifications;
  readonly terminals: Terminals;
  /**
   * Who is in this repository right now — every Claude session the user-scope
   * hook reports (a person's `claude`, a console agent, an autopilot lane),
   * with its presence. See `sessions/registry.ts`. Per instance, like the
   * accounts: two consoles on one machine are two projects.
   */
  readonly sessions: SessionRegistry;
  /**
   * The per-phase review verdicts — this console's own, beside the run.
   *
   * Resolved through a closure rather than a captured path because `open()`
   * can re-point the console at another source root while it runs, and a store
   * holding the previous instance's directory would keep answering about the
   * plan the operator just left. See `review.ts` for why a verdict lives here
   * and not in `docs/`.
   */
  readonly reviews: ReviewStore = new ReviewStore((slug) =>
    this.root ? join(STATE_DIR, 'runs', instanceId(this.root.path), slug, 'review') : null,
  );
  /** `POST /hooks/session` token bucket — the hook fires per turn of every session on the machine. */
  protected hookBucket = { tokens: HOOK_EVENTS_PER_MINUTE, at: Date.now() };

  /**
   * Which waiting episode each session was last pushed about — sessionId →
   * `waiting.since`. The push moment is the TRANSITION (a new episode), never
   * the repeat Notification the CLI fires while still waiting; the tag already
   * collapses what slips through. In-memory like the other dedupe maps: a
   * restart re-announces at most once per still-live episode.
   */
  protected waitingAnnounced = new Map<string, string>();
  /** The unsupervised-outcome inbox: `runs/<instance>/<slug>/outcomes/` under watch while a root is open. */
  protected outcomeWatcher: FSWatcher | null = null;
  protected outcomeTimers = new Map<string, NodeJS.Timeout>();

  /** The inbox floor — see `OUTCOME_INBOX_SWEEP_MS`. */
  protected outcomeSweep: ReturnType<typeof setInterval> | null = null;
  /**
   * What sessions nobody here spawned declared, by `slug:phase` — the
   * classifier's `declared` evidence for a hand-run phase (a `blocked` or
   * `needs-human` from a person's session drives the same ladder as a lane's).
   */
  protected declaredOutcomes = new Map<
    string,
    NonNullable<PhaseEvidence['declared']> & { sessionId?: string }
  >();
  /** This instance's Claude accounts — registry, meters, per-run environments. */
  readonly accounts: Accounts;
  protected accountsEmitTimer: NodeJS.Timeout | null = null;
  /** This instance's MCP servers — registry, credentials, health, per-run configs. */
  readonly mcp: Mcp;
  protected mcpEmitTimer: NodeJS.Timeout | null = null;
  /**
   * The issue estate — every repository this console stands on, and its issues.
   *
   * Per-instance like `accounts` and `mcp`, and for the same reason: two
   * consoles on one machine are two projects, and one project's backlog is not
   * the other's. It holds no credential — `gh` authenticates itself — and it
   * never writes to GitHub (`server/issues/`).
   */
  readonly issues: IssuesStore;
  protected issuesSweepTimer: NodeJS.Timeout | null = null;

  /**
   * Presence events raised while this object was still being built.
   *
   * `SessionRegistry.load()` reads the records AND whatever the hook dropped in
   * the inbox while no console was up, then prunes — and every one of those
   * moves calls back into `onPresenceChange`. That callback runs on the right
   * side of `this.sessions = new SessionRegistry({…}).load()`, so at that
   * moment `this.sessions` is still `undefined` (and `this.scheduler` and
   * `this.converger`, assigned further down, doubly so). Three hard Node
   * crashes came from exactly that — `Cannot read properties of undefined
   * (reading 'presence')` with `uptimeSeconds: 0` and no shutdown path, in a
   * launchd unit whose restart made the crash-loop look like slowness.
   *
   * So a callback that arrives before the object exists is not dropped and not
   * answered: it is parked here and applied once construction has unwound (see
   * `queuePresenceChange`). Bounded, because a poisoned inbox is exactly the
   * case that produces a lot of them at once.
   */
  private presenceBacklog: Array<{ record: SessionRecord; event: SessionEventName | 'prune' | 'heartbeat' }> =
    [];
  /** False until construction has unwound; see `presenceBacklog`. */
  private presenceReady = false;

  constructor(flags: Flags) {
    this.flags = flags;
    this.prefs = loadPrefs();
    this.sizing = loadSizing(flags.scriptsDir);
    this.mcpSizing = loadMcpSurcharge(flags.scriptsDir);
    this.gateVocab = loadGateVocab(flags.scriptsDir);
    // A new shell opens where you are working, not in `$HOME` — the source
    // directory is what every command you were about to type is relative to.
    this.terminals = new Terminals({
      allowed: flags.allowTerminal,
      agentAllowed: agentEnabled(flags),
      // Signing an account in needs a pty for exactly one fixed command; the
      // accounts flag is that permission without opening free-form sessions.
      loginAllowed: flags.allowAccounts,
      cwd: () => this.root?.path,
      // Every pty session — agent, QA, plan wizard, a plain shell — learns the
      // MCP registry, so `validate.sh` run by hand fires F15 instead of
      // silently skipping it (the advisory was dead in production because
      // launchd's env never carried it).
      baseEnv: () => ({ PE_MCP_SERVERS: this.mcp.enabledIds().join(' ') }),
      onSession: (event) => this.onSessionEvent(event),
    });
    // Sessions the pty broker is still holding — the ones the LAST console
    // left running. Fire and forget on purpose: adopting is a `stat` when no
    // broker has ever run here, and a console must not wait on it to serve a
    // board. `resume()` swallows its own failures and never starts a broker.
    void this.terminals.resume().then((adopted) => {
      if (!adopted) return;
      this.emit('sessions', {
        type: 'adopted',
        adopted,
        sessions: this.terminals.state().sessions,
        live: this.terminals.live(),
        foreign: this.sessionViews(),
      });
    });
    this.push = new Push(flags.remoteUsers);
    // `link` is a closure rather than a string because `flags.port` moves after
    // construction — `resolvePort` may pick a different one, and a payload that
    // baked in the requested port would send the operator to a console that is
    // not there. `INSTANCE.name` names WHICH console spoke, which matters the
    // moment somebody points two of them at one channel.
    this.webhooks = new Webhooks({
      enabled: flags.allowWebhooks,
      instance: INSTANCE.name,
      link: (url) => `${instanceUrl(flags.port, flags.host)}${url}`,
    });
    // The console's own alarm channel must not fail silently: 29 real sends
    // died on BadJwtToken/BadWebPushTopic with nothing but log lines. A
    // classified streak lands on the environment card and the out-of-band leg
    // — never on push itself (the channel under suspicion cannot carry its
    // own obituary). Once per service|reason per process.
    this.push.onPersistentReject = ({ service: pushService, reason, streak, devices }) => {
      const key = `${pushService}|${reason}`;
      if (this.pushHealthAnnounced.has(key)) return;
      this.pushHealthAnnounced.add(key);
      const fix =
        reason === 'BadJwtToken'
          ? 'Usual causes: the machine clock is skewed, or the device subscribed under a different ' +
            'VAPID key. Fix the clock, or remove and re-subscribe the device in Settings → Notifications.'
          : reason === 'BadWebPushTopic'
            ? 'Subscriptions predating the hashed-topic fix keep failing — remove and re-subscribe the device.'
            : 'Remove and re-subscribe the device in Settings → Notifications, and check the network.';
      this.environment.issues.push({
        kind: 'push-broken',
        detail:
          `${pushService} is rejecting this console's pushes (${reason}, ${streak} in a row, ` +
          `${devices.length} device${devices.length === 1 ? '' : 's'})`,
        fix,
      });
      log.warn('push.health', { service: pushService, reason, streak, devices });
      notifyOutOfBand(
        'Phase Console: push delivery is broken',
        `${pushService} rejects with ${reason} — see Settings → Notifications`,
      );
    };
    // A notification that reached NONE of its devices. Distinct from the streak
    // above, and not covered by it: three stall cards died on two devices
    // across two services, so neither `service|reason` key ever reached 3 and
    // the only trace was a log line. Once per process — the point is that the
    // operator learns the channel is not arriving, not that they learn it forty
    // times — and on the health card rather than as a push, because the channel
    // under suspicion cannot carry its own obituary.
    this.push.onUndelivered = ({ category, title, devices }) => {
      log.warn('push.undelivered', { category, title, devices });
      if (this.pushHealthAnnounced.has('undelivered')) return;
      this.pushHealthAnnounced.add('undelivered');
      const outcomes = [...new Set(devices.map((d) => d.outcome))].join(', ');
      this.environment.issues.push({
        kind: 'push-broken',
        detail:
          `A notification reached none of this console's ${devices.length} device` +
          `${devices.length === 1 ? '' : 's'} ("${title}" — every attempt came back ${outcomes})`,
        fix:
          'Notifications are being sent and are not arriving. Send a test from ' +
          'Settings → Notifications; if that fails too, remove and re-subscribe the device.',
      });
      notifyOutOfBand(
        'Phase Console: a notification reached nobody',
        `${title} — see Settings → Notifications`,
      );
    };
    this.notifications = new Notifications();
    // The environment doctor: computed once (this process's env cannot
    // change), carried on state(), and — for the one finding that means the
    // unit was installed as somebody else — announced on the health channel.
    this.environment = { issues: environmentReport() };
    // The announce is suppressed under a test runner: the doctor reads the
    // AMBIENT machine env, and a developer whose own shell PATH carries the
    // defect would otherwise leak a health notification into every suite that
    // pins exact announcement sets. The report itself still computes — tests
    // assert on state().environment, not on the ambient push.
    const testing = process.env.NODE_TEST_CONTEXT || process.env.VITEST;
    // A VAPID key that could not be READ disables push instead of minting a
    // replacement, because minting is what silently unsubscribes every device.
    // It rides `push-broken` — the same kind, the same card, the same errand
    // shape — so the inbox row and the launch dialog's "this run will ask for a
    // tap nobody will hear" warning both fire with no client change. The cause
    // is in `detail`, exactly as the three reject reasons already are.
    if (this.push.keyFailure) {
      this.environment.issues.push({
        kind: 'push-broken',
        detail: this.push.keyFailure.error,
        fix: this.push.keyFailure.fix,
      });
      if (!testing) {
        notifyOutOfBand(
          'Phase Console: push is off',
          `${this.push.keyFailure.error} — see Settings → Notifications`,
        );
      }
    }
    if (this.environment.issues.length) log.warn('env.doctor', { issues: this.environment.issues });
    const foreign = this.environment.issues.find((issue) => issue.kind === 'path-foreign-home');
    if (foreign && !testing) {
      this.announce('health', {
        title: 'Console environment needs attention',
        body: `${foreign.detail}. ${foreign.fix}`,
        tag: tagFor('health', 'env-doctor'),
      });
    }
    this.watcher = new DocsWatcher((paths) => this.onChange(paths));
    // The session registry: loaded from disk (records + whatever the hook
    // dropped in the inbox while no console was up), then watching the inbox.
    this.sessions = new SessionRegistry({
      dir: join(INSTANCE_STATE_DIR, 'sessions'),
      onChange: (record, event) => this.queuePresenceChange(record, event),
      onWarn: (what, detail) => log.warn(what, detail),
    })
      .load()
      .start();
    this.approvals = new Approvals({
      notify: (approval) => {
        this.emit('approval', approval);
        const where = `${approval.slug}${approval.phase != null ? ` phase ${approval.phase}` : ''}`;
        this.announce(
          'approval',
          {
            title: approval.kind === 'verify' ? 'A check only you can make' : 'Permission needed',
            body: `${where} — ${approval.title}`,
            tag: tagFor('approval', approval.id),
            detail: approval.detail,
          },
          {
            slug: approval.slug,
            phase: approval.phase,
            runId: approval.runId,
            approvalId: approval.id,
            // Allow/Deny on the notification itself. `approvalId` still rides
            // beside it for a worker older than action tokens, which synthesises
            // the same two buttons from it — see `shared/sw-push.js`.
            answer: {
              item: inboxItemId({
                kind: 'approval',
                slug: approval.slug,
                phase: approval.phase,
                runId: approval.runId,
                subject: approval.id,
              }),
              verbs: ['allow', 'deny'],
            },
          },
        );
      },
      // A decision made anywhere is now true everywhere. Every ending arrives
      // here — a click, a tap on a phone, the timeout, `disarm()` when the run
      // ends — because the hook is inside the settle closure itself.
      resolved: (approval) => {
        this.emit('approval:resolved', {
          id: approval.id,
          status: approval.status,
          decidedBy: approval.decidedBy,
          decidedAt: approval.decidedAt,
          reason: approval.reason,
          runId: approval.runId,
          slug: approval.slug,
          phase: approval.phase,
          title: approval.title,
        });
      },
    });
    this.scheduler = new Scheduler({
      max: () => this.flags.maxSessions,
      // The usage walls, read from the ONE place that persists them. Without
      // this the scheduler kept its own `Map` of the same fact, and the two
      // diverged across a restart — the registry remembered the window, the
      // admission gate did not, and the next entry in the queue spent a whole
      // session finding out.
      //
      // Forwarded through arrows rather than handed `this.accounts` directly:
      // the scheduler is constructed before the registry is, so a direct
      // reference would read `undefined` here. Every call is late-bound.
      accountWalls: {
        limitedUntil: (accountId, nowMs) => this.accounts.limitedUntil(accountId, nowMs),
        markLimited: (accountId, bucket, resetsAt) => this.accounts.markLimited(accountId, bucket, resetsAt),
        accountIds: () => this.accounts.accountIds(),
      },
      // Every lock on disk, across every plan the store has scanned — which is
      // how a session this console never started (a human in a terminal, a
      // bash worker) gets a say in what the autopilot is allowed to begin.
      locks: () => this.allLocks(),
      // The entry's OWN phase, read live off disk: the one holder the store's
      // watcher-debounced view can lag on (a same-phase claim written seconds
      // ago). Without it admission granted, the boarding belt-check refused,
      // and the loop re-boarded ~1 Hz until the store caught up.
      liveLock: (slug, phase) => {
        const handoffsDir = this.root?.handoffsDir;
        if (!handoffsDir || this.store?.get(slug)?.plan?.closed) return null;
        const lock = readLock(handoffsDir, slug, phase);
        return lock
          ? {
              slug,
              phase: lock.phase,
              owner: lock.owner,
              expired: lock.expired,
              scope: lock.scope,
              ...(lock.leaseUntil != null ? { leaseUntil: lock.leaseUntil } : {}),
              ...(lock.session ? { session: lock.session } : {}),
              // The branch the holder's work rides — the field the scheduler's
              // carve-out is decided on. Forwarded HERE as well as in `allLocks`
              // because this is the same-phase read that corrects a lagging store,
              // and a lock the store has not seen yet would otherwise arrive
              // unqualified and serialise an isolated run against nothing.
              ...(lock.branch ? { branch: lock.branch } : {}),
              ...(lock.worktree ? { tree: lock.worktree } : {}),
            }
          : null;
      },
      // A lock with no `scope=` line: recover what the plan says that phase
      // touches rather than reading it as `all`. See `SchedulerDeps.scopeFor`.
      scopeFor: (slug, phase) => this.scopeOf(slug, phase),
      // How much longer a holder's plan has — decoration on the queue page,
      // never an input to the decision. Synchronous off the memo above, so a
      // cold answer is `undefined` rather than an await inside the scan.
      etaFor: (slug) => this.etaHint(slug),
      // Presence beats the lease: a lock whose session the registry shows
      // ended stops blocking NOW; a live one is named as live on the queue.
      presence: (lock) => this.sessions.presenceOfLock(lock),
      // The repository guard is a preference, read per call so a flip in the
      // settings page lands on the very next poll. Off never means unguarded
      // within one run — see `SchedulerDeps.guard`.
      guard: () => this.prefs.repoGuard !== false,
      // When this console is willing to START phases. A preference like the
      // guard, read per call for the same reason: an operator who sets quiet
      // hours at 21:55 means tonight, not after the next restart.
      schedule: () => this.prefs.boardingSchedule,
      // The operator's hold, read per call like the guard so a Release lands on
      // the very next scan. A hold lives on the run's own checkpoint, which is
      // why this is answered from the live runner rather than from a table
      // here: one fact, one place, and it survives a restart with the run.
      holdFor: (slug) => this.runners.get(slug)?.current()?.hold ?? null,
      // `startAfter`, resolved against the predecessor plan's latest run. See
      // `SchedulerDeps.chainBlocker` for why this is a holder and not a
      // convergence special case.
      chainBlocker: (slug) => {
        const after = this.runners.get(slug)?.current()?.startAfter;
        if (!after || after === slug) return null;
        return this.planRunSettled(after) ? null : after;
      },
      // The panic button, read per call like the guard and the hold — a Thaw
      // all lands on the very next scan rather than after the next restart.
      // First in both of the scheduler's scans; see `SchedulerDeps.fleetHold`.
      fleetHold: () => this.fleetHold(),
      onChange: (snapshot) =>
        this.emit('run:queue', {
          max: snapshot.max,
          live: snapshot.live,
          queued: snapshot.queued,
          throttledUntil: snapshot.throttledUntil,
          throttledAccounts: snapshot.throttledAccounts,
          schedule: snapshot.schedule ?? null,
        }),
    });
    // The convergence loop. Its passes go through `convergeNow` (which builds
    // the deps from this service's own store, board cache, runner pool and
    // healer); its clock is the real one unless a harness swaps it first.
    this.converger = new ConvergeScheduler({
      run: (slug, trigger, lastNoop) => this.convergeNow(slug, trigger, lastNoop),
      slugs: () => this.convergeSlugs(),
      everyMs: () => this.prefs.convergeEveryMs,
      // The panic button. Every trigger but the operator's own press finds the
      // console frozen and journals it; see `ConvergeSchedulerDeps.fleetHold`.
      fleetHold: () => this.fleetHold(),
      // The full flattened view rides the event (`convergeView`) — the Pulse
      // writes it straight into its cache, phase by phase, no refetch.
      onReport: (report) => this.emit('run:converge', convergeView(report)),
    });
    // The watch clock. Everything it needs to ask a question it cannot answer
    // itself is handed in here, and each one defaults to "no answer" rather
    // than to an assumption — a console with no scheduler cannot know whether
    // a scope is free, and one with `watchCmdRefs` off has decided not to ask.
    this.watchClock = new WatchScheduler({
      runs: () => this.watchableRuns(),
      journal: (slug, state, kind, data, phase) => {
        if (!this.root?.ok) return;
        new Journal(this.root.path, slug, state.id).append(kind, data, phase);
      },
      save: (_slug, state) => {
        saveRun(state);
      },
      onLanded: (slug, state, phase, landed) => this.onWatchLanded(slug, state, phase, landed),
      fleetHold: () => this.fleetHold(),
      // A landed offer is HELD while its delivery is still being driven. The
      // healer holds the drive's own promise — which settles exactly when the
      // drive does — so this, and never a stamp signed before the work
      // happened, is what "in flight" means (QA round 3, H1).
      resumeInFlight: (slug, phase) => this.watchResumeInFlight(slug, phase),
      // `lock:<slug>/<N>` — answered from the console's own lock store rather
      // than by shelling `phase-lock.sh`: this runs on a timer over every
      // watched phase, and the store is the same evidence `conflicts` reads.
      // Three ways to be free and they are not the same fact: nothing holds it
      // at all, the lease lapsed, or the holding SESSION ended (which is what
      // makes a claim debris before its lease says so).
      lockFree: (slug, phase) => {
        const lock = this.allLocks().find((l) => l.slug === slug && l.phase === phase);
        if (!lock) return true;
        if (lock.expired) return true;
        return this.lockPresenceFor(lock) === 'ended';
      },
      // `cmd:` — off unless the operator turned it on AND the console may run
      // things at all. `--allow-run` is the capability that makes every other
      // unattended act real; a console that may not spawn a session must not
      // execute a session's recorded command either.
      cmdRefsEnabled: () => this.flags.allowRun && this.prefs.watchCmdRefs !== false,
      runCommand: (command, timeoutMs) =>
        runSingleCommand(command, {
          cwd: this.root?.path ?? process.cwd(),
          timeoutMs,
        }),
    });
    // No flag: reading the issues of the repository you pointed this console at
    // is DISPLAY, exactly like `sessions/registry` and the repo browse surface.
    // Acting on them — minting a plan session — is the plan wizard's own
    // `--allow-agent` door, unchanged.
    this.issues = new IssuesStore({
      root: () => this.root?.path,
      stateDir: INSTANCE_STATE_DIR,
    });
    this.accounts = new Accounts({
      onChange: () => this.emitAccounts(),
      // The meters warn before the wall: 80 is "plan your afternoon", 95 is
      // "the next long phase will not finish". Its own category, off by
      // default — the wall itself (and everything a run does about one) stays
      // under `limits`, so muting the climb never mutes the crash.
      onThreshold: (view, bucket, level, utilization, resetsAt) => {
        const name = view.email ?? view.name ?? view.id;
        const when = new Date(resetsAt);
        const reset = Number.isNaN(when.getTime()) ? resetsAt : when.toLocaleString();
        this.announce('usage-climbing', {
          title:
            level === 'alert'
              ? `Usage window nearly spent — ${bucketLabel(bucket)}`
              : `Usage climbing — ${bucketLabel(bucket)}`,
          body: `${name}: ${Math.round(utilization)}% of the ${bucketLabel(bucket)} window used · resets ${reset}`,
          tag: tagFor('usage-climbing', view.id, bucket, resetsAt),
        });
      },
      // A login that went from known-good to broken. Rides the `limits`
      // category (its catalogue copy claims sign-in failures), fires once per
      // transition — the poller's own refresh has already been tried.
      onAuthChange: (view, state) => {
        const name = view.email ?? view.name ?? view.id;
        this.announce('limits', {
          title: `Sign in again — ${name}`,
          body:
            state === 'expired'
              ? `${name}'s Claude login has expired and could not be refreshed. Sessions on it will ` +
                'fail until someone signs in again — Settings → Claude accounts has the button.'
              : `${name} is signed out. Sign in again from Settings → Claude accounts before running ` +
                'work as it.',
          tag: tagFor('limits', 'auth', view.id),
        });
      },
    });
    this.mcp = new Mcp({
      onChange: () => this.emitMcp(),
      // A server's advertised tools changed under a plan that already trusted
      // it. This is the documented MCP supply-chain attack — a server that was
      // safe when it was attached, republished with a tool that is not — and a
      // client's only defence is to have written down what it used to be. Rides
      // `health` — the console reporting on its own equipment, as
      // `announceMcpDegraded` does — never `limits`, whose catalogue copy is
      // about usage windows and would mute a supply-chain warning under the
      // wrong switch.
      onToolsChanged: (view, added, removed) => {
        const parts = [
          added.length ? `added ${added.join(', ')}` : '',
          removed.length ? `removed ${removed.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('; ');
        this.announce('health', {
          title: `MCP server changed its tools — ${view.label}`,
          body:
            `${view.label} now advertises different tools (${parts}). Review it before the next ` +
            'run attaches it: a server whose tools change under you is how a trusted integration ' +
            'becomes an untrusted one.',
          tag: tagFor('health', 'mcp-drift', view.id),
        });
      },
      // A server changed state in a way somebody would want to know about.
      // Transitions only — the poller has already tried; this is the point at
      // which a person could act.
      onStatusChange: (view, status) => {
        if (status === 'connected') {
          this.announce('health', {
            title: `MCP server back — ${view.label}`,
            body: `${view.label} is connected again and available to runs on this console.`,
            tag: tagFor('health', 'mcp', view.id, status),
          });
          // Whatever parked on it can go. This is the trigger that was missing:
          // a sign-in through the console's own terminal already called this,
          // but a server that recovered any other way did not.
          void this.healMcpParks(view.id);
          return;
        }
        this.announce('health', {
          title: `MCP server unavailable — ${view.label}`,
          body:
            status === 'needs-auth'
              ? `${view.label} needs signing in, and an unattended run cannot do it. Phases that name this ` +
                'server will run without it and say so, unless the plan requires it — Settings ▸ MCP has ' +
                'the button.'
              : `${view.label} will not connect${view.issue ? `: ${view.issue}` : ''}. Phases that name it ` +
                'will run without it and say so, unless the plan requires it.',
          tag: tagFor('health', 'mcp', view.id, status),
        });
      },
    });
    // Meters run for the life of the process, not the life of a source dir —
    // accounts are an instance fact, and the header shows them on every page.
    this.accounts.startPolling();
    // A fault anywhere in the process reaches the browser as a health event,
    // so a degraded console announces itself instead of looking healthy.
    onDegraded((state) => {
      this.emit('health', { ...state, watcher: this.watcher.status() });
      // The supervisor failing quietly is the worst case here: every other
      // surface still looks exactly like a console that is working.
      this.announce('health', {
        title: 'Phase Console is degraded',
        body: `${state.kind}: ${state.message}`,
        tag: tagFor('health', state.kind, state.message),
      });
    });
    // Construction is over when the stack unwinds, not when this line runs:
    // the derived classes' own field initializers run after `super()` returns,
    // so the earliest moment at which the whole object exists is the first
    // microtask. Draining there needs no cooperation from any subclass, which
    // is the point — a future subclass field cannot forget to flush.
    queueMicrotask(() => this.flushPresenceBacklog());
  }

  /**
   * A presence move, applied now or parked until the object exists.
   *
   * See `presenceBacklog`. The bound is 500 records: a poisoned inbox is the
   * case that mints these, and a backlog nobody could ever drain is a second
   * way to fall over at boot. Oldest wins — the first events of a boot are the
   * ones that carry the ended sessions whose locks are debris.
   */
  private queuePresenceChange(record: SessionRecord, event: SessionEventName | 'prune' | 'heartbeat'): void {
    if (this.presenceReady) {
      this.onPresenceChange(record, event);
      return;
    }
    if (this.presenceBacklog.length >= PRESENCE_BACKLOG_MAX) {
      log.warn('sessions.presence-backlog-full', { dropped: `${record.sessionId}:${event}` });
      return;
    }
    this.presenceBacklog.push({ record, event });
  }

  /**
   * Apply what arrived during construction. Idempotent, and each event is
   * isolated: one unreadable record must not take the boot down with it — that
   * is the whole defect this exists for.
   */
  protected flushPresenceBacklog(): void {
    if (this.presenceReady) return;
    this.presenceReady = true;
    const pending = this.presenceBacklog;
    this.presenceBacklog = [];
    for (const { record, event } of pending) {
      try {
        this.onPresenceChange(record, event);
      } catch (error) {
        log.warn('sessions.presence-apply-failed', {
          session: record.sessionId,
          event,
          error: (error as Error).message,
        });
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * The runner pool
   * ---------------------------------------------------------------- */

  /** The runner for a plan, made on first use. See `runners`. */
  runnerFor(slug: string): Runner {
    const existing = this.runners.get(slug);
    if (existing) return existing;
    const made = this.makeRunner();
    this.runners.set(slug, made);
    return made;
  }

  /** The runner DRIVING this plan right now, or null. */
  protected liveRunner(slug: string): Runner | null {
    const runner = this.runners.get(slug);
    return runner?.busy() ? runner : null;
  }

  /**
   * Has this plan's latest run ENDED — the question `startAfter` chains on.
   *
   * Settled means "no loop is behind it any more" (`isLiveStatus`), not
   * "finished": a chained run must proceed when its predecessor is paused,
   * parked, halted or interrupted, because none of those is going to become a
   * running run without somebody pressing something, and a chain that waited
   * for one would be a chain nobody could ever release.
   *
   * Three answers, in order of how much they know:
   *   1. a live runner in THIS process — the authority while it exists;
   *   2. a CLOSED plan — nobody is coming back to it, so it is settled
   *      whatever its last run says;
   *   3. the newest run file on disk, which is how the chain survives a
   *      console restart and how it sees a run another console drove.
   * No run at all is settled: a chain behind a plan nobody has ever started
   * has nothing to wait for, and blocking on it would be an unreleasable hold
   * on a typo.
   *
   * Synchronous like every other answer an admission scan reads — `latestRun`
   * is a directory read, and `runFor`'s async half is only the board
   * reconciliation, which cannot change whether a loop is behind the run.
   */
  protected planRunSettled(slug: string): boolean {
    const live = this.runners.get(slug)?.current();
    if (live) return !isLiveStatus(live.status);
    if (this.store?.get(slug)?.plan?.closed) return true;
    if (!this.root) return true;
    const state = latestRun(this.root.path, slug, this.liveRunId());
    return !state || !isLiveStatus(state.status);
  }

  /** Every runner with a loop behind it, in no particular order. */
  protected liveRunners(): Runner[] {
    return [...this.runners.values()].filter((runner) => runner.busy());
  }

  /**
   * Every run this process is genuinely driving.
   *
   * A Set rather than an id, because that is what it now is. Every read of a
   * run passes through it: a `running` status on disk is a claim by a process
   * that may have been killed since, and this is the only thing that says
   * whether anything is behind it.
   */
  protected liveRunIds(): Set<string> {
    const ids = new Set<string>();
    for (const runner of this.liveRunners()) {
      const id = runner.current()?.id;
      if (id) ids.add(id);
    }
    return ids;
  }

  /**
   * Clear away the worktrees of every run that is over — the boot half of D10.
   *
   * A console killed mid-run (a crash, a SIGKILL, a machine that lost power)
   * leaves its `integration/` registered and CHECKED OUT on `pe/<slug>`.
   * `git worktree prune` will not touch it, because prune drops registrations
   * whose DIRECTORY is gone and this one is intact — so every later run of that
   * plan meets "already checked out at …", degrades to sharing the operator's
   * checkout, and the feature is silently off until somebody runs
   * `git worktree remove --force` by hand. Nobody ever did, because nothing
   * anywhere said so. Lane directories wedge the same way: `pe/<slug>-pN` is
   * per-plan-per-phase, NOT per-run.
   *
   * Sibling of `sweepRunSecrets` above and, like it, the ONLY sweep that can
   * collect after a crash — a run that ends in order prunes its own trees in
   * the runner's `finally`. Both are keyed on `liveRunIds()`, a fact about
   * processes rather than a status on disk, and the second belt is the recorded
   * child pids: a session can outlive the console that spawned it, and its lane
   * is the tree it is still writing.
   *
   * Never removes a checkout holding work — unlanded commits or anything
   * uncommitted at all keep it, and `worktree.ts` §`sweepStale` owns that rule.
   */
  protected async sweepStaleWorktrees(): Promise<void> {
    if (!this.root?.ok) return;
    const root = this.root.path;
    const live = this.liveRunIds();
    for (const record of this.store?.list() ?? []) {
      try {
        const stateDir = runDir(root, record.slug);
        const result = await sweepStale(root, {
          // BOTH homes: whatever the setting says today, a tree made under the
          // other one is still this console's to sweep.
          homes: WORKTREE_ROOTS.map((mode) => worktreeHome({ mode, root, slug: record.slug, stateDir })),
          slug: record.slug,
          liveRunIds: live,
          children: (runId) =>
            childrenOf(loadRun(root, record.slug, runId) ?? ({ phases: {} } as RunState)).map(
              (child) => child.pid,
            ),
          probe: (pid) => pidHoldsWork(pid),
        });
        if (result.removed.length || result.kept.length) {
          log.info('run.worktrees-swept', {
            slug: record.slug,
            removed: result.removed,
            kept: result.kept,
            runs: result.runs,
          });
        }
      } catch (error) {
        // One plan's unreadable state directory must not stop the boot.
        log.warn('run.worktree-sweep-failed', { slug: record.slug, error });
      }
    }

    // Once for the whole repository, after every plan: the registrations that
    // were never ours. A prunable one holds a branch for ever and nothing else
    // drops it (`prune` is what `sweepStale` runs only when IT removed
    // something); a hand-made checkout on a `pe/*` branch is reported and
    // never touched. Both are facts about the repository rather than about any
    // one plan, so asking per plan would repeat the same answer N times.
    try {
      const stray = await sweepUnmanaged(root, {
        managed: managedRoots({ root, consoleDir: consoleRunsDir(root) }),
      });
      if (stray.pruned.length) log.info('run.worktrees-pruned', { unmanaged: stray.pruned });
      if (stray.unmanaged.length) {
        log.info('run.worktrees-unmanaged', {
          trees: stray.unmanaged.map((tree) => `${tree.dir} (${tree.branch})`),
        });
      }
    } catch (error) {
      log.warn('run.worktree-sweep-failed', { error });
    }
  }

  /**
   * Drop every per-run secret file no live run claims.
   *
   * The boot half of the mcp-config / settings prune (`pruneMcpConfigs`,
   * `pruneSettingsFiles`), and the only half that can collect after a crash:
   * an orderly ending sweeps itself in the runner's `finally`, but a console
   * that was SIGKILLed never reaches one, and its files — resolved MCP configs
   * with bearer tokens in them, settings files with the approval run token —
   * were simply immortal. Keyed on `liveRunIds()`, which is a fact about
   * processes rather than a status on disk.
   */
  protected sweepRunSecrets(): void {
    const keep = this.liveRunIds();
    const removed = [...pruneMcpConfigs(keep), ...pruneSettingsFiles(keep)];
    if (removed.length) log.info('run.secrets-swept', { files: removed.length, kept: keep.size });
  }

  /**
   * Drop run records nothing will read again.
   *
   * Nothing in the tree ever unlinked a `run-*.json`, so `listRuns()` re-read a
   * monotonically growing set on every plan open — for the life of the machine.
   * Sessions were already swept on this policy (`RETAIN_ENDED_MS`); runs simply
   * were not. Age AND count both have to be exceeded, and only a `finished` run
   * is ever a candidate, so this can never take the record somebody is looking
   * at. At `open()` only: a sweep on a read path is the defect above wearing a
   * different hat.
   */
  protected sweepOldRuns(): void {
    if (!this.root?.ok) return;
    const keep = this.liveRunIds();
    let removed = 0;
    for (const record of this.store?.list() ?? []) {
      try {
        removed += pruneRuns(this.root.path, record.slug, keep).length;
      } catch {
        /* one unreadable plan directory must not stop the sweep */
      }
    }
    if (removed) log.info('run.records-swept', { runs: removed, kept: keep.size });
  }

  /**
   * Probe the registered MCP servers now, and again every health TTL.
   *
   * `unref`'d, like every other background clock here: this must never be the
   * reason a process stays up. Idempotent — `open()` can be called again for a
   * new root, and the previous clock is replaced rather than doubled.
   */
  protected startMcpHealthClock(cwd: string): void {
    if (this.mcpHealthTimer) clearInterval(this.mcpHealthTimer);
    const tick = () => {
      // `refresh()` is single-flight and TTL-aware, and returns immediately
      // when nothing is registered — so this costs a process only when there
      // is genuinely something whose status may have gone stale. It announces
      // through the facade's own `onChange`, which is already wired, so there
      // is nothing to emit here.
      //
      // …unless the console is frozen. `refresh` shells out to `claude mcp` to
      // probe each registered server, which is a process the operator did not
      // ask for on a console they switched off at the wall. It is not an
      // auto-START — nothing it does can begin a run — but it is the one
      // remaining thing that spawns under a freeze, and "nothing runs" is
      // easier to keep true than "nothing that matters runs". The health cache
      // simply goes stale, which is what it does overnight anyway.
      if (this.fleetHold()) return;
      void this.mcp
        .refresh({ cwd })
        .catch((error: unknown) => log.warn('mcp.health.tick-failed', { error: (error as Error).message }));
    };
    this.mcpHealthTimer = setInterval(tick, HEALTH_TTL_MS);
    this.mcpHealthTimer.unref?.();
    tick();
  }

  /**
   * The issue estate's idle cadence.
   *
   * Same shape as the MCP health clock above and the same three properties:
   * `unref`'d so it never keeps a process up, idempotent so re-opening a root
   * replaces rather than doubles it, and silent under a freeze.
   *
   * One thing it deliberately does NOT do is probe at open. `sweep()` keeps
   * warm what an operator has already asked for and never discovers, so a
   * console that is merely running spends no GitHub quota at all — which is
   * why it is safe to leave this on with no flag. The first fetch of any
   * repository is an operator pressing Refresh.
   */
  protected startIssuesSweepClock(): void {
    if (this.issuesSweepTimer) clearInterval(this.issuesSweepTimer);
    this.issuesSweepTimer = setInterval(() => {
      if (this.fleetHold()) return;
      void this.issues
        .sweep()
        .catch((error: unknown) => log.warn('issues.sweep-failed', { error: (error as Error).message }));
    }, ISSUES_SWEEP_MS);
    this.issuesSweepTimer.unref?.();
  }

  /** Every live run's state, first-started first. */
  runStates(): RunState[] {
    return this.liveRunners()
      .map((runner) => runner.current())
      .filter((state): state is RunState => Boolean(state))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * The run a verified hook token belongs to.
   *
   * Null when the token names nothing this console drives — a run that ended
   * between the child's call and this lookup. Answering `guarded` in that case
   * is the fail-safe direction: the strictest profile, never a neighbour's.
   */
  protected runBytoken(runId?: string | null): RunState | null {
    if (!runId) return null;
    for (const runner of this.liveRunners()) {
      const state = runner.current();
      if (state?.id === runId) return state;
    }
    return null;
  }

  /** The runner driving a given run id, for controls that arrive by id. */
  protected runnerByRunId(runId: string): Runner | null {
    for (const runner of this.liveRunners()) {
      if (runner.current()?.id === runId) return runner;
    }
    return null;
  }

  /** How full the console is: the header's answer, and `/api/queue`'s summary. */
  concurrency(): {
    max: number;
    live: number;
    queued: number;
    throttledUntil: number | null;
    throttledAccounts: { accountId: string; until: number }[];
    schedule?: { open: boolean; opensAt: number | null; reason: string | null } | null;
  } {
    const snapshot = this.scheduler.snapshot();
    return {
      max: snapshot.max,
      // Lanes, not runs. One run driving three phases is three sessions on this
      // machine, and the cap is about sessions.
      live: snapshot.live,
      queued: snapshot.queued,
      throttledUntil: snapshot.throttledUntil,
      throttledAccounts: snapshot.throttledAccounts,
      // Reported even when open, so the header can say "boarding paused until
      // 09:00" without a phase having to fail to start first.
      schedule: snapshot.schedule ?? null,
    };
  }

  /**
   * The queue, in full — what is holding a scope and what is waiting on it.
   *
   * `waitingOn` carries the holder of each collision, because "queued" on its
   * own is the same unhelpful non-answer `status: pausing` used to be: it says
   * a thing is not happening without saying what would have to change.
   */
  queueSnapshot(): ReturnType<Scheduler['snapshot']> {
    return this.scheduler.snapshot();
  }

  /**
   * Each phase of a plan, its declared scope, and what that scope collides with.
   *
   * Read straight off the same two sources admission uses — the Repos column
   * and the live locks — so the page cannot show one answer while the
   * scheduler acts on another.
   */
  phaseScopes(slug: string): { phase: number; scope: string[]; conflicts: string[] }[] {
    const rows = this.store?.get(slug)?.plan?.graph ?? [];
    const locks = this.allLocks().filter((lock) => !lock.expired);
    const grants = this.scheduler.snapshot().grants;
    return rows.map((row) => {
      const scope = scopeOfRow(row.repos);
      const conflicts: string[] = [];
      for (const lock of locks) {
        if (lock.slug === slug && lock.phase === row.phase) continue;
        const other = lock.scope?.length ? lock.scope : (this.scopeOf(lock.slug, lock.phase) ?? ['all']);
        if (scopesIntersect(other, scope)) conflicts.push(`${lock.slug} phase ${lock.phase} (${lock.owner})`);
      }
      for (const grant of grants) {
        if (grant.slug === slug && grant.phase === row.phase) continue;
        if (scopesIntersect(grant.scope, scope)) {
          conflicts.push(`${grant.slug}${grant.phase == null ? '' : ` phase ${grant.phase}`} (running)`);
        }
      }
      return { phase: row.phase, scope, conflicts: [...new Set(conflicts)] };
    });
  }

  /** Every lock on disk, across every plan — the scheduler's view of the world. */
  /**
   * The registry's word on a lock's session — with this console's own LIVE runs
   * carved out, which is the clause every other reader of this rule already
   * carries: the scheduler skips `lock.owner === own`, boarding's belt-check
   * requires `holder !== owner`, and `endedSessionLocks` drops
   * `live.has(runId)` — "minus this console's own live runs' claims (their
   * runners release their own)".
   *
   * Not an optimisation. A lane HOLDS its phase lock across verification with
   * the attempt's session already exited — up to twelve hours — and the lease
   * keepalive rewrites that lock every refresh still naming the ended session.
   * Without this the console calls a working phase's claim debris, and
   * `runner-loop.ts` records what happens when that claim goes: the phase "was
   * unlocked and read `ready` to every other session that looked".
   *
   * `unknown` rather than `live`, deliberately: the run holds it, but nobody is
   * vouching for that session, so the LEASE decides — which is exactly what
   * `unknown` means in `sessions/registry.ts`.
   */
  protected lockPresenceFor(lock: { owner: string; session?: string }): Presence {
    const runId = autopilotRunId(lock.owner);
    if (runId && this.liveRunIds().has(runId)) return 'unknown';
    return this.sessions.presenceOfLock(lock);
  }

  /**
   * The runs the watch clock scans: every open, phased plan's latest run that
   * has not finished.
   *
   * The LIVE runner's own state object is preferred over a fresh load, and that
   * is not an optimisation — the scheduler writes `watchState` onto the record
   * and saves it, and doing that to a second copy loaded from disk would race
   * the runner's own persist and lose whichever wrote first.
   */
  protected watchableRuns(): { slug: string; state: RunState }[] {
    if (!this.root?.ok) return [];
    const out: { slug: string; state: RunState }[] = [];
    for (const record of this.store?.list() ?? []) {
      if (!record.plan?.phased || record.plan.closed) continue;
      const live = this.runners.get(record.slug)?.current();
      const state = live ?? latestRun(this.root.path, record.slug, this.liveRunIds());
      if (!state) continue;
      // A finished run's declarations are history. Anything else — running,
      // parked, paused, halted — can still be moved by the world changing.
      if (state.status === 'finished') continue;
      out.push({ slug: record.slug, state });
    }
    return out;
  }

  protected allLocks(): LockView[] {
    const out: LockView[] = [];
    for (const record of this.store?.list() ?? []) {
      // Parity with `phase-lock.sh conflicts`, which skips closed plans: a
      // closed plan's leftover locks are debris, not holders.
      if (record.plan?.closed) continue;
      for (const lock of record.locks) {
        out.push({
          slug: record.slug,
          phase: lock.phase,
          owner: lock.owner,
          expired: lock.expired,
          scope: lock.scope,
          // The lease clock, so the scheduler can judge expiry live instead
          // of trusting the bit frozen at scan time — and arm a wake at it.
          ...(lock.leaseUntil != null ? { leaseUntil: lock.leaseUntil } : {}),
          // The holding session, so the registry can say whether it is still there.
          ...(lock.session ? { session: lock.session } : {}),
          // The branch the holder's work rides. Absent for every lock written
          // before the field existed, and absent is the colliding answer, so
          // this widens nothing on its own — see `LockView.branch`.
          ...(lock.branch ? { branch: lock.branch } : {}),
          // …and the tree, the other half of the carve decision.
          ...(lock.worktree ? { tree: lock.worktree } : {}),
        });
      }
    }
    return out;
  }

  /**
   * Which of a phase's direct dependencies have requested changes.
   *
   * Lives on this link rather than beside the other review members because
   * `makeRunner` below is where the runner's dep is wired, and a method the
   * base cannot see is not one the base can hand over.
   */
  reviewHoldFor(slug: string, phase: number): number[] {
    const row = this.store?.get(slug)?.plan?.graph.find((r) => r.phase === phase);
    if (!row) return [];
    return reviewHold(row.dependsOn ?? [], this.reviews.all(slug));
  }

  /**
   * The auto reviewer's two halves, implemented in `ServiceLive` — which is
   * where the git window, the review store and the invalidation live. Declared
   * here because `makeRunner` (above) hands them to every runner it builds.
   */
  abstract reviewerFacts(
    slug: string,
    phase: number,
    policy: ReviewerVerdictPolicy,
  ): Promise<ReviewerFacts | null>;

  abstract recordReviewerReport(slug: string, phase: number, report: ReviewerReport): void;

  /**
   * What "Give this run its own checkout" would DO for this plan, before any
   * run exists — the launch dialog renders this answer instead of a checkbox
   * that is guaranteed to be refused (G6). A dry run of the drive preamble's
   * decision chain: availability, scope confinement, and — under a
   * superproject — which repositories a mirror would mount.
   */
  async isolationPreflight(slug: string): Promise<IsolationPreview | null> {
    if (!this.root?.ok) return null;
    const record = this.store?.get(slug);
    if (!record?.plan) return null;
    const scopes = new Set<string>();
    for (const row of record.plan.graph) {
      for (const token of scopeOfRow(row.repos)) scopes.add(token);
    }
    // The whole answer — shape, mounts, and the branch-in-use probe — lives
    // beside the machinery it predicts (`previewIsolation`, worktree.ts),
    // where the git fixtures that test the decide can test the prediction.
    // The reclaim mode rides along, so the preflight promises exactly what the
    // launch would do: with it off, a checkout on the run branch is still a
    // refusal; with it on, the preview says which tree would be switched.
    return previewIsolation(
      this.root.path,
      slug,
      scopes,
      reclaimModeOf(this.prefs.isolationReclaim),
      // …and the live claims on this plan's scope, so the preview refuses
      // exactly what the launch's reclaim would refuse (precondition 4).
      this.occupiedTrees([...scopes]),
    );
  }

  /**
   * Every LIVE claim the run-checkout reclaim must not move under, for a run
   * touching `scope` — `RunnerDeps.occupiedTrees` and `previewIsolation`'s
   * list. Live means what the scheduler means: not lapsed by the clock, and
   * not a session the registry reports ENDED (`lockLapsed`); a closed plan's
   * leftovers are debris, as `allLocks` already treats them.
   *
   * 🔴 Read off the lock FILES, not the store. The store is the watcher's
   * 150 ms-debounced memory, and a claim written inside that window — a hand
   * session that claimed a second ago — is exactly the one this must see (the
   * lag class W8 closed for the scheduler's own-phase read). One `readdir` per
   * open plan; the store still says which plans exist and which are closed.
   *
   * Two shapes of claim, two answers:
   *  - `worktree=` written ⇒ a named tree, held wherever the run's scope lies:
   *    a path match is a fact about ground, not about scopes.
   *  - no `worktree=` ⇒ the claim never said where its work rides. The
   *    boot prompt's own `claim … --scope … --git` is this shape, and the
   *    first cut read it as "occupies nothing" — the opposite of the doctrine
   *    every other reader holds (an unqualified claim collides with
   *    everything). It holds every tree when its scope intersects the run's,
   *    and nothing when the two are disjoint; a lock that stated no scope is
   *    recovered from the plan as the scheduler recovers it, else `all`.
   */
  protected occupiedTrees(scope: readonly string[]): OccupiedTree[] {
    const now = Date.now();
    const asking = scope.length ? [...scope] : ['all'];
    const out: OccupiedTree[] = [];
    for (const lock of this.liveLockFiles()) {
      if (lockLapsed(lock, now, this.sessions.presenceOfLock(lock))) continue;
      const by = `${lock.owner}, ${lock.slug} phase ${lock.phase}${lock.session ? ` [session ${lock.session}]` : ''}`;
      if (lock.tree) {
        out.push({ tree: lock.tree, by, owner: lock.owner });
        continue;
      }
      const declared = lock.scope?.length ? lock.scope : this.scopeOf(lock.slug, lock.phase);
      if (!scopesIntersect(declared?.length ? declared : ['all'], asking)) continue;
      out.push({ by, owner: lock.owner });
    }
    return out;
  }

  /**
   * Every lock file on disk under every OPEN plan, parsed now — `allLocks`'s
   * shape from the files rather than from the store's last scan. A plan the
   * store does not know is not a plan; a plan it knows as closed is skipped
   * exactly as `allLocks` skips it. Any unreadable directory reads as no
   * locks there, which is what a plan with no `.locks/` is.
   */
  protected liveLockFiles(): LockView[] {
    const handoffsDir = this.root?.handoffsDir;
    if (!handoffsDir) return this.allLocks();
    const out: LockView[] = [];
    for (const record of this.store?.list() ?? []) {
      if (record.plan?.closed) continue;
      const dir = join(handoffsDir, record.slug, '.locks');
      let files: string[];
      try {
        files = readdirSync(dir).filter((name) => /^phase-\d+\.lock$/.test(name));
      } catch {
        continue;
      }
      for (const file of files) {
        const phase = Number.parseInt(file.slice('phase-'.length), 10);
        if (!Number.isFinite(phase)) continue;
        const lock = readLock(handoffsDir, record.slug, phase);
        if (!lock) continue;
        out.push({
          slug: record.slug,
          phase: lock.phase,
          owner: lock.owner,
          expired: lock.expired,
          scope: lock.scope,
          ...(lock.leaseUntil != null ? { leaseUntil: lock.leaseUntil } : {}),
          ...(lock.session ? { session: lock.session } : {}),
          ...(lock.branch ? { branch: lock.branch } : {}),
          ...(lock.worktree ? { tree: lock.worktree } : {}),
        });
      }
    }
    return out;
  }

  /** What a phase's Repos column says it touches. Undefined for an unknown plan. */
  protected scopeOf(slug: string, phase: number): string[] | undefined {
    const row = this.store?.get(slug)?.plan?.graph.find((r) => r.phase === phase);
    return row ? scopeOfRow(row.repos) : undefined;
  }

  private makeRunner(): Runner {
    const flags = this.flags;
    return new Runner({
      scriptsDir: flags.scriptsDir,
      approvals: this.approvals,
      scheduler: this.scheduler,
      // The panic button, for the one auto-start the runner owns that the
      // scheduler cannot see — the park poke. See `RunnerDeps.fleetHold`.
      fleetHold: () => this.fleetHold(),
      maxParallel: () => this.flags.maxSessions,
      // The registry's word on a lock's session, for the boarding belt-check:
      // an ended session's claim is released and boarding goes on.
      lockPresence: (lock) => this.sessions.presenceOfLock(lock),
      // The registry cannot learn a lane's liveness any other way: the run's
      // own settings file displaces the presence hook. See `RunnerDeps
      // .sessionHeartbeat`. Throttling is the registry's, not ours.
      sessionHeartbeat: (sessionId, opts) => {
        this.sessions.heartbeat(sessionId, opts);
      },
      // The store's handoff for a phase — status and Outstanding — for the
      // loop's own situation classifier and the re-board briefs. The board's
      // word already says `stuck`/`in-progress`; this is what it SAYS.
      handoffFor: (slug, phase) => {
        const record = this.store?.get(slug);
        const handoff = record ? handoffFor(record, phase) : undefined;
        return handoff
          ? { exists: true, status: handoff.status, outstanding: handoff.outstanding }
          : { exists: false };
      },
      // THE evidence builder (P6/D4) — the same one `Service.classifyPhase`
      // reads through, so the loop and the healer weigh one set of facts about
      // a phase rather than two that drift. The runner overlays only what is
      // RUN-local (its own root, the outcome it was handed, its clock, its
      // scope dirs, its git); everything else — the store's handoff, the lock
      // under one clock, the LIVE gate, `gateDelegated`, the registry hit, QA,
      // plan health — arrives from here. The runner's own copy lacked
      // `gateDelegated`, so with `delegateHumanGates` on it parked a delegated
      // gate with an errand for a gate nobody needed to clear.
      evidenceDeps: (slug) => this.evidenceDeps(slug),
      // The ladder's caps and the unblock switch — the same preferences the
      // healer reads, so the loop's climbs and the healer's count against one
      // budget.
      ladderCaps: () => ladderCaps(this.prefs),
      // The per-day cap's denominator. The runner cannot compute it — it sees
      // one run, and the cap is about the machine.
      dayHistory: () => this.dayRungs(),
      unblockAttempts: () => this.prefs.unblockAttempts !== false,
      // Opt-in, and absent means no: a phase with no §Verification parks
      // until an operator says the handoff alone is proof enough.
      allowUnverifiedPhases: () => this.prefs.allowUnverifiedPhases === true,
      // Opt-in, and absent means no: a `human` gate is a person's until an
      // operator says otherwise for their own console.
      delegateHumanGates: () => this.prefs.delegateHumanGates === true,
      // The console's own review hold. Not an engine read — see the dep's own
      // comment in `runner-core.ts` for why the engine must stay ignorant of it.
      reviewHold: (slug, phase) => this.reviewHoldFor(slug, phase),
      // The auto reviewer's two halves. Resolved here for the same reason the
      // QA and recovery briefings are: only the service can read the plan, run
      // the git window and write the review store, and only the runner may
      // spawn a session and spend money. Neither reaches into the other.
      reviewer: {
        facts: (slug, phase, policy) => this.reviewerFacts(slug, phase, policy),
        record: (slug, phase, report) => this.recordReviewerReport(slug, phase, report),
      },
      origin: `http://${flags.host}:${flags.port}`,
      // The registry ids, so the runner's own engine calls (its validate.sh in
      // confirm(), its board reads) carry PE_MCP_SERVERS like the service's do.
      mcpIds: () => this.mcp.enabledIds(),
      // The plan is the only source for what proves a phase worked, exactly as
      // it is the only source for what the phase should do.
      verificationText: (slug, phase) => this.store?.get(slug)?.plan?.phases[phase]?.verification,
      setupText: (slug, phase) => this.store?.get(slug)?.plan?.phases[phase]?.setup,
      // Raw-text presence check, distinct from the parsed field above: it is
      // what lets the park message tell "the plan omits it" apart from "the
      // plan states it in a shape the parser lost".
      verificationDeclared: (slug, phase) =>
        /\*\*\s*Verification\b/i.test(this.store?.get(slug)?.plan?.phases[phase]?.raw ?? ''),
      // …and where they mean to be run. Same store, same reason.
      verifyIn: (slug, phase) => this.store?.get(slug)?.plan?.phases[phase]?.verifyIn,
      // Read only to SUGGEST a `Verify in:` on a failure — never to pick a
      // directory. The Repos column has always been there; nothing read it.
      phaseRepos: (slug, phase) => {
        const row = this.store?.get(slug)?.plan?.graph.find((r) => r.phase === phase);
        return row ? splitRepos(row.repos) : undefined;
      },
      // The same cell, read as SCOPE: what admission decides on and what the
      // child is told it holds. Kept separate from `phaseRepos` above so a
      // cosmetic hint can never become the thing concurrency rests on.
      phaseScope: (slug, phase) => this.scopeOf(slug, phase),
      // …and for what it should run as. These bullets have been in the plan
      // format from the start; until now nothing read them.
      phaseDefaults: (slug, phase) => {
        const detail = this.store?.get(slug)?.plan?.phases[phase];
        if (!detail) return undefined;
        return { model: modelAlias(detail.model), effort: effortOf(detail.effort) };
      },
      // What the PLAN says this phase needs — its §Session budget line unioned
      // with its own `**MCP:**` bullet. Read from the parsed plan rather than
      // shelled per phase: the runner asks for this on every boarding, and
      // `engine-parity.test.ts` is what keeps the two readings honest.
      planMcp: (slug, phase) => {
        const plan = this.store?.get(slug)?.plan;
        if (!plan) return [];
        return [
          ...new Set([...(plan.sessionBudget.mcpServers ?? []), ...(plan.phases[phase]?.mcpServers ?? [])]),
        ];
      },
      // What the PLAN says to do when one of them will not connect — the
      // phase's own bullet first, then the §Session budget line. Absent means
      // the plan has no opinion and the run's setting answers; it is the ONE
      // resolution where the plan outranks the run, because a phase that says
      // it requires a server is describing the work rather than a preference.
      planMcpPolicy: (slug, phase) => {
        const plan = this.store?.get(slug)?.plan;
        return plan?.phases[phase]?.mcpPolicy ?? plan?.sessionBudget.mcpPolicy;
      },
      // A phase boarded without servers it asked for. The runner has no
      // notification vocabulary; this is where the fact becomes something an
      // operator hears, once per run per server rather than once per phase.
      onMcpDegraded: (state, phase, degraded) => this.announceMcpDegraded(state, phase, degraded),
      // Absent when the flag is off: a console that may not REGISTER servers
      // still resolves plans that name them, because reading is not the gated
      // act — but with an empty registry every such name is unreachable, which
      // is the honest outcome and exactly what the session is told.
      mcp: {
        preflight: (ids, cwd) => this.mcp.preflight(ids, { cwd }),
        configFor: (runId, phase, ids) => this.mcp.configFor(runId, phase, ids),
      },
      // The plan's Branch prose and title, for the git-strategy block: the
      // prose is read only to WARN on a mismatch, the title names the PR.
      planBranch: (slug) => this.store?.get(slug)?.plan?.sessionBudget.branch,
      planWorktrees: (slug) => this.store?.get(slug)?.plan?.sessionBudget.worktrees,
      // Every Repos cell of the plan, through the SAME reading admission uses.
      // A second parse of that column is how the console comes to draw one
      // answer while the scheduler acts on another.
      planScope: (slug) => [
        ...new Set((this.store?.get(slug)?.plan?.graph ?? []).flatMap((row) => scopeOfRow(row.repos))),
      ],
      worktreePrefs: () => ({
        maxConcurrent: this.prefs.worktreeMaxConcurrent,
        root: this.prefs.worktreeRoot,
        setup: this.prefs.worktreeSetup,
        copyEnv: this.prefs.worktreeCopyEnv,
        // Read per call like the rest of this object, so a flip in Settings
        // lands on the next drive rather than at the next console.
        reclaim: this.prefs.isolationReclaim,
        deleteMergedBranches: this.prefs.deleteMergedRunBranches,
      }),
      // Does any phase of this run ask to leave the run branch? Off the parsed
      // plan the store already holds — the same source `verifyIn` is answered
      // from, and for the same reason: the plan is the authority, and a second
      // parse of it is how the console comes to act on an answer it does not
      // display. The question itself is `detachRequestedIn`, exported by the
      // parser so the plan-reading half is testable where the parse lives;
      // this arrow adds only the store lookup. Scoped to a run's `onlyPhases`
      // when it has them.
      detachRequested: (slug, phases) => {
        const plan = this.store?.get(slug)?.plan;
        return plan ? detachRequestedIn(plan, phases) : false;
      },
      // The trees live locks name, for the reclaim's fourth precondition —
      // the SAME table `locks()`/`liveLock` feed the scheduler, read through
      // the same lapse clock and the same presence answer, so what admission
      // treats as a live holder the reclaim treats as an occupied tree.
      occupiedTrees: (scope) => this.occupiedTrees(scope),
      // Runs this process is genuinely DRIVING, not statuses on disk: a
      // `running` run whose console was killed holds no checkout this cap
      // should count against a live one. Its tree is the boot sweep's business.
      // …and asked through `holdsIsolatedCheckout()`, not `checkout` directly:
      // a run that is mid-acquisition holds a reservation the cap has to see,
      // or two runs starting together both pass a cap of one.
      isolatedCheckouts: (excludingRunId) => {
        const liveIds = new Set<string>();
        let count = 0;
        for (const runner of this.liveRunners()) {
          const run = runner.current();
          if (!run) continue;
          liveIds.add(run.id);
          if (run.id !== excludingRunId && runner.holdsIsolatedCheckout()) count += 1;
        }
        // …plus the trees of runs nothing is DRIVING — a `running` file whose
        // console was killed, a kept dirty tree the settle refused to delete.
        // Each is a full checkout on disk, which is the thing the cap exists
        // to bound, and a live-only count read them as free slots (G7). One
        // readdir per plan, only on the checkout-taking path; the sweep is
        // still what reclaims them.
        if (this.root?.ok) {
          try {
            const root = this.root.path;
            const consoleDir = join(STATE_DIR, 'runs', instanceId(root));
            // BOTH homes per plan — the configured one and the older one, the
            // same pair the boot sweep walks (`worktreeHome`) — so a tree left
            // under either counts. Plans are enumerated from both parents too:
            // a plan whose trees stand only under the project still has a
            // state directory, but the reverse is what a flip leaves behind.
            const slugs = new Set<string>();
            for (const parent of [consoleDir, join(worktreesRoot(root), 'runs')]) {
              try {
                for (const entry of readdirSync(parent, { withFileTypes: true })) {
                  if (entry.isDirectory()) slugs.add(entry.name);
                }
              } catch {
                /* an absent parent holds nothing to count */
              }
            }
            const seen = new Set<string>();
            for (const slug of slugs) {
              const stateDir = join(consoleDir, slug);
              for (const mode of WORKTREE_ROOTS) {
                let ids: string[] = [];
                try {
                  ids = readdirSync(worktreeHome({ mode, root, slug, stateDir }));
                } catch {
                  continue;
                }
                for (const id of ids) {
                  if (liveIds.has(id) || id === excludingRunId || seen.has(`${slug}/${id}`)) continue;
                  seen.add(`${slug}/${id}`);
                  count += 1;
                }
              }
            }
          } catch {
            /* a cap probe must never fail an admission */
          }
        }
        return count;
      },
      planTitle: (slug) => this.store?.get(slug)?.plan?.title,
      // The account seam. `envFor` makes a child run AS the run's account;
      // `pickAccount` is the switch policy's cached answer; the limited hook
      // remembers the wall on the account and tells the operator which one.
      accountEnv: (accountId, trustRoots) => this.accounts.envFor(accountId, trustRoots),
      pickAccount: (excluding, forModel) => this.accounts.pickAccount(excluding, forModel),
      // The resource ladder: the ranked candidates the auth preflight probes
      // one by one, and the three knobs, read live from prefs so Settings
      // applies to the next wall rather than the next run.
      rankAccounts: (excluding, forModel) => this.accounts.rankAccounts(excluding, forModel),
      autoAccountSwitch: () => this.prefs.autoAccountSwitch !== false,
      budgetAutoRaisePct: () => this.prefs.budgetAutoRaisePct ?? 25,
      mcpRequireTimeoutMs: () => this.prefs.mcpRequireTimeoutMs ?? DEFAULT_MCP_REQUIRE_TIMEOUT_MS,
      // Read on every evaluation, not captured at construction: a number
      // changed in Settings ▸ Automation applies to the lane already running.
      stallThresholds: () => ({
        stallSilentMs: this.prefs.stallSilentMs,
        stallSpinTurns: this.prefs.stallSpinTurns,
        stallStalemateAttempts: this.prefs.stallStalemateAttempts,
        stallRetryBurst: this.prefs.stallRetryBurst,
        stallExternalWaitMs: this.prefs.stallExternalWaitMs,
      }),
      onMcpRequireTimeout: (state, phase, result) => this.announceMcpTimeout(state, phase, result),
      // The preflight probe, under the RUN's account env. Signed out, the
      // refusal names the account and the exact command that fixes it —
      // composed here, where the config dir is known, never in the browser.
      checkAuth: async (accountId) => {
        const env = await this.accounts.envFor(accountId);
        const root = this.root?.ok ? this.root.path : process.cwd();
        const status = await checkAuthFor(root, env, accountId ?? 'default', true);
        if (!status.loggedIn && accountId && accountId !== DEFAULT_ACCOUNT_ID) {
          const meta = this.accounts.meta(accountId);
          const fix =
            meta?.kind === 'profile'
              ? `sign it in with \`CLAUDE_CONFIG_DIR=${profileConfigDir(accountId)} claude auth login\`, ` +
                'or from Settings → Claude accounts'
              : 'paste a fresh `claude setup-token` for it in Settings → Claude accounts';
          return {
            ...status,
            detail:
              `the run is set to pay as ${this.accounts.labelFor(accountId)} and that login is ` +
              `expired or signed out — ${fix}.${status.detail ? ` (${status.detail})` : ''}`,
          };
        }
        return status;
      },
      onAccountLimited: (accountId, window, resetsAt, detail) => {
        if (resetsAt) this.accounts.markLimited(accountId, window, resetsAt.toISOString());
        const name = this.accounts.labelFor(accountId);
        this.announce('limits', {
          title: `Usage limit hit — ${name}`,
          body: detail,
          tag: tagFor('limits', accountId ?? 'default', window, resetsAt?.toISOString() ?? 'unknown'),
        });
      },
      portTranscript: (sessionId, fromAccount, toAccount) =>
        portTranscript(
          sessionId,
          this.accounts.configDirFor(fromAccount),
          this.accounts.configDirFor(toAccount),
        ),
      onEvent: (event, data) => this.onRunnerEvent(event, data),
    });
  }

  /* ---------------------------------------------------------------- *
   * Announcing — the one choke point
   * ---------------------------------------------------------------- */

  /**
   * Say something, once, through every leg — and write it down first.
   *
   * Everything that wants to tell the operator anything goes through here, and
   * the order matters. The record is written **before** delivery is attempted,
   * so it exists in the cases that used to lose the event entirely: no tab
   * open, no device subscribed, `Push.announce()` returning at its first line
   * because the register is empty. The inbox is therefore complete by
   * construction — if it is not in the store, it was not announced.
   *
   * Three legs leave from here and they fail independently: the SSE event (a
   * tab, if one is open), the operator's own notifier (`PHASE_CONSOLE_NOTIFY`,
   * if one is set), and web push (each subscribed device, reporting back what
   * became of it). None of them can throw into a run.
   *
   * And one gate stands in front of all four, which is the point of doing this
   * here rather than per leg. A category the operator has turned off produces
   * *nothing*: no record, no SSE, no out-of-band command, no push. That has to
   * happen before `record()` or the inbox keeps filling with the very thing the
   * switch was thrown to stop — which is exactly how a console accumulates 182
   * unread notifications for a category that is off by default. Suppression
   * before recording is what keeps the unread count honest.
   *
   * Push keeps its own per-device categories underneath this: the global switch
   * decides whether the console speaks at all, the device switch decides whether
   * this phone is one of the places it speaks to.
   */
  protected announce(
    category: CategoryId,
    message: { title: string; body: string; tag: string; detail?: string },
    context: {
      slug?: string | null;
      phase?: number | null;
      runId?: string;
      approvalId?: string;
      sessionId?: string | null;
      sessionKind?: 'shell' | 'claude' | null;
      /**
       * Answerable from the notification itself.
       *
       * `answer` names the INBOX ITEM this notification is about and the verbs
       * the operator may press — never an endpoint. `push/actions.ts` mints a
       * signed token over the pair, `POST /api/push/action` verifies it and
       * looks the item up in the live inbox to find out what those verbs mean.
       * An announcer that omits this sends the notification it always sent: one
       * you open.
       *
       * The id must be minted with `inboxItemId` from the SAME subject
       * `server/inbox.ts` uses, or the callback will find nothing and fall back
       * to opening the app — `test/push-actions.test.ts` holds the two together
       * for every kind this console offers buttons for.
       */
      answer?: { item: string; verbs: readonly string[] };
    } = {},
    opts: {
      /**
       * Override the category's own urgency for THIS announcement.
       *
       * One caller, deliberately: a stall re-said at the escalation threshold
       * (`escalateStall`). The `stalled` category is non-urgent because at
       * minute ten nothing is blocked on the operator — and that reasoning
       * expires. Raising the category itself would buzz for every stall, which
       * is how a channel gets muted; raising this one announcement is the whole
       * point of the escalation.
       */
      urgent?: boolean;
      /**
       * Send the push even inside the 5-second same-tag dedupe: this
       * announcement REPLACES the last one on its tag rather than repeating
       * it (a "press Re-check" that follows "re-checking" by milliseconds).
       * See `Push.announce`.
       */
      replace?: boolean;
    } = {},
  ): NotificationRecord | null {
    // The one gate. `notify` is a complete map by construction (`loadPrefs`), so
    // a category missing from a stored config took its catalogue default on load
    // rather than arriving here as `undefined` and silencing itself.
    if (!this.prefs.notify[category]) return null;

    // And the second: a closed plan does not report progress. Here rather than at
    // each announcer for the same reason as the first gate — a suppression that
    // has to be remembered in five places is a suppression that will be missed in
    // one. Only the plan-progress categories are affected; see the catalogue for
    // why a live process keeps its voice whatever the plan's front matter says.
    if (isPlanProgress(category) && this.isClosedPlan(context.slug)) return null;

    const url = routeFor(category, context);
    const record = this.notifications.record({
      category,
      title: message.title,
      body: message.body,
      url,
      // The one per-announcement urgency override (the escalated stall) is a
      // fact about THIS announcement, so the record and the webhook carry it
      // too — an inbox row reading "not urgent" about the push that buzzed a
      // wrist would be the ledger disagreeing with the wire.
      ...(opts.urgent === undefined ? {} : { urgent: opts.urgent }),
      slug: context.slug ?? undefined,
      phase: context.phase ?? undefined,
      runId: context.runId,
      // Carried onto the record, not only into the URL: this is what lets a
      // page mark its own notifications read when you open it.
      sessionId: context.sessionId ?? undefined,
    });

    // The inbox badge and any open inbox follow the store live rather than
    // polling it.
    this.emit('notification', record);

    // The path that reaches an operator who is asleep with no browser in the
    // picture at all — which is the case the whole unattended design exists for.
    notifyOutOfBand(`Phase Console: ${message.title}`, message.detail ?? message.body);

    // Minted per notification, not per item: the nonce is what makes a single
    // notification's buttons spendable once, and two pushes about the same item
    // are two separate offers to answer it.
    const callback = context.answer ? mintActionToken(context.answer.item, context.answer.verbs) : null;
    const buttons = callback ? notificationButtons(context.answer!.verbs) : [];

    this.push.announce(
      category,
      {
        title: message.title,
        body: message.body,
        tag: message.tag,
        url,
        ...(context.approvalId ? { approvalId: context.approvalId } : {}),
        // Both or neither: a button with no token is a button that cannot be
        // pressed, and a token with no button is unreachable.
        ...(callback && buttons.length ? { actions: buttons, callback } : {}),
        notificationId: record.id,
      },
      Date.now(),
      (report) => {
        this.notifications.delivery(record.id, { ...report, at: new Date().toISOString() });
        this.emit('notification:delivery', { id: record.id, ...report });
      },
      opts.urgent === undefined && !opts.replace
        ? undefined
        : {
            ...(opts.urgent === undefined ? {} : { urgent: opts.urgent }),
            ...(opts.replace ? { replace: true } : {}),
          },
    );

    // The fourth leg, and the only one that leaves this machine. It gets the
    // record's own id and route and nothing from the push leg above: no action
    // token (it is same-origin by construction and means nothing to a third
    // party), no `approvalId`, no buttons. Fire-and-forget like the rest — a
    // relay being down must not be able to touch a run.
    this.webhooks.announce(category, {
      title: message.title,
      body: message.detail ?? message.body,
      url,
      notificationId: record.id,
      slug: context.slug ?? null,
      phase: context.phase ?? null,
      runId: context.runId ?? null,
      ...(opts.urgent === undefined ? {} : { urgent: opts.urgent }),
    });
    return record;
  }

  /**
   * Has the operator closed this plan?
   *
   * Read from the store's already-parsed front matter rather than by shelling to
   * `phase-graph.sh --closed`: this is asked on the notification path, which must
   * not wait on a subprocess, and the predicate is a pure function of a string
   * the store already has. `stats.ts` owns the reading; the bash side owns its
   * own, and `engine-parity` is what keeps the two honest.
   */
  isClosedPlan(slug?: string | null): boolean {
    if (!slug) return false;
    return isClosedStatus(this.store?.get(slug)?.plan?.status);
  }

  /* ---------------------------------------------------------------- *
   * Sessions — the other thing this console is running
   * ---------------------------------------------------------------- */

  /**
   * Every lifecycle moment of every pty, turned into the two things the rest of
   * the system needs: a live event, and — for the ones worth interrupting
   * someone over — a notification.
   *
   * The stream first. A terminal deliberately had no SSE event: the socket IS
   * its live channel, and a list that refetched on every unrelated `changed`
   * would be noise. That reasoning holds for the *session's own page* and fails
   * everywhere else — the dashboard's list of what is running, the nav badge,
   * and the second browser you opened all need to know a session appeared or
   * ended, and none of them is holding that socket. So one event, carrying the
   * whole list, on the six moments the list can change.
   *
   * Then the notification, and the restraint is the design. Three cases earn
   * one, and everything else is silence:
   *
   *  - **it ended while you were not attached** — the case the whole feature
   *    exists for: you closed the tab, went to lunch, and something finished;
   *  - **it ended badly** (a nonzero code), attached or not — a failure you
   *    would otherwise find by scrolling back through a dead terminal;
   *  - **it was a recovery session** (P4's linkage), always — you asked the
   *    console to fix something and its outcome is the answer.
   *
   * A session you closed yourself is never announced. `kill()` reports `killed`
   * rather than `exited` precisely so that stays true.
   */
  private onSessionEvent(event: SessionEvent): void {
    const { type, session } = event;
    this.emit('sessions', {
      type,
      session,
      sessions: this.terminals.state().sessions,
      live: this.terminals.live(),
      foreign: this.sessionViews(),
    });

    if (type !== 'exited') return;
    const code = session.exited?.code ?? 0;
    const failed = code !== 0 || session.exited?.signal != null;

    // A verify-command terminal's exit is the whole point of the mint: the
    // code lands back on the run record, and green settles via recheck.
    if (session.meta?.verify) {
      this.reflectVerifyCommand(session.meta.verify, code, this.terminals.outputTail(session.id));
      return;
    }

    // A login session's exit is answered by reading back who the profile
    // became — email, plan — never by announcing that a process ended. The
    // probe also covers "they closed it without finishing": completeLogin
    // simply finds no credentials and the card keeps saying "not signed in".
    const loginAccount = session.meta?.intent === 'login' ? session.meta.accountId : undefined;
    if (loginAccount) {
      void this.accounts
        .completeLogin(loginAccount)
        .then((view) => {
          if (view?.signedIn && view.email) {
            this.announce('limits', {
              title: 'Account signed in',
              body: `${view.email} is now available to runs on this console.`,
              tag: tagFor('limits', 'login', loginAccount),
            });
          }
        })
        .catch((error) => log.warn('accounts.login.complete-failed', { account: loginAccount, error }));
      return;
    }

    // An MCP sign-in's exit is answered the same way: by re-probing rather than
    // by trusting that the terminal closing meant success. Somebody who gave up
    // halfway leaves the server exactly as it was, and the card keeps saying so.
    const loginMcp = session.meta?.intent === 'login' ? session.meta.mcpServer : undefined;
    if (loginMcp) {
      const bridged = session.meta?.mcpBridged === true;
      void (async () => {
        // Take the bridged definition back BEFORE re-probing, so the probe
        // measures the state the operator is left in rather than the temporary
        // one this flow created. The probe reads its own `--mcp-config` and
        // never the CLI's registry, so removing the entry cannot change the
        // verdict — but a probe run against a registry we are about to edit
        // would be a claim about a world that stops existing a moment later.
        if (bridged) await this.releaseMcpBridge(loginMcp, session.meta?.mcpConfigDir);
        const servers = await this.refreshMcp(true);
        const view = servers.find((server) => server.id === loginMcp);
        if (view?.status === 'connected') {
          this.announce('limits', {
            title: 'MCP server signed in',
            body: `${view.label} is connected and available to runs on this console.`,
            tag: tagFor('limits', 'mcp-login', loginMcp),
          });
          // A run parked waiting for exactly this can now be re-armed.
          await this.healMcpParks(loginMcp);
        }
      })().catch((error) => log.warn('mcp.login.complete-failed', { server: loginMcp, error }));
      return;
    }

    const recovery = session.meta?.recovery;
    const qa = session.meta?.qa;
    if (!event.detached && !failed && !recovery && !qa) return;

    // A recovery session was opened to change something specific, so its exit
    // is answered by re-reading that thing rather than by reporting that a
    // process ended. Async, and deliberately not awaited: the registry is
    // emitting an event, not waiting for a verdict.
    if (recovery) {
      void this.announceRecoveryOutcome(session, recovery, failed);
      return;
    }

    // A QA session was opened to produce a verdict, so its exit is answered by
    // re-reading test-status.md — never by reporting that a process ended, and
    // never by assuming the review reached a conclusion because it stopped.
    if (qa) {
      void this.announceQaOutcome(session, qa, failed);
      return;
    }

    // A stop the operator asked for is not news — the exit IS the outcome they
    // requested. The recovery/QA branches above deliberately still ran: a
    // stopped verdict session must still be read against the board.
    if (session.stopping) return;

    const what = session.kind === 'claude' ? 'Agent session' : 'Terminal';
    this.announce(
      'session',
      {
        title: failed ? `${what} failed` : `${what} finished`,
        body:
          `${session.label} — ${failed ? `exited ${describeExit(session)}` : 'exited cleanly'}` +
          (event.detached ? ' · nothing was attached' : ''),
        tag: tagFor('session', session.id, String(code)),
        detail: session.cwd,
      },
      {
        sessionId: session.id,
        sessionKind: session.kind,
      },
    );
  }

  /**
   * What the recovery achieved, checked against the board — then said.
   *
   * "Your recovery session ended" is the notification this feature exists to
   * not send. The console knows what the session was for, so it can re-read
   * the board and answer the actual question: is the phase done now?
   *
   * A session that crashed is still checked, because a session can commit the
   * fix and then fall over on its way out, and the board is the evidence
   * either way.
   */
  private async announceRecoveryOutcome(
    session: SessionInfo,
    link: { kind: string; slug?: string; phase?: number; runId?: string },
    failed: boolean,
  ): Promise<void> {
    let outcome: { fixed: boolean; headline: string; detail: string };
    try {
      outcome = await this.recoveryOutcome(link);
    } catch (error) {
      // Never let a failed board read swallow the notification — the operator
      // still needs to know the session ended.
      outcome = {
        fixed: false,
        headline: `Recovery for ${link.slug ?? 'a plan'} finished`,
        detail: `The console could not re-read the board: ${(error as Error).message}`,
      };
    }

    // The verdict becomes the record before anyone is told about it: a fixed
    // board flips the phase to done, clears the halt and parks the run; a miss
    // annotates the attempt. For a while the verdict went only into the
    // notification below, and the run it was about stayed `halted` forever.
    let synced: RunState | null = null;
    try {
      synced = this.syncRecoveredRun(link, outcome);
    } catch (error) {
      log.warn('recovery.sync-failed', { slug: link.slug, phase: link.phase, error });
    }

    this.announce(
      'session',
      {
        title: outcome.fixed ? `Recovered · ${outcome.headline}` : `Still needs you · ${outcome.headline}`,
        body: `${outcome.detail}${failed ? ` (the session itself exited ${describeExit(session)})` : ''}`,
        tag: tagFor('session', session.id, outcome.fixed ? 'fixed' : 'unfixed'),
        detail: session.label,
      },
      {
        sessionId: session.id,
        sessionKind: session.kind,
        ...(link.slug ? { slug: link.slug } : {}),
        ...(link.phase != null ? { phase: link.phase } : {}),
        ...(link.runId ? { runId: link.runId } : {}),
      },
    );

    // The surfaces that offered the recovery re-read themselves off this.
    this.emit('sessions', {
      type: 'recovery-outcome',
      session,
      recovery: { ...link, ...outcome, synced: Boolean(synced) },
      sessions: this.terminals.state().sessions,
      live: this.terminals.live(),
      foreign: this.sessionViews(),
    });

    // A fixed run carries on by itself — the same resume `retryPhase` and the
    // limit clock make, under the automation pref that governs everything else
    // unattended. `parked` is the only post-sync state worth continuing; a
    // not-fixed outcome left the halt standing on purpose.
    // …and not under a fleet freeze. See the twin gate in `service-recovery.ts`:
    // continuing a fixed run spawns a session, and the freeze makes no
    // exception for the recovery family.
    if (outcome.fixed && synced?.status === 'parked' && link.slug && this.fleetHold()) {
      log.info('run.recovery-continue-frozen', { slug: link.slug, runId: synced.id });
    } else if (
      outcome.fixed &&
      synced?.status === 'parked' &&
      link.slug &&
      this.prefs.autoContinueRecovery !== false &&
      this.flags.allowRun &&
      !this.liveRunner(link.slug)
    ) {
      try {
        log.info('run.recovery-continue', { slug: link.slug, runId: synced.id });
        await this.startRun(link.slug, {
          resumeRunId: synced.id,
          ...(synced.onlyPhases?.length ? { onlyPhases: synced.onlyPhases } : {}),
          skills: synced.skills ?? [],
        });
      } catch (error) {
        log.warn('run.recovery-continue-failed', { slug: link.slug, runId: synced.id, error });
      }
    }
  }

  /**
   * What the QA session actually recorded — read back, never assumed.
   *
   * The asymmetry with a recovery is deliberate. A recovery is judged by the
   * board, which moves for many reasons; a review is judged by the one row it
   * was sent to write, and a review that wrote no row produced no verdict
   * however long it ran. So "no verdict recorded" is a first-class outcome
   * here, and it is never softened into a pass.
   */
  private async announceQaOutcome(
    session: SessionInfo,
    link: { slug: string; phase: number; before?: string; beforeReport?: string },
    failed: boolean,
  ): Promise<void> {
    let outcome: QaOutcome;
    try {
      outcome = await this.qaOutcome(link);
    } catch (error) {
      outcome = {
        recorded: false,
        headline: `QA for ${link.slug} P${link.phase} finished`,
        detail: `The console could not re-read test-status.md: ${(error as Error).message}`,
      };
    }

    // A recorded FAIL is the `qa` category's own subject ("or QA recorded a
    // fail" — urgent, and it holds every dependent); every other ending of the
    // QA session is a session ending. Announcing the fail as "a session ended"
    // put it behind the one switch an operator watching QA would not keep on.
    this.announce(
      outcome.recorded && outcome.result === 'fail' ? 'qa' : 'session',
      {
        title: outcome.recorded
          ? `QA ${outcome.result} · ${link.slug} P${link.phase}`
          : `No verdict · ${link.slug} P${link.phase}`,
        body: `${outcome.detail}${failed ? ` (the session itself exited ${describeExit(session)})` : ''}`,
        tag: tagFor('session', session.id, outcome.result ?? 'none'),
        detail: session.label,
      },
      {
        sessionId: session.id,
        sessionKind: session.kind,
        slug: link.slug,
        phase: link.phase,
      },
    );

    // The surfaces that offered the review re-read themselves off this.
    this.emit('sessions', {
      type: 'qa-outcome',
      session,
      qa: { ...link, ...outcome },
      sessions: this.terminals.state().sessions,
      live: this.terminals.live(),
      foreign: this.sessionViews(),
    });
  }

  /**
   * What a shutdown or a restart does to the sessions this console is showing,
   * as a fact rather than a warning in the abstract.
   *
   * Both dialogs render it. "stops 2 agent sessions and a terminal" is a
   * different decision from "stops nothing", and for a long time neither
   * button said which it was — Restart killed every pty and never mentioned
   * it. Phase 6 made it say so; **Phase 7 made it untrue**, which is why
   * `survives` is here rather than a sentence in the client: the ptys belong
   * to a broker that outlives this process, so they are counted and then
   * explicitly reported as *kept*.
   *
   * `survives` is a property of how the ptys are owned, so it is asked of the
   * registry that owns them — a console running with an injected spawn (every
   * registry test) correctly reports `false`.
   */
  sessionInventory(): {
    live: number;
    agent: number;
    terminal: number;
    ended: number;
    survives: boolean;
    sessions: { id: string; label: string; kind: SessionKind }[];
  } {
    const all = this.terminals.state().sessions;
    const live = all.filter((session) => !session.exited);
    return {
      live: live.length,
      agent: live.filter((session) => session.kind === 'claude').length,
      terminal: live.filter((session) => session.kind !== 'claude').length,
      ended: all.length - live.length,
      survives: this.terminals.survivesRestart(),
      sessions: live.map((session) => ({ id: session.id, label: session.label, kind: session.kind })),
    };
  }

  /* ---------------------------------------------------------------- *
   * Opening a source directory
   * ---------------------------------------------------------------- */

  /**
   * Why this console will not be repointed, or `null` if it will.
   *
   * A non-default instance exists *because* someone wanted a console for one
   * project: it has that project's id, its state directory, its port and (from
   * P6) its own unit. Letting the browser swap its root would leave every one
   * of those describing a project it is no longer serving — the instance would
   * still be named `alpha`, still be writing to alpha's log, and be showing
   * beta's plans. So it refuses, and names the verb that does what the operator
   * actually wants: start beta's own console.
   *
   * The default instance keeps the picker. It is the console someone opens with
   * no project in mind, and taking that away to buy consistency would remove
   * the only entry point a first-time user has.
   */
  pinnedRefusal(path: string): string | null {
    if (!INSTANCE.pinned || !INSTANCE.root) return null;
    if (instanceId(path) === INSTANCE.id) return null;
    return (
      `This console is pinned to ${INSTANCE.root} (instance ${INSTANCE.name}). ` +
      'Run `phase-console start` in the other project to open its own console.'
    );
  }

  open(path: string): RootCheck {
    const check = checkRoot(path);
    if (!check.ok) return check;

    this.root = check;
    this.store = new Store(check);
    this.store.scan();
    this.search.rebuild(this.store.list());
    this.boards.clear();
    this.qaModes.clear();
    this.lints.clear();
    this.sessionPlans.clear();
    this.portfolioCache = null;
    invalidate();
    this.generation++;

    this.prefs = rememberRoot(this.prefs, check.path);
    this.watcher.start([check.plansDir, check.handoffsDir]);
    this.armSessionInbox(check.path);
    void this.refreshRepoInfo();
    void this.warm();
    // Secrets a previous console left behind. The runner sweeps its own run's
    // files when its loop ends, which covers every ORDERLY ending; this covers
    // the rest — a crash, a SIGKILL, a machine that lost power — and it is the
    // only sweep that can, because nothing else survives to know those runs
    // existed. Runs still in flight are kept: their sessions may be adopted.
    this.sweepRunSecrets();
    this.sweepOldRuns();
    // The health cache is empty in a fresh process, so every server reads
    // `unknown` until something asks — and the only thing that asked was an
    // operator opening the MCP page. A console driving unattended runs never
    // opened it, so the TTL that `refresh()` has always honoured had no clock
    // behind it: the first anybody heard of a signed-out server was a phase
    // parking on it at boarding, which is the exact cost the preflight exists
    // to avoid. Probe once at open, then on the TTL. Both no-op when nothing
    // is registered, which is the common case.
    this.startMcpHealthClock(check.path);
    // The issue estate's keep-warm clock. Unlike the health probe above it
    // does NOT tick at open: it refreshes only repositories somebody has
    // already fetched, so a console nobody has asked spends no GitHub quota.
    this.startIssuesSweepClock();
    // The convergence loop: the boot pass once the queued re-adoption is done (a
    // queued run must be live before the loop reads it), then the sweep clock.
    this.bootSettled = this.readoptQueued()
      .catch((error) => log.warn('run.readopt-failed', { error }))
      // After the re-adoption, so a queued run this console just picked up
      // counts as LIVE and its trees are left alone.
      .then(() => this.sweepStaleWorktrees())
      .then(async () => {
        if (!this.convergeAutomatic()) return;
        this.converger.start();
        // The watch clock rides the same switch: one thing to turn off.
        this.watchClock.open();
        await this.converger.boot(this.convergeSlugs());
      })
      .catch((error) => log.warn('converge.boot-failed', { error }));
    return check;
  }

  /**
   * Pick up runs that were waiting for a scope when the console went away.
   *
   * The ONE status this is safe for, and the reason `queued` is not in
   * `IN_FLIGHT`: a queued run has spawned nothing, edited nothing and holds no
   * lock — it was a pending promise in a process that no longer exists. There
   * is no half-finished work to reason about, so continuing it is the same act
   * as having started it a moment later, which is what the operator asked for.
   *
   * Anything else stays exactly as `reconcileRun` left it. A run that was
   * mid-phase gets `interrupted` or `parked` and waits for a person, because
   * the thing that makes those unsafe to resume automatically — a session that
   * may still be running, a tree that may be half-edited — is precisely what a
   * queued run does not have.
   */
  protected async readoptQueued(): Promise<void> {
    if (!this.flags.allowRun || !this.root?.ok) return;
    // A console that boots into a standing freeze re-adopts NOTHING.
    //
    // This is the restart half of exit criterion 2, and it is a whole-pass
    // refusal rather than a per-branch one on purpose: every door below —
    // re-boarding a queued run, re-arming a wait, asking the healer for a pass
    // — ends in a spawned session, and a boot that opened even one of them
    // would be the freeze surviving the restart in name only. The clocks are
    // not lost: `readoptQueued` is exactly the pass that re-arms them, and the
    // thaw runs it again.
    const frozen = this.fleetHold();
    if (frozen) {
      log.info('run.readopt-frozen', { by: frozen.by, at: frozen.at });
      return;
    }
    for (const record of this.store?.list() ?? []) {
      const state = latestRun(this.root.path, record.slug, this.liveRunIds());
      // A `require` MCP park outlives the console that parked it: its clock
      // re-arms here for the remainder, or fires at once when it is overdue.
      if (state) this.armMcpRequireTimersFor(state);
      // …and so does a freeze. The fourth boot clock, and the one that was
      // missing: `escalateAt` is persisted and drawn on the lane card as a
      // promise, but it was kept only by an `unref`ed timer inside the Runner,
      // so a console that went away retracted it in silence — which is how the
      // incident's child stayed stopped at PPID 1 for three and a half hours.
      if (state) this.armFreezeEscalation(record.slug, state);
      // A run this console is already driving is not re-adoptable — it was
      // never let go of. At boot the pool is empty and this is a no-op; it
      // matters on the OTHER caller of this pass, `thawFleet`, where the whole
      // fleet is live and re-starting a queued run would give one plan two
      // loops. Same discipline as `resumeLimitPaused`'s live check.
      if (this.liveRunner(record.slug)) continue;
      if (state?.status === 'queued') {
        try {
          log.info('run.readopt-queued', { slug: record.slug, runId: state.id });
          await this.startRun(record.slug, {
            resumeRunId: state.id,
            // Resume clears a scope it is not handed, and an omitted skills list
            // would let machine defaults overwrite the run's sticky one — the
            // same passthrough retryPhase makes, for the same reason.
            ...(state.onlyPhases?.length ? { onlyPhases: state.onlyPhases } : {}),
            skills: state.skills ?? [],
            // …and the account, for the same reason again. `startRun` runs
            // `preflightAccount(options.accountId)`, so a readopt that omits it
            // judges the DEFAULT login — its usage meters, its auth state —
            // while the runner resumes under `state.accountId`. The run then
            // sails past a preflight that never looked at the account paying
            // for it, or is refused on the strength of one that is not.
            ...(state.accountId ? { accountId: state.accountId } : {}),
          });
        } catch (error) {
          log.warn('run.readopt-failed', { slug: record.slug, runId: state.id, error });
        }
        continue;
      }
      // The second readoptable shape: a run reconciled off a wait
      // (`reconcileRun` turned waiting→paused, keeping `waitUntil`). Two wait
      // kinds share that clock — the usage window, and a park on external work
      // some phase declared — and `waitReason` is which (`waitReasonOf` falls
      // back to the record scan for runs written before it). A park is always
      // re-armed (it is not a limit, so `onLimit: 'pause'` does not speak for
      // it); a limit honors the run's own policy.
      if (state?.status === 'paused' && state.waitUntil) {
        const parked = waitReasonOf(state) === 'external';
        if (parked || (state.onLimit ?? 'wait') !== 'pause') {
          this.armLimitResume(record.slug, state);
          continue;
        }
      }
      // The third readoptable shape: a run that halted — or was interrupted by
      // the very crash this boot is recovering from — with auto-recovery on.
      // The attempts counter was bumped at every launch and persisted, so the
      // relaunch is bounded by whatever the budget still allows; everything
      // else is re-checked by `maybeAutoRecover` when the timer fires.
      // A verification-preflight park rides the same door: it is the one
      // parked shape whose halt names a machine-clearable kind.
      // …and a `parked` run whose stop lives on a PHASE. Since the halt-kind
      // split that is the commonest new stop shape — a phase-level kind writes
      // `record.halt` and leaves `state.halt` null — and this door was keyed on
      // `state.halt` alone, so a console restart silently stopped re-arming the
      // very runs it most needs to (QA F2). Converge's five-minute sweep still
      // reached them; this makes it the boot's job again, as it was.
      const phaseStopped =
        state?.status === 'parked' && Object.values(state.phases ?? {}).some((r) => r?.halt);
      if (
        state &&
        state.autoRecover &&
        (state.status === 'halted' ||
          state.status === 'interrupted' ||
          (state.status === 'parked' && state.halt?.kind === 'verification-preflight') ||
          phaseStopped)
      ) {
        this.scheduleAutoRecover(record.slug);
      }
    }
  }

  /**
   * One armed clock per plan: the newest reset time wins, restarts survive.
   * `at` is the clock the timer is armed FOR, so re-arming on the same
   * `waitUntil` is a no-op — the arm now also rides every `waiting` run
   * emit (see `onRunnerEvent`), which repeats.
   */
  private limitResumeTimers = new Map<string, { timer: NodeJS.Timeout; at: number }>();

  /** Freeze escalations re-armed at boot, keyed `slug:runId`. */
  protected freezeTimers = new Map<string, NodeJS.Timeout>();

  /**
   * A stop asks the convergence loop for a pass a minute out, per plan.
   *
   * The delay is the point, not an implementation detail: the halt event fires
   * while the run is still draining its lanes, the operator may be watching
   * and about to act themselves, and a console that spawns an agent the same
   * second something breaks is a console nobody can get ahead of. When the
   * pass runs it re-reads everything — the run may have been continued,
   * stopped or fixed by hand in the meantime, and every one of those wins.
   * (The healer this used to arm directly, `maybeAutoRecover`, is now the
   * loop's `heal` step; `converge.ts` has the trigger matrix.)
   */
  protected scheduleAutoRecover(slug: string, delayMs = HALT_DELAY_MS): void {
    if (!this.convergeAutomatic()) return;
    this.converger.request(slug, 'halt', delayMs);
  }

  /**
   * May the loop run without being asked? The capability that makes any of it
   * real (`--allow-run`), and the switch (`--no-converge`, or a harness that
   * never set it). The operator's press is not gated here.
   */
  protected convergeAutomatic(): boolean {
    return this.flags.converge === true && this.flags.allowRun;
  }

  /* ---------------------------------------------------------------- *
   * Fleet freeze — one predicate, everything that could start asks it
   * ---------------------------------------------------------------- */

  /**
   * Is this console frozen? The single predicate the whole phase hangs on.
   *
   * Every auto-start mechanism asks this AT FIRE TIME, which is what makes the
   * thaw exact: nothing here cancels a timer, moves a deadline or rewinds a
   * clock, so a wait whose moment passed during the freeze fires on the first
   * scan after the thaw, and a session that was mid-token thaws mid-token.
   */
  fleetHold(): FleetHold | null {
    if (this.fleetHoldCache === undefined) this.fleetHoldCache = readFleetHold();
    return this.fleetHoldCache;
  }

  /** Write the marker and remember it. Returns the record every reader will see. */
  protected markFleetFrozen(by: string): FleetHold {
    const hold = writeFleetHold(by);
    this.fleetHoldCache = hold;
    return hold;
  }

  /** Drop the marker and remember that. Idempotent. */
  protected markFleetThawed(): void {
    clearFleetHold();
    this.fleetHoldCache = null;
  }

  /**
   * The fleet's state as `/api/state` and the banner read it.
   *
   * Here rather than beside `freezeFleet`/`thawFleet` in `ServiceRuns` because
   * `ServiceLive` builds `/api/state` and sits BELOW that class — the reader is
   * lower in the chain than the writers, so the read has to live at the root.
   */
  fleetState(): { frozen: boolean; at: string | null; by: string | null } {
    const hold = this.fleetHold();
    return { frozen: Boolean(hold), at: hold?.at ?? null, by: hold?.by ?? null };
  }

  protected armLimitResume(slug: string, state: RunState): void {
    const at = Date.parse(state.waitUntil ?? '');
    if (!Number.isFinite(at)) return;
    const delay = at - Date.now();
    // Whatever clock the run recorded is honoured. The 12-hour ceiling that
    // used to live here belonged to the runner's old verdict — "a reset half
    // a day out is a recovery card for a person" — and the runner now makes
    // that call itself: it switches accounts when one can pay and otherwise
    // WAITS with the errand on the run, so a weekly window recorded as
    // `waitUntil` must re-arm, or the restart turns a self-resuming run into
    // one waiting for a person. Only a delay `setTimeout` cannot hold (24.8
    // days) is left to the next boot.
    if (delay > MAX_TIMER_MS) return;
    const existing = this.limitResumeTimers.get(slug);
    if (existing?.at === at) return; // already armed on this very clock
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(
      () => {
        void this.resumeLimitPaused(slug, state.id);
      },
      Math.max(0, delay),
    );
    timer.unref?.();
    this.limitResumeTimers.set(slug, { timer, at });
    log.info('run.rearmed-wait', { slug, runId: state.id, until: state.waitUntil });
  }

  private async resumeLimitPaused(slug: string, runId: string): Promise<void> {
    this.limitResumeTimers.delete(slug);
    if (!this.flags.allowRun || !this.root?.ok) return;
    // The wait's moment arrived while the console was frozen. Nothing is
    // rescheduled here and nothing is lost: the run keeps its `waitUntil` on
    // disk, so `thawFleet`'s re-arm pass finds it overdue and fires it once —
    // which is exit criterion 3's "the overdue wait fires once".
    const frozen = this.fleetHold();
    if (frozen) {
      log.info('run.limit-resume-frozen', { slug, runId, by: frozen.by });
      return;
    }
    // Re-read before acting: the operator may have continued it by hand,
    // stopped it, or started something else in the hours this timer slept.
    const state = latestRun(this.root.path, slug, this.liveRunIds());
    // `paused` is the reconciled shape; `waiting` is the same run read off a
    // console that never restarted (the pooled state was never reconciled).
    // Both mean "resume me at the clock".
    if (!state || state.id !== runId || !state.waitUntil) return;
    if (state.status !== 'paused' && state.status !== 'waiting') return;
    if (this.liveRunner(slug)) {
      // The loop is still draining its lanes (or tearing down). Its settling
      // emit re-arms whatever wait it ends in — but a clock consumed HERE,
      // with that emit already behind it, is a clock nobody re-arms, and it
      // is the run's only wake. Re-check in a minute instead of dropping it:
      // run 258e1cc7 lost its clock exactly this way and then slept from
      // 02:53Z to the operator's Recheck at 06:52Z.
      const timer = setTimeout(() => {
        void this.resumeLimitPaused(slug, runId);
      }, LIMIT_RESUME_RETRY_MS);
      timer.unref?.();
      this.limitResumeTimers.set(slug, { timer, at: Date.parse(state.waitUntil) });
      return;
    }
    try {
      log.info('run.limit-resume', { slug, runId });
      await this.startRun(slug, {
        resumeRunId: runId,
        ...(state.onlyPhases?.length ? { onlyPhases: state.onlyPhases } : {}),
        skills: state.skills ?? [],
        // The second readopt path, and the one where omitting it is worst: this
        // run is resuming off a USAGE WALL, so the one thing preflight must
        // look at is the account that hit it.
        ...(state.accountId ? { accountId: state.accountId } : {}),
      });
    } catch (error) {
      log.warn('run.limit-resume-failed', { slug, runId, error });
    }
  }

  close(): void {
    this.accounts.stop();
    if (this.accountsEmitTimer) clearTimeout(this.accountsEmitTimer);
    this.accountsEmitTimer = null;
    // Its two siblings were left running. Both are `unref`'d, so neither held
    // the process up — but a Service closed and replaced (a root change, and
    // every test that opens one) left a timer holding the CLOSED instance,
    // which then emitted onto a dead channel. Cleared here for the same reason
    // `accountsEmitTimer` always was.
    if (this.inboxTimer) clearTimeout(this.inboxTimer);
    this.inboxTimer = null;
    if (this.mcpEmitTimer) clearTimeout(this.mcpEmitTimer);
    this.mcpEmitTimer = null;
    for (const armed of this.limitResumeTimers.values()) clearTimeout(armed.timer);
    this.limitResumeTimers.clear();
    for (const timer of this.freezeTimers.values()) clearTimeout(timer);
    this.freezeTimers.clear();
    for (const timer of this.mcpRequireTimers.values()) clearTimeout(timer);
    this.mcpRequireTimers.clear();
    if (this.mcpHealthTimer) clearInterval(this.mcpHealthTimer);
    this.mcpHealthTimer = null;
    if (this.issuesSweepTimer) clearInterval(this.issuesSweepTimer);
    this.issuesSweepTimer = null;
    this.converger.close();
    this.watchClock.close();
    this.watcher.stop();
    this.disarmSessionInbox();
    this.sessions.close();
    // Nothing is admitted after this point, and every pending admission is
    // rejected rather than left holding a promise nobody will settle.
    this.scheduler.close();
    // Lets go of the pty broker WITHOUT killing anything (Phase 7). The ptys
    // are its children, not this process's, so a restart now reconnects to the
    // same sessions with their scrollback instead of ending them. With an
    // injected spawn — a test — they really are ours and are still killed.
    this.terminals.close();
    // The runner POOL is retained across runs by design (`runnerFor` makes one
    // per plan and keeps it), so its clocks outlived the Service that owned
    // them: a liveness ticker per plan ever run, plus a lease keepalive per
    // lane, all `unref`'d and all still firing into a closed instance.
    for (const runner of this.runners.values()) {
      try {
        runner.close();
      } catch {
        /* one runner must not stop the shutdown */
      }
    }
    // Read markers and delivery outcomes are collapsed behind a debounce; this
    // is the one moment they would otherwise be lost.
    this.notifications.flush();
    // Checkpoints owed by the coalescing writer. Everything above may have
    // scheduled one; this is the last moment they can be paid.
    flushRunSaves();
  }

  /* ---------------------------------------------------------------- *
   * The inbox
   * ---------------------------------------------------------------- */

  /**
   * History, plus the two facts that explain a notification you never got.
   *
   * `devices` being empty means nothing can arrive out of band no matter how
   * many categories are on, and `outOfBand` being unconfigured means the same
   * for a machine with no browser at all. Both were previously discoverable
   * only by reading source.
   */
  inbox(query: NotificationQuery = {}) {
    return {
      ...this.notifications.list(query),
      categories: CATEGORIES,
      devices: this.push.list().length,
      outOfBand: { configured: Boolean(process.env.PHASE_CONSOLE_NOTIFY) },
    };
  }

  /* ---------------------------------------------------------------- *
   * Restarting the console from the console
   * ---------------------------------------------------------------- */

  /**
   * Everything the button needs to render itself honestly, before it is
   * pressed. Two independent reasons it may refuse, and they read differently:
   * a run in flight is "not now", an unsupervised process is "not from here".
   */
  restartReadiness(): {
    ok: boolean;
    reason?: string;
    supervisor: ReturnType<typeof supervisor>;
    /** True where nothing supervises: the console re-executes itself rather than relying on a supervisor. */
    selfRestart?: boolean;
    busy: boolean;
    run: { slug: string; status: string; phase?: number } | null;
    sessions: ReturnType<Service['sessionInventory']>;
  } {
    // Restart used to kill every pty — `shutdown()` calls `service.close()` —
    // and never said so. Since Phase 7 the ptys belong to a broker that
    // outlives this process, so the inventory rides along to say what SURVIVES
    // rather than what dies: `sessions.survives` is the difference, and the
    // dialog reads it rather than assuming either answer.
    const sessions = this.sessionInventory();
    // Every busy plan, not "the" one: a restart aborts all of them, and a
    // dialog that named one while three were running would understate what
    // pressing it costs by two.
    const running = this.runStates();
    const state = running[0] ?? null;
    // `hasShutdownWork()` is the real test rather than a status on disk: the
    // runner registers its handler exactly while it is driving, and drops it
    // the moment the loop returns. A `running` row left by a killed process
    // does not register anything, and must not block a restart forever.
    const busy = hasShutdownWork();
    const supervision = supervisor();
    if (busy) {
      return {
        ok: false,
        reason:
          running.length > 1
            ? `${running.length} plans are mid-run (${running.map((r) => `${r.slug} ${r.status}`).join(', ')}) ` +
              '— restarting would abort every session they are driving and expire every card they are ' +
              'waiting on, unanswerably'
            : state
              ? `${state.slug} is mid-run (${state.status}) — restarting would abort the session it is driving ` +
                'and expire every card it is waiting on, unanswerably'
              : 'a run is checkpointing — restarting now would cut it in half',
        supervisor: supervision,
        busy,
        run: state ? { slug: state.slug, status: state.status } : null,
        sessions,
      };
    }
    const verdict = restartVerdict(supervision);
    if (!verdict.ok) {
      return { ok: false, reason: verdict.reason, supervisor: supervision, busy, run: null, sessions };
    }
    return { ok: true, selfRestart: verdict.selfRestart, supervisor: supervision, busy, run: null, sessions };
  }

  /* ---------------------------------------------------------------- *
   * Stopping the console from the console
   * ---------------------------------------------------------------- */

  /**
   * What pressing Shut down will actually stop — everything the confirm dialog
   * needs to be an inventory rather than a warning.
   *
   * Unlike `restartReadiness()` this never refuses. A restart while a run is
   * driving is a mistake (it aborts the child and expires its cards
   * unanswerably); a *shutdown* while a run is driving is a decision — the
   * runner checkpoints on the way out and the run resumes when the console
   * comes back. Refusing to turn something off because it is busy is how you
   * get a machine with no off switch, which is the bug this is fixing.
   */
  shutdownReadiness(): {
    supervisor: ReturnType<typeof supervisor>;
    stop: ReturnType<typeof stopPlan>;
    busy: boolean;
    run: { slug: string; status: string } | null;
    sessions: ReturnType<Service['sessionInventory']>;
    restartHint: string;
  } {
    const state = this.runStates()[0] ?? null;
    const supervision = supervisor();
    const stop = stopPlan(supervision);
    // The Pro tree can also offer to reinstall the unit; the free tree ships no
    // agent script, so both tails assemble to nothing there.
    const reinstallLaunchctl = [
    ].join('');
    const reinstallSystemctl = [
    ].join('');
    return {
      supervisor: supervision,
      stop,
      busy: hasShutdownWork(),
      run: state ? { slug: state.slug, status: state.status } : null,
      sessions: this.sessionInventory(),
      // Where a person has to go to get it back. Under launchd the job is
      // unloaded, so the page they are looking at is about to be the last thing
      // this console says to them.
      restartHint:
        stop.via === 'launchctl'
          ? `launchctl kickstart -k gui/$(id -u)/${stop.label}${reinstallLaunchctl}`
          : stop.via === 'systemctl'
            ? `systemctl --user start ${stop.label}${reinstallSystemctl}`
            : 'start it again with `bash <skill>/start` (or viewer/run)',
    };
  }

  /**
   * Stop this console and everything it owns.
   *
   * The order is the same as any other exit — `shutdown()` in `index.ts` closes
   * the server, calls `service.close()` (which kills every pty), then drains the
   * registered handlers so a run checkpoints. What differs is that under launchd
   * the job is unloaded first, so nothing brings it back.
   */
  shutdown(by: string): { ok: boolean; reason?: string; stop?: ReturnType<typeof stopPlan> } {
    const readiness = this.shutdownReadiness();
    log.warn('shutdown.requested', {
      by,
      supervisor: readiness.supervisor.kind,
      via: readiness.stop.via,
      sessions: readiness.sessions.live,
      busy: readiness.busy,
    });
    // Announced before it happens, because afterwards there is nothing here to
    // announce anything — and a push that arrives on a phone is the only record
    // an operator elsewhere will get that the console went down on purpose.
    this.announce('health', {
      title: 'Phase Console is shutting down',
      body: `asked for by ${by} · ${readiness.stop.detail}`,
      tag: tagFor('health', 'shutdown', String(Date.now())),
    });
    if (!requestShutdown(`shutdown (${by})`)) {
      return { ok: false, reason: 'this build has no shutdown verb registered — stop it by hand' };
    }
    return { ok: true, stop: readiness.stop };
  }

  /**
   * Exit cleanly and let the supervisor bring it back.
   *
   * There is no other way to load new server code: Node reads `server/` once,
   * at startup, so a fix on disk is invisible to the running process however
   * many times the page is reloaded. That is what the stale banner has always
   * said and what it has never been able to do anything about.
   *
   * `force` skips only the supervision check — never the in-flight one. A
   * restart that aborts a live child and expires its cards unanswerably is not
   * something a flag should be able to talk you into.
   */
  restart(
    by: string,
    force = false,
  ): { ok: boolean; reason?: string; supervisor?: ReturnType<typeof supervisor> } {
    const readiness = this.restartReadiness();
    if (!readiness.ok && (readiness.busy || !force)) {
      return { ok: false, reason: readiness.reason, supervisor: readiness.supervisor };
    }
    log.warn('restart.requested', { by, supervisor: readiness.supervisor.kind, force });
    this.announce('health', {
      title: 'Phase Console is restarting',
      body: `asked for by ${by} · ${readiness.supervisor.detail}`,
      tag: tagFor('health', 'restart', String(Date.now())),
    });
    if (!requestRestart(`restart (${by})`)) {
      return { ok: false, reason: 'this build has no restart verb registered — restart it by hand' };
    }
    return { ok: true, supervisor: readiness.supervisor };
  }

  markNotificationsRead(ids?: string[] | null): { changed: number; unread: number } {
    const changed = this.notifications.markRead(ids);
    if (changed) this.emit('notification:read', { ids: ids ?? null, unread: this.notifications.unread() });
    return { changed, unread: this.notifications.unread() };
  }

  /**
   * Mark read only what a scope matches — the verb behind auto-read-on-view.
   *
   * The event carries `ids: null` like the bulk read does; a client that has
   * the inbox open refetches rather than trying to patch a list it cannot know
   * the shape of.
   */
  markNotificationsReadFor(scope: {
    slug?: string;
    category?: string;
    runId?: string;
    sessionId?: string;
    phase?: number;
  }): { changed: number; unread: number } {
    const changed = this.notifications.markReadWhere(scope);
    if (changed) this.emit('notification:read', { ids: null, scope, unread: this.notifications.unread() });
    return { changed, unread: this.notifications.unread() };
  }

  clearNotifications(what: 'all' | 'read' | { id: string }): { removed: number; unread: number } {
    const removed = this.notifications.clear(what);
    if (removed) this.emit('notification:cleared', { removed, unread: this.notifications.unread() });
    return { removed, unread: this.notifications.unread() };
  }

  protected async refreshRepoInfo(): Promise<void> {
    if (!this.root) return;
    this.repo = await repoInfo(this.root.path, this.root.docsDir);
  }

  /**
   * Pre-compute every board so the first list render is instant.
   *
   * The event says WHICH root it warmed, and that one field is the difference
   * between a client that throws away its whole cache on every console boot and
   * one that only does so when the root actually moved under it. `open()` is
   * the sole caller, so a browser reading this is answering exactly one
   * question: "is this still the project I have been looking at?"
   */
  private async warm(): Promise<void> {
    const root = this.root?.path ?? null;
    const slugs = this.store?.list().map((r) => r.slug) ?? [];
    await inLanes(WARM_LANES, slugs, (slug) => this.board(slug).catch(() => undefined));
    this.emit('warm', { plans: slugs.length, root });
  }
}
