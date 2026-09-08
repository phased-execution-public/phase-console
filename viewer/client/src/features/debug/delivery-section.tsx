/**
 * The delivery ledger — what happened to each announcement, per device.
 *
 * The vocabulary is `shared/ops-vocab.js` `DELIVERY_OUTCOMES` and the meanings
 * are Phase 2's register table, rendered here rather than restated: this page
 * and that document are one contract, and a fifth spelling of "what `sent`
 * means" is how the two drift.
 *
 * The word this page exists to keep honest is `sent`. It means the push
 * service accepted the message — not that anybody saw it, because the browser
 * and the operating system are two more yeses after that one. A ledger that
 * renders `sent` as a green tick is a ledger that lies about the one thing an
 * operator would use it for.
 */

import { MailCheck } from 'lucide-react';

import type { ViewProps } from '@/app/router';
import {
  Badge,
  Banner,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  DataTable,
  Empty,
  PageError,
  RelativeTime,
  SectionHeading,
  Spinner,
  Tile,
  type Column,
} from '@/components/ui';
import type { DebugEntry } from '@/lib/api';
import { useDebugIndex } from '@/lib/queries';
import { debugHref } from './routes';

/**
 * What each outcome means, and whether it counts as delivered.
 *
 * The third column is the one that matters: `quiet` is HELD — the device was
 * inside its own quiet hours and nothing was attempted, on purpose — so it is
 * neither a success nor a failure, and folding it into either would misreport
 * a feature working exactly as it was configured.
 */
const OUTCOMES: { id: string; means: string; counts: string; tone: 'ok' | 'bad' | 'neutral' }[] = [
  { id: 'sent', means: 'The push service accepted it — not “you saw it”.', counts: 'delivered', tone: 'ok' },
  { id: 'throttled', means: '429 with a retry-after; not resent.', counts: 'not delivered', tone: 'bad' },
  {
    id: 'failed',
    means: 'A service rejection. Counts toward the 15-strike device drop.',
    counts: 'not delivered',
    tone: 'bad',
  },
  {
    id: 'gone',
    means: '404/410 — the subscription is dead; the device row is dropped at once.',
    counts: 'not delivered',
    tone: 'bad',
  },
  {
    id: 'quiet',
    means: 'The device was inside its quiet hours; nothing attempted, on purpose.',
    counts: 'held',
    tone: 'neutral',
  },
];

/**
 * What an ABSENT `detail` means, per outcome.
 *
 * A `quiet` or `sent` row carries no detail because nothing was rejected — and
 * printing "The service gave no reason" over those implies a service was asked
 * and stayed silent, which for `quiet` is the opposite of what happened.
 */
const SILENCE: Record<string, string> = {
  sent: 'Accepted by the push service. Whether the browser and the OS showed it are two more yeses this console never sees.',
  quiet: 'Nothing was attempted: the device was inside its quiet hours.',
};

const TONE_OF: Record<string, 'ok' | 'bad' | 'neutral' | 'wait'> = {
  sent: 'ok',
  quiet: 'neutral',
  throttled: 'wait',
  failed: 'bad',
  gone: 'bad',
};

const columns: Column<DebugEntry>[] = [
  {
    id: 'at',
    head: 'When',
    priority: 2,
    min: 120,
    cell: (row) => (row.at ? <RelativeTime at={row.at} /> : <span className="text-ink-faint">undated</span>),
  },
  {
    id: 'outcome',
    head: 'Outcome',
    identity: true,
    priority: 1,
    min: 110,
    cell: (row) => {
      const outcome = row.event.replace(/^delivery\./, '');
      return (
        <Badge tone={TONE_OF[outcome] ?? 'neutral'} size="sm">
          {outcome}
        </Badge>
      );
    },
  },
  {
    id: 'device',
    head: 'Device',
    priority: 2,
    min: 120,
    cell: (row) => String((row.data as { label?: string } | undefined)?.label ?? '—'),
  },
  {
    id: 'category',
    head: 'Category',
    priority: 3,
    min: 100,
    cell: (row) => String((row.data as { category?: string } | undefined)?.category ?? '—'),
  },
  {
    id: 'what',
    head: 'Announcement',
    flex: true,
    priority: 1,
    min: 200,
    card: 'title',
    cell: (row) => <span className="text-xs">{row.text}</span>,
  },
];

export default function DeliverySection(_props: { route: ViewProps['route'] }) {
  // The delivery source alone: this is a ledger, not the log explorer with a
  // filter pre-set, and asking for one source is what keeps it cheap.
  const { data, isPending, error, refetch } = useDebugIndex({ source: ['delivery'], limit: 500 });

  if (isPending)
    return (
      <div className="grid place-items-center py-16">
        <Spinner />
      </div>
    );
  if (error) return <PageError error={error} retry={() => void refetch()} />;
  if (!data) return null;

  const rows = data.entries;
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const outcome = row.event.replace(/^delivery\./, '');
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }

  return (
    <div className="flex flex-col gap-3">
      {/* The window is capped twice — the store's retained announcements, then
          this read's row limit — and the tiles below count only what arrived.
          The Logs section renders this same flag; a ledger that quietly totals
          a slice is the one that gets quoted. */}
      {data.truncated ? (
        <Banner severity="warn" data-testid="delivery-truncated">
          More delivery rows matched than were read, so the counts below are over the newest {rows.length} of
          them.{' '}
          <a className="text-action underline" href={debugHref('logs', { source: ['delivery'] })}>
            Open them in the log explorer
          </a>
          {' to filter.'}
        </Banner>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {OUTCOMES.map((outcome) => (
          <Tile
            key={outcome.id}
            label={outcome.id}
            // The SERVER's per-outcome count when it sent one: it counts over
            // the whole retained ledger, while the rows below are a page of it.
            value={String(data.delivery?.outcomes[outcome.id] ?? counts[outcome.id] ?? 0)}
            hint={outcome.counts}
          />
        ))}
      </div>

      {data.delivery ? (
        <p className="text-2xs text-ink-faint" data-testid="delivery-tally">
          {`${data.delivery.announcements} announcement${data.delivery.announcements === 1 ? '' : 's'} `}
          {`reached ${data.delivery.devices} device${data.delivery.devices === 1 ? '' : 's'}. `}
          {/* The figure that answers "did anybody get told" — and it is NOT
              the `failed` count: a fan-out where one device took it is
              delivered, and one every device held as `quiet` was never
              attempted. The server owns that rule; this only renders it. */}
          <span className={data.delivery.undelivered ? 'text-ink' : undefined}>
            {`${data.delivery.undelivered} reached nobody.`}
          </span>
        </p>
      ) : null}

      {rows.length === 0 ? (
        <Empty
          icon={<MailCheck size={20} aria-hidden />}
          title="Nothing has been delivered to a device yet"
          body="A row appears here per device per announcement, once a browser has subscribed to push. Until then every announcement still lands in the inbox — the record is written before any delivery is attempted."
        />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(row, index) => `${row.at}|${row.event}|${index}`}
          label="Delivery ledger"
          // The row's own record under it — the service's rejection reason is
          // the whole answer to "why did this one not arrive", and it is too
          // long for a column that has to survive a phone.
          detail={(row) => {
            const meta = row.data as
              { detail?: string; notification?: string; urgent?: boolean; outcome?: string } | undefined;
            const outcome = meta?.outcome ?? row.event.replace(/^delivery\./, '');
            return (
              <div className="flex flex-col gap-1 text-2xs text-ink-muted">
                {/* Branching on the OUTCOME, not on whether a detail happens
                    to be present — see SILENCE. */}
                <span>{meta?.detail ?? SILENCE[outcome] ?? 'The service gave no reason.'}</span>
                <span className="font-mono">
                  {meta?.notification ?? '—'}
                  {meta?.urgent ? ' · urgent' : ''}
                </span>
              </div>
            );
          }}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>What each outcome means</CardTitle>
        </CardHeader>
        <CardBody>
          <SectionHeading as="h3" size="band">
            The ledger vocabulary
          </SectionHeading>
          <dl className="mt-2 flex flex-col gap-2 text-xs">
            {OUTCOMES.map((outcome) => (
              <div key={outcome.id} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
                <dt className="w-24 shrink-0">
                  <Badge tone={TONE_OF[outcome.id] ?? 'neutral'} size="sm">
                    {outcome.id}
                  </Badge>
                </dt>
                <dd className="text-ink-muted">
                  {outcome.means}
                  <span className="ml-1 text-ink-faint">{`(counts as ${outcome.counts})`}</span>
                </dd>
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}
