/**
 * The tour: where the browser goes, in which viewports, and the picture it
 * leaves of each stop.
 *
 * The stops are DERIVED from `shared/route-meta.js` — every destination, every
 * plan tab — plus `#/approve` and the three overlays, so a destination added
 * there is toured (and measured, and photographed) without anyone remembering
 * to add it here. The pictures go to `e2e/.shots/<project>/<stop>.png`,
 * gitignored and never pixel-diffed: they are for the session that changed the
 * page to READ, because a clipped row is exactly the defect a test that only
 * asks "did it render" passes.
 *
 * Plain enough for `node --test` to import (`test/dist-dir.test.ts` holds the
 * tour to one PNG per stop): no runtime import of Playwright.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page, Request } from '@playwright/test';

import { DESTINATIONS, PLAN_TABS } from '../../shared/route-meta.js';

export const SHOTS_DIR = fileURLToPath(new URL('../.shots', import.meta.url));

/** The sandboxed console (`e2e/fixture/console.ts`) and the Vite in front of it. */
export const CONSOLE_PORT = 4961;
export const VITE_PORT = 4962;

/** The four viewports. The two touch ones emulate a coarse pointer with no hover. */
export const VIEWPORTS = [
  { name: 'phone-360', width: 360, height: 740, touch: true },
  { name: 'tablet-768', width: 768, height: 1024, touch: true },
  { name: 'desk-1024', width: 1024, height: 768, touch: false },
  { name: 'desk-1280', width: 1280, height: 800, touch: false },
] as const;

/** The seeded plan the plan tabs are toured on (`e2e/fixture/seed.ts`). */
export const TOUR_PLAN = 'tower';

export type Overlay = 'palette' | 'help' | 'bell';
export type Stop = { name: string; hash: string; overlay?: Overlay };

export const STOPS: readonly Stop[] = [
  ...DESTINATIONS.map((d) => ({ name: d, hash: `#/${d}` })),
  ...PLAN_TABS.map((t) => ({ name: `plan-${t}`, hash: `#/plan/${TOUR_PLAN}/${t}` })),
  { name: 'approve', hash: '#/approve' },
  // `?k=` `?help=` `?bell=` — `client/src/app/routes.ts` OVERLAY_KEYS.
  { name: 'overlay-palette', hash: '#/runs?k=', overlay: 'palette' },
  { name: 'overlay-help', hash: '#/runs?help=', overlay: 'help' },
  { name: 'overlay-bell', hash: '#/runs?bell=1', overlay: 'bell' },
];

export const shotPath = (project: string, stop: string): string => join(SHOTS_DIR, project, `${stop}.png`);

/** What the fixture wrote into its library root — `e2e-fixture.json`. */
export type Fixture = {
  anchor: number;
  tourPlan: string;
  plans: string[];
  runs: { slug: string; id: string; status: string; halt: string | null }[];
  stateDir: string;
  ready: boolean;
  live?: boolean;
  why?: string;
  root: string;
};

let cached: Fixture | null = null;

/**
 * The fixture's handshake, read once per worker: the console names its own
 * library root (`/api/state`), and the fixture left the file there. Waits for
 * `ready` — the live lane is up — because a spec that looked for it earlier
 * would measure a different page from the next run's.
 */
export async function fixture(): Promise<Fixture> {
  if (cached) return cached;
  for (let i = 0; i < 600; i++) {
    try {
      const state = (await (await fetch(`http://127.0.0.1:${CONSOLE_PORT}/api/state`)).json()) as {
        root?: { path?: string };
      };
      const root = state.root?.path;
      if (root) {
        const fx = JSON.parse(readFileSync(join(root, 'e2e-fixture.json'), 'utf8')) as Fixture;
        if (fx.ready) return (cached = { ...fx, root });
      }
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the e2e fixture console never became ready');
}

/**
 * Go to a stop and wait until it has stopped moving: the page's own frame
 * visible, every request it made answered (the event stream aside — it never
 * ends), skeletons gone, fonts loaded, two frames painted. A page measured
 * while its data is still arriving is a different page on every run, and a
 * ratchet over it would fail at random. The clock is fixed ten minutes after
 * the seed's anchor, so every relative time the seed implies reads the same.
 */
export async function visit(page: Page, stop: Stop, anchor: number): Promise<void> {
  const inflight = new Set<Request>();
  const streams = (r: Request): boolean =>
    r.resourceType() === 'eventsource' || /\/(events|ws)(\?|$)/.test(new URL(r.url()).pathname);
  const start = (r: Request): void => void (streams(r) || inflight.add(r));
  const end = (r: Request): void => void inflight.delete(r);
  page.on('request', start);
  page.on('requestfinished', end);
  page.on('requestfailed', end);
  try {
    await page.clock.setFixedTime(anchor + 10 * 60_000);
    await page.goto(`/${stop.hash}`);
    await page.locator('main').first().waitFor({ state: 'visible' });
    if (stop.overlay) await page.getByRole('dialog').first().waitFor({ state: 'visible' });
    await quiet(inflight);
    await settle(page);
    await quiet(inflight);
  } finally {
    page.off('request', start);
    page.off('requestfinished', end);
    page.off('requestfailed', end);
  }
}

/** Until nothing has been in flight for 400 ms (10 s at most — then as it stands). */
async function quiet(inflight: Set<Request>): Promise<void> {
  let calm = 0;
  for (let waited = 0; waited < 10_000 && calm < 400; waited += 50) {
    await new Promise((r) => setTimeout(r, 50));
    calm = inflight.size ? 0 : calm + 50;
  }
}

export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page
    .waitForFunction(() => !document.querySelector('.animate-pulse'), null, { timeout: 8_000 })
    .catch(() => undefined); // a page that never stops loading is measured as it stands
  await page.evaluate(async () => {
    const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
    await frame();
    await frame();
    for (const a of document.getAnimations()) {
      try {
        a.finish();
      } catch {
        a.cancel(); // an infinite one cannot finish
      }
    }
    await frame();
  });
}

/** Photograph the viewport as it stands, and prove the file landed. */
export async function shoot(page: Page, project: string, stop: string): Promise<string> {
  const path = shotPath(project, stop);
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
  if (!existsSync(path) || statSync(path).size === 0)
    throw new Error(`no picture was written for ${project}/${stop}`);
  return path;
}
