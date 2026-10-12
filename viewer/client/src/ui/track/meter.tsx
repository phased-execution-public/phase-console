import type { ReactNode } from 'react';
import type { UiState } from '@shared/status-vocab.js';
import { cn } from '@/lib/cn';

/**
 * The line's short form: one share of one whole, drawn on the track's own
 * ground — ladder spend against the day cap, a phase against a session.
 *
 * A MARK, not a figure (design.md §8.2): one datum, and the words beside it
 * are its table, so it owes no numbers fold and draws no axis. It is a real
 * `role="meter"` with the numbers on it, so a screen reader hears "$2.50 of
 * $40.00" and never a decoration. The quarter ticks are what make the bar
 * readable without the figure beside it, which is what a phone needs.
 *
 * The fill is clamped to the track; the numbers are not, and past the whole
 * the title says so. Paint is a state through `.state-<paint>`, the one
 * indirection every drawing uses.
 */
export function LoadMeter({
  value,
  max,
  label,
  valueText,
  reading,
  paint = 'running',
  className,
}: {
  /** The part. Absent, or with no whole to read it against, there is no meter — only `reading`. */
  value: number | null | undefined;
  /** The whole. */
  max: number | null | undefined;
  /** The meter's accessible name: what is measured against what. */
  label: string;
  /** The exact reading, in words — "$2.50 of $40.00". */
  valueText?: string;
  /** A few characters at the bar's end, or the whole answer when there is no meter. */
  reading?: ReactNode;
  paint?: UiState;
  className?: string;
}) {
  if (value == null || max == null || !(max > 0)) {
    return reading == null ? null : (
      <span className={cn('text-meta text-ink-faint', className)}>{reading}</span>
    );
  }
  const share = Math.min(1, Math.max(0, value / max));
  const over = value > max;
  return (
    <span className={cn('flex min-w-0 items-center gap-2', className)}>
      <span
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={valueText}
        title={`${label}: ${valueText ?? value}${over ? ' — over' : ''}`}
        className={cn(
          'relative block h-1.5 min-w-12 flex-1 overflow-hidden rounded-full bg-track',
          `state-${paint}`,
        )}
      >
        <span
          className="block h-full rounded-full bg-state"
          style={{ width: `${Math.round(share * 100)}%` }}
        />
        {[0.25, 0.5, 0.75].map((tick) => (
          <span
            key={tick}
            aria-hidden
            className="absolute inset-y-0 w-px bg-ground/70"
            style={{ insetInlineStart: `${tick * 100}%` }}
          />
        ))}
      </span>
      {reading != null && <span className="shrink-0 text-meta text-ink-muted tnum">{reading}</span>}
    </span>
  );
}
