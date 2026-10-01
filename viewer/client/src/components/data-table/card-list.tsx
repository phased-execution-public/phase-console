import { useId, useLayoutEffect, useRef, type MouseEvent, type ReactNode, type Ref } from 'react';
import { useNavigate } from '@/app/router';
import { cn } from '@/lib/cn';
import type { GridItem, VirtualWindow } from './engine';
import { NO_VALUE, type Column } from './layout';

/**
 * Nothing here, said where the rows would be.
 *
 * The same measurements as `Empty` (`ui/feedback.tsx`) without its required
 * title, because a table's own empty line is usually one sentence and a caller
 * that wants the full block simply passes an `<Empty>` as the node.
 */
export function EmptyBlock({ children }: { children: ReactNode }) {
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
export function rowClickNavigates(event: MouseEvent<HTMLElement>): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const target = event.target as HTMLElement | null;
  if (target?.closest('a,button,input,select,textarea,label,summary,[role="button"],[role="link"]')) {
    return false;
  }
  return !window.getSelection()?.toString();
}

/** How a group's value reads in its heading. A blank is said, not left blank. */
export const groupLabel = (value: string | number): string => (value === NO_VALUE ? 'none' : String(value));

/**
 * One record's pick box — the issues board's native checkbox, once, for every
 * grid (`features/repo/issues.tsx` says why it is native: the row already
 * handles its own click, and the label gives the thumb floor with no second
 * wrapper). The floor is released only where a pointer can hover: a tablet is
 * as coarse a pointer as a phone, whatever its width.
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
  // `indeterminate` is a DOM property with no attribute and no React prop, so
  // it is set after every commit that could have moved it.
  const box = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (box.current) box.current.indeterminate = indeterminate;
  });
  return (
    <label className="flex min-h-(--tap-min) min-w-(--tap-min) cursor-pointer items-center justify-center [@media(hover:hover)]:sm:min-h-0 [@media(hover:hover)]:sm:min-w-0">
      <input
        type="checkbox"
        checked={checked}
        ref={box}
        onChange={onToggle}
        aria-label={label}
        className="size-4 accent-[var(--accent)]"
      />
    </label>
  );
}

/** What a card list needs to offer picks: the grid's selection, by row key. */
export interface CardPick<T> {
  isPicked: (key: string) => boolean;
  toggle: (key: string) => void;
  labelOf: (row: T) => string;
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
 * Anything `DataTable` is given, both renderings get — since control-tower
 * phase 18 that includes the grid's own features: a pick box per card, the
 * group headings, the columns the operator hid (folded into each card under a
 * disclosure, never dropped) and the window.
 */
export function CardList<T>({
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
  items,
  hidden = [],
  pick,
  onToggleGroup,
  win,
  anchor,
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
  /** The grid's row model, when a feature asked for one — else `rows` as given. */
  items?: GridItem<T>[];
  /** The columns the operator hid: each card keeps them behind a disclosure. */
  hidden?: Column<T>[];
  pick?: CardPick<T>;
  onToggleGroup?: (key: string) => void;
  /** Only the cards in view are drawn, when the table asked for a window. */
  win?: VirtualWindow | null;
  anchor?: Ref<HTMLUListElement>;
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

  const card = (row: T, key: string, slot?: { ref: (node: Element | null) => void; index: number }) => {
    const href = rowHref?.(row);
    // The card's own attributes, in the order they always had: a caller's
    // `rowProps` still wins over everything before it.
    const attrs = {
      className: cn(
        'rounded-lg border border-rule bg-surface px-(--tile-pad-x) py-(--tile-pad-y)',
        rowClassName?.(row),
      ),
      ...(href
        ? {
            'data-row-href': href,
            onClick: (event: MouseEvent<HTMLElement>) => {
              if (rowClickNavigates(event)) navigate(href);
            },
          }
        : {}),
      ...(rowProps?.(row) ?? {}),
    };
    const body = (
      <>
        <div className="flex min-w-0 items-baseline gap-2">
          {pick && (
            <span className="-my-2 shrink-0 self-center">
              <PickBox
                checked={pick.isPicked(key)}
                label={`Select ${pick.labelOf(row)}`}
                onToggle={() => pick.toggle(key)}
              />
            </span>
          )}
          {/* `lead`, not `identity`: when one column is BOTH — the plan's
              slug names the record and is the thing you read, which is
              three of the five tables here — this printed it twice, once
              in mono and once as the headline. `lead` is undefined in
              exactly that case and was computed for exactly this. */}
          {/* Muted, not faint: the lead is read — a phase's number, a run's id —
              and faint fails AA at this size on a tinted card. */}
          {lead && <span className="shrink-0 font-mono text-2xs text-ink-muted">{lead.cell(row)}</span>}
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
        {/* What the operator hid is folded here, not dropped — the card's
            twin of the table's row detail, and a native disclosure so it
            costs no state and opens from the keyboard. */}
        {hidden.length > 0 && (
          <details className="mt-1.5 text-xs">
            <summary className="flex min-h-(--tap-min) cursor-pointer items-center text-2xs text-ink-muted [@media(hover:hover)]:sm:min-h-0">
              {`${hidden.length} hidden column${hidden.length === 1 ? '' : 's'}`}
            </summary>
            <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
              {hidden.map((c) => (
                <div key={c.id} className="contents">
                  <dt className="text-2xs uppercase tracking-wide text-ink-muted">{c.head}</dt>
                  <dd className="min-w-0">{c.cell(row)}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
        {detail?.(row)}
      </>
    );
    if (!slot) {
      return (
        <li key={key} {...attrs}>
          {body}
        </li>
      );
    }
    // Windowed, the measured box is an outer item that carries the gap as its
    // own padding: a margin is outside every box the virtualizer can measure,
    // and a gap it cannot see is a list whose model and page disagree.
    return (
      <li key={key} ref={slot.ref} data-index={slot.index} className="pb-2">
        <div {...attrs}>{body}</div>
      </li>
    );
  };

  const heading = (
    item: Extract<GridItem<T>, { kind: 'group' }>,
    extra?: { ref?: (node: Element | null) => void; index?: number },
  ) => {
    const column = columns.find((c) => c.id === item.column);
    return (
      <li key={item.key} ref={extra?.ref} data-index={extra?.index} className={extra ? 'pb-2' : undefined}>
        <button
          type="button"
          aria-expanded={item.open}
          onClick={() => onToggleGroup?.(item.key)}
          className="flex min-h-(--tap-min) w-full cursor-pointer items-center gap-2 text-left"
        >
          <span aria-hidden="true" className="font-mono text-2xs text-ink-faint">
            {item.open ? '▾' : '▸'}
          </span>
          {column && <span className="sr-only">{`${column.head}: `}</span>}
          <strong className="text-2xs">{column?.groupLabel?.(item.value) ?? groupLabel(item.value)}</strong>
          <span className="font-mono text-2xs text-ink-faint tabular-nums">{item.count}</span>
        </button>
      </li>
    );
  };

  const list: GridItem<T>[] =
    items ?? rows.map((row, i) => ({ kind: 'row', key: getRowKey(row, i), row, index: i }));
  const windowed = Boolean(win && (win.padTop > 0 || win.padBottom > 0 || win.indexes.length < list.length));

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
      {windowed && win ? (
        /* The window's list: spacers of computed height stand in for the cards
           not drawn, and each drawn card carries its own bottom gap so the
           virtualizer measures what the page actually lays out. */
        <ul aria-label={label} className="flex flex-col" ref={anchor}>
          <li aria-hidden="true" style={{ height: win.padTop }} />
          {win.indexes.map((i) => {
            const item = list[i]!;
            const slot = { ref: win.measure, index: i };
            return item.kind === 'group' ? heading(item, slot) : card(item.row, item.key, slot);
          })}
          <li aria-hidden="true" style={{ height: win.padBottom }} />
        </ul>
      ) : (
        <ul aria-label={label} className="flex flex-col gap-2" ref={anchor}>
          {list.map((item) => (item.kind === 'group' ? heading(item) : card(item.row, item.key)))}
        </ul>
      )}
    </div>
  );
}
