/**
 * Plans, phases, handoffs and gates — the plan surface — and the guarded write
 * verbs that act on it.
 */

import { request, post, q } from './client';
import { type HEALTH_SEVERITIES } from '../../../../shared/ops-vocab.js';
import { type GATE_KINDS } from '../../../../shared/plan-vocab.js';
import { PLAN_INCLUDES, includeParam } from '../../../../shared/projection.js';
import type { EtaEstimate, EvidenceProof, PhaseEta, PhaseLive, PreflightWarning } from './runs';

export interface PlanSummary {
  slug: string;
  title?: string;
  kind?: string;
  phases: number;
  ready: unknown[];
  /** Named explicitly — the index signature below types them `unknown`, and
   * closure is read by the nav counts, which cannot cast their way to it. */
  status?: string;
  closed?: boolean;
  [key: string]: unknown;
}

/* ---------------- the plan surface ----------------
 * These mirror `server/service.ts` (`PlanDetail`, `PhaseView`, `RouteView`) and
 * `server/analysis/stats.ts` (`PlanStats`). They are hand-written rather than
 * generated because the server is frozen for this rewrite: a shape that drifts
 * is a server change, and a server change is a decision, not an accident.
 *
 * `state` and `status` stay `string`. The engine owns that vocabulary, and
 * narrowing it here would turn an engine that learned a new word into a type
 * error in the client instead of a chip that paints grey. `asPhaseState()`
 * does the narrowing at the point of paint. */

export interface HealthIssue {
  slug: string;
  severity: (typeof HEALTH_SEVERITIES)[number];
  kind: string;
  message: string;
  phase?: number;
}

export interface PhaseLock {
  phase?: number;
  owner: string;
  expired: boolean;
  leaseUntil?: number;
  host?: string;
  /** When the claim was taken — the other half of "how long has this been held?". */
  claimedAt?: number;
  /**
   * What the claim covers. Absent means the claim was taken without one, which
   * the engine treats as colliding with everything — so an absent scope is not
   * "no scope", it is the widest possible one.
   */
  scope?: string[];
  /** The claiming session's own id — joins a claim to the registry and ptys. */
  session?: string;
}

export interface PlanSummaryFull {
  slug: string;
  title: string;
  kind: string;
  status?: string;
  /**
   * The plan's status is terminal, so it reports no work and no warnings.
   * Optional because an older server does not send it — read it through
   * `lib/closure.ts`'s `isClosed()`, never directly, so the status fallback
   * applies. ⚠️ `ready`, `locks`, `qaFailures` and `stuck` stay populated on a
   * closed plan by design; gating them is the client's job.
   */
  closed?: boolean;
  /** The date `close-plan.sh` recorded, when it was closed through the verb. */
  closedOn?: string;
  closedReason?: string;
  created?: string;
  activity: number;
  phases: number;
  declaredPhases?: number;
  done: number;
  ready: number[];
  waiting: number;
  inProgress: number[];
  stuck: number[];
  percent: number;
  remainingWeight: number;
  remainingSessions: number;
  criticalPath: number[];
  criticalWeight: number;
  minimumSessions: number;
  bottleneck?: { phase: number; blocks: number };
  nextBest?: { phase: number; unblocks: number };
  budget: number;
  targetModel?: string;
  branch?: string;
  skills: string[];
  /** `**MCP servers (every session):**` — attached to every phase of this plan. */
  mcpServers: string[];
  qaMode: string;
  /** The engine's reason beside the word (`plan directive: QA gate: on`). */
  qaModeReason?: string;
  qaFailures: number[];
  locks: PhaseLock[];
  repos: string[];
  handoffCount: number;
  lastCompleted?: string;
  spanDays?: number;
  medianGapDays?: number;
  issues: HealthIssue[];
  engineError?: string;
  issueCounts: { error: number; warning: number; info: number };
  hasHandoffs: boolean;
  /** How long this plan has left. Absent only when nothing is left. */
  eta?: EtaEstimate;
}

export interface PhaseRow {
  phase: number;
  title: string;
  dependsOn: number[];
  parallelSafe: string;
  repos: string;
  exitCriteria: string;
}

export interface PhaseAnalysis {
  phase: number;
  state: string;
  size: string;
  weight: number;
  dependsOn: number[];
  dependents: number[];
  transitiveDependents: number[];
  unblocks: number;
  onCriticalPath: boolean;
}

export interface PhaseHandoffRef {
  file: string;
  status: string;
  completed?: string;
  title: string;
  /**
   * `?include=handoffs` — 42.1 KB of the 46.5 KB this reference costs across a
   * 23-phase plan, and the only part of it that is projected. Absent means
   * EITHER the handoff has no Outstanding section OR the caller did not ask;
   * never render a sentence that distinguishes them (`ways-forward.tsx` did).
   */
  outstanding?: string;
  skillsUsed: string[];
  prompts: number;
}

export interface PhaseView {
  phase: number;
  title: string;
  state: string;
  size: string;
  weight: number;
  gated: boolean;
  gates?: string;
  gateCheck?: string;
  /** The gate's category — who can clear it. Mirrors `--gate-kind`. Optional
   * so a freshly built client keeps working against a not-yet-restarted older
   * server; absent reads as `none`. */
  gateKind?: (typeof GATE_KINDS)[number];
  model?: string;
  effort?: string;
  goal?: string;
  readFirst?: string;
  files?: string;
  steps?: string;
  exitCriteria?: string;
  verification?: string;
  /** `**MCP:**` — registry ids this phase needs, on top of the plan-wide line. */
  mcpServers?: string[];
  handoffMustRecord?: string;
  /** `?include=prose` — absent on the board projection (`shared/projection.js`). */
  bullets?: { label: string; body: string }[];
  row?: PhaseRow;
  analysis?: PhaseAnalysis;
  qa?: { result: string; report?: string };
  /**
   * THIS phase's QA regime and which line answered — `phase` when the phase's
   * own `- **QA:** …` bullet decided, `plan` otherwise. Absent on an older
   * server; readers fall back to `summary.qaMode`, the plan's word.
   */
  qaMode?: { mode: string; source: 'phase' | 'plan' };
  /** The rounds the ledger records for this phase — how many, and the latest. */
  qaRounds?: { count: number; latest: { round: number; result: string; report?: string } };
  lock?: PhaseLock;
  handoff?: PhaseHandoffRef;
  /**
   * Claimed versus evidenced (`shared/evidence-model.js`). The board says a
   * phase is done; this says whether the handoff, the §Verification result and
   * the QA table agree. Absent on a server from before Phase 4.
   */
  proof?: EvidenceProof;
  /**
   * What is working this phase right now, if anything (`PhaseLive`).
   *
   * The other half of `proof`, and the one the board could never say: `state`
   * is a word out of a markdown file, this is a process. Absent means nothing
   * live was found — which is also how an older server reads, deliberately, so
   * a surface that decides whether to pulse or to link degrades to "no".
   */
  live?: PhaseLive;
  /**
   * This console's own verdict on the phase's diff (`server/review.ts`).
   *
   * Absent means nobody has reviewed it HERE — never "approved by default",
   * and never a claim about another machine's console. Optional so a freshly
   * built client keeps working against a not-yet-restarted older server.
   */
  review?: {
    verdict: string;
    at: string;
    by?: string;
    note?: string;
    base?: string;
    tip?: string;
  };
  /**
   * The direct dependencies of this phase on which changes were requested.
   *
   * Non-empty means this console refuses to board the phase, the way it
   * refuses one whose gate is not clear. It names the PHASES rather than
   * claiming a board state, because a surface has to be able to say whose hold
   * it is: the engine knows nothing about this.
   */
  reviewHold?: number[];
}

export interface RouteNode {
  phase: number;
  layer: number;
  row: number;
  state: string;
  size: string;
  gated: boolean;
  title: string;
  /** Claimed, and whether the claim still holds. Absent on an older server. */
  locked?: 'live' | 'stale';
}

export interface RouteView {
  nodes: RouteNode[];
  edges: { from: number; to: number }[];
  layers: number;
  rows: number;
}

export interface BatchGroup {
  index: number;
  kind: string;
  /** Already formatted by the engine — `180K`, not a token count. */
  weight: string;
  phases: number[];
  gated: boolean;
  note?: string;
}

export interface SessionPlanView {
  excluded?: number[];
  groups: BatchGroup[];
  raw: string;
  budget?: string;
}

export interface LintResult {
  ok: boolean;
  issues: string[];
  summary: string;
  timedOut?: boolean;
}

export interface SessionBudgetView {
  raw: string;
  targetModel?: string;
  budget?: string;
  branch?: string;
  skills: string[];
  /** `**MCP servers (every session):**` — attached to every phase of this plan. */
  mcpServers: string[];
  qaGate?: 'on' | 'off';
}

export interface PlanFile {
  slug: string;
  title: string;
  provenance?: string;
  context?: string;
  architecture?: string;
  endToEnd?: string;
  sessionBudget: SessionBudgetView;
  /** `?include=document` — Source-tab only. */
  graph?: PhaseRow[];
  /** `?include=document` — Source-tab only. */
  callouts?: string[];
  /** `?include=document` — the whole plan re-shipped; no client surface reads it. */
  sections?: { title: string; body: string }[];
  path?: string;
}

export interface HandoffRow {
  phase: number;
  file: string;
  title: string;
  status: string;
  completed?: string;
  bytes: number;
  mtime: number;
  prompts: number;
  skillsUsed: string[];
}

/**
 * What boarding will find wrong with this plan's §Verification, BEFORE a run
 * exists and before any money is spent.
 *
 * The warnings are the RUN's own `PreflightWarning` — deliberately the same
 * type, because they are computed by the same extractor and the same lead
 * resolver, and a second shape here would let the plan page and the run page
 * describe one finding two ways. The server has written these to the journal as
 * prose since Phase 4, where they predicted the dominant halt class forty-four
 * times and were rendered by nothing.
 *
 * None of the four kinds is fatal on its own, which is why the plan page badges
 * rather than blocks: `missing-lead` is a command the supervisor will SKIP and
 * record, `human-check` is a §Verification only a person can answer,
 * `cwd-unpinned` runs at the repository root and usually means it, and only
 * `nothing-runnable` is certain to park the phase.
 *
 * Only OPEN phases appear — a done phase's verification already ran.
 */
/**
 * What "Give this run its own checkout" would DO for this plan — granted (and
 * for a superproject, which repositories the mirror would mount), or refused
 * by name. The launch dialog renders this instead of a checkbox that is
 * guaranteed to be refused.
 */
export interface IsolationPreflight {
  available: boolean;
  /** `checkout` = one worktree of the root; `mirror` = per-repo worktrees. */
  kind?: 'checkout' | 'mirror';
  refusal?: string;
  detail?: string;
  mounts?: string[];
  skipped?: string[];
  /** The run root is a superproject (`.gitmodules` at its top level). */
  multiRepo: boolean;
}

export interface VerifyPreflight {
  phases: { phase: number; warnings: PreflightWarning[] }[];
  computedAt: string;
}

/**
 * One phase's money — `server/analysis/spend.ts` `PhaseCost`.
 *
 * `partial` is the one that changes how a figure must be RENDERED: the session
 * really ran and its spend was never harvested, so the number is a floor and
 * `$0.00` would read as "this was free", which it certainly was not.
 */
export interface PhaseCost {
  phase: number;
  usd: number;
  attempts: number;
  partial: boolean;
  durationMs: number;
  model?: string;
  status?: string;
  endedAt?: string;
  runs: number;
}

/**
 * What a plan cost — `server/analysis/spend.ts` `PlanCostView`.
 *
 * `ladderUsd` is a SUBSET of `totalUsd`, never a column to add to it, and
 * `residualUsd` is a reconciliation fault rather than a category: in a healthy
 * run the per-phase figures sum to the run totals exactly.
 */
export interface PlanCost {
  slug: string;
  totalUsd: number;
  attributedUsd: number;
  residualUsd: number;
  ladderUsd: number;
  partialPhases: number[];
  phases: PhaseCost[];
  byModel: { model: string; usd: number; phases: number }[];
  byDay: { day: string; usd: number }[];
  byDayTruncated: boolean;
  runs: { runId: string; spentUsd: number; budgetUsd: number | null; status?: string }[];
}

/** The share of elapsed wall-clock a plan has spent with a phase actually running. */
export interface DutyCycle {
  ratio: number;
  samples: number;
  assumed: boolean;
  workingMs: number;
  elapsedMs: number;
}

/**
 * When a plan finishes — `server/analysis/stats.ts` `Forecast`.
 *
 * The instants are ISO and the client renders them in ITS zone; `label` is
 * duration-shaped and therefore zone-free. `assumptions` is not decoration:
 * a date gets quoted long after the caveats around it are forgotten, so every
 * surface that prints one of these instants prints the list beside it.
 */
export interface Forecast {
  earliest: string;
  expected: string;
  latest: string;
  basis: EtaEstimate['basis'];
  samples: number;
  remainingPhases: number;
  remainingWeight: number;
  workingLowMs: number;
  workingHighMs: number;
  duty: DutyCycle;
  assumptions: string[];
  label: string;
}

/** `POST /api/plans/:slug/qa-mode {mode, phase?}` — the regime the engine reads back. */
export interface QaModeSetOutcome {
  ok: boolean;
  detail: string;
  plan?: { mode: string; reason?: string };
  phase?: { phase: number; regime: { mode: string; reason?: string } };
}

/** `GET /api/plans/:slug/qa-report/:phase?round=N`. */
export interface QaReportView {
  path: string;
  round: number;
  text: string;
}

export interface PlanDetail {
  summary: PlanSummaryFull;
  plan: PlanFile | null;
  phases: PhaseView[];
  route: RouteView;
  batches: SessionPlanView | null;
  boardText: string;
  lint: LintResult | null;
  handoffs: HandoffRow[];
  index: { phase: number; title: string; status: string; link?: string }[];
  /**
   * The plan's own estimate and one per phase, from a single rate reading.
   *
   * Optional because the server is whatever Node loaded at startup while the
   * client is read from disk per request — upgrading the skill under a running
   * console leaves a new UI talking to an old API (see `state.serverStale`), and
   * a required field would make that show up as a crash rather than a missing
   * line. Every read site already spells it `detail.eta?.…`.
   */
  eta?: { plan: EtaEstimate | null; perPhase: PhaseEta[] };
  /**
   * What this plan cost, phase by phase. Optional for the same
   * new-UI-old-server reason as `eta` — read it as `detail.cost?.…`.
   */
  cost?: PlanCost;
  /** When it finishes, and every assumption that date rests on. Same optionality. */
  forecast?: Forecast | null;
  qa: { phase: number; result: string; report?: string }[];
  /**
   * Which phases each recorded verdict is holding, keyed by the phase whose
   * verdict it is — the board's word. Absent on an older server.
   */
  qaHeld?: Record<number, number[]>;
  locks: PhaseLock[];
  git: {
    sha?: string;
    subject?: string;
    author?: string;
    date?: string;
    relativeDate?: string;
    dirty?: boolean;
  };
  /**
   * `?include=memory` — the Source tab asks for it. ABSENT when nobody asked;
   * `null` when someone did and the plan has no memory file. Two facts, and the
   * Source tab shows a different thing for each.
   */
  memory?: { key: string; path: string; text: string; indexLines: string[] } | null;
}

export interface HandoffDetail {
  slug: string;
  phase: number;
  file: string;
  path: string;
  title: string;
  status: string;
  rawStatus?: string;
  completed?: string;
  nextPhase?: string;
  dependsOn: number[];
  blocks: number[];
  parallelSafe: number[];
  skillsUsed: string[];
  keyFiles: string[];
  memoryKey?: string;
  outstanding?: string;
  prompts: number;
  finalPhase?: boolean;
  body: string;
  bytes: number;
  mtime: number;
}

/** `phase-graph.sh --gate-status` for one phase. */
export interface GateStatus {
  kind: string;
  clear: boolean;
  detail: string;
}

/* ---------------- review (server/review.ts) ----------------
 * The diff a phase landed, and this console's verdict on it. Mirrors the
 * server module by hand, for the same reason the plan shapes above are
 * hand-written: a shape that drifts is a server change, and a server change is
 * a decision rather than an accident. */

export type ReviewVerdict = 'approved' | 'requested-changes' | 'commented';

export interface DiffLine {
  kind: 'context' | 'add' | 'del' | 'meta';
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
  /** The file's hunks were cut at the per-file cap — the COUNTS are still real. */
  truncated?: boolean;
}

export interface ReviewWindow {
  kind: 'handoff-window' | 'working-tree' | 'explicit' | 'none';
  base?: string;
  tip?: string;
  /** How the bracket was chosen, and what it cannot know. Shown verbatim. */
  note: string;
}

export interface PhaseDiff {
  slug: string;
  phase: number;
  window: ReviewWindow;
  commits: { sha: string; subject?: string; date?: string; author?: string }[];
  files: DiffFile[];
  additions: number;
  deletions: number;
  truncated: boolean;
  /** git could not answer — `files` is empty and means NOTHING. */
  failed: boolean;
}

/** One inline comment, anchored to a file and (usually) a line. Schema v2. */
export interface ReviewComment {
  id: string;
  path: string;
  line?: number;
  side?: 'old' | 'new';
  hunk?: string;
  code?: string;
  body: string;
  by?: string;
  at: string;
  /** Answered. Kept, not deleted — and skipped when a follow-up is composed. */
  resolved?: boolean;
}

export interface ReviewRecord {
  version: number;
  slug: string;
  phase: number;
  verdict: ReviewVerdict;
  note?: string;
  by?: string;
  at: string;
  base?: string;
  tip?: string;
  comments?: ReviewComment[];
}

export interface PhaseReview {
  diff: PhaseDiff;
  review: ReviewRecord | null;
  /** The phase has landed a commit since the verdict was given. */
  staleTip: boolean;
}

/* ---------------- landing (server/landing.ts) ----------------
 * How a finished plan leaves the machine: a branch, a commit range, and a
 * packet of files. Mirrored by hand like the review shapes above. */

export interface BranchState {
  available: boolean;
  branch?: string;
  head?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  dirty: string[];
  dirtyTruncated: boolean;
}

export interface LandingWindow {
  kind: 'plan-window' | 'explicit' | 'none';
  base?: string;
  tip?: string;
  note: string;
}

export interface LandingArtifact {
  /** Relative to the packet directory — and the download key the route accepts. */
  name: string;
  kind: 'manifest' | 'bundle' | 'patch';
  bytes: number;
}

export interface LandingPacket {
  version: number;
  slug: string;
  at: string;
  repo: BranchState;
  window: LandingWindow;
  commits: { sha: string; subject?: string; date?: string; author?: string }[];
  commitCount: number;
  commitsTruncated: boolean;
  bundle?: { name: string; bytes: number; ref: string; prerequisites: string[] };
  patches: { dir: string; files: string[] };
  files: LandingArtifact[];
  apply: string[];
  notes: string[];
}

export interface LandingView {
  slug: string;
  repo: BranchState;
  window: LandingWindow;
  commitCount: number;
  /** Every phase done — decides how loudly the card presents itself, never whether it works. */
  finished: boolean;
  packet: LandingPacket | null;
  writable: boolean;
}

/* ---------------- the guarded write verbs ----------------
 * Every one of them shells out to a phased-execution script, and every one is
 * refused unless the server was started with `--allow-writes`. `dry` returns
 * the exact invocation without running it — the preview the dialog shows. */

export interface WriteRequest {
  action: string;
  slug?: string;
  phase?: number;
  [field: string]: unknown;
}

/** What became of one release attempt. A bulk release returns one per lock. */
export interface LockRelease {
  slug: string;
  phase: number;
  ok: boolean;
  /** Read from the lock file; null when there was no lock to read. */
  owner: string | null;
  detail?: string;
}

export interface WriteResult {
  /** Absent on a dry run — a preview neither succeeded nor failed. */
  ok?: boolean;
  dryRun?: boolean;
  /** The literal command line. Present on a dry run and a real one. */
  command?: string;
  description?: string;
  code?: number;
  stdout?: string;
  stderr?: string;
}

/** The plan surface's fetchers — merged into `api` by `./index`. */
export const plansApi = {
  plans: () => request<PlanSummary[]>('/api/plans'),

  /* ---- plans ----
     The prompt endpoints answer `text/plain`; `request` already returns a
     string for a non-JSON content type, so they are typed as one. */
  /**
   * One plan, projected. `include` names groups from `shared/projection.js`;
   * omitted, the server answers the board projection — 47.8 KB on the measured
   * 23-phase plan, against 286.5 KB for `include=full`.
   */
  plan: (slug: string, opts?: { model?: string; include?: Iterable<string> }) => {
    const params = new URLSearchParams();
    if (opts?.model) params.set('model', opts.model);
    const include = opts?.include ? includeParam(opts.include, PLAN_INCLUDES) : '';
    if (include) params.set('include', include);
    const query = params.toString();
    return request<PlanDetail>(`/api/plans/${q(slug)}${query ? `?${query}` : ''}`);
  },
  planRaw: (slug: string) => request<string>(`/api/plans/${q(slug)}/raw`),
  handoff: (slug: string, phase: number | string) =>
    request<HandoffDetail>(`/api/plans/${q(slug)}/handoff/${phase}`),
  prompt: (slug: string, phase: number | string) => request<string>(`/api/plans/${q(slug)}/prompt/${phase}`),
  nextPrompt: (slug: string, phase?: number | string) =>
    request<string>(`/api/plans/${q(slug)}/next-prompt/${phase ?? 'none'}`),
  qaPrompt: (slug: string, phase: number | string) =>
    request<string>(`/api/plans/${q(slug)}/qa-prompt/${phase}`),
  boardText: (slug: string) => request<string>(`/api/plans/${q(slug)}/board`),

  /* ---- landing ----
     GET is unflagged like the review's: which branch the work is on and
     whether it is anywhere else is display. POST composes the packet and is
     `--allow-writes`. Neither can push — see `server/landing.ts`. */
  landing: (slug: string) => request<LandingView>(`/api/plans/${q(slug)}/landing`),
  composeLanding: (slug: string, range?: { base?: string; tip?: string }) =>
    post<{ ok: boolean; packet: LandingPacket | null; detail: string }>(
      `/api/plans/${q(slug)}/landing`,
      range ?? {},
    ),
  /* A plain href, not a fetch: the browser's own download machinery names the
     file from `content-disposition` and streams it to disk, which is the whole
     point of the packet. Each segment is encoded separately so a patch's
     `patches/0001-….patch` keeps its slash. */
  landingFileHref: (slug: string, name: string) =>
    `/api/plans/${q(slug)}/landing/${name.split('/').map(q).join('/')}`,
  memoryBlock: (slug: string) => request<string>(`/api/plans/${q(slug)}/memory-block`),
  gate: (slug: string, phase: number | string) => request<GateStatus>(`/api/plans/${q(slug)}/gate/${phase}`),
  approveGate: (
    slug: string,
    phase: number,
    body: { approve: boolean; by?: string; note?: string; continueRun?: boolean },
  ) =>
    post<{ ok: boolean; gate: GateStatus | null; detail: string; resumed?: boolean }>(
      `/api/plans/${q(slug)}/gate/${phase}`,
      body,
    ),
  /* Read-only, and deliberately unflagged: looking at what a session changed
     is display, the same class as reading its handoff. */
  review: (slug: string, phase: number | string, range?: { base?: string; tip?: string }) => {
    const params = new URLSearchParams();
    if (range?.base) params.set('base', range.base);
    if (range?.tip) params.set('tip', range.tip);
    const query = params.toString();
    return request<PhaseReview>(`/api/plans/${q(slug)}/review/${phase}${query ? `?${query}` : ''}`);
  },
  /* `--allow-writes`, because `requested-changes` holds every dependent phase
     from boarding — a read-only console must not be able to stop a run. */
  setReview: (
    slug: string,
    phase: number,
    body: { verdict: ReviewVerdict | 'withdraw'; note?: string; by?: string; base?: string; tip?: string },
  ) =>
    post<{ ok: boolean; review: ReviewRecord | null; detail: string }>(
      `/api/plans/${q(slug)}/review/${phase}`,
      body,
    ),
  /* `--allow-writes` like the verdict: a comment cannot hold anything by
     itself, but Send back turns a comment set into a re-boarded phase. */
  commentOnReview: (
    slug: string,
    phase: number,
    body:
      | {
          action: 'add';
          path: string;
          line?: number;
          side?: 'old' | 'new';
          hunk?: string;
          code?: string;
          body: string;
          by?: string;
        }
      | { action: 'resolve' | 'unresolve' | 'delete'; id: string },
  ) =>
    post<{ ok: boolean; review: ReviewRecord | null; detail: string }>(
      `/api/plans/${q(slug)}/review-comment/${phase}`,
      body,
    ),
  /* `--allow-run`, not `--allow-writes`: this re-boards the phase, which
     spawns a session that edits the repository. The follow-up prompt is
     composed on the SERVER from the stored comments — this body names the
     phase and nothing else, so it cannot put words in front of a session. */
  sendBackReview: (slug: string, phase: number, body: { by?: string } = {}) =>
    post<{ ok: boolean; detail: string; followUp?: string; boarded?: boolean }>(
      `/api/plans/${q(slug)}/review-send-back/${phase}`,
      body,
    ),
  sessionPlan: (slug: string, model?: string) =>
    request<unknown>(`/api/plans/${q(slug)}/session-plan${model ? `?model=${q(model)}` : ''}`),
  /* Read-only and advisory: what boarding would find, per open phase. It costs
     the plan's own extractor plus a PATH lookup per lead — cheap, but not free,
     so it is its own request rather than a field on `detail()`. */
  verifyPreflight: (slug: string) => request<VerifyPreflight>(`/api/plans/${q(slug)}/verify-preflight`),
  isolationPreflight: (slug: string) =>
    request<IsolationPreflight>(`/api/plans/${q(slug)}/isolation-preflight`),
  write: (body: WriteRequest, dry?: boolean) => post<WriteResult>(`/api/write${dry ? '?dry=1' : ''}`, body),

  /* ---- stale claims ----
     The owner comes off the lock file on the server, so nothing here asks a
     person to retype `someone@example.com/opus-p2` from a card that never
     showed it. A live lease answers 409 and stays claimed. */
  /* `force` takes a claim whose lease is still running. That is the operator
     deciding another session is gone, and it is the only way past a live claim
     now that one blocks a run — so it is a separate argument, never a default,
     and every caller that passes it asks for confirmation first. */
  releaseLock: (slug: string, phase: number, force = false) =>
    post<LockRelease>('/api/locks/release', force ? { slug, phase, force } : { slug, phase }),
  releaseExpiredLocks: () =>
    post<{ results: LockRelease[]; released: number }>('/api/locks/release', { expired: true }),

  /**
   * Turn QA on for a plan that has it off.
   *
   * Write-class rather than agent-class: it creates `test-status.md` and
   * backfills the already-complete phases as waived, which is a change to the
   * repository whether or not a review is ever minted.
   */
  qaActivate: (slug: string, phase: number) =>
    post<{ ok: boolean; mode: string; detail: string }>(`/api/plans/${q(slug)}/qa-mode`, { phase }),
  /**
   * Set the QA regime — for the plan (no phase) or for one phase — through
   * `scripts/qa-mode.sh`. Write-class like `qaActivate`. The answer is what
   * the ENGINE reads back, not the directive echoed: with a ledger on disk a
   * written `off` reads as `waived`.
   */
  qaModeSet: (slug: string, request: { mode: 'on' | 'off' | 'inherit'; phase?: number }) =>
    post<QaModeSetOutcome>(`/api/plans/${q(slug)}/qa-mode`, request),
  /** The text of one QA report — the latest round when `round` is absent. */
  qaReport: (slug: string, phase: number, round?: number) =>
    request<QaReportView>(`/api/plans/${q(slug)}/qa-report/${phase}${round ? `?round=${round}` : ''}`),
  /**
   * Waive a recorded verdict with a reason — the third QA-recovery verb, and
   * the only one that starts nothing.
   *
   * Write-class for `qaActivate`'s reason and beside it for the same reason:
   * what it does is write one row of `test-status.md`, and a console that may
   * write but may not run must still be able to release a gate.
   */
  qaWaive: (slug: string, phase: number, reason: string) =>
    post<{ ok: boolean; verdict: string; round?: number; report?: string; detail: string }>(
      `/api/plans/${q(slug)}/qa-waive`,
      { phase, reason },
    ),
};
