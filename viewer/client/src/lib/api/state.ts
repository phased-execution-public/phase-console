/**
 * The console shell — what `/api/state` reports, the admission queue, and the
 * server-side preferences with their shipped defaults.
 *
 * Shapes mirror `server/service.ts` and `server/config.ts`. Hand-written rather
 * than generated, like every module here: a shape that drifts is a server
 * change, and a server change is a decision, not an accident.
 */

import { request, post } from './client';
import type { SchedulePolicy } from '@shared/schedule-policy.js';
import type { ResumeAtBootMode } from '@shared/automation-model.js';
import { type RunPriority } from '@shared/orchestration-model.js';
import {
  isolationMode,
  reclaimModeOf,
  settleOf,
  WORKTREE_DEFAULTS,
  type IsolationMode,
  type IsolationReclaim,
  type SettleStrategy,
  worktreeRootOf,
  type WorktreeRoot,
} from '@shared/worktree-model.js';
import type { McpPolicy } from './runs';
import type { GitMode, HolderKind, ReviewerPolicy } from '@shared/run-lifecycle.js';

/* ---------------- shapes ----------------
 * Only what the shell reads in this phase is typed. Views type their own as
 * they are ported; `unknown` is deliberate where a shape is not yet load-bearing. */

/** A directory the console has read, as `/api/state` reports it. */
export interface RootInfo {
  path?: string;
  label?: string;
  ok?: boolean;
  docsDir?: string;
  plansDir?: string;
  planCount?: number;
  handoffCount?: number;
  reason?: string;
}

/** The phase weights and session budgets the engine's `sizing.env` declares. */
export interface Sizing {
  S?: number;
  M?: number;
  L?: number;
  budgetBig?: number;
  budgetHaiku?: number;
  [key: string]: number | undefined;
}

/**
 * What `lifecycle.ts` reports about whatever started this process.
 *
 * `supervised` — not `ok`. The field was declared as `ok` here and has always
 * been sent as `supervised`, so every read of it was `undefined`; nothing
 * happened to notice because only `detail` was ever read. A page that gated a
 * button on it would have found the console permanently unsupervised.
 */
export interface SupervisorInfo {
  /** Whether a clean exit is expected to come back. */
  supervised?: boolean;
  kind?: 'launchd' | 'systemd' | 'declared' | 'none';
  detail?: string;
  /** True when supervision is inferred rather than read from a plist. */
  assumed?: boolean;
}

/**
 * How full the console is right now: lanes in use, lanes allowed, and anything
 * waiting for a scope to clear.
 *
 * `throttledUntil` is an ACCOUNT usage window, not a per-run one — the soonest
 * expiry across every throttled account, kept for older readers. With several
 * accounts, `throttledAccounts` says which login was told to come back when;
 * a run paying with a different one keeps going.
 */
export interface Concurrency {
  max: number;
  live: number;
  queued: number;
  throttledUntil: number | null;
  throttledAccounts?: { accountId: string; until: number }[];
  /**
   * The boarding schedule's answer at the moment of the snapshot, or null when
   * no policy is set. Present even when OPEN, so a header can say what the
   * schedule thinks without a phase having to fail to start first.
   */
  schedule?: { open: boolean; opensAt: number | null; reason: string | null } | null;
}

/**
 * The panic button's state: is this whole console frozen, since when, by whom?
 *
 * One shape read from two places — `/api/state` (where the app-wide banner
 * gets it) and the `run:queue` event (which the freeze/thaw verbs emit) — so
 * the banner and the queue page can never disagree about whether the console
 * is switched off.
 */
export interface FleetState {
  frozen: boolean;
  at: string | null;
  by: string | null;
}

/** Who is holding a scope an entry is waiting on, and which tokens collided. */
export interface QueueHolder {
  kind: HolderKind;
  slug: string;
  phase: number | null;
  owner: string;
  scope: string[];
  overlaps: string[];
  /** When a `lock` holder's lease lapses (ms epoch) — "lease ends <t>". */
  leaseUntil?: number;
  /**
   * The branch this holder's work rides, when it declared one.
   *
   * The scheduler has carried it since phase 8 (`Holder.branch`) and this type
   * dropped it. Reported, never acted on: by the time a holder exists the
   * branch question has already been asked and answered against it. Its job is
   * to let the wait read in reverse — "queued behind X, **and X is on your
   * branch**" is the difference between a collision that could have been carved
   * out of and one that could not.
   */
  branch?: string;
  /** The working tree the holder's work rides, when it declared one. */
  tree?: string;
  /**
   * How much longer the holder's OWN plan has (`Holder.eta`).
   *
   * The question a queue could not answer: *how long*. Absent whenever nothing
   * of that plan has finished, because there is then no rate to measure — and
   * a number invented for the card would read exactly like a measured one.
   */
  eta?: { remainingWeight?: number; label?: string };
  /**
   * The holding session's id (`Holder.session`, off the lock's `session=`).
   *
   * Third of the three fields the scheduler has always sent and this type
   * dropped — `entryFields` passes `waitingOn` through verbatim, so every one
   * of them has been on the wire the whole time. Without it a queue can say a
   * session is in the way and give no way to go and look at it.
   */
  session?: string;
  /**
   * What the session registry says about that session (`Holder.presence`).
   *
   * `live` — somebody (or another console) is in it right now, so this is a
   * queue to WAIT IN rather than a lease to outlive; `unknown` — no hook
   * reports it and the lease rules decide. An `ended` session's lock never
   * reaches a holder at all: it lapses the moment the registry says so.
   *
   * The distinction is the difference between "this clears when they finish"
   * and "this clears when the lease lapses", and a page that cannot draw it
   * offers a takeover for the first and patience for the second.
   */
  presence?: 'live' | 'unknown';
  /**
   * This holder is a CLOCK, not another actor (`Holder.clock`): the operator's
   * boarding window, the live-session cap, an account's usage wall, a fleet
   * freeze, a hold, a chain.
   *
   * ⚠️ **Never render a clock as somebody to go and find.** There is nobody to
   * name, nothing to release, and the wait ends by itself at a moment that is
   * already known. `kind: 'reserved'` is the neighbouring signal but not the
   * same one — the scheduler sets `clock` explicitly, and the runner's own
   * admission cap reads it so that a wait on a clock is never capped into a
   * park (D2: parking a phase for waiting exactly as long as it was told to is
   * the console punishing its own policy).
   */
  clock?: true;
}

export interface QueueEntry {
  id: string;
  slug: string;
  phase: number | null;
  runId: string;
  scope: string[];
  /**
   * The branch THIS entry's session would commit on, when qualified. The
   * server has always sent it (`entryFields`); this type dropped it, so the
   * queue page could name the holder's branch and never the requester's —
   * "you: pe/x · them: pe/y" needs both halves.
   */
  branch?: string;
  /** The working tree this entry's session would edit, when qualified. */
  tree?: string;
  since: number;
  waitingOn: QueueHolder[];
  bypassed: number;
  reserving: boolean;
  /** The scan class. Absent means `normal` — see `shared/orchestration-model.js`. */
  priority?: RunPriority;
  /** An operator moved this entry to the front of its class. */
  bumped?: true;
  /** The run is held: nothing of it boards until someone releases it. */
  held?: { at: string; by?: string };
  /** The plan this entry is chained behind and still waiting on. */
  after?: string;
}

/**
 * What it would cost to let one queued plan go first — advisory ONLY.
 *
 * Nothing on the server reads this back: the scheduler never reorders itself,
 * and this is the figure an operator looks at before deciding to. Every field
 * is nullable because an estimate exists only once something of that plan has
 * finished, and a made-up number would be indistinguishable from a measured
 * one on the page that draws it.
 */
export interface QueueAdvice {
  slug: string;
  remainingWeight: number | null;
  remainingPhases: number | null;
  label: string | null;
}

export interface QueueSnapshot extends Concurrency {
  grants: { id: string; slug: string; phase: number | null; runId: string; scope: string[]; at: number }[];
  entries: QueueEntry[];
  /**
   * Present on `GET /api/queue` and deliberately absent from the `state`
   * payload and the `run:queue` event: it costs a board read per queued plan,
   * and those two are emitted on every admission change.
   */
  advice?: QueueAdvice[];
}

/** A phase's declared scope, and what it would collide with if started now. */
export interface PhaseScope {
  phase: number;
  scope: string[];
  conflicts: string[];
}

export interface InstanceInfo {
  id: string;
  name: string;
  /** A console that serves one project and refuses to be repointed. */
  pinned: boolean;
}

export interface ConsoleState {
  generation?: number;
  root?: RootInfo;
  /**
   * Which console this is, on a machine that may be running several.
   *
   * Optional like everything else on this type: a new client can be talking to
   * a server started before instances existed, and every consumer must read a
   * missing answer as "this server cannot say" rather than inventing one.
   */
  instance?: InstanceInfo;
  allowWrites?: boolean;
  allowRun?: boolean;
  /** The environment doctor's findings (PATH rot, broken push delivery). */
  environment?: { issues: { kind: string; detail: string; fix: string }[] };
  /** `--allow-terminal`: the shell gate the nav reads on every page. */
  allowTerminal?: boolean;
  /** `--allow-agent`: interactive claude sessions in the browser terminal. */
  allowAgent?: boolean;
  /** `--allow-accounts`: registering Claude accounts. The meters are always on. */
  allowAccounts?: boolean;
  /**
   * Whether MCP servers may be REGISTERED here. Reading the registry, the
   * catalog and the connection statuses never needs it.
   */
  allowMcp?: boolean;
  /**
   * `--allow-webhooks`: whether outbound webhook destinations may be
   * REGISTERED here — and, underneath, whether any POST is made at all.
   * Reading the destination list never needs it.
   */
  allowWebhooks?: boolean;
  autopilot?: boolean;
  /** True once `server/` on disk is newer than the process serving this page. */
  serverStale?: boolean;
  /** Which static root answered — the migration seam, surfaced in Settings. */
  staticRoot?: 'dist' | 'not-built';
  /** The commit `dist` was built from (`dist/.build-rev`); null when unstamped. */
  distRev?: string | null;
  supervisor?: SupervisorInfo;
  unread?: number;
  scriptsDir?: string;
  /**
   * Skills a NEW run would start with (`--default-skills` /
   * `PHASE_CONSOLE_DEFAULT_SKILLS`). Not what a run HAS — that is on the run.
   */
  defaultSkills?: string[];
  /**
   * Every model this console will START a phase on, strongest first — the
   * server's own `offeredModels()`, read from `scripts/models.env`.
   *
   * Optional like everything else here: an older server cannot say, and the
   * form falls back to its build's copy rather than offering nothing. Offering
   * and ACCEPTING are different questions — the door still takes any spelling
   * `models.env` knows, including ones absent from this list.
   */
  models?: string[];
  /**
   * `--remote` / `--remote-user`. Optional like everything else here: a new
   * client can be talking to a server started before these existed, and a
   * missing answer must read as "this server cannot say", never as "none".
   */
  remoteHosts?: string[];
  remoteUsers?: string[];
  /** The port this console is served on — setup commands embed it. */
  port?: number;
  /** Which OS the SERVER runs on — the setup commands differ per platform. */
  platform?: string;
  /** The server's home dir, so absolute paths render as "$HOME/…". */
  home?: string;
  sizing?: Sizing;
  searchDocs?: number;
  repo?: {
    available?: boolean;
    branch?: string;
    ahead?: number;
    behind?: number;
    dirty?: string[];
  };
  recentRoots?: { path: string; label: string }[];
  watcher?: { ok?: boolean; detail?: string };
  health?: unknown;
  /**
   * Every live run. The singular `run` field is gone — "the first live run of
   * ANY plan" reads plan B's run while looking at plan A the moment two drive.
   */
  runs?: unknown[];
  /** How full the console is, straight from the scheduler. */
  concurrency?: Concurrency;
  /**
   * The panic button: is this whole console frozen, since when, by whom?
   *
   * On the state rather than only on `/api/queue` because the banner it drives
   * renders on EVERY destination — a frozen console has to say so on whatever
   * page the operator is looking at, not only on the one about runs.
   * Absent from an older server, which reads as not frozen.
   */
  /**
   * Runs this console's own restart stopped, waiting on an answer
   * (`resumeAtBoot: 'ask'`). Empty on every normal load; the app opens the
   * question only when there is one. Absent on a server before 3.5.0.
   */
  resumeAsk?: { slug: string; runId: string; phases: number[]; sessions: string[]; at: string }[];
  fleet?: FleetState;
  /**
   * Server-side preferences. `notify` is the global per-category switch the
   * console consults before it announces anything at all — it is server truth
   * and deliberately NOT mirrored into `lib/prefs.ts` (browser-local UI
   * settings), because a notification suppressed in one tab has to stay
   * suppressed for the process, not for the tab that happened to set it.
   */
  prefs?: {
    notify?: Record<string, boolean>;
    /**
     * Automation defaults — the opening values for every launch surface. Each
     * launch can override them for itself. Resolve absent keys through
     * `automationPrefs`, never ad hoc, so every surface agrees on defaults.
     */
    attachDefaultSkills?: boolean;
    qaByDefault?: boolean;
    gitMode?: GitMode;
    openPrOnComplete?: boolean;
    /**
     * What a finished work branch does by default — `SETTLE_STRATEGIES`.
     *
     * The newer, more specific spelling of `openPrOnComplete`. Never read on
     * its own: a `config.json` written before it existed carries only the
     * boolean, and the server hands back a `settle` that is merely the shipped
     * default beside it. `automationPrefs` below does the fold.
     */
    settle?: SettleStrategy;
    reviewEachPhaseByDefault?: boolean;
    reviewerPolicy?: ReviewerPolicy;
    repoGuard?: boolean;
    /**
     * What a new run ASKS for: the shared checkout (`queue`, today's behaviour)
     * or one of its own. Meaningful only with `gitMode: 'new-branch'` — which
     * is why the launch dialog renders its control only there.
     */
    isolation?: IsolationMode;
    worktreeMaxConcurrent?: number;
    worktreeSetup?: string;
    worktreeCopyEnv?: boolean;
    /** Where console-made trees live: inside the project (`.worktrees/`) or the state directory. */
    worktreeRoot?: WorktreeRoot;
    /** May a run switch a CLEAN checkout off its run branch to take it? */
    isolationReclaim?: IsolationReclaim;
    /** Delete `pe/*` branches once their pull request has MERGED (`-d` only). */
    deleteMergedRunBranches?: boolean;
    autoRecoverByDefault?: boolean;
    autoContinueRecovery?: boolean;
    watchCmdRefs?: boolean;
    mcpPolicy?: McpPolicy;
    /** The remediation ladder's caps and toggles (server `Prefs`; Settings ▸ Automation renders them). */
    ladderPerPhaseRungs?: number;
    ladderPerPhaseUsd?: number;
    ladderPerRunRungs?: number;
    ladderPerRunUsd?: number;
    ladderPerDayUsd?: number;
    unblockAttempts?: boolean;
    staleClaimTakeover?: boolean;
    /**
     * `ask` (shipped) · `auto` · `off`. A boolean on a console from before
     * 3.5.0 — read it through `resumeAtBootMode`, never directly, because a
     * stored `true` means `ask` and not `auto`.
     */
    resumeAtBoot?: ResumeAtBootMode | boolean;
    autoAccountSwitch?: boolean;
    /** A `human` gate is briefed to the phase's own session to verify and clear. Off by default — see `server/config.ts`. */
    delegateHumanGates?: boolean;
    /** A phase whose plan states no §Verification boards and passes on its handoff alone. Off by default. */
    allowUnverifiedPhases?: boolean;
    /** One more rung, once per phase, when the newest settled rung landed commits. Off by default. */
    ladderExtendOnProgress?: boolean;
    convergeEveryMs?: number;
    /** A spent run budget is raised ONCE by this percentage (0 = never) — the resource ladder's `raise-budget` rung. */
    budgetAutoRaisePct?: number;
    /** How long a `require` MCP park waits for the server before continuing without it (0 = forever). */
    mcpRequireTimeoutMs?: number;
    /**
     * When a live lane stops being work (`shared/attention-model.js`
     * `STALL_DEFAULTS`, Phase 5). Thresholds, not policy: crossing one
     * announces and journals, it never acts — with the single exception of
     * `stallExternalWaitMs`, which parks the phase and releases its lock,
     * because a lane waiting on somebody else's clock is holding an exclusive
     * claim that blocks every session whose scope intersects it.
     */
    stallSilentMs?: number;
    stallSpinTurns?: number;
    stallStalemateAttempts?: number;
    stallRetryBurst?: number;
    stallExternalWaitMs?: number;
    /** The same call when it waits on a job this session started itself. */
    stallLocalJobMs?: number;
    /**
     * The clock on the ANNOUNCEMENT rather than on a detector: how long before
     * a stall the operator has not acted on is said again.
     *
     * Declared late — `ladder.tsx` has read it since it shipped, through the
     * index signature below rather than through a field, so it type-checked
     * while being invisible to every reader of this type. That is the same
     * shape of gap as `settle` being in the prefs loader and not the writer,
     * and it is fixed here for the same reason.
     */
    stallEscalateMs?: number;
    /**
     * When this console is willing to START phases (`shared/schedule-policy.js`).
     * `enabled: false` — the default — means every hour boards. Recoveries are
     * exempt: the schedule governs what the autopilot starts, never what an
     * operator asks for.
     */
    boardingSchedule?: SchedulePolicy;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

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
  isolation: IsolationMode;
  worktreeMaxConcurrent: number;
  worktreeSetup: string;
  worktreeCopyEnv: boolean;
  worktreeRoot: WorktreeRoot;
  isolationReclaim: IsolationReclaim;
  deleteMergedRunBranches: boolean;
  autoRecoverByDefault: boolean;
  autoContinueRecovery: boolean;
  watchCmdRefs: boolean;
  mcpPolicy: McpPolicy;
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
    autoRecoverByDefault: prefs.autoRecoverByDefault ?? true,
    autoContinueRecovery: prefs.autoContinueRecovery ?? true,
    // On, like the server. An older console has never written the key, and a
    // `cmd:` ref cannot exist on a run that server never watched.
    watchCmdRefs: prefs.watchCmdRefs ?? true,
    // Only the exact word may stop a plan, matching the server's own coercion.
    // A console running an older server has never written the key, and reads
    // as the shipped default rather than as the behaviour it used to have.
    mcpPolicy: prefs.mcpPolicy === 'require' ? 'require' : 'continue',
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
  unblockAttempts: true,
  staleClaimTakeover: true,
  autoAccountSwitch: true,
  delegateHumanGates: false,
  allowUnverifiedPhases: false,
  ladderExtendOnProgress: false,
  convergeEveryMs: 300_000,
  budgetAutoRaisePct: 25,
  mcpRequireTimeoutMs: 1_800_000,
} as const;

export type LadderPrefs = {
  ladderPerPhaseRungs: number;
  ladderPerPhaseUsd: number;
  ladderPerRunRungs: number;
  ladderPerRunUsd: number;
  ladderPerDayUsd: number;
  unblockAttempts: boolean;
  staleClaimTakeover: boolean;
  autoAccountSwitch: boolean;
  delegateHumanGates: boolean;
  allowUnverifiedPhases: boolean;
  ladderExtendOnProgress: boolean;
  convergeEveryMs: number;
  budgetAutoRaisePct: number;
  mcpRequireTimeoutMs: number;
};

/**
 * The ladder's preferences with the server's own defaults applied — the same
 * one-place `?? default` rule as `automationPrefs`, for the thirteen knobs the
 * ladder card renders. The server sanitises on load and save (a finite number
 * ≥ 0, a real boolean), so these fallbacks only matter against an older server
 * that has never written the keys.
 */
export function ladderPrefs(state: ConsoleState | undefined): LadderPrefs {
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
    unblockAttempts: bool(prefs.unblockAttempts, d.unblockAttempts),
    staleClaimTakeover: bool(prefs.staleClaimTakeover, d.staleClaimTakeover),
    autoAccountSwitch: bool(prefs.autoAccountSwitch, d.autoAccountSwitch),
    delegateHumanGates: bool(prefs.delegateHumanGates, d.delegateHumanGates),
    allowUnverifiedPhases: bool(prefs.allowUnverifiedPhases, d.allowUnverifiedPhases),
    ladderExtendOnProgress: bool(prefs.ladderExtendOnProgress, d.ladderExtendOnProgress),
    convergeEveryMs: num(prefs.convergeEveryMs, d.convergeEveryMs),
    budgetAutoRaisePct: num(prefs.budgetAutoRaisePct, d.budgetAutoRaisePct),
    mcpRequireTimeoutMs: num(prefs.mcpRequireTimeoutMs, d.mcpRequireTimeoutMs),
  };
}

/** The shell's fetchers — merged into `api` by `./index`. */
export const stateApi = {
  /* ---- shell ---- */
  state: () => request<ConsoleState>('/api/state'),
  /** The admission queue: what holds a scope, and what is waiting on it. */
  queue: () => request<QueueSnapshot>('/api/queue'),
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
  /** Each phase's scope and what it would collide with if started right now. */
  runScopes: (slug: string) =>
    request<{ scopes: PhaseScope[] }>(`/api/run/${encodeURIComponent(slug)}/scopes`),
  savePrefs: (patch: Record<string, unknown>) => post<unknown>('/api/prefs', patch),
  /** Answer "your restart stopped these runs — shall I pick them up?" */
  bootResume: (decision: 'continue' | 'dismiss', runId?: string) =>
    post<{ answered: string[]; decision: string }>(
      '/api/boot-resume',
      runId ? { decision, runId } : { decision },
    ),
};
