/**
 * The figures chunk, held to its two promises (control-tower phase 29).
 *
 * 1. **The numbers table equals the figure** — for all four `CHART_FIGURES`
 *    and for the run's cost strip. Every drawn datum carries
 *    `data-datum`/`data-value`; the fold under it is `ChartNumbers`. They are
 *    built from the same rows, and this is what notices the day they are not:
 *    a drawing that filters, rounds or reorders what its table says.
 * 2. **The interaction vocabulary is the same on each figure** — a crosshair a
 *    keyboard reaches, a zoom that ⌃/⌘ + wheel drives and a plain wheel does
 *    not, and `touch-action: pan-y` so a vertical swipe stays the page's. A
 *    real pinch and a real swipe are `e2e/figures.spec.ts`'s: jsdom has no
 *    gesture pipeline to ask.
 */

import type { ReactElement } from 'react';
import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BarList, Bars, CHART_FIGURES, Calendar, StackBar } from '@/components/charts';
import { Gantt } from '@/features/runs/gantt';
import type { RunTimeline } from '@/lib/api';

const MIN = 60_000;

/** Today and two days back, so the Calendar's window always holds them. */
const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);

const SAMPLES: Record<(typeof CHART_FIGURES)[number], ReactElement> = {
  Bars: (
    <Bars
      data={[
        { week: '2026-W36', count: 2 },
        { week: '2026-W37', count: 0 },
        { week: '2026-W38', count: 7 },
      ]}
      label="phases"
    />
  ),
  Calendar: (
    <Calendar
      data={[
        { date: day(0), count: 3 },
        { date: day(2), count: 1 },
        { date: day(400), count: 9 },
      ]}
    />
  ),
  BarList: (
    <BarList
      items={[
        { name: 'phased-execution', value: 12 },
        { name: 'phase-console-site', value: 3 },
      ]}
      unit=" USD"
      label="repos"
    />
  ),
  StackBar: (
    <StackBar
      segments={[
        { label: 'done', value: 9, tone: 'done' },
        { label: 'waiting', value: 2, tone: 'waiting' },
        { label: 'failed', value: 1, tone: 'failed' },
      ]}
      label="phases"
    />
  ),
};

type Row = [key: string, value: number];

/** The drawing's own rows: every datum it drew, with the value it drew it at. */
function drawn(container: HTMLElement, only?: (value: number) => boolean): Row[] {
  const rows = [...container.querySelectorAll<HTMLElement | SVGElement>('[data-figure] [data-datum]')].map(
    (node): Row => [node.getAttribute('data-datum') ?? '', Number(node.getAttribute('data-value'))],
  );
  return only ? rows.filter(([, value]) => only(value)) : rows;
}

/** The fold's rows: the first cell as the key, the first number in the second as the value. */
function tabulated(container: HTMLElement, fold: RegExp): Row[] {
  fireEvent.click(within(container).getByRole('button', { name: fold }));
  return [...container.querySelectorAll('tbody tr')].map((tr): Row => {
    const cells = tr.querySelectorAll('td');
    return [cells[0].textContent ?? '', Number((cells[1].textContent ?? '').replace(/[^0-9.]/g, ''))];
  });
}

const sorted = (rows: Row[]) => [...rows].sort(([a], [b]) => a.localeCompare(b));

describe('the numbers table equals the figure', () => {
  it('covers every figure the module names — a fifth would arrive here or fail', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...CHART_FIGURES].sort());
  });

  it('Bars: one row per drawn week, at the drawn count', () => {
    const { container } = render(SAMPLES.Bars);
    const figure = drawn(container);
    expect(figure).toHaveLength(3);
    expect(sorted(tabulated(container, /the weeks/i))).toEqual(sorted(figure));
  });

  it('Calendar: exactly the days drawn with something in them, and none from outside the window', () => {
    const { container } = render(SAMPLES.Calendar);
    const figure = drawn(container, (value) => value > 0);
    // The day 400 days back is outside a 26-week window, drawn nowhere, tabulated nowhere.
    expect(figure.map(([date]) => date).sort()).toEqual([day(2), day(0)].sort());
    expect(sorted(tabulated(container, /days with a completion/i))).toEqual(sorted(figure));
  });

  it('BarList: every ranked row, at its value', () => {
    const { container } = render(SAMPLES.BarList);
    const figure = drawn(container);
    expect(figure).toHaveLength(2);
    expect(sorted(tabulated(container, /repos, in full/i))).toEqual(sorted(figure));
  });

  it('StackBar: every segment, at its count', () => {
    const { container } = render(SAMPLES.StackBar);
    const figure = drawn(container);
    expect(figure).toHaveLength(3);
    expect(sorted(tabulated(container, /phases as numbers/i))).toEqual(sorted(figure));
  });

  it('the run cost strip: one row per attempt window, at its dollars', () => {
    const timeline: RunTimeline = {
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
      series: {
        cost: [
          { phase: 1, attempt: 1, startMs: 0, endMs: 20 * MIN, value: 4.25, open: false },
          { phase: 2, attempt: 1, startMs: 25 * MIN, endMs: 60 * MIN, value: 11, open: false },
        ],
        tokens: [],
      },
    };
    const { container } = render(<Gantt timeline={timeline} />);
    const figure = drawn(container);
    expect(figure).toHaveLength(2);
    expect(sorted(tabulated(container, /attempt costs/i))).toEqual(sorted(figure));
  });
});

describe('one interaction vocabulary, on each figure', () => {
  for (const name of CHART_FIGURES) {
    it(`${name}: the crosshair is a slider a keyboard reaches and reads`, () => {
      const { container } = render(SAMPLES[name]);
      const slider = within(container).getByRole('slider');
      expect(slider).toHaveAttribute('tabindex', '0');
      expect(slider.getAttribute('aria-label')).toBeTruthy();
      slider.focus();
      const before = slider.getAttribute('aria-valuenow');
      fireEvent.keyDown(slider, { key: 'Home' });
      expect(slider.getAttribute('aria-valuenow')).toBe('0');
      fireEvent.keyDown(slider, { key: 'End' });
      expect(slider.getAttribute('aria-valuenow')).not.toBe('0');
      expect(before).not.toBeNull();
      // What the slider says is what the line under the figure shows.
      const readout = container.querySelector('[data-readout]');
      expect(readout?.textContent).toBeTruthy();
      expect(slider.getAttribute('aria-valuetext')).toBeTruthy();
    });

    it(`${name}: + zooms, 0 resets, and the way back is a button outside the slider`, () => {
      const { container } = render(SAMPLES[name]);
      const slider = within(container).getByRole('slider');
      expect(within(container).queryByRole('button', { name: /reset zoom/i })).toBeNull();
      fireEvent.keyDown(slider, { key: '+' });
      const reset = within(container).getByRole('button', { name: /reset zoom/i });
      expect(slider.contains(reset)).toBe(false);
      fireEvent.keyDown(slider, { key: '0' });
      expect(within(container).queryByRole('button', { name: /reset zoom/i })).toBeNull();
    });

    it(`${name}: a plain wheel is the page's; ⌃ + wheel zooms; a vertical swipe is left to the page`, () => {
      const { container } = render(SAMPLES[name]);
      const surface = container.querySelector<HTMLElement>('[data-figure]')!;
      expect(surface.style.touchAction).toBe('pan-y');

      const plain = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
      surface.dispatchEvent(plain);
      expect(plain.defaultPrevented).toBe(false);
      expect(within(container).queryByRole('button', { name: /reset zoom/i })).toBeNull();

      const pinch = new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true });
      fireEvent(surface, pinch);
      expect(pinch.defaultPrevented).toBe(true);
      expect(within(container).getByRole('button', { name: /reset zoom/i })).toBeInTheDocument();
    });
  }
});
