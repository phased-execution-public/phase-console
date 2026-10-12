/**
 * The bidi law (design.md §6.2, quiet-console phase 27), held in the
 * stylesheet itself: jsdom computes neither direction nor alignment, and the
 * browser half (`e2e/rtl.spec.ts`) reads only what a page happens to draw.
 *
 * - Every text holder is `unicode-bidi: plaintext`, and every one but a button
 *   keeps the page's ALIGNMENT with `match-parent` — spelled twice, because
 *   Blink and WebKit know only `-webkit-match-parent` (Chromium 151 answers
 *   `CSS.supports('text-align', 'match-parent')` false) and Gecko only the
 *   standard spelling. With the standard one alone every block stood at its own
 *   start, and a Persian title in a list of English ones left the column's edge.
 * - The exemption is a DECLARED direction: a `dir` the kit only repeats from
 *   the page (`DIR_MIRROR`, `ui/direction.ts`) declares nothing, so English in
 *   a radio group keeps its full stop last.
 * - A machine's value — `code`, `kbd`, `samp`, `pre` — reads left to right.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DIR_MIRROR } from '../ui/direction';

// Through a variable, as `logical.test.ts` does: a literal `new URL('./x', import.meta.url)`
// is an asset Vite rewrites into a served URL.
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const css = readFileSync(here('./theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
  selector: selector!.replace(/\s+/g, ' ').trim(),
  body: body!,
}));
const ruleWhere = (declaration: RegExp) => {
  const found = rules.filter((rule) => declaration.test(rule.body));
  expect(found, `one rule declares ${declaration}`).toHaveLength(1);
  return found[0]!;
};
const holders = (selector: string) =>
  /^:where\(([^)]*)\)/
    .exec(selector)![1]!
    .split(',')
    .map((name) => name.trim());

const TEXT_HOLDERS = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'dt',
  'dd',
  'th',
  'td',
  'caption',
  'figcaption',
  'legend',
  'summary',
  'blockquote',
  'div',
  'span',
  'label',
  'a',
];
const MIRROR = Object.keys(DIR_MIRROR)[0]!;

describe('the bidi law in the base layer', () => {
  it('lets every text holder, buttons too, find its own direction', () => {
    const rule = ruleWhere(/unicode-bidi:\s*plaintext/);
    expect(holders(rule.selector).sort()).toEqual([...TEXT_HOLDERS, 'button'].sort());
  });

  it("keeps the page's alignment in every engine: the -webkit- spelling, then the standard one", () => {
    const rule = ruleWhere(/text-align:\s*match-parent/);
    expect(holders(rule.selector).sort()).toEqual([...TEXT_HOLDERS].sort());
    const webkit = rule.body.search(/text-align:\s*-webkit-match-parent/);
    const standard = rule.body.search(/text-align:\s*match-parent/);
    expect(webkit, 'Blink and WebKit read only -webkit-match-parent').toBeGreaterThanOrEqual(0);
    expect(webkit, 'the standard spelling comes last, so Gecko keeps it').toBeLessThan(standard);
  });

  it('exempts a declared direction only — never the mirror the kit hands its primitives', () => {
    expect(MIRROR).toBe('data-dir-mirror');
    for (const rule of [ruleWhere(/unicode-bidi:\s*plaintext/), ruleWhere(/text-align:\s*match-parent/)]) {
      expect(rule.selector).toContain(`:not(:where([dir]:not([${MIRROR}]), body [dir]:not([${MIRROR}]) *))`);
    }
  });

  it("reads a machine's value left to right, isolated from the prose around it", () => {
    const rule = ruleWhere(/direction:\s*ltr/);
    expect(rule.selector.split(',').map((name) => name.trim())).toEqual(['code', 'kbd', 'samp', 'pre']);
    expect(rule.body).toMatch(/unicode-bidi:\s*isolate/);
  });
});
