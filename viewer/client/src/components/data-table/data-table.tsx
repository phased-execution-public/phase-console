import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useNavigate } from '@/app/router';
import { cn } from '@/lib/cn';
import { usePhone } from '@/lib/media';
import { getPrefs, usePrefs, type TableState } from '@/lib/prefs';
import {
  Table,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  TR,
  stickyHeadCell,
  stickyIdentityCell,
} from '@/components/ui/table';
import type { GridItem, RowModel, VirtualWindow } from './engine';
import { CardList, EmptyBlock, PickBox, groupLabel, rowClickNavigates, type CardPick } from './card-list';
import {
  FOLD_AFFORDANCE,
  VIRTUAL_FROM,
  canHide,
  planColumns,
  railOffsets,
  trackOf,
  useTableFit,
  type Column,
  type FilterValue,
} from './layout';
import { BulkBar, Toolbar } from './toolbar';

/**
 * DataTable — the whole arrangement, from one column array.
 *
 * ## What it always was, and still is with no new props
 *
 * One `Column<T>[]` yields the wide table, its folded cut and the phone's card
 * list (`card-list.tsx`). The cut, the tracks, the pinned rail and the fit are
 * `layout.ts`; the wrapper and the sticky header are `ui/table.tsx`'s pair —
 * READ THAT FILE'S HEADER before touching either, because the conditional
 * scroll wrapper and the sticky rules are one decision. A table given none of
 * the props below renders exactly what it rendered before control-tower phase
 * 18 moved it here, and the tests written before the move hold that.
 *
 * ## Never cover a row with an overlay
 *
 * Three tables reached "the whole row is a link" by putting
 * `after:absolute after:inset-0` on the identity cell's `<a>` and `relative` on
 * the row. It works as a target and breaks everything else: the sheet paints
 * above every cell that is not itself positioned, so a link, a button or a
 * `<select>` in any other column is dead to the pointer — while staying in the
 * tab order, which is the shape of the bug nobody sees in a screenshot.
 *
 * `rowHref` is the supported way. The identity cell becomes a real `<a>` (so
 * keyboard, middle-click, "copy link address" and the status bar all work) and
 * the row carries a click handler that stands down over anything interactive.
 * Nothing is ever painted over another cell.
 *
 * ## What phase 18 added — each only when asked for
 *
 *   - `toolbar`   a filter per `Column.filter`, and ONE "View" control that
 *                 opens a sheet with the rest: facets, ranges, "Group by" and
 *                 the columns. On a phone the sheet holds everything.
 *   - `groupBy`   the default grouping. Each group is a heading ROW of this
 *                 same table — never a second table — whose button carries
 *                 `aria-expanded` and names the rows it controls.
 *   - `selection` a pick box per row, one "every row shown" box in the header,
 *                 and a bar of bulk verbs while anything is picked. A pick is a
 *                 row KEY, so it survives the caller re-sorting the rows.
 *   - `virtual`   past `VIRTUAL_FROM` rows, only a window is drawn — against
 *                 the shell's one scroller, `<main>`, so the header still sticks.
 *   - `tableId`   the operator's filters, hidden columns, grouping and folded
 *                 groups, kept in `lib/prefs.ts` `tables` under this key.
 *   - `summary`   what sits above the table, handed the records the filters
 *                 keep (control-tower phase 21: the runs ledger's tiles), so a
 *                 total never sits above a list it does not account for.
 *
 * A column the operator hides joins the folded columns in the row's detail.
 * No datum is removed.
 *
 * The row model behind those features is TanStack Table's, and it is loaded
 * on demand (`engine.ts` says why). Until it lands the table shows its rows
 * as given — every one of them, unless it asked for a window: then as many as
 * it ever draws whole, and a line saying how many more are on their way, so
 * nothing goes missing unsaid (control-tower phase 23: a 72-phase plan was in
 * the DOM whole for the frames its engine took to load, #26). A chunk that
 * cannot load holds nothing back.
 */

/** A verb the selection bar offers over the picked rows. */
export interface BulkVerb<T> {
  id: string;
  /** What the button says — the verb itself ("Close issues"), not "Apply". */
  label: string;
  onRun: (rows: T[]) => void;
  tone?: 'default' | 'danger';
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T, index: number) => string;
  /** Accessible name. A table nobody can name is a table nobody can find. */
  label: string;
  /** Revealed under a row. Folded columns are appended to whatever this gives. */
  detail?: (row: T) => ReactNode;
  rowClassName?: (row: T) => string | undefined;
  /**
   * Extra props for the row element — hover/focus handlers, data attributes.
   * The Plans table buys a plan's round trip on intent this way.
   */
  rowProps?: (row: T) => Record<string, unknown>;
  /**
   * Where this row goes, if it goes anywhere.
   *
   * The identity cell becomes a real `<a>` — so the keyboard reaches it, the
   * middle button opens a tab, the status bar shows the destination and "copy
   * link address" copies one — and the row itself becomes clickable. Nothing is
   * painted over the other cells; see the ban in this file's header for what
   * that costs and which three tables paid it.
   */
  rowHref?: (row: T) => string | undefined;
  /** The sort currently in force, by `Column.sort.id`. */
  activeSort?: string;
  onSort?: (id: string) => void;
  /**
   * What stands in for the rows when there are none — rendered INSIDE the
   * table's own frame, under the header, so the columns are still named and the
   * page does not change shape between "nothing yet" and "one row". Optional:
   * a table that passes nothing keeps an empty body, as before.
   */
  empty?: ReactNode;
  /** Render records as cards below the shell breakpoint. Default true. */
  cards?: boolean;
  className?: string;
  /**
   * Keep the operator's view of this table — filters, hidden columns, grouping,
   * folded groups — under this key in `lib/prefs.ts` (`tables`). Without one
   * the view lasts as long as the table is mounted.
   */
  tableId?: string;
  /** Offer the filters and the View control above the table. */
  toolbar?: boolean;
  /**
   * Group the rows under this column (a `groupable` column's id) until the
   * operator chooses otherwise — their choice, including "none", is kept by
   * `tableId` and wins.
   */
  groupBy?: string;
  /** Let rows be picked, and offer these verbs over the picked ones. */
  selection?: {
    verbs: BulkVerb<T>[];
    /** How a row is named to a screen reader. Default: its identity column's `value`, else its key. */
    labelOf?: (row: T) => string;
  };
  /**
   * Draw only the rows in view once there are more than `VIRTUAL_FROM` of them,
   * windowed against the shell's one scroller (`<main>`) so the page still has
   * one scroll and the header still sticks.
   */
  virtual?: boolean;
  /**
   * How many rows it takes before `virtual` windows them. Default
   * `VIRTUAL_FROM`. A table whose every row is dense — the phase table is a
   * dozen chips a row — pays for its DOM long before a list of names does.
   */
  virtualFrom?: number;
  /**
   * The columns hidden until the operator says otherwise — their choice,
   * stored by `tableId`, wins. One column array can serve several readings
   * this way: each reading is a `tableId` and the columns it leads with.
   */
  defaultHidden?: readonly string[];
  /** The group keys (`${columnId}:${value}`) folded until the operator opens one. */
  defaultCollapsed?: readonly string[];
  /** What the View sheet calls "no grouping" — `None` unless the table has a better word. */
  ungroupedLabel?: string;
  /**
   * Drawn above the toolbar, given the records the filters keep, in order — the
   * rows as given until the engine lands. A figure above a table describes the
   * table: the runs ledger's tiles total what the operator narrowed it to.
   */
  summary?: (kept: readonly T[]) => ReactNode;
}

/* ------------------------------------------------------------------------- *
 * The operator's view — persisted by `tableId`
 * ------------------------------------------------------------------------- */

export interface TableView {
  filters: Record<string, FilterValue>;
  hidden: string[];
  groupBy: string | null;
  collapsed: string[];
  setFilter: (columnId: string, value: FilterValue | null) => void;
  setHidden: (columnId: string, hide: boolean) => void;
  setGroupBy: (columnId: string | null) => void;
  toggleGroup: (key: string) => void;
  /** Back to the table's own defaults: no filters, nothing hidden, its own grouping. */
  reset: () => void;
}

const EMPTY_STATE: TableState = {};
/** One empty list, so a table with nothing folded does not hand the engine a new one every render. */
const NONE: string[] = [];

/** A filter value that says nothing — never stored. */
const isEmpty = (value: FilterValue | null | undefined): boolean =>
  value == null ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0) ||
  (Array.isArray(value) && value.length === 2 && value[0] == null && value[1] == null);

function useTableView<T>(
  tableId: string | undefined,
  columns: Column<T>[],
  fallbackGroup?: string,
  fallbackHidden?: readonly string[],
  fallbackCollapsed?: readonly string[],
): TableView {
  const [prefs, setPrefs] = usePrefs();
  const [local, setLocal] = useState<TableState>(EMPTY_STATE);
  const stored = tableId ? (prefs.tables?.[tableId] ?? EMPTY_STATE) : local;

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

  // What is stored is honoured only where it still names something real: a
  // column renamed or retired since the operator's last visit is ignored,
  // never an error.
  const byId = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const filters = useMemo(() => {
    const out: Record<string, FilterValue> = {};
    for (const [id, value] of Object.entries(stored.filters ?? {})) {
      const column = byId.get(id);
      if (column?.filter && column.value && !isEmpty(value)) out[id] = value;
    }
    return out;
  }, [stored.filters, byId]);
  const hidden = useMemo(
    () =>
      (stored.hidden ?? fallbackHidden ?? []).filter((id) => {
        const column = byId.get(id);
        return column ? canHide(column) : false;
      }),
    [stored.hidden, fallbackHidden, byId],
  );
  const wanted = stored.groupBy !== undefined ? stored.groupBy : (fallbackGroup ?? null);
  const groupColumn = wanted == null ? undefined : byId.get(wanted);
  const groupBy = groupColumn?.groupable && groupColumn.value ? groupColumn.id : null;
  const collapsed = (stored.collapsed ?? fallbackCollapsed ?? NONE) as string[];

  return {
    filters,
    hidden,
    groupBy,
    collapsed,
    setFilter: (columnId, value) =>
      write((previous) => {
        const next = { ...(previous.filters ?? {}) };
        if (isEmpty(value)) delete next[columnId];
        else next[columnId] = value as FilterValue;
        return { ...previous, filters: next };
      }),
    setHidden: (columnId, hide) =>
      write((previous) => {
        const without = (previous.hidden ?? fallbackHidden ?? []).filter((id) => id !== columnId);
        return { ...previous, hidden: hide ? [...without, columnId] : without };
      }),
    setGroupBy: (columnId) => write((previous) => ({ ...previous, groupBy: columnId })),
    toggleGroup: (key) =>
      write((previous) => {
        const shut = previous.collapsed ?? fallbackCollapsed ?? [];
        return {
          ...previous,
          collapsed: shut.includes(key) ? shut.filter((k) => k !== key) : [...shut, key],
        };
      }),
    reset: () => write(() => EMPTY_STATE),
  };
}

/* ------------------------------------------------------------------------- *
 * The engine, on demand
 * ------------------------------------------------------------------------- */

type Engine = typeof import('./engine');
let engineLoaded: Engine | null = null;
let engineLoading: Promise<Engine> | null = null;

/**
 * Fetch the row-model engine now — for a caller that knows a table with
 * features is about to mount (a hover on the link to its page).
 */
export function loadEngine(): Promise<Engine> {
  engineLoading ??= import('./engine').then(
    (module) => (engineLoaded = module),
    (error: unknown) => {
      // A chunk that failed to arrive (offline, a deploy mid-session) is
      // retried by the next table that asks; until then the rows show as given.
      engineLoading = null;
      throw error;
    },
  );
  return engineLoading;
}

function useEngine(wanted: boolean): { engine: Engine | null; failed: boolean } {
  const [engine, setEngine] = useState<Engine | null>(engineLoaded);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!wanted || engine) return;
    let live = true;
    loadEngine().then(
      (module) => live && setEngine(module),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [wanted, engine]);
  return { engine: wanted ? (engine ?? engineLoaded) : null, failed };
}

/* ------------------------------------------------------------------------- *
 * DataTable
 * ------------------------------------------------------------------------- */

export function DataTable<T>(props: DataTableProps<T>) {
  const view = useTableView(
    props.tableId,
    props.columns,
    props.groupBy,
    props.defaultHidden,
    props.defaultCollapsed,
  );
  const wanted = Boolean(
    props.toolbar ||
    props.selection ||
    view.groupBy ||
    Object.keys(view.filters).length ||
    (props.virtual && props.rows.length > (props.virtualFrom ?? VIRTUAL_FROM)),
  );
  const { engine, failed } = useEngine(wanted);
  // The window's origin is STATE, set by the grid's ref: the grid draws it only
  // once the window has come up, after the engine's effects have run, so the
  // window has to be told when it lands rather than read it too early.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [lifted, setLifted] = useState<Lifted<T> | null>(null);
  // Wanted, and not yet handed up — the engine still loading, or landed and
  // about to lift its first model. A chunk that could not load is not pending.
  const pending = wanted && !failed && !(engine && lifted);
  /*
   * The grid keeps ONE place in the tree whether or not the engine has landed.
   * The engine's hooks run in a sibling that renders nothing and hands its
   * answer up (`EngineHost`), so the engine's arrival re-renders the table
   * rather than replacing it — a row a person opened in the first moments, a
   * sheet they had started to open, a focus they had placed, all survive it.
   * Swapping the whole table for a modelled one was the first shape of this,
   * and it tore those down.
   */
  return (
    <>
      {engine && (
        <EngineHost engine={engine} props={props} view={view} anchor={anchor} onChange={setLifted} />
      )}
      <Grid
        props={props}
        view={view}
        model={engine ? (lifted?.model ?? null) : null}
        win={engine ? (lifted?.win ?? null) : null}
        pending={pending}
        anchor={setAnchor}
      />
    </>
  );
}

/** What the engine hands the grid: the rows as drawn, and the window over them. */
interface Lifted<T> {
  model: RowModel<T>;
  win: VirtualWindow;
}

function EngineHost<T>({
  engine,
  props,
  view,
  anchor,
  onChange,
}: {
  engine: Engine;
  props: DataTableProps<T>;
  view: TableView;
  anchor: HTMLElement | null;
  onChange: (lifted: Lifted<T>) => void;
}) {
  const phone = usePhone();
  const model = engine.useRowModel({
    rows: props.rows,
    columns: props.columns,
    getRowKey: props.getRowKey,
    filters: view.filters,
    groupBy: view.groupBy,
    collapsed: view.collapsed,
    selectable: Boolean(props.selection),
  });
  const items = model.items;
  // Stable until the rows move: the virtualizer keys its measurements on this
  // function, and a new one each render re-measured every row every render —
  // which, handed up through the layout effect below, never stopped.
  const keyAt = useCallback((index: number) => items[index]?.key ?? String(index), [items]);
  const win = engine.useWindow({
    count: items.length,
    enabled: Boolean(props.virtual) && items.length > (props.virtualFrom ?? VIRTUAL_FROM),
    anchor,
    // A card is several lines; a table row is one. The estimate only has to
    // be close — every drawn item is measured as it lands.
    estimate: phone ? 132 : 44,
    keyAt,
  });
  // Before paint: a layout effect's update renders again before the browser
  // draws, so the table is never shown one answer behind its engine.
  useLayoutEffect(() => onChange({ model, win }), [model, win, onChange]);
  return null;
}

/** The pick column's id — not a record's column, so never offered to hide. */
const PICK = '__pick';

function Grid<T>({
  props,
  view,
  model,
  win,
  pending,
  anchor,
}: {
  props: DataTableProps<T>;
  view: TableView;
  model: RowModel<T> | null;
  win: VirtualWindow | null;
  /** The engine is wanted and has not handed up its first model yet. */
  pending: boolean;
  /** Takes the window's origin — the first body, or the card list — while the window is on. */
  anchor: (node: HTMLElement | null) => void;
}) {
  const {
    columns,
    rows,
    getRowKey,
    label,
    detail,
    rowClassName,
    rowProps,
    rowHref,
    activeSort,
    onSort,
    empty,
    cards = true,
    className,
    selection,
    toolbar,
  } = props;
  const phone = usePhone();
  const navigate = useNavigate();
  const { wrapRef, tableRef, width, overflows, measured } = useTableFit();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const groupIds = useId();

  // Until the engine has a model, a table that asked for a window draws no more
  // rows than it ever draws whole: every row past that is one the window exists
  // not to draw, and the engine's first frame would drop it again. The rest are
  // named below the rows (`held`), never silently left out.
  const cap = pending && props.virtual ? (props.virtualFrom ?? VIRTUAL_FROM) : Infinity;
  const drawn = useMemo(() => (rows.length > cap ? rows.slice(0, cap) : rows), [rows, cap]);
  const held = rows.length - drawn.length;
  const holding =
    held > 0 ? (
      <p className="text-xs text-ink-muted" role="status">
        {`${drawn.length} of ${rows.length} rows shown while the table loads.`}
      </p>
    ) : null;

  // The rows as drawn: the engine's model when a feature asked for one, else
  // the caller's rows as given.
  const items = useMemo<GridItem<T>[]>(
    () =>
      model?.items ?? drawn.map((row, index) => ({ kind: 'row', key: getRowKey(row, index), row, index })),
    [model, drawn, getRowKey],
  );
  const keyOf = useMemo(() => {
    const map = new Map<T, string>();
    for (const item of items) if (item.kind === 'row') map.set(item.row, item.key);
    return map;
  }, [items]);

  const identityColumn = columns.find((c) => c.identity);
  const labelOf = useCallback(
    (row: T) => selection?.labelOf?.(row) ?? String(identityColumn?.value?.(row) ?? keyOf.get(row) ?? ''),
    [selection, identityColumn, keyOf],
  );

  const pick = useMemo<CardPick<T> | undefined>(
    () => (selection && model ? { isPicked: model.isPicked, toggle: model.toggle, labelOf } : undefined),
    [selection, model, labelOf],
  );

  // Hidden columns leave the cut and join what it folded — never the page.
  const hiddenSet = useMemo(() => new Set(view.hidden), [view.hidden]);
  const hiddenColumns = useMemo(() => columns.filter((c) => hiddenSet.has(c.id)), [columns, hiddenSet]);
  const offered = useMemo(() => {
    const visible = hiddenSet.size ? columns.filter((c) => !hiddenSet.has(c.id)) : columns;
    if (!pick) return visible;
    const pickColumn: Column<T> = {
      id: PICK,
      head: 'Select',
      priority: 1,
      min: 44,
      width: '44px',
      card: 'hide',
      hideable: false,
      cell: (row) => {
        const key = keyOf.get(row) ?? '';
        return (
          <PickBox
            checked={pick.isPicked(key)}
            label={`Select ${pick.labelOf(row)}`}
            onToggle={() => pick.toggle(key)}
          />
        );
      },
    };
    return [pickColumn, ...visible];
  }, [columns, hiddenSet, pick, keyOf]);

  const cut = useMemo(
    () => planColumns(offered, width, hiddenColumns.length ? { folding: true } : {}),
    [offered, width, hiddenColumns.length],
  );
  const shown = cut.shown;
  const folded = useMemo(
    () => (hiddenColumns.length ? [...cut.folded, ...hiddenColumns] : cut.folded),
    [cut.folded, hiddenColumns],
  );
  const identity = shown.find((c) => c.identity) ?? shown.find((c) => c.id !== PICK) ?? shown[0];
  const expandable = Boolean(detail) || folded.length > 0;
  // The columns that travel with the identity when the wrapper scrolls, and
  // where each of them sits. Empty unless it scrolls — see `railOffsets`.
  const rail = useMemo(
    () => (overflows ? railOffsets(shown, identity, width) : new Map<string, number>()),
    [overflows, shown, identity, width],
  );

  const toggle = useCallback((key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const windowed = Boolean(win && (win.padTop > 0 || win.padBottom > 0 || win.indexes.length < items.length));
  const filteredEmpty = Boolean(model && model.total > 0 && model.shown === 0);
  const bar =
    selection && model && model.picked.length > 0 ? (
      <BulkBar
        count={model.picked.length}
        verbs={selection.verbs}
        rows={model.picked}
        onClear={model.clearPicked}
      />
    ) : null;
  // The controls are there from the first paint. Until the engine lands the
  // View sheet lists no facet values and the filters wait to be applied; the
  // table itself stays where it is when it does (see `DataTable`).
  const tools = toolbar ? (
    <Toolbar
      label={label}
      columns={columns}
      view={view}
      phone={phone && cards}
      {...(props.ungroupedLabel ? { ungroupedLabel: props.ungroupedLabel } : {})}
      {...(model ? { facet: model.facet, shown: model.shown, total: model.total } : {})}
    />
  ) : null;

  const noMatch = (
    <EmptyBlock>
      No rows match these filters.{' '}
      <button
        type="button"
        className="text-action underline"
        onClick={() => {
          for (const id of Object.keys(view.filters)) view.setFilter(id, null);
        }}
      >
        Clear filters
      </button>
    </EmptyBlock>
  );

  let body: ReactNode;
  if (phone && cards) {
    body = filteredEmpty ? (
      <div className="rounded-lg border border-rule bg-surface">{noMatch}</div>
    ) : (
      <CardList
        columns={columns.filter((c) => !hiddenSet.has(c.id))}
        rows={drawn}
        getRowKey={getRowKey}
        label={label}
        {...(detail ? { detail } : {})}
        {...(rowClassName ? { rowClassName } : {})}
        {...(rowProps ? { rowProps } : {})}
        {...(rowHref ? { rowHref } : {})}
        {...(activeSort ? { activeSort } : {})}
        {...(onSort ? { onSort } : {})}
        {...(empty != null ? { empty } : {})}
        {...(model ? { items, onToggleGroup: view.toggleGroup } : {})}
        {...(hiddenColumns.length ? { hidden: hiddenColumns } : {})}
        {...(pick ? { pick } : {})}
        {...(windowed && win ? { win, anchor } : {})}
      />
    );
    if (holding) {
      body = (
        <>
          {body}
          {holding}
        </>
      );
    }
  } else {
    const row = (item: Extract<GridItem<T>, { kind: 'row' }>, rowIndex?: number) => {
      const isOpen = open.has(item.key);
      const href = rowHref?.(item.row);
      return (
        <Row
          key={item.key}
          row={item.row}
          rowKey={item.key}
          shown={shown}
          folded={folded}
          identity={identity}
          rail={rail}
          expandable={expandable}
          isOpen={isOpen}
          onToggle={toggle}
          onNavigate={navigate}
          {...(detail ? { detail } : {})}
          {...(href ? { href } : {})}
          {...(rowClassName?.(item.row) ? { className: rowClassName(item.row) as string } : {})}
          {...(rowIndex !== undefined ? { 'aria-rowindex': rowIndex } : {})}
          {...(rowProps?.(item.row) ?? {})}
        />
      );
    };
    const heading = (item: Extract<GridItem<T>, { kind: 'group' }>, controls?: string, rowIndex?: number) => {
      const column = columns.find((c) => c.id === item.column);
      return (
        <TR className="hover:bg-surface" {...(rowIndex !== undefined ? { 'aria-rowindex': rowIndex } : {})}>
          {/* The heading is a row of the same table, so the columns stay
              aligned across every group — a separate table per group is how a
              phone ends up with five different column widths. */}
          <TD colSpan={shown.length} className="bg-ground-deep/60 py-1">
            <button
              type="button"
              aria-expanded={item.open}
              {...(controls ? { 'aria-controls': controls } : {})}
              className="flex w-full cursor-pointer items-center gap-2 text-left [@media(hover:none)]:min-h-(--tap-min)"
              onClick={() => view.toggleGroup(item.key)}
            >
              <span aria-hidden="true" className="font-mono text-2xs text-ink-faint">
                {item.open ? '▾' : '▸'}
              </span>
              {column && <span className="sr-only">{`${column.head}: `}</span>}
              <strong className="text-2xs">
                {column?.groupLabel?.(item.value) ?? groupLabel(item.value)}
              </strong>
              <span className="font-mono text-2xs text-ink-faint tabular-nums">{item.count}</span>
            </button>
          </TD>
        </TR>
      );
    };

    const emptyRow = (content: ReactNode) => (
      <TR className="hover:bg-surface">
        <TD colSpan={shown.length}>{content}</TD>
      </TR>
    );

    let tbodies: ReactNode;
    if (windowed && win) {
      // Each drawn item is a body of its own: the row AND its open detail are
      // one measured box, so opening a row moves the window by exactly what
      // it grew. Two spacer bodies stand in for everything not drawn; the top
      // one is also the window's origin (`anchor`).
      tbodies = (
        <>
          <tbody aria-hidden="true" ref={anchor}>
            <tr style={{ height: win.padTop }} />
          </tbody>
          {win.indexes.map((i) => {
            const item = items[i]!;
            return (
              <TBody
                key={item.key}
                ref={win.measure}
                data-index={i}
                className={cn(i > 0 && 'border-t border-rule')}
              >
                {item.kind === 'group' ? heading(item, undefined, i + 2) : row(item, i + 2)}
              </TBody>
            );
          })}
          <tbody aria-hidden="true">
            <tr style={{ height: win.padBottom }} />
          </tbody>
        </>
      );
    } else if (items.some((item) => item.kind === 'group')) {
      // One heading body and one rows body per group — the phase table's
      // shape (`features/runs/phase-table.tsx`): the rows' body exists whether
      // or not the group is folded, so `aria-controls` never dangles.
      const sections: {
        group: Extract<GridItem<T>, { kind: 'group' }> | null;
        rows: Extract<GridItem<T>, { kind: 'row' }>[];
      }[] = [];
      for (const item of items) {
        if (item.kind === 'group') sections.push({ group: item, rows: [] });
        else if (sections.length) sections[sections.length - 1]!.rows.push(item);
        else sections.push({ group: null, rows: [item] });
      }
      tbodies = sections.map((section, index) => {
        const bodyId = `${groupIds}-group-${index}`;
        return (
          <Fragment key={section.group?.key ?? `rows-${index}`}>
            {section.group && <TBody>{heading(section.group, bodyId)}</TBody>}
            <TBody id={bodyId}>{section.rows.map((item) => row(item))}</TBody>
          </Fragment>
        );
      });
    } else {
      tbodies = (
        <TBody>
          {rows.length === 0 && empty != null && emptyRow(<EmptyBlock>{empty}</EmptyBlock>)}
          {filteredEmpty && emptyRow(noMatch)}
          {items.map((item) => (item.kind === 'row' ? row(item) : null))}
          {holding && emptyRow(holding)}
        </TBody>
      );
    }

    body = (
      // Not measured yet is not "it fits": until the box has answered, the
      // wrapper scrolls, because a table at full width in a wrapper that does not
      // scroll is the arrangement that hides a column with no way to reach it.
      <TableWrap ref={wrapRef} scrolls={overflows || !measured} className={className}>
        {/* Always fixed: every column here has declared a track (`width`, else
            `min`, else the default), so laying out on the content instead would
            be ignoring what the table just said about itself. */}
        <Table
          ref={tableRef}
          aria-label={label}
          fixed
          // Windowed, the table says how many rows it has, and each drawn row
          // its true position — "row 412 of 1001" on a table holding forty.
          {...(windowed ? { 'aria-rowcount': items.length + 1 } : {})}
        >
          <THead>
            <TR {...(windowed ? { 'aria-rowindex': 1 } : {})}>
              {shown.map((c) => (
                <HeadCell
                  key={c.id}
                  column={c}
                  // Sticky is the OTHER half of `scrolls`, so it must be the same
                  // decision: not overflowing is not enough, the box has to have
                  // said so. Unmeasured, the wrapper scrolls and sticky binds to
                  // a box that never scrolls vertically — pure paint cost.
                  sticky={!overflows && measured}
                  pinnedLeft={rail.get(c.id)}
                  railEdge={c === identity}
                  // The room the cut reserved for the `+N` is this column's to
                  // lay out — a flex identity takes it anyway.
                  owed={c === identity && folded.length > 0 ? FOLD_AFFORDANCE : 0}
                  activeSort={activeSort}
                  {...(onSort ? { onSort } : {})}
                  {...(c.id === PICK && model
                    ? {
                        override: (
                          <PickBox
                            checked={model.pickedShown === 'all'}
                            indeterminate={model.pickedShown === 'some'}
                            label="Select every row shown"
                            onToggle={model.toggleShown}
                          />
                        ),
                      }
                    : {})}
                />
              ))}
            </TR>
          </THead>
          {tbodies}
        </Table>
      </TableWrap>
    );
  }

  // The frame depends on what the table was ASKED for, never on what is
  // showing this instant: a bar that appears on the first pick must not move
  // the table one level down, which would remount it and every control in it.
  if (!toolbar && !selection && !props.summary) return body;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {props.summary?.(model ? model.kept : rows)}
      {tools}
      {bar}
      {body}
    </div>
  );
}

function HeadCell<T>({
  column,
  sticky,
  pinnedLeft,
  railEdge,
  owed,
  activeSort,
  onSort,
  override,
}: {
  column: Column<T>;
  sticky: boolean;
  /** Where this column sits in the pinned rail, or absent if it is not in one. */
  pinnedLeft?: number;
  /** The last column of the rail — the one that carries the rule down its right. */
  railEdge: boolean;
  /** Width the cut reserved for this column beyond its own track — the identity's fold count. */
  owed: number;
  activeSort?: string;
  onSort?: (id: string) => void;
  /** What the cell holds instead of its head — the pick column's "every row" box. */
  override?: ReactNode;
}) {
  const sortable = column.sort && onSort;
  const active = Boolean(column.sort && activeSort === column.sort.id);
  const pinned = pinnedLeft !== undefined;
  return (
    <TH
      className={cn(
        column.align === 'end' && 'text-right',
        sticky && stickyHeadCell,
        // The pinned head cell is the corner both rails meet in: the header's
        // recessed ground, and the identity rail's own rule down its right —
        // which only the rail's LAST column draws.
        pinned && 'sticky z-(--z-base) bg-ground',
        pinned && railEdge && 'shadow-[1px_0_0_0_var(--rule)]',
      )}
      // The cut budgeted `trackOf`; laying out on anything else is how the two
      // came to disagree by 360 px on a nine-column table.
      {...(column.flex && !pinned
        ? {}
        : {
            style: {
              ...(column.flex ? {} : { width: column.width ?? trackOf(column) }),
              ...(column.flex || !owed ? {} : { width: trackOf(column) + owed }),
              ...(pinned ? { left: pinnedLeft } : {}),
            },
          })}
      // A sorted column with no visible arrow is a silent claim about order.
      {...(column.sort ? { 'aria-sort': active ? column.sort.dir : 'none' } : {})}
    >
      {override ??
        (sortable ? (
          <button
            type="button"
            onClick={() => onSort(column.sort!.id)}
            className={cn(
              'inline-flex items-center gap-1 hover:text-ink [@media(hover:none)]:min-h-(--tap-min)',
              active && 'text-action',
            )}
          >
            {column.head}
            <span aria-hidden className={cn('text-2xs', !active && 'opacity-0')}>
              {column.sort!.dir === 'ascending' ? '↑' : '↓'}
            </span>
          </button>
        ) : (
          column.head
        ))}
    </TH>
  );
}

function Row<T>({
  row,
  rowKey,
  shown,
  folded,
  identity,
  rail,
  expandable,
  isOpen,
  onToggle,
  onNavigate,
  href,
  detail,
  className,
  ...rest
}: {
  row: T;
  rowKey: string;
  shown: Column<T>[];
  folded: Column<T>[];
  identity: Column<T> | undefined;
  /** Column id → its `left` in the pinned rail. Empty when nothing pins. */
  rail: Map<string, number>;
  expandable: boolean;
  isOpen: boolean;
  onToggle: (key: string) => void;
  onNavigate: (path: string) => void;
  /** `DataTableProps.rowHref` for this row, already resolved. */
  href?: string;
  detail?: (row: T) => ReactNode;
  className?: string;
  [key: string]: unknown;
}) {
  const panelId = `row-${rowKey}-detail`;
  const identityCell = (c: Column<T>) =>
    href ? (
      // A real link, not a target: the row's destination has to survive being
      // tabbed to, middle-clicked, hovered for the status bar and copied.
      <a
        href={href}
        data-row-link=""
        // 24px at the least, both ways (WCAG 2.5.8): a phase number is one glyph.
        className="inline-flex min-h-6 min-w-6 max-w-full items-center rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-focus"
      >
        {c.cell(row)}
      </a>
    ) : (
      c.cell(row)
    );
  return (
    <>
      <TR
        className={cn(href && 'cursor-pointer', className)}
        data-open={isOpen ? '' : undefined}
        {...(href
          ? {
              'data-row-href': href,
              onClick: (event: MouseEvent<HTMLTableRowElement>) => {
                if (rowClickNavigates(event)) onNavigate(href);
              },
            }
          : {})}
        {...rest}
      >
        {shown.map((c) => {
          const pinnedLeft = rail.get(c.id);
          return (
            <TD
              key={c.id}
              className={cn(
                c.align === 'end' && 'text-right tabular-nums',
                c.cellClassName,
                // Opaque, and still the row's own colour — `stickyIdentityCell`
                // is where that is arranged, and why it takes two layers. Only
                // the rail's last column draws the rule down its right.
                pinnedLeft !== undefined && stickyIdentityCell,
                pinnedLeft !== undefined && c === identity && 'shadow-[1px_0_0_0_var(--rule)]',
              )}
              // Inline `left` beats the `left-0` utility, which is right only for
              // the first column of the rail.
              {...(pinnedLeft ? { style: { left: pinnedLeft } } : {})}
            >
              {c === identity && expandable ? (
                <span className="flex items-center gap-1.5">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    onClick={() => onToggle(rowKey)}
                    className="inline-flex min-h-6 min-w-6 items-center justify-center gap-1 text-ink-faint hover:text-ink [@media(hover:none)]:min-h-(--tap-min)"
                  >
                    <span aria-hidden className="font-mono text-2xs">
                      {isOpen ? '▾' : '▸'}
                    </span>
                    <span className="sr-only">
                      {isOpen ? 'Hide' : 'Show'} the rest of this row
                      {folded.length
                        ? ` — ${folded.length} more column${folded.length === 1 ? '' : 's'}`
                        : ''}
                    </span>
                  </button>
                  <span className="min-w-0">{identityCell(c)}</span>
                  {/* What was folded is COUNTED. A column that leaves without
                    saying so is the whole defect this table was rebuilt for.
                    Open, the count is wrong and the SPACE is still owed:
                    `planColumns` charged `FOLD_AFFORDANCE` for this box, so
                    unmounting it would hand the identity column 40 px back for
                    exactly as long as a row stays open, and shift every cell
                    beside it. `invisible` keeps the promise. */}
                  {folded.length > 0 && (
                    <span
                      aria-hidden
                      // Muted: the count is read, not glanced at — it is the only
                      // sign a column left, and faint failed AA on a live row's tint.
                      className={cn('shrink-0 font-mono text-2xs text-ink-muted', isOpen && 'invisible')}
                    >
                      +{folded.length}
                    </span>
                  )}
                </span>
              ) : c === identity ? (
                identityCell(c)
              ) : (
                c.cell(row)
              )}
            </TD>
          );
        })}
      </TR>
      {isOpen && (
        <TR className="hover:bg-surface">
          <TD colSpan={shown.length} id={panelId} className="bg-ground-deep/40">
            {folded.length > 0 && (
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                {folded.map((c) => (
                  <div key={c.id} className="contents">
                    <dt className="text-2xs uppercase tracking-wide text-ink-muted">{c.head}</dt>
                    <dd className="min-w-0">{c.cell(row)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {detail?.(row)}
          </TD>
        </TR>
      )}
    </>
  );
}
