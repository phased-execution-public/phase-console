/**
 * The route map: its maths, and the three things a station has to say.
 *
 * The layout numbers are the port's whole risk surface — they were derived
 * against a real phone and a real plan, and a rewrite that quietly rounds one
 * of them produces a map that still *looks* fine on a laptop and cannot be
 * tapped on a phone. So the derivation is asserted, not just the value.
 *
 * The rest of the file holds the properties the redesign exists for:
 *
 *   - **the opening view is the whole plan.** `fitScale` is bounded above and
 *     not below (a deep plan must be allowed to draw small), the content box
 *     carries no second allowance for labels, and every automatic move is
 *     clamped to the drawing — an unclamped "look at this station" is what
 *     opened the map on empty paper.
 *   - **no state is told apart by hue.** Five states, five different drawn
 *     glyphs, and the ring treatments that go with them. jsdom computes no
 *     styles, so what is asserted is the MARKUP that CSS paints by: the class
 *     that sets `--state`, and the glyph geometry, which is arithmetic.
 *   - **only a live fact may pulse**, and it is what puts a driver's icon on
 *     the station. A board word out of a markdown file must not breathe.
 *
 * Plus the source guard on `styles/route-map.css`: no hue read outside the
 * `.state-*` → `--state` bridge, no `dvh`, reduced motion declared locally.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAP_CONSTANTS,
  RouteMap,
  centreView,
  clampView,
  fitScale,
  markGeometry,
  platforms,
  positions,
  stationFacts,
  trackPath,
  wrapLabel,
  type PhaseDriver,
} from './dag';
import { expectNoAxeViolations } from '@/test/axe';
import { getPrefs, setPrefs } from '@/lib/prefs';
import type { RouteView, SessionPlanView } from '@/lib/api';

const { touch } = vi.hoisted(() => ({ touch: vi.fn(() => false) }));
vi.mock('@/lib/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media')>();
  return { ...actual, useTouch: () => touch() };
});

const { COL_W, ROW_H, PAD, R, TAP, MIN_K, MAX_K, FIT_MIN_K, FIT_MAX_K, ZOOM_STEP } = MAP_CONSTANTS;

/** A diamond: 1 → {2,3} → 4. Two layers of one, one layer of two. */
const ROUTE: RouteView = {
  nodes: [
    { phase: 1, layer: 0, row: 0, state: 'done', size: 'M', gated: false, title: 'Foundations' },
    { phase: 2, layer: 1, row: 0, state: 'ready', size: 'L', gated: false, title: 'Design system and shell' },
    { phase: 3, layer: 1, row: 1, state: 'waiting', size: 'S', gated: true, title: 'Terminal' },
    { phase: 4, layer: 2, row: 0, state: 'stuck', size: 'M', gated: false, title: 'Cutover' },
  ],
  edges: [
    { from: 1, to: 2 },
    { from: 1, to: 3 },
    { from: 2, to: 4 },
    { from: 3, to: 4 },
  ],
  layers: 3,
  rows: 2,
};

/** The same diamond with phase 2 in flight — the only shape that may pulse. */
const RUNNING: RouteView = {
  ...ROUTE,
  nodes: ROUTE.nodes.map((node) => (node.phase === 2 ? { ...node, state: 'in-progress' } : node)),
};

/**
 * One station in each of the five states a board word can reach.
 *
 * `BOARD_STATE_UI` maps the engine's five buckets onto done, running, queued,
 * waiting and needs-you — so this is every mark the map can draw, on one page.
 */
const FIVE: RouteView = {
  nodes: [
    { phase: 1, layer: 0, row: 0, state: 'done', size: 'M', gated: false, title: 'Foundations' },
    { phase: 2, layer: 1, row: 0, state: 'in-progress', size: 'L', gated: false, title: 'Shell' },
    { phase: 3, layer: 1, row: 1, state: 'ready', size: 'S', gated: false, title: 'Terminal' },
    { phase: 4, layer: 2, row: 0, state: 'waiting', size: 'M', gated: false, title: 'Cutover' },
    { phase: 5, layer: 2, row: 1, state: 'stuck', size: 'M', gated: false, title: 'Release' },
  ],
  edges: [
    { from: 1, to: 2 },
    { from: 1, to: 3 },
    { from: 2, to: 4 },
    { from: 3, to: 5 },
  ],
  layers: 3,
  rows: 2,
};

describe('the zoom floor', () => {
  it('keeps a 44px target from overlapping the row above it', () => {
    // A station's hit circle is TAP CSS px across at any zoom, and rows are
    // ROW_H plan units apart. The targets stop colliding once TAP/k < ROW_H.
    const collisionFloor = TAP / ROW_H;
    expect(collisionFloor).toBeCloseTo(0.407, 3);
    expect(MIN_K).toBeGreaterThan(collisionFloor);
  });

  it('orders the four zoom bounds the way the toolbar assumes', () => {
    expect(FIT_MIN_K).toBeLessThan(MIN_K);
    expect(MIN_K).toBeLessThan(FIT_MAX_K);
    expect(FIT_MAX_K).toBeLessThan(MAX_K);
  });

  it('zooms out by exactly the reciprocal of zooming in, so out-then-in returns', () => {
    // The wheel used to step 0.92/1.08 and the buttons 0.9/1.1 — four numbers,
    // no two of them each other's inverse.
    expect(ZOOM_STEP).toBeGreaterThan(1);
    expect(ZOOM_STEP * (1 / ZOOM_STEP)).toBeCloseTo(1, 10);
  });

  it('caps the hit radius at the row pitch, so a target never covers its neighbour', () => {
    // The component's rule, restated: at any zoom at or below the floor the cap
    // is what is doing the work, and the cap is smaller than the row pitch.
    const hitR = (k: number) => Math.min(TAP / k, ROW_H - 6) / 2;
    expect(hitR(MIN_K) * 2).toBeLessThan(ROW_H);
    expect(hitR(1) * 2).toBe(TAP);
    expect(hitR(2)).toBeLessThan(hitR(1));
  });
});

describe('positions', () => {
  it('puts a layer in a column and a row in a row', () => {
    const { points } = positions(ROUTE);
    expect(points.get(1)).toMatchObject({ x: PAD, y: PAD + 0.5 * ROW_H });
    expect(points.get(2)).toMatchObject({ x: PAD + COL_W, y: PAD });
    expect(points.get(3)).toMatchObject({ x: PAD + COL_W, y: PAD + ROW_H });
    expect(points.get(4)).toMatchObject({ x: PAD + 2 * COL_W, y: PAD + 0.5 * ROW_H });
  });

  it('centres a short layer against the tallest one', () => {
    // Layer 0 holds one node against a tallest layer of two, so it sits half a
    // row down — a single station level with the gap, not with the top row.
    const { points } = positions(ROUTE);
    expect(points.get(1)!.y).toBe(points.get(2)!.y + ROW_H / 2);
  });

  it('leaves room past the last column for half a label, and none below for one', () => {
    const { width, height } = positions(ROUTE);
    expect(width).toBe(PAD * 2 + (ROUTE.layers - 1) * COL_W + 60);
    expect(height).toBe(PAD * 2 + ROW_H);
    // The whole point: the last row sits a full PAD above the bottom edge, and
    // a two-line label drops ~43 into it. A second allowance on top (there was
    // a `LABEL_DROP` of 40) made every fit 15-26% too small.
    const lastRow = PAD + ROW_H;
    expect(height - lastRow).toBe(PAD);
    expect(PAD).toBeGreaterThan(markGeometry(R).label + 12);
  });

  it('does not divide by zero on a one-phase plan', () => {
    const { width, height, points } = positions({
      nodes: [{ phase: 1, layer: 0, row: 0, state: 'ready', size: 'S', gated: false, title: 'Only' }],
      edges: [],
      layers: 1,
      rows: 1,
    });
    expect(points.size).toBe(1);
    expect(width).toBe(PAD * 2 + 60);
    expect(height).toBe(PAD * 2);
  });
});

describe('fitting the plan to the frame', () => {
  it('lets a deep plan draw below the TOUCH floor — a fit is not a zoom you chose', () => {
    // Forty phases across fifteen layers in a laptop card. MIN_K is the floor
    // on the MANUAL zoom (a 44px target must not overlap its neighbour); a fit
    // clamped to it opened two thirds of the plan outside the frame with
    // nothing on screen to say there was more.
    const k = fitScale({ w: 900, h: 520 }, { w: 2800, h: 1300 });
    expect(k).toBeLessThan(MIN_K);
    expect(k).toBeGreaterThanOrEqual(FIT_MIN_K);
    expect(k).toBeCloseTo(900 / 2800, 5);
  });

  it('still refuses to balloon a two-phase plan', () => {
    expect(fitScale({ w: 900, h: 520 }, { w: 200, h: 180 })).toBe(FIT_MAX_K);
  });

  it('never answers zero, whatever it is handed', () => {
    expect(fitScale({ w: 0, h: 0 }, { w: 5000, h: 5000 })).toBe(FIT_MIN_K);
    expect(fitScale({ w: 900, h: 520 }, { w: 0, h: 0 })).toBe(FIT_MAX_K);
  });
});

describe('clamping the window to the drawing', () => {
  it('keeps a pan inside the content box', () => {
    expect(clampView({ k: 1, x: 4000, y: 900 }, { w: 200, h: 200 }, { w: 1000, h: 400 })).toEqual({
      k: 1,
      x: 800,
      y: 200,
    });
    expect(clampView({ k: 1, x: -4000, y: -900 }, { w: 200, h: 200 }, { w: 1000, h: 400 })).toEqual({
      k: 1,
      x: 0,
      y: 0,
    });
  });

  it('centres an axis the window is wider than — there is nothing to pan to', () => {
    const view = clampView({ k: 1, x: 900, y: 0 }, { w: 2000, h: 2000 }, { w: 500, h: 400 });
    expect(view.x).toBe((500 - 2000) / 2);
    expect(view.y).toBe((400 - 2000) / 2);
  });

  it('centres the drawing when no station is named', () => {
    const view = centreView(2, { w: 400, h: 200 }, { w: 1000, h: 600 });
    expect(view).toEqual({ k: 2, x: (1000 - 200) / 2, y: (600 - 100) / 2 });
  });

  it('looks at a corner station without leaving the paper', () => {
    // The defect this replaces: `centreOn` put a corner station in the middle
    // of the frame, which puts most of the frame outside the map.
    const view = centreView(1, { w: 200, h: 200 }, { w: 1000, h: 400 }, { x: 990, y: 390 });
    expect(view.x).toBe(800);
    expect(view.y).toBe(200);
  });

  it('a fit shows the whole plan, so looking at a station moves nothing', () => {
    const content = { w: 1000, h: 400 };
    const frame = { w: 500, h: 300 };
    const k = fitScale(frame, content);
    expect(centreView(k, frame, content, { x: 980, y: 20 })).toEqual(centreView(k, frame, content));
  });
});

describe('markGeometry', () => {
  it('derives every ring and chip from the radius, so the legend is the same mark', () => {
    const geo = markGeometry(R);
    // Outward, in order, and none of them on top of another.
    expect(R).toBeLessThan(geo.ring);
    expect(geo.ring).toBeLessThan(geo.gate);
    expect(geo.gate).toBeLessThan(geo.claim);
    expect(geo.claim).toBeLessThan(geo.halo);
    // A chip on the diagonal clears the dot and stays inside the halo.
    expect(geo.offset).toBeGreaterThan(geo.chip);
    expect(geo.offset * Math.SQRT2 + geo.chip).toBeGreaterThan(R);
    expect(geo.glyph).toBeLessThan(geo.chip);
    // Half scale is half a mark, not a differently-proportioned one.
    const half = markGeometry(R / 2);
    expect(half.chip).toBeCloseTo(geo.chip / 2, 1);
    expect(half.ring).toBeCloseTo(geo.ring / 2, 1);
  });
});

describe('trackPath', () => {
  const at = (x: number, y: number) => ({
    phase: 0,
    layer: 0,
    row: 0,
    state: 'done',
    size: 'M',
    gated: false,
    title: 't',
    x,
    y,
  });

  it('draws a straight line between stations on the same row', () => {
    const d = trackPath(at(100, 50), at(300, 50));
    expect(d).toBe(`M${100 + R + 4},50 L${300 - R - 8},50`);
    expect(d).not.toContain('Q');
  });

  it('turns with two rounded corners when the rows differ', () => {
    const d = trackPath(at(100, 50), at(300, 158));
    expect(d.match(/Q/g)).toHaveLength(2);
    expect(d.startsWith(`M${100 + R + 4},50`)).toBe(true);
    expect(d.endsWith(`,158`)).toBe(true);
  });

  it('curves the same way going up as going down', () => {
    const down = trackPath(at(100, 50), at(300, 158));
    const up = trackPath(at(100, 158), at(300, 50));
    expect(down.match(/Q/g)).toHaveLength(up.match(/Q/g)!.length);
  });
});

describe('wrapLabel', () => {
  it('keeps a short title on one line', () => {
    expect(wrapLabel('Cutover')).toEqual(['Cutover']);
  });

  it('breaks a long title onto a second line', () => {
    // The break happens on the word that would take the line *past* 17, so a
    // line of exactly 17 stays whole.
    expect(wrapLabel('Design system and shell')).toEqual(['Design system and', 'shell']);
    expect('Design system and'.length).toBe(17);
  });

  it('elides rather than running a third line off the map', () => {
    const lines = wrapLabel('Plan surface tabs and the dependency map and phase detail');
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith('…')).toBe(true);
    expect(lines[1].length).toBeLessThanOrEqual(17);
  });
});

describe('what a station says', () => {
  const node = { phase: 4, title: 'Cutover', size: 'M', gated: false };

  it('leads with the phase, then the board word and the size', () => {
    expect(stationFacts(node, 'stuck', undefined)).toEqual(['Phase 4 — Cutover', 'Needs you · size M']);
  });

  it('names what it waits on, and the gate it has to be let through', () => {
    const lines = stationFacts({ ...node, gated: true }, 'waiting', [2, 3]);
    expect(lines).toContain('needs P2 · P3');
    expect(lines.some((line) => line.startsWith('gated'))).toBe(true);
  });

  it('names the DRIVER over an observed live fact, with the claim it holds', () => {
    const driver: PhaseDriver = {
      live: { via: 'run', actor: 'autopilot', session: '1a2b3c4d' },
      lock: { owner: 'autopilot/1a2b3c4d', expired: false, host: 'studio' },
    };
    expect(stationFacts(node, 'in-progress', undefined, driver)).toContain(
      'Autopilot session · held by autopilot/1a2b3c4d on studio',
    );
  });

  it('a claim with nothing running is a claim, and a lapsed one says to release it', () => {
    expect(stationFacts(node, 'ready', undefined, { lock: { owner: 'mobin', expired: false } })).toContain(
      'claimed by mobin',
    );
    const stale = stationFacts(node, 'ready', undefined, { lock: { owner: 'mobin', expired: true } });
    expect(stale.some((line) => line.includes('lapsed claim'))).toBe(true);
  });

  it('says when a phase is on the chain that decides the finish date', () => {
    expect(stationFacts(node, 'ready', undefined, undefined, true)).toContain('on the critical path');
  });
});

describe('<RouteMap>', () => {
  const BATCHES: SessionPlanView = {
    groups: [{ index: 1, kind: 'batch', weight: '130K', phases: [2, 3], gated: false }],
    raw: '',
    budget: '200K/session',
    excluded: [1],
  };

  beforeEach(() => touch.mockReturnValue(false));

  it('draws one focusable station per phase, each naming its state out loud', () => {
    render(<RouteMap route={ROUTE} batches={BATCHES} budget={200_000} />);
    // Named, not just counted — the toolbar's zoom controls are buttons too.
    const stations = screen.getAllByRole('button', { name: /^Phase \d/ });
    expect(stations).toHaveLength(4);
    expect(screen.getByLabelText(/Phase 1: Foundations, Done/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Phase 2: .*, Next up/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Phase 3: Terminal, Waiting/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Phase 4: Cutover, Needs you/)).toBeInTheDocument();
    for (const station of stations) expect(station).toHaveAttribute('tabindex', '0');
  });

  it('is a GROUP of buttons, not an image that happens to contain forty of them', () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    const svg = container.querySelector('svg.route-svg')!;
    expect(svg.getAttribute('role')).toBe('group');
    expect(svg.getAttribute('aria-label')).toMatch(/4 stations/);
    expect(within(svg as unknown as HTMLElement).getAllByRole('button')).toHaveLength(4);
  });

  it('paints each station with its own state class, so no two states look alike', () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    expect(container.querySelector('.station.state-done')).not.toBeNull();
    expect(container.querySelector('.station.state-queued')).not.toBeNull();
    expect(container.querySelector('.station.state-waiting')).not.toBeNull();
    // `stuck` had aliased `blocked` in the old palette; it is its own line now.
    expect(container.querySelector('.station.state-needs-you')).not.toBeNull();
    // …and each of them carries `route-mark`, which is what `--state` and every
    // glyph rule hang off — the legend draws the same class on the same shapes.
    for (const station of container.querySelectorAll('.station')) {
      expect(station.classList.contains('route-mark')).toBe(true);
    }
  });

  it('gives every state a DIFFERENT drawn glyph, so hue is never the only cue', () => {
    const { container } = render(<RouteMap route={FIVE} />);
    const glyphOf = (state: string) =>
      [...container.querySelectorAll(`.station.state-${state} .mark-chip .mark-glyph`)]
        .map((el) => el.getAttribute('d') ?? el.tagName)
        .join('|');

    const drawn = ['done', 'running', 'queued', 'waiting', 'needs-you'].map(glyphOf);
    for (const d of drawn) expect(d).not.toBe('');
    // The property, stated as a property: five states, five distinct marks.
    expect(new Set(drawn).size).toBe(drawn.length);
  });

  it('rings only the two states that are not merely a position in a queue', () => {
    const { container } = render(<RouteMap route={FIVE} />);
    expect(container.querySelector('.station.state-running .state-ring')).not.toBeNull();
    expect(container.querySelector('.station.state-needs-you .state-ring')).not.toBeNull();
    expect(container.querySelector('.station.state-queued .state-ring')).toBeNull();
    expect(container.querySelector('.station.state-done .state-ring')).toBeNull();
  });

  it('hatches a gated station, and chips it so the hatch needs no legend', () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    expect(container.querySelectorAll('.station .gate-ring')).toHaveLength(1);
    expect(container.querySelectorAll('.station .gate-chip')).toHaveLength(1);
  });

  it('threads a train through its stations rather than boxing them', () => {
    const { container } = render(<RouteMap route={ROUTE} batches={BATCHES} budget={200_000} />);
    // One line, one ring per carried station — and no rect around the group.
    expect(container.querySelectorAll('.train-line')).toHaveLength(1);
    expect(container.querySelectorAll('.train-ring')).toHaveLength(2);
    expect(container.querySelector('.train rect')).toBeNull();
    expect(container.querySelector('.band-label')?.textContent).toContain('130K/200K');
  });

  it('draws a track per edge, points it, and marks the ones already departed', () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    const tracks = [...container.querySelectorAll('path.track')];
    expect(tracks).toHaveLength(4);
    // Only the two edges leaving phase 1 (done) are drawn as completed track,
    // and `state-done` is what puts `--state` on them — no second hue name.
    expect(container.querySelectorAll('path.track.track-done.state-done')).toHaveLength(2);
    // Direction is drawn, not implied by reading order.
    expect(container.querySelector('marker#track-arrow')).not.toBeNull();
    for (const track of tracks) {
      // `pathLength` normalises every edge, which is what replaced the
      // hard-coded 1400 dash that drew a short edge as dots.
      expect(track.getAttribute('pathLength')).toBe('100');
    }
  });

  it('caps the draw-in stagger, so a deep plan is not half-drawn for two seconds', () => {
    const deep: RouteView = {
      nodes: Array.from({ length: 15 }, (_, i) => ({
        phase: i + 1,
        layer: i,
        row: 0,
        state: 'waiting',
        size: 'S',
        gated: false,
        title: `P${i + 1}`,
      })),
      edges: Array.from({ length: 14 }, (_, i) => ({ from: i + 1, to: i + 2 })),
      layers: 15,
      rows: 1,
    };
    const { container } = render(<RouteMap route={deep} />);
    const indices = [...container.querySelectorAll('path.track')].map((el) =>
      Number((el as SVGElement).style.getPropertyValue('--i')),
    );
    expect(Math.max(...indices)).toBeLessThanOrEqual(8);
    expect(Math.max(...indices)).toBeGreaterThan(0);
  });

  it('marks the critical path on the edges whose BOTH ends are on it', () => {
    const { container } = render(<RouteMap route={ROUTE} critical={new Set([1, 2, 4])} />);
    // 1→2 and 2→4 qualify; 1→3 and 3→4 do not.
    expect(container.querySelectorAll('path.track.track-critical')).toHaveLength(2);
    expect(container.querySelector('marker#track-arrow-critical')).not.toBeNull();
  });

  it('renders every station under one viewBox rather than scaling the SVG', () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    const svg = container.querySelector('svg.route-svg')!;
    expect(svg.getAttribute('viewBox')).toMatch(/^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/);
    expect(svg.getAttribute('width')).toBe('100%');
  });

  it('has no axe violations with every mark on the page', () => {
    const { container } = render(
      <RouteMap
        route={RUNNING}
        batches={BATCHES}
        budget={200_000}
        critical={new Set([1, 2, 4])}
        selected={4}
        drivers={new Map([[2, { live: { via: 'run', actor: 'autopilot' } }]])}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Key' }));
    return expectNoAxeViolations(container);
  });
});

describe('who is driving', () => {
  beforeEach(() => touch.mockReturnValue(false));

  const drivers = (): Map<number, PhaseDriver> =>
    new Map([
      [
        2,
        {
          live: { via: 'run', actor: 'autopilot', session: '1a2b3c4d' },
          lock: { owner: 'autopilot/1a2b3c4d', expired: false },
        },
      ],
    ]);

  it('puts a driver chip on the live station and nowhere else', () => {
    const { container } = render(<RouteMap route={RUNNING} drivers={drivers()} />);
    expect(container.querySelectorAll('.actor-chip')).toHaveLength(1);
    expect(container.querySelector('.station.state-running .actor-chip')).not.toBeNull();
  });

  it('licenses the pulse with the live fact, never with the board word', () => {
    const { container: withoutFact } = render(<RouteMap route={RUNNING} />);
    // `in-progress` alone is a word out of a markdown file: no `.live`.
    expect(withoutFact.querySelector('.station.state-running')).not.toBeNull();
    expect(withoutFact.querySelector('.station.state-running.live')).toBeNull();

    const { container: withFact } = render(<RouteMap route={RUNNING} drivers={drivers()} />);
    expect(withFact.querySelector('.station.state-running.live')).not.toBeNull();
    // …and nothing else may wear it, however loudly its board word reads.
    expect(withFact.querySelectorAll('.station.live')).toHaveLength(1);
  });

  it('draws a claim as a cordon only where there is no process to draw instead', () => {
    const claimed = new Map<number, PhaseDriver>([[3, { lock: { owner: 'mobin', expired: true } }]]);
    const { container } = render(<RouteMap route={RUNNING} drivers={new Map([...drivers(), ...claimed])} />);
    expect(container.querySelectorAll('.claim-ring')).toHaveLength(1);
    expect(container.querySelector('.station.state-waiting .claim-ring.stale')).not.toBeNull();
    expect(container.querySelector('.station.state-running .claim-ring')).toBeNull();
  });

  it('says the vehicle in words too — the icon is not the whole answer', () => {
    const { container } = render(<RouteMap route={RUNNING} drivers={drivers()} />);
    const station = container.querySelector('.station.state-running')!;
    expect(station.querySelector('title')?.textContent).toContain(
      'Autopilot session · held by autopilot/1a2b3c4d',
    );
  });
});

describe('the legend teaches the map that is drawn', () => {
  beforeEach(() => touch.mockReturnValue(false));

  it('draws the five states as the REAL mark, not as five plain dots', () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    const marks = [...container.querySelectorAll('.legend-mark')];
    expect(marks).toHaveLength(5);
    for (const mark of marks) {
      expect(mark.querySelector('.dot')).not.toBeNull();
      expect(mark.querySelector('.mark-glyph')).not.toBeNull();
    }
    // The same class the stations wear, so the two cannot drift apart.
    for (const mark of marks) expect(mark.classList.contains('route-mark')).toBe(true);
  });

  it('keeps the rest of the key one press away rather than four rows tall', () => {
    render(<RouteMap route={ROUTE} />);
    const key = screen.getByRole('button', { name: 'Key' });
    expect(key).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Autopilot session')).toBeNull();

    fireEvent.click(key);
    // Everything else the map can draw: the gate, both claims, the three
    // vehicles, the critical path and a session batch.
    for (const label of [
      'Gated',
      'Claimed',
      'Lapsed claim',
      'Autopilot session',
      'Console agent',
      'Terminal session',
      'Critical path',
      'Session batch',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});

describe('a finger has no hover', () => {
  beforeEach(() => {
    setPrefs({ mapPanZoom: false });
    touch.mockReturnValue(true);
  });

  it('answers the first tap with the facts and the second with the phase', () => {
    const picked: number[] = [];
    render(<RouteMap route={ROUTE} onSelect={(phase) => picked.push(phase)} />);

    fireEvent.click(screen.getByLabelText(/Phase 4: Cutover/));
    // A native `<title>` never shows on a phone, so the same lines are markup.
    const strip = screen.getByRole('group', { name: 'Phase 4 facts' });
    expect(within(strip).getByText('Phase 4 — Cutover')).toBeInTheDocument();
    expect(within(strip).getByText(/needs P2 · P3/)).toBeInTheDocument();
    expect(picked).toEqual([]);

    fireEvent.click(screen.getByLabelText(/Phase 4: Cutover/));
    expect(picked).toEqual([4]);
  });

  it('offers a real link when the caller knows the phase’s address', () => {
    render(<RouteMap route={ROUTE} hrefFor={(phase) => `#/plan/demo/phase/${phase}`} />);
    fireEvent.click(screen.getByLabelText(/Phase 3: Terminal/));
    expect(screen.getByRole('link', { name: 'Open phase' })).toHaveAttribute('href', '#/plan/demo/phase/3');
  });

  it('closes the strip without opening anything', () => {
    const picked: number[] = [];
    render(<RouteMap route={ROUTE} onSelect={(phase) => picked.push(phase)} />);
    fireEvent.click(screen.getByLabelText(/Phase 1: Foundations/));
    fireEvent.click(screen.getByRole('button', { name: 'Close facts' }));
    expect(screen.queryByRole('group', { name: /facts/ })).toBeNull();
    expect(picked).toEqual([]);
  });

  it('a mouse still opens the phase on the first click', () => {
    touch.mockReturnValue(false);
    const picked: number[] = [];
    render(<RouteMap route={ROUTE} onSelect={(phase) => picked.push(phase)} />);
    fireEvent.click(screen.getByLabelText(/Phase 4: Cutover/));
    expect(picked).toEqual([4]);
  });
});

describe('the pan & zoom lock', () => {
  beforeEach(() => {
    // Prefs persist in jsdom's localStorage across tests in this file; every
    // case below states its own opening position.
    setPrefs({ mapPanZoom: false });
    touch.mockReturnValue(false);
  });

  const frameOf = (container: HTMLElement) => container.querySelector('.route-frame')! as HTMLElement;
  const viewBoxOf = (container: HTMLElement) =>
    container.querySelector('svg.route-svg')!.getAttribute('viewBox');

  it('opens locked: no interactive marker, and the toggle says so', () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    expect(frameOf(container).hasAttribute('data-interactive')).toBe(false);
    const toggle = screen.getByRole('button', { name: 'Pan and zoom' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  it('a locked map ignores the drag — the viewBox does not move', () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    const frame = frameOf(container);
    const before = viewBoxOf(container);
    fireEvent.pointerDown(frame, { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(frame, { pointerId: 1, clientX: 160, clientY: 160 });
    fireEvent.pointerUp(frame, { pointerId: 1 });
    expect(viewBoxOf(container)).toBe(before);
  });

  it('unlocking turns the same drag into a pan, and remembers the choice', () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pan and zoom' }));
    expect(getPrefs().mapPanZoom).toBe(true);
    const frame = frameOf(container);
    expect(frame.hasAttribute('data-interactive')).toBe(true);
    const before = viewBoxOf(container);
    fireEvent.pointerDown(frame, { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(frame, { pointerId: 1, clientX: 160, clientY: 160 });
    fireEvent.pointerUp(frame, { pointerId: 1 });
    expect(viewBoxOf(container)).not.toBe(before);
  });

  it('a pointer that leaves the frame uncaptured ends its drag', () => {
    // `setPointerCapture` throws for a pointer the element is not tracking, and
    // jsdom does not implement it at all. Without this the gesture stayed alive
    // with no `pointerup` coming — the map then panned on every mouse move.
    const { container } = render(<RouteMap route={ROUTE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pan and zoom' }));
    const frame = frameOf(container);
    fireEvent.pointerDown(frame, { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerLeave(frame, { pointerId: 1 });
    const settled = viewBoxOf(container);
    fireEvent.pointerMove(frame, { pointerId: 1, clientX: 400, clientY: 400 });
    expect(viewBoxOf(container)).toBe(settled);
  });

  it('a focus that moves after the operator has panned never yanks the map back', () => {
    const { container, rerender } = render(<RouteMap route={ROUTE} focus={4} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pan and zoom' }));
    const frame = frameOf(container);
    fireEvent.pointerDown(frame, { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(frame, { pointerId: 1, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(frame, { pointerId: 1 });
    const panned = viewBoxOf(container);

    // The run stream ticks and the plan's most urgent phase changes. The map
    // is the operator's now; a re-centre here is the map fighting the hand.
    rerender(<RouteMap route={ROUTE} focus={2} />);
    expect(viewBoxOf(container)).toBe(panned);
    rerender(<RouteMap route={ROUTE} focus={null} />);
    expect(viewBoxOf(container)).toBe(panned);
  });

  it('the toolbar zoom buttons work while locked — locking hides nothing', () => {
    render(<RouteMap route={ROUTE} />);
    const readout = () => screen.getByText(/%$/).textContent;
    const before = readout();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(readout()).not.toBe(before);
  });

  it('stations stay tappable while locked', () => {
    const picked: number[] = [];
    render(<RouteMap route={ROUTE} onSelect={(phase) => picked.push(phase)} />);
    fireEvent.click(screen.getByLabelText(/Phase 4: Cutover/));
    expect(picked).toEqual([4]);
  });

  it('a double-click on the background is Fit', () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    const zoomed = screen.getByText(/%$/).textContent;
    fireEvent.doubleClick(frameOf(container));
    // Unmeasured in jsdom, Fit is a no-op rather than a lie; what matters is
    // that the gesture reaches it and that a station's own double-click does not.
    expect(screen.getByText(/%$/).textContent).toBe(zoomed);
    expect(frameOf(container)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * The stylesheet, as source text — jsdom computes no styles
 * ------------------------------------------------------------------ */

describe('route-map.css keeps its side of the token bargain', () => {
  const CSS = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'route-map.css'),
    'utf8',
  );
  const code = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');

  it('reads no hue outside the `.state-*` → `--state` bridge', () => {
    // `StatusBadge` and theme.css's `.state-<ui>` classes are the only two
    // places a status hue may be named. This file restated `--status-*` and
    // `--line-done` about fifteen times, so a state added to the vocabulary
    // painted everywhere except a map.
    expect(code).not.toMatch(/--status-/);
    // The map's own half of the file. Below it the guide strip paints an ACTOR
    // (`machine` / `person`), which is a different axis and keeps its ink
    // names; `--line-gated` and `--line-progress` stay named here too, because
    // a gate's barrier and a session batch's line are ink, not state.
    const map = code.slice(0, code.indexOf('.guide-strip'));
    expect(map).not.toMatch(/--line-(done|ready|waiting|blocked|stuck)\b/);
    expect(map).toMatch(/\.route-mark\.state-done \.dot \{ fill: var\(--state\)/);
    expect(map).toMatch(/\.track-done \{ stroke: color-mix\(in oklab, var\(--state\)/);
  });

  it('drops the rules no board word can reach', () => {
    // `BOARD_STATE_UI` emits neither, so both were dead paint.
    expect(code).not.toMatch(/state-verifying/);
    expect(code).not.toMatch(/state-failed/);
    // …and the one that named a class the map has never set.
    expect(code).not.toMatch(/\.station\.state-ready\b/);
    expect(code).toMatch(/\.station\.state-queued .station-label/);
  });

  it('sizes by the visible viewport, never by dvh', () => {
    // `dvh` ignores the iOS software keyboard; `--app-height` is the token the
    // shell corrects. The only `dvh` left may be that token's own fallback.
    const bare = code.replace(/var\(--app-height,\s*[^)]*\)/g, 'APP_HEIGHT');
    expect(bare).not.toMatch(/dvh/);
    expect(code).toMatch(/--app-height/);
  });

  it('opts its own animations out of reduced motion, beside the animations', () => {
    expect(code).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(code).toMatch(
      /prefers-reduced-motion[\s\S]*station-pulse|station-pulse[\s\S]*prefers-reduced-motion/,
    );
  });

  it('draws every edge from its own length, not from a guess at the longest', () => {
    expect(code).not.toMatch(/stroke-dasharray:\s*1400/);
    expect(code).toMatch(/stroke-dasharray:\s*100;/);
  });

  it('prints the network on paper, not on a graph-editor dot grid', () => {
    // The bed was a 24px radial dot grid — the node-canvas default, which says
    // nothing about a plan and competed with the network it was under. The
    // platform bands are the structure now, so the frame is flat.
    const frame = code.slice(code.indexOf('.route-frame'), code.indexOf('.route-svg'));
    expect(frame).not.toMatch(/radial-gradient/);
    expect(frame).toMatch(/background:\s*var\(--ground-deep\)/);
  });

  it('rules the board in ground tones — the vocabulary belongs to the marks', () => {
    // `code` has had its comments stripped, so the section is bounded by the
    // next real rule — never by a banner comment, which is not in this string.
    const bands = code.slice(code.indexOf('.platforms'), code.indexOf('.track {'));
    expect(bands.length).toBeGreaterThan(60);
    // The ruling spans the frame. One that took a pointer would take every
    // pointer meant for a station standing on it.
    expect(bands).toMatch(/\.platforms \{ pointer-events: none; \}/);
    // Paper, never a status hue: `--state` here would make a whole column
    // read as one phase's state.
    expect(bands).not.toMatch(/--state\b/);
    expect(bands).not.toMatch(/--status-/);
  });

  it('keeps the map to ONE paper, which is what lets the trunk have a casing', () => {
    // A casing is a wider stroke in the paper's own colour. This shipped with
    // alternating band fills for one round, and a paper that alternates cannot
    // have one: half the trunk drew a light channel down the middle of the
    // network instead of hiding what it covered.
    expect(code).not.toMatch(/\.platform-band/);
    const frame = code.slice(code.indexOf('.route-frame'), code.indexOf('.route-svg'));
    const paper = frame.match(/background:\s*var\((--[a-z-]+)\)/)?.[1];
    expect(paper).toBe('--ground-deep');
    const casing = code.slice(code.indexOf('.track-casing {'));
    expect(casing).toMatch(new RegExp(`stroke:\\s*var\\(${paper}\\)`));
  });

  it('sets the band labels above the type floor, in ink held to the TEXT contrast floor', () => {
    // Both numbers are design law rather than taste, and both were wrong when
    // this shipped: §10.9 makes 12px the floor non-negotiable, and
    // `contrast.test.ts` holds `--ink-faint` only to the 3:1 LARGE-text floor —
    // measured 3.12:1 on the base band, a fail for text this size.
    // `--ink-muted` is held to 4.5:1. The bands stay quiet through their FILL.
    const bands = code.slice(code.indexOf('.platform-label'), code.indexOf('.track {'));
    expect(bands).not.toMatch(/font-size:\s*(?:[0-9]|1[01])px/);
    expect(bands).not.toMatch(/--ink-faint/);
    expect(bands).toMatch(/fill:\s*var\(--ink-muted\)/);
    // Under-inking by opacity is the same failure wearing a different property.
    expect(bands).not.toMatch(/opacity:/);
  });

  it('casings are the paper colour and are silenced by reduced motion', () => {
    const casing = code.slice(code.indexOf('.track-casing {'));
    // Transparent would defeat the whole point: a casing exists to HIDE what
    // it covers, which is how a line reads as passing over a crossing. Which
    // token is the paper is pinned against `.route-frame` in its own test above.
    expect(casing).toMatch(/stroke:\s*var\(--ground-deep\)/);
    // It draws itself in on the same stagger as its own line — a casing that
    // arrived first would flash a blank channel across the map.
    expect(casing).toMatch(/animation:\s*draw-track/);
    expect(code).toMatch(/prefers-reduced-motion[\s\S]*\.track-casing/);
  });
});

/* ------------------------------------------------------------------ *
 * The board, ruled — platforms and the trunk
 * ------------------------------------------------------------------ */

describe('platforms', () => {
  it('tiles the whole drawing: every band ends where the next one starts', () => {
    const { width } = positions(ROUTE);
    const bands = platforms(ROUTE, width);
    expect(bands.map((b) => b.layer)).toEqual([0, 1, 2]);
    // The first runs out to the left margin and the last to the full width —
    // a column of paper with a gap either side reads as a card, and these are
    // meant to read as one board.
    expect(bands[0].left).toBe(0);
    expect(bands[bands.length - 1].right).toBe(width);
    for (let i = 1; i < bands.length; i++) expect(bands[i].left).toBe(bands[i - 1].right);
  });

  it('puts each interior boundary at the midpoint between two columns', () => {
    const bands = platforms(ROUTE, positions(ROUTE).width);
    // Station x is `PAD + layer * COL_W`; the band between layers 0 and 1
    // divides them exactly in half.
    expect(bands[1].left).toBe(PAD + COL_W - COL_W / 2);
    expect(bands[1].right).toBe(PAD + COL_W + COL_W / 2);
  });

  it('counts the stations standing on each platform', () => {
    // The diamond: one, two, one.
    expect(platforms(ROUTE, positions(ROUTE).width).map((b) => b.count)).toEqual([1, 2, 1]);
  });

  it('rules nothing when there is nothing to rule', () => {
    expect(platforms({ nodes: [], edges: [], layers: 0, rows: 0 }, 200)).toEqual([]);
  });
});

describe('the board, ruled', () => {
  beforeEach(() => touch.mockReturnValue(false));

  it('draws one numbered band per wave, under everything and deaf to the pointer', () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    // One hairline per BOUNDARY — three waves have two between them; a rule at
    // the left margin would be a border, not a ruling.
    expect(container.querySelectorAll('.platform-rule')).toHaveLength(ROUTE.layers - 1);
    // The wave a phase sits in decided its x and the map never printed it.
    const labels = [...container.querySelectorAll('.platform-label')].map((el) => el.textContent);
    expect(labels).toEqual(['wave 1', 'wave 2', 'wave 3']);
    expect([...container.querySelectorAll('.platform-count')].map((el) => el.textContent)).toEqual([
      '1',
      '2',
      '1',
    ]);
    // Structure, not a record: forty "wave 3, 5" nodes teach a screen reader
    // nothing, and the legend says it once in words instead.
    expect(container.querySelector('.platforms')).toHaveAttribute('aria-hidden', 'true');
  });

  it('paints the ruling BEFORE the track — SVG has no z-index', () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    const svg = container.querySelector('svg.route-svg')!;
    const all = [...svg.querySelectorAll('.platform-rule, path.track')];
    const lastRule = all.findLastIndex((el) => el.classList.contains('platform-rule'));
    const firstTrack = all.findIndex((el) => el.classList.contains('track'));
    expect(lastRule).toBeGreaterThanOrEqual(0);
    expect(lastRule).toBeLessThan(firstTrack);
  });

  it('rules a single-wave plan with nothing, because it compares it with nothing', () => {
    const one: RouteView = {
      nodes: [{ phase: 1, layer: 0, row: 0, state: 'ready', size: 'S', gated: false, title: 'Only' }],
      edges: [],
      layers: 1,
      rows: 1,
    };
    const { container } = render(<RouteMap route={one} />);
    expect(container.querySelector('.platforms')).toBeNull();
  });
});

describe('the trunk', () => {
  beforeEach(() => touch.mockReturnValue(false));

  it('gives every critical edge a casing, and only those', () => {
    const { container } = render(<RouteMap route={ROUTE} critical={new Set([1, 2, 4])} />);
    // 1→2 and 2→4 qualify; 1→3 and 3→4 do not.
    expect(container.querySelectorAll('path.track-casing')).toHaveLength(2);
    expect(container.querySelectorAll('path.track.track-critical')).toHaveLength(2);
  });

  it('draws no casing on a plan with no critical path', () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    expect(container.querySelectorAll('path.track-casing')).toHaveLength(0);
    expect(container.querySelector('.trunk')).toBeNull();
  });

  it('partitions the edges rather than duplicating them', () => {
    // The whole risk of a second pass: drawing the trunk twice would double
    // the plan's track and light every "one path per edge" reading wrong.
    const { container } = render(<RouteMap route={ROUTE} critical={new Set([1, 2, 4])} />);
    expect(container.querySelectorAll('path.track')).toHaveLength(ROUTE.edges.length);
  });

  it('paints the trunk LAST, so it passes over every line it crosses', () => {
    const { container } = render(<RouteMap route={ROUTE} critical={new Set([1, 2, 4])} />);
    const tracks = [...container.querySelectorAll('path.track')];
    const crit = tracks.map((el) => el.classList.contains('track-critical'));
    // Every ordinary edge comes first. In route order the critical 1→2 is the
    // FIRST edge, so a single pass painted it under 1→3 and it vanished into
    // the junction — which is what this asserts can no longer happen.
    expect(crit).toEqual([false, false, true, true]);
  });

  it('lays each casing under its own line, never over it', () => {
    const { container } = render(<RouteMap route={ROUTE} critical={new Set([1, 2, 4])} />);
    const trunk = [...container.querySelector('.trunk')!.children];
    const lastCasing = trunk.findLastIndex((el) => el.classList.contains('track-casing'));
    const firstLine = trunk.findIndex((el) => el.classList.contains('track-critical'));
    expect(lastCasing).toBeLessThan(firstLine);
  });

  it('dims a casing with the line it belongs to', () => {
    const { container } = render(<RouteMap route={ROUTE} critical={new Set([1, 2, 4])} />);
    // Hovering phase 3 leaves 1→2 and 2→4 outside the neighbourhood, so both
    // the trunk and its casing must fade — a casing left bright would paint a
    // white channel across the dimmed network.
    fireEvent.mouseEnter(screen.getByRole('button', { name: /^Phase 3:/ }));
    expect(container.querySelectorAll('path.track-casing.dim')).toHaveLength(2);
    expect(container.querySelectorAll('path.track.track-critical.dim')).toHaveLength(2);
  });
});
