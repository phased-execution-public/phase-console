/**
 * A plan in the panel (#360, #361, and the drawer its status opens): the
 * record Inspect hands the shell draws the plan's own status as a badge — in
 * the meta line and on the Overview — leads its Overview with the reasons
 * behind the row's word, and draws the same proportional track the list and
 * the cards draw. The Overview reads the plan itself, so it is mounted the
 * way the shell mounts the panel: inside the app's client and router.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanSummaryFull } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { MemoryRouterProvider } from '@/shell/router';
import { TooltipProvider } from '@/ui/tooltip';
import { toRows } from './model';

const handed = vi.hoisted(() => ({
  record: null as null | { key: string; meta: ReactNode; overview: ReactNode },
}));
vi.mock('@/shell/panel/inspector-host', () => ({
  inspect: (record: { key: string; meta: ReactNode; overview: ReactNode }) => {
    handed.record = record;
  },
}));
vi.mock('@/shell/panel/actions-tab', () => ({ ActionsTab: () => null }));

const { inspectPlan, planRecordKey } = await import('./inspector');

const summary = {
  slug: 'alpha',
  title: 'Alpha plan',
  kind: 'plan',
  status: 'active',
  activity: 0,
  phases: 5,
  done: 2,
  ready: [3],
  waiting: 1,
  inProgress: [4],
  stuck: [],
  percent: 40,
  qaFailures: [],
  locks: [],
  repos: [],
  issues: [],
  issueCounts: { error: 0, warning: 0, info: 0 },
} as unknown as PlanSummaryFull;

beforeEach(() => {
  handed.record = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const path = String(input);
      const body = /^\/api\/plans(\?|$)/.test(path)
        ? [summary]
        : /^\/api\/state(\?|$)/.test(path)
          ? { autopilot: true }
          : /^\/api\/runs/.test(path)
            ? []
            : /^\/api\/inbox/.test(path)
              ? { items: [], generatedAt: new Date().toISOString() }
              : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function drawHanded() {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  const { meta, overview } = handed.record!;
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/plans">
        <TooltipProvider>
          <div data-testid="meta">{meta}</div>
          <div data-testid="overview">{overview}</div>
        </TooltipProvider>
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

describe('a plan in the panel', () => {
  it('is keyed by the plan, so a row can tell it is the one on show', () => {
    const [row] = toRows([summary], [], Date.now());
    inspectPlan(row!, undefined);
    expect(handed.record!.key).toBe(planRecordKey('alpha'));
    expect(planRecordKey('alpha')).toBe('plan:alpha');
  });

  it('draws the plan’s status as a badge, and the counts in proportion', async () => {
    const [row] = toRows([summary], [], Date.now());
    inspectPlan(row!, undefined);
    const view = drawHanded();
    expect(within(view.getByTestId('meta')).getByTestId('plan-mark')).toHaveAttribute('data-chrome', 'badge');
    const overviewEl = view.getByTestId('overview');
    expect(within(overviewEl).getByTestId('plan-status')).toHaveAttribute('data-chrome', 'badge');
    expect(
      within(overviewEl).getByRole('img', {
        name: 'Alpha plan, 5 phases: 2 done, 1 in progress, 1 next up, 1 waiting, 40 %',
      }),
    ).toBeInTheDocument();
  });

  it('leads its Overview with why its status says what it says', async () => {
    const [row] = toRows([summary], [], Date.now());
    inspectPlan(row!, undefined);
    const view = drawHanded();
    const why = view.getByTestId('plan-why');
    expect(within(why).getByRole('heading', { name: 'Why it says Active' })).toBeInTheDocument();
    await waitFor(() =>
      expect(within(why).getByTestId('plan-why-headline')).toHaveTextContent(
        'Nothing is running it, and 1 phase can start: 3.',
      ),
    );
    expect(within(why).getByRole('heading', { name: /What can start next/ })).toBeInTheDocument();
    expect(within(why).getByRole('heading', { name: 'About this plan' })).toBeInTheDocument();
  });
});
