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
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { TooltipProvider } from '@/components/ui';
import type { PlanCost, Portfolio, SpendView } from '@/lib/api';
import { queryClientConfig } from '@/lib/queries';
import { CostVsCapsPanel } from './cost-vs-caps';
import { PlanCostPanel } from './plan-cost';
import { PortfolioPanel } from './portfolio';

const PORTFOLIO = {
  generatedAt: Date.parse('2026-09-29T12:00:00Z'),
  totals: {
    plans: 4,
    documents: 0,
    orphans: 0,
    closed: 1,
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
} as unknown as Portfolio;

const SPEND = {
  today: { settledUsd: 18.25, ladderUsd: 2.5, capUsd: 40 },
  series: [{ day: '2026-09-29', settledUsd: 18.25, ladderUsd: 2.5 }],
  runs: [
    { runId: 'r1', slug: 'demo', spentUsd: 61.5, budgetUsd: 100 },
    { runId: 'r2', slug: 'quiet', spentUsd: 4, budgetUsd: null },
  ],
} as unknown as SpendView;

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

function mount(ui: React.ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient(queryClientConfig)}>
      <MemoryRouterProvider initial="#/insights">
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
});

describe('every datum of the Insights panels is within two interactions', () => {
  it('the portfolio’s standing facts need no press: plan split, sizes, locks, health, stalled plans', async () => {
    mount(<PortfolioPanel stats={PORTFOLIO} allowWrites={false} closedSlugs={new Set(['gone'])} />);
    await expectWithinTwo([
      '3 open · 1 closed',
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
      'P5 ready · idle 9 days',
    ]);
    expect(presses).toBe(0);
  });

  it('a health issue’s severity is its word and icon, never the kind painted by hue', async () => {
    mount(<PortfolioPanel stats={PORTFOLIO} allowWrites={false} closedSlugs={new Set(['gone'])} />);
    const error = document.querySelector('[data-vocab="health"][data-status="error"]');
    const info = document.querySelector('[data-vocab="health"][data-status="info"]');
    expect(error?.textContent).toBe('Error');
    expect(info?.textContent).toBe('Info');
    expect(error?.querySelector('svg')).toBeTruthy();
    // No chip speaks a severity by its tone any more.
    expect(document.querySelectorAll('[data-vocab="health"]')).toHaveLength(2);
  });

  it('the charts’ numbers are one press each: phase states, plan statuses, sizes, busiest plans', async () => {
    mount(<PortfolioPanel stats={PORTFOLIO} allowWrites={false} closedSlugs={new Set()} />);
    press(/^The phase states as numbers/);
    await expectWithinTwo(['done', 'needs you', '12']);
    presses = 0;
    press(/^The statuses, in full/);
    await expectWithinTwo(['active', 'complete']);
    presses = 0;
    press(/^The phase sizes as numbers/);
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
});
