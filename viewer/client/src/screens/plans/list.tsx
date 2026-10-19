/**
 * The plans as a list — one line per plan on the grid (7.0, quiet-console
 * phase 9).
 *
 * ```
 * Status                 Plan                  Phases                                  Left         Moved
 * ● Running (Active)     storefront redesign   ████████████▌▐▒▒▒▒░░░░░░                5 sessions   2h ago
 *                                              41 done · 1 in progress · 3 waiting · 56 %
 * ● Needs you (Active)   cart api              ███▐░░░░░  3 done · 1 next up · 5 waiting  2 sessions   3d ago
 * ```
 *
 * `(Active)` is the plan's own status badge (#361); the Phases column is the
 * plan's phases in proportion with its legend (#360, `track-bar.tsx`).
 *
 * The five facts at the glance; Everything draws the rest as columns — the
 * slug, the reading, the phases next up, the estimate, the run, who waits,
 * what is wrong, where it lives. On a phone the same columns are records: the
 * name, then the quiet line of facts, and everything else one press away.
 * The status and the name pin together while a wide table scrolls.
 */

import { useMemo, type ReactNode } from 'react';
import { progressReading } from '@shared/plan-vocab.js';
import { prefetchIntent, usePrefetchPlan } from '@/data/plans';
import { etaLabel, etaTitle, plural } from '@/lib/format';
import { Mono, RelativeTime, type Everything } from '@/ui';
import { Grid } from '@/ui/grid/grid';
import type { Column } from '@/ui/grid/column';
import { PlanStatus, type WordOf } from '@/ui/status';
import { planHref, turnHref } from '@/shell/routes';
import { concerns, leftWords, markLabel, repoLabel, type PlanRow } from './model';
import { ConcernLines, NextUpLinks, PlanLine, PlanMark, RunLink } from './row';

const none = <span className="text-ink-faint">—</span>;

/**
 * Every column a plan has. The first five are the glance, in the order the
 * design law reads a line: the mark, the name, the line, what is left, when
 * it moved. The rest are Everything's.
 */
export function libraryColumns(): Column<PlanRow>[] {
  return [
    {
      id: 'status',
      head: 'Status',
      priority: 1,
      // The plan's badge, and a run's word beside it when one leads (#361).
      min: 168,
      card: 'meta',
      value: markLabel,
      sort: { id: 'attention', dir: 'descending' },
      cell: (row) => <PlanMark row={row} />,
    },
    {
      id: 'plan',
      head: 'Plan',
      priority: 1,
      min: 200,
      flex: true,
      identity: true,
      card: 'title',
      value: (row) => row.title,
      sort: { id: 'name', dir: 'ascending' },
      cell: (row) => <span className="text-body text-ink">{row.title}</span>,
    },
    {
      id: 'line',
      head: 'Phases',
      priority: 2,
      min: 280,
      card: 'meta',
      value: (row) => row.percent,
      sort: { id: 'progress', dir: 'descending' },
      cell: (row) => <PlanLine row={row} />,
    },
    {
      id: 'left',
      head: 'Left',
      priority: 2,
      min: 112,
      card: 'meta',
      value: (row) => row.remainingSessions,
      cell: (row) => (
        <span className="tnum" title={row.eta ? etaTitle(row.eta) : undefined}>
          {leftWords(row)}
        </span>
      ),
    },
    {
      id: 'moved',
      head: 'Moved',
      priority: 3,
      // Wide enough for "57 minutes ago" on one line: at 104 it wrapped, and
      // the row stood twice the height of its neighbours at 1024 and 1280.
      // Never nowrap — a clock may still break rather than escape its cell.
      min: 136,
      card: 'meta',
      value: (row) => row.activity,
      sort: { id: 'activity', dir: 'descending' },
      cell: (row) => (row.activity ? <RelativeTime at={row.activity} live={false} /> : none),
    },

    /* ---- Everything ---- */
    {
      id: 'slug',
      head: 'Slug',
      min: 180,
      everything: true,
      value: (row) => row.slug,
      cell: (row) => <Mono value={row.slug} copyable />,
    },
    {
      id: 'reading',
      head: 'Done',
      min: 150,
      everything: true,
      value: (row) => row.done,
      cell: (row) => {
        const reading = progressReading(row);
        return row.phases ? (
          <span className="tnum" title={reading.title}>
            {reading.text}
          </span>
        ) : (
          none
        );
      },
    },
    {
      id: 'next',
      head: 'Next up',
      min: 160,
      everything: true,
      value: (row) => (row.isClosed ? 0 : row.readyPhases.length),
      sort: { id: 'ready', dir: 'descending' },
      cell: (row) => (!row.isClosed && row.readyPhases.length ? <NextUpLinks row={row} max={3} /> : none),
    },
    {
      id: 'estimate',
      head: 'Estimate',
      min: 280,
      everything: true,
      value: (row) => row.eta?.highMs ?? null,
      cell: (row) =>
        row.eta && !row.isClosed ? (
          <span title={etaTitle(row.eta)}>{etaLabel(row.eta.lowMs, row.eta.highMs, row.eta.basis)}</span>
        ) : (
          none
        ),
    },
    {
      id: 'run',
      head: 'Run',
      min: 160,
      everything: true,
      value: (row) => row.run?.view.label ?? null,
      cell: (row) => (row.run ? <RunLink row={row} /> : none),
    },
    {
      id: 'waiting',
      head: 'Waiting on you',
      min: 140,
      everything: true,
      value: (row) => row.needsYou,
      cell: (row) =>
        row.needsYou ? (
          <a href={turnHref()} className="tnum rounded-sm hover:underline">
            {plural(row.needsYou, 'thing')}
          </a>
        ) : (
          none
        ),
    },
    {
      id: 'health',
      head: 'Health',
      min: 240,
      everything: true,
      value: (row) => concerns(row)[0]?.text ?? null,
      cell: (row) => (concerns(row).length ? <ConcernLines row={row} /> : none),
    },
    {
      id: 'repos',
      head: 'Repositories',
      min: 170,
      everything: true,
      value: (row) => row.repos.join(', '),
      cell: (row) =>
        row.repos.length ? <span title={repoLabel(row.repos).title}>{repoLabel(row.repos).text}</span> : none,
    },
    {
      id: 'branch',
      head: 'Branch',
      min: 170,
      everything: true,
      value: (row) => row.branch ?? null,
      cell: (row) => (row.branch ? <Mono value={row.branch} /> : none),
    },
    {
      id: 'plan-status',
      head: 'Plan status',
      min: 132,
      everything: true,
      value: (row) => row.status,
      cell: (row) =>
        row.isPlan ? (
          <PlanStatus
            status={row.status as WordOf<'plan'>}
            chrome="badge"
            withNote={false}
            data-testid="plan-status"
          />
        ) : (
          none
        ),
    },
    {
      id: 'handoffs',
      head: 'Handoffs',
      min: 96,
      align: 'end',
      everything: true,
      value: (row) => row.handoffCount,
      cell: (row) => <span className="tnum">{row.handoffCount}</span>,
    },
    {
      id: 'started',
      head: 'Started',
      min: 112,
      everything: true,
      value: (row) => row.summary?.startedAt ?? null,
      cell: (row) =>
        row.summary?.startedAt ? <RelativeTime at={row.summary.startedAt} live={false} /> : none,
    },
    {
      id: 'model',
      head: 'Model',
      min: 160,
      everything: true,
      value: (row) => row.summary?.targetModel ?? null,
      cell: (row) => (row.summary?.targetModel ? <Mono value={row.summary?.targetModel} /> : none),
    },
    {
      id: 'qa',
      head: 'QA',
      min: 96,
      everything: true,
      value: (row) => row.summary?.qaMode ?? null,
      cell: (row) => row.summary?.qaMode || none,
    },
  ];
}

export interface PlanListProps {
  rows: readonly PlanRow[];
  everything: Everything;
  sort: string;
  onSort: (id: string) => void;
  /** What opens in place under a row — the verbs and the phases next up. */
  detail: (row: PlanRow) => ReactNode;
  /** The grid's own name for this list — each group and fold is a table of its own. */
  label: string;
  tableId: string;
  empty?: ReactNode;
}

export function PlanList({ rows, everything, sort, onSort, detail, label, tableId, empty }: PlanListProps) {
  const columns = useMemo(() => libraryColumns(), []);
  // A pointer resting on a row, or a Tab landing on its link, buys the plan's
  // round trip while the reader decides — the click then paints from cache.
  const prefetch = usePrefetchPlan();
  return (
    <Grid
      columns={columns}
      rows={rows}
      getRowKey={(row) => row.slug}
      label={label}
      tableId={tableId}
      toolbar={false}
      everything={everything}
      activeSort={sort}
      onSort={onSort}
      rowHref={(row) => planHref(row.slug)}
      rowProps={(row) => ({
        ...prefetchIntent(prefetch, row.slug),
        'data-plan-row': row.slug,
        'data-closed': row.isClosed ? '' : undefined,
      })}
      detail={detail}
      virtual
      empty={empty}
    />
  );
}
