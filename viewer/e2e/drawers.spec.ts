/**
 * Every drawer fits its content, at every width (2026-10-20, Tower strips — the owner: "all drawers
 * of any kind must be adaptive width due to the content, and wholly compatible and responsive on
 * the mobile and tablet").
 *
 * Each drawer below is opened at all four viewports and measured as it stands:
 *
 *   - below 640 (`phone-360`) it is a bottom sheet as wide as the screen, its handle a control that
 *     grows it to the whole screen and back;
 *   - from 640 (`tablet-768`, `desk-1024`) it is an end drawer whose width sits inside the bounds
 *     of its measure (`data-sheet-size`) and never past the viewport less 2 rem — and at 1200 and
 *     up (`desk-1280`) the panel's column does the same for a Your turn card, never past 55 % of
 *     the screen;
 *   - nothing in it overflows sideways or escapes the screen (the layout probe);
 *   - the Your turn card opened from its line passes axe — contrast included — in both lights, and
 *     its primary press is on screen without scrolling the drawer.
 *
 * The pictures are `e2e/.shots/<viewport>/drawers-<drawer>.png`, for the session that changed a
 * drawer to READ, as the tour's are.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { axeFindings, layoutFindings } from './lib/probes.ts';
import { VIEWPORTS, fixture, shoot, visit, type Overlay } from './lib/shots.ts';

/** Each measure's bounds in rem (`styles/theme.css`, `[data-sheet-size]`). */
const MEASURE_REM: Readonly<Record<string, readonly [number, number]>> = {
  narrow: [20, 28],
  reading: [30, 44],
  form: [34, 52],
  wide: [44, 72],
};
const REM = 16;

function viewportOf(project: string) {
  const viewport = VIEWPORTS.find((v) => v.name === project);
  if (!viewport) throw new Error(`no viewport named ${project}`);
  return viewport;
}

/** The open drawer: a sheet the kit drew, by the side it says it stands on. */
const sheet = (page: Page): Locator => page.locator('[role="dialog"][data-sheet-side]').first();

/** A drawer's width is inside its measure's bounds, each capped by `cap` (the viewport less 2 rem, or the column's share). */
async function expectWithinMeasure(box: Locator, cap: number): Promise<void> {
  const size = (await box.getAttribute('data-sheet-size')) ?? 'reading';
  const bounds = MEASURE_REM[size];
  expect(bounds, `a known measure: ${size}`).toBeTruthy();
  const [min, max] = bounds!;
  const rect = await box.boundingBox();
  expect(rect, 'the drawer has a box').toBeTruthy();
  expect(rect!.width, `${size}: no wider than ${max} rem or its cap`).toBeLessThanOrEqual(
    Math.min(max * REM, cap) + 1,
  );
  expect(rect!.width, `${size}: no narrower than ${min} rem or its cap`).toBeGreaterThanOrEqual(
    Math.min(min * REM, cap) - 1,
  );
}

/** Nothing sideways, nothing off the screen. */
async function expectContained(page: Page, touch: boolean): Promise<void> {
  const layout = (await layoutFindings(page, { touch })).filter(
    (f) => f.cls === 'overflow' || f.cls === 'escape',
  );
  expect(layout).toEqual([]);
}

for (const [name, hash, overlay] of [
  ['help', '#/runs?help=', 'help'],
  ['inbox', '#/runs?bell=1', 'bell'],
] as const satisfies readonly (readonly [string, string, Overlay])[]) {
  test(`${name}: an end drawer fitting its content from 640, a bottom sheet below`, async ({
    page,
  }, info) => {
    const viewport = viewportOf(info.project.name);
    const fx = await fixture();
    await visit(page, { name: `drawers-${name}`, hash, overlay }, fx.anchor);
    const box = sheet(page);
    await expect(box).toBeVisible();
    if (viewport.width < 640) {
      await expect(box).toHaveAttribute('data-sheet-side', 'bottom');
      const rect = await box.boundingBox();
      expect(rect!.width, 'a bottom sheet is the width of the screen').toBeGreaterThanOrEqual(
        viewport.width - 1,
      );
      // The handle is a control: it grows the sheet to the whole screen, and back.
      const handle = box.locator('[data-sheet-handle]');
      await expect(handle).toHaveAttribute('aria-expanded', 'false');
      await handle.click();
      await expect(handle).toHaveAttribute('aria-expanded', 'true');
      const grown = await box.boundingBox();
      expect(grown!.height, 'grown, it takes the screen').toBeGreaterThan(viewport.height * 0.9);
      await handle.click();
      await expect(handle).toHaveAttribute('aria-expanded', 'false');
    } else {
      await expect(box).toHaveAttribute('data-sheet-side', 'end');
      await expectWithinMeasure(box, viewport.width - 2 * REM);
    }
    await expectContained(page, viewport.touch);
    await shoot(page, info.project.name, `drawers-${name}`);
  });
}

test('a Your turn card fits its drawer, reads in both lights, and keeps its primary on screen', async ({
  page,
}, info) => {
  const viewport = viewportOf(info.project.name);
  const fx = await fixture();
  await visit(page, { name: 'drawers-turn', hash: '#/turn' }, fx.anchor);
  const rows = page.getByTestId('turn-row');
  expect(await rows.count()).toBeGreaterThan(0);
  await rows.first().locator('[data-select]').click();
  await expect(page.getByTestId('turn-panel-card')).toBeVisible();
  const column = viewport.width >= 1200;
  const host = column ? page.locator('aside[data-panel]').first() : sheet(page);
  await expect(host).toBeVisible();
  if (column) {
    // The column fits its record: a card is a `form`, and the page beside it keeps 50 rem.
    await expect(host).toHaveAttribute('data-sheet-size', 'form');
    await expectWithinMeasure(host, Math.min(56 * REM, viewport.width - 80 - 50 * REM));
  } else if (viewport.width < 640) {
    await expect(host).toHaveAttribute('data-sheet-side', 'bottom');
  } else {
    await expect(host).toHaveAttribute('data-sheet-side', 'end');
    await expect(host).toHaveAttribute('data-sheet-size', 'form');
    await expectWithinMeasure(host, viewport.width - 2 * REM);
  }
  await expectContained(page, viewport.touch);
  // The primary is reachable where the person is: pinned in the drawer, never under its fold.
  const primary = host.getByTestId('turn-primary');
  if (await primary.count()) {
    const rect = await primary.first().boundingBox();
    expect(rect, 'the primary is drawn').toBeTruthy();
    expect(rect!.y + rect!.height, 'the primary is on screen without scrolling').toBeLessThanOrEqual(
      viewport.height + 1,
    );
  }
  const scope = column ? 'aside[data-panel]' : '[role="dialog"][data-sheet-side]';
  for (const theme of ['light', 'dark'] as const) {
    expect(await axeFindings(page, theme, scope), `axe in ${theme}`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await shoot(page, info.project.name, 'drawers-turn');
});
