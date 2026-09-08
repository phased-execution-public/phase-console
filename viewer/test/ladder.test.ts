/**
 * The remediation ladder — pure, and held to its promises: never the same
 * rung twice for one situation on one phase; refuses past the per-phase,
 * per-run and per-day caps by attempts AND dollars; skips what this console
 * cannot drive; an errand with a real `need` and `how` for every situation
 * (and every sub-kind that has a table); bookkeeping that old readers still
 * understand (`attempts`, `lastAt`, `lastOutcome` stay in step with `rungs`).
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SITUATIONS, SITUATION_ACTOR, SUB_KINDS, situationKey } from '../shared/situation-model.js';
import { MAX_RUNG_INTERRUPTIONS, countedRungs, triedRungKeys, untriedRungs } from '../shared/ladder-model.js';
import {
  DEFAULT_LADDER_CAPS, RUNGS_BY_SITUATION, RUNG_VEHICLES,
  accountRung, errandFor, ladderCaps, lastSettledRung, nextRung, progressExtension, rungKey, rungsFor, sameErrand, settleRung,
  type RecoverySlot,
} from '../server/runner/ladder.ts';
import type { RungRecord } from '../server/runner/state.ts';

const at = '2026-08-21T00:00:00.000Z';
const climbed = (situation: string, rung: string, costUsd = 0, params?: RungRecord['params']): RungRecord =>
  ({ situation, rung, at, costUsd, outcome: 'failed', ...(params ? { params } : {}) });

/* ------------------------------------------------------------------ *
 * Tables
 * ------------------------------------------------------------------ */

test('every rung names a known vehicle, a label and a blurb that states the cost', () => {
  for (const [key, rungs] of Object.entries(RUNGS_BY_SITUATION)) {
    for (const rung of rungs) {
      assert.ok((RUNG_VEHICLES as readonly string[]).includes(rung.vehicle), `${key}: ${rung.vehicle}`);
      assert.ok(rung.label.length > 3, key);
      assert.ok(rung.blurb.length > 40, `${key}/${rung.vehicle} must say what starts and what it costs`);
      assert.match(rung.blurb, /cost|free/i, `${key}/${rung.vehicle}`);
    }
  }
});

test('the measured specimens climb the right first rung', () => {
  assert.equal(rungsFor('never-started')[0].vehicle, 'reboard-fresh');
  assert.equal(rungsFor('work-in-progress')[0].vehicle, 'resume-own-session');
  assert.equal(rungsFor('work-in-progress')[0].params?.mode, 'continue');
  assert.equal(rungsFor('blocked-declared:unknown')[0].vehicle, 'unblock-session');
  assert.equal(rungsFor('done-unrecorded')[0].vehicle, 'closeout-own-session');
  assert.equal(rungsFor('verify-red')[0].vehicle, 'resume-own-session');
  assert.equal(rungsFor('verify-red')[1].vehicle, 'fix-agent');
  // QA climbs now. It used to be a person's — and a `pending` row that nothing
  // ever dispatches is not "a person's", it is a deadlock: the engine holds
  // every dependent behind a verdict no process will ever give. The independence
  // QA needs comes from the fresh-context SUBAGENT the session dispatches
  // (SKILL.md §QA), not from the session being a different one, so resuming the
  // phase's own session and asking it to run that subagent is the mechanism the
  // skill already prescribes.
  assert.equal(rungsFor('qa-pending')[0].vehicle, 'resume-own-session');
  assert.equal(rungsFor('qa-pending')[0].params?.mode, 'qa-verdict');
  assert.equal(rungsFor('qa-failed')[0].vehicle, 'resume-own-session');
  assert.equal(rungsFor('qa-failed')[0].params?.mode, 'qa-fix');
  assert.equal(rungsFor('qa-failed')[1].vehicle, 'fix-agent', 'a fresh agent when the session is gone');
  // A sub-kind without its own table falls back to the id's.
  assert.equal(rungsFor('blocked-declared:nonsense').length, 0, 'blocked-declared itself has no generic rung');
  assert.equal(rungsFor('plan-broken:lint')[0].vehicle, 'plan-repair-script');
});

/* ------------------------------------------------------------------ *
 * nextRung
 * ------------------------------------------------------------------ */

test('never the same rung twice for one situation on one phase — then exhaustion', () => {
  const situation = 'work-in-progress';
  const first = nextRung({ situation, history: [] });
  assert.ok(first.ok && first.rung.vehicle === 'resume-own-session' && first.index === 0);
  const second = nextRung({ situation, history: [climbed(situation, 'resume-own-session', 4, { mode: 'continue' })] });
  assert.ok(second.ok && second.rung.vehicle === 'reboard-resume-brief' && second.index === 1);
  // The escalated step of the same vehicle is a DIFFERENT rung (params differ).
  const third = nextRung({ situation, history: [
    climbed(situation, 'resume-own-session', 4, { mode: 'continue' }),
    climbed(situation, 'reboard-resume-brief', 9),
  ] });
  assert.ok(third.ok && third.rung.vehicle === 'reboard-resume-brief' && third.rung.params?.escalate === 'model');
  const done = nextRung({ situation, history: [
    climbed(situation, 'resume-own-session', 4, { mode: 'continue' }),
    climbed(situation, 'reboard-resume-brief', 9),
    climbed(situation, 'reboard-resume-brief', 9, { escalate: 'model' }),
  ], caps: { perPhaseRungs: 10 } });
  assert.equal(done.ok, false);
  assert.equal(!done.ok && done.exhausted, true);
  assert.match(!done.ok ? done.reason : '', /every rung .* has been tried/);
  // A rung climbed for ANOTHER situation on this phase does not count as tried for this one.
  const other = nextRung({ situation, history: [climbed('verify-red', 'resume-own-session', 4, { mode: 'fix-verification' })] });
  assert.ok(other.ok && other.rung.vehicle === 'resume-own-session');
  assert.notEqual(rungKey('verify-red', { vehicle: 'resume-own-session', params: { mode: 'fix-verification' } }),
    rungKey('work-in-progress', { vehicle: 'resume-own-session', params: { mode: 'continue' } }));
});

test('caps refuse by attempts AND dollars — per phase, per run, per day', () => {
  const situation = 'never-started';
  // Per-phase rungs: three climbed (on any situation) is the default cap.
  const phaseRungs = nextRung({ situation, history: [climbed('a', 'x'), climbed('b', 'y'), climbed('c', 'z')] });
  assert.equal(phaseRungs.ok, false);
  assert.match(!phaseRungs.ok ? phaseRungs.reason : '', /phase's ladder budget is spent \(3 of 3 rungs\)/);
  // Per-phase dollars.
  const phaseUsd = nextRung({ situation, history: [climbed('a', 'x', 100)] });
  assert.match(!phaseUsd.ok ? phaseUsd.reason : '', /phase's ladder budget is spent \(\$100\.00 of \$100\)/);
  // Per-run rungs count every phase's rungs together.
  const runRungs = nextRung({ situation, history: [], runHistory: Array.from({ length: 10 }, (_, i) => climbed('a', `r${i}`)) });
  assert.match(!runRungs.ok ? runRungs.reason : '', /run's ladder budget is spent \(10 of 10 rungs\)/);
  // Per-run dollars.
  const runUsd = nextRung({ situation, history: [], runHistory: [climbed('a', 'x', 250), climbed('b', 'y', 150)] });
  assert.match(!runUsd.ok ? runUsd.reason : '', /run's ladder budget is spent \(\$400\.00 of \$400\)/);
  // Per-day dollars, when the caller knows the day.
  const dayUsd = nextRung({ situation, history: [], dayHistory: [climbed('a', 'x', 600)] });
  assert.match(!dayUsd.ok ? dayUsd.reason : '', /today's ladder budget is spent/);
  // Under every cap it climbs; the caps are prefs.
  assert.ok(nextRung({ situation, history: [climbed('a', 'x', 99.99)], runHistory: [climbed('a', 'x', 99.99)], dayHistory: [] }).ok);
  assert.ok(nextRung({ situation, history: [climbed('a', 'x'), climbed('b', 'y'), climbed('c', 'z')], caps: { perPhaseRungs: 4 } }).ok);
  // Unknown costs count as zero — a cap is never tripped by a missing number.
  assert.ok(nextRung({ situation, history: [{ situation: 'a', rung: 'x', at }] }).ok);
});

test('a vehicle this console cannot drive is skipped, and the reason says so when nothing else is left', () => {
  const situation = 'plan-broken:verification';
  const only = nextRung({ situation, history: [], available: (rung) => rung.vehicle !== 'plan-repair-script' });
  assert.ok(only.ok && only.rung.vehicle === 'plan-repair-agent');
  const none = nextRung({ situation, history: [], available: () => false });
  assert.equal(none.ok, false);
  assert.match(!none.ok ? none.reason : '', /no rung for plan-broken:verification is available on this console yet/);
  assert.equal(!none.ok && none.exhausted, true);
});

test('a person\'s situation and a wait are refused without being "exhausted"; nothing-wrong says so', () => {
  const person = nextRung({ situation: 'gated-manual', history: [] });
  assert.equal(person.ok, false);
  assert.equal(!person.ok && person.exhausted, false);
  assert.match(!person.ok ? person.reason : '', /person's to settle/);
  const wait = nextRung({ situation: 'foreign-live', history: [] });
  assert.equal(!wait.ok && wait.exhausted, false);
  assert.match(!wait.ok ? wait.reason : '', /settles itself/);
  const none = nextRung({ situation: 'superseded', history: [] });
  assert.match(!none.ok ? none.reason : '', /nothing is wrong/);
  // A machine's situation with an empty sub-table IS exhausted (credential/gate blockers go straight to the errand).
  const cred = nextRung({ situation: 'blocked-declared:credential', history: [] });
  assert.equal(!cred.ok && cred.exhausted, true);
});

/* ------------------------------------------------------------------ *
 * Caps from prefs
 * ------------------------------------------------------------------ */

test('ladderCaps reads the five prefs and defaults anything unusable', () => {
  assert.deepEqual(ladderCaps(undefined), DEFAULT_LADDER_CAPS);
  assert.deepEqual(ladderCaps({ ladderPerPhaseUsd: 25, ladderPerRunRungs: -3, ladderPerDayUsd: Number.NaN }), {
    ...DEFAULT_LADDER_CAPS, perPhaseUsd: 25,
  });
  assert.equal(ladderCaps({ ladderPerPhaseRungs: 0 }).perPhaseRungs, 0, 'zero is a legal cap: nothing climbs');
  assert.equal(nextRung({ situation: 'never-started', history: [], caps: ladderCaps({ ladderPerPhaseRungs: 0 }) }).ok, false);
});

/* ------------------------------------------------------------------ *
 * Bookkeeping
 * ------------------------------------------------------------------ */

test('accountRung records BEFORE the climb and keeps the legacy counters in step; settleRung closes it', () => {
  const slot: RecoverySlot = { attempts: 0, lastAt: 'old', errand: { phase: 2, situation: 'x', tried: [], need: 'n', how: 'h', at } };
  const rung = accountRung(slot, { situation: 'work-in-progress', rung: 'resume-own-session', params: { mode: 'continue' }, at });
  assert.equal(slot.attempts, 1);
  assert.equal(slot.lastAt, at);
  assert.equal(slot.errand, undefined, 'a climb clears the standing errand');
  assert.deepEqual(slot.rungs, [{ situation: 'work-in-progress', rung: 'resume-own-session', at, outcome: 'running', params: { mode: 'continue' } }]);
  assert.equal(rung, slot.rungs![0]);
  // Settling the open rung: outcome, cost, and the old-reader fields.
  const settled = settleRung(slot, 'fixed', 12.5, 'the board reads done');
  assert.equal(settled, rung);
  assert.equal(rung.outcome, 'fixed');
  assert.equal(rung.costUsd, 12.5);
  assert.equal(slot.fixed, true);
  assert.equal(slot.lastOutcome, 'fixed');
  // Nothing open: null, and nothing changes.
  assert.equal(settleRung(slot, 'failed'), null);
  // The next climb is a new entry; a failed settle marks lastOutcome without claiming fixed.
  accountRung(slot, { situation: 'work-in-progress', rung: 'reboard-resume-brief', at });
  settleRung(slot, 'failed', 3);
  assert.equal(slot.rungs!.length, 2);
  assert.equal(slot.lastOutcome, 'failed');
  assert.equal(slot.attempts, 2);
  // The next rung for the situation now skips both.
  const next = nextRung({ situation: 'work-in-progress', history: slot.rungs! });
  assert.ok(next.ok && next.rung.params?.escalate === 'model');
});

/* ------------------------------------------------------------------ *
 * Errands
 * ------------------------------------------------------------------ */

test('errandFor yields {situation, tried, need, how} with non-empty need/how for EVERY situation and sub-kind', () => {
  for (const id of SITUATIONS) {
    const keys = [id, ...((SUB_KINDS[id] ?? []).map((sub) => situationKey(id, sub)))];
    for (const key of keys) {
      const errand = errandFor(key, [], 4, at);
      assert.equal(errand.phase, 4);
      assert.equal(errand.situation, key);
      assert.deepEqual(errand.tried, []);
      assert.ok(errand.need.trim().length > 10, `${key} need`);
      assert.ok(errand.how.trim().length > 10, `${key} how`);
      assert.equal(errand.at, at);
    }
  }
  // `tried` names the rungs already climbed so nobody repeats them by hand.
  const errand = errandFor('work-in-progress', [
    climbed('work-in-progress', 'resume-own-session', 4, { mode: 'continue' }),
    'reboard-resume-brief',
  ], 2, at);
  assert.deepEqual(errand.tried, ['resume-own-session (continue) → failed', 'reboard-resume-brief']);
  // An unknown key reads as unknown — never throws.
  assert.equal(errandFor('whatever').situation, 'unknown');
});

/* ------------------------------------------------------------------ *
 * One table, three readers
 * ------------------------------------------------------------------ */

import * as SHARED_LADDER from '../shared/ladder-model.js';
import * as CLIENT_LADDER from '../client/src/lib/ladder.ts';

test('server, client and the shared module hold the SAME rung table and vehicle list — by identity', () => {
  assert.equal(RUNGS_BY_SITUATION, SHARED_LADDER.RUNGS_BY_SITUATION, 'server table is the shared object');
  assert.equal(CLIENT_LADDER.RUNGS_BY_SITUATION, SHARED_LADDER.RUNGS_BY_SITUATION, 'client table is the shared object');
  assert.equal(RUNG_VEHICLES, SHARED_LADDER.RUNG_VEHICLES);
  assert.equal(CLIENT_LADDER.RUNG_VEHICLES, SHARED_LADDER.RUNG_VEHICLES);
  assert.equal(DEFAULT_LADDER_CAPS, SHARED_LADDER.DEFAULT_LADDER_CAPS);
  // Every rung names a vehicle the vocabulary lists; every situation has a row.
  for (const [key, rungs] of Object.entries(SHARED_LADDER.RUNGS_BY_SITUATION)) {
    for (const rung of rungs) assert.ok(SHARED_LADDER.RUNG_VEHICLES.includes(rung.vehicle), `${key}: ${rung.vehicle}`);
  }
  // Every situation has a table — by its id, or by every one of its sub-kinds
  // (`resource-wall` and `blocked-declared` branch per sub-kind and have no bare row).
  for (const id of SITUATIONS) {
    const keys = Object.keys(SHARED_LADDER.RUNGS_BY_SITUATION);
    assert.ok(keys.includes(id) || keys.some((k) => k.startsWith(`${id}:`)), `${id} has a rung table (possibly empty)`);
  }
});

test('the shared helpers say what a climbed rung is called and what comes next', () => {
  assert.equal(SHARED_LADDER.rungLabel('resume-own-session', { mode: 'continue' }), 'Continue in its own session');
  assert.equal(SHARED_LADDER.rungLabel('reboard-resume-brief', { escalate: 'model' }), 'Board fresh, stronger');
  assert.equal(SHARED_LADDER.rungLabel('no-such-vehicle'), 'no such vehicle');
  const next = SHARED_LADDER.untriedRungs('work-in-progress', [
    { situation: 'work-in-progress', rung: 'resume-own-session', params: { mode: 'continue' } },
  ]);
  assert.equal(next[0].label, 'Board fresh with a resume brief');
  // QA has rungs now (see the deadlock note above): the phase's own session
  // first, a fresh review when that session is gone — and once both are
  // climbed the walk is empty, which is when the errand is written.
  assert.equal(SHARED_LADDER.untriedRungs('qa-pending', [])[0]?.params?.mode, 'qa-verdict');
  const afterResume = SHARED_LADDER.untriedRungs('qa-pending', [
    { situation: 'qa-pending', rung: 'resume-own-session', params: { mode: 'qa-verdict' } },
  ]);
  assert.equal(afterResume[0]?.params?.mode, 'qa-review');
  assert.deepEqual(
    SHARED_LADDER.untriedRungs('qa-pending', [
      { situation: 'qa-pending', rung: 'resume-own-session', params: { mode: 'qa-verdict' } },
      { situation: 'qa-pending', rung: 'fix-agent', params: { mode: 'qa-review' } },
    ]),
    [],
  );
  // And `nextRung` (caps and all) agrees with the shared walk on what is next.
  const chosen = nextRung({ situation: 'work-in-progress', history: [
    { situation: 'work-in-progress', rung: 'resume-own-session', params: { mode: 'continue' }, at: 'x', outcome: 'failed' },
  ] });
  assert.ok(chosen.ok && chosen.rung.label === 'Board fresh with a resume brief');
});

test('QA situations are the ladder\'s to climb, and only then a person\'s', () => {
  // The measured deadlock: a plan with QA on finishes a phase, `new-handoff.sh`
  // writes `| N | pending | - |`, `_is_verified` accepts only pass|waived, and
  // NOTHING in the system ever dispatches QA. Six phases were held behind a
  // verdict no process would ever give, for ever, with no defect recorded
  // anywhere. "A person's to settle" is the right word for a decision; it is the
  // wrong word for a chore nobody scheduled.
  assert.equal(SITUATION_ACTOR['qa-pending'], 'machine');
  assert.equal(SITUATION_ACTOR['qa-failed'], 'machine');

  // And the errand still exists for when the climb runs out — a verdict the
  // ladder could not produce is genuinely a person's.
  for (const key of ['qa-pending', 'qa-failed']) {
    const errand = errandFor(key, [], 3);
    assert.match(errand.need, /QA verdict/);
    assert.equal(errand.phase, 3);
  }
});

test('QA has a round budget of its own, which the generic caps could never express', () => {
  // Issue #7 §3. `state.consecutiveFailures` counts phase ATTEMPT failures and a
  // `fail` VERDICT never touched it; the `ladder*` caps count rungs and dollars,
  // and a round driven from inside a phase's own session is neither. So nothing
  // bounded rounds at all — one phase on the run that issue was written from
  // reached five, under a table with two rungs.
  const failed = (n: number) => Array.from({ length: n }, (_, i) => ({
    situation: 'qa-failed', rung: 'resume-own-session', params: { mode: 'qa-fix' },
    at: `t${i}`, outcome: 'failed' as const,
  }));

  // Under budget: the ladder still climbs.
  const under = nextRung({ situation: 'qa-failed', history: [], qaRounds: 1, qaMaxRounds: 2 });
  assert.ok(under.ok, `a phase inside its round budget still climbs: ${JSON.stringify(under)}`);

  // At budget: exhausted, and the reason names QA rather than a generic total —
  // "the phase's ladder budget is spent" would send a reader to the wrong knob.
  const spent = nextRung({ situation: 'qa-failed', history: [], qaRounds: 2, qaMaxRounds: 2 });
  assert.equal(spent.ok, false);
  assert.ok(!spent.ok && spent.exhausted, 'exhausted, so the phase parks with an errand');
  assert.ok(!spent.ok && /QA has failed 2 of the 2 rounds/.test(spent.reason), spent.ok ? '' : spent.reason);

  // It bounds `qa-failed` alone. `qa-pending` is a verdict that was never given,
  // and refusing to ask for one because earlier rounds failed would leave the
  // phase held by a row nobody will ever fill.
  const pending = nextRung({ situation: 'qa-pending', history: [], qaRounds: 9, qaMaxRounds: 2 });
  assert.ok(pending.ok, 'a pending verdict is still chased');

  // Absent — every run file written before the budget existed — means uncounted.
  const uncounted = nextRung({ situation: 'qa-failed', history: [], qaRounds: 9 });
  assert.ok(uncounted.ok, 'no budget stated, so the old behaviour stands');

  // And it does not displace the generic caps: a phase out of RUNGS is still out.
  const outOfRungs = nextRung({
    situation: 'qa-failed', history: failed(3), qaRounds: 0, qaMaxRounds: 99,
  });
  assert.equal(outOfRungs.ok, false);
});

test('the QA budget counts FAILED rounds, and the errand names the budget in force', () => {
  // QA round 1 of this phase found both halves. The setting is "QA may FAIL N
  // rounds", and the caller was spending it on `qa[].length` — which counts
  // passes, waivers and the synthetic entry pushed when a reviewer records
  // nothing. Because `qa[]` survives `resetForRetry`, a phase could park on its
  // FIRST real fail under a message claiming three had failed (F3). And the
  // errand only quoted a budget the run had EXPLICITLY stored, so on every run
  // that took the default — most of them — the headline fell back to the
  // generic ask (F4).
  const spent = nextRung({ situation: 'qa-failed', history: [], qaRounds: 2, qaMaxRounds: 2 });
  assert.ok(!spent.ok && /QA has failed 2 of the 2 rounds/.test(spent.reason), spent.ok ? '' : spent.reason);

  const errand = errandFor('qa-failed', [], 5, undefined, undefined, null, {
    rounds: 2, max: 2, report: 'reports/phase-05-qa-round2.md',
  });
  assert.match(errand.need, /failed 2 of the 2 rounds/);
  assert.match(errand.how, /reports\/phase-05-qa-round2\.md/);

  // Below the budget the ask stays the table's own sentence — a phase with one
  // recorded fail is not a phase the run has given up on.
  const early = errandFor('qa-failed', [], 5, undefined, undefined, null, {
    rounds: 1, max: 3, report: 'reports/phase-05-qa.md',
  });
  assert.match(early.need, /QA verdict/);
  assert.match(early.how, /reports\/phase-05-qa\.md/, 'but it still names the report to open');
});

test('a spent QA budget asks for the report that describes the code as it stands', () => {
  // The static ask says "fix what the QA report names", and after three rounds
  // there are three of them with only the newest still describing the code.
  const errand = errandFor('qa-failed', [], 7, undefined, undefined, null, {
    rounds: 3, max: 3, report: 'reports/phase-07-qa-round3.md',
  });
  assert.match(errand.need, /failed 3 of the 3 rounds/);
  assert.match(errand.how, /reports\/phase-07-qa-round3\.md/);
  assert.equal(errand.phase, 7);

  // With no rounds recorded it is the table's own sentence, unchanged.
  assert.match(errandFor('qa-failed', [], 7).need, /QA verdict/);
});

test('a machine situation always has something to climb', () => {
  // The invariant the QA gap broke, in the one direction that is actually an
  // invariant: an actor of `machine` PROMISES the ladder will try something, and
  // an empty rung list under that promise is a silent dead end — the console
  // refuses, writes nothing (a machine's exhaustion is not a person's ask), and
  // the run sits. `qa-pending` was exactly that for months.
  //
  // The converse is deliberately NOT asserted: `waiting-external` carries a free
  // `recheck-watch` rung while remaining a `wait`, which is correct — re-reading
  // a watch ref spends nothing and settles the wait sooner.
  for (const id of SITUATIONS) {
    if (SITUATION_ACTOR[id] !== 'machine') continue;
    if (rungsFor(id).length) continue;
    const subs = SUB_KINDS[id] ?? [];
    assert.ok(
      subs.length > 0 && subs.some((sub) => rungsFor(`${id}:${sub}`).length > 0),
      `${id} promises the ladder will act and offers it nothing to climb`,
    );
  }
});

test('a rung label belongs to the situation it was climbed for', () => {
  // `verify-red` and `qa-failed` both climb `fix-agent`, and only the first
  // carries params. Resolving the exact-params pass across every table before
  // the loose one let the paramless one — earlier in the object — answer for
  // both, so the Pulse read "Fix what QA found" about a red verification.
  assert.equal(SHARED_LADDER.rungLabel('fix-agent', undefined, 'verify-red'), 'Fix with a stronger new agent');
  assert.equal(SHARED_LADDER.rungLabel('fix-agent', { escalate: 'model' }, 'verify-red'), 'Fix with a stronger new agent');
  assert.equal(SHARED_LADDER.rungLabel('fix-agent', undefined, 'qa-failed'), 'Fix what QA found with a new agent');
  // The same rule for the vehicle two QA situations share with work-in-progress.
  assert.equal(SHARED_LADDER.rungLabel('resume-own-session', { mode: 'qa-fix' }, 'qa-failed'), 'Fix what QA found, then re-record');
  assert.equal(SHARED_LADDER.rungLabel('resume-own-session', { mode: 'continue' }, 'work-in-progress'), 'Continue in its own session');
  // With no situation at all it still beats the raw id.
  assert.notEqual(SHARED_LADDER.rungLabel('fix-agent'), 'fix agent');
});

/* ------------------------------------------------------------------ *
 * Standing errands, and the one extension (console-parallel-repaint P12)
 * ------------------------------------------------------------------ */

test('sameErrand: a fresh clock or a quoted exit is the same ask; changed words, phase, situation or tried are not', () => {
  const base = errandFor('gated-manual', [], 4, at);
  assert.equal(sameErrand(undefined, base), false, 'nothing stands yet');
  assert.equal(sameErrand(null, base), false);
  assert.equal(sameErrand(base, { ...base, at: '2026-08-22T00:00:00.000Z' }), true, 'a fresh clock is the same ask');
  assert.equal(sameErrand(base, { ...base, said: 'quoted' }), true, 'the quoted exit rides the errand it arrived on');
  assert.equal(sameErrand(base, { ...base, need: 'something else' }), false);
  assert.equal(sameErrand(base, { ...base, how: 'another door' }), false);
  assert.equal(sameErrand(base, { ...base, situation: 'qa-pending' }), false);
  assert.equal(sameErrand(base, { ...base, phase: 5 }), false);
  assert.equal(sameErrand(base, { ...base, tried: ['reboard-fresh → failed'] }), false, 'a rung climbed since is news');
  assert.equal(sameErrand({ ...base, tried: ['a', 'b'] }, { ...base, tried: ['a', 'b'] }), true);
  assert.equal(sameErrand({ ...base, tried: ['a', 'b'] }, { ...base, tried: ['b', 'a'] }), false, 'order is the climb order');
  assert.equal(sameErrand({ ...base, earlier: ['x'] }, { ...base }), false);
  assert.equal(sameErrand({ ...base, earlier: ['x'] }, { ...base, earlier: ['x'] }), true);
});

test('progressExtension: one more rung against the RUNG cap alone — once per phase, only with commits, only when switched on', () => {
  const caps = { ...DEFAULT_LADDER_CAPS };
  // Three rungs on this phase across two situations: the count is spent while
  // work-in-progress still has untried rungs in its table.
  const history = [
    climbed('verify-red', 'resume-own-session', 4, { mode: 'fix-verification' }),
    climbed('verify-red', 'fix-agent', 9, { escalate: 'model' }),
    climbed('work-in-progress', 'resume-own-session', 3, { mode: 'continue' }),
  ];
  const spent = nextRung({ situation: 'work-in-progress', history, caps });
  assert.equal(spent.ok, false);
  assert.match(spent.ok ? '' : spent.reason, /3 of 3 rungs/);
  assert.deepEqual(progressExtension(spent, {}, caps, true, true), { perPhaseRungs: 4 });
  assert.equal(progressExtension(spent, {}, caps, true, false), null, 'off by default');
  assert.equal(progressExtension(spent, {}, caps, false, true), null, 'nothing landed — the count is the count');
  assert.equal(
    progressExtension(spent, { extended: { at, commits: 1, since: at, situation: 'work-in-progress' } }, caps, true, true),
    null, 'once per phase',
  );
  // The widened caps hand the ladder its next untried rung.
  const again = nextRung({ situation: 'work-in-progress', history, caps: { ...caps, perPhaseRungs: 4 } });
  assert.equal(again.ok, true);
  assert.equal(again.ok ? again.rung.vehicle : null, 'reboard-resume-brief');
  // A spent DOLLAR cap stands: money that was spent was spent.
  const usd = nextRung({ situation: 'work-in-progress', history: [climbed('work-in-progress', 'resume-own-session', 100)], caps });
  assert.match(usd.ok ? '' : usd.reason, /\$100\.00 of \$100/);
  assert.equal(progressExtension(usd, {}, caps, true, true), null, 'a spent DOLLAR cap stands');
  // Nothing to extend while a rung is still climbable, or when the table is simply exhausted.
  const open = nextRung({ situation: 'work-in-progress', history: [], caps });
  assert.equal(open.ok, true);
  assert.equal(progressExtension(open, {}, caps, true, true), null);
  const table = nextRung({ situation: 'blocked-declared:unknown', history: [climbed('blocked-declared:unknown', 'unblock-session')], caps });
  assert.match(table.ok ? '' : table.reason, /every rung/);
  assert.equal(progressExtension(table, {}, caps, true, true), null, 'a table with nothing left is not a count to widen');
});

test('lastSettledRung: the newest rung that ran and ended — never one still running or one the console died under', () => {
  const settled: RungRecord = { situation: 'verify-red', rung: 'resume-own-session', at: '2026-08-21T01:00:00.000Z', outcome: 'failed' };
  const interrupted: RungRecord = { situation: 'verify-red', rung: 'fix-agent', at: '2026-08-21T02:00:00.000Z', outcome: 'interrupted' };
  const running: RungRecord = { situation: 'verify-red', rung: 'fix-agent', at: '2026-08-21T03:00:00.000Z', outcome: 'running' };
  assert.equal(lastSettledRung(undefined), null);
  assert.equal(lastSettledRung({ rungs: [] }), null);
  assert.equal(lastSettledRung({ rungs: [settled, interrupted, running] }), settled);
  assert.equal(lastSettledRung({ rungs: [settled, { ...interrupted, outcome: 'fixed' }] })?.at, interrupted.at);
});

/* ------------------------------------------------------------------ *
 * Interruptions are bounded
 * ------------------------------------------------------------------ */

test('a rung cut short climbs again ONCE — a streak of interruptions counts as tried, and as spend', () => {
  // Measured (run 31285928, phase 3): nineteen `resume-own-session {qa-fix}`
  // rungs in 47 minutes, every one settled `interrupted` at zero turns because
  // `--resume` could not find the session's transcript. `interrupted` was
  // exempt from the same-rung-once rule AND from every numeric cap, so the
  // ladder offered the identical rung for ever. "Cut short — it can run again"
  // must mean once, not without limit.
  const situation = 'qa-failed';
  const cut = (n: number): RungRecord[] => Array.from({ length: n }, (_, i) => ({
    situation, rung: 'resume-own-session', params: { mode: 'qa-fix' },
    at: `2026-09-06T05:${String(15 + i).padStart(2, '0')}:00.000Z`, outcome: 'interrupted' as const, turns: 0,
  }));
  const key = rungKey(situation, { vehicle: 'resume-own-session', params: { mode: 'qa-fix' } });

  // One interruption: the console died under it, or it was restarted — the
  // same rung runs again, and it costs no rung of the caps.
  assert.equal(MAX_RUNG_INTERRUPTIONS, 2);
  assert.deepEqual([...triedRungKeys(cut(1))], []);
  assert.equal(countedRungs(cut(1)).length, 0);
  const once = nextRung({ situation, history: cut(1) });
  assert.ok(once.ok && once.rung.vehicle === 'resume-own-session', 'one interruption re-climbs the same rung');

  // Two in a row: the rung has been TRIED — the ladder moves to the next one.
  assert.deepEqual([...triedRungKeys(cut(2))], [key]);
  assert.equal(countedRungs(cut(2)).length, 2, 'the streak that consumed the rung counts toward the caps');
  const twice = nextRung({ situation, history: cut(2) });
  assert.ok(twice.ok && twice.rung.vehicle === 'fix-agent', `two interruptions move on: ${JSON.stringify(twice)}`);

  // Three: the phase's ladder budget (3 rungs) is spent — a person is asked.
  const thrice = nextRung({ situation, history: cut(3) });
  assert.equal(thrice.ok, false);
  assert.match(!thrice.ok ? thrice.reason : '', /ladder budget is spent \(3 of 3 rungs\)/);

  // The specimen itself: nineteen, never the twentieth.
  const specimen = nextRung({ situation, history: cut(19) });
  assert.equal(specimen.ok, false);
  assert.equal(!specimen.ok && specimen.exhausted, true);

  // A streak broken by a rung that RAN is not a streak: interrupted, failed,
  // interrupted is one tried rung (the failure) and one free interruption.
  const broken = [cut(1)[0], { ...cut(1)[0], outcome: 'failed' as const, turns: 12 }, cut(1)[0]];
  assert.equal(countedRungs(broken).length, 1);
  assert.deepEqual([...triedRungKeys(broken)], [key]);

  // The card's "next: …" reads the same helper, so it never promises a rung
  // the runner then refuses.
  assert.deepEqual(untriedRungs(situation, cut(1)).map((r) => r.vehicle), ['resume-own-session', 'fix-agent']);
  assert.deepEqual(untriedRungs(situation, cut(2)).map((r) => r.vehicle), ['fix-agent']);
});

test('qa-pending has a second rung — a fresh review — for a phase whose own session is gone', () => {
  // One-rung tables end in an errand the moment their rung cannot run. For
  // `qa-pending` that rung is "resume the phase's own session", and the
  // measured way it cannot run is a transcript the account paying cannot see:
  // the plan then parked on "run QA from the phase page" for a review the
  // console could have boarded itself, fresh, from the boot prompt.
  const table = rungsFor('qa-pending');
  assert.equal(table.length, 2);
  assert.equal(table[0].vehicle, 'resume-own-session', 'the cheap rung first: the session that has the context');
  assert.equal(table[1].vehicle, 'fix-agent');
  assert.equal(table[1].params?.mode, 'qa-review');
  assert.match(table[1].blurb, /cost/i);
  // Its params keep it a DIFFERENT rung from `qa-failed`'s paramless
  // `fix-agent`, so a label lookup never crosses the tables.
  assert.notEqual(rungKey('qa-pending', table[1]), rungKey('qa-failed', rungsFor('qa-failed')[1]));
  // Once the own-session rung has been tried, it is what comes next.
  const next = nextRung({
    situation: 'qa-pending',
    history: [climbed('qa-pending', 'resume-own-session', 0, { mode: 'qa-verdict' })],
  });
  assert.ok(next.ok && next.rung.vehicle === 'fix-agent' && next.rung.params?.mode === 'qa-review', JSON.stringify(next));
});
