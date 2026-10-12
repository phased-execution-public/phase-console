/**
 * The undriven card (7.0, quiet-console phase 11; the cases of
 * `features/runs/undriven.test.tsx`, control-tower phase 79, #114, UD-1).
 *
 * What is worth pinning: a phase the board reads in progress that nothing of
 * its live run drives appears, with how long, why and the verb that boards it —
 * and nothing appears when every phase is driven. The list is the server's
 * (`GET /api/runs`' `undriven`), or — for a run read alone — the stamps it is
 * folded from, through the same reader; the card never derives its own.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  return { ...actual, post: (path: string, body?: unknown) => post(path, body) };
});

import type { RunState } from '@/data/api';
import { UndrivenCard, undrivenOf } from './undriven';

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
    expect(undrivenOf(RUNS)[0]!.deferredTo).toBe('timed-park');
  });

  it('is empty when every phase is driven', () => {
    expect(undrivenOf([run('r3', 'gamma', []), run('r4', 'delta', undefined)])).toEqual([]);
  });

  it('reads the stamps off a run read alone, which carries no list', () => {
    // `GET /api/run/:slug` is the record: the phases' own stamps, no `undriven`.
    const alone = {
      id: 'r5',
      slug: 'epsilon',
      status: 'running',
      phases: {
        4: {
          phase: 4,
          status: 'pending',
          undriven: {
            since: '2026-09-25T05:00:00.000Z',
            board: 'in-progress',
            situation: null,
            why: 'Nothing boarded it.',
          },
        },
        5: { phase: 5, status: 'running' },
      },
    } as unknown as RunState;
    expect(undrivenOf([alone]).map((row) => `${row.slug}:${row.phase} ${row.why}`)).toEqual([
      'epsilon:4 Nothing boarded it.',
    ]);
    // A stopped run drives nothing, so nothing of it is "undriven".
    expect(undrivenOf([{ ...alone, status: 'finished' } as RunState])).toEqual([]);
  });
});

describe('UndrivenCard', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ run: null });
  });

  it('draws nothing when nothing is undriven', () => {
    const { container } = render(<UndrivenCard runs={[run('r3', 'gamma', [])]} allowRun now={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names each phase, how long, why, and the deferred step — as a summons', () => {
    render(<UndrivenCard runs={RUNS} allowRun now={NOW} />);
    const card = screen.getByTestId('undriven');
    expect(card).toHaveAttribute('data-summons');
    expect(card.textContent).toContain('Needs you');
    expect(screen.getByText('Nothing is driving these phases')).toBeInTheDocument();
    expect(screen.getByText('The ladder deferred it to the healer.')).toBeInTheDocument();
    expect(screen.getByText('It is queued with no queue entry behind it.')).toBeInTheDocument();
    expect(screen.getByText('timed-park')).toBeInTheDocument();
    // Every duration is a labelled clock, never a bare figure.
    expect(screen.getByText('undriven 2h 00m')).toBeInTheDocument();
    expect(screen.getByText('undriven 30m 00s')).toBeInTheDocument();
  });

  it('says one phase as one', () => {
    render(<UndrivenCard runs={[RUNS[0]!]} allowRun now={NOW} />);
    expect(screen.getByText('Nothing is driving this phase')).toBeInTheDocument();
  });

  it("Retry boards the phase through the run's retry verb", async () => {
    render(<UndrivenCard runs={RUNS} allowRun now={NOW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry phase 2' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/run/beta/retry', { phase: 2 }));
  });

  it('cannot be pressed on a console without --allow-run', () => {
    render(<UndrivenCard runs={RUNS} allowRun={false} now={NOW} />);
    const retry = screen.getByRole('button', { name: 'Retry phase 6' });
    expect(retry).toBeDisabled();
    expect(retry.getAttribute('title')).toMatch(/--allow-run/);
  });
});
