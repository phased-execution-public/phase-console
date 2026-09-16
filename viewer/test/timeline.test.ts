/**
 * The time axis, and the attempt comparison.
 *
 * The claim this file has to keep honest is exit criterion 1: *the bars match
 * the journal's timestamps.* That is only checkable if nothing in the
 * projection is modelled — so the tests are written as "this entry at this
 * time produces a bar with exactly these edges", and a projection that started
 * guessing durations from a record field would fail them.
 *
 * The three that matter most are the ones a plausible implementation gets
 * wrong:
 *
 *   1. **an open bar is OPEN.** A bar with no terminal event must close at the
 *      horizon and say so, not silently become a finished bar with a
 *      convenient end time.
 *   2. **money is per attempt, not cumulative.** `phase.done` carries the
 *      phase's running total; only `phase.session` carries what one boarding
 *      spent. Summing the wrong one makes attempt 2 look like it cost what
 *      both attempts cost together.
 *   3. **an absent figure stays absent.** A boarding with no session recorded
 *      has `costUsd: null`, never `0` — `$0.00` reads as "this was free".
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  projectTimeline, attemptsOf, compareAttempts, compareConsecutive, criticalLane,
} from '../server/analysis/timeline.ts';
import type { JournalEntry } from '../server/runner/journal.ts';

const T0 = Date.parse('2026-08-24T10:00:00.000Z');
const MIN = 60_000;

let seq = 0;
/** One journal line, `min` minutes after the run's first entry. */
const at = (min: number, event: string, phase?: number, data?: Record<string, unknown>): JournalEntry => ({
  seq: ++seq,
  time: new Date(T0 + min * MIN).toISOString(),
  event,
  ...(phase === undefined ? {} : { phase }),
  ...(data ? { data } : {}),
});

/** A phase that boarded, verified and finished: 0 → 30 min. */
const CLEAN: JournalEntry[] = [
  at(0, 'run.start'),
  at(0, 'phase.start', 1, { model: 'claude-opus-5' }),
  at(20, 'phase.awaiting-verification', 1),
  at(25, 'phase.verify', 1, { ok: true, ran: [{ command: 'npm test', code: 0, ms: 300_000 }] }),
  at(30, 'phase.done', 1, { costUsd: 1.5, attempts: 1 }),
  at(30, 'run.finished'),
];

/* ------------------------------------------------------------------ *
 * projectTimeline — the bars ARE the journal
 * ------------------------------------------------------------------ */

test('every bar edge is a journal timestamp, to the millisecond', () => {
  const timeline = projectTimeline(CLEAN);
  const [lane] = timeline.lanes;
  assert.ok(lane);
  assert.equal(lane.phase, 1);
  assert.equal(timeline.startedAt, new Date(T0).toISOString());
  assert.equal(timeline.spanMs, 30 * MIN);

  // working 0→20 (boarding to verification), verifying 20→25, working 25→30.
  assert.deepEqual(
    lane.bars.map((bar) => [bar.kind, bar.startMs, bar.endMs, bar.open]),
    [
      ['working', 0, 20 * MIN, false],
      ['verifying', 20 * MIN, 25 * MIN, false],
      ['working', 25 * MIN, 30 * MIN, false],
    ],
  );
  assert.equal(lane.workingMs, 25 * MIN);
  assert.equal(lane.verifyingMs, 5 * MIN);
  assert.equal(lane.totalMs, 30 * MIN);
  assert.equal(lane.attempts, 1);
  assert.equal(lane.partial, false);
});

test('a finished run ends where its journal ends; a live one has no end, only a horizon', () => {
  const finished = projectTimeline(CLEAN);
  assert.equal(finished.endedAt, new Date(T0 + 30 * MIN).toISOString());
  assert.equal(finished.horizonAt, finished.endedAt);

  // Same journal, no `run.finished`, looked at an hour later.
  const live = projectTimeline(CLEAN.filter((e) => e.event !== 'run.finished'), { now: T0 + 90 * MIN });
  assert.equal(live.endedAt, null, 'a run still going has not ended');
  assert.equal(live.horizonAt, new Date(T0 + 90 * MIN).toISOString());
  assert.equal(live.spanMs, 90 * MIN);
});

test('a bar with no terminal event is open, and closes at the horizon rather than at its last entry', () => {
  const timeline = projectTimeline(
    [at(0, 'run.start'), at(0, 'phase.start', 4, {})],
    { now: T0 + 40 * MIN },
  );
  const bar = timeline.lanes[0]!.bars.at(-1)!;
  assert.equal(bar.open, true, 'still running — never a finished bar');
  assert.equal(bar.startMs, 0);
  assert.equal(bar.endMs, 40 * MIN);
});

test('a clock reading BEHIND the journal cannot shorten a bar that is demonstrably still open', () => {
  const timeline = projectTimeline(
    [at(0, 'phase.start', 4, {}), at(50, 'phase.tasks', 4, {})],
    { now: T0 + 10 * MIN },                       // a clock 40 minutes behind the newest entry
  );
  assert.equal(timeline.spanMs, 50 * MIN);
  assert.equal(timeline.lanes[0]!.bars.at(-1)!.endMs, 50 * MIN);
});

test('a park is its own bar, bracketed by the park and the resume', () => {
  const timeline = projectTimeline([
    at(0, 'phase.start', 2, {}),
    at(10, 'phase.waiting', 2, { until: new Date(T0 + 40 * MIN).toISOString(), reason: 'CI build' }),
    at(45, 'phase.wait-resume', 2, { waits: 1 }),
    at(60, 'phase.done', 2, { costUsd: 2 }),
    at(60, 'run.finished'),
  ]);
  const lane = timeline.lanes[0]!;
  assert.deepEqual(
    lane.bars.map((bar) => [bar.kind, bar.startMs / MIN, bar.endMs / MIN]),
    [['working', 0, 10], ['waiting', 10, 45], ['working', 45, 60]],
  );
  assert.equal(lane.waitingMs, 35 * MIN);
  // The park's own reason reaches the mark, so the axis can be read without
  // opening the journal.
  const park = timeline.marks.find((mark) => mark.kind === 'park');
  assert.equal(park?.label, 'CI build');
});

test('an operator freeze is a frozen bar on the lane it stopped', () => {
  const timeline = projectTimeline([
    at(0, 'phase.start', 3, {}),
    at(5, 'run.frozen', 3, { pid: 1, by: 'operator' }),
    at(35, 'run.thawed', 3, { frozenMs: 30 * MIN }),
    at(40, 'phase.done', 3, {}),
    at(40, 'run.finished'),
  ]);
  const lane = timeline.lanes[0]!;
  assert.equal(lane.frozenMs, 30 * MIN);
  assert.equal(lane.workingMs, 10 * MIN);
});

test('a second boarding is a second attempt on the same lane, and the bars know which', () => {
  const timeline = projectTimeline([
    at(0, 'phase.start', 5, {}),
    at(10, 'phase.failed', 5, { attempts: 1 }),
    at(12, 'phase.start', 5, {}),
    at(30, 'phase.done', 5, {}),
    at(30, 'run.finished'),
  ]);
  const lane = timeline.lanes[0]!;
  assert.equal(lane.attempts, 2);
  assert.deepEqual(lane.bars.map((bar) => bar.attempt), [1, 2]);
  // The gap between them is NOT a bar: the phase was not in the lane.
  assert.equal(lane.totalMs, 28 * MIN);
});

test('a truncated tail marks the lane partial instead of drawing a confident wrong bar', () => {
  // The tail opens mid-phase: no `phase.start` for lane 7 anywhere in it.
  const timeline = projectTimeline(
    [at(0, 'phase.awaiting-verification', 7), at(5, 'phase.verify', 7, { ok: false, ran: [] }), at(6, 'phase.failed', 7, {})],
    { truncated: true },
  );
  assert.equal(timeline.truncated, true);
  assert.equal(timeline.lanes[0]!.partial, true, 'this lane began before the window we can see');
});

test('an empty journal projects to an empty axis rather than throwing', () => {
  const timeline = projectTimeline([], { now: T0 });
  assert.deepEqual(timeline.lanes, []);
  assert.equal(timeline.spanMs, 0);
  assert.equal(timeline.startedAt, null);
});

test('entries the projection does not model are counted, not silently dropped', () => {
  const timeline = projectTimeline([
    at(0, 'phase.start', 1, {}),
    at(1, 'phase.tools', 1, {}),
    at(2, 'phase.checkpointed', 1, {}),
    at(3, 'phase.done', 1, {}),
  ]);
  assert.equal(timeline.unmapped, 2, 'two entries moved no bar and said so');
});

test('run-level traffic never counts as unmapped — it has no lane to be missing from', () => {
  const timeline = projectTimeline([
    at(0, 'run.start'),
    at(0, 'run.settings', undefined, { model: 'x' }),
    at(1, 'run.paused'),
    at(2, 'phase.start', 1, {}),
    at(3, 'phase.done', 1, {}),
    at(3, 'run.finished'),
  ]);
  assert.equal(timeline.unmapped, 0, 'the field flags a phase event nobody modelled, nothing else');
});

test('a verification failure reaches the marks with its verdict, so the tick can be red', () => {
  const timeline = projectTimeline([
    at(0, 'phase.start', 1, {}),
    at(5, 'phase.verify', 1, { ok: false, ran: [{ command: 'npm test', code: 1, ms: 10 }] }),
    at(6, 'phase.failed', 1, {}),
  ]);
  const verify = timeline.marks.find((mark) => mark.kind === 'verify');
  assert.equal(verify?.ok, false);
  const outcome = timeline.marks.find((mark) => mark.kind === 'outcome');
  assert.equal(outcome?.label, 'failed');
  assert.equal(outcome?.ok, false);
});

/* ------------------------------------------------------------------ *
 * criticalLane — longest by MEASURED time, not by hop count
 * ------------------------------------------------------------------ */

test('the critical path follows the slowest chain, not the longest one', () => {
  // 1 → 2 → 3 is three short phases; 1 → 4 is one very long one.
  const deps = new Map([[1, []], [2, [1]], [3, [2]], [4, [1]]]);
  const durations = new Map([[1, 10 * MIN], [2, 5 * MIN], [3, 5 * MIN], [4, 60 * MIN]]);
  const path = criticalLane(deps, durations);
  assert.deepEqual(path.phases, [1, 4]);
  assert.equal(path.ms, 70 * MIN);
});

test('a phase that did not run still LINKS two that did', () => {
  const deps = new Map([[1, []], [2, [1]], [3, [2]]]);
  const durations = new Map([[1, 10 * MIN], [3, 10 * MIN]]);   // 2 never ran
  assert.deepEqual(criticalLane(deps, durations).phases, [1, 2, 3]);
});

test('a cycle in the graph returns rather than hanging', () => {
  const deps = new Map([[1, [2]], [2, [1]]]);
  const path = criticalLane(deps, new Map([[1, MIN], [2, MIN]]));
  assert.ok(path.ms > 0);
});

test('nothing measured is not a critical path', () => {
  assert.deepEqual(criticalLane(new Map([[1, []], [2, [1]]]), new Map()).phases, []);
});

/* ------------------------------------------------------------------ *
 * attemptsOf — a boarding, and what IT spent
 * ------------------------------------------------------------------ */

const TWO_ATTEMPTS: JournalEntry[] = [
  at(0, 'phase.start', 9, { model: 'claude-sonnet-5' }),
  at(8, 'phase.session', 9, { attempt: 1, costUsd: 0.75, turns: 30, model: 'claude-sonnet-5', said: 'ran out of turns' }),
  at(9, 'phase.verify', 9, {
    ok: false,
    ran: [{ command: 'npm test', code: 1, ms: 4_000 }, { command: 'npm run lint', code: 0, ms: 900 }],
  }),
  at(10, 'phase.failed', 9, { attempts: 1 }),
  at(12, 'phase.rung', 9, { rung: 'escalate', situation: 'verify-failed:tests' }),
  at(12, 'phase.start', 9, { model: 'claude-opus-5' }),
  at(20, 'phase.session', 9, { attempt: 1, costUsd: 2.0, turns: 40, model: 'claude-opus-5' }),
  at(24, 'phase.session', 9, { attempt: 2, costUsd: 0.5, turns: 10, model: 'claude-opus-5' }),
  at(25, 'phase.verify', 9, {
    ok: true,
    cwd: '.',
    ran: [{ command: 'npm test', code: 0, ms: 5_000 }, { command: 'npm run typecheck', code: 0, ms: 2_000 }],
  }),
  at(26, 'phase.done', 9, { costUsd: 3.25, attempts: 3 }),
];

test('an attempt is a BOARDING, and its money is its own sessions — never the phase total', () => {
  const attempts = attemptsOf(TWO_ATTEMPTS, 9);
  assert.equal(attempts.length, 2);

  assert.equal(attempts[0]!.attempt, 1);
  assert.equal(attempts[0]!.outcome, 'failed');
  assert.equal(attempts[0]!.durationMs, 10 * MIN);
  assert.equal(attempts[0]!.costUsd, 0.75);
  assert.equal(attempts[0]!.turns, 30);
  assert.equal(attempts[0]!.sessions, 1);

  // `phase.done` said 3.25 — the phase's CUMULATIVE total. This boarding spent
  // 2.5 of it, across two inner sessions.
  assert.equal(attempts[1]!.costUsd, 2.5);
  assert.equal(attempts[1]!.turns, 50);
  assert.equal(attempts[1]!.sessions, 2);
  assert.equal(attempts[1]!.outcome, 'done');
  assert.equal(attempts[1]!.model, 'claude-opus-5');
  assert.deepEqual(attempts[1]!.rungs, ['escalate']);
});

test('a boarding that recorded no session has no figure — not zero', () => {
  const attempts = attemptsOf([at(0, 'phase.start', 2, {}), at(1, 'phase.gated', 2, { gate: 'manual' })], 2);
  assert.equal(attempts[0]!.costUsd, null);
  assert.equal(attempts[0]!.turns, null);
  assert.equal(attempts[0]!.outcome, 'gated');
});

test('a park ends the boarding, and the resume opens the next one', () => {
  const attempts = attemptsOf([
    at(0, 'phase.start', 3, {}),
    at(5, 'phase.waiting', 3, { until: 'x' }),
    at(60, 'phase.start', 3, {}),
    at(70, 'phase.done', 3, {}),
  ], 3);
  assert.deepEqual(attempts.map((a) => a.outcome), ['parked', 'done']);
  assert.equal(attempts[0]!.durationMs, 5 * MIN);
});

test('a boarding still running is reported as open, with the clock it has', () => {
  const attempts = attemptsOf([at(0, 'phase.start', 1, {}), at(15, 'phase.tasks', 1, {})], 1);
  assert.equal(attempts[0]!.outcome, 'open');
  assert.equal(attempts[0]!.endedAt, null);
  assert.equal(attempts[0]!.durationMs, 15 * MIN);
});

test('a boarding displaced by another with no terminal event in between is named, not lost', () => {
  const attempts = attemptsOf([at(0, 'phase.start', 1, {}), at(5, 'phase.start', 1, {}), at(9, 'phase.done', 1, {})], 1);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]!.outcome, 'superseded');
});

test('journal traffic before the first visible boarding cannot invent an attempt', () => {
  assert.deepEqual(attemptsOf([at(0, 'phase.session', 1, { costUsd: 9 }), at(1, 'phase.done', 1, {})], 1), []);
});

/* ------------------------------------------------------------------ *
 * compareAttempts — by command, and honest about absence
 * ------------------------------------------------------------------ */

test('the comparison names the outcome, the rung, the duration, the spend and every command that flipped', () => {
  const [first, second] = attemptsOf(TWO_ATTEMPTS, 9);
  const diff = compareAttempts(first!, second!);

  assert.equal(diff.outcome.from, 'failed');
  assert.equal(diff.outcome.to, 'done');
  assert.equal(diff.outcome.changed, true);
  assert.deepEqual(diff.rungs.to, ['escalate']);
  assert.equal(diff.durationMs.deltaMs, 4 * MIN);
  assert.equal(diff.costUsd.deltaUsd, 1.75);
  assert.equal(diff.model.changed, true);
  assert.equal(diff.verification.from, false);
  assert.equal(diff.verification.to, true);

  // `npm test` fail→pass; `npm run lint` vanished; `npm run typecheck` appeared.
  assert.deepEqual(
    diff.verification.flips.map((flip) => [flip.command, flip.from, flip.to]),
    [
      ['npm run lint', 'pass', 'absent'],
      ['npm run typecheck', 'absent', 'pass'],
      ['npm test', 'fail', 'pass'],
    ],
  );
  assert.equal(diff.verification.unchanged, 0);
});

test('commands are matched by NAME, so a reordered verification block reports no flips', () => {
  const build = (order: string[]): JournalEntry[] => [
    at(0, 'phase.start', 1, {}),
    at(1, 'phase.verify', 1, { ok: true, ran: order.map((command) => ({ command, code: 0, ms: 1 })) }),
    at(2, 'phase.done', 1, {}),
  ];
  const a = attemptsOf(build(['a', 'b']), 1)[0]!;
  const b = attemptsOf(build(['b', 'a']), 1)[0]!;
  const diff = compareAttempts(a, b);
  assert.deepEqual(diff.verification.flips, []);
  assert.equal(diff.verification.unchanged, 2);
});

test('an unknown figure on either side leaves the delta unknown rather than defaulting to zero', () => {
  const [first, second] = attemptsOf([
    at(0, 'phase.start', 1, {}),
    at(1, 'phase.gated', 1, {}),                 // no session ⇒ costUsd null
    at(2, 'phase.start', 1, {}),
    at(3, 'phase.session', 1, { costUsd: 1, turns: 5 }),
    at(4, 'phase.done', 1, {}),
  ], 1);
  const diff = compareAttempts(first!, second!);
  assert.equal(diff.costUsd.from, null);
  assert.equal(diff.costUsd.to, 1);
  assert.equal(diff.costUsd.deltaUsd, null, 'unknown minus a number is not a number');
});

test('consecutive pairs are what an operator reads: three attempts give two comparisons', () => {
  const entries = [1, 2, 3].flatMap((i) => [
    at(i * 10, 'phase.start', 1, {}),
    at(i * 10 + 5, 'phase.failed', 1, {}),
  ]);
  const pairs = compareConsecutive(attemptsOf(entries, 1));
  assert.deepEqual(pairs.map((pair) => [pair.from, pair.to]), [[1, 2], [2, 3]]);
});

test('one attempt has nothing to compare against', () => {
  assert.deepEqual(compareConsecutive(attemptsOf(CLEAN, 1)), []);
});

/* ------------------------------------------------------------------ *
 * The ledgers on the axis (zero-touch phase 19)
 * ------------------------------------------------------------------ */

test('a session ending is a session mark naming its mode, how it ended and its cost — unknown, never $0', () => {
  const timeline = projectTimeline([
    at(0, 'run.start', undefined, { door: 'operator', by: 'operator', resumed: false }),
    at(0, 'phase.start', 1, {}),
    at(10, 'phase.session', 1, { mode: 'phase', endedBy: 'watchdog', costUsd: 0.75, costSource: 'result', isError: false }),
    at(20, 'phase.session', 1, { mode: 'repair', endedBy: 'exit', costUsd: 0, costSource: 'none', isError: true }),
    at(30, 'phase.done', 1, {}),
  ]);
  const sessions = timeline.marks.filter((mark) => mark.kind === 'session');
  assert.deepEqual(sessions.map((mark) => [mark.atMs, mark.phase, mark.label, mark.ok]), [
    [10 * MIN, 1, 'phase · ended by watchdog · $0.75', true],
    [20 * MIN, 1, 'repair · ended by exit · cost unknown', false],
  ]);
  assert.equal(timeline.unmapped, 0, 'a session line is placed, not counted as unmapped');
});

test('asks and policy answers tick their lane, and each start of the run ticks the axis with its door', () => {
  const timeline = projectTimeline([
    at(0, 'run.start', undefined, { door: 'operator', by: 'operator', resumed: false }),
    at(0, 'phase.start', 2, {}),
    at(5, 'phase.question-raised', 2, { question: 'Which branch?' }),
    at(6, 'phase.approval-decided', 2, { decision: 'allow' }),
    at(7, 'phase.policy-answered', 2, { decisionKey: 'qa.exhausted', answer: 'waive', source: 'default' }),
    at(40, 'run.start', undefined, { door: 'converge-relaunch', by: 'console', resumed: true }),
    at(50, 'phase.done', 2, {}),
  ]);
  const of = (kind: string) => timeline.marks.filter((mark) => mark.kind === kind);
  assert.equal(of('ask').length, 2);
  assert.ok(of('ask').every((mark) => mark.phase === 2));
  assert.deepEqual(of('policy').map((mark) => mark.label), ['qa.exhausted → waive (default)']);
  assert.deepEqual(of('start').map((mark) => [mark.atMs, mark.phase, mark.label]), [
    [0, undefined, 'operator · operator'],
    [40 * MIN, undefined, 'converge-relaunch (resumed) · console'],
  ]);
  assert.equal(timeline.unmapped, 0);
});
