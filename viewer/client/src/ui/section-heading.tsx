import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * A section's title — the second of the four sizes (15/600), in sentence case,
 * with no eyebrow above it and no tracked-out label (design.md §2). A count
 * beside it says how much the section holds; an `aside` is the section's one
 * control, at the end of the line. LEVEL is an outline decision: pass `as`.
 */
export function SectionHeading({
  as: Tag = 'h2',
  count,
  aside,
  className,
  children,
  ...props
}: {
  as?: 'h2' | 'h3' | 'h4';
  count?: number;
  aside?: ReactNode;
  children: ReactNode;
} & HTMLAttributes<HTMLHeadingElement>) {
  return (
    <div className={cn('flex min-w-0 items-baseline justify-between gap-3', className)}>
      <Tag className="min-w-0 text-section font-semibold text-ink" {...props}>
        {children}
        {/* The gap is on BOTH sides: an English title and its count are one
            left-to-right run whatever the document's direction, so under
            `dir="rtl"` a margin on the count's start edge lands outside the
            run and the count touches the title (quiet-console phase 27). */}
        {count != null && (
          <span className="mx-2 text-meta font-normal text-ink-faint tabular-nums">{count}</span>
        )}
      </Tag>
      {aside != null && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
    </div>
  );
}
