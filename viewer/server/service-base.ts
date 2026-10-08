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
import { basename, join, resolve } from 'node:path';
import { availableParallelism, homedir, loadavg } from 'node:os';
import { isSchedulingPolicy, loadGuardFactor, schedulingPolicy, type SchedulingPolicy } from '../shared/orchestration-model.js';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { census, consumeAutostartOnce, fleetProfile, instanceId, instanceUrl, profileFor, readAutostart } from '../shared/instances.mjs';
import type { BootHoldKind, ShutdownClockSource } from '../shared/ops-vocab.js';
import { burnPhrase, FORECAST_LEAD_HOURS } from '../shared/ops-vocab.js';
import {
  INSTANCE,
  INSTANCE_STATE_DIR,
  SKILL_DIR,
  STATE_DIR,
  agentEnabled,
  checkRoot,
  distRev,
  notifyCommand,
  rememberRoot,
  loadPrefs,
  migrateReminderQuiet,
  savePrefs,
  serverIsStale,
  staticRoot,
  type Flags,
  type Prefs,
  type RootCheck,
} from './config.ts';
import {
  SessionRegistry,
  claimWindowEnds,
  holdReleasedAt,
  correlate,
  parseHookPayload,
  sessionsByAccount,
  readSessionEvents,
  type ChangeMeta,
  type RegistryChange,
  type RunLink,
  type SessionEventLine,
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
  automaticResumes, waitClockPhases, waitClockVerdict, waitHoldWhy, WAIT_OVERDUE_GRACE_MS, evidenceFingerprint,
  lockHasLiveLane, lockHeldByLiveRun } from './converge.ts';
import { evaluateWait, hoursText, parkedMsOf, RESUME_REFUSED_RECHECK_MS, WAIT_OVERDUE_ANNOUNCE_MS } from './runner/wait-budget.ts';
import { pollableRefs, probeWatchRef } from './watch-refs.ts';
import { hintedPhases, runEndedBadly, runResumable, type HintedPhase, type ResumeTrigger } from '../shared/run-lifecycle.js';
import { WatchScheduler, phaseDoneOf, type WatchLandingOutcome } from './watch-scheduler.ts';
import { VerifyWatch, type VerifyLookup } from './verify-watch.ts';
import { UnitProber } from './watch-unit.ts';
import { proofsFile, readProofs } from './runner/proofs.ts';
import { answerDeclaredProbe, DECLARED_PROBE_BUDGET_MS, type DeclaredProbeAnswer } from './declared-probe.ts';
import type { WatchState as WatchStateView } from './watch-refs.ts';
import { judgeCommand, runSingleCommand } from './runner/verify.ts';
import { shell } from './shell.ts';
import { planWrite, runWrite } from './writes.ts';
import { holdBinds, readFleetHold, writeFleetHold, clearFleetHold, type FleetHold } from './fleet-hold.ts';
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
  clearStopMarker,
  degradedState,
  disableOwnUnit,
  hasShutdownWork,
  offShutdown,
  onDegraded,
  onShutdown,
  readStopMarker,
  requestRestart,
  requestShutdown,
  restartVerdict,
  stopPlan,
  supervisor,
  writeStopMarker,
  type ExitPlan,
  type RestartHow,
  type ShutdownContext,
  type StopMarker,
  type StopPlan,
  type UnloadPlan,
} from './lifecycle.ts';
import {
  emptyInventory,
  inventoryDigest,
  inventoryEmpty,
  inventorySentence,
  shutdownVerdict,
  soonestClock,
  type InventoryClock,
  type ShutdownInventory,
} from './shutdown.ts';
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
import { SpentTokens, lockScreenOf, mintActionToken, notificationButtons } from './push/actions.ts';
import { humanStepPush, humanStepReminderPush, type HumanStepPush } from './push/catalogue.ts';
import {
  HUMAN_STEP_CLOCK_MS, HUMAN_STEPS_FILE, HumanStepLedger, type DeclareInput, type HumanStep, type TurnRefused,
} from './human-steps.ts';
import { raiseTurn as raiseAtTheDoor } from './turn/index.ts';
import { HANDLED_FILE, HandledLedger, handledOfJournal, type HandledInput, type HandledRow, type JournalLineSeen } from './turn/handled.ts';
import { TurnRound, type RoundState } from './turn/round.ts';
import { count } from './counters.ts';
import { ruleFamilyOf, wallTurnInput, type RecordedWall, type TodayGrant } from './permissions/walls.ts';
import { Grants, GRANTS_FILE, type GrantRow } from './permissions/grants.ts';
import { ownerDoorMode } from './owner/door.ts';
import { guardStep, type CommandJudge } from './turn/guard.ts';
import { parseGuide } from '../shared/guide-grammar.js';
import { KIND_META } from '../shared/human-step-model.js';
import { Notifications, type NotificationQuery, type NotificationRecord } from './notifications.ts';
import {
  composeDigest, DIGEST_EVERY_MS, UNDELIVERED_KEEP, type DigestDetection, type DigestTurn, type DigestUndelivered,
} from './push/digest.ts';
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
  type InboxIssueDraft,
  type InboxSupervisorCard,
  type InboxMessage,
  type InboxReach,
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
  type EtaShape,
} from './analysis/stats.ts';
import {
  detachRequestedIn,
  conflictPolicyOf,
  credentialPolicyFor,
  credentialsFor,
  gitlinkFor,
  isolationFor,
  landFor,
  mcpServersFor,
  personCheckFor,
  permissionModeFor,
  modelPolicyFor,
  verifyTimeoutFor,
  type Plan,
  type PhaseDetail,
  type PhaseRow,
  type Resolved,
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
import type { Actor, McpDegradation, PhaseRecord as RunPhaseRecord } from './runner/state.ts';
import { policyPrefsOf } from './runner/policy.ts';
import { credentialsHeld, probeCredential, type CredentialVerdict } from './credentials-probe.ts';
import { asActor, describeActor, doorActor, viaOfTrigger, type StartActor } from './actor.ts';
import { ceilingSentence, DEFAULT_STARTS_PER_HOUR, DEFAULT_USD_PER_HOUR, probeCeiling, StartCeiling, type CeilingRefusal, type CeilingVerdict } from './start-ceiling.ts';
import type { WaitBudget } from './runner/wait-budget.ts';
import { formatScope, normalizeToken, parseScope, repoKeyOf, scopeOfRow, scopesIntersect } from '../shared/scope.js';
import {
  KIND_PROFILE,
  NO_HANDOFF_AUTO_RE,
  VERIFICATION_AUTO_RE,
  isRecoveryClass,
  recoveryActionsFor,
} from '../shared/recovery-model.js';
import { isLiveStatus } from '../shared/status-vocab.js';
import { DELIVERY_ISSUE_ID, deliveryIssue, environmentReport, type EnvIssue } from './env-doctor.ts';
import { probeDelivery, type DeliveryFacts } from './prelude.ts';
import { claudeConfigDirs, copyCommit, sessionSkillCopy, skillCopyReport, type SkillCopyReport } from './skill-copy.ts';
import { tailscaleStatus } from './tailscale.ts';
import { CONSOLE_VERSION, Heartbeat, MachineLanes, instancesView, type HeartbeatFacts } from './fleet.ts';

/**
 * How long `inFlightRuns()` reuses one walk of the store. Short enough that a
 * run cannot start and finish inside it; long enough that a single admission
 * scan reads the disk once rather than once per lock.
 */
const IN_FLIGHT_RUNS_TTL_MS = 2_000;

/**
 * How long `storedRunById` believes "no plan holds this run id".
 *
 * A HIT is kept for the life of the process — a run id belongs to one plan for
 * as long as its file exists — but a miss has to expire, or a token that
 * arrives a second before its run's first save is answered `unknown` for ever.
 * Short, because the only thing it costs to be wrong is one scan.
 */
const TOKEN_PLAN_MISS_MS = 30_000;

/** How many run ids that map is worth remembering; oldest out first. */
const TOKEN_PLAN_MAX = 256;

import { spentBudgetPark } from './runner/runner-loop.ts';
// Outside the region: the runner's `ladderSeenTtlMs` dep reads it in both trees (#161).
import { LADDER_SEEN_TTL_MS } from './runner/runner-core.ts';
import { accessLedger } from './api/access.ts';
import { Terminals, type SessionEvent, type SessionInfo, type SessionKind } from './terminal.ts';
import { Journal, onJournalAppend } from './runner/journal.ts';
import { CLOCK_MODEL, COST_MODEL, remeasureFromLedger, repriceFromLedger, type CapTable } from './runner/session-record.ts';
import { journalFile } from './runner/run-paths.ts';
import { sizingCensus, type CensusLine, type CensusRun, type SizingCensus } from './analysis/sizing-model.ts';
import { inferSessionScope, locateSessionLog, TranscriptReader, type InferredScope, type ScopeBasis } from './sessions/scope-inference.ts';
import {
  FREEZE_ESCALATE_MS,
  escalatePersistedFreeze,
  freezeVerdict,
  type PersistedEscalation,
} from './runner/freeze.ts';
import type { LaneLiveness } from './runner/liveness.ts';
import {
  appendAck as appendRulingAck,
  appendRuling,
  ingestRulings,
  readRulings,
  rulingsFile,
  type Ruling,
} from './runner/rulings.ts';
import { Relay } from './relay.ts';
import { initVersionFor, noteCliInit } from './cli-init.ts';
import { RELAY_RULE_DEFAULTS, RELAY_WINDOW_MS, sanitiseRelayRules } from '../shared/relay-model.js';
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
  procIdentity,
  pruneRuns,
  reconcileRecordsAgainstBoard,
  resetForRetry,
  resolveRunsAgainst,
  saveRun,
  slugsNeedingBoard,
  runDir,
  waitClockOf,
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
  clearRunFileCache,
  setRunState,
} from './runner/state.ts';
import { adoptionHeld, crashLoop, readCrashLedger, setAdoptionHold } from './crash-ledger.ts';
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
  radarPair,
  treeDisk,
  worktreeHome,
  worktreesRoot,
  STAGING_BRANCH,
  type RunGitView,
} from './runner/worktree.ts';
import { DEFAULT_MAX_PER_REPO, pairKey, reclaimModeOf, WORKTREE_ROOTS } from '../shared/worktree-model.js';
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
import { Accounts, DEFAULT_ACCOUNT_ID, type AccountView, type RunIdentity } from './accounts/index.ts';
import { ConnectivityProbe } from './connectivity-probe.ts';
import { CostDrift } from './runner/usage.ts';
import { HEALTH_TTL_MS, Mcp, type McpServerView } from './mcp/index.ts';
import { IDLE_POLL_MS as ISSUES_SWEEP_MS } from './issues/fetch.ts';
import {
  RETENTION_SWEEP_MS,
  applyRetention,
  collectRetention,
  keptTreeBytes,
  retentionReport,
  type RetentionReport,
} from './retention.ts';
import { IssuesStore, type IssueProvenance } from './issues/index.ts';
import { planFixesLookup } from './issues/fixes.ts';
import { pruneMcpConfigs } from './mcp/config.ts';
import { pruneSettingsFiles, tokenFromSettingsFile, type Approval, type ApprovalEvent, type ManifestCheck } from './runner/approvals.ts';
import { assertTranscriptLayout, cliVersion, portTranscript } from './accounts/transcripts.ts';
import type { HeadroomVerdict } from './accounts/index.ts';
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
  timeoutConsequence,
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
  policyAdvisory,
  struckFor,
  type Evidence,
  type PolicyScope,
  type PermissionProfile,
  type PolicyAdvisory,
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
  SHUTDOWN_ANNOUNCE_WAIT_MS,
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
  SIZING_CENSUS_MS,
  SIZING_CENSUS_WINDOW_MS,
} from './service-core.ts';
import { lockRows, readLockFiles, type LockFilter, type LockRow } from './locks.ts';
import type { Lock } from './parse/folder.ts';

import type { Service } from './service.ts';
import type { Presence } from '../shared/run-lifecycle.js';

/**
 * The presence moves a full construction backlog may throw away (SHD-7): a
 * `prune` (the record is already gone, and `onPresenceChange` returns before
 * the debris path for one) and a `heartbeat` (the next one repeats it). Every
 * other move is a fact with a reaction behind it and is never dropped.
 */
/**
 * A directive the plan actually STATED — a phase bullet or the plan line — or
 * `undefined` for the vocabulary's default. What lets a run's own word (the
 * launch form's, phase 15) speak where the plan is silent, without the
 * runner ever reading the bullets itself.
 */
function stated<T extends string>(resolved: Resolved<T>): T | undefined {
  return resolved.source === 'default' ? undefined : resolved.value;
}

function droppablePresence(event: RegistryChange): boolean {
  return event === 'prune' || event === 'heartbeat';
}

/**
 * A session of one of this console's runs whose hook calls are being refused
 * 401 (#74) — a run-level fault while it lives, because the CLI does not block
 * a tool on a failed hook. `count` is every refusal since `since`.
 */
export type HookFault = {
  runId: string;
  slug: string;
  phase?: number;
  sessionId: string;
  hook: string;
  reason: string;
  count: number;
  since: string;
  lastAt: string;
};

/**
 * A live Claude session in this repository that holds no lock for the phase in
 * question — somebody the phase would collide with (REG-3). `scope` is what
 * the session is working in, as far as the console can tell: its `PE_SCOPE`,
 * else the repository directory its cwd is inside, else `all`.
 */
export type SessionPeer = {
  sessionId: string;
  pid: number | null;
  cwd: string;
  kind: string;
  presence: 'live' | 'unknown';
  owner: string;
  scope: string[];
  plan: { slug: string; phase: number; strong: boolean } | null;
  /**
   * When this peer stops holding the phase (ms epoch): its claim window's end
   * (`claimWindowEnds`), or — for a scope read from what it touched — a window
   * after its last touch (`inferSessionScope`). Absent for a session
   * correlated to the phase itself, which holds it for as long as it lives.
   */
  claimUntil?: number;
  /** How its scope was read (control-tower phase 82, #119) — the queue and the card say it. */
  basis?: ScopeBasis;
  /** A few lines of what that reading rests on. */
  evidence?: string[];
};

/** Why a console boots holding its automation — see `ServiceBase.bootHold`. */
export type BootHold = {
  kind: BootHoldKind;
  /** ISO — when the hold began: the stop's moment, or this boot's. */
  at: string;
  by: string;
  why: string;
  marker?: StopMarker;
};

/** What the Restart button reads before it is pressed — see `ServiceBase.restartReadiness`. */
export type RestartReadiness = {
  ok: boolean;
  reason?: string;
  supervisor: ReturnType<typeof supervisor>;
  /** True where nothing supervises: the console re-executes itself rather than relying on a supervisor. */
  selfRestart?: boolean;
  busy: boolean;
  run: { slug: string; status: string; phase?: number } | null;
  sessions: ReturnType<ServiceBase['sessionInventory']>;
};

/** What pressing Restart did — see `ServiceBase.restart`. */
export type RestartOutcome = {
  ok: boolean;
  reason?: string;
  supervisor?: ReturnType<typeof supervisor>;
  /** The copy is being updated first; the process restarts when the update answers. */
  updating?: boolean;
  /** Pressed mid-run: it waits for the live sessions to finish, then updates and restarts. */
  waiting?: boolean;
  /** Refused because the unit cannot be re-rendered (#71): the re-install a person runs instead. */
  command?: string;
};

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

/**
 * Where the operator's acknowledgements of policy advisories live: per
 * instance, beside the policy file, keyed by kind to the fingerprint of the
 * rule set acknowledged. Not a preference — a pref is a choice about
 * behaviour, and this is a receipt.
 */
const ADVISORY_ACK_FILE = join(INSTANCE_STATE_DIR, 'policy-advisory.json');

/** Beside a plan's runs (`runDir`): the last board that answered, for the next process (#96). */
const LAST_GOOD_BOARD_FILE = 'last-good-board.json';

function readAdvisoryAcks(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(ADVISORY_ACK_FILE, 'utf8')) as { acknowledged?: unknown };
    const acks = parsed?.acknowledged;
    if (!acks || typeof acks !== 'object' || Array.isArray(acks)) return {};
    return Object.fromEntries(Object.entries(acks as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  } catch {
    return {};
  }
}

/** The advisory's identity: its kind over the sorted rules it names. */
function advisoryFingerprint(advisory: PolicyAdvisory): string {
  return createHash('sha256').update(`${advisory.kind}:${[...advisory.rules].sort().join('|')}`).digest('hex').slice(0, 16);
}

/** The machine profile's webhook rows for THIS console — its override first — or none on an unreadable file. */
function machineProfileHooks(): { url: string; name?: string; categories?: string[] }[] {
  try {
    return profileFor(INSTANCE.id).webhooks ?? [];
  } catch {
    return [];
  }
}

/** The words a source brings for its item's first push (control-tower phase 132) — an errand's, a relayed question's. */
export type TurnMessage = { title: string; body: string; detail?: string };

/** The ONE tag an item's pushes ride — its first push and every reminder — so a device holds one notification per item. */
export function turnTagOf(step: Pick<HumanStep, 'id' | 'slug' | 'phase'>): string {
  return tagFor('needs-you', step.slug, String(step.phase), `human-step-${step.id}`);
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
  abstract qaWaive(
    slug: string, phase: number, opts?: { reason?: string; by?: string },
  ): Promise<{ ok: boolean; verdict: string; round?: number; report?: string; detail: string }>;
  protected abstract announceMcpDegraded(state: RunState, phase: number, degraded: McpDegradation[]): void;
  protected abstract announceMcpTimeout(state: RunState, phase: number, result: McpContinueResult): void;
  protected abstract armFreezeEscalation(slug: string, state: RunState): void;
  protected abstract armMcpRequireTimer(slug: string, phase: number, dueAt: number): void;
  protected abstract armMcpRequireTimersFor(state: RunState): void;
  /* The ladder's two availability readers (phase 10), implemented in
   * ServiceRuns and ServiceRecovery and handed to every runner as
   * `rungDrivable`/`rungUnavailable` — the loop's exhaustion predicate is the
   * healer's, so the two cannot disagree about what this console can drive. */
  protected abstract vehicleForRung(
    rung: Rung, situation: Situation, record: RunPhaseRecord | undefined, evidence: PhaseEvidence | null,
    slug?: string, state?: RunState | null,
  ): DriveVehicle | null;
  protected abstract unavailableRungHint(
    situation: Situation, record: RunPhaseRecord | undefined, evidence: PhaseEvidence | null,
    slug: string, state: RunState | null,
  ): string | null;
  protected abstract armSessionInbox(root: string): void;
  abstract authStatus(force?: boolean): Promise<AuthStatus>;
  abstract board(slug: string): Promise<Board>;
  /** A phase's wait budget through the engine — `ServiceLive.waitBudget`. */
  abstract waitBudget(slug: string, phase: number): Promise<WaitBudget>;
  /** The `budget` announcer (control-tower phase 14, #40) — `ServiceLive.announceBudget`. */
  protected abstract announceBudget(data: unknown): void;
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
  /** The stored triggers (control-tower phase 98, #137): read at open, stopped at close — `ServiceRuns`. */
  protected abstract startTriggers(): void;
  protected abstract stopTriggers(): void;
  abstract emit(event: string, data: unknown): void;
  protected abstract emitAccounts(): void;
  /** The identity behind an account changed — park every run bound to the previous one (`ServiceRuns`). */
  protected abstract identityChanged(accountId: string, now: RunIdentity): number;
  /** A login a run depends on can no longer be renewed — announce it with the fix (`ServiceRuns`). */
  protected abstract loginAtRisk(view: Pick<AccountView, 'id' | 'email' | 'name'>, risk: { reason: string; fix: string }): boolean;
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
  /** A queue holder's remaining time — its PHASE's when known (`ServiceRuns.holderEta`, #63). */
  protected abstract holderEta(slug: string, phase: number | null): HolderEta | undefined;
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
  /**
   * A watched run GitHub refused to start (control-tower phase 111, #166) —
   * the healer files the phase's ONE errand naming the budget.
   */
  protected abstract onCiNotRun(slug: string, state: RunState, phase: number, verdict: WatchStateView): void;
  abstract maybeAutoRecover(slug: string, pass?: { trigger?: string; fingerprint?: string }): Promise<AutoRecoverResult>;
  protected abstract mcpRequireTimeoutMs(): number;
  protected abstract onChange(paths: string[]): void;
  protected abstract onPresenceChange(
    record: SessionRecord,
    event: RegistryChange,
    meta?: ChangeMeta,
  ): void;
  protected abstract onRunnerEvent(event: string, data: unknown): void;
  protected abstract planRate(slug: string, ownSamples?: EtaSample[], ownMissing?: number): RateReading;
  protected abstract preRecoveryGate(
    slug: string,
    state: RunState,
    phase: number,
    opts?: { verb?: boolean },
  ): Promise<'proceed' | 'superseded' | 'resolved' | 'unchanged' | 'capped'>;
  /** The evidence fingerprint over this console's facts — the converge pass's function (phase 9). */
  protected abstract accountsStampFor(): string | null;
  protected abstract fingerprintFor(
    slug: string, state: RunState, board: Record<number, string>, qa?: Parameters<typeof evidenceFingerprint>[4],
  ): string;
  protected abstract preflightAccount(accountId: string | undefined, forModel?: string): HeadroomVerdict;
  /** How many registered accounts the breaker refuses, out of how many exist. */
  protected abstract accountsUsable(): { unusable: number; total: number };
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
  /** The recover verb — declared here so the runner's deps can reach it from the constructor (phase 9). */
  abstract recoverPhase(
    slug: string, phase: number, mode: RecoverMode,
    opts?: { instruction?: string; by?: string; settled?: boolean; cls?: RecoveryClass; situation?: string },
  ): Promise<RunState | null>;
  /** The policy editor — declared here for the same reason: the `widen-rule` dep strikes through it. */
  abstract editPolicy(edit: {
    scope?: PolicyScope; slug?: string | null;
    add?: { deny?: string[]; ask?: string[]; allow?: string[] };
    remove?: { deny?: string[]; ask?: string[]; allow?: string[] };
    reset?: ('deny' | 'ask' | 'allow')[];
    restore?: { deny?: string[]; ask?: string[]; allow?: string[] };
    set?: { autoApprove?: boolean | null };
    by?: string;
  }): unknown;
  abstract retryPhase(
    slug: string,
    phase: number,
    override: { addendum?: string; options?: PhaseOptions; by?: string } | undefined,
    actor: StartActor,
  ): Promise<RunState | null>;
  /** A person's Resume press — also what a standing approval card's Allow presses (#140). */
  abstract pressResume(
    slug: string, phase: number, mode: 'resume' | 'closeout',
    opts: { instruction?: string; actor: StartActor },
  ): Promise<import('./runner/state.ts').PressAnswer>;
  abstract sessionViews(): SessionView[];

  /**
   * One session's raw hook payloads, newest-last.
   *
   * A read of evidence, not of state: `sessionViews()` answers what is true
   * now, and this answers how it got that way — the sequence `applyEvent`
   * folds away. Phase 13's timeline reads it, and so does the run bundle.
   */
  sessionEvents(sessionId: string, limit?: number): SessionEventLine[] {
    try {
      return readSessionEvents(join(INSTANCE_STATE_DIR, 'sessions'), sessionId, limit);
    } catch {
      // Not a session id. An empty list is the honest answer: nothing was
      // recorded under that name, which is also what a real miss looks like.
      return [];
    }
  }
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
  /** The policy advisory has been emitted this boot (once, whatever changes after). */
  private policyAdvisoryAnnounced = false;
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
  /**
   * The last board, and the last lint verdict, that PROVED something — kept
   * across revisions on purpose, which is why `forget()` never touches them: a
   * page is served one, marked stale, where the current read timed out or has
   * not landed yet (#44). One entry per plan; a board read that timed out also
   * notes when, so its cached answer is retried after `BOARD_RETRY_MS`.
   */
  protected goodBoards = new Map<string, { at: number; board: Board }>();
  protected boardTimeouts = new Map<string, number>();
  /**
   * When a plan's lint last timed out or could not run — the board's #44 rule
   * for the lint (control-tower phase 81, #97): such a verdict proves nothing,
   * and converge now asks the lint before relaunching a stop about the plan, so
   * a reading that stayed cached for the revision would never be asked again.
   */
  protected lintTimeouts = new Map<string, number>();

  /**
   * The last good board this console — or the one before a restart — read for
   * a plan, or null when none ever was (control-tower phase 84, #96). Memory
   * first; else the copy `rememberGoodBoard` left on disk, because the map
   * alone died with the process and a restarted console summarised an
   * unreadable board as 0 %. A copy that does not parse as a board is none.
   */
  protected lastGoodBoard(slug: string): { at: number; board: Board } | null {
    const hit = this.goodBoards.get(slug);
    if (hit) return hit;
    if (!this.root) return null;
    try {
      const raw = JSON.parse(readFileSync(join(runDir(this.root.path, slug), LAST_GOOD_BOARD_FILE), 'utf8')) as
        { at?: unknown; board?: Partial<Board> };
      const board = raw.board;
      if (typeof raw.at !== 'number' || !board || !Array.isArray(board.done) || !Array.isArray(board.ready)
        || !Array.isArray(board.waiting) || !board.states || typeof board.states !== 'object') return null;
      const entry = { at: raw.at, board: board as Board };
      this.goodBoards.set(slug, entry);
      return entry;
    } catch {
      return null;
    }
  }

  /** Keep a board that answered — in memory, and on disk for the next process (#96). Never throws. */
  protected rememberGoodBoard(slug: string, board: Board): void {
    const entry = { at: Date.now(), board };
    this.goodBoards.set(slug, entry);
    if (!this.root) return;
    try {
      const dir = runDir(this.root.path, slug);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, LAST_GOOD_BOARD_FILE);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(entry));
      renameSync(tmp, file);
    } catch (error) {
      log.warn('engine.board-persist-failed', { slug, error: (error as Error).message });
    }
  }
  protected knownLints = new Map<string, { at: number; revision: number; lint: LintResult }>();
  protected sessionPlans = new Map<string, Cached<SessionPlan>>();
  protected portfolioCache: { generation: number; value: Portfolio } | null = null;
  protected etaPoolCache: { at: number; value: EtaPool } | null = null;
  /** The pool's shape, kept longer than the pool (`ETA_SHAPE_MS`) — see `etaShape`. */
  protected etaShapeCache: { at: number; value: EtaShape | null } | null = null;
  /** The sizing census and the read that is refreshing it — see `sizingCensus`. */
  protected sizingCensusCache: { at: number; value: SizingCensus } | null = null;
  protected sizingCensusRead: Promise<void> | null = null;

  /**
   * What this console measured about its own sessions (control-tower phase 59,
   * #83): the caps every spawn runs under (`deriveCapTable`), the context model
   * and boot floor, and sessions per phase for the forecast. Read from the
   * journals of the runs touched within `SIZING_CENSUS_WINDOW_MS`, in the
   * background, at most once per `SIZING_CENSUS_MS` — a reader never waits for
   * it, and until the first read lands every answer is the shipped one.
   */
  protected sizingCensus(): SizingCensus | null {
    const now = Date.now();
    const cached = this.sizingCensusCache;
    if ((!cached || now - cached.at >= SIZING_CENSUS_MS) && !this.sizingCensusRead) {
      this.sizingCensusRead = this.readSizingCensus(now)
        .then((value) => { if (value) this.sizingCensusCache = { at: Date.now(), value }; })
        .catch((error: unknown) => { log.warn('sizing.census-failed', { error: String(error) }); })
        .finally(() => { this.sizingCensusRead = null; });
    }
    return cached?.value ?? null;
  }

  /** The measured caps the runner's spawns read (`RunnerDeps.sessionCaps`); null until the census lands. */
  protected sessionCapTable(): CapTable | null {
    return this.sizingCensus()?.caps ?? null;
  }

  protected async readSizingCensus(now: number): Promise<SizingCensus | null> {
    const root = this.root?.ok ? this.root.path : null;
    if (!root) return null;
    const since = now - SIZING_CENSUS_WINDOW_MS;
    const runs: CensusRun[] = [];
    const plans = new Map<string, Plan>();
    for (const record of this.store?.list() ?? []) {
      const plan = record.plan;
      if (!plan?.phased) continue;
      plans.set(record.slug, plan);
      let stored: ReturnType<typeof listRuns> = [];
      // The live set, always (control-tower phase 110, #175): read without it,
      // every run this console drove was reconciled as abandoned — once an hour.
      try { stored = listRuns(root, record.slug, this.liveRunIds()); } catch { continue; }
      for (const run of stored) {
        const touched = Date.parse(run.updatedAt ?? '');
        if (Number.isFinite(touched) && touched < since) continue;
        let text: string;
        try { text = await readFile(journalFile(root, record.slug, run.id), 'utf8'); } catch { continue; }
        const lines: CensusLine[] = [];
        for (const raw of text.split('\n')) {
          if (!raw.includes('"phase.session"') && !raw.includes('"phase.tokens"') && !raw.includes('"phase.context-wrapup"')) continue;
          try {
            const entry = JSON.parse(raw) as CensusLine;
            lines.push({ event: entry.event, phase: entry.phase, time: entry.time, data: entry.data });
          } catch { /* a torn line is not a session */ }
        }
        runs.push({ slug: record.slug, phases: run.phases ?? {}, lines });
      }
    }
    return sizingCensus(runs, (slug, phase) => {
      const plan = plans.get(slug);
      const size = plan?.phases[phase]?.size;
      if (!plan || !size) return undefined;
      return { size, weight: weightOf(size, this.sizing, mcpServersFor(plan, phase).length, this.mcpSizing) };
    }, this.sizing, now);
  }

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

  /**
   * The issue drafts a person owes a decision on, for the inbox (phase 12),
   * and which plan filed a number, for the repository page. FREE defaults —
   * nothing, and nobody — overridden in `ServiceRuns`'s Pro region: the free
   * tree's inbox draws no draft rows and its estate carries no chip, and the
   * two call sites (`Service.inbox`, the `IssuesStore` above) compile in both
   * trees without knowing which one they are in. The rule `messagesBlock`
   * learned: a name reachable from a shared module must exist in both trees,
   * and the Pro half is the one that feeds it.
   */
  protected inboxIssueDrafts(): InboxIssueDraft[] {
    return [];
  }

  /** The supervisor's standing cards for the inbox (control-tower phase 101) — none here; the Pro override feeds them. */
  protected inboxSupervisorCards(): InboxSupervisorCard[] {
    return [];
  }

  /**
   * The manifest's answer for a card an automatic actor is about to settle
   * (control-tower phase 84, #112). Nothing here — `Service` reads the plan's
   * `permission.destructive` row; the base has no manifest to read.
   */
  protected manifestAnswerForCard(_approval: Approval): ManifestCheck | null {
    return null;
  }

  /**
   * Say once more what issue drafts still wait for a person (control-tower
   * phase 84, #118) — the issues clock calls it. FREE default: the free tree
   * has no drafts; `ServiceRuns`'s Pro region does the work.
   */
  protected reannounceIssueDrafts(): void {}

  /**
   * The sessions' messages to the OPERATOR, for the inbox (phase 15) — the
   * same FREE-default / Pro-override arrangement as the drafts above, and for
   * the same reason: the free tree has no mailbox and draws no message rows.
   */
  protected inboxMessages(): InboxMessage[] {
    return [];
  }

  protected issueProvenance(_nameWithOwner: string, _number: number): IssueProvenance | undefined {
    return undefined;
  }
  protected listeners = new Set<LiveListener>();

  /**
   * How many event-stream clients this console is writing to.
   *
   * Reported as a gauge, because the retention that took this console down was
   * in exactly these clients' write buffers and there was no sample anywhere
   * that would have shown their number climbing.
   */
  sseClients(): number {
    return this.listeners.size;
  }
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
  /** Budget pushes already sent — one per budget per spend, one per warning key (control-tower phase 14). */
  protected notifiedBudget = new Set<string>();
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
      /** The episode it was armed for — a wait chain's first call (control-tower phase 47). */
      since?: string;
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
   * The runs already named as answered from a stored record (#21) — so
   * `hook.run-stored` is written once per orphan and not once per tool call.
   */
  protected storedTokenNamed = new Set<string>();

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
  /** The machine lane ceiling every console acquires against (FLT-7). */
  readonly machineLanes: MachineLanes;
  /** This console's beat into its registry row — started by `index.ts` once the port is bound (FLT-5). */
  readonly heartbeat: Heartbeat;
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
  /** The `verify:` scheme's oracle — a phase's red lines, re-run on a new head (control-tower phase 88). */
  readonly verifyWatch: VerifyWatch;
  /** The `unit:` scheme's prober — one queue and one ssh master per host (control-tower phase 121). */
  readonly unitProber = new UnitProber();
  /**
   * Settles when this `open()`'s boot work is done: queued runs re-adopted and
   * the convergence loop's boot pass over every plan complete. What a harness
   * awaits instead of guessing how long the console takes to look around.
   */
  bootSettled: Promise<void> = Promise.resolve();
  readonly approvals: Approvals;
  /**
   * Tier 2 (zero-touch-console phase 14): the one place a question a session
   * raised is answered on its behalf — rule, recommendation, first option — and
   * the card a person may beat it on. Built beside the broker it keeps its cards in.
   */
  readonly relay: Relay;
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
  /** The installed CLI's version, read once at boot — stamped on every transcript port (ACT-12). */
  protected cliVersionSeen: string | undefined;
  protected accountsEmitTimer: NodeJS.Timeout | null = null;
  /** This instance's MCP servers — registry, credentials, health, per-run configs. */
  readonly mcp: Mcp;
  /**
   * The per-instance ceiling over every automatic `claude` start
   * (`start-ceiling.ts`, SLF-1): consulted by `startRun` for the nine doors
   * that go through it, by the runner for the reviewer and the cloud review,
   * and by the MCP facade for its probe. Reads the two `ceiling*` prefs live.
   */
  readonly startCeiling: StartCeiling;
  /**
   * The MCP health probe's OWN budget (control-tower phase 100, #73): a probe
   * is not a session, so it never spends the work-start ceiling above.
   */
  readonly probeCeiling: StartCeiling;
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
  /** The digest's hourly clock (control-tower phase 97, #140). */
  protected digestTimer: NodeJS.Timeout | null = null;
  /** Notifications that reached no device since the channel last answered (#140, #108): the newest kept, all counted. */
  protected undelivered: { kept: DigestUndelivered[]; lost: number } = { kept: [], lost: 0 };
  /** When the last digest went out — what its "handled since the last digest" counts from (control-tower phase 138). */
  protected lastDigestAt: number | null = null;
  protected retentionTimer: NodeJS.Timeout | null = null;
  /** The human-step ledger (control-tower phase 41), made on first use — `humanStepsNow`. */
  protected humanStepLedger: HumanStepLedger | null = null;
  /** The grant engine and its ledger (control-tower phase 149), made on first use — `grantsNow()`. */
  protected grantLedger: Grants | null = null;
  /** The reminder clock's timer (control-tower phase 43) — `startHumanStepClock`. */
  protected humanStepTimer: NodeJS.Timeout | null = null;

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
  private presenceBacklog: Array<{ record: SessionRecord; event: RegistryChange; meta?: ChangeMeta }> =
    [];
  /** False until construction has unwound; see `presenceBacklog`. */
  private presenceReady = false;
  /**
   * What the bound cost, by kind (SHD-7): `dropped` — the droppable moves
   * (`prune`, `heartbeat`) thrown away to make room; `deferred` — real moves
   * that could not be parked because nothing droppable was left to evict, kept
   * as a pending reconciliation instead. Reported once, at the flush.
   */
  private presenceBacklogCost: { dropped: Record<string, number>; deferred: Record<string, number> } = {
    dropped: {}, deferred: {},
  };
  /**
   * Real presence moves the bounded backlog could not hold, by session: the
   * latest event per session, re-applied against the record as it then stands
   * by the registry's next poll (SHD-7). A `SessionEnd` or `SessionStart` is
   * never dropped — its record was persisted before the callback, and what a
   * dropped callback lost was the REACTION (the scheduler poll, `correlate`,
   * the lock-debris release), which nothing else would ever re-raise.
   */
  private presenceReconcile = new Map<string, { event: RegistryChange; meta?: ChangeMeta }>();

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
    // ONE quiet-hours setting (control-tower phase 138, #215): a config that
    // still holds the reminders' own window has it moved onto the devices
    // before anything reads either.
    this.adoptReminderQuiet(this.prefs);
    // `link` is a closure rather than a string because `flags.port` moves after
    // construction — `resolvePort` may pick a different one, and a payload that
    // baked in the requested port would send the operator to a console that is
    // not there. `INSTANCE.name` names WHICH console spoke, which matters the
    // moment somebody points two of them at one channel.
    this.webhooks = new Webhooks({
      enabled: flags.allowWebhooks,
      instance: INSTANCE.name,
      profileHooks: machineProfileHooks(),
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
      // Kept to be said again once the channel answers (#140) — never the
      // digest itself, which would only ever report its own absence.
      if (category !== 'digest') {
        this.undelivered.kept = [...this.undelivered.kept, { category, title, at: new Date().toISOString() }]
          .slice(-UNDELIVERED_KEEP);
        this.undelivered.lost += 1;
      }
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
    // The boot doctor's channel row (FLT-1 ii): this console must reach a
    // person — a device, the notifier, a webhook — or it files `push-broken`,
    // re-judged whenever the register or the webhook rows change, and named
    // with the category of the first announcement that found nobody. The
    // Tailscale half under `--remote` is asked once the port is bound
    // (`checkDeliveryReachable`, from `index.ts`).
    this.push.onNoDevice = ({ category, subscribed }) => {
      if (subscribed > 0 || this.noDeviceCategory) return;
      this.noDeviceCategory = category;
      log.warn('push.no-device', { category });
      this.refreshDeliveryIssue();
    };
    this.push.onDevicesChanged = () => this.refreshDeliveryIssue();
    this.webhooks.onRowsChanged = () => this.refreshDeliveryIssue();
    this.refreshDeliveryIssue();
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
    // The policy in force, judged once per boot (phase 12, TRS-9): an empty
    // ask list or a struck deny wall is logged and — unless acknowledged
    // against exactly this rule set — announced on the health channel, the
    // way the environment doctor's one finding is.
    this.announcePolicyAdvisories(Boolean(testing));
    this.watcher = new DocsWatcher((paths) => this.onChange(paths));
    // The session registry: loaded from disk (records + whatever the hook
    // dropped in the inbox while no console was up), then watching the inbox.
    this.sessions = new SessionRegistry({
      dir: join(INSTANCE_STATE_DIR, 'sessions'),
      onChange: (record, event, meta) => this.queuePresenceChange(record, event, meta),
      onWarn: (what, detail) => log.warn(what, detail),
      onInfo: (what, detail) => log.info(what, detail),
      // The 30 s poll is what re-applies a real move the construction backlog
      // could not hold (SHD-7) — a deferral, never a drop.
      onPoll: () => {
        this.applyPresenceReconciliations();
        this.sweepHeldTokens();
      },
    })
      .load()
      .start();
    this.approvals = new Approvals({
      // #112: what the plan's `permission.destructive` row answers for a card,
      // re-read when an automatic actor would settle it — see `Service`.
      manifestAnswer: (approval) => this.manifestAnswerForCard(approval),
      // T-15 and T-5 (control-tower phase 97, #140): the push and the
      // notification inbox, with what the timeout will do.
      warn: (approval, leadMs) => this.announceExpiring(approval, leadMs),
      notify: (approval) => {
        const where = `${approval.slug}${approval.phase != null ? ` phase ${approval.phase}` : ''}`;
        // A card born decided — a grant under a plan's publishing exception
        // (TRS-4) — is announced once, as news rather than as a question:
        // nothing is left to answer, so no verbs ride it and no `approval`
        // event puts it in a queue. `approval:resolved` already told the pages.
        if (approval.status !== 'pending') {
          this.announce(
            'approval',
            {
              title: 'Published under a plan exception',
              body: `${where} — ${approval.title}`,
              tag: tagFor('approval', approval.id),
              detail: approval.reason ?? approval.detail,
            },
            { slug: approval.slug, phase: approval.phase, runId: approval.runId, approvalId: approval.id },
          );
          return;
        }
        this.emit('approval', approval);
        // A relayed question (phase 14) is a session ASKING — the `session-ask`
        // push, with the question and its options as the body — and it carries
        // no verbs: a notification button may allow or deny, never choose one
        // of four labels, so the answer is a tap on the approve page.
        if (approval.kind === 'question') {
          const first = approval.question?.items[0];
          const options = first?.options.map((option) => option.label).join(' · ') ?? '';
          this.announce(
            'session-ask',
            {
              title: `A session asks — answered by rule in ${Math.round(RELAY_WINDOW_MS / 1000)} s unless you do`,
              body: `${where} — ${approval.title}${options ? ` (${options})` : ''}`.slice(0, 400),
              tag: tagFor('session-ask', 'question', approval.id),
              detail: approval.detail,
            },
            { slug: approval.slug, phase: approval.phase, runId: approval.runId, approvalId: approval.id },
          );
          return;
        }
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
      // The run journal's twins of a raise and of every ending (TRS-7).
      record: (event, approval) => this.journalApproval(event, approval),
      // A relayed question the broker would end on its own is the relay's.
      questionEnding: (approval, why) => this.relay?.end(approval, why) ?? false,
    });
    this.relay = new Relay({
      approvals: this.approvals,
      runner: (runId) => this.runnerByRunId(runId),
      journal: (slug, runId, event, data, phase) => {
        if (this.root?.ok) Journal.for(this.root.path, slug, runId).append(event, data, phase);
      },
      announce: (category, message, context) => this.announce(category, message, context),
      tagFor: (...parts) => tagFor(...parts),
      // An unanswerable question is a `decision` item of Your turn (phase 132).
      raiseTurn: (input, message) => {
        const raised = this.raiseTurn(input, { message });
        return Boolean(raised && !('refused' in raised));
      },
      appendRuling: (slug, ruling) => {
        if (!this.root?.ok) return;
        appendRuling(rulingsFile(this.root.path, slug), {
          slug, phase: ruling.phase, kind: 'ambiguity', what: ruling.what, why: ruling.why,
          decisionKey: 'ambiguity', by: ruling.by, relay: ruling.relay,
          ...(ruling.sessionId ? { sessionId: ruling.sessionId } : {}),
        });
      },
      rules: () => [...RELAY_RULE_DEFAULTS, ...sanitiseRelayRules(this.prefs?.relayRules)],
      scriptsDir: flags.scriptsDir,
    });
    // The machine's lanes, every console's (zero-touch phase 17, FLT-7):
    // `fleet.json` `maxSessions` is the ceiling on the machine, and each lane
    // this console starts is a token every sibling counts at its own admission.
    this.machineLanes = new MachineLanes(INSTANCE.id, { name: INSTANCE.name, port: () => this.flags.port });
    this.heartbeat = new Heartbeat(INSTANCE.id, () => this.heartbeatFacts());
    this.scheduler = new Scheduler({
      // Read per call, like `max` beside it: a flip in Settings takes effect on
      // the next scan rather than at the next console.
      maxPerRepo: () => this.prefs.maxConcurrentPerRepo ?? DEFAULT_MAX_PER_REPO,
      max: () => this.flags.maxSessions,
      machine: this.machineLanes,
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
      // The machine-load guard (control-tower phase 100, #135 G.27): read per
      // scan, like `max`, so a factor moved in Settings lands on the next one.
      load: () => this.loadSample(),
      // How much longer a holder's plan has — decoration on the queue page,
      // never an input to the decision. Synchronous off the memo above, so a
      // cold answer is `undefined` rather than an await inside the scan.
      etaFor: (slug, phase) => this.holderEta(slug, phase),
      // Presence beats the lease: a lock whose session the registry shows
      // ended stops blocking NOW; a live one is named as live on the queue.
      //
      // Through `lockPresenceFor`, never the raw registry (SCH-3). A LANE's
      // lock outlives its attempt's session by design — the keepalive rewrites
      // it every refresh still naming a session that exited — so the raw word
      // is `ended` for a claim a run is actively holding, and `ended` here is
      // what stops it blocking and admits a second lane into the same tree.
      presence: (lock) => this.lockPresenceFor(lock),
      // …and presence speaks with no lock at all (REG-3): a live session in
      // this repository that has not claimed yet is a holder, named.
      peers: (entry) => (this.root?.ok
        ? this.peersInRepository(this.root.path, { slug: entry.slug, phase: entry.phase }, [], entry.scope)
        : []),
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
        Journal.for(this.root.path, slug, state.id).append(kind, data, phase);
      },
      save: (_slug, state) => {
        saveRun(state);
      },
      onLanded: (slug, state, phase, landed) => this.onWatchLanded(slug, state, phase, landed),
      onNotRun: (slug, state, phase, verdict) => this.onCiNotRun(slug, state, phase, verdict),
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
      // …and a ref the console MINTED runs only on an explicit yes (SLF-8).
      mintedCmdRefsEnabled: () => this.flags.allowRun && this.prefs.watchMintedCmdRefs === true,
      runCommand: (command, timeoutMs) =>
        runSingleCommand(command, {
          cwd: this.root?.path ?? process.cwd(),
          timeoutMs,
        }),
      // …and judged WITHOUT running, at declaration (control-tower phase 88,
      // #125): a ref the policy would refuse is refused while the session can
      // still fix it, however `watchCmdRefs` is set.
      judgeCommand: (command) => judgeCommand(command),
      // `credential:<id>` — a credential read by presence, never its value
      // (control-tower phase 132): the proof a `secret-entry` item is given.
      credentialProbe: (id) => this.credentialProbe(id),
      // `phase:<slug>/<N>` for a plan the pass did not load (#129): that plan's
      // latest run record, then its board when no run holds the phase.
      phaseDone: (slug, phase) => this.phaseDoneAnswer(slug, phase),
      // `verify:<slug>/<N>`: the declaring phase's red lines on a new head.
      verifyProbe: (target) => this.verifyWatch.probe(target),
      // `unit:<host>/<unit>` (control-tower phase 121, #181): one ssh master per host.
      unitProbe: (target) => this.unitProber.probe(target),
    });
    this.verifyWatch = new VerifyWatch({
      lookup: (slug, phase) => this.verifyLookup(slug, phase),
      head: async (cwd) => {
        const run = await shell('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
          channel: 'shell', intent: 'watch-ref', timeout: 10_000, expectFailure: true,
        });
        const sha = run.ok ? run.stdout.trim() : '';
        return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
      },
      run: (command, cwd, timeoutMs) => runSingleCommand(command, { cwd, timeoutMs }),
    });
    // No flag: reading the issues of the repository you pointed this console at
    // is DISPLAY, exactly like `sessions/registry` and the repo browse surface.
    // Acting on them — minting a plan session — is the plan wizard's own
    // `--allow-agent` door, unchanged.
    this.issues = new IssuesStore({
      root: () => this.root?.path,
      stateDir: INSTANCE_STATE_DIR,
      // Which plan filed a number (phase 12) — answered by the Pro half from
      // the plans' issue ledgers, `undefined` from this base and the free tree.
      provenance: (nameWithOwner, number) => this.issueProvenance(nameWithOwner, number),
      // The desk's "planned in <slug> phase N" (control-tower phase 118): the
      // phase whose `Fixes:` line names the issue, read off the plan store's
      // own parse and re-indexed only when that plan's file moves.
      fixes: planFixesLookup((slug) => {
        const record = this.store?.get(slug);
        return record?.plan ? { mtime: record.planMtime, phases: record.plan.phases } : undefined;
      }),
      // The repositories the operator added to the desk by `owner/name`
      // (`prefs.issueRepos`) — read live, so an Add or a Remove is the next read.
      added: () => this.prefs.issueRepos ?? [],
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
      // …and the forecast warns HOURS before the wall (control-tower phase 92,
      // #141): an account serving live runs projected to wall inside the lead —
      // what it walls at, when it resets, and who is burning it. Holding new
      // admissions on the projection is the operator's opt-in.
      forecastLeadMs: () => (this.prefs.usageForecastLeadHours ?? FORECAST_LEAD_HOURS) * 3_600_000,
      onForecast: (view, bucket, forecast) => {
        const name = view.email ?? view.name ?? view.id;
        const wallsAt = forecast.wallsAt ? new Date(forecast.wallsAt) : null;
        const resets = new Date(forecast.resetsAt);
        const held = Number.isNaN(resets.getTime()) || !wallsAt ? null : Math.max(0, resets.getTime() - wallsAt.getTime());
        const runs = (view.forecast?.burning ?? []).map((run) => `${run.slug} (phase${run.lanes.length === 1 ? '' : 's'} ${run.lanes.join(', ')})`);
        this.announce('usage-climbing', {
          title: `Usage walls in ${wallsAt ? `about ${hoursText(wallsAt.getTime() - Date.now())}` : 'under the lead'} — ${bucketLabel(bucket)}`,
          body: `${name}: ${Math.round(forecast.pct)}% of the ${bucketLabel(bucket)} window, ${burnPhrase(forecast.burnPctPerHour) || 'climbing'}`
            + ` · walls ≈${wallsAt ? wallsAt.toLocaleTimeString() : 'soon'}`
            + ` · resets ${Number.isNaN(resets.getTime()) ? forecast.resetsAt : resets.toLocaleString()}`
            + `${held !== null ? ` (${hoursText(held)} walled)` : ''}`
            + `${runs.length ? ` · burning it: ${runs.join('; ')}` : ''}`,
          tag: tagFor('usage-climbing', 'forecast', view.id, bucket, forecast.resetsAt),
        });
        if (this.prefs.usageForecastHold === true) {
          this.scheduler.brake(view.id === DEFAULT_ACCOUNT_ID ? undefined : view.id, {
            untilMs: Number.isNaN(resets.getTime()) ? null : resets.getTime(), pct: forecast.pct, window: bucket,
          });
        }
      },
      // Credits stopped carrying an account the operator let use them, or
      // started again (control-tower phase 93, #146). A stop is the operator's
      // to know — its runs are back on the plan's limits, by their own rules;
      // a start lifts the brake a plan window put on the account.
      onCredits: (view, change) => {
        const name = view.email ?? view.name ?? view.id;
        if (change.carrying) this.scheduler.releaseBrake(view.id === DEFAULT_ACCOUNT_ID ? undefined : view.id);
        this.announce('limits', {
          title: change.carrying ? `Credits carry ${name} again` : `Credits stopped — ${name}`,
          body: change.carrying
            ? `${name}: ${change.reason}. Runs on it are no longer held by its plan windows.`
            : `${name} can no longer run past its plan windows on credit: ${change.reason}. `
              + 'Its runs are back on the plan\'s limits — a switch, a wait or a pause, by their own rules.',
          tag: tagFor('limits', 'credits', view.id),
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
              ? `The API refused ${name}'s Claude login. Sessions on it will fail until someone ` +
                'signs in again — Settings → Claude accounts has the button.'
              : `${name} is signed out. Sign in again from Settings → Claude accounts before running ` +
                'work as it.',
          tag: tagFor('limits', 'auth', view.id),
        });
      },
      // The identity behind an account changed (control-tower phase 91, #131):
      // every run bound to the previous one parks for a person.
      onIdentityChange: (accountId, now) => { this.identityChanged(accountId, now); },
      // A login a run depends on can no longer be renewed (#147 ask 4).
      onLoginAtRisk: (view, risk) => { this.loginAtRisk(view, risk); },
    });
    // The poller's adaptive cadence, wired at last (ACT-3): an account one of
    // this console's runners is spending RIGHT NOW is read every ~90 s, the
    // rest every ten minutes. `runners` is a map on this instance, so the
    // probe is late-bound like every other runner seam here.
    this.accounts.setActiveProbe((accountId) =>
      [...this.runners.values()].some((runner) => runner.isSpending(accountId)));
    // Who is burning each account, for its forecast (control-tower phase 92, #141).
    this.accounts.setBurningProbe((accountId) =>
      [...this.runners.values()].flatMap((runner) => runner.burningOn(accountId)));
    // Who is set to PAY as each account — the bar's paying mark (control-tower
    // phase 13, #33) — whether or not a lane of it is spending this minute.
    this.accounts.setPayingProbe((accountId) => this.payingAs(accountId));
    this.probeCeiling = probeCeiling();
    this.startCeiling = new StartCeiling(() => ({
      startsPerHour: this.prefs.ceilingStartsPerHour ?? DEFAULT_STARTS_PER_HOUR,
      usdPerHour: this.prefs.ceilingUsdPerHour ?? DEFAULT_USD_PER_HOUR,
    }));
    this.mcp = new Mcp({
      onChange: () => this.emitMcp(),
      // The probe spends its OWN budget (control-tower phase 100, #73: "must
      // not share the automatic-start ledger with work sessions"): refused past
      // it — health goes stale, which is what it does overnight anyway — and
      // never counted against the ceiling that stops a runaway work loop.
      ceiling: {
        admit: (actor) => this.probeCeiling.admit(actor),
        charge: (actor) => this.probeCeiling.charge(actor, null),
      },
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
    // The transcript layout the switch-and-resume path depends on is the CLI's
    // and undocumented (ACT-12): read once here and logged, so a release that
    // moves the files is noticed at boot rather than at the first switch that
    // finds nothing; the CLI's version is remembered so every port records
    // the layout it was made under.
    const layout = assertTranscriptLayout(this.accounts.configDirFor(undefined));
    if (layout.ok) log.info('accounts.transcript-layout', { ...layout });
    else log.warn('accounts.transcript-layout', { ...layout });
    void cliVersion().then((version) => { this.cliVersionSeen = version; });
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
   * way to fall over at boot. What the bound bites is chosen by KIND, never by
   * arrival (SHD-7): `load()` ingests the inbox before it prunes, so on a deep
   * inbox the moves at the back of the queue were exactly the ingested
   * `SessionEnd`s whose locks are debris — and an early `return` threw the
   * newest away. Now a full backlog evicts its oldest droppable move (`prune`,
   * `heartbeat`) to make room, drops an incoming droppable when there is none,
   * and parks a real move it cannot hold as a pending reconciliation the next
   * poll re-applies.
   */
  private queuePresenceChange(record: SessionRecord, event: RegistryChange, meta?: ChangeMeta): void {
    if (this.presenceReady) {
      this.onPresenceChange(record, event, meta);
      return;
    }
    if (this.presenceBacklog.length < PRESENCE_BACKLOG_MAX) {
      this.presenceBacklog.push({ record, event, ...(meta ? { meta } : {}) });
      return;
    }
    const cost = this.presenceBacklogCost;
    const evictable = this.presenceBacklog.findIndex((entry) => droppablePresence(entry.event));
    if (evictable >= 0) {
      const [evicted] = this.presenceBacklog.splice(evictable, 1);
      cost.dropped[evicted.event] = (cost.dropped[evicted.event] ?? 0) + 1;
      this.presenceBacklog.push({ record, event, ...(meta ? { meta } : {}) });
      return;
    }
    if (droppablePresence(event)) {
      cost.dropped[event] = (cost.dropped[event] ?? 0) + 1;
      return;
    }
    cost.deferred[event] = (cost.deferred[event] ?? 0) + 1;
    this.presenceReconcile.set(record.sessionId, { event, ...(meta ? { meta } : {}) });
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
    const cost = this.presenceBacklogCost;
    if (Object.keys(cost.dropped).length || Object.keys(cost.deferred).length) {
      // Once, at the flush, by kind — so a reader can see the bound bit only
      // what it may (`prune`, `heartbeat` under `dropped`) and how many real
      // moves wait for the poll (`deferred`).
      log.warn('sessions.presence-backlog-full', {
        max: PRESENCE_BACKLOG_MAX, dropped: cost.dropped, deferred: cost.deferred,
      });
    }
    for (const { record, event, meta } of pending) {
      try {
        this.onPresenceChange(record, event, meta);
      } catch (error) {
        log.warn('sessions.presence-apply-failed', {
          session: record.sessionId,
          event,
          error: (error as Error).message,
        });
      }
    }
  }

  /**
   * Re-apply the real moves the construction backlog deferred, against each
   * session's record as it stands NOW — the registry's poll calls this, so a
   * deferred `SessionEnd` reaches the scheduler and the convergence loop within
   * one poll instead of never (SHD-7). A session pruned in the meantime is
   * skipped: its record is gone, and a lock naming it reads `unknown` and
   * lapses on its lease.
   */

  protected applyPresenceReconciliations(): number {
    if (!this.presenceReady || !this.presenceReconcile.size) return 0;
    const pending = [...this.presenceReconcile];
    this.presenceReconcile.clear();
    let applied = 0;
    for (const [sessionId, { event, meta }] of pending) {
      const record = this.sessions.get(sessionId);
      if (!record) continue;
      try {
        this.onPresenceChange(record, event, meta);
        applied++;
      } catch (error) {
        log.warn('sessions.presence-apply-failed', { session: sessionId, event, error: (error as Error).message });
      }
    }
    if (applied) log.info('sessions.presence-reconciled', { applied, events: pending.map(([, e]) => e.event) });
    return applied;
  }

  /* ---------------------------------------------------------------- *
   * The runner pool
   * ---------------------------------------------------------------- */

  /** The runner for a plan, made on first use. See `runners`. */
  /**
   * May the console push this run's `pe/*` branches? The base says no: the
   * flag and the plan's `permission.destructive` row are the leaf service's
   * to read (`Service.publishAllowedFor`), and a base that answered yes would
   * be a base that pushed.
   */
  protected publishAllowedFor(_state: RunState, _phase: number): boolean {
    return false;
  }

  /**
   * Does any phase of this plan land by pull request (`Land: pr` or
   * `trunk`)? The publish carve-out's question (phase 8): such a plan boards
   * a landing session after each of those phases, and that session's
   * `gh pr create`/`gh pr merge` must raise a card under every profile. A
   * plan-wide `Land:` answers for every phase; a phase's own bullet answers
   * for itself.
   */
  protected planPublishes(slug: string): boolean {
    const plan = this.store?.get(slug)?.plan;
    if (!plan) return false;
    const lands = (phase?: number): boolean => {
      const word = landFor(plan, phase).value;
      return word === 'pr' || word === 'trunk';
    };
    return lands() || Object.keys(plan.phases).some((n) => lands(Number(n)));
  }

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
  /**
   * Clash zones by pair key — the ONE thing the radar tells the free half.
   *
   * 🔴 A map rather than a call, and that is the whole point of it. The radar
   * is Pro and the inbox is free, so a free module calling into the Pro one is
   * a free tree that will not load — the lesson `messagesBlock` taught in
   * phase 10, restated: a helper a free module reaches must be FREE, and the
   * Pro half must be the thing that FEEDS it. This map is always here and is
   * simply always empty in the free tree, so the reader needs no branch and
   * the free build needs no override.
   */
  protected readonly radarZones = new Map<string, string[]>();


  /**
   * The live runs set to pay as an account (control-tower phase 13, #33) —
   * the paying mark on its view, and the runs a machine-login re-sign-in
   * would end. A run this console is driving, whatever its lanes are doing.
   */
  protected payingAs(accountId: string): { slug: string; runId: string }[] {
    const out: { slug: string; runId: string }[] = [];
    for (const [slug, runner] of this.runners) {
      const state = runner.busy() ? runner.current() : null;
      if (state && (state.accountId ?? DEFAULT_ACCOUNT_ID) === accountId) out.push({ slug, runId: state.id });
    }
    return out;
  }

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
            childrenOf(loadRun(root, record.slug, runId, live) ?? ({ phases: {} } as RunState)).map(
              (child) => child.pid,
            ),
          probe: (pid) => pidHoldsWork(pid),
          // The same two answers the runner's own sweep gives (phase 15):
          // each dead run's own retention word, else the console's — and
          // whether it ended badly, which `keep-on-failure` asks. The boot
          // sweep passed neither before, so it read every run as clean and
          // every word as the shipped default.
          retention: (runId) => loadRun(root, record.slug, runId, live)?.worktreeRetention ?? this.prefs.worktreeRetention,
          failed: (runId) => runEndedBadly(loadRun(root, record.slug, runId, live)),
          // 🔴 #94: this sweep runs BEFORE any runner re-registers, so `live` is
          // empty here by construction and "not live" read as "over" — a paused
          // run's clean mirror mounts went at every restart. The stored run is
          // the only witness that something will drive it again.
          resumable: (runId) => runResumable(loadRun(root, record.slug, runId, live)),
        });
        if (result.removed.length || result.kept.length || result.spared.length) {
          log.info('run.worktrees-swept', {
            slug: record.slug,
            removed: result.removed,
            kept: result.kept,
            runs: result.runs,
            ...(result.spared.length ? { spared: result.spared } : {}),
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

  /** Runs whose surviving child's hook token could not be read back — `token-lost` for their cards. */
  protected tokenLostRuns = new Set<string>();

  /** Hook calls refused from a session one of this console's runs launched (#74), keyed `runId session`. */
  protected hookFaults = new Map<string, HookFault>();
  /** Session ids a refused hook call named that belong to no run here — asked once each. */
  private hookStrangers = new Set<string>();

  /**
   * A hook call answered 401 (#74). From a session one of this console's runs
   * launched it is not noise: the CLI does not block a tool on a failed hook,
   * so that session is working with no policy, no ask card and no wait guard.
   * It is a RUN-level fault — journalled `run.hook-unauthorised` on its run
   * once per session, and standing in the inbox as a health row while the
   * session lives. Anything else stays the `hook.rejected` log line it was.
   */
  noteHookUnauthorised(hook: string, body: unknown, reason: string): void {
    const raw = (body as { session_id?: unknown } | null)?.session_id;
    const sessionId = typeof raw === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(raw) ? raw : '';
    if (!sessionId || this.hookStrangers.has(sessionId)) return;
    const known = [...this.hookFaults.values()].find((fault) => fault.sessionId === sessionId);
    if (known) { known.count += 1; known.lastAt = new Date().toISOString(); return; }
    const owner = this.sessions.get(sessionId)?.owner ?? '';
    const ownerRun = /^autopilot\/([A-Za-z0-9_-]+)$/.exec(owner)?.[1];
    let found: HookFault | null = null;
    for (const [slug, runner] of this.runners) {
      const state = runner.current();
      if (!state) continue;
      const record = Object.values(state.phases ?? {}).find((phase) => phase.sessionId === sessionId);
      if (!record && state.id !== ownerRun) continue;
      const at = new Date().toISOString();
      found = { runId: state.id, slug, sessionId, hook, reason, count: 1, since: at, lastAt: at, ...(record ? { phase: record.phase } : {}) };
      break;
    }
    if (!found) {
      if (this.hookStrangers.size >= 256) this.hookStrangers.clear();
      this.hookStrangers.add(sessionId);
      return;
    }
    this.hookFaults.set(`${found.runId} ${sessionId}`, found);
    const data = { sessionId, hook, reason, ...(this.approvals.liveToken(found.runId) ? { armed: true } : { armed: false }) };
    try {
      const runner = this.runners.get(found.slug);
      if (runner?.current()?.id === found.runId) runner.note('run.hook-unauthorised', data, found.phase);
      else if (this.root?.ok) Journal.for(this.root.path, found.slug, found.runId).append('run.hook-unauthorised', data, found.phase);
    } catch { /* the journal is bookkeeping: the inbox row still stands */ }
    this.emit('inbox', { at: new Date().toISOString() });
  }

  /** The standing hook faults, for the inbox — a session that has ended takes its row with it. */
  protected hookFaultFacts(): HookFault[] {
    for (const [key, fault] of [...this.hookFaults]) {
      if (this.sessions.presence(fault.sessionId) === 'ended') this.hookFaults.delete(key);
    }
    return [...this.hookFaults.values()];
  }

  /**
   * Retire the hook tokens kept past their loop (#74) once the last child
   * holding one has gone. On the registry's 30 s poll.
   */
  protected sweepHeldTokens(): void {
    for (const runId of this.approvals.sweepHeld(this.liveRunIds())) log.info('approvals.token-released', { runId });
  }

  /**
   * What an earlier console left of its approvals (TRS-11), judged once the
   * runs can be read: a run whose child outlived that console gets its token
   * ADOPTED from the settings file the child is still holding — never a fresh
   * one, which would make every later hook call from that child unauthorised,
   * and this hook fails open — and each outstanding card is kept answerable or
   * filed `unanswerable` with the reason that holds.
   */
  protected recoverApprovals(): void {
    if (!this.root?.ok) return;
    // Adoption is the act this hold exists to stop. A console in a crash loop
    // adopting a surviving child's hook token is a console about to die again
    // holding the only credential that child's next hook call can be answered
    // with — and the measured loop did exactly that, twice, five minutes apart.
    const held = adoptionHeld();
    if (held) {
      log.info('approvals.adoption-held', { hold: held });
      return;
    }
    const live = this.liveRunIds();
    for (const record of this.store?.list() ?? []) {
      let state: RunState | null = null;
      try { state = latestRun(this.root.path, record.slug, live); } catch { state = null; }
      if (!state || live.has(state.id)) continue;
      const alive = childrenOf(state).filter((child) => pidHoldsWork(child.pid, procIdentity(child)));
      if (!alive.length) continue;
      const token = tokenFromSettingsFile(state.id);
      if (token && this.approvals.adoptToken(state.id, token)) {
        log.info('approvals.token-adopted', { runId: state.id, slug: record.slug, pids: alive.map((child) => child.pid) });
        // …held by those children, so it is retired when the last one goes (#74).
        this.approvals.release(state.id, alive.map((child) => ({ pid: child.pid, ...procIdentity(child) })));
      } else {
        this.tokenLostRuns.add(state.id);
        log.warn('approvals.token-lost', { runId: state.id, slug: record.slug, pids: alive.map((child) => child.pid) });
      }
    }
    this.approvals.recover((card) => {
      // A relayed question (phase 14): answered by rule NOW, the outage in its
      // `waitedMs` — answerable when it was deferred, `hook-closed` when not.
      if (card.kind === 'question') return this.relay.recoverCard(card);
      if (card.standing) return { unanswerable: 'reoffered' };
      if (card.kind !== 'tool') return { unanswerable: 'asker-gone' };
      if (this.approvals.liveToken(card.runId)) return { answerable: true };
      return { unanswerable: this.tokenLostRuns.has(card.runId) ? 'token-lost' : 'session-gone' };
    });
  }

  /**
   * The run journal's twin of an approval moment (TRS-7): a raise and every
   * ending — a person, `disarm()`, the timeout — on the run that asked, through
   * its live runner when one drives it and onto its journal file when none
   * does. A grant's twin is written by its one caller, which alone knows the
   * scope that answered (`phase.approval-auto-granted`).
   */
  /**
   * A card about to run out (control-tower phase 97, #140), said where an
   * operator away from the console will see it: the push — on the card's own
   * tag, so it replaces the card on a lock screen — and the notification
   * inbox, both through `announce`. It names the card, its deadline and what
   * its timeout will do, and carries Allow and Extend.
   */
  protected announceExpiring(approval: Approval, leadMs: number): void {
    const where = `${approval.slug}${approval.phase != null ? ` phase ${approval.phase}` : ''}`;
    this.announce(
      'approval',
      {
        title: `Approval expires in ${Math.max(1, Math.round(leadMs / 60_000))} min — ${where}`,
        body: `${approval.title} — ${approval.onTimeout ?? timeoutConsequence(approval)}`.slice(0, 400),
        tag: tagFor('approval', approval.id),
        detail: approval.detail,
      },
      {
        slug: approval.slug,
        phase: approval.phase,
        runId: approval.runId,
        approvalId: approval.id,
        answer: {
          item: inboxItemId({
            kind: 'approval', slug: approval.slug, phase: approval.phase, runId: approval.runId, subject: approval.id,
          }),
          verbs: ['allow', 'extend'],
        },
      },
      { replace: true },
    );
  }

  protected journalApproval(event: ApprovalEvent, approval: Approval): void {
    if (event === 'auto-granted' || approval.runId === 'unknown') return;
    // The card's later moments (#140): a warning, an Extend, a card that stands.
    const later = event === 'warned' ? 'phase.approval-expiring'
      : event === 'extended' ? 'phase.approval-extended'
        : event === 'standing' ? 'phase.approval-standing' : null;
    if (later) {
      const data: Record<string, unknown> = {
        approvalId: approval.id, expiresAt: approval.expiresAt, onTimeout: approval.onTimeout ?? null,
        ...(event === 'warned' ? { leadMs: approval.warned?.at(-1) ?? null } : {}),
        ...(event === 'extended' ? { ...approval.extended?.at(-1), standsUntil: approval.standsUntil ?? null } : {}),
        ...(event === 'standing' ? { convertedAt: approval.converted?.at ?? null } : {}),
      };
      try {
        const runner = this.runnerByRunId(approval.runId);
        if (runner) runner.note(later, data, approval.phase ?? undefined);
        else if (this.root?.ok && approval.slug && approval.slug !== 'unknown') {
          Journal.for(this.root.path, approval.slug, approval.runId).append(later, data, approval.phase ?? undefined);
        }
      } catch { /* the journal twin is bookkeeping: it never costs the card */ }
      return;
    }
    const name = event === 'raised' ? 'phase.approval-raised' : 'phase.approval-decided';
    const data: Record<string, unknown> = event === 'raised'
      ? {
        approvalId: approval.id, kind: approval.kind, title: approval.title.slice(0, 200), expiresAt: approval.expiresAt,
        ...(approval.tool ? { tool: approval.tool.name } : {}),
        ...(approval.matched !== undefined ? { matched: approval.matched } : {}),
        ...(approval.standing ? { standing: true } : {}),
      }
      : {
        approvalId: approval.id, kind: approval.kind, decision: approval.status, decidedBy: approval.decidedBy ?? null,
        waitedMs: Math.max(0, (Date.parse(approval.decidedAt ?? '') || Date.now()) - Date.parse(approval.createdAt)),
        ...(approval.recovered ? { recovered: true } : {}),
        // The why a person decided with, which the card kept and this line
        // dropped (control-tower phase 96, #142).
        ...(approval.reason ? { reason: approval.reason.slice(0, 500) } : {}),
      };
    const phase = approval.phase ?? undefined;
    try {
      const runner = this.runnerByRunId(approval.runId);
      if (runner) {
        runner.note(name, data, phase);
        return;
      }
      if (this.root?.ok && approval.slug && approval.slug !== 'unknown') {
        Journal.for(this.root.path, approval.slug, approval.runId).append(name, data, phase);
      }
    } catch { /* the journal twin is bookkeeping: it never costs the decision */ }
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
  /**
   * The supervisor chats whose `--mcp-config` a sweep must keep (control-tower
   * phase 27) — none in a build without the chat, where no chat file is ever
   * touched; the Pro service answers with the chats that have a live process.
   */
  protected liveChatIds(): string[] | undefined {
    return undefined;
  }

  /** The console is closing — the Pro service ends its chats' processes here. */
  protected closeChats(): void {}

  protected sweepRunSecrets(): void {
    // …and every run whose token this console adopted from a surviving child
    // (TRS-11): that child is still holding the file, and the file is the only
    // place its token can be read back from on the next restart.
    const keep = new Set([...this.liveRunIds(), ...this.approvals.armedRuns()]);
    const removed = [...pruneMcpConfigs(keep, this.liveChatIds()), ...pruneSettingsFiles(keep)];
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
    const policy = loadPrefs().retention;
    const keep = this.liveRunIds();
    let removed = 0;
    for (const record of this.store?.list() ?? []) {
      try {
        removed += pruneRuns(
          this.root.path,
          record.slug,
          keep,
          Date.now(),
          policy.runRetainDays * 24 * 60 * 60_000,
          policy.runRetainMin,
        ).length;
      } catch {
        /* one unreadable plan directory must not stop the sweep */
      }
    }
    if (removed) log.info('run.records-swept', { runs: removed, kept: keep.size });
  }

  /**
   * Bring every stored run booked under the old cost model to `COST_MODEL`,
   * ONCE (control-tower phase 46, #62, CC-6/CC-7).
   *
   * Until 6.0 each spawn's reported `total_cost_usd` was booked whole, and a
   * `--resume` reports the conversation's running total — so every resumed
   * phase re-booked its earlier spend, and a stored run's `spentUsd` is what a
   * Continue's budget and the spend pages read. `repriceFromLedger` re-books the
   * run from its own journal's `phase.session` lines, takes off only the
   * re-reported part, seeds each session's mark and stamps the model; the stamp
   * is what makes a second boot a no-op. `run.cost-repriced {before, after}` is
   * journalled on the run when its figure moved. A run this process is driving
   * is left to its runner, whose own bookings are already deltas; one whose
   * journal cannot be read is left for the next boot.
   */
  protected repriceStoredRuns(): void {
    if (!this.root?.ok) return;
    const root = this.root.path;
    const live = this.liveRunIds();
    const cents = (usd: number) => Math.round(usd * 100) / 100;
    let repriced = 0;
    for (const plan of this.store?.list() ?? []) {
      let runs: ReturnType<typeof listRuns> = [];
      try { runs = listRuns(root, plan.slug, live); } catch { continue; }
      for (const state of runs) {
        if ((state.costModel ?? 1) >= COST_MODEL || live.has(state.id)) continue;
        try {
          const journal = Journal.for(root, plan.slug, state.id);
          const result = repriceFromLedger(state, journal.read());
          if (!result) continue;
          saveRun(state);
          repriced += 1;
          if (Math.abs(result.before - result.after) < 0.005) continue;
          journal.append('run.cost-repriced', {
            before: cents(result.before), after: cents(result.after), costModel: COST_MODEL, sessions: result.sessions,
            phases: Object.fromEntries(Object.entries(result.phases)
              .map(([phase, moved]) => [phase, { before: cents(moved.before), after: cents(moved.after) }])),
          });
        } catch (error) {
          log.warn('run.reprice-failed', { slug: plan.slug, runId: state.id, error });
        }
      }
    }
    if (repriced) log.info('run.records-repriced', { runs: repriced, costModel: COST_MODEL });
  }

  /**
   * Bring every stored run kept under the old clock model to `CLOCK_MODEL`,
   * ONCE (control-tower phase 58, #66, EE-2).
   *
   * Until 6.0 only a phase's own attempts opened a window, so every resume,
   * repair, QA round, closeout, landing and review worked the phase and left no
   * time on its record — and the ETA, fitted on that record, learned a rate
   * nobody worked at (a phase finished by its closeout read 12.8 s). The
   * journal's `phase.session` lines carry each of those sessions' wall;
   * `remeasureFromLedger` adds them as closed windows and stamps the model, so a
   * second boot is a no-op. `run.clocks-remeasured {sessions, phases}` is
   * journalled on the run when a figure moved. A run this process is driving is
   * left to its runner, whose door now opens the windows itself; one whose
   * journal cannot be read is left for the next boot.
   */
  protected remeasureStoredRuns(): void {
    if (!this.root?.ok) return;
    const root = this.root.path;
    const live = this.liveRunIds();
    let remeasured = 0;
    for (const plan of this.store?.list() ?? []) {
      let runs: ReturnType<typeof listRuns> = [];
      try { runs = listRuns(root, plan.slug, live); } catch { continue; }
      for (const state of runs) {
        if ((state.clockModel ?? 1) >= CLOCK_MODEL || live.has(state.id)) continue;
        try {
          const journal = Journal.for(root, plan.slug, state.id);
          const result = remeasureFromLedger(state, journal.read());
          if (!result) continue;
          saveRun(state);
          remeasured += 1;
          if (!Object.keys(result.phases).length) continue;
          journal.append('run.clocks-remeasured', {
            clockModel: CLOCK_MODEL, sessions: result.sessions,
            phases: Object.fromEntries(Object.entries(result.phases)
              .map(([phase, moved]) => [phase, { before: Math.round(moved.before), after: Math.round(moved.after) }])),
          });
        } catch (error) {
          log.warn('run.remeasure-failed', { slug: plan.slug, runId: state.id, error });
        }
      }
    }
    if (remeasured) log.info('run.records-remeasured', { runs: remeasured, clockModel: CLOCK_MODEL });
  }

  /**
   * What the retention table would do right now, and what it found.
   *
   * The scan is shared by the sweep and by `GET /api/debug/retention`, so the
   * card an operator reads and the work the console does are the same list —
   * a card computed a second way is a card that is eventually wrong about the
   * thing it exists to promise.
   */
  retentionNow(): RetentionReport {
    const live: Record<string, string[]> = {};
    for (const runner of this.liveRunners()) {
      const current = runner.current();
      if (!current) continue;
      (live[current.slug] ??= []).push(current.id);
    }
    return retentionReport(
      collectRetention({
        instanceDir: INSTANCE_STATE_DIR,
        runsDir: this.root?.ok ? consoleRunsDir(this.root.path) : null,
        live,
        // Kept run worktrees (#75): the `project` root's trees, and every
        // tree's size as last measured off the loop — never a new scan of a
        // tree whose run is live (#171).
        projectWorktrees: this.root?.ok ? join(worktreesRoot(this.root.path), 'runs') : null,
        treeBytes: (dir, facts) => keptTreeBytes(dir, (tree) => treeDisk(tree), { live: facts?.live ?? false }),
      }),
      loadPrefs().retention,
      Date.now(),
    );
  }

  /**
   * Sweep every sink, then again once a day.
   *
   * After `sweepOldRuns`, never before: `pruneRuns` is what decides a run is
   * gone, and the global byte cap here is a floor UNDER that decision rather
   * than a second opinion about it. Running the cap first would delete the
   * sidecars of runs the per-plan rule was about to keep.
   *
   * `unref`'d like every other clock here, and daily rather than hourly
   * because nothing in the table moves faster than that: the two sinks that
   * can grow quickly (the supervisor's stdio, the console log) are bounded by
   * size, and a size bound crossed at noon costs one day of a bigger file, not
   * a full disk.
   */
  protected startRetentionClock(): void {
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    const tick = (): void => {
      if (this.fleetHold()) return;
      try {
        applyRetention(this.retentionNow().actions);
      } catch (error) {
        log.warn('retention.failed', { error: (error as Error).message });
      }
    };
    this.retentionTimer = setInterval(tick, RETENTION_SWEEP_MS);
    this.retentionTimer.unref?.();
    tick();
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
  /**
   * The digest's clock (control-tower phase 97, #140): hourly, and a tick with
   * the category off composes nothing. Unref'd like every console clock.
   */
  protected startDigestClock(): void {
    if (this.digestTimer) clearInterval(this.digestTimer);
    this.digestTimer = setInterval(() => {
      void this.digestTick().catch((error: unknown) => log.warn('digest.tick-failed', { error: (error as Error)?.message ?? String(error) }));
    }, DIGEST_EVERY_MS);
    this.digestTimer.unref?.();
  }

  /**
   * Compose and announce the digest, when its category is on (#140): Your turn
   * first (control-tower phase 138, #215 — how many items need the person, how
   * many a check sent back, how many things the AI handled since the last
   * digest), then every decision waiting with its deadline, every parked run,
   * every detection, and what the channel failed to deliver. Nothing to say
   * says nothing. Through `announce`, so the push, the notification inbox and
   * the webhooks all have it and every gate the other categories obey holds.
   */
  async digestTick(now = Date.now()): Promise<NotificationRecord | null> {
    if (!this.prefs.notify.digest) return null;
    const since = this.lastDigestAt;
    let turn: DigestTurn | null = null;
    try {
      const counted = await this.digestTurn(new Date(since ?? now - DIGEST_EVERY_MS).toISOString());
      turn = counted ? { ...counted, handledSince: since === null ? 'hour' : 'digest' } : null;
    } catch (error) {
      // An unreadable turn is a digest without its first line, never no digest.
      log.warn('digest.tick-failed', { part: 'turn', error: (error as Error)?.message ?? String(error) });
    }
    // Read after the turn's await: the category may have been switched off meanwhile.
    if (!this.prefs.notify.digest) return null;
    const digest = composeDigest({
      now,
      approvals: this.approvals.all()
        .filter((card) => card.status === 'pending' && card.kind !== 'question')
        .map((card) => ({ slug: card.slug, phase: card.phase, title: card.title, createdAt: card.createdAt, expiresAt: card.expiresAt })),
      parks: this.runStates()
        .filter((state) => state.status === 'parked' && state.halt)
        .map((state) => ({ slug: state.slug, phase: state.halt?.phase ?? null, reason: state.halt?.reason ?? 'parked' })),
      detections: this.digestDetections(),
      undelivered: this.undelivered.kept,
      undeliveredTotal: this.undelivered.lost,
      turn,
    });
    if (!digest) return null;
    this.undelivered = { kept: [], lost: 0 };
    const record = this.announce('digest', { title: digest.title, body: digest.body.slice(0, 1_500), tag: tagFor('digest', String(now)) });
    if (record) this.lastDigestAt = now;
    return record;
  }

  /**
   * ONE quiet-hours setting (control-tower phase 138, #215): the reminders'
   * own window (`reminderQuiet`, phase 43) — from a config written before the
   * change, or a page that still sends it — moves onto every push device that
   * has no window of its own (`migrateReminderQuiet`, `config.ts`); a device
   * with its own keeps it, and the key is never stored again. Idempotent: a
   * preference without the key moves nothing. Logged once per move as
   * `push.quiet-migrated`. Never throws — a window that could not move must not
   * cost a boot or a save.
   */
  protected adoptReminderQuiet(source: object): void {
    try {
      // `Prefs` no longer declares the key: it is read here, from what disk or a page holds, and nowhere else.
      const plan = migrateReminderQuiet(source as { reminderQuiet?: unknown }, this.push.list());
      if (!plan) return;
      for (const id of plan.devices) this.push.setQuiet(id, plan.quiet);
      if (source === this.prefs) {
        this.prefs = plan.prefs as Prefs;
        savePrefs(this.prefs);
      }
      log.info('push.quiet-migrated', {
        from: 'reminderQuiet', quiet: plan.quiet ?? 'malformed — dropped', devices: plan.devices.length, kept: plan.kept.length,
      });
    } catch (error) {
      log.warn('push.quiet-migrated', { from: 'reminderQuiet', error: (error as Error)?.message ?? String(error) });
    }
  }

  /**
   * Your turn, counted for the digest (control-tower phase 138, #215): the open
   * items that need the person, the ones a check sent back, and what the AI
   * handled since `since`. `Service` reads it from the page's own answer
   * (`turnAnswer`); null here, where there is no page to read.
   */
  protected async digestTurn(_since: string): Promise<Omit<DigestTurn, 'handledSince'> | null> {
    return null;
  }

  /**
   * What other parts of the console have detected and want in the digest — a
   * stalled lane, a session that stopped producing work. None yet: control-tower
   * phase 101 builds the detections and fills this seam.
   */
  protected digestDetections(): DigestDetection[] {
    return [];
  }

  /**
   * The channel answered again (#140, #108): the notifications it failed to
   * deliver meanwhile are said once, as a digest, with the first push that
   * arrives. Only while the digest is on — it is the digest's promise.
   */
  protected digestCatchUp(): void {
    if (!this.undelivered.lost || !this.prefs.notify.digest) return;
    const lost = this.undelivered;
    this.undelivered = { kept: [], lost: 0 };
    const digest = composeDigest({
      now: Date.now(), approvals: [], parks: [], detections: [], undelivered: lost.kept, undeliveredTotal: lost.lost,
    });
    if (digest) {
      this.announce('digest', { title: digest.title, body: digest.body.slice(0, 1_500), tag: tagFor('digest', 'undelivered') });
    }
  }

  protected startIssuesSweepClock(): void {
    if (this.issuesSweepTimer) clearInterval(this.issuesSweepTimer);
    this.issuesSweepTimer = setInterval(() => {
      if (this.fleetHold()) return;
      // A draft that has waited past its bound is said once more (#118). Local
      // and cheap — a ledger read per plan — so it rides this clock.
      this.reannounceIssueDrafts();
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
   * The run a verified hook token belongs to — the live one, else the run's own
   * STORED record.
   *
   * The live half alone was the whole lookup, and #21 is what that cost. A
   * child that outlives its console keeps working and keeps calling this hook;
   * the console adopts its token (`recoverApprovals`), so every call verifies —
   * and then resolved to nothing, was answered under the strictest profile with
   * no run context, and raised cards stamped `unknown` that nobody could
   * attribute. Ninety calls in forty-five minutes, each one a fact the console
   * was holding on disk and declining to read.
   *
   * So the record answers when no runner does: its own `permissionProfile`, its
   * plan's policy overlay and `permission.destructive` row, its relay state,
   * its slug and phase. Null now means what `hook.run-unknown` always claimed
   * it meant — no record on this machine explains this token.
   */
  protected runForToken(runId?: string | null): RunState | null {
    if (!runId) return null;
    for (const runner of this.liveRunners()) {
      const state = runner.current();
      if (state?.id === runId) return state;
    }
    return this.storedRunById(runId);
  }

  /**
   * Which plan's runs hold a given run id — remembered, because this question
   * is asked on a path that runs once per TOOL CALL.
   *
   * A run id belongs to exactly one plan for as long as its file exists, so a
   * hit is kept for the life of the process and re-asked only when the file it
   * names has gone (retention prunes). A MISS is re-asked on a short clock: the
   * scan is one `loadRun` per open plan, and a stale token calling in a loop
   * must not pay for all of them every time.
   */
  private readonly tokenPlan = new Map<string, { slug: string | null; at: number }>();

  /** The stored record for a run id, across every plan this console has open. */
  protected storedRunById(runId: string): RunState | null {
    if (!this.root?.ok) return null;
    const root = this.root.path;
    const live = this.liveRunIds();
    const memo = this.tokenPlan.get(runId);
    if (memo?.slug) {
      let state: RunState | null = null;
      try { state = loadRun(root, memo.slug, runId, live); } catch { state = null; }
      if (state) return state;
      // The file is gone — pruned, or the plan was closed and swept. Ask again.
      this.tokenPlan.delete(runId);
    } else if (memo && Date.now() - memo.at < TOKEN_PLAN_MISS_MS) {
      return null;
    }
    for (const record of this.store?.list() ?? []) {
      let state: RunState | null = null;
      try { state = loadRun(root, record.slug, runId, live); } catch { state = null; }
      if (state) { this.rememberTokenPlan(runId, record.slug); return state; }
    }
    this.rememberTokenPlan(runId, null);
    return null;
  }

  private rememberTokenPlan(runId: string, slug: string | null): void {
    this.tokenPlan.delete(runId);
    this.tokenPlan.set(runId, { slug, at: Date.now() });
    while (this.tokenPlan.size > TOKEN_PLAN_MAX) {
      const oldest = this.tokenPlan.keys().next();
      if (oldest.done) break;
      this.tokenPlan.delete(oldest.value);
    }
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
    console: { live: number; max: number };
    machine: { live: number; max: number | null } | null;
  } {
    const snapshot = this.scheduler.snapshot();
    return {
      // Both ceilings, named apart (FLT-7): this console's own `maxSessions`,
      // and the machine's — every console's live lanes against `fleet.json`
      // `maxSessions`. `max`/`live` stay the console's for older readers.
      console: { live: snapshot.live, max: snapshot.max },
      machine: snapshot.machine,
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
   * The attention inbox's `needs-you` count as it was last built, with when —
   * what the heartbeat reports to a fleet reader. Set by `attention()`; null
   * until the first build.
   */
  protected needsYouCount: { count: number; at: number } | null = null;

  /** The category of the first announcement that found no device at all — named once per process (FLT-1). */
  private noDeviceCategory: string | null = null;
  /** Tailscale as last asked under `--remote`; null until `checkDeliveryReachable` has asked. */
  private tailscaleFacts: DeliveryFacts['tailscale'] = null;

  /**
   * Judge the delivery channel again and set or withdraw the one
   * `push-broken` issue it owns. The same `probeDelivery` the run-start
   * prelude asks (phase 11), over the live register: a device that subscribes
   * after boot clears the row at once, rather than at the next restart.
   */
  refreshDeliveryIssue(): void {
    let verdict: ReturnType<typeof probeDelivery>;
    try {
      verdict = probeDelivery({
        devices: this.push.list().length,
        notifyCommand: Boolean(notifyCommand()),
        webhooks: this.webhooks.list().length,
        // Only once it has been asked: a console is not called unreachable on a
        // guess about a daemon nobody has probed yet.
        remote: (this.flags.remoteHosts?.length ?? 0) > 0 && this.tailscaleFacts !== null,
        tailscale: this.tailscaleFacts,
      });
    } catch {
      return;
    }
    const issue = deliveryIssue(verdict, this.noDeviceCategory);
    const at = this.environment.issues.findIndex((existing) => existing.id === DELIVERY_ISSUE_ID);
    const before = at >= 0 ? this.environment.issues[at] : null;
    if ((issue?.detail ?? null) === (before?.detail ?? null)) return;
    if (at >= 0) this.environment.issues.splice(at, 1);
    if (issue) this.environment.issues.unshift(issue);
    if (issue) log.warn('env.delivery-channel', { ok: false, reason: verdict.reason, category: this.noDeviceCategory });
    else log.info('env.delivery-channel', { ok: true, reason: verdict.reason });
  }

  /** The `--remote` half of the channel row: Tailscale running and serving this port. */
  async checkDeliveryReachable(): Promise<void> {
    if (!this.flags.remoteHosts.length) return;
    try {
      const status = await tailscaleStatus(this.flags.port);
      this.tailscaleFacts = status.state === 'running'
        ? { running: true, forOurPort: status.serve.forOurPort }
        : { running: false, forOurPort: false };
    } catch {
      this.tailscaleFacts = { running: false, forOurPort: false };
    }
    this.refreshDeliveryIssue();
  }

  /** The last `skillCopy()` answer and when it was read — `/api/state` is polled, the disk is not the news. */
  private skillCopyMemo: { at: number; report: SkillCopyReport } | null = null;

  /**
   * Which skill copy each Claude Code config dir's sessions load, against this
   * console's commit (control-tower phase 98, #151) — `skill-copy.ts`, the one
   * reader, cached for five seconds like `distRev()`. The doctor's row,
   * `/api/state`'s field, the inbox's health row and the boot prompt all read
   * this answer, so none of them can say a different thing about one copy.
   */
  skillCopy(): SkillCopyReport {
    const now = Date.now();
    if (this.skillCopyMemo && now - this.skillCopyMemo.at < 5_000) return this.skillCopyMemo.report;
    const report = skillCopyReport({ configDirs: claudeConfigDirs(), consoleRev: distRev() });
    this.skillCopyMemo = { at: now, report };
    return report;
  }

  /**
   * What the inbox's instance-health rows read (FLT-1 iv, FLT-6): this
   * console's delivery verdict and unread count, Tailscale under `--remote`
   * (the 30 s memo the Settings card reads), and every OTHER registered console
   * of the machine as the census sees it.
   */
  async inboxFleetFacts(): Promise<NonNullable<InboxFacts['fleet']>> {
    const delivery = probeDelivery({
      devices: this.push.list().length,
      notifyCommand: Boolean(notifyCommand()),
      webhooks: this.webhooks.list().length,
      remote: false,
    });
    let remote: InboxReach | null = null;
    if ((this.flags.remoteHosts?.length ?? 0) > 0) {
      const status = await tailscaleStatus(this.flags.port);
      remote = status.state === 'running'
        ? {
          running: true, forOurPort: status.serve.forOurPort, hosts: this.flags.remoteHosts,
          ...(status.serve.occupant ? {
            occupant: {
              port: status.serve.occupant.port,
              ...(status.serve.occupant.id ? { id: status.serve.occupant.id } : {}),
              ...(status.serve.occupant.name ? { name: status.serve.occupant.name } : {}),
            },
          } : {}),
        }
        : {
          running: false, forOurPort: false, hosts: this.flags.remoteHosts,
          ...(status.state === 'installed-not-running' && status.detail ? { detail: status.detail } : {}),
          ...(status.state === 'not-installed' ? { detail: 'not installed' } : {}),
        };
    }
    const siblings = census().rows
      .filter((row) => row.id !== INSTANCE.id && row.provenance !== 'state-only')
      .map((row) => ({
        id: row.id, name: row.name, root: row.root, liveness: row.liveness, discrepancies: row.discrepancies,
        unit: row.sources.unit, autostart: row.autostart, stopMarker: row.stopMarker,
        lastSeenAt: row.lastSeenAt, stoppedAt: row.stoppedAt,
      }));
    const facts: NonNullable<InboxFacts['fleet']> = {
      delivery: { ok: delivery.ok, reason: delivery.reason }, unread: this.notifications.unread(), remote, siblings,
      crashed: this.crashedBoot,
    };
    return facts;
  }

  /** `GET /api/instances` — the machine's census, the same report `phase-console list --json` prints. */
  instancesView(): ReturnType<typeof instancesView> {
    return instancesView();
  }

  /**
   * `GET /api/fleet/profile` — the machine profile as every console reads it,
   * and what THIS console runs with: each setting's value and its source
   * (`flag`, `env`, this console's `override`, or the machine `profile`).
   */
  fleetProfileView(): {
    profile: ReturnType<typeof fleetProfile>;
    console: {
      id: string;
      name: string;
      remoteHosts: string[];
      remoteUsers: string[];
      notifyCommand: boolean;
      maxSessions: number;
      machineMaxSessions: number | null;
      autostart: boolean | 'once';
      sources: NonNullable<Flags['profile']>['sources'];
      overridden: string[];
    };
  } {
    const profile = fleetProfile();
    return {
      profile,
      console: {
        id: INSTANCE.id,
        name: INSTANCE.name,
        remoteHosts: this.flags.remoteHosts,
        remoteUsers: this.flags.remoteUsers,
        notifyCommand: Boolean(notifyCommand()),
        maxSessions: this.flags.maxSessions,
        machineMaxSessions: profile.maxSessions ?? null,
        autostart: readAutostart(INSTANCE.id),
        sources: this.flags.profile?.sources ?? {},
        overridden: this.flags.profile?.overridden ?? [],
      },
    };
  }

  /** What this console's beat says about it (FLT-5, FLT-6, FLT-10). */
  protected heartbeatFacts(): HeartbeatFacts {
    return {
      port: this.flags.port,
      supervisor: supervisor().kind,
      lanes: { live: this.scheduler.snapshot().live, max: this.flags.maxSessions },
      needsYou: this.needsYouCount?.count ?? null,
      lastRemoteAt: accessLedger.lastRemoteAt(),
      build: { version: CONSOLE_VERSION, rev: distRev() },
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
   * Every live run's hinted-not-queued phases (control-tower phase 86, #128
   * #114) — `GET /api/queue`'s `hinted`, oldest hint first across runs. Read
   * off each live runner's own state through the one shared reader
   * (`hintedPhases`), never a copy of its rule.
   */
  queueHinted(): (HintedPhase & { slug: string; runId: string })[] {
    const rows: (HintedPhase & { slug: string; runId: string })[] = [];
    for (const runner of this.runners.values()) {
      const state = runner.current();
      if (!state) continue;
      for (const row of hintedPhases(state)) rows.push({ slug: state.slug, runId: state.id, ...row });
    }
    return rows.sort((a, b) => Date.parse(a.since) - Date.parse(b.since) || a.slug.localeCompare(b.slug) || a.phase - b.phase);
  }

  /**
   * Every lock claim this console can see, one row each, worst-first (#24) —
   * `GET /api/locks`. Read off the lock FILES now, not the store's scan, so a
   * row carries the branch and worktree the file says and a lapse is judged
   * on this instant's clock with the holder's presence (`server/locks.ts`).
   */
  lockRows(filter: LockFilter = {}): LockRow[] {
    return lockRows({
      locks: () => this.lockFilesNow(),
      title: (slug, phase) => {
        const plan = this.store?.get(slug)?.plan;
        return plan?.phases[phase]?.title || titleOf(plan?.graph ?? [], phase) || `Phase ${phase}`;
      },
      presence: (lock) => this.lockPresenceFor(lock),
      queue: () => this.scheduler.snapshot().entries,
      eta: (slug) => this.etaHint(slug),
      now: () => Date.now(),
    }, filter);
  }

  /** The lock files of every plan this console lists that is not closed, read now. */
  protected lockFilesNow(): Lock[] {
    // `handoffsDir` is only set when the folder existed at open; the first
    // claim in a fresh docs root creates it, and that claim must still show.
    const handoffsDir = this.root?.handoffsDir ?? (this.root?.docsDir ? join(this.root.docsDir, 'handoffs') : null);
    if (!handoffsDir) return [];
    const slugs = (this.store?.list() ?? []).filter((record) => !record.plan?.closed).map((record) => record.slug);
    return readLockFiles(handoffsDir, slugs);
  }

  /**
   * The one writer of `<instance state>/human-steps.ndjson` (control-tower
   * phase 41) — every door that records a person's turn goes through it.
   */
  humanStepsNow(): HumanStepLedger {
    // Every write is news to an open page (control-tower phase 42): the step,
    // as it now reads, rides the `human-step` event — a patch, never a refetch.
    return (this.humanStepLedger ??= new HumanStepLedger(join(INSTANCE_STATE_DIR, HUMAN_STEPS_FILE), undefined,
      (step) => { this.emit('human-step', { step }); this.stepChanged(step); }));
  }

  /** Told of every step the ledger writes, after the page is — the recovery half stops a check whose item settled (phase 134). */
  protected stepChanged(_step: HumanStep): void { /* nothing here */ }

  /**
   * The grant engine (control-tower phase 149, #212) — the ONE writer of a
   * rule on a person's behalf, and of `<instance state>/grants.ndjson`. What a
   * grant does once applied or ended (the journal, the push, the run's
   * settings, the items it covers) is the recovery half's (`grantApplied`,
   * `grantEnded`).
   */
  grantsNow(): Grants {
    return (this.grantLedger ??= new Grants({
      file: join(INSTANCE_STATE_DIR, GRANTS_FILE),
      // The engine reads the owner key itself: a caller's silence never skips the owner door.
      enrolled: () => ownerDoorMode() === 'enrolled',
      onApplied: (row) => this.grantApplied(row),
      onEnded: (row) => this.grantEnded(row),
    }));
  }


  /** A grant was applied — the recovery half journals it, announces it and acts on what it covers. */
  protected grantApplied(_row: GrantRow): void { /* nothing here */ }

  /** A grant ended — the recovery half journals it and raises the settings it lowered. */
  protected grantEnded(_row: GrantRow): void { /* nothing here */ }

  /** The console's clock for grants: what ran out, or whose phase settled, expires (phase 149) — how many ended. */
  protected sweepGrants(): number { return 0; /* the recovery half reads the runs */ }

  /**
   * The widen card's Allow (phase 9) is a grant since phase 149: the rule
   * struck from this plan's file BY THE ENGINE, with its row — never a policy
   * edit of its own. The card's answer brings the door it came through and
   * whether that door proved a fresh owner touch, and the engine judges the
   * strike by them: on a console with an owner key it is the owner's. True when
   * granted; else the engine's refusal — a never rule is never struck, whatever
   * a card says.
   */
  protected widenGrant(
    slug: string, rule: string, by: string,
    at: { runId?: string | null; phase?: number | null; card?: string | null; door?: string | null; fresh?: boolean } = {},
  ): true | string {
    const tool = parseRule(rule)?.tool ?? 'Bash';
    const applied = this.grantsNow().apply({
      scope: 'plan', wall: 'deny', tool, rule, family: ruleFamilyOf({ tool, rule }),
      slug, phase: at.phase ?? null, runId: at.runId ?? null, card: at.card ?? null, via: 'card', by, door: at.door ?? null,
      ...(typeof at.fresh === 'boolean' ? { fresh: at.fresh } : {}),
      reason: 'the widen card was allowed',
    });
    if (!applied.ok) log.warn('runner.widen-rule.failed', { slug, rule, error: applied.error });
    return applied.ok ? true : applied.error;
  }

  /**
   * Record a declared human step and inform a person ONCE: the ledger line,
   * one `needs-you` push naming the step's actions, the move to `notified`.
   * The inbox row is derived from the ledger, so it is one by construction.
   * Null when the declaration's step was not a step. Never throws — a person's
   * turn that could not be written must not cost the park it rides.
   */
  recordHumanStep(input: DeclareInput): HumanStep | null {
    const raised = this.raiseTurn(input);
    return raised && !('refused' in raised) ? raised : null;
  }

  /**
   * The one door into Your turn (control-tower phase 130, §Architecture 19):
   * the guard at ingest — a session's declaration held to G1, G2 and G4 against
   * its own run's policy — then the ledger, ONE item per wall (G7), one push.
   * A refusal raises nothing and says why; the caller parks the phase on it.
   */
  raiseTurn(input: DeclareInput, opts: { message?: TurnMessage } = {}): HumanStep | TurnRefused | null {
    try {
      const judge = input.judge !== undefined ? input.judge
        : input.birth === 'session' ? this.commandJudgeFor(input.runId ?? null) : null;
      // The one door (`turn/index.ts`, control-tower phase 132): ONE item per
      // source, and the item's ONE push — in the source's own words when it
      // brings them (an errand, a relayed question), under the item's tag.
      return raiseAtTheDoor(
        { ledger: this.humanStepsNow(), announce: (step) => this.announceHumanStep(step, 0, opts.message) },
        { ...input, judge },
      );
    } catch (error) {
      log.warn('human-steps.ledger-unwritable', { slug: input.slug, phase: input.phase, error: (error as Error)?.message ?? String(error) });
      return null;
    }
  }

  /**
   * The permission item a recorded wall is (control-tower phase 135, #212),
   * raised through the one door — the widen rung's ask, a refused push, a
   * declaration citing the wall. An item of the same wall still open for the
   * lane whose Grant presses ANOTHER card is withdrawn first: it would press a
   * card nobody holds any more. Answers the item's id, or null.
   */
  raisePermissionItem(input: {
    slug: string; runId: string; phase: number; sessionId?: string;
    wall: RecordedWall; need?: string | null; grant?: TodayGrant | null;
  }): string | null {
    try {
      const at = { slug: input.slug, runId: input.runId, phase: input.phase, ...(input.sessionId ? { sessionId: input.sessionId } : {}) };
      // A console with no owner key says so on a high item (phase 149).
      const raise = wallTurnInput(at, input.wall, {
        need: input.need ?? null, grant: input.grant ?? null, keyless: ownerDoorMode() === 'unenrolled',
      });
      const card = input.grant && 'approvalId' in input.grant ? input.grant.approvalId : null;
      const ref = (raise.step as { source?: { ref?: string } }).source?.ref;
      // An open item of this wall whose Grant presses a card nobody holds any
      // more — a new card is raised, or its own has been answered or expired —
      // is superseded rather than answered again with a dead button.
      const pending = new Set(this.approvals.pending().map((approval) => approval.id));
      const ledger = this.humanStepsNow();
      for (const open of ledger.open()) {
        const held = open.permission?.grant && 'approvalId' in open.permission.grant ? open.permission.grant.approvalId : null;
        if (held && open.birth === 'console' && open.slug === input.slug && open.phase === input.phase
          && (open.runId ?? '') === input.runId && open.source?.kind === 'wall' && open.source.ref === ref
          && (card ? held !== card : !pending.has(held))) {
          ledger.move(open.id, 'dismissed', { by: 'console', verb: 'dismiss', note: 'superseded — the card its Grant pressed is gone' });
        }
      }
      const raised = this.raiseTurn(raise);
      return raised && !('refused' in raised) ? raised.id : null;
    } catch (error) {
      log.warn('human-steps.ledger-unwritable', { slug: input.slug, phase: input.phase, error: (error as Error)?.message ?? String(error) });
      return null;
    }
  }

  /**
   * The declaring run's own permission policy as a command judge — what G4
   * asks "could the AI have run this itself?". Null when the run is unknown:
   * the guard never refuses on a guess.
   */
  protected abstract commandJudgeFor(runId: string | null): CommandJudge | null;

  /**
   * One credential, read by presence — `credentials-probe.ts`, uncached, so a
   * secret stored a moment ago is seen at the next check. Never the value.
   */
  protected credentialProbe(id: string): Promise<CredentialVerdict> {
    return probeCredential(id);
  }

  /**
   * The one push a human step gets — true when it was announced — and, from
   * control-tower phase 43, each REMINDER (`n` > 0), under the same tag so a
   * device holds one notification per step. Since phase 138 (#215) it opens
   * the item (`#/turn/<id>`), and its lock screen is what the `device` door
   * may press (`lockScreenOf`): an act's *Open* and *I did it*, a permission
   * item's *Allow* (its narrowest grant, where a device may make it) or *Open*,
   * and *Deny*; a decision's *Open*. Each signed verb is bound to the item's
   * inbox row (`answer`). A reminder is announced NOT urgent: it is a repeat,
   * never news, so it never breaks through a device's quiet hours.
   */
  protected announceHumanStep(step: HumanStep, n = 0, message?: TurnMessage): boolean {
    const screen = lockScreenOf(step);
    const facts = { ...step, label: KIND_META[step.kind].label, actions: screen.buttons };
    const push = n > 0 ? humanStepReminderPush(facts, n) : humanStepPush(facts);
    // A source that brings its own words (control-tower phase 132) says them
    // once, at the first push; every reminder is the item's.
    const words = n === 0 && message ? { ...message, detail: message.detail ?? push.message.detail } : push.message;
    const record = this.announce('needs-you', {
      ...words, tag: turnTagOf(step),
    }, {
      slug: step.slug, phase: step.phase, ...(step.runId ? { runId: step.runId } : {}), step: push.step, stepId: step.id,
      ...(screen.verbs.length ? {
        answer: {
          item: inboxItemId({ kind: 'human-step', slug: step.slug, phase: step.phase, runId: step.runId, subject: step.id }),
          verbs: screen.verbs,
        },
      } : {}),
    }, n > 0 ? { urgent: false } : {});
    return record !== null;
  }

  /** The reminder clock's pass (control-tower phase 43) — `ServiceRecovery.humanStepClockTick`. */
  protected abstract humanStepClockTick(now?: number): unknown;

  /** The due pass over upcoming acts (control-tower phase 121) — `ServiceRecovery.humanStepDuePass`. */
  protected abstract humanStepDuePass(now?: number): Promise<unknown>;

  /** An embedded terminal a human step opened has exited — its command's exit may prove the step. */
  protected abstract humanStepTerminalExited(id: string, code: number): Promise<unknown>;

  /** Items a live grant now covers, and supervisor items whose subject settled — withdrawn (phase 136, `ServiceRecovery`). */
  protected abstract turnCoveredPass(now?: number): string[];

  /** Items returned `turnEscalateAfter` times and not yet escalated — escalated once (phase 136, `ServiceRecovery`). */
  protected abstract turnEscalatePass(now?: number): string[];

  /** Open proofs the console reads, read again on their back-off — the ids proven (phase 136, `ServiceRecovery`). */
  protected abstract turnProofPass(now?: number): Promise<string[]>;

  /** The round (control-tower phase 136): made once, on the human-step clock. */
  protected turnRound: TurnRound | null = null;
  /** The handled log (control-tower phase 136): `<instance state>/handled.ndjson`. */
  protected handledLedger: HandledLedger | null = null;
  /** The journal hook the round and the handled log hear every run's lines through. */
  private journalHook: (() => void) | null = null;

  /** The one writer of `handled.ndjson`, made on first use. */
  handledNow(): HandledLedger {
    return (this.handledLedger ??= new HandledLedger(join(INSTANCE_STATE_DIR, HANDLED_FILE)));
  }

  /** Record a thing handled — a failure is logged, never thrown into the act it records. */
  protected recordHandled(input: HandledInput): HandledRow | null {
    try {
      const row = this.handledNow().record(input);
      if (row) count('turn_handled_total', [row.source]);
      return row;
    } catch (error) {
      log.warn('human-steps.ledger-unwritable', { file: HANDLED_FILE, error: (error as Error)?.message ?? String(error) });
      return null;
    }
  }

  /**
   * The round (control-tower phase 136, #213): the grants' clock, the reminder
   * clock's pass, the withdrawals, the escalations, the due pass and the
   * proofs, in that order (`turn/round.ts`) — and ONE server-sent event,
   * `turn`, when it changed the turn.
   */
  protected turnRoundNow(): TurnRound {
    return (this.turnRound ??= new TurnRound({
      grants: () => this.sweepGrants(),
      clock: (now) => this.humanStepClockTick(now) as { reminded: string[]; expired: string[]; dismissed: string[] },
      covered: (now) => this.turnCoveredPass(now),
      escalate: (now) => this.turnEscalatePass(now),
      due: (now) => this.humanStepDuePass(now) as Promise<{ due: string[]; proven: string[] }>,
      proofs: (now) => this.turnProofPass(now),
    }, {
      emit: (state: RoundState) => {
        count('turn_rounds_total', [state.trigger ?? 'clock']);
        this.emit('turn', { round: state.n, at: state.at, changed: state.last });
      },
      failed: (pass, error) => log.warn('human-steps.clock-failed', { error: (error as Error)?.message ?? String(error), pass }),
    }));
  }

  /** One line a run's journal wrote: a thing handled is recorded, and a round is woken. */
  protected onJournalLine(line: JournalLineSeen): void {
    const handled = handledOfJournal(line);
    if (handled) this.recordHandled(handled);
    this.turnRound?.poke(line.entry.event);
  }

  /**
   * The human-step clock, which drives the round: once a minute, unref'd like
   * every console clock, and a run's journal line wakes one too, debounced. A
   * pass that throws is logged and the round carries on.
   */
  protected startHumanStepClock(): void {
    this.turnRoundNow().start(HUMAN_STEP_CLOCK_MS);
    this.journalHook ??= onJournalAppend((line) => this.onJournalLine(line));
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

  /**
   * THE presence of a session that claimed a phase (#49) — one answer for the
   * inbox gate and the overdue resume (`declarerHold`), for admission and every
   * other reader of a lock's session (`lockPresenceFor`), and for the runner's
   * own check before a `--resume` (its `sessionPresence` dep). Readers asking
   * the registry separately is how the inbox called a declarer gone while
   * admission, two seconds later, queued the phase it re-boarded behind that
   * same declarer's lock — and the run waited on itself until it was stopped.
   *
   * The registry's word, with ONE fact laid over it. `ended` is the hook's
   * claim, and a `claude` that `/clear`s or resumes into a new session id ends
   * the OLD id while the process — and the lock the old id claimed — carry on.
   * The registry already answers such a record `unknown` when it can prove the
   * process is the same one (`procStartedAt`, #73); one it cannot prove stays
   * `ended` there, because a census must not revive a recycled pid. A claim is
   * different: its lease bounds a wrong answer, and a wrong `ended` frees a
   * live session's lock under it. So an `ended` record with no identity whose
   * pid still runs reads `unknown` here — nobody vouches either way, and the
   * lease decides.
   *
   * Since control-tower phase 108 (#172) the registry calls a `/clear`ed id
   * `ended` outright once its successor has started in the same process — the
   * SESSION is over, and the queue must stop waiting on it. Its CLAIM is not:
   * the person who cleared is still at that process, so while it runs the
   * lease decides here exactly as it did before (PRS-1).
   */
  protected declarerPresence(sessionId: string): { presence: Presence; pid?: number } {
    const seen = this.sessions.presenceDetail(sessionId);
    if (seen.presence !== 'ended' || !seen.pid) return seen;
    const record = this.sessions.get(sessionId);
    if (record?.supersededBy) {
      return this.sessions.processLive(record) ? { presence: 'unknown', pid: seen.pid } : seen;
    }
    // Identity was asked and answered: the process that ran it is gone.
    if (record?.procStartedAt) return seen;
    return this.sessions.pidLive(seen.pid) ? { presence: 'unknown', pid: seen.pid } : seen;
  }

  /**
   * Whether the session that wrote a declaration still holds its phase — the
   * presence read every resume of THAT session must pass first (REG-1).
   *
   * A session `declarerPresence` shows LIVE is still working: a hand session
   * that declared its wait and carried on, or one that took the phase over.
   * Arming a `--resume` of it would put a second `claude` on its transcript in
   * its working tree — the one act nothing can undo. `unknown` (no record, a
   * stale one, a stopped process, an ended id whose process still runs) falls
   * back to the lease: an unexpired lock naming that session says it still
   * holds the phase — the same lock admission would queue behind. `ended`, or
   * no session named at all, holds nothing. Returns what held it, or null.
   */
  protected declarerHold(
    slug: string, phase: number, sessionId: string | undefined,
  ): { why: 'session-live' | 'session-lease'; sessionId: string; pid?: number; lock?: string } | null {
    if (!sessionId) return null;
    const { presence, pid } = this.declarerPresence(sessionId);
    if (presence === 'live') return { why: 'session-live', sessionId, ...(pid ? { pid } : {}) };
    if (presence === 'ended') return null;
    const now = Date.now();
    const lock = this.allLocks().find((held) => held.slug === slug && held.phase === phase
      && held.session === sessionId && !lockLapsed(held, now));
    return lock ? { why: 'session-lease', sessionId, lock: lock.owner, ...(pid ? { pid } : {}) } : null;
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
  protected lockPresenceFor(lock: { owner: string; session?: string; slug?: string; phase?: number }): Presence {
    // 🔴 A run's lane is LIVE while its run holds that phase's grant or has the
    // lane's session running (control-tower phase 60, #82). It read `unknown`,
    // so the lock twin of a live foreign lane was cappable while its grant was
    // exempt: the two-hour cap parked healthy waits behind a refreshed lock,
    // and the park note carried its stale lease.
    if (this.lockHasLiveLane(lock)) return 'live';
    // `liveRunIds()` alone answered only for THIS console's runners, so every
    // lane of every other console on the same root fell through to the registry
    // — and got `ended`, because a lane's lock outlives its attempt's session.
    // Two consoles on one root therefore released each other's live claims
    // (S5-a). The run FILE settles it, through `runIsDead`, so both consoles
    // reach the same verdict from the same evidence.
    if (lockHeldByLiveRun(lock.owner, this.liveRunIds(), this.inFlightRuns())) return 'unknown';
    // The declarer's answer, not the registry's raw word (#49): the inbox gate
    // reads this same function, so it cannot call a claim free that admission
    // is about to queue behind.
    return lock.session ? this.declarerPresence(lock.session).presence : 'unknown';
  }

  /**
   * Is this an autopilot lane's lock whose run is working that phase right now
   * — holding its grant in this console's scheduler, or with the lane's session
   * alive in the run's own record (another console's lane)? See `lockPresenceFor`.
   */
  protected lockHasLiveLane(lock: { owner: string; slug?: string; phase?: number }): boolean {
    const runId = autopilotRunId(lock.owner);
    if (!runId || lock.phase == null) return false;
    let grants: readonly { runId: string; slug: string; phase: number | null }[] = [];
    try { grants = this.scheduler?.granted(runId) ?? []; } catch { grants = []; }
    return lockHasLiveLane(lock, grants, this.inFlightRuns());
  }

  /**
   * The runs that could still be holding a lane's lock — including other
   * consoles' — memoised for a beat.
   *
   * `lockPresenceFor` is called in loops (every lock, every admission scan,
   * every converge pass), and this walks the store. The window is short enough
   * that a run cannot start and finish inside it and long enough that one scan
   * reads the disk once.
   */
  private inFlightRunsMemo: { at: number; runs: RunState[] } | null = null;
  protected inFlightRuns(): RunState[] {
    const now = Date.now();
    if (this.inFlightRunsMemo && now - this.inFlightRunsMemo.at <= IN_FLIGHT_RUNS_TTL_MS) {
      return this.inFlightRunsMemo.runs;
    }
    const runs = this.watchableRuns().map(({ state }) => state);
    this.inFlightRunsMemo = { at: now, runs };
    return runs;
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
  /**
   * What the console's own record says of `<slug>`'s phase N (control-tower
   * phase 88, #129): the plan's live or latest run first; a phase no run of
   * this console holds answers from the board — a hand-driven phase has no
   * console §Verification to wait for. Null when neither can be read.
   */
  protected phaseDoneAnswer(slug: string, phase: number): { state: 'landed' | 'pending'; detail: string } | null {
    if (!this.root?.ok) return null;
    const state = this.runners.get(slug)?.current() ?? latestRun(this.root.path, slug, this.liveRunIds());
    const answer = phaseDoneOf(state?.phases?.[String(phase)]);
    if (answer) return answer;
    const board = this.boards.get(slug)?.settled;
    if (!board) return null;
    return board.done.includes(phase)
      ? { state: 'landed', detail: `phase ${phase} is done on the board (no run of it here)` }
      : { state: 'pending', detail: `phase ${phase} is not done on the board` };
  }

  /** Where `verify:<slug>/<N>` re-runs the phase's red lines, and what it reads them from (#129). */
  protected verifyLookup(slug: string, phase: number): VerifyLookup | null {
    if (!this.root?.ok) return null;
    const state = this.runners.get(slug)?.current() ?? latestRun(this.root.path, slug, this.liveRunIds());
    const record = state?.phases?.[String(phase)];
    if (!state || !record) return null;
    const planned = this.store?.get(slug)?.plan?.phases[phase];
    const tree = state.workRoot ?? state.root ?? this.root.path;
    return {
      record,
      cwd: resolve(tree, record.verifiedIn ?? planned?.verifyIn?.trim() ?? '.'),
      proofs: readProofs(proofsFile(this.root.path, slug), slug, phase),
      planLines: extractCommands(planned?.verification).commands,
    };
  }

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
      // The one answer admission reads (#49): a claim this census called free
      // while admission queued behind it would hand its tree to a second run.
      if (lockLapsed(lock, now, this.lockPresenceFor(lock))) continue;
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

  /**
   * The ONE peer predicate (REG-3): the sessions the registry shows `live` (or
   * `unknown` with a process behind them) in this repository, which could be
   * about to work `phase` — read at admission, at boarding and by the
   * classifier, independently of any lock.
   *
   * Every registry consultation on a decision path used to be reached THROUGH
   * a lock, so a session that had started and not yet claimed — the first
   * minute of every hand session, which is exactly when two sessions collide —
   * was invisible to the lane about to board beside it, and a person had to be
   * interrupted to ask whether a peer was on the phase. Left out, because
   * something else already speaks for each: the console's own lanes (an
   * `autopilot/<runId>` owner this console drives — its grant holds the scope),
   * a session strongly correlated to a DIFFERENT phase (its lock does), one
   * whose lock on THIS phase names it (the lock is the holder), probes, the
   * sessions named in `excluding`, and a session whose inferred scope is
   * disjoint from the phase's. What remains is a peer: a session correlated to
   * this phase with no lock, for as long as it lives; any other only inside its
   * claim window (`PEER_CLAIM_WINDOW_MS` after its newest start, reported as
   * `claimUntil`). That window is the whole of the case: a session that is
   * going to work a phase claims it, so one that started long ago and claimed
   * nothing is not about to — without the bound, every terminal a person left
   * open in the root held every phase in the repository.
   */
  peersInRepository(
    root: string,
    phase: { slug: string; phase: number } | null,
    excluding: readonly (string | undefined)[] = [],
    scope?: readonly string[],
  ): SessionPeer[] {
    let present: ReturnType<SessionRegistry['inRoot']>;
    try {
      present = this.sessions.inRoot(root, { excluding });
    } catch {
      return [];
    }
    if (!present.length) return [];
    const locks = this.allLocks();
    const liveIds = this.liveRunIds();
    const runs: RunLink[] = [];
    for (const state of this.runStates()) {
      for (const [key, record] of Object.entries(state.phases ?? {})) {
        runs.push({
          runId: state.id, slug: state.slug, phase: Number(key),
          ...(record.sessionId ? { sessionId: record.sessionId } : {}),
          ...(PHASE_IN_FLIGHT.includes(record.status) ? { active: true } : {}),
        });
      }
    }
    const wanted = scope?.length ? scope : phase ? (this.scopeOf(phase.slug, phase.phase) ?? ['all']) : ['all'];
    const now = Date.now();
    const out: SessionPeer[] = [];
    for (const record of present) {
      const ownerRun = /^autopilot\/([A-Za-z0-9._-]{1,64})$/.exec(record.owner ?? '')?.[1];
      if (ownerRun && liveIds.has(ownerRun)) continue;
      const plan = correlate(record, locks.map((lock) => ({
        slug: lock.slug, phase: lock.phase, owner: lock.owner, ...(lock.session ? { session: lock.session } : {}),
      })), now, runs) ?? null;
      if (plan && phase && plan.strong && (plan.slug !== phase.slug || plan.phase !== phase.phase)) continue;
      if (phase && locks.some((lock) => lock.slug === phase.slug && lock.phase === phase.phase && lock.session === record.sessionId)) continue;
      // Working THIS phase (strongly or weakly): a peer while it lives. Anything
      // else might be about to claim it only until its claim window shuts.
      const onThisPhase = Boolean(plan && phase && plan.slug === phase.slug && plan.phase === phase.phase);
      // An operator said this terminal is not working here (#119).
      if (holdReleasedAt(record, now)) continue;
      const read = this.sessionScope(record, root, now, locks);
      const claimUntil = onThisPhase ? null : read.leaseUntil ?? claimWindowEnds(record);
      if (claimUntil != null && now >= claimUntil) continue;
      // A session at work on THIS phase holds it whatever it touched; any other
      // holds what it touched here, and nothing once that is nothing.
      const peerScope = read.scope.length ? read.scope : onThisPhase ? [...wanted] : [];
      if (!peerScope.length || !scopesIntersect(peerScope, wanted)) continue;
      out.push({
        sessionId: record.sessionId,
        pid: record.pid ?? null,
        cwd: record.cwd,
        kind: record.kind,
        presence: record.presence,
        owner: record.owner ?? (record.user && record.host ? `${record.user}@${record.host}` : 'a Claude session'),
        scope: peerScope,
        plan,
        ...(claimUntil != null ? { claimUntil } : {}),
        basis: read.basis,
        ...(read.evidence.length ? { evidence: read.evidence } : {}),
      });
    }
    return out;
  }

  /**
   * The transcripts the peer feed reads, incrementally (#119) — and the reader
   * a lane's activity is read through, from the log's end (control-tower phase
   * 95, #138).
   */
  protected readonly transcripts = new TranscriptReader();
  /** Where each session's own log was found: a scan of `projects/*` is paid once, not per request. */
  private readonly sessionLogs = new Map<string, string>();

  /**
   * Where a session's own JSONL log is (control-tower phase 95, #138): the path
   * its presence hook reported (the registry's `transcript`), else the config
   * dir of the account that recorded it, else any account this console knows,
   * else the machine's own. Remembered while the file is there.
   */
  protected sessionLogOf(sessionId: string, accountId?: string): string | null {
    const known = this.sessionLogs.get(sessionId);
    if (known && existsSync(known)) return known;
    const dirs = new Set<string>();
    if (accountId) dirs.add(this.accounts.configDirFor(accountId));
    for (const id of this.accounts.accountIds()) dirs.add(this.accounts.configDirFor(id));
    dirs.add(this.accounts.configDirFor(undefined));
    const found = locateSessionLog(sessionId, { registryPath: this.sessions.get(sessionId)?.transcript, configDirs: [...dirs] });
    if (found) {
      this.sessionLogs.set(sessionId, found);
      if (this.sessionLogs.size > 256) this.sessionLogs.delete(this.sessionLogs.keys().next().value!);
    }
    return found;
  }

  /**
   * What a session holds in `root`, and why — `inferSessionScope` over its
   * declared `PE_SCOPE`, else what its transcript says it TOUCHED (control-tower
   * phase 82, #119). The cwd alone used to decide: a session opened in the root
   * was scope `all` for its whole life, whatever it worked on. Now the cwd is
   * only the bounded unknown lease of a session that has touched nothing yet,
   * and a session whose every touch is in another docs root holds nothing here.
   *
   * `locks` is what the caller already read (control-tower phase 108, #172): a
   * claim in the transcript holds only while its lock is still on disk and
   * unexpired, so a released lock's scope never lingers on the session that
   * claimed it — whoever released it.
   */
  protected sessionScope(record: SessionRecord, root: string, now = Date.now(), locks?: readonly LockView[]): InferredScope {
    return inferSessionScope({
      root,
      record,
      touches: this.transcripts.read(record.transcript),
      planScope: (slug, phase) => {
        const plan = this.store?.get(slug)?.plan;
        if (!plan) return undefined;
        return phase == null ? [] : this.scopeOf(slug, phase) ?? [];
      },
      ...(locks ? { lockHeld: (slug: string, phase: number) => locks.some((lock) => lock.slug === slug && lock.phase === phase && !lock.expired) } : {}),
      now,
    });
  }

  /** What a phase's Repos column says it touches. Undefined for an unknown plan. */
  /**
   * The machine's 5-minute load against the guard's factor (control-tower
   * phase 100, #135 G.27) — the same `os.loadavg()` the phase report and the
   * supervisor read; the factor is null when the guard is off.
   */
  loadSample(): { avg5: number; cores: number; factor: number | null } {
    return { avg5: loadavg()[1] ?? 0, cores: availableParallelism(), factor: loadGuardFactor(this.prefs) };
  }

  /** A plan's scheduling policy: its own, else the console's, else `seniority` (control-tower phase 100). */
  schedulingPolicyFor(slug: string): SchedulingPolicy {
    const own = this.prefs.schedulingPolicies?.[slug];
    return schedulingPolicy(isSchedulingPolicy(own) ? own : this.prefs.schedulingPolicy);
  }

  /** The plan's critical path over a board, in order — what the `critical-path` policy promotes. */
  criticalPathOf(slug: string, board: Board | null): number[] {
    const plan = this.store?.get(slug)?.plan;
    if (!plan || !board) return [];
    const rows = plan.graph ?? [];
    const sizes = new Map(rows.map((row) => [row.phase, plan.phases[row.phase]?.size ?? ('M' as const)]));
    return criticalPath(indexGraph(rows), board, sizes, this.sizing, resolveBudget(plan.sessionBudget.targetModel, this.sizing)).phases;
  }

  /**
   * Every lane a stopped run's record keeps for a phase stands again in the
   * scheduler (control-tower phase 100): a reservation outlives the console.
   * A live run's runner does the same for its own at its start.
   */
  protected registerStoredReservations(): void {
    if (!this.root?.ok) return;
    const live = this.liveRunIds();
    for (const record of this.store?.list() ?? []) {
      let state: RunState | null = null;
      try { state = latestRun(this.root.path, record.slug, live); } catch { state = null; }
      if (!state || live.has(state.id)) continue;
      for (const phase of Object.values(state.phases)) {
        const kept = phase?.queueControl?.reserve;
        if (!kept || phase.status === 'done' || phase.status === 'skipped') continue;
        this.scheduler.reserveLane({
          slug: state.slug, runId: state.id, phase: phase.phase, at: kept.at, by: kept.by,
          ...(kept.reason ? { reason: kept.reason } : {}), ...(kept.lane ? { lane: kept.lane } : {}),
        });
      }
    }
  }

  protected scopeOf(slug: string, phase: number): string[] | undefined {
    const row = this.store?.get(slug)?.plan?.graph.find((r) => r.phase === phase);
    return row ? scopeOfRow(row.repos) : undefined;
  }

  /** One connectivity probe for every run this console starts (control-tower phase 80, #108). */
  private outageProbe: ConnectivityProbe | null = null;
  /** One memory of a drifting price for every run this console starts (control-tower phase 109, #202). */
  private costDrift: CostDrift | null = null;

  private makeRunner(): Runner {
    const flags = this.flags;
    return new Runner({
      scriptsDir: flags.scriptsDir,
      approvals: this.approvals,
      scheduler: this.scheduler,
      // The plan's scheduling policy and its critical path (control-tower phase 100).
      schedulingPolicy: (slug) => this.schedulingPolicyFor(slug),
      criticalPath: (slug, board) => this.criticalPathOf(slug, board),
      // What a lane waiting out an outage asks "is the API back?" — phase 76's
      // probe, one per console, so a dozen waiting lanes cost one look a minute.
      connectivity: (this.outageProbe ??= new ConnectivityProbe()),
      // One memory of a drifting price for every run (control-tower phase 109,
      // #202): a drift is announced once a day, not once per run.
      costDrift: (this.costDrift ??= new CostDrift()),
      // The panic button, for the one auto-start the runner owns that the
      // scheduler cannot see — the park poke. See `RunnerDeps.fleetHold`.
      fleetHold: () => this.fleetHold(),
      maxParallel: () => this.flags.maxSessions,
      // The word on a lock's session, for the boarding belt-check: an ended
      // session's claim is released and boarding goes on. The SAME reader the
      // scheduler's admission asks (`lockPresenceFor` → `declarerPresence`,
      // #49) — it read the raw registry, so the belt-check could release as
      // debris a claim admission had just queued behind.
      lockPresence: (lock) => this.lockPresenceFor(lock),
      // A session's own presence, for the resume gate. This console's own lanes
      // never reach it as `live`: a lane's session has exited by the time
      // anything resumes it, and its pid probe says so (REG-1).
      sessionPresence: (sessionId) => this.declarerPresence(sessionId),
      // The peer belt-check at boarding (REG-3) — the same predicate admission
      // read, for the grant→spawn window.
      peers: (slug, phase, excluding) => (this.root?.ok ? this.peersInRepository(this.root.path, { slug, phase }, excluding) : []),
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
      // Every session's caps, measured from this console's own sessions
      // (control-tower phase 59, #83); the shipped table until the census lands.
      sessionCaps: () => this.sessionCapTable(),
      // The per-day cap's denominator. The runner cannot compute it — it sees
      // one run, and the cap is about the machine.
      dayHistory: () => this.dayRungs(),
      unblockAttempts: () => this.prefs.unblockAttempts !== false,
      // Opt-in, and absent means no: a phase with no §Verification parks
      // until an operator says the handoff alone is proof enough.
      allowUnverifiedPhases: () => this.prefs.allowUnverifiedPhases === true,
      // A phase's reds are judged against what its lines read on the tree it
      // boarded on (control-tower phase 83, #103): a red already there is
      // inherited, never charged to it.
      verifyBaseline: () => true,
      // …measured beside the session since control-tower phase 105, and held
      // by the same machine-load guard that holds new admissions (phase 100).
      machineLoad: () => this.scheduler.loadReading(),
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
      // A person's turn (control-tower phase 41): the ledger, the one push.
      humanStep: (input) => this.raiseTurn(input),
      // A watchdog park arms a minted cmd: ref only when it will run (#121 item 3).
      mintedCmdRefs: () => this.flags.allowRun && this.prefs.watchMintedCmdRefs === true,
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
      // …and the same cell as FULL paths, which is what the working tree is
      // asked at (control-tower phase 45, #60): `shop/shop-web`, not the
      // `shop` the name view truncates it to.
      phaseRepoDirs: (slug, phase) => this.scopeOf(slug, phase),
      // The same cell, read as SCOPE: what admission decides on and what the
      // child is told it holds. Kept separate from `phaseRepos` above so a
      // cosmetic hint can never become the thing concurrency rests on.
      phaseScope: (slug, phase) => this.scopeOf(slug, phase),
      // …and for what it should run as. These bullets have been in the plan
      // format from the start; until now nothing read them.
      phaseDefaults: (slug, phase) => {
        const plan = this.store?.get(slug)?.plan;
        const detail = plan?.phases[phase];
        if (!detail) return undefined;
        // The permission mode is the phase's bullet, else the plan's line —
        // one level to the runner (`resolvePermissionMode`'s `plan`), both
        // read by `permissionModeFor` exactly as `--permission-mode N` prints.
        const mode = permissionModeFor(plan, phase)?.value;
        // …and the model policy the same way (#91): the bullet, else the line.
        const modelPolicy = modelPolicyFor(plan, phase)?.value;
        return {
          model: modelAlias(detail.model), effort: effortOf(detail.effort),
          ...(mode ? { permissionMode: mode } : {}), ...(modelPolicy ? { modelPolicy } : {}),
        };
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
      // The credentials the PLAN names for a phase and its policy for a missing
      // one (phase 11, ZTD-4) — read from the parsed plan like `planMcp`, held
      // to `phase-graph.sh --credentials N` by `engine-parity.test.ts`.
      planCredentials: (slug, phase) => {
        const plan = this.store?.get(slug)?.plan;
        return { ids: credentialsFor(plan, phase), policy: credentialPolicyFor(plan, phase) ?? null };
      },
      // …and whether they are held, by id, through the one registry the
      // prelude and `doctor` read (memoised, never a value).
      credentialsHeld: (ids) => credentialsHeld(ids, { cwd: this.root?.path }),
      // The plan's answer once the QA round budget is spent (phase 11, ZTD-9).
      planQaExhausted: (slug) => this.store?.get(slug)?.plan?.sessionBudget.qaExhausted,
      // …and a phase's answer for a §Verification fragment written as prose (ZTD-6).
      personCheck: (slug, phase) => personCheckFor(this.store?.get(slug)?.plan, phase),
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
        transportOf: (id) => this.mcp.resolve([id]).servers[0]?.transport,
      },
      // The plan's Branch prose and title, for the git-strategy block: the
      // prose is read only to WARN on a mismatch, the title names the PR.
      planBranch: (slug) => this.store?.get(slug)?.plan?.sessionBudget.branch,
      planWorktrees: (slug) => this.store?.get(slug)?.plan?.sessionBudget.worktrees,
      // The plan's own base branch, unresolved: `resolveBase` turns the word
      // into a commit, and only the runner knows which repository to ask.
      planBaseBranch: (slug) => this.store?.get(slug)?.plan?.sessionBudget.baseBranch,
      // Through the parser's own resolver, never a second read of the bullet:
      // one reading, so the console cannot draw one answer and act on another.
      planIsolation: (slug, phase) => isolationFor(this.store?.get(slug)?.plan, phase)?.value,
      // The landing words (many-plans-one-repo phase 8), through the parser's
      // resolvers — the same reading `phase-graph.sh --land/--gitlink/
      // --conflict-policy` gives, held to it by `engine-parity.test.ts`.
      // `landing` and `conflictPolicy` answer only what the PLAN said (a phase
      // bullet or the plan line), never the vocabulary's default: silence is
      // what lets the run's own word speak (phase 15 — `RunState.landing` /
      // `conflictPolicy`), and the runner reads the default after both.
      planLand: (slug, phase) => stated(landFor(this.store?.get(slug)?.plan, phase)),
      planGitlink: (slug, phase) => gitlinkFor(this.store?.get(slug)?.plan, phase).value,
      planConflictPolicy: (slug) => stated(conflictPolicyOf(this.store?.get(slug)?.plan)),
      planPublishes: (slug) => this.planPublishes(slug),
      // May the console push THIS run's branches: `--allow-publish` AND the
      // plan's `permission.destructive` row naming `git push` (the leaf
      // service answers; the base knows neither the flag's meaning nor the row).
      publishAllowed: (state, phase) => this.publishAllowedFor(state, phase),
      // The phases whose gate reads `pr-merged <phase>` / `landed <phase>`,
      // and the graph's `Depends on` — both off the parsed plan.
      landingDependents: (slug, phase) => {
        const plan = this.store?.get(slug)?.plan;
        if (!plan) return [];
        const re = new RegExp(`^(?:pr-merged|landed)\\s+${phase}(?:\\s|$)`, 'i');
        return Object.values(plan.phases)
          .filter((detail) => re.test((detail.gateCheck ?? '').trim()))
          .map((detail) => detail.phase)
          .filter((p): p is number => Number.isInteger(p));
      },
      phaseDependencies: (slug, phase) => {
        const row = this.store?.get(slug)?.plan?.graph.find((r) => r.phase === phase);
        return row ? [...row.dependsOn] : [];
      },
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
        maxPerRepo: this.prefs.maxConcurrentPerRepo,
        retention: this.prefs.worktreeRetention,
        baseBranch: this.prefs.baseBranch,
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
      // Every run this console is driving right now, across every plan — the
      // question a Runner cannot ask, because it sees only its own (SWP-2).
      // `inFlightRuns()` is folded in beside the live loops for the same reason
      // `lockPresenceFor` reads it: a run between phases holds its checkout and
      // is not behind a live loop at that instant.
      liveRunIds: () => new Set([...this.liveRunIds(), ...this.inFlightRuns().map((run) => run.id)]),
      // Every plan in the library, so `runBranches` can tell a lane branch from
      // another PLAN's run branch before deleting it (SWP-1).
      knownSlugs: () => (this.store?.list() ?? []).map((record) => record.slug),
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
      // Who else is spending each account: the presence registry's live
      // sessions, matched by the config dir their hook reported. A token
      // account's credential is not its dir, so it names no sessions.
      nonRunSessions: () => sessionsByAccount(
        this.sessions.views(),
        this.accounts.accountIds()
          .filter((id) => this.accounts.meta(id)?.kind !== 'token')
          .map((id) => ({ accountId: id, configDir: this.accounts.configDirFor(id) })),
      ),
      // The resource ladder: the ranked candidates the auth preflight probes
      // one by one, and the three knobs, read live from prefs so Settings
      // applies to the next wall rather than the next run.
      rankAccounts: (excluding, forModel) => this.accounts.rankAccounts(excluding, forModel),
      // The console's commit and the skill a session of the run loads: the
      // plugin copy of the config dir its account spawns under (#151).
      consoleSkill: (accountId) => {
        const copy = sessionSkillCopy(this.accounts.configDirFor(accountId));
        return {
          consoleRev: this.skillCopy().consoleRev,
          skill: copy?.install ? { configDir: copy.configDir, commit: copyCommit(copy), installPath: copy.install.installPath } : null,
        };
      },
      // The wall's own picker (control-tower phase 78, #100): the rank inside
      // the pool, less every account that would wall before the reset.
      switchCandidates: (excluding, forModel, opts) => this.accounts.switchCandidates(excluding, forModel, opts),
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
        // Forwarded at last: without it the runner always read the shipped 45
        // minutes, whatever Settings said.
        stallLocalJobMs: this.prefs.stallLocalJobMs,
        stallLoopRun: this.prefs.stallLoopRun,
      }),
      // The watchdog's own park, switchable off (SLF-9, KNOWN-SINCE).
      stallAutomaticPark: () => this.prefs.stallAutomaticPark !== false,
      onMcpRequireTimeout: (state, phase, result) => this.announceMcpTimeout(state, phase, result),
      // The preflight probe, under the RUN's account env. Signed out, the
      // refusal names the account and the exact command that fixes it —
      // composed here, where the config dir is known, never in the browser.
      checkAuth: async (accountId) => {
        const env = await this.accounts.envFor(accountId);
        const root = this.root?.ok ? this.root.path : process.cwd();
        const status = await checkAuthFor(root, env, accountId ?? 'default', true);
        // The organisation the probe named is the breaker's key — learned
        // machine-wide, so a token account (no `.claude.json` to read) still
        // gets one (ACT-8).
        this.accounts.noteAuthProbe(accountId, status);
        // Every kind, the machine login included (control-tower phase 13,
        // #33): the account every console has without registering anything,
        // and the one most runs spend, was the one this sentence skipped. The
        // fix is the one `loginFix` sentence the account card speaks too.
        if (!status.loggedIn) {
          return {
            ...status,
            detail:
              `the run is set to pay as ${this.accounts.labelFor(accountId)} and that login is ` +
              `expired or signed out — ${this.accounts.signInFix(accountId)}, or sign it in from Settings → ` +
              `Claude accounts.${status.detail ? ` (${status.detail})` : ''}`,
          };
        }
        return status;
      },
      // The one helper (ACT-5, SES-2): the facade writes the account's fact
      // machine-wide and answers what to hold; the runner throttles and
      // journals from the answer. A wall is announced under `limits` as it
      // always was; a RETIREMENT is announced too — it is the account fact
      // that costs the most to discover twice.
      leaveAccount: (accountId, leaving) => {
        // A credential refusal goes through `retire` — the one door onto the
        // breaker's `retired`, the same one phase 11's prelude probe will use
        // with an explicit orgId; the classifier is account-blind, so the
        // organisation is whatever the learned store already knows.
        const result = leaving.kind === 'credential'
          ? this.accounts.retire(accountId, undefined, leaving.reason, leaving.by, leaving.class)
          : this.accounts.leaveAccount(accountId, leaving);
        const name = this.accounts.labelFor(accountId);
        if (leaving.kind === 'usage' && !leaving.perModel) {
          this.announce('limits', {
            title: `Usage limit hit — ${name}`,
            body: leaving.reason,
            tag: tagFor('limits', result.accountId, leaving.bucket ?? 'window', result.until ?? 'unknown'),
          });
        } else if (leaving.kind === 'credential') {
          this.announce('limits', {
            title: `Account retired — ${name}`,
            body: `${leaving.reason}. The console will not start work as ${name}`
              + `${result.orgId ? ' or any account in its organisation' : ''} until you clear it under Settings ▸ Accounts.`,
            tag: tagFor('limits', 'retired', result.accountId),
          });
        }
        return result;
      },
      // The quota door's verdict (ACT-2) — read from cache, never thrown; the
      // runner climbs or parks on it beside the auth door.
      accountHeadroom: (accountId, forModel) => this.preflightAccount(accountId, forModel),
      // A session that spent under the account and ended well lifts its walls
      // and cooling (#78, control-tower phase 54); the runner re-reads the
      // phases it holds parked on them. The re-probe's poll is the same read
      // the panels' Refresh asks for.
      noteSpend: (accountId, model) => this.accounts.noteSpend(accountId, model),
      refreshUsage: (accountId) => this.accounts.refreshUsage(accountId),
      // What the drive loop's own `switch-account` rung weighs a target
      // against the walled account with (control-tower phase 79, #98) — the
      // same room the operator's switch reads, so neither moves a run onto less.
      accountRoom: (accountId, forModel) => this.accounts.roomOf(accountId, forModel),
      // Credits carry an account past its plan windows (control-tower phase
      // 93, #146): the runner's 95 % decision and live wall read this bit, and
      // each session's overage fields go back to the account it spends.
      creditCarries: (accountId) => this.accounts.creditCarries(accountId),
      noteSessionCredit: (accountId, info) => this.accounts.noteSessionCredit(accountId, info),
      // How long the ladder pass trusts "unchanged since I climbed it" (#114):
      // the healer's own cadence, read live. Zero is converge's OFF switch,
      // never a zero expiry — that would re-climb every record on every tick.
      ladderSeenTtlMs: () => {
        const every = this.prefs.convergeEveryMs ?? 0;
        return every > 0 ? every : LADDER_SEEN_TTL_MS;
      },
      // How many accounts the breaker refuses, out of how many there are — the
      // one fact "halted, the API refused this credential" could not say, and
      // the one that decides whether switching accounts is even an option.
      accountsUsable: () => this.accountsUsable(),
      // Who each account answers now (control-tower phase 91, #131): a run binds
      // to it at start and compares it before every boarding.
      identityOf: (accountId) => this.accounts.identityOf(accountId),
      // The healer's availability, for the loop's own exhaustion predicate
      // (LFC-2, phase 10): a rung the loop cannot drive but the healer can is
      // deferred; one neither can drive is exhausted, with the reasons.
      // `state` is null here — the loop asks about its OWN run, whose record
      // it holds; the vehicles that need the run answer from the record and
      // the meters alone, which is the conservative reading.
      rungDrivable: (slug, rung, situation, record, evidence, state) =>
        this.vehicleForRung(rung, situation, record, evidence, slug, state) !== null,
      rungUnavailable: (slug, situation, record, evidence, state) =>
        this.unavailableRungHint(situation, record, evidence, slug, state),
      // The `widen-rule` rung's two acts (phase 9, TRS-10): strike the deny
      // rule for this plan once a person approved the card, and — when the
      // loop that offered it has since ended — resume the phase's own session
      // through the recover verb, which is the stopped-run door.
      // The widen card's Allow is a grant (control-tower phase 149): the rule
      // struck from this plan's file by the engine, with its row.
      widenRule: (slug, rule, by, at) => this.widenGrant(slug, rule, by, at),
      // A run's grants below plan scope, lowered in the settings its next child loads.
      grantsLowered: (runId) => this.grantsNow().lowered(runId),
      resumeOwnSession: (slug, phase, instruction, by) => {
        void this.recoverPhase(slug, phase, 'resume', { instruction, by }).catch((error) => {
          log.warn('runner.widen-rule.resume-failed', { slug, phase, error });
        });
      },
      // The widen rung's ask is a permission ITEM (control-tower phase 135).
      raisePermission: (input) => this.raisePermissionItem(input),
      accountKind: (accountId) => this.accounts.meta(accountId ?? DEFAULT_ACCOUNT_ID)?.kind,
      // A person's switch undone by the machine (#106) is never silent.
      onAccountSwitchReverted: (state, detail) => this.announceReversal(state, detail),
      onLiveWallEscalated: (state, phase, detail) => {
        const name = this.accounts.labelFor(state.accountId);
        this.announce('limits', {
          title: detail.action === 'wait'
            ? `Usage wall — ${state.slug} phase ${phase} waits for the window`
            : `Usage wall — ${state.slug} phase ${phase} is parked`,
          body: `${name}: ${detail.reason}. No other account has headroom`
            + (detail.until ? `; the phase resumes at ${new Date(detail.until).toLocaleString()}.` : ' and the wall reported no reset time.'),
          tag: tagFor('limits', 'live-wall', state.id, String(phase)),
        });
      },
      // The CLI version the floor flag is judged against (`permissionPromptsFor`):
      // one memoised `claude --version`, shared with the transcript port.
      cliVersion: () => cliVersion(),
      // The relay's floor (phase 14): read from the newest `system/init` any
      // session on this console reported, and remembered for the next spawn.
      initVersion: (binary) => initVersionFor(binary),
      noteCliInit: (version, binary) => noteCliInit(version, binary),
      portTranscript: (sessionId, fromAccount, toAccount) =>
        portTranscript(
          sessionId,
          this.accounts.configDirFor(fromAccount),
          this.accounts.configDirFor(toAccount),
          this.cliVersionSeen ? { cliVersion: this.cliVersionSeen } : {},
        ),
      onEvent: (event, data) => this.onRunnerEvent(event, data),
      // The ceiling, for the two starts the runner owns and for the dollars
      // every session reports (`spawnSession` charges them as it ends).
      startCeiling: {
        admit: (actor) => this.startCeiling.admit(actor),
        charge: (actor, slug) => this.startCeiling.charge(actor, slug ?? null),
        spendUsd: (usd) => this.startCeiling.spendUsd(usd),
        shouldAnnounce: (refusal) => this.startCeiling.shouldAnnounce(refusal as CeilingRefusal),
      },
    });
  }

  /**
   * May this automatic start happen? A press always may. A refusal is written
   * where a reader will look — `run.start-refused` on the run when there is
   * one, `start-ceiling.refused` on the console log otherwise — and announced
   * on `health` ONCE per window, since the second refusal in the hour is the
   * same fact. Returns the refusal (never throws) so each door can decline in
   * its own way: `startRun` throws it, the probe skips, the reviewer notes.
   */
  protected admitStart(actor: Actor, slug: string | null, runId: string | null): CeilingVerdict {
    const verdict = this.startCeiling.admit(actor);
    if (verdict.ok) return verdict;
    const payload = { ...actor, ceiling: verdict.ceiling, limit: verdict.limit, count: verdict.count, until: verdict.until };
    if (slug && runId && this.root?.ok) {
      try { Journal.for(this.root.path, slug, runId).append('run.start-refused', payload); } catch { /* the log line below still says it */ }
    }
    log.warn('start-ceiling.refused', { slug, runId, ...payload });
    if (this.startCeiling.shouldAnnounce(verdict)) {
      this.announce('health', {
        title: `Start ceiling reached — ${verdict.ceiling === 'startsPerHour' ? `${verdict.count} automatic starts` : `$${verdict.count.toFixed(2)} of session spend`} in the last hour`,
        body: ceilingSentence(verdict),
        tag: tagFor('health', 'start-ceiling', verdict.until),
      });
    }
    return verdict;
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
  /**
   * What the permission policy in force can be warned about, with whether
   * the operator has acknowledged each against its current rule set. Pure
   * over the merge and the strikes at one scope — the global policy, or a
   * plan's merged view — and read on every `GET /api/policy`.
   */
  policyAdvisories(slug: string | null = null): (PolicyAdvisory & { acknowledged: boolean; fingerprint: string })[] {
    const acks = readAdvisoryAcks();
    return policyAdvisory(loadPolicyFor(slug), struckFor(slug)).map((advisory) => {
      const fingerprint = advisoryFingerprint(advisory);
      return { ...advisory, fingerprint, acknowledged: acks[advisory.kind] === fingerprint };
    });
  }

  /**
   * The operator has read it: recorded against the rule set it named, so the
   * same advisory over a CHANGED set (one more strike) stands again. `true`
   * when the kind currently stands; a kind that does not is nothing to
   * acknowledge and answers `false`.
   */
  acknowledgePolicyAdvisory(kind: string): boolean {
    const standing = this.policyAdvisories().find((advisory) => advisory.kind === kind);
    if (!standing) return false;
    const acks = readAdvisoryAcks();
    acks[kind] = standing.fingerprint;
    mkdirSync(join(ADVISORY_ACK_FILE, '..'), { recursive: true });
    writeFileSync(ADVISORY_ACK_FILE, `${JSON.stringify({ version: 1, acknowledged: acks }, null, 2)}\n`, 'utf8');
    log.info('policy.advisory-acknowledged', { kind, rules: standing.rules.length });
    return true;
  }

  /**
   * Once per boot: log every standing advisory (`policy.advisory {kind,
   * rules}`) and announce the unacknowledged ones on the health channel. The
   * log line is the console's record and is never suppressed; the announce
   * is skipped under a test runner like the environment doctor's, because it
   * reads the AMBIENT policy files. Returns what it logged, for the caller
   * that wants to know.
   */
  protected announcePolicyAdvisories(quiet = false): PolicyAdvisory[] {
    if (this.policyAdvisoryAnnounced) return [];
    this.policyAdvisoryAnnounced = true;
    let standing: ReturnType<ServiceBase['policyAdvisories']>;
    try {
      standing = this.policyAdvisories();
    } catch (error) {
      log.warn('policy.advisory-unread', { error: (error as Error).message });
      return [];
    }
    for (const advisory of standing) {
      log.warn('policy.advisory', { kind: advisory.kind, rules: advisory.rules, acknowledged: advisory.acknowledged });
      if (advisory.acknowledged || quiet) continue;
      this.announce('health', {
        title: advisory.kind === 'ask-empty' ? 'No run here asks about anything' : 'The deny wall has been struck',
        body: `${advisory.message} Settings ▸ Permissions shows the rules and takes the acknowledgement.`,
        tag: tagFor('health', `policy-advisory-${advisory.kind}`),
      });
    }
    return standing;
  }

  /**
   * A switch moved a run back onto the account a person had moved it away from
   * (control-tower phase 78, #106) — announced under `limits`, whether the
   * runner's own wall or the ladder's rung on a stopped run did it: a person's
   * choice undone in silence is how #106 was found, by reading the journal.
   */
  protected announceReversal(
    state: Pick<RunState, 'id' | 'slug'>,
    detail: { from: string; to: string; choice: { at: string; by: string }; reason: string },
  ): void {
    this.announce('limits', {
      title: `Account switch reversed — ${state.slug}`,
      body: `${detail.choice.by} moved ${state.slug} off ${this.accounts.labelFor(detail.to)} at `
        + `${new Date(detail.choice.at).toLocaleString()}; it is back on it now, because `
        + `${this.accounts.labelFor(detail.from)} is walled (${detail.reason.slice(0, 160)}).`,
      tag: tagFor('limits', 'switch-reverted', state.id, detail.choice.at),
    }, { slug: state.slug, runId: state.id });
  }

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
      /** Land on a Tower bay rather than the run — a supervisor's card (control-tower phase 102). */
      bay?: 'needs-you' | null;
      /** The item a push is about — it opens `#/turn/<id>` (control-tower phase 138). */
      stepId?: string | null;
      /** The grant a `granted` push announces — it opens Settings ▸ Permissions ▸ Grants at it (phase 138). */
      grantId?: string | null;
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
      /** A human step's payload block (control-tower phase 41) — `humanStepPush`. */
      step?: HumanStepPush;
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
    // Minted before the record, so the bell drawer offers the same buttons
    // the phone does, answered by the same one-shot token (phase 25).
    const callback = context.answer ? mintActionToken(context.answer.item, context.answer.verbs) : null;
    const buttons = callback ? notificationButtons(context.answer!.verbs) : [];
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
      ...(callback && buttons.length ? { actions: buttons, callback } : {}),
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
    const payload = {
      title: message.title,
      body: message.body,
      tag: message.tag,
      url,
      ...(context.approvalId ? { approvalId: context.approvalId } : {}),
      // Both or neither: a button with no token is a button that cannot be
      // pressed, and a token with no button is unreachable.
      ...(callback && buttons.length ? { actions: buttons, callback } : {}),
      ...(context.step ? { step: context.step } : {}),
      notificationId: record.id,
    };
    const pushed = this.push.announce(
      category,
      payload,
      Date.now(),
      (report) => {
        this.notifications.delivery(record.id, { ...report, at: new Date().toISOString() });
        this.emit('notification:delivery', { id: record.id, ...report });
        // A push that arrived is the channel answering again (#140).
        if (report.outcome === 'sent') this.digestCatchUp();
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
    const hooked = this.webhooks.announce(category, {
      title: message.title,
      body: message.detail ?? message.body,
      url,
      notificationId: record.id,
      slug: context.slug ?? null,
      phase: context.phase ?? null,
      runId: context.runId ?? null,
      ...(opts.urgent === undefined ? {} : { urgent: opts.urgent }),
    });
    const legs: unknown[] = [pushed, hooked];
    this.trackDelivery(record.id, legs);
    return record;
  }


  /**
   * The deliveries still in flight, by notification id — kept only until they
   * settle. Nothing awaits them on the ordinary path (a slow push service must
   * never stall a phase); the shutdown announcement is the one reader, because
   * the process that sent it is about to exit (SHD-4).
   */
  protected readonly deliveries = new Map<string, Promise<void>>();

  private trackDelivery(id: string, legs: readonly unknown[]): void {
    const pending = legs.filter((leg): leg is Promise<unknown> => leg instanceof Promise);
    if (!pending.length) return;
    const settled = Promise.allSettled(pending).then(() => undefined);
    this.deliveries.set(id, settled);
    void settled.finally(() => { if (this.deliveries.get(id) === settled) this.deliveries.delete(id); });
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

    // A human step's terminal (control-tower phase 43): its command's exit is
    // the step's proof when the step names none, and the moment to run the
    // proof when it does. Nothing of what was typed in it is read.
    if (session.meta?.humanStep) {
      void this.humanStepTerminalExited(session.meta.humanStep.id, failed ? (code || 1) : 0).catch((error: unknown) => {
        log.warn('human-steps.clock-failed', { id: session.meta?.humanStep?.id, error: (error as Error)?.message ?? String(error) });
      });
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
    if (outcome.fixed && synced?.status === 'parked' && link.slug && this.fleetHoldFor(link.slug)) {
      log.info('run.recovery-continue-frozen', { slug: link.slug, runId: synced.id });
    } else if (outcome.fixed && synced?.status === 'parked' && link.slug && synced.autonomy === 'halt-on-everything') {
      // The session vehicle's rule (control-tower phase 81, #105): a run the
      // operator set to halt on everything is one they continue themselves —
      // parked, and said so on the run's record.
      const why = 'the run is halt-on-everything — the operator continues it';
      if (this.root) {
        Journal.for(this.root.path, link.slug, synced.id)
          .append('run.recovery-parked', { phase: link.phase ?? null, why, by: 'pty-agent' }, link.phase);
      }
      log.info('run.recovery-parked', { slug: link.slug, runId: synced.id, phase: link.phase ?? null, why });
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
          // The pty agent's exit is an OBSERVATION, not a clock: the console
          // continues because the recovery it launched said `fixed`.
          actor: doorActor('pty-continue', {
            by: 'console', via: 'event', origin: 'pty-agent:exit',
            trigger: `${link.kind}:${outcome.fixed ? 'fixed' : 'not-fixed'}`,
            guard: 'autoContinueRecovery,allowRun,!liveRunner,!fleetHold',
          }),
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
    // The cards and tokens a previous console left go FIRST (TRS-11): a
    // surviving child's token lives only in the settings file this sweeps.
    this.recoverApprovals();
    this.sweepRunSecrets();
    this.sweepOldRuns();
    // Before anything reads a budget off a stored run: its dollars, re-priced
    // once to the booked-delta model (control-tower phase 46, #62).
    this.repriceStoredRuns();
    // The lanes stopped runs keep for a phase (control-tower phase 100).
    this.registerStoredReservations();
    // …and before anything reads a phase's worked time: every session that
    // worked it, re-measured once from the journal (control-tower phase 58, #66).
    this.remeasureStoredRuns();
    // Every OTHER sink, after the run records and never before them: the global
    // byte cap is a floor under `pruneRuns`'s per-plan decision, not a second
    // opinion about it.
    this.startRetentionClock();
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
    this.startDigestClock();
    this.startHumanStepClock();
    // Every plan's stored triggers (control-tower phase 98, #137): one already
    // true fires now, and the rest watch what goes by.
    this.startTriggers();
    // What this boot holds, read before anything below asks `convergeAutomatic()`
    // or re-adopts: the stop marker and the profile's `autostart` (SHD-5, FLT-9).
    this.settleBootHold();
    this.announceCrashedBoot();
    // The convergence loop: the boot pass once the queued re-adoption is done (a
    // queued run must be live before the loop reads it), then the sweep clock.
    // The watch clock opens BEFORE the re-adoption when the loop runs, so an
    // overdue wait's refs are read with it open, ahead of any resume (SHD-6).
    if (this.convergeAutomatic()) this.watchClock.open();
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
  protected async readoptQueued(
    opts: { trigger: ResumeTrigger; operatorPress?: boolean } = { trigger: 'boot' },
  ): Promise<void> {
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
    // …and so does one that boots holding its automation (SHD-5, FLT-9): a
    // console stopped with "stay off", or one the profile says does not start
    // its work unattended. Whole-pass, for the freeze's reason — every door
    // below ends in a spawned session. The release runs this pass again.
    const held = this.bootHold();
    if (held) {
      log.info('run.readopt-held', { kind: held.kind, by: held.by, at: held.at });
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
            // At boot this is the console starting up; from `thawFleet` it is
            // the operator's press, and the trigger word says which.
            actor: doorActor('boot-readopt', {
              by: 'console', via: opts.trigger === 'boot' ? 'boot' : viaOfTrigger(opts.trigger),
              origin: `readoptQueued:${opts.trigger}`, trigger: 'queued',
              guard: 'allowRun,root.ok,!fleetHold,!liveRunner', counter: 'one per plan per boot',
            }),
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
      // some phase declared.
      //
      // Asked through the convergence loop's OWN predicate (`waitClockVerdict`),
      // so the two paths give one answer with one `why` (SLF-6): this arm used
      // to arm whatever clock was on disk, the operator's stop unread, and fire
      // a past one on the next tick — five resumes 64 to 581 minutes late, each
      // reading as on time (SLF-5, SHD-6). A clock still ahead is armed; one
      // that went by is RULED ON (`resumeOverdueWait`) or asked about; a pinned
      // one is left, and says why.
      if (state && (state.status === 'paused' || state.status === 'waiting') && waitClockOf(state)) {
        const verdict = waitClockVerdict(state, {
          now: Date.now(), prefs: this.prefs,
          // A thaw is the operator's own press: it answers the question a restart asks.
          decision: opts.operatorPress ? 'continue' : (this.resumeDecisions.get(state.id) ?? null),
        });
        if (verdict.verdict === 'arm') { this.armLimitResume(record.slug, state, 'boot'); continue; }
        if (verdict.verdict === 'resume') {
          void this.resumeOverdueWait(record.slug, state.id, opts.trigger, { count: true });
          continue;
        }
        if (verdict.verdict === 'ask') {
          this.registerResumeAsk(record.slug, state.id, verdict.phases, verdict.sessions, verdict.why, opts.trigger);
          continue;
        }
        if (verdict.verdict !== 'not-a-wait') {
          // `hold` and `errand`: nothing starts. The errand is the convergence
          // loop's to write — one writer, one dedupe — and a console running
          // without the loop still logs what it decided and why.
          log.info('run.readopt-wait-held', { slug: record.slug, runId: state.id, verdict: verdict.verdict, why: verdict.why });
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
  private limitResumeTimers = new Map<string, { timer: NodeJS.Timeout; at: number; armedBy?: 'boot' | 'runtime' }>();

  /** Freeze escalations re-armed at boot, keyed `slug:runId`. */
  protected freezeTimers = new Map<string, NodeJS.Timeout>();

  /**
   * When each in-process clock with no moment of its own will fire (SHD-1):
   * the freeze escalations, the MCP `require` clocks and the outcome inbox's
   * debounce, keyed `source|key`, written beside every arm and dropped beside
   * every clear. `limitResumeTimers` carries its own `at` and is read directly.
   * It is what lets the shutdown inventory name a clock and its moment rather
   * than count timers.
   */
  protected readonly clockLedger = new Map<string, InventoryClock>();

  protected noteClock(
    source: ShutdownClockSource, key: string, atMs: number, where: { slug?: string; runId?: string; phase?: number } = {},
  ): void {
    if (!Number.isFinite(atMs)) return;
    this.clockLedger.set(`${source}|${key}`, { source, at: new Date(atMs).toISOString(), ...where });
  }

  protected dropClock(source: ShutdownClockSource, key: string): void {
    this.clockLedger.delete(`${source}|${key}`);
  }

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
    // A boot hold (the stop marker, `autostart: false`) switches the loop's
    // automatic triggers off exactly as `--no-converge` does, for as long as it
    // stands (SHD-5, FLT-9).
    return this.flags.converge === true && this.flags.allowRun && !this.bootHold();
  }

  /* ---------------------------------------------------------------- *
   * The boot hold — a stop that meant it, and a start policy
   * ---------------------------------------------------------------- */

  /**
   * The stop marker as this process last read or wrote it. `undefined` until
   * the first read; `null` for "no marker". See `bootHold()` for when it is
   * re-read.
   */
  protected stopMarkerCache: StopMarker | null | undefined = undefined;
  /** The profile said `autostart: false` for this instance when it booted (FLT-9). */
  protected autostartOff = false;
  /** An operator released this boot's hold; nothing holds again until the next boot. */
  protected bootHoldReleased = false;
  /** When this console opened its root — the moment an `autostart-off` hold began. */
  private bootHoldSince: string | null = null;
  /** `boot.hold` is said once per hold. */
  private bootHoldSaid = false;

  /**
   * Why this console is holding its automation, or null (SHD-5, FLT-9).
   *
   * Two reasons, one answer, read by everything that would start work on its
   * own: the stop marker a `mode: 'unload'` Shut down wrote (a console stopped
   * on purpose that came back anyway), and the machine profile saying this
   * instance does not start its work unattended. While either holds,
   * `readoptQueued` re-adopts nothing and `convergeAutomatic()` is false — so no
   * boot pass, no sweep, no watch clock, no outcome-inbox boarding. An
   * operator's press is never held: this is the console's automation, not a
   * lock on the operator's hands.
   *
   * The marker is re-read while it is known to stand (cheap, and the only way a
   * `phase-console start` that removed it reaches a console already up) and
   * never while it is known absent — only this process writes it.
   *
   * A marker that vanishes under a console holding for it is that start: the
   * agent removes the file, finds the job already running and starts nothing,
   * so the boot pass the hold skipped would otherwise never run — a console
   * reporting no hold with no re-adoption and no sweep behind it. It runs here,
   * once, as the boot it stands in for (`boot.hold-released`, `how:
   * 'marker-removed'`), and `bootSettled` follows it.
   */
  bootHold(): BootHold | null {
    if (this.bootHoldReleased) return null;
    if (this.stopMarkerCache === undefined || this.stopMarkerCache !== null) {
      const before = this.stopMarkerCache;
      this.stopMarkerCache = readStopMarker();
      if (before && !this.stopMarkerCache && !this.autostartOff) {
        log.warn('boot.hold-released', {
          kind: 'stopped', how: 'marker-removed', heldSince: before.at, heldBy: before.by,
          by: 'outside this console — the stop marker was removed',
        });
        const settled = this.bootSettled;
        this.bootSettled = settled.then(() => this.runHeldBoot({ trigger: 'boot' }));
      }
    }
    const marker = this.stopMarkerCache;
    if (marker) {
      return {
        kind: 'stopped', at: marker.at, by: marker.by, marker,
        why: `stopped on purpose by ${marker.by} at ${marker.at} (stay off) — nothing is re-adopted or converged until the stop is cleared`,
      };
    }
    if (this.autostartOff) {
      return {
        kind: 'autostart-off', at: this.bootHoldSince ?? new Date().toISOString(), by: 'fleet.json',
        why: 'the machine profile says this console does not start its work unattended (autostart: false) — nothing is re-adopted or converged until an operator releases it',
      };
    }
    // The breaker. Three hard endings inside ten minutes is a loop, and a
    // supervisor's ten-second restart is about to make it four — each one
    // re-parking the live children of the runs the last console was driving.
    //
    // Read from the field rather than the ledger: `bootHold()` is called by
    // every `GET /api/state`, and the ledger only changes when a BOOT writes to
    // it — so asking the disk here would put a file read on the polled path, in
    // a fix whose subject is a console doing exactly that.
    const loop = this.crashLoopAtBoot;
    if (loop) {
      return {
        kind: 'crash-loop', at: loop.since, by: 'this console',
        why: `this console ended hard ${loop.boots} times since ${loop.since} — automation is held so a supervisor's restart cannot re-park the runs it was driving. Release it once the cause is understood.`,
      };
    }
    return null;
  }

  /**
   * Read the start policy for this boot and say what holds, once. `once` is
   * spent here: this boot is the start the profile granted, so the profile's
   * entry becomes `false` and this console's own unit is disabled, so the next
   * login does not start it again (both journalled as `boot.autostart-once`).
   */
  protected settleBootHold(): void {
    this.bootHoldSince = new Date().toISOString();
    // Once per boot, before anything asks: see `crashLoopAtBoot`.
    this.crashLoopAtBoot = crashLoop();
    this.bootHoldReleased = false;
    this.bootHoldSaid = false;
    // Read fresh: a marker cached by an earlier open is not one that vanished
    // under THIS boot, and must not run a second boot pass beside open()'s own.
    this.stopMarkerCache = undefined;
    const autostart = readAutostart(INSTANCE.id);
    this.autostartOff = autostart === false;
    if (autostart === 'once') {
      const spent = consumeAutostartOnce(INSTANCE.id);
      const unit = spent ? disableOwnUnit((file, args, options) => spawnSync(file, args, options)) : null;
      log.info('boot.autostart-once', { instance: INSTANCE.id, spent, unit: unit?.label ?? null, disabled: unit?.ok ?? null });
    }
    const hold = this.bootHold();
    // The latch the two park writers consult. It is set from ANY hold, not only
    // the crash loop: a console told to stay off must not re-park a live run
    // either, and the measured incident is what proves the read path needs its
    // own answer rather than inheriting `readoptQueued`'s.
    setAdoptionHold(hold ? hold.kind : null);
    if (hold && !this.bootHoldSaid) {
      this.bootHoldSaid = true;
      log.warn('boot.hold', { kind: hold.kind, by: hold.by, at: hold.at, why: hold.why });
    }
  }

  /**
   * The operator lifts the hold (Settings, or the route behind it): the marker
   * is removed, this boot is released, and the boot pass that was held runs now
   * — the re-adoption, then the convergence loop and its clocks. The profile is
   * not edited: `autostart: false` still holds the NEXT boot, which is what the
   * profile says.
   */
  async releaseBootHold(who: Actor | string): Promise<{ ok: boolean; reason?: string; was?: BootHoldKind }> {
    const actor = asActor(who, 'Service.releaseBootHold');
    const hold = this.bootHold();
    if (!hold) return { ok: false, reason: 'nothing is holding this console’s automation' };
    if (hold.kind === 'stopped') {
      try {
        clearStopMarker();
      } catch (error) {
        return { ok: false, reason: (error as Error).message };
      }
      this.stopMarkerCache = null;
    }
    this.bootHoldReleased = true;
    // Let the read path speak again, and drop what it answered while held: a
    // run it was asked about under the hold was deliberately left untouched,
    // and the DEFERRED reconcile is what runs now.
    setAdoptionHold(null);
    clearRunFileCache();
    log.warn('boot.hold-released', { ...actor, kind: hold.kind, how: 'release', heldSince: hold.at, by: actor.by, heldBy: hold.by });
    await this.runHeldBoot({ trigger: 'button', operatorPress: true });
    return { ok: true, was: hold.kind };
  }

  /**
   * What this console's own ledger says about how the last one ended, or null.
   * Read once at boot: the ledger only changes when a boot writes to it.
   */
  protected crashedBoot: { at: string; boots: number; snapshot?: string | null } | null = null;

  /**
   * Whether this console booted into a crash loop, decided once.
   *
   * The ledger only changes when a boot appends to it, and this console's own
   * boot is the last such event it will ever see — so the verdict is a fact
   * about this process, not a question to re-ask on every request.
   */
  protected crashLoopAtBoot: { since: string; boots: number } | null = null;

  /**
   * Say ONCE per boot that the console before this one ended hard.
   *
   * It was a log line and nothing else, which is how a console crash-looped for
   * five minutes — parking two live autopilot runs each time round — with
   * nobody told. One push, one inbox row, and the row carries the snapshot's
   * path when one was written.
   */
  protected announceCrashedBoot(): void {
    const ledger = readCrashLedger();
    const newest = ledger[ledger.length - 1];
    if (!newest) return;
    // Only THIS boot's own record: an older one is history the inbox has
    // already shown, and re-announcing it every restart is how a person learns
    // to ignore the category.
    if (newest.pid !== process.pid) return;
    const loop = this.crashLoopAtBoot;
    this.crashedBoot = {
      at: newest.at,
      boots: loop?.boots ?? 1,
      snapshot: newest.snapshot ?? null,
    };
    this.announce('health', {
      title: loop ? 'Phase Console is in a crash loop' : 'Phase Console restarted after a hard stop',
      body: loop
        ? `Ended hard ${loop.boots} times since ${loop.since}. Automation is held until you release it.`
        : 'The console before this one wrote no exit record — it was killed, ran out of heap, or the machine stopped.',
      tag: tagFor('health', 'previous-run-crashed', newest.at),
    });
  }

  /** The boot pass a hold skipped: the re-adoption, then the loop, its sweep and the watch clock. */
  private async runHeldBoot(opts: { trigger: ResumeTrigger; operatorPress?: boolean }): Promise<void> {
    try {
      await this.readoptQueued(opts);
    } catch (error) {
      log.warn('run.readopt-failed', { error });
    }
    if (this.convergeAutomatic()) {
      this.converger.start();
      this.watchClock.open();
      await this.converger.boot(this.convergeSlugs()).catch((error) => log.warn('converge.boot-failed', { error }));
    }
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

  /**
   * The hold `slug`'s automatic starts wait on, or null: `fleetHold` read
   * through `holdBinds`. Every automatic start that knows its plan asks this
   * rather than `fleetHold()`, because a restart waiting for its lanes holds
   * only the plans whose scope meets theirs (control-tower phase 48, #70).
   */
  fleetHoldFor(slug: string | null | undefined): FleetHold | null {
    const hold = this.fleetHold();
    return holdBinds(hold, slug) ? hold : null;
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
  fleetState(): {
    frozen: boolean;
    at: string | null;
    by: string | null;
    url?: string | null;
    reachable?: boolean;
    hold?: FleetHold | null;
  } {
    const hold = this.fleetHold();
    // `frozen` is THIS console's own freeze, the console tier's word; a machine
    // hold (and a restart's) is carried beside it, never folded into it — a held
    // console's live sessions are still running, and the banner must not say
    // otherwise. Only the console's own marker has no scope.
    const own = hold && !hold.scope ? hold : null;
    const state: ReturnType<ServiceBase['fleetState']> = { frozen: Boolean(own), at: own?.at ?? null, by: own?.by ?? null };
    return state;
  }

  protected armLimitResume(slug: string, state: RunState, armedBy: 'boot' | 'runtime' = 'runtime'): void {
    // The run's clock, else the soonest waiting record's (WAI-6) — one reader.
    const until = waitClockOf(state);
    const at = Date.parse(until ?? '');
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
    this.limitResumeTimers.set(slug, { timer, at, armedBy });
    log.info('run.rearmed-wait', { slug, runId: state.id, until, armedBy, inMs: Math.max(0, delay) });
    // A clock a restart re-armed goes on the RUN's journal too, where the
    // resume it leads to lands — it lived only in `console.log`, so the run's
    // own history could not say its resume was re-armed at all (SHD-6).
    if (armedBy === 'boot' && this.root?.ok) {
      Journal.for(this.root.path, slug, state.id).append('run.rearmed-wait', {
        until, now: new Date().toISOString(), inMs: Math.max(0, delay), armedBy,
      });
    }
  }

  /** Overdue rulings in flight, by `slug:runId` — the boot pass and the loop may reach one clock together. */
  private readonly overdueRulings = new Set<string>();

  /** The late-resume announcements already made, by `runId@until` — lateness is said once. */
  private readonly lateAnnounced = new Set<string>();

  /**
   * Register that a run is waiting on the operator's word — the question a
   * restart asks (`resumeAtBoot: 'ask'`), for the boot's re-adoption as for the
   * loop's `await-decision`. Journalled once per boot, on the run.
   */
  protected registerResumeAsk(
    slug: string, runId: string, phases: number[], sessions: string[], why: string, trigger: ResumeTrigger,
  ): void {
    const first = !this.resumeAsks.has(runId);
    this.resumeAsks.set(runId, { slug, runId, phases, sessions, at: new Date().toISOString() });
    if (first && this.root?.ok) {
      Journal.for(this.root.path, slug, runId).append('run.resume-asked', { phases, reason: why, trigger });
    }
  }

  /**
   * An overdue wait, RULED ON rather than fired (SHD-6, SLF-5).
   *
   * A clock that went by while nothing ran — a console restart, a freeze, a
   * machine asleep — used to fire on the next tick: `setTimeout(…, 0)`, no
   * lateness recorded, no ref checked, no budget re-read, and in the measured
   * case a session resumed 9.7 hours late into work that had moved on. Now, in
   * order and before anything starts:
   *
   *  1. the lateness and what the refs say NOW go on the run's journal
   *     (`run.wait-overdue`), with the watch clock open;
   *  2. each declared park's budget is re-read through `evaluateWait` — spent
   *     parks that phase on its refs with a `budgets` errand (`spentBudgetPark`,
   *     control-tower phase 45), never a boarding and never a failure;
   *  3. a park whose declaring session is still RUNNING is not resumed over it
   *     (REG-1) — refused, recorded, re-checked shortly; an author the registry
   *     shows ended is recorded on the ruling;
   *  4. lateness past `WAIT_OVERDUE_ANNOUNCE_MS` is announced, once;
   *  5. the resume is counted (`phase.resume-automatic`) when the caller's gate
   *     did not already count it — and only then `run.limit-resume` starts it.
   *
   * Answers whether it launched. One ruling per run at a time: the boot pass
   * and the convergence loop can meet the same clock.
   */
  /**
   * The ingest probe's door (control-tower phase 50, #86): ask a staged
   * declaration's refs now, through the watch clock's own probe, and say
   * whether one has already landed — `declared-probe.ts` holds the rules. A
   * landing is journalled on the run the file names, else on the plan's
   * latest run; with neither, the answer alone reaches the session.
   */
  probeDeclaration(body: { slug?: unknown; phase?: unknown; file?: unknown }): Promise<DeclaredProbeAnswer> {
    return answerDeclaredProbe(body, {
      root: this.root?.ok ? this.root.path : null,
      // The guard at the door (control-tower phase 130): G1, G2, G4 and G6,
      // while the session is still there to hear exit 2 or 4.
      guard: (runId, step) => {
        const guide = step.guide === undefined ? null
          : parseGuide(typeof step.guide === 'string' ? step.guide : step.guide?.text, {
            lang: typeof step.guide === 'object' ? step.guide?.lang : undefined,
          });
        if (guide && !guide.ok) return { ok: false, rule: 'G6', exit: 2, sentence: `--guide refused: ${guide.error}`.replace(/["\\]/g, "'") };
        return guardStep({
          kind: String(step.kind ?? ''),
          ...(typeof step.title === 'string' ? { title: step.title } : {}),
          ...(typeof step.why === 'string' && step.why_source !== 'inferred' ? { why: step.why } : {}),
          ...(typeof step.proof_type === 'string' ? { proofType: step.proof_type } : {}),
          ...(typeof step.proof === 'string' ? { proof: step.proof } : {}),
          ...(typeof step.proof_words === 'string' ? { proofWords: step.proof_words } : {}),
          guide: guide?.ok ? guide.guide : null,
          ...(typeof step.open_command === 'string' ? { openCommand: step.open_command } : {}),
          ...(typeof step.tried === 'string' ? { tried: step.tried } : {}),
        }, { stage: 'door', judge: this.commandJudgeFor(runId) });
      },
      // G5's evidence (control-tower phase 135): the walls recorded for the
      // declaring lane — the run the staged file names, else the plan's latest;
      // null when no run of this console holds the phase (an interactive
      // session's declaration is explained, never refused).
      walls: (slug, runId, phase) => {
        if (!this.root?.ok) return null;
        const run = latestRun(this.root.path, slug, this.liveRunIds());
        if (!run || (runId && run.id !== runId)) return null;
        const record = run.phases[String(phase)];
        return record ? (record.walls ?? []) : null;
      },
      probe: (slug, phase, refs) => this.watchClock.probeDeclared(slug, phase, refs, { budgetMs: DECLARED_PROBE_BUDGET_MS }),
      journal: (slug, runId, kind, data, phase) => {
        if (!this.root?.ok) return;
        const id = runId ?? latestRun(this.root.path, slug, this.liveRunIds())?.id ?? null;
        if (id) Journal.for(this.root.path, slug, id).append(kind, data, phase);
      },
    });
  }

  async resumeOverdueWait(slug: string, runId: string, trigger: ResumeTrigger, opts: { count: boolean }): Promise<boolean> {
    if (!this.flags.allowRun || !this.root?.ok) return false;
    const key = `${slug}:${runId}`;
    if (this.overdueRulings.has(key)) return false;
    this.overdueRulings.add(key);
    try {
      const armed = this.limitResumeTimers.get(slug);
      if (armed) { clearTimeout(armed.timer); this.limitResumeTimers.delete(slug); }
      const frozen = this.fleetHoldFor(slug);
      if (frozen) { log.info('run.limit-resume-frozen', { slug, runId, by: frozen.by }); return false; }
      const root = this.root.path;
      const state = latestRun(root, slug, this.liveRunIds());
      if (!state || state.id !== runId || !state.waitUntil) return false;
      if (state.status !== 'paused' && state.status !== 'waiting') return false;
      if (this.liveRunner(slug)) return false;
      const held = waitHoldWhy(state);
      if (held) { log.info('run.limit-resume-held', { slug, runId, why: held }); return false; }
      const now = Date.now();
      const until = state.waitUntil;
      const lateByMs = Math.max(0, now - Date.parse(until));
      const journal = Journal.for(root, slug, runId);
      const parks = waitClockPhases(state);

      // 1. What the world says now — the refs, with the watch clock open.
      if (this.convergeAutomatic()) this.watchClock.open();
      const refs: { phase: number; ref: string; state: string; detail?: string }[] = [];
      for (const record of parks) {
        for (const target of pollableRefs(record.declared?.watch ?? record.watch).filter((t) => t.kind !== 'cmd').slice(0, 8)) {
          const answer = await probeWatchRef(target, {
            lockFree: (lockSlug, lockPhase) => {
              const lock = this.allLocks().find((l) => l.slug === lockSlug && l.phase === lockPhase);
              return !lock || lock.expired || this.lockPresenceFor(lock) === 'ended';
            },
          });
          refs.push({ phase: record.phase, ref: answer.ref, state: answer.state, ...(answer.detail ? { detail: answer.detail } : {}) });
        }
      }
      const declarers = parks.map((record) => {
        const sessionId = record.resumeSessionId ?? record.sessionId;
        return { phase: record.phase, sessionId: sessionId ?? null, presence: sessionId ? this.sessions.presence(sessionId) : null };
      });
      journal.append('run.wait-overdue', {
        until, now: new Date(now).toISOString(), lateByMs, trigger, refs, declarers,
      });
      log.warn('run.wait-overdue', { slug, runId, until, lateByMs, trigger });

      // 2. The budget, re-read through the one expression. Spent is a BUDGET
      //    event (control-tower phase 45, #59), never a failed phase or a
      //    halt: the phase waits on its refs with no clock and a `budgets`
      //    errand — the live runner's `parkOnSpentBudget`, through the same
      //    pure `spentBudgetPark` — and a landing resumes it.
      const spentParks: number[] = [];
      for (const record of parks) {
        if (record.declared?.status !== 'waiting-external') continue;
        const budget = await this.waitBudget(slug, record.phase);
        const verdict = evaluateWait({
          purpose: 'resume', now, parkedMs: parkedMsOf(record, now), waits: record.waits ?? 0, budget,
          ledger: record.declared.by === 'watchdog' ? 'watchdog' : 'session',
        });
        if (verdict.verdict !== 'timeout') continue;
        const spent = spentBudgetPark(state, record.phase, {
          ledger: verdict.ledger, refusal: `phase ${record.phase} was not resumed — ${verdict.reason}`,
          budget, at: new Date(now).toISOString(),
        });
        journal.append('phase.wait-budget-spent', { ...spent.data, trigger }, record.phase);
        if (spent.errand) journal.append('phase.errand', { ...spent.errand }, record.phase);
        // A spent budget announces as one (control-tower phase 14, #40).
        this.announceBudget({ slug, runId: state.id, phase: record.phase, state: 'spent', fact: spent.fact });
        spentParks.push(record.phase);
      }
      const resumable = parks.filter((record) => !spentParks.includes(record.phase));

      // 3. The author: a session still running is not resumed over (REG-1).
      for (const record of resumable) {
        const hold = this.declarerHold(slug, record.phase, record.resumeSessionId ?? record.sessionId);
        if (!hold) continue;
        journal.append('phase.resume-refused', { ...hold, by: 'console', trigger }, record.phase);
        log.warn('run.resume-refused', { slug, runId, phase: record.phase, ...hold });
        this.announce('parked', {
          title: 'A resume is held — its session is still running',
          body: `${slug} phase ${record.phase} — session ${hold.sessionId.slice(0, 8)}${hold.pid ? ` (pid ${hold.pid})` : ''} `
            + 'is still running, so the console did not resume it on top of itself. It checks again shortly.',
          tag: tagFor('parked', slug, String(record.phase), 'resume-refused'),
        }, { slug, phase: record.phase, runId });
        saveRun(state);
        this.emit('run:state', { state });
        const retry = setTimeout(() => { void this.resumeOverdueWait(slug, runId, trigger, opts); }, RESUME_REFUSED_RECHECK_MS);
        retry.unref?.();
        return false;
      }

      // 4. Lateness worth saying out loud, once.
      if (lateByMs > WAIT_OVERDUE_ANNOUNCE_MS && !this.lateAnnounced.has(`${runId}@${until}`)) {
        this.lateAnnounced.add(`${runId}@${until}`);
        this.announce('parked', {
          title: 'A wait was resumed late',
          body: `${slug} — the wait clock (${until}) went by ${Math.round(lateByMs / 60_000)} min before anything could `
            + 'resume it. The console checked the refs and the budget before resuming; the session is told the world may have moved on.',
          tag: tagFor('parked', slug, runId, 'wait-overdue'),
        }, { slug, runId });
      }

      if (!resumable.length) {
        state.waitUntil = null;
        state.waitReason = null;
        setRunState(state, 'parked');
        state.stoppedBy = 'system';
        state.finishedReason = `the wait budget ran out while this run was parked (phase ${spentParks.join(', ')}) — `
          + 'it waits on its refs with no clock of its own; nothing was resumed.';
        saveRun(state);
        this.emit('run:state', { state });
        return false;
      }

      // 5. Counted, then started.
      if (opts.count) {
        const at = new Date(now).toISOString();
        for (const record of resumable) {
          const slot = ((state.recoveries ??= {})[String(record.phase)] ??= { attempts: 0, lastAt: at });
          slot.bootResumes = automaticResumes(state, record.phase) + 1;
          slot.lastAt = at;
          delete slot.errand;
          journal.append('phase.resume-automatic', {
            trigger, path: 'overdue-wait', count: slot.bootResumes,
            sessionId: record.resumeSessionId ?? record.sessionId ?? null, lateByMs, by: 'console',
          }, record.phase);
        }
      }
      saveRun(state);
      journal.append('run.limit-resume', { until, lateByMs, trigger, overdue: true });
      log.info('run.limit-resume', { slug, runId, lateByMs, trigger });
      await this.startRun(slug, {
        actor: doorActor('wait-clock', {
          by: 'console', via: trigger === 'boot' ? 'boot' : viaOfTrigger(trigger),
          origin: `resumeOverdueWait:${trigger}`, trigger: `overdue:${until}`,
          guard: 'waitClockVerdict,evaluateWait,resumableSession',
          ...(opts.count ? { counter: `MAX_BOOT_RESUMES:${Math.max(...resumable.map((record) => automaticResumes(state, record.phase)))}` } : {}),
        }),
        resumeRunId: runId,
        ...(state.onlyPhases?.length ? { onlyPhases: state.onlyPhases } : {}),
        skills: state.skills ?? [],
        ...(state.accountId ? { accountId: state.accountId } : {}),
      });
      return true;
    } catch (error) {
      log.warn('run.limit-resume-failed', { slug, runId, error });
      return false;
    } finally {
      this.overdueRulings.delete(key);
    }
  }

  private async resumeLimitPaused(slug: string, runId: string): Promise<void> {
    const armedBy = this.limitResumeTimers.get(slug)?.armedBy ?? 'runtime';
    this.limitResumeTimers.delete(slug);
    if (!this.flags.allowRun || !this.root?.ok) return;
    // The wait's moment arrived while the console was frozen. Nothing is
    // rescheduled here and nothing is lost: the run keeps its `waitUntil` on
    // disk, so `thawFleet`'s re-arm pass finds it overdue and fires it once —
    // which is exit criterion 3's "the overdue wait fires once".
    const frozen = this.fleetHoldFor(slug);
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
      this.limitResumeTimers.set(slug, { timer, at: Date.parse(state.waitUntil), armedBy });
      return;
    }
    // The same pins as the boot and the loop, read at the moment of firing:
    // the operator may have stopped it in the hours this timer slept.
    const held = waitHoldWhy(state);
    if (held) { log.info('run.limit-resume-held', { slug, runId, why: held }); return; }
    // Fired LATE — a machine asleep, a blocked loop, a clock a restart armed
    // already in the past: ruled on, never fired bare. Counted only when a
    // restart armed it; a live console's own late clock is the session's.
    const lateByMs = Date.now() - Date.parse(state.waitUntil);
    if (lateByMs > WAIT_OVERDUE_GRACE_MS) {
      await this.resumeOverdueWait(slug, runId, 'timer', { count: armedBy === 'boot' });
      return;
    }
    try {
      log.info('run.limit-resume', { slug, runId, lateByMs: Math.max(0, lateByMs) });
      Journal.for(this.root.path, slug, runId).append('run.limit-resume', {
        until: state.waitUntil, lateByMs: Math.max(0, lateByMs), trigger: 'timer', overdue: false,
      });
      await this.startRun(slug, {
        actor: doorActor('wait-clock', {
          by: 'console', via: armedBy === 'boot' ? 'boot' : 'timer', origin: `armLimitResume:${armedBy}`,
          trigger: `until:${state.waitUntil}`, guard: 'waitHoldWhy', counter: 'one per wait clock',
        }),
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
    this.heartbeat.stop();
    // First, while every socket is still open: a question whose window is open
    // is DEFERRED (phase 14) — its session ends the turn with the call kept, and
    // the card stays on disk for the next boot to answer — rather than dying
    // with the hook socket the drain is about to close.
    try { this.relay.deferOpen(null, 'shutdown'); } catch (error) { log.warn('relay.bookkeeping-failed', { what: 'defer', error: String(error) }); }
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
    this.clockLedger.clear();
    if (this.mcpHealthTimer) clearInterval(this.mcpHealthTimer);
    this.mcpHealthTimer = null;
    if (this.issuesSweepTimer) clearInterval(this.issuesSweepTimer);
    this.issuesSweepTimer = null;
    if (this.digestTimer) clearInterval(this.digestTimer);
    this.digestTimer = null;
    if (this.humanStepTimer) clearInterval(this.humanStepTimer);
    this.humanStepTimer = null;
    this.turnRound?.stop();
    this.journalHook?.();
    this.journalHook = null;
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.retentionTimer = null;
    this.stopTriggers();
    this.closeChats();
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
      outOfBand: { configured: Boolean(notifyCommand()) },
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
  restartReadiness(): RestartReadiness {
    const readiness = this.restartGate();
    return readiness;
  }

  /** The two refusals — "not now" and "not from here" — or the go-ahead. */
  private restartGate(): RestartReadiness {
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
   * What pressing Shut down will actually stop — computed from WORK (SHD-1).
   *
   * It used to be two numbers that measured nothing a shutdown discards: pty
   * terminals and "is a drain handler registered". Now: the lanes live runners
   * hold, every in-process clock the exit throws away (with when it would have
   * fired), the runs on disk the next boot picks back up, the sessions the
   * presence registry shows live, the pending approval cards and the unread
   * inbox depth — plus both strengths the button can use (`modes`), what each
   * achieves, and the command that undoes the strong one.
   *
   * Still never a refusal by itself: this is what the dialog RENDERS. The
   * refusal is `shutdown()`'s, and it is a demand for acknowledgement rather
   * than a wall — a console you cannot turn off is the bug that made this
   * endpoint exist.
   */
  shutdownReadiness(): {
    supervisor: ReturnType<typeof supervisor>;
    /** The strength a bare press uses. */
    mode: 'exit';
    /** The plan for that strength (`modes.exit`). */
    stop: ExitPlan;
    modes: { exit: ExitPlan; unload: UnloadPlan | null };
    inventory: ShutdownInventory;
    /** Nothing in flight, armed, owed, live, pending or unread — a bare `{confirm: true}` goes through. */
    empty: boolean;
    soonestClock: InventoryClock | null;
    busy: boolean;
    run: { slug: string; status: string } | null;
    sessions: ReturnType<Service['sessionInventory']>;
    /** How to get it back after `exit`. */
    restartHint: string;
    /** How to undo `unload`, when there is a unit to unload. */
    unloadHint: string | null;
    /** Why this console is holding its automation right now, if it is. */
    bootHold: BootHold | null;
  } {
    const state = this.runStates()[0] ?? null;
    const supervision = supervisor();
    const exitPlan = stopPlan(supervision);
    const unloadPlan = stopPlan(supervision, process.env, process.getuid?.() ?? null, 'unload');
    const modes = { exit: exitPlan, unload: unloadPlan };
    let inventory: ShutdownInventory;
    try {
      inventory = this.shutdownInventory();
    } catch (error) {
      // An inventory that could not be read must not take the off switch with
      // it — but it must not read as "nothing is running" either. An empty one
      // would let a bare press through, so the failure is logged and the empty
      // shape is returned with `empty: false`, which still demands acknowledgement.
      log.warn('shutdown.inventory-failed', { error: (error as Error).message });
      inventory = emptyInventory();
      return {
        supervisor: supervision, mode: 'exit', stop: exitPlan, modes, inventory, empty: false,
        soonestClock: null, busy: hasShutdownWork(), run: state ? { slug: state.slug, status: state.status } : null,
        sessions: this.sessionInventory(), restartHint: this.restartHintFor(exitPlan), unloadHint: unloadPlan?.resurrect ?? null,
        bootHold: this.bootHold(),
      };
    }
    return {
      supervisor: supervision,
      mode: 'exit',
      stop: exitPlan,
      modes,
      inventory,
      empty: inventoryEmpty(inventory),
      soonestClock: soonestClock(inventory),
      busy: hasShutdownWork(),
      run: state ? { slug: state.slug, status: state.status } : null,
      sessions: this.sessionInventory(),
      restartHint: this.restartHintFor(exitPlan),
      unloadHint: unloadPlan?.resurrect ?? null,
      bootHold: this.bootHold(),
    };
  }

  /** Where a person goes to get the console back after an `exit` of this strength. */
  private restartHintFor(plan: ExitPlan): string {
    if (plan.durability === 'returns') return 'nothing to do — its supervisor starts it again by itself';
    const label = process.env.XPC_SERVICE_NAME;
    if (plan.durability === 'until-login') {
      return label && label !== '0'
        ? `launchctl kickstart -k gui/$(id -u)/${label} — or wait for the next login`
        : process.env.PHASE_CONSOLE_UNIT
          ? `systemctl --user start ${process.env.PHASE_CONSOLE_UNIT}`
          : 'the next login starts it again';
    }
    return 'start it again with `bash <skill>/start` (or viewer/run)';
  }

  /**
   * The inventory itself (SHD-1). Each section reads the thing it names, never
   * a proxy for it: the lanes from the runners' own child records, the clocks
   * from the timer maps and the ledger beside them, the runs from disk, the
   * sessions from the registry, the cards from the broker, the depth from the
   * inbox directories.
   */
  protected shutdownInventory(): ShutdownInventory {
    const inventory = emptyInventory();
    const liveIds = this.liveRunIds();

    for (const runner of this.liveRunners()) {
      const state = runner.current();
      if (!state) continue;
      for (const child of childrenOf(state)) {
        inventory.lanes.push({
          slug: state.slug, runId: state.id, phase: child.phase,
          pid: child.pid ?? null, sessionId: child.sessionId ?? null,
        });
      }
      inventory.runs.push({
        slug: state.slug, id: state.id, status: state.status, waitUntil: waitClockOf(state) ?? null, live: true, clock: null,
      });
    }

    for (const [slug, armed] of this.limitResumeTimers) {
      inventory.clocks.push({ source: 'wait-resume', at: new Date(armed.at).toISOString(), slug });
    }
    for (const clock of this.clockLedger.values()) inventory.clocks.push(clock);
    const drainAt = this.sessions.pendingDrainAt();
    if (drainAt != null) inventory.clocks.push({ source: 'session-inbox', at: new Date(drainAt).toISOString() });
    for (const pass of this.converger.snapshot().pending) {
      inventory.clocks.push({ source: 'converge', at: new Date(pass.dueAt).toISOString(), slug: pass.slug });
    }

    if (this.root?.ok) {
      const root = this.root.path;
      for (const record of this.store?.list() ?? []) {
        if (record.plan?.closed) continue;
        let outcomes = 0;
        try {
          // `inboxOutcomePhase` is the one reader of the name shape — a second
          // regex spelled here would have missed every stamped name the moment
          // S9-a added one, and the inbox depth would have read 0 with a
          // backlog sitting in it.
          outcomes = readdirSync(outcomeInboxDir(root, record.slug)).filter((name) => inboxOutcomePhase(name) !== null).length;
        } catch { outcomes = 0; }
        inventory.inboxDepth.outcomes += outcomes;
        if (this.liveRunner(record.slug)) continue;
        const state = latestRun(root, record.slug, liveIds);
        if (!state || state.resolved) continue;
        const until = waitClockOf(state) ?? null;
        const clock = this.soonestClockFor(inventory.clocks, record.slug);
        const owed = state.status === 'queued'
          || state.status === 'waiting'
          || ((state.status === 'paused' || state.status === 'parked') && (until != null || clock != null));
        if (!owed) continue;
        inventory.runs.push({ slug: record.slug, id: state.id, status: state.status, waitUntil: until, live: false, clock });
      }
    }
    // A live runner's run carries the soonest clock of its plan too.
    for (const run of inventory.runs) {
      if (run.live) run.clock = this.soonestClockFor(inventory.clocks, run.slug);
    }

    const laneSessions = new Set(inventory.lanes.map((lane) => lane.sessionId).filter(Boolean));
    for (const view of this.sessionViews()) {
      if (view.presence !== 'live' || view.probe || laneSessions.has(view.sessionId)) continue;
      inventory.liveSessions.push({
        sessionId: view.sessionId, kind: view.kind, pid: view.pid ?? null, cwd: view.cwd,
        plan: view.plan ? { slug: view.plan.slug, phase: view.plan.phase } : null,
      });
    }

    for (const card of this.approvals.pending()) {
      inventory.pendingApprovals.push({
        id: card.id, slug: card.slug, phase: card.phase, kind: card.kind, expiresAt: card.expiresAt,
      });
    }
    inventory.inboxDepth.sessions = this.sessions.depth();
    inventory.clocks.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return inventory;
  }

  private soonestClockFor(clocks: readonly InventoryClock[], slug: string): InventoryClock | null {
    let soonest: InventoryClock | null = null;
    for (const clock of clocks) {
      if (clock.slug !== slug) continue;
      if (!soonest || Date.parse(clock.at) < Date.parse(soonest.at)) soonest = clock;
    }
    return soonest;
  }

  /**
   * Stop this console — at the strength asked for, and only on purpose.
   *
   * The order is the same as any other exit — `shutdown()` in `index.ts` notes
   * what is abandoned, closes the server, calls `service.close()`, then drains
   * the registered handlers so a run checkpoints. What the press decides:
   *
   *  - **refusals first** (`shutdownVerdict`): a bare `{confirm: true}` over a
   *    non-empty inventory is refused with the inventory named; `unload` always
   *    needs `acknowledge: true`, and needs a unit to unload;
   *  - **`unload` writes the stop marker before anything is unloaded**, so a
   *    process that comes back anyway boots holding its automation;
   *  - `shutdown.requested` carries the actor, the strength, the durability the
   *    plan achieves and the inventory in digest — the reason survives the
   *    process;
   *  - the announcement is AWAITED inside the drain (SHD-4) rather than left to
   *    a push callback the exit outruns, and records `skipped` when nothing
   *    could be seen delivered.
   */
  shutdown(
    who: Actor | string,
    ask: { mode?: unknown; acknowledge?: unknown } = {},
  ): {
    ok: boolean;
    status?: 400 | 409;
    reason?: string;
    needs?: 'mode' | 'unload' | 'acknowledge';
    mode?: string;
    stop?: StopPlan;
    inventory?: ShutdownInventory;
  } {
    const actor = asActor(who, 'Service.shutdown');
    const readiness = this.shutdownReadiness();
    const acknowledged = ask.acknowledge === true;
    const unread = !readiness.empty && inventoryEmpty(readiness.inventory);
    const verdict = unread && !acknowledged
      ? {
        ok: false as const, status: 409 as const, needs: 'acknowledge' as const,
        reason: 'the console could not read what it is holding, so it cannot say it is holding nothing — '
          + 'pass "acknowledge": true to shut it down anyway',
      }
      : shutdownVerdict(
        { mode: ask.mode === undefined ? readiness.mode : ask.mode, acknowledge: acknowledged },
        readiness.modes.unload,
        readiness.inventory,
      );
    if (!verdict.ok) {
      log.info('shutdown.refused', {
        ...actor, mode: ask.mode ?? readiness.mode, needs: verdict.needs, reason: verdict.reason,
        inventory: inventoryDigest(readiness.inventory),
      });
      return {
        ok: false, status: verdict.status, reason: verdict.reason, needs: verdict.needs,
        mode: typeof ask.mode === 'string' ? ask.mode : readiness.mode,
        inventory: readiness.inventory,
        ...(verdict.needs === 'unload' ? {} : { stop: ask.mode === 'unload' && readiness.modes.unload ? readiness.modes.unload : readiness.modes.exit }),
      };
    }
    const plan: StopPlan = verdict.mode === 'unload' ? readiness.modes.unload! : readiness.modes.exit;
    let marker: StopMarker | null = null;
    if (plan.mode === 'unload') {
      try {
        marker = writeStopMarker({
          by: actor.by, via: actor.via, origin: actor.origin, remoteUser: actor.remoteUser ?? null,
          durability: plan.durability, label: plan.label, resurrect: plan.resurrect,
        });
        this.stopMarkerCache = marker;
      } catch (error) {
        // Without the marker `unload` is the old bare bootout that a login
        // undoes — refused rather than carried out weaker than it was named.
        log.warn('shutdown.marker-write-failed', { error: (error as Error).message });
        return {
          ok: false, status: 409, needs: 'unload', mode: 'unload', inventory: readiness.inventory,
          reason: `the stop marker could not be written (${(error as Error).message}) — "stay off" would not hold, so nothing was stopped`,
        };
      }
    }
    // The actor DERIVED from the request (SHD-3), then what the press chose and
    // what it achieves, and the inventory it acknowledged — in digest, because
    // this line has to survive the process it is about.
    log.warn('shutdown.requested', {
      ...actor,
      supervisor: readiness.supervisor.kind,
      stop: plan.via,
      mode: plan.mode,
      durability: plan.durability,
      acknowledged,
      sessions: readiness.sessions.live,
      busy: readiness.busy,
      inventory: inventoryDigest(readiness.inventory),
    });
    // Announced before it happens, because afterwards there is nothing here to
    // announce anything — and a push that arrives on a phone is the only record
    // an operator elsewhere will get that the console went down on purpose.
    const record = this.announce('health', {
      title: 'Phase Console is shutting down',
      body: `${describeActor(actor)} · ${plan.detail}`
        + (readiness.empty ? '' : ` · it was holding: ${inventorySentence(readiness.inventory)}`),
      tag: tagFor('health', 'shutdown', String(Date.now())),
    });
    if (record) this.awaitAnnouncementAtShutdown(record);
    if (!requestShutdown(`shutdown (${actor.by} via ${actor.via} from ${actor.origin})`, { mode: plan.mode })) {
      // Nothing is draining: neither the announcement's handler nor the marker
      // may outlive a press that did not happen.
      offShutdown('shutdown-announcement');
      if (marker) {
        try { clearStopMarker(); this.stopMarkerCache = null; } catch { /* the refusal below still stands */ }
      }
      return { ok: false, status: 409, reason: 'this build has no shutdown verb registered — stop it by hand' };
    }
    return { ok: true, mode: plan.mode, stop: plan, inventory: readiness.inventory };
  }

  /**
   * Hold the drain open for the shutdown announcement's delivery (SHD-4).
   *
   * Registered as a drain handler, so `runShutdownHandlers` awaits it inside the
   * console's 120 s budget — bounded by `SHUTDOWN_ANNOUNCE_WAIT_MS` so a push
   * service that never answers cannot eat the drain. Whatever the wait ends on,
   * the record leaves with a non-empty `delivery`: the reports that landed, or
   * the console's own `skipped` row saying why none did. Both shutdown rows the
   * audit measured carried `delivery: []`.
   */
  private awaitAnnouncementAtShutdown(record: NotificationRecord): void {
    onShutdown('shutdown-announcement', async () => {
      const pending = this.deliveries.get(record.id);
      let timedOut = false;
      if (pending) {
        await Promise.race([
          pending,
          new Promise<void>((resolve) => {
            setTimeout(() => { timedOut = true; resolve(); }, SHUTDOWN_ANNOUNCE_WAIT_MS).unref();
          }),
        ]);
      }
      if (!record.delivery.length) {
        this.notifications.delivery(record.id, {
          device: 'console',
          label: 'this console',
          outcome: 'skipped',
          detail: pending && timedOut
            ? `process exiting — no delivery report within ${SHUTDOWN_ANNOUNCE_WAIT_MS / 1000} s`
            : pending
              ? 'process exiting — nothing reported a delivery'
              : 'process exiting — no device or webhook to deliver to',
          at: new Date().toISOString(),
        });
      }
      this.notifications.flush();
      log.info('shutdown.announced', {
        id: record.id, waitedFor: Boolean(pending), timedOut, delivery: record.delivery.map((row) => row.outcome),
      });
    });
  }

  /**
   * Every run the shutdown abandons, on its OWN journal (SHD-8) — called by
   * `index.ts` before anything closes, on every path (a press, a restart, a
   * signal). A run a live runner drives writes its own `run.console-shutdown`
   * from its checkpoint; this is every other one — queued, waiting, paused on a
   * clock, parked on one — which used to learn nothing from its journal about
   * the console going away, or about the clock that went with it.
   */
  noteShutdown(context: ShutdownContext): void {
    if (!this.root?.ok) return;
    let inventory: ShutdownInventory;
    try {
      inventory = this.shutdownInventory();
    } catch (error) {
      log.warn('shutdown.inventory-failed', { error: (error as Error).message });
      return;
    }
    for (const run of inventory.runs) {
      if (run.live) continue;
      try {
        Journal.for(this.root.path, run.slug, run.id).append('run.console-shutdown', {
          intent: context.intent,
          reason: context.reason,
          ...(context.mode ? { mode: context.mode } : {}),
          live: false,
          status: run.status,
          pids: [],
          phases: [],
          waitUntil: run.waitUntil,
          clock: run.clock,
          discards: run.clock
            ? `the ${run.clock.source} clock due ${run.clock.at}`
            : run.waitUntil
              ? `the wait clock due ${run.waitUntil}`
              : null,
        });
      } catch (error) {
        log.warn('shutdown.journal-failed', { slug: run.slug, runId: run.id, error: (error as Error).message });
      }
    }
    log.info('shutdown.inventory', { intent: context.intent, ...inventoryDigest(inventory) });
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
    who: Actor | string, force = false, options: { update?: boolean; whenIdle?: boolean; session?: string | null } = {},
  ): RestartOutcome {
    const actor = asActor(who, 'Service.restart');
    // Asked from inside a run's own session — the CLI passes the session's id
    // — it is that session's act, and its run is told (control-tower phase 48,
    // #69): a phase whose last act is "update when idle" used to leave no line
    // on its own journal, and the restart read as the operator's.
    const session = this.restartSessionOf(options.session);
    if (session) {
      this.journalOnRun(session.slug, session.runId, 'run.restart-requested', {
        ...actor, session: session.sessionId, update: options.update !== false,
        whenIdle: options.whenIdle === true, force,
      }, session.phase);
    }
    const readiness = this.restartReadiness();
    if (!readiness.ok && (readiness.busy || !force)) {
      return { ok: false, reason: readiness.reason, supervisor: readiness.supervisor };
    }
    return this.carryOutRestart(actor, readiness.supervisor, force);
  }

  /**
   * The live run session a restart request names, or null (control-tower
   * phase 48, #69). Found by the session id the lane's record carries — the
   * CLI sends `$PE_SESSION_ID`, which the runner put in that session's
   * environment — so a request can only ever be attributed to a session this
   * console is actually running.
   */
  protected restartSessionOf(
    sessionId: string | null | undefined,
  ): { sessionId: string; slug: string; runId: string; phase: number } | null {
    if (!sessionId) return null;
    for (const runner of this.liveRunners()) {
      const state = runner.current();
      if (!state) continue;
      for (const record of Object.values(state.phases)) {
        if (record.sessionId === sessionId) return { sessionId, slug: state.slug, runId: state.id, phase: record.phase };
      }
    }
    return null;
  }

  /** One line on one run's own journal — a failure to write it is logged, never thrown into a restart. */
  protected journalOnRun(slug: string, runId: string, event: string, data: Record<string, unknown>, phase?: number): void {
    if (!this.root?.ok) return;
    try {
      Journal.for(this.root.path, slug, runId).append(event, data, phase);
    } catch (error) {
      log.warn('restart.journal-failed', { slug, runId, event, error: (error as Error).message });
    }
  }

  /**
   * The exit itself: logged, announced, and handed to the registered restarter.
   * `expected` is what the unit is judged against when an update moved the
   * copy — the node arguments the update shipped (#71).
   */
  private carryOutRestart(
    actor: Actor, supervision: ReturnType<typeof supervisor>, force: boolean, note?: string,
    expected?: readonly string[],
  ): RestartOutcome {
    let how: RestartHow = {};
    log.warn('restart.requested', { ...actor, supervisor: supervision.kind, force, ...(how.reload ? { reload: true } : {}) });
    this.announce('health', {
      title: 'Phase Console is restarting',
      body: `${describeActor(actor)} · ${note ? `${note} · ` : ''}${supervision.detail}`,
      tag: tagFor('health', 'restart', String(Date.now())),
    });
    if (!requestRestart(`restart (${actor.by} via ${actor.via} from ${actor.origin})`, how)) {
      return { ok: false, reason: 'this build has no restart verb registered — restart it by hand' };
    }
    return { ok: true, supervisor: supervision };
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

