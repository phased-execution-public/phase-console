/**
 * One page clock (turn-by-turn phase 8).
 *
 * Every clock a page shows — how long ago an item was assigned, how long is
 * left before its deadline, when it starts — reads ONE module-level `now`,
 * so two figures on one card can never disagree by a tick. The clock is a
 * store, not a hook's own interval: a figure subscribes with
 * `useSyncExternalStore`, and a tick re-renders the figures that read it and
 * nothing else — never the page, never the card around them.
 *
 * The rule:
 *
 *   - **1 s** while a timing grid is ON SCREEN (`useFineClock`, which a grid
 *     calls with its own element: an IntersectionObserver says when it is in
 *     view; where there is none, mounted counts as on screen);
 *   - **30 s** otherwise, while anything reads the clock at all;
 *   - **no timer** when nothing reads it;
 *   - under `prefers-reduced-motion: reduce` the 1 s tick is never taken: a
 *     second-by-second countdown is motion, and the 30 s clock still says
 *     every figure in minutes.
 */

import { useEffect, useSyncExternalStore, type RefObject } from 'react';
import { reducedMotion } from '@/lib/media';

/** The two periods, in milliseconds. */
export const PAGE_CLOCK = Object.freeze({ fineMs: 1000, coarseMs: 30_000 });

const listeners = new Set<() => void>();
let fineHolders = 0;
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
let period = 0;

/** The period the clock should tick at now: fine while a grid is on screen (and motion is welcome), else coarse. */
export function clockPeriod(): number {
  return fineHolders > 0 && !reducedMotion() ? PAGE_CLOCK.fineMs : PAGE_CLOCK.coarseMs;
}

function tick() {
  now = Date.now();
  for (const listener of [...listeners]) listener();
}

/** (Re)arm the one interval at the period the readers need — or none, when nobody reads. */
function arm() {
  const want = listeners.size ? clockPeriod() : 0;
  if (want === period && (want === 0 || timer !== undefined)) return;
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  period = want;
  if (want) timer = setInterval(tick, want);
}

function subscribe(listener: () => void): () => void {
  if (!listeners.size) now = Date.now();
  listeners.add(listener);
  arm();
  return () => {
    listeners.delete(listener);
    arm();
  };
}

const read = () => now;

/** The page's `now`, in ms — re-read on the page clock's tick, by this component alone. */
export function usePageNow(): number {
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Ask for the fine tick while `ref`'s element is on screen. A grid calls this
 * with its own box; when it scrolls away, the clock drops back to 30 s.
 */
export function useFineClock(ref: RefObject<Element | null>, active = true): void {
  useEffect(() => {
    if (!active) return undefined;
    let holding = false;
    const hold = (on: boolean) => {
      if (on === holding) return;
      holding = on;
      fineHolders += on ? 1 : -1;
      if (on) now = Date.now();
      arm();
    };
    const el = ref.current;
    if (el && typeof IntersectionObserver === 'function') {
      const seen = new IntersectionObserver((entries) => hold(entries.some((entry) => entry.isIntersecting)));
      seen.observe(el);
      return () => {
        seen.disconnect();
        hold(false);
      };
    }
    hold(true);
    return () => hold(false);
  }, [ref, active]);
}

/** For tests: how many fine holders and readers the clock has, and its period now. */
export function clockState(): { readers: number; fine: number; period: number } {
  return { readers: listeners.size, fine: fineHolders, period };
}
