/**
 * A `date:` BACKSTOP beside a live ref (control-tower phase 121, #181's
 * cheaper variant): `waiting-external` takes both — the live ref wakes the
 * phase the moment it lands, and the date only bounds the wait.
 *
 *   WB-1  the park's clock is the backstop, not the thirty-minute default, and
 *         the journal names the backstop beside the live ref;
 *   WB-2  the live ref landing first resumes the phase early — the date is
 *         never asked for again;
 *   WB-3  the backstop passing first resumes it too, saying what it is: the
 *         date passed and the live ref has NOT landed, with what the ref last
 *         read — never "the thing you waited for happened".
 * The bash half (the door names the backstop) is `tests/unit/outcome.bats`.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PhaseRecord, RunState } from '../server/runner/state.ts';
import { WatchScheduler } from '../server/watch-scheduler.ts';
import { backstopOf, type WatchState } from '../server/watch-refs.ts';
import { DEFAULT_WAIT_BUDGET, evaluateWait } from '../server/runner/wait-budget.ts';

type Timer = { fn: () => void; ms: number; live: boolean };

function fakeClock(start = Date.parse('2026-10-05T10:00:00Z')) {
  let t = start;
  const timers: Timer[] = [];
  return {
    advance: (ms: number) => { t += ms; },
    clock: {
      now: () => t,
      setTimeout: (fn: () => void, ms: number) => { const timer = { fn, ms, live: true }; timers.push(timer); return timer; },
      clearTimeout: (handle: unknown) => { if (handle) (handle as Timer).live = false; },
    },
  };
}

const LIVE = 'unit:build-box/nightly-build.service';
const BACKSTOP = 'date:2026-10-05T16:00:00Z';

function parked(refs: string[]): RunState {
  const record = {
    phase: 7, status: 'waiting', parkedUntil: '2026-10-05T16:00:00.000Z',
    declared: { status: 'waiting-external', watch: refs, at: '2026-10-05T10:00:00Z', by: 'session', requested: '2026-10-05T16:00:00.000Z' },
  } as unknown as PhaseRecord;
  return { id: 'r1', slug: 'demo', status: 'waiting', phases: { 7: record } } as unknown as RunState;
}

test('WB-1 — the backstop is the clock: a declaration naming a live ref and a date parks until the date, inside its budget', () => {
  const now = Date.parse('2026-10-05T10:00:00Z');
  const verdict = evaluateWait({
    now, parkedMs: 0, waits: 0, budget: DEFAULT_WAIT_BUDGET, ledger: 'session',
    dates: [[BACKSTOP, Date.parse('2026-10-05T16:00:00Z')]], pollable: true,
  });
  assert.equal(verdict.verdict, 'park');
  if (verdict.verdict !== 'park') return;
  assert.equal(new Date(verdict.until).toISOString(), '2026-10-05T16:00:00.000Z', 'not the thirty-minute default');
  assert.equal(verdict.extendedBy, BACKSTOP);
  // The pair, named: what bounds it and what wakes it.
  assert.deepEqual(backstopOf([LIVE, BACKSTOP]), { backstop: BACKSTOP, live: [LIVE] });
  assert.equal(backstopOf([BACKSTOP]), null, 'a date alone is a clock, not a backstop');
  assert.equal(backstopOf([LIVE]), null);
  // The latest date bounds it when there are two.
  assert.equal(backstopOf([LIVE, 'date:2026-10-05T12:00:00Z', BACKSTOP])?.backstop, BACKSTOP);
});

test('WB-2 — the live ref lands first: the phase is offered early, and the date is never asked again', async () => {
  const { clock, advance } = fakeClock();
  const run = parked([LIVE, BACKSTOP]);
  const landed: WatchState[] = [];
  let unit: WatchState['state'] = 'pending';
  const scheduler = new WatchScheduler({
    runs: () => [{ slug: 'demo', state: run }],
    unitProbe: async (target) => ({ ref: target.ref, state: unit, detail: unit === 'landed' ? 'Result=success · exited 2026-10-05T11:02:00.000Z' : 'activating (start)', ...(unit === 'landed' ? { unit: { result: 'success', exitedAt: '2026-10-05T11:02:00.000Z' } } : {}) }),
    onLanded: (_slug, _state, _phase, verdict) => { landed.push(verdict); return 'resumed'; },
    clock,
  });
  scheduler.open();
  await scheduler.tick();
  assert.equal(landed.length, 0);
  unit = 'landed';
  advance(5 * 60_000 + 1_000);
  await scheduler.tick();
  assert.equal(landed.length, 1, 'woken by the live ref, hours before the backstop');
  assert.equal(landed[0]!.ref, LIVE);
  const rows = run.phases['7']!.watchState!.refs;
  assert.equal(rows.find((r) => r.ref === BACKSTOP)?.state, 'pending', 'the backstop never landed');
  scheduler.close();
});

test('WB-3 — the backstop passes first: the phase resumes, told the date passed and the live ref has NOT landed', async () => {
  const { clock, advance } = fakeClock();
  const run = parked([LIVE, BACKSTOP]);
  const landed: WatchState[] = [];
  const scheduler = new WatchScheduler({
    runs: () => [{ slug: 'demo', state: run }],
    unitProbe: async (target) => ({ ref: target.ref, state: 'pending', detail: 'activating (start)' }),
    onLanded: (_slug, _state, _phase, verdict) => { landed.push(verdict); return 'resumed'; },
    clock,
  });
  scheduler.open();
  await scheduler.tick();
  advance(6 * 3_600_000 + 1_000);
  await scheduler.tick();
  assert.equal(landed.length, 1);
  assert.equal(landed[0]!.ref, BACKSTOP);
  assert.match(landed[0]!.detail ?? '', /^the backstop passed \(2026-10-05T16:00:00\.000Z\) — unit:build-box\/nightly-build\.service has NOT landed \(activating \(start\)\)/);
  scheduler.close();
});
