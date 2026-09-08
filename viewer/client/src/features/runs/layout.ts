/**
 * How the fleet is drawn — the table, or the cards — and where that is kept.
 *
 * The Plans list has had this choice since 3.0 (`prefs.plansLayout`); the fleet
 * had the two renderings and no way to ask for either, so the viewport decided
 * and a laptop could never see the cards while a phone could never see the
 * table. Cards are the better read when the question is "what is wrong with
 * this one"; the table is the better read when the question is "which of these
 * cost the most", and both questions get asked on both sizes of screen.
 *
 * The default is `auto`, which is the behaviour that shipped: cards below the
 * shell breakpoint, the table above it. Choosing either explicitly is what
 * makes it stick.
 *
 * ## Why the key is declared here
 *
 * `Prefs` lives in `lib/prefs.ts` and is one store for the whole app — this is
 * `lib/prefs.ts`'s own `runsLayout` key: the value is read and written
 * through the same `usePrefs()`, lands in the same `localStorage` blob and
 * survives the same way. `auto` is resolved here, once, rather than left to
 * each caller.
 */

import { usePrefs, type Prefs } from '@/lib/prefs';
import { usePhone } from '@/lib/media';

export type RunsLayout = Prefs['runsLayout'];

/** What `auto` means on this screen. */
export function resolveRunsLayout(choice: RunsLayout | undefined, phone: boolean): 'table' | 'cards' {
  if (choice === 'table' || choice === 'cards') return choice;
  return phone ? 'cards' : 'table';
}

/**
 * The fleet's shape, and the one way to change it.
 *
 * Returns what is DRAWN, never `auto` — a caller rendering a toggle needs to
 * know which of the two is on screen, and a caller rendering the fleet needs
 * the same answer.
 */
export function useRunsLayout(): ['table' | 'cards', (next: 'table' | 'cards') => void] {
  const [prefs, setPrefs] = usePrefs();
  const phone = usePhone();
  return [resolveRunsLayout(prefs.runsLayout, phone), (next) => setPrefs({ runsLayout: next })];
}
