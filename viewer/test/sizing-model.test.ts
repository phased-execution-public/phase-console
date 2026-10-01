/**
 * The sizing model (control-tower phase 59, #83, AUD-25): a session's context
 * is a per-session FLOOR plus a slope × weight, and a plan's forecast is in
 * the unit the console runs — `1 phase ≥ 1 session`.
 *
 * `scripts/sizing.env` used to say a session's context was about three times
 * its summed weight. On the audit week that line was under 107 of 108 phases:
 * S phases peaked at 21.6× their weight, L at 5.3×, because every session
 * reads its boot prefix and does its plan-and-verify work before its size
 * counts at all. And the §Session budget forecasts it fed assumed the batching
 * the autopilot never does — 0.35–0.67 sessions a phase against a measured
 * 1.1–5.0.
 *
 * SM-1..3 hold the new model to the measured corpus
 * (`fixtures/sizing/sessions-corpus.json`, two consoles of this machine,
 * anonymised) and the shipped numbers in `sizing.env` to the model's own fit
 * of that corpus, so neither can drift from what was measured.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SKILL_DIR } from '../server/config.ts';
import { loadSizing } from '../server/analysis/graph.ts';
import {
  contextOf, fitContextModel, forecastSessions, FORECAST_UNIT, sessionsPerPhaseOf, shippedContextModel, sizingCensus,
  type PhaseSessions, type SizingSession,
} from '../server/analysis/sizing-model.ts';
import {
  CAP_HEADROOM, CAP_MIN_SAMPLES, CAP_PERCENTILE, CAP_WINDOW_MS, CLOSEOUT_MAX_TURNS, REPAIR_MAX_TURNS, RESUME_MIN_TURNS,
  SHIPPED_CAP_TABLE, capsFor, deriveCapTable, sessionRecordOf, type CapSample,
} from '../server/runner/session-record.ts';
import type { SpawnOutcome, SpawnRequest } from '../server/runner/spawn.ts';

type Corpus = {
  sessions: (SizingSession & { instance: string })[];
  phases: (PhaseSessions & { instance: string })[];
};
const CORPUS: Corpus = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'sizing', 'sessions-corpus.json'), 'utf8'));
const SHIPPED = loadSizing(join(SKILL_DIR, 'scripts'));
const WEIGHT = { S: SHIPPED.S, M: SHIPPED.M, L: SHIPPED.L } as const;

/** "Near 1": the measured median peak within a fifth of what the model says, for every tag. */
const NEAR = 0.2;

const consoles = [
  ['console-a', CORPUS.sessions.filter((s) => s.instance === 'console-a')],
  ['console-b', CORPUS.sessions.filter((s) => s.instance === 'console-b')],
  ['both', CORPUS.sessions],
] as const;

test('SM-1: the measured peak ÷ (floor + slope × weight) sits near 1 for every tag — on each console and on both', () => {
  for (const [name, sessions] of consoles) {
    const model = fitContextModel(sessions, SHIPPED);
    assert.equal(model.basis, 'measured', name);
    assert.deepEqual(model.sizes.map((s) => s.size), ['S', 'M', 'L'], `${name}: every tag measured`);
    for (const row of model.sizes) {
      assert.ok(Math.abs(row.ratio - 1) <= NEAR, `${name} ${row.size}: median peak ${row.medianPeak} is ${row.ratio.toFixed(3)} × the model`);
    }
  }
});

test('SM-1: the model it replaces — context ≈ 3 × weight — missed every tag, the smallest by 7×', () => {
  const model = fitContextModel(CORPUS.sessions, SHIPPED);
  const old = model.sizes.map((row) => ({ size: row.size, ratio: row.medianPeak / (3 * WEIGHT[row.size as 'S' | 'M' | 'L']) }));
  for (const row of old) assert.ok(row.ratio > 1.8, `${row.size} ran ${row.ratio.toFixed(2)} × the old line`);
  assert.ok(old[0]!.ratio > 7, 'an S phase peaked at more than seven times its 3 × weight');
  // …and with no floor the slope is not the answer either: the best line
  // through the origin still misses S by more than half.
  const through = model.sizes.reduce((a, r) => a + r.medianPeak * r.weight, 0) / model.sizes.reduce((a, r) => a + r.weight * r.weight, 0);
  assert.ok(model.sizes[0]!.medianPeak / (through * model.sizes[0]!.weight) > 1.5);
});

test('SM-2: the floor is the boot the first call read, plus the work above it — and a batch pays it ONCE', () => {
  const model = fitContextModel(CORPUS.sessions, SHIPPED);
  assert.ok(model.bootMeasured, 'the boot is measured from the first calls');
  assert.equal(model.boot, model.bootMeasured.tokens);
  assert.equal(Math.round(model.boot + model.work), Math.round(model.floor));
  assert.ok(model.boot > 80_000 && model.boot < 130_000);
  assert.ok(model.floor > 250_000, `the floor ${model.floor} is most of an S phase's peak`);
  // Two L phases in one session pay one floor and two slopes — never two floors.
  const two = contextOf(model, 2 * WEIGHT.L);
  assert.equal(Math.round(two), Math.round(model.floor + model.slope * 2 * WEIGHT.L));
  assert.ok(two < 2 * contextOf(model, WEIGHT.L));
});

test('SM-2: the shipped sizing.env IS the corpus\'s fit — boot, work floor and slope, to the rounding', () => {
  const model = fitContextModel(CORPUS.sessions, SHIPPED);
  assert.ok(Math.abs(SHIPPED.bootFloor - model.boot) <= 1_000, `boot ${model.boot} vs SESSION_BOOT_FLOOR ${SHIPPED.bootFloor}`);
  assert.ok(Math.abs(SHIPPED.workFloor - model.work) <= 1_000, `work ${model.work} vs SESSION_WORK_FLOOR ${SHIPPED.workFloor}`);
  assert.ok(Math.abs(SHIPPED.slopePct - model.slope * 100) <= 1, `slope ${model.slope} vs SESSION_SLOPE_PCT ${SHIPPED.slopePct}`);
  // And the shipped model sits near 1 on the corpus as well.
  const shipped = shippedContextModel(SHIPPED);
  for (const row of model.sizes) assert.ok(Math.abs(row.medianPeak / contextOf(shipped, row.weight) - 1) <= NEAR, row.size);
});

test('SM-2: a repository that has measured its boot but not yet a fit takes its own boot and the shipped work', () => {
  const boots: SizingSession[] = [80_000, 82_000, 84_000].map((firstContext, i) => ({
    mode: 'phase', resumed: false, firstContext, calls: 4, peakContext: firstContext + 10, at: `2026-10-0${i + 1}T00:00:00Z`,
  }));
  const model = fitContextModel(boots, SHIPPED);
  assert.equal(model.basis, 'shipped', 'three short sessions fit nothing');
  assert.equal(model.boot, 82_000);
  assert.equal(model.floor, 82_000 + SHIPPED.workFloor);
  assert.equal(fitContextModel([], SHIPPED).floor, SHIPPED.bootFloor + SHIPPED.workFloor);
});

test('SM-3: sessions per phase are measured, split by size and by whether the phase wrapped — and sizing.env holds them', () => {
  const table = sessionsPerPhaseOf(CORPUS.phases, SHIPPED);
  for (const size of ['S', 'M', 'L'] as const) {
    const row = table[size];
    const env = SHIPPED.sessions[size];
    assert.equal(row.basis, 'measured', size);
    assert.ok(Math.abs(row.noWrap * 100 - env.noWrapX100) <= 1, `${size} no-wrap ${row.noWrap}`);
    assert.ok(Math.abs(row.wraps * 100 - env.wrapX100) <= 1, `${size} wraps ${row.wraps}`);
    assert.ok(Math.abs(row.wrapRate * 100 - env.wrapPct) <= 1, `${size} wrap rate ${row.wrapRate}`);
    assert.ok(row.expected >= 1, 'a phase is at least one session');
    assert.ok(row.wraps > row.noWrap || size === 'S', `${size}: a phase that wraps takes more sessions`);
  }
  assert.ok(table.L.wrapRate > table.M.wrapRate && table.M.wrapRate > table.S.wrapRate, 'the larger the phase, the likelier it wraps');
});

test('SM-3: the forecast is in the unit the autopilot runs — 1 phase ≥ 1 session — never a weight over a budget', () => {
  const table = sessionsPerPhaseOf([], SHIPPED); // the shipped rows
  const forecast = forecastSessions(Array.from({ length: 10 }, () => ({ size: 'L' as const })), table);
  assert.equal(forecast.unit, FORECAST_UNIT);
  assert.equal(FORECAST_UNIT, '1 phase ≥ 1 session');
  // (58 × 148 + 42 × 254) / 10000 = 1.9252 sessions per L phase: 19 for ten.
  assert.equal(forecast.sessions, 19);
  assert.equal(forecast.bySize.L.phases, 10);
  // Batching's arithmetic would have said ⌈900K ÷ 200K⌉ = 5 — the audit's 2–4× under-count.
  assert.ok(forecast.sessions > Math.ceil((10 * WEIGHT.L) / SHIPPED.budget1m) * 3);
  // Never fewer sessions than phases, even for a size that measured under one.
  const tiny = { ...table, S: { ...table.S, expected: 0.4 } };
  assert.equal(forecastSessions([{ size: 'S' }, { size: 'S' }], tiny).sessions, 2);
  assert.equal(forecastSessions([], table).sessions, 0);
});

test('SM-3: the control-tower-sized plan — the forecast a plan can quote instead of a hand-typed one', () => {
  // 46 L · 22 M · 7 S, the shape of the plan that fixed this.
  const plan = [
    ...Array.from({ length: 46 }, () => ({ size: 'L' as const })),
    ...Array.from({ length: 22 }, () => ({ size: 'M' as const })),
    ...Array.from({ length: 7 }, () => ({ size: 'S' as const })),
  ];
  const forecast = forecastSessions(plan, sessionsPerPhaseOf([], SHIPPED));
  // 46 × 1.9252 + 22 × 1.658 + 7 × 1.7117 = 88.56 + 36.48 + 11.98 = 137.0
  assert.equal(forecast.sessions, 137);
  assert.ok(forecast.sessions >= plan.length);
});

/* ------------------------------------------------------------------ *
 * SM-4..5 — the caps come from measured sessions, and say how
 * ------------------------------------------------------------------ */

type CorpusSession = SizingSession & { instance: string; at: string; turns: number; usd: number; bookedUsd?: number };
const LINES: CapSample[] = (CORPUS.sessions as CorpusSession[]).map((s) => ({
  mode: s.mode, at: s.at, turns: s.turns, costUsd: s.usd, bookedUsd: s.bookedUsd, resumed: s.resumed,
}));
const NOW = Date.parse('2026-09-25T12:00:00Z');

test('SM-4: a mode\'s caps are its p99 + 50 % over the window, rounded up — and the shipped table IS the corpus\'s', () => {
  assert.equal(CAP_PERCENTILE, 0.99);
  assert.equal(CAP_HEADROOM, 0.5);
  const table = deriveCapTable(LINES, NOW);
  const phase = table.modes.phase!;
  assert.equal(phase.turns!.value, 490, 'p99 322 turns × 1.5 = 483, rounded up to ten');
  assert.equal(phase.usd!.value, 120, 'p99 $77.81 × 1.5 = $116.72, rounded up to five');
  assert.equal(table.modes.resume!.turns!.value, 120, 'p99 74 × 1.5 = 111 → 120');
  for (const mode of ['phase', 'resume'] as const) {
    for (const key of ['turns', 'usd'] as const) {
      const derived = table.modes[mode]?.[key];
      const shipped = SHIPPED_CAP_TABLE.modes[mode]?.[key];
      assert.equal(derived?.value, shipped?.value, `${mode} ${key}: shipped = derived`);
      if (!derived) continue;
      assert.equal(derived.derivation!.samples, shipped!.derivation!.samples, `${mode} ${key}: the same sessions`);
      assert.equal(derived.derivation!.observed, shipped!.derivation!.observed, `${mode} ${key}: the same p99`);
    }
  }
});

test('SM-4: a correct cap binds on a runaway and never on the p90 — the per-size rows it replaces did the opposite', () => {
  const table = deriveCapTable(LINES, NOW);
  const fresh = (CORPUS.sessions as CorpusSession[]).filter((s) => s.mode === 'phase' && !s.resumed);
  const q = (values: number[], p: number) => { const a = [...values].sort((x, y) => x - y); return a[Math.floor((a.length - 1) * p)]!; };
  const turnsP90 = q(fresh.map((s) => s.turns), 0.9);
  const usdP90 = q(fresh.map((s) => s.usd), 0.9);
  assert.ok(turnsP90 / table.modes.phase!.turns!.value < 0.6, `p90 ${turnsP90} turns is ${turnsP90 / 490} of the cap`);
  assert.ok(usdP90 / table.modes.phase!.usd!.value < 0.6, `p90 $${usdP90} is ${usdP90 / 120} of the cap`);
  assert.ok(Math.max(...fresh.map((s) => s.turns)) < table.modes.phase!.turns!.value, 'no measured session reached the turn cap');
  // The M row this replaces ($60 / 300 turns) sat below the p90 of the M sessions it capped.
  const m = fresh.filter((s) => s.size === 'M');
  assert.ok(q(m.map((s) => s.turns), 0.9) > 0.8 * 300, 'M ran at 0.8 of its old turn cap by p90');
  assert.ok(Math.max(...m.map((s) => s.usd)) > 60, 'and past its old dollar cap at the top');
});

test('SM-4: too few sessions keep the shipped cap; old sessions leave the window; a measurement never lowers a side cap', () => {
  assert.equal(CAP_MIN_SAMPLES, 20);
  const few = LINES.filter((l) => l.mode === 'phase').slice(0, CAP_MIN_SAMPLES - 1);
  assert.equal(deriveCapTable(few, NOW).modes.phase, undefined, 'nineteen sessions are not a p99');
  const later = deriveCapTable(LINES, NOW + CAP_WINDOW_MS + 86_400_000);
  assert.deepEqual(later.modes, {}, 'two weeks after the corpus nothing in it is read');
  // A console whose closeouts all ran short does not cut the next one below its brief's cap.
  const shortCloseouts: CapSample[] = Array.from({ length: 30 }, (_, i) => ({ mode: 'closeout', at: new Date(NOW - i * 3_600_000).toISOString(), turns: 10 }));
  const t = deriveCapTable(shortCloseouts, NOW);
  assert.equal(t.modes.closeout!.turns!.value, 20);
  assert.deepEqual(capsFor({ mode: 'closeout', phaseBudgetUsd: null, table: t }).maxTurns, { value: CLOSEOUT_MAX_TURNS, source: 'closeout' });
  // …and one whose repairs measurably run long gets the room.
  const longRepairs: CapSample[] = Array.from({ length: 30 }, (_, i) => ({ mode: 'repair', at: new Date(NOW - i * 3_600_000).toISOString(), turns: 100 + i }));
  const r = capsFor({ mode: 'repair', phaseBudgetUsd: null, table: deriveCapTable(longRepairs, NOW) }).maxTurns;
  assert.ok(r.value > REPAIR_MAX_TURNS && r.source === 'measured', `a repair cap of ${r.value}`);
  // A resume: the phase's cap less what was spent, floored at the resume floor.
  assert.equal(capsFor({ mode: 'resume', phaseBudgetUsd: null, spentTurns: 440 }).maxTurns.value, RESUME_MIN_TURNS);
  assert.equal(capsFor({ mode: 'resume', phaseBudgetUsd: null, spentTurns: 100 }).maxTurns.value, 390);
});

test('SM-5: every session records its caps\' derivation — the window and the percentile — so drift is visible in the ledger', () => {
  const table = deriveCapTable(LINES, NOW);
  const caps = capsFor({ mode: 'phase', phaseBudgetUsd: null, table });
  for (const cap of [caps.maxTurns, caps.maxBudgetUsd]) {
    assert.equal(cap.source, 'measured');
    assert.deepEqual(Object.keys(cap.derivation!).sort(), ['basis', 'from', 'headroom', 'observed', 'percentile', 'samples', 'to']);
    assert.equal(cap.derivation!.basis, 'this-console');
    assert.equal(cap.derivation!.percentile, 0.99);
    assert.match(cap.derivation!.from!, /^2026-09-16/);
    assert.match(cap.derivation!.to!, /^2026-09-25/);
  }
  // The phase.session line is built from the caps the spawn ran under: the derivation rides into the journal.
  const request = { prompt: 'p', cwd: '/tmp', caps } as unknown as SpawnRequest;
  const outcome = { code: 0, turns: 200, costUsd: 30, durationMs: 60_000, caps } as unknown as SpawnOutcome;
  const record = sessionRecordOf({ mode: 'phase', request, outcome });
  assert.deepEqual(record.maxTurns.derivation, caps.maxTurns.derivation);
  assert.deepEqual(record.maxBudgetUsd.derivation, caps.maxBudgetUsd.derivation);
  // Before this console has measured anything, the shipped table answers — and says it is the shipped one.
  const shipped = capsFor({ mode: 'phase', phaseBudgetUsd: null });
  assert.equal(shipped.maxTurns.derivation!.basis, 'shipped');
  assert.equal(shipped.maxTurns.value, 490);
  // A run's own budget still wins the dollars, and says so.
  assert.deepEqual(capsFor({ mode: 'phase', phaseBudgetUsd: 40, table }).maxBudgetUsd, { value: 40, source: 'run' });
});

test('SM-4..5: the census reads a console\'s journals into the caps, the context model and the sessions per phase', () => {
  const at = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
  const lines = Array.from({ length: 24 }, (_, i) => [
    { event: 'phase.session', phase: i + 1, time: at(i), data: { mode: 'phase', turns: 100 + i, costUsd: 20 + i, resumed: false } },
    { event: 'phase.tokens', phase: i + 1, time: at(i), data: { mode: 'phase', resumed: false, calls: 90, firstContext: 100_000, peakContext: 400_000 + i * 1000 } },
  ]).flat();
  lines.push({ event: 'phase.context-wrapup', phase: 1, time: at(0), data: {} } as never);
  const phases = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(i + 1), { phase: i + 1, status: 'done' }]));
  const census = sizingCensus([{ slug: 'p', phases, lines }], () => ({ size: 'L', weight: SHIPPED.L }), SHIPPED, NOW);
  assert.equal(census.caps.modes.phase!.turns!.derivation!.samples, 24);
  assert.equal(census.context.boot, 100_000, 'the boot floor from the recorded first calls');
  assert.equal(census.sessions.L.basis, 'measured');
  assert.equal(census.sessions.L.phases, 24);
  assert.ok(Math.abs(census.sessions.L.wrapRate - 1 / 24) < 1e-9, 'phase 1 wrapped');
});
