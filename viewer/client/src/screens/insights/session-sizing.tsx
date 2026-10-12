/**
 * What a session may spend — the caps a session runs under and where each
 * came from, the context it is sized to, and how many sessions a phase takes
 * (`GET /api/sizing`).
 *
 * A cap is measured, never chosen: a mode's p99 plus half again over this
 * console's own sessions once twenty stand in a fortnight, else the table
 * shipped with the release, measured the same way on the machine that cut it.
 * So every figure carries the server's own words for how it was reached, and
 * the cap table puts what this console measured beside what shipped — the gap
 * between the two is what a person reads it for. The table is folded the way
 * a figure's numbers are: the phase's two caps above it are the glance.
 *
 * Every figure is the server's (`./model`). A console with no plan directory
 * open has no sessions to measure, and says so in one line.
 */

import { ApiError } from '@/data/http';
import type { SessionSizing } from '@/data/runs';
import { sourceHref } from '@/shell/routes';
import { Button, Empty, RelativeTime, SectionHeading } from '@/ui';
import { Disclosure } from '@/ui/disclosure';
import type { Column } from '@/ui/grid/column';
import { Grid } from '@/ui/grid/grid';
import { NOT_SAID, sizingReading, type CapRow } from './model';
import { FactRows, InsightAnswer, InsightNote } from './parts';

const CAP_COLUMNS: readonly Column<CapRow>[] = [
  {
    id: 'cap',
    head: 'Cap',
    priority: 1,
    min: 140,
    flex: true,
    identity: true,
    card: 'title',
    value: (row) => row.cap,
    cell: (row) => <span className="break-words text-ink">{row.cap}</span>,
  },
  {
    id: 'measured',
    head: 'Measured here',
    priority: 1,
    min: 120,
    align: 'end',
    card: 'meta',
    value: (row) => row.measured,
    cell: (row) => <span className="tnum">{row.measured}</span>,
  },
  {
    id: 'shipped',
    head: 'Shipped',
    priority: 1,
    min: 96,
    align: 'end',
    card: 'meta',
    value: (row) => row.shipped,
    cell: (row) => <span className="tnum">{row.shipped}</span>,
  },
  {
    id: 'basis',
    head: 'How it was reached',
    min: 280,
    everything: true,
    value: (row) => row.basis,
    cell: (row) => <span className="break-words text-ink-muted">{row.basis ?? NOT_SAID}</span>,
  },
];

/** The read was refused: no plan directory is one line and the way to open one; anything else is the server's words. */
function SizingRefusal({ error, onRetry }: { error: Error; onRetry: () => void }) {
  if (error instanceof ApiError && error.status === 409) {
    return (
      <Empty
        data-testid="insights-sizing"
        title="No plan directory is open, so there are no sessions to measure."
        action={
          <Button size="sm" asChild>
            <a href={sourceHref()}>Choose a source directory</a>
          </Button>
        }
      />
    );
  }
  return (
    <Empty
      data-testid="insights-sizing"
      title={`The session caps could not be read: ${error.message || 'the read failed and said nothing.'}`}
      action={
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
}

export function SessionSizingPanel({
  sizing,
  error,
  onRetry,
  everything = false,
}: {
  sizing: SessionSizing | undefined;
  error: Error | null;
  onRetry: () => void;
  everything?: boolean;
}) {
  if (error) return <SizingRefusal error={error} onRetry={onRetry} />;
  if (!sizing) {
    return (
      <Empty
        data-testid="insights-sizing"
        title="No sizing answer: this console’s server predates it."
        action={
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    );
  }

  const reading = sizingReading(sizing);

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="insights-sizing">
      <div className="flex min-w-0 flex-col gap-3">
        <InsightAnswer>{reading.answer}</InsightAnswer>
        <FactRows facts={reading.phase} />
        <p className="max-w-(--measure) text-meta text-ink-muted" data-testid="sizing-derived">
          {sizing.derivedAt ? (
            <>
              Measured from this console’s own sessions <RelativeTime at={sizing.derivedAt} />.
            </>
          ) : (
            'This console has not read its own sessions yet, so every figure is the shipped one.'
          )}
        </p>
      </div>

      {reading.caps.length > 0 && (
        // Folded as a figure's numbers are: the phase's two caps above are the glance.
        <Disclosure label="The cap table" openLabel="Hide the cap table" count={reading.caps.length}>
          <Grid
            columns={CAP_COLUMNS}
            rows={reading.caps}
            getRowKey={(row) => row.id}
            label="Each session mode’s caps, measured here and shipped"
            tableId="insights-caps"
            everything={everything}
          />
        </Disclosure>
      )}

      <div className="flex min-w-0 flex-col gap-2">
        <SectionHeading as="h3">Context</SectionHeading>
        <FactRows facts={reading.context} />
        <InsightNote>{sizing.bootLine}</InsightNote>
        {everything && reading.peaks.length > 0 && (
          <div className="flex min-w-0 flex-col gap-1.5" data-testid="sizing-peaks">
            <h4 className="text-meta font-normal text-ink-muted">Each size’s peaks against the model</h4>
            <FactRows facts={reading.peaks} />
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <SectionHeading as="h3">Sessions per phase</SectionHeading>
        <FactRows facts={reading.sessions} />
      </div>

      {everything && (
        <InsightNote>
          A mode’s cap is its p99 plus half again over this console’s last two weeks of sessions once twenty
          stand; until then it is the table shipped with the release, measured the same way. A phase session
          is boarded under the phase’s two caps above.
        </InsightNote>
      )}
    </div>
  );
}
