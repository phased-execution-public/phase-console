/**
 * A run that has stopped wanting a phase must stop advertising it (issue #6).
 *
 * The report was three surfaces — Runs, Sessions, and a plan's Autopilot tab —
 * showing phases as `queued` / `waiting` with multi-hour ETAs on a run the
 * operator had already pressed **Pause after this phase** on. The client was
 * rendering the model faithfully; the model was what was stale. `pause()` armed
 * the word and told the scheduler nothing, so the only thing that could clear a
 * `queued` record was the arrival check — reached when the entry finally got to
 * the head of a queue whose own ETA said hours.
 *
 * Two halves, tested apart because they fail apart:
 *
 *   A. **`Scheduler.withdrawRun`** — the queue's half. Deliberately NOT
 *      `releaseRun`: a pause keeps what the run already HOLDS (the phase in
 *      flight finishes, which is the whole meaning of the button) and drops only
 *      what it is waiting for.
 *   B. **`Runner.withdrawQueued`** — the record's half, which is what the three
 *      surfaces actually read. One act, three surfaces fixed.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PHASE_CONSOLE_LOG = '';

const { Scheduler, AdmissionAborted } = await import('../server/runner/scheduler.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { newRun, phaseRecord } = await import('../server/runner/state.ts');
import type { LockView, ScopeGrant } from '../server/runner/scheduler.ts';
import type { RunState } from '../server/runner/state.ts';

/** Let the microtask `admit()` schedules actually run. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/* ================================================================== *
 * A. The queue's half
 * ================================================================== */

test('withdrawRun drops what a run is WAITING for and keeps what it HOLDS', async () => {
  const changes: number[] = [];
  const s = new Scheduler({
    max: 1,
    locks: (): LockView[] => [],
    onChange: (snap) => changes.push(snap.entries.length),
  });

  const held = await s.admit({ slug: 'demo', phase: 1, runId: 'R1', scope: ['app'] });
  // Two behind it, and one belonging to a DIFFERENT run — the withdrawal must
  // be surgical, or a pause on one plan empties the queue of another.
  const queuedA = s.admit({ slug: 'demo', phase: 2, runId: 'R1', scope: ['app'] });
  const queuedB = s.admit({ slug: 'demo', phase: 3, runId: 'R1', scope: ['app'] });
  // Never awaited: the session cap is 1 and the live lane keeps its grant, so
  // this one stays queued for the whole test — which is exactly what makes it
  // the control. `close()` below is what settles it.
  const foreign = s.admit({ slug: 'other', phase: 9, runId: 'R2', scope: ['app'] });
  foreign.catch(() => {});
  await tick();
  assert.equal(s.snapshot().entries.length, 3, 'three are waiting behind the live lane');

  const rejected: string[] = [];
  for (const [name, promise] of [['A', queuedA], ['B', queuedB]] as const) {
    promise.catch((error) => {
      assert.ok(error instanceof AdmissionAborted, 'a withdrawal reads as an abort, like a stop');
      rejected.push(name);
    });
  }

  const withdrawn = s.withdrawRun('R1');
  await tick();

  assert.equal(withdrawn, 2, 'both of this run’s waiting entries, and only those');
  assert.deepEqual(rejected.sort(), ['A', 'B']);
  const entries = s.snapshot().entries;
  assert.equal(entries.length, 1, 'the other run’s entry is untouched');
  assert.equal(entries[0]!.runId, 'R2');
  // The grant is bookkeeping the RUNNING lane still needs. `releaseRun` would
  // have taken it, and with it the scope the phase is mid-edit inside.
  assert.equal(s.granted('R1').length, 1, 'the phase in flight keeps its scope');
  assert.ok((held as ScopeGrant).id, 'the live grant is still a grant');
  assert.ok(changes.length > 0, 'the queue page is told, even when nothing else moved');

  // Idempotent: a second press, or a halt arriving behind a pause, finds
  // nothing left to do and says so.
  assert.equal(s.withdrawRun('R1'), 0);
  s.release(held);
  s.close();
});

test('withdrawRun lets whoever was queued behind those entries through', async () => {
  const s = new Scheduler({ max: 1, locks: (): LockView[] => [] });
  const held = await s.admit({ slug: 'a', phase: 1, runId: 'R1', scope: ['app'] });
  const mine = s.admit({ slug: 'a', phase: 2, runId: 'R1', scope: ['app'] });
  const theirs = s.admit({ slug: 'b', phase: 1, runId: 'R2', scope: ['app'] });
  await tick();
  mine.catch(() => {});

  s.withdrawRun('R1');
  s.release(held);
  await tick();
  // Not merely "the queue is shorter": the session cap is 1, so the other run
  // could only be admitted because the withdrawal freed a slot AND the poll ran.
  const grant = await theirs;
  assert.equal(grant.runId, 'R2');
  s.release(grant);
  s.close();
});

/* ================================================================== *
 * B. The record's half — what the three surfaces read
 * ================================================================== */

/**
 * A runner with a state installed and no loop.
 *
 * `pause()` asks for exactly two things (`state` and `driving`) and a fake
 * scheduler, which is what lets this test the real control verbs without a
 * repo, a child process or a board. The subclass is the seam: `withdrawQueued`
 * is `protected`, which a subclass may call and a stranger may not.
 */
class Probe extends Runner {
  persists = 0;
  /** The undebounced write — counted apart, because a halt owes THAT one. */
  durableWrites = 0;

  installed(state: RunState): void {
    (this as unknown as { state: RunState }).state = state;
    (this as unknown as { driving: Promise<void> }).driving = Promise.resolve();
  }

  /** `halt()` is `protected`, and a run-level halt is the third withdrawal door. */
  haltRun(reason: string): void {
    this.halt(reason);
  }

  protected override persist(): void {
    this.persists++;
    super.persist();
  }

  protected override persistNow(): void {
    this.durableWrites++;
    super.persistNow();
  }
}

function probe(withdrawn = 0) {
  const calls: string[] = [];
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const scheduler = {
    withdrawRun: (runId: string): number => {
      calls.push(runId);
      return withdrawn;
    },
    poll: () => {},
    releaseRun: () => {},
  } as unknown as InstanceType<typeof Scheduler>;

  const runner = new Probe({
    scriptsDir: '/nonexistent',
    scheduler,
    onEvent: (event, data) => events.push({ event, data }),
  });
  const state = newRun({ slug: 'demo', root: '/tmp/demo' });
  state.activePhase = 12;
  // The shape from the report: 12 running, 14 and 15 queued behind its scope,
  // each carrying the ETA that made the lie legible.
  phaseRecord(state, 12).status = 'running';
  for (const phase of [14, 15]) {
    const record = phaseRecord(state, phase);
    record.status = 'queued';
    record.lockWaitSince = new Date().toISOString();
    record.waitingOn = [{ slug: 'demo', phase: 12, owner: 'autopilot/x', eta: { label: '~9 h-18 h left' } }];
  }
  runner.installed(state);
  return { runner, state, calls, events };
}

test('a pause withdraws the run’s queued lanes — the entries AND the word on the records', () => {
  const { runner, state, calls } = probe(2);

  assert.equal(runner.pause('console'), true);

  assert.deepEqual(calls, [state.id], 'the scheduler is told, once, about this run only');
  assert.equal(state.status, 'pausing');
  assert.equal(state.pause?.afterPhase, 12);
  for (const phase of [14, 15]) {
    const record = state.phases[String(phase)]!;
    assert.equal(record.status, 'pending', `phase ${phase} is startable again, not queued`);
    // The ETA is the part that made the report; `endLockWait` takes it with the
    // word. "phase 14 — waiting, ~9 h-18 h left" on a stopped run is the
    // opposite of true.
    assert.equal(record.waitingOn, undefined, `phase ${phase} advertises no wait`);
    assert.equal(record.lockWaitSince, undefined);
  }
  assert.equal(state.phases['12']!.status, 'running', 'the phase being finished is untouched');
});

test('the withdrawal is journalled, so a paused run can say what it cancelled', () => {
  const { runner, events } = probe(2);
  runner.pause('console');
  const line = events.find((e) => e.event === 'run:journal' && e.data.event === 'run.pause-withdrew');
  assert.ok(line, 'run.pause-withdrew is on the journal');
  assert.equal((line!.data.data as Record<string, unknown>).entries, 2);
  assert.equal((line!.data.data as Record<string, unknown>).phases, 2);
});

test('a pause with nothing queued withdraws nothing and journals nothing', () => {
  const { runner, state, events } = probe(0);
  for (const phase of [14, 15]) state.phases[String(phase)]!.status = 'pending';

  runner.pause('console');

  assert.equal(
    events.some((e) => e.event === 'run:journal' && e.data.event === 'run.pause-withdrew'),
    false,
    'a line saying two things were withdrawn when none were is a line that misleads',
  );
});

test('a second pause is a no-op — the first one already emptied the queue', () => {
  const { runner, calls } = probe(2);
  assert.equal(runner.pause('console'), true);
  assert.equal(runner.pause('console'), true, 'still true — the run IS pausing');
  assert.deepEqual(calls, calls.slice(0, 1), 'the scheduler is not asked twice');
});

test('a park withdraws too', () => {
  const { runner, state, calls } = probe(2);

  runner.park('nobody answered the approval');

  assert.deepEqual(calls, [state.id]);
  assert.equal(state.phases['14']!.status, 'pending');
  assert.equal(state.phases['15']!.status, 'pending');
  assert.equal(state.phases['12']!.status, 'running', 'the live phase is untouched');
});

test('a run-level halt withdraws, AND the withdrawal is written (QA r1 L1)', () => {
  const { runner, state, calls } = probe(2);
  const before = runner.durableWrites;

  runner.haltRun('3 phases failed in a row');

  assert.deepEqual(calls, [state.id], 'the halt door tells the scheduler too');
  assert.equal(state.phases['14']!.status, 'pending');
  assert.equal(state.phases['15']!.status, 'pending');
  // The durability half, which `halt()` alone of the three doors did not have.
  // `queued` is NOT in `PHASE_IN_FLIGHT`, so a console that died before the
  // drive loop's next write would leave `queued` on disk for a phase whose
  // scheduler entry is gone — and `settleInFlightRecords` would not repair it.
  assert.ok(runner.durableWrites > before, 'the halt writes what it withdrew, undebounced');
});

test('a halt with nothing queued does not write for nothing', () => {
  const { runner, state } = probe(0);
  for (const phase of [14, 15]) state.phases[String(phase)]!.status = 'pending';
  const before = runner.durableWrites;

  runner.haltRun('3 phases failed in a row');

  assert.equal(runner.durableWrites, before, 'no withdrawal, no extra write');
});
