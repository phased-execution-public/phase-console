/**
 * The four figures, drawn — the lazy half of `charts.tsx` (control-tower
 * phase 29, #32 gap 2).
 *
 * `charts.tsx` still owns the figures by name, their numbers tables and the
 * one legal colour vocabulary; what moved here is the DRAWING, because a figure
 * that can be read with a crosshair, zoomed and walked with a keyboard needs an
 * axis, and an axis is where a library earns its keep. This module is reached
 * only through `./lazy` — a dynamic import — so the visx code rides in a chunk
 * of its own and first paint does not carry it (`scripts/check-dist.mjs`
 * finds the chunk by the `data-figure` attribute every drawing here spells).
 *
 * Three rules every drawing keeps, each held by a test:
 *
 *   - **Paint is a token.** Bars, cells and segments still resolve through
 *     `toneVar`, and every axis is drawn with `AXIS_PAINT`, never visx's own
 *     `#222` (`charts.test.tsx`'s literal-colour sweep).
 *   - **What is drawn is what is tabulated.** Every datum carries
 *     `data-datum`/`data-value`, and `figures/run-chart.test.tsx` holds the
 *     drawing and the `ChartNumbers` table under it to the same rows.
 *   - **The page keeps its scroll.** The crosshair, the zoom and the gestures
 *     are `useFigure`'s: a plain wheel and a vertical swipe belong to the page.
 */

import { useMemo, useRef, type ReactNode } from 'react';
import { AxisBottom, AxisLeft, AxisTop } from '@visx/axis';
import { localPoint } from '@visx/event';
import { Bar, Line } from '@visx/shape';

import { Button } from '@/components/ui';
import {
  toneVar,
  type BarListItem,
  type BarPoint,
  type CalendarCell,
  type ChartTone,
  type StackSegment,
} from '@/components/charts';
import { cn } from '@/lib/cn';

import { AXIS_PAINT, useWidth } from './paint';
import { linear, valueTicks, type AxisWindow } from './scales';
import { useFigure, type Figure } from './use-figure';

/** A client point in an SVG's own units — the viewBox, whatever the CSS size. */
function svgPoint(svg: SVGSVGElement | null, clientX: number, clientY: number) {
  if (!svg) return null;
  return localPoint(svg, { clientX, clientY } as unknown as MouseEvent);
}

/** Where on a plain HTML box a client x falls, as a share of its width. */
function shareOf(box: Element | null, clientX: number): number | null {
  const rect = box?.getBoundingClientRect();
  if (!rect || !(rect.width > 0)) return null;
  return (clientX - rect.left) / rect.width;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The frame every figure is drawn in: one focusable crosshair over the
 * drawing, the readout under it, and — only while zoomed — the way back.
 *
 * The reset is OUTSIDE the slider: a button inside a `role="slider"` is a
 * control nested in a control, which a screen reader cannot reach and axe
 * calls `nested-interactive`.
 */
export function FigureFrame({
  name,
  figure,
  readout,
  idle,
  children,
}: {
  /** The figure's name in `CHART_FIGURES` — the chunk mark and the test's handle. */
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
        title="Arrow keys read each value · + and − zoom · ⌃ or ⌘ with the wheel, or a pinch, zooms too"
        className="relative select-none rounded-sm"
      >
        {children}
      </div>
      <div className="flex min-h-[1.5rem] items-center justify-between gap-2 text-2xs text-ink-faint">
        {/* `aria-hidden`: the slider's value text says the same words, and a
            live region here would announce every pixel of a hover. */}
        <span aria-hidden="true" data-readout className="min-w-0 truncate">
          {figure.cursor === null ? idle : readout}
        </span>
        {figure.zoomed ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-auto shrink-0 px-1 py-0 text-2xs"
            onClick={figure.reset}
          >
            Reset zoom · ×{figure.zoom.toFixed(1)}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Bars — weekly completions, on a count axis
 * ------------------------------------------------------------------ */

const BARS_PAD = { top: 6, right: 4, bottom: 16, left: 22 };

export function BarsDrawing({ data, height, label }: { data: BarPoint[]; height: number; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const width = useWidth(box, 320);
  const count = data.length;
  const plotW = Math.max(1, width - BARS_PAD.left - BARS_PAD.right);
  const plotH = Math.max(1, height - BARS_PAD.top - BARS_PAD.bottom);
  const max = Math.max(1, ...data.map((d) => d.count));
  const ticks = valueTicks(0, max, 3);
  const top = ticks[ticks.length - 1];

  const xOf = (view: AxisWindow) => linear(view, [BARS_PAD.left, BARS_PAD.left + plotW]);
  const figure = useFigure({
    label: `${label} per week`,
    count,
    bounds: [0, Math.max(count, 1)],
    // Four weeks at the closest, or half of a shorter series.
    minSpan: Math.max(1, Math.min(4, count / 2)),
    describe: (i) => `${data[i].week}: ${plural(data[i].count, label.replace(/s$/, ''), label)}`,
    stopAt: (i) => i + 0.5,
    locate: (clientX, clientY, view) => {
      const point = svgPoint(svg.current, clientX, clientY);
      if (!point) return null;
      const at = xOf(view).invert(point.x);
      return { at, stop: at >= 0 && at < count ? Math.floor(at) : null };
    },
  });

  const x = xOf(figure.view);
  const y = linear([0, top], [BARS_PAD.top + plotH, BARS_PAD.top]);
  const gap = Math.min(3, (x(1) - x(0)) * 0.18);
  // A week label every so many bars, so they never collide: ~44px apiece.
  const every = Math.max(1, Math.ceil((figure.view[1] - figure.view[0]) / Math.max(1, plotW / 44)));
  const labelled = data.map((_, i) => i).filter((i) => i % every === (count - 1) % every);
  const cursor = figure.cursor;

  return (
    <FigureFrame
      name="Bars"
      figure={figure}
      idle={`${plural(count, 'week')} · ${data.reduce((sum, d) => sum + d.count, 0)} ${label}`}
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
              x1={BARS_PAD.left}
              x2={BARS_PAD.left + plotW}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--rule)"
              strokeWidth={0.5}
              opacity={0.6}
            />
          ))}
          {data.map((point, i) => {
            const x0 = Math.max(BARS_PAD.left, x(i) + gap / 2);
            const x1 = Math.min(BARS_PAD.left + plotW, x(i + 1) - gap / 2);
            const barHeight = (point.count / top) * plotH;
            const current = i === count - 1;
            return (
              <Bar
                key={point.week ?? i}
                data-datum={point.week}
                data-value={point.count}
                x={x0}
                y={BARS_PAD.top + plotH - barHeight}
                width={Math.max(0, x1 - x0)}
                height={Math.max(point.count ? 1.5 : 0, barHeight)}
                rx={1}
                fill={current ? 'var(--action)' : toneVar('running')}
                opacity={current || cursor === i ? 1 : 0.75}
              >
                <title>{`${point.week}: ${point.count} ${label}`}</title>
              </Bar>
            );
          })}
          <AxisLeft
            left={BARS_PAD.left}
            scale={y}
            tickValues={ticks}
            hideAxisLine
            tickFormat={(value) => String(value)}
            {...AXIS_PAINT}
          />
          <AxisBottom
            top={BARS_PAD.top + plotH}
            scale={x}
            tickValues={labelled.map((i) => i + 0.5)}
            tickFormat={(value) => (data[Math.floor(Number(value))]?.week ?? '').replace(/^\d{4}-/, '')}
            {...AXIS_PAINT}
            // Baseline inside the drawing: the default `0.25em` below the tick
            // put the week under the SVG's bottom edge at a phone's scale.
            tickLabelProps={{ ...AXIS_PAINT.tickLabelProps, dy: 0 }}
          />
          {cursor !== null && data[cursor] ? (
            <Line
              from={{ x: x(cursor + 0.5), y: BARS_PAD.top }}
              to={{ x: x(cursor + 0.5), y: BARS_PAD.top + plotH }}
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

const CAL_HEIGHT = 86;
const CAL_TOP = 12;
const CAL_ROW = (CAL_HEIGHT - CAL_TOP) / 7;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `cells` and `span` come from `charts.tsx`, which tabulates the same days. */
export function CalendarDrawing({ cells, span }: { cells: CalendarCell[]; span: number }) {
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
  const picked = figure.cursor !== null ? cells[figure.cursor] : undefined;

  return (
    <FigureFrame
      name="Calendar"
      figure={figure}
      idle={`last ${span} weeks`}
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
                  ? `color-mix(in oklab, ${toneVar('done')} ${Math.round(cell.intensity * 100)}%, var(--track))`
                  : 'var(--track)'
              }
              stroke={figure.cursor === i ? 'var(--action)' : 'none'}
              strokeWidth={figure.cursor === i ? 1.5 : 0}
            >
              <title>{`${cell.date}: ${cell.count} phase${cell.count === 1 ? '' : 's'}`}</title>
            </rect>
          ))}
          <AxisTop
            top={CAL_TOP - 1}
            scale={x}
            tickValues={monthStarts.map((m) => m.week)}
            tickFormat={(value) => MONTHS[monthStarts.find((m) => m.week === Number(value))?.month ?? 0]}
            hideAxisLine
            {...AXIS_PAINT}
            tickLength={0}
            hideTicks
            // The month sits IN the band above the cells; visx's default lifts it
            // three-quarters of an em above the axis, off the top of the SVG.
            tickLabelProps={{ ...AXIS_PAINT.tickLabelProps, textAnchor: 'start', dx: 1, dy: 0 }}
          />
        </svg>
      </div>
    </FigureFrame>
  );
}

/* ------------------------------------------------------------------ *
 * BarList — ranked rows, on a value axis
 * ------------------------------------------------------------------ */

export function BarListDrawing({
  items,
  unit,
  tone,
}: {
  items: BarListItem[];
  unit: string;
  tone: ChartTone;
}) {
  const track = useRef<HTMLDivElement>(null);
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
      `${items[i].name}: ${items[i].value}${unit}${total ? ` · ${Math.round((items[i].value / total) * 100)}% of the total` : ''}`,
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
          ? `values ${low.toFixed(1)}–${high.toFixed(1)}${unit}`
          : `${plural(items.length, 'row')}`
      }
      readout={cursor !== null && items[cursor] ? figure.sliderProps['aria-valuetext'] : null}
    >
      <div className="flex flex-col gap-1">
        {ticks.length ? (
          <div className="grid grid-cols-[minmax(0,1fr)_2.5fr_auto] gap-2" aria-hidden="true">
            <span />
            <span className="relative h-3 text-[9px] text-ink-faint">
              {ticks.map((tick) => (
                <span
                  key={tick}
                  className="absolute -translate-x-1/2 tabular-nums"
                  style={{ left: `${pct(tick)}%` }}
                >
                  {tick}
                </span>
              ))}
            </span>
            <span />
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
                'grid grid-cols-[minmax(0,1fr)_2.5fr_auto] items-center gap-2 rounded-sm',
                cursor === i && 'bg-ground-deep',
              )}
              // The whole row, not just the truncated name: a pointer asking a
              // 6px bar what it is should get the reading, not the label it can
              // already see. The table below is the same answer for everyone else.
              title={`${item.name}: ${item.value}${unit}`}
            >
              <span className="truncate text-xs text-ink-muted">{item.name}</span>
              <span
                ref={i === 0 ? track : undefined}
                className="relative h-1.5 overflow-hidden rounded-full bg-track"
              >
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${pct(item.value)}%`, background: toneVar(tone) }}
                />
                {over ? (
                  // Past the window's edge: said with a notch rather than by a
                  // bar that silently stops at the frame.
                  <span className="absolute inset-y-0 right-0 w-0.5 bg-ground" aria-hidden="true" />
                ) : null}
              </span>
              <span className="text-right font-mono text-2xs tabular-nums text-ink">
                {item.value}
                {unit}
              </span>
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

export function StackBarDrawing({ segments }: { segments: StackSegment[] }) {
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
    // A 2px segment beside a 3px one is the same segment to the eye; zoomed
    // sixteen times it is not.
    minSpan: total / 16,
    describe: (i) =>
      `${segments[i].label}: ${segments[i].value}${sum ? ` · ${Math.round((segments[i].value / total) * 100)}%` : ''}`,
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
  const ticks = figure.zoomed ? valueTicks((low / total) * 100, (high / total) * 100, 3) : [];

  return (
    <FigureFrame
      name="StackBar"
      figure={figure}
      idle={sum ? `${sum} in all` : 'nothing counted'}
      readout={cursor !== null && segments[cursor] ? figure.sliderProps['aria-valuetext'] : null}
    >
      <div
        ref={bar}
        className="relative flex h-2.5 overflow-hidden rounded-full bg-track"
        role="img"
        aria-label={segments.map((s) => `${s.label} ${s.value}`).join(', ')}
      >
        {segments.map((segment, i) => (
          // `title` the ATTRIBUTE, not a `<title>` child: this bar is HTML, and
          // a `<title>` here is the HEAD element, parsed out of place.
          <span
            key={segment.label}
            data-datum={segment.label}
            data-value={segment.value}
            title={`${segment.label}: ${segment.value}`}
            className={cn('absolute inset-y-0', cursor === i && 'outline outline-1 outline-ink')}
            style={{
              left: `${pct(starts[i] - low)}%`,
              width: `${pct(segment.value)}%`,
              background: toneVar(segment.tone),
            }}
          />
        ))}
      </div>
      {ticks.length ? (
        <div className="relative mt-0.5 h-3 text-[9px] text-ink-faint" aria-hidden="true">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute -translate-x-1/2 tabular-nums"
              style={{ left: `${pct((tick / 100) * total - low)}%` }}
            >
              {tick}%
            </span>
          ))}
        </div>
      ) : null}
    </FigureFrame>
  );
}
