/**
 * Logs and retention — what this console is using, and for how long it keeps it.
 *
 * Two questions an operator could not previously ask anything. "What is using
 * my disk" had no answer at all: the policy was scattered across four modules
 * and half the sinks had none. "How long is this kept" had a different answer
 * per sink, none of them written down. This card is the one place both are
 * answered, and the table it shows is the same table the sweep acts on — not a
 * second computation that can drift from it.
 *
 * **The rows say what the next sweep WOULD do, before it does it.** `due` is
 * the count of files the planner has already decided on, read from the same
 * pure function the daily clock calls. That is the whole reason `planRetention`
 * is pure: a card that could only report the past would leave "is it about to
 * delete something I want" unanswerable, which is the question that makes
 * people turn retention off.
 *
 * Editing the numbers needs `--allow-writes`, because it changes what this
 * console will DELETE. Reading them needs nothing.
 */

import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, useApiMutation, useConsoleState, useRetention } from '@/lib/queries';
import { Button, Card, CardBody, CardHeader, CardTitle, DataTable, Skeleton, field } from '@/components/ui';

/** Bytes as a person reads them. Three significant figures is all a size card needs. */
function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = value / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/**
 * The sentence for each sink, written here rather than sent from the server.
 *
 * The server sends the NUMBERS; these are the words for them. A policy row
 * whose meaning lived in the API would have to be translated by every future
 * client, and the meaning is not per-console — it is the product's.
 */
const SINK_LABEL: Record<string, { label: string; policy: (p: Record<string, number>) => string }> = {
  'console-log': {
    label: 'Console log',
    policy: (p) => `rotates at ${bytes(p.consoleLogMaxBytes ?? 0)}, one previous kept`,
  },
  'supervisor-stdio': {
    label: 'Supervisor stdout and stderr',
    policy: (p) =>
      `trimmed past ${bytes(p.supervisorLogMaxBytes ?? 0)}, keeping the last ${bytes(p.supervisorLogKeepBytes ?? 0)}`,
  },
  'fleet-log': {
    label: 'Fleet supervisor log',
    policy: (p) => `trimmed past ${bytes(p.supervisorLogMaxBytes ?? 0)}`,
  },
  'run-records': {
    label: 'Runs, journals and their sidecars',
    policy: (p) =>
      `${p.runRetainDays ?? 0} days, at least ${p.runRetainMin ?? 0} per plan, ${bytes(p.runsMaxBytes ?? 0)} in total`,
  },
  'task-inbox': { label: 'Task ledgers', policy: (p) => `${p.taskInboxDays ?? 0} days` },
  'outcome-inbox': {
    label: 'Declared outcomes',
    policy: (p) => `${p.outcomeInboxDays ?? 0} days, at most ${p.outcomeInboxMax ?? 0} a plan`,
  },
  rulings: {
    label: 'Ruling ledgers',
    policy: (p) => `never pruned — reported past ${bytes(p.rulingsOversizedBytes ?? 0)}`,
  },
  'session-events': {
    label: 'Session event logs',
    policy: (p) => `pruned with the session, ${bytes(p.sessionEventsMaxBytes ?? 0)} each`,
  },
  'git-trace': {
    label: 'Git traces',
    policy: (p) =>
      `leftovers past ${p.gitTraceLeftoverHours ?? 0} h, ${bytes(p.gitTraceDirMaxBytes ?? 0)} in total`,
  },
  messages: {
    label: 'Message ledgers',
    policy: (p) => `rotates at ${bytes(p.messagesRotateBytes ?? 0)}, kept ${p.messagesRetainDays ?? 0} days`,
  },
};

/** The four numbers worth editing from a page; the rest are edited in `config.json`. */
const EDITABLE: { key: string; label: string; unit: 'days' | 'MB' | 'count' }[] = [
  { key: 'runRetainDays', label: 'Keep runs for', unit: 'days' },
  { key: 'runRetainMin', label: 'Keep at least, per plan', unit: 'count' },
  { key: 'runsMaxBytes', label: 'All runs together, at most', unit: 'MB' },
  { key: 'supervisorLogMaxBytes', label: 'Trim supervisor logs past', unit: 'MB' },
];

const MB = 1024 * 1024;

export function RetentionCard() {
  const { data: state } = useConsoleState();
  const { data, isPending } = useRetention();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const writesOff = state?.allowWrites !== true;

  const save = useApiMutation<Record<string, number>, unknown>({
    fn: (retention) => api.savePrefs({ retention }),
    invalidates: [keys.debugRetention(), keys.state()],
    say: 'Retention saved. The next sweep uses it.',
    onDone: () => setDraft({}),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Logs and retention</CardTitle>
      </CardHeader>
      <CardBody>
        {isPending || !data ? (
          <Skeleton className="h-32" />
        ) : (
          <>
            <p className="text-2xs text-ink-faint">
              {`${bytes(data.bytes)} across ${data.sinks.filter((one) => one.files > 0).length} sinks. `}
              {data.actions.length > 0
                ? `The next sweep would act on ${data.actions.length} file(s).`
                : 'Nothing is due for the next sweep.'}
            </p>
            <DataTable
              label="What this console keeps"
              // A sink with no files is a policy row about nothing — it is in
              // the docs, and a table of ten zeroes hides the three that matter.
              rows={data.sinks.filter((one) => one.files > 0)}
              getRowKey={(one) => one.sink}
              columns={[
                {
                  id: 'sink',
                  head: 'Sink',
                  priority: 1,
                  min: 180,
                  flex: true,
                  identity: true,
                  card: 'title',
                  cell: (one) => <span className="text-ink">{SINK_LABEL[one.sink]?.label ?? one.sink}</span>,
                },
                { id: 'size', head: 'Size', priority: 2, min: 80, cell: (one) => bytes(one.bytes) },
                { id: 'files', head: 'Files', priority: 4, min: 60, cell: (one) => String(one.files) },
                {
                  id: 'policy',
                  head: 'Kept',
                  priority: 3,
                  min: 220,
                  flex: true,
                  cell: (one) => (
                    <span className="text-ink-faint">{SINK_LABEL[one.sink]?.policy(data.policy) ?? '—'}</span>
                  ),
                },
                {
                  id: 'due',
                  head: 'Due',
                  priority: 5,
                  min: 60,
                  cell: (one) => (one.due > 0 ? String(one.due) : '—'),
                },
              ]}
            />

            <div className="mt-4 border-t border-rule pt-3">
              <div className="grid gap-2 sm:grid-cols-2">
                {EDITABLE.map((row) => {
                  const stored = data.policy[row.key] ?? 0;
                  const shown = row.unit === 'MB' ? Math.round(stored / MB) : stored;
                  return (
                    <label key={row.key} className="flex flex-col gap-1 text-2xs text-ink-faint">
                      {`${row.label} (${row.unit})`}
                      <input
                        type="number"
                        min={row.key === 'runRetainMin' ? 0 : 1}
                        // The shared control class, not a hand-rolled one: a
                        // number input written by hand lands 22px tall, which is
                        // half the thumb floor on the phone this console is read
                        // from. `styles/touch.test.ts` is the gate.
                        className={`${field} px-2 text-xs`}
                        value={draft[row.key] ?? String(shown)}
                        disabled={writesOff || save.isPending}
                        title={
                          writesOff
                            ? 'Restart with --allow-writes — these numbers decide what this console deletes.'
                            : undefined
                        }
                        onChange={(event) => setDraft((was) => ({ ...was, [row.key]: event.target.value }))}
                      />
                    </label>
                  );
                })}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={writesOff || save.isPending || Object.keys(draft).length === 0}
                  title={
                    writesOff
                      ? 'Restart with --allow-writes — these numbers decide what this console deletes.'
                      : 'Saved whole; a value the console cannot use falls back to its shipped default.'
                  }
                  onClick={() => {
                    const patch: Record<string, number> = { ...data.policy };
                    for (const [key, value] of Object.entries(draft)) {
                      const row = EDITABLE.find((one) => one.key === key);
                      const n = Number(value);
                      if (!Number.isFinite(n)) continue;
                      patch[key] = row?.unit === 'MB' ? n * MB : n;
                    }
                    save.mutate(patch);
                  }}
                >
                  {save.isPending ? 'Saving…' : 'Save retention'}
                </Button>
                <span className="text-2xs text-ink-faint">
                  Rulings are never pruned. The sweep runs at boot and once a day.
                </span>
              </div>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
