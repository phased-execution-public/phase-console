/**
 * The undo window (turn-by-turn phase 5) — a terminal press held on the page.
 *
 * *Not doing this*, *Send my decision*, *Approve* and *Deny* end an item: the
 * session is told, the gate opens, the run moves. A press like that is the one
 * a person most wants back a second later, and once sent nothing takes it back
 * — so it is HELD on the page for `UNDO_WINDOW_MS` with an *Undo* beside it,
 * and only then sent. Undone, it sends nothing, ever. The server never sees a
 * held press, so there is no second route to cancel one: the hold is the
 * page's alone.
 *
 * Pure scheduling: the clock is injected (`timers`), so a test drives it with
 * fake timers and a page uses the real ones.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** How long a terminal press waits on the page before it is sent. */
export const UNDO_WINDOW_MS = 5000;

/** The clock a hold runs on — `setTimeout` and `clearTimeout` unless a caller says otherwise. */
export interface UndoTimers {
  set: (fire: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const REAL_TIMERS: UndoTimers = {
  set: (fire, ms) => setTimeout(fire, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type HeldOutcome = 'sent' | 'undone';

/** One held press: take it back, or send it at once; `settled` says which happened. */
export interface HeldPress {
  /** Where it stands: still held, sent, or taken back. */
  readonly state: 'held' | HeldOutcome;
  /** Take it back — true when it was still held; after it was sent, nothing happens. */
  undo: () => boolean;
  /** Send it now rather than at the window's end — once; a sent or undone press stays as it is. */
  sendNow: () => void;
  /** Resolves once, with what became of it. */
  readonly settled: Promise<HeldOutcome>;
}

/**
 * Hold `send` for `ms`, then call it — exactly once, and never after `undo()`.
 * `send` is the press itself; what it answers is its own business (the card
 * shows a refusal where the press was made).
 */
export function holdPress(
  send: () => unknown,
  { ms = UNDO_WINDOW_MS, timers = REAL_TIMERS }: { ms?: number; timers?: UndoTimers } = {},
): HeldPress {
  let state: 'held' | HeldOutcome = 'held';
  let settle: (outcome: HeldOutcome) => void = () => undefined;
  const settled = new Promise<HeldOutcome>((resolve) => {
    settle = resolve;
  });
  let handle: unknown = null;
  const fire = () => {
    if (state !== 'held') return;
    state = 'sent';
    timers.clear(handle);
    settle('sent');
    send();
  };
  handle = timers.set(fire, ms);
  return {
    get state() {
      return state;
    },
    undo: () => {
      if (state !== 'held') return false;
      state = 'undone';
      timers.clear(handle);
      settle('undone');
      return true;
    },
    sendNow: fire,
    settled,
  };
}

/** What a card draws while a press is held: its words, and how long the window is. */
export type HeldView = { label: string; ms: number };

/**
 * One card's held press. A second terminal press while one is held sends the
 * first at once — two held presses on one item would be two answers to one
 * question — and a card that leaves the page sends what it holds, because the
 * person pressed it and did not take it back.
 */
export function useHeldPress(ms: number = UNDO_WINDOW_MS) {
  const current = useRef<HeldPress | null>(null);
  const [held, setHeld] = useState<HeldView | null>(null);

  useEffect(
    () => () => {
      current.current?.sendNow();
    },
    [],
  );

  const hold = useCallback(
    (label: string, send: () => unknown) => {
      current.current?.sendNow();
      const press = holdPress(send, { ms });
      current.current = press;
      setHeld({ label, ms });
      void press.settled.then(() => {
        if (current.current !== press) return;
        current.current = null;
        setHeld(null);
      });
    },
    [ms],
  );

  const undo = useCallback(() => current.current?.undo() ?? false, []);
  const sendNow = useCallback(() => current.current?.sendNow(), []);

  return { held, hold, undo, sendNow };
}
