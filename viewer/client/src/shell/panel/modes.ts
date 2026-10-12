/**
 * The right panel's modes (7.0, quiet-console phase 3): **Details** — the
 * inspector, the second door to depth on every page — and, in Pro,
 * **Supervisor** — the chat, beside whatever page you are on. One panel, a
 * segmented control at its top, ⌘I and ⌘. to toggle each, and its width, mode
 * and whether it stands in `prefs.panel`, because it survives navigation.
 *
 * Pure: the words, the readers and the writers. `frame.tsx` draws it.
 */

import { PANEL_WIDTH, getPrefs, setPrefs, type PanelPref } from '@/lib/prefs';

export const PANEL_MODES = [
  'details',
] as const;

export type PanelMode = (typeof PANEL_MODES)[number];

export const MODE_LABEL: Readonly<Record<PanelMode, string>> = {
  details: 'Details',
};

export function isPanelMode(value: string): value is PanelMode {
  return (PANEL_MODES as readonly string[]).includes(value);
}

/** The pref as a mode the shell can draw — a browser that stored a word this build lacks reads Details. */
export function panelMode(pref: PanelPref): PanelMode {
  return isPanelMode(pref.mode) ? pref.mode : 'details';
}

/**
 * The facts of `/api/state` the panel reads — a structural subset, so a test can hand it a stub. An
 * intersection rather than an interface: the free build reads none of them, and an empty interface
 * is a type that admits anything.
 */
export type PanelState = object & {
};

/**
 * Whether the panel stands at all: open, and in a mode that has something to
 * show here. The Supervisor needs a server that offers one, is never drawn
 * beside its own page — `#/chat` IS the chat — and never on a phone, where
 * `#/chat` is the only place it is drawn.
 */
export function panelStands(
  pref: PanelPref,
  state: PanelState | undefined,
  head: string | undefined,
  phone = false,
): boolean {
  if (!pref.open) return false;
  void state;
  void head;
  void phone;
  return true;
}

export const clampWidth = (width: number): number =>
  Math.min(PANEL_WIDTH.max, Math.max(PANEL_WIDTH.min, Math.round(width)));

function patchPanel(patch: Partial<PanelPref>): void {
  setPrefs({ panel: { ...getPrefs().panel, ...patch } });
}

/** Open the panel in a mode (the mode it is in, by default). */
export function openPanel(mode?: PanelMode): void {
  patchPanel({ open: true, ...(mode ? { mode } : {}) });
}

export function closePanel(): void {
  patchPanel({ open: false });
}

/** Open in this mode, or close if it is already open in it — what a toggle does. */
export function togglePanel(mode: PanelMode): void {
  const current = getPrefs().panel;
  if (current.open && panelMode(current) === mode) closePanel();
  else openPanel(mode);
}

export function setPanelWidth(width: number): void {
  patchPanel({ width: clampWidth(width) });
}

