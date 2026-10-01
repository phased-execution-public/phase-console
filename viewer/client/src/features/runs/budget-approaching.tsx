/**
 * A budget near its end, drawn BEFORE the park (control-tower phase 25, #40).
 *
 * Phase 14 announced `phase.budget-approaching` at 80 % — a push and a journal
 * line — and nothing on a page drew it, so the first thing a person could see
 * was the park the warning had existed to prevent. The runner now keeps the
 * fact on the holder until a raise answers it; this draws each one with the
 * same raise the halt card offers, worded by `budgetHeadline(fact,
 * 'approaching')` — never arithmetic of this page's own.
 */

import { Banner } from '@/components/ui';
import { BudgetRaise } from '@/components/halt-card';
import type { RunState } from '@/lib/api';
import { budgetHeadline, type BudgetFact } from '@shared/budget-model.js';

/** Every budget of this run still approaching: the run's own, then each open phase's. */
export function budgetApproaches(run: RunState): { phase: number | null; fact: BudgetFact }[] {
  const out: { phase: number | null; fact: BudgetFact }[] = [];
  for (const fact of Object.values(run.budgetApproaching ?? {})) out.push({ phase: null, fact });
  for (const record of Object.values(run.phases)) {
    if (record.status === 'done' || record.status === 'skipped') continue;
    for (const fact of Object.values(record.budgetApproaching ?? {})) out.push({ phase: record.phase, fact });
  }
  return out;
}

export function BudgetApproaching({ slug, run }: { slug: string; run: RunState }) {
  const approaches = budgetApproaches(run);
  if (!approaches.length) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="budget-approaching">
      {approaches.map(({ phase, fact }) => (
        <Banner key={`${phase ?? 'run'}:${fact.budget}`} severity="warn">
          <span className="flex flex-col gap-2">
            <span>
              {phase != null ? `Phase ${phase}: ` : ''}
              {budgetHeadline(fact, 'approaching')}
            </span>
            <BudgetRaise slug={slug} phase={phase} fact={fact} />
          </span>
        </Banner>
      ))}
    </div>
  );
}
