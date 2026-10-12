/**
 * What each session cost — every open plan's newest runs, per plan and per
 * account, summed from each session's own `phase.session` line rather than
 * from the runs' running totals (zero-touch phase 19; chapter 03 SES-1).
 *
 * The run view reconciles one run's sessions against its spend; this is the
 * same ledger across the portfolio, so the two cannot count differently. A
 * session that never reported a cost is counted apart, never as $0 — and the
 * count is the server's (`unknownSessions`), not the rows added up here — and
 * a run whose journal read was cut makes its figures lower bounds, said so.
 *
 * One hue, the figures' own: a bar's length is the only encoding, and the
 * plan or account is its label, never a colour.
 */

import { useLedgerSummary } from '@/data/runs';
import { money, plural } from '@/lib/format';
import { Skeleton } from '@/ui';
import { BarList } from '@/ui/figures/lazy';
import { FigureBlock, InsightNote } from './parts';

type LedgerRows = NonNullable<ReturnType<typeof useLedgerSummary>['data']>['plans'];

const bars = (rows: LedgerRows) => rows.map((row) => ({ name: row.key, value: row.costUsd }));

export function LedgerSummaryPanel({ everything = false }: { everything?: boolean }) {
  const { data, isPending, error } = useLedgerSummary();
  if (error) {
    return (
      <p className="text-body text-ink-muted">
        The run ledgers could not be read: {(error as Error).message || 'the read failed and said nothing.'}
      </p>
    );
  }
  // The figures' own height while the ledgers are read, so nothing below moves when they arrive.
  if (isPending && !data) {
    return (
      <div aria-busy="true" className="min-w-0">
        <Skeleton className="h-28" />
      </div>
    );
  }

  const unknown = data?.unknownSessions ?? 0;
  const truncated = data?.truncatedRuns ?? 0;

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="insights-ledger">
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <FigureBlock caption="Per plan">
          <BarList
            items={bars(data?.plans ?? [])}
            format={money}
            label="plans"
            empty="No run of an open plan has reported a session yet."
          />
        </FigureBlock>
        <FigureBlock caption="Per account">
          <BarList
            items={bars(data?.accounts ?? [])}
            format={money}
            label="accounts"
            empty="No account has paid for a session yet."
          />
        </FigureBlock>
      </div>
      {(unknown > 0 || truncated > 0) && (
        <p className="max-w-(--measure) text-meta text-ink-muted">
          {unknown > 0
            ? `${plural(unknown, 'session')} never reported a cost and ${unknown === 1 ? 'is' : 'are'} not counted. `
            : ''}
          {truncated > 0
            ? `${plural(truncated, 'run')} had a journal too long to read whole; those figures are lower bounds.`
            : ''}
        </p>
      )}
      {everything && (
        <InsightNote>
          Summed from each session’s own report of what it cost, over every open plan’s newest runs. A run’s
          own ledger, reconciled against its spend, is on its run view.
        </InsightNote>
      )}
    </div>
  );
}
