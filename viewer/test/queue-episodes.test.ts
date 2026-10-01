/**
 * Every minute of real queueing is recorded once and survives withdrawals and
 * restarts (control-tower phase 60, #81 — QE-1..4).
 *
 * The audit found about half of all queue time missing from `waitedMs`: it was
 * reported only at admission, so a pause, a halt, a park, a console restart or
 * the lock-wait cap threw away the clock — and the entry's place in the queue
 * with it, so a sibling's halt sent every waiter to the back of the line.
 *
 *   QE-1  an episode opens once, closes once with its outcome and length, and
 *         `queuedMs` is the sum of every episode, charged per holder class;
 *   QE-2  a withdrawn entry keeps its AGE and aging reservation, and the next
 *         entry is born with them — in the scheduler's order, too;
 *   QE-3  …across a console restart, whose open episode closes `restarted`
 *         where it was last seen waiting, not at the next boot;
 *   QE-4  every grant writes exactly one `phase.admitted`, naming what released it.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PHASE_CONSOLE_LOG = '';

const { Scheduler, AdmissionAborted } = await import('../server/runner/scheduler.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { newRun, phaseRecord } = await import('../server/runner/state.ts');
const { openQueueEpisode, noteQueueHead, closeQueueEpisode, restartedAt } = await import('../server/runner/queue-episodes.ts');
import type { LockView, ScopeGrant } from '../server/runner/scheduler.ts';
import type { PhaseRecord, RunState } from '../server/runner/state.ts';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const MIN = 60_000;
const T0 = Date.parse('2026-09-25T08:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/* ================================================================== *
 * QE-1 — the record's episodes
 * ================================================================== */

test('QE-1: an episode opens once, closes once, and queuedMs is every episode summed', () => {
  const record = { phase: 4, status: 'pending' } as PhaseRecord;

  assert.equal(openQueueEpisode(record, iso(T0), 'other-run'), true);
  assert.equal(openQueueEpisode(record, iso(T0 + 5 * MIN), 'other-run'), false, 'a re-arm of one wait is still one episode');
  noteQueueHead(record, 'hand', iso(T0 + 10 * MIN));
  const first = closeQueueEpisode(record, 'withdrawn', iso(T0 + 30 * MIN), 'pause');
  assert.deepEqual(first, { outcome: 'withdrawn', ms: 30 * MIN, queuedMs: 30 * MIN, waitedMs: 30 * MIN, since: iso(T0), why: 'pause' });
  assert.equal(closeQueueEpisode(record, 'withdrawn', iso(T0 + 31 * MIN)), null, 'a second close of one episode is no line at all');
  assert.equal(record.queueSince, iso(T0), 'a withdrawal keeps the entry’s age');

  openQueueEpisode(record, iso(T0 + 60 * MIN), 'hand');
  const second = closeQueueEpisode(record, 'admitted', iso(T0 + 75 * MIN));
  assert.equal(second?.ms, 15 * MIN);
  assert.equal(second?.queuedMs, 45 * MIN, 'cumulative: the withdrawn half is not lost');
  assert.equal(second?.waitedMs, 45 * MIN, 'the admission reports the whole wait, not its last leg');
  // Since control-tower phase 86 (#128) the AGE outlives the admission — it is
  // the seniority a re-board of this phase is born with; the wait itself ends.
  assert.equal(record.queueSince, iso(T0), 'the admission keeps the age (#128): a re-board is born this old');
  assert.equal(record.queueWaitedMs, undefined, 'the wait itself is over');
  assert.deepEqual(record.queuedByClass, { 'other-run': 10 * MIN, hand: 35 * MIN }, 'each stretch is charged to the class that held it');
});

test('QE-1: a restart ends the open episode where it was last SEEN waiting, never at the next boot', () => {
  const record = { phase: 2, status: 'queued' } as PhaseRecord;
  openQueueEpisode(record, iso(T0), 'other-run');
  record.queueSeenAt = iso(T0 + 40 * MIN);
  const at = restartedAt(record, iso(T0 + 9 * 60 * MIN));
  assert.equal(at, iso(T0 + 40 * MIN), 'the hours the console was down are not queue time');
  assert.equal(closeQueueEpisode(record, 'restarted', at)?.ms, 40 * MIN);
  // No sighting at all: the episode is a measured zero, not the downtime.
  const bare = { phase: 3 } as PhaseRecord;
  bare.queuedAt = iso(T0);
  assert.equal(restartedAt(bare, iso(T0 + 5 * 60 * MIN)), iso(T0));
});

/* ================================================================== *
 * QE-2 — the scheduler is born with the age it is given
 * ================================================================== */

test('QE-2: an entry born with an age takes its place among younger entries, and `aged` reserves at birth', async () => {
  let now = T0;
  const s = new Scheduler({ max: 1, now: () => now, locks: (): LockView[] => [] });
  const held = await s.admit({ slug: 'demo', phase: 1, runId: 'R1', scope: ['app'] });
  now += 5 * MIN;
  const young = s.admit({ slug: 'other', phase: 7, runId: 'R2', scope: ['app'] });
  young.catch(() => {});
  now += 1 * MIN;
  const old = s.admit({ slug: 'demo', phase: 4, runId: 'R1', scope: ['app'], since: T0 - 30 * MIN, aged: true });
  old.catch(() => {});
  await tick();

  const entries = s.snapshot().entries;
  assert.deepEqual(entries.map((e) => e.phase), [4, 7], 'the resumed entry is FIRST: it waited longer than the one that arrived before it');
  assert.equal(entries[0]!.since, T0 - 30 * MIN, 'born with its age');
  assert.equal(entries[0]!.reserving, true, 'born with its reservation');
  assert.equal(entries[0]!.order, 0, 'and first in the scan');

  s.release(held);
  const grant = await old;
  assert.equal(grant.phase, 4, 'the old entry is admitted before the younger one');
  s.close();
});

test('QE-2: an age in the future is read as now', async () => {
  const now = T0;
  const s = new Scheduler({ max: 1, now: () => now, locks: (): LockView[] => [] });
  const held = await s.admit({ slug: 'demo', phase: 1, runId: 'R1', scope: ['app'] });
  const late = s.admit({ slug: 'demo', phase: 2, runId: 'R1', scope: ['app'], since: T0 + 60 * MIN });
  late.catch(() => {});
  await tick();
  assert.equal(s.snapshot().entries[0]!.since, T0);
  s.release(held);
  s.close();
});

/* ================================================================== *
 * The runner's half — a runner with a state and no loop
 * ================================================================== */

class Probe extends Runner {
  scope = ['app'];
  installed(state: RunState): void {
    (this as unknown as { state: RunState }).state = state;
    (this as unknown as { driving: Promise<void> }).driving = Promise.resolve();
  }
  protected override async scopeFor(): Promise<string[]> { return this.scope; }
  admitNow(phase: number): Promise<ScopeGrant | null> { return this.admit(phase, 'phase'); }
  withdraw(why: 'pause' | 'halt' | 'park'): number { return this.withdrawQueued(why); }
  orphans(): void { this.closeOrphanedEpisodes(); }
}

type Journal = { event: string; phase?: number; data: Record<string, unknown> }[];

function harness(state: RunState, locks: () => LockView[], now: () => number) {
  const journal: Journal = [];
  const scheduler = new Scheduler({ max: 4, now, locks });
  const runner = new Probe({
    scriptsDir: '/nonexistent',
    scheduler,
    now: () => new Date(now()),
    onEvent: (event, data) => {
      if (event !== 'run:journal') return;
      const line = data as { event: string; phase?: number; data: Record<string, unknown> };
      journal.push({ event: line.event, phase: line.phase, data: line.data ?? {} });
    },
  });
  runner.installed(state);
  return { scheduler, runner, journal };
}

const lock = (owner: string, phase: number, leaseMs: number): LockView => ({
  slug: 'other', phase, owner, expired: false, scope: ['app'], leaseUntil: leaseMs,
});

test('QE-2/QE-3: a withdraw-then-resume keeps its age and reservation across a console restart', async () => {
  let now = T0;
  let locks: LockView[] = [lock('someone@laptop', 9, T0 + 8 * 60 * MIN)];
  const state = newRun({ slug: 'demo', root: '/tmp/demo' });
  phaseRecord(state, 5).status = 'pending';

  // The first console: phase 5 queues behind a stranger's claim.
  const one = harness(state, () => locks, () => now);
  const waiting = one.runner.admitNow(5);
  waiting.catch(() => {});
  for (let i = 0; i < 5 && !one.journal.some((l) => l.event === 'phase.queued'); i++) await tick();
  const record = state.phases['5']!;
  assert.equal(record.status, 'queued');
  assert.equal(record.queueSince, iso(T0));

  // Eleven minutes: it has aged into reserving, and the record keeps that.
  now += 11 * MIN;
  one.scheduler.poll();
  assert.equal(record.queueReserving, true, 'the reservation it earned is on the record');

  // A sibling's halt withdraws it.
  one.runner.withdraw('halt');
  await assert.rejects(waiting, (error) => error instanceof AdmissionAborted);
  const closed = one.journal.filter((l) => l.event === 'phase.queue-closed');
  assert.equal(closed.length, 1, 'one close, even though the lane’s own catch saw the abort too');
  assert.deepEqual(
    { outcome: closed[0]!.data.outcome, why: closed[0]!.data.why, ms: closed[0]!.data.ms },
    { outcome: 'withdrawn', why: 'halt', ms: 11 * MIN },
  );
  assert.equal(record.status, 'pending');
  assert.equal(record.queuedMs, 11 * MIN, 'the withdrawn wait is counted, not discarded');
  assert.equal(record.queueSince, iso(T0), 'the age survives the withdrawal');
  assert.deepEqual(state.blockedMs, { hand: 11 * MIN }, 'the run’s blocked wall-clock closes with the withdrawal');
  assert.equal(state.blockedOpen, undefined);
  one.scheduler.close();

  // The console restarts; the heal loop re-boards it two minutes later.
  now += 2 * MIN;
  const two = harness(state, () => locks, () => now);
  two.runner.orphans();
  assert.equal(two.journal.filter((l) => l.event === 'phase.queue-closed').length, 0, 'nothing was left open');
  const again = two.runner.admitNow(5);
  again.catch(() => {});
  for (let i = 0; i < 5 && !two.journal.some((l) => l.event === 'phase.queued'); i++) await tick();
  const entry = two.scheduler.snapshot().entries.find((e) => e.phase === 5)!;
  assert.equal(entry.since, T0, 'born with the age of the wait the halt interrupted');
  assert.equal(entry.reserving, true, 'and with its reservation — not at the back of the line');
  assert.equal(two.journal.find((l) => l.event === 'phase.queued')!.data.age, iso(T0));

  // The stranger lets go.
  now += 4 * MIN;
  locks = [];
  two.scheduler.poll();
  const grant = await again;
  assert.ok(grant);
  const admitted = two.journal.filter((l) => l.event === 'phase.admitted');
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0]!.data.waitedMs, 15 * MIN, 'the whole wait: 11 minutes, then 4 — never the downtime');
  assert.deepEqual(admitted[0]!.data.releasedBy, { slug: 'other', owner: 'someone@laptop', kind: 'lock', phase: 9, class: 'hand' });
  assert.equal(record.queuedMs, 15 * MIN);
  assert.equal(record.queueSince, iso(T0), 'the admission keeps the age — the seniority a re-board carries (#128)');
  assert.equal(record.queueReserving, undefined, 'the reservation ends with the wait');
  assert.deepEqual(state.blockedMs, { hand: 15 * MIN }, 'blocked for 11 minutes, then 4 — the two between were nobody’s wait');
  two.scheduler.release(grant);
  two.scheduler.close();
});

test('QE-3: an episode a dead console left open closes `restarted` at its last sighting', () => {
  const now = T0 + 6 * 60 * MIN;
  const state = newRun({ slug: 'demo', root: '/tmp/demo' });
  const record = phaseRecord(state, 3);
  record.status = 'queued';
  record.queuedAt = iso(T0);
  record.queueSince = iso(T0 - 20 * MIN);
  record.queueSeenAt = iso(T0 + 25 * MIN);
  record.lockWaitSince = iso(T0);
  record.waitingOn = [{ slug: 'other', phase: 1, owner: 'autopilot/abcdef012345' }];
  record.queueHead = { class: 'other-run', since: iso(T0) };
  // A sibling that was last seen waiting ten minutes before it.
  const sibling = phaseRecord(state, 4);
  sibling.status = 'queued';
  sibling.queuedAt = iso(T0 + 5 * MIN);
  sibling.queueSeenAt = iso(T0 + 15 * MIN);
  sibling.queueHead = { class: 'other-run', since: iso(T0 + 5 * MIN) };
  state.blockedOpen = { class: 'other-run', since: iso(T0) };
  const { runner, journal, scheduler } = harness(state, () => [], () => now);

  runner.orphans();

  const closed = journal.filter((l) => l.event === 'phase.queue-closed' && l.phase === 3);
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.data.outcome, 'restarted');
  assert.equal(closed[0]!.data.ms, 25 * MIN, 'ended where it was last seen, not six hours later at boot');
  assert.deepEqual(state.blockedMs, { 'other-run': 25 * MIN }, 'the run was blocked until the LAST sighting of any phase — not through the downtime');
  assert.equal(state.blockedOpen, undefined);
  assert.equal(record.status, 'pending', 'startable again, like a withdrawal leaves it');
  assert.equal(record.queueSince, iso(T0 - 20 * MIN), 'the age is kept for the next entry');
  assert.equal(record.lockWaitSince, undefined, 'a dead claim’s two hours restart with the console measuring them');

  // A second drive under the SAME queue is not a restart.
  record.queuedAt = iso(now);
  record.status = 'queued';
  runner.orphans();
  assert.equal(journal.filter((l) => l.event === 'phase.queue-closed').at(-1)!.data.outcome, 'withdrawn');
  assert.deepEqual(state.blockedMs, { 'other-run': 25 * MIN }, 'an episode with no head class charges nothing to the run');
  scheduler.close();
});

/* ================================================================== *
 * QE-4 — one `phase.admitted` per grant
 * ================================================================== */

test('QE-4: a free admission writes exactly one phase.admitted, with nothing named as its releaser', async () => {
  const now = T0;
  const state = newRun({ slug: 'demo', root: '/tmp/demo' });
  const { runner, journal, scheduler } = harness(state, () => [], () => now);
  const grant = await runner.admitNow(1);
  assert.ok(grant);
  const admitted = journal.filter((l) => l.event === 'phase.admitted');
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0]!.data.releasedBy, undefined);
  assert.equal(admitted[0]!.data.waitedMs, 0);
  assert.equal(journal.filter((l) => l.event === 'phase.queue-closed').length, 0, 'no wait, no episode');
  scheduler.release(grant);
  scheduler.close();
});

test('QE-4: a phase that joined free and was held by a later scan is queued, and its grant names the releaser', async () => {
  let now = T0;
  let locks: LockView[] = [];
  const state = newRun({ slug: 'demo', root: '/tmp/demo' });
  const { runner, journal, scheduler } = harness(state, () => locks, () => now);
  // The claim lands between the probe and the scan — the silent path.
  const origWould = scheduler.wouldBlock.bind(scheduler);
  scheduler.wouldBlock = (request) => {
    const answer = origWould(request);
    locks = [lock('autopilot/0123456789ab', 2, T0 + 60 * MIN)];
    return answer;
  };
  const pending = runner.admitNow(6);
  for (let i = 0; i < 5 && !journal.some((l) => l.event === 'phase.queued'); i++) await tick();
  assert.equal(state.phases['6']!.status, 'queued', 'a scan that finds it held says so');
  now += 3 * MIN;
  locks = [];
  scheduler.poll();
  const grant = await pending;
  const admitted = journal.filter((l) => l.event === 'phase.admitted');
  assert.equal(admitted.length, 1, 'one line per grant');
  assert.equal((admitted[0]!.data.releasedBy as { owner: string; class: string }).owner, 'autopilot/0123456789ab');
  assert.equal((admitted[0]!.data.releasedBy as { owner: string; class: string }).class, 'other-run');
  assert.equal(admitted[0]!.data.waitedMs, 3 * MIN);
  scheduler.release(grant!);
  scheduler.close();
});

test('QE-2 (control-tower phase 99): an operator\'s withdrawal closes the episode `withdrawn`, why `operator`, and the age survives it', async () => {
  const now = T0;
  const state = newRun({ slug: 'demo', root: '/tmp/demo' });
  phaseRecord(state, 5).status = 'pending';
  const { scheduler, runner, journal } = harness(state, () => [lock('someone@laptop', 9, T0 + 8 * 60 * MIN)], () => now);
  const waiting = runner.admitNow(5);
  waiting.catch(() => {});
  for (let i = 0; i < 5 && !journal.some((l) => l.event === 'phase.queued'); i++) await tick();
  const out = runner.queueControl(5, 'withdraw', { by: 'operator', via: 'api', origin: 'local', remoteUser: null, reason: 'not this week' });
  assert.equal(out.ok, true);
  await assert.rejects(waiting, (error) => error instanceof AdmissionAborted);
  const closed = journal.filter((l) => l.event === 'phase.queue-closed');
  assert.equal(closed.length, 1);
  assert.deepEqual({ outcome: closed[0]!.data.outcome, why: closed[0]!.data.why }, { outcome: 'withdrawn', why: 'operator' },
    'a person took this one entry out — not the run stopping');
  assert.equal(state.phases['5']!.queueSince, iso(T0), 'a re-queue is born as old as the wait it had');
  scheduler.close();
});
