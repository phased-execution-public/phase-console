/**
 * Called once at the top of a spec whose `page.route` handlers call
 * `route.fetch()`.
 *
 * The page keeps polling as a test ends, and a handler still inside its fetch
 * then throws "route.fetch: Test ended" — an error outside any test, which fails
 * the whole tour and keeps every project that depends on the tour's from
 * running (the tower rehearsal's, control-tower phase 33). Unrouting at the end
 * of each test, ignoring whatever is still in flight, is Playwright's own
 * answer to it.
 */
import { test } from '@playwright/test';

import { CONSOLE_PORT } from './shots.ts';

export function releaseRoutesAfterEach(): void {
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });
}

/**
 * The fixture console's own answer to a GET, read once from Node — never
 * through the page's `route.fetch` (#312). A handler that fetched inside the
 * page's route shared the browser's keep-alive socket with everything else
 * the tour had in flight, and under load one reset (`read ECONNRESET`) red the
 * whole tour. Read here, on a connection of its own, a reset is simply asked
 * again; the handler then fulfils from this body and touches no network.
 */
export async function fixtureAnswer<T>(path: string, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CONSOLE_PORT}${path}`);
      if (res.ok) return (await res.json()) as T;
      last = new Error(`GET ${path} answered ${res.status}`);
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 250 * (i + 1)));
  }
  throw last instanceof Error ? last : new Error(`GET ${path} never answered`);
}
