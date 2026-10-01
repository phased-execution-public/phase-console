/**
 * Admission re-reads a fresh board (control-tower phase 86, #136, #149 ask 4).
 *
 * trade P67 queued at 03:14Z while the board read its dependency P66 done;
 * P66 then ended `partial` and went back to in-progress — and for two hours
 * P67 sat AHEAD of its own dependency, because `runPhase` boards with the
 * board it read BEFORE the admission wait (`runPhaseAdmitted(phase, board,
 * lane)`), and nothing re-checked readiness at the grant. And an isolated run's
 * automatic resume, queued as a recovery, refused `pause` outright.
 *
 *   AR-1  an entry whose dependency is not done waits with an `after` holder
 *         naming it — a skip: never reserving, its age kept — and is admitted
 *         the scan its dependency clears;
 *   AR-2  a phase whose dependency re-opened while it waited is HELD at the
 *         grant (`phase.admission-held`), never boarded, never withdrawn, and
 *         boards once the dependency is done;
 *   AR-3  a dependency sorts ahead of its dependants in the queue, whatever
 *         the two entries' ages;
 *   AR-4  a queued automatic resume (a recovery still waiting for its scope)
 *         can be paused, and re-queued with an instruction, without stopping
 *         the run.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { boardHarness, journalled } from './lane-harness.ts';

process.env.PHASE_CONSOLE_LOG = '';

const { Scheduler } = await import('../server/runner/scheduler.ts');
const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { holderClass } = await import('../server/runner/scheduler.ts');
const { HOLDER_KINDS } = await import('../shared/run-lifecycle.js');
type RunState = import('../server/runner/state.ts').RunState;

const MIN = 60_000;
const tick = () => new Promise((done) => { setTimeout(done, 10); });

async function waitFor(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (check()) return;
    await new Promise((done) => { setTimeout(done, 20); });
  }
  assert.fail(`timed out waiting for ${what}`);
}

/* ------------------------------------------------------------------ *
 * AR-1 — the `after` holder
 * ------------------------------------------------------------------ */

test('AR-1: an entry whose dependency is not done waits on an `after` holder naming it — never reserving, its age kept — and is admitted once it clears', async () => {
  assert.ok((HOLDER_KINDS as readonly string[]).includes('after'), 'a holder kind of its own, in the shared vocabulary');
  assert.equal(holderClass({ kind: 'after', owner: '', slug: 'trade', phase: 66 } as never, 'r1'), 'own-run', 'its own plan holds it');
  const scheduler = new Scheduler({ max: 4, locks: () => [] });
  const born = Date.now() - 3 * 60 * MIN;
  let deps: number[] | null = [66];
  const pending = scheduler.admit({ slug: 'trade', phase: 67, runId: 'r1', scope: ['app'], since: born, awaiting: () => deps } as never);
  await tick();
  const held = scheduler.snapshot().entries.find((entry) => entry.phase === 67)!;
  assert.ok(held, 'it is ON the queue — held, never withdrawn');
  assert.equal(held.waitingOn[0]?.kind, 'after');
  assert.equal(held.waitingOn[0]?.phase, 66, 'the holder is the dependency, by number');
  assert.match(held.waitingOn[0]?.owner ?? '', /66/);
  assert.equal(held.reserving, false, 'a hold is a skip: three hours old and it still blocks nobody');
  assert.equal(held.since, born, 'and it keeps its age');
  deps = null;
  scheduler.poll();
  const grant = await pending;
  assert.ok(grant, 'admitted the scan its dependency cleared');
  scheduler.release(grant);
});

/* ------------------------------------------------------------------ *
 * AR-2 — a dependency that re-opens during the wait
 * ------------------------------------------------------------------ */

test('AR-2: #136 — a phase whose dependency re-opened while it queued is held at the grant, never boarded, and boards once the dependency is done', async () => {
  const scheduler = new Scheduler({ max: 4, locks: () => [] });
  const foreign = await scheduler.admit({ slug: 'other', phase: 9, runId: 'other-run', scope: ['app'] });
  const h = boardHarness({ states: { 1: 'done', 2: 'done', 3: 'ready' }, deps: { scheduler } });
  const run = newRun({ slug: 'demo', root: h.root, autonomy: 'keep-going', autoRecover: false } as never);
  run.status = 'parked';
  phaseRecord(run, 1).status = 'done';
  phaseRecord(run, 2).status = 'done';
  saveRun(run);
  await h.runner.start({ slug: 'demo', root: h.root, resumeRunId: run.id, maxParallel: 1 } as never);
  try {
    await waitFor(() => scheduler.snapshot().entries.some((entry) => entry.phase === 3), 'phase 3 to queue behind the other run');
    // 04:15Z: the dependency ends `partial`, and the board takes it back.
    h.states[2] = 'in-progress';
    h.states[3] = 'waiting';
    h.blocked[3] = [2];
    h.render();
    scheduler.release(foreign);
    await waitFor(() => journalled(h, 'phase.admission-held').length > 0, 'the grant to be held');
    assert.deepEqual(h.spawned, [], 'nothing boarded over an unfinished dependency');
    const held = journalled(h, 'phase.admission-held')[0];
    assert.equal(held.phase, 3);
    assert.deepEqual(held.after, [2], 'the hold names the dependency');
    await waitFor(() => scheduler.snapshot().entries.some((entry) => entry.phase === 3 && entry.waitingOn[0]?.kind === 'after'), 'the entry to wait on its dependency');
    const entry = scheduler.snapshot().entries.find((e) => e.phase === 3)!;
    assert.equal(entry.waitingOn[0]?.phase, 2, 'the queue view names the dependency');
    // The dependency finishes.
    h.states[2] = 'done';
    h.states[3] = 'ready';
    delete h.blocked[3];
    h.render();
    (h.runner as unknown as { docsDirty: boolean }).docsDirty = true;
    (h.runner as unknown as { wake: { resolve(): void } }).wake.resolve();
    await h.runner.wait();
    assert.deepEqual(h.spawned, [3], 'it boarded once the dependency was done');
  } finally {
    await h.runner.stop?.();
  }
});

/* ------------------------------------------------------------------ *
 * AR-3 — a dependency before its dependants
 * ------------------------------------------------------------------ */

test('AR-3: a re-queued dependency sorts ahead of its dependants in the queue, whatever the two entries\' ages', async () => {
  const scheduler = new Scheduler({ max: 4, locks: () => [] });
  const foreign = await scheduler.admit({ slug: 'other', phase: 9, runId: 'other-run', scope: ['app'] });
  const now = Date.now();
  // P67 queued three hours ago; P66 re-queued a minute ago, after it re-opened.
  void scheduler.admit({ slug: 'trade', phase: 67, runId: 'r1', scope: ['app'], since: now - 3 * 60 * MIN, awaiting: () => [66] } as never).catch(() => {});
  void scheduler.admit({ slug: 'trade', phase: 66, runId: 'r1', scope: ['app'], since: now - MIN }).catch(() => {});
  await tick();
  const order = [...scheduler.snapshot().entries].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((entry) => entry.phase);
  assert.deepEqual(order, [66, 67], 'the dependency first');
  scheduler.release(foreign);
  scheduler.releaseRun('r1');
});

/* ------------------------------------------------------------------ *
 * AR-4 — a queued automatic resume answers Pause and a new instruction
 * ------------------------------------------------------------------ */

function recoveryRun(root: string): RunState {
  const state = newRun({ slug: 'demo', root, autonomy: 'keep-going', autoRecover: false } as never);
  state.status = 'parked';
  Object.assign(phaseRecord(state, 1), { status: 'parked', attempts: 1, sessionId: 'sess-1' });
  saveRun(state);
  return state;
}

test('AR-4: #149 — a recovery still waiting for its scope can be paused: its admission is withdrawn, the run reads paused, nothing is stopped', async () => {
  const scheduler = new Scheduler({ max: 4, locks: () => [] });
  const foreign = await scheduler.admit({ slug: 'other', phase: 9, runId: 'other-run', scope: ['app'] });
  const h = boardHarness({ states: { 1: 'in-progress' }, deps: { scheduler } });
  const run = recoveryRun(h.root);
  await h.runner.recover({ slug: 'demo', root: h.root, runId: run.id, phase: 1, mode: 'resume', instruction: 'phase 1: carry on', by: 'watch' } as never);
  try {
    await waitFor(() => scheduler.snapshot().entries.some((entry) => entry.phase === 1), 'the recovery to queue');
    assert.equal(h.runner.pause('operator'), true, 'a queued recovery answers Pause');
    await h.runner.wait();
    const after = h.runner.current()!;
    assert.equal(after.status, 'paused', 'the run reads paused — not stopped, not interrupted');
    assert.equal(after.pause?.by, 'operator');
    assert.ok(journalled(h, 'phase.recovery-cancelled').length === 1, 'the withdrawn recovery is on the record');
    assert.deepEqual(h.spawned, [], 'nothing spawned');
    assert.equal(scheduler.snapshot().entries.length, 0, 'and its entry has left the queue');
  } finally {
    scheduler.release(foreign);
  }
});

test('AR-4: #149 — a queued recovery can be re-queued with an instruction: it keeps its place and boards with the new words', async () => {
  const scheduler = new Scheduler({ max: 4, locks: () => [] });
  const foreign = await scheduler.admit({ slug: 'other', phase: 9, runId: 'other-run', scope: ['app'] });
  const h = boardHarness({ states: { 1: 'in-progress' }, deps: { scheduler } });
  const run = recoveryRun(h.root);
  await h.runner.recover({ slug: 'demo', root: h.root, runId: run.id, phase: 1, mode: 'resume', instruction: 'phase 1: the old words', by: 'watch' } as never);
  await waitFor(() => scheduler.snapshot().entries.some((entry) => entry.phase === 1), 'the recovery to queue');
  const before = scheduler.snapshot().entries.find((entry) => entry.phase === 1)!;
  const requeue = (h.runner as unknown as { requeueRecovery?: (phase: number, instruction: string, by: string) => boolean }).requeueRecovery;
  assert.equal(typeof requeue, 'function', 'a queued recovery has a verb for new words');
  assert.equal(requeue!.call(h.runner, 1, 'phase 1: THE NEW WORDS', 'operator'), true);
  const same = scheduler.snapshot().entries.find((entry) => entry.phase === 1)!;
  assert.equal(same.id, before.id, 'the same entry — it keeps its place');
  scheduler.release(foreign);
  await h.runner.wait();
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].prompt, /THE NEW WORDS/, 'the recovery boarded with the new instruction');
  assert.doesNotMatch(h.requests[0].prompt, /the old words/);
  assert.equal(journalled(h, 'phase.recovery-requeued').length, 1, 'and the change is on the record');
});
