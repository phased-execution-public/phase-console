/**
 * A run's spend in the panel — Inspect, the second door to depth, for
 * Insights' "Each run against its budget" (7.0, quiet-console phase 27;
 * design.md principle 3).
 *
 * The grid draws a run as one line — its plan, what it spent, its budget — and
 * keeps its id for Everything; Inspect, from the line's fold, hands the panel
 * the row's whole record: every figure it carries, in words, and the row as
 * the server sent it. Overview and Raw: the spend report keeps no history of a
 * run, and what a run can be told to do is its own page's.
 *
 * Every figure is the SERVER's (`/api/spend`, `server/analysis/spend.ts`), as
 * everywhere on Insights (`./model`). What a run spent and its budget are said
 * side by side and never subtracted: the report sends no room under a run's
 * budget, and a difference made here would be a second arithmetic beside the
 * one a run is stopped by. A sum over its budget is painted by the kit's
 * `Money`, exactly as the row paints it.
 *
 * Read live from the one spend answer the page reads, so a run that spends
 * while it is on show moves in the panel, and the panel says when its figures
 * were read; a run the report stops carrying keeps the figures it was
 * inspected with, and says so.
 */

import type { SpendView } from '@/data/api';
import { useSpend } from '@/data/runs';
import { money } from '@/lib/format';
import { RawTab } from '@/shell/panel/raw-tab';
import { inspect } from '@/shell/panel/inspector-host';
import { KeyValue, Money, Mono, RelativeTime } from '@/ui';

type SpendRow = SpendView['runs'][number];

/** The panel's name for a run's spend — what `useInspected()` is compared to, to mark the row on show. */
export const runSpendKey = (runId: string): string => `spend:${runId}`;

/** The run as the spend answer holds it now, when it was read — or as it was inspected, once the answer drops it. */
function useLiveSpend(row: SpendRow): { row: SpendRow; readAt: number | null; dropped: boolean } {
  const { data, dataUpdatedAt } = useSpend();
  const live = data?.runs.find((one) => one.runId === row.runId);
  if (live) return { row: live, readAt: dataUpdatedAt || null, dropped: false };
  return { row, readAt: null, dropped: data !== undefined };
}

/** Every figure the row carries, in words. */
function RunSpendOverview({ row: inspected }: { row: SpendRow }) {
  const { row, readAt, dropped } = useLiveSpend(inspected);
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="run-spend-overview">
      {dropped && (
        <p className="max-w-(--measure) text-meta text-ink-muted">
          The latest spend report no longer carries this run: these are its figures from when it was
          inspected.
        </p>
      )}
      <KeyValue
        items={[
          ['Plan', row.slug || null],
          ['Run', <Mono key="run" value={row.runId} copyable className="wrap-anywhere" />],
          ['Spent', <Money key="spent" usd={row.spentUsd} against={row.budgetUsd} />],
          ['Budget', row.budgetUsd == null ? 'None set' : money(row.budgetUsd)],
          readAt != null ? ['Read', <RelativeTime key="read" at={readAt} />] : null,
        ]}
      />
    </div>
  );
}

/** The row as the server sent it, read live as the Overview is. */
function RunSpendRaw({ row: inspected }: { row: SpendRow }) {
  const { row } = useLiveSpend(inspected);
  return <RawTab value={row} />;
}

/** Show one run's spend in the panel, named as its line names it. */
export function inspectRunSpend(row: SpendRow): void {
  inspect({
    key: runSpendKey(row.runId),
    title: row.slug || `Run ${row.runId}`,
    description: (
      <>
        Run <Mono value={row.runId} chars={12} />
      </>
    ),
    overview: <RunSpendOverview row={row} />,
    raw: <RunSpendRaw row={row} />,
  });
}
