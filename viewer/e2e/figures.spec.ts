import { expect, test, type Locator, type Page } from '@playwright/test';

import { releaseRoutesAfterEach } from './lib/routes.ts';
import { VIEWPORTS, shoot } from './lib/shots.ts';

releaseRoutesAfterEach();

/*
 * The four figures in a real browser (control-tower phase 29, #32 gap 2):
 * what jsdom cannot say, on EACH of `CHART_FIGURES`, not only the run chart.
 *
 *   - the crosshair is in the tab order and a keyboard moves it;
 *   - a plain wheel over a figure scrolls the page, and ⌃ + wheel (what a
 *     trackpad pinch sends) zooms it;
 *   - on a touch screen a two-finger pinch zooms, and a one-finger vertical
 *     swipe that starts ON the figure still scrolls the page.
 *
 * Both touch gestures go through Chromium's own input pipeline, so
 * `touch-action` is honoured exactly as it is for a finger: the swipe is
 * `Input.synthesizeScrollGesture` (a figure that declared `none` fails it),
 * and the pinch is two raw touch points moving apart sideways
 * (`Input.dispatchTouchEvent`). `Input.synthesizePinchGesture` is NOT used:
 * measured here, its pinch never reaches the script of a `pan-y` surface.
 *
 * The subject is Insights (`#/insights`): Velocity draws `Bars` and
 * `Calendar`, the portfolio draws `StackBar` and `BarList`. `/api/stats` is
 * served with a velocity and a calendar of its own, so the figures have
 * something to read whatever the fixture's dates are; the page itself is the
 * real one.
 */

const FIGURES = ['Bars', 'Calendar', 'BarList', 'StackBar'] as const;

const touch = (project: string): boolean => VIEWPORTS.find((v) => v.name === project)?.touch ?? false;

async function serveStats(page: Page): Promise<void> {
  await page.route(/\/api\/stats(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const stats = (await response.json()) as Record<string, unknown>;
    const now = Date.now();
    const day = (back: number) => new Date(now - back * 86_400_000).toISOString().slice(0, 10);
    stats.velocity = Array.from({ length: 26 }, (_, i) => ({
      week: `2026-W${String(i + 12).padStart(2, '0')}`,
      count: ((i * 7) % 5) + 1,
    }));
    stats.calendar = Array.from({ length: 40 }, (_, i) => ({ date: day(i * 3), count: (i % 4) + 1 }));
    const byStatus = stats.byStatus;
    if (!Array.isArray(byStatus) || byStatus.length < 2) {
      stats.byStatus = [
        { status: 'done', count: 9 },
        { status: 'ready', count: 3 },
        { status: 'waiting', count: 2 },
      ];
    }
    await route.fulfill({ response, json: stats });
  });
}

async function open(page: Page, name: (typeof FIGURES)[number]): Promise<Locator> {
  await serveStats(page);
  await page.goto('/#/insights');
  const figure = page.locator(`[data-figure="${name}"]`).first();
  await expect(figure).toBeVisible();
  // Mid-screen, so the page can scroll either way from here.
  await figure.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  return figure;
}

/** The figure's own "Reset zoom", which sits beside the slider, never inside it. */
const resetOf = (figure: Locator) =>
  figure.locator('xpath=following-sibling::div[1]').getByRole('button', { name: /reset zoom/i });

const scrollTop = (page: Page) =>
  page
    .locator('main')
    .first()
    .evaluate((main) => main.scrollTop);

async function centre(figure: Locator): Promise<{ x: number; y: number }> {
  const box = await figure.boundingBox();
  if (!box) throw new Error('the figure has no box');
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + Math.min(box.height / 2, 30)) };
}

test.describe('the figures', () => {
  for (const name of FIGURES) {
    test(`${name}: the crosshair is reached by Tab and moved by the keyboard`, async ({ page }, info) => {
      const figure = await open(page, name);
      await expect(figure).toHaveAttribute('role', 'slider');

      // Reached from the keyboard: focus whatever precedes it in the tab
      // order, then Tab — the figure must be the next stop.
      await figure.evaluate((node) => {
        const tabbable = [
          ...document.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex="0"]',
          ),
        ].filter((el) => el.offsetParent !== null || el === node);
        const at = tabbable.indexOf(node as HTMLElement);
        tabbable[at - 1]?.focus();
      });
      await page.keyboard.press('Tab');
      await expect(figure).toBeFocused();

      await page.keyboard.press('Home');
      await expect(figure).toHaveAttribute('aria-valuenow', '0');
      await page.keyboard.press(name === 'Calendar' || name === 'BarList' ? 'ArrowDown' : 'ArrowRight');
      await expect(figure).toHaveAttribute('aria-valuenow', '1');
      const said = await figure.getAttribute('aria-valuetext');
      expect(said).toBeTruthy();
      // The line under the figure shows what the slider says.
      await expect(figure.locator('xpath=following-sibling::div[1]').locator('[data-readout]')).toHaveText(
        said!,
      );

      await page.keyboard.press('+');
      await expect(resetOf(figure)).toBeVisible();
      await page.keyboard.press('0');
      await expect(resetOf(figure)).toHaveCount(0);
      if (name === 'Bars') await shoot(page, info.project.name, 'figures-crosshair');
    });

    test(`${name}: a plain wheel scrolls the page, and ⌃ + wheel zooms the figure`, async ({ page }) => {
      const figure = await open(page, name);
      const at = await centre(figure);
      await page.mouse.move(at.x, at.y);

      const before = await scrollTop(page);
      const room = await page
        .locator('main')
        .first()
        .evaluate((main) => main.scrollHeight - main.clientHeight - main.scrollTop);
      await page.mouse.wheel(0, room > 150 ? 150 : -150);
      await expect.poll(() => scrollTop(page)).not.toBe(before);
      await expect(resetOf(figure)).toHaveCount(0);

      await figure.evaluate((node) => node.scrollIntoView({ block: 'center' }));
      const again = await centre(figure);
      await page.mouse.move(again.x, again.y);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -300);
      await page.keyboard.up('Control');
      await expect(resetOf(figure)).toBeVisible();
    });

    test(`${name}: a two-finger pinch zooms the figure`, async ({ page }, info) => {
      test.skip(!touch(info.project.name), 'a touch screen');
      const figure = await open(page, name);
      const cdp = await page.context().newCDPSession(page);
      const at = await centre(figure);
      // Two fingers either side of the centre, moving apart sideways — the
      // part of a gesture `touch-action: pan-y` leaves to the page's script.
      const fingers = (spread: number) => [
        { x: at.x - spread, y: at.y, id: 1 },
        { x: at.x + spread, y: at.y, id: 2 },
      ];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(12) });
      for (let step = 1; step <= 8; step++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: fingers(12 + step * 8),
        });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(resetOf(figure)).toBeVisible();
      if (name === 'Bars') await shoot(page, info.project.name, 'figures-pinched');
    });

    test(`${name}: a vertical swipe that starts on the figure scrolls the page`, async ({ page }, info) => {
      test.skip(!touch(info.project.name), 'a touch screen');
      const figure = await open(page, name);
      const cdp = await page.context().newCDPSession(page);
      const from = await centre(figure);
      const before = await scrollTop(page);
      const room = await page
        .locator('main')
        .first()
        .evaluate((main) => main.scrollHeight - main.clientHeight - main.scrollTop);
      await cdp.send('Input.synthesizeScrollGesture', {
        x: from.x,
        y: from.y,
        yDistance: room > 200 ? -200 : 200,
        gestureSourceType: 'touch',
        speed: 800,
      });
      await expect.poll(() => scrollTop(page)).not.toBe(before);
      await expect(resetOf(figure)).toHaveCount(0);
    });
  }
});
