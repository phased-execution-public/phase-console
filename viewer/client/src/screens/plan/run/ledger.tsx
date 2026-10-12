/**
 * What every session of the run cost and how long it ran, held to the run's
 * own spend (7.0, quiet-console phase 12; the 6.x ledger card's sessions).
 *
 * ```
 * $1.50, 378 turns and 2m 00s across 2 sessions.
 * Session              Account   Model   Turns                Time     Cost      Ended by
 * P2 phase attempt 1   default   opus                   338   1m 00s   $1.50     exit
 *                                           max 300 per prompt
 * P2 qa                default   opus                    40   1m 00s   Unknown   watchdog  cut short by the console
 * 2 sessions reported $1.50 and 1 never reported a cost; the run’s own spend is $1.50, so it cannot be reconciled.
 * ```
 *
 * One row per `phase.session` line — the one shape the spawn door writes for
 * every session it starts: what it was for, who paid and with which model, its
 * turns, how long it ran, what it said it cost and how it ended. A session that
 * never reported a cost reads unknown, never $0.00. When it ended, its id,
 * where its cost was read and the two caps it ran under — each with where the
 * cap came from — are the Everything columns.
 *
 * The turn cap binds per PROMPT: a session woken more than once sums its
 * prompts past the cap and never nears it in any one. So the Turns cell names
 * the largest prompt beside the sum when the two differ, and the cap says what
 * it counts — the sum is never the figure set against it.
 *
 * Under the rows, the reconciliation: the sessions' own figures against the
 * run's running spend. They agree when every spend went through the spawn door
 * and every session reported; when they do not, the gap is said as a finding
 * rather than averaged away. What the ladder tried is its own fold
 * (`rungs.tsx`): a rung's cost is its boarded session's, a row here already.
 */

import type { ReactNode } from 'react';
import type { LedgerCap, LedgerSession, LedgerTotals, RunLedger } from '@/data/api';
import { cn } from '@/lib/cn';
import { money, plural } from '@/lib/format';
import { Duration, Money, Mono, RelativeTime } from '@/ui';
import type { Column } from '@/ui/grid/column';
import { Grid } from '@/ui/grid/grid';

/** Below this, a gap between the session lines and the run's spend is rounding, not a finding. */
const GAP_USD = 0.01;

/*
 * A cell's parts sit in a flex row whose gap draws the space between them; the
 * `{' '}` beside each part is for the words — what a screen reader and a copy
 * get — and lays nothing out.
 */

/** A fact the line does not carry — said as a quiet dash, with why on hover. */
const none = (why: string) => (
  <span className="text-ink-faint" title={why}>
    —
  </span>
);

/** The largest prompt, when it is a different figure from the sum — `null` for one prompt or a line from before it. */
function largestPrompt(session: LedgerSession): number | null {
  return session.promptTurns != null && session.turns != null && session.promptTurns !== session.turns
    ? session.promptTurns
    : null;
}

function turnsTitle(session: LedgerSession): string | undefined {
  const counted = session.turnsSource ? `Counted from the ${session.turnsSource}` : null;
  const largest = largestPrompt(session);
  const perPrompt =
    largest != null
      ? `${session.turns} turns across its prompts; the largest ran ${largest}, the figure its turn cap binds, per prompt`
      : null;
  return [counted, perPrompt].filter(Boolean).join('. ') || undefined;
}

/** A cap and where it came from — or a dash for a line that names none. */
function CapCell({ cap, children }: { cap: LedgerCap; children: (value: number) => ReactNode }) {
  if (!cap) return none('This line names no cap.');
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-2">
      <span className="tnum">{children(cap.value)}</span>{' '}
      <Mono
        value={cap.source}
        title={cap.basis ? `Where this cap came from, ${cap.basis}` : 'Where this cap came from'}
      />
    </span>
  );
}

const COLUMNS: Column<LedgerSession>[] = [
  {
    id: 'session',
    head: 'Session',
    identity: true,
    flex: true,
    priority: 1,
    // "P12 closeout attempt 3 resumed" on one line.
    min: 200,
    card: 'title',
    value: (session) =>
      `${session.phase != null ? `P${session.phase}` : 'Run'} ${session.mode}${
        session.attempt != null ? ` attempt ${session.attempt}` : ''
      }`,
    cell: (session) => (
      <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="text-meta text-ink-muted tnum">
          {session.phase != null ? `P${session.phase}` : 'Run'}
        </span>{' '}
        <Mono value={session.mode} className="wrap-anywhere text-ink" />
        {session.attempt != null && (
          <>
            {' '}
            <span className="text-meta text-ink-muted tnum">attempt {session.attempt}</span>
          </>
        )}
        {session.resumed && (
          <>
            {' '}
            <span
              className="text-meta text-ink-muted"
              title="It resumed an earlier session rather than starting fresh"
            >
              resumed
            </span>
          </>
        )}
      </span>
    ),
  },
  {
    id: 'account',
    head: 'Account',
    priority: 2,
    min: 112,
    value: (session) => session.account,
    cell: (session) =>
      session.account ? (
        <Mono value={session.account} chars={20} className="wrap-anywhere" />
      ) : (
        none('The journal names no account for this session.')
      ),
  },
  {
    id: 'model',
    head: 'Model',
    priority: 3,
    min: 112,
    value: (session) => session.model,
    cell: (session) =>
      session.model ? (
        <Mono value={session.model} className="wrap-anywhere" />
      ) : (
        none('No model was recorded.')
      ),
  },
  {
    id: 'turns',
    head: 'Turns',
    align: 'end',
    priority: 2,
    // "max 300 per prompt" under the sum.
    min: 128,
    value: (session) => session.turns,
    cell: (session) => {
      if (session.turns == null) return none('The session never reported its turns.');
      const largest = largestPrompt(session);
      return (
        <span className="inline-flex flex-col items-end" title={turnsTitle(session)}>
          <span className="tnum">{session.turns}</span>
          {largest != null && (
            <>
              {' '}
              <span className="text-meta text-ink-muted tnum" data-testid="ledger-prompt-turns">
                max {largest} per prompt
              </span>
            </>
          )}
        </span>
      );
    },
  },
  {
    id: 'time',
    head: 'Time',
    align: 'end',
    priority: 2,
    min: 88,
    value: (session) => session.ms,
    cell: (session) => <Duration ms={session.ms} />,
  },
  {
    id: 'cost',
    head: 'Cost',
    align: 'end',
    priority: 1,
    min: 88,
    card: 'meta',
    value: (session) => session.costUsd,
    cell: (session) =>
      session.costUsd == null ? (
        <span
          className="text-ink-muted"
          data-testid="ledger-cost-unknown"
          title="The session never reported a cost — unknown, not $0."
        >
          Unknown
        </span>
      ) : (
        <Money usd={session.costUsd} data-testid="ledger-cost" />
      ),
  },
  {
    id: 'ended',
    head: 'Ended by',
    priority: 1,
    min: 160,
    card: 'meta',
    value: (session) => session.endedBy,
    cell: (session) => (
      <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-2">
        {session.endedBy ? <Mono value={session.endedBy} /> : none('This line names no ending.')}
        {session.consoleEnded && (
          <>
            {' '}
            <span
              className="text-meta text-ink-muted"
              data-testid="ledger-console-ended"
              title="The console ended this session rather than the session finishing its turn."
            >
              cut short by the console
            </span>
          </>
        )}
        {session.isError && (
          <>
            {' '}
            <span className="state-failed text-meta text-state" data-testid="ledger-error">
              with an error
            </span>
          </>
        )}
      </span>
    ),
  },

  /* ---- Everything ---- */
  {
    id: 'at',
    head: 'Ended',
    min: 120,
    everything: true,
    value: (session) => session.at,
    cell: (session) => <RelativeTime at={session.at} live={false} />,
  },
  {
    id: 'turn-cap',
    head: 'Turn cap',
    min: 200,
    everything: true,
    value: (session) => session.maxTurns?.value,
    cell: (session) => (
      <CapCell cap={session.maxTurns}>{(value) => `${plural(value, 'turn')} per prompt`}</CapCell>
    ),
  },
  {
    id: 'budget-cap',
    head: 'Dollar cap',
    min: 144,
    everything: true,
    value: (session) => session.maxBudgetUsd?.value,
    cell: (session) => <CapCell cap={session.maxBudgetUsd}>{(value) => money(value)}</CapCell>,
  },
  {
    id: 'session-id',
    head: 'Session id',
    min: 112,
    everything: true,
    value: (session) => session.sessionId,
    cell: (session) =>
      session.sessionId ? <Mono value={session.sessionId} chars={8} /> : none('No session id was recorded.'),
  },
  {
    id: 'cost-source',
    head: 'Cost read from',
    min: 120,
    everything: true,
    value: (session) => session.costSource,
    cell: (session) =>
      session.costSource ? <Mono value={session.costSource} /> : none('The line names no source.'),
  },
];

/**
 * The reconciliation sentence — and whether it is a finding: the sessions' own
 * figures against the run's running spend, the gap said rather than averaged
 * away. A cost never reported means the two cannot be held to each other.
 */
export function reconciliation(totals: LedgerTotals): { text: string; gap: boolean } {
  const reported =
    totals.sessions === 0
      ? 'No session has reported a cost'
      : `${plural(totals.sessions, 'session')} reported ${money(totals.sessionsUsd)}` +
        (totals.unknownCost ? ` and ${totals.unknownCost} never reported a cost` : '');
  const held = totals.spentUsd != null ? `; the run’s own spend is ${money(totals.spentUsd)}` : '';
  let verdict = '';
  if (totals.gapUsd != null) {
    if (Math.abs(totals.gapUsd) > GAP_USD) {
      verdict =
        totals.gapUsd > 0
          ? `, and ${money(totals.gapUsd)} of it no session line accounts for`
          : `, and the session lines exceed it by ${money(-totals.gapUsd)}`;
    } else {
      verdict = totals.unknownCost ? ', so it cannot be reconciled' : ', reconciled';
    }
  }
  const cut = totals.truncated ? ' The journal read was cut, so early sessions may be missing.' : '';
  return { text: `${reported}${held}${verdict}.${cut}`, gap: totals.reconciled === false };
}

/** The run's sessions with what each cost and ran, then the reconciliation — nothing until the ledger answers. */
export function RunCostLedger({
  ledger,
  everything = false,
}: {
  ledger: RunLedger | undefined;
  /** The page's Everything: the long-tail columns drawn rather than folded into each row. */
  everything?: boolean;
}) {
  if (!ledger) return null;
  const { sessions, totals } = ledger;
  const { text, gap } = reconciliation(totals);
  return (
    <div data-testid="run-ledger" className="flex min-w-0 flex-col gap-2">
      {sessions.length ? (
        <>
          <p data-testid="ledger-total" className="text-meta text-ink-muted">
            <Money usd={totals.sessionsUsd} />, {plural(totals.turns, 'turn')} and <Duration ms={totals.ms} />{' '}
            across {plural(totals.sessions, 'session')}.
          </p>
          <Grid
            columns={COLUMNS}
            rows={sessions}
            getRowKey={(session, index) =>
              `${session.at}|${session.sessionId ?? ''}|${session.mode}|${index}`
            }
            label="Sessions"
            everything={everything}
          />
        </>
      ) : (
        <p data-testid="ledger-empty" className="text-body text-ink-muted">
          No session has ended on this run yet.
        </p>
      )}
      <p
        data-testid="ledger-reconcile"
        data-gap={gap ? 'true' : undefined}
        className={cn('max-w-(--measure) text-meta', gap ? 'state-failed text-state' : 'text-ink-muted')}
      >
        {text}
      </p>
    </div>
  );
}
