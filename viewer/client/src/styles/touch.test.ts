/**
 * Touch-correctness guards, as source text — jsdom computes no styles
 * (`css: false`), so the honest assertions are about what ships, in the shape
 * `theme.test.ts` established.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..');
const theme = readFileSync(join(here, 'theme.css'), 'utf8');
const indexHtml = readFileSync(join(SRC, '..', 'index.html'), 'utf8');

/**
 * The trees a surface is written in: the kit, the cards, the shell and the
 * screens — every file that draws something a person meets. `lib/` and
 * `data/` draw nothing, so the page sweeps below do not read them; a rule
 * about anything that ships walks the whole of `src/` instead.
 */
const SURFACE_TREES = ['ui', 'cards', 'shell', 'screens'];

/** Every primitive that floats over the page and must size by the VISIBLE viewport. */
const OVERLAYS = [
  'ui/dialog.tsx',
  'ui/confirm.tsx',
  'ui/sheet.tsx',
  'ui/popover.tsx',
  'ui/dropdown.tsx',
  'ui/select.tsx',
  'ui/command.tsx',
];

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    // App source only — a test (this one included) may NAME the pattern.
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\./.test(name)) yield path;
  }
}

/** Every file a surface is written in. */
function* surfaces(): Generator<string> {
  for (const dir of SURFACE_TREES) yield* walk(join(SRC, dir));
}

const rel = (path: string) => path.slice(SRC.length + 1);

/**
 * A JSX opening tag, from `<name` to the `>` that closes IT.
 *
 * Depth-aware, because the first `>` in a JSX tag is almost never the tag's:
 * it belongs to the `=>` of an `onChange`/`onScroll` handler, often several
 * attributes before `className`. Cutting at it hides the class list, and a
 * sweep that reads no class list reports no offenders — which is what the
 * first draft of the `<select>` sweep did, and what a later `[^>]*` in the
 * `TableWrap` sweep did in the other direction (it called a correctly gated
 * wrapper ungated, because the `scrolls=` sat past a handler's arrow).
 */
function openTag(text: string, from: number): string {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return text.slice(from, i + 1);
  }
  return text.slice(from);
}

/**
 * Every class list in a file, in all three shapes it is written in.
 *
 * `className="…"`, `className={`…`}` and `className={cn('…', …)}` are one
 * question with three spellings, and a sweep that reads only the first has a
 * bypass that needs no new import to reach — the byte-exact defect, retyped
 * inside a template literal.
 */
function classLists(text: string): string[] {
  const out: string[] = [];
  for (const [attr] of text.matchAll(/className=(?:"[^"]*"|\{`[^`]*`\}|\{[^}]*\})/g)) out.push(attr);
  return out;
}

/**
 * A file with its comments removed.
 *
 * Every sweep below is about what SHIPS, and a prose paragraph explaining why a
 * unit is banned must not read as the ban being broken — `shell/layout.tsx`
 * names `dvh` three times in the comment that forbids it.
 *
 * Anchored to the start of a line, which is where every block comment in this
 * codebase begins, because the unanchored form is not sound: a comment OPENER
 * inside a string starts a comment the stripper then runs to the next real
 * terminator. `screens/settings/rules.tsx` has one, in the hint that
 * explains one glob segment against any depth, and the greedy version swallowed
 * 180 lines from it — including two of the very selects the sweep below exists
 * to find.
 */
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/^[ \t]*\{?\/\*[\s\S]*?\*\/\}?/gm, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

describe('the input floor wins on touch', () => {
  it('theme.css carries the UNLAYERED coarse-pointer floor, after the last @layer block', () => {
    const floor = theme.indexOf('@media (pointer: coarse)');
    expect(floor).toBeGreaterThan(-1);
    expect(theme.slice(floor)).toMatch(
      /input,\s*textarea,\s*select\s*\{\s*font-size:\s*max\(var\(--text-input\),\s*1em\)/,
    );
    // Everything layered loses to unlayered CSS — but only if this rule IS
    // unlayered: it must sit after the last @layer/@import block.
    expect(floor).toBeGreaterThan(theme.lastIndexOf('@layer'));
  });

  it('the field class is defined exactly once under src/ — in ui/field.ts', () => {
    const definitions: string[] = [];
    for (const path of walk(SRC)) {
      const text = readFileSync(path, 'utf8');
      // The historic copy-paste: a local `const field = 'h-9 …'`.
      if (/const field =\s*\n?\s*'h-9 /.test(text)) definitions.push(path);
    }
    expect(definitions).toEqual([join(SRC, 'ui', 'field.ts')]);
  });
});

describe('the keyboard contract', () => {
  it('index.html asks Android to resize the LAYOUT viewport for the keyboard', () => {
    expect(indexHtml).toMatch(/interactive-widget=resizes-content/);
  });

  it('--app-height exists with its dvh fallback, and the shell consumes it', () => {
    expect(theme).toMatch(/--app-height:\s*100dvh/);
    // The grid moved out of `App.tsx` and into the shell layout in 3.0; the
    // rule did not move with it — `dvh` ignores the software keyboard on iOS,
    // so the shell's own height is this token and nothing else.
    // Through `code()`: `layout.tsx`'s own comments NAME the units and axes it
    // forbids, and a sweep that reads the prose is the incident this file's
    // header records (`dvh`, named three times in the comment banning it).
    const layout = code(join(SRC, 'shell', 'layout.tsx'));
    expect(layout).toMatch(/h-\(--app-height\)/);
    expect(layout).not.toMatch(/'grid h-dvh/);
  });
});

describe('scroll traps stay dead', () => {
  it('the live console body chains at its ends instead of stopping the page', () => {
    const console_ = readFileSync(join(SRC, 'screens', 'plan', 'run', 'console.tsx'), 'utf8');
    expect(console_).not.toMatch(/live-body[^"]*overscroll-contain/);
  });

  /*
   * The one that shipped anyway, and the sweep that would have caught it.
   *
   * `screens/launch/per-phase.tsx` imported `stickyHeadCell`, put it on all
   * seven header cells and left the wrapper at its default — which scrolls. A
   * sticky header inside an overflow-x box binds to a box that never scrolls
   * vertically: the columns left the screen on the first flick and did not come
   * back. The primitives' own guard (the grid's, below) cannot see a consumer,
   * so this one reads every surface that reaches for the class.
   */
  it('every surface that pins a header also says when its wrapper scrolls', () => {
    const offenders: string[] = [];
    for (const path of surfaces()) {
      // The kit's own definition of the class is not a consumer of it.
      if (rel(path) === 'ui/table.tsx') continue;
      const text = code(path);
      if (!/\bstickyHeadCell\b/.test(text)) continue;
      if (!/scrolls=\{[^}]*overflows/.test(text)) offenders.push(rel(path));
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The grid keeps the table rules.
 *
 * Two files, one decision: the kit's `ui/table.tsx` owns the wrapper, the
 * sticky header class and the pinned identity cell, and the grid built on it
 * (`ui/grid/grid.tsx`) decides when to apply them — so each case reads both
 * halves.
 */
describe('the grid keeps the table rules', () => {
  const kit = () => code(join(SRC, 'ui', 'table.tsx'));
  const grid = () => code(join(SRC, 'ui', 'grid', 'grid.tsx'));

  /*
   * A sticky header and a scrolling wrapper are a pair, not two classes:
   * `position: sticky` binds to the nearest scrolling ancestor, so a header
   * inside an always-scrolling wrapper can only stick to a box that never
   * scrolls vertically — pure paint cost, and a layer per table. The wrapper is
   * a scroll container only when the table actually overflows it, so the header
   * may stick on the other branch, where it binds to `<main>` and works. The
   * invariant is that the two stay coupled; banning `sticky top-0` outright
   * would hold the title by losing the header.
   */
  it('sticks its header only outside a scroll container, and only once measured', () => {
    // The wrapper never scrolls unconditionally — `scrolls` gates it.
    expect(kit()).toMatch(/scrolls && 'overflow-x-auto overscroll-x-contain'/);
    expect(kit()).not.toMatch(/'w-full max-w-full overflow-x-auto/);
    // And the sticky header is applied only on the branch that does not scroll
    // — and only once a real width exists, because "not measured" resolves to
    // the scrolling branch and sticky may not ride along with it.
    expect(kit()).toMatch(/stickyHeadCell =\s*\n?\s*'sticky top-0/);
    expect(grid()).toMatch(/const \{ wrapRef, tableRef, width, overflows, measured \} = useTableFit\(\)/);
    expect(grid()).toMatch(/sticky=\{!overflows && measured\}/);
    expect(grid()).toMatch(/scrolls=\{overflows \|\| !measured\}/);
    expect(grid()).toMatch(/sticky && stickyHeadCell/);
    // Never a max-height, so never a second vertical scroller: overflow-x makes
    // computed overflow-y auto, and a height-capped wrapper eats the page's
    // touch flick. The grid's window scrolls `<main>`, never a box of its own.
    expect(kit()).not.toMatch(/max-h-/);
    expect(grid()).not.toMatch(/max-h-/);
  });

  it('pins an opaque identity cell, offset on the logical side', () => {
    // `bg-inherit` alone takes the row's colour and NOTHING under it, so a live
    // run's row (`bg-running/8`) left its pinned phase number 92 % see-through
    // and the Status column was read through it as it scrolled past. The cell
    // paints its own base and composites the row's tint back over it.
    const pinned = /export const stickyIdentityCell = \[([\s\S]*?)\]\.join/.exec(kit());
    expect(pinned, 'stickyIdentityCell must still be the layered class list').not.toBeNull();
    for (const layer of ['before:bg-surface', 'after:bg-inherit', 'isolate', 'start-0']) {
      expect(pinned![1]).toContain(layer);
    }
    // Both layers behind the cell's own content, inside the cell's own stacking
    // context — otherwise the tint paints over the number instead of under it.
    expect(pinned![1]).toMatch(/before:-z-\d+/);
    expect(pinned![1]).toMatch(/after:-z-\d+/);
    // The grid paints every pinned cell with it, and offsets the rail with the
    // logical inset — `left` would pin the wrong edge under `dir="rtl"`.
    expect(grid()).toMatch(/pinnedAt !== undefined && stickyIdentityCell/);
    expect(grid()).toMatch(/insetInlineStart: pinnedAt/);
    expect(grid()).not.toMatch(/\bleft: /);
  });

  it('declares a min per column, and lays out the track the cut budgeted', () => {
    const column = code(join(SRC, 'ui', 'grid', 'column.ts'));
    const body = /export interface Column<T> extends ColumnTrack \{([\s\S]*?)\n\}/.exec(column);
    expect(body, 'ui/grid/column.ts declares the Column').not.toBeNull();
    expect(body![1]).toMatch(/^\s*min: number;$/m);
    expect(body![1]).not.toMatch(/^\s*min\?:/m);
    expect(grid()).toMatch(/width: column\.width \?\? trackOf\(column\)/);
  });
});

/* ------------------------------------------------------------------ *
 * The three sweeps — a rule is only a rule if it holds everywhere
 * ------------------------------------------------------------------ */

describe('no surface sizes itself by dvh', () => {
  /**
   * `dvh` is the LARGE viewport: on iOS it ignores the software keyboard, so a
   * sheet sized in it puts its own buttons underneath the keys. `--app-height`
   * follows `visualViewport` and falls back to `100dvh` in exactly one place —
   * `theme.css`, where the token is declared.
   *
   * The rule is absolute: there is no `dvh` on any surface at all, and no
   * allowance to add a name to — the two shipped uses this sweep was written
   * around (the run console's transcript pane and the run-setup settings
   * sheet) were fixed, not excused.
   */

  it('every surface sizes by --app-height', () => {
    const offenders: string[] = [];
    for (const path of surfaces()) {
      // No word boundary: the unit arrives welded to its number (`50dvh`,
      // `max-h-[85dvh]`), and `\bdvh\b` matches neither — which is how the
      // first draft of this sweep passed over both of the known two.
      if (/dvh/.test(code(path))) offenders.push(rel(path));
    }
    expect(offenders).toEqual([]);
  });
});

describe('nothing is revealed by hover alone', () => {
  /**
   * A control at `opacity-0` that comes back on `:hover` is invisible forever on
   * a touch screen — there is no hover, and the first tap is the click. The
   * shipped pattern pairs every such reveal with `[@media(hover:none)]`, which
   * is a media query and not a state, so the control is simply always there on
   * a phone (`screens/repo/diff-view.tsx`). The line comment's inline "+" in the
   * review panel is what this was written for: on a phone there was no way to
   * comment.
   */
  it('every opacity-0 reveal has a coarse-pointer path', () => {
    const offenders: string[] = [];
    for (const path of surfaces()) {
      for (const [attr] of code(path).matchAll(/className=(?:"[^"]*"|\{`[^`]*`\}|\{[^}]*\})/g)) {
        if (!/\bopacity-0\b/.test(attr)) continue;
        if (!/(?:hover|hover_&\]):opacity-100/.test(attr)) continue;
        if (!/\[@media\(hover:none\)\]:opacity-100/.test(attr)) offenders.push(rel(path));
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });
});

describe('the thumb floor is a hit area, not a class', () => {
  /**
   * A `tap-area`/`tap-line` host may not clip its own overflow.
   *
   * Both utilities put the 44px hit area in an absolutely positioned `::before`
   * whose containing block is the HOST — both set `position: relative` — so the
   * host's own `overflow` cuts the hit area back to the drawn box, and the
   * class then asserts a floor that measurably is not there. `truncate` is
   * `overflow: hidden`, and two shipped sites carried both: measured in
   * headless Chromium against the phase's own compiled stylesheet with the
   * coarse-pointer branch live, `tap-line truncate` gave a 187×20 link a 44px
   * `::before` and all four corners of the intended square missed it; the same
   * markup without `truncate` hit all four.
   *
   * The fix is to move the clip onto an inner span. This is the guard, because
   * an inert class cannot be seen by looking at the page and cannot be seen by
   * `elementsFromPoint` either.
   */
  it('no tap-area / tap-line host also clips its own overflow', () => {
    const CLIPS = /\b(truncate|overflow-hidden|overflow-x-hidden|overflow-y-hidden|overflow-clip)\b/;
    const offenders: string[] = [];
    for (const path of walk(SRC)) {
      if (!path.endsWith('.tsx') && !path.endsWith('.ts')) continue;
      for (const attr of classLists(code(path))) {
        if (/\btap-(?:area|line)\b/.test(attr) && CLIPS.test(attr)) {
          offenders.push(`${rel(path)}: ${attr.slice(0, 120)}`);
        }
      }
    }
    expect(
      offenders,
      'overflow:hidden on the host clips the 44px ::before — put the clip on an inner span',
    ).toEqual([]);
  });

  /**
   * A control with controls above or below it takes the BOX floor, not an overlay.
   *
   * The other way an overlay is not a hit area: it overhangs its host by
   * `(44 − height)/2` at each end — 12.5px on a 19px line — and being a
   * positioned descendant it hit-tests ABOVE non-positioned siblings. Measured
   * twice, on two surfaces:
   *
   *   **the approve card** (now Your turn's item card). "Open where it lives" sits `gap-2` (8px) under
   *   Allow / Deny / Stop, so the overlay's top edge landed at y=497 against a
   *   button row ending at y=502 and `elementFromPoint` three pixels inside
   *   EVERY one of the three buttons answered the link. Five pixels, on the one
   *   surface where a mis-tap grants or denies a run.
   *
   *   **the Insights plan lists.** 20px rows at a 24px pitch: each row's 44px
   *   overlay reached 12px into the row above and won there, so 8px of a row's
   *   VISIBLE slug opened the row below's plan.
   *
   * `tap-row` / `tap-cell` are the answer at every site below — the drawn box
   * is the target, so it cannot reach past itself. Pinned as source text
   * because jsdom computes no styles; the measurement lives in the register.
   */
  const BOX_FLOOR: Readonly<Record<string, number>> = Object.freeze({
    // Your turn — an item's links stack under its buttons, and the page's lists stack links:
    'cards/item-card.tsx': 2, // the facts' plan / phase / run / unblocks links, "Open where it lives"
    'screens/turn/index.tsx': 1, // "Repo ▸ Issues" under the toolbar
    'screens/turn/handled.tsx': 1, // a handled row's plan and web links share one class
    'screens/turn/inspector.tsx': 1, // the explain view's plan / phase / run links
    'cards/guide.tsx': 1, // a guide step's link, its address beneath it
    // Insights: the grid floors its own row links, so what is left here are
    // the two stacked lists it does not draw — the health issues and the
    // stalled plans.
    'screens/insights/portfolio.tsx': 2, // a health issue's plan link, a stalled plan
  });

  it('the surfaces measured as stealing a neighbour floor by the box, not an overlay', () => {
    for (const [file, count] of Object.entries(BOX_FLOOR)) {
      const text = code(join(SRC, ...file.split('/')));
      const floors = [...text.matchAll(/\btap-(?:row|cell)\b/g)];
      expect(floors, `${file}: box floors`).toHaveLength(count);
      expect(text, `${file}: an overlay here reaches into a neighbouring control`).not.toMatch(
        /\btap-(?:line|area)\b/,
      );
    }
  });

  /* ------------------------------------------------------------------ *
   * A floor is a claim about the ANCESTORS too.
   *
   * The third instance of one root cause, and the one none of the probes
   * could see. `tap-*` is not the only way a floor is declared — `Button`
   * declares its own as `[@media(hover:none)]:min-w-(--tap-min)` — and the
   * host is not the only box that can clip one. Measured at 360
   * with the coarse branch live: a shrinkable `inline-flex overflow-hidden`
   * group, 50px wide, around two children the floor makes 44px each; the
   * second was drawn 5px wide and its centre answered `<main>`. A control an
   * ANCESTOR clips does not have a floor, and every hit-test in the register
   * scored it as passing, because the ancestor is what answers where the
   * child was clipped away.
   *
   * One sweep and one pin — and the shape of the guard is itself a measured
   * result. The tempting third check, "a box may not clip a floor it declares
   * on ITSELF", was written, run, and disproved: `overflow` clips a box's
   * DESCENDANTS, never its own border box, so a `min-w`/`min-h`/`size` floor
   * survives the element's own `truncate` whole, and the hit area it names is
   * still there to be hit. A 44px-tall tab trigger was the false positive that
   * showed it. Only an OVERLAY floor dies to a self-clip, because a `::before`
   * IS a descendant — and that is the rule at the top of this block, already
   * pinned. What is left is the true one: a box that clips CONTROLS must
   * declare it cannot shrink around them. Meters and bars clip and hold no
   * control, so they are not in its sights.
   * ------------------------------------------------------------------ */
  /**
   * A class list as TOKENS, and whether a token carries a variant.
   *
   * The distinction is the whole guard. `overflow-hidden` clips the element;
   * `[&>span]:truncate` clips its children and `sm:overflow-hidden` clips it
   * only above a breakpoint — a sweep that greps the attribute as one string
   * calls `SelectTrigger` a clipping box and stops being read. `:` inside
   * brackets is not a variant separator: `[@media(hover:none)]:min-w-(--tap-min)`
   * has three colons and exactly one of them divides the variant from the
   * utility.
   */
  const tokens = (attr: string): string[] =>
    attr
      .replace(/^className=\{?/, '')
      // Whitespace, quotes, commas and braces only — NOT parentheses. A
      // Tailwind v4 custom property is written `min-w-(--tap-min)` and an
      // arbitrary variant `[@media(hover:none)]:…`; splitting on `(` cuts both
      // in half, which loses the bracket depth `hasVariant` counts and turns
      // every variant-scoped utility into a bare one.
      .split(/[\s'"`,]+|[{}]/)
      .filter((t) => t.length > 0 && !/^[.…]/.test(t));
  const hasVariant = (token: string): boolean => {
    let depth = 0;
    for (const ch of token) {
      if (ch === '[' || ch === '(') depth += 1;
      else if (ch === ']' || ch === ')') depth -= 1;
      else if (ch === ':' && depth === 0) return true;
    }
    return false;
  };
  const CLIP = /^(?:truncate|overflow-hidden|overflow-x-hidden|overflow-y-hidden|overflow-clip)$/;
  /**
   * Does this token clip the element ITSELF — under any condition?
   *
   * `hasVariant` is the right filter for the general question ("is this box a
   * clipping box"), because `sm:overflow-hidden` clips only above a breakpoint
   * and `[&>span]:truncate` clips a CHILD. For a segmented control the question
   * is narrower and the answer stricter: it may not clip under ANY condition,
   * and the condition that matters most is the coarse pointer, which is exactly
   * where the floors it holds come from. So a variant is not an excuse here —
   * only a descendant selector is, since `[&>…]` names a different element.
   * (Round 3, L2: `[@media(hover:none)]:overflow-hidden` on `ButtonGroup` was a
   * live bypass of both sweeps below.)
   */
  const clipsSelf = (token: string): boolean => {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < token.length; i += 1) {
      const ch = token[i];
      if (ch === '[' || ch === '(') depth += 1;
      else if (ch === ']' || ch === ')') depth -= 1;
      else if (ch === ':' && depth === 0) {
        parts.push(token.slice(start, i));
        start = i + 1;
      }
    }
    const utility = token.slice(start);
    if (!CLIP.test(utility)) return false;
    // `[&>button]:truncate` clips the button, not this box.
    return !parts.some((v) => v.includes('&'));
  };

  it('a segmented control does not clip its segments', () => {
    // The idiom, and the only shape in this tree that wraps real controls in a
    // clip: a row-direction flex drawing a bordered, rounded box around its
    // children. Two segmented groups were written this way and both hid a
    // segment. A meter is a bordered box's opposite number — it clips, it is a
    // flex row, and it holds no control — so `border` is what separates them: a
    // meter has none, and is not in this sweep's sights.
    const offenders: string[] = [];
    for (const path of walk(SRC)) {
      if (!/\.tsx?$/.test(path)) continue;
      for (const attr of classLists(code(path))) {
        const ts = tokens(attr);
        const bare = ts.filter((t) => !hasVariant(t));
        if (!ts.some(clipsSelf)) continue;
        if (!bare.some((t) => t === 'flex' || t === 'inline-flex') || bare.includes('flex-col')) continue;
        if (!bare.some((t) => t === 'border' || /^border-\d/.test(t))) continue;
        if (!bare.some((t) => t === 'rounded' || /^rounded-/.test(t))) continue;
        offenders.push(`${rel(path)}: ${attr.slice(0, 140)}`);
      }
    }
    expect(
      offenders,
      'put the radius on the end segments instead — a clip here hides a segment rather than squeezing it',
    ).toEqual([]);
  });

  it('the segmented primitive keeps its segments whole', () => {
    // `ButtonGroup` is the kit's one segmented control — a view switch, a
    // section's filter, a toolbar's two orders.
    const button = code(join(SRC, 'ui', 'button.tsx'));
    const group = classLists(button.slice(button.indexOf('export function ButtonGroup'))).find(
      (attr) => /\binline-flex\b/.test(attr) && /\bborder-rule(?:-strong)?'/.test(attr),
    );
    expect(group, 'ui/button.tsx: the segmented root').toBeDefined();
    expect(
      tokens(group ?? '').filter(clipsSelf),
      'ui/button.tsx: a clip here hides a segment instead of squeezing it',
    ).toEqual([]);
    expect(group, 'ui/button.tsx: the group keeps the width its segments declare').toMatch(/\bshrink-0\b/);
    // The container half of the same fix: a header row that holds controls
    // gives somewhere other than a control. The page's header wraps; a section
    // heading's title gives while the controls at its end keep their width.
    expect(
      code(join(SRC, 'ui', 'page.tsx')),
      'the page header must wrap — otherwise the only give in the row is to squash a control',
    ).toMatch(/<header className="flex min-w-0 flex-wrap items-baseline justify-between/);
    const heading = code(join(SRC, 'ui', 'section-heading.tsx'));
    expect(heading, 'a section heading gives at its title').toMatch(/<Tag className="min-w-0 /);
    expect(heading, 'a section heading keeps its controls whole').toMatch(
      /\{aside != null && <div className="flex shrink-0 /,
    );
  });
});

/* -------------------------------------------------------------------- *
 * The floors this plan APPLIED, pinned as source text.
 *
 * Round 3's M1: the two segmented primitives got three pins and the other
 * half of the same remediation got none — deleting `tap-cell` from the QA
 * verdicts card left every test in the tree green, and so did reverting the
 * select-all label to a width-released floor. A fix nothing can see is a fix
 * the next refactor deletes. `tap-*` is applied in twenty-odd places and this
 * file names none of them; these two are the ones QA measured and asked for.
 * -------------------------------------------------------------------- */
describe('an applied floor stays applied', () => {
  /**
   * The `P<n>` links in Insights are the grid's row links.
   *
   * They were once the same control twice — a glyph-width mono link at the
   * head of a row in a list of ~19px rows, the only way to that phase — and
   * each was found unfloored by a different QA round, measured 14.5×18.6 and
   * winning 0 of the 4 corners of its own 44×44 floor at 360, 768 and 1024.
   * Both lists — a plan's spend per phase and its QA verdicts — are drawn on
   * the grid, where the whole row is the link and the grid floors it
   * (`ui/grid/card-list.tsx` on a phone). So the pin is that no bare `P<n>`
   * anchor comes back beside the row's own.
   */
  it('the Insights phase links are the grid rows, never a glyph-width anchor', () => {
    for (const file of ['screens/insights/plan-cost.tsx', 'screens/insights/plan-record.tsx']) {
      const text = code(join(SRC, ...file.split('/')));
      expect(text, `${file}: the rows open their phase`).toMatch(/\browHref=/);
      expect(text, `${file}: a bare P<n> anchor — 14.5px wide to a thumb`).not.toMatch(/<a\b[^>]*>\s*P\{/);
    }
  });

  /**
   * A coarse-pointer floor is released by a POINTER, never by a WIDTH.
   *
   * `sm:min-h-0` drops the floor at 640px, and a touch tablet at 768 or 1024 is
   * every bit as coarse a pointer as a phone. The correct spelling is
   * `[@media(hover:hover)]:sm:min-h-0`: a mouse keeps the compact row, a thumb
   * keeps its floor at every width. No site spells it the other way, and there
   * is no allowance to name one in: a new one goes red.
   */
  it('a thumb floor is released by a pointer, not a width', () => {
    const FLOOR = /(?:min-w|min-h|size)-\(?--tap-min/;
    // `(?<![\w:\]])` is the whole guard: it rejects the `sm:` inside
    // `[@media(hover:hover)]:sm:min-h-0`, which is the CORRECT spelling, while
    // still catching a bare `sm:`/`md:` release on the same class list.
    const WIDTH_RELEASE = /(?<![\w:\]])(?:sm|md|lg|xl):(?:min-h-0|min-w-0|size-auto)\b/;
    const found: string[] = [];
    for (const path of walk(SRC)) {
      if (!path.endsWith('.tsx') || path.includes('.test.')) continue;
      for (const attr of classLists(code(path))) {
        if (FLOOR.test(attr) && WIDTH_RELEASE.test(attr)) found.push(rel(path).replace(/\\/g, '/'));
      }
    }
    expect(
      found,
      'release a coarse floor with `[@media(hover:hover)]:` — a `sm:` release drops it for a touch tablet too',
    ).toEqual([]);
  });
});

describe('a select cannot size to its widest option', () => {
  /**
   * A `<select>` is as wide as its longest `<option>`, and the options here are
   * DATA — plan slugs, tool names, model ids. One long slug made a 423 px
   * control inside a 390 px phone and scrolled the whole app sideways.
   *
   * Scoped to the selects sized for a thumb outright (`min-h-(--tap-min)` on
   * its own): those are the settings-shaped ones, the ones filled from data.
   * A select behind `[@media(hover:none)]:min-h-(--tap-min)` with two written
   * options — `screens/plan/run/ask.tsx`'s Ask/Steer — has a longest option
   * the app itself wrote, and no bound to hold it to.
   */
  /**
   * The opening tag, from `<select` to the `>` that closes it.
   *
   * Depth-aware, because the first `>` in a JSX tag is almost never the tag's:
   * it belongs to the `=>` of an `onChange` handler, several attributes before
   * `className`. Cutting at it hides the class list, and a sweep that reads no
   * class list reports no offenders — which is what the first draft did.
   */
  const openingTag = (text: string, from: number) => {
    let depth = 0;
    for (let i = from; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) return text.slice(from, i + 1);
    }
    return text.slice(from);
  };

  it('every full-size select declares a maximum width', () => {
    const offenders: string[] = [];
    for (const path of surfaces()) {
      const text = code(path);
      for (const match of text.matchAll(/<select\b/g)) {
        const cls = /className="([^"]*)"/.exec(openingTag(text, match.index))?.[1];
        if (!cls || !/(^|\s)min-h-\(--tap-min\)/.test(cls)) continue;
        if (!/\bmax-w-/.test(cls)) offenders.push(`${rel(path)}: ${cls}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('per-page mobile fixes stay fixed', () => {
  it('the route map sizes by --app-height — never vh (the large-viewport trap) or dvh (blind to the keyboard)', () => {
    // The rule as it ships, comments stripped: a sentence ABOUT a unit is not the unit.
    const map = readFileSync(join(SRC, 'screens', 'plan', 'map', 'route-map.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      ' ',
    );
    expect(map).toMatch(
      /\.route-frame\s*\{[^}]*block-size:\s*clamp\(300px,\s*calc\(var\(--app-height\)\s*\*\s*0\.56\),\s*640px\)/,
    );
    expect(map).not.toMatch(/\d+d?vh\b/);
  });

  it('dialogs, sheets, menus and popovers never size by 100vw (it ignores the scrollbar)', () => {
    for (const name of OVERLAYS) {
      const text = readFileSync(join(SRC, name), 'utf8');
      expect(text, name).not.toMatch(/100vw/);
    }
  });

  it('the terminal scrollback is contained — a flick must not rubber-band the shell', () => {
    const css = readFileSync(join(SRC, 'screens', 'sessions', 'terminal.css'), 'utf8');
    // xterm 6: fingers land on `.xterm-scrollable-element`; `.xterm-viewport`
    // is an empty ground behind the screen, and a rule on it contains nothing.
    expect(css).toMatch(/\.xterm-scrollable-element\s*\{\s*overscroll-behavior:\s*contain/);
    expect(css).not.toMatch(/\.xterm-viewport\s*\{[^}]*(overscroll-behavior|touch-action)/);
    // Scrollbar styling likewise — the viewport no longer scrolls.
    expect(css).not.toMatch(/\.xterm-viewport::-webkit-scrollbar/);
  });

  it('the terminal key bar is a grid, never a scroller, and never a touch listener', () => {
    // Code, not prose: the file's own comment names the old scroller to explain the ban.
    const keybar = readFileSync(join(SRC, 'screens', 'sessions', 'keybar.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(keybar).not.toMatch(/overflow-x-auto/);
    expect(keybar).not.toMatch(/addEventListener\(['"]touch/);
    expect(keybar).not.toMatch(/onTouch(Start|End)=/);
    expect(keybar).toMatch(/touch-action:manipulation/);
  });

  it('nothing under src/ attaches a NON-PASSIVE touchstart (the listener that cancels a scroll it sits on)', () => {
    for (const path of walk(SRC)) {
      const text = readFileSync(path, 'utf8');
      const match = /addEventListener\(\s*['"]touchstart['"][^)]*passive:\s*false/.exec(text);
      expect(match, `${path} attaches a non-passive touchstart`).toBeNull();
    }
  });

  it('dialogs, sheets, menus and popovers size by --app-height — never dvh, which ignores the iOS keyboard', () => {
    for (const name of OVERLAYS) {
      const text = readFileSync(join(SRC, name), 'utf8');
      // Classes, not prose: a `dvh` inside an arbitrary-value bracket.
      expect(text, `${name} sizes by dvh`).not.toMatch(/\[[^\]]*\bdvh\b[^\]]*\]/);
      expect(text, name).toMatch(/--app-height/);
    }
  });

  it('toasts sit above the keyboard and above every bottom bar, never at bottom-0', () => {
    // The one tray is the kit's.
    const toast = readFileSync(join(SRC, 'ui', 'toast.tsx'), 'utf8');
    expect(toast).toMatch(/--app-height/);
    expect(toast).toMatch(/--bottom-bars/);
    expect(toast).not.toMatch(/fixed inset-x-0 bottom-0/);
    // The bars that register: the shell's tab bar and the terminal's bottom row.
    expect(readFileSync(join(SRC, 'shell', 'tab-bar.tsx'), 'utf8')).toMatch(/useBottomBar/);
    expect(readFileSync(join(SRC, 'screens', 'sessions', 'pane.tsx'), 'utf8')).toMatch(/useBottomBar/);
  });

  it('the session head gives way at its name, never past the edge', () => {
    // A session's facts in a `shrink-0` row PUSH instead of wrapping: measured
    // at 1440, one more button sent the row 122 px past the viewport, its tabs
    // at x = −25. The head is one line over the terminal, whose clock goes on a
    // phone and whose NAME is the one part that gives — down to its floor,
    // truncated — so the controls at its end stay on screen.
    const page = readFileSync(join(SRC, 'screens', 'sessions', 'session-page.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const head = /data-testid="session-head"\s+className="([^"]+)"/.exec(page);
    expect(head, 'the head must be one classed line').not.toBeNull();
    expect(head![1]).toContain('min-w-0');
    expect(page).toMatch(/<h1 className="min-w-20 truncate /);
    // The clock is the first thing a phone does without.
    expect(page).toMatch(/className="hidden shrink-0 text-meta text-ink-muted sm:inline"/);
  });

  it('the tab strip never calls scrollIntoView — it scrolls every ancestor, and live SSE renders made the run page crawl', () => {
    // Through `code()`: the file's own comment names the API to explain the ban.
    const tabs = code(join(SRC, 'ui', 'tabs.tsx'));
    expect(tabs).not.toMatch(/\.scrollIntoView\(/);
    // The once-per-change guard: an every-render effect may only scroll when
    // the ACTIVE tab actually moved.
    expect(tabs).toMatch(/lastActive/);
  });
});

/* ------------------------------------------------------------------ *
 * `shrink-0` on a variable-length row — the defect three phases found
 * ------------------------------------------------------------------ */

/**
 * The rule, stated once because it has now cost four surfaces:
 *
 * a flex row whose CONTENT can grow — an actions bar that gains a button when a
 * lane goes live, a facts line that gains an ETA phrase, a page header whose
 * `<select>` sizes to a plan slug — must be allowed to shrink and to wrap.
 * `shrink-0` on such a row makes it PUSH instead, and because the shell's one
 * scroller has `overflow-y: auto` (which computes `overflow-x` to `auto`), the
 * push becomes a horizontal scroll of the whole app.
 *
 * `flex-wrap` alone does not save it: a row that may not shrink has nothing to
 * wrap into. Measured, each caught only by the tour:
 *
 *   Phase 10  the session strip           1326 in a 1204 track (tabs at x = −25)
 *   Phase 11  the run console's actions     441 in a  390 track
 *   Phase 11  Now's plan facts line         324 in a  320 track
 *   Phase 11  `Page`'s actions row          323 in a  320 track (every page)
 */
describe('a row that can grow may shrink and wrap', () => {
  const rows: [string, string][] = [
    ['ui/page.tsx', 'flex min-w-0 flex-wrap items-center gap-2'],
    ['screens/plan/run/console.tsx', 'flex min-w-0 flex-wrap items-center justify-end gap-1.5'],
  ];

  for (const [file, cls] of rows) {
    it(`${file} keeps its actions row shrinkable`, () => {
      const text = code(join(SRC, file));
      expect(text).toContain(cls);
      expect(text, `${file} must not put shrink-0 back on that row`).not.toContain(
        cls.replace('min-w-0', 'shrink-0'),
      );
    });
  }
});

describe('text the app did not write can wrap', () => {
  it('a health issue message breaks long words', () => {
    // Issue messages quote plan text — slugs, paths, `bash -c '…'` — and a
    // token with no space in it for forty characters has nothing to wrap AT.
    // Phase 9 found this on a recorded command; Phase 11 on this list.
    const text = code(join(SRC, 'screens/insights/portfolio.tsx'));
    expect(text).toContain('min-w-0 break-words text-meta text-ink-muted');
  });
});

/* ------------------------------------------------------------------ *
 * The structural guarantees — Phase 11
 *
 * Everything above this line is a pin on a surface that once broke. The four
 * sweeps below are the same rules stated where they are DECIDED, so the next
 * surface cannot break them: the shell's axis, the control class, the motion
 * preference, and the axe roster. A pin says "this file is fixed"; these say
 * "this defect cannot be written".
 * ------------------------------------------------------------------ */

describe('the shell scrolls on ONE axis', () => {
  /**
   * The guarantee the whole no-sideways-scroll exit criterion rests on, and
   * until now the only one with nothing holding it.
   *
   * `overflow-y: auto` computes `overflow-x` to `auto` as well, so `<main>`
   * pinned `overflow-x: hidden` and an over-wide child is CLIPPED. That single
   * word is what makes every other rule here a containment failure instead of
   * an app that slides sideways: the table primitive scrolling inside its own
   * box, a row that may shrink, a `<select>` with a maximum — each of them is
   * the *nice* half of a pair whose *safe* half is this. Flip it to `auto` and
   * the app slides left again, taking the rail with it, with no scrollbar on a
   * trackpad to get back.
   */
  it('main pins overflow-x, and the full-height branch scrolls not at all', () => {
    // Through `code()`: `layout.tsx`'s own comments NAME the units and axes it
    // forbids, and a sweep that reads the prose is the incident this file's
    // header records (`dvh`, named three times in the comment banning it).
    const layout = code(join(SRC, 'shell', 'layout.tsx'));
    expect(layout).toContain('min-w-0 overflow-x-hidden overflow-y-auto overscroll-none');
    // The terminal/agent branch owns its own height and must not add a second
    // scroller of either axis.
    expect(layout).toContain('flex min-w-0 flex-col overflow-hidden');
    // And neither branch may ever scroll sideways.
    expect(layout, 'main must never scroll on x').not.toMatch(/overflow-x-(auto|scroll)/);
  });

  it('the grid that holds them clips too, and is sized by the app-height token', () => {
    // Through `code()`: `layout.tsx`'s own comments NAME the units and axes it
    // forbids, and a sweep that reads the prose is the incident this file's
    // header records (`dvh`, named three times in the comment banning it).
    const layout = code(join(SRC, 'shell', 'layout.tsx'));
    expect(layout).toMatch(/'grid h-\(--app-height\) overflow-hidden/);
  });
});

describe('a form control cannot be hand-rolled', () => {
  /**
   * `field.ts` is the one definition, and a source guard above holds the
   * literal `const field = 'h-9 …'` to exactly one file. That guard only ever
   * saw a copy that was given a NAME — and the fifth copy was not: an inline
   * `className="rounded-md border border-rule bg-surface px-2 py-1 text-2xs"`
   * on the attempt-compare `<select>`, which is invisible to a sweep looking
   * for a `const`. It shipped without the two things the shared class exists
   * to carry, in a Sheet a phone can open: no coarse-pointer thumb floor
   * (22px tall), and no `min-w-0`.
   *
   * So the rule moves from "do not copy the const" to "reach the class" —
   * which is checkable wherever a control is written.
   */
  /** Every `<select>`/`<input>` written in a page, with its class list. */
  function* controls(): Generator<{ file: string; tag: string; cls: string }> {
    for (const path of surfaces()) {
      const text = code(path);
      for (const m of text.matchAll(/<(select|input)\b/g)) {
        const tag = openTag(text, m.index);
        // Checkboxes and radios are sized by the row they sit in, not by this
        // class — and a hidden input is not a control at all.
        if (/type="(hidden|checkbox|radio)"/.test(tag)) continue;
        const cls = /className=(?:"([^"]*)"|\{([^}]*)\})/.exec(tag);
        yield { file: rel(path), tag: m[1]!, cls: cls ? (cls[1] ?? cls[2] ?? '') : '' };
      }
    }
  }

  /** The shared class, under any of the three names it is imported as. */
  const shared = (cls: string) => /\b(field|fieldSurface|fieldClass)\b/.test(cls);

  it('every select and text input reaches the thumb floor', () => {
    const offenders: string[] = [];
    for (const { file, cls } of controls()) {
      if (shared(cls)) continue;
      // Its own floor, or a min-height already well past it (a textarea-shaped
      // input at `min-h-28` is not a 44px question).
      const explicit = /min-h-\(--tap-min\)/.test(cls);
      const tall = /\bmin-h-(\d+)\b/.exec(cls);
      if (explicit || (tall && Number(tall[1]) >= 11)) continue;
      offenders.push(`${file}: ${cls || '(no className)'}`);
    }
    expect(offenders).toEqual([]);
  });

  it('every select declares a width it cannot grow past', () => {
    // A `<select>` is as wide as its longest `<option>` and the options are
    // DATA. The shared class carries `min-w-0`; anything else must say so.
    const offenders: string[] = [];
    for (const { file, tag, cls } of controls()) {
      if (tag !== 'select') continue;
      if (shared(cls)) continue;
      if (/\b(max-w-|w-full|min-w-0|flex-1)/.test(cls)) continue;
      offenders.push(`${file}: ${cls || '(no className)'}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('a table says whether it scrolls', () => {
  /**
   * `TableWrap`'s `scrolls` defaults to `true`, and that default is the SAFE
   * one — an over-wide table in a non-scrolling wrapper is clipped by `<main>`
   * with no scrollbar anywhere. But a default also means a whole destination
   * can be built without the question ever being asked, and that is what
   * happened: four Repo tables were a bare `<TableWrap>`, so on a phone each was
   * a sideways scroller where the grid would have given a card list. Not a
   * shipped bug — the primitive scrolls inside its own box, so the page never
   * moved, which is the rule working — but not the phone rendering the design
   * is aiming at either.
   *
   * So two rules, and they are separable. Every wrapper answers the SCROLL
   * question — `scrolls={overflows || !measured}` off `useTableFit` — so it is
   * a scroll container only when the table genuinely overflows, and the sticky
   * header can bind to `<main>` on the other branch; that rule is ABSOLUTE,
   * with no allowance. And every table reaches the grid, which asks the
   * question for it and gives a phone a card list, or writes down why it
   * cannot — Commit history's lane gutter is one continuous drawing across row
   * boundaries, which no folding, card-rendering primitive can preserve.
   */

  /**
   * EVERY occurrence, not "does this file have one somewhere".
   *
   * The first draft asked whether the file contained a `scrolls=` anywhere,
   * which is a file-level answer to a per-element question: a bare
   * `<TableWrap>` added beside a correctly gated one in the same file passed
   * it. Each opening tag is judged on its own.
   */
  const bareWrappers = (text: string) =>
    [...text.matchAll(/<TableWrap\b/g)]
      .map((m) => openTag(text, m.index))
      .filter((tag) => !/\sscrolls=/.test(tag)).length;

  it('every TableWrap says whether it scrolls', () => {
    const offenders: string[] = [];
    for (const path of surfaces()) {
      const bare = bareWrappers(code(path));
      if (bare > 0) offenders.push(`${rel(path)} (${bare} ungated)`);
    }
    expect(
      offenders,
      'pass scrolls={overflows || !measured} from useTableFit, or reach the grid (`ui/grid`), which asks for you',
    ).toEqual([]);
  });

  /**
   * Every table reaches the grid, or writes down why it cannot.
   *
   * The Phase 6 register measured twenty render sites in eighteen files and
   * found that NOT ONE carried a reason — so nobody could tell a table that had
   * weighed the primitive and rejected it from a table written before the
   * primitive existed. Eight of the over-wide ones turned out to be the second
   * kind.
   *
   * The reason is checked per SITE, not per file, and the marker has to be the
   * nearest one above it — a file with two tables and one reason fails, which
   * is the shape a later table added beside an explained one would take.
   *
   * `ui/table.tsx` is the primitive and `ui/grid/grid.tsx` the grid built on
   * it: their own render sites are what everything else is being asked to
   * reach.
   */
  /*
   * `[\s>/]` on BOTH branches, not `\s` on the lowercase one.
   *
   * `table\s` required whitespace after the tag name, so `<table>` and
   * `<table/>` — an attribute-less render site, the easiest one to write — were
   * invisible to the sweep while `<Table>` and `<Table/>` were caught. A guard
   * with a hole shaped like the simplest spelling of the thing it guards is a
   * guard whose green is worth nothing. `<TableWrap` still does not match: the
   * character after the name is `W`.
   */
  const RENDER_SITE = /<(?:Table|table)[\s>/]/g;
  const REASON = 'hand-rolled because:';

  /*
   * Sites are counted in CODE, reasons are looked for in the RAW text, and the
   * two have to share one coordinate space — so the comments are blanked to
   * spaces of the same length rather than deleted.
   *
   * Both halves matter, and the second only became visible when the first was
   * fixed. Sites had been counted on raw text too, which was only ever right by
   * accident: prose writes `<table>` and code writes `<table `, so widening the
   * pattern to see the bare tag immediately made four PROSE MENTIONS of
   * `<table>` — in `charts.tsx`, `route-tab.tsx`, `fleet-table.tsx` and
   * `tailscale.tsx` — count as unexplained render sites. A rule about what
   * ships may not be triggered by a sentence describing it. The reason, though,
   * IS a comment, which is why it is still read from the original.
   */
  const blankComments = (text: string) =>
    text.replace(/^[ \t]*\{?\/\*[\s\S]*?\*\/\}?|^[ \t]*\/\/.*$/gm, (m) => m.replace(/[^\n]/g, ' '));

  const unexplained = (text: string) => {
    const sites = [...blankComments(text).matchAll(RENDER_SITE)].map((m) => m.index);
    return sites.filter((at, i) => {
      // The window starts after the PREVIOUS site, so one reason cannot excuse
      // two tables however close together they sit.
      const from = i === 0 ? 0 : (sites[i - 1] ?? 0);
      return !text.slice(from, at).includes(REASON);
    }).length;
  };

  it('every table reaches the grid or says why it does not', () => {
    const offenders: string[] = [];
    for (const path of walk(SRC)) {
      if (!path.endsWith('.tsx')) continue;
      // The primitives' own definitions are not render sites: the kit's
      // `ui/table.tsx` and the grid built on it.
      if (rel(path) === 'ui/table.tsx' || rel(path) === 'ui/grid/grid.tsx') continue;
      const bare = unexplained(readFileSync(path, 'utf8'));
      if (bare > 0) offenders.push(`${rel(path)} (${bare} unexplained)`);
    }
    expect(
      offenders,
      'render through the grid (`ui/grid`), or put a `// hand-rolled because:` comment naming what the ' +
        'primitive cannot do',
    ).toEqual([]);
  });

  /**
   * A column may say how its cell ALIGNS, never that it refuses to wrap.
   *
   * `Column.cellClassName` arrived in Phase 7 for one thing — a two-line cell
   * reading level with its one-line neighbours — and the way it would be
   * misused is obvious: `whitespace-nowrap`, to stop a chip breaking. Under
   * `table-fixed` that does not widen the column, it escapes it, `useTableFit`
   * reads the table over its box and the whole thing loses its sticky header
   * for one chip. Widening the `min` is the fix; this is the ban.
   */
  it('no column declares its way out of its own track', () => {
    const offenders: string[] = [];
    for (const path of walk(SRC)) {
      if (!path.endsWith('.tsx') && !path.endsWith('.ts')) continue;
      for (const m of code(path).matchAll(/cellClassName:\s*'([^']*)'/g)) {
        if (/\b(whitespace-nowrap|w-max|min-w-\[)/.test(m[1] ?? '')) {
          offenders.push(`${rel(path)}: ${m[1]}`);
        }
      }
    }
    expect(offenders, 'widen the column’s `min` instead — see Column.cellClassName').toEqual([]);
  });

  /**
   * …and the same escape by the other route: a nowrap PRIMITIVE inside the cell.
   *
   * The ban above reads `cellClassName` string literals, which is the spelling
   * a column uses to refuse to wrap. It cannot see the commoner one: `cell:`
   * renders a status, and every member of the status family draws through
   * `DotWord`, whose root is `whitespace-nowrap` (`SeverityMark` and
   * `FactMark` carry it themselves). A chip that read
   * `phase-console-commerce · p23` in a `min: 176` column — about 240px that
   * cannot break — once passed the ban with nothing to see.
   *
   * The rule is not "no nowrap in a track", because a nowrap status is usually
   * RIGHT: a status word is a closed vocabulary of short words, and `needs-you`
   * split over two lines reads as two states. It is "a track that holds
   * ARBITRARY content lets it break" — a plan slug, a GitHub label, a path an
   * operator typed — and `max-w-full wrap-anywhere whitespace-normal` is how it is
   * spelled. A member's NOTE is part of what it holds: `RunStatus` draws the
   * wait a run is on beside its word, and a watch ref or a written reason is
   * not a vocabulary.
   *
   * Which side a column falls on cannot be read off its source, so the
   * vocabulary cells are named here WITH their vocabulary, and the assertion is
   * equality in both directions — the shape `server/`'s `.kill(` lint takes, and
   * for the same reason: a reason that cannot rot is a reason that must be
   * deleted to stop applying.
   */
  const VOCABULARY_CELLS: Readonly<Record<string, string>> = Object.freeze({
    // A member draws its word's label from the vocabulary's table in
    // `shared/status-model.js` (`WORD_ROWS`), and a word the table lacks reads
    // `Unknown`; none of the vocabularies below carries a note.
    'screens/insights/plan-record.tsx:verdict': 'the QA results (`qa-result`), by QaStatus',
    'screens/plan/run/attempts.tsx:now': 'the verification verdicts (`verification`), by OpsStatus',
    'screens/plan/run/history.tsx:status':
      'the run statuses (`run`), by RunStatus with its note off — the note wraps on its own line under it',
    'screens/plan/run/attempts.tsx:was': 'the verification verdicts (`verification`), by OpsStatus',
    'screens/plan/run/rungs.tsx:cause': 'why a rung settled (`rungCause`), by OpsStatus',
    'screens/plan/run/rungs.tsx:outcome': 'the rung outcomes (`rung`), by OpsStatus',
    'screens/plan/run/why-started.tsx:state': 'the decision states (`decision`), by OpsStatus',
    'screens/plan/source/source-tab.tsx:state':
      'the decision states (`decision`), by OpsStatus — anything else renders as breakable text',
    'screens/plans/list.tsx:plan-status': 'the plan statuses (`plan`), by PlanStatus with its note off',
    'screens/repo/issues.tsx:category': 'the issue categories (`issue-category`), by OpsStatus',
    'screens/runs/all-runs.tsx:status':
      'the run statuses (`run`), by RunStatus with its note off — the wait wraps on its own line under it',
    'screens/repo/issues.tsx:plan':
      'the issue plan states (`issue-plan`), by OpsStatus — where it is planned breaks beside it',
    'screens/repo/issues.tsx:severity': 'the issue severities (`issue-severity`), by OpsStatus',
    'screens/repo/settles.tsx:kind': 'the settle events (`settle`), by OpsStatus',
    'screens/repo/trees.tsx:role': 'the checkout roles (`checkout-role`), by OpsStatus',
    'screens/repo/trees.tsx:state':
      'the presence words (`presence`) by OpsStatus, and the written words `Prunable` and `Managed`',
    'screens/sessions/list.tsx:status':
      'a session’s phase, terminal or presence word, by SessionStatus — its summons one of two written ' +
      'phrases, `needs your permission` and `needs your answer`',
    'screens/sessions/locks.tsx:session':
      'the presence words (`presence`), by OpsStatus under the session id',
  });

  /** Every `{ … }` object literal in `text` that declares a column `id`. */
  function columnLiterals(text: string): { id: string; body: string }[] {
    const out: { id: string; body: string }[] = [];
    for (const m of text.matchAll(/\bid: '([^']+)'/g)) {
      // Back to the `{` that opens the object this `id` belongs to…
      let depth = 0;
      let open = -1;
      for (let i = m.index; i >= 0; i -= 1) {
        if (text[i] === '}') depth += 1;
        else if (text[i] === '{') {
          if (depth === 0) {
            open = i;
            break;
          }
          depth -= 1;
        }
      }
      if (open < 0) continue;
      // …and forward to the `}` that closes it.
      depth = 0;
      for (let i = open; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            out.push({ id: m[1] as string, body: text.slice(open, i + 1) });
            break;
          }
        }
      }
    }
    return out;
  }

  /**
   * The opening tag that starts at `<` — `{ … }` aware, so a `>` inside a JSX
   * expression does not end it early.
   */
  function openingTagAt(text: string, i: number): string {
    let depth = 0;
    for (let k = i; k < text.length; k += 1) {
      const ch = text[k];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) return text.slice(i, k + 1);
    }
    return text.slice(i);
  }

  it('a nowrap primitive inside a declared track either breaks or is a closed vocabulary', () => {
    // Two ways to be a nowrap primitive: BE one of the components, or carry the
    // utility by hand. Round 2's L3 — a raw `<span className="whitespace-nowrap">`
    // in a `cell:` was invisible to a check that only knew the component names.
    // The components are the status family (`@/ui/status`): `DotWord`, every
    // member that draws through it, and the two marks that set the utility
    // themselves.
    const NOWRAP_COMPONENT =
      /^<(?:DotWord|RunStatus|PhaseStatus|PlanStatus|QaStatus|OpsStatus|SessionStatus|AccountStatus|McpStatus|SeverityMark|FactMark|AttentionMark)\b/;
    const NOWRAP_CLASS = /\bwhitespace-nowrap\b/;
    // `wrap-anywhere` is Tailwind's `overflow-wrap: anywhere` — a long token
    // breaks inside itself, as under `break-all`.
    const BREAKS = /\b(whitespace-normal|break-all|break-words|wrap-anywhere)\b/;
    // Scoped to the tag that carries the primitive, not the whole column literal
    // — the other half of L3. A `break-all` on an unrelated child used to exempt
    // every nowrap thing in the same cell.
    const unbroken = (body: string): boolean => {
      for (let i = body.indexOf('<'); i !== -1; i = body.indexOf('<', i + 1)) {
        if (!/[A-Za-z]/.test(body[i + 1] ?? '')) continue;
        const tag = openingTagAt(body, i);
        if (!NOWRAP_COMPONENT.test(tag) && !NOWRAP_CLASS.test(tag)) continue;
        if (!BREAKS.test(tag)) return true;
      }
      return false;
    };
    const found: string[] = [];
    for (const path of walk(SRC)) {
      if (!path.endsWith('.tsx')) continue;
      for (const { id, body } of columnLiterals(code(path))) {
        if (!/\bcell:/.test(body)) continue;
        if (!/\bmin:\s*\d/.test(body) && !/\bwidth:/.test(body)) continue;
        if (!unbroken(body)) continue;
        found.push(`${rel(path)}:${id}`);
      }
    }
    expect(
      found.sort(),
      'let it break (`max-w-full wrap-anywhere whitespace-normal`), or name the closed vocabulary in VOCABULARY_CELLS',
    ).toEqual(Object.keys(VOCABULARY_CELLS).sort());
  });

  /**
   * The arithmetic fixes of Phase 7, pinned as the numbers they are.
   *
   * Each was a track narrower than the content it held, and each cost far more
   * than its own size: 13px took the issues board's sticky header, 4px took the
   * run phase table's, and a flex column with no floor at all resolved to zero
   * and let the fleet table paint two cells on top of each other. A `min` is
   * only true against real content, so the numbers are worth holding still.
   */
  it('the tracks that were measured stay measured', () => {
    const issues = code(join(SRC, 'screens/repo/issues.tsx'));
    // The desk's three vocabulary cells are a dot and a word that never wraps
    // (`DotWord` is nowrap): each track holds its widest word — `No severity`,
    // `Needs a plan`, `Documentation` — and the cell's `--tile-pad-x` twice.
    expect(issues).toMatch(/id: 'severity',[\s\S]{0,200}?min: 128,/);
    expect(issues).toMatch(/id: 'plan',[\s\S]{0,200}?min: 168,/);
    expect(issues).toMatch(/id: 'category',[\s\S]{0,200}?min: 144,/);

    const phase = code(join(SRC, 'screens/plan/phases/table.tsx'));
    // The widest single remedy — `Pick up with a new agent` with its mechanism
    // badge — measures 249px, and the group around it already wraps, which does
    // nothing when one ITEM is wider than the cell.
    expect(phase).toMatch(/id: 'actions',[^}]*min: 252/);
    // The cut and the layout read ONE number — the kit grid's, since the 7.0
    // phase grid moved onto `ui/grid` (quiet-console phase 10).
    expect(phase).toMatch(/<Grid\b/);
    expect(code(join(SRC, 'ui/grid/grid.tsx'))).toMatch(/width: column\.width \?\? trackOf\(column\)/);
  });

  /**
   * The departures board reads `measured`, like every other gated table.
   *
   * It was the one that did not, and the two questions are different: before
   * the first measurement `overflows` is false, so the wrapper did not scroll
   * while the table already carried its `min-w` floor — an over-wide table
   * inside a box that clips, with no scrollbar anywhere to reach the columns
   * past the edge. Unmeasured is not "it fits".
   */
  it('the departures board waits to be measured', () => {
    // The departures board IS the phase table since control-tower phase 23,
    // and it waits through the grid: the wrapper scrolls until the box has
    // answered, and a window of rows is drawn against `<main>`.
    const grid = code(join(SRC, 'ui/grid/grid.tsx'));
    expect(grid).toMatch(/const \{ wrapRef, tableRef, width, overflows, measured \} = useTableFit\(\)/);
    expect(grid).toMatch(/scrolls=\{overflows \|\| !measured\}/);
    const table = code(join(SRC, 'screens/plan/phases/table.tsx'));
    expect(table).toMatch(/virtualFrom=\{PHASE_VIRTUAL_FROM\}/);
    expect(code(join(SRC, 'screens/plan/phases/model.ts'))).toMatch(/export const PHASE_VIRTUAL_FROM = 40;/);
  });

  /**
   * The identity is never the thing that gives way.
   *
   * One cause under five register rows: a `min-w-0` name beside a `shrink-0`
   * badge, chip cluster or timestamp. `min-w-0` does not mean "shrink me last",
   * it means "shrink me to nothing", and next to something that cannot shrink
   * at all that is exactly what happened — a plan card whose name kept 113px so
   * that two chips could stay whole, a phases-tab row whose title kept 33px
   * (`Se…` for `Setup`) beside four, an inbox row whose errand read `A session
   * i…` beside a whole timestamp. The floor is the name saying what it is
   * worth, which is the same thing a column's `min` says.
   */
  it('a record’s name declares a floor', () => {
    const pins: [string, RegExp][] = [
      ['cards/inbox-row.tsx', /className="min-w-48 flex-1 truncate font-medium/],
      // A list's name is a grid column, whose `min` the kit's `Column` type
      // requires; the open session's head and the run console's keep their own.
      ['screens/sessions/session-page.tsx', /className="min-w-20 truncate text-body font-semibold text-ink"/],
      ['screens/plan/run/console.tsx', /className="min-w-24 truncate text-body font-semibold text-ink"/],
    ];
    for (const [file, pattern] of pins) {
      expect(code(join(SRC, file)), `${file} lost its identity floor`).toMatch(pattern);
    }
    // The phase table's name column is the one that absorbs the rest, and it
    // has a floor of its own.
    expect(code(join(SRC, 'screens/plan/phases/table.tsx'))).toMatch(
      /id: 'phase',\s*head: 'Phase',\s*priority: 1,\s*min: 260,\s*flex: true,/,
    );
  });

  /**
   * A prose table is contained by an element, not by a chain of assumptions.
   *
   * `.md table` asked to scroll itself with `max-width: 100%`, which resolves
   * against the containing block — and the guide's cards are `<details>` with
   * `overflow-hidden` inside a column flex inside a portal, where it resolved
   * wider than the card. Measured 275px in a 266px sheet, clipped, with no
   * scrollbar to reach the cut column. A wrapper div needs none of that
   * reasoning: it is as wide as its box, whatever produced the box.
   */
  it('every prose table gets a real wrapper', () => {
    const markdown = code(join(SRC, 'ui', 'markdown.tsx'));
    expect(markdown).toMatch(/function wrapTables/);
    expect(markdown).toMatch(/if \(!inline\) wrapTables\(template\.content\)/);
    const prose = readFileSync(join(here, 'prose.css'), 'utf8');
    expect(prose).toMatch(/\.md-tablewrap \{[^}]*overflow-x: auto/);
    // And it may never become a second VERTICAL scroller — the ban `table.tsx`
    // states for `TableWrap`, which is why the height cap is absent here.
    expect(prose).not.toMatch(/\.md-tablewrap \{[^}]*max-height/);
  });

  /**
   * The transcript's phone grid has one track per child.
   *
   * It declared three for four: the clock was added to `.live-line` later and
   * nothing brought the phone rule with it, so grid laid the eight-character
   * time into the 46px track meant for the kind label and `white-space: nowrap`
   * carried it straight over the words beside it.
   */
  it('a transcript line has four columns at every width', () => {
    const css = readFileSync(join(SRC, 'styles/console.css'), 'utf8');
    const tracks = [...css.matchAll(/grid-template-columns:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(tracks.length).toBeGreaterThan(0);
    for (const track of tracks) {
      expect(track.split(/\s+(?![^()]*\))/).length, `"${track}" is not four tracks`).toBe(4);
    }
  });
});

describe('the newest destinations keep their phone fixes', () => {
  /*
   * Repo and Debug shipped after most of the sweeps above were written, and
   * each re-grew a defect those sweeps pin only by NAME on an older surface.
   * Pinned here the same way, beside the class each belongs to.
   */
  it("Logs' health list breaks a path the way Insights' does", () => {
    // `issue.detail` is `PATH entry does not exist: /very/long/…` — one token,
    // beside a nowrap status that will not give. The identical list in
    // Insights (`screens/insights/portfolio.tsx`) was fixed for this in Phase 9.
    // Through `code()` — every pin in this file must be, and these two were the
    // last that were not: each fix is EXPLAINED in a comment on the line above
    // it, so a raw read is satisfied by the prose that describes the class
    // rather than by the class. Deleting the break rule from the log row left the
    // suite green for exactly that reason.
    const text = code(join(SRC, 'screens/logs/health-section.tsx'));
    expect(text).toContain('min-w-0 text-body break-words text-ink');
    expect(text).toContain('flex min-w-0 flex-wrap items-baseline gap-x-2');
  });

  it("Logs' log line wraps, breaks its event name, and can be tapped", () => {
    const text = code(join(SRC, 'screens/logs/logs-section.tsx'));
    // ~261px of fixed columns left ~59px for the message on a 360px phone, so
    // below 640 the message takes a line of its own under the clock, the level
    // and the source, and the four columns are a desk's.
    expect(text).toContain('grid grid-cols-[auto_auto_minmax(0,1fr)]');
    expect(text).toContain('col-span-full min-w-0 sm:col-span-1');
    // A dotted event name (`runner.phase.verify.failed`) had no break rule.
    expect(text).toContain('wrap-anywhere');
    // The line is the only way into the row's panel: the kit Button carries the
    // coarse-pointer floor, and the line lets it grow rather than clip.
    expect(text).toMatch(/<Button\s+variant="ghost"\s+onClick=\{\(\) => inspectEntry/);
    expect(text).toContain('h-auto w-full shrink');
  });

  it("Repo's patch pane scrolls sideways only, at every width", () => {
    /*
     * 6.2 capped the patch pane and the file list at 32rem behind `lg:` and
     * gave each a scroller of its own on a desk. 7.0's Changes is one column
     * (quiet-console phase 17): a file opens IN PLACE under its own line, and
     * its patch scrolls sideways and never down, so the page stays the one
     * vertical scroller at every width. Per CLASS LIST, as before: a cap or a
     * vertical scroller anywhere in the section's two files is a nested
     * scroller on a phone.
     */
    for (const file of ['screens/repo/diff.tsx', 'screens/repo/diff-view.tsx']) {
      for (const cls of classLists(code(join(SRC, ...file.split('/'))))) {
        expect(cls, `${file}: a height cap nests a scroller: ${cls}`).not.toMatch(/(^|[\s:])max-h-/);
        expect(cls, `${file}: a vertical scroller inside the page: ${cls}`).not.toMatch(
          /(^|[\s:])overflow-y-/,
        );
      }
    }
    const pane = classLists(code(join(SRC, 'screens', 'repo', 'diff.tsx'))).filter((cls) =>
      cls.includes('overflow-x-auto'),
    );
    expect(pane, 'the patch pane is the one sideways scroller').toHaveLength(1);
    expect(pane[0]).toMatch(/\bmin-w-0\b/);
    expect(pane[0]).toMatch(/\boverscroll-x-contain\b/);
  });

  it('every row that is the only way into a record can be tapped', () => {
    // A changed file's line is the only way to its patch — Changes' expand
    // button and the review's list row — and each keeps a thumb's floor that
    // a POINTER releases, never a width. The branch and tree rows are grid
    // rows since 7.0 (quiet-console phase 17), whose link is the grid's.
    for (const file of ['screens/repo/diff.tsx', 'screens/repo/diff-view.tsx']) {
      const text = code(join(SRC, ...file.split('/')));
      expect(text, `${file} lost its tap floor`).toMatch(/'flex min-h-\(--tap-min\) w-full/);
      expect(text, `${file} releases its floor by a pointer`).toMatch(/\[@media\(hover:hover\)\]:min-h-/);
      expect(text, `${file} releases its floor by a width`).not.toMatch(/(?<![\w:\]])sm:min-h-0/);
    }
  });

  it('the issues desk’s per-row control survives the CARD rendering', () => {
    /*
     * The grid renders a card list below the shell breakpoint, and a card
     * does not draw a column marked `card: 'none'`. The 6.x board's pick
     * column was once hidden that way, so a phone had one selection control —
     * "select every issue shown" — and no way to choose *these three*, which is
     * the verb the whole surface exists for. The board still looked right in a
     * screenshot. (Phase 16 QA round 1, High.)
     *
     * Asserted on the COLUMN, not the file. The behavioural pin lives in
     * `screens/repo/issues-phone.test.tsx`, which mounts the phone rendering
     * and picks one row; this is the source-level companion, here because
     * "a control the phone cannot reach" is this file's subject.
     */
    const text = code(join(SRC, 'screens/repo/issues.tsx'));
    const pick = text.slice(text.indexOf("id: 'pick'"), text.indexOf("id: 'number'"));
    expect(pick, 'the pick column has moved or gone').toContain('cell:');
    expect(pick, 'a pick column a card does not draw is a phone that cannot pick one issue').not.toMatch(
      /card:\s*'(?:none|hide)'/,
    );
    expect(pick).toMatch(/card:\s*'action'/);
  });

  it('the commit row reaches 44px WITHOUT growing past the lane gutter', () => {
    /*
     * The one row where the tap floor and the layout can contradict each other,
     * so the rule is a PAIR and both halves are asserted.
     *
     * `LaneCell` draws an SVG of exactly `ROW_H` and the row IS that height by
     * construction — which is what makes the lane lines join across row
     * boundaries, the thing `graph.tsx`'s header calls "a non-problem". A
     * `min-h-(--tap-min)` on the subject button against the cell's default
     * `py-(--tile-pad-y)` adds that padding ON TOP of 44: the row grows to 64px
     * (56 compact), the SVG does not, `align-middle` centres it, and every
     * boundary gets a gap in the line.
     *
     * Removing the CELL's padding is what makes the two agree — then the
     * button's floor resolves to exactly `ROW_H`, the row does not move, and
     * the target is the full 44. An earlier fix grew the hit area with negative
     * margin instead and left it at 40px (32 compact), which is a smaller
     * miss than the original but still a miss.
     *
     * Asserted on the CELL, not the file: banning `min-h-(--tap-min)` file-wide
     * (the first attempt) forbids the fix and contradicts the thumb-floor sweep
     * above — a legitimate `<select>` added to this file could satisfy neither.
     *
     * 7.0 (quiet-console phase 17) keeps the pair, on real `<tr>` rows: the
     * subject is the row's link (`data-row-link`), and the gutter cell's end
     * padding is the logical `pe-0`, so a right-to-left page keeps it too.
     */
    const text = code(join(SRC, 'screens', 'repo', 'graph.tsx'));
    // Each commit is a real table row, never a positioned box on a canvas.
    expect(text).toMatch(/<TR\s+data-testid="commit-row"/);
    // The subject cell drops its vertical padding …
    expect(text, 'the subject cell must not add padding to a fixed-height row').toMatch(
      /<TD className="min-w-0 py-0 align-middle">/,
    );
    // … and the link it holds takes the floor.
    expect(text).toMatch(/className="flex min-h-\(--tap-min\) w-full min-w-0 items-center/);
    // The lane cell keeps the height the whole arrangement is pinned to, and
    // the SVG and the row still agree on one number. Its width is no longer
    // `w-px` — under the `fixed` layout Phase 7 gave this table, `w-px` would
    // be a literal one-pixel track with the SVG hanging out of it, so the cell
    // declares the gutter's real width instead.
    expect(text).toMatch(
      /<TD className="py-0 pe-0 align-middle" style=\{\{ height: ROW_H, width: gutterTrack\(lanes\) \}\}>/,
    );
    expect(text).toMatch(
      /export const gutterTrack = \(lanes: number\): string => `calc\(\$\{lanes \* LANE_W\}px \+ var\(--tile-pad-x\)\)`/,
    );
    expect(text).toMatch(/export const ROW_H = 44;/);
    expect(text).toMatch(/<svg width=\{w\} height=\{ROW_H\}/);
  });

  it('the lane gutter is a drawing a screen reader skips, and never wider than 128px', () => {
    /*
     * Every fact the gutter draws is in the row beside it, so the drawing is
     * `aria-hidden`; and past eight lanes it would outgrow the subject it sits
     * beside, so the lanes past the cut are counted in words instead of drawn
     * (quiet-console phase 17, exit criterion 2).
     */
    const text = code(join(SRC, 'screens', 'repo', 'graph.tsx'));
    expect(text).toMatch(/export const LANE_W = 16;/);
    expect(text).toMatch(/export const LANE_CAP = 8;/);
    expect(text).toMatch(/export const GUTTER_MAX = LANE_W \* LANE_CAP;/);
    // The drawn lanes are capped where the rows are made …
    expect(text).toMatch(/lanes: Math\.min\(packed\.laneCount, LANE_CAP\)/);
    // … and the drawing itself is hidden from the accessibility tree.
    expect(text).toMatch(
      /<svg width=\{w\} height=\{ROW_H\} viewBox=\{`0 0 \$\{w\} \$\{ROW_H\}`\} aria-hidden="true"/,
    );
  });
});

describe('focus stays visible on every page surface', () => {
  /**
   * `theme.css` paints one ring globally — `:focus-visible { outline: 2px }` —
   * and `focus-visible` is the right selector: it fires for a keyboard and not
   * for a mouse, so nothing has to trade one for the other.
   *
   * No surface may simply suppress it, the kit included: one that drops it
   * with `outline-none` restores it for the keyboard with an explicit
   * `focus-visible:` indicator. A settings page once had `focus:outline-none`
   * beside a `focus:border-action`, which reads as a swap and is not one:
   * `focus:` fires for both input modes, so the ring was gone for the keyboard
   * too and a 1px hue change was the whole indicator — on the input that
   * chooses which repository the console opens.
   */
  it('no surface suppresses the ring', () => {
    const offenders: string[] = [];
    for (const path of surfaces()) {
      const text = code(path);
      for (const [attr] of text.matchAll(/className=(?:"[^"]*"|\{`[^`]*`\}|\{[^}]*\})/g)) {
        if (!/\boutline-none\b/.test(attr)) continue;
        // The legitimate form: suppressed for the pointer, restored for the
        // keyboard by an explicit `focus-visible:` indicator that PAINTS.
        // Either property counts — a pane or a roving-focus list may draw a
        // `ring` rather than an `outline`, the same promise kept with the other
        // of the two that can keep it. But the
        // suffix has to be checked: `focus-visible:outline-none`,
        // `focus-visible:outline-hidden` and `focus-visible:ring-0` all match
        // "has a focus-visible outline/ring" while removing the indicator
        // entirely, which is the exact defect this sweep is for.
        if (/focus-visible:(outline|ring)-(none|hidden|0)\b/.test(attr)) {
          offenders.push(rel(path));
          continue;
        }
        if (/focus-visible:(outline|ring)\b/.test(attr)) continue;
        offenders.push(rel(path));
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('the global ring is still declared, and by focus-visible', () => {
    expect(theme).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--focus\)/);
  });
});

describe('the motion preference reaches the scrolls the app animates itself', () => {
  /**
   * `theme.css` carries the blanket `prefers-reduced-motion` rule, and it
   * covers every animation, transition and CSS `scroll-behavior` in the app.
   * It cannot cover a scroll performed in JS: CSSOM-View says an explicit
   * `behavior` argument OVERRIDES the computed property, so
   * `pane.scrollTo({ behavior: 'smooth' })` in the help sheet's section panel
   * (`shell/help/section.tsx`) glided for a reader who had asked the whole
   * system to stop moving.
   *
   * `lib/scroll.ts` — the app's own helper, and the reason `scrollIntoView` is
   * banned — never had the bug: it assigns `scrollTop`, which is instant. The
   * rule is that the OTHER way of scrolling must ask.
   */
  it('no surface hard-codes a smooth scroll', () => {
    const offenders: string[] = [];
    for (const path of walk(SRC)) {
      if (!/\.tsx?$/.test(path)) continue;
      const text = code(path);
      if (/behavior:\s*['"]smooth['"]/.test(text)) offenders.push(rel(path));
    }
    expect(offenders, 'pass scrollBehavior() from lib/media.ts instead — it answers the media query').toEqual(
      [],
    );
  });

  it('lib/media.ts is where the question is asked, beside the other three', () => {
    const media = readFileSync(join(SRC, 'lib', 'media.ts'), 'utf8');
    expect(media).toMatch(/prefers-reduced-motion: reduce/);
    expect(media).toMatch(/export const scrollBehavior/);
    // `auto` is the CSSOM word for "jump" — the fallback must not be `smooth`.
    expect(media).toMatch(/reducedMotion\(\) \? 'auto' : 'smooth'/);
  });

  it('the stylesheet still carries the blanket rule the JS path complements', () => {
    expect(theme).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(theme).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(theme).toMatch(/scroll-behavior:\s*auto\s*!important/);
  });
});

describe('every Settings section is reachable by thumb', () => {
  it('the nav links carry the tap minimum', () => {
    // The whole section list is links, and a link is the only way into a
    // section — a 28 px row here is a page a phone cannot open. Since 7.0 the
    // list is the place's index (quiet-console phase 21), and each row is two
    // lines: the floor is a min-height alone, never `tap-row`, whose
    // `align-items: center` would centre a column's lines on a phone.
    const text = readFileSync(join(SRC, 'screens/settings/nav.tsx'), 'utf8');
    expect(text).toContain('[@media(hover:none)]:min-h-(--tap-min)');
    expect(text).not.toMatch(/\btap-row\b[^"]*\bflex-col\b/);
  });

  it('the plan scope cannot size to its widest option', () => {
    // A `<select>` sizes to its WIDEST option, and every option here is a plan
    // slug. Unbounded, one long slug made a 423 px control inside a 390 px
    // phone and scrolled the whole page sideways (Phase 6's trap). 7.0's scope
    // is the kit's combobox, whose trigger truncates its words, bounded on the
    // desk's bar and as wide as the View sheet on a phone (quiet-console phase 19).
    const text = code(join(SRC, 'screens/insights/index.tsx'));
    expect(text).not.toMatch(/<select\b/);
    expect(text).toContain('<Combobox');
    expect(text).toMatch(/inline: scope\('w-\d+ max-w-full'\)/);
  });
});

/*
 * The Run view (quiet-console phase 11; the run page since control-tower phase
 * 24): it opens on a glance and folds everything else under a named row, so
 * the fold's row is the thing a thumb presses most there. The e2e spec
 * (`e2e/run-page.spec.ts`) hit-tests each one at 360; these pins keep the
 * classes that make it win.
 */
describe('the Run view’s folds and header keep their thumb', () => {
  it('screens/plan/run/index.tsx: each fold is a full-width row with the tap floor on touch, in one shrinkable column', () => {
    const text = readFileSync(join(SRC, 'screens/plan/run/index.tsx'), 'utf8');
    expect(text).toContain('flex min-w-0 flex-col border-t border-rule pt-2');
    expect(text).toContain('h-auto min-h-9 w-full min-w-0 justify-start gap-2');
    expect(text).toContain('[@media(hover:none)]:min-h-(--tap-min)');
    // The name truncates inside the row rather than pushing the count out of it.
    expect(text).toContain('<span className="min-w-0 truncate">{words.name}</span>');
  });

  it('screens/plan/run/glance.tsx: the header is the run row’s header variant', () => {
    expect(readFileSync(join(SRC, 'screens/plan/run/glance.tsx'), 'utf8')).toContain('variant="header"');
  });

  it('screens/runs/run-row.tsx: the header variant keeps the name’s floor and draws no second way in', () => {
    const text = readFileSync(join(SRC, 'screens/runs/run-row.tsx'), 'utf8');
    expect(text.match(/min-w-\(--strip-name-floor\) truncate/g)?.length).toBe(2);
    // Heading its own page, the name is words, never a link back to that page.
    expect(text).toMatch(/\{header \? \(\s*<span\s+data-testid="strip-name"/);
  });
});
