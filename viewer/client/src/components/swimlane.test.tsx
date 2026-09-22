/**
 * The swimlane primitive — the drawing, with none of the meaning.
 *
 * `Gantt` used to be both: the geometry (`ROW`/`BAR`/`TRACK`/`AXIS`, `ticksFor`,
 * the hatch, the `.state-*` bridge) AND the claim that a row is a phase and a
 * bar is a boarding. Debug ▸ Timeline draws rows that are sessions, console
 * marks and git commands, so the geometry had to come out — and the test that
 * matters for an extraction is that the thing extracted still says exactly what
 * it said before, for a caller that knows nothing about phases.
 *
 * Three properties, because each is a claim the picture makes on its own:
 * an open bar is hatched rather than solid, the axis lands on round units, and
 * a row's label is real text outside the SVG (an `<svg><text>` is not something
 * anybody can reach with a keyboard).
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AXIS, BAR, ROW, Swimlane, TRACK, ticksFor, type SwimlaneRow } from './swimlane';

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
    // The Gantt's label column pads by `AXIS / height` and spaces rows by
    // `ROW / height`. Those are arithmetic over these four, so they are exports
    // rather than private consts — a second copy would drift by a pixel a
    // release until the labels no longer lined up with the bars.
    expect([ROW, BAR, TRACK, AXIS]).toEqual([22, 11, 1000, 16]);
    expect(BAR).toBeLessThan(ROW);
  });
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

  it('draws nothing but says so when there are no rows', () => {
    const { container } = render(<Swimlane spanMs={0} ariaLabel="empty" rows={[]} />);
    expect(container.querySelector('svg')).toBeNull();
  });
});
