/**
 * The four figures, held through their one door (`./lazy`).
 *
 * 1. **A figure cannot be painted a colour the design system does not have.**
 *    Its tone is a state's name and its drawing paints through `.state-<tone>`
 *    and `var(--state)`, so the guard is a sweep of everything rendered — the
 *    drawing, its key, its numbers opened — for any literal colour, any raw
 *    `--status-*` and any utility that names a hue. A raw hex is invisible in
 *    one of the two lights, and nobody flips the theme to check a chart.
 * 2. **The inventory is closed.** A component this module exports is a figure,
 *    or it is written down below with the reason it is not; a mark is the
 *    line's (`ui/track/meter.tsx`). Derived from the module's own exports, so a
 *    chart added to neither list fails here rather than shipping unexplained.
 * 3. **Every figure carries its numbers, and the drawing equals them.** The
 *    fold opens to a captioned table of the rows the figure was drawn from;
 *    every drawn datum carries `data-datum`/`data-value`, and this is what
 *    notices the day a drawing filters, rounds or reorders what its table says.
 * 4. **One interaction vocabulary on each figure** — a crosshair a keyboard
 *    reaches and reads, a zoom whose way back sits outside the slider, ⌃/⌘ +
 *    wheel zooming where a plain wheel does not, `touch-action: pan-y` so a
 *    vertical swipe stays the page's, and a pointer read from the inline start.
 *    A real pinch and a real swipe are `e2e/figures.spec.ts`'s: jsdom has no
 *    gesture pipeline to ask.
 *
 * `test-setup.ts` preloads the chunks through `loadFigures`, so every drawing
 * here renders in its first frame, as it does in a browser once they arrive.
 */

import type { ReactElement } from 'react';
import { fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as meter from '@/ui/track/meter';
import * as figures from './lazy';
import { BarList, Bars, Calendar, FIGURES, MARKS, StackBar, calendarCells, type FigureName } from './lazy';
import { FIGURE_CAP, FIGURE_DESCENT, FIGURE_TYPE, textWidth } from './paint';

/** Calendar halves its window on a phone; the phone is this switch. */
const viewport = vi.hoisted(() => ({ narrow: false }));
vi.mock('@/lib/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/media')>()),
  useNarrow: () => viewport.narrow,
}));

afterEach(() => {
  viewport.narrow = false;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Today and some days back, so the Calendar's window always holds them. */
const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);

const SAMPLES: Record<FigureName, ReactElement> = {
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

/** Each figure's numbers fold, by the words it is labelled with. */
const FOLDS: Record<FigureName, RegExp> = {
  Bars: /^The weeks/,
  Calendar: /^The days with a completion/,
  BarList: /^The repos, in full/,
  StackBar: /^The phases as numbers/,
};

/**
 * Exported components that are not figures, each with its reason.
 *
 * An allowance, not a filter: the inventory is derived from the module's own
 * exports precisely so an undeclared chart cannot ship, and the only way past
 * it is to write down why a component is not one.
 */
const NOT_A_FIGURE: Record<string, string> = {
  RunCostFigure:
    "the run's cost strip: a second reading drawn under the Gantt's lanes, on THEIR axis and crosshair — " +
    'its numbers are the Gantt’s fold (`run-chart.test.tsx`), so it owes no table of its own and is no mark',
};

/** Every component the door exports: an exported function with a capitalised name. */
const exportedComponents = () =>
  Object.entries(figures)
    .filter(([name, value]) => typeof value === 'function' && /^[A-Z]/.test(name))
    .map(([name]) => name);

type Row = [key: string, value: number];

const slider = (container: HTMLElement) => within(container).getByRole('slider');
const resetButton = (container: HTMLElement) =>
  within(container).queryByRole('button', { name: /reset zoom/i });
const fold = (container: HTMLElement, name: RegExp) => within(container).getByRole('button', { name });

/** The drawing's own rows: every datum it drew, with the value it drew it at. */
function drawn(container: HTMLElement, only?: (value: number) => boolean): Row[] {
  const rows = [...container.querySelectorAll('[data-figure] [data-datum]')].map((node): Row => [
    node.getAttribute('data-datum') ?? '',
    Number(node.getAttribute('data-value')),
  ]);
  return only ? rows.filter(([, value]) => only(value)) : rows;
}

/** The fold's rows: the first cell as the key, the first number in the second as the value. */
function tabulated(container: HTMLElement, name: RegExp): Row[] {
  fireEvent.click(fold(container, name));
  return [...container.querySelectorAll('tbody tr')].map((tr): Row => {
    const cells = tr.querySelectorAll('td');
    return [cells[0]?.textContent ?? '', Number((cells[1]?.textContent ?? '').replace(/[^0-9.]/g, ''))];
  });
}

/** The table's rows as text, cell by cell. */
const cellsOf = (container: HTMLElement) =>
  [...container.querySelectorAll('tbody tr')].map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent),
  );

const sorted = (rows: Row[]) => [...rows].sort(([a], [b]) => a.localeCompare(b));

/** The widths a drawing sets inline, in order — a bar's length, a segment's share. */
const widths = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[data-figure] [style*="width"]')].map((el) => el.style.width);

/** Anything that is a colour but not a token reference. */
const LITERAL_COLOUR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\boklab\(/i;
/** A hue reached around the state indirection — the 6.x `toneVar` spelling, or a raw hue utility. */
const RAW_HUE =
  /var\(--status-|(?<![\w-])(?:bg|text|border|fill|stroke|outline)-(?:needs-you|failed|running|verifying|waiting|queued|skipped|done)\b/;

/** Every `fill`, `stroke`, `color` and inline style in a rendered tree, and every class list. */
function paints(container: HTMLElement): { paint: string[]; classes: string[] } {
  const paint: string[] = [];
  const classes: string[] = [];
  for (const node of container.querySelectorAll('*')) {
    for (const attr of ['fill', 'stroke', 'color', 'stop-color', 'style']) {
      const value = node.getAttribute(attr);
      if (value) paint.push(value);
    }
    const names = node.getAttribute('class');
    if (names) classes.push(names);
  }
  return { paint, classes };
}

/** Render a figure, move its crosshair, zoom it and open its numbers — every paint path it has. */
function exercise(name: FigureName) {
  const view = render(SAMPLES[name]);
  const knob = slider(view.container);
  fireEvent.keyDown(knob, { key: 'End' });
  fireEvent.keyDown(knob, { key: '+' });
  fireEvent.click(fold(view.container, FOLDS[name]));
  return view;
}

describe('a figure is painted with states, never a colour', () => {
  for (const name of FIGURES) {
    it(`${name}: tokens only — the drawing, its key and its numbers, crosshair on and zoomed`, () => {
      const { container } = exercise(name);
      const { paint, classes } = paints(container);
      expect(paint.length).toBeGreaterThan(0);
      for (const value of paint) {
        expect(value, value).not.toMatch(LITERAL_COLOUR);
        expect(value, value).not.toMatch(RAW_HUE);
      }
      for (const value of classes) expect(value, value).not.toMatch(RAW_HUE);
      // Each figure reaches its hue through the one indirection.
      expect(container.querySelector('[data-figure] [class*="state-"]'), name).not.toBeNull();
    });
  }

  it('paints the closed weeks as the running state and the Calendar from the done state', () => {
    const bars = render(SAMPLES.Bars);
    const [first] = bars.container.querySelectorAll('[data-figure] [data-datum]');
    expect(first!.getAttribute('class')).toContain('state-running');
    expect(first!.getAttribute('fill')).toBe('var(--state)');
    bars.unmount();

    const calendar = render(SAMPLES.Calendar);
    const cells = [...calendar.container.querySelectorAll('[data-figure] [data-datum]')];
    const full = cells.find((cell) => cell.getAttribute('data-value') !== '0')!;
    const none = cells.find((cell) => cell.getAttribute('data-value') === '0')!;
    // The heat is the done state mixed into the track — the one place a
    // percentage could tempt a literal.
    expect(full.closest('.state-done')).not.toBeNull();
    expect(full.getAttribute('fill')).toMatch(/^color-mix\(in oklab, var\(--state\) \d+%, var\(--track\)\)$/);
    expect(none.getAttribute('fill')).toBe('var(--track)');
  });

  it('paints a ranked bar and a segment as their own state, through `bg-state`', () => {
    const { container } = render(
      <>
        <BarList items={[{ name: 'a', value: 1 }]} tone="done" />
        <StackBar segments={[{ label: 'next up', value: 1, tone: 'queued' }]} />
      </>,
    );
    const bar = container.querySelector('[data-figure="BarList"] .bg-state')!;
    expect(bar.className).toContain('state-done');
    const segment = container.querySelector('[data-figure="StackBar"] [data-datum]')!;
    expect(segment.className).toContain('bg-state');
    expect(segment.className).toContain('state-queued');
  });

  it('sets its type in the four sizes, numbers in the sans — no 6.x size, no mono', () => {
    for (const name of FIGURES) {
      const { container, unmount } = exercise(name);
      for (const { className } of container.querySelectorAll<HTMLElement>('[class]')) {
        if (typeof className !== 'string') continue;
        expect(className, `${name}: ${className}`).not.toMatch(/(?<![\w-])(?:text-2xs|text-xs|text-\[)/);
        expect(className, `${name}: ${className}`).not.toMatch(/(?<![\w-])font-mono\b/);
      }
      unmount();
    }
  });
});

describe('the inventory is closed', () => {
  it('exports exactly the figures, plus the components written down as not one', () => {
    expect(new Set(FIGURES).size, 'a figure is named once').toBe(FIGURES.length);
    expect(
      exportedComponents()
        .filter((name) => !(name in NOT_A_FIGURE))
        .sort(),
      'every exported component is a figure, or is written down below with its reason',
    ).toEqual([...FIGURES].sort());
    // …and the allowance names only what the module still exports.
    for (const name of Object.keys(NOT_A_FIGURE)) expect(exportedComponents(), name).toContain(name);
  });

  it('names marks the line draws, and no mark is a figure', () => {
    for (const name of MARKS) {
      expect(typeof (meter as Record<string, unknown>)[name], `${name} is the line's`).toBe('function');
      expect((FIGURES as readonly string[]).includes(name), `${name} is a mark, not a figure`).toBe(false);
    }
  });
});

describe('every figure carries its numbers', () => {
  it('drives every figure in FIGURES: each offers its numbers and opens to a captioned table of rows', () => {
    // The driver is over the list itself: a figure added with no sample fails
    // the first assertion, and one whose table is missing, unnamed or empty
    // fails the rest. Four hand-written cases could only check the four.
    expect(Object.keys(SAMPLES).sort(), 'every figure needs a sample').toEqual([...FIGURES].sort());
    for (const name of FIGURES) {
      const { container, unmount } = render(SAMPLES[name]);
      expect(container.querySelector(`[data-figure="${name}"]`), `${name} draws`).not.toBeNull();
      const toggle = fold(container, FOLDS[name]);
      expect(toggle, `${name} folds its numbers`).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(toggle);
      expect(container.querySelector('caption')?.textContent, `${name} captions its table`).toBeTruthy();
      expect(container.querySelectorAll('tbody tr').length, `${name} tabulates its rows`).toBeGreaterThan(0);
      unmount();
    }
  });

  it('labels each fold, caption and column in the figure’s own words', () => {
    const heads = (container: HTMLElement) =>
      within(container)
        .getAllByRole('columnheader')
        .map((head) => head.textContent);
    const caption = (container: HTMLElement) => container.querySelector('caption')?.textContent;

    const bars = render(SAMPLES.Bars);
    fireEvent.click(fold(bars.container, FOLDS.Bars));
    expect(caption(bars.container)).toBe('phases per week, the numbers behind the figure');
    expect(heads(bars.container)).toEqual(['Week', 'phases']);
    expect(cellsOf(bars.container)).toEqual([
      ['2026-W36', '2'],
      ['2026-W37', '0'],
      ['2026-W38', '7'],
    ]);
    bars.unmount();

    const calendar = render(SAMPLES.Calendar);
    fireEvent.click(fold(calendar.container, FOLDS.Calendar));
    expect(caption(calendar.container)).toBe('Phase completions by day over the last 26 weeks');
    expect(heads(calendar.container)).toEqual(['Day', 'Phases']);
    expect(calendar.container.textContent).toMatch(/\d+ days in the window; the rest completed nothing\./);
    calendar.unmount();

    const list = render(SAMPLES.BarList);
    fireEvent.click(fold(list.container, FOLDS.BarList));
    expect(caption(list.container)).toBe("repos, with each row's share of the total");
    expect(heads(list.container)).toEqual(['Name', 'Value', 'Share']);
    expect(cellsOf(list.container)[0]).toEqual(['phased-execution', '12 USD', '80%']);
    list.unmount();

    const stack = render(SAMPLES.StackBar);
    fireEvent.click(fold(stack.container, FOLDS.StackBar));
    expect(caption(stack.container)).toBe('phases, by count and share');
    expect(heads(stack.container)).toEqual(['Segment', 'Count', 'Share']);
    expect(cellsOf(stack.container)[0]).toEqual(['done', '9', '75%']);
    stack.unmount();

    // Unnamed, a ranked list and a stack still say what their rows are.
    const bare = render(
      <>
        <BarList items={[{ name: 'a', value: 1 }]} />
        <StackBar segments={[{ label: 'b', value: 1, tone: 'done' }]} />
      </>,
    );
    expect(fold(bare.container, /^The rows, in full/)).toBeInTheDocument();
    expect(fold(bare.container, /^The segments as numbers/)).toBeInTheDocument();
  });

  it('tabulates only the Calendar days something landed on, and none from outside the window', () => {
    const { container } = render(SAMPLES.Calendar);
    const rows = tabulated(container, FOLDS.Calendar);
    // The day 400 days back is outside a 26-week window: drawn nowhere, tabulated nowhere.
    expect(rows.map(([date]) => date).sort()).toEqual([day(2), day(0)].sort());
    for (const [, count] of rows) expect(count).toBeGreaterThan(0);
  });

  it('offers no fold at all when there is nothing to tabulate', () => {
    // A disclosure counting "(0)" is an invitation to a blank table.
    const { container } = render(<Bars data={[]} />);
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('the drawing equals its table', () => {
  it('Bars: one row per drawn week, at the drawn count', () => {
    const { container } = render(SAMPLES.Bars);
    const figure = drawn(container);
    expect(figure).toHaveLength(3);
    expect(sorted(tabulated(container, FOLDS.Bars))).toEqual(sorted(figure));
  });

  it('Calendar: exactly the days drawn with something in them', () => {
    const { container } = render(SAMPLES.Calendar);
    const figure = drawn(container, (value) => value > 0);
    expect(figure.map(([date]) => date).sort()).toEqual([day(2), day(0)].sort());
    expect(sorted(tabulated(container, FOLDS.Calendar))).toEqual(sorted(figure));
  });

  it('BarList: every ranked row, at its value', () => {
    const { container } = render(SAMPLES.BarList);
    const figure = drawn(container);
    expect(figure).toHaveLength(2);
    expect(sorted(tabulated(container, FOLDS.BarList))).toEqual(sorted(figure));
  });

  it('StackBar: every segment, at its count', () => {
    const { container } = render(SAMPLES.StackBar);
    const figure = drawn(container);
    expect(figure).toHaveLength(3);
    expect(sorted(tabulated(container, FOLDS.StackBar))).toEqual(sorted(figure));
  });
});

describe('the figures as figures', () => {
  it('draws the current week apart from the rest', () => {
    const { container } = render(SAMPLES.Bars);
    const bars = [...container.querySelectorAll('[data-figure="Bars"] [data-datum]')];
    expect(bars).toHaveLength(3);
    expect(bars.at(-1)!.getAttribute('fill')).toBe('var(--action)');
    expect(bars.at(-1)!.getAttribute('class') ?? '').not.toContain('state-');
    expect(bars[0]!.getAttribute('fill')).toBe('var(--state)');
  });

  it('gives a zero-count bar no height rather than a misleading minimum', () => {
    const { container } = render(<Bars data={[{ week: 'w', count: 0 }]} />);
    expect(container.querySelector('[data-figure="Bars"] [data-datum]')!.getAttribute('height')).toBe('0');
  });

  it('scales BarList against its own maximum', () => {
    const { container } = render(
      <BarList
        items={[
          { name: 'a', value: 10 },
          { name: 'b', value: 5 },
        ]}
      />,
    );
    expect(widths(container)).toEqual(['100%', '50%']);
  });

  it('writes a BarList value with the page’s formatter everywhere — the bars, the readout and the numbers', () => {
    const usd = (value: number) => `$${value.toFixed(2)}`;
    const { container } = render(
      <BarList
        items={[
          { name: 'plan-a', value: 3 },
          { name: 'plan-b', value: 1 },
        ]}
        format={usd}
        unit=" ignored"
        label="plans"
      />,
    );
    const knob = slider(container);
    fireEvent.keyDown(knob, { key: 'Home' });
    expect(knob.getAttribute('aria-valuetext')).toBe('plan-a: $3.00, 75% of the total');
    expect(container.querySelector('[data-readout]')?.textContent).toBe('plan-a: $3.00, 75% of the total');
    expect(container.querySelector('[data-datum="plan-a"]')?.textContent).toContain('$3.00');
    fireEvent.click(fold(container, /^The plans, in full/));
    expect(cellsOf(container)).toEqual([
      ['plan-a', '$3.00', '75%'],
      ['plan-b', '$1.00', '25%'],
    ]);
    expect(container.textContent).not.toContain('ignored');
  });

  it('says so in one line, and offers no fold, when there is nothing to rank', () => {
    const { container, rerender } = render(<BarList items={[]} />);
    expect(container.textContent).toBe('Nothing recorded yet.');
    expect(container.firstElementChild?.className).toContain('text-meta');
    expect(container.firstElementChild?.className).toContain('text-ink-muted');
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('[data-figure]')).toBeNull();
    rerender(<BarList items={[]} empty="No handoff records a skill yet." />);
    expect(container.textContent).toBe('No handoff records a skill yet.');
  });

  it('divides a StackBar proportionally, from the inline start', () => {
    const { container } = render(
      <StackBar
        segments={[
          { label: 'done', value: 3, tone: 'done' },
          { label: 'next up', value: 1, tone: 'queued' },
        ]}
      />,
    );
    expect(widths(container)).toEqual(['75%', '25%']);
    const [first, second] = [...container.querySelectorAll<HTMLElement>('[data-figure] [data-datum]')];
    expect(first!.style.insetInlineStart).toBe('0%');
    expect(second!.style.insetInlineStart).toBe('75%');
    for (const segment of [first!, second!]) {
      expect(segment.style.left).toBe('');
      expect(segment.style.right).toBe('');
    }
  });

  it('does not divide by zero when every segment is empty, and refuses to invent a share', () => {
    const { container } = render(<StackBar segments={[{ label: 'done', value: 0, tone: 'done' }]} />);
    expect(widths(container)).toEqual(['0%']);
    // 0 of 0 is not 0 of 1: the bar divides by a floor of 1 to draw itself,
    // and the table must not borrow it to print a share of a total that does
    // not exist.
    fireEvent.click(fold(container, /^The segments as numbers/));
    expect(cellsOf(container)).toEqual([['done', '0', '—']]);
  });

  it('keys a StackBar with the kit’s legend — each segment’s word, count and paint', () => {
    const { container } = render(SAMPLES.StackBar);
    const key = container.querySelector('[data-slot="legend"]');
    expect(key).not.toBeNull();
    const entries = [...key!.querySelectorAll('li')];
    expect(entries.map((entry) => entry.textContent)).toEqual(['done9', 'waiting2', 'failed1']);
    expect(entries[1]!.querySelector('.state-waiting.bg-state')).not.toBeNull();
  });

  it('gives StackBar segments a real tooltip, and leaks no <title> into the page', () => {
    // HTML, not SVG: a `<title>` child there is the document HEAD element,
    // parsed out of place — so the tooltip is the attribute.
    const { container } = render(SAMPLES.StackBar);
    const titles = [...container.querySelectorAll('[data-figure] [data-datum]')].map((segment) =>
      segment.getAttribute('title'),
    );
    expect(titles).toEqual(['done: 9', 'waiting: 2', 'failed: 1']);
    for (const title of container.querySelectorAll('title')) expect(title.closest('svg')).not.toBeNull();
  });

  it('makes every svg a named picture or a hidden decoration — never a third thing', () => {
    // A FIGURE owes a role and a name; DECORATION — the numbers fold's chevron —
    // owes `aria-hidden` and must not claim `role="img"`. Scanning `svg` alone
    // would make a hidden icon look like a nameless chart; scanning only named
    // ones would let a chart escape by shipping without a role at all.
    for (const name of FIGURES) {
      const { container, unmount } = exercise(name);
      const svgs = [...container.querySelectorAll('svg')];
      expect(svgs.length, name).toBeGreaterThan(0);
      for (const svg of svgs) {
        if (svg.getAttribute('aria-hidden') === 'true') {
          expect(svg.getAttribute('role'), 'decoration must not claim a role').not.toBe('img');
          continue;
        }
        expect(svg.getAttribute('role'), name).toBe('img');
        expect(svg.getAttribute('aria-label'), name).toBeTruthy();
      }
      unmount();
    }
  });

  it('builds a calendar of the window ending today, oldest first, empty days at no intensity', () => {
    const cells = calendarCells(
      [
        { date: day(0), count: 4 },
        { date: day(1), count: 2 },
      ],
      2,
    );
    expect(cells.at(-1)!.date).toBe(day(0));
    expect(cells.map((cell) => cell.date)).toEqual([...cells.map((cell) => cell.date)].sort());
    expect(cells.at(-1)!.intensity).toBe(1);
    expect(cells.at(-2)!.intensity).toBeCloseTo(0.25 + 0.5 * 0.75);
    expect(cells.filter((cell) => cell.count === 0).every((cell) => cell.intensity === 0)).toBe(true);
    expect(cells.length).toBeLessThanOrEqual(3 * 7);
  });

  it('halves the Calendar on a phone', () => {
    viewport.narrow = true;
    const { container } = render(SAMPLES.Calendar);
    fireEvent.click(fold(container, FOLDS.Calendar));
    expect(container.querySelector('caption')?.textContent).toBe(
      'Phase completions by day over the last 13 weeks',
    );
    expect(container.querySelector('[data-readout]')?.textContent).toBe('Last 13 weeks');
  });
});

/* ------------------------------------------------------------------ *
 * The type a drawing writes, and the room it is given (quiet-console
 * phase 27: the axes were 9 px, under design law's 12 px floor). jsdom
 * measures nothing, so a drawing is laid out at a width by reporting one,
 * and a label's extent is read from its own attributes and its width at the
 * figures' type — an estimate never narrower than the font draws it.
 * ------------------------------------------------------------------ */

/** Lay every drawing out `width` px wide, as a browser would measure its box. */
const measuredAt = (width: number) =>
  vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({ width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0 } as DOMRect);

/** A length an attribute writes, in px: a number, or ems of the figures' type. */
const px = (value: string | null): number =>
  value?.endsWith('em') ? Number.parseFloat(value) * FIGURE_TYPE : Number(value ?? 0);

/** How far a node's ancestors move it: the sum of their `translate(x, y)`s. */
function shift(node: Element): [number, number] {
  let [dx, dy] = [0, 0];
  for (let at = node.parentElement; at && at.tagName !== 'svg'; at = at.parentElement) {
    const moved = /translate\(\s*([-\d.]+)[ ,]+([-\d.]+)\s*\)/.exec(at.getAttribute('transform') ?? '');
    if (moved) [dx, dy] = [dx + Number(moved[1]), dy + Number(moved[2])];
  }
  return [dx, dy];
}

/** A written label in the SVG's own units: where it starts and ends, and its baseline. */
function placed(text: Element): { from: number; to: number; baseline: number } {
  const [dx, dy] = shift(text);
  const at = dx + px(text.getAttribute('x')) + px(text.getAttribute('dx'));
  const wide = textWidth(text.textContent ?? '');
  const anchor = text.getAttribute('text-anchor') ?? 'start';
  const from = anchor === 'end' ? at - wide : anchor === 'middle' ? at - wide / 2 : at;
  return { from, to: from + wide, baseline: dy + px(text.getAttribute('y')) + px(text.getAttribute('dy')) };
}

/** No two of these labels share a pixel, left to right. */
function expectApart(labels: { from: number; to: number }[], what: string) {
  const sorted = [...labels].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i]!.from, `${what}: label ${i} starts past label ${i - 1}`).toBeGreaterThan(
      sorted[i - 1]!.to,
    );
  }
}

/** Twenty-six weeks, as the server buckets them (`2026-W15` …), with counts up to `top`. */
const weeks = (top: number) =>
  Array.from({ length: 26 }, (_, i) => ({
    week: `2026-W${String(15 + i).padStart(2, '0')}`,
    count: Math.round(((i * 7) % 26) * (top / 25)),
  }));

describe('the type a drawing writes, and its room', () => {
  it('writes every word in the figures’ one type size — the counts, the weeks and the months', () => {
    for (const name of ['Bars', 'Calendar'] as const) {
      const { container, unmount } = render(SAMPLES[name]);
      const texts = [...container.querySelectorAll('[data-figure] svg text')];
      expect(texts.length, name).toBeGreaterThan(0);
      for (const text of texts) {
        expect(text.getAttribute('font-size'), `${name}: ${text.textContent}`).toBe(String(FIGURE_TYPE));
      }
      unmount();
    }
  });

  // A 360 px phone's figure is about 300 px across; a desk's, 600 to 900.
  for (const width of [296, 328, 600, 900]) {
    it(`Bars at ${width} px: every count in its gutter and on its own line, no two weeks touching, none off the drawing`, () => {
      measuredAt(width);
      for (const top of [7, 25, 198]) {
        const { container, unmount } = render(<Bars data={weeks(top)} label="phases" />);
        const svg = container.querySelector('[data-figure="Bars"] svg')!;
        expect(svg.getAttribute('viewBox'), `${top}`).toBe(`0 0 ${width} ${svg.getAttribute('height')}`);
        const height = Number(svg.getAttribute('height'));
        const plotStart = Math.min(
          ...[...svg.querySelectorAll('[data-datum]')].map((bar) => Number(bar.getAttribute('x'))),
        );

        const counts = [...svg.querySelectorAll('.visx-axis-left text')].map(placed);
        expect(counts.length, `${top}: counts`).toBeGreaterThan(1);
        for (const count of counts) {
          expect(count.from, `${top}: a count inside the drawing`).toBeGreaterThanOrEqual(0);
          expect(count.to, `${top}: a count left of the bars`).toBeLessThan(plotStart);
          expect(
            count.baseline - FIGURE_CAP,
            `${top}: a count under the drawing's top`,
          ).toBeGreaterThanOrEqual(0);
        }
        const lines = counts.map((count) => count.baseline).sort((a, b) => a - b);
        for (let i = 1; i < lines.length; i++) {
          expect(lines[i]! - lines[i - 1]!, `${top}: two counts a numeral apart`).toBeGreaterThan(FIGURE_CAP);
        }

        const labels = [...svg.querySelectorAll('.visx-axis-bottom text')].map(placed);
        expect(labels.length, `${top}: weeks`).toBeGreaterThan(1);
        // The current week is always named.
        expect(svg.querySelector('.visx-axis-bottom')!.textContent).toContain('W40');
        for (const label of labels) {
          expect(label.from, `${top}: a week inside the drawing`).toBeGreaterThanOrEqual(0);
          expect(label.to, `${top}: a week inside the drawing`).toBeLessThanOrEqual(width);
          expect(label.baseline + FIGURE_DESCENT, `${top}: a week above the bottom edge`).toBeLessThanOrEqual(
            height,
          );
        }
        expectApart(labels, `${width}px, top ${top}: weeks`);
        unmount();
      }
    });
  }

  for (const [narrow, width] of [
    [true, 296],
    [true, 328],
    [false, 600],
    [false, 900],
  ] as const) {
    it(`Calendar at ${width} px: every month in its band, over the cells, and no two touching — whatever day it is`, () => {
      measuredAt(width);
      viewport.narrow = narrow;
      vi.useFakeTimers({ toFake: ['Date'] });
      // A month a day for five weeks: every way a month can fall across the
      // window's first and last weeks, the cramped first column included.
      for (let day = 0; day < 35; day++) {
        vi.setSystemTime(new Date(Date.UTC(2026, 7, 20 + day, 12)));
        const { container, unmount } = render(<Calendar data={[]} />);
        const svg = container.querySelector('[data-figure="Calendar"] svg')!;
        const cellsTop = Math.min(
          ...[...svg.querySelectorAll('[data-datum]')].map((cell) => Number(cell.getAttribute('y'))),
        );
        const months = [...svg.querySelectorAll('.visx-axis-top text')].map(placed);
        expect(months.length, `${width}px, day ${day}`).toBeGreaterThan(1);
        for (const month of months) {
          expect(month.from, `day ${day}: a month inside the drawing`).toBeGreaterThanOrEqual(0);
          expect(month.to, `day ${day}: a month inside the drawing`).toBeLessThanOrEqual(width);
          expect(month.baseline - FIGURE_TYPE * 0.8, `day ${day}: under the top edge`).toBeGreaterThanOrEqual(
            0,
          );
          expect(
            month.baseline + FIGURE_DESCENT,
            `day ${day}: a descender clears the cells`,
          ).toBeLessThanOrEqual(cellsTop);
        }
        expectApart(months, `${width}px, day ${day}: months`);
        unmount();
      }
    });
  }
});

describe('one interaction vocabulary, on each figure', () => {
  for (const name of FIGURES) {
    it(`${name}: the crosshair is a slider a keyboard reaches, and the line under it reads what it says`, () => {
      const { container } = render(SAMPLES[name]);
      const knob = slider(container);
      expect(knob).toHaveAttribute('tabindex', '0');
      expect(knob).toHaveAttribute('data-figure', name);
      expect(knob.getAttribute('aria-label')).toBeTruthy();
      knob.focus();
      fireEvent.keyDown(knob, { key: 'Home' });
      expect(knob.getAttribute('aria-valuenow')).toBe('0');
      fireEvent.keyDown(knob, { key: 'End' });
      expect(knob.getAttribute('aria-valuenow')).not.toBe('0');
      const said = knob.getAttribute('aria-valuetext');
      expect(said).toBeTruthy();
      expect(said).not.toContain(' · ');
      const readout = container.querySelector('[data-readout]');
      expect(readout?.textContent).toBe(said);
      // The line is the slider's next sibling, never inside it.
      expect(knob.nextElementSibling?.contains(readout!)).toBe(true);
    });

    it(`${name}: + zooms, 0 resets, and the way back is a button outside the slider`, () => {
      const { container } = render(SAMPLES[name]);
      const knob = slider(container);
      expect(resetButton(container)).toBeNull();
      fireEvent.keyDown(knob, { key: '+' });
      const reset = resetButton(container)!;
      expect(reset).toHaveTextContent(/^Reset zoom, ×\d+\.\d$/);
      expect(knob.contains(reset)).toBe(false);
      expect(knob.nextElementSibling?.contains(reset)).toBe(true);
      fireEvent.keyDown(knob, { key: '0' });
      expect(resetButton(container)).toBeNull();
      fireEvent.keyDown(knob, { key: '+' });
      fireEvent.click(resetButton(container)!);
      expect(resetButton(container)).toBeNull();
    });

    it(`${name}: a plain wheel is the page's; ⌃ + wheel zooms; a vertical swipe is left to the page`, () => {
      const { container } = render(SAMPLES[name]);
      const surface = container.querySelector<HTMLElement>(`[data-figure="${name}"]`)!;
      expect(surface.style.touchAction).toBe('pan-y');

      const plain = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
      surface.dispatchEvent(plain);
      expect(plain.defaultPrevented).toBe(false);
      expect(resetButton(container)).toBeNull();

      const pinch = new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true });
      fireEvent(surface, pinch);
      expect(pinch.defaultPrevented).toBe(true);
      expect(resetButton(container)).toBeInTheDocument();
    });
  }

  it('reads a pointer from the inline start, so a right-to-left page mirrors the crosshair with the bar', () => {
    /** The segment under a hover at each client x, in turn, on a 100 px bar. */
    const read = (dir: 'ltr' | 'rtl', xs: number[]) => {
      const { container, unmount } = render(<div dir={dir}>{SAMPLES.StackBar}</div>);
      const bar = container.querySelector('[data-figure="StackBar"] [role="img"]')!;
      bar.getBoundingClientRect = () =>
        ({ left: 0, right: 100, width: 100, top: 0, bottom: 10, height: 10, x: 0, y: 0 }) as DOMRect;
      const knob = slider(container);
      const out = xs.map((clientX) => {
        fireEvent.pointerMove(knob, { clientX, clientY: 5, pointerType: 'mouse' });
        return knob.getAttribute('aria-valuenow');
      });
      unmount();
      return out;
    };
    // Near the right-hand edge is the inline END of a left-to-right bar — the
    // last segment — and the START of a right-to-left one. Each direction is
    // read at both ends, so neither answer can be the slider's resting value.
    expect(read('ltr', [95, 5])).toEqual(['2', '0']);
    expect(read('rtl', [5, 95])).toEqual(['2', '0']);
  });
});
