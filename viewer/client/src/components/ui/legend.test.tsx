/**
 * One legend, and every graphical surface using it (issue #10).
 *
 * There were four legends, each written from scratch inside the component that
 * needed it, and none at all on the two most-looked-at bars in the product. The
 * property this file holds is not "the legend renders" — it is that a surface
 * cannot ship a key of its own again: the census below mounts every consumer and
 * asserts each one's key carries `data-slot="legend"`, which only this primitive
 * writes.
 *
 * The other half is that the words come from the vocabulary rather than from a
 * per-chart literal, so a ninth UI state counts and names itself.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { STATE_META, UI_STATES } from '@/lib/status-vocab';
import { Legend, stateEntries, stateTally } from './legend';
import { StackBar, RouteStrip, RunStrip } from '@/components/charts';
import { RouteMap } from '@/components/dag';
import { Gantt } from '@/features/runs/gantt';
import { Timeline } from '@/features/runs/timeline';

const legends = (container: HTMLElement) => container.querySelectorAll('[data-slot="legend"]');

describe('the legend primitive', () => {
  it('draws the entry’s OWN mark, not a stand-in dot', () => {
    const { container } = render(
      <Legend
        entries={[
          { key: 'a', label: 'Running', state: 'running' },
          { key: 'b', label: 'Critical path', mark: <span data-testid="real-mark" /> },
        ]}
      />,
    );
    // The route map's rule, now the system's: a legend of plain dots beside a
    // map of glyphs is a legend that teaches the wrong thing.
    expect(screen.getByTestId('real-mark')).toBeInTheDocument();
    expect(container.querySelector('.state-running')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('shows a count only when the surface counts', () => {
    render(
      <Legend
        entries={[
          { key: 'a', label: 'done', state: 'done', count: 9 },
          { key: 'b', label: 'running', state: 'running' },
        ]}
      />,
    );
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('renders nothing at all when there is nothing to explain', () => {
    const { container } = render(<Legend entries={[]} />);
    expect(legends(container)).toHaveLength(0);
  });

  it('is a list either way — `inline` only changes which elements carry it', () => {
    const block = render(<Legend entries={[{ key: 'a', label: 'done', state: 'done' }]} />);
    expect(block.container.querySelector('ul')).toBeInTheDocument();
    const inline = render(<Legend inline entries={[{ key: 'a', label: 'done', state: 'done' }]} />);
    // A `<ul>` cannot go inside a `<span>` or a strip's bar, and the semantics
    // must survive the swap rather than being dropped with the element.
    expect(inline.container.querySelector('ul')).toBeNull();
    expect(inline.container.querySelector('[role="list"]')).toBeInTheDocument();
    expect(inline.container.querySelectorAll('[role="listitem"]')).toHaveLength(1);
  });

  it('is clean to axe', async () => {
    const { container } = render(<Legend entries={stateEntries({ done: 4, running: 1, failed: 2 })} />);
    await expectNoAxeViolations(container);
  });
});

describe('the entries and the sentence come off the vocabulary', () => {
  it('walks UI_STATES worst-first and drops the zeroes', () => {
    const entries = stateEntries({ done: 4, 'needs-you': 1, running: 2, skipped: 0 });
    expect(entries.map((e) => e.key)).toEqual(['needs-you', 'running', 'done']);
    expect(entries.map((e) => e.count)).toEqual([1, 2, 4]);
    // The label is the vocabulary's, not the chart's.
    expect(entries[0]!.label).toBe(STATE_META['needs-you'].label.toLowerCase());
  });

  it('a state nobody has written a chart for still counts and names itself', () => {
    // The whole point of walking the vocabulary: no chart is edited when a
    // state is added, so every state already has an entry waiting for it.
    const counts = Object.fromEntries(UI_STATES.map((s) => [s, 1]));
    expect(stateEntries(counts)).toHaveLength(UI_STATES.length);
  });

  it('says the same sentence a SegmentBar names itself with', () => {
    expect(stateTally({ done: 2, running: 1 })).toBe('3 of 3 phases: 1 running, 2 done');
    expect(stateTally({ done: 2 }, { total: 5 })).toBe('2 of 5 phases: 2 done');
    expect(stateTally({}, { label: 'runs' })).toBe('no runs');
  });
});

/* ------------------------------------------------------------------ *
 * The census — every graphical surface, mounted
 * ------------------------------------------------------------------ */

describe('every graphical surface renders the shared legend', () => {
  const PHASES = [
    { phase: 1, state: 'done' },
    { phase: 2, state: 'running' },
    { phase: 3, state: 'ready' },
  ];

  it('RouteStrip', () => {
    const { container } = render(<RouteStrip phases={PHASES} />);
    expect(legends(container).length).toBeGreaterThan(0);
  });

  it('RunStrip', () => {
    const { container } = render(
      <RunStrip
        phases={[
          { phase: 1, status: 'done' },
          { phase: 2, status: 'failed' },
        ]}
      />,
    );
    expect(legends(container).length).toBeGreaterThan(0);
  });

  it('StackBar', () => {
    const { container } = render(
      <StackBar segments={[{ label: 'small', value: 3, tone: 'done' }]} label="sizes" />,
    );
    expect(legends(container).length).toBeGreaterThan(0);
  });

  it('Timeline', () => {
    const { container } = render(
      <Timeline
        now={10_000}
        phases={
          [
            {
              phase: 1,
              status: 'done',
              attempts: 1,
              costUsd: 0,
              startedAt: new Date(0).toISOString(),
              endedAt: new Date(5_000).toISOString(),
              durationMs: 5_000,
            },
          ] as never
        }
      />,
    );
    expect(legends(container).length).toBeGreaterThan(0);
    expect(screen.getByText('working')).toBeInTheDocument();
  });

  it('Gantt', () => {
    const { container } = render(
      <Gantt
        timeline={
          {
            startedAt: new Date(0).toISOString(),
            spanMs: 10_000,
            truncated: false,
            criticalPath: [],
            criticalMs: 0,
            marks: [],
            lanes: [
              {
                phase: 1,
                attempts: 1,
                partial: false,
                critical: false,
                workingMs: 5_000,
                verifyingMs: 0,
                waitingMs: 0,
                frozenMs: 0,
                bars: [{ attempt: 1, kind: 'working', startMs: 0, endMs: 5_000, open: false }],
              },
            ],
          } as never
        }
      />,
    );
    expect(legends(container).length).toBeGreaterThan(0);
    expect(screen.getByText('critical path')).toBeInTheDocument();
  });

  it('RouteMap — and it still draws the map’s own station marks, not dots', () => {
    const { container } = render(
      <RouteMap
        route={
          {
            nodes: [
              { phase: 1, layer: 0, row: 0, state: 'done', size: 'M', gated: false, title: 'Foundations' },
              { phase: 2, layer: 1, row: 0, state: 'ready', size: 'L', gated: false, title: 'Shell' },
            ],
            edges: [{ from: 1, to: 2 }],
            layers: 2,
            rows: 1,
          } as never
        }
      />,
    );
    expect(legends(container).length).toBeGreaterThan(0);
    // The DAG's contribution is an SVG mark, which is what `mark` is for.
    expect(container.querySelector('[data-slot="legend"] svg.legend-mark')).toBeInTheDocument();
  });
});
