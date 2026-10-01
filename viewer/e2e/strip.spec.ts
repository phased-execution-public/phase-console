/**
 * The run strip in a real layout engine (control-tower phase 19, exit
 * criterion 5): at 360 px the name never drops under its floor, and nothing —
 * folded or expanded in place — escapes `<main>`.
 *
 * jsdom has no layout, so the two questions only a browser can answer are
 * asked here, on the fixture's LIVE run (`stub-claude.mjs`), in every project:
 * the name's box against its own `min-width` (`--strip-name-floor`, 12ch — a
 * strip whose name is squeezed to nothing is a coloured bar), and the probe's
 * `overflow` and `escape` classes (`lib/probes.ts`) over the whole page. The
 * one action must also WIN its tap on a phone, where it is the thumb's target.
 * Screenshots land in `e2e/.shots/<project>/strip*.png` for the building
 * session to read — never pixel-diffed.
 */

import { expect, test, type Page } from '@playwright/test';

import { layoutFindings, still } from './lib/probes.ts';
import { fixture, shoot, visit } from './lib/shots.ts';

const PHONE = 'phone-360';

/** Every strip's name: its box, and the floor it was given. */
async function names(page: Page) {
  return page.getByTestId('strip-name').evaluateAll((els) =>
    els.map((el) => ({
      name: el.textContent ?? '',
      width: el.getBoundingClientRect().width,
      floor: parseFloat(getComputedStyle(el).minWidth),
    })),
  );
}

/** Only the two classes this criterion is about: sideways scroll and a clipped escape. */
async function escapes(page: Page, touch: boolean) {
  return (await layoutFindings(page, { touch })).filter((f) => f.cls === 'overflow' || f.cls === 'escape');
}

test('the strip keeps its name and stays inside main, folded and expanded', async ({ page }, info) => {
  const fx = await fixture();
  expect(fx.live, `the fixture's run must be live for the board to draw a strip (${fx.why ?? ''})`).toBe(
    true,
  );
  const touch = info.project.name === PHONE || info.project.name.startsWith('tablet');

  await visit(page, { name: 'strip', hash: '#/runs' }, fx.anchor);
  const strip = page.locator('[data-strip]').first();
  await expect(strip).toBeVisible();

  const folded = await names(page);
  expect(folded.length, 'the board draws a strip for the live run').toBeGreaterThan(0);
  for (const n of folded) {
    expect(n.floor, `${n.name}: the floor is real — 12ch, never 0`).toBeGreaterThan(40);
    expect(n.width, `${n.name}: the name keeps its floor`).toBeGreaterThanOrEqual(n.floor - 0.5);
  }
  expect(await escapes(page, touch)).toEqual([]);
  await shoot(page, info.project.name, 'strip');

  // Expanded in place: the detail is inside the strip, and the strip inside main.
  await strip.getByTestId('strip-expand').click();
  await expect(strip.getByTestId('strip-detail')).toBeVisible();
  await still(page);
  for (const n of await names(page)) {
    expect(n.width, `${n.name}: expanded, the name still keeps its floor`).toBeGreaterThanOrEqual(
      n.floor - 0.5,
    );
  }
  expect(await escapes(page, touch)).toEqual([]);
  await shoot(page, info.project.name, 'strip-expanded');
});

test('the one action wins its tap on a phone', async ({ page }, info) => {
  test.skip(info.project.name !== PHONE, 'the thumb is a phone’s question');
  const fx = await fixture();
  await visit(page, { name: 'strip-action', hash: '#/runs' }, fx.anchor);
  const strip = page.locator('[data-strip]').first();
  await expect(strip).toBeVisible();
  await expect(strip.getByTestId('strip-action')).toHaveCount(1);

  const action = strip.getByTestId('strip-action');
  await action.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
  await still(page);
  const hit = await action.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      wins: Boolean(top && (top === el || el.contains(top))),
      what: top ? top.outerHTML.replace(/\s+/g, ' ').slice(0, 160) : 'nothing',
      height: Math.round(r.height),
    };
  });
  expect(hit.wins, `the tap lands on ${hit.what}`).toBe(true);
  expect(hit.height, 'a thumb’s height on a touch screen').toBeGreaterThanOrEqual(44);
});
