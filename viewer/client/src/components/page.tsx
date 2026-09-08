import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The page frame every view sits in.
 *
 * `min-w-0` on the scroll container is the whole reason a wide table or a long
 * command does not push the phone sideways: a grid child's default `min-width:
 * auto` lets its content set the track width, and one over-wide cell then makes
 * the *shell* scroll, taking the tab bar off the edge of the screen with it.
 */
export function Page({
  title,
  subtitle,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mx-auto w-full min-w-0 max-w-(--content-max) px-3 py-4 md:px-5', className)}>
      {(title != null || actions != null) && (
        <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            {title != null && <h1 className="font-display text-3xl leading-none">{title}</h1>}
            {subtitle != null && <p className="mt-1.5 text-sm text-ink-muted">{subtitle}</p>}
          </div>
          {/* `min-w-0`, never `shrink-0`. This row holds whatever a page puts
              in it — a select whose widest option is a plan slug, chips
              carrying counts that grow a digit — and `shrink-0` on a
              variable-length row makes it PUSH the page rather than wrap
              inside it. Measured on Insights at 320: 322.8 in a 320 track, and
              the shell scrolled sideways. `flex-wrap` alone does not save it,
              because a row that may not shrink has nothing to wrap into. */}
          {actions != null && <div className="flex min-w-0 flex-wrap gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </div>
  );
}
