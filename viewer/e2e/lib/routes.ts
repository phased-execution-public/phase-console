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

export function releaseRoutesAfterEach(): void {
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });
}
