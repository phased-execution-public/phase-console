/**
 * The drawer's whole reason to exist is the sentence "attempt 2 differed from
 * attempt 1 in exactly these ways", so the tests are about the ways it can
 * quietly lie:
 *
 *   - printing `$0.00` for a figure that was never recorded;
 *   - reporting a delta between a number and an absence;
 *   - showing the FIRST pair when someone opened it to see the last one.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import type { AttemptComparison, AttemptSummary, PhaseAttempts } from '@/lib/api';

const state: { data: PhaseAttempts | undefined; isLoading: boolean } = { data: undefined, isLoading: false };

vi.mock('@/lib/queries', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  // The drawer's own fetch needs a server; nothing here is about fetching.
  useAttempts: () => state,
}));

const { AttemptCompare } = await import('./attempt-compare');

const MIN = 60_000;

function attempt(over: Partial<AttemptSummary> & { attempt: number }): AttemptSummary {
  return {
    phase: 9,
    startedAt: '2026-08-24T10:00:00.000Z',
    endedAt: '2026-08-24T10:10:00.000Z',
    durationMs: 10 * MIN,
    outcome: 'failed',
    model: 'claude-sonnet-5',
    effort: null,
    costUsd: 1,
    turns: 20,
    sessions: 1,
    rungs: [],
    verification: null,
    said: null,
    ...over,
  };
}

function comparison(over: Partial<AttemptComparison> = {}): AttemptComparison {
  return {
    phase: 9,
    from: 1,
    to: 2,
    outcome: { from: 'failed', to: 'done', changed: true },
    model: { from: 'claude-sonnet-5', to: 'claude-opus-5', changed: true },
    verification: { from: false, to: true, flips: [], unchanged: 2 },
    rungs: { from: [], to: ['escalate'] },
    durationMs: { from: 10 * MIN, to: 14 * MIN, deltaMs: 4 * MIN },
    costUsd: { from: 0.75, to: 2.5, deltaUsd: 1.75 },
    turns: { from: 30, to: 50 },
    ...over,
  };
}

function mount(node: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/** A comparison row, found by its own header — never by a value that repeats. */
const row = (label: string): HTMLElement => screen.getByRole('rowheader', { name: label }).closest('tr')!;

const open = (over: Partial<PhaseAttempts>) => {
  state.data = { runId: 'r1', attempts: [], comparisons: [], ...over };
  state.isLoading = false;
};

describe('AttemptCompare', () => {
  it('names the outcome, the rung, the duration and the spend', () => {
    open({ attempts: [attempt({ attempt: 1 }), attempt({ attempt: 2 })], comparisons: [comparison()] });
    mount(<AttemptCompare slug="demo" phase={9} onClose={() => {}} />);

    // Row-scoped, not `getByText`: "done" and "failed" appear in several places
    // on this drawer, and a test that matches the wrong one passes for the
    // wrong reason.
    expect(row('outcome').textContent).toContain('failed → done');
    expect(row('ladder rungs').textContent).toContain('escalate');
    expect(row('duration').textContent).toContain('10m');
    expect(row('spend').textContent).toContain('$0.75');
    expect(row('spend').textContent).toContain('$2.50');
    expect(row('model').textContent).toContain('claude-opus-5');
  });

  it('shows an unrecorded figure as unrecorded, never as $0.00', () => {
    open({
      attempts: [attempt({ attempt: 1, costUsd: null }), attempt({ attempt: 2 })],
      comparisons: [comparison({ costUsd: { from: null, to: 2.5, deltaUsd: null } })],
    });
    mount(<AttemptCompare slug="demo" phase={9} onClose={() => {}} />);

    expect(screen.getAllByText('not recorded').length).toBeGreaterThan(0);
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('lists every command that flipped, with both exit codes', () => {
    open({
      attempts: [attempt({ attempt: 1 }), attempt({ attempt: 2 })],
      comparisons: [
        comparison({
          verification: {
            from: false,
            to: true,
            unchanged: 1,
            flips: [
              {
                command: 'npm test',
                from: 'fail',
                to: 'pass',
                fromCode: 1,
                toCode: 0,
                fromMs: 4_000,
                toMs: 5_000,
              },
              {
                command: 'npm run typecheck',
                from: 'absent',
                to: 'pass',
                fromCode: null,
                toCode: 0,
                fromMs: null,
                toMs: 2_000,
              },
            ],
          },
        }),
      ],
    });
    mount(<AttemptCompare slug="demo" phase={9} onClose={() => {}} />);

    expect(screen.getByText('npm test')).toBeTruthy();
    expect(screen.getByText('npm run typecheck')).toBeTruthy();
    expect(screen.getByText('1 → 0')).toBeTruthy();
    // A command that only appeared on one side has no exit code to show there.
    expect(screen.getByText('— → 0')).toBeTruthy();
  });

  it('says plainly when nothing flipped, rather than showing an empty table', () => {
    open({ attempts: [attempt({ attempt: 1 }), attempt({ attempt: 2 })], comparisons: [comparison()] });
    mount(<AttemptCompare slug="demo" phase={9} onClose={() => {}} />);
    expect(screen.getByText(/No command changed its result/)).toBeTruthy();
  });

  it('opens on the NEWEST pair, because that is the question being asked', () => {
    open({
      attempts: [attempt({ attempt: 1 }), attempt({ attempt: 2 }), attempt({ attempt: 3 })],
      comparisons: [comparison({ from: 1, to: 2 }), comparison({ from: 2, to: 3 })],
    });
    mount(<AttemptCompare slug="demo" phase={9} onClose={() => {}} />);
    const select = screen.getByLabelText(/Which pair/) as HTMLSelectElement;
    expect(select.value).toBe('1');
    expect(select.options[Number(select.value)]!.textContent).toContain('attempt 2 → 3');
  });

  it('lets the reader step back to an earlier pair', () => {
    open({
      attempts: [attempt({ attempt: 1 }), attempt({ attempt: 2 }), attempt({ attempt: 3 })],
      comparisons: [comparison({ from: 1, to: 2 }), comparison({ from: 2, to: 3 })],
    });
    mount(<AttemptCompare slug="demo" phase={9} onClose={() => {}} />);
    const select = screen.getByLabelText(/Which pair/) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '0' } });
    expect(select.value).toBe('0');
  });

  it('a single boarding has nothing to compare, and says what it did instead', () => {
    open({ attempts: [attempt({ attempt: 1, outcome: 'done' })], comparisons: [] });
    mount(<AttemptCompare slug="demo" phase={9} onClose={() => {}} />);
    expect(screen.getByText(/nothing to compare yet/)).toBeTruthy();
    expect(row('outcome').textContent).toContain('done');
  });

  it('a phase with no boarding in this run says so rather than rendering an empty diff', () => {
    open({ attempts: [], comparisons: [] });
    mount(<AttemptCompare slug="demo" phase={9} onClose={() => {}} />);
    expect(screen.getByText(/No attempts recorded/)).toBeTruthy();
  });

  it('renders nothing while closed', () => {
    open({ attempts: [attempt({ attempt: 1 })], comparisons: [] });
    mount(<AttemptCompare slug="demo" phase={null} onClose={() => {}} />);
    expect(screen.queryByText(/No attempts recorded/)).toBeNull();
  });
});
