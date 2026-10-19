/**
 * What both sections of Sessions read (7.0, quiet-console phase 15): the one
 * list of processes, and the two links between the processes and the claims.
 *
 * The sections are REAL LINKS with the section in the address (§Architecture
 * 4, `shell/section-nav.tsx`), each with its count, so the list says how many
 * claims are held and the claims say how many processes there are — one
 * glance either way, and a reload lands where it was.
 */

import { useMemo } from 'react';
import { useAccounts } from '@/data/accounts';
import type { ConsoleState, TerminalState } from '@/data/api';
import { lanesOf } from '@/data/lanes';
import { useLocks, usePlanDetails } from '@/data/plans';
import { useApprovals, useRunList, useRunRecords } from '@/data/runs';
import { useSessionRegistry, useTerminals } from '@/data/sessions';
import { SectionNav } from '@/shell/section-nav';
import { sessionsHref, sessionsLocksHref } from '@/shell/routes';
import { sessionRows, type SessionRow } from './model';

/** The shared session cap — across shells and agents alike. */
export interface SessionCap {
  /** The cap is reached: a new shell or session would be refused. */
  atCap: boolean;
  /** How many running sessions the console allows at once. */
  limit: number;
}

/**
 * Where the console stands against its cap. Live processes only: an ended
 * record stays listed (that is where its `--resume` id lives) and holds no
 * slot. `live` is the server's own count; the filter is for a server that
 * predates it.
 */
export function capOf(terminals: TerminalState | undefined): SessionCap {
  const sessions = terminals?.sessions ?? [];
  const limit = terminals?.limit ?? 8;
  const live = terminals?.live ?? sessions.filter((one) => !one.exited).length;
  return { atCap: live >= limit, limit };
}

export interface SessionRows extends SessionCap {
  rows: SessionRow[];
  /** Every source that is asked has answered once — before then an empty list is not news. */
  ready: boolean;
}

/**
 * Every process, folded once: the run lanes (the SLIM list, #234), this
 * console's ptys, the sessions the presence hook reported, and the pending
 * permission cards that mark a lane as waiting on a person — and, for the
 * lanes, what the run record holds about each session (#369): the whole
 * record of each LIVE run, the plan detail (a phase's title and estimate) and
 * the registry's accounts (an account id's name).
 *
 * The runs are asked only once `/api/state` has answered and says there is
 * an autopilot — a server that predates it has no run endpoints — and the
 * ptys only on a console that can have one.
 */
export function useSessionRows(state: ConsoleState | undefined): SessionRows {
  const ptys = state?.allowAgent === true || state?.allowTerminal === true;
  const runsEnabled = state != null && state.autopilot !== false;
  const runs = useRunList(runsEnabled);
  const approvals = useApprovals(runsEnabled);
  const registry = useSessionRegistry();
  const terminals = useTerminals(ptys);
  const accounts = useAccounts(runsEnabled);

  const lanes = useMemo(() => lanesOf(runs.data ?? []), [runs.data]);
  // The plans with a lane on the page, in a stable order — a handful, never the run list.
  const liveKey = useMemo(() => [...new Set(lanes.map((lane) => lane.slug))].sort().join('\n'), [lanes]);
  const live = useMemo(() => (liveKey ? liveKey.split('\n') : []), [liveKey]);
  const { bySlug: records } = useRunRecords(live, runsEnabled);
  const { bySlug: details } = usePlanDetails(live, runsEnabled);

  const rows = useMemo(
    () =>
      sessionRows({
        terminals: terminals.data?.sessions,
        lanes,
        foreign: registry.data?.sessions,
        approvals: approvals.data,
        records,
        details,
        accounts: accounts.data?.accounts,
      }),
    [terminals.data, lanes, registry.data, approvals.data, records, details, accounts.data],
  );
  return {
    rows,
    ready: state != null && !runs.isLoading && !registry.isLoading && !terminals.isLoading,
    ...capOf(terminals.data),
  };
}

/** The sentence a page says at the cap — and where the refused buttons say why. */
export const capWords = (limit: number): string =>
  `${limit} sessions are running, the most this console allows at once: close one to start another.`;

/** The processes and the claims, as two links with their counts. */
export function SessionsSections({ current, sessions }: { current: 'list' | 'locks'; sessions: number }) {
  // The unfiltered claims — the same read the Locks section draws its scopes from.
  const { data } = useLocks();
  return (
    <SectionNav
      label="Sessions sections"
      current={current}
      sections={[
        { id: 'list', label: 'Sessions', href: sessionsHref(), count: sessions },
        {
          id: 'locks',
          label: 'Locks',
          href: sessionsLocksHref(),
          ...(data ? { count: data.rows.length } : {}),
        },
      ]}
    />
  );
}
