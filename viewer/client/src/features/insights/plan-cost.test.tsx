/**
 * The plan cost card — money, and a date with its reasons attached.
 *
 * Mounted through the destination rather than the panel alone, for the reason
 * `portfolio.test.tsx` gives: the panel's inputs are whatever
 * `#/insights?plan=<slug>` assembles from `/api/plans/<slug>`, and a test that
 * hand-built them would pass while the real page handed over the wrong ones.
 *
 * The three properties worth failing over are all "a number that means one
 * thing being read as another": an unharvested cost printed as `$0.00`, the
 * ladder's dollars added to a total that already contains them, and a finish
 * date shown without what it assumed.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import type { Forecast, PlanCost } from '@/lib/api';
import { costCsv } from './plan-cost';

const { stats, plans, spend, state, plan } = vi.hoisted(() => ({
  stats: vi.fn(),
  plans: vi.fn(),
  spend: vi.fn(),
  state: vi.fn(),
  plan: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, stats, plans, spend, state, plan } };
});

const COST: PlanCost = {
  slug: 'demo',
  totalUsd: 61.5,
  attributedUsd: 61.5,
  residualUsd: 0,
  ladderUsd: 12,
  partialPhases: [3],
  phases: [
    {
      phase: 1,
      usd: 40,
      attempts: 3,
      partial: false,
      durationMs: 7_200_000,
      model: 'claude-opus-5',
      runs: 1,
    },
    {
      phase: 2,
      usd: 21.5,
      attempts: 1,
      partial: false,
      durationMs: 1_800_000,
      model: 'claude-sonnet-5',
      runs: 1,
    },
    { phase: 3, usd: 0, attempts: 1, partial: true, durationMs: 3_600_000, runs: 1 },
  ],
  byModel: [
    { model: 'claude-opus-5', usd: 40, phases: 1 },
    { model: 'claude-sonnet-5', usd: 21.5, phases: 1 },
  ],
  byDay: [
    { day: '2026-08-23', usd: 40 },
    { day: '2026-08-24', usd: 21.5 },
  ],
  byDayTruncated: false,
  runs: [{ runId: 'run-1', spentUsd: 61.5, budgetUsd: 100, status: 'running' }],
};

const FORECAST: Forecast = {
  earliest: '2026-08-26T00:00:00Z',
  expected: '2026-08-28T00:00:00Z',
  latest: '2026-08-30T00:00:00Z',
  basis: 'plan',
  samples: 6,
  remainingPhases: 4,
  remainingWeight: 160_000,
  workingLowMs: 7_200_000,
  workingHighMs: 14_400_000,
  duty: { ratio: 0.25, samples: 6, assumed: false, workingMs: 3_600_000, elapsedMs: 14_400_000 },
  assumptions: [
    'Rate: measured from this plan’s own completed phases (6 completed phases behind it).',
    'Duty cycle: 25% — measured, phases ran for 1 h of the 4 h between this plan’s first and last completion.',
    'Phases are assumed to run one after another. Concurrent lanes finish sooner than this.',
  ],
  label: '~8 h–1 d out',
};

const ROUTE = { segments: ['insights'], query: { plan: 'demo' }, path: 'insights?plan=demo' };

function mount() {
  const client = new QueryClient(queryClientConfig);
  return import('./index').then(({ default: InsightsView }) =>
    render(
      <QueryClientProvider client={client}>
        <InsightsView route={ROUTE} />
      </QueryClientProvider>,
    ),
  );
}

/** The plan detail, with only the fields this page reads. */
const detail = (over: Record<string, unknown> = {}) => ({
  summary: {
    slug: 'demo',
    title: 'Demo',
    kind: 'plan',
    closed: false,
    activity: 1,
    phases: 7,
    done: 3,
    ready: [4],
    waiting: 3,
    inProgress: [],
    stuck: [],
    percent: 43,
    remainingWeight: 160_000,
    remainingSessions: 1,
    criticalPath: [],
    criticalWeight: 0,
    minimumSessions: 1,
    budget: 200_000,
    skills: [],
    mcpServers: [],
    qaMode: 'off',
    qaFailures: [],
    locks: [],
    repos: [],
    handoffCount: 3,
    issues: [],
    issueCounts: { error: 0, warning: 0, info: 0 },
    hasHandoffs: true,
  },
  plan: null,
  phases: [],
  route: { nodes: [], edges: [], layers: 0, rows: 0 },
  batches: null,
  boardText: '',
  lint: null,
  handoffs: [],
  index: [],
  cost: COST,
  forecast: FORECAST,
  qa: [],
  locks: [],
  git: {},
  memory: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  stats.mockResolvedValue({
    generatedAt: Date.parse('2026-08-24T12:00:00Z'),
    totals: {
      plans: 1,
      documents: 0,
      orphans: 0,
      closed: 0,
      phases: 7,
      done: 3,
      ready: 1,
      waiting: 3,
      inProgress: 0,
      stuck: 0,
      percent: 43,
      remainingWeight: 160_000,
      remainingSessions: 1,
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
    qaModes: [],
    qaFailures: [],
    phaseCounts: [],
  });
  plans.mockResolvedValue([{ slug: 'demo', title: 'Demo', kind: 'plan' }]);
  spend.mockResolvedValue({ today: { settledUsd: 0, ladderUsd: 0, capUsd: null }, runs: [], series: [] });
  state.mockResolvedValue({
    autopilot: true,
    allowRun: false,
    allowWrites: false,
    staticRoot: 'dist',
    scriptsDir: '/s',
  });
  plan.mockResolvedValue(detail());
});

afterEach(cleanup);

describe('the plan cost card', () => {
  it('is on the plan-scoped page and reports the total against the runs behind it', async () => {
    await mount();
    expect(await screen.findByText('What this plan cost')).toBeTruthy();
    expect(screen.getAllByText('$61.50').length).toBeGreaterThan(0);
  });

  it('shows the ladder as its own tile and never adds it to the total', async () => {
    await mount();
    await screen.findByText('What this plan cost');
    // $61.50 total, $12 ladder. `$73.50` is the number this panel exists not to
    // print — the same defect the day-cap tile had before P9.
    expect(screen.queryByText('$73.50')).toBeNull();
    expect(screen.getAllByText('$12.00').length).toBeGreaterThan(0);
    expect(screen.getByText(/already inside the total/)).toBeTruthy();
  });

  it('marks a phase whose cost was never harvested rather than printing it as free', async () => {
    await mount();
    await screen.findByText('What this plan cost');
    // The row exists (the phase really ran) and is flagged.
    expect(screen.getByText(/recorded no cost for a session that ran/)).toBeTruthy();
    expect(screen.getAllByText(/^P3$/).length).toBeGreaterThan(0);
    // On the ROW, not merely in the banner above it: the row is where the
    // figure is read, and `$0.00` beside no marker is the whole defect.
    const marks = screen.getAllByTitle('a session ran whose spend was never recorded');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.textContent).toBe('≥');
  });

  it('prints the forecast’s assumptions as text, not as a tooltip', async () => {
    await mount();
    await screen.findByText('Finish date');
    for (const line of FORECAST.assumptions) {
      expect(screen.getByText(line)).toBeTruthy();
    }
    // And keeps working time and calendar time apart: only one of them shrinks
    // when you run more lanes.
    expect(screen.getByText(/of actual running/)).toBeTruthy();
  });

  it('warns when the per-phase figures do not reconcile with the run totals', async () => {
    plan.mockResolvedValue(detail({ cost: { ...COST, attributedUsd: 50, residualUsd: 11.5 } }));
    await mount();
    expect(await screen.findByText(/is not on any phase/)).toBeTruthy();
  });

  it('says nothing rather than zero when the server cannot answer', async () => {
    plan.mockResolvedValue(detail({ cost: undefined, forecast: undefined }));
    await mount();
    expect(await screen.findByText('No cost report')).toBeTruthy();
    expect(screen.queryByText('Finish date')).toBeNull();
  });

  /*
   * The list's own controls. It and the QA list beside it were the only two
   * lists in the console with no order and no bound — which on a long plan
   * means the row you came for is wherever its phase number puts it, past a
   * screenful of rows you did not ask about.
   */
  it('opens dearest-first and can be asked for plan order instead', async () => {
    // The two orders must genuinely disagree, or the control is proved by a
    // fixture rather than by the code: P3 is the dearest and the last phase.
    plan.mockResolvedValue(
      detail({
        cost: {
          ...COST,
          partialPhases: [],
          phases: [
            { phase: 3, usd: 90, attempts: 1, partial: false, durationMs: 60_000, runs: 1 },
            { phase: 1, usd: 40, attempts: 1, partial: false, durationMs: 60_000, runs: 1 },
            { phase: 2, usd: 21.5, attempts: 1, partial: false, durationMs: 60_000, runs: 1 },
          ],
        },
      }),
    );
    await mount();
    await screen.findByText('Per phase');
    const order = () =>
      screen
        .getAllByRole('listitem')
        .map((li) => li.textContent ?? '')
        .filter((text) => /^P\d/.test(text))
        .map((text) => text.slice(0, 2));

    // "Where did the money go" is the question the card answers, so that is
    // the order it opens in.
    expect(order()).toEqual(['P3', 'P1', 'P2']);
    fireEvent.click(screen.getByRole('button', { name: 'Phase' }));
    expect(order()).toEqual(['P1', 'P2', 'P3']);
    fireEvent.click(screen.getByRole('button', { name: 'Cost' }));
    expect(order()).toEqual(['P3', 'P1', 'P2']);
  });

  it('shows the first twenty phases and asks before printing the rest', async () => {
    const phases = Array.from({ length: 25 }, (_, i) => ({
      phase: i + 1,
      usd: 25 - i,
      attempts: 1,
      partial: false,
      durationMs: 60_000,
      runs: 1,
    }));
    plan.mockResolvedValue(detail({ cost: { ...COST, phases, partialPhases: [] } }));
    await mount();
    await screen.findByText('Per phase');

    const listed = () =>
      screen
        .getAllByRole('listitem')
        .map((li) => li.textContent ?? '')
        .filter((text) => /^P\d/.test(text)).length;
    expect(listed()).toBe(20);

    fireEvent.click(screen.getByRole('button', { name: 'Show all 25' }));
    expect(listed()).toBe(25);
    fireEvent.click(screen.getByRole('button', { name: 'Show the first 20' }));
    expect(listed()).toBe(20);
  });

  it('offers a way forward when no phase has cost anything', async () => {
    plan.mockResolvedValue(
      detail({ cost: { ...COST, phases: [], partialPhases: [], byModel: [], byDay: [] } }),
    );
    await mount();
    expect(await screen.findByText('No phase has cost anything yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the autopilot' })).toHaveAttribute(
      'href',
      '#/plan/demo/run',
    );
  });

  it('is absent from the portfolio scope, where there is no plan to cost', async () => {
    const client = new QueryClient(queryClientConfig);
    const { default: InsightsView } = await import('./index');
    render(
      <QueryClientProvider client={client}>
        <InsightsView route={{ segments: ['insights'], query: {}, path: 'insights' }} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('What it costs')).toBeTruthy();
    expect(screen.queryByText('What this plan cost')).toBeNull();
  });
});

describe('the CSV export', () => {
  it('names its units and carries the partial flag — a floor exported as a total is the same lie', () => {
    const csv = costCsv(COST);
    const [header, ...rows] = csv.trim().split('\n');
    expect(header).toBe('phase,usd,partial,sessions,runs,seconds,model,status,ended_at');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe('1,40,false,3,1,7200,claude-opus-5,,');
    expect(rows[2]).toBe('3,0,true,1,1,3600,,,');
    expect(csv.endsWith('\n')).toBe(true);
  });

  it('quotes a field that would otherwise break the row', () => {
    const csv = costCsv({
      ...COST,
      phases: [{ phase: 1, usd: 1, attempts: 1, partial: false, durationMs: 0, model: 'a,b"c', runs: 1 }],
    });
    expect(csv.split('\n')[1]).toBe('1,1,false,1,1,0,"a,b""c",,');
  });
});
