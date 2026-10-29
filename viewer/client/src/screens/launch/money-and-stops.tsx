/**
 * Money and stops — the Money category's panel.
 *
 * Opens on the answer, not the fields: where this run stops, in clauses
 * read off the values, and what it does instead of stopping. The ceilings
 * and the stop conditions are the controls under it. An empty budget box
 * reads "no ceiling" here rather than as a box nobody filled in.
 */

import type { RunForecastUsdView } from '@/data/api';
import { plural } from '@/lib/format';
import { SectionHeading } from '@/ui';
import { Money } from '@/ui/money';
import { useDraftPrelude, useLaunchFacts } from './model/facts';
import { useSetupForm } from './form-context';
import { MoneySection, StopsSection } from './sections';
import { ceilings, stopsWhen } from './model/summary';

export function MoneyAndStops() {
  const f = useSetupForm();
  const facts = useLaunchFacts();
  const on = f.on;
  // The per-round ceiling counts as money here, and it is the only one a
  // `qa-fix` launch has: a recovery carries no phase or run budget of its own
  // (it inherits the run's), so without this term the Money group would vanish
  // and the one ceiling that launch DOES set would have nowhere to render.
  const money = on('phaseBudgetUsd') || on('runBudgetUsd') || on('qaRoundBudgetUsd');
  const { stops, carriesOn } = stopsWhen(f.values);
  const cost = ceilings(f.values, facts.willRun.length || undefined);
  const forecast = useDraftPrelude().data?.forecast;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section className="flex min-w-0 flex-col gap-2">
        <SectionHeading as="h4">Where it stops</SectionHeading>
        <StopsGlance stops={stops} carriesOn={carriesOn} />
      </section>
      {money && (
        <section className="flex min-w-0 flex-col gap-3">
          <SectionHeading as="h4">Money</SectionHeading>
          <MoneySection />
          <ul className="flex min-w-0 flex-col gap-0.5 text-meta text-ink-muted">
            {cost.lines.map((line) => (
              <li key={line} className="tabular-nums">
                {line}
              </li>
            ))}
            {forecast && forecast.phases.length > 0 && (
              <ForecastLine forecast={forecast} atMost={cost.atMost} />
            )}
            {facts.detail?.summary.remainingWeight ? (
              <li className="tabular-nums">
                The plan's own sizes put what is left at ≈{' '}
                {plural(facts.detail.summary.remainingSessions, 'session')} of work — a size, not a price.
              </li>
            ) : null}
          </ul>
        </section>
      )}
      <section className="flex min-w-0 flex-col gap-3">
        <SectionHeading as="h4">Stops</SectionHeading>
        <StopsSection />
      </section>
    </div>
  );
}

/**
 * What the run will likely cost, beside the ceilings (measured-console phase 23): the prelude's
 * forecast — each phase its size's sessions × dollars per session — always `estimated`, and
 * said to be over the ceiling when it is.
 */
export function ForecastLine({ forecast, atMost }: { forecast: RunForecastUsdView; atMost: number | null }) {
  const measured = forecast.phases.filter((p) => p.perSession.basis === 'measured').length;
  const over = atMost != null && forecast.usd != null && forecast.usd > atMost;
  return (
    <li data-testid="launch-forecast-usd" className="tabular-nums">
      Likely cost <Money usd={forecast.usd} word="estimated" showWord className="text-ink" /> for{' '}
      {plural(forecast.phases.length, 'phase')} — each its size's sessions × dollars per session,{' '}
      {measured
        ? `${measured} of them from this console's own ledger`
        : 'from the shipped table until twenty sessions are measured'}
      {forecast.unpricedPhases > 0
        ? `; ${plural(forecast.unpricedPhases, 'phase')} nobody prices, so it is a floor`
        : ''}
      {over ? (
        <>
          {' '}
          — over the ceiling of <Money usd={atMost} />, so it would halt and ask before the end
        </>
      ) : null}
      .
    </li>
  );
}

export function StopsGlance({ stops, carriesOn }: { stops: string[]; carriesOn: string[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 text-body">
      <div className="min-w-0">
        <p className="text-ink">The run halts and asks when</p>
        <ul className="mt-1 list-disc ps-5 text-ink-muted">
          {stops.map((clause) => (
            <li key={clause} className="break-words">
              {clause}
            </li>
          ))}
        </ul>
      </div>
      {carriesOn.length > 0 && (
        <div className="min-w-0">
          <p className="text-ink">And otherwise</p>
          <ul className="mt-1 list-disc ps-5 text-ink-muted">
            {carriesOn.map((clause) => (
              <li key={clause} className="break-words">
                {clause}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
