/**
 * Every legacy address lands (control-tower phase 21, exit criterion 1).
 *
 * 6.0 made `#/runs` — the Tower — the home, and retired Now, the Ready list and
 * the Pulse as destinations. Bookmarks, a notification a phone kept for a week
 * and the server's own pushes (`/#/now`, `/#/ready`) still carry the old
 * addresses, so each is asked of the real console in a real browser: it must
 * land where `client/src/app/routes.ts` rules, query and all, and draw the page
 * it names. `app/router.test.tsx` holds the same table against the translation
 * itself; this is the proof that the hash, the router and the page agree.
 */

import { expect, test } from '@playwright/test';

import { VIEWPORTS } from './lib/shots.ts';

/** Where each old address lands, and the page title drawn there. */
const LANDS: readonly { from: string; to: string; title: string }[] = [
  { from: '#/now', to: '#/runs', title: 'Runs' },
  { from: '#/now?focus=inbox', to: '#/runs?bay=needs-you', title: 'Runs' },
  { from: '#/now?focus=lanes', to: '#/runs?bay=live', title: 'Runs' },
  { from: '#/now?focus=next', to: '#/runs?bay=ready', title: 'Runs' },
  { from: '#/now?focus=plans', to: '#/plans', title: 'Plans' },
  { from: '#/dashboard', to: '#/runs', title: 'Runs' },
  // One hop each, not through `#/now`: the server mints `/#/ready` today.
  { from: '#/ready', to: '#/runs?bay=ready', title: 'Runs' },
  { from: '#/pulse', to: '#/runs?bay=live', title: 'Runs' },
  // The overlays ride on the home now, and open over it.
  { from: '#/search?q=cart', to: '#/runs?k=cart', title: 'Runs' },
  { from: '#/guide/mobile', to: '#/runs?help=mobile', title: 'Runs' },
  { from: '#/notifications', to: '#/runs?bell=1&panel=announcements', title: 'Runs' },
  // Not a redirect at all: the Pro ledger's address stays what it was.
  { from: '#/runs?view=table', to: '#/runs?view=table', title: 'Runs' },
];

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test.describe('every old address lands', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== VIEWPORTS[0].name, 'an address is the same at every width');
  });

  for (const { from, to, title } of LANDS) {
    test(`${from} → ${to}`, async ({ page }) => {
      await page.goto(`/${from}`);
      await expect(page).toHaveURL(new RegExp(`${escape(to)}$`));
      // By locator, not role: an overlay the address opens hides the page from
      // the accessibility tree while it is open, and the page is still there.
      await expect(page.locator('main h1').first()).toHaveText(title);
    });
  }

  test('an address that names nothing is the home, and is not rewritten', async ({ page }) => {
    await page.goto('/#/');
    await expect(page.locator('main h1').first()).toHaveText('Runs');
    await expect(page).toHaveURL(/#\/$/);
  });
});
