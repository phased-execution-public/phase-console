/**
 * The map's tools (one-pool phase 16, #376): every tool lives in the address
 * and survives a reload, a trace lights exactly the right phases, a click
 * inspects and a second click opens, the hover card says what the page knows,
 * and export writes an SVG and a PNG of the view on show.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanDetail, RouteView } from '@/data/api';
import { __resetInspectorForTests, useInspected } from '@/shell/panel/inspector-host';
import { foldDoneWaves, laneRoute, positions, transposed, waveHeading } from './dag';
import { exportName, svgDataUrl, svgMarkup } from './export';
import { hoverLines } from './hover-card';
import { MapView, hoverFactsOf, stationFactsOf } from './map-view';
import {
  DEFAULT_TOOLS,
  NO_FIGURE_PAINT,
  chipsOf,
  colorScale,
  mapToolsOf,
  mapToolsSearch,
  passes,
  toggledLayer,
  traceOf,
  traceWords,
} from './tools';

const { touch } = vi.hoisted(() => ({ touch: vi.fn(() => false) }));
vi.mock('@/lib/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media')>();
  return { ...actual, useTouch: () => touch() };
});

/*   1 ─┬─ 2 ── 4 ── 6
 *      └─ 3 ── 5          */
const ROUTE: RouteView = {
  nodes: [
    { phase: 1, layer: 0, row: 0, state: 'done', size: 'S', gated: false, title: 'Foundations' },
    { phase: 2, layer: 1, row: 0, state: 'done', size: 'M', gated: false, title: 'Shell' },
    { phase: 3, layer: 1, row: 1, state: 'ready', size: 'L', gated: true, title: 'Terminal' },
    { phase: 4, layer: 2, row: 0, state: 'in-progress', size: 'M', gated: false, title: 'Cutover' },
    { phase: 5, layer: 2, row: 1, state: 'waiting', size: 'S', gated: false, title: 'Docs' },
    { phase: 6, layer: 3, row: 0, state: 'waiting', size: 'L', gated: false, title: 'Release' },
  ],
  edges: [
    { from: 1, to: 2 },
    { from: 1, to: 3 },
    { from: 2, to: 4 },
    { from: 3, to: 5 },
    { from: 4, to: 6 },
  ],
  layers: 4,
  rows: 2,
};

const REPOS: Record<number, string> = {
  1: 'phased-execution',
  2: 'phased-execution',
  3: 'phase-console-site',
  4: 'phased-execution, docs',
  5: 'phase-console-site',
  6: 'phased-execution',
};

const DETAIL = {
  summary: { slug: 'demo', budget: 200_000 },
  phases: ROUTE.nodes.map((node) => ({
    phase: node.phase,
    title: node.title,
    state: node.state,
    size: node.size,
    gated: node.gated,
    row: { repos: REPOS[node.phase] },
    analysis: { onCriticalPath: [1, 2, 4, 6].includes(node.phase) },
    ...(node.phase === 4
      ? { lock: { owner: 'autopilot/1a2b3c4d', expired: false, leaseUntil: Date.now() + 3_600_000 } }
      : {}),
  })),
  route: ROUTE,
  batches: null,
  cost: {
    phases: [
      { phase: 1, usd: 2, attempts: 1, partial: false, durationMs: 600_000, runs: 1 },
      { phase: 2, usd: 8, attempts: 2, partial: false, durationMs: 3_600_000, runs: 1 },
      { phase: 4, usd: 1.5, attempts: 1, partial: false, durationMs: 120_000, runs: 1 },
    ],
  },
  eta: {
    plan: null,
    perPhase: [{ phase: 6, weight: 1, estMs: 5_400_000, basis: 'measured', clock: 'working', label: '' }],
  },
} as unknown as PlanDetail;

const station = (container: HTMLElement, phase: number) =>
  container.querySelector<SVGGElement>(`.route-station[data-phase="${phase}"]`)!;
/** A station's button — what a pointer or a press reaches, over the drawing. */
const target = (container: HTMLElement, phase: number) =>
  container.querySelector<HTMLButtonElement>(`.route-station-button[data-phase="${phase}"]`)!;
const dimmedPhases = (container: HTMLElement) =>
  [...container.querySelectorAll('.route-station.dim')].map((el) => Number(el.getAttribute('data-phase')));

/** The address the last tool press wrote, as a query object. */
function queryOfHash(): Record<string, string> {
  const search = window.location.hash.split('?')[1] ?? '';
  return Object.fromEntries(new URLSearchParams(search));
}

afterEach(() => {
  window.location.hash = '';
  __resetInspectorForTests();
});

describe('the address grammar', () => {
  it('says nothing for the defaults, and reads back what it wrote', () => {
    expect(mapToolsSearch(DEFAULT_TOOLS)).toBe('');
    const tools = mapToolsOf({
      status: 'waiting,gated',
      repo: 'docs',
      size: 'L,S',
      color: 'cost',
      layer: 'short,batches,waves',
      layout: 'repo',
      sel: '4',
    });
    expect(tools.status).toEqual(['gated', 'waiting']);
    expect(tools.size).toEqual(['L', 'S']);
    expect([...tools.layers].sort()).toEqual(['batches', 'short', 'waves']);
    const search = mapToolsSearch(tools);
    expect(search).toBe(
      'status=gated,waiting&repo=docs&size=L,S&color=cost&layer=short,batches,waves&layout=repo&sel=4',
    );
    expect(mapToolsOf(Object.fromEntries(new URLSearchParams(search)))).toEqual(tools);
  });

  it('ignores a word it does not know, and keeps one name layer', () => {
    const tools = mapToolsOf({ color: 'mauve', layout: 'spiral', layer: 'names,short,bogus', sel: 'x' });
    expect(tools.color).toBe('state');
    expect(tools.layout).toBe('lr');
    expect([...tools.layers]).toEqual(['names']);
    expect(tools.sel).toBeNull();
    expect(mapToolsOf({ layer: 'none' }).layers.size).toBe(0);
    expect(mapToolsSearch({ ...DEFAULT_TOOLS, layers: new Set() })).toBe('layer=none');
    expect([...toggledLayer(new Set(['names']), 'short')]).toEqual(['short']);
  });
});

describe('filters, trace and colour', () => {
  const stations = stationFactsOf(DETAIL);

  it('counts each chip from the plan', () => {
    const chips = chipsOf(stations);
    const count = (facet: string, value: string) =>
      chips.find((c) => c.facet === facet && c.value === value)?.count;
    expect(count('status', 'done')).toBe(2);
    expect(count('status', 'waiting')).toBe(2);
    expect(count('status', 'gated')).toBe(1);
    expect(count('status', 'critical')).toBe(4);
    expect(count('repo', 'phased-execution')).toBe(4);
    expect(count('repo', 'docs')).toBe(1);
    expect(count('size', 'L')).toBe(2);
  });

  it('passes a station only through every facet that is set', () => {
    const p4 = stations.find((s) => s.phase === 4)!;
    expect(passes(p4, { status: [], repo: [], size: [] })).toBe(true);
    expect(passes(p4, { status: ['critical'], repo: ['docs'], size: [] })).toBe(true);
    expect(passes(p4, { status: ['critical'], repo: ['docs'], size: ['S'] })).toBe(false);
  });

  it('traces the whole chain both ways, not only the neighbours', () => {
    const trace = traceOf(ROUTE.edges, 2);
    expect([...trace.up]).toEqual([1]);
    expect([...trace.down].sort()).toEqual([4, 6]);
    expect(traceWords(traceOf(ROUTE.edges, 1))).toBe('waits on 0 · unblocks 5');
  });

  it('paints by a measure in a ramp, and says what has no figure', () => {
    const scale = colorScale('cost', stations);
    expect(scale.paintOf(stations.find((s) => s.phase === 3)!)).toBe(NO_FIGURE_PAINT);
    expect(scale.paintOf(stations.find((s) => s.phase === 2)!)).toMatch(/100%/);
    expect(scale.key.at(-1)?.label).toBe('Nothing spent');
    const repo = colorScale('repo', stations);
    expect(repo.key.map((k) => k.label)).toEqual(['phase-console-site', 'phased-execution']);
    // Never a literal colour: every paint is a theme token.
    for (const key of [...scale.key, ...repo.key]) expect(key.paint).toMatch(/var\(--/);
    expect(colorScale('state', stations).key).toEqual([]);
  });
});

describe('the layouts', () => {
  it('folds the leading done waves into one column', () => {
    const { route, fold } = foldDoneWaves(ROUTE);
    // Wave 2 holds a phase still ready, so only wave 1 folds.
    expect(fold).toEqual({ waves: 1, phases: 1 });
    expect(route.layers).toBe(4);
    expect(route.nodes.map((n) => [n.phase, n.layer])).toEqual([
      [2, 1],
      [3, 1],
      [4, 2],
      [5, 2],
      [6, 3],
    ]);
    expect(route.edges.some((edge) => edge.from === 1)).toBe(false);
    expect(waveHeading(0, fold)).toBe('Wave 1 done');
    expect(waveHeading(1, fold)).toBe('Wave 2');
    expect(waveHeading(0, { waves: 3, phases: 7 })).toBe('Waves 1–3 done');
  });

  it('puts each phase in its first repository’s lane', () => {
    const { route, lanes } = laneRoute(ROUTE, (phase) => REPOS[phase]?.split(',')[0]);
    expect(lanes.map((lane) => [lane.repo, lane.row0, lane.rows])).toEqual([
      ['phase-console-site', 0, 1],
      ['phased-execution', 1, 1],
    ]);
    const rowOf = new Map(route.nodes.map((n) => [n.phase, n.row]));
    expect(rowOf.get(3)).toBe(0);
    expect(rowOf.get(4)).toBe(1);
  });

  it('turns the map so a wave is a row', () => {
    const turned = transposed(positions(ROUTE), ROUTE.layers);
    const p1 = turned.points.get(1)!;
    const p6 = turned.points.get(6)!;
    expect(p6.y).toBeGreaterThan(p1.y);
    expect(turned.points.get(2)!.y).toBe(turned.points.get(3)!.y);
  });
});

describe('MapView — the tools in the address', () => {
  beforeEach(() => touch.mockReturnValue(false));

  it('writes every tool to the address, and a reload draws the same picture', () => {
    // The page hands the map its address on every hash change; so does this.
    const view = render(<MapView detail={DETAIL} run={null} query={{ view: 'map' }} />);
    const press = (act: () => void) => {
      act();
      view.rerender(<MapView detail={DETAIL} run={null} query={queryOfHash()} />);
    };
    press(() => fireEvent.click(screen.getByRole('button', { name: 'Waiting, 2' })));
    expect(window.location.hash).toBe('#/plan/demo/phases?view=map&status=waiting');
    press(() => fireEvent.change(screen.getByLabelText('Colour by'), { target: { value: 'repo' } }));
    press(() => fireEvent.change(screen.getByLabelText('Layout'), { target: { value: 'tb' } }));
    press(() => fireEvent.click(screen.getByRole('button', { name: 'Batches' })));
    view.unmount();

    // The reload: nothing but the address.
    const query = queryOfHash();
    expect(query).toEqual({
      view: 'map',
      status: 'waiting',
      color: 'repo',
      layer: 'names,critical,waves,done',
      layout: 'tb',
    });
    const { container } = render(<MapView detail={DETAIL} run={null} query={query} />);
    expect(screen.getByRole('button', { name: 'Waiting, 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Colour by')).toHaveValue('repo');
    expect(screen.getByLabelText('Layout')).toHaveValue('tb');
    expect(screen.getByRole('button', { name: 'Batches' })).toHaveAttribute('aria-pressed', 'false');
    // The filter dims what it leaves out; it removes nothing.
    expect(container.querySelectorAll('.route-station')).toHaveLength(6);
    expect(dimmedPhases(container).sort()).toEqual([1, 2, 3, 4]);
    // The colour is a token on the station, the key says what it means.
    expect(station(container, 3).getAttribute('style')).toContain('--state');
    expect(within(screen.getByTestId('map-color-key')).getByText('phase-console-site')).toBeInTheDocument();
    // Clear puts every tool back but the selection.
    fireEvent.click(screen.getByRole('button', { name: 'Clear the tools' }));
    expect(window.location.hash).toBe('#/plan/demo/phases?view=map');
  });

  it('traces the selected station: its chain lit, the rest dimmed, the counts said', () => {
    const { container } = render(<MapView detail={DETAIL} run={null} query={{ view: 'map', sel: '2' }} />);
    expect(dimmedPhases(container).sort()).toEqual([3, 5]);
    expect(screen.getByTestId('map-trace')).toHaveTextContent('Tracing P2waits on 1 · unblocks 2');
    expect(station(container, 2).classList.contains('selected')).toBe(true);
  });

  it('a click inspects in the panel and selects; a second click opens the phase', () => {
    function Probe() {
      const record = useInspected();
      return <span data-testid="inspected">{record?.key ?? ''}</span>;
    }
    const view = render(
      <>
        <MapView detail={DETAIL} run={null} />
        <Probe />
      </>,
    );
    fireEvent.click(target(view.container, 4));
    expect(screen.getByTestId('inspected').textContent).toContain('4');
    expect(queryOfHash().sel).toBe('4');
    expect(window.location.hash).not.toContain('/phase/4');
    view.rerender(
      <>
        <MapView detail={DETAIL} run={null} query={queryOfHash()} />
        <Probe />
      </>,
    );
    fireEvent.click(target(view.container, 4));
    expect(window.location.hash).toBe('#/plan/demo/phase/4');
  });

  it('the hover card says what the page knows, and offers the doors', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<MapView detail={DETAIL} run={null} />);
      fireEvent.mouseEnter(target(container, 4));
      const card = screen.getByTestId('map-hover-card');
      expect(within(card).getByText('Phase 4: Cutover')).toBeInTheDocument();
      expect(card).toHaveTextContent(/In progress · size M · \$1\.50 so far/);
      expect(card).toHaveTextContent(/Claimed by autopilot\/1a2b3c4d, lease/);
      expect(card).toHaveTextContent('waits on 2 · unblocks 1');
      expect(within(card).getByRole('link', { name: 'Open phase' })).toHaveAttribute(
        'href',
        '#/plan/demo/phase/4',
      );
      // In place of the native tooltip, not beside it.
      expect(target(container, 4).hasAttribute('title')).toBe(false);
      expect(station(container, 4).querySelector('title')).toBeNull();
      fireEvent.click(within(card).getByRole('button', { name: 'Trace' }));
      expect(queryOfHash().sel).toBe('4');
      fireEvent.mouseLeave(target(container, 4));
      act(() => vi.advanceTimersByTime(400));
      expect(screen.queryByTestId('map-hover-card')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a phone keeps its fact strip, with Inspect beside Open', () => {
    touch.mockReturnValue(true);
    const { container } = render(<MapView detail={DETAIL} run={null} />);
    fireEvent.mouseEnter(target(container, 4));
    expect(screen.queryByTestId('map-hover-card')).toBeNull();
    fireEvent.click(target(container, 4));
    const strip = screen.getByRole('group', { name: 'Phase 4 facts' });
    expect(within(strip).getByRole('button', { name: 'Inspect' })).toBeInTheDocument();
  });

  it('folds the done waves when the layer is off', () => {
    const { container } = render(
      <MapView detail={DETAIL} run={null} query={{ view: 'map', layer: 'names,batches,critical,waves' }} />,
    );
    expect(container.querySelectorAll('.route-station')).toHaveLength(5);
    expect(screen.getByText('Wave 1 done')).toBeInTheDocument();
  });
});

describe('the hover card’s words', () => {
  it('reads the estimate, the cost and the trace in one place', () => {
    const facts = hoverFactsOf(DETAIL, null, 6)!;
    expect(facts.estimate).toBe('1h 30m');
    expect(hoverLines(facts)).toContain('waits on 3 · unblocks 0');
    expect(hoverFactsOf(DETAIL, null, 99)).toBeNull();
  });
});

describe('export', () => {
  it('writes the view as a standalone SVG, painted inline', () => {
    const { container } = render(<MapView detail={DETAIL} run={null} />);
    const svg = container.querySelector<SVGSVGElement>('svg.route-svg')!;
    const markup = svgMarkup(
      svg,
      () => ({ getPropertyValue: (prop: string) => (prop === 'fill' ? 'red' : '') }) as never,
    );
    expect(markup.startsWith('<?xml')).toBe(true);
    expect(markup).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(markup).toContain(`viewBox="${svg.getAttribute('viewBox')}"`);
    expect(markup).toContain('fill:red');
    expect(markup).not.toContain('route-station-hit');
    // The picture, never the buttons over it: nothing in the file to focus or press.
    expect(markup).not.toMatch(/<button|route-station-button|tabindex|role="/);
    expect((markup.match(/class="route-station /g) ?? []).length).toBe(6);
    expect(svgDataUrl(markup).startsWith('data:image/svg+xml')).toBe(true);
    expect(exportName('one pool/x', 'png')).toBe('one-pool-x-map.png');
  });

  it('the Export buttons save an SVG and a PNG of the current view', async () => {
    const saved: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push(this.download);
    });
    const create = vi.fn(() => 'blob:map');
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    // jsdom draws no image and has no canvas: stand both in.
    const image = vi.spyOn(window, 'Image').mockImplementation(function (this: HTMLImageElement) {
      const img = document.createElement('img');
      queueMicrotask(() => img.onload?.(new Event('load')));
      return img;
    } as never);
    const ctx = { fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: '' };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA');
    try {
      render(<MapView detail={DETAIL} run={null} />);
      fireEvent.click(screen.getByRole('button', { name: 'Export the view as SVG' }));
      fireEvent.click(screen.getByRole('button', { name: 'Export the view as PNG' }));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(saved).toEqual(['demo-map.svg', 'demo-map.png']);
      expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    } finally {
      click.mockRestore();
      image.mockRestore();
    }
  });
});
