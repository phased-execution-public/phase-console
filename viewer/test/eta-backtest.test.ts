/**
 * The estimator ships only if it beats the baseline it replaces
 * (control-tower phase 58, #65, EB-1..2).
 *
 * The audit's strawman — the median of a plan's last seven raw durations,
 * no sizes, no weights — beat the old EMA on both of its measures. So the bar
 * here is not "principled", it is "better": every measured phase predicted at
 * its first boarding from the phases that had finished before it, by both
 * estimators on the same evidence, and the new one must come out at least as
 * often within ×2 AND with no larger mean absolute log error.
 *
 *   EB-1  over the committed corpus — the 520 measured phases two consoles on
 *         the machine this was written on had stored on 2026-09-25, names
 *         taken out (`fixtures/eta/backtest-corpus.json`, written by
 *         `node viewer/server/analysis/eta-backtest.ts … --corpus`);
 *   EB-2  over a console's LIVE stored runs, when `PE_ETA_BACKTEST_RUNS`
 *         names them (`<runs dir>=<repo root>`, `;`-separated) — reading
 *         real state is an opt-in, never a default of the suite;
 *   EB-3  the extraction itself, over a stored-runs directory built here: the
 *         journal re-measure, the exclusions, the plan's sizes.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BASELINE_FALLBACK_MS, BASELINE_WINDOW, anonymise, backtest, baselineEstimate, modelEstimate, planFacts,
  recordsFromRuns, scorePairs, type BacktestRecord,
} from '../server/analysis/eta-backtest.ts';

const MIN = 60_000;
const HOUR = 3_600_000;
const WEIGHTS = { S: 15_000, M: 40_000, L: 90_000 };

const CORPUS = join(import.meta.dirname, 'fixtures', 'eta', 'backtest-corpus.json');

const show = (label: string, r: ReturnType<typeof backtest>) =>
  `${label}: estimator MALE ${r.estimator.male.toFixed(3)} / within ×2 ${(100 * r.estimator.within2).toFixed(1)} % — `
  + `baseline MALE ${r.baseline.male.toFixed(3)} / within ×2 ${(100 * r.baseline.within2).toFixed(1)} % (n=${r.records})`;

test('EB-1: over the committed corpus the estimator beats the naive recent-median on BOTH measures', (t) => {
  const { records } = JSON.parse(readFileSync(CORPUS, 'utf8')) as { records: BacktestRecord[] };
  assert.ok(records.length >= 500, `the corpus holds ${records.length} measured phases`);
  const result = backtest(records);
  t.diagnostic(show('corpus', result));
  assert.ok(result.estimator.within2 >= result.baseline.within2, show('within ×2', result));
  assert.ok(result.estimator.male <= result.baseline.male, show('MALE', result));
  assert.equal(result.ships, true);
});

test('EB-1: …and on each console of the corpus alone, and on its newer half cold', (t) => {
  const { records } = JSON.parse(readFileSync(CORPUS, 'utf8')) as { records: BacktestRecord[] };
  const consoles = [...new Set(records.map((r) => r.instance))];
  assert.ok(consoles.length >= 2);
  for (const id of consoles) {
    const result = backtest(records.filter((r) => r.instance === id));
    t.diagnostic(show(id, result));
    assert.equal(result.ships, true, show(id, result));
  }
  const cut = [...records].sort((a, b) => a.startedAt.localeCompare(b.startedAt))[Math.floor(records.length / 2)]!.startedAt;
  const newer = backtest(records.filter((r) => r.startedAt >= cut));
  t.diagnostic(show(`from ${cut.slice(0, 10)}, no older history`, newer));
  assert.equal(newer.ships, true, show('newer half', newer));
});

test('EB-2: over live stored runs, when a person names them', (t) => {
  const spec = process.env.PE_ETA_BACKTEST_RUNS;
  if (!spec) {
    t.skip('PE_ETA_BACKTEST_RUNS is unset — set it to `<runs dir>=<repo root>[;…]` to replay a console’s own runs');
    return;
  }
  const records: BacktestRecord[] = [];
  for (const pair of spec.split(';').filter(Boolean)) {
    const [runs, docs] = pair.split('=');
    const instance = runs!.replace(/\/+$/, '').split('/').pop()!;
    records.push(...recordsFromRuns(runs!, instance, (slug) => {
      const path = join(docs!, 'docs', 'plans', `${slug}.md`);
      return existsSync(path) ? planFacts(readFileSync(path, 'utf8'), slug, WEIGHTS) : null;
    }).records);
  }
  const result = backtest(records);
  t.diagnostic(show('live', result));
  assert.ok(result.records > 0, 'the named runs hold measured phases');
  assert.equal(result.ships, true, show('live', result));
});

/* ------------------------------------------------------------------ *
 * The pieces
 * ------------------------------------------------------------------ */

const rec = (plan: string, i: number, workedMin: number, size: 'S' | 'M' | 'L' = 'M'): BacktestRecord => ({
  instance: 'c', plan, phase: i, size, weight: WEIGHTS[size],
  startedAt: new Date(Date.UTC(2026, 8, 1, i)).toISOString(),
  endedAt: new Date(Date.UTC(2026, 8, 1, i) + workedMin * MIN).toISOString(),
  workedMs: workedMin * MIN,
});

test('the baseline is the median of the plan’s newest seven, else the console’s, else an hour', () => {
  const target = rec('a', 50, 60);
  assert.equal(baselineEstimate([], target), BASELINE_FALLBACK_MS);
  const other = [10, 20, 30].map((m, i) => rec('b', i, m));
  assert.equal(baselineEstimate(other, target), 20 * MIN, 'no plan evidence: the console’s');
  const own = [100, 1, 1, 50, 60, 70, 80, 90, 99].map((m, i) => rec('a', 10 + i, m));
  assert.equal(BASELINE_WINDOW, 7);
  assert.equal(baselineEstimate([...other, ...own], target), 70 * MIN, 'the newest seven of the plan’s own');
});

test('the model is predicted from the past only: a phase is never evidence for itself', () => {
  const records = [rec('a', 0, 40), rec('a', 1, 40), rec('a', 2, 40), rec('a', 3, 400)];
  const result = backtest(records);
  assert.equal(result.records, 4);
  // The 400-minute phase is scored against a forecast that never saw it.
  const prior = records.slice(0, 3);
  assert.ok(modelEstimate(prior, records[3]!) < 2 * HOUR);
});

test('scoring is the audit’s: mean |ln(actual ÷ estimate)| and the share within ×2', () => {
  const score = scorePairs([[2, 1], [1, 2], [1, 1], [8, 1]]);
  assert.equal(score.n, 4);
  assert.ok(Math.abs(score.male - (Math.log(2) * 2 + Math.log(8)) / 4) < 1e-12);
  assert.equal(score.within2, 0.75);
  assert.equal(score.under2, 1);
  assert.equal(score.over2, 0);
});

test('EB-3: stored runs are read with every session re-measured from the journal, and non-measurements left out', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-eta-backtest-'));
  try {
    const runs = join(root, 'runs');
    mkdirSync(join(runs, 'demo'), { recursive: true });
    const t0 = Date.parse('2026-09-20T10:00:00Z');
    const at = (m: number) => new Date(t0 + m * MIN).toISOString();
    writeFileSync(join(runs, 'demo', 'run-abc123.json'), JSON.stringify({
      id: 'abc123',
      phases: {
        '1': { phase: 1, status: 'done', attempts: 1, startedAt: at(0), attemptStartedAt: at(0), attemptEndedAt: at(40), endedAt: at(40), durationMs: 40 * MIN },
        '2': { phase: 2, status: 'done', attempts: 1, startedAt: at(50), attemptStartedAt: at(50), attemptEndedAt: at(50.2), endedAt: at(120), durationMs: 12_000 },
        '3': { phase: 3, status: 'done', attempts: 1, startedAt: at(130), endedAt: at(131), durationMs: 5_000 },
        '4': { phase: 4, status: 'running', attempts: 1, startedAt: at(140), attemptStartedAt: at(140) },
      },
    }));
    writeFileSync(join(runs, 'demo', 'run-abc123.jsonl'), [
      { event: 'phase.session', phase: 2, time: at(90), data: { mode: 'resume', ms: 30 * MIN } },
      { event: 'phase.session', phase: 2, time: at(120), data: { mode: 'closeout', ms: 10 * MIN } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n{"half-written');
    const plan = [
      '# demo', '', '## Phase graph', '', '| Phase | Title | Depends on | Repos |', '|---|---|---|---|',
      '| 1 | one | — | x |', '| 2 | two | 1 | x |', '| 3 | three | 2 | x |', '| 4 | four | 3 | x |', '',
      '### Phase 1 — one', '- **Size:** L', '', '### Phase 2 — two', '- **Size:** S', '',
      '### Phase 3 — three', '', '### Phase 4 — four', '',
    ].join('\n');
    const { records, missing } = recordsFromRuns(runs, 'console-x', (slug) =>
      (slug === 'demo' ? planFacts(plan, slug, WEIGHTS) : null));
    assert.deepEqual(records.map((r) => [r.phase, r.size, r.weight]), [[1, 'L', 90_000], [2, 'S', 15_000]]);
    assert.equal(records[0]!.workedMs, 40 * MIN);
    assert.ok(Math.abs(records[1]!.workedMs - (12_000 + 40 * MIN)) < 1_000, 'the resume and closeout are its work');
    assert.equal(missing, 1, 'the five-second completion is counted, not used');
    const [named] = anonymise(records);
    assert.equal(named!.instance, 'console-a');
    assert.equal(named!.plan, 'plan-01');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
