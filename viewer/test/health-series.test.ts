/**
 * Logs ▸ Health over time (measured-console phase 31, §Architecture 9 F2) — the bounded series.
 *
 * HS-1 a point is checked field by field; HS-2 the gate's marker JSON is one point per run and
 * never twice; HS-3 both bounds hold (the retention's days and the points per measure) and the
 * file is rewritten without the excess, 0600; HS-4 the view carries extra points (the
 * reconciliation's delta) without writing them; HS-5 a run save is timed into the `persist`
 * measure's window, which a read empties.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HEALTH_MEASURES, HEALTH_SERIES_DAYS, HealthSeries, boundPoints, gateMarkerPoint, pointOf, seriesView,
} from '../server/health-series.ts';
import { takePersistTiming } from '../server/runner/state.ts';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

test('HS-1 a point is a known measure, an instant and a finite number — anything else is no point', () => {
  assert.deepEqual(pointOf({ m: 'load', at: '2026-10-28T11:00:00Z', v: 0.42 }), { m: 'load', at: '2026-10-28T11:00:00.000Z', v: 0.42 });
  assert.equal(pointOf({ m: 'nope', at: '2026-10-28T11:00:00Z', v: 1 }), null);
  assert.equal(pointOf({ m: 'load', at: 'yesterday', v: 1 }), null);
  assert.equal(pointOf({ m: 'load', at: '2026-10-28T11:00:00Z', v: Number.NaN }), null);
  assert.deepEqual([...HEALTH_MEASURES], ['gate', 'load', 'persist', 'reconcile']);
});

test('HS-2 the full gate\'s marker JSON is one point per run, at its end, and the same run is never written twice', () => {
  const marker = { version: 1, full: true, head: '1210dab63bd83f85', total_s: 1210, started_at: '2026-10-27T09:00:00Z', ended_at: '2026-10-27T09:20:10Z', stages: [] };
  assert.deepEqual(gateMarkerPoint(marker), { m: 'gate', at: '2026-10-27T09:20:10.000Z', v: 1210, note: '1210dab63bd8' });
  assert.equal(gateMarkerPoint({ total_s: 'soon' }), null);
  const series = new HealthSeries({ dir: mkdtempSync(join(tmpdir(), 'p31-hs-')), now: () => NOW });
  assert.equal(series.record('gate', 1210, { at: '2026-10-27T09:20:10Z', note: 'a' }), true);
  assert.equal(series.record('gate', 1210, { at: '2026-10-27T09:20:10Z', note: 'a' }), false, 'the same marker read again');
  assert.equal(series.record('gate', 1500, { at: '2026-10-28T09:00:00Z' }), true);
  assert.deepEqual(series.view().measures.gate.map((p) => p.v), [1210, 1500]);
});

test('HS-3 the series is bounded by the retention\'s days and by points per measure, and pruning rewrites the file 0600', () => {
  const points = [
    ...Array.from({ length: 10 }, (_, i) => ({ m: 'load' as const, at: iso(NOW - i * 3_600_000), v: i })),
    { m: 'load' as const, at: iso(NOW - (HEALTH_SERIES_DAYS + 1) * DAY), v: 99 },
    { m: 'persist' as const, at: iso(NOW - DAY), v: 3 },
  ];
  const kept = boundPoints(points, NOW, HEALTH_SERIES_DAYS, 4);
  assert.deepEqual(kept.filter((p) => p.m === 'load').map((p) => p.v), [3, 2, 1, 0], 'the newest four, oldest first');
  assert.ok(!kept.some((p) => p.v === 99), 'past the retention');
  assert.equal(kept.filter((p) => p.m === 'persist').length, 1, 'each measure has its own bound');

  const dir = mkdtempSync(join(tmpdir(), 'p31-hs-'));
  const series = new HealthSeries({ dir, now: () => NOW, maxPoints: 4 });
  for (const p of points) series.record(p.m, p.v, { at: p.at });
  assert.equal(series.prune(HEALTH_SERIES_DAYS), 7);
  assert.equal(series.points().length, 5);
  assert.equal(statSync(series.file).mode & 0o777, 0o600);
  assert.equal(series.prune(HEALTH_SERIES_DAYS), 0, 'a bounded file is left alone');
  assert.equal(readFileSync(series.file, 'utf8').trim().split('\n').length, 5);
});

test('HS-4 the view is every measure over its days, extra points (the reconciliation\'s delta) drawn but never written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p31-hs-'));
  const series = new HealthSeries({ dir, now: () => NOW });
  series.record('load', 0.5, { at: iso(NOW - 60_000) });
  const view = series.view(7, [{ m: 'reconcile', at: iso(NOW - DAY), v: 3.2, note: 'reconciled' }]);
  assert.deepEqual(view.bounds, { maxPoints: 2_100, days: 7, sampleMs: 300_000 });
  assert.deepEqual(view.measures.reconcile, [{ at: iso(NOW - DAY), v: 3.2, note: 'reconciled' }]);
  assert.deepEqual(view.measures.load.map((p) => p.v), [0.5]);
  assert.deepEqual(view.measures.gate, []);
  assert.equal(series.points().some((p) => p.m === 'reconcile'), false);
  assert.equal(seriesView([], { now: NOW, days: 1 }).from, iso(NOW - DAY));
});

test('HS-5 a run save is timed into the persist measure\'s window, and reading the window empties it', async () => {
  const { saveRun } = await import('../server/runner/state.ts');
  takePersistTiming();
  assert.deepEqual(takePersistTiming(), { saves: 0, meanMs: null, maxMs: null }, 'no save, no figure — never 0 ms');
  const root = mkdtempSync(join(tmpdir(), 'p31-persist-'));
  try {
    saveRun({ root, slug: 'demo', id: 'r1', status: 'running', phases: {}, spentUsd: 0 } as never);
  } catch {
    /* a minimal record may fail a later step; the timing is taken either way */
  }
  const timing = takePersistTiming();
  assert.equal(timing.saves, 1);
  assert.ok(timing.meanMs !== null && timing.meanMs >= 0);
  assert.equal(takePersistTiming().saves, 0);
});
