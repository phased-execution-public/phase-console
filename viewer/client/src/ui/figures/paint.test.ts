/**
 * #415 — at 390 px Insights ▸ Accounts' time axis wrote `Oct 19 16:00` over
 * `Oct 19 23:00`: the label pulled inside the frame at the right edge landed on
 * its neighbour. `unclashed` keeps only the labels whose drawn extent, where
 * `inside` will draw them, meets nothing kept to their right.
 */

import { describe, expect, it } from 'vitest';

import { inside, unclashed } from './paint';

/** Seventy pixels a label, the width of `Oct 19 16:00` at the figures' type. */
const WIDE = 70;

describe('unclashed', () => {
  it('drops the label an edge would push onto its neighbour, and keeps the newest', () => {
    // A 390 px phone: the last two ticks are 40 px apart and the last is pulled left by the edge.
    const ticks = [40, 160, 300, 340];
    const kept = unclashed(
      ticks,
      (at) => at,
      () => WIDE,
      390,
    );
    expect(kept).toEqual([40, 160, 340]);
    expect(kept.at(-1)).toBe(340);
  });

  it('every kept label clears the next by the gap, where it is drawn', () => {
    const ticks = Array.from({ length: 12 }, (_, i) => 10 + i * 32);
    const kept = unclashed(
      ticks,
      (at) => at,
      () => WIDE,
      390,
      4,
    );
    const extent = (at: number) => {
      const { textAnchor, dx } = inside(at, WIDE, 390);
      const anchor = at + dx;
      const start =
        textAnchor === 'end' ? anchor - WIDE : textAnchor === 'start' ? anchor : anchor - WIDE / 2;
      return [start, start + WIDE] as const;
    };
    for (let i = 1; i < kept.length; i++)
      expect(extent(kept[i - 1]!)[1] + 4).toBeLessThanOrEqual(extent(kept[i]!)[0]);
    for (const at of kept) {
      const [start, end] = extent(at);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(390);
    }
  });

  it('leaves a wide desk alone', () => {
    const ticks = [100, 400, 700, 1000];
    expect(
      unclashed(
        ticks,
        (at) => at,
        () => WIDE,
        1280,
      ),
    ).toEqual(ticks);
  });
});
