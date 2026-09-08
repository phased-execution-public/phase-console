import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The row anatomy four lists arrived at separately.
 *
 * Plans' cards, the fleet's phone cards, Now's lanes and the session list are
 * four different vocabularies over one shape: something that says WHAT STATE
 * this is in, a name you can follow, an identifier under it, a wrapping line of
 * facts, a clock on the right, and buttons. Written four times, they disagreed
 * about the two things that are not decoration:
 *
 *  - **the header row must wrap.** Three of the four had `shrink-0` on the row
 *    that gains a badge when a lane goes live, so it PUSHED instead — and
 *    because the shell's one scroller computes `overflow-x: auto`, the push
 *    became a horizontal scroll of the whole app. Measured four times, on four
 *    surfaces, in three phases (`styles/touch.test.ts` carries the ledger).
 *  - **the title truncates against something.** A `truncate` inside a parent
 *    that may not shrink truncates nothing; the plan whose repo list is
 *    fourteen names long is what proves it.
 *
 * Both are structural, so they live here and cannot be forgotten again. Every
 * slot is a `ReactNode` and this file knows what none of them mean — which is
 * what lets one row serve a plan, a run, a lane and a session.
 */
export function ListRow({
  lead,
  title,
  href,
  hint,
  subtitle,
  aside,
  facts,
  time,
  actions,
  as: Tag = 'li',
  className,
  children,
}: {
  /** State, first and shrink-0: a StatusBadge, a StatusDot, a kind icon. */
  lead?: ReactNode;
  /** The name. Truncates, and is the tap target when `href` is given. */
  title: ReactNode;
  href?: string;
  /** The hover for the title — the full text, when the visible one is cut. */
  hint?: string;
  /** The identifier or the phase line under the name. Mono, small, truncating. */
  subtitle?: ReactNode;
  /** Top-right: chips and badges. Wraps under the title rather than pushing it. */
  aside?: ReactNode;
  /** The wrapping fact line — counts, money, elapsed. Small, mono, faint. */
  facts?: ReactNode;
  /** Right of the facts: the one clock. Never shrinks, never wraps mid-phrase. */
  time?: ReactNode;
  /** The buttons. Their own row, wrapping, because a row gains buttons. */
  actions?: ReactNode;
  as?: 'li' | 'div';
  className?: string;
  /** Anything this shape has no slot for — a progress track, a tail, a note. */
  children?: ReactNode;
}) {
  return (
    <Tag
      className={cn('flex min-w-0 flex-col gap-2 rounded-lg border border-rule bg-surface p-3', className)}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        {lead != null && <span className="shrink-0 self-center">{lead}</span>}
        <span className="min-w-0 flex-1">
          {href ? (
            <a href={href} className="block min-w-0 truncate font-medium hover:text-action" title={hint}>
              {title}
            </a>
          ) : (
            <span className="block min-w-0 truncate font-medium" title={hint}>
              {title}
            </span>
          )}
          {subtitle != null && (
            <span className="block min-w-0 truncate font-mono text-2xs text-ink-faint">{subtitle}</span>
          )}
        </span>
        {/* `flex-wrap`, never `shrink-0`: this is the row that gains a badge. */}
        {aside != null && (
          <span className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">{aside}</span>
        )}
      </div>

      {children}

      {(facts != null || time != null) && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-2xs tabular-nums text-ink-faint">
          {facts}
          {/* `ml-auto` on a row that is allowed to wrap: on a phone the clock
              drops to its own line rather than pushing the facts off-screen. */}
          {time != null && <span className="ml-auto shrink-0 whitespace-nowrap">{time}</span>}
        </div>
      )}

      {actions != null && <div className="flex min-w-0 flex-wrap gap-1.5">{actions}</div>}
    </Tag>
  );
}
