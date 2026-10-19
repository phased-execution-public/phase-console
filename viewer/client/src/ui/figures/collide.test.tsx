/**
 * No figure draws text over text (#375).
 *
 * The owner measured it on 7.1.0: a batch's caption written over its wave's
 * heading, track run through station names, and four marks on one spot of the
 * run timeline that read as one. This guard lays out two real plans — the
 * turn-by-turn plan (18 phases, 15 waves) and the control-tower plan (150
 * phases, 51 waves, 13 rows) — and their real runs (172 and 1,517 marks), and
 * measures what the drawings write:
 *
 *   - every box comes from the numbers the drawing hands its `<text>` — its x,
 *     its baseline, its anchor, its dx, a tspan's dy — through `textBox`, the
 *     figures' own ruler, which errs wide;
 *   - on the map, no two text boxes meet, and no track segment meets a name, a
 *     caption or a heading (the casing's width, the widest stroke there is);
 *   - on the run timeline and on the swimlane at four widths, no two text
 *     boxes meet, and every moment is still on the drawing — inside a mark's
 *     count when it shares a spot.
 *
 * Both plans are closed, so they carry no batches: every wave is made one here,
 * with a weight against a budget and every third gated — the longest caption
 * the map writes, and a head in every column's top row, which is exactly where
 * the caption met the heading. The fixtures are the console's own answers
 * (`GET /api/plans/<slug>`, `GET /api/run/<slug>/timeline`), trimmed to what
 * the drawings read, the marks' labels emptied.
 */

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { BatchGroup, RouteView, RunTimeline, SessionPlanView } from '@/data/api';
import { RouteMap } from '@/screens/plan/map/dag';
import { RunGantt } from '@/screens/plan/run/gantt';

import { meets, segmentBox, textBox, type Rect, type TextAnchor } from './collide';
import { FIGURE_TYPE, textWidth } from './paint';
import { Swimlane, type SwimlaneRow } from './swimlane';
import controlTower from './fixtures/control-tower.json';
import turnByTurn from './fixtures/turn-by-turn.json';

const { width } = vi.hoisted(() => ({ width: { current: 1000 } }));
vi.mock('./paint', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./paint')>();
  return { ...actual, useWidth: () => width.current };
});
vi.mock('@/lib/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media')>();
  return { ...actual, useTouch: () => false, useNarrow: () => false };
});

interface Fixture {
  plan: string;
  route: RouteView;
  timeline: RunTimeline;
}
const FIXTURES = [turnByTurn, controlTower] as unknown as Fixture[];

/** The map's type and the figures' are one size, `--text-meta`. */
const TYPE = FIGURE_TYPE;
/** A batch caption's words are set this much further apart than their spaces (`TRAIN_GAP`). */
const TRAIN_GAP = 4;
/** The widest stroke on the map: the critical path's casing, 9 wide. */
const CASING_HALF = 4.5;

/** One drawn line of text, as a box, with what it says — for a failure message a person can read. */
interface Drawn {
  what: string;
  box: Rect;
}

const num = (el: Element, name: string, fallback = 0): number => {
  const value = Number(el.getAttribute(name));
  return Number.isFinite(value) && el.hasAttribute(name) ? value : fallback;
};
const anchorOf = (el: Element): TextAnchor =>
  (el.getAttribute('text-anchor') as TextAnchor | null) ?? 'start';
/** The text an element writes itself — never the `<title>` a hover reads. */
const ownText = (el: Element): string =>
  [...el.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE || (node as Element).tagName === 'tspan')
    .map((node) => node.textContent ?? '')
    .join('');

/** Every line of text the map writes, as boxes. */
function mapTexts(svg: SVGSVGElement): Drawn[] {
  const out: Drawn[] = [];
  for (const el of svg.querySelectorAll('text')) {
    const cls = el.getAttribute('class') ?? '';
    const x = num(el, 'x');
    const y = num(el, 'y');
    const anchor = anchorOf(el);
    if (cls.includes('route-station-label')) {
      // One line per tspan, each `dy` under the one before.
      let baseline = y;
      for (const span of el.querySelectorAll('tspan')) {
        baseline += num(span, 'dy');
        const text = span.textContent ?? '';
        out.push({
          what: `name "${text}"`,
          box: textBox({ x: num(span, 'x', x), y: baseline, text, anchor, size: TYPE }),
        });
      }
    } else if (cls.includes('band-label')) {
      const text = ownText(el);
      const box = textBox({ x, y, text, anchor, size: TYPE });
      const slack = TRAIN_GAP * el.querySelectorAll('tspan[dx]').length;
      out.push({
        what: `caption "${text}"`,
        box: { ...box, x0: box.x0 - slack / 2, x1: box.x1 + slack / 2 },
      });
    } else {
      const text = ownText(el);
      out.push({
        what: `${cls.split(' ')[0] || 'text'} "${text}"`,
        box: textBox({ x, y, text, anchor, size: TYPE }),
      });
    }
  }
  return out;
}

/** A track's path as its straight legs — a corner through its control point, which bounds the curve. */
function legs(d: string): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  const tokens = d.match(/[MLQ][^MLQ]*/g) ?? [];
  let at: [number, number] = [0, 0];
  for (const token of tokens) {
    const values = token
      .slice(1)
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (token[0] === 'M') at = [values[0]!, values[1]!];
    else if (token[0] === 'L') {
      out.push([at[0], at[1], values[0]!, values[1]!]);
      at = [values[0]!, values[1]!];
    } else {
      out.push([at[0], at[1], values[0]!, values[1]!]);
      out.push([values[0]!, values[1]!, values[2]!, values[3]!]);
      at = [values[2]!, values[3]!];
    }
  }
  return out;
}

/** Every pair of boxes that meet, named — empty is the pass. */
function overlaps(texts: readonly Drawn[]): string[] {
  const found: string[] = [];
  const sorted = [...texts].sort((a, b) => a.box.x0 - b.box.x0);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j]!.box.x0 < sorted[i]!.box.x1; j++) {
      if (meets(sorted[i]!.box, sorted[j]!.box)) found.push(`${sorted[i]!.what} × ${sorted[j]!.what}`);
    }
  }
  return found;
}

/** Every wave a batch: a head in each column's top row, the longest caption the map writes. */
function wavesAsBatches(route: RouteView): SessionPlanView {
  const byLayer = new Map<number, number[]>();
  for (const node of [...route.nodes].sort((a, b) => a.row - b.row)) {
    byLayer.set(node.layer, [...(byLayer.get(node.layer) ?? []), node.phase]);
  }
  const groups: BatchGroup[] = [...byLayer.entries()]
    .sort(([a], [b]) => a - b)
    .map(([layer, phases]) => ({
      index: layer + 1,
      kind: 'batch',
      weight: '190K',
      phases,
      gated: layer % 3 === 0,
    }));
  return { groups, raw: '' };
}

describe('the map writes no text over text, and runs no track through a word (#375)', () => {
  for (const fixture of FIXTURES) {
    describe(`${fixture.plan} (${fixture.route.nodes.length} phases, ${fixture.route.layers} waves)`, () => {
      const draw = () => {
        const { container } = render(
          <RouteMap route={fixture.route} batches={wavesAsBatches(fixture.route)} budget={200_000} />,
        );
        return container.querySelector<SVGSVGElement>('svg.route-svg')!;
      };

      it('draws every station, name, heading and caption it is measured on', () => {
        const svg = draw();
        // Unmeasured, the window is the whole plan: everything is drawn.
        expect(svg.querySelectorAll('.route-station')).toHaveLength(fixture.route.nodes.length);
        expect(svg.querySelectorAll('.route-station-label')).toHaveLength(fixture.route.nodes.length);
        expect(svg.querySelectorAll('.platform-label')).toHaveLength(fixture.route.layers);
        expect(svg.querySelectorAll('.band-label')).toHaveLength(fixture.route.layers);
      });

      it('no two text boxes meet — headings, captions, names and numbers', () => {
        expect(overlaps(mapTexts(draw()))).toEqual([]);
      });

      it('no track runs through a name, a caption or a heading', () => {
        const svg = draw();
        const words = mapTexts(svg).filter((text) => !text.what.startsWith('route-station-number'));
        const crossed: string[] = [];
        for (const path of svg.querySelectorAll('path.route-track')) {
          for (const [ax, ay, bx, by] of legs(path.getAttribute('d') ?? '')) {
            const stroke = segmentBox(ax, ay, bx, by, CASING_HALF);
            for (const word of words) {
              if (meets(stroke, word.box))
                crossed.push(`track ${path.getAttribute('d')?.slice(0, 24)}… × ${word.what}`);
            }
          }
        }
        expect(crossed).toEqual([]);
      });
    });
  }
});

/**
 * The map's other layouts and layers (one-pool phase 16, #376) are held to the
 * same two rules: top to bottom, one lane per repository (every third phase in
 * a second repository, every fifth in none), and the done waves folded.
 */
describe('the map’s layouts write no text over text and run no track through a word (#376)', () => {
  const repoOf = (phase: number) =>
    phase % 5 === 0 ? undefined : phase % 3 === 0 ? 'phase-console-site' : 'phased-execution';
  const VARIANTS: { name: string; props: Partial<Parameters<typeof RouteMap>[0]> }[] = [
    { name: 'top to bottom', props: { layout: 'tb' } },
    { name: 'one lane per repository', props: { layout: 'repo', repoOf } },
    { name: 'done waves folded', props: { layers: new Set(['names', 'batches', 'critical', 'waves']) } },
    { name: 'short names', props: { layers: new Set(['short', 'batches', 'critical', 'waves', 'done']) } },
  ];
  for (const fixture of FIXTURES) {
    for (const variant of VARIANTS) {
      it(`${fixture.plan}, ${variant.name}`, () => {
        // Half the plan done, so the fold has waves to fold.
        const half = Math.floor(fixture.route.layers / 2);
        const route = {
          ...fixture.route,
          nodes: fixture.route.nodes.map((node) => ({
            ...node,
            state: node.layer < half ? 'done' : node.state,
          })),
        };
        const { container } = render(
          <RouteMap route={route} batches={wavesAsBatches(route)} budget={200_000} {...variant.props} />,
        );
        const svg = container.querySelector<SVGSVGElement>('svg.route-svg')!;
        expect(overlaps(mapTexts(svg))).toEqual([]);
        const words = mapTexts(svg).filter((text) => !text.what.startsWith('route-station-number'));
        const crossed: string[] = [];
        for (const path of svg.querySelectorAll('path.route-track')) {
          for (const [ax, ay, bx, by] of legs(path.getAttribute('d') ?? '')) {
            const stroke = segmentBox(ax, ay, bx, by, CASING_HALF);
            for (const word of words) {
              if (meets(stroke, word.box))
                crossed.push(`track ${path.getAttribute('d')?.slice(0, 24)}… × ${word.what}`);
            }
          }
        }
        expect(crossed).toEqual([]);
      });
    }
  }
});

/** Every line of text a swimlane's drawing writes, as boxes: a mark's glyph an em wide, as it is drawn. */
function laneTexts(svg: SVGSVGElement): Drawn[] {
  return [...svg.querySelectorAll('text')].map((el) => {
    const text = ownText(el);
    const tick = el.hasAttribute('data-tick');
    const anchor = anchorOf(el);
    const x = num(el, 'x') + num(el, 'dx');
    const y = num(el, 'y');
    if (tick) return { what: `tick "${text}"`, box: textBox({ x, y, text, anchor }) };
    // A glyph is an em wide, whatever the estimator says of a letter.
    const glyph = [...text][0] ?? '';
    const wide = FIGURE_TYPE + textWidth(text.slice(glyph.length));
    const x0 = anchor === 'middle' ? x - wide / 2 : anchor === 'end' ? x - wide : x;
    const box = textBox({ x: x0, y, text: '', anchor: 'start' });
    return { what: `mark "${text}" at ${Math.round(x)}`, box: { ...box, x1: x0 + wide } };
  });
}

/** How many moments the drawn marks stand for: one each, or a cluster's count. */
const momentsDrawn = (svg: SVGSVGElement): number =>
  [...svg.querySelectorAll('text:not([data-tick])')].reduce(
    (sum, el) => sum + Number(el.getAttribute('data-mark-count') ?? 1),
    0,
  );

describe('the run timeline writes no mark over a mark (#375)', () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.plan}: ${fixture.timeline.marks.length} marks over ${fixture.timeline.lanes.length} lanes, none covering another`, () => {
      width.current = 1000;
      const { container } = render(<RunGantt timeline={fixture.timeline} />);
      const svg = container.querySelector<SVGSVGElement>('[data-testid="run-gantt"] svg')!;
      expect(overlaps(laneTexts(svg))).toEqual([]);
      // Nothing is dropped to make room: a shared spot is a count.
      expect(momentsDrawn(svg)).toBe(fixture.timeline.marks.length);
    });
  }
});

describe('the swimlane clusters what would collide, at every width (#375)', () => {
  for (const fixture of FIXTURES) {
    const rows: SwimlaneRow[] = fixture.timeline.lanes.map((lane) => ({
      key: String(lane.phase),
      label: `P${lane.phase}`,
      ariaLabel: `phase ${lane.phase}`,
      bars: lane.bars.map((bar, i) => ({
        key: `${i}`,
        startMs: bar.startMs,
        endMs: bar.endMs,
        state: 'state-running',
      })),
      marks: fixture.timeline.marks
        .filter((mark) => mark.phase === lane.phase)
        .map((mark, i) => ({ key: `${i}`, atMs: mark.atMs, glyph: mark.kind === 'note' ? '✎' : '●' })),
    }));
    const axisMarks = fixture.timeline.marks
      .filter((mark) => mark.phase === undefined)
      .map((mark, i) => ({ key: `run-${i}`, atMs: mark.atMs, glyph: '▶' }));
    const total = rows.reduce((sum, row) => sum + (row.marks?.length ?? 0), 0) + axisMarks.length;

    for (const px of [360, 768, 1280, 1568]) {
      it(`${fixture.plan} at ${px} px: no two words or glyphs meet, and every moment is drawn`, () => {
        width.current = px;
        const { container } = render(
          <Swimlane rows={rows} axisMarks={axisMarks} spanMs={fixture.timeline.spanMs} ariaLabel="lanes" />,
        );
        const svg = container.querySelector('svg')!;
        expect(overlaps(laneTexts(svg))).toEqual([]);
        expect(momentsDrawn(svg)).toBe(total);
      });
    }
  }
});
