import { useCallback, useMemo } from 'react';
import { getPrefs, usePrefs } from '@/lib/prefs';

/**
 * Everything — the third door to depth (design.md §1, principle 3): a per-page
 * persisted switch that turns essentials into all columns, all facts, all
 * sections, all keys. No datum is removed by the glance; this is how every
 * datum stays within two interactions.
 *
 * The page holds the switch (`useEverything(page)`) and hands it to its
 * toolbar, whose last slot draws it (`EverythingSwitch`, `ui/toolbar.tsx`), and
 * to whatever it draws: the grid un-folds its `everything` columns
 * (`ui/grid/column.ts`), a page shows its folded sections. One preference key
 * holds every page's answer, and keys are only ever added, never renamed —
 * the name was decided once, here.
 */

/** The preference key: page id → whether Everything is on for that page. */
export const EVERYTHING_PREF = 'everything' as const;

export type EverythingPref = Readonly<Record<string, boolean>>;

/** What the switch hands a page. */
export interface Everything {
  /** Draw everything, or the essentials. */
  on: boolean;
  toggle: () => void;
}

/**
 * The page's switch, kept per page id across reloads and visits. Two pages
 * never share an answer: the runs table at its fullest says nothing about how
 * much a plan page should show.
 */
export function useEverything(page: string): Everything {
  const [prefs, setPrefs] = usePrefs();
  const on = prefs[EVERYTHING_PREF]?.[page] === true;
  const toggle = useCallback(() => {
    // Read at write time, not from the render: two writes in one tick must not
    // have the second undo the first.
    const { [page]: was, ...rest } = getPrefs()[EVERYTHING_PREF] ?? {};
    setPrefs({ [EVERYTHING_PREF]: was === true ? rest : { ...rest, [page]: true } });
  }, [page, setPrefs]);
  return useMemo(() => ({ on, toggle }), [on, toggle]);
}

/**
 * What the switch says to a screen reader once it has moved: the page changed
 * shape around the person, and a switch's own state is not that news.
 */
export const everythingSaid = (on: boolean): string =>
  on ? 'Showing everything: every column, fact and section.' : 'Showing the essentials.';
