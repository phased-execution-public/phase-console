/**
 * What the console spent, and which day it spent it on.
 *
 * Two things are pinned here that a spend figure gets wrong quietly. The first
 * is the day boundary: every other day key in this tree is a UTC day, and a
 * money figure that resets at UTC midnight tells an operator nine hours east
 * that their evening's work happened tomorrow — so `dayKey` formats in a real
 * zone, and the fixtures below are timestamps that fall on DIFFERENT days
 * depending on which of the two you pick. The second is honesty: `ladderUsd`
 * reads $0.00 because nothing in the runner records what a rung cost, and the
 * test says so out loud, because the day it stops reading zero must be the day
 * somebody wrote the number down, not the day somebody invented one.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_COST_DAYS, SERIES_DAYS, dayKey, dayKeysEndingAt, overDayCap, planCost, rungsToday, spendSummary,
  type SpendRunView,
} from '../server/analysis/spend.ts';
import { nextRung } from '../server/runner/ladder.ts';

/** Tokyo is UTC+9 all year: a clean boundary with no DST to argue about. */
const TZ = 'Asia/Tokyo';

/** 2026-08-22 11:00 in Tokyo — comfortably mid-morning, comfortably still the 21st in UTC. */
const NOW = new Date('2026-08-22T02:00:00Z');

/** Local midnight in Tokyo is 15:00Z the day before; these two minutes straddle it. */
const JUST_BEFORE = '2026-08-21T14:59:00Z';
const JUST_AFTER = '2026-08-21T15:01:00Z';

const rung = (at: string, costUsd?: number) => ({
  situation: 'work-in-progress',
  rung: 'resume-own-session',
  at,
  ...(costUsd === undefined ? {} : { costUsd }),
});

/* ------------------------------------------------------------------ *
 * dayKey
 * ------------------------------------------------------------------ */

test('the day key is the operator\'s day, not UTC\'s — the same instant lands on two different dates', () => {
  assert.equal(dayKey(JUST_BEFORE, TZ), '2026-08-21');
  assert.equal(dayKey(JUST_AFTER, TZ), '2026-08-22');
  // Both are the 21st in UTC. If this module had used `toISOString().slice(0, 10)`
  // like every other day key in the tree, the two would be indistinguishable.
  assert.equal(dayKey(JUST_BEFORE, 'UTC'), '2026-08-21');
  assert.equal(dayKey(JUST_AFTER, 'UTC'), '2026-08-21');
});

test('a zone with DST keeps its 25-hour day whole', () => {
  // 2026-11-01, America/New_York: the clocks go back at 02:00 EDT, so the day
  // starts at 04:00Z and does not end until 05:00Z the next morning.
  assert.equal(dayKey('2026-11-01T03:59:00Z', 'America/New_York'), '2026-10-31');
  assert.equal(dayKey('2026-11-01T04:01:00Z', 'America/New_York'), '2026-11-01');
  assert.equal(dayKey('2026-11-02T04:30:00Z', 'America/New_York'), '2026-11-01');
  assert.equal(dayKey('2026-11-02T05:01:00Z', 'America/New_York'), '2026-11-02');
});

test('a timestamp nobody can read is the empty key, not an exception', () => {
  // These come out of run files this module did not write.
  assert.equal(dayKey('not a date', TZ), '');
  assert.equal(dayKey(Number.NaN, TZ), '');
  assert.equal(dayKey(new Date('nonsense'), TZ), '');
});

test('the key list is calendar arithmetic, so a DST day is never skipped or repeated', () => {
  const week = dayKeysEndingAt('2026-11-02', 7);
  assert.deepEqual(week, [
    '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02',
  ]);
  assert.equal(new Set(week).size, 7);
  // Month and year boundaries are just dates.
  assert.deepEqual(dayKeysEndingAt('2027-01-02', 7).slice(0, 3), ['2026-12-27', '2026-12-28', '2026-12-29']);
  assert.deepEqual(dayKeysEndingAt('', 7), [], 'no day, no history');
});

/* ------------------------------------------------------------------ *
 * rungsToday
 * ------------------------------------------------------------------ */

test('rungsToday is today\'s rungs only, across every run, oldest first', () => {
  const runs: SpendRunView[] = [
    {
      id: 'r1', slug: 'alpha',
      recoveries: {
        '3': { rungs: [rung(JUST_BEFORE), rung('2026-08-22T01:00:00Z')] },
        '4': { rungs: [rung(JUST_AFTER)] },
      },
    },
    { id: 'r2', slug: 'beta', recoveries: { '1': { rungs: [rung('2026-08-19T10:00:00Z')] } } },
    { id: 'r3', slug: 'gamma' },
  ];
  const today = rungsToday(runs, NOW, TZ);
  assert.deepEqual(today.map((r) => r.at), [JUST_AFTER, '2026-08-22T01:00:00Z']);
  // The 19th belongs to nobody's today, in any zone.
  assert.ok(!today.some((r) => r.at.startsWith('2026-08-19')));
  // A UTC reading of the same instant picks a DIFFERENT set: JUST_AFTER is
  // still the 21st there, so the day it belongs to is one the operator finished
  // eleven hours ago.
  assert.deepEqual(rungsToday(runs, NOW, 'UTC').map((r) => r.at), ['2026-08-22T01:00:00Z']);
});

test('rungsToday hands the records back untouched, so nextRung does its own exact sum', () => {
  const runs: SpendRunView[] = [
    { id: 'r1', slug: 'alpha', recoveries: { '2': { rungs: [rung(JUST_AFTER, 600)] } } },
  ];
  const dayHistory = rungsToday(runs, NOW, TZ);
  assert.equal(dayHistory[0].costUsd, 600, 'not rounded, not copied, not summarised');
  // The wiring this exists for: the same list, straight into the per-day cap.
  const refused = nextRung({ situation: 'never-started', history: [], dayHistory });
  assert.equal(refused.ok, false);
  assert.match(!refused.ok ? refused.reason : '', /today's ladder budget is spent/);
  assert.ok(nextRung({ situation: 'never-started', history: [], dayHistory: rungsToday(runs, new Date('2026-08-25T02:00:00Z'), TZ) }).ok,
    'a new day is a new budget');
});

test('a rung with no recorded cost is still returned, and counts as zero dollars', () => {
  const runs: SpendRunView[] = [
    { id: 'r1', slug: 'alpha', recoveries: { '2': { rungs: [rung(JUST_AFTER), rung('2026-08-22T01:00:00Z')] } } },
  ];
  const dayHistory = rungsToday(runs, NOW, TZ);
  assert.equal(dayHistory.length, 2, 'a reader counting attempts wants the whole day');
  assert.ok(nextRung({ situation: 'never-started', history: [], dayHistory }).ok,
    'no cap is ever tripped by a number nobody wrote');
});

/* ------------------------------------------------------------------ *
 * spendSummary — today
 * ------------------------------------------------------------------ */

/** One run whose phases finished either side of local midnight. */
const straddling: SpendRunView[] = [
  {
    id: 'run-1', slug: 'alpha', spentUsd: 30.5, runBudgetUsd: 100, updatedAt: '2026-08-22T01:30:00Z',
    phases: {
      '1': { costUsd: 12.25, endedAt: JUST_BEFORE },
      '2': { costUsd: 18.25, endedAt: JUST_AFTER },
      '3': { costUsd: 40, endedAt: undefined },
    },
  },
];

test('a run that straddles local midnight books each phase on the day it ended', () => {
  const view = spendSummary({ runs: straddling, capUsd: 600, tz: TZ }, NOW);
  assert.equal(view.today.settledUsd, 18.25, 'only the phase that ended after local midnight');
  const series = new Map(view.series.map((d) => [d.day, d.settledUsd]));
  assert.equal(series.get('2026-08-21'), 12.25);
  assert.equal(series.get('2026-08-22'), 18.25);
  // In UTC the whole $30.50 would have landed on the 21st and today would read $0.
  const utc = spendSummary({ runs: straddling, capUsd: 600, tz: 'UTC' }, NOW);
  assert.equal(utc.today.settledUsd, 0);
  assert.equal(new Map(utc.series.map((d) => [d.day, d.settledUsd])).get('2026-08-21'), 30.5);
});

test('a phase still in flight has spent money that belongs to no date yet', () => {
  const view = spendSummary({ runs: straddling, tz: TZ }, NOW);
  const total = view.series.reduce((sum, d) => sum + d.settledUsd, 0);
  assert.equal(total, 30.5, 'the $40 phase with no endedAt is in no bucket at all');
  assert.equal(view.runs[0].spentUsd, 30.5);
});

test('ladderUsd is an honest zero: the runner does not record what a rung costs', () => {
  const runs: SpendRunView[] = [
    {
      id: 'run-1', slug: 'alpha', spentUsd: 90, updatedAt: '2026-08-22T01:30:00Z',
      // Exactly what `accountRung` writes and nothing ever settles: no costUsd.
      recoveries: { '2': { rungs: [rung(JUST_AFTER), rung('2026-08-22T01:00:00Z')] } },
      phases: { '2': { costUsd: 90, endedAt: JUST_AFTER } },
    },
  ];
  const view = spendSummary({ runs, capUsd: 600, tz: TZ }, NOW);
  assert.equal(view.today.settledUsd, 90, 'the session money is real and is reported');
  assert.equal(view.today.ladderUsd, 0, 'the rung money is not recorded, so it is reported as nothing');
});

/* ------------------------------------------------------------------ *
 * spendSummary — the cap
 * ------------------------------------------------------------------ */

test('the day cap comparison is nextRung\'s: >=, and no cap when none is set', () => {
  const spent = (costUsd: number): SpendRunView[] => [
    { id: 'r', slug: 'alpha', recoveries: { '1': { rungs: [rung(JUST_AFTER, costUsd)] } } },
  ];
  const under = spendSummary({ runs: spent(599.99), capUsd: 600, tz: TZ }, NOW);
  assert.equal(under.today.ladderUsd, 599.99);
  assert.equal(under.today.capUsd, 600);
  assert.equal(overDayCap(under.today), false);

  const exactly = spendSummary({ runs: spent(600), capUsd: 600, tz: TZ }, NOW);
  assert.equal(overDayCap(exactly.today), true, 'reaching the cap is spending it, exactly as nextRung reads it');

  // No cap set at all — the view says null and nothing is ever over it.
  const uncapped = spendSummary({ runs: spent(5_000), tz: TZ }, NOW);
  assert.equal(uncapped.today.capUsd, null);
  assert.equal(overDayCap(uncapped.today), false);

  // Zero is a cap, not an absence: it is what an operator sets to stop the
  // ladder spending anything, and `nextRung` refuses at it immediately.
  const zero = spendSummary({ runs: [], capUsd: 0, tz: TZ }, NOW);
  assert.equal(zero.today.capUsd, 0);
  assert.equal(overDayCap(zero.today), true);
});

/* ------------------------------------------------------------------ *
 * spendSummary — runs and series
 * ------------------------------------------------------------------ */

test('each run stands against its own budget, dearest first; unlimited is null', () => {
  const runs: SpendRunView[] = [
    { id: 'b', slug: 'beta', spentUsd: 5, runBudgetUsd: 50 },
    { id: 'a', slug: 'alpha', spentUsd: 120, runBudgetUsd: null },
    { id: 'c', slug: 'gamma', spentUsd: 0, runBudgetUsd: 20, updatedAt: '2026-08-22T01:00:00Z' },
    { id: 'd', slug: 'delta', spentUsd: 0, runBudgetUsd: 20, updatedAt: '2026-07-01T01:00:00Z' },
  ];
  const view = spendSummary({ runs, tz: TZ }, NOW);
  assert.deepEqual(view.runs, [
    { runId: 'a', slug: 'alpha', spentUsd: 120, budgetUsd: null },
    { runId: 'b', slug: 'beta', spentUsd: 5, budgetUsd: 50 },
    { runId: 'c', slug: 'gamma', spentUsd: 0, budgetUsd: 20 },
  ]);
  // `delta` spent nothing and was last touched in July: not a fact about spending.
});

test('the series is exactly seven buckets, oldest first, with the empty days present as zeros', () => {
  const runs: SpendRunView[] = [
    {
      id: 'r', slug: 'alpha', spentUsd: 7,
      phases: {
        '1': { costUsd: 4, endedAt: '2026-08-16T06:00:00Z' },  // Tokyo 2026-08-16, the oldest bucket
        '2': { costUsd: 3, endedAt: JUST_AFTER },              // Tokyo 2026-08-22, today
        '3': { costUsd: 99, endedAt: '2026-08-10T06:00:00Z' }, // older than the window: not shown
      },
    },
  ];
  const view = spendSummary({ runs, capUsd: 600, tz: TZ }, NOW);
  assert.equal(view.series.length, SERIES_DAYS);
  assert.equal(view.series.length, 7);
  assert.deepEqual(view.series.map((d) => d.day), [
    '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22',
  ]);
  assert.deepEqual(view.series.map((d) => d.settledUsd), [4, 0, 0, 0, 0, 0, 3]);
  assert.deepEqual(view.series.map((d) => d.ladderUsd), [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(view.series.at(-1)!.day, dayKey(NOW, TZ), 'today is always the last bucket');
  assert.equal(view.series.at(-1)!.settledUsd, view.today.settledUsd);
  // A wider window is still all-days-present.
  assert.equal(spendSummary({ runs, tz: TZ, days: 30 }, NOW).series.length, 30);
});

test('nothing on disk is an empty answer, not a missing one', () => {
  const view = spendSummary({ runs: [], capUsd: 600, tz: TZ }, NOW);
  assert.deepEqual(view.today, { settledUsd: 0, ladderUsd: 0, capUsd: 600 });
  assert.deepEqual(view.runs, []);
  assert.equal(view.series.length, 7);
  assert.ok(view.series.every((d) => d.settledUsd === 0 && d.ladderUsd === 0));
});

test('float dust is not a spend figure', () => {
  const runs: SpendRunView[] = [
    {
      id: 'r', slug: 'alpha', spentUsd: 0.1 + 0.2,
      phases: { '1': { costUsd: 0.1, endedAt: JUST_AFTER }, '2': { costUsd: 0.2, endedAt: JUST_AFTER } },
    },
  ];
  const view = spendSummary({ runs, tz: TZ }, NOW);
  assert.equal(view.today.settledUsd, 0.3);
  assert.equal(view.runs[0].spentUsd, 0.3);
});

test('a run file missing every optional field is read, not thrown at', () => {
  const runs = [
    { id: 'r', slug: 'alpha' },
    { id: 'x', slug: 'beta', spentUsd: 3, phases: { '1': { endedAt: 'garbage', costUsd: 5 } }, recoveries: {} },
  ] as SpendRunView[];
  const view = spendSummary({ runs, tz: TZ }, NOW);
  assert.deepEqual(view.runs, [{ runId: 'x', slug: 'beta', spentUsd: 3, budgetUsd: null }]);
  assert.equal(view.today.settledUsd, 0, 'an unreadable endedAt lands in no bucket');
});

/* ------------------------------------------------------------------ *
 * planCost — per-phase attribution
 * ------------------------------------------------------------------ */

/**
 * The identity every one of these tests is really about: every site that ends
 * a session books the same dollars to BOTH `run.spentUsd` and
 * `record.costUsd`, so in a healthy run the per-phase figures sum to the run
 * total exactly. `residualUsd` exists to say when they do not.
 */
const costRun = (
  id: string,
  spentUsd: number,
  phases: Record<string, Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): SpendRunView => ({ id, slug: 'demo', spentUsd, phases, ...extra } as SpendRunView);

test('a phase costs what its records cost, summed across every run of the plan', () => {
  const view = planCost({
    slug: 'demo',
    tz: TZ,
    runs: [
      costRun('r1', 3, { 1: { costUsd: 2, endedAt: '2026-08-20T01:00:00Z', attempts: 1 },
                         2: { costUsd: 1, endedAt: '2026-08-20T02:00:00Z', attempts: 1 } }),
      // Phase 1 re-boarded under a second run: real money, spent twice.
      costRun('r2', 5, { 1: { costUsd: 5, endedAt: '2026-08-21T01:00:00Z', attempts: 2 } }),
    ],
  });

  assert.equal(view.totalUsd, 8);
  assert.equal(view.attributedUsd, 8);
  assert.equal(view.residualUsd, 0);
  assert.deepEqual(view.phases.map((p) => [p.phase, p.usd, p.attempts, p.runs]), [
    [1, 7, 3, 2],
    [2, 1, 1, 1],
  ]);
});

test('the residual is a FAULT, not a category — it is only non-zero when a run file disagrees with itself', () => {
  const healthy = planCost({ slug: 'demo', runs: [costRun('r1', 4, { 1: { costUsd: 4, attempts: 1 } })] });
  assert.equal(healthy.residualUsd, 0);

  // A record dropped (or a file written by an older build): the run says it
  // spent $4 and only $1 can be attributed to a phase.
  const broken = planCost({ slug: 'demo', runs: [costRun('r1', 4, { 1: { costUsd: 1, attempts: 1 } })] });
  assert.equal(broken.totalUsd, 4);
  assert.equal(broken.attributedUsd, 1);
  assert.equal(broken.residualUsd, 3);
});

test('the ladder figure is a SUBSET of the run total, never a third column to add on', () => {
  // `chargeRung` books the same dollars a third time. Adding `ladderUsd` to
  // `totalUsd` would double-count every rung the ladder ever drove.
  const view = planCost({
    slug: 'demo',
    runs: [costRun('r1', 6, { 1: { costUsd: 6, attempts: 2 } }, {
      recoveries: { 1: { rungs: [rung('2026-08-21T01:00:00Z', 6)] } },
    })],
  });
  assert.equal(view.totalUsd, 6);
  assert.equal(view.ladderUsd, 6);
  assert.equal(view.attributedUsd, 6);
  assert.equal(view.residualUsd, 0);
});

test('costUnknown makes the figure a FLOOR and names the phase — $0.00 must never read as free', () => {
  const view = planCost({
    slug: 'demo',
    runs: [costRun('r1', 0, {
      3: { costUsd: 0, attempts: 1, costUnknown: true, endedAt: '2026-08-21T01:00:00Z' },
      4: { costUsd: 2, attempts: 1, endedAt: '2026-08-21T02:00:00Z' },
    })],
  });
  assert.deepEqual(view.partialPhases, [3]);
  assert.equal(view.phases.find((p) => p.phase === 3)?.partial, true);
  assert.equal(view.phases.find((p) => p.phase === 4)?.partial, false);
});

test('an old run file that knows only that the cost is unknown still gets a row', () => {
  // Every field on a phase record is optional because old files predate most
  // of them. `costUnknown` with no `attempts` and no `costUsd` is the shape
  // that says "a session really ran and its spend was never harvested" — the
  // one row that must not be filtered out as "a phase that never started".
  const view = planCost({ slug: 'demo', runs: [costRun('r1', 0, { 5: { costUnknown: true } })] });
  assert.deepEqual(view.phases.map((p) => p.phase), [5]);
  assert.deepEqual(view.partialPhases, [5]);
});

test('a phase that has not started is not a row of zeros above the ones somebody opened this to see', () => {
  const view = planCost({
    slug: 'demo',
    runs: [costRun('r1', 1, { 1: { costUsd: 1, attempts: 1 }, 2: { costUsd: 0, attempts: 0 } })],
  });
  assert.deepEqual(view.phases.map((p) => p.phase), [1]);
});

test('money is booked to the model a phase ENDED on, and the operator day it ended', () => {
  const view = planCost({
    slug: 'demo',
    tz: TZ,
    runs: [costRun('r1', 3, {
      // Straddles Tokyo midnight: these two land on different days, and would
      // be indistinguishable under a UTC day key.
      1: { costUsd: 1, endedAt: JUST_BEFORE, attempts: 1, model: 'claude-sonnet-5' },
      2: { costUsd: 2, endedAt: JUST_AFTER, attempts: 1, model: 'claude-sonnet-5', actualModel: 'claude-opus-5' },
    })],
  });
  // `actualModel` wins over `model`: what it ran on, not what it was told to.
  assert.deepEqual(view.byModel, [
    { model: 'claude-opus-5', usd: 2, phases: 1 },
    { model: 'claude-sonnet-5', usd: 1, phases: 1 },
  ]);
  assert.deepEqual(view.byDay, [
    { day: '2026-08-21', usd: 1 },
    { day: '2026-08-22', usd: 2 },
  ]);
});

test('the daily series fills its gaps and never truncates silently', () => {
  const view = planCost({
    slug: 'demo',
    tz: 'UTC',
    runs: [costRun('r1', 2, {
      1: { costUsd: 1, endedAt: '2026-08-20T01:00:00Z', attempts: 1 },
      2: { costUsd: 1, endedAt: '2026-08-23T01:00:00Z', attempts: 1 },
    })],
  });
  // A gap in a bar chart reads as missing data; "nothing was spent" is data.
  assert.deepEqual(view.byDay.map((d) => d.day), ['2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23']);
  assert.deepEqual(view.byDay.map((d) => d.usd), [1, 0, 0, 1]);
  assert.equal(view.byDayTruncated, false);

  const long = planCost({
    slug: 'demo',
    tz: 'UTC',
    runs: [costRun('r1', 2, {
      1: { costUsd: 1, endedAt: '2026-01-01T01:00:00Z', attempts: 1 },
      2: { costUsd: 1, endedAt: '2026-08-23T01:00:00Z', attempts: 1 },
    })],
  });
  assert.equal(long.byDay.length, MAX_COST_DAYS);
  assert.equal(long.byDayTruncated, true, 'a window presented as a whole life is a lie');
  assert.equal(long.byDay[long.byDay.length - 1]!.day, '2026-08-23', 'the NEWEST days are the ones kept');
});

test('planCost attributes a live phase to the phase and to no day', () => {
  const view = planCost({
    slug: 'demo',
    tz: TZ,
    runs: [costRun('r1', 4, { 1: { costUsd: 4, attempts: 1 } })],
  });
  assert.equal(view.attributedUsd, 4, 'the money is still attributed to the phase');
  assert.deepEqual(view.byDay, [], 'and to no day, because guessing one is how a live run appears twice');
});

test('nothing at all is a whole, renderable answer', () => {
  const view = planCost({ slug: 'demo', runs: [] });
  assert.deepEqual(view.phases, []);
  assert.equal(view.totalUsd, 0);
  assert.equal(view.residualUsd, 0);
  assert.deepEqual(view.byModel, []);
  assert.deepEqual(view.byDay, []);
});
