import { ArrowDown, ArrowUp, ChevronRight } from 'lucide-react';
import { useId, type MouseEvent, type ReactNode, type Ref } from 'react';
import type { UiState } from '@shared/status-vocab.js';
import { cn } from '@/lib/cn';
import { Button } from '../button';
import { Checkbox } from '../checkbox';
import { Disclosure } from '../disclosure';
import type { Column } from './column';
import type { GridItem, VirtualWindow } from './engine';
import { NO_VALUE } from './layout';

/**
 * Whether a click inside a row was aimed at the row, or at something in it.
 *
 * A row that navigates on click must not swallow the controls it contains, and
 * must not fire when the pointer was being used to select text — reading a
 * cell by dragging across it is not a request to leave the page.
 */
export function rowClickNavigates(event: MouseEvent<HTMLElement>): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const target = event.target as HTMLElement | null;
  if (target?.closest('a,button,input,select,textarea,label,summary,[role="button"],[role="link"]')) {
    return false;
  }
  return !window.getSelection()?.toString();
}

/**
 * A row's click, followed through its own link. The row's destination is a
 * real `<a>` — tabbable, middle-clickable, its address in the status bar — so
 * the rest of the row hands a plain click to it rather than navigating beside
 * it. The kit knows no router; the link is the router's.
 */
export function followRowLink(event: MouseEvent<HTMLElement>): void {
  if (!rowClickNavigates(event)) return;
  event.currentTarget.querySelector<HTMLAnchorElement>('a[data-row-link]')?.click();
}

/** How a group's value reads in its heading. A blank is said, not left blank. */
export const groupLabel = (value: string | number): string => (value === NO_VALUE ? 'none' : String(value));

/**
 * One record's pick box — the kit's checkbox, so a picked row is ink and never
 * amber (a pick has not made a row urgent). Its hit area is the thumb floor on
 * touch (`tap-area`), so the box stays small and the target does not.
 */
export function PickBox({
  checked,
  label,
  onToggle,
  indeterminate = false,
}: {
  checked: boolean;
  label: string;
  onToggle: () => void;
  indeterminate?: boolean;
}) {
  return (
    <Checkbox
      checked={indeterminate ? 'indeterminate' : checked}
      onCheckedChange={onToggle}
      aria-label={label}
    />
  );
}

/** What a card list needs to offer picks: the grid's selection, by row key. */
export interface CardPick<T> {
  isPicked: (key: string) => boolean;
  toggle: (key: string) => void;
  labelOf: (row: T) => string;
}

/** A group's heading: a button that folds it, its word, and how many records it holds. */
export function GroupHeading({
  label,
  count,
  open,
  controls,
  onToggle,
  column,
}: {
  label: string;
  count: number;
  open: boolean;
  controls?: string;
  onToggle: () => void;
  /** The grouping column's head, said to a screen reader before the value. */
  column?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      {...(controls ? { 'aria-controls': controls } : {})}
      onClick={onToggle}
      className="flex min-h-8 w-full cursor-pointer items-center gap-2 text-start [@media(hover:none)]:min-h-(--tap-min)"
    >
      <ChevronRight
        size={14}
        aria-hidden
        className={cn(
          'shrink-0 text-ink-faint transition-transform duration-fast ease-transit',
          open && 'rotate-90',
        )}
      />
      {column && <span className="sr-only">{`${column}: `}</span>}
      <span className="text-meta font-medium text-ink">{label}</span>
      <span className="tnum text-meta text-ink-muted">{count}</span>
    </button>
  );
}

/**
 * Facts as a two-column list: each column's head, and the row's value beside it
 * on one baseline. A copyable value is a 44 px box on touch with its text
 * centred; here its text stands at the box's top (`data-copy`, as `KeyValue`
 * does), so the value reads on its head's line and the extra height hangs below.
 */
export function Facts<T>({ columns, row, className }: { columns: Column<T>[]; row: T; className?: string }) {
  return (
    <dl
      className={cn('grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1', className)}
    >
      {columns.map((c) => (
        <div key={c.id} className="contents">
          <dt className="text-meta text-ink-muted">{c.head}</dt>
          <dd className="min-w-0 break-words text-body text-ink [&_[data-copy]]:items-start">
            {c.cell(row)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The same records, below the shell breakpoint: a list, not a table with the
 * columns hidden — nine columns cannot all be true at 360 px, and a row that
 * scrolls sideways on a phone is a row nobody reads the end of.
 *
 * Each record is ONE line at the glance (design.md §1, principle 2), taken from
 * the same column array: the identity leads, `card: 'title'` is the headline
 * and the record's link, `'meta'` columns are the quiet line under it, `'action'`
 * the one action at the end. Every other column is a labelled fact in the
 * record's fold — one press away — and with Everything on the facts are drawn
 * on the record itself; what the reading withholds and what the operator hid
 * stay in the fold either way. No datum removed.
 *
 * The records sit on one surface separated by rules, as the table's rows do:
 * a phone shows the table's rows reflowed, not a stack of cards.
 */
export function CardList<T>({
  visible,
  folded,
  everything,
  items,
  label,
  detail,
  rowClassName,
  rowPaint,
  rowProps,
  rowHref,
  activeSort,
  onSort,
  sortControls,
  empty,
  pick,
  isOpen,
  onToggle,
  onToggleGroup,
  win,
  anchor,
}: {
  /** The columns this reading draws, in order — the grid's columns less what it withholds and the operator hid. */
  visible: Column<T>[];
  /** What the reading withholds and the operator hid: in every record's fold. */
  folded: Column<T>[];
  everything: boolean;
  items: GridItem<T>[];
  label: string;
  detail?: (row: T) => ReactNode;
  rowClassName?: (row: T) => string | undefined;
  /** The grid's `rowPaint`: a record in a state is a strip here too — its edge, its tint while open. */
  rowPaint?: (row: T) => UiState | undefined;
  rowProps?: (row: T) => Record<string, unknown>;
  rowHref?: (row: T) => string | undefined;
  activeSort?: string;
  onSort?: (id: string) => void;
  /**
   * Draw the orders above the records. A grid with a toolbar carries them in
   * its sort slot instead; one without would leave a phone no way to reorder
   * what a desk reorders from its headers.
   */
  sortControls: boolean;
  empty?: ReactNode;
  pick?: CardPick<T>;
  /** Whether a record's fold is open, by key — the grid's, so a fold survives the window. */
  isOpen: (key: string) => boolean;
  onToggle: (key: string) => void;
  onToggleGroup: (key: string) => void;
  /** Only the records in view are drawn, when the grid asked for a window. */
  win?: VirtualWindow | null;
  anchor?: Ref<HTMLUListElement>;
}) {
  const sortLabelId = useId();
  const sortable = visible.filter((c) => c.sort);
  const drawn = visible.filter((c) => c.card !== 'none');
  const identity = drawn.find((c) => c.identity);
  const title = drawn.find((c) => c.card === 'title') ?? identity ?? drawn[0];
  // One column can be both — the plan's slug names the record AND is the thing
  // you read. Printing it twice is the tell that a card was generated.
  const lead = identity === title ? undefined : identity;
  const meta = drawn.filter((c) => c.card === 'meta' && c !== title && c !== lead);
  const action = drawn.find((c) => c.card === 'action' && c !== title && c !== lead);
  const facts = drawn.filter((c) => c !== title && c !== lead && c !== action && !meta.includes(c));
  const order = new Map([...visible, ...folded].map((c, i) => [c.id, i] as const));
  const inFold = (everything ? folded : [...facts, ...folded]).sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );
  const onRecord = everything ? facts : [];

  if (!items.length && empty != null) {
    return (
      <div className="rounded-lg border border-rule bg-surface px-(--tile-pad-x) py-(--tile-pad-y)">
        {empty}
      </div>
    );
  }

  const record = (
    row: T,
    key: string,
    first: boolean,
    slot?: { ref: (node: Element | null) => void; index: number },
  ) => {
    const href = rowHref?.(row);
    const open = isOpen(key);
    const paint = rowPaint?.(row);
    const body = (
      <div className="flex min-w-0 items-start gap-2">
        {/* A strip's leading edge, down the record's start side (the grid's header). */}
        {paint && (
          <span
            aria-hidden
            data-strip-edge=""
            className={cn(
              'pointer-events-none absolute inset-y-0 start-0 w-1 bg-state-vivid',
              `state-${paint}`,
            )}
          />
        )}
        {pick && (
          <span className="flex h-6 shrink-0 items-center">
            <PickBox
              checked={pick.isPicked(key)}
              label={`Select ${pick.labelOf(row)}`}
              onToggle={() => pick.toggle(key)}
            />
          </span>
        )}
        <div className="min-w-32 flex-1">
          {/* The head: the title, and the one action beside it — or under it,
              once the two no longer share a line (a phase's remedy is 252 px).
              Only the head is shared: the quiet line, the facts and the fold
              take the record's whole width, so a wide action never narrows
              them to half a phone. */}
          <div className="flex min-w-0 flex-wrap items-start gap-x-4 gap-y-1.5">
            <div className="flex min-w-[min(100%,12rem)] flex-1 items-baseline gap-2">
              {lead && <span className="shrink-0 text-meta text-ink-muted">{lead.cell(row)}</span>}
              {title && (
                <span className="min-w-0 flex-1 break-words text-body font-medium text-ink">
                  {href ? (
                    // A block: a title that wraps is still ONE box. An inline
                    // link's box spans its lines and its middle falls between
                    // them, where a tap lands on the card and not the link (the
                    // register's touch-present). A block also keeps the lead
                    // beside it on the title's FIRST baseline, which an
                    // inline-block, aligned on its last line, would not.
                    <a href={href} data-row-link="" className="block rounded-sm hover:underline">
                      {title.cell(row)}
                    </a>
                  ) : (
                    title.cell(row)
                  )}
                </span>
              )}
            </div>
            {action && (
              // Its own clearance: a small control here reaches past its box on a
              // touch screen (`tap-area`: 44 px around a 16 px checkbox, 14 px a
              // side), so the gap beside the title is 16 px. Under the title it
              // starts at the record's edge, as every other line does.
              <div className="flex min-w-0 max-w-full items-center justify-end">{action.cell(row)}</div>
            )}
          </div>
          {meta.length > 0 && (
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-meta text-ink-muted">
              {meta.map((c) => (
                <span key={c.id} className="min-w-0 break-words">
                  {c.cell(row)}
                </span>
              ))}
            </div>
          )}
          {onRecord.length > 0 && <Facts columns={onRecord} row={row} className="mt-1.5" />}
          {(inFold.length > 0 || detail) && (
            <Disclosure
              open={open}
              onOpenChange={() => onToggle(key)}
              label="Details"
              variant="inline"
              openLabel="Hide details"
              {...(inFold.length ? { count: inFold.length } : {})}
              className="mt-1"
              bodyClassName="flex flex-col gap-2 pt-1.5"
            >
              {inFold.length > 0 && <Facts columns={inFold} row={row} />}
              {detail?.(row)}
            </Disclosure>
          )}
        </div>
      </div>
    );
    const attrs = {
      className: cn(
        'min-w-0 px-(--tile-pad-x) py-(--tile-pad-y)',
        !first && 'border-t border-rule',
        paint && 'relative',
        // An open strip sits on its state's tint.
        paint && open && cn(`state-${paint}`, 'bg-state-tint'),
        rowClassName?.(row),
      ),
      'data-open': open ? '' : undefined,
      ...(paint ? { 'data-strip': paint } : {}),
      ...(href ? { 'data-row-href': href, onClick: followRowLink } : {}),
      // A caller's `rowProps` still wins over everything before it.
      ...(rowProps?.(row) ?? {}),
    };
    if (!slot) {
      return (
        <li key={key} {...attrs}>
          {body}
        </li>
      );
    }
    return (
      <li key={key} ref={slot.ref} data-index={slot.index} {...attrs}>
        {body}
      </li>
    );
  };

  const heading = (
    item: Extract<GridItem<T>, { kind: 'group' }>,
    first: boolean,
    slot?: { ref: (node: Element | null) => void; index: number },
  ) => {
    const column = visible.find((c) => c.id === item.column) ?? folded.find((c) => c.id === item.column);
    return (
      <li
        key={item.key}
        ref={slot?.ref}
        data-index={slot?.index}
        className={cn('bg-ground-deep px-(--tile-pad-x) py-0.5', !first && 'border-t border-rule')}
      >
        <GroupHeading
          label={column?.groupLabel?.(item.value) ?? groupLabel(item.value)}
          count={item.count}
          open={item.open}
          onToggle={() => onToggleGroup(item.key)}
          {...(column ? { column: column.head } : {})}
        />
      </li>
    );
  };

  const windowed = Boolean(win && (win.padTop > 0 || win.padBottom > 0 || win.indexes.length < items.length));
  const indexes = windowed && win ? win.indexes : items.map((_, i) => i);
  const slotOf = (i: number) => (windowed && win ? { ref: win.measure, index: i } : undefined);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {sortControls && sortable.length > 0 && onSort && (
        // A phone has no column heads to press: the orders the desk offers are
        // here, and pressing the order in force asks the page to reverse it —
        // the same `onSort(id)` the header cell sends.
        <div
          role="group"
          aria-labelledby={sortLabelId}
          className="flex min-w-0 flex-wrap items-center gap-1.5"
        >
          <span id={sortLabelId} className="text-meta text-ink-muted">
            Sort
          </span>
          {sortable.map((c) => {
            const active = activeSort === c.sort!.id;
            const Arrow = c.sort!.dir === 'ascending' ? ArrowUp : ArrowDown;
            return (
              <Button key={c.id} size="sm" aria-pressed={active} onClick={() => onSort(c.sort!.id)}>
                {c.head}
                <Arrow size={12} aria-hidden className={cn(!active && 'opacity-0')} />
              </Button>
            );
          })}
        </div>
      )}
      <ul
        aria-label={label}
        ref={anchor}
        className="flex min-w-0 flex-col rounded-lg border border-rule bg-surface"
      >
        {windowed && win && <li aria-hidden="true" style={{ height: win.padTop }} />}
        {indexes.map((i, n) => {
          const item = items[i]!;
          const first = n === 0 && !(windowed && win && win.padTop > 0);
          return item.kind === 'group'
            ? heading(item, first, slotOf(i))
            : record(item.row, item.key, first, slotOf(i));
        })}
        {windowed && win && <li aria-hidden="true" style={{ height: win.padBottom }} />}
      </ul>
    </div>
  );
}
