/**
 * IF — one interval formatter, one rounding rule, three registers (#28 §3).
 *
 * The measured bug: 119 s rendered `1:59` in a stopwatch, `2m` in a table and
 * `1m 59s` in a sentence, because the table helper ROUNDED while the other two
 * floored. The registers stay; the rule becomes one.
 */
import './state-sandbox.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INTERVAL_REGISTERS, formatInterval, intervalParts } from '../shared/interval-format.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

test('IF-1 — 119,000 ms renders 1:59, 1m 59s and 1m 59s: one rule, three registers', () => {
  assert.deepEqual(INTERVAL_REGISTERS, ['clock', 'prose', 'table']);
  assert.equal(formatInterval(119_000, 'clock'), '1:59');
  assert.equal(formatInterval(119_000, 'prose'), '1m 59s');
  assert.equal(formatInterval(119_000, 'table'), '1m 59s');
});

test('IF-2 — the rule is floor: no register ever reads ahead of the stopwatch', () => {
  // 119.999 s is still 1:59 on a stopwatch, so it is 1m 59s everywhere.
  for (const register of INTERVAL_REGISTERS) {
    assert.equal(formatInterval(119_999, register), formatInterval(119_000, register), register);
  }
  // The table's old answer for 119 s was `2m` — rounded up past the clock.
  assert.notEqual(formatInterval(119_000, 'table'), '2m');
  // 89.6 s: the old table rounded to `90s`; floor reads 1m 29s.
  assert.equal(formatInterval(89_600, 'table'), '1m 29s');
  assert.equal(formatInterval(89_600, 'clock'), '1:29');
});

test('IF-3 — every register is a truncation of the same parts', () => {
  const samples = [0, 999, 1_000, 47_000, 59_999, 60_000, 12 * MIN + 3_000, 50 * MIN + 34_000,
    HOUR, HOUR + 4 * MIN, 2 * HOUR, 26 * HOUR + 3 * MIN + 9_000];
  for (const ms of samples) {
    const parts = intervalParts(ms)!;
    const clock = formatInterval(ms, 'clock');
    // The clock carries every part; the word registers may drop the tail, never change the head.
    const numbers = clock.split(':').map(Number);
    const [h, m, s] = numbers.length === 3 ? numbers : [0, ...numbers];
    assert.deepEqual([h, m, s], [parts.hours, parts.minutes, parts.seconds], `clock of ${ms}`);
    for (const register of ['prose', 'table'] as const) {
      const text = formatInterval(ms, register);
      const read = (unit: string): number | undefined => {
        const match = new RegExp(`(\\d+)${unit}`).exec(text);
        return match ? Number(match[1]) : undefined;
      };
      if (read('h') !== undefined) assert.equal(read('h'), parts.hours, `${register} hours of ${ms}`);
      if (read('m') !== undefined) assert.equal(read('m'), parts.minutes, `${register} minutes of ${ms}`);
      if (read('s') !== undefined) assert.equal(read('s'), parts.seconds, `${register} seconds of ${ms}`);
    }
  }
});

test('IF-4 — the registers differ only in precision and padding', () => {
  assert.equal(formatInterval(47_000, 'prose'), '47s');
  assert.equal(formatInterval(47_000, 'table'), '47s');
  assert.equal(formatInterval(12 * MIN + 3_000, 'prose'), '12m 03s');
  assert.equal(formatInterval(12 * MIN + 3_000, 'table'), '12m 3s');
  assert.equal(formatInterval(12 * MIN + 3_000, 'clock'), '12:03');
  assert.equal(formatInterval(10 * MIN, 'table'), '10m');
  assert.equal(formatInterval(HOUR + 4 * MIN, 'prose'), '1h 04m');
  assert.equal(formatInterval(HOUR + 4 * MIN, 'table'), '1h 4m');
  assert.equal(formatInterval(HOUR + 4 * MIN + 5_000, 'clock'), '1:04:05');
  assert.equal(formatInterval(2 * HOUR, 'table'), '2h');
});

test('IF-5 — an unmeasurable interval is the em-dash in words and 0:00 on the clock', () => {
  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    assert.equal(formatInterval(bad, 'prose'), '—');
    assert.equal(formatInterval(bad, 'table'), '—');
    assert.equal(formatInterval(bad, 'clock'), '0:00');
  }
  assert.equal(intervalParts(Number.NaN), null);
  // The default register is prose.
  assert.equal(formatInterval(119_000), '1m 59s');
});
