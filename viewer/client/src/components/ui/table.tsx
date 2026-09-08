import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
} from 'react';
import { useNavigate } from '@/app/router';
import { cn } from '@/lib/cn';
import { usePhone } from '@/lib/media';

/**
 * Tables.
 *
 * ## The wrapper, and why it is conditional
 *
 * A table wide enough to need scrolling scrolls *inside its own box*, so the
 * page body never does. A phone that scrolls sideways as a whole loses the tab
 * bar off the edge and never gets it back — that is the single most common way
 * a responsive layout breaks here.
 *
 * But being a scroll container has a cost that went unpaid for three releases:
 * `position: sticky` binds to the nearest scrolling ancestor, so a header
 * inside an always-scrolling wrapper can only stick to a box that never scrolls
 * vertically. That is why `THead` was not sticky — the mechanism could not
 * work, not because a pinned header was unwanted. Measured on the 34-row run
 * phase table, the columns simply left the screen and did not come back.
 *
 * So the wrapper scrolls **only when it has to**. `useTableFit` measures the
 * table against its box and answers one of two modes:
 *
 *   - `fits`      — no scroll container at all, and `stickyHeadCell` on the
 *                   header cells binds to `<main>`, the shell's one scroller.
 *   - `overflows` — `overflow-x: auto` exactly as before, and the identity
 *                   column pins left instead (`stickyIdentityCell`), which
 *                   sticky CAN do inside an overflow-x wrapper.
 *
 * `DataTable` makes `fits` the normal case by dropping columns it cannot show
 * rather than letting them fall off the edge silently.
 *
 * Until the box has actually been measured neither answer is known, and the
 * honest one is `overflows`: a table rendered at every column inside a wrapper
 * that does not scroll is the one arrangement that can hide a column with no
 * way to reach it. `useTableFit` says so with `measured`.
 *
 * Never give the wrapper a max-height. `overflow-x` makes computed `overflow-y`
 * auto, so a height-capped wrapper becomes a second vertical scroller that
 * captures touch flicks meant for the page. Height always fits content here.
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
 */

/** Cell padding rides the density tokens, so `data-density` reaches tables. */
const CELL_PAD = 'px-(--tile-pad-x) py-(--tile-pad-y)';

/**
 * A header cell pinned to the shell's scroller.
 *
 * Sticky goes on the `<th>`, never on `<thead>`: a table section is not a
 * containing block in every engine, and a sectionful of sticky is one layer
 * where this is one per cell. `--z-base` exists for exactly this
 * (`theme.css`, "reserved for sticky table headers").
 *
 * Only ever applied on the `fits` branch — see the note above. A sticky header
 * inside an overflow-x wrapper is still the thing that does not work.
 *
 * Two things make it read as a header once rows slide underneath it. It is
 * painted on `--ground` — the page's own colour, so the header is the RECESSED
 * band and a hovered row (`--surface-raised`) is the raised one; they were both
 * `--surface-raised` before, which meant the row under the pointer merged into
 * the header and the table appeared to have two header rows. And it carries its
 * own bottom rule as an inset shadow: `border-collapse` gives the `<thead>`
 * border to whichever adjacent cell wins the collapse, so a border there is not
 * a rule that can be relied on to be drawn.
 */
export const stickyHeadCell = 'sticky top-0 z-(--z-base) bg-ground shadow-[inset_0_-1px_0_0_var(--rule)]';

/**
 * The identity column, pinned left while the rest of the row scrolls past.
 *
 * It has to be OPAQUE — it is the one cell scrolled content passes beneath —
 * and it has to keep the row's own tint, including the hover one, or the pinned
 * cell announces a different row than the row it belongs to. `bg-inherit` alone
 * gave only the second: a run's live row is `bg-progress/8`, so the pinned cell
 * was 92 % see-through and phase numbers were read through the Status column
 * sliding past them.
 *
 * So the cell paints both, in order, inside its own stacking context (`isolate`
 * — a negative-z child paints above the box's background and below its content,
 * and the whole group travels with the sticky cell, above the scrolled cells):
 *
 *   `::before`  the opaque base, `--surface`
 *   `::after`   the row's tint again — `bg-inherit` on a pseudo takes its
 *               ORIGINATING element's background, which is the row's
 *   content     the phase number, unclouded
 */
export const stickyIdentityCell = [
  'sticky left-0 isolate bg-inherit',
  'before:pointer-events-none before:absolute before:inset-0 before:-z-20 before:bg-surface before:content-[""]',
  'after:pointer-events-none after:absolute after:inset-0 after:-z-10 after:bg-inherit after:content-[""]',
].join(' ');

export function TableWrap({
  className,
  scrolls = true,
  ...props
}: ComponentPropsWithRef<'div'> & {
  /**
   * Whether this wrapper is a horizontal scroll container.
   *
   * `false` is what lets a sticky header reach `<main>`. Only pass it when the
   * table is known to fit — `useTableFit` is how that is known, and `measured`
   * is part of knowing.
   *
   * The default is the safe answer, because the alternative is not a table that
   * merely looks wrong. `<main>` carries `overflow-x-hidden` (`app/shell/
   * layout.tsx`) precisely so an over-wide table cannot scroll the page
   * sideways — which means an over-wide table in a wrapper that does not scroll
   * is CLIPPED, with no scrollbar anywhere to reach the clipped columns. The
   * two files are one decision: neither may be changed alone.
   */
  scrolls?: boolean;
}) {
  return (
    <div
      data-scrolls={scrolls ? '' : undefined}
      className={cn(
        'w-full max-w-full rounded-lg border border-rule',
        scrolls && 'overflow-x-auto overscroll-x-contain',
        className,
      )}
      {...props}
    />
  );
}

export function Table({
  className,
  fixed = false,
  ...props
}: ComponentPropsWithRef<'table'> & {
  /**
   * Lay out on the declared column widths instead of on the content.
   *
   * Auto layout sizes a column to its WIDEST cell across every row, which is
   * how the run phase table ended up giving Status five hundred pixels — one
   * queued phase carried a chip naming the plan it waits behind, and every
   * other row paid for it while Phase wrapped four-line titles in a hundred.
   * A table that has declared what its columns are worth should be laid out
   * on that, and cells that no longer fit should say so themselves.
   */
  fixed?: boolean;
}) {
  return (
    <table className={cn('w-full border-collapse text-sm', fixed && 'table-fixed', className)} {...props} />
  );
}

export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      /*
       * `[&_button]:uppercase` is not cosmetic. Tailwind's preflight resets
       * `text-transform: none` on `button`, so a header rendered as a sort
       * button silently opted out of the casing every other header has —
       * measured on the Plans table, the five sortable columns read "Plan ·
       * Done · Ready · Health · Activity" beside "TRACK · LEFT · REPOS · RUN".
       * The header row was announcing sortability in letterforms by accident.
       * Sort state is the arrow's job, and only the arrow's.
       *
       * `bg-ground`, not `bg-surface-raised`, and it must stay that way: the
       * row hover IS `bg-surface-raised`, so a header painted in it merged with
       * whichever row the pointer was on. The header is the recessed band and
       * the row under the pointer is the raised one — the same two tokens, the
       * other way round. `stickyHeadCell` repeats it per cell, because a cell
       * background paints over a section one under `border-collapse`.
       */
      className={cn(
        'bg-ground text-left text-2xs uppercase tracking-wide text-ink-muted [&_button]:uppercase',
        className,
      )}
      {...props}
    />
  );
}

/*
 * `TBody` and `TR` take a `ref` where the rest of the family does not, because
 * a windowed table has to address them: the virtualizer measures each row it
 * renders and needs the body's own position to know where the window sits
 * (`features/plans/route-tab.tsx`). In React 19 `ref` is an ordinary prop, so
 * this is a wider type and no `forwardRef`.
 */
export function TBody({ className, ...props }: ComponentPropsWithRef<'tbody'>) {
  return <tbody className={cn('divide-y divide-rule', className)} {...props} />;
}

export function TR({ className, ...props }: ComponentPropsWithRef<'tr'>) {
  return <tr className={cn('bg-surface hover:bg-surface-raised', className)} {...props} />;
}

export function TH({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="col" className={cn('whitespace-nowrap font-medium', CELL_PAD, className)} {...props} />;
}

export function TD({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  /*
   * `min-w-0` and `break-words` are the other half of a declared column width.
   * Under `table-fixed` the column is exactly as wide as it said it would be,
   * so a cell whose content refuses to wrap does not widen its column — it
   * escapes it, and the table is over the edge again with no scrollbar to say
   * so. Measured: one recovery-button row wanted 193px of a 120px column.
   */
  return <td className={cn('min-w-0 align-middle break-words', CELL_PAD, className)} {...props} />;
}

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
}

/** What a column costs when nothing says otherwise. */
const DEFAULT_MIN = 104;
const NUMERIC_MIN = 76;
/** Room the fold affordance itself needs inside the identity cell. */
const FOLD_AFFORDANCE = 40;
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

const minOf = <T,>(c: Column<T>): number => c.min ?? (c.align === 'end' ? NUMERIC_MIN : DEFAULT_MIN);

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
export const trackOf = <T,>(c: Column<T>): number => {
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
    const budget = keep.size + 1 === columns.length ? width : width - FOLD_AFFORDANCE;
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

/* ------------------------------------------------------------------------- *
 * DataTable — the whole arrangement, from one column array
 * ------------------------------------------------------------------------- */

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
}

export function DataTable<T>({
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
}: DataTableProps<T>) {
  const phone = usePhone();
  const navigate = useNavigate();
  const { wrapRef, tableRef, width, overflows, measured } = useTableFit();
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  const { shown, folded } = useMemo(() => planColumns(columns, width), [columns, width]);
  const identity = shown.find((c) => c.identity) ?? shown[0];
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

  if (phone && cards) {
    return (
      <CardList
        columns={columns}
        rows={rows}
        getRowKey={getRowKey}
        label={label}
        {...(detail ? { detail } : {})}
        {...(rowClassName ? { rowClassName } : {})}
        {...(rowProps ? { rowProps } : {})}
        {...(rowHref ? { rowHref } : {})}
        {...(activeSort ? { activeSort } : {})}
        {...(onSort ? { onSort } : {})}
        {...(empty != null ? { empty } : {})}
      />
    );
  }

  return (
    // Not measured yet is not "it fits": until the box has answered, the
    // wrapper scrolls, because a table at full width in a wrapper that does not
    // scroll is the arrangement that hides a column with no way to reach it.
    <TableWrap ref={wrapRef} scrolls={overflows || !measured} className={className}>
      {/* Always fixed: every column here has declared a track (`width`, else
          `min`, else the default), so laying out on the content instead would
          be ignoring what the table just said about itself. */}
      <Table ref={tableRef} aria-label={label} fixed>
        <THead>
          <TR>
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
                activeSort={activeSort}
                {...(onSort ? { onSort } : {})}
              />
            ))}
          </TR>
        </THead>
        <TBody>
          {rows.length === 0 && empty != null && (
            <TR className="hover:bg-surface">
              <TD colSpan={shown.length}>
                <EmptyBlock>{empty}</EmptyBlock>
              </TD>
            </TR>
          )}
          {rows.map((row, i) => {
            const key = getRowKey(row, i);
            const isOpen = open.has(key);
            const href = rowHref?.(row);
            return (
              <Row
                key={key}
                row={row}
                rowKey={key}
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
                {...(rowClassName?.(row) ? { className: rowClassName(row) as string } : {})}
                {...(rowProps?.(row) ?? {})}
              />
            );
          })}
        </TBody>
      </Table>
    </TableWrap>
  );
}

/**
 * Nothing here, said where the rows would be.
 *
 * The same measurements as `Empty` (`ui/feedback.tsx`) without its required
 * title, because a table's own empty line is usually one sentence and a caller
 * that wants the full block simply passes an `<Empty>` as the node.
 */
function EmptyBlock({ children }: { children: ReactNode }) {
  return (
    <div className="grid place-items-center px-4 py-10 text-center text-sm text-ink-muted">
      <div className="max-w-sm">{children}</div>
    </div>
  );
}

/**
 * Whether a click inside a row was aimed at the row, or at something in it.
 *
 * A row that navigates on click must not swallow the controls it contains, and
 * must not fire when the pointer was being used to select text — reading a
 * cell by dragging across it is not a request to leave the page.
 */
function rowClickNavigates(event: MouseEvent<HTMLElement>): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const target = event.target as HTMLElement | null;
  if (target?.closest('a,button,input,select,textarea,label,summary,[role="button"],[role="link"]')) {
    return false;
  }
  return !window.getSelection()?.toString();
}

function HeadCell<T>({
  column,
  sticky,
  pinnedLeft,
  railEdge,
  activeSort,
  onSort,
}: {
  column: Column<T>;
  sticky: boolean;
  /** Where this column sits in the pinned rail, or absent if it is not in one. */
  pinnedLeft?: number;
  /** The last column of the rail — the one that carries the rule down its right. */
  railEdge: boolean;
  activeSort?: string;
  onSort?: (id: string) => void;
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
              ...(pinned ? { left: pinnedLeft } : {}),
            },
          })}
      // A sorted column with no visible arrow is a silent claim about order.
      {...(column.sort ? { 'aria-sort': active ? column.sort.dir : 'none' } : {})}
    >
      {sortable ? (
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
      )}
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
        className="rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-accent"
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
                    className="inline-flex items-center gap-1 text-ink-faint hover:text-ink [@media(hover:none)]:min-h-(--tap-min)"
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
                      className={cn('shrink-0 font-mono text-2xs text-ink-faint', isOpen && 'invisible')}
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

/**
 * The same records, below the shell breakpoint.
 *
 * Not a table with the columns hidden — a list of records. Nine columns cannot
 * all be true at 390px, and a row that scrolls sideways on a phone is a row
 * nobody reads the end of. The card takes its shape from the same column
 * array: the identity column leads, `card: 'title'` is the headline, `'meta'`
 * joins one dim line, and everything else is a labelled pair.
 *
 * It takes the REST of the table's arrangement too, and that is not a detail.
 * It used to accept four props of the nine, so a phone silently lost the sort
 * control (the Plans list offers five orders on a desktop and none on a phone),
 * the row's own props (prefetch-on-intent, dead) and the row's destination.
 * Anything `DataTable` is given, both renderings get.
 */
function CardList<T>({
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
}: {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T, index: number) => string;
  label: string;
  detail?: (row: T) => ReactNode;
  rowClassName?: (row: T) => string | undefined;
  rowProps?: (row: T) => Record<string, unknown>;
  rowHref?: (row: T) => string | undefined;
  activeSort?: string;
  onSort?: (id: string) => void;
  empty?: ReactNode;
}) {
  const navigate = useNavigate();
  const sortLabelId = useId();
  const sortable = columns.filter((c) => c.sort);
  const identity = columns.find((c) => c.identity);
  const title = columns.find((c) => c.card === 'title') ?? columns.find((c) => c !== identity);
  // One column can be both — the plan's name says which record it is AND is
  // the thing you read. Printing it twice is the tell that a card was
  // generated rather than written.
  const lead = identity === title ? undefined : identity;
  const meta = columns.filter((c) => c.card === 'meta');
  const pairs = columns.filter((c) => c !== lead && c !== title && c.card !== 'meta' && c.card !== 'hide');

  if (!rows.length && empty != null) {
    return (
      <div className="rounded-lg border border-rule bg-surface">
        <EmptyBlock>{empty}</EmptyBlock>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* The orders the table offers, as a row of chips rather than a header
          nobody can reach: a phone has no column heads to press, and a list
          whose order cannot be changed is a different feature from the one the
          desktop has. Pressing the order in force reverses it — the same
          `onSort(id)` contract the header cell uses. */}
      {sortable.length > 0 && onSort && (
        <div role="group" aria-labelledby={sortLabelId} className="flex min-w-0 flex-wrap items-center gap-1">
          <span id={sortLabelId} className="text-2xs uppercase tracking-wide text-ink-faint">
            Sort
          </span>
          {sortable.map((c) => {
            const active = activeSort === c.sort!.id;
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={active}
                onClick={() => onSort(c.sort!.id)}
                className={cn(
                  'inline-flex min-h-(--tap-min) items-center gap-1 rounded border px-2 text-xs',
                  active ? 'border-action/40 text-action' : 'border-rule text-ink-muted',
                )}
              >
                {c.head}
                <span aria-hidden className={cn('text-2xs', !active && 'opacity-0')}>
                  {c.sort!.dir === 'ascending' ? '↑' : '↓'}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <ul aria-label={label} className="flex flex-col gap-2">
        {rows.map((row, i) => {
          const href = rowHref?.(row);
          return (
            <li
              key={getRowKey(row, i)}
              className={cn(
                'rounded-lg border border-rule bg-surface px-(--tile-pad-x) py-(--tile-pad-y)',
                rowClassName?.(row),
              )}
              {...(href
                ? {
                    'data-row-href': href,
                    onClick: (event: MouseEvent<HTMLLIElement>) => {
                      if (rowClickNavigates(event)) navigate(href);
                    },
                  }
                : {})}
              {...(rowProps?.(row) ?? {})}
            >
              <div className="flex min-w-0 items-baseline gap-2">
                {/* `lead`, not `identity`: when one column is BOTH — the plan's
                    slug names the record and is the thing you read, which is
                    three of the five tables here — this printed it twice, once
                    in mono and once as the headline. `lead` is undefined in
                    exactly that case and was computed for exactly this. */}
                {lead && <span className="shrink-0 font-mono text-2xs text-ink-faint">{lead.cell(row)}</span>}
                {title && (
                  <span className="min-w-0 flex-1 font-medium">
                    {href ? (
                      <a href={href} data-row-link="" className="rounded-sm">
                        {title.cell(row)}
                      </a>
                    ) : (
                      title.cell(row)
                    )}
                  </span>
                )}
              </div>
              {meta.length > 0 && (
                <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
                  {meta.map((c) => (
                    <span key={c.id} className="min-w-0">
                      {c.cell(row)}
                    </span>
                  ))}
                </p>
              )}
              {pairs.length > 0 && (
                <dl className="mt-1.5 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                  {pairs.map((c) => (
                    <div key={c.id} className="contents">
                      <dt className="text-2xs uppercase tracking-wide text-ink-muted">{c.head}</dt>
                      <dd className="min-w-0">{c.cell(row)}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {detail?.(row)}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
