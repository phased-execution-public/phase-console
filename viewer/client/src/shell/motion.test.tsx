/**
 * Motion answers an act, and reduced motion stops all of it (design.md §1
 * principle 9 and §5; quiet-console phase 27).
 *
 * The console has three motions and one transition. `rise` is the one arrival
 * (a bottom sheet, a toast, the bell's selection bar); `fade` is an overlay's
 * scrim and box (a dialog, an end sheet, a popover, a menu); `pulse-soft` is
 * the one continuing motion — a live running thing being watched; and the
 * expand is a region's one grid row growing from 0fr to 1fr. A reader who asks
 * the system to stop moving gets none of them: theme.css's blanket rule
 * flattens every animation, transition and CSS smooth scroll, the track's and
 * the route map's sheets state their own stop beside what they animate, and a
 * scroll the app performs in JS asks `lib/media.ts` first.
 *
 * jsdom computes no styles, so this reads what ships — the stylesheets and the
 * class lists — the shape `theme.test.ts` and `touch.test.ts` take. The real
 * browser's reading is `e2e/doors.spec.ts`'s motion leg, which opens the doors
 * under both preferences and records every animation and transition that
 * starts.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reducedMotion, scrollBehavior } from '@/lib/media';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const theme = readFileSync(join(SRC, 'styles', 'theme.css'), 'utf8');

/** The new client, where every motion is one of the vocabulary's. */
const NEW_TREE = ['ui', 'cards', 'shell', 'screens'];

/** The three motions — the vocabulary design.md §5 closes. */
const MOTIONS = ['fade', 'rise', 'pulse-soft'] as const;

/**
 * The two loading marks the kit draws with Tailwind's own keyframes, by the
 * files that may: a spinner turns while something is fetched (`spin`), a
 * skeleton breathes where a list will be (`pulse`). They are not the page's
 * motions — they stand for "not here yet" — and the blanket rule stops both.
 * Equality both ways: a new site goes red here, a removed one must be struck.
 */
const LOADING_MARKS: Readonly<Record<string, readonly string[]>> = {
  'animate-spin': ['screens/launch/sections.tsx', 'shell/disconnected.tsx', 'ui/feedback.tsx'],
  'animate-pulse': ['ui/feedback.tsx'],
};

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    // Shipped source only — a test (this one included) may NAME a motion.
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\./.test(name)) yield path;
  }
}

const rel = (path: string) => path.slice(SRC.length + 1).replace(/\\/g, '/');

function* shipped(): Generator<string> {
  for (const dir of NEW_TREE) {
    const root = join(SRC, dir);
    if (existsSync(root)) yield* walk(root);
  }
}

/** The body of the block that opens at `from` (the index of its `{`), braces balanced. */
function block(text: string, from: number): string {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && --depth === 0) return text.slice(from + 1, i);
  }
  return text.slice(from + 1);
}

describe('the motions are three, and the stylesheet says which', () => {
  it('declares exactly the three as animation tokens', () => {
    const tokens = [...theme.matchAll(/--animate-([\w-]+):/g)].map((m) => m[1]);
    expect(tokens.sort()).toEqual([...MOTIONS].sort());
  });

  it('draws exactly the three as keyframes', () => {
    const frames = [...theme.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]);
    expect(frames.sort()).toEqual([...MOTIONS].sort());
  });

  it('keeps one continuing motion: only pulse-soft repeats', () => {
    for (const motion of MOTIONS) {
      const line = theme.match(new RegExp(`--animate-${motion}:([^;]+);`))![1]!;
      expect(/\binfinite\b/.test(line), motion).toBe(motion === 'pulse-soft');
    }
  });

  it('makes the expand a transition of its one grid row, on the medium duration, from a first frame of 0fr', () => {
    const rule = block(theme, theme.indexOf('{', theme.indexOf('.expand-region {')));
    expect(rule).toMatch(/grid-template-rows:\s*1fr/);
    expect(rule).toMatch(/transition:\s*grid-template-rows var\(--transition-duration-medium\)/);
    const first = theme.slice(theme.search(/@starting-style\s*\{/));
    expect(block(first, first.indexOf('{'))).toMatch(/\.expand-region\s*\{\s*grid-template-rows:\s*0fr/);
  });
});

describe('under prefers-reduced-motion nothing moves', () => {
  it('the blanket rule stops every animation, transition and smooth scroll, on everything', () => {
    const at = theme.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(at).toBeGreaterThan(-1);
    const rule = block(theme, theme.indexOf('{', at));
    expect(rule).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{/);
    expect(rule).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    // One iteration: an infinite animation at 0.01 ms would still flicker for ever.
    expect(rule).toMatch(/animation-iteration-count:\s*1\s*!important/);
    expect(rule).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(rule).toMatch(/scroll-behavior:\s*auto\s*!important/);
  });

  it('states it in the base layer, where an important declaration outranks every later layer and every unlayered sheet', () => {
    // Important declarations cascade in REVERSE layer order: the first layer's
    // `!important` beats the utilities' and a library's unlayered sheet (React
    // Flow's dash, a vendor's spinner). Outside the base layer it would lose to
    // any utility that said `!important` too.
    const base = theme.indexOf('@layer base {');
    expect(base).toBeGreaterThan(-1);
    const body = block(theme, theme.indexOf('{', base));
    expect(body).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('every animation a class names is one of the three, or a loading mark the kit owns', () => {
    const offenders: string[] = [];
    const marks: Record<string, string[]> = {};
    for (const path of shipped()) {
      if (!/\.tsx?$/.test(path)) continue;
      for (const [name] of readFileSync(path, 'utf8').matchAll(/\banimate-[\w-]+/g)) {
        if ((MOTIONS as readonly string[]).includes(name.slice('animate-'.length))) continue;
        if (name in LOADING_MARKS) (marks[name] ??= []).push(rel(path));
        else offenders.push(`${rel(path)}: ${name}`);
      }
    }
    expect(offenders, 'a motion outside the vocabulary — use rise, fade or pulse-soft, or none').toEqual([]);
    for (const [name, files] of Object.entries(LOADING_MARKS)) {
      expect([...new Set(marks[name] ?? [])].sort(), name).toEqual([...files].sort());
    }
  });

  it('every stylesheet that animates states its own stop beside what it animates', () => {
    const sheets = [...shipped()].filter((path) => path.endsWith('.css'));
    expect(sheets.map(rel)).toContain('ui/track/track.css');
    for (const path of sheets) {
      const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const moves = [...css.matchAll(/(?:^|[\s;{])animation:\s*([^;]+);/g)].filter(
        (m) => m[1]!.trim() !== 'none',
      );
      if (!moves.length) continue;
      const at = css.indexOf('@media (prefers-reduced-motion: reduce)');
      expect(at, `${rel(path)} animates and says nothing for a reader who asked it not to`).toBeGreaterThan(
        -1,
      );
      expect(block(css, css.indexOf('{', at)), rel(path)).toMatch(/animation:\s*none/);
    }
  });

  it('the live pulse is a running thing’s alone: the status family breathes only a live view', () => {
    const dot = readFileSync(join(SRC, 'ui/status/dot-word.tsx'), 'utf8');
    expect(dot).toMatch(/pulses && 'animate-pulse-soft'/);
    expect(dot).toMatch(/const pulses = [^;]*live[^;]*running/);
  });
});

describe('a scroll the app performs asks the preference', () => {
  const answer = (reduce: boolean) =>
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: reduce && query === '(prefers-reduced-motion: reduce)',
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      })),
    );
  afterEach(() => vi.unstubAllGlobals());

  it('jumps for a reader who asked for less motion', () => {
    answer(true);
    expect(reducedMotion()).toBe(true);
    expect(scrollBehavior()).toBe('auto');
  });

  it('glides for everyone else', () => {
    answer(false);
    expect(reducedMotion()).toBe(false);
    expect(scrollBehavior()).toBe('smooth');
  });
});
