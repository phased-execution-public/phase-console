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
 * So the two properties pinned here are: the duty cycle is MEASURED from the
 * plan's own completions and stretches the estimate, and when it cannot be
 * measured the forecast SAYS SO in its assumptions rather than quietly
 * assuming 100%.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dutyCycle, etaFrom, forecastFrom, rateFor,
  type EtaEstimate, type EtaSample,
} from '../server/analysis/stats.ts';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-08-24T12:00:00Z');

/** A completion: `durationMs` of work, ending at `at`. */
const sample = (at: string, hours: number, weight = 40_000): EtaSample =>
  ({ weight, durationMs: hours * HOUR, at });

/** A plan that worked 1 h out of every 4 h of wall-clock: four completions, 3 h apart. */
const QUARTER_DUTY: EtaSample[] = [
  sample('2026-08-20T00:00:00Z', 1),
  sample('2026-08-20T03:00:00Z', 1),
  sample('2026-08-20T06:00:00Z', 1),
  sample('2026-08-20T09:00:00Z', 1),
];

/* ------------------------------------------------------------------ *
 * dutyCycle
 * ------------------------------------------------------------------ */

test('the duty cycle is measured over the window BETWEEN completions, so the first sample is not double-counted', () => {
  const duty = dutyCycle(QUARTER_DUTY);
  assert.equal(duty.assumed, false);
  assert.equal(duty.samples, 4);
  // 9 h elapsed between first and last completion; 3 h of work inside it (the
  // first sample's own hour happened BEFORE the window opened).
  assert.equal(duty.elapsedMs, 9 * HOUR);
  assert.equal(duty.workingMs, 3 * HOUR);
  assert.equal(duty.ratio, 1 / 3);
});

test('one completion is a duration with no window around it — the fallback is stated, not silent', () => {
  const duty = dutyCycle([sample('2026-08-20T00:00:00Z', 1)]);
  assert.equal(duty.assumed, true);
  assert.equal(duty.ratio, 1);
  assert.equal(duty.samples, 0);
});

test('a duty cycle can never exceed 1, however many lanes ran at once', () => {
  // Two phases finishing a minute apart after four hours each: concurrent
  // lanes. An unclamped ratio would be 240, shrinking the forecast to nothing.
  const duty = dutyCycle([
    sample('2026-08-20T00:00:00Z', 4),
    sample('2026-08-20T00:01:00Z', 4),
  ]);
  assert.equal(duty.ratio, 1);
  assert.equal(duty.assumed, false, 'it WAS measured — it was measured as saturated');
});

test('a window of zero width is not a measurement, however much work is inside it', () => {
  // Two completions recorded at the SAME instant. Dividing by that window
  // gives Infinity, which the clamp turns into a confident-looking 1.0 — so
  // the guard has to run first, and the answer has to say it was assumed.
  const duty = dutyCycle([
    sample('2026-08-20T00:00:00Z', 2),
    sample('2026-08-20T00:00:00Z', 2),
  ]);
  assert.equal(duty.assumed, true, 'a ratio from a zero-width window is not evidence');
  assert.equal(duty.ratio, 1);
});

test('undated or zero-duration samples are not evidence about elapsed time', () => {
  assert.equal(dutyCycle([]).assumed, true);
  assert.equal(dutyCycle([{ weight: 1, durationMs: 0, at: '2026-08-20T00:00:00Z' }]).assumed, true);
  assert.equal(dutyCycle([{ weight: 1, durationMs: HOUR }, { weight: 1, durationMs: HOUR }]).assumed, true);
});

/* ------------------------------------------------------------------ *
 * forecastFrom
 * ------------------------------------------------------------------ */

/** A 4-hour working estimate with a ±50% band. */
function eta(): EtaEstimate {
  const value = etaFrom(rateFor(QUARTER_DUTY), { weight: 160_000, phases: 4 });
  assert.ok(value, 'the fixture must produce an estimate');
  return value;
}

test('the forecast stretches the WORKING estimate by the measured duty cycle', () => {
  const value = eta();
  const forecast = forecastFrom(value, dutyCycle(QUARTER_DUTY), NOW);
  assert.ok(forecast);

  // At a one-third duty cycle a four-hour job takes twelve hours of calendar.
  assert.equal(Date.parse(forecast.earliest) - NOW, value.lowMs * 3);
  assert.equal(Date.parse(forecast.latest) - NOW, value.highMs * 3);
  assert.equal(forecast.workingLowMs, value.lowMs, 'the working figure is reported, not hidden');
  assert.equal(forecast.workingHighMs, value.highMs);
  // The naive date — the one this whole module exists to avoid — would be here.
  assert.ok(Date.parse(forecast.latest) > NOW + value.highMs);
});

test('expected sits between earliest and latest', () => {
  const forecast = forecastFrom(eta(), dutyCycle(QUARTER_DUTY), NOW);
  assert.ok(forecast);
  assert.ok(Date.parse(forecast.earliest) <= Date.parse(forecast.expected));
  assert.ok(Date.parse(forecast.expected) <= Date.parse(forecast.latest));
});

test('an unmeasurable duty cycle produces a date that SAYS it will be early', () => {
  const forecast = forecastFrom(eta(), dutyCycle([]), NOW);
  assert.ok(forecast);
  assert.equal(Date.parse(forecast.latest) - NOW, forecast.workingHighMs, 'no stretch applied');
  const stated = forecast.assumptions.join('\n');
  assert.match(stated, /assumed 100%/);
  assert.match(stated, /it will be early/);
});

test('every assumption the date rests on is IN the answer — the whole point of the field', () => {
  const forecast = forecastFrom(eta(), dutyCycle(QUARTER_DUTY), NOW);
  assert.ok(forecast);
  const stated = forecast.assumptions.join('\n');
  // Four claims a reader must be shown, because each one can make the date wrong.
  assert.match(stated, /Rate:/, 'where the rate came from');
  assert.match(stated, /Work left:/, 'how much is left, and that it comes from the size tags');
  assert.match(stated, /Duty cycle: 33%/, 'the measured stretch, as a number');
  assert.match(stated, /one after another/, 'that concurrency is not modelled');
  assert.match(stated, /widens with FEWER completed phases/, "that the band is a sample count, not a variance");
});

test('the basis rides along, so a heuristic date cannot be read as a measured one', () => {
  const heuristic = etaFrom(rateFor([], []), { weight: 40_000, phases: 1 });
  assert.ok(heuristic);
  assert.equal(heuristic.basis, 'heuristic');
  const forecast = forecastFrom(heuristic, dutyCycle([]), NOW);
  assert.ok(forecast);
  assert.equal(forecast.basis, 'heuristic');
  assert.match(forecast.assumptions.join('\n'), /placeholder, not a forecast/);
});

test('no remaining work means no date — "finishes today" on a finished plan is a units error', () => {
  assert.equal(forecastFrom(null, dutyCycle(QUARTER_DUTY), NOW), null);
  assert.equal(etaFrom(rateFor(QUARTER_DUTY), { weight: 0, phases: 0 }), null);
});

test('the label is zone-free, so it is safe to print anywhere', () => {
  const forecast = forecastFrom(eta(), dutyCycle(QUARTER_DUTY), NOW);
  assert.ok(forecast);
  // A duration, never a date: the server does not know the reader's zone, and
  // a UTC date printed to somebody nine hours east names the wrong day.
  assert.match(forecast.label, /out$/);
  assert.doesNotMatch(forecast.label, /\d{4}-\d{2}-\d{2}/);
});

test('an unreadable clock is refused rather than turned into 1970', () => {
  assert.equal(forecastFrom(eta(), dutyCycle(QUARTER_DUTY), Number.NaN), null);
});
