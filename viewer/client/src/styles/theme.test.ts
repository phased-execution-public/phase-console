/**
 * The theme guard.
 *
 * Two things rot silently in a token system: a fourth breakpoint appearing
 * because someone needed "just one" media query, and a token being renamed out
 * from under the components that use it. The old stylesheet had five
 * breakpoints (640, 780, 900, 1180, 1200), no two of which agreed on what a
 * small screen was. This test is what keeps that from happening again — and,
 * since 3.0, what keeps the status palette a closed set of eight, the accent a
 * single amber, the type floor at 12 px and the fonts the vendored files (two
 * variable faces since 4.0, with their width clamps).
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

/** Shipped source only — a test may name a width in order to reject it. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(css|ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
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
      ...STATUS_TOKENS,
      '--accent',
      '--action',
      '--focus',
      '--shadow-card',
      '--glow-action',
      '--font-sans',
      '--font-display',
      '--font-mono',
      '--text-2xs',
      '--text-xs',
      '--text-sm',
      '--text-md',
      '--text-lg',
      '--text-xl',
      '--text-2xl',
      '--text-3xl',
      '--tap-min',
      '--text-input',
      '--app-height',
      '--z-base',
      '--z-sticky',
      '--z-shell',
      '--z-scrim',
      '--z-toast',
      '--rail-width',
      '--content-max',
    ];
    const missing = required.filter((token) => !new RegExp(`\\${token}:`).test(THEME));
    expect(missing, `undeclared: ${missing.join(', ')}`).toEqual([]);
  });

  it('defines each colour once, for both themes at the same time', () => {
    // The old file wrote the light palette twice on top of the dark one and the
    // three copies had already drifted (`--line-waiting` was missing from one).
    // `light-dark()` makes a second definition unnecessary — and a duplicate
    // here means someone started a fourth copy.
    for (const token of [
      ...STATUS_TOKENS,
      '--ground',
      '--ground-deep',
      '--surface',
      '--surface-raised',
      '--ink',
      '--track',
    ]) {
      const declarations = [...THEME.matchAll(new RegExp(`^\\s*\\${token}:`, 'gm'))];
      expect(declarations.length, `${token} declared ${declarations.length}x`).toBe(1);
      const line = THEME.split('\n').find((l) => l.trim().startsWith(`${token}:`)) ?? '';
      expect(line, `${token} should carry both themes`).toContain('light-dark(');
    }
  });

  it('holds the status palette at one OKLCH weight per theme', () => {
    // Equal weight is the design rule: no state shouts louder than another by
    // accident. Every chromatic state shares one L/C pair per theme; the two
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

  it('reserves amber for the thing that needs a person', () => {
    // `--accent` is the semantic name; the action colour and the focus ring are
    // it, and it is the needs-you state. A component that wants "do this now"
    // asks for `--action`; nothing asks for the amber literal.
    expect(THEME).toMatch(/--accent:\s*var\(--status-needs-you\)/);
    expect(THEME).toMatch(/--action:\s*var\(--accent\)/);
    expect(THEME).toMatch(/--focus:\s*var\(--accent\)/);
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
  });

  it('keeps the legacy 2.x tokens as aliases, never as a second palette', () => {
    // The views that predate the vocabulary still paint with `--line-*` and
    // `.state-ready` & co. Until Phase 11 deletes them they must resolve — to
    // the vocabulary's own tokens, not to a literal that could drift from it.
    for (const legacy of [
      '--line-done',
      '--line-ready',
      '--line-progress',
      '--line-waiting',
      '--line-blocked',
      '--line-stuck',
      '--line-gated',
    ]) {
      const line = THEME.split('\n').find((l) => l.trim().startsWith(`${legacy}:`)) ?? '';
      expect(line, `${legacy} must alias a --status-* token`).toMatch(/var\(--status-[a-z-]+\)/);
    }
    for (const cls of ['state-ready', 'state-in-progress', 'state-blocked', 'state-stuck', 'state-gated']) {
      expect(THEME, `.${cls} must alias a --status-* token`).toMatch(
        new RegExp(`\\.${cls}\\s*\\{\\s*--state:\\s*var\\(--status-[a-z-]+\\)`),
      );
    }
  });

  it('sets a .state-<ui> class for each of the eight UI states', () => {
    for (const token of STATUS_TOKENS) {
      const ui = token.replace('--status-', '');
      expect(THEME, `.state-${ui}`).toMatch(
        new RegExp(`\\.state-${ui}\\s*\\{\\s*--state:\\s*var\\(${token}\\)`),
      );
    }
  });

  it('sets the type floor at 12 px and lifts the reading sizes', () => {
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
  });

  it('vendors the 4.0 voices as exactly two variable woff2 files and nothing else', () => {
    const fonts = readdirSync(here('../assets/fonts'))
      .filter((f) => f.endsWith('.woff2'))
      .sort();
    expect(fonts).toEqual(['instrument-sans-var.woff2', 'martian-mono-var.woff2']);
    // Every @font-face points at one of them, and every one is pointed at.
    // De-duplicated: the display face deliberately reuses the sans file.
    const referenced = [
      ...new Set([...THEME.matchAll(/url\('\.\.\/assets\/fonts\/([\w.-]+\.woff2)'\)/g)].map(([, f]) => f)),
    ].sort();
    expect(referenced).toEqual(fonts);
    for (const f of fonts) expect(existsSync(here(`../assets/fonts/${f}`))).toBe(true);
    // The families the tokens name are the families the faces declare.
    expect(THEME).toMatch(/--font-sans:\s*'Instrument Sans'/);
    expect(THEME).toMatch(/--font-display:\s*'Instrument Sans Display'/);
    expect(THEME).toMatch(/--font-mono:\s*'Martian Mono'/);
    // Ligatures are off in the mono utility itself, not only on `code`.
    expect(THEME).toMatch(/--font-mono--font-feature-settings:\s*'liga' 0, 'calt' 0/);
  });

  it('clamps the width axes: UI full, display condensed, mono semi-condensed', () => {
    // The display face is the SAME file as the UI face with its width axis
    // clamped by the `font-stretch` descriptor — lose the clamp and the
    // display voice silently becomes the body voice, which nothing else can
    // see. The mono clamp is the density the tables were budgeted on.
    const face = (family: string) =>
      new RegExp(`font-family:\\s*'${family}';[^}]*`, 's').exec(THEME)?.[0] ?? '';
    expect(face('Instrument Sans')).toMatch(/font-stretch:\s*100%/);
    expect(face('Instrument Sans Display')).toMatch(/font-stretch:\s*80%/);
    expect(face('Martian Mono')).toMatch(/font-stretch:\s*87\.5%/);
  });

  /**
   * The woff2 files are REDISTRIBUTED in the npm tarball. The OFL's condition
   * 2 is explicit: a bundled or redistributed copy must carry the copyright
   * notice and the licence, as a stand-alone text file or a readable header —
   * one notice PER redistributed family. Prose about a licence is not the
   * licence (the 3.0 tree learned this the hard way).
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
    // `files` ships `viewer/client/dist/` and not `client/src`, so a licence
    // that only exists in source is a licence that does not travel with the
    // fonts — the same defect, one directory along.
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
   * plausible-looking class that compiles to NOTHING. It typechecks, it lints,
   * it renders, every one of the client's tests passes over it, and the
   * affordance it was painting is simply invisible. Three shipped that way.
   *
   * So: any colour utility whose base names a custom property the stylesheet
   * declares, but which the theme never exposed as `--color-<base>`, is a
   * ghost. That is exactly the raw-namespace mistake and nothing else.
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
   * The same guard, widened — and this is the half that was missing.
   *
   * The test above catches a base declared as a RAW property but never exposed
   * as `--color-*`. It cannot catch a base declared NOWHERE AT ALL, because
   * `raw.has(base)` is false for a name the stylesheet has never heard of. So
   * `bg-surface-sunken` sailed through: there is no `--surface-sunken` and no
   * `--color-surface-sunken`, the class compiled to nothing, and four sites
   * painted air — the run phase table's group headers, the timeline's bar
   * track and two gantt hatch fills. Same failure mode, opposite cause.
   *
   * A blanket "every colour utility must be a project token" would fail on
   * `bg-white` and `text-transparent`, so the rule is scoped to the families
   * this palette owns: inside one of those, the full name must be exposed.
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
      // And the same name reached through `var()` — how the two gantt fills
      // did it, which no scan over utility CLASSES could ever have seen.
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
  const ROUTE_MAP = readFileSync(here('./route-map.css'), 'utf8');

  it('lets a long path in a sentence wrap instead of widening the page', () => {
    // The skill directory printed on Settings is one unbreakable word 91px
    // wider than the phone, and it took the tab bar sideways with it.
    expect(THEME).toMatch(/:not\(pre\)\s*>\s*code[^{]*\{[^}]*overflow-wrap:\s*anywhere/);
    // …and a block of shell still scrolls inside itself rather than wrapping.
    expect(THEME).not.toMatch(/\bpre\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it('does not bounce a strip of empty ground in under the tab bar', () => {
    expect(THEME).toMatch(/body\s*\{[^}]*overscroll-behavior:\s*none/s);
  });

  it('leaves the vertical swipe to the page, even over the route map', () => {
    // `touch-action: none` gave the map every touch that began inside it, and
    // on a phone the map is half the screen — so the tab could not be scrolled.
    // The map now opens LOCKED (`auto` — every gesture is the page's) and only
    // the unlocked `[data-interactive]` state takes the horizontal gestures,
    // still leaving `pan-y` to the page.
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
