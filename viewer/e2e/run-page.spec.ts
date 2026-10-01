/**
 * The run page and Sessions at a phone's width (control-tower phase 24, exit
 * criterion 6): nothing overflows `main`, folded or unfolded, and every tap
 * target the page opens on — the strip's action, each fold's row, the
 * settings verb — wins its own hit test at the thumb's height.
 *
 * The run page opens on a glance since phase 24: the run's strip as its header
 * and every other section folded under a row that names it. A fold's row is
 * the thing a thumb presses most on this page, so each one is hit-tested, and
 * the page is read again with every fold open — a section that only overflows
 * once shown is still an overflow.
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

test('the run page opens on its strip and folds, and stays inside main — folded and unfolded', async ({
  page,
}, info) => {
  const fx = await fixture();
  expect(fx.live, `the fixture's run must be live (${fx.why ?? ''})`).toBe(true);
  const touch = info.project.name === PHONE || info.project.name.startsWith('tablet');

  await visit(page, { name: 'run-page', hash: '#/plan/tower/run' }, fx.anchor);
  await expect(page.getByTestId('run-head')).toBeVisible();
  await expect(page.getByTestId('run-head').locator('[data-strip][data-variant="row"]')).toBeVisible();
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
