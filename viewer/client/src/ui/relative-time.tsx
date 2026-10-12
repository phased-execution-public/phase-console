import type { HTMLAttributes } from 'react';
import { useNow } from '@/lib/clock';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/format';

/**
 * A clock, relative — "4 minutes ago", "in 2 hours", "just now" within a
 * minute either side — in the sans with tabular numerals (design.md §2: a time
 * is not a machine value). The absolute time is the title; `live` keeps it
 * ticking while it is on screen.
 */
export function RelativeTime({
  at,
  live = true,
  intervalMs = 30_000,
  className,
  title,
  ...props
}: {
  at: number | string | null | undefined;
  live?: boolean;
  intervalMs?: number;
} & HTMLAttributes<HTMLElement>) {
  const ms = at == null ? NaN : typeof at === 'number' ? at : Date.parse(at);
  useNow(live && Number.isFinite(ms), intervalMs);
  if (!Number.isFinite(ms)) return <span className={cn('text-ink-faint', className)}>—</span>;
  const date = new Date(ms);
  return (
    <time
      dateTime={date.toISOString()}
      title={title ?? date.toLocaleString()}
      className={cn('tnum', className)}
      {...props}
    >
      {relativeTime(ms)}
    </time>
  );
}
