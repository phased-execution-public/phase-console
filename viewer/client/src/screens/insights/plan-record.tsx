/**
 * This plan's record — where the QA verdicts have a home.
 *
 * `PlanDetail.qa` carries a verdict and a report PATH per phase, and until 3.0
 * no surface rendered it: a verdict an operator could act on was a file only
 * somebody who knew the convention could find. Every row opens its phase's
 * handoff; a row with a report links to the report too.
 *
 * Two orders, and the second is why the control exists: a plan with
 * twenty-two verdicts reads as a wall of passes in plan order, and the one
 * failure in it is wherever its phase number puts it. Worst-first is not a
 * rank written here — it is the verdict's paint's place in `UI_STATES`, the
 * vocabulary's own worst-first order; a word this console does not know sorts
 * last rather than first.
 */

import { useMemo, useState } from 'react';
import { describeWord } from '@shared/status-model.js';
import { UI_STATES } from '@shared/status-vocab.js';
import { qaReportHref, qaReportRound } from '@/lib/qa';
import { handoffHref, planHref } from '@/shell/routes';
import { Button, Empty, Mono } from '@/ui';
import type { Column } from '@/ui/grid/column';
import { Grid } from '@/ui/grid/grid';
import { QaStatus, type WordOf } from '@/ui/status';
import { PROSE_LINK } from './parts';

/** One recorded QA verdict, as the plan detail carries it. */
export type QaRow = { phase: number; result: string; report?: string };
type RecordSort = 'phase' | 'verdict';

const verdictRank = (result: string): number => {
  const at = UI_STATES.indexOf(describeWord('qa-result', result).paint);
  return at < 0 ? UI_STATES.length : at;
};

const ORDER: Readonly<Record<RecordSort, (a: QaRow, b: QaRow) => number>> = {
  phase: (a, b) => a.phase - b.phase,
  verdict: (a, b) => verdictRank(a.result) - verdictRank(b.result) || a.phase - b.phase,
};

function recordColumns(slug: string): Column<QaRow>[] {
  return [
    {
      id: 'phase',
      head: 'Phase',
      priority: 1,
      min: 72,
      identity: true,
      card: 'title',
      sort: { id: 'phase', dir: 'ascending' },
      value: (row) => row.phase,
      cell: (row) => <span className="tnum text-ink">P{row.phase}</span>,
    },
    {
      id: 'verdict',
      head: 'Verdict',
      priority: 1,
      min: 120,
      card: 'meta',
      sort: { id: 'verdict', dir: 'ascending' },
      value: (row) => row.result,
      cell: (row) => <QaStatus result={row.result as WordOf<'qa-result'>} />,
    },
    {
      id: 'report',
      head: 'Report',
      priority: 2,
      min: 200,
      flex: true,
      value: (row) => row.report ?? null,
      cell: (row) =>
        row.report ? (
          <a
            href={qaReportHref(slug, row.phase, qaReportRound(row.report))}
            className="tap-line min-w-0 wrap-anywhere text-ink underline decoration-ink-faint underline-offset-2"
            title={row.report}
          >
            <Mono value={row.report} />
          </a>
        ) : (
          <span className="text-ink-muted">no report file</span>
        ),
    },
  ];
}

export function PlanRecord({ slug, qa }: { slug: string; qa: readonly QaRow[] }) {
  const [sort, setSort] = useState<RecordSort>('phase');
  const rows = useMemo(() => [...qa].sort(ORDER[sort]), [qa, sort]);
  const columns = useMemo(() => recordColumns(slug), [slug]);

  if (!rows.length) {
    return (
      <Empty
        title="QA is off for this plan: an empty record means nothing was asked for, not that anything failed."
        action={
          <Button size="sm" asChild>
            <a href={planHref(slug, 'source')}>Read the plan’s QA line</a>
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="insights-plan-record">
      <p className="text-meta text-ink-muted">
        {rows.length === 1 ? 'One QA verdict' : `${rows.length} QA verdicts`}, from{' '}
        <a href={planHref(slug, 'source')} className={PROSE_LINK}>
          the plan’s test-status.md
        </a>
      </p>
      <Grid
        columns={columns}
        rows={rows}
        getRowKey={(row) => String(row.phase)}
        label="QA verdicts"
        tableId="insights-qa"
        rowHref={(row) => handoffHref(slug, row.phase)}
        activeSort={sort}
        onSort={(id) => setSort(id === 'verdict' ? 'verdict' : 'phase')}
      />
    </div>
  );
}
