/**
 * The figures' type: never under the floor, and never without its room
 * (design.md §2 and §8.2; quiet-console phase 27).
 *
 * An SVG reads no type scale of its own — the size a drawing writes is the
 * size a reader gets — and 9 px axis labels and 8 px glyphs shipped for two
 * releases because only a person reading a picture could see them. So this
 * reads the folder's own source: every `fontSize`, as a JSX attribute or an
 * object key, is `FIGURE_TYPE` or a literal at or over the 12 px floor, and
 * `FIGURE_TYPE` is the meta size the theme declares. The bands the labels are
 * written in are cut from that one size (`./paint`), which the second half
 * holds: change the size and the room changes with it.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  AXIS_PAINT,
  FIGURE_ASCENT,
  FIGURE_BAND,
  FIGURE_CAP,
  FIGURE_DESCENT,
  FIGURE_TYPE,
  inside,
  textWidth,
} from './paint';
import { AXIS, BAR, ROW } from './swimlane';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Design law's floor for anything a person reads (design.md §2). */
const FLOOR = 12;

/** The one name a drawing may set its type by instead of a literal. */
const NAMED = new Set(['FIGURE_TYPE']);

/** Comments stripped: a sentence about a 9 px label is not one. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * Every type size a source sets, as written: `fontSize={9}`, `fontSize="8"`,
 * `fontSize: 9`, `font-size: 9px`, `fontSize={FIGURE_TYPE}` — and a
 * Tailwind arbitrary size, `text-[9px]`.
 */
function sizes(source: string): string[] {
  const text = code(source);
  const found = [...text.matchAll(/\bfont(?:Size|-size)\s*[=:]\s*\{?\s*(['"`]?)([^'"`}\s,;)]+)\1/g)].map(
    (match) => match[2],
  );
  for (const match of text.matchAll(/\btext-\[(\d*\.?\d+)px\]/g)) found.push(`${match[1]}px`);
  return found;
}

/** Why a size is refused, or null when it is the figures' type or at the floor. */
function refusal(size: string): string | null {
  if (NAMED.has(size)) return null;
  const px = /^(\d*\.?\d+)(px)?$/.exec(size);
  if (!px) return `${size}: not a size this guard can read — set it with FIGURE_TYPE`;
  return Number(px[1]) < FLOOR ? `${size}: under the ${FLOOR} px floor` : null;
}

/** The folder's sources, tests aside. */
const SOURCES = readdirSync(here('.')).filter((name) => /\.tsx?$/.test(name) && !/\.test\./.test(name));

describe('no type in a figure is under the floor', () => {
  it('reads every size the drawings set, and refuses none', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const name of SOURCES) {
      for (const size of sizes(readFileSync(here(`./${name}`), 'utf8'))) {
        seen += 1;
        const why = refusal(size);
        if (why) offenders.push(`${name}: ${why}`);
      }
    }
    expect(offenders).toEqual([]);
    // The axis paint, the tick labels and both kinds of glyph: a guard that
    // read nothing would pass this folder by reading nothing.
    expect(seen).toBeGreaterThanOrEqual(4);
  });

  it('is shown its own negative: each spelling of a small size is caught, and the floor and the name pass', () => {
    const bad = [
      '<text fontSize="9">',
      '<text fontSize={8}>',
      '<text fontSize={ 11.5 }>',
      "tickLabelProps: { fill: 'var(--ink-faint)', fontSize: 9, fontFamily: 'inherit' }",
      "{ fontSize: '10px' }",
      '<text style="font-size: 9px">',
      '<text className="text-[10px]">',
      '<text fontSize={size}>',
    ];
    for (const source of bad) {
      const found = sizes(source);
      expect(found, source).toHaveLength(1);
      expect(refusal(found[0]!), source).not.toBeNull();
    }
    for (const source of ['<text fontSize={FIGURE_TYPE}>', '<text fontSize="12">', '{ fontSize: 12.5 }']) {
      const found = sizes(source);
      expect(found, source).toHaveLength(1);
      expect(refusal(found[0]!), source).toBeNull();
    }
    // A comment that NAMES the old size is not a size.
    expect(sizes('// the axes were set at fontSize: 9\n/* fontSize="8" */')).toEqual([]);
  });

  it('sets the figures’ type at the meta size the theme declares, over the floor', () => {
    const theme = readFileSync(here('../../styles/theme.css'), 'utf8');
    const meta = /--text-meta:\s*(\d*\.?\d+)rem/.exec(theme);
    expect(meta, '--text-meta in rem').not.toBeNull();
    expect(FIGURE_TYPE).toBe(Number(meta![1]) * 16);
    expect(FIGURE_TYPE).toBeGreaterThanOrEqual(FLOOR);
    expect(AXIS_PAINT.tickLabelProps.fontSize).toBe(FIGURE_TYPE);
  });
});

describe('the room a label is given is cut from its size', () => {
  it('a band holds a line: the tallest letter over the baseline and a descender under it', () => {
    expect([FIGURE_CAP, FIGURE_ASCENT, FIGURE_DESCENT, FIGURE_BAND]).toEqual([9, 10, 4, 16]);
    expect(FIGURE_CAP).toBeGreaterThanOrEqual(FIGURE_TYPE * 0.72);
    expect(FIGURE_ASCENT).toBeGreaterThanOrEqual(FIGURE_TYPE * 0.75);
    expect(FIGURE_DESCENT).toBeGreaterThanOrEqual(FIGURE_TYPE * 0.25);
    expect(FIGURE_BAND).toBeGreaterThan(FIGURE_ASCENT + FIGURE_DESCENT);
    // The swimlane's tick band is one such band, and a row is two lines: the
    // bar's, and the one a moment's glyph hangs into under the bar's edge.
    expect(AXIS).toBe(FIGURE_BAND);
    expect(ROW).toBeGreaterThanOrEqual(2 * (FIGURE_ASCENT + FIGURE_DESCENT));
    expect(BAR).toBe(ROW / 2);
  });

  it('never estimates a label narrower than Instrument Sans draws it', () => {
    // The font file's own advances, per em, for every character the figures
    // write (`tnum`: every numeral is 0.6). An estimate under any of these lets
    // two labels touch; over them costs a few pixels of air.
    const ADVANCE: Record<string, number> = Object.fromEntries(
      [
        'A .728  D .752  F .602  J .455  M .906  N .736  O .786  S .608  W 1.089',
        'a .533  b .606  c .533  d .606  e .564  g .606  h .599  l .24  m .922  n .599',
        'o .584  p .606  r .375  s .473  t .377  u .589  v .523  y .523  $ .608  . .255',
      ]
        .flatMap((line) => [...line.matchAll(/(\S) (\d*\.\d+)/g)])
        .map(([, ch, em]) => [ch, Number(em)]),
    );
    for (const numeral of '0123456789') ADVANCE[numeral] = 0.6;
    ADVANCE[' '] = 0.2;
    const drawn = (text: string) => [...text].reduce((sum, ch) => sum + ADVANCE[ch]! * FIGURE_TYPE, 0);
    const labels = [
      ...['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
      'W38',
      '$20',
      '$0.25',
      '0s',
      '45s',
      '10m 30s',
      '1h 30m',
      '12h 30m',
      '168h',
    ];
    for (const label of labels) {
      for (const ch of label) expect(ADVANCE[ch], `the advance of ${JSON.stringify(ch)}`).toBeDefined();
      expect(textWidth(label), label).toBeGreaterThanOrEqual(drawn(label));
      // …and never wildly over — an em at most — or labels thin for nothing.
      expect(textWidth(label), label).toBeLessThanOrEqual(drawn(label) + FIGURE_TYPE);
    }
  });

  it('holds a label inside the drawing: centred while it fits, flush with the edge it would cross', () => {
    expect(inside(100, 30, 320)).toEqual({ textAnchor: 'middle', dx: 0 });
    // The current week's label at the far edge ends a pixel inside it…
    expect(inside(315, 30, 320)).toEqual({ textAnchor: 'end', dx: 4 });
    // …and a mark at the axis's first moment starts a pixel inside the near one.
    expect(inside(0, FIGURE_TYPE, 320)).toEqual({ textAnchor: 'start', dx: 1 });
  });
});
