/**
 * The one axis primitive — every figure with an axis reads its ticks, its
 * pixel map and its zoom from here (control-tower phase 29, #32 gap 2).
 *
 * Before this file the Gantt had built an axis of its own (`ticksFor`, a round
 * unit ladder), `Bars` had none, and nothing could zoom. "One axis, not two"
 * is the whole brief: the run's time axis, the insights panels' figures and
 * Debug ▸ Timeline all ask the same three questions — where does this value
 * land, which values deserve a label, and what does the window show once a
 * person has zoomed — so they get one answer each.
 *
 * The linear map and the 1-2-5 value ticks come from `@visx/scale` (d3-scale
 * underneath); the duration ladder stays ours, because d3's time ticks label
 * wall-clock instants and this axis labels ELAPSED time ("15m", "2h"). The
 * zoom is a 1-D window over the data rather than `@visx/zoom`'s 2-D matrix —
 * see `viewer/docs/design.md` § Figures and marks for why.
 *
 * Nothing here names a colour, and nothing here imports React: a scale is
 * arithmetic, and the drawings own the paint.
 */

import { scaleLinear } from '@visx/scale';

/** A span of the axis's own units — `[low, high]`, low < high when it shows anything. */
export type AxisWindow = readonly [number, number];

/**
 * Elapsed-time steps a label may land on: 1, 5, 15, 30 seconds, 1, 5, 15, 30
 * minutes, 1, 2, 6, 12 hours, a day, a week. A span divided by six gives
 * labels like `10:23`, which nobody can line up against anything.
 */
export const DURATION_STEPS = Object.freeze([
  1_000,
  5_000,
  15_000,
  30_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  3_600_000,
  2 * 3_600_000,
  6 * 3_600_000,
  12 * 3_600_000,
  86_400_000,
  7 * 86_400_000,
] as const);

/**
 * Round-unit ticks inside a window of elapsed milliseconds, aiming for
 * `target` labels. A zoomed window that starts at 10:07 labels 10:10, never
 * 10:07 — the round unit is the point of the ladder.
 */
export function durationTicks(window: AxisWindow, target = 6): number[] {
  const [low, high] = window;
  const span = high - low;
  if (!(span > 0)) return [];
  const raw = span / target;
  const step = DURATION_STEPS.find((unit) => unit >= raw) ?? DURATION_STEPS[DURATION_STEPS.length - 1];
  const out: number[] = [];
  for (let at = Math.ceil(low / step) * step; at <= high; at += step) out.push(at);
  return out;
}

/** The ladder over `[0, spanMs]` — the Gantt's original question, kept by name. */
export function ticksFor(spanMs: number, target = 6): number[] {
  return durationTicks([0, spanMs], target);
}

/**
 * Ticks for a count or a dollar amount: 1-2-5 steps from `low`, covering
 * `high`. Nothing measured is one tick at zero, never an invented scale.
 */
export function valueTicks(low: number, high: number, target = 4): number[] {
  if (!(high > low)) return [low];
  const ticks = scaleLinear<number>({ domain: [low, high], nice: target }).ticks(target);
  if (ticks.length < 2) return ticks.length ? ticks : [low];
  // d3 prints the steps INSIDE the domain; a reader needs the label that
  // covers the maximum, so the ladder is carried one step past it rather than
  // leaving the tallest bar above the last number.
  const step = ticks[1] - ticks[0];
  while (ticks[ticks.length - 1] < high - step * 1e-9) {
    ticks.push(Number((ticks[ticks.length - 1] + step).toPrecision(12)));
  }
  return ticks;
}

/** A linear map from a window of the axis onto a pixel range, invertible. */
export function linear(window: AxisWindow, range: readonly [number, number]) {
  return scaleLinear<number>({ domain: [window[0], window[1]], range: [range[0], range[1]] });
}

/**
 * The window after zooming by `factor` (above 1 narrows) about `focus`.
 *
 * The focus keeps its relative place — the thing under the pointer stays under
 * the pointer, which is what makes a zoom feel like looking closer rather than
 * like being moved. Clamped to `bounds` (a zoom never shows what is not there)
 * and never narrower than `minSpan` (a figure says how close is still legible).
 */
export function zoomWindow(
  window: AxisWindow,
  factor: number,
  focus: number,
  bounds: AxisWindow,
  minSpan: number,
): AxisWindow {
  const [low, high] = window;
  const full = bounds[1] - bounds[0];
  if (!(full > 0) || !(factor > 0)) return [bounds[0], bounds[1]];
  const span = Math.min(full, Math.max(minSpan, (high - low) / factor));
  const at = Math.min(Math.max(focus, low), high);
  const share = high > low ? (at - low) / (high - low) : 0.5;
  return clampWindow(at - share * span, span, bounds);
}

/** The window moved by `delta` units, its span unchanged, clamped at both ends. */
export function panWindow(window: AxisWindow, delta: number, bounds: AxisWindow): AxisWindow {
  return clampWindow(window[0] + delta, window[1] - window[0], bounds);
}

/** How far in a window is: the full span over the window's span. 1 is not zoomed. */
export function zoomOf(window: AxisWindow, bounds: AxisWindow): number {
  const span = window[1] - window[0];
  return span > 0 ? (bounds[1] - bounds[0]) / span : 1;
}

function clampWindow(low: number, span: number, bounds: AxisWindow): AxisWindow {
  const start = Math.min(Math.max(low, bounds[0]), bounds[1] - span);
  return [start, start + span];
}
