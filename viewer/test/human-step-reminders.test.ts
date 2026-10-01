/**
 * A person's turn (control-tower phase 43) — the reminder clock and the ends
 * of a step, on a fake clock.
 *
 *   HS-6  reminders fire at +15 m, +1 h, +6 h, then daily; quiet hours defer
 *         one to their end and a snooze is a floor under it; a person's act
 *         restarts the gap; a restart resumes the series and a console that was
 *         down for a day sends ONE reminder; nothing reminds once the step is
 *         `proven`, `cannot` or `dismissed`.
 *   HS-7  at the window's end the step reads `expired` — once — and becomes an
 *         errand; *I can't do this* settles it at once with the person's
 *         reason; neither loops and neither re-arms the series; a step that
 *         names no window has seven days.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  HumanStepLedger, nextReminderAt, outsideQuiet, sanitiseStep, tickHumanSteps, windowEndOf,
} = await import('../server/human-steps.ts');
const { HUMAN_STEP_DEFAULT_WINDOW_MS, REMINDER_SERIES_MS } = await import('../shared/human-step-model.js');
type HumanStep = import('../server/human-steps.ts').HumanStep;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** 2026-09-30T00:00:00Z — a midnight, so the UTC minute-of-day below reads the wall clock. */
const T0 = Date.parse('2026-09-30T00:00:00.000Z');
const utcMinute = (ms: number): number => Math.floor((ms % DAY) / MIN);

function world(windowMinutes?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-human-reminders-'));
  let now = T0;
  const clock = { get: () => now, set: (ms: number) => { now = ms; } };
  const ledger = new HumanStepLedger(join(dir, 'human-steps.ndjson'), () => new Date(now));
  const clean = sanitiseStep({
    kind: 'third-party-approval', title: 'Ask the org owner to approve the app', open_url: 'https://github.com/organizations/acme/settings/oauth_application_policy',
    proof: 'cmd:"gh api orgs/acme"', ...(windowMinutes ? { windowMinutes } : {}),
  }, 'session')!;
  const declared = ledger.declare({ slug: 'demo', phase: 4, birth: 'session', runId: 'run-1', clean: clean.step });
  ledger.move(declared.id, 'notified', { by: 'console', verb: 'notify', pushed: true });
  const reminded: number[] = [];
  const expired: HumanStep[] = [];
  const tick = (opts: { quiet?: { start: string; end: string } } = {}) => tickHumanSteps({
    ledger, now: now, minuteOf: utcMinute, ...(opts.quiet ? { quiet: opts.quiet } : {}),
    remind: (_step, n) => { reminded.push(n); return true; },
    expired: (step) => { expired.push(step); },
  });
  return {
    dir, clock, ledger, id: declared.id, reminded, expired, tick,
    step: () => ledger.get(declared.id)!,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Walk the clock to `until`, ticking every `stepMs`; answer the moments (after T0) a reminder fired. */
function walk(
  w: ReturnType<typeof world>, until: number, opts: { quiet?: { start: string; end: string }; stepMs?: number } = {},
): number[] {
  const fired: number[] = [];
  const stride = opts.stepMs ?? 5 * MIN;
  for (let at = w.clock.get() + stride; at <= until; at += stride) {
    w.clock.set(at);
    if (w.tick(opts).reminded.length) fired.push(at - T0);
  }
  return fired;
}

test('HS-6 — the series: +15 m, +1 h, +6 h, then daily, each gap after the last reminder', () => {
  const w = world(10 * 24 * 60);
  try {
    assert.deepEqual([...REMINDER_SERIES_MS], [15 * MIN, HOUR, 6 * HOUR, DAY], 'the shipped series');
    assert.equal(nextReminderAt(w.step()), T0 + 15 * MIN, 'the first is fifteen minutes after the notification');
    const fired = walk(w, T0 + 3 * DAY);
    const first = 15 * MIN;
    const second = first + HOUR;
    const third = second + 6 * HOUR;
    assert.deepEqual(fired, [first, second, third, third + DAY, third + 2 * DAY], 'then daily, the last gap repeating');
    assert.deepEqual(w.reminded, [1, 2, 3, 4, 5], 'each reminder knows its number');
    assert.equal(w.step().reminders, 5);
    assert.equal(w.step().state, 'notified', 'a reminder re-notifies');
    assert.equal(w.ledger.history(w.id).filter((m) => m.verb === 'remind').length, 5, 'every reminder is a ledger line');
  } finally { w.cleanup(); }
});

test('HS-6 — quiet hours defer a reminder to their end, never drop it', () => {
  const w = world(10 * 24 * 60);
  try {
    // Notified at 00:00: the first reminder would fall at 00:15, inside 22:00–07:00.
    const quiet = { start: '22:00', end: '07:00' };
    assert.equal(nextReminderAt(w.step(), { quiet, minuteOf: utcMinute }), T0 + 7 * HOUR, 'deferred to 07:00');
    const fired = walk(w, T0 + 7 * HOUR + 55 * MIN, { quiet });
    assert.deepEqual(fired, [7 * HOUR], 'one reminder, at the end of the quiet window');
    // A window that does not cross midnight, and a moment outside any window.
    assert.equal(outsideQuiet(T0 + 13 * HOUR, { start: '12:00', end: '14:00' }, utcMinute), T0 + 14 * HOUR);
    assert.equal(outsideQuiet(T0 + 15 * HOUR, { start: '12:00', end: '14:00' }, utcMinute), T0 + 15 * HOUR);
    assert.equal(outsideQuiet(T0 + 15 * HOUR, null, utcMinute), T0 + 15 * HOUR, 'no quiet hours, no deferral');
  } finally { w.cleanup(); }
});

test('HS-6 — a snooze is a floor under the next reminder; an open restarts the gap', () => {
  const w = world(10 * 24 * 60);
  try {
    w.clock.set(T0 + 5 * MIN);
    w.ledger.move(w.id, 'notified', { by: 'operator', verb: 'snooze', snoozeUntil: new Date(T0 + 2 * HOUR).toISOString() });
    assert.equal(nextReminderAt(w.step()), T0 + 2 * HOUR, 'not before the snooze ends');
    const fired = walk(w, T0 + 2 * HOUR + 30 * MIN);
    assert.deepEqual(fired, [2 * HOUR], 'the snoozed reminder fires when the snooze ends');
    // A person opens it ten minutes later: the next gap (1 h) counts from the open.
    w.clock.set(T0 + 2 * HOUR + 40 * MIN);
    w.ledger.move(w.id, 'opened', { by: 'operator', verb: 'open', where: 'here' });
    assert.equal(w.step().opened, 1);
    assert.equal(nextReminderAt(w.step()), T0 + 3 * HOUR + 40 * MIN, 'the gap restarts after the person\'s act');
    // A snooze shorter than the gap does not bring the reminder forward.
    w.ledger.move(w.id, 'notified', { by: 'operator', verb: 'snooze', snoozeUntil: new Date(T0 + 2 * HOUR + 50 * MIN).toISOString() });
    assert.equal(nextReminderAt(w.step()), T0 + 3 * HOUR + 40 * MIN);
  } finally { w.cleanup(); }
});

test('HS-6 — a restart resumes the series, and a day of downtime sends ONE reminder', () => {
  const w = world(10 * 24 * 60);
  try {
    walk(w, T0 + 20 * MIN);
    assert.deepEqual(w.reminded, [1]);
    // The console was down from 00:20 to 06:00 the next day: one reminder on the
    // first pass back, then the gap after it — never a burst of the missed ones.
    w.clock.set(T0 + DAY + 6 * HOUR);
    const fresh = new HumanStepLedger(w.ledger.file, () => new Date(w.clock.get()));
    const pass = tickHumanSteps({ ledger: fresh, now: w.clock.get(), remind: (_s, n) => { w.reminded.push(n); return true; } });
    assert.deepEqual(pass.reminded, [w.id]);
    assert.deepEqual(w.reminded, [1, 2], 'the second reminder, numbered from the ledger');
    const again = tickHumanSteps({ ledger: fresh, now: w.clock.get() + MIN, remind: () => true });
    assert.deepEqual(again.reminded, [], 'and not again a minute later');
    assert.equal(nextReminderAt(fresh.get(w.id)!), T0 + DAY + 12 * HOUR, 'the third gap (6 h) counts from the second');
  } finally { w.cleanup(); }
});

test('HS-6 — nothing reminds once the step is proven, cannot or dismissed', () => {
  for (const settle of ['proven', 'cannot', 'dismissed'] as const) {
    const w = world(10 * 24 * 60);
    try {
      w.ledger.move(w.id, settle, { by: 'operator', verb: settle === 'proven' ? 'prove' : settle === 'cannot' ? 'cannot' : 'dismiss' });
      assert.equal(nextReminderAt(w.step()), null, `${settle}: no next reminder`);
      assert.deepEqual(walk(w, T0 + 3 * DAY), [], `${settle}: three days, no reminder`);
      assert.deepEqual(w.expired, [], `${settle}: and no expiry either`);
    } finally { w.cleanup(); }
  }
});

test('HS-7 — the window closes: expired once, an errand, never reminded again', () => {
  const w = world(90);
  try {
    const end = T0 + 90 * MIN;
    assert.equal(windowEndOf(w.step()), end);
    const fired = walk(w, T0 + 5 * HOUR);
    assert.deepEqual(fired, [15 * MIN, 75 * MIN], 'the two reminders the window had room for');
    assert.equal(w.step().state, 'expired');
    assert.equal(w.expired.length, 1, 'the errand is raised once');
    assert.equal(w.expired[0].id, w.id);
    assert.match(String(w.step().note), /window closed at 2026-09-30T01:30:00\.000Z with nothing proven/);
    const moves = w.ledger.history(w.id);
    assert.equal(moves.filter((m) => m.verb === 'expire').length, 1, 'one expiry line in the ledger');
    assert.equal(moves[moves.length - 1].verb, 'expire', 'and nothing after it');
    // A move out of `expired` is refused: the state machine holds it.
    const again = w.ledger.move(w.id, 'notified', { by: 'console', verb: 'remind' });
    assert.ok('refused' in again);
  } finally { w.cleanup(); }
});

test('HS-7 — I can\'t do this settles the step at once, with the reason, and re-arms nothing', () => {
  const w = world(10 * 24 * 60);
  try {
    w.clock.set(T0 + 3 * MIN);
    const moved = w.ledger.move(w.id, 'cannot', { by: 'operator', verb: 'cannot', note: 'I am not an owner of the acme org' });
    assert.ok(!('refused' in moved));
    assert.equal(w.step().state, 'cannot');
    assert.equal(w.step().note, 'I am not an owner of the acme org', 'the person\'s reason rides the step');
    assert.deepEqual(walk(w, T0 + 11 * DAY), [], 'no reminder, and past the window no expiry either');
    assert.deepEqual(w.expired, []);
  } finally { w.cleanup(); }
});

test('HS-7 — a step that names no window has seven days, then expires', () => {
  const w = world();
  try {
    assert.equal(HUMAN_STEP_DEFAULT_WINDOW_MS, 7 * DAY);
    assert.equal(w.step().until, undefined, 'the ledger keeps what the declaration said');
    assert.equal(windowEndOf(w.step()), T0 + 7 * DAY, 'the window it has is seven days');
    w.clock.set(T0 + 7 * DAY);
    const pass = w.tick();
    assert.deepEqual(pass.expired, [w.id]);
    assert.equal(w.step().state, 'expired');
  } finally { w.cleanup(); }
});

test('HS-6 — a withdrawn step (its phase closed) is dismissed and never reminded', () => {
  const w = world(10 * 24 * 60);
  try {
    w.clock.set(T0 + HOUR);
    const pass = tickHumanSteps({ ledger: w.ledger, now: w.clock.get(), remind: () => true, withdrawn: () => 'the phase closed' });
    assert.deepEqual(pass.dismissed, [w.id]);
    assert.equal(w.step().state, 'dismissed');
    assert.equal(w.step().note, 'the phase closed');
  } finally { w.cleanup(); }
});
