/**
 * How each phase's clock was split (7.0, quiet-console phase 12) — and the
 * phase's exit criterion 4, held for BOTH of the run's time figures:
 *
 *   T-1 the timeline and the Gantt keep the page's scroll: each figure's
 *       surface is its crosshair's slider and declares `touch-action: pan-y`;
 *       a plain wheel over it is the page's, and only ⌃ + wheel zooms;
 *   T-2 both read the figures' own scales: each axis is labelled with
 *       `durationTicks` over the window on show, written with `duration`, and
 *       a bar sits where `linear(window, range)` puts its start — and when the
 *       scales answer something no ladder or ratio of a drawing's own would,
 *       both drawings follow the scales;
 *   T-3 the split's arithmetic (`spansOf`), every case of the 6.x timeline's
 *       suite — the parts sum to the duration, and the two clamps hold;
 *   T-4 the split as drawn: a row per phase on one shared scale with its parts
 *       in its accessible name, each part painted as the bar kind it is, an
 *       open phase hatched, the key in words, the numbers folded under it, a
 *       crosshair that reads a phase, and one line when nothing has run.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The scales stay the real ones, watched — T-2 bends them to see who follows.
vi.mock('@/ui/figures/scales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui/figures/scales')>();
  return { ...actual, durationTicks: vi.fn(actual.durationTicks), linear: vi.fn(actual.linear) };
});

import type { PhaseRecord, RunTimeline, TimelineLane } from '@/data/api';
import { duration } from '@/lib/format';
import { expectNoAxeViolations } from '@/test/axe';
import { durationTicks, linear } from '@/ui/figures/scales';
import { TRACK } from '@/ui/figures/swimlane';
import { RunGantt } from './gantt';
import { RunClockSplit, spansOf } from './timeline';

const real = await vi.importActual<typeof import('@/ui/figures/scales')>('@/ui/figures/scales');

afterEach(() => {
  vi.mocked(durationTicks).mockImplementation(real.durationTicks);
  vi.mocked(linear).mockImplementation(real.linear);
});

const T0 = Date.parse('2026-08-22T10:00:00.000Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function record(over: Partial<PhaseRecord> & { phase: number }): PhaseRecord {
  return { status: 'done', attempts: 1, costUsd: 0, ...over } as PhaseRecord;
}

/** A finished phase of `minutes`, its parts as given. */
const finished = (phase: number, minutes: number, over: Partial<PhaseRecord> = {}) =>
  record({
    phase,
    startedAt: iso(T0),
    endedAt: iso(T0 + minutes * MIN),
    durationMs: minutes * MIN,
    ...over,
  });

/** P1: 5m working, 3m waiting, 2m frozen. P2: 40m working — the longest, so the scale. */
const PHASES = [finished(1, 10, { frozenMs: 2 * MIN, parkedUntil: iso(T0 + 3 * MIN) }), finished(2, 40)];

function lane(over: Partial<TimelineLane> & { phase: number }): TimelineLane {
  return {
    bars: [{ kind: 'working', startMs: 20 * MIN, endMs: 35 * MIN, attempt: 1, open: false }],
    startMs: 20 * MIN,
    endMs: 35 * MIN,
    totalMs: 15 * MIN,
    workingMs: 15 * MIN,
    verifyingMs: 0,
    queuedMs: 0,
    waitingMs: 0,
    downMs: 0,
    frozenMs: 0,
    measuredMs: 15 * MIN,
    attempts: 1,
    partial: false,
    critical: false,
    ...over,
  };
}

const TIMELINE: RunTimeline = {
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
};

/** The figure's own drawing — the swimlane's SVG, inside its slider. */
const drawing = (): SVGSVGElement => screen.getByRole('slider').querySelector('svg')!;
const tickLabels = (svg: SVGSVGElement) =>
  [...svg.querySelectorAll('text[data-tick]')].map((tick) => tick.textContent);
const barsIn = (svg: SVGSVGElement, state: string) =>
  [...svg.querySelectorAll('rect')].filter((rect) => rect.getAttribute('class')?.split(' ').includes(state));
const xOf = (rect: Element | undefined) => Number(rect?.getAttribute('x'));
const widthOf = (rect: Element | undefined) => Number(rect?.getAttribute('width'));

const FIGURES = {
  'the Gantt': () => render(<RunGantt timeline={TIMELINE} />),
  'the clock split': () => render(<RunClockSplit now={T0 + 60 * MIN} phases={PHASES} />),
};

describe('T-1 the timeline and the Gantt keep the page’s scroll', () => {
  for (const [name, mount] of Object.entries(FIGURES)) {
    it(`${name}: the drawing is the crosshair's surface, and a vertical swipe is left to the page`, () => {
      mount();
      const surface = screen.getByRole('slider');
      expect(surface.style.touchAction).toBe('pan-y');
      expect(surface).toHaveAttribute('tabindex', '0');
      expect(surface.getAttribute('aria-label')).toBeTruthy();
      expect(surface.querySelector('svg')).not.toBeNull();
    });

    it(`${name}: a plain wheel is the page's; ⌃ + wheel zooms, and the way back is outside the slider`, () => {
      mount();
      const surface = screen.getByRole('slider');
      const plain = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
      surface.dispatchEvent(plain);
      expect(plain.defaultPrevented).toBe(false);
      expect(screen.queryByRole('button', { name: /reset zoom/i })).toBeNull();

      const pinch = new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true });
      fireEvent(surface, pinch);
      expect(pinch.defaultPrevented).toBe(true);
      const reset = screen.getByRole('button', { name: /reset zoom/i });
      expect(surface.contains(reset)).toBe(false);
      fireEvent.click(reset);
      expect(screen.queryByRole('button', { name: /reset zoom/i })).toBeNull();
    });
  }
});

describe('T-2 both read the figures’ scales — never a ladder or a ratio of their own', () => {
  it('the Gantt: its axis is the ladder over the run, in durations, and a bar sits where the linear map says', () => {
    render(<RunGantt timeline={TIMELINE} />);
    const svg = drawing();
    expect(tickLabels(svg)).toEqual(real.durationTicks([0, 60 * MIN]).map(duration));
    // Unmeasured in jsdom, so the drawing is TRACK wide.
    const x = real.linear([0, 60 * MIN], [0, TRACK]);
    const [bar] = barsIn(svg, 'state-running');
    expect(xOf(bar)).toBeCloseTo(x(20 * MIN));
    expect(widthOf(bar)).toBeCloseTo(x(35 * MIN) - x(20 * MIN));
  });

  it('the clock split: its axis is the ladder over the longest phase, and each part sits where the linear map says', () => {
    render(<RunClockSplit now={T0 + 60 * MIN} phases={PHASES} />);
    const svg = drawing();
    expect(tickLabels(svg)).toEqual(real.durationTicks([0, 40 * MIN]).map(duration));
    const x = real.linear([0, 40 * MIN], [0, TRACK]);
    // P1's waiting part follows its 5 minutes of work; P2's 40 minutes ARE the scale.
    const [waiting] = barsIn(svg, 'state-waiting');
    expect(xOf(waiting)).toBeCloseTo(x(5 * MIN));
    expect(widthOf(waiting)).toBeCloseTo(x(8 * MIN) - x(5 * MIN));
    const longest = barsIn(svg, 'state-running').find((rect) => widthOf(rect) > x(10 * MIN));
    expect(xOf(longest)).toBe(0);
    expect(widthOf(longest)).toBeCloseTo(TRACK);
  });

  it('both draw what the scales answer, so a drawing with its own ladder or ratio could not pass', () => {
    // A ladder no round-unit rule would produce, and a map seven pixels off true.
    vi.mocked(durationTicks).mockImplementation(() => [7_000, 1_234_000]);
    vi.mocked(linear).mockImplementation((window, range) => {
      const straight = real.linear(window, range);
      return ((value: number) => straight(value) + 7) as unknown as ReturnType<typeof real.linear>;
    });

    const gantt = render(<RunGantt timeline={TIMELINE} />);
    expect(tickLabels(drawing())).toEqual([duration(7_000), duration(1_234_000)]);
    expect(xOf(barsIn(drawing(), 'state-running')[0])).toBeCloseTo(
      real.linear([0, 60 * MIN], [0, TRACK])(20 * MIN) + 7,
    );
    gantt.unmount();

    render(<RunClockSplit now={T0 + 60 * MIN} phases={PHASES} />);
    expect(tickLabels(drawing())).toEqual([duration(7_000), duration(1_234_000)]);
    expect(xOf(barsIn(drawing(), 'state-waiting')[0])).toBeCloseTo(
      real.linear([0, 40 * MIN], [0, TRACK])(5 * MIN) + 7,
    );
  });
});

describe('T-3 spansOf — the split is arithmetic over the runner’s own clocks', () => {
  it('splits a finished phase into working, waiting and frozen', () => {
    const [span] = spansOf(
      [
        record({
          phase: 1,
          startedAt: iso(T0),
          endedAt: iso(T0 + 10 * MIN),
          durationMs: 10 * MIN,
          frozenMs: 2 * MIN,
          parkedUntil: iso(T0 + 3 * MIN),
        }),
      ],
      T0 + 20 * MIN,
    );
    expect(span!.totalMs).toBe(10 * MIN);
    expect(span!.frozenMs).toBe(2 * MIN);
    expect(span!.waitingMs).toBe(3 * MIN);
    // The remainder, never a fourth measured figure — the three must sum to
    // the duration or the bar lies about its own width.
    expect(span!.workingMs).toBe(5 * MIN);
    expect(span!.workingMs + span!.frozenMs + span!.waitingMs).toBe(span!.totalMs);
    expect(span!.live).toBe(false);
  });

  it('clamps a frozen clock that outran the phase', () => {
    // `frozenMs` is the runner's and the duration the closeout's; a restart
    // between them can leave the first larger. The bar must not outgrow the phase.
    const [span] = spansOf(
      [
        record({
          phase: 2,
          startedAt: iso(T0),
          durationMs: 5 * MIN,
          frozenMs: 99 * MIN,
          endedAt: iso(T0 + 5 * MIN),
        }),
      ],
      T0 + 10 * MIN,
    );
    expect(span!.frozenMs).toBe(5 * MIN);
    expect(span!.workingMs).toBe(0);
  });

  it('counts a park that is still running only up to now', () => {
    // `parkedUntil` is in the FUTURE while parked: subtracting it from anything
    // is how a phase ends up with negative working time.
    const [span] = spansOf(
      [record({ phase: 3, status: 'waiting', startedAt: iso(T0), parkedUntil: iso(T0 + 60 * MIN) })],
      T0 + 20 * MIN,
    );
    expect(span!.waitingMs).toBe(20 * MIN);
    expect(span!.totalMs).toBe(20 * MIN);
    expect(span!.live).toBe(true);
  });

  it('measures an open phase against the clock, and marks it live', () => {
    const [span] = spansOf([record({ phase: 4, status: 'running', startedAt: iso(T0) })], T0 + 7 * MIN);
    expect(span!.totalMs).toBe(7 * MIN);
    expect(span!.live).toBe(true);
  });

  it('drops phases that never started, and orders by phase', () => {
    const spans = spansOf(
      [
        record({ phase: 9, startedAt: iso(T0), durationMs: MIN, endedAt: iso(T0 + MIN) }),
        record({ phase: 2, startedAt: iso(T0), durationMs: MIN, endedAt: iso(T0 + MIN) }),
        record({ phase: 5 }),
      ],
      T0,
    );
    expect(spans.map((s) => s.phase)).toEqual([2, 9]);
  });
});

describe('T-4 <RunClockSplit>', () => {
  it('draws a row per phase, with its parts in its accessible name', () => {
    render(<RunClockSplit now={T0 + 30 * MIN} phases={[finished(1, 10, { frozenMs: 2 * MIN })]} />);
    const row = screen.getByRole('img', { name: /^phase 1:/ });
    expect(row).toHaveAccessibleName(/8m.* working/);
    expect(row).toHaveAccessibleName(/2m.* frozen/);
    expect(row).toHaveAccessibleName(/in all/);
  });

  it('starts every bar at the same edge, and paints each part as the bar kind it is', () => {
    render(<RunClockSplit now={T0 + 60 * MIN} phases={PHASES} />);
    const svg = drawing();
    const first = (phase: string) =>
      [...svg.querySelectorAll('g[role="img"]')]
        .find((row) => row.getAttribute('aria-label')?.startsWith(`phase ${phase}:`))!
        .querySelectorAll('rect')[1];
    expect(xOf(first('1'))).toBe(0);
    expect(xOf(first('2'))).toBe(0);
    // The Gantt's classes, never a hue: working, waiting, and frozen's neutral.
    for (const state of ['state-running', 'state-waiting', '[--state:var(--ink-faint)]']) {
      const [part] = barsIn(svg, state);
      expect(part, state).toBeTruthy();
      expect(part!.getAttribute('fill')).toBe('var(--state)');
    }
  });

  it('hatches a phase still open, and says in its key what the hatch means', () => {
    render(
      <RunClockSplit
        now={T0 + 12 * MIN}
        phases={[finished(1, 10), record({ phase: 2, status: 'running', startedAt: iso(T0) })]}
      />,
    );
    const open = screen.getByRole('img', { name: /^phase 2:/ });
    expect(open).toHaveAccessibleName(/still open/);
    expect(open.querySelector('rect[fill="url(#pe-clock-split-open)"]')).not.toBeNull();
    expect(screen.getByRole('img', { name: /^phase 1:/ }).querySelector('rect[fill^="url("]')).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Key' })).getByText('Still open')).toBeInTheDocument();
  });

  it('names each part in words beside its mark — a key of the shared shape', () => {
    const { container } = render(<RunClockSplit now={T0 + 60 * MIN} phases={PHASES} />);
    const key = screen.getByRole('list', { name: 'Key' });
    expect(key).toHaveAttribute('data-slot', 'legend');
    expect(
      within(key)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Working', 'Waiting', 'Frozen']);
    // Nothing open, so no hatch to explain.
    expect(container.querySelector('[data-slot="legend"]')?.textContent).not.toContain('Still open');
  });

  it('folds its numbers under it: one row per phase, each part and the whole', () => {
    render(<RunClockSplit now={T0 + 60 * MIN} phases={PHASES} />);
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /the phase clocks/i }));
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent))).toEqual([
      ['P1', duration(5 * MIN), duration(3 * MIN), duration(2 * MIN), duration(10 * MIN)],
      ['P2', duration(40 * MIN), '—', '—', duration(40 * MIN)],
    ]);
  });

  it('reads a phase with the crosshair: the arrows walk the rows, and the line under it says what the slider says', () => {
    const { container } = render(<RunClockSplit now={T0 + 60 * MIN} phases={PHASES} />);
    const slider = screen.getByRole('slider');
    expect(container.querySelector('[data-readout]')?.textContent).toMatch(/longest phase, 40m/);
    slider.focus();
    fireEvent.keyDown(slider, { key: 'ArrowDown' });
    expect(slider).toHaveAttribute('aria-valuenow', '1');
    expect(slider.getAttribute('aria-valuetext')).toMatch(/^phase 2: 40m.* working/);
    expect(container.querySelector('[data-readout]')?.textContent).toBe(
      slider.getAttribute('aria-valuetext'),
    );
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(slider).toHaveAttribute('aria-valuenow', '0');
  });

  it('says so in one line rather than drawing an empty chart when nothing has run', () => {
    render(<RunClockSplit phases={[]} now={T0} emptyAction={<a href="#plan">Open the plan</a>} />);
    expect(screen.getByText(/Nothing has taken any time yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the plan' })).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  it('is clean to axe', async () => {
    const { container } = render(<RunClockSplit now={T0 + 60 * MIN} phases={PHASES} />);
    await expectNoAxeViolations(container);
  });
});
