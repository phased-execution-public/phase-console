import { expect, test } from '@playwright/test';

import { axeFindings, focusFindings, layoutFindings, still, type Finding } from './lib/probes.ts';

// The probes must FAIL on a page that is broken the ways this console has
// actually been broken. A probe that reports nothing on a clean page proves
// nothing — `register.spec.ts` would pass just as happily over a probe that
// stopped measuring — so every class is shown a defect it has to name, beside
// a control that must stay clean so an always-failing probe is caught too.
//
// The first case is the one `docs/design.md` §6.1 was written about: a control
// its ANCESTOR clips. Where the ancestor hides the control, the ancestor is what
// the point hits, so a probe that accepts `hit.contains(el)` scores the defect
// as a pass. Three shipped defects were scored that way.

const BROKEN = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin: 0; font: 16px/1.4 system-ui, sans-serif; color: #111; background: #fff; }
  main { display: block; width: 320px; height: 600px; overflow-x: hidden; overflow-y: auto; }
  button { height: 44px; min-width: 44px; border: 1px solid #333; background: #eee; color: #111; }
  button:focus-visible { outline: 2px solid #111; outline-offset: 2px; }
  .ghost:focus, .ghost:focus-visible { outline: none; box-shadow: none; }
  .group { display: inline-flex; overflow: hidden; width: 30px; }
  .scroller { display: flex; overflow-x: auto; width: 120px; }
  .scroller button { flex: none; width: 100px; }
  .pill { border-radius: 9999px; width: 96px; }
  .shell { height: 120px; overflow: hidden; }
  .shell > .pane { height: 120px; overflow-y: auto; }
  .sliver { height: 20px; overflow: hidden; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .meta { display: flex; width: 200px; gap: 8px; }
  .meta .tag { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta .fixed { flex: none; white-space: nowrap; width: 200px; }
  .meta .floor { min-width: 3ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style></head>
<body>
  <header><div id="banner" style="width: 2000px">Banner wider than any phone</div></header>
  <main>
    <div style="width: 600px">Row that escapes main</div>
    <p><span class="group"><button style="width: 60px">Clipped</button></span></p>
    <p style="position: relative; height: 44px">
      <button style="position: absolute; left: 0; top: 0; width: 120px">Under</button>
      <button style="position: absolute; left: 60px; top: 0; width: 80px">Cover</button>
    </p>
    <p><button style="pointer-events: none">Deaf</button></p>
    <p><button class="pill">Pill</button> <button>Fine</button></p>
    <div class="scroller"><button>One</button><button>Two</button><button>Three</button></div>
    <div class="shell"><div class="pane">
      <div style="height: 300px">Tall content</div>
      <button>Below the fold</button>
      <div class="sliver"><button>Sliver</button></div>
    </div></div>
    <details><summary>Folded</summary><button>Folded away</button></details>
    <details open><summary>Unfolded</summary><button style="pointer-events: none">Unfolded deaf</button></details>
    <p><span class="sr">Only for screen readers, and long enough to be wide</span></p>
    <p class="meta"><span class="tag">squeezed tag</span><span class="fixed">a range estimate</span></p>
    <p class="meta"><span class="floor">floored tag</span><span class="fixed">a range estimate</span></p>
    <p style="color: #c8c8c8; background: #fff">Faint text nobody can read</p>
    <p><button class="ghost">Ghost</button></p>
  </main>
</body></html>`;

const keys = (found: Finding[], cls: Finding['cls']): string[] =>
  found.filter((f) => f.cls === cls).map((f) => f.key);

test.describe('the probes fail on a deliberately broken page', () => {
  test.beforeEach(async ({ page }, info) => {
    // One project is enough: the page is synthetic and sized for itself.
    test.skip(info.project.name !== 'phone-360', 'synthetic page — measured once');
    await page.setContent(BROKEN);
  });

  test('escape: a row wider than main is named, the scroller and the sr-only span are not', async ({
    page,
  }) => {
    const found = await layoutFindings(page, { touch: false });
    expect(keys(found, 'escape')).toContain('div "Row that escapes main"');
    expect(keys(found, 'escape').join('\n')).not.toMatch(/screen readers|One|Two|Three/);
  });

  test('overflow: a header wider than the viewport is named', async ({ page }) => {
    const found = await layoutFindings(page, { touch: false });
    expect(keys(found, 'overflow')).toContain('div "Banner wider than any phone"');
  });

  test('squeezed: a tag its row gave zero width is named; a floored tag and an sr-only span are not (#203)', async ({
    page,
  }) => {
    const found = await layoutFindings(page, { touch: false });
    expect(keys(found, 'squeezed')).toEqual(['span "squeezed tag"']);
  });

  test('touch: the clipped control fails WINS and SURVIVES — its ancestor answering is not a pass', async ({
    page,
  }) => {
    const found = await layoutFindings(page, { touch: true });
    expect(keys(found, 'touch-wins')).toContain('button "Clipped"');
    expect(keys(found, 'touch-survives')).toContain('button "Clipped"');
  });

  test('touch: a control another control covers does not win', async ({ page }) => {
    const found = await layoutFindings(page, { touch: true });
    expect(keys(found, 'touch-wins')).toContain('button "Under"');
    expect(keys(found, 'touch-wins')).not.toContain('button "Cover"');
  });

  test('touch: a control the pointer cannot reach is not present', async ({ page }) => {
    const found = await layoutFindings(page, { touch: true });
    expect(keys(found, 'touch-present')).toContain('button "Deaf"');
  });

  test('touch: whole controls, a rounded one and a scroller’s tail are clean', async ({ page }) => {
    const found = await layoutFindings(page, { touch: true });
    const named = found.filter((f) => f.cls.startsWith('touch-')).map((f) => f.key);
    for (const clean of [
      'button "Fine"',
      'button "Pill"',
      'button "One"',
      'button "Two"',
      'button "Three"',
    ]) {
      expect(named).not.toContain(clean);
    }
  });

  test('touch: below the fold of a scroller in a clipping shell is reachable; an inner sliver is not', async ({
    page,
  }) => {
    const found = await layoutFindings(page, { touch: true });
    expect(keys(found, 'touch-survives')).not.toContain('button "Below the fold"');
    expect(keys(found, 'touch-survives')).toContain('button "Sliver"');
  });

  test('touch: a closed disclosure’s body is not on screen; an open one’s is asked', async ({ page }) => {
    // Chromium keeps a closed <details>' body laid out behind
    // `content-visibility: hidden`: its controls have rectangles, and are never
    // painted or hit. The phase table's cards fold their hidden columns — the
    // recovery buttons among them — into one, and the register named every one
    // `touch-present` (control-tower phase 23).
    const found = await layoutFindings(page, { touch: true });
    const named = found.filter((f) => f.cls.startsWith('touch-')).map((f) => f.key);
    expect(named).not.toContain('button "Folded away"');
    expect(keys(found, 'touch-present')).toContain('button "Unfolded deaf"');
  });

  test('touch: behind an open modal only the dialog is asked', async ({ page }) => {
    await page.evaluate(() => {
      document.body.style.pointerEvents = 'none';
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.style.cssText = 'position: fixed; left: 0; top: 0; pointer-events: auto; background: #fff';
      dialog.innerHTML = '<button style="pointer-events: none">Dialog deaf</button>';
      document.body.append(dialog);
    });
    const found = await layoutFindings(page, { touch: true });
    expect(keys(found, 'touch-present')).toEqual(['button "Dialog deaf"']);
  });

  test('axe: faint text fails colour contrast', async ({ page }) => {
    const found = await axeFindings(page, 'light');
    expect(
      keys(found, 'axe').filter((k) => k.startsWith('color-contrast/light p #c8c8c8 on #ffffff')),
    ).toHaveLength(1);
  });

  test('focus: a control whose ring is removed is named, one with a ring is not', async ({ page }) => {
    const found = await focusFindings(page);
    expect(keys(found, 'focus')).toContain('button "Ghost"');
    expect(keys(found, 'focus')).not.toContain('button "Fine"');
  });
});

test.describe('the probes see the real console', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'phone-360', 'one real page is enough');
  });

  test('re-breaking <main> on the real Runs page is measured as escape', async ({ page }) => {
    await page.goto('/#/runs');
    await expect(page.locator('main')).toBeVisible();
    const before = keys(await layoutFindings(page, { touch: false }), 'escape');
    // What a missing `min-w-0` does to one row, done on purpose: a child that
    // may not shrink, three phones wide, inside the one scroller.
    await page.evaluate(() => {
      const row = document.createElement('div');
      row.textContent = 'Re-broken row';
      row.style.width = '1080px';
      document.querySelector('main')?.prepend(row);
    });
    const after = keys(await layoutFindings(page, { touch: false }), 'escape');
    expect(before).not.toContain('div "Re-broken row"');
    expect(after).toContain('div "Re-broken row"');
  });

  // `still()` is what every axe reading stands on: a theme switch must have
  // LANDED before contrast is read. theme.css's reduced-motion rule (the tour
  // always emulates `reduce`) gives every element a 0.01 ms transition on
  // `all`, so a colour that lands on a parent moves its children's inherited
  // and currentColor paint the next time style is read, and their transitions
  // start a frame later — up to 12 frames of them on the plan page. Read
  // mid-cascade, text is the old theme's ink on the new ground: gate 3 of
  // control-tower phase 34 failed on exactly that, gone a moment later.
  test('still: after a theme switch nothing is left running for a reading to catch mid-flight', async ({
    page,
  }) => {
    await page.goto('/#/runs');
    await expect(page.locator('main')).toBeVisible();
    await page.emulateMedia({ colorScheme: 'light' });
    await still(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await still(page);
    const running = await page.evaluate(
      () => document.getAnimations().filter((a) => a.playState === 'running' || a.pending).length,
    );
    expect(running).toBe(0);
  });
});
