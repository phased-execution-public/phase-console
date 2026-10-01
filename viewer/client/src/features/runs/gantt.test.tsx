/**
 * The Gantt's job is to draw the projection without adding claims to it.
 *
 * So the tests are mostly about the three things the chart says ON ITS OWN,
 * beyond the numbers handed to it: that an open bar looks different from a
 * finished one, that a truncated journal is admitted in words, and that a
 * phase with two boardings offers the comparison (exit criterion 2's entry
 * point — a drawer nothing can open is not an offer).
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { Gantt, laneLabel, liveNowMs, ticksFor } from './gantt';
import type { RunDetail, RunTimeline, TimelineLane } from '@/lib/api';
import { applyEffect, keys } from '@/lib/queries';

const MIN = 60_000;

function lane(over: Partial<TimelineLane> & { phase: number }): TimelineLane {
  return {
    bars: [{ kind: 'working', startMs: 0, endMs: 10 * MIN, attempt: 1, open: false }],
    startMs: 0,
    endMs: 10 * MIN,
    totalMs: 10 * MIN,
    workingMs: 10 * MIN,
    verifyingMs: 0,
    queuedMs: 0,
    waitingMs: 0,
    downMs: 0,
    frozenMs: 0,
    measuredMs: 10 * MIN,
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

  it('paints queued, down and verifying bars through their own state classes, and a down bar says why (#76)', () => {
    const { container } = render(
      <Gantt
        timeline={timeline({
          lanes: [
            lane({
              phase: 4,
              bars: [
                { kind: 'queued', startMs: 0, endMs: 5 * MIN, attempt: 0, open: false },
                { kind: 'working', startMs: 5 * MIN, endMs: 20 * MIN, attempt: 1, open: false },
                { kind: 'verifying', startMs: 20 * MIN, endMs: 25 * MIN, attempt: 1, open: false },
                {
                  kind: 'down',
                  startMs: 26 * MIN,
                  endMs: 50 * MIN,
                  attempt: 1,
                  open: false,
                  note: 'halted: plan-lint',
                },
              ],
              queuedMs: 5 * MIN,
              workingMs: 15 * MIN,
              verifyingMs: 5 * MIN,
              downMs: 24 * MIN,
            }),
          ],
        })}
      />,
    );
    const rects = [...container.querySelectorAll('rect')];
    const painted = (state: string) => rects.filter((rect) => rect.classList.contains(state));
    expect(painted('state-queued')).toHaveLength(1);
    expect(painted('state-running')).toHaveLength(1);
    expect(painted('state-verifying')).toHaveLength(1);
    // A run that was down is history, not a call to act: the neutral, never amber.
    const [down] = painted('state-skipped');
    expect(down).toBeTruthy();
    expect(painted('state-needs-you')).toHaveLength(0);
    expect(down!.querySelector('title')?.textContent).toMatch(/run down .*\(halted: plan-lint\)/);
    // …and it is a RAIL, thinner than a bar: held, with nothing running on it.
    const [working] = painted('state-running');
    expect(Number(down!.getAttribute('height'))).toBeLessThan(Number(working!.getAttribute('height')));
    // The key names every kind a bar can be, and the row's sentence counts them.
    for (const label of ['working', 'verifying', 'queued', 'waiting', 'run down', 'frozen']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByLabelText(/phase 4: .*queued, .*run down/)).toBeTruthy();
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

/*
 * #32 gap 1 (control-tower phase 29): the axis of a LIVE run is not a
 * snapshot. A `run:progress` frame is already patched into the cache by the
 * event effect; the Gantt reads the cache, so the present moves with no new
 * projection asked for. And the cost of each attempt rides the same axis on a
 * dollar scale of its own.
 */
describe('a live axis', () => {
  const T0 = '2026-09-23T10:00:00.000Z';
  const live = (over: Partial<RunTimeline> = {}) =>
    timeline({
      startedAt: T0,
      endedAt: null,
      horizonAt: '2026-09-23T10:30:00.000Z',
      asOf: '2026-09-23T10:30:00.000Z',
      spanMs: 30 * MIN,
      lanes: [
        lane({ phase: 1, bars: [{ kind: 'working', startMs: 0, endMs: 30 * MIN, attempt: 1, open: true }] }),
      ],
      ...over,
    });

  it('advances on a run:progress frame, with no refetch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-23T10:30:00.000Z'));
      const client = new QueryClient();
      const queryFn = vi.fn();
      const detail = {
        run: { id: 'r1', slug: 'tower', phases: { '1': { status: 'running', attempts: 1 } } },
      };
      client.setQueryData(keys.run('tower'), detail as unknown as RunDetail);
      const timelineNow = live();
      function Live() {
        const { data } = useQuery({ queryKey: keys.run('tower'), queryFn, staleTime: Infinity });
        return <Gantt timeline={timelineNow} run={(data as RunDetail | undefined)?.run} />;
      }
      const { container } = render(
        <QueryClientProvider client={client}>
          <Live />
        </QueryClientProvider>,
      );
      const now = () => Number(container.querySelector('[data-now-ms]')?.getAttribute('data-now-ms'));
      expect(now()).toBe(30 * MIN);

      vi.setSystemTime(new Date('2026-09-23T10:42:00.000Z'));
      act(() => {
        applyEffect(client, 'run:progress', {
          slug: 'tower',
          runId: 'r1',
          phase: 1,
          status: 'running',
          attempt: 1,
          spentUsd: 2.5,
        });
      });
      await waitFor(() => expect(now()).toBe(42 * MIN));
      // The open bar grew to the present with it, and nothing was fetched.
      expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toMatch(/now \(42m/);
      expect(queryFn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a finished run has an end, not a present', () => {
    expect(liveNowMs(timeline())).toBeUndefined();
    expect(liveNowMs(live())).toBe(30 * MIN);
    // A frame seen after the projection moves the present on; an older one does not.
    expect(liveNowMs(live(), Date.parse('2026-09-23T10:35:00.000Z'))).toBe(35 * MIN);
    expect(liveNowMs(live(), Date.parse('2026-09-23T10:20:00.000Z'))).toBe(30 * MIN);
  });

  it('carries a cost axis from series.cost, on a dollar scale of its own', () => {
    const { container } = render(
      <Gantt
        timeline={timeline({
          series: {
            cost: [{ phase: 1, attempt: 1, startMs: 0, endMs: 10 * MIN, value: 12, open: false }],
            tokens: [],
          },
        })}
      />,
    );
    const strip = container.querySelector('[data-figure="RunCost"]');
    expect(strip).not.toBeNull();
    // Readable: round dollars covering the dearest attempt, not twelve ticks.
    expect([...strip!.querySelectorAll('text')].map((t) => t.textContent)).toEqual(['$10', '$20']);
    expect(within(container).getByText('cost')).toBeInTheDocument();
  });

  it("an open window reads its lane's live spend when that is newer", () => {
    const { container } = render(
      <Gantt
        timeline={live({
          series: {
            cost: [{ phase: 1, attempt: 1, startMs: 0, endMs: 30 * MIN, value: 1, open: true }],
            tokens: [],
          },
        })}
        run={{ phases: { '1': { live: { spentUsd: 3.5 } } } } as unknown as RunDetail['run']}
      />,
    );
    expect(container.querySelector('[data-figure="RunCost"] [data-datum]')?.getAttribute('data-value')).toBe(
      '3.5',
    );
  });

  it('draws nothing on the cost axis for a console that sent no series', () => {
    const { container } = render(<Gantt timeline={timeline()} />);
    expect(container.querySelector('[data-figure="RunCost"]')).toBeNull();
  });
});
