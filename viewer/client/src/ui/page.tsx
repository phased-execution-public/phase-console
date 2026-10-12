import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The page frame — one calm column, top to bottom (design.md §1, principle 1).
 *
 * A title in the first size (22/600), the situation in words beneath it when
 * the page has one, the page's controls at the end of the title line, and then
 * the rows. Text measures at most `--measure`; tables take the width. The
 * frame pads on the density tokens, so `data-density` reaches every page.
 */
export function Page({
  title,
  lead,
  actions,
  className,
  children,
  ...props
}: {
  title: ReactNode;
  /** The situation, in words — only non-zero figures, each a link. */
  lead?: ReactNode;
  /** The page's controls: the toolbar, a primary verb. */
  actions?: ReactNode;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <div
      data-page
      className={cn(
        'mx-auto flex w-full min-w-0 max-w-(--content-max) flex-col gap-6 px-(--pad-x) py-(--pad-y)',
        className,
      )}
      {...props}
    >
      <header className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 max-w-(--measure)">
          <h1 className="text-title font-semibold text-ink">{title}</h1>
          {lead != null && <p className="mt-1 text-body text-ink-muted">{lead}</p>}
        </div>
        {actions != null && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}
