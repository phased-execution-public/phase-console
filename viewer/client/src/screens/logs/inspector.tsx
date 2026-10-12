/**
 * One log row, in the panel: what it said, where it came from, and the way to
 * every other row of its story.
 *
 * Overview is the row's words and its facts — the level, the source, the
 * moment, the plan, the run, the phase and the trace — each fact that names a
 * record a link to it: the plan to its page, the run to its journal, the trace
 * to the explorer narrowed to that trace (the run's whole story, and nothing
 * that merely shares its clock). Raw is the redacted record as the server
 * sent it, which is the thing a person quotes.
 */

import type { HealthSeverity } from '@shared/ops-vocab.js';
import type { DebugEntry, DebugLevel } from '@/data/api';
import { planHref } from '@/shell/routes';
import { inspect } from '@/shell/panel/inspector-host';
import { KeyValue, Mono, RelativeTime } from '@/ui';
import { CopyButton } from '@/ui/copy-button';
import { OpsStatus } from '@/ui/status';
import { logsSectionHref } from './routes';

/** A log level, as the health vocabulary words it: Info, Warning, Error. */
export const LEVEL_WORD: Readonly<Record<DebugLevel, HealthSeverity>> = {
  info: 'info',
  warn: 'warning',
  error: 'error',
};

/** What each source is, said once — the filter's lines and the panel's. */
export const LOG_SOURCE_BLURB: Readonly<Record<DebugEntry['source'], string>> = {
  console: 'The console’s own log, and this process’s ring of recent lines.',
  supervisor: 'The supervisor’s stdout and stderr — where a crash before the logger lands.',
  journal: 'The runs’ journals: what each lane did, one event at a time.',
  outcome: 'What an unsupervised session declared about how it ended.',
  ruling: 'What sessions decided, per plan.',
  delivery: 'What happened to each announcement, per device.',
  health: 'The environment doctor’s findings, each with its fix.',
};

const LINK = 'tap-line text-ink underline decoration-ink-faint underline-offset-2';

/** A row's key — its moment, source and event, and its place in the list. */
export const entryKey = (entry: DebugEntry, index: number): string =>
  `${entry.at}|${entry.source}|${entry.event}|${index}`;

function EntryOverview({ entry }: { entry: DebugEntry }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="max-w-(--measure) text-body break-words text-ink">
        {entry.text || 'This row said nothing.'}
      </p>
      <KeyValue
        items={[
          ['Level', <OpsStatus key="level" vocab="health" word={LEVEL_WORD[entry.level]} />],
          [
            'Source',
            <span key="source" title={LOG_SOURCE_BLURB[entry.source]}>
              {entry.source}
            </span>,
          ],
          [
            'When',
            entry.at ? (
              <span key="at">
                <RelativeTime at={entry.at} />{' '}
                <span className="text-ink-muted">{new Date(entry.at).toLocaleString()}</span>
              </span>
            ) : (
              'undated — this source wrote no time'
            ),
          ],
          ['Event', <Mono key="event" value={entry.event} />],
          entry.slug
            ? [
                'Plan',
                <a key="plan" href={planHref(entry.slug)} className={LINK}>
                  {entry.slug}
                </a>,
              ]
            : null,
          entry.runId
            ? [
                'Run',
                entry.slug ? (
                  <a
                    key="run"
                    href={logsSectionHref('journal', {
                      slug: entry.slug,
                      run: entry.runId,
                      phase: entry.phase,
                    })}
                    className={LINK}
                  >
                    <Mono value={entry.runId} />
                  </a>
                ) : (
                  <Mono key="run" value={entry.runId} />
                ),
              ]
            : null,
          entry.phase !== undefined ? ['Phase', `Phase ${entry.phase}`] : null,
          entry.traceId
            ? [
                'Trace',
                <a key="trace" href={logsSectionHref('logs', { trace: entry.traceId })} className={LINK}>
                  <Mono value={entry.traceId} chars={12} title={`Show every row of trace ${entry.traceId}`} />
                </a>,
              ]
            : null,
        ]}
      />
      <p className="max-w-(--measure) text-meta text-ink-muted">
        Secret-shaped values and the operator’s home path are masked on the way out of the server, here as in
        the bundle.
      </p>
    </div>
  );
}

function EntryRaw({ entry }: { entry: DebugEntry }) {
  const text = JSON.stringify(entry, null, 2);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div>
        <CopyButton text={text} label="Copy the row" copiedLabel="Copied the row" />
      </div>
      <pre className="overflow-x-auto font-mono text-meta whitespace-pre-wrap break-words text-ink">
        {text}
      </pre>
    </div>
  );
}

/** Put a row in the panel. */
export function inspectEntry(entry: DebugEntry, index: number): void {
  inspect({
    key: `log:${entryKey(entry, index)}`,
    title: entry.event,
    overview: <EntryOverview entry={entry} />,
    raw: <EntryRaw entry={entry} />,
  });
}
