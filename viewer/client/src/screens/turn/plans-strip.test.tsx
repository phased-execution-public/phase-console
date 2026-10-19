/**
 * *Where the plans stand* (turn-by-turn phase 9; #366 asked for a bar, #360
 * drew it): each plan the open items name, its board read off the plans list
 * — never recounted — and, since #360, the same proportional track the Plans
 * page draws, its counts in words.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanSummaryFull, TurnItem } from '@/data/api';
import type { TurnAnswer } from '@/data/turn';
import { keys, queryClientConfig } from '@/data/keys';
import { TooltipProvider } from '@/ui/tooltip';
import { PlansStrip, plansStanding } from './plans-strip';

const item = (slug: string) => ({ id: `${slug}-1`, slug }) as unknown as TurnItem;
const answer = {
  groups: { approve: [item('alpha'), item('alpha')], now: [item('beta')] },
} as unknown as Pick<TurnAnswer, 'groups'>;

const alpha = {
  slug: 'alpha',
  title: 'Alpha plan',
  kind: 'plan',
  status: 'active',
  phases: 10,
  done: 4,
  inProgress: [5],
  stuck: [6],
  ready: [7],
  waiting: 3,
  percent: 40,
  qaFailures: [],
} as unknown as PlanSummaryFull;

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })),
  );
});
afterEach(() => vi.unstubAllGlobals());

function mount(plans: unknown[]) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: {
      queries: { ...queryClientConfig.defaultOptions?.queries, retry: false, staleTime: Infinity },
    },
  });
  client.setQueryData(keys.plans(), plans);
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <PlansStrip answer={answer} waitingHref={(slug) => `#/turn?plan=${slug}`} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('where the plans stand', () => {
  it('reads each plan the open items name off the plans list, in the order they stand', () => {
    const standing = plansStanding(answer, [alpha]);
    expect(standing.map((p) => [p.slug, p.done, p.phases, p.waiting])).toEqual([
      ['alpha', 4, 10, 2],
      ['beta', null, null, 1],
    ]);
  });

  it('draws each known plan as the proportional track, its counts in words (#366, #360)', () => {
    mount([alpha]);
    const line = screen.getAllByTestId('turn-plan').find((li) => li.dataset.plan === 'alpha')!;
    const track = within(line).getByRole('img', {
      name: 'Alpha plan, 10 phases: 4 done, 1 in progress, 1 stuck, 1 next up, 3 waiting, 40 %',
    });
    const counts = [...track.querySelectorAll<HTMLElement>('[data-segment]')].map((s) =>
      Number(s.dataset.count),
    );
    expect(counts.reduce((a, b) => a + b, 0)).toBe(10);
    expect(within(line).getByTestId('plan-legend')).toHaveTextContent(
      '4 done · 1 in progress · 1 stuck · 1 next up · 3 waiting · 40 %',
    );
    // A plan the list does not know draws no track — only what waits on you.
    const beta = screen.getAllByTestId('turn-plan').find((li) => li.dataset.plan === 'beta')!;
    expect(within(beta).queryByRole('img')).toBeNull();
    expect(within(beta).getByTestId('turn-plan-waiting')).toHaveTextContent('1 waits on you');
  });
});
