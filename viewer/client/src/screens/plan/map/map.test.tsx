/**
 * The route map at seventy stations and more, and the Phases view's `map`
 * reading that draws it (`map-view.tsx`).
 *
 * `dag.test.tsx` holds the map's maths and what a station says; this file
 * holds what changes at plan scale, against the plan the phase was measured
 * on — `test/fixtures/route-map/plan-71.json`, a real 71-phase dependency shape
 * (30 waves, 13 rows, 165 edges) with neutral titles:
 *
 *   - **the signature grammar holds** — a 7 px station dot at the zoom floor,
 *     verifying told from running by a dashed line of its own, and the summons
 *     ring on a station stopped on a person;
 *   - **windowed drawing** — the DOM holds what the frame shows, and the same
 *     frame over a plan four times as long holds exactly as much;
 *   - **a minimap** under a crowded plan, bounded however long the plan grows;
 *   - **fit-to-width** — every row across the frame, never below the floor;
 *   - **a station search** that moves the window to what it finds;
 *   - and **the keyboard reaches every station** from one tab stop.
 *
 * jsdom lays nothing out, so a frame is given its size here (`measure`) and the
 * CSS promises are read as source, the way `dag.test.tsx` reads them. What only
 * a browser can answer — the page scrolling past the map, a pinch — is
 * `e2e/route-map.spec.ts`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAP_CONSTANTS,
  RouteMap,
  crowded,
  drawWindow,
  findStations,
  fitScale,
  neighbour,
  openingScale,
  positions,
  rowsScale,
  type PhaseDriver,
} from './dag';
import { MapView, focusPhase, verifyingPhases } from './map-view';
import { expectNoAxeViolations } from '@/test/axe';
import { setPrefs } from '@/lib/prefs';
import type { PlanDetail, RouteView } from '@/data/api';

const { touch } = vi.hoisted(() => ({ touch: vi.fn(() => false) }));
vi.mock('@/lib/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media')>();
  return { ...actual, useTouch: () => touch() };
});

const { R, MIN_K, MAX_K, FIT_MAX_K, COL_W, FIND_K, FIND_FROM } = MAP_CONSTANTS;
const HERE = dirname(fileURLToPath(import.meta.url));

interface Fixture {
  route: RouteView;
  verifying: number[];
  critical: number[];
}
const PLAN: Fixture = JSON.parse(
  readFileSync(
    join(HERE, '..', '..', '..', '..', '..', 'test', 'fixtures', 'route-map', 'plan-71.json'),
    'utf8',
  ),
) as Fixture;
const ROUTE = PLAN.route;

/** The same plan four times over, end to end: four times the stations, the same breadth. */
function chained(route: RouteView, copies: number): RouteView {
  const n = route.nodes.length;
  const last = route.nodes.reduce((a, b) => (b.layer > a.layer ? b : a));
  const first = route.nodes.reduce((a, b) =>
    b.layer < a.layer || (b.layer === a.layer && b.phase < a.phase) ? b : a,
  );
  return {
    nodes: Array.from({ length: copies }, (_, c) =>
      route.nodes.map((node) => ({
        ...node,
        phase: node.phase + c * n,
        // The same title, so each copy draws exactly as the first does.
        layer: node.layer + c * route.layers,
      })),
    ).flat(),
    edges: [
      ...Array.from({ length: copies }, (_, c) =>
        route.edges.map((edge) => ({ from: edge.from + c * n, to: edge.to + c * n })),
      ).flat(),
      ...Array.from({ length: copies - 1 }, (_, c) => ({
        from: last.phase + c * n,
        to: first.phase + (c + 1) * n,
      })),
    ],
    layers: route.layers * copies,
    rows: route.rows,
  };
}
const LONG = chained(ROUTE, 4);

const { width: CONTENT_W, height: CONTENT_H } = positions(ROUTE);
/** The plan page's frame at 1280 (the card inside the shell), and a phone's at 360. */
const DESK = { w: 1150, h: 640 };
const PHONE = { w: 330, h: 414 };

/** Give every `.route-frame` a size — jsdom measures nothing. */
let unmeasure: (() => void) | null = null;
function measure(frame: { w: number; h: number }) {
  const sized = (value: number) =>
    function (this: HTMLElement) {
      return this.classList?.contains('route-frame') ? value : 0;
    };
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: sized(frame.w) });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: sized(frame.h) });
  unmeasure = () => {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
  };
}

beforeEach(() => {
  touch.mockReturnValue(false);
  setPrefs({ mapPanZoom: false });
});
afterEach(() => {
  unmeasure?.();
  unmeasure = null;
});

const readout = () => screen.getByText(/^\d+%$/).textContent;
const viewBox = (container: HTMLElement) =>
  container.querySelector('svg.route-svg')!.getAttribute('viewBox')!.split(' ').map(Number) as [
    number,
    number,
    number,
    number,
  ];
const drawnPhases = (container: HTMLElement) =>
  [...container.querySelectorAll('.route-svg .route-station')].map((el) =>
    Number(el.getAttribute('data-phase')),
  );
const station = (container: HTMLElement, phase: number) =>
  container.querySelector<SVGGElement>(`.route-svg .route-station[data-phase="${phase}"]`);
/** A station's button — the target over the drawing, which holds the tab stop. */
const button = (container: HTMLElement, phase: number) =>
  container.querySelector<HTMLButtonElement>(`.route-station-button[data-phase="${phase}"]`);
const stateOf = (state: string) => ROUTE.nodes.find((node) => node.state === state)!.phase;

const CSS = readFileSync(join(HERE, 'route-map.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');

describe('the fixture is the plan the phase was measured on', () => {
  it('has 71 stations in 30 waves and 13 rows, every board state, and a phase to verify', () => {
    expect(ROUTE.nodes).toHaveLength(71);
    expect(ROUTE.layers).toBe(30);
    expect(ROUTE.rows).toBe(13);
    expect(new Set(ROUTE.nodes.map((node) => node.state))).toEqual(
      new Set(['done', 'in-progress', 'ready', 'waiting', 'stuck']),
    );
    expect(PLAN.verifying).toHaveLength(1);
  });
});

describe('the signature grammar holds', () => {
  it('draws a station dot 7 px across the radius at the zoom floor', () => {
    // R in plan units, times the floor. The dot the floor was derived around.
    expect(Math.round(R * MIN_K)).toBe(7);
    measure(PHONE);
    const { container } = render(<RouteMap route={ROUTE} />);
    // A phone opens this plan AT the floor, so every dot drawn is that dot.
    expect(readout()).toBe(`${Math.round(MIN_K * 100)}%`);
    const dots = [...container.querySelectorAll('.route-svg .route-station .dot')];
    expect(dots.length).toBeGreaterThan(0);
    for (const dot of dots) expect(Number(dot.getAttribute('r'))).toBe(R);
  });

  it('tells verifying from running by a dashed ring of its own, and a glyph of its own', () => {
    const verifying = PLAN.verifying[0]!;
    const running = ROUTE.nodes.find(
      (node) => node.state === 'in-progress' && node.phase !== verifying,
    )!.phase;
    const drivers = new Map<number, PhaseDriver>([[verifying, { verifying: true }]]);
    const { container } = render(<RouteMap route={ROUTE} drivers={drivers} />);
    const checked = station(container, verifying)!;
    expect(checked.classList.contains('state-verifying')).toBe(true);
    expect(button(container, verifying)!.getAttribute('aria-label')).toMatch(/, Verifying$/);
    expect(checked.querySelector('.state-ring')).not.toBeNull();
    const glyph = (el: Element) =>
      [...el.querySelectorAll('.mark-chip .mark-glyph')]
        .map((g) => g.getAttribute('d') ?? g.tagName)
        .join('|');
    expect(glyph(checked)).not.toBe(glyph(station(container, running)!));
    // The line is the tell, and it is not running's.
    const dash = (state: string) =>
      CSS.match(
        new RegExp(`\\.route-mark\\.state-${state} \\.state-ring \\{[^}]*stroke-dasharray:\\s*([\\d. ]+)`),
      )?.[1];
    expect(dash('verifying')).toBeTruthy();
    expect(dash('running')).toBeTruthy();
    expect(dash('verifying')).not.toBe(dash('running'));
    // Only a live run may breathe.
    expect(CSS).not.toMatch(/state-verifying[^{]*\{[^}]*animation/);
  });

  it('keeps the summons ring for a person, and draws a stuck station as the quiet wait the model reads', () => {
    // Control-tower phase 31: a station is the status model's view. `stuck` is a
    // handoff the console resumes by itself — the waiting paint, its own alert
    // glyph, no ring — and amber stays a summons, never a board word's.
    const { container } = render(<RouteMap route={ROUTE} />);
    const stuck = station(container, stateOf('stuck'))!;
    expect(stuck.classList.contains('state-waiting')).toBe(true);
    expect(stuck.querySelector('.state-ring')).toBeNull();
    // The needs-you ring itself: solid, heavier, never dashed.
    const rule = CSS.match(/\.route-mark\.state-needs-you \.state-ring \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/stroke-width:\s*2\.6/);
    expect(rule).not.toMatch(/dasharray/);
  });

  it('learns verifying from the run — a record still checking, never one that ended', () => {
    const set = verifyingPhases({
      phases: {
        '3': { phase: 3, status: 'verifying' },
        '4': { phase: 4, status: 'verifying', endedAt: '2026-09-30T00:00:00Z' },
        '5': { phase: 5, status: 'running' },
      },
    } as never);
    expect([...set]).toEqual([3]);
  });
});

describe('windowed drawing: the DOM is the size of the frame, not of the plan', () => {
  it('draws what the frame shows, plus a margin — not the plan', () => {
    measure(DESK);
    const { container } = render(<RouteMap route={ROUTE} focus={1} />);
    const drawn = drawnPhases(container);
    expect(drawn.length).toBeGreaterThan(10);
    expect(drawn.length).toBeLessThan(ROUTE.nodes.length);
    // Every station drawn stands inside the window's margin.
    const [x, y, w, h] = viewBox(container);
    const win = drawWindow({ k: DESK.w / w, x, y }, { w, h });
    const { points } = positions(ROUTE);
    for (const phase of drawn) {
      const point = points.get(phase)!;
      expect(point.x).toBeGreaterThanOrEqual(win.x0);
      expect(point.x).toBeLessThanOrEqual(win.x1);
    }
  });

  it('holds exactly as much for a plan four times as long, in the same frame', () => {
    measure(DESK);
    const short = render(<RouteMap route={ROUTE} focus={1} />);
    const shortStations = drawnPhases(short.container).length;
    const shortNodes = short.container.querySelectorAll('.route-svg *').length;
    const shortMinimap = short.container.querySelectorAll('.route-minimap *').length;
    short.unmount();

    const long = render(<RouteMap route={LONG} focus={1} />);
    expect(LONG.nodes).toHaveLength(284);
    expect(drawnPhases(long.container)).toHaveLength(shortStations);
    // The whole drawing, not just its stations: track, rulings and all.
    expect(long.container.querySelectorAll('.route-svg *').length).toBe(shortNodes);
    expect(long.container.querySelectorAll('.route-minimap *').length).toBe(shortMinimap);
  });

  it('draws everything while the frame is unmeasured — a first paint is never blank', () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    expect(drawnPhases(container)).toHaveLength(71);
  });
});

describe('names at a size a person can read (#375)', () => {
  const labelled = (container: HTMLElement) =>
    [...container.querySelectorAll('.route-station')]
      .filter((station) => station.querySelector('.route-station-label'))
      .map((station) => Number(station.getAttribute('data-phase')));

  it('draws numbers below a legible size, a name where it is asked for, and every name once it reads', () => {
    measure(DESK);
    const { container } = render(<RouteMap route={ROUTE} />);
    // The rows' fit: a name would be under 9 px on screen, so none is drawn.
    const opened = Number(screen.getByText(/^\d+%$/).textContent!.replace('%', '')) / 100;
    expect(opened * MAP_CONSTANTS.MAP_TYPE).toBeLessThan(MAP_CONSTANTS.LEGIBLE_PX);
    expect(labelled(container)).toEqual([]);
    expect(container.querySelectorAll('.route-station-number').length).toBeGreaterThan(0);
    // A pointer on a station asks for its name and its neighbours'.
    const first = container.querySelector('.route-station-button')!;
    fireEvent.mouseEnter(first);
    expect(labelled(container)).toContain(Number(first.getAttribute('data-phase')));
    fireEvent.mouseLeave(first);
    // Closer in, every drawn station is named.
    for (let i = 0; i < 6; i++) fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(labelled(container).length).toBe(drawnPhases(container).length);
  });
});

describe('a minimap under a crowded plan', () => {
  it('draws the whole plan small — one track, one path per state — and the window on it', () => {
    measure(DESK);
    const { container } = render(<RouteMap route={ROUTE} focus={1} />);
    const minimap = container.querySelector('svg.route-minimap')!;
    expect(minimap).not.toBeNull();
    expect(minimap.getAttribute('aria-hidden')).toBe('true');
    expect(minimap.querySelectorAll('.minimap-track')).toHaveLength(1);
    const states = [...minimap.querySelectorAll('.minimap-dots')].map((path) =>
      [...path.classList].find((name) => name.startsWith('state-')),
    );
    // One path per PAINT: `stuck` shares the waiting paint (the status model).
    expect(new Set(states)).toEqual(
      new Set(['state-done', 'state-running', 'state-queued', 'state-waiting']),
    );
    const view = minimap.querySelector('.minimap-view')!;
    expect(Number(view.getAttribute('width'))).toBeLessThan(CONTENT_W);
    expect(Number(view.getAttribute('x'))).toBe(0);
    // The same fact, in words.
    expect(screen.getByText(/^Waves 1–\d+ of 30$/)).toBeInTheDocument();
  });

  it('moves the window where it is pressed', () => {
    measure(DESK);
    const { container } = render(<RouteMap route={ROUTE} focus={1} />);
    const minimap = container.querySelector<SVGSVGElement>('svg.route-minimap')!;
    vi.spyOn(minimap, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 200,
      bottom: 56,
      width: 200,
      height: 56,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const before = viewBox(container)[0];
    fireEvent.pointerDown(minimap, { pointerId: 1, clientX: 196, clientY: 28, button: 0 });
    const after = viewBox(container)[0];
    expect(after).toBeGreaterThan(before + CONTENT_W / 2);
    expect(screen.getByText(/^Waves \d+–30 of 30$/)).toBeInTheDocument();
  });

  it('stays away from a plan that fits whole at a tappable zoom', () => {
    measure(DESK);
    const small: RouteView = { ...ROUTE, nodes: ROUTE.nodes.slice(0, 1), edges: [], layers: 1, rows: 1 };
    const { container } = render(<RouteMap route={small} />);
    expect(container.querySelector('.route-minimap')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fit rows' })).toBeNull();
  });
});

describe('fit-to-width: every row across the frame', () => {
  it('fits the rows, never below the floor and never ballooning', () => {
    const content = { w: CONTENT_W, h: CONTENT_H };
    expect(rowsScale(DESK, content)).toBeCloseTo(DESK.h / CONTENT_H, 5);
    expect(rowsScale(PHONE, content)).toBe(MIN_K);
    expect(rowsScale(DESK, { w: 200, h: 100 })).toBe(FIT_MAX_K);
  });

  it('opens a crowded plan at fit-to-width, and any other plan whole', () => {
    const content = { w: CONTENT_W, h: CONTENT_H };
    expect(crowded(DESK, content)).toBe(true);
    expect(openingScale(DESK, content)).toBe(rowsScale(DESK, content));
    expect(crowded({ w: 0, h: 0 }, content)).toBe(false);
    const fits = { w: 600, h: 300 };
    expect(crowded(DESK, fits)).toBe(false);
    expect(openingScale(DESK, fits)).toBe(fitScale(DESK, fits));
  });

  it('opens with every row in the frame, then Fit shows the plan and Fit rows brings the rows back', () => {
    measure(DESK);
    const { container } = render(<RouteMap route={ROUTE} focus={1} />);
    const rows = Math.round(rowsScale(DESK, { w: CONTENT_W, h: CONTENT_H }) * 100);
    expect(readout()).toBe(`${rows}%`);
    const [, , w, h] = viewBox(container);
    expect(h).toBeCloseTo(CONTENT_H, 0);
    expect(w).toBeLessThan(CONTENT_W);

    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(readout()).toBe(`${Math.round(fitScale(DESK, { w: CONTENT_W, h: CONTENT_H }) * 100)}%`);
    expect(drawnPhases(container)).toHaveLength(71);

    fireEvent.click(screen.getByRole('button', { name: 'Fit rows' }));
    expect(readout()).toBe(`${rows}%`);
  });
});

describe('a station search that moves the viewport', () => {
  it('finds by number first, then by name, in plan order', () => {
    expect(findStations(ROUTE.nodes, '38')).toEqual([38]);
    expect(findStations(ROUTE.nodes, 'p38')).toEqual([38]);
    expect(findStations(ROUTE.nodes, 'phase 38')).toEqual([38]);
    expect(findStations(ROUTE.nodes, '#7')).toEqual([7]);
    // A title that starts with a p is a title, not a number.
    expect(findStations(ROUTE.nodes, 'pricing')).toEqual([71]);
    expect(findStations(ROUTE.nodes, 'PAGE')).toEqual([23, 24, 71]);
    expect(findStations(ROUTE.nodes, '   ')).toEqual([]);
  });

  it('moves the window to the station it finds, at a zoom its name reads at, and rings it', () => {
    measure(DESK);
    const { container } = render(<RouteMap route={ROUTE} focus={1} />);
    const far = ROUTE.nodes.find((node) => node.title === 'Release day')!.phase;
    expect(drawnPhases(container)).not.toContain(far);
    const search = screen.getByRole('searchbox', { name: 'Find a station' });
    fireEvent.change(search, { target: { value: 'Release day' } });
    expect(screen.getByText('1 match, press Enter')).toBeInTheDocument();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(screen.getByText('1 of 1')).toBeInTheDocument();

    const found = station(container, far)!;
    expect(found).not.toBeNull();
    expect(found.classList.contains('selected')).toBe(true);
    expect(Number(readout()!.replace('%', ''))).toBeGreaterThanOrEqual(FIND_K * 100);
    // The window is centred on it, or as near as the paper allows.
    const [x, , w] = viewBox(container);
    const point = positions(ROUTE).points.get(far)!;
    expect(point.x).toBeGreaterThan(x);
    expect(point.x).toBeLessThan(x + w);
    // And it holds the tab stop now: the keyboard carries on from the answer.
    expect(button(container, far)!.getAttribute('tabindex')).toBe('0');
  });

  it('walks the matches with Enter and back with Shift+Enter, and Escape lets go', () => {
    measure(DESK);
    const { container } = render(<RouteMap route={ROUTE} focus={1} />);
    const search = screen.getByRole('searchbox', { name: 'Find a station' });
    fireEvent.change(search, { target: { value: 'page' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(station(container, 23)?.classList.contains('selected')).toBe(true);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(station(container, 24)?.classList.contains('selected')).toBe(true);
    fireEvent.keyDown(search, { key: 'Enter', shiftKey: true });
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect((search as HTMLInputElement).value).toBe('');
  });

  it('is offered from twenty stations, not to a plan read at a glance', () => {
    const short: RouteView = { ...ROUTE, nodes: ROUTE.nodes.slice(0, FIND_FROM - 1) };
    render(<RouteMap route={short} />);
    expect(screen.queryByRole('searchbox', { name: 'Find a station' })).toBeNull();
  });
});

describe('the keyboard reaches every station', () => {
  it('walks all 71 from the first with the arrow keys alone', () => {
    const { points } = positions(ROUTE);
    const seen = new Set<number>([1]);
    const queue = [1];
    while (queue.length) {
      const from = queue.shift()!;
      for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
        const next = neighbour(points, from, key);
        if (next != null && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect(seen.size).toBe(71);
    expect(neighbour(points, 30, 'Home')).toBe(1);
    expect(neighbour(points, 30, 'End')).toBe(71);
    expect(neighbour(points, 30, 'Tab')).toBeNull();
  });

  it('crosses to the next wave at the nearest station, and stays in its wave going down', () => {
    const { points } = positions(ROUTE);
    const here = points.get(1)!;
    const right = points.get(neighbour(points, 1, 'ArrowRight')!)!;
    expect(right.layer).toBe(here.layer + 1);
    const down = neighbour(points, right.phase, 'ArrowDown');
    if (down != null) {
      expect(points.get(down)!.layer).toBe(right.layer);
      expect(points.get(down)!.y).toBeGreaterThan(right.y);
    }
  });

  it('is one tab stop, and the arrow keys carry it', () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    const stops = [...container.querySelectorAll('.route-station-button[tabindex="0"]')];
    expect(stops).toHaveLength(1);
    const first = stops[0] as HTMLButtonElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    const moved = document.activeElement!;
    expect(moved).not.toBe(first);
    expect(moved.tagName).toBe('BUTTON');
    expect(moved.classList.contains('route-station-button')).toBe(true);
    expect(moved.getAttribute('tabindex')).toBe('0');
    expect(first.getAttribute('tabindex')).toBe('-1');
  });

  // Each ArrowRight re-lays the whole 71-station window, synchronously, so the
  // walk's wall time is the machine's load times the number of presses (#316:
  // 20 s timed out at load 90). It walks to the FIRST wave the frame left
  // behind — the press that has to move the window — rather than to the end of
  // the line, and the limit is the walk's own, not vitest's shared 20 s.
  it('draws and brings into the window a station the frame had left behind', { timeout: 90_000 }, () => {
    measure(DESK);
    const { container } = render(<RouteMap route={ROUTE} focus={1} />);
    const drawn = new Set(drawnPhases(container));
    const waveOf = (layer: number) =>
      ROUTE.nodes.filter((node) => node.layer === layer).map((node) => node.phase);
    let target = 1;
    while (target < ROUTE.layers && waveOf(target).some((phase) => drawn.has(phase))) target++;
    expect(target, 'the frame draws every wave, so nothing is left behind to bring in').toBeLessThan(
      ROUTE.layers,
    );
    const lastWave = waveOf(target);
    for (const phase of lastWave) expect(drawn).not.toContain(phase);
    // Right, wave after wave, to the first wave the frame had left behind.
    for (let wave = 0; wave < target; wave++) {
      fireEvent.keyDown(
        document.activeElement?.classList.contains('route-station-button')
          ? document.activeElement
          : container.querySelector<HTMLButtonElement>('.route-station-button[tabindex="0"]')!,
        { key: 'ArrowRight' },
      );
    }
    const at = Number(document.activeElement!.getAttribute('data-phase'));
    expect(lastWave).toContain(at);
    const [x, , w] = viewBox(container);
    const point = positions(ROUTE).points.get(at)!;
    expect(point.x).toBeGreaterThan(x);
    expect(point.x).toBeLessThan(x + w);
    // A keyboard walk never zooms: only the window moved.
    expect(w).toBeCloseTo(DESK.w / rowsScale(DESK, { w: CONTENT_W, h: CONTENT_H }), 0);
  });
});

describe('at scale, still accessible', () => {
  it('has no axe violations with the search, the minimap and a verifying station on the page', () => {
    measure(DESK);
    const drivers = new Map<number, PhaseDriver>([[PLAN.verifying[0]!, { verifying: true }]]);
    const { container } = render(
      <RouteMap route={ROUTE} focus={1} drivers={drivers} critical={new Set(PLAN.critical)} />,
    );
    expect(container.querySelector('.route-minimap')).not.toBeNull();
    return expectNoAxeViolations(container);
  });

  it('keeps the zoom bounds the toolbar promises', () => {
    expect(MIN_K).toBe(0.45);
    expect(MAX_K).toBeGreaterThan(FIND_K);
    expect(COL_W).toBeGreaterThan(0);
  });
});

describe('MapView — the Phases view’s map reading', () => {
  const critical = new Set(PLAN.critical);
  /** The tour plan's detail as the page holds it: the fixture's route, its phases beside it. */
  const DETAIL = {
    summary: { slug: 'demo', budget: 200_000 },
    phases: ROUTE.nodes.map((node) => ({
      phase: node.phase,
      title: node.title,
      state: node.state,
      analysis: { onCriticalPath: critical.has(node.phase) },
      // A lane observed working phase 58, and the claim it holds.
      ...(node.phase === 58
        ? {
            live: { via: 'run', actor: 'autopilot' },
            lock: { owner: 'autopilot/1a2b3c4d', expired: false },
          }
        : {}),
    })),
    route: ROUTE,
    batches: null,
  } as unknown as PlanDetail;
  const RUN = { phases: { '62': { phase: 62, status: 'verifying' } } } as never;

  afterEach(() => {
    window.location.hash = '';
  });

  it('opens on the station the plan is asking about: a blocked handoff, then what moves, then what could', () => {
    expect(focusPhase(DETAIL)).toBe(stateOf('stuck'));
    const quiet = (states: Record<number, string>) =>
      ({ phases: ROUTE.nodes.map((n) => ({ phase: n.phase, state: states[n.phase] ?? 'done' })) }) as never;
    expect(focusPhase(quiet({ 5: 'ready', 9: 'in-progress' }))).toBe(9);
    expect(focusPhase(quiet({ 5: 'ready' }))).toBe(5);
    // Nothing wants anything: the map does not snap anywhere.
    expect(focusPhase(quiet({}))).toBeNull();
  });

  it('draws the plan’s route with what the route does not carry: the ring, the trunk, the driver and the check', () => {
    const { container } = render(<MapView detail={DETAIL} run={RUN} />);
    expect(drawnPhases(container)).toHaveLength(ROUTE.nodes.length);
    // Where it opened keeps a ring, and holds the map's one tab stop.
    const opened = station(container, stateOf('stuck'))!;
    expect(opened.classList.contains('selected')).toBe(true);
    expect(button(container, stateOf('stuck'))!.getAttribute('tabindex')).toBe('0');
    // The critical path, joined from each phase's analysis: an edge is on the
    // trunk when both of its ends are.
    const trunk = ROUTE.edges.filter((edge) => critical.has(edge.from) && critical.has(edge.to));
    expect(trunk.length).toBeGreaterThan(0);
    expect(container.querySelectorAll('path.route-track.route-track-critical')).toHaveLength(trunk.length);
    // Who is driving, from the phase's live fact — the one station that may breathe.
    expect(station(container, 58)!.querySelector('.actor-chip')).not.toBeNull();
    expect(
      [...container.querySelectorAll('.route-station.live')].map((el) => el.getAttribute('data-phase')),
    ).toEqual(['58']);
    // What the run is verifying, which the board has no word for.
    expect(station(container, 62)!.classList.contains('state-verifying')).toBe(true);
  });

  it('opens a phase at its own address, by the keyboard and by a link', () => {
    const desk = render(<MapView detail={DETAIL} run={null} />);
    fireEvent.keyDown(button(desk.container, 7)!, { key: 'Enter' });
    expect(window.location.hash).toBe('#/plan/demo/phase/7');
    desk.unmount();
    // A finger's first tap asks; the strip's Open phase is a real link.
    touch.mockReturnValue(true);
    const phone = render(<MapView detail={DETAIL} run={null} />);
    fireEvent.click(button(phone.container, 9)!);
    expect(screen.getByRole('link', { name: 'Open phase' })).toHaveAttribute('href', '#/plan/demo/phase/9');
  });
});
