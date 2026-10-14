/**
 * *Where the plans stand* (turn-by-turn phase 9, §Architecture 7): for every
 * plan the open items name, one line — how many of its phases are done, the
 * phase it is on now, the phase it can take next, and how many of its items
 * wait on you, that number a link to the page narrowed to the plan.
 *
 * ```
 * Where the plans stand
 * turn-by-turn   8 of 18 phases done   Now phase 9   Next phase 10   2 wait on you
 * ```
 *
 * The board's facts are the plans list's (`GET /api/plans`, the same answer
 * the Plans page reads — the engine's buckets, never recounted here); the
 * page adds only which plans to show and what of each waits on the person.
 * A plan the list does not know (a closed one, a read that failed) still
 * gets its line, saying only what waits on you.
 */

import type { PlanSummaryFull } from '@/data/api';
import type { TurnAnswer } from '@/data/turn';
import { usePlans } from '@/data/plans';
import { phaseHref, planHref } from '@/shell/routes';
import { SectionHeading } from '@/ui';
import { TURN_OPEN_GROUPS } from '@shared/turn-model.js';

const link = 'tap-row text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-ink';

/** One plan's line, as data: its board facts and what of it waits on the person. */
export type PlanStanding = {
  slug: string;
  done: number | null;
  phases: number | null;
  now: number[];
  next: number[];
  waiting: number;
};

/**
 * The plans the open items name, in the order their first item stands, each
 * with its board read off the plans list. Pure — `plans-strip.test` proves it.
 */
export function plansStanding(
  answer: Pick<TurnAnswer, 'groups'>,
  plans: readonly Partial<PlanSummaryFull>[] | undefined,
): PlanStanding[] {
  const waiting = new Map<string, number>();
  for (const group of TURN_OPEN_GROUPS) {
    for (const item of answer.groups[group] ?? []) {
      if (item.slug) waiting.set(item.slug, (waiting.get(item.slug) ?? 0) + 1);
    }
  }
  const bySlug = new Map((plans ?? []).filter((plan) => plan.slug).map((plan) => [plan.slug!, plan]));
  return [...waiting.entries()].map(([slug, count]) => {
    const plan = bySlug.get(slug);
    const numbers = (value: unknown): number[] =>
      Array.isArray(value) ? value.filter((n): n is number => typeof n === 'number') : [];
    return {
      slug,
      done: typeof plan?.done === 'number' ? plan.done : null,
      phases: typeof plan?.phases === 'number' ? plan.phases : null,
      now: numbers(plan?.inProgress),
      next: numbers(plan?.ready),
      waiting: count,
    };
  });
}

function Phases({ slug, word, phases }: { slug: string; word: string; phases: number[] }) {
  if (!phases.length) return null;
  const shown = phases.slice(0, 3);
  return (
    <span className="text-ink-muted">
      {word} {phases.length === 1 ? 'phase' : 'phases'}{' '}
      {shown.map((phase, index) => (
        <span key={phase}>
          {index > 0 ? ', ' : ''}
          <a className={link} href={phaseHref(slug, phase)}>
            {phase}
          </a>
        </span>
      ))}
      {phases.length > shown.length ? ` and ${phases.length - shown.length} more` : ''}
    </span>
  );
}

export function PlansStrip({
  answer,
  waitingHref,
}: {
  answer: Pick<TurnAnswer, 'groups'>;
  /** The page narrowed to one plan — its *wait on you* link. */
  waitingHref: (slug: string) => string;
}) {
  const plans = usePlans();
  const standing = plansStanding(answer, plans.data as Partial<PlanSummaryFull>[] | undefined);
  if (!standing.length) return null;
  return (
    <section
      aria-labelledby="turn-plans-heading"
      data-testid="turn-plans"
      className="flex min-w-0 flex-col gap-2 py-5"
    >
      <SectionHeading id="turn-plans-heading" count={standing.length}>
        Where the plans stand
      </SectionHeading>
      <ul className="flex list-none flex-col gap-1 p-0">
        {standing.map((plan) => (
          <li
            key={plan.slug}
            data-testid="turn-plan"
            data-plan={plan.slug}
            className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-0.5 text-body"
          >
            <a className={`${link} font-medium`} href={planHref(plan.slug)}>
              {plan.slug}
            </a>
            {plan.done != null && plan.phases != null ? (
              <span className="text-ink-muted tabular-nums">
                {plan.done} of {plan.phases} phases done
              </span>
            ) : null}
            <Phases slug={plan.slug} word="Now" phases={plan.now} />
            <Phases slug={plan.slug} word="Next" phases={plan.next} />
            <a className={link} href={waitingHref(plan.slug)} data-testid="turn-plan-waiting">
              {plan.waiting} {plan.waiting === 1 ? 'waits' : 'wait'} on you
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
