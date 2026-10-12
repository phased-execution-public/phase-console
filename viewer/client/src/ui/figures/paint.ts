/**
 * What every drawing in the figures chunk shares: the axis paint, the type
 * drawn inside an SVG and the room it takes, and a width.
 *
 * `@visx/axis` ships `#222` for the line, the ticks and the labels, and Arial
 * for the type. Both are exactly the "colour vocabulary to fight" the figures
 * refused a library's palette for (`./lazy`: a figure paints states, never
 * colours) — so no axis in this chunk is drawn without these props, and
 * `figures.test.tsx`'s literal-colour sweep is what notices one that is.
 */

import { createElement, useEffect, useState, type RefObject } from 'react';
import type { TickRendererProps } from '@visx/axis';

/**
 * The size of everything written INSIDE a figure's SVG — an axis's counts and
 * dollars, a week, a month, a duration, a moment's glyph — in px: the meta size
 * (`--text-meta`, 0.78125 rem), half a pixel over design law's 12 px floor
 * (design.md §2). An SVG reads no type scale of its own and is drawn in px, so
 * the size is a number, here, beside the room cut for it; `type.test.ts` holds
 * it to the theme's token and every `fontSize` in this folder to the floor.
 * Until quiet-console phase 27 the axes were set at 9 and the marks at 8.
 */
export const FIGURE_TYPE = 12.5;

/*
 * How far that type reaches, from Instrument Sans's own metrics (per em: a
 * capital or a numeral 0.72 tall, an ascender or a `$` about 0.75, the
 * descender 0.25; every numeral 0.6 wide, tabular), rounded OUT to whole
 * pixels. Every band and gutter a label is written in is cut from these, so a
 * label and its room move together: change the size, and every figure re-fits.
 */

/** A numeral's or a capital's height over its baseline. */
export const FIGURE_CAP = Math.ceil(FIGURE_TYPE * 0.72);
/** The tallest letter's reach over its baseline — a `d`, an `l`, a `$`. */
export const FIGURE_ASCENT = Math.ceil(FIGURE_TYPE * 0.8);
/** A descender's reach under it — a `p`, a `g`, a `y`. */
export const FIGURE_DESCENT = Math.ceil(FIGURE_TYPE * 0.25);
/** The band one line of labels is written in: the letters, and a pixel of air over and under. */
export const FIGURE_BAND = FIGURE_ASCENT + FIGURE_DESCENT + 2;

/** One character's advance, in ems, never under the font's own: `W` and `m` are the widest. */
const advance = (ch: string): number =>
  /\d/.test(ch) ? 0.6 : /[MWmw]/.test(ch) ? 1.1 : /[A-Z]/.test(ch) ? 0.8 : ch === ' ' ? 0.2 : 0.62;

/**
 * About how wide a label is drawn at `FIGURE_TYPE`, in px — never narrower than
 * it is (numerals exactly, anything else at the font's widest for its kind).
 * What a figure spaces its labels by, so two can never touch and none runs off
 * the drawing; nobody reads the estimate itself.
 */
export function textWidth(text: string): number {
  let ems = 0;
  for (const ch of text) ems += advance(ch);
  return Math.ceil(ems * FIGURE_TYPE);
}

/**
 * How a label centred on `at` is written so it stays inside `[0, width]`:
 * centred while it fits, held flush against the edge it would run past when it
 * does not. Spread into a visx tick label or an SVG `<text>`.
 */
export function inside(
  at: number,
  wide: number,
  width: number,
): { textAnchor: 'start' | 'middle' | 'end'; dx: number } {
  if (at + wide / 2 > width - 1) return { textAnchor: 'end', dx: width - 1 - at };
  if (at - wide / 2 < 1) return { textAnchor: 'start', dx: 1 - at };
  return { textAnchor: 'middle', dx: 0 };
}

/**
 * A tick label as a plain `<text>`. visx's own `Text` wraps every label in a
 * nested `<svg>` — an unnamed svg per tick, which is exactly what the chart
 * guard's "every svg is a named chart or decoration" rule exists to catch, and
 * a node per label nobody needed.
 */
function tickLabel({ formattedValue, ...props }: TickRendererProps) {
  return createElement('text', props, formattedValue);
}

/** Spread onto every `@visx/axis` component. Tokens only, and the figures' one type size. */
export const AXIS_PAINT = {
  tickComponent: tickLabel,
  stroke: 'var(--rule)',
  tickStroke: 'var(--rule)',
  tickLength: 3,
  tickLabelProps: {
    fill: 'var(--ink-faint)',
    fontSize: FIGURE_TYPE,
    fontFamily: 'inherit',
  },
} as const;

/**
 * The element's own width in CSS pixels, so an axis label is drawn at the size
 * it is read at rather than stretched by a `preserveAspectRatio="none"`
 * viewBox. `fallback` answers until the first measure — and always in jsdom,
 * which has no `ResizeObserver` and lays nothing out.
 */
export function useWidth(ref: RefObject<Element | null>, fallback: number): number {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const next = Math.round(node.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
