/**
 * The run's cost strip, held to the figures' two promises.
 *
 * 1. **The numbers table equals the figure.** Every attempt window the strip
 *    draws carries `data-datum`/`data-value`, and the fold under the run's
 *    Gantt is `FigureNumbers` over the same rows; this is what notices the day
 *    a drawing filters, rounds or reorders what its table says.
 * 2. **The interaction vocabulary is the figures' own** on the axis the strip
 *    shares with the lanes: a crosshair a keyboard reaches and reads, and a zoom
 *    whose way back is a button outside the slider. The wheel and the swipe are
 *    `screens/plan/run/timeline.test.tsx`'s (the phase's exit criterion), a real
 *    pinch and a real swipe `e2e/figures.spec.ts`'s: jsdom has no gesture
 *    pipeline to ask.
 *
 * And the strip's own claims: an open window reads pale with a dashed edge —
 * spent so far — and its dollars are labelled inside the plot, as short as
 * they honestly can be. The four figures' half of this suite is beside it, in
 * `figures.test.tsx`.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { RunTimeline, TimelineSeriesPoint } from '@/data/api';
import { RunGantt } from '@/screens/plan/run/gantt';
import { FIGURE_ASCENT, FIGURE_TYPE } from './paint';
import { RunCostChart, dollars } from './run-chart';

const MIN = 60_000;

type Row = [key: string, value: number];

/** The drawing's own rows: every datum it drew, with the value it drew it at. */
function drawn(container: HTMLElement): Row[] {
  return [...container.querySelectorAll<SVGElement>('[data-figure] [data-datum]')].map((node): Row => [
    node.getAttribute('data-datum') ?? '',
    Number(node.getAttribute('data-value')),
  ]);
}

/** The fold's rows: the first cell as the key, the first number in the second as the value. */
function tabulated(container: HTMLElement, fold: RegExp): Row[] {
  fireEvent.click(within(container).getByRole('button', { name: fold }));
  return [...container.querySelectorAll('tbody tr')].map((tr): Row => {
    const cells = tr.querySelectorAll('td');
    return [cells[0]?.textContent ?? '', Number((cells[1]?.textContent ?? '').replace(/[^0-9.]/g, ''))];
  });
}

const sorted = (rows: Row[]) => [...rows].sort(([a], [b]) => a.localeCompare(b));

const COST: TimelineSeriesPoint[] = [
  { phase: 1, attempt: 1, startMs: 0, endMs: 20 * MIN, value: 4.25, open: false },
  { phase: 2, attempt: 1, startMs: 25 * MIN, endMs: 60 * MIN, value: 11, open: false },
];

const TIMELINE: RunTimeline = {
  startedAt: '2026-09-23T10:00:00.000Z',
  endedAt: '2026-09-23T11:00:00.000Z',
  horizonAt: '2026-09-23T11:00:00.000Z',
  spanMs: 60 * MIN,
  lanes: [
    {
      phase: 1,
      bars: [{ kind: 'working', startMs: 0, endMs: 20 * MIN, attempt: 1, open: false }],
      startMs: 0,
      endMs: 20 * MIN,
      totalMs: 20 * MIN,
      workingMs: 20 * MIN,
      verifyingMs: 0,
      queuedMs: 0,
      downMs: 0,
      measuredMs: 20 * MIN,
      waitingMs: 0,
      frozenMs: 0,
      attempts: 1,
      partial: false,
      critical: false,
    },
  ],
  marks: [],
  criticalPath: [],
  criticalMs: 0,
  truncated: false,
  unmapped: 0,
  series: { cost: COST, tokens: [] },
};

describe('the numbers table equals the figure', () => {
  it('the run cost strip: one row per attempt window, at its dollars', () => {
    const { container } = render(<RunGantt timeline={TIMELINE} />);
    const figure = drawn(container);
    expect(figure).toHaveLength(2);
    expect(sorted(tabulated(container, /attempt costs/i))).toEqual(sorted(figure));
  });
});

describe('the strip’s own claims', () => {
  const strip = (points: TimelineSeriesPoint[]) =>
    render(
      <RunCostChart
        points={points}
        view={[0, 60 * MIN]}
        height={40}
        describe={(point) => `P${point.phase} attempt ${point.attempt}`}
      />,
    );

  it('draws an open window pale with a dashed edge — spent so far, not spent', () => {
    const { container } = strip([
      COST[0]!,
      { phase: 2, attempt: 1, startMs: 25 * MIN, endMs: 40 * MIN, value: 3, open: true },
    ]);
    const [closed, open] = [...container.querySelectorAll('[data-datum]')];
    expect(closed!.getAttribute('stroke-dasharray')).toBeNull();
    expect(open!.getAttribute('stroke-dasharray')).toBe('3 2');
    expect(Number(open!.getAttribute('fill-opacity'))).toBeLessThan(
      Number(closed!.getAttribute('fill-opacity')),
    );
    // Paint is the running state's token, never a hue.
    expect(open!.getAttribute('class')).toContain('state-running');
    expect(open!.getAttribute('fill')).toBe('var(--state)');
  });

  it('labels its dollars inside the plot, covering the dearest attempt, as short as they honestly can be', () => {
    const { container } = strip(COST);
    const labels = [...container.querySelectorAll('[data-figure="RunCost"] text')].map((t) => t.textContent);
    expect(labels.at(-1)).toBe('$20');
    expect(dollars(5)).toBe('$5');
    expect(dollars(0.25)).toBe('$0.25');
    expect(container.querySelector('[data-figure="RunCost"]')).toHaveAttribute(
      'aria-label',
      "Cost of each attempt on the run's time axis, the highest $11",
    );
  });

  it('writes its dollars in the figures’ type, each on a line of its own and none cut by the strip’s edge', () => {
    // The Gantt draws the strip 40 px tall; the dearest attempt decides the
    // ladder, and a short strip writes fewer dollars, never smaller ones.
    for (const dearest of [0.4, 1, 4.25, 11, 47, 120, 1234]) {
      const { container, unmount } = render(
        <RunCostChart
          points={[{ phase: 1, attempt: 1, startMs: 0, endMs: 20 * MIN, value: dearest, open: false }]}
          view={[0, 60 * MIN]}
          height={40}
          describe={() => 'P1'}
        />,
      );
      const labels = [...container.querySelectorAll('[data-figure="RunCost"] text')];
      expect(labels.length, `$${dearest}`).toBeGreaterThan(0);
      const baselines = labels.map((label) => {
        expect(label.getAttribute('font-size'), `$${dearest}`).toBe(String(FIGURE_TYPE));
        return Number(label.getAttribute('y')) + Number(label.getAttribute('dy'));
      });
      for (const baseline of baselines) {
        expect(baseline - FIGURE_ASCENT, `$${dearest}: under the strip's top`).toBeGreaterThanOrEqual(0);
      }
      const sorted = [...baselines].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]! - sorted[i - 1]!, `$${dearest}: two dollars a line apart`).toBeGreaterThan(
          FIGURE_ASCENT,
        );
      }
      // The top label still covers the dearest attempt.
      expect(
        Number((labels.at(-1)!.textContent ?? '').replace('$', '')),
        `$${dearest}`,
      ).toBeGreaterThanOrEqual(dearest);
      unmount();
    }
  });
});

describe('one interaction vocabulary, on the axis the strip shares', () => {
  it('the crosshair is a slider a keyboard reaches and reads, and the line under it says the same', () => {
    const { container } = render(<RunGantt timeline={TIMELINE} />);
    const slider = within(container).getByRole('slider');
    expect(slider).toHaveAttribute('tabindex', '0');
    expect(slider.getAttribute('aria-label')).toBeTruthy();
    slider.focus();
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(slider.getAttribute('aria-valuenow')).toBe('0');
    fireEvent.keyDown(slider, { key: 'End' });
    expect(slider.getAttribute('aria-valuenow')).not.toBe('0');
    const readout = container.querySelector('[data-readout]');
    expect(readout?.textContent).toBe(slider.getAttribute('aria-valuetext'));
    // The strip draws the crosshair on its own window too.
    expect(container.querySelector('[data-figure="RunCost"] line[stroke="var(--ink-muted)"]')).not.toBeNull();
  });

  it('+ zooms, 0 resets, and the way back is a button outside the slider', () => {
    const { container } = render(<RunGantt timeline={TIMELINE} />);
    const slider = within(container).getByRole('slider');
    expect(screen.queryByRole('button', { name: /reset zoom/i })).toBeNull();
    fireEvent.keyDown(slider, { key: '+' });
    const reset = screen.getByRole('button', { name: /reset zoom/i });
    expect(slider.contains(reset)).toBe(false);
    fireEvent.keyDown(slider, { key: '0' });
    expect(screen.queryByRole('button', { name: /reset zoom/i })).toBeNull();
  });
});
