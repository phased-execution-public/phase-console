/**
 * Keyboard chords, and the one guard every chord needs.
 *
 * A window-level `keydown` listener is a global claim on a key, and the two
 * things that make one safe were written out by hand wherever a shortcut
 * appeared: *is a person typing into something* (four copies under `src/`,
 * three of them subtly different), and *is a terminal focused* (one, in the
 * palette, and it was a bug fix — Ctrl-K is kill-to-end-of-line in every shell
 * and in readline, and the palette's listener swallowed it, so the console's
 * own terminal was the one place the shortcut could not be used).
 *
 * Both live here now, so the next shortcut inherits them instead of
 * rediscovering them.
 */

import { useEffect } from 'react';

/**
 * One key with its modifiers.
 *
 * `mod` means "the platform's command key": ⌘ on a Mac, Ctrl elsewhere. It is
 * one flag rather than two because no chord in this app wants ⌘ and not Ctrl,
 * and a per-platform test at every call site is a per-platform bug at every
 * call site.
 */
export interface Chord {
  /** Compared case-insensitively against `event.key` — `'k'`, `'/'`, `'Escape'`. */
  key: string;
  /** ⌘ on a Mac, Ctrl elsewhere. Without it, the chord requires NO modifier. */
  mod?: boolean;
  /**
   * Fire even while a person is typing.
   *
   * ⌘K wants this — it is the way out of a field. A bare letter never does:
   * a shortcut that steals a keystroke from a text box is a shortcut that
   * eats a sentence.
   */
  whileTyping?: boolean;
}

/** Fields that own their keys — a shortcut must never steal a keystroke from one. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element?.tagName) return false;
  const tag = element.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  // `=== true`, not a bare read: jsdom leaves `isContentEditable` undefined.
  return element.isContentEditable === true;
}

/**
 * Is the keystroke inside a pty?
 *
 * A terminal owns its whole keyboard, and xterm's hidden helper textarea
 * bubbles every keystroke up to `window` — so a Ctrl chord captured here is a
 * Ctrl chord the shell never sees. ⌘ is not a terminal chord on any platform
 * and is deliberately unaffected.
 */
export function inTerminal(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest?.('.phase-term'));
}

/** Does this event match this chord, under the two guards above? */
function matches(event: KeyboardEvent, chord: Chord): boolean {
  if (event.key.toLowerCase() !== chord.key.toLowerCase()) return false;
  if (!chord.whileTyping && isTypingTarget(event.target)) return false;
  if (chord.mod) return event.metaKey || (event.ctrlKey && !inTerminal(event.target));
  // A bare key means bare: `/` with Alt held is a different keystroke, and
  // claiming it would break a browser or OS binding that already has it.
  return !event.metaKey && !event.ctrlKey && !event.altKey;
}

export interface ShortcutOptions {
  /** Off while a surface is not mounted enough to answer. Default on. */
  enabled?: boolean;
  /**
   * Call `preventDefault()` before the handler. Default on — a chord this app
   * claims is a chord the browser must not also act on.
   */
  preventDefault?: boolean;
}

/**
 * Claim a chord for as long as this component is mounted.
 *
 * `handler` is read through a ref-free dependency: it goes in the effect's own
 * dep list, so pass a `useCallback` (or an inline closure over stable values)
 * exactly as you would to any other effect. The alternative — stashing it in a
 * ref so the listener never re-binds — is the classic stale-closure bug this
 * codebase's lint rule exists to prevent.
 */
export function useShortcut(
  chords: Chord | readonly Chord[],
  handler: (event: KeyboardEvent) => void,
  { enabled = true, preventDefault = true }: ShortcutOptions = {},
): void {
  // A stable dependency: the chord list is nearly always an inline literal, and
  // a fresh array every render would re-bind the listener every render. A Chord
  // is plain data — two strings and two flags — so the round trip is lossless
  // and the JSON IS the identity.
  const signature = JSON.stringify(Array.isArray(chords) ? chords : [chords]);

  useEffect(() => {
    if (!enabled) return undefined;
    const list = JSON.parse(signature) as Chord[];
    const onKey = (event: KeyboardEvent) => {
      if (!list.some((chord) => matches(event, chord))) return;
      if (preventDefault) event.preventDefault();
      handler(event);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [signature, handler, enabled, preventDefault]);
}
