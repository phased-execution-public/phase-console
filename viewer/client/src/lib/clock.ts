/**
 * A clock that moves.
 *
 * Every figure in the old run view changed only when the server spoke, so the
 * header said "started 20 minutes ago" and went on saying it for the next forty.
 * On a phase that thinks quietly for four minutes that is indistinguishable from
 * a page that has died — which is the single most common reason someone reloads
 * a console that was working perfectly.
 *
 * The interval is owned here rather than in the component so that "is this
 * ticking?" is one boolean at the call site: a frozen session's clock is
 * genuinely not running, and counting on would claim work that is not happening.
 */

import { useEffect, useState } from 'react';

export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    // Re-read on activation: a run that was idle for an hour must not paint one
    // stale second before the first tick lands.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

/** Whole seconds from `now` until `iso`, never below zero. */
export function secondsUntil(iso: string, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000));
}

/**
 * The seconds an ask with a window has left — a relayed question's (phase 14),
 * whose console answers it by rule when the window closes — re-read every second
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
  const now = useNow(open && secondsUntil(expiresAt ?? '') > 0);
  return open ? secondsUntil(expiresAt ?? '', now) : null;
}
