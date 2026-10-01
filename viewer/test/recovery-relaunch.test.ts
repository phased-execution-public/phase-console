/**
 * A stop about the plan is answered by the plan (control-tower phase 81, #97).
 *
 * Measured on hub 4123, 2026-09-24: observability-plane halted `plan-lint` on
 * phase 14 (phase 26's in-progress handoff lacked its "Start next phase(s)"
 * section). The console then wrote `resolved: superseded — the board shows
 * phase 14 done` over it: the resolver reads the halt's anchor, and a
 * plan-lint halt's anchor is always done, because the lint runs after the
 * phase closes. The handoff was fixed and `validate.sh` went green; converge
 * never relaunched the run (a resolved run is pinned), Recover answered
 * `errand` ("the board had already moved past the halt"), and the run sat
 * halted with three phases ready until somebody sent a start by hand. The same
 * run halted `plan-lint` again at 00:50Z the next day and waited 3.5 hours for
 * a press — whose "superseded" step then relaunched it WITHOUT asking the lint.
 *
 * RR-4: Recover relaunches a resolved or superseded halt once the plan lints
 * clean — and never before: a red lint is answered with the lint's own
 * finding, and a lint that could not run relaunches nothing.
 * RR-5: converge re-checks a plan-lint halt when the plan changes on disk. The
 * halt survives the read path (a phase reading done does not supersede a stop
 * about the plan), the check is the lint the page already caches per revision,
 * and a clean lint relaunches through converge's one door.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { planConvergence } = await import('../server/converge.ts');
const { loadRun, newRun, phaseRecord, runDir, saveRun } = await import('../server/runner/state.ts');
type RunState = import('../server/runner/state.ts').RunState;
type LintResult = import('../server/engine.ts').LintResult;
type ConvergeFacts = import('../server/converge.ts').ConvergeFacts;

const PLAN = `---
slug: alpha
created: 2026-08-06
status: active
phases: 3
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | cart api | 1 | — | app | it still works |
| 3 | checkout | 2 | — | app | it ships |

## Phases

### Phase 1 — schema
- **Size:** S
- **Verification:** \`true\`

### Phase 2 — cart api
- **Size:** S
- **Verification:** \`true\`

### Phase 3 — checkout
- **Size:** S
- **Verification:** \`true\`
`;

/** What `validate.sh` says of the plan while phase 2's handoff lacks its boot section. */
const LINT_RED = 'VALIDATE FAIL: alpha — 1 handoff problem(s)';

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-recovery-relaunch-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return root;
}

/**
 * A complete handoff `validate.sh` accepts — frontmatter agreeing with the
 * graph, a written "What this phase did", and the boot section. `bootSection:
 * false` is the #97 defect: the one section it checks for, missing.
 */
function handoff(root: string, phase: number, dependsOn: number[], opts: { bootSection?: boolean } = {}): void {
  const title = ['schema', 'cart-api', 'checkout'][phase - 1];
  const boot = opts.bootSection === false ? '' : '\n## ▶ Start next phase(s)\nNothing to add.\n';
  writeFileSync(join(root, 'docs', 'handoffs', 'alpha', `phase-0${phase}-${title}.md`), `---
plan: docs/plans/alpha.md
phase: ${phase}
title: ${title}
status: complete
depends_on: [${dependsOn.join(', ')}]
---
# Phase ${phase} — ${title}

## What this phase did
It did the work it was asked to.
${boot}`, 'utf8');
}

function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  return svc;
}

function lint(ok: boolean, extra: Partial<LintResult> = {}): LintResult {
  return {
    ok,
    issues: ok ? [] : ['phase-02-cart-api.md: missing the boot section'],
    summary: ok ? 'VALIDATE OK: alpha' : LINT_RED,
    timedOut: false, crashed: false, ...extra,
  };
}

/** Stub the service's lint and count the asks. */
function stubLint(svc: ReturnType<typeof service>, answer: () => LintResult): { asked: () => number } {
  let asked = 0;
  (svc as never as Record<string, unknown>).lint = async () => { asked += 1; return answer(); };
  return { asked: () => asked };
}

function stubStart(svc: ReturnType<typeof service>): Array<{ slug: string; options: Record<string, unknown> }> {
  const started: Array<{ slug: string; options: Record<string, unknown> }> = [];
  (svc as never as Record<string, unknown>).startRun = async (slug: string, options: Record<string, unknown>) => {
    started.push({ slug, options });
    return null;
  };
  return started;
}

const GREEN = { ok: true, reason: '1 command green', notRun: [], ran: [{ command: 'true', ok: true, code: 0, ms: 1, output: '' }] };
/** The live #97 record: a LATER attempt of phase 2 had run its §Verification red, which holds the record (D27). */
const RED_LATER = {
  ok: false, reason: '`true` exited 1', notRun: [],
  ran: [{ command: 'true', ok: false, code: 1, ms: 1, output: '' }, { command: 'true', ok: false, code: 1, ms: 1, output: '', retry: true }],
};

/**
 * The run the lint stopped: phase 2 closed its work, verified it, then left the
 * plan failing `validate.sh` — `runner-attempt.ts` marks the record `failed`
 * and halts the RUN `plan-lint` anchored on it.
 */
function lintHalted(root: string, over: Partial<RunState> = {}, verification: object = GREEN): RunState {
  handoff(root, 1, []);
  handoff(root, 2, [1], { bootSection: false });
  const state = newRun({ slug: 'alpha', root });
  state.status = 'halted';
  state.stoppedBy = 'system';
  state.activePhase = 2;
  state.halt = { at: new Date().toISOString(), reason: `phase 2 left the plan failing validate.sh: ${LINT_RED}`, phase: 2, kind: 'plan-lint' };
  state.finishedReason = state.halt.reason;
  const one = phaseRecord(state, 1);
  one.status = 'done'; one.attempts = 1;
  const two = phaseRecord(state, 2);
  two.status = 'failed'; two.attempts = 1;
  two.verification = verification as never;
  two.lint = { ok: false, summary: LINT_RED };
  Object.assign(state, over);
  saveRun(state);
  return state;
}

const SUPERSEDED = () => ({ at: new Date().toISOString(), auto: true, reason: 'superseded — the board shows phase 2 done' });

function journal(root: string, runId: string): Array<{ event: string; data: Record<string, unknown> }> {
  let text = '';
  try { text = readFileSync(join(runDir(root, 'alpha'), `run-${runId}.jsonl`), 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { event: string; data: Record<string, unknown> });
}

/* ------------------------------------------------------------------ *
 * RR-4 — Recover relaunches a resolved or superseded halt once the plan
 * lints clean, and never before
 * ------------------------------------------------------------------ */

test('RR-4: Recover over the #97 run — plan-lint halt, "superseded", the plan now lints clean — relaunches it, and says the lint is why', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    try {
      const state = lintHalted(root, { resolved: SUPERSEDED() }, RED_LATER);
      handoff(root, 2, [1]); // the handoff was fixed
      const { asked } = stubLint(svc, () => lint(true));
      const started = stubStart(svc);

      const report = await svc.recoverPlan('alpha', { by: 'operator', door: 'operator' } as never);
      assert.equal(report.outcome, 'resumed', `${report.outcome}: ${report.detail}`);
      assert.equal(started.length, 1, 'the run continues in the same press');
      assert.equal(started[0]!.options.resumeRunId, state.id, 'through the one door, as the run it was');
      assert.ok(asked() >= 1, 'the plan\'s lint was asked before anything was relaunched');
      assert.ok(report.steps.some((step) => /lints clean/.test(step)), report.steps.join(' | '));

      const after = loadRun(root, 'alpha', state.id)!;
      assert.equal(after.halt, null, 'the stop the lint answered is gone on disk');
      assert.equal(after.resolved ?? null, null, 'and so is the "superseded" written over it');
      assert.ok(journal(root, state.id).some((line) => line.event === 'run.plan-recover' && line.data.step === 'lint-clean'),
        'journalled as the lint answering it');
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RR-4: a plan that STILL fails validate.sh is not relaunched — the press answers with the lint\'s own finding, and the halt stands', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    try {
      // The fresh shape (green verification, record reconcilable): the read
      // path used to dissolve this halt, and the press then relaunched straight
      // into the same red lint, which halted the run again a phase later.
      const state = lintHalted(root);
      stubLint(svc, () => lint(false));
      const started = stubStart(svc);

      const report = await svc.recoverPlan('alpha', { by: 'operator', door: 'operator' } as never);
      assert.equal(report.outcome, 'errand', `${report.outcome}: ${report.detail}`);
      assert.equal(started.length, 0, 'nothing is relaunched into a red lint');
      assert.match(report.detail, /VALIDATE FAIL: alpha/, 'the answer quotes what validate.sh said');
      assert.equal(report.errand?.situation, 'plan-broken:lint');

      const after = loadRun(root, 'alpha', state.id)!;
      assert.equal(after.halt?.kind, 'plan-lint', 'the stop stands, still saying what it is');
      assert.ok(journal(root, state.id).some((line) => line.event === 'run.plan-recover' && line.data.step === 'lint-red'));
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RR-4: a lint that could not RUN relaunches nothing and says so — "I could not check" is not "it is clean"', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    try {
      lintHalted(root, { resolved: SUPERSEDED() }, RED_LATER);
      stubLint(svc, () => lint(false, { timedOut: true, summary: '' }));
      const started = stubStart(svc);

      const report = await svc.recoverPlan('alpha', { by: 'operator', door: 'operator' } as never);
      assert.equal(report.outcome, 'nothing-to-do', `${report.outcome}: ${report.detail}`);
      assert.equal(started.length, 0);
      assert.match(report.detail, /lint could not run/i);
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RR-4: a phase-less stop a person already dismissed is relaunched by their Recover once the plan lints clean — never "the stop is already resolved"', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    try {
      handoff(root, 1, []);
      handoff(root, 2, [1]);
      const state = newRun({ slug: 'alpha', root });
      state.status = 'halted';
      state.stoppedBy = 'system';
      state.halt = { at: new Date().toISOString(), reason: 'the engine could not read the plan: the engine timed out reading this plan', kind: 'plan-unreadable' };
      state.finishedReason = state.halt.reason;
      state.resolved = { at: new Date().toISOString(), auto: false, reason: 'dismissed by the operator', by: 'mo' };
      phaseRecord(state, 1).status = 'done';
      phaseRecord(state, 2).status = 'done';
      saveRun(state);
      stubLint(svc, () => lint(true));
      const started = stubStart(svc);

      const report = await svc.recoverPlan('alpha', { by: 'operator', door: 'operator' } as never);
      assert.equal(report.outcome, 'resumed', `${report.outcome}: ${report.detail}`);
      assert.equal(started.length, 1);
      assert.equal(started[0]!.options.resumeRunId, state.id);
      const after = loadRun(root, 'alpha', state.id)!;
      assert.equal(after.halt, null);
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RR-4: a stop an OLDER console dissolved and marked superseded — no halt left, the plan still red — is answered by the lint, not relaunched', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    try {
      // What the pre-#97 read path left behind: the plan-lint halt dissolved,
      // "superseded" written over the run, the plan never fixed.
      handoff(root, 1, []);
      handoff(root, 2, [1], { bootSection: false });
      const state = newRun({ slug: 'alpha', root });
      state.status = 'parked';
      state.stoppedBy = 'system';
      state.resolved = SUPERSEDED();
      state.finishedReason = 'halted on phase 2; the board has since closed it — nothing is left of the halt';
      phaseRecord(state, 1).status = 'done';
      phaseRecord(state, 2).status = 'done';
      saveRun(state);
      const { asked } = stubLint(svc, () => lint(false));
      const started = stubStart(svc);

      const report = await svc.recoverPlan('alpha', { by: 'operator', door: 'operator' } as never);
      assert.equal(report.outcome, 'errand', `${report.outcome}: ${report.detail}`);
      assert.equal(asked(), 1, 'the settled mark an older reading left is re-asked of the lint');
      assert.equal(started.length, 0, 'nothing is relaunched into the same red lint');
      assert.match(report.detail, /VALIDATE FAIL: alpha/);
      assert.match(report.detail, /press Recover again/, 'no stop is left for converge to answer, and the answer says so');
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------ *
 * RR-5 — converge re-checks a plan-lint halt when the plan changes on disk
 * ------------------------------------------------------------------ */

function facts(run: RunState, over: Partial<ConvergeFacts> = {}): ConvergeFacts {
  return {
    slug: 'alpha', now: Date.now(), trigger: 'timer',
    board: { 1: 'done', 2: 'done', 3: 'ready' },
    runs: [run], live: new Set(), locks: [], prefs: {},
    ...over,
  };
}

function stored(over: Partial<RunState> = {}): RunState {
  const state = newRun({ slug: 'alpha', root: '/nowhere' });
  state.status = 'halted';
  state.stoppedBy = 'system';
  state.activePhase = 2;
  state.halt = { at: new Date().toISOString(), reason: `phase 2 left the plan failing validate.sh: ${LINT_RED}`, phase: 2, kind: 'plan-lint' };
  phaseRecord(state, 1).status = 'done';
  phaseRecord(state, 2).status = 'done';
  Object.assign(state, over);
  return state;
}

test('RR-5: a plan-lint halt the board "superseded" is relaunched the moment the plan lints clean', () => {
  const run = stored({ resolved: SUPERSEDED() });
  const plan = planConvergence({ ...facts(run), lint: lint(true) } as ConvergeFacts);
  const relaunch = plan.actions.find((action) => action.kind === 'relaunch');
  assert.ok(relaunch, `a clean lint relaunches: ${JSON.stringify(plan.actions)}`);
  assert.equal(relaunch.kind === 'relaunch' && relaunch.runId, run.id);
  assert.match(relaunch.kind === 'relaunch' ? relaunch.why.join(' ') : '', /lints clean/);
  assert.ok(!plan.actions.some((action) => action.kind === 'heal'), 'a stop about the plan climbs no ladder');
});

test('RR-5: while the lint is red the run stays down, and the pass says what validate.sh said — no relaunch, no heal', () => {
  for (const resolved of [null, SUPERSEDED()]) {
    const plan = planConvergence({ ...facts(stored({ resolved })), lint: lint(false) } as ConvergeFacts);
    assert.ok(!plan.actions.some((action) => action.kind === 'relaunch' || action.kind === 'heal'),
      `resolved=${Boolean(resolved)}: ${JSON.stringify(plan.actions)}`);
    const skip = plan.actions.find((action) => action.kind === 'skip');
    assert.match(skip?.kind === 'skip' ? skip.why : '', /still fails validate\.sh.*VALIDATE FAIL: alpha/);
  }
});

test('RR-5: a lint that could not run decides nothing — the pass waits for the next one', () => {
  const plan = planConvergence({ ...facts(stored()), lint: lint(false, { crashed: true, summary: '' }) } as ConvergeFacts);
  assert.ok(!plan.actions.some((action) => action.kind === 'relaunch' || action.kind === 'heal'), JSON.stringify(plan.actions));
});

test('RR-5: a person\'s dismissal and an operator\'s stop still pin the run, whatever the lint says', () => {
  const dismissed = stored({ resolved: { at: new Date().toISOString(), auto: false, reason: 'dismissed by the operator' } });
  const stopped = stored({ stoppedBy: 'operator' });
  for (const run of [dismissed, stopped]) {
    const plan = planConvergence({ ...facts(run), lint: lint(true) } as ConvergeFacts);
    assert.ok(!plan.actions.some((action) => action.kind === 'relaunch'), JSON.stringify(plan.actions));
  }
});

test('RR-5: end to end — the halt survives the read path, the red plan holds it, and the fixed handoff landing on disk relaunches it', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    try {
      const state = lintHalted(root);
      const started = stubStart(svc);

      // The read path is what used to dissolve it: phase 2's record is
      // reconcilable, and closing it took the halt anchored on it along — then
      // the resolver pinned the run as "superseded".
      const read = (await svc.runsFor('alpha')).find((run) => run.id === state.id)!;
      assert.equal(read.halt?.kind, 'plan-lint', 'a phase reading done does not supersede a stop about the plan');
      assert.equal(read.resolved ?? null, null, 'and nothing resolves it as superseded');

      // The real engine: validate.sh is red while the boot section is missing.
      const red = await svc.convergeNow('alpha', 'change');
      assert.ok(red, 'converge ran');
      assert.equal(started.length, 0, `nothing relaunches into the red lint: ${JSON.stringify(red!.actions)}`);

      // The fix lands on disk; the page's revision moves, and so does the lint.
      handoff(root, 2, [1]);
      (svc as never as { reread: (slug: string) => void }).reread('alpha');
      const green = await svc.convergeNow('alpha', 'change');
      assert.equal(started.length, 1, `the clean plan relaunches the run: ${JSON.stringify(green?.actions)}`);
      assert.equal(started[0]!.options.resumeRunId, state.id);
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
