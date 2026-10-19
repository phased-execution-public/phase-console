/**
 * The sessions as a list — one line per process on the grid (7.0,
 * quiet-console phase 15; the rich row since one-pool phase 17, #369).
 *
 * ```
 * Status        Session            Working on                 Account  Model and effort     Progress  Spend  Context   Elapsed        Last heard
 * (● Running)   quiet-console P15  (Lane) Sessions, terminal  Work     claude-opus-5-5 high ▮▮▮▯ 4/7  $1.75  ▮▯▯ 30 %  ▮▮▯ 12m of 40m  12 minutes ago
 * (○ Exited)    zsh                (Shell) /repo              —        —                    —         —      —         —              1 minute ago
 * ```
 *
 * The glance is what a session is doing and costing: its status as a badge,
 * its name, its kind (a quiet outlined word) beside what it works on, the
 * account it runs on, its model and effort, its task progress and its context
 * as meters, its spend, its worked clock against the estimate and when it was
 * last heard. Everything draws the heavy facts as columns: its kind word, its
 * note, when it began, attempts, turns, its run's worktree, both ids and its
 * task list. Every fact is the row's (`model.ts` folds them once), so the
 * inspector and the phone read the same. A row goes where the session lives
 * (a pty's terminal, a lane's run, a foreign session's phase or its own page),
 * expands in place to its verbs, and inspects in the panel. On a phone the
 * same columns are records, the meters kept.
 */

import { useMemo, type ReactNode } from 'react';
import type { RunState, TerminalSession } from '@/data/api';
import { useRun } from '@/data/runs';
import { duration, weight } from '@/lib/format';
import { usePhone } from '@/lib/media';
import { Button, Duration, Money, Mono, RelativeTime, SectionHeading, type Everything } from '@/ui';
import { Grid } from '@/ui/grid/grid';
import type { Column } from '@/ui/grid/column';
import { SessionStatus } from '@/ui/status';
import { LoadMeter } from '@/ui/track/meter';
import { useInspected } from '@/shell/panel/inspector-host';
import { sessionsHref, turnHref } from '@/shell/routes';
import { SessionControls } from './controls';
import { inspectRow, TaskList, taskWords } from './inspector';
import {
  KIND_LABEL,
  SESSION_BADGES,
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
 * What a session is, as a quiet outlined word — never a status: no hue, no
 * `data-status`, so a row still carries exactly ONE status mark (#369).
 */
export function SessionKindBadge({ row }: { row: Pick<SessionRow, 'badge'> }) {
  const badge = SESSION_BADGES[row.badge];
  return (
    <span
      data-session-badge={row.badge}
      title={badge.blurb}
      className="inline-flex shrink-0 items-center rounded-full border border-rule-strong px-2 text-meta text-ink-muted"
    >
      {badge.label}
    </span>
  );
}

/** "4 of 7" as a meter — the doing task in the meter's title, through its label. */
function ProgressCell({ progress }: { progress: SessionRow['progress'] }) {
  if (!progress) return none;
  return (
    <LoadMeter
      value={progress.done}
      max={progress.total}
      label="Tasks done"
      valueText={`${progress.done} of ${progress.total} tasks done`}
      reading={`${progress.done} of ${progress.total}`}
    />
  );
}

/** The context against the model's window, as a meter; the figure alone where no window is known. */
function ContextCell({ context }: { context: SessionRow['context'] }) {
  if (!context) return none;
  const share = context.window ? Math.round((context.tokens / context.window) * 100) : null;
  const stage =
    context.stage === 'checkpoint'
      ? ', checkpointing'
      : context.stage === 'wrap-up'
        ? ', told to wrap up'
        : '';
  return (
    <LoadMeter
      value={context.tokens}
      max={context.window}
      label="Context used"
      valueText={`${weight(context.tokens)}${context.window ? ` of ${weight(context.window)}` : ''}${stage}`}
      reading={share != null ? `${share} %` : `${weight(context.tokens)} context`}
    />
  );
}

/**
 * The worked clock against the estimate, as a meter, when the record says
 * both; the worked clock alone without an estimate; and on a live row the
 * record has not reached, how long it has run, ticking.
 */
function ElapsedCell({ row }: { row: SessionRow }) {
  if (row.workedMs != null) {
    if (row.estimateMs != null && row.estimateMs > 0) {
      return (
        <LoadMeter
          value={row.workedMs}
          max={row.estimateMs}
          label="Worked against the estimate"
          valueText={`${duration(row.workedMs)} of about ${duration(row.estimateMs)}`}
          reading={`${duration(row.workedMs)} of ${duration(row.estimateMs)}`}
        />
      );
    }
    return <Duration ms={row.workedMs} />;
  }
  if (row.live && row.createdAt != null && Number.isFinite(row.createdAt)) {
    return <Duration since={row.createdAt} live />;
  }
  return none;
}

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
      // "Live │ needs your permission" on one line, in its outlined pill: the summons rides beside the word.
      min: 264,
      card: 'meta',
      value: (row) => row.view.label,
      cell: (row) => (
        <SessionStatus
          chrome="badge"
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
      cell: (row) => (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <SessionKindBadge row={row} />
          {row.detail ? (
            isPath(row) ? (
              <Mono value={row.detail} className="min-w-0 wrap-anywhere" />
            ) : (
              <span className="min-w-0 break-words">{row.detail}</span>
            )
          ) : null}
        </span>
      ),
    },
    {
      id: 'account',
      head: 'Account',
      priority: 3,
      min: 132,
      value: (row) => row.account?.name ?? null,
      cell: (row) =>
        row.account ? (
          row.account.name === row.account.id ? (
            <Mono value={row.account.id} className="wrap-anywhere" />
          ) : (
            <span className="break-words" title={row.account.id}>
              {row.account.name}
            </span>
          )
        ) : (
          none
        ),
    },
    {
      id: 'model',
      head: 'Model and effort',
      priority: 3,
      min: 168,
      value: (row) => (row.model ? `${row.model}${row.effort ? ` ${row.effort}` : ''}` : null),
      cell: (row) =>
        row.model || row.effort ? (
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            {row.model ? <Mono value={row.model} className="min-w-0 wrap-anywhere" /> : null}
            {row.effort ? <span className="text-meta text-ink-muted">{row.effort}</span> : null}
          </span>
        ) : (
          none
        ),
    },
    {
      id: 'progress',
      head: 'Progress',
      priority: 2,
      min: 144,
      value: (row) => (row.progress ? row.progress.done / row.progress.total : null),
      cell: (row) => <ProgressCell progress={row.progress} />,
    },
    {
      id: 'spend',
      head: 'Spend',
      priority: 3,
      min: 88,
      align: 'end',
      value: (row) => row.spendUsd ?? null,
      cell: (row) => (row.spendUsd != null ? <Money usd={row.spendUsd} /> : none),
    },
    {
      id: 'context',
      head: 'Context',
      priority: 3,
      min: 144,
      value: (row) => row.context?.tokens ?? null,
      cell: (row) => <ContextCell context={row.context} />,
    },
    {
      id: 'elapsed',
      head: 'Elapsed',
      priority: 3,
      // "12m 03s of 1h 04m" beside its bar.
      min: 176,
      value: (row) => row.workedMs ?? null,
      cell: (row) => <ElapsedCell row={row} />,
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
      id: 'attempts',
      head: 'Attempts',
      min: 96,
      align: 'end',
      everything: true,
      value: (row) => row.attempts ?? null,
      cell: (row) => (row.attempts != null ? String(row.attempts) : none),
    },
    {
      id: 'turns',
      head: 'Turns',
      min: 88,
      align: 'end',
      everything: true,
      value: (row) => row.turns ?? null,
      cell: (row) => (row.turns != null ? String(row.turns) : none),
    },
    {
      id: 'worktree',
      head: 'Worktree',
      min: 200,
      everything: true,
      value: (row) => row.worktree ?? null,
      cell: (row) => (row.worktree ? <Mono value={row.worktree} className="wrap-anywhere" /> : none),
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
      value: (row) => row.conversation ?? null,
      cell: (row) => (row.conversation ? <Mono value={row.conversation} chars={12} copyable /> : none),
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
