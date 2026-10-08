/**
 * Your turn in a real browser (control-tower phase 137, #214, exit criterion 8).
 *
 * The register measures `#/turn` as it opens, at every viewport — overflow,
 * escape, the touch floors, axe in both themes, the focus walk on the desks.
 * This spec measures what only the turn has, on the fixture's own items
 * (`seedTurn`: one in every group), at all four viewports:
 *
 *   - every seeded item is in its group, and the groups are in the page's order;
 *   - every primary action wins `elementFromPoint` at its own centre, and is a
 *     thumb tall on touch;
 *   - the long command scrolls inside its own block: the block is no wider than
 *     its card, it scrolls, and the document never does;
 *   - with *Done* and the handled log unfolded, axe finds nothing in light and
 *     dark, nothing overflows, and on the desks the focus walk finds nothing;
 *   - the permission card (phase 138, #215): on a phone its scopes stack, the
 *     typed rule sits above where a keyboard rises, and once typed, Grant wins
 *     its own centre — nothing overflows;
 *   - Settings ▸ Permissions opens at the grant the `granted` push names, its
 *     Revoke wins its centre, and nothing overflows.
 */

import { expect, test, type Page } from '@playwright/test';

import { axeFindings, focusFindings, layoutFindings, still } from './lib/probes.ts';
import { VIEWPORTS, fixture, shoot, visit } from './lib/shots.ts';

const ORDER = ['now', 'decide', 'upcoming', 'checking', 'done', 'handled'];

/** Unfold what the page folds: *Done* and the handled log. */
async function unfold(page: Page): Promise<void> {
  for (const name of [/What was settled/, /What the AI handled/]) {
    const button = page.getByRole('button', { name });
    if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  }
  await still(page);
}

test('every group holds its item, in order, and every primary wins its own centre', async ({
  page,
}, info) => {
  const viewport = VIEWPORTS.find((v) => v.name === info.project.name);
  if (!viewport) throw new Error(`no viewport named ${info.project.name}`);
  const fx = await fixture();
  await visit(page, { name: 'turn-items', hash: '#/turn' }, fx.anchor);

  const sections = await page
    .getByTestId('turn-section')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-section')));
  expect(sections).toEqual(ORDER);

  await unfold(page);
  for (const seeded of fx.turn) {
    const item = page.locator(
      `[data-testid="turn-section"][data-section="${seeded.group}"] [data-testid="turn-item"][data-item="${seeded.id}"]`,
    );
    await expect(item, `${seeded.id} in ${seeded.group}`).toHaveCount(1);
  }

  const primaries = page.getByTestId('turn-primary');
  const count = await primaries.count();
  expect(count, 'Do now and the decision each lead with one primary').toBeGreaterThanOrEqual(4);
  for (let index = 0; index < count; index++) {
    const primary = primaries.nth(index);
    // A disabled primary is no target — *Send my answer* before anything is
    // chosen (the kit's disabled button takes no pointer events).
    if (await primary.isDisabled()) continue;
    await primary.scrollIntoViewIfNeeded();
    await still(page);
    const wins = await primary.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { hit: Boolean(hit && (hit === el || el.contains(hit))), height: r.height };
    });
    expect(wins.hit, `primary ${index} wins its own centre`).toBe(true);
    if (viewport.touch) expect(wins.height, `primary ${index} is a thumb tall`).toBeGreaterThanOrEqual(44);
  }
});

test('a long command scrolls inside its card, never the page', async ({ page }, info) => {
  const viewport = VIEWPORTS.find((v) => v.name === info.project.name);
  if (!viewport) throw new Error(`no viewport named ${info.project.name}`);
  const fx = await fixture();
  await visit(page, { name: 'turn-command', hash: '#/turn/turn-now-signin' }, fx.anchor);
  const card = page.locator('[data-testid="turn-item"][data-item="turn-now-signin"]');
  const command = card.getByTestId('guide-command').first();
  await command.scrollIntoViewIfNeeded();
  const box = await command.evaluate((el) => {
    const card = el.closest('[data-testid="turn-item"]')!;
    const before = el.scrollLeft;
    el.scrollLeft = 80;
    const scrolled = el.scrollLeft > before;
    return {
      inside: el.getBoundingClientRect().right <= card.getBoundingClientRect().right + 0.5,
      wider: el.scrollWidth > el.clientWidth,
      scrolled,
      overflowX: getComputedStyle(el).overflowX,
      page: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    };
  });
  expect(box.inside, 'the command block stays inside its card').toBe(true);
  expect(box.page, 'the document never scrolls sideways').toBe(true);
  expect(box.overflowX).toBe('auto');
  // On a phone the command is wider than its card, and it is the block that scrolls.
  if (viewport.name === 'phone-360') expect([box.wider, box.scrolled]).toEqual([true, true]);
});

test('unfolded, the page holds: axe light and dark, no overflow, the focus walk on the desks', async ({
  page,
}, info) => {
  const viewport = VIEWPORTS.find((v) => v.name === info.project.name);
  if (!viewport) throw new Error(`no viewport named ${info.project.name}`);
  const fx = await fixture();
  await visit(page, { name: 'turn-open', hash: '#/turn' }, fx.anchor);
  await unfold(page);
  const layout = (await layoutFindings(page, { touch: viewport.touch })).filter(
    (f) => f.cls === 'overflow' || f.cls === 'escape',
  );
  expect(layout, `${viewport.name}: overflow with everything unfolded`).toEqual([]);
  expect(await axeFindings(page, 'light'), 'axe, light').toEqual([]);
  expect(await axeFindings(page, 'dark'), 'axe, dark').toEqual([]);
  await page.emulateMedia({ colorScheme: 'light' });
  if (!viewport.touch) expect(await focusFindings(page, 40), 'the focus walk').toEqual([]);
  await page.evaluate(() => document.querySelector('main')?.scrollTo(0, 0));
  await still(page);
  await shoot(page, info.project.name, 'turn-open');
});

/** A control wins its own centre, and on touch is a thumb tall. */
async function wins(page: Page, locator: ReturnType<Page['locator']>, touch: boolean, what: string) {
  await locator.scrollIntoViewIfNeeded();
  await still(page);
  const hit = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { hit: Boolean(top && (top === el || el.contains(top))), height: r.height };
  });
  expect(hit.hit, `${what} wins its own centre`).toBe(true);
  if (touch) expect(hit.height, `${what} is a thumb tall`).toBeGreaterThanOrEqual(44);
}

test('the permission card: the scopes stack on a phone, the typed rule sits above the keyboard, Grant wins once typed', async ({
  page,
}, info) => {
  const viewport = VIEWPORTS.find((v) => v.name === info.project.name);
  if (!viewport) throw new Error(`no viewport named ${info.project.name}`);
  const fx = await fixture();
  await visit(page, { name: 'turn-permit', hash: '#/turn/turn-permit' }, fx.anchor);
  const card = page.locator('[data-testid="turn-item"][data-item="turn-permit"]');
  const scopes = card.getByTestId('grant-scope');
  await expect(scopes).toHaveCount(5);
  const edge = await card.evaluate((el) => el.getBoundingClientRect().right);
  const boxes = await scopes.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right };
    }),
  );
  for (const box of boxes)
    expect(box.right, 'every scope stays inside its card').toBeLessThanOrEqual(edge + 0.5);
  if (viewport.name === 'phone-360') {
    for (let index = 1; index < boxes.length; index++) {
      expect(boxes[index]!.top, 'on a phone the scopes stack').toBeGreaterThan(boxes[index - 1]!.top);
      expect(Math.abs(boxes[index]!.left - boxes[0]!.left)).toBeLessThan(1);
    }
  }

  const typed = card.getByTestId('grant-typed');
  await typed.focus();
  await still(page);
  const at = await typed.evaluate((el) => ({
    bottom: el.getBoundingClientRect().bottom,
    height: window.innerHeight,
  }));
  if (viewport.touch) {
    expect(at.bottom, 'the typed rule sits above where a keyboard rises').toBeLessThanOrEqual(
      at.height * 0.6,
    );
  }
  const grant = card.getByTestId('turn-primary');
  await expect(grant).toBeDisabled();
  await typed.fill((await card.getByTestId('grant-rule').textContent()) ?? '');
  await expect(grant).toBeEnabled();
  await wins(page, grant, viewport.touch, 'Grant');

  const layout = (await layoutFindings(page, { touch: viewport.touch })).filter(
    (f) => f.cls === 'overflow' || f.cls === 'escape',
  );
  expect(layout, `${viewport.name}: overflow on the permission card`).toEqual([]);
  await shoot(page, info.project.name, 'turn-permit');
});

test('Settings ▸ Permissions opens at the granted push’s grant, and holds on a phone', async ({
  page,
}, info) => {
  const viewport = VIEWPORTS.find((v) => v.name === info.project.name);
  if (!viewport) throw new Error(`no viewport named ${info.project.name}`);
  const fx = await fixture();
  await visit(
    page,
    { name: 'settings-permissions', hash: '#/settings/permissions?grant=g-e2e0permit0' },
    fx.anchor,
  );
  const row = page.locator('[data-testid="grant-row"][data-grant="g-e2e0permit0"]');
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('owner-keys-card')).toBeVisible();
  await wins(page, row.getByRole('button', { name: 'Revoke' }), viewport.touch, 'Revoke');
  const layout = (await layoutFindings(page, { touch: viewport.touch })).filter(
    (f) => f.cls === 'overflow' || f.cls === 'escape',
  );
  expect(layout, `${viewport.name}: overflow on Settings ▸ Permissions`).toEqual([]);
  expect(await axeFindings(page, 'light'), 'axe, light').toEqual([]);
  expect(await axeFindings(page, 'dark'), 'axe, dark').toEqual([]);
  await page.emulateMedia({ colorScheme: 'light' });
  await shoot(page, info.project.name, 'settings-permissions');
});
