/**
 * Why this run started — every time it did (zero-touch phase 19; chapter 02 SLF-1).
 *
 * The operator's question about a run nobody remembers pressing: which door
 * started it, what fired that door (a timer, a boot, an event), which guard let
 * it through and which start of that door this was, and who asked from where.
 * The words are the journal's own `run.start` lines — phase 7 put the actor on
 * every one — read back by the ledger, so a resumed run lists each start rather
 * than only the first. Beside them, the start door's report: the decisions it
 * resolved and where each answer came from, what its probes found, and the
 * override a person signed, if one did.
 *
 * `compact` is the session page's cut: the sentence, without the manifest.
 */

import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  DataTable,
  RelativeTime,
  type Column,
} from '@/components/ui';
import type { LedgerStart, ResolvedManifest, RunLedger } from '@/lib/api';

/** One start as one sentence: what happened, through which door, fired by what, and who. */
export function startLine(start: LedgerStart): string {
  const what =
    start.event === 'run.start-refused'
      ? 'Refused at'
      : start.event === 'phase.session-start'
        ? `A ${start.mode ?? 'side'} session started through`
        : start.resumed
          ? 'Resumed through'
          : 'Started through';
  const door = start.door ?? 'a door this line does not name';
  const fired = [
    start.trigger ? `fired by ${start.trigger}` : '',
    start.guard ? `past ${start.guard}` : '',
    start.counter != null ? `start ${start.counter} of that door` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const account = start.account ? ` · account ${start.account}` : '';
  const reason = start.reason ? ` · ${start.reason}` : '';
  return `${what} ${door}${fired ? ` (${fired})` : ''} — ${start.said}${account}${reason}`;
}

function when(iso: string): number | null {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
}

type DecisionRow = ResolvedManifest['decisions'][number];

const DECISION_COLUMNS: Column<DecisionRow>[] = [
  {
    id: 'key',
    head: 'Decision',
    identity: true,
    card: 'title',
    priority: 1,
    cell: (row) => <span className="font-mono text-xs">{row.key}</span>,
  },
  { id: 'state', head: 'State', priority: 1, cell: (row) => <span className="text-xs">{row.state}</span> },
  {
    id: 'source',
    head: 'Answered by',
    priority: 1,
    cell: (row) => <span className="text-xs">{row.source}</span>,
  },
  {
    id: 'value',
    head: 'Value',
    flex: true,
    priority: 2,
    cell: (row) => (
      <span className="line-clamp-2 text-xs" title={row.value}>
        {row.value || '—'}
      </span>
    ),
  },
];

function ManifestReport({ manifest }: { manifest: ResolvedManifest }) {
  const probes = Object.entries(manifest.probes ?? {});
  const credentials = manifest.credentials as
    { policy?: string; held?: string[]; missing?: string[] } | undefined;
  const delivery = manifest.delivery as
    { ok?: boolean; channels?: unknown; acknowledged?: boolean } | undefined;
  return (
    <div className="flex flex-col gap-2" data-testid="why-started-manifest">
      <p className="text-2xs text-ink-faint">What the start door resolved, and where each answer came from</p>
      {manifest.overridden && (
        <p className="text-xs text-ink" data-testid="why-started-override">
          Overridden by {manifest.overridden.by}: {manifest.overridden.rows.join(', ') || 'no rows named'}
        </p>
      )}
      {manifest.decisions.length > 0 && (
        <DataTable
          label="Decisions at start"
          columns={DECISION_COLUMNS}
          rows={manifest.decisions}
          getRowKey={(row) => row.key}
        />
      )}
      {probes.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-ink-muted" aria-label="Start probes">
          {probes.map(([name, probe]) => (
            <li key={name}>
              <span className="font-mono">{name}</span>: {probe.status}
              {probe.reason ? ` — ${probe.reason}` : ''}
            </li>
          ))}
        </ul>
      )}
      {(credentials || delivery) && (
        <p className="text-xs text-ink-muted">
          {credentials
            ? `Credentials: ${credentials.held?.length ? `held ${credentials.held.join(', ')}` : 'none held'}${
                credentials.missing?.length ? ` · missing ${credentials.missing.join(', ')}` : ''
              }${credentials.policy ? ` (${credentials.policy})` : ''}`
            : ''}
          {credentials && delivery ? ' · ' : ''}
          {delivery
            ? `Delivery: ${delivery.ok ? 'a channel reaches a person' : delivery.acknowledged ? 'channel-less, acknowledged' : 'no channel'}`
            : ''}
        </p>
      )}
    </div>
  );
}

export function WhyStarted({
  ledger,
  manifest,
  compact = false,
}: {
  ledger: RunLedger | undefined;
  manifest?: ResolvedManifest | null;
  compact?: boolean;
}) {
  const starts = ledger?.starts ?? [];
  const runStarts = starts.filter((start) => start.event !== 'phase.session-start');
  const latest = [...runStarts].reverse().find((start) => start.event === 'run.start') ?? null;
  const beside = starts.filter((start) => start.event === 'phase.session-start');
  const earlier = runStarts.filter((start) => start !== latest);

  return (
    <Card data-testid="why-started">
      <CardHeader className="flex-wrap items-baseline gap-x-3">
        <CardTitle>Why this run started</CardTitle>
        {ledger?.totals.truncated ? (
          <Badge tone="wait" title="The journal read was cut — an earlier start may be missing.">
            journal truncated
          </Badge>
        ) : null}
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {latest ? (
          <p className="text-sm text-ink" data-testid="why-started-latest">
            {startLine(latest)}
          </p>
        ) : (
          <p className="text-sm text-ink-muted">
            {ledger ? 'No start of this run is on its journal.' : 'Reading the journal…'}
          </p>
        )}
        {!compact && earlier.length > 0 && (
          <ol
            className="flex flex-col gap-1 text-xs text-ink-muted"
            aria-label="Every other start of this run"
          >
            {earlier.map((start, i) => {
              const at = when(start.at);
              return (
                <li key={`${start.at}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
                  {at != null && <RelativeTime at={at} className="text-2xs text-ink-faint" />}
                  <span>{startLine(start)}</span>
                </li>
              );
            })}
          </ol>
        )}
        {!compact && beside.length > 0 && (
          <ol
            className="flex flex-col gap-1 text-xs text-ink-muted"
            aria-label="Sessions started beside the run"
          >
            {beside.map((start, i) => (
              <li key={`${start.at}-${i}`}>
                {start.phase != null ? `p${start.phase} · ` : ''}
                {startLine(start)}
              </li>
            ))}
          </ol>
        )}
        {!compact && manifest && <ManifestReport manifest={manifest} />}
      </CardBody>
    </Card>
  );
}
