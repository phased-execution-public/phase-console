/**
 * The guards that stand behind every table: each one reaches the grid (or says
 * why it is hand-rolled), and no `tap-*` host clips the hit area it carries.
 *
 * They read source rather than render, because the claim is about the whole
 * tree: the grid's rail and its card fold are only correct if every table
 * actually reaches `ui/grid/grid.tsx`, and the one thing that can make a
 * `tap-*` floor a lie is the host clipping it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The primitives' own render sites: the markup, and the grid built on it. */
const PRIMITIVES = new Set(['ui/table.tsx', 'ui/grid/grid.tsx']);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(tsx?)$/.test(name) && !/\.test\./.test(name)) yield path;
  }
}

const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const rel = (path: string) =>
  path
    .slice(SRC.length + 1)
    .split('\\')
    .join('/');

describe('a table render site', () => {
  // `[\s>/]` on both branches: `<table>` and `<table/>`, the two simplest
  // spellings, once slipped past a pattern that wanted whitespace after the tag.
  const RENDER_SITE = /<(?:Table|table)[\s>/]/g;

  it('is seen in every spelling — self-closing, bare, or with attributes', () => {
    for (const site of ['<Table/>', '<table/>', '<table>', '<table className="x">', '<Table fixed>']) {
      expect(site.match(RENDER_SITE), site).not.toBeNull();
    }
    // …and never the wrapper, whose next character is not one of the three.
    expect('<TableWrap scrolls>'.match(RENDER_SITE)).toBeNull();
  });

  it('reaches the grid, or its file says why it is hand-rolled', () => {
    const offenders: string[] = [];
    for (const path of walk(SRC)) {
      if (!path.endsWith('.tsx') || PRIMITIVES.has(rel(path))) continue;
      const raw = readFileSync(path, 'utf8');
      const sites = [...stripComments(raw).matchAll(RENDER_SITE)].length;
      if (sites === 0) continue;
      const reasons = [...raw.matchAll(/hand-rolled because:/g)].length;
      if (reasons < sites) offenders.push(`${rel(path)}: ${sites} site(s), ${reasons} reason(s)`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('a tap-area / tap-line host', () => {
  /**
   * `tap-area`/`tap-line` put the hit area in an absolutely positioned `::before`
   * whose containing block is the host (both set `position: relative`), so the
   * HOST's own overflow clips it — and `truncate` is `overflow: hidden`. Measured
   * in headless Chromium: on a `tap-line truncate` host all four corners of the
   * intended 44x44 square miss the control. `styles/touch.test.ts` holds every
   * other touch rule; this is the same rule read from the class lists.
   */
  it('never also clips its own overflow', () => {
    const offenders: string[] = [];
    const CLIP = /\b(truncate|overflow-hidden|overflow-x-hidden|overflow-y-hidden|overflow-clip)\b/;
    for (const path of walk(SRC)) {
      const text = readFileSync(path, 'utf8');
      for (const [attr] of text.matchAll(/className=(?:"[^"]*"|\{`[^`]*`\}|\{[^}]*\})/g)) {
        if (/\btap-(area|line)\b/.test(attr) && CLIP.test(attr)) {
          offenders.push(`${rel(path)}: ${attr.slice(0, 120)}`);
        }
      }
    }
    expect(offenders, 'overflow:hidden on the host clips the 44px ::before hit area').toEqual([]);
  });
});
