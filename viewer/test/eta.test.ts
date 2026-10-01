/**
 * How long is left.
 *
 * The estimator is small, which is exactly why it is worth pinning: a figure
 * this cheap to produce is one somebody will read off the screen and plan an
 * evening around. What is asserted here is mostly what it *refuses* to say —
 * nothing at all without evidence, nothing precise with a little, never a
 * countdown, and never a figure that does not name its clock.
 *
 * The model is affine since control-tower phase 58 (#65): a phase takes a
 * floor plus a slope × weight of working time, the shape fitted on the pool's
 * per-size medians and the level on this plan's own measured phases. The
 * robustness and back-test contracts live in `eta-robust.test.ts` and
 * `eta-backtest.test.ts`; the evidence in `eta-evidence.test.ts`.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  estimateEta, estimateMs, etaFrom, etaSamples, fitShape, heuristicPhaseMs, phaseEtaFor, rateFor,
  ETA_MIN_EVIDENCE_MS, HEURISTIC_FLOOR_MS, HEURISTIC_RATE_PER_WEIGHT, HEURISTIC_SLOPE_MS_PER_WEIGHT,
  type EtaSample,
} from '../server/analysis/stats.ts';
import { loadSizing } from '../server/analysis/graph.ts';
import { SKILL_DIR } from '../server/config.ts';

const MIN = 60_000;
const HOUR = 3_600_000;

/**
 * The S/M/L weights, READ from `scripts/sizing.env` rather than restated (F5):
 * nothing here depends on the particular values, only on S < M < L.
 */
const SIZING = loadSizing(join(SKILL_DIR, 'scripts'));
const S = SIZING.S;
const M = SIZING.M;
const L = SIZING.L;

const at = (i: number) => new Date(Date.UTC(2026, 8, 1, i)).toISOString();
const sample = (size: 'S' | 'M' | 'L', minutes: number, i = 0): EtaSample =>
  ({ weight: size === 'S' ? S : size === 'M' ? M : L, durationMs: minutes * MIN, at: at(i), size });

test('with no finished phase there is no estimate at all', () => {
  assert.equal(estimateEta([], { weight: L * 3, phases: 3 }), null);
});

test('with nothing left to do there is nothing to estimate', () => {
  const samples = [sample('M', 40), sample('M', 50, 1), sample('M', 45, 2)];
  assert.equal(estimateEta(samples, { weight: 0, phases: 0 }), null);
});

test('the model is a floor plus a slope: an L is not six times an S', () => {
  const pool = [
    ...[30, 32, 35, 28].map((m, i) => sample('S', m, i)),
    ...[45, 50, 48, 52].map((m, i) => sample('M', m, 10 + i)),
    ...[70, 75, 72, 68].map((m, i) => sample('L', m, 20 + i)),
  ];
  const rate = rateFor(pool, pool);
  const s = estimateMs(rate, S);
  const l = estimateMs(rate, L);
  assert.ok(rate.floorMs > 10 * MIN, `a real floor, got ${rate.floorMs / MIN} min`);
  assert.ok(l / s > 1.5 && l / s < 3.5, `L/S ${l / s} tracks the measured medians, not the 6× of the weights`);
});

test('a fixed sequence produces a labelled range in working time, and never a countdown', () => {
  const samples = [sample('M', 40), sample('M', 44, 1), sample('M', 38, 2), sample('M', 42, 3)];
  const eta = etaFrom(rateFor(samples, samples), { weight: M * 3, phases: 3 })!;
  assert.equal(eta.basis, 'plan');
  assert.equal(eta.clock, 'working');
  assert.equal(eta.samples, 4);
  assert.ok(eta.lowMs < eta.highMs);
  assert.match(eta.label, /^~.+ of work left$/, 'names its clock');
  assert.doesNotMatch(eta.label, /\d+s\b|:\d\d/, 'no seconds, no clock face');
});

test('the range snaps to a scale a person would say out loud', () => {
  const samples = [sample('M', 40), sample('M', 44, 1), sample('M', 38, 2)];
  const eta = etaFrom(rateFor(samples, samples), { weight: M * 9, phases: 9 })!;
  for (const ms of [eta.lowMs, eta.highMs]) {
    if (ms < HOUR) assert.equal(ms % (5 * MIN), 0);
    else if (ms < 4 * HOUR) assert.equal(ms % (30 * MIN), 0);
    else assert.equal(ms % HOUR, 0);
  }
});

test('a tiny remainder still reads as a floor rather than as zero', () => {
  const samples = [sample('S', 6), sample('S', 6, 1), sample('S', 6, 2)];
  const eta = etaFrom(rateFor(samples, samples), { weight: 1, phases: 1 })!;
  assert.ok(eta.lowMs >= 5 * MIN);
});

test('only phases that finished — and were measured — are evidence of how long a phase takes', () => {
  const runs = [{
    phases: {
      '1': { phase: 1, status: 'done', durationMs: 30 * MIN, endedAt: at(1) },
      '2': { phase: 2, status: 'interrupted', durationMs: 90 * MIN, endedAt: at(2) },
      '3': { phase: 3, status: 'done', durationMs: 0, endedAt: at(3) },
      '4': { phase: 4, status: 'done', durationMs: ETA_MIN_EVIDENCE_MS - 1, endedAt: at(4) },
    },
  }];
  const samples = etaSamples(runs, new Map([[1, M], [2, M], [3, M], [4, M]]));
  assert.deepEqual(samples.map((s) => s.durationMs), [30 * MIN]);
});

test('samples come from every run of the plan, oldest first', () => {
  const runs = [
    { phases: { '2': { phase: 2, status: 'done', durationMs: 20 * MIN, endedAt: at(5) } } },
    { phases: { '1': { phase: 1, status: 'done', durationMs: 10 * MIN, endedAt: at(1) } } },
  ];
  const samples = etaSamples(runs, new Map([[1, S], [2, S]]));
  assert.deepEqual(samples.map((s) => s.durationMs), [10 * MIN, 20 * MIN]);
});

test('a phase the plan no longer sizes is not a sample', () => {
  const runs = [{ phases: { '9': { phase: 9, status: 'done', durationMs: 20 * MIN, endedAt: at(1) } } }];
  assert.deepEqual(etaSamples(runs, new Map([[1, M]])), []);
});

test("this plan's own phases set the level, however big the pool", () => {
  const own = [sample('M', 120), sample('M', 130, 1), sample('M', 125, 2)];
  const pool = Array.from({ length: 200 }, (_, i) => sample('M', 40, 10 + i));
  const rate = rateFor(own, [...pool, ...own]);
  assert.equal(rate.basis, 'plan');
  assert.equal(rate.samples, 3);
  assert.ok(estimateMs(rate, M) > 100 * MIN, 'the plan runs three times the pool, and the estimate says so');
});

test('with nothing of its own a plan borrows the pool, and says so', () => {
  const pool = [sample('M', 40), sample('M', 44, 1), sample('M', 38, 2)];
  const rate = rateFor([], pool);
  assert.equal(rate.basis, 'portfolio');
  assert.equal(rate.samples, 3);
  assert.ok(rate.spread >= 0.5 - 1e-9, 'never tighter than ±50 % on borrowed evidence');
});

test('with nothing anywhere the heuristic answers, labelled as the guess it is', () => {
  const rate = rateFor([], []);
  assert.equal(rate.basis, 'heuristic');
  assert.equal(rate.samples, 0);
  assert.equal(rate.floorMs, HEURISTIC_FLOOR_MS);
  assert.equal(rate.slopeMsPerWeight, HEURISTIC_SLOPE_MS_PER_WEIGHT);
});

test('the shipped shape is measured, not a stake in the ground: S, M and L within 2× of each other', () => {
  const s = heuristicPhaseMs(S);
  const l = heuristicPhaseMs(L);
  assert.ok(s > 30 * MIN && l < 2 * HOUR, `S ${s / MIN} min, L ${l / MIN} min`);
  assert.ok(l / s < 2, 'the old constant made an L six times an S');
  assert.equal(HEURISTIC_RATE_PER_WEIGHT, Math.round(heuristicPhaseMs(40_000) / 40_000));
});

test('the band never tightens as the evidence weakens', () => {
  const plan = rateFor([sample('M', 40), sample('M', 44, 1), sample('M', 38, 2), sample('M', 41, 3)], []);
  const pool = rateFor([], [sample('M', 40), sample('M', 44, 1), sample('M', 38, 2), sample('M', 41, 3)]);
  const none = rateFor([], []);
  assert.ok(plan.spread <= pool.spread, `plan ${plan.spread} ≤ pool ${pool.spread}`);
  assert.ok(pool.spread <= none.spread, `pool ${pool.spread} ≤ heuristic ${none.spread}`);
});

test('a borrowed rate still refuses to estimate a plan with nothing left', () => {
  assert.equal(etaFrom(rateFor([], [sample('M', 40)]), { weight: 0, phases: 0 }), null);
});

test('the estimate carries its basis, its clock and its evidence count all the way to the render site', () => {
  const eta = etaFrom(rateFor([], []), { weight: M, phases: 1 })!;
  assert.equal(eta.basis, 'heuristic');
  assert.equal(eta.clock, 'working');
  assert.equal(eta.samples, 0);
  assert.equal(eta.missing, 0);
});

test('estimateEta stays plan-evidence-only, so the old contract is unchanged', () => {
  assert.equal(estimateEta([], { weight: M, phases: 1 }), null);
  const eta = estimateEta([sample('M', 40), sample('M', 44, 1), sample('M', 38, 2)], { weight: M, phases: 1 });
  assert.equal(eta?.basis, 'plan');
});

test('a phase estimate is the same reading applied to that phase alone, and names its clock', () => {
  const samples = [sample('M', 40), sample('L', 70, 1), sample('M', 44, 2), sample('L', 75, 3)];
  const rate = rateFor(samples, samples);
  const small = phaseEtaFor(1, S, rate);
  const large = phaseEtaFor(2, L, rate);
  assert.ok(large.estMs > small.estMs);
  assert.equal(large.clock, 'working');
  assert.match(large.label, /^~.+ of work$/);
  assert.equal(large.basis, rate.basis);
});

test('a phase estimate is bucketed like every other figure here', () => {
  const rate = rateFor([], []);
  const eta = phaseEtaFor(1, M, rate);
  assert.equal(eta.estMs % (5 * MIN), 0);
});

test('a declared wall-clock floor replaces the model wherever it is higher', () => {
  const rate = rateFor([], []);
  assert.equal(estimateMs(rate, S, 3 * HOUR), 3 * HOUR);
  assert.equal(estimateMs(rate, S, 1 * MIN), estimateMs(rate, S));
  assert.equal(phaseEtaFor(9, S, rate, 2 * HOUR).estMs, 2 * HOUR);
  const plain = etaFrom(rate, { weight: S + M, phases: 2 })!;
  const floored = etaFrom(rate, { weight: S + M, phases: 2, floors: [{ weight: S, floorMs: 3 * HOUR }] })!;
  assert.ok(floored.highMs > plain.highMs + HOUR, 'the gated phase carries its floor into the plan total');
});

test('a phase whose time a declared floor explains teaches the rate nothing', () => {
  const pool = [sample('M', 40), sample('M', 44, 1), sample('M', 38, 2)];
  const gated = { ...sample('S', 6 * 60, 3), floorMs: 90 * MIN };
  assert.deepEqual(fitShape([...pool, gated]), fitShape(pool));
});

test('a plan and its phases cannot disagree about how fast it goes', () => {
  const samples = [sample('M', 40), sample('L', 70, 1), sample('M', 44, 2), sample('L', 75, 3)];
  const rate = rateFor(samples, samples);
  const eta = etaFrom(rate, { weight: M + L, phases: 2 })!;
  const sumOfPhases = estimateMs(rate, M) + estimateMs(rate, L);
  const factor = 1 + rate.spread;
  // The plan's band is the same reading summed; bucketing moves each end by at most a bucket.
  assert.ok(Math.abs(eta.highMs / factor - sumOfPhases) < 0.35 * sumOfPhases);
});
