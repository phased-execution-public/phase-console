import { ChevronDown } from 'lucide-react';
import { useId, useState, type HTMLAttributes, type ReactNode } from 'react';
import type { UiState } from '@shared/status-vocab.js';
import { cn } from '@/lib/cn';

/**
 * One line per thing (design.md §1, principle 2). A run, a plan, a phase, a
 * session, a turn item is one line: a status mark and its word · the name ·
 * one fact · one clock · one action. Nothing else at the glance; everything
 * else expands in place (the first door to depth).
 *
 * The leading edge wears the thing's paint when it has one — a 2 px rule in
 * the hue, never a filled band — so a column of rows reads as a column of
 * states before a word is read. Rows are separated by space; the caller draws
 * a hairline only between groups.
 *
 * Below 640 the fact and the clock drop under the name; from 640 the five sit
 * on one line. The expand is the `.expand-region` transition; its content
 * unmounts when folded (a fold is not a cache), and `expanded` lets the caller
 * remember it per person.
 */
export interface RowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'children'> {
  /** The status mark and its word — a member of `@/ui/status`. */
  mark: ReactNode;
  name: ReactNode;
  /** The name is the way in. */
  href?: string;
  fact?: ReactNode;
  clock?: ReactNode;
  /** The one action. */
  action?: ReactNode;
  /** The leading edge's paint. */
  paint?: UiState;
  /** What expands in place. Present = the row can expand. */
  children?: ReactNode;
  /** Controlled expansion; absent, the row remembers its own. */
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** What opening names — "Phases", "Details". */
  expandLabel?: string;
}

export function Row({
  mark,
  name,
  href,
  fact,
  clock,
  action,
  paint,
  children,
  expanded: controlled,
  defaultExpanded = false,
  onExpandedChange,
  expandLabel = 'Details',
  className,
  ...props
}: RowProps) {
  const region = useId();
  const [uncontrolled, setUncontrolled] = useState(defaultExpanded);
  const canExpand = children != null;
  const open = canExpand && (controlled ?? uncontrolled);
  // "Show details", "Show details of Docs": the label's first letter follows
  // the verb, and a name inside it keeps its own capitals.
  const expandWords = `${expandLabel.charAt(0).toLowerCase()}${expandLabel.slice(1)}`;
  const toggle = () => {
    const next = !open;
    if (controlled === undefined) setUncontrolled(next);
    onExpandedChange?.(next);
  };
  return (
    <div
      data-row
      data-paint={paint}
      data-expanded={open ? '' : undefined}
      className={cn(
        'grid min-w-0 items-center gap-x-3 gap-y-0.5 border-s-2 py-1.5 ps-3',
        'grid-cols-[auto_minmax(0,1fr)_auto] sm:grid-cols-[auto_minmax(0,1fr)_auto_auto_auto]',
        paint ? `state-${paint} border-state` : 'border-transparent',
        className,
      )}
      {...props}
    >
      <div className="flex items-center">{mark}</div>
      <div className="min-w-0 truncate text-body text-ink">
        {href ? (
          <a href={href} className="rounded-sm hover:underline">
            {name}
          </a>
        ) : (
          name
        )}
      </div>
      <div className="col-start-3 row-start-1 flex items-center justify-self-end gap-1 sm:col-start-auto sm:row-start-auto">
        {action}
        {canExpand && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? region : undefined}
            aria-label={`${open ? 'Hide' : 'Show'} ${expandWords}`}
            onClick={toggle}
            className="inline-grid size-7 place-items-center rounded text-ink-faint hover:bg-surface-raised hover:text-ink [@media(hover:none)]:size-(--tap-min)"
          >
            <ChevronDown
              size={14}
              aria-hidden
              className={cn('transition-transform duration-fast ease-transit', open && 'rotate-180')}
            />
          </button>
        )}
      </div>
      {fact != null && (
        <div className="col-start-2 min-w-0 truncate text-meta text-ink-muted sm:col-start-auto sm:row-start-auto">
          {fact}
        </div>
      )}
      {clock != null && (
        <div className="col-start-2 whitespace-nowrap text-meta text-ink-faint tabular-nums sm:col-start-auto sm:row-start-auto">
          {clock}
        </div>
      )}
      {open && (
        <div className="expand-region col-span-full">
          <div id={region} className="pt-2">
            {children}
          </div>
        </div>
      )}
    </div>
  );
}
