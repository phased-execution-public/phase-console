/**
 * The plan's burn-up (one-pool phase 16, #376): phases and weight done over
 * time, from when each was done, against the plan's whole, with the
 * forecast's band from now — and its numbers.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { PlanDetail } from '@/data/api';
import { BurnupView, burnupInputOf } from '@/screens/plan/phases/progress';

import { BurnupFigure, burnupOf, type BurnupInput } from './burnup';

const D = 86_400_000;
const NOW = Date.parse('2026-10-17T12:00:00.000Z');

const INPUT: BurnupInput = {
  phases: [
    { phase: 1, weight: 1, state: 'done', doneAt: NOW - 3 * D },
    { phase: 2, weight: 3, state: 'done', doneAt: NOW - 1 * D },
    { phase: 3, weight: 2, state: 'done' },
    { phase: 4, weight: 4, state: 'ready' },
  ],
  forecast: {
    earliest: new Date(NOW + D).toISOString(),
    expected: new Date(NOW + 2 * D).toISOString(),
    latest: new Date(NOW + 4 * D).toISOString(),
  },
  now: NOW,
};

describe('burnupOf — the arithmetic', () => {
  const burnup = burnupOf(INPUT);

  it('counts a done phase with no date from the first moment, and says how many', () => {
    expect(burnup.undated).toBe(1);
    expect(burnup.points[0]).toEqual({ at: burnup.t0, phases: 1, weight: 2 });
  });

  it('steps up at each finish, phases and weight both', () => {
    expect(burnup.points.slice(1)).toEqual([
      { at: NOW - 3 * D, phases: 2, weight: 3, phase: 1 },
      { at: NOW - 1 * D, phases: 3, weight: 6, phase: 2 },
    ]);
    expect(burnup.totalPhases).toBe(4);
    expect(burnup.totalWeight).toBe(10);
  });

  it('carries the forecast as a band from now, and none once nothing is left', () => {
    expect(burnup.band).toEqual({ earliest: NOW + D, expected: NOW + 2 * D, latest: NOW + 4 * D });
    expect(burnup.t1).toBeGreaterThan(NOW + 4 * D);
    const finished = burnupOf({ ...INPUT, phases: INPUT.phases.map((p) => ({ ...p, state: 'done' })) });
    expect(finished.band).toBeUndefined();
  });
});

describe('<BurnupFigure>', () => {
  it('draws both series, the band and the summary, painted by state tokens only', () => {
    const { container } = render(<BurnupFigure input={INPUT} />);
    expect(container.querySelector('[data-testid="burnup-phases"]')?.getAttribute('class')).toBe(
      'state-done',
    );
    expect(container.querySelector('[data-testid="burnup-weight"]')?.getAttribute('class')).toBe(
      'state-running',
    );
    expect(container.querySelector('[data-testid="burnup-band"]')).not.toBeNull();
    expect(screen.getByTestId('burnup-summary')).toHaveTextContent(
      '3 of 4 phases done (75%), 60% of the weight',
    );
    expect(screen.getByTestId('burnup-summary')).toHaveTextContent('1 phase done with no record of when');
    for (const el of container.querySelectorAll('svg *')) {
      for (const attr of ['fill', 'stroke']) {
        const value = el.getAttribute(attr);
        if (value) expect(value, `${el.tagName} ${attr}`).toMatch(/^(none|var\(--[a-z-]+\))$/);
      }
    }
    const figure = screen.getByTestId('plan-burnup');
    fireEvent.click(within(figure).getByRole('button', { name: /The points/ }));
    expect(within(figure).getAllByRole('row')).toHaveLength(1 + 3);
  });
});

describe('the Burn-up reading — from the run record', () => {
  it('takes each phase’s finish from the run, else its cost record, else its handoff', () => {
    const detail = {
      phases: [
        { phase: 1, weight: 1, state: 'done', handoff: { completed: '2026-10-10' } },
        { phase: 2, weight: 2, state: 'done' },
        { phase: 3, weight: 1, state: 'done' },
        { phase: 4, weight: 1, state: 'ready' },
      ],
      cost: {
        phases: [
          {
            phase: 2,
            usd: 1,
            attempts: 1,
            partial: false,
            durationMs: 60_000,
            endedAt: '2026-10-12T10:00:00.000Z',
            runs: 1,
          },
        ],
      },
      forecast: null,
    } as unknown as PlanDetail;
    const run = {
      phases: {
        '3': { phase: 3, startedAt: '2026-10-16T09:00:00.000Z', endedAt: '2026-10-16T10:00:00.000Z' },
      },
    } as never;
    const input = burnupInputOf(detail, run, NOW);
    expect(input.phases.map((p) => p.doneAt)).toEqual([
      Date.parse('2026-10-10'),
      Date.parse('2026-10-12T10:00:00.000Z'),
      Date.parse('2026-10-16T10:00:00.000Z'),
      undefined,
    ]);
    render(<BurnupView detail={detail} run={run} />);
    expect(screen.getByTestId('plan-burnup')).toBeInTheDocument();
  });
});
