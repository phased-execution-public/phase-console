/**
 * What the grid's specs ask of a real browser (`tables.spec.ts`, `plan.spec.ts`).
 *
 * jsdom lays nothing out, so a window drawn in the wrong place — rows a page
 * too low, a band of bare spacer under the header — passes every client test.
 * These read the laid-out page.
 */
import type { Page } from '@playwright/test';

import { VIEWPORTS } from './shots.ts';

/** A touch viewport draws the grid as a card list, not a table. */
export const touch = (project: string): boolean => VIEWPORTS.find((v) => v.name === project)?.touch ?? false;

/**
 * Whether the drawn items fill what `<main>` shows, from its top — or the
 * sticky header's foot — to its bottom: `covered`, else where the gap is. The
 * items are a table's rows or a list's cards; the spacers are `aria-hidden`.
 */
export function coverage(page: Page, selector: string): Promise<string> {
  return page.evaluate((selector) => {
    const grid = document.querySelector(selector);
    const main = document.querySelector('main');
    if (!grid || !main) return 'no grid';
    // A header sticks by its cells, so a cell's foot is the edge it holds.
    const cell = grid.querySelector('thead th');
    const top = cell ? cell.getBoundingClientRect().bottom : main.getBoundingClientRect().top;
    const bottom = main.getBoundingClientRect().bottom;
    const items = [...grid.querySelectorAll('tbody tr[aria-rowindex], :scope > li:not([aria-hidden])')].map(
      (item) => item.getBoundingClientRect(),
    );
    const first = items.find((item) => item.bottom > top);
    const last = items.at(-1);
    if (!first || !last) return 'nothing drawn below the top edge';
    if (first.top > top + 1) return `a ${Math.round(first.top - top)}px band at the top`;
    if (last.bottom < bottom - 1) return `a ${Math.round(bottom - last.bottom)}px band at the foot`;
    return 'covered';
  }, selector);
}

/** Scroll the shell's one scroller — no table has one of its own — to a fraction of its height. */
export async function scrollMain(page: Page, fraction: number): Promise<void> {
  await page
    .locator('main')
    .first()
    .evaluate((main, fraction) => {
      main.scrollTop = main.scrollHeight * fraction;
    }, fraction);
}

/**
 * Scroll the shell's one scroller to a fraction of ONE grid, so that `<main>`
 * shows nothing but that grid. A fraction of the scroller's own height is a
 * fraction of the whole page, and what stands below a grid moves with the
 * fixture's clock: once the live run's card lands under the plan's phases,
 * halfway down the page was the table's last rows and 554 px of that card
 * (control-tower phase 34).
 */
export async function scrollMainWithin(page: Page, selector: string, fraction: number): Promise<void> {
  await page
    .locator('main')
    .first()
    .evaluate(
      (main, [selector, fraction]) => {
        const grid = document.querySelector(selector);
        if (!grid) return;
        const box = grid.getBoundingClientRect();
        const top = box.top - main.getBoundingClientRect().top + main.scrollTop;
        main.scrollTop = top + Math.max(0, box.height - main.clientHeight) * fraction;
      },
      [selector, fraction] as const,
    );
}
