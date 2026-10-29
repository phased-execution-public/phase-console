/**
 * The plans as a list — one line per plan on the grid (7.0, quiet-console
 * phase 9; the owner's richer table, which scrolls).
 *
 * ```
 * Status                    Plan                 Phases                              Now           Waiting on            Next up     Your turn  Left        Spent   Account  Model        Moved
 * ● Running ◎ Active  Why   storefront redesign  ▮▮▮▮▮▮▮▮▮▮▮▯▯▯▯▯  (56 %)            P42 ● Running  —                     P43 next up  —          5 sessions  $41.20  work     opus 5.5     2h ago
 *                                                (41 done) (1 in progress) (3 waiting)                                                          ~2–3 h …    Claude   effort high
 * ```
 *
 * The status leads every row as a button: the plan's own badge, a run's or a
 * person's word beside it (#361), and *Why*, which opens the plan in the panel
 * on the reasons behind the word (`./why`). The Phases column is the plan's
 * phases as a pipeline with its badges and its percentage (#360,
 * `track-bar.tsx`). Then what is live now, the one thing it waits on, the
 * phases next up, its items on Your turn, the work left with the estimate,
 * what its runs spent, who pays and on which model, and when it last moved —
 * every one of them `priority: 1`, so a desk that cannot fit them never folds
 * them away: the table scrolls inside its own box, the status and the name
 * pinned at its start (the grid's rail), and the header stays put above the
 * box rather than sticking inside a scroller (design.md §10 rule 6).
 *
 * Everything draws the rest as columns — the slug, the reading, the run, what
 * is wrong, where it lives, the plan's own status word, the handoffs, when it
 * started, its QA regime. On a phone the same columns are records: the name,
 * then the quiet line of facts, and everything else one press away.
 */

import { useMemo, type ReactNode } from 'react';
import { progressReading } from '@shared/plan-vocab.js';
import { prefetchIntent, usePrefetchPlan } from '@/data/plans';
import { Mono, RelativeTime, type Everything } from '@/ui';
import { Grid } from '@/ui/grid/grid';
import type { Column } from '@/ui/grid/column';
import { PlanStatus, type WordOf } from '@/ui/status';
import { planHref } from '@/shell/routes';
import { planRecordKey } from './inspector';
import { concerns, markLabel, repoLabel, type PlanRow } from './model';
import {
  AccountCell,
  ConcernLines,
  LeftCell,
  ModelCell,
  NextUpLinks,
  NowCell,
  PlanLine,
  PlanStatusButton,
  RunLink,
  SpentCell,
  TurnCell,
  WaitsCell,
} from './row';
import { liveNowOf, waitsOnOf } from './why';

const none = <span className="text-ink-faint">—</span>;

/** What the status column presses, and whose record the panel holds. */
export interface StatusDoor {
  onWhy: (row: PlanRow) => void;
  /** The key of the record the panel holds now (`useInspected`). */
  inspected?: string | undefined;
}

/**
 * Every column a plan has. The glance first, in the order the design law
 * reads a line — the mark, the name, the line — then the facts the owner
 * asked for beside them, each `priority: 1` (the table scrolls rather than
 * folding any of them away). The rest are Everything's.
 */
export function libraryColumns(door: StatusDoor): Column<PlanRow>[] {
  return [
    {
      id: 'status',
      head: 'Status',
      priority: 1,
      // The plan's badge, a run's word beside it when one leads (#361), and
      // *Why*. Status and name together stay under half a desk's box with the
      // panel docked beside it, so the grid's rail pins both while it scrolls.
      min: 176,
      card: 'meta',
      value: markLabel,
      sort: { id: 'attention', dir: 'descending' },
      cell: (row) => (
        <PlanStatusButton row={row} onWhy={door.onWhy} pressed={door.inspected === planRecordKey(row.slug)} />
      ),
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
      priority: 1,
      // The pipeline and its percentage on one line; its badges wrap under it.
      min: 300,
      card: 'meta',
      value: (row) => row.percent,
      sort: { id: 'progress', dir: 'descending' },
      cell: (row) => <PlanLine row={row} />,
    },
    {
      id: 'now',
      head: 'Now',
      priority: 1,
      min: 150,
      value: (row) =>
        liveNowOf(row)
          .map((lane) => `P${lane.phase}`)
          .join(' ') || null,
      cell: (row) => <NowCell row={row} />,
    },
    {
      id: 'waits',
      head: 'Waiting on',
      priority: 1,
      min: 240,
      value: (row) => waitsOnOf(row)?.lead ?? null,
      cell: (row) => <WaitsCell row={row} />,
    },
    {
      id: 'next',
      head: 'Next up',
      priority: 1,
      min: 150,
      value: (row) => (row.isClosed ? 0 : row.readyPhases.length),
      sort: { id: 'ready', dir: 'descending' },
      cell: (row) => (!row.isClosed && row.readyPhases.length ? <NextUpLinks row={row} max={3} /> : none),
    },
    {
      id: 'turn',
      head: 'Your turn',
      priority: 1,
      min: 132,
      value: (row) => row.turn.open,
      cell: (row) => <TurnCell row={row} />,
    },
    {
      id: 'left',
      head: 'Left',
      priority: 1,
      // "9 sessions", the estimate wrapping under it.
      min: 168,
      card: 'meta',
      value: (row) => row.remainingSessions,
      cell: (row) => <LeftCell row={row} />,
    },
    {
      id: 'spent',
      head: 'Spent',
      priority: 1,
      min: 112,
      align: 'end',
      value: (row) => (row.spend.runs ? row.spend.usd : null),
      cell: (row) => <SpentCell row={row} />,
    },
    {
      id: 'account',
      head: 'Account',
      priority: 1,
      min: 160,
      value: (row) => row.account?.who ?? null,
      cell: (row) => <AccountCell row={row} />,
    },
    {
      id: 'model',
      head: 'Model',
      priority: 1,
      min: 184,
      value: (row) => row.run?.record.model ?? row.summary?.targetModel ?? null,
      cell: (row) => <ModelCell row={row} />,
    },
    {
      id: 'moved',
      head: 'Moved',
      priority: 1,
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
      id: 'run',
      head: 'Run',
      min: 160,
      everything: true,
      value: (row) => row.run?.view.label ?? null,
      cell: (row) => (row.run ? <RunLink row={row} /> : none),
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
  /** What a row's status presses — the panel on the reasons behind it — and whose record it holds. */
  onWhy: (row: PlanRow) => void;
  inspected?: string | undefined;
}

export function PlanList({
  rows,
  everything,
  sort,
  onSort,
  detail,
  label,
  tableId,
  empty,
  onWhy,
  inspected,
}: PlanListProps) {
  const columns = useMemo(() => libraryColumns({ onWhy, inspected }), [onWhy, inspected]);
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
