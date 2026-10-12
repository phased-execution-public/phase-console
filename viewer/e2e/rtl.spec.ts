import { expect, test, type Page } from '@playwright/test';

import { layoutFindings } from './lib/probes.ts';
import { STOPS, VIEWPORTS, fixture, settle, shoot, visit, type Stop } from './lib/shots.ts';

// RTL is a switch away (control-tower phase 31; every stop since quiet-console
// phase 27). The kit, the cards, the shell and the screens set their spacing,
// insets, borders and alignment in LOGICAL properties (`ms-`/`me-`, `ps-`/`pe-`,
// `start-`/`end-`, `margin-inline-*` — `client/src/styles/logical.test.ts`
// holds them there), so flipping `dir` on the document mirrors the page rather
// than breaking it. The proof is every stop of the tour — every destination,
// every head, the deeper sections and the three overlays — measured with
// `dir="rtl"` in all four viewports: nothing slides past the viewport's edge,
// nothing escapes `<main>`, and the document is no wider than the screen.

/** Throw the switch and let the mirrored page settle. */
async function mirror(page: Page): Promise<void> {
  await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
  await settle(page);
}

async function fits(page: Page, what: string, touch: boolean): Promise<void> {
  const width = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(width.scroll, `${what}: the document is wider than the screen in RTL`).toBeLessThanOrEqual(
    width.client,
  );
  const found = (await layoutFindings(page, { touch })).filter(
    (f) => f.cls === 'overflow' || f.cls === 'escape',
  );
  expect(found, `${what}: overflow in RTL`).toEqual([]);
}

for (const stop of STOPS) {
  test(`with dir="rtl" ${stop.name} mirrors and nothing overflows`, async ({ page }, info) => {
    const viewport = VIEWPORTS.find((v) => v.name === info.project.name);
    if (!viewport) throw new Error(`no viewport named ${info.project.name}`);
    const fx = await fixture();
    await visit(page, stop, fx.anchor);
    await mirror(page);

    // The switch took: the document and the shell really are right-to-left.
    const dir = await page.evaluate(() => ({
      doc: getComputedStyle(document.documentElement).direction,
      main: getComputedStyle(document.querySelector('main')!).direction,
    }));
    expect(dir).toEqual({ doc: 'rtl', main: 'rtl' });
    await fits(page, `${viewport.name} ${stop.name}`, viewport.touch);
  });
}

/**
 * English in a right-to-left document keeps its own order (quiet-console phase
 * 27, phase 8's deferral). A paragraph's base direction is its document's, so
 * under `dir="rtl"` the browser's bidi algorithm moved an English sentence's
 * leading number to its far end ("need you now — the oldest 14"), its trailing
 * full stop to its front (".Read at 06:13 PM") and an ordered step's number
 * after its words. Prose finds its own direction now (`unicode-bidi:
 * plaintext` on the text blocks, `styles/theme.css`) — the way the guide's
 * Persian finds its — so the measurement is the one a reader makes: in a line
 * of English, the first character stands left of the last. It is asked of each
 * RUN of text: a block's text grouped by the box it is laid out in (one inline
 * formatting context). Two boxes — a label and its count drawn as two flex
 * items, a number and its caption — trade places under `dir="rtl"` by design
 * ("In flight 0 · Ready now 13"), so each is read on its own, never across.
 */
const PROSE_STOPS: readonly Stop[] = [
  { name: 'turn', hash: '#/turn' },
  { name: 'runs', hash: '#/runs' },
  { name: 'insights', hash: '#/insights' },
  { name: 'settings-instance', hash: '#/settings/instance' },
];

for (const stop of PROSE_STOPS) {
  test(`with dir="rtl" English prose on ${stop.name} keeps its own order`, async ({ page }, info) => {
    test.skip(info.project.name !== 'phone-360' && info.project.name !== 'desk-1280', 'two widths say it');
    const fx = await fixture();
    await visit(page, stop, fx.anchor);
    await mirror(page);
    const read = await page.evaluate(() => {
      // Text whose first or last character is one the bidi algorithm moves: a
      // leading number or mark, a trailing full stop or bracket — the shapes
      // that read reversed under a right-to-left base direction.
      const SHAPED = /^[\d(“"'‘[]|[.?!:)”"'’\]…]$/;
      // The box a text node is laid out in: its nearest ancestor that is neither
      // an inline nor `display: contents` — a flex item is blockified, so it is one.
      const boxOf = (node: Node): Element | null => {
        let el = node.parentElement;
        while (el && /^(inline|contents)$/.test(getComputedStyle(el).display)) el = el.parentElement;
        return el;
      };
      const at = (node: Text, i: number) => {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        return range.getBoundingClientRect();
      };
      const blocks = [...document.querySelectorAll('main p, main h1, main h2, main h3, main li, main dd')];
      const turned: string[] = [];
      let asked = 0;
      for (const el of blocks) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
          acceptNode: (n) =>
            (n.textContent ?? '').trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
        });
        // The block's runs: its text grouped by the box each piece is laid out in.
        const runs = new Map<Element | null, Text[]>();
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const box = boxOf(n);
          runs.set(box, [...(runs.get(box) ?? []), n as Text]);
        }
        for (const nodes of runs.values()) {
          const text = nodes
            .map((n) => n.textContent)
            .join('')
            .trim();
          if (!/[A-Za-z]{3}/.test(text) || /[֐-ࣿ]/.test(text)) continue; // English only
          if (!(SHAPED.test(text[0]!) || SHAPED.test(text[text.length - 1]!))) continue;
          const firstNode = nodes[0]!;
          const lastNode = nodes[nodes.length - 1]!;
          const first = at(firstNode, firstNode.textContent!.search(/\S/));
          const last = at(lastNode, lastNode.textContent!.trimEnd().length - 1);
          if (!first.width || !last.width) continue;
          // One line only: across a wrap the first character may stand right of the last.
          if (Math.abs(first.top - last.top) > 2) continue;
          asked += 1;
          if (first.left > last.left) turned.push(text.slice(0, 60));
        }
      }
      return { asked, turned };
    });
    expect(read.asked, `${stop.name}: English lines to read`).toBeGreaterThan(0);
    expect(read.turned, `${stop.name}: English read backwards in RTL`).toEqual([]);
  });
}

// Your turn mirrored (quiet-console phase 8): the page's sections, its cards
// and their moves are set in logical properties like the shell, so with
// `dir="rtl"` the whole page mirrors — the headline, the toolbar, the section
// headings with their counts, the guide's track inside each card — and nothing
// slides past an edge. The picture is the one the phase's handoff reads at 360
// and at 1280.
test('with dir="rtl" Your turn mirrors and nothing overflows', async ({ page }, info) => {
  const viewport = VIEWPORTS.find((v) => v.name === info.project.name);
  if (!viewport) throw new Error(`no viewport named ${info.project.name}`);
  const fx = await fixture();
  await visit(page, { name: 'turn-mirrored', hash: '#/turn' }, fx.anchor);
  await mirror(page);

  const dir = await page.evaluate(() => ({
    doc: getComputedStyle(document.documentElement).direction,
    page: getComputedStyle(document.querySelector('[data-turn-page]')!).direction,
  }));
  expect(dir).toEqual({ doc: 'rtl', page: 'rtl' });
  await fits(page, `${viewport.name} Your turn`, viewport.touch);
  await page.evaluate(() => document.querySelector('main')?.scrollTo(0, 0));
  await settle(page);
  await shoot(page, info.project.name, 'turn-rtl');
});

// A guide carries its language (control-tower phase 137, §Architecture 19
// "Language"): the fixture's Persian item is drawn right-to-left inside a
// left-to-right page, its command left-to-right, its inline code and its
// numbers isolated so they keep their own order — and still nothing overflows.
test('a Persian guide on Your turn is right-to-left, its command and numbers left-to-right', async ({
  page,
}, info) => {
  const viewport = VIEWPORTS.find((v) => v.name === info.project.name);
  if (!viewport) throw new Error(`no viewport named ${info.project.name}`);
  const fx = await fixture();
  await visit(page, { name: 'turn-rtl', hash: '#/turn/turn-now-fa' }, fx.anchor);
  const guide = page.locator('[data-item="turn-now-fa"] [data-testid="turn-guide"]');
  await expect(guide).toHaveAttribute('dir', 'rtl');
  await expect(guide).toHaveAttribute('lang', 'fa');
  const read = await guide.evaluate((el) => ({
    guide: getComputedStyle(el).direction,
    command: getComputedStyle(el.querySelector('[data-testid="guide-command"]')!).direction,
    code: [...el.querySelectorAll('code')].every((code) => getComputedStyle(code).direction === 'ltr'),
    number: [...el.querySelectorAll('bdi[dir="ltr"]')].some((bdi) => /\d/.test(bdi.textContent ?? '')),
  }));
  expect(read).toEqual({ guide: 'rtl', command: 'ltr', code: true, number: true });
  const found = (await layoutFindings(page, { touch: viewport.touch })).filter(
    (f) => f.cls === 'overflow' || f.cls === 'escape',
  );
  expect(found, `${viewport.name}: overflow on the Persian item`).toEqual([]);
});
