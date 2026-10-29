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
 *
 * Since 2026-10-20 (Tower strips) a fold is a STRIP by default: a full-width
 * head — the chevron on a round plate, the label in ink, the count in a pill,
 * and a rule running out to the edge, so a fold reads as a section and never
 * as a stray grey line — and the body opens on a rule down from the chevron.
 * `variant="inline"` keeps the small one-line toggle for a fold INSIDE a row
 * (a phone card's Details, an inbox row's How).
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
  variant = 'strip',
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
  /** `strip` (the default) is a section's fold; `inline` a fold inside a row. */
  variant?: 'strip' | 'inline';
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
  const strip = variant === 'strip';
  return (
    <div className={cn(strip && 'min-w-0', className)}>
      <button
        type="button"
        aria-expanded={open}
        // Only while the region exists: an aria-controls naming a missing id
        // is an axe violation, not a hint.
        aria-controls={open ? region : undefined}
        data-testid={testId}
        data-fold={variant}
        onClick={toggle}
        className={cn(
          strip
            ? 'group/fold flex w-full min-w-0 items-center gap-2 rounded-sm py-1.5 text-start text-body text-ink'
            : 'inline-flex items-center gap-1 rounded-sm text-meta text-ink-muted hover:text-ink',
          '[@media(hover:none)]:min-h-(--tap-min)',
        )}
      >
        {strip ? (
          <span
            aria-hidden
            className={cn(
              'inline-grid size-6 shrink-0 place-items-center rounded-full transition-colors duration-fast ease-transit',
              open ? 'bg-surface-raised text-ink' : 'bg-ground-deep text-ink-muted group-hover/fold:text-ink',
            )}
          >
            <ChevronRight
              size={14}
              className={cn('transition-transform duration-fast ease-transit', open && 'rotate-90')}
            />
          </span>
        ) : (
          <ChevronRight
            size={12}
            aria-hidden
            className={cn('shrink-0 transition-transform duration-fast ease-transit', open && 'rotate-90')}
          />
        )}
        <span className={cn(strip && 'min-w-0 font-medium')}>{open ? openLabel : label}</span>
        {count != null &&
          !open &&
          (strip ? (
            <span className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-ground-deep px-1.5 text-meta leading-[1.4] font-semibold text-ink-muted tabular-nums">
              {/* Heard as "… (12)", seen as a pill. */}
              <span className="sr-only"> (</span>
              {count}
              <span className="sr-only">)</span>
            </span>
          ) : (
            <span className="tnum text-ink-faint">({count})</span>
          ))}
        {strip && <span aria-hidden className="h-px min-w-4 flex-1 bg-rule" />}
      </button>
      {open && (
        <div className="expand-region">
          <div id={region} className={cn(strip && 'ms-3 border-s border-rule-strong ps-5', bodyClassName)}>
            {children}
          </div>
        </div>
      )}
    </div>
  );
}
