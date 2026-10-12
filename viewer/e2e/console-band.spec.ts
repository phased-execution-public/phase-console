/**
 * The console band, in a real browser (control-tower phase 25): what the
 * server could always do, reachable from a page — Logs ▸ Health's doctor and
 * this process, Logs ▸ Access, the log filters in the URL, the heap reading,
 * the log level's debug channels, and the Locks section. Logs was Debug until
 * 7.0; since quiet-console phase 20 it is 7.0's own place (`screens/logs/`),
 * and `#/debug` redirects there.
 *
 * 7.0's header carries no chips: the heap left it for Logs ▸ Health's runtime
 * strip, and the chrome says where you are and what the situation is.
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

test('Logs ▸ Health runs the doctor on a press and leads with the check to fix first', async ({ page }) => {
  const fx = await fixture();
  await visit(page, { name: 'band-health', hash: '#/logs/health' }, fx.anchor);
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

test('Logs ▸ Access counts what this console has served', async ({ page }) => {
  const fx = await fixture();
  await visit(page, { name: 'band-access', hash: '#/logs/access' }, fx.anchor);
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
    { name: 'band-logs', hash: `#/logs?q=phase&since=${encodeURIComponent(since)}&limit=100` },
    fx.anchor,
  );
  const request = new URL((await asked).url());
  expect(request.searchParams.get('q')).toBe('phase');
  expect(request.searchParams.get('since')).toBe(since);
  expect(request.searchParams.get('limit')).toBe('100');
  await expect(page.getByLabel('How many rows to read')).toHaveValue('100');
  await expect(page.getByLabel('Search logs')).toHaveValue('phase');
});

test('the log level sends its debug channels and the change reverts with a DELETE', async ({ page }) => {
  const fx = await fixture();
  // Answered here: a real override would change the fixture console's own log
  // for every spec after this one.
  let level = {
    level: 'info',
    debug: '',
    source: 'env',
    levels: ['debug', 'info', 'warn', 'error'],
  } as Record<string, unknown>;
  const posted: unknown[] = [];
  await page.route('**/api/debug/level', async (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      const body = route.request().postDataJSON() as { level: string; debug: string; ttlMs: number };
      posted.push(body);
      level = {
        ...level,
        level: body.level,
        debug: body.debug,
        source: 'override',
        until: Date.now() + body.ttlMs,
      };
    } else if (method === 'DELETE') {
      level = { ...level, level: 'info', debug: '', source: 'env', until: undefined };
      posted.push('DELETE');
    }
    await route.fulfill({ json: level });
  });
  await visit(page, { name: 'band-level', hash: '#/logs' }, fx.anchor);
  const card = page.getByTestId('log-level');
  await expect(card.getByTestId('log-level-state')).toHaveText('Info, as configured.');
  await card.getByRole('button', { name: 'Change the level' }).click();
  await card.getByLabel('Debug channels').fill('git, runner');
  await card.getByLabel('For', { exact: true }).selectOption({ label: '2 hours' });
  await card.getByRole('button', { name: 'Change the level' }).last().click();
  await expect(card.getByTestId('log-level-state')).toContainText(
    'with the git, runner channels on, changed here',
  );
  expect(posted[0]).toEqual({ level: 'info', debug: 'git, runner', ttlMs: 2 * 60 * 60_000 });
  await card.getByRole('button', { name: 'Revert now' }).click();
  await expect(card.getByTestId('log-level-state')).toHaveText('Info, as configured.');
  expect(posted[1]).toBe('DELETE');
});

test('the header says where you are and what the situation is; the heap reads on Logs ▸ Health', async ({
  page,
}) => {
  const fx = await fixture();
  await visit(page, { name: 'band-chrome', hash: '#/runs' }, fx.anchor);
  // The place in a word, and the situation line (loaded after first paint) —
  // and no meter: the header carries no chip of any kind since 7.0.
  const header = page.getByRole('banner');
  await expect(header.getByTestId('header-title')).toHaveText('Runs');
  await expect(header.getByTestId('situation-line')).toBeVisible({ timeout: 30_000 });
  await expect(header.getByRole('meter')).toHaveCount(0);

  // The rail goes to Logs, and the header's word follows it.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('button', { name: 'Logs', exact: true })
    .click();
  await expect(page).toHaveURL(/#\/logs$/);
  await expect(header.getByTestId('header-title')).toHaveText('Logs');

  // The reading the header's chip carried — the heap against the limit this
  // console chose — on the runtime strip that leads Logs ▸ Health.
  await visit(page, { name: 'band-runtime', hash: '#/logs/health' }, fx.anchor);
  const heap = page.getByTestId('runtime-strip').getByRole('meter', { name: 'Heap', exact: true });
  await expect(heap).toBeVisible({ timeout: 30_000 });
  await expect(heap).toHaveAttribute('aria-valuetext', / of /);
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
