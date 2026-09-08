/**
 * `/api/metrics` — the console's numbers in Prometheus text exposition format.
 *
 * Pure: facts in, one string out. No file is opened, no clock is read, nothing
 * is cached — `server/service-live.ts` assembles the facts from the same
 * `planStats` / `spendSummary` / `planCost` calls every page already uses, so a
 * scrape and a screen can never disagree about a number.
 *
 * ## The names are a CONTRACT
 *
 * The moment an operator points a scraper at this endpoint, every name and
 * label below is load-bearing: renaming one silently breaks their dashboards
 * and alerts, and a metric that changes meaning without changing name is worse
 * than one that disappears. So:
 *
 *   - **Never rename or repurpose a family.** Add a new one and leave the old
 *     one reporting what it always reported.
 *   - **Never add a label to an existing family.** Every label is part of a
 *     series' identity; adding one splits history at the upgrade.
 *   - `_total` means a COUNTER — monotonically non-decreasing for as long as
 *     the run files it is read from survive. Deleting a run file resets it, the
 *     one way this can go backwards, and `rate()` handles that as it handles
 *     any counter reset.
 *   - Everything else is a GAUGE and may move in either direction.
 *
 * The full family list, with what each one answers, is in `docs/metrics.md` —
 * and `viewer/test/metrics.test.ts` pins the names against this file so the
 * document cannot drift away from the endpoint.
 *
 * ## Cardinality
 *
 * Labelled by `slug`, never by run id: a run id is minted per boarding, so a
 * console driven for a year would mint thousands of dead series that a scraper
 * keeps forever. Per-plan is the granularity an operator asks questions at, and
 * a plan count is bounded by a directory somebody maintains by hand.
 *
 * ## Exposure
 *
 * Unauthenticated on `127.0.0.1`, exactly like every other read on this server
 * — the console binds to loopback and has no other posture to weaken. Nothing
 * here carries a note, a title, a path or an owner: a scrape is numbers and
 * slugs, which is what makes it safe to leave open on a laptop.
 */

import { BOARD_BUCKETS } from '../../shared/status-vocab.js';
import type { PhaseState } from '../engine.ts';

/** One plan, as the board sees it. A subset of `analysis/stats.ts` `PlanStats`. */
export type MetricsPlan = {
  slug: string;
  status?: string;
  closed: boolean;
  phases: number;
  done: number;
  ready: number;
  waiting: number;
  inProgress: number;
  stuck: number;
  remainingWeight: number;
  /** 0-100, as `planStats` reports it. Emitted as a 0-1 ratio, the Prometheus convention. */
  percent: number;
};

/** One run, already rolled up. */
export type MetricsRun = {
  slug: string;
  status: string;
  spentUsd: number;
  /** Sum of `PhaseRecord.attempts` over this run — sessions the console launched. */
  attempts: number;
  /** Sum of `PhaseRecord.durationMs` over this run, in seconds. */
  phaseSeconds: number;
};

/** Per-plan money, from `analysis/spend.ts` `planCost`. */
export type MetricsCost = {
  slug: string;
  totalUsd: number;
  attributedUsd: number;
  residualUsd: number;
  ladderUsd: number;
};

/**
 * One ISOLATED run's checkout load, from the runner's own git probe.
 *
 * Only a run with a checkout of its own contributes an entry — `runGit()`
 * answers `null` for every shared run — which is what makes the three families
 * below ABSENT rather than zero on a console that has never isolated anything.
 * That distinction is the point: `0` says "measured, and there are none",
 * absent says "nothing here measures this", and an alert written against the
 * first would fire forever on a console that means the second.
 */
export type MetricsGit = {
  slug: string;
  /** Console-managed checkouts of this plan's run, live ones only. */
  worktrees: number;
  /**
   * Bytes those checkouts occupy. ABSENT when `du` could not answer for any of
   * them — a machine without `du` reports no disk rather than none used.
   */
  diskBytes?: number;
  /** Distinct files named by this run's `conflicted` radar pairs. */
  conflictedFiles: number;
};

export type MetricsFacts = {
  plans: readonly MetricsPlan[];
  runs: readonly MetricsRun[];
  cost: readonly MetricsCost[];
  /** One entry per isolated run. Absent or empty ⇒ the three git families emit nothing. */
  git?: readonly MetricsGit[];
  /** Every ladder rung this console has recorded, for the tally. */
  rungs: readonly { rung: string; outcome?: string }[];
  /** Today's money — `spendSummary().today`. */
  today: { settledUsd: number; ladderUsd: number; capUsd: number | null };
  version?: string;
  instanceId?: string;
  /** How long assembling these facts took, in seconds. */
  scrapeSeconds?: number;
};

/**
 * The board states a phase can be in — the label values of
 * `phase_console_phases`.
 *
 * MEMBERS from `shared/status-vocab.js`'s `BOARD_BUCKETS` (the one owner);
 * only the EMISSION ORDER is decided here, because these become metric lines
 * and reordering them churns every scrape diff for no reason.
 */
const EMIT_RANK: Record<string, number> = {
  done: 0, ready: 1, 'in-progress': 2, waiting: 3, stuck: 4,
};
export const PHASE_STATES: readonly PhaseState[] = Object.freeze(
  [...BOARD_BUCKETS].sort((a, b) => (EMIT_RANK[a] ?? 99) - (EMIT_RANK[b] ?? 99)),
);

/**
 * Every family this endpoint emits, in the order it emits them.
 *
 * Exported because it IS the contract: `test/metrics.test.ts` asserts the
 * rendered text carries exactly these families and no others, so a family
 * added without a line here — or a line added without an emitter — fails.
 */
export const METRIC_FAMILIES: readonly (readonly [string, 'gauge' | 'counter', string])[] = [
  ['phase_console_build_info', 'gauge', 'Console version and instance, always 1.'],
  ['phase_console_scrape_duration_seconds', 'gauge', 'Seconds spent assembling this response.'],
  ['phase_console_plans', 'gauge', 'Plans, by plan status and whether the operator has closed them.'],
  ['phase_console_phases', 'gauge', 'Phases per plan, by board state.'],
  ['phase_console_plan_progress_ratio', 'gauge', 'Done phases over total phases, 0 to 1.'],
  ['phase_console_plan_remaining_weight', 'gauge', 'Unfinished phase weight, in the plan sizing units.'],
  ['phase_console_runs', 'gauge', 'Autopilot runs per plan, by run status.'],
  ['phase_console_phase_attempts_total', 'counter', 'Sessions the console has launched for a plan.'],
  ['phase_console_phase_seconds_total', 'counter', 'Wall-clock seconds phases of a plan have run for.'],
  ['phase_console_spend_usd_total', 'counter', 'USD every session of a plan has cost (the run total).'],
  ['phase_console_phase_spend_usd_total', 'counter', 'USD attributed to a numbered phase of a plan.'],
  ['phase_console_spend_residual_usd', 'gauge',
    'Run total minus what is attributed to phases. Non-zero means a run file disagrees with itself.'],
  ['phase_console_ladder_spend_usd_total', 'counter',
    'USD the remediation ladder was charged on a plan. A SUBSET of the run total.'],
  ['phase_console_ladder_rungs_total', 'counter', 'Ladder rungs climbed, by rung and how each ended.'],
  ['phase_console_settled_usd_today', 'gauge',
    "USD settled by phases that ended today, in the operator's zone."],
  ['phase_console_ladder_usd_today', 'gauge',
    'USD the ladder was charged today - the figure the day cap refuses a rung against.'],
  ['phase_console_day_cap_usd', 'gauge', "The ladder's per-day USD cap. Absent when no cap is set."],
  // Appended at the END rather than grouped with the other per-plan gauges: the
  // emission order is a scrape's line order, and reordering it churns every
  // diff of a saved scrape for no gain. All three are absent — not zero — on a
  // console with no isolated run.
  ['phase_console_worktrees', 'gauge',
    'Console-managed checkouts a plan\'s isolated run holds. Absent when no isolated run exists.'],
  ['phase_console_worktree_disk_bytes', 'gauge',
    'Bytes those checkouts occupy. Absent where du could not answer.'],
  ['phase_console_branch_conflicted_files', 'gauge',
    'Files a plan\'s run branch already conflicts on with another live branch.'],
];

/**
 * A label value, escaped as the exposition format requires.
 *
 * Backslash, double quote and newline are the three characters that can end a
 * label early and turn the rest of the line into something a parser will refuse
 * — and a plan slug comes off a filesystem, so none of them is impossible.
 */
export function escapeLabel(value: string): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

/**
 * A sample value.
 *
 * A non-finite number is DROPPED by the caller rather than printed: Prometheus
 * accepts `NaN`, but a NaN in a dashboard is indistinguishable from a broken
 * query, and every quantity here has an honest zero.
 */
function num(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e6) / 1e6);
}

type Sample = { labels?: Record<string, string>; value: number };

/** One family: its HELP, its TYPE, and its samples. Emits nothing at all when it has none. */
function family(name: string, type: string, help: string, samples: Sample[]): string[] {
  const usable = samples.filter((s) => Number.isFinite(s.value));
  if (!usable.length) return [];
  const lines = [`# HELP ${name} ${help.replace(/\n/g, ' ')}`, `# TYPE ${name} ${type}`];
  for (const sample of usable) {
    const pairs = Object.entries(sample.labels ?? {})
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}="${escapeLabel(String(v))}"`);
    lines.push(`${name}${pairs.length ? `{${pairs.join(',')}}` : ''} ${num(sample.value)}`);
  }
  return lines;
}

/** Tally a list into `key -> count`, sorted by key so a scrape is byte-stable. */
function tally<T>(list: readonly T[], key: (item: T) => string): [string, number][] {
  const counts = new Map<string, number>();
  for (const item of list) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** Sum a per-plan quantity, one entry per slug that has any, slug-sorted. */
function bySlug<T>(list: readonly T[], slug: (item: T) => string, value: (item: T) => number): Sample[] {
  const sums = new Map<string, number>();
  for (const item of list) sums.set(slug(item), (sums.get(slug(item)) ?? 0) + value(item));
  return [...sums.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, total]) => ({ labels: { slug: name }, value: total }));
}

/** Index into `METRIC_FAMILIES` by name, so an emitter cannot drift from its own HELP text. */
function help(name: string): string {
  const row = METRIC_FAMILIES.find(([id]) => id === name);
  if (!row) throw new Error(`metrics: ${name} has no METRIC_FAMILIES entry`);
  return row[2];
}

/**
 * The whole response body.
 *
 * Deterministic: every list is sorted, so two scrapes of an unchanged console
 * are byte-identical and a diff of them is a diff of the console's state.
 * Ends with a newline, which the format requires and which a `curl` without
 * one makes very annoying to read.
 */
export function renderMetrics(facts: MetricsFacts): string {
  const plans = facts?.plans ?? [];
  const runs = facts?.runs ?? [];
  const cost = facts?.cost ?? [];
  const rungs = facts?.rungs ?? [];
  const today = facts?.today ?? { settledUsd: 0, ladderUsd: 0, capUsd: null };
  const out: string[] = [];
  const emit = (name: string, type: 'gauge' | 'counter', samples: Sample[]): void => {
    out.push(...family(name, type, help(name), samples));
  };

  emit('phase_console_build_info', 'gauge', [{
    labels: { version: facts?.version ?? 'unknown', instance: facts?.instanceId ?? 'unknown' },
    value: 1,
  }]);

  if (typeof facts?.scrapeSeconds === 'number') {
    emit('phase_console_scrape_duration_seconds', 'gauge', [{ value: facts.scrapeSeconds }]);
  }

  emit('phase_console_plans', 'gauge',
    tally(plans, (p) => `${p.status ?? 'unknown'} ${p.closed ? '1' : '0'}`).map(([key, count]) => {
      const [status, closed] = key.split(' ');
      return { labels: { status: status ?? 'unknown', closed: closed ?? '0' }, value: count };
    }));

  const sorted = [...plans].sort((a, b) => a.slug.localeCompare(b.slug));

  emit('phase_console_phases', 'gauge',
    sorted.flatMap((p) => PHASE_STATES.map((state) => ({
      labels: { slug: p.slug, state },
      value: state === 'done' ? p.done
        : state === 'ready' ? p.ready
        : state === 'in-progress' ? p.inProgress
        : state === 'waiting' ? p.waiting
        : p.stuck,
    }))));

  emit('phase_console_plan_progress_ratio', 'gauge',
    sorted.map((p) => ({ labels: { slug: p.slug }, value: p.phases > 0 ? p.done / p.phases : 0 })));
  emit('phase_console_plan_remaining_weight', 'gauge',
    sorted.map((p) => ({ labels: { slug: p.slug }, value: p.remainingWeight })));

  emit('phase_console_runs', 'gauge',
    tally(runs, (r) => `${r.slug} ${r.status}`).map(([key, count]) => {
      const [slug, status] = key.split(' ');
      return { labels: { slug: slug ?? '', status: status ?? 'unknown' }, value: count };
    }));

  emit('phase_console_phase_attempts_total', 'counter', bySlug(runs, (r) => r.slug, (r) => r.attempts));
  emit('phase_console_phase_seconds_total', 'counter', bySlug(runs, (r) => r.slug, (r) => r.phaseSeconds));

  emit('phase_console_spend_usd_total', 'counter', bySlug(cost, (c) => c.slug, (c) => c.totalUsd));
  emit('phase_console_phase_spend_usd_total', 'counter', bySlug(cost, (c) => c.slug, (c) => c.attributedUsd));
  emit('phase_console_spend_residual_usd', 'gauge', bySlug(cost, (c) => c.slug, (c) => c.residualUsd));
  emit('phase_console_ladder_spend_usd_total', 'counter', bySlug(cost, (c) => c.slug, (c) => c.ladderUsd));

  emit('phase_console_ladder_rungs_total', 'counter',
    tally(rungs, (r) => `${r.rung} ${r.outcome ?? 'running'}`).map(([key, count]) => {
      const [rung, outcome] = key.split(' ');
      return { labels: { rung: rung ?? 'unknown', outcome: outcome ?? 'running' }, value: count };
    }));

  emit('phase_console_settled_usd_today', 'gauge', [{ value: today.settledUsd }]);
  emit('phase_console_ladder_usd_today', 'gauge', [{ value: today.ladderUsd }]);
  // Absent, not zero: no cap set and a cap of zero are opposite facts, and a
  // zero here would alert as "the ladder can never spend again". ONE decision
  // point on purpose — a redundant `typeof` guard upstream of the non-finite
  // filter would be a rule no test could prove is doing anything.
  emit('phase_console_day_cap_usd', 'gauge', today.capUsd == null ? [] : [{ value: today.capUsd }]);

  // The isolated runs' checkout load. `bySlug` is not used: these are per-run
  // measurements of a directory, not sums of a per-run quantity, and two runs
  // of one plan cannot both hold the plan's managed trees.
  const git = [...(facts?.git ?? [])].sort((a, b) => a.slug.localeCompare(b.slug));
  emit('phase_console_worktrees', 'gauge',
    git.map((entry) => ({ labels: { slug: entry.slug }, value: entry.worktrees })));
  // A `du` that could not answer is DROPPED by the non-finite filter in
  // `family()`, one slug at a time: a console where one checkout is unmeasurable
  // still reports the others rather than losing the family.
  emit('phase_console_worktree_disk_bytes', 'gauge',
    git.map((entry) => ({ labels: { slug: entry.slug }, value: entry.diskBytes ?? NaN })));
  emit('phase_console_branch_conflicted_files', 'gauge',
    git.map((entry) => ({ labels: { slug: entry.slug }, value: entry.conflictedFiles })));

  return `${out.join('\n')}\n`;
}

/** What `Content-Type` a Prometheus scraper expects. */
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
