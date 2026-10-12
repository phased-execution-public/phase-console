import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { money } from '@/lib/format';

/**
 * A sum, in the sans with tabular numerals (design.md §2: money is not a
 * machine value). Against a budget it says so in its title, and reads in the
 * failed hue only once it is over.
 */
export function Money({
  usd,
  against,
  className,
  title,
  ...props
}: { usd: number | null | undefined; against?: number | null } & HTMLAttributes<HTMLSpanElement>) {
  if (usd == null) return <span className={cn('text-ink-faint', className)}>—</span>;
  const over = against != null && against > 0 && usd > against;
  const budget =
    against != null && against > 0 ? ` of a ${money(against)} budget${over ? ' — over' : ''}` : '';
  return (
    <span
      className={cn('tnum', over && 'text-failed', className)}
      title={title ?? `${money(usd)}${budget}`}
      {...props}
    >
      {money(usd)}
    </span>
  );
}
