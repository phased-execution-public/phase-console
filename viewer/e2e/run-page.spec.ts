/**
 * The plan's Run view and Sessions at every width (7.0, quiet-console phase
 * 11; control-tower phase 24's criterion carried): nothing overflows `main`,
 * folded or unfolded, and every tap target the view opens on — the head's one
 * action and its Inspect, each fold's row, the settings verb — wins its own
 * hit test at the thumb's height.
 *
 * The view opens on a glance: the run's row as its head (the Runs home's own
 * line, its `header` variant), the halt card when stopped, the lanes, the
 * verbs, and every other section folded under a row that names it. A fold's
 * row is the thing a thumb presses most here, so each one is hit-tested, and
 * the view is read again with every fold open — a section that only overflows
 * once shown is still an overflow. The History reading (every run of the
 * plan) and the run in the panel (Inspect) are read the same way.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { layoutFindings, still } from './lib/probes.ts';
import { fixture, shoot, visit } from './lib/shots.ts';

const PHONE = 'phone-360';

async function escapes(page: Page, touch: boolean) {
  return (await layoutFindings(page, { touch })).filter((f) => f.cls === 'overflow' || f.cls === 'escape');
}

/** Does a tap at the middle of `target` land on it — and is it a thumb's height? */
async function wins(target: Locator) {
  await target.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
  await still(target.page());
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      wins: Boolean(top && (top === el || el.contains(top))),
      what: top ? top.outerHTML.replace(/\s+/g, ' ').slice(0, 160) : 'nothing',
      height: Math.round(r.height),
      label: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 60),
    };
  });
}

test('the Run view opens on its head and folds, and stays inside main — folded and unfolded', async ({
  page,
}, info) => {
  const fx = await fixture();
  expect(fx.live, `the fixture's run must be live (${fx.why ?? ''})`).toBe(true);
  const touch = info.project.name === PHONE || info.project.name.startsWith('tablet');

  await visit(page, { name: 'run-page', hash: '#/plan/tower/run' }, fx.anchor);
  await expect(page.getByTestId('run-head')).toBeVisible();
  // The head IS the Runs home's row — the same line, as a header.
  await expect(page.getByTestId('run-head').locator('[data-strip][data-variant="header"]')).toBeVisible();
  await expect(page.getByTestId('run-head').getByTestId('strip-expand')).toHaveCount(0);
  const toggles = page.getByTestId('run-section-toggle');
  expect(await toggles.count(), 'the page folds its sections under named rows').toBeGreaterThan(5);
  expect(await escapes(page, touch)).toEqual([]);
  // The picture is of the run page itself, not the plan header above it.
  await page.getByTestId('run-head').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await still(page);
  await shoot(page, info.project.name, 'run-page');

  // Every fold open: what a section shows must fit as well as its row did.
  for (let i = 0; i < (await toggles.count()); i += 1) {
    const toggle = toggles.nth(i);
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  }
  await still(page);
  expect(await escapes(page, touch)).toEqual([]);
  await page.getByTestId('run-sections').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await still(page);
  await shoot(page, info.project.name, 'run-page-unfolded');

  // The sessions fold names its panes in the address and draws the chosen one's console.
  const sessions = page.locator('section[data-section="sessions"]');
  await expect(sessions.getByRole('link', { name: /^Run\b/ })).toBeVisible();
  await expect(sessions.getByRole('log').first()).toBeAttached();
  // Each rebuilt fold photographed at its own top, so the pictures read every section.
  for (const id of [
    'sessions',
    'time',
    'ledger',
    'notes',
    'messages',
    'git',
    'landing',
    'ways',
    'verification',
  ]) {
    const fold = page.locator(`section[data-section="${id}"]`);
    if (!(await fold.count())) continue;
    await fold.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await still(page);
    await shoot(page, info.project.name, `run-fold-${id}`);
  }

  // Leave the folds as a person found them: the preference is per browser.
  for (let i = 0; i < (await toggles.count()); i += 1) {
    const toggle = toggles.nth(i);
    if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click();
  }
});

test('on a phone every tap target the run page opens on wins its tap', async ({ page }, info) => {
  test.skip(info.project.name !== PHONE, 'the thumb is a phone’s question');
  const fx = await fixture();
  await visit(page, { name: 'run-page-taps', hash: '#/plan/tower/run' }, fx.anchor);
  await expect(page.getByTestId('run-head')).toBeVisible();

  const targets: Locator[] = [];
  const toggles = page.getByTestId('run-section-toggle');
  for (let i = 0; i < (await toggles.count()); i += 1) targets.push(toggles.nth(i));
  const action = page.getByTestId('run-head').getByTestId('strip-action');
  if (await action.count()) targets.push(action.first());
  targets.push(page.getByTestId('run-head').getByTestId('strip-inspect'));
  const verb = page.getByRole('button', { name: /^(Settings|Continue this run|Start a run)$/ });
  if (await verb.count()) targets.push(verb.first());

  const lost: string[] = [];
  for (const target of targets) {
    const hit = await wins(target);
    if (!hit.wins) lost.push(`${hit.label}: the tap lands on ${hit.what}`);
    else if (hit.height < 44) lost.push(`${hit.label}: ${hit.height}px, under a thumb's 44`);
  }
  expect(lost).toEqual([]);
});

test('the History reading lists every run of the plan and opens one, inside main', async ({ page }, info) => {
  const fx = await fixture();
  const touch = info.project.name === PHONE || info.project.name.startsWith('tablet');
  await visit(page, { name: 'run-history', hash: '#/plan/tower/run?view=history' }, fx.anchor);
  const rows = page.getByTestId('history-row');
  await expect(rows.first()).toBeVisible();
  expect(await escapes(page, touch)).toEqual([]);
  await shoot(page, info.project.name, 'run-history');

  // A run opened: its phases, one line each, inside main.
  const id = await rows.first().getAttribute('data-run');
  await visit(
    page,
    { name: 'run-history-picked', hash: `#/plan/tower/run?view=history&run=${id}` },
    fx.anchor,
  );
  await expect(page.getByTestId('history-picked')).toBeVisible();
  await still(page);
  expect(await escapes(page, touch)).toEqual([]);
});

test('Inspect puts the run in the panel: its eight sections and its Actions', async ({ page }, info) => {
  test.skip(info.project.name !== 'desk-1280', 'the panel is the desk’s column; asked once');
  const fx = await fixture();
  await visit(page, { name: 'run-inspect', hash: '#/plan/tower/run' }, fx.anchor);
  await page.getByTestId('run-head').getByTestId('strip-inspect').click();
  // The eight sections fold under their names, the phase inspector's grammar.
  await expect(page.getByRole('button', { name: /^Isolation and trees/ }).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Actions' }).click();
  await expect(page.getByTestId('run-actions')).toBeVisible();
  // Five verbs, then Extend once per waiting card of the run — and one row,
  // disabled, while none waits, as in the seed: six.
  const actions = page.getByTestId('run-action');
  for (const id of [
    'isolate',
    'isolate-phase',
    'board-at-boundary',
    'repair-checkout',
    'errand-tree',
    'extend',
  ]) {
    await expect(actions.and(page.locator(`[data-action="${id}"]`))).toHaveCount(1);
  }
  await expect(actions).toHaveCount(6);
  await still(page);
  await shoot(page, info.project.name, 'run-inspect');
});

test('Sessions stays inside main, and every row’s way in wins its tap on a phone', async ({ page }, info) => {
  const fx = await fixture();
  const touch = info.project.name === PHONE || info.project.name.startsWith('tablet');
  await visit(page, { name: 'sessions-page', hash: '#/sessions' }, fx.anchor);
  await still(page);
  expect(await escapes(page, touch)).toEqual([]);
  await shoot(page, info.project.name, 'sessions-page');

  if (info.project.name !== PHONE) return;
  const links = page.locator('main a[href^="#/"]');
  const lost: string[] = [];
  for (let i = 0; i < Math.min(await links.count(), 12); i += 1) {
    const link = links.nth(i);
    if (!(await link.isVisible())) continue;
    const hit = await wins(link);
    if (!hit.wins) lost.push(`${hit.label}: the tap lands on ${hit.what}`);
  }
  expect(lost).toEqual([]);
});
