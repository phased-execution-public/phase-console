/**
 * Your turn, as the home's first group (7.0, quiet-console phase 7; the acts
 * since control-tower phases 130–139).
 *
 * Every item a person owes NOW — a sign-in, a code, a decision, a permission,
 * an errand — one line each, the primary move inline, oldest first. The group
 * holds the ACTS; the runs they summon sit in the group of what they are,
 * wearing the summons on their mark (`data/run-groups.ts`). Its aside is the
 * page: Your turn (`#/turn`) says why only a person fits each, the guide and
 * how it will be checked. An empty group says that nothing needs you, and
 * when the loop next looks by itself — "nothing" alone reads as "and nothing
 * ever will".
 */

import type { ConvergeStatusView } from '@/data/api';
import { useInboxActions } from '@/cards/inbox-row';
import { LazyItemRow } from '@/cards/lazy-item-row';
import type { RunGroups } from '@/data/run-groups';
import { turnHref } from '@/shell/routes';
import { nextSweepWords } from './model';

export function YourTurn({
  model,
  converge,
}: {
  model: RunGroups;
  converge: ConvergeStatusView | undefined;
}) {
  const { perform, busy } = useInboxActions();
  const { items, upcoming } = model;
  if (!items.length) {
    return (
      <p className="text-body text-ink-muted" data-testid="your-turn-empty">
        Nothing needs you right now. {nextSweepWords(converge)}
        {upcoming.length > 0 && (
          <>
            {' '}
            <a href={turnHref()} className="text-ink underline underline-offset-2">
              {upcoming.length} coming up
            </a>
            .
          </>
        )}
      </p>
    );
  }
  return (
    <ul className="flex min-w-0 flex-col divide-y divide-rule" aria-label="Your turn">
      {items.map((row) => (
        <li key={row.id} className="min-w-0 py-1">
          <LazyItemRow row={row} perform={perform} {...(busy ? { busy } : {})} />
        </li>
      ))}
    </ul>
  );
}

/** The group's aside: the page, and what is coming up. */
export function YourTurnAside({ model }: { model: RunGroups }) {
  const coming = model.upcoming.length;
  return (
    <a
      href={turnHref()}
      data-testid="bay-turn"
      className="text-meta text-ink-muted underline-offset-2 hover:text-ink hover:underline"
    >
      {coming ? `Open Your turn — ${coming} coming up` : 'Open Your turn'}
    </a>
  );
}
