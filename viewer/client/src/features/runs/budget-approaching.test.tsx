/**
 * A budget near its end is drawn with its raise BEFORE the park (control-tower
 * phase 25, #40), worded by the model's own headline.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunState } from '@/lib/api';
import { budgetHeadline, type BudgetFact } from '@shared/budget-model.js';

const { state, runRaiseBudget } = vi.hoisted(() => ({ state: vi.fn(), runRaiseBudget: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, runRaiseBudget } };
});

import { BudgetApproaching, budgetApproaches } from './budget-approaching';

const PHASE_FACT = {
  budget: 'phase-usd',
  phase: 4,
  limit: 10,
  spent: 8.5,
  left: 1.5,
  unit: 'usd',
  spentOn: [],
  at: '2026-09-29T10:00:00.000Z',
} as unknown as BudgetFact;

const RUN = {
  slug: 'demo',
  runId: 'r1',
  status: 'running',
  phases: {
    '4': { phase: 4, status: 'running', budgetApproaching: { 'phase-usd': PHASE_FACT } },
    '2': { phase: 2, status: 'done', budgetApproaching: { 'phase-usd': { ...PHASE_FACT, phase: 2 } } },
  },
} as unknown as RunState;

function mount(run: RunState) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <BudgetApproaching slug="demo" run={run} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.mockResolvedValue({ allowWrites: true, allowRun: true });
  runRaiseBudget.mockResolvedValue({
    ok: true,
    budget: 'phase-usd',
    phase: 4,
    was: 10,
    now: 15,
    retried: false,
  });
});

describe('a budget approaching its end', () => {
  it('is drawn with its headline and its raise before any park — a done phase’s is not', async () => {
    expect(budgetApproaches(RUN)).toHaveLength(1);
    mount(RUN);
    const card = screen.getByTestId('budget-approaching');
    expect(card).toHaveTextContent(`Phase 4: ${budgetHeadline(PHASE_FACT, 'approaching')}`);
    const raise = within(card).getByTestId('budget-raise');
    const step = within(raise).getAllByRole('button')[0]!;
    await waitFor(() => expect(step.hasAttribute('disabled')).toBe(false));
    fireEvent.click(step);
    await waitFor(() =>
      expect(runRaiseBudget).toHaveBeenCalledWith(
        'demo',
        expect.objectContaining({ budget: 'phase-usd', phase: 4 }),
      ),
    );
  });

  it('draws nothing when no budget approaches', () => {
    mount({ ...RUN, phases: {} } as unknown as RunState);
    expect(screen.queryByTestId('budget-approaching')).toBeNull();
  });
});
