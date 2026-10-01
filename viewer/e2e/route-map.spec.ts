import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { touch } from './lib/grid.ts';
import { releaseRoutesAfterEach } from './lib/routes.ts';
import { TOUR_PLAN, shoot } from './lib/shots.ts';

releaseRoutesAfterEach();

/*
 * The route map at 71 stations, in a real browser (control-tower phase 30, #32
 * gap 3).
 *
 * The plan is `test/fixtures/route-map/plan-71.json` — a real 71-phase
 * dependency shape, 30 waves by 13 rows, neutral titles — served as the tour
 * plan's own detail, so the page around the map is the real one and the tour's
 * ratchet is not moved by a seeded plan. What jsdom cannot answer is held here:
 *
 *   - the zoom floor is 45 %, for the buttons and for a two-finger pinch;
 *   - the page scrolls PAST the map on a phone — a vertical swipe that starts
 *     on the map, or on its minimap, is the page's, locked or unlocked;
 *   - every station is keyboard reachable, from one tab stop;
 *   - and the hardening the spike chose: the DOM holds a window of stations,
 *     not the plan; a minimap; fit-to-width; a search that moves the window.
 *
 * Both touch gestures go through Chromium's own input pipeline, as
 * `figures.spec.ts` does it: the swipe is `Input.synthesizeScrollGesture`, the
 * pinch two raw touch points (`Input.dispatchTouchEvent`).
 */

interface Node {
  phase: number;
  layer: number;
  row: number;
  state: string;
  size: string;
  gated: boolean;
  title: string;
}
interface Fixture {
  route: { nodes: Node[]; edges: { from: number; to: number }[]; layers: number; rows: number };
  critical: number[];
}
const PLAN = JSON.parse(
  readFileSync(new URL('../test/fixtures/route-map/plan-71.json', import.meta.url), 'utf8'),
) as Fixture;
const STATIONS = PLAN.route.nodes.length;
const MAP = `/#/plan/${TOUR_PLAN}/phases?view=map`;
const TOUR_ONLY = new Set(['live', 'lock', 'handoff']);

/** Serve the tour plan with the fixture's route and phases in place of its own. */
async function serveFixture(page: Page): Promise<void> {
  await page.route(new RegExp(`/api/plans/${TOUR_PLAN}(?:\\?[^/]*)?$`), async (route) => {
    const response = await route.fetch();
    const detail = (await response.json()) as {
      summary: Record<string, unknown>;
      phases: Record<string, unknown>[];
      [key: string]: unknown;
    };
    const template = detail.phases[0]!;
    const critical = new Set(PLAN.critical);
    const analysis = template.analysis as Record<string, unknown> | undefined;
    const row = template.row as Record<string, unknown> | undefined;
    const phases = PLAN.route.nodes.map((node) => {
      // A live lane, a claim and a handoff belong to the tour plan's own phases.
      const rest = Object.fromEntries(Object.entries(template).filter(([key]) => !TOUR_ONLY.has(key)));
      return {
        ...rest,
        phase: node.phase,
        title: node.title,
        state: node.state,
        size: node.size,
        gated: node.gated,
        blockedBy: [],
        qaHeld: [],
        reviewHold: [],
        ...(analysis
          ? {
              analysis: {
                ...analysis,
                phase: node.phase,
                onCriticalPath: critical.has(node.phase),
                dependsOn: [],
                dependents: [],
                transitiveDependents: [],
              },
            }
          : {}),
        ...(row
          ? {
              row: {
                ...row,
                phase: node.phase,
                dependsOn: PLAN.route.edges.filter((e) => e.to === node.phase).map((e) => e.from),
              },
            }
          : {}),
      };
    });
    await route.fulfill({
      response,
      json: {
        ...detail,
        summary: { ...detail.summary, phases: STATIONS },
        phases,
        route: PLAN.route,
        batches: null,
      },
    });
  });
}

/** The map's own zoom readout, as a number. */
async function zoom(page: Page): Promise<number> {
  const text = await page
    .locator('div:has(> .route-frame)')
    .getByText(/^\d+%$/)
    .textContent();
  return Number(text!.replace('%', ''));
}

const stations = (page: Page) => page.locator('.route-svg .station');

async function openMap(page: Page): Promise<void> {
  await serveFixture(page);
  await page.goto(MAP);
  await expect(stations(page).first()).toBeVisible();
}

/** Is this element's box inside the map frame's box? */
async function insideFrame(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((selector) => {
    const el = document.querySelector(selector);
    const frame = document.querySelector('.route-frame');
    if (!el || !frame) return false;
    const a = el.querySelector('.dot')?.getBoundingClientRect() ?? el.getBoundingClientRect();
    const b = frame.getBoundingClientRect();
    return a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
  }, selector);
}

/** Bring the map's card to the top of what `<main>` shows, for a shot. */
async function frameTheMap(page: Page): Promise<void> {
  await page
    .locator('.route-frame')
    .evaluate((frame) => frame.parentElement?.scrollIntoView({ block: 'start' }));
}

test.describe('the route map at 71 stations', () => {
  test('opens with every row across the frame, at or above the floor, a window of stations and a minimap', async ({
    page,
  }, info) => {
    // How long the drawing took, from the navigation — recorded, not judged:
    // this is the dev server, and the spike measured the production build.
    await page.addInitScript(() => {
      new MutationObserver((_, observer) => {
        if (document.querySelector('.route-svg .station')) {
          observer.disconnect();
          requestAnimationFrame(() => {
            (window as unknown as { firstStation: number }).firstStation = performance.now();
          });
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await openMap(page);
    const firstStation = await page.evaluate(
      () => (window as unknown as { firstStation?: number }).firstStation,
    );
    info.annotations.push({
      type: 'first station drawn',
      description: `${Math.round(firstStation ?? -1)} ms`,
    });

    expect(await zoom(page)).toBeGreaterThanOrEqual(45);
    // The window, not the plan: fewer stations in the DOM than the plan has.
    const drawn = await stations(page).count();
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(STATIONS);
    await expect(page.locator('svg.route-minimap')).toBeVisible();
    await expect(page.getByText(/^Waves \d+–\d+ of 30$/)).toBeVisible();
    // Fit-to-width: the zoom at which every row fills the frame's height —
    // unless that is below the floor, and then the floor. Never the whole-plan
    // fit, which drew this plan at 6 % on a phone.
    const frameH = await page.locator('.route-frame').evaluate((frame) => frame.clientHeight);
    const rowsH = 58 * 2 + (PLAN.route.rows - 1) * 108;
    const expected = Math.min(1.6, Math.max(0.45, frameH / rowsH));
    expect(await zoom(page)).toBe(Math.round(expected * 100));
    const viewBox = (await page.locator('svg.route-svg').getAttribute('viewBox'))!.split(' ').map(Number);
    expect(viewBox[3]).toBeCloseTo(frameH / expected, 0);
    // Where the floor allows it, that is every row of the plan.
    if (expected > 0.45) expect(viewBox[3]).toBeCloseTo(rowsH, 0);
    await frameTheMap(page);
    await shoot(page, info.project.name, 'route-map-71');
  });

  test('zooms out no further than 45 %, and a station dot there is the 7 px one', async ({ page }) => {
    await openMap(page);
    const out = page.getByRole('button', { name: 'Zoom out' });
    for (let press = 0; press < 12; press++) await out.click();
    expect(await zoom(page)).toBe(45);
    const radius = await page.evaluate(() => {
      const dot = document.querySelector('.route-svg .station .dot')!;
      return dot.getBoundingClientRect().width / 2;
    });
    // 15 plan units at 0.45 is 6.75 px, and the ring's stroke adds half its width.
    expect(radius).toBeGreaterThan(6.5);
    expect(radius).toBeLessThan(8);
  });

  test('a two-finger pinch zooms, and stops at the floor', async ({ page }, info) => {
    test.skip(!touch(info.project.name), 'a touch screen');
    await openMap(page);
    await page.getByRole('button', { name: 'Pan and zoom' }).click();
    const frame = page.locator('.route-frame');
    await frame.scrollIntoViewIfNeeded();
    const box = (await frame.boundingBox())!;
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const cdp = await page.context().newCDPSession(page);
    const pinch = async (from: number, to: number) => {
      const fingers = (spread: number) => [
        { x: at.x - spread, y: at.y, id: 1 },
        { x: at.x + spread, y: at.y, id: 2 },
      ];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(from) });
      for (let step = 1; step <= 8; step++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: fingers(from + ((to - from) * step) / 8),
        });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const before = await zoom(page);
    await pinch(20, 90);
    await expect.poll(() => zoom(page)).toBeGreaterThan(before);
    await pinch(100, 10);
    await pinch(100, 10);
    await expect.poll(() => zoom(page)).toBe(45);
  });

  test('a vertical swipe that starts on the map, or its minimap, scrolls the page past it', async ({
    page,
  }, info) => {
    test.skip(!touch(info.project.name), 'a touch screen');
    await openMap(page);
    const cdp = await page.context().newCDPSession(page);
    const scrollTop = () =>
      page
        .locator('main')
        .first()
        .evaluate((main) => main.scrollTop);
    /** A swipe that starts on `selector`, toward whichever end of the page has room. */
    const swipeFrom = async (selector: string) => {
      const target = page.locator(selector).first();
      await target.scrollIntoViewIfNeeded();
      const box = (await target.boundingBox())!;
      const before = await scrollTop();
      const room = await page
        .locator('main')
        .first()
        .evaluate((main) => main.scrollHeight - main.clientHeight - main.scrollTop);
      const up = room > 150;
      await cdp.send('Input.synthesizeScrollGesture', {
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        yDistance: up ? -150 : 150,
        gestureSourceType: 'touch',
        speed: 800,
      });
      await expect.poll(async () => Math.abs((await scrollTop()) - before)).toBeGreaterThan(50);
    };
    // Locked — the map is a picture the page scrolls over.
    await swipeFrom('.route-frame');
    await swipeFrom('svg.route-minimap');
    // Unlocked — `pan-y`: a sideways drag pans the map, a vertical one is still the page's.
    await page.getByRole('button', { name: 'Pan and zoom' }).click();
    await swipeFrom('.route-frame');
    // Past it: from the map's top at the top of the screen, swipes that start
    // on whatever of the map is still showing carry the page on until the map
    // has left the screen, or the page has ended.
    await page.locator('.route-frame').evaluate((frame) => frame.scrollIntoView({ block: 'start' }));
    const startTop = await scrollTop();
    // What `<main>` shows: the shell's header sits above it, and a map under
    // the header has left the page as surely as one above the screen.
    const shown = () =>
      page.evaluate(() => {
        const frame = document.querySelector('.route-frame')!.getBoundingClientRect();
        const main = document.querySelector('main')!;
        const view = main.getBoundingClientRect();
        return {
          x: frame.left + frame.width / 2,
          top: Math.max(frame.top, view.top),
          bottom: Math.min(frame.bottom, view.bottom),
          pageEnded: main.scrollHeight - main.clientHeight - main.scrollTop < 2,
        };
      });
    for (let swipe = 0; swipe < 12; swipe++) {
      const now = await shown();
      if (now.bottom - now.top < 40 || now.pageEnded) break;
      const y = (now.top + now.bottom) / 2;
      await cdp.send('Input.synthesizeScrollGesture', {
        x: now.x,
        y,
        yDistance: -Math.min(250, y - 10),
        gestureSourceType: 'touch',
        speed: 1200,
      });
    }
    const past = await shown();
    expect((await scrollTop()) - startTop).toBeGreaterThan(100);
    // Gone from what `<main>` shows (a sliver under 40 px), or the page ended.
    expect(past.bottom - past.top < 40 || past.pageEnded).toBe(true);
  });

  test('every station is keyboard reachable, from one tab stop', async ({ page }, info) => {
    test.skip(touch(info.project.name), 'a keyboard');
    await openMap(page);
    await expect(page.locator('.route-svg .station[tabindex="0"]')).toHaveCount(1);
    // Tab from the search, through the toolbar, onto the map's one stop.
    await page.getByRole('searchbox', { name: 'Find a station' }).focus();
    for (let press = 0; press < 12; press++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement?.classList.contains('station'))) break;
    }
    const active = () => page.evaluate(() => Number(document.activeElement?.getAttribute('data-phase')));
    expect(await active()).toBeGreaterThan(0);

    await page.keyboard.press('End');
    await expect.poll(active).toBe(STATIONS);
    expect(await insideFrame(page, `.station[data-phase="${STATIONS}"]`)).toBe(true);
    await page.keyboard.press('Home');
    await expect.poll(active).toBe(1);

    // Along the whole line to the last wave: each step is drawn, focused, in the frame.
    const lastWave = PLAN.route.nodes.filter((n) => n.layer === PLAN.route.layers - 1).map((n) => n.phase);
    for (let wave = 1; wave < PLAN.route.layers; wave++) await page.keyboard.press('ArrowRight');
    const at = await active();
    expect(lastWave).toContain(at);
    expect(await insideFrame(page, `.station[data-phase="${at}"]`)).toBe(true);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowDown');
    expect(await page.locator('.route-svg .station[tabindex="0"]').count()).toBe(1);
  });

  test('a station search moves the window to the station and rings it', async ({ page }, info) => {
    await openMap(page);
    const before = await page.locator('svg.route-svg').getAttribute('viewBox');
    const target = PLAN.route.nodes.find((n) => n.title === 'Release day')!;
    const search = page.getByRole('searchbox', { name: 'Find a station' });
    await search.fill('Release day');
    await search.press('Enter');
    await expect(page.getByText('1 of 1')).toBeVisible();
    await expect(page.locator('svg.route-svg')).not.toHaveAttribute('viewBox', before!);
    const found = page.locator(`.route-svg .station[data-phase="${target.phase}"]`);
    await expect(found).toHaveClass(/\bselected\b/);
    expect(await insideFrame(page, `.station[data-phase="${target.phase}"]`)).toBe(true);
    await frameTheMap(page);
    await shoot(page, info.project.name, 'route-map-found');
  });

  test('Fit shows the whole plan; Fit rows puts every row back across the frame', async ({ page }) => {
    await openMap(page);
    const opened = await zoom(page);
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await expect.poll(() => zoom(page)).toBeLessThan(45);
    await expect(stations(page)).toHaveCount(STATIONS);
    await page.getByRole('button', { name: 'Fit rows' }).click();
    await expect.poll(() => zoom(page)).toBe(opened);
    expect(await stations(page).count()).toBeLessThan(STATIONS);
  });
});
