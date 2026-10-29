import { Accordion as BaseAccordion } from '@base-ui/react/accordion';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import type { UiState } from '@shared/status-vocab.js';
import { cn } from '@/lib/cn';
import { CountBadge } from '@/ui/status';

/**
 * Folds that belong together (2026-10-20, Tower strips) — the sections of ONE
 * record a person opens one by one: an Inspector's run record, a phase's
 * drawer, a Your turn card's details. Each fold is a STRIP: a full-width head
 * that says what it holds — its label, a count, a one-line summary of what is
 * inside, so a closed fold still informs — and a body that opens by its
 * measured height, on a rule that runs down from the head's chevron.
 *
 * Base UI owns the heads' keyboard (the arrow keys move between them, Home and
 * End jump) and the body's height (`--accordion-panel-height`, from 0 while it
 * starts and ends); several folds may be open at once. A folded body unmounts,
 * as every fold of the console does: a fold is not a cache. Not in the `@/ui`
 * barrel: it reaches the status family for its counts.
 */
export function Accordion({
  value,
  defaultValue,
  onValueChange,
  className,
  children,
}: {
  /** The open folds, by their `value`. Present = controlled. */
  value?: string[] | undefined;
  defaultValue?: string[] | undefined;
  onValueChange?: ((value: string[]) => void) | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <BaseAccordion.Root
      multiple
      {...(value !== undefined ? { value } : {})}
      {...(defaultValue !== undefined ? { defaultValue } : {})}
      {...(onValueChange ? { onValueChange: (next: unknown[]) => onValueChange(next as string[]) } : {})}
      className={cn('flex min-w-0 flex-col', className)}
    >
      {children}
    </BaseAccordion.Root>
  );
}

/** The heading each level renders — an element Base UI's `render` takes, made once. */
const HEADINGS = {
  2: <h2 />,
  3: <h3 />,
  4: <h4 />,
  5: <h5 />,
  6: <h6 />,
} as const;

export function AccordionItem({
  value,
  label,
  summary,
  count,
  paint,
  icon,
  testId,
  section,
  level = 3,
  bodyClassName,
  children,
}: {
  value: string;
  /** What the fold holds, named — never "More". */
  label: ReactNode;
  /** One line of what is inside, read while it is folded. */
  summary?: ReactNode;
  /** How many things it holds. */
  count?: number | undefined;
  /** The state the count is about — the worst thing inside — when it is one. */
  paint?: UiState | undefined;
  /** A glyph before the label. */
  icon?: ReactNode;
  testId?: string | undefined;
  /** The fold's `data-section` — a record's section id, for a page that addresses its sections. */
  section?: string | undefined;
  /**
   * The head's heading level — one below whatever titles the record the folds
   * belong to (a card titled at h3 folds at h4). Default 3.
   */
  level?: 2 | 3 | 4 | 5 | 6;
  bodyClassName?: string | undefined;
  children: ReactNode;
}) {
  return (
    <BaseAccordion.Item
      value={value}
      {...(section ? { 'data-section': section } : {})}
      className="group/fold min-w-0 border-b border-rule last:border-b-0"
    >
      <BaseAccordion.Header className="m-0" render={HEADINGS[level]}>
        <BaseAccordion.Trigger
          {...(testId ? { 'data-testid': testId } : {})}
          className={cn(
            'flex w-full min-w-0 items-center gap-2 rounded-sm py-2.5 text-start',
            'text-body text-ink hover:text-ink [@media(hover:none)]:min-h-(--tap-min)',
          )}
        >
          <span
            aria-hidden
            className="inline-grid size-6 shrink-0 place-items-center rounded-full bg-ground-deep text-ink-muted group-data-[open]/fold:bg-surface-raised group-data-[open]/fold:text-ink"
          >
            <ChevronRight
              size={14}
              className="transition-transform duration-fast ease-transit group-data-[open]/fold:rotate-90"
            />
          </span>
          {icon && (
            <span aria-hidden className="shrink-0 text-ink-muted">
              {icon}
            </span>
          )}
          <span className="min-w-0 font-medium">{label}</span>
          {count != null && (
            <>
              <span className="sr-only"> (</span>
              <CountBadge count={count} paint={paint} />
              <span className="sr-only">)</span>
            </>
          )}
          {summary != null && (
            <span className="ms-auto min-w-0 truncate ps-2 text-meta text-ink-muted">{summary}</span>
          )}
        </BaseAccordion.Trigger>
      </BaseAccordion.Header>
      <BaseAccordion.Panel
        className={cn(
          'h-(--accordion-panel-height) overflow-hidden transition-[height] duration-medium ease-transit',
          'data-[ending-style]:h-0 data-[starting-style]:h-0',
        )}
      >
        <div className={cn('ms-3 border-s border-rule-strong pb-3 ps-5', bodyClassName)}>{children}</div>
      </BaseAccordion.Panel>
    </BaseAccordion.Item>
  );
}
