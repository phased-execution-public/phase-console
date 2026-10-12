import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** A shape where something has not loaded yet. Only where nothing loaded — never over stale data. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn('animate-pulse rounded bg-rule', className)} {...props} />;
}

/**
 * An empty state is one line and an action (design.md §9): what this will
 * hold, and how to put the first thing in it. No illustration, no paragraph.
 */
export function Empty({
  title,
  action,
  className,
  ...props
}: { title: ReactNode; action?: ReactNode } & Omit<HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-3 text-body text-ink-muted',
        className,
      )}
      {...props}
    >
      <p className="min-w-0">{title}</p>
      {action != null && <div className="flex items-center gap-2">{action}</div>}
    </div>
  );
}

/** Something is being fetched right now. Says so to a screen reader; draws a quiet ring. */
export function Spinner({ label = 'Loading', className }: { label?: string; className?: string }) {
  return (
    <span role="status" className={cn('inline-flex items-center gap-2 text-meta text-ink-muted', className)}>
      <span
        aria-hidden
        className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-rule-strong border-t-ink-muted"
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}
