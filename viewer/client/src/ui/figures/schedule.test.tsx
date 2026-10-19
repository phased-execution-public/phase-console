/**
 * The plan's schedule (one-pool phase 16, #376): what ran comes from the run
 * record, what is left starts once everything it waits on is expected to end
 * and takes its estimate, the chain that sets the finish is outlined and
 * named, and the drawing equals its numbers.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { PlanDetail } from '@/data/api';
import { ScheduleView, recordsOf, scheduleInputOf } from '@/screens/plan/phases/progress';

import { ScheduleFigure, scheduleOf, type ScheduleInput } from './schedule';

const H = 3_600_000;
const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

/*  1 → 2 → 4
 *  1 → 3 ──┘   (4 waits on 2 and 3)          */
const INPUT: ScheduleInput = {
  phases: [
    { phase: 1, title: 'One', state: 'done' },
    { phase: 2, title: 'Two', state: 'in-progress' },
    { phase: 3, title: 'Three', state: 'ready' },
    { phase: 4, title: 'Four', state: 'waiting' },
  ],
  edges: [
    { from: 1, to: 2 },
    { from: 1, to: 3 },
    { from: 2, to: 4 },
    { from: 3, to: 4 },
  ],
  estimates: new Map([
    [1, 1 * H],
    [2, 3 * H],
    [3, 1 * H],
    [4, 2 * H],
  ]),
  records: new Map([
    [1, { startedAt: iso(NOW - 4 * H), endedAt: iso(NOW - 2.5 * H) }],
    [2, { startedAt: iso(NOW - 1 * H) }],
  ]),
  now: NOW,
};

describe('scheduleOf — the arithmetic', () => {
  const schedule = scheduleOf(INPUT);
  const row = (phase: number) => schedule.rows.find((r) => r.phase === phase)!;

  it('reads what ran from the run record', () => {
    expect(row(1).actual).toEqual({ start: NOW - 4 * H, end: NOW - 2.5 * H, open: false });
    expect(row(1).expected).toBeUndefined();
    // Running: so far, then the rest of its estimate.
    expect(row(2).actual).toEqual({ start: NOW - H, end: NOW, open: true });
    expect(row(2).expected).toEqual({ start: NOW, end: NOW + 2 * H });
  });

  it('starts what is left once everything it waits on is expected to end', () => {
    expect(row(3).expected).toEqual({ start: NOW, end: NOW + H });
    // P4 waits on P2 (ends +2h) and P3 (ends +1h): the later sets its start.
    expect(row(4).expected).toEqual({ start: NOW + 2 * H, end: NOW + 4 * H });
    expect(schedule.finishAt).toBe(NOW + 4 * H);
  });

  it('names the chain that sets the finish', () => {
    expect(schedule.criticalPath).toEqual([2, 4]);
    expect(schedule.rows.filter((r) => r.critical).map((r) => r.phase)).toEqual([2, 4]);
    expect(schedule.t0).toBe(NOW - 4 * H);
    expect(schedule.t1).toBe(NOW + 4 * H);
  });

  it('gives a phase with no estimate the plan’s median one, and a plan with none an hour', () => {
    const none = scheduleOf({ ...INPUT, estimates: new Map() });
    const p3 = none.rows.find((r) => r.phase === 3)!;
    expect(p3.expected!.end - p3.expected!.start).toBe(H);
    expect(p3.estimateMs).toBeUndefined();
  });

  it('has nothing to schedule when every phase is done', () => {
    const done = scheduleOf({
      ...INPUT,
      phases: INPUT.phases.map((p) => ({ ...p, state: 'done' })),
      records: new Map(),
    });
    expect(done.finishAt).toBeUndefined();
    expect(done.criticalPath).toEqual([]);
  });
});

describe('<ScheduleFigure>', () => {
  it('draws a lane per phase, done, open and expected each by its own state, and a now line', () => {
    const { container } = render(<ScheduleFigure input={INPUT} />);
    const figure = screen.getByTestId('plan-schedule');
    expect(container.querySelectorAll('rect.state-done').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('rect.state-running').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('rect.state-queued').length).toBe(3);
    expect(within(figure).getByTestId('schedule-critical')).toHaveTextContent('Critical chain P2 → P4');
    expect(within(figure).getByTestId('schedule-finish')).toHaveTextContent(/Expected to finish/);
    // Its numbers, one row per phase.
    fireEvent.click(within(figure).getByRole('button', { name: /The schedule/ }));
    expect(within(figure).getAllByRole('row')).toHaveLength(1 + INPUT.phases.length);
  });
});

describe('the Schedule reading — from the run record', () => {
  const DETAIL = {
    phases: INPUT.phases.map((p) => ({ ...p, size: 'M', weight: 1 })),
    route: { nodes: [], edges: INPUT.edges, layers: 3, rows: 2 },
    eta: { plan: null, perPhase: [...INPUT.estimates].map(([phase, estMs]) => ({ phase, estMs })) },
    cost: {
      phases: [
        {
          phase: 1,
          usd: 1,
          attempts: 1,
          partial: false,
          durationMs: 1.5 * H,
          endedAt: iso(NOW - 2.5 * H),
          runs: 1,
        },
      ],
    },
  } as unknown as PlanDetail;

  it('joins the run record over the cost record', () => {
    const run = { phases: { '2': { phase: 2, startedAt: iso(NOW - H) } } } as never;
    const records = recordsOf(DETAIL, run);
    expect(records.get(1)).toEqual({ startedAt: iso(NOW - 4 * H), endedAt: iso(NOW - 2.5 * H) });
    expect(records.get(2)).toEqual({ startedAt: iso(NOW - H) });
    const input = scheduleInputOf(DETAIL, run, NOW);
    expect(scheduleOf(input).finishAt).toBe(NOW + 4 * H);
  });

  it('renders the reading', () => {
    render(
      <ScheduleView
        detail={DETAIL}
        run={{ phases: { '2': { phase: 2, startedAt: iso(Date.now() - H) } } } as never}
      />,
    );
    expect(screen.getByTestId('plan-schedule')).toBeInTheDocument();
  });
});
