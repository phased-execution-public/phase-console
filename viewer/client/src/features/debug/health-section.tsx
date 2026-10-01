/**
 * Health — the environment, the watch clock, the metrics, and the bundle.
 *
 * Two of these three had a producer and no reader. `environmentReport()` wrote
 * its findings into `/api/state` and only the dashboard's health block ever
 * looked; `WatchScheduler.snapshot()` had a comment saying nothing read it yet.
 * `/api/metrics` had a Prometheus scraper and a LINK on the Insights page —
 * this is its first renderer.
 *
 * **Metrics here are a snapshot, and the page says so.** The console keeps no
 * time series: `/api/metrics` renders the current facts on every scrape, so
 * "the metrics over time" is a question for whatever scrapes it, not for this
 * page. The thing on this destination that genuinely IS a timeline is the run
 * journal, one section over. Drawing a fake axis over one sample would be the
 * exact kind of reassurance this destination exists not to give.
 */

import { useState } from 'react';
import { HeartPulse } from 'lucide-react';

import type { ViewProps } from '@/app/router';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  CopyButton,
  Disclosure,
  Empty,
  KeyValue,
  type KeyValueItem,
  Meter,
  PageError,
  SectionHeading,
  Spinner,
  field,
} from '@/components/ui';
import { cn } from '@/lib/cn';
// The charts live in their own module, not the kit: `charts.tsx` owns the
// figure/mark split and the one legal colour vocabulary, and importing from
// there is what keeps `CHART_FIGURES` a closed set.
import { BarList, ChartNumbers } from '@/components/charts';
import { OpsBadge } from '@/components/ui/status';
import { RetirementEvidence, hasRetirementStory } from '@/components/retirement-evidence';
import { api, type DoctorRow, type MetricFamily } from '@/lib/api';
import { bytes } from '@/lib/format';
import {
  useAccounts,
  useConsoleState,
  useDebugBundle,
  useDebugLevel,
  useDoctor,
  useSetDebugLevel,
} from '@/lib/queries';
import { useRuntime } from './runtime';
import { consolePath } from '@/lib/base';
import { debugHref } from './routes';

/** A family worth a bar chart has more than one labelled sample. */
function chartable(family: MetricFamily): boolean {
  return family.samples.length > 1 && family.samples.some((s) => Object.keys(s.labels).length > 0);
}

/** The label set as one readable string — `status="active" closed="0"`. */
function labelText(labels: Record<string, string>): string {
  const parts = Object.entries(labels).map(([key, value]) => `${key}=${value}`);
  return parts.length ? parts.join(' ') : '(no labels)';
}

function Family({ family }: { family: MetricFamily }) {
  // `name`, not `label`: `BarListItem` is the kit's shape and the numbers fold
  // renders it, so a second spelling here would be a second thing to keep true.
  const items = family.samples.map((sample) => ({
    name: labelText(sample.labels),
    value: sample.value,
  }));

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <SectionHeading as="h3" size="band">
          {family.name}
        </SectionHeading>
        <Badge tone="neutral" size="sm">
          {family.type}
        </Badge>
      </div>
      {family.help ? <p className="text-2xs text-ink-faint">{family.help}</p> : null}
      {chartable(family) ? (
        <BarList items={items} label={family.name} />
      ) : (
        <ul className="flex flex-col gap-0.5 font-mono text-2xs">
          {items.map((item) => (
            <li key={item.name} className="flex justify-between gap-3">
              <span className="truncate text-ink-muted">{item.name}</span>
              <span className="tabular-nums">{item.value}</span>
            </li>
          ))}
        </ul>
      )}
      {/* A figure's L3 is the table it was drawn from — design.md §8. A mark
          gets none, and the list above IS its own table, so only the charted
          families carry one. */}
      {chartable(family) ? (
        <ChartNumbers
          label={`${family.name} samples`}
          caption={family.help}
          columns={[
            { head: 'Labels', cell: (row) => row.name },
            { head: 'Value', align: 'end', cell: (row) => row.value },
          ]}
          rows={items}
          getRowKey={(row) => row.name}
        />
      ) : null}
    </div>
  );
}

/**
 * The console's own runtime, on screen before anything is asked for
 * (control-tower phase 29, #32 gap 4): the heap against the limit this console
 * chose, the event loop's delay, and how many event streams it is writing to.
 * #20 was a heap climbing to its limit twice in five minutes with no number
 * anyone could have been watching; these are those numbers.
 *
 * Landed FIRST in this file, at its top: phase 25 owns the rest of the section
 * and builds around the strip. It is a scrape every 15 s while the section is
 * open — never a history, which is why it says "as of".
 */
export function RuntimeStrip() {
  const { data, error, dataUpdatedAt } = useRuntime();
  const heap = data?.heapUsedBytes;
  const limit = data?.heapLimitBytes;
  const delay = data?.eventLoopDelaySeconds;
  return (
    <section
      aria-labelledby="runtime-strip-title"
      data-testid="runtime-strip"
      className="grid gap-x-4 gap-y-2 rounded border border-rule bg-surface p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]"
    >
      <h2 id="runtime-strip-title" className="text-xs font-medium text-ink sm:col-span-3">
        This console&rsquo;s runtime
      </h2>
      {error ? (
        <p className="text-2xs text-ink-muted sm:col-span-3">
          The runtime could not be read from <code>/api/metrics</code>: {error.message}
        </p>
      ) : (
        <>
          {heap !== undefined && limit ? (
            <Meter value={heap} max={limit} label="Heap" valueText={`${bytes(heap)} of ${bytes(limit)}`}>
              <p className="text-2xs text-ink-faint">
                Heap {bytes(heap)} of {bytes(limit)}
              </p>
            </Meter>
          ) : (
            <p className="text-2xs text-ink-faint">Heap: {data ? 'not reported' : 'reading…'}</p>
          )}
          <p className="text-2xs text-ink-faint">
            Event-loop delay{' '}
            <span className="font-mono tabular-nums text-ink">
              {delay !== undefined ? `${Math.round(delay * 1000)} ms` : '—'}
            </span>
          </p>
          <p className="text-2xs text-ink-faint">
            Event-stream clients{' '}
            <span className="font-mono tabular-nums text-ink">{data?.sseClients ?? '—'}</span>
          </p>
          {dataUpdatedAt ? (
            <p className="text-2xs text-ink-faint sm:col-span-3">
              As of {new Date(dataUpdatedAt).toLocaleTimeString()} — read every 15 s while this page is open.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

export default function HealthSection(props: { route: ViewProps['route'] }) {
  return (
    <div className="flex flex-col gap-3">
      <RuntimeStrip />
      <DoctorCard />
      <ProcessCard />
      <RetirementsCard />
      <HealthBody {...props} />
    </div>
  );
}

/**
 * The doctor's rows, worst first: the first BLOCKING failure leads — it is the
 * one to fix first, and the server names it — then the other failures, then
 * what passed, then what was not checked. The same probes a run's start
 * asks, so "why will this not start" is answerable before anyone presses Start.
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

function DoctorCard() {
  // The doctor shells out (`gh`, the CLI, the hooks), so it runs when asked —
  // the same rule as the bundle below — and a minute's answer is reused.
  const [asked, setAsked] = useState(false);
  const { data, isPending, error, refetch, isFetching } = useDoctor(asked);
  return (
    <Card data-testid="doctor">
      <CardHeader>
        <CardTitle>Doctor</CardTitle>
      </CardHeader>
      <CardBody>
        {!asked ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-ink-muted">
              The checks a run&rsquo;s start makes — accounts, credentials, the CLI, <code>gh</code>, the
              hooks — and the machine&rsquo;s own, as <code>phase-console doctor</code> prints them.
            </p>
            <Button size="sm" variant="action" onClick={() => setAsked(true)}>
              Run the doctor
            </Button>
          </div>
        ) : isPending ? (
          <div className="grid place-items-center py-6">
            <Spinner />
          </div>
        ) : error ? (
          <PageError error={error} retry={() => void refetch()} />
        ) : data ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink" data-testid="doctor-verdict">
              {data.ok
                ? 'Nothing blocks a start.'
                : `Blocked: ${data.firstFailing?.label ?? 'a check failed'} — fix that first.`}{' '}
              <span className="text-2xs text-ink-faint">
                As of <RelativeTimeText at={data.at} /> · CLI floor {data.cliFloor}
              </span>
            </p>
            <ul className="flex flex-col divide-y divide-rule" aria-label="Doctor checks">
              {doctorOrder(data.rows, data.firstFailing).map((row) => (
                <li
                  key={row.id}
                  data-testid="doctor-row"
                  data-row={row.id}
                  className="flex min-w-0 flex-col gap-0.5 py-1.5 sm:flex-row sm:items-baseline sm:gap-3"
                >
                  <span className="flex shrink-0 items-center gap-2 sm:w-44">
                    <OpsBadge vocab="probe" word={row.status} size="sm" />
                    <span className="text-sm text-ink">{row.label}</span>
                  </span>
                  <span className="min-w-0 text-xs break-words text-ink-muted">
                    {row.reason}
                    {row.status === 'fail' && !row.blocking ? ' (advisory — a start still goes ahead)' : ''}
                    {row.warnings?.length ? (
                      <span className="block text-2xs text-ink-faint">{row.warnings.join(' · ')}</span>
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
        ) : null}
      </CardBody>
    </Card>
  );
}

/** A plain time, for a line that must not tick. */
function RelativeTimeText({ at }: { at: string }) {
  const date = new Date(at);
  return <time dateTime={at}>{Number.isNaN(date.getTime()) ? at : date.toLocaleTimeString()}</time>;
}

/** How long a person's level change lasts before the console reverts it by itself. */
const LEVEL_TTL_MS = 30 * 60_000;

/**
 * This process: which generation of the docs it has read, when it booted,
 * the build it serves, the arguments node started with, a restart's update
 * while it runs — and how loud its own log is. All of it was on `/api/state`
 * with nothing drawing it.
 */
function ProcessCard() {
  const { data: state } = useConsoleState();
  const { data: level } = useDebugLevel();
  const setLevel = useSetDebugLevel();
  const restart = state?.restartUpdate ?? null;
  const items: KeyValueItem[] = [
    ['Generation', state?.generation !== undefined ? String(state.generation) : '—'],
    ['Booted', state?.bootedAt ? <RelativeTimeText at={state.bootedAt} /> : '—'],
    ['Serving build', state?.distRev ? state.distRev.slice(0, 8) : 'unstamped'],
    ['Node arguments', state?.execArgv?.length ? state.execArgv.join(' ') : 'none'],
  ];
  return (
    <Card data-testid="process">
      <CardHeader>
        <CardTitle>This process</CardTitle>
      </CardHeader>
      <CardBody>
        <KeyValue items={items} />
        <div className="mt-2">
          <CopyButton
            text={async () => JSON.stringify(await api.stateWith(['full']), null, 2)}
            label="Copy the whole state"
            copiedLabel="Copied the state"
          />
        </div>
        <p className="mt-2 text-2xs text-ink-faint">
          The generation counts the changes to the docs this console has read; a page whose generation is
          behind it is showing an older board.
        </p>
        <div className="mt-3 flex flex-col gap-1" data-testid="restart-update">
          <SectionHeading as="h3" size="band">
            Restart and update
          </SectionHeading>
          {restart ? (
            <p className="flex flex-wrap items-baseline gap-2 text-xs text-ink-muted">
              <OpsBadge vocab="restart" word={restart.state} size="sm" />
              <span>
                {restart.detail} — by {restart.by}, started <RelativeTimeText at={restart.startedAt} />
                {restart.finishedAt ? (
                  <>
                    , finished <RelativeTimeText at={restart.finishedAt} />
                  </>
                ) : null}
                {restart.expectedEnd ? (
                  <>
                    ; expected to end by <RelativeTimeText at={restart.expectedEnd} />
                  </>
                ) : null}
                {restart.lanes
                  ? `; waiting on ${restart.lanes} live lane${restart.lanes === 1 ? '' : 's'}`
                  : ''}
                {restart.plans?.length ? ` (${restart.plans.join(', ')})` : ''}
              </span>
            </p>
          ) : (
            <p className="text-xs text-ink-muted">No restart or update since this process booted.</p>
          )}
        </div>
        {level ? (
          <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="log-level">
            <SectionHeading as="h3" size="band">
              Log level
            </SectionHeading>
            <label className="sr-only" htmlFor="debug-level">
              This console&rsquo;s log level
            </label>
            <select
              id="debug-level"
              value={level.level}
              disabled={setLevel.isPending}
              className={cn(field, 'w-28')}
              onChange={(event) => setLevel.mutate({ level: event.target.value, ttlMs: LEVEL_TTL_MS })}
            >
              {level.levels.map((word) => (
                <option key={word} value={word}>
                  {word}
                </option>
              ))}
            </select>
            <span className="text-2xs text-ink-faint">
              {level.source === 'override' && level.until
                ? `changed here — reverts by itself at ${new Date(level.until).toLocaleTimeString()}`
                : 'as configured — a change here lasts 30 minutes'}
            </span>
            {level.source === 'override' ? (
              <Button size="sm" variant="ghost" onClick={() => setLevel.mutate(null)}>
                Revert now
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

/**
 * Every account whose credential was retired, or whose retirement a later
 * read contradicted — with what it stood on. Nothing when there is none, so
 * a healthy console does not carry an empty card.
 */
function RetirementsCard() {
  const { data } = useAccounts();
  const rows = [
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
  if (!rows.length) return null;
  return (
    <Card data-testid="retirements">
      <CardHeader>
        <CardTitle>Retired credentials</CardTitle>
      </CardHeader>
      <CardBody>
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id} className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-ink">{row.name}</span>
              <RetirementEvidence entitlement={row.entitlement} />
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function HealthBody(_props: { route: ViewProps['route'] }) {
  // Assembling a bundle reads every source and renders a metrics scrape, so it
  // is not paid on arrival — the reader asks for it.
  const [asked, setAsked] = useState(false);
  const { data, isPending, error, refetch } = useDebugBundle({}, asked);

  if (!asked) {
    return (
      <Empty
        icon={<HeartPulse size={20} aria-hidden />}
        title="Read the console’s own health"
        body="One pass over the environment doctor, the watch clock and every metric family — assembled on request, because it reads every source and renders a full metrics scrape."
        action={
          <Button variant="action" onClick={() => setAsked(true)}>
            Read health
          </Button>
        }
      />
    );
  }

  if (isPending)
    return (
      <div className="grid place-items-center py-16">
        <Spinner />
      </div>
    );
  if (error) return <PageError error={error} retry={() => void refetch()} />;
  if (!data) return null;

  const watches = data.health.watches;
  // The bundle records a failed scrape as a note rather than a 500, so the
  // Metrics card has to read the notes to know WHICH empty list it is holding.
  const metricsFailure = data.notes.find((note) => note.startsWith('Metrics could not be rendered'));

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader>
          <CardTitle>For an AI</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-sm text-ink-muted">
            One JSON snapshot of everything on this destination — versions, flags, health, the watch clock,
            every metric family, the recent log rows and the delivery tally. Secret-shaped runs and the
            operator’s home path are masked on the way out of the server, so it is safe to paste into a
            model’s context.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <CopyButton
              text={async () => JSON.stringify(await api.debugBundle({}), null, 2)}
              label="Copy for AI"
              copiedLabel="Copied the bundle"
            />
            <Button asChild size="sm">
              <a href={consolePath('/api/debug/bundle?download=1')} download>
                Download bundle
              </a>
            </Button>
            <span className="text-2xs text-ink-faint">{`schema ${data.schema} v${data.version}`}</span>
          </div>
          {/*
            A SECOND bundle, and deliberately a second button. This one is the
            console — every plan, the health rows, the metrics, the newest log
            lines. The other is one RUN: its journal, its transcript, its task
            ledgers, its outcomes, its locks, its git trace. "Is this console
            well" and "why did phase 7 park on Tuesday" are different questions
            and the first bundle answered only the first.
          */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="ghost">
              <a href={debugHref('journal')}>Export one run…</a>
            </Button>
            <span className="text-2xs text-ink-faint">
              One run’s own files, redacted, as a tar.gz — pick it on Journal, or run{' '}
              <code>phase-console diagnostics --run &lt;id&gt;</code> with the console down.
            </span>
          </div>
          {data.notes.length ? (
            <ul className="mt-3 flex flex-col gap-1 text-2xs text-ink-faint">
              {data.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Environment</CardTitle>
        </CardHeader>
        <CardBody>
          {data.health.environment.length === 0 ? (
            <p className="text-sm text-ink-muted">
              The environment doctor found nothing: every entry on <code>PATH</code> exists and belongs to
              this user, and push delivery has not failed.
            </p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {data.health.environment.map((issue) => (
                <li key={`${issue.kind}:${issue.detail}`} className="flex min-w-0 flex-col gap-0.5">
                  {/* `min-w-0 break-words`, and the row wraps: `issue.detail` is
                      a filesystem PATH the app did not write (`PATH entry does
                      not exist: /very/long/…`), which is one token with nothing
                      to wrap at, and the `Badge` beside it is `whitespace-nowrap`
                      and will not give. Unwrapped, the row's min-content is
                      badge + whole path — and `<main>` CLIPS rather than
                      scrolls, so the path simply ended off the right edge with
                      no scrollbar anywhere to reach it. Insights' copy of this
                      same list was fixed for this in Phase 9; Debug's newer one
                      shipped without it. */}
                  <span className="flex min-w-0 flex-wrap items-start gap-2">
                    <Badge tone="wait" size="sm">
                      {issue.kind}
                    </Badge>
                    <span className="min-w-0 break-words text-ink">{issue.detail}</span>
                  </span>
                  {/* The fix travels with the finding — an issue with no errand
                      beside it is a complaint. It quotes paths too. */}
                  <span className="min-w-0 text-xs break-words text-ink-muted">{issue.fix}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>The watch clock</CardTitle>
        </CardHeader>
        <CardBody>
          {watches ? (
            <>
              <KeyValue
                items={[
                  ['Armed', watches.open ? 'yes' : 'no'],
                  ['Passes', String(watches.passes)],
                  ['Refs being watched', String(watches.asked.length)],
                ]}
              />
              {watches.asked.length ? (
                <Disclosure label="Show the refs" className="mt-3">
                  <ul className="flex flex-col gap-0.5 font-mono text-2xs text-ink-muted">
                    {watches.asked.map((ref) => (
                      <li key={ref}>{ref}</li>
                    ))}
                  </ul>
                </Disclosure>
              ) : null}
            </>
          ) : (
            // `null`'s only producer is the `catch` in `debug/deps.ts` — so
            // the page knows the read FAILED and knows nothing about what is
            // parked. "Nothing is parked on a ref." was a claim it cannot
            // make, printed every time it appeared.
            <p className="text-sm text-ink-muted">
              The watch clock did not answer, so this console cannot say what is parked on a ref.
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metrics</CardTitle>
        </CardHeader>
        <CardBody>
          {/* An empty list has two causes and they are opposite: a console
              with nothing to report, and a scrape that threw. The bundle
              records the second as a note rather than a 500, so printing
              "0 families … right now" over it is a present-tense positive
              claim about a read that failed. */}
          {metricsFailure ? (
            <Banner severity="error" data-testid="metrics-failed">
              {metricsFailure}
            </Banner>
          ) : (
            <p className="text-xs text-ink-muted">
              {`${data.metrics.length} families, as `}
              <a className="text-action underline" href={consolePath('/api/metrics')}>
                <code>/api/metrics</code>
              </a>
              {' renders them right now. This console keeps no history — a chart over time is a question '}
              for whatever scrapes that endpoint, and the timeline on this destination is the run journal.
            </p>
          )}
          <div className="mt-4 flex flex-col gap-5">
            {data.metrics.map((family) => (
              <Family key={family.name} family={family} />
            ))}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
