/**
 * The grid's engine — the ONE file that imports `@tanstack/react-table`.
 *
 * ## What it is for, and what it is not
 *
 * TanStack Table is used for its ROW MODEL and nothing else: which records
 * survive the filters, what each filterable column's values are and how many
 * rows carry each (the facets), how the records fall into groups, and which of
 * them are picked. It renders nothing. The markup, the column cut, the pinned
 * rail, the sticky header and the phone's card list are this client's own
 * (`layout.ts`, `data-table.tsx`, `card-list.tsx`) — measured, guarded by
 * `styles/touch.test.ts`, and not up for replacement by a library's idea of a
 * table.
 *
 * The v9 API is used DIRECTLY — `useTable({ features, … })` with the features
 * registered explicitly below — not through `./legacy`. Only what the grid
 * uses is registered, which is the whole point of v9's feature slots: sorting
 * stays the caller's (`activeSort`/`onSort`), expansion is the grid's own
 * `collapsed` list, and pagination does not exist here.
 *
 * ## Why it is its own module, loaded on demand
 *
 * `components/ui` is ONE modulepreloaded chunk, and first paint is gated at
 * 200 KB served (`viewer/scripts/check-dist.mjs`). A table with no filter, no
 * grouping, no selection and no window needs none of this, and most tables
 * are that table — so `data-table.tsx` reaches this file through `import()`
 * only when a table asks for a feature, and renders the plain rows until it
 * lands. `check-dist` finds whichever chunk carries the library by content and
 * fails if the document preloads it or a route reaches it by a static import.
 * ESLint's `no-restricted-imports` (`viewer/eslint.config.js`) is what keeps
 * this the only importer.
 *
 * The virtualizer (`@tanstack/react-virtual`) rides here too: a windowed body
 * is a feature a table asks for, like any other.
 */

import {
  columnFacetingFeature,
  columnFilteringFeature,
  columnGroupingFeature,
  createColumnHelper,
  createFacetedMinMaxValues,
  createFacetedRowModel,
  createFacetedUniqueValues,
  createFilteredRowModel,
  createGroupedRowModel,
  rowSelectionFeature,
  tableFeatures,
  useTable,
  type ColumnFiltersState,
  type FilterFn,
  type Row,
  type RowSelectionState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NO_VALUE, type Column, type FilterValue } from './layout';

/*
 * Stable, and module-level: a new features object per render would invalidate
 * every memoised row model on every render (the library's own warning).
 */
const features = tableFeatures({
  columnFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  columnFacetingFeature,
  facetedRowModel: createFacetedRowModel(),
  facetedUniqueValues: createFacetedUniqueValues(),
  facetedMinMaxValues: createFacetedMinMaxValues(),
  columnGroupingFeature,
  groupedRowModel: createGroupedRowModel(),
  rowSelectionFeature,
});

type Features = typeof features;
/*
 * The library types a row as an object (`RowData`); the grid's `T` is whatever
 * a caller's rows are, which is always an object in practice and never proven
 * so by the type. This says it once, here, rather than constraining every
 * `DataTable<T>` in the client.
 */
type Datum<T> = T & Record<string, unknown>;
type GridRow<T> = Row<Features, Datum<T>>;

/** What a column's `value` reads as to the engine: a string, a number, or nothing. */
const datum = <T>(column: Column<T>, row: T): string | number => {
  const value = column.value?.(row);
  return value == null ? NO_VALUE : value;
};

/*
 * The three filters a column can ask for (`Column.filter`). Each is handed its
 * own value shape, and an EMPTY value is never stored (`useTableView` drops it), so
 * none of these has to treat "no filter" as a case.
 */
const textFilter = (row: GridRow<unknown>, id: string, wanted: unknown): boolean =>
  String(row.getValue(id)).toLocaleLowerCase().includes(String(wanted).toLocaleLowerCase());

const facetFilter = (row: GridRow<unknown>, id: string, wanted: unknown): boolean =>
  Array.isArray(wanted) && wanted.includes(String(row.getValue(id)));

const rangeFilter = (row: GridRow<unknown>, id: string, wanted: unknown): boolean => {
  const [min, max] = wanted as [number | null, number | null];
  const value = row.getValue(id);
  // A row with no number is outside every range someone typed: a filter that
  // let blanks through would answer "cost over $10" with rows that have none.
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return (min == null || value >= min) && (max == null || value <= max);
};

const FILTERS = { text: textFilter, facet: facetFilter, range: rangeFilter } as const;

/** One item the grid draws, in display order. */
export type GridItem<T> =
  | { kind: 'row'; key: string; row: T; index: number }
  | {
      kind: 'group';
      /** `${columnId}:${value}` — the id `view.collapsed` stores. */
      key: string;
      column: string;
      value: string | number;
      /** Records in the group, folded or not. */
      count: number;
      /** The keys of the records it holds, in order — what a heading controls. */
      rows: string[];
      open: boolean;
    };

export interface Facet {
  /** Every value the column holds under the OTHER active filters, with its count. */
  values: { value: string; count: number }[];
  /** The numeric span, for a `range` filter; null when nothing is a number. */
  range: [number, number] | null;
}

export interface RowModel<T> {
  items: GridItem<T>[];
  /** Records that survive the filters (group headings not counted). */
  shown: number;
  /**
   * The records themselves, in order — folded groups' included, since a fold
   * hides a record from the eye, not from the filters. What a table's
   * `summary` is given, so a total above the rows counts exactly these.
   */
  kept: T[];
  /** Records before the filters. */
  total: number;
  facet: (columnId: string) => Facet;
  /** The picked records that are in the data AND survive the filters, in display order. */
  picked: T[];
  isPicked: (key: string) => boolean;
  /** Pick or drop one record by key. */
  toggle: (key: string) => void;
  /** Every record shown is picked (`all`), some are (`some`), or none (`none`). */
  pickedShown: 'all' | 'some' | 'none';
  /** Pick every record shown, or — when all already are — drop them. */
  toggleShown: () => void;
  clearPicked: () => void;
}

export interface RowModelInput<T> {
  rows: readonly T[];
  columns: Column<T>[];
  getRowKey: (row: T, index: number) => string;
  filters: Record<string, FilterValue>;
  groupBy: string | null;
  collapsed: readonly string[];
  selectable: boolean;
}

const EMPTY_SELECTION: RowSelectionState = {};

export function useRowModel<T>(input: RowModelInput<T>): RowModel<T> {
  const { rows, columns, getRowKey, filters, groupBy, collapsed, selectable } = input;
  const [selection, setSelection] = useState<RowSelectionState>(EMPTY_SELECTION);

  const helper = useMemo(() => createColumnHelper<Features, Datum<T>>(), []);
  /*
   * Only the columns with a `value` are the engine's business — a column
   * without one can be shown, folded and hidden, never filtered or grouped by.
   * Keyed by the columns' ids and kinds rather than the array's identity, so a
   * caller that builds its columns inline does not rebuild the row model on
   * every render.
   */
  const signature = columns
    .map((c) => `${c.id}:${c.filter ?? ''}:${c.groupable ? 'g' : ''}:${c.value ? 'v' : ''}`)
    .join('|');
  const latest = useRef(columns);
  latest.current = columns;
  const defs = useMemo(
    () =>
      helper.columns(
        latest.current
          .filter((c) => c.value)
          .map((c) =>
            helper.accessor((row: Datum<T>) => datum(latest.current.find((x) => x.id === c.id) ?? c, row), {
              id: c.id,
              enableColumnFilter: Boolean(c.filter),
              enableGrouping: Boolean(c.groupable),
              filterFn: (c.filter ? FILTERS[c.filter] : textFilter) as FilterFn<Features, Datum<T>>,
            }),
          ),
      ),
    // `signature` is the columns' shape; `latest` is read through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [helper, signature],
  );
  const known = useMemo(() => new Set(defs.map((d) => d.id)), [defs]);

  const columnFilters = useMemo<ColumnFiltersState>(
    () =>
      Object.entries(filters)
        .filter(([id]) => known.has(id))
        .map(([id, value]) => ({ id, value })),
    [filters, known],
  );
  const grouping = useMemo(() => (groupBy && known.has(groupBy) ? [groupBy] : []), [groupBy, known]);
  const keyOf = useRef(getRowKey);
  keyOf.current = getRowKey;

  const table = useTable<Features, Datum<T>>({
    features,
    columns: defs,
    data: rows as Datum<T>[],
    getRowId: (row, index) => keyOf.current(row, index),
    state: { columnFilters, grouping, rowSelection: selection },
    // The view owns filters and grouping (`useTableView`, kept by `tableId`);
    // the library never changes them on its own, so its callbacks have nothing
    // to write back. Selection is the engine's own state.
    onColumnFiltersChange: () => {},
    onGroupingChange: () => {},
    onRowSelectionChange: (updater) =>
      setSelection((previous) => (typeof updater === 'function' ? updater(previous) : updater)),
    enableRowSelection: selectable,
    enableSubRowSelection: false,
    groupedColumnMode: false,
  });

  /*
   * Keyed on the library's own row models, never on `table`: the adapter hands
   * back a fresh table reference whenever it renders, and the model this hook
   * returns is handed UP to the grid through a layout effect — keyed on
   * `table`, it would be new every render and hand itself up forever. The row
   * models are memoised by the library on their real inputs (the data, the
   * filters, the grouping), so they move exactly when the answer does.
   */
  const live = useRef(table);
  live.current = table;
  const filtered = table.getFilteredRowModel().rows;
  const grouped = grouping.length ? table.getGroupedRowModel().rows : null;
  const shut = useMemo(() => new Set(collapsed), [collapsed]);

  const items = useMemo<GridItem<T>[]>(() => {
    const out: GridItem<T>[] = [];
    const push = (row: GridRow<T>) =>
      out.push({ kind: 'row', key: row.id, row: row.original, index: row.index });
    if (!grouping.length) {
      for (const row of filtered) push(row);
      return out;
    }
    const column = grouping[0]!;
    const rank = latest.current.find((c) => c.id === column)?.groupOrder;
    const groups = rank
      ? [...(grouped ?? [])].sort(
          (a, b) => rank(a.groupingValue as string | number) - rank(b.groupingValue as string | number),
        )
      : (grouped ?? []);
    for (const group of groups) {
      if (!group.getIsGrouped()) {
        push(group);
        continue;
      }
      const value = group.groupingValue as string | number;
      const key = `${column}:${value}`;
      const leaves = group.getLeafRows().filter((r) => !r.getIsGrouped());
      const open = !shut.has(key);
      out.push({
        kind: 'group',
        key,
        column,
        value,
        count: leaves.length,
        rows: leaves.map((r) => r.id),
        open,
      });
      if (open) for (const leaf of leaves) push(leaf);
    }
    return out;
  }, [filtered, grouped, grouping, shut]);

  const picked = useMemo(() => {
    if (!selectable) return [];
    const byKey = new Set(Object.keys(selection).filter((k) => selection[k]));
    return filtered.filter((row) => byKey.has(row.id)).map((row) => row.original);
  }, [filtered, selection, selectable]);

  const shownKeys = useMemo(() => filtered.map((row) => row.id), [filtered]);
  const kept = useMemo(() => filtered.map((row) => row.original), [filtered]);
  const pickedCount = selectable ? shownKeys.filter((k) => selection[k]).length : 0;
  const pickedShown = pickedCount === 0 ? 'none' : pickedCount === shownKeys.length ? 'all' : 'some';

  // Read through `live`, re-made whenever the filtered rows move: a facet is
  // the other filters' answer, so that is exactly when its counts change.
  const facet = useCallback(
    (id: string): Facet => {
      const column = live.current.getColumn(id);
      if (!column) return { values: [], range: null };
      const values = [...column.getFacetedUniqueValues().entries()]
        .map(([value, count]) => ({ value: String(value), count: Number(count) }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
      const span = column.getFacetedMinMaxValues();
      const range =
        span && Number.isFinite(span[0]) && Number.isFinite(span[1])
          ? ([span[0], span[1]] as [number, number])
          : null;
      return { values, range };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered],
  );

  const toggle = useCallback(
    (key: string) =>
      setSelection((previous) => {
        const next = { ...previous };
        if (next[key]) delete next[key];
        else next[key] = true;
        return next;
      }),
    [],
  );

  const toggleShown = useCallback(
    () =>
      setSelection((previous) => {
        const next = { ...previous };
        const every = shownKeys.every((k) => next[k]);
        for (const k of shownKeys) {
          if (every) delete next[k];
          else next[k] = true;
        }
        return next;
      }),
    [shownKeys],
  );

  const clearPicked = useCallback(() => setSelection(EMPTY_SELECTION), []);
  const isPicked = useCallback(
    (key: string) => Boolean(selectable && selection[key]),
    [selectable, selection],
  );

  // One object per change, not per render: the grid memoises its columns and
  // its cut on this, and a fresh object every render would recompute both.
  return useMemo(
    () => ({
      items,
      shown: filtered.length,
      kept,
      total: rows.length,
      facet,
      picked,
      isPicked,
      toggle,
      pickedShown,
      toggleShown,
      clearPicked,
    }),
    [
      items,
      filtered.length,
      kept,
      rows.length,
      facet,
      picked,
      isPicked,
      toggle,
      pickedShown,
      toggleShown,
      clearPicked,
    ],
  );
}

/* ------------------------------------------------------------------------- *
 * The window
 * ------------------------------------------------------------------------- */

const OVERSCAN = 8;

export interface WindowInput {
  count: number;
  enabled: boolean;
  /**
   * The element whose top is the window's origin — the table's first body, or
   * the card list — once the grid has drawn it. An element, never a ref: the
   * grid draws it only after this window has come up, and an effect that read
   * a ref found it empty and never looked again.
   */
  anchor: HTMLElement | null;
  estimate: number;
  keyAt: (index: number) => string;
}

export interface VirtualWindow {
  /** The indexes to draw, in order — every one of them when the window is off. */
  indexes: number[];
  padTop: number;
  padBottom: number;
  /** The ref each drawn item takes, so it is measured as it lands. */
  measure: (node: Element | null) => void;
}

const noMeasure = () => {};

/**
 * A window over the shell's ONE scroller — `<main>` — never a scroller of the
 * table's own. The reasons are `features/plans/route-tab.tsx`'s, which did it
 * first: `TableWrap` may never carry a max-height (a height-capped wrapper is
 * a second vertical scroller that eats the page's flick), and a header that
 * sticks to `<main>` is the one that works. So the rows stay in page flow and
 * two spacers of computed height stand in for the ones not drawn.
 *
 * `scrollMargin` is measured from the two rects and re-measured by a
 * `ResizeObserver`, because everything above the table changes height as its
 * own queries land; and the virtualizer is seeded with an offset and a height
 * so its first render already has a window rather than none. A margin never
 * measured is a window placed for a table at the scroller's top edge — its
 * rows drawn below the fold, a band of bare spacer under the header.
 */
export function useWindow({ count, enabled, anchor, estimate, keyAt }: WindowInput): VirtualWindow {
  const scroller = useRef<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  const getScrollElement = useCallback(() => {
    if (!scroller.current) {
      const main = document.querySelector('main');
      scroller.current =
        main instanceof HTMLElement ? main : (document.scrollingElement as HTMLElement | null);
    }
    return scroller.current;
  }, []);

  useEffect(() => {
    if (!enabled || !anchor) return;
    const box = getScrollElement();
    if (!box) return;
    const measure = () => {
      const top = anchor.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      setScrollMargin((previous) => (Math.abs(previous - top) > 1 ? top : previous));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    // Content landing above the table moves it without resizing the scroller
    // or the origin — but it resizes a box that holds both, so every box from
    // the origin up to the scroller is watched.
    const observer = new ResizeObserver(measure);
    for (let node: Element | null = anchor; node && node !== box; node = node.parentElement) {
      observer.observe(node);
    }
    observer.observe(box);
    return () => observer.disconnect();
  }, [anchor, enabled, getScrollElement, count]);

  const virtualizer = useVirtualizer({
    count,
    enabled,
    getScrollElement,
    estimateSize: () => estimate,
    overscan: OVERSCAN,
    getItemKey: keyAt,
    scrollMargin,
    initialOffset: () => getScrollElement()?.scrollTop ?? 0,
    initialRect: { width: 0, height: typeof window === 'undefined' ? 0 : window.innerHeight },
  });

  // The window is handed UP to the grid through a layout effect, so it must
  // be the same object until it moves — a fresh one every render would hand
  // itself up forever. The library keeps `getVirtualItems()` stable while the
  // range and the measurements hold, which is what this keys on.
  const drawn = enabled ? virtualizer.getVirtualItems() : null;
  const total = enabled ? virtualizer.getTotalSize() : 0;
  const measure = virtualizer.measureElement;
  return useMemo(() => {
    if (!drawn) {
      return {
        indexes: Array.from({ length: count }, (_, i) => i),
        padTop: 0,
        padBottom: 0,
        measure: noMeasure,
      };
    }
    const first = drawn[0];
    const last = drawn[drawn.length - 1];
    return {
      indexes: drawn.map((item) => item.index),
      padTop: first ? Math.max(0, first.start - scrollMargin) : 0,
      padBottom: last ? Math.max(0, total - (last.end - scrollMargin)) : 0,
      measure,
    };
  }, [drawn, total, count, scrollMargin, measure]);
}
