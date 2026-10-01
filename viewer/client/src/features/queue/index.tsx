/**
 * `#/queue` — the whole queue of one console (control-tower phase 99, #135 A,
 * B, E and I).
 *
 * One page answers what an operator could only piece together before: what is
 * queued, in what order it will board, WHY it sits there (the scan's own keys,
 * in words), what each entry waits on and who holds what — a lane polling its
 * own job named as such (#67), a branch hold naming the run behind it and the
 * two ways out (#150). Beside the table: the live lanes, the phases a re-board
 * asked for that no entry holds yet, the withdrawn ones, and the audit strip —
 * every change anybody made here, newest first, with who and why.
 *
 * Every word comes from `GET /api/queue`, which writes it through
 * `shared/queue-model.js`: a terminal, the CLI and the supervisor read exactly
 * what this page draws. The page decides only what a person may press, and
 * every press carries the reason typed once at the top.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Badge,
  Empty,
  RelativeTime,
  SectionHeading,
  Skeleton,
  fieldSurface,
  toast,
} from '@/components/ui';
import { DataTable, type Column } from '@/components/data-table';
import { Page } from '@/components/page';
import {
  api,
  type QueueAuditRow,
  type QueueHintedRow,
  type QueueLane,
  type QueueReservation,
  type QueueView,
  type QueueViewEntry,
  type QueueWithdrawnRow,
} from '@/lib/api';
import { SCHEDULING_POLICIES, SCHEDULING_POLICY_LABELS } from '@shared/orchestration-model.js';
import { post } from '@/lib/api/client';
import { cn } from '@/lib/cn';
import { keys, useConsoleState, useQueue } from '@/lib/queries';
import { runsHref } from '@/app/routes';
import {
  capacityLine,
  carriedPress,
  entryVerbs,
  LANE_PRESSES,
  laneLine,
  laneVerbs,
  pressBody,
} from './model';

/** What each verb's toast says it did — the button's own verb, done. */
const DONE: Readonly<Record<string, string>> = Object.freeze({
  bump: 'Moved ahead',
  hold: 'Held',
  release: 'Released',
  defer: 'Deferred for an hour',
  withdraw: 'Withdrawn from the queue',
  requeue: 'Re-queued',
  pin: 'Pinned next in its plan',
  unpin: 'Unpinned',
  reserve: 'A lane is kept for it',
  unreserve: 'The kept lane is free',
  yield: 'Asked to yield its lane',
  policy: 'Policy changed',
});

type Press = (key: string, verb: string, body: Record<string, unknown>) => Promise<void>;

export default function QueuePage() {
  const { data: state } = useConsoleState();
  const allowRun = Boolean(state?.allowRun);
  const { data, isLoading } = useQueue();
  const view = data as QueueView | undefined;
  const client = useQueryClient();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const press = useCallback<Press>(
    async (key, verb, body) => {
      setBusy(key);
      try {
        const sent = pressBody(body, reason);
        if (verb === 'policy') await api.queuePolicy(sent);
        else if (LANE_PRESSES.has(verb)) await api.laneAct(verb, sent);
        else await api.queueAct(verb, sent);
        toast(DONE[verb] ?? 'Done', 'ok');
      } catch (error) {
        toast(String((error as Error)?.message ?? error), 'error');
      } finally {
        setBusy(null);
        void client.invalidateQueries({ queryKey: keys.queue() });
        void client.invalidateQueries({ queryKey: keys.runs() });
      }
    },
    [client, reason],
  );

  const entries = useMemo(() => view?.entries ?? [], [view]);
  const columns = useMemo(() => queueColumns({ allowRun, busy, press }), [allowRun, busy, press]);

  return (
    <Page
      title="Queue"
      subtitle={
        view
          ? `${entries.length} waiting, ${view.lanes.length} live — first to board at the top`
          : 'What waits for a lane, in the order it will board'
      }
      actions={
        allowRun ? (
          <label className="flex min-w-0 items-center gap-2 text-2xs text-ink-muted">
            <span>Why</span>
            <input
              type="text"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Recorded with every change you make here"
              data-testid="queue-reason"
              maxLength={200}
              className="h-8 w-72 max-w-full min-w-0 rounded-md border border-rule bg-surface px-2 text-sm text-ink placeholder:text-ink-faint focus-visible:border-rule-strong [@media(hover:none)]:min-h-(--tap-min)"
            />
          </label>
        ) : undefined
      }
    >
      {isLoading && !view ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="flex min-w-0 flex-col gap-5">
          <Capacity view={view} allowRun={allowRun} busy={busy} press={press} />
          <AuditStrip rows={view?.audit ?? []} />
          {entries.length ? (
            <DataTable
              columns={columns}
              rows={entries}
              getRowKey={(entry) => entry.id}
              label="The admission queue, in the order it will board"
              tableId="queue"
              detail={(entry) => <EntryDetail entry={entry} allowRun={allowRun} />}
            />
          ) : (
            <Empty
              title="Nothing is waiting"
              body={
                <>
                  Every phase that asked for a lane has one. An entry appears here the moment a phase has to
                  wait —{' '}
                  <a className="underline" href={runsHref()}>
                    the Tower
                  </a>{' '}
                  shows what is running.
                </>
              }
            />
          )}
          <Lanes lanes={view?.lanes ?? []} allowRun={allowRun} busy={busy} press={press} />
          <Kept rows={view?.reservations ?? []} allowRun={allowRun} busy={busy} press={press} />
          <Hinted rows={view?.hinted ?? []} allowRun={allowRun} busy={busy} press={press} />
          <Withdrawn rows={view?.withdrawn ?? []} allowRun={allowRun} busy={busy} press={press} />
        </div>
      )}
    </Page>
  );
}

function queueColumns({
  allowRun,
  busy,
  press,
}: {
  allowRun: boolean;
  busy: string | null;
  press: Press;
}): Column<QueueViewEntry>[] {
  const columns: Column<QueueViewEntry>[] = [
    {
      id: 'position',
      head: 'Place',
      priority: 1,
      width: '3.5rem',
      min: 48,
      align: 'end',
      card: 'meta',
      cell: (entry) => <span className="tabular-nums text-ink-muted">{entry.position}</span>,
    },
    {
      id: 'phase',
      head: 'Phase',
      identity: true,
      flex: true,
      priority: 1,
      min: 160,
      card: 'title',
      cell: (entry) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-sm text-ink">
            {entry.slug} P{entry.phase}
          </div>
          {entry.title && <div className="truncate text-2xs text-ink-muted">{entry.title}</div>}
        </div>
      ),
    },
    {
      id: 'why',
      head: 'Why here',
      priority: 1,
      min: 200,
      width: '17rem',
      cell: (entry) => (
        <span
          className="text-2xs text-ink"
          data-testid="queue-why"
          title={entry.reason.all.map((key) => key.text).join('\n')}
        >
          {entry.reason.text}
        </span>
      ),
    },
    {
      id: 'waits',
      head: 'Waits on',
      priority: 2,
      min: 200,
      width: '17rem',
      cell: (entry) => (
        <span className="text-2xs text-ink-muted" data-testid="queue-waits">
          {entry.waits}
        </span>
      ),
    },
    {
      id: 'class',
      head: 'Class',
      priority: 3,
      min: 64,
      width: '5rem',
      cell: (entry) => <Badge tone={entry.class === 'high' ? 'accent' : 'neutral'}>{entry.class}</Badge>,
    },
    {
      id: 'waiting',
      head: 'Waiting since',
      priority: 3,
      min: 88,
      width: '7rem',
      cell: (entry) => <RelativeTime at={entry.clocks.since} />,
    },
    {
      id: 'account',
      head: 'Account',
      priority: 4,
      min: 72,
      width: '6rem',
      cell: (entry) => <span className="font-mono text-2xs">{entry.account}</span>,
    },
  ];
  if (allowRun) {
    columns.push({
      id: 'change',
      head: 'Change',
      priority: 2,
      min: 220,
      width: '16rem',
      cell: (entry) => (
        <div className="flex flex-wrap gap-1">
          {[...entryVerbs(entry), ...laneVerbs(entry)].map((verb) => (
            <Button
              key={verb.verb}
              size="sm"
              variant={verb.verb === 'withdraw' ? 'danger' : 'ghost'}
              title={verb.says}
              disabled={busy !== null}
              data-testid={`queue-${verb.verb}`}
              onClick={() => void press(`${entry.id}:${verb.verb}`, verb.verb, verb.body)}
            >
              {verb.label}
            </Button>
          ))}
        </div>
      ),
    });
  }
  return columns;
}

/** Under a row: every key that places it, and the way out of a branch hold (#150). */
function EntryDetail({ entry, allowRun }: { entry: QueueViewEntry; allowRun: boolean }) {
  const escapes = entry.waitingOn.flatMap((holder) => holder.escapes ?? []);
  return (
    <div className="flex min-w-0 flex-col gap-2 text-2xs text-ink-muted">
      <ul className="flex flex-col gap-0.5">
        {entry.reason.all.map((key) => (
          <li key={key.key}>{key.text}</li>
        ))}
      </ul>
      <p>
        Scope {entry.scope.join(', ')}
        {entry.branch ? `, branch ${entry.branch}` : ''}
        {entry.tree ? `, tree ${entry.tree}` : ''}.
      </p>
      {allowRun && escapes.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {escapes.map((escape) => (
            <Button
              key={escape.verb}
              size="sm"
              variant="default"
              onClick={() =>
                void post(escape.endpoint, escape.body ?? {}).then(
                  () => toast(escape.label, 'ok'),
                  (error: unknown) => toast(String((error as Error)?.message ?? error), 'error'),
                )
              }
            >
              {escape.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function Band({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2">
      <SectionHeading id={id}>{title}</SectionHeading>
      {children}
    </section>
  );
}

/** Every change anybody made to the queue, newest first — who, what, and why. */
function AuditStrip({ rows }: { rows: readonly QueueAuditRow[] }) {
  if (!rows.length) return null;
  return (
    <Band id="queue-audit" title="Recent changes">
      <ol className="flex min-w-0 flex-col gap-0.5 text-2xs text-ink-muted" data-testid="queue-audit">
        {rows.slice(0, 6).map((row, index) => (
          <li key={`${row.at ?? ''}:${index}`} className="flex min-w-0 gap-2">
            {row.at && <RelativeTime at={row.at} className="shrink-0 tabular-nums" />}
            <span className="min-w-0 break-words text-ink">{row.text}</span>
          </li>
        ))}
      </ol>
    </Band>
  );
}

/**
 * What orders this queue and what may be holding all of it (control-tower
 * phase 100): the policy — changeable here, for the console — and the load.
 */
function Capacity({
  view,
  allowRun,
  busy,
  press,
}: {
  view: QueueView | undefined;
  allowRun: boolean;
  busy: string | null;
  press: Press;
}) {
  const line = capacityLine(view);
  if (!line) return null;
  const current = view?.policy?.console ?? 'seniority';
  const labels = SCHEDULING_POLICY_LABELS as Record<string, string>;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-2xs"
      data-testid="queue-capacity"
    >
      <span className={view?.load?.holding ? 'text-accent' : 'text-ink-muted'}>{line}</span>
      {allowRun && (
        <label className="flex items-center gap-1 text-ink-muted">
          <span>Order by</span>
          <select
            value={current}
            disabled={busy !== null}
            data-testid="queue-policy"
            onChange={(event) => void press('policy', 'policy', { policy: event.target.value })}
            className={cn(fieldSurface, 'h-7 py-0 text-2xs')}
          >
            {SCHEDULING_POLICIES.map((word) => (
              <option key={word} value={word}>
                {labels[word] ?? word}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

/** The lanes kept for a phase — even while it is parked — and the press that frees each (control-tower phase 100). */
function Kept({
  rows,
  allowRun,
  busy,
  press,
}: {
  rows: readonly QueueReservation[];
  allowRun: boolean;
  busy: string | null;
  press: Press;
}) {
  if (!rows.length) return null;
  return (
    <Band id="queue-kept" title="Kept lanes">
      <ul className="flex min-w-0 flex-col gap-1" data-testid="queue-kept">
        {rows.map((row) => (
          <li
            key={`${row.slug}:${row.phase}`}
            className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-2xs"
          >
            <span className="font-mono text-sm text-ink">
              {row.slug} P{row.phase}
            </span>
            <span className="text-ink-muted">
              {row.armed
                ? `holding ${row.scope.join(', ')} and one lane until it boards`
                : `when ${row.lane ? `${row.lane.slug} P${row.lane.phase}` : 'its lane'} ends`}
              {row.by ? `, by ${row.by}` : ''}
              {row.reason ? ` — ${row.reason}` : ''}
            </span>
            {allowRun && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() =>
                  void press(`${row.slug}:${row.phase}:unreserve`, 'unreserve', {
                    slug: row.slug,
                    phase: row.phase,
                  })
                }
              >
                Free lane
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Band>
  );
}

function Lanes({
  lanes,
  allowRun = false,
  busy = null,
  press,
}: {
  lanes: readonly QueueLane[];
  allowRun?: boolean;
  busy?: string | null;
  press?: Press;
}) {
  if (!lanes.length) return null;
  return (
    <Band id="queue-lanes" title="Live lanes">
      <ul className="flex min-w-0 flex-col gap-1" data-testid="queue-lanes">
        {lanes.map((lane) => (
          <li
            key={`${lane.runId}:${lane.phase}`}
            className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-2xs"
          >
            <span className="font-mono text-sm text-ink">
              {lane.slug} P{lane.phase}
            </span>
            <span className="text-ink-muted">
              on {lane.account}, since <RelativeTime at={lane.since} />
            </span>
            <span className={lane.wait ? 'text-accent' : 'text-ink-muted'} data-testid="queue-lane-line">
              {laneLine(lane)}
            </span>
            {allowRun && press && lane.phase != null && (
              <Button
                size="sm"
                variant="ghost"
                title="Hand this lane over at its next safe point, to the head of the queue — its phase re-queues by itself"
                disabled={busy !== null}
                data-testid="queue-yield"
                onClick={() =>
                  void press(`${lane.runId}:${lane.phase}:yield`, 'yield', {
                    slug: lane.slug,
                    phase: lane.phase,
                  })
                }
              >
                Yield
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Band>
  );
}

function Hinted({
  rows,
  allowRun,
  busy,
  press,
}: {
  rows: readonly QueueHintedRow[];
  allowRun: boolean;
  busy: string | null;
  press: Press;
}) {
  if (!rows.length) return null;
  return (
    <Band id="queue-hinted" title="Asked to board, not queued yet">
      <ul className="flex min-w-0 flex-col gap-1" data-testid="queue-hinted">
        {rows.map((row) => {
          const carried = carriedPress(row.queue);
          return (
            <li
              key={`${row.runId}:${row.phase}`}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs"
            >
              <span className="font-mono text-sm text-ink">
                {row.slug} P{row.phase}
              </span>
              <span className="text-ink-muted">
                since <RelativeTime at={row.since} /> — {row.why}
              </span>
              {allowRun && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  title="Queue it now: first in its run's next lane, first in its class."
                  data-testid="queue-hinted-queue"
                  onClick={() => void press(`hinted:${row.runId}:${row.phase}`, carried.verb, carried.body)}
                >
                  Queue it
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Band>
  );
}

function Withdrawn({
  rows,
  allowRun,
  busy,
  press,
}: {
  rows: readonly QueueWithdrawnRow[];
  allowRun: boolean;
  busy: string | null;
  press: Press;
}) {
  if (!rows.length) return null;
  return (
    <Band id="queue-withdrawn" title="Withdrawn">
      <ul className="flex min-w-0 flex-col gap-1" data-testid="queue-withdrawn">
        {rows.map((row) => {
          const carried = carriedPress(row.requeue);
          return (
            <li
              key={`${row.runId}:${row.phase}`}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs"
            >
              <span className="font-mono text-sm text-ink">
                {row.slug} P{row.phase}
              </span>
              <span className="text-ink-muted">{row.text}</span>
              {allowRun && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  data-testid="queue-requeue"
                  onClick={() =>
                    void press(`withdrawn:${row.runId}:${row.phase}`, carried.verb, carried.body)
                  }
                >
                  Re-queue
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Band>
  );
}
