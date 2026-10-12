/**
 * `GET /api/report?since=&until=&replay=1` (quiet-console phase 25,
 * §Architecture 5; exit criterion 4): the week in numbers over this console's
 * stored runs — the week report with its ETA backtest (`metrics.phaseEta`) and
 * its holder ETA (`metrics.holderEta`) folded in, `replay=1` re-deriving them
 * with today's models — as `phase-console report` answers it, which had no
 * route.
 *
 * The fold reads every journal the console holds, so an answer is remembered
 * five minutes per question (`analysis/report-view.ts` `ReportMemo`): the same
 * question inside the window is not read again. Below the "no source
 * directory" wall. The corpus is `week-report.test.ts`'s own — two runs of one
 * made-up console (`fixtures/week-report/`).
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bareService, call, service, tempDir, wire } from './thin-read-harness.ts';
import { INSTANCE, SKILL_DIR } from '../server/config.ts';
import { REPLAY_RULES, planFactsReader, weekReportFromDir, type WeekReportOptions } from '../server/analysis/week-report.ts';
import { REPORT_DEFAULT_DAYS, REPORT_MEMO_MS, ReportMemo } from '../server/analysis/report-view.ts';
import { consoleRunsDir } from '../server/runner/run-paths.ts';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'week-report');
const SINCE = '2026-01-05T00:00:00.000Z';
const UNTIL = '2026-01-12T00:00:00.000Z';
const WEEK = `/api/report?since=${SINCE}&until=${UNTIL}`;

/** A library holding the corpus's plans, its two runs under this console's runs directory. */
function library(): string {
  const root = tempDir('p25-report');
  cpSync(join(FIXTURE, 'docs'), join(root, 'docs'), { recursive: true });
  cpSync(join(FIXTURE, 'runs', 'console-a'), consoleRunsDir(root), { recursive: true });
  return root;
}

/** The service's memo, swapped for one that counts its reads on a clock the test moves. */
function counting(svc: object, start: number) {
  const state = { reads: 0, now: start };
  const memo = new ReportMemo((dir: string, options: WeekReportOptions) => {
    state.reads += 1;
    return weekReportFromDir(dir, options);
  }, () => state.now);
  (svc as { reportMemo: ReportMemo }).reportMemo = memo;
  return state;
}

test('GET /api/report is a 409 with no source directory open', async () => {
  const svc = await bareService();
  try {
    const out = await call(svc, 'GET', WEEK);
    assert.equal(out.status, 409);
  } finally {
    svc.close();
  }
});

test('the week report, its ETA backtest and its holder ETA, folded from the two runs — and not read again inside five minutes', async () => {
  const root = library();
  const svc = await service(root);
  try {
    const clock = counting(svc, Date.parse('2026-01-12T09:00:00.000Z'));
    const expected = weekReportFromDir(consoleRunsDir(root), {
      instance: INSTANCE.name, since: SINCE, until: UNTIL, replay: [],
      factsOf: planFactsReader(root, join(SKILL_DIR, 'scripts')),
    });
    assert.ok(expected.metrics.phaseEta.records > 0, 'the corpus has phases to backtest');
    assert.ok(expected.metrics.holderEta.waits > 0, 'and waits behind a holder');

    const first = await call(svc, 'GET', WEEK);
    assert.equal(first.status, 200);
    assert.equal(first.body.cached, false);
    assert.equal(first.body.readAt, new Date(clock.now).toISOString());
    assert.deepEqual(first.body.report, wire(expected), 'the whole report, as phase-console report folds it');
    assert.deepEqual(first.body.report.metrics.phaseEta, wire(expected.metrics.phaseEta));
    assert.deepEqual(first.body.report.metrics.holderEta, wire(expected.metrics.holderEta));
    assert.equal(clock.reads, 1);

    clock.now += REPORT_MEMO_MS - 1;
    const second = await call(svc, 'GET', WEEK);
    assert.equal(second.body.cached, true, 'the same question inside five minutes');
    assert.equal(second.body.readAt, first.body.readAt, 'when its journals were read');
    assert.deepEqual(second.body.report, first.body.report);
    assert.equal(clock.reads, 1, 'no journal was read again');

    clock.now += 1;
    const third = await call(svc, 'GET', WEEK);
    assert.equal(third.body.cached, false, 'five minutes on, the journals are read again');
    assert.equal(clock.reads, 2);

    const replayed = await call(svc, 'GET', `${WEEK}&replay=1`);
    assert.equal(replayed.status, 200);
    assert.equal(replayed.body.cached, false, 'replay is a different question');
    assert.deepEqual(replayed.body.report.replay, [...REPLAY_RULES]);
    assert.equal(clock.reads, 3);
  } finally {
    svc.close();
  }
});

test('with no window named it is the week before now; a window that is not one is a 400', async () => {
  const svc = await service(library());
  try {
    const clock = counting(svc, Date.parse('2026-01-12T00:00:00.000Z'));
    const out = await call(svc, 'GET', '/api/report');
    assert.equal(out.status, 200);
    assert.equal(out.body.report.until, new Date(clock.now).toISOString());
    assert.equal(out.body.report.since, new Date(clock.now - REPORT_DEFAULT_DAYS * 86_400_000).toISOString());

    for (const query of ['since=last%20tuesday', `since=${UNTIL}&until=${SINCE}`, `since=${SINCE}&until=${SINCE}`]) {
      const refused = await call(svc, 'GET', `/api/report?${query}`);
      assert.equal(refused.status, 400, query);
      assert.match(String(refused.body.error), /since|until/);
    }
  } finally {
    svc.close();
  }
});
