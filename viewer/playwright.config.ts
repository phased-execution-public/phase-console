import { defineConfig } from '@playwright/test';

import { CONSOLE_PORT, VITE_PORT, VIEWPORTS } from './e2e/lib/shots.ts';

// The real-browser harness (control-tower phase 15). What `test:client` cannot
// see — jsdom has no layout engine — measured in Chromium: overflow, escape from
// `<main>` (which `overflow-x-hidden` CLIPS rather than scrolls, so a broken row
// is invisible to a screenshot and to a reviewer alike), the three touch
// questions of `docs/design.md` §6.1, axe with contrast in both themes, and a
// painted focus ring. `e2e/register.spec.ts` holds every finding to a two-way
// ratchet in `e2e/baseline.json`.
//
// Two servers, both throwaway and both on loopback. The console is a SANDBOXED
// one (`e2e/fixture/console.ts`: temporary XDG homes, a seeded plan library, a
// stub `claude` on PATH) — never the operator's. Vite serves the client in front
// of it, pointed there by `PHASE_CONSOLE_ORIGIN`. `reuseExistingServer` is off on
// purpose: something already on either port is not this fixture, and a tour run
// against it would measure — and write to — whatever it is.
//
// Dist mode (control-tower phase 31): with `PHASE_CONSOLE_DIST_DIR` set to a
// production build, there is no Vite. The fixture console serves that build
// itself — the one `server/config.ts` `DIST_DIR` names — under its real
// headers, CSP included, and the browser talks to the console directly. That
// is the client a person meets, and `scripts/gates.sh` tours it; the dev mode
// stays for a person iterating on a page.

// The four viewports every stop is toured in (`e2e/lib/shots.ts`), their names
// the baseline's keys. A touch project emulates a phone or tablet — a coarse
// pointer and no hover, which `smoke.spec.ts` asserts rather than assumes.
const useFor = (v: (typeof VIEWPORTS)[number]) => ({
  viewport: { width: v.width, height: v.height },
  ...(v.touch ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
});
const REHEARSAL = /rehearsal\.spec\.ts$/;
const PROJECTS = VIEWPORTS.map((v) => ({ name: v.name, use: useFor(v), testIgnore: REHEARSAL }));

// The browser half of the tower rehearsal (control-tower phase 33): the Runs
// page and quick start at 360 and 1280, against the same fixture console. It
// STARTS runs there — and every spec above measures that console as the seed
// left it — so it runs in projects of its own that wait for the four above
// (`dependencies`), and writes its plans only once they are done.
const REHEARSAL_PROJECTS = VIEWPORTS.filter((v) => v.name === 'phone-360' || v.name === 'desk-1280').map(
  (v) => ({
    name: `rehearsal-${v.name}`,
    use: useFor(v),
    testMatch: REHEARSAL,
    dependencies: PROJECTS.map((p) => p.name),
  }),
);

const WRITE_BASELINE = process.env.PHASE_CONSOLE_E2E_BASELINE === 'write';
const DIST = Boolean(process.env.PHASE_CONSOLE_DIST_DIR);

export default defineConfig({
  testDir: './e2e',
  testMatch: /\.spec\.ts$/,
  outputDir: './e2e/.results',
  fullyParallel: true,
  workers: 6,
  forbidOnly: true,
  retries: 0,
  // A liveness bound, like the two below: a passing test never waits for it.
  // At load average 70–84 (control-tower phase 103: an emulator, a simulator
  // and another console's lanes on the same machine), with three workers,
  // register stops ran 50–53 s against the old 60 s bound, and the gate runs
  // six workers.
  timeout: 180_000,
  // The first page to reach a lazy chunk (the grid, the figures) waits while
  // the dev server compiles it; six workers asking at once on a machine at a
  // load average near 50 took past 10 s, on a clean tree as on a changed one
  // (control-tower phase 49). A passing wait returns the moment it passes, so
  // only a failure takes longer to say so. Phase 103, at load average 70–84,
  // saw the grid take past 30 s (`tables.spec.ts`), on one viewport and then
  // another.
  expect: { timeout: 60_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${DIST ? CONSOLE_PORT : VITE_PORT}`,
    browserName: 'chromium',
    // A context option, not a `use` one: the page answers
    // `prefers-reduced-motion: reduce`, and theme.css shortens every transition.
    contextOptions: { reducedMotion: 'reduce' },
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'off',
    screenshot: 'off',
  },
  projects: [...PROJECTS, ...REHEARSAL_PROJECTS],
  // `test:e2e:baseline` — each register test leaves its findings, and this
  // folds them into `e2e/baseline.json` once every worker is done.
  globalTeardown: WRITE_BASELINE ? './e2e/lib/baseline.ts' : undefined,
  webServer: [
    {
      command: `node e2e/fixture/console.ts --port ${CONSOLE_PORT}`,
      url: `http://127.0.0.1:${CONSOLE_PORT}/api/state`,
      reuseExistingServer: false,
      timeout: 90_000,
      stdout: 'pipe',
      stderr: 'pipe',
      // The fixture removes its sandbox and its console on SIGTERM; a SIGKILL
      // would leave both behind in $TMPDIR. Its teardown is the console's own
      // shutdown (an 8 s backstop), then a reap of what that left (3 s of grace,
      // #90) — so the wait is longer than the sum, not the first part.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 20_000 },
    },
    ...(DIST
      ? []
      : [
          {
            command: `npx vite --port ${VITE_PORT} --strictPort`,
            url: `http://127.0.0.1:${VITE_PORT}/`,
            reuseExistingServer: false,
            timeout: 90_000,
            env: { PHASE_CONSOLE_ORIGIN: `http://127.0.0.1:${CONSOLE_PORT}` },
            gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 5_000 },
          },
        ]),
  ],
});
