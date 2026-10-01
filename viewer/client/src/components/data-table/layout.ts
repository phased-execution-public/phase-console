/**
 * The table's LAYOUT — which columns fit, which fold, how wide each is laid out,
 * where the pinned rail sits, and whether the wrapper has to scroll.
 *
 * Moved here from `components/ui/table.tsx` by control-tower phase 18, unchanged
 * in behaviour: that file keeps the primitives (`TableWrap`, `Table`, the cells
 * and the two sticky class lists), and this one keeps the arithmetic every
 * table built on them shares — `DataTable` and the hand-rolled tables alike
 * (`features/runs/phase-table.tsx`, `fleet-table.tsx`, `plans/route-tab.tsx`,
 * `repo/graph-section.tsx`, `run-setup/per-phase.tsx`, `components/charts.tsx`).
 * Read `ui/table.tsx`'s header before changing anything here: the conditional
 * scroll wrapper and the sticky rules are one decision with this file's
 * `useTableFit`, and neither half may be changed alone.
 *
 * Nothing here imports the table engine. The engine (`engine.ts`) is loaded on
 * demand; the layout is on every table's path, so it stays plain.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** The three filters a column can offer (`Column.filter`). */
export type FilterKind = 'text' | 'facet' | 'range';

/**
 * A filter's value, by kind: the text typed; the facet values kept; the range's
 * two ends, either of which may be open. An empty one is never stored.
 */
export type FilterValue = string | string[] | [number | null, number | null];

/** A missing value, as a filter, a facet and a group heading all see it. */
export const NO_VALUE = '';

/**
 * More records than this and a table that asked for `virtual` draws only a
 * window of them. Below it every row is in the DOM, as it always was: a
 * window costs a measurement per row and a scroll listener, which buys
 * nothing on a list that fits a few screens.
 */
export const VIRTUAL_FROM = 150;

/* ------------------------------------------------------------------------- *
 * Column definitions — one source, three renderings
 *
 * A table used to be written three times: the wide one, whatever a phone got,
 * and the hand-written card list beside it. `FleetCards` and `PhasesTab` were
 * both born that way, and the nine tables with no card list at all are what
 * happens when writing the third copy is expensive. A column knows its own
 * head, its own cell, how badly it is needed and what a card should do with
 * it, so all three renderings come from the same array.
 * ------------------------------------------------------------------------- */

export interface Column<T> {
  id: string;
  /** Plain words. `THead` owns the casing — do not pre-uppercase. */
  head: string;
  cell: (row: T) => ReactNode;
  /**
   * How hard this column fights to stay on screen. `1` is never dropped;
   * anything higher is folded into the row's detail, smallest first, until
   * what is left fits. Default `3`.
   */
  priority?: number;
  /** Roughly the narrowest this column reads at, in px. Drives the cut. */
  min?: number;
  align?: 'start' | 'end';
  /**
   * An explicit track under fixed layout. Defaults to `min`.
   *
   * Declaring one number per column and laying out on a different one is how
   * the cut and the layout come to disagree — the cut said ten columns fit and
   * the layout then drew them 360px wider than the box.
   */
  width?: string;
  /**
   * The column that absorbs whatever is left over. Exactly one per table.
   *
   * Under `table-fixed` a column with no declared width takes the remainder,
   * which is what the identity-bearing text column wants: everything else is
   * a chip, a number or a date and knows its own size.
   */
  flex?: true;
  /** The one column that says WHICH RECORD this is. Pins left when scrolling. */
  identity?: true;
  /** What the card rendering does with it. Default: a labelled row. */
  card?: 'title' | 'meta' | 'hide';
  /**
   * Extra classes for this column's `<td>`, and only for the `<td>`.
   *
   * It exists for one thing: vertical alignment. A column whose cell is two
   * stacked lines (a slug over its detail sentence) reads as `align-top` beside
   * one-line neighbours, and `TD`'s default `align-middle` centres it against
   * them. That is a per-column fact and there was nowhere to say it.
   *
   * It is NOT a hole in the declared track. `whitespace-nowrap` here is the
   * mechanism this phase spent its structural half removing — a cell that
   * refuses to wrap does not widen its column under `table-fixed`, it escapes
   * it, and `useTableFit` then flips the whole table to scroll mode and drops
   * the sticky header for the sake of one chip. Widen the `min` instead.
   * `styles/touch.test.ts` pins that ban.
   */
  cellClassName?: string;
  /** Offer this column as a sort in the header. */
  sort?: { id: string; dir: 'ascending' | 'descending' };
  /**
   * The column's datum as a plain value — what a filter tests, a facet counts
   * and a group heading names. `cell` renders; this is what the cell MEANS.
   *
   * A column without one can still be shown, folded and hidden; it can never
   * be filtered or grouped by, because a rendered node is not a value anyone
   * can compare (the library's own warning: never filter renderer output).
   */
  value?: (row: T) => string | number | null | undefined;
  /**
   * Offer a filter for this column in the table's toolbar — `text` (the value
   * contains what was typed), `facet` (the value is one of those ticked, each
   * listed with its count) or `range` (a number between two ends). Needs
   * `value`, and the table's `toolbar`.
   */
  filter?: FilterKind;
  /** Offer this column in the toolbar's "Group by". Needs `value`. */
  groupable?: boolean;
  /**
   * What a group heading SAYS for one of this column's values. Default: the
   * value itself. A column whose values are ids (`needs-you`) says their words
   * (`Needs you`) here — the id stays what a filter tests and a fold stores.
   */
  groupLabel?: (value: string | number) => string;
  /**
   * Where a group sits among its siblings, lowest first. Default: the order the
   * rows first carry each value in. A column whose groups have a READING order
   * (needs-you before done) says it here, so the order does not depend on how
   * the caller happened to sort its rows.
   */
  groupOrder?: (value: string | number) => number;
  /**
   * Whether the operator may hide this column from the View panel. Default: every
   * column but the identity, which carries the row's own toggle.
   *
   * Hiding is not deleting. A hidden column joins the FOLDED columns — counted
   * on the row's `+N` and listed in its detail under its own head — so the
   * datum is always one press away (design law: no datum removed).
   */
  hideable?: boolean;
}

/** Whether the View panel offers this column. The identity never: it holds the row's toggle. */
export const canHide = <T>(c: Column<T>): boolean => !c.identity && c.hideable !== false;

/** What a column costs when nothing says otherwise. */
const DEFAULT_MIN = 104;
const NUMERIC_MIN = 76;
/**
 * Room the fold affordance itself needs inside the identity cell. The cut
 * reserves it, and the grid lays it out ON the identity column — a narrow
 * identity with no room of its own split a two-digit phase number over two
 * lines beside its `+12` (control-tower phase 23).
 */
export const FOLD_AFFORDANCE = 40;
/** Rounding, not overflow — see `useTableFit`. */
const SUBPIXEL_SLACK = 6;
/**
 * A classic scrollbar, and the width change the cut must NOT react to.
 *
 * The loop, measured with "always show scrollbars" on: unfolding a column makes
 * the page taller, `<main>` gains its vertical scrollbar, every box inside it
 * loses ~15 px, the cut folds the column back, the page shortens, the scrollbar
 * goes, the width returns. Six pixels of sub-pixel slack cannot cover a
 * scrollbar, so the width itself is held still across a band that wide.
 */
const SCROLLBAR_SLACK = 18;

const minOf = <T>(c: Column<T>): number => c.min ?? (c.align === 'end' ? NUMERIC_MIN : DEFAULT_MIN);

/**
 * The track a column will actually be LAID OUT on, as a number.
 *
 * The cut used to budget `min` while `HeadCell` laid out on `width ?? min`, so
 * a column that declared a wide fixed track was budgeted at its narrow one and
 * the cut came out over-optimistic by the difference — the arithmetic said ten
 * columns fit and the layout then drew them past the edge. One resolution, used
 * by both. A `width` this cannot read as a length (a percentage, a `calc`) is
 * budgeted at `min`, which is the safe direction: it is the number the column
 * promised it can be read at.
 */
export const trackOf = <T>(c: Column<T>): number => {
  const declared = c.width?.trim().match(/^(\d+(?:\.\d+)?)(px|rem|em)?$/);
  if (!declared) return minOf(c);
  const value = Number(declared[1]);
  return declared[2] === 'rem' || declared[2] === 'em' ? value * 16 : value;
};

/**
 * The pinned rail is a RUN of columns, not one column — and this says how wide.
 *
 * `left-0` in `stickyIdentityCell` is only right for the FIRST pinned column. A
 * table whose identity is column two — the issues board, where a 40 px pick box
 * comes first, and the delivery ledger, where the timestamp does — pinned the
 * identity to the left edge and let the checkbox slide away underneath it, so
 * the row being ticked and the tick being pressed were two different rows.
 * Everything up to and including the identity column travels together, each
 * offset by the tracks in front of it. The offset is an INLINE `left`, which
 * beats the `left-0` utility on specificity and so needs no second class.
 *
 * The rail is refused when it would eat more than `MAX_RAIL` of the box: a
 * pinned run wider than the scrolling remainder is not a rail, it is a table
 * that cannot be scrolled. Then only the identity column pins, as before.
 */
const MAX_RAIL = 0.5;

export function railOffsets<T>(
  shown: Column<T>[],
  identity: Column<T> | undefined,
  boxWidth: number,
): Map<string, number> {
  const offsets = new Map<string, number>();
  const last = identity ? shown.indexOf(identity) : -1;
  if (last < 0) return offsets;
  let x = 0;
  for (let i = 0; i <= last; i++) {
    offsets.set(shown[i].id, x);
    x += trackOf(shown[i]);
  }
  // `x` is now the whole rail's width. Too wide to be one, and only the
  // identity pins — at zero, because nothing travels in front of it.
  if (boxWidth > 0 && x > boxWidth * MAX_RAIL) {
    offsets.clear();
    offsets.set(shown[last].id, 0);
  }
  return offsets;
}

/**
 * Which columns fit, and which fold.
 *
 * Pure, so it is testable without a layout engine — jsdom computes no styles,
 * which is why every other size promise in this client is asserted as source
 * text. This one can be asserted as arithmetic instead.
 *
 * Priority 1 is kept whatever happens: a table that has dropped the column
 * naming the record is not a narrower table, it is a different one. When even
 * those do not fit, the wrapper scrolls and the identity column pins.
 */
export function planColumns<T>(
  columns: Column<T>[],
  width: number,
  /**
   * `folding`: something folds whatever this cut decides — the operator hid a
   * column — so the fold affordance is owed its room even when every column
   * offered here would fit. Absent, the cut is exactly what it always was.
   */
  options: { folding?: boolean } = {},
): { shown: Column<T>[]; folded: Column<T>[] } {
  const essential = columns.filter((c) => (c.priority ?? 3) === 1);
  const rest = columns.filter((c) => (c.priority ?? 3) !== 1);
  // Unmeasured (width 0, first paint, jsdom) shows everything rather than
  // flashing a folded table and unfolding it a frame later. Showing everything
  // is only safe because the WRAPPER is told the same thing and scrolls — a
  // full-width table in a wrapper that does not is a table with columns off the
  // edge and no way to reach them (`DataTable`, `useTableFit().measured`).
  if (width <= 0) return { shown: columns, folded: [] };

  let used = essential.reduce((n, c) => n + trackOf(c), 0);
  const keep = new Set(essential.map((c) => c.id));
  // Cheapest-to-keep first: by priority, then by declaration order.
  const queue = rest
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.priority ?? 3) - (b.c.priority ?? 3) || a.i - b.i);

  for (const { c } of queue) {
    const next = used + trackOf(c);
    // Leave room for the fold affordance while anything is still unplaced.
    const budget = keep.size + 1 === columns.length && !options.folding ? width : width - FOLD_AFFORDANCE;
    if (next > budget) continue;
    used = next;
    keep.add(c.id);
  }

  return {
    shown: columns.filter((c) => keep.has(c.id)),
    folded: columns.filter((c) => !keep.has(c.id)),
  };
}

/**
 * The wrapper's inner width, and whether the table currently overflows it.
 *
 * Measured, never assumed: the cards above a table grow as their own queries
 * land, and the rail appears and disappears at 900px. A `ResizeObserver` on
 * both boxes is the same technique the departures board already uses to keep
 * its virtualizer's `scrollMargin` honest.
 *
 * ## What it does NOT do
 *
 * It used to feed the measured overflow back as a penalty on the next cut, to
 * catch a column that had under-declared what it needs. That was a stateful
 * correction for a problem the declared numbers should own, and it had its own
 * failure: immediately after a resize the table is still laid out for the OLD
 * width, so the first measurement at 390px reported a table a thousand pixels
 * over, and the remembered penalty then held the budget down for the rest of
 * that width. The columns' own `min` values are measured against real content
 * instead, and `overflows` is the honest fallback when they are still wrong.
 *
 * ## Three things it now says that it did not
 *
 * **`measured`.** Zero is not a width, it is "not yet" — the state before the
 * first commit, a `<details>` that is closed, jsdom forever. It used to be
 * reported as a width of 0, which every caller then read as "everything fits",
 * so the one arrangement that can silently hide a column was also the default.
 *
 * **Hysteresis, twice.** The width is held still across a scrollbar's width
 * (`SCROLLBAR_SLACK`), because the page's own scrollbar appearing is not a
 * resize the cut may react to — reacting is what made the fold/unfold loop.
 * And `overflows` enters on `SUBPIXEL_SLACK` but leaves only at zero: inside a
 * scrolling wrapper the table is stretched to the box, so "it would fit now" is
 * exactly `scrollWidth <= clientWidth` and nothing looser.
 *
 * **Nothing detached stays observed.** A `ResizeObserver` holds its targets, so
 * a table that unmounted while the hook lived on — a tab switch, a row group
 * collapsing — kept both the node and its callback alive.
 */
export function useTableFit(): {
  wrapRef: (node: HTMLDivElement | null) => void;
  tableRef: (node: HTMLTableElement | null) => void;
  width: number;
  overflows: boolean;
  /** Whether `width` came from a real box. Until it does, assume overflow. */
  measured: boolean;
} {
  const wrap = useRef<HTMLDivElement | null>(null);
  const table = useRef<HTMLTableElement | null>(null);
  const [state, setState] = useState({ width: 0, overflows: false, measured: false });

  const measure = useCallback(() => {
    const box = wrap.current;
    if (!box) return;
    const raw = box.clientWidth;
    /*
     * A few pixels of slack. Sub-pixel widths round once per column, so nine
     * columns routinely land three pixels over a box they fit inside — and
     * three pixels is not a hidden column, it is arithmetic. Treating it as
     * overflow costs a scrollbar and, worse, the sticky header.
     */
    const over = table.current ? table.current.scrollWidth - raw : 0;
    setState((prev) => {
      const measured = raw > 0;
      // The reported width moves only on a change bigger than a scrollbar, so
      // the page's scrollbar coming and going cannot re-cut the columns. A
      // first measurement and a box that has gone away are always taken.
      const width =
        !prev.measured || !measured || Math.abs(raw - prev.width) > SCROLLBAR_SLACK ? raw : prev.width;
      const overflows = prev.overflows ? over > 0 : over > SUBPIXEL_SLACK;
      if (prev.width === width && prev.overflows === overflows && prev.measured === measured) return prev;
      return { width, overflows, measured };
    });
  }, []);

  const observer = useRef<ResizeObserver | null>(null);
  const observe = useCallback(
    (node: Element | null, slot: 'wrap' | 'table') => {
      const slotRef = slot === 'wrap' ? wrap : table;
      const previous = slotRef.current;
      if (previous && previous !== node) observer.current?.unobserve(previous);
      slotRef.current = node as (HTMLDivElement & HTMLTableElement) | null;
      if (typeof ResizeObserver === 'undefined') {
        measure();
        return;
      }
      if (!observer.current) observer.current = new ResizeObserver(measure);
      if (node) observer.current.observe(node);
      measure();
    },
    [measure],
  );

  /*
   * After every commit, before the browser paints. The cut changes the table's
   * width, which changes the answer — settling that in a layout effect is what
   * keeps the resolved arrangement from being one painted frame behind, and the
   * `ResizeObserver` (which fires after paint) from being the thing that
   * discovers it.
   */
  useLayoutEffect(measure);

  useEffect(() => () => observer.current?.disconnect(), []);

  const wrapRef = useCallback((node: HTMLDivElement | null) => observe(node, 'wrap'), [observe]);
  const tableRef = useCallback((node: HTMLTableElement | null) => observe(node, 'table'), [observe]);

  return {
    wrapRef,
    tableRef,
    width: state.width,
    overflows: state.overflows,
    measured: state.measured,
  };
}
