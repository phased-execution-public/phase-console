/**
 * The undriven card (control-tower phase 79, #114, UD-1).
 *
 * What is worth pinning: a phase the board reads in progress that nothing of
 * its live run drives appears on the Runs page, with how long, why and the verb
 * that boards it — and nothing appears when every phase is driven. The list is
 * the server's (`GET /api/runs`' `undriven`), so the card never re-derives it.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const recover = vi.fn(async () => true);
vi.mock('@/lib/run-recover', () => ({ runRecoverVerb: (...args: unknown[]) => recover(...(args as [])) }));

import { UndrivenCard, undrivenOf } from './undriven';
import type { RunState } from '@/lib/api';

const NOW = Date.parse('2026-09-25T06:00:00.000Z');

function run(id: string, slug: string, undriven: RunState['undriven']): RunState {
  return { id, slug, status: 'running', phases: {}, undriven } as unknown as RunState;
}

const RUNS = [
  run('r1', 'alpha', [
    {
      phase: 6,
      since: '2026-09-25T05:30:00.000Z',
      board: 'in-progress',
      situation: null,
      why: 'It is queued with no queue entry behind it.',
    },
  ]),
  run('r2', 'beta', [
    {
      phase: 2,
      since: '2026-09-25T04:00:00.000Z',
      board: 'stuck',
      situation: 'blocked-declared:external',
      why: 'The ladder deferred it to the healer.',
      deferred: {
        next: 'timed-park',
        remaining: ['timed-park'],
        situation: 'blocked-declared:external',
        reason: 'x',
        at: '2026-09-25T04:00:00.000Z',
      },
    },
  ]),
  run('r3', 'gamma', []),
];

describe('undrivenOf', () => {
  it("collects every run's undriven phases, longest-undriven first", () => {
    expect(undrivenOf(RUNS).map((row) => `${row.slug}:${row.phase}`)).toEqual(['beta:2', 'alpha:6']);
    expect(undrivenOf(RUNS)[0].deferredTo).toBe('timed-park');
  });

  it('is empty when every phase is driven', () => {
    expect(undrivenOf([run('r3', 'gamma', []), run('r4', 'delta', undefined)])).toEqual([]);
  });
});

describe('UndrivenCard', () => {
  beforeEach(() => recover.mockClear());

  it('draws nothing when nothing is undriven', () => {
    const { container } = render(<UndrivenCard runs={[run('r3', 'gamma', [])]} allowRun now={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names each phase, how long, why, and the deferred step', () => {
    render(<UndrivenCard runs={RUNS} allowRun now={NOW} />);
    expect(screen.getByText('Nothing is driving these phases')).toBeInTheDocument();
    expect(screen.getByText('The ladder deferred it to the healer.')).toBeInTheDocument();
    expect(screen.getByText('It is queued with no queue entry behind it.')).toBeInTheDocument();
    expect(screen.getByText('timed-park')).toBeInTheDocument();
    expect(screen.getByText(/for 2:00:00|for 2h/)).toBeInTheDocument();
  });

  it("Retry boards the phase through the run's retry verb", () => {
    render(<UndrivenCard runs={RUNS} allowRun now={NOW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry phase 2' }));
    expect(recover).toHaveBeenCalledWith('retry', { slug: 'beta', phase: 2 });
  });

  it('cannot be pressed on a console without --allow-run', () => {
    render(<UndrivenCard runs={RUNS} allowRun={false} now={NOW} />);
    expect(screen.getByRole('button', { name: 'Retry phase 6' })).toBeDisabled();
  });
});
