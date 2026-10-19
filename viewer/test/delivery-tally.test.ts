/**
 * The delivery tally and the push-broken rows (one-pool phase 18).
 *
 * #314: `tallyDelivery` added `row.device` for every delivery row, and a
 * no-device report is written with device `''`, so a console with nothing
 * subscribed reported `devices: 1`. A placeholder row (`no-device`,
 * `skipped`) names no device and is counted as none.
 *
 * #280: a `push-broken` row raised by one undelivered notification (or a
 * rejection streak) had no id, so nothing could withdraw it, and `doctor`
 * stayed blocking until a restart however the channel was repaired. The rows
 * have ids now, and a delivered push or a device change withdraws them.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tallyDelivery } from '../server/debug/index.ts';
import { DELIVERY_PLACEHOLDERS, isDeliveryPlaceholder } from '../shared/ops-vocab.js';
import { ServiceBase } from '../server/service-base.ts';
import { DELIVERY_ISSUE_ID, PUSH_REJECT_ISSUE_PREFIX, PUSH_UNDELIVERED_ISSUE_ID } from '../server/env-doctor.ts';
import type { NotificationRecord } from '../server/notifications.ts';

const record = (delivery: { device: string; outcome: string; label?: string }[]): NotificationRecord =>
  ({ id: 'n', category: 'halted', title: 't', at: new Date().toISOString(), delivery }) as unknown as NotificationRecord;

test('#314: the two placeholders are the vocabulary’s, and nothing else is one', () => {
  assert.deepEqual([...DELIVERY_PLACEHOLDERS].sort(), ['no-device', 'skipped']);
  assert.equal(isDeliveryPlaceholder('no-device'), true);
  assert.equal(isDeliveryPlaceholder('skipped'), true);
  for (const outcome of ['sent', 'quiet', 'failed', 'gone', 'throttled', '', undefined]) {
    assert.equal(isDeliveryPlaceholder(outcome), false, String(outcome));
  }
});

test('#314: a console with no device tallies no device — seven no-device announcements are seven undelivered and zero devices', () => {
  const records = Array.from({ length: 7 }, () => record([{ device: '', outcome: 'no-device' }]));
  assert.deepEqual(tallyDelivery(records), {
    outcomes: { 'no-device': 7 }, undelivered: 7, announcements: 7, devices: 0,
  });
});

test('#314: a skipped row is no device either, and a real device is counted once however often it is named', () => {
  const tally = tallyDelivery([
    record([{ device: 'd1', outcome: 'sent' }, { device: 'd2', outcome: 'failed' }]),
    record([{ device: 'd1', outcome: 'quiet' }]),
    record([{ device: '', outcome: 'skipped' }]),
    record([{ device: 'console', outcome: 'skipped' }]),
  ]);
  assert.equal(tally.devices, 2, 'd1 and d2 — never the placeholders');
  assert.equal(tally.announcements, 4);
  assert.equal(tally.undelivered, 2, 'the two placeholder announcements reached nobody; the all-quiet one is held');
  assert.deepEqual(tally.outcomes, { sent: 1, failed: 1, quiet: 1, skipped: 2 });
});

/** The withdrawal, run against just the environment it edits. */
function withdraw(issues: { id?: string; kind: string; detail: string; fix: string }[], cause: 'delivered' | 'devices-changed', service?: string) {
  const self = { environment: { issues } };
  ServiceBase.prototype.withdrawPushHealth.call(self as unknown as ServiceBase, cause, service);
  return self.environment.issues.map((issue) => issue.id ?? issue.kind);
}

const rows = () => [
  { id: DELIVERY_ISSUE_ID, kind: 'push-broken', detail: 'no device', fix: 'subscribe' },
  { id: PUSH_UNDELIVERED_ISSUE_ID, kind: 'push-broken', detail: 'reached none', fix: 'send a test' },
  { id: `${PUSH_REJECT_ISSUE_PREFIX}https://fcm.googleapis.com|BadJwtToken`, kind: 'push-broken', detail: 'fcm', fix: 'clock' },
  { id: `${PUSH_REJECT_ISSUE_PREFIX}https://web.push.apple.com|BadJwtToken`, kind: 'push-broken', detail: 'apple', fix: 'clock' },
  { kind: 'push-broken', detail: 'the key could not be read', fix: 'restore the key' },
];

test('#280: a delivered push withdraws the undelivered row and its own service’s rejection rows — nothing else', () => {
  assert.deepEqual(withdraw(rows(), 'delivered', 'https://fcm.googleapis.com'), [
    DELIVERY_ISSUE_ID,
    `${PUSH_REJECT_ISSUE_PREFIX}https://web.push.apple.com|BadJwtToken`,
    'push-broken',
  ]);
});

test('#280: a device change — the repair the row asks for — withdraws every row a failed push raised, and keeps the channel row and the key row', () => {
  assert.deepEqual(withdraw(rows(), 'devices-changed'), [DELIVERY_ISSUE_ID, 'push-broken']);
});

test('#280: with nothing to withdraw, nothing moves', () => {
  const only = [{ id: DELIVERY_ISSUE_ID, kind: 'push-broken', detail: 'x', fix: 'y' }];
  assert.deepEqual(withdraw(only, 'delivered', 'https://fcm.googleapis.com'), [DELIVERY_ISSUE_ID]);
});
