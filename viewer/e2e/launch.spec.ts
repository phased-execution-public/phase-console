/**
 * Starting a run on a phone (control-tower phase 22, criterion 6).
 *
 * The launch is one screen now — the quick view — and on a phone it is a
 * full-height sheet: ONE scroller (the sheet's body; a tile pushes its
 * controls as a sub-view inside it, never a second scroller), a footer that
 * does not move when the body scrolls, and a Launch button that still wins
 * its hit test once the keyboard is up. The keyboard is the visual viewport
 * shrinking under a focused field: `--app-height` follows it
 * (`installAppHeight`), and the sheet is exactly that tall, so the footer
 * rides on the keyboard's upper edge.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { still } from './lib/probes.ts';
import { fixture, shotPath, visit } from './lib/shots.ts';

const PHONE = 'phone-360';

/** Every element inside `root` that is scrolling content right now. */
async function scrollers(root: Locator): Promise<string[]> {
  return root.evaluate((el) =>
    [el, ...el.querySelectorAll('*')]
      .filter((node) => {
        const style = getComputedStyle(node);
        return /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
      })
      .map(
        (node) =>
          `${node.tagName.toLowerCase()}.${(node.getAttribute('class') ?? '').split(' ').slice(0, 3).join('.')}`,
      ),
  );
}

/**
 * Does a tap at the centre of `target` land on it (or inside it)?
 *
 * Asked only of an ENABLED target: a disabled button takes no pointer events,
 * so `elementFromPoint` answers its parent row and the hit test measures
 * nothing. Launch stays disabled while the plan's decisions are read ("Reading
 * this plan's decisions…"), and under a full gate's load that read lands after
 * the sheet is drawn — red in 2 of 2 gates at control-tower phase 124, green
 * alone. So wait for the read to land, not for the clock.
 */
async function wins(page: Page, target: Locator): Promise<{ wins: boolean; what: string }> {
  await expect(target).toBeEnabled();
  await still(page);
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      wins: Boolean(top && (top === el || el.contains(top))),
      what: top ? top.outerHTML.replace(/\s+/g, ' ').slice(0, 160) : 'nothing',
    };
  });
}

test('a phone launch is one scroller under a fixed footer, and Launch wins its tap with the keyboard up', async ({
  page,
}, info) => {
  test.skip(info.project.name !== PHONE, 'the thumb is a phone’s question');
  const fx = await fixture();
  // `quiet` is the seeded plan an operator paused: its run page offers the
  // launch that picks it up — a staged launch, preset row and all.
  await visit(page, { name: 'launch-phone', hash: '#/plan/quiet/run' }, fx.anchor);
  await page
    .getByRole('button', { name: /^(Continue this run|Start a run)$/ })
    .first()
    .click();

  const sheet = page.getByRole('dialog');
  await expect(sheet.getByTestId('quick-view')).toBeVisible();
  const launch = sheet.getByTestId('launch-submit');
  await expect(launch).toBeVisible();
  await still(page);
  await page.screenshot({ path: shotPath(info.project.name, 'launch-quick') });

  // One scroller: the sheet's body, and nothing inside it.
  await still(page);
  const list = await scrollers(sheet);
  expect(list.length, `scrolling: ${list.join(' | ')}`).toBeLessThanOrEqual(1);

  // A fixed footer: scrolling the body to its end moves the tiles, not Launch.
  const before = await launch.boundingBox();
  await sheet.getByTestId('quick-view').evaluate((el) => {
    let node: Element | null = el;
    while (node && getComputedStyle(node).overflowY !== 'auto') node = node.parentElement;
    if (node) node.scrollTop = node.scrollHeight;
  });
  await still(page);
  const after = await launch.boundingBox();
  expect(Math.round(after!.y)).toBe(Math.round(before!.y));
  const scrolled = await wins(page, launch);
  expect(scrolled.wins, `after the scroll the tap lands on ${scrolled.what}`).toBe(true);

  // A tile pushes its controls inside the same scroller…
  await sheet.getByRole('button', { name: /^(Edit|Answer) Money and stops$/ }).click();
  await expect(sheet.getByTestId('tile-subview')).toBeVisible();
  expect((await scrollers(sheet)).length).toBeLessThanOrEqual(1);

  // …and with a field focused and the keyboard up, Launch still takes the tap.
  const budget = sheet.getByLabel(/Budget for the run/);
  await budget.focus();
  await page.setViewportSize({ width: 360, height: 420 });
  await still(page);
  const box = await launch.boundingBox();
  expect(box, 'Launch is on screen').toBeTruthy();
  expect(box!.y + box!.height, 'Launch sits above the keyboard').toBeLessThanOrEqual(420);
  const hit = await wins(page, launch);
  expect(hit.wins, `the tap lands on ${hit.what}`).toBe(true);
  await expect(budget).toBeFocused();

  // Back to the list, same sheet, same footer.
  await sheet.getByRole('button', { name: 'All settings' }).click();
  await expect(sheet.getByTestId('quick-view')).toBeVisible();
  await page.setViewportSize({ width: 360, height: 740 });
});

test('on a desk the quick view is one screen of tiles, one open at a time, under one ink Launch', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desk-1280', 'the desk layout is asked once');
  const fx = await fixture();
  await visit(page, { name: 'launch-desk', hash: '#/plan/quiet/run' }, fx.anchor);
  await page
    .getByRole('button', { name: /^(Continue this run|Start a run)$/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('quick-view')).toBeVisible();
  await still(page);
  await page.screenshot({ path: shotPath(info.project.name, 'launch-quick') });
  await dialog.getByRole('button', { name: /^(Edit|Answer) Git$/ }).click();
  await expect(dialog.getByRole('region', { name: 'Git' })).toBeVisible();
  await dialog.getByRole('button', { name: /^(Edit|Answer) Engine$/ }).click();
  await expect(dialog.getByRole('region', { name: 'Git' })).toHaveCount(0);
  await expect(dialog.getByRole('region', { name: 'Engine' })).toBeVisible();
  await still(page);
  await page.screenshot({ path: shotPath(info.project.name, 'launch-quick-open') });
  // The one primary: Launch, and nothing else in the dialog painted like it.
  const solid = await dialog.evaluate((root) => {
    const launch = root.querySelector('[data-testid="launch-submit"]');
    const bg = launch ? getComputedStyle(launch).backgroundColor : '';
    return [...root.querySelectorAll('button')].filter((b) => getComputedStyle(b).backgroundColor === bg)
      .length;
  });
  expect(solid).toBe(1);
});
