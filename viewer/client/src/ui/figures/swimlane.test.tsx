/**
 * The swimlane primitive — the drawing, with none of the meaning.
 *
 * Its callers say what a row is (a phase on the run's Gantt, one phase's own
 * clock on the clock split, a session or a git command on Logs ▸ Timeline);
 * what is tested here is what the drawing says for a caller that knows nothing
 * about phases. Four properties, because each is a claim the picture makes on
 * its own: an open bar is hatched rather than solid, the axis is the figures'
 * axis (round units from the one ladder, positions from the one linear map),
 * the drawing is laid out at its own pitch so a label stays level with its
 * row, and a row's label is real text outside the SVG (an `<svg><text>` is not
 * something anybody can reach with a keyboard).
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FIGURE_TYPE, textWidth } from './paint';
import { durationTicks, linear } from './scales';
import { AXIS, BAR, RAIL, ROW, Swimlane, TRACK, ticksFor, type SwimlaneRow } from './swimlane';
import type { Figure } from './use-figure';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Lay the drawing out `width` px wide, as a browser would measure it: jsdom
 * measures nothing, so `useWidth` keeps `TRACK` unless a box reports a width.
 */
const measuredAt = (width: number) =>
  vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({ width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0 } as DOMRect);

/**
 * Where a written label starts and ends, from its own attributes and its width
 * at the figures' type — its own words, not the `<title>` a glyph carries.
 */
function extent(text: Element): [number, number] {
  const at = Number(text.getAttribute('x')) + Number(text.getAttribute('dx') ?? 0);
  const wide = textWidth(text.firstChild?.textContent ?? '');
  const anchor = text.getAttribute('text-anchor') ?? 'start';
  return anchor === 'end'
    ? [at - wide, at]
    : anchor === 'middle'
      ? [at - wide / 2, at + wide / 2]
      : [at, at + wide];
}

const MIN = 60_000;

function row(over: Partial<SwimlaneRow> & { key: string }): SwimlaneRow {
  return {
    label: over.key,
    ariaLabel: `${over.key}: 10 min working`,
    bars: [{ key: 'b1', startMs: 0, endMs: 10 * MIN, state: 'state-running' }],
    ...over,
  };
}

describe('geometry', () => {
  it('states its units so a caller can lay text out beside the SVG', () => {
    // The label column pads by `AXIS` and spaces its rows by the row pitch.
    // Those are arithmetic over these four, so they are exports rather than
    // private consts — a second copy would drift by a pixel a release until the
    // labels no longer lined up with the bars. Cut from the figures' type since
    // quiet-console phase 27 (they were 22, 11, 1000 and 16 under 8 px glyphs).
    expect([ROW, BAR, TRACK, AXIS]).toEqual([28, 14, 1000, 16]);
    expect(BAR).toBeLessThan(ROW);
    expect(RAIL).toBeLessThan(BAR / 2);
  });

  it('hangs a moment’s glyph from the bar’s lower edge, never over the middle of the bar it marks', () => {
    const { container } = render(
      <Swimlane
        spanMs={60 * MIN}
        ariaLabel="one row"
        rows={[row({ key: 'a', marks: [{ key: 'm', atMs: 30 * MIN, glyph: '◆', title: 'verify' }] })]}
      />,
    );
    const glyph = [...container.querySelectorAll('text')].find((node) => node.textContent?.startsWith('◆'))!;
    const baseline = Number(glyph.getAttribute('y'));
    // The row's own track: the first thing its group draws.
    const track = container.querySelector('g[aria-label] > rect')!;
    const barTop = Number(track.getAttribute('y'));
    const barBottom = barTop + Number(track.getAttribute('height'));
    // A glyph reaches a capital's height (0.72 em) over its baseline: its top
    // overlaps the bar's lower edge, and its baseline sits under the bar, in the row.
    const glyphTop = baseline - FIGURE_TYPE * 0.72;
    expect(glyphTop).toBeGreaterThan((barTop + barBottom) / 2);
    expect(glyphTop).toBeLessThan(barBottom);
    expect(baseline).toBeGreaterThan(barBottom);
    expect(baseline).toBeLessThanOrEqual(AXIS + ROW);
  });

  it('lays its rows at the pitch it is given, so a thumb-high label stays level with its bars', () => {
    const { container } = render(
      <Swimlane
        spanMs={60 * MIN}
        ariaLabel="two rows"
        rowHeight={44}
        rows={[row({ key: 'a' }), row({ key: 'b' })]}
      />,
    );
    expect(container.querySelector('svg')?.getAttribute('height')).toBe(String(AXIS + 2 * 44));
    const labels = [...container.querySelectorAll<HTMLElement>('ol > li')];
    expect(labels.map((li) => li.style.height)).toEqual(['44px', '44px']);
    // The bar keeps its share of the row: half of it, as at the default pitch.
    const bar = [...container.querySelectorAll('rect')].find((rect) =>
      rect.getAttribute('class')?.includes('state-running'),
    );
    expect(Number(bar?.getAttribute('height'))).toBe(22);
  });
});

describe('the axis is the figures’ axis', () => {
  it('puts a bar where the one linear map says, inside a zoomed window too', () => {
    const { container } = render(
      <Swimlane
        spanMs={60 * MIN}
        view={[10 * MIN, 40 * MIN]}
        ariaLabel="one row"
        rows={[
          row({ key: 'a', bars: [{ key: 'b', startMs: 20 * MIN, endMs: 30 * MIN, state: 'state-running' }] }),
        ]}
      />,
    );
    const bar = [...container.querySelectorAll('rect')].find((rect) =>
      rect.getAttribute('class')?.includes('state-running'),
    );
    // The drawing has not been measured in jsdom, so it is TRACK wide.
    const x = linear([10 * MIN, 40 * MIN], [0, TRACK]);
    expect(Number(bar?.getAttribute('x'))).toBeCloseTo(x(20 * MIN));
    expect(Number(bar?.getAttribute('width'))).toBeCloseTo(x(30 * MIN) - x(20 * MIN));
  });

  it('labels exactly the ladder’s ticks over the window on show, in the meta size', () => {
    const { container } = render(
      <Swimlane
        spanMs={60 * MIN}
        view={[7 * MIN, 37 * MIN]}
        ariaLabel="one row"
        tickLabel={(ms) => `${ms / MIN}m`}
        rows={[row({ key: 'a' })]}
      />,
    );
    const ticks = [...container.querySelectorAll('text[data-tick]')];
    expect(ticks.map((tick) => Number(tick.getAttribute('data-tick')))).toEqual(
      durationTicks([7 * MIN, 37 * MIN]),
    );
    expect(ticks[0]?.textContent).toBe('10m');
    // The meta size in px, as an SVG is drawn — never a rem class the bands were not cut for.
    for (const tick of ticks) {
      expect(tick.getAttribute('font-size')).toBe(String(FIGURE_TYPE));
      expect(tick.getAttribute('class')).toBe('tnum');
      expect(Number(tick.getAttribute('y'))).toBeLessThan(AXIS);
    }
  });

  it('writes every word and glyph in the figures’ one type size', () => {
    const { container } = render(
      <Swimlane
        spanMs={60 * MIN}
        ariaLabel="one row"
        tickLabel={(ms) => `${ms / MIN}m`}
        axisMarks={[{ key: 'start', atMs: 0, glyph: '▶', title: 'operator' }]}
        rows={[row({ key: 'a', marks: [{ key: 'm', atMs: 5 * MIN, glyph: '▾', title: 'board' }] })]}
      />,
    );
    const texts = [...container.querySelectorAll('svg text')];
    expect(texts.length).toBeGreaterThan(2);
    for (const text of texts)
      expect(text.getAttribute('font-size'), text.textContent!).toBe(String(FIGURE_TYPE));
  });
});

describe('the bands a label is written in', () => {
  it('gives the run’s own marks a band under the ticks, so a glyph never sits on a label', () => {
    const { container } = render(
      <Swimlane
        spanMs={60 * MIN}
        ariaLabel="one row"
        tickLabel={(ms) => `${ms / MIN}m`}
        axisMarks={[{ key: 'start', atMs: 0, glyph: '▶', title: 'operator' }]}
        rows={[row({ key: 'a' }), row({ key: 'b' })]}
      />,
    );
    const start = [...container.querySelectorAll('text')].find((node) => node.textContent?.startsWith('▶'))!;
    const tick = container.querySelector('text[data-tick]')!;
    // The glyph's top is under the tick label's descent: two lines, not one.
    expect(Number(start.getAttribute('y')) - FIGURE_TYPE * 0.8).toBeGreaterThan(
      Number(tick.getAttribute('y')) + FIGURE_TYPE * 0.25,
    );
    // …and the rows, their labels and the drawing's height move down by the band.
    const band = Number(container.querySelector('svg')!.getAttribute('height')) - AXIS - 2 * ROW;
    expect(band).toBeGreaterThan(0);
    expect(container.querySelector<HTMLElement>('ol')!.style.paddingTop).toBe(`${AXIS + band}px`);
    expect(Number(start.getAttribute('y'))).toBeLessThanOrEqual(AXIS + band);
  });

  it('draws no marks’ band for a run with no marks of its own', () => {
    const { container } = render(
      <Swimlane spanMs={60 * MIN} ariaLabel="one row" rows={[row({ key: 'a' })]} />,
    );
    expect(container.querySelector('svg')!.getAttribute('height')).toBe(String(AXIS + ROW));
    expect(container.querySelector<HTMLElement>('ol')!.style.paddingTop).toBe(`${AXIS}px`);
  });

  it('holds a glyph at the axis’s first moment inside the drawing rather than cutting it in half', () => {
    const { container } = render(
      <Swimlane
        spanMs={60 * MIN}
        ariaLabel="one row"
        axisMarks={[{ key: 'start', atMs: 0, glyph: '▶', title: 'operator' }]}
        rows={[row({ key: 'a', marks: [{ key: 'm', atMs: 60 * MIN, glyph: '●', title: 'outcome' }] })]}
      />,
    );
    const glyph = (mark: string) =>
      [...container.querySelectorAll('text')].find((node) => node.textContent?.startsWith(mark))!;
    expect(glyph('▶').getAttribute('text-anchor')).toBe('start');
    expect(extent(glyph('▶'))[0]).toBeGreaterThanOrEqual(0);
    expect(glyph('●').getAttribute('text-anchor')).toBe('end');
    expect(extent(glyph('●'))[1]).toBeLessThanOrEqual(TRACK);
  });

  for (const width of [200, 248, 320, 600, 1000]) {
    it(`writes no two tick labels over each other, and none off the drawing, ${width} px wide`, () => {
      measuredAt(width);
      for (const [view, write] of [
        [[0, 60 * MIN], (ms: number) => `${ms / MIN}m`],
        // Zoomed into a minute and a half: the ladder's longest words.
        [[10 * MIN, 11.5 * MIN], (ms: number) => `${Math.floor(ms / MIN)}m ${(ms % MIN) / 1000}s`],
        [[0, 13 * 3_600_000], (ms: number) => `${Math.floor(ms / 3_600_000)}h 30m`],
      ] as const) {
        const { container, unmount } = render(
          <Swimlane
            spanMs={60 * MIN}
            view={view as unknown as [number, number]}
            ariaLabel="one row"
            tickLabel={write}
            rows={[row({ key: 'a' })]}
          />,
        );
        expect(container.querySelector('svg')!.getAttribute('viewBox')).toBe(`0 0 ${width} ${AXIS + ROW}`);
        const spans = [...container.querySelectorAll('text[data-tick]')]
          .map(extent)
          .sort((a, b) => a[0] - b[0]);
        expect(spans.length, `${width}px`).toBeGreaterThan(0);
        for (const [from, to] of spans) {
          expect(from, `${width}px`).toBeGreaterThanOrEqual(0);
          expect(to, `${width}px`).toBeLessThanOrEqual(width);
        }
        for (let i = 1; i < spans.length; i++) {
          expect(spans[i]![0], `${width}px: label ${i} starts past label ${i - 1}`).toBeGreaterThan(
            spans[i - 1]![1],
          );
        }
        unmount();
      }
    });
  }
});

describe('ticksFor', () => {
  it('lands on round units rather than on the span divided by six', () => {
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

describe('Swimlane', () => {
  it('draws a row per entry, each reachable by its own sentence', () => {
    render(<Swimlane spanMs={60 * MIN} ariaLabel="two rows" rows={[row({ key: 'a' }), row({ key: 'b' })]} />);
    expect(screen.getByLabelText('a: 10 min working')).toBeTruthy();
    expect(screen.getByLabelText('b: 10 min working')).toBeTruthy();
  });

  it('hatches an open bar so "ran for" and "has been running for" do not look alike', () => {
    const { container } = render(
      <Swimlane
        spanMs={20 * MIN}
        ariaLabel="one row"
        hatchId="pe-test-open"
        rows={[
          row({
            key: 'a',
            bars: [
              { key: 'closed', startMs: 0, endMs: 5 * MIN, state: 'state-running' },
              { key: 'open', startMs: 5 * MIN, endMs: 20 * MIN, state: 'state-running', open: true },
            ],
          }),
        ]}
      />,
    );
    expect(container.querySelector('pattern#pe-test-open')).toBeTruthy();
    const hatched = [...container.querySelectorAll('rect')].filter(
      (rect) => rect.getAttribute('fill') === 'url(#pe-test-open)',
    );
    expect(hatched).toHaveLength(1);
  });

  it('gives each swimlane its own hatch id, so two on one page do not share one', () => {
    const { container } = render(
      <>
        <Swimlane spanMs={MIN} ariaLabel="one" hatchId="pe-one" rows={[row({ key: 'a' })]} />
        <Swimlane spanMs={MIN} ariaLabel="two" hatchId="pe-two" rows={[row({ key: 'b' })]} />
      </>,
    );
    expect(container.querySelector('pattern#pe-one')).toBeTruthy();
    expect(container.querySelector('pattern#pe-two')).toBeTruthy();
  });

  it('paints through the `--state` bridge rather than naming a hue', () => {
    // The one rule this component exists to keep: a bar names a STATE class and
    // the colour follows from `styles/theme.css`. A `fill="var(--status-…)"`
    // here would be a second status→colour table one directory from the first.
    const { container } = render(
      <Swimlane
        spanMs={MIN}
        ariaLabel="one"
        rows={[row({ key: 'a', bars: [{ key: 'b', startMs: 0, endMs: MIN, state: 'state-verifying' }] })]}
      />,
    );
    const bar = [...container.querySelectorAll('rect')].find((rect) =>
      rect.getAttribute('class')?.includes('state-verifying'),
    );
    expect(bar).toBeTruthy();
    expect(bar!.getAttribute('fill')).toBe('var(--state)');
  });

  it('labels the axis with the ticks, in the caller`s own words', () => {
    render(
      <Swimlane
        spanMs={60 * MIN}
        ariaLabel="one"
        rows={[row({ key: 'a' })]}
        tickLabel={(ms) => `+${ms / MIN}m`}
      />,
    );
    expect(screen.getByText('+15m')).toBeTruthy();
    expect(screen.getByText('+45m')).toBeTruthy();
  });

  it('puts run-level marks on the axis itself, where they belong to no row', () => {
    const { container } = render(
      <Swimlane
        spanMs={60 * MIN}
        ariaLabel="one"
        rows={[row({ key: 'a' })]}
        axisMarks={[{ key: 'start', atMs: 0, glyph: '▶', title: 'operator' }]}
      />,
    );
    expect([...container.querySelectorAll('text')].some((node) => node.textContent?.includes('▶'))).toBe(
      true,
    );
  });

  it('selects the bar a person clicked, and nothing when nothing is selectable', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <Swimlane
        spanMs={MIN}
        ariaLabel="one"
        rows={[
          row({ key: 'a', bars: [{ key: 'b', startMs: 0, endMs: MIN, state: 'state-running', onSelect }] }),
        ]}
      />,
    );
    const bar = container.querySelector('rect[role="button"]');
    expect(bar).toBeTruthy();
    fireEvent.click(bar!);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('names a selectable bar, because an SVG <title> is not an accessible name', () => {
    // axe's `aria-command-name`: a `role="button"` whose only text is a
    // `<title>` child announces as "button" and nothing else. The Debug
    // timeline's every bar is selectable, so this is every bar on the page.
    const { container } = render(
      <Swimlane
        spanMs={MIN}
        ariaLabel="one"
        rows={[
          row({
            key: 'a',
            bars: [
              {
                key: 'b',
                startMs: 0,
                endMs: MIN,
                state: 'state-running',
                title: 'p4 working 1 min',
                onSelect: () => {},
              },
            ],
          }),
        ]}
      />,
    );
    expect(container.querySelector('rect[role="button"]')?.getAttribute('aria-label')).toBe(
      'p4 working 1 min',
    );
  });

  it('lets a keyboard reach and press a selectable bar on a static drawing, which is then a group', () => {
    // An image's children are presentational: a button inside one is announced
    // as nothing (axe's `nested-interactive`). So a drawing holding controls is
    // a group of them, each row a group named by its own sentence.
    const onSelect = vi.fn();
    render(
      <Swimlane
        spanMs={MIN}
        ariaLabel="one run"
        rows={[
          row({
            key: 'a',
            bars: [
              { key: 'b', startMs: 0, endMs: MIN, state: 'state-running', title: 'p4 working', onSelect },
            ],
          }),
        ]}
      />,
    );
    const bar = screen.getByRole('button', { name: 'p4 working' });
    expect(bar).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(bar, { key: 'Enter' });
    fireEvent.keyDown(bar, { key: ' ' });
    fireEvent.keyDown(bar, { key: 'a' });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('group', { name: 'one run' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'a: 10 min working' })).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('keeps a drawing with no control an image, and a slider’s bars off the tab order', () => {
    const { container, rerender } = render(
      <Swimlane spanMs={MIN} ariaLabel="one run" rows={[row({ key: 'a' })]} />,
    );
    expect(screen.getByRole('img', { name: 'one run' })).toBeInTheDocument();
    // With `figure` the track is the one slider and its walk owns the keyboard:
    // a bar inside it is a pointer's target and never a second tab stop.
    const figure = { sliderProps: {}, surfaceProps: {} } as unknown as Figure;
    rerender(
      <Swimlane
        spanMs={MIN}
        ariaLabel="one run"
        figure={figure}
        rows={[
          row({
            key: 'a',
            bars: [
              { key: 'b', startMs: 0, endMs: MIN, state: 'state-running', title: 'p4', onSelect: () => {} },
            ],
          }),
        ]}
      />,
    );
    expect(screen.getByRole('img', { name: 'one run' })).toBeInTheDocument();
    expect(container.querySelector('rect[role="button"]')).not.toHaveAttribute('tabindex');
  });

  it('lets a finger through a mark that does nothing, to the bar under it', () => {
    // The register measured it: a phase's start mark sits on the bar's lower
    // edge and won the bar's corner from a touch. A hover keeps the glyph's title.
    const { container } = render(
      <Swimlane
        spanMs={MIN}
        ariaLabel="one"
        rows={[
          row({
            key: 'a',
            marks: [
              { key: 'm', atMs: 0, glyph: '▾', title: 'board' },
              { key: 'n', atMs: MIN / 2, glyph: '✖', title: 'error', onSelect: () => {} },
            ],
          }),
        ]}
      />,
    );
    const glyph = (mark: string) =>
      [...container.querySelectorAll('text')].find((node) => node.textContent?.startsWith(mark));
    expect(glyph('▾')?.getAttribute('class')).toContain('pointer-coarse:pointer-events-none');
    expect(glyph('✖')?.getAttribute('class')).not.toContain('pointer-events-none');
    expect(glyph('✖')).toHaveAttribute('role', 'button');
  });

  it('folds marks that would cover each other into ONE counted mark whose title lists them all (#375)', () => {
    // Four notes pinned at one instant drew one ✎ over three others, and a
    // hover read only the top one.
    const note = (key: string, title: string) => ({ key, atMs: 30 * MIN, glyph: '✎', title });
    const { container } = render(
      <Swimlane
        spanMs={60 * MIN}
        ariaLabel="one"
        rows={[
          row({
            key: 'a',
            marks: [note('a', 'one'), note('b', 'two'), note('c', 'three'), note('d', 'four')],
          }),
        ]}
      />,
    );
    const marks = [...container.querySelectorAll('text:not([data-tick])')];
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveAttribute('data-mark-count', '4');
    expect(marks[0]!.firstChild?.textContent).toBe('✎×4');
    expect(marks[0]!.querySelector('title')?.textContent).toBe('one\ntwo\nthree\nfour');
  });

  it('says how many more when the kinds differ, keeps a failure red, and lets marks a glyph apart stand alone', () => {
    const { container } = render(
      <Swimlane
        spanMs={60 * MIN}
        ariaLabel="one"
        rows={[
          row({
            key: 'a',
            marks: [
              { key: 'b', atMs: 10 * MIN, glyph: '▏', title: 'board' },
              { key: 'w', atMs: 10 * MIN + 1000, glyph: '✖', title: 'wall', state: 'state-failed' },
              { key: 'o', atMs: 40 * MIN, glyph: '●', title: 'outcome' },
            ],
          }),
        ]}
      />,
    );
    const marks = [...container.querySelectorAll('text:not([data-tick])')];
    expect(marks.map((mark) => mark.firstChild?.textContent)).toEqual(['▏+1', '●']);
    expect(marks[0]!.getAttribute('class')).toContain('state-failed');
    // A lone mark is drawn exactly as before: its glyph, centred on its instant.
    expect(marks[1]).toHaveAttribute('text-anchor', 'middle');
    expect(marks[1]).not.toHaveAttribute('data-mark-count');
  });

  it('ties one bar to another by key, named; a tie with a missing end is not drawn (#407)', () => {
    const { container } = render(
      <Swimlane
        spanMs={60 * MIN}
        ariaLabel="ties"
        rows={[
          row({ key: 'a', bars: [{ key: 'one', startMs: 0, endMs: 10 * MIN, state: 'state-running' }] }),
          row({
            key: 'b',
            bars: [{ key: 'two', startMs: 20 * MIN, endMs: 30 * MIN, state: 'state-running' }],
          }),
        ]}
        ties={[
          {
            key: 't',
            from: { row: 'a', bar: 'one' },
            to: { row: 'b', bar: 'two' },
            title: 'two waits for one',
          },
          { key: 'gone', from: { row: 'a', bar: 'one' }, to: { row: 'b', bar: 'nope' }, title: 'nothing' },
        ]}
      />,
    );
    const ties = container.querySelectorAll('g[data-tie]');
    expect(ties).toHaveLength(1);
    expect(ties[0]).toHaveAttribute('aria-label', 'two waits for one');
    expect(ties[0]!.querySelector('title')?.textContent).toBe('two waits for one');
  });

  it('hangs a named lock or person under the bar it marks (#407)', () => {
    const { container } = render(
      <Swimlane
        spanMs={60 * MIN}
        ariaLabel="glyphs"
        rows={[
          row({
            key: 'a',
            bars: [
              {
                key: 'one',
                startMs: 0,
                endMs: 10 * MIN,
                state: 'state-running',
                glyphs: [
                  { kind: 'person', title: 'waits for a person' },
                  { kind: 'lock', title: 'held by a holder' },
                ],
              },
            ],
          }),
        ]}
      />,
    );
    const glyphs = [...container.querySelectorAll('g[data-glyph]')];
    expect(glyphs.map((g) => [g.getAttribute('data-glyph'), g.getAttribute('aria-label')])).toEqual([
      ['person', 'waits for a person'],
      ['lock', 'held by a holder'],
    ]);
  });

  it('draws nothing but says so when there are no rows', () => {
    const { container } = render(<Swimlane spanMs={0} ariaLabel="empty" rows={[]} />);
    expect(container.querySelector('svg')).toBeNull();
  });
});
