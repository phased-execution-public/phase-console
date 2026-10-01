/**
 * A phase can wait on a sibling's completion — `phase:<slug>/<N>` (control-tower phase 88, #129).
 *
 * Measured on hub 4123 on 2026-09-25 (run 24fcba33): P50 and P41 were blocked until sibling P43 was
 * done, and no scheme meant that. `lock:…/43` landed while P43 merely sat in the queue, so the
 * ingest probe refused the park; the sessions fell back to `cmd:grep -q '^status: complete'
 * …/phase-43-….md` — a poll of a file the console owns the truth about — on a back-off that would
 * have noticed P43's completion 3 h 20 min late, because `tick()` fired on its timer alone.
 *
 * PW-1  `phase:<slug>/<N>` lands when the console's RECORD of phase N reads done — after its own
 *       §Verification, which re-opens a red one (phase 62) — and is read from state, never a shell;
 *       a phase naming itself is refused; the declaration probe answers it at once
 * PW-2  it un-lands when the phase is re-opened: a landed `phase:` row is re-read, not re-delivered
 * PW-3  a phase reaching done re-probes every ref that names it within one tick — the scheduler
 *       fires on the board's transition, not only on its timer
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PhaseRecord, RunState } from '../server/runner/state.ts';
import { WatchScheduler } from '../server/watch-scheduler.ts';
import { parseWatchRef, probeWatchRef, watchRefProblem, WATCH_SCHEMES } from '../server/watch-refs.ts';

const REF = 'phase:demo/43';

type Timer = { fn: () => void; ms: number; live: boolean };

function fakeClock(start = Date.parse('2026-09-27T10:00:00Z')) {
  let t = start;
  const timers: Timer[] = [];
  return {
    timers,
    advance: (ms: number) => { t += ms; },
    clock: {
      now: () => t,
      setTimeout: (fn: () => void, ms: number) => { const timer = { fn, ms, live: true }; timers.push(timer); return timer; },
      clearTimeout: (handle: unknown) => { if (handle) (handle as Timer).live = false; },
    },
  };
}

function runWith(records: Partial<PhaseRecord>[]): RunState {
  const phases: Record<string, PhaseRecord> = {};
  for (const r of records) phases[String(r.phase)] = { status: 'pending', ...r } as PhaseRecord;
  return { id: 'r1', slug: 'demo', status: 'running', phases } as unknown as RunState;
}

const parkedOn = (refs: string[], extra: Partial<PhaseRecord> = {}): Partial<PhaseRecord> => ({
  phase: 50, status: 'waiting',
  declared: { status: 'blocked', needs: 'external', watch: refs, at: '2026-09-27T09:59:00Z', parked: 'poll-park' },
  ...extra,
});

test('PW-1: phase:<slug>/<N> is a scheme — parsed, polled from state, landed only on a DONE record', async () => {
  assert.ok((WATCH_SCHEMES as readonly string[]).includes('phase'));
  assert.deepEqual(parseWatchRef(REF), { kind: 'phase', slug: 'demo', phase: 43, ref: REF });
  assert.equal(parseWatchRef('phase:demo/x'), null);
  assert.match(watchRefProblem('phase:demo') ?? '', /phase:<slug>\/<phase>/);

  const target = parseWatchRef(REF)!;
  const states = new Map<number, string>([[43, 'running']]);
  const phaseDone = (slug: string, phase: number) => {
    const status = states.get(phase);
    if (slug !== 'demo' || !status) return null;
    return status === 'done' ? { state: 'landed' as const, detail: `phase ${phase} is done` } : { state: 'pending' as const, detail: `phase ${phase} reads ${status}` };
  };
  assert.equal((await probeWatchRef(target, { phaseDone })).state, 'pending');
  states.set(43, 'verifying');
  assert.equal((await probeWatchRef(target, { phaseDone })).state, 'pending', 'verifying is not done: the console has not judged it yet');
  states.set(43, 'done');
  const landed = await probeWatchRef(target, { phaseDone });
  assert.equal(landed.state, 'landed');
  assert.match(landed.detail ?? '', /done/);
  assert.equal((await probeWatchRef(target, {})).state, 'unknown', 'no state oracle wired — unknown, never landed');
});

test('PW-1: the scheduler lands a parked phase on its sibling\'s DONE record, refuses a phase naming itself, and the ingest probe answers at once', async () => {
  const { clock, advance } = fakeClock();
  let sibling = 'running';
  const landed: { phase: number; ref: string }[] = [];
  const run = runWith([parkedOn([REF, 'phase:demo/50'])]);
  const scheduler = new WatchScheduler({
    runs: () => [{ slug: 'demo', state: run }],
    phaseDone: (_slug, phase) => (phase === 43 ? (sibling === 'done' ? { state: 'landed', detail: 'phase 43 is done' } : { state: 'pending', detail: `phase 43 reads ${sibling}` }) : null),
    onLanded: (_slug, _state, phase, verdict) => { landed.push({ phase, ref: verdict.ref }); return 'deferred'; },
    clock,
  });
  scheduler.open();
  await scheduler.tick();
  const rows = () => run.phases['50'].watchState!.refs;
  assert.equal(rows().find((r) => r.ref === REF)?.state, 'pending');
  const own = rows().find((r) => r.ref === 'phase:demo/50');
  assert.equal(own?.state, 'refused', 'a phase cannot wait for its own completion');
  assert.equal(landed.length, 0);

  sibling = 'done';
  advance(61_000);
  await scheduler.tick();
  assert.equal(rows().find((r) => r.ref === REF)?.state, 'landed');
  assert.deepEqual(landed, [{ phase: 50, ref: REF }]);

  const probed = await scheduler.probeDeclared('demo', 51, [REF], { budgetMs: 1_000 });
  assert.equal(probed.landed?.ref, REF, 'a sibling already done answers "already landed — continue" at declaration');
  scheduler.close();
});

test('PW-2: a landed phase: ref UN-LANDS when its phase is re-opened — re-read, never re-delivered from memory', async () => {
  const { clock } = fakeClock();
  let sibling = 'done';
  const journal: { kind: string; data: Record<string, unknown> }[] = [];
  const run = runWith([parkedOn([REF])]);
  const scheduler = new WatchScheduler({
    runs: () => [{ slug: 'demo', state: run }],
    phaseDone: () => (sibling === 'done' ? { state: 'landed', detail: 'phase 43 is done' } : { state: 'pending', detail: 'phase 43 reads failed — re-opened by its §Verification' }),
    onLanded: () => 'done',
    journal: (_slug, _state, kind, data) => { journal.push({ kind, data }); },
    clock,
  });
  scheduler.open();
  await scheduler.tick();
  const record = run.phases['50'];
  assert.equal(record.watchState!.refs[0].state, 'landed');
  assert.deepEqual(record.watchLandedDone, [REF], 'the healer answered done');

  sibling = 'failed';
  scheduler.boardMoved('demo', 43);
  await scheduler.tick();
  assert.equal(record.watchState!.refs[0].state, 'pending', 'the re-open un-lands it');
  assert.match(record.watchState!.refs[0].detail ?? '', /re-opened/);
  assert.ok(!record.watchLandedDone?.includes(REF), 'no longer a terminal landing');
  assert.ok(journal.some((l) => l.kind === 'phase.watch-checked' && l.data.state === 'pending' && l.data.ref === REF), 'the transition is journalled');
  scheduler.close();
});

test('PW-3: a phase reaching done re-probes every ref naming it within one tick — not on the next timer', async () => {
  const fake = fakeClock();
  let sibling = 'running';
  const asked: string[] = [];
  const handoff = 'cmd:"grep -q \'^status: complete\' /work/docs/handoffs/demo/phase-43-perf-ii.md"';
  const run = runWith([parkedOn([REF, handoff])]);
  const scheduler = new WatchScheduler({
    runs: () => [{ slug: 'demo', state: run }],
    phaseDone: () => (sibling === 'done' ? { state: 'landed', detail: 'phase 43 is done' } : { state: 'pending', detail: 'phase 43 reads running' }),
    probe: async (target) => { asked.push(target.ref); return { ref: target.ref, state: 'pending' }; },
    onLanded: () => 'deferred',
    clock: fake.clock,
  });
  scheduler.open();
  await scheduler.tick();
  const rows = run.phases['50'].watchState!.refs;
  assert.ok(rows.every((r) => typeof r.nextDueAt === 'number' && r.nextDueAt > fake.clock.now()), 'both rows wait on their cadence');
  const armedBefore = fake.timers.filter((t) => t.live).map((t) => t.ms);
  assert.ok(armedBefore.every((ms) => ms >= 60_000), 'the timer sleeps at least a minute');

  sibling = 'done';
  const rearmed = scheduler.boardMoved('demo', 43);
  assert.equal(rearmed, 2, 'the phase: ref and the cmd: ref over its handoff are both due now');
  const live = fake.timers.filter((t) => t.live);
  assert.equal(live.length, 1);
  assert.ok(live[0].ms <= 1_000, `a board transition fires the scheduler at once (armed ${live[0].ms} ms)`);
  asked.length = 0;
  live[0].fn();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(rows.find((r) => r.ref === REF)?.state, 'landed');
  assert.ok(asked.includes(handoff), 'the cmd: ref naming its handoff is asked again too');
  assert.equal(scheduler.boardMoved('demo', 7), 0, 'a phase nothing names re-arms nothing');
  scheduler.close();
});
