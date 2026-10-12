/**
 * The no-client-arithmetic contract (quiet-console phase 19, exit criterion:
 * "the ETA, cost and velocity panels read the same server arithmetic").
 *
 * `./model` is what those three panels print, and every figure in it is a
 * field the server sent, formatted. So each case hands it a server answer
 * whose fields DISAGREE with what a browser would make of the others — a
 * `total` that is not the series added up, room under the cap that is not
 * the cap less the ladder, an open count that is not plans less closed, a
 * `mediumMs` no floor and slope lead to — and asserts the printed figure is
 * the field, never the sum. A field a server older than 7.0 does not send
 * prints "—", or is left out; it is never made up in its place.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { overDayCap } from '@shared/ladder-model.js';
import type { EtaEstimate, PlanSummaryFull, Portfolio, PortfolioTotals, SpendView } from '@/data/api';
import {
  NOT_SAID,
  basisWords,
  costReading,
  etaModelWords,
  etaReading,
  samplesWords,
  sizingReading,
  velocityReading,
  weekFacts,
  type InsightFact,
} from './model';
import { sizingAnswer, weekAnswer } from './test-answers';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ---------------- the server's answers ---------------- */

/** `/api/spend` as a 7.0 server sends it; a case overrides what it is about. */
function spend(over: Partial<SpendView> = {}): SpendView {
  return {
    today: { settledUsd: 18.25, ladderUsd: 2.5, capUsd: 40, ladderLeftUsd: 37.5 },
    runs: [
      { runId: 'r1', slug: 'demo', spentUsd: 61.5, budgetUsd: 100 },
      { runId: 'r2', slug: 'quiet', spentUsd: 4, budgetUsd: null },
      { runId: 'r3', slug: 'demo', spentUsd: 2.25, budgetUsd: 10 },
    ],
    series: [
      { day: '2026-10-08', settledUsd: 0, ladderUsd: 0, usd: 0 },
      { day: '2026-10-09', settledUsd: 3.1, ladderUsd: 0.9, usd: 4 },
      { day: '2026-10-10', settledUsd: 18.25, ladderUsd: 2.5, usd: 20.75 },
    ],
    total: { settledUsd: 21.35, ladderUsd: 3.4, usd: 24.75 },
    ...over,
  };
}

/** The same answer from a server older than 7.0: no `total`, no day's `usd`, no `ladderLeftUsd`. */
function older(view: SpendView): SpendView {
  return {
    today: { settledUsd: view.today.settledUsd, ladderUsd: view.today.ladderUsd, capUsd: view.today.capUsd },
    runs: view.runs,
    series: view.series.map((day) => ({
      day: day.day,
      settledUsd: day.settledUsd,
      ladderUsd: day.ladderUsd,
    })),
  };
}

/** `/api/stats`' rate as a server older than 7.0 sent it: everything but `mediumMs`. */
const OLDER_RATE: NonNullable<Portfolio['rate']> = {
  ratePerWeight: 61,
  floorMs: 600_000,
  slopeMsPerWeight: 45,
  basis: 'portfolio',
  samples: 12,
  spread: 0.6,
  missing: 2,
  clock: 'working',
};

/**
 * One M phase as the server's own `estimateMs` reads it: 2h 9m. Nothing a
 * browser could make of the rate's other fields lands there — the shipped M's
 * 40 000 of weight is 40m on the affine model (600 000 + 45 × 40 000) and 40m
 * 40s on the plain rate (61 × 40 000), and (7 777 777 − 600 000) / 45 is no
 * whole weight at all.
 */
const MEDIUM_MS = 7_777_777;
const RATE: NonNullable<Portfolio['rate']> = { ...OLDER_RATE, mediumMs: MEDIUM_MS };

/** `/api/stats` as a 7.0 server sends it. Nine plans, two closed — and three open, not the seven a subtraction makes. */
function portfolio(over: Partial<Portfolio> = {}, totals: Partial<PortfolioTotals> = {}): Portfolio {
  return {
    generatedAt: Date.parse('2026-10-10T12:00:00Z'),
    totals: {
      plans: 9,
      documents: 0,
      orphans: 0,
      closed: 2,
      open: 3,
      phases: 40,
      done: 20,
      ready: 2,
      waiting: 16,
      inProgress: 1,
      stuck: 1,
      percent: 50,
      remainingWeight: 1_400_000,
      remainingSessions: 12,
      ...totals,
    },
    byStatus: [],
    activeLocks: [],
    issues: [],
    velocity: [],
    calendar: [],
    sizeMix: [],
    repos: [],
    skills: [],
    models: [],
    stalled: [],
    busiest: [],
    rate: RATE,
    ...over,
  };
}

const valueOf = (facts: readonly InsightFact[], label: string): string | undefined =>
  facts.find((fact) => fact.label === label)?.value;

/** A fact whole — its label, value and hint. */
const fact = (facts: readonly InsightFact[], label: string): InsightFact | undefined =>
  facts.find((one) => one.label === label);

/* ---------------- what it costs ---------------- */

describe('costReading — the window, the cap and the runs, as the server summed them', () => {
  it('prints today’s figures and the window’s total as sent, formatted', () => {
    expect(costReading(spend()).facts.map((fact) => [fact.label, fact.value])).toEqual([
      ['Settled today', '$18.25'],
      ['Ladder today', '$2.50'],
      ['Day cap', '$40.00'],
      ['Last 3 days', '$24.75'],
    ]);
  });

  it('the window’s cost is the server’s `total`, never the series added up here', () => {
    // A total that is not the days' sum ($24.75): the figure printed says which one it came from.
    const reading = costReading(spend({ total: { settledUsd: 50, ladderUsd: 7.07, usd: 57.07 } }));
    expect(valueOf(reading.facts, 'Last 3 days')).toBe('$57.07');
  });

  it('with no `total` (an older server) the window’s cost is "—" — no sum stands in for it', () => {
    // Days that add up to figures nothing else here could print: $69.15 together, $69.12 settled.
    const series = [
      { day: '2026-10-09', settledUsd: 12.34, ladderUsd: 0.01, usd: 12.35 },
      { day: '2026-10-10', settledUsd: 56.78, ladderUsd: 0.02, usd: 56.8 },
    ];
    const reading = costReading(older(spend({ series })));
    expect(reading.facts[3]).toEqual({
      label: 'Last 2 days',
      value: NOT_SAID,
      hint: 'settled and ladder together',
    });
    const printed = JSON.stringify(reading.facts);
    expect(printed).not.toContain('69.15');
    expect(printed).not.toContain('69.12');
  });

  it('the room under the cap is the server’s `ladderLeftUsd`; "—" when it was not sent', () => {
    // Room the server measured that no subtraction here would make: a $40 cap, $2.50 spent, $11.11 left.
    const today = { settledUsd: 18.25, ladderUsd: 2.5, capUsd: 40, ladderLeftUsd: 11.11 };
    expect(costReading(spend({ today })).cap).toEqual({
      ladderUsd: 2.5,
      capUsd: 40,
      atCap: false,
      room: '$11.11',
    });
    expect(costReading(older(spend())).cap?.room).toBe(NOT_SAID);
    expect(costReading(spend({ today: { ...today, ladderLeftUsd: null } })).cap?.room).toBe(NOT_SAID);
  });

  it('no cap set: no meter at all, and the day cap says none', () => {
    const reading = costReading(
      spend({ today: { settledUsd: 18.25, ladderUsd: 2.5, capUsd: null, ladderLeftUsd: null } }),
    );
    expect(reading.cap).toBeNull();
    expect(reading.facts[2]).toEqual({
      label: 'Day cap',
      value: 'none',
      hint: 'nothing refuses a rung on cost',
    });
  });

  it('at the cap is the cap’s own verdict, `overDayCap` — the rule a rung is refused by', () => {
    const cases = [
      { ladderUsd: 2.5, capUsd: 40, ladderLeftUsd: 37.5, at: false },
      { ladderUsd: 39.99, capUsd: 40, ladderLeftUsd: 0.01, at: false },
      { ladderUsd: 40, capUsd: 40, ladderLeftUsd: 0, at: true },
      { ladderUsd: 41, capUsd: 40, ladderLeftUsd: 0, at: true },
      // A cap of zero is reached the instant it is set.
      { ladderUsd: 0, capUsd: 0, ladderLeftUsd: 0, at: true },
    ];
    for (const { at, ...ladder } of cases) {
      const today = { settledUsd: 1, ...ladder };
      const cap = costReading(spend({ today })).cap;
      expect(cap?.atCap, JSON.stringify(ladder)).toBe(overDayCap(today));
      expect(cap?.atCap, JSON.stringify(ladder)).toBe(at);
    }
  });

  it('each day is drawn at the server’s `usd` as sent: every day, in order, zeros kept', () => {
    // A day whose `usd` is not its settled plus its ladder: what is drawn says where it came from.
    const series = [
      { day: '2026-10-08', settledUsd: 0, ladderUsd: 0, usd: 0 },
      { day: '2026-10-09', settledUsd: 3.1, ladderUsd: 0.9, usd: 4.44 },
      { day: '2026-10-10', settledUsd: 18.25, ladderUsd: 2.5, usd: 20.76 },
    ];
    const reading = costReading(spend({ series }));
    expect(reading.days).toEqual([
      { name: '2026-10-08', value: 0 },
      { name: '2026-10-09', value: 4.44 },
      { name: '2026-10-10', value: 20.76 },
    ]);
    // The numbers fold keeps settled and ladder apart, exactly as sent.
    expect(reading.split).toEqual(series);
  });

  it('a day with no `usd` (an older server) is dropped, never summed from its settled and ladder', () => {
    const series = [
      { day: '2026-10-09', settledUsd: 3.1, ladderUsd: 0.9, usd: 4 },
      { day: '2026-10-10', settledUsd: 18.25, ladderUsd: 2.5 },
    ];
    const reading = costReading(spend({ series }));
    expect(reading.days).toEqual([{ name: '2026-10-09', value: 4 }]);
    // An older server sent no day's `usd`: nothing is drawn, and its days still read apart in the fold.
    const old = costReading(older(spend()));
    expect(old.days).toEqual([]);
    expect(old.split.map((day) => day.day)).toEqual(['2026-10-08', '2026-10-09', '2026-10-10']);
  });

  it('the runs narrow to the plan in scope, and are every run unscoped', () => {
    const view = spend();
    expect(costReading(view).runs).toEqual(view.runs);
    expect(costReading(view, 'demo').runs.map((run) => run.runId)).toEqual(['r1', 'r3']);
    expect(costReading(view, 'nobody').runs).toEqual([]);
  });
});

/* ---------------- how long is left ---------------- */

describe('etaReading — the portfolio', () => {
  it('an M phase is the server’s `mediumMs`, formatted — never a floor plus a slope times a weight', () => {
    const value = valueOf(etaReading(portfolio()).estimate ?? [], 'An M phase');
    expect(value).toBe('about 2h 9m of work');
    // What the browser's own arithmetic would have said for the shipped M (see MEDIUM_MS).
    expect(value).not.toContain('40m');
  });

  it('an M phase is "—" when an older server sent no `mediumMs`; the rest still stands on what was sent', () => {
    const estimate = etaReading(portfolio({ rate: OLDER_RATE })).estimate;
    expect(estimate?.map((fact) => [fact.label, fact.value])).toEqual([
      ['An M phase', NOT_SAID],
      ['Basis', basisWords('portfolio', false)],
      ['Samples', samplesWords(12, 2)],
      ['Confidence band', '÷1.6 to ×1.6 of the estimate, where three in four measured phases fell'],
    ]);
  });

  it('a heuristic basis is no estimate; the model it stands on is still the server’s floor and slope', () => {
    const reading = etaReading(portfolio({ rate: { ...RATE, basis: 'heuristic' } }));
    expect(reading.estimate).toBeNull();
    expect(reading.model).toEqual({ label: 'Model', value: etaModelWords(600_000, 45) });
    // No rate at all: neither.
    const none = etaReading(portfolio({ rate: undefined }));
    expect(none.estimate).toBeNull();
    expect(none.model).toBeNull();
  });

  it('the answer counts the open plans the server counted, and none when it did not count them', () => {
    expect(etaReading(portfolio()).answer).toBe('12 sessions left, 1.4M of work across 3 open plans.');
    expect(etaReading(portfolio({}, { open: 1 })).answer).toBe(
      '12 sessions left, 1.4M of work across 1 open plan.',
    );
    // An older server: no `open`, so no count — never plans less closed.
    expect(etaReading(portfolio({}, { open: undefined })).answer).toBe('12 sessions left, 1.4M of work.');
    expect(etaReading(portfolio({}, { remainingSessions: 0 })).answer).toBe(
      'Nothing is left to do across 3 open plans.',
    );
    expect(etaReading(portfolio({}, { remainingSessions: 0, open: undefined })).answer).toBe(
      'Nothing is left to do.',
    );
  });

  it('the standing counts are the totals as sent, and an unscoped reading has no floor', () => {
    const reading = etaReading(portfolio());
    expect(reading.facts).toEqual([
      { label: 'Ready now', value: '2' },
      { label: 'In flight', value: '1' },
    ]);
    expect(reading.floor).toBeNull();
  });
});

describe('etaReading — one plan', () => {
  const ETA: EtaEstimate = {
    ratePerWeight: 61,
    floorMs: 600_000,
    slopeMsPerWeight: 45,
    samples: 6,
    missing: 1,
    basis: 'plan',
    remainingWeight: 400_000,
    remainingPhases: 5,
    lowMs: 3_600_000,
    highMs: 14_400_000,
    clock: 'working',
    label: '≈ 3 days',
  };
  /** The plan's own analysis, as far as the reading reads it; a count left out is one an older server did not send. */
  const own = (over: Record<string, unknown> = {}) =>
    ({
      ready: [3, 4],
      inProgress: [2],
      minimumSessions: 3,
      remainingSessions: 8,
      ...over,
    }) as unknown as PlanSummaryFull;
  const floorOf = (over: Record<string, unknown>) =>
    etaReading(portfolio(), { plan: 'demo', planEta: ETA, planStats: own(over) }).floor;

  it('the floor is the two counts the server sent, never their difference', () => {
    const floor = floorOf({});
    expect(floor).toEqual({ minimum: 3, remaining: 8, all: false });
    // 8 − 3 is the reader's to see, never a field of the reading.
    expect(Object.values(floor ?? {})).not.toContain(5);
  });

  it('the floor is all of it when the chain is at least as long as what is left', () => {
    expect(floorOf({ minimumSessions: 8, remainingSessions: 8 })).toEqual({
      minimum: 8,
      remaining: 8,
      all: true,
    });
    expect(floorOf({ minimumSessions: 9, remainingSessions: 8 })).toEqual({
      minimum: 9,
      remaining: 8,
      all: true,
    });
  });

  it('no floor when either count is absent, or the chain is under one session', () => {
    expect(floorOf({ minimumSessions: undefined })).toBeNull();
    expect(floorOf({ remainingSessions: undefined })).toBeNull();
    expect(floorOf({ minimumSessions: 0 })).toBeNull();
    expect(etaReading(portfolio(), { plan: 'demo', planEta: ETA }).floor).toBeNull();
  });

  it('the answer and the estimate are the plan’s own estimate, formatted', () => {
    const reading = etaReading(portfolio(), { plan: 'demo', planEta: ETA, planStats: own() });
    expect(reading.answer).toBe('≈ 3 days in demo: 5 phases, 400K of weight.');
    expect(reading.facts.map((fact) => [fact.label, fact.value])).toEqual([
      ['Sessions left', '8'],
      ['Ready now', '2'],
      ['In flight', '1'],
    ]);
    expect(reading.estimate?.map((fact) => [fact.label, fact.value])).toEqual([
      ['Estimate', '≈ 3 days'],
      ['Phases left', '5 phases, 400K'],
      ['Basis', basisWords('plan', true)],
      ['Samples', samplesWords(6, 1)],
    ]);
    expect(reading.model).toEqual({ label: 'Model', value: etaModelWords(600_000, 45) });
  });

  it('no estimate for the plan says so, and draws none', () => {
    const reading = etaReading(portfolio(), { plan: 'demo', planEta: null, planStats: own() });
    expect(reading.answer).toBe('No estimate for demo.');
    expect(reading.estimate).toBeNull();
    expect(reading.model).toBeNull();
  });
});

/* ---------------- how fast ---------------- */

describe('velocityReading — the weeks as the server bucketed them', () => {
  // The calendar's days would bucket into other counts — 3 in the week the
  // server counts 2, 1 in the week it counts 5 — so weeks re-counted here
  // could not pass for the server's.
  // ISO week keys, as `weeklyBuckets` writes them: W38 is 14–20 September, W40 28 September–4 October.
  const WEEKS = [
    { week: '2026-W38', count: 2 },
    { week: '2026-W39', count: 0 },
    { week: '2026-W40', count: 5 },
  ];
  const CALENDAR = [
    { date: '2026-09-19', count: 3 },
    { date: '2026-10-01', count: 1 },
  ];

  it('draws the server’s weeks as sent: same values, same order, same length', () => {
    const reading = velocityReading(portfolio({ velocity: WEEKS, calendar: CALENDAR }));
    expect(reading.weeks).toEqual(WEEKS);
    expect(reading.weeks.map((week) => week.count)).toEqual([2, 0, 5]);
    expect(reading.from).toBe('2026-W38');
    expect(reading.to).toBe('2026-W40');
    expect(reading.calendar).toEqual(CALENDAR);
    expect(reading.empty).toBe(false);
  });

  it('says the median gap in words, and nothing when the server has none', () => {
    expect(velocityReading(portfolio({ medianCycleDays: 0 })).gap).toBe('the same day');
    expect(velocityReading(portfolio({ medianCycleDays: 1 })).gap).toBe('1 day');
    expect(velocityReading(portfolio({ medianCycleDays: 4 })).gap).toBe('4 days');
    expect(velocityReading(portfolio()).gap).toBeNull();
  });

  it('is empty when no week landed anything, and when there are no weeks', () => {
    const idle = velocityReading(portfolio({ velocity: WEEKS.map((week) => ({ ...week, count: 0 })) }));
    expect(idle).toMatchObject({ empty: true, from: '2026-W38', to: '2026-W40' });
    expect(velocityReading(portfolio({ velocity: [] }))).toMatchObject({ empty: true, from: null, to: null });
  });
});

/* ---------------- what a session may spend ---------------- */

describe('what a session may spend', () => {
  it('prints the floor the server sent beside its boot and work, never their sum', () => {
    const sizing = sizingAnswer();
    // A floor that is not boot + work: the printed peak must be the field.
    sizing.context = { ...sizing.context, boot: 30_000, work: 20_000, floor: 61_000 };
    const reading = sizingReading(sizing);
    expect(fact(reading.context, 'Peak')?.value).toBe('61K + 0.42 × weight');
    expect(fact(reading.context, 'Boot')?.value).toBe('30K');
    expect(fact(reading.context, 'Work')?.value).toBe('20K');
  });

  it('answers with the phase’s own caps, each with the server’s words for how it was reached', () => {
    const reading = sizingReading(sizingAnswer());
    expect(reading.answer).toBe('A phase session runs under 510 turns and $120.00.');
    expect(reading.phase).toEqual([
      {
        label: 'Turns',
        value: '510',
        hint: 'p99 337 turns + 50 % — 44 phase sessions on this console, 2026-09-28 → 2026-10-11',
      },
      {
        label: 'Dollars',
        value: '$120.00',
        hint: 'p99 $77.81 + 50 % — 274 phase sessions, 2026-09-16 → 2026-09-25 (shipped)',
      },
    ]);
  });

  it('puts each mode’s measured cap beside the shipped one, the shipped table’s modes first', () => {
    const rows = sizingReading(sizingAnswer()).caps;
    expect(rows.map((row) => [row.cap, row.measured, row.shipped])).toEqual([
      ['phase turns', '510', '490'],
      ['phase dollars', 'not measured', '$120.00'],
      ['resume turns', 'not measured', '120'],
      // Measured here and never shipped: the server did not say, so neither does the table.
      ['closeout turns', '70', NOT_SAID],
    ]);
    expect(rows[0]?.basis).toMatch(/on this console/);
    expect(rows[1]?.basis).toMatch(/\(shipped\)$/);
  });

  it('sessions per phase are the server’s expected count, never the halves weighted here', () => {
    const sizing = sizingAnswer();
    // (1 − 0.25) × 1.2 + 0.25 × 2.4 is 1.5; the server's 1.75 is what prints.
    sizing.sessions.M = { ...sizing.sessions.M, expected: 1.75 };
    const reading = sizingReading(sizing);
    expect(fact(reading.sessions, 'M')?.value).toBe('1.75 sessions a phase');
    expect(fact(reading.sessions, 'L')?.hint).toMatch(/as shipped$/);
  });

  it('a shipped model says so, and has no per-size peaks to show', () => {
    const sizing = sizingAnswer();
    sizing.context = { ...sizing.context, basis: 'shipped', bootMeasured: null, sizes: [] };
    const reading = sizingReading(sizing);
    expect(fact(reading.context, 'Basis')?.value).toBe('the shipped model: too few sessions here to fit one');
    expect(fact(reading.context, 'Boot')?.hint).toBe('the first call’s context, as shipped');
    expect(reading.peaks).toEqual([]);
  });
});

/* ---------------- this week ---------------- */

describe('this week', () => {
  it('prints every share and hour as the server measured it', () => {
    const facts = weekFacts(weekAnswer().report.metrics);
    expect(fact(facts, 'Stopped')).toEqual({
      label: 'Stopped',
      // 21 of 140 hours is 15 %; the server's own share is what prints, whatever it is.
      value: '15 % of 140 run-hours',
      hint: 'ended by a person 12.5 h, by the console 6 h, by a wait clock 2 h, still stopped 0.5 h',
    });
    expect(fact(facts, 'Spend')?.hint).toBe('over 88 sessions, phantom $2.25 (0.5 %), 3 differ');
    expect(fact(facts, 'Unrun verification')).toEqual({
      label: 'Unrun verification',
      value: '1',
      hint: 'alpha P3',
    });
    expect(fact(facts, 'Context re-read')?.hint).toBe(
      'over 9400 calls in 88 sessions, 65K a call, the boot prefix 48 % of it (70 sessions measured their boot)',
    );
  });

  it('a phase estimate nobody journalled says so, with the baseline it would be scored against', () => {
    const metrics = weekAnswer().report.metrics;
    expect(fact(weekFacts(metrics), 'Phase estimate')).toEqual({
      label: 'Phase estimate',
      value: 'not journalled',
      hint: '40 phases, the recent-median baseline within 2× 71 %, MALE 0.62, and a replay scores today’s estimator',
    });
    const scored = {
      ...metrics,
      phaseEta: { ...metrics.phaseEta, estimator: { ...metrics.phaseEta.baseline, within2: 0.8, male: 0.5 } },
    };
    expect(fact(weekFacts(scored), 'Phase estimate')?.value).toBe('within 2× 80 %, MALE 0.50');
  });

  it('a boot nobody measured is "not measured", never 0 %', () => {
    const metrics = weekAnswer().report.metrics;
    const unmeasured = { ...metrics, context: { ...metrics.context, bootShare: null, bootMeasured: 0 } };
    expect(fact(weekFacts(unmeasured), 'Context re-read')?.hint).toMatch(
      /the boot prefix not measured of it/,
    );
  });
});

/* ---------------- the source ---------------- */

/** Comments stripped: a header that explains the rule is not a breach of it. */
const decommented = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('no sum is made in the browser', () => {
  it('neither the words nor the panels that print them reduce anything', () => {
    for (const file of [
      'model.ts',
      'eta.tsx',
      'cost-vs-caps.tsx',
      'velocity.tsx',
      'session-sizing.tsx',
      'week-report.tsx',
    ]) {
      const code = decommented(readFileSync(join(HERE, file), 'utf8'));
      // The read saw the module, so an empty string cannot pass for a clean one.
      expect(code, file).toMatch(/export function/);
      expect(code, file).not.toContain('.reduce(');
    }
  });
});
