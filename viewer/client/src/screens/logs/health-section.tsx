/**
 * Logs ▸ Health — is this console well, and the bundle for whoever asks.
 *
 * ```
 * This console's runtime   Heap ▬▬▬▬▬░░░ 812 MB of 6.0 GB   Event-loop delay 3 ms   Event streams 2
 * ───────────────────────────────────────────────────────────────────────────
 * Over time                Full gate ▁▃▅▃  Load per core ▂▃▂▂  Save time ▁▁▂▁
 * ───────────────────────────────────────────────────────────────────────────
 * Doctor                   [Run the doctor]
 * ───────────────────────────────────────────────────────────────────────────
 * This process             Generation 412   Booted 3 hours ago   Serving build af1cadb3 …
 * ───────────────────────────────────────────────────────────────────────────
 * (Retired credentials, only while there is one)
 * ───────────────────────────────────────────────────────────────────────────
 * Automatic starts this hour   Work starts ▬▬▬░░░ 12 of 40   Work spend $48.20 of $250.00 …
 * ───────────────────────────────────────────────────────────────────────────
 * Stray consoles           None: every console process on this machine still has its code.
 * ───────────────────────────────────────────────────────────────────────────
 * The bundle               [Copy for AI]  [Download the bundle]  Export one run
 * ───────────────────────────────────────────────────────────────────────────
 * Environment, the watch clock and metrics      [Read them]
 * ```
 *
 * Questions between hairlines, each answered once, top to bottom. The runtime
 * is a scrape every 15 s while the section is open, never a history, and the
 * start ceiling a read of the server's memory every 30 s; the stray consoles
 * are one `ps`, read on arrival. The doctor and the bundle cost a pass over
 * every source, so each runs when it is asked for. Over time is the one place
 * the console keeps a history of its own health (measured-console phase 31,
 * F2): a bounded series per measure — the full gate's seconds per run, the
 * machine's load per core, the mean milliseconds a run save took
 * — read from `GET /api/health/series`, with the bounds said in words. `/api/metrics` still
 * renders only the current facts on every scrape, so the metrics below are a
 * snapshot and say so; the run's own timeline is the run journal.
 */

import { useState, type ReactNode } from 'react';
import { RetirementEvidence, hasRetirementStory } from '@/cards/retirement-evidence';
import { useAccounts } from '@/data/accounts';
import { api, type DoctorRow, type MetricFamily } from '@/data/api';
import { useConsoleState } from '@/data/console';
import { useDebugBundle, useDoctor, useHealthSeries, useRuntime, type HealthSeriesView } from '@/data/logs';
import { consolePath } from '@/lib/base';
import { bytes, duration, plural } from '@/lib/format';
import type { Route } from '@/shell/routes';
import { Banner, Button, KeyValue, Mono, SectionHeading, Skeleton, type KeyValueItem } from '@/ui';
import { CopyButton } from '@/ui/copy-button';
import { Disclosure } from '@/ui/disclosure';
import { BarList, Series } from '@/ui/figures/lazy';
import { OpsStatus } from '@/ui/status';
import { LoadMeter } from '@/ui/track/meter';
import { CeilingCounters } from './ceiling';
import { logsSectionHref } from './routes';
import { readRuntime } from './runtime';
import { StrayConsoleList } from './strays';

const LINK = 'tap-line whitespace-nowrap text-ink underline decoration-ink-faint underline-offset-2';

/** One question of the section: its heading, then its answer. The section draws a hairline between them. */
function HealthQuestion({
  id,
  title,
  children,
  testId,
}: {
  id: string;
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      aria-labelledby={`health-${id}`}
      data-health={id}
      data-testid={testId}
      className="flex min-w-0 flex-col gap-3 py-6 first:pt-0"
    >
      <SectionHeading id={`health-${id}`}>{title}</SectionHeading>
      {children}
    </section>
  );
}

/** A moment, as a clock that does not tick. */
function At({ at }: { at: string }) {
  const date = new Date(at);
  return <time dateTime={at}>{Number.isNaN(date.getTime()) ? at : date.toLocaleString()}</time>;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A point's instant as the axis writes it, in UTC: `Oct 17 14:05`. */
function pointTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const clock = `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()} ${clock}`;
}

type SeriesMeasure = keyof HealthSeriesView['measures'];

/** Each measure: its caption, the row's name, how a value is written, and what an empty strip says. */
const SERIES_MEASURES: readonly {
  id: SeriesMeasure;
  caption: string;
  name: string;
  format: (value: number) => string;
  empty: string;
}[] = [
  {
    id: 'gate',
    caption: 'The full gate, seconds per run',
    name: 'Gate time',
    format: (value) => duration(value * 1000),
    empty: 'The full gate has not run on this machine.',
  },
  {
    id: 'load',
    caption: 'Load per core, the five-minute average',
    name: 'Load per core',
    format: (value) => value.toFixed(2),
    empty: 'No load has been sampled yet.',
  },
  {
    id: 'persist',
    caption: 'Mean milliseconds a run save took',
    name: 'Save time',
    format: (value) => `${Math.round(value)} ms`,
    empty: 'No run has been saved since sampling began.',
  },
];

/**
 * Health over time (measured-console phase 31, F2): one small figure per measure, a point each —
 * and the bounds said in words, so a strip that stops short reads as the retention, not a fault.
 */
function OverTime() {
  const { data, error, refetch } = useHealthSeries();
  if (error && !data) {
    return (
      <Banner
        severity="error"
        action={
          <Button size="sm" variant="ghost" onClick={() => void refetch()}>
            Try again
          </Button>
        }
      >
        Health over time could not be read: {error.message}
      </Banner>
    );
  }
  if (!data) return <Skeleton className="h-40" aria-busy="true" />;
  const { bounds } = data;
  const minutes = Math.round(bounds.sampleMs / 60_000);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="max-w-(--measure) text-meta text-ink-muted" data-testid="health-series-bounds">
        Kept for {plural(bounds.days, 'day')}, and at most {plural(bounds.maxPoints, 'point')} of each
        measure, the newest. Load and save time are sampled every {plural(minutes, 'minute')}; the gate has a
        point per run. Times are UTC.
      </p>
      {SERIES_MEASURES.map((measure) => {
        const points = data.measures[measure.id] ?? [];
        return (
          <div
            key={measure.id}
            className="flex min-w-0 flex-col gap-2"
            data-testid={`health-series-${measure.id}`}
            data-points={points.length}
          >
            <h3 className="text-meta font-normal text-ink-muted">{measure.caption}</h3>
            <Series
              buckets={points.map((point) => ({ start: point.at, end: point.at }))}
              rows={[{ name: measure.name, values: points.map((point) => point.v) }]}
              format={measure.format}
              timeText={pointTime}
              label={measure.caption}
              heads={{ time: 'Time (UTC)' }}
              summed={false}
              empty={measure.empty}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * The console's runtime, on screen before anything is asked for (#20: a heap
 * climbing to its limit twice in five minutes with no number anyone could
 * watch). These are those numbers.
 */
export function RuntimeStrip() {
  const { data, error, dataUpdatedAt } = useRuntime(readRuntime);
  const heap = data?.heapUsedBytes;
  const limit = data?.heapLimitBytes;
  const delay = data?.eventLoopDelaySeconds;
  if (error) {
    return (
      <p className="text-body text-ink-muted" data-testid="runtime-strip">
        The runtime could not be read from <Mono value="/api/metrics" />: {error.message}
      </p>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="runtime-strip">
      <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2 text-meta text-ink-muted">
        <span className="flex min-w-48 flex-1 items-center gap-2 sm:max-w-sm">
          <span>Heap</span>
          {heap !== undefined && limit ? (
            <LoadMeter
              value={heap}
              max={limit}
              label="Heap"
              valueText={`${bytes(heap)} of ${bytes(limit)}`}
              reading={`${bytes(heap)} of ${bytes(limit)}`}
              paint={heap / limit > 0.85 ? 'failed' : 'running'}
              className="flex-1"
            />
          ) : (
            <span className="text-ink">{data ? 'not reported' : 'reading…'}</span>
          )}
        </span>
        <span>
          Event-loop delay{' '}
          <span className="tnum text-ink">
            {delay !== undefined ? `${Math.round(delay * 1000)} ms` : 'not reported'}
          </span>
        </span>
        <span>
          Event streams <span className="tnum text-ink">{data?.sseClients ?? 'not reported'}</span>
        </span>
      </div>
      {dataUpdatedAt ? (
        <p className="text-meta text-ink-muted">
          As of {new Date(dataUpdatedAt).toLocaleTimeString()}, read every 15 seconds while this section is
          open.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The doctor's rows, worst first: the first BLOCKING failure leads — the one
 * to fix first, and the server names it — then the other failures, then what
 * passed, then what was not asked.
 */
export function doctorOrder(rows: readonly DoctorRow[], first: DoctorRow | null): DoctorRow[] {
  const rank = (row: DoctorRow) =>
    first && row.id === first.id
      ? 0
      : row.status === 'fail'
        ? row.blocking
          ? 1
          : 2
        : row.status === 'ok'
          ? 3
          : 4;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
    .map((x) => x.row);
}

/**
 * A check's name, its flag kept whole: `Outward writes (--allow-publish)` in
 * an 11rem column broke after `--allow-`, a flag nobody could then read or
 * copy. The space before the parenthesis stays the place to wrap.
 */
function CheckName({ label }: { label: string }) {
  const flag = /^(.*\S)\s+(\(--[^()\s]+\))$/.exec(label);
  if (!flag) return label;
  return (
    <>
      {flag[1]} <span className="whitespace-nowrap">{flag[2]}</span>
    </>
  );
}

function Doctor() {
  // It shells out (`gh`, the CLI, the hooks), so it runs when asked, and a
  // minute's answer is reused.
  const [asked, setAsked] = useState(false);
  const { data, error, refetch, isFetching } = useDoctor(asked);
  if (!asked) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2" data-testid="doctor">
        <p className="max-w-(--measure) text-body text-ink-muted">
          The checks a run’s start makes, and the machine’s own, as <Mono value="phase-console doctor" />{' '}
          prints them.
        </p>
        <Button size="sm" onClick={() => setAsked(true)}>
          Run the doctor
        </Button>
      </div>
    );
  }
  if (error) {
    return (
      <Banner
        severity="error"
        data-testid="doctor"
        action={
          <Button size="sm" variant="ghost" onClick={() => void refetch()}>
            Try again
          </Button>
        }
      >
        The doctor could not run: {error.message}
      </Banner>
    );
  }
  if (!data) return <Skeleton className="h-24" data-testid="doctor" aria-busy="true" />;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="doctor">
      <p className="max-w-(--measure) text-body text-ink" data-testid="doctor-verdict">
        {data.ok
          ? 'Nothing blocks a start.'
          : `Blocked: ${data.firstFailing?.label ?? 'a check failed'} — fix that first.`}{' '}
        <span className="text-meta text-ink-muted">
          As of <At at={data.at} />, CLI floor {data.cliFloor}.
        </span>
      </p>
      <ul className="flex min-w-0 flex-col divide-y divide-rule" aria-label="Doctor checks">
        {doctorOrder(data.rows, data.firstFailing).map((row) => (
          // Three tracks on a desk — the word, the check, the reason — so the
          // words read down one column whatever a check is called; on a phone
          // the word and the check share a line (`sm:contents` hands the two
          // to the desk's grid). The advice is its own line: a reason often
          // ends on a command, and a sentence run on after it reads as part
          // of the command.
          <li
            key={row.id}
            data-testid="doctor-row"
            data-row={row.id}
            className="grid min-w-0 gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[5.5rem_11rem_minmax(0,1fr)] sm:items-baseline"
          >
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 sm:contents">
              <OpsStatus vocab="probe" word={row.status} />
              <span className="min-w-0 text-body break-words text-ink">
                <CheckName label={row.label} />
              </span>
            </span>
            <span className="min-w-0 text-body break-words text-ink-muted">
              {row.reason}
              {row.status === 'fail' && !row.blocking ? (
                <span className="mt-0.5 block text-meta">A start still goes ahead: this one is advice.</span>
              ) : null}
              {row.warnings?.length ? (
                <span className="mt-0.5 block text-meta">{row.warnings.join('; ')}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <div>
        <Button size="sm" variant="ghost" disabled={isFetching} onClick={() => void refetch()}>
          {isFetching ? 'Checking…' : 'Check again'}
        </Button>
      </div>
    </div>
  );
}

/**
 * This process: which generation of the docs it has read, when it booted, the
 * build it serves, how node started it, what restarts it, and a restart's
 * update while it runs.
 */
function ThisProcess() {
  const { data: state } = useConsoleState();
  const restart = state?.restartUpdate ?? null;
  const items: KeyValueItem[] = [
    ['Generation', state?.generation !== undefined ? String(state.generation) : 'not reported'],
    ['Booted', state?.bootedAt ? <At at={state.bootedAt} /> : 'not reported'],
    ['Serving build', state?.distRev ? <Mono value={state.distRev} chars={12} copyable /> : 'unstamped'],
    ['Node arguments', state?.execArgv?.length ? <Mono value={state.execArgv.join(' ')} /> : 'none'],
    ['Supervisor', state?.supervisor?.detail ?? 'not reported'],
    ['Source', state?.root?.path ? <Mono value={state.root.path} /> : 'none open'],
    ['Platform', state?.platform ?? 'not reported'],
  ];
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="process">
      <KeyValue items={items} />
      <p className="max-w-(--measure) text-meta text-ink-muted">
        The generation counts the changes to the docs this console has read; a page behind it shows an older
        board.
      </p>
      <div>
        <CopyButton
          text={async () => JSON.stringify(await api.stateWith(['full']), null, 2)}
          label="Copy the whole state"
          copiedLabel="Copied the state"
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1" data-testid="restart-update">
        <span className="text-meta text-ink-muted">Restart and update</span>
        {restart ? (
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-body text-ink">
            <OpsStatus vocab="restart" word={restart.state} />
            <span className="min-w-0 break-words text-ink-muted">
              {restart.detail}. Asked by {restart.by}, started <At at={restart.startedAt} />
              {restart.finishedAt ? (
                <>
                  , finished <At at={restart.finishedAt} />
                </>
              ) : null}
              {restart.expectedEnd ? (
                <>
                  ; expected to end by <At at={restart.expectedEnd} />
                </>
              ) : null}
              {restart.lanes ? `; waiting on ${plural(restart.lanes, 'live lane')}` : ''}
              {restart.plans?.length ? ` (${restart.plans.join(', ')})` : ''}.
            </span>
          </p>
        ) : (
          <p className="text-body text-ink-muted">No restart or update since this process booted.</p>
        )}
      </div>
    </div>
  );
}

/** Every account whose credential was retired, or whose retirement a later read contradicted. */
function useRetirements() {
  const { data } = useAccounts();
  return [
    ...(data?.accounts ?? []).map((a) => ({
      id: a.id,
      name: a.name ?? a.email ?? a.id,
      entitlement: a.entitlement,
    })),
    ...(data?.tombstones ?? []).map((t) => ({
      id: t.id,
      name: `${t.name} (removed)`,
      entitlement: t.entitlement,
    })),
  ].filter((row) => hasRetirementStory(row.entitlement));
}

/** The bundle: one redacted JSON snapshot for a model's context, and one run's own files. */
function TheBundle() {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="max-w-(--measure) text-body text-ink-muted">
        Versions, flags, health, the watch clock, every metric family, the newest log rows and the delivery
        tally, as one JSON snapshot. Secret-shaped values and the operator’s home path are masked on the way
        out of the server, so it is safe to paste into a model’s context.
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <CopyButton
          text={async () => JSON.stringify(await api.debugBundle({}), null, 2)}
          label="Copy for AI"
          copiedLabel="Copied the bundle"
        />
        <Button size="sm" variant="ghost" asChild>
          <a href={consolePath('/api/debug/bundle?download=1')} download>
            Download the bundle
          </a>
        </Button>
      </div>
      <p className="max-w-(--measure) text-meta text-ink-muted">
        One run’s own files — its journal, transcript, ledgers, outcomes, locks and git trace, redacted, as a
        tar.gz — are on{' '}
        <a href={logsSectionHref('journal')} className={LINK}>
          Journal
        </a>
        , or <Mono value="phase-console diagnostics --run <id>" words /> with the console down.
      </p>
    </div>
  );
}

/** A family worth a figure has more than one labelled sample. */
function chartable(family: MetricFamily): boolean {
  return family.samples.length > 1 && family.samples.some((s) => Object.keys(s.labels).length > 0);
}

/** A sample's labels as one readable string — `status=active closed=0`. */
function labelText(labels: Record<string, string>): string {
  const parts = Object.entries(labels).map(([key, value]) => `${key}=${value}`);
  return parts.length ? parts.join(' ') : 'no labels';
}

function Family({ family }: { family: MetricFamily }) {
  const items = family.samples.map((sample) => ({ name: labelText(sample.labels), value: sample.value }));
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-metric={family.name}>
      <h4 className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-body text-ink">
        <Mono value={family.name} />
        <span className="text-meta text-ink-muted">{family.type}</span>
      </h4>
      {family.help ? <p className="max-w-(--measure) text-meta text-ink-muted">{family.help}</p> : null}
      {chartable(family) ? (
        <BarList items={items} label={`${family.name} samples`} />
      ) : (
        <ul className="flex min-w-0 flex-col gap-0.5 text-meta">
          {items.map((item) => (
            <li key={item.name} className="flex min-w-0 justify-between gap-3">
              <span className="min-w-0 truncate font-mono text-ink-muted">{item.name}</span>
              <span className="tnum text-ink">{item.value}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What the bundle holds about health: the environment, the watch clock and the metrics — read on a press. */
function BundleHealth() {
  const [asked, setAsked] = useState(false);
  const { data, error, refetch } = useDebugBundle({}, asked);
  if (!asked) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <p className="max-w-(--measure) text-body text-ink-muted">
          One pass over the environment doctor, the watch clock and every metric family.
        </p>
        <Button size="sm" onClick={() => setAsked(true)}>
          Read them
        </Button>
      </div>
    );
  }
  if (error) {
    return (
      <Banner
        severity="error"
        action={
          <Button size="sm" variant="ghost" onClick={() => void refetch()}>
            Try again
          </Button>
        }
      >
        The bundle could not be read: {error.message}
      </Banner>
    );
  }
  if (!data) return <Skeleton className="h-40" aria-busy="true" />;

  const watches = data.health.watches;
  // A failed scrape is recorded as a note rather than a 500, so the notes
  // say WHICH empty list the metrics are.
  const metricsFailure = data.notes.find((note) => note.startsWith('Metrics could not be rendered'));
  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="bundle-health">
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-body font-semibold text-ink">Environment</h3>
        {data.health.environment.length === 0 ? (
          <p className="max-w-(--measure) text-body text-ink-muted">
            Nothing found: every entry on PATH exists and belongs to this user, and push delivery has not
            failed.
          </p>
        ) : (
          <ul className="flex min-w-0 flex-col gap-3">
            {data.health.environment.map((issue) => (
              <li key={`${issue.kind}:${issue.detail}`} className="flex min-w-0 flex-col gap-0.5">
                {/* A path is one token with nothing to wrap at, and <main> clips. */}
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span className="text-meta text-ink-muted">{issue.kind}</span>
                  <span className="min-w-0 text-body break-words text-ink">{issue.detail}</span>
                </span>
                {/* The fix travels with the finding. */}
                <span className="min-w-0 text-meta break-words text-ink-muted">{issue.fix}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-body font-semibold text-ink">The watch clock</h3>
        {watches ? (
          <>
            <KeyValue
              items={[
                ['Armed', watches.open ? 'yes' : 'no'],
                ['Passes', String(watches.passes)],
                ['Refs watched', String(watches.asked.length)],
              ]}
            />
            {watches.asked.length ? (
              <Disclosure label="The refs" count={watches.asked.length}>
                <ul className="mt-2 flex min-w-0 flex-col gap-0.5 font-mono text-meta wrap-anywhere text-ink-muted">
                  {watches.asked.map((ref) => (
                    <li key={ref}>{ref}</li>
                  ))}
                </ul>
              </Disclosure>
            ) : null}
          </>
        ) : (
          // `null` is a read that FAILED, so it knows nothing about what is parked.
          <p className="text-body text-ink-muted">
            The watch clock did not answer, so this console cannot say what is parked on a ref.
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <h3 className="text-body font-semibold text-ink">Metrics</h3>
        {metricsFailure ? (
          <Banner severity="error" data-testid="metrics-failed">
            {metricsFailure}
          </Banner>
        ) : (
          <p className="max-w-(--measure) text-meta text-ink-muted">
            {plural(data.metrics.length, 'family', 'families')}, as{' '}
            <a className={LINK} href={consolePath('/api/metrics')}>
              /api/metrics
            </a>{' '}
            renders them now: a snapshot, not a history. What this console does keep over time is under Over
            time, above.
          </p>
        )}
        <div className="flex min-w-0 flex-col gap-5">
          {data.metrics.map((family) => (
            <Family key={family.name} family={family} />
          ))}
        </div>
      </div>
      {data.notes.length ? (
        <ul className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
          {data.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default function HealthSection(_props: { route: Route }) {
  const retirements = useRetirements();
  return (
    <div className="flex min-w-0 flex-col divide-y divide-rule" data-testid="health">
      <HealthQuestion id="runtime" title="This console’s runtime">
        <RuntimeStrip />
      </HealthQuestion>
      <HealthQuestion id="series" title="Over time" testId="health-series">
        <OverTime />
      </HealthQuestion>
      <HealthQuestion id="doctor" title="Doctor">
        <Doctor />
      </HealthQuestion>
      <HealthQuestion id="process" title="This process">
        <ThisProcess />
      </HealthQuestion>
      {retirements.length > 0 && (
        <HealthQuestion id="retirements" title="Retired credentials" testId="retirements">
          <ul className="flex min-w-0 flex-col gap-2">
            {retirements.map((row) => (
              <li key={row.id} className="flex min-w-0 flex-col gap-0.5">
                <span className="text-body text-ink">{row.name}</span>
                <RetirementEvidence entitlement={row.entitlement} />
              </li>
            ))}
          </ul>
        </HealthQuestion>
      )}
      <HealthQuestion id="ceiling" title="Automatic starts this hour">
        <CeilingCounters />
      </HealthQuestion>
      <HealthQuestion id="strays" title="Stray consoles">
        <StrayConsoleList />
      </HealthQuestion>
      <HealthQuestion id="bundle" title="The bundle">
        <TheBundle />
      </HealthQuestion>
      <HealthQuestion id="bundle-health" title="Environment, the watch clock and metrics">
        <BundleHealth />
      </HealthQuestion>
    </div>
  );
}
