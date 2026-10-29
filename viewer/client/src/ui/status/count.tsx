import type { UiState } from '@shared/status-vocab.js';
import { cn } from '@/lib/cn';

/**
 * A count on a tab or a fold's head (2026-10-20, Tower strips): the number in
 * a small pill, quiet in ink by default. Given a `paint` it takes that
 * state's tint and word colour — the worst thing the count holds (a reading
 * whose QA failed counts its fails in red) — so the hue still comes only from
 * the state classes, and the number is never the only carrier: a caller
 * names what is counted in `label`, which a screen reader hears instead.
 */
export function CountBadge({
  count,
  paint,
  label,
  className,
}: {
  count: number;
  /** The state the count is about, when it is one — else the pill is quiet ink. */
  paint?: UiState | undefined;
  /** What is counted, in words: "3 phases with a QA fail". */
  label?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      data-count={count}
      data-paint={paint}
      {...(label ? { 'aria-label': label, role: 'img' } : {})}
      className={cn(
        'inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-meta leading-[1.4] font-semibold tabular-nums',
        paint ? `state-${paint} bg-state-tint text-state` : 'bg-ground-deep text-ink-muted',
        className,
      )}
    >
      {count}
    </span>
  );
}
