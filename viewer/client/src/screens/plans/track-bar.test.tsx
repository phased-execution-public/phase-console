/**
 * A plan's line (#360), drawn as a pipeline: every phase a cell of the bar in
 * its share's paint, the legend under it as the family's badges — each wearing
 * exactly its segment's paint — and the percentage done as a badge at the
 * bar's end. The whole stays ONE picture whose name reads every count, so a
 * screen reader hears the words once and no badge is a tab stop of its own.
 */

import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { PIPELINE_MAX, PlanTrack } from './track-bar';
import type { CountsSource, PipelineStop, PlanRow } from './model';

type TrackRow = CountsSource & Pick<PlanRow, 'title'>;

const row = (over: Partial<TrackRow> = {}): TrackRow => ({
  title: 'Alpha plan',
  phases: 10,
  done: 4,
  percent: 40,
  readyPhases: [6],
  inProgress: [5],
  stuck: [7],
  waiting: 3,
  qaFailures: [],
  gated: [],
  isClosed: false,
  ...over,
});

const shares = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>('[data-share]')].map((badge) => [
    badge.dataset.share,
    badge.textContent,
    badge.dataset.paint,
  ]);

describe('the legend is the family’s badges', () => {
  it('names every non-zero share as a badge, in the line’s order, each in its segment’s paint', () => {
    const view = render(<PlanTrack row={row()} />);
    const legend = view.getByTestId('plan-legend');
    expect(shares(legend)).toEqual([
      ['done', '4 done', 'done'],
      ['in-progress', '1 in progress', 'running'],
      ['stuck', '1 stuck', 'needs-you'],
      ['ready', '1 next up', 'queued'],
      ['waiting', '3 waiting', 'waiting'],
    ]);
    for (const badge of legend.querySelectorAll<HTMLElement>('[data-share]')) {
      expect(badge.getAttribute('data-chrome')).toBe('badge');
      const segment = view.container.querySelector<HTMLElement>(`[data-segment="${badge.dataset.share}"]`);
      expect(segment?.dataset.paint, `${badge.dataset.share}: the badge is its segment's colour`).toBe(
        badge.dataset.paint,
      );
    }
  });

  it('says what no bucket accounts for as plain words, and puts the gate after the shares it marks', () => {
    const view = render(<PlanTrack row={row({ stuck: [], inProgress: [], gated: [6, 8], waiting: 2 })} />);
    const legend = view.getByTestId('plan-legend');
    expect(shares(legend).map(([share, words]) => [share, words])).toEqual([
      ['done', '4 done'],
      ['ready', '1 next up'],
      ['waiting', '2 waiting'],
      ['gated', '2 gated'],
    ]);
    expect(within(legend).getByTestId('plan-rest')).toHaveTextContent('3 left');
  });

  it('draws the percentage as a badge at the bar’s end, quiet once the plan is closed', () => {
    const open = render(<PlanTrack row={row()} />);
    const percent = open.getByTestId('plan-percent');
    expect(percent).toHaveAttribute('data-chrome', 'badge');
    expect(percent).toHaveTextContent('40 %');
    expect(percent).not.toHaveAttribute('data-quiet');
    open.unmount();
    const closed = render(
      <PlanTrack row={row({ isClosed: true, done: 2, phases: 6, percent: 33, readyPhases: [3] })} />,
    );
    expect(closed.getByTestId('plan-percent')).toHaveAttribute('data-quiet');
    expect(shares(closed.getByTestId('plan-legend')).map(([share, words]) => [share, words])).toEqual([
      ['done', '2 done'],
      ['never', '4 never ran'],
    ]);
  });

  it('is one picture named by its counts, and no badge in it is a tab stop', async () => {
    const view = render(<PlanTrack row={row({ qaFailures: [3] })} />);
    const picture = view.getByRole('img', {
      name: 'Alpha plan, 10 phases: 3 done, 1 held by QA, 1 in progress, 1 stuck, 1 next up, 3 waiting, 40 %',
    });
    const marks = picture.querySelectorAll<HTMLElement>('[data-status]');
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) expect(mark.tabIndex).toBe(-1);
    await expectNoAxeViolations(view.container);
  });

  it('says an unread board in words — the shared reading, never a badge at 0 %', () => {
    const view = render(<PlanTrack row={row({ progress: 'unknown', done: 0, percent: 0 })} />);
    expect(view.getByTestId('plan-legend')).toHaveTextContent(/progress unknown/);
    expect(view.queryByTestId('plan-percent')).toBeNull();
    expect(view.container.querySelector('[data-share]')).toBeNull();
  });
});

describe('the bar is a pipeline: one cell per phase', () => {
  it('draws every phase as a cell of its share’s segment, the cells summing to the phases', () => {
    const view = render(<PlanTrack row={row()} />);
    const bar = view.container.querySelector<HTMLElement>('[data-bar]')!;
    expect(bar.dataset.pipeline).toBe('phases');
    const segments = [...bar.querySelectorAll<HTMLElement>('[data-segment]')];
    expect(segments.map((s) => [s.dataset.segment, s.querySelectorAll('[data-cell]').length])).toEqual([
      ['done', 4],
      ['in-progress', 1],
      ['stuck', 1],
      ['ready', 1],
      ['waiting', 3],
    ]);
    expect(bar.querySelectorAll('[data-cell]')).toHaveLength(10);
  });

  it('past the most a row can tell apart, draws each share as one stretch', () => {
    const big = PIPELINE_MAX + 2;
    const view = render(
      <PlanTrack
        row={row({
          phases: big,
          done: big - 2,
          readyPhases: [big - 1],
          waiting: 1,
          inProgress: [],
          stuck: [],
        })}
      />,
    );
    const bar = view.container.querySelector<HTMLElement>('[data-bar]')!;
    expect(bar.dataset.pipeline).toBe('shares');
    expect(bar.querySelectorAll('[data-cell]')).toHaveLength(0);
    const counts = [...bar.querySelectorAll<HTMLElement>('[data-segment]')].map((s) =>
      Number(s.dataset.count),
    );
    expect(counts.reduce((a, b) => a + b, 0)).toBe(big);
  });

  it('given the phases in their own order, draws each as its own cell where it stands, a gate hatched over it', () => {
    const order: PipelineStop[] = [
      { phase: 1, share: 'done', title: 'Lay the floor' },
      { phase: 2, share: 'done' },
      { phase: 3, share: 'in-progress', title: 'Wire it' },
      { phase: 4, share: 'ready', gated: true },
      { phase: 5, share: 'waiting' },
    ];
    const view = render(
      <PlanTrack
        row={row({
          phases: 5,
          done: 2,
          percent: 40,
          inProgress: [3],
          readyPhases: [4],
          stuck: [],
          waiting: 1,
          gated: [4],
        })}
        order={order}
      />,
    );
    const bar = view.container.querySelector<HTMLElement>('[data-bar]')!;
    expect(bar.dataset.pipeline).toBe('ordered');
    const cells = [...bar.querySelectorAll<HTMLElement>('[data-cell]')];
    expect(cells.map((c) => [c.dataset.phase, c.dataset.share, c.dataset.paint])).toEqual([
      ['1', 'done', 'done'],
      ['2', 'done', 'done'],
      ['3', 'in-progress', 'running'],
      ['4', 'ready', 'queued'],
      ['5', 'waiting', 'waiting'],
    ]);
    expect(cells[0]).toHaveAttribute('title', 'P1 Done: Lay the floor');
    expect(cells[2]).toHaveAttribute('title', 'P3 In progress: Wire it');
    expect(cells[3]!.querySelector('[data-gated]')).not.toBeNull();
    expect(cells[4]!.querySelector('[data-gated]')).toBeNull();
    // The legend still counts the row, and the picture's name says it.
    expect(
      view.getByRole('img', {
        name: /^Alpha plan, 5 phases: 2 done, 1 in progress, 1 next up, 1 waiting, 1 gated, 40 %$/,
      }),
    ).toBeInTheDocument();
  });

  it('ignores an order that does not cover every phase, rather than draw half a plan', () => {
    const view = render(<PlanTrack row={row()} order={[{ phase: 1, share: 'done' }]} />);
    expect(view.container.querySelector<HTMLElement>('[data-bar]')!.dataset.pipeline).toBe('phases');
  });
});
