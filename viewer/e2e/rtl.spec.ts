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
