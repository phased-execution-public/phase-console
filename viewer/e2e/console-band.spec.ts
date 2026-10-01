/**
 * The console band, in a real browser (control-tower phase 25): what the
 * server could always do, reachable from a page — Debug ▸ Health's doctor and
 * this process, Debug ▸ Access, the log filters in the URL, the heap chip in
 * the header, and the Locks section.
 *
 * On the sandboxed fixture console (`e2e/fixture/console.ts`), on one desk
 * viewport: these are wiring questions, and the tour and the register already
 * measure the pages' layout at every viewport.
 */

import { expect, test } from '@playwright/test';

import { fixture, visit } from './lib/shots.ts';

const DESK = 'desk-1280';

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== DESK, 'the band is wiring — one desk viewport answers it');
});

test('Debug ▸ Health runs the doctor on a press and leads with the check to fix first', async ({ page }) => {
  const fx = await fixture();
  await visit(page, { name: 'band-health', hash: '#/debug/health' }, fx.anchor);
  await page.getByRole('button', { name: 'Run the doctor' }).click();
  await expect(page.getByTestId('doctor-verdict')).toBeVisible({ timeout: 30_000 });
  const rows = page.getByTestId('doctor-row');
  expect(await rows.count()).toBeGreaterThan(3);
  // Every row wears a probe badge, never a colour of this page's own.
  expect(await page.locator('[data-testid="doctor-row"] [data-status]').count()).toBe(await rows.count());
  const verdict = (await page.getByTestId('doctor-verdict').textContent()) ?? '';
  if (verdict.startsWith('Blocked:')) {
    // The verdict names the check to fix first, and that check's row leads.
    const named = verdict.slice('Blocked: '.length, verdict.indexOf(' — fix that first'));
    expect(await rows.first().textContent(), 'the named check leads the rows').toContain(named);
  }
  // This process: the generation the page read, and a restart's state.
  await expect(page.getByTestId('process')).toContainText('Generation');
  await expect(page.getByTestId('restart-update')).toBeVisible();
});

test('Debug ▸ Access counts what this console has served', async ({ page }) => {
  const fx = await fixture();
  await visit(page, { name: 'band-access', hash: '#/debug/access' }, fx.anchor);
  await expect(page.getByTestId('access')).toContainText('On this machine');
});

test('the log filters round-trip through the URL: q, since and limit', async ({ page }) => {
  const fx = await fixture();
  const since = '2026-01-01T00:00:00.000Z';
  const asked = page.waitForRequest(
    (r) => r.url().includes('/api/debug/index') && r.url().includes('limit=100'),
  );
  await visit(
    page,
    { name: 'band-logs', hash: `#/debug?q=phase&since=${encodeURIComponent(since)}&limit=100` },
    fx.anchor,
  );
  const request = new URL((await asked).url());
  expect(request.searchParams.get('q')).toBe('phase');
  expect(request.searchParams.get('since')).toBe(since);
  expect(request.searchParams.get('limit')).toBe('100');
  await expect(page.getByLabel('How many rows to read')).toHaveValue('100');
  await expect(page.getByLabel('Search logs')).toHaveValue('phase');
});

test('the heap chip is in the header on every page and opens Debug ▸ Health', async ({ page }) => {
  const fx = await fixture();
  await visit(page, { name: 'band-chip', hash: '#/runs' }, fx.anchor);
  const chip = page.getByTestId('runtime-chip');
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip.getByRole('meter')).toHaveAttribute('aria-valuetext', /Heap .* of /);
  await chip.click();
  await expect(page).toHaveURL(/#\/debug\/health/);
});

test('the Locks section lists every claim with what it holds up', async ({ page }) => {
  const fx = await fixture();
  await visit(page, { name: 'band-locks', hash: '#/sessions/locks' }, fx.anchor);
  await expect(page.getByRole('heading', { name: 'Locks' })).toBeVisible();
  // Either the claims table or the empty state — never an error page.
  await expect(
    page.getByRole('table', { name: /phase claims/i }).or(page.getByText('No phase is claimed right now.')),
  ).toBeVisible();
});
