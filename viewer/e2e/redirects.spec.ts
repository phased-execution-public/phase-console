/**
 * Every legacy address lands (control-tower phase 21, exit criterion 1).
 *
 * 6.0 made `#/runs` — the Tower — the home, and retired Now, the Ready list and
 * the Pulse as destinations; 7.0 renamed Debug to Logs (quiet-console phase 3)
 * and rebuilt the home as the Runs home (phase 7), whose word for a group is
 * `?group=` — `?bay=`, the 6.x spelling the server still mints into pushes, is
 * read as an alias and never written again — and whose Queued group is where
 * the queue page went. Bookmarks, a notification a phone kept for a week and
 * the server's own pushes (`/#/now`, `/#/ready`, `/#/queue`) still carry the
 * old addresses, so each is asked of the real console in a real browser: it
 * must land where `client/src/shell/redirects.ts` rules, in one hop, query and
 * all, and draw the page it names — read off the chrome's own word for the
 * place (`header-title`), because the home's `<h1>` is the situation sentence,
 * not a name. The client suite holds the same table against the translation
 * itself; this is the proof that the hash, the router and the page agree.
 */

import { expect, test } from '@playwright/test';

import { VIEWPORTS } from './lib/shots.ts';

/** `#/queue`: the Queue page in Pro, the Runs home's Queued group in Free. */
const QUEUE_LANDS: { from: string; to: string; title: string }[] = [
  { from: '#/queue', to: '#/runs?group=queued', title: 'Runs' },
];

/** Where each old address lands, and the chrome's word for the place drawn there. */
const LANDS: readonly { from: string; to: string; title: string }[] = [
  { from: '#/now', to: '#/runs', title: 'Runs' },
  { from: '#/now?focus=inbox', to: '#/runs?group=needs-you', title: 'Runs' },
  { from: '#/now?focus=lanes', to: '#/runs?group=live', title: 'Runs' },
  { from: '#/now?focus=next', to: '#/runs?group=ready', title: 'Runs' },
  { from: '#/now?focus=plans', to: '#/plans', title: 'Plans' },
  { from: '#/dashboard', to: '#/runs', title: 'Runs' },
  // One hop each, not through `#/now`: the server mints `/#/ready` today.
  { from: '#/ready', to: '#/runs?group=ready', title: 'Runs' },
  { from: '#/pulse', to: '#/runs?group=live', title: 'Runs' },
  // The queue page (control-tower phase 99) was the home's Queued group from 7.0; in Pro it is a
  // page again (one-pool phase 40) and stays where it is, query and all. Free keeps the redirect.
  ...QUEUE_LANDS,
  // The overlays ride on the home now, and open over it.
  { from: '#/search?q=cart', to: '#/runs?k=cart', title: 'Runs' },
  { from: '#/guide/mobile', to: '#/runs?help=mobile', title: 'Runs' },
  { from: '#/notifications', to: '#/runs?bell=1&panel=announcements', title: 'Runs' },
  // The phone's answer page became Your turn (control-tower phase 137), and a
  // push's step lands on its item — both in one hop.
  { from: '#/approve', to: '#/turn', title: 'Your turn' },
  { from: '#/approve?step=turn-now-signin', to: '#/turn/turn-now-signin', title: 'Your turn' },
  // Debug became Logs in 7.0: the section and every filter ride along, in one
  // hop, onto 7.0's own place (quiet-console phase 20) — and the section it
  // names is the one lit, which the case below asks of every section.
  { from: '#/debug', to: '#/logs', title: 'Logs' },
  { from: '#/debug/health?since=1', to: '#/logs/health?since=1', title: 'Logs' },
  // Not redirects at all: the 6.x spelling of a group, and the Pro ledger's
  // address, are read as aliases and the address stays what it was.
  { from: '#/runs?bay=live', to: '#/runs?bay=live', title: 'Runs' },
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
      // the accessibility tree while it is open, and the chrome is still there.
      await expect(page.getByTestId('header-title')).toHaveText(title);
    });
  }

  // Each Logs section is an address, and the 6.x one lands on it with its
  // query: the page's own heading says Logs and its section nav lights the
  // section the address named (the two Pro sections ride the Pro tree).
  const SECTIONS: readonly [string, string][] = [
    ['journal', 'Journal'],
    ['delivery', 'Delivery'],
    ['health', 'Health'],
    ['access', 'Access'],
  ];
  test('#/debug/<section>?q lands on #/logs/<section>?q with that section lit', async ({ page }) => {
    for (const [id, label] of SECTIONS) {
      await page.goto(`/#/debug/${id}?slug=demo`);
      await expect(page).toHaveURL(new RegExp(`#/logs/${id}\\?slug=demo$`));
      await expect(page.getByRole('heading', { level: 1, name: 'Logs' })).toBeVisible();
      await expect(
        page.getByRole('navigation', { name: 'Logs sections' }).getByRole('link', { name: label }),
      ).toHaveAttribute('aria-current', 'page');
    }
  });

  test('an address that names nothing is the home, and is not rewritten', async ({ page }) => {
    await page.goto('/#/');
    await expect(page.getByTestId('header-title')).toHaveText('Runs');
    await expect(page).toHaveURL(/#\/$/);
  });
});
