/**
 * Budgets announce themselves and can be raised (control-tower phase 14, #40).
 *
 * Every budget in the console could stop a run and none could say so: a spent
 * wait budget parked a phase under a card describing CI, a spent run budget
 * halted under the generic "Run halted", and the only raise was a text editor.
 *
 *   BR-1  every spent budget — wait, phase dollars, run dollars, ladder cap,
 *         streak — carries one `BudgetFact {budget, phase, limit, spent,
 *         spentOn[]}` and announces ONCE under `budget`.
 *   BR-2  at 80% there is one `phase.budget-approaching` line and one push per
 *         budget per attempt.
 *   BR-3  the first line says BUDGET with the arithmetic, never the
 *         CI-flavoured sentence of the thing the budget stopped.
 *   BR-4  a wait raise writes the plan (behind --allow-writes), journals
 *         `run.budget-raised`, re-arms the watch, clears the errand, retries.
 *   BR-5  a dollar raise writes the run setting, journals, clears, retries.
 *   BR-6  a ladder raise writes `ladderPerRunRungs`; the streak is cleared,
 *         never raised; nonsense is refused by name.
 */
// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BUDGET_KINDS, BUDGET_WARN_PCT, budgetApproaching, budgetArithmetic, budgetFact, budgetHeadline,
} from '../shared/budget-model.js';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { journalFile, runFile } = await import('../server/runner/run-paths.ts');
const { spentBudgetPark } = await import('../server/runner/runner-loop.ts');
const { capErrand, errandFor, budgetFirst } = await import('../server/runner/ladder.ts');
const {
  evaluateWait, waitBudgetFact, waitApproaching, runBudgetFact, streakFact, claimBudgetWarning,
} = await import('../server/runner/wait-budget.ts');
const { planWrite, runWrite, WriteError } = await import('../server/writes.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { workflowTimeoutOf } = await import('../server/watch-refs.ts');
type RunState = import('../server/runner/state.ts').RunState;

const PLAN = `---
slug: alpha
created: 2026-09-22
status: active
phases: 2
---

# alpha

## Session budget

> **Wait budget:** 12h

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | cart api | 1 | — | app | it still works |

## Phases

### Phase 1 — schema
- **Size:** S
- **Verification:**
  - \`true\`

### Phase 2 — cart api
- **Size:** S
- **Waits on:** \`gh:acme/app#run/42\` · 60m
- **Verification:**
  - \`true\`
`;

const HOUR = 60 * 60_000;
const MIN = 60_000;
const T0 = Date.parse('2026-09-29T10:00:00.000Z');

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-budget-raise-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return root;
}

type Announced = { category: string; message: { title: string; body: string; tag: string; detail?: string }; context: Record<string, unknown> };

function service(root: string, flags: { allowWrites?: boolean } = {}) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: flags.allowWrites ?? true, allowRun: true,
    allowAccounts: true, scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  const announced: Announced[] = [];
  (svc as unknown as { announce: (...a: unknown[]) => null }).announce = (category, message, context) => {
    announced.push({ category, message, context } as Announced);
    return null;
  };
  const retried: { slug: string; phase: number | null }[] = [];
  (svc as unknown as Record<string, unknown>).pressRetry = async (slug: string, phase: number) => {
    retried.push({ slug, phase });
    return { ok: true, status: 200, run: null };
  };
  (svc as unknown as Record<string, unknown>).startRun = async (slug: string) => {
    retried.push({ slug, phase: null });
    return null;
  };
  return { svc, announced, retried };
}

const PRESS = { by: 'operator', via: 'api', origin: '127.0.0.1', remoteUser: null } as const;

function journal(root: string, runId: string): { event: string; phase?: number; data?: Record<string, unknown> }[] {
  return readFileSync(journalFile(root, 'alpha', runId), 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; phase?: number; data?: Record<string, unknown> });
}

/**
 * Phase 2 parked on a spent wait budget: 60m budget, 60m parked, asked for 90m
 * more. With no ref to watch (`watch: []`) it is the `budgets` errand; since
 * control-tower phase 121 a ref that still polls makes it a wait, with none.
 */
function spentWaitRun(root: string, watch: string[] = ['gh:acme/app#run/42']): RunState {
  const state = newRun({ slug: 'alpha', root });
  state.status = 'waiting';
  const record = phaseRecord(state, 2);
  record.status = 'waiting';
  record.sessionId = 'sess-2';
  record.waitHistory = [{ parkedFrom: new Date(T0 - HOUR).toISOString(), parkedUntil: new Date(T0).toISOString(), resumedAt: new Date(T0).toISOString(), by: 'session' }];
  record.waits = 1;
  const budget = { budgetMs: HOUR, source: 'phase' as const, countersignedUntil: null, refs: watch };
  spentBudgetPark(state, 2, {
    ledger: 'budget', refusal: 'the phase needs another 1.5 h parked', budget,
    declared: {
      status: 'waiting-external', watch, by: 'session',
      requested: new Date(T0 + 90 * MIN).toISOString(), budget: { ms: HOUR, source: 'phase' }, at: new Date(T0).toISOString(),
    } as never,
    at: new Date(T0).toISOString(),
  });
  saveRun(state);
  return state;
}

/* ------------------------------------------------------------------ *
 * The shared model
 * ------------------------------------------------------------------ */

test('the model: five budgets, one warning line, one arithmetic', () => {
  assert.deepEqual([...BUDGET_KINDS], ['wait', 'phase-usd', 'run-usd', 'ladder', 'streak']);
  assert.equal(BUDGET_WARN_PCT, 80);
  assert.equal(budgetApproaching(47.9, 60), false);
  assert.equal(budgetApproaching(48, 60), true, '80% is the line');
  assert.equal(budgetApproaching(60, 60), false, 'spent is not approaching');
  assert.equal(budgetApproaching(1, 0), false, 'a limit of nothing has no line');
  assert.equal(
    budgetArithmetic({ budget: 'wait', limit: 60, spent: 39.7, asked: 90 }),
    '60m wait budget · 39.7m accrued · 20.3m left · asked for 90m',
  );
  assert.equal(budgetArithmetic({ budget: 'run-usd', limit: 20, spent: 20.4 }), '$20.00 run budget · $20.40 accrued · $0.00 left');
  assert.equal(budgetArithmetic({ budget: 'wait', limit: 720, spent: 60 }), '12h wait budget · 60m accrued · 11h left');
  const fact = budgetFact({ budget: 'phase-usd', phase: 3, limit: 10, spent: 9.999, spentOn: [{ what: 'attempt 1', amount: 4.5 }] });
  assert.deepEqual(
    { budget: fact.budget, phase: fact.phase, limit: fact.limit, spent: fact.spent, left: fact.left, unit: fact.unit },
    { budget: 'phase-usd', phase: 3, limit: 10, spent: 10, left: 0, unit: 'usd' },
  );
});

/* ------------------------------------------------------------------ *
 * BR-3 — the first line says budget
 * ------------------------------------------------------------------ */

test('BR-3: a refused wait states the arithmetic first; the spent-budget errand leads with BUDGET, never with CI', () => {
  const verdict = evaluateWait({
    now: T0, requestedUntil: T0 + 90 * MIN, parkedMs: 39.7 * MIN, waits: 1,
    budget: { budgetMs: HOUR, source: 'phase', countersignedUntil: null, refs: [] }, ledger: 'session', pollable: false,
  });
  assert.equal(verdict.verdict, 'timeout');
  assert.match(verdict.reason, /^60m wait budget · 39\.7m accrued · 20\.3m left · asked for 90m — /);
  assert.match(verdict.reason, /its wait budget is 1\.0 h \(this phase's `Waits on:` bullet\)/, 'the old sentence survives behind it');

  const root = scratch();
  const state = spentWaitRun(root, []);
  const errand = state.recoveries?.['2']?.errand as Record<string, unknown> & { need: string };
  assert.match(errand.need, /^Wait budget spent — 60m wait budget · 60m accrued · 0m left · asked for 90m/);
  assert.match(errand.need, /more wait budget for phase 2/);
  assert.doesNotMatch(errand.need, /CI, a PR/);
  assert.equal(errand.decisionKey, 'budgets');

  // The ladder's own errand for a phase a budget stopped: budget first, the
  // CI-flavoured ask gone.
  const external = errandFor('blocked-declared:external', [], 2);
  assert.match(external.need, /CI, a PR/, 'the table sentence, as it stands for a real external wait');
  const fact = waitBudgetFact(phaseRecord(state, 2), { budgetMs: HOUR, source: 'phase', countersignedUntil: null, refs: [] }, { now: T0 });
  const first = budgetFirst(external, fact);
  assert.match(first.need, /^Wait budget spent — 60m wait budget/);
  assert.doesNotMatch(first.need, /CI, a PR/);
  assert.equal((first as { budget?: unknown }).budget, fact);
});

test('BR-3: when the COUNT of declared waits ran out, the headline names the count, never minutes the phase still has; a person\'s Retry re-opens it', async () => {
  const root = scratch();
  const state = newRun({ slug: 'alpha', root });
  const record = phaseRecord(state, 2);
  record.status = 'waiting';
  record.waits = 4;
  record.waitHistory = [{ parkedFrom: new Date(T0 - HOUR).toISOString(), parkedUntil: new Date(T0 - 30 * MIN).toISOString(), resumedAt: new Date(T0 - 30 * MIN).toISOString(), by: 'session' }];
  const { errand } = spentBudgetPark(state, 2, {
    ledger: 'waits', refusal: 'the phase has already declared 4 wait(s) — the most one phase may (4)',
    budget: { budgetMs: 2 * HOUR, source: 'phase', countersignedUntil: null, refs: [] },
    declared: { status: 'waiting-external', watch: [], by: 'session', at: new Date(T0).toISOString() } as never,
    at: new Date(T0).toISOString(),
  });
  assert.ok(errand, 'nothing it named can be watched, so a person is asked');
  assert.match(errand.need, /^Wait budget spent — 4 declared waits allowed · 4 declared · 0 left/);
  assert.doesNotMatch(errand.need.split(' — it needs')[0], /\dm |\dh /, 'no minutes in the headline: the time budget is not what ran out');
  assert.equal((errand as { budget?: { unit: string } }).budget?.unit, 'waits');
  const { resetForRetry } = await import('../server/runner/state.ts');
  resetForRetry(record, { by: 'operator', journal: () => {} });
  assert.equal(record.waits, undefined, 'a person\'s Retry re-opens the count');
});

/* ------------------------------------------------------------------ *
 * BR-1 — every spent budget carries one fact and announces once
 * ------------------------------------------------------------------ */

test('BR-1: the five facts carry {budget, phase, limit, spent, spentOn[]}', () => {
  const root = scratch();
  const state = spentWaitRun(root, []);
  const wait = (state.recoveries?.['2']?.errand as { budget?: ReturnType<typeof budgetFact> }).budget!;
  assert.equal(wait.budget, 'wait');
  assert.equal(wait.phase, 2);
  assert.equal(wait.limit, 60);
  assert.equal(wait.spent, 60);
  assert.equal(wait.asked, 90);
  assert.equal(wait.spentOn.length, 1, 'the one park it went on');
  assert.equal(wait.spentOn[0].amount, 60);

  const run = newRun({ slug: 'alpha', root });
  run.runBudgetUsd = 20;
  run.spentUsd = 20.4;
  phaseRecord(run, 1).costUsd = 12.4;
  phaseRecord(run, 2).costUsd = 8;
  const usd = runBudgetFact(run);
  assert.deepEqual([usd.budget, usd.phase, usd.limit, usd.spent], ['run-usd', null, 20, 20.4]);
  assert.deepEqual(usd.spentOn.map((s) => s.what), ['phase 1', 'phase 2'], 'the dearest phase first');

  run.maxConsecutiveFailures = 2;
  run.consecutiveFailures = 2;
  run.failureStreak = [1, 2];
  const streak = streakFact(run, 2);
  assert.deepEqual([streak.budget, streak.phase, streak.limit, streak.spent], ['streak', 2, 2, 2]);
  assert.deepEqual(streak.spentOn.map((s) => s.what), ['phase 1', 'phase 2']);

  const cap = capErrand({ key: 'work-in-progress', ok: false, refusal: 'ladder-budget-spent', cap: 'run-rungs', spent: 12, limit: 12, reason: 'the run rungs are spent' } as never, { phase: 2, tried: ['resume'] });
  const ladder = (cap as { budget?: ReturnType<typeof budgetFact> }).budget!;
  assert.deepEqual([ladder.budget, ladder.phase, ladder.limit, ladder.spent, ladder.setting], ['ladder', 2, 12, 12, 'ladderPerRunRungs']);
  assert.deepEqual(ladder.spentOn.map((s) => s.what), ['resume']);
});

test('BR-1: a spent budget announces under `budget` exactly once, from the runner, the errand and the inbox alike', () => {
  const root = scratch();
  const { svc, announced } = service(root);
  try {
    const state = spentWaitRun(root, []);
    const fact = (state.recoveries?.['2']?.errand as { budget: ReturnType<typeof budgetFact> }).budget;
    const onRunnerEvent = (svc as unknown as { onRunnerEvent: (e: string, d: unknown) => void }).onRunnerEvent.bind(svc);
    onRunnerEvent('run:budget', { slug: 'alpha', runId: state.id, phase: 2, state: 'spent', fact });
    onRunnerEvent('run:budget', { slug: 'alpha', runId: state.id, phase: 2, state: 'spent', fact });
    // The same spend arriving as an errand (a cap, a stored run's healer) is
    // the same announcement, not a second card beside a needs-you one.
    (svc as unknown as { announceErrand: (d: unknown) => void }).announceErrand({
      slug: 'alpha', runId: state.id, phase: 2, errand: { ...state.recoveries!['2'].errand },
    });
    const budget = announced.filter((a) => a.category === 'budget');
    assert.equal(budget.length, 1, 'once');
    assert.equal(announced.filter((a) => a.category === 'needs-you').length, 0, 'never buried under a mismatched errand');
    assert.match(budget[0].message.body, /^Wait budget spent — 60m wait budget · 60m accrued · 0m left · asked for 90m/);
    assert.match(budget[0].message.title, /alpha · phase 2/);
    assert.equal(budget[0].context.phase, 2);
    assert.equal(budget[0].context.slug, 'alpha');
  } finally {
    svc.close();
  }
});

/* ------------------------------------------------------------------ *
 * BR-2 — approaching, once per budget per attempt
 * ------------------------------------------------------------------ */

test('BR-2: a wait that will cross 80% of its budget is named at the grant, and a warning is claimed once per attempt', () => {
  const budget = { budgetMs: HOUR, source: 'phase' as const, countersignedUntil: null, refs: [] };
  assert.equal(waitApproaching({ parkedMs: 10 * MIN, grantedMs: 20 * MIN, budget }), null, '30 of 60 — under the line');
  const near = waitApproaching({ parkedMs: 30 * MIN, grantedMs: 20 * MIN, budget });
  assert.ok(near, '50 of 60 — past it before the window ends');
  assert.equal(near!.crossesInMs, 18 * MIN, 'the line is 48m: eighteen minutes into this park');
  assert.equal(waitApproaching({ parkedMs: 50 * MIN, grantedMs: 5 * MIN, budget })!.crossesInMs, 0, 'already past it');
  assert.equal(waitApproaching({ parkedMs: 60 * MIN, grantedMs: 5 * MIN, budget }), null, 'spent is not approaching');

  const record: { budgetWarned?: Record<string, string> } = {};
  assert.equal(claimBudgetWarning(record, 'wait', 'attempt-1:60'), true);
  assert.equal(claimBudgetWarning(record, 'wait', 'attempt-1:60'), false, 'the same attempt, the same budget: once');
  assert.equal(claimBudgetWarning(record, 'phase-usd', 'attempt-1:10'), true, 'another budget is its own warning');
  assert.equal(claimBudgetWarning(record, 'wait', 'attempt-2:60'), true, 'a new attempt re-arms it');
  assert.equal(claimBudgetWarning(record, 'wait', 'attempt-2:90'), true, 'so does a raise');
});

test('BR-2: an approaching budget pushes once, not urgent, and says 80%', () => {
  const root = scratch();
  const { svc, announced } = service(root);
  try {
    const fact = budgetFact({ budget: 'run-usd', limit: 20, spent: 16.5 });
    const onRunnerEvent = (svc as unknown as { onRunnerEvent: (e: string, d: unknown) => void }).onRunnerEvent.bind(svc);
    onRunnerEvent('run:budget', { slug: 'alpha', runId: 'r1', phase: null, state: 'approaching', key: 'run:20', fact });
    onRunnerEvent('run:budget', { slug: 'alpha', runId: 'r1', phase: null, state: 'approaching', key: 'run:20', fact });
    const budget = announced.filter((a) => a.category === 'budget');
    assert.equal(budget.length, 1);
    assert.equal(budget[0].message.body, `Run budget 80% spent — ${budgetArithmetic(fact)}`);
    assert.equal(budgetHeadline(fact, 'approaching'), budget[0].message.body);
  } finally {
    svc.close();
  }
});

/* ------------------------------------------------------------------ *
 * BR-4..6 — the raise
 * ------------------------------------------------------------------ */

test('BR-4: a wait raise writes the plan, journals who and by how much, re-arms the watch, clears the errand, retries', async () => {
  const root = scratch();
  const { svc, retried } = service(root);
  try {
    const state = spentWaitRun(root);
    const answer = await svc.raiseBudget('alpha', { budget: 'wait', phase: 2, add: 30 }, { ...PRESS, reason: 'the build moved to the slow box' });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    // Written where it was declared — the phase's own bullet — and read back.
    const plan = readFileSync(join(root, 'docs', 'plans', 'alpha.md'), 'utf8');
    assert.match(plan, /- \*\*Waits on:\*\* `gh:acme\/app#run\/42` · 90m/);
    const line = journal(root, state.id).find((entry) => entry.event === 'run.budget-raised');
    assert.ok(line, 'the raise left no line');
    assert.deepEqual(
      { budget: line!.data?.budget, was: line!.data?.was, now: line!.data?.now, by: line!.data?.by, via: line!.data?.via },
      { budget: 'wait', was: 60, now: 90, by: 'operator', via: 'raise-budget' },
    );
    assert.equal(line!.data?.reason, 'the build moved to the slow box');
    assert.equal(line!.phase, 2);
    const after = JSON.parse(readFileSync(runFile(root, 'alpha', state.id), 'utf8')) as RunState;
    assert.equal(after.phases['2'].declared?.budgetSpent, undefined, 'the watch is re-armed: no spent stamp holds its clock');
    assert.equal(after.recoveries?.['2']?.errand, undefined, 'the budget errand is answered');
    assert.deepEqual(retried, [{ slug: 'alpha', phase: 2 }], 'and it retries, in the same press');
  } finally {
    svc.close();
  }
});

test('BR-4: a wait raise needs --allow-writes, a phase, and a raise that raises', async () => {
  const root = scratch();
  const { svc, retried } = service(root, { allowWrites: false });
  try {
    spentWaitRun(root);
    const refused = await svc.raiseBudget('alpha', { budget: 'wait', phase: 2, add: 30 }, PRESS);
    assert.equal(refused.ok, false);
    assert.equal((refused as { status: number }).status, 403);
    assert.match((refused as { error: string }).error, /--allow-writes/);
    assert.match(readFileSync(join(root, 'docs', 'plans', 'alpha.md'), 'utf8'), /· 60m/, 'nothing written');
    assert.deepEqual(retried, []);
  } finally {
    svc.close();
  }
  const { svc: svc2 } = service(scratch());
  try {
    assert.equal(((await svc2.raiseBudget('alpha', { budget: 'wait', add: 30 }, PRESS)) as { status: number }).status, 400);
  } finally {
    svc2.close();
  }
  assert.equal(planWrite({ action: 'wait-budget', slug: 'alpha', phase: 2, minutes: 90 } as never, { root: '/r' }).script, 'wait-budget.sh');
  assert.deepEqual(
    planWrite({ action: 'wait-budget', slug: 'alpha', phase: 2, minutes: 90, refs: ['gh:acme/app#run/9'] } as never, { root: '/r' }).args,
    ['alpha', '--phase', '2', '--ref', 'gh:acme/app#run/9', '90m'],
  );
  assert.throws(() => planWrite({ action: 'wait-budget', slug: 'alpha', phase: 2, minutes: 0 } as never, { root: '/r' }), WriteError);
});

test('BR-5: a dollar raise writes the run setting, journals, clears the halt and continues the run', async () => {
  const root = scratch();
  const { svc, retried } = service(root);
  try {
    const state = newRun({ slug: 'alpha', root });
    state.status = 'halted';
    state.runBudgetUsd = 20;
    state.spentUsd = 20.4;
    state.halt = { at: new Date(T0).toISOString(), reason: 'the run budget of $20 is spent', kind: 'budget', budget: runBudgetFact(state) } as never;
    state.errand = { ...errandFor('resource-wall:budget', [], 0) };
    saveRun(state);
    const answer = await svc.raiseBudget('alpha', { budget: 'run-usd', add: 10 }, PRESS);
    assert.equal(answer.ok, true, JSON.stringify(answer));
    const after = JSON.parse(readFileSync(runFile(root, 'alpha', state.id), 'utf8')) as RunState;
    assert.equal(after.runBudgetUsd, 30);
    assert.equal(after.halt, null);
    assert.equal(after.errand ?? null, null);
    const line = journal(root, state.id).find((entry) => entry.event === 'run.budget-raised');
    assert.deepEqual([line?.data?.budget, line?.data?.was, line?.data?.now, line?.data?.via], ['run-usd', 20, 30, 'raise-budget']);
    assert.deepEqual(retried, [{ slug: 'alpha', phase: null }], 'the run continues');

    const phase = await svc.raiseBudget('alpha', { budget: 'phase-usd', phase: 2, to: 25 }, PRESS);
    assert.equal(phase.ok, true, JSON.stringify(phase));
    const again = JSON.parse(readFileSync(runFile(root, 'alpha', state.id), 'utf8')) as RunState;
    assert.equal(again.phaseBudgetUsd, 25);
    assert.deepEqual(retried.at(-1), { slug: 'alpha', phase: 2 }, 'a phase cap retries the phase');
  } finally {
    svc.close();
  }
});

test('BR-6: a ladder raise writes ladderPerRunRungs and retries; the streak is cleared, never raised; nonsense is refused by name', async () => {
  const root = scratch();
  const { svc, retried } = service(root);
  try {
    const state = newRun({ slug: 'alpha', root });
    state.status = 'parked';
    phaseRecord(state, 2).status = 'parked';
    const cap = capErrand({ key: 'work-in-progress', ok: false, refusal: 'ladder-budget-spent', cap: 'run-rungs', spent: 12, limit: 12, reason: 'the run rungs are spent' } as never, { phase: 2, tried: [] });
    (state.recoveries ??= {})['2'] = { attempts: 1, lastAt: new Date(T0).toISOString(), errand: cap };
    saveRun(state);
    const answer = await svc.raiseBudget('alpha', { budget: 'ladder', phase: 2, add: 4 }, PRESS);
    assert.equal(answer.ok, true, JSON.stringify(answer));
    const after = JSON.parse(readFileSync(runFile(root, 'alpha', state.id), 'utf8')) as RunState;
    assert.equal(after.ladderPerRunRungs, 16);
    assert.equal(after.recoveries?.['2']?.errand, undefined);
    const line = journal(root, state.id).find((entry) => entry.event === 'run.budget-raised');
    assert.deepEqual([line?.data?.budget, line?.data?.was, line?.data?.now, line?.data?.setting], ['ladder', 12, 16, 'ladderPerRunRungs']);
    assert.deepEqual(retried, [{ slug: 'alpha', phase: 2 }]);

    const streak = await svc.raiseBudget('alpha', { budget: 'streak' }, PRESS);
    assert.equal((streak as { status: number }).status, 400);
    assert.match((streak as { error: string }).error, /clear-streak/);
    assert.equal(((await svc.raiseBudget('alpha', { budget: 'nope' } as never, PRESS)) as { status: number }).status, 400);
    const lower = await svc.raiseBudget('alpha', { budget: 'ladder', phase: 2, to: 3 }, PRESS);
    assert.equal((lower as { status: number }).status, 400, 'a raise that lowers is not a raise');
    assert.equal(((await svc.raiseBudget('nobody', { budget: 'run-usd', add: 5 }, PRESS)) as { status: number }).status, 404);
  } finally {
    svc.close();
  }
});

test('BR-4: a live run reads its wait budget at every park, so a raise written to the plan is what the next park meets', async () => {
  // #40's thread, 2026-09-26: a phase raised from 180m to 360m on the plan
  // parked again three minutes later on "3.0 h, this phase's Waits on: bullet"
  // — the runner had read the budget once for its whole life.
  const root = scratch();
  const scripts = join(SKILL_DIR, 'scripts');
  const state = newRun({ slug: 'alpha', root });
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: scripts,
    spawn: async () => { throw new Error('no session is spawned in this test'); },
    onEvent: (event: string, data: Record<string, unknown>) => { events.push({ event, data }); },
  } as never);
  const handle = instance as never as Record<string, unknown>;
  handle.state = state;
  handle.persist = () => {};
  const read = (handle.waitBudgetOf as (phase: number) => Promise<{ budgetMs: number; source: string }>).bind(instance);
  assert.equal((await read(2)).budgetMs, HOUR);
  const outcome = await runWrite(planWrite({ action: 'wait-budget', slug: 'alpha', phase: 2, minutes: 360 }, { root }), { scriptsDir: scripts, root });
  assert.equal(outcome.ok, true, outcome.stderr);
  const after = await read(2);
  assert.equal(after.budgetMs, 6 * HOUR, 'the next park reads the plan the console shows');
  assert.equal(after.source, 'phase');

  // And the live door of the raise answers the hold on the loop's own state.
  const record = phaseRecord(state, 2);
  record.status = 'waiting';
  record.declared = { status: 'waiting-external', watch: ['gh:acme/app#run/42'], by: 'session', at: new Date(T0).toISOString(), budgetSpent: { at: new Date(T0).toISOString(), ledger: 'budget' } } as never;
  (state.recoveries ??= {})['2'] = { attempts: 0, lastAt: '', errand: { ...errandFor('waiting-external', [], 2), decisionKey: 'budgets' } } as never;
  handle.record = (event: string, data: Record<string, unknown>, phase?: number) => { events.push({ event, data: { ...data, phase } }); };
  const cleared = (handle.budgetRaised as (d: Record<string, unknown>) => string[]).call(instance, {
    budget: 'wait', phase: 2, was: 60, now: 360, by: 'operator', via: 'raise-budget',
  });
  // Retiring the spent stamp answers the `budgets` errand with it.
  assert.deepEqual(cleared, ['spent-wait']);
  assert.equal(record.declared?.budgetSpent, undefined);
  assert.equal(state.recoveries?.['2']?.errand, undefined);
  const line = events.find((e) => e.event === 'run.budget-raised');
  assert.deepEqual([line?.data.budget, line?.data.was, line?.data.now, line?.data.phase], ['wait', 60, 360, 2]);
});

/* ------------------------------------------------------------------ *
 * The workflow timeout F36 is told
 * ------------------------------------------------------------------ */

test('the workflow timeout: the longest job, and GitHub\'s six hours for a job that states none', () => {
  const yaml = [
    'name: ci',
    'on: [push]',
    'jobs:',
    '  build:',
    '    runs-on: self-hosted',
    '    timeout-minutes: 100',
    '    steps:',
    '      - run: make',
    '        timeout-minutes: 500',
    '  lint:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 15',
  ].join('\n');
  assert.equal(workflowTimeoutOf(yaml), 100, 'job-level only: a step timeout bounds nothing the job does not');
  assert.equal(workflowTimeoutOf(`${yaml}\n  deploy:\n    runs-on: x\n`), 360, 'a job with no timeout runs up to 360');
  assert.equal(workflowTimeoutOf('name: nothing here'), null);
});

test('BR-7: an approaching budget is kept on its holder until a raise answers it, so a page can draw it before the park (phase 25)', async () => {
  const { RunnerBase } = await import('../server/runner/runner-base.ts');
  const { RunnerControl } = await import('../server/runner/runner-control.ts');
  const lines: [string, Record<string, unknown>][] = [];
  const state = {
    phases: { '4': { phase: 4, status: 'running', attempts: 1, costUsd: 8.5 } },
    spentUsd: 16.5,
  } as unknown as Record<string, unknown> & { phases: Record<string, Record<string, unknown>> };
  const self = {
    state,
    record: (name: string, data: Record<string, unknown>) => lines.push([name, data]),
    emit: () => {},
    persist: () => {},
  };
  const note = (RunnerBase.prototype as unknown as { noteBudgetApproaching: (...a: unknown[]) => void }).noteBudgetApproaching;
  const runFact = budgetFact({ budget: 'run-usd', limit: 20, spent: 16.5 });
  const phaseFact = budgetFact({ budget: 'phase-usd', limit: 10, spent: 8.5, phase: 4 });
  note.call(self, 'run', null, runFact, 'run:20');
  note.call(self, 'phase', 4, phaseFact, '1:10');
  assert.deepEqual((state as { budgetApproaching?: unknown }).budgetApproaching, { 'run-usd': runFact });
  assert.deepEqual(state.phases['4']!.budgetApproaching, { 'phase-usd': phaseFact });
  assert.equal(lines.filter(([name]) => name === 'phase.budget-approaching').length, 2);

  // A raise answers the approach: the card that offered it goes.
  const raised = (RunnerControl.prototype as unknown as { budgetRaised: (...a: unknown[]) => string[] }).budgetRaised;
  raised.call(self, { budget: 'phase-usd', phase: 4, was: 10, now: 20 });
  assert.deepEqual(state.phases['4']!.budgetApproaching, {});
  assert.deepEqual((state as { budgetApproaching?: unknown }).budgetApproaching, { 'run-usd': runFact }, 'the run budget still approaches');
});
