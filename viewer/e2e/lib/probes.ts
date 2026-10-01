/**
 * The measurements: what a person meets on a page, taken in a real layout engine.
 *
 * Seven classes, each a question `docs/design.md` §6 answers in prose and jsdom
 * cannot answer at all:
 *
 *   overflow        a box past the viewport's edge that no ancestor clips — the page slides sideways
 *   escape          a box past `<main>`'s edge that `<main>` CLIPS (`overflow-x-hidden`): invisible
 *                   to a screenshot, which is exactly why it has to be measured
 *   touch-present   §6.1's first question — is the control in the hit stack at all
 *   touch-wins      the second — does it WIN (`elementFromPoint`) at its centre and four corners,
 *                   owned only as `hit === el || el.contains(hit)`; an ancestor answering is a clip,
 *                   never a pass
 *   touch-survives  the third — does its own box survive every ancestor that clips it
 *   axe             axe-core over WCAG A/AA, colour contrast ON, per theme
 *   focus           a keyboard focus that paints no ring
 *
 * A finding is `{cls, key}`. The key names the element the way a person would
 * — tag, role, accessible name — with digits folded to `#`, so a clock ticking
 * or a count moving does not turn one finding into two. Nothing here fails a
 * test: `register.spec.ts` decides, against `e2e/baseline.json`.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import type { Page } from '@playwright/test';

export const FINDING_CLASSES = [
  'overflow',
  'escape',
  'touch-present',
  'touch-wins',
  'touch-survives',
  'axe',
  'focus',
] as const;
export type FindingClass = (typeof FINDING_CLASSES)[number];
export type Finding = { cls: FindingClass; key: string };

/** `--tap-min`, the thumb floor the third question compares against. */
export const TAP_MIN = 44;

type Probe = {
  layout(opts: { touch: boolean; tapMin: number; steps: number }): Promise<Finding[]>;
  focused(): { key: string; painted: boolean; ident: string } | null;
  describe(el: Element): string;
};

declare global {
  interface Window {
    __pcProbe?: Probe;
    axe?: { run(ctx: Document, opts: object): Promise<AxeResults> };
  }
}
type AxeResults = {
  violations: {
    id: string;
    nodes: {
      target: unknown[];
      any?: { data?: { fgColor?: string; bgColor?: string; fontSize?: string } | null }[];
    }[];
  }[];
};

/**
 * Everything that runs in the page, installed once per document. It is ONE
 * function because Playwright ships a function to the page by its source text,
 * so a helper it calls has to live inside it.
 */
function install(): void {
  if (window.__pcProbe) return;
  const TOL = 1;
  const styles = new WeakMap<Element, CSSStyleDeclaration>();
  const cs = (el: Element): CSSStyleDeclaration => {
    let s = styles.get(el);
    if (!s) {
      s = getComputedStyle(el);
      styles.set(el, s);
    }
    return s;
  };
  // A key must read the same on every machine and every run: an absolute path
  // (the sandbox's, the checkout's) becomes `<path>`, a hash or an id becomes
  // `#`, and so does every other run of digits.
  const fold = (s: string | null | undefined): string =>
    (s ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\/(?:[\w.@+-]+\/)+[\w.@+-]*/g, '<path>')
      .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{6,}\b/gi, '#')
      .replace(/\d+/g, '#')
      // A duration's unit moves with the clock ("# min" becomes "#.# h"), and so
      // does the half of the day a timestamp falls in.
      .replace(
        /#(?:\.#)?\s?(?:ms|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|weeks?)\b/g,
        '#t',
      )
      .replace(/\s?\b(?:AM|PM)\b/g, '')
      .slice(0, 48);
  const labelledBy = (el: Element): string =>
    (el.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .map((id) => (id ? (document.getElementById(id)?.textContent ?? '') : ''))
      .join(' ')
      .trim();
  const describe = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const name =
      el.getAttribute('aria-label') ||
      labelledBy(el) ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      el.textContent ||
      el.getAttribute('name') ||
      '';
    return `${tag}${role ? `[${role}]` : ''} "${fold(name)}"`;
  };
  // Not drawn, or drawn for a screen reader only (`sr-only`: a 1px box whose
  // clip hides it) — neither is a box a thumb or an eye can meet.
  const invisible = (el: Element): boolean => {
    const s = cs(el);
    if (s.visibility === 'hidden' || s.visibility === 'collapse') return true;
    // A closed <details>' body keeps its boxes — Chromium lays it out behind
    // `content-visibility: hidden` — and is never painted or hit. Only its
    // summary, the disclosure's own control, is on screen.
    const shut = el.closest('details:not([open])');
    if (shut && shut !== el && !shut.querySelector(':scope > summary')?.contains(el)) return true;
    return (
      s.position === 'absolute' && (s.clipPath === 'inset(50%)' || s.clip === 'rect(0px, 0px, 0px, 0px)')
    );
  };
  // The ancestors whose overflow can clip `el`, nearest first. An absolutely
  // positioned box is clipped only from its containing block up, and a fixed
  // one by nothing but the viewport — which is how a dropdown escapes a card.
  const clippers = (el: Element): Element[] => {
    const chain: Element[] = [];
    let cur: Element | null = el;
    for (let guard = 0; cur && guard < 64; guard++) {
      const pos = cs(cur).position;
      let a: Element | null;
      if ((pos === 'absolute' || pos === 'fixed') && cur instanceof HTMLElement) a = cur.offsetParent;
      else a = cur.parentElement;
      cur = null;
      while (a && a !== document.documentElement) {
        chain.push(a);
        const p = cs(a).position;
        if (p === 'absolute' || p === 'fixed') {
          cur = a;
          break;
        }
        a = a.parentElement;
      }
    }
    return chain;
  };
  const outermost = (set: Set<Element>): Element[] =>
    [...set].filter((el) => {
      for (let a = el.parentElement; a; a = a.parentElement) if (set.has(a)) return false;
      return true;
    });
  const frame = (): Promise<void> =>
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

  const CONTROL = [
    'a[href]',
    'button',
    'input:not([type=hidden])',
    'select',
    'textarea',
    'summary',
    '[tabindex]:not([tabindex="-1"])',
    ...[
      'button',
      'link',
      'tab',
      'checkbox',
      'radio',
      'switch',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'option',
      'combobox',
      'slider',
    ].map((r) => `[role=${r}]`),
  ].join(',');

  const layout: Probe['layout'] = async ({ touch, tapMin, steps }) => {
    const out: Finding[] = [];
    // The layout width (no scrollbar) is what overflows; the taller of the two
    // heights is what a bottom-anchored bar is drawn against under emulation.
    const vw = document.documentElement.clientWidth;
    const vh = Math.max(document.documentElement.clientHeight, innerHeight);
    const main = document.querySelector('main');
    const mainBox = main?.getBoundingClientRect();

    // overflow and escape: horizontal, so one pass at any scroll position.
    const overflowing = new Set<Element>();
    const escaping = new Set<Element>();
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if ((r.width === 0 && r.height === 0) || invisible(el)) continue;
      const clip = clippers(el).find((a) => cs(a).overflowX !== 'visible');
      if (!clip || clip === document.body) {
        if (r.right > vw + TOL || r.left < -TOL) overflowing.add(el);
        continue;
      }
      const ox = cs(clip).overflowX;
      if (ox === 'auto' || ox === 'scroll') continue; // a scroller holds it: off screen, not gone
      if (clip === main && mainBox && (r.right > mainBox.right + TOL || r.left < mainBox.left - TOL))
        escaping.add(el);
    }
    for (const el of outermost(overflowing)) out.push({ cls: 'overflow', key: describe(el) });
    for (const el of outermost(escaping)) out.push({ cls: 'escape', key: describe(el) });
    if (!touch) return out;

    // While a modal layer is up the page behind it takes no pointer at all (the
    // dialog library turns `pointer-events` off on <body>): its controls are not
    // targets, and only the dialog's own are asked.
    const modal =
      cs(document.body).pointerEvents === 'none' || !!document.querySelector('[aria-modal="true"]')
        ? [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')]
        : null;
    const controls = [...document.querySelectorAll(CONTROL)].filter((el) => {
      if (el.matches(':disabled') || el.closest('[inert],[aria-hidden="true"]')) return false;
      if (modal && !modal.some((m) => m.contains(el))) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !invisible(el);
    });

    // The third question needs no viewport. Per axis, walk the ancestors out:
    // one that CLIPS (`hidden`/`clip`) cuts what is left of the control; one
    // that SCROLLS defers — the control can be scrolled anywhere inside it, so
    // from there out what matters is how much of the SCROLLER survives. That is
    // why the walk goes on past a scroller (one inside a clipping box is still
    // clipped by it) and why a control below the fold of a scroller inside the
    // viewport-high shell is not a finding, while one an inner box cuts to a
    // sliver stays one wherever it is scrolled.
    type Span = { lo: number; hi: number; len: number; fixed: boolean };
    const cut = (s: Span, b0: number, b1: number): Span => {
      const lo = Math.max(s.lo, b0);
      const hi = Math.min(s.hi, b1);
      const room = Math.max(0, hi - lo);
      return { lo, hi, len: s.fixed ? room : Math.min(s.len, room), fixed: s.fixed };
    };
    const roam = (s: Span, b0: number, b1: number): Span => ({
      lo: b0,
      hi: b1,
      len: Math.min(s.len, b1 - b0),
      fixed: false,
    });
    for (const el of controls) {
      const r = el.getBoundingClientRect();
      let x: Span = { lo: r.left, hi: r.right, len: r.width, fixed: true };
      let y: Span = { lo: r.top, hi: r.bottom, len: r.height, fixed: true };
      for (const a of clippers(el)) {
        if (a === document.body) continue;
        const s = cs(a);
        const b = a.getBoundingClientRect();
        if (s.overflowX === 'hidden' || s.overflowX === 'clip') x = cut(x, b.left, b.right);
        else if (s.overflowX === 'auto' || s.overflowX === 'scroll') x = roam(x, b.left, b.right);
        if (s.overflowY === 'hidden' || s.overflowY === 'clip') y = cut(y, b.top, b.bottom);
        else if (s.overflowY === 'auto' || s.overflowY === 'scroll') y = roam(y, b.top, b.bottom);
      }
      if (x.len < Math.min(r.width, tapMin) - TOL || y.len < Math.min(r.height, tapMin) - TOL) {
        out.push({ cls: 'touch-survives', key: describe(el) });
      }
    }

    // The first two need the control on screen and WHOLE — inside the viewport
    // and inside every ancestor that scrolls (a scroller's hidden tail is off
    // screen, not broken). `<main>` is walked a half-screen at a time and a
    // control is asked at every position it stands whole until it answers
    // clean once: a control under a sticky bar at one scroll position is
    // reachable at the next, and only one that loses everywhere is a finding.
    type Verdict = 'clean' | 'touch-present' | 'touch-wins';
    const whole = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      let [x0, x1, y0, y1] = [0, vw, 0, vh];
      for (const a of clippers(el)) {
        if (a === document.body) continue;
        const s = cs(a);
        const b = a.getBoundingClientRect();
        if (s.overflowX === 'auto' || s.overflowX === 'scroll')
          [x0, x1] = [Math.max(x0, b.left), Math.min(x1, b.right)];
        if (s.overflowY === 'auto' || s.overflowY === 'scroll')
          [y0, y1] = [Math.max(y0, b.top), Math.min(y1, b.bottom)];
      }
      return r.left >= x0 - TOL && r.right <= x1 + TOL && r.top >= y0 - TOL && r.bottom <= y1 + TOL;
    };
    const judge = (el: Element): Verdict => {
      const r = el.getBoundingClientRect();
      const owns = (hit: Element | null): boolean => !!hit && (hit === el || el.contains(hit));
      const cx = (r.left + r.right) / 2;
      const cy = (r.top + r.bottom) / 2;
      if (!document.elementsFromPoint(cx, cy).some(owns)) return 'touch-present';
      // The four corners of the DRAWN box, inset just past a rounded corner so a
      // pill is not failed for its own radius.
      const s = cs(el);
      const radius = Math.min(
        Math.max(
          ...[
            s.borderTopLeftRadius,
            s.borderTopRightRadius,
            s.borderBottomLeftRadius,
            s.borderBottomRightRadius,
          ].map((v) => parseFloat(v) || 0),
        ),
        r.width / 2,
        r.height / 2,
      );
      const inset = Math.min(Math.ceil(radius * (1 - Math.SQRT1_2)) + 1, r.width / 2, r.height / 2);
      const points: [number, number][] = [
        [cx, cy],
        [r.left + inset, r.top + inset],
        [r.right - inset, r.top + inset],
        [r.left + inset, r.bottom - inset],
        [r.right - inset, r.bottom - inset],
      ];
      const lost = points
        .filter(([x, y]) => x >= 0 && y >= 0 && x < vw && y < vh)
        .some(([x, y]) => !owns(document.elementFromPoint(x, y)));
      return lost ? 'touch-wins' : 'clean';
    };
    const verdicts = new Map<Element, Verdict>();
    const start = main?.scrollTop ?? 0;
    main?.scrollTo({ top: 0, behavior: 'instant' }); // every reading walks from the top
    for (let step = 0; step < steps; step++) {
      await frame();
      for (const el of controls) {
        if (verdicts.get(el) !== 'clean' && whole(el)) verdicts.set(el, judge(el));
      }
      if (!main || main.scrollTop + main.clientHeight >= main.scrollHeight - TOL) break;
      main.scrollTo({ top: main.scrollTop + Math.max(1, main.clientHeight / 2), behavior: 'instant' });
    }
    main?.scrollTo({ top: start, behavior: 'instant' });
    await frame();
    for (const [el, v] of verdicts) if (v !== 'clean') out.push({ cls: v, key: describe(el) });
    return out;
  };

  // A ring is an outline or a box-shadow on the focused control, or on one of
  // the two boxes around it a `focus-within` ring would be drawn on.
  const ring = (el: Element): boolean => {
    const s = cs(el);
    const outline =
      s.outlineStyle !== 'none' &&
      parseFloat(s.outlineWidth) > 0 &&
      !/rgba\(.*,\s*0\)$|transparent/.test(s.outlineColor);
    return outline || (s.boxShadow !== 'none' && s.boxShadow !== '');
  };
  const focused: Probe['focused'] = () => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    styles.delete(el);
    let painted = ring(el);
    for (let a = el.parentElement, i = 0; !painted && a && i < 2; a = a.parentElement, i++) {
      styles.delete(a);
      painted = ring(a);
    }
    const r = el.getBoundingClientRect();
    return {
      key: describe(el),
      painted,
      ident: `${describe(el)}@${Math.round(r.left)},${Math.round(r.top)}`,
    };
  };

  window.__pcProbe = { layout, focused, describe };
}

/** Overflow, escape and — on a touch project — the three touch questions. */
export async function layoutFindings(
  page: Page,
  opts: { touch: boolean; steps?: number },
): Promise<Finding[]> {
  await page.evaluate(install);
  return page.evaluate((o) => window.__pcProbe!.layout(o), {
    touch: opts.touch,
    tapMin: TAP_MIN,
    steps: opts.steps ?? 12,
  });
}

/**
 * axe's source, evaluated rather than added as a `<script>`: in dist mode the
 * page runs under the console's real CSP (`script-src 'self'`), which refuses
 * an injected inline script — and a probe that turns the policy off
 * (`bypassCSP`) would also turn off the thing `smoke.spec.ts` measures. An
 * evaluation over the DevTools protocol is not the page's script, so the
 * policy neither sees nor records it.
 */
const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

/**
 * axe-core over WCAG 2.x A and AA — which is where colour contrast lives — in
 * one theme. The theme is the media query the console follows when its own
 * preference is `system`, the shipped default. `within` narrows it to one
 * element — an overlay's own dialog, when the page behind it is a stop of its
 * own and would otherwise be counted twice.
 */
export async function axeFindings(page: Page, theme: 'light' | 'dark', within?: string): Promise<Finding[]> {
  await page.emulateMedia({ colorScheme: theme });
  await still(page);
  if (!(await page.evaluate(() => !!window.axe))) await page.evaluate(AXE_SOURCE);
  await page.evaluate(install);
  const found = await page.evaluate(async (scope) => {
    const res = await window.axe!.run(scope ? ({ include: [scope] } as unknown as Document) : document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      rules: { 'color-contrast': { enabled: true } },
      resultTypes: ['violations'],
    });
    return res.violations.flatMap((v) =>
      v.nodes.map((n) => {
        const sel = n.target[0];
        const el = typeof sel === 'string' ? document.querySelector(sel) : null;
        // Contrast is a property of a colour PAIR, not of a row: keyed by what a
        // token change fixes, a finding survives the list it sits in reordering.
        const c = v.id === 'color-contrast' ? n.any?.find((a) => a.data?.fgColor)?.data : null;
        if (c && el)
          return {
            rule: v.id,
            key: `${el.tagName.toLowerCase()} ${c.fgColor} on ${c.bgColor} ${c.fontSize ?? ''}`.trim(),
          };
        return { rule: v.id, key: el ? window.__pcProbe!.describe(el) : String(sel) };
      }),
    );
  }, within ?? null);
  return found.map((f) => ({ cls: 'axe' as const, key: `${f.rule}/${theme} ${f.key}` }));
}

/**
 * Let a theme switch land: two frames, then every running transition and
 * animation finished (an infinite one cancelled), and again a frame at a time
 * until a frame starts with nothing running. Finishing one transition starts
 * others: theme.css's reduced-motion rule gives every element a 0.01 ms
 * transition on `all`, so a colour landing on a parent moves its children's
 * inherited and currentColor paint, and their transitions start the next time
 * style is read. On the plan page that cascade runs for up to 12 frames.
 * Contrast read mid-transition is a colour halfway between two tokens, or the
 * old theme's ink on the new ground — a different finding on every run.
 */
export async function still(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
    const finish = (animations: Animation[]): void => {
      for (const a of animations) {
        try {
          a.finish();
        } catch {
          a.cancel();
        }
      }
    };
    await frame();
    await frame();
    finish(document.getAnimations());
    // getAnimations() brings style up to date first, so it sees what the last
    // round of finishing started. Bounded: a page that animates for ever is
    // measured as it stands.
    for (let round = 0; round < 60; round++) {
      await frame();
      const running = document.getAnimations().filter((a) => a.playState === 'running' || a.pending);
      if (!running.length) break;
      finish(running);
    }
  });
}

/**
 * Walk the keyboard focus through the first `stops` tab stops and name every
 * control that paints no ring. Stops at the first repeat — the order cycled.
 * `within` is an overlay's stop: the walk starts inside the open modal, where
 * a keyboard's focus is while it is up — starting above it walked the dialog
 * library's invisible focus guard and then the inert page behind (phase 31).
 */
export async function focusFindings(page: Page, stops = 24, within?: string): Promise<Finding[]> {
  await page.evaluate(install);
  // Start from the top of the document (or of the modal) every time. A blur
  // alone leaves the browser's focus-navigation starting point where the last
  // walk ended, so a second walk would begin mid-page and name different controls.
  await page.evaluate((scope) => {
    const mark = document.createElement('div');
    mark.tabIndex = -1;
    ((scope && document.querySelector(scope)) || document.body).prepend(mark);
    mark.focus();
    mark.remove();
  }, within ?? null);
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press('Tab');
    const at = await page.evaluate(() => window.__pcProbe!.focused());
    if (!at || seen.has(at.ident)) break;
    seen.add(at.ident);
    if (!at.painted) out.push({ cls: 'focus', key: at.key });
  }
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.querySelector('main')?.scrollTo({ top: 0, behavior: 'instant' });
  });
  return out;
}
