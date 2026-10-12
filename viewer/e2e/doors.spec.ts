/**
 * The three doors, by thumb (quiet-console phase 27).
 *
 * Design law §1, principle 3: three doors to depth, the same on every page —
 * EXPAND in place, INSPECT (the panel: a bottom sheet below 900), EVERYTHING
 * (the toolbar's last slot; below 900 inside its one View sheet). The register
 * measures every stop as it first paints; a door is where a page changes shape
 * after that — a fold grows a row, the panel rises over the page, Everything
 * puts every column, fact and section back — and none of those states is a
 * stop. So here each door is opened, at the two touch widths (both under 900,
 * so both are the phone shell), on every destination and the two heads a
 * person acts on most, and the page is measured as the door left it:
 *
 *   - nothing overflows the viewport or escapes `<main>`, and no text is
 *     squeezed to nothing (the layout probe);
 *   - every control on screen keeps its thumb floor — present, winning its own
 *     box, surviving its clippers (the touch probe); with a sheet up, its own;
 *   - the door's own control wins a tap at its centre once it has moved: the
 *     fold's toggle, the inspector's tabs, the View button and the switch;
 *   - and the key bar: with a page's search focused and a keyboard taking the
 *     bottom of the screen, the field stays above it and still takes the tap.
 *
 * The pictures (`e2e/.shots/<viewport>/doors-<place>-<door>.png`) are for the
 * phase that changed a page to READ, as the tour's are.
 *
 * Where a destination keeps a door in one of its sections rather than on its
 * landing (Logs' records fold on Delivery; Settings' keys live on Everything;
 * Repo's richest list is the Issues desk, the one the fixture serves without a
 * git repository), the table says so — it is still that destination's door.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { layoutFindings, still, type Finding } from './lib/probes.ts';
import { VIEWPORTS, fixture, shoot, visit } from './lib/shots.ts';

/** The touch widths — the phone shell at both. */
const DOOR_PROJECTS: readonly string[] = ['phone-360', 'tablet-768'];

/** What the keyboard takes of each touch viewport's height, as a phone's and a tablet's do. */
const KEYBOARD: Readonly<Record<string, number>> = { 'phone-360': 320, 'tablet-768': 360 };

type Door = {
  /** The address the door is found at. */
  hash: string;
  /** The control that opens it, inside `<main>`. */
  control: (main: Locator) => Locator;
  /**
   * The folds to open first, in order, when the control lives inside them (a
   * row's Inspect) — each found inside the region the one before it drew.
   */
  within?: readonly ((scope: Locator) => Locator)[];
};

type Place = {
  /** The destination or head — the picture's stem. */
  name: string;
  expand: Door;
  inspect: Door;
  /** Where the page's Everything switch is, in its View sheet. */
  everything: string;
};

const fold = (name: RegExp) => (main: Locator) => main.getByRole('button', { name, expanded: false }).first();
const inspectButton = (main: Locator) => main.getByRole('button', { name: 'Inspect', exact: true }).first();
const details = fold(/^Details\b/);

/**
 * Every destination's three doors, and the two heads a person acts on most. A
 * destination added to `shared/route-meta.js` fails the coverage test below
 * until it has a row here.
 */
const PLACES: readonly Place[] = [
  {
    name: 'runs',
    // A run's line expands in place; its account goes to the panel from inside it.
    expand: { hash: '#/runs', control: fold(/^Everything about /) },
    inspect: { hash: '#/runs', within: [fold(/^Everything about /)], control: inspectButton },
    everything: '#/runs',
  },
  {
    name: 'plans',
    expand: { hash: '#/plans', control: details },
    inspect: { hash: '#/plans', within: [details], control: inspectButton },
    everything: '#/plans',
  },
  {
    name: 'sessions',
    expand: { hash: '#/sessions', control: details },
    inspect: { hash: '#/sessions', within: [details], control: inspectButton },
    everything: '#/sessions',
  },
  {
    name: 'repo',
    // The Issues desk: an issue's record folds open; its title opens it in the panel.
    expand: { hash: '#/repo/issues?state=all', control: details },
    inspect: { hash: '#/repo/issues?state=all', control: (main) => main.locator('a[data-row-link]').first() },
    everything: '#/repo/issues?state=all',
  },
  {
    name: 'insights',
    // A question's numbers fold open; a run's spend goes to the panel from its
    // record, under What it costs' runs (folded at first paint).
    expand: { hash: '#/insights', control: fold(/^The days, in full\b/) },
    inspect: {
      hash: '#/insights',
      within: [(main) => fold(/^The runs\b/)(main.getByTestId('insights-cost')), details],
      control: inspectButton,
    },
    everything: '#/insights',
  },
  {
    name: 'logs',
    // Delivery's records fold open; a log line is its own way into the panel.
    expand: { hash: '#/logs/delivery', control: details },
    inspect: { hash: '#/logs', control: (main) => main.getByTestId('log-line').first() },
    everything: '#/logs',
  },
  {
    name: 'settings',
    // Every key, on Everything: a key's facts fold open; its record goes to the panel.
    expand: { hash: '#/settings/everything', control: details },
    inspect: { hash: '#/settings/everything', within: [details], control: inspectButton },
    everything: '#/settings/everything',
  },
  {
    name: 'turn',
    expand: { hash: '#/turn', control: fold(/^The history: who raised it/) },
    inspect: { hash: '#/turn', control: inspectButton },
    everything: '#/turn',
  },
  {
    name: 'plan',
    expand: { hash: '#/plan/tower/phases', control: details },
    inspect: {
      hash: '#/plan/tower/phases',
      control: (main) => main.getByRole('button', { name: /^Inspect phase \d+$/ }).first(),
    },
    everything: '#/plan/tower/phases',
  },
];

/* ---------------- the measurements ---------------- */

const show = (found: readonly Finding[]): string => found.map((f) => `${f.cls}: ${f.key}`).join('\n  ');

/** The page as the door left it: the layout and every touch question, the same ones the register asks. */
async function measure(page: Page, what: string): Promise<void> {
  await still(page);
  const found = await layoutFindings(page, { touch: true });
  expect(found, `${what}:\n  ${show(found)}`).toEqual([]);
}

/**
 * Does a tap at the control's centre land on it (or inside it)? Asked once it
 * is on screen: a control under a sticky bar, or under the sheet that opened
 * over it, loses the tap to whatever is drawn there.
 */
async function wins(page: Page, control: Locator, what: string): Promise<void> {
  await control.scrollIntoViewIfNeeded();
  await still(page);
  const hit = await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      wins: Boolean(top && (top === el || el.contains(top))),
      what: top ? top.outerHTML.replace(/\s+/g, ' ').slice(0, 160) : 'nothing',
    };
  });
  expect(hit.wins, `${what}: a tap at its centre lands on ${hit.what}`).toBe(true);
}

/**
 * Open a fold and hand back the region it drew (`aria-controls`) and the
 * toggle itself — held as an element, because a toggle says a different name
 * once open ("Hide details"), and the locator that found it shut would find
 * the next shut one instead.
 */
async function open(page: Page, toggle: Locator, what: string): Promise<{ region: Locator; held: Locator }> {
  await expect(toggle, `${what}: the fold starts shut`).toHaveAttribute('aria-expanded', 'false');
  const mark = `door-${Math.random().toString(36).slice(2)}`;
  await toggle.evaluate((el, m) => el.setAttribute('data-door', m), mark);
  const held = page.locator(`[data-door="${mark}"]`);
  await held.click();
  await expect(held, `${what}: the fold opens`).toHaveAttribute('aria-expanded', 'true');
  const id = await held.getAttribute('aria-controls');
  expect(id, `${what}: the open fold names the region it drew`).toBeTruthy();
  const region = page.locator(`[id="${id}"]`);
  await expect(region, `${what}: the region is drawn`).toBeVisible();
  return { region, held };
}

const skipOffTouch = (project: string) =>
  test.skip(!DOOR_PROJECTS.includes(project), 'the doors by thumb are the touch widths’ question');

/* ---------------- the doors ---------------- */

for (const place of PLACES) {
  test.describe(`${place.name}’s doors`, () => {
    test('expand: a record opens in place, and the page still fits', async ({ page }, info) => {
      skipOffTouch(info.project.name);
      const fx = await fixture();
      await visit(page, { name: `doors-${place.name}`, hash: place.expand.hash }, fx.anchor);
      const toggle = place.expand.control(page.locator('main'));
      await expect(toggle, `${place.name}: a fold to open`).toBeVisible();
      const { held } = await open(page, toggle, place.name);
      await measure(page, `${place.name}, a record expanded`);
      // The toggle is the way back, and it must still take the tap where it now stands.
      await wins(page, held, `${place.name}: the open fold's toggle`);
      await shoot(page, info.project.name, `doors-${place.name}-expand`);
    });

    test('inspect: the record rises from the bottom, whole, and its tabs take the tap', async ({
      page,
    }, info) => {
      skipOffTouch(info.project.name);
      const viewport = VIEWPORTS.find((v) => v.name === info.project.name)!;
      const fx = await fixture();
      await visit(page, { name: `doors-${place.name}`, hash: place.inspect.hash }, fx.anchor);
      const main = page.locator('main');
      let scope = main;
      for (const holder of place.inspect.within ?? []) {
        scope = (await open(page, holder(scope), `${place.name}, the fold holding Inspect`)).region;
      }
      const trigger = place.inspect.control(scope);
      await expect(trigger, `${place.name}: a way into the panel`).toBeVisible();
      await trigger.click();

      const sheet = page.locator('[role="dialog"][data-panel="details"]');
      await expect(sheet, `${place.name}: the panel opens`).toBeVisible();
      const record = sheet.locator('[data-inspector]');
      await expect(record, `${place.name}: it holds the record`).toBeVisible();
      await expect(record.locator('h2').first()).not.toBeEmpty();
      await still(page);

      // A bottom sheet: the whole width, standing on the bottom edge, never the whole height.
      const box = (await sheet.boundingBox())!;
      expect(Math.round(box.x), `${place.name}: the sheet starts at the edge`).toBe(0);
      expect(Math.round(box.width), `${place.name}: the sheet is the screen's width`).toBe(viewport.width);
      expect(Math.round(box.y + box.height), `${place.name}: the sheet stands on the bottom`).toBe(
        viewport.height,
      );
      expect(box.height, `${place.name}: the page shows above the sheet`).toBeLessThan(viewport.height);

      await measure(page, `${place.name}, the record in the panel`);
      const tabs = record.getByRole('tab');
      for (let i = 0; i < (await tabs.count()); i += 1) {
        await wins(
          page,
          tabs.nth(i),
          `${place.name}: the inspector's ${await tabs.nth(i).textContent()} tab`,
        );
      }
      await shoot(page, info.project.name, `doors-${place.name}-inspect`);

      await page.keyboard.press('Escape');
      await expect(sheet, `${place.name}: Escape puts the record away`).toBeHidden();
    });

    test('everything: the switch in the View sheet turns the page into all of it, and the page still fits', async ({
      page,
    }, info) => {
      skipOffTouch(info.project.name);
      const fx = await fixture();
      await visit(page, { name: `doors-${place.name}`, hash: place.everything }, fx.anchor);
      const main = page.locator('main');
      const view = main.locator('[data-slot="view-sheet"]');
      await expect(view, `${place.name}: the View sheet's button`).toBeVisible();
      await wins(page, view, `${place.name}: View`);
      await view.click();

      const sheet = page.getByRole('dialog', { name: 'View' });
      await expect(sheet).toBeVisible();
      const flip = sheet.getByRole('switch', { name: 'Everything' });
      await expect(flip).toHaveAttribute('aria-checked', 'false');
      await wins(page, flip, `${place.name}: the Everything switch`);
      await flip.click();
      await expect(flip).toHaveAttribute('aria-checked', 'true');
      await expect(sheet.getByRole('status')).toHaveText(/^Showing everything/);
      await measure(page, `${place.name}, the View sheet with Everything on`);

      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      // The button counts what is in force, Everything included.
      await expect(view).toHaveAccessibleName(/^View, \d+ in use$/);
      await measure(page, `${place.name}, with Everything on`);
      await page.locator('main').evaluate((el) => el.scrollTo({ top: 0, behavior: 'instant' }));
      await shoot(page, info.project.name, `doors-${place.name}-everything`);
    });

    test('the key bar: a focused search stays above the keyboard and takes the tap', async ({
      page,
    }, info) => {
      skipOffTouch(info.project.name);
      const viewport = VIEWPORTS.find((v) => v.name === info.project.name)!;
      const fx = await fixture();
      await visit(page, { name: `doors-${place.name}`, hash: place.everything }, fx.anchor);
      const search = page.locator('main input[type="search"]').first();
      test.skip((await search.count()) === 0, `${place.name} has no search on its bar`);
      await search.focus();
      const height = viewport.height - KEYBOARD[info.project.name]!;
      await page.setViewportSize({ width: viewport.width, height });
      // What the browser does when a keyboard rises under a focused field
      // (`interactive-widget=resizes-content`): it scrolls the field into what
      // is left of the screen. The question is whether anything of the page's
      // own — a bar, a sheet, the tab bar riding the keyboard — then covers it.
      await search.scrollIntoViewIfNeeded();
      await still(page);
      await expect(search).toBeFocused();
      const box = (await search.boundingBox())!;
      expect(box.y + box.height, `${place.name}: the search sits above the keyboard`).toBeLessThanOrEqual(
        height,
      );
      await wins(page, search, `${place.name}: the search with the keyboard up`);
      const found = (await layoutFindings(page, { touch: true })).filter(
        (f) => f.cls === 'overflow' || f.cls === 'escape',
      );
      expect(found, `${place.name}, with the keyboard up:\n  ${show(found)}`).toEqual([]);
      await expect(search).toBeFocused();
    });
  });
}

/* ---------------- motion ---------------- */

/** One motion that started: an animation by its keyframes' name, a transition by its property. */
type Motion = { kind: 'animation' | 'transition'; name: string; seconds: number; iterations: string };

declare global {
  interface Window {
    __motions?: Motion[];
  }
}

/**
 * Write down every animation and transition that STARTS from now on, with the
 * duration and the iteration count the cascade gave it at that moment — read
 * from the element's computed style, so the reduced-motion rule's answer is
 * what is recorded, not the class that asked for the motion.
 */
function recordMotions(): void {
  const seconds = (value: string) => (value.endsWith('ms') ? parseFloat(value) / 1000 : parseFloat(value));
  const pick = (list: string, names: string, name: string) => {
    const all = list.split(',').map((s) => s.trim());
    const at = names.split(',').map((s) => s.trim());
    const i = Math.max(0, at.indexOf(name), at.indexOf('all'));
    return all[i % all.length] ?? all[0] ?? '';
  };
  window.__motions = [];
  document.addEventListener(
    'animationstart',
    (event) => {
      const style = getComputedStyle(event.target as Element);
      window.__motions!.push({
        kind: 'animation',
        name: event.animationName,
        seconds: seconds(pick(style.animationDuration, style.animationName, event.animationName)),
        iterations: pick(style.animationIterationCount, style.animationName, event.animationName),
      });
    },
    true,
  );
  document.addEventListener(
    'transitionrun',
    (event) => {
      const style = getComputedStyle(event.target as Element);
      window.__motions!.push({
        kind: 'transition',
        name: event.propertyName,
        seconds: seconds(pick(style.transitionDuration, style.transitionProperty, event.propertyName)),
        iterations: '1',
      });
    },
    true,
  );
}

/**
 * The doors move only for a reader who welcomes it (design.md §5; the browser
 * half of the phase's fourth criterion — `client/src/shell/motion.test.tsx`
 * holds the stylesheets). One page, the three motions and the expand, under
 * both answers to `prefers-reduced-motion`: with no preference the inspector's
 * sheet RISES, its scrim FADES, a run's row grows its region and the live
 * running dot breathes for ever — which is what proves the recorder sees them —
 * and under `reduce` every one of them is over in 0.01 ms, once.
 */
for (const preference of ['no-preference', 'reduce'] as const) {
  test(`motion: the three motions and the expand, with prefers-reduced-motion ${preference}`, async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'phone-360', 'one width says it');
    await page.emulateMedia({ reducedMotion: preference });
    await page.addInitScript(recordMotions);
    const fx = await fixture();
    await visit(page, { name: 'doors-motion', hash: '#/runs' }, fx.anchor);

    // The one continuing motion: a live running thing, observed — a track's
    // live station, a status dot told it is live. Found by what asks for the
    // pulse, so the reading under `reduce` is of the same marks.
    const pulses = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          'main .ui-station[data-live] > .ui-station-dot, main .animate-pulse-soft',
        ),
      ]
        .map((el) => getComputedStyle(el))
        .map((s) => ({
          name: s.animationName,
          duration: s.animationDuration,
          iterations: s.animationIterationCount,
        })),
    );
    expect(pulses.length, 'a live running thing on the home').toBeGreaterThan(0);

    await page.evaluate(() => (window.__motions = []));
    const { region } = await open(page, fold(/^Everything about /)(page.locator('main')), 'a run');
    await region.getByRole('button', { name: 'Inspect', exact: true }).click();
    await expect(page.locator('[role="dialog"][data-panel="details"]')).toBeVisible();
    await page.waitForTimeout(400);
    const moved = await page.evaluate(() => window.__motions ?? []);
    const find = (kind: Motion['kind'], name: string) =>
      moved.filter((m) => m.kind === kind && m.name === name);

    if (preference === 'no-preference') {
      expect(pulses.every((p) => p.name === 'pulse-soft' && p.iterations === 'infinite')).toBe(true);
      expect(
        find('animation', 'rise').some((m) => m.seconds >= 0.2),
        'the sheet rises',
      ).toBe(true);
      expect(
        find('animation', 'fade').some((m) => m.seconds >= 0.1),
        'the scrim fades',
      ).toBe(true);
      expect(
        find('transition', 'grid-template-rows').some((m) => m.seconds >= 0.2),
        'the row grows its region',
      ).toBe(true);
    } else {
      // Stopped outright by its own sheet (`animation: none` beside it), or
      // flattened by the blanket rule to one 0.01 ms beat — never a breath.
      expect(
        pulses.filter((p) => p.name !== 'none' && !(p.duration === '1e-05s' && p.iterations === '1')),
        'the live mark is still',
      ).toEqual([]);
      expect(moved.length, 'the doors still opened, and the recorder still heard them').toBeGreaterThan(0);
      expect(
        moved.filter((m) => m.seconds > 0.0001 || (m.iterations !== '1' && m.kind === 'animation')),
        'nothing moves for a reader who asked it not to',
      ).toEqual([]);
    }
  });
}

test('every destination has its row in the doors’ table', async ({}, info) => {
  skipOffTouch(info.project.name);
  const { DESTINATIONS } = await import('../shared/route-meta.js');
  const named = new Set(PLACES.map((p) => p.name));
  expect((DESTINATIONS as readonly string[]).filter((d) => !named.has(d))).toEqual([]);
});
