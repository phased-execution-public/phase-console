/**
 * The Tower in a real layout engine (control-tower phase 20, exit criterion
 * 5): no overflow in any of the four projects — the bays, the annunciator and
 * the strips, with Settled opened and a lamp pressed — and on a phone the bays
 * STACK, one under the other at the width of the page, with each strip's one
 * action at its foot and the width of the strip: the thumb's zone
 * (§Architecture 5's phone wireframe).
 *
 * The fixture seeds a stopped run for every halt family (`fixture/seed.ts`)
 * and one live run (`stub-claude.mjs`), so every bay the page draws has
 * something real in it. Screenshots land in `e2e/.shots/<project>/tower*.png`
 * for the building session to read — never pixel-diffed.
 */

import { expect, test, type Page } from '@playwright/test';

import { BAYS } from '../shared/status-model.js';
import { layoutFindings, still } from './lib/probes.ts';
import { fixture, shoot, visit } from './lib/shots.ts';

const PHONE = 'phone-360';

/** Only the two classes this criterion is about: sideways scroll and a clipped escape. */
async function escapes(page: Page, touch: boolean) {
  return (await layoutFindings(page, { touch })).filter((f) => f.cls === 'overflow' || f.cls === 'escape');
}

test('the Tower stays inside main in every project — bays, lamps, strips, Settled open', async ({
  page,
}, info) => {
  const fx = await fixture();
  const touch = info.project.name === PHONE || info.project.name.startsWith('tablet');

  await visit(page, { name: 'tower', hash: '#/runs?view=board' }, fx.anchor);
  await expect(page.getByTestId('tower')).toBeVisible();
  const order = await page
    .getByTestId('bay')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-bay')));
  expect(order, 'every bay, most urgent first').toEqual([...BAYS]);
  // The seed stops a run in several families: the annunciator has lamps lit.
  expect(await page.locator('[data-testid="lamp"][data-lit="true"]').count()).toBeGreaterThan(0);
  expect(await escapes(page, touch)).toEqual([]);
  await shoot(page, info.project.name, 'tower');

  // Settled opened in place, then a lit lamp pressed: still nothing escapes.
  const settled = page.locator('[data-testid="bay"][data-bay="settled"]');
  const show = settled.getByRole('button', { name: /^Show / });
  if (await show.count()) {
    await show.click();
    await still(page);
  }
  expect(await escapes(page, touch)).toEqual([]);

  await page.locator('[data-testid="lamp"][data-lit="true"]').first().click();
  await still(page);
  await expect(page.getByTestId('tower-filtered')).toBeVisible();
  expect(await escapes(page, touch)).toEqual([]);
  await shoot(page, info.project.name, 'tower-filtered');
});

test('on a phone the bays stack, and each strip’s one action is at its foot, full width', async ({
  page,
}, info) => {
  test.skip(info.project.name !== PHONE, 'the thumb is a phone’s question');
  const fx = await fixture();
  await visit(page, { name: 'tower-phone', hash: '#/runs?view=board' }, fx.anchor);
  await expect(page.getByTestId('tower')).toBeVisible();

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

  const strips = page.locator('[data-strip]');
  expect(await strips.count(), 'the fixture puts strips in the bays').toBeGreaterThan(0);
  const strip = strips.first();
  const action = strip.getByTestId('strip-action');
  await action.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
  await still(page);
  const geometry = await strip.evaluate((el) => {
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
  expect(geometry.share, 'the action spans the strip — reachable by either thumb').toBeGreaterThanOrEqual(
    0.6,
  );
  expect(geometry.height, 'a thumb’s height on a touch screen').toBeGreaterThanOrEqual(44);
  expect(geometry.belowName, 'at the foot of the strip, under its name').toBe(true);
  expect(geometry.wins, `the tap lands on ${geometry.what}`).toBe(true);
  await shoot(page, info.project.name, 'tower-thumb');
});

/*
 * The Needs-you bay keeps runs (control-tower phase 139, #216, exit criterion
 * 2): no loose rows — the asks no strip draws are items of Your turn, which
 * the bay links to in one line, and the situation line's *Your turn (n)*
 * counts items and opens the page. The fixture seeds Your turn's items on a
 * phase no run is on (`seedTurn`), so the line is there; the numbers are read
 * off the page, never written down.
 */
test('the Needs-you bay keeps runs — no loose rows, one line to Your turn, which the situation line opens too', async ({
  page,
}, info) => {
  const fx = await fixture();
  await visit(page, { name: 'tower-turn', hash: '#/runs?view=board' }, fx.anchor);
  const needs = page.locator('[data-testid="bay"][data-bay="needs-you"]');
  await expect(needs).toBeVisible();
  await expect(needs.getByTestId('bay-inbox')).toHaveCount(0);
  await expect(needs.getByTestId('coming-up')).toHaveCount(0);
  // The bay counts runs: its number is its strips.
  const count = Number(await needs.getAttribute('data-count'));
  expect(await needs.locator('[data-strip]').count()).toBe(count);
  const line = needs.getByTestId('bay-turn');
  await expect(line).toHaveAttribute('href', '#/turn');
  await expect(line).toContainText(/^Your turn: \d+ needs? you/);
  // The header line holds every part at a desk's width; narrower, it clips from the end.
  if (info.project.name === 'desk-1280') {
    const part = page.getByTestId('situation-line').getByRole('link', { name: /^Your turn \(\d+\)$/ });
    await expect(part).toHaveAttribute('href', '#/turn');
  }
  await line.click();
  await expect(page.getByTestId('turn-item').first()).toBeVisible();
});
