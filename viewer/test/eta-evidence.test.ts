/**
 * The ETA's evidence is what phases really took (control-tower phase 58, #66,
 * EE-1..5).
 *
 * Only a phase's own attempt ever added to its measured time. The seven other
 * session paths — a resume, a repair, a QA round, a closeout, a landing, a
 * review, the pull request — booked money and turns and no time, so a phase
 * its closeout finished read 12.8 s and entered the rate as one of the fastest
 * phases on record. These tests pin what replaced that:
 *
 *   EE-1  every session that works a phase opens a window at the spawn door,
 *         and the worked time is their sum; the run's pull-request session is
 *         not the phase's work;
 *   EE-2  a stored run is re-measured from its journal once — its sessions'
 *         walls become windows, never twice, and never over a window the door
 *         already opened;
 *   EE-3  a finished phase that is not a measurement (no time, near-zero, a
 *         closeout's paperwork alone) is left out of the rate AND counted;
 *   EE-4  every remaining-time figure names its clock — working or calendar;
 *   EE-5  a calendar with no recent pace reads unknown, and the plan page
 *         carries both figures.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PHASE_WORK_MODES, addSessionWindow, closeAttemptWindow, openAttemptWindow, openSessionWindow, phaseClocks,
} from '../shared/phase-clocks.js';
import { ETA_CLOCKS, ETA_MISSING_REASONS } from '../shared/ops-vocab.js';
import { SESSION_MODES } from '../shared/run-lifecycle.js';
import {
  ETA_MIN_EVIDENCE_MS, dutyCycle, etaEvidence, etaFrom, evidenceOf, forecastFrom, phaseEtaFor, rateFor,
} from '../server/analysis/stats.ts';
import { CLOCK_MODEL, capsFor, remeasureFromLedger, type LedgerLine } from '../server/runner/session-record.ts';
import { Runner } from '../server/runner/runner.ts';
import { newRun, phaseRecord } from '../server/runner/state.ts';
import type { SpawnFn, SpawnOutcome } from '../server/runner/spawn.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-09-20T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

/* ------------------------------------------------------------------ *
 * EE-1 — every session that worked the phase is worked time
 * ------------------------------------------------------------------ */

test('EE-1: an attempt plus a resume plus a closeout is the sum of all three windows', () => {
  const record: Record<string, unknown> = { phase: 3, status: 'running', attempts: 0, startedAt: iso(T0) };
  record.attempts = 1;
  record.attemptStartedAt = iso(T0);
  openAttemptWindow(record, 1, iso(T0));
  closeAttemptWindow(record, iso(T0 + 20 * MIN));
  openSessionWindow(record, 'resume', iso(T0 + 60 * MIN));
  closeAttemptWindow(record, iso(T0 + 90 * MIN));
  openSessionWindow(record, 'closeout', iso(T0 + 120 * MIN));
  closeAttemptWindow(record, iso(T0 + 125 * MIN));
  record.status = 'done';
  const clocks = phaseClocks(record, T0 + 999 * MIN);
  assert.equal(clocks.workedMs, (20 + 30 + 5) * MIN, 'the parks between them are not work');
  assert.deepEqual(clocks.attemptWindows.map((w) => w.mode ?? 'attempt'), ['attempt', 'resume', 'closeout']);
});

test('EE-1: a window opened on a record written before windows keeps the time it already had', () => {
  const legacy: Record<string, unknown> = {
    phase: 4, status: 'done', attempts: 2, startedAt: iso(T0), attemptStartedAt: iso(T0 + 30 * MIN),
    attemptEndedAt: iso(T0 + 50 * MIN), durationMs: 45 * MIN,
  };
  openSessionWindow(legacy, 'closeout', iso(T0 + 60 * MIN));
  closeAttemptWindow(legacy, iso(T0 + 70 * MIN));
  assert.equal(phaseClocks(legacy, T0 + 999 * MIN).workedMs, (45 + 10) * MIN);
});

test('EE-1: the work modes are every session mode but the run’s pull request', () => {
  assert.deepEqual([...PHASE_WORK_MODES], SESSION_MODES.filter((m) => m !== 'pr'));
  for (const mode of ['resume', 'repair', 'qa', 'closeout', 'review']) assert.ok(PHASE_WORK_MODES.includes(mode as never));
});

function doorRepo() {
  const root = mkdtempSync(join(tmpdir(), 'pc-eta-evidence-'));
  const scripts = join(root, 'scripts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  for (const name of ['phase-graph.sh', 'phase-lock.sh', 'validate.sh']) {
    writeFileSync(join(scripts, name), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(scripts, name), 0o755);
  }
  return { root, scripts, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('EE-1: the spawn door opens and closes a window for every non-attempt work session, and books its time', async () => {
  const r = doorRepo();
  let now = T0;
  const spawn: SpawnFn = async () => {
    now += 7 * MIN; // each session works seven minutes
    return {
      signal: { subtype: 'success', code: 0, text: '' }, sessionId: 'sess-door', costUsd: 0, turns: 1,
      resultText: 'ok', durationMs: 7 * MIN, argv: [],
    } as SpawnOutcome;
  };
  const runner = new Runner({ scriptsDir: r.scripts, spawn, verificationText: () => '`true`', now: () => new Date(now) } as never);
  try {
    const state = newRun({ slug: 'demo', root: r.root } as never);
    const record = phaseRecord(state, 5);
    Object.assign(record, { status: 'done', attempts: 1, startedAt: iso(T0 - 60 * MIN), attemptStartedAt: iso(T0 - 60 * MIN) });
    openAttemptWindow(record, 1, iso(T0 - 60 * MIN));
    closeAttemptWindow(record, iso(T0 - 40 * MIN));
    (runner as unknown as { state: unknown }).state = state;
    const caps = capsFor({ mode: 'closeout', size: 'M' } as never);
    const door = (runner as unknown as {
      spawnSession: (p: number, m: string, req: object, ctx: object) => Promise<SpawnOutcome>;
    }).spawnSession.bind(runner);
    for (const mode of ['resume', 'qa', 'closeout', 'review', 'pr']) {
      await door(5, mode, { prompt: 'x', cwd: r.root }, { caps });
    }
    const windows = (record.attemptWindows ?? []) as { mode?: string; startedAt: string; endedAt?: string }[];
    assert.deepEqual(windows.map((w) => w.mode ?? 'attempt'), ['attempt', 'resume', 'qa', 'closeout', 'review'],
      'the pull-request session is the run’s, not the phase’s');
    assert.ok(windows.every((w) => w.endedAt), 'every window the door opened, it closed');
    assert.equal(phaseClocks(record, now).workedMs, (20 + 4 * 7) * MIN);
    assert.equal(record.durationMs, (20 + 4 * 7) * MIN, 'the stored figure is the windows’ sum');
  } finally {
    r.cleanup();
  }
});

test('EE-1: a spawn that throws still closes the window it opened — no clock left running to now', async () => {
  const r = doorRepo();
  let now = T0;
  const spawn: SpawnFn = async () => {
    now += 3 * MIN;
    throw new Error('spawn refused');
  };
  const runner = new Runner({ scriptsDir: r.scripts, spawn, verificationText: () => '`true`', now: () => new Date(now) } as never);
  try {
    const state = newRun({ slug: 'demo', root: r.root } as never);
    const record = phaseRecord(state, 5);
    Object.assign(record, { status: 'running', attempts: 1, startedAt: iso(T0 - 60 * MIN), attemptStartedAt: iso(T0 - 60 * MIN) });
    openAttemptWindow(record, 1, iso(T0 - 60 * MIN));
    closeAttemptWindow(record, iso(T0 - 40 * MIN));
    (runner as unknown as { state: unknown }).state = state;
    const door = (runner as unknown as {
      spawnSession: (p: number, m: string, req: object, ctx: object) => Promise<SpawnOutcome>;
    }).spawnSession.bind(runner);
    await assert.rejects(door(5, 'resume', { prompt: 'x', cwd: r.root }, { caps: capsFor({ mode: 'resume', size: 'M' } as never) }));
    const windows = (record.attemptWindows ?? []) as { mode?: string; endedAt?: string }[];
    assert.ok(windows.every((w) => w.endedAt), 'the resume window is closed although its spawn threw');
    now += 5 * 60 * MIN; // hours later, the record still reads the three minutes it worked
    assert.equal(phaseClocks(record, now).workedMs, (20 + 3) * MIN);
  } finally {
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * EE-2 — a stored run re-measured from its journal, once
 * ------------------------------------------------------------------ */

const session = (phase: number, mode: string, endMs: number, ms: number): LedgerLine =>
  ({ event: 'phase.session', phase, time: iso(endMs), data: { mode, ms } });

test('EE-2: a stored run’s resume, repair and closeout sessions become windows; its attempts and its PR do not', () => {
  const state = {
    phases: {
      '20': {
        phase: 20, status: 'done', attempts: 1, startedAt: iso(T0), attemptStartedAt: iso(T0),
        attemptEndedAt: iso(T0 + 13_000), durationMs: 12_800,
      } as Record<string, unknown>,
    },
  } as { clockModel?: number; phases: Record<string, Record<string, unknown>> };
  const lines = [
    session(20, 'phase', T0 + 13_000, 12_800),
    session(20, 'resume', T0 + 60 * MIN, 20 * MIN),
    session(20, 'closeout', T0 + 90 * MIN, 12 * MIN),
    session(20, 'pr', T0 + 100 * MIN, 9 * MIN),
    { event: 'phase.start', phase: 20, time: iso(T0), data: {} },
  ];
  const result = remeasureFromLedger(state, lines, T0 + 999 * MIN)!;
  assert.equal(result.sessions, 2);
  assert.equal(state.clockModel, CLOCK_MODEL);
  const worked = phaseClocks(state.phases['20'], T0 + 999 * MIN).workedMs!;
  assert.ok(Math.abs(worked - (13_000 + 32 * MIN)) < 1_000, `worked ${worked}`);
  assert.equal(state.phases['20']!.durationMs, worked);
  assert.deepEqual(result.phases['20']!.after, worked);
  // …and it is now EVIDENCE: 32 minutes of real sessions, not a 12.8 s closeout-finished record.
  assert.deepEqual(evidenceOf(state.phases['20']!, T0 + 999 * MIN), { durationMs: worked });
});

test('EE-2: the re-measure is once — the stamp makes a second pass a no-op', () => {
  const state = { phases: { '1': { phase: 1, status: 'done', durationMs: 30 * MIN } as Record<string, unknown> } } as {
    clockModel?: number; phases: Record<string, Record<string, unknown>>;
  };
  const lines = [session(1, 'resume', T0 + 60 * MIN, 10 * MIN)];
  assert.ok(remeasureFromLedger(state, lines));
  assert.equal(remeasureFromLedger(state, lines), null);
  assert.equal(phaseClocks(state.phases['1'], T0).workedMs, 40 * MIN);
});

test('EE-2: a session the door already timed is not added again', () => {
  const record: Record<string, unknown> = { phase: 2, status: 'done', attempts: 1, durationMs: 30 * MIN };
  openSessionWindow(record, 'resume', iso(T0 + 50 * MIN));
  closeAttemptWindow(record, iso(T0 + 60 * MIN));
  const before = phaseClocks(record, T0).workedMs;
  assert.equal(addSessionWindow(record, 'resume', T0 + 50 * MIN + 400, T0 + 60 * MIN + 3_000), false);
  const state = { phases: { '2': record } };
  remeasureFromLedger(state, [session(2, 'resume', T0 + 60 * MIN + 2_000, 10 * MIN)]);
  assert.equal(phaseClocks(record, T0).workedMs, before);
});

/* ------------------------------------------------------------------ *
 * EE-3 — what is not a measurement is left out, and counted
 * ------------------------------------------------------------------ */

test('EE-3: no time, near-zero and closeout-only completions are missing evidence, each with its reason', () => {
  const closeoutOnly: Record<string, unknown> = { phase: 4, status: 'done', attempts: 1, endedAt: iso(T0 + 5), durationMs: 5_000 };
  openSessionWindow(closeoutOnly, 'closeout', iso(T0));
  closeAttemptWindow(closeoutOnly, iso(T0 + 11 * MIN));
  const runs = [{
    phases: {
      '1': { phase: 1, status: 'done', endedAt: iso(T0 + 1), durationMs: 40 * MIN },
      '2': { phase: 2, status: 'done', endedAt: iso(T0 + 2) },
      '3': { phase: 3, status: 'done', endedAt: iso(T0 + 3), durationMs: 12_805 },
      '4': closeoutOnly as { phase: number; status: string; endedAt?: string },
      '5': { phase: 5, status: 'interrupted', endedAt: iso(T0 + 6), durationMs: 90 * MIN },
    },
  }];
  const weights = new Map([1, 2, 3, 4, 5].map((p) => [p, { weight: 40_000, size: 'M' as const }]));
  const evidence = etaEvidence(runs, weights, T0 + 999 * MIN);
  assert.deepEqual(evidence.samples.map((s) => s.durationMs), [40 * MIN]);
  assert.deepEqual(evidence.missing, [
    { phase: 2, reason: 'no-duration' },
    { phase: 3, reason: 'near-zero' },
    { phase: 4, reason: 'closeout-only' },
  ]);
  assert.deepEqual([...ETA_MISSING_REASONS].sort(), ['closeout-only', 'near-zero', 'no-duration']);
  assert.equal(ETA_MIN_EVIDENCE_MS, 5 * MIN);
});

test('EE-3: the missing count rides the reading to the estimate a surface prints', () => {
  const samples = [40, 44, 38].map((m, i) => ({ weight: 40_000, durationMs: m * MIN, at: iso(T0 + i), size: 'M' as const }));
  const eta = etaFrom(rateFor(samples, samples, { missing: 3 }), { weight: 80_000, phases: 2 })!;
  assert.equal(eta.missing, 3);
  assert.equal(eta.samples, 3);
});

/* ------------------------------------------------------------------ *
 * EE-4 / EE-5 — every figure names its clock; an unknown calendar says so
 * ------------------------------------------------------------------ */

test('EE-4: every remaining-time figure names working or calendar time', () => {
  assert.deepEqual([...ETA_CLOCKS], ['working', 'calendar']);
  const samples = [0, 3, 6, 9].map((h) => ({ weight: 40_000, durationMs: 60 * MIN, at: iso(T0 + h * 60 * MIN), size: 'M' as const }));
  const rate = rateFor(samples, samples);
  const eta = etaFrom(rate, { weight: 120_000, phases: 3 })!;
  const phase = phaseEtaFor(7, 40_000, rate);
  const forecast = forecastFrom(eta, dutyCycle(samples, T0 + 10 * 60 * MIN), T0 + 10 * 60 * MIN)!;
  assert.equal(eta.clock, 'working');
  assert.match(eta.label, / of work left$/);
  assert.equal(phase.clock, 'working');
  assert.match(phase.label, / of work$/);
  assert.equal(forecast.clock, 'calendar');
  assert.match(forecast.label, / on the calendar$/);
});

test('EE-5: an idle history reads unknown on the calendar — the working figure stands, no date is invented', () => {
  const idle = [0, 1, 2].map((d) => ({ weight: 40_000, durationMs: 6 * MIN, at: iso(T0 + d * 24 * 60 * MIN), size: 'M' as const }));
  const rate = rateFor(idle, idle);
  const eta = etaFrom(rate, { weight: 40_000, phases: 1 })!;
  const forecast = forecastFrom(eta, dutyCycle(idle, T0 + 2 * 24 * 60 * MIN), T0 + 2 * 24 * 60 * MIN)!;
  assert.equal(forecast.calendar, 'unknown');
  assert.equal(forecast.duty.reason, 'idle-history');
  assert.equal(forecast.label, 'calendar time unknown');
  assert.equal(forecast.expected, undefined);
  assert.equal(forecast.workingHighMs, eta.highMs);
});
