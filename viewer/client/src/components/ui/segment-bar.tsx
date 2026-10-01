import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { UI_STATES, type UiState } from '@/lib/status-vocab';
import { stateTally } from './legend';

/**
 * A proportional bar over the eight paints: how many phases are done, running,
 * next up, waiting, needing you — in the width of a table cell.
 *
 * The counts are keyed by PAINT, which the caller reads off the status model
 * (`describePhase(…).paint`, `describeWord('board', w).paint`): this primitive
 * is first paint and knows no status word. Every segment is painted by its
 * paint's token through `.state-<paint>` (never a colour of its own), drawn
 * worst-first so the amber sits at the left edge where a glance lands, and the
 * whole thing is one `role="img"` whose name reads the counts out in words — a
 * proportional bar is not a progress bar, and "37 %" would be the least useful
 * of its numbers.
 */
export interface SegmentCounts extends Partial<Record<UiState, number>> {}

export function SegmentBar({
  counts,
  total,
  label = 'phases',
  height = 'md',
  className,
  ...props
}: {
  counts: SegmentCounts;
  /** The denominator; defaults to the sum of the counts. A larger total leaves track unpainted. */
  total?: number;
  /** What is being counted, for the accessible name. */
  label?: string;
  height?: 'sm' | 'md';
} & HTMLAttributes<HTMLSpanElement>) {
  const segments = UI_STATES.map((paint) => ({ paint, value: Math.max(0, counts[paint] ?? 0) })).filter(
    (s) => s.value > 0,
  );
  const sum = segments.reduce((acc, s) => acc + s.value, 0);
  const denominator = Math.max(total ?? sum, sum, 1);
  // The sentence lives in `ui/legend.tsx` now, so the words under a strip and
  // the name of this bar are one walk of one vocabulary. Unchanged wording —
  // it was this component's, and it was the good one.
  const name = stateTally(counts, { ...(total == null ? {} : { total }), label });
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      className={cn(
        'flex w-full min-w-0 items-stretch gap-px overflow-hidden rounded-full bg-track',
        height === 'sm' ? 'h-1.5' : 'h-2.5',
        className,
      )}
      {...props}
    >
      {segments.map(({ paint, value }) => (
        <span
          key={paint}
          className={cn('block min-w-0 bg-state', `state-${paint}`)}
          style={{ width: `${(value / denominator) * 100}%` }}
        />
      ))}
    </span>
  );
}
