import { useCallback } from 'react';
import { useShortcut } from '@/lib/shortcut';
import { OVERLAY_KEYS, closeOverlaysHref, paletteHref, type Route } from '../routes';

/**
 * The palette's way in, claimed for the app's life: ⌘K anywhere (it is the way
 * out of a field, so it fires while typing), and `/` only when nothing is
 * being typed into. A second press while it is up closes it, the way every
 * palette does. The two guards that make either safe — a focused field, and a
 * focused pty, whose Ctrl-K is kill-to-end-of-line — belong to every shortcut
 * in the app and live in `lib/shortcut.ts`.
 *
 * Separate from the palette itself so the dialog's chunk (cmdk) loads only
 * when the address asks for it, while the chord works from the first paint.
 */
export function usePaletteShortcut(route: Route, navigate: (path: string) => void): void {
  const open = route.query[OVERLAY_KEYS.palette] != null;
  const toggle = useCallback(
    () => navigate(open ? closeOverlaysHref(route) : paletteHref('', route)),
    [navigate, open, route],
  );
  useShortcut([{ key: 'k', mod: true, whileTyping: true }, { key: '/' }], toggle);
}
