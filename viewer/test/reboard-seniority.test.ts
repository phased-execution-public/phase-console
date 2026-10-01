/**
 * A re-board keeps its seat (control-tower phase 86, #128 #132 #114).
 *
 * Measured on both consoles: a phase that handed off at a context wrap-up, or
 * was re-boarded by a Retry, sat hinted for 3–12 hours while every freshly
 * READY phase boarded past it — the drive loop built its candidates as
 * `[reverifying, board.ready, expiredWaits, hinted]`, so the first free lane
 * always went to a phase that had never started, and a hint made no queue
 * entry at all until some lane happened to end.
 *
 *   RS-1  the candidates are ordered by SENIORITY — a hinted, checkpointed or
 *         wall-expired phase boards ahead of a `board.ready` phase that never
 *         started, oldest clock first;
 *   RS-2  the age is carried across a re-board: an admission no longer ends
 *         `queueSince`, and seniority is the oldest of queue age, hint time and
 *         park expiry;
 *   RS-3  a hint set on a live run wakes the loop — the hinted phase takes a
 *         free lane without waiting for the live one to end;
 *   RS-4  `/api/queue` names a hinted-not-queued phase with its time, from one
 *         shared reader the Runs page uses too.
 * (RS-5 is in `press-does-what-it-says.test.ts`, RS-6 in `ladder-rearm.test.ts`.)
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { boardHarness, journalled } from './lane-harness.ts';

process.env.PHASE_CONSOLE_LOG = '';

const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const episodes = await import('../server/runner/queue-episodes.ts');
const lifecycle = await import('../shared/run-lifecycle.js');
type RunState = import('../server/runner/state.ts').RunState;
type PhaseRecord = import('../server/runner/state.ts').PhaseRecord;

const MIN = 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

/** A stopped run of `demo` over the harness's root, shaped by `over`, saved. */
function stored(root: string, over: (state: RunState) => void): RunState {
  const state = newRun({ slug: 'demo', root, autonomy: 'keep-going', autoRecover: false } as never);
  state.status = 'parked';
  over(state);
  saveRun(state);
  return state;
}

const hint = (at: string, by = 'console', rung = 'reboard-resume-brief') =>
  ({ situation: 'work-in-progress', rung, brief: 'resume' as const, at, by });

/* ------------------------------------------------------------------ *
 * RS-1 — seniority orders the candidates
 * ------------------------------------------------------------------ */

test('RS-1: a hinted in-progress phase boards ahead of board.ready phases that never started (#128, #114)', async () => {
  const h = boardHarness({ states: { 1: 'done', 2: 'in-progress', 3: 'ready', 4: 'ready' } });
  const run = stored(h.root, (state) => {
    phaseRecord(state, 1).status = 'done';
    Object.assign(phaseRecord(state, 2), { status: 'pending', attempts: 1, boardingHint: hint(ago(2 * 60 * MIN)) });
  });
  await h.runner.start({ slug: 'demo', root: h.root, resumeRunId: run.id, maxParallel: 1 } as never);
  await h.runner.wait();
  assert.deepEqual(h.spawned, [2, 3, 4], 'the phase that has already worked boards first; the fresh ones after it, in the board\'s order');
});

test('RS-1: the oldest clock boards first — queue age, hint time and park expiry are one seniority; no clock boards last', async () => {
  const h = boardHarness({ states: { 1: 'done', 2: 'in-progress', 3: 'in-progress', 4: 'ready', 5: 'ready' } });
  const run = stored(h.root, (state) => {
    // The ladder is on, as it is on every real run: it is what boards a phase
    // whose park a relaunch found expired.
    state.autoRecover = true;
    phaseRecord(state, 1).status = 'done';
    // 2 — hinted an hour ago (a wrap-up's re-board).
    Object.assign(phaseRecord(state, 2), { status: 'pending', attempts: 1, boardingHint: hint(ago(60 * MIN)) });
    // 3 — a usage-wall park whose window expired two hours ago.
    Object.assign(phaseRecord(state, 3), {
      status: 'waiting', attempts: 1, parkedUntil: ago(2 * 60 * MIN),
      usageWall: { account: 'default', bucket: 'five_hour', latest: ago(2 * 60 * MIN), probes: 0 },
    });
    // 4 — never started, but it joined a queue three hours ago and was withdrawn.
    Object.assign(phaseRecord(state, 4), { status: 'pending', queueSince: ago(3 * 60 * MIN) });
    // 5 — never started, never queued: no clock at all.
  });
  await h.runner.start({ slug: 'demo', root: h.root, resumeRunId: run.id, maxParallel: 1 } as never);
  await h.runner.wait();
  assert.deepEqual(h.spawned, [4, 3, 2, 5], 'oldest first: queue age 3 h, park expiry 2 h, hint 1 h — then the phase with no clock');
});

/* ------------------------------------------------------------------ *
 * RS-2 — the age survives a re-board
 * ------------------------------------------------------------------ */

test('RS-2: an admission keeps the entry\'s age — a re-board joins the queue as old as the wait it replaced', () => {
  const record = {} as PhaseRecord;
  const t0 = ago(90 * MIN);
  episodes.openQueueEpisode(record, t0, 'grant');
  episodes.closeQueueEpisode(record, 'admitted', ago(60 * MIN));
  assert.equal(record.queueSince, t0, 'the age outlives the admission (it used to end there)');
  assert.equal(record.queueWaitedMs, undefined, 'the wait itself is over');
  assert.equal(record.queueReserving, undefined, 'and its reservation with it');
  // The wrap-up re-queues it: the next episode is born where the first one stood.
  episodes.openQueueEpisode(record, ago(5 * MIN), 'grant');
  assert.equal(record.queueSince, t0);
});

test('RS-2: seniority is the oldest of queue age, hint time and an EXPIRED park — and names its clock', () => {
  const { seniorityOf } = episodes as unknown as {
    seniorityOf: (record: Partial<PhaseRecord>, now?: string) => { at: string; clock: string } | null;
  };
  assert.equal(typeof seniorityOf, 'function', 'one reader of the three clocks');
  const now = new Date().toISOString();
  assert.equal(seniorityOf({}, now), null, 'a phase that never waited has no seniority');
  assert.deepEqual(seniorityOf({ boardingHint: hint('2026-09-26T08:00:00.000Z') } as never, now),
    { at: '2026-09-26T08:00:00.000Z', clock: 'hint' }, 'a hint alone is a claim');
  const hinted = seniorityOf({ boardingHint: hint('2026-09-26T08:00:00.000Z'), queueSince: '2026-09-26T09:00:00.000Z' } as never, now)!;
  assert.deepEqual(hinted, { at: '2026-09-26T08:00:00.000Z', clock: 'hint' });
  const queued = seniorityOf({ boardingHint: hint('2026-09-26T08:00:00.000Z'), queueSince: '2026-09-26T07:00:00.000Z' } as never, now)!;
  assert.deepEqual(queued, { at: '2026-09-26T07:00:00.000Z', clock: 'queue' });
  const parked = seniorityOf({ status: 'waiting', parkedUntil: '2026-09-26T06:00:00.000Z', queueSince: '2026-09-26T07:00:00.000Z' } as never, now)!;
  assert.deepEqual(parked, { at: '2026-09-26T06:00:00.000Z', clock: 'park' });
  const future = new Date(Date.now() + 60 * MIN).toISOString();
  assert.equal(seniorityOf({ status: 'waiting', parkedUntil: future } as never, now), null, 'a park still running is no claim to a lane');
});

/* ------------------------------------------------------------------ *
 * RS-3 — a hint on a live run is acted on at once
 * ------------------------------------------------------------------ */

test('RS-3: a hint set on a live run wakes the loop — the hinted phase takes a free lane while the other lane still runs', async () => {
  let releaseOne!: () => void;
  const one = new Promise<void>((done) => { releaseOne = done; });
  const h = boardHarness({
    states: { 1: 'ready', 2: 'in-progress' },
    repos: { 1: 'web', 2: 'api' },
    onSpawn: async (phase) => { if (phase === 1) await one; },
  });
  const run = stored(h.root, (state) => {
    Object.assign(phaseRecord(state, 2), { status: 'pending', attempts: 1 });
  });
  await h.runner.start({ slug: 'demo', root: h.root, resumeRunId: run.id, maxParallel: 2 } as never);
  try {
    for (let i = 0; i < 100 && !h.spawned.includes(1); i++) await new Promise((done) => { setTimeout(done, 20); });
    assert.deepEqual(h.spawned, [1], 'phase 1 runs; phase 2 has nothing boarding it yet');
    const live = (h.runner as unknown as { state: RunState }).state;
    (h.runner as unknown as { reboardWith(record: PhaseRecord, hint: unknown): void })
      .reboardWith(phaseRecord(live, 2), hint(new Date().toISOString()));
    for (let i = 0; i < 100 && !h.spawned.includes(2); i++) await new Promise((done) => { setTimeout(done, 20); });
    assert.deepEqual(h.spawned, [1, 2], 'the hint boarded phase 2 on the free lane — it did not wait for phase 1 to end');
  } finally {
    releaseOne();
    await h.runner.wait();
  }
});

/* ------------------------------------------------------------------ *
 * RS-4 — a hinted-not-queued phase is named, with its time
 * ------------------------------------------------------------------ */

test('RS-4: the shared reader lists a live run\'s hinted phases that no lane or queue entry holds, oldest first', () => {
  const { hintedPhases } = lifecycle as unknown as {
    hintedPhases: (run: unknown) => { phase: number; since: string; rung: string; by: string | null; serialBehind?: number }[];
  };
  assert.equal(typeof hintedPhases, 'function', 'one reader, in the shared vocabulary');
  const state = newRun({ slug: 'demo', root: '/nowhere' });
  state.status = 'running';
  Object.assign(phaseRecord(state, 2), { status: 'pending', boardingHint: hint('2026-09-26T08:20:00.000Z') });
  Object.assign(phaseRecord(state, 3), { status: 'pending', boardingHint: hint('2026-09-26T06:00:00.000Z', 'person-slot', 'reboard-fresh'), serialBehind: 4 });
  Object.assign(phaseRecord(state, 4), { status: 'running' });
  Object.assign(phaseRecord(state, 5), { status: 'queued', boardingHint: hint('2026-09-26T05:00:00.000Z') });
  Object.assign(phaseRecord(state, 6), { status: 'pending' });
  const rows = hintedPhases(state);
  assert.deepEqual(rows.map((row) => row.phase), [3, 2], 'a queued entry is on the queue already; the rest, oldest hint first');
  assert.equal(rows[0].since, '2026-09-26T06:00:00.000Z');
  assert.equal(rows[0].rung, 'reboard-fresh');
  assert.equal(rows[0].serialBehind, 4, 'and what it is behind, when it is serial');
  assert.deepEqual(hintedPhases({ ...state, status: 'parked' }), [], 'a stopped run drives nothing');
});

test('RS-4: GET /api/queue carries the hinted-not-queued phases beside the scheduler\'s entries', async () => {
  const state = newRun({ slug: 'demo', root: '/nowhere' });
  state.status = 'running';
  Object.assign(phaseRecord(state, 59), { status: 'pending', boardingHint: hint('2026-09-25T08:20:34.000Z', 'operator', 'reboard-fresh') });
  const { hintedPhases } = lifecycle as unknown as { hintedPhases: (run: unknown) => unknown[] };
  // The route answers the widened view since control-tower phase 99 (#135):
  // the stub composes it through the real `queueView`, over its own parts.
  const { queueView } = await import('../server/queue-view.ts');
  const snapshot = { max: 1, live: 1, queued: 0, entries: [], grants: [] };
  const service = {
    root: { path: '/nowhere' }, store: { list: () => [] },
    queueSnapshot: () => snapshot,
    queueAdvice: async () => [],
    queueHinted: () => hintedPhases(state).map((row) => ({ slug: 'demo', runId: state.id, ...(row as object) })),
    queueView: () => ({ ...snapshot, ...queueView({ snapshot: snapshot as never, hinted: service.queueHinted() as never, runs: [state], now: Date.now() }) }),
  };
  const { handleApi } = await import('../server/api/routes.ts');
  const out = { status: 0, body: null as any };
  const req = { method: 'GET', headers: { 'x-phase-console': '1' }, on() { return this; }, [Symbol.asyncIterator]: async function* () { /* none */ } };
  const res = {
    req, writeHead(status: number) { out.status = status; return this; },
    end(chunk: unknown) { out.body = JSON.parse(String(chunk)); }, on() { return this; },
  };
  await handleApi({ service } as never, req as never, res as never, new URL('http://127.0.0.1/api/queue'));
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual(out.body.hinted.map((row: { phase: number; since: string }) => [row.phase, row.since]), [[59, '2026-09-25T08:20:34.000Z']]);
  // …and each row carries the press that queues it from the view (control-tower phase 99, QV-3).
  assert.deepEqual(out.body.hinted[0].queue, { verb: 'bump', method: 'POST', endpoint: '/api/queue/bump', body: { slug: 'demo', phase: 59 } });
});

test('RS-1: the boarding order is journalled when seniority moved it — which phase went first and by which clock', async () => {
  const h = boardHarness({ states: { 1: 'in-progress', 2: 'ready' } });
  const run = stored(h.root, (state) => {
    Object.assign(phaseRecord(state, 1), { status: 'pending', attempts: 1, boardingHint: hint(ago(30 * MIN)) });
  });
  await h.runner.start({ slug: 'demo', root: h.root, resumeRunId: run.id, maxParallel: 1 } as never);
  await h.runner.wait();
  const rows = journalled(h, 'phase.seniority');
  assert.ok(rows.length >= 1, 'a seniority decision is on the record');
  assert.equal(rows[0].phase, 1);
  assert.equal(rows[0].clock, 'hint');
  assert.deepEqual(rows[0].ahead, [2], 'and the fresh phases it went ahead of');
});
