/**
 * The ETA is robust (control-tower phase 58, #65, ER-1..4).
 *
 * The old rate was an EMA of duration ÷ weight at α = 0.4: the newest phase
 * was 40 % of it, nothing was clipped, and dividing by weight made a long S six
 * times as extreme as an L of the same length. One S phase that spent six
 * hours polling a gate log took the plan's rate from 73 to 633 ms per weight;
 * the next L phase was shown as 16 hours and took 1.4. These tests pin the
 * replacement's four properties:
 *
 *   ER-1  one 16-hour outlier moves an L estimate by at most 1.5×, however
 *         much or little evidence surrounds it;
 *   ER-2  the band comes from how spread the evidence is, not how much of it
 *         there is;
 *   ER-3  the evidence count a surface prints is the count that was weighted;
 *   ER-4  the shape is per-size winsorised medians fitted to a floor + slope.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateMs, fitShape, planLevel, rateFor, ETA_PLAN_WINDOW, ETA_POOL_WINDOW,
  HEURISTIC_FLOOR_MS, HEURISTIC_SLOPE_MS_PER_WEIGHT, type EtaSample,
} from '../server/analysis/stats.ts';

const MIN = 60_000;
const HOUR = 3_600_000;
const W = { S: 15_000, M: 40_000, L: 90_000 } as const;

let clock = 0;
/** A measured phase, each newer than the last. */
const phase = (size: 'S' | 'M' | 'L', ms: number): EtaSample =>
  ({ weight: W[size], durationMs: ms, size, at: new Date(Date.UTC(2026, 8, 1) + ++clock * MIN).toISOString() });

/** A small deterministic spread around a centre: ±15 %, the same every run. */
const around = (size: 'S' | 'M' | 'L', centreMs: number, n: number): EtaSample[] =>
  Array.from({ length: n }, (_, i) => phase(size, centreMs * (1 + 0.15 * Math.sin(i * 1.7))));

/** The pool a console of this size holds: every size, the audit's medians. */
const POOL = [...around('S', 0.5 * HOUR, 8), ...around('M', 0.85 * HOUR, 20), ...around('L', 1.15 * HOUR, 24)];

const lEstimate = (own: EtaSample[], pool: EtaSample[] = POOL): number =>
  estimateMs(rateFor(own, [...pool, ...own]), W.L);

/* ------------------------------------------------------------------ *
 * ER-1 — one outlier's reach
 * ------------------------------------------------------------------ */

test('ER-1: one 16-hour phase moves an L estimate by at most 1.5×, for every amount of evidence around it', () => {
  for (let n = 0; n <= ETA_PLAN_WINDOW; n++) {
    const own = around('L', 1.3 * HOUR, n);
    for (const size of ['S', 'M', 'L'] as const) {
      const before = lEstimate(own);
      const after = lEstimate([...own, phase(size, 16 * HOUR)]);
      const moved = Math.max(after / before, before / after);
      assert.ok(moved <= 1.5, `n=${n}, a 16 h ${size}: moved ${moved.toFixed(2)}×`);
    }
  }
});

test('ER-1: the week that broke the old rate — nine phases at their pace, then a six-hour S — barely moves the next L', () => {
  // The nine prior phases, as rates in ms per weight on L/M phases, then the S.
  const rates = [73, 96, 41.7, 88, 64, 57, 79, 70, 62];
  const own = rates.map((r, i) => phase(i % 3 ? 'L' : 'M', r * (i % 3 ? W.L : W.M)));
  const before = lEstimate(own);
  const after = lEstimate([...own, phase('S', 6.14 * HOUR)]);
  assert.ok(after / before <= 1.5, `moved ${(after / before).toFixed(2)}×; the EMA moved it 8.7×`);
  assert.ok(after < 4 * HOUR, `the next L reads ${(after / HOUR).toFixed(1)} h, not 16`);
});

test('ER-1: a 16-hour outlier in the POOL is one sample among sixty, not 40 % of the answer', () => {
  const before = estimateMs(rateFor([], POOL), W.L);
  const after = estimateMs(rateFor([], [...POOL, phase('S', 16 * HOUR)]), W.L);
  assert.ok(Math.max(after / before, before / after) <= 1.5);
});

/* ------------------------------------------------------------------ *
 * ER-2 — the band is the spread
 * ------------------------------------------------------------------ */

test('ER-2: the band comes from observed dispersion — same count, different spread, different band', () => {
  const steady = Array.from({ length: 8 }, (_, i) => phase('L', HOUR * (1 + 0.05 * Math.sin(i))));
  const erratic = Array.from({ length: 8 }, (_, i) => phase('L', HOUR * (i % 2 ? 2.2 : 0.45)));
  const tight = rateFor(steady, POOL);
  const wide = rateFor(erratic, POOL);
  assert.equal(tight.samples, wide.samples);
  assert.ok(wide.spread > tight.spread * 2, `erratic ${wide.spread.toFixed(2)} vs steady ${tight.spread.toFixed(2)}`);
});

test('ER-2: more of the same evidence does not narrow the band by itself', () => {
  const pattern = (n: number) => Array.from({ length: n }, (_, i) => phase('L', HOUR * [0.7, 1, 1.4][i % 3]!));
  const few = rateFor(pattern(6), POOL);
  const many = rateFor(pattern(12), POOL);
  assert.ok(Math.abs(few.spread - many.spread) < 0.1, `6 → ${few.spread.toFixed(2)}, 12 → ${many.spread.toFixed(2)}`);
});

test('ER-2: the band brackets the phases it came from — about three in four inside it', () => {
  const own = around('L', 1.2 * HOUR, 12);
  const rate = rateFor(own, POOL);
  const point = estimateMs(rate, W.L);
  const factor = 1 + rate.spread;
  const inside = own.filter((s) => s.durationMs >= point / factor && s.durationMs <= point * factor).length;
  assert.ok(inside >= 8, `${inside} of 12 inside ×/÷ ${factor.toFixed(2)}`);
});

/* ------------------------------------------------------------------ *
 * ER-3 — the count shown is the count weighted
 * ------------------------------------------------------------------ */

test('ER-3: a pooled reading reports the window it weighted, never the whole history', () => {
  const history = Array.from({ length: 400 }, (_, i) => phase(i % 2 ? 'M' : 'L', HOUR));
  const rate = rateFor([], history);
  assert.equal(rate.basis, 'portfolio');
  assert.equal(rate.samples, ETA_POOL_WINDOW);
});

test('ER-3: a plan reading reports its own window', () => {
  const own = around('M', HOUR, 30);
  const rate = rateFor(own, POOL);
  assert.equal(rate.basis, 'plan');
  assert.equal(rate.samples, ETA_PLAN_WINDOW);
  assert.equal(planLevel(own, { floorMs: HOUR, slopeMsPerWeight: 0 }).samples, ETA_PLAN_WINDOW);
});

test('ER-3: the level is the NEWEST window — a plan that sped up reads fast', () => {
  const slow = around('M', 3 * HOUR, 20);
  const fast = around('M', 0.8 * HOUR, ETA_PLAN_WINDOW);
  const rate = rateFor([...slow, ...fast], POOL);
  assert.ok(estimateMs(rate, W.M) < 1.2 * HOUR);
});

/* ------------------------------------------------------------------ *
 * ER-4 — per-size winsorised medians, an affine floor + slope
 * ------------------------------------------------------------------ */

test('ER-4: the shape recovers a floor and a slope from per-size medians', () => {
  // 30 min + 20 ms per weight: S 35, M 43.3, L 60 min.
  const truth = (w: number) => 30 * MIN + 20 * w;
  const pool = (['S', 'M', 'L'] as const).flatMap((size) => around(size, truth(W[size]), 9));
  const shape = fitShape(pool)!;
  assert.ok(Math.abs(shape.floorMs - 30 * MIN) < 3 * MIN, `floor ${(shape.floorMs / MIN).toFixed(1)} min`);
  assert.ok(Math.abs(shape.slopeMsPerWeight - 20) < 3, `slope ${shape.slopeMsPerWeight.toFixed(1)} ms/weight`);
  assert.deepEqual(shape.sizes.map((s) => s.size), ['S', 'M', 'L']);
});

test('ER-4: one extreme sample per size moves neither the medians nor the line', () => {
  const truth = (w: number) => 30 * MIN + 20 * w;
  const pool = (['S', 'M', 'L'] as const).flatMap((size) => around(size, truth(W[size]), 9));
  const clean = fitShape(pool)!;
  const dirty = fitShape([...pool, phase('S', 16 * HOUR), phase('L', 1 * MIN * 6)])!;
  assert.ok(Math.abs(dirty.floorMs - clean.floorMs) < 5 * MIN);
  assert.ok(Math.abs(dirty.slopeMsPerWeight - clean.slopeMsPerWeight) < 5);
});

test('ER-4: a size seen fewer than three times is a sample, not a class — one six-hour S does not bend the line', () => {
  // pe-hub's own pool on 2026-09-25: 18 M, 41 L and ONE S, the six-hour one.
  // Its median was itself, and as an anchor it flattened the line to S ≈ M ≈ L.
  const truth = (w: number) => 30 * MIN + 20 * w;
  const body = [...around('M', truth(W.M), 18), ...around('L', truth(W.L), 41)];
  const clean = fitShape(body)!;
  const dirty = fitShape([...body, phase('S', 6 * HOUR)])!;
  assert.ok(Math.abs(dirty.floorMs - clean.floorMs) < 5 * MIN, `floor ${(dirty.floorMs / MIN).toFixed(1)} min`);
  assert.ok(Math.abs(dirty.slopeMsPerWeight - clean.slopeMsPerWeight) < 5, `slope ${dirty.slopeMsPerWeight.toFixed(1)}`);
  assert.ok(estimateMs(dirty, W.S) < 1.5 * truth(W.S), `S ${(estimateMs(dirty, W.S) / MIN).toFixed(0)} min`);
  // Still reported, and still counted in the band: it is evidence, just not a class.
  assert.deepEqual(dirty.sizes.map((s) => [s.size, s.samples, s.anchored]), [['S', 1, false], ['M', 18, true], ['L', 41, true]]);
  assert.ok(dirty.dispersion >= clean.dispersion);
});

test('ER-4: a pool with no size seen three times still fits on what it has', () => {
  const shape = fitShape([phase('S', 30 * MIN), phase('L', 90 * MIN)])!;
  assert.ok(shape.slopeMsPerWeight > 0);
  assert.ok(Math.abs(estimateMs(shape, W.L) - 90 * MIN) < MIN);
  assert.deepEqual(shape.sizes.map((s) => s.anchored), [true, true]);
});

test('ER-4: a slope the data says is negative is flat, and a negative floor is zero', () => {
  const inverted = [...around('S', 2 * HOUR, 5), ...around('L', HOUR, 5)];
  const flat = fitShape(inverted)!;
  assert.equal(flat.slopeMsPerWeight, 0);
  assert.ok(flat.floorMs > HOUR);
  const steep = [...around('S', 5 * MIN, 5), ...around('L', 2 * HOUR, 5)];
  const through = fitShape(steep)!;
  assert.equal(through.floorMs, 0);
  assert.ok(through.slopeMsPerWeight > 0);
});

test('ER-4: a pool that knows one size borrows the shipped proportions through its median', () => {
  const shape = fitShape(around('L', 2 * HOUR, 6))!;
  const ratio = shape.slopeMsPerWeight / shape.floorMs;
  assert.ok(Math.abs(ratio - HEURISTIC_SLOPE_MS_PER_WEIGHT / HEURISTIC_FLOOR_MS) < 1e-9);
  assert.ok(Math.abs(shape.floorMs + shape.slopeMsPerWeight * W.L - 2 * HOUR) < 0.2 * HOUR);
});

test('ER-4: the shape is fitted on the newest pool window only', () => {
  const stale = around('M', 5 * HOUR, 200);
  const recent = around('M', HOUR, ETA_POOL_WINDOW);
  const shape = fitShape([...stale, ...recent])!;
  assert.equal(shape.samples, ETA_POOL_WINDOW);
  assert.ok(shape.floorMs + shape.slopeMsPerWeight * W.M < 1.3 * HOUR);
});
