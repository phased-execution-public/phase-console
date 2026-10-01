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
  type Sizing, type McpSizing, type SessionsPerSize,
} from './graph.ts';
import { parseScope } from '../../shared/scope.js';
import { phaseClocks, planSpan } from '../../shared/phase-clocks.js';
import { CLOSED_PLAN_STATUSES, PLAN_STATUSES } from '../../shared/plan-vocab.js';
import {
  ETA_BASES, HEALTH_SEVERITIES, type DutyUnknownReason, type EtaMissingReason,
} from '../../shared/ops-vocab.js';
import { mergeDecisions } from '../../shared/decisions-model.js';
import { personCheckFor } from '../parse/plan.ts';
import { policyForPlan } from '../runner/policy.ts';
import type { RunVerifyApprovals } from '../runner/state.ts';
import { approvalsForPhase, reviewPhase } from '../runner/verify-review.ts';

/**
 * The slice of a run record the health analysis reads. Structural rather than
 * the runner's own `RunState` so this module stays a reader of files on disk,
 * never of the loop; the service fills it from `listRuns`.
 */
export type RunView = {
  id: string;
  status: string;
  phases: Record<string, { phase: number; status: string; startedAt?: string; endedAt?: string; attemptEndedAt?: string }>;
  /** The run's start-door answers for §Verification — what plan health reads to know a phase is answered. */
  verifyApprovals?: RunVerifyApprovals;
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
  /**
   * When work on the plan actually began — the earliest boarding any of its
   * runs recorded, ISO with time (#28). `created` stays the authoring date the
   * plan file gives, to the day. Absent until a run boards a phase.
   */
  startedAt?: string;
  /** From `startedAt` to now while a run is live, else to the last recorded end — to the millisecond (#28). */
  spanMs?: number;
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
export function planStats(ctx: PlanContext, sizing: Sizing, mcp?: McpSizing, sessions?: SessionsPerSize): PlanStats {
  const { record, board, qaMode } = ctx;
  const plan = record.plan;
  const rows = plan?.graph ?? [];
  const sizes = new Map<number, PhaseSize>(rows.map((r) => [r.phase, plan?.phases[r.phase]?.size ?? 'M']));
  const budget = resolveBudget(plan?.sessionBudget.targetModel, sizing);
  const index = indexGraph(rows);

  // Sessions in the console's unit — each phase its measured sessions, never a
  // weight over a budget (control-tower phase 59, #83).
  const critical = criticalPath(index, board, sizes, sizing, budget, undefined, sessions);
  const remaining = remainingWork(rows, board, sizes, sizing, budget, undefined, sessions);

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
    ...planSpan(ctx.runs ?? [], Date.now()),
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
  'verification-unrunnable', 'verification-approval', 'record-ahead-of-board',
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
    // What boarding will do with this phase's §Verification — asked of the ONE
    // review boarding asks (`runner/verify-review.ts`), with the plan's own
    // Person-check and the newest run's start-door answers, about the plan
    // alone (a missing binary is this machine's, not the plan's). It is the
    // issue the plan-repair agent knows how to fix, which is what lets
    // `resolveRecovery` accept a repair at all — so it names only what a plan
    // edit fixes. A command waiting for one exact approval is `info`: an
    // approval is the operator's, and a paid session could only record an
    // errand about it (run f0da619a, 2026-09-18).
    if (!board.done.includes(row.phase)) {
      const review = reviewPhase({
        phase: row.phase,
        verification: detail?.verification,
        declared: /\*\*\s*Verification\b/i.test(detail?.raw ?? ''),
        personCheck: personCheckFor(plan, row.phase)
          ?? policyForPlan('verification.person-check', mergeDecisions(plan.decisions, record.decisionsTwin ?? []), null)?.answer
          ?? null,
        approvals: approvalsForPhase(ctx.runs?.[0]?.verifyApprovals, row.phase),
        skipPathProbe: true,
      });
      if (review.verdict === 'parks') {
        if (!review.items.length) {
          const declared = /\*\*\s*Verification\b/i.test(detail?.raw ?? '');
          add('warning', 'verification-unrunnable',
            declared
              ? `Phase ${row.phase}'s §Verification yields nothing the runner can execute — it will park at boarding`
              : `Phase ${row.phase} has no §Verification — it will park at boarding`,
            row.phase);
        }
        for (const item of review.items) {
          if (item.approvable) {
            add('info', 'verification-approval',
              `Phase ${row.phase}'s §Verification needs one approval at the start door: ${item.text} — ${item.reason}`,
              row.phase);
          } else {
            add('warning', 'verification-unrunnable',
              review.runs.length
                ? `Phase ${row.phase}'s §Verification: ${item.text} — ${item.reason}; Person-check: halt parks it at boarding`
                : `Phase ${row.phase}'s §Verification yields nothing the runner can execute — it will park at boarding `
                  + `(${item.text} — ${item.reason})`,
              row.phase);
          }
        }
      }
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
  contexts: PlanContext[], sizing: Sizing, rate?: RateReading, mcp?: McpSizing, sessions?: SessionsPerSize,
): Portfolio {
  const stats = contexts.map((ctx) => ({ ctx, stats: planStats(ctx, sizing, undefined, sessions) }));
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
 * One finished phase, as evidence about how long phases take here.
 *
 * `durationMs` is the phase's WORKED time — every session that worked it,
 * resume, repair, QA, closeout, landing and review included (#28's
 * `phaseClocks.workedMs`, control-tower phase 58, #66) — never the first
 * attempt alone. `size` is the phase's tag, the class the per-size medians are
 * taken over; `floorMs` a declared `- **Wall-clock floor:**`, which explains
 * the phase's time by itself and so teaches the rate nothing.
 */
export type EtaSample = {
  weight: number;
  durationMs: number;
  at?: string;
  size?: PhaseSize;
  floorMs?: number;
};

/** A finished phase that is NOT evidence, and why — reported, never silently dropped (EE-3). */
export type EtaMissing = { phase: number; reason: EtaMissingReason };

export type EtaEvidence = { samples: EtaSample[]; missing: EtaMissing[] };

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
 * The least worked time that measures a phase's work (EE-2). No session boots,
 * reads a plan and works a phase in under five minutes: the finished records
 * below it (12.8 s, 5 s) are closeout-only completions and phases closed outside
 * the run, and one entered the old EMA as a 40 % cut in a single step.
 */
export const ETA_MIN_EVIDENCE_MS = 5 * 60_000;

/** A plan's newest measured phases the level is read from — a bounded window, never all of history. */
export const ETA_PLAN_WINDOW = 12;

/**
 * The pool's newest measured phases the SHAPE is fitted on. Bounded for the
 * same reason, and so the evidence count a surface prints is the count that was
 * weighted — the pool once claimed 413 phases while an EMA over four decided.
 */
export const ETA_POOL_WINDOW = 60;

/**
 * How many measured phases a plan needs before its own level stands alone.
 * Below it each of its ratios is bounded to `ETA_CLIP` of the pool and the
 * level is shrunk toward the pool in proportion — which is what keeps one
 * outlier from moving an estimate more than 1.5× even when it is most of the
 * evidence (ER-1). From the third on, a median does that job by itself.
 */
export const ETA_SPEAK_AT = 3;

/** The furthest one ratio may pull a plan that has not yet reached `ETA_SPEAK_AT` (log). */
export const ETA_CLIP = Math.log(3);

/**
 * How many phases of one size the pool window needs before that size anchors
 * the shape. Below it the size's median is one or two phases — itself — and
 * pe-hub's newest sixty held exactly one S, a six-hour one, which as an anchor
 * bent the line to S ≈ M ≈ L (2026-09-25). Such a size stays in the window and
 * the band; the line goes through the sizes that are classes.
 */
export const ETA_CLASS_MIN = 3;

/**
 * The shape when nothing, anywhere, has finished: a floor plus a slope,
 * re-derived from measurement (control-tower phase 58, #65) rather than the
 * old stake in the ground (60 ms per weight: 15/40/90 min for S/M/L, which
 * made an L six times an S). Fitted through the per-size medians of the 520
 * measured phases two consoles had stored on 2026-09-25 — every session's
 * worked time: S 0.58 h (38), M 0.89 h (204), L 1.22 h (278) — it lands
 * S ≈ 41 min, M ≈ 52 min, L ≈ 74 min. Always labelled `heuristic`, so nobody
 * reads it as evidence.
 */
export const HEURISTIC_FLOOR_MS = 34 * 60_000;
export const HEURISTIC_SLOPE_MS_PER_WEIGHT = 26;

/** The shipped shape at one weight — what a surface with no rate reading may print. */
export function heuristicPhaseMs(weight: number): number {
  return HEURISTIC_FLOOR_MS + HEURISTIC_SLOPE_MS_PER_WEIGHT * Math.max(0, weight);
}

/**
 * Kept for readers that print one per-weight figure: the shipped shape's rate
 * at an M phase (40K). The estimator itself never multiplies weight by a rate.
 */
export const HEURISTIC_RATE_PER_WEIGHT = Math.round(heuristicPhaseMs(40_000) / 40_000);

/**
 * A rate, and how much weight to put on it. See `rateFor`.
 *
 * The model is AFFINE: a phase takes `floorMs + slopeMsPerWeight × weight` of
 * working time. The proportional model before it (weight × rate) could not
 * represent the per-phase floor every session pays — measured, an L phase
 * takes 2.31× an S, not the 6× its weight says — so it over-estimated L after
 * a run of small phases and under-estimated S.
 */
export type RateReading = {
  basis: EtaBasis;
  /** The affine floor: working time any phase takes before its weight counts. */
  floorMs: number;
  /** The affine slope, milliseconds per unit of weight. */
  slopeMsPerWeight: number;
  /** One per-weight figure for surfaces that print one: the model at an M phase (40K) ÷ 40K. */
  ratePerWeight: number;
  /**
   * The measured phases actually WEIGHTED: the plan window's count for `plan`,
   * the pool window's for `portfolio`, zero for the heuristic (ER-3).
   */
  samples: number;
  /**
   * How far the band runs above the point, as a fraction (`e^q − 1`); it runs
   * the same factor below. From the observed dispersion of the phases behind the
   * reading (ER-2) — the 75th percentile of how far they fell from the model —
   * never from how many there were.
   */
  spread: number;
  /** Finished phases of this plan with no usable measurement (EE-3). */
  missing: number;
  clock: 'working';
};

export type EtaEstimate = {
  /** The reading's per-weight figure (`RateReading.ratePerWeight`). */
  ratePerWeight: number;
  floorMs: number;
  slopeMsPerWeight: number;
  /** How many measured phases the reading weighted. */
  samples: number;
  /** Finished phases with no usable measurement, reported beside the count. */
  missing: number;
  /** Which link of the fallback chain answered. See `EtaBasis`. */
  basis: EtaBasis;
  remainingWeight: number;
  remainingPhases: number;
  /** The range, in milliseconds, already snapped to its coarse bucket. */
  lowMs: number;
  highMs: number;
  /** Working time: the remaining phases back to back, nothing parked, queued or overnight. */
  clock: 'working';
  /** What to render. Always a range, always hedged, always naming its clock. */
  label: string;
};

/** One phase's own estimate — what the plan page puts beside a phase row. */
export type PhaseEta = {
  phase: number;
  weight: number;
  /** The point estimate for this phase alone, in milliseconds, bucketed. */
  estMs: number;
  basis: EtaBasis;
  clock: 'working';
  /** `~40 min of work` — no "left", because a phase that has not started has none. */
  label: string;
};

/** The phase size an evidence sample is classed under: its tag, else the nearest shipped weight. */
function classOf(sample: EtaSample): string {
  if (sample.size) return sample.size;
  const w = sample.weight;
  return w < 27_500 ? 'S' : w < 65_000 ? 'M' : 'L';
}

/**
 * Is this finished record evidence of how long a phase takes — and if not, why
 * not (EE-1..3)? Worked time is `phaseClocks.workedMs`: every session's window.
 * A closeout's paperwork is part of finishing a phase, but a record whose ONLY
 * real time is a closeout measured the paperwork, not the work.
 */
export function evidenceOf(record: Record<string, unknown>, nowMs = Date.now()): { durationMs: number } | { missing: EtaMissingReason } {
  const clocks = phaseClocks(record, nowMs);
  const worked = clocks.workedMs;
  if (worked === null || !(worked > 0)) return { missing: 'no-duration' };
  const closeoutMs = clocks.attemptWindows
    .filter((w) => w.mode === 'closeout')
    .reduce((sum, w) => sum + Math.max(0, Date.parse(w.endedAt ?? '') - Date.parse(w.startedAt)), 0);
  if (closeoutMs > 0 && worked - closeoutMs < ETA_MIN_EVIDENCE_MS) return { missing: 'closeout-only' };
  if (worked < ETA_MIN_EVIDENCE_MS) return { missing: 'near-zero' };
  return { durationMs: worked };
}

type EvidencePhase = { weight: number; size?: PhaseSize; floorMs?: number };

/**
 * Finished phases across every run of a plan, oldest first — the samples, and
 * the finished phases that could not be samples (EE-3). `phases` maps a phase
 * number to its weight (and, where known, its size and declared floor); a
 * number is accepted for the callers that know only the weight.
 */
export function etaEvidence(
  runs: { phases: Record<string, { phase: number; status: string; endedAt?: string } & Record<string, unknown>> }[],
  phases: ReadonlyMap<number, number | EvidencePhase>,
  nowMs = Date.now(),
): EtaEvidence {
  const samples: EtaSample[] = [];
  const missing: EtaMissing[] = [];
  for (const run of runs) {
    for (const record of Object.values(run.phases ?? {})) {
      // Only a phase that finished is evidence of how long a phase takes. An
      // interrupted one measures when somebody pressed Stop.
      if (record.status !== 'done') continue;
      const known = phases.get(record.phase);
      const phase = typeof known === 'number' ? { weight: known } : known;
      if (!phase?.weight) continue;
      const verdict = evidenceOf(record, nowMs);
      if ('missing' in verdict) {
        missing.push({ phase: record.phase, reason: verdict.missing });
        continue;
      }
      samples.push({
        weight: phase.weight,
        durationMs: verdict.durationMs,
        at: record.endedAt,
        ...(phase.size ? { size: phase.size } : {}),
        ...(phase.floorMs ? { floorMs: phase.floorMs } : {}),
      });
    }
  }
  // Chronological: both windows are the NEWEST phases. A record with no
  // `endedAt` sorts last — it is almost certainly the newest.
  samples.sort((a, b) => (a.at ?? '9999').localeCompare(b.at ?? '9999'));
  return { samples, missing };
}

/** `etaEvidence(…).samples` — for a caller that has no use for what was missing. */
export function etaSamples(
  runs: Parameters<typeof etaEvidence>[0],
  phases: ReadonlyMap<number, number | EvidencePhase>,
): EtaSample[] {
  return etaEvidence(runs, phases).samples;
}

/** A sample that teaches the rate: measured, and not explained by a declared floor. */
function teaches(sample: EtaSample): boolean {
  return sample.weight > 0 && sample.durationMs >= ETA_MIN_EVIDENCE_MS && !sample.floorMs;
}

const Q_MIN = Math.log(1.25);
const Q_MAX = Math.log(4);
/** The band's half-width (log) under sparse plan evidence, a pool reading, and no evidence at all. */
const Q_SPARSE = Math.log(2);
const Q_POOL = Math.log(1.5);
const Q_HEURISTIC = Math.log(2.5);

/** The shape: working ms ≈ floor + slope × weight, fitted on the pool. */
export type EtaShape = {
  floorMs: number;
  slopeMsPerWeight: number;
  /** Pool phases the fit weighted (≤ `ETA_POOL_WINDOW`). */
  samples: number;
  /** The 75th percentile of |log(actual ÷ shape)| over the window. */
  dispersion: number;
  /** The per-size medians; `anchored` ones are those the line went through (`ETA_CLASS_MIN`). */
  sizes: { size: string; weight: number; medianMs: number; samples: number; anchored: boolean }[];
};

function shapeMs(shape: Pick<EtaShape, 'floorMs' | 'slopeMsPerWeight'>, weight: number): number {
  return Math.max(1, shape.floorMs + shape.slopeMsPerWeight * weight);
}

/** One point of the shared affine fit: a phase's weight, what was measured, and the size class it is taken over. */
export type AffinePoint = { weight: number; value: number; size: string };

/** A floor + slope through per-size medians, and the medians it went through. */
export type AffineFit = {
  floor: number;
  slope: number;
  /** The per-size medians; `anchored` ones are those the line went through (`ETA_CLASS_MIN`). */
  sizes: { size: string; weight: number; median: number; samples: number; anchored: boolean }[];
};

/**
 * The shared affine fit — one model, two quantities: phase 58's working TIME
 * (`fitShape`) and phase 59's session CONTEXT (`analysis/sizing-model.ts`).
 *
 * Per-size winsorised medians (each size's values clipped to within 4× of its
 * median), then a line through them by least squares. Only a size seen
 * `ETA_CLASS_MIN` times anchors it — a rarer one is a sample, not a class —
 * unless no size has been, when the line goes through what there is. A slope
 * the data says is negative is flat, a floor it says is negative is zero, and
 * points that know only one size take `proportions` (a shipped floor and
 * slope) scaled through that size's median. Null for no points.
 *
 * `weighting` is the one difference between the two readers. `count` — each
 * median weighs as many phases as it has — is the ETA's, which predicts the
 * pool's typical phase. `class` — every anchored size weighs once — is the
 * sizing model's, whose claim is per TAG ("the ratio sits near 1 for every
 * tag"): counted, eighty-seven M sessions would pull the line off sixteen S.
 */
export function fitAffine(
  points: readonly AffinePoint[],
  opts: { weighting: 'count' | 'class'; proportions: { floor: number; slope: number } },
): AffineFit | null {
  if (!points.length) return null;
  const bySize = new Map<string, AffinePoint[]>();
  for (const point of points) bySize.set(point.size, [...(bySize.get(point.size) ?? []), point]);
  const sizes = [...bySize.entries()]
    .map(([size, list]) => {
      const mid = median(list.map((p) => p.value));
      const clipped = list.map((p) => Math.min(Math.max(p.value, mid / 4), mid * 4));
      return {
        size,
        weight: median(list.map((p) => p.weight)),
        median: median(clipped),
        samples: list.length,
        anchored: list.length >= ETA_CLASS_MIN,
      };
    })
    .sort((a, b) => a.weight - b.weight);
  if (!sizes.some((s) => s.anchored)) for (const s of sizes) s.anchored = true;
  const anchors = sizes.filter((s) => s.anchored);
  const w = (s: (typeof anchors)[number]) => (opts.weighting === 'count' ? s.samples : 1);

  let floor: number;
  let slope: number;
  if (anchors.length === 1) {
    const only = anchors[0]!;
    const scale = only.median / Math.max(1, opts.proportions.floor + opts.proportions.slope * only.weight);
    floor = opts.proportions.floor * scale;
    slope = opts.proportions.slope * scale;
  } else {
    const n = sum(anchors.map(w));
    const mx = sum(anchors.map((s) => w(s) * s.weight)) / n;
    const my = sum(anchors.map((s) => w(s) * s.median)) / n;
    const sxx = sum(anchors.map((s) => w(s) * (s.weight - mx) ** 2));
    const sxy = sum(anchors.map((s) => w(s) * (s.weight - mx) * (s.median - my)));
    slope = sxx > 0 ? sxy / sxx : 0;
    floor = my - slope * mx;
    if (slope < 0) {
      slope = 0;
      floor = my;
    } else if (floor < 0) {
      floor = 0;
      slope = sum(anchors.map((s) => w(s) * s.median * s.weight)) / sum(anchors.map((s) => w(s) * s.weight * s.weight));
    }
  }
  return { floor, slope, sizes };
}

/**
 * Per-size winsorised medians over the pool's newest measured phases, fitted
 * to an affine floor + slope (ER-4) by `fitAffine`, the medians weighted by
 * their counts; the dispersion is then read over the same window, each
 * deviation bounded, so one sample moves neither a median nor the band far.
 * Null for an empty pool.
 */
export function fitShape(pool: readonly EtaSample[]): EtaShape | null {
  const window = pool.filter(teaches).slice(-ETA_POOL_WINDOW);
  const fit = fitAffine(
    window.map((s) => ({ weight: s.weight, value: s.durationMs, size: classOf(s) })),
    { weighting: 'count', proportions: { floor: HEURISTIC_FLOOR_MS, slope: HEURISTIC_SLOPE_MS_PER_WEIGHT } },
  );
  if (!fit) return null;
  const fitted = { floorMs: fit.floor, slopeMsPerWeight: fit.slope };
  const deviations = window.map((s) => Math.min(Math.abs(Math.log(s.durationMs / shapeMs(fitted, s.weight))), Q_MAX));
  return {
    floorMs: fit.floor,
    slopeMsPerWeight: fit.slope,
    samples: window.length,
    dispersion: clamp(percentile(deviations, 0.75), Q_MIN, Q_MAX),
    sizes: fit.sizes.map(({ median: medianMs, ...rest }) => ({ ...rest, medianMs })),
  };
}

/**
 * This plan's level against the shape, in log space: the median of its newest
 * measured phases' log(actual ÷ shape) — a plan that runs twice the pool reads
 * `ln 2`. Below `ETA_SPEAK_AT` phases each ratio is clipped to `ETA_CLIP` and the
 * level shrunk toward the pool in proportion; from there on it is the plain
 * median, and the band is the 75th percentile of the winsorised deviations.
 */
export function planLevel(own: readonly EtaSample[], shape: Pick<EtaShape, 'floorMs' | 'slopeMsPerWeight'>): {
  level: number; samples: number; dispersion: number | null;
} {
  const window = own.filter(teaches).slice(-ETA_PLAN_WINDOW);
  if (!window.length) return { level: 0, samples: 0, dispersion: null };
  const ratios = window.map((s) => Math.log(s.durationMs / shapeMs(shape, s.weight)));
  if (window.length < ETA_SPEAK_AT) {
    const clipped = ratios.map((r) => clamp(r, -ETA_CLIP, ETA_CLIP));
    return { level: (median(clipped) * window.length) / ETA_SPEAK_AT, samples: window.length, dispersion: null };
  }
  const level = median(ratios);
  const deviations = ratios.map((r) => Math.min(Math.abs(r - level), Q_MAX));
  return { level, samples: window.length, dispersion: clamp(percentile(deviations, 0.75), Q_MIN, Q_MAX) };
}

/**
 * The rate to use, and how much of a claim it is.
 *
 * Three links, tried in order, each weaker and each labelled as such:
 *
 * 1. **this plan's own measured phases** set the LEVEL against the pool's
 *    shape — the only reading that accounts for what this particular work is
 *    like;
 * 2. **the pool** (every plan's newest measured phases on this console) when the
 *    plan has none — the shape at the pool's own level, a band never tighter
 *    than ±50 %, because how well the pool applies to this plan is exactly what
 *    it cannot measure;
 * 3. **the shipped shape** — no evidence at all, and it says so.
 *
 * The shape is the pool's per-size medians fitted to a floor + slope
 * (`fitShape`); with an empty pool it is the shipped one, even under a plan
 * reading. `missing` is carried through untouched: the count of this plan's
 * finished phases that could not be samples.
 */
export function rateFor(
  planSamples: readonly EtaSample[],
  portfolioSamples: readonly EtaSample[] = [],
  opts: { missing?: number; shape?: EtaShape | null } = {},
): RateReading {
  const shape = opts.shape !== undefined ? opts.shape : fitShape(portfolioSamples.length ? portfolioSamples : planSamples);
  const base = shape ?? { floorMs: HEURISTIC_FLOOR_MS, slopeMsPerWeight: HEURISTIC_SLOPE_MS_PER_WEIGHT };
  const missing = opts.missing ?? 0;
  const own = planLevel(planSamples, base);
  if (own.samples > 0) {
    const scale = Math.exp(own.level);
    const q = own.dispersion ?? Math.max(shape?.dispersion ?? Q_SPARSE, Q_SPARSE);
    return reading('plan', base.floorMs * scale, base.slopeMsPerWeight * scale, own.samples, q, missing);
  }
  if (shape) return reading('portfolio', shape.floorMs, shape.slopeMsPerWeight, shape.samples, Math.max(shape.dispersion, Q_POOL), missing);
  return reading('heuristic', HEURISTIC_FLOOR_MS, HEURISTIC_SLOPE_MS_PER_WEIGHT, 0, Q_HEURISTIC, missing);
}

function reading(
  basis: EtaBasis, floorMs: number, slopeMsPerWeight: number, samples: number, q: number, missing: number,
): RateReading {
  return {
    basis,
    floorMs,
    slopeMsPerWeight,
    ratePerWeight: (floorMs + slopeMsPerWeight * 40_000) / 40_000,
    samples,
    spread: Math.exp(q) - 1,
    missing,
    clock: 'working',
  };
}

/**
 * One phase's working time under a reading, unbucketed: the affine model at its
 * weight, and never under a declared `- **Wall-clock floor:**`.
 */
export function estimateMs(rate: Pick<RateReading, 'floorMs' | 'slopeMsPerWeight'>, weight: number, floorMs = 0): number {
  return Math.max(rate.floorMs + rate.slopeMsPerWeight * Math.max(0, weight), floorMs);
}

/** A remaining phase with a declared floor — its weight, so the floor can replace the model where it is higher. */
export type RemainingFloor = { weight: number; floorMs: number };

/**
 * What is left, as a range nobody should read to the minute — in WORKING time.
 *
 * A **range in coarse buckets**, never a countdown: the underlying quantity is a
 * model's throughput on work nobody has seen yet, and rendering that to the
 * second claims a precision that does not exist. The point is the affine model
 * summed over the remaining phases (`phases × floor + slope × weight`, each
 * declared floor taking over where it is higher); the band is the reading's
 * own, from observed dispersion. The label says `of work`, because this is the
 * phases back to back — the calendar is `forecastFrom`'s question.
 *
 * Still null on **zero remaining weight**: "0 min left" on a finished plan is
 * not an estimate, it is a units error.
 */
export function etaFrom(
  rate: RateReading,
  remaining: { weight: number; phases: number; floors?: readonly RemainingFloor[] },
): EtaEstimate | null {
  if (!remaining.weight || remaining.weight <= 0) return null;
  if (!(rate.floorMs + rate.slopeMsPerWeight > 0)) return null;

  let point = Math.max(1, remaining.phases) * rate.floorMs + rate.slopeMsPerWeight * remaining.weight;
  for (const floor of remaining.floors ?? []) {
    const model = estimateMs(rate, floor.weight);
    if (floor.floorMs > model) point += floor.floorMs - model;
  }
  const factor = 1 + Math.max(0, rate.spread);
  const lowMs = bucketMs(point / factor);
  const highMs = bucketMs(point * factor);

  return {
    ratePerWeight: rate.ratePerWeight,
    floorMs: rate.floorMs,
    slopeMsPerWeight: rate.slopeMsPerWeight,
    samples: rate.samples,
    missing: rate.missing,
    basis: rate.basis,
    remainingWeight: remaining.weight,
    remainingPhases: remaining.phases,
    lowMs,
    highMs,
    clock: 'working',
    label: lowMs === highMs ? `~${humanMs(highMs)} of work left` : `~${humanMs(lowMs)}–${humanMs(highMs)} of work left`,
  };
}

/**
 * The plan-evidence-only estimate: null until a phase of THIS plan has been measured.
 *
 * Kept as its own function because that suppression is still the right answer
 * for a caller that wants "what this plan has actually shown us" and nothing
 * weaker. Everything else goes through `rateFor` + `etaFrom`.
 */
export function estimateEta(
  samples: readonly EtaSample[],
  remaining: { weight: number; phases: number },
): EtaEstimate | null {
  const rate = rateFor(samples, samples);
  return rate.basis === 'plan' ? etaFrom(rate, remaining) : null;
}

/**
 * One phase, on its own.
 *
 * The same reading as the plan estimate, at one phase's weight — so a table of
 * phases and the header above it cannot disagree about how fast this plan goes.
 * A point rather than a range: beside a row there is space for one number, and
 * `~` plus a bucket is already the whole claim.
 */
export function phaseEtaFor(phase: number, weight: number, rate: RateReading, floorMs = 0): PhaseEta {
  const estMs = bucketMs(estimateMs(rate, weight, floorMs));
  return { phase, weight, estMs, basis: rate.basis, clock: 'working', label: `~${humanMs(estMs)} of work` };
}

/** A holder PHASE's remaining working time — `holderRemaining`'s answer (control-tower phase 60, #63). */
export type HolderRemaining = {
  /** The point: what is left of its estimate, never under the residual below. */
  remainingMs: number;
  lowMs: number;
  highMs: number;
  /** It has already worked past its own estimate. */
  overrun: boolean;
  /** `~25–50 min of work left` — bucketed, naming its clock, and saying so when it is past its estimate. */
  label: string;
};

/**
 * How much of its own estimate a holder that has worked most or all of it is
 * still given. Measured, not assumed (`analysis/holder-eta.ts`, 425 admitted
 * waits on this machine): a holder already past its estimate went on to hold
 * the scope for a median 0.73 of it, so "0 min left" was the one answer
 * certain to be wrong. Half its estimate scored best of the rules tried —
 * MALE 1.19 against 1.79 for the bare difference.
 */
export const HOLDER_RESIDUAL_FRACTION = 0.5;

/**
 * What a holder PHASE has left (control-tower phase 60, #63): its estimate
 * (phase 58's model, `estimateMs`) minus the working time it has already put
 * in, never under `HOLDER_RESIDUAL_FRACTION` of the estimate, in a band from the
 * plan's own dispersion. The scope a waiter needs is released when the holder
 * PHASE ends — its whole plan was 24.7× the real wait at the median.
 */
export function holderRemaining(estimate: number, spread: number, workedMs: number): HolderRemaining {
  const factor = 1 + Math.max(0, spread);
  const left = estimate - Math.max(0, workedMs);
  const point = Math.max(left, estimate * HOLDER_RESIDUAL_FRACTION, 60_000);
  const lowMs = point / factor;
  const highMs = point * factor;
  const low = bucketMs(lowMs);
  const high = bucketMs(highMs);
  const range = low === high ? `~${humanMs(high)}` : `~${humanMs(low)}–${humanMs(high)}`;
  const overrun = left <= 0;
  return {
    remainingMs: point, lowMs, highMs, overrun,
    label: overrun ? `${range} of work left, past its estimate` : `${range} of work left`,
  };
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

/** The median; shared with `analysis/sizing-model.ts`. */
export function median(list: number[]): number {
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

function clamp(n: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, n)); }

/** The p-quantile by linear interpolation between order statistics; 0 for an empty list. */
export function percentile(list: number[], p: number): number {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  const k = (sorted.length - 1) * p;
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (k - lo);
}

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

/** How much of a plan's recent wall-clock was a phase actually running. */
export type DutyCycle = {
  /** Working ms ÷ elapsed ms over the recent window, clamped to (0, 1]. Meaningless unless `known`. */
  ratio: number;
  /** Completions in the window the measurement read. */
  samples: number;
  /** False when the window cannot say how this plan is being driven — then there is no date (EE-5). */
  known: boolean;
  /** Why it is not known. */
  reason?: DutyUnknownReason;
  workingMs: number;
  elapsedMs: number;
};

/** The completions the duty cycle reads: the newest ten … */
export const DUTY_WINDOW = 10;
/** … within a week of the newest, and only while the newest is within a week of now. */
export const DUTY_WINDOW_MS = 7 * DAY;
/**
 * Below this the window describes a plan that mostly SAT — 0.0003 and 0.0595
 * were measured — and dividing by it stretches a working estimate into a
 * fiction. Unknown is the honest answer.
 */
export const DUTY_MIN_RATIO = 0.05;
/** Fewer dated completions than this in the window is not a pace. */
export const DUTY_MIN_SAMPLES = 3;

/**
 * The share of this plan's RECENT elapsed time spent working (EE-4).
 *
 * Measured over the newest `DUTY_WINDOW` completions within `DUTY_WINDOW_MS` of
 * the newest, between the first and last of them, so the numerator excludes the
 * first one's own duration — that work happened before the window opened. The
 * old measurement ran from the plan's FIRST completion ever, so one completion
 * months back, or one near-zero record, stretched every forecast by a history
 * nobody was repeating. Unknown when the window holds fewer than three, when
 * its ratio is under `DUTY_MIN_RATIO`, or when its newest completion is more than
 * a week before `nowMs`.
 */
export function dutyCycle(samples: readonly EtaSample[], nowMs = Date.now()): DutyCycle {
  const dated = samples
    .filter((s) => s.at && s.durationMs > 0)
    .map((s) => ({ at: Date.parse(s.at!), durationMs: s.durationMs }))
    .filter((s) => Number.isFinite(s.at))
    .sort((a, b) => a.at - b.at);
  const unknown = (reason: DutyUnknownReason, window: typeof dated = []): DutyCycle => ({
    ratio: 1, samples: window.length, known: false, reason, workingMs: 0, elapsedMs: 0,
  });
  if (!dated.length) return unknown('too-few');
  const newest = dated[dated.length - 1]!.at;
  if (nowMs - newest > DUTY_WINDOW_MS) return unknown('stale', dated.slice(-DUTY_WINDOW));
  const window = dated.slice(-DUTY_WINDOW).filter((s) => newest - s.at <= DUTY_WINDOW_MS);
  if (window.length < DUTY_MIN_SAMPLES) return unknown('too-few', window);

  const elapsedMs = newest - window[0]!.at;
  if (elapsedMs <= 0) return unknown('too-few', window);
  const workingMs = window.slice(1).reduce((total, s) => total + s.durationMs, 0);
  // Clamped: phases may run in parallel lanes, so the working sum can exceed
  // the window. A duty cycle over 1 would then SHRINK the forecast below the
  // working time, which is a claim the evidence cannot support.
  const ratio = Math.min(1, workingMs / elapsedMs);
  if (ratio < DUTY_MIN_RATIO) return { ...unknown('idle-history', window), workingMs, elapsedMs, ratio };
  return { ratio, samples: window.length, known: true, workingMs, elapsedMs };
}

export type Forecast = {
  /** ISO instants, present only when the calendar is `known`. The client renders them in its own zone. */
  earliest?: string;
  expected?: string;
  latest?: string;
  clock: 'calendar';
  /** Whether a date exists at all (EE-5): false reads "unknown", never a date off an idle ratio. */
  calendar: 'known' | 'unknown';
  basis: EtaBasis;
  samples: number;
  missing: number;
  remainingPhases: number;
  remainingWeight: number;
  /** What the ETA measured, in working time, before the duty cycle stretched it. */
  workingLowMs: number;
  workingHighMs: number;
  duty: DutyCycle;
  /** Every assumption the date rests on, in the order applied. Rendered verbatim. */
  assumptions: string[];
  /** Zone-free, so it is safe to print anywhere: `~3–9 d on the calendar`, or `calendar time unknown`. */
  label: string;
};

/** A rounded percentage that never reads `0%` for a real, tiny fraction. */
function pct(ratio: number): string {
  const value = ratio * 100;
  if (value >= 10) return `${Math.round(value)}%`;
  if (value >= 1) return `${Math.round(value * 10) / 10}%`;
  return `${Math.round(value * 100) / 100}%`;
}

const DUTY_UNKNOWN_SENTENCE: Record<DutyUnknownReason, string> = {
  'too-few': 'fewer than three of this plan’s phases finished in the recent window, so nothing measures how it is being driven',
  'idle-history': 'the recent window is mostly idle time, and a pace that small describes a plan that sat, not one being driven',
  stale: 'no phase of this plan has finished in the last week, so there is no recent pace to project',
};

/**
 * When this plan finishes on the CALENDAR, and why you should or should not believe it.
 *
 * Null exactly when `etaFrom` is null — no remaining work, or no usable rate.
 * "Finishes today" on a finished plan is a units error, and this module inherits
 * that judgement rather than re-deciding it. With a duty cycle that is not
 * `known` it still answers, with `calendar: 'unknown'` and no dates: the working
 * estimate stands, the date does not exist, and the assumptions say why.
 */
export function forecastFrom(
  eta: EtaEstimate | null,
  duty: DutyCycle,
  now: Date | number,
): Forecast | null {
  if (!eta) return null;
  const at = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(at)) return null;

  const known = duty.known && duty.ratio > 0 && duty.ratio <= 1;
  const lowMs = known ? eta.lowMs / duty.ratio : eta.lowMs;
  const highMs = known ? eta.highMs / duty.ratio : eta.highMs;
  const midMs = (lowMs + highMs) / 2;
  const iso = (ms: number): string => new Date(at + ms).toISOString();

  const measured = `${eta.samples} measured ${eta.samples === 1 ? 'phase' : 'phases'} weighted`;
  const missing = eta.missing
    ? `; ${eta.missing} finished ${eta.missing === 1 ? 'phase has' : 'phases have'} no usable measurement and ${eta.missing === 1 ? 'is' : 'are'} not in it`
    : '';
  const assumptions = [
    `Rate: ${BASIS_CLAIM[eta.basis]} (${measured}${missing}).`,
    `Model: each phase takes ${humanMs(eta.floorMs)} plus ${Math.round(eta.slopeMsPerWeight)} ms per unit of weight `
      + 'of working time — a floor every session pays, then its size.',
    `Work left: ${eta.remainingWeight} weight across ${eta.remainingPhases} `
      + `${eta.remainingPhases === 1 ? 'phase' : 'phases'}, from each phase's size tag and any declared wall-clock floor.`,
    known
      ? `Duty cycle: ${pct(duty.ratio)} — measured over this plan’s newest ${duty.samples} completions, phases ran for `
        + `${humanMs(duty.workingMs)} of the ${humanMs(duty.elapsedMs)} between the first and last of them. Gates, `
        + 'review holds, parks and overnight gaps are inside that number; change how the plan is driven and it stops applying.'
      : `Duty cycle: unknown — ${DUTY_UNKNOWN_SENTENCE[duty.reason ?? 'too-few']}. There is no calendar date; the working `
        + 'estimate is the phases back to back, and the calendar will be later by however long the plan sits.',
    'Phases are assumed to run one after another. Concurrent lanes finish sooner than this.',
    'The band is the spread of the measured phases behind the rate around the model — where three in four of '
      + 'them fell — not a count of them.',
  ];

  return {
    ...(known ? { earliest: iso(lowMs), expected: iso(midMs), latest: iso(highMs) } : {}),
    clock: 'calendar',
    calendar: known ? 'known' : 'unknown',
    basis: eta.basis,
    samples: eta.samples,
    missing: eta.missing,
    remainingPhases: eta.remainingPhases,
    remainingWeight: eta.remainingWeight,
    workingLowMs: eta.lowMs,
    workingHighMs: eta.highMs,
    duty,
    assumptions,
    label: !known
      ? 'calendar time unknown'
      : lowMs === highMs
        ? `~${humanMs(highMs)} on the calendar`
        : `~${humanMs(lowMs)}–${humanMs(highMs)} on the calendar`,
  };
}

/** What each basis actually claims, for the assumptions list. Matches `client/features/insights/eta.tsx`. */
const BASIS_CLAIM: Record<EtaBasis, string> = {
  plan: 'this plan’s own measured phases, against the shape of every plan’s',
  portfolio: 'every plan’s newest measured phases — this one has none of its own yet',
  heuristic: 'the shipped shape — nothing has been measured anywhere, so this is a placeholder, not a forecast',
};
