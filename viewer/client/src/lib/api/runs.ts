/**
 * The autopilot — runs, phase records, approvals, the convergence loop, and the
 * ETA shapes every other surface reads.
 */

import { request, post, q } from './client';
import {
  type BOARD_WORDS,
  type HANDOFF_WORDS,
  type RULING_KINDS,
  type VERIFICATION_WORDS,
} from '../../../../shared/evidence-model.js';
import { type QA_DISPLAY_WORDS } from '../../../../shared/plan-vocab.js';
import { type ETA_BASES } from '../../../../shared/ops-vocab.js';
import { type PERMISSION_PROFILES, type QA_FIX_STRATEGIES } from '../../../../shared/run-settings.js';
import { type BLOCKED_ON } from '../../../../shared/plan-vocab.js';
import { type RunPriority } from '../../../../shared/orchestration-model.js';
import {
  type CheckoutState,
  type IsolationMode,
  type RadarState,
  type SettleStrategy,
} from '../../../../shared/worktree-model.js';

/* ---------------- the autopilot ----------------
 * Mirrors `server/runner/state.ts` (`RunState`, `PhaseRecord`, `VerifySummary`),
 * `server/runner/approvals.ts` (`Approval`), `server/service.ts`
 * (`PhaseDiagnosis`, `RecoveryAction`) and `server/analysis/stats.ts`
 * (`EtaEstimate`). Hand-written for the same reason the plan shapes are: the
 * server is frozen, so a shape that drifts is a decision rather than an accident.
 *
 * `status` unions ARE narrowed here, unlike the plan surface's phase `state`.
 * They are the runner's own closed vocabulary rather than the engine's open one,
 * and every tone table below is keyed by them — an unknown status should be a
 * type error at the table, not a chip that silently paints grey. */

/**
 * The runner's own closed vocabularies, taken from `shared/run-lifecycle.js`
 * where their members are written down once. The per-word notes that used to
 * live here live there — including why `queued` is live to this file and not to
 * the server's `IN_FLIGHT`, and why `parked` was missing from this union for as
 * long as it was while the server emitted it.
 */
export type RunStatus = RunStatusWord;
export type PhaseStatus = PhaseStatusWord;

export type Autonomy = AutonomyMode;
export type PermissionProfile = (typeof PERMISSION_PROFILES)[number];
/** How a QA recovery boards its fix session — the shared vocabulary's two words. */
export type QaFixStrategy = (typeof QA_FIX_STRATEGIES)[number];

export interface VerifyRun {
  command: string;
  ok: boolean;
  code: number;
  ms: number;
  output: string;
  /** `terminal` when a person re-ran it in the integrated terminal. */
  via?: 'terminal';
}

export interface VerifySummary {
  ok: boolean;
  reason: string;
  ran: VerifyRun[];
  notRun: { text: string; reason: string }[];
  /** Commands skipped because their lead binary does not exist here —
   * neither ran nor failed; "I could not check" made explicit. */
  skipped?: { command: string; lead: string; reason: string }[];
}

/**
 * The halt vocabulary, imported by identity from `shared/recovery-model.js`.
 * This was a hand-kept third copy of the same seventeen words (the server's
 * `runner/state.ts` mirror is the second); nothing compared them, so nothing
 * would have said which one was right on the day they disagreed.
 */
import type { HaltKind } from '@shared/recovery-model.js';

export type { HaltKind };

/** One structured boarding-preflight finding (`preflight` is the frozen string twin). */
export interface PreflightWarning {
  kind: 'human-check' | 'missing-lead' | 'cwd-unpinned' | 'nothing-runnable';
  message: string;
  lead?: string;
  command?: string;
}

/* ---------------- liveness (Phase 5's server B) ---------------- */

/**
 * What the runner can see about a lane that has NOT stopped.
 *
 * Five signals, worst first, imported by identity from `shared/attention-model.js`
 * rather than restated here — this union used to be a hand-kept copy and it had
 * already drifted: `external-wait` arrived in shared with `stallExternal` and
 * never reached this side, so a lane waiting on someone else's clock had no word
 * on this side of the wire. Deliberately a different list from the inbox's
 * `StallKind`: these are about a session that exists and is spending, and four of
 * the inbox's six kinds describe a phase with no session at all.
 */
import type { StallSignal } from '@shared/attention-model.js';
import type {
  AutonomyMode,
  BoardingBrief,
  ConvergeTrigger,
  GitMode,
  McpPolicy as McpPolicyWord,
  OnLimitPolicy as OnLimit,
  PhaseStatus as PhaseStatusWord,
  ReviewerPolicy,
  RungOutcome,
  RunStatus as RunStatusWord,
  SettledRungOutcome,
  UltraReviewMode,
  PhaseLifecycle,
} from '@shared/run-lifecycle.js';

export type { StallSignal };

/** The episode in progress: which signal, since when, and the one line of evidence. */
export interface StallState {
  signal: StallSignal;
  /** ISO — when the condition BECAME true, not when the ticker noticed. */
  since: string;
  detail: string;
}

/** A tool call that went out and has not come back. */
export interface OpenTool {
  id: string;
  name: string;
  since: string;
}

/**
 * One live lane, as `GET /api/run/:slug` reports it (`liveness[]`).
 *
 * `commitsSinceStart` and `treeDirty` cost a subprocess each, so the server
 * refreshes them every five minutes rather than every tick: they answer "has
 * this ATTEMPT produced anything at all", which does not change per turn. Read
 * them as a few minutes old and never as a live clock — and the window really is
 * the attempt's, so a phase that committed on an earlier attempt reads zero here
 * until this one commits.
 */
export interface LaneLiveness {
  phase: number;
  lastOutputAt: string;
  lastToolUseAt?: string;
  turnsSinceLastTool: number;
  commitsSinceStart: number;
  treeDirty: boolean;
  openTool?: OpenTool;
  stall?: StallState;
  /**
   * API retries since the last productive event. Absent while there are none.
   * See `server/runner/liveness.ts` — without it a retry storm reads as plain
   * silence on every surface an operator has.
   */
  retries?: { count: number; since: string };
}

/* ---------------- rulings (Phase 5's ledger) ---------------- */

export type RulingKind = (typeof RULING_KINDS)[number];

/**
 * One judgement call a session recorded — `phase-outcome.sh <slug> <N> ruling`.
 *
 * A ruling is not an outcome and never becomes one: nothing acts on it, which
 * is the property that makes it safe for a session to record whenever it is in
 * doubt. `ack` is an annotation, never a resolution — a ruling is never "done",
 * and acking one appends a line to the ledger rather than editing the old one.
 */
export interface Ruling {
  id: string;
  slug: string;
  phase: number;
  kind: RulingKind;
  what: string;
  why?: string;
  /** The field that makes a ruling worth reading. */
  costIfWrong?: string;
  sessionId?: string;
  at: string;
  ack?: { at: string; by?: string };
}

/* ---------------- the journal ---------------- */

/**
 * One line of a run's journal (`server/runner/journal.ts` `JournalEntry`).
 *
 * `seq` is per run and monotonic, which is what makes a line permalinkable:
 * `#/plan/:slug/run?j=<seq>` names one entry for as long as the run exists.
 */
/* ---- the time axis (`server/analysis/timeline.ts`) ---- */

export type BarKind = 'working' | 'verifying' | 'waiting' | 'frozen';

export interface TimelineBar {
  kind: BarKind;
  startMs: number;
  endMs: number;
  attempt: number;
  /** Still open when the journal ended — drawn hatched, never as finished. */
  open: boolean;
  note?: string;
}

export type MarkKind = 'board' | 'verify' | 'rung' | 'park' | 'wall' | 'outcome';

export interface TimelineMark {
  kind: MarkKind;
  atMs: number;
  phase?: number;
  label: string;
  ok?: boolean;
}

export interface TimelineLane {
  phase: number;
  bars: TimelineBar[];
  startMs: number;
  endMs: number;
  totalMs: number;
  workingMs: number;
  verifyingMs: number;
  waitingMs: number;
  frozenMs: number;
  attempts: number;
  /** The journal's tail cut this lane's opening off. */
  partial: boolean;
  critical: boolean;
}

export interface RunTimeline {
  startedAt: string | null;
  /** `null` while the run is still going — NOT the same as the axis's edge. */
  endedAt: string | null;
  horizonAt: string;
  spanMs: number;
  lanes: TimelineLane[];
  marks: TimelineMark[];
  criticalPath: number[];
  criticalMs: number;
  truncated: boolean;
  unmapped: number;
}

export interface AttemptVerification {
  command: string;
  ok: boolean;
  code: number;
  ms: number;
}

export interface AttemptSummary {
  phase: number;
  attempt: number;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  outcome: string;
  model: string | null;
  effort: string | null;
  /** `null` means nothing was recorded — a different claim from `$0`. */
  costUsd: number | null;
  turns: number | null;
  sessions: number;
  rungs: string[];
  verification: {
    ok: boolean;
    reason: string | null;
    cwd: string | null;
    ran: AttemptVerification[];
    notRun: number;
    skipped: number;
  } | null;
  said: string | null;
}

export interface VerificationFlip {
  command: string;
  from: 'pass' | 'fail' | 'absent';
  to: 'pass' | 'fail' | 'absent';
  fromCode: number | null;
  toCode: number | null;
  fromMs: number | null;
  toMs: number | null;
}

export interface AttemptComparison {
  phase: number;
  from: number;
  to: number;
  outcome: { from: string; to: string; changed: boolean };
  model: { from: string | null; to: string | null; changed: boolean };
  verification: {
    from: boolean | null;
    to: boolean | null;
    flips: VerificationFlip[];
    unchanged: number;
  };
  rungs: { from: string[]; to: string[] };
  durationMs: { from: number; to: number; deltaMs: number };
  costUsd: { from: number | null; to: number | null; deltaUsd: number | null };
  turns: { from: number | null; to: number | null };
}

export interface PhaseAttempts {
  runId: string | null;
  attempts: AttemptSummary[];
  comparisons: AttemptComparison[];
}

export interface JournalEntry {
  seq: number;
  time: string;
  event: string;
  phase?: number;
  data?: Record<string, unknown>;
}

/* ---------------- claimed vs evidenced ---------------- */

/**
 * `shared/evidence-model.js` `deriveEvidence` output — the four facts behind a
 * claim, and whether they back it.
 *
 * Named `evidenced`, never `done`: the board says a phase is done, and this
 * says whether anything on disk agrees. `why` is never empty.
 */
export interface EvidenceProof {
  board: (typeof BOARD_WORDS)[number];
  handoff: (typeof HANDOFF_WORDS)[number];
  verification: (typeof VERIFICATION_WORDS)[number];
  qa: (typeof QA_DISPLAY_WORDS)[number];
  evidenced: boolean;
  /**
   * The board paints work in flight and nothing live was found behind it.
   *
   * Optional so a client built after a server is not: `undefined` reads as
   * "this server did not measure it", which is the honest degradation — a warn
   * chip nobody measured is worse than no chip.
   */
  stale?: boolean;
  why: string[];
}

/* ---------------- what is actually running a phase ---------------- */

/**
 * Which witness saw a phase being worked. `LIVE_VIA` in
 * `shared/evidence-model.js` is the one definition; this mirrors it.
 */
export type PhaseLiveVia = 'run' | 'lock' | 'registry';

/**
 * Something OBSERVED to be working this phase right now — the fact the board
 * word is a claim about.
 *
 * ABSENT means nothing live was found, and it also means "a server that does
 * not send this field". The two reading alike is deliberate: both are "we
 * cannot say anything is running", which is the answer a chip should act on.
 */
/**
 * Who is driving a live phase. `PHASE_ACTORS` in `shared/status-vocab.js` is
 * the one definition; this mirrors it (allowed by name in vocab-owners).
 */
export type PhaseActor = 'autopilot' | 'agent' | 'external';

export interface PhaseLive {
  via: PhaseLiveVia;
  /** Who is driving — absent from a server older than the field. */
  actor?: PhaseActor;
  /** The Claude session id, when the witness knows one. What a deep link needs. */
  session?: string;
  /** The process. Only `via: 'run'` ever knows one. */
  pid?: number;
}

/**
 * One row of a session's task list, as the server folded it.
 *
 * The same shape `shared/task-model.js` produces for the browser's own fold —
 * by construction, not by coincidence: both come out of `foldTaskEvent`, which
 * is what lets the activity panel be SEEDED from the record instead of
 * re-deriving the list from a bounded transcript replay that has no creates in
 * it. `id` is null only for a `TaskCreate` whose id has not come back yet.
 */
export interface PhaseTask {
  id: string | null;
  /** The `tool_use` id of the create, while it is still waiting for an id. */
  key?: string;
  content: string;
  activeForm?: string;
  status: string;
}

/**
 * One QA round on a phase, as the run recorded it.
 *
 * `verdict` is a plain string, not the verdict union: it comes off a file a
 * person may have hand-broken, and an unparseable cell must be showable rather
 * than throwing. `costUsd`/`turns` are the reviewing SESSION's spend, booked
 * against the first round it produced — a session that recorded two rounds
 * spent its money once.
 */
export interface QaRound {
  round: number;
  verdict: string;
  /** Relative to the plan's handoff folder, as `test-status.md` records it. */
  reportPath?: string;
  sessionId?: string;
  brief?: string;
  costUsd?: number;
  turns?: number;
  at?: string;
}

export interface PhaseRecord {
  phase: number;
  status: PhaseStatus;
  /**
   * What the phase IS, and why it stopped — `shared/run-lifecycle.js`.
   *
   * Written beside `status` since 3.5.0 and absent on any record older than
   * that, which is why every reader passes it to `phaseUiState` rather than
   * switching on it: the paint falls back to the status word alone.
   */
  lifecycle?: PhaseLifecycle;
  attempts: number;
  costUsd: number;
  /** The recorded spend is known to be incomplete — see `PhaseRecord.costUnknown`. */
  costUnknown?: boolean;
  turns?: number;
  durationMs?: number;
  frozenMs?: number;
  /** When a `waiting` park elapses and the runner resumes the phase's session. */
  parkedUntil?: string;
  /** The session's own words for what it is waiting on. */
  parkReason?: string;
  /** Refs for the external things being waited on (`gh:…#run/N`, `lock:slug/N`). */
  watch?: string[];
  /** How many waiting-external parks this phase has taken (capped by the runner). */
  waits?: number;
  /** When this phase started queueing behind a foreign lock. */
  lockWaitSince?: string;
  /**
   * How many times this phase called each attached MCP server, by id. Zero for
   * an id means it was attached and never touched — the interesting number,
   * since every attached server is paid for on every turn.
   */
  mcpCalls?: Record<string, number>;
  /** Left by a checkpointed freeze; makes Continue a `--resume` rather than a restart. */
  resumeSessionId?: string;
  model?: string;
  effort?: string;
  /** What the session's own `init` said it was running on — not always what it was asked for. */
  actualModel?: string;
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
  note?: string;
  /** Boarding-preflight warnings on the §Verification — advisory, absent when clean. */
  preflight?: string[];
  /** The same findings, structured — what a page filters and badges by. */
  preflightDetail?: PreflightWarning[];
  /** Servers this phase asked for and boarded without. Absent when all connected. */
  mcpDegraded?: McpDegradation[];
  verification?: VerifySummary;
  /**
   * Every QA round this phase has been through, oldest first — mirrors
   * `server/runner/state.ts` `QaRoundRecord`.
   *
   * Absent on every record written before rounds existed, so read it as
   * `?? []`. This is the run's OWN view of QA: `PhaseView.qa` on the plan side
   * is the single current verdict parsed out of `test-status.md`, which is what
   * gates — this is the history behind it plus what each round cost, which no
   * run surface could show at all before (issue #7).
   */
  qa?: QaRound[];
  /**
   * A QA round in flight on this phase — the runner sets it when the reviewer
   * is spawned and clears it when the round ends. The record reads `done` the
   * whole time (a review happens after the work), so this is what makes the
   * session a lane: a tab, a console and a task list on the run page and Now.
   */
  qaSession?: { round: number; report: string; verb?: string; sessionId?: string; startedAt: string };
  lint?: { ok: boolean; summary: string };
  closeout?: { at: string; ok: boolean; sessionId?: string; note?: string };
  said?: string;
  /**
   * The session's own task list — what `scripts/phase-tasks.sh` published, or
   * what the CLI's task tools wrote when it still had them. Folded server-side
   * so it survives a reload and a console restart; absent when the session
   * published none.
   */
  tasks?: PhaseTask[];
  /**
   * The classifier's last word on this phase (`server/runner/situation.ts`),
   * cached on the record for the table and the Ways-forward strip — `key` is
   * `id:sub`, `why` the evidence lines. Never an input to anything.
   */
  situation?: { key: string; at: string; why?: string[] };
  /**
   * A rung's instruction for the NEXT boarding — the brief the runner appends
   * (`fresh` | `resume` | `unblock` | `continue` | `closeout`) and the session
   * it resumes, when one exists. Consumed the moment the session spawns.
   */
  boardingHint?: BoardingHint;
  /** A `require` MCP park on its clock: when it parked and what was unreachable. */
  mcpPark?: { at: string; degraded: McpDegradation[] };
  /** The gate evaluation at boarding. */
  gate?: { clear: boolean; kind: string; detail: string };
  /**
   * The lane's last liveness snapshot, persisted on the record.
   *
   * Stale by construction once the lane is gone — it is what the SERVER falls
   * back to when no runner is live (`service.runLiveness`), and the record's
   * own `status` is what says whether to believe it. Prefer `RunDetail.liveness`
   * for anything in flight.
   */
  liveness?: LaneLiveness;
  /** The stall episode in progress. Cleared when an attempt is given up on. */
  stall?: StallState;
}

/** What a rung told the runner to do at the phase's next boarding. */
export interface BoardingHint {
  situation: string;
  rung: string;
  brief: BoardingBrief | (string & {});
  sessionId?: string;
  instruction?: string;
  escalate?: 'model';
  at: string;
  by?: string;
}

/**
 * What a phase does when one of its MCP servers cannot be reached.
 *
 * `continue` (the shipped default) runs it without that server and says so, in
 * the session's prompt and in the phase record. `require` parks at boarding,
 * which is what every phase used to do — one signed-out server halted a real
 * eleven-phase plan that named no MCP servers of its own.
 */
export type McpPolicy = McpPolicyWord;

/** One server a phase asked for and did not get, with the errand it implies. */
export interface McpDegradation {
  id: string;
  reason: 'needs-auth' | 'failed' | 'unregistered' | 'switched-off';
  detail?: string;
}

/**
 * What "Retry with edits…" sends: an instruction for the boot prompt and/or
 * settings, both for ONE attempt.
 *
 * Deliberately the same `PhaseOptions` the run-setup form already builds —
 * there is one vocabulary for "what a phase runs as", and the attempt is a
 * level of it rather than a new idea. The server coerces it through the same
 * table for the same reason.
 */
export interface RetryEdits {
  addendum?: string;
  options?: PhaseOptions;
}

export interface PhaseOptions {
  model?: string;
  effort?: string;
  tools?: string[];
  permissionMode?: string;
  skills?: string[];
  /** Drop the RUN's skills for this phase; its own `skills` still apply. */
  skillsOff?: boolean;
  /** MCP servers this phase attaches, on top of the plan's and the run's. */
  mcpServers?: string[];
  /**
   * Drop the RUN's MCP servers for this phase. The PLAN's own `**MCP:**` bullet
   * still applies — that is a versioned statement about what the phase needs,
   * not somebody's preference for one run.
   */
  mcpOff?: boolean;
  /**
   * This phase's answer to an unreachable server. The most specific there is,
   * and the only one that outranks the plan.
   */
  mcpPolicy?: McpPolicy;
  /**
   * Whether the console answers this phase's permission asks itself.
   * Tri-state: true/false override, absent inherits (plan → global → ON).
   * Both values are stored — false is a choice, never silence.
   */
  autoApprove?: boolean;
}

/** One live `claude -p` process: which phase it is on, and the session it holds. */
export interface ChildRef {
  pid: number;
  phase: number;
  sessionId: string;
  /** When the PHASE started — hours from the process's own start on a retry. */
  startedAt: string;
  /**
   * When this PROCESS started, as the console saw it at spawn.
   *
   * The other half of the `(pid, start-time)` tuple the server uses to tell a
   * child from whatever recycled its pid. Mirrored here because a pid rendered
   * without it is a number the operator cannot safely act on, and the client
   * was silently dropping a field the server had been writing all along.
   * Optional: records written before it existed have no answer, and that is
   * different from "it started at the epoch".
   */
  procStartedAt?: string;
  /**
   * Set while THIS lane sits under SIGSTOP. The run-level `freeze` slot can
   * only name one lane; with several frozen at once this is the per-lane truth
   * the controls read.
   *
   * **`escalateAt` absent is a word, not a gap** — a STANDING freeze, which is
   * what a fleet Freeze-all writes. It never converts to a checkpoint on a
   * clock, so there is nothing to count down to; render the freeze without a
   * deadline rather than inventing one.
   */
  frozen?: { at: string; by: string; escalateAt?: string };
  /**
   * The lane's own checkout. **Absent means shared** — this session is editing
   * the run's own root, as every run did before worktree lanes existed.
   */
  worktree?: string;
  /**
   * The branch that checkout is on (`pe/<slug>-p<N>`). **Absent means the run's
   * own branch** — set only alongside `worktree`, never on its own.
   */
  branch?: string;
}

export interface RunState {
  id: string;
  slug: string;
  root: string;
  status: RunStatus;
  autonomy: Autonomy;
  model: string;
  effort?: string;
  limits?: {
    status: string;
    window?: string;
    utilization?: number;
    resetsAt?: number;
    at: string;
  };
  phaseBudgetUsd: number | null;
  runBudgetUsd: number | null;
  spentUsd: number;
  maxConsecutiveFailures: number;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
  activePhase: number | null;
  /**
   * The mirror lane, and every reader written before the pool.
   *
   * One run can drive several disjoint-scope phases at once, so this is the
   * LOWEST-numbered live lane rather than "the" child — chosen for stability, so
   * it does not flip between lanes on every write. It is load-bearing, not
   * legacy: `reconcileRun` and every console built before lanes answer "is
   * something running" from it. `children` is the full picture.
   */
  child: ChildRef | null;
  /** Every live lane, keyed by phase — STRING keys, like `phases`. */
  children?: Record<string, ChildRef>;
  /** How many lanes this run may hold at once. Never more than the console's cap. */
  maxParallel?: number;
  waitUntil: string | null;
  /**
   * Which wait `waitUntil` is — a usage window to sit out, or a phase parked on
   * work outside the session. They want opposite advice, and the clock alone
   * never said which, so this view asserted "usage limit" for both. Absent on
   * runs written before the field; mirrors `server/runner/state.ts`.
   */
  waitReason?: WaitReason;
  /** `kind` is the halt's machine-readable class; absent on older records. */
  /** `kind` mirrors `server/runner/state.ts`'s HaltKind (open-ended for
   * records written by other versions); readers go through the shared
   * KIND_PROFILE, never string literals. */
  halt: {
    at: string;
    reason: string;
    phase?: number;
    kind?: HaltKind | (string & {});
  } | null;
  pause: { requestedAt: string; afterPhase: number | null; by: string } | null;
  freeze: {
    at: string;
    phase: number | null;
    pid: number;
    by: string;
    escalateAt?: string;
  } | null;
  finishedReason?: string;
  onlyPhases?: number[];
  phaseOptions?: Record<string, PhaseOptions>;
  skills?: string[];
  /** MCP servers every phase of this run attaches, on top of the plan's own. */
  mcpServers?: string[];
  /** This run's answer to an unreachable server. Absent = `continue`. */
  mcpPolicy?: McpPolicy;
  permissionProfile?: PermissionProfile;
  /** The Claude account this run spawns as. Absent = the machine login. */
  accountId?: string;
  /** What the run does at the shared usage window. Absent = `wait`. */
  onLimit?: OnLimitPolicy;
  /**
   * The run's git strategy, echoed off the state file. Absent means
   * default-branch — including on servers from before the feature — so render
   * nothing rather than falling back to preferences here: a header states the
   * run's own record.
   */
  gitMode?: 'new-branch';
  /** Meaningful only with `gitMode: 'new-branch'`; absent there means true. */
  openPr?: boolean;
  /**
   * What happens to the run's branch when it finishes — see `SETTLE_STRATEGIES`.
   *
   * **Never read directly.** An absent `settle` is not "no answer": thousands of
   * run files predate the field and say `openPr` instead, and `openPr: false`
   * asked for exactly what `keep` means. `settleOf(run)` in
   * `shared/worktree-model.js` is the one place that back-compatibility lives.
   */
  settle?: SettleStrategy;
  /**
   * What the run ASKED for — its own checkout, or the shared one. Absent means
   * `queue`, and the same rule as `gitMode` applies: a surface reads the run's
   * own record here and never falls back to a preference, because a live run's
   * setting is a fact rather than a default.
   */
  isolation?: IsolationMode;
  /**
   * What the run actually GOT — the outcome to `isolation`'s request.
   *
   * Absent means `shared`, including on a server from before the feature.
   * `refused` means isolation was asked for and could not be given: the run is
   * working in the console's own checkout with queue semantics, and
   * `isolationRefusal` names which impossibility it hit.
   */
  checkout?: CheckoutState;
  /** The run's managed checkout, when it has one. Absent means `root`. */
  workRoot?: string;
  /**
   * The repositories a MIRROR workRoot holds, root-relative — present only
   * when the run's checkout is a mirror of a superproject's sub-repositories
   * rather than one worktree of the root.
   */
  mountedRepos?: string[];
  /**
   * Which impossibility a `refused` run hit — a KEY of `REFUSAL_REASON` in
   * `shared/worktree-model.js`'s sibling `server/runner/worktree.ts`. The
   * sentence is looked up, never stored, so a surface can never render prose
   * that has drifted from the code that decided it.
   */
  isolationRefusal?: string;
  /**
   * Which class this run's admissions are scanned in. Absent means `normal`,
   * the same omission convention `isolation` and `gitMode` use — read it
   * through `runPriority()` rather than testing the field, so a run file from
   * before the feature and one that says `normal` are the same fact.
   */
  priority?: RunPriority;
  /** A plan slug this run boards after. Absent means no chain. */
  startAfter?: string;
  /** The operator's hold: nothing new boards, live lanes keep running. */
  hold?: { at: string; by?: string } | null;
  /** The per-phase auto reviewer. Absent means off — see `server/reviewer.ts`. */
  reviewEachPhase?: boolean;
  reviewerPolicy?: ReviewerPolicy;
  /** The standing ultracode licence in every prompt. Absent means off. */
  ultracode?: boolean;
  /** When this run runs `claude ultrareview`. Absent means never. */
  ultraReview?: UltraReviewMode;
  /**
   * Why this stopped run no longer wants a person — the board overtook it
   * (`auto`), or someone dismissed it. Annotation, never deletion: the run is
   * still here, still halted, still readable. See `server/runner/state.ts`.
   */
  resolved?: RunResolution | null;
  /** A person put the card back; the board resolver leaves it alone from then on. */
  reopenedAt?: string | null;
  /**
   * Who last stopped the run — the operator (Stop, Pause, an escalated
   * freeze) or the system (a halt or park the loop wrote, a console shutdown,
   * a crash found at boot). The convergence loop picks up only the system's
   * stops. Absent on runs written before the field existed.
   */
  stoppedBy?: 'operator' | 'system';
  /** The run-level ask for a person, when a stop has no phase to hang it on. */
  errand?: Errand | null;
  /**
   * The resource ladder raised the run budget once (`budgetAutoRaisePct`); its
   * presence is what makes the raise happen once per run.
   */
  budgetRaise?: { from: number; to: number; pct: number; at: string } | null;
  /** Recovery bookkeeping, keyed by phase (`plan` for a plan-wide repair) — see `RecoverySlot`. */
  recoveries?: Record<string, RecoverySlot>;
  /** Present when the run heals its own auto-recoverable halts. */
  autoRecover?: { attempts: number };
  /**
   * The rulings written SINCE this run started, folded in by the watcher.
   *
   * A slice, not the ledger: `runs/<instance>/<slug>/rulings.ndjson` is per
   * plan and outlives every run, so a plan on its fourth run would otherwise
   * carry three runs of history. `GET /api/run/:slug/rulings` reads the whole
   * file, which is what the page shows.
   */
  rulings?: Ruling[];
  phases: Record<string, PhaseRecord>;
}

export interface RunResolution {
  at: string;
  auto: boolean;
  reason: string;
  by?: string;
  note?: string;
}

/**
 * What a person is asked for, ONCE, when the ladder for a phase is exhausted
 * or the situation is intrinsically human: the situation, what was tried (so
 * nobody tries it again by hand), what is needed, and how to give it.
 */
export interface Errand {
  phase: number;
  situation: string;
  tried: string[];
  /** Rungs climbed for a DIFFERENT situation on this phase (server `Errand.earlier`). */
  earlier?: string[];
  need: string;
  how: string;
  at: string;
  /**
   * The session's own last words, verbatim, when they are the evidence — a
   * zero-turn exit that named its cause (a refusal, an unloadable skill).
   * Absent on every other errand. See `server/runner/state.ts`.
   */
  said?: string;
}

/** One rung the ladder climbed on a phase (`server/runner/state.ts` `RungRecord`). */
export interface RungRecord {
  situation: string;
  rung: string;
  at: string;
  params?: Record<string, string | number | boolean>;
  costUsd?: number;
  outcome?: RungOutcome;
  note?: string;
}

/**
 * A run's recovery bookkeeping for one phase (`server/runner/state.ts`
 * `RunState.recoveries[phase]`). `lastOutcome` is the verdict the server has
 * always written and this type once never carried — `no-defect` ("looked,
 * found nothing wrong") was invisible and toasted as a failure.
 */
export interface RecoverySlot {
  attempts: number;
  lastAt: string;
  lastReason?: string;
  fixed?: boolean;
  lastOutcome?: SettledRungOutcome;
  /** The ladder's own history for this phase — every rung climbed, in order. */
  rungs?: RungRecord[];
  /** The one open ask for a person, when the ladder is exhausted. */
  errand?: Errand;
  /** Resumes after console restarts killed this phase's lane (bounded). */
  bootResumes?: number;
}

/**
 * One action of a convergence pass, flattened (`server/converge.ts`
 * `ConvergeActionView`): what the loop did, to which phase, and why.
 */
export interface ConvergeActionView {
  kind: 'release-debris' | 'relaunch' | 'errand' | 'heal' | 'skip' | (string & {});
  phase?: number | null;
  situation?: string;
  rung?: string;
  vehicle?: string;
  owner?: string;
  session?: string;
  reboard?: {
    phase: number;
    situation: string;
    rung: string;
    brief?: string;
  }[];
  rearm?: number[];
  need?: string;
  launched?: boolean;
  ok: boolean;
  why: string;
}

/** The convergence loop's last pass on a plan — the Pulse's convergence line. */
export interface ConvergeView {
  slug: string;
  trigger: ConvergeTrigger | (string & {});
  at: string;
  launched: boolean;
  noop: boolean;
  actions: ConvergeActionView[];
  errands: number;
}

/** `GET /api/converge`: whether the loop runs by itself here, its cadence, its queue and its last reports. */
export interface ConvergeStatusView {
  automatic: boolean;
  everyMs: number;
  pending: { slug: string; trigger: string; dueAt: number }[];
  running: string[];
  reports: ConvergeView[];
}

/**
 * Which link of the fallback chain answered — and therefore how much of a claim
 * the number is. `etaLabel()` in `lib/format` turns it into words.
 */
export type EtaBasis = (typeof ETA_BASES)[number];

/** Always a range, always hedged — see `server/analysis/stats.ts`. */
export interface EtaEstimate {
  ratePerWeight: number;
  samples: number;
  basis: EtaBasis;
  remainingWeight: number;
  remainingPhases: number;
  lowMs: number;
  highMs: number;
  label: string;
}

/** One phase's own estimate — a point, not a range. */
export interface PhaseEta {
  phase: number;
  weight: number;
  estMs: number;
  basis: EtaBasis;
  label: string;
}

/* ---------------- the branch probe ----------------
 * Mirrors `server/runner/worktree.ts` (`Divergence`, `CheckoutEntry`,
 * `RadarPair`, `RunGitView`) — the probe phase 9 wired onto `run:git` and the
 * `git` field of `GET /api/run/:slug`.
 *
 * ⚠️ **Every number here is optional, and that is the contract, not laziness.**
 * The probe answers `undefined` for a number, `'unknown'` for a verdict and
 * `[]` for a list rather than failing, because none of those is news about the
 * RUN: a monitoring layer that turns a healthy run's page red is worse than one
 * that occasionally says it does not know. A surface therefore renders an
 * absent fact as a dash, never as an alarm. */

/** How far a branch has moved from the base, both ways. */
export interface Divergence {
  ahead: number;
  behind: number;
}

/** A registered checkout of this repository, as `git worktree list` sees it. */
export interface CheckoutEntry {
  /** Absolute path, as git prints it (symlinks resolved). */
  dir: string;
  /** The branch it stands on, absent for a detached HEAD or a bare entry. */
  branch?: string;
  /** Is this the repository's own root checkout — the operator's tree? */
  root: boolean;
  /** Does it live under the console's state directory, i.e. did we make it? */
  managed: boolean;
  /** `worktree list` still prints a checkout whose directory is gone. */
  prunable: boolean;
  /** Bytes on disk, when `du` could answer. Managed trees only. */
  disk?: number;
}

/** What two live branches would do to each other if they met. */
export interface RadarPair {
  a: string;
  b: string;
  state: RadarState;
  /** The files the verdict is about: the overlap, or the conflicted subset. */
  files: string[];
}

/** One run's git situation, as the console observed it from outside. */
export interface RunGitView {
  /** When this was probed — the whole point of a cached view. */
  at: string;
  /** The branch everything here is measured against: the root checkout's own. */
  base?: string;
  /** The run branch, when the run has one. */
  branch?: string;
  /** The run's isolated checkout, when it has one. */
  workRoot?: string;
  /** Ahead/behind of `branch` vs `base`. Absent = could not ask. */
  divergence?: Divergence;
  /** Files `branch` changed since it left `base`, capped. */
  files: string[];
  /** Were there more than the cap? A list that silently stops is a lie. */
  filesTruncated: boolean;
  /** Bytes the run's own checkout occupies. */
  disk?: number;
  /** Every checkout of this repository, root included. */
  checkouts: CheckoutEntry[];
  /** Pairwise verdicts over the live branches, worst first. */
  radar: RadarPair[];
}

export interface RunDetail {
  run: RunState | null;
  history: RunState[];
  eta: EtaEstimate | null;
  /**
   * The branch probe's cached view, or `null`.
   *
   * `null` is the ordinary answer and never an error: `service.runGit` reads the
   * LIVE runner's cache and never probes on demand, so a shared-checkout run, a
   * run nobody is driving and a run whose isolation was refused all report it.
   * The surface says "shared checkout" rather than drawing an empty card.
   */
  git?: RunGitView | null;
  /**
   * One estimate per open lane. The REMAINDER is not here on purpose: the
   * elapsed clock ticks in the browser, so a server-computed "time left" would
   * be stale the instant it was serialised. See `server/service.ts`.
   *
   * Optional for the same reason as `PlanDetail.eta` — an older server process
   * under a newer client simply does not send it.
   */
  phaseEta?: PhaseEta[];
  /**
   * One entry per live lane. Rides along for the same reason `eta` does: "is
   * this lane working" is a question about ONE moment, and a second request
   * could be answered against a different one.
   *
   * Optional because an older server process under a newer client simply does
   * not send it — read an absent array as "this server cannot tell you", never
   * as "nothing is stalled".
   */
  liveness?: LaneLiveness[];
}

export interface Evidence {
  label: string;
  body: string;
}

export interface Approval {
  id: string;
  runId: string;
  slug: string;
  phase: number | null;
  /** `verify` is a question for a person, not a permission question. */
  kind: 'gate' | 'tool' | 'verify';
  title: string;
  detail: string;
  evidence: Evidence[];
  tool?: {
    name: string;
    input?: { command?: string; [key: string]: unknown };
    cwd?: string;
  };
  suggestedRule?: string;
  createdAt: string;
  expiresAt: string;
  status: string;
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
}

export interface DecideResult {
  ok?: boolean;
  /** The rule can be refused while the card is still answered — both are reported. */
  error?: string;
  wrote?: string;
  scope?: string;
}

export interface RecoveryAction {
  id:
    | 'recheck'
    | 'closeout'
    | 'resume'
    | 'retry'
    | 'skip'
    | 'fix-agent'
    | 'mcp-continue'
    | 'continue-run'
    | 'release'
    | 'force-release'
    | 'dismiss';
  label: string;
  detail: string;
  /** How it acts: check | own-session | new-agent | run-control | claim | mcp. */
  mechanism?: string;
  /** Which console capability gates it (run | agent | writes), when one does. */
  flag?: string | null;
  /** Set on `fix-agent`: which agent briefing to launch. */
  recoveryClass?: string;
}

export interface PhaseDiagnosis {
  runId: string;
  phase: number;
  status: string;
  blockedOn: (typeof BLOCKED_ON)[number] | null;
  boardState: string;
  said: string | null;
  verification: VerifySummary | null;
  /** Where the commands ran, relative to the root — `.` when it is the root. */
  verifiedIn: string | null;
  lint: { ok: boolean; summary: string } | null;
  closeout: {
    at: string;
    ok: boolean;
    sessionId?: string;
    note?: string;
  } | null;
  sessionId: string | null;
  resumable: boolean;
  note: string | null;
  workingTree: string[];
  lock: string | null;
  actions: RecoveryAction[];
  /** The classifier's word for the phase and why (`server/runner/situation.ts`); null when it could not read. */
  situation: {
    id: string;
    sub?: string;
    key: string;
    label: string;
    blurb: string;
    actor: 'machine' | 'person' | 'wait' | 'none' | string;
    why: string[];
  } | null;
  /** The evidence it was decided from, as short lines. Absent on older servers. */
  evidence?: string[];
  /**
   * Claimed versus evidenced for this phase, from the four facts on disk.
   * Absent on a server from before Phase 4.
   */
  proof?: EvidenceProof;
  /** What is working this phase right now, if anything. Absent means nothing is. */
  live?: PhaseLive;
  /** THIS phase's rulings, from the whole ledger — not just this run's slice. */
  rulings?: Ruling[];
}

export interface TranscriptEntry {
  seq: number;
  at: string;
  event: string;
  data: Record<string, unknown>;
}

/** What a start or a settings change sends. Every field is checked server-side. */
export interface RunSettings {
  model?: string;
  effort?: string;
  autonomy?: Autonomy;
  phaseBudgetUsd?: number | null;
  runBudgetUsd?: number | null;
  phaseOptions?: Record<string, PhaseOptions>;
  skills?: string[];
  /** MCP servers every phase of this run attaches, on top of the plan's own. */
  mcpServers?: string[];
  /** What a phase does when one of those will not connect. Absent = the preference. */
  mcpPolicy?: McpPolicy;
  permissionProfile?: PermissionProfile;
  onlyPhases?: number[];
  resumeRunId?: string;
  /** Work on one plan-wide branch (`pe/<slug>`) instead of what is checked out. */
  gitMode?: GitMode;
  /** New-branch runs only: the final phase pushes and opens a PR. */
  openPr?: boolean;
  /** New-branch runs only: ask for a console-managed checkout of the branch. */
  isolation?: IsolationMode;
  /** The scan class. Absent means `normal`; also accepted by `settings`. */
  priority?: RunPriority;
  /** A plan slug to board after. Start-only — `settings` never reads it. */
  startAfter?: string;
  /** Launch a fresh reviewer session at each phase-finish. Absent means off. */
  reviewEachPhase?: boolean;
  /** Whether a reviewer's changes-requested may hold dependents. Absent = no. */
  reviewerPolicy?: ReviewerPolicy;
  /** The standing ultracode licence in every prompt this run composes. */
  ultracode?: boolean;
  /** When to run `claude ultrareview`. `off` is accepted on `settings`. */
  ultraReview?: UltraReviewMode;
  /** Seed the machine's default skills into this run. */
  attachDefaultSkills?: boolean;
  /** START only: turn the plan's QA gate on before the run begins. */
  qa?: boolean;
  /** A registered account id, `default`, or `auto` (most 5-hour headroom). */
  accountId?: string;
  /** What to do at the shared usage window. */
  onLimit?: OnLimitPolicy;
  /** Heal auto-recoverable halts by launching the fix agent. Sticky on resume. */
  autoRecover?: boolean;
  /** The reviewer's own tier and failure budget — see `shared/run-settings.js`. */
  qaModel?: string;
  qaEffort?: string;
  qaMaxRounds?: number;
  /** QA recovery's two: how a fix session boards, and what ONE round may spend. */
  qaFixStrategy?: QaFixStrategy;
  qaRoundBudgetUsd?: number | null;
}

/**
 * What a QA-recovery verb takes beside its phase — the fix session's own
 * settings, the reviewer's tier, and the loop's two stops.
 *
 * A subset of `RunSettings` rather than the whole of it, and deliberately: a
 * recovery answers one verdict on one phase, so it carries nothing about the
 * run's git strategy, its parallelism or its scope. Naming the subset here is
 * what stops a card from posting a field the recovery door does not read.
 */
export type QaRecoverSettings = Pick<
  RunSettings,
  | 'model'
  | 'effort'
  | 'accountId'
  | 'onLimit'
  | 'permissionProfile'
  | 'skills'
  | 'mcpServers'
  | 'mcpPolicy'
  | 'attachDefaultSkills'
  | 'qaModel'
  | 'qaEffort'
  | 'qaMaxRounds'
  | 'qaFixStrategy'
  | 'qaRoundBudgetUsd'
> & {
  /** Which strategy this loop's FIX sessions use. Absent lets the run decide. */
  strategy?: QaFixStrategy;
  by?: string;
};

/** The on-limit policies a run can carry. `wait` is the pre-accounts behavior. */
export type OnLimitPolicy = OnLimit;
export type WaitReason = 'usage-limit' | 'external';

/** `{ run }` — every mutating run endpoint answers in this envelope. */
export interface RunEnvelope {
  run: RunState | null;
  /** Start only: phases whose §Verification would park at boarding — advisory. */
  preflight?: string[];
  error?: string;
}

export interface AskResult {
  ok: boolean;
  /** The browser's own retry landed twice; the server saw the key and said so. */
  repeated?: boolean;
  error?: string;
}

/** The autopilot's fetchers — merged into `api` by `./index`. */
export const runsApi = {
  /* ---- autopilot ---- */
  runs: () => request<RunState[]>('/api/runs'),
  run: (slug: string) => request<RunDetail>(`/api/run/${q(slug)}`),
  runJournal: (slug: string, id?: number, limit?: number) =>
    request<JournalEntry[]>(
      `/api/run/${q(slug)}/journal${id ? `/${id}` : ''}${limit ? `?limit=${limit}` : ''}`,
    ),
  /**
   * The PLAN's whole ruling ledger, oldest first — not the run's slice.
   *
   * Answers before any run exists, which is the common case for a plan
   * somebody is driving by hand.
   */
  runRulings: (slug: string) => request<{ rulings: Ruling[] }>(`/api/run/${q(slug)}/rulings`),
  /** The run projected onto one absolute time axis (`server/analysis/timeline.ts`). */
  runTimeline: (slug: string, id?: string) =>
    request<RunTimeline>(`/api/run/${q(slug)}/timeline${id ? `/${q(id)}` : ''}`),
  /** One phase's boardings, with each consecutive pair already diffed. */
  runAttempts: (slug: string, phase: number, id?: string) =>
    request<PhaseAttempts>(`/api/run/${q(slug)}/attempts/${phase}${id ? `?run=${q(id)}` : ''}`),
  runTranscript: (slug: string, id?: string, limit?: number) =>
    request<TranscriptEntry[]>(
      `/api/run/${q(slug)}/transcript${id ? `/${id}` : ''}${limit ? `?limit=${limit}` : ''}`,
    ),
  runStart: (slug: string, options?: RunSettings) => post<RunEnvelope>(`/api/run/${q(slug)}/start`, options),
  runPause: (slug: string) => post<RunEnvelope>(`/api/run/${q(slug)}/pause`),
  runResume: (slug: string) => post<RunEnvelope>(`/api/run/${q(slug)}/resume`),
  /**
   * Hold and release — the admission gate, not the phase boundary.
   *
   * Beside Pause/Resume because that is the pair they are compared with, and
   * different from them in the one way that matters: a pause settles the run
   * at the next boundary, a hold refuses the next ADMISSION and lets the
   * running phases finish and write their handoffs.
   */
  runHold: (slug: string, by?: string) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/hold`, by ? { by } : undefined),
  runRelease: (slug: string) => post<RunEnvelope>(`/api/run/${q(slug)}/release`),
  runStop: (slug: string, phase?: number) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/stop`, phase ? { phase } : undefined),
  runSkip: (slug: string, phase: number) => post<RunEnvelope>(`/api/run/${q(slug)}/skip`, { phase }),
  /**
   * Board this phase again — with `edits`, board it again with words and
   * settings for that ONE attempt.
   *
   * A bare call is byte-identical to the plain Retry this has always been: the
   * server reads an empty payload as "no override" and clears any unspent one,
   * so "Retry" and "Retry with edits, having typed nothing" mean the same thing
   * rather than two things.
   */
  runRetry: (slug: string, phase: number, edits?: RetryEdits) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/retry`, { phase, ...(edits ?? {}) }),
  runRecheck: (slug: string, phase: number) => post<RunEnvelope>(`/api/run/${q(slug)}/recheck`, { phase }),
  runCloseout: (slug: string, phase: number) => post<RunEnvelope>(`/api/run/${q(slug)}/closeout`, { phase }),
  /** Set the run to `continue` and retry every phase the MCP preflight parked. */
  runMcpContinue: (slug: string) => post<RunEnvelope>(`/api/run/${q(slug)}/mcp-continue`, {}),
  runRecover: (slug: string) =>
    post<{
      outcome: 'running' | 'resumed' | 'recovering' | 'errand' | 'nothing-to-do';
      detail: string;
      steps: string[];
      run: RunState | null;
      /** The one ask for a person, when the outcome is `errand`. */
      errand?: Errand;
    }>(`/api/run/${q(slug)}/recover`, {}),
  runVerifyCommand: (slug: string, phase: number, command: string) =>
    post<{ ok: true; sessionId: string; token: string; expiresAt: number }>(
      `/api/run/${q(slug)}/verify-command`,
      { phase, command },
    ),
  runResumePhase: (slug: string, phase: number, instruction?: string) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/resume-phase`, {
      phase,
      instruction,
    }),
  phaseDiagnosis: (slug: string, phase: number | string) =>
    request<PhaseDiagnosis>(`/api/run/${q(slug)}/diagnosis/${q(String(phase))}`),
  runSettings: (slug: string, patch: RunSettings) => post<RunEnvelope>(`/api/run/${q(slug)}/settings`, patch),
  /**
   * The two QA-recovery verbs that START something (issue #11): the fix-and-
   * review loop, and the review alone. One function because they are one door
   * and one payload, differing by the verb — `qa-rerun` simply boards no fix
   * session, which is what "the review was wrong rather than the work" means.
   *
   * Waiving is NOT here: it writes one row and starts nothing, so it lives with
   * the plan's other write (`qaWaive`, `api/plans.ts`) and is gated on
   * `--allow-writes` rather than `--allow-run`.
   */
  qaRecover: (slug: string, phase: number, options?: QaRecoverSettings) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/qa-recover`, { phase, ...(options ?? {}) }),
  qaRerun: (slug: string, phase: number, options?: QaRecoverSettings) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/qa-rerun`, { phase, ...(options ?? {}) }),
  // `phase` is optional on all five per-session controls: omitted means "the
  // session that is running", which is what they meant before a run could hold
  // more than one. Naming it makes the server refuse rather than act on
  // whichever phase is running by the time the request lands.
  runFreeze: (slug: string, phase?: number) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/freeze`, phase ? { phase } : undefined),
  runThaw: (slug: string, phase?: number) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/thaw`, phase ? { phase } : undefined),
  // Dismissing a stopped run's card, and putting it back. By run id, because
  // the card belongs to the run that raised it — not to whichever run of that
  // plan happens to be newest.
  runResolve: (slug: string, runId: string, note?: string) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/resolve`, {
      runId,
      ...(note ? { note } : {}),
    }),
  runUnresolve: (slug: string, runId: string) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/unresolve`, { runId }),
  runAsk: (slug: string, question: string, key: string, phase?: number) =>
    post<AskResult>(`/api/run/${q(slug)}/ask`, {
      question,
      key,
      ...(phase ? { phase } : {}),
    }),
  runSteer: (slug: string, instruction: string, key: string, phase?: number) =>
    post<AskResult>(`/api/run/${q(slug)}/steer`, {
      instruction,
      key,
      ...(phase ? { phase } : {}),
    }),

  approvals: () => request<Approval[]>('/api/approvals'),
  decide: (id: string, decision: string, reason?: string, remember?: string, rule?: string) =>
    post<DecideResult>(`/api/approvals/${q(id)}`, {
      decision,
      reason,
      by: 'console',
      ...(remember ? { remember, rule } : {}),
    }),

  /* ---- the convergence loop ---- */
  converge: () => request<ConvergeStatusView>('/api/converge'),
};
