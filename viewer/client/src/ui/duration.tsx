import type { HTMLAttributes } from 'react';
import { useNow } from '@/ui/clock';
import { cn } from '@/lib/cn';
import { duration, elapsed } from '@/lib/format';

/** `PT1H2M3S` — the machine-readable twin a `<time>` carries. */
export function isoDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}${s || (!h && !m) ? `${s}S` : ''}`;
}

/**
 * A span of time — a run's age, a phase's wall clock — in the sans with
 * tabular numerals. Give it `ms`, or `since` and `live` to let it tick.
 */
export function Duration({
  ms,
  since,
  live = false,
  className,
  ...props
}: { ms?: number | null; since?: number | null; live?: boolean } & HTMLAttributes<HTMLElement>) {
  const now = useNow(live && since != null, 1000);
  const value = ms ?? (since != null ? Math.max(0, now - since) : null);
  if (value == null || !Number.isFinite(value))
    return <span className={cn('text-ink-faint', className)}>—</span>;
  return (
    <time dateTime={isoDuration(value)} className={cn('tnum', className)} {...props}>
      {live ? elapsed(value) : duration(value)}
    </time>
  );
}
