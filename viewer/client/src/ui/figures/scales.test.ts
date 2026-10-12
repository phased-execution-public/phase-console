/**
 * The one axis primitive (control-tower phase 29, #32 gap 2). What it holds:
 * a duration axis still lands on round units — the ladder `ticksFor` always
 * had, now also for a zoomed window that does not start at zero; a value axis
 * lands on 1-2-5 steps; and a zoom never leaves the data, never inverts, and
 * keeps the point under the pointer where the pointer is.
 */

import { describe, expect, it } from 'vitest';

import { durationTicks, linear, panWindow, ticksFor, valueTicks, zoomOf, zoomWindow } from './scales';

const MIN = 60_000;

describe('durationTicks', () => {
  it('is the old ladder over a window that starts at zero', () => {
    expect(durationTicks([0, 60 * MIN])).toEqual([0, 15 * MIN, 30 * MIN, 45 * MIN, 60 * MIN]);
    expect(durationTicks([0, 60 * MIN])).toEqual(ticksFor(60 * MIN));
  });

  it('lands on round units inside a zoomed window, not on the window edge', () => {
    // 10:07 → 10:37 is a 30-minute window: 5-minute steps, starting at 10:10.
    const ticks = durationTicks([7 * MIN, 37 * MIN]);
    expect(ticks[0]).toBe(10 * MIN);
    for (const at of ticks) expect(at % (5 * MIN)).toBe(0);
    expect(ticks.at(-1)).toBeLessThanOrEqual(37 * MIN);
  });

  it('has nothing to label in an empty or inverted window', () => {
    expect(durationTicks([5, 5])).toEqual([]);
    expect(durationTicks([9, 3])).toEqual([]);
  });
});

describe('valueTicks', () => {
  it('lands on 1-2-5 steps from zero and covers the maximum', () => {
    const ticks = valueTicks(0, 13);
    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(13);
    const step = ticks[1] - ticks[0];
    expect([1, 2, 5, 10]).toContain(step);
  });

  it('says zero for nothing measured rather than inventing a scale', () => {
    expect(valueTicks(0, 0)).toEqual([0]);
  });

  it('reads cents as cents', () => {
    const ticks = valueTicks(0, 0.4);
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(0.4);
    expect(ticks.every((t) => t <= 0.5)).toBe(true);
  });
});

describe('linear', () => {
  it('maps a window onto a pixel range and back', () => {
    const scale = linear([10, 20], [0, 100]);
    expect(scale(15)).toBe(50);
    expect(scale.invert(25)).toBe(12.5);
  });
});

describe('zoomWindow', () => {
  const bounds = [0, 100] as const;

  it('narrows about the focus, keeping the focus where it was', () => {
    const next = zoomWindow([0, 100], 2, 25, bounds, 1);
    expect(next[1] - next[0]).toBe(50);
    // 25 sat a quarter of the way in, and still does.
    expect((25 - next[0]) / (next[1] - next[0])).toBeCloseTo(0.25);
  });

  it('never leaves the data, however hard it is pushed', () => {
    const out = zoomWindow([60, 100], 0.1, 90, bounds, 1);
    expect(out).toEqual([0, 100]);
    const edge = zoomWindow([0, 100], 4, 99, bounds, 1);
    expect(edge[1]).toBeLessThanOrEqual(100);
    expect(edge[0]).toBeGreaterThanOrEqual(0);
  });

  it('stops at the narrowest window the figure allows', () => {
    const next = zoomWindow([0, 100], 1000, 50, bounds, 5);
    expect(next[1] - next[0]).toBe(5);
  });

  it('pans without changing the span, clamped at both ends', () => {
    expect(panWindow([10, 30], 50, bounds)).toEqual([60, 80]);
    expect(panWindow([10, 30], 80, bounds)).toEqual([80, 100]);
    expect(panWindow([10, 30], -50, bounds)).toEqual([0, 20]);
  });

  it('reads the zoom as the full span over the window span', () => {
    expect(zoomOf([0, 25], bounds)).toBe(4);
    expect(zoomOf([0, 100], bounds)).toBe(1);
  });
});
