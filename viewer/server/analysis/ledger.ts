/**
 * The run's ledger (zero-touch phase 19): why each start happened, what every
 * session cost and how long it ran, and what each rung of the ladder spent —
 * read back from the journal and reconciled against the run's own spend.
 *
 * Chapter 02 SLF-1 asked for "why did this start" on every page, and chapter 03
 * SES-1 for a session ledger. Phases 4, 7 and 10 made the journal carry both:
 * `run.start` spreads its actor (`door · trigger · guard · counter`,
 * `by · via · origin · remoteUser`), every session writes ONE `phase.session`
 * shape through the spawn door, and every settlement writes ONE
 * `phase.rung-settled` shape. Nothing read them back. This does, and only this:
 * a pure function over journal entries, so the run page, the session vitals and
 * Insights cannot each count a different total.
 *
 * Reconciliation is why they are read together. `RunState.spentUsd` is the
 * runner's own running sum; the session lines are what each session said it
 * cost. They agree when every spend went through the spawn door and every
 * session reported a figure. A gap is a finding — a session whose cost is
 * unknown (`costSource: none`, never counted as $0), a spend booked outside the
 * door, or a journal tail that no longer holds the early sessions — and the
 * ledger reports what it can see rather than rounding it away.
 *
 * A rung's `costUsd` is the spend of the session the rung boarded, which that
 * session's own line already carries — so the rung column is shown beside the
 * sessions, never added to them.
 */

import { drivableBy } from '../../shared/ladder-model.js';
import { describeActor } from '../actor.ts';
import type { JournalEntry } from '../runner/journal.ts';
import { consoleEnded } from '../runner/session-record.ts';

/** Below this, a gap between the session lines and `spentUsd` is rounding, not a finding. */
export const LEDGER_GAP_USD = 0.01;

export type LedgerStart = {
  at: string;
  /** Which line said so: a run start, a refused one, or a session started beside a run (a reviewer, a pty rung). */
  event: 'run.start' | 'run.start-refused' | 'phase.session-start';
  phase: number | null;
  resumed: boolean;
  door: string | null;
  trigger: string | null;
  guard: string | null;
  counter: string | number | null;
  by: string | null;
  via: string | null;
  origin: string | null;
  remoteUser: string | null;
  account: string | null;
  mode: string | null;
  /** The actor as one sentence — `describeActor`'s words. */
  said: string;
  /** A refused start's reason. */
  reason: string | null;
};

export type LedgerCap = { value: number; source: string; basis?: string } | null;

export type LedgerSession = {
  at: string;
  phase: number | null;
  mode: string;
  attempt: number | null;
  model: string | null;
  sessionId: string | null;
  resumed: boolean;
  /** The `ENDED_BY` word: how the session ended. */
  endedBy: string | null;
  /** The console ended it, rather than the session finishing its turn. */
  consoleEnded: boolean;
  isError: boolean;
  turns: number | null;
  turnsSource: string | null;
  /** `null` when the session never reported a cost — unknown, never $0. */
  costUsd: number | null;
  costSource: string | null;
  ms: number | null;
  maxTurns: LedgerCap;
  maxBudgetUsd: LedgerCap;
  /** The account the run was spending when the session ended. */
  account: string | null;
};

export type LedgerRung = {
  at: string;
  phase: number | null;
  /** The rung's vehicle word. */
  rung: string;
  /** Who can drive that vehicle (`RUNG_DRIVERS`), or null for a word this build does not know. */
  driver: string | null;
  outcome: string;
  situation: string;
  costUsd: number;
  note: string | null;
  by: string | null;
};

export type LedgerTotals = {
  sessions: number;
  /** Summed over the sessions that reported a cost. */
  sessionsUsd: number;
  /** Sessions whose cost was never reported. */
  unknownCost: number;
  turns: number;
  ms: number;
  rungsUsd: number;
  /** The run's own running sum, when the run is known. */
  spentUsd: number | null;
  /** `spentUsd − sessionsUsd`, when both are known. */
  gapUsd: number | null;
  /** Within `LEDGER_GAP_USD` with every session's cost known; null when there is no run to hold it to. */
  reconciled: boolean | null;
  /** The journal read was cut: early starts and sessions may be missing from every figure above. */
  truncated: boolean;
};

export type RunLedger = {
  runId: string | null;
  starts: LedgerStart[];
  sessions: LedgerSession[];
  rungs: LedgerRung[];
  totals: LedgerTotals;
};

export type LedgerRunFacts = { id?: string | null; spentUsd?: number | null } | null;

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function cap(value: unknown): LedgerCap {
  const raw = value as { value?: unknown; source?: unknown; basis?: unknown } | null | undefined;
  const amount = num(raw?.value);
  if (amount == null) return null;
  return { value: amount, source: str(raw?.source) ?? 'unknown', ...(str(raw?.basis) ? { basis: String(raw?.basis) } : {}) };
}

function startOf(entry: JournalEntry, account: string | null): LedgerStart {
  const data = entry.data ?? {};
  const by = str(data.by);
  const via = str(data.via);
  const origin = str(data.origin);
  const remoteUser = str(data.remoteUser);
  const said = by
    ? describeActor({ by, via: (via ?? 'api') as never, origin: origin ?? 'local', remoteUser })
    : 'not attributed — the line predates the actor on every start';
  const counter = data.counter;
  return {
    at: entry.time,
    event: entry.event as LedgerStart['event'],
    phase: typeof entry.phase === 'number' ? entry.phase : null,
    resumed: data.resumed === true,
    door: str(data.door),
    trigger: str(data.trigger),
    guard: str(data.guard),
    counter: typeof counter === 'string' || typeof counter === 'number' ? counter : null,
    by,
    via,
    origin,
    remoteUser,
    account: str(data.account) ?? account,
    mode: str(data.mode),
    said,
    reason: str(data.reason) ?? str(data.why),
  };
}

/**
 * One run's ledger from its journal. `run` holds it to the run's own spend; pass
 * `truncated` when the read may have cut the journal's head.
 */
export function projectLedger(
  entries: readonly JournalEntry[],
  run: LedgerRunFacts,
  opts: { truncated?: boolean } = {},
): RunLedger {
  const starts: LedgerStart[] = [];
  const sessions: LedgerSession[] = [];
  const rungs: LedgerRung[] = [];
  let account: string | null = null;

  for (const entry of entries) {
    const data = entry.data ?? {};
    const phase = typeof entry.phase === 'number' ? entry.phase : null;
    switch (entry.event) {
      case 'run.start':
        account = str(data.account) ?? account;
        starts.push(startOf(entry, account));
        break;
      case 'run.start-refused':
      case 'phase.session-start':
        starts.push(startOf(entry, account));
        break;
      case 'run.account-switched':
        account = str(data.account) ?? str(data.to) ?? account;
        break;
      case 'phase.session': {
        const endedBy = str(data.endedBy);
        const costSource = str(data.costSource);
        const cost = num(data.costUsd);
        sessions.push({
          at: entry.time,
          phase,
          mode: str(data.mode) ?? 'phase',
          attempt: num(data.attempt),
          model: str(data.model),
          sessionId: str(data.sessionId),
          resumed: data.resumed === true,
          endedBy,
          consoleEnded: consoleEnded(endedBy),
          isError: data.isError === true,
          turns: num(data.turns),
          turnsSource: str(data.turnsSource),
          costUsd: costSource === 'none' ? null : cost,
          costSource,
          ms: num(data.ms),
          maxTurns: cap(data.maxTurns),
          maxBudgetUsd: cap(data.maxBudgetUsd),
          account,
        });
        break;
      }
      case 'phase.rung-settled': {
        const rung = str(data.rung) ?? 'rung';
        rungs.push({
          at: entry.time,
          phase,
          rung,
          driver: drivableBy(rung) ?? null,
          outcome: str(data.outcome) ?? 'running',
          situation: str(data.situation) ?? '',
          costUsd: num(data.costUsd) ?? 0,
          note: str(data.note),
          by: str(data.by),
        });
        break;
      }
      default:
        break;
    }
  }

  const known = sessions.filter((session) => session.costUsd != null);
  const sessionsUsd = round(known.reduce((sum, session) => sum + (session.costUsd ?? 0), 0));
  const unknownCost = sessions.length - known.length;
  const spentUsd = num(run?.spentUsd ?? null);
  const gapUsd = spentUsd == null ? null : round(spentUsd - sessionsUsd);
  return {
    runId: str(run?.id ?? null),
    starts,
    sessions,
    rungs,
    totals: {
      sessions: sessions.length,
      sessionsUsd,
      unknownCost,
      turns: sessions.reduce((sum, session) => sum + (session.turns ?? 0), 0),
      ms: sessions.reduce((sum, session) => sum + (session.ms ?? 0), 0),
      rungsUsd: round(rungs.reduce((sum, rung) => sum + rung.costUsd, 0)),
      spentUsd,
      gapUsd,
      reconciled: gapUsd == null ? null : Math.abs(gapUsd) <= LEDGER_GAP_USD && unknownCost === 0,
      truncated: Boolean(opts.truncated),
    },
  };
}

/** Cents are the ledger's grain; float sums of session costs drift below it. */
function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

export type LedgerSummaryRow = {
  /** A plan slug, or an account id. */
  key: string;
  runs: number;
  sessions: number;
  costUsd: number;
  unknownCost: number;
  turns: number;
  ms: number;
};

export type LedgerSummary = {
  plans: LedgerSummaryRow[];
  accounts: LedgerSummaryRow[];
  /** Runs whose journal read was cut — their figures are lower bounds. */
  truncatedRuns: number;
};

/** The same ledger, aggregated per plan and per account — what Insights draws. Most expensive first. */
export function summariseLedgers(ledgers: readonly { slug: string; ledger: RunLedger }[]): LedgerSummary {
  const plans = new Map<string, LedgerSummaryRow & { runIds: Set<string> }>();
  const accounts = new Map<string, LedgerSummaryRow & { runIds: Set<string> }>();
  const slot = (map: typeof plans, key: string) => {
    let row = map.get(key);
    if (!row) {
      row = { key, runs: 0, sessions: 0, costUsd: 0, unknownCost: 0, turns: 0, ms: 0, runIds: new Set() };
      map.set(key, row);
    }
    return row;
  };
  let truncatedRuns = 0;
  ledgers.forEach(({ slug, ledger }, index) => {
    if (ledger.totals.truncated) truncatedRuns++;
    const runKey = ledger.runId ?? `#${index}`;
    const plan = slot(plans, slug);
    plan.runIds.add(runKey);
    for (const session of ledger.sessions) {
      for (const row of [plan, slot(accounts, session.account ?? 'default')]) {
        row.runIds.add(runKey);
        row.sessions++;
        row.turns += session.turns ?? 0;
        row.ms += session.ms ?? 0;
        if (session.costUsd == null) row.unknownCost++;
        else row.costUsd += session.costUsd;
      }
    }
  });
  const finish = (map: typeof plans): LedgerSummaryRow[] =>
    [...map.values()]
      .map(({ runIds, ...row }) => ({ ...row, runs: runIds.size, costUsd: round(row.costUsd) }))
      .sort((a, b) => b.costUsd - a.costUsd || a.key.localeCompare(b.key));
  return { plans: finish(plans), accounts: finish(accounts), truncatedRuns };
}
