/**
 * The Runs home in a real layout engine (7.0, quiet-console phase 7; the Tower
 * since control-tower phase 20, exit criterion 5): no overflow in any of the
 * four projects — the groups, the lamps in the toolbar's Filter slot and the
 * rows, with Settled opened and a lamp pressed — and on a phone the groups
 * STACK, one under the other at the width of the page, with each row's one
 * action at its foot and the width of the row: the thumb's zone
 * (§Architecture 5's phone wireframe).
 *
 * The fixture seeds a stopped run for every halt family (`fixture/seed.ts`)
 * and one live run (`stub-claude.mjs`), so every group the page draws has
 * something real in it. Screenshots land in `e2e/.shots/<project>/tower*.png`
 * for the building session to read — never pixel-diffed.
 */

import { expect, test, type Page } from '@playwright/test';

import { BAYS } from '../shared/bays.js';
import { layoutFindings, still } from './lib/probes.ts';
import { fixture, shoot, visit } from './lib/shots.ts';

const PHONE = 'phone-360';

/** Only the two classes this criterion is about: sideways scroll and a clipped escape. */
async function escapes(page: Page, touch: boolean) {
  return (await layoutFindings(page, { touch })).filter((f) => f.cls === 'overflow' || f.cls === 'escape');
}

/**
 * The lamps are the toolbar's Filter slot (7.0): a popover under the Filter
 * word on a desk, a section of the one View sheet below 900 px (`ui/toolbar`).
 * Open it before reading a lamp — it is gone from the DOM while closed — and
 * put it away before measuring the page a person sees after choosing.
 */
async function openFilter(page: Page): Promise<void> {
  const phone = (page.viewportSize()?.width ?? 0) < 900;
  await page.locator(phone ? '[data-slot="view-sheet"]' : '[data-slot="filter"]').click();
  await expect(page.getByTestId('annunciator')).toBeVisible();
}

/** Escape dismisses the popover and the sheet alike. */
async function closeFilter(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('annunciator')).toHaveCount(0);
}

test('the Runs home stays inside main in every project — groups, lamps, rows, Settled open', async ({
  page,
}, info) => {
  const fx = await fixture();
  const touch = info.project.name === PHONE || info.project.name.startsWith('tablet');

  await visit(page, { name: 'tower', hash: '#/runs?view=groups' }, fx.anchor);
  await expect(page.getByTestId('runs-home')).toBeVisible();
  const order = await page
    .getByTestId('bay')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-bay')));
  expect(order, 'every group, most urgent first').toEqual([...BAYS]);
  expect(await escapes(page, touch)).toEqual([]);
  await shoot(page, info.project.name, 'tower');

  // Settled opened in place: still nothing escapes.
  const toggle = page.getByTestId('settled-toggle');
  if ((await toggle.count()) && (await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
    await still(page);
  }
  expect(await escapes(page, touch)).toEqual([]);

  // The seed stops a run in several families: the Filter has lamps lit — and
  // the panel they sit in holds its nine words at every width.
  await openFilter(page);
  const lit = page.locator('[data-testid="lamp"][data-lit="true"]');
  await expect(lit.first(), 'the seed stops runs in several families').toBeVisible();
  expect(await escapes(page, touch)).toEqual([]);

  // A lit lamp pressed and the panel put away: the groups narrow, and the note says so.
  await lit.first().click();
  await closeFilter(page);
  await still(page);
  await expect(page.getByTestId('tower-filtered')).toBeVisible();
  expect(await escapes(page, touch)).toEqual([]);
  await shoot(page, info.project.name, 'tower-filtered');
});

test('on a phone the groups stack, and each row’s one action is at its foot, full width', async ({
  page,
}, info) => {
  test.skip(info.project.name !== PHONE, 'the thumb is a phone’s question');
  const fx = await fixture();
  await visit(page, { name: 'tower-phone', hash: '#/runs?view=groups' }, fx.anchor);
  await expect(page.getByTestId('runs-home')).toBeVisible();

  const boxes = await page.getByTestId('bay').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { bay: el.getAttribute('data-bay'), left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    }),
  );
  const main = await page.locator('main').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right };
  });
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i]!;
    expect(box.left, `${box.bay} starts at the page's edge`).toBeGreaterThanOrEqual(main.left - 0.5);
    expect(box.right, `${box.bay} ends inside the page`).toBeLessThanOrEqual(main.right + 0.5);
    if (i > 0)
      expect(box.top, `${box.bay} sits under ${boxes[i - 1]!.bay}`).toBeGreaterThanOrEqual(
        boxes[i - 1]!.bottom - 0.5,
      );
  }

  const rows = page.locator('[data-strip]');
  expect(await rows.count(), 'the fixture puts rows in the groups').toBeGreaterThan(0);
  const row = rows.first();
  const action = row.getByTestId('strip-action');
  await action.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
  await still(page);
  const geometry = await row.evaluate((el) => {
    const act = el.querySelector('[data-testid="strip-action"]')!.getBoundingClientRect();
    const name = el.querySelector('[data-testid="strip-name"]')!.getBoundingClientRect();
    const own = el.getBoundingClientRect();
    const hit = document.elementFromPoint(act.left + act.width / 2, act.top + act.height / 2);
    const target = el.querySelector('[data-testid="strip-action"]')!;
    return {
      share: act.width / own.width,
      height: act.height,
      belowName: act.top >= name.bottom - 0.5,
      wins: Boolean(hit && (hit === target || target.contains(hit))),
      what: hit ? hit.outerHTML.replace(/\s+/g, ' ').slice(0, 160) : 'nothing',
    };
  });
  expect(geometry.share, 'the action spans the row — reachable by either thumb').toBeGreaterThanOrEqual(0.6);
  expect(geometry.height, 'a thumb’s height on a touch screen').toBeGreaterThanOrEqual(44);
  expect(geometry.belowName, 'at the foot of the row, under its name').toBe(true);
  expect(geometry.wins, `the tap lands on ${geometry.what}`).toBe(true);
  await shoot(page, info.project.name, 'tower-thumb');
});

/*
 * The Your turn group holds the ACTS, one line each (7.0, quiet-console phase
 * 7; control-tower phase 139, #216): its number is its items, and no run sits
 * in it — a run a person's turn summons keeps the group of what it is, wearing
 * the summons on its row — and the group's one line opens the page, as the
 * situation line's *Your turn (n)* does on a desk. The fixture seeds the items
 * on a phase of the live plan that no run is on (`seedTurn`), so the group is
 * never empty and the live run is the one they summon; the numbers are read
 * off the page, never written down.
 */
test('the Your turn group holds items, not rows — its count is its items, the summoned run keeps its group, and one line opens the page', async ({
  page,
}, info) => {
  const fx = await fixture();
  await visit(page, { name: 'tower-turn', hash: '#/runs?view=groups' }, fx.anchor);
  const turn = page.locator('[data-testid="bay"][data-bay="needs-you"]');
  await expect(turn).toBeVisible();
  // The group counts its items: its number is its item rows, and no run row is among them.
  const count = Number(await turn.getAttribute('data-count'));
  expect(count, 'the seed puts items in Your turn').toBeGreaterThan(0);
  await expect(turn.getByTestId('item-row')).toHaveCount(count);
  // Each row says the card's words (turn-by-turn phase 10): NOW and the type,
  // then the composer's title — every row here is due, so every row says Now.
  const words = turn.locator('[data-testid="item-row"] [data-testid="turn-row-words"]');
  await expect(words).toHaveCount(count);
  expect(
    new Set(await words.evaluateAll((els) => els.map((el) => el.getAttribute('data-readiness')))),
  ).toEqual(new Set(['now']));
  expect(
    (await words.evaluateAll((els) => els.map((el) => el.getAttribute('data-type')))).every((t) =>
      ['approve', 'do', 'decide'].includes(String(t)),
    ),
  ).toBe(true);
  await expect(turn.locator('[data-strip]')).toHaveCount(0);
  // The run the items summon sits in Running, wearing the summons on its row.
  expect(fx.live, `the fixture's run must be live for Running to hold it (${fx.why ?? ''})`).toBe(true);
  const summoned = page.locator(`[data-strip][data-slug="${fx.tourPlan}"]`).first();
  await expect(summoned).toHaveAttribute('data-bay', 'needs-you');
  await expect(summoned).toHaveAttribute('data-group', 'live');
  const line = turn.getByTestId('bay-turn');
  await expect(line).toHaveAttribute('href', '#/turn');
  await expect(line).toContainText(/^Open Your turn/);
  // The header line holds every part at a desk's width; narrower, it clips from the end.
  if (info.project.name === 'desk-1280') {
    const part = page.getByTestId('situation-line').getByRole('link', { name: /^Your turn \(\d+\)$/ });
    await expect(part).toHaveAttribute('href', '#/turn');
  }
  await line.click();
  await expect(page.getByTestId('turn-item').first()).toBeVisible();
});
