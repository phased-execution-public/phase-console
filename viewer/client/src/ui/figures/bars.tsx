/**
 * The four figures, drawn — the lazy half of `./lazy` (control-tower phase 29;
 * on the 7.0 tokens since quiet-console phase 19).
 *
 * `./lazy` owns the figures by name, their numbers and the one legal paint
 * vocabulary; what lives here is the DRAWING, because a figure that can be read
 * with a crosshair, zoomed and walked with a keyboard needs an axis, and an
 * axis is where a library earns its keep. This module is reached only through
 * `./lazy`'s `import()`, so the visx code rides in a chunk of its own and first
 * paint does not carry it (`scripts/check-dist.mjs` finds the chunk by the
 * `data-figure` attribute every drawing here spells). Its types come from
 * `./lazy` as types only: a value import would be a static edge back into the
 * door, and the chunk would stop being lazy.
 *
 * Four rules every drawing keeps, each held by `figures.test.tsx`:
 *
 *   - **Paint is a state.** A bar, a cell or a segment wears `.state-<tone>`
 *     and paints `var(--state)` — `bg-state` in HTML — the indirection every
 *     dot and station uses; every axis is drawn with `AXIS_PAINT`, never visx's
 *     own `#222`. The literal-colour sweep is what notices one that is not.
 *   - **What is drawn is what is tabulated.** Every datum carries
 *     `data-datum`/`data-value`, and the figure's numbers are held to the same
 *     rows.
 *   - **The page keeps its scroll.** The crosshair, the zoom and the gestures
 *     are `useFigure`'s: a plain wheel and a vertical swipe belong to the page.
 *   - **Sides are logical.** An HTML drawing places a bar by its inline start
 *     and reads a pointer from it, so a right-to-left page mirrors the bar and
 *     the crosshair together. An SVG draws in its own units, which no page
 *     direction moves, and is read in them.
 */

import { useMemo, useRef, type ReactNode } from 'react';
import { AxisBottom, AxisLeft, AxisTop } from '@visx/axis';
import { localPoint } from '@visx/event';
import { Bar, Line } from '@visx/shape';

import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';

import type {
  BarListItem,
  BarPoint,
  CalendarCell,
  FigureTone,
  SeriesBucket,
  SeriesRow,
  StackSegment,
} from './lazy';
import {
  AXIS_PAINT,
  FIGURE_BAND,
  FIGURE_CAP,
  FIGURE_DESCENT,
  FIGURE_TYPE,
  inside,
  SERIES,
  seriesHeight,
  textWidth,
  useWidth,
} from './paint';
import { linear, valueTicks, valueTicksWithin, type AxisWindow } from './scales';
import { useFigure, type Figure } from './use-figure';

/** A client point in an SVG's own units — the viewBox, whatever the CSS size. */
function svgPoint(svg: SVGSVGElement | null, clientX: number, clientY: number) {
  if (!svg) return null;
  return localPoint(svg, { clientX, clientY } as unknown as MouseEvent);
}

/** Whether a box reads right to left: the nearest `dir` above it says so, as the document's switch does. */
const readsRtl = (box: Element): boolean => box.closest('[dir]')?.getAttribute('dir') === 'rtl';

/**
 * Where on a plain HTML box a client x falls, as a share of its width read
 * from the inline START — the edge its bars grow from, which is the box's
 * right-hand edge on a right-to-left page.
 */
function shareOf(box: Element | null, clientX: number): number | null {
  const rect = box?.getBoundingClientRect();
  if (!box || !rect || !(rect.width > 0)) return null;
  const fromStart = readsRtl(box) ? rect.right - clientX : clientX - rect.left;
  return fromStart / rect.width;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A zoomed window's end, as a person reads it: one decimal at most. */
const tenths = (value: number) => Math.round(value * 10) / 10;

/**
 * The frame every figure is drawn in: one focusable crosshair over the
 * drawing, and the line under it — the readout and, only while zoomed, the way
 * back.
 *
 * The reset is OUTSIDE the slider: a button inside a `role="slider"` is a
 * control nested in a control, which a screen reader cannot reach and axe
 * calls `nested-interactive`. The line is the slider's next sibling, which is
 * where `e2e/figures.spec.ts` looks for both. It is as tall as the button, so
 * a zoom moves nothing under it.
 */
function FigureFrame({
  name,
  figure,
  readout,
  idle,
  children,
}: {
  /** The figure's name in `FIGURES` — the chunk mark and the tests' handle. */
  name: string;
  figure: Figure;
  /** What the crosshair is on, in words. */
  readout: ReactNode;
  /** What the line says with no crosshair — the figure's own caption. */
  idle: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div
        {...figure.sliderProps}
        {...figure.surfaceProps}
        data-figure={name}
        title="Arrow keys read each value; + and − zoom, and so do ⌃ or ⌘ with the wheel, or a pinch"
        className="relative select-none rounded-sm"
      >
        {children}
      </div>
      <div className="flex min-h-7 min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-meta text-ink-muted">
        {/* `aria-hidden`: the slider's value text says the same words, and a
            live region here would announce every pixel of a hover. */}
        <span aria-hidden="true" data-readout className="min-w-0 break-words tnum">
          {figure.cursor === null ? idle : readout}
        </span>
        {figure.zoomed ? (
          <Button variant="ghost" size="sm" className="tnum" onClick={figure.reset}>
            Reset zoom, ×{figure.zoom.toFixed(1)}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Bars — weekly completions, on a count axis
 * ------------------------------------------------------------------ */

/**
 * The plot's margins in the SVG's own units, named for what sits in them and
 * cut from the figures' type (`./paint`), so no label outgrows its room: the
 * band above the bars (half a numeral — the top count is centred on its line —
 * and a pixel), the band the weeks are written in (the tick, then visx sets a
 * bottom label's baseline one type size under it, then its descent), and the
 * far edge. The gutter the counts are written in is not a constant: it is as
 * wide as the widest count it writes (`countsGutter`).
 */
const BARS_INSET = {
  top: Math.ceil(FIGURE_CAP / 2) + 1,
  weeks: Math.ceil(AXIS_PAINT.tickLength + FIGURE_TYPE + FIGURE_DESCENT),
  far: 4,
};

/** Two counts' lines at least this far apart, so two centred numerals never touch. */
const COUNT_PITCH = FIGURE_CAP + 4;

/**
 * The gutter the counts are written in: the tick, visx's quarter-em gap, the
 * widest count, and two pixels to the drawing's edge.
 */
const countsGutter = (ticks: readonly number[]): number =>
  Math.ceil(
    AXIS_PAINT.tickLength + FIGURE_TYPE / 4 + Math.max(...ticks.map((t) => textWidth(String(t)))) + 2,
  );

/** A week as its axis writes it: `2026-W38` → `W38`. */
const weekLabel = (week: string | undefined): string => (week ?? '').replace(/^\d{4}-/, '');

export function BarsDrawing({
  data,
  height,
  label,
}: {
  data: readonly BarPoint[];
  height: number;
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const width = useWidth(box, 320);
  const count = data.length;
  const plotH = Math.max(1, height - BARS_INSET.top - BARS_INSET.weeks);
  const max = Math.max(1, ...data.map((d) => d.count));
  // As many counts as the plot's height can write a line apart — thinned, never smaller.
  const ticks = valueTicksWithin(max, plotH, COUNT_PITCH, 3);
  const top = ticks[ticks.length - 1];
  const counts = countsGutter(ticks);
  const plotW = Math.max(1, width - counts - BARS_INSET.far);
  const one = label.replace(/s$/, '');

  const xOf = (view: AxisWindow) => linear(view, [counts, counts + plotW]);
  const figure = useFigure({
    label: `${label} per week`,
    count,
    bounds: [0, Math.max(count, 1)],
    // Four weeks at the closest, or half of a shorter series.
    minSpan: Math.max(1, Math.min(4, count / 2)),
    describe: (i) => `${data[i].week}: ${plural(data[i].count, one, label)}`,
    stopAt: (i) => i + 0.5,
    locate: (clientX, clientY, view) => {
      const point = svgPoint(svg.current, clientX, clientY);
      if (!point) return null;
      const at = xOf(view).invert(point.x);
      return { at, stop: at >= 0 && at < count ? Math.floor(at) : null };
    },
  });

  const x = xOf(figure.view);
  const y = linear([0, top], [BARS_INSET.top + plotH, BARS_INSET.top]);
  const gap = Math.min(3, (x(1) - x(0)) * 0.18);
  // A week label every so many bars, so two never touch: each gets the widest
  // label's width and a type size of air (`W38` is 29 px of it).
  const pitch = Math.max(0, ...data.map((d) => textWidth(weekLabel(d.week)))) + FIGURE_TYPE;
  const every = Math.max(1, Math.ceil((figure.view[1] - figure.view[0]) / Math.max(1, plotW / pitch)));
  const labelled = data.map((_, i) => i).filter((i) => i % every === (count - 1) % every);
  const cursor = figure.cursor;
  const sum = data.reduce((total, d) => total + d.count, 0);

  return (
    <FigureFrame
      name="Bars"
      figure={figure}
      idle={`${plural(count, 'week')}, ${plural(sum, one, label)}`}
      readout={cursor !== null && data[cursor] ? figure.sliderProps['aria-valuetext'] : null}
    >
      <div ref={box}>
        <svg
          ref={svg}
          viewBox={`0 0 ${width} ${height}`}
          height={height}
          className="block w-full overflow-hidden"
          role="img"
          aria-label={`${label} per week`}
        >
          {ticks.map((tick) => (
            <line
              key={tick}
              x1={counts}
              x2={counts + plotW}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--rule)"
              strokeWidth={0.5}
              opacity={0.6}
            />
          ))}
          {data.map((point, i) => {
            const x0 = Math.max(counts, x(i) + gap / 2);
            const x1 = Math.min(counts + plotW, x(i + 1) - gap / 2);
            const barHeight = (point.count / top) * plotH;
            // The week still being written is drawn apart, in the action's ink;
            // every closed week is the running state's paint.
            const current = i === count - 1;
            return (
              <Bar
                key={point.week ?? i}
                data-datum={point.week}
                data-value={point.count}
                x={x0}
                y={BARS_INSET.top + plotH - barHeight}
                width={Math.max(0, x1 - x0)}
                height={Math.max(point.count ? 1.5 : 0, barHeight)}
                rx={1}
                className={current ? undefined : 'state-running'}
                fill={current ? 'var(--action)' : 'var(--state)'}
                opacity={current || cursor === i ? 1 : 0.75}
              >
                <title>{`${point.week}: ${plural(point.count, one, label)}`}</title>
              </Bar>
            );
          })}
          <AxisLeft
            left={counts}
            scale={y}
            tickValues={ticks}
            hideAxisLine
            tickFormat={(value) => String(value)}
            {...AXIS_PAINT}
            // Each count centred on its own line — half a numeral over it and
            // half under — which is what the band above the bars is cut for.
            tickLabelProps={{ ...AXIS_PAINT.tickLabelProps, dy: FIGURE_CAP / 2 }}
          />
          <AxisBottom
            top={BARS_INSET.top + plotH}
            scale={x}
            tickValues={labelled.map((i) => i + 0.5)}
            tickFormat={(value) => weekLabel(data[Math.floor(Number(value))]?.week)}
            {...AXIS_PAINT}
            // Baseline inside the drawing: the default `0.25em` below the tick
            // put the week under the SVG's bottom edge at a phone's scale. A week
            // is centred on its bar, and held inside the drawing at either end —
            // the current week's label is always drawn, at the far edge.
            tickLabelProps={(value) => ({
              ...AXIS_PAINT.tickLabelProps,
              dy: 0,
              ...inside(x(Number(value)), textWidth(weekLabel(data[Math.floor(Number(value))]?.week)), width),
            })}
          />
          {cursor !== null && data[cursor] ? (
            <Line
              from={{ x: x(cursor + 0.5), y: BARS_INSET.top }}
              to={{ x: x(cursor + 0.5), y: BARS_INSET.top + plotH }}
              stroke="var(--ink-muted)"
              strokeWidth={1}
              strokeDasharray="2 2"
              pointerEvents="none"
            />
          ) : null}
        </svg>
      </div>
    </FigureFrame>
  );
}

/* ------------------------------------------------------------------ *
 * Calendar — days as cells, weeks as columns, months as the axis
 * ------------------------------------------------------------------ */

/**
 * The band the months are written in — one line of the figures' type, its
 * baseline a descent above the first row so a `p` or a `y` clears the cells —
 * then a row per weekday. 86 in all, which `./lazy` reserves for the drawing
 * before its chunk arrives (16 + 7 × 10; the band was 12, for a 9 px month).
 */
const CAL_TOP = FIGURE_BAND;
const CAL_ROW = 10;
const CAL_HEIGHT = CAL_TOP + 7 * CAL_ROW;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A month's label, placed: written from its week's start, or held against the far edge. */
type MonthLabel = { week: number; month: number; end: boolean };

/**
 * The months the band can name, right to left, each placed: from its first
 * week's start, or flush with the far edge when it would run past it — and a
 * month whose label would touch the next one's is not named. Walking from the
 * right drops the EARLIER of two, which is the window's first, partial month.
 */
function monthLabels(
  starts: readonly { week: number; month: number }[],
  at: (week: number) => number,
  width: number,
): MonthLabel[] {
  const out: MonthLabel[] = [];
  // Where the label to the right begins, less half a type size of air.
  let room = Infinity;
  for (let i = starts.length - 1; i >= 0; i--) {
    const { week, month } = starts[i];
    const from = at(week);
    if (from < 0 || from >= width) continue;
    const wide = textWidth(MONTHS[month]);
    const end = from + 1 + wide > width - 1;
    const left = end ? width - 1 - wide : from + 1;
    if (left + wide > room) continue;
    out.unshift({ week, month, end });
    room = left - FIGURE_TYPE / 2;
  }
  return out;
}

/** `cells` and `span` come from `./lazy`, which tabulates the same days. */
export function CalendarDrawing({ cells, span }: { cells: readonly CalendarCell[]; span: number }) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const width = useWidth(box, 320);
  const columns = span + 1;

  const xOf = (view: AxisWindow) => linear(view, [0, width]);
  const figure = useFigure({
    label: 'Phase completions by day',
    count: cells.length,
    bounds: [0, columns],
    minSpan: Math.min(columns, 4),
    describe: (i) => `${cells[i].date}: ${plural(cells[i].count, 'phase')} completed`,
    stopAt: (i) => cells[i].week + 0.5,
    // A calendar is two-dimensional: up and down are days, across is weeks.
    keySteps: { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 },
    locate: (clientX, clientY, view) => {
      const point = svgPoint(svg.current, clientX, clientY);
      if (!point) return null;
      const at = xOf(view).invert(point.x);
      const week = Math.floor(at);
      const day = Math.floor((point.y - CAL_TOP) / CAL_ROW);
      const stop = cells.findIndex((cell) => cell.week === week && cell.day === day);
      return { at, stop: stop >= 0 ? stop : null };
    },
  });

  const x = xOf(figure.view);
  const column = x(1) - x(0);
  const size = Math.max(2, Math.min(column, CAL_ROW) - 2);
  // A month's name over the first week that starts in it.
  const monthStarts = useMemo(() => {
    const out: { week: number; month: number }[] = [];
    let last = -1;
    for (const cell of cells) {
      if (cell.day !== 0 && out.length) continue;
      const month = Number(cell.date.slice(5, 7)) - 1;
      if (month !== last) out.push({ week: cell.week, month });
      last = month;
    }
    return out;
  }, [cells]);
  const named = monthLabels(monthStarts, x, width);
  const picked = figure.cursor !== null ? cells[figure.cursor] : undefined;

  return (
    <FigureFrame
      name="Calendar"
      figure={figure}
      idle={`Last ${span} weeks`}
      readout={picked ? figure.sliderProps['aria-valuetext'] : null}
    >
      <div ref={box}>
        <svg
          ref={svg}
          viewBox={`0 0 ${width} ${CAL_HEIGHT}`}
          height={CAL_HEIGHT}
          className="block w-full overflow-hidden"
          role="img"
          aria-label="Phase completions by day"
        >
          {/* Every cell is the done state's paint, mixed into the track by how
              full the day was; an empty day is the track itself. */}
          <g className="state-done">
            {cells.map((cell, i) => (
              <rect
                key={cell.date}
                data-datum={cell.date}
                data-value={cell.count}
                x={x(cell.week) + (column - size) / 2}
                y={CAL_TOP + cell.day * CAL_ROW + (CAL_ROW - size) / 2}
                width={size}
                height={size}
                rx="1.5"
                fill={
                  cell.count
                    ? `color-mix(in oklab, var(--state) ${Math.round(cell.intensity * 100)}%, var(--track))`
                    : 'var(--track)'
                }
                stroke={figure.cursor === i ? 'var(--action)' : 'none'}
                strokeWidth={figure.cursor === i ? 1.5 : 0}
              >
                <title>{`${cell.date}: ${plural(cell.count, 'phase')}`}</title>
              </rect>
            ))}
          </g>
          <AxisTop
            top={CAL_TOP - FIGURE_DESCENT}
            scale={x}
            tickValues={named.map((m) => m.week)}
            tickFormat={(value) => MONTHS[named.find((m) => m.week === Number(value))?.month ?? 0]}
            hideAxisLine
            {...AXIS_PAINT}
            tickLength={0}
            hideTicks
            // The month sits IN the band above the cells, on the band's baseline;
            // visx's default lifts it three-quarters of an em above the axis, off
            // the top of the SVG.
            tickLabelProps={(value, index) => ({
              ...AXIS_PAINT.tickLabelProps,
              textAnchor: named[index]?.end ? 'end' : 'start',
              dx: named[index]?.end ? width - 1 - x(Number(value)) : 1,
              dy: 0,
            })}
          />
        </svg>
      </div>
    </FigureFrame>
  );
}

/* ------------------------------------------------------------------ *
 * BarList — ranked rows, on a value axis
 * ------------------------------------------------------------------ */

/**
 * The rows share one grid — each row a subgrid of it — so every bar starts
 * and ends on the same pixel whatever its value's words, and a zoomed tick
 * sits over the bars it labels rather than over a column of its own width.
 */
const RANKED = 'grid grid-cols-[minmax(0,1fr)_2.5fr_auto] items-center gap-x-2 gap-y-1';

export function BarListDrawing({
  items,
  tone: paint,
  valueText,
}: {
  items: readonly BarListItem[];
  tone: FigureTone;
  /** A value as the figure writes it — the same words in the bars, the readout and the numbers. */
  valueText: (value: number) => string;
}) {
  const track = useRef<HTMLSpanElement>(null);
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const max = Math.max(1, ...items.map((item) => item.value));
  const total = items.reduce((sum, item) => sum + item.value, 0);

  const figure = useFigure({
    label: 'Ranked values',
    count: items.length,
    bounds: [0, max],
    // Zooming the VALUE axis is what a ranked list is read closer for: the long
    // tail, whose bars are a few pixels each at the scale of the leader.
    minSpan: max / 32,
    describe: (i) =>
      `${items[i].name}: ${valueText(items[i].value)}` +
      (total ? `, ${Math.round((items[i].value / total) * 100)}% of the total` : ''),
    keySteps: { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -1, ArrowRight: 1 },
    initialStop: 0,
    locate: (clientX, clientY, view) => {
      const share = shareOf(track.current, clientX);
      const at = share === null ? (view[0] + view[1]) / 2 : view[0] + share * (view[1] - view[0]);
      const stop = rows.current.findIndex((row) => {
        const rect = row?.getBoundingClientRect();
        return rect ? clientY >= rect.top && clientY < rect.bottom : false;
      });
      return { at, stop: stop >= 0 ? stop : null };
    },
  });

  const [low, high] = figure.view;
  const pct = (value: number) => Math.min(100, Math.max(0, ((value - low) / (high - low)) * 100));
  const ticks = figure.zoomed ? valueTicks(low, high, 3).filter((t) => t >= low && t <= high) : [];
  const cursor = figure.cursor;

  return (
    <FigureFrame
      name="BarList"
      figure={figure}
      idle={
        figure.zoomed
          ? `Values ${valueText(tenths(low))} to ${valueText(tenths(high))}`
          : plural(items.length, 'row')
      }
      readout={cursor !== null && items[cursor] ? figure.sliderProps['aria-valuetext'] : null}
    >
      <div className={RANKED}>
        {ticks.length ? (
          <div aria-hidden="true" className="col-span-full grid grid-cols-subgrid">
            <span className="relative col-start-2 h-5 text-meta text-ink-faint">
              {ticks.map((tick) => (
                // Centred on its value from the inline start: the translate
                // has no logical twin, so a right-to-left page turns it round.
                <span
                  key={tick}
                  className="absolute top-0 -translate-x-1/2 whitespace-nowrap tnum rtl:translate-x-1/2"
                  style={{ insetInlineStart: `${pct(tick)}%` }}
                >
                  {valueText(tick)}
                </span>
              ))}
            </span>
          </div>
        ) : null}
        {items.map((item, i) => {
          const over = item.value > high;
          return (
            <div
              key={item.name}
              ref={(node) => {
                rows.current[i] = node;
              }}
              data-datum={item.name}
              data-value={item.value}
              className={cn(
                'col-span-full grid grid-cols-subgrid items-center rounded-sm',
                cursor === i && 'bg-ground-deep',
              )}
              // The whole row, not just the truncated name: a pointer asking a
              // 6 px bar what it is should get the reading, not the label it can
              // already see. The numbers are the same answer for everyone else.
              title={`${item.name}: ${valueText(item.value)}`}
            >
              <span className="truncate text-meta text-ink-muted">{item.name}</span>
              <span
                ref={i === 0 ? track : undefined}
                className="relative h-1.5 overflow-hidden rounded-full bg-track"
              >
                <span
                  className={cn('block h-full rounded-full bg-state', `state-${paint}`)}
                  style={{ width: `${pct(item.value)}%` }}
                />
                {over ? (
                  // Past the window's edge: said with a notch rather than by a
                  // bar that silently stops at the frame.
                  <span className="absolute inset-y-0 end-0 w-0.5 bg-ground" aria-hidden="true" />
                ) : null}
              </span>
              <span className="text-end text-meta text-ink tnum">{valueText(item.value)}</span>
            </div>
          );
        })}
      </div>
    </FigureFrame>
  );
}

/* ------------------------------------------------------------------ *
 * StackBar — one proportional stack, zoomable along its length
 * ------------------------------------------------------------------ */

export function StackBarDrawing({ segments }: { segments: readonly StackSegment[] }) {
  const bar = useRef<HTMLDivElement>(null);
  const sum = segments.reduce((running, segment) => running + segment.value, 0);
  // The divisor, never zero: an all-empty stack is 0 of 0, and "—" is its share.
  const total = sum || 1;
  const starts = useMemo(() => {
    let at = 0;
    return segments.map((segment) => {
      const start = at;
      at += segment.value;
      return start;
    });
  }, [segments]);

  const figure = useFigure({
    label: 'Segments',
    count: segments.length,
    bounds: [0, total],
    // A 2 px segment beside a 3 px one is the same segment to the eye; zoomed
    // sixteen times it is not.
    minSpan: total / 16,
    describe: (i) =>
      `${segments[i].label}: ${segments[i].value}` +
      (sum ? `, ${Math.round((segments[i].value / total) * 100)}%` : ''),
    stopAt: (i) => starts[i] + segments[i].value / 2,
    initialStop: 0,
    locate: (clientX, _clientY, view) => {
      const share = shareOf(bar.current, clientX);
      if (share === null) return null;
      const at = view[0] + share * (view[1] - view[0]);
      const stop = segments.findIndex((segment, i) => at >= starts[i] && at < starts[i] + segment.value);
      return { at, stop: stop >= 0 ? stop : null };
    },
  });

  const [low, high] = figure.view;
  const pct = (value: number) => (value / (high - low)) * 100;
  const cursor = figure.cursor;
  const [lowShare, highShare] = [(low / total) * 100, (high / total) * 100];
  const ticks = figure.zoomed
    ? valueTicks(lowShare, highShare, 3).filter((t) => t >= lowShare && t <= highShare)
    : [];

  return (
    <FigureFrame
      name="StackBar"
      figure={figure}
      idle={sum ? `${sum} in all` : 'Nothing counted'}
      readout={cursor !== null && segments[cursor] ? figure.sliderProps['aria-valuetext'] : null}
    >
      <div
        ref={bar}
        className="relative h-2.5 overflow-hidden rounded-full bg-track"
        role="img"
        aria-label={segments.map((s) => `${s.label} ${s.value}`).join(', ')}
      >
        {segments.map(({ label, value, tone: paint }, i) => (
          // `title` the ATTRIBUTE, not a `<title>` child: this bar is HTML, and
          // a `<title>` here is the HEAD element, parsed out of place.
          <span
            key={label}
            data-datum={label}
            data-value={value}
            title={`${label}: ${value}`}
            className={cn(
              'absolute inset-y-0 bg-state',
              `state-${paint}`,
              cursor === i && 'outline outline-1 outline-ink',
            )}
            style={{ insetInlineStart: `${pct(starts[i] - low)}%`, width: `${pct(value)}%` }}
          />
        ))}
      </div>
      {ticks.length ? (
        <div className="relative mt-0.5 h-5 text-meta text-ink-faint" aria-hidden="true">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute top-0 -translate-x-1/2 whitespace-nowrap tnum rtl:translate-x-1/2"
              style={{ insetInlineStart: `${pct((tick / 100) * total - low)}%` }}
            >
              {tick}%
            </span>
          ))}
        </div>
      ) : null}
    </FigureFrame>
  );
}

/* ------------------------------------------------------------------ *
 * Series — one strip per row on one shared time axis
 * ------------------------------------------------------------------ */

/** A label cut, with an ellipsis, to the room it is written in — the numbers carry it in full. */
function clip(text: string, room: number): string {
  if (textWidth(text) <= room) return text;
  let out = text;
  while (out.length > 1 && textWidth(`${out}…`) > room) out = out.slice(0, -1);
  return `${out}…`;
}

/**
 * Small multiples, never a stack of colours: each row (an account) is a strip of
 * its own in the one paint, named in words above it, on one time axis and one
 * crosshair — the row is its label, never its hue (design.md §8.2). The column
 * still being written, the last bucket, is drawn apart in the action's ink, as
 * `Bars` draws its current week.
 */
export function SeriesDrawing({
  buckets,
  rows,
  tone: paint,
  valueText,
  timeText,
  label,
}: {
  buckets: readonly SeriesBucket[];
  rows: readonly SeriesRow[];
  tone: FigureTone;
  valueText: (value: number) => string;
  /** A bucket's start as the axis and the readout write it. */
  timeText: (start: string) => string;
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const width = useWidth(box, 320);
  const count = buckets.length;
  const height = seriesHeight(rows.length);
  const plotW = Math.max(1, width - 2 * SERIES.side);
  const max = Math.max(0, ...rows.flatMap((row) => row.values));
  const top = max > 0 ? max : 1;

  const xOf = (view: AxisWindow) => linear(view, [SERIES.side, SERIES.side + plotW]);
  const figure = useFigure({
    label,
    count,
    bounds: [0, Math.max(count, 1)],
    minSpan: Math.max(1, Math.min(6, count / 2)),
    describe: (i) => {
      const parts = rows
        .map((row) => ({ name: row.name, value: row.values[i] ?? 0 }))
        .filter((part) => part.value > 0)
        .map((part) => `${part.name} ${valueText(part.value)}`);
      return `${timeText(buckets[i]?.start ?? '')}: ${parts.length ? parts.join(', ') : 'nothing'}`;
    },
    stopAt: (i) => i + 0.5,
    locate: (clientX, clientY, view) => {
      const point = svgPoint(svg.current, clientX, clientY);
      if (!point) return null;
      const at = xOf(view).invert(point.x);
      return { at, stop: at >= 0 && at < count ? Math.floor(at) : null };
    },
  });

  const x = xOf(figure.view);
  const gap = Math.min(2, (x(1) - x(0)) * 0.2);
  const pitch = Math.max(0, ...buckets.map((b) => textWidth(timeText(b.start)))) + FIGURE_TYPE;
  const every = Math.max(1, Math.ceil((figure.view[1] - figure.view[0]) / Math.max(1, plotW / pitch)));
  const labelled = buckets.map((_, i) => i).filter((i) => i % every === (count - 1) % every);
  const cursor = figure.cursor;
  const axisAt = height - SERIES.times;
  const sum = rows.reduce((total, row) => total + row.values.reduce((a, b) => a + b, 0), 0);

  return (
    <FigureFrame
      name="Series"
      figure={figure}
      idle={
        max > 0
          ? `${valueText(sum)} in all; the tallest column, on every strip, is ${valueText(max)}`
          : 'Nothing was spent in this window'
      }
      readout={cursor !== null && buckets[cursor] ? figure.sliderProps['aria-valuetext'] : null}
    >
      <div ref={box}>
        <svg
          ref={svg}
          viewBox={`0 0 ${width} ${height}`}
          height={height}
          className="block w-full overflow-hidden"
          role="img"
          aria-label={label}
        >
          {rows.map((row, r) => {
            const y0 = r * (SERIES.name + SERIES.strip + SERIES.gap);
            const base = y0 + SERIES.name + SERIES.strip;
            const total = row.values.reduce((a, b) => a + b, 0);
            const name = `${row.name}  ${valueText(total)}`;
            return (
              <g key={row.name} data-row={row.name}>
                <text
                  x={SERIES.side}
                  y={y0 + FIGURE_BAND - FIGURE_DESCENT - 1}
                  fontSize={FIGURE_TYPE}
                  fill="var(--ink-muted)"
                >
                  {clip(name, plotW)}
                </text>
                <line
                  x1={SERIES.side}
                  x2={SERIES.side + plotW}
                  y1={base + 0.5}
                  y2={base + 0.5}
                  stroke="var(--rule-strong)"
                  strokeWidth={1}
                />
                {row.values.map((value, i) => {
                  const x0 = Math.max(SERIES.side, x(i) + gap / 2);
                  const x1 = Math.min(SERIES.side + plotW, x(i + 1) - gap / 2);
                  if (x1 <= x0) return null;
                  const h = (value / top) * SERIES.strip;
                  const current = i === count - 1;
                  return (
                    <Bar
                      key={buckets[i]?.start ?? i}
                      data-datum={`${row.name}@${buckets[i]?.start ?? i}`}
                      data-value={value}
                      x={x0}
                      y={base - h}
                      width={x1 - x0}
                      height={Math.max(value > 0 ? 1.5 : 0, h)}
                      rx={1}
                      className={current ? undefined : `state-${paint}`}
                      fill={current ? 'var(--action)' : 'var(--state)'}
                      opacity={current || cursor === i ? 1 : 0.75}
                    >
                      <title>{`${row.name}, ${timeText(buckets[i]?.start ?? '')}: ${valueText(value)}`}</title>
                    </Bar>
                  );
                })}
              </g>
            );
          })}
          <AxisBottom
            top={axisAt}
            scale={x}
            tickValues={labelled.map((i) => i + 0.5)}
            tickFormat={(value) => timeText(buckets[Math.floor(Number(value))]?.start ?? '')}
            {...AXIS_PAINT}
            tickLabelProps={(value) => ({
              ...AXIS_PAINT.tickLabelProps,
              dy: 0,
              ...inside(
                x(Number(value)),
                textWidth(timeText(buckets[Math.floor(Number(value))]?.start ?? '')),
                width,
              ),
            })}
          />
          {cursor !== null && buckets[cursor] ? (
            <Line
              from={{ x: x(cursor + 0.5), y: 0 }}
              to={{ x: x(cursor + 0.5), y: axisAt }}
              stroke="var(--ink-muted)"
              strokeWidth={1}
              strokeDasharray="2 2"
              pointerEvents="none"
            />
          ) : null}
        </svg>
      </div>
    </FigureFrame>
  );
}
