/**
 * A gate that clears somewhere else wakes the run it holds (control-tower
 * phase 51, #48) — and a closed plan's run is never woken at all.
 *
 * The measured shape: a phase the run had BOARDED three times was gated behind
 * another plan's phases (`- **Gate-check:** plan <other>:10,11`). The runner
 * parked it `gated`, and then nothing could wake it: the healer's fingerprint
 * read only this plan's board, locks and stamps, so the other plan finishing
 * moved no term of it and every later pass skipped with "nothing has changed";
 * and the "board opened up" relaunch fired only for a ready phase the run had
 * NEVER boarded. The gate honoured the hold and never the release.
 *
 *   CG-1  a boarded phase whose record reads `gated` is re-boarded when its
 *         gate now reads clear — and not a pass before; the verdict is part of
 *         the fingerprint, so a latch taken while it read blocked cannot
 *         swallow the clearing.
 *   CG-2  boarded or never boarded: a never-boarded ready phase still boards by
 *         itself, and a phase whose FIRST boarding met the gate (no session
 *         yet) re-boards fresh when it clears.
 *   CG-3  the gather step asks for the outstanding phases' verdicts only, the
 *         wake is counted like every automatic resume and bounded by the same
 *         cap — and through a real console, a cross-plan gate is read FRESH,
 *         never from a cache keyed on the gated plan's revision.
 *   CG-4  a run whose plan is CLOSED is settled once (`run.closed-plan`), and
 *         never woken, re-armed or re-boarded, whatever its gates say.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const {
  planConvergence, executeConvergence, convergePlan, evidenceFingerprint, MAX_BOOT_RESUMES,
} = await import('../server/converge.ts');
const { newRun, phaseRecord, saveRun, loadRun, journalFile } = await import('../server/runner/state.ts');
type RunState = import('../server/runner/state.ts').RunState;
type ConvergeFacts = import('../server/converge.ts').ConvergeFacts;
type ConvergeDeps = import('../server/converge.ts').ConvergeDeps;
type ConvergeAction = import('../server/converge.ts').ConvergeAction;

const SCRIPTS = join(SKILL_DIR, 'scripts');
const NOW = Date.parse('2026-09-24T10:00:00Z');

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** Phases 1–3 done, 4 gated behind another plan, 5–6 waiting on 4 — the #48 board. */
const BOARD: Record<number, string> = { 1: 'done', 2: 'done', 3: 'done', 4: 'in-progress', 5: 'waiting', 6: 'waiting' };

/** The #48 run: parked because nothing was ready, phase 4 boarded three times and now `gated`. */
function parkedOnGate(): RunState {
  const state = newRun({ slug: 'alpha', root: '/tmp/alpha' });
  state.status = 'parked';
  state.halt = { at: '2026-09-22T23:40:18.564Z', reason: 'nothing is ready: every remaining phase is gated or waiting', kind: 'nothing-ready' };
  for (const phase of [1, 2, 3]) phaseRecord(state, phase).status = 'done';
  const record = phaseRecord(state, 4);
  record.status = 'gated';
  record.attempts = 3;
  record.resumeSessionId = 'sess-4';
  record.note = 'gate not clear: blocked — beta phase(s) 10 11 not verified';
  record.gate = { clear: false, kind: 'blocked', detail: 'beta phase(s) 10 11 not verified' } as never;
  return state;
}

function facts(over: Partial<ConvergeFacts> = {}): ConvergeFacts {
  return {
    slug: 'alpha', now: NOW, trigger: 'timer', board: BOARD, runs: [], live: new Set(), locks: [],
    prefs: { resumeAtBoot: 'auto' }, pidAlive: () => false,
    ...over,
  };
}

const kinds = (plan: { actions: { kind: string }[] }) => plan.actions.map((a) => a.kind);
const skipWhy = (plan: { actions: ({ kind: string } & { why?: string })[] }) =>
  plan.actions.filter((a) => a.kind === 'skip').map((a) => a.why ?? '').join(' | ');
const relaunchOf = (plan: { actions: ConvergeAction[] }) =>
  plan.actions.find((a): a is Extract<ConvergeAction, { kind: 'relaunch' }> => a.kind === 'relaunch');

function stubDeps(state: RunState, over: Partial<ConvergeDeps> = {}) {
  const started: Array<Record<string, unknown>> = [];
  const lines: Array<{ runId: string; event: string; data: Record<string, unknown>; phase?: number }> = [];
  const deps: ConvergeDeps = {
    now: () => NOW,
    runs: () => [state],
    live: () => new Set(),
    board: async () => BOARD,
    locks: () => [],
    prefs: () => ({ resumeAtBoot: 'auto' }),
    pidAlive: () => false,
    heal: async () => ({ launched: false, reason: 'nothing to climb' }),
    startRun: async (_slug, options) => { started.push(options as never); return null; },
    editRun: (_slug, _runId, apply) => { apply(state); return state; },
    releaseLock: async () => ({ ok: true }),
    journal: (_slug, runId, event, data, phase) => { lines.push({ runId, event, data, ...(phase === undefined ? {} : { phase }) }); },
    ...over,
  };
  return { deps, started, lines };
}

/* ------------------------------------------------------------------ *
 * CG-1 — the boarded phase
 * ------------------------------------------------------------------ */

test('CG-1: a boarded phase gated behind another plan is re-boarded when that gate clears — and not a pass before', () => {
  const state = parkedOnGate();
  const held = planConvergence(facts({ runs: [state], gates: { 4: 'blocked' } }));
  assert.equal(relaunchOf(held), undefined, `the gate still holds: nothing is launched (${kinds(held)})`);
  assert.deepEqual(kinds(held), ['heal'], 'the healer may look; the run is not started');

  const cleared = planConvergence(facts({ runs: [state], gates: { 4: 'clear' } }));
  const relaunch = relaunchOf(cleared);
  assert.ok(relaunch, `the gate cleared: a relaunch (${kinds(cleared)})`);
  assert.deepEqual(relaunch.reboard.map((ask) => ask.phase), [4], 'the gated record is asked to re-board — `gated` is settled, so a bare start would never pick it up');
  assert.equal(relaunch.reboard[0].rung, 'resume-own-session', 'it boarded before and has a session to continue');
  assert.equal(relaunch.reboard[0].sessionId, 'sess-4');
  assert.equal(relaunch.reboard[0].by, 'converge');
  assert.deepEqual(relaunch.counted, [{ phase: 4, path: 'gate-cleared', sessionId: 'sess-4' }], 'counted like every automatic resume');
  assert.match(relaunch.why.join(' '), /gate on phase 4 now reads clear/);
});

test('CG-1: the gate verdict is evidence — a latch taken while it read blocked cannot swallow its clearing', () => {
  const state = parkedOnGate();
  const blocked = evidenceFingerprint(state, BOARD, [], null, null, NOW, null, { 4: 'blocked' });
  const clear = evidenceFingerprint(state, BOARD, [], null, null, NOW, null, { 4: 'clear' });
  assert.notEqual(blocked, clear, 'another plan finishing moves a term of THIS run\'s fingerprint');
  assert.equal(
    evidenceFingerprint(state, BOARD, [], null, null, NOW, null, { 4: 'blocked' }), blocked,
    'the same verdict twice is the same evidence',
  );
  // Latched while blocked: the next pass over the same verdict stays quiet…
  const quiet = planConvergence(facts({ runs: [state], gates: { 4: 'blocked' }, lastNoop: blocked }));
  assert.match(skipWhy(quiet), /nothing has changed/);
  // …and the pass that finds it clear does not.
  assert.ok(relaunchOf(planConvergence(facts({ runs: [state], gates: { 4: 'clear' }, lastNoop: blocked }))));
});

/* ------------------------------------------------------------------ *
 * CG-2 — boarded or never boarded
 * ------------------------------------------------------------------ */

test('CG-2: a never-boarded ready phase boards by itself — its gate is the runner\'s to check at boarding', () => {
  const state = parkedOnGate();
  delete state.phases['4'];
  const board = { ...BOARD, 4: 'ready' };
  for (const verdict of ['blocked', 'clear']) {
    const relaunch = relaunchOf(planConvergence(facts({ runs: [state], board, gates: { 4: verdict } })));
    assert.ok(relaunch, `never boarded, gate ${verdict}: the board opened up`);
    assert.deepEqual(relaunch.reboard, [], 'a ready phase with no record is a candidate already — no ask is needed');
    assert.match(relaunch.why.join(' '), /never boarded it/);
  }
});

test('CG-2: a phase whose FIRST boarding met the gate re-boards fresh when it clears', () => {
  const state = parkedOnGate();
  const record = state.phases['4'];
  record.attempts = 0;
  delete record.resumeSessionId;
  const board = { ...BOARD, 4: 'ready' };
  assert.equal(relaunchOf(planConvergence(facts({ runs: [state], board, gates: { 4: 'blocked' } }))), undefined,
    'boarded (its record exists) and still blocked: nothing to launch');
  const relaunch = relaunchOf(planConvergence(facts({ runs: [state], board, gates: { 4: 'clear' } })));
  assert.ok(relaunch);
  assert.deepEqual(relaunch.reboard.map((ask) => [ask.phase, ask.rung, ask.sessionId]), [[4, 'reboard-fresh', undefined]],
    'no session ever ran: it boards from its boot prompt');
});

test('CG-2: the operator\'s stop and a resolved run stay pinned, whatever the gate says', () => {
  const stopped = parkedOnGate();
  stopped.stoppedBy = 'operator';
  assert.equal(relaunchOf(planConvergence(facts({ runs: [stopped], gates: { 4: 'clear' } }))), undefined);
  const resolved = parkedOnGate();
  resolved.resolved = { at: new Date(NOW).toISOString(), auto: false, reason: 'dismissed', by: 'operator' };
  assert.equal(relaunchOf(planConvergence(facts({ runs: [resolved], gates: { 4: 'clear' } }))), undefined);
});

/* ------------------------------------------------------------------ *
 * CG-3 — gathered, counted, bounded; and read fresh by a real console
 * ------------------------------------------------------------------ */

test('CG-3: the gather step asks for the outstanding phases\' verdicts only; the wake re-boards and is counted', async () => {
  const state = parkedOnGate();
  const asked: number[][] = [];
  const { deps, started, lines } = stubDeps(state, {
    gates: async (_slug, phases) => { asked.push([...phases]); return { 4: 'clear' }; },
  });
  const report = await convergePlan(deps, 'alpha', 'timer');
  assert.deepEqual(asked, [[4]], 'the done phases, and the ones still waiting on dependencies, are never asked about');
  assert.equal(report.launched, true);
  assert.equal(started.length, 1);
  const reboard = started[0].reboard as Array<{ phase: number }>;
  assert.deepEqual(reboard.map((ask) => ask.phase), [4]);
  const resumes = lines.filter((l) => l.event === 'phase.resume-automatic');
  assert.deepEqual(resumes.map((l) => [l.phase, l.data.path, l.data.count]), [[4, 'gate-cleared', 1]],
    'one count, under its own path — not a killed lane');
});

test('CG-3: a wake at the automatic-resume cap is a person\'s errand, not a launch', async () => {
  const state = parkedOnGate();
  state.recoveries = { 4: { attempts: 0, lastAt: new Date(NOW).toISOString(), bootResumes: MAX_BOOT_RESUMES } } as never;
  const { deps, started } = stubDeps(state, { gates: async () => ({ 4: 'clear' }) });
  const report = await convergePlan(deps, 'alpha', 'timer');
  assert.equal(report.launched, false);
  assert.equal(started.length, 0, 'a gate that keeps reading clear to converge and blocked to the runner cannot spin');
  assert.deepEqual(kinds(report), ['errand']);
});

test('CG-3: a live run, or no run at all, costs no gate read', async () => {
  const state = parkedOnGate();
  let reads = 0;
  const gates = async () => { reads += 1; return {}; };
  await convergePlan(stubDeps(state, { gates, live: () => new Set([state.id]) }).deps, 'alpha', 'timer');
  await convergePlan(stubDeps(state, { gates, runs: () => [] }).deps, 'alpha', 'timer');
  assert.equal(reads, 0);
});

const alphaPlan = (status = 'active') => `---
slug: alpha
created: 2026-09-24
status: ${status}
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

### Phase 2 — cart api *(GATED)*
- **Size:** S
- **Gates (must clear first):** the beta plan's phase 1 is verified
- **Gate-check:** plan beta:1

### Phase 3 — checkout
- **Size:** S
`;

const BETA = `---
slug: beta
created: 2026-09-24
status: active
phases: 1
---

# beta

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | lands | — | — | lib | it lands |

## Phases

### Phase 1 — lands
- **Size:** S
`;

function writeHandoff(root: string, slug: string, phase: number, title: string, status: string): void {
  const dir = join(root, 'docs', 'handoffs', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `phase-${String(phase).padStart(2, '0')}-${title}.md`),
    `---\nplan: docs/plans/${slug}.md\nphase: ${phase}\ntitle: ${title}\nstatus: ${status}\n---\n# Phase ${phase} — ${title}\n\n## What this phase did\n\nIt did the work.\n`, 'utf8');
}

function twoPlans(alphaStatus = 'active'): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-cross-gate-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), alphaPlan(alphaStatus), 'utf8');
  writeFileSync(join(root, 'docs', 'plans', 'beta.md'), BETA, 'utf8');
  writeHandoff(root, 'alpha', 1, 'schema', 'complete');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function console_(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: false,
    scriptsDir: SCRIPTS, logFile: null, converge: true,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  svc.prefs.resumeAtBoot = 'auto';
  assert.equal(svc.open(root).ok, true);
  const started: Array<Record<string, unknown>> = [];
  (svc as never as Record<string, unknown>).startRun = async (_slug: string, options: Record<string, unknown>) => {
    started.push(options);
    return null;
  };
  return { svc, started };
}

/** Alpha's run as the runner leaves it: phase 1 done, phase 2 boarded, its gate blocked, the run parked. */
function storedGatedRun(root: string): RunState {
  const state = newRun({ slug: 'alpha', root, autoRecover: false });
  state.status = 'parked';
  state.halt = { at: new Date().toISOString(), reason: 'nothing is ready: phase 2 is gated', kind: 'nothing-ready' };
  phaseRecord(state, 1).status = 'done';
  const record = phaseRecord(state, 2);
  record.status = 'gated';
  record.note = 'gate not clear: blocked — beta phase(s) 1 not verified';
  saveRun(state);
  return state;
}

function events(root: string, runId: string): Array<{ event: string; phase?: number; data: Record<string, unknown> }> {
  const file = journalFile(root, 'alpha', runId);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('CG-3: through a real console, another plan landing re-boards the gated phase — the verdict is read fresh', async () => {
  const { root, cleanup } = twoPlans();
  const { svc, started } = console_(root);
  try {
    await svc.bootSettled;
    await svc.converger.idle();
    started.length = 0;
    const state = storedGatedRun(root);

    await svc.convergeNow('alpha', 'timer');
    assert.equal(started.length, 0, 'beta has not landed: the gate holds and nothing is started');

    // Beta's phase 1 lands. Nothing about ALPHA's files moves — its revision
    // is the one it was, so a verdict cached on it would still read blocked.
    writeHandoff(root, 'beta', 1, 'lands', 'complete');
    await svc.convergeNow('alpha', 'timer');
    assert.equal(started.length, 1, `the other plan landed: one relaunch (${JSON.stringify(events(root, state.id).filter((e) => e.event === 'run.converge').map((e) => e.data))})`);
    assert.equal(started[0].resumeRunId, state.id);
    const reboard = started[0].reboard as Array<{ phase: number; rung: string }>;
    assert.deepEqual(reboard.map((ask) => [ask.phase, ask.rung]), [[2, 'reboard-fresh']]);
  } finally {
    await svc.close();
    cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * CG-4 — a closed plan is never woken
 * ------------------------------------------------------------------ */

test('CG-4: a run whose plan is CLOSED is settled, never relaunched, whatever its gates say', () => {
  for (const status of ['complete', 'superseded', 'abandoned']) {
    const plan = planConvergence(facts({ runs: [parkedOnGate()], gates: { 4: 'clear' }, planStatus: status }));
    assert.deepEqual(kinds(plan), ['settle-closed'], `${status}: settled, not woken (${kinds(plan)})`);
  }
  // An open status is no reason at all.
  assert.ok(relaunchOf(planConvergence(facts({ runs: [parkedOnGate()], gates: { 4: 'clear' }, planStatus: 'active' }))));
  // Not even the operator's press, and not a sleeping run whose clock went by.
  assert.deepEqual(kinds(planConvergence(facts({ runs: [parkedOnGate()], trigger: 'button', planStatus: 'superseded' }))), ['settle-closed']);
  const sleeping = parkedOnGate();
  sleeping.status = 'paused';
  sleeping.stoppedBy = 'system';
  sleeping.waitUntil = new Date(NOW - 3_600_000).toISOString();
  sleeping.waitReason = 'external';
  assert.deepEqual(kinds(planConvergence(facts({ runs: [sleeping], planStatus: 'complete' }))), ['settle-closed'],
    'an overdue wait of a closed plan is not resumed');
});

test('CG-4: the settle stops the run, journals run.closed-plan once, and the next pass leaves it alone', async () => {
  const state = parkedOnGate();
  const { deps, started, lines } = stubDeps(state);
  const first = await executeConvergence(planConvergence(facts({ runs: [state], gates: { 4: 'clear' }, planStatus: 'superseded' })), deps);
  assert.equal(first.launched, false);
  assert.equal(started.length, 0);
  assert.equal(state.status, 'halted', 'nothing drives it and nothing will');
  assert.equal(state.stoppedBy, 'system');
  assert.equal(state.resolved?.auto, true);
  assert.match(state.resolved?.reason ?? '', /superseded/);
  const closed = lines.filter((l) => l.event === 'run.closed-plan');
  assert.equal(closed.length, 1);
  assert.equal(closed[0].data.status, 'superseded');

  const second = await executeConvergence(planConvergence(facts({ runs: [state], gates: { 4: 'clear' }, planStatus: 'superseded' })), deps);
  assert.equal(second.launched, false);
  assert.equal(lines.filter((l) => l.event === 'run.closed-plan').length, 1, 'once');
  assert.deepEqual(kinds(second), ['skip']);
});

test('CG-4: through a real console, a superseded plan\'s run is settled on a change pass and never relaunched', async () => {
  const { root, cleanup } = twoPlans('superseded');
  writeHandoff(root, 'beta', 1, 'lands', 'complete');
  const { svc, started } = console_(root);
  try {
    await svc.bootSettled;
    await svc.converger.idle();
    const state = storedGatedRun(root);
    await svc.convergeNow('alpha', 'change');
    await svc.convergeNow('alpha', 'change');
    assert.equal(started.length, 0, 'its gate cleared the day before — and it is still not woken');
    const stored = loadRun(root, 'alpha', state.id)!;
    assert.equal(stored.stoppedBy, 'system');
    assert.ok(stored.resolved, 'settled');
    const closed = events(root, state.id).filter((e) => e.event === 'run.closed-plan');
    assert.deepEqual(closed.map((e) => e.data.status), ['superseded'], 'journalled once');
  } finally {
    await svc.close();
    cleanup();
  }
});
