import { useSyncExternalStore } from 'react';

/**
 * The document's direction, for the primitives that must be told it
 * (quiet-console phase 27).
 *
 * A Radix root draws `dir="ltr"` on itself unless it is told otherwise — it
 * reads its own prop, then a provider, then defaults — so with `dir="rtl"` on
 * the document a tab strip, a radio group, a menu and a select stayed left to
 * right inside a page that had mirrored around them, and their arrow keys
 * moved the wrong way. The switch is the `dir` attribute on `<html>`; this
 * reads it, and follows it when it is thrown while the page is open.
 */
export type Direction = 'ltr' | 'rtl';

const read = (): Direction =>
  typeof document !== 'undefined' && document.documentElement.getAttribute('dir') === 'rtl' ? 'rtl' : 'ltr';

function subscribe(notify: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => {};
  const watch = new MutationObserver(notify);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ['dir'] });
  return () => watch.disconnect();
}

/** `'rtl'` while the document reads right to left, else `'ltr'`. */
export function useDocumentDir(): Direction {
  return useSyncExternalStore(subscribe, read, () => 'ltr');
}

/**
 * The mark on a `dir` that only repeats the document's. The base layer
 * (`styles/theme.css`) leaves an element that DECLARES a direction — a Persian
 * guide, a `<bdi>` — and everything inside it as declared; a primitive told
 * the page's direction declares nothing, so the text inside a radio group or a
 * menu still finds its own (an English option's full stop stays last).
 */
export const DIR_MIRROR = { 'data-dir-mirror': '' } as const;

/** The mark, unless the caller declared a direction of its own. */
export const mirrorUnless = (declared: Direction | undefined): Partial<typeof DIR_MIRROR> =>
  declared ? {} : DIR_MIRROR;
