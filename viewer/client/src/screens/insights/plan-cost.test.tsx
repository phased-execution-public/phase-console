/**
 * What this plan cost — money, and a date with its reasons attached.
 *
 * Mounted through the destination rather than the panel alone, for the reason
 * `portfolio.test.tsx` gives: the panel's inputs are whatever
 * `#/insights?plan=<slug>` assembles from `/api/plans/<slug>`, and a test that
 * hand-built them would pass while the real page handed over the wrong ones.
 * The server answers by path through `@/data/http`, the one door every hook
 * under `data/` reads through.
 *
 * The three properties worth failing over are all "a number that means one
 * thing being read as another": an unharvested cost printed as `$0.00`, the
 * ladder's dollars added to a total that already contains them, and a finish
 * date shown without what it assumed.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The server's answers by path (the part before `?`). */
const server = vi.hoisted(() => ({ reads: {} as Record<string, unknown> }));
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  const answer = async (path: string) => {
    const read = server.reads[path.split('?')[0]!];
    if (typeof read === 'function') return (read as (path: string) => unknown)(path);
    if (read !== undefined) return read;
    throw new actual.ApiError(`Nothing is fixtured for ${path}`, 404, path);
  };
  return { ...actual, request: (path: string) => answer(path), post: (path: string) => answer(path) };
});

import type { Forecast, PlanCost, Portfolio } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { setPrefs } from '@/lib/prefs';
import { MemoryRouterProvider } from '@/shell/router';
import { parseHash, type Route } from '@/shell/routes';
import { TooltipProvider } from '@/ui/tooltip';
import InsightsView from './index';
import { costCsv } from './plan-cost';

vi.setConfig({ testTimeout: 20_000 });

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
  clock: 'calendar',
  calendar: 'known',
  basis: 'plan',
  samples: 6,
  missing: 0,
  remainingPhases: 4,
  remainingWeight: 160_000,
  workingLowMs: 7_200_000,
  workingHighMs: 14_400_000,
  duty: { ratio: 0.25, samples: 6, known: true, workingMs: 3_600_000, elapsedMs: 14_400_000 },
  assumptions: [
    'Rate: measured from this plan’s own completed phases (6 measured phases weighted).',
    'Duty cycle: 25% — measured, phases ran for 1 h of the 4 h between this plan’s first and last completion.',
    'Phases are assumed to run one after another. Concurrent lanes finish sooner than this.',
  ],
  label: '~8 h–1 d on the calendar',
};

/** The same forecast with no measurable duty cycle — no date, working estimate stands. */
const UNKNOWN_FORECAST: Forecast = {
  clock: 'calendar',
  calendar: 'unknown',
  basis: 'plan',
  samples: 6,
  missing: 0,
  remainingPhases: 4,
  remainingWeight: 160_000,
  workingLowMs: 7_200_000,
  workingHighMs: 14_400_000,
  duty: { ratio: 1, samples: 0, known: false, reason: 'too-few', workingMs: 0, elapsedMs: 0 },
  assumptions: [
    'Rate: measured from this plan’s own completed phases (6 measured phases weighted).',
    'Duty cycle: unknown — fewer than three of this plan’s phases finished in the recent window.',
    'Phases are assumed to run one after another. Concurrent lanes finish sooner than this.',
  ],
  label: 'calendar time unknown',
};

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

const STATS: Portfolio = {
  generatedAt: Date.parse('2026-08-24T12:00:00Z'),
  totals: {
    plans: 1,
    documents: 0,
    orphans: 0,
    closed: 0,
    open: 1,
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
};

function mount(address = '#/insights?plan=demo') {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={address}>
        <TooltipProvider>
          <InsightsView route={parseHash(address) as Route} />
        </TooltipProvider>
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

/** The card, once the plan's detail has answered. */
const card = () => screen.findByTestId('insights-plan-cost');

/** A fact row's value cell — the figure and, beside it, what the figure is. */
const fact = (scope: HTMLElement, label: string) =>
  within(scope).getByText(label).nextElementSibling as HTMLElement;

/**
 * The per-phase rows are the card's numbers, folded as a figure's are
 * (control-tower phase 26): one press on the fold opens them.
 */
const openPhases = (scope: HTMLElement) =>
  fireEvent.click(within(scope).getByRole('button', { name: /^The phases/ }));

/** The phases as the grid draws them, top to bottom — each row's link to its phase. */
const order = () =>
  within(screen.getByRole('table', { name: "Each phase's cost, over every attempt" }))
    .getAllByRole('link', { name: /^P\d+$/ })
    .map((link) => link.textContent);

beforeEach(() => {
  localStorage.clear();
  setPrefs({ tables: {}, everything: {} });
  // A 400 px box, as the Repo ledger stubs it: the grid cuts its columns to
  // the width it measures, and the phase and its cost stay on the row.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
  server.reads = {
    '/api/stats': STATS,
    '/api/plans': [{ slug: 'demo', title: 'Demo', kind: 'plan' }],
    '/api/plans/demo': detail(),
    '/api/spend': { today: { settledUsd: 0, ladderUsd: 0, capUsd: null }, runs: [], series: [] },
    '/api/state': {
      autopilot: true,
      allowRun: false,
      allowWrites: false,
      staticRoot: 'dist',
      scriptsDir: '/s',
    },
    '/api/ledger': { plans: [], accounts: [], truncatedRuns: 0, unknownSessions: 0 },
  };
});

afterEach(() => vi.restoreAllMocks());

describe('the plan cost card', () => {
  it('is on the plan-scoped page and reports the total against the runs behind it', async () => {
    mount();
    expect(await screen.findByText('What this plan cost')).toBeTruthy();
    const total = fact(await card(), 'Total');
    expect(within(total).getByText('$61.50')).toBeTruthy();
    expect(within(total).getByText('across 1 run')).toBeTruthy();
  });

  it('shows the ladder as its own figure and never adds it to the total', async () => {
    mount();
    const cost = await card();
    // $61.50 total, $12 ladder. `$73.50` is the number this panel exists not to
    // print — the same defect the day-cap tile had before P9.
    expect(document.body.textContent).not.toContain('$73.50');
    const ladder = fact(cost, 'Ladder');
    expect(within(ladder).getByText('$12.00')).toBeTruthy();
    expect(within(ladder).getByText(/already inside the total/)).toBeTruthy();
  });

  it('marks a phase whose cost was never harvested rather than printing it as free', async () => {
    mount();
    const cost = await card();
    // The row exists (the phase really ran) and is flagged.
    expect(within(cost).getByText(/^1 phase recorded no cost for a session that ran \(P3\)/)).toBeTruthy();
    openPhases(cost);
    expect(order()).toContain('P3');
    // On the ROW, not merely in the banner above it: the row is where the
    // figure is read, and `$0.00` beside no marker is the whole defect.
    const marks = screen.getAllByTitle('A session ran whose spend was never recorded');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.textContent).toBe('≥');
    expect(within(marks[0]!.closest('tr')!).getByRole('link', { name: 'P3' })).toBeTruthy();
  });

  it('prints the forecast’s assumptions as text, not as a tooltip', async () => {
    mount();
    await screen.findByText('Finish date');
    for (const line of FORECAST.assumptions) {
      expect(screen.getByText(line)).toBeTruthy();
    }
    expect(screen.getByText('Expected')).toBeTruthy();
    // And keeps working time and calendar time apart: only one of them shrinks
    // when you run more lanes.
    expect(screen.getByText('Working time').nextElementSibling?.textContent).toBe('2h to 4h of work');
  });

  it('shows no date and shows its label when the calendar is unknown', async () => {
    // A duty cycle with nothing to measure has no date at all — never one
    // rendered off an idle ratio. The working estimate still stands.
    server.reads['/api/plans/demo'] = detail({ forecast: UNKNOWN_FORECAST });
    mount();
    const cost = await card();
    await screen.findByText('Finish date');
    const finish = fact(cost, 'Finish');
    expect(within(finish).getByText('unknown')).toBeTruthy();
    expect(within(finish).getByText('calendar time unknown')).toBeTruthy();
    expect(screen.queryByText('Earliest')).toBeNull();
    expect(screen.queryByText('Expected')).toBeNull();
    expect(screen.queryByText('Latest')).toBeNull();
    for (const line of UNKNOWN_FORECAST.assumptions) {
      expect(screen.getByText(line)).toBeTruthy();
    }
  });

  it('warns when the per-phase figures do not reconcile with the run totals', async () => {
    server.reads['/api/plans/demo'] = detail({ cost: { ...COST, attributedUsd: 50, residualUsd: 11.5 } });
    mount();
    expect(
      await screen.findByText(
        /^\$11\.50 of this plan’s spend is on no phase: \$61\.50 spent, \$50\.00 attributed/,
      ),
    ).toBeTruthy();
  });

  it('says nothing rather than zero when the server cannot answer', async () => {
    server.reads['/api/plans/demo'] = detail({ cost: undefined, forecast: undefined });
    mount();
    expect(await screen.findByText(/^No cost report:/)).toBeTruthy();
    expect(screen.queryByText('Finish date')).toBeNull();
    expect(document.querySelector('[data-insight="plan-cost"]')?.textContent).not.toContain('$0.00');
  });

  /*
   * The list's own order. It and the QA list beside it were the only two lists
   * in the console with no order — which on a long plan means the row you came
   * for is wherever its phase number puts it, past a screenful of rows you did
   * not ask about. Since 7.0 the order is the grid's column sort.
   */
  it('opens dearest-first and can be asked for plan order instead', async () => {
    // The two orders must genuinely disagree, or the control is proved by a
    // fixture rather than by the code: P3 is the dearest and the last phase.
    server.reads['/api/plans/demo'] = detail({
      cost: {
        ...COST,
        partialPhases: [],
        phases: [
          { phase: 3, usd: 90, attempts: 1, partial: false, durationMs: 60_000, runs: 1 },
          { phase: 1, usd: 40, attempts: 1, partial: false, durationMs: 60_000, runs: 1 },
          { phase: 2, usd: 21.5, attempts: 1, partial: false, durationMs: 60_000, runs: 1 },
        ],
      },
    });
    mount();
    const cost = await card();
    openPhases(cost);

    // "Where did the money go" is the question the card answers, so that is
    // the order it opens in.
    expect(order()).toEqual(['P3', 'P1', 'P2']);
    fireEvent.click(within(cost).getByRole('button', { name: 'Phase' }));
    expect(order()).toEqual(['P1', 'P2', 'P3']);
    fireEvent.click(within(cost).getByRole('button', { name: 'Cost' }));
    expect(order()).toEqual(['P3', 'P1', 'P2']);
  });

  // Replaces 6.2's "shows the first twenty phases and asks before printing the
  // rest": 7.0 dropped the twenty-row bound; the fold is what asks first.
  it('folds every phase behind one press that says how many, and draws them all once open', async () => {
    const phases = Array.from({ length: 25 }, (_, i) => ({
      phase: i + 1,
      usd: 25 - i,
      attempts: 1,
      partial: false,
      durationMs: 60_000,
      runs: 1,
    }));
    server.reads['/api/plans/demo'] = detail({ cost: { ...COST, phases, partialPhases: [] } });
    mount();
    const cost = await card();
    const fold = within(cost).getByRole('button', { name: /^The phases/ });
    expect(fold).toHaveTextContent('(25)');
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(within(cost).queryByRole('table')).toBeNull();

    fireEvent.click(fold);
    expect(order()).toHaveLength(25);
    fireEvent.click(within(cost).getByRole('button', { name: 'Hide the phases' }));
    expect(within(cost).queryByRole('table')).toBeNull();
  });

  it('offers a way forward when no phase has cost anything', async () => {
    server.reads['/api/plans/demo'] = detail({
      cost: { ...COST, phases: [], partialPhases: [], byModel: [], byDay: [] },
    });
    mount();
    const cost = await card();
    expect(within(cost).getByText(/^No phase has cost anything yet/)).toBeTruthy();
    expect(within(cost).getByRole('link', { name: 'Open the run' })).toHaveAttribute(
      'href',
      '#/plan/demo/run',
    );
  });

  it('is absent from the portfolio scope, where there is no plan to cost', async () => {
    mount('#/insights');
    expect(await screen.findByTestId('insights-cost')).toBeTruthy();
    expect(screen.getByText('What it costs')).toBeTruthy();
    expect(screen.queryByText('What this plan cost')).toBeNull();
    expect(screen.queryByTestId('insights-plan-cost')).toBeNull();
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
