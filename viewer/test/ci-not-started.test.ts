/**
 * A CI run GitHub refused to start is not a red CI (control-tower phase 111, #166).
 *
 * On 2026-09-26 GitHub refused to start any Actions job for one repository
 * for 7.5 hours: its own Actions budget read `consumed_amount 10.0` of 10 with
 * `prevent_further_usage`. Every run on the plan's closing PR ended
 * `completed: failure` in 1–3 s — no runner, no step, one annotation: "The job
 * was not started because recent account payments have failed or your
 * spending limit needs to be increased". The watch read that as a landing, and
 * the resume brief sent four sessions to fix a CI that never ran.
 *
 *   CI-1  the probe reads the jobs: every failed job with no runner and no
 *         step, under the "not started" annotation, is `not-run (billing)` —
 *         a wait that stays open, never a landing, naming the budget and its
 *         consumed amount when the token can read them;
 *   CI-2  the errand says so once; the budget gaining room lands the ref with
 *         "re-run the failed jobs (`gh run rerun <id> --failed`)", and the
 *         ref keeps following the run's newest attempt;
 *   CI-3  the Tower draws ONE "CI refused (billing)" state per repository.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ciRefusedErrand, landingDirective, parseWatchRef, probeWatchRef, type WatchState } from '../server/watch-refs.ts';
import { WatchScheduler } from '../server/watch-scheduler.ts';
import { newRun, phaseRecord } from '../server/runner/state.ts';
import { CI_NOT_RUN_LABELS, ciRefusalsOf } from '../shared/ci-refusal.js';

const REPO = 'acme/app';
const RUN = '36231511254';
const REF = `gh:${REPO}#run/${RUN}`;
const NOT_STARTED = 'The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the \'Billing & plans\' section in your settings';

/** How the probe's reads say they are GETs — `$*` as the fake sees it. */
const JSON_GET = '-H Accept: application/vnd.github+json';

/** A fake `gh` on PATH that answers from files in its own directory. */
function fakeGh(files: Record<string, unknown>): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-gh-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(body), 'utf8');
  writeFileSync(join(dir, 'gh'), [
    '#!/bin/bash',
    'd="$(dirname "$0")"',
    'answer() { if [ -f "$d/$1" ]; then cat "$d/$1"; else echo "HTTP 403: Resource not accessible by integration" >&2; exit 1; fi; }',
    'case "$*" in',
    `  "run view ${RUN} --repo ${REPO} --json status,conclusion") answer run.json ;;`,
    `  "api repos/${REPO}/actions/runs/${RUN}/jobs?per_page=100 ${JSON_GET}") answer jobs.json ;;`,
    `  "api repos/${REPO}/check-runs/111/annotations ${JSON_GET}") answer annotations.json ;;`,
    `  "api organizations/acme/settings/billing/budgets ${JSON_GET}") answer budgets.json ;;`,
    `  "api organizations/acme/settings/billing/budgets/b-repo ${JSON_GET}") answer budget-repo.json ;;`,
    '  *) echo "unexpected gh $*" >&2; exit 1 ;;',
    'esac',
    '',
  ].join('\n'), 'utf8');
  chmodSync(join(dir, 'gh'), 0o755);
  return { dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` } };
}

const refusedJob = (id: number, name: string) => ({
  id, name, status: 'completed', conclusion: 'failure', run_attempt: 1,
  runner_id: null, runner_name: null, steps: [], started_at: '2026-09-26T09:01:02Z', completed_at: '2026-09-26T09:01:03Z',
});

const REFUSED = {
  'run.json': { status: 'completed', conclusion: 'failure' },
  'jobs.json': { total_count: 2, jobs: [refusedJob(111, 'integrity'), refusedJob(112, 'no-api-base-fallback')] },
  'annotations.json': [{ path: '.github', annotation_level: 'failure', message: NOT_STARTED }],
  'budgets.json': {
    budgets: [
      { id: 'b-repo', budget_scope: 'repository', budget_entity_name: REPO, budget_product_sku: 'actions', budget_amount: 10, prevent_further_usage: true },
      { id: 'b-copilot', budget_scope: 'organization', budget_entity_name: 'acme', budget_product_sku: 'copilot', budget_amount: 50, prevent_further_usage: true },
    ],
  },
  'budget-repo.json': { id: 'b-repo', budget_scope: 'repository', budget_entity_name: REPO, budget_product_sku: 'actions', budget_amount: 10, consumed_amount: 10.0, prevent_further_usage: true },
};

const target = () => {
  const t = parseWatchRef(REF);
  assert.ok(t && t.kind === 'gh-run');
  return t!;
};

/* ------------------------------------------------------------------ *
 * CI-1 — the probe tells a refusal from a red run
 * ------------------------------------------------------------------ */

test('CI-1: a run GitHub never started is not-run (billing), a wait that stays open, naming the budget', async () => {
  const gh = fakeGh(REFUSED);
  try {
    const verdict = await probeWatchRef(target(), { env: gh.env });
    assert.equal(verdict.state, 'pending', 'never a landing: there is no result to read');
    assert.match(verdict.detail ?? '', /^not-run \(billing\)/);
    assert.match(verdict.detail ?? '', /\$10(\.00)? of \$10(\.00)?/, 'the budget and its consumed amount');
    assert.equal(verdict.notRun?.cause, 'billing');
    assert.equal(verdict.notRun?.repo, REPO);
    assert.equal(verdict.notRun?.run, RUN);
    assert.equal(verdict.notRun?.jobs, 2);
    assert.match(verdict.notRun?.annotation ?? '', /spending limit/);
    assert.deepEqual(verdict.notRun?.budgets, [{ scope: 'repository', name: REPO, amount: 10, consumed: 10, stops: true }]);
    assert.equal(verdict.notRun?.headroom, false);
  } finally { rmSync(gh.dir, { recursive: true, force: true }); }
});

test('CI-1: a run whose jobs ran and failed is still a red CI — completed: failure, a landing', async () => {
  const gh = fakeGh({
    ...REFUSED,
    'jobs.json': { total_count: 1, jobs: [{ ...refusedJob(111, 'integrity'), runner_id: 7, runner_name: 'GitHub Actions 7', steps: [{ name: 'Run tests', conclusion: 'failure', number: 3 }] }] },
  });
  try {
    const verdict = await probeWatchRef(target(), { env: gh.env });
    assert.equal(verdict.state, 'landed');
    assert.equal(verdict.detail, 'completed: failure');
    assert.equal(verdict.notRun, undefined);
  } finally { rmSync(gh.dir, { recursive: true, force: true }); }
});

test('CI-1: no runner and no step but another annotation is not called billing', async () => {
  const gh = fakeGh({ ...REFUSED, 'annotations.json': [{ annotation_level: 'failure', message: 'The workflow is not valid.' }] });
  try {
    const verdict = await probeWatchRef(target(), { env: gh.env });
    assert.equal(verdict.state, 'landed');
    assert.equal(verdict.notRun, undefined);
  } finally { rmSync(gh.dir, { recursive: true, force: true }); }
});

test('CI-1: a token that cannot read the budget still classifies the refusal, and says what it could not read', async () => {
  const files: Record<string, unknown> = { ...REFUSED };
  delete files['budgets.json'];
  const gh = fakeGh(files);
  try {
    const verdict = await probeWatchRef(target(), { env: gh.env });
    assert.equal(verdict.state, 'pending');
    assert.equal(verdict.notRun?.cause, 'billing');
    assert.equal(verdict.notRun?.budgets, undefined);
    assert.match(verdict.notRun?.unreadable ?? '', /organizations\/acme\/settings\/billing\/budgets/);
    assert.match(verdict.detail ?? '', /cannot read the Actions budget/);
    assert.equal(verdict.notRun?.headroom, undefined);
  } finally { rmSync(gh.dir, { recursive: true, force: true }); }
});

test('CI-1: a jobs read that fails falls back to the plain verdict — never worse than before', async () => {
  const files: Record<string, unknown> = { ...REFUSED };
  delete files['jobs.json'];
  const gh = fakeGh(files);
  try {
    const verdict = await probeWatchRef(target(), { env: gh.env });
    assert.equal(verdict.state, 'landed');
    assert.equal(verdict.detail, 'completed: failure');
  } finally { rmSync(gh.dir, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------ *
 * CI-2 — the errand, the landing on headroom, the brief
 * ------------------------------------------------------------------ */

function waitingRun() {
  const state = newRun({ slug: 'alpha', root: '/tmp/whatever' });
  state.status = 'waiting';
  const record = phaseRecord(state, 11);
  record.status = 'waiting';
  record.declared = { status: 'waiting-external', reason: 'CI on the closing PR', watch: [REF], at: new Date().toISOString() } as never;
  return state;
}

function scheduler(state: ReturnType<typeof waitingRun>, answers: WatchState[], seen: WatchState[], landed: WatchState[]) {
  const clock = new WatchScheduler({
    runs: () => [{ slug: 'alpha', state }],
    probe: async () => answers.shift()!,
    onLanded: async (_slug: string, _state: unknown, _phase: number, l: WatchState) => { landed.push(l); return 'resumed' as const; },
    onNotRun: (_slug: string, _state: unknown, _phase: number, v: WatchState) => { seen.push(v); },
    save: () => {},
  } as never);
  clock.open();
  return clock;
}

const billing = (headroom: boolean | undefined, consumed = 10, amount = 10): WatchState => ({
  ref: REF, state: 'pending',
  detail: `not-run (billing): GitHub did not start 2 jobs — budget ${consumed} of ${amount}`,
  notRun: {
    cause: 'billing', repo: REPO, run: RUN, jobs: 2, annotation: NOT_STARTED,
    budgets: [{ scope: 'repository', name: REPO, amount, consumed, stops: true }],
    ...(headroom === undefined ? {} : { headroom }),
  },
});

test('CI-2: the refusal is handed to the errand writer once, not every pass', async () => {
  const state = waitingRun();
  const seen: WatchState[] = [];
  const landed: WatchState[] = [];
  const clock = scheduler(state, [billing(false), billing(false), billing(false)], seen, landed);
  try {
    // Every row due on each pass: the cadence is not what this tests.
    for (let pass = 0; pass < 3; pass += 1) {
      for (const row of state.phases['11'].watchState?.refs ?? []) row.nextDueAt = 0;
      await clock.tick();
    }
    assert.equal(seen.length, 1, 'one errand for one refusal');
    assert.equal(landed.length, 0, 'and nothing resumed: no CI ran');
    const row = state.phases['11'].watchState?.refs[0];
    assert.equal(row?.state, 'pending');
    assert.equal(row?.notRun?.cause, 'billing', 'the row keeps what it read');
  } finally { clock.close(); }
});

test('CI-2: the budget gaining room lands the ref, and the landing says re-run the failed jobs', async () => {
  const state = waitingRun();
  const seen: WatchState[] = [];
  const landed: WatchState[] = [];
  const clock = scheduler(state, [billing(false), billing(true, 10, 20)], seen, landed);
  try {
    await clock.tick();
    for (const row of state.phases['11'].watchState?.refs ?? []) row.nextDueAt = 0;
    await clock.tick();
    assert.equal(landed.length, 1, 'the room is the landing');
    assert.equal(landed[0].state, 'landed');
    assert.match(landed[0].detail ?? '', /^not-run \(billing\)/);
    assert.match(landed[0].detail ?? '', /room again/);
    const directive = landingDirective(landed[0]);
    assert.match(directive, new RegExp(`gh run rerun ${RUN} --repo ${REPO.replace('/', '\\/')} --failed`));
    assert.match(directive, /same ref/, 'and the watch follows the new attempt');
  } finally { clock.close(); }
});

test('CI-2: room at first sight is not a landing — the refusal is not the budget, and the errand says so', async () => {
  const state = waitingRun();
  const seen: WatchState[] = [];
  const landed: WatchState[] = [];
  const clock = scheduler(state, [billing(true, 3, 10)], seen, landed);
  try {
    await clock.tick();
    assert.equal(landed.length, 0, 'nothing changed that a re-run would fix');
    assert.equal(seen.length, 1);
    const errand = ciRefusedErrand(seen[0].notRun!, REF);
    assert.match(errand.need, /payment method/);
  } finally { clock.close(); }
});

test('CI-2: the errand names the repository, the budget and its consumed amount, and the re-run', () => {
  const spent = ciRefusedErrand(billing(false).notRun!, REF);
  assert.match(spent.need, /GitHub Actions refused to start/);
  assert.match(spent.need, /acme\/app/);
  assert.match(spent.need, /\$10(\.00)? of \$10(\.00)?/);
  assert.match(spent.how, /organizations\/acme\/settings\/billing\/budgets/);
  assert.match(spent.how, new RegExp(`gh run rerun ${RUN} --repo acme/app --failed`));
  const blind = ciRefusedErrand({ cause: 'billing', repo: REPO, run: RUN, jobs: 2, annotation: NOT_STARTED, unreadable: 'HTTP 403' }, REF);
  assert.match(blind.need, /cannot read/);
  assert.match(blind.how, /gh api organizations\/acme\/settings\/billing\/budgets/, 'the check a person can run');
});

/* ------------------------------------------------------------------ *
 * CI-3 — one state per repository
 * ------------------------------------------------------------------ */

test('CI-3: the Tower draws ONE "CI refused (billing)" state per repository, across runs and phases', () => {
  const row = (ref: string, repo: string, run: string, state: 'pending' | 'landed' = 'pending') => ({
    ref, scheme: 'gh-run', state, checkedAt: '2026-09-26T09:05:00Z',
    notRun: { cause: 'billing', repo, run, jobs: 1, annotation: NOT_STARTED, budgets: [{ scope: 'repository', name: repo, amount: 10, consumed: 10, stops: true }], headroom: false },
  });
  const run = (id: string, slug: string, status: string, phases: Record<string, unknown>) => ({ id, slug, status, phases });
  const runs = [
    run('r1', 'vca-refactor', 'waiting', {
      11: { phase: 11, status: 'waiting', watchState: { at: 'x', refs: [row('gh:acme/app#run/1', 'acme/app', '1')] } },
      12: { phase: 12, status: 'waiting', watchState: { at: 'x', refs: [row('gh:acme/app#run/2', 'acme/app', '2')] } },
    }),
    run('r2', 'hub-tidy', 'waiting', {
      3: { phase: 3, status: 'waiting', watchState: { at: 'x', refs: [row('gh:acme/app#run/3', 'acme/app', '3'), row('gh:acme/aws#run/9', 'acme/aws', '9')] } },
    }),
    // A finished run, and a refusal that has since landed, are no longer standing.
    run('r3', 'old', 'finished', { 1: { phase: 1, status: 'done', watchState: { at: 'x', refs: [row('gh:acme/web#run/4', 'acme/web', '4')] } } }),
    run('r4', 'moved-on', 'waiting', { 2: { phase: 2, status: 'waiting', watchState: { at: 'x', refs: [row('gh:acme/web#run/5', 'acme/web', '5', 'landed')] } } }),
  ];
  const states = ciRefusalsOf(runs as never);
  assert.deepEqual(states.map((s) => s.repo), ['acme/app', 'acme/aws'], 'one per repository, never one per phase');
  const app = states[0];
  assert.equal(app.label, CI_NOT_RUN_LABELS.billing);
  assert.equal(app.label, 'CI refused (billing)');
  assert.deepEqual(app.phases.map((p) => `${p.slug}/P${p.phase}`), ['hub-tidy/P3', 'vca-refactor/P11', 'vca-refactor/P12']);
  assert.deepEqual(app.budgets, [{ scope: 'repository', name: 'acme/app', amount: 10, consumed: 10, stops: true }]);
});
