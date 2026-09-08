/**
 * Stage 3 — Money and stops.
 *
 * Opens on the answer, not the fields: where this run stops, in clauses
 * read off the values, and what it does instead of stopping. The ceilings
 * and the stop conditions are the controls under it. An empty budget box
 * reads "no ceiling" here rather than as a box nobody filled in.
 */

import { SectionHeading } from '@/components/ui';
import { useLaunchFacts } from './facts';
import { useSetupForm } from './form-context';
import { MoneySection, StopsSection } from './sections';
import { ceilings, stopsWhen } from './summary';

export function MoneyAndStops() {
  const f = useSetupForm();
  const facts = useLaunchFacts();
  const on = f.on;
  // The per-round ceiling counts as money here, and it is the only one a
  // `qa-fix` launch has: a recovery carries no phase or run budget of its own
  // (it inherits the run's), so without this term the Money block vanished and
  // the one ceiling that launch DOES set had nowhere to render.
  const money = on('phaseBudgetUsd') || on('runBudgetUsd') || on('qaRoundBudgetUsd');
  const { stops, carriesOn } = stopsWhen(f.values);
  const cost = ceilings(f.values, facts.willRun.length || undefined);
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <SectionHeading as="h3" tone="muted">
          Where it stops
        </SectionHeading>
        <StopsGlance stops={stops} carriesOn={carriesOn} />
      </section>
      {money && (
        <section className="flex flex-col gap-3">
          <SectionHeading as="h3" tone="muted">
            Money
          </SectionHeading>
          <MoneySection />
          <ul className="flex flex-col gap-0.5 text-xs text-ink-muted">
            {cost.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}
      <section className="flex flex-col gap-3">
        <SectionHeading as="h3" tone="muted">
          Stops
        </SectionHeading>
        <StopsSection />
      </section>
    </div>
  );
}

export function StopsGlance({ stops, carriesOn }: { stops: string[]; carriesOn: string[] }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div>
        <p className="text-ink">The run halts and asks when</p>
        <ul className="mt-1 list-disc pl-5 text-ink-muted">
          {stops.map((clause) => (
            <li key={clause}>{clause}</li>
          ))}
        </ul>
      </div>
      {carriesOn.length > 0 && (
        <div>
          <p className="text-ink">And otherwise</p>
          <ul className="mt-1 list-disc pl-5 text-ink-muted">
            {carriesOn.map((clause) => (
              <li key={clause}>{clause}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
