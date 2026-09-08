/**
 * `service`: the module prologue — types, constants and pure helpers.
 *
 * A LEAF by design. The class this file serves is split across an `extends`
 * chain, and every link in that chain needs these declarations; if they had
 * stayed in the file holding the final class, each link would import its own
 * descendant and the cycle would be immediate. Nothing here imports a chunk,
 * so nothing here can close a loop.
 *
 * Re-exported by `service.ts` under the names it always had, so no importer
 * outside this folder is affected by the split.
 */

import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';

import { instanceId } from '../shared/instances.mjs';
import {
  INSTANCE, INSTANCE_STATE_DIR, SKILL_DIR, STATE_DIR, agentEnabled, checkRoot, distRev, rememberRoot, loadPrefs, savePrefs,
  serverIsStale, staticRoot,
  type Flags, type Prefs, type RootCheck,
} from './config.ts';
import {
  SessionRegistry, correlate, parseHookPayload,
  type RunLink, type SessionEventName, type SessionKind as RegistrySessionKind, type SessionRecord, type SessionView,
} from './sessions/registry.ts';
import { hooksStatus, installHooks, uninstallHooks, type HooksStatus, type HooksWrite } from './hooks-install.ts';
import { Store, handoffFor, lockFor, qaFor, readLock, type PlanRecord } from './store.ts';
import {
  ConvergeScheduler, convergePlan, HALT_DELAY_MS, type ConvergeDeps, type ConvergeReport, type ConvergeTrigger, convergeView, type ConvergeView } from './converge.ts';
import { planWrite, runWrite } from './writes.ts';
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
import {
  rungsToday, spendSummary, type PlanCostView, type SpendRunView, type SpendView,
} from './analysis/spend.ts';
import {
  buildInbox, inboxIds, pruneAcks, readAcks, removeAck, writeAck,
  INBOX_ACKS_DIR, type InboxAck, type InboxFacts, type InboxView,
} from './inbox.ts';
import { STALL_SIGNAL_META, inboxItemId, parseInboxItemId } from '../shared/attention-model.js';
import { deriveEvidence } from '../shared/evidence-model.js';
import {
  planStats, portfolio, etaSamples, etaFrom, rateFor, phaseEtaFor, healthIssues, isClosedStatus, splitRepos,
  type PlanStats, type Portfolio, type PlanContext, type EtaEstimate, type EtaSample,
  type PhaseEta, type RateReading, type Forecast,
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
import type { McpDegradation, PhaseRecord as RunPhaseRecord } from './runner/state.ts';
import { formatScope, scopeOfRow, scopesIntersect } from '../shared/scope.js';
import {
  KIND_PROFILE, NO_HANDOFF_AUTO_RE, VERIFICATION_AUTO_RE, isRecoveryClass, recoveryActionsFor,
} from '../shared/recovery-model.js';
import { environmentReport, type EnvIssue } from './env-doctor.ts';
import { Terminals, type SessionEvent, type SessionInfo, type SessionKind } from './terminal.ts';
import { Journal } from './runner/journal.ts';
import {
  FREEZE_ESCALATE_MS, escalatePersistedFreeze, freezeVerdict, type PersistedEscalation,
} from './runner/freeze.ts';
import type { LaneLiveness } from './runner/liveness.ts';
import { appendAck as appendRulingAck, ingestRulings, readRulings, rulingsFile, type Ruling } from './runner/rulings.ts';
import {
  autoResolveRun, childrenOf, latestRun, listRuns, loadRun, newRun, phaseRecord, pidAlive,
  reconcileRecordsAgainstBoard, resetForRetry, resolveRunsAgainst, saveRun,
  slugsNeedingBoard, runDir, IN_FLIGHT, PHASE_IN_FLIGHT, RESOLVABLE, isMcpPolicy, mcpReasonText,
  type BoardingBrief, type Errand, type McpPolicy, type PreflightWarning, type RungRecord, type RunState, type VerifySummary,
} from './runner/state.ts';
import {
  consumeOutcome, inboxOutcomePhase, outcomeFileFor, outcomeInboxDir, readOutcome, type PhaseOutcome,
} from './runner/outcome.ts';
import { readTranscript, transcriptFile, type TranscriptEntry } from './runner/transcript.ts';
import { extractCommands, resolveLead, unresolvableLeads, verifyPhase } from './runner/verify.ts';
import { loadVerifyEnv } from './runner/verify-env.ts';
import { checkAuth, checkAuthFor, forgetAuth, openLoginTerminal, openCommandTerminal, shellQuote, type AuthStatus } from './runner/auth.ts';
import { Accounts, DEFAULT_ACCOUNT_ID, profileConfigDir, type AccountView } from './accounts/index.ts';
import { Mcp, type McpServerView } from './mcp/index.ts';
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
import { BLOCKED_ON } from '../shared/plan-vocab.js';
import type { Presence } from '../shared/run-lifecycle.js';
import {
  Approvals, classifyTool, matchedDenyRule, loadPolicy, loadPolicyFor, policyExtras, addPolicyRules,
  editPolicy, planPolicyPath, effectivePlanPolicyPath, notifyOutOfBand, carvedPolicy, suggestedRule,
  autoApproveFor, neverAutoApproves, hitsHidden,
  parseRule, inertRules, HOOK_TOOLS, WRAPPERS_NOT_STRIPPED,
  PERMISSION_PROFILES, PROFILE_LABELS,
  DEFAULT_DENY, DEFAULT_ASK, DEFAULT_ALLOW, POLICY_PATH,
  type Evidence, type PolicyScope, type PermissionProfile,
} from './runner/approvals.ts';


/** The longest delay `setTimeout` can hold (2^31 − 1 ms ≈ 24.8 days); past it a clock waits for the next boot. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * A wait-resume clock that fired while the run's loop was still draining
 * re-checks this often instead of being consumed in silence — the drain is
 * minutes, and the clock it would drop is the run's ONLY wake.
 */
export const LIMIT_RESUME_RETRY_MS = 60_000;

/** One live update, with the id a reconnecting client replays from. */
export type LiveEvent = { id: number; event: string; data: unknown };
export type LiveListener = (event: string, data: unknown, id: number) => void;

/** Enough backlog to cover a browser reconnect, not a history. */
export const EVENT_BUFFER = 200;

export type PlanSummary = PlanStats & {
  engineError?: string;
  issueCounts: { error: number; warning: number; info: number };
  hasHandoffs: boolean;
  /**
   * How long this plan has left, cheap enough to send for every plan at once.
   *
   * The whole estimate rather than a pre-rendered string, so the ONE decision
   * about how an estimate reads — the range, and the hedge its `basis` earns —
   * stays in the one client formatter every surface calls. Absent on a plan with
   * nothing left to do; never absent for want of evidence, which is what `basis`
   * is for.
   */
  eta?: EtaEstimate;
};

/**
 * A claim on a phase, as a page needs to read it.
 *
 * Everything `parseLock` recovers from the lock file except its path — the
 * narrower shape this used to be (`owner`/`expired`/`leaseUntil`) could say
 * that a phase was held but never who by, on what machine, since when, or over
 * what scope, which is exactly the set of questions someone asks before
 * deciding whether to take a claim away from another session.
 */
export type PhaseLockView = {
  owner: string;
  expired: boolean;
  leaseUntil?: number;
  claimedAt?: number;
  host?: string;
  scope?: string[];
  /** The claiming session's own id (`session=` in the lock file) — what a
   * client needs to join a claim to the registry and the pty list. */
  session?: string;
};

/**
 * The one place a parsed lock becomes a lock a page can read.
 *
 * Two call sites used to narrow it by hand and had already drifted — the
 * per-phase one dropped `host`, the plan-level one kept it — so the same claim
 * described itself differently depending on which list you found it in.
 */
export function lockView(lock: {
  owner: string; expired: boolean; leaseUntil?: number;
  claimedAt?: number; host?: string; scope?: string[]; session?: string;
} | null | undefined): PhaseLockView | undefined {
  if (!lock) return undefined;
  return {
    owner: lock.owner,
    expired: lock.expired,
    leaseUntil: lock.leaseUntil,
    claimedAt: lock.claimedAt,
    host: lock.host,
    scope: lock.scope,
    session: lock.session,
  };
}

export type PhaseView = {
  phase: number;
  title: string;
  state: string;
  size: string;
  weight: number;
  gated: boolean;
  gates?: string;
  gateCheck?: string;
  /** The gate's category — who can clear it. Mirrors `--gate-kind`. */
  gateKind: GateKind;
  model?: string;
  effort?: string;
  goal?: string;
  readFirst?: string;
  files?: string;
  steps?: string;
  exitCriteria?: string;
  verification?: string;
  handoffMustRecord?: string;
  /** `?include=prose` — see `shared/projection.js`. Absent on the board projection. */
  bullets?: { label: string; body: string }[];
  row?: PhaseRow;
  analysis?: PhaseAnalysis;
  qa?: { result: string; report?: string };
  /**
   * THIS phase's QA regime, and which line answered (2026-09-07).
   *
   * `summary.qaMode` is the PLAN's word, and three surfaces judged "is this
   * phase held?" with it — wrong for a phase carrying its own `- **QA:** off`
   * under a plan-wide `on`, and the reverse. The engine has resolved the
   * regime per phase since the directive landed and `deriveEvidence` read it;
   * nothing carried it to the client. `source` is `phase` when the phase's own
   * bullet decided, `plan` otherwise.
   */
  qaMode?: { mode: QaMode['mode']; source: 'phase' | 'plan' };
  /**
   * The rounds `test-status.md` records for this phase — how many, and the
   * latest — so a surface can say "round 3 · fail" without fetching the run.
   * Absent for a phase with no round on the ledger.
   */
  qaRounds?: { count: number; latest: { round: number; result: string; report?: string } };
  /**
   * This console's own verdict on the phase's diff (`review.ts`).
   *
   * Absent means nobody has reviewed it here — never "approved by default".
   * `staleTip` says the phase has landed a commit since the verdict was given,
   * which is a fact the surface states rather than a rule anything enforces:
   * an approval is about a diff, and a diff that moved is not the one approved.
   */
  review?: {
    verdict: string; at: string; by?: string; note?: string;
    base?: string; tip?: string; staleTip?: boolean;
  };
  /**
   * The dependencies of this phase that have requested changes.
   *
   * Present and non-empty means the console holds this phase the way an
   * unapproved gate does — the runner refuses to board it. The engine knows
   * nothing about it, which is why the field names the PHASES rather than
   * claiming a board state: a surface must be able to say whose hold this is.
   */
  reviewHold?: number[];
  lock?: PhaseLockView;
  handoff?: {
    file: string; status: string; completed?: string; title: string;
    outstanding?: string; skillsUsed: string[]; prompts: number;
  };
  /**
   * Claimed versus evidenced (`shared/evidence-model.js`).
   *
   * The plan page's whole job is to say what is done, and `done` here has only
   * ever meant "a handoff says so". This carries the second half of that
   * sentence — what, if anything, actually ran — so a phase table can show the
   * difference instead of implying there is none.
   */
  proof?: EvidenceView;
  /**
   * What, if anything, is working this phase right now (`PhaseLive`).
   *
   * The other half of `proof`, and the one the board could not say at all:
   * `state` is a word out of a markdown file, and this is the process. ABSENT
   * means nothing live was found — never `false`, so that "no server sent it"
   * and "nothing is running" read alike to a client, which is the honest
   * degradation for a field a surface uses to decide whether to pulse.
   */
  live?: PhaseLive;
};

export type RouteView = {
  nodes: {
    phase: number; layer: number; row: number; state: string; size: string; gated: boolean;
    title: string;
    /**
     * Whether a station is claimed, and whether that claim still holds.
     *
     * A marker rather than the lock itself: the map draws a ring, and shipping
     * the whole lock object to every node would put an owner string on the wire
     * for a shape that has nowhere to render one.
     */
    locked?: 'live' | 'stale';
  }[];
  edges: { from: number; to: number }[];
  layers: number;
  rows: number;
};

export type PlanDetail = {
  summary: PlanSummary;
  /**
   * `slug`, `title`, `sessionBudget` and `path` are the board projection. The
   * rest is `?include=document` — `source-tab.tsx` is their only reader, and on a
   * 31-phase plan `architecture` + `context` alone are 20.5 KB.
   */
  plan: {
    slug: string; title: string; provenance?: string; context?: string; architecture?: string;
    endToEnd?: string; sessionBudget: unknown; graph?: PhaseRow[]; callouts?: string[];
    sections?: { title: string; body: string }[];
    path?: string;
  } | null;
  phases: PhaseView[];
  route: RouteView;
  batches: SessionPlan | null;
  boardText: string;
  lint: LintResult | null;
  handoffs: {
    phase: number; file: string; title: string; status: string; completed?: string;
    bytes: number; mtime: number; prompts: number; skillsUsed: string[];
  }[];
  index: { phase: number; title: string; status: string; link?: string }[];
  /**
   * How long the plan has left, and how long each phase would take on its own.
   *
   * `perPhase` is an array rather than a map keyed by phase because it is
   * derived render data, not run state: the pages that read it want it in plan
   * order, and a `.find` is the only lookup anything does. Both halves come from
   * ONE `RateReading`, so a phase row and the header above it can never disagree
   * about how fast this plan goes.
   */
  eta: { plan: EtaEstimate | null; perPhase: PhaseEta[] };
  /**
   * What this plan has cost, phase by phase — `analysis/spend.ts` `planCost`.
   *
   * Read off the plan's OWN run files, so it is money this console spent
   * driving this plan and nothing else. `residualUsd` is a reconciliation
   * check rather than a category: in a healthy run the per-phase figures sum
   * to the run totals exactly, so anything left over is a run file disagreeing
   * with itself.
   */
  cost: PlanCostView;
  /**
   * When the plan finishes, and everything that date rests on.
   *
   * Null exactly when `eta.plan` is — no remaining work, or no usable rate.
   * NOT `now + eta`: the working estimate is stretched by a measured duty
   * cycle, and `assumptions` is the list a reader must be shown beside the
   * date rather than have to go and look for.
   */
  forecast: Forecast | null;
  qa: { phase: number; result: string; report?: string }[];
  /**
   * Which phases each recorded verdict is holding, keyed by the phase whose
   * verdict it is (`qaHeldBy`). Held dependents existed only as client-side
   * prose before this; the board is the authority on what a verdict holds.
   */
  qaHeld: Record<number, number[]>;
  locks: (PhaseLockView & { phase: number })[];
  git: GitFileInfo & { dirty?: boolean };
  /**
   * `?include=memory`. ABSENT when it was not asked for; `null` when it was and
   * the plan has no memory file — two different facts, and the Source tab shows
   * a different thing for each.
   */
  memory?: { key: string; path: string; text: string; indexLines: string[] } | null;
};

/**
 * A phase someone else is holding right now.
 *
 * Its own class because the answer is 409, not 500: the request is well formed
 * and the caller did nothing wrong — the phase is simply being worked. Thrown
 * by every verb that would START a session on a named phase, so the refusal
 * cannot be an accident of which endpoint you happened to call.
 *
 * This used not to exist, and the consequence was worse than a missing error
 * type: `POST /api/run/<slug>/start` on a claimed phase answered 200, minted a
 * run, and only degraded to `parked` several subprocesses later inside the
 * runner. The console said a run had started; nothing ran.
 */
/** `POST /hooks/session` answered 400: the body is not a session event. */
export class HookPayloadError extends Error {}
/** `POST /hooks/session` answered 429: the bucket is empty. */
export class HookRateError extends Error {}

/** Session events accepted per minute — a person's sessions produce a few; a runaway loop must not write a storm. */
export const HOOK_EVENTS_PER_MINUTE = 300;
/**
 * Presence moves parked during service construction before the oldest is
 * dropped — see `ServiceBase.presenceBacklog`. A poisoned session inbox is
 * exactly what mints a lot of these at once, so the park is bounded: a boot
 * that cannot drain its own backlog is a second way to fall over at boot.
 */
export const PRESENCE_BACKLOG_MAX = 500;
/** Per-file debounce for the unsupervised-outcome inbox watcher. */
export const OUTCOME_INBOX_DEBOUNCE_MS = 250;
/**
 * How often the inbox is re-read from disk, whatever the watcher did.
 *
 * `fs.watch(dir, { recursive: true })` is the only thing that notices a
 * declaration today, and it is not a guarantee: a loaded machine drops events,
 * and the watcher's own error handler CLOSES it for the life of the console
 * with nothing to re-arm it. Either way the drop sits unread until the next
 * boot — and `phase-outcome.sh` is the session→runner channel, so what is lost
 * is a phase saying how it ended. A `readdir` per plan on a slow clock is the
 * cheapest possible floor under that.
 */
export const OUTCOME_INBOX_SWEEP_MS = 10_000;
/** An inbox declaration older than this is history, not news. */
export const OUTCOME_INBOX_MAX_AGE_MS = 24 * 60 * 60_000;
/** A `waiting-external` that names no window waits this long — the runner's own default. */
export const UNSUPERVISED_WAIT_DEFAULT_MS = 30 * 60_000;

export class PhaseClaimedError extends Error {
  /* Plain fields, assigned in the body. Constructor parameter properties are
     TypeScript that Node's strip-only loader cannot erase, and this server runs
     straight off its `.ts` — one `readonly slug: string` in a constructor
     signature refuses to start the whole console. */
  slug: string;
  phase: number;
  lock: { owner: string; host?: string; leaseUntil?: number };

  constructor(
    slug: string,
    phase: number,
    lock: { owner: string; host?: string; leaseUntil?: number },
  ) {
    super(
      `Phase ${phase} of ${slug} is claimed by ${lock.owner}`
      + (lock.host ? ` on ${lock.host}` : '')
      + (lock.leaseUntil ? ` — the lease runs until ${new Date(lock.leaseUntil).toISOString()}` : '')
      + '. Wait for that session, or release the claim.',
    );
    this.name = 'PhaseClaimedError';
    this.slug = slug;
    this.phase = phase;
    this.lock = lock;
  }
}

/** What became of one release attempt. Bulk releases return one per lock. */
export type LockRelease = {
  slug: string;
  phase: number;
  ok: boolean;
  /** The owner read from the lock file — null when there was no lock to read. */
  owner: string | null;
  detail?: string;
};

/**
 * What became of a run control that can refuse for a reason worth showing.
 *
 * `RunState | null` could say "it did not happen" and never why, so the route
 * had a single sentence for every refusal — "nothing is running for this plan"
 * — printed just as readily when something WAS running and the operator had
 * simply aimed at a phase that finished while their tap was in flight.
 */
export type ControlResult =
  | { ok: true; run: RunState | null }
  | { ok: false; reason: string };

/** A forward action the console can offer on a phase that is not done. */
export type RecoveryAction = {
  id: 'recheck' | 'closeout' | 'resume' | 'retry' | 'skip' | 'fix-agent'
    | 'mcp-continue' | 'continue-run' | 'release' | 'force-release' | 'dismiss';
  label: string;
  /** What it costs — the thing that was never stated on the old Retry button. */
  detail: string;
  /** How it acts: check | own-session | new-agent | run-control | claim | mcp. */
  mechanism?: string;
  /** Which console capability gates it (run | agent | writes), when one does. */
  flag?: string | null;
  /** Set on `fix-agent`: which agent briefing to launch. */
  recoveryClass?: string;
};

/**
 * Thrown when a run-verb targets a phase a live agent recovery session is
 * already editing. Routes answer it as the same 409-with-sessionId shape
 * `resolveRecovery` refusals use, so the client navigates to the session
 * instead of erroring.
 */
export class RecoveryBusyError extends Error {
  readonly sessionId: string;
  constructor(message: string, sessionId: string) {
    super(message);
    this.name = 'RecoveryBusyError';
    this.sessionId = sessionId;
  }
}

/**
 * What `shared/evidence-model.js` answers: the claim, and whether anything
 * backs it. Declared here rather than imported from the client, because the
 * shared module is JS with JSDoc and the server has no typecheck pass to read
 * it — the client mirrors this in `lib/evidence.ts` and the identity test in
 * `test/evidence-model.test.ts` is what stops the two drifting.
 */
export type EvidenceView = {
  board: string;
  handoff: string;
  verification: string;
  qa: string;
  /** Whether the claim is backed. Never named `done`. */
  evidenced: boolean;
  /** The board paints work in flight and nothing live was found behind it. */
  stale: boolean;
  why: string[];
};

/* ------------------------------------------------------------------ *
 * Liveness — the fact the board word is a claim about
 * ------------------------------------------------------------------ */

/**
 * Which witness saw a phase being worked. Mirrors `LIVE_VIA` in
 * `shared/evidence-model.js`, which is the one definition; this is the TS
 * shadow, and `test/evidence-model.test.ts` holds the two identical.
 */
export type PhaseLiveVia = 'run' | 'lock' | 'registry';

/**
 * Something observed to be working this phase RIGHT NOW.
 *
 * The field `PhaseView` was missing, and the whole of B2(a): the board's word
 * for a phase comes from `phase_status()` grepping `^status:` out of a
 * markdown file, `BOARD_STATE_UI` maps `in-progress` to `running`, and five
 * surfaces paint it — with nothing anywhere in the tree settling the sentence
 * against a process. A phase of one plan on this estate showed "Running"
 * for 18 DAYS over no run, no lock and no process.
 *
 * Three-valued in its `via`, and ABSENT when nothing is live — absence is the
 * answer, never `{live: false}`, so an older server and a genuinely idle phase
 * read the same way to a client that has never heard of the field.
 */
/**
 * WHO is driving it — the axis `via` deliberately is not. `via` names the
 * WITNESS; this names the VEHICLE: an autopilot lane (this console's or
 * another's), an interactive agent a console minted, or a session outside
 * every console. `PHASE_ACTORS` in `shared/status-vocab.js` is the one
 * definition; this is its TS shadow, allowed by name in
 * `test/vocab-owners.test.ts`.
 */
export type PhaseActor = 'autopilot' | 'agent' | 'external';

export type PhaseLive = {
  via: PhaseLiveVia;
  /** Who is driving — optional on the wire so an older server reads the same. */
  actor?: PhaseActor;
  /** The Claude session id, when the witness knows one — this is what a deep link needs. */
  session?: string;
  /** The process, when the witness knows one. Only `via: 'run'` ever does. */
  pid?: number;
};

/**
 * The facts the three witnesses offer, each already reduced to what it can
 * prove. Nothing here does I/O — the caller has already asked the probe, the
 * registry and the store, so this stays a pure decision that a test can drive.
 */
export type PhaseLiveFacts = {
  /**
   * The phase's newest run record on a SETTLED read (`loadRun` → `settle`),
   * plus this console's own answer about whether it is driving that run.
   * `inFlight` must be `PHASE_IN_FLIGHT.includes(record.status)` computed by
   * the caller, because a settled read has already demoted a record whose
   * process stopped holding work.
   */
  run?: { inFlight: boolean; session?: string; pid?: number } | null;
  /** The phase's lock, with the registry's word on the session it names. */
  lock?: {
    expired: boolean; presence: Presence; session?: string;
    /** The registry's kind for that session, when it holds a record. */
    kind?: RegistrySessionKind;
  } | null;
  /** The registry's own word on the session the run record last named. */
  registry?: {
    session: string; presence: Presence;
    kind?: RegistrySessionKind;
  } | null;
  /**
   * The claude session ids of THIS console's live ptys — the console's own
   * ground truth for `agent`, ahead of the registry's kind, because a pty
   * minted before `PE_OWNER` was set (or on a hook-less machine) still
   * registers as foreign.
   */
  ptySessions?: ReadonlySet<string>;
};

/**
 * Resolve the three witnesses into one answer, strongest first.
 *
 * The order is the decision, not an accident:
 *
 *  1. `run` — a record still in flight after `settleInFlightRecords` has had
 *     its say means either this console's loop is driving it or a probed
 *     process outlived a console. A process is a fact.
 *  2. `lock` — an unexpired claim whose own `session=` the registry positively
 *     vouches for. The register's line, finally acted on: "a lock naming a
 *     live session is a stronger liveness fact than the record but no surface
 *     prefers it". Note `presence === 'live'` and not `!== 'ended'`: an
 *     unexpired lock the registry cannot vouch for is a CLAIM, and painting a
 *     claim as a running process is the bug being fixed. What that lock is
 *     for is the scheduler's queue, not a pulsing chip.
 *  3. `registry` — the session is live although the run record was settled.
 *     The two probes disagreeing, with the registry's own heartbeat as the
 *     fresher fact: a console that restarted with an empty `children` map
 *     settles a record whose session is still very much working.
 */
export function phaseLive(facts: PhaseLiveFacts): PhaseLive | undefined {
  const run = facts.run;
  if (run?.inFlight) {
    return {
      via: 'run',
      actor: 'autopilot',
      ...(run.session ? { session: run.session } : {}),
      ...(run.pid ? { pid: run.pid } : {}),
    };
  }
  const lock = facts.lock;
  if (lock && !lock.expired && lock.presence === 'live') {
    return {
      via: 'lock',
      actor: actorOf(lock.session, lock.kind, facts.ptySessions),
      ...(lock.session ? { session: lock.session } : {}),
    };
  }
  const registry = facts.registry;
  if (registry?.session && registry.presence === 'live') {
    return {
      via: 'registry',
      actor: actorOf(registry.session, registry.kind, facts.ptySessions),
      session: registry.session,
    };
  }
  return undefined;
}

/**
 * The vehicle behind a lock- or registry-witnessed session. The console's own
 * pty list outranks the registry's kind (see `PhaseLiveFacts.ptySessions`);
 * the registry's `foreign` — and a session the registry has never heard of —
 * both fold to `external`, because "not one of ours" is the honest reading of
 * both.
 */
function actorOf(
  session: string | undefined,
  kind: RegistrySessionKind | undefined,
  pty: ReadonlySet<string> | undefined,
): PhaseActor {
  if (session && pty?.has(session)) return 'agent';
  if (kind === 'autopilot' || kind === 'agent') return kind;
  return 'external';
}

/**
 * Which phases each recorded verdict is holding — `Board.qa` (the verdict that
 * is the problem, keyed by ITS phase) joined with `Board.blockedBy` (every
 * waiting phase's unsatisfied dependencies). Only the phases a verdict actually
 * holds, in phase order; a verdict holding nothing is absent. Pure and
 * structural so a test drives it without an engine.
 */
export function qaHeldBy(board: { qa?: Record<number, string>; blockedBy?: Record<number, number[]> }): Record<number, number[]> {
  const out: Record<number, number[]> = {};
  for (const key of Object.keys(board.qa ?? {})) {
    const holder = Number(key);
    const held = Object.entries(board.blockedBy ?? {})
      .filter(([, deps]) => deps.includes(holder))
      .map(([phase]) => Number(phase))
      .sort((a, b) => a - b);
    if (held.length) out[holder] = held;
  }
  return out;
}

/**
 * The claude session ids of a console's live ptys, from `terminals.state()`.
 * Pure and structural so both `detail()` and the diagnosis can feed it and a
 * test can drive it without a Terminals.
 */
export function ptyClaudeSessions(
  sessions: readonly { kind: string; exited?: unknown; meta?: { claudeSessionId?: string } }[],
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const session of sessions) {
    if (session.kind !== 'claude' || session.exited) continue;
    const id = session.meta?.claudeSessionId;
    if (id) out.add(id);
  }
  return out;
}

/**
 * Event prefixes that can change what needs a person.
 *
 * A list rather than "everything", because `emit` is also how terminal bytes
 * and pty resizes travel, and a keystroke is not a reason to recompute the
 * inbox.
 */
export const INBOX_SOURCES = [
  'run:', 'approval', 'lock', 'account', 'mcp', 'health', 'plan', 'gate', 'qa', 'environment',
  // Registry beats too (a session's waiting flag is an inbox fact now). Every
  // attach/detach/turn-end schedules the same debounced 400 ms tick a run
  // event does — one refetch per beat, deliberately accepted.
  'sessions',
];

/**
 * Why an ask was answered without a person, one sentence per resolution level.
 * The level is real information: "this phase is set to" and "the default" tell
 * an operator two different places to go if they want it otherwise.
 */
export const AUTO_GRANT_REASONS = {
  phase: 'auto-granted — this phase is set to answer permission asks automatically',
  plan: "auto-granted — this plan's policy answers permission asks automatically",
  global: 'auto-granted — this console is set to answer permission asks automatically',
  default: 'auto-granted — the console answers permission asks automatically (the default)',
} as const;

export type PhaseDiagnosis = {
  runId: string;
  phase: number;
  status: string;
  /** Which of the three checks is standing in the way, when one is. */
  blockedOn: (typeof BLOCKED_ON)[number] | null;
  boardState: string;
  said: string | null;
  verification: VerifySummary | null;
  /** Where the commands ran, relative to the root — `.` when it is the root. */
  verifiedIn: string | null;
  lint: { ok: boolean; summary: string } | null;
  closeout: { at: string; ok: boolean; sessionId?: string; note?: string } | null;
  sessionId: string | null;
  resumable: boolean;
  note: string | null;
  workingTree: string[];
  lock: string | null;
  actions: RecoveryAction[];
  /**
   * The classifier's word for the phase (`runner/situation.ts`) — what the
   * unattended healer would act on — with the sentences that decided it.
   */
  situation: Situation | null;
  /** The evidence it was decided from, as short lines (`summariseEvidence`). */
  evidence: string[];
  /**
   * Claimed versus evidenced (`shared/evidence-model.js`).
   *
   * Named `proof` and not `evidence` because `evidence` above is already the
   * situation classifier's reasoning lines, and the two answer different
   * questions: those say why the healer chose a rung, this says whether the
   * phase's own "done" is backed by anything that ran. Never named `done`.
   */
  proof: EvidenceView;
  /**
   * What is working this phase right now, if anything (`PhaseLive`).
   *
   * The same three witnesses `detail()` asks, resolved the same way — so the
   * phase row's chip and this panel cannot say different things about the same
   * phase. Absent means nothing live was found.
   */
  live?: PhaseLive;
  /**
   * What sessions DECIDED on this phase (`runner/rulings.ts`), oldest first.
   *
   * On the diagnosis rather than only on the run because this is the panel
   * somebody opens when a phase did not go the way the plan said it would, and
   * "the session read the instruction the other way, and here is why" is the
   * answer more often than anything the verification output holds.
   */
  rulings: Ruling[];
};

/**
 * What a finished QA session left behind.
 *
 * `recorded` is the whole point: it is false for a session that ended without
 * writing a row, and `result` is then absent rather than inherited from
 * whatever the phase happened to read before.
 */
export type QaOutcome = {
  recorded: boolean;
  result?: string;
  report?: string;
  headline: string;
  detail: string;
};

/** The phase's title from the plan graph, when the table has one. */
export function titleOf(rows: PhaseRow[], phase?: number): string | undefined {
  if (phase == null) return undefined;
  return rows.find((row) => row.phase === phase)?.title || undefined;
}

/**
 * The owner a recovery session claims a phase as.
 *
 * Legible in a lock file and in `phase-lock.sh list`, which is the point: the
 * next person to find a claim needs to know a console opened it, not decode an
 * id. Same `<who>/<what>` shape the conventions use.
 */
export function recoveryOwner(request: RecoveryRequest): string {
  return request.phase != null ? `console/recover-p${request.phase}` : 'console/recover';
}

/**
 * What can still be done about a phase in this state.
 *
 * The invariant this exists to hold: **a phase that is not done always offers at
 * least one way forward.** A run that halted with its approval card expired had
 * none — the card could not be answered, the phase could not be closed, and the
 * only controls on the page re-ran or discarded work that was probably fine.
 * `test/recovery.test.ts` walks every terminal status and asserts this is never
 * empty.
 */
export function recoveryActions(
  status: string, resumable: boolean, situation?: { id: string; sub?: string } | null,
): RecoveryAction[] {
  // The words, the mechanisms and the ordering all come from the shared model
  // — this wrapper only keeps the wire shape the diagnosis payload has always
  // had (`detail`, not `blurb`). Flag gating is deliberately absent here: the
  // client holds the console's flags and computes its own disabled states.
  // The situation, when known, leads the ordering (additive — see the model).
  return recoveryActionsFor({ record: { status, resumable }, ...(situation ? { situation } : {}) }).map((action) => ({
    id: action.id as RecoveryAction['id'],
    label: action.label,
    detail: action.blurb,
    mechanism: action.mechanism,
    flag: action.flag,
    ...(action.recoveryClass ? { recoveryClass: action.recoveryClass } : {}),
  }));
}

/** `git status --porcelain`, or empty when it cannot be read. */
export function gitPorcelain(root: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain'], {
      cwd: root, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
    }, (error, stdout) => resolve(error ? '' : String(stdout).trim()));
  });
}

/**
 * One cached engine answer, keyed by the plan revision it was computed at.
 *
 * `value` is the **promise**, not the result, so an entry exists from the
 * moment the work starts rather than from the moment it finishes: concurrent
 * askers share one script run instead of each starting their own. `settled` is
 * the resolved value once it has landed, for the one caller that needs to know
 * whether an answer is ALREADY available without waiting for it — the plan
 * detail, which now renders without blocking on the lint.
 */
export type Cached<T> = { revision: number; value: Promise<T>; settled?: T };

/** The one line of a tool call that tells you what it is about to do. */
export function describeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'url', 'query', 'pattern']) {
    const value = record[key];
    if (typeof value === 'string' && value) return value.replace(/\s+/g, ' ').slice(0, 300);
  }
  return '';
}

/**
 * The model named inside a plan's `**Model:**` bullet.
 *
 * Plans write these as prose — "`claude-opus-5` (1M window)", "Opus for the
 * hard reasoning", "Haiku — mechanical". Passing that whole string to `--model`
 * would fail, so only a recognised name is taken and anything else is left to
 * the run's default rather than guessed at.
 *
 * The match keeps the whole model token, not just the family word. It used to
 * collapse to a bare alias, which meant a plan that carefully asked for
 * `claude-opus-5[1m]` ran on plain `opus`: the one part of the name the
 * operator wrote on purpose — the window — was the part thrown away, and the
 * board then sized the plan's sessions against a window it was not running on.
 */
export function modelAlias(text?: string): string | undefined {
  const match = /\b(?:claude-)?(?:fable|opus|sonnet|haiku)(?:-[0-9a-z.]+)*(?:\[1m\])?/i.exec(text ?? '');
  return match ? match[0].toLowerCase() : undefined;
}

/** The same, for `**Effort:**` — one of the five the CLI accepts, or nothing. */
export function effortOf(text?: string): string | undefined {
  const match = /\b(low|medium|high|xhigh|max)\b/i.exec(text ?? '');
  return match ? match[1].toLowerCase() : undefined;
}

/**
 * How a session ended, in the words a notification can carry.
 *
 * A signal is the interesting case and the one a bare exit code loses: a pty
 * killed by the OOM killer reports code 0 with `signal: 9`, and "exited
 * cleanly" would be a lie about the most important thing that happened.
 */
export function describeExit(session: SessionInfo): string {
  const { code = 0, signal } = session.exited ?? {};
  if (signal) return `on signal ${signal}`;
  return `with code ${code}`;
}

/** Read-only git, for approval evidence. Never fails the request it decorates. */
export function gitRead(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 5_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error ? '' : String(stdout).trim().slice(0, 4_000));
    });
  });
}

/**
 * Every plan's finished-phase evidence, read once. See `Service.etaPool`.
 *
 * `all` is the portfolio fallback and is sorted by when each phase ENDED rather
 * than grouped by plan: it feeds an EMA, whose entire behaviour is the order of
 * its input, so stacking one plan's history after another's would make the
 * newest evidence whatever plan happened to sort last.
 */
export type EtaPool = { bySlug: Map<string, EtaSample[]>; all: EtaSample[] };

/**
 * How long a read of every plan's runs stays good for.
 *
 * Not the plan `generation`, which is the right key for anything derived from
 * files in `docs/` and the wrong one here: run records change when a PHASE
 * finishes, which moves no document and bumps no generation — so a
 * generation-keyed estimate would freeze for the whole of a long run, exactly
 * when it is being watched. Short enough that a finished phase shows up before
 * anyone reloads, long enough that a burst of list requests reads the disk once.
 */
export const ETA_POOL_MS = 5_000;

/**
 * How long a queue holder's ETA hint stays fresh (`ServiceRuns.etaHint`).
 *
 * Much longer than `ETA_POOL_MS`, and for the opposite reason: this one is
 * read from inside the SCHEDULER's synchronous scan, which runs on every
 * admission change, and its subject is a whole plan's remaining work — a
 * number that moves when a phase finishes, not second to second. A short TTL
 * here would put a board read behind every queue scan and change no answer.
 */
export const ETA_HINT_MS = 60_000;

/**
 * The skills a NEW run starts with: what was asked for, else the machine's.
 *
 * `??` and deliberately not `||`. An explicit empty list is the operator having
 * unchecked every box, and that has to mean "none" rather than "you did not
 * say" — with `||` the default would reassert itself and there would be no way
 * to turn it off for a run at all. Absent means the request never mentioned
 * skills (a `curl`, an older client), and then the machine's default applies.
 *
 * Seeded ONCE, here. From this point the run's own `skills[]` is the single
 * truth and nothing re-reads the flag — so changing the flag cannot retroactively
 * alter a run in flight, and unchecking survives every later write.
 */
export function seedSkills(chosen: string[] | undefined, defaults: string[]): string[] | undefined {
  if (chosen !== undefined) return chosen;
  return defaults.length ? [...defaults] : undefined;
}

/**
 * Which recovery class a halt can be healed by WITHOUT a person — or null.
 *
 * Deliberately narrower than the client's `classifyRun`: the client offers a
 * button and a person decides; this decides by itself, so anything ambiguous,
 * human-shaped or resource-shaped answers null. The named `kind` written at
 * the halt site is the contract; the sentences below only cover records
 * written before kinds existed, and only the unmistakable ones — the client's
 * generic "assess and carry on" fallback is exactly what an unattended loop
 * must not press.
 */
export function autoRecoveryClass(
  halt: { reason: string; kind?: string } | null,
  status: string,
  record?: { verification?: { ok: boolean } | null } | null,
): RecoveryClass | null {
  // An interrupted run is the crash this console is booting back from — the
  // one case where the status alone is the whole diagnosis.
  if (status === 'interrupted') return 'interrupted-resume';
  // The one PARKED shape an agent can clear: every ready phase held by an
  // unrunnable §Verification, named as such by the drive loop. plan-repair is
  // the class whose briefing knows the fix (author the bullet from the exit
  // criteria); a parked run with any other kind — or none, like a lock park
  // or a live-orphan adoption — stays a person's.
  if (status === 'parked') {
    return halt?.kind === 'verification-preflight' ? 'plan-repair' : null;
  }
  if (status !== 'halted' || !halt) return null;

  // The named kind through the ONE profile table (shared/recovery-model.js) —
  // the same table the halt banner and the human classifiers read, so the
  // three can never disagree about a kind again.
  if (halt.kind) {
    const profile = (KIND_PROFILE as Record<string, { autoClass: string | null; park?: boolean }>)[halt.kind];
    if (!profile) return null; // a named kind not in the table is not healable
    // A park kind on a HALTED run is a contradiction — the drive loop writes
    // these on parks only, so meeting one here means something else is wrong.
    if (profile.park) return null;
    // A no-handoff halt whose record shows RED verification is a verification
    // failure wearing paperwork clothes — the closeout brief forbids the work
    // that would fix it (the observed four-session loop on one phase).
    if (halt.kind === 'no-handoff' && record?.verification && !record.verification.ok) {
      return 'halted-verification';
    }
    // A LADDER class is not a briefing: the situation classifier and the
    // remediation ladder own that kind now (`runner/situation.ts`, `ladder.ts`).
    // This legacy reader answers only with an agent class it could launch.
    return isRecoveryClass(profile.autoClass) ? profile.autoClass as RecoveryClass : null;
  }

  // Records written before kinds existed: only the runner's own unmistakable
  // sentences, and only the two an unattended loop may act on.
  if (VERIFICATION_AUTO_RE.test(halt.reason)) return 'halted-verification';
  if (NO_HANDOFF_AUTO_RE.test(halt.reason)) return 'halted-missing-handoff';
  return null;
}

/** A rung, translated to what this console can launch today. */
export type DriveVehicle =
  | { kind: 'retry' }
  /** `mode: 'repair'` carries the briefing class and the situation key it was
   * chosen for; the other modes act on the phase's own session and need
   * neither. */
  | { kind: 'session'; mode: RecoverMode; instruction?: string; cls?: RecoveryClass; situation?: string }
  | { kind: 'agent'; cls: RecoveryClass }
  /** A deterministic script — no session, no money. Today: `repair-artefacts.sh`. */
  | { kind: 'script'; script: 'repair-artefacts' }
  /** The runner's own re-board with a brief (`start({resumeRunId, reboard})`). */
  | { kind: 'reboard'; brief: BoardingBrief; escalate?: 'model' }
  /** A `require` MCP park past its clock: continue without the servers, errand recorded. */
  | { kind: 'mcp-continue' }
  /**
   * A fresh QA review through the QA recovery loop (`qaRecover`, verb
   * `qa-rerun`, strategy `fresh`) — `qa-pending`'s second rung, for a phase
   * whose own session cannot be resumed.
   */
  | { kind: 'qa-rerun' };

/** What `maybeAutoRecover` answers — launched or not, and what it read. */
export type AutoRecoverResult = {
  launched: boolean;
  reason?: string;
  phase?: number;
  /** The `id:sub` situation key of the anchor phase. */
  situation?: string;
  label?: string;
  rung?: string;
  vehicle?: 'retry' | 'session' | 'agent' | 'reboard' | 'mcp-continue' | 'script' | 'qa-rerun';
};

/**
 * The situation a phase-less stop most plausibly is — for the one errand the
 * recover verb answers with when no record can be classified.
 */
export function situationOfHalt(halt: RunState['halt']): string {
  switch (halt?.kind) {
    case 'plan-lint': case 'plan-unreadable': case 'verification-preflight': return 'plan-broken';
    case 'run-preflight': return 'resource-wall:auth';
    case 'budget': return 'resource-wall:budget';
    case 'models-exhausted': return 'resource-wall:model';
    case 'mcp-preflight': return 'mcp-unavailable';
    case 'needs-human': case 'phase-blocked': return 'blocked-declared';
    case 'verify-failed': return 'verify-red';
    case 'no-handoff': return 'done-unrecorded';
    default: return 'unknown';
  }
}


/**
 * Human names for the usage endpoint's bucket keys. Unknown keys — a tier that
 * ships after this file — degrade to a readable form of the key itself, so a
 * new window appears in notifications the day it exists rather than after an
 * update here.
 */
export function bucketLabel(bucket: string): string {
  if (bucket === 'five_hour') return '5-hour session';
  if (bucket === 'seven_day') return 'weekly (all models)';
  const model = /^seven_day_(.+)$/.exec(bucket)?.[1];
  if (model) return `weekly (${model[0].toUpperCase()}${model.slice(1)})`;
  return bucket.replace(/_/g, ' ');
}
