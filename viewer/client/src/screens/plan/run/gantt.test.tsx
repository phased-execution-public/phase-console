/**
 * When each phase held the lane (7.0, quiet-console phase 12) — every case of
 * the 6.x Gantt's suite, ported. Its job is to draw the projection without
 * adding claims to it, so most of this is about what the chart says ON ITS OWN:
 *
 *   G-1 a row per phase, labelled from the projection, its sentence counting
 *       only the kinds it has time in;
 *   G-2 a lane with two attempts offers their comparison — a kit button, a
 *       thumb high on touch with its row — and nothing pretends to when no
 *       comparison can open;
 *   G-3 each kind paints through its own state class (a down bar a rail, the
 *       neutral, with its cause), an open bar is hatched, and the key names
 *       every kind in words;
 *   G-4 a truncated journal is admitted in a word with its reason on hover,
 *       and the critical path is named in text with the question it answers;
 *   G-5 a live axis advances on a progress frame with no refetch, and the
 *       cost of each attempt rides it on a dollar scale of its own;
 *   G-6 the figure owes its numbers: the attempt costs and the lanes fold
 *       under the key; an empty axis is one line that blames the journal.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { request, media } = vi.hoisted(() => ({ request: vi.fn(), media: { touch: false } }));

vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  return { ...actual, request: (path: string) => request(path) };
});
vi.mock('@/lib/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media')>();
  return { ...actual, useTouch: () => media.touch };
});

import type { RunDetail, RunTimeline, TimelineLane } from '@/data/api';
import { keys, queryClientConfig } from '@/data/keys';
import { applyEffect } from '@/data/live';
import { useRun } from '@/data/runs';
import { expectNoAxeViolations } from '@/test/axe';
import { AXIS } from '@/ui/figures/swimlane';
import { BAR_STYLE, RunGantt, laneLabel, liveNowMs } from './gantt';

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

const rects = (container: HTMLElement) => [...container.querySelectorAll('[role="slider"] rect')];
const painted = (container: HTMLElement, state: string) =>
  rects(container).filter((rect) => rect.getAttribute('class')?.split(' ').includes(state));

describe('G-1 laneLabel and the rows', () => {
  it('names every kind that has time in it, and no kind that does not', () => {
    const text = laneLabel(lane({ phase: 3, waitingMs: 5 * MIN, attempts: 2 }));
    expect(text).toContain('phase 3');
    expect(text).toContain('2 attempts');
    expect(text).toContain('waiting');
    expect(text).not.toContain('frozen');
  });

  it('says so when the journal cut the lane off', () => {
    expect(laneLabel(lane({ phase: 1, partial: true }))).toContain('truncated');
  });

  it('draws a row per phase, labelled from the projection', () => {
    render(<RunGantt timeline={timeline({ lanes: [lane({ phase: 1 }), lane({ phase: 2 })] })} />);
    expect(screen.getByRole('img', { name: /^phase 1:/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /^phase 2:/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'When each phase held the lane' })).toBeInTheDocument();
  });
});

describe('G-2 the comparison', () => {
  it('offers it for a phase with two attempts, and not for one with a single attempt', () => {
    const onCompare = vi.fn();
    render(
      <RunGantt
        timeline={timeline({ lanes: [lane({ phase: 1, attempts: 1 }), lane({ phase: 2, attempts: 3 })] })}
        onCompare={onCompare}
      />,
    );
    expect(screen.queryByRole('button', { name: /Compare phase 1/ })).toBeNull();
    const button = screen.getByRole('button', { name: "Compare phase 2's 3 attempts" });
    expect(button.textContent).toBe('P2×3');
    fireEvent.click(button);
    expect(onCompare).toHaveBeenCalledWith(2);
  });

  it('does not pretend to be clickable when nothing can open the comparison', () => {
    render(<RunGantt timeline={timeline({ lanes: [lane({ phase: 2, attempts: 3 })] })} />);
    expect(screen.queryByRole('button', { name: /P2|phase 2/ })).toBeNull();
    expect(screen.getByText('P2')).toBeInTheDocument();
  });

  it('gives a lane button its thumb on touch, and its row the same height, so the labels stay level', () => {
    media.touch = true;
    try {
      const { container } = render(
        <RunGantt
          timeline={timeline({ lanes: [lane({ phase: 1 }), lane({ phase: 2, attempts: 2 })] })}
          onCompare={() => {}}
        />,
      );
      const labels = [...container.querySelectorAll<HTMLElement>('ol > li')];
      expect(labels.map((li) => li.style.height)).toEqual(['44px', '44px']);
      expect(container.querySelector('[role="slider"] svg')?.getAttribute('height')).toBe(String(AXIS + 88));
      expect(screen.getByRole('button', { name: /Compare phase 2/ }).className).toContain(
        '[@media(hover:none)]:min-h-(--tap-min)',
      );
    } finally {
      media.touch = false;
    }
  });
});

describe('G-3 the bars and their key', () => {
  it('paints queued, down and verifying bars through their own state classes, and a down bar says why (#76)', () => {
    const { container } = render(
      <RunGantt
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
    expect(painted(container, 'state-queued')).toHaveLength(1);
    expect(painted(container, 'state-running')).toHaveLength(1);
    expect(painted(container, 'state-verifying')).toHaveLength(1);
    // A run that was down is history, not a call to act: the neutral, never amber.
    const [down] = painted(container, 'state-skipped');
    expect(down).toBeTruthy();
    expect(painted(container, 'state-needs-you')).toHaveLength(0);
    expect(down!.querySelector('title')?.textContent).toMatch(/run down .*\(halted: plan-lint\)/);
    // …and it is a RAIL, thinner than a bar: held, with nothing running on it.
    const [working] = painted(container, 'state-running');
    expect(Number(down!.getAttribute('height'))).toBeLessThan(Number(working!.getAttribute('height')));
    // The row's sentence counts them.
    expect(screen.getByRole('img', { name: /phase 4: .*queued, .*run down/ })).toBeInTheDocument();
  });

  it('names every kind a bar can be in its key, each beside the paint its bars use', () => {
    render(<RunGantt timeline={timeline()} />);
    const key = screen.getByRole('list', { name: 'Key' });
    expect(key).toHaveAttribute('data-slot', 'legend');
    const items = within(key).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Working',
      'Verifying',
      'Queued',
      'Waiting',
      'Run down',
      'Frozen',
    ]);
    for (const [index, kind] of Object.keys(BAR_STYLE).entries()) {
      const mark = items[index]!.querySelector('i');
      for (const name of BAR_STYLE[kind as keyof typeof BAR_STYLE].state.split(' ')) {
        expect(mark?.classList.contains(name), kind).toBe(true);
      }
    }
  });

  it('hatches an open bar so "worked for" and "has been working for" do not look alike', () => {
    const { container } = render(
      <RunGantt
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
    const hatched = rects(container).filter(
      (rect) => rect.getAttribute('fill') === 'url(#pe-run-gantt-open)',
    );
    expect(hatched).toHaveLength(1);
    expect(container.querySelector('pattern#pe-run-gantt-open')).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Key' })).getByText('Still open')).toBeInTheDocument();
  });
});

describe('G-4 what the chart would otherwise claim silently', () => {
  it('admits a truncated journal in a word, with why on hover — never a badge', () => {
    render(<RunGantt timeline={timeline({ truncated: true, lanes: [lane({ phase: 1, partial: true })] })} />);
    const word = screen.getByTestId('gantt-truncated');
    expect(word).toHaveTextContent('Journal truncated');
    expect(word.title).toMatch(/read as a tail/);
    expect(screen.getByRole('img', { name: /phase 1: .*starts mid-flight/ })).toBeInTheDocument();
  });

  it('says nothing about truncation when the whole journal was read', () => {
    render(<RunGantt timeline={timeline()} />);
    expect(screen.queryByText(/journal truncated/i)).toBeNull();
  });

  it('names the critical path in text as well as drawing it, and says which question it answers', () => {
    const { container } = render(
      <RunGantt
        timeline={timeline({
          criticalPath: [1, 4],
          criticalMs: 45 * MIN,
          lanes: [lane({ phase: 1, critical: true }), lane({ phase: 4, critical: true })],
        })}
      />,
    );
    const line = screen.getByTestId('gantt-critical');
    expect(line).toHaveTextContent('Critical path P1 → P4, 45m');
    // The plan page has a critical path too, and it answers the other question.
    expect(line.title).toMatch(/not the plan/);
    expect(rects(container).filter((rect) => rect.getAttribute('stroke') === 'var(--action)')).toHaveLength(
      2,
    );
    expect(within(screen.getByRole('list', { name: 'Key' })).getByText('Critical path')).toBeInTheDocument();
  });
});

/*
 * The axis of a LIVE run is not a snapshot. A `run:progress` frame is patched
 * into the cache by the event effect; the Gantt reads the cache, so the present
 * moves with no new projection asked for. And the cost of each attempt rides
 * the same axis on a dollar scale of its own.
 */
describe('G-5 a live axis', () => {
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
      request.mockReset();
      const client = new QueryClient({
        ...queryClientConfig,
        defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
      });
      const detail = {
        run: { id: 'r1', slug: 'tower', phases: { '1': { status: 'running', attempts: 1 } } },
      };
      client.setQueryData(keys.run('tower'), detail as unknown as RunDetail);
      const timelineNow = live();
      function Live() {
        const { data } = useRun('tower');
        return <RunGantt timeline={timelineNow} run={data?.run} />;
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
      expect(request).not.toHaveBeenCalled();
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
      <RunGantt
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
    expect(within(container).getByText('Cost')).toBeInTheDocument();
  });

  it("an open window reads its lane's live spend when that is newer", () => {
    const { container } = render(
      <RunGantt
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
    const { container } = render(<RunGantt timeline={timeline()} />);
    expect(container.querySelector('[data-figure="RunCost"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /the attempt costs/i })).toBeNull();
  });
});

describe('G-6 its numbers, and an empty axis', () => {
  it('folds the lanes’ numbers under the key: one row per phase, where its time went', () => {
    render(
      <RunGantt
        timeline={timeline({
          lanes: [
            lane({ phase: 1 }),
            lane({ phase: 2, attempts: 2, partial: true, waitingMs: 5 * MIN, totalMs: 15 * MIN }),
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /the lanes/i }));
    const table = screen.getByRole('table', { name: /numbers behind the lanes/ });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent))).toEqual([
      ['P1', '1', '10m working', '10m'],
      ['P2, starts mid-flight', '2', '10m working, 5m waiting', '15m'],
    ]);
  });

  it('has an empty state that blames the journal rather than the phases, with the way on', () => {
    render(
      <RunGantt
        timeline={timeline({ lanes: [], spanMs: 0 })}
        emptyAction={<a href="#plan">Open the plan</a>}
      />,
    );
    expect(screen.getByText(/Nothing on the axis yet: .*journal/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the plan' })).toBeInTheDocument();
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('is clean to axe', async () => {
    const { container } = render(
      <RunGantt
        timeline={timeline({
          truncated: true,
          criticalPath: [1],
          criticalMs: 10 * MIN,
          lanes: [lane({ phase: 1, critical: true }), lane({ phase: 2, attempts: 2 })],
          series: {
            cost: [{ phase: 1, attempt: 1, startMs: 0, endMs: 10 * MIN, value: 2, open: false }],
            tokens: [],
          },
        })}
        onCompare={() => {}}
      />,
    );
    await expectNoAxeViolations(container);
  });
});
