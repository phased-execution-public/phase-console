/**
 * Lanes, pinned, reserved and yielded ATOMICALLY (control-tower phase 100,
 * #135 B.8 and D.15–17; #150 ask 2).
 *
 * Before this an operator who wanted one phase to take the next lane had two
 * levers: a bump, which a sibling's re-board beat in the same second (#134),
 * and steering a live session to declare `partial` and hoping. An all-scope
 * phase that parked on a CI watch lost its window at the park and starved
 * behind every lane that boarded in between (#135, 2026-09-29).
 *
 *   LP-1  a RESERVATION keeps the next lane on its scope for its phase: when
 *         the named lane ends the lane goes to it in the same scan — never to
 *         an older entry, never to the yielding lane's own re-board — and a
 *         reservation made while its phase is parked holds the scope and one
 *         lane slot until the phase comes back, then is spent; a PIN makes a
 *         phase its plan's next lane — its run's other entries wait while it
 *         waits for a lane, another plan's do not — and is spent when it
 *         boards; neither widens a scoped run, so a pin never breaks
 *         `honestScopedFinish`; a YIELD reserves the yielding lane for the
 *         named phase (or the head of the queue) and asks the session to hand
 *         off, journalled on the yielding run;
 *   LP-2  the lane verbs are rows of the ONE operator verb table, beside
 *         phase 90's `isolate-phase` and `isolate`, and each is a route:
 *         `POST /api/lane/<verb>`.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { Scheduler } = await import('../server/runner/scheduler.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { newRun, phaseRecord, saveRun, loadRun, honestScopedFinish } = await import('../server/runner/state.ts');
const { laneMarkRefusal } = await import('../server/runner/queue-control.ts');
const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { journalFile } = await import('../server/runner/run-paths.ts');
const { LANE_VERBS, PIN_HOLDER, RESERVATION_HOLDER } = await import('../shared/orchestration-model.js');
const { OPERATOR_VERBS, verbNamed } = await import('../shared/verb-model.js');
import type { EngineResult } from '../server/engine.ts';
import type { LockView, ScopeGrant } from '../server/runner/scheduler.ts';
import type { Actor, RunState } from '../server/runner/state.ts';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const MIN = 60_000;
const RA = 'aaaaaaaaaaaa';
const RB = 'bbbbbbbbbbbb';
const RC = 'cccccccccccc';
const RD = 'dddddddddddd';

const who = (reason?: string, by = 'operator'): Actor =>
  ({ by, via: 'api', origin: 'local', remoteUser: null, ...(reason ? { reason } : {}) }) as Actor;

async function settle(scheduler: InstanceType<typeof Scheduler>, n: number): Promise<void> {
  for (let i = 0; i < 40 && scheduler.snapshot().entries.length < n; i++) await tick();
  await tick();
}

const waiting = (scheduler: InstanceType<typeof Scheduler>, slug: string) =>
  scheduler.snapshot().entries.find((entry) => entry.slug === slug);
const grantedTo = (scheduler: InstanceType<typeof Scheduler>) =>
  scheduler.snapshot().grants.map((grant) => `${grant.slug}:${grant.phase}`);

/* ================================================================== *
 * LP-1 — a reservation hands the lane over in the same scan
 * ================================================================== */

test('LP-1: a lane reserved for a phase goes to it when the named lane ends — not to an older entry, not to a sibling\'s re-board (#134)', async () => {
  const scheduler = new Scheduler({ max: 2 });
  const lane = await scheduler.admit({ slug: 'alpha', phase: 1, runId: RA, scope: ['app'] });
  const older = scheduler.admit({ slug: 'beta', phase: 2, runId: RB, scope: ['app'] }); older.catch(() => {});
  const target = scheduler.admit({ slug: 'gamma', phase: 3, runId: RC, scope: ['app'] }); target.catch(() => {});
  await settle(scheduler, 2);

  scheduler.reserveLane({ slug: 'gamma', runId: RC, phase: 3, lane: { slug: 'alpha', phase: 1 }, by: 'operator', reason: 'gamma unblocks the release' });
  const [reservation] = scheduler.snapshot().reservations;
  assert.ok(reservation, 'the reservation is on the snapshot — the queue page and GET /api/queue read it');
  assert.equal(reservation!.armed, false, 'not armed while the lane it waits for is live');
  assert.equal(waiting(scheduler, 'gamma')!.laneReserved?.by, 'operator', 'its entry says a lane is reserved for it');

  // A sibling's wrap-up re-board is queued before the lane ends — the race #134 lost.
  const reboard = scheduler.admit({ slug: 'alpha', phase: 2, runId: RA, scope: ['app'] }); reboard.catch(() => {});
  await settle(scheduler, 3);

  scheduler.release(lane);
  assert.deepEqual(grantedTo(scheduler), ['gamma:3'], 'the lane went to the reserved phase in the same scan');
  assert.equal(scheduler.snapshot().reservations.length, 0, 'spent when its phase boarded');
  assert.ok(waiting(scheduler, 'beta'), 'the older entry still waits');
  assert.ok(waiting(scheduler, 'alpha'), 'and so does the sibling\'s re-board');
  const granted = await target;
  scheduler.release(granted);
  scheduler.close();
});

test('LP-1: a reservation made while its phase is parked holds its scope and one lane slot until the phase is back', async () => {
  const scheduler = new Scheduler({ max: 2 });
  // gamma P3 parked on a CI watch: no queue entry at all — its reservation stands anyway.
  scheduler.reserveLane({ slug: 'gamma', runId: RC, phase: 3, scope: ['all'], by: 'operator', reason: 'the all-scope deploy keeps its window' });
  assert.equal(scheduler.snapshot().reservations[0]!.armed, true, 'no lane named: armed at once');

  const onScope = scheduler.admit({ slug: 'beta', phase: 2, runId: RB, scope: ['app'] }); onScope.catch(() => {});
  await settle(scheduler, 1);
  const held = waiting(scheduler, 'beta')!;
  assert.equal(held.waitingOn[0]?.slug, RESERVATION_HOLDER, 'an entry on its scope waits on the reservation');
  assert.match(held.waitingOn[0]!.owner, /reserved for gamma P3 by operator — the all-scope deploy keeps its window/);
  assert.equal(held.waitingOn[0]!.clock, true, 'an operator\'s word: never capped like a stale lock');

  // A narrower reservation: only its own scope and one slot are kept.
  scheduler.unreserveLane(RC, 3);
  const free = await onScope;
  assert.deepEqual(grantedTo(scheduler), ['beta:2'], 'lifted: the entry boards at once');
  scheduler.release(free);

  scheduler.reserveLane({ slug: 'gamma', runId: RC, phase: 3, scope: ['app'], by: 'operator' });
  const disjoint = scheduler.admit({ slug: 'delta', phase: 4, runId: RD, scope: ['docs'] });
  const grant = await disjoint;
  assert.deepEqual(grantedTo(scheduler), ['delta:4'], 'a disjoint scope boards while a slot is left beyond the reserved one');
  const third = scheduler.admit({ slug: 'beta', phase: 5, runId: RB, scope: ['site'] }); third.catch(() => {});
  await settle(scheduler, 1);
  assert.equal(waiting(scheduler, 'beta')!.waitingOn[0]?.slug, RESERVATION_HOLDER, 'the last free slot is the reserved one');

  const back = scheduler.admit({ slug: 'gamma', phase: 3, runId: RC, scope: ['app'] });
  const boarded = await back;
  assert.equal(boarded.phase, 3, 'the phase back from its park boards on the slot kept for it');
  assert.equal(scheduler.snapshot().reservations.length, 0, 'and the reservation is spent');
  scheduler.release(boarded);
  scheduler.release(grant);
  const late = await third;
  scheduler.release(late);
  scheduler.close();
});

/* ================================================================== *
 * LP-1 — a pin: its plan's next lane
 * ================================================================== */

class Probe extends Runner {
  installed(state: RunState): void {
    (this as unknown as { state: RunState }).state = state;
    (this as unknown as { driving: Promise<void> }).driving = Promise.resolve();
  }
  protected override async scopeFor(phase: number): Promise<string[]> { return phase === 5 ? ['app'] : ['docs']; }
  protected override async script(): Promise<EngineResult> {
    return { stdout: 'free', stderr: '', code: 0 } as unknown as EngineResult;
  }
  admitNow(phase: number): Promise<ScopeGrant | null> { return this.admit(phase, 'phase'); }
}

function pinned(onlyPhases?: number[]) {
  let locks: LockView[] = [{
    slug: 'other', phase: 9, owner: 'someone@laptop', expired: false, scope: ['app'], leaseUntil: Date.now() + 60 * MIN,
  }];
  const scheduler = new Scheduler({ max: 4, locks: () => locks });
  const state = newRun({ slug: 'demo', root: '/tmp/demo', ...(onlyPhases ? { onlyPhases } : {}) } as never);
  const journal: { event: string; phase?: number; data: Record<string, unknown> }[] = [];
  const runner = new Probe({
    scriptsDir: '/nonexistent', scheduler,
    onEvent: (event, data) => {
      if (event !== 'run:journal') return;
      const line = data as { event: string; phase?: number; data?: Record<string, unknown> };
      journal.push({ event: line.event, phase: line.phase, data: line.data ?? {} });
    },
  });
  runner.installed(state);
  return { scheduler, runner, state, journal, free: (): void => { locks = []; scheduler.poll(); } };
}

test('LP-1: a pinned phase takes its plan\'s next lane — its run\'s other entries wait while it waits, another plan\'s do not', async () => {
  const h = pinned();
  const out = h.runner.queueControl(5, 'pin', who('P5 carries the migration'));
  assert.equal(out.ok, true);
  assert.equal(h.state.phases['5']!.queueControl?.pin?.reason, 'P5 carries the migration', 'the pin is on the record');
  const five = h.runner.admitNow(5); five.catch(() => {});
  const six = h.runner.admitNow(6); six.catch(() => {});
  const foreign = h.scheduler.admit({ slug: 'trade', phase: 43, runId: RB, scope: ['site'] });
  await settle(h.scheduler, 2);

  assert.equal(waiting(h.scheduler, 'demo') && h.scheduler.snapshot().entries.find((e) => e.phase === 5)?.pinned, true, 'the pinned entry says so');
  const sibling = h.scheduler.snapshot().entries.find((e) => e.phase === 6)!;
  assert.equal(sibling.waitingOn[0]?.slug, PIN_HOLDER, 'its sibling on a FREE scope waits for it');
  assert.match(sibling.waitingOn[0]!.owner, /demo P5 is pinned next by operator — P5 carries the migration/);
  const other = await foreign;
  assert.equal(other.slug, 'trade', 'another plan is not held by this plan\'s pin');
  h.scheduler.release(other);

  const line = h.journal.find((l) => l.event === 'phase.lane-pinned');
  assert.ok(line, 'journalled on the run');
  assert.equal(line!.data.reason, 'P5 carries the migration');

  h.free();
  const grant = await five;
  assert.ok(grant, 'the pinned phase boards the moment its scope is free');
  assert.equal(h.state.phases['5']!.queueControl?.pin, undefined, 'spent when it boards');
  const next = h.scheduler.snapshot().entries.find((e) => e.phase === 6);
  assert.notEqual(next?.waitingOn[0]?.slug, PIN_HOLDER, 'its sibling is no longer held by the pin');
  h.scheduler.release(grant!);
  const sib = await six.catch(() => null);
  if (sib) h.scheduler.release(sib);
  h.scheduler.close();
});

test('LP-1: a pin never widens a scoped run — a phase outside onlyPhases is refused, so honestScopedFinish is untouched', async () => {
  assert.equal(laneMarkRefusal({ onlyPhases: [2, 3] }, 3, 'pin'), null, 'inside the scope: allowed');
  assert.match(laneMarkRefusal({ onlyPhases: [2, 3] }, 5, 'pin') ?? '', /outside this run's scope \(P2, P3\)/);
  assert.match(laneMarkRefusal({ onlyPhases: [2, 3] }, 5, 'reserve') ?? '', /never widens a scoped run/);
  assert.equal(laneMarkRefusal({}, 5, 'pin'), null, 'an unscoped run: every phase is its own');

  const h = pinned([5]);
  const refused = h.runner.queueControl(6, 'pin', who());
  assert.equal(refused.ok, false);
  assert.equal((refused as { status: number }).status, 409);
  assert.equal(h.state.phases['6']?.queueControl, undefined, 'nothing written');
  assert.deepEqual(h.state.onlyPhases, [5], 'the scope is what it was');

  // A pinned phase that never settled is still OPEN to the honest sentence.
  assert.equal(h.runner.queueControl(5, 'pin', who()).ok, true);
  h.state.status = 'finished';
  phaseRecord(h.state, 5).status = 'pending';
  assert.equal(honestScopedFinish(h.state), true, 'the run that "finished" with its pinned phase open is corrected');
  assert.match(h.state.finishedReason ?? '', /unsettled/);
  assert.deepEqual(h.state.onlyPhases, [5]);
  h.scheduler.close();
});

test('LP-1: a phase that finishes however it finishes keeps no lane — its reservation cannot hold a scope for good', () => {
  const h = pinned();
  assert.equal(h.runner.queueControl(6, 'reserve', who('keep it')).ok, true);
  assert.deepEqual(h.scheduler.snapshot().reservations.map((r) => r.phase), [6], 'kept in the scheduler');
  phaseRecord(h.state, 6).status = 'done';   // closed outside the queue — a board reconcile, a hand
  (h.runner as unknown as { persist(): void }).persist();
  assert.equal(h.scheduler.snapshot().reservations.length, 0, 'the save drops it');
  assert.equal(h.state.phases['6']!.queueControl, undefined, 'and the mark with it');
  h.scheduler.close();
});

/* ================================================================== *
 * LP-1 (yield) and LP-2 — through the service and the routes
 * ================================================================== */

const trash: string[] = [];
process.on('exit', () => {
  for (const dir of trash) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const PLAN = (slug: string) => `---
slug: ${slug}
created: 2026-09-30
status: active
phases: 3
---

# ${slug}

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | cart api | — | — | app | it still works |
| 3 | deploy | — | — | app | shipped |

## Phases

### Phase 1 — schema
- **Size:** S

### Phase 2 — cart api
- **Size:** S

### Phase 3 — deploy
- **Size:** S
`;

function service(root: string, allowRun = true) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun, allowAccounts: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  return svc;
}

type Captured = { status: number; body: Record<string, unknown> };

async function call(svc: unknown, method: 'GET' | 'POST', path: string, body: unknown = {}): Promise<Captured> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out: Captured = { status: 0, body: {} };
  const payload = JSON.stringify(body);
  const req = {
    method,
    headers: { 'x-phase-console': '1', host: '127.0.0.1:4130', 'user-agent': 'Mozilla/5.0' },
    socket: { remoteAddress: '127.0.0.1' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload, 'utf8'); },
  };
  const res = {
    req,
    writeHead(status: number) { out.status = status; return this; },
    end(chunk: unknown) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      try { out.body = JSON.parse(text) as Record<string, unknown>; } catch { out.body = { text }; }
    },
    setHeader() { return this; },
    on() { return this; },
  };
  await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  return out;
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-lane-verbs-'));
  trash.push(root);
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  for (const slug of ['alpha', 'beta']) {
    mkdirSync(join(root, 'docs', 'handoffs', slug), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', `${slug}.md`), PLAN(slug), 'utf8');
  }
  return root;
}

function stored(root: string, slug: string, extra: Partial<RunState> = {}): RunState {
  const run: RunState = { ...newRun({ slug, root }), ...extra } as RunState;
  run.status = 'parked';
  for (const n of [1, 2, 3]) phaseRecord(run, n).status = 'pending';
  saveRun(run);
  return run;
}

const lines = (root: string, run: RunState) =>
  readFileSync(journalFile(root, run.slug, run.id), 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; phase?: number; data?: Record<string, unknown> });

test('LP-1: a yield reserves the yielding lane for the named phase, asks the session to hand off, and is journalled on the yielding run', async () => {
  const root = repo();
  const svc = service(root);
  try {
    const alpha = stored(root, 'alpha');
    const beta = stored(root, 'beta');
    const scheduler = (svc as unknown as { scheduler: InstanceType<typeof Scheduler> }).scheduler;
    // alpha P1 holds a live lane on `app`; beta P1 is older in the queue; beta P2 is the one it yields to.
    const lane = await scheduler.admit({ slug: 'alpha', phase: 1, runId: alpha.id, scope: ['app'] });
    const older = scheduler.admit({ slug: 'beta', phase: 1, runId: beta.id, scope: ['app'] }); older.catch(() => {});
    const target = scheduler.admit({ slug: 'beta', phase: 2, runId: beta.id, scope: ['app'] }); target.catch(() => {});
    await settle(scheduler, 2);

    const out = await call(svc, 'POST', '/api/lane/yield', { slug: 'alpha', phase: 1, to: { slug: 'beta', phase: 2 }, reason: 'beta P2 is the release' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const answer = out.body.yield as { to: { slug: string; phase: number }; steered: boolean; why?: string };
    assert.deepEqual(answer.to, { slug: 'beta', phase: 2 });
    assert.equal(answer.steered, false, 'no session of this console drives alpha — said, not pretended');
    assert.equal(loadRun(root, 'beta', beta.id)!.phases['2']!.queueControl?.reserve?.lane?.slug, 'alpha', 'the reservation is on the target\'s record, naming the lane');
    assert.ok(lines(root, alpha).some((line) => line.event === 'phase.lane-yielded' && line.data?.reason === 'beta P2 is the release'), 'journalled on the yielding run, with the reason');

    scheduler.release(lane);
    assert.deepEqual(grantedTo(scheduler), ['beta:2'], 'the lane went to the named phase, not the older entry');
    const granted = await target;
    scheduler.release(granted);
    const second = await older;
    scheduler.release(second);

    // With no `to`, the lane goes to the head of the queue.
    const again = await scheduler.admit({ slug: 'alpha', phase: 2, runId: alpha.id, scope: ['app'] });
    const head = scheduler.admit({ slug: 'beta', phase: 3, runId: beta.id, scope: ['app'] }); head.catch(() => {});
    await settle(scheduler, 1);
    const toHead = await call(svc, 'POST', '/api/lane/yield', { slug: 'alpha', phase: 2 });
    assert.equal(toHead.status, 200, JSON.stringify(toHead.body));
    assert.deepEqual((toHead.body.yield as { to: unknown }).to, { slug: 'beta', phase: 3 }, 'the head of the queue');
    scheduler.release(again);
    scheduler.release(await head);

    assert.equal((await call(svc, 'POST', '/api/lane/yield', { slug: 'alpha', phase: 3 })).status, 409, 'a phase with no live lane has nothing to yield');
  } finally {
    svc.close();
  }
});

test('LP-2: the lane verbs are rows of the one verb table, beside isolate-phase and isolate, and each is a route', async () => {
  for (const name of LANE_VERBS) assert.ok(verbNamed(name), `${name} is a row of the operator verb table`);
  for (const name of ['pin', 'unpin', 'reserve', 'unreserve', 'yield']) {
    const row = verbNamed(name)!;
    assert.equal(row.route, `POST /api/lane/${name}`);
    assert.equal(row.kind, 'act');
    assert.ok(row.method, `${name} names the Service method it presses`);
    assert.ok(row.cli, `${name} is a CLI word too`);
  }
  assert.equal(new Set(OPERATOR_VERBS.map((row) => row.name)).size, OPERATOR_VERBS.length, 'one row per verb');

  const root = repo();
  const svc = service(root);
  try {
    const alpha = stored(root, 'alpha');
    stored(root, 'beta', { onlyPhases: [1] } as Partial<RunState>);
    const pin = await call(svc, 'POST', '/api/lane/pin', { slug: 'alpha', phase: 2, reason: 'P2 first' });
    assert.equal(pin.status, 200, JSON.stringify(pin.body));
    assert.equal(loadRun(root, 'alpha', alpha.id)!.phases['2']!.queueControl?.pin?.reason, 'P2 first', 'a stopped run takes the pin on its record');
    assert.equal((await call(svc, 'POST', '/api/lane/unpin', { slug: 'alpha', phase: 2 })).status, 200);
    assert.equal(loadRun(root, 'alpha', alpha.id)!.phases['2']!.queueControl?.pin, undefined);

    const reserve = await call(svc, 'POST', '/api/lane/reserve', { slug: 'alpha', phase: 3, reason: 'keep the window' });
    assert.equal(reserve.status, 200, JSON.stringify(reserve.body));
    const queue = await call(svc, 'GET', '/api/queue');
    const reservations = queue.body.reservations as { slug: string; phase: number; reason?: string }[];
    assert.deepEqual(reservations.map((r) => [r.slug, r.phase, r.reason]), [['alpha', 3, 'keep the window']], 'the queue answers the reservation');
    assert.equal((await call(svc, 'POST', '/api/lane/unreserve', { slug: 'alpha', phase: 3 })).status, 200);
    assert.equal(((await call(svc, 'GET', '/api/queue')).body.reservations as unknown[]).length, 0);

    assert.equal((await call(svc, 'POST', '/api/lane/pin', { slug: 'beta', phase: 3 })).status, 409, 'outside a scoped run: refused, never widened');
    assert.equal((await call(svc, 'POST', '/api/lane/shove', { slug: 'alpha', phase: 1 })).status, 404);
    // Phase 90's two isolation verbs answer through the same door (#150 ask 2).
    for (const [verb, body] of [['isolate-phase', { slug: 'alpha', phase: 2 }], ['isolate', { slug: 'alpha' }]] as const) {
      const out = await call(svc, 'POST', `/api/lane/${verb}`, body);
      assert.doesNotMatch(String(out.body.error ?? ''), /no lane verb/, `${verb} is dispatched by the lane route`);
      assert.notEqual(out.status, 403);
    }
    assert.equal((await call(svc, 'POST', '/api/lane/pin', {})).status, 400);
    const names = lines(root, alpha).map((line) => line.event).filter((event) => event.startsWith('phase.lane-'));
    assert.deepEqual(names, ['phase.lane-pinned', 'phase.lane-unpinned', 'phase.lane-reserved', 'phase.lane-unreserved']);
  } finally {
    svc.close();
  }
  const bare = service(root, false);
  try {
    assert.equal((await call(bare, 'POST', '/api/lane/pin', { slug: 'alpha', phase: 2 })).status, 403, 'run-class authority, like the queue verbs');
  } finally {
    bare.close();
  }
});
