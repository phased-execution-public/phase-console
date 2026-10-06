/**
 * CI GitHub will not start, one line per repository (control-tower phase 111,
 * #166).
 *
 * When a repository's Actions budget is spent, or its account cannot pay,
 * GitHub ends every run on it in seconds without starting a job. Each phase
 * watching one of those runs used to be its own diagnosis — four sessions of
 * one plan re-learned the same wall by hand. The wall is the repository's, so
 * the Tower says it once per repository: what the budget reads, and which
 * phases wait on it. Each of those phases carries the errand that says how
 * to clear it; this line only says where the wall is.
 *
 * Ink, no hue: the phases' own errands are the summons.
 */

import { CreditCard } from 'lucide-react';
import { budgetClause, type CiRefusal, type CiRefusedPhase } from '@shared/ci-refusal.js';
import { phaseList } from './waits';

/** `vca-refactor P11 and P12, hub-tidy P3` — who waits, plan by plan. */
export function waitersOf(phases: readonly CiRefusedPhase[]): string {
  const bySlug = new Map<string, number[]>();
  for (const p of phases) bySlug.set(p.slug, [...(bySlug.get(p.slug) ?? []), p.phase]);
  return [...bySlug].map(([slug, list]) => `${slug} ${phaseList(list)}`).join(', ');
}

/** The sentence after the label: the budget as read, then who waits. */
export function ciRefusedSentence(item: CiRefusal): string {
  const budget = budgetClause({ budgets: item.budgets, unreadable: item.unreadable });
  const waits = item.phases.length === 1 ? 'waits' : 'wait';
  return `GitHub is not starting jobs for ${item.repo}: ${budget}. ${waitersOf(item.phases)} ${waits} on it.`;
}

export function CiRefusedLines({ items }: { items: readonly CiRefusal[] }) {
  if (!items.length) return null;
  return (
    <ul
      aria-label="Repositories GitHub is not running CI for"
      data-testid="ci-refused"
      className="flex min-w-0 flex-col gap-1"
    >
      {items.map((item) => (
        <li
          key={item.repo}
          data-testid="ci-refused-repo"
          data-repo={item.repo}
          className="flex min-w-0 items-start gap-2 text-2xs text-ink-muted"
        >
          <CreditCard size={12} aria-hidden className="mt-0.5 shrink-0 text-ink" />
          <span className="min-w-0 break-words">
            <span className="font-medium text-ink">{item.label}</span> {ciRefusedSentence(item)}
          </span>
        </li>
      ))}
    </ul>
  );
}
