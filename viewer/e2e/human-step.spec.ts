/**
 * A person's turn, in a real browser (control-tower phase 42, criteria 3 and 7).
 *
 * The fixture console's own items (control-tower phase 137's `seedTurn`) hang
 * off `tower`'s last phases, which no run is on. This spec stages one more, on
 * its own pages only: `page.route` adds ONE running run (`ship`) to
 * `/api/runs`, ONE `human-step` row for it to `/api/inbox` and the item it is
 * to `/api/turn`, and answers the step's own routes — the ledger's list,
 * *Open*, and *Check now*, whose proof lands. Everything else is the fixture
 * console, unchanged.
 *
 *   3. the step summons its running run into Needs you, with the step's act
 *      as the strip's ONE action; it lights its family's lamp and counts in
 *      *Your turn (n)*; on `proven` the strip leaves Needs you with no reload;
 *   7. on a phone, the push's one tap (`#/approve?step=<id>`, the address an
 *      older push carries) lands on the item on Your turn (`#/turn/<id>`, phase
 *      137) in one hop, whole: the primary wins `elementFromPoint`, the code is
 *      selectable, nothing overflows.
 */

import { expect, test, type Page } from '@playwright/test';

import { layoutFindings, still } from './lib/probes.ts';
import { releaseRoutesAfterEach } from './lib/routes.ts';
import { fixture, shoot, visit } from './lib/shots.ts';

releaseRoutesAfterEach();

const PHONE = 'phone-360';
const DESK = 'desk-1280';
const STEP = 'human-step-e2e';
const RUN = 'e2e0000step1';
const LINK = 'https://example.com/device';

type Staged = { proven: boolean; opens: number };

function record(anchor: number, staged: Staged) {
  const at = (min: number) => new Date(anchor - min * 60_000).toISOString();
  return {
    id: STEP,
    kind: 'device-code',
    title: 'Pair the deploy CLI',
    where: 'any',
    birth: 'session',
    slug: 'ship',
    phase: 2,
    runId: RUN,
    sessionId: 'sess-e2e',
    openUrl: LINK,
    proof: 'cmd:"deploy whoami"',
    code: 'WDJB-MJHT',
    lines: ['Open the link on any device.', 'Type the code shown here, then press I did it.'],
    state: staged.proven ? 'proven' : 'notified',
    declaredAt: at(20),
    at: at(1),
    opened: staged.opens,
    windowEnd: new Date(anchor + 7 * 86_400_000).toISOString(),
    nextReminderAt: new Date(anchor + 15 * 60_000).toISOString(),
    moves: [{ state: 'notified', verb: 'notify', at: at(20), by: 'console', pushed: true }],
    ...(staged.proven ? { provenBy: 'a person' } : {}),
  };
}

function row(anchor: number) {
  return {
    id: `human-step:ship:2:${STEP}`,
    kind: 'human-step',
    severity: 'needs-you',
    slug: 'ship',
    phase: 2,
    runId: RUN,
    title: 'Your turn — enter a device code for ship phase 2',
    need: 'Pair the deploy CLI — code WDJB-MJHT',
    how: `From any device: open ${LINK}`,
    since: new Date(anchor - 20 * 60_000).toISOString(),
    actions: [
      {
        verb: 'check',
        label: "I've done this — check",
        endpoint: `/api/human-steps/${STEP}/check`,
        method: 'POST',
      },
    ],
    href: '/plan/ship/phase/2',
    category: { word: 'credentials', label: 'Credentials and accounts' },
    humanStep: {
      kind: 'device-code',
      label: 'Enter a device code',
      icon: 'smartphone',
      title: 'Pair the deploy CLI',
      where: 'any',
      state: 'notified',
      fold: null,
      lines: ['Open the link on any device.', 'Type the code shown here, then press I did it.'],
      proof: 'cmd:"deploy whoami"',
      offers: ['open', 'check'],
      stepId: STEP,
      openUrl: LINK,
      code: 'WDJB-MJHT',
    },
    // The item this row is — what the server folds onto every person-facing row
    // (`server/turn/fold.ts`); the strip's one action is its run's oldest item's.
    turn: {
      item: STEP,
      record: 'ledger',
      source: 'declared',
      kind: 'device-code',
      why: 'identity',
      proofType: 'probe',
      group: 'now',
    },
  };
}

/** The same step as Your turn holds it (`GET /api/turn`'s item). */
function turnItem(anchor: number) {
  const r = row(anchor);
  return {
    ...r,
    item: STEP,
    record: 'ledger',
    source: 'declared',
    kind: 'device-code',
    why: 'identity',
    proofType: 'probe',
    group: 'now',
    rows: [r.id],
    step: {
      id: STEP,
      kind: 'device-code',
      title: 'Pair the deploy CLI',
      state: 'notified',
      why: 'identity',
      whySource: 'inferred',
      proofType: 'probe',
      attempts: 0,
      waiters: [{ slug: 'ship', phase: 2, runId: RUN }],
      declaredAt: r.since,
      birth: 'session',
      proof: 'cmd:"deploy whoami"',
    },
  };
}

function ship(anchor: number, root: string) {
  const at = (min: number) => new Date(anchor - min * 60_000).toISOString();
  return {
    id: RUN,
    slug: 'ship',
    root,
    status: 'running',
    autonomy: 'keep-going',
    model: 'opus',
    createdAt: at(40),
    updatedAt: at(1),
    activePhase: 2,
    child: null,
    waitUntil: null,
    pause: null,
    freeze: null,
    spentUsd: 1.5,
    runBudgetUsd: null,
    phaseBudgetUsd: null,
    maxConsecutiveFailures: 4,
    consecutiveFailures: 0,
    halt: null,
    phases: {
      '1': { phase: 1, status: 'done', attempts: 1, costUsd: 1, startedAt: at(40), endedAt: at(25) },
      '2': { phase: 2, status: 'running', attempts: 1, costUsd: 0.5, startedAt: at(25) },
    },
  };
}

/** Stage the step on this page alone. The returned state is what the routes answer from. */
async function stage(page: Page, anchor: number, root: string): Promise<Staged> {
  const staged: Staged = { proven: false, opens: 0 };
  // A link opens in a new tab: recorded, never followed off the machine.
  await page.addInitScript(() => {
    (window as unknown as { __opened: unknown[] }).__opened = [];
    window.open = (...args: unknown[]) => {
      (window as unknown as { __opened: unknown[] }).__opened.push(args);
      return null;
    };
  });
  await page.route(
    (url) => url.pathname === '/api/runs',
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const runs = (await response.json()) as unknown[];
      await route.fulfill({ response, json: [...runs, ship(anchor, root)] });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/inbox',
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const view = (await response.json()) as { items: unknown[] };
      await route.fulfill({
        response,
        json: { ...view, items: staged.proven ? view.items : [row(anchor), ...view.items] },
      });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/turn',
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const turn = (await response.json()) as {
        groups: { now: unknown[] };
        counts: { now: number; total: number };
      };
      if (staged.proven) return route.fulfill({ response, json: turn });
      await route.fulfill({
        response,
        json: {
          ...turn,
          groups: { ...turn.groups, now: [turnItem(anchor), ...turn.groups.now] },
          counts: { ...turn.counts, now: turn.counts.now + 1, total: turn.counts.total + 1 },
        },
      });
    },
  );
  await page.route(
    (url) => url.pathname.startsWith('/api/human-steps'),
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === 'GET')
        return route.fulfill({
          json: {
            steps: [record(anchor, staged)],
            reminders: { series: [900_000, 3_600_000, 21_600_000, 86_400_000], quiet: null },
            can: { openHost: false, terminal: false, resume: true },
          },
        });
      if (path.endsWith('/open')) {
        staged.opens += 1;
        return route.fulfill({
          json: {
            ok: true,
            opened: { n: staged.opens, where: 'here', what: 'url', url: LINK },
            step: record(anchor, staged),
          },
        });
      }
      if (path.endsWith('/check')) {
        staged.proven = true;
        return route.fulfill({
          json: {
            ok: true,
            check: { landed: true, read: 'landed — exit 0', ref: 'cmd:"deploy whoami"' },
            resumed: { launched: true },
            step: record(anchor, staged),
          },
        });
      }
      return route.fulfill({ json: { ok: true, step: record(anchor, staged) } });
    },
  );
  return staged;
}

test('a step is a summons: Needs you, its act on the strip, its lamp, Your turn — and proven moves it, no reload', async ({
  page,
}, info) => {
  test.skip(![DESK, PHONE].includes(info.project.name), 'one desk and the phone carry the proof');
  const fx = await fixture();
  const staged = await stage(page, fx.anchor, fx.root);
  await visit(page, { name: 'human-step-tower', hash: '#/runs' }, fx.anchor);

  const strip = page.locator('[data-strip][data-slug="ship"]');
  await expect(strip).toHaveAttribute('data-bay', 'needs-you');
  await expect(strip.getByTestId('strip-action')).toHaveText('Open sign-in');
  // Its family's lamp is lit, and counts it — the seed's own signed-out run
  // lights the same lamp, so the step is read as one MORE.
  const lamp = page.locator('[data-testid="lamp"][data-category="credentials"]');
  await expect(lamp).toHaveAttribute('data-lit', 'true');
  const lit = async () => Number((await lamp.locator('span').last().textContent())?.trim() ?? 'NaN');
  const before = await lit();
  expect(before).toBeGreaterThanOrEqual(1);
  if (info.project.name === DESK)
    // The fixture's own items count too (phase 137's seed), so the number is
    // read, not written down; the lamp below proves the one this step adds.
    await expect(page.getByTestId('situation-line').first()).toContainText(/Your turn \(\d+\)/);

  // A marker a reload would wipe.
  await page.evaluate(() => void ((window as unknown as { __stayed: boolean }).__stayed = true));

  // The strip's one action opens the step here, in a new tab — the Tower stays.
  await strip.getByTestId('strip-action').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __opened: unknown[] }).__opened.length))
    .toBe(1);
  await expect.poll(() => staged.opens).toBe(1);

  // Expanded in place: the whole card, then the check — whose proof lands.
  await strip.getByTestId('strip-expand').click();
  const card = strip.getByTestId('human-step-card');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('step-code')).toHaveText('WDJB-MJHT');
  await still(page);
  await shoot(page, info.project.name, 'human-step-tower');

  await card.getByTestId('step-check').click();
  await expect(page.locator('[data-strip][data-slug="ship"]')).not.toHaveAttribute('data-bay', 'needs-you');
  expect(staged.proven).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __stayed?: boolean }).__stayed)).toBe(true);
  await expect.poll(lit).toBe(before - 1);
});

test('on a phone the push’s one tap lands on the item on Your turn: the action wins the thumb, the code selects, nothing overflows', async ({
  page,
}, info) => {
  test.skip(info.project.name !== PHONE, 'the lock screen is a phone’s');
  const fx = await fixture();
  await stage(page, fx.anchor, fx.root);
  // What an older push opens for the step (`#/approve?step=`); the worker now
  // opens `#/turn/<id>` itself (`shared/sw-push.js` `stepTarget`). One hop.
  await visit(page, { name: 'human-step-turn', hash: `#/approve?step=${STEP}` }, fx.anchor);
  await expect(page).toHaveURL(new RegExp(`#/turn/${STEP}$`));

  const card = page.locator(`[data-testid="turn-item"][data-item="${STEP}"]`);
  await expect(card).toHaveAttribute('aria-current', 'true');
  await expect(card.getByTestId('turn-title')).toHaveText('Pair the deploy CLI');

  const primary = card.getByTestId('turn-primary');
  await expect(primary).toHaveText('Open sign-in');
  await primary.scrollIntoViewIfNeeded();
  await still(page);
  const wins = await primary.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { hit: Boolean(hit && (hit === el || el.contains(hit))), height: r.height };
  });
  expect(wins.hit, 'the primary action wins its own centre').toBe(true);
  expect(wins.height).toBeGreaterThanOrEqual(44);

  const code = card.getByTestId('step-code');
  await expect(code).toHaveText('WDJB-MJHT');
  const select = await code.evaluate((el) => {
    const style = getComputedStyle(el);
    return style.userSelect || (style as unknown as { webkitUserSelect?: string }).webkitUserSelect;
  });
  expect(select).toBe('all');

  const findings = (await layoutFindings(page, { touch: true })).filter(
    (f) => f.cls === 'overflow' || f.cls === 'escape',
  );
  expect(findings).toEqual([]);
  await shoot(page, info.project.name, 'human-step-turn');
});
