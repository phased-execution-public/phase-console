/**
 * A plan in the panel (#360, #361): the record Inspect hands the shell draws
 * the plan's own status as a badge — in the meta line and on the Overview —
 * and the same proportional track the list and the cards draw.
 */

import { render, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PlanSummaryFull } from '@/data/api';
import { TooltipProvider } from '@/ui/tooltip';
import { toRows } from './model';

const handed = vi.hoisted(() => ({ record: null as null | { meta: ReactNode; overview: ReactNode } }));
vi.mock('@/shell/panel/inspector-host', () => ({
  inspect: (record: { meta: ReactNode; overview: ReactNode }) => {
    handed.record = record;
  },
}));
vi.mock('@/shell/panel/actions-tab', () => ({ ActionsTab: () => null }));

const { inspectPlan } = await import('./inspector');

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

describe('a plan in the panel', () => {
  it('draws the plan’s status as a badge, and the counts in proportion', () => {
    const [row] = toRows([summary], [], Date.now());
    inspectPlan(row!, undefined);
    const { meta, overview } = handed.record!;
    const view = render(
      <TooltipProvider>
        <div data-testid="meta">{meta}</div>
        <div data-testid="overview">{overview}</div>
      </TooltipProvider>,
    );
    expect(within(view.getByTestId('meta')).getByTestId('plan-mark')).toHaveAttribute('data-chrome', 'badge');
    const overviewEl = view.getByTestId('overview');
    expect(within(overviewEl).getByTestId('plan-status')).toHaveAttribute('data-chrome', 'badge');
    expect(
      within(overviewEl).getByRole('img', {
        name: 'Alpha plan, 5 phases: 2 done, 1 in progress, 1 next up, 1 waiting, 40 %',
      }),
    ).toBeInTheDocument();
  });
});
