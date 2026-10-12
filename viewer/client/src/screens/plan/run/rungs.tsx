/**
 * What the ladder tried on this run (7.0, quiet-console phase 11; the rung
 * table of the 6.x ledger card, zero-touch phase 19 and control-tower phase 24).
 *
 * ```
 * 3 rungs, $0.75 in all, already inside the sessions’ costs.
 * Rung                  Driven by               Outcome       Why          Situation            Cost
 * P2 switch-account     The console drives it   ● Failed      The machine  resource-wall:auth   $0.75
 * P3 resume-own-session The console drives it   ○ Withdrawn   Never ran    crashed              $0.00
 * ```
 *
 * One row per `phase.rung-settled` line of the run's ledger: the phase and the
 * vehicle the rung climbed, who drives that vehicle (the ladder table's
 * drivability column — how, on hover), how it settled and why, the situation
 * it was climbing and what its boarded session spent. The outcome and the
 * cause are status words through the family, so `withdrawn` (a lane that never
 * spawned, #16) reads as its own settled word and never as a failure. When it
 * settled, its note and who climbed it are the Everything columns, one press
 * away on every row.
 *
 * A rung's cost is its session's, which the session ledger already counts, so
 * the total is said beside it and never added to anything.
 *
 * The grid, not a hand-made list: one column array gives the table on a desk,
 * the folded cut on a narrow one and a record per rung on a phone. It asks for
 * no toolbar, no group and no window, so it never fetches the row engine — a
 * fold costs nothing it does not draw.
 */

import { RUNG_DRIVER_LABELS, VEHICLE_DRIVERS } from '@shared/ladder-model.js';
import type { LedgerRung, RunLedger } from '@/data/api';
import { plural } from '@/lib/format';
import { Money, Mono, RelativeTime } from '@/ui';
import type { Column } from '@/ui/grid/column';
import { Grid } from '@/ui/grid/grid';
import { OpsStatus, type WordOf } from '@/ui/status';

/** The owner's words, read by any key the wire may carry. */
const DRIVER_LABELS: Readonly<Record<string, string | undefined>> = RUNG_DRIVER_LABELS;
const VEHICLES: Readonly<Record<string, { how: string } | undefined>> = VEHICLE_DRIVERS;

/** Sentence case for a label the vocabulary writes to run on inside a sentence. */
const upper = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1);

/** A fact the settlement does not carry — said as a quiet dash, with why on hover. */
const none = (why: string) => (
  <span className="text-ink-faint" title={why}>
    —
  </span>
);

const COLUMNS: Column<LedgerRung>[] = [
  {
    id: 'rung',
    head: 'Rung',
    identity: true,
    flex: true,
    priority: 1,
    // "P12 reboard-resume-brief", the longest vehicle, on one line.
    min: 200,
    card: 'title',
    value: (rung) => `${rung.phase != null ? `P${rung.phase} ` : ''}${rung.rung}`,
    cell: (rung) => (
      <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-2">
        {rung.phase != null && <span className="text-meta text-ink-muted tnum">P{rung.phase}</span>}
        <Mono value={rung.rung} className="wrap-anywhere text-ink" />
      </span>
    ),
  },
  {
    id: 'driver',
    head: 'Driven by',
    priority: 2,
    min: 200,
    value: (rung) => rung.driver,
    cell: (rung) => {
      const label = rung.driver ? (DRIVER_LABELS[rung.driver] ?? rung.driver) : null;
      if (!label) return none('This build does not know who drives this vehicle.');
      return (
        <span className="break-words text-meta" title={VEHICLES[rung.rung]?.how} data-testid="rung-driver">
          {upper(label)}
        </span>
      );
    },
  },
  {
    id: 'outcome',
    head: 'Outcome',
    priority: 1,
    min: 144,
    card: 'meta',
    value: (rung) => rung.outcome,
    cell: (rung) => (
      <OpsStatus vocab="rung" word={rung.outcome as WordOf<'rung'>} data-testid="rung-outcome" />
    ),
  },
  {
    id: 'cause',
    head: 'Why',
    priority: 2,
    min: 128,
    value: (rung) => rung.cause ?? null,
    cell: (rung) =>
      rung.cause ? (
        <OpsStatus vocab="rungCause" word={rung.cause as WordOf<'rungCause'>} data-testid="rung-cause" />
      ) : (
        none('This settlement names no cause.')
      ),
  },
  {
    id: 'situation',
    head: 'Situation',
    priority: 3,
    min: 176,
    value: (rung) => rung.situation || null,
    cell: (rung) =>
      rung.situation ? (
        <Mono value={rung.situation} className="wrap-anywhere" />
      ) : (
        none('No situation was written.')
      ),
  },
  {
    id: 'cost',
    head: 'Cost',
    priority: 2,
    min: 88,
    align: 'end',
    card: 'meta',
    value: (rung) => rung.costUsd,
    cell: (rung) => <Money usd={rung.costUsd} />,
  },

  /* ---- Everything ---- */
  {
    id: 'at',
    head: 'Settled',
    min: 120,
    everything: true,
    value: (rung) => rung.at,
    cell: (rung) => <RelativeTime at={rung.at} live={false} />,
  },
  {
    id: 'note',
    head: 'Note',
    min: 200,
    everything: true,
    value: (rung) => rung.note,
    cell: (rung) =>
      rung.note ? <span className="break-words">{rung.note}</span> : none('No note was written.'),
  },
  {
    id: 'by',
    head: 'Climbed by',
    min: 120,
    everything: true,
    value: (rung) => rung.by,
    cell: (rung) => (rung.by ? <Mono value={rung.by} /> : none('The settlement names no actor.')),
  },
];

/** The rungs the run's ledger settled, or one line saying the ladder has not climbed. */
export function RunRungs({ ledger }: { ledger: RunLedger | undefined }) {
  if (!ledger) {
    return (
      <p data-testid="run-rungs" data-state="unread" className="text-meta text-ink-muted">
        The ledger has not answered yet.
      </p>
    );
  }
  const { rungs, totals } = ledger;
  if (!rungs.length) {
    return (
      <p data-testid="run-rungs" data-state="empty" className="text-body text-ink-muted">
        The ladder has not tried anything on this run.
      </p>
    );
  }
  return (
    <div data-testid="run-rungs" className="flex min-w-0 flex-col gap-2">
      <p data-testid="rungs-total" className="text-meta text-ink-muted">
        {plural(rungs.length, 'rung')}, <Money usd={totals.rungsUsd} /> in all, already inside the sessions’
        costs.
        {totals.truncated ? ' The journal read was cut, so early rungs may be missing.' : ''}
      </p>
      <Grid
        columns={COLUMNS}
        rows={rungs}
        getRowKey={(rung, index) => `${rung.at}|${rung.phase ?? ''}|${rung.rung}|${index}`}
        label="Rung settlements"
      />
    </div>
  );
}
