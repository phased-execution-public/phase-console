/**
 * Every key the shell answers, in ONE table (#334): the chords the hooks claim
 * (`palette/shortcut.ts`, `panel/shortcuts.ts`) are read from here, and
 * Settings ▸ Essentials ▸ Keyboard draws this list row by row — so the card
 * cannot list a key nothing answers, or miss one something does. A row with no
 * `chords` is a key a component answers on its own (Esc is every overlay's,
 * the arrows the panel edge's) and is here so the card says it.
 *
 * The same keys are the help sheet's Keyboard table (`content/guide/reference.md`).
 */

import type { Chord } from '@/lib/shortcut';

export interface Shortcut {
  /** The keys as drawn: one is a key, two or more a chord. */
  keys: readonly string[];
  /** What it does, in the card's words. */
  does: string;
  /** What the shell claims for it, when the shell claims it (`useShortcut`). */
  chords?: readonly Chord[];
}

/** ⌘K anywhere — the way out of a field, so it fires while typing. */
export const PALETTE_KEY: Shortcut = {
  keys: ['⌘', 'K'],
  does: 'Search and commands',
  chords: [{ key: 'k', mod: true, whileTyping: true }],
};

/** `/` only when nothing is being typed into. */
export const PALETTE_BARE_KEY: Shortcut = {
  keys: ['/'],
  does: 'The same, without a modifier',
  chords: [{ key: '/' }],
};

export const DETAILS_KEY: Shortcut = {
  keys: ['⌘', 'I'],
  does: 'Open or close the panel’s Details',
  chords: [{ key: 'i', mod: true, whileTyping: true }],
};


/** The card's list, in the card's order. */
export const KEYMAP: readonly Shortcut[] = [
  PALETTE_KEY,
  PALETTE_BARE_KEY,
  DETAILS_KEY,
  { keys: ['Esc'], does: 'Close a dialog, a sheet, the palette, the bell or the help sheet' },
  { keys: ['←', '→'], does: 'Widen or narrow the panel from its focused edge' },
];
