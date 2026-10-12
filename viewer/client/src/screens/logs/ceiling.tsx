/**
 * Logs ▸ Health, the start ceiling — how many sessions this console started
 * by itself in the sliding hour, and what they reported costing, against the
 * hour's limits; the MCP probe's own budget beside it (`GET /api/ceiling`).
 *
 * ```
 * There is room: the next automatic start goes ahead. Counted over a sliding 1h.
 * Work starts       ▬▬▬▬░░░░░░░░  12 of 40
 * Work spend        ▬░░░░░░░░░░░  $48.20 of $250.00
 * Work starts by    converge-relaunch 7, wait-clock 5
 * Probe starts      ▬▬▬░░░░░░░░░  6 of 24
 * Probe spend       $0.00, no limit
 * ```
 *
 * Past either limit the next automatic start is refused until the oldest
 * entry that limit counts leaves the hour, so what leads is which limit is
 * full and until when — the server's `full` and `until`, never a count
 * compared here. A person's own Start, Retry and Continue are never counted.
 */

import { Fragment } from 'react';
import { useStartCeiling, type CeilingWindow } from '@/data/machine';
import { duration, money } from '@/lib/format';
import { settingsHref } from '@/shell/routes';
import { Button, KeyValue, Mono, Skeleton } from '@/ui';
import { LoadMeter } from '@/ui/track/meter';

const LINK = 'tap-line whitespace-nowrap text-ink underline decoration-ink-faint underline-offset-2';

/** A moment later today, as a clock reads it. */
function Until({ at }: { at: string }) {
  const date = new Date(at);
  return (
    <time
      dateTime={at}
      className="tnum"
      title={Number.isNaN(date.getTime()) ? undefined : date.toLocaleString()}
    >
      {Number.isNaN(date.getTime()) ? at : date.toLocaleTimeString()}
    </time>
  );
}

/** One count against its limit: a meter when there is a limit, the count alone when 0 switches it off. */
function Against({
  value,
  limit,
  label,
  words,
  full,
}: {
  value: number;
  limit: number;
  label: string;
  words: (n: number) => string;
  full: boolean;
}) {
  const reading = limit > 0 ? `${words(value)} of ${words(limit)}` : `${words(value)}, no limit`;
  return (
    <LoadMeter
      value={value}
      max={limit}
      label={label}
      valueText={reading}
      reading={reading}
      paint={full ? 'needs-you' : 'running'}
      className="max-w-sm"
    />
  );
}

/** What stops the next start of one window, in a sentence — or null while there is room under both limits. */
function fullWords(window: CeilingWindow, what: string) {
  if (!window.full) return null;
  const count =
    window.full === 'startsPerHour'
      ? `${window.starts} starts against a limit of ${window.limits.startsPerHour}`
      : `${money(window.usd)} of session spend against a limit of ${money(window.limits.usdPerHour)}`;
  return (
    <>
      The {what} is full: {count}.{' '}
      {window.until ? (
        <>
          Nothing more starts by itself before <Until at={window.until} />.
        </>
      ) : null}
    </>
  );
}

const starts = (n: number) => String(n);

export function CeilingCounters() {
  const { data, error, refetch, isFetching } = useStartCeiling();
  if (error) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2" data-testid="ceiling">
        <p className="max-w-(--measure) text-body text-ink-muted">
          The start ceiling could not be read: {error.message || 'the read failed and said nothing.'}
        </p>
        <Button size="sm" variant="ghost" disabled={isFetching} onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!data) return <Skeleton className="h-40" data-testid="ceiling" aria-busy="true" />;

  const { work, probe } = data;
  const workFull = fullWords(work, 'work ceiling');
  const probeFull = fullWords(probe, 'MCP probe’s budget');
  const doors = Object.entries(work.doors);
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="ceiling">
      <p className="max-w-(--measure) text-body text-ink" data-testid="ceiling-verdict">
        {workFull ?? 'There is room: the next automatic start goes ahead.'}{' '}
        <span className="text-meta text-ink-muted">Counted over a sliding {duration(work.windowMs)}.</span>
      </p>
      {probeFull && (
        <p className="max-w-(--measure) text-body text-ink" data-testid="ceiling-probe-verdict">
          {probeFull}
        </p>
      )}
      <KeyValue
        items={[
          [
            'Work starts',
            <Against
              key="starts"
              value={work.starts}
              limit={work.limits.startsPerHour}
              label="Automatic starts this hour"
              words={starts}
              full={work.full === 'startsPerHour'}
            />,
          ],
          [
            'Work spend',
            <Against
              key="usd"
              value={work.usd}
              limit={work.limits.usdPerHour}
              label="Session spend this hour"
              words={money}
              full={work.full === 'usdPerHour'}
            />,
          ],
          [
            'Work starts by door',
            doors.length ? (
              <span key="doors" className="min-w-0">
                {doors.map(([door, count], index) => (
                  <Fragment key={door}>
                    {index > 0 && ', '}
                    <span className="whitespace-nowrap">
                      <Mono value={door} /> <span className="tnum text-ink">{count}</span>
                    </span>
                  </Fragment>
                ))}
              </span>
            ) : (
              'none this hour'
            ),
          ],
          [
            'Probe starts',
            <Against
              key="probe-starts"
              value={probe.starts}
              limit={probe.limits.startsPerHour}
              label="MCP probe starts this hour"
              words={starts}
              full={probe.full === 'startsPerHour'}
            />,
          ],
          [
            'Probe spend',
            <Against
              key="probe-usd"
              value={probe.usd}
              limit={probe.limits.usdPerHour}
              label="MCP probe spend this hour"
              words={money}
              full={probe.full === 'usdPerHour'}
            />,
          ],
        ]}
      />
      <p className="max-w-(--measure) text-meta text-ink-muted">
        Your own Start, Retry and Continue are never counted, and the MCP probe has a budget of its own.{' '}
        <a href={settingsHref('automation')} className={LINK}>
          Set the limits in Automation
        </a>
      </p>
    </div>
  );
}
