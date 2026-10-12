/**
 * Logs and retention — what this console keeps, and for how long (7.0's since
 * quiet-console phase 23, when every key became a page's to write).
 *
 * ```
 * Logs and retention
 * 1.2 GB across 9 sinks. The next sweep would act on 3 files.
 * Runs, journals and their sidecars   812 MB · 214 files   30 days, at least 20 per plan …   3 due
 * …
 * Runs                                                    5 keys
 * Keep a finished run for                                  [ 30 ] days
 * Keep at least, per plan                                  [ 20 ]
 * ▸ Logs  ▸ Ledgers  ▸ Git traces and evidence
 * ```
 *
 * Two questions nothing else answers: what is using this console's disk, and
 * how long each thing is kept. The report (`GET /api/debug/retention`) is the
 * same table the sweep acts on — `due` is the count the planner has already
 * decided on, so "is it about to delete something I want" is answered BEFORE
 * it does.
 *
 * Every member of the policy is a key a page may write (`retention.<key>`,
 * through the one settings door), and each is held there to the floor the
 * loader holds it to (`server/retention-policy.ts`): a size or an age above
 * zero — a zero cap would mean "delete everything" — except the runs kept per
 * plan, where zero means "keep none past its age"; and a trim's tail under
 * the size that triggers it. The page says each floor before the press. The
 * sweep reads the file, so the next one uses a change.
 */

import { PREF_META } from '@shared/prefs-model.js';
import { usePrefsSchema } from '@/data/console';
import { useRetention } from '@/data/logs';
import { Disclosure } from '@/ui/disclosure';
import { Skeleton } from '@/ui';
import { NumberSetting, SettingsGroup, readFailureClause, useSetting } from './setting';

const MB = 1024 * 1024;

/** Bytes as a person reads them. Three significant figures is all a size needs. */
export function bytesWords(value: number): string {
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
 * The sentence for each sink. The server sends the NUMBERS; these are the words
 * for them — the meaning is the product's, not a console's.
 */
export const SINK_WORDS: Readonly<
  Record<string, { label: string; kept: (p: Record<string, number>) => string }>
> = {
  'console-log': {
    label: 'Console log',
    kept: (p) => `rotates at ${bytesWords(p.consoleLogMaxBytes ?? 0)}, one previous kept`,
  },
  'supervisor-stdio': {
    label: 'Its output files',
    kept: (p) =>
      `trimmed past ${bytesWords(p.supervisorLogMaxBytes ?? 0)}, keeping the last ${bytesWords(p.supervisorLogKeepBytes ?? 0)}`,
  },
  'fleet-log': {
    label: 'The machine’s supervisor log',
    kept: (p) => `trimmed past ${bytesWords(p.supervisorLogMaxBytes ?? 0)}`,
  },
  'run-records': {
    label: 'Runs, journals and their sidecars',
    kept: (p) =>
      `${p.runRetainDays ?? 0} days, at least ${p.runRetainMin ?? 0} per plan, ${bytesWords(p.runsMaxBytes ?? 0)} in total`,
  },
  'run-worktrees': {
    label: 'Kept run checkouts',
    kept: (p) =>
      `reported past ${p.runWorktreeRetainDays ?? 0} days or ${bytesWords(p.runWorktreesMaxBytes ?? 0)} together — removed by their run’s prune, never by the sweep`,
  },
  'task-inbox': { label: 'Task lists', kept: (p) => `${p.taskInboxDays ?? 0} days` },
  'outcome-inbox': {
    label: 'Declared outcomes',
    kept: (p) => `${p.outcomeInboxDays ?? 0} days, at most ${p.outcomeInboxMax ?? 0} a plan`,
  },
  rulings: {
    label: 'Ruling ledgers',
    kept: (p) => `never pruned — reported past ${bytesWords(p.rulingsOversizedBytes ?? 0)}`,
  },
  'session-events': {
    label: 'Session event logs',
    kept: (p) => `pruned with the session, ${bytesWords(p.sessionEventsMaxBytes ?? 0)} each`,
  },
  'git-trace': {
    label: 'Git traces',
    kept: (p) =>
      `leftovers past ${p.gitTraceLeftoverHours ?? 0} h, ${bytesWords(p.gitTraceDirMaxBytes ?? 0)} in total`,
  },
  messages: {
    label: 'Message ledgers',
    kept: (p) =>
      `rotates at ${bytesWords(p.messagesRotateBytes ?? 0)}, kept ${p.messagesRetainDays ?? 0} days`,
  },
  crashes: { label: 'Crash records', kept: (p) => `${p.crashRetainDays ?? 0} days` },
  locks: {
    label: 'Lock history',
    kept: (p) => `rotates at ${bytesWords(p.locksRotateBytes ?? 0)}, one previous kept`,
  },
  'human-steps': {
    label: 'Your-turn steps',
    kept: (p) => `rotates at ${bytesWords(p.humanStepsRotateBytes ?? 0)}, one previous kept`,
  },
  'turn-evidence': {
    label: 'Attached evidence',
    kept: (p) => `${p.turnEvidenceRetainDays ?? 0} days, ${bytesWords(p.turnEvidenceMaxBytes ?? 0)} in total`,
  },
  grants: { label: 'Grant ledger', kept: (p) => `rotates at ${bytesWords(p.grantsRotateBytes ?? 0)}` },
  handled: { label: 'Handled log', kept: (p) => `rotates at ${bytesWords(p.handledRotateBytes ?? 0)}` },
};

/** One key's row: its name on the page. The hint is the schema's own sentence. */
interface RetentionKey {
  key: string;
  label: string;
}

/** Every retention key, by what it keeps — the first group open, the rest one press away. */
export const RETENTION_GROUPS: readonly { id: string; title: string; keys: readonly RetentionKey[] }[] = [
  {
    id: 'runs',
    title: 'Runs',
    keys: [
      { key: 'runRetainDays', label: 'Keep a finished run for' },
      { key: 'runRetainMin', label: 'Keep at least, per plan' },
      { key: 'runsMaxBytes', label: 'Every plan’s runs together, at most' },
      { key: 'runWorktreeRetainDays', label: 'Report a kept run checkout after' },
      { key: 'runWorktreesMaxBytes', label: 'Report kept run checkouts past' },
    ],
  },
  {
    id: 'logs',
    title: 'Logs',
    keys: [
      { key: 'consoleLogMaxBytes', label: 'Rotate the console log at' },
      { key: 'supervisorLogMaxBytes', label: 'Trim its output files past' },
      { key: 'supervisorLogKeepBytes', label: 'Of a trimmed file, keep the last' },
      { key: 'crashRetainDays', label: 'Keep crash records and heap snapshots for' },
    ],
  },
  {
    id: 'ledgers',
    title: 'Ledgers',
    keys: [
      { key: 'taskInboxDays', label: 'Keep a phase’s task list for' },
      { key: 'outcomeInboxDays', label: 'Keep a declared outcome for' },
      { key: 'outcomeInboxMax', label: 'Declared outcomes per plan, at most' },
      { key: 'rulingsOversizedBytes', label: 'Report a ruling ledger past' },
      { key: 'sessionEventsMaxBytes', label: 'One session’s presence events, at most' },
      { key: 'messagesRotateBytes', label: 'Rotate the message ledger at' },
      { key: 'messagesRetainDays', label: 'Keep a rotated message ledger for' },
      { key: 'locksRotateBytes', label: 'Rotate the lock history at' },
      { key: 'humanStepsRotateBytes', label: 'Rotate the human-step ledger at' },
      { key: 'grantsRotateBytes', label: 'Rotate the grant ledger at' },
      { key: 'handledRotateBytes', label: 'Rotate the handled log at' },
    ],
  },
  {
    id: 'traces',
    title: 'Git traces and evidence',
    keys: [
      { key: 'gitTraceLeftoverHours', label: 'An unread git trace goes after' },
      { key: 'gitTraceDirMaxBytes', label: 'Git traces together, at most' },
      { key: 'turnEvidenceRetainDays', label: 'Keep evidence attached to an item for' },
      { key: 'turnEvidenceMaxBytes', label: 'Attached evidence together, at most' },
    ],
  },
];

/** How a key is typed: its unit on the page, the scale from the stored number, and its floor. */
export function retentionField(key: string): { unit: string; scale: number; min: number } {
  const unit = PREF_META[`retention.${key}`]?.unit;
  const min = key === 'runRetainMin' ? 0 : 1;
  switch (unit) {
    case 'bytes':
      return { unit: 'MB', scale: MB, min };
    case 'days':
      return { unit: 'days', scale: 1, min };
    case 'hours':
      return { unit: 'hours', scale: 1, min };
    default:
      return { unit: '', scale: 1, min };
  }
}

/** What holds the trim and its tail together, said under each of the two. */
const TRIM_BOUND: Readonly<Record<string, string>> = {
  supervisorLogMaxBytes: 'It stays above the tail a trim keeps.',
  supervisorLogKeepBytes: 'It stays under the size that triggers the trim.',
};

function RetentionRow({ entry }: { entry: RetentionKey }) {
  const pref = `retention.${entry.key}`;
  const field = retentionField(entry.key);
  // A trim's tail stays under the size that triggers it — or the trim never
  // shrinks anything, and the loader would quietly cut the tail to a quarter.
  // Held from both ends: the tail under the trim, the trim above the tail.
  const trim = useSetting<number>('retention.supervisorLogMaxBytes');
  const tail = useSetting<number>('retention.supervisorLogKeepBytes');
  const max =
    entry.key === 'supervisorLogKeepBytes' && typeof trim.value === 'number'
      ? Math.max(field.min, Math.ceil(trim.value / MB) - 1)
      : undefined;
  const min =
    entry.key === 'supervisorLogMaxBytes' && typeof tail.value === 'number'
      ? Math.max(field.min, Math.floor(tail.value / MB) + 1)
      : field.min;
  const description = PREF_META[pref]?.description;
  const bound = TRIM_BOUND[entry.key];
  return (
    <NumberSetting
      pref={pref}
      label={entry.label}
      hint={bound && description ? `${description} ${bound}` : description}
      unit={field.unit || undefined}
      alignUnit
      scale={field.scale}
      min={min}
      {...(max != null ? { max } : {})}
      integer
    />
  );
}

/** What the sweep acts on now, and the policy words — read from the schema, so a save moves them. */
function SinkReport() {
  const { data, isPending, error } = useRetention();
  const schema = usePrefsSchema();
  const policy: Record<string, number> = {};
  for (const row of schema.data?.rows ?? []) {
    if (!row.key.startsWith('retention.')) continue;
    const value = row.value ?? row.default;
    if (typeof value === 'number') policy[row.key.slice('retention.'.length)] = value;
  }
  // The policy words are the schema's numbers or nothing: a read that failed
  // is said once, never worded as a policy of zeros.
  const unread = schema.isError && !schema.data && (
    <p className="max-w-(--measure) text-meta text-ink-muted" data-testid="retention-unread">
      The settings could not be read{readFailureClause(schema.error)}, so how long each is kept is not said
      here. The keys below still save.
    </p>
  );
  if (isPending) {
    return <Skeleton className="h-20" aria-busy="true" aria-label="Reading what this console keeps" />;
  }
  if (!data) {
    return (
      <>
        <p className="max-w-(--measure) text-meta text-ink-muted" data-testid="retention-report">
          The console did not say what it keeps
          {readFailureClause(error)}. The keys below still save.
        </p>
        {unread}
      </>
    );
  }
  // A sink with no files is a policy row about nothing; ten zeroes hide the three that matter.
  const sinks = data.sinks.filter((one) => one.files > 0);
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="retention-report">
      {unread}
      <p role="status" className="max-w-(--measure) text-body text-ink">
        {`${bytesWords(data.bytes)} across ${sinks.length} ${sinks.length === 1 ? 'sink' : 'sinks'}. `}
        {data.actions.length > 0
          ? `The next sweep would act on ${data.actions.length} ${data.actions.length === 1 ? 'file' : 'files'}.`
          : 'Nothing is due for the next sweep.'}
      </p>
      <ul className="flex min-w-0 flex-col gap-2" aria-label="What this console keeps">
        {sinks.map((one) => {
          const words = SINK_WORDS[one.sink];
          return (
            <li key={one.sink} className="flex min-w-0 flex-col gap-0.5" data-sink={one.sink}>
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
                <span className="text-body text-ink">{words?.label ?? one.sink}</span>
                <span className="text-meta tabular-nums text-ink-muted">
                  {bytesWords(one.bytes)} · {one.files} {one.files === 1 ? 'file' : 'files'}
                  {one.due > 0 ? ` · ${one.due} due` : ''}
                </span>
              </span>
              {words && schema.data && <span className="text-meta text-ink-muted">{words.kept(policy)}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function RetentionGroup() {
  const [first, ...rest] = RETENTION_GROUPS;
  return (
    <SettingsGroup
      id="retention"
      title="Logs and retention"
      lead="A size or an age here is where this console starts deleting. The sweep runs at boot and once a day, and reads these as it starts; rulings are never pruned."
    >
      <SinkReport />
      <div className="flex min-w-0 flex-col gap-5" data-retention-keys={first!.id}>
        <h3 className="text-body font-semibold text-ink">{first!.title}</h3>
        {first!.keys.map((entry) => (
          <RetentionRow key={entry.key} entry={entry} />
        ))}
      </div>
      {rest.map((group) => (
        <Disclosure
          key={group.id}
          label={group.title}
          count={group.keys.length}
          testId={`retention-${group.id}`}
        >
          <div className="flex min-w-0 flex-col gap-5 pt-3" data-retention-keys={group.id}>
            {group.keys.map((entry) => (
              <RetentionRow key={entry.key} entry={entry} />
            ))}
          </div>
        </Disclosure>
      ))}
    </SettingsGroup>
  );
}
