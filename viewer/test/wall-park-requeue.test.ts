/**
 * An expired usage-wall park re-enters the line with its seniority, and its
 * card tells the time it is now (control-tower phase 86, #132, #78's body).
 *
 * vca P19 was checkpointed by a 12:36Z usage wall with the window resetting at
 * 12:50Z. At the reset nothing boarded it; its sibling took the lane, twice,
 * and for two hours its card said "…the window resets in 14 min" over an
 * account reading 25 % — the sentence was written once, at the park.
 *
 *   WR-1  at a boundary, a phase whose wall park expired boards ahead of a
 *         sibling's newer re-attempt and of phases that never started;
 *   WR-2  the park's clock wakes the loop: at the reset the phase takes a free
 *         lane without waiting for another lane to end;
 *   WR-3  the wall's sentence is re-derived from the absolute reset and the
 *         phase's current holder at every reading — `/api/runs` included —
 *         never frozen at the park;
 *   WR-4  the card carries the last usage reading (at, by, resets) beside its
 *         "at the latest" time.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { boardHarness } from './lane-harness.ts';

process.env.PHASE_CONSOLE_LOG = '';

const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const situationModel = await import('../shared/situation-model.js');
type RunState = import('../server/runner/state.ts').RunState;

const SEC = 1_000;
const MIN = 60 * SEC;
const at = (ms: number): string => new Date(Date.now() + ms).toISOString();
const wall = (latest: string) => ({ account: 'default', bucket: 'five_hour', latest, probes: 0 });

function stored(root: string, over: (state: RunState) => void): RunState {
  const state = newRun({ slug: 'demo', root, autonomy: 'keep-going', autoRecover: false } as never);
  state.status = 'parked';
  phaseRecord(state, 1).status = 'done';
  over(state);
  saveRun(state);
  return state;
}

/* ------------------------------------------------------------------ *
 * WR-1 — the expired park keeps its seat
 * ------------------------------------------------------------------ */

test('WR-1: #132 — at the boundary an expired wall park boards ahead of a sibling\'s newer re-attempt and of a phase that never started', async () => {
  const h = boardHarness({ states: { 1: 'done', 2: 'in-progress', 3: 'in-progress', 4: 'ready' } });
  const run = stored(h.root, (state) => {
    // 2 — the sibling's own re-attempt, hinted ten seconds ago.
    Object.assign(phaseRecord(state, 2), {
      status: 'pending', attempts: 2,
      boardingHint: { situation: 'work-in-progress', rung: 'reboard-resume-brief', brief: 'resume', at: at(-10 * SEC), by: 'console' },
    });
    // 3 — checkpointed by the wall; the window reset thirty seconds ago.
    Object.assign(phaseRecord(state, 3), { status: 'waiting', attempts: 1, parkedUntil: at(-30 * SEC), usageWall: wall(at(-30 * SEC)) });
  });
  await h.runner.start({ slug: 'demo', root: h.root, resumeRunId: run.id, maxParallel: 1 } as never);
  await h.runner.wait();
  assert.deepEqual(h.spawned, [3, 2, 4], 'the checkpointed phase first, then the re-attempt, then the fresh phase');
});

/* ------------------------------------------------------------------ *
 * WR-2 — the reset boards it at once
 * ------------------------------------------------------------------ */

test('WR-2: at the reset the parked phase takes a free lane at once — it does not wait for another lane to end', async () => {
  let releaseFive!: () => void;
  const five = new Promise<void>((done) => { releaseFive = done; });
  let fiveBoardedAt = Number.NaN;
  const h = boardHarness({
    states: { 1: 'done', 3: 'in-progress', 5: 'ready' },
    repos: { 3: 'app', 5: 'docs' },
    onSpawn: async (phase) => { if (phase === 5) { fiveBoardedAt = Date.now(); await five; } },
  });
  const reset = at(1_500);
  const run = stored(h.root, (state) => {
    Object.assign(phaseRecord(state, 3), { status: 'waiting', attempts: 1, parkedUntil: reset, usageWall: wall(reset) });
  });
  await h.runner.start({ slug: 'demo', root: h.root, resumeRunId: run.id, maxParallel: 2 } as never);
  try {
    for (let i = 0; i < 250 && !h.spawned.includes(3); i++) await new Promise((done) => { setTimeout(done, 20); });
    if (fiveBoardedAt < Date.parse(reset)) {
      assert.deepEqual(h.spawned, [5, 3], 'phase 3 boarded at its reset while phase 5 was still running');
    } else {
      // A machine too loaded to board anything before the reset: the park had
      // expired at the first pass, so it boarded ahead by seniority (WR-1) —
      // the property above could not be exercised, and the order says why.
      assert.equal(h.spawned[0], 3, 'an expired park boards ahead of a phase that never started');
    }
  } finally {
    releaseFive();
    await h.runner.wait();
  }
});

/* ------------------------------------------------------------------ *
 * WR-3 — the sentence is read now, never frozen
 * ------------------------------------------------------------------ */

test('WR-3: the wall\'s sentence counts down to the absolute reset, and after it names what the phase waits for now', () => {
  const { wallReading } = situationModel as unknown as {
    wallReading: (record: unknown, now: number) => { latest: string; reset: boolean; sentence: string } | null;
  };
  assert.equal(typeof wallReading, 'function', 'one reader, in the shared situation model');
  const reset = Date.parse('2026-09-25T12:50:00.000Z');
  const record = { status: 'waiting', usageWall: wall('2026-09-25T12:50:00.000Z') };
  const before = wallReading(record, reset - 14 * MIN)!;
  assert.equal(before.reset, false);
  assert.match(before.sentence, /resets in 14 min \(12:50Z\) at the latest/);
  // Two hours later the same record says what is true two hours later.
  const later = wallReading({ ...record, status: 'queued', waitingOn: [{ slug: 'vca-refactor', phase: 20, owner: 'vca-refactor P20 (grant)' }] }, reset + 2 * 60 * MIN)!;
  assert.equal(later.reset, true);
  assert.doesNotMatch(later.sentence, /resets in/, 'never a countdown to a moment already past');
  assert.match(later.sentence, /reset at 12:50Z — waiting for vca-refactor P20 \(grant\)/, 'it names the real holder');
  const serial = wallReading({ ...record, status: 'pending', serialBehind: 20 }, reset + MIN)!;
  assert.match(serial.sentence, /waiting for phase 20 of this run \(same scope\)/);
  assert.equal(wallReading({ status: 'waiting' }, reset), null, 'no wall, no reading');
});

test('WR-3: one rule puts the wall read now in a situation\'s first line — `/api/runs` and the phase diagnosis both apply it', () => {
  type Situation = { key: string; why: string[] };
  const { withWallWhy, wallReading } = situationModel as unknown as {
    withWallWhy: (situation: Situation | null, wall: unknown) => Situation | null;
    wallReading: (record: unknown, now: number) => { sentence: string } | null;
  };
  assert.equal(typeof withWallWhy, 'function', 'one rule, in the shared situation model');
  const reset = Date.parse('2026-09-25T12:50:00.000Z');
  const record = { status: 'queued', usageWall: wall('2026-09-25T12:50:00.000Z'), waitingOn: [{ slug: 'demo', phase: 20, owner: 'demo P20 (grant)' }] };
  // What the classifier says: it quotes the note written at the park.
  const classified = { key: 'resource-wall:usage', why: ['a usage limit: checkpointed (rate limited mid-session) — resets in 14 min', 'the run is waiting'] };
  const read = withWallWhy(classified, wallReading(record, reset + 5 * MIN))!;
  assert.match(read.why[0]!, /the usage window reset at 12:50Z — waiting for demo P20 \(grant\)/);
  assert.equal(read.why[1], 'the run is waiting', 'only the first line is the wall\'s');
  assert.match(classified.why[0]!, /resets in 14 min/, 'a copy — the classification handed in is untouched');
  assert.equal(withWallWhy(classified, null), classified, 'no wall on the record, nothing to re-read');
  const other = { key: 'work-in-progress', why: ['an in-progress handoff'] };
  assert.equal(withWallWhy(other, wallReading(record, reset)), other, 'only a usage wall\'s situation takes the reading');
  assert.equal(withWallWhy(null, wallReading(record, reset)), null);
});

test('WR-3: GET /api/runs re-derives a wall situation\'s first line at every read — the stored text is never what a reader sees', async () => {
  const state = newRun({ slug: 'demo', root: '/nowhere' });
  state.status = 'running';
  const past = new Date(Date.now() - 2 * 60 * MIN).toISOString();
  Object.assign(phaseRecord(state, 19), {
    status: 'queued', usageWall: wall(past), waitingOn: [{ slug: 'demo', phase: 20, owner: 'demo P20 (grant)' }],
    situation: { key: 'resource-wall:usage', at: past, why: ['a live wall with no account to move to, and the window resets in 14 min', 'rate limited'] },
  });
  const service = { root: null, store: { list: () => [] }, allRuns: async () => [state] };
  const { handleApi } = await import('../server/api/routes.ts');
  const out = { status: 0, body: null as any };
  const req = { method: 'GET', headers: { 'x-phase-console': '1' }, on() { return this; }, [Symbol.asyncIterator]: async function* () { /* none */ } };
  const res = { req, writeHead(status: number) { out.status = status; return this; }, end(chunk: unknown) { out.body = JSON.parse(String(chunk)); }, on() { return this; } };
  await handleApi({ service } as never, req as never, res as never, new URL('http://127.0.0.1/api/runs'));
  assert.equal(out.status, 200, JSON.stringify(out.body).slice(0, 300));
  const why = out.body[0].phases['19'].situation.why as string[];
  assert.match(why[0], /reset at .*Z — waiting for demo P20 \(grant\)/, 'the live sentence');
  assert.equal(why[1], 'rate limited', 'the rest of the evidence stands');
  assert.equal(state.phases['19'].situation!.why![0], 'a live wall with no account to move to, and the window resets in 14 min',
    'a copy for the payload — the runner\'s own record is never rewritten by a read');
});

/* ------------------------------------------------------------------ *
 * WR-4 — the last reading is on the card
 * ------------------------------------------------------------------ */

test('WR-4: #78 — the reading carries the last usage reading beside its "at the latest" time', () => {
  const { wallReading } = situationModel as unknown as {
    wallReading: (record: unknown, now: number) => { latest: string; lastReading: Record<string, unknown> | null } | null;
  };
  const reading = wallReading({
    status: 'waiting',
    usageWall: { ...wall('2026-09-25T12:50:00.000Z'), lastReading: { at: '2026-09-25T12:41:00.000Z', by: 'reprobe', ok: false, resetsAt: '2026-09-25T12:50:00.000Z' } },
  }, Date.parse('2026-09-25T12:45:00.000Z'))!;
  assert.equal(reading.latest, '2026-09-25T12:50:00.000Z', 'the at-the-latest time');
  assert.deepEqual(reading.lastReading, { at: '2026-09-25T12:41:00.000Z', by: 'reprobe', ok: false, resetsAt: '2026-09-25T12:50:00.000Z' },
    'and the reading that judged it: when, by what, and the reset it reported');
});
