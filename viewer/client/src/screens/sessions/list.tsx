/**
 * The sessions as a list — one line per process on the grid (7.0,
 * quiet-console phase 15).
 *
 * ```
 * Status                              Session              Working on                      Last heard
 * ● Running                           quiet-console P15    Sessions and the terminal       12 minutes ago
 * ● Live │ ⏳ needs your permission    pe-hub P9            ~/work/shop           2 minutes ago
 * ○ Exited                            zsh                  /repo                           1 minute ago
 * ```
 *
 * Four facts at the glance — the mark, the name, what it is working on, when
 * it was last heard — and Everything draws the rest as columns: its kind, its
 * note, when it began, how long it has run, both ids, its task list. A row
 * goes where the session lives (a pty's terminal, a lane's run, a foreign
 * session's phase or its own page), expands in place to its verbs, and
 * inspects in the panel. On a phone the same columns are records.
 */

import { useMemo, type ReactNode } from 'react';
import type { RunState, TerminalSession } from '@/data/api';
import { useRun } from '@/data/runs';
import { usePhone } from '@/lib/media';
import { Button, Duration, Mono, RelativeTime, SectionHeading, type Everything } from '@/ui';
import { Grid } from '@/ui/grid/grid';
import type { Column } from '@/ui/grid/column';
import { SessionStatus } from '@/ui/status';
import { useInspected } from '@/shell/panel/inspector-host';
import { sessionsHref, turnHref } from '@/shell/routes';
import { SessionControls } from './controls';
import { inspectRow, TaskList, taskWords } from './inspector';
import {
  KIND_LABEL,
  attentionWords,
  groupSessionRows,
  type SessionGroupBy,
  type SessionRow,
  type SessionSortId,
} from './model';

const none = <span className="text-ink-faint">—</span>;

/** A path is a machine value: mono, and allowed to break anywhere rather than escape its cell. */
const isPath = (row: SessionRow): boolean => row.kind !== 'lane';

/**
 * Every column a session has. The first four are the glance; the kind joins
 * them when the list is one list, because no heading says it then.
 */
export function sessionColumns(by: SessionGroupBy): Column<SessionRow>[] {
  return [
    {
      id: 'status',
      head: 'Status',
      priority: 1,
      // "Live │ needs your permission" on one line: the summons rides beside the word.
      min: 232,
      card: 'meta',
      value: (row) => row.view.label,
      cell: (row) => (
        <SessionStatus
          vocab={row.vocab}
          word={row.view.word}
          summons={row.attention ? attentionWords(row.attention) : undefined}
          live={row.live}
        />
      ),
    },
    {
      id: 'session',
      head: 'Session',
      priority: 1,
      min: 180,
      flex: true,
      identity: true,
      card: 'title',
      value: (row) => row.label,
      cell: (row) => <span className="text-body break-words text-ink">{row.label}</span>,
    },
    {
      id: 'detail',
      head: 'Working on',
      priority: 2,
      min: 220,
      value: (row) => row.detail ?? null,
      cell: (row) =>
        row.detail ? (
          isPath(row) ? (
            <Mono value={row.detail} className="wrap-anywhere" />
          ) : (
            <span className="break-words">{row.detail}</span>
          )
        ) : (
          none
        ),
    },
    {
      id: 'heard',
      head: 'Last heard',
      priority: 2,
      // "57 minutes ago" on one line; a clock may still break rather than escape.
      min: 136,
      card: 'meta',
      value: (row) => row.startedAt ?? null,
      sort: { id: 'activity', dir: 'descending' },
      cell: (row) =>
        row.startedAt != null && Number.isFinite(row.startedAt) ? (
          <RelativeTime at={row.startedAt} live={row.live} />
        ) : (
          none
        ),
    },
    {
      id: 'kind',
      head: 'Kind',
      priority: 2,
      min: 150,
      ...(by === 'kind' ? { everything: true } : {}),
      value: (row) => KIND_LABEL[row.kind],
      sort: { id: 'kind', dir: 'ascending' },
      cell: (row) => KIND_LABEL[row.kind],
    },

    /* ---- Everything ---- */
    {
      id: 'note',
      head: 'Note',
      min: 140,
      everything: true,
      value: (row) => row.note ?? null,
      cell: (row) => (row.note ? <span className="break-words">{row.note}</span> : none),
    },
    {
      id: 'began',
      head: 'Began',
      min: 136,
      everything: true,
      value: (row) => row.createdAt ?? null,
      sort: { id: 'created', dir: 'descending' },
      cell: (row) =>
        row.createdAt != null && Number.isFinite(row.createdAt) ? (
          <RelativeTime at={row.createdAt} live={false} />
        ) : (
          none
        ),
    },
    {
      id: 'for',
      head: 'Running for',
      min: 120,
      everything: true,
      value: (row) => (row.live ? (row.createdAt ?? null) : null),
      cell: (row) =>
        row.live && row.createdAt != null && Number.isFinite(row.createdAt) ? (
          <Duration since={row.createdAt} live />
        ) : (
          none
        ),
    },
    {
      id: 'terminal',
      head: 'Terminal',
      min: 140,
      everything: true,
      value: (row) => row.id ?? null,
      cell: (row) => (row.id ? <Mono value={row.id} chars={12} copyable /> : none),
    },
    {
      id: 'conversation',
      head: 'Conversation',
      min: 140,
      everything: true,
      value: (row) => row.sessionId ?? null,
      cell: (row) => (row.sessionId ? <Mono value={row.sessionId} chars={12} copyable /> : none),
    },
    {
      id: 'tasks',
      head: 'Doing',
      min: 200,
      everything: true,
      value: (row) => (row.tasks?.length ? taskWords(row.tasks) : null),
      cell: (row) => (row.tasks?.length ? <span className="break-words">{taskWords(row.tasks)}</span> : none),
    },
  ];
}

export interface SessionListProps {
  rows: readonly SessionRow[];
  by: SessionGroupBy;
  everything: Everything;
  sort: SessionSortId;
  onSort: (id: SessionSortId) => void;
  empty?: ReactNode;
}

/** The list, a section per kind — or one list — each its own grid. */
export function SessionList({ rows, by, everything, sort, onSort, empty }: SessionListProps) {
  const columns = useMemo(() => sessionColumns(by), [by]);
  const groups = useMemo(() => groupSessionRows(rows, by), [rows, by]);
  const inspected = useInspected()?.key;
  const phone = usePhone();
  if (!rows.length) return <>{empty}</>;

  const grid = (group: (typeof groups)[number]) => (
    <Grid
      columns={columns}
      rows={group.rows}
      getRowKey={(row) => row.key}
      label={group.label}
      tableId={`sessions-${group.key}`}
      toolbar={false}
      everything={everything}
      activeSort={sort}
      // On a phone the toolbar's Sort, in its View sheet, is the one order
      // control: a grid's own sort row over every kind's section would say it
      // once per section. A desk sorts by pressing a column's head.
      {...(phone ? {} : { onSort: (id: string) => onSort(id as SessionSortId) })}
      rowHref={(row) => row.href}
      rowProps={(row) => ({
        'data-session-row': row.key,
        'data-kind': row.kind,
        'data-live': row.live ? '' : undefined,
        'data-attention': row.attention ? 'needs-you' : undefined,
      })}
      detail={(row) => <RowDetail row={row} inspected={inspected === `session:${row.key}`} />}
    />
  );

  if (by === 'none') return grid(groups[0]!);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {groups.map((group, i) => (
        <section
          key={group.key}
          aria-labelledby={`sessions-group-${group.key}`}
          data-group={group.key}
          className={
            i ? 'flex min-w-0 flex-col gap-2 border-t border-rule pt-4' : 'flex min-w-0 flex-col gap-2'
          }
        >
          <SectionHeading id={`sessions-group-${group.key}`} count={group.rows.length}>
            {group.label}
          </SectionHeading>
          {grid(group)}
        </section>
      ))}
    </div>
  );
}

/** A lane's task list is the whole record's: read once the row is opened, never for the glance. */
function LaneTasks({ slug, phase, runId }: { slug: string; phase: number; runId: string }) {
  const { data } = useRun(slug);
  const run = data?.run as RunState | undefined;
  const tasks = run && run.id === runId ? run.phases?.[String(phase)]?.tasks : undefined;
  return tasks?.length ? <TaskList tasks={tasks} /> : null;
}

/**
 * What opens in place under a row: its own word and why it waits, what it
 * says it is doing, and the ways on — the panel, the place it lives, and for
 * a pty this console owns, its verbs.
 */
function RowDetail({ row, inspected }: { row: SessionRow; inspected: boolean }) {
  const pty =
    row.id && (row.kind === 'agent' || row.kind === 'shell') ? (row.record as TerminalSession) : null;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="session-row-detail">
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-body text-ink-muted">
        <SessionStatus vocab={row.vocab} word={row.view.word} withNote={false} />
        {row.note && <span>{row.note}</span>}
        {row.attention && (
          <span className="text-ink">
            It {attentionWords(row.attention)}
            {row.attention.since ? (
              <>
                {' '}
                since <RelativeTime at={Date.parse(row.attention.since)} />
              </>
            ) : null}
            .
          </span>
        )}
      </p>
      {row.lane ? <LaneTasks {...row.lane} /> : row.tasks?.length ? <TaskList tasks={row.tasks} /> : null}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" aria-pressed={inspected} onClick={() => inspectRow(row)}>
          Inspect
        </Button>
        {row.kind === 'lane' && (
          <>
            <Button size="sm" variant="ghost" asChild>
              <a href={row.href}>Open the run</a>
            </Button>
            {row.attention && (
              <Button size="sm" asChild>
                <a href={turnHref()}>Answer on Your turn</a>
              </Button>
            )}
          </>
        )}
        {pty && (
          <>
            <Button size="sm" variant="ghost" asChild>
              <a href={row.href}>Open the terminal</a>
            </Button>
            <SessionControls session={pty} />
          </>
        )}
        {row.kind === 'foreign' && row.sessionId && (
          <>
            <Button size="sm" variant="ghost" asChild>
              <a href={sessionsHref(row.sessionId)}>Open the session</a>
            </Button>
            {row.href !== sessionsHref(row.sessionId) && (
              <Button size="sm" variant="ghost" asChild>
                <a href={row.href}>Open its phase</a>
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
