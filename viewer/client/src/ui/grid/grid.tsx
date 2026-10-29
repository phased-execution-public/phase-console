import { ArrowDown, ArrowUp, ChevronRight } from 'lucide-react';
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { UiState } from '@shared/status-vocab.js';
import { cn } from '@/lib/cn';
import { usePhone } from '@/lib/media';
import { Button } from '../button';
import type { Everything } from '../everything';
import { Table, TableWrap, TBody, TD, TH, THead, TR, stickyHeadCell, stickyIdentityCell } from '../table';
import type { ToolbarSlot, ToolbarVerb } from '../toolbar';
import {
  CardList,
  Facts,
  GroupHeading,
  PickBox,
  followRowLink,
  groupLabel,
  type CardPick,
} from './card-list';
import { readingOf, type Column } from './column';
import type { GridItem, RowModel, VirtualWindow } from './engine';
import { FOLD_AFFORDANCE, VIRTUAL_FROM, planColumns, railOffsets, trackOf, useTableFit } from './layout';
import { BulkBar, GridToolbar, type BulkVerb } from './toolbar';
import { useGridView, type GridView } from './view';

/**
 * The grid — the one table (design.md §1; quiet-console phase 6).
 *
 * One `Column<T>[]` (`column.ts`) yields the wide table, its folded cut and the
 * phone's record list (`card-list.tsx`). The cut, the tracks, the pinned rail
 * and the fit are `layout.ts`; the wrapper and the sticky header are
 * `ui/table.tsx`'s pair — read that file's header before touching either, the
 * conditional scroll wrapper and the sticky rules are one decision.
 *
 * ## Three doors, the table's way
 *
 * Expand: a row the cut, the reading or the operator folded says so on its
 * `+N`, and opens in place onto those columns under their heads (and the
 * page's own `detail`). Inspect: the page's — a row's link (`rowHref`) or its
 * own control opens the panel. Everything: `everything` is the page's switch
 * (`ui/everything.ts`); off, the columns marked `everything` fold and the rest
 * are cut to fit; on, every column is drawn and the wrapper scrolls with the
 * identity pinned. No datum removed: everything folded is one press away.
 *
 * ## Strips, when the rows are records in a state
 *
 * A table whose every row is ONE record in ONE state — a plan's phases —
 * passes `rowPaint`, and its rows are flight strips (2026-10-20, Tower
 * strips): the first cell carries the state's 4 px leading edge, an OPEN row
 * and its detail sit on the state's tint with the edge running down through
 * both, and the row's toggle is a chevron on a round plate in a 44 px target
 * that turns as the row opens. Opt-in, because most tables' rows are not one
 * thing in one state, and a hue on every row would be a hue that says nothing.
 * The hue is a state class's (`state-<paint>`), never a page's.
 *
 * ## Never cover a row with an overlay
 *
 * A row-covering `after:absolute after:inset-0` link leaves every other control
 * in the row dead to the pointer while it stays in the tab order. `rowHref` is
 * the supported way: the identity cell becomes a real `<a>` and the row hands a
 * plain click to it (`followRowLink`), standing down over anything interactive.
 *
 * ## What a grid asks for, each only when asked
 *
 *   - `toolbar`   the toolbar grammar over the columns (`toolbar.tsx`): the
 *                 search, the filters with their facets, the group, the sort,
 *                 the columns, the page's ⋯ and its Everything switch.
 *   - `groupBy`   the default grouping; each group is a heading ROW of this
 *                 same table — never a second table — whose button carries
 *                 `aria-expanded` and names the rows it controls.
 *   - `selection` a pick box per row, one "every row shown" box in the header,
 *                 and a bar of verbs while anything is picked. A pick is a row
 *                 KEY, so it survives the caller re-sorting the rows.
 *   - `virtual`   past `virtualFrom` rows (150), only a window is drawn —
 *                 against the shell's one scroller, `<main>`, so the header
 *                 still sticks.
 *   - `tableId`   the operator's view, kept in `lib/prefs.ts` `tables`.
 *   - `summary`   what sits above the table, handed the records the filters
 *                 keep, so a total never sits above rows it does not count.
 *
 * The row model behind those features is TanStack Table's, in `engine.ts`, and
 * this file is the one that reaches it — through `import()`, so the library is
 * a chunk of its own (`engine-*`) that a grid asking for nothing never fetches.
 * Until it lands the grid shows its rows as given; one that asked for a window
 * shows as many as it ever draws whole and says how many more are coming. A
 * chunk that cannot load holds nothing back.
 */

/** The page's toolbar additions — the slots the columns cannot fill. */
export interface GridToolbarOptions {
  /** The page's own orders, when they are not the columns' `sort`. */
  sort?: ToolbarSlot;
  /** The page's verbs: the toolbar's `⋯`. */
  more?: readonly ToolbarVerb[];
  /**
   * The search box's hint, when `Search by <head>` is longer than the box —
   * a desk's is 14rem and a long head was cut mid-word. The accessible name
   * stays the columns' own, `Search the <label> by <head>`.
   */
  placeholder?: string;
}

export interface GridProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  getRowKey: (row: T, index: number) => string;
  /** The accessible name. A table nobody can name is a table nobody can find. */
  label: string;
  /** Revealed under a row, after the columns it folds. */
  detail?: (row: T) => ReactNode;
  rowClassName?: (row: T) => string | undefined;
  /**
   * The state each row is in, which makes the rows STRIPS (see the header):
   * the state's leading edge, its tint while open, the plated toggle. Absent,
   * or `undefined` for a row, and that row draws as any table's.
   */
  rowPaint?: (row: T) => UiState | undefined;
  /** Extra props for the row element — hover and focus handlers, data attributes. */
  rowProps?: (row: T) => Record<string, unknown>;
  /** Where this row goes: the identity cell becomes a real `<a>`, and the row follows it on a plain click. */
  rowHref?: (row: T) => string | undefined;
  /** The order in force, by `Column.sort.id`. Sorting is the page's; the grid offers and reports it. */
  activeSort?: string;
  onSort?: (id: string) => void;
  /** What stands in for the rows when there are none — inside the table's frame, under the header. */
  empty?: ReactNode;
  /** Draw records as a list below the shell breakpoint (900). Default true. */
  cards?: boolean;
  className?: string;
  /** Keep the operator's view under this key in `lib/prefs.ts` (`tables`). */
  tableId?: string;
  /** The toolbar grammar above the grid — `true`, or the page's own slots beside the columns'. */
  toolbar?: boolean | GridToolbarOptions;
  /**
   * The page's Everything (`useEverything`): its `on` decides the reading, and
   * the toolbar draws its switch. A boolean when the page draws the switch
   * somewhere else.
   */
  everything?: Everything | boolean;
  /** Group under this column until the operator chooses otherwise; their choice, "none" included, wins. */
  groupBy?: string;
  /** The group keys (`${columnId}:${value}`) folded until the operator opens one. */
  defaultCollapsed?: readonly string[];
  /** Let rows be picked, and offer these verbs over the picked ones. */
  selection?: {
    verbs: BulkVerb<T>[];
    /** How a row is named to a screen reader. Default: its identity's `value`, else its key. */
    labelOf?: (row: T) => string;
  };
  /** Draw only the rows in view once there are more than `virtualFrom`. */
  virtual?: boolean;
  /** How many rows it takes before `virtual` windows them. Default `VIRTUAL_FROM` (150). */
  virtualFrom?: number;
  /** What the group control calls "no grouping" — `None` unless the page has a better word. */
  ungroupedLabel?: string;
  /** Drawn above the toolbar, given the records the filters keep, in order. */
  summary?: (kept: readonly T[]) => ReactNode;
}

/* ------------------------------------------------------------------------- *
 * The engine, on demand
 * ------------------------------------------------------------------------- */

type Engine = typeof import('./engine');
let engineLoaded: Engine | null = null;
let engineLoading: Promise<Engine> | null = null;

/**
 * Fetch the row-model engine now — for a page that knows a grid with features
 * is about to mount (a hover on the link to it).
 */
export function loadEngine(): Promise<Engine> {
  engineLoading ??= import('./engine').then(
    (module) => (engineLoaded = module),
    (error: unknown) => {
      // A chunk that failed to arrive (offline, a deploy mid-session) is
      // retried by the next grid that asks; until then the rows show as given.
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
 * The grid
 * ------------------------------------------------------------------------- */

export function Grid<T>(props: GridProps<T>) {
  const view = useGridView(props.tableId, props.columns, {
    groupBy: props.groupBy,
    collapsed: props.defaultCollapsed,
  });
  const wanted = Boolean(
    props.toolbar ||
    props.selection ||
    view.groupBy ||
    Object.keys(view.filters).length ||
    (props.virtual && props.rows.length > (props.virtualFrom ?? VIRTUAL_FROM)),
  );
  const { engine, failed } = useEngine(wanted);
  // The window's origin is STATE, set by the body's ref: the body draws it only
  // once the window has come up, so the window has to be told when it lands.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [lifted, setLifted] = useState<Lifted<T> | null>(null);
  // Wanted, and not yet handed up. A chunk that could not load is not pending.
  const pending = wanted && !failed && !(engine && lifted);
  /*
   * The body keeps ONE place in the tree whether or not the engine has landed.
   * The engine's hooks run in a sibling that renders nothing and hands its
   * answer up (`EngineHost`), so its arrival re-renders the grid rather than
   * replacing it — a row somebody opened, a popover they had started to open, a
   * focus they had placed, all survive it.
   */
  return (
    <>
      {engine && (
        <EngineHost engine={engine} props={props} view={view} anchor={anchor} onChange={setLifted} />
      )}
      <GridBody
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
  props: GridProps<T>;
  view: GridView;
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
  // function, and a new one each render re-measured every row every render.
  const keyAt = useCallback((index: number) => items[index]?.key ?? String(index), [items]);
  const win = engine.useWindow({
    count: items.length,
    enabled: Boolean(props.virtual) && items.length > (props.virtualFrom ?? VIRTUAL_FROM),
    anchor,
    // A record on a phone is a few lines; a table row is one. The estimate only
    // has to be close — every drawn item is measured as it lands.
    estimate: phone ? 88 : 44,
    keyAt,
  });
  // Before paint: the grid is never shown one answer behind its engine.
  useLayoutEffect(() => onChange({ model, win }), [model, win, onChange]);
  return null;
}

/** The pick column's id — not a record's column, so never offered to hide. */
const PICK = '__pick';

/** Columns in the order the page declared them. */
const inOrder = <T,>(columns: readonly Column<T>[], ids: ReadonlySet<string>): Column<T>[] =>
  columns.filter((c) => ids.has(c.id));

function GridBody<T>({
  props,
  view,
  model,
  win,
  pending,
  anchor,
}: {
  props: GridProps<T>;
  view: GridView;
  model: RowModel<T> | null;
  win: VirtualWindow | null;
  /** The engine is wanted and has not handed up its first model yet. */
  pending: boolean;
  /** Takes the window's origin — the first body, or the record list — while the window is on. */
  anchor: (node: HTMLElement | null) => void;
}) {
  const {
    columns,
    rows,
    getRowKey,
    label,
    detail,
    rowClassName,
    rowPaint,
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
  const { wrapRef, tableRef, width, overflows, measured } = useTableFit();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const groupIds = useId();
  const everything = typeof props.everything === 'object' ? props.everything : undefined;
  const everythingOn = typeof props.everything === 'object' ? props.everything.on : Boolean(props.everything);

  // Until the engine has a model, a grid that asked for a window draws no more
  // rows than it ever draws whole, and names the rest below them (`held`).
  const cap = pending && props.virtual ? (props.virtualFrom ?? VIRTUAL_FROM) : Infinity;
  const drawn = useMemo(() => (rows.length > cap ? rows.slice(0, cap) : rows), [rows, cap]);
  const held = rows.length - drawn.length;
  const holding =
    held > 0 ? (
      <p className="text-meta text-ink-muted" role="status">
        {`${drawn.length} of ${rows.length} rows shown while the table loads.`}
      </p>
    ) : null;

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

  // The reading, then the operator: what Everything withholds and what was
  // hidden leave the cut and join what it folds — never the page.
  const reading = useMemo(() => readingOf(columns, everythingOn), [columns, everythingOn]);
  const hiddenIds = useMemo(() => new Set(view.hidden), [view.hidden]);
  const visible = useMemo(
    () => reading.offered.filter((c) => !hiddenIds.has(c.id)),
    [reading.offered, hiddenIds],
  );
  const away = useMemo(
    () => inOrder(columns, new Set([...reading.withheld.map((c) => c.id), ...hiddenIds])),
    [columns, reading.withheld, hiddenIds],
  );
  const offered = useMemo(() => {
    if (!pick) return visible;
    const pickColumn: Column<T> = {
      id: PICK,
      head: 'Select',
      priority: 1,
      min: 44,
      width: '44px',
      card: 'none',
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
  }, [visible, pick, keyOf]);

  // Everything draws every column it offers and lets the wrapper scroll; the
  // essentials are cut to the measured width.
  const cut = useMemo(
    () =>
      everythingOn
        ? { shown: offered, folded: [] as Column<T>[] }
        : planColumns(offered, width, away.length ? { folding: true } : {}),
    [everythingOn, offered, width, away.length],
  );
  const shown = cut.shown;
  const folded = useMemo(
    () =>
      away.length
        ? inOrder(columns, new Set([...cut.folded.map((c) => c.id), ...away.map((c) => c.id)]))
        : cut.folded,
    [columns, cut.folded, away],
  );
  const identity = shown.find((c) => c.identity) ?? shown.find((c) => c.id !== PICK) ?? shown[0];
  const expandable = Boolean(detail) || folded.length > 0;
  // The narrowest the table may lay out: every drawn column at its track, and
  // the fold count's room. Fixed layout honours a declared width but gives the
  // flex column only what is left, so a table drawing more than fits — every
  // column under Everything, or priority 1 alone on a narrow box — would crush
  // its flex column under its floor and never measure as overflowing. At this
  // floor it overflows instead, the wrapper scrolls and the identity pins.
  const floor = shown.reduce((n, c) => n + trackOf(c), 0) + (folded.length > 0 ? FOLD_AFFORDANCE : 0);
  // The columns that travel with the identity while the wrapper scrolls, and
  // where each sits. Empty unless it scrolls — see `railOffsets`.
  const rail = useMemo(
    () => (overflows ? railOffsets(shown, identity, width) : new Map<string, number>()),
    [overflows, shown, identity, width],
  );

  const toggle = useCallback((key: string) => {
    setOpen((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const isOpen = useCallback((key: string) => open.has(key), [open]);

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
  const options = typeof toolbar === 'object' ? toolbar : {};
  // The controls are there from the first paint; until the engine lands the
  // facets say "No values yet" and the filters wait to apply.
  const tools = toolbar ? (
    <GridToolbar
      label={label}
      columns={columns}
      offered={reading.offered}
      withheld={reading.withheld.length}
      view={view}
      {...(model ? { facet: model.facet, shown: model.shown, total: model.total } : {})}
      {...(activeSort ? { activeSort } : {})}
      {...(onSort ? { onSort } : {})}
      {...(options.sort ? { sort: options.sort } : {})}
      {...(options.more ? { more: options.more } : {})}
      {...(options.placeholder ? { placeholder: options.placeholder } : {})}
      {...(everything ? { everything } : {})}
      {...(props.ungroupedLabel ? { ungroupedLabel: props.ungroupedLabel } : {})}
    />
  ) : null;

  const noMatch = (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-3 text-body text-ink-muted">
      <p>No rows match these filters.</p>
      <Button variant="ghost" onClick={view.clearFilters}>
        Clear filters
      </Button>
    </div>
  );

  let body: ReactNode;
  if (phone && cards) {
    body = filteredEmpty ? (
      <div className="rounded-lg border border-rule bg-surface px-(--tile-pad-x)">{noMatch}</div>
    ) : (
      <CardList
        visible={visible}
        folded={away}
        everything={everythingOn}
        items={items}
        label={label}
        sortControls={!toolbar}
        isOpen={isOpen}
        onToggle={toggle}
        onToggleGroup={view.toggleGroup}
        {...(detail ? { detail } : {})}
        {...(rowClassName ? { rowClassName } : {})}
        {...(rowPaint ? { rowPaint } : {})}
        {...(rowProps ? { rowProps } : {})}
        {...(rowHref ? { rowHref } : {})}
        {...(activeSort ? { activeSort } : {})}
        {...(onSort ? { onSort } : {})}
        {...(empty != null ? { empty } : {})}
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
    const record = (item: Extract<GridItem<T>, { kind: 'row' }>, rowIndex?: number) => {
      const href = rowHref?.(item.row);
      const extra = rowClassName?.(item.row);
      const paint = rowPaint?.(item.row);
      return (
        <TableRecord
          key={item.key}
          row={item.row}
          rowKey={item.key}
          shown={shown}
          folded={folded}
          identity={identity}
          rail={rail}
          expandable={expandable}
          isOpen={open.has(item.key)}
          onToggle={toggle}
          {...(detail ? { detail } : {})}
          {...(href ? { href } : {})}
          {...(extra ? { className: extra } : {})}
          {...(paint ? { paint } : {})}
          {...(rowIndex !== undefined ? { 'aria-rowindex': rowIndex } : {})}
          {...(rowProps?.(item.row) ?? {})}
        />
      );
    };
    const heading = (item: Extract<GridItem<T>, { kind: 'group' }>, controls?: string, rowIndex?: number) => {
      const column = columns.find((c) => c.id === item.column);
      return (
        <TR className="hover:bg-surface" {...(rowIndex !== undefined ? { 'aria-rowindex': rowIndex } : {})}>
          {/* A heading is a row of the same table, so the columns stay aligned
              across every group — a table per group is how a page ends up
              with five different column widths. */}
          <TD colSpan={shown.length} className="bg-ground-deep py-0.5">
            <GroupHeading
              label={column?.groupLabel?.(item.value) ?? groupLabel(item.value)}
              count={item.count}
              open={item.open}
              onToggle={() => view.toggleGroup(item.key)}
              {...(controls ? { controls } : {})}
              {...(column ? { column: column.head } : {})}
            />
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
      // one measured box, so opening a row moves the window by exactly what it
      // grew. Two spacer bodies stand in for everything not drawn; the top one
      // is also the window's origin (`anchor`).
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
                {item.kind === 'group' ? heading(item, undefined, i + 2) : record(item, i + 2)}
              </TBody>
            );
          })}
          <tbody aria-hidden="true">
            <tr style={{ height: win.padBottom }} />
          </tbody>
        </>
      );
    } else if (items.some((item) => item.kind === 'group')) {
      // One heading body and one rows body per group: the rows' body exists
      // whether or not the group is folded, so `aria-controls` never dangles.
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
            <TBody id={bodyId}>{section.rows.map((item) => record(item))}</TBody>
          </Fragment>
        );
      });
    } else {
      tbodies = (
        <TBody>
          {rows.length === 0 &&
            empty != null &&
            emptyRow(<div className="py-3 text-body text-ink-muted">{empty}</div>)}
          {filteredEmpty && emptyRow(noMatch)}
          {items.map((item) => (item.kind === 'row' ? record(item) : null))}
          {holding && emptyRow(holding)}
        </TBody>
      );
    }

    body = (
      // Not measured yet is not "it fits": until the box has answered, the
      // wrapper scrolls, because a table at full width in a wrapper that does
      // not scroll is the arrangement that hides a column with no way to it.
      <TableWrap ref={wrapRef} scrolls={overflows || !measured} className={className}>
        {/* Always fixed: every column has declared its track (`min`, or
            `width`), so laying out on the content would ignore what the grid
            just said about itself. */}
        <Table
          ref={tableRef}
          aria-label={label}
          fixed
          style={{ minWidth: floor }}
          // Windowed, the table says how many rows it has, and each drawn row
          // its true position — "row 412 of 1001" on a table holding forty.
          {...(windowed ? { 'aria-rowcount': items.length + 1 } : {})}
        >
          <THead>
            <TR className="hover:bg-ground" {...(windowed ? { 'aria-rowindex': 1 } : {})}>
              {shown.map((c) => (
                <HeadCell
                  key={c.id}
                  column={c}
                  // Sticky is the OTHER half of `scrolls`, so it is the same
                  // decision: not overflowing is not enough, the box has to have
                  // said so. Unmeasured, the wrapper scrolls and sticky would bind
                  // to a box that never scrolls vertically.
                  sticky={!overflows && measured}
                  pinnedAt={rail.get(c.id)}
                  railEdge={c === identity}
                  // The room the cut reserved for the `+N` is this column's.
                  owed={c === identity && folded.length > 0 ? FOLD_AFFORDANCE : 0}
                  {...(activeSort ? { activeSort } : {})}
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

  // The frame depends on what the grid was ASKED for, never on what shows this
  // instant: a bar that appears on the first pick must not move the table one
  // level down, which would remount it and every control in it.
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

/** The rule down the pinned rail's last column — on its end side, whichever way the page reads. */
const RAIL_EDGE = 'shadow-[1px_0_0_0_var(--rule)] rtl:shadow-[-1px_0_0_0_var(--rule)]';

function HeadCell<T>({
  column,
  sticky,
  pinnedAt,
  railEdge,
  owed,
  activeSort,
  onSort,
  override,
}: {
  column: Column<T>;
  sticky: boolean;
  /** Where this column sits in the pinned rail, or absent if it is not in one. */
  pinnedAt?: number | undefined;
  /** The identity — the column whose rule, when the rail pins, runs down its end side. */
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
  const pinned = pinnedAt !== undefined;
  const Arrow = column.sort?.dir === 'ascending' ? ArrowUp : ArrowDown;
  return (
    <TH
      className={cn(
        column.align === 'end' ? 'text-end' : 'text-start',
        sticky && stickyHeadCell,
        // The pinned head cell is the corner both rails meet in: the header's
        // recessed ground, and the rail's rule down its end side.
        pinned && 'sticky z-(--z-base) bg-ground',
        pinned && railEdge && RAIL_EDGE,
      )}
      // The cut budgeted `trackOf`; laying out on anything else is how the two
      // came to disagree by 360 px on a nine-column table.
      {...(column.flex && !pinned
        ? {}
        : {
            style: {
              ...(column.flex ? {} : { width: column.width ?? trackOf(column) }),
              ...(column.flex || !owed ? {} : { width: trackOf(column) + owed }),
              ...(pinned ? { insetInlineStart: pinnedAt } : {}),
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
              'inline-flex items-center gap-1 rounded-sm hover:text-ink [@media(hover:none)]:min-h-(--tap-min)',
              active && 'text-ink',
            )}
          >
            {column.head}
            <Arrow size={12} aria-hidden className={cn(!active && 'opacity-0')} />
          </button>
        ) : (
          column.head
        ))}
    </TH>
  );
}

function TableRecord<T>({
  row,
  rowKey,
  shown,
  folded,
  identity,
  rail,
  expandable,
  isOpen,
  onToggle,
  href,
  detail,
  className,
  paint,
  ...rest
}: {
  row: T;
  rowKey: string;
  shown: Column<T>[];
  folded: Column<T>[];
  identity: Column<T> | undefined;
  /** Column id → its offset in the pinned rail. Empty when nothing pins. */
  rail: Map<string, number>;
  expandable: boolean;
  isOpen: boolean;
  onToggle: (key: string) => void;
  /** `GridProps.rowHref` for this row, already resolved. */
  href?: string;
  detail?: (row: T) => ReactNode;
  className?: string;
  /** `GridProps.rowPaint` for this row, already resolved: the row is a strip. */
  paint?: UiState;
  [key: string]: unknown;
}) {
  const panelId = `row-${rowKey}-detail`;
  const strip = paint !== undefined;
  // The strip's leading edge: a 4 px rule in the state's vivid hue down the
  // first cell's start side — an element of its own, not the cell's border,
  // because a collapsed table spills half a start border outside the
  // scroller that clips it. It runs the cell's whole height, and the open
  // row's detail draws it again over the rule between the two, so the edge
  // runs down through both unbroken.
  const edge = (below: boolean) =>
    strip ? (
      <span
        aria-hidden
        data-strip-edge=""
        className={cn(
          'pointer-events-none absolute start-0 w-1 bg-state-vivid',
          below ? '-top-px bottom-0' : 'inset-y-0',
          `state-${paint}`,
        )}
      />
    ) : null;
  const identityCell = (c: Column<T>) =>
    href ? (
      // A real link, not a target: the row's destination has to survive being
      // tabbed to, middle-clicked, hovered for the status bar and copied.
      <a
        href={href}
        data-row-link=""
        // 24px at the least, both ways (WCAG 2.5.8): a phase number is one glyph.
        className="inline-flex min-h-6 min-w-6 max-w-full items-center rounded-sm hover:underline"
      >
        {c.cell(row)}
      </a>
    ) : (
      c.cell(row)
    );
  return (
    <>
      <TR
        className={cn(
          href && 'cursor-pointer',
          // An open strip sits on its state's tint, and stays on it under the pointer.
          strip && isOpen && cn(`state-${paint}`, 'bg-state-tint hover:bg-state-tint'),
          className,
        )}
        data-open={isOpen ? '' : undefined}
        {...(strip ? { 'data-strip': paint } : {})}
        {...(href ? { 'data-row-href': href, onClick: followRowLink } : {})}
        {...rest}
      >
        {shown.map((c, i) => {
          const pinnedAt = rail.get(c.id);
          return (
            <TD
              key={c.id}
              className={cn(
                c.align === 'end' && 'text-end tabular-nums',
                c.cellClassName,
                // The edge's anchor — a pinned cell is positioned already.
                strip && i === 0 && pinnedAt === undefined && 'relative',
                // Opaque, and still the row's own colour — `stickyIdentityCell`
                // is where that is arranged, and why it takes two layers.
                pinnedAt !== undefined && stickyIdentityCell,
                pinnedAt !== undefined && c === identity && RAIL_EDGE,
              )}
              // An inline offset beats the `start-0` utility, which is right
              // only for the rail's first column.
              {...(pinnedAt ? { style: { insetInlineStart: pinnedAt } } : {})}
            >
              {i === 0 && edge(false)}
              {c === identity && expandable ? (
                <span className="flex min-w-0 items-center gap-1.5">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    onClick={() => onToggle(rowKey)}
                    className={
                      strip
                        ? // A strip's toggle: a chevron on a round plate, in a 44 px target.
                          'group/toggle -my-2.5 -ms-2.5 inline-flex size-(--tap-min) shrink-0 items-center justify-center rounded-full'
                        : 'inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded-sm text-ink-faint hover:text-ink [@media(hover:none)]:min-h-(--tap-min)'
                    }
                  >
                    {strip ? (
                      <span
                        aria-hidden
                        className={cn(
                          'inline-grid size-6 place-items-center rounded-full transition-colors duration-fast ease-transit',
                          isOpen
                            ? 'bg-surface-raised text-ink'
                            : 'bg-ground-deep text-ink-muted group-hover/toggle:text-ink',
                        )}
                      >
                        <ChevronRight
                          size={14}
                          className={cn(
                            'transition-transform duration-fast ease-transit',
                            isOpen && 'rotate-90',
                          )}
                        />
                      </span>
                    ) : (
                      <ChevronRight
                        size={14}
                        aria-hidden
                        className={cn(
                          'transition-transform duration-fast ease-transit',
                          isOpen && 'rotate-90',
                        )}
                      />
                    )}
                    <span className="sr-only">
                      {isOpen ? 'Hide' : 'Show'} the rest of this row
                      {folded.length
                        ? ` — ${folded.length} more column${folded.length === 1 ? '' : 's'}`
                        : ''}
                    </span>
                  </button>
                  <span className="min-w-0">{identityCell(c)}</span>
                  {/* What was folded is COUNTED: a column that leaves without
                      saying so is the defect this grid exists against. Open, the
                      count is moot and the SPACE is still owed — the cut charged
                      `FOLD_AFFORDANCE` for it — so it turns invisible rather than
                      unmounting, and no cell beside it shifts. */}
                  {folded.length > 0 && (
                    <span
                      aria-hidden
                      className={cn('tnum shrink-0 text-meta text-ink-muted', isOpen && 'invisible')}
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
          <TD
            colSpan={shown.length}
            id={panelId}
            // A strip's detail is the strip, open: on its state's tint, the edge running down.
            className={strip ? cn('relative bg-state-tint', `state-${paint}`) : 'bg-ground-deep'}
          >
            {edge(true)}
            <div className="flex min-w-0 flex-col gap-2 py-1">
              {folded.length > 0 && <Facts columns={folded} row={row} />}
              {detail?.(row)}
            </div>
          </TD>
        </TR>
      )}
    </>
  );
}
