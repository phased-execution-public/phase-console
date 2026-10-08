import { expect, test } from '@playwright/test';

import { layoutFindings } from './lib/probes.ts';
import { STOPS, VIEWPORTS, fixture, settle, visit } from './lib/shots.ts';

// RTL is a switch away (control-tower phase 31). The kit and the shell set
// their spacing, insets, borders and alignment in LOGICAL properties
// (`ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`, `margin-inline-*` —
// `client/src/styles/logical.test.ts` holds them there), so flipping `dir` on
// the document mirrors the page rather than breaking it. The proof is the
// tour's home stop — the first stop, the Tower — measured with `dir="rtl"`:
// nothing slides past the viewport's edge, nothing escapes `<main>`, and the
// document is no wider than the screen, in every viewport.

const HOME = STOPS[0];

test('with dir="rtl" the home stop mirrors and nothing overflows', async ({ page }, info) => {
  const viewport = VIEWPORTS.find((v) => v.name === info.project.name);
  if (!viewport) throw new Error(`no viewport named ${info.project.name}`);
  const fx = await fixture();
  await visit(page, HOME, fx.anchor);
  await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
  await settle(page);

  // The switch took: the document and the shell really are right-to-left.
  const dir = await page.evaluate(() => ({
    doc: getComputedStyle(document.documentElement).direction,
    main: getComputedStyle(document.querySelector('main')!).direction,
  }));
  expect(dir).toEqual({ doc: 'rtl', main: 'rtl' });

  const width = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(width.scroll, `${viewport.name}: the document is wider than the screen in RTL`).toBeLessThanOrEqual(
    width.client,
  );

  const found = (await layoutFindings(page, { touch: viewport.touch })).filter(
    (f) => f.cls === 'overflow' || f.cls === 'escape',
  );
  expect(found, `${viewport.name}: overflow in RTL`).toEqual([]);
});

// A guide carries its language (control-tower phase 137, §Architecture 19
// "Language"): the fixture's Persian item is drawn right-to-left inside a
// left-to-right page, its command left-to-right, its inline code and its
// numbers isolated so they keep their own order — and still nothing overflows.
test('a Persian guide on Your turn is right-to-left, its command and numbers left-to-right', async ({
  page,
}, info) => {
  const viewport = VIEWPORTS.find((v) => v.name === info.project.name);
  if (!viewport) throw new Error(`no viewport named ${info.project.name}`);
  const fx = await fixture();
  await visit(page, { name: 'turn-rtl', hash: '#/turn/turn-now-fa' }, fx.anchor);
  const guide = page.locator('[data-item="turn-now-fa"] [data-testid="turn-guide"]');
  await expect(guide).toHaveAttribute('dir', 'rtl');
  await expect(guide).toHaveAttribute('lang', 'fa');
  const read = await guide.evaluate((el) => ({
    guide: getComputedStyle(el).direction,
    command: getComputedStyle(el.querySelector('[data-testid="guide-command"]')!).direction,
    code: [...el.querySelectorAll('code')].every((code) => getComputedStyle(code).direction === 'ltr'),
    number: [...el.querySelectorAll('bdi[dir="ltr"]')].some((bdi) => /\d/.test(bdi.textContent ?? '')),
  }));
  expect(read).toEqual({ guide: 'rtl', command: 'ltr', code: true, number: true });
  const found = (await layoutFindings(page, { touch: viewport.touch })).filter(
    (f) => f.cls === 'overflow' || f.cls === 'escape',
  );
  expect(found, `${viewport.name}: overflow on the Persian item`).toEqual([]);
});
