/**
 * What it costs — the money question, in the two units it has.
 *
 * **The ladder today against the day cap** is the cap's own arithmetic: it is
 * the figure `nextRung` refuses a rung against (`ladderPerDayUsd`), so it is
 * the one that can stop the autopilot — and the runs' settled spend is NOT in
 * it, which is why the meter draws the ladder alone and says the settled
 * figure beside it. **Each run against its budget** is where the money is
 * going right now. The two are deliberately not interchangeable.
 *
 * Every figure is the server's (`./model`): the window's total and each day's
 * are summed by `/api/spend`, the room left under the cap too, and the
 * verdict is `overDayCap`, the rule a rung is refused by.
 *
 * A run's line is the three doors' (quiet-console phase 27): it goes to the
 * run, it opens in place — the row's expansion on a desk, the record's fold on
 * a phone — onto its id and Inspect, which puts the run's spend in the panel
 * (`./inspector`); Everything draws the id on the line.
 */

import type { SpendView } from '@/data/api';
import { money } from '@/lib/format';
import { useInspected } from '@/shell/panel/inspector-host';
import { runHref, settingsHref } from '@/shell/routes';
import { Button, Empty, Money, Mono, SectionHeading } from '@/ui';
import { Disclosure } from '@/ui/disclosure';
import { BarList } from '@/ui/figures/lazy';
import { FigureNumbers } from '@/ui/figures/numbers';
import type { Column } from '@/ui/grid/column';
import { Grid } from '@/ui/grid/grid';
import { LoadMeter } from '@/ui/track/meter';
import { inspectRunSpend, runSpendKey } from './inspector';
import { costReading } from './model';
import { FactRows, FigureBlock, InsightNote, PROSE_LINK } from './parts';

type SpendRun = SpendView['runs'][number];

/**
 * What opens under a run's line: the way into the panel, pressed while the
 * run's spend is the record on show. Mounted only while the line is open, so
 * only an open line asks the panel what it shows.
 */
function RunSpendDetail({ run }: { run: SpendRun }) {
  const shown = useInspected()?.key === runSpendKey(run.runId);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="run-spend-detail">
      <Button size="sm" variant="ghost" aria-pressed={shown} onClick={() => inspectRunSpend(run)}>
        Inspect
      </Button>
    </div>
  );
}

const RUN_COLUMNS: readonly Column<SpendRun>[] = [
  {
    id: 'plan',
    head: 'Plan',
    priority: 1,
    min: 200,
    flex: true,
    identity: true,
    card: 'title',
    value: (run) => run.slug,
    cell: (run) => <span className="break-words text-ink">{run.slug}</span>,
  },
  {
    id: 'spent',
    head: 'Spent',
    priority: 1,
    min: 96,
    align: 'end',
    card: 'meta',
    value: (run) => run.spentUsd,
    cell: (run) => <Money usd={run.spentUsd} against={run.budgetUsd} />,
  },
  {
    id: 'budget',
    head: 'Budget',
    priority: 1,
    min: 120,
    card: 'meta',
    value: (run) => run.budgetUsd,
    cell: (run) =>
      run.budgetUsd == null ? (
        <span className="text-ink-muted">no budget</span>
      ) : (
        <span className="tnum">of {money(run.budgetUsd)}</span>
      ),
  },
  {
    id: 'run',
    head: 'Run',
    min: 120,
    everything: true,
    value: (run) => run.runId,
    cell: (run) => <Mono value={run.runId} chars={12} />,
  },
];

export function CostVsCapsPanel({
  spend,
  plan,
  everything = false,
}: {
  spend: SpendView | undefined;
  plan?: string;
  everything?: boolean;
}) {
  if (!spend) {
    return (
      <Empty
        title="No spend report: this console’s server predates it, or nothing has cost anything yet."
        action={
          <Button size="sm" asChild>
            <a href={settingsHref('automation')}>See the spend caps</a>
          </Button>
        }
      />
    );
  }

  const reading = costReading(spend, plan);
  const cap = reading.cap;

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="insights-cost">
      <FactRows facts={reading.facts} />

      {cap ? (
        <div className="flex max-w-(--measure) min-w-0 flex-col gap-1.5">
          <LoadMeter
            value={cap.ladderUsd}
            max={cap.capUsd}
            label="Ladder spend today against the day cap"
            valueText={`${money(cap.ladderUsd)} of ${money(cap.capUsd)}`}
            paint={cap.atCap ? 'needs-you' : 'running'}
          />
          <p className="text-meta text-ink-muted">
            {cap.atCap
              ? 'At the cap: the ladder refuses its next rung until midnight. '
              : `${cap.room} of ladder left today. `}
            The runs settled {money(spend.today.settledUsd)} on top; the cap does not count it.
          </p>
        </div>
      ) : (
        <p className="max-w-(--measure) text-meta text-ink-muted">
          No day cap is set, so nothing refuses a rung on cost.{' '}
          <a href={settingsHref('automation')} className={PROSE_LINK}>
            Set one in Settings
          </a>
        </p>
      )}

      {reading.days.length > 0 && (
        <FigureBlock caption="Spend per day, settled and ladder together" className="max-w-(--measure)">
          <BarList items={reading.days} format={money} label="days" heads={{ name: 'Day', value: 'Spend' }} />
          <FigureNumbers
            label="days, settled and ladder apart"
            caption="Each day's settled spend and ladder spend, as the server summed them"
            rows={reading.split}
            getRowKey={(day) => day.day}
            columns={[
              { head: 'Day', cell: (day) => day.day },
              { head: 'Settled', cell: (day) => money(day.settledUsd), align: 'end' },
              { head: 'Ladder', cell: (day) => money(day.ladderUsd), align: 'end' },
            ]}
          />
          {everything && (
            <InsightNote>
              A day whose ladder figure runs close to its settled one was spent on repair.
            </InsightNote>
          )}
        </FigureBlock>
      )}

      <div className="flex min-w-0 flex-col gap-2">
        <SectionHeading
          as="h3"
          aside={plan ? <span className="text-meta text-ink-muted">{plan} only</span> : null}
        >
          Runs against their budgets
        </SectionHeading>
        {reading.runs.length ? (
          // Folded as a figure's numbers are: the figures above are the glance,
          // and each run's own is one press away.
          <Disclosure label="The runs" openLabel="Hide the runs" count={reading.runs.length}>
            <Grid
              columns={RUN_COLUMNS}
              rows={reading.runs}
              getRowKey={(run) => run.runId}
              label="Each run against its budget"
              tableId="insights-runs"
              everything={everything}
              rowHref={(run) => runHref(run.slug)}
              detail={(run) => <RunSpendDetail run={run} />}
            />
          </Disclosure>
        ) : (
          <p className="text-body text-ink-muted">
            {plan ? 'No run of this plan has cost anything yet.' : 'No run has cost anything yet.'}
          </p>
        )}
      </div>
    </div>
  );
}
