import { expect, test, type Page } from '@playwright/test';

import { coverage, scrollMain, touch } from './lib/grid.ts';
import { VIEWPORTS, shoot } from './lib/shots.ts';

/*
 * The grid in a real browser (control-tower phase 18): what jsdom cannot say.
 *
 * jsdom lays nothing out, so the two promises that are ABOUT layout are held
 * here — a thousand rows draw only a window of `<tr>` while the header stays
 * pinned to the shell's one scroller, and a phone gets a card list with ONE
 * control above it, a View sheet holding the filters and the columns.
 *
 * The subject is the Debug delivery ledger (`#/debug/delivery`), a Free table
 * that asks for a toolbar, a window and a kept view. Its rows are the answer to
 * one request, served here rather than seeded: a thousand deliveries in the
 * fixture's state would reach every stop of the tour, and the tour's ratchet
 * is not this spec's to move. The section is not a tour stop.
 */

const OUTCOMES = ['sent', 'quiet', 'failed', 'throttled', 'gone'] as const;
const CATEGORIES = ['halted', 'needs-you', 'health'] as const;

function ledger(count: number) {
  const newest = Date.parse('2026-09-20T12:00:00Z');
  return {
    entries: Array.from({ length: count }, (_, i) => ({
      source: 'delivery',
      at: new Date(newest - i * 60_000).toISOString(),
      level: 'info',
      event: `delivery.${OUTCOMES[i % OUTCOMES.length]}`,
      text: `Announcement ${i + 1}`,
      data: { label: `device-${i % 7}`, category: CATEGORIES[i % CATEGORIES.length] },
    })),
    sources: [],
    truncated: false,
    slugs: [],
  };
}

async function serveLedger(page: Page, count: number): Promise<void> {
  await page.route(/\/api\/debug\/index\?(?:.*&)?source=delivery/, (route) =>
    route.fulfill({ json: ledger(count) }),
  );
}

test.describe('the grid', () => {
  test('1,000 rows put fewer than 80 <tr> in the DOM, and the header stays sticky', async ({
    page,
  }, info) => {
    test.skip(touch(info.project.name), 'the desk table; a touch viewport is the card list');
    await serveLedger(page, 1000);
    await page.goto('/#/debug/delivery');

    const table = page.getByRole('table', { name: 'Delivery ledger' });
    // The window is on once the engine has landed: the table then says how
    // many rows it has while holding only a few of them.
    await expect(table).toHaveAttribute('aria-rowcount', '1001');
    expect(await table.locator('tr').count()).toBeLessThan(80);

    // Halfway down the shell's one scroller — the table has none of its own.
    await scrollMain(page, 0.5);
    await expect
      .poll(async () =>
        Number(await table.locator('tbody tr[aria-rowindex]').first().getAttribute('aria-rowindex')),
      )
      .toBeGreaterThan(200);
    expect(await table.locator('tr').count()).toBeLessThan(80);

    // The header rode down with the page: its cells sit at the scroller's top
    // edge, not a thousand rows above it.
    const edges = await page.evaluate(() => {
      const head = document.querySelector('table[aria-label="Delivery ledger"] thead th');
      const main = document.querySelector('main');
      return {
        head: head?.getBoundingClientRect().top ?? NaN,
        main: main?.getBoundingClientRect().top ?? NaN,
      };
    });
    expect(Math.abs(edges.head - edges.main)).toBeLessThanOrEqual(2);

    // And the window covers what the scroller shows. The rows are placed from
    // the table's top inside `<main>`, below everything the page draws above
    // it; a window that never measured that drew its rows a page too low and
    // left a band of bare spacer under the header, where rows should be.
    await expect.poll(() => coverage(page, 'table[aria-label="Delivery ledger"]')).toBe('covered');
    // For the building session to READ, never to diff (`lib/shots.ts`).
    await shoot(page, info.project.name, 'tables-window');
  });

  test('the phone rendering is a card list with one "View" sheet for filters and columns', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== VIEWPORTS[0].name, 'the phone');
    await serveLedger(page, 1000);
    await page.goto('/#/debug/delivery');

    const list = page.getByRole('list', { name: 'Delivery ledger' });
    await expect(list).toBeVisible();
    await expect(page.getByRole('table', { name: 'Delivery ledger' })).toHaveCount(0);
    // The card list is windowed too: a phone is where a thousand nodes cost most.
    await expect.poll(async () => list.locator('li').count()).toBeLessThan(80);

    // ONE control above the cards. No filter box of its own on a phone: the
    // sheet holds every setting the desk spreads out.
    const view = page.getByRole('button', { name: /^View/ });
    await expect(view).toHaveCount(1);
    await expect(page.getByRole('searchbox')).toHaveCount(0);

    await shoot(page, info.project.name, 'tables-cards');
    await view.click();
    const sheet = page.getByRole('dialog', { name: 'View' });
    await expect(sheet).toBeVisible();
    await shoot(page, info.project.name, 'tables-view-sheet');
    await expect(
      sheet.getByRole('searchbox', { name: 'Filter delivery ledger by announcement' }),
    ).toBeVisible();
    await expect(sheet.getByRole('group', { name: 'Outcome' })).toBeVisible();
    await expect(sheet.getByRole('radiogroup', { name: 'Group by' })).toBeVisible();
    await expect(sheet.getByRole('group', { name: 'Columns' })).toBeVisible();

    // And it works: keep only the failures, and the page says how many of how many.
    await sheet
      .getByRole('group', { name: 'Outcome' })
      .getByRole('checkbox', { name: /^failed/ })
      .check();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(page.getByText('200 of 1000 shown')).toBeVisible();
    await expect(list.getByRole('listitem').first()).toContainText('failed');

    // Two hundred cards are still a window, and it covers what the phone shows.
    await scrollMain(page, 0.5);
    await expect.poll(() => coverage(page, 'ul[aria-label="Delivery ledger"]')).toBe('covered');
  });
});
