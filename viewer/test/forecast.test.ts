/**
 * The forecast — a DATE, and everything it is standing on.
 *
 * The defect this file exists to prevent is the quiet one: `now + etaFrom(...)`
 * looks like a completion date and is a claim about working time. Every plan
 * in this repo's own history spends most of its wall-clock NOT working —
 * waiting on a gate, held by a review, parked, or overnight — so the naive
 * date is early by more than the estimate itself, and being early is exactly
 * the direction nobody checks.
 *
 * So the properties pinned here are: the duty cycle is MEASURED from the plan's
 * RECENT completions (a bounded window, control-tower phase 58, #66) and
 * stretches the estimate; when it cannot be measured, or measures a plan that
 * mostly sat, the forecast has NO date and says why; and every figure names
 * its clock.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DUTY_MIN_RATIO, DUTY_WINDOW, dutyCycle, etaFrom, forecastFrom, rateFor,
  type EtaEstimate, type EtaSample,
} from '../server/analysis/stats.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-08-20T12:00:00Z');

/** A completion: `durationMs` of work, ending at `at`. */
const sample = (at: string, hours: number, weight = 40_000): EtaSample =>
  ({ weight, durationMs: hours * HOUR, at, size: 'M' });

/** A plan that worked 1 h out of every 3 h of wall-clock: four completions, 3 h apart. */
const THIRD_DUTY: EtaSample[] = [
  sample('2026-08-20T00:00:00Z', 1),
  sample('2026-08-20T03:00:00Z', 1),
  sample('2026-08-20T06:00:00Z', 1),
  sample('2026-08-20T09:00:00Z', 1),
];

const etaOf = (samples: EtaSample[], basisSamples = samples): EtaEstimate =>
  etaFrom(rateFor(basisSamples, basisSamples), { weight: 160_000, phases: 4 })!;

/* ------------------------------------------------------------------ *
 * dutyCycle
 * ------------------------------------------------------------------ */

test('the duty cycle is measured over the window BETWEEN completions, so the first sample is not double-counted', () => {
  const duty = dutyCycle(THIRD_DUTY, NOW);
  assert.equal(duty.known, true);
  assert.equal(duty.samples, 4);
  // 9 h elapsed between first and last completion; 3 h of work inside it (the
  // first sample's own hour happened BEFORE the window opened).
  assert.equal(duty.elapsedMs, 9 * HOUR);
  assert.equal(duty.workingMs, 3 * HOUR);
  assert.equal(duty.ratio, 1 / 3);
});

test('EE-4: the window is RECENT and bounded — an old completion does not stretch the pace', () => {
  const old = sample('2026-06-01T00:00:00Z', 1);
  const withOld = dutyCycle([old, ...THIRD_DUTY], NOW);
  assert.equal(withOld.ratio, 1 / 3, 'a completion months back is outside the window');
  assert.equal(withOld.samples, 4);
  // …and only the newest DUTY_WINDOW completions are read at all.
  const many = Array.from({ length: DUTY_WINDOW + 6 }, (_, i) =>
    sample(new Date(Date.parse('2026-08-19T00:00:00Z') + i * 2 * HOUR).toISOString(), 1));
  assert.equal(dutyCycle(many, NOW).samples, DUTY_WINDOW);
});

test('EE-5: fewer than three recent completions is not a pace — unknown, not an assumed 100 %', () => {
  const one = dutyCycle([sample('2026-08-20T00:00:00Z', 1)], NOW);
  assert.equal(one.known, false);
  assert.equal(one.reason, 'too-few');
  const two = dutyCycle(THIRD_DUTY.slice(0, 2), NOW);
  assert.equal(two.known, false);
  assert.equal(two.reason, 'too-few');
});

test('EE-5: a window that is mostly idle reads unknown rather than stretching the estimate by it', () => {
  // Three one-minute completions a day apart: a duty cycle near 0.0007.
  const idle = [
    sample('2026-08-18T00:00:00Z', 0.1),
    sample('2026-08-19T00:00:00Z', 0.1),
    sample('2026-08-20T00:00:00Z', 0.1),
  ];
  const duty = dutyCycle(idle, NOW);
  assert.equal(duty.known, false);
  assert.equal(duty.reason, 'idle-history');
  assert.ok(duty.ratio < DUTY_MIN_RATIO);
  const forecast = forecastFrom(etaOf(idle, THIRD_DUTY), duty, NOW)!;
  assert.equal(forecast.calendar, 'unknown');
  assert.equal(forecast.expected, undefined, 'no date off an idle-history ratio');
});

test('EE-5: a plan with no completion in the last week has no recent pace', () => {
  const duty = dutyCycle(THIRD_DUTY, NOW + 10 * DAY);
  assert.equal(duty.known, false);
  assert.equal(duty.reason, 'stale');
});

test('a duty cycle can never exceed 1, however many lanes ran at once', () => {
  const parallel = [
    sample('2026-08-20T00:00:00Z', 1),
    sample('2026-08-20T01:00:00Z', 5),
    sample('2026-08-20T02:00:00Z', 5),
  ];
  assert.equal(dutyCycle(parallel, NOW).ratio, 1);
});

test('undated or zero-duration samples are not evidence about elapsed time', () => {
  const duty = dutyCycle([
    { weight: 40_000, durationMs: HOUR },
    { weight: 40_000, durationMs: 0, at: '2026-08-20T00:00:00Z' },
    sample('2026-08-20T03:00:00Z', 1),
  ], NOW);
  assert.equal(duty.known, false);
});

/* ------------------------------------------------------------------ *
 * forecastFrom
 * ------------------------------------------------------------------ */

test('the forecast stretches the WORKING estimate by the measured duty cycle', () => {
  const eta = etaOf(THIRD_DUTY);
  const forecast = forecastFrom(eta, dutyCycle(THIRD_DUTY, NOW), NOW)!;
  assert.equal(forecast.calendar, 'known');
  assert.equal(forecast.workingLowMs, eta.lowMs);
  assert.equal(forecast.workingHighMs, eta.highMs);
  // ÷ (1/3), to the millisecond a Date keeps.
  assert.ok(Math.abs(Date.parse(forecast.earliest!) - NOW - eta.lowMs * 3) <= 1);
  assert.ok(Math.abs(Date.parse(forecast.latest!) - NOW - eta.highMs * 3) <= 1);
});

test('expected sits between earliest and latest', () => {
  const forecast = forecastFrom(etaOf(THIRD_DUTY), dutyCycle(THIRD_DUTY, NOW), NOW)!;
  const [e, x, l] = [forecast.earliest!, forecast.expected!, forecast.latest!].map(Date.parse);
  assert.ok(e! <= x! && x! <= l!);
});

test('an unknown duty cycle gives no date at all, and the assumptions say why', () => {
  const duty = dutyCycle([sample('2026-08-20T00:00:00Z', 1)], NOW);
  const forecast = forecastFrom(etaOf(THIRD_DUTY), duty, NOW)!;
  assert.equal(forecast.calendar, 'unknown');
  assert.equal(forecast.earliest, undefined);
  assert.equal(forecast.latest, undefined);
  assert.equal(forecast.label, 'calendar time unknown');
  assert.match(forecast.assumptions.join('\n'), /Duty cycle: unknown — fewer than three/);
});

test('every assumption the date rests on is IN the answer — the whole point of the field', () => {
  const forecast = forecastFrom(etaOf(THIRD_DUTY), dutyCycle(THIRD_DUTY, NOW), NOW)!;
  const text = forecast.assumptions.join('\n');
  assert.match(text, /Rate: /);
  assert.match(text, /4 measured phases weighted/);
  assert.match(text, /Model: each phase takes .+ plus \d+ ms per unit of weight/);
  assert.match(text, /Work left: 160000 weight across 4 phases/);
  assert.match(text, /Duty cycle: 33%/);
  assert.match(text, /one after another/);
  assert.match(text, /spread of the measured phases/);
});

test('finished phases with no usable measurement are named in the assumptions, not dropped', () => {
  const rate = rateFor(THIRD_DUTY, THIRD_DUTY, { missing: 2 });
  const eta = etaFrom(rate, { weight: 40_000, phases: 1 })!;
  const forecast = forecastFrom(eta, dutyCycle(THIRD_DUTY, NOW), NOW)!;
  assert.equal(forecast.missing, 2);
  assert.match(forecast.assumptions[0]!, /2 finished phases have no usable measurement/);
});

test('the basis rides along, so a heuristic date cannot be read as a measured one', () => {
  const eta = etaFrom(rateFor([], []), { weight: 40_000, phases: 1 })!;
  const forecast = forecastFrom(eta, dutyCycle(THIRD_DUTY, NOW), NOW)!;
  assert.equal(forecast.basis, 'heuristic');
  assert.match(forecast.assumptions[0]!, /placeholder/);
});

test('no remaining work means no date — "finishes today" on a finished plan is a units error', () => {
  assert.equal(forecastFrom(null, dutyCycle(THIRD_DUTY, NOW), NOW), null);
});

test('the label is zone-free and names the calendar, so it is safe to print anywhere', () => {
  const forecast = forecastFrom(etaOf(THIRD_DUTY), dutyCycle(THIRD_DUTY, NOW), NOW)!;
  assert.equal(forecast.clock, 'calendar');
  assert.match(forecast.label, /^~.+ on the calendar$/);
  assert.doesNotMatch(forecast.label, /Z|GMT|UTC|\d{4}-\d\d/);
});

test('an unreadable clock is refused rather than turned into 1970', () => {
  assert.equal(forecastFrom(etaOf(THIRD_DUTY), dutyCycle(THIRD_DUTY, NOW), Number.NaN), null);
});
