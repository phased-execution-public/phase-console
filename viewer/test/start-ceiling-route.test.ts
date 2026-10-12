/**
 * `GET /api/ceiling` (quiet-console phase 25, §Architecture 5): the start
 * ceiling's live counters — the automatic starts and the session dollars in
 * the sliding hour, the limits, the doors that made the starts, the limit the
 * next automatic start would meet and when it frees — and the MCP probe's own
 * ceiling beside it. Until now only a refusal ever said any of it.
 *
 * Above the "no source directory" wall: the ceiling is the console's, open
 * plan directory or not. A read charges nothing and announces nothing.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bareService, call, scratch, service } from './thin-read-harness.ts';
import { doorActor } from '../server/actor.ts';
import {
  CEILING_WINDOW_MS, DEFAULT_STARTS_PER_HOUR, DEFAULT_USD_PER_HOUR, PROBE_STARTS_PER_HOUR, StartCeiling,
} from '../server/start-ceiling.ts';

const clock = () => doorActor('wait-clock', { by: 'console', via: 'timer', origin: 'armLimitResume' });
const converge = () => doorActor('converge-relaunch', { by: 'console', via: 'timer', origin: 'converge' });

test('GET /api/ceiling answers with no source directory open: both ceilings, empty, with their limits', async () => {
  const svc = await bareService();
  try {
    const out = await call(svc, 'GET', '/api/ceiling');
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.work, {
      starts: 0, usd: 0, limits: { startsPerHour: DEFAULT_STARTS_PER_HOUR, usdPerHour: DEFAULT_USD_PER_HOUR },
      windowMs: CEILING_WINDOW_MS, doors: {}, full: null, until: null,
    });
    assert.deepEqual(out.body.probe.limits, { startsPerHour: PROBE_STARTS_PER_HOUR, usdPerHour: 0 });
    assert.equal(out.body.probe.full, null);
  } finally {
    svc.close();
  }
});

test('the counters are the live ones: the doors, the limit the next start meets and when it frees — and reading charges nothing', async () => {
  const svc = await service(scratch());
  try {
    svc.prefs.ceilingStartsPerHour = 2;
    const first = Date.now() - 20 * 60_000;
    svc.startCeiling.charge(clock(), 'alpha', first);
    svc.startCeiling.charge(converge(), 'alpha', first + 5 * 60_000);

    const out = await call(svc, 'GET', '/api/ceiling');
    assert.equal(out.status, 200);
    assert.equal(out.body.work.starts, 2);
    assert.deepEqual(out.body.work.doors, { 'wait-clock': 1, 'converge-relaunch': 1 });
    assert.deepEqual(out.body.work.limits, { startsPerHour: 2, usdPerHour: DEFAULT_USD_PER_HOUR }, 'the preference, read live');
    assert.equal(out.body.work.full, 'startsPerHour');
    assert.equal(out.body.work.until, new Date(first + CEILING_WINDOW_MS).toISOString(), 'when the oldest start leaves the hour');
    // The same answer the door would give the next automatic start.
    const refusal = svc.startCeiling.admit(clock());
    assert.equal(refusal.ok, false);
    if (!refusal.ok) assert.equal(refusal.until, out.body.work.until);

    const again = await call(svc, 'GET', '/api/ceiling');
    assert.equal(again.body.work.starts, 2, 'a read is not a start');
    assert.equal(again.body.probe.starts, 0, "the probe's ceiling is its own — work starts never count there");

    // The dollars: room under the starts, none under the money.
    svc.prefs.ceilingStartsPerHour = 0;
    svc.startCeiling.spendUsd(DEFAULT_USD_PER_HOUR + 10, first + 10 * 60_000);
    const spent = await call(svc, 'GET', '/api/ceiling');
    assert.equal(spent.body.work.full, 'usdPerHour');
    assert.equal(spent.body.work.usd, DEFAULT_USD_PER_HOUR + 10);
    assert.equal(spent.body.work.until, new Date(first + 10 * 60_000 + CEILING_WINDOW_MS).toISOString());
  } finally {
    svc.close();
  }
});

test('view() frees as the window slides, and a limit of 0 is no limit', () => {
  let now = Date.parse('2026-10-10T12:00:00.000Z');
  const ceiling = new StartCeiling(() => ({ startsPerHour: 1, usdPerHour: 0 }), () => now);
  assert.equal(ceiling.view().full, null);
  ceiling.charge(clock(), 'alpha');
  assert.deepEqual(
    { full: ceiling.view().full, until: ceiling.view().until },
    { full: 'startsPerHour', until: new Date(now + CEILING_WINDOW_MS).toISOString() },
  );
  now += CEILING_WINDOW_MS + 1;
  assert.deepEqual({ starts: ceiling.view().starts, full: ceiling.view().full, until: ceiling.view().until }, { starts: 0, full: null, until: null });

  const unbounded = new StartCeiling(() => ({ startsPerHour: 0, usdPerHour: 0 }), () => now);
  for (let i = 0; i < 50; i += 1) unbounded.charge(clock(), 'alpha');
  unbounded.spendUsd(10_000);
  assert.equal(unbounded.view().full, null, '0 switches both limits off');
});
