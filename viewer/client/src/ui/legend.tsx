import type { ReactNode } from 'react';
import type { UiState } from '@shared/status-vocab.js';
import { cn } from '@/lib/cn';

/**
 * The key: each mark a drawing makes, beside the word it means — the route
 * map's station glyphs, a stacked figure's segments.
 *
 * One rule makes it a key rather than a decoration: an entry draws the REAL
 * mark, at key size — the map hands in its own station glyph, never a stand-in
 * dot, because a key of plain dots beside a map of glyphs teaches the wrong
 * thing. Where the drawing's mark IS a dot painted by state, `paint` draws that
 * dot through `.state-<paint>`, the same indirection the drawing uses, so the
 * key and the picture cannot disagree. The words are the caller's, taken from
 * the status model and the shared vocabularies, so the key never re-spells a
 * status.
 *
 * `data-slot="legend"` is the console's marker for "this surface's key is the
 * shared shape, not a hand-rolled row" — the census in
 * `ui/legend.test.tsx` counts every graphical surface by it.
 */
export interface LegendEntry {
  /** Stable across renders. */
  key: string;
  /** The word the mark means, in sentence case. */
  label: string;
  /** The drawing's own mark, at key size. Wins over `paint`. */
  mark?: ReactNode;
  /** A dot painted by state, for a drawing whose mark is one. */
  paint?: UiState;
  /** How many the drawing counts under this mark, when it counts. */
  count?: number;
}

export function Legend({ entries, className }: { entries: readonly LegendEntry[]; className?: string }) {
  if (!entries.length) return null;
  return (
    <ul
      data-slot="legend"
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-meta text-ink-muted',
        className,
      )}
    >
      {entries.map(({ key, mark, paint, label, count }) => (
        <li key={key} className="flex items-center gap-1.5">
          {mark ??
            (paint ? (
              <span aria-hidden className={cn('size-2 shrink-0 rounded-full bg-state', `state-${paint}`)} />
            ) : null)}
          {label}
          {count != null && <span className="tnum text-ink">{count}</span>}
        </li>
      ))}
    </ul>
  );
}
