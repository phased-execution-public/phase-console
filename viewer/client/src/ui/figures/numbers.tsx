/**
 * The numbers under a figure — every figure's way back to its data.
 *
 * A figure is a reading of its rows, and the reading is lossy on purpose: a
 * Gantt answers *which phase held the lane at 14:20* in one glance and cannot
 * answer *what did attempt 2 cost to the cent*. So every figure owes its
 * numbers: a fold that names them and counts them, then the table the figure
 * was drawn from — the same rows, never a second derivation free to drift from
 * the picture above it. It is the only honest answer for the two readings an
 * SVG cannot give: a screen reader gets a sentence and a shape, and a phone
 * has no hover for the `<title>` a pointer reads.
 *
 * Nothing charted, nothing to tabulate: with no rows the fold is not drawn —
 * the figure's own empty line is the message, and a fold counting "(0)" is an
 * invitation to a blank table.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Disclosure } from '@/ui/disclosure';
import { useTableFit } from '@/ui/grid/layout';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/ui/table';

/** One column of a figure's numbers: its head, its cell, and which edge it reads from. */
export interface FigureColumn<T> {
  head: string;
  cell: (row: T) => ReactNode;
  /** `end` for a number, so a column of them lines up on its units. */
  align?: 'start' | 'end';
}

export function FigureNumbers<T>({
  label,
  caption,
  columns,
  rows,
  getRowKey,
  note,
  className,
}: {
  /** What one row IS, plural and lower case — the fold reads "The {label}". */
  label: string;
  /** The table's accessible name: a whole sentence naming what was charted. */
  caption: string;
  columns: readonly FigureColumn<T>[];
  rows: readonly T[];
  getRowKey: (row: T, index: number) => string;
  /** Anything the table cannot say about itself — a bound, an exclusion. */
  note?: ReactNode;
  className?: string;
}) {
  const { wrapRef, tableRef, overflows, measured } = useTableFit();
  if (!rows.length) return null;

  return (
    <Disclosure
      label={`The ${label}`}
      openLabel={`Hide the ${label}`}
      count={rows.length}
      className={className}
      bodyClassName="flex min-w-0 flex-col gap-1 pt-1"
    >
      {/* Scrolls sideways only when the table is measured wider than its box —
          a scroll container binds the sticky head to itself, so one that does
          not have to scroll leaves the page as the only scroller — and is then
          a stop a keyboard can reach to read the cut columns. */}
      <TableWrap
        ref={wrapRef}
        scrolls={overflows || !measured}
        {...(overflows ? { tabIndex: 0, role: 'group', 'aria-label': caption } : {})}
      >
        {/* hand-rolled because: it is the numbers BEHIND a figure, not a record
            list. Its columns are the figure's own series, it has no identity to
            pin and nothing to fold into a card, and a phone reads it as the same
            few columns the figure was drawn from. */}
        <Table ref={tableRef} className="text-meta">
          <caption className="sr-only">{caption}</caption>
          <THead>
            <tr>
              {columns.map((column) => (
                <TH key={column.head} className={column.align === 'end' ? 'text-end' : 'text-start'}>
                  {column.head}
                </TH>
              ))}
            </tr>
          </THead>
          <TBody>
            {rows.map((row, index) => (
              <TR key={getRowKey(row, index)}>
                {columns.map((column) => (
                  <TD
                    key={column.head}
                    className={cn('text-ink', column.align === 'end' ? 'tnum text-end' : 'text-start')}
                  >
                    {column.cell(row)}
                  </TD>
                ))}
              </TR>
            ))}
          </TBody>
        </Table>
      </TableWrap>
      {note != null && <p className="text-meta text-ink-muted">{note}</p>}
    </Disclosure>
  );
}
