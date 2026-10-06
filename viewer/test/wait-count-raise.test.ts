/**
 * The declared-wait COUNT, raisable by the plan — and a wait whose ref still
 * polls reads as a wait (control-tower phase 121, #40's 2026-10-01 asks).
 *
 * `WAIT_MAX_PER_PHASE` (4) was a constant: a release phase that waited on
 * five builds was refused its fifth wait however much of its time budget was
 * left, and the refusal filed an errand naming a person ("re-check by hand")
 * while the build it waited on was ten minutes from landing.
 *
 *   WC-1  `**Wait count:** <n>` (plan) and `- **Wait count:** <n>` (phase),
 *         read through the engine, raise the count the park is judged on, and
 *         the refusal names the line that would raise it;
 *   WC-2  a park on a spent count — or a spent time budget — whose ref still
 *         polls is a WAIT on that ref: no errand, no "by hand", the note naming
 *         the ref; with nothing pollable the errand stands, naming both lines;
 *   WC-3  the run reads `waiting` on that ref, never `parked` with nothing
 *         ready.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { DEFAULT_WAIT_BUDGET, WAIT_MAX_PER_PHASE, evaluateWait, waitBudgetFrom } = await import('../server/runner/wait-budget.ts');
const { spentBudgetPark } = await import('../server/runner/runner-loop.ts');
const { newRun, phaseRecord } = await import('../server/runner/state.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { dateOfRef, liveRefs, stillLiveRefs } = await import('../server/watch-refs.ts');
const { SKILL_DIR } = await import('../server/config.ts');
type RunState = import('../server/runner/state.ts').RunState;

const NOW = Date.parse('2026-10-05T10:00:00Z');
const REF = 'gh:acme/app#run/42';

function engine(args: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'pc-wait-count-'));
  try {
    mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
    cpSync(join(SKILL_DIR, 'tests', 'fixtures', 'plans', 'operator-acts.md'), join(dir, 'docs', 'plans', 'operator-acts.md'));
    const run = spawnSync('bash', [join(SKILL_DIR, 'scripts', 'phase-graph.sh'), 'operator-acts', ...args], {
      encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, DOCS_ROOT: dir, XDG_STATE_HOME: join(dir, 'state') },
    });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('WC-1 — the plan raises the count: the engine reads it, the park is judged on it, the refusal names the line', () => {
  // The engine's two answers, as the runner reads them (`RunnerBase.waitBudgetOf`).
  const phase = waitBudgetFrom('', '', dateOfRef, engine(['--wait-count', '1']));
  assert.equal(phase.waitsMax, 8);
  assert.equal(phase.waitsSource, 'phase');
  const plan = waitBudgetFrom('', '', dateOfRef, engine(['--wait-count', '2']));
  assert.deepEqual([plan.waitsMax, plan.waitsSource], [6, 'plan']);
  const silent = waitBudgetFrom('', '', dateOfRef, '');
  assert.deepEqual([silent.waitsMax, silent.waitsSource], [WAIT_MAX_PER_PHASE, 'default']);
  assert.equal(DEFAULT_WAIT_BUDGET.waitsMax ?? WAIT_MAX_PER_PHASE, 4);

  const ask = (waits: number, budget = phase) => evaluateWait({
    now: NOW, requestedUntil: NOW + 30 * 60_000, parkedMs: 60 * 60_000, waits, budget, ledger: 'session', pollable: true,
  });
  assert.equal(ask(4).verdict, 'park', 'the fifth wait of a phase the plan allows eight');
  assert.equal(ask(7).verdict, 'park');
  const spent = ask(8);
  assert.equal(spent.verdict, 'timeout');
  if (spent.verdict !== 'timeout') return;
  assert.equal(spent.ledger, 'waits');
  assert.match(spent.reason, /the most one phase may \(8, this phase's `Wait count:` bullet\)/);
  // The console's own four still hold a plan that says nothing.
  assert.equal(ask(4, silent).verdict, 'timeout');
});

test('WC-2 — a spent count whose ref still polls is a WAIT on that ref: no errand, nothing "by hand"', () => {
  const state = newRun({ slug: 'demo', root: '/home/x/repo', onlyPhases: [7] } as never) as RunState;
  const record = phaseRecord(state, 7);
  record.waits = 6;
  const budget = { ...DEFAULT_WAIT_BUDGET, waitsMax: 6, waitsSource: 'plan' as const };
  const { errand, fact, data } = spentBudgetPark(state, 7, {
    ledger: 'waits', refusal: 'the phase has already declared 6 wait(s)', budget,
    declared: { status: 'waiting-external', watch: [REF], by: 'session', at: new Date(NOW).toISOString() } as never,
    at: new Date(NOW).toISOString(),
  });
  assert.equal(errand, null, 'no errand: nothing needs a person');
  assert.equal(state.recoveries?.['7']?.errand, undefined);
  assert.equal(record.status, 'waiting');
  assert.equal(record.parkedUntil, undefined, 'no clock of its own — the ref is the clock');
  assert.ok(record.declared?.budgetSpent, 'stamped spent, so the watch keeps polling past the budget');
  assert.match(record.note ?? '', /^waiting on gh:acme\/app#run\/42 — /);
  assert.doesNotMatch(record.note ?? '', /by hand/);
  assert.equal(fact.limit, 6, "the fact is the plan's count, not the console's four");
  assert.equal(data.polling, true);

  // A spent TIME budget with a live ref reads the same (#40, 2026-10-01T14:07Z).
  const timed = newRun({ slug: 'demo', root: '/home/x/repo', onlyPhases: [8] } as never) as RunState;
  const t = spentBudgetPark(timed, 8, {
    ledger: 'budget', refusal: 'Wait budget spent', budget: DEFAULT_WAIT_BUDGET,
    declared: { status: 'waiting-external', watch: [REF], by: 'session', at: new Date(NOW).toISOString() } as never,
  });
  assert.equal(t.errand, null);

  // Nothing pollable: only a person moves it, and the errand names BOTH lines.
  const blind = newRun({ slug: 'demo', root: '/home/x/repo', onlyPhases: [9] } as never) as RunState;
  phaseRecord(blind, 9).waits = 4;
  const b = spentBudgetPark(blind, 9, {
    ledger: 'waits', refusal: 'the phase has already declared 4 wait(s)', budget: DEFAULT_WAIT_BUDGET,
    declared: { status: 'waiting-external', watch: [], by: 'session', at: new Date(NOW).toISOString() } as never,
  });
  assert.ok(b.errand, 'with nothing to watch, a person is asked');
  assert.match(b.errand!.how ?? '', /- \*\*Wait count:\*\* <n>/);
});

test('WC-3 — the run reads WAITING on the ref, not parked with nothing ready', () => {
  const runner = new Runner({ scriptsDir: join(SKILL_DIR, 'scripts'), spawn: (async () => { throw new Error('no spawn'); }) as never });
  try {
    const state = newRun({ slug: 'demo', root: '/home/x/repo', onlyPhases: [7] } as never) as RunState;
    const record = phaseRecord(state, 7);
    spentBudgetPark(state, 7, {
      ledger: 'waits', refusal: 'the phase has already declared 4 wait(s)', budget: DEFAULT_WAIT_BUDGET,
      declared: { status: 'waiting-external', watch: [REF], by: 'session', at: new Date(NOW).toISOString() } as never,
    });
    assert.equal(record.status, 'waiting');
    (runner as unknown as { state: RunState }).state = state;
    const entered = (runner as unknown as { enterRunWaiting(now: string): boolean }).enterRunWaiting(new Date(NOW).toISOString());
    assert.equal(entered, true, 'a wait on a polling ref is a wait');
    assert.equal(state.status, 'waiting');
    assert.equal(state.waitReason, 'external');
    assert.match(state.finishedReason ?? '', /gh:acme\/app#run\/42/);
    assert.doesNotMatch(state.finishedReason ?? '', /resumes at undefined/);
  } finally {
    runner.close();
  }
});

test('a spent park is a wait only while a LIVE ref is out: a date alone, or live refs the clock has refused, is a person\'s again', () => {
  const at = '2026-10-05T10:00:00.000Z';
  const budget = { budgetMs: 60 * 60_000, source: 'phase' as const, countersignedUntil: null, refs: [] };
  const park = (watch: string[], refused: string[] = []) => {
    const state = newRun({ slug: 'alpha', root: '/tmp/whatever' });
    const record = phaseRecord(state, 2);
    record.status = 'waiting';
    record.waits = 4;
    if (refused.length) {
      record.watchState = { at, refs: refused.map((ref) => ({ ref, scheme: 'unit' as const, state: 'refused' as const, detail: 'no such host' })) } as never;
    }
    const { errand } = spentBudgetPark(state, 2, {
      ledger: 'waits', refusal: 'the phase has already declared 4 wait(s) — the most one phase may (4, the console default)', budget,
      declared: { status: 'waiting-external', watch, by: 'session', at } as never, at,
    });
    return { errand, record };
  };
  // A date is a clock, not a watch — it does not hold a spent park off a person.
  assert.deepEqual(liveRefs(['date:2026-10-06T09:00:00Z', 'gh:acme/app#run/42']).map((t) => t.ref), ['gh:acme/app#run/42']);
  assert.equal(park(['date:2026-10-06T09:00:00Z']).errand?.decisionKey, 'budgets', 'a date alone still asks a person');
  // A live ref out: a wait, no errand.
  const live = park(['unit:build-box/nightly-build.service']);
  assert.equal(live.errand, null);
  assert.match(live.record.note ?? '', /^waiting on unit:build-box\/nightly-build\.service — its wait budget is spent/);
  // The same ref, refused by the clock for good: nothing is watched, so a person is asked.
  const refused = park(['unit:build-box/nightly-build.service'], ['unit:build-box/nightly-build.service']);
  assert.equal(stillLiveRefs(refused.record).length, 0);
  assert.equal(refused.errand?.decisionKey, 'budgets');
  assert.match(refused.errand?.how ?? '', /Nothing it named can be watched/);
});
