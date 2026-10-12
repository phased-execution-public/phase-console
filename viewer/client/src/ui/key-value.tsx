import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** One row: a label and its value. A falsy row is skipped, so a caller can write `cond && [k, v]`. */
export type KeyValueItem = readonly [label: string, value: ReactNode] | null | undefined | false;

/**
 * Facts in two columns — the label in the meta size, the value in the body
 * size — one column on a phone. A row whose value is empty is not drawn: an
 * empty cell is a question the page cannot answer, and the page should say so
 * in words, not in blanks.
 *
 * A label and its value read as one line (quiet-console phase 27). In two
 * columns each row's cells share a baseline (`items-baseline`), so the label
 * sits on its value's FIRST line, whatever either is set in and however far
 * the value wraps. A copyable value (`Mono copyable`, a `data-copy` box) keeps
 * its 44 px thumb floor as the box — these values are stacked, so a
 * `tap-area`/`tap-line` overhang would win the taps of the rows around it
 * (design.md §6) — but writes its text at the box's TOP, so the extra height
 * hangs below the line. Centred, the text sat 13 px under its label in two
 * columns, and on a phone as far from its own label as from the next one. The
 * other shape — the label as tall as the box and centred in it — fits only a
 * one-line value: beside a value that wraps, the label would centre on its
 * middle line, and on a phone every label would sit on a 44 px strip of its own.
 */
export function KeyValue({ items, className }: { items: readonly KeyValueItem[]; className?: string }) {
  const rows = items.filter(
    (item): item is readonly [string, ReactNode] => Array.isArray(item) && item[1] != null && item[1] !== '',
  );
  if (!rows.length) return null;
  return (
    <dl
      className={cn(
        'grid grid-cols-1 items-baseline gap-x-6 gap-y-1.5 sm:grid-cols-[max-content_minmax(0,1fr)]',
        className,
      )}
    >
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="min-w-0 text-meta text-ink-muted">{label}</dt>
          <dd className="min-w-0 break-words text-body text-ink [&_[data-copy]]:items-start">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
