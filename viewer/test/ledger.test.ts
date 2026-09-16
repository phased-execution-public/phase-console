/**
 * The run's ledger (zero-touch phase 19) — held against synthetic 5.0 journal
 * lines, because the recorded corpus (`fixtures/journals/`) predates the actor on
 * `run.start` and `endedBy` on `phase.session`.
 *
 * What is pinned: every start is read back with its door and its actor's words;
 * a session's cost is its own line's, and a cost never reported is UNKNOWN rather
 * than $0; the account a session spent is the one the run was on when it ended;
 * a rung carries the driver its vehicle has; and the reconciliation against the
 * run's `spentUsd` is a finding when it does not hold.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LEDGER_GAP_USD, projectLedger, summariseLedgers } from '../server/analysis/ledger.ts';
import type { JournalEntry } from '../server/runner/journal.ts';
import { drivableBy } from '../shared/ladder-model.js';

const T0 = Date.parse('2026-09-15T10:00:00.000Z');
let seq = 0;

function at(min: number, event: string, phase?: number, data?: Record<string, unknown>): JournalEntry {
  return {
    seq: ++seq,
    time: new Date(T0 + min * 60_000).toISOString(),
    event,
    ...(phase != null ? { phase } : {}),
    ...(data ? { data } : {}),
  };
}

function session(min: number, phase: number, over: Record<string, unknown> = {}): JournalEntry {
  return at(min, 'phase.session', phase, {
    mode: 'phase', attempt: 1, model: 'opus', sessionId: `s-${min}`, resumed: false, isError: false,
    endedBy: 'exit', turns: 12, turnsSource: 'result', costUsd: 1.5, costSource: 'result', ms: 60_000,
    maxTurns: { value: 300, source: 'size' }, maxBudgetUsd: { value: 60, source: 'size' },
    ...over,
  });
}

const START = at(0, 'run.start', undefined, {
  runId: 'r1', slug: 'demo', account: 'default', resumed: false,
  by: 'operator', via: 'api', origin: 'local', remoteUser: null, door: 'operator',
});
const RELAUNCH = at(30, 'run.start', undefined, {
  runId: 'r1', slug: 'demo', account: 'backup', resumed: true,
  by: 'console', via: 'timer', origin: 'local', remoteUser: null,
  door: 'converge-relaunch', trigger: 'timer', guard: 'converge', counter: 2,
});

const JOURNAL: JournalEntry[] = [
  START,
  session(10, 1),
  at(11, 'run.account-switched', undefined, { from: 'default', account: 'backup', at: 'ladder' }),
  session(20, 2, { endedBy: 'watchdog', costUsd: 0.75, turns: 4 }),
  at(21, 'phase.rung-settled', 2, { rung: 'switch-account', outcome: 'failed', situation: 'resource-wall:usage', costUsd: 0.75, params: null }),
  at(22, 'phase.start', 3, {}),
  RELAUNCH,
  session(40, 3, { costSource: 'none', costUsd: 0, turns: 12 }),
];

test('every start is read back with its door, what fired it and the actor’s own words', () => {
  const ledger = projectLedger(JOURNAL, { id: 'r1', spentUsd: 2.25 });
  assert.equal(ledger.starts.length, 2);
  const [first, second] = ledger.starts;
  assert.equal(first.door, 'operator');
  assert.equal(first.resumed, false);
  assert.match(first.said, /asked for by operator over api from local/);
  assert.equal(second.door, 'converge-relaunch');
  assert.equal(second.resumed, true);
  assert.equal(second.trigger, 'timer');
  assert.equal(second.guard, 'converge');
  assert.equal(second.counter, 2);
  assert.match(second.said, /asked for by console over timer from local/);
});

test('a start that predates the actor says so rather than inventing one', () => {
  const ledger = projectLedger([at(0, 'run.start', undefined, { runId: 'old', slug: 'demo' })], null);
  assert.equal(ledger.starts[0].by, null);
  assert.match(ledger.starts[0].said, /not attributed/);
});

test('a session’s cost is its own line’s, a cost never reported is unknown — never $0 — and the account is the one it spent', () => {
  const ledger = projectLedger(JOURNAL, { id: 'r1', spentUsd: 2.25 });
  assert.equal(ledger.sessions.length, 3);
  const [one, two, three] = ledger.sessions;
  assert.equal(one.costUsd, 1.5);
  assert.equal(one.account, 'default');
  assert.equal(one.consoleEnded, false, 'the session finished its own turn');
  assert.equal(two.endedBy, 'watchdog');
  assert.equal(two.consoleEnded, true, 'the console ended it');
  assert.equal(two.account, 'backup', 'spent after the switch');
  assert.deepEqual(two.maxBudgetUsd, { value: 60, source: 'size' });
  assert.equal(three.costUsd, null, '`costSource: none` is unknown, not free');

  assert.equal(ledger.totals.sessions, 3);
  assert.equal(ledger.totals.sessionsUsd, 2.25);
  assert.equal(ledger.totals.unknownCost, 1);
  assert.equal(ledger.totals.turns, 28);
  assert.equal(ledger.totals.ms, 180_000);
});

test('a rung carries its vehicle’s driver, and its cost is shown beside the sessions — never added to them', () => {
  const ledger = projectLedger(JOURNAL, { id: 'r1', spentUsd: 2.25 });
  assert.equal(ledger.rungs.length, 1);
  assert.equal(ledger.rungs[0].rung, 'switch-account');
  assert.equal(ledger.rungs[0].driver, drivableBy('switch-account'));
  assert.equal(ledger.rungs[0].costUsd, 0.75);
  assert.equal(ledger.totals.rungsUsd, 0.75);
  assert.equal(ledger.totals.sessionsUsd, 2.25, 'the rung’s spend is its session’s, already counted once');
});

test('reconciliation: a gap against spentUsd is a finding; within a cent with every cost known is reconciled', () => {
  const known = JOURNAL.filter((entry) => !(entry.event === 'phase.session' && entry.data?.costSource === 'none'));
  const gap = projectLedger(known, { id: 'r1', spentUsd: 5 });
  assert.equal(gap.totals.gapUsd, 2.75);
  assert.equal(gap.totals.reconciled, false);

  const close = projectLedger(known, { id: 'r1', spentUsd: 2.25 + LEDGER_GAP_USD / 2 });
  assert.equal(close.totals.reconciled, true);

  const unknown = projectLedger(JOURNAL, { id: 'r1', spentUsd: 2.25 });
  assert.equal(unknown.totals.gapUsd, 0);
  assert.equal(unknown.totals.reconciled, false, 'a session that never reported leaves nothing to hold the total to');

  const noRun = projectLedger(JOURNAL, null);
  assert.equal(noRun.totals.spentUsd, null);
  assert.equal(noRun.totals.reconciled, null);

  assert.equal(projectLedger(JOURNAL, null, { truncated: true }).totals.truncated, true);
});

test('the summary aggregates per plan and per account, most expensive first, unknown costs counted apart', () => {
  const summary = summariseLedgers([
    { slug: 'demo', ledger: projectLedger(JOURNAL, { id: 'r1', spentUsd: 2.25 }) },
    { slug: 'other', ledger: projectLedger([START, session(5, 1, { costUsd: 4 })], { id: 'r2', spentUsd: 4 }) },
  ]);
  assert.deepEqual(summary.plans.map((row) => [row.key, row.costUsd, row.sessions, row.runs]), [
    ['other', 4, 1, 1],
    ['demo', 2.25, 3, 1],
  ]);
  const byAccount = Object.fromEntries(summary.accounts.map((row) => [row.key, row]));
  assert.equal(byAccount.default.costUsd, 5.5);
  assert.equal(byAccount.backup.costUsd, 0.75);
  assert.equal(byAccount.backup.unknownCost, 1);
  assert.equal(summary.truncatedRuns, 0);
});
