/**
 * On a phone, the button a halt card recommends is the one a thumb reaches
 * (control-tower phase 17, criterion 7).
 *
 * The seed (`e2e/fixture/seed.ts`) stops one plan in each of the nine
 * families of §Architecture 4 — halted, parked or interrupted the way the
 * runner writes that kind. For each, the run page is opened at 360 × 740,
 * the recommended button is brought to the middle of the screen, and
 * `document.elementFromPoint` at its centre must answer the button itself (or
 * something inside it): not a sticky bar, not a toast, not a neighbour's
 * overhanging tap area. A card that recommends a button a phone cannot press
 * has recommended nothing.
 */

import { expect, test } from '@playwright/test';

import { HALT_KIND_CATEGORY } from '../shared/halt-categories.js';
import { still } from './lib/probes.ts';
import { fixture, visit } from './lib/shots.ts';

const PHONE = 'phone-360';

/** Seeded plan → the family its stop is in. */
const SEEDED: Readonly<Record<string, string>> = {
  decide: 'decision',
  signin: 'credentials',
  limits: 'limits',
  network: 'environment',
  repair: 'plan',
  verify: 'verification',
  external: 'external',
  restart: 'conflict',
  stopped: 'operator',
};

for (const [slug, category] of Object.entries(SEEDED)) {
  test(`${category}: the recommended button wins the tap on a phone (${slug})`, async ({ page }, info) => {
    test.skip(info.project.name !== PHONE, 'the thumb is a phone’s question');
    const fx = await fixture();
    const seeded = fx.runs.find((run) => run.slug === slug);
    expect(seeded?.halt, `the seed stops ${slug}`).toBeTruthy();
    expect(HALT_KIND_CATEGORY[seeded!.halt!], `${slug}'s stop is in the ${category} family`).toBe(category);

    await visit(page, { name: `halts-${slug}`, hash: `#/plan/${slug}/run` }, fx.anchor);
    await expect(page.locator(`[data-halt-category="${category}"]`).first()).toBeVisible();

    const button = page.getByTestId('halt-recommended').first();
    await expect(button).toBeVisible();
    await button.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
    await still(page);
    const hit = await button.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        wins: Boolean(top && (top === el || el.contains(top))),
        what: top ? top.outerHTML.replace(/\s+/g, ' ').slice(0, 160) : 'nothing',
        size: [Math.round(r.width), Math.round(r.height)],
      };
    });
    expect(hit.wins, `${slug}: the tap lands on ${hit.what}`).toBe(true);
    expect(hit.size[1], `${slug}: the recommended button is a thumb's height`).toBeGreaterThanOrEqual(28);
  });
}
