/**
 * What every drawing in the figures chunk shares: the axis paint and a width.
 *
 * `@visx/axis` ships `#222` for the line, the ticks and the labels, and Arial
 * for the type. Both are exactly the "colour vocabulary to fight" `charts.tsx`
 * refused a library for — so no axis in this chunk is drawn without these
 * props, and `charts.test.tsx`'s literal-colour sweep is what notices one that
 * is.
 */

import { createElement, useEffect, useState, type RefObject } from 'react';
import type { TickRendererProps } from '@visx/axis';

/**
 * A tick label as a plain `<text>`. visx's own `Text` wraps every label in a
 * nested `<svg>` — an unnamed svg per tick, which is exactly what the chart
 * guard's "every svg is a named chart or decoration" rule exists to catch, and
 * a node per label nobody needed.
 */
function tickLabel({ formattedValue, ...props }: TickRendererProps) {
  return createElement('text', props, formattedValue);
}

/** Spread onto every `@visx/axis` component. Tokens only. */
export const AXIS_PAINT = {
  tickComponent: tickLabel,
  stroke: 'var(--rule)',
  tickStroke: 'var(--rule)',
  tickLength: 3,
  tickLabelProps: {
    fill: 'var(--ink-faint)',
    fontSize: 9,
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
