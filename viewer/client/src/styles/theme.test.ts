/**
 * The theme guard — tokens 7.0 (quiet-console phase 1).
 *
 * Two things rot silently in a token system: a fourth breakpoint appearing
 * because someone needed "just one" media query, and a token being renamed out
 * from under the components that use it. This test is what keeps that from
 * happening — and, since 7.0, what keeps the type to ONE sans at ONE width
 * (the condensed display face is retired, and the test fails the day a width
 * clamp comes back), the status palette a closed set of eight at one weight,
 * the accent a single amber, the type floor at 12 px with four sizes to a
 * page, the radii 3 / 6 / 10, and the shadow one — for overlays.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BP_PHONE, BP_SHELL, BP_WIDE } from '@/lib/media';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SRC = here('..');
const THEME = readFileSync(here('./theme.css'), 'utf8');

/** The only widths this design is allowed to branch on. */
const ALLOWED = [640, 900, 1200];

/** The eight UI states of `shared/status-vocab.js`, as the palette names them. */
const STATUS_TOKENS = [
  '--status-done',
  '--status-running',
  '--status-verifying',
  '--status-queued',
  '--status-waiting',
  '--status-needs-you',
  '--status-failed',
  '--status-skipped',
];

/** Every colour the room is made of — each declared ONCE, for both lights at once. */
const COLOUR_TOKENS = [
  ...STATUS_TOKENS,
  '--ground',
  '--ground-deep',
  '--surface',
  '--surface-raised',
  '--rule',
  '--rule-strong',
  '--ink',
  '--ink-muted',
  '--ink-faint',
  '--track',
  '--hatch',
];

/**
 * Every custom property whose value reaches the amber hue, followed to its root
 * through `var()`, the needs-you state itself aside. `--state` is the per-class
 * indirection and is not a token of the palette.
 */
function tokensReachingAmber(): string[] {
  const decl = new Map<string, string>();
  for (const m of THEME.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) {
    if (m[1] !== '--state' && !decl.has(m[1])) decl.set(m[1], m[2]);
  }
  const reaches = (token: string, seen = new Set<string>()): boolean => {
    if (token === '--status-needs-you') return true;
    if (seen.has(token)) return false;
    seen.add(token);
    const value = decl.get(token) ?? '';
    return [...value.matchAll(/var\((--[\w-]+)/g)].some(([, ref]) => reaches(ref, seen));
  };
  return [...decl.keys()].filter((t) => t !== '--status-needs-you' && reaches(t)).sort();
}

/** Shipped source only — a test may name a width in order to reject it. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(css|ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Every `@font-face` a stylesheet declares: its family and its width clamp. */
function faces(css: string): { family: string; stretch: string | null }[] {
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => ({
    family: /font-family:\s*'([^']+)'/.exec(body)?.[1] ?? '',
    stretch: /font-stretch:\s*([\d.]+%)/.exec(body)?.[1] ?? null,
  }));
}

/**
 * The 7.0 type law, as a function of a stylesheet so it can be shown its own
 * negative: ONE sans, Instrument Sans, at 100 % of its width; the mono held at
 * 87.5 %; no second face over the sans file and no condensed clamp anywhere.
 * Returns what breaks it, so `[]` is the law held.
 */
function widthLawBroken(css: string): string[] {
  const out: string[] = [];
  const declared = faces(css);
  const sans = declared.filter((f) => f.family === 'Instrument Sans');
  if (sans.length !== 1) out.push(`Instrument Sans declared ${sans.length}× (one face, one width)`);
  for (const f of declared) {
    if (/display/i.test(f.family)) out.push(`a display face: '${f.family}'`);
    if (f.family === 'Instrument Sans' && f.stretch !== '100%')
      out.push(`the sans clamped at ${f.stretch ?? 'no width'}`);
    if (f.family === 'Martian Mono' && f.stretch !== '87.5%')
      out.push(`the mono clamped at ${f.stretch ?? 'no width'}`);
    if (f.stretch && f.stretch !== '100%' && f.stretch !== '87.5%') out.push(`a width clamp of ${f.stretch}`);
  }
  if (/--font-display\b/.test(css)) out.push('a --font-display token');
  return out;
}

describe('theme tokens', () => {
  it('declares exactly three breakpoints, at 640/900/1200', () => {
    const declared = [...THEME.matchAll(/--breakpoint-([\w-]+):\s*(\d+)px/g)].map(([, name, value]) => ({
      name,
      value: Number(value),
    }));
    expect(declared.map((b) => b.value)).toEqual(ALLOWED);
    // Tailwind's own sm/md/lg/xl/2xl must be cleared, or there are eight.
    expect(THEME).toMatch(/--breakpoint-\*:\s*initial/);
  });

  it('keeps the media.ts constants in step with the stylesheet', () => {
    // A media query cannot read a custom property, so these live in two places
    // by necessity. This is the assertion that makes that survivable.
    const doc = Object.fromEntries(
      [...THEME.matchAll(/--bp-(phone|shell|wide):\s*(\d+)px/g)].map(([, k, v]) => [k, Number(v)]),
    );
    expect(doc).toEqual({ phone: BP_PHONE, shell: BP_SHELL, wide: BP_WIDE });
    expect([BP_PHONE, BP_SHELL, BP_WIDE]).toEqual(ALLOWED);
  });

  it('declares every token the components paint with', () => {
    const required = [
      ...COLOUR_TOKENS,
      '--accent',
      '--action',
      '--focus',
      '--shadow-overlay',
      '--font-sans',
      '--font-mono',
      '--text-title',
      '--text-section',
      '--text-body',
      '--text-meta',
      '--text-2xs',
      '--text-xs',
      '--text-sm',
      '--text-md',
      '--text-lg',
      '--text-xl',
      '--text-2xl',
      '--text-3xl',
      '--radius-sm',
      '--radius',
      '--radius-lg',
      '--tap-min',
      '--text-input',
      '--app-height',
      '--measure',
      '--z-base',
      '--z-sticky',
      '--z-shell',
      '--z-scrim',
      '--z-toast',
      '--rail-width',
      '--content-max',
      '--pad-x',
      '--pad-y',
      '--tile-pad-x',
      '--tile-pad-y',
    ];
    const missing = required.filter((token) => !new RegExp(`\\${token}:`).test(THEME));
    expect(missing, `undeclared: ${missing.join(', ')}`).toEqual([]);
  });

  it('defines each colour once, for both lights at the same time', () => {
    // `light-dark()` makes a second definition unnecessary — and a duplicate
    // here means someone started a second copy of the palette.
    for (const token of COLOUR_TOKENS) {
      const declarations = [...THEME.matchAll(new RegExp(`^\\s*\\${token}:`, 'gm'))];
      expect(declarations.length, `${token} declared ${declarations.length}x`).toBe(1);
      const line = THEME.split('\n').find((l) => l.trim().startsWith(`${token}:`)) ?? '';
      expect(line, `${token} should carry both lights`).toContain('light-dark(');
    }
  });

  it('holds the status palette at one OKLCH weight per light', () => {
    // Equal weight is the design rule: no state shouts louder than another by
    // accident. Every chromatic state shares one L/C pair per light; the two
    // neutrals (queued, skipped) keep the lightness and drop the chroma.
    const weights = new Map<string, { paper: string; night: string }>();
    for (const token of STATUS_TOKENS) {
      const line = THEME.split('\n').find((l) => l.trim().startsWith(`${token}:`)) ?? '';
      const match =
        /light-dark\(oklch\(([\d.]+%) ([\d.]+) [\d.]+\), oklch\(([\d.]+%) ([\d.]+) [\d.]+\)\)/.exec(line);
      expect(match, `${token} is not a light-dark(oklch, oklch) pair`).toBeTruthy();
      const [, paperL, paperC, nightL, nightC] = match!;
      weights.set(token, { paper: `${paperL} ${paperC}`, night: `${nightL} ${nightC}` });
      expect(paperL, `${token} paper lightness`).toBe(weights.get(STATUS_TOKENS[0])!.paper.split(' ')[0]);
      expect(nightL, `${token} night lightness`).toBe(weights.get(STATUS_TOKENS[0])!.night.split(' ')[0]);
    }
    const chromatic = STATUS_TOKENS.filter((t) => t !== '--status-queued' && t !== '--status-skipped');
    const paperC = new Set(chromatic.map((t) => weights.get(t)!.paper));
    const nightC = new Set(chromatic.map((t) => weights.get(t)!.night));
    expect([...paperC], 'one paper L/C for every chromatic state').toHaveLength(1);
    expect([...nightC], 'one night L/C for every chromatic state').toHaveLength(1);
  });

  it('keeps the room one cool neutral family — every surface and ink at hue 230, low chroma', () => {
    // One room, two lights: a surface or an ink at another hue is a second
    // room, and a chroma past 0.02 is a tint rather than paper.
    for (const token of COLOUR_TOKENS.filter((t) => !STATUS_TOKENS.includes(t) && t !== '--hatch')) {
      const line = THEME.split('\n').find((l) => l.trim().startsWith(`${token}:`)) ?? '';
      for (const [, C, h] of line.matchAll(/oklch\([\d.]+% ([\d.]+) ([\d.]+)/g)) {
        expect(Number(C), `${token} chroma`).toBeLessThanOrEqual(0.02);
        if (Number(C) > 0) expect(Number(h), `${token} hue`).toBe(230);
      }
    }
  });

  it('reserves amber for the thing that needs a person — reached only through --accent', () => {
    // Amber is a summons and nothing else. `--accent` is the ONE door to it and
    // it is the needs-you state; the action colour (a primary button) and the
    // focus ring are high-contrast INK, because neither is a person being
    // summoned.
    expect(THEME).toMatch(/--accent:\s*var\(--status-needs-you\)/);
    expect(THEME).toMatch(/--action:\s*var\(--ink\)/);
    expect(THEME).toMatch(/--focus:\s*var\(--ink\)/);
    // Follow every custom property to its root: the only tokens whose value
    // reaches the amber hue are the needs-you state itself, the accent, and the
    // aliases that exist to paint a needs-you state.
    expect(tokensReachingAmber()).toEqual(['--accent', '--color-accent', '--color-needs-you']);
    // Only one token may sit at the amber hue: every other hue in the palette
    // is at least 40° away, so no second state can be mistaken for the accent.
    const hues = STATUS_TOKENS.map((token) => {
      const line = THEME.split('\n').find((l) => l.trim().startsWith(`${token}:`)) ?? '';
      return { token, hue: Number(/oklch\([\d.]+% [\d.]+ ([\d.]+)\)/.exec(line)?.[1]) };
    });
    const amber = hues.find((h) => h.token === '--status-needs-you')!.hue;
    for (const { token, hue } of hues) {
      if (token === '--status-needs-you') continue;
      expect(Math.abs(hue - amber), `${token} sits too close to the amber hue`).toBeGreaterThanOrEqual(40);
    }
    // And a selection is not a summons either.
    expect(THEME).not.toMatch(/::selection\s*\{[^}]*accent/);
  });

  it('never draws a focus mark in amber', () => {
    // A focused control is not a person being summoned. The ring is `--focus`
    // (ink), painted by `:focus-visible` in theme.css; a component that narrows
    // it names `outline-focus`. An outline is only ever a focus mark here; a
    // ring is one under a focus variant.
    const amber = new Set(
      ['--status-needs-you', ...tokensReachingAmber()].map((t) => t.replace(/^--(?:color-)?/, '')),
    );
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const body = readFileSync(file, 'utf8');
      for (const [hit, variant, kind, value] of body.matchAll(
        /\b((?:focus|focus-visible|focus-within):)?(outline|ring)-(\(--[\w-]+\)|\[var\(--[\w-]+\)\]|[a-z][\w-]*)/g,
      )) {
        if (kind === 'ring' && !variant) continue;
        if (amber.has(value.replace(/^[([](?:var\()?--/, '').replace(/[)\]]+$/, ''))) {
          offenders.push(`src/${file.replace(SRC, '')}: ${hit}`);
        }
      }
      // And a stylesheet's own outline, spelled as a declaration.
      for (const [hit, token] of body.matchAll(/outline(?:-color)?\s*:[^;{}]*var\((--[\w-]+)\)/g)) {
        if (amber.has(token.replace(/^--(?:color-)?/, '')))
          offenders.push(`src/${file.replace(SRC, '')}: ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('carries no 2.x alias — the line tokens, their colour names and the board-word classes are gone', () => {
    expect(THEME).not.toMatch(/(?<![\w-])--line-[a-z]/);
    expect(THEME).not.toMatch(/--color-(?:ready|progress|blocked|stuck|gated)\b/);
    expect(THEME).not.toMatch(/\.state-(?:ready|in-progress|blocked|stuck|gated)\b/);
  });

  it('sets a .state-<ui> class for each of the eight UI states', () => {
    for (const token of STATUS_TOKENS) {
      const ui = token.replace('--status-', '');
      expect(THEME, `.state-${ui}`).toMatch(
        new RegExp(`\\.state-${ui}\\s*\\{\\s*--state:\\s*var\\(${token}\\)`),
      );
    }
  });

  it('sets the type floor at 12 px, four sizes to a page, and tabular numerals', () => {
    // Four sizes make a page (design.md §2): title 22 · section 15 · body 14 ·
    // meta 12.5 — fixed, never fluid. The body is set in `--text-body`.
    const roles = Object.fromEntries(
      [...THEME.matchAll(/--text-(title|section|body|meta):\s*([\d.]+)rem/g)].map(([, k, v]) => [
        k,
        Number(v) * 16,
      ]),
    );
    expect(roles).toEqual({ title: 22, section: 15, body: 14, meta: 12.5 });
    expect(THEME).toMatch(/body\s*\{[^}]*font-size:\s*var\(--text-body\)/s);
    // The 6.x scale stays while the rendered-markdown sheet (`prose.css`) sizes
    // from it — no page wears it — and its floor is 12 px.
    const sizes = Object.fromEntries(
      [...THEME.matchAll(/--text-(2xs|xs|sm|md):\s*([\d.]+)rem/g)].map(([, k, v]) => [k, Number(v)]),
    );
    expect(sizes).toEqual({ '2xs': 0.75, xs: 0.8125, sm: 0.875, md: 0.9375 });
    // Nothing in the stylesheet is set below the floor.
    const rems = [...THEME.matchAll(/--text-[\w-]+:\s*([\d.]+)rem/g)].map(([, v]) => Number(v));
    expect(Math.min(...rems)).toBeGreaterThanOrEqual(0.75);
    // Tabular figures are the body's default, and `.tnum` exists for opt-back-in.
    expect(THEME).toMatch(/body\s*\{[^}]*font-variant-numeric:\s*tabular-nums/s);
    expect(THEME).toMatch(/@utility tnum\s*\{\s*font-variant-numeric:\s*tabular-nums/);
    // Titles are the UI face at 600 — no second face.
    expect(THEME).toMatch(/h1,\s*h2,\s*h3,\s*h4\s*\{[^}]*font-family:\s*var\(--font-sans\)/s);
  });

  it('shapes with three radii — 3, 6, 10 — and casts one shadow, for overlays', () => {
    expect(THEME).toMatch(/--radius-sm:\s*3px/);
    expect(THEME).toMatch(/--radius:\s*6px/);
    expect(THEME).toMatch(/--radius-lg:\s*10px/);
    // One shadow exists: the overlay's. Surfaces differ by tone, never by
    // shadow, so a card shadow, a glow or a second elevation is a regression.
    const shadows = new Set([...THEME.matchAll(/--shadow-([\w-]+)\s*:/g)].map(([, name]) => name));
    expect([...shadows]).toEqual(['overlay']);
    expect(THEME).not.toMatch(/--glow-/);
  });

  it('vendors the voices as exactly two variable woff2 files and nothing else', () => {
    const fonts = readdirSync(here('../assets/fonts'))
      .filter((f) => f.endsWith('.woff2'))
      .sort();
    expect(fonts).toEqual(['instrument-sans-var.woff2', 'martian-mono-var.woff2']);
    // Every @font-face points at one of them, and every one is pointed at.
    const referenced = [
      ...new Set([...THEME.matchAll(/url\('\.\.\/assets\/fonts\/([\w.-]+\.woff2)'\)/g)].map(([, f]) => f)),
    ].sort();
    expect(referenced).toEqual(fonts);
    for (const f of fonts) expect(existsSync(here(`../assets/fonts/${f}`))).toBe(true);
    // The families the tokens name are the families the faces declare — two of them.
    expect(THEME).toMatch(/--font-sans:\s*'Instrument Sans'/);
    expect(THEME).toMatch(/--font-mono:\s*'Martian Mono'/);
    expect(faces(THEME).map((f) => f.family)).toEqual(['Instrument Sans', 'Martian Mono']);
    // Ligatures are off in the mono utility itself, not only on `code`.
    expect(THEME).toMatch(/--font-mono--font-feature-settings:\s*'liga' 0, 'calt' 0/);
  });

  it('sets ONE sans at 100 % of its width and no display clamp — and would fail on one', () => {
    // 7.0 retired the condensed display face 4.0 clamped out of the sans file
    // (`font-stretch: 80%`): titles are the UI face at 600. The law is a
    // function of the stylesheet, shown its own negative here, so the day a
    // clamp comes back this test is what says so.
    expect(widthLawBroken(THEME)).toEqual([]);
    const reclamped = THEME.replace(/font-stretch:\s*100%/, 'font-stretch: 80%');
    expect(reclamped).not.toBe(THEME);
    expect(widthLawBroken(reclamped)).toEqual(expect.arrayContaining([expect.stringMatching(/80%/)]));
    const secondFace =
      THEME +
      "@font-face { font-family: 'Instrument Sans Display'; src: url('../assets/fonts/instrument-sans-var.woff2') format('woff2-variations'); font-stretch: 80%; }";
    expect(widthLawBroken(secondFace)).toEqual(
      expect.arrayContaining([expect.stringMatching(/display face/), expect.stringMatching(/80%/)]),
    );
    expect(widthLawBroken(`${THEME}\n--font-display: 'x';`)).toContain('a --font-display token');
  });

  /**
   * The woff2 files are REDISTRIBUTED in the npm tarball. The OFL's condition
   * 2 is explicit: a bundled or redistributed copy must carry the copyright
   * notice and the licence, as a stand-alone text file or a readable header —
   * one notice PER redistributed family. Prose about a licence is not the
   * licence.
   */
  it('ships the OFL text and both copyright notices beside the fonts they cover', () => {
    const ofl = here('../assets/fonts/OFL.txt');
    expect(existsSync(ofl)).toBe(true);
    const text = readFileSync(ofl, 'utf8');
    expect(text).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
    expect(text).toMatch(/Copyright 2022 The Instrument Sans Project Authors/);
    expect(text).toMatch(/Copyright 2020 The Martian Mono Project Authors/);
    expect(text).toMatch(/Reserved Font Name/);
    // The whole licence, not a link to it.
    expect(text).toMatch(/PERMISSION & CONDITIONS/);
    expect(text).toMatch(/DISCLAIMER/);

    // …and it has to be in the TARBALL, which is the thing being redistributed.
    const pkg = JSON.parse(readFileSync(here('../../../../package.json'), 'utf8')) as {
      files: string[];
    };
    expect(pkg.files).toContain('viewer/client/src/assets/fonts/OFL.txt');
  });

  /**
   * The ghost-utility guard.
   *
   * Tailwind v4 emits a colour rule only for names declared `--color-X` in the
   * `@theme inline` block. The palette also declares each state twice — once as
   * the raw `--status-done` and once as the utility `--color-done` — so a
   * className spelled from the RAW namespace (`bg-status-done`) is a perfectly
   * plausible-looking class that compiles to NOTHING. Three shipped that way.
   */
  it('paints only with colour tokens the theme actually exposes', () => {
    const declared = new Set([...THEME.matchAll(/--color-([a-z][a-z0-9-]*)\s*:/g)].map(([, name]) => name));
    const raw = new Set(
      [...THEME.matchAll(/(?:^|[\s;{])--([a-z][a-z0-9-]*)\s*:/gm)]
        .map(([, name]) => name)
        .filter((name) => !name.startsWith('color-')),
    );
    const offenders: string[] = [];
    for (const file of walk(SRC).filter((f) => /\.tsx?$/.test(f))) {
      const body = readFileSync(file, 'utf8');
      for (const [, base] of body.matchAll(
        /\b(?:text|bg|border|ring|fill|stroke|decoration|outline)-([a-z][a-z0-9-]*)/g,
      )) {
        if (raw.has(base) && !declared.has(base)) {
          offenders.push(`src/${file.replace(SRC, '')}: ${base}`);
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  /**
   * The same guard, widened: a base declared NOWHERE AT ALL. `bg-surface-sunken`
   * sailed through the test above — there is no `--surface-sunken` and no
   * `--color-surface-sunken`, the class compiled to nothing, and four sites
   * painted air. Scoped to the families this palette owns: inside one of
   * those, the full name must be exposed.
   */
  it('never paints from a token family with a name the theme never declared', () => {
    const declared = new Set([...THEME.matchAll(/--color-([a-z][a-z0-9-]*)\s*:/g)].map(([, name]) => name));
    const families = new Set([...declared].map((name) => name.split('-')[0]));
    const offenders: string[] = [];

    for (const file of walk(SRC).filter((f) => /\.(tsx?|css)$/.test(f))) {
      const body = readFileSync(file, 'utf8');
      const flag = (base: string, hit: string) => {
        if (!families.has(base.split('-')[0])) return;
        if (declared.has(base)) return;
        offenders.push(`src/${file.replace(SRC, '')}: ${hit}`);
      };
      // A utility: bg-surface-sunken, text-ink-nope, border-rule-imaginary.
      for (const [hit, base] of body.matchAll(
        /\b(?:text|bg|border|ring|fill|stroke|decoration|outline)-([a-z][a-z0-9-]*)/g,
      )) {
        flag(base, hit);
      }
      // And the same name reached through `var()`, which no scan over utility
      // CLASSES could ever have seen.
      for (const [hit, base] of body.matchAll(/var\(--([a-z][a-z0-9-]*)\)/g)) {
        if (declared.has(base) || THEME.includes(`--${base}:`)) continue;
        flag(base, hit);
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  /**
   * The same defect stated as the shape it actually took, so the guard reads
   * as a rule and not only as an algorithm. `--status-*` is the raw namespace;
   * the utilities are `text-done` / `bg-needs-you` / `hover:text-failed`.
   */
  it('never spells a state utility from the raw --status- namespace', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const body = readFileSync(file, 'utf8');
      for (const [hit] of body.matchAll(/(?:text|bg|border)-status-[a-z][a-z0-9-]*/g)) {
        offenders.push(`src/${file.replace(SRC, '')}: ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Three phone defects, each of which was one declaration, and each of which
 * made a page unusable rather than untidy. They are asserted here because the
 * fix is a stylesheet line with nothing else to hold it in place.
 */
describe('the phone holds together', () => {
  // The map's own sheet, beside it — it rides the map's lazy chunk.
  const ROUTE_MAP = readFileSync(here('../screens/plan/map/route-map.css'), 'utf8');

  it('lets a long path in a sentence wrap instead of widening the page', () => {
    expect(THEME).toMatch(/:not\(pre\)\s*>\s*code[^{]*\{[^}]*overflow-wrap:\s*anywhere/);
    // …and a block of shell still scrolls inside itself rather than wrapping.
    expect(THEME).not.toMatch(/\bpre\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it('does not bounce a strip of empty ground in under the tab bar', () => {
    expect(THEME).toMatch(/body\s*\{[^}]*overscroll-behavior:\s*none/s);
  });

  it('leaves the vertical swipe to the page, even over the route map', () => {
    expect(ROUTE_MAP).toMatch(/\.route-frame\s*\{[^}]*touch-action:\s*auto/s);
    expect(ROUTE_MAP).toMatch(/\.route-frame\[data-interactive\]\s*\{[^}]*touch-action:\s*pan-y/s);
    expect(ROUTE_MAP).not.toMatch(/touch-action:\s*none/s);
  });
});

describe('no stray breakpoints', () => {
  it('branches on no width outside 640/900/1200 anywhere in src/', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      // Plain CSS media queries, and Tailwind's arbitrary-variant forms
      // (`min-[820px]:`, `max-[700px]:`, `[@media(max-width:700px)]:`).
      const widths = [
        ...text.matchAll(/@media[^{]*?(\d+)px/g),
        ...text.matchAll(/(?:min|max)-\[(\d+)px\]/g),
      ].map(([, value]) => Number(value));
      for (const width of widths) {
        // `BP - 1` is how a max-width query expresses "below the breakpoint".
        if (!ALLOWED.includes(width) && !ALLOWED.includes(width + 1)) {
          offenders.push(`src/${file.replace(SRC, '')}: ${width}px`);
        }
      }
    }
    expect(offenders, `stray widths:\n${offenders.join('\n')}`).toEqual([]);
  });
});
