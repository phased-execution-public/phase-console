/**
 * The four charts.
 *
 * The property under test is the one the port exists to establish: **a chart
 * cannot be painted a colour the design system does not have.** The legacy
 * charts took a `color` string per segment and every call site passed
 * `var(--line-…)` by hand — which worked, and would equally have accepted
 * `#ff0000`. Here the palette is a closed set of tone names, so the guard is a
 * scan of the rendered output for any literal colour at all.
 *
 * That matters because a raw hex is invisible in one theme. Night and Paper have
 * different lightness for every state colour; a hardcoded green looks correct on
 * the board and unreadable on the map, and nobody flips the theme to check a
 * chart.
 */

import type { ReactElement } from 'react';
import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import * as charts from './charts';
import {
  BarList,
  Bars,
  CHART_FIGURES,
  CHART_MARKS,
  CHART_TONES,
  Calendar,
  LoadMeter,
  RouteStrip,
  RunStrip,
  StackBar,
  toneVar,
} from './charts';

/** Anything that is a colour but not a token reference. */
const LITERAL_COLOUR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\boklab\(/i;

/** Every `fill`, `stroke` and inline `background` in a rendered tree. */
function paints(container: HTMLElement): string[] {
  const out: string[] = [];
  for (const node of container.querySelectorAll<HTMLElement>('*')) {
    for (const attr of ['fill', 'stroke'] as const) {
      const value = node.getAttribute(attr);
      if (value) out.push(value);
    }
    const style = node.getAttribute('style');
    if (style) out.push(style);
  }
  return out;
}

const VELOCITY = [
  { week: '2026-W29', count: 2 },
  { week: '2026-W30', count: 5 },
  { week: '2026-W31', count: 0 },
];

const CALENDAR = [
  { date: '2026-08-01', count: 3 },
  { date: '2026-08-02', count: 1 },
];

/**
 * Exported components that are charts of neither kind, each with its reason.
 *
 * An allowlist, not a filter: the inventory guard below is derived from the
 * module's own exports precisely so an undeclared chart cannot ship, and the
 * only way past it is to write down why a component is not one.
 */
const NOT_A_CHART: Record<string, string> = {
  ChartNumbers: 'the table under a figure, not a figure — it draws nothing',
};

/**
 * Every component this module exports, by name.
 *
 * A component is an exported function whose name is capitalised, which leaves
 * `toneVar` out on its own casing and the frozen arrays out on their type.
 * Interfaces and type aliases do not exist at runtime, so they never appear.
 */
function exportedComponents(): string[] {
  return Object.entries(charts)
    .filter(([name, value]) => typeof value === 'function' && /^[A-Z]/.test(name))
    .map(([name]) => name)
    .filter((name) => !(name in NOT_A_CHART));
}

/**
 * One rendering of each figure, enough to draw a table from.
 *
 * Keyed by the figure's name and asserted complete against `CHART_FIGURES`, so
 * a figure added to that list arrives here or the guard fails — which is what
 * makes the driver below a check on the inventory rather than on four charts
 * somebody remembered to write cases for.
 */
const FIGURE_SAMPLES: Record<(typeof CHART_FIGURES)[number], ReactElement> = {
  Bars: <Bars data={VELOCITY} label="phases" />,
  Calendar: <Calendar data={CALENDAR} />,
  BarList: <BarList items={[{ name: 'phased-execution', value: 4 }]} label="repos" />,
  StackBar: <StackBar segments={[{ label: 'done', value: 3, tone: 'done' }]} label="sizes" />,
};

describe('the chart palette', () => {
  it('resolves every tone — the eight UI states — to a --status-* custom property', () => {
    expect([...CHART_TONES]).toEqual([
      'needs-you',
      'failed',
      'running',
      'verifying',
      'waiting',
      'queued',
      'skipped',
      'done',
    ]);
    for (const tone of CHART_TONES) {
      expect(toneVar(tone)).toBe(`var(--status-${tone})`);
    }
  });

  it('paints Bars with tokens only', () => {
    const { container } = render(<Bars data={VELOCITY} />);
    const used = paints(container);
    expect(used.length).toBeGreaterThan(0);
    for (const value of used) expect(value, value).not.toMatch(LITERAL_COLOUR);
  });

  it('paints the Calendar with tokens only, including the mixed intensities', () => {
    const { container } = render(<Calendar data={CALENDAR} />);
    const used = paints(container);
    // The heat cells are `color-mix(... var(--status-done) N%, var(--track))`,
    // which is the one place a percentage could tempt a literal.
    expect(used.some((v) => v.includes('color-mix'))).toBe(true);
    for (const value of used) expect(value, value).not.toMatch(LITERAL_COLOUR);
  });

  it('paints BarList and StackBar with tokens only', () => {
    const { container } = render(
      <>
        <BarList
          items={[
            { name: 'aws', value: 4 },
            { name: 'hub', value: 1 },
          ]}
        />
        <StackBar
          segments={[
            { label: 'done', value: 3, tone: 'done' },
            { label: 'next up', value: 1, tone: 'queued' },
          ]}
        />
      </>,
    );
    for (const value of paints(container)) expect(value, value).not.toMatch(LITERAL_COLOUR);
  });
});

describe('the charts as charts', () => {
  it('marks the current week apart from the rest', () => {
    const { container } = render(<Bars data={VELOCITY} />);
    const bars = [...container.querySelectorAll('rect')];
    expect(bars).toHaveLength(VELOCITY.length);
    expect(bars.at(-1)!.getAttribute('fill')).toBe('var(--action)');
    expect(bars[0].getAttribute('fill')).toBe(toneVar('running'));
  });

  it('gives a zero-count bar no height rather than a misleading minimum', () => {
    const { container } = render(<Bars data={[{ week: 'w', count: 0 }]} />);
    expect(container.querySelector('rect')!.getAttribute('height')).toBe('0');
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
    const widths = [...container.querySelectorAll<HTMLElement>('span[style*="width"]')].map(
      (el) => el.style.width,
    );
    expect(widths).toEqual(['100%', '50%']);
  });

  it('says so rather than rendering an empty rank when there is nothing to rank', () => {
    const { container } = render(<BarList items={[]} />);
    expect(container.textContent).toMatch(/Nothing recorded yet/);
  });

  it('divides a StackBar proportionally and labels every segment', () => {
    const { container } = render(
      <StackBar
        segments={[
          { label: 'done', value: 3, tone: 'done' },
          { label: 'next up', value: 1, tone: 'queued' },
        ]}
      />,
    );
    const widths = [...container.querySelectorAll<HTMLElement>('span[style*="width"]')].map(
      (el) => el.style.width,
    );
    expect(widths).toEqual(['75%', '25%']);
    expect(container.textContent).toContain('done');
    expect(container.textContent).toContain('next up');
  });

  it('does not divide by zero when every segment is empty', () => {
    const { container } = render(<StackBar segments={[{ label: 'done', value: 0, tone: 'done' }]} />);
    expect(container.querySelector<HTMLElement>('span[style*="width"]')!.style.width).toBe('0%');
  });

  it('paints the LoadMeter and the RouteStrip with tokens only', () => {
    const { container } = render(
      <>
        <LoadMeter fraction={0.4} label="40%" description="40% of a session" />
        <RouteStrip
          phases={[
            { phase: 1, state: 'done' },
            { phase: 2, state: 'ready' },
          ]}
        />
      </>,
    );
    for (const value of paints(container)) expect(value, value).not.toMatch(LITERAL_COLOUR);
  });

  it('draws a load as a share of the bar, clamped for anything over budget', () => {
    const { container, rerender } = render(<LoadMeter fraction={0.4} label="40%" />);
    expect(container.querySelector<HTMLElement>('span[style*="width"]')!.style.width).toBe('40%');
    rerender(<LoadMeter fraction={1} label="over" />);
    expect(container.querySelector<HTMLElement>('span[style*="width"]')!.style.width).toBe('100%');
  });

  it('says so rather than drawing an empty meter when there is nothing to measure', () => {
    const { container } = render(<LoadMeter fraction={null} label="unsized" />);
    expect(container.querySelector('span[style*="width"]')).toBeNull();
    expect(container.textContent).toBe('unsized');
  });

  it('paints a state the engine has not taught it as the unknown state, never transparent', () => {
    // `var(--status-${state})` would interpolate an undeclared property for a
    // new engine word and paint the segment invisible — which reads as "this
    // phase does not exist" rather than "we do not know what this is". The
    // vocabulary's unknown state is `waiting`: never amber, never green.
    const { container } = render(<RouteStrip phases={[{ phase: 1, state: 'quantum-superposition' }]} />);
    const segment = container.querySelector<HTMLElement>('[title^="P1"]')!;
    expect(segment.style.background).toBe(toneVar('waiting'));
  });

  it('gives a strip one segment per phase and names the progress', () => {
    const { container } = render(
      <RouteStrip
        phases={[
          { phase: 1, state: 'done' },
          { phase: 2, state: 'done' },
          { phase: 3, state: 'ready' },
        ]}
      />,
    );
    const strip = container.querySelector('[role="img"]')!;
    // Every non-zero state, worst-first, in the vocabulary's own words — not
    // `done` alone, which could not say whether the third phase was running,
    // waiting on a lock, or red.
    expect(strip.getAttribute('aria-label')).toBe('3 of 3 phases: 1 queued, 2 done');
    expect(strip.children).toHaveLength(3);
    // …and the same facts ON THE SCREEN. The counting was always done and was
    // rendered to nothing but the accessibility tree.
    expect(container.textContent).toContain('3');
    expect(container.textContent).toContain('done');
    expect(container.textContent).toContain('queued');
  });

  it('drops the strip tally where the row already carries the numbers', () => {
    const { container } = render(
      <RouteStrip
        tally={false}
        phases={[
          { phase: 1, state: 'done' },
          { phase: 2, state: 'ready' },
        ]}
      />,
    );
    // The bar keeps its accessible name either way — turning the tally off is
    // a decision about DUPLICATION on the card, never about the a11y tree.
    expect(container.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe(
      '2 of 2 phases: 1 queued, 1 done',
    );
    expect(container.textContent).not.toContain('done');
  });

  it('paints a run strip with tokens only, including a status it has not been taught', () => {
    const { container } = render(
      <RunStrip
        phases={[
          { phase: 1, status: 'done' },
          { phase: 2, status: 'failed' },
          { phase: 3, status: 'quantum-superposition' },
        ]}
      />,
    );
    for (const value of paints(container)) expect(value, value).not.toMatch(LITERAL_COLOUR);
    // Same fallback the route strip makes: the unknown state says "we do not
    // know what this is", where an interpolated `var(--status-<new word>)`
    // would say nothing at all by painting the segment invisible.
    expect(container.querySelector<HTMLElement>('[title^="P3"]')!.style.background).toBe(toneVar('waiting'));
  });

  it('reads a run phase with the runner vocabulary, not the plan one', () => {
    // The two strips share exactly one word — `done`. A single table covering
    // both would have to answer what a `blocked` run phase is, and there is no
    // such thing.
    const { container } = render(
      <RunStrip
        phases={[
          { phase: 1, status: 'failed' },
          { phase: 2, status: 'parked' },
          { phase: 3, status: 'awaiting-verification' },
          { phase: 4, status: 'skipped' },
        ]}
      />,
    );
    const fills = [...container.querySelector('[role="img"]')!.children].map(
      (c) => (c as HTMLElement).style.background,
    );
    // `parked` is a queue of questions, not a failure — it needs a person,
    // never red; `awaiting-verification` likewise; `skipped` is its own word.
    expect(fills).toEqual([
      toneVar('failed'),
      toneVar('needs-you'),
      toneVar('needs-you'),
      toneVar('skipped'),
    ]);
  });

  it('counts a run strip by what actually finished', () => {
    const { container } = render(
      <RunStrip
        phases={[
          { phase: 1, status: 'done' },
          { phase: 2, status: 'skipped' },
          { phase: 3, status: 'failed' },
        ]}
      />,
    );
    // A skipped phase is not a done one, however the run ended — and now it is
    // counted as what it is rather than merely excluded from `done`.
    expect(container.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe(
      '3 of 3 phases: 1 failed, 1 skipped, 1 done',
    );
    expect(container.textContent).toContain('failed');
    expect(container.textContent).toContain('skipped');
  });

  it('gives every chart an accessible name — they are img roles, not decoration', () => {
    const { container } = render(
      <>
        <Bars data={VELOCITY} />
        <Calendar data={CALENDAR} />
      </>,
    );
    // Every svg is one of exactly two things, and the guard is that there is
    // no third: a CHART, which owes a role and a name, or DECORATION, which
    // owes `aria-hidden` and must NOT claim `role="img"` — the numbers fold's
    // chevron is the second kind. Scanning `svg` alone made a hidden icon look
    // like a nameless chart; scanning only named ones would let a real chart
    // escape the guard by shipping without a role at all.
    const svgs = [...container.querySelectorAll('svg')];
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) {
      if (svg.getAttribute('aria-hidden') === 'true') {
        expect(svg.getAttribute('role'), 'decoration must not claim a role').not.toBe('img');
        continue;
      }
      expect(svg.getAttribute('role')).toBe('img');
      expect(svg.getAttribute('aria-label')).toBeTruthy();
    }
  });

  /**
   * `Bars` and `Calendar` get their per-datum readout from a `<title>` CHILD,
   * which is right: inside the SVG namespace `<title>` IS the tooltip element.
   * `StackBar` is HTML — a `<div>` of `<span>`s — and a `<title>` there is the
   * document HEAD element, parsed out of place. So its segments had no tooltip
   * at all, and stray `<title>` nodes leaked into the document.
   */
  it('gives StackBar segments a real tooltip, and leaks no <title> into the page', () => {
    const { container } = render(
      <StackBar
        segments={[
          { label: 'S', value: 3, tone: 'done' },
          { label: 'M', value: 5, tone: 'running' },
          { label: 'L', value: 2, tone: 'waiting' },
        ]}
      />,
    );
    const titles = [...container.querySelectorAll('span')]
      .map((span) => span.getAttribute('title'))
      .filter(Boolean);
    expect(titles).toEqual(expect.arrayContaining(['S: 3', 'M: 5', 'L: 2']));
    // Not one `<title>` ELEMENT outside an <svg> — that was the leak.
    for (const title of container.querySelectorAll('title')) {
      expect(title.closest('svg')).not.toBeNull();
    }
  });
});

/**
 * The numbers under a chart — the third rung of the disclosure ladder, applied
 * to a picture.
 *
 * The property under test is that a FIGURE cannot ship without its data. SVG
 * gives a screen reader an `aria-label` and a shape; a phone gives a `<title>`
 * tooltip to nobody at all. Both readers get the same answer here or they get
 * no answer, so the table is built into the chart rather than offered to the
 * call site — and these tests are what keeps that true as charts are added.
 */
describe('every figure carries its numbers', () => {
  const open = (container: HTMLElement, name: RegExp) => {
    fireEvent.click(within(container).getByRole('button', { name }));
  };

  it('holds the inventory closed — a chart is a figure or a mark, never neither', () => {
    // Derived from the MODULE, not restated from the source. The literal this
    // replaced could only catch a name deleted from a list, never a chart
    // added to neither — which is the failure the two lists exist to prevent,
    // and which `ChartNumbers` was already shipping green.
    const named = [...CHART_FIGURES, ...CHART_MARKS];
    expect(new Set(named).size, 'a chart cannot be both a figure and a mark').toBe(named.length);
    expect([...named].sort(), 'every exported component is a figure or a mark').toEqual(
      [...exportedComponents()].sort(),
    );
    for (const name of named) {
      expect(typeof (charts as Record<string, unknown>)[name], `${name} is exported`).toBe('function');
    }
  });

  it('renders the numbers for every figure, not for four of them by hand', () => {
    // The driver over `CHART_FIGURES` itself: a figure added to the list with
    // no sample here fails at the first assertion, and one whose table is
    // missing, unnamed or unreachable fails at the rest. Four hand-written
    // cases can only ever check the four that were written.
    expect(Object.keys(FIGURE_SAMPLES).sort(), 'every figure needs a sample to render').toEqual(
      [...CHART_FIGURES].sort(),
    );

    for (const name of CHART_FIGURES) {
      const { container, unmount } = render(FIGURE_SAMPLES[name]);
      // The numbers fold, by the attribute that makes it one — a figure may
      // grow a second button, and `getByRole('button')` would then fail on the
      // count rather than on the property under test.
      const toggle = container.querySelector<HTMLElement>('button[aria-expanded="false"]');
      expect(toggle, `${name} offers its numbers`).not.toBeNull();
      fireEvent.click(toggle!);
      const caption = container.querySelector('caption');
      expect(caption?.textContent, `${name} captions its table`).toBeTruthy();
      expect(container.querySelectorAll('tbody tr').length, `${name} tabulates its rows`).toBeGreaterThan(0);
      // A bounded scroll region a keyboard cannot enter is one a keyboard user
      // cannot read to the end of, and a group named by anything but its own
      // caption is a second name for one table.
      const scroller = container.querySelector('[role="group"]')!;
      expect(scroller.getAttribute('tabindex'), `${name} keeps its scroller reachable`).toBe('0');
      expect(scroller.getAttribute('aria-label'), `${name} names its table once`).toBe(caption!.textContent);
      unmount();
    }
  });

  it('folds the numbers away by default and says how many are in there', () => {
    const { container } = render(<Bars data={VELOCITY} label="phases" />);
    const toggle = within(container).getByRole('button', { name: /the weeks/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // The count is drawn while folded — that is when it informs the decision
    // to open. Three weeks of data, three rows.
    expect(toggle.textContent).toContain('3');
    expect(container.querySelector('table')).toBeNull();
  });

  it('gives Bars a row per week, in the chart’s own order', () => {
    const { container } = render(<Bars data={VELOCITY} label="phases" />);
    open(container, /the weeks/i);
    const rows = [...container.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent),
    );
    expect(rows).toEqual([
      ['2026-W29', '2'],
      ['2026-W30', '5'],
      ['2026-W31', '0'],
    ]);
    // The label names the measure in both places — the column head and the
    // table's accessible name — so the fold is readable without the chart.
    expect(within(container).getByRole('columnheader', { name: 'phases' })).toBeTruthy();
    expect(container.querySelector('caption')!.textContent).toContain('phases per week');
  });

  it('tabulates only the days the Calendar has something to report, and says so', () => {
    const { container } = render(<Calendar data={[...CALENDAR, { date: '2026-08-03', count: 0 }]} />);
    open(container, /the days with a completion/i);
    const rows = [...container.querySelectorAll('tbody tr')];
    // A year of squares is ~180 rows of which most are zero. Only the days
    // something landed on are rows; the note carries the denominator.
    for (const row of rows) expect(row.textContent).not.toMatch(/\b0$/);
    expect(container.textContent).toMatch(/days in the window; the rest completed nothing/);
  });

  it('gives BarList the two things the bars cannot say: the full name and the share', () => {
    const { container } = render(
      <BarList
        label="repos"
        items={[
          { name: 'a-very-long-repository-slug-that-truncates', value: 3 },
          { name: 'hub', value: 1 },
        ]}
      />,
    );
    open(container, /the repos, in full/i);
    const first = [...container.querySelectorAll('tbody tr')][0].querySelectorAll('td');
    expect(first[0].textContent).toBe('a-very-long-repository-slug-that-truncates');
    expect(first[1].textContent).toBe('3');
    expect(first[2].textContent).toBe('75%');
  });

  it('reads a share off StackBar, and refuses to invent one when nothing was counted', () => {
    const { container, unmount } = render(
      <StackBar
        label="phase states"
        segments={[
          { label: 'done', value: 3, tone: 'done' },
          { label: 'next up', value: 1, tone: 'queued' },
        ]}
      />,
    );
    open(container, /the phase states as numbers/i);
    expect([...container.querySelectorAll('tbody tr')][0].textContent).toContain('75%');
    unmount();

    // 0 of 0 is not 0 of 1. The bar divides by a floor of 1 so it can draw
    // itself; the table must not borrow that floor and print a percentage of
    // a total that does not exist.
    const empty = render(<StackBar segments={[{ label: 'done', value: 0, tone: 'done' }]} />);
    open(empty.container, /the segments as numbers/i);
    expect([...empty.container.querySelectorAll('tbody td')].at(-1)!.textContent).toBe('—');
  });

  it('offers no fold at all when there is nothing to tabulate', () => {
    // A disclosure labelled "(0)" is an invitation to a blank table. The
    // chart's own empty state is the message.
    const { container } = render(<Bars data={[]} />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('names the table for a screen reader and keeps the scroller reachable', () => {
    const { container } = render(<Bars data={VELOCITY} label="phases" />);
    open(container, /the weeks/i);
    const scroller = container.querySelector('[role="group"]')!;
    // A bounded scroll region a keyboard cannot enter is a region a keyboard
    // user cannot read to the end of.
    expect(scroller.getAttribute('tabindex')).toBe('0');
    expect(scroller.getAttribute('aria-label')).toBe(container.querySelector('caption')!.textContent);
  });

  it('paints the numbers with tokens only, exactly like the chart above them', () => {
    const { container } = render(<StackBar segments={[{ label: 'done', value: 3, tone: 'done' }]} />);
    open(container, /the segments as numbers/i);
    for (const value of paints(container)) expect(value, value).not.toMatch(LITERAL_COLOUR);
  });

  it('leaves the marks alone — a row’s own datum owes no table', () => {
    // `LoadMeter`, `RouteStrip` and `RunStrip` render inside a `<span>` or a
    // `<td>`, where a `<table>` is invalid markup; their data is the row they
    // sit in, already spelled out beside them.
    const { container } = render(
      <>
        <LoadMeter fraction={0.4} label="40%" />
        <RouteStrip phases={[{ phase: 1, state: 'done' }]} />
        <RunStrip phases={[{ phase: 1, status: 'done' }]} />
      </>,
    );
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });
});
