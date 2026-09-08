import { useMemo } from 'react';
/**
 * A plan as a table row — the comparing layout.
 *
 * Every plan on one screen, sortable by the column you are asking about. The
 * card (`card.tsx`) is the browsing layout; both read the same `PlanRow` and
 * the same chips from `row.tsx`.
 */

import { DataTable, RelativeTime, type Column } from '@/components/ui';
import { Lock } from 'lucide-react';
import { etaLabel, etaTitle } from '@/lib/format';
import { closedTitle } from '@/lib/closure';
import { prefetchIntent, usePrefetchPlan } from '@/lib/queries';
import { cn } from '@/lib/cn';
import { phaseHref, planHref } from '@shared/routes.js';
import { concerns, type PlanRow, type SortId } from './model';
import { ConcernChip, NeedsYouChip, RunChip, Track, repoLabel } from './row';

/**
 * The nine columns.
 *
 * `priority` decides what survives a narrow window, and it is a judgement
 * about the question each column answers: the name and what is wrong with it
 * are why anyone opened this page, so they never leave. Repos is the first to
 * go — it is the one you filter by rather than read.
 */
function planColumnsFor(): Column<PlanRow>[] {
  // Every order but Name runs biggest-first, and saying so is the difference
  // between a screen reader announcing the column and announcing the sort.
  const sortOf = (id: SortId): { sort: Column<PlanRow>['sort'] } => ({
    sort: { id, dir: id === 'name' ? 'ascending' : 'descending' },
  });
  return [
    {
      id: 'plan',
      head: 'Plan',
      priority: 1,
      min: 240,
      flex: true,
      identity: true,
      card: 'title',
      ...sortOf('name'),
      cell: (row) => (
        /* The table had NO closed marker at all. Every other signal it shows is
           one closure suppresses — Ready reads `—`, Health is blank, Left is
           `—` — so a closed plan rendered as a live plan with nothing to do,
           which is the one reading that is worse than either truth. */
        <a href={planHref(row.slug)} className="block min-w-0 hover:text-action">
          <span className={cn('flex min-w-0 items-center gap-1.5', row.isClosed && 'text-ink-muted')}>
            <span className="truncate">{row.title}</span>
            {row.isClosed && (
              <span
                title={closedTitle(row)}
                className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-rule bg-surface-raised px-1 py-px text-2xs font-medium uppercase tracking-wide text-ink-faint"
              >
                <Lock size={9} className="shrink-0" aria-hidden />
                {row.status}
              </span>
            )}
          </span>
          {row.slug !== row.title && (
            <span className="block truncate font-mono text-2xs text-ink-faint">{row.slug}</span>
          )}
        </a>
      ),
    },
    { id: 'track', head: 'Track', priority: 3, min: 128, card: 'meta', cell: (row) => <Track row={row} /> },
    {
      id: 'done',
      head: 'Done',
      priority: 2,
      min: 76,
      align: 'end',
      ...sortOf('progress'),
      cell: (row) => (row.phases ? `${row.done}/${row.phases}` : '—'),
    },
    {
      id: 'ready',
      head: 'Ready',
      priority: 2,
      min: 76,
      align: 'end',
      ...sortOf('ready'),
      // Same rule as the card: a closed plan reads `—`, not a live count in
      // ready-amber linking into a phase nobody will run.
      cell: (row) =>
        !row.isClosed && row.readyPhases.length ? (
          <a
            href={phaseHref(row.slug, row.readyPhases[0])}
            className="text-ready hover:text-action"
            title={`Open phase ${row.readyPhases[0]}`}
          >
            {row.readyPhases.length}
          </a>
        ) : (
          <span className="text-ink-faint">—</span>
        ),
    },
    {
      id: 'left',
      head: 'Left',
      priority: 3,
      min: 152,
      align: 'end',
      // Sessions is the unit of work left; the estimate under it is what that
      // has been costing in wall-clock. Sorting still keys off the session
      // count — a time is a derived reading of it.
      cell: (row) => (
        <span className="text-ink-faint">
          {row.remainingSessions || '—'}
          {row.eta && (
            <span className="block" title={etaTitle(row.eta)}>
              {etaLabel(row.eta.lowMs, row.eta.highMs, row.eta.basis)}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'repos',
      head: 'Repos',
      priority: 4,
      min: 120,
      cell: (row) => (
        <span className="block truncate font-mono text-2xs text-ink-faint" title={repoLabel(row.repos).title}>
          {repoLabel(row.repos).text || '—'}
        </span>
      ),
    },
    {
      id: 'health',
      head: 'Health',
      priority: 1,
      min: 192,
      ...sortOf('attention'),
      // Needs-you rides in the Health cell, ahead of the concern: it is the
      // same column's question — what is wrong here — and it is the only
      // answer that names a person rather than a state.
      cell: (row) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <NeedsYouChip row={row} />
          <ConcernChip row={row} />
          {row.needsYou === 0 && concerns(row).filter((c) => c.key !== 'needs-you').length === 0 && (
            <span className="text-ink-faint">—</span>
          )}
        </span>
      ),
    },
    {
      id: 'run',
      head: 'Run',
      priority: 2,
      min: 128,
      card: 'meta',
      cell: (row) => (
        <>
          <RunChip row={row} /> {!row.run && <span className="text-ink-faint">—</span>}
        </>
      ),
    },
    {
      id: 'activity',
      head: 'Activity',
      priority: 3,
      min: 104,
      ...sortOf('activity'),
      // `live={false}`: this table draws every plan in the source, and one
      // interval per row is a timer per row for a figure that moves by the hour.
      cell: (row) => <RelativeTime at={row.activity} live={false} className="text-2xs text-ink-faint" />,
    },
  ];
}

export function PlanTable({
  rows,
  sortId,
  onSort,
}: {
  rows: PlanRow[];
  sortId: SortId;
  onSort: (id: SortId) => void;
}) {
  // A pointer resting on a row, or a Tab landing on its link, buys the plan's
  // round trip while the reader is still deciding — so the click paints from
  // cache instead of waiting. Free to be wrong: `prefetchQuery` is a no-op on a
  // key that already holds fresh data, and everything here is fresh forever.
  const prefetch = usePrefetchPlan();
  const columns = useMemo(() => planColumnsFor(), []);

  return (
    <DataTable
      label="Plans"
      columns={columns}
      rows={rows}
      getRowKey={(row) => row.slug}
      activeSort={sortId}
      onSort={(id) => onSort(id as SortId)}
      rowProps={(row) => prefetchIntent(prefetch, row.slug)}
    />
  );
}
