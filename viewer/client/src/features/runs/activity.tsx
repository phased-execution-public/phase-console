/**
 * The three things a `claude -p` process does that a scrolling log cannot show,
 * and the fourth thing that happens after it stops.
 *
 * A transcript answers "what has it said". These answer "what is it doing" —
 * which is a question about *state*, and state read off a log is the reader doing
 * the folding in their head: scrolling back for the last task write, remembering
 * which `Bash` never came back, unpicking two subagents' sentences from one
 * interleaved paragraph, watching a `[1/2]` line and waiting forty minutes to
 * learn whether it passed.
 *
 * All four are derived from the same events the console renders, by
 * `shared/console-model.js`, so they replay after a reload for the same reason it
 * does — and a finished run shows the task list it ended on rather than an empty
 * box.
 *
 * **Everything here is stamped.** The model has carried `at` on every tool call
 * and `todosAt` on every list rewrite since it was written, and the panel read
 * neither: the right-hand column was a DURATION, so a reader could see that a
 * `Bash` took four minutes and never that it happened nine hours ago. That bites
 * hardest on exactly the runs this panel exists for — replayed after a reload,
 * where a call still showing `…` on a session that died at 2am looks identical to
 * one running right now.
 */

import { Card, CardBody, CardHeader, CardTitle, Legend } from '@/components/ui';
import { useNow } from '@/lib/clock';
import { clockTime, toolTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { TASK_STATUSES, TASK_STATUS_META } from '@shared/task-model.js';
import type { Activity, VerifyRow } from './console-model';

/** Tool calls worth showing at once; the rest are in the console. */
const TOOLS_SHOWN = 24;

/**
 * The mark shapes, DERIVED from the table that owns them rather than written
 * out again — the same one-source rule the paint table itself was moved for.
 *
 * This only works because `TASK_STATUS_META` is frozen behind a `const` type
 * assertion: without it, plain JS widens every value to `string`, the derived
 * union becomes `string`, and `MARK_CLASS` silently turns into an open record
 * where a deleted entry compiles. Which would be #9.2's own defect reintroduced
 * by the fix for it — a mark that is missing rather than distinct. Deleting an
 * entry from `MARK_CLASS` must be a `TS2741`; it is.
 */
export type TaskMark = (typeof TASK_STATUS_META)[keyof typeof TASK_STATUS_META]['mark'];

/**
 * The shape half of a task's mark. The hue is `state-<ui>` from the same table;
 * this is what makes the three distinguishable with the hue taken away.
 */
const MARK_CLASS: Record<TaskMark, string> = {
  hollow: 'border border-current',
  live: 'bg-current ring-2 ring-current/25',
  solid: 'bg-current',
};

const meta = (status: string) => TASK_STATUS_META[status as keyof typeof TASK_STATUS_META] ?? null;

/**
 * One task's mark, at row size or at legend size — the same component, which is
 * what makes the key on the card able to teach what the rows mean.
 */
function TaskMark({ status, className }: { status: string; className?: string }) {
  const paint = meta(status);
  return (
    <span
      aria-hidden="true"
      className={cn(
        'mt-1 size-1.5 shrink-0 rounded-full',
        paint ? `text-state state-${paint.ui}` : 'text-ink-faint',
        paint ? MARK_CLASS[paint.mark as TaskMark] : 'bg-current',
        className,
      )}
    />
  );
}

/**
 * What each checklist state reads as, and the glyph that carries it without
 * colour. Keyed by `VERIFY_STATES` from the fold that assigns them — a row's
 * state and its paint cannot come from two different lists.
 */
export const VERIFY_STATE: Record<string, { label: string; ui: string; glyph: string }> = {
  running: { label: 'running', ui: 'running', glyph: '·' },
  passed: { label: 'passed', ui: 'done', glyph: '✓' },
  failed: { label: 'failed', ui: 'failed', glyph: '✗' },
  skipped: { label: 'skipped', ui: 'skipped', glyph: '–' },
  unknown: { label: 'no result', ui: 'waiting', glyph: '?' },
};

function VerifyRowItem({ row, now }: { row: VerifyRow; now: number }) {
  const paint = VERIFY_STATE[row.state] ?? VERIFY_STATE.unknown!;
  const elapsed = row.state === 'running' ? Math.max(0, now - row.at) : row.ms;
  return (
    <li className="flex flex-col gap-0.5 text-2xs">
      <div className="flex items-baseline gap-2">
        <span
          aria-hidden="true"
          className={cn('w-3 shrink-0 text-center font-mono text-state', `state-${paint.ui}`)}
        >
          {paint.glyph}
        </span>
        <code className="min-w-0 flex-1 truncate font-mono text-ink-faint">{row.command}</code>
        {/* The state in TEXT, beside the glyph — never the glyph alone. */}
        <span className={cn('shrink-0 text-state', `state-${paint.ui}`)}>{paint.label}</span>
        <span className="w-14 shrink-0 text-right font-mono tabular-nums text-ink-faint">
          {(elapsed == null ? '—' : toolTime(elapsed)) +
            (row.code != null && row.code !== 0 ? ` · ${row.code}` : '')}
        </span>
      </div>
      {row.tail && (
        <pre className="ml-5 max-h-32 overflow-auto rounded-sm bg-ground-deep p-1.5 font-mono text-2xs whitespace-pre-wrap text-ink-muted">
          {row.tail}
        </pre>
      )}
      {row.reason && <p className="ml-5 text-2xs text-ink-faint">{row.reason}</p>}
    </li>
  );
}

export function ActivityPanels({
  activity,
  live,
  now: fixedNow,
}: {
  activity: Activity;
  live: boolean;
  /** Injectable so a test can draw a running command without a real clock. */
  now?: number;
}) {
  // The elapsed clock on the command in flight has to TICK. Nothing re-renders
  // this pane between a command's start event and its result — which is the
  // forty minutes the checklist was written for — so a render-time `Date.now()`
  // painted `0ms` for the whole suite. `useNow` is what six sibling components
  // already use for exactly this; the prop stays as the test seam.
  const ticking = useNow(live && fixedNow == null);
  const now = fixedNow ?? ticking;
  const { todos, tools, agents, verify } = activity;
  const verifyRows: VerifyRow[] = [
    ...verify.commands,
    ...verify.skipped.map((s, i) => ({
      index: verify.commands.length + i,
      total: 0,
      command: s.command,
      state: 'skipped' as const,
      at: verify.at,
      reason: s.reason,
    })),
  ];
  if (!todos.length && !tools.length && !agents.length && !verifyRows.length) return null;

  const doneCount = todos.filter((t) => t.status === 'completed').length;
  const recent = tools.slice(-TOOLS_SHOWN).reverse();
  const running = tools.filter((t) => t.ok === null).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>What it is doing</CardTitle>
      </CardHeader>
      <CardBody className="grid gap-4 lg:grid-cols-2">
        {todos.length > 0 && (
          <section className="min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="font-display text-sm">Task list</h3>
              <span className="font-mono text-2xs text-ink-faint tabular-nums">
                {doneCount}/{todos.length}
              </span>
            </div>
            <ol className="mt-1.5 flex flex-col gap-0.5">
              {todos.map((todo, i) => (
                <li key={todo.id ?? todo.key ?? i} className="flex items-baseline gap-2 text-2xs">
                  <TaskMark status={todo.status} />
                  <span
                    className={cn('min-w-0', todo.status === 'completed' && 'text-ink-faint line-through')}
                  >
                    {todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
                    {/* The status as TEXT. The dot was `aria-hidden`, so for a
                        screen reader `pending` and `in_progress` were one row
                        written twice — and for everyone else they differed by
                        colour on a 6px dot. */}
                    <span className="sr-only"> — {meta(todo.status)?.label ?? todo.status}</span>
                  </span>
                </li>
              ))}
            </ol>
            {/* All three statuses, drawn with the row's own mark. Guarded like
                `meta()` is: a status the table has no entry for must not take
                the whole card down, which is a harder failure than the
                fallback-paint bug this key was added for. */}
            <Legend
              className="mt-2"
              entries={TASK_STATUSES.map((status: string) => ({
                key: status,
                label: meta(status)?.label ?? status,
                mark: <TaskMark status={status} className="mt-0" />,
              }))}
            />
            <p className="mt-1.5 text-2xs text-ink-faint">
              The session&apos;s own list, as it last wrote it — not the plan&apos;s phases.
              {writtenAt(activity.todosAt)}
            </p>
          </section>
        )}

        {tools.length > 0 && (
          <section className="min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="font-display text-sm">Tool activity</h3>
              <span className="font-mono text-2xs text-ink-faint tabular-nums">
                {tools.length}
                {tools.length === TOOLS_SHOWN ? '+' : ''}
                {running ? ` · ${running} running` : ''}
              </span>
            </div>
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {recent.map((tool, i) => (
                <li
                  key={tool.id ?? `${tool.name}-${i}`}
                  className={cn(
                    'flex items-baseline gap-2 text-2xs',
                    tool.ok === false && 'text-blocked',
                    tool.ok === null && 'text-progress',
                  )}
                >
                  <span className="shrink-0 font-mono">
                    {tool.name}
                    {tool.agent && <span className="text-ink-faint"> {tool.agent}</span>}
                  </span>
                  {tool.summary && (
                    <code className="min-w-0 truncate font-mono text-ink-faint">{tool.summary}</code>
                  )}
                  <span
                    className="ml-auto shrink-0 font-mono tabular-nums"
                    title={tool.ok === false ? tool.detail || 'the call failed' : undefined}
                  >
                    {/* No result yet means it is still going, and on an
                        unattended run that is the interesting state — a `Bash`
                        six minutes in reads identically to one that finished,
                        without this. */}
                    {tool.ok === null
                      ? live
                        ? '…'
                        : '—'
                      : tool.ms == null
                        ? tool.ok
                          ? 'ok'
                          : 'failed'
                        : `${tool.ok ? '' : '✗ '}${toolTime(tool.ms)}`}
                  </span>
                  {/* WHEN, beside how long. The duration alone cannot place a
                      call in time, which is the whole question on a replay. */}
                  <span className="w-14 shrink-0 text-right font-mono tabular-nums text-ink-faint">
                    {clockTime(tool.at)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {verifyRows.length > 0 && (
          <section className="min-w-0 lg:col-span-2">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="font-display text-sm">Verification</h3>
              <span className="font-mono text-2xs text-ink-faint tabular-nums">
                {verify.summary
                  ? verify.summary.ok
                    ? 'passed'
                    : 'failed'
                  : `${verify.commands.filter((c) => c.state !== 'running').length}/${verify.commands.length || '?'}`}
              </span>
            </div>
            <ul className="mt-1.5 flex flex-col gap-1">
              {verifyRows.map((row) => (
                <VerifyRowItem key={`${row.state}-${row.index}`} row={row} now={now} />
              ))}
            </ul>
            {verify.summary && (
              <p className="mt-1.5 max-w-prose text-2xs text-ink-faint">{verify.summary.reason}</p>
            )}
            <p className="mt-1.5 max-w-prose text-2xs text-ink-faint">
              The plan&apos;s own §Verification, command by command, as the runner runs it. A skipped
              command&apos;s lead is not installed here — it is an unanswered question, never a verdict, and a
              phase whose every command is skipped parks.
            </p>
          </section>
        )}

        {agents.length > 0 && (
          <section className="min-w-0 lg:col-span-2">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="font-display text-sm">Subagents</h3>
              <span className="font-mono text-2xs text-ink-faint tabular-nums">
                {agents.filter((a) => !a.done).length} running · {agents.length} total
              </span>
            </div>
            <div className="mt-1.5 flex flex-col gap-2">
              {agents.map((agent) => (
                <div
                  key={agent.id}
                  className={cn(
                    'border-l-2 pl-2',
                    agent.done ? 'border-rule text-ink-faint' : 'border-progress',
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <strong className="text-2xs">{agent.agent || 'agent'}</strong>
                    <span className="flex items-baseline gap-2 text-2xs text-ink-faint">
                      {/* The lane's own clock — when this agent was started. */}
                      <span className="font-mono tabular-nums">{clockTime(agent.at)}</span>
                      {agent.done ? 'finished' : 'working'}
                    </span>
                  </div>
                  {agent.title && <div className="text-2xs text-ink-faint">{agent.title}</div>}
                  {agent.text && (
                    <p className="mt-0.5 max-h-32 overflow-y-auto text-2xs whitespace-pre-wrap text-ink-muted">
                      {agent.text.slice(-600)}
                    </p>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-1.5 max-w-prose text-2xs text-ink-faint">
              One lane per delegated agent, matched to the <code className="font-mono">Agent</code> call that
              started it. Unnamed when that call did not say which agent — the field is optional. Their words
              used to arrive as one voice and read as neither.
            </p>
          </section>
        )}
      </CardBody>
    </Card>
  );
}

/** ` Written at 14:07:52.` for the task card — absent until the session writes a list. */
function writtenAt(at: number): string {
  return at ? ` Written at ${clockTime(at)}.` : '';
}
