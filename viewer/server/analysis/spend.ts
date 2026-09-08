/**
 * What this console has spent — the day's money, each run against its budget,
 * and a week of history. Pure: files in, numbers out, and the clock is an
 * argument.
 *
 * Read by `server/service.ts` (`spendSummary`, behind `GET /api/spend`, whose
 * answer the client's `client/src/lib/api/spend.ts` `SpendView` already names
 * field for field) and by the two callers of `runner/ladder.ts` `nextRung` —
 * `server/runner/runner.ts` (`Runner.climb`) and `server/service.ts`
 * (`maybeAutoRecover`) — which need `rungsToday` for the `dayHistory` the
 * per-day cap counts. Pinned by `test/spend.test.ts`.
 *
 * It takes a STRUCTURAL slice of a run file rather than importing the runner's
 * own `RunState`, the same way `analysis/stats.ts` takes `RunView`: this module
 * reads records that have already landed on disk, never the loop that is
 * writing them. Nothing here opens a file, nothing here reads a clock — a
 * summary you can only produce by being the live console is a summary nobody
 * can test.
 *
 * ## Days are LOCAL days here, and that is a deliberate break
 *
 * Every other day key in this tree is `toISOString().slice(0, 10)` — a UTC day
 * (`analysis/stats.ts`, `client/src/lib/format.ts`, `client/src/components/
 * charts.tsx`). That is fine for a heat-map of activity and wrong for money:
 * "today's ladder budget is spent" is a sentence about the operator's day, and
 * an operator seven hours west of UTC watches their cap reset in the middle of
 * the afternoon and their evening's spend land on tomorrow. So `dayKey` here
 * formats in a real time zone (the host's, unless one is named) and everything
 * downstream — `rungsToday`, the seven buckets, the cap comparison — agrees
 * with it. A client rendering `series[].day` must print the key it was GIVEN
 * rather than re-deriving one from a timestamp, or the chart and the header
 * will disagree about which day it is.
 *
 * ## What is real, and what is honestly zero
 *
 * `runs[].spentUsd` / `budgetUsd` are exact: the runner adds every session's
 * `total_cost_usd` to `RunState.spentUsd` the moment the spawn resolves, and
 * `runBudgetUsd` already reflects the one auto-raise.
 *
 * `settledUsd` is an approximation with a name: it sums `PhaseRecord.costUsd`
 * on the day the phase ENDED. That figure is cumulative over every attempt and
 * every session kind on the phase, so a phase begun Monday and finished
 * Wednesday books all of its money on Wednesday, and a phase retried on Friday
 * re-books its whole history on Friday (`resetForRetry` clears `endedAt` and
 * deliberately keeps `costUsd`). The exact alternative is replaying each run's
 * journal by entry `time`, which is one `Journal.read()` per run — the very
 * per-plan read `etaPool` grew a cache to avoid. A live phase contributes
 * nothing until it lands, which is why the contract's field is `settledUsd`
 * and not `spentUsd`.
 *
 * `ladderUsd` is real money for the rungs the RUNNER drives, and structurally
 * zero for the rest — the split is worth knowing before reading the number.
 * `accountRung` still opens a rung with no cost, because what a rung costs is
 * not knowable when it is climbed. The cost arrives later: `runner/ladder.ts`
 * `chargeRung` adds each attempt's own `outcome.costUsd` to the newest OPEN
 * rung as that attempt ends — `runner/runner-attempt.ts` (the phase attempt
 * and the closeout), `runner/runner-loop.ts` (the PR session) and
 * `runner/runner-control.ts` (an instructed resume) — and it is a no-op unless
 * the ladder is what reboarded the phase, so an ordinary first boarding is not
 * charged to anything. That is why the dollar caps in `nextRung` now have a
 * column to sum, and why `ladderPerDayUsd` can refuse a rung, which it never
 * could before.
 *
 * What is still zero is everything the runner did not spawn. `Runner.climb`
 * accounts a rung and never settles it; the service's healer
 * (`service-recovery.ts`) settles the OUTCOME only and passes `undefined` for
 * cost at every one of its call sites — deliberately, because the one site
 * that used to pass money passed `PhaseRecord.costUsd`, a CUMULATIVE figure
 * that would re-book a phase's whole history every time it climbed again. And
 * a rung whose vehicle is a briefed pty agent is never charged at all, for the
 * reason the next paragraph gives. So the number this module returns is still
 * the true sum of what is recorded, and nothing here invents one — it is just
 * no longer the case that nothing is recorded.
 *
 * And a day figure built from run files is RUNNER spend only. QA sessions, the
 * plan wizard, the agent-vehicle rungs and operator terminals all run through
 * `server/agent.ts` / `server/terminal.ts` as ptys, which never see a
 * `total_cost_usd`. Money the console spends that way is recorded nowhere and
 * therefore appears nowhere here.
 */

import { overDayCap as sharedOverDayCap } from '../../shared/ladder-model.js';
import type { RungOutcome } from '../../shared/run-lifecycle.js';

/** A `YYYY-MM-DD` local-day key, as produced by `dayKey`. */
export type DayKey = string;

/**
 * One rung as it sits in a run file (`runner/state.ts` `RungRecord`), spelled
 * out structurally so this module imports nothing from the loop. The shape is
 * an exact mirror, so what `rungsToday` returns is assignable straight into
 * `nextRung`'s `dayHistory`.
 */
export type RungView = {
  situation: string;
  rung: string;
  at: string;
  params?: Record<string, string | number | boolean>;
  costUsd?: number;
  outcome?: RungOutcome;
  note?: string;
};

/**
 * The phase slice of a run file. `spendSummary` reads only the first two; the
 * rest are `planCost`'s, kept in one type so a reader never has to ask which of
 * two overlapping shapes a run record satisfies.
 */
export type PhaseCostRecordView = {
  costUsd?: number;
  endedAt?: string;
  attempts?: number;
  durationMs?: number;
  status?: string;
  model?: string;
  actualModel?: string;
  costUnknown?: boolean;
};

/** The slice of a run file this module reads. Everything optional: old run files predate most of it. */
export type SpendRunView = {
  id: string;
  slug: string;
  spentUsd?: number;
  runBudgetUsd?: number | null;
  updatedAt?: string;
  phases?: Record<string, PhaseCostRecordView | undefined>;
  recoveries?: Record<string, { rungs?: readonly RungView[] } | undefined>;
};

export type SpendFacts = {
  /** Every run under this instance the caller is willing to account for — `listRuns` across every slug. */
  runs: readonly SpendRunView[];
  /**
   * `ladderCaps(prefs).perDayUsd`. Absent or unusable means no cap is set and
   * the view says `null`. Zero is NOT null: a per-day cap of zero is what an
   * operator who wants the ladder to spend nothing sets, and `nextRung` refuses
   * at `>= 0` accordingly, so it is passed through as the number it is.
   */
  capUsd?: number | null;
  /** IANA zone for the day boundary. Absent = this host's zone. */
  tz?: string;
  /** How many buckets the series carries, today last. Default 7. */
  days?: number;
};

/** Exactly `client/src/lib/api/spend.ts` `SpendView`. Do not add a field here without changing that file. */
export type SpendView = {
  today: { settledUsd: number; ladderUsd: number; capUsd: number | null };
  runs: { runId: string; slug: string; spentUsd: number; budgetUsd: number | null }[];
  series: { day: DayKey; settledUsd: number; ladderUsd: number }[];
};

const DAY = 86_400_000;

/** The default width of the history: a week, because a week is what a cap is felt over. */
export const SERIES_DAYS = 7;

/**
 * Money, the way `ladder.ts` `usd` counts it: a missing or unreadable figure is
 * zero, never a refusal. A cap must never trip on a number nobody wrote.
 */
const money = (value: unknown): number =>
  (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Cents. Sub-cent float dust is not a spend figure, and `$0.30000000000000004` is not a number to show anyone. */
const cents = (value: number): number => Math.round(value * 100) / 100;

const millis = (value: Date | number | string): number | null => {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * The local-midnight day key — `2026-08-22` — for an instant, in `tz` or in
 * this host's own zone.
 *
 * `Intl` rather than arithmetic because the offset is not a constant: an hour
 * that does not exist and an hour that happens twice are both real days on the
 * calendar, and only the zone database knows where they are. An instant that
 * cannot be read at all returns the empty key, which matches no bucket and
 * sums into nothing — this module never throws at a bad timestamp in a file it
 * did not write.
 */
export function dayKey(date: Date | number | string, tz?: string): DayKey {
  const ms = millis(date);
  if (ms === null) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    ...(tz ? { timeZone: tz } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  if (!year || !month || !day) return '';
  return `${year.padStart(4, '0')}-${month}-${day}`;
}

/**
 * `days` day keys ending at `key`, oldest first.
 *
 * Calendar arithmetic on the key itself, anchored at noon UTC — the trick
 * `stats.ts` `weeklyBuckets` uses. Stepping by 86.4M milliseconds through a
 * zone would skip or repeat a day twice a year; stepping through midday of a
 * date has no such hour to fall into, and the zone has already done its work
 * by the time a key exists.
 */
export function dayKeysEndingAt(key: DayKey, days: number): DayKey[] {
  const anchor = Date.parse(`${key}T12:00:00Z`);
  const width = Number.isFinite(days) && days > 0 ? Math.floor(days) : SERIES_DAYS;
  if (!Number.isFinite(anchor)) return [];
  const keys: DayKey[] = [];
  for (let i = width - 1; i >= 0; i--) {
    keys.push(new Date(anchor - i * DAY).toISOString().slice(0, 10));
  }
  return keys;
}

/**
 * Every rung this console climbed today, across every run — the `dayHistory`
 * the per-day cap counts, which neither `Runner.climb` nor `maybeAutoRecover`
 * passes today, which is why `ladderPerDayUsd` has never refused anything.
 *
 * Oldest first, and the records are handed back UNTOUCHED: `nextRung` does its
 * own exact summing, so nothing here rounds a number the cap will compare.
 * Rungs with no cost are still returned — the per-day cap is dollars, but a
 * reader counting attempts wants the whole day.
 */
export function rungsToday(
  runs: readonly SpendRunView[],
  now: Date | number,
  tz?: string,
): RungView[] {
  // One clock read for the whole pass. A key computed per record is a key that
  // can change halfway down a long list, at exactly the moment it matters.
  const today = dayKey(now, tz);
  if (!today) return [];
  const rungs: RungView[] = [];
  for (const run of runs ?? []) {
    for (const slot of Object.values(run?.recoveries ?? {})) {
      for (const rung of slot?.rungs ?? []) {
        if (!rung || typeof rung.at !== 'string') continue;
        if (dayKey(rung.at, tz) !== today) continue;
        rungs.push(rung);
      }
    }
  }
  return rungs.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Has today's ladder spend reached the cap?
 *
 * The definition moved to `shared/ladder-model.js` and is re-exported here so
 * every existing caller keeps its import: the CLIENT has to ask this question
 * too — three of its surfaces asked it and got it wrong, adding settled run
 * spend to a cap that only ever counted the ladder — and a predicate two
 * layers must agree on is not a server detail.
 */
export function overDayCap(today: SpendView['today']): boolean {
  return sharedOverDayCap(today);
}

/** Sum a run's phase costs onto the day each phase ended. */
function settledByDay(runs: readonly SpendRunView[], tz: string | undefined, into: Map<DayKey, number>): void {
  for (const run of runs ?? []) {
    for (const record of Object.values(run?.phases ?? {})) {
      // No end time is no day: a phase still in flight has spent money that
      // belongs to no date yet, and guessing one is how a live run's cost
      // appears twice.
      if (!record?.endedAt) continue;
      const cost = money(record.costUsd);
      if (!cost) continue;
      const key = dayKey(record.endedAt, tz);
      if (!key) continue;
      into.set(key, (into.get(key) ?? 0) + cost);
    }
  }
}

/**
 * Today's money against the day cap, each run against its budget, and a week
 * of history — the whole `SpendView`, in one pass over the run files.
 *
 * `runs` carries a run when it has spent something or was touched today; a
 * finished run that cost nothing is not a fact about spending, and a console
 * that has driven two hundred runs should not answer with two hundred rows.
 * Ordered by what it cost, descending, because the question this table is
 * opened to answer is which run is eating the budget.
 */
export function spendSummary(facts: SpendFacts, now: Date | number): SpendView {
  const tz = facts?.tz;
  const runs = facts?.runs ?? [];
  const today = dayKey(now, tz);
  const keys = dayKeysEndingAt(today, facts?.days ?? SERIES_DAYS);

  const settled = new Map<DayKey, number>();
  settledByDay(runs, tz, settled);

  const ladder = new Map<DayKey, number>();
  for (const run of runs) {
    for (const slot of Object.values(run?.recoveries ?? {})) {
      for (const rung of slot?.rungs ?? []) {
        const cost = money(rung?.costUsd);
        if (!cost) continue;
        const key = dayKey(rung.at, tz);
        if (!key) continue;
        ladder.set(key, (ladder.get(key) ?? 0) + cost);
      }
    }
  }

  const capUsd =
    typeof facts?.capUsd === 'number' && Number.isFinite(facts.capUsd) && facts.capUsd >= 0
      ? facts.capUsd
      : null;

  const rows = runs
    .filter((run) => run && typeof run.id === 'string')
    .filter((run) => money(run.spentUsd) > 0 || (run.updatedAt ? dayKey(run.updatedAt, tz) === today : false))
    .map((run) => ({
      runId: run.id,
      slug: typeof run.slug === 'string' ? run.slug : '',
      spentUsd: cents(money(run.spentUsd)),
      budgetUsd:
        typeof run.runBudgetUsd === 'number' && Number.isFinite(run.runBudgetUsd) ? run.runBudgetUsd : null,
    }))
    .sort((a, b) => b.spentUsd - a.spentUsd || a.runId.localeCompare(b.runId));

  return {
    today: {
      settledUsd: cents(settled.get(today) ?? 0),
      ladderUsd: cents(ladder.get(today) ?? 0),
      capUsd,
    },
    runs: rows,
    // Every day present, empty ones as zeros: a gap in a bar chart reads as
    // missing data, and "nothing was spent on Sunday" is data.
    series: keys.map((day) => ({
      day,
      settledUsd: cents(settled.get(day) ?? 0),
      ladderUsd: cents(ladder.get(day) ?? 0),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Per-plan attribution — what a plan cost, phase by phase
 * ------------------------------------------------------------------ */

/**
 * ## Where a plan's money actually is, and why the total has to be checked
 *
 * Every site that ends a session books the same dollars three times, on
 * purpose: `state.spentUsd += cost` (the RUN's total), `record.costUsd += cost`
 * (the PHASE's), and `chargeRung(...)` (the ladder rung that caused the
 * attempt, when one did). Four sites do it — `runner-attempt.ts` twice (the
 * phase attempt and the closeout), `runner-loop.ts` (the PR session) and
 * `runner-control.ts` (an instructed resume) — and all four pair the first two.
 *
 * So in a healthy run `Σ phases[].costUsd` EQUALS `run.spentUsd`, and the
 * ladder figure is a **subset of both**, never a third column to add on. That
 * identity is the reason this module reports `residualUsd` rather than an
 * "unattributed" category: a non-zero residual is not a kind of spending, it is
 * the evidence that a run file disagrees with itself (a record dropped, a file
 * written by an older build, a hand-edit). Presenting it as a category would
 * make a defect look like a budget line.
 *
 * The per-phase figure is CUMULATIVE over attempts within a run — `resetForRetry`
 * clears `endedAt` and deliberately keeps `costUsd` — and summed across runs,
 * because a phase re-boarded under a second run spent real money twice.
 * `costUnknown` rides along as `partial`: the session ran and its spend was
 * never harvested, so the figure is a floor and every surface must say so
 * rather than printing `$0.00` over hours of work.
 */

/** The slice of a run file the per-plan attribution reads. A superset of `SpendRunView`. */
export type PlanCostRunView = SpendRunView & {
  status?: string;
  model?: string;
  createdAt?: string;
};

/** One phase's money, rolled up across every run of the plan. */
export type PhaseCost = {
  phase: number;
  /** Cumulative across attempts and across runs. */
  usd: number;
  attempts: number;
  /** The recorded cost is a FLOOR — some contributing session's spend was never harvested. */
  partial: boolean;
  durationMs: number;
  /**
   * The last model recorded for this phase (`actualModel` before `model`, then
   * the run's own). A phase that fell back mid-run books all of its money to
   * the model it ENDED on: the records keep one name, not a per-attempt list.
   */
  model?: string;
  status?: string;
  endedAt?: string;
  /** How many runs contributed money to this phase. */
  runs: number;
};

export type PlanCostFacts = {
  slug: string;
  /** Every run of THIS plan. */
  runs: readonly PlanCostRunView[];
  /** IANA zone for the day boundary — the same operator-day rule as `spendSummary`. */
  tz?: string;
};

export type PlanCostView = {
  slug: string;
  /** Σ `run.spentUsd` — every session the runner spawned for this plan. The headline. */
  totalUsd: number;
  /** Σ `phases[].costUsd` — the part that belongs to a numbered phase. */
  attributedUsd: number;
  /**
   * `totalUsd − attributedUsd`. Zero in a healthy run (see the note above); a
   * non-zero value is a reconciliation FAULT, not a spending category.
   */
  residualUsd: number;
  /** What the remediation ladder was charged on this plan's runs — a SUBSET of `totalUsd`. */
  ladderUsd: number;
  /** Phases whose recorded cost is known-incomplete, ascending. */
  partialPhases: number[];
  /** Most expensive first — the question this table is opened to answer. */
  phases: PhaseCost[];
  byModel: { model: string; usd: number; phases: number }[];
  /** Contiguous days, oldest first, zeros included. Truncated to the newest `MAX_COST_DAYS`. */
  byDay: { day: DayKey; usd: number }[];
  /** True when `byDay` dropped older buckets to fit the cap — never truncate silently. */
  byDayTruncated: boolean;
  runs: { runId: string; spentUsd: number; budgetUsd: number | null; status?: string }[];
};

/**
 * The widest daily history a plan's cost chart carries.
 *
 * A plan open for a year would otherwise return 365 buckets to draw a sparkline
 * nobody can read. The cap keeps the NEWEST days and sets `byDayTruncated`, so
 * a reader is told the series is a window rather than the whole life of the plan.
 */
export const MAX_COST_DAYS = 90;

/** The model a phase's money should be booked to: what it actually ran on, else what it was told to run on. */
function modelOf(
  record: { model?: string; actualModel?: string } | undefined,
  run: { model?: string } | undefined,
): string | undefined {
  return record?.actualModel || record?.model || run?.model || undefined;
}

/**
 * What one plan cost — the whole `PlanCostView`, in one pass over its run files.
 *
 * Pure, like everything else here: no file is opened, no clock is read. The
 * caller hands over the runs it is willing to account for, which for the
 * console is `listRuns(root, slug, liveRunId)`.
 */
export function planCost(facts: PlanCostFacts): PlanCostView {
  const tz = facts?.tz;
  const runs = facts?.runs ?? [];

  let totalUsd = 0;
  let ladderUsd = 0;
  const byPhase = new Map<number, PhaseCost>();
  const byModel = new Map<string, { usd: number; phases: Set<number> }>();
  const byDay = new Map<DayKey, number>();

  for (const run of runs) {
    if (!run || typeof run.id !== 'string') continue;
    totalUsd += money(run.spentUsd);

    for (const [key, record] of Object.entries(run.phases ?? {})) {
      const phase = Number(key);
      if (!Number.isInteger(phase) || !record) continue;
      const detail: PhaseCostRecordView = record;
      const cost = money(detail.costUsd);
      const attempts = money(detail.attempts);
      const partial = detail.costUnknown === true;
      // A record that cost nothing, ran nothing and is not marked incomplete is
      // not evidence about money — it is a phase that has not started. Keeping
      // it would put a row of zeros above the phases somebody opened this to see.
      if (!cost && !attempts && !partial) continue;

      const prev = byPhase.get(phase);
      const model = modelOf(detail, run);
      const endedAt = detail.endedAt;
      const next: PhaseCost = {
        phase,
        usd: (prev?.usd ?? 0) + cost,
        attempts: (prev?.attempts ?? 0) + attempts,
        partial: (prev?.partial ?? false) || partial,
        durationMs: (prev?.durationMs ?? 0) + money(detail.durationMs),
        // The NEWEST record wins for the descriptive fields — a phase retried
        // under a later run is described by that attempt, not its first.
        ...(model || prev?.model ? { model: (endedAt ?? '') >= (prev?.endedAt ?? '') ? (model ?? prev?.model) : prev?.model } : {}),
        ...(detail.status || prev?.status
          ? { status: (endedAt ?? '') >= (prev?.endedAt ?? '') ? (detail.status ?? prev?.status) : prev?.status }
          : {}),
        ...(endedAt || prev?.endedAt
          ? { endedAt: (endedAt ?? '') >= (prev?.endedAt ?? '') ? (endedAt ?? prev?.endedAt) : prev?.endedAt }
          : {}),
        runs: (prev?.runs ?? 0) + (cost ? 1 : 0),
      };
      byPhase.set(phase, next);

      if (cost && model) {
        const slot = byModel.get(model) ?? { usd: 0, phases: new Set<number>() };
        slot.usd += cost;
        slot.phases.add(phase);
        byModel.set(model, slot);
      }
      // Same convention as `settledByDay`: money lands on the day the phase
      // ENDED, and a phase still in flight belongs to no date yet. ONE decision
      // point: `dayKey` already answers the empty key for an instant it cannot
      // read, and a missing `endedAt` is exactly that case — a second `endedAt`
      // guard in front of it would be a rule no test could prove is doing
      // anything.
      const day = cost ? dayKey(endedAt ?? '', tz) : '';
      if (day) byDay.set(day, (byDay.get(day) ?? 0) + cost);
    }

    for (const slot of Object.values(run.recoveries ?? {})) {
      for (const rung of slot?.rungs ?? []) ladderUsd += money(rung?.costUsd);
    }
  }

  const phases = [...byPhase.values()]
    .map((p) => ({ ...p, usd: cents(p.usd) }))
    .sort((a, b) => b.usd - a.usd || a.phase - b.phase);
  const attributedUsd = [...byPhase.values()].reduce((sum, p) => sum + p.usd, 0);

  const days = [...byDay.keys()].sort();
  const filled = days.length
    ? dayRange(days[0]!, days[days.length - 1]!).map((day) => ({ day, usd: cents(byDay.get(day) ?? 0) }))
    : [];
  const byDayTruncated = filled.length > MAX_COST_DAYS;

  return {
    slug: typeof facts?.slug === 'string' ? facts.slug : '',
    totalUsd: cents(totalUsd),
    attributedUsd: cents(attributedUsd),
    // Rounded from the rounded pair, so the three numbers a reader sees add up.
    residualUsd: cents(cents(totalUsd) - cents(attributedUsd)),
    ladderUsd: cents(ladderUsd),
    partialPhases: phases.filter((p) => p.partial).map((p) => p.phase).sort((a, b) => a - b),
    phases,
    byModel: [...byModel.entries()]
      .map(([model, slot]) => ({ model, usd: cents(slot.usd), phases: slot.phases.size }))
      .sort((a, b) => b.usd - a.usd || a.model.localeCompare(b.model)),
    byDay: byDayTruncated ? filled.slice(-MAX_COST_DAYS) : filled,
    byDayTruncated,
    runs: runs
      .filter((run) => run && typeof run.id === 'string')
      .map((run) => ({
        runId: run.id,
        spentUsd: cents(money(run.spentUsd)),
        budgetUsd:
          typeof run.runBudgetUsd === 'number' && Number.isFinite(run.runBudgetUsd) ? run.runBudgetUsd : null,
        ...(typeof run.status === 'string' ? { status: run.status } : {}),
      }))
      .sort((a, b) => b.spentUsd - a.spentUsd || a.runId.localeCompare(b.runId)),
  };
}

/**
 * Every day key from `from` to `to` inclusive, oldest first.
 *
 * The same noon-UTC anchor `dayKeysEndingAt` uses, for the same reason: stepping
 * through midday of a date has no missing or repeated hour to fall into.
 */
function dayRange(from: DayKey, to: DayKey): DayKey[] {
  const start = Date.parse(`${from}T12:00:00Z`);
  const end = Date.parse(`${to}T12:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const keys: DayKey[] = [];
  for (let at = start; at <= end; at += DAY) keys.push(new Date(at).toISOString().slice(0, 10));
  return keys;
}
