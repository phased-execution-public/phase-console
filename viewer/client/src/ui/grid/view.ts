import { useCallback, useMemo, useState } from 'react';
import { getPrefs, usePrefs, type TableState } from '@/lib/prefs';
import type { Column } from './column';
import { canHide, type FilterValue } from './layout';

/**
 * What an operator made of one grid — its filters, the columns they hid, the
 * grouping and the groups they folded — kept by the grid's `tableId` in
 * `lib/prefs.ts` (`tables`), so a view somebody built is the one they meet on
 * the next visit. Without a `tableId` it lasts as long as the grid is mounted.
 *
 * What is stored is honoured only where it still names something real: a
 * column renamed or retired since the last visit is ignored, never an error.
 * Selection is deliberately not here — a pick is an intention about this
 * visit's rows (`TableState` says why).
 */
export interface GridView {
  filters: Record<string, FilterValue>;
  hidden: string[];
  groupBy: string | null;
  collapsed: string[];
  setFilter: (columnId: string, value: FilterValue | null) => void;
  setHidden: (columnId: string, hide: boolean) => void;
  setGroupBy: (columnId: string | null) => void;
  toggleGroup: (key: string) => void;
  clearFilters: () => void;
  /** Back to the grid's own defaults: no filters, nothing hidden, its own grouping. */
  reset: () => void;
}

const EMPTY_STATE: TableState = {};
/** One empty list, so a grid with nothing folded does not hand the engine a new one every render. */
const NONE: string[] = [];

/** A filter value that says nothing — never stored. */
export const isEmptyFilter = (value: FilterValue | null | undefined): boolean =>
  value == null ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0) ||
  (Array.isArray(value) && value.length === 2 && value[0] == null && value[1] == null);

export function useGridView<T>(
  tableId: string | undefined,
  columns: readonly Column<T>[],
  defaults: { groupBy?: string | undefined; collapsed?: readonly string[] | undefined } = {},
): GridView {
  const [prefs, setPrefs] = usePrefs();
  const [local, setLocal] = useState<TableState>(EMPTY_STATE);
  const stored = tableId ? (prefs.tables?.[tableId] ?? EMPTY_STATE) : local;
  const fallbackGroup = defaults.groupBy;
  const fallbackCollapsed = defaults.collapsed;

  const write = useCallback(
    (patch: (previous: TableState) => TableState) => {
      if (!tableId) {
        setLocal(patch);
        return;
      }
      // Read at write time, not from the render: two writes in one tick must
      // not have the second undo the first.
      const all = getPrefs().tables ?? {};
      setPrefs({ tables: { ...all, [tableId]: patch(all[tableId] ?? EMPTY_STATE) } });
    },
    [tableId, setPrefs],
  );

  const byId = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const filters = useMemo(() => {
    const out: Record<string, FilterValue> = {};
    for (const [id, value] of Object.entries(stored.filters ?? {})) {
      const column = byId.get(id);
      if (column?.filter && column.value && !isEmptyFilter(value)) out[id] = value;
    }
    return out;
  }, [stored.filters, byId]);
  const hidden = useMemo(
    () =>
      (stored.hidden ?? NONE).filter((id) => {
        const column = byId.get(id);
        return column ? canHide(column) : false;
      }),
    [stored.hidden, byId],
  );
  const wanted = stored.groupBy !== undefined ? stored.groupBy : (fallbackGroup ?? null);
  const groupColumn = wanted == null ? undefined : byId.get(wanted);
  const groupBy = groupColumn?.groupable && groupColumn.value ? groupColumn.id : null;
  const collapsed = (stored.collapsed ?? fallbackCollapsed ?? NONE) as string[];

  return useMemo<GridView>(
    () => ({
      filters,
      hidden,
      groupBy,
      collapsed,
      setFilter: (columnId, value) =>
        write((previous) => {
          const next = { ...(previous.filters ?? {}) };
          if (isEmptyFilter(value)) delete next[columnId];
          else next[columnId] = value as FilterValue;
          return { ...previous, filters: next };
        }),
      setHidden: (columnId, hide) =>
        write((previous) => {
          const without = (previous.hidden ?? NONE).filter((id) => id !== columnId);
          return { ...previous, hidden: hide ? [...without, columnId] : without };
        }),
      setGroupBy: (columnId) => write((previous) => ({ ...previous, groupBy: columnId })),
      toggleGroup: (key) =>
        write((previous) => {
          const shut = previous.collapsed ?? fallbackCollapsed ?? NONE;
          return {
            ...previous,
            collapsed: shut.includes(key) ? shut.filter((k) => k !== key) : [...shut, key],
          };
        }),
      clearFilters: () => write((previous) => ({ ...previous, filters: {} })),
      reset: () => write(() => EMPTY_STATE),
    }),
    [filters, hidden, groupBy, collapsed, write, fallbackCollapsed],
  );
}
