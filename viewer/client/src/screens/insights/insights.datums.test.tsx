/**
 * No datum removed from Insights — every figure its panels showed is within TWO
 * interactions (control-tower phase 26, exit criterion 3; `docs/design.md` §5:
 * "No datum removed · every datum within 2 interactions").
 *
 * Phase 26 made the panels glance-first: a status is a badge of the family —
 * a health issue's severity is its word and icon, where the issue's kind was
 * painted by severity in hue alone — and the numbers tables are folded the
 * way a chart's numbers are (`ChartNumbers`): the per-phase spend and each
 * run against its budget sit under a fold named for its rows, one press away,
 * with the tiles above them answering at a glance. This walks each panel's
 * facts and counts the presses to reach them.
 *
 * 7.0 (quiet-console phase 19) keeps every row of that ledger and re-spells
 * only what 7.0 changed, each at its place: separate facts are separate words
 * (a comma, never a middle dot), a phase state is the board model's label, a
 * status is a dot and its word, a size is a one-hue ranked list, and the
 * window's cost is the server's own `total`. The tables are the 7.0 grid,
 * which cuts its columns to the box it measures, so every box is stubbed a
 * desk's 1024 px: every column but the Everything ones fits there, which is
 * where 6.2 drew them.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The server's answers by path (the part before `?`). */
const server = vi.hoisted(() => ({ reads: {} as Record<string, unknown> }));
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  const answer = async (path: string) => {
    const read = server.reads[path.split('?')[0]!];
    if (read !== undefined) return read;
    throw new actual.ApiError(`Nothing is fixtured for ${path}`, 404, path);
  };
  return { ...actual, request: (path: string) => answer(path), post: (path: string) => answer(path) };
});

import type { PlanCost, Portfolio, SpendView } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { setPrefs } from '@/lib/prefs';
import { MemoryRouterProvider } from '@/shell/router';
import { insightsHref } from '@/shell/routes';
import { TooltipProvider } from '@/ui/tooltip';
import { CostVsCapsPanel } from './cost-vs-caps';
import { PlanCostPanel } from './plan-cost';
import { PortfolioPanel } from './portfolio';
import { SessionSizingPanel } from './session-sizing';
import { sizingAnswer, weekAnswer } from './test-answers';
import { WeekReportPanel } from './week-report';

/** What a health row's repair asks of the console: no flag, so its verbs say why they are off. */
const STATE = { allowRun: false, allowWrites: false, allowAgent: false };

/** Built per test, because a lease's countdown is read against the clock at the render. */
const portfolio = (): Portfolio =>
  ({
    generatedAt: Date.parse('2026-09-29T12:00:00Z'),
    totals: {
      plans: 4,
      documents: 0,
      orphans: 0,
      closed: 1,
      // 7.0: the server says how many plans are open, so the page prints it and never subtracts.
      open: 3,
      phases: 20,
      done: 12,
      ready: 2,
      waiting: 4,
      inProgress: 1,
      stuck: 1,
      percent: 60,
      remainingWeight: 320_000,
      remainingSessions: 3,
    },
    byStatus: [
      { status: 'active', count: 3 },
      { status: 'complete', count: 1 },
    ],
    sizeMix: [
      { size: 'S', count: 5 },
      { size: 'M', count: 9 },
      { size: 'L', count: 6 },
    ],
    activeLocks: [
      {
        slug: 'demo',
        phase: 4,
        owner: 'pe-mac-4711-1759000000',
        expired: false,
        closed: false,
        leaseUntil: Date.now() + 20 * 60_000,
      },
      {
        slug: 'old',
        phase: 2,
        owner: 'pe-mac-12-1758000000',
        expired: true,
        closed: false,
        leaseUntil: Date.now() - 60_000,
      },
      {
        slug: 'gone',
        phase: 1,
        owner: 'pe-mac-9-1757000000',
        expired: true,
        closed: true,
        leaseUntil: Date.now() - 60_000,
      },
    ],
    busiest: [
      { slug: 'demo', completions: 7 },
      { slug: 'old', completions: 3 },
    ],
    issues: [
      {
        slug: 'demo',
        phase: 2,
        kind: 'index-drift',
        severity: 'error',
        message: 'INDEX.md reads blocked where the handoff says complete',
      },
      { slug: 'gone', kind: 'orphan-lock', severity: 'info', message: 'a lock on a closed plan' },
    ],
    stalled: [{ slug: 'quiet', ready: [5], days: 9 }],
    velocity: [],
    calendar: [],
    repos: [],
    skills: [],
    models: [],
    qaModes: [],
    qaFailures: [],
    phaseCounts: [],
  }) as unknown as Portfolio;

/** A day the window holds and nothing was spent on — the server sends it, as zeros. */
const quietDay = (day: string) => ({ day, settledUsd: 0, ladderUsd: 0, usd: 0 });

// 7.0: what the server sends — the whole seven-day window, today last, each day
// with its `usd`, the window's `total` and the room left under the cap, every
// sum made by the server (`server/analysis/spend.ts`), none by the panel.
const SPEND: SpendView = {
  today: { settledUsd: 18.25, ladderUsd: 2.5, capUsd: 40, ladderLeftUsd: 37.5 },
  series: [
    quietDay('2026-09-23'),
    quietDay('2026-09-24'),
    quietDay('2026-09-25'),
    quietDay('2026-09-26'),
    quietDay('2026-09-27'),
    quietDay('2026-09-28'),
    { day: '2026-09-29', settledUsd: 18.25, ladderUsd: 2.5, usd: 20.75 },
  ],
  total: { settledUsd: 18.25, ladderUsd: 2.5, usd: 20.75 },
  runs: [
    { runId: 'r1', slug: 'demo', spentUsd: 61.5, budgetUsd: 100 },
    { runId: 'r2', slug: 'quiet', spentUsd: 4, budgetUsd: null },
  ],
};

const COST = {
  slug: 'demo',
  totalUsd: 61.5,
  attributedUsd: 61.5,
  residualUsd: 0,
  ladderUsd: 12,
  partialPhases: [],
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
      runs: 2,
    },
  ],
  byModel: [{ model: 'claude-opus-5', usd: 40, phases: 1 }],
  byDay: [{ day: '2026-09-28', usd: 61.5 }],
  byDayTruncated: false,
  runs: [{ runId: 'run-1', spentUsd: 61.5, budgetUsd: 100, status: 'running' }],
} as unknown as PlanCost;

function mount(ui: ReactNode) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={insightsHref()}>
        <TooltipProvider>{ui}</TooltipProvider>
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

/** Every press is counted; a datum's budget is two. */
let presses = 0;
const press = (name: RegExp) => {
  presses += 1;
  fireEvent.click(screen.getByRole('button', { name }));
};
const onPage = (text: string) => (document.body.textContent ?? '').includes(text);

async function expectWithinTwo(facts: readonly string[]) {
  for (const fact of facts) {
    await waitFor(() => expect(onPage(fact), `"${fact}" is not on the page`).toBe(true));
  }
  expect(presses, `reached in ${presses} presses`).toBeLessThanOrEqual(2);
}

beforeEach(() => {
  presses = 0;
  localStorage.clear();
  setPrefs({ tables: {}, everything: {} });
  // A desk's box everywhere: the grid cuts its columns to the width it measures.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1024);
  server.reads = { '/api/state': STATE };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('every datum of the Insights panels is within two interactions', () => {
  it('the portfolio’s standing facts need no press: plan split, sizes, locks, health, stalled plans', async () => {
    mount(<PortfolioPanel stats={portfolio()} allowWrites={false} closedSlugs={new Set(['gone'])} />);
    await expectWithinTwo([
      // 7.0: two facts are two words, '3 open · 1 closed' → '3 open, 1 closed'.
      '3 open, 1 closed',
      'demo P4',
      'pe-mac-4711-1759000000',
      '20m left',
      'expired',
      'debris',
      'index-drift',
      'demo P2',
      'INDEX.md reads blocked where the handoff says complete',
      'orphan-lock',
      'quiet',
      // 7.0: the same comma, 'P5 ready · idle 9 days' → 'P5 ready, idle 9 days'.
      'P5 ready, idle 9 days',
    ]);
    expect(presses).toBe(0);
  });

  // 7.0: a status is a dot and its word, never an icon (quiet-console phase 4) — "word and icon" → "word and dot".
  it('a health issue’s severity is its word and dot, never the kind painted by hue', async () => {
    mount(<PortfolioPanel stats={portfolio()} allowWrites={false} closedSlugs={new Set(['gone'])} />);
    const error = document.querySelector('[data-vocab="health"][data-status="error"]');
    const info = document.querySelector('[data-vocab="health"][data-status="info"]');
    expect(error?.textContent).toBe('Error');
    expect(info?.textContent).toBe('Info');
    // 7.0: the dot carries the hue where 6.2 drew an icon, `svg` → `[data-dot]`.
    expect(error?.querySelector('[data-dot]')).toBeTruthy();
    // No chip speaks a severity by its tone any more.
    expect(document.querySelectorAll('[data-vocab="health"]')).toHaveLength(2);
  });

  it('the charts’ numbers are one press each: phase states, plan statuses, sizes, busiest plans', async () => {
    mount(<PortfolioPanel stats={portfolio()} allowWrites={false} closedSlugs={new Set()} />);
    press(/^The phase states as numbers/);
    // 7.0: a state is the board model's label (`describeWord('board', …)`), 'done', 'needs you' → 'Done', 'Stuck'.
    await expectWithinTwo(['Done', 'Stuck', '12']);
    presses = 0;
    press(/^The statuses, in full/);
    await expectWithinTwo(['active', 'complete']);
    presses = 0;
    // 7.0: the sizes are a one-hue ranked list, so its fold is "in full" — 'as numbers' → ', in full'.
    press(/^The phase sizes, in full/);
    await expectWithinTwo(['S', 'M', 'L', '9']);
    presses = 0;
    press(/^The plans, in full/);
    await expectWithinTwo(['demo', '7']);
  });

  it('cost against the caps: the tiles need none, and each run against its budget is one press', async () => {
    mount(<CostVsCapsPanel spend={SPEND} />);
    await expectWithinTwo([
      'Settled today',
      '$18.25',
      'Ladder today',
      '$2.50',
      'Day cap',
      '$40.00',
      // 7.0: the window as long as the server's series, at the server's `total` (the fixture says so).
      'Last 7 days',
      '$20.75',
    ]);
    expect(onPage('no budget')).toBe(false);
    press(/^The runs/);
    await expectWithinTwo(['demo', '$61.50', 'of $100.00', 'quiet', 'no budget']);
  });

  it('what this plan cost: the tiles need none, and every phase’s spend, sessions, time and model is one press', async () => {
    mount(<PlanCostPanel slug="demo" cost={COST} forecast={null} />);
    await expectWithinTwo(['Total', '$61.50', 'Dearest phase', '$40.00', 'Ladder', '$12.00']);
    expect(onPage('claude-sonnet-5')).toBe(false);
    press(/^The phases/);
    await expectWithinTwo(['P1', '3 sessions', 'claude-opus-5', 'P2', '$21.50', '2 runs', 'claude-sonnet-5']);
  });

  // quiet-console phase 26: what `GET /api/sizing` says, drawn for the first time.
  it('what a session may spend: the phase caps, the context and sessions per phase need none; the cap table is one press', async () => {
    mount(<SessionSizingPanel sizing={sizingAnswer()} error={null} onRetry={() => {}} />);
    await expectWithinTwo([
      'A phase session runs under 510 turns and $120.00.',
      'p99 337 turns + 50 % — 44 phase sessions on this console, 2026-09-28 → 2026-10-11',
      'p99 $77.81 + 50 % — 274 phase sessions, 2026-09-16 → 2026-09-25 (shipped)',
      '53K + 0.42 × weight',
      '31K',
      '22K',
      'measured over 120 fresh phase sessions',
      'Boot floor: 31K per session',
      '1.10 sessions a phase',
      '1.05 without a context wrap, 2.10 with one, 5 % wrap, measured over 14 finished phases',
      '2.10 sessions a phase',
    ]);
    expect(onPage('closeout turns')).toBe(false);
    press(/^The cap table/);
    await expectWithinTwo(['phase turns', '510', '490', 'phase dollars', 'not measured', 'resume turns']);
    expect(onPage('closeout turns')).toBe(true);
  });

  it('this week: every target’s verdict, sentence and figure need none; every measurement is one press', async () => {
    server.reads['/api/report'] = weekAnswer();
    mount(<WeekReportPanel />);
    await expectWithinTwo([
      'No streak halt from a rescued command, a repeated ending of one phase or a wait-budget refusal',
      '1 of 4 halts; 2 verify-failed from a rescued command',
      'No own-run lane wait reported as contention',
      'Phase ETA: within-2x share at or above the naive baseline, MALE at or below it',
    ]);
    // A dot and a word each: met, missed, nothing to judge.
    expect(
      [...document.querySelectorAll('[data-target] [data-vocab="probe"]')].map((el) => el.textContent),
    ).toEqual(['Fail', 'OK', 'Not asked']);
    expect(onPage('15 % of 140 run-hours')).toBe(false);
    press(/^Every measurement/);
    await expectWithinTwo([
      '15 % of 140 run-hours',
      'ended by a person 12.5 h, by the console 6 h, by a wait clock 2 h, still stopped 0.5 h',
      '3.25 h',
      '$412.50 booked, $410.25 final',
      'phantom $2.25 (0.5 %)',
      '9 episodes, 4.5 h',
      '7 waits, 1.3× off at the median',
      'not journalled',
      'alpha P3',
      '2 of 50 starts differ',
      '610.5M cache-read tokens',
    ]);
  });
});
