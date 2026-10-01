/**
 * What each attempt cost, on the run's own time axis (control-tower phase 29,
 * #32 gap 1's second half).
 *
 * The Gantt answers *when did each phase hold the lane*; nothing answered
 * *what did it cost to hold it*, although both were journalled. This strip is
 * that second answer, drawn under the lanes and sharing their window, their
 * crosshair and their "now" — one axis, two readings. A long bar and an
 * expensive bar can then be told apart at a glance, which is the question an
 * operator has at minute 40 of a phase.
 *
 * The dollar scale is its own (`valueTicks`), labelled inside the plot so the
 * strip lines up with the lanes above it to the pixel: an axis gutter here
 * would shift every window sideways from the bar it belongs to. An OPEN window
 * is drawn pale with a dashed edge — "spent so far" — for the same reason an
 * open lane is hatched.
 *
 * Reached only through `./lazy`. Paint is tokens only, and every window carries
 * `data-datum`/`data-value` so the numbers table under the Gantt is held to the
 * same rows (`figures/run-chart.test.tsx`).
 */

import { useRef } from 'react';
import { AxisLeft } from '@visx/axis';
import { Bar, Line } from '@visx/shape';

import type { TimelineSeriesPoint } from '@/lib/api';

import { AXIS_PAINT, useWidth } from './paint';
import { linear, valueTicks, type AxisWindow } from './scales';

/**
 * A dollar label as short as it can honestly be: `$5`, `$0.25`. Written here
 * rather than taken from `lib/format`: a shared module the entry also uses is
 * split into a chunk of its own by the bundler the moment a lazy chunk imports
 * it, and that chunk is preloaded — first paint grew by one for a formatter.
 */
export const dollars = (usd: number): string => (Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`);

export function RunCostChart({
  points,
  view,
  nowMs,
  cursorMs,
  height,
  describe,
}: {
  points: readonly TimelineSeriesPoint[];
  /** A window's tooltip, in the caller's words (it owns the duration format). */
  describe: (point: TimelineSeriesPoint) => string;
  /** The lanes' window — the same one, so the strip and the bars line up. */
  view: AxisWindow;
  nowMs?: number;
  cursorMs?: number | null;
  height: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box, 600);
  const max = Math.max(0, ...points.map((point) => point.value));
  const ticks = valueTicks(0, max, 2);
  const top = ticks[ticks.length - 1] || 1;
  const x = linear(view, [0, width]);
  const y = linear([0, top], [height - 1, 6]);
  const clampX = (px: number) => Math.min(width, Math.max(0, px));

  return (
    <div ref={box}>
      <svg
        data-figure="RunCost"
        viewBox={`0 0 ${width} ${height}`}
        height={height}
        className="block w-full overflow-hidden"
        role="img"
        aria-label={`Cost of each attempt on the run's time axis, the highest ${dollars(max)}`}
      >
        {ticks.slice(1).map((tick) => (
          <line
            key={tick}
            x1={0}
            x2={width}
            y1={y(tick)}
            y2={y(tick)}
            stroke="var(--rule)"
            strokeWidth={0.5}
            opacity={0.6}
          />
        ))}
        {points.map((point) => {
          const x0 = clampX(x(point.startMs));
          const x1 = clampX(x(point.endMs));
          const barTop = y(point.value);
          return (
            <Bar
              key={`${point.phase}-${point.attempt}`}
              data-datum={`p${point.phase} attempt ${point.attempt}`}
              data-value={point.value}
              x={x0}
              y={barTop}
              width={Math.max(x1 - x0, x1 > 0 && x0 < width ? 1.5 : 0)}
              height={Math.max(0, height - 1 - barTop)}
              className="state-running"
              fill="var(--state)"
              fillOpacity={point.open ? 0.3 : 0.65}
              stroke={point.open ? 'var(--state)' : 'none'}
              strokeDasharray={point.open ? '3 2' : undefined}
              strokeWidth={point.open ? 1 : 0}
            >
              <title>{describe(point)}</title>
            </Bar>
          );
        })}
        <AxisLeft
          left={0}
          scale={y}
          tickValues={ticks.slice(1)}
          hideAxisLine
          hideTicks
          tickFormat={(value) => dollars(Number(value))}
          {...AXIS_PAINT}
          tickLabelProps={{ ...AXIS_PAINT.tickLabelProps, textAnchor: 'start', dx: 3, dy: -2 }}
        />
        {nowMs !== undefined && nowMs >= view[0] && nowMs <= view[1] ? (
          <Line
            from={{ x: x(nowMs), y: 0 }}
            to={{ x: x(nowMs), y: height }}
            className="state-running"
            stroke="var(--state)"
            strokeDasharray="3 3"
            pointerEvents="none"
          />
        ) : null}
        {cursorMs != null && cursorMs >= view[0] && cursorMs <= view[1] ? (
          <Line
            from={{ x: x(cursorMs), y: 0 }}
            to={{ x: x(cursorMs), y: height }}
            stroke="var(--ink-muted)"
            strokeDasharray="2 2"
            pointerEvents="none"
          />
        ) : null}
      </svg>
    </div>
  );
}
