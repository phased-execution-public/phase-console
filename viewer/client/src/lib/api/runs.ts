/**
 * The autopilot — runs, phase records, approvals, the convergence loop, and the
 * ETA shapes every other surface reads.
 */

import { request, post, q } from './client';
import type { AttemptWindow, PhaseClocks } from '../../../../shared/phase-clocks.js';
import type {
  BOARD_WORDS,
  HANDOFF_WORDS,
  RULING_KINDS,
  VERIFICATION_WORDS,
} from '../../../../shared/evidence-model.js';
import type { QA_DISPLAY_WORDS } from '../../../../shared/plan-vocab.js';
import type {
  ETA_BASES,
  PHASE_ETA_CONFIDENCES,
  PROBE_STATUSES,
  SLOW_RULES,
} from '../../../../shared/ops-vocab.js';
import type { PERMISSION_PROFILES, QA_FIX_STRATEGIES, RELAY_MODES } from '../../../../shared/run-settings.js';
import type { BLOCKED_ON } from '../../../../shared/plan-vocab.js';
import type { SILENCE_KINDS } from '../../../../shared/attention-model.js';
import type { RunPriority } from '../../../../shared/orchestration-model.js';
import type { QueueControl } from './state';
import type { PolicySource } from '../../../../shared/policy-model.js';
import type {
  CheckoutState,
  IsolationMode,
  RadarState,
  SettleStrategy,
} from '../../../../shared/worktree-model.js';
import type { ConflictPolicy, LandPolicy, LandingState } from '../../../../shared/landing-model.js';
import type { BudgetFact, BudgetKind } from '../../../../shared/budget-model.js';
import type { RetirementEvidence } from './accounts';
import type { IssueMode } from '../../../../shared/issues-model.js';
import type { MessagingWord } from '../../../../shared/message-model.js';

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
/** The relay's two modes and the probe verdict words — the shared owners' members, by type. */
export type RelayMode = (typeof RELAY_MODES)[number];
export type ProbeStatus = (typeof PROBE_STATUSES)[number];
/** How a QA recovery boards its fix session — the shared vocabulary's two words. */
export type QaFixStrategy = (typeof QA_FIX_STRATEGIES)[number];

export interface VerifyRun {
  command: string;
  ok: boolean;
  code: number;
  /** What it ran AGAINST — the repository, branch and head (control-tower phase 40, #41). */
  tree?: { repo: string; branch: string | null; head: string | null };
  /** The console's own second run of a red command — a rescue when it went green (#45). */
  retry?: boolean;
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
  /**
   * The trees the verdict read (control-tower phase 40, #41) — `verify-in`
   * is the one it ran against; `scope`, `named` and `sibling` the others it
   * looked at. Drawn as the verdict's `{repo, branch, head}` line (phase 24).
   */
  trees?: {
    repo: string;
    branch: string | null;
    head: string | null;
    role: 'verify-in' | 'scope' | 'named' | 'sibling';
  }[];
}

/**
 * The halt vocabulary, imported by identity from `shared/recovery-model.js`.
 * This was a hand-kept third copy of the same seventeen words (the server's
 * `runner/state.ts` mirror is the second); nothing compared them, so nothing
 * would have said which one was right on the day they disagreed.
 */
import type { HaltHolderKind, HaltHolderVerb, HaltKind } from '@shared/recovery-model.js';
import type { WaitReason as WaitReasonWord } from '@shared/status-vocab.js';

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
import type { HumanStepKind, HumanStepWhere } from '@shared/human-step-model.js';
import type { HolderKind } from '@shared/run-lifecycle.js';
import type {
  AutonomyMode,
  BoardingBrief,
  ConvergeTrigger,
  GitMode,
  McpPolicy as McpPolicyWord,
  ModelPolicy,
  OnLimitPolicy as OnLimit,
  PhaseStatus as PhaseStatusWord,
  ReviewerPolicy,
  RungOutcome,
  RunStatus as RunStatusWord,
  SettledRungOutcome,
  UltraReviewMode,
  UndrivenPhase,
  PhaseLifecycle,
  WatchStateWord,
} from '@shared/run-lifecycle.js';

export type { StallSignal };

/** The episode in progress: which signal, since when, and the one line of evidence. */
export interface StallState {
  signal: StallSignal;
  /** ISO — when the condition BECAME true, not when the ticker noticed. */
  since: string;
  detail: string;
  /** `silent` only: the call a quiet lane is inside, else its last one (control-tower phase 95, #138). */
  waitingOn?: { tool: string; summary?: string; open: boolean; since: string; ok?: boolean };
}

/** A tool call that went out and has not come back. */
export interface OpenTool {
  id: string;
  name: string;
  since: string;
  /** The call's own one-line summary — for a `Bash` call, the command. */
  summary?: string;
}

/**
 * One thing a lane's session did, read from its OWN log (control-tower phase
 * 95, #138) — `line` is the log line's id, what a report links to.
 */
export type ActivityEvent =
  | {
      kind: 'tool';
      id: string;
      name: string;
      description?: string;
      summary?: string;
      at: string;
      endedAt?: string;
      exit?: 'ok' | 'error';
      code?: number;
      open?: true;
      line: string;
    }
  | { kind: 'text'; at: string; text: string; line: string }
  | {
      kind: 'marker';
      at: string;
      marker: 'compaction' | 'wrap-up' | 'supervisor' | 'input';
      text: string;
      line: string;
    };

/** `GET /api/run/:slug/phase/:n/activity` — always `untrusted`: a model's own words. */
export interface PhaseActivity {
  slug: string;
  runId?: string;
  phase: number;
  sessionId?: string;
  live: boolean;
  source: 'session-log' | 'none';
  untrusted: true;
  events: ActivityEvent[];
  bytesRead: number;
  why?: string;
}

/** Where a report's figure came from. */
export type ReportSource =
  | { kind: 'journal'; seq: number; event: string }
  | { kind: 'session-line'; line: string }
  | { kind: 'task'; id: string }
  | { kind: 'lane'; field: string }
  | { kind: 'record'; field: string }
  | { kind: 'machine'; sample: 'loadavg' };

/** `GET /api/run/:slug/phase/:n/report` — see `server/analysis/phase-report.ts` (#163). */
export interface PhaseReport {
  slug: string;
  runId: string;
  phase: number;
  at: string;
  status: string;
  live: boolean;
  doing: {
    task?: { id: string; text: string; since?: string; source: ReportSource[] };
    operation?: { label: string; done: number; of: number; pct: number; at: string; source: ReportSource[] };
    last?: { text: string; at: string; source: ReportSource[] };
  };
  done: {
    count: number;
    total: number;
    items: { id: string; text: string; durationMs?: number; source: ReportSource[] }[];
  };
  left: { count: number; items: { id: string; text: string; status: string; source: ReportSource[] }[] };
  waitingOn: {
    kind: 'tool' | 'wait' | 'queue';
    text: string;
    since?: string;
    until?: string;
    source: ReportSource[];
  }[];
  whySlow: { rule: SlowRule; text: string; source: ReportSource[] }[];
  eta: {
    minutes: { low: number; high: number } | null;
    confidence: PhaseEtaConfidence;
    basis: string;
    source: ReportSource[];
  };
  timeline: {
    id: string;
    text: string;
    status: string;
    startedAt?: string;
    durationMs?: number;
    source: ReportSource[];
  }[];
  summary: string;
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
  /** The last call this attempt finished — what a card names when nothing is open (control-tower phase 95). */
  lastCall?: { tool: string; summary?: string; since: string; ok: boolean };
  stall?: StallState;
  /**
   * Which silence the lane is in, since when (epoch ms) and against which
   * threshold (#28, `server/runner/liveness.ts` `silenceOf`). Absent while the
   * console itself silenced the lane (verifying, frozen) and on an older server.
   * A row prints it LABELLED — `SILENCE_LABELS` — never as a bare elapsed.
   */
  silence?: {
    kind: (typeof SILENCE_KINDS)[number];
    sinceMs: number;
    thresholdMs: number;
    graceMs?: number;
  };
  /**
   * API retries since the last productive event. Absent while there are none.
   * See `server/runner/liveness.ts` — without it a retry storm reads as plain
   * silence on every surface an operator has.
   */
  retries?: { count: number; since: string };
  /**
   * What this attempt's session has cost in context so far. Absent until its
   * first API call. See `server/runner/liveness.ts` `LaneTokens`.
   */
  tokens?: LaneTokens;
  /**
   * What the session in flight has cost so far, in dollars — not yet in the
   * run's `spentUsd`, which books a session when it ends. Absent until its
   * first `result`. See `server/runner/liveness.ts`.
   */
  spentUsd?: number;
}

/**
 * A live lane's context and caching (autopilot-token-drain phase 3).
 *
 * `context` is the newest API call's — what every further call re-reads — and
 * `peak` the largest; `input`, `cacheRead`, `cacheWrite` and `output` are this
 * attempt's sums. `rebuilds` counts calls that wrote the cache again instead of
 * reading it, `pollCalls` the status checks the poll-loop guard counted.
 * `window` is the context window the server judged against, when it knew the
 * model; `stage` is the line the context has passed — `wrap-up` (the session has
 * been told to finish up) or `checkpoint` (the console is ending it and boarding
 * the next attempt fresh) — and absent below both.
 */
export interface LaneTokens {
  context: number;
  peak: number;
  calls: number;
  rebuilds: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  pollCalls: number;
  window?: number;
  stage?: 'wrap-up' | 'checkpoint';
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

/**
 * `working` is a session and nothing else; `queued`, `down` (the run itself was
 * stopped, with its cause on `note`) and `verifying` are drawn as themselves
 * (control-tower phase 61, #76).
 */
export type BarKind = 'working' | 'verifying' | 'queued' | 'waiting' | 'down' | 'frozen';

export interface TimelineBar {
  kind: BarKind;
  startMs: number;
  endMs: number;
  attempt: number;
  /** Still open when the journal ended — drawn hatched, never as finished. */
  open: boolean;
  /** Why — a `down` bar's cause (`halted: plan-lint`, `stopped by operator`). */
  note?: string;
}

export type MarkKind =
  'board' | 'verify' | 'rung' | 'park' | 'wall' | 'outcome' | 'session' | 'ask' | 'policy' | 'start' | 'note';

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
  queuedMs: number;
  waitingMs: number;
  downMs: number;
  frozenMs: number;
  /** Session and verification time on closed bars — the critical path's only weight. */
  measuredMs: number;
  attempts: number;
  /** The journal's tail cut this lane's opening off. */
  partial: boolean;
  critical: boolean;
}

/** One value over one attempt window, on the bars' own axis (`server/analysis/timeline.ts`). */
export interface TimelineSeriesPoint {
  phase: number;
  attempt: number;
  startMs: number;
  endMs: number;
  value: number;
  /** Still open: `value` is what it has spent SO FAR. */
  open: boolean;
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
  /**
   * Cost and peak context per attempt window (control-tower phase 7). Optional
   * on the client because a console older than that answers without it.
   */
  series?: { cost: TimelineSeriesPoint[]; tokens: TimelineSeriesPoint[] };
  /** ISO — when the projection was taken; the axis's "now" until a progress frame is newer. */
  asOf?: string;
}

/* ---- the ledger (`server/analysis/ledger.ts`, zero-touch phase 19) ---- */

/** One start of a run, a refused one, or a session started beside it — with the actor's words. */
export interface LedgerStart {
  at: string;
  event: 'run.start' | 'run.start-refused' | 'phase.session-start';
  phase: number | null;
  resumed: boolean;
  door: string | null;
  trigger: string | null;
  guard: string | null;
  counter: string | number | null;
  by: string | null;
  via: string | null;
  origin: string | null;
  remoteUser: string | null;
  account: string | null;
  mode: string | null;
  /** The actor as one sentence. */
  said: string;
  reason: string | null;
}

export type LedgerCap = { value: number; source: string; basis?: string } | null;

/** One `phase.session` line — how a session ended, what it cost, how long it ran, under which caps. */
export interface LedgerSession {
  at: string;
  phase: number | null;
  mode: string;
  attempt: number | null;
  model: string | null;
  sessionId: string | null;
  resumed: boolean;
  endedBy: string | null;
  /** The console ended it, rather than the session finishing its turn. */
  consoleEnded: boolean;
  isError: boolean;
  /** Every prompt's turns, summed — the session's total. */
  turns: number | null;
  turnsSource: string | null;
  /**
   * The largest one prompt's turns — what `maxTurns` binds, per prompt
   * (control-tower phase 89, #62's SIZ-7). `null` on a line from before it.
   */
  promptTurns: number | null;
  /** `null` when the session never reported a cost — unknown, never $0. */
  costUsd: number | null;
  costSource: string | null;
  ms: number | null;
  maxTurns: LedgerCap;
  maxBudgetUsd: LedgerCap;
  account: string | null;
}

/** One rung settlement, with the driver word the ladder table gives its vehicle. */
export interface LedgerRung {
  at: string;
  phase: number | null;
  rung: string;
  driver: string | null;
  outcome: string;
  /** `RUNG_FAILURE_CAUSES` — absent on a server from before control-tower phase 24. */
  cause?: string | null;
  situation: string;
  costUsd: number;
  note: string | null;
  by: string | null;
}

export interface LedgerTotals {
  sessions: number;
  sessionsUsd: number;
  unknownCost: number;
  turns: number;
  ms: number;
  rungsUsd: number;
  spentUsd: number | null;
  gapUsd: number | null;
  /** Within a cent with every cost known; `null` when there is no run to hold it to. */
  reconciled: boolean | null;
  truncated: boolean;
}

export interface RunLedger {
  runId: string | null;
  starts: LedgerStart[];
  sessions: LedgerSession[];
  rungs: LedgerRung[];
  totals: LedgerTotals;
}

export interface LedgerSummaryRow {
  key: string;
  runs: number;
  sessions: number;
  costUsd: number;
  unknownCost: number;
  turns: number;
  ms: number;
}

export interface LedgerSummary {
  plans: LedgerSummaryRow[];
  accounts: LedgerSummaryRow[];
  truncatedRuns: number;
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
    /** The trees that verdict read (`phase.verify` `trees`) — absent from a server before phase 24. */
    trees?: { repo: string; branch: string | null; head: string | null; role?: string }[];
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

/** The landing engine's position for one phase — `server/runner/state.ts` `PhaseLanding`. */
export interface PhaseLanding {
  /** The policy resolved for this phase (`--land N`). */
  policy: LandPolicy;
  /** The conflict policy read once at the landing. */
  conflict: ConflictPolicy;
  /** The ledger's word for the phase as a whole: the least-advanced repository. */
  state: LandingState | 'pending';
  /** The engine's own position — finer than the ledger's word. */
  step: 'local' | 'push' | 'session' | 'verify' | 'watch' | 'done' | 'parked';
  /** Where a PARKED landing resumes from, when it may. Absent on a park a person owns. */
  resumeFrom?: 'local' | 'push' | 'session' | 'verify';
  /** One entry per mounted repository, keyed by the ledger's repo key (`''` is the root). */
  repos: Record<string, PhaseLandingRepo>;
  /** How many times the remote half has been attempted. */
  attempts: number;
  /** Rebase sessions spent on a lane conflict. Absent means none. */
  rebases?: number;
  /** When the landing last moved. */
  at: string;
  /** Why it parked or degraded, in one sentence. */
  note?: string;
}

export interface PhaseLandingRepo {
  /** The branch this repository's work is on — the lane branch, else the run branch. */
  branch: string;
  state: LandingState | 'pending';
  /** The sha the push put on the remote, once it did. */
  pushed?: string;
  /** The pull request, once verified against `gh pr view`. */
  pr?: {
    repo: string;
    number: number;
    url: string;
    state: string;
    mergedAt?: string;
    mergeCommit?: string;
    checkedAt: string;
  };
}

/** One phase's §Verification baseline — `server/runner/state.ts` `VerifyBaseline`. */
export interface PhaseBaseline {
  at: string;
  tree: string | null;
  head: string | null;
  concurrent?: boolean;
  commands: {
    command: string;
    chain?: string;
    ok: boolean;
    code: number;
    failures?: string[];
    tail?: string;
    environment?: string;
    from: 'reused' | 'measured';
    once?: true;
  }[];
}

export interface PhaseRecord {
  phase: number;
  status: PhaseStatus;
  /**
   * An operator's standing word on this phase's place in the queue — moved
   * ahead, held, deferred, withdrawn — with who and why (control-tower phase
   * 99, #135). On the record, so the board and the run card show it whether or
   * not the phase is queued right now.
   */
  queueControl?: QueueControl;
  /** A budget of this phase's past its warning line and not yet raised (phase 25, #40) — budget → fact. */
  budgetApproaching?: Record<string, BudgetFact>;
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
  /** On the wire this IS `phaseClocks.workedMs` — the attempt windows minus frozen time (#28). */
  durationMs?: number;
  /** The labelled clocks, computed by the server when the payload was built (#28). */
  phaseClocks?: PhaseClocks;
  /** Each session's window (#28) — `shared/phase-clocks.js`. */
  attemptWindows?: AttemptWindow[];
  queuedMs?: number;
  queuedAt?: string;
  /**
   * A ready phase serial behind a live lane of its own run (control-tower
   * phase 60, #64) — `ready (behind this run's P<n>)`, never queued.
   */
  serialBehind?: number;
  frozenMs?: number;
  /** When a `waiting` park elapses and the runner resumes the phase's session. */
  parkedUntil?: string;
  /** The session's own words for what it is waiting on. */
  parkReason?: string;
  /** Refs for the external things being waited on (`gh:…#run/N`, `lock:slug/N`). */
  watch?: string[];
  /**
   * What the watch clock last found for each ref, and when it asked — the
   * record's `watchState` (control-tower phase 88, #148), which the phase row
   * shows as each ref's last probe. A ref with no row has not been asked yet.
   */
  watchState?: {
    at: string;
    refs: Array<{
      ref: string;
      scheme: string;
      state: WatchStateWord;
      detail?: string;
      checkedAt: string;
      /** Epoch ms of the next probe; absent means never again (a refused ref). */
      nextDueAt?: number;
      /** The console minted it from a refused in-turn wait, rather than the session declaring it. */
      minted?: true;
      /** A CI run GitHub never started — what the probe read (control-tower phase 111, #166). */
      notRun?: CiNotRunView;
    }>;
  };
  /** How many waiting-external parks this phase has DECLARED (capped by the runner). */
  waits?: number;
  /** How many times the console parked this phase by itself — its own allowance, never `waits`. */
  watchdogParks?: number;
  /** Declared refs no watch scheme can poll, each with why — named on the park, never dropped. */
  watchUnpollable?: { ref: string; reason: string }[];
  /** Who parked it: the session, a hand session through the inbox, or the console's watchdog. */
  declared?: { status: string; by?: string; requested?: string; reason?: string };
  /** A resume the console refused because the session it would resume is still running. */
  resumeRefused?: { sessionId: string; at: string; why: string; pid?: number; lock?: string };
  /**
   * This phase's replay crossed 80 % of its cap (`near-full`) or reached it
   * (`full`) — the session pane says so (control-tower phase 94, #133).
   */
  replay?: { state: 'near-full' | 'full'; bytes: number; cap: number; at: string };
  /** When this phase started queueing behind a foreign lock. */
  lockWaitSince?: string;
  /**
   * What holds this phase up, as the runner wrote it on the record
   * (`server/runner/state.ts` `PhaseRecord.waitingOn`): the queue's shadows of
   * another claim, and — kind `fence` — a sibling phase of this run parked on a
   * declared EXTERNAL wall whose scope meets this one's (control-tower phase 6,
   * #19), with the refs it still waits on and when the fence lifts by itself.
   * The Tower's strips say it (phase 20).
   */
  waitingOn?: PhaseHolder[];
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
  /** Parked on a pinned model the session did not start on (#91) — read with `status: 'parked'`. */
  modelMismatch?: { requested: string; resolved: string; at: string };
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
   * What the phase's §Verification lines read on the tree it boarded on —
   * mirrors `server/runner/state.ts` `VerifyBaseline`. Since control-tower
   * phase 106 a red line keeps its failing tests and an output `tail` (#195),
   * and a line the machine stopped says why (`environment`, #185).
   */
  baseline?: PhaseBaseline;
  /**
   * Where this phase's landing has got to (many-plans-one-repo phase 8) —
   * mirrors `server/runner/state.ts` `PhaseLanding`. Absent on every phase
   * of a plan whose word is `hold`, and on a free console. Read by the run
   * page's landing card (phase 15).
   */
  landing?: PhaseLanding;
  /**
   * Why THIS phase stopped, when the run drove on without it — mirrors
   * `server/runner/state.ts` `PhaseRecord.halt`, written by `settlePhase()`.
   * A parked landing's halt carries the engine's whole sentence: the run
   * branch, the conflicted files, the other lanes that wrote the same branch
   * and where to resolve it (`laneConflictHalt`), which is what the landing
   * card shows a person verbatim. Absent while the phase runs and on every
   * record the run-level `halt` still describes.
   */
  halt?: {
    at: string;
    reason: string;
    phase?: number;
    kind?: HaltKind | (string & {});
    /** How many registered accounts the breaker refuses, out of how many exist. */
    accounts?: { unusable: number; total: number };
  };
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
   * What a live lane last REPORTED, written by the `run:progress` patch and by
   * nothing else — never by the server, and never persisted.
   *
   * The three fields are the ones a summary surface prints and the record's own
   * copies of which are only as fresh as the last invalidating event: between
   * phase boundaries that is never, so a row rendering `tasks`, `costUsd` and
   * the record's context froze at boot while the session worked. Kept beside
   * the record's own rather than overwriting it, so "what the checkpoint says"
   * and "what the lane said three seconds ago" stay two answerable questions.
   */
  live?: {
    tasks?: { total: number; done: number; active: string | null };
    spentUsd?: number;
    contextTokens?: number;
    /** The labelled clocks as of the last `run:progress` frame (#28). */
    phaseClocks?: PhaseClocks;
  };
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
  /**
   * A usage wall this phase is parked on (control-tower phase 54, #78): the
   * account and window, the reset "at the latest", and the last usage reading
   * that judged it. Read through `wallReading` (`@shared/situation-model.js`),
   * never shown raw — the countdown is derived at each reading (phase 86, #132).
   */
  usageWall?: {
    account: string;
    bucket: string;
    latest: string;
    probes: number;
    lastReading?: { at: string; by: string; ok: boolean; resetsAt?: string };
  };
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
  /**
   * The board reads this phase in progress (or stuck) and nothing of its live
   * run drives it (control-tower phase 79, #114). Read through the run's
   * `undriven` list, which answers only for a live run.
   */
  undriven?: Omit<UndrivenPhase, 'phase'>;
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
  /**
   * The `git worktree lock` reason the runner fastened on `worktree`, written
   * only when git accepted it (phase 15). **Absent means not locked by this
   * console** — a shared-root lane, a run-level checkout, or a lock git
   * refused — so a row that reads "locked" is the runner's own word.
   */
  locked?: string;
}

/**
 * One of the console's OWN lanes — mirrors `server/runner/state.ts`
 * `VerifyingLane` (control-tower phase 89, #68's 2026-09-25 05:44Z comment).
 *
 * A pass the runner is running for a phase right now, under the phase's grant,
 * with no session behind it: the phase's §Verification (`verify`), its
 * baseline at boarding (`baseline`) or a context wrap-up's fast gate
 * (`wip-gate`). `children` holds only sessions, so a run mid-verification read
 * `running` with nothing in it and the Runs page showed nothing working.
 */
export interface VerifyingLane {
  phase: number;
  purpose: 'verify' | 'baseline' | 'wip-gate';
  /** The command running now, condensed by the server (≤ 200 chars). */
  command: string;
  /** 1-based position of that command in the pass, out of `total`. */
  index: number;
  total: number;
  /** ISO — when the PASS started. */
  startedAt: string;
  /** ISO — when THIS command started. */
  commandStartedAt: string;
  /** It runs in a clean checkout of the phase's HEAD, not the working tree. */
  exported?: boolean;
  /** The console's own pid — the process whose children the commands are. */
  pid: number;
  /** The pass is in its `Setup:` preamble — `command` is the bring-up command (control-tower phase 105). */
  stage?: 'setup';
  /** The running command's own process (control-tower phase 105, #173). */
  child?: { pid: number; procStartedAt: string };
}

export interface RunState {
  /** A run-wide budget past its warning line and not yet raised (phase 25, #40) — budget → fact. */
  budgetApproaching?: Record<string, BudgetFact>;
  /**
   * The plan's issue drafts waiting on a person (control-tower phase 84, #118)
   * — set by `GET /api/runs` on the plan's newest run only, absent at zero.
   */
  pendingDrafts?: number;
  /**
   * The phases the board reads in progress that nothing of this live run
   * drives (control-tower phase 79, #114) — `undrivenPhases`, set by
   * `GET /api/runs` on every run; empty for a run that is not live.
   */
  undriven?: UndrivenPhase[];
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
  /** The part of `spentUsd` its sessions spent on credit past a plan window (control-tower phase 93). */
  creditUsd?: number;
  maxConsecutiveFailures: number;
  /** The run's own ladder rung caps (#14); absent, the console's preference speaks. */
  ladderPerRunRungs?: number;
  ladderPerPhaseRungs?: number;
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
  /**
   * The console's own lanes, keyed by phase like `children` (control-tower
   * phase 89) — `GET /api/runs` sends only the ones the live console is
   * running now. Absent or empty when nothing is verifying, and on a server
   * from before the field.
   */
  verifying?: Record<string, VerifyingLane>;
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
    /**
     * How many registered accounts the breaker refuses, out of how many exist
     * — written on halts whose remedy might be "use another account", so a
     * card can say whether there IS another one. Absent on every other kind,
     * and on records written before 5.2.0.
     */
    accounts?: { unusable: number; total: number };
    /**
     * The budget a `budget` or `failure-streak` halt spent (control-tower
     * phase 14, #40) — the run's dollars or the streak, with its arithmetic.
     */
    budget?: BudgetFact;
    /** A `nothing-ready` park's holders, one per phase (server `HaltHolder`, phase 5). */
    holders?: HaltHolder[];
    /** What a credential refusal stood on (#57) — the retirement's evidence. */
    evidence?: RetirementEvidence;
  } | null;
  /**
   * What each counted failure was charged ON (control-tower phase 87, #122):
   * the same block stopping four phases is one cause, charged once.
   */
  failureRoots?: { phase: number; key: string; label: string }[];
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
  /**
   * Who that account answered when the run bound to it (control-tower phase
   * 91, #131) — a run parked `identity-changed` offers to continue on the new
   * login or move back to this person's profile.
   */
  identity?: { account: string; key: string; email?: string; org?: string; at: string };
  /** What the run does at the shared usage window. Absent = `wait`. */
  onLimit?: OnLimitPolicy;
  /**
   * Whether the run's model may move (control-tower phase 54, #91): `pinned`
   * runs on the model it names or parks; `ladder` may fall back, step down at
   * a wall and escalate. Absent = `ladder`; the plan's `**Model policy:**`
   * outranks it.
   */
  modelPolicy?: ModelPolicy;
  /**
   * What each requested model resolved to, as the sessions' own `init` said —
   * `from` when a request moved within this run (`run.model-resolved`).
   */
  resolvedModels?: Record<string, { resolved: string; at: string; from?: string }>;
  /**
   * The run's answers to the decision manifest (phase 11): the launch form's
   * required fields and the manifest as the door resolved it. Absent on a run
   * from before 5.0.0.
   */
  resumeOnRestart?: boolean;
  relay?: RelayMode;
  /** The run's default permission mode (control-tower phase 11) — absent means `acceptEdits`. */
  permissionMode?: string;
  /** Minutes an approval card waits for a person (control-tower phase 97, #140) — absent means the hook call's hour. */
  approvalTimeoutMinutes?: number;
  /** How a QA recovery's fix session boards, and what one round may spend — absent is `resume` and no ceiling. */
  qaFixStrategy?: QaFixStrategy;
  qaRoundBudgetUsd?: number | null;
  accounts?: AccountRequirement[];
  acknowledgedWaivers?: string[];
  manifest?: ResolvedManifest;
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
  /**
   * The seven words the launch form gained in many-plans-one-repo phase 15
   * (mirrors `server/runner/state.ts`). Each is absent when the run said
   * nothing — the plan's line, the console's preference or the owner's
   * default then decides — and the plan's own line outranks every one of
   * them. `baseBranch` is immutable once the run's branch exists;
   * `issuesMode` may only tighten mid-run (the settings door 409s the other
   * direction, `features/run-setup/sections.tsx` says so beside the control).
   */
  baseBranch?: string;
  /**
   * What that word (or the plan's line, the preference, the shipped default)
   * RESOLVED to when the run's branch was cut — the ref, the commit, which
   * arm answered (`origin-head` · `trunk` · `head` · `ref`) and who declared
   * the word (`plan` · `run` · `console` · `default`). Written once by the
   * runner (phase 15); absent on a run whose word resolved to nothing and on
   * every run file from before the field. The lane row reads it — "what was
   * every lane cut from" is asked most by whoever arrives after the console
   * that decided.
   */
  base?: {
    ref: string;
    sha: string;
    source: 'origin-head' | 'trunk' | 'head' | 'ref' | (string & {});
    declaredBy: PolicySource | (string & {});
  };
  maxConcurrentPerRepo?: number;
  worktreeRetention?: string;
  landing?: LandPolicy;
  conflictPolicy?: ConflictPolicy;
  messaging?: MessagingWord;
  issuesMode?: IssueMode;
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
  /** People's notes on this run, oldest first — `server/runner/state.ts` `RunNote` (control-tower phase 96). */
  notes?: RunNote[];
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

/** One thing holding a `nothing-ready` park (server `HaltHolder`): its phase, kind, the ONE verb that clears it. */
export interface HaltHolder {
  phase: number;
  kind: HaltHolderKind;
  verb: HaltHolderVerb;
  why: string;
  setting?: string;
  gate?: string;
  /** The gate's `--gate-status` verdict word — a person's (`manual`) or a machine's (`blocked`). */
  gateKind?: string;
  /**
   * The blocker BEHIND a cross-plan gate, link by link (#150 ask 4): the phase
   * the gate waits on, what holds THAT, and the holder run's phases left and
   * ETA. Drawn when the server sends it; no server writes it yet.
   */
  chain?: { label: string; phasesLeft?: number; eta?: string }[];
}

/** The plan a plan-mode phase presented, as the console kept it (`GET …/plan-text`). */
export interface PlanText {
  ok: true;
  phase: number;
  sha: string;
  bytes: number;
  at: string;
  state: string;
  truncated: boolean;
  text: string;
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
  /**
   * The budget that stopped this phase, when a budget did (control-tower phase
   * 14, #40): which one, its arithmetic and what spent it — the raise the card
   * offers beside the reason. Its headline is already the errand's `need`.
   */
  budget?: BudgetFact;
  /** A CAP errand's arithmetic (control-tower phase 5, #14): which cap, spent of allowed, and the setting that raises it. */
  cap?: string;
  spent?: number;
  limit?: number;
  onDonePhases?: number;
  setting?: { key: string; scope: string; label?: string } | string;
  /** Whether a Retry of this phase would forgive what the cap counted — said BEFORE the press (#14 ask 3). */
  replenishes?: boolean;
  /**
   * The other phases this ONE errand stands for — siblings that met the same
   * declared external wall and were folded into it rather than filing a copy
   * each (control-tower phase 6, #19). Each carries `foldedInto` on its slot.
   */
  alsoPhases?: number[];
}

/**
 * One holder on a phase record's `waitingOn` (`server/runner/state.ts`) — the
 * queue's shadow of another claim (slug and owner), or a `fence`: the sibling
 * phase whose declared external wall holds this one's scope, its live refs,
 * and when it lifts by itself (epoch ms; null for no known end).
 */
export interface PhaseHolder {
  slug: string;
  phase?: number;
  owner: string;
  kind?: HolderKind;
  refs?: string[];
  until?: number | null;
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
  /** This phase's ask is another phase's errand — the one it was folded into (`Errand.alsoPhases`). */
  foldedInto?: number;
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
/** How far a live phase's own-rate ETA can be trusted (control-tower phase 95, #163). */
export type PhaseEtaConfidence = (typeof PHASE_ETA_CONFIDENCES)[number];
/** A why-slow cause's rule (#163). */
export type SlowRule = (typeof SLOW_RULES)[number];

/**
 * Always a range, always hedged, always naming its clock — see
 * `server/analysis/stats.ts`. `clock` is always `'working'` here: a calendar
 * figure is a different shape, `Forecast` (`lib/api/plans`).
 */
export interface EtaEstimate {
  ratePerWeight: number;
  /** The affine floor: working time any phase takes before its weight counts. */
  floorMs: number;
  /** The affine slope, milliseconds per unit of weight. */
  slopeMsPerWeight: number;
  /** How many measured phases the reading weighted. */
  samples: number;
  /** Finished phases with no usable measurement, reported beside the count. */
  missing: number;
  basis: EtaBasis;
  remainingWeight: number;
  remainingPhases: number;
  lowMs: number;
  highMs: number;
  /** Working time: the remaining phases back to back, nothing parked, queued or overnight. */
  clock: 'working';
  label: string;
}

/** One phase's own estimate — a point, not a range. */
export interface PhaseEta {
  phase: number;
  weight: number;
  estMs: number;
  basis: EtaBasis;
  clock: 'working';
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
  /**
   * The `git worktree lock` reason, when the tree is locked. An EMPTY string
   * is a real answer — git allows a lock with no reason — and a different one
   * from absent, which means the tree is not locked.
   */
  locked?: string;
}

/** What two live branches would do to each other if they met. */
export interface RadarPair {
  a: string;
  b: string;
  state: RadarState;
  /** The files the verdict is about: the overlap, or the conflicted subset. */
  files: string[];
  /**
   * The clash zones this pair touches, when it touches any — files that merge
   * CLEANLY and are wrong afterwards. Absent when it touches none, which is a
   * different fact from a console with no radar.
   */
  zones?: string[];
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
  /** `verify` is a question for a person, not a permission question; `question` is a relayed one (phase 14). */
  kind: 'gate' | 'tool' | 'verify' | 'question';
  title: string;
  detail: string;
  evidence: Evidence[];
  tool?: {
    name: string;
    input?: { command?: string; [key: string]: unknown };
    cwd?: string;
  };
  suggestedRule?: string;
  /** The ask rule that matched the call, or null when none did. Absent before 5.0.0. */
  matched?: string | null;
  /**
   * The plan's `permission.destructive` row this call was checked against
   * (control-tower phase 84, #112): what it answered, and why — on a card a
   * person must answer, why it did NOT cover this call.
   */
  manifest?: {
    key: string;
    rule: string;
    value: string;
    source: string;
    /**
     * `deny`: the row allows the push only in its bare form (`bareForm`) —
     * answered at once, or by the manifest when an automatic actor settled
     * the card (control-tower phase 107, #186); never on a card that waits.
     */
    answer: 'allow' | 'deny' | null;
    why: string;
    branch?: string;
    bareForm?: string;
  };
  createdAt: string;
  expiresAt: string;
  /** What the card's timeout will do, said before it happens (control-tower phase 97, #140). */
  onTimeout?: string;
  /** The hook call's hard limit: an Extend past it makes the card stand instead (#140). */
  hookDeadline?: string;
  /** Set by an Extend past `hookDeadline`: the card stands until then (#140). */
  standsUntil?: string;
  /** The card outlived its hook call and stands — its session was told no at `at` (#140). */
  converted?: { at: string };
  /** `pending`, `allow`, `deny`, or — for a card a restart left — `unanswerable`. */
  status: string;
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
  /** A card the console restarted under and kept answerable. */
  recovered?: { at: string; from: string };
  /** Why a recovered card can no longer be answered. */
  unanswerable?: { reason: string; detail: string };
  /**
   * A relayed question's part (phase 14): the questions the call carries, the
   * answers so far and who gave them, and — when the console went away with the
   * window open — the deferral that keeps the call for its session's resume.
   */
  question?: {
    mechanism: string;
    tool: string;
    items: {
      key: string;
      question: string;
      header?: string;
      options: { label: string; description?: string }[];
      multiSelect: boolean;
    }[];
    answers: Record<string, { label: string; by: string; at: string; ruleId?: string; who?: string }>;
    deferred?: { toolUseId: string; at: string; why: string };
  };
}

/** What answering a relayed question reports (`POST /api/run/:slug/answer`). */
export interface AnswerResult {
  ok: boolean;
  answered?: string[];
  remaining?: number;
  error?: string;
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
/** One account a run may spend, and the five-hour headroom (percent) it must show first. */
export interface AccountRequirement {
  id: string;
  minHeadroomPct: number;
}

/** One manifest row as the door resolved it (`server/prelude.ts`). */
export interface PreludeRow {
  key: string;
  value: string;
  owner: string;
  state: string;
  blocking: 'yes' | 'no';
  source: string;
  /** Where the prelude got the row: the plan (or its twin), the launch form, or a shipped default. */
  origin: string;
  /** Which probe judged it, for the probed rows. */
  probe?: 'accounts' | 'mcp' | 'credentials' | 'delivery' | 'verification';
}

/** One probe's answer — the word, the reason, the warnings when some but not all failed. */
export interface ProbeVerdict {
  status: ProbeStatus;
  ok: boolean;
  reason: string;
  warnings?: string[];
  /** The probe's facts — for `verification`, a `VerificationDetail`. */
  detail?: unknown;
}

/** A §Verification fragment the runner will not run on its own, and why (`VerifyNotRun`). */
export interface VerificationItem {
  text: string;
  reason: string;
  /** The sha256 of the whole command — what an answer is bound to. */
  fp?: string;
  /** One exact approval would make it run. Nothing destructive, off-machine or unparseable ever is. */
  approvable?: boolean;
}

/** One phase's verification review, as the fifth probe reports it (`runner/verify-review.ts`). */
export interface VerificationReviewView {
  phase: number;
  verdict: 'clear' | 'records' | 'may-ask' | 'asks' | 'parks';
  park?: string;
  runs: string[];
  items: VerificationItem[];
  waived: VerificationItem[];
  setup: VerificationItem[];
  missing: string[];
}

/** Probe 5's detail: every open phase's review, the run's scope, and the draft's answers resolved. */
export interface VerificationDetail {
  reviews: VerificationReviewView[];
  scope: number[] | null;
  answers?: {
    approve: { fp: string; text: string }[];
    waive: { phase: number; fp: string; text: string }[];
  };
}

/** The run-start prelude (`GET /api/run/:slug/prelude`, and the body of a 409 at the start door). */
export interface Prelude {
  slug: string;
  rows: PreludeRow[];
  /**
   * `verification` is absent from a console older than 2026-09-18; `trees`
   * (probe 6, control-tower phase 40) and `git-strategy` (probe 7, phase 11)
   * from one older than those phases. Their details are `TreesDetail` and
   * `{ lines: GitStrategyLine[] }`.
   */
  probes: Record<'accounts' | 'mcp' | 'credentials' | 'delivery', ProbeVerdict> & {
    verification?: ProbeVerdict;
    trees?: ProbeVerdict;
    'git-strategy'?: ProbeVerdict;
    /** The plan's own human steps, each proof run at the door (control-tower phase 44). Never blocks. */
    'human-steps'?: ProbeVerdict;
  };
  blocking: { key: string; why: string }[];
  waived: string[];
  acknowledged: string[];
  manifestPresent: boolean;
  accounts: AccountRequirement[];
  credentials: { policy: string; ids: string[]; held: string[]; missing: string[] };
  delivery: { ok: boolean; channels: string[]; acknowledged: boolean };
  /**
   * The plan-declared human steps of the phases this run will drive — "this
   * run will need you N times", asked at the door rather than at three in the
   * morning. Absent from a console older than control-tower phase 44.
   */
  humanSteps?: PreludeStep[];
  at: string;
}

/** One plan-declared step as the launch door lists it — its proof run at the door. */
export interface PreludeStep {
  phase: number;
  kind: HumanStepKind;
  what: string;
  where: HumanStepWhere;
  /** `pre-cleared` — the proof already holds; `needed` — it does not; `unchecked` — it could not be run. */
  state: 'pre-cleared' | 'needed' | 'unchecked';
  open?: { url: string } | { command: string };
  proof?: string;
  /** What the proof answered at the door, in its own words. */
  read?: string;
  windowMinutes?: number;
  autoOpen?: 'host';
  credential?: string;
}

/** The launch draft's answers to probe 5 — fingerprints; waivers as `<phase>:<fp>`. */
export interface VerifyAnswers {
  approve: string[];
  waive: string[];
}

/** The manifest as `run.start` echoed it and the run stores it. */
export interface ResolvedManifest {
  decisions: Omit<PreludeRow, 'probe'>[];
  accounts: AccountRequirement[];
  credentials: Prelude['credentials'];
  delivery: Prelude['delivery'];
  probes: Record<string, { status: string; reason: string }>;
  overridden?: { rows: string[]; by: string; at: string };
  at: string;
}

/** What the launch form's draft sends the prelude. */
export interface PreludeDraft {
  accounts?: AccountRequirement[];
  relay?: RelayMode;
  resumeOnRestart?: boolean;
  acknowledgedWaivers?: string[];
  model?: string;
  profile?: string;
  mcpPolicy?: string;
  /** Probe 5's question: the phases the run will drive, its autonomy, and the answers so far. */
  onlyPhases?: number[];
  autonomy?: string;
  verifyAnswers?: VerifyAnswers;
  /** Probes 6 and 7: the draft's checkout — whether it cuts a branch, and whether it stands in a tree of its own. */
  gitMode?: string;
  isolation?: string;
}

/** One plan git line the chosen strategy will not honour (probe 7, #18) — `server/prelude.ts` `GitStrategyLine`. */
export interface GitStrategyLine {
  kind: 'branch' | 'worktrees' | 'checkout';
  /** What the plan says. */
  plan: string;
  /** What this run does instead. */
  run: string;
  /** Whether `honour` can make the plan's line hold. */
  honourable: boolean;
  phases?: number[];
}

/** Probe 6's facts (control-tower phase 40) — `server/prelude.ts` `TreeFacts`. */
export interface TreesDetail {
  held: { repo: string; branch: string; run: string; slug: string }[];
  isolated: boolean;
  /** Could the console isolate this plan? `null` when that could not be asked. */
  grantable: boolean | null;
  refusal?: string;
}

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
  /**
   * The prelude's required answers (phase 11, START only): how the run resumes
   * after a console restart, whether the relay is armed, the accounts it may
   * spend with their minimum headroom, the waived rows it acknowledges, and
   * the one recorded way past a blocking row.
   */
  resumeOnRestart?: boolean;
  relay?: RelayMode;
  accounts?: AccountRequirement[];
  acknowledgedWaivers?: string[];
  manifestOverride?: { rows?: string[]; by?: string };
  /** The reviewer's own tier and failure budget — see `shared/run-settings.js`. */
  qaModel?: string;
  qaEffort?: string;
  qaMaxRounds?: number;
  /** QA recovery's two: how a fix session boards, and what ONE round may spend. */
  qaFixStrategy?: QaFixStrategy;
  qaRoundBudgetUsd?: number | null;
  /** The run's own ladder rung caps (#14): a whole number sets one, `null` clears it. */
  ladderPerRunRungs?: number | null;
  ladderPerPhaseRungs?: number | null;
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
/** The wait axis's reason — `shared/status-vocab.js` owns the words; this copy once held two of the four (LFC-5). */
export type WaitReason = WaitReasonWord;

/** `{ run }` — every mutating run endpoint answers in this envelope. */
export interface RunEnvelope {
  run: RunState | null;
  /** Start only: phases whose §Verification would park at boarding — advisory. */
  preflight?: string[];
  error?: string;
  /** A person's press (retry, closeout, resume-phase, delegate): what it launched — only when the phase boarded at that admission. */
  launched?: PressLaunch;
  /** …or what it QUEUED instead (control-tower phase 86, RS-5): a re-board is a hint, and a hint is not a launch. */
  queued?: PressQueued;
  /** Delegate only: the `deviation` ruling it wrote on the plan's ledger. */
  rulingId?: string;
}

/**
 * What a person's press launched (control-tower phase 53, #54–#56) — the answer
 * a verb gives instead of 200-and-nothing. `session` is the session it resumed,
 * or `null` when it boarded a FRESH one with the resume brief, and `why` says
 * why the phase's own session was not resumed.
 */
export interface PressLaunch {
  runId: string;
  phase: number;
  session: string | null;
  brief: string;
  why?: string;
}

/**
 * What a press queued rather than boarded (control-tower phase 86, RS-5): the
 * same account, plus its 1-based place in line — null when the loop decided
 * nothing in time to say — and what it waits behind.
 */
export interface PressQueued extends PressLaunch {
  position: number | null;
  behind?: { kind: string; slug: string; phase: number | null; owner: string };
}

export interface AskResult {
  ok: boolean;
  /** The browser's own retry landed twice; the server saw the key and said so. */
  repeated?: boolean;
  error?: string;
}

/**
 * One person's note on a run (control-tower phase 96, #142) — the wire shape
 * of `server/runner/state.ts` `RunNote`. A PINNED note is a standing decision:
 * shown on the run page and read into the boot prompt of every phase it
 * applies to, until somebody unpins it. Both editions: the route and the
 * record are free, so the types stay outside the Pro region below.
 */
export interface RunNote {
  id: string;
  at: string;
  by: string;
  text: string;
  pinned: boolean;
  /** The phase it is about; absent for the whole run. */
  phase?: number;
}

export interface RunNoteResult {
  note: RunNote;
  run: RunState;
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
  /** Why each start happened and what every session cost, held to the run's spend (`server/analysis/ledger.ts`). */
  runLedger: (slug: string, id?: string) =>
    request<RunLedger>(`/api/run/${q(slug)}/ledger${id ? `/${q(id)}` : ''}`),
  /** Every open plan's newest runs, their ledgers per plan and per account — what Insights draws. */
  ledgerSummary: () => request<LedgerSummary>('/api/ledger'),
  /**
   * The session replay, read from the end of its files. With `phase`, that
   * phase's own replay — one capped file per phase since control-tower phase 94
   * (#133) — or its journal lines, said so, when it has none.
   */
  runTranscript: (slug: string, id?: string, limit?: number, phase?: number) => {
    const query = new URLSearchParams();
    if (limit) query.set('limit', String(limit));
    if (phase != null) query.set('phase', String(phase));
    const search = query.toString();
    return request<TranscriptEntry[]>(
      `/api/run/${q(slug)}/transcript${id ? `/${id}` : ''}${search ? `?${search}` : ''}`,
    );
  },
  /**
   * A phase's last events, read from its live (or latest) session's own log
   * (control-tower phase 95, #138) — whatever the replay's size.
   */
  phaseActivity: (slug: string, phase: number, limit = 20) =>
    request<PhaseActivity>(`/api/run/${q(slug)}/phase/${phase}/activity?limit=${limit}`),
  /** A live phase's report: doing, done, left, waiting on, why slow, when (#163). */
  phaseReport: (slug: string, phase: number) =>
    request<PhaseReport>(`/api/run/${q(slug)}/phase/${phase}/report`),
  runStart: (slug: string, options?: RunSettings) => post<RunEnvelope>(`/api/run/${q(slug)}/start`, options),
  /**
   * The run-start prelude for the launch form's DRAFT (phase 11): the manifest
   * rendered and the probes run over the console's own facts, before
   * Launch is pressed. The draft's answers ride in the query so the form shows
   * exactly what the door will judge.
   */
  runPrelude: (slug: string, draft: PreludeDraft = {}) => {
    const params = new URLSearchParams();
    if (draft.accounts?.length)
      params.set('accounts', draft.accounts.map((a) => `${a.id}:${a.minHeadroomPct}`).join(','));
    if (draft.relay) params.set('relay', draft.relay);
    if (typeof draft.resumeOnRestart === 'boolean')
      params.set('resumeOnRestart', String(draft.resumeOnRestart));
    if (draft.acknowledgedWaivers?.length) params.set('ack', draft.acknowledgedWaivers.join(','));
    if (draft.model) params.set('model', draft.model);
    if (draft.profile) params.set('profile', draft.profile);
    if (draft.mcpPolicy) params.set('mcpPolicy', draft.mcpPolicy);
    if (draft.onlyPhases?.length) params.set('only', draft.onlyPhases.join(','));
    if (draft.autonomy) params.set('autonomy', draft.autonomy);
    if (draft.verifyAnswers?.approve.length) params.set('approve', draft.verifyAnswers.approve.join(','));
    if (draft.verifyAnswers?.waive.length) params.set('waive', draft.verifyAnswers.waive.join(','));
    if (draft.gitMode) params.set('gitMode', draft.gitMode);
    if (draft.isolation) params.set('isolation', draft.isolation);
    const query = params.toString();
    return request<{ prelude: Prelude }>(`/api/run/${q(slug)}/prelude${query ? `?${query}` : ''}`);
  },
  runPause: (slug: string) => post<RunEnvelope>(`/api/run/${q(slug)}/pause`),
  /**
   * One cloud review of this run's branch, now — billed to the operator's own
   * account, one review per press. The answer is the review's own result: a
   * review that could not happen is `unknown` with its reason, never "nothing found".
   */
  runUltraReview: (slug: string) =>
    post<{
      slug: string;
      phase: number;
      state: 'landed' | 'unknown';
      verdict?: string;
      findings?: number;
      reason?: string;
      ms: number;
    }>(`/api/run/${q(slug)}/ultrareview`),
  /**
   * A person's answer to an identity park (control-tower phase 91, #131):
   * `continue` on the login the account answers now, or `move` to a registered
   * account that answers the identity the run started on. Both resume the run.
   */
  runIdentity: (slug: string, choice: 'continue' | 'move', accountId?: string) =>
    post<RunEnvelope & { accountId?: string }>(`/api/run/${q(slug)}/identity`, {
      choice,
      ...(accountId ? { accountId } : {}),
    }),
  // `resumed` says which of the two it did (control-tower phase 77, #102):
  // took back a pause not yet reached, or started a settled pause again — or,
  // since control-tower phase 110 (#176), a parked, halted or interrupted run.
  runResume: (slug: string) =>
    post<
      RunEnvelope & {
        resumed?: {
          runId: string;
          from: 'pausing' | 'paused' | 'parked' | 'halted' | 'interrupted';
          act: 'pause-cancelled' | 'relaunched';
        };
      }
    >(`/api/run/${q(slug)}/resume`),
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
  /**
   * Zero the consecutive-failure streak and nothing else.
   *
   * Its own verb because the thing that is wrong is the COUNTER: an outage can
   * spend a run's whole allowance in seconds, and there is no phase to retry.
   * Answers what the counter was, so the button can say what it did. `409` on
   * a finished run — a settled run's record is not editable.
   */
  runClearStreak: (slug: string) =>
    post<RunEnvelope & { was: number }>(`/api/run/${q(slug)}/clear-streak`, {}),
  /**
   * Raise the budget that stopped the work, where it was declared, and retry —
   * one press (control-tower phase 14, #40). `add` is the raise in the
   * budget's unit (minutes, dollars, rungs); a wait writes the plan, so it
   * answers 403 on a console without `--allow-writes`.
   */
  runRaiseBudget: (
    slug: string,
    body: { budget: BudgetKind; phase?: number; add?: number; to?: number; scope?: 'phase' | 'plan' },
  ) =>
    post<{
      budget: BudgetKind;
      phase: number | null;
      was: number;
      now: number;
      retried: boolean;
      run: RunState | null;
    }>(`/api/run/${q(slug)}/raise-budget`, body),
  /** The plan a plan-mode phase presented (control-tower phase 17, #34) — what the halt card's reader draws. */
  runPlanText: (slug: string, phase: number) =>
    request<PlanText>(`/api/run/${q(slug)}/plan-text?phase=${encodeURIComponent(String(phase))}`),
  /** A person's Approve or Reject of that plan (control-tower phase 11). */
  runPlanDecision: (slug: string, body: { phase: number; decision: 'approve' | 'reject'; reason?: string }) =>
    post<{ ok: true; decision: 'approve' | 'reject'; sha: string }>(
      `/api/run/${q(slug)}/plan-approval`,
      body,
    ),
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
  /** Hand the acts a phase kept for a person (`--needs human-acts`) to its session. */
  runDelegate: (slug: string, phase: number, instruction?: string) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/delegate`, {
      phase,
      instruction,
    }),
  /** "Done — continue": a person did the errand the phase is parked on (control-tower phase 88, #124). */
  runErrandAnswered: (slug: string, phase: number, note?: string) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/phase/${phase}/errand-answered`, { note }),
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
  // A person's note on the run, and pinning one (control-tower phase 96, #142).
  runNote: (slug: string, body: { text: string; pinned?: boolean; phase?: number }) =>
    post<RunNoteResult>(`/api/run/${q(slug)}/notes`, body),
  runPinNote: (slug: string, id: string, pinned: boolean) =>
    post<RunNoteResult>(`/api/run/${q(slug)}/notes`, { id, pinned }),
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
  // A person's pick on a relayed question, inside its window (phase 14).
  answerQuestion: (slug: string, approvalId: string, answers: { key: string; label: string }[]) =>
    post<AnswerResult>(`/api/run/${q(slug)}/answer`, { approvalId, answers }),
  decide: (id: string, decision: string, reason?: string, remember?: string, rule?: string) =>
    post<DecideResult>(`/api/approvals/${q(id)}`, {
      decision,
      reason,
      ...(remember ? { remember, rule } : {}),
    }),
  // Not yet (control-tower phase 97, #140): the card's deadline, `minutes` later.
  extend: (id: string, minutes: number) =>
    post<{ ok: boolean; standing?: boolean; error?: string; approval?: Approval }>(
      `/api/approvals/${q(id)}/extend`,
      { minutes },
    ),

  /* ---- the convergence loop ---- */
  converge: () => request<ConvergeStatusView>('/api/converge'),
};

/** A CI run GitHub never started, as the watch row carries it (`server/watch-refs.ts` `CiNotRun`). */
export interface CiNotRunView {
  cause: string;
  repo: string;
  run: string;
  attempt?: number;
  jobs: number;
  annotation: string;
  budgets?: Array<{
    scope: 'repository' | 'organization';
    name: string;
    amount: number;
    consumed: number;
    stops: boolean;
  }>;
  unreadable?: string;
  headroom?: boolean;
}
