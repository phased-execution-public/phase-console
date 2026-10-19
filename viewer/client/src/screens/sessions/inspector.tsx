/**
 * A session in the panel — Inspect, the second door to depth (7.0,
 * quiet-console phase 15; design.md principle 3).
 *
 * The list folds four shapes of process into one row, and that flattening is
 * what a person needs to see past the moment a row does not say what they
 * expected: so the Overview carries the row's every fact, History what the
 * presence hook said about it, and Raw the record the row was built FROM. A
 * lane is a phase's session, so its Actions are that phase's verbs.
 *
 * An open session is inspected LIVE: its Overview (the vitals, the facts) and
 * its Actions (the controls) are components that read the session by id from
 * the one terminal list, so a freeze, a stop or the clock moves in the panel
 * without the page handing the panel a new record.
 */

import type { ReactNode } from 'react';
import { TASK_STATUS_META } from '@shared/task-model.js';
import type { PhaseTask, TerminalSession } from '@/data/api';
import { useSessionEvents, useTerminals } from '@/data/sessions';
import { cn } from '@/lib/cn';
import { ActionsTab } from '@/shell/panel/actions-tab';
import { HistoryTab } from '@/shell/panel/history-tab';
import { RawTab } from '@/shell/panel/raw-tab';
import { inspect } from '@/shell/panel/inspector-host';
import { duration, weight } from '@/lib/format';
import { Duration, KeyValue, Money, Mono, RelativeTime, SectionHeading } from '@/ui';
import { SessionStatus } from '@/ui/status';
import { SessionActions } from './controls';
import { MODE_TITLE, modeName } from './modes';
import {
  KIND_LABEL,
  SESSION_BADGES,
  SESSION_GROUPS,
  attentionWords,
  terminalWord,
  type SessionRow,
} from './model';
import { SessionVitals } from './vitals';

/** A task list in words: "3 of 7 done, Wiring the runner" — the doing task in its own words. */
export function taskWords(tasks: readonly PhaseTask[]): string {
  const done = tasks.filter((task) => task.status === 'completed').length;
  const doing = tasks.find((task) => task.status === 'in_progress');
  const active = doing ? doing.activeForm || doing.content : null;
  return `${done} of ${tasks.length} done${active ? `, ${active}` : ''}`;
}

/** The session's own task list — the one thing on a row the SESSION wrote. */
export function TaskList({ tasks }: { tasks: readonly PhaseTask[] }) {
  return (
    <ol
      className="flex min-w-0 flex-col gap-1"
      aria-label="What it says it is doing"
      data-testid="session-tasks"
    >
      {tasks.map((task, index) => {
        const meta = TASK_STATUS_META[task.status as keyof typeof TASK_STATUS_META];
        // The task model's own paint for its word (`shared/task-model.js`), never a hue chosen here.
        const paint = meta?.ui ?? 'queued';
        return (
          <li key={task.id ?? task.key ?? index} className="flex min-w-0 items-baseline gap-2 text-body">
            <span className={cn('w-12 shrink-0 text-meta text-state', `state-${paint}`)}>
              {meta?.label ?? task.status}
            </span>
            <span className="min-w-0 break-words text-ink">
              {task.status === 'in_progress' ? task.activeForm || task.content : task.content}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** A QA reviewer's target, read defensively off the record: the shape is a union and is printed, never trusted. */
function qaOf(row: SessionRow) {
  return (
    row.record as
      | { meta?: { qa?: { slug: string; phase: number; before?: string; round?: number; report?: string } } }
      | undefined
  )?.meta?.qa;
}

function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <SectionHeading>{heading}</SectionHeading>
      {children}
    </section>
  );
}

/**
 * What the session runs on and what it has cost (#369) — the row's own
 * facts, folded once in `model.ts`; nothing drawn where nothing says it.
 */
function RunsOn({ row }: { row: SessionRow }) {
  const items: [string, ReactNode][] = [];
  if (row.account) {
    items.push([
      'Account',
      row.account.name === row.account.id ? (
        <Mono key="account" value={row.account.id} />
      ) : (
        `${row.account.name} (${row.account.id})`
      ),
    ]);
  }
  if (row.model) items.push(['Model', <Mono key="model" value={row.model} />]);
  if (row.effort) items.push(['Effort', row.effort]);
  if (row.spendUsd != null) items.push(['Spend', <Money key="spend" usd={row.spendUsd} />]);
  if (row.context) {
    const { tokens, window, stage } = row.context;
    items.push([
      'Context',
      `${weight(tokens)}${window ? ` of ${weight(window)} (${Math.round((tokens / window) * 100)} %)` : ''}${stage ? `, past the ${stage} line` : ''}`,
    ]);
  }
  if (row.progress) items.push(['Tasks', `${row.progress.done} of ${row.progress.total} done`]);
  if (row.workedMs != null) items.push(['Worked', duration(row.workedMs)]);
  if (row.estimateMs != null) items.push(['Estimate', `about ${duration(row.estimateMs)}`]);
  if (row.attempts != null) items.push(['Attempts', String(row.attempts)]);
  if (row.turns != null) items.push(['Turns', String(row.turns)]);
  if (row.worktree)
    items.push(['Worktree', <Mono key="tree" value={row.worktree} className="wrap-anywhere" />]);
  if (!items.length) return null;
  return (
    <Section heading="What it runs on">
      <KeyValue items={items} />
    </Section>
  );
}

/** Every fact of a row, by what it answers. */
export function RowOverview({ row }: { row: SessionRow }) {
  const qa = qaOf(row);
  const blurb = SESSION_GROUPS.find((group) => group.kind === row.kind)?.blurb;
  const began = row.createdAt != null && Number.isFinite(row.createdAt) ? row.createdAt : null;
  const heard = row.startedAt != null && Number.isFinite(row.startedAt) ? row.startedAt : null;
  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="session-overview">
      <Section heading="What it is">
        <KeyValue
          items={[
            ['Kind', blurb ? `${KIND_LABEL[row.kind]}: ${blurb}` : KIND_LABEL[row.kind]],
            row.badge !== row.kind ? ['Session', SESSION_BADGES[row.badge].blurb] : null,
            // Not "where": three kinds put a directory here, a lane its phase title.
            ['Working on', row.detail],
            ['Standing', row.view.label],
            ['Note', row.note],
            ['Waiting on you', row.attention ? attentionWords(row.attention) : null],
            [
              'Since',
              row.attention?.since ? <RelativeTime key="since" at={Date.parse(row.attention.since)} /> : null,
            ],
            // Two ids, and the difference is load-bearing: `id` is a pty THIS
            // console owns and can close; `sessionId` a Claude conversation.
            ['Terminal', row.id ? <Mono key="id" value={row.id} copyable /> : null],
            [
              'Conversation',
              (row.conversation ?? row.sessionId) && (row.conversation ?? row.sessionId) !== row.id ? (
                <Mono key="conversation" value={row.conversation ?? row.sessionId ?? ''} copyable />
              ) : null,
            ],
          ]}
        />
      </Section>

      <RunsOn row={row} />

      <Section heading="Clocks">
        {/* `startedAt` is the LAST thing that happened, `createdAt` when it began. */}
        <KeyValue
          items={[
            ['Began', began != null ? <RelativeTime key="began" at={began} /> : null],
            ['Last heard', heard != null ? <RelativeTime key="heard" at={heard} /> : null],
            ['Running for', row.live && began != null ? <Duration key="for" since={began} live /> : null],
          ]}
        />
      </Section>

      {qa ? (
        <Section heading="What it is reviewing">
          {/* `before` is the snapshot taken at mint time — what turns "it ended" into "it recorded something". */}
          <KeyValue
            items={[
              ['Plan', qa.slug],
              ['Phase', String(qa.phase)],
              ['Round', qa.round ? String(qa.round) : null],
              ['Report it writes', qa.report ? <Mono key="report" value={qa.report} /> : null],
              ['Verdict before it started', qa.before ?? 'none recorded'],
            ]}
          />
        </Section>
      ) : null}

      {row.tasks?.length ? (
        <Section heading="What it says it is doing">
          <TaskList tasks={row.tasks} />
        </Section>
      ) : null}
    </div>
  );
}

/**
 * The raw hook events behind a registry record (control-tower phase 25): the
 * registry says what is true now, and this says how it got that way. Read
 * while the tab is drawn, newest last.
 */
export function HookEvents({ sessionId }: { sessionId: string }) {
  const { data, error } = useSessionEvents(sessionId);
  if (error) {
    return <p className="text-body text-ink-muted">The hook events could not be read: {error.message}</p>;
  }
  const events = data?.events ?? [];
  if (!events.length)
    return <p className="text-body text-ink-muted">No hook event is recorded for this session.</p>;
  return (
    <div data-testid="hook-events">
      <HistoryTab
        entries={events.map((line) => ({
          at: line.at,
          text: (
            <span className="font-mono text-meta">
              {line.event}
              {line.lateMs > 1000 ? (
                <span className="text-ink-muted">, {Math.round(line.lateMs / 1000)} s late</span>
              ) : null}
            </span>
          ),
          by: line.via,
        }))}
      />
    </div>
  );
}

const rowSummons = (row: SessionRow): string | undefined =>
  row.attention ? attentionWords(row.attention) : undefined;

/**
 * The line under the panel's title. A directory is a machine value with no
 * break points, so it is drawn mono and may break anywhere — as prose, its
 * first segment ran past the panel's edge. A lane's line is its phase title.
 */
const describedAs = (row: Pick<SessionRow, 'kind' | 'detail'>): ReactNode =>
  row.kind === 'lane' ? row.detail : <Mono value={row.detail ?? ''} className="wrap-anywhere" />;

/** Show one row of the list in the panel. */
export function inspectRow(row: SessionRow): void {
  inspect({
    key: `session:${row.key}`,
    title: row.label,
    ...(row.detail ? { description: describedAs(row) } : {}),
    meta: <SessionStatus vocab={row.vocab} word={row.view.word} summons={rowSummons(row)} />,
    overview: <RowOverview row={row} />,
    ...(row.lane
      ? { actions: <ActionsTab kind="phase" args={{ slug: row.lane.slug, phase: row.lane.phase }} /> }
      : {}),
    ...(row.sessionId ? { history: <HookEvents sessionId={row.sessionId} /> } : {}),
    ...(row.record != null ? { raw: JSON.stringify(row.record, null, 2) } : {}),
  });
}

/* ------------------------------------------------------------------ *
 * An open session, live
 * ------------------------------------------------------------------ */

function useLiveSession(id: string): { session: TerminalSession | undefined; atCap: boolean } {
  const { data } = useTerminals();
  const sessions = data?.sessions ?? [];
  const live = data?.live ?? sessions.filter((one) => !one.exited).length;
  return { session: sessions.find((one) => one.id === id), atCap: live >= (data?.limit ?? 8) };
}

const GONE = <p className="text-body text-ink-muted">That session is not here any more.</p>;

/** The open session's vitals and facts — read live. */
export function SessionOverview({ id, size }: { id: string; size?: { cols: number; rows: number } }) {
  const { session } = useLiveSession(id);
  if (!session) return GONE;
  const claude = session.kind === 'claude';
  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="session-overview">
      <SessionVitals session={session} />
      <Section heading="What it is">
        <KeyValue
          items={[
            ['Kind', claude ? 'An agent session — Claude Code in a terminal' : 'A shell'],
            claude ? ['Launched in', <span key="mode">{modeName(session.meta?.permissionMode)}</span>] : null,
            claude ? ['About the mode', MODE_TITLE] : null,
            claude ? ['Modes', '⇧Tab inside the session cycles the permission modes'] : null,
            claude && session.meta?.model
              ? ['Model', `${session.meta.model}${session.meta.effort ? ` at ${session.meta.effort}` : ''}`]
              : null,
            ['Directory', <Mono key="cwd" value={session.cwd} className="wrap-anywhere" />],
            ['Shell', session.shell ? <Mono key="shell" value={session.shell} /> : null],
            ['Size', `${(size ?? session).cols} columns, ${(size ?? session).rows} rows`],
            ['Attached', session.clients === 1 ? 'one browser' : `${session.clients} browsers`],
            ['Process', <Mono key="pid" value={String(session.pid)} />],
            ['Began', <RelativeTime key="began" at={session.createdAt} />],
            session.lastOutputAt
              ? ['Last output', <RelativeTime key="out" at={session.lastOutputAt} />]
              : null,
            ['Terminal', <Mono key="id" value={session.id} copyable />],
            session.meta?.claudeSessionId
              ? ['Conversation', <Mono key="conversation" value={session.meta.claudeSessionId} copyable />]
              : null,
          ]}
        />
      </Section>
      {session.tasks?.length ? (
        <Section heading="What it says it is doing">
          <TaskList tasks={session.tasks} />
        </Section>
      ) : null}
    </div>
  );
}

/** The open session as the machine holds it — read live too, so Raw never trails the page. */
function SessionRaw({ id }: { id: string }) {
  const { session } = useLiveSession(id);
  return session ? <RawTab value={session} /> : GONE;
}

/** The open session's acts — read live, so a freeze turns its button into Continue. */
export function SessionActionsTab({
  id,
  onGone,
  onResume,
}: {
  id: string;
  onGone: (id: string) => void;
  onResume?: (conversation: string) => void;
}) {
  const { session, atCap } = useLiveSession(id);
  if (!session) return GONE;
  return (
    <SessionActions
      session={session}
      atCap={atCap}
      onGone={onGone}
      {...(onResume && session.kind === 'claude' ? { onResume } : {})}
    />
  );
}

/** The open session's record, for the panel. `open: false` puts it there without opening the panel. */
export function inspectSession(
  session: TerminalSession,
  how: {
    onGone: (id: string) => void;
    onResume?: (conversation: string) => void;
    size?: { cols: number; rows: number };
    open?: boolean;
  },
): void {
  const conversation = session.meta?.claudeSessionId;
  inspect(
    {
      key: `session:pty:${session.id}`,
      title: session.label,
      description: <Mono value={session.cwd} className="wrap-anywhere" />,
      meta: <SessionStatus vocab="terminal" word={terminalWord(session)} />,
      overview: <SessionOverview id={session.id} {...(how.size ? { size: how.size } : {})} />,
      actions: (
        <SessionActionsTab
          id={session.id}
          onGone={how.onGone}
          {...(how.onResume ? { onResume: how.onResume } : {})}
        />
      ),
      ...(conversation ? { history: <HookEvents sessionId={conversation} /> } : {}),
      raw: <SessionRaw id={session.id} />,
    },
    { open: how.open !== false },
  );
}
