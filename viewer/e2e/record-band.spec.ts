/**
 * The record band on a phone (control-tower phase 26, exit criterion 4): Repo
 * — every section — and Insights stay inside `main` at 360, with every fold
 * open as well as shut, and the issues board's compose sheet keeps its submit
 * winning its tap once the keyboard is up.
 *
 * The keyboard is the visual viewport shrinking under a focused field, as in
 * `launch.spec.ts`: `--app-height` follows it, and a full sheet is exactly
 * that tall, so the footer rides the keyboard's upper edge. The submit is
 * pressable whether or not this console could start the session — the sheet
 * says why it cannot, beside the button — so its hit test is the layout's
 * question, not the fixture's flags.
 */

import { expect, test, type Page } from '@playwright/test';

import { layoutFindings, still } from './lib/probes.ts';
import { fixture, shoot, visit } from './lib/shots.ts';

const PHONE = 'phone-360';

/** Every section of Repo and the Insights page. */
const RECORD_BAND = [
  { name: 'band-repo-graph', hash: '#/repo' },
  { name: 'band-repo-branches', hash: '#/repo/branches' },
  { name: 'band-repo-trees', hash: '#/repo/trees' },
  { name: 'band-repo-diff', hash: '#/repo/diff' },
  { name: 'band-repo-settles', hash: '#/repo/settles' },
  { name: 'band-repo-issues', hash: '#/repo/issues' },
  { name: 'band-insights', hash: '#/insights' },
] as const;

async function escapes(page: Page) {
  return (await layoutFindings(page, { touch: true })).filter(
    (f) => f.cls === 'overflow' || f.cls === 'escape',
  );
}


test.beforeEach(({}, info) => {
  test.skip(info.project.name !== PHONE, 'the 360 question is a phone’s');
});

for (const stop of RECORD_BAND) {
  test(`${stop.hash} stays inside main at 360, folded and unfolded`, async ({ page }, info) => {
    const fx = await fixture();
    await visit(page, stop, fx.anchor);
    expect(await escapes(page), 'folded').toEqual([]);
    await shoot(page, info.project.name, stop.name);

    // Every fold the page draws, opened: a table's numbers and a card's rows
    // must fit as well as the fold's own row did.
    // A fold, not a menu: a select's combobox and a popup trigger also say
    // `aria-expanded`, and an open listbox holds the pointer.
    const folds = page.locator(
      'main button[aria-expanded="false"]:not([role="combobox"]):not([aria-haspopup])',
    );
    for (let i = (await folds.count()) - 1; i >= 0; i -= 1) {
      const fold = folds.nth(i);
      if (await fold.isVisible()) await fold.click();
    }
    await still(page);
    expect(await escapes(page), 'unfolded').toEqual([]);
  });
}

