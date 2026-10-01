/**
 * The logical-properties guard — RTL is a switch away.
 *
 * WHAT IT HOLDS. The kit (`components/ui/**`) and the shell (`app/shell/**`) say
 * every horizontal margin, padding, inset, border, corner radius and alignment
 * in LOGICAL terms — `ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`, `border-s`/`border-e`,
 * `rounded-s`/`rounded-e` (and `rounded-ss`/`-se`/`-es`/`-ee`), `text-start`/`text-end`,
 * `float-start`/`float-end` — and the four stylesheets (`theme.css`, `console.css`,
 * `prose.css`, `route-map.css`) declare `margin-inline-*`, `padding-inline-*`,
 * `inset-inline-*`, `border-inline-*` and `text-align: start | end`. Never
 * `ml-`/`mr-`/`pl-`/`pr-`/`left-`/`right-`/`border-l`/`border-r`/`rounded-l`/
 * `rounded-r`/`text-left`/`text-right`, and never their CSS or inline-style twins.
 *
 * WHY. A physical side is a decision about which edge the reader's text starts
 * on, made once and for every reader. A logical one is made by the document:
 * `dir="rtl"` on `<html>` flips the rail to the right, the pinned column to the
 * right, the toast tray to the left and every row of icon-then-label with them —
 * no per-component change, no second stylesheet. `e2e/rtl.spec.ts` is the proof
 * in a browser (the home stop, measured with the switch thrown); this file is
 * the ratchet that keeps the next `ml-2` from quietly undoing it, because a
 * physical utility renders identically in LTR and nothing else would ever notice.
 *
 * THE ALLOWANCE is `KEPT`, and it is small on purpose: file, token, how many,
 * and why. What earns a place is a side that is PHYSICAL BY NATURE — a centring
 * pair (`left-1/2` with `-translate-x-1/2`, which has no logical twin and
 * centres in both directions), a variant the API names by edge
 * (`SheetSide` `'right'`), a device's safe-area insets (a notch does not flip
 * with `dir`). Equality is checked in BOTH directions, the shape `touch.test.ts`
 * uses for `WIDTH_RELEASED_FLOORS`: a new physical utility goes red, and a fixed
 * one has to be struck from the list, so a reason cannot rot.
 *
 * WHAT IT DOES NOT SEE, deliberately: transforms and origins (`translate-x-*`,
 * `origin-left`, `slide-in-from-left`, `scaleX`), gradient directions, box-shadow
 * offsets, Radix's `side="left|right"` prop, and `scrollLeft`/`offsetLeft` — each
 * has no logical spelling to migrate to. Those are judged where they are written.
 *
 * Source text, like its siblings: jsdom computes no styles (`css: false`), so the
 * honest assertion is about what ships.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SRC = resolve(here('..'));

/** The two trees the phase names. Everything under them, at any depth. */
const SCOPES = ['components/ui', 'app/shell'];
const STYLESHEETS = ['theme.css', 'console.css', 'prose.css', 'route-map.css'];

/** Shipped source only — a test may NAME a physical utility in order to reject it. */
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) yield path;
  }
}

const rel = (path: string) => path.slice(SRC.length + 1).replace(/\\/g, '/');

/** Blank a match to spaces, keeping its newlines — line numbers stay the file's own. */
const blank = (match: string) => match.replace(/[^\n]/g, ' ');

/**
 * A source file with its comments blanked.
 *
 * Every sweep here is about what SHIPS, and a sentence explaining why a side is
 * physical must not read as the side being physical (`tab-bar.tsx` names
 * `-right-3` in the comment that says why the badge no longer uses it).
 *
 * Anchored to the start of a line, which is where every block comment in this
 * codebase begins, for the reason `touch.test.ts`'s `code()` records: the
 * unanchored form runs a comment opener found inside a string to the next real
 * terminator and swallows real classes. The price is that a trailing comment on
 * a code line is read as code — put the sentence on a line of its own.
 */
const code = (text: string) =>
  text.replace(/^[ \t]*\{?\/\*[\s\S]*?\*\/\}?/gm, blank).replace(/^[ \t]*\/\/.*$/gm, blank);

/** A stylesheet without its comments — CSS has one form, so it is safe unanchored. */
const css = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, blank);

/**
 * `(?<![\w-])` is the boundary of a class token: a utility starts after a space,
 * a quote, a bracket or a `:` (so `md:`, `hover:` and `[&>button]:` all pass) and
 * never in the middle of a word or a hyphenated name — which is what keeps
 * `top-left-…`, `slide-in-from-left`, `bg-right-top` and `data-[side=left]` out.
 */
const B = String.raw`(?<![\w-])`;

/** Every physical spelling in a class string or an inline style, by kind. */
const SOURCE_KINDS: readonly (readonly [kind: string, pattern: RegExp])[] = [
  ['margin/padding (ml- mr- pl- pr-)', new RegExp(String.raw`${B}-?(?:ml|mr|pl|pr)-`, 'g')],
  ['inset (left- right-)', new RegExp(String.raw`${B}-?(?:left|right)-`, 'g')],
  ['border (border-l border-r)', new RegExp(String.raw`${B}border-[lr](?![a-z])`, 'g')],
  [
    'corners (rounded-l/r/tl/tr/bl/br)',
    new RegExp(String.raw`${B}rounded-(?:l|r|tl|tr|bl|br)(?![a-z])`, 'g'),
  ],
  ['alignment (text-left text-right)', new RegExp(String.raw`${B}text-(?:left|right)(?![\w-])`, 'g')],
  [
    'float/clear (float-left clear-right)',
    new RegExp(String.raw`${B}(?:float|clear)-(?:left|right)(?![\w-])`, 'g'),
  ],
  ['scroll margin/padding (scroll-ml- …)', new RegExp(String.raw`${B}scroll-[mp][lr]-`, 'g')],
  // The same sides spelled the other two ways a class list can be reached.
  [
    'arbitrary property ([margin-left:…] [left:…])',
    new RegExp(
      String.raw`\[(?:(?:margin|padding|border)-)?(?:left|right)\s*:|\[text-align\s*:\s*(?:left|right)\b`,
      'g',
    ),
  ],
  ['inline style (marginLeft borderRight …)', /(?<![\w$.])(?:margin|padding|border)(?:Left|Right)\b/g],
  ['inline style (left: right:)', /(?<![\w$.'"[-])(?:left|right)\s*:/g],
  ['inline style (textAlign: left)', /\btextAlign\s*:\s*['"](?:left|right)['"]/g],
];

/** The declarations a stylesheet can make with a side in the NAME. */
const CSS_KINDS: readonly (readonly [kind: string, pattern: RegExp])[] = [
  ['margin-left/right', /(?<![\w-])margin-(?:left|right)(?=\s*:)/g],
  ['padding-left/right', /(?<![\w-])padding-(?:left|right)(?=\s*:)/g],
  ['border-left/right (and -width/-style/-color)', /(?<![\w-])border-(?:left|right)(?:-[a-z]+)?(?=\s*:)/g],
  ['border-top-left-radius & co', /(?<![\w-])border-(?:top|bottom)-(?:left|right)-radius(?=\s*:)/g],
  ['scroll-margin/padding-left/right', /(?<![\w-])scroll-(?:margin|padding)-(?:left|right)(?=\s*:)/g],
  ['left: right: (a positioned offset)', /(?<![\w-])(?:left|right)(?=\s*:)/g],
  ['text-align: left|right', /(?<![\w-])text-align\s*:\s*(?:left|right)\b/g],
  ['float/clear: left|right', /(?<![\w-])(?:float|clear)\s*:\s*(?:left|right)\b/g],
];

interface Hit {
  file: string;
  line: number;
  kind: string;
  /** The utility or property as written, to the end of the token. */
  token: string;
}

/** Where a class token ends: a space, a quote, a backtick or a comma. */
const TOKEN_END = /[\s'"`,;]/;

function hitsIn(
  file: string,
  text: string,
  kinds: readonly (readonly [string, RegExp])[],
  wholeToken: boolean,
): Hit[] {
  const out: Hit[] = [];
  for (const [kind, pattern] of kinds) {
    for (const m of text.matchAll(pattern)) {
      const at = m.index ?? 0;
      let end = at + m[0].length;
      if (wholeToken) while (end < text.length && !TOKEN_END.test(text[end]!)) end += 1;
      out.push({
        file,
        line: text.slice(0, at).split('\n').length,
        kind,
        token: text.slice(at, end).trim(),
      });
    }
  }
  return out;
}

function sourceHits(): { hits: Hit[]; files: string[] } {
  const files: string[] = [];
  const hits: Hit[] = [];
  for (const scope of SCOPES) {
    for (const path of walk(join(SRC, ...scope.split('/')))) {
      files.push(rel(path));
      hits.push(...hitsIn(rel(path), code(readFileSync(path, 'utf8')), SOURCE_KINDS, true));
    }
  }
  return { hits, files };
}

function styleHits(): Hit[] {
  const hits: Hit[] = [];
  for (const name of STYLESHEETS) {
    hits.push(
      ...hitsIn(`styles/${name}`, css(readFileSync(join(SRC, 'styles', name), 'utf8')), CSS_KINDS, false),
    );
  }
  return hits;
}

/**
 * The physical sides that stay physical, each with the reason it has no logical
 * spelling to migrate to. `token` is the utility or property as written; `count`
 * is how many times, so an extra one is a new violation and a removed one is a
 * stale entry.
 */
const KEPT: readonly { file: string; token: string; count: number; why: string }[] = [
  {
    file: 'components/ui/dialog.tsx',
    token: 'left-1/2',
    count: 2,
    why: 'centring pair with -translate-x-1/2 (Dialog and DialogContent): translate has no logical twin, and left:50% with -50% centres in either direction',
  },
  {
    file: 'components/ui/alert-dialog.tsx',
    token: 'left-1/2',
    count: 1,
    why: 'centring pair with -translate-x-1/2, as Dialog',
  },
  {
    file: 'app/shell/tab-bar.tsx',
    token: 'left-1/2',
    count: 2,
    why: 'the active-tab mark: centring pair with -translate-x-1/2, on a tab and on More',
  },
  {
    file: 'components/ui/sheet.tsx',
    token: 'right-0',
    count: 1,
    why: 'SheetSide "right" names a physical edge, and eight call sites pass it by name (help, the bell drawer, the inspector, the chat dock, the QA report …). Flipping it is a rename to "end" across them, not a respelling',
  },
  {
    file: 'components/ui/sheet.tsx',
    token: 'border-l',
    count: 1,
    why: 'the divider of that same "right" sheet — it goes with the edge it faces',
  },
  {
    file: 'styles/theme.css',
    token: 'left',
    count: 1,
    why: 'tap-area::before — centring pair (left:50% with translate:-50% -50%), the same reason as left-1/2',
  },
  {
    file: 'styles/theme.css',
    token: 'padding-left',
    count: 1,
    why: ".px-safe — env(safe-area-inset-left) is the DEVICE's left: a notch does not move with dir, so neither may its padding",
  },
  {
    file: 'styles/theme.css',
    token: 'padding-right',
    count: 1,
    why: '.px-safe — env(safe-area-inset-right), as above',
  },
];

/** Hits not covered by the allowance, and allowance entries that no longer match. */
function judge(hits: readonly Hit[], scope: (file: string) => boolean) {
  const seen = new Map<string, number>();
  const offenders: Hit[] = [];
  const allowed = new Map(KEPT.filter((k) => scope(k.file)).map((k) => [`${k.file}\0${k.token}`, k]));
  for (const hit of hits) {
    const key = `${hit.file}\0${hit.token}`;
    const keep = allowed.get(key);
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (!keep || (seen.get(key) ?? 0) > keep.count) offenders.push(hit);
  }
  const stale = [...allowed.entries()]
    .filter(([key, keep]) => (seen.get(key) ?? 0) !== keep.count)
    .map(
      ([key, keep]) => `${keep.file}: ${keep.token} — expected ${keep.count}, found ${seen.get(key) ?? 0}`,
    );
  return { offenders, stale };
}

const show = (hits: readonly Hit[]) => hits.map((h) => `${h.file}:${h.line}  ${h.token}   [${h.kind}]`);

describe('the kit and the shell spell their sides logically', () => {
  const { hits, files } = sourceHits();

  it('scans the whole of components/ui and app/shell', () => {
    // A guard that finds nothing because it walked nothing is the failure this
    // pins: the two trees are large, and both must be in the sweep.
    expect(files.filter((f) => f.startsWith('components/ui/')).length).toBeGreaterThan(50);
    expect(files.filter((f) => f.startsWith('app/shell/')).length).toBeGreaterThan(8);
    expect(files).toContain('components/ui/button.tsx');
    expect(files).toContain('components/ui/status/status-icons.ts');
    expect(files).toContain('app/shell/layout.tsx');
    expect(files.filter((f) => /\.test\./.test(f))).toEqual([]);
  });

  it('holds no ml- mr- pl- pr- left- right- border-l/r rounded-l/r text-left/right … outside the allowance', () => {
    const { offenders } = judge(hits, (f) => !f.startsWith('styles/'));
    expect(
      show(offenders),
      'spell it logically: ml→ms, mr→me, pl→ps, pr→pe, left→start, right→end, border-l→border-s, ' +
        'border-r→border-e, rounded-l→rounded-s, rounded-r→rounded-e, rounded-tl/tr/bl/br→rounded-ss/se/es/ee, ' +
        'text-left→text-start, text-right→text-end — or, if the side is physical by nature, add it to KEPT with the reason',
    ).toEqual([]);
  });

  it('keeps no allowance the source has stopped needing', () => {
    const { stale } = judge(hits, (f) => !f.startsWith('styles/'));
    expect(stale, 'strike it from KEPT — the source no longer carries it').toEqual([]);
  });
});

describe('the stylesheets declare their sides logically', () => {
  const hits = styleHits();

  it('holds no margin-left/right, padding-left/right, border-left/right, left:/right: or text-align: left|right outside the allowance', () => {
    const { offenders } = judge(hits, (f) => f.startsWith('styles/'));
    expect(
      show(offenders),
      'declare it logically: margin-inline-start/end, padding-inline-start/end, inset-inline-start/end, ' +
        'border-inline-start/end, text-align: start|end — or add it to KEPT with the reason it is physical',
    ).toEqual([]);
  });

  it('keeps no allowance the stylesheets have stopped needing', () => {
    const { stale } = judge(hits, (f) => f.startsWith('styles/'));
    expect(stale, 'strike it from KEPT — the stylesheet no longer carries it').toEqual([]);
  });

  it('reads route-map.css as the logical stylesheet it already is', () => {
    // It says `inset-inline-*` and `:dir(rtl)` throughout — the guard must read
    // them as the logical spelling they are, and not trip over the word "left"
    // in a gradient (`to right`) or a comment about one.
    const map = css(readFileSync(join(SRC, 'styles', 'route-map.css'), 'utf8'));
    expect(map).toMatch(/inset-inline-start/);
    expect(hitsIn('styles/route-map.css', map, CSS_KINDS, false)).toEqual([]);
  });
});

/**
 * The sweep is only worth its green if it can go red. These are the spellings
 * it exists for, the ones that look like them and are not, and the two places a
 * sentence about a physical side is allowed to live.
 */
describe('the sweep can see what it sweeps for', () => {
  const tokens = (text: string) => hitsIn('sample', code(text), SOURCE_KINDS, true).map((h) => h.token);

  it('finds every physical spelling — bare, negative, variant-prefixed and arbitrary', () => {
    expect(tokens(`'ml-2 -mr-1 sm:pl-3 md:!pr-0 [&>svg]:ml-auto first:pl-[10px]'`)).toEqual([
      'ml-2',
      '-mr-1',
      'pl-3',
      'pr-0',
      'ml-auto',
      'pl-[10px]',
    ]);
    expect(tokens(`"absolute left-0 -right-px md:right-2 focus:left-3"`)).toEqual([
      'left-0',
      '-right-px',
      'right-2',
      'left-3',
    ]);
    expect(tokens(`'border-l border-r-0 last:border-r border-l-2'`)).toEqual([
      'border-l',
      'border-r-0',
      'border-r',
      'border-l-2',
    ]);
    expect(
      tokens(`'rounded-l first:rounded-r-md [&>a]:rounded-tl-[3px] rounded-br rounded-bl-lg rounded-tr'`),
    ).toEqual(['rounded-l', 'rounded-r-md', 'rounded-tl-[3px]', 'rounded-br', 'rounded-bl-lg', 'rounded-tr']);
    expect(tokens(`'text-left [&_th]:text-right float-left clear-right scroll-ml-2 scroll-pr-4'`)).toEqual([
      'text-left',
      'text-right',
      'float-left',
      'clear-right',
      'scroll-ml-2',
      'scroll-pr-4',
    ]);
    expect(tokens('`pl-${depth}`')).toEqual(['pl-${depth}']);
  });

  it('finds the sides spelled as an arbitrary property or an inline style', () => {
    expect(
      tokens(`'[padding-left:4px] [border-right:1px_solid] [left:0] [right:50%] [text-align:right]'`),
    ).toEqual([
      '[padding-left:4px]',
      '[border-right:1px_solid]',
      '[left:0]',
      '[right:50%]',
      '[text-align:right]',
    ]);
    expect(
      tokens(`style={{ marginLeft: 4, paddingRight: 2, borderLeft: 'none', textAlign: 'right' }}`),
    ).toHaveLength(4);
    expect(tokens(`style={{ left: 0, top: 0 }}`)).toEqual(['left:']);
    expect(tokens(`style={{ right: \`\${x}%\` }}`)).toEqual(['right:']);
  });

  it('leaves the logical spellings, and the physical-by-nature ones the guard does not claim, alone', () => {
    expect(
      tokens(
        `'ms-2 me-auto ps-3 pe-0 start-0 end-2 -start-px border-s border-e-2 rounded-s rounded-e-md rounded-ss ` +
          `rounded-ee text-start text-end float-start scroll-ms-2 inset-x-0 px-2 mx-auto'`,
      ),
    ).toEqual([]);
    expect(
      tokens(
        `'-translate-x-1/2 translate-x-0.5 origin-left origin-top-left slide-in-from-left slide-out-to-right ` +
          `data-[side=left]:animate-x bg-right-top object-left-top top-left-corner items-start justify-end'`,
      ),
    ).toEqual([]);
    // Words that merely contain a side: a `pr-` that is a pull request, a `-left-` inside a name.
    expect(
      tokens(
        `'sample-left-1 impl-right-2 border-rule border-red-500 border-lime-500 rounded-lg rounded-t-md'`,
      ),
    ).toEqual([]);
  });

  it('does not read a comment as code — own-line, block, or JSX', () => {
    const src = [
      `// ml-2 was the old spelling`,
      `  /* pr-3 and`,
      `     left-0 too */`,
      `  {/* border-r, in prose`,
      `      across lines */}`,
      `<p className="ms-2" />`,
    ].join('\n');
    expect(tokens(src)).toEqual([]);
    // …and the line numbers stay the file's own.
    expect(hitsIn('sample', code(`// note\nclassName="pl-2"`), SOURCE_KINDS, true)[0]?.line).toBe(2);
  });

  it('reads a stylesheet declaration by its name, not by a word in a value', () => {
    const at = (text: string) => hitsIn('x.css', css(text), CSS_KINDS, false).map((h) => h.token);
    expect(
      at(
        `.a { margin-left: 1px; padding-right: 2px; border-left: 2px solid red; border-right-width: 1px; ` +
          `left: 0; right: 50%; text-align: right; float: left; border-top-left-radius: 2px; ` +
          `scroll-padding-left: 1px }`,
      ),
    ).toEqual([
      'margin-left',
      'padding-right',
      'border-left',
      'border-right-width',
      'border-top-left-radius',
      'scroll-padding-left',
      'left',
      'right',
      'text-align: right',
      'float: left',
    ]);
    expect(
      at(
        `.a { margin-inline-start: 1px; padding-inline: 2px; inset-inline-start: 0; border-inline-end: 1px solid; ` +
          `text-align: start; border-start-start-radius: 2px; padding-left-x: 0 } ` +
          `/* margin-left: 1px; left: 0 */ .b { mask-image: linear-gradient(to right, black, transparent); ` +
          `padding: env(safe-area-inset-left) }`,
      ),
    ).toEqual([]);
  });
});
