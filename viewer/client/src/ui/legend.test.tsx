/**
 * One key, and every graphical surface using it (issue #10).
 *
 * The property this file holds is not "the key renders" — it is that a
 * surface cannot ship a key of its own: the census below mounts every consumer
 * and asserts each one's key carries `data-slot="legend"`, which only this
 * primitive writes (the run view's Gantt draws the same shape, marker
 * included, for its kinds).
 */

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RouteMap } from '@/screens/plan/map/dag';
import { RunGantt } from '@/screens/plan/run/gantt';
import { expectNoAxeViolations } from '@/test/axe';
import { StackBar } from './figures/lazy';
import { Legend } from './legend';

const legends = (container: HTMLElement) => container.querySelectorAll('[data-slot="legend"]');

describe('the legend primitive', () => {
  it('draws the entry’s OWN mark, not a stand-in dot', () => {
    const { container } = render(
      <Legend
        entries={[
          { key: 'a', label: 'Running', paint: 'running' },
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
          { key: 'a', label: 'done', paint: 'done', count: 9 },
          { key: 'b', label: 'running', paint: 'running' },
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

  it('is a list, one item per entry', () => {
    const { container } = render(
      <Legend
        entries={[
          { key: 'a', label: 'done', paint: 'done' },
          { key: 'b', label: 'failed', paint: 'failed' },
        ]}
      />,
    );
    expect(container.querySelector('ul[data-slot="legend"]')).toBeInTheDocument();
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  it('is clean to axe', async () => {
    const { container } = render(
      <Legend
        entries={[
          { key: 'failed', label: 'failed', paint: 'failed', count: 2 },
          { key: 'running', label: 'running', paint: 'running', count: 1 },
          { key: 'done', label: 'done', paint: 'done', count: 4 },
        ]}
      />,
    );
    await expectNoAxeViolations(container);
  });
});

/* ------------------------------------------------------------------ *
 * The census — every graphical surface, mounted
 * ------------------------------------------------------------------ */

describe('every graphical surface renders the shared legend', () => {
  // The kit's line (`ui/track`) carries its own words beside every station,
  // so it draws no key: a key under a line of named stations would say it twice.

  it('StackBar', () => {
    const { container } = render(
      <StackBar segments={[{ label: 'small', value: 3, tone: 'done' }]} label="sizes" />,
    );
    expect(legends(container).length).toBeGreaterThan(0);
  });

  it('Gantt', () => {
    const { container } = render(
      <RunGantt
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
    // The key names the kinds the figure draws, in the vocabulary's words.
    expect(
      within(container.querySelector('[data-slot="legend"]') as HTMLElement).getByText('Working'),
    ).toBeInTheDocument();
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
