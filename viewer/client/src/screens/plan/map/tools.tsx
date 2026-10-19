/**
 * The map's tools (one-pool phase 16, #376): what the reader asked the map to
 * show, as an address, and the row of controls that writes it.
 *
 * ```
 * Filter  [In progress 2] [Next up 4] [Stuck 1] [Waiting 9] [Done 12] [Gated 3] [Critical 7]
 *         [phased-execution 20] [docs 8]   [S 4] [M 11] [L 13]
 * Colour by [State ▾]  Layout [Left to right ▾]  Layers [Names] [Short] [Batches] [Critical path] [Waves] [Done waves]
 * Export [SVG] [PNG]                                              Clear the tools
 * ```
 *
 * ---- The address grammar ----
 *
 * Every tool is a query parameter of `#/plan/<slug>/phases?view=map`, so a
 * reload keeps the picture and a shared link opens the same one:
 *
 *   - `status=<word>[,<word>]` — board words (`BOARD_ORDER`), plus `gated` and
 *     `critical`; `repo=<token>[,…]` — Repos tokens; `size=<S|M|L|…>[,…]`.
 *     A station that fails a facet is DIMMED, never removed: the map keeps its
 *     shape, so a filter cannot move a station under the reader.
 *   - `color=state|repo|size|cost|time` — what a station's paint says; `state`
 *     (the default) carries no parameter.
 *   - `layer=<layer>[,…]` — the layers drawn, from `names` (full names) or
 *     `short` (one short line) or neither (numbers only), `batches`,
 *     `critical`, `waves` and `done` (the finished waves, which off fold into
 *     one column). Absent means every default layer; `layer=none` means none.
 *   - `layout=lr|tb|repo` — left to right (the default), top to bottom, or one
 *     lane per repository.
 *   - `sel=<phase>` — the station the trace runs through, and the one the
 *     panel inspects.
 *
 * The zoom and the centre stay out of the address on purpose: every pan would
 * write history, and the map already opens on the station the plan asks about.
 */

import { useMemo } from 'react';
import { BOARD_ORDER } from '@shared/phase-model.js';
import { describeWord } from '@shared/status-model.js';
import { parseScope } from '@shared/scope.js';
import { Button } from '@/ui';
import { NativeSelect } from '@/ui/native-select';
import { cn } from '@/lib/cn';
import { duration, money } from '@/lib/format';

/* ------------------------------------------------------------------ *
 * The vocabulary
 * ------------------------------------------------------------------ */

/** What a station's paint can say. `state` is the default and the board's own. */
export const MAP_COLORS = ['state', 'repo', 'size', 'cost', 'time'] as const;
export type MapColor = (typeof MAP_COLORS)[number];

export const MAP_COLOR_LABELS: Record<MapColor, string> = {
  state: 'State',
  repo: 'Repository',
  size: 'Size',
  cost: 'Cost spent',
  time: 'Time taken',
};

/** How the stations are laid out. `lr` is the default. */
export const MAP_LAYOUTS = ['lr', 'tb', 'repo'] as const;
export type MapLayout = (typeof MAP_LAYOUTS)[number];

export const MAP_LAYOUT_LABELS: Record<MapLayout, string> = {
  lr: 'Left to right',
  tb: 'Top to bottom',
  repo: 'One lane per repository',
};

/**
 * The layers a reader can switch. `names` and `short` are two spellings of one
 * layer (a station's name, full or one short line); with neither the map draws
 * numbers only.
 */
export const MAP_LAYERS = ['names', 'short', 'batches', 'critical', 'waves', 'done'] as const;
export type MapLayer = (typeof MAP_LAYERS)[number];

export const MAP_LAYER_LABELS: Record<MapLayer, string> = {
  names: 'Names',
  short: 'Short names',
  batches: 'Batches',
  critical: 'Critical path',
  waves: 'Wave headings',
  done: 'Done waves',
};

/** What a map draws when the address says nothing. */
export const DEFAULT_LAYERS: readonly MapLayer[] = ['names', 'batches', 'critical', 'waves', 'done'];

/** The two status words the board does not have: a gate, and the trunk. */
export const MAP_OVERLAYS = ['gated', 'critical'] as const;

export interface MapTools {
  status: string[];
  repo: string[];
  size: string[];
  color: MapColor;
  layers: ReadonlySet<MapLayer>;
  layout: MapLayout;
  sel: number | null;
}

export const DEFAULT_TOOLS: MapTools = {
  status: [],
  repo: [],
  size: [],
  color: 'state',
  layers: new Set(DEFAULT_LAYERS),
  layout: 'lr',
  sel: null,
};

/** The address's keys, in the order a link writes them. */
export const MAP_PARAMS = ['status', 'repo', 'size', 'color', 'layer', 'layout', 'sel'] as const;

/* ------------------------------------------------------------------ *
 * The address
 * ------------------------------------------------------------------ */

const listOf = (value: string | undefined): string[] =>
  [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));

const oneOf = <T extends string>(words: readonly T[], value: string | undefined, fallback: T): T =>
  (words as readonly string[]).includes(value ?? '') ? (value as T) : fallback;

/** The tools an address asks for; anything it does not say is the default, and an unknown word is ignored. */
export function mapToolsOf(query: Readonly<Record<string, string | undefined>>): MapTools {
  const layerParam = query.layer;
  let layers: Set<MapLayer>;
  if (layerParam === undefined) layers = new Set(DEFAULT_LAYERS);
  else if (layerParam === 'none') layers = new Set();
  else
    layers = new Set(
      listOf(layerParam).filter((l): l is MapLayer => (MAP_LAYERS as readonly string[]).includes(l)),
    );
  // One name layer at a time: a full name wins over the short one.
  if (layers.has('names')) layers.delete('short');
  const sel = Number(query.sel);
  return {
    status: listOf(query.status),
    repo: listOf(query.repo),
    size: listOf(query.size),
    color: oneOf(MAP_COLORS, query.color, 'state'),
    layers,
    layout: oneOf(MAP_LAYOUTS, query.layout, 'lr'),
    sel: Number.isInteger(sel) && sel > 0 ? sel : null,
  };
}

const sameLayers = (a: ReadonlySet<MapLayer>, b: readonly MapLayer[]) =>
  a.size === b.length && b.every((layer) => a.has(layer));

/** The tools as query parameters — only what differs from the default, in a fixed order. */
export function mapToolsQuery(tools: MapTools): [string, string][] {
  const out: [string, string][] = [];
  if (tools.status.length) out.push(['status', [...tools.status].sort().join(',')]);
  if (tools.repo.length) out.push(['repo', [...tools.repo].sort().join(',')]);
  if (tools.size.length) out.push(['size', [...tools.size].sort().join(',')]);
  if (tools.color !== 'state') out.push(['color', tools.color]);
  if (!sameLayers(tools.layers, DEFAULT_LAYERS)) {
    const on = MAP_LAYERS.filter((layer) => tools.layers.has(layer));
    out.push(['layer', on.length ? on.join(',') : 'none']);
  }
  if (tools.layout !== 'lr') out.push(['layout', tools.layout]);
  if (tools.sel != null) out.push(['sel', String(tools.sel)]);
  return out;
}

/** The tools as the `extra` of `planViewHref(slug, 'map', extra)` — `a=b&c=d`, encoded. */
export function mapToolsSearch(tools: MapTools): string {
  return new URLSearchParams(mapToolsQuery(tools)).toString().replace(/%2C/g, ',');
}

/** Whether anything but the selection differs from the default — what *Clear the tools* is offered for. */
export const toolsActive = (tools: MapTools): boolean => mapToolsQuery({ ...tools, sel: null }).length > 0;

/** A facet with `value` switched in or out. */
export const toggled = (list: readonly string[], value: string): string[] =>
  list.includes(value) ? list.filter((one) => one !== value) : [...list, value].sort();

/** The layers with `layer` switched — the two name layers exclude each other. */
export function toggledLayer(layers: ReadonlySet<MapLayer>, layer: MapLayer): Set<MapLayer> {
  const next = new Set(layers);
  if (next.has(layer)) next.delete(layer);
  else {
    next.add(layer);
    if (layer === 'names') next.delete('short');
    if (layer === 'short') next.delete('names');
  }
  return next;
}

/* ------------------------------------------------------------------ *
 * What a station is, for the tools
 * ------------------------------------------------------------------ */

/** One station's facts as the tools read them — joined at the call site from the plan's phases. */
export interface StationFacts {
  phase: number;
  state: string;
  size: string;
  gated: boolean;
  critical: boolean;
  repos: string[];
  costUsd?: number;
  durationMs?: number;
}

/** A phase's Repos cell as scope tokens — the console's one reader of the column. */
export const reposOf = (cell: string | undefined): string[] => parseScope(cell ?? '');

/** Does a station pass every facet that is set? An empty facet passes everything. */
export function passes(station: StationFacts, tools: Pick<MapTools, 'status' | 'repo' | 'size'>): boolean {
  if (tools.status.length) {
    const words = new Set<string>([station.state]);
    if (station.gated) words.add('gated');
    if (station.critical) words.add('critical');
    if (!tools.status.some((word) => words.has(word))) return false;
  }
  if (tools.repo.length && !tools.repo.some((repo) => station.repos.includes(repo))) return false;
  if (tools.size.length && !tools.size.includes(station.size)) return false;
  return true;
}

/** One chip of a facet: its value, its words and how many stations carry it. */
export interface Chip {
  facet: 'status' | 'repo' | 'size';
  value: string;
  label: string;
  count: number;
}

/** The chips with counts, built from the plan — the key's words, then the repositories, then the sizes. */
export function chipsOf(stations: readonly StationFacts[]): Chip[] {
  const count = (test: (s: StationFacts) => boolean) => stations.filter(test).length;
  const status: Chip[] = (BOARD_ORDER as readonly string[]).map((word) => ({
    facet: 'status' as const,
    value: word,
    label: describeWord('board', word).label,
    count: count((s) => s.state === word),
  }));
  status.push(
    { facet: 'status', value: 'gated', label: 'Gated', count: count((s) => s.gated) },
    { facet: 'status', value: 'critical', label: 'On the critical path', count: count((s) => s.critical) },
  );
  const repos = [...new Set(stations.flatMap((s) => s.repos))].sort((a, b) => a.localeCompare(b));
  const repo: Chip[] = repos.map((value) => ({
    facet: 'repo',
    value,
    label: value,
    count: count((s) => s.repos.includes(value)),
  }));
  const sizes = [...new Set(stations.map((s) => s.size).filter(Boolean))].sort(bySize);
  const size: Chip[] = sizes.map((value) => ({
    facet: 'size',
    value,
    label: `Size ${value}`,
    count: count((s) => s.size === value),
  }));
  return [...status.filter((chip) => chip.count > 0), ...repo, ...size];
}

const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL'];
function bySize(a: string, b: string): number {
  const ia = SIZE_ORDER.indexOf(a);
  const ib = SIZE_ORDER.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
}

/* ------------------------------------------------------------------ *
 * The trace
 * ------------------------------------------------------------------ */

/** Everything a station waits on (upstream) and everything it unblocks (downstream), transitively. */
export function traceOf(
  edges: readonly { from: number; to: number }[],
  phase: number,
): { up: Set<number>; down: Set<number> } {
  const walk = (next: (p: number) => number[]) => {
    const seen = new Set<number>();
    const stack = next(phase);
    while (stack.length) {
      const p = stack.pop()!;
      if (seen.has(p) || p === phase) continue;
      seen.add(p);
      stack.push(...next(p));
    }
    return seen;
  };
  const into = new Map<number, number[]>();
  const outOf = new Map<number, number[]>();
  for (const { from, to } of edges) {
    into.set(to, [...(into.get(to) ?? []), from]);
    outOf.set(from, [...(outOf.get(from) ?? []), to]);
  }
  return { up: walk((p) => into.get(p) ?? []), down: walk((p) => outOf.get(p) ?? []) };
}

/** The trace in words — what the station waits on and what it unblocks. */
export function traceWords(trace: { up: ReadonlySet<number>; down: ReadonlySet<number> }): string {
  return `waits on ${trace.up.size} · unblocks ${trace.down.size}`;
}

/* ------------------------------------------------------------------ *
 * Colour by
 * ------------------------------------------------------------------ */

/**
 * The categorical paints a repository lane is drawn in — the console's own
 * status tokens, never a literal colour, and never the two that summon a
 * person (failed, needs-you): a repository is not an alarm.
 */
const CATEGORY_PAINT = [
  'var(--status-running)',
  'var(--status-done)',
  'var(--status-waiting)',
  'var(--status-verifying)',
  'var(--status-queued)',
  'var(--status-skipped)',
] as const;

/** An ordinal ramp: one hue, four strengths over the track's own ink. */
const RAMP = [35, 60, 80, 100].map(
  (pct) => `color-mix(in oklch, var(--status-running) ${pct}%, var(--track))`,
);

/** The paint of a station that has no figure for the measure — the track's own ink. */
export const NO_FIGURE_PAINT = 'var(--track)';

/** One entry of a colour key: a swatch and its words. */
export interface ColorKey {
  paint: string;
  label: string;
}

export interface ColorScale {
  /** A station's paint, or `undefined` for the board's own (`color=state`). */
  paintOf: (station: StationFacts) => string | undefined;
  key: ColorKey[];
}

/** Four bins over `[0, max]`, each labelled by its upper bound in the measure's own words. */
function binned(values: readonly number[], words: (n: number) => string) {
  const max = Math.max(0, ...values);
  const bounds = [0.25, 0.5, 0.75, 1].map((f) => f * max);
  const binOf = (v: number) =>
    Math.min(
      3,
      bounds.findIndex((b) => v <= b + 1e-9),
    );
  const key = bounds.map((b, i) => ({
    paint: RAMP[i]!,
    label: i === 0 ? `up to ${words(b)}` : `${words(bounds[i - 1]!)} to ${words(b)}`,
  }));
  return { binOf, key, max };
}

/** What `color=` paints each station, and the key that says so. */
export function colorScale(color: MapColor, stations: readonly StationFacts[]): ColorScale {
  if (color === 'state') return { paintOf: () => undefined, key: [] };
  if (color === 'repo') {
    const repos = [...new Set(stations.map((s) => s.repos[0] ?? ''))].sort((a, b) => a.localeCompare(b));
    const paintOf = (s: StationFacts) => {
      const at = repos.indexOf(s.repos[0] ?? '');
      return s.repos.length ? CATEGORY_PAINT[at % CATEGORY_PAINT.length] : NO_FIGURE_PAINT;
    };
    return {
      paintOf,
      key: repos.map((repo, i) => ({
        paint: repo ? CATEGORY_PAINT[i % CATEGORY_PAINT.length]! : NO_FIGURE_PAINT,
        label: repo || 'No repository named',
      })),
    };
  }
  if (color === 'size') {
    const sizes = [...new Set(stations.map((s) => s.size))].sort(bySize);
    const step = (i: number) => RAMP[Math.round((i * (RAMP.length - 1)) / Math.max(1, sizes.length - 1))]!;
    return {
      paintOf: (s) => step(sizes.indexOf(s.size)),
      key: sizes.map((size, i) => ({ paint: step(i), label: `Size ${size}` })),
    };
  }
  const measure = (s: StationFacts) => (color === 'cost' ? s.costUsd : s.durationMs);
  const values = stations.map(measure).filter((v): v is number => typeof v === 'number' && v > 0);
  const words = color === 'cost' ? money : duration;
  if (!values.length) {
    return {
      paintOf: () => NO_FIGURE_PAINT,
      key: [{ paint: NO_FIGURE_PAINT, label: color === 'cost' ? 'Nothing spent yet' : 'Nothing timed yet' }],
    };
  }
  const { binOf, key } = binned(values, words);
  return {
    paintOf: (s) => {
      const v = measure(s);
      return typeof v === 'number' && v > 0 ? RAMP[binOf(v)] : NO_FIGURE_PAINT;
    },
    key: [...key, { paint: NO_FIGURE_PAINT, label: color === 'cost' ? 'Nothing spent' : 'Not timed' }],
  };
}

/* ------------------------------------------------------------------ *
 * The controls
 * ------------------------------------------------------------------ */

function ChipButton({
  pressed,
  onClick,
  children,
  label,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
  label: string;
}) {
  return (
    <Button
      size="sm"
      variant={pressed ? 'default' : 'ghost'}
      aria-pressed={pressed}
      aria-label={label}
      className={cn('tnum', pressed && 'ring-1 ring-ink')}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/** The colour key under the tools — drawn only when the paint says something other than state. */
export function ColorLegend({ keys }: { keys: readonly ColorKey[] }) {
  if (!keys.length) return null;
  return (
    <ul
      data-slot="legend"
      aria-label="Colour key"
      data-testid="map-color-key"
      className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-meta text-ink-muted"
    >
      {keys.map((key) => (
        <li key={key.label} className="flex items-center gap-1.5">
          <i aria-hidden className="size-3 shrink-0 rounded-full" style={{ background: key.paint }} />
          {key.label}
        </li>
      ))}
    </ul>
  );
}

export function MapToolbar({
  tools,
  chips,
  colorKey,
  trace,
  onChange,
  onExport,
}: {
  tools: MapTools;
  chips: readonly Chip[];
  colorKey: readonly ColorKey[];
  /** The selected station's trace in words — `traceWords`. */
  trace?: string | null;
  onChange: (next: MapTools) => void;
  onExport?: (kind: 'svg' | 'png') => void;
}) {
  const facets = useMemo(
    () =>
      (['status', 'repo', 'size'] as const)
        .map((facet) => ({ facet, chips: chips.filter((chip) => chip.facet === facet) }))
        .filter((group) => group.chips.length > 0),
    [chips],
  );
  const set = (patch: Partial<MapTools>) => onChange({ ...tools, ...patch });
  return (
    <div
      className="flex min-w-0 flex-col gap-2 border-b border-rule px-(--tile-pad-x) py-(--tile-pad-y)"
      role="group"
      aria-label="Map tools"
      data-testid="map-tools"
    >
      {facets.map((group) => (
        <div
          key={group.facet}
          className="flex min-w-0 flex-wrap items-center gap-1"
          role="group"
          aria-label={`Filter by ${group.facet}`}
        >
          <span className="me-1 text-meta text-ink-muted">
            {group.facet === 'status' ? 'Filter' : group.facet === 'repo' ? 'Repository' : 'Size'}
          </span>
          {group.chips.map((chip) => {
            const on = tools[chip.facet].includes(chip.value);
            return (
              <ChipButton
                key={`${chip.facet}:${chip.value}`}
                pressed={on}
                label={`${chip.label}, ${chip.count}`}
                onClick={() =>
                  set({ [chip.facet]: toggled(tools[chip.facet], chip.value) } as Partial<MapTools>)
                }
              >
                {chip.label}
                <span className="text-ink-faint">{chip.count}</span>
              </ChipButton>
            );
          })}
        </div>
      ))}
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-meta text-ink-muted">
          Colour by
          <NativeSelect
            aria-label="Colour by"
            value={tools.color}
            onChange={(event) => set({ color: event.target.value as MapColor })}
            data-testid="map-color"
          >
            {MAP_COLORS.map((color) => (
              <option key={color} value={color}>
                {MAP_COLOR_LABELS[color]}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="flex items-center gap-2 text-meta text-ink-muted">
          Layout
          <NativeSelect
            aria-label="Layout"
            value={tools.layout}
            onChange={(event) => set({ layout: event.target.value as MapLayout })}
            data-testid="map-layout"
          >
            {MAP_LAYOUTS.map((layout) => (
              <option key={layout} value={layout}>
                {MAP_LAYOUT_LABELS[layout]}
              </option>
            ))}
          </NativeSelect>
        </label>
        <div className="flex min-w-0 flex-wrap items-center gap-1" role="group" aria-label="Layers">
          <span className="me-1 text-meta text-ink-muted">Layers</span>
          {MAP_LAYERS.map((layer) => (
            <ChipButton
              key={layer}
              pressed={tools.layers.has(layer)}
              label={MAP_LAYER_LABELS[layer]}
              onClick={() => set({ layers: toggledLayer(tools.layers, layer) })}
            >
              {MAP_LAYER_LABELS[layer]}
            </ChipButton>
          ))}
        </div>
        {onExport && (
          <div className="flex items-center gap-1" role="group" aria-label="Export">
            <span className="me-1 text-meta text-ink-muted">Export</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onExport('svg')}
              aria-label="Export the view as SVG"
            >
              SVG
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onExport('png')}
              aria-label="Export the view as PNG"
            >
              PNG
            </Button>
          </div>
        )}
        {toolsActive(tools) && (
          <Button size="sm" variant="ghost" onClick={() => onChange({ ...DEFAULT_TOOLS, sel: tools.sel })}>
            Clear the tools
          </Button>
        )}
      </div>
      {trace && tools.sel != null && (
        <p
          className="flex min-w-0 flex-wrap items-center gap-2 text-meta text-ink-muted"
          data-testid="map-trace"
          aria-live="polite"
        >
          <span className="text-ink">Tracing P{tools.sel}</span>
          <span className="tnum">{trace}</span>
          <Button size="sm" variant="ghost" onClick={() => set({ sel: null })}>
            Clear the trace
          </Button>
        </p>
      )}
      <ColorLegend keys={colorKey} />
    </div>
  );
}
