/**
 * `GET /api/sizing` (quiet-console phase 25, §Architecture 5): what a session
 * may spend — the caps this console measured beside the shipped ones, the caps
 * a phase session spawns under, the context model with its boot floor's line,
 * and sessions per phase. The census the runner already spawns under, as a
 * page reads it; no route said any of it before.
 *
 * Below the "no source directory" wall: the census is read from the open
 * directory's stored runs, so with none open the answer is the 409 its
 * neighbours give. Until this console's first read of its own sessions lands,
 * every figure is the shipped one and says so (`derivedAt: null`, each row's
 * basis).
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { bareService, call, scratch, service, wire } from './thin-read-harness.ts';
import { SKILL_DIR } from '../server/config.ts';
import { loadSizing } from '../server/analysis/graph.ts';
import { shippedContextModel, sizingCensus, sizingView, type CensusLine } from '../server/analysis/sizing-model.ts';
import { CAP_MIN_SAMPLES, SHIPPED_CAP_TABLE, phaseCaps } from '../server/runner/session-record.ts';

const SHIPPED = loadSizing(join(SKILL_DIR, 'scripts'));
const NOW = Date.parse('2026-10-10T12:00:00.000Z');

/** Twenty-four phase sessions of one plan inside the census window: enough to measure both caps. */
function measuredCensus() {
  const lines: CensusLine[] = [];
  for (let i = 0; i < CAP_MIN_SAMPLES + 4; i += 1) {
    lines.push({
      event: 'phase.session', phase: 1 + (i % 3), time: new Date(NOW - (i + 1) * 3_600_000).toISOString(),
      data: { mode: 'phase', turns: 100 + i, costUsd: 4 + i / 4, costSource: 'reported' },
    });
  }
  return sizingCensus([{ slug: 'alpha', phases: {}, lines }], () => ({ size: 'S', weight: 50_000 }), SHIPPED, NOW);
}

test('GET /api/sizing is a 409 with no source directory open, like the plan routes beside it', async () => {
  const svc = await bareService();
  try {
    const out = await call(svc, 'GET', '/api/sizing');
    assert.equal(out.status, 409);
    assert.match(String(out.body.error), /No source directory is open/);
  } finally {
    svc.close();
  }
});

test('with nothing measured yet every figure is the shipped one, and says so — then the census lands and dates it', async () => {
  const svc = await service(scratch());
  try {
    const out = await call(svc, 'GET', '/api/sizing');
    assert.equal(out.status, 200);
    assert.equal(out.body.derivedAt, null, 'no census yet: nothing is measured');
    assert.equal(out.body.caps.measured, null);
    assert.deepEqual(out.body.caps.shipped, wire(SHIPPED_CAP_TABLE), 'the shipped table rides beside it, whole');
    assert.deepEqual(out.body.caps.phase, wire(phaseCaps(null)), 'a phase spawns under the shipped caps');
    assert.deepEqual(out.body.context, wire(shippedContextModel(SHIPPED)));
    assert.equal(typeof out.body.bootLine, 'string');
    assert.ok(out.body.bootLine.length > 0);
    for (const size of ['S', 'M', 'L']) {
      assert.equal(out.body.sessions[size].basis, 'shipped', `${size} sessions per phase are the shipped row`);
    }

    // The read started the census in the background — a reader never waits for
    // it — and the next read carries what it measured (nothing, here), dated.
    // (Over an empty library it may well have landed already.)
    await (svc as never as { sizingCensusRead: Promise<void> | null }).sizingCensusRead;
    const after = await call(svc, 'GET', '/api/sizing');
    assert.equal(after.status, 200);
    assert.equal(typeof after.body.derivedAt, 'string');
    assert.ok(after.body.caps.measured, 'the census is in: its own table, however little it measured');
    assert.deepEqual(after.body.caps.shipped, wire(SHIPPED_CAP_TABLE));
  } finally {
    svc.close();
  }
});

test('a measured census answers its caps beside the shipped ones, and a phase spawns under the measured pair', async () => {
  const census = measuredCensus();
  const turns = census.caps.modes.phase?.turns;
  const usd = census.caps.modes.phase?.usd;
  assert.equal(turns?.source, 'measured', 'the fixture measures the turn cap');
  assert.equal(usd?.source, 'measured', 'the fixture measures the dollar cap');

  const view = sizingView(census, SHIPPED);
  assert.equal(view.derivedAt, census.derivedAt);
  assert.deepEqual(view.caps.measured, census.caps);
  assert.equal(view.caps.shipped, SHIPPED_CAP_TABLE, 'the shipped table is the owner\'s object');
  assert.deepEqual(view.caps.phase, { turns, usd });
  assert.notDeepEqual(view.caps.phase.turns, SHIPPED_CAP_TABLE.modes.phase?.turns);
  assert.deepEqual(view.sessions, census.sessions);
  assert.deepEqual(view.context, census.context);

  // …and the route answers the census the service holds.
  const svc = await service(scratch());
  try {
    (svc as never as { sizingCensusCache: { at: number; value: unknown } }).sizingCensusCache = { at: Date.now(), value: census };
    const out = await call(svc, 'GET', '/api/sizing');
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, wire(view));
  } finally {
    svc.close();
  }
});
