import { expect, test, type Page } from '@playwright/test';

import { UI_STATES } from '../shared/status-vocab.js';
import { still } from './lib/probes.ts';
import { STOPS, VIEWPORTS, fixture, visit } from './lib/shots.ts';

/*
 * The signal law in a real browser (control-tower phase 16): the two promises
 * about colour that jsdom, which paints nothing, cannot check.
 *
 * No status is colour-only (WCAG 1.4.1). A status here is an element that says
 * it is one: a badge of the typed family (`data-status`, `ui/status/`), or a
 * legacy `StatusBadge` / `StatusDot` (`data-state` naming a UI state AND
 * wearing its paint — a Radix part's `data-state="open"` is not a status). A
 * badge must SHOW an icon and a word: drawn, not collapsed to nothing, not left
 * to a screen reader alone. A dot is the hue and nothing else by design, so the
 * box that holds it must show the word it colours.
 *
 * The focus ring is ink, never amber (tokens 6.0): every ring a keyboard walk
 * paints is the resolved `--ink`, in both themes, and never the resolved
 * `--accent` — amber is a summons, and a focused control is not one.
 *
 * Not a ratchet. `register.spec.ts` owns the baseline; a status drawn in
 * colour alone is a defect to fix, not a count to bank.
 */

type Miss = { why: string; what: string };

/** Every status on the page that a reader without colour could not read. */
async function colourOnly(page: Page): Promise<Miss[]> {
  return page.evaluate((states: readonly string[]) => {
    const shown = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      return (
        r.width > 0 && r.height > 0 && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      );
    };
    // Text a sighted reader gets: an `sr-only` span is a 1px box, and a word
    // only a screen reader hears does not answer the eye.
    const words = (el: Element, skip?: Element): string => {
      let text = '';
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const host = n.parentElement;
        if (!host || !n.textContent?.trim() || (skip && skip.contains(host))) continue;
        const r = host.getBoundingClientRect();
        if (r.width > 1 && r.height > 1 && shown(host)) text += n.textContent;
      }
      return text.trim();
    };
    const icon = (el: Element): boolean => [...el.querySelectorAll('svg')].some(shown);
    const sketch = (el: Element): string => el.outerHTML.replace(/\s+/g, ' ').slice(0, 220);

    const out: Miss[] = [];
    for (const el of document.querySelectorAll('[data-status][data-paint]')) {
      if (!shown(el)) continue;
      if (!icon(el)) out.push({ why: 'a family badge draws no icon', what: sketch(el) });
      if (!words(el)) out.push({ why: 'a family badge draws no word', what: sketch(el) });
    }
    for (const el of document.querySelectorAll('[data-state]')) {
      const state = el.getAttribute('data-state') ?? '';
      if (!states.includes(state) || !el.classList.contains(`state-${state}`) || !shown(el)) continue;
      if (el.getAttribute('aria-hidden') === 'true') {
        const box = el.parentElement;
        if (!box || !words(box, el))
          out.push({ why: 'a status dot sits beside no word', what: sketch(box ?? el) });
        continue;
      }
      if (!icon(el)) out.push({ why: 'a status badge draws no icon', what: sketch(el) });
      if (!words(el)) out.push({ why: 'a status badge draws no word', what: sketch(el) });
    }
    return out;
  }, UI_STATES);
}

type Rgb = [number, number, number];
type Ring = { at: string; ring: string; rgb: Rgb | null; ink: Rgb; accent: Rgb };

/**
 * Walk the keyboard focus through the first `stops` tab stops and read each
 * ring's colour beside the two tokens it may and may not be, resolved in the
 * same box — a colour scheme is inherited, so `light-dark()` must be asked
 * where the ring is drawn. A ring is an outline or a box-shadow on the control
 * or on one of the two boxes around it, as the register's probe reads one.
 *
 * Colours are compared as pixels, never as strings: a translucent ring
 * (`ring-action/50`) and a colour mid-transition both serialize as `oklab()`
 * while the token reads `oklch()`, and a Tailwind ring is a list of shadows
 * whose first entries are transparent placeholders.
 */
async function rings(page: Page, stops = 12): Promise<Ring[]> {
  await page.evaluate(() => {
    const mark = document.createElement('div');
    mark.tabIndex = -1;
    document.body.prepend(mark);
    mark.focus();
    mark.remove();
  });
  const out: Ring[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press('Tab');
    // The focus turned the ring on through `transition-colors`: read it landed.
    await still(page);
    const read = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      // One colour as the sRGB pixel it paints, or null for a transparent one.
      const pixel = (colour: string): [number, number, number] | null => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = colour;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        return a === 0 ? null : [r, g, b];
      };
      // The first colour of a shadow list that paints anything.
      const shadowPixel = (shadow: string): [number, number, number] | null => {
        for (const [colour] of shadow.matchAll(/(?:rgba?|oklch|oklab|lab|lch|color)\([^)]*\)/g)) {
          const p = pixel(colour);
          if (p) return p;
        }
        return null;
      };
      const r = el.getBoundingClientRect();
      const at = `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 40)}"@${Math.round(r.left)},${Math.round(r.top)}`;
      for (let box: Element | null = el, up = 0; box && up < 3; box = box.parentElement, up++) {
        const s = getComputedStyle(box);
        const line =
          s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 ? pixel(s.outlineColor) : null;
        const glow = line ? null : s.boxShadow && s.boxShadow !== 'none' ? shadowPixel(s.boxShadow) : null;
        if (!line && !glow) continue;
        // A fresh probe per token, born with its colour: a colour CHANGED on a
        // live element transitions (the theme's own `transition-colors`), and
        // reads as the colour it is leaving.
        const host = box;
        const token = (name: string): [number, number, number] => {
          const probe = document.createElement('span');
          probe.style.cssText = `transition: none; color: var(${name})`;
          host.appendChild(probe);
          const colour = getComputedStyle(probe).color;
          probe.remove();
          return pixel(colour) ?? [0, 0, 0];
        };
        return {
          at,
          ring: line ? s.outlineColor : s.boxShadow,
          rgb: line ?? glow,
          ink: token('--ink'),
          accent: token('--accent'),
        };
      }
      const black: [number, number, number] = [0, 0, 0];
      return { at, ring: 'none', rgb: null, ink: black, accent: black };
    });
    if (!read || seen.has(read.at)) break;
    seen.add(read.at);
    out.push(read);
  }
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  return out;
}

/** Two pixels within rounding of each other (a translucent ring is un-premultiplied). */
const near = (a: Rgb, b: Rgb): boolean => a.every((v, i) => Math.abs(v - b[i]) <= 3);

const touch = (project: string): boolean => VIEWPORTS.find((v) => v.name === project)?.touch ?? false;

for (const stop of STOPS) {
  test(`no status is colour-only: ${stop.name}`, async ({ page }) => {
    const fx = await fixture();
    await visit(page, stop, fx.anchor);
    const misses = await colourOnly(page);
    expect(misses, misses.map((m) => `${m.why}: ${m.what}`).join('\n')).toEqual([]);
  });
}

// The stops a keyboard spends most of its time on, each with a primary button
// or a live badge in reach of the first dozen tabs.
const RING_STOPS = STOPS.filter((s) => ['runs', 'plan-route', 'approve'].includes(s.name));

for (const stop of RING_STOPS) {
  test(`the focus ring is ink, never amber, in both themes: ${stop.name}`, async ({ page }, info) => {
    test.skip(touch(info.project.name), 'a keyboard walk belongs to the desks');
    const fx = await fixture();
    await visit(page, stop, fx.anchor);
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await still(page);
      // A focus that paints no ring at all is the register's (`focus`, ratcheted
      // in `baseline.json`); this asks what colour the rings that exist are.
      const walked = (await rings(page)).filter((r) => r.rgb !== null);
      expect(walked.length, `${theme}: the walk painted no ring to read`).toBeGreaterThan(0);
      for (const { at, ring, rgb, ink, accent } of walked) {
        const said = `${theme} ${at}: ring ${ring} = rgb(${rgb!.join(', ')}); ink rgb(${ink.join(', ')}), accent rgb(${accent.join(', ')})`;
        expect(near(ink, accent), `${said} — the two tokens resolve alike, so this proves nothing`).toBe(
          false,
        );
        expect(near(rgb!, accent), `${said} — the ring is amber`).toBe(false);
        expect(near(rgb!, ink), `${said} — the ring is not ink`).toBe(true);
      }
    }
    await page.emulateMedia({ colorScheme: 'light' });
  });
}
