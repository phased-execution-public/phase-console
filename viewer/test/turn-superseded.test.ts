/**
 * The superseded predicate (turn-by-turn phase 7, §Architecture 5.2,
 * `server/runner/supersede.ts`) — SP-1..6, every case it accepts and every
 * one it refuses, by name:
 *
 *   SP-1  a stopped run is superseded by a later run of its plan — the newest
 *         that qualifies is named; an older run, the same run or another plan's
 *         supersedes nothing (`no-successor`);
 *   SP-2  a live run never is — something drives it, or a child of it still
 *         holds work (`live`); nor one still running, paused or finished
 *         (`not-stopped`);
 *   SP-3  an unlanded run and a stop about the plan never are (`unlanded`,
 *         `plan-halt`); nor one a person put back or dismissed (`reopened`,
 *         `dismissed`);
 *   SP-4  a successor a person dismissed is abandoned — no successor; a newer
 *         one that stands still is;
 *   SP-5  a scoped successor covers only what it holds: what the run still
 *         owes, after its records and the board, must be inside its
 *         `onlyPhases` — an unscoped run's debt is the plan's open phases;
 *   SP-6  the resolution names its successor, `auto: true`, reversible: the
 *         batch resolver writes it only when told what is live, and tells who
 *         asked; a run a person reopened is left alone.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { newRun, phaseRecord, resolveRunsAgainst } = await import('../server/runner/state.ts');
const { SUPERSEDE_REFUSALS, autoResolveSuperseded, outstandingPhases, supersedeReading, supersededBy } = await import('../server/runner/supersede.ts');
type RunState = import('../server/runner/state.ts').RunState;

const root = mkdtempSync(join(tmpdir(), 'pc-supersede-'));
const NEVER = () => false;

/** A run of `slug`, created at minute `m`, shaped by `over`. */
function run(m: number, over: (state: RunState) => void = () => {}, slug = 'alpha'): RunState {
  const state = newRun({ slug, root } as never);
  state.createdAt = new Date(Date.parse('2026-10-10T17:00:00Z') + m * 60_000).toISOString();
  over(state);
  return state;
}

const halted = (state: RunState) => {
  state.status = 'halted' as never;
  state.halt = { at: state.createdAt, reason: 'stopped', phase: 3, kind: 'operator-stop' } as never;
};
const refused = (a: RunState, runs: RunState[], facts = {}) => {
  const reading = supersedeReading(a, runs, { holdsWork: NEVER, ...facts });
  return reading.superseded ? null : reading.refused;
};

test('SP-1: a stopped run is superseded by a later run of its plan — the newest that qualifies; never by an older one, itself or another plan', () => {
  const a = run(0, halted);
  const b = run(31);
  const c = run(90);
  assert.equal(supersededBy(a, [a, b], { holdsWork: NEVER })?.id, b.id);
  assert.equal(supersededBy(a, [a, b, c], { holdsWork: NEVER })?.id, c.id, 'the newest that qualifies — the one still standing');
  const older = run(-30);
  assert.equal(refused(a, [a, older]), 'no-successor');
  assert.equal(refused(a, [a]), 'no-successor');
  assert.equal(refused(a, [a, run(40, () => {}, 'beta')]), 'no-successor', 'another plan\'s run is no successor');
  for (const kind of ['halted', 'parked', 'interrupted'] as const) {
    assert.equal(supersededBy(run(0, (s) => { s.status = kind as never; }), [b], { holdsWork: NEVER })?.id, b.id, `${kind} is stopped`);
  }
});

test('SP-2: a live run never is — driven, or a child still holding work — nor one running, paused or finished', () => {
  const a = run(0, halted);
  const b = run(31);
  assert.equal(refused(a, [b], { live: new Set([a.id]) }), 'live');
  assert.equal(refused(a, [b], { live: a.id }), 'live');
  const orphan = run(0, (s) => {
    halted(s);
    s.children = { 3: { pid: 4242, phase: 3, sessionId: 's', startedAt: s.createdAt } } as never;
  });
  assert.equal(refused(orphan, [b], { holdsWork: (pid: number) => pid === 4242 }), 'live', 'a frozen orphan still holds the tree');
  assert.equal(refused(orphan, [b]), null, 'a child that is gone holds nothing');
  for (const status of ['running', 'paused', 'finished', 'queued', 'waiting'] as const) {
    assert.equal(refused(run(0, (s) => { s.status = status as never; }), [b]), 'not-stopped', status);
  }
});

test('SP-3: an unlanded run, a stop about the plan, and a run a person put back or dismissed are never superseded', () => {
  const b = run(31);
  assert.equal(refused(run(0, (s) => { halted(s); s.halt!.kind = 'unlanded' as never; }), [b]), 'unlanded');
  for (const kind of ['plan-lint', 'plan-unreadable']) {
    assert.equal(refused(run(0, (s) => { halted(s); s.halt!.kind = kind as never; }), [b]), 'plan-halt', kind);
  }
  assert.equal(refused(run(0, (s) => { halted(s); s.reopenedAt = s.createdAt; }), [b]), 'reopened');
  assert.equal(refused(run(0, (s) => { halted(s); s.resolved = { at: s.createdAt, auto: false, reason: 'dismissed by the operator', by: 'operator' }; }), [b]), 'dismissed');
  // An automatic resolution is not a person's: the predicate still answers.
  assert.equal(refused(run(0, (s) => { halted(s); s.resolved = { at: s.createdAt, auto: true, reason: 'superseded — the board shows phase 3 done' }; }), [b]), null);
  assert.deepEqual([...SUPERSEDE_REFUSALS].sort(), ['dismissed', 'live', 'no-successor', 'not-stopped', 'plan-halt', 'reopened', 'unlanded']);
});

test('SP-4: a successor a person dismissed is abandoned; a newer run that stands still supersedes', () => {
  const a = run(0, halted);
  const dropped = run(31, (s) => { s.resolved = { at: s.createdAt, auto: false, reason: 'dismissed by the operator', by: 'operator' }; });
  assert.equal(refused(a, [a, dropped]), 'no-successor');
  const auto = run(45, (s) => { s.resolved = { at: s.createdAt, auto: true, reason: 'superseded — the board shows phase 4 done' }; });
  assert.equal(supersededBy(a, [a, dropped, auto], { holdsWork: NEVER })?.id, auto.id, 'a run the board settled is no abandoned run');
});

test('SP-5: a scoped successor covers only what it holds — the debt after the records and the board', () => {
  const scoped = run(0, (s) => { halted(s); s.onlyPhases = [3, 4]; });
  assert.deepEqual(outstandingPhases(scoped), [3, 4]);
  assert.equal(supersededBy(scoped, [run(31, (s) => { s.onlyPhases = [3, 4, 5]; })], { holdsWork: NEVER }) !== null, true);
  const disjoint = run(31, (s) => { s.onlyPhases = [4, 5]; });
  assert.equal(refused(scoped, [disjoint]), 'no-successor', 'a disjoint scope does not cover phase 3');
  // Phase 3 settled — on the run's record, or on the board — and phase 4 is all it owes.
  const doneHere = run(0, (s) => { halted(s); s.onlyPhases = [3, 4]; phaseRecord(s, 3).status = 'done' as never; });
  assert.deepEqual(outstandingPhases(doneHere), [4]);
  assert.equal(refused(doneHere, [disjoint]), null);
  assert.equal(refused(scoped, [disjoint], { board: { 3: 'done', 4: 'ready' } }), null);
  // An unscoped run owes the plan: without the plan's phases only an unscoped successor covers it.
  const whole = run(0, halted);
  assert.equal(outstandingPhases(whole), null);
  assert.equal(refused(whole, [disjoint]), 'no-successor');
  assert.equal(refused(whole, [run(31)]), null);
  // …with them, a scoped successor that holds every open one does.
  assert.equal(refused(whole, [disjoint], { planPhases: [1, 2, 3, 4, 5], board: { 1: 'done', 2: 'done', 3: 'done', 4: 'ready', 5: 'waiting' } }), null);
  assert.equal(refused(whole, [disjoint], { planPhases: [1, 2, 3, 4, 5], board: { 1: 'done', 2: 'done', 3: 'ready', 4: 'ready', 5: 'waiting' } }), 'no-successor');
});

test('SP-6: the resolution names its successor, auto and reversible; the batch resolver writes it only when told what is live', () => {
  const a = run(0, halted);
  const b = run(31);
  const at = new Date('2026-10-11T19:18:00Z');
  assert.equal(autoResolveSuperseded(a, [a, b], { holdsWork: NEVER }, at)?.id, b.id);
  assert.deepEqual(a.resolved, { at: at.toISOString(), auto: true, reason: `superseded by run ${b.id}`, supersededBy: b.id });
  assert.equal(autoResolveSuperseded(a, [a, b], { holdsWork: NEVER }), null, 'once resolved, nothing more is written');
  // The batch: a board for the plan, and the facts — or nothing is superseded.
  const boards = new Map([['alpha', { 1: 'done', 2: 'ready', 3: 'waiting' } as Record<number, string>]]);
  const c = run(0, (s) => { s.status = 'interrupted' as never; });
  const d = run(60);
  assert.deepEqual(resolveRunsAgainst([c, d], boards), [], 'no facts: no close');
  assert.equal(c.resolved ?? null, null);
  const told: [string, string][] = [];
  const changed = resolveRunsAgainst([c, d], boards, new Map(), { live: new Set(), superseded: (one, by) => told.push([one.id, by.id]) });
  assert.deepEqual(changed.map((one) => one.id), [c.id]);
  assert.equal(c.resolved?.reason, `superseded by run ${d.id}`);
  assert.deepEqual(told, [[c.id, d.id]]);
  // A run a person reopened stays theirs.
  const e = run(0, (s) => { s.status = 'halted' as never; s.reopenedAt = s.createdAt; });
  resolveRunsAgainst([e, d], boards, new Map(), { live: new Set() });
  assert.equal(e.resolved ?? null, null);
});
