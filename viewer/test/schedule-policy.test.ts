/**
 * The boarding schedule, as a pure function of a policy and a clock.
 *
 * Everything here is date arithmetic with an injected timestamp — no scheduler,
 * no console, no timers — which is the point of keeping the rules in
 * `shared/schedule-policy.js`: the thing that decides whether a run may start
 * tonight is testable without starting anything.
 *
 * Local time throughout, deliberately (the console is a localhost app and its
 * clock IS the operator's). `new Date(y, m, d, h, m)` is local, so these dates
 * mean what they read as on whatever machine runs them.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  cronField, cronMinutesOf, describeOpening, formatHhMm, nextOpening, openAt, parseCron,
  parseHhMm, policyStated, sanitiseSchedule, scheduleState, windowCovers, SCAN_DAYS,
} = await import('../shared/schedule-policy.js');

/** 2026-08-24 is a Monday. Every date below is anchored to that week. */
const at = (day: number, hour: number, minute = 0): number =>
  new Date(2026, 7, day, hour, minute, 0, 0).getTime();

const MON = 24, TUE = 25, FRI = 21, SAT = 22, SUN = 23;

/* ---------------------------------------------------------------- *
 * Times
 * ---------------------------------------------------------------- */

test('HH:MM parses, round-trips, and refuses what is not a time', () => {
  assert.equal(parseHhMm('09:00'), 540);
  assert.equal(parseHhMm('9:05'), 545);
  assert.equal(parseHhMm('23:59'), 1439);
  assert.equal(parseHhMm('00:00'), 0);
  for (const bad of ['24:00', '09:60', '9', '0900', '', 'nine', null, 9]) {
    assert.equal(parseHhMm(bad as never), null, `${String(bad)} is not a time`);
  }
  assert.equal(formatHhMm(540), '09:00');
  assert.equal(formatHhMm(0), '00:00');
  // Wrapping, so a caller doing arithmetic on minutes cannot produce `24:00`.
  assert.equal(formatHhMm(1440), '00:00');
  assert.equal(formatHhMm(-60), '23:00');
});

/* ---------------------------------------------------------------- *
 * Windows
 * ---------------------------------------------------------------- */

test('a plain window is open between its ends and closed outside them', () => {
  const w = { from: '09:00', to: '18:00' };
  assert.equal(windowCovers(w, new Date(at(MON, 9, 0))), true, 'inclusive at `from`');
  assert.equal(windowCovers(w, new Date(at(MON, 17, 59))), true);
  assert.equal(windowCovers(w, new Date(at(MON, 18, 0))), false, 'exclusive at `to`');
  assert.equal(windowCovers(w, new Date(at(MON, 8, 59))), false);
});

test('`days` restricts which day a window may START on', () => {
  const weekdays = { days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' };
  assert.equal(windowCovers(weekdays, new Date(at(MON, 10))), true);
  assert.equal(windowCovers(weekdays, new Date(at(SAT, 10))), false);
  assert.equal(windowCovers(weekdays, new Date(at(SUN, 10))), false);
});

test('a window that wraps midnight belongs to the day it STARTED on', () => {
  // "Friday night" — 22:00 Friday through 06:00 Saturday, and nothing else.
  const fridayNight = { days: [5], from: '22:00', to: '06:00' };
  assert.equal(windowCovers(fridayNight, new Date(at(FRI, 23))), true, 'Friday 23:00');
  assert.equal(windowCovers(fridayNight, new Date(at(SAT, 2))), true, 'Saturday 02:00 is Friday night');
  assert.equal(windowCovers(fridayNight, new Date(at(FRI, 2))), false, 'Friday 02:00 is THURSDAY night');
  assert.equal(windowCovers(fridayNight, new Date(at(SAT, 23))), false, 'Saturday night is not Friday night');
  assert.equal(windowCovers(fridayNight, new Date(at(SAT, 6))), false, 'exclusive at `to`');
});

test('an unparseable window covers nothing — never everything', () => {
  for (const bad of [{ from: '9', to: '18:00' }, { from: '09:00', to: 'later' }, {}, null]) {
    assert.equal(windowCovers(bad as never, new Date(at(MON, 10))), false);
  }
});

/* ---------------------------------------------------------------- *
 * cron
 * ---------------------------------------------------------------- */

test('cron fields parse the forms a crontab actually contains', () => {
  assert.deepEqual([...cronField('*', 0)!].length, 60);
  assert.deepEqual([...cronField('5', 0)!], [5]);
  assert.deepEqual([...cronField('1-3', 0)!], [1, 2, 3]);
  assert.deepEqual([...cronField('*/15', 0)!], [0, 15, 30, 45]);
  assert.deepEqual([...cronField('0-30/10', 0)!], [0, 10, 20, 30]);
  assert.deepEqual([...cronField('1,5,9', 0)!], [1, 5, 9]);
  assert.deepEqual([...cronField('50/5', 0)!], [50, 55], 'a bare step starts at the value');
});

test('a malformed cron field is null, so a typo never widens a window', () => {
  assert.equal(cronField('60', 0), null, 'out of range high');
  assert.equal(cronField('-1', 0), null);
  assert.equal(cronField('5-1', 0), null, 'inverted range');
  assert.equal(cronField('*/0', 0), null, 'zero step');
  assert.equal(cronField('', 0), null);
  assert.equal(cronField('x', 0), null);
  assert.equal(cronField('24', 1), null, 'hours stop at 23');
  assert.equal(cronField('0', 2), null, 'days of month start at 1');
  assert.equal(parseCron('0 9 * *'), null, 'four fields is not an expression');
  assert.equal(parseCron('0 9 * * 1-5 extra'), null, 'six is not either');
  assert.equal(parseCron('0 99 * * *'), null);
});

test('a cron opening lasts `cronMinutes` and then closes', () => {
  const policy = { enabled: true, cron: ['0 9 * * 1-5'], cronMinutes: 120 };
  assert.equal(openAt(policy, at(MON, 9, 0)), true, 'at the fire');
  assert.equal(openAt(policy, at(MON, 10, 59)), true, 'inside the opening');
  assert.equal(openAt(policy, at(MON, 11, 0)), false, 'the opening has lapsed');
  assert.equal(openAt(policy, at(MON, 8, 59)), false, 'before it');
  assert.equal(openAt(policy, at(SAT, 9, 30)), false, 'weekend — the expression does not fire');
});

test('cronMinutes coerces: absent, zero, negative and non-numbers all take the default', () => {
  assert.equal(cronMinutesOf({}), 60);
  assert.equal(cronMinutesOf({ cronMinutes: 0 }), 60);
  assert.equal(cronMinutesOf({ cronMinutes: -30 }), 60);
  assert.equal(cronMinutesOf({ cronMinutes: '30' } as never), 60);
  assert.equal(cronMinutesOf({ cronMinutes: Number.NaN }), 60);
  assert.equal(cronMinutesOf({ cronMinutes: 30 }), 30);
});

test('day-of-month and day-of-week are a UNION when both are restricted — Vixie cron`s rule', () => {
  // 2026-08-01 is a Saturday; the 3rd is a Monday.
  const policy = { enabled: true, cron: ['0 0 1 * 1'], cronMinutes: 1 };
  assert.equal(openAt(policy, new Date(2026, 7, 1, 0, 0).getTime()), true, 'the 1st, a Saturday');
  assert.equal(openAt(policy, new Date(2026, 7, 3, 0, 0).getTime()), true, 'a Monday that is not the 1st');
  assert.equal(openAt(policy, new Date(2026, 7, 2, 0, 0).getTime()), false, 'neither');
});

/* ---------------------------------------------------------------- *
 * Composition — the order the three rules apply in
 * ---------------------------------------------------------------- */

test('no policy, or a policy that says nothing, boards at every hour', () => {
  assert.equal(policyStated(undefined), false);
  assert.equal(policyStated({ enabled: true }), false, 'enabled with no rules is not a schedule');
  assert.equal(policyStated({ windows: [{ from: '09:00', to: '18:00' }] }), false, 'rules without `enabled` are off');
  assert.equal(openAt(undefined as never, at(MON, 3)), true);
  assert.equal(openAt({ enabled: false, windows: [{ from: '09:00', to: '18:00' }] }, at(MON, 3)), true);
  assert.deepEqual(scheduleState(undefined as never, at(MON, 3)), { open: true, opensAt: at(MON, 3), reason: null });
});

test('quiet hours BEAT a window that would otherwise be open', () => {
  const policy = {
    enabled: true,
    windows: [{ from: '00:00', to: '23:59' }],
    quiet: [{ from: '22:00', to: '07:00' }],
  };
  assert.equal(openAt(policy, at(MON, 12)), true);
  assert.equal(openAt(policy, at(MON, 23)), false, 'inside quiet hours');
  assert.equal(openAt(policy, at(TUE, 3)), false, 'still quiet after midnight');
  assert.equal(openAt(policy, at(TUE, 7)), true, 'quiet hours end');
});

test('quiet hours alone are a deny-list: everything else stays open', () => {
  const policy = { enabled: true, quiet: [{ from: '22:00', to: '07:00' }] };
  assert.equal(openAt(policy, at(MON, 14)), true);
  assert.equal(openAt(policy, at(MON, 23)), false);
});

test('windows and cron are both allow-lists and either one opens the door', () => {
  const policy = {
    enabled: true,
    windows: [{ days: [1], from: '09:00', to: '10:00' }],
    cron: ['0 20 * * 2'],
    cronMinutes: 60,
  };
  assert.equal(openAt(policy, at(MON, 9, 30)), true, 'the window');
  assert.equal(openAt(policy, at(TUE, 20, 30)), true, 'the cron opening');
  assert.equal(openAt(policy, at(TUE, 9, 30)), false, 'neither');
});

/* ---------------------------------------------------------------- *
 * When it opens
 * ---------------------------------------------------------------- */

test('the next opening is found, and it is the NEXT one', () => {
  const policy = { enabled: true, windows: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }] };
  assert.equal(nextOpening(policy, at(MON, 20)), at(TUE, 9), 'Monday evening → Tuesday morning');
  assert.equal(nextOpening(policy, at(SAT, 10)), at(MON, 9), 'Saturday → Monday, not Sunday');
  assert.equal(nextOpening(policy, at(MON, 10)), at(MON, 10), 'already open: now');
});

test('an opening further out than the scan horizon answers null, not a wrong time', () => {
  // 29 February exists only in a leap year; 2027 is not one, so this expression
  // has no opening at all in the scan horizon — or in the year.
  const policy = { enabled: true, cron: ['0 3 30 2 *'], cronMinutes: 60 };
  assert.equal(nextOpening(policy, at(MON, 12)), null);
  const state = scheduleState(policy, at(MON, 12));
  assert.equal(state.open, false);
  assert.equal(state.opensAt, null);
  assert.match(state.reason!, new RegExp(`next ${SCAN_DAYS} days`));
});

test('the reason names the DAY whenever the opening is not today', () => {
  assert.equal(describeOpening(at(MON, 14), at(MON, 9)), '14:00');
  assert.equal(describeOpening(at(TUE, 9), at(MON, 22)), 'tomorrow 09:00');
  assert.equal(describeOpening(at(FRI + 7, 9), at(MON, 22)), 'Friday 09:00');
  assert.match(describeOpening(at(MON + 9, 9), at(MON, 22)), /^Wednesday 09:00, 9 days from now$/);
});

test('the state says which rule closed the door, and when it opens', () => {
  const policy = {
    enabled: true,
    windows: [{ from: '00:00', to: '23:59' }],
    quiet: [{ from: '22:00', to: '07:00' }],
  };
  const closed = scheduleState(policy, at(MON, 23));
  assert.equal(closed.open, false);
  assert.equal(closed.opensAt, at(TUE, 7));
  assert.match(closed.reason!, /^quiet hours — boarding opens tomorrow 07:00$/);

  const windowed = scheduleState({ enabled: true, windows: [{ from: '09:00', to: '18:00' }] }, at(MON, 20));
  assert.match(windowed.reason!, /^the boarding schedule — boarding opens tomorrow 09:00$/);
});

/* ---------------------------------------------------------------- *
 * Coercion
 * ---------------------------------------------------------------- */

test('sanitiseSchedule DROPS what it cannot read rather than defaulting it open', () => {
  const clean = sanitiseSchedule({
    enabled: true,
    windows: [
      { days: [1, 2], from: '9:00', to: '18:00' },
      { from: 'noon', to: '18:00' },
      'not an object',
      { days: [1, 9, 'x', 1], from: '20:00', to: '21:00' },
    ],
    quiet: [{ from: '22:00', to: '07:00' }],
    cron: ['0 9 * * 1-5', '0 99 * * *', 42, '  0   20  *  *  * '],
    cronMinutes: -5,
  });
  assert.deepEqual(clean.windows, [
    { days: [1, 2], from: '09:00', to: '18:00' },
    { days: [1], from: '20:00', to: '21:00' },
  ], 'the two readable windows, times normalised and days deduped/filtered');
  assert.deepEqual(clean.quiet, [{ from: '22:00', to: '07:00' }]);
  assert.deepEqual(clean.cron, ['0 9 * * 1-5', '0 20 * * *'], 'whitespace normalised, the invalid one dropped');
  assert.equal(clean.cronMinutes, 60, 'a negative life takes the default');
  assert.equal(clean.enabled, true);
});

test('sanitiseSchedule of nothing is a policy that boards at every hour', () => {
  const empty = sanitiseSchedule(undefined);
  assert.deepEqual(empty, { enabled: false, windows: [], quiet: [], cron: [], cronMinutes: 60 });
  assert.equal(policyStated(empty), false);
  assert.equal(openAt(empty, at(MON, 3)), true);
  // `enabled` is the exact word, like `mcpPolicy: 'require'` — a truthy string
  // in config.json must not turn somebody's overnight run off.
  assert.equal(sanitiseSchedule({ enabled: 'yes' }).enabled, false);
});
