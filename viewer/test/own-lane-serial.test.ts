/**
 * A phase waiting behind its OWN run's lane is serial work, not contention
 * (control-tower phase 60, #64 — OL-1..3).
 *
 * The run loop boards every ready phase it may, and the scheduler listed the
 * run's own grants as holders, so every sibling of a plan whose phases share a
 * repository sat `queued` behind its own lane — with a `phase.queued` line, a
 * durable `waitingOn`, a queued badge and a `waitedMs` accruing in parallel.
 * The audit measured 78 % of all queued lane-time as a run queued behind
 * itself, sharing one event, one counter and one surface with real contention.
 *
 *   OL-1  a ready phase whose scope meets a live lane of its own run stays
 *         ready with `serialBehind`: no queue entry, no `phase.queued`, no
 *         `waitedMs`, no queued word — at admission, and when a queued phase's
 *         holders BECOME its own live lane;
 *   OL-2  the drive loop never boards it into the scheduler: a sibling boarded
 *         earlier in the same pass is a lane it is serial behind, too;
 *   OL-3  queue metrics split holders by class (`HOLDER_CLASSES`) and report
 *         the WALL-CLOCK a run was blocked, each instant charged once — never
 *         its phases' queued lane-time summed.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PHASE_CONSOLE_LOG = '';

const { Scheduler, AdmissionSerial, autopilotOwner, holderClass, isOwnLiveLane } = await import('../server/runner/scheduler.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { newRun, phaseRecord } = await import('../server/runner/state.ts');
const { renderMetrics } = await import('../server/analysis/metrics.ts');
const { closeQueueEpisode, foldRunBlocked, noteQueueHead, openQueueEpisode } = await import('../server/runner/queue-episodes.ts');
const { BLOCKED_BY_ORDER, HOLDER_CLASSES } = await import('../shared/run-lifecycle.js');
import type { Holder, LockView, ScopeGrant } from '../server/runner/scheduler.ts';
import type { RunState } from '../server/runner/state.ts';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const T0 = Date.parse('2026-09-25T09:00:00.000Z');
const MIN = 60_000;

class Probe extends Runner {
  scope = ['app'];
  installed(state: RunState): void {
    (this as unknown as { state: RunState }).state = state;
    (this as unknown as { driving: Promise<void> }).driving = Promise.resolve();
  }
  protected override async scopeFor(): Promise<string[]> { return this.scope; }
  admitNow(phase: number): Promise<ScopeGrant | null> { return this.admit(phase, 'phase'); }
  recoveryNow(phase: number): Promise<ScopeGrant | null> {
    const kind = 'recovery' as const;
    return this.admit(phase, kind);
  }
}

type Journal = { event: string; phase?: number; data: Record<string, unknown> }[];

function harness(locks: () => LockView[] = () => [], now: () => number = () => T0) {
  const journal: Journal = [];
  const emitted: Record<string, unknown>[] = [];
  const scheduler = new Scheduler({ max: 4, now, locks });
  const state = newRun({ slug: 'demo', root: '/tmp/demo' });
  const runner = new Probe({
    scriptsDir: '/nonexistent',
    scheduler,
    now: () => new Date(now()),
    onEvent: (event, data) => {
      if (event === 'run:phase') emitted.push(data as Record<string, unknown>);
      if (event !== 'run:journal') return;
      const line = data as { event: string; phase?: number; data: Record<string, unknown> };
      journal.push({ event: line.event, phase: line.phase, data: line.data ?? {} });
    },
  });
  runner.installed(state);
  return { scheduler, runner, journal, state, emitted };
}

/* ================================================================== *
 * OL-1 — at admission
 * ================================================================== */

test('OL-1: a phase whose scope meets a live lane of its own run is serial, never queued', async () => {
  const { scheduler, runner, journal, state, emitted } = harness();
  // Phase 3 of THIS run holds the scope — its lane is live.
  const lane = await scheduler.admit({ slug: 'demo', phase: 3, runId: state.id, scope: ['app'] });
  phaseRecord(state, 4).status = 'pending';

  await assert.rejects(runner.admitNow(4), (error) => error instanceof AdmissionSerial && error.behind === 3);

  const record = state.phases['4']!;
  assert.equal(record.serialBehind, 3, 'it reads ready (behind this run’s P3)');
  assert.equal(record.status, 'pending', 'its word is untouched — no queued badge');
  assert.equal(record.queuedAt, undefined, 'no episode was opened');
  assert.equal(record.queuedMs, undefined, 'and no queue time accrues');
  assert.equal(record.waitingOn, undefined);
  assert.equal(scheduler.snapshot().entries.length, 0, 'it never joined the scheduler');
  assert.equal(journal.filter((l) => l.event === 'phase.queued').length, 0, 'no phase.queued');
  assert.equal(journal.filter((l) => l.event === 'phase.admitted').length, 0, 'no admission, so no waitedMs');
  assert.deepEqual(journal.filter((l) => l.event === 'phase.serial-behind').map((l) => l.data), [{ behind: 3 }]);
  assert.ok(emitted.some((e) => e.phase === 4 && e.serialBehind === 3), 'the console is told');
  assert.notEqual(state.status, 'queued', 'the RUN is not repainted as waiting on itself');

  // Asked again while the lane lives: the same answer, and no second line.
  await assert.rejects(runner.admitNow(4), (error) => error instanceof AdmissionSerial);
  assert.equal(journal.filter((l) => l.event === 'phase.serial-behind').length, 1, 'once per change of the lane it is behind');

  // The lane ends: the phase boards, and the serial mark goes with it.
  scheduler.release(lane);
  const grant = await runner.admitNow(4);
  assert.ok(grant);
  assert.equal(record.serialBehind, undefined);
  scheduler.release(grant!);
  scheduler.close();
});

test('OL-1: a foreign holder beside its own live lane still makes it serial — it could not board before its sibling ends', async () => {
  const foreign: LockView = { slug: 'other', phase: 2, owner: 'someone@laptop', expired: false, scope: ['app'], leaseUntil: T0 + 60 * MIN };
  const { scheduler, runner, state } = harness(() => [foreign]);
  // The own grant is admitted under a guard that ignores the foreign lock.
  const lane = await new Promise<ScopeGrant>((resolve) => {
    const s = scheduler as unknown as { grants: Map<string, ScopeGrant> };
    const grant: ScopeGrant = { id: 'own-3', slug: 'demo', phase: 3, runId: state.id, scope: ['app'], at: T0 };
    s.grants.set(grant.id, grant);
    resolve(grant);
  });
  await assert.rejects(runner.admitNow(5), (error) => error instanceof AdmissionSerial && error.behind === 3);
  assert.equal(state.phases['5']!.serialBehind, 3);
  scheduler.release(lane);
  scheduler.close();
});

test('OL-1: a queued phase whose holders BECOME its own live lane leaves the queue for serial', async () => {
  let now = T0;
  let locks: LockView[] = [{ slug: 'other', phase: 1, owner: 'someone@laptop', expired: false, scope: ['app'], leaseUntil: T0 + 60 * MIN }];
  const { scheduler, runner, journal, state } = harness(() => locks, () => now);
  phaseRecord(state, 6).status = 'pending';
  const waiting = runner.admitNow(6);
  for (let i = 0; i < 5 && !journal.some((l) => l.event === 'phase.queued'); i++) await tick();
  assert.equal(state.phases['6']!.status, 'queued', 'behind a stranger: that is a queue');

  // The stranger lets go, and in the same moment a sibling lane of this run takes the scope.
  now += 7 * MIN;
  locks = [];
  const s = scheduler as unknown as { grants: Map<string, ScopeGrant> };
  s.grants.set('own-2', { id: 'own-2', slug: 'demo', phase: 2, runId: state.id, scope: ['app'], at: now });
  scheduler.poll();

  await assert.rejects(waiting, (error) => error instanceof AdmissionSerial && error.behind === 2);
  const record = state.phases['6']!;
  assert.equal(record.status, 'pending');
  assert.equal(record.serialBehind, 2);
  assert.equal(record.queuedAt, undefined);
  assert.equal(record.queuedMs, 7 * MIN, 'the real wait behind the stranger is kept');
  const closed = journal.filter((l) => l.event === 'phase.queue-closed');
  assert.deepEqual({ outcome: closed[0]?.data.outcome, why: closed[0]?.data.why }, { outcome: 'withdrawn', why: 'serial' });
  assert.equal(scheduler.snapshot().entries.length, 0, 'the entry left the scheduler');
  assert.equal(journal.filter((l) => l.event === 'phase.admitted').length, 0);
  scheduler.close();
});

test('OL-1: a recovery is an operator’s press, and queues behind its own lane as it always did', async () => {
  const { scheduler, runner, state } = harness();
  const lane = await scheduler.admit({ slug: 'demo', phase: 3, runId: state.id, scope: ['app'] });
  const recovery = runner.recoveryNow(4);
  for (let i = 0; i < 5 && !scheduler.snapshot().entries.length; i++) await tick();
  assert.equal(scheduler.snapshot().entries.length, 1, 'a recovery is not serial work of the run loop');
  assert.equal(state.phases['4']?.serialBehind, undefined);
  scheduler.release(lane);
  const grant = await recovery;
  scheduler.release(grant!);
  scheduler.close();
});

/* ================================================================== *
 * OL-2 — the drive loop's boarding pass
 * ================================================================== */

class LoopProbe extends Probe {
  /** The boarding pass's own question, asked the way the loop asks it. */
  async serialOf(phase: number, ahead: { phase: number; scope: string[] }[]): Promise<number | null> {
    return (this as unknown as {
      serialBehindOf(p: number, a: { phase: number; scope: string[] }[]): Promise<number | null>;
    }).serialBehindOf(phase, ahead);
  }
}

test('OL-2: the boarding pass reads a sibling boarded earlier in the same pass as a lane to be serial behind', async () => {
  const scheduler = new Scheduler({ max: 4, locks: () => [] });
  const runner = new LoopProbe({ scriptsDir: '/nonexistent', scheduler });
  const state = newRun({ slug: 'demo', root: '/tmp/demo' });
  runner.installed(state);
  assert.equal(await runner.serialOf(5, [{ phase: 4, scope: ['app'] }]), 4, 'same repository, same tree: serial');
  assert.equal(await runner.serialOf(5, [{ phase: 4, scope: ['other-repo'] }]), null, 'disjoint scopes board together');
  assert.equal(await runner.serialOf(5, [{ phase: 7, scope: ['app'] }, { phase: 4, scope: ['app'] }]), 4, 'the lowest lane is named');
  assert.equal(await runner.serialOf(5, []), null);
  scheduler.close();
  // No scheduler, no admission: a harness that is not about concurrency boards exactly as before.
  const bare = new LoopProbe({ scriptsDir: '/nonexistent' });
  bare.installed(state);
  assert.equal(await bare.serialOf(5, [{ phase: 4, scope: ['app'] }]), null);
});

/* ================================================================== *
 * OL-3 — the metrics split holders by class
 * ================================================================== */

test('OL-3: every holder has exactly one class, seen from the waiting run', () => {
  const run = 'aaaaaaaaaaaa';
  const holder = (over: Partial<Holder>): Holder => ({
    kind: 'grant', slug: 'demo', phase: 3, owner: autopilotOwner(run), scope: ['app'], overlaps: ['app'], ...over,
  });
  assert.equal(holderClass(holder({}), run), 'own-run');
  assert.equal(holderClass(holder({ kind: 'reserved' }), run), 'own-run');
  assert.equal(holderClass(holder({ owner: autopilotOwner('bbbbbbbbbbbb') }), run), 'other-run');
  assert.equal(holderClass(holder({ kind: 'lock', owner: 'someone@laptop' }), run), 'hand');
  assert.equal(holderClass(holder({ kind: 'lock', owner: autopilotOwner('bbbbbbbbbbbb') }), run), 'other-run');
  assert.equal(holderClass(holder({ kind: 'session', owner: 'session 1234' }), run), 'hand');
  assert.equal(holderClass(holder({ kind: 'reserved', slug: 'session cap', phase: null, owner: '3 of 3 lanes' }), run), 'clock');
  assert.equal(holderClass(holder({ kind: 'reserved', slug: 'boarding window', phase: null, clock: true }), run), 'clock');
  assert.equal(holderClass(holder({ kind: 'branch', owner: 'run x' }), run), 'other-run');
  // A dependency its own plan took back from done (control-tower phase 86,
  // #136) — its own run's business, whatever the owner line reads.
  assert.equal(holderClass(holder({ kind: 'after', owner: 'phase 2 of demo — its dependency is not done', overlaps: [] }), run), 'own-run');
  assert.equal(isOwnLiveLane(holder({ kind: 'after', owner: autopilotOwner(run) }), run), false, 'a dependency is not a live lane to be serial behind');
  for (const klass of ['own-run', 'other-run', 'hand', 'clock']) assert.ok(HOLDER_CLASSES.includes(klass as never));
  assert.equal(isOwnLiveLane(holder({}), run), true);
  assert.equal(isOwnLiveLane(holder({ kind: 'reserved' }), run), false, 'a reservation is not a live lane');
  assert.equal(isOwnLiveLane(holder({ owner: autopilotOwner('bbbbbbbbbbbb') }), run), false);
});

test('OL-3: the scheduler snapshot counts waiting entries by their head holder’s class', async () => {
  const s = new Scheduler({
    max: 4,
    locks: (): LockView[] => [{ slug: 'x', phase: 1, owner: 'someone@laptop', expired: false, scope: ['hand-repo'], leaseUntil: Date.now() + 60 * MIN }],
  });
  const lane = await s.admit({ slug: 'demo', phase: 1, runId: 'aaaaaaaaaaaa', scope: ['app'] });
  const own = s.admit({ slug: 'demo', phase: 2, runId: 'aaaaaaaaaaaa', scope: ['app'] });
  const other = s.admit({ slug: 'else', phase: 5, runId: 'bbbbbbbbbbbb', scope: ['app'] });
  const hand = s.admit({ slug: 'demo', phase: 9, runId: 'aaaaaaaaaaaa', scope: ['hand-repo'] });
  for (const p of [own, other, hand]) p.catch(() => {});
  await tick();
  assert.deepEqual(s.snapshot().byClass, { 'own-run': 1, 'other-run': 1, hand: 1 });
  s.release(lane);
  s.close();
});

test('OL-3: a run’s blocked time is WALL-CLOCK — each instant charged once, to the most external class holding any of its phases', () => {
  const state = newRun({ slug: 'demo', root: '/tmp/demo' });
  const at = (min: number): string => new Date(T0 + min * MIN).toISOString();
  const four = phaseRecord(state, 4);
  const five = phaseRecord(state, 5);
  const six = phaseRecord(state, 6);

  // 0′: phases 4 and 6 wait behind a person's lock.
  openQueueEpisode(four, at(0), 'hand');
  foldRunBlocked(state, at(0));
  openQueueEpisode(six, at(0), 'hand');
  foldRunBlocked(state, at(0));
  assert.deepEqual(state.blockedOpen, { class: 'hand', since: at(0) });
  // 10′: phase 5 queues behind another run — contention outranks the person.
  openQueueEpisode(five, at(10), 'other-run');
  foldRunBlocked(state, at(10));
  // 30′: that run lets go; the person still holds the other two.
  closeQueueEpisode(five, 'admitted', at(30));
  foldRunBlocked(state, at(30));
  // 45′: phase 6's holder becomes a clock — the person still holds phase 4.
  noteQueueHead(six, 'clock', at(45));
  foldRunBlocked(state, at(45));
  // 60′: everything is admitted.
  closeQueueEpisode(four, 'admitted', at(60));
  foldRunBlocked(state, at(60));
  closeQueueEpisode(six, 'admitted', at(60));
  foldRunBlocked(state, at(60));

  assert.deepEqual(state.blockedMs, { hand: 40 * MIN, 'other-run': 20 * MIN });
  assert.equal(state.blockedOpen, undefined, 'nothing waits, so nothing is open');
  const lane = (four.queuedMs ?? 0) + (five.queuedMs ?? 0) + (six.queuedMs ?? 0);
  assert.equal(lane, 140 * MIN, 'the phases waited 140 lane-minutes between them…');
  assert.equal(Object.values(state.blockedMs!).reduce((a, b) => a + (b ?? 0), 0), 60 * MIN, '…and the run was blocked for one wall-clock hour');
  assert.deepEqual(BLOCKED_BY_ORDER, ['other-run', 'hand', 'clock', 'own-run'], 'every class, the run’s own last');
});

test('OL-3: three siblings behind one stranger for an hour are one blocked hour, never three', async () => {
  let now = T0;
  let locks: LockView[] = [{ slug: 'other', phase: 1, owner: 'someone@laptop', expired: false, scope: ['app'], leaseUntil: T0 + 2 * 60 * MIN }];
  const { scheduler, runner, state } = harness(() => locks, () => now);
  const waits = [4, 5, 6].map((phase) => {
    phaseRecord(state, phase).status = 'pending';
    const pending = runner.admitNow(phase);
    pending.catch(() => {});
    return pending;
  });
  for (let i = 0; i < 10 && Object.values(state.phases).filter((r) => r.status === 'queued').length < 3; i++) await tick();
  assert.equal(Object.values(state.phases).filter((r) => r.status === 'queued').length, 3, 'all three wait on the stranger');
  assert.deepEqual(state.blockedOpen, { class: 'hand', since: new Date(T0).toISOString() });

  now += 60 * MIN;
  locks = [];
  scheduler.poll();
  const settled = await Promise.allSettled(waits);
  for (let i = 0; i < 10 && state.blockedOpen; i++) await tick();

  assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1, 'one boards; its siblings are serial behind it');
  assert.deepEqual(state.blockedMs, { hand: 60 * MIN }, 'one wall-clock hour, however many phases waited through it');
  assert.equal(state.blockedOpen, undefined);
  const grant = settled.find((s) => s.status === 'fulfilled') as PromiseFulfilledResult<ScopeGrant | null>;
  scheduler.release(grant.value!);
  scheduler.close();
});

test('OL-3: the metric reports blocked wall-clock by holder class, never phases’ queued time summed', () => {
  const text = renderMetrics({
    version: 'test', instanceId: 'x', scrapeSeconds: 0,
    plans: [], runs: [
      { slug: 'demo', status: 'running', spentUsd: 0, attempts: 1, phaseSeconds: 10, blockedSeconds: { 'other-run': 120, hand: 30 } },
      { slug: 'demo', status: 'finished', spentUsd: 0, attempts: 1, phaseSeconds: 10, blockedSeconds: { 'other-run': 60 } },
    ],
    cost: [], rungs: [], today: { settledUsd: 0, ladderUsd: 0, capUsd: null },
  });
  assert.match(text, /# TYPE phase_console_run_blocked_seconds_total counter/);
  assert.match(text, /phase_console_run_blocked_seconds_total\{slug="demo",class="other-run"\} 180/);
  assert.match(text, /phase_console_run_blocked_seconds_total\{slug="demo",class="hand"\} 30/);
  assert.doesNotMatch(text, /class="own-run"/, 'no own-run series when nothing queued behind its own run');
  assert.doesNotMatch(text, /phase_console_queued_seconds_total/, 'no series sums per-phase lane time as queued');
});

/* ================================================================== *
 * OL-4 — the lane verbs (control-tower phase 100) never make own work contention
 * ================================================================== */

test('OL-4: a pinned phase behind its own live lane is still serial, never queued — and a pin, a kept lane and the load guard are clocks', async () => {
  const { isCappableBlocker } = await import('../server/runner/scheduler.ts');
  const { LOAD_HOLDER, PIN_HOLDER, RESERVATION_HOLDER } = await import('../shared/orchestration-model.js');
  const run = 'aaaaaaaaaaaa';
  for (const slug of [PIN_HOLDER, RESERVATION_HOLDER, LOAD_HOLDER]) {
    const pseudo: Holder = { kind: 'reserved', slug, phase: null, owner: 'x', scope: ['all'], overlaps: ['all'], clock: true };
    assert.equal(holderClass(pseudo, run), 'clock', `${slug} is policy, never own-run pipelining`);
    assert.equal(isOwnLiveLane(pseudo, run), false);
    assert.equal(isCappableBlocker(pseudo), false, `${slug} is an operator's word or the machine's load — never capped into a park`);
  }

  const { scheduler, runner, state } = harness();
  const lane = await scheduler.admit({ slug: 'demo', phase: 3, runId: state.id, scope: ['app'] });
  phaseRecord(state, 4).status = 'pending';
  const pinned = runner.queueControl(4, 'pin', { by: 'operator', via: 'api', origin: 'local', remoteUser: null } as never);
  assert.equal(pinned.ok, true);
  await assert.rejects(runner.admitNow(4), (error) => error instanceof AdmissionSerial && error.behind === 3,
    'a pin does not turn a run\'s own serial work into contention');
  assert.equal(scheduler.snapshot().entries.length, 0, 'it never joined the scheduler');
  assert.ok(state.phases['4']!.queueControl?.pin, 'the pin stands for the moment its own lane ends');
  scheduler.release(lane);
  scheduler.close();
});
