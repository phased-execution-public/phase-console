/**
 * The Gantt's job is to draw the projection without adding claims to it.
 *
 * So the tests are mostly about the three things the chart says ON ITS OWN,
 * beyond the numbers handed to it: that an open bar looks different from a
 * finished one, that a truncated journal is admitted in words, and that a
 * phase with two boardings offers the comparison (exit criterion 2's entry
 * point — a drawer nothing can open is not an offer).
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Gantt, laneLabel, ticksFor } from './gantt';
import type { RunTimeline, TimelineLane } from '@/lib/api';

const MIN = 60_000;

function lane(over: Partial<TimelineLane> & { phase: number }): TimelineLane {
  return {
    bars: [{ kind: 'working', startMs: 0, endMs: 10 * MIN, attempt: 1, open: false }],
    startMs: 0,
    endMs: 10 * MIN,
    totalMs: 10 * MIN,
    workingMs: 10 * MIN,
    verifyingMs: 0,
    waitingMs: 0,
    frozenMs: 0,
    attempts: 1,
    partial: false,
    critical: false,
    ...over,
  };
}

function timeline(over: Partial<RunTimeline> = {}): RunTimeline {
  return {
    startedAt: '2026-08-24T10:00:00.000Z',
    endedAt: '2026-08-24T11:00:00.000Z',
    horizonAt: '2026-08-24T11:00:00.000Z',
    spanMs: 60 * MIN,
    lanes: [lane({ phase: 1 })],
    marks: [],
    criticalPath: [],
    criticalMs: 0,
    truncated: false,
    unmapped: 0,
    ...over,
  };
}

describe('ticksFor', () => {
  it('lands on round units rather than on the span divided by six', () => {
    // 60 minutes over ~6 labels wants 10 min, which is not in the ladder — so
    // it takes the next one up rather than inventing an unreadable 10:00.
    expect(ticksFor(60 * MIN)).toEqual([0, 15 * MIN, 30 * MIN, 45 * MIN, 60 * MIN]);
  });

  it('covers the whole span, always starting at zero', () => {
    const ticks = ticksFor(7 * 60 * MIN);
    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)!).toBeLessThanOrEqual(7 * 60 * MIN);
  });

  it('has nothing to label when nothing has elapsed', () => {
    expect(ticksFor(0)).toEqual([]);
    expect(ticksFor(-1)).toEqual([]);
  });
});

describe('laneLabel', () => {
  it('names every segment that has time in it, and no segment that does not', () => {
    const text = laneLabel(lane({ phase: 3, waitingMs: 5 * MIN, attempts: 2 }));
    expect(text).toContain('phase 3');
    expect(text).toContain('2 attempts');
    expect(text).toContain('waiting');
    expect(text).not.toContain('frozen');
  });

  it('says so when the journal cut the lane off', () => {
    expect(laneLabel(lane({ phase: 1, partial: true }))).toContain('truncated');
  });
});

describe('Gantt', () => {
  it('draws a row per phase, labelled from the projection', () => {
    render(<Gantt timeline={timeline({ lanes: [lane({ phase: 1 }), lane({ phase: 2 })] })} />);
    expect(screen.getByLabelText(/phase 1:/)).toBeTruthy();
    expect(screen.getByLabelText(/phase 2:/)).toBeTruthy();
  });

  it('offers the comparison for a phase with two attempts, and not for one with a single attempt', () => {
    const onCompare = vi.fn();
    render(
      <Gantt
        timeline={timeline({ lanes: [lane({ phase: 1, attempts: 1 }), lane({ phase: 2, attempts: 3 })] })}
        onCompare={onCompare}
      />,
    );
    expect(screen.queryByTitle(/Compare phase 1/)).toBeNull();
    const button = screen.getByTitle(/Compare phase 2/);
    fireEvent.click(button);
    expect(onCompare).toHaveBeenCalledWith(2);
  });

  it('does not pretend to be clickable when nothing can open the drawer', () => {
    render(<Gantt timeline={timeline({ lanes: [lane({ phase: 2, attempts: 3 })] })} />);
    expect(screen.queryByRole('button', { name: /p2/ })).toBeNull();
  });

  it('hatches an open bar so "worked for" and "has been working for" do not look alike', () => {
    const { container } = render(
      <Gantt
        timeline={timeline({
          lanes: [
            lane({
              phase: 1,
              bars: [
                { kind: 'working', startMs: 0, endMs: 5 * MIN, attempt: 1, open: false },
                { kind: 'working', startMs: 5 * MIN, endMs: 20 * MIN, attempt: 1, open: true },
              ],
            }),
          ],
        })}
      />,
    );
    const hatched = [...container.querySelectorAll('rect')].filter(
      (rect) => rect.getAttribute('fill') === 'url(#pe-gantt-open)',
    );
    expect(hatched).toHaveLength(1);
    expect(container.querySelector('pattern#pe-gantt-open')).toBeTruthy();
  });

  it('admits a truncated journal in words, not only as a badge', () => {
    render(<Gantt timeline={timeline({ truncated: true, lanes: [lane({ phase: 1, partial: true })] })} />);
    expect(screen.getByText('journal truncated')).toBeTruthy();
    expect(screen.getByText(/read as a tail/)).toBeTruthy();
  });

  it('says nothing about truncation when the whole journal was read', () => {
    render(<Gantt timeline={timeline()} />);
    expect(screen.queryByText('journal truncated')).toBeNull();
  });

  it('names the critical path in text as well as drawing it', () => {
    render(
      <Gantt
        timeline={timeline({
          criticalPath: [1, 4],
          criticalMs: 45 * MIN,
          lanes: [lane({ phase: 1, critical: true }), lane({ phase: 4, critical: true })],
        })}
      />,
    );
    expect(screen.getByText(/p1 → p4/)).toBeTruthy();
    // And it says which question it answers, since the plan page has a
    // different critical path that answers the other one.
    expect(screen.getByText(/not the plan/)).toBeTruthy();
  });

  it('has an empty state that blames the journal rather than the phases', () => {
    render(<Gantt timeline={timeline({ lanes: [], spanMs: 0 })} />);
    expect(screen.getByText(/Nothing on the axis yet/)).toBeTruthy();
  });
});
