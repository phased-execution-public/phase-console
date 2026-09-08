import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The band label — the small uppercase eyebrow over a group of rows.
 *
 * Twenty-odd surfaces spelled it out, in two dialects that had drifted apart
 * without either being a decision: `text-2xs font-medium uppercase
 * tracking-[0.14em]` at fourteen sites, `font-display text-2xs
 * tracking-[0.14em] uppercase` at six. On top of those, two features had grown
 * a local `Section` component of their own for the larger band title.
 *
 * The unified spelling is the majority one — `font-medium`, not `font-display`.
 * The display face earns its place on things that are read as names (a plan
 * title, a dialog heading); an eyebrow is a signpost, and a signpost set in a
 * display face competes with the thing it is pointing at.
 *
 * ## Two sizes, and why they are one component
 *
 * `band` is the eyebrow over a list. `title` is the heading over a whole
 * section of a page (Insights' five questions). They are the same job at two
 * scales, and the reason to keep them together is the `as` prop: a heading
 * level is an outline decision, not a size decision, and splitting the sizes
 * into two components is how a page ends up with an `<h3>` above an `<h2>`.
 */
export function SectionHeading({
  as: Tag = 'h2',
  size = 'band',
  tone,
  className,
  children,
  ...props
}: {
  /** The heading level. Pick it from the page's outline, never from the size. */
  as?: 'h2' | 'h3' | 'h4' | 'span' | 'div';
  size?: 'band' | 'title';
  /**
   * Defaults to the reading each size wants: an eyebrow is faint, a section
   * title is full-strength ink. The other two are rationed exactly as the
   * button variants are — `action` (amber) says *this band is what to do now*,
   * and `state` inherits whatever `.state-<ui>` class an ancestor carries, so a
   * band over a failed phase is painted by the phase rather than by a hue
   * chosen here.
   */
  tone?: 'ink' | 'faint' | 'muted' | 'action' | 'state';
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLHeadingElement>, 'color'>) {
  return (
    <Tag className={cn(SIZE[size], TONE[tone ?? (size === 'title' ? 'ink' : 'faint')], className)} {...props}>
      {children}
    </Tag>
  );
}

const SIZE = {
  band: 'text-2xs font-medium uppercase tracking-[0.14em]',
  title: 'font-display text-xl leading-none',
} as const;

const TONE = {
  ink: 'text-ink',
  faint: 'text-ink-faint',
  muted: 'text-ink-muted',
  action: 'text-action',
  // Not a hue: `--color-state` resolves through whatever `.state-<ui>` class an
  // ancestor set (see theme.css), so this paints itself from the row's status.
  state: 'text-state',
} as const;
