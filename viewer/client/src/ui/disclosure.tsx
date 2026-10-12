import { ChevronRight } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Expand, in place — the first door to depth (design.md §1, principle 3).
 *
 * A page's calm default may fold detail, but every fold carries its own way
 * back: a quiet line that says what it is hiding and how much. The label NAMES
 * what appears ("All 12 options", "Raw record") — never "More…", which names
 * nothing. The count is drawn while folded, because that is when it informs.
 * Content unmounts when folded — a fold is not a cache. Controlled (`open` +
 * `onOpenChange`) or uncontrolled (`defaultOpen`); the expand is the
 * `.expand-region` transition, which reduced motion collapses.
 */
export function Disclosure({
  label = 'Show everything',
  openLabel = 'Show less',
  count,
  open: controlled,
  defaultOpen = false,
  onOpenChange,
  className,
  bodyClassName,
  testId,
  children,
}: {
  /** What opening reveals, named. Sentence case, plain verbs. */
  label?: ReactNode;
  /** The way back. */
  openLabel?: ReactNode;
  /** How much is folded. Drawn only while folded. */
  count?: number;
  /** Present = controlled. The button then only reports intent. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  bodyClassName?: string;
  /** The toggle's test id — a card that pins its folds in a datum ledger names them. */
  testId?: string;
  children: ReactNode;
}) {
  const region = useId();
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const open = controlled ?? uncontrolled;
  const toggle = () => {
    const next = !open;
    if (controlled === undefined) setUncontrolled(next);
    onOpenChange?.(next);
  };
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        // Only while the region exists: an aria-controls naming a missing id
        // is an axe violation, not a hint.
        aria-controls={open ? region : undefined}
        data-testid={testId}
        onClick={toggle}
        className={cn(
          'inline-flex items-center gap-1 rounded-sm text-meta text-ink-muted',
          'hover:text-ink [@media(hover:none)]:min-h-(--tap-min)',
        )}
      >
        <ChevronRight
          size={12}
          aria-hidden
          className={cn('shrink-0 transition-transform duration-fast ease-transit', open && 'rotate-90')}
        />
        <span>{open ? openLabel : label}</span>
        {count != null && !open && <span className="tnum text-ink-faint">({count})</span>}
      </button>
      {open && (
        <div className="expand-region">
          <div id={region} className={bodyClassName}>
            {children}
          </div>
        </div>
      )}
    </div>
  );
}
