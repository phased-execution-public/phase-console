/**
 * What a session is doing, as state rather than as a log (7.0, quiet-console
 * phase 12; the 6.x activity panels, task summary and Now panel before it).
 *
 * ```
 * Task list       1 of 3 done, written at 14:07:52
 *  ● Wiring the endpoint
 *  ○ write the handoff
 * Tool calls      24 calls, 1 running
 *  Bash  npm test                                   4m   14:07:52
 * Verification    1 of 2 done
 *  ● Passed     npm test                            4.2s
 *  ● Verifying  npm run lint                        1m 30s
 * ```
 *
 * A transcript answers "what has it said"; these answer "what is it doing" — the
 * last task list it wrote, the call that never came back, two subagents' words
 * kept apart, a `[1/2]` line that would otherwise mean forty minutes of waiting
 * to learn whether it passed. All of it is folded from the events the console
 * draws (`shared/console-model.js`), so it replays after a reload for the same
 * reason the console does. Everything is stamped: a call still open on a
 * session that died at 2am must not read like one running now.
 *
 * The phase's REPORT is the server's reading of the same session (`NowReport`):
 * the plain answer first, then the operation in hand, what it waits on, why it
 * is slow — each figure linked to the line it was read from — and its tasks.
 * `LastActivity` is the one-line version a lane's row carries.
 */

import type { ReactNode } from 'react';
import { TASK_STATUSES, TASK_STATUS_META, taskSummary } from '@shared/task-model.js';
import type { ActivityEvent, PhaseActivity, PhaseReport, PhaseTask, ReportSource } from '@/data/api';
import { usePhaseActivity, usePhaseReport } from '@/data/runs';
import { useNow } from '@/lib/clock';
import { cn } from '@/lib/cn';
import { clockTime, duration, plural, toolTime } from '@/lib/format';
import { Mono, RelativeTime } from '@/ui';
import { OpsStatus, PhaseStatus, type WordOf } from '@/ui/status';
import type { SessionActivity, SessionToolCall, VerifyCommandRow } from './console-model';
import { journalHref } from './journal';

/* ------------------------------------------------------------------ *
 * The session's activity
 * ------------------------------------------------------------------ */

/** Tool calls drawn at once; every older one is in the console. */
const TOOLS_SHOWN = 24;

/**
 * A task mark's SHAPE, derived from the table that owns it. It holds only
 * because `TASK_STATUS_META` is frozen behind a `const` assertion: without it
 * every value widens to `string`, `MARK_CLASS` becomes an open record, and a
 * deleted shape compiles — a mark missing rather than distinct.
 */
export type TaskMarkShape = (typeof TASK_STATUS_META)[keyof typeof TASK_STATUS_META]['mark'];

/** What tells the three apart with the hue taken away. */
const MARK_CLASS: Record<TaskMarkShape, string> = {
  hollow: 'border border-current',
  live: 'bg-current ring-2 ring-current/25',
  solid: 'bg-current',
};

const taskMeta = (status: string) => TASK_STATUS_META[status as keyof typeof TASK_STATUS_META] ?? null;

/** One task's mark, at row size and in the key — the same shape, which is what lets the key teach the rows. */
function TaskMark({ status, className }: { status: string; className?: string }) {
  const paint = taskMeta(status);
  return (
    <span
      aria-hidden="true"
      className={cn(
        'mt-1 size-1.5 shrink-0 rounded-full',
        paint ? `text-state state-${paint.ui}` : 'text-ink-faint',
        paint ? MARK_CLASS[paint.mark as TaskMarkShape] : 'bg-current',
        className,
      )}
    />
  );
}

/**
 * How each checklist state is drawn — every state the fold can assign, each a
 * word of the status family: the command in hand is the phase's Verifying, a
 * settled one passed, failed or was skipped, and a row whose verification
 * ended without its result says it does not know rather than guessing.
 */
export const COMMAND_STATE_WORDS: Readonly<
  Record<
    VerifyCommandRow['state'],
    | { vocab: 'phase'; word: WordOf<'phase'> }
    | { vocab: 'verdict'; word: WordOf<'verdict'> }
    | { vocab: 'verification'; word: null }
  >
> = {
  running: { vocab: 'phase', word: 'verifying' },
  passed: { vocab: 'verdict', word: 'passed' },
  failed: { vocab: 'phase', word: 'failed' },
  skipped: { vocab: 'phase', word: 'skipped' },
  unknown: { vocab: 'verification', word: null },
};

function CommandState({ state }: { state: VerifyCommandRow['state'] }) {
  const drawn = COMMAND_STATE_WORDS[state] ?? COMMAND_STATE_WORDS.unknown;
  if (drawn.vocab === 'phase') return <PhaseStatus record={{ status: drawn.word }} />;
  if (drawn.vocab === 'verdict') return <OpsStatus vocab="verdict" word={drawn.word} />;
  return <OpsStatus vocab="verification" word={null} title="It started, and no result was recorded" />;
}

/** A group's name and its facts, on one line. */
function GroupHead({ name, about, children }: { name: string; about: string; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <h4 className="text-body font-medium text-ink" title={about}>
        {name}
      </h4>
      {children != null && <span className="text-meta text-ink-muted tnum">{children}</span>}
    </div>
  );
}

export function ActivityPanels({
  activity,
  live,
  now: fixedNow,
}: {
  activity: SessionActivity;
  live: boolean;
  /** Injectable so a test can draw a running command without a real clock. */
  now?: number;
}) {
  // The command in flight has a clock that must TICK: nothing re-renders this
  // between a command's start and its result, which can be forty minutes.
  const ticking = useNow(live && fixedNow == null);
  const now = fixedNow ?? ticking;
  const { todos, tools, agents, verify } = activity;
  const verifyRows: VerifyCommandRow[] = [
    ...verify.commands,
    ...verify.skipped.map((skip, i) => ({
      index: verify.commands.length + i,
      total: 0,
      command: skip.command,
      state: 'skipped' as const,
      at: verify.at,
      reason: skip.reason,
    })),
  ];
  if (!todos.length && !tools.length && !agents.length && !verifyRows.length) return null;

  return (
    <section
      aria-label="What the session is doing"
      data-testid="session-activity"
      className="flex min-w-0 flex-col divide-y divide-rule"
    >
      {todos.length > 0 && <TaskList todos={todos} at={activity.todosAt} />}
      {tools.length > 0 && <ToolCalls tools={tools} live={live} />}
      {verifyRows.length > 0 && <Checklist verify={activity.verify} rows={verifyRows} now={now} />}
      {agents.length > 0 && <Subagents agents={agents} />}
    </section>
  );
}

const GROUP = 'flex min-w-0 flex-col gap-1.5 py-3 first:pt-0 last:pb-0';

function TaskList({ todos, at }: { todos: readonly PhaseTask[]; at: number }) {
  const done = todos.filter((todo) => todo.status === 'completed').length;
  return (
    <div className={GROUP} data-group="tasks">
      <GroupHead name="Task list" about="The session’s own list, as it last wrote it, not the plan’s phases">
        {done} of {todos.length} done{at ? `, written at ${clockTime(at)}` : ''}
      </GroupHead>
      <ol className="flex min-w-0 flex-col gap-0.5">
        {todos.map((todo, i) => (
          <li key={todo.id ?? todo.key ?? i} className="flex min-w-0 items-baseline gap-2 text-body">
            <TaskMark status={todo.status} />
            <span
              className={cn(
                'min-w-0 break-words',
                todo.status === 'completed' ? 'text-ink-faint line-through' : 'text-ink',
              )}
            >
              {todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
              {/* The status in words: the mark is hidden from a screen reader,
                  and to everyone else two of them differ by shape and hue. */}
              <span className="sr-only">, {taskMeta(todo.status)?.label ?? todo.status}</span>
            </span>
          </li>
        ))}
      </ol>
      {/* Every status, drawn with the rows' own mark — guarded as the rows are,
          so a status the table has no entry for cannot take the list down. */}
      <p data-slot="legend" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-ink-muted">
        {(TASK_STATUSES as readonly string[]).map((status) => (
          <span key={status} className="inline-flex items-center gap-1.5">
            <TaskMark status={status} className="mt-0" />
            {taskMeta(status)?.label ?? status}
          </span>
        ))}
      </p>
    </div>
  );
}

/** A call's outcome in its column: how long it took, or that it has not come back. */
function toolOutcome(tool: SessionToolCall, live: boolean): string {
  if (tool.ok === null) return live ? 'running' : 'no result';
  if (tool.ms == null) return tool.ok ? 'ok' : 'failed';
  return tool.ok ? toolTime(tool.ms) : `failed after ${toolTime(tool.ms)}`;
}

function ToolCalls({ tools, live }: { tools: readonly SessionToolCall[]; live: boolean }) {
  const recent = tools.slice(-TOOLS_SHOWN).reverse();
  const running = tools.filter((tool) => tool.ok === null).length;
  return (
    <div className={GROUP} data-group="tools">
      <GroupHead
        name="Tool calls"
        about="The session’s tool calls, newest first; the console holds every one"
      >
        {plural(tools.length, 'call')}
        {tools.length > TOOLS_SHOWN ? `, the last ${TOOLS_SHOWN} shown` : ''}
        {running ? `, ${running} running` : ''}
      </GroupHead>
      <ul className="flex min-w-0 flex-col gap-0.5">
        {recent.map((tool, i) => (
          <li
            key={tool.id ?? `${tool.name}-${i}`}
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 text-meta"
          >
            <span className="min-w-0 truncate" title={tool.summary || undefined}>
              <Mono value={tool.name} className="text-ink" />
              {tool.agent && <span className="text-ink-muted"> {tool.agent}</span>}
              {tool.summary && (
                <>
                  {' '}
                  <Mono value={tool.summary} />
                </>
              )}
            </span>
            {/* How long, beside WHEN: the duration alone cannot place a call in
                time, which is the whole question on a replay. */}
            <span
              className={cn('tnum', tool.ok === false ? 'state-failed text-state' : 'text-ink-muted')}
              title={tool.ok === false ? tool.detail || 'The call failed' : undefined}
            >
              {toolOutcome(tool, live)}
            </span>
            <time className="text-ink-faint tnum" dateTime={new Date(tool.at).toISOString()}>
              {clockTime(tool.at)}
            </time>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Checklist({
  verify,
  rows,
  now,
}: {
  verify: SessionActivity['verify'];
  rows: readonly VerifyCommandRow[];
  now: number;
}) {
  const settled = verify.commands.filter((command) => command.state !== 'running').length;
  return (
    <div className={GROUP} data-group="verification">
      <GroupHead
        name="Verification"
        about="The plan’s own §Verification, command by command, as the runner runs it. A skipped command’s lead is not installed here: an unanswered question, never a verdict, and a phase whose every command is skipped parks."
      >
        {verify.summary ? (
          <OpsStatus vocab="verification" word={verify.summary.ok ? 'green' : 'red'} />
        ) : (
          `${settled} of ${verify.commands.length || '?'} done`
        )}
      </GroupHead>
      <ul className="flex min-w-0 flex-col gap-1">
        {rows.map((row) => {
          const elapsed = row.state === 'running' ? Math.max(0, now - row.at) : row.ms;
          return (
            <li
              key={`${row.state}-${row.index}`}
              data-state={row.state}
              className="flex min-w-0 flex-col gap-0.5"
            >
              <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 text-meta">
                <CommandState state={row.state} />
                <span className="min-w-0 truncate" title={row.command}>
                  <Mono value={row.command} className="text-ink" />
                </span>
                <span className="text-ink-muted tnum">
                  {elapsed == null ? '—' : toolTime(elapsed)}
                  {row.code != null && row.code !== 0 ? `, exit ${row.code}` : ''}
                  {row.retry ? ', on retry' : ''}
                </span>
              </div>
              {row.tail && (
                <pre className="ms-5 rounded-sm bg-ground-deep p-1.5 font-mono text-meta wrap-anywhere whitespace-pre-wrap text-ink-muted">
                  {row.tail}
                </pre>
              )}
              {row.reason && <p className="ms-5 text-meta text-ink-muted">{row.reason}</p>}
            </li>
          );
        })}
      </ul>
      {verify.summary && <p className="text-meta text-ink-muted">{verify.summary.reason}</p>}
    </div>
  );
}

function Subagents({ agents }: { agents: SessionActivity['agents'] }) {
  return (
    <div className={GROUP} data-group="agents">
      <GroupHead
        name="Subagents"
        about="One lane per delegated agent, matched to the Agent call that started it — unnamed when that call did not say which agent"
      >
        {agents.filter((agent) => !agent.done).length} running of {agents.length}
      </GroupHead>
      <ul className="flex min-w-0 flex-col gap-2">
        {agents.map((agent) => (
          <li
            key={agent.id}
            className={cn(
              'flex min-w-0 flex-col gap-0.5 border-s-2 ps-3',
              agent.done ? 'border-rule' : 'state-running border-state',
            )}
          >
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="text-body font-medium text-ink">{agent.agent || 'agent'}</span>
              {agent.title && (
                <span className="min-w-0 break-words text-meta text-ink-muted">{agent.title}</span>
              )}
              {/* When this agent was started — the lane's own clock. */}
              <time
                className="ms-auto text-meta text-ink-faint tnum"
                dateTime={new Date(agent.at).toISOString()}
              >
                {clockTime(agent.at)}
              </time>
              <PhaseStatus record={{ status: agent.done ? 'done' : 'running' }} />
            </div>
            {agent.text && (
              <p className="min-w-0 break-words whitespace-pre-wrap text-meta text-ink-muted">
                {agent.text.slice(-600)}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * A task list in one line
 * ------------------------------------------------------------------ */

/**
 * `1/3 Wiring the runner` — a session's task list small enough for a row, read
 * through `taskSummary` so every surface that draws one says the same.
 */
export function TaskLine({
  tasks,
  live,
  className,
}: {
  tasks?: readonly PhaseTask[] | undefined;
  /**
   * What the lane last REPORTED (`run:progress`). The record's list is only as
   * fresh as the last event that re-read it, which between phase boundaries is
   * never; the frame carries the summary, so it is preferred here.
   */
  live?: { total: number; done: number; active: string | null } | undefined;
  className?: string;
}) {
  const { total, done, active } = live ?? taskSummary(tasks as PhaseTask[] | undefined);
  // A session that published no list gets no furniture saying so.
  if (!total) return null;
  return (
    <span
      data-testid="task-summary"
      className={cn('inline-flex min-w-0 items-baseline gap-1.5 text-meta text-ink-muted', className)}
      title={
        active
          ? `${done} of ${total} tasks done; the session says it is: ${active}`
          : `${done} of ${total} tasks done`
      }
    >
      <span className="tnum">
        {done}/{total}
      </span>
      {active && <span className="min-w-0 truncate">{active}</span>}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * The phase's report
 * ------------------------------------------------------------------ */

/** Where a report's figure came from, as words a reader can follow. */
export function sourceWords(source: ReportSource): string {
  switch (source.kind) {
    case 'journal':
      return `journal line ${source.seq} (${source.event})`;
    case 'session-line':
      return `session log line ${source.line}`;
    case 'task':
      return `task ${source.id}`;
    case 'lane':
      return `lane ${source.field}`;
    case 'record':
      return `phase record ${source.field}`;
    case 'machine':
      return 'machine load average';
  }
}

/** A figure's source: a journal line links to it, the rest name themselves. */
function SourceMark({ source }: { source: readonly ReportSource[] }) {
  const journal = source.find((s): s is Extract<ReportSource, { kind: 'journal' }> => s.kind === 'journal');
  const words = source.map(sourceWords).join('; ');
  if (journal) {
    return (
      <a
        href={journalHref(journal.seq)}
        title={words}
        className="tap-row text-meta text-ink-muted underline decoration-rule-strong underline-offset-2 hover:text-ink"
      >
        journal #{journal.seq}
      </a>
    );
  }
  if (!source[0]) return null;
  return (
    <span title={words} className="text-meta text-ink-muted">
      {sourceWords(source[0])}
    </span>
  );
}

function etaWords(eta: PhaseReport['eta']): string {
  if (!eta.minutes) return 'no estimate yet';
  const { low, high } = eta.minutes;
  return high <= 0 ? 'about to finish' : `${low}–${high} min left`;
}

/** The report, drawn — pure, so a surface that already holds one reuses it. */
export function NowReport({ report, className }: { report: PhaseReport; className?: string }) {
  const op = report.doing.operation;
  const active = report.timeline.find((task) => task.status === 'in_progress');
  return (
    <section
      data-testid="now-panel"
      aria-label={`What phase ${report.phase} is doing`}
      className={cn('flex min-w-0 flex-col gap-2', className)}
    >
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h4 className="text-body font-semibold text-ink">Phase {report.phase} now</h4>
        <span className="text-meta text-ink-muted tnum" title={report.eta.basis}>
          {etaWords(report.eta)}
          {report.eta.confidence !== 'none' ? `, ${report.eta.confidence} confidence` : ''}
        </span>
      </div>
      <p data-testid="now-summary" className="max-w-(--measure) text-body text-ink">
        {report.summary}
      </p>

      {op && (
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-body text-ink">
          <span
            role="meter"
            data-testid="now-operation"
            aria-label={op.label}
            aria-valuemin={0}
            aria-valuemax={op.of}
            aria-valuenow={op.done}
            aria-valuetext={`${op.done} of ${op.of}`}
            className="tnum"
          >
            {op.label}: {op.done} of {op.of}
          </span>
          <SourceMark source={op.source} />
        </p>
      )}

      {report.waitingOn.length > 0 && (
        <section aria-label="Waiting on" className="flex min-w-0 flex-col gap-0.5">
          <h5 className="text-meta text-ink-muted">Waiting on</h5>
          <ul className="flex min-w-0 flex-col gap-0.5 text-body text-ink">
            {report.waitingOn.map((wait) => (
              <li key={`${wait.kind}-${wait.text}`} className="flex min-w-0 flex-wrap items-baseline gap-x-3">
                <span className="min-w-0 break-words">{wait.text}</span>
                <SourceMark source={wait.source} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.whySlow.length > 0 && (
        <section aria-label="Why it is slow" className="flex min-w-0 flex-col gap-0.5">
          <h5 className="text-meta text-ink-muted">Why it is slow</h5>
          <ul className="flex min-w-0 flex-col gap-0.5 text-body text-ink">
            {report.whySlow.map((why) => (
              <li
                key={why.rule}
                data-rule={why.rule}
                className="flex min-w-0 flex-wrap items-baseline gap-x-3"
              >
                <span className="min-w-0 break-words">{why.text}</span>
                <SourceMark source={why.source} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.timeline.length > 0 && (
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-meta text-ink-muted tnum">
            {report.done.count} of {report.done.total} tasks done
            {active?.startedAt && (
              <>
                , on the current one since <RelativeTime at={active.startedAt} />
              </>
            )}
          </p>
          <ol aria-label="Tasks" className="flex min-w-0 flex-col gap-0.5">
            {report.timeline.map((task) => (
              <li
                key={task.id}
                data-status={task.status}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 text-body"
              >
                <span
                  className={cn(
                    'min-w-0 truncate',
                    task.status === 'in_progress'
                      ? 'font-medium text-ink'
                      : task.status === 'completed'
                        ? 'text-ink-muted'
                        : 'text-ink-faint',
                  )}
                  title={task.text}
                >
                  {task.text}
                </span>
                <span className="text-meta text-ink-muted tnum">
                  {task.startedAt ? <RelativeTime at={task.startedAt} /> : 'not started'}
                </span>
                <span className="text-meta text-ink-muted tnum">
                  {task.durationMs != null ? duration(task.durationMs) : ''}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <p className="text-meta text-ink-muted">
        {report.eta.minutes
          ? `ETA from this phase’s own rate: ${report.eta.basis}.`
          : `No ETA: ${report.eta.basis}.`}
      </p>
    </section>
  );
}

/** One phase's report, fetched and kept fresh by the journal lines that move it; nothing for a phase not live. */
export function NowPanel({
  slug,
  phase,
  enabled = true,
  className,
}: {
  slug: string;
  phase: number;
  enabled?: boolean;
  className?: string;
}) {
  const { data } = usePhaseReport(slug, phase, enabled);
  if (!data || !('live' in data) || !data.live) return null;
  return <NowReport report={data} {...(className ? { className } : {})} />;
}

/** A report for each live lane of a run — four at most; a run with more is read lane by lane. */
export function LiveNow({
  slug,
  phases,
  enabled = true,
}: {
  slug: string;
  phases: readonly number[];
  enabled?: boolean;
}) {
  if (!phases.length) return null;
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="live-now">
      {phases.slice(0, 4).map((phase) => (
        <NowPanel key={phase} slug={slug} phase={phase} enabled={enabled} />
      ))}
    </div>
  );
}

/** One event of a session's own log, as a line a person reads. */
export function activityLine(event: ActivityEvent): string {
  if (event.kind === 'text') return event.text.replace(/\s+/g, ' ').slice(0, 160);
  if (event.kind === 'marker')
    return `${event.marker === 'input' ? 'told' : event.marker}: ${event.text.replace(/\s+/g, ' ').slice(0, 120)}`;
  const what = event.description ?? event.summary ?? '';
  const state = event.open
    ? 'running'
    : event.exit === 'error'
      ? `failed${event.code != null ? ` (exit ${event.code})` : ''}`
      : '';
  return `${event.name}${what ? ` — ${what.slice(0, 120)}` : ''}${state ? `, ${state}` : ''}`;
}

/** The newest event as one line — pure, for a surface that already holds the payload. */
export function LastActivityLine({
  activity,
  className,
}: {
  activity: PhaseActivity | undefined;
  className?: string;
}) {
  // A payload with no events (an older server, an error body) is no activity,
  // never a render error that takes a whole list down with it.
  const events = activity?.events ?? [];
  const last = events[events.length - 1];
  if (!last) return null;
  return (
    <span
      data-testid="last-activity"
      title={`From the session’s own log, line ${last.line}`}
      className={cn('flex min-w-0 basis-full items-baseline gap-1.5 text-meta text-ink-muted', className)}
    >
      <span className="min-w-0 truncate">{activityLine(last)}</span>
      <RelativeTime at={last.at} className="shrink-0 text-ink-faint" />
    </span>
  );
}

/** The last thing a live lane did, read from its session's own log. */
export function LastActivity({
  slug,
  phase,
  enabled = true,
  className,
}: {
  slug: string;
  phase: number;
  enabled?: boolean;
  className?: string;
}) {
  const { data } = usePhaseActivity(slug, phase, enabled, 5);
  return <LastActivityLine activity={data} {...(className ? { className } : {})} />;
}
