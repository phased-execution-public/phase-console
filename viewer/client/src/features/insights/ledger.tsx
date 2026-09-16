/**
 * The ledger, aggregated (zero-touch phase 19; chapter 03 SES-1) — what every
 * open plan's newest runs cost, per plan and per account, summed from each
 * session's own `phase.session` line rather than from the runs' running totals.
 *
 * The run page reconciles one run's sessions against its spend; this is the same
 * ledger across the portfolio, so the two cannot count differently. A session
 * that never reported a cost is counted apart as unknown, never as $0, and a run
 * whose journal read was cut is said to be a lower bound.
 *
 * One hue, the chart family's own (`components/charts.tsx`): a bar's length is
 * the only encoding, and the plan or account is its label — never a colour.
 */

import { BarList } from '@/components/charts';
import { plural } from '@/lib/format';
import { useLedgerSummary } from '@/lib/queries';

export function LedgerSummaryPanel() {
  const { data, isPending, error } = useLedgerSummary();
  if (error) return <p className="text-sm text-ink-muted">The run ledgers could not be read.</p>;
  if (isPending && !data) return <p className="text-sm text-ink-muted">Reading every run’s ledger…</p>;

  const plans = data?.plans ?? [];
  const accounts = data?.accounts ?? [];
  const unknown = plans.reduce((sum, row) => sum + row.unknownCost, 0);
  const bars = (rows: typeof plans) =>
    rows.map((row) => ({ name: row.key, value: Math.round(row.costUsd * 100) / 100 }));

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="insights-ledger">
      <div className="grid min-w-0 gap-6 md:grid-cols-2">
        <div className="min-w-0">
          <h3 className="mb-2 text-xs text-ink-muted">Per plan</h3>
          <BarList items={bars(plans)} unit=" USD" label="plans" />
        </div>
        <div className="min-w-0">
          <h3 className="mb-2 text-xs text-ink-muted">Per account</h3>
          <BarList items={bars(accounts)} unit=" USD" label="accounts" />
        </div>
      </div>
      {(unknown > 0 || (data?.truncatedRuns ?? 0) > 0) && (
        <p className="text-2xs text-ink-faint">
          {unknown > 0
            ? `${plural(unknown, 'session')} never reported a cost and ${unknown === 1 ? 'is' : 'are'} not counted. `
            : ''}
          {(data?.truncatedRuns ?? 0) > 0
            ? `${plural(data?.truncatedRuns ?? 0, 'run')} had a journal too long to read whole — those figures are lower bounds.`
            : ''}
        </p>
      )}
    </div>
  );
}
