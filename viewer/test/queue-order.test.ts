/**
 * The queue, ORDERED — an operator's word on where a phase goes sticks, and is
 * written down with its reason (control-tower phase 99, #135 B, E and I).
 *
 * Before this the one lever was the one-shot `POST /api/queue/bump`: invisible
 * on the board, logged only to `console.log` (#128), lost whenever the entry
 * was re-created — a pause, a retry, a wrap-up, a restart — and the watchdog
 * wrote scripts that re-bumped entries as they reappeared.
 *
 *   QV-4  a bump SURVIVES its entry: the mark lives on the phase's record, a
 *         re-created entry is born bumped, the run's own boarding order puts
 *         it first, and it is spent when the phase boards; a plan's phases
 *         reorder as a list (the listed first, in that order) across the
 *         cross-plan queue;
 *   QV-5  hold, defer and withdraw ONE entry: a held entry stays queued and
 *         is never admitted until released; a deferred one boards when its
 *         clock passes; a withdrawn one leaves the queue, its run boards its
 *         other phases, and it is named — never boarded — until re-queued;
 *   QV-6  every change is journalled with who and WHY (phase 96's `reason`),
 *         a move with the order before and after, and the audit strip reads
 *         the lines back, newest first.
 * (QV-1..3 and QV-7 are in `queue-view.test.ts`.)
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { boardHarness } from './lane-harness.ts';

process.env.PHASE_CONSOLE_LOG = '';

const { Scheduler, AdmissionAborted, AdmissionWithdrawn } = await import('../server/runner/scheduler.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { queueAuditRows } = await import('../server/queue-view.ts');
const { ENTRY_HOLD_HOLDER, DEFER_HOLDER, QUEUE_VERBS } = await import('../shared/orchestration-model.js');
import type { EngineResult } from '../server/engine.ts';
import type { LockView, ScopeGrant } from '../server/runner/scheduler.ts';
import type { Actor, RunState } from '../server/runner/state.ts';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const MIN = 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

const who = (reason?: string, by = 'operator'): Actor =>
  ({ by, via: 'api', origin: 'local', remoteUser: null, ...(reason ? { reason } : {}) }) as Actor;

class Probe extends Runner {
  installed(state: RunState): void {
    (this as unknown as { state: RunState }).state = state;
    (this as unknown as { driving: Promise<void> }).driving = Promise.resolve();
  }
  protected override async scopeFor(): Promise<string[]> { return ['app']; }
  protected override async script(): Promise<EngineResult> {
    return { stdout: 'free', stderr: '', code: 0 } as unknown as EngineResult;
  }
  admitNow(phase: number): Promise<ScopeGrant | null> { return this.admit(phase, 'phase'); }
}

type Line = { event: string; phase?: number; data: Record<string, unknown> };

/** A live-shaped run of `demo`, its admissions queued behind a lock on `app` until `free()`. */
function harness() {
  const journal: Line[] = [];
  let locks: LockView[] = [{
    slug: 'other', phase: 9, owner: 'someone@laptop', expired: false, scope: ['app'], leaseUntil: Date.now() + 60 * MIN,
  }];
  const scheduler = new Scheduler({ max: 4, locks: () => locks });
  const state = newRun({ slug: 'demo', root: '/tmp/demo' });
  const runner = new Probe({
    scriptsDir: '/nonexistent',
    scheduler,
    onEvent: (event, data) => {
      if (event !== 'run:journal') return;
      const line = data as Line;
      journal.push({ event: line.event, phase: line.phase, data: line.data ?? {} });
    },
  });
  runner.installed(state);
  const free = (): void => { locks = []; scheduler.poll(); };
  const order = (): { phase: number | null; order?: number; bumped?: true }[] =>
    scheduler.snapshot().entries.map((e) => ({ phase: e.phase, order: e.order, ...(e.bumped ? { bumped: e.bumped } : {}) }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return { scheduler, runner, journal, state, free, order };
}

const queued = async (h: ReturnType<typeof harness>, n: number): Promise<void> => {
  for (let i = 0; i < 40 && h.scheduler.snapshot().entries.length < n; i++) await tick();
};

/* ================================================================== *
 * QV-4 — a bump survives its entry; a plan reorders as a list
 * ================================================================== */

test('QV-4: a bump survives its entry — the mark is on the record, a re-created entry is born bumped, and boarding spends it', async () => {
  const h = harness();
  const five = h.runner.admitNow(5); five.catch(() => {});
  const six = h.runner.admitNow(6); six.catch(() => {});
  await queued(h, 2);
  assert.deepEqual(h.order().map((e) => e.phase), [5, 6], 'first come, first served before anybody says otherwise');

  const out = h.runner.queueControl(6, 'bump', who('P6 unblocks trade P43'));
  assert.equal(out.ok, true);
  assert.deepEqual(h.order().map((e) => e.phase), [6, 5], 'to the front of its class, at once');
  const mark = h.state.phases['6']!.queueControl?.bump;
  assert.ok(mark, 'the bump is on the phase\'s own record — the board and the run card read it there');
  assert.equal(mark!.by, 'operator');
  assert.equal(mark!.reason, 'P6 unblocks trade P43');

  // The entry dies — the run was paused — and is re-created later, in the
  // other order: the operator's word stands on the new entry.
  h.scheduler.withdrawRun(h.state.id);
  await Promise.allSettled([five, six]);
  const sixAgain = h.runner.admitNow(6); sixAgain.catch(() => {});
  const fiveAgain = h.runner.admitNow(5); fiveAgain.catch(() => {});
  await queued(h, 2);
  const again = h.order();
  assert.equal(again[0]!.phase, 6, 'the re-created entry is born bumped — it did not die with the first');
  assert.equal(again[0]!.bumped, true);

  h.free();
  const grant = await sixAgain;
  assert.ok(grant, 'it boards first');
  assert.equal(h.state.phases['6']!.queueControl?.bump, undefined, 'spent when the phase boards: the job is done');
  h.scheduler.release(grant!);
  // P5 is now serial behind its own run's live lane — its admission stands down.
  const other = await fiveAgain.catch(() => null);
  if (other) h.scheduler.release(other);
  h.scheduler.close();
});

test('QV-4: the run\'s own boarding order honours a bump — a bumped phase takes the next lane of its run', async () => {
  const h = boardHarness({ states: { 1: 'done', 2: 'ready', 3: 'ready', 4: 'ready' } });
  const run = newRun({ slug: 'demo', root: h.root, autonomy: 'keep-going', autoRecover: false } as never);
  run.status = 'parked';
  phaseRecord(run, 1).status = 'done';
  // 2 has the oldest seniority; 4 was moved ahead by a person; 3 never waited.
  Object.assign(phaseRecord(run, 2), { status: 'pending', queueSince: ago(3 * 60 * MIN) });
  phaseRecord(run, 4).queueControl = { bump: { at: ago(MIN), by: 'operator', reason: 'unblocks P7', stamp: Date.now() - MIN } };
  saveRun(run);
  await h.runner.start({ slug: 'demo', root: h.root, resumeRunId: run.id, maxParallel: 1 } as never);
  await h.runner.wait();
  assert.deepEqual(h.spawned, [4, 2, 3], 'the bumped phase first, then seniority, then the board\'s order');
});

test('QV-4: a plan\'s phases reorder as a list — the listed first, in that order, ahead of the unbumped queue', async () => {
  const h = harness();
  for (const phase of [5, 6, 7]) { const p = h.runner.admitNow(phase); p.catch(() => {}); }
  await queued(h, 3);
  // Another plan's entry, in the line after them: the reorder is this plan's
  // word about its own phases, and they go ahead of the queue's FIFO tail.
  const foreign = h.scheduler.admit({ slug: 'trade', phase: 43, runId: 'bbbbbbbbbbbb', scope: ['app'] });
  foreign.catch(() => {});
  await queued(h, 4);
  const out = h.runner.reorderQueue([7, 5], who('7 then 5: the release needs both'));
  assert.equal(out.ok, true);
  // The rest take fair-share turns (control-tower phase 100, #135 C.13):
  // trade's first entry goes before demo's third, however young it is.
  assert.deepEqual(h.order().map((e) => e.phase), [7, 5, 43, 6], 'the list first, in its order; the rest by turns across plans');
  assert.ok(h.state.phases['7']!.queueControl?.bump && h.state.phases['5']!.queueControl?.bump, 'each listed phase carries the mark');
  assert.equal(h.state.phases['6']!.queueControl?.bump, undefined, 'an unlisted phase keeps its place');
  const line = h.journal.find((l) => l.event === 'run.queue-reordered');
  assert.ok(line, 'one line for the list');
  assert.deepEqual(line!.data.phases, [7, 5]);
  assert.equal(line!.data.reason, '7 then 5: the release needs both');
  assert.ok(Array.isArray(line!.data.before) && Array.isArray(line!.data.after), 'the order before and after');
  h.scheduler.close();
});

/* ================================================================== *
 * QV-5 — hold, defer, withdraw
 * ================================================================== */

test('QV-5: a held entry stays queued and is never admitted — its holder says who and why — until released', async () => {
  const scheduler = new Scheduler({ max: 4 });
  const mark = { at: new Date().toISOString(), by: 'operator', reason: 'waiting for the CI fix' };
  const held = scheduler.admit({ slug: 'demo', phase: 5, runId: 'aaaaaaaaaaaa', scope: ['app'], control: { hold: mark } });
  let granted: ScopeGrant | null = null;
  void held.then((grant) => { granted = grant; });
  await tick(); await tick();
  assert.equal(granted, null, 'the scope is free, and it is still not admitted');
  const [entry] = scheduler.snapshot().entries;
  assert.equal(entry!.waitingOn[0]!.slug, ENTRY_HOLD_HOLDER);
  assert.equal(entry!.waitingOn[0]!.clock, true, 'a decision, never capped into a park');
  assert.match(entry!.waitingOn[0]!.owner, /operator/);
  assert.match(entry!.waitingOn[0]!.owner, /waiting for the CI fix/);
  assert.equal(entry!.reserving, false, 'a held entry never ages into an obstacle');
  assert.equal(scheduler.markEntry(entry!.id, { hold: null }), true);
  const grant = await held;
  assert.ok(grant, 'released: it boards on the next scan');
  scheduler.release(grant);
  scheduler.close();
});

test('QV-5: a deferred entry waits on its clock and boards when it passes — no poke needed', async () => {
  const scheduler = new Scheduler({ max: 4 });
  const until = Date.now() + 120;
  const deferred = scheduler.admit({
    slug: 'demo', phase: 5, runId: 'aaaaaaaaaaaa', scope: ['app'],
    control: { defer: { until: new Date(until).toISOString(), at: new Date().toISOString(), by: 'operator', reason: 'after the 12:50Z reset' } },
  });
  await tick(); await tick();
  const [entry] = scheduler.snapshot().entries;
  assert.equal(entry!.waitingOn[0]!.slug, DEFER_HOLDER);
  assert.equal(entry!.waitingOn[0]!.leaseUntil, until, 'the moment it ends is on the holder');
  assert.match(entry!.waitingOn[0]!.owner, /after the 12:50Z reset/);
  const grant = await Promise.race([deferred, sleep(2_000).then(() => null)]);
  assert.ok(grant, 'its own timer admitted it when the clock passed');
  scheduler.release(grant!);
  scheduler.close();
});

test('QV-5: a withdrawn entry leaves the queue — the admission ends as a withdrawal, not a stop', async () => {
  const h = harness();
  const five = h.runner.admitNow(5);
  const six = h.runner.admitNow(6); six.catch(() => {});
  await queued(h, 2);
  const out = h.runner.queueControl(5, 'withdraw', who('not this week'));
  assert.equal(out.ok, true);
  await assert.rejects(five, (error: unknown) => error instanceof AdmissionWithdrawn && error instanceof AdmissionAborted);
  assert.deepEqual(h.scheduler.snapshot().entries.map((e) => e.phase), [6], 'it is out of the line');
  assert.ok(h.state.phases['5']!.queueControl?.withdrawn, 'and the record says so, for the loop and the page');
  h.scheduler.close();
});

test('QV-5: a withdrawn phase is never boarded — its run boards the others and names it — until it is re-queued', async () => {
  const h = boardHarness({ states: { 1: 'done', 2: 'ready', 3: 'ready' } });
  const run = newRun({ slug: 'demo', root: h.root, autonomy: 'keep-going', autoRecover: false } as never);
  run.status = 'parked';
  phaseRecord(run, 1).status = 'done';
  phaseRecord(run, 2).queueControl = { withdrawn: { at: ago(MIN), by: 'operator', reason: 'not this week' } };
  saveRun(run);
  await h.runner.start({ slug: 'demo', root: h.root, resumeRunId: run.id, maxParallel: 1 } as never);
  await h.runner.wait();
  assert.deepEqual(h.spawned, [3], 'the withdrawn phase took no lane; its sibling did');
  const state = h.runner.current()!;
  assert.match(state.finishedReason ?? '', /phase 2.*withdrawn from the queue by operator/, 'the run names what it will not board, and who said so');

  const back = h.runner.queueControl(2, 'requeue', who('this week after all'));
  assert.equal(back.ok, true);
  assert.equal(h.runner.current()!.phases['2']!.queueControl?.withdrawn, undefined);
  await h.runner.start({ slug: 'demo', root: h.root, resumeRunId: run.id, maxParallel: 1 } as never);
  await h.runner.wait();
  assert.deepEqual(h.spawned, [3, 2], 're-queued: it boards');
});

/* ================================================================== *
 * QV-6 — journalled with its reason; the audit strip reads it back
 * ================================================================== */

test('QV-6: every queue change is journalled with who and why, a move with the order before and after', async () => {
  const h = harness();
  for (const phase of [5, 6]) { const p = h.runner.admitNow(phase); p.catch(() => {}); }
  await queued(h, 2);
  const until = new Date(Date.now() + 60 * MIN).toISOString();
  assert.equal(h.runner.queueControl(6, 'hold', who('waiting for the CI fix')).ok, true);
  assert.equal(h.runner.queueControl(6, 'release', who('CI is green')).ok, true);
  assert.equal(h.runner.queueControl(6, 'defer', who('after the window'), { until }).ok, true);
  assert.equal(h.runner.queueControl(6, 'release', who()).ok, true);
  assert.equal(h.runner.queueControl(6, 'bump', who('P6 unblocks P7')).ok, true);
  assert.equal(h.runner.queueControl(5, 'withdraw', who('not this week')).ok, true);
  assert.equal(h.runner.queueControl(5, 'requeue', who('this week after all'), { position: 'front' }).ok, true);

  const of = (event: string): Line[] => h.journal.filter((l) => l.event === event);
  assert.equal(of('phase.queue-held')[0]!.data.reason, 'waiting for the CI fix');
  assert.equal(of('phase.queue-held')[0]!.data.by, 'operator');
  assert.equal(of('phase.queue-released')[0]!.data.reason, 'CI is green');
  assert.equal(of('phase.queue-deferred')[0]!.data.until, until);
  assert.equal(of('phase.queue-deferred')[0]!.data.reason, 'after the window');
  const bumped = of('phase.queue-bumped')[0]!;
  assert.equal(bumped.phase, 6);
  assert.equal(bumped.data.reason, 'P6 unblocks P7');
  assert.deepEqual(bumped.data.order, { before: 1, after: 0 }, 'where it stood and where it went');
  assert.equal(of('phase.queue-withdrawn')[0]!.data.reason, 'not this week');
  const requeued = of('phase.queue-requeued')[0]!;
  assert.equal(requeued.data.position, 'front', 'back in at the front: a re-queue can say where');
  assert.ok(h.state.phases['5']!.queueControl?.bump, 'at the front means bumped');

  // A second identical word is not a second decision.
  const lines = h.journal.length;
  assert.equal(h.runner.queueControl(6, 'bump', who('again')).ok, true);
  assert.equal(h.journal.length, lines + 1, 'a second bump is a new instruction and orders in front of the first');
  assert.equal(h.runner.queueControl(5, 'release', who()).ok, true);
  assert.equal(h.journal.length, lines + 1, 'releasing nothing writes nothing');

  // A phase that is done takes no mark.
  h.state.phases['9'] = { ...phaseRecord(h.state, 9), status: 'done' };
  const refused = h.runner.queueControl(9, 'hold', who());
  assert.equal(refused.ok, false);
  h.scheduler.close();
});

test('QV-6: the audit strip reads the queue\'s lines back, newest first, each in one sentence with its reason', () => {
  const at = (m: number): string => new Date(Date.UTC(2026, 8, 30, 12, m)).toISOString();
  const rows = queueAuditRows([
    { slug: 'demo', runId: 'aaaaaaaaaaaa', at: at(1), event: 'phase.queue-held', phase: 6, data: { by: 'operator', reason: 'waiting for the CI fix' } },
    { slug: 'demo', runId: 'aaaaaaaaaaaa', at: at(2), event: 'phase.queue-bumped', phase: 5, data: { by: 'watchdog', order: { before: 3, after: 0 } } },
    { slug: 'demo', runId: 'aaaaaaaaaaaa', at: at(3), event: 'run.queue-reordered', data: { by: 'operator', reason: 'release order', phases: [7, 5] } },
    { slug: 'demo', runId: 'aaaaaaaaaaaa', at: at(4), event: 'phase.queued', phase: 6, data: {} },
  ]);
  assert.deepEqual(rows.map((row) => row.verb), ['reorder', 'bump', 'hold'], 'queue changes only, newest first');
  assert.match(rows[0]!.text, /operator reordered demo: P7, P5 — release order/);
  assert.match(rows[1]!.text, /watchdog moved demo P5 ahead \(4th → 1st\)/);
  assert.match(rows[2]!.text, /operator held demo P6 — waiting for the CI fix/);
  for (const row of rows) assert.ok((QUEUE_VERBS as readonly string[]).includes(row.verb));
});
