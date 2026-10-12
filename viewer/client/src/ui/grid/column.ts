import type { ReactNode } from 'react';
import type { ColumnTrack, FilterKind } from './layout';

/**
 * The grid's column — one declaration, three renderings.
 *
 * A table used to be written three times: the wide one, whatever a phone got,
 * and a hand-written card list beside it, and the tables with no card list at
 * all were what happened when writing the third copy was expensive. A column
 * knows its own head, its own cell, how hard it fights to stay on screen, what
 * a phone's card does with it and which reading it belongs to, so the wide
 * table, its folded cut and the phone's card list all come from one array
 * (`grid.tsx`, `card-list.tsx`).
 *
 * ## The two readings
 *
 * Everything (design.md §1, principle 3; `ui/everything.ts`) is a page's switch
 * between the essentials and all of it. A column marked `everything` is not on
 * the glance: it FOLDS into the row's detail, counted on the row's `+N`, one
 * press away — and with Everything on it is a column like the others. With
 * Everything on nothing folds to fit, either: every column is drawn and the
 * table scrolls sideways inside its own box with the identity pinned, because
 * "all columns" that folded again would be the essentials under another name.
 * A column the operator hid stays folded in both readings — that was their
 * choice about this table, and Everything is a question about the page.
 */

/**
 * What a phone's card does with a column. Absent: a labelled pair, in the
 * card's fold at the glance and on the card itself with Everything on.
 *
 *   `title`   the card's headline, drawn as the record's link when it has one;
 *   `meta`    one more word on the card's quiet line under the headline — a
 *             status, a clock, a figure: what the glance must say;
 *   `action`  the card's one action, at the end of its first line;
 *   `none`    not drawn on a card at all — only for a column that carries no
 *             datum of its own (a pick box, a control whose verbs the card
 *             draws elsewhere). A datum is never `none`: no datum removed.
 */
export type CardRole = 'title' | 'meta' | 'action' | 'none';

export interface Column<T> extends ColumnTrack {
  id: string;
  /** Plain words in sentence case. `THead` draws them as they are written. */
  head: string;
  cell: (row: T) => ReactNode;
  /**
   * The narrowest this column reads at, in px — REQUIRED, measured against the
   * widest real content the column holds. The cut budgets it, the layout lays
   * it out (unless `width` says otherwise), and a cell that refuses to wrap
   * inside it escapes the column rather than widening it — `useTableFit` then
   * reads the table over its box and the sticky header goes for one chip.
   * Widen the `min`; never `whitespace-nowrap` the cell (`styles/touch.test.ts`).
   */
  min: number;
  /**
   * How hard this column fights to stay on screen. `1` is never dropped;
   * anything higher is folded into the row's detail, smallest first, until
   * what is left fits. Default `3`.
   */
  priority?: number;
  align?: 'start' | 'end';
  /**
   * An explicit track under fixed layout, when the column is laid out wider
   * than its `min`. The cut budgets this same number (`trackOf`), so the cut and
   * the layout can never disagree about what fits.
   */
  width?: string;
  /**
   * The column that absorbs whatever is left over — exactly one per table, and
   * usually the identity's text. It still declares its `min`: the floor it
   * never gives up, which is what a record's name is worth.
   */
  flex?: true;
  /**
   * The one column that says WHICH RECORD this is: never folded, pinned at the
   * start when the table scrolls, the holder of the row's toggle and its link.
   */
  identity?: true;
  /**
   * The column belongs to Everything: folded into the row's detail at the
   * glance, drawn as a column with Everything on. The identity ignores it.
   */
  everything?: true;
  /** What a phone's card does with it — see `CardRole`. */
  card?: CardRole;
  /**
   * Extra classes for this column's `<td>`, and only the `<td>` — for vertical
   * alignment (a two-line cell reading `align-top` beside one-line neighbours).
   * Never a way out of the track: `whitespace-nowrap` here is banned by
   * `styles/touch.test.ts`.
   */
  cellClassName?: string;
  /** Offer this column as an order in the header and the toolbar's sort. */
  sort?: { id: string; dir: 'ascending' | 'descending' };
  /**
   * The column's datum as a plain value — what a filter tests, a facet counts
   * and a group heading names. `cell` renders; this is what the cell MEANS. A
   * column without one can be shown, folded and hidden, never filtered or
   * grouped by: a rendered node is not a value anyone can compare.
   */
  value?: (row: T) => string | number | null | undefined;
  /**
   * A filter in the toolbar: `text` (the value contains what was typed — the
   * first such column is the toolbar's search), `facet` (the value is one of
   * those ticked, each listed with its count) or `range` (a number between two
   * ends). Needs `value`.
   */
  filter?: FilterKind;
  /** Offer this column in the toolbar's group. Needs `value`. */
  groupable?: boolean;
  /** What a group heading SAYS for one of this column's values (an id's word). Default: the value. */
  groupLabel?: (value: string | number) => string;
  /** Where a group sits among its siblings, lowest first. Default: the order the rows carry the values in. */
  groupOrder?: (value: string | number) => number;
  /**
   * Whether the operator may hide it from the toolbar's columns. Default: every
   * column but the identity. Hiding is not deleting — a hidden column folds
   * into the row's detail, counted on its `+N` (no datum removed).
   */
  hideable?: boolean;
}

/**
 * Which columns a reading offers, and which it withholds into the row's
 * detail. Everything on offers all of them; the essentials withhold the
 * columns marked `everything`, except the identity, which no reading folds.
 */
export function readingOf<T>(
  columns: readonly Column<T>[],
  everything: boolean,
): { offered: Column<T>[]; withheld: Column<T>[] } {
  if (everything) return { offered: [...columns], withheld: [] };
  const offered: Column<T>[] = [];
  const withheld: Column<T>[] = [];
  for (const column of columns) {
    if (column.everything && !column.identity) withheld.push(column);
    else offered.push(column);
  }
  return { offered, withheld };
}

/** The first column a search box can stand for: a `text` filter with a value. */
export const searchColumnOf = <T>(columns: readonly Column<T>[]): Column<T> | undefined =>
  columns.find((c) => c.filter === 'text' && c.value);
