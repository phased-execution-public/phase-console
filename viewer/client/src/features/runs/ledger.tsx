/**
 * What the run cost and how long it ran, session by session (zero-touch phase
 * 19; chapter 03 SES-1).
 *
 * Every row is one `phase.session` line — the one shape the spawn door writes
 * for every session it starts (phase 4): which mode, how it ended and whether the
 * console ended it, its turns, what it said it cost, how long it ran, and the two
 * caps it ran under with where each cap came from. A session that never reported
 * a cost reads *unknown*, never $0.00.
 *
 * Under the table, the reconciliation: the sessions' own figures against the
 * run's running `spentUsd`. They agree when every spend went through the spawn
 * door and every session reported; when they do not, the gap is shown as a
 * finding rather than averaged away. Below that, what each rung of the ladder
 * settled with — its situation, its cost and who drives that vehicle (the ladder
 * table's drivability column, phase 10). A rung's cost is its boarded session's,
 * already in the table above, so it is shown beside the total and never added.
 */

import { RUNG_DRIVER_LABELS, VEHICLE_DRIVERS } from '@shared/ladder-model.js';
import { Badge, Card, CardBody, CardHeader, CardTitle, DataTable, type Column } from '@/components/ui';
import type { LedgerCap, LedgerRung, LedgerSession, LedgerTotals, RunLedger } from '@/lib/api';
import { cn } from '@/lib/cn';
import { duration, money } from '@/lib/format';

function capText(cap: LedgerCap, format: (value: number) => string): string {
  return cap ? `${format(cap.value)} · ${cap.source}` : '—';
}

const SESSION_COLUMNS: Column<LedgerSession>[] = [
  {
    id: 'session',
    head: 'Session',
    identity: true,
    card: 'title',
    priority: 1,
    cell: (session) => (
      <span className="font-mono text-xs">
        {session.phase != null ? `p${session.phase}` : 'run'} · {session.mode}
        {session.attempt != null ? ` #${session.attempt}` : ''}
      </span>
    ),
  },
  {
    id: 'ended',
    head: 'Ended by',
    priority: 1,
    cell: (session) => (
      <span className="flex flex-wrap items-center gap-1 text-xs">
        {session.endedBy ?? '—'}
        {session.consoleEnded && (
          <Badge
            tone="wait"
            title="The console ended this session rather than the session finishing its turn."
          >
            console
          </Badge>
        )}
        {session.isError && <span className="text-2xs text-blocked">error</span>}
      </span>
    ),
  },
  {
    id: 'cost',
    head: 'Cost',
    align: 'end',
    priority: 1,
    cell: (session) =>
      session.costUsd == null ? (
        <span
          className="text-2xs text-ink-faint"
          title="The session never reported a cost — unknown, not $0."
        >
          unknown
        </span>
      ) : (
        <span className="font-mono text-xs" data-testid="ledger-cost">
          {money(session.costUsd)}
        </span>
      ),
  },
  {
    id: 'turns',
    head: 'Turns',
    align: 'end',
    priority: 2,
    cell: (session) => (
      <span
        className="font-mono text-xs"
        title={session.turnsSource ? `counted from the ${session.turnsSource}` : undefined}
      >
        {session.turns ?? '—'}
      </span>
    ),
  },
  {
    id: 'time',
    head: 'Time',
    align: 'end',
    priority: 2,
    cell: (session) => (
      <span className="font-mono text-xs">{session.ms != null ? duration(session.ms) : '—'}</span>
    ),
  },
  {
    id: 'caps',
    head: 'Caps',
    priority: 3,
    cell: (session) => (
      <span className="text-2xs text-ink-muted">
        {capText(session.maxTurns, (value) => `${value} turns`)} · {capText(session.maxBudgetUsd, money)}
      </span>
    ),
  },
];

const RUNG_COLUMNS: Column<LedgerRung>[] = [
  {
    id: 'rung',
    head: 'Rung',
    identity: true,
    card: 'title',
    priority: 1,
    cell: (rung) => (
      <span className="font-mono text-xs">
        {rung.phase != null ? `p${rung.phase} · ` : ''}
        {rung.rung}
      </span>
    ),
  },
  {
    id: 'driver',
    head: 'Driven by',
    priority: 1,
    cell: (rung) => (
      <span
        className="text-xs"
        title={(VEHICLE_DRIVERS as Record<string, { how: string } | undefined>)[rung.rung]?.how}
        data-testid="ledger-driver"
      >
        {(RUNG_DRIVER_LABELS as Record<string, string>)[rung.driver ?? 'never'] ?? rung.driver ?? '—'}
      </span>
    ),
  },
  {
    id: 'outcome',
    head: 'Outcome',
    priority: 1,
    cell: (rung) => <span className="text-xs">{rung.outcome}</span>,
  },
  {
    id: 'situation',
    head: 'Situation',
    priority: 2,
    cell: (rung) => <span className="font-mono text-2xs text-ink-muted">{rung.situation || '—'}</span>,
  },
  {
    id: 'cost',
    head: 'Cost',
    align: 'end',
    priority: 2,
    cell: (rung) => <span className="font-mono text-xs">{money(rung.costUsd)}</span>,
  },
];

/** The reconciliation sentence — and whether it is a finding. */
export function reconciliation(totals: LedgerTotals): { text: string; gap: boolean } {
  const parts = [
    `${totals.sessions} session${totals.sessions === 1 ? '' : 's'} reported ${money(totals.sessionsUsd)}`,
  ];
  if (totals.unknownCost) {
    parts.push(`${totals.unknownCost} never reported a cost`);
  }
  if (totals.spentUsd != null) parts.push(`the run's own spend is ${money(totals.spentUsd)}`);
  const gap = totals.reconciled === false;
  if (totals.gapUsd != null) {
    if (Math.abs(totals.gapUsd) > 0.01) {
      parts.push(
        totals.gapUsd > 0
          ? `${money(totals.gapUsd)} of it no session line accounts for`
          : `the session lines exceed it by ${money(-totals.gapUsd)}`,
      );
    } else if (totals.unknownCost) {
      parts.push('so it cannot be reconciled');
    } else {
      parts.push('reconciled');
    }
  }
  if (totals.truncated) parts.push('the journal read was cut, so early sessions may be missing');
  return { text: `${parts.join(' · ')}.`, gap };
}

export function LedgerCard({ ledger }: { ledger: RunLedger | undefined }) {
  if (!ledger) return null;
  const { sessions, rungs, totals } = ledger;
  const { text, gap } = reconciliation(totals);
  return (
    <Card data-testid="run-ledger">
      <CardHeader className="flex-wrap items-baseline gap-x-3">
        <CardTitle>What it cost and how long it ran</CardTitle>
        <span className="text-2xs text-ink-faint">
          {money(totals.sessionsUsd)} · {totals.turns} turns · {duration(totals.ms)}
        </span>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {sessions.length ? (
          <DataTable
            label="Sessions"
            columns={SESSION_COLUMNS}
            rows={sessions}
            getRowKey={(session) => `${session.at}-${session.sessionId ?? ''}-${session.mode}`}
          />
        ) : (
          <p className="text-sm text-ink-muted">No session of this run has ended yet.</p>
        )}
        <p
          data-testid="ledger-reconcile"
          data-gap={gap ? 'true' : undefined}
          className={cn('text-xs', gap ? 'text-blocked' : 'text-ink-muted')}
        >
          {text}
        </p>
        {rungs.length > 0 && (
          <>
            <p className="text-2xs text-ink-faint">
              What the ladder tried — {money(totals.rungsUsd)}, already inside the sessions above
            </p>
            <DataTable
              label="Rung settlements"
              columns={RUNG_COLUMNS}
              rows={rungs}
              getRowKey={(rung) => `${rung.at}-${rung.rung}-${rung.phase ?? ''}`}
            />
          </>
        )}
      </CardBody>
    </Card>
  );
}
