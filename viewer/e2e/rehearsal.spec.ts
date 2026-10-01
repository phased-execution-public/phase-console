/**
 * The tower rehearsal, in a browser (control-tower phase 33, exit criterion 3):
 * the Runs page and quick start at 360 and at 1280, against a console of this
 * tree whose `claude` is a stub.
 *
 * The tower rehearsal drives its consoles over the API. This drives the
 * fixture console the way a person does — the Tower's Ready bay, its Start, the
 * quick view's one Launch — and, on a phone, recovers the stop that launch meets
 * with the one button its card recommends, the way `halts.spec.ts` only asked
 * whether a thumb could reach it.
 *
 * It runs LAST, in projects of its own (`playwright.config.ts`): every other
 * spec measures the fixture console as the seed left it, and this one starts
 * runs there. Its plans are written into the fixture's library when it starts,
 * so no page another spec measured ever held them, and each run it starts is
 * stopped before it ends.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { still } from './lib/probes.ts';
import { CONSOLE_PORT, fixture } from './lib/shots.ts';

type Run = {
  id?: string;
  status?: string;
  halt?: { kind?: string; phase?: number } | null;
  children?: unknown;
  child?: unknown;
};

async function consoleApi<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<{ status: number; json: T | null }> {
  const res = await fetch(`http://127.0.0.1:${CONSOLE_PORT}${path}`, {
    method,
    headers: {
      'x-phase-console': '1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as T | null };
}

const runOf = async (slug: string): Promise<Run | null> =>
  (await consoleApi<{ run?: Run }>(`/api/run/${slug}`)).json?.run ?? null;

/** A lane is live on the run: the fixture's stub session stays until it is stopped. */
const liveLane = (run: Run | null): boolean =>
  run?.status === 'running' && JSON.stringify(run.children ?? run.child ?? null).includes('pid');

/** A one-phase plan. Without `verified` its phase states no §Verification — the stop the phone meets. */
function plan(slug: string, verified: boolean): string {
  return [
    '---',
    `slug: ${slug}`,
    'created: 2026-10-01',
    'status: active',
    'phases: 1',
    `handoffs: docs/handoffs/${slug}/`,
    '---',
    '',
    `# ${slug}`,
    '',
    '## Phase graph',
    '',
    '| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |',
    '|---|---|---|---|---|---|',
    `| 1 | The one step | — | — | ${slug} | it is done |`,
    '',
    '## Phases',
    '',
    '### Phase 1 — The one step',
    '',
    '- **Size:** S',
    ...(verified ? ['- **Verification:**', '  - `test -d docs`'] : []),
    '',
  ].join('\n');
}

/** Write a plan into the fixture's library and wait until the console reads its phase ready. */
async function addPlan(root: string, slug: string, verified: boolean): Promise<string> {
  mkdirSync(join(root, 'docs', 'handoffs', slug), { recursive: true });
  mkdirSync(join(root, slug), { recursive: true });
  const file = join(root, 'docs', 'plans', `${slug}.md`);
  writeFileSync(file, plan(slug, verified));
  await expect
    .poll(
      async () => {
        const { json } = await consoleApi<unknown>('/api/plans');
        const rows = Array.isArray(json) ? json : ((json as { plans?: unknown[] } | null)?.plans ?? []);
        const row = rows.find((r) => (r as { slug?: string }).slug === slug) as
          { ready?: unknown[] } | undefined;
        return Boolean(row?.ready?.includes(1));
      },
      { timeout: 30_000, message: `the console reads ${slug}'s phase ready` },
    )
    .toBe(true);
  return file;
}

/**
 * Start a plan as a person does: the Tower's Ready bay, Start, the quick view,
 * a preset when one is named, Launch.
 */
async function launchFromRuns(page: Page, slug: string, hash: string, preset?: string): Promise<void> {
  await page.goto(`/${hash}`);
  // The bay shows its first few by leverage, and a one-phase plan written a
  // moment ago frees nothing: a person looking for it opens the whole bay.
  const bay = page.getByTestId('ready-bay').first();
  await expect(bay).toBeVisible();
  const every = bay.getByRole('button', { name: /^Show all \d+ ready phases?$/ });
  if (await every.count()) await every.click();
  const row = page.locator(`[data-testid="ready-row"][data-slug="${slug}"]`).first();
  await expect(row, `the Ready bay offers ${slug}`).toBeVisible();
  await row.getByTestId('ready-start').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('quick-view')).toBeVisible();
  if (preset) {
    const choice = dialog
      .getByRole('group', { name: 'Start from a preset' })
      .getByRole('button', { name: preset });
    await choice.click();
    await expect(choice).toHaveAttribute('aria-pressed', 'true');
  }
  const launch = dialog.getByTestId('launch-submit');
  await expect(launch).toBeEnabled();
  await launch.click();
  await expect(dialog.getByTestId('quick-view')).toBeHidden();
}

test('on a desk, the Runs page starts a plan through quick start and its lane goes live', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'rehearsal-desk-1280', 'the desk half is asked at 1280');
  const fx = await fixture();
  const slug = 'rehearse-desk';
  await addPlan(fx.root, slug, true);

  await launchFromRuns(page, slug, '#/runs');
  await expect
    .poll(async () => liveLane(await runOf(slug)), { timeout: 60_000, message: 'a live lane' })
    .toBe(true);

  // The Runs page says so: the plan's strip, painted as working.
  await page.goto('/#/runs');
  const strip = page.locator(`[data-strip][data-slug="${slug}"]`).first();
  await expect(strip).toBeVisible();
  await expect(strip).toHaveAttribute('data-paint', 'running');

  const stopped = await consoleApi(`/api/run/${slug}/stop`, 'POST', {});
  expect(stopped.status).toBe(200);
});

test('on a phone, a run started through quick start stops, and the button its card recommends recovers it', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'rehearsal-phone-360', 'the phone half is asked at 360');
  const fx = await fixture();
  const slug = 'rehearse-phone';
  const file = await addPlan(fx.root, slug, false);

  // Careful: a person is there to decide, so nothing recovers the stop before
  // they do. The shipped preset recovers by itself, and a run its healer had
  // already re-driven reads live — a live run's card offers nothing to press.
  await launchFromRuns(page, slug, '#/runs?bay=ready', 'Careful');
  // It stops at the door, before any session is spent: the plan states no
  // verification for its one phase — a stop in the `plan` category.
  await expect
    .poll(
      async () => {
        const run = await runOf(slug);
        return run?.status === 'parked' || run?.status === 'halted' ? (run.halt?.kind ?? null) : null;
      },
      { timeout: 60_000, message: 'the stop' },
    )
    .toBe('verification-preflight');

  await page.goto(`/#/plan/${slug}/run`);
  await expect(page.locator('[data-halt-category="plan"]').first()).toBeVisible();
  const recommended = page.getByTestId('halt-recommended').first();
  await expect(recommended).toBeVisible();
  await expect(recommended).toHaveText(/Retry/);

  // The card's own first step — "Repair the plan file" — then its one button.
  writeFileSync(file, plan(slug, true));
  await recommended.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
  await still(page);
  await recommended.tap();

  // Recovered: the stop is gone and the phase boarded — the stub's lane is live on it.
  await expect
    .poll(
      async () => {
        const run = await runOf(slug);
        return !run?.halt && liveLane(run);
      },
      { timeout: 60_000, message: 'the run leaves its stop and boards the phase' },
    )
    .toBe(true);
  await expect(page.locator('[data-halt-category="plan"]')).toHaveCount(0);

  const stopped = await consoleApi(`/api/run/${slug}/stop`, 'POST', {});
  expect(stopped.status).toBe(200);
});
