/**
 * The console shell — `/api/state`, the admission queue's fetchers, and the
 * server-side preferences with their shipped defaults.
 *
 * The shapes are the wire's (`shared/wire/state.js`, measured-console phase
 * 32): one declaration the server's handlers and these fetchers both import,
 * so a shape that drifts is a type error on one side or the other.
 */

import { request, post } from '../http';
import type { StateInclude } from '@shared/projection.js';
import {
  DEFAULT_MAX_PER_REPO,
  DEFAULT_RETENTION,
  isolationMode,
  reclaimModeOf,
  retentionOf,
  settleOf,
  WORKTREE_DEFAULTS,
  type IsolationMode,
  type IsolationReclaim,
  type SettleStrategy,
  worktreeRootOf,
  type WorktreeRoot,
} from '@shared/worktree-model.js';
import {
  CONFLICT_POLICIES,
  DEFAULT_BASE_BRANCH,
  DEFAULT_CONFLICT,
  landPolicyOf,
  type ConflictPolicy,
  type LandPolicy,
} from '@shared/landing-model.js';
import { DEFAULT_MESSAGING, MESSAGING_WORDS, type MessagingWord } from '@shared/message-model.js';
import { DEFAULT_ISSUES, ISSUE_MODES } from '@shared/issue-modes.js';
import type { IssueMode } from '@shared/issues-model.js';
import type { McpPolicy } from './runs';
import type { GitMode, ReviewerPolicy } from '@shared/run-lifecycle.js';
import type {
  BootHold,
  BootResumeAnswer,
  ConsoleState,
  FleetState,
  PhaseScope,
  QueueLoad,
  QueueSnapshot,
  QueueView,
} from '@shared/wire/state.js';

export type {
  ApprovalCounts,
  BootHold,
  BootResumeAnswer,
  Concurrency,
  ConsolePrefs,
  ConsoleState,
  EventsSubscribeAnswer,
  FleetState,
  HolderEtaView,
  InstanceInfo,
  PhaseScope,
  QueueAdvice,
  QueueAuditRow,
  QueueControl,
  QueueEntry,
  QueueHintedRow,
  QueueHolder,
  QueueLane,
  QueueLaneWait,
  QueueLoad,
  QueueMark,
  QueuePress,
  QueueReservation,
  QueueSnapshot,
  QueueView,
  QueueViewEntry,
  QueueWithdrawnRow,
  ReachState,
  RootInfo,
  Sizing,
  SkillCopyEntry,
  SkillCopyView,
  SupervisorInfo,
} from '@shared/wire/state.js';

/**
 * The automation preferences with the server's own defaults applied — the one
 * place the `?? default` chain lives. The server sanitises on load and save,
 * so these fallbacks only matter against an older server that has never
 * written the keys.
 */
export function automationPrefs(state: ConsoleState | undefined): {
  attachDefaultSkills: boolean;
  qaByDefault: boolean;
  gitMode: GitMode;
  openPrOnComplete: boolean;
  settle: SettleStrategy;
  reviewEachPhaseByDefault: boolean;
  reviewerPolicy: ReviewerPolicy;
  repoGuard: boolean;
  radarSerialize: boolean;
  isolation: IsolationMode;
  worktreeMaxConcurrent: number;
  worktreeSetup: string;
  worktreeCopyEnv: boolean;
  worktreeRoot: WorktreeRoot;
  isolationReclaim: IsolationReclaim;
  deleteMergedRunBranches: boolean;
  maxConcurrentPerRepo: number;
  worktreeRetention: string;
  baseBranch: string;
  landing: LandPolicy;
  conflictPolicy: ConflictPolicy;
  messaging: MessagingWord;
  issuesMode: IssueMode;
  autoRecoverByDefault: boolean;
  autoContinueRecovery: boolean;
  watchCmdRefs: boolean;
  watchMintedCmdRefs: boolean;
  mcpPolicy: McpPolicy;
  checkJudgement: boolean;
  checkModel: string;
  checkEffort: string;
  turnEscalateAfter: number;
} {
  const prefs = state?.prefs ?? {};
  return {
    attachDefaultSkills: prefs.attachDefaultSkills ?? false,
    qaByDefault: prefs.qaByDefault ?? false,
    gitMode: prefs.gitMode === 'new-branch' ? 'new-branch' : 'default-branch',
    openPrOnComplete: prefs.openPrOnComplete ?? true,
    // Through the OWNER's fold, exactly as `server/config.ts` resolves the same
    // two keys: an absent `settle` reads the older boolean rather than
    // defaulting past it, so a console that stored `openPrOnComplete: false`
    // keeps meaning `keep` and does not silently start opening pull requests.
    settle: settleOf({ settle: prefs.settle, openPr: prefs.openPrOnComplete }),
    // Off is the default, and a console running an older server has never
    // written the key — which reads as off, which is the safe direction.
    reviewEachPhaseByDefault: prefs.reviewEachPhaseByDefault ?? false,
    // Only the exact word may let a reviewer hold work, matching the server.
    reviewerPolicy: prefs.reviewerPolicy === 'may-hold' ? 'may-hold' : 'comment-only',
    repoGuard: prefs.repoGuard ?? true,
    // Off unless the server wrote `true`: on is the setting that makes a phase wait.
    radarSerialize: prefs.radarSerialize === true,
    // Through the owner's coercer, so the client and the server cannot answer
    // differently about what a stored value means. An older server has never
    // written the key, which reads as `queue` — today's behaviour.
    isolation: isolationMode(prefs.isolation),
    worktreeMaxConcurrent: prefs.worktreeMaxConcurrent ?? WORKTREE_DEFAULTS.worktreeMaxConcurrent,
    worktreeSetup: prefs.worktreeSetup ?? WORKTREE_DEFAULTS.worktreeSetup,
    worktreeCopyEnv: prefs.worktreeCopyEnv ?? WORKTREE_DEFAULTS.worktreeCopyEnv,
    // Through the owner's coercer: an older server never wrote the key, and
    // absent reads as the project — where a person can find the trees.
    worktreeRoot: worktreeRootOf(prefs.worktreeRoot),
    // Through the owner's coercer, like `isolation` above: only the exact word
    // turns the reclaim off, so a console running an older server (which never
    // wrote the key) reads the shipped default rather than a third meaning.
    isolationReclaim: reclaimModeOf(prefs.isolationReclaim),
    deleteMergedRunBranches: prefs.deleteMergedRunBranches ?? true,
    // Phase 7's three, each through its owner's default (or coercer, where the
    // vocabulary is open): a console running an older server never wrote them.
    maxConcurrentPerRepo:
      typeof prefs.maxConcurrentPerRepo === 'number' && prefs.maxConcurrentPerRepo > 0
        ? prefs.maxConcurrentPerRepo
        : DEFAULT_MAX_PER_REPO,
    worktreeRetention: prefs.worktreeRetention ? retentionOf(prefs.worktreeRetention) : DEFAULT_RETENTION,
    baseBranch: prefs.baseBranch?.trim() || DEFAULT_BASE_BRANCH,
    // Phase 15's four launch defaults, each read through its owner's vocabulary
    // exactly as `server/config.ts` reads them: only a member means anything,
    // and everything else is the owner's default — the fail-safe direction for
    // each word (`hold` writes nothing, `halt` stops, `on` costs nothing
    // unused, `off` files nothing).
    landing: landPolicyOf(prefs.landing) as LandPolicy,
    conflictPolicy: CONFLICT_POLICIES.includes(prefs.conflictPolicy as never)
      ? (prefs.conflictPolicy as ConflictPolicy)
      : DEFAULT_CONFLICT,
    messaging: MESSAGING_WORDS.includes(prefs.messaging as never)
      ? (prefs.messaging as MessagingWord)
      : DEFAULT_MESSAGING,
    issuesMode: ISSUE_MODES.includes(prefs.issuesMode as never)
      ? (prefs.issuesMode as IssueMode)
      : DEFAULT_ISSUES,
    autoRecoverByDefault: prefs.autoRecoverByDefault ?? true,
    autoContinueRecovery: prefs.autoContinueRecovery ?? true,
    // On, like the server. An older console has never written the key, and a
    // `cmd:` ref cannot exist on a run that server never watched.
    watchCmdRefs: prefs.watchCmdRefs ?? true,
    watchMintedCmdRefs: prefs.watchMintedCmdRefs ?? false,
    // Only the exact word may stop a plan, matching the server's own coercion.
    // A console running an older server has never written the key, and reads
    // as the shipped default rather than as the behaviour it used to have.
    mcpPolicy: prefs.mcpPolicy === 'require' ? 'require' : 'continue',
    // The check (phase 134), as `server/config.ts` ships it: judgement on
    // unless the server wrote `false`, the checker on `sonnet` at `low`, and
    // three rejections escalate.
    checkJudgement: prefs.checkJudgement !== false,
    checkModel: prefs.checkModel || 'sonnet',
    checkEffort: prefs.checkEffort || 'low',
    turnEscalateAfter: prefs.turnEscalateAfter ?? 3,
  };
}

/**
 * The ladder's preferences (`server/config.ts` `DEFAULT_PREFS`), the shipped
 * values. Settings ▸ Automation's ladder card shows them as "shipped: …" and
 * `ladderPrefs()` falls back to them against a server that never wrote a key.
 */
export const LADDER_PREF_DEFAULTS = {
  ladderPerPhaseRungs: 3,
  ladderPerPhaseUsd: 100,
  ladderPerRunRungs: 10,
  ladderPerRunUsd: 400,
  ladderPerDayUsd: 600,
  ceilingStartsPerHour: 40,
  ceilingUsdPerHour: 250,
  unblockAttempts: true,
  staleClaimTakeover: true,
  autoAccountSwitch: true,
  usageForecastLeadHours: 2,
  usageForecastHold: false,
  delegateHumanGates: true,
  allowUnverifiedPhases: false,
  ladderExtendOnProgress: false,
  convergeEveryMs: 300_000,
  budgetAutoRaisePct: 25,
  mcpRequireTimeoutMs: 1_800_000,
} as const;

/**
 * The ladder's preferences with the server's own defaults applied — the same
 * one-place `?? default` rule as `automationPrefs`, for the knobs the ladder
 * card renders. The server sanitises on load and save (a finite number
 * ≥ 0, a real boolean), so these fallbacks only matter against an older server
 * that has never written the keys.
 */
export function ladderPrefs(state: ConsoleState | undefined): {
  ladderPerPhaseRungs: number;
  ladderPerPhaseUsd: number;
  ladderPerRunRungs: number;
  ladderPerRunUsd: number;
  ladderPerDayUsd: number;
  ceilingStartsPerHour: number;
  ceilingUsdPerHour: number;
  unblockAttempts: boolean;
  staleClaimTakeover: boolean;
  autoAccountSwitch: boolean;
  usageForecastLeadHours: number;
  usageForecastHold: boolean;
  delegateHumanGates: boolean;
  allowUnverifiedPhases: boolean;
  ladderExtendOnProgress: boolean;
  convergeEveryMs: number;
  budgetAutoRaisePct: number;
  mcpRequireTimeoutMs: number;
  /** The console's `policy.<key>` overrides as stored — empty means none. */
  policy: Partial<Record<string, string>>;
} {
  const prefs = state?.prefs ?? {};
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  const bool = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback;
  const d = LADDER_PREF_DEFAULTS;
  return {
    ladderPerPhaseRungs: num(prefs.ladderPerPhaseRungs, d.ladderPerPhaseRungs),
    ladderPerPhaseUsd: num(prefs.ladderPerPhaseUsd, d.ladderPerPhaseUsd),
    ladderPerRunRungs: num(prefs.ladderPerRunRungs, d.ladderPerRunRungs),
    ladderPerRunUsd: num(prefs.ladderPerRunUsd, d.ladderPerRunUsd),
    ladderPerDayUsd: num(prefs.ladderPerDayUsd, d.ladderPerDayUsd),
    ceilingStartsPerHour: num(prefs.ceilingStartsPerHour, d.ceilingStartsPerHour),
    ceilingUsdPerHour: num(prefs.ceilingUsdPerHour, d.ceilingUsdPerHour),
    unblockAttempts: bool(prefs.unblockAttempts, d.unblockAttempts),
    staleClaimTakeover: bool(prefs.staleClaimTakeover, d.staleClaimTakeover),
    autoAccountSwitch: bool(prefs.autoAccountSwitch, d.autoAccountSwitch),
    usageForecastLeadHours: num(prefs.usageForecastLeadHours, d.usageForecastLeadHours),
    usageForecastHold: bool(prefs.usageForecastHold, d.usageForecastHold),
    delegateHumanGates: bool(prefs.delegateHumanGates, d.delegateHumanGates),
    allowUnverifiedPhases: bool(prefs.allowUnverifiedPhases, d.allowUnverifiedPhases),
    ladderExtendOnProgress: bool(prefs.ladderExtendOnProgress, d.ladderExtendOnProgress),
    convergeEveryMs: num(prefs.convergeEveryMs, d.convergeEveryMs),
    budgetAutoRaisePct: num(prefs.budgetAutoRaisePct, d.budgetAutoRaisePct),
    mcpRequireTimeoutMs: num(prefs.mcpRequireTimeoutMs, d.mcpRequireTimeoutMs),
    policy: prefs.policy && typeof prefs.policy === 'object' ? { ...prefs.policy } : {},
  };
}

/** The shell's fetchers — merged into `api` by `./index`. */

/**
 * Each lane verb's route, spelled out (control-tower phase 31): the dispatcher
 * answers `isolate`, `isolate-phase` and `yield` as rows of their own, and
 * `test/route-coverage.test.ts` holds every route to a caller it can read.
 */
const LANE_PATHS: Readonly<Record<string, string>> = Object.freeze({
  pin: '/api/lane/pin',
  unpin: '/api/lane/unpin',
  reserve: '/api/lane/reserve',
  unreserve: '/api/lane/unreserve',
  yield: '/api/lane/yield',
  'isolate-phase': '/api/lane/isolate-phase',
  isolate: '/api/lane/isolate',
});
export const stateApi = {
  /* ---- shell ---- */
  state: () => request<ConsoleState>('/api/state'),
  /**
   * `/api/state` with its projection widened (`?include=runs|full`,
   * `shared/projection.js`): the default carries run SUMMARIES; `runs`
   * restores the whole records and `full` everything. For a reader that needs
   * the whole of it — never the shell's every-page read.
   */
  stateWith: (include: readonly StateInclude[]) =>
    request<ConsoleState>(`/api/state${include.length ? `?include=${include.join(',')}` : ''}`),
  /**
   * The admission queue: what holds a scope, and what is waiting on it —
   * widened since control-tower phase 99 (#135) to the whole view the queue
   * page draws: every entry's reason and holder in words, the lanes, the
   * hinted and withdrawn phases, and the audit strip.
   */
  queue: () => request<QueueView>('/api/queue'),
  /**
   * An operator's word on one phase's place (control-tower phase 99, #135):
   * `bump`, `hold`, `release`, `defer` (`until`), `withdraw`, `requeue`
   * (`position: 'front'`), `reorder` (`slug`, `phases`) — naming an entry by
   * `entryId` or a phase by `{slug, phase}`, with the `reason` it is written
   * down with. Durable: the mark is on the phase's record.
   */
  queueAct: (verb: string, body: Record<string, unknown>) =>
    post<QueueSnapshot & { change: { verb: string; slug: string; phase: number | null; changed: boolean } }>(
      `/api/queue/${encodeURIComponent(verb)}`,
      body,
    ),
  /**
   * An operator's word on a LANE (control-tower phase 100, #135 B.8, D.15–16):
   * `pin` / `unpin`, `reserve` / `unreserve`, `yield` (`to`), `isolate-phase`,
   * `isolate` — naming `{slug, phase}`, with the `reason` it is written down with.
   */
  laneAct: (verb: string, body: Record<string, unknown>) =>
    post<QueueSnapshot>(LANE_PATHS[verb] ?? `/api/lane/${encodeURIComponent(verb)}`, body),
  /** The scheduling policy (the console's, or `slug`'s) and the load guard's factor (control-tower phase 100). */
  queuePolicy: (body: { policy?: string | null; slug?: string; loadFactor?: number; reason?: string }) =>
    post<{ policy: NonNullable<QueueView['policy']>; load: QueueLoad }>('/api/queue/policy', body),
  /**
   * Move one queued entry to the front of its class.
   *
   * 404s on an entry that has already been admitted or cancelled — a stale id
   * from a page left open must not read as a successful move. It never crosses
   * a class boundary; an operator who wants that has the priority control,
   * which says so out loud. See `Scheduler.bump`.
   */
  queueBump: (entryId: string) => post<QueueSnapshot>('/api/queue/bump', { entryId }),
  /**
   * The order a run's OWN queued phases board in (control-tower phase 99,
   * #135): the whole list, the first boarding first. Never across runs — the
   * scan's classes decide that — and durable, as every queue mark is.
   */
  queueReorder: (slug: string, phases: readonly number[]) =>
    post<QueueSnapshot & { change: { verb: string; slug: string; phase: number | null; changed: boolean } }>(
      '/api/queue/reorder',
      { slug, phases },
    ),
  /**
   * Stop the queue waiting on a terminal session (control-tower phase 82,
   * #119): for `hours`, or — with none — for as long as that session lives.
   * 404s on a session the registry does not know; 403s without `--allow-run`.
   */
  releaseSessionHold: (sessionId: string, hours?: number) =>
    post<{ ok: true; sessionId: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/release`,
      hours ? { hours } : {},
    ),
  /**
   * The panic button. Freeze every live lane where it stands and hold every
   * list; thaw puts the whole fleet back exactly where it was.
   *
   * 409s when there is nothing to do — freezing an already-frozen console must
   * not read as having just frozen it, or the moment an operator then quotes
   * is the wrong one. Both are `--allow-run`-gated: a console that starts
   * nothing has nothing to stop.
   */
  fleetFreeze: (by?: string) =>
    post<{ fleet: FleetState; runs: number }>('/api/fleet/freeze', by ? { by } : {}),
  fleetThaw: (by?: string) => post<{ fleet: FleetState; runs: number }>('/api/fleet/thaw', by ? { by } : {}),
  /* The boot hold's release (SHD-5, FLT-9): the marker cleared, and the held
   * re-adoption and convergence run now. Run-class, like the thaw. */
  releaseBootHold: () =>
    post<{ ok: boolean; was?: NonNullable<BootHold>['kind']; bootHold: BootHold | null }>(
      '/api/automation/hold/release',
      {},
    ),
  /** Each phase's scope and what it would collide with if started right now. */
  runScopes: (slug: string) =>
    request<{ scopes: PhaseScope[] }>(`/api/run/${encodeURIComponent(slug)}/scopes`),
  savePrefs: (patch: Record<string, unknown>) => post<unknown>('/api/prefs', patch),
  /** Answer "your restart stopped these runs — shall I pick them up?" */
  bootResume: (decision: 'continue' | 'dismiss', runId?: string) =>
    post<BootResumeAnswer>('/api/boot-resume', runId ? { decision, runId } : { decision }),
};
