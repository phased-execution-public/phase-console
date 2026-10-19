/**
 * The watch clock wakes the phase its ref names (one-pool phase 23).
 *
 * Four measured failures, replayed on a fake clock:
 *
 *   #337  a parked phase's `cmd:` ref was never asked — no `phase.watch-checked`
 *         in either window — and the phase woke on its own clock 70 minutes,
 *         then two hours, after the file it watched appeared;
 *   #303  a release phase parked on a `gh:` run was not asked for 8 minutes
 *         after the run went green (its period is two);
 *   #245  a `cmd:` ref whose window passed while the run stood was asked on the
 *         hour step of its post-window back-off, ~35 minutes after it landed;
 *         and a pass that never ended took the clock with it.
 *
 * The cause of the first two: the timer slept until the soonest `nextDueAt`
 * of any row it held. A declaration has no row until it is first asked, so one
 * that arrived while the timer slept on another run's six-hour `cmd:` step had
 * no say until that step came due. Now the timer never sleeps longer than
 * `WATCH_CEILING_MS`, a declaration pokes it, a pass that throws re-arms it,
 * and a person's Resume resets the back-off.
 *
 *   WS-1  a declaration made while another run's row sleeps six hours is asked
 *         within the ceiling (red before: six hours).
 *   WS-2  a poke asks a fresh declaration at once.
 *   WS-3  a `cmd:` ref that lands at T+70 min in a three-hour window resumes
 *         within one step, and the same holds across a console restart: the
 *         pending set is the run record's own `watchState`, read back from disk.
 *   WS-4  a `gh:` run that completes is landed within one gh period (#303).
 *   WS-5  one run's malformed record does not starve another's refs, and a pass
 *         that throws still re-arms the clock.
 *   WS-6  a person's Resume makes every row due now and the post-window
 *         back-off counts from the press (#245).
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WatchScheduler } from '../server/watch-scheduler.ts';
import {
  WATCH_CEILING_MS, WATCH_CMD_BACKOFF_MS, WATCH_POLL_MS, cmdStepMs, declaredWindowOf, parseWatchRef,
  type WatchState,
} from '../server/watch-refs.ts';
import type { RunState } from '../server/runner/state.ts';

const NOW = Date.parse('2026-10-12T00:24:43Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

class FakeClock {
  time = NOW;
  now = (): number => this.time;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private seq = 0;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.push({ at: this.time + ms, fn, id });
    return id;
  };
  clearTimeout = (handle: unknown): void => { this.timers = this.timers.filter((t) => t.id !== handle); };
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = due.at;
      due.fn();
      for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    }
    this.time = target;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A run whose phase 1 waits on `refs`, declared at `at` with a window to `until`. */
function waitingRun(id: string, slug: string, refs: string[], at = NOW, until = NOW + 4 * HOUR): RunState {
  return {
    id, slug, status: 'running', model: 'claude-opus-5-5',
    startedAt: new Date(at).toISOString(),
    phases: {
      1: {
        phase: 1, status: 'waiting', attempts: 1,
        parkedUntil: new Date(until).toISOString(),
        declared: {
          status: 'waiting-external', reason: 'a detached suite', watch: refs,
          at: new Date(at).toISOString(), requested: new Date(until).toISOString(),
          budget: { ms: 10 * HOUR, source: 'plan' },
        },
      },
    },
  } as unknown as RunState;
}

/** Another run's phase whose `cmd:` row sleeps on its six-hour step — the hub's background. */
function sleepingRun(): RunState {
  const state = waitingRun('run-b', 'beta', ['cmd:"test -f /tmp/beta.done"'], NOW - 30 * HOUR, NOW - 20 * HOUR);
  (state.phases['1'] as unknown as { declared: { budgetSpent: unknown } }).declared.budgetSpent = { at: state.startedAt, ledger: 'budget' };
  state.phases['1'].watchState = {
    at: new Date(NOW).toISOString(),
    refs: [{
      ref: 'cmd:"test -f /tmp/beta.done"', scheme: 'cmd', state: 'pending', detail: 'exit 1',
      checkedAt: new Date(NOW).toISOString(), runs: 9, nextDueAt: NOW + 6 * HOUR,
    }],
  } as never;
  return state;
}

test('WS-1: a declaration made while another run\'s row sleeps six hours is asked within the ceiling (#337)', async () => {
  const clock = new FakeClock();
  const beta = sleepingRun();
  const alpha = { id: 'run-a', slug: 'alpha', status: 'running', phases: {} } as unknown as RunState;
  const asked: { ref: string; at: number }[] = [];
  const scheduler = new WatchScheduler({
    clock,
    runs: () => [{ slug: 'beta', state: beta }, { slug: 'alpha', state: alpha }],
    probe: async (t) => { asked.push({ ref: t.ref, at: clock.now() }); return { ref: t.ref, state: 'pending', detail: 'exit 1' }; },
  });
  scheduler.open();
  // Ten seconds later phase 1 of alpha parks on its sentinel — no row yet.
  await clock.advance(10_000);
  Object.assign(alpha, waitingRun('run-a', 'alpha', ['cmd:"test -f /tmp/p10-verify/s3/ALL.done"'], clock.now()));
  await clock.advance(WATCH_CEILING_MS);
  const first = asked.find((a) => a.ref.includes('ALL.done'));
  assert.ok(first, 'the new declaration was asked — before the fix it waited out beta\'s six-hour step');
  assert.ok(first!.at - (NOW + 10_000) <= WATCH_CEILING_MS, `asked ${(first!.at - NOW - 10_000) / 1000} s after it was declared`);
  assert.equal(asked.filter((a) => a.ref.includes('beta')).length, 0, 'beta\'s row keeps its own six-hour clock');
  assert.ok(WATCH_CEILING_MS <= MIN, 'the ceiling is a minute');
  scheduler.close();
});

test('WS-2: a poke asks a fresh declaration at once, and a poke during a pass is folded into one more pass', async () => {
  const clock = new FakeClock();
  const beta = sleepingRun();
  const alpha = { id: 'run-a', slug: 'alpha', status: 'running', phases: {} } as unknown as RunState;
  let release: (() => void) | null = null;
  const asked: string[] = [];
  const scheduler = new WatchScheduler({
    clock,
    runs: () => [{ slug: 'beta', state: beta }, { slug: 'alpha', state: alpha }],
    probe: async (t) => {
      asked.push(t.ref);
      if (t.ref.includes('slow')) await new Promise<void>((resolve) => { release = resolve; });
      return { ref: t.ref, state: 'pending' };
    },
  });
  scheduler.open();
  Object.assign(alpha, waitingRun('run-a', 'alpha', ['cmd:"test -f /tmp/slow"']));
  scheduler.poke();
  await clock.advance(0);
  assert.deepEqual(asked, ['cmd:"test -f /tmp/slow"'], 'asked on the pass the poke fired, not a minute later');
  // A second declaration arrives while that pass is still waiting on its probe.
  alpha.phases['2'] = { ...waitingRun('x', 'alpha', ['cmd:"test -f /tmp/second"']).phases['1'], phase: 2 } as never;
  scheduler.poke();
  assert.equal(scheduler.snapshot().armed, true);
  release!();
  await new Promise((resolve) => setImmediate(resolve));
  await clock.advance(0);
  assert.ok(asked.includes('cmd:"test -f /tmp/second"'), 'the folded pass ran when the first one ended');
  assert.equal(asked.filter((r) => r.includes('slow')).length, 1, 'never two passes at once: the slow ref was asked once');
  scheduler.close();
});

/** A disk of JSON: every pass reads a fresh copy, as production re-loads each run. */
function disk(initial: RunState[]) {
  const files = new Map(initial.map((s) => [s.slug, JSON.stringify(s)]));
  return {
    runs: () => [...files.entries()].map(([slug, text]) => ({ slug, state: JSON.parse(text) as RunState })),
    save: (slug: string, state: RunState) => { files.set(slug, JSON.stringify(state)); },
    read: (slug: string) => JSON.parse(files.get(slug)!) as RunState,
  };
}

test('WS-3: a cmd: ref that lands at T+70 min resumes within one step — and across a console restart (#337)', async () => {
  const ref = 'cmd:"test -f /tmp/p10-verify/s3/ALL.done"';
  const landsAt = NOW + 70 * MIN;
  const window = { from: NOW, until: NOW + 3 * HOUR };
  const probe = (clock: FakeClock) => async (t: { ref: string }): Promise<WatchState> =>
    clock.now() >= landsAt ? { ref: t.ref, state: 'landed', detail: 'exit 0' } : { ref: t.ref, state: 'pending', detail: 'exit 1' };

  // One console, straight through.
  {
    const clock = new FakeClock();
    const store = disk([waitingRun('run-a', 'alpha', [ref], NOW, window.until), sleepingRun()]);
    const landed: number[] = [];
    const scheduler = new WatchScheduler({
      clock, runs: store.runs, save: store.save, probe: probe(clock),
      onLanded: () => { landed.push(clock.now()); return 'done'; },
    });
    scheduler.open();
    await clock.advance(4 * HOUR);
    assert.equal(landed.length, 1, 'the landing was handed to the healer once');
    const step = cmdStepMs('test -f x', 9, landsAt, window);
    assert.ok(landed[0]! - landsAt <= step, `seen ${(landed[0]! - landsAt) / MIN} min after landing; one step is ${step / MIN} min`);
    assert.ok(landed[0]! < window.until, 'inside the window, not on its clock');
    scheduler.close();
  }

  // A restart at T+40 min: the first console dies holding a pending row; the
  // second reads the row back from the run file and goes on from it.
  {
    const clock = new FakeClock();
    const store = disk([waitingRun('run-a', 'alpha', [ref], NOW, window.until), sleepingRun()]);
    const first = new WatchScheduler({ clock, runs: store.runs, save: store.save, probe: probe(clock), onLanded: () => 'done' });
    first.open();
    await clock.advance(40 * MIN);
    first.close();
    const persisted = store.read('alpha').phases['1'].watchState?.refs.find((r) => r.ref === ref);
    assert.equal(persisted?.state, 'pending', 'the pending set is on disk: the run record\'s own watchState');
    assert.ok((persisted?.runs ?? 0) >= 2 && persisted?.nextDueAt !== undefined, 'with its runs and its next due time');

    const landed: number[] = [];
    const second = new WatchScheduler({
      clock, runs: store.runs, save: store.save, probe: probe(clock),
      onLanded: () => { landed.push(clock.now()); return 'done'; },
    });
    second.open();
    await clock.advance(3 * HOUR);
    assert.equal(landed.length, 1, 'the restarted console landed it');
    const step = cmdStepMs('test -f x', persisted!.runs ?? 0, landsAt, window);
    assert.ok(landed[0]! - landsAt <= step, `seen ${(landed[0]! - landsAt) / MIN} min after landing across the restart`);
    second.close();
  }
});

test('WS-4: a gh: run that completes is landed within one gh period while another run sleeps (#303)', async () => {
  const clock = new FakeClock();
  const ref = 'gh:acme/app#run/38003551487';
  const completes = NOW + 15 * MIN + 30_000;
  const store = disk([sleepingRun()]);
  const landed: number[] = [];
  const scheduler = new WatchScheduler({
    clock, runs: store.runs, save: store.save,
    probe: async (t) => (clock.now() >= completes ? { ref: t.ref, state: 'landed', detail: 'completed success' } : { ref: t.ref, state: 'pending' }),
    onLanded: () => { landed.push(clock.now()); return 'done'; },
  });
  scheduler.open();
  // The phase boarded after a gate park and declared its wait 13 minutes in.
  await clock.advance(13 * MIN);
  store.save('alpha', waitingRun('run-a', 'alpha', [ref], clock.now(), clock.now() + 2 * HOUR));
  await clock.advance(30 * MIN);
  assert.equal(landed.length, 1);
  assert.ok(landed[0]! - completes <= WATCH_POLL_MS['gh-run'] + WATCH_CEILING_MS,
    `landed ${(landed[0]! - completes) / 1000} s after the run completed`);
  scheduler.close();
});

test('WS-5: a malformed record starves no other run, and a pass that throws re-arms the clock', async () => {
  const clock = new FakeClock();
  const bad = waitingRun('run-x', 'broken', ['cmd:"test -f /tmp/x"']);
  // A record an older build wrote: not an array where the rotation iterates one.
  (bad.phases['1'] as unknown as { waitingOn: unknown }).waitingOn = { slug: 'other', phase: 2 };
  const good = waitingRun('run-a', 'alpha', ['gh:acme/app#run/1']);
  let asks = 0;
  let throwRuns = false;
  const scheduler = new WatchScheduler({
    clock,
    runs: () => { if (throwRuns) throw new Error('store went away'); return [{ slug: 'broken', state: bad }, { slug: 'alpha', state: good }]; },
    probe: async (t) => { if (t.ref.includes('acme')) asks += 1; return { ref: t.ref, state: 'pending' }; },
  });
  scheduler.open();
  await clock.advance(10 * MIN);
  assert.ok(asks >= 4, `alpha's gh ref was asked ${asks} times past the broken run`);
  // The run listing itself throws for a while, then recovers: the clock goes on.
  throwRuns = true;
  await clock.advance(5 * MIN);
  throwRuns = false;
  const before = asks;
  await clock.advance(5 * MIN);
  assert.ok(asks > before, 'still asking after a stretch of failed passes');
  assert.equal(scheduler.snapshot().armed, true);
  scheduler.close();
});

test('WS-6: a person\'s Resume makes every row due now and counts the back-off from the press (#245)', async () => {
  const clock = new FakeClock();
  const ref = 'cmd:"test -f /tmp/p124-gate1.done"';
  // Declared three hours ago with a two-hour window that ended an hour ago;
  // the post-window back-off had reached its hour step.
  const state = waitingRun('run-a', 'alpha', [ref], NOW - 3 * HOUR, NOW - HOUR);
  state.phases['1'].status = 'pending';
  delete state.phases['1'].parkedUntil;
  state.phases['1'].watchState = {
    at: new Date(NOW - 30 * MIN).toISOString(),
    refs: [{ ref, scheme: 'cmd', state: 'pending', detail: 'exit 1', checkedAt: new Date(NOW - 30 * MIN).toISOString(), runs: 14, nextDueAt: NOW + 30 * MIN }],
  } as never;
  const window = declaredWindowOf(state.phases['1']);
  assert.ok(window && window.until < NOW, 'the window is over');
  assert.equal(cmdStepMs('test -f x', 14, NOW, window), WATCH_CMD_BACKOFF_MS[2], 'without a reset: the hour step');

  const asked: number[] = [];
  const scheduler = new WatchScheduler({
    clock, runs: () => [{ slug: 'alpha', state }],
    probe: async (t) => { asked.push(clock.now()); return { ref: t.ref, state: 'pending', detail: 'exit 1' }; },
  });
  scheduler.open();
  assert.equal(scheduler.reset(state, [1], NOW), 1, 'one row made due');
  assert.equal(state.phases['1'].watchResetAt, new Date(NOW).toISOString());
  scheduler.poke();
  await clock.advance(0);
  assert.deepEqual(asked, [NOW], 'asked at the press, not half an hour later');
  const row = state.phases['1'].watchState!.refs[0]!;
  assert.equal(row.nextDueAt, NOW + WATCH_CMD_BACKOFF_MS[0], 'and next on the FIRST step, counted from the press');
  assert.equal(cmdStepMs('test -f x', 15, NOW + 5 * MIN, window, NOW), WATCH_CMD_BACKOFF_MS[1], 'then fifteen');
  // A landed or refused row is never touched by a reset.
  state.phases['1'].watchState!.refs[0] = { ...row, state: 'refused', nextDueAt: undefined } as never;
  assert.equal(scheduler.reset(state, [1], NOW), 0);
  assert.ok(parseWatchRef(ref));
  scheduler.close();
});
