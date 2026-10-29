/**
 * The node suite's fake clocks (measured-console phase 15) — seven files each
 * defined a `fakeClock` of their own, in two shapes (the 2026-10-17 audit,
 * evidence/local-testing.md §8.2). Where what a test waits on is a timer the
 * code under test schedules on the real clock, `node:test`'s `mock.timers` is
 * the tool; these are for code that takes a clock as a dependency.
 */

/** A clock a dependency reads as `now(): Date`, wound by hand. */
export function dateClock(from: string | number) {
  const state = { at: typeof from === 'number' ? from : Date.parse(from) };
  return {
    now: () => new Date(state.at),
    wind: (ms: number) => {
      state.at += ms;
    },
    set: (iso: string) => {
      state.at = Date.parse(iso);
    },
  };
}

export type FakeTimer = { fn: () => void; ms: number; live: boolean };

/** A clock with timers a test fires by hand: `clock` is the dependency, `timers` what it scheduled. */
export function timerClock(start: number) {
  let t = start;
  const timers: FakeTimer[] = [];
  return {
    timers,
    advance: (ms: number) => {
      t += ms;
    },
    clock: {
      now: () => t,
      setTimeout: (fn: () => void, ms: number) => {
        const timer = { fn, ms, live: true };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (handle: unknown) => {
        if (handle) (handle as FakeTimer).live = false;
      },
    },
  };
}
