/**
 * The holder a queued phase names is the CURRENT one (control-tower phase 60,
 * #82 — QH-1..3).
 *
 * The runner wrote `phase.queued` and the durable `waitingOn` once per
 * admission, while the scheduler re-derived the holders on every poll and told
 * nobody: every one of 95 admitted waits had exactly one `phase.queued`, and a
 * holder that took over later — a hand lock, then an own sibling, then another
 * run — was never recorded. The two-hour cap was armed from that entry-time
 * snapshot and fired whatever held the scope two hours later, against a live
 * refreshed lock, naming a lock that was already gone.
 *
 *   QH-1  a change of holder is journalled and the durable shadow follows it;
 *   QH-2  the cap re-scans when it fires and parks only on a cappable holder
 *         that STILL blocks, naming that one; a park re-arms only once nothing
 *         cappable meets its scope — not when its own phase's lock is free;
 *   QH-3  an autopilot lane’s lock whose run holds the grant or runs the
 *         session reads `live`, so it is never cappable;
 *   QH-4  a dependency the board took back from done is an `after` holder
 *         like any other: `phase.queued` and the durable shadow name it, a
 *         change to it is journalled, and it holds the entry in its place
 *         (control-tower phase 86, #136).
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PHASE_CONSOLE_LOG = '';

const { Scheduler, AdmissionAborted, AdmissionCapped, isCappableBlocker } = await import('../server/runner/scheduler.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { newRun, phaseRecord } = await import('../server/runner/state.ts');
const { lockHasLiveLane } = await import('../server/converge.ts');
const { LOCK_WAIT_CAP_MS } = await import('../server/runner/runner-core.ts');
import type { Board } from '../server/engine.ts';
import type { EngineResult } from '../server/engine.ts';
import type { LockView, ScopeGrant } from '../server/runner/scheduler.ts';
import type { RunState } from '../server/runner/state.ts';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const MIN = 60_000;

class Probe extends Runner {
  scope = ['app'];
  lockStatus = 'phase 5: free';
  installed(state: RunState): void {
    (this as unknown as { state: RunState }).state = state;
    (this as unknown as { driving: Promise<void> }).driving = Promise.resolve();
  }
  protected override async scopeFor(): Promise<string[]> { return this.scope; }
  protected override async script(): Promise<EngineResult> {
    return { stdout: this.lockStatus, stderr: '', code: 0 } as unknown as EngineResult;
  }
  admitNow(phase: number): Promise<ScopeGrant | null> { return this.admit(phase, 'phase'); }
  rearm(board: Board): Promise<void> { return this.rearmLockCapParks(board); }
  /** What the drive loop does with every board it reads — the `awaiting` probe answers from it. */
  read(board: Board): void { this.noteBoard(board); }
}

/** A board on which phase 5 waits for the dependencies named, or nothing. */
const boardWith = (awaits: number[]): Board => ({
  phased: true,
  states: { 3: awaits.includes(3) ? 'in-progress' : 'done', 5: awaits.length ? 'waiting' : 'ready' },
  ready: awaits.length ? [] : [5],
  blockedBy: awaits.length ? { 5: awaits } : {},
}) as unknown as Board;

type Journal = { event: string; phase?: number; data: Record<string, unknown> }[];

function harness(locks: () => LockView[], presence?: (lock: LockView) => 'live' | 'unknown' | 'ended') {
  const journal: Journal = [];
  const scheduler = new Scheduler({ max: 4, locks, ...(presence ? { presence } : {}) });
  const state = newRun({ slug: 'demo', root: '/tmp/demo' });
  const runner = new Probe({
    scriptsDir: '/nonexistent',
    scheduler,
    onEvent: (event, data) => {
      if (event !== 'run:journal') return;
      const line = data as { event: string; phase?: number; data: Record<string, unknown> };
      journal.push({ event: line.event, phase: line.phase, data: line.data ?? {} });
    },
  });
  runner.installed(state);
  return { scheduler, runner, journal, state };
}

const claim = (owner: string, phase: number, extra: Partial<LockView> = {}): LockView => ({
  slug: 'other', phase, owner, expired: false, scope: ['app'], leaseUntil: Date.now() + 60 * MIN, ...extra,
});

const queuedOn = async (journal: Journal): Promise<void> => {
  for (let i = 0; i < 20 && !journal.some((l) => l.event === 'phase.queued'); i++) await tick();
};

/* ================================================================== *
 * QH-1
 * ================================================================== */

test('QH-1: a change of holder is journalled, and the durable shadow names the new one', async () => {
  let locks = [claim('someone@laptop', 1)];
  const { scheduler, runner, journal, state } = harness(() => locks);
  const waiting = runner.admitNow(5);
  waiting.catch(() => {});
  await queuedOn(journal);
  assert.equal(state.phases['5']!.waitingOn?.[0]?.owner, 'someone@laptop');

  // The person lets go; another run's lane takes the scope before the waiter can.
  locks = [claim('autopilot/0123456789ab', 3, { slug: 'third' })];
  scheduler.poll();
  scheduler.poll();

  const changed = journal.filter((l) => l.event === 'phase.queue-holder-changed');
  assert.equal(changed.length, 1, 'once per change — a second identical scan says nothing');
  assert.deepEqual(changed[0]!.data.from, { slug: 'other', phase: 1, owner: 'someone@laptop', kind: 'lock' });
  assert.deepEqual(changed[0]!.data.to, { slug: 'third', phase: 3, owner: 'autopilot/0123456789ab', kind: 'lock' });
  assert.equal(changed[0]!.data.headClass, 'other-run');
  assert.equal(state.phases['5']!.waitingOn?.[0]?.owner, 'autopilot/0123456789ab', 'the inbox and the Now card read the CURRENT holder');
  assert.equal(journal.filter((l) => l.event === 'phase.queued').length, 1, 'the wait itself did not start again');

  locks = [];
  scheduler.poll();
  const grant = await waiting;
  const admitted = journal.find((l) => l.event === 'phase.admitted')!;
  assert.equal((admitted.data.releasedBy as { owner: string }).owner, 'autopilot/0123456789ab', 'the admission names the holder whose release let it through');
  scheduler.release(grant!);
  scheduler.close();
});

/* ================================================================== *
 * QH-2
 * ================================================================== */

test('QH-2: the cap re-scans when it fires, and parks naming the claim that blocks NOW — with its lease as it stands now', async () => {
  let locks = [claim('first@laptop', 1)];
  const { scheduler, runner, journal, state } = harness(() => locks);
  // Two hours, less a beat, already spent behind dead claims.
  phaseRecord(state, 5).lockWaitSince = new Date(Date.now() - LOCK_WAIT_CAP_MS + 120).toISOString();
  const waiting = runner.admitNow(5);
  await queuedOn(journal);
  // Before the cap fires, the claim in the way changes hands.
  const lease = Date.now() + 42 * MIN;
  locks = [claim('second@laptop', 2, { leaseUntil: lease })];

  await assert.rejects(waiting, (error) => error instanceof AdmissionCapped);
  const record = state.phases['5']!;
  assert.equal(record.status, 'parked');
  assert.match(record.note ?? '', /locked by second@laptop/, 'the park names the holder in the way when it fired');
  assert.match(record.note ?? '', new RegExp(new Date(lease).toISOString()), 'with its lease as it stands then');
  const capped = journal.find((l) => l.event === 'phase.lock-wait-capped')!;
  assert.equal(capped.data.holder, 'second@laptop');
  assert.equal(capped.data.phase, 2);
  assert.equal(journal.find((l) => l.event === 'phase.queue-closed')!.data.outcome, 'capped');
  scheduler.close();
});

test('QH-2: a cap that fires with no cappable claim left does not park, and the wait goes on', async () => {
  let locks = [claim('first@laptop', 1)];
  const presence = (lock: LockView): 'live' | 'unknown' => (lock.owner === 'present@laptop' ? 'live' : 'unknown');
  const { scheduler, runner, journal, state } = harness(() => locks, presence);
  phaseRecord(state, 5).lockWaitSince = new Date(Date.now() - LOCK_WAIT_CAP_MS + 150).toISOString();
  const waiting = runner.admitNow(5);
  waiting.catch(() => {});
  await queuedOn(journal);
  // A person is in the session holding it now: a queue to wait in, not debris.
  locks = [claim('present@laptop', 1, { session: 'sess-1' })];
  await sleep(300);

  const record = state.phases['5']!;
  assert.equal(record.status, 'queued', 'still waiting — never parked behind a live session');
  assert.equal(journal.some((l) => l.event === 'phase.lock-wait-capped'), false);
  assert.equal(record.lockWaitSince, undefined, 'the wait on a dead claim is over, so its two hours are too');
  assert.equal(record.waitingOn?.[0]?.owner, 'present@laptop');

  locks = [];
  scheduler.poll();
  const grant = await waiting;
  scheduler.release(grant!);
  scheduler.close();
});

test('QH-2: a cap park re-arms only once nothing cappable meets its scope — its own phase’s lock being free is not enough', async () => {
  let locks = [claim('stranger@laptop', 9, { slug: 'another-plan' })];
  const { scheduler, runner, journal, state } = harness(() => locks);
  const record = phaseRecord(state, 5);
  record.status = 'parked';
  record.note = 'phase 5 is locked by stranger@laptop and has waited 120 minutes for it';
  runner.lockStatus = 'phase 5: free';
  const board = { states: { 5: 'ready' } } as unknown as Board;

  await runner.rearm(board);
  assert.equal(record.status, 'parked', 'the claim it was capped behind is another plan’s, and it is still there');
  assert.equal(journal.some((l) => l.event === 'phase.lock-cap-rearmed'), false);

  locks = [];
  await runner.rearm(board);
  assert.notEqual(record.status, 'parked', 'the claim is gone: the wait starts over');
  assert.equal(journal.filter((l) => l.event === 'phase.lock-cap-rearmed').length, 1);
  scheduler.close();
});

/* ================================================================== *
 * QH-3
 * ================================================================== */

test('QH-3: an autopilot lane’s lock reads live while its run holds the grant or runs the session', () => {
  const owner = 'autopilot/0123456789ab';
  const grants = [{ runId: '0123456789ab', slug: 'other', phase: 4 }];
  assert.equal(lockHasLiveLane({ owner, slug: 'other', phase: 4 }, grants, []), true, 'its run holds the grant');
  assert.equal(lockHasLiveLane({ owner, slug: 'other', phase: 5 }, grants, []), false, 'a different phase of that run');
  assert.equal(lockHasLiveLane({ owner: 'someone@laptop', slug: 'other', phase: 4 }, grants, []), false, 'a person’s lock is the registry’s business');

  const run = { id: '0123456789ab', children: { 7: { pid: 4242, phase: 7 } } } as unknown as RunState;
  assert.equal(lockHasLiveLane({ owner, phase: 7 }, [], [run], (pid) => pid === 4242), true, 'another console’s lane, its session alive');
  assert.equal(lockHasLiveLane({ owner, phase: 7 }, [], [run], () => false), false, 'the session is gone: lease rules decide');

  // …and a live lock is never capped, while the same lock reading `unknown` was.
  const holder = { kind: 'lock' as const, slug: 'other', phase: 4, owner, scope: ['app'], overlaps: ['app'] };
  assert.equal(isCappableBlocker({ ...holder, presence: 'live' }), false);
  assert.equal(isCappableBlocker(holder), true);
});

test('QH-3: the scheduler names a live lane’s lock as live, so the admission cap never arms on it', async () => {
  const lane = claim('autopilot/0123456789ab', 4, { session: 'lane-session' });
  const { scheduler, runner, journal, state } = harness(() => [lane], () => 'live');
  const waiting = runner.admitNow(5);
  await queuedOn(journal);
  assert.equal(state.phases['5']!.lockWaitSince, undefined, 'no cap clock behind a live lane');
  scheduler.close();
  await assert.rejects(waiting, (error) => error instanceof AdmissionAborted);
});

/* ================================================================== *
 * QH-4 — a dependency not done is a holder (control-tower phase 86, #136)
 * ================================================================== */

test('QH-4: a phase admitted while its dependency is not done queues on an `after` holder — `phase.queued` and the shadow name the dependency', async () => {
  const { scheduler, runner, journal, state } = harness(() => []);
  runner.read(boardWith([3]));
  const waiting = runner.admitNow(5);
  await queuedOn(journal);

  const queued = journal.find((l) => l.event === 'phase.queued')!;
  assert.equal(queued.data.headKind, 'after', 'the head holder is the dependency, not a lock or a lane');
  assert.equal(queued.data.headClass, 'own-run', 'its own plan holds it — neither another run nor a person');
  const named = (queued.data.waitingOn as { slug: string; phase: number; owner: string }[])[0]!;
  assert.equal(named.slug, 'demo');
  assert.equal(named.phase, 3);
  assert.match(named.owner, /phase 3 of demo/);
  const shadow = state.phases['5']!.waitingOn?.[0];
  assert.equal(shadow?.phase, 3, 'the durable shadow — what the inbox and the Now card read — names the dependency');
  assert.match(shadow?.owner ?? '', /its dependency is not done/);
  assert.equal(state.phases['5']!.status, 'queued');
  assert.equal(state.phases['5']!.lockWaitSince, undefined, 'a dependency is not a claim, so no cap clock');

  // The board still reads it not done: a scan holds the entry where it is.
  scheduler.poll();
  assert.equal(state.phases['5']!.status, 'queued', 'held in place — never granted on the stale board, never withdrawn');

  // Its dependency is done again: the next board read lets it through.
  runner.read(boardWith([]));
  const grant = await waiting;
  assert.ok(grant, 'granted the scan its dependency is done');
  assert.equal(journal.filter((l) => l.event === 'phase.queued').length, 1, 'one wait, one `phase.queued`');
  scheduler.release(grant!);
  scheduler.close();
});

test('QH-4: a dependency the board takes back while the phase waits becomes its head holder — journalled as a change, the shadow following', async () => {
  let locks = [claim('someone@laptop', 1)];
  const { scheduler, runner, journal, state } = harness(() => locks);
  runner.read(boardWith([]));
  const waiting = runner.admitNow(5);
  waiting.catch(() => {});
  await queuedOn(journal);
  assert.equal(state.phases['5']!.waitingOn?.[0]?.owner, 'someone@laptop');

  // Phase 3 reopens under it — and the person lets go in the same breath.
  runner.read(boardWith([3]));
  locks = [];
  scheduler.poll();

  const changed = journal.filter((l) => l.event === 'phase.queue-holder-changed');
  assert.equal(changed.length, 1);
  assert.deepEqual(changed[0]!.data.from, { slug: 'other', phase: 1, owner: 'someone@laptop', kind: 'lock' });
  const to = changed[0]!.data.to as { slug: string; phase: number; owner: string; kind: string };
  assert.equal(to.kind, 'after');
  assert.equal(to.phase, 3);
  assert.equal(changed[0]!.data.headClass, 'own-run');
  assert.equal(state.phases['5']!.waitingOn?.[0]?.phase, 3, 'the shadow names the dependency now, not the lock that let go');
  assert.equal(state.phases['5']!.status, 'queued', 'a free scope does not board a phase whose dependency is not done');

  runner.read(boardWith([]));
  const grant = await waiting;
  assert.ok(grant);
  scheduler.release(grant!);
  scheduler.close();
});

/* ================================================================== *
 * QH-5 (control-tower phase 99, #135 E) — an operator's hold is a holder like any other
 * ================================================================== */

test('QH-5: a hold on the entry becomes its CURRENT holder — journalled, on the durable shadow — and a clock the cap never parks', async () => {
  const { scheduler, runner, journal, state } = harness(() => [claim('someone@laptop', 1)]);
  const waiting = runner.admitNow(5);
  waiting.catch(() => {});
  await queuedOn(journal);
  const out = runner.queueControl(5, 'hold', { by: 'operator', via: 'api', origin: 'local', remoteUser: null, reason: 'waiting for the CI fix' });
  assert.equal(out.ok, true);
  scheduler.poll();
  const changed = journal.filter((l) => l.event === 'phase.queue-holder-changed');
  assert.equal(changed.length, 1, 'the head moved from the lock to the hold, and the record says so');
  assert.equal((changed[0]!.data.to as { slug: string }).slug, 'held entry');
  assert.equal(changed[0]!.data.headClass, 'clock');
  assert.match(String(state.phases['5']!.waitingOn?.[0]?.owner), /held in the queue by operator — waiting for the CI fix/);
  const [entry] = scheduler.snapshot().entries;
  assert.equal(isCappableBlocker(entry!.waitingOn[0]!), false, 'a person\'s hold is never capped into a park');
  scheduler.close();
});
