/**
 * Logs ▸ Delivery — what happened to each announcement, per device.
 *
 * ```
 * 42 announcements; 2 reached no device.
 * ● Sent 30   ● Quiet hours 6   ● Failed 4   ● Throttled 1   ● Device gone 1
 * [Find a title]  Filter  Group  Columns  ⋯  Everything
 * Announcement                          Outcome        Device     Category    When
 * › What each outcome means (7)
 * ```
 *
 * The words are `shared/status-model.js`'s `delivery` rows and the meanings
 * the register's, drawn here rather than restated. The word this page keeps
 * honest is Sent: the push service accepted the message — not that anybody
 * saw it, because the browser and the operating system are two more yeses
 * after that one. And Quiet hours is HELD, neither a success nor a failure:
 * the device was inside its own quiet hours and nothing was attempted, on
 * purpose.
 */

import { useMemo } from 'react';
import type { DeliveryOutcome } from '@shared/ops-vocab.js';
import type { DebugEntry } from '@/data/api';
import { useDebugIndex } from '@/data/logs';
import { plural } from '@/lib/format';
import type { Route } from '@/shell/routes';
import { Banner, Button, RelativeTime, Skeleton, useEverything } from '@/ui';
import { Disclosure } from '@/ui/disclosure';
import type { Column } from '@/ui/grid/column';
import { Grid } from '@/ui/grid/grid';
import { OpsStatus } from '@/ui/status';
import { logsSectionHref } from './routes';

type Outcome = DeliveryOutcome;

/**
 * What each outcome means, and how it counts. The order is the ledger's: what
 * reached a device first, then what was held, then what did not.
 */
export const OUTCOMES: readonly { id: Outcome; means: string; counts: string }[] = [
  { id: 'sent', means: 'The push service accepted it — not “you saw it”.', counts: 'delivered' },
  {
    id: 'quiet',
    means: 'The device was inside its quiet hours; nothing was attempted, on purpose.',
    counts: 'held',
  },
  { id: 'throttled', means: 'A 429 with a retry-after; not resent.', counts: 'not delivered' },
  {
    id: 'failed',
    means: 'The push service refused it. Fifteen in a row drop the device.',
    counts: 'not delivered',
  },
  {
    id: 'gone',
    means: 'A 404 or 410: the subscription is dead, and the device is dropped at once.',
    counts: 'not delivered',
  },
  {
    id: 'skipped',
    means: 'Nothing could be seen delivered — the process exited first, or there was nowhere to send it.',
    counts: 'not delivered',
  },
  {
    id: 'no-device',
    means: 'No device was there to take it — none subscribed, or none to this category.',
    counts: 'not delivered',
  },
];

const KNOWN = new Set<string>(OUTCOMES.map((o) => o.id));

/**
 * What an ABSENT `detail` means, per outcome: a Sent or a Quiet hours row
 * carries none because nothing was refused, and "the service gave no reason"
 * over those would imply a service was asked and stayed silent.
 */
const SILENCE: Readonly<Partial<Record<Outcome, string>>> = {
  sent: 'Accepted by the push service. Whether the browser and the OS showed it are two more yeses this console never sees.',
  quiet: 'Nothing was attempted: the device was inside its quiet hours.',
};

const outcomeOf = (row: DebugEntry): string => row.event.replace(/^delivery\./, '');
const meta = (row: DebugEntry) =>
  (row.data ?? {}) as {
    label?: string;
    device?: string;
    category?: string;
    detail?: string;
    notification?: string;
    urgent?: boolean;
    outcome?: string;
  };

/**
 * The announcement's own title. The server writes a delivery row's text as
 * `<device>: <outcome> — <detail> · <title>` (`server/debug/sources.ts`
 * `deliveryEntries`) — the explorer's one line — and its `data` carries every
 * part of that prefix but not the title. The prefix is rebuilt from `data` and
 * taken off only when it matches to the character, so a text written any
 * other way is shown whole, never cut in the wrong place. Outcome, device and
 * detail have columns and the row's fold of their own; the Announcement
 * column is the announcement.
 */
export function deliveryTitleOf(row: DebugEntry): string {
  const facts = meta(row);
  const prefix = `${facts.label || facts.device}: ${facts.outcome ?? outcomeOf(row)}${facts.detail ? ` — ${facts.detail}` : ''} · `;
  return row.text.startsWith(prefix) && row.text.length > prefix.length
    ? row.text.slice(prefix.length)
    : row.text;
}

/** An outcome as its dot and word — a word the vocabulary lacks as itself. */
function OutcomeWord({ outcome }: { outcome: string }) {
  return KNOWN.has(outcome) ? (
    <OpsStatus vocab="delivery" word={outcome as Outcome} />
  ) : (
    <span className="text-meta text-ink">{outcome}</span>
  );
}

const COLUMNS: Column<DebugEntry>[] = [
  {
    id: 'what',
    head: 'Announcement',
    identity: true,
    flex: true,
    min: 220,
    priority: 1,
    card: 'title',
    cell: (row) => <span className="break-words">{deliveryTitleOf(row)}</span>,
    value: deliveryTitleOf,
    filter: 'text',
  },
  {
    id: 'outcome',
    head: 'Outcome',
    min: 132,
    priority: 1,
    card: 'meta',
    cell: (row) => <OutcomeWord outcome={outcomeOf(row)} />,
    value: outcomeOf,
    filter: 'facet',
    groupable: true,
  },
  {
    id: 'device',
    head: 'Device',
    min: 120,
    priority: 2,
    cell: (row) => meta(row).label ?? 'none named',
    value: (row) => meta(row).label,
    filter: 'facet',
    groupable: true,
  },
  {
    id: 'category',
    head: 'Category',
    // `usage-climbing`, the longest category, broke at its hyphen at 112.
    min: 144,
    priority: 3,
    cell: (row) => meta(row).category ?? 'none',
    value: (row) => meta(row).category,
    filter: 'facet',
    groupable: true,
  },
  {
    id: 'at',
    head: 'When',
    min: 128,
    priority: 2,
    card: 'meta',
    cell: (row) => (row.at ? <RelativeTime at={row.at} /> : 'undated'),
    value: (row) => row.at,
  },
];

/** A row's own record, under it: the refusal is the whole answer to "why did this one not arrive". */
function DeliveryDetail({ row }: { row: DebugEntry }) {
  const facts = meta(row);
  const outcome = (facts.outcome ?? outcomeOf(row)) as Outcome;
  return (
    <div className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
      <span className="break-words">{facts.detail ?? SILENCE[outcome] ?? 'The service gave no reason.'}</span>
      <span className="font-mono wrap-anywhere">
        {facts.notification ?? 'no notification id'}
        {facts.urgent ? ', urgent' : ''}
      </span>
    </div>
  );
}

export default function DeliverySection(_props: { route: Route }) {
  // The delivery source alone: a ledger, not the explorer with a filter set,
  // and asking for one source is what keeps it cheap.
  const { data, error, refetch } = useDebugIndex({ source: ['delivery'], limit: 500 });
  const everything = useEverything('logs-delivery');
  const rows = useMemo(() => data?.entries ?? [], [data]);

  // The SERVER's count when it sent one — over the whole retained ledger,
  // where the rows are a page of it — else what arrived.
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const row of rows) out[outcomeOf(row)] = (out[outcomeOf(row)] ?? 0) + 1;
    return data?.delivery?.outcomes ?? out;
  }, [rows, data]);

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
        The delivery ledger could not be read: {error.message}
      </Banner>
    );
  }
  if (!data) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="Reading the delivery ledger">
        <Skeleton className="h-6 max-w-md" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  const tally = data.delivery;
  const shown = OUTCOMES.filter((o) => everything.on || (counts[o.id] ?? 0) > 0);

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="delivery">
      {tally && tally.announcements > 0 ? (
        <p className="max-w-(--measure) text-body text-ink" data-testid="delivery-tally">
          {plural(tally.announcements, 'announcement')};{' '}
          {/* The figure that answers "did it reach anything" — NOT the failed
              count: a fan-out one device took is delivered, and one every
              device held as quiet was never attempted. The server's rule.
              Reached is a push service's yes, never a person's (Sent, above),
              and the tally's `devices` is every device the ledger NAMES — the
              no-device row's placeholder among them — so it is not a count of
              devices reached and this sentence does not say one. */}
          {tally.undelivered === 0
            ? 'none went undelivered.'
            : tally.undelivered === tally.announcements
              ? 'none reached a device.'
              : `${tally.undelivered.toLocaleString()} reached no device.`}
        </p>
      ) : null}
      {shown.length > 0 && (
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1" data-testid="delivery-counts">
          {shown.map((outcome) => (
            <span key={outcome.id} className="inline-flex items-baseline gap-1.5" title={outcome.means}>
              <OpsStatus vocab="delivery" word={outcome.id} />
              <span className="tnum text-meta text-ink">{(counts[outcome.id] ?? 0).toLocaleString()}</span>
            </span>
          ))}
        </p>
      )}
      {data.truncated && (
        <Banner severity="warn" data-testid="delivery-truncated">
          More delivery rows matched than were read, so the counts are over the newest {rows.length} of them.{' '}
          <a
            className="tap-line whitespace-nowrap text-ink underline decoration-ink-faint underline-offset-2"
            href={logsSectionHref('logs', { source: ['delivery'] })}
          >
            Open them in the explorer
          </a>
        </Banner>
      )}

      <Grid
        label="Delivery ledger"
        columns={COLUMNS}
        rows={rows}
        getRowKey={(row, index) => `${row.at}|${row.event}|${index}`}
        tableId="logs-delivery"
        // `Search by announcement` was cut at every width; the search reads
        // the title, and says so in a word that fits.
        toolbar={{ placeholder: 'Find a title' }}
        everything={everything}
        virtual
        detail={(row) => <DeliveryDetail row={row} />}
        empty="Nothing has been delivered to a device yet: a row appears per device per announcement once a browser subscribes to push."
      />

      <Disclosure label="What each outcome means" count={OUTCOMES.length}>
        <dl className="mt-2 flex min-w-0 flex-col gap-2">
          {OUTCOMES.map((outcome) => (
            <div key={outcome.id} className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:gap-3">
              <dt className="shrink-0 sm:w-36">
                <OpsStatus vocab="delivery" word={outcome.id} />
              </dt>
              <dd className="min-w-0 text-body text-ink-muted">
                {outcome.means} <span className="text-meta">Counts as {outcome.counts}.</span>
              </dd>
            </div>
          ))}
        </dl>
      </Disclosure>
    </div>
  );
}
