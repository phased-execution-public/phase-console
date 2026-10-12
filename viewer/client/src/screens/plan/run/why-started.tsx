/**
 * Why this run started — every time it did (7.0, quiet-console phase 12; the
 * 6.x why-started card).
 *
 * ```
 * 2h ago   Resumed through converge-relaunch (fired by timer, past converge, start 2 of that door) — asked for by console over timer from local, on account default.
 * 3h ago   Started through operator — asked for by operator over api from local.
 * Sessions started beside the run  1
 * 1h ago   P4 A review session started through auto-reviewer — asked for by console over event from local.
 * What the start door resolved
 * Overridden by operator: announce.
 * Decision   State        Answered by   Value
 * gates      ● Answered   plan          delegated
 * accounts   ● OK   default has headroom
 * Credentials   held gh (require)
 * Delivery      no channel, acknowledged
 * ```
 *
 * The operator's question about a run nobody remembers pressing: which door
 * started it, what fired that door (a timer, a boot, an event), which guard
 * let it through and which start of that door this was, and who asked from
 * where. The words are the journal's own `run.start` lines, read back by the
 * ledger, so a resumed run lists each start rather than only the first —
 * newest first, the latest real start marked. Below them, the start door's
 * report: the decisions it resolved and where each answer came from, what its
 * probes found, and the override a person signed, if one did.
 *
 * One sentence per start, from one set of parts: `startLine` says it as text
 * and the row draws the same words with its ids in the machine face, so the
 * two cannot disagree.
 */

import type { LedgerStart, ResolvedManifest, RunLedger } from '@/data/api';
import { cn } from '@/lib/cn';
import { KeyValue, Mono, RelativeTime, SectionHeading } from '@/ui';
import type { Column } from '@/ui/grid/column';
import { Grid } from '@/ui/grid/grid';
import { OpsStatus, type WordOf } from '@/ui/status';

/** A sentence's words without its closing stop, so the line can add its own. */
const bare = (text: string): string => text.trim().replace(/[.!]+$/, '');

/** One start as the parts its sentence is made of; `door` and `account` are ids. */
function startParts(start: LedgerStart) {
  const what =
    start.event === 'run.start-refused'
      ? 'Refused at'
      : start.event === 'phase.session-start'
        ? `A ${start.mode ?? 'side'} session started through`
        : start.resumed
          ? 'Resumed through'
          : 'Started through';
  const fired = [
    start.trigger ? `fired by ${start.trigger}` : '',
    start.guard ? `past ${start.guard}` : '',
    start.counter != null ? `start ${start.counter} of that door` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return {
    what,
    door: start.door,
    fired: fired ? ` (${fired})` : '',
    said: ` — ${bare(start.said)}`,
    account: start.account,
    reason: start.reason ? `; ${bare(start.reason)}` : '',
  };
}

/** What a line says when it names no door. */
const NO_DOOR = 'a door this line does not name';

/** One start as one sentence: what happened, through which door, fired by what, and who. */
export function startLine(start: LedgerStart): string {
  const parts = startParts(start);
  return (
    `${parts.what} ${parts.door ?? NO_DOOR}${parts.fired}${parts.said}` +
    `${parts.account ? `, on account ${parts.account}` : ''}${parts.reason}.`
  );
}

/** `startLine`, drawn: the same words, the door and the account in the machine face, in the line's ink. */
function StartWords({ start, latest }: { start: LedgerStart; latest: boolean }) {
  const parts = startParts(start);
  const id = cn('wrap-anywhere', latest && 'text-ink');
  return (
    <>
      {parts.what} {parts.door ? <Mono value={parts.door} className={id} /> : NO_DOOR}
      {parts.fired}
      {parts.said}
      {parts.account && (
        <>
          , on account <Mono value={parts.account} className={id} />
        </>
      )}
      {parts.reason}.
    </>
  );
}

/**
 * Newest first: the latest start is the one a person asks about. The journal
 * is written in order, so two lines in the same instant keep the later first.
 */
const newestFirst = (starts: readonly LedgerStart[]): LedgerStart[] =>
  [...starts].reverse().sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));

function StartRow({ start, latest = false }: { start: LedgerStart; latest?: boolean }) {
  return (
    <li
      data-testid="why-started-start"
      data-event={start.event}
      data-latest={latest ? '' : undefined}
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 py-1"
    >
      <RelativeTime at={start.at} live={false} className="text-meta text-ink-faint" />
      <p
        data-testid={latest ? 'why-started-latest' : undefined}
        className={cn('min-w-0 break-words text-body', latest ? 'text-ink' : 'text-ink-muted')}
      >
        {start.phase != null && (
          <>
            <span className="text-meta text-ink-muted tnum">P{start.phase}</span>{' '}
          </>
        )}
        <StartWords start={start} latest={latest} />
      </p>
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * What the start door resolved
 * ------------------------------------------------------------------ */

type DecisionRow = ResolvedManifest['decisions'][number];

const DECISION_COLUMNS: Column<DecisionRow>[] = [
  {
    id: 'key',
    head: 'Decision',
    identity: true,
    priority: 1,
    // "verification.person-check", the longest key.
    min: 216,
    card: 'title',
    value: (row) => row.key,
    cell: (row) => <Mono value={row.key} className="wrap-anywhere text-ink" />,
  },
  {
    id: 'state',
    head: 'State',
    priority: 1,
    min: 136,
    card: 'meta',
    value: (row) => row.state,
    cell: (row) => <OpsStatus vocab="decision" word={row.state as WordOf<'decision'>} />,
  },
  {
    id: 'source',
    head: 'Answered by',
    priority: 2,
    min: 104,
    value: (row) => row.source,
    cell: (row) => <span className="break-words">{row.source}</span>,
  },
  {
    id: 'value',
    head: 'Value',
    flex: true,
    priority: 2,
    min: 200,
    value: (row) => row.value,
    cell: (row) =>
      row.value ? (
        <span className="line-clamp-2 break-words" title={row.value}>
          {row.value}
        </span>
      ) : (
        <span className="text-ink-faint" title="The door resolved no value for it.">
          —
        </span>
      ),
  },

  /* ---- Everything ---- */
  {
    id: 'owner',
    head: 'Owner',
    min: 104,
    everything: true,
    value: (row) => row.owner,
    cell: (row) => <span className="break-words">{row.owner}</span>,
  },
  {
    id: 'blocking',
    head: 'Blocks the start',
    min: 120,
    everything: true,
    value: (row) => row.blocking,
    cell: (row) => (row.blocking === 'yes' ? 'Yes' : 'No'),
  },
  {
    id: 'origin',
    head: 'Read from',
    min: 104,
    everything: true,
    value: (row) => row.origin,
    cell: (row) => <span className="break-words">{row.origin}</span>,
  },
];

function ManifestReport({ manifest, everything }: { manifest: ResolvedManifest; everything: boolean }) {
  const probes = Object.entries(manifest.probes ?? {});
  const credentials = manifest.credentials as
    { policy?: string; held?: string[]; missing?: string[] } | undefined;
  const delivery = manifest.delivery as { ok?: boolean; acknowledged?: boolean } | undefined;
  return (
    <div data-testid="why-started-manifest" className="flex min-w-0 flex-col gap-2 border-t border-rule pt-3">
      <SectionHeading as="h3">What the start door resolved</SectionHeading>
      {manifest.overridden && (
        <p
          data-testid="why-started-override"
          className="text-body text-ink"
          title={`Signed ${new Date(manifest.overridden.at).toLocaleString()}`}
        >
          Overridden by {manifest.overridden.by}: {manifest.overridden.rows.join(', ') || 'no rows named'}.
        </p>
      )}
      {manifest.decisions.length > 0 && (
        <Grid
          columns={DECISION_COLUMNS}
          rows={manifest.decisions}
          getRowKey={(row) => row.key}
          label="Decisions at start"
          everything={everything}
        />
      )}
      {probes.length > 0 && (
        <ul className="flex min-w-0 flex-col gap-1" aria-label="Start probes">
          {probes.map(([name, probe]) => (
            <li key={name} className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-meta">
              <Mono value={name} className="text-ink" />{' '}
              <OpsStatus
                vocab="probe"
                word={probe.status as WordOf<'probe'>}
                data-testid="why-started-probe"
              />
              {probe.reason && (
                <>
                  {' '}
                  <span className="min-w-0 break-words text-ink-muted">{probe.reason}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <KeyValue
        items={[
          credentials && [
            'Credentials',
            `${credentials.held?.length ? `Held ${credentials.held.join(', ')}` : 'None held'}${
              credentials.missing?.length ? `; missing ${credentials.missing.join(', ')}` : ''
            }${credentials.policy ? ` (${credentials.policy})` : ''}`,
          ],
          delivery && [
            'Delivery',
            delivery.ok
              ? 'A channel reaches a person'
              : delivery.acknowledged
                ? 'No channel, acknowledged'
                : 'No channel',
          ],
        ]}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The section
 * ------------------------------------------------------------------ */

export function RunWhyStarted({
  ledger,
  manifest,
  everything = false,
}: {
  ledger: RunLedger | undefined;
  manifest?: ResolvedManifest | null;
  /** The page's Everything: the decisions' long-tail columns drawn rather than folded. */
  everything?: boolean;
}) {
  const starts = ledger?.starts ?? [];
  const runStarts = newestFirst(starts.filter((start) => start.event !== 'phase.session-start'));
  const beside = newestFirst(starts.filter((start) => start.event === 'phase.session-start'));
  // The latest REAL start: a refusal after it did not start anything.
  const latest = runStarts.find((start) => start.event === 'run.start') ?? null;

  return (
    <div data-testid="why-started" className="flex min-w-0 flex-col gap-3">
      {runStarts.length ? (
        <ol className="flex min-w-0 flex-col" aria-label="Every start of this run">
          {runStarts.map((start, index) => (
            <StartRow key={`${start.at}|${index}`} start={start} latest={start === latest} />
          ))}
        </ol>
      ) : (
        <p className="text-body text-ink-muted">
          {ledger ? 'No start of this run is on its journal.' : 'Reading the journal…'}
        </p>
      )}
      {ledger?.totals.truncated && (
        <p className="text-meta text-ink-muted" data-testid="why-started-truncated">
          The journal read was cut, so an earlier start may be missing.
        </p>
      )}
      {beside.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1 border-t border-rule pt-3">
          <SectionHeading as="h3" count={beside.length}>
            Sessions started beside the run
          </SectionHeading>
          <ol className="flex min-w-0 flex-col" aria-label="Sessions started beside the run">
            {beside.map((start, index) => (
              <StartRow key={`${start.at}|${index}`} start={start} />
            ))}
          </ol>
        </div>
      )}
      {manifest && <ManifestReport manifest={manifest} everything={everything} />}
    </div>
  );
}
