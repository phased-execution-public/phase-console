/**
 * One category of the launch, as one line (7.0, quiet-console phase 13).
 *
 * Control-tower phase 22 drew the nine categories as tiles in a grid; 7.0 draws
 * them as the page grammar's rows (design.md §1): the category's glyph and
 * name, what it is set to in a few separate words, where those values mostly
 * came from, how many were changed here, and ONE verb. The verb opens the
 * category's controls IN PLACE, straight under its line — at every width, one
 * row at a time — and Done folds them again. A row holding something that
 * holds Launch (an open decision, the plan's git lines) is the summons: its
 * leading edge is the one amber, and its verb is Answer.
 */

import {
  Crosshair,
  Cpu,
  GitBranch,
  MessageCircleQuestion,
  ScanSearch,
  ShieldCheck,
  UserRound,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/ui';
import { cn } from '@/lib/cn';
import type { Category, CategoryId } from './model/categories';
import { PROVENANCE_WORDS, type Source } from './model/seed';

export const CATEGORY_GLYPHS: Readonly<Record<CategoryId, LucideIcon>> = Object.freeze({
  scope: Crosshair,
  engine: Cpu,
  safety: ShieldCheck,
  git: GitBranch,
  money: Wallet,
  review: ScanSearch,
  tools: Wrench,
  accounts: UserRound,
  decisions: MessageCircleQuestion,
});

/** The id of a category's controls, while they are open. */
export function categoryPanelId(id: CategoryId): string {
  return `launch-category-${id}`;
}

export interface CategoryRowProps {
  category: Category;
  /** What the category is set to now — each a word of its own (`tileBadges`). */
  words: readonly string[];
  /** Where its untouched values mostly came from. */
  source?: Source;
  /** How many of its values were changed in this launch. */
  changed: number;
  /** Something here holds Launch: the row is the summons. */
  summons?: boolean;
  open: boolean;
  onToggle: () => void;
  /** The category's controls — drawn only while open. */
  children?: ReactNode;
}

export function CategoryRow({
  category,
  words,
  source,
  changed,
  summons = false,
  open,
  onToggle,
  children,
}: CategoryRowProps) {
  const Glyph = CATEGORY_GLYPHS[category.id];
  const verb = open ? 'Done' : summons ? 'Answer' : 'Edit';
  const paint = summons ? 'needs-you' : undefined;
  const panel = categoryPanelId(category.id);
  return (
    <li
      data-category={category.id}
      data-open={open || undefined}
      data-summons={summons || undefined}
      className={cn(
        'min-w-0 border-s-2 ps-3',
        paint ? `state-${paint} border-state` : open ? 'border-ink-faint' : 'border-transparent',
      )}
    >
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 py-1.5 sm:grid-cols-[auto_9.5rem_minmax(0,1fr)_auto_auto]">
        <Glyph size={15} aria-hidden className={cn('shrink-0', summons ? 'text-state' : 'text-ink-muted')} />
        <h3 className="min-w-0 text-body font-medium text-ink">{category.label}</h3>
        {/* Below 640 the words and their provenance share one wrapping line under
            the name; from 640 the wrapper dissolves and each is a column. */}
        <div className="col-start-2 col-end-4 row-start-2 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 sm:contents">
          <ul
            aria-label={`${category.label} now`}
            className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-meta text-ink sm:text-body"
          >
            {words.map((word) => (
              <li key={word} className="min-w-0 break-words">
                {word}
              </li>
            ))}
          </ul>
          <p className="flex min-w-0 flex-wrap gap-x-3 text-meta text-ink-muted empty:hidden sm:justify-end">
            {source && <span data-source={source}>{PROVENANCE_WORDS[source]}</span>}
            {changed > 0 && (
              <span className="text-ink" data-changed={changed}>
                changed {changed}
              </span>
            )}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="col-start-3 row-start-1 justify-self-end sm:col-start-auto sm:row-start-auto"
          aria-expanded={open}
          aria-controls={open ? panel : undefined}
          aria-label={`${verb} ${category.label}`}
          onClick={onToggle}
        >
          {verb}
        </Button>
      </div>
      {open && (
        <div className="expand-region">
          <div
            id={panel}
            role="region"
            aria-label={category.label}
            className="flex min-w-0 flex-col gap-4 pt-1 pb-4"
          >
            <p className="max-w-(--measure) text-meta text-ink-muted">{category.blurb}</p>
            {children}
          </div>
        </div>
      )}
    </li>
  );
}
