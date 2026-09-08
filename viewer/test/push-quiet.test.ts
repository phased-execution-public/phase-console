/**
 * Delivery quiet hours, and the corrective `replace` opt (parallel-repaint P2).
 *
 * Quiet hours are suppression at the LAST leg: the record-first choke point has
 * already written the inbox row before push is asked, so what is pinned here is
 * narrower and sharper — inside the window a device is not sent to, the ledger
 * says `quiet` for it rather than nothing, urgent traffic breaks through unless
 * the device said otherwise, and a fan-out where every device slept is not the
 * "reached nobody" alarm.
 *
 * `replace` exists because the two corrective pushes (`retractHalt`,
 * `retractStall`) ride the alarm's own tag ON PURPOSE, so the service worker
 * replaces the displayed card — and the 5-second same-tag dedupe read that as a
 * re-render and swallowed the all-clear whenever a subject resolved fast.
 */

import './state-sandbox.ts';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let push: typeof import('../server/push/index.ts');
let vapid: typeof import('../server/push/vapid.ts');

before(async () => {
  push = await import('../server/push/index.ts');
  vapid = await import('../server/push/vapid.ts');
});

/** A subscription shaped like a browser's: a P-256 point and a 16-byte auth secret. */
function subscription(i: number) {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return {
    endpoint: `https://push.example.com/sub/quiet-${i}-${randomBytes(4).toString('hex')}`,
    keys: { p256dh: point.toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}

/** A register holding exactly these devices — the file is shared by every `new Push()`. */
function fresh(labels: string[]) {
  const register = new push.Push(['you@example.com']);
  for (const d of register.list()) register.unsubscribe(d.id);
  const devices = labels.map((label, i) => {
    const d = register.subscribe(subscription(i), undefined, label);
    assert.ok(!('error' in d), `subscribing ${label} must work`);
    return d;
  });
  return { register, devices };
}

/** Point `deliver`'s fetch at a canned status and count the calls. */
function withFetch(status = 201) {
  const real = globalThis.fetch;
  let calls = 0;
  (globalThis as { fetch: unknown }).fetch = async () => { calls += 1; return new Response(null, { status }); };
  return { calls: () => calls, restore: () => { (globalThis as { fetch: unknown }).fetch = real; } };
}

/** `announce` is deliberately not awaited; give the fan-out time to land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise((r) => { setTimeout(r, 2); });
}

/** A local-clock instant at HH:MM today — the window math reads local hours, so this is TZ-proof. */
function at(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

const NIGHT = { start: '22:00', end: '08:00', allowUrgent: true };

/* ------------------------------------------------------------------ *
 * The shape and the clock
 * ------------------------------------------------------------------ */

test('parseQuietHours: null clears, a good window keeps its flag, a bad shape refuses', () => {
  assert.equal(push.parseQuietHours(null), null);
  assert.equal(push.parseQuietHours(undefined), null);
  assert.deepEqual(push.parseQuietHours({ start: '22:00', end: '08:00' }), NIGHT, 'allowUrgent defaults ON');
  assert.deepEqual(push.parseQuietHours({ start: '09:00', end: '17:30', allowUrgent: false }),
    { start: '09:00', end: '17:30', allowUrgent: false });
  for (const bad of [{ start: '25:00', end: '08:00' }, { start: '22:00' }, { start: '22:00', end: '8:00' }, 'night', 42]) {
    const parsed = push.parseQuietHours(bad);
    assert.ok(parsed && 'error' in parsed, `${JSON.stringify(bad)} must be refused, not coerced`);
  }
  const same = push.parseQuietHours({ start: '22:00', end: '22:00' });
  assert.ok(same && 'error' in same && /same minute/.test(same.error));
});

test('inQuietHours: a window that crosses midnight, one that does not, half-open at both ends', () => {
  // The normal case: the night.
  assert.equal(push.inQuietHours(NIGHT, at('23:30')), true);
  assert.equal(push.inQuietHours(NIGHT, at('03:00')), true);
  assert.equal(push.inQuietHours(NIGHT, at('22:00')), true, 'the start minute is inside');
  assert.equal(push.inQuietHours(NIGHT, at('08:00')), false, 'the end minute is outside — half-open');
  assert.equal(push.inQuietHours(NIGHT, at('21:59')), false);
  assert.equal(push.inQuietHours(NIGHT, at('12:00')), false);
  // A daytime window, for an operator who sleeps by day.
  const day = { start: '09:00', end: '17:00', allowUrgent: true };
  assert.equal(push.inQuietHours(day, at('12:00')), true);
  assert.equal(push.inQuietHours(day, at('08:59')), false);
  assert.equal(push.inQuietHours(day, at('17:00')), false);
  assert.equal(push.inQuietHours(undefined, at('03:00')), false, 'absent means off');
});

/* ------------------------------------------------------------------ *
 * The fan-out
 * ------------------------------------------------------------------ */

test('inside the window a quiet device is held, the ledger says so, and nobody is alarmed', async () => {
  const { register, devices } = fresh(['phone', 'laptop']);
  register.setQuiet(devices[0].id, NIGHT);
  const reports: { label: string; outcome: string }[] = [];
  let undelivered = 0;
  register.onUndelivered = () => { undelivered += 1; };
  const fetch = withFetch(201);
  try {
    register.announce('phase', { title: 'P3 done', body: 'b', tag: 'q-1', url: '/' }, at('02:00'),
      (report) => { reports.push({ label: report.label, outcome: report.outcome }); });
    await settle();
  } finally {
    fetch.restore();
  }
  assert.equal(fetch.calls(), 1, 'only the laptop was sent to');
  assert.deepEqual(reports.sort((a, b) => a.label.localeCompare(b.label)), [
    { label: 'laptop', outcome: 'sent' },
    { label: 'phone', outcome: 'quiet' },
  ], 'the held device is on the ledger as quiet, not missing');
  assert.equal(undelivered, 0);
});

test('a fan-out where every device slept is not the "reached nobody" alarm', async () => {
  const { register, devices } = fresh(['phone']);
  register.setQuiet(devices[0].id, NIGHT);
  let undelivered = 0;
  register.onUndelivered = () => { undelivered += 1; };
  const fetch = withFetch(201);
  try {
    register.announce('phase', { title: 'P3 done', body: 'b', tag: 'q-2', url: '/' }, at('03:00'));
    await settle();
  } finally {
    fetch.restore();
  }
  assert.equal(fetch.calls(), 0);
  assert.equal(undelivered, 0, 'quiet is a decision, not an outage');
});

test('urgent breaks through by default, and is held when the device says so', async () => {
  const { register, devices } = fresh(['phone']);
  register.setQuiet(devices[0].id, NIGHT);
  const fetch = withFetch(201);
  try {
    // `approval` is urgent by catalogue.
    register.announce('approval', { title: 'Permission needed', body: 'b', tag: 'q-3a', url: '/' }, at('03:00'));
    await settle();
    assert.equal(fetch.calls(), 1, 'an approval at 3am still wakes the phone');
    // The per-announcement override counts as urgent too — the escalated stall.
    register.announce('stalled', { title: 'Still stalled', body: 'b', tag: 'q-3b', url: '/' }, at('03:00'),
      undefined, { urgent: true });
    await settle();
    assert.equal(fetch.calls(), 2);
    // And the device may refuse even those.
    register.setQuiet(devices[0].id, { ...NIGHT, allowUrgent: false });
    const held: string[] = [];
    register.announce('approval', { title: 'Permission needed', body: 'b', tag: 'q-3c', url: '/' }, at('03:00'),
      (report) => { held.push(report.outcome); });
    await settle();
    assert.equal(fetch.calls(), 2, 'nothing more was sent');
    assert.deepEqual(held, ['quiet']);
  } finally {
    fetch.restore();
  }
});

test('outside the window the device is sent to as before', async () => {
  const { register, devices } = fresh(['phone']);
  register.setQuiet(devices[0].id, NIGHT);
  const fetch = withFetch(201);
  try {
    register.announce('phase', { title: 'P3 done', body: 'b', tag: 'q-4', url: '/' }, at('12:00'));
    await settle();
  } finally {
    fetch.restore();
  }
  assert.equal(fetch.calls(), 1);
});

test('`replace` sends a same-tag corrective the dedupe would otherwise swallow', async () => {
  const { register } = fresh(['phone']);
  const fetch = withFetch(201);
  try {
    const now = at('12:00');
    register.announce('halted', { title: 'run halted', body: 'b', tag: 'q-5', url: '/' }, now);
    // Two seconds later, without the opt: a re-render, dropped — the old rule.
    register.announce('halted', { title: 'run halted', body: 'b', tag: 'q-5', url: '/' }, now + 2_000);
    await settle();
    assert.equal(fetch.calls(), 1, 'same tag inside five seconds is one send');
    // The corrective: same tag, different message, must go.
    register.announce('halted', { title: 'resolved on its own', body: 'b', tag: 'q-5', url: '/' }, now + 3_000,
      undefined, { urgent: false, replace: true });
    await settle();
    assert.equal(fetch.calls(), 2, 'the all-clear rides the alarm\'s tag and is sent anyway');
  } finally {
    fetch.restore();
  }
});

/* ------------------------------------------------------------------ *
 * The register
 * ------------------------------------------------------------------ */

test('setQuiet sets, clears, refuses a bad shape, and survives a restart', () => {
  const { register, devices } = fresh(['phone']);
  const set = register.setQuiet(devices[0].id, { start: '23:00', end: '07:00' });
  assert.ok(set && !('error' in set));
  assert.deepEqual(set.quiet, { start: '23:00', end: '07:00', allowUrgent: true });
  assert.deepEqual(register.list()[0].quiet, { start: '23:00', end: '07:00', allowUrgent: true },
    'the public row carries it — the card renders from this');

  const bad = register.setQuiet(devices[0].id, { start: 'late', end: '07:00' });
  assert.ok(bad && 'error' in bad, 'a bad shape is a refusal, and the stored window is untouched');
  assert.deepEqual(register.list()[0].quiet, { start: '23:00', end: '07:00', allowUrgent: true });

  assert.equal(register.setQuiet('no-such-device', NIGHT), null);

  const again = new push.Push(['you@example.com']);
  assert.deepEqual(again.list()[0]?.quiet, { start: '23:00', end: '07:00', allowUrgent: true },
    'persisted with the device, like its categories');

  const cleared = register.setQuiet(devices[0].id, null);
  assert.ok(cleared && !('error' in cleared) && cleared.quiet === undefined, 'null clears');
});

test('a half-written window on disk is dropped on load rather than half-honoured', () => {
  const { devices } = fresh(['phone']);
  assert.equal(devices.length, 1);
  const file = join(vapid.PUSH_DIR, 'subscriptions.json');
  const rows = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[];
  rows[0].quiet = { start: '22:00' };
  writeFileSync(file, JSON.stringify(rows), 'utf8');
  const reloaded = new push.Push(['you@example.com']);
  assert.equal(reloaded.list()[0].quiet, undefined, 'quiet hours nobody asked for must not exist');
});

/* ------------------------------------------------------------------ *
 * The 15-strike budget (register N8)
 * ------------------------------------------------------------------ */

test('a push that never reached the service does not count toward dropping the device', async () => {
  const { register, devices } = fresh(['phone']);
  const real = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async () => { throw new TypeError('fetch failed: ENOTFOUND'); };
  try {
    for (let i = 0; i < 16; i++) {
      register.announce('phase', { title: 'P1 done', body: 'b', tag: `b1-${i}`, url: '/' }, at('12:00') + i * 10_000);
    }
    await settle();
  } finally {
    (globalThis as { fetch: unknown }).fetch = real;
  }
  assert.equal(register.list().length, 1, 'sixteen network failures did not unsubscribe the phone');
  assert.equal(register.list()[0].failures, 0, 'and burned none of its budget');
  assert.equal(register.list()[0].id, devices[0].id);

  // A real rejection from the service still counts.
  const fetch = withFetch(500);
  try {
    register.announce('phase', { title: 'P1 done', body: 'b', tag: 'b1-real', url: '/' }, at('13:00'));
    await settle();
  } finally {
    fetch.restore();
  }
  assert.equal(register.list()[0].failures, 1);
});

test('an encrypt failure IS the subscription\'s fault and counts toward the drop', async () => {
  const { register } = fresh([]);
  // 65 bytes that pass the length check and are not a point on the curve.
  const bogus = Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url');
  const device = register.subscribe({
    endpoint: `https://push.example.com/sub/bogus-${randomBytes(4).toString('hex')}`,
    keys: { p256dh: bogus, auth: randomBytes(16).toString('base64url') },
  }, undefined, 'bad-key');
  assert.ok(!('error' in device));
  const fetch = withFetch(201);
  try {
    register.announce('phase', { title: 'P1 done', body: 'b', tag: 'enc-1', url: '/' }, at('12:00'));
    await settle();
  } finally {
    fetch.restore();
  }
  assert.equal(fetch.calls(), 0, 'nothing reached the service — encryption failed first');
  assert.equal(register.list()[0].failures, 1, 'and that counts: a key that cannot be encrypted to never will be');
});
