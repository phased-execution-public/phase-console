import { expect, test, type Locator, type Page } from '@playwright/test';

import { releaseRoutesAfterEach } from './lib/routes.ts';
import { VIEWPORTS, shoot } from './lib/shots.ts';

releaseRoutesAfterEach();

/*
 * The four figures in a real browser (control-tower phase 29, #32 gap 2):
 * what jsdom cannot say, on EACH of the figures `ui/figures/lazy.tsx` names
 * (`FIGURES`), not only the run chart.
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
 * The subject is Insights (`#/insights`): How fast draws `Bars` and
 * `Calendar`, What shape the work is in draws `StackBar` and `BarList` — each
 * figure is found inside the question it answers, so a figure another
 * question adds above it (the cost's days) never changes which one is
 * tested. `/api/stats` is served with a velocity and a calendar of its own,
 * so the figures have something to read whatever the fixture's dates are;
 * the page itself is the real one.
 *
 * #247 (quiet-console phase 19): at phone-360 the gestures sometimes landed
 * beside the figure, because the page was still MOVING — a question above it
 * answered after the figure was measured and pushed it down the screen. So a
 * test reads the page only once it has settled (every question drawn, no
 * `aria-busy` placeholder left: every read answered and every drawing
 * arrived), and measures a figure immediately before each gesture, after any
 * scroll, until two reads of its box agree. And one page load serves all four
 * figures, a step each: sixteen loads of Insights a project became four. A
 * test now does four figures' work, so its time limit is four figures' worth
 * of the tour's own (under the full gate's load one figure's wheel test once
 * ran past 180 s).
 */

const FIGURES = ['Bars', 'Calendar', 'BarList', 'StackBar'] as const;
type FigureName = (typeof FIGURES)[number];

/** The question each figure answers on Insights (`data-insight`). */
const QUESTION: Readonly<Record<FigureName, string>> = {
  Bars: 'velocity',
  Calendar: 'velocity',
  BarList: 'shape',
  StackBar: 'shape',
};

/** The questions an unscoped Insights asks — all of them drawn is the page settled. */
const QUESTIONS = 9;

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

const figureOf = (page: Page, name: FigureName): Locator =>
  page.locator(`[data-insight="${QUESTION[name]}"] [data-figure="${name}"]`).first();

/** Insights, once nothing on it will move by itself again. */
async function open(page: Page): Promise<void> {
  await serveStats(page);
  await page.goto('/#/insights');
  const questions = page.locator('[data-testid="insights-questions"]');
  await expect(questions.locator('[data-insight]')).toHaveCount(QUESTIONS);
  await expect(questions.locator('[aria-busy="true"]')).toHaveCount(0);
  for (const name of FIGURES) await expect(figureOf(page, name)).toBeVisible();
}

/** Mid-screen, so the page can scroll either way from here. */
const centreOnScreen = (figure: Locator) =>
  figure.evaluate((node) => node.scrollIntoView({ block: 'center' }));

/** The figure's box once it has stopped moving: read until two reads a beat apart agree. */
async function settledBox(figure: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  let last = '';
  let box: Awaited<ReturnType<Locator['boundingBox']>> = null;
  await expect
    .poll(
      async () => {
        box = await figure.boundingBox();
        const read = JSON.stringify(box);
        const still = box !== null && read === last;
        last = read;
        return still;
      },
      { intervals: [100], message: 'the figure keeps moving' },
    )
    .toBe(true);
  return box!;
}

/** Where a gesture lands: the middle of the figure, at most 30 px down, so it is on the drawing. */
async function aim(figure: Locator): Promise<{ x: number; y: number }> {
  const box = await settledBox(figure);
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + Math.min(box.height / 2, 30)) };
}

/** The figure's own "Reset zoom", which sits beside the slider, never inside it. */
const resetOf = (figure: Locator) =>
  figure.locator('xpath=following-sibling::div[1]').getByRole('button', { name: /reset zoom/i });

const scrollTop = (page: Page) =>
  page
    .locator('main')
    .first()
    .evaluate((main) => main.scrollTop);

/** How far the page can still scroll down from where it is. */
const roomBelow = (page: Page) =>
  page
    .locator('main')
    .first()
    .evaluate((main) => main.scrollHeight - main.clientHeight - main.scrollTop);

test.describe('the figures', () => {
  test.describe.configure({ timeout: FIGURES.length * 180_000 });

  test('every figure: the crosshair is reached by Tab and moved by the keyboard', async ({ page }, info) => {
    await open(page);
    for (const name of FIGURES) {
      await test.step(name, async () => {
        const figure = figureOf(page, name);
        await centreOnScreen(figure);
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
    }
  });

  test('every figure: a plain wheel scrolls the page, and ⌃ + wheel zooms the figure', async ({ page }) => {
    await open(page);
    for (const name of FIGURES) {
      await test.step(name, async () => {
        const figure = figureOf(page, name);
        await centreOnScreen(figure);
        const at = await aim(figure);
        await page.mouse.move(at.x, at.y);

        const before = await scrollTop(page);
        await page.mouse.wheel(0, (await roomBelow(page)) > 150 ? 150 : -150);
        await expect.poll(() => scrollTop(page)).not.toBe(before);
        await expect(resetOf(figure)).toHaveCount(0);

        // The page moved under the pointer: put the figure back and aim again.
        await centreOnScreen(figure);
        const again = await aim(figure);
        await page.mouse.move(again.x, again.y);
        await page.keyboard.down('Control');
        await page.mouse.wheel(0, -300);
        await page.keyboard.up('Control');
        await expect(resetOf(figure)).toBeVisible();
      });
    }
  });

  test('every figure: a two-finger pinch zooms it', async ({ page }, info) => {
    test.skip(!touch(info.project.name), 'a touch screen');
    await open(page);
    const cdp = await page.context().newCDPSession(page);
    for (const name of FIGURES) {
      await test.step(name, async () => {
        const figure = figureOf(page, name);
        await centreOnScreen(figure);
        const at = await aim(figure);
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
    }
  });

  test('every figure: a vertical swipe that starts on it scrolls the page', async ({ page }, info) => {
    test.skip(!touch(info.project.name), 'a touch screen');
    await open(page);
    const cdp = await page.context().newCDPSession(page);
    for (const name of FIGURES) {
      await test.step(name, async () => {
        const figure = figureOf(page, name);
        await centreOnScreen(figure);
        const from = await aim(figure);
        const before = await scrollTop(page);
        await cdp.send('Input.synthesizeScrollGesture', {
          x: from.x,
          y: from.y,
          yDistance: (await roomBelow(page)) > 200 ? -200 : 200,
          gestureSourceType: 'touch',
          speed: 800,
        });
        await expect.poll(() => scrollTop(page)).not.toBe(before);
        await expect(resetOf(figure)).toHaveCount(0);
      });
    }
  });
});
