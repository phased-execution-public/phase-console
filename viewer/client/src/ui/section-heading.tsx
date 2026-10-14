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
        {/* The title and its count are two boxes of one flex pair with a gap
            between them, never one line of text (#296): an English title and
            its number resolve as one left-to-right run whatever the document's
            direction, so under `dir="rtl"` a margin on the count landed outside
            that run and drew "Do now5". A gap is between boxes, and boxes
            survive bidi. With no count the title is the heading's own text. */}
        {count != null ? (
          <span className="inline-flex max-w-full min-w-0 items-baseline gap-2">
            <span className="min-w-0" data-slot="title">
              {children}
            </span>
            <span className="shrink-0 text-meta font-normal text-ink-faint tabular-nums" data-slot="count">
              {count}
            </span>
          </span>
        ) : (
          children
        )}
      </Tag>
      {aside != null && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
    </div>
  );
}
