/**
 * How long is left — the estimate, and what it is standing on.
 *
 * An ETA with no basis is a guess wearing a number, so every figure carries
 * the basis that produced it: `plan` (this plan's own completed phases),
 * `portfolio` (pooled across every plan, until a plan has evidence of its own)
 * or `heuristic` (the shipped constants — nothing has finished yet). The same
 * "about 3 days" means three different things depending on which, and only
 * one of them is worth planning around.
 *
 * The server owns the arithmetic (`analysis/stats.ts`); this panel prints it
 * through `./model` and computes nothing. A client that did would drift from
 * the phase, run and lane ETAs, and three surfaces disagreeing about when
 * something finishes is worse than one saying it does not know.
 */

import type { EtaEstimate, PlanSummaryFull, Portfolio } from '@/data/api';
import { plural } from '@/lib/format';
import { planHref, planViewHref, runsBayHref } from '@/shell/routes';
import { Button, Empty, KeyValue } from '@/ui';
import { etaReading } from './model';
import { FactLine, InsightAnswer, InsightNote, PROSE_LINK } from './parts';

export function EtaPanel({
  stats,
  plan,
  planEta,
  planStats,
  everything = false,
}: {
  stats: Portfolio;
  plan?: string;
  planEta?: EtaEstimate | null;
  /** The scoped plan's own analysis — its counts and the floor under its estimate. */
  planStats?: PlanSummaryFull;
  everything?: boolean;
}) {
  const reading = etaReading(stats, { plan, planEta, planStats });
  const floor = reading.floor;

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="insights-eta">
      <InsightAnswer>{reading.answer}</InsightAnswer>
      <FactLine facts={reading.facts} everything={everything} />
      {reading.estimate ? (
        <KeyValue
          items={[
            ...reading.estimate.map(
              (fact) =>
                [
                  fact.label,
                  fact.hint && everything ? (
                    <span key={fact.label}>
                      {fact.value} <span className="text-meta text-ink-muted">{fact.hint}</span>
                    </span>
                  ) : (
                    fact.value
                  ),
                ] as const,
            ),
            everything && reading.model ? ([reading.model.label, reading.model.value] as const) : null,
            plan && floor
              ? ([
                  'Floor',
                  <span key="floor">
                    {floor.all
                      ? `All ${plural(floor.remaining, 'session')} left must run in order: the dependency chain accounts for all of it. `
                      : `${plural(floor.minimum, 'session')} of the ${floor.remaining} left must run in order; the rest could run beside the chain. `}
                    <a href={planViewHref(plan, 'map')} className={PROSE_LINK}>
                      The route map draws it
                    </a>
                  </span>,
                ] as const)
              : null,
          ]}
        />
      ) : plan ? (
        <Empty
          title="No estimate for this plan: every phase is done, or this console’s server predates the per-plan estimate."
          action={
            <Button size="sm" asChild>
              <a href={planHref(plan)}>Open the plan</a>
            </Button>
          }
        />
      ) : (
        <Empty
          title="No phase has finished yet, so estimates use the shipped constants."
          action={
            <Button size="sm" asChild>
              <a href={runsBayHref('ready')}>See what could start</a>
            </Button>
          }
        />
      )}
      {everything && (
        <InsightNote>
          A phase’s own estimate is on its row, a run’s on its run view and a lane’s on Runs; every one of
          them reads this rate.
        </InsightNote>
      )}
    </div>
  );
}
