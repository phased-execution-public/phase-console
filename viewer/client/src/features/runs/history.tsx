/**
 * Earlier runs of this plan.
 *
 * The first entry of `history` is the run the rest of the page is about, so it is
 * dropped here rather than shown twice — and with one run there is nothing to
 * say, so the section does not exist at all.
 *
 * Runs are recorded outside the repository (`~/.local/state/…`), which is why
 * none of this shows up in `git status` and why a plan can have a history on one
 * machine and none on another.
 */

import { Card, CardBody, CardHeader, CardTitle, MonoId, RelativeTime } from '@/components/ui';
import { RunStatusBadge } from '@/components/ui/status';
import { DataTable, type Column } from '@/components/data-table';
import { money } from '@/lib/format';
import { runHref } from '@/app/routes';
import type { RunState } from '@/lib/api';

const COLUMNS: Column<RunState>[] = [
  {
    id: 'run',
    head: 'Run',
    priority: 1,
    min: 140,
    flex: true,
    identity: true,
    card: 'title',
    // The whole id is the hover and the clipboard: an id long enough to fill
    // the column is an id nobody can carry to a `grep` off the screen.
    cell: (r) => <MonoId id={r.id} chars={12} copyable />,
  },
  {
    id: 'status',
    head: 'Status',
    priority: 1,
    min: 128,
    card: 'meta',
    // The typed badge (control-tower phase 24): the run's word through the
    // status model — its icon beside it, its reason on hover.
    cell: (r) => <RunStatusBadge run={r} />,
  },
  {
    id: 'updated',
    head: 'Updated',
    priority: 2,
    min: 128,
    card: 'meta',
    // `live={false}`: a table of past runs never changes, and one interval
    // per row for a figure that cannot move is pure wakeups.
    cell: (r) => <RelativeTime at={r.updatedAt} live={false} className="text-ink-faint" />,
  },
  {
    id: 'spent',
    head: 'Spent',
    priority: 2,
    min: 96,
    align: 'end',
    // The same treatment the run's own phase table gives money: a column of
    // figures that re-flows digit by digit is a column you cannot compare down.
    cell: (r) => <span className="font-mono tabular-nums">{money(r.spentUsd)}</span>,
  },
];

export function RunHistory({ history }: { history: RunState[] }) {
  const earlier = history.slice(1);
  if (!earlier.length) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Earlier runs</CardTitle>
      </CardHeader>
      <CardBody className="p-0">
        <DataTable
          label="Earlier runs"
          columns={COLUMNS}
          rows={earlier}
          getRowKey={(r) => r.id}
          // No `empty`: this section does not exist when there is nothing in
          // it (the early return above), which is the better answer than a
          // card explaining that a plan has only ever been run once.
          rowHref={(r) => runHref(r.slug)}
        />
      </CardBody>
    </Card>
  );
}
