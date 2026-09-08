import { ChevronRight } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The disclosure ladder's L1 rung — expand in place (`docs/design.md`,
 * "minimal surface, total recall").
 *
 * A page's calm default (L0) may fold detail, but every fold must carry its
 * own way back: a quiet row that says what it is hiding and how much. This is
 * that row, canonized, so twenty surfaces do not each invent a chevron with a
 * different tap target and a different voice.
 *
 * The voice is directive and honest: the label names what appears ("Show
 * everything", "All 12 options", "Raw record") — never "More…", which names
 * nothing. The count is drawn while folded because that is when it matters:
 * an operator deciding whether to open a fold is owed the size of what is in
 * it. Content unmounts when folded — a fold is not a cache.
 *
 * Controlled (`open` + `onOpenChange`) or uncontrolled (`defaultOpen`), the
 * same split every Radix surface here uses.
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
  children,
}: {
  /** What opening reveals, named. Sentence case, plain verbs. */
  label?: ReactNode;
  /** The way back. */
  openLabel?: ReactNode;
  /** How much is folded. Drawn only while folded — that is when it informs. */
  count?: number;
  /** Present = controlled. The button then only reports intent. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  bodyClassName?: string;
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
        // Only while the region exists: a folded Disclosure unmounts it, and
        // an aria-controls naming a missing id is an axe violation, not a hint.
        aria-controls={open ? region : undefined}
        onClick={toggle}
        className={cn(
          'inline-flex items-center gap-1 rounded-sm text-xs text-ink-muted',
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
        <div id={region} className={cn('animate-rise', bodyClassName)}>
          {children}
        </div>
      )}
    </div>
  );
}
