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
  PageError,
  SectionHeading,
  Spinner,
} from '@/components/ui';
// The charts live in their own module, not the kit: `charts.tsx` owns the
// figure/mark split and the one legal colour vocabulary, and importing from
// there is what keeps `CHART_FIGURES` a closed set.
import { BarList, ChartNumbers } from '@/components/charts';
import { api, type MetricFamily } from '@/lib/api';
import { useDebugBundle } from '@/lib/queries';
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

export default function HealthSection(_props: { route: ViewProps['route'] }) {
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
