/**
 * Where a figure's words land, as boxes — and whether two of them meet (#375).
 *
 * The owner measured it on 7.1.0: the map drew a batch's caption over its wave
 * heading and ran track through station names, and the run timeline drew four
 * marks on one spot that read as one. Every one of those is a box laid over
 * another box, so this file is the one vocabulary for that question:
 *
 *   - `textBox` — the box one line of SVG text covers, from the numbers the
 *     drawing hands the `<text>` element: its anchor point, its anchor, its
 *     `dx`, its size. The width is the figures' own estimate (`textWidth`),
 *     which errs wide, so a box that clears here clears on a screen.
 *   - `meets` — two boxes overlap (a shared edge is not an overlap).
 *   - `segmentBox` — an axis-parallel stroke as the box it paints.
 *   - `clusterMarks` — moments on one line whose glyphs would cover each other,
 *     folded into one counted mark (`✎×4`) whose title lists them all, so a
 *     hover reads every one and none hides another.
 *
 * Pure and dependency-free past `./paint`, so the map's layout pass, the
 * swimlane and `collide.test.tsx` all measure with the same ruler.
 */

import { FIGURE_TYPE, textWidth } from './paint';

/** A rectangle in the drawing's own units. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type TextAnchor = 'start' | 'middle' | 'end';

/** How far a line of type reaches above its baseline, and below it, in ems. */
export const ASCENT_EM = 0.8;
export const DESCENT_EM = 0.25;

/**
 * The box one line of text covers, drawn at `(x, y)` — `y` its baseline — with
 * SVG's anchor and `dx`. `size` is the type size in the drawing's units.
 */
export function textBox({
  x,
  y,
  text,
  anchor = 'start',
  dx = 0,
  size = FIGURE_TYPE,
}: {
  x: number;
  y: number;
  text: string;
  anchor?: TextAnchor;
  dx?: number;
  size?: number;
}): Rect {
  const width = textWidth(text) * (size / FIGURE_TYPE);
  const at = x + dx;
  const x0 = anchor === 'middle' ? at - width / 2 : anchor === 'end' ? at - width : at;
  return { x0, y0: y - size * ASCENT_EM, x1: x0 + width, y1: y + size * DESCENT_EM };
}

/** Two boxes overlap, with `gap` of air demanded between them. Touching is not overlapping. */
export const meets = (a: Rect, b: Rect, gap = 0): boolean =>
  a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap;

/** A box grown by `by` on every side. */
export const grow = (box: Rect, by: number): Rect => ({
  x0: box.x0 - by,
  y0: box.y0 - by,
  x1: box.x1 + by,
  y1: box.y1 + by,
});

/** The box one stroke paints between two points — `half` its half-width. */
export function segmentBox(ax: number, ay: number, bx: number, by: number, half: number): Rect {
  return {
    x0: Math.min(ax, bx) - half,
    y0: Math.min(ay, by) - half,
    x1: Math.max(ax, bx) + half,
    y1: Math.max(ay, by) + half,
  };
}

/** One mark as drawn: the moments it stands for, what it says and where its box is. */
export interface PlacedMark<M> {
  members: M[];
  /** Where it stands — its members' mean, in the drawing's units, before the box is held inside. */
  at: number;
  /** A single glyph, or the glyph and how many it stands for: `✎×4`, or `●+3` for mixed kinds. */
  text: string;
  /** The box's left and right edges, already held inside `[1, width − 1]`. */
  x0: number;
  x1: number;
}

/** The air demanded between two marks on one line. */
const MARK_GAP = 1;

/**
 * Moments on one line, as the marks a reader can tell apart.
 *
 * A glyph is an em wide (a ✎ or a ✖ is, whatever the estimator says of a
 * letter). Marks are taken left to right, and one whose glyph would meet the
 * mark before it joins it; a mark that grew (its count widens it) and so
 * reached the one before it is merged with that one too, until no two boxes
 * meet. A lone moment keeps its glyph; a cluster of one kind says `✎×4`, of
 * several kinds the first one's glyph and how many more, `●+3`. Zooming in
 * spreads the moments, and the clusters come apart by themselves.
 */
export function clusterMarks<M extends { atMs: number; glyph: string }>(
  marks: readonly M[],
  x: (ms: number) => number,
  width: number,
  size = FIGURE_TYPE,
): PlacedMark<M>[] {
  const sorted = marks
    .map((mark) => ({ mark, px: x(mark.atMs) }))
    .filter((one) => Number.isFinite(one.px))
    .sort((a, b) => a.px - b.px);

  const place = (members: { mark: M; px: number }[]): PlacedMark<M> => {
    const first = members[0]!.mark;
    const one = members.length === 1;
    const same = members.every((m) => m.mark.glyph === first.glyph);
    const text = one
      ? first.glyph
      : same
        ? `${first.glyph}×${members.length}`
        : `${first.glyph}+${members.length - 1}`;
    const wide = size + (one ? 0 : textWidth(text.slice(first.glyph.length)) * (size / FIGURE_TYPE));
    const at = members.reduce((sum, m) => sum + m.px, 0) / members.length;
    // Held inside the drawing, as `inside()` holds a lone glyph.
    const x0 = at + wide / 2 > width - 1 ? width - 1 - wide : at - wide / 2 < 1 ? 1 : at - wide / 2;
    return { members: members.map((m) => m.mark), at, text, x0, x1: x0 + wide };
  };

  const groups: { mark: M; px: number }[][] = [];
  for (const one of sorted) {
    const last = groups.at(-1);
    if (last) {
      const placed = place(last);
      if (one.px - size / 2 < placed.x1 + MARK_GAP) {
        last.push(one);
        continue;
      }
    }
    groups.push([one]);
  }
  // A cluster that widened can reach the one before it: merge until none meets.
  for (let i = 1; i < groups.length;) {
    const before = place(groups[i - 1]!);
    const here = place(groups[i]!);
    if (here.x0 < before.x1 + MARK_GAP) {
      groups[i - 1] = groups[i - 1]!.concat(groups[i]!);
      groups.splice(i, 1);
      i = Math.max(1, i - 1);
    } else {
      i += 1;
    }
  }
  return groups.map(place);
}
