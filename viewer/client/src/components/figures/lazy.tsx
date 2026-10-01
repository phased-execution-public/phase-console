/**
 * The door to the figures chunk — the only way anything reaches `./bars` or
 * `./run-chart` (control-tower phase 29).
 *
 * `charts.tsx` is on almost every destination (the Pulse draws a mark), so a
 * static import of a drawing from there would put visx in first paint. The
 * drawings are reached through `import()` here instead, and
 * `scripts/check-dist.mjs` asserts the chunk stays lazy: no static importer,
 * never modulepreloaded.
 *
 * Two things this file does that a bare `lazy()` would not:
 *
 *   - **A loaded chunk renders synchronously.** Once `loadFigures()` has
 *     resolved, a figure mounted later draws in its first render instead of
 *     flashing a placeholder — the second figure on a page never waits.
 *   - **A figure keeps the path it mounted with.** Switching a mounted figure
 *     from the `Suspense` path to the direct one would remount its drawing and
 *     drop its zoom and its keyboard focus, so the choice is made once.
 *
 * The placeholder has the drawing's height, so the numbers fold under a figure
 * does not jump when the picture arrives.
 */

import { createElement, lazy, Suspense, useState, type ComponentType } from 'react';

type Drawings = typeof import('./bars') & typeof import('./run-chart');

let loaded: Drawings | null = null;
let pending: Promise<Drawings> | null = null;

/** Fetch the figures chunk once. Resolves with the drawings; safe to call often. */
export function loadFigures(): Promise<Drawings> {
  pending ??= Promise.all([import('./bars'), import('./run-chart')]).then(([bars, run]) => {
    loaded = { ...bars, ...run };
    return loaded;
  });
  return pending;
}

function lazyFigure<Props extends object>(
  name: string,
  pick: (drawings: Drawings) => ComponentType<Props>,
  height: (props: Props) => number,
) {
  const Deferred = lazy(() => loadFigures().then((drawings) => ({ default: pick(drawings) })));
  function Figure(props: Props) {
    const [direct] = useState(() => loaded !== null);
    if (direct && loaded) return createElement(pick(loaded), props);
    return (
      <Suspense
        fallback={
          <div aria-busy="true" className="rounded-sm bg-track/40" style={{ height: height(props) }} />
        }
      >
        {createElement(Deferred, props)}
      </Suspense>
    );
  }
  Figure.displayName = `Lazy(${name})`;
  return Figure;
}

export const BarsFigure = lazyFigure(
  'Bars',
  (d) => d.BarsDrawing,
  (props) => props.height + 24,
);
export const CalendarFigure = lazyFigure(
  'Calendar',
  (d) => d.CalendarDrawing,
  () => 110,
);
export const BarListFigure = lazyFigure(
  'BarList',
  (d) => d.BarListDrawing,
  (props) => props.items.length * 22 + 24,
);
export const StackBarFigure = lazyFigure(
  'StackBar',
  (d) => d.StackBarDrawing,
  () => 34,
);
export const RunCostFigure = lazyFigure(
  'RunCost',
  (d) => d.RunCostChart,
  (props) => props.height,
);
