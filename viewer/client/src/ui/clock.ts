/**
 * The one page clock (turn-by-turn phase 8; the only clock since
 * measured-console phase 32, when `lib/clock.ts` folded into it).
 *
 * Every clock a page shows — how long ago an item was assigned, how long is
 * left before its deadline, how long a session has been running, when a
 * relayed question's window closes — reads ONE module-level `now`, so two
 * figures on one page can never disagree by a tick. The clock is a store, not
 * a hook's own interval: a figure subscribes with `useSyncExternalStore`, and
 * a tick re-renders the figures that read it and nothing else — never the
 * page, never the card around them. There is one interval for the whole page,
 * however many figures read it.
 *
 * The rule:
 *
 *   - **1 s** while a timing grid is ON SCREEN (`useFineClock`, which a grid
 *     calls with its own element: an IntersectionObserver says when it is in
 *     view; where there is none, mounted counts as on screen);
 *   - **30 s** otherwise, while anything reads the clock at all;
 *   - a figure that states its own cadence (`useNow(active, everyMs)` — a
 *     live run's elapsed seconds, a lane's minute) is re-read on that cadence,
 *     and the one interval runs at the finest cadence anything on the page
 *     asks for;
 *   - **no timer** when nothing reads it;
 *   - under `prefers-reduced-motion: reduce` the grid's 1 s tick is never
 *     taken: a second-by-second countdown is motion, and the 30 s clock still
 *     says every figure in minutes.
 *
 * A reader is told of a tick only when its own cadence's bucket of wall time
 * has turned over (`floor(now / everyMs)`), so every figure on one cadence
 * moves on the same tick, and a figure on a coarse cadence is not re-rendered
 * by a fine one beside it. `lib/clock` is not importable: ESLint refuses it.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import { reducedMotion } from '@/lib/media';

/** The two periods, in milliseconds. */
export const PAGE_CLOCK = Object.freeze({ fineMs: 1000, coarseMs: 30_000 });

/** One figure reading the clock: its cadence (none = the page's own), its last value, and how to tell it. */
interface Reader {
  everyMs?: number;
  value: number;
  notify: () => void;
}

const readers = new Set<Reader>();
let fineHolders = 0;
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
let period = 0;

/** The page's own cadence: fine while a grid is on screen (and motion is welcome), else coarse. */
function pageEvery(): number {
  return fineHolders > 0 && !reducedMotion() ? PAGE_CLOCK.fineMs : PAGE_CLOCK.coarseMs;
}

/** The period the clock should tick at now: the page's cadence, or the finest a figure asks for. */
export function clockPeriod(): number {
  let want = pageEvery();
  for (const reader of readers) if (reader.everyMs !== undefined) want = Math.min(want, reader.everyMs);
  return want;
}

const bucket = (at: number, everyMs: number) => Math.floor(at / everyMs);

function tick() {
  now = Date.now();
  const page = pageEvery();
  for (const reader of [...readers]) {
    const every = reader.everyMs ?? page;
    if (bucket(now, every) === bucket(reader.value, every)) continue;
    reader.value = now;
    reader.notify();
  }
}

/** (Re)arm the one interval at the period the readers need — or none, when nobody reads. */
function arm() {
  const want = readers.size ? clockPeriod() : 0;
  if (want === period && (want === 0 || timer !== undefined)) return;
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  period = want;
  if (want) timer = setInterval(tick, want);
}

function join(reader: Reader): () => void {
  if (!readers.size) now = Date.now();
  // A figure that starts reading re-reads: one idle for an hour must not
  // paint a stale second before the first tick lands.
  reader.value = now;
  readers.add(reader);
  arm();
  if (Date.now() - now >= (reader.everyMs ?? pageEvery())) tick();
  return () => {
    readers.delete(reader);
    arm();
  };
}

/** The page's `now`, in ms — re-read on the page clock's tick, by this component alone. */
export function usePageNow(): number {
  return useClock(true, undefined);
}

/**
 * `now`, in ms, from the one page clock — re-read every `everyMs` while
 * `active`, and held still while not: a frozen session's clock is genuinely
 * not running, and counting on would claim work that is not happening.
 */
export function useNow(active: boolean, everyMs: number = PAGE_CLOCK.fineMs): number {
  return useClock(active, everyMs);
}

function useClock(active: boolean, everyMs: number | undefined): number {
  const reader = useRef<Reader | null>(null);
  if (reader.current === null)
    reader.current = { value: readers.size ? now : Date.now(), notify: () => undefined };
  const self = reader.current;
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!active) return () => undefined;
      self.everyMs = everyMs;
      self.notify = notify;
      return join(self);
    },
    [self, active, everyMs],
  );
  const read = useCallback(() => self.value, [self]);
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

/** Whole seconds from `now` until `iso`, never below zero. */
export function secondsUntil(iso: string, at: number = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - at) / 1000));
}

/**
 * The seconds an ask with a window has left — a relayed question's, whose
 * console answers it by rule when the window closes — re-read every second
 * while it is open. A countdown that only moved on the next server event would
 * read "55 s" until the console had already answered.
 *
 * `null` for an ask with no window, which waits for a person however long that
 * takes. One hook for every surface that shows a window (the run page's
 * question card, `#/approve`, and an inbox row), so they cannot disagree about
 * how long is left.
 */
export function useWindowLeft(expiresAt: string | undefined | null): number | null {
  const open = Boolean(expiresAt) && Number.isFinite(Date.parse(expiresAt ?? ''));
  const at = useNow(open && secondsUntil(expiresAt ?? '') > 0, PAGE_CLOCK.fineMs);
  return open ? secondsUntil(expiresAt ?? '', at) : null;
}

/** For tests: how many fine holders and readers the clock has, and its period now. */
export function clockState(): { readers: number; fine: number; period: number } {
  return { readers: readers.size, fine: fineHolders, period };
}
