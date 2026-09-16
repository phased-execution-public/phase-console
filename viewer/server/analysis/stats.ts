/**
 * Statistics and health analysis across one source directory.
 *
 * Every number here is derived from files on disk plus the engine's own
 * classification — nothing is entered by hand, and nothing overrides what
 * `phase-graph.sh` says about state.
 */

import type { PlanRecord } from '../store.ts';
import type { Board, QaMode } from '../engine.ts';
import { mcpServersFor, type PhaseSize } from '../parse/plan.ts';
import {
  indexGraph, layerGraph, unblockValue, weightOf, resolveBudget, criticalPath, remainingWork,
  type Sizing, type McpSizing,
} from './graph.ts';
import { parseScope } from '../../shared/scope.js';
import { CLOSED_PLAN_STATUSES, PLAN_STATUSES } from '../../shared/plan-vocab.js';
import { ETA_BASES, HEALTH_SEVERITIES } from '../../shared/ops-vocab.js';
import { extractCommands } from '../runner/verify.ts';

/**
 * The slice of a run record the health analysis reads. Structural rather than
 * the runner's own `RunState` so this module stays a reader of files on disk,
 * never of the loop; the service fills it from `listRuns`.
 */
export type RunView = {
  id: string;
  status: string;
  phases: Record<string, { phase: number; status: string }>;
};

export type PlanContext = {
  record: PlanRecord;
  board: Board;
  qaMode: QaMode;
  /** The plan's runs, newest first — optional, for the record-vs-board checks. */
  runs?: readonly RunView[];
};

export type ReadyItem = {
  slug: string;
  planTitle: string;
  phase: number;
  title: string;
  size: PhaseSize;
  weight: number;
  gated: boolean;
  unblocks: number;
  lockedBy?: string;
  lockExpired?: boolean;
  repos: string;
  activity: number;
};

export type HealthIssue = {
  slug: string;
  severity: (typeof HEALTH_SEVERITIES)[number];
  kind: string;
  message: string;
  phase?: number;
};

export type PlanStats = {
  slug: string;
  title: string;
  kind: PlanRecord['kind'];
  status?: string;
  /**
   * The operator closed this plan — its status is terminal, so it reports no
   * work, no warnings and no prompts. The board still renders in full.
   */
  closed: boolean;
  /** Date `close-plan.sh` recorded, when it was closed through the verb. */
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
  qaMode: QaMode['mode'];
  /**
   * The engine's reason beside the word — `plan directive: QA gate: on`,
   * `test-status.md exists` — so a status block can say WHY rather than
   * flatten it away. Absent when the engine gave none (`off`).
   */
  qaModeReason?: string;
  qaFailures: number[];
  locks: { phase: number; owner: string; expired: boolean; leaseUntil?: number }[];
  repos: string[];
  handoffCount: number;
  lastCompleted?: string;
  /** Days between the first and last recorded phase completion. */
  spanDays?: number;
  medianGapDays?: number;
  issues: HealthIssue[];
};

export type Portfolio = {
  generatedAt: number;
  totals: {
    plans: number;
    documents: number;
    orphans: number;
    /** Plans an operator has closed — excluded from `ready` and the remaining totals. */
    closed: number;
    phases: number;
    done: number;
    ready: number;
    waiting: number;
    inProgress: number;
    stuck: number;
    percent: number;
    remainingWeight: number;
    remainingSessions: number;
  };
  /** `closed` so a consumer can group the terminal statuses without re-deriving the predicate. */
  byStatus: { status: string; count: number; closed: boolean }[];
  readyQueue: ReadyItem[];
  /**
   * Every lock, closed plans included — this is the inventory, and a lock file
   * on disk is a fact whatever the plan's status says.
   *
   * `closed` rides along because a lock left on a closed plan is **debris, not a
   * blocker**: `phase-lock.sh conflicts` skips it outright (the scan crosses
   * every plan, so that debris would otherwise block unrelated work), and a
   * surface that shows it as an expired lease needing release would be inventing
   * a chore. Carried rather than re-derived, for the same reason `byStatus`
   * carries it.
   */
  activeLocks: {
    slug: string; phase: number; owner: string; expired: boolean; leaseUntil?: number; closed: boolean;
    /** The claiming session's own id, when the lock file names one. */
    session?: string;
  }[];
  qaModes: { mode: string; count: number }[];
  qaFailures: { slug: string; phase: number }[];
  issues: HealthIssue[];
  velocity: { week: string; count: number }[];
  calendar: { date: string; count: number }[];
  medianCycleDays?: number;
  sizeMix: { size: PhaseSize; count: number }[];
  repos: { repo: string; count: number }[];
  skills: { skill: string; count: number }[];
  models: { model: string; count: number }[];
  phaseCounts: { phases: number; plans: number }[];
  stalled: { slug: string; days: number; ready: number[] }[];
  busiest: { slug: string; completions: number }[];
  /**
   * How fast phases have actually been going lately, pooled across every plan.
   *
   * The statistics page counted phases and never once said how long one takes,
   * which is the number every other figure on it is implicitly about. Absent
   * only when the caller did not compute it — `basis: 'heuristic'` is how "we
   * have never finished anything" is reported.
   */
  rate?: RateReading;
};

const DAY = 86_400_000;

/**
 * `mcp` is optional so a caller with no scripts directory keeps the old,
 * size-only answer rather than silently getting a wrong one; the console always
 * has one and always passes it, so its numbers now match `_phase_weight`.
 */
export function planStats(ctx: PlanContext, sizing: Sizing, mcp?: McpSizing): PlanStats {
  const { record, board, qaMode } = ctx;
  const plan = record.plan;
  const rows = plan?.graph ?? [];
  const sizes = new Map<number, PhaseSize>(rows.map((r) => [r.phase, plan?.phases[r.phase]?.size ?? 'M']));
  const budget = resolveBudget(plan?.sessionBudget.targetModel, sizing);
  const index = indexGraph(rows);

  const critical = criticalPath(index, board, sizes, sizing, budget);
  const remaining = remainingWork(rows, board, sizes, sizing, budget);

  const bottleneck = rows
    .filter((r) => board.states[r.phase] !== 'done')
    .map((r) => ({ phase: r.phase, blocks: unblockValue(index, r.phase, board) }))
    .sort((a, b) => b.blocks - a.blocks || a.phase - b.phase)[0];

  const nextBest = board.ready
    .map((phase) => ({ phase, unblocks: unblockValue(index, phase, board), critical: critical.phases.includes(phase) }))
    .sort((a, b) => Number(b.critical) - Number(a.critical) || b.unblocks - a.unblocks || a.phase - b.phase)[0];

  const completions = record.handoffs
    .filter((h) => h.status === 'complete' && h.completed)
    .map((h) => Date.parse(h.completed!))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  const gaps: number[] = [];
  for (let i = 1; i < completions.length; i++) gaps.push((completions[i] - completions[i - 1]) / DAY);

  const repos = [...new Set(rows.flatMap((r) => splitRepos(r.repos)))].sort();

  return {
    slug: record.slug,
    title: plan?.title ?? record.slug,
    kind: record.kind,
    status: normalisePlanStatus(plan?.status),
    closed: isClosedStatus(plan?.status),
    closedOn: plan?.closed,
    closedReason: plan?.closedReason,
    created: plan?.created,
    activity: record.activity,
    phases: rows.length,
    declaredPhases: plan?.declaredPhases,
    done: board.done.length,
    ready: board.ready,
    waiting: board.waiting.length,
    inProgress: board.inProgress,
    stuck: board.stuck,
    percent: rows.length ? Math.round((board.done.length / rows.length) * 100) : 0,
    remainingWeight: remaining.weight,
    remainingSessions: remaining.sessions,
    criticalPath: critical.phases,
    criticalWeight: critical.weight,
    minimumSessions: critical.sessions,
    bottleneck: bottleneck && bottleneck.blocks > 0 ? bottleneck : undefined,
    nextBest: nextBest ? { phase: nextBest.phase, unblocks: nextBest.unblocks } : undefined,
    budget,
    targetModel: plan?.sessionBudget.targetModel,
    branch: plan?.sessionBudget.branch,
    skills: plan?.sessionBudget.skills ?? [],
    mcpServers: plan?.sessionBudget.mcpServers ?? [],
    qaMode: qaMode.mode,
    ...(qaMode.reason ? { qaModeReason: qaMode.reason } : {}),
    qaFailures: record.qa.filter((q) => q.result === 'fail').map((q) => q.phase),
    locks: record.locks.map((l) => ({ phase: l.phase, owner: l.owner, expired: l.expired, leaseUntil: l.leaseUntil })),
    repos,
    handoffCount: record.handoffs.length,
    lastCompleted: completions.length ? new Date(completions.at(-1)!).toISOString().slice(0, 10) : undefined,
    spanDays: completions.length > 1 ? Math.round((completions.at(-1)! - completions[0]) / DAY) : undefined,
    medianGapDays: gaps.length ? round1(median(gaps)) : undefined,
    issues: healthIssues(ctx),
  };
}

/** Strip the template legend that trails many status values. */
export function normalisePlanStatus(raw?: string): string | undefined {
  if (!raw) return undefined;
  const first = raw.split(/[—-]{1,2}\s/)[0].trim().toLowerCase();
  return PLAN_STATUSES.find((k) => first.startsWith(k)) ?? first.split(/\s+/)[0] ?? undefined;
}

/**
 * The three statuses that mean nobody is coming back to this plan.
 * Re-exported from `shared/plan-vocab.js`, which owns the words, so the
 * server, the client and the close menu cannot drift apart.
 */
export const CLOSED_STATUSES: readonly string[] = CLOSED_PLAN_STATUSES;

/**
 * Is this plan closed? — the single JS reading of closure, and the deliberate
 * twin of `plan_is_closed()` in `scripts/phase-graph.sh`. Both decide it from
 * the status alone, so the plans an operator hand-marked long before the verb
 * existed close correctly: `closed:` / `closed_reason:` are what the verb
 * *records*, never what closure *is*.
 */
export function isClosedStatus(raw?: string): boolean {
  const status = normalisePlanStatus(raw);
  return status !== undefined && CLOSED_STATUSES.includes(status);
}

/**
 * The issue kinds that report *progress* — every one of them silenced for a
 * closed plan. Nobody is going to unstick a handoff in a plan that was
 * abandoned, so saying so is noise that buries the issues that do matter.
 *
 * What is NOT in this set is the point: `engine`, `phase-count`,
 * `undefined-dep` and `orphan` are file corruption, and a closed plan keeps
 * reporting them — demoted to `info`, never dropped. A broken plan nobody can
 * see is worse than a noisy one.
 */
export const PROGRESS_ISSUE_KINDS = new Set([
  'stale-handoff', 'qa-fail', 'missing-handoff', 'depends-drift', 'index-drift', 'stale-lock', 'no-handoff-dir',
  'verification-unrunnable', 'record-ahead-of-board',
]);

/**
 * The Repos cell as *repository* names — the top segment of each scope token.
 *
 * The reading itself now lives in `shared/scope.js`, because the bash side has
 * to agree with it: `phase-lock.sh` decides whether a claim collides using the
 * same rules. What stays here is the narrower question this file and the
 * `Verify in:` suggestion ask — "which repositories?" — where a path like
 * `packages/cart-api` is the `packages` checkout and tallies as one.
 */
export function splitRepos(cell: string): string[] {
  return [...new Set(parseScope(cell).map((token) => token.split('/')[0]))];
}

export function healthIssues(ctx: PlanContext): HealthIssue[] {
  const { record, board } = ctx;
  const plan = record.plan;
  const issues: HealthIssue[] = [];
  const closed = isClosedStatus(plan?.status);
  // One gate, applied where the issues are made rather than where they are
  // drawn: every surface in the console reads this list, so filtering here is
  // the difference between closure meaning something everywhere and meaning
  // something on whichever page remembered to ask.
  const add = (severity: HealthIssue['severity'], kind: string, message: string, phase?: number) => {
    if (closed && PROGRESS_ISSUE_KINDS.has(kind)) return;
    issues.push({ slug: record.slug, severity: closed ? 'info' : severity, kind, message, phase });
  };

  if (record.kind === 'orphan-handoffs') {
    add('warning', 'orphan', 'Handoff folder with no plan file in docs/plans');
    return issues;
  }
  if (!plan?.phased) return issues;

  if (board.error) add('error', 'engine', `Engine could not read the graph: ${board.error}`);

  if (plan.declaredPhases && plan.declaredPhases !== plan.graph.length) {
    add('error', 'phase-count',
      `Front matter says ${plan.declaredPhases} phases but the graph table parses ${plan.graph.length} rows`);
  }

  const known = new Set(plan.graph.map((r) => r.phase));
  for (const row of plan.graph) {
    for (const dep of row.dependsOn) {
      if (!known.has(dep)) add('error', 'undefined-dep', `Phase ${row.phase} depends on ${dep}, which is not in the table`, row.phase);
    }
    // Since 5.0.0 the bash lint FAILS this (F24 `gate-directive-missing`) and
    // the board reads the gate as `ai` (gates.env GATE_DEFAULT) until the
    // author says which it is; this row is the console's own word for it.
    const detail = plan.phases[row.phase];
    if (detail?.gated && !detail.gateCheck) {
      add('error', 'gate-uncategorized',
        `Phase ${row.phase} is GATED with no Gate-check (it reads as ai until it has one; validate.sh fails it) — add \`ai <check>\` (a session clears it) `
        + 'or `manual <who>` (the Gate card clears it)', row.phase);
    }
    // A phase whose §Verification yields nothing runnable boards the autopilot
    // only to park ("nothing would prove the work"). Judged by the SAME
    // extractor boarding uses, skipped for done phases (their proof is their
    // handoff) — and it is the issue the plan-repair agent knows how to fix,
    // which is what lets `resolveRecovery` accept a repair for it at all.
    if (!board.done.includes(row.phase)
      && !extractCommands(detail?.verification).commands.length) {
      const declared = /\*\*\s*Verification\b/i.test(detail?.raw ?? '');
      add('warning', 'verification-unrunnable',
        declared
          ? `Phase ${row.phase}'s §Verification yields nothing the runner can execute — it will park at boarding`
          : `Phase ${row.phase} has no §Verification — it will park at boarding`,
        row.phase);
    }
  }

  for (const phase of board.done) {
    if (!record.handoffs.some((h) => h.phase === phase)) {
      add('warning', 'missing-handoff', `Phase ${phase} counts as done but has no handoff file`, phase);
    }
  }

  for (const handoff of record.handoffs) {
    const row = plan.graph.find((r) => r.phase === handoff.phase);
    if (row && handoff.dependsOn.length && !sameSet(handoff.dependsOn, row.dependsOn)) {
      add('warning', 'depends-drift',
        `Phase ${handoff.phase} handoff lists depends_on [${handoff.dependsOn}] but the graph says [${row.dependsOn}]`,
        handoff.phase);
    }
    if (handoff.status === 'in-progress' || handoff.status === 'blocked') {
      const age = Math.round((Date.now() - handoff.mtime) / DAY);
      // WARNING for both words since 2026-08-30 (R2). `error` was reserved for
      // `blocked`, and an error is what the situation classifier's health arm
      // reads as "the plan is broken" — so a session that did exactly what the
      // contract asks (hand off `blocked` rather than end silently) had its
      // testimony outranked by a health issue its own honesty raised. A stale
      // handoff is a thing to LOOK at, never a defect in the plan.
      add('warning', 'stale-handoff',
        `Phase ${handoff.phase} handoff is ${handoff.status}${age > 0 ? `, untouched ${age}d` : ''}`, handoff.phase);
    }
    if (record.index.length && !record.index.some((r) => r.phase === handoff.phase)) {
      add('info', 'index-drift', `Phase ${handoff.phase} is missing from INDEX.md`, handoff.phase);
    }
  }

  for (const row of record.qa) {
    if (row.result === 'fail') add('error', 'qa-fail', `Phase ${row.phase} QA recorded fail — dependents stay blocked`, row.phase);
  }

  for (const lock of record.locks) {
    if (lock.expired) add('info', 'stale-lock', `Phase ${lock.phase} lock by ${lock.owner} has expired`, lock.phase);
  }

  // A run record that reads `done` over a board that does not: the run's word
  // has run AHEAD of the plan's — a handoff reverted or re-opened by hand, a
  // phase file moved, a board the engine now reads differently. Never
  // rewritten (the record is the run's own history, and reconcile only ever
  // moves records FORWARD to done), so it is raised here instead — once per
  // phase, on the newest run that says so. Skipped when the engine could not
  // read the board at all: an empty board is not evidence of anything.
  if (ctx.runs?.length && !board.error) {
    const ahead = new Set<number>();
    for (const run of ctx.runs) {
      for (const rec of Object.values(run.phases)) {
        if (rec.status !== 'done' || ahead.has(rec.phase) || !known.has(rec.phase)) continue;
        if (board.done.includes(rec.phase)) continue;
        ahead.add(rec.phase);
        add('warning', 'record-ahead-of-board',
          `Phase ${rec.phase} reads done on run ${run.id} but the board reads `
          + `${board.states[rec.phase] ?? 'unknown'} — the handoff moved after the run closed it`,
          rec.phase);
      }
    }
  }

  if (plan.phased && !record.handoffDir && board.done.length > 0) {
    add('warning', 'no-handoff-dir', 'Plan reports progress but has no handoff folder');
  }

  return issues;
}

export function portfolio(
  contexts: PlanContext[], sizing: Sizing, rate?: RateReading, mcp?: McpSizing,
): Portfolio {
  const stats = contexts.map((ctx) => ({ ctx, stats: planStats(ctx, sizing) }));
  const plans = stats.filter((s) => s.stats.kind === 'plan');
  // The census counts every plan; the forward-looking numbers count only the
  // open ones. "23 phases ready" that includes an abandoned plan's phases is an
  // invitation to start work nobody wants.
  const open = plans.filter((s) => !s.stats.closed);

  const totals = {
    plans: plans.length,
    documents: stats.filter((s) => s.stats.kind === 'document').length,
    orphans: stats.filter((s) => s.stats.kind === 'orphan-handoffs').length,
    closed: plans.length - open.length,
    phases: sum(plans.map((s) => s.stats.phases)),
    done: sum(plans.map((s) => s.stats.done)),
    ready: sum(open.map((s) => s.stats.ready.length)),
    waiting: sum(plans.map((s) => s.stats.waiting)),
    inProgress: sum(plans.map((s) => s.stats.inProgress.length)),
    stuck: sum(plans.map((s) => s.stats.stuck.length)),
    percent: 0,
    remainingWeight: sum(open.map((s) => s.stats.remainingWeight)),
    remainingSessions: sum(open.map((s) => s.stats.remainingSessions)),
  };
  totals.percent = totals.phases ? Math.round((totals.done / totals.phases) * 100) : 0;

  // Gated in step with `totals.ready` — `service.test.ts` asserts the two agree,
  // and a queue that recommended a closed plan's phase would be the same bug.
  const readyQueue: ReadyItem[] = [];
  for (const { ctx, stats: s } of open) {
    const plan = ctx.record.plan!;
    const index = indexGraph(plan.graph);
    for (const phase of s.ready) {
      const row = plan.graph.find((r) => r.phase === phase);
      const detail = plan.phases[phase];
      const lock = ctx.record.locks.find((l) => l.phase === phase);
      readyQueue.push({
        slug: ctx.record.slug,
        planTitle: plan.title,
        phase,
        title: detail?.title || row?.title || `Phase ${phase}`,
        size: detail?.size ?? 'M',
        weight: weightOf(detail?.size, sizing, mcpServersFor(plan, phase).length, mcp),
        gated: detail?.gated ?? false,
        unblocks: unblockValue(index, phase, ctx.board),
        lockedBy: lock?.owner,
        lockExpired: lock?.expired,
        repos: row?.repos ?? '',
        activity: ctx.record.activity,
      });
    }
  }
  readyQueue.sort((a, b) => b.unblocks - a.unblocks || b.activity - a.activity);

  const completions: { date: string; slug: string }[] = [];
  for (const { ctx } of stats) {
    for (const handoff of ctx.record.handoffs) {
      if (handoff.status !== 'complete') continue;
      const date = handoff.completed ?? new Date(handoff.mtime).toISOString().slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) completions.push({ date, slug: ctx.record.slug });
    }
  }

  const gaps: number[] = [];
  for (const { ctx } of plans) {
    const times = ctx.record.handoffs
      .filter((h) => h.status === 'complete' && h.completed)
      .map((h) => Date.parse(h.completed!))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / DAY);
  }

  const now = Date.now();
  const stalled = open
    .filter((s) => s.stats.ready.length > 0)
    .map((s) => ({ slug: s.stats.slug, days: Math.round((now - s.stats.activity) / DAY), ready: s.stats.ready }))
    .filter((s) => s.days >= 7)
    .sort((a, b) => b.days - a.days);

  return {
    generatedAt: now,
    totals,
    byStatus: tally(stats.map((s) => s.stats.status ?? 'unset'))
      .map(([status, count]) => ({ status, count, closed: isClosedStatus(status) })),
    readyQueue,
    activeLocks: stats.flatMap(({ ctx, stats: s }) => ctx.record.locks.map((l) => ({
      slug: ctx.record.slug,
      phase: l.phase,
      owner: l.owner,
      session: l.session,
      expired: l.expired,
      leaseUntil: l.leaseUntil,
      closed: s.closed,
    }))).sort((a, b) =>
      // Debris last, then live before expired: the rows that need a decision
      // come first, and a closed plan's leftovers never head the list.
      Number(a.closed) - Number(b.closed)
      || Number(a.expired) - Number(b.expired)
      || (b.leaseUntil ?? 0) - (a.leaseUntil ?? 0)),
    qaModes: tally(plans.map((s) => s.stats.qaMode)).map(([mode, count]) => ({ mode, count })),
    qaFailures: stats.flatMap(({ ctx }) => ctx.record.qa.filter((q) => q.result === 'fail')
      .map((q) => ({ slug: ctx.record.slug, phase: q.phase }))),
    issues: stats.flatMap((s) => s.stats.issues),
    velocity: weeklyBuckets(completions.map((c) => c.date), 26),
    calendar: tally(completions.map((c) => c.date)).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)),
    medianCycleDays: gaps.length ? round1(median(gaps)) : undefined,
    sizeMix: (['S', 'M', 'L'] as PhaseSize[]).map((size) => ({
      size,
      count: plans.reduce((n, s) => n + Object.values(s.ctx.record.plan?.phases ?? {}).filter((p) => p.size === size).length, 0),
    })),
    repos: tally(plans.flatMap((s) => s.stats.repos)).slice(0, 14).map(([repo, count]) => ({ repo, count })),
    skills: tally(stats.flatMap(({ ctx }) => ctx.record.handoffs.flatMap((h) => h.skillsUsed)))
      .slice(0, 14).map(([skill, count]) => ({ skill, count })),
    models: tally(plans.map((s) => s.stats.targetModel ?? 'unspecified')).map(([model, count]) => ({ model, count })),
    phaseCounts: tally(plans.map((s) => String(s.stats.phases)))
      .map(([phases, plansCount]) => ({ phases: Number(phases), plans: plansCount }))
      .sort((a, b) => a.phases - b.phases),
    stalled,
    busiest: tally(completions.map((c) => c.slug)).slice(0, 10).map(([slug, completionCount]) => ({ slug, completions: completionCount })),
    ...(rate ? { rate } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * How long is left
 * ------------------------------------------------------------------ */

/**
 * One completed phase, as evidence about how fast this plan goes.
 *
 * Weight rather than count, because phases are not interchangeable: an `S` and
 * an `L` differ by six times the working set, and a plan whose last three
 * phases were small would otherwise promise a finish it cannot keep.
 */
export type EtaSample = { weight: number; durationMs: number; at?: string };

/**
 * Where a rate came from, which is the thing that decides how much to believe it.
 *
 * An estimate built from this plan's own finished phases and one built from a
 * heuristic constant are the same shape and nothing like the same claim. Before
 * this existed the console could only say the number or say nothing, so the only
 * way to be honest about a guess was to suppress it — and a plan that has never
 * run showed no estimate at all, which is the case someone most wants one for.
 */
export type EtaBasis = (typeof ETA_BASES)[number];

/**
 * Milliseconds per unit of weight when nothing, anywhere, has ever finished.
 *
 * Not a measurement — a stake in the ground, chosen so the three size tags land
 * on the durations `references/sizing.md` describes: at the sizing constants
 * (S 15K / M 40K / L 90K) this is 15 min, 40 min and 90 min. It is the last link
 * in the chain and always labelled `heuristic`, so nobody reads it as evidence.
 */
export const HEURISTIC_RATE_PER_WEIGHT = 60;

/** A rate, and how much weight to put on it. See `rateFor`. */
export type RateReading = {
  /** Milliseconds per unit of weight. */
  ratePerWeight: number;
  basis: EtaBasis;
  /** Finished phases behind the rate. Zero for the heuristic. */
  samples: number;
  /** How far the band runs either side of the point estimate, as a fraction. */
  spread: number;
};

export type EtaEstimate = {
  /** Milliseconds per unit of weight, EMA-smoothed. */
  ratePerWeight: number;
  /** How many completed phases the rate is built from. */
  samples: number;
  /** Which link of the fallback chain answered. See `EtaBasis`. */
  basis: EtaBasis;
  remainingWeight: number;
  remainingPhases: number;
  /** The range, in milliseconds, already snapped to its coarse bucket. */
  lowMs: number;
  highMs: number;
  /** What to render. Always a range, always hedged. */
  label: string;
};

/** One phase's own estimate — what the plan page puts beside a phase row. */
export type PhaseEta = {
  phase: number;
  weight: number;
  /** The point estimate for this phase alone, in milliseconds, bucketed. */
  estMs: number;
  basis: EtaBasis;
  /** `~40 min` — no "left", because a phase that has not started has none. */
  label: string;
};

/**
 * Smoothing factor for the rate.
 *
 * An EMA is the standard online estimator for this shape of problem —
 * recursive, no history to keep, and recency-weighted. Recency is the point
 * here rather than a nicety: model and effort change between phases in this
 * system, so a run's first phase on `haiku`/`low` says almost nothing about its
 * fourth on `opus`/`xhigh`, and a plain mean would hold that stale evidence
 * forever. At 0.4 the newest phase carries 40% of the estimate and anything
 * five phases back is under 5% of it.
 */
export const ETA_ALPHA = 0.4;

/** Completed phases across every run of a plan, oldest first. */
export function etaSamples(
  runs: { phases: Record<string, { phase: number; status: string; durationMs?: number; endedAt?: string }> }[],
  weights: Map<number, number>,
): EtaSample[] {
  const samples: EtaSample[] = [];
  for (const run of runs) {
    for (const record of Object.values(run.phases ?? {})) {
      // Only a phase that finished is evidence of how long a phase takes. An
      // interrupted one measures when somebody pressed Stop.
      if (record.status !== 'done' || !record.durationMs || record.durationMs <= 0) continue;
      const weight = weights.get(record.phase);
      if (!weight) continue;
      samples.push({ weight, durationMs: record.durationMs, at: record.endedAt });
    }
  }
  // Chronological, because the EMA's whole behaviour is order-dependent. A
  // record with no `endedAt` sorts last: it is almost certainly the newest.
  return samples.sort((a, b) => (a.at ?? '9999').localeCompare(b.at ?? '9999'));
}

/** EMA of duration-per-weight over samples in order. Null when there are none. */
export function emaRate(samples: EtaSample[], alpha = ETA_ALPHA): number | null {
  let ema: number | null = null;
  for (const sample of samples) {
    if (!sample.weight || sample.durationMs <= 0) continue;
    const rate = sample.durationMs / sample.weight;
    ema = ema === null ? rate : alpha * rate + (1 - alpha) * ema;
  }
  return ema;
}

/** Phases that are actually evidence — a zero-weight or zero-duration one is not. */
function usableSamples(samples: EtaSample[]): number {
  return samples.filter((s) => s.weight && s.durationMs > 0).length;
}

/** How wide the band runs on `n` of this plan's own finished phases. */
function spreadFor(used: number): number {
  return used >= 4 ? 0.35 : used >= 2 ? 0.5 : 0.7;
}

/**
 * The rate to use, and how much of a claim it is.
 *
 * Three links, tried in order, each weaker and each labelled as such:
 *
 * 1. **this plan's own finished phases** — the only reading that accounts for
 *    what this particular work is like;
 * 2. **every plan's finished phases, pooled** — the machine and the account are
 *    the same, so throughput transfers *somewhat*; how much is exactly the thing
 *    this cannot measure, hence a band never tighter than half;
 * 3. **the heuristic constant** — no evidence at all, and it says so.
 *
 * The chain exists because suppression was the old answer to "no evidence", and
 * suppression is worst precisely where the question is loudest: a plan that has
 * never run showed nothing. A labelled rough guess is more use than silence, and
 * strictly more honest than an unlabelled precise one.
 */
export function rateFor(
  planSamples: EtaSample[],
  portfolioSamples: EtaSample[] = [],
  alpha = ETA_ALPHA,
): RateReading {
  const own = emaRate(planSamples, alpha);
  if (own !== null && own > 0) {
    const used = usableSamples(planSamples);
    return { ratePerWeight: own, basis: 'plan', samples: used, spread: spreadFor(used) };
  }

  const pooled = emaRate(portfolioSamples, alpha);
  if (pooled !== null && pooled > 0) {
    const used = usableSamples(portfolioSamples);
    return {
      ratePerWeight: pooled,
      basis: 'portfolio',
      samples: used,
      // Never tighter than half however many samples there are: the count says
      // how well the pool is measured, not how well it applies to this plan.
      spread: Math.max(0.5, spreadFor(used)),
    };
  }

  return {
    ratePerWeight: HEURISTIC_RATE_PER_WEIGHT,
    basis: 'heuristic',
    samples: 0,
    spread: 0.6,
  };
}

/**
 * What is left, as a range nobody should read to the minute.
 *
 * A **range in coarse buckets**, never a countdown: the underlying quantity is a
 * model's throughput on work nobody has seen yet, and rendering that to the
 * second claims a precision that does not exist. The band widens as the evidence
 * weakens, which is the honest direction for it to move — and `basis` says which
 * kind of evidence it was, so the render site can hedge in words too.
 *
 * Still null on **zero remaining weight**: "0 min left" on a finished plan is
 * not an estimate, it is a units error.
 */
export function etaFrom(
  rate: RateReading,
  remaining: { weight: number; phases: number },
): EtaEstimate | null {
  if (!remaining.weight || remaining.weight <= 0) return null;
  if (!(rate.ratePerWeight > 0)) return null;

  const point = remaining.weight * rate.ratePerWeight;
  const lowMs = bucketMs(point * (1 - rate.spread));
  const highMs = bucketMs(point * (1 + rate.spread));

  return {
    ratePerWeight: rate.ratePerWeight,
    samples: rate.samples,
    basis: rate.basis,
    remainingWeight: remaining.weight,
    remainingPhases: remaining.phases,
    lowMs,
    highMs,
    label: lowMs === highMs ? `~${humanMs(highMs)} left` : `~${humanMs(lowMs)}–${humanMs(highMs)} left`,
  };
}

/**
 * The plan-evidence-only estimate: null until a phase of THIS plan has finished.
 *
 * Kept as its own function because that suppression is still the right answer
 * for a caller that wants "what this plan has actually shown us" and nothing
 * weaker. Everything else goes through `rateFor` + `etaFrom`.
 */
export function estimateEta(
  samples: EtaSample[],
  remaining: { weight: number; phases: number },
  alpha = ETA_ALPHA,
): EtaEstimate | null {
  const rate = rateFor(samples, [], alpha);
  return rate.basis === 'plan' ? etaFrom(rate, remaining) : null;
}

/**
 * One phase, on its own.
 *
 * The same rate as the plan estimate, applied to one phase's weight — so a table
 * of phases and the header above it cannot disagree about how fast this plan
 * goes. A point rather than a range: beside a row there is space for one number,
 * and `~` plus a bucket is already the whole claim.
 */
export function phaseEtaFor(phase: number, weight: number, rate: RateReading): PhaseEta {
  const estMs = bucketMs(weight * rate.ratePerWeight);
  return { phase, weight, estMs, basis: rate.basis, label: `~${humanMs(estMs)}` };
}

/** Snap to a scale a person would say out loud: 5 min, then half hours, then hours. */
function bucketMs(ms: number): number {
  const minutes = ms / 60_000;
  if (minutes <= 5) return 5 * 60_000;
  if (minutes < 60) return Math.round(minutes / 5) * 5 * 60_000;
  const hours = minutes / 60;
  if (hours < 4) return (Math.round(hours * 2) / 2) * 3_600_000;
  if (hours < 24) return Math.round(hours) * 3_600_000;
  return Math.round(hours / 6) * 6 * 3_600_000;
}

function humanMs(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = ms / 3_600_000;
  if (hours < 24) return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
  const days = ms / 86_400_000;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)} d`;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function sum(list: number[]): number { return list.reduce((a, b) => a + b, 0); }

function median(list: number[]): number {
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

function tally(list: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const item of list) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function sameSet(a: number[], b: number[]): boolean {
  const left = [...new Set(a)].sort((x, y) => x - y).join(',');
  const right = [...new Set(b)].sort((x, y) => x - y).join(',');
  return left === right;
}

/** ISO week key (`2026-W31`) buckets for the last `weeks` weeks, oldest first. */
export function weeklyBuckets(dates: string[], weeks: number): { week: string; count: number }[] {
  const counts = new Map<string, number>();
  const now = new Date();
  const keys: string[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 7 * DAY);
    const key = isoWeek(d);
    keys.push(key);
    counts.set(key, 0);
  }
  for (const date of dates) {
    const key = isoWeek(new Date(`${date}T12:00:00Z`));
    if (counts.has(key)) counts.set(key, counts.get(key)! + 1);
  }
  return keys.map((week) => ({ week, count: counts.get(week) ?? 0 }));
}

export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export { layerGraph };

/* ------------------------------------------------------------------ *
 * The forecast — a DATE, and everything it is standing on
 * ------------------------------------------------------------------ */

/**
 * ## Why a completion date is not `now + etaFrom(...)`
 *
 * `EtaEstimate` measures WORKING time: remaining weight × how long a unit of
 * weight has taken, summed as though every remaining phase ran back to back.
 * A calendar date is a different quantity, and the gap between them is the
 * hours a plan spends NOT working — waiting on a gate, held by a review,
 * parked on an external clock, or simply overnight while nobody boards a phase.
 * Adding working milliseconds to `now` silently assumes that gap is zero, which
 * for every plan in this repo's own history is off by more than the estimate
 * itself.
 *
 * So the working estimate is stretched by a **measured duty cycle**: of the
 * wall-clock this plan has actually elapsed, what fraction was a phase running.
 * It is measured from the plan's own completions, it degrades to a stated
 * assumption of 1.0 when there is nothing to measure, and — this is the point —
 * every input is reported alongside the date, because a forecast whose
 * assumptions are not visible is a number that will be quoted without them.
 */

/** How much of a plan's elapsed wall-clock was a phase actually running. */
export type DutyCycle = {
  /** Working ms ÷ elapsed ms, clamped to (0, 1]. */
  ratio: number;
  /** Completions behind the measurement. Zero when it could not be measured. */
  samples: number;
  /** True when nothing could be measured and `ratio` is the stated 1.0 assumption. */
  assumed: boolean;
  workingMs: number;
  elapsedMs: number;
};

/** Nothing to measure: the honest fallback is "assume it runs continuously", said out loud. */
const CONTINUOUS: DutyCycle = { ratio: 1, samples: 0, assumed: true, workingMs: 0, elapsedMs: 0 };

/**
 * The share of elapsed time this plan has spent working.
 *
 * Measured over the window between the FIRST and LAST completion, so the
 * numerator excludes the first sample's own duration — that work happened
 * before the window opened, and counting it would let a two-phase plan report
 * a duty cycle above 1.
 *
 * Needs a window with width. ONE decision does that job — `elapsedMs <= 0` —
 * and it covers both ways there is none: a single completion (a duration with
 * no window around it) and two that landed on the same instant. The emptiness
 * check above it is a different rule, guarding the array read, not the maths.
 */
export function dutyCycle(samples: EtaSample[]): DutyCycle {
  const dated = samples
    .filter((s) => s.at && s.durationMs > 0)
    .map((s) => ({ at: Date.parse(s.at!), durationMs: s.durationMs }))
    .filter((s) => Number.isFinite(s.at))
    .sort((a, b) => a.at - b.at);
  if (!dated.length) return CONTINUOUS;

  const elapsedMs = dated[dated.length - 1]!.at - dated[0]!.at;
  if (elapsedMs <= 0) return CONTINUOUS;
  // Every entry in `dated` has a positive duration and a non-zero window needs
  // at least two of them, so this sum is always positive here — no third guard.
  const workingMs = dated.slice(1).reduce((sum, s) => sum + s.durationMs, 0);

  return {
    // Clamped: phases may run in parallel lanes, so the working sum can exceed
    // the window. A duty cycle over 1 would then SHRINK the forecast below the
    // working time, which is a claim the evidence cannot support.
    ratio: Math.min(1, workingMs / elapsedMs),
    samples: dated.length,
    assumed: false,
    workingMs,
    elapsedMs,
  };
}

export type Forecast = {
  /** ISO instants. The client renders them in its own zone; this module never picks one. */
  earliest: string;
  expected: string;
  latest: string;
  basis: EtaBasis;
  samples: number;
  remainingPhases: number;
  remainingWeight: number;
  /** What the ETA measured, before the duty cycle stretched it. */
  workingLowMs: number;
  workingHighMs: number;
  duty: DutyCycle;
  /** Every assumption the date rests on, in the order applied. Rendered verbatim. */
  assumptions: string[];
  /** Zone-free, so it is safe to print anywhere: `~3–9 days out`. */
  label: string;
};

/** A rounded percentage that never reads `0%` for a real, tiny fraction. */
function pct(ratio: number): string {
  const value = ratio * 100;
  if (value >= 10) return `${Math.round(value)}%`;
  if (value >= 1) return `${Math.round(value * 10) / 10}%`;
  return `${Math.round(value * 100) / 100}%`;
}

/**
 * When this plan finishes, and why you should or should not believe it.
 *
 * Null exactly when `etaFrom` is null — no remaining work, or no usable rate.
 * "Finishes today" on a finished plan is a units error, and this module inherits
 * that judgement rather than re-deciding it.
 */
export function forecastFrom(
  eta: EtaEstimate | null,
  duty: DutyCycle,
  now: Date | number,
): Forecast | null {
  if (!eta) return null;
  const at = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(at)) return null;

  const ratio = duty.ratio > 0 && duty.ratio <= 1 ? duty.ratio : 1;
  const lowMs = eta.lowMs / ratio;
  const highMs = eta.highMs / ratio;
  const midMs = (lowMs + highMs) / 2;

  const iso = (ms: number): string => new Date(at + ms).toISOString();

  const assumptions = [
    `Rate: ${BASIS_CLAIM[eta.basis]} (${eta.samples} completed ${eta.samples === 1 ? 'phase' : 'phases'} behind it).`,
    `Work left: ${eta.remainingWeight} weight across ${eta.remainingPhases} `
      + `${eta.remainingPhases === 1 ? 'phase' : 'phases'}, from each phase's size tag.`,
    duty.assumed
      ? 'Duty cycle: assumed 100% — this plan has not finished two dated phases, so nothing '
        + 'measures the hours it spends NOT working. The date is the working estimate added to now, '
        + 'and it will be early.'
      : `Duty cycle: ${pct(ratio)} — measured, phases ran for ${humanMs(duty.workingMs)} of the `
        + `${humanMs(duty.elapsedMs)} between this plan's first and last completion. Gates, review holds, `
        + 'parks and overnight gaps are already inside that number; change how the plan is driven and it '
        + 'stops applying.',
    'Phases are assumed to run one after another. Concurrent lanes finish sooner than this.',
    'The band is the ETA’s own: it widens with FEWER completed phases, and never reflects how '
      + 'variable those phases actually were.',
  ];

  return {
    earliest: iso(lowMs),
    expected: iso(midMs),
    latest: iso(highMs),
    basis: eta.basis,
    samples: eta.samples,
    remainingPhases: eta.remainingPhases,
    remainingWeight: eta.remainingWeight,
    workingLowMs: eta.lowMs,
    workingHighMs: eta.highMs,
    duty,
    assumptions,
    label: lowMs === highMs
      ? `~${humanMs(highMs)} out`
      : `~${humanMs(lowMs)}–${humanMs(highMs)} out`,
  };
}

/** What each basis actually claims, for the assumptions list. Matches `client/features/insights/eta.tsx`. */
const BASIS_CLAIM: Record<EtaBasis, string> = {
  plan: 'measured from this plan’s own completed phases',
  portfolio: 'pooled across every plan — this one has not finished enough phases to speak for itself',
  heuristic: 'the shipped constant — nothing has completed anywhere, so this is a placeholder, not a forecast',
};
