import { expect, test } from '@playwright/test';

import { STOPS, fixture, shoot, visit } from './lib/shots.ts';

// The tour: every destination `shared/route-meta.js` declares, every plan tab,
// `#/approve` and the three overlays, in all four viewports — rendered without
// an uncaught error or a fallen error boundary, and photographed. The pictures
// (`e2e/.shots/<viewport>/<stop>.png`) are never compared by pixel; they are
// for the session that changed a page to open and READ.

for (const stop of STOPS) {
  test(`tour: ${stop.name}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    const fx = await fixture();
    await visit(page, stop, fx.anchor);

    await expect(page.locator('main').first()).toBeVisible();
    if (stop.overlay) await expect(page.getByRole('dialog').first()).toBeVisible();
    await expect(page.getByText(/could not be shown/), 'an error boundary caught this page').toHaveCount(0);
    await shoot(page, info.project.name, stop.name);
    expect(errors, `uncaught errors on ${stop.hash}`).toEqual([]);
  });
}
