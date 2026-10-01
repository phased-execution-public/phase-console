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

  // working 0→20 (boarding to verification), verifying 20→25 — and NOTHING
  // 25→30: the phase's session had ended before its proof ran, so the stretch
  // between the verdict and the settle is not work (control-tower phase 61, #76).
  assert.deepEqual(
    lane.bars.map((bar) => [bar.kind, bar.startMs, bar.endMs, bar.open]),
    [
      ['working', 0, 20 * MIN, false],
      ['verifying', 20 * MIN, 25 * MIN, false],
    ],
  );
  assert.equal(lane.workingMs, 20 * MIN);
  assert.equal(lane.verifyingMs, 5 * MIN);
  assert.equal(lane.totalMs, 25 * MIN);
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

test('a re-opened phase ends its boarding red at the re-open, and its fix is a second attempt — never one bar across both', () => {
  // Control-tower phase 62 (#68): a red FINAL verdict over a complete handoff
  // re-opens the phase — no `phase.done`, no `phase.failed`. Without its own
  // terminal line the first boarding would stay open until the fix session.
  const timeline = projectTimeline([
    at(0, 'phase.start', 1, {}),
    at(20, 'phase.session', 1, { mode: 'phase', ms: 20 * MIN }),
    at(25, 'phase.verify', 1, { ok: false, ran: [{ command: 'npm test', code: 1, ms: 5 * MIN }] }),
    at(25, 'phase.verify-proven', 1, { proven: [], refused: [] }),
    at(25, 'phase.verification-failed', 1, { reopened: true, times: 1, failed: ['npm test'] }),
    at(25, 'phase.verification-held', 2, { held: [1] }),
    at(30, 'phase.start', 1, {}),
    at(40, 'phase.session', 1, { mode: 'phase', ms: 10 * MIN }),
    at(42, 'phase.verify', 1, { ok: true, ran: [{ command: 'npm test', code: 0, ms: 2 * MIN }] }),
    at(42, 'phase.done', 1, { reopened: 1 }),
    at(42, 'run.finished'),
  ]);
  const lane = timeline.lanes.find((l) => l.phase === 1)!;
  assert.equal(lane.attempts, 2, 'the fix session is a second boarding');
  const outcomes = timeline.marks.filter((mark) => mark.kind === 'outcome' && mark.phase === 1);
  assert.deepEqual(outcomes.map((mark) => [mark.label, mark.ok]), [['verification-failed', false], ['done', true]]);
  assert.equal(lane.bars.some((bar) => bar.startMs < 25 * MIN && bar.endMs > 30 * MIN), false,
    'nothing is drawn across the re-open');
  assert.equal(timeline.unmapped, 0, 'the proof note and the hold are known, and draw no bar');
});

/* ------------------------------------------------------------------ *
 * What happened, drawn as what happened (control-tower phase 61, #76)
 *
 * The audit replayed hub's journals through this projection and drew 903
 * working hours against 134 hours of sessions: a phase the board settled by
 * reconcile never closed, a halted, parked or stopped run left its lanes open
 * as working, and every automatic verification was drawn as work. The rule
 * these pin: WORKING is a session — its bar ends where `phase.session` says
 * the session ended and begins that line's own measured `ms` before — and the
 * time between sessions is queueing, a run that was down, a park or a proof,
 * each drawn as itself or not at all.
 * ------------------------------------------------------------------ */

const HOUR = 60 * MIN;

/** Σ `phase.session` `ms` for one phase — the number the working bars must equal. */
const sessionSum = (entries: readonly JournalEntry[], phase: number): number =>
  entries
    .filter((e) => e.event === 'phase.session' && e.phase === phase)
    .reduce((total, e) => total + Number(e.data?.ms ?? 0), 0);

const shape = (lane: { bars: { kind: string; startMs: number; endMs: number; open: boolean }[] }) =>
  lane.bars.map((bar) => [bar.kind, bar.startMs / MIN, bar.endMs / MIN, bar.open]);

test('phase.reconciled ends the lane: a phase the board settled is not drawn working to the horizon', () => {
  // tfar P1 in the audit: a 51-minute session, a plan-lint halt, and a settle by
  // reconcile a day later with no `phase.done` — drawn as 71 hours of work.
  const entries: JournalEntry[] = [
    at(0, 'run.start'),
    at(0, 'phase.start', 1, {}),
    at(51, 'phase.session', 1, { mode: 'phase', ms: 51 * MIN, costUsd: 4 }),
    at(52, 'run.halt', undefined, { kind: 'plan-lint', reason: 'the plan lint crashed', phase: 1 }),
    at(24 * 60, 'run.start', undefined, { door: 'operator', resumed: true }),
    at(24 * 60 + 1, 'phase.reconciled', 1, { by: 'the board', outcome: 'done' }),
  ];
  const timeline = projectTimeline(entries, { now: T0 + 72 * HOUR });
  const lane = timeline.lanes[0]!;

  assert.equal(lane.workingMs, sessionSum(entries, 1), 'working IS the session: 51 minutes, not 71 hours');
  assert.ok(lane.bars.every((bar) => !bar.open), 'nothing about a settled phase is still open');
  assert.ok(lane.endMs <= (24 * 60 + 1) * MIN, 'the lane ends where the board settled it');
  const outcome = timeline.marks.find((mark) => mark.kind === 'outcome' && mark.phase === 1);
  assert.equal(outcome?.label, 'reconciled done');
  assert.equal(outcome?.ok, true);
});

test('a bar closes at its session`s end, and the stretch after it is not work', () => {
  const entries: JournalEntry[] = [
    at(0, 'run.start'),
    at(0, 'phase.start', 2, {}),
    at(30, 'phase.session', 2, { mode: 'phase', ms: 28 * MIN }),
    at(31, 'phase.outcome', 2, { status: 'partial' }),
  ];
  // Five hours later and the run never finished: the old projection drew five
  // hours of working here, hatched as "still open".
  const lane = projectTimeline(entries, { now: T0 + 5 * HOUR }).lanes[0]!;
  assert.deepEqual(shape(lane), [['working', 2, 30, false]]);
  assert.equal(lane.workingMs, sessionSum(entries, 2));
});

test('run-level halt, park, pause and stop close the lanes in flight, each down bar naming its cause', () => {
  const entries: JournalEntry[] = [
    at(0, 'run.start'),
    at(0, 'phase.start', 1, {}),
    at(0, 'phase.start', 2, {}),
    at(0, 'phase.start', 3, {}),
    at(0, 'phase.start', 4, {}),
    at(10, 'phase.session', 1, { mode: 'phase', ms: 10 * MIN }),
    at(10, 'run.halt', undefined, { kind: 'failure-streak', reason: 'three phases failed', phase: 1 }),
    at(20, 'phase.session', 2, { mode: 'phase', ms: 20 * MIN }),
    at(20, 'run.parked', undefined, { reason: 'phase 2 needs a person' }),
    at(30, 'phase.session', 3, { mode: 'phase', ms: 30 * MIN }),
    at(30, 'run.paused', undefined, { afterPhase: 3 }),
    // A stop reaches a session still RUNNING: it ends a breath later, and the
    // work is the session's to the second — the down bar starts where it ended.
    at(40, 'run.stop-requested', undefined, { phases: [4], by: 'operator', via: 'http' }),
    at(40.5, 'phase.session', 4, { mode: 'phase', ms: 40.5 * MIN, endedBy: 'operator' }),
    at(100, 'run.start', undefined, { door: 'operator', resumed: true }),
  ];
  const timeline = projectTimeline(entries, { now: T0 + 10 * HOUR });
  const lane = (phase: number) => timeline.lanes.find((l) => l.phase === phase)!;
  const down = (phase: number) => lane(phase).bars.filter((bar) => bar.kind === 'down');

  // The run went down at the halt and stayed down through the park, the pause
  // and the stop, so every lane in flight carries the FIRST cause — from the
  // moment its own session ended, because a session outranks the run's state.
  assert.deepEqual(down(1).map((bar) => [bar.startMs / MIN, bar.endMs / MIN, bar.note]), [[10, 100, 'halted: failure-streak']]);
  assert.deepEqual(down(2).map((bar) => [bar.startMs / MIN, bar.endMs / MIN, bar.note]), [[20, 100, 'halted: failure-streak']]);
  assert.deepEqual(down(4).map((bar) => [bar.startMs / MIN, bar.endMs / MIN, bar.note]), [[40.5, 100, 'halted: failure-streak']]);
  for (const phase of [1, 2, 3, 4]) {
    assert.equal(lane(phase).workingMs, sessionSum(entries, phase), `p${phase} works for its session, and no longer`);
    assert.ok(lane(phase).bars.every((bar) => !bar.open), `p${phase}: the next start closed every bar`);
  }
});

test('a down bar says why: a park, a pause and a stop by whom are each their own cause', () => {
  const run = (event: string, data: Record<string, unknown>) => {
    const lane = projectTimeline([
      at(0, 'phase.start', 5, {}),
      at(10, 'phase.session', 5, { mode: 'phase', ms: 10 * MIN }),
      at(11, event, undefined, data),
      at(20, 'run.start', undefined, { door: 'operator', resumed: true }),
    ]).lanes[0]!;
    return lane.bars.find((bar) => bar.kind === 'down')?.note;
  };
  assert.equal(run('run.parked', { reason: 'phase 5 needs a person' }), 'parked: phase 5 needs a person');
  assert.equal(run('run.paused', { afterPhase: 5 }), 'paused');
  assert.equal(run('run.stop-requested', { phases: [], by: 'operator' }), 'stopped by operator');
  assert.equal(run('run.console-shutdown', { intent: 'restart' }), 'console shut down (restart)');
  assert.equal(run('run.waiting-external', { phases: [5], waitUntil: null }), 'waiting on an outside clock');
});

test('halt, then requeue: working equals the phase.session sum, and the queue and the down time are drawn as themselves', () => {
  const entries: JournalEntry[] = [
    at(0, 'run.start'),
    at(0, 'phase.start', 3, {}),
    at(40, 'phase.session', 3, { mode: 'phase', ms: 40 * MIN }),
    at(40, 'phase.outcome', 3, { status: 'partial' }),
    at(41, 'run.halt', undefined, { kind: 'failure-streak', phase: 3 }),
    at(200, 'run.start', undefined, { door: 'operator', resumed: true }),
    at(200, 'phase.queued', 3, { headClass: 'other-run', head: 'hand' }),
    at(210, 'phase.queue-closed', 3, { outcome: 'admitted', ms: 10 * MIN }),
    at(210, 'phase.start', 3, {}),
    at(240, 'phase.session', 3, { mode: 'phase', ms: 29 * MIN }),
    at(245, 'phase.verify', 3, { ok: true, ran: [{ command: 'npm test', code: 0, ms: 4 * MIN }, { command: 'npm run lint', code: 0, ms: MIN }] }),
    at(245, 'phase.done', 3, {}),
    at(245, 'run.finished'),
  ];
  const lane = projectTimeline(entries).lanes[0]!;

  assert.equal(lane.workingMs, sessionSum(entries, 3), 'the sessions, and nothing else, are work');
  assert.deepEqual(shape(lane), [
    ['working', 0, 40, false],
    ['down', 41, 200, false],
    ['queued', 200, 210, false],
    ['working', 211, 240, false],
    ['verifying', 240, 245, false],
  ]);
  assert.equal(lane.downMs, 159 * MIN);
  assert.equal(lane.queuedMs, 10 * MIN);
  assert.equal(lane.verifyingMs, 5 * MIN);
  assert.equal(lane.attempts, 2);
  assert.equal(lane.bars.find((bar) => bar.kind === 'down')?.note, 'halted: failure-streak');
});

test('a queue bar runs from phase.queued to its close — a restarted close ends at its last sighting', () => {
  const entries: JournalEntry[] = [
    at(0, 'run.start'),
    at(0, 'phase.queued', 6, { headClass: 'other-run' }),
    // The console holding the queue went away at 20; the next one says so at 100.
    at(100, 'run.start', undefined, { door: 'boot', resumed: true }),
    at(100, 'phase.queue-closed', 6, { outcome: 'restarted', since: new Date(T0).toISOString(), ms: 20 * MIN }),
    at(100, 'phase.queued', 6, { headClass: 'other-run', age: new Date(T0).toISOString() }),
    at(101, 'phase.serial-behind', 6, { behind: 2 }),
    at(130, 'phase.queue-closed', 6, { outcome: 'admitted', ms: 30 * MIN }),
    at(130, 'phase.start', 6, {}),
    at(150, 'phase.session', 6, { mode: 'phase', ms: 20 * MIN }),
    at(150, 'phase.done', 6, {}),
    at(150, 'run.finished'),
  ];
  const timeline = projectTimeline(entries);
  const lane = timeline.lanes[0]!;
  assert.deepEqual(shape(lane).filter(([kind]) => kind === 'queued'), [['queued', 0, 20, false], ['queued', 100, 130, false]]);
  assert.equal(lane.queuedMs, 50 * MIN);
  assert.equal(lane.partial, false, 'a lane that begins with its queue line began where we can see it');
  assert.equal(timeline.unmapped, 0, 'serial-behind is ready time behind the run`s own lane — known, and never a queue bar');
});

test('automatic verification is a verifying bar, measured from phase.verify`s own commands', () => {
  const entries: JournalEntry[] = [
    at(0, 'phase.start', 7, {}),
    at(20, 'phase.session', 7, { mode: 'phase', ms: 20 * MIN }),
    // No `phase.awaiting-verification`: that line is the person-check path's.
    at(27, 'phase.verify', 7, { ok: true, ran: [{ command: 'npm test', code: 0, ms: 4 * MIN }, { command: 'npm run lint', code: 0, ms: 2 * MIN }] }),
    at(27, 'phase.done', 7, {}),
    at(27, 'run.finished'),
  ];
  const lane = projectTimeline(entries).lanes[0]!;
  assert.deepEqual(shape(lane), [['working', 0, 20, false], ['verifying', 21, 27, false]]);
  assert.equal(lane.verifyingMs, 6 * MIN);
  assert.equal(lane.workingMs, sessionSum(entries, 7));
});

test('a session nobody reported ends where its lane was last seen once the next console starts', () => {
  const entries: JournalEntry[] = [
    at(0, 'run.start'),
    at(0, 'phase.start', 8, {}),
    at(12, 'phase.resources', 8, { rssMb: 400 }),
    // The console died here — no `phase.session`, no halt — and the next one
    // started the run again at 300.
    at(300, 'run.start', undefined, { door: 'boot', resumed: true }),
  ];
  const lane = projectTimeline(entries, { now: T0 + 400 * MIN }).lanes[0]!;
  assert.deepEqual(shape(lane), [['working', 0, 12, false], ['down', 12, 300, false]]);
  assert.equal(lane.bars[1]!.note, 'no console');
});

test('a pull-request session is not the phase`s work', () => {
  const lane = projectTimeline([
    at(0, 'phase.start', 9, {}),
    at(10, 'phase.session', 9, { mode: 'phase', ms: 10 * MIN }),
    at(12, 'phase.done', 9, {}),
    at(30, 'phase.session', 9, { mode: 'pr', ms: 15 * MIN }),
    at(30, 'run.finished'),
  ]).lanes[0]!;
  assert.equal(lane.workingMs, 10 * MIN);
});

test('a freeze inside a measured session is frozen, and the rest of the session is work', () => {
  const lane = projectTimeline([
    at(0, 'phase.start', 3, {}),
    at(5, 'run.frozen', 3, { pid: 1, by: 'operator' }),
    at(35, 'run.thawed', 3, { frozenMs: 30 * MIN }),
    at(40, 'phase.session', 3, { mode: 'phase', ms: 39 * MIN }),
    at(40, 'phase.done', 3, {}),
    at(40, 'run.finished'),
  ]).lanes[0]!;
  assert.deepEqual(shape(lane), [['working', 1, 5, false], ['frozen', 5, 35, false], ['working', 35, 40, false]]);
  assert.equal(lane.frozenMs, 30 * MIN);
  assert.equal(lane.workingMs, 9 * MIN);
});

test('a stop ends a freeze: the stopped run is down, not frozen for as long as anyone looks', () => {
  // ai-builder-v4 P3 in the replay: frozen, then the run was stopped, and the
  // freeze was drawn for 160 hours after the process it described was gone.
  const lane = projectTimeline([
    at(0, 'phase.start', 3, {}),
    at(5, 'run.frozen', 3, { pid: 1, by: 'operator' }),
    at(30, 'run.stop-requested', undefined, { phases: [3], by: 'operator', wasFrozen: true }),
  ], { now: T0 + 50 * HOUR }).lanes[0]!;
  assert.deepEqual(shape(lane).slice(1), [['frozen', 5, 30, false], ['down', 30, 50 * 60, true]]);
  assert.equal(lane.bars.at(-1)!.note, 'stopped by operator');
});

test('the critical path is weighted by measured session and verify time, never by a bar left open', () => {
  // 1 → 2 and 1 → 3. Phase 2 worked 30 minutes and verified 5; phase 3 has sat
  // in a session nobody reported for ten hours and counts for nothing measured.
  const entries: JournalEntry[] = [
    at(0, 'phase.start', 1, {}),
    at(10, 'phase.session', 1, { mode: 'phase', ms: 10 * MIN }),
    at(10, 'phase.done', 1, {}),
    at(10, 'phase.start', 2, {}),
    at(10, 'phase.start', 3, {}),
    at(40, 'phase.session', 2, { mode: 'phase', ms: 30 * MIN }),
    at(45, 'phase.verify', 2, { ok: true, ran: [{ command: 'npm test', code: 0, ms: 5 * MIN }] }),
    at(45, 'phase.done', 2, {}),
  ];
  const deps = new Map([[1, []], [2, [1]], [3, [1]]]);
  const timeline = projectTimeline(entries, { now: T0 + 10 * HOUR, deps });
  const lane = (phase: number) => timeline.lanes.find((l) => l.phase === phase)!;

  assert.equal(lane(3).bars.at(-1)!.open, true, 'the live lane is still drawn, hatched');
  assert.equal(lane(3).measuredMs, 0, 'but an open bar is not a measurement');
  assert.equal(lane(2).measuredMs, 35 * MIN);
  assert.deepEqual(timeline.criticalPath, [1, 2]);
  assert.equal(timeline.criticalMs, 45 * MIN);
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

/*
 * An attempt ends when its session does (control-tower phase 89, #130; the
 * rest of AT-1..3 is `attempts.test.ts`). The LANE is the phase's time on the
 * run and keeps drawing what happened to it after a session declared partial —
 * the run going down with it, its queue — while the ATTEMPT is the boarding,
 * and neither the down time nor the queue is its clock.
 */

test('AT-1: the partial the run halted and requeued is an attempt that ended at its session — `partial`, not superseded at the next boarding', () => {
  const entries: JournalEntry[] = [
    at(0, 'run.start'),
    at(0, 'phase.start', 3, { attempt: 1 }),
    at(40, 'phase.session', 3, { attempt: 1, mode: 'phase', ms: 40 * MIN }),
    at(40, 'phase.outcome', 3, { status: 'partial' }),
    at(41, 'run.halt', undefined, { kind: 'failure-streak', phase: 3 }),
    at(200, 'run.start', undefined, { door: 'operator', resumed: true }),
    at(200, 'phase.queued', 3, { headClass: 'other-run', head: 'hand' }),
    at(210, 'phase.queue-closed', 3, { outcome: 'admitted', ms: 10 * MIN }),
    at(210, 'phase.start', 3, { attempt: 2 }),
    at(240, 'phase.session', 3, { attempt: 2, mode: 'phase', ms: 29 * MIN }),
    at(245, 'phase.verify', 3, { ok: true, ran: [{ command: 'npm test', code: 0, ms: 5 * MIN }] }),
    at(245, 'phase.done', 3, {}),
    at(245, 'run.finished'),
  ];
  const [first, second] = attemptsOf(entries, 3);
  assert.deepEqual(
    [first!.attempt, first!.outcome, first!.endedAt, first!.durationMs],
    [1, 'partial', new Date(T0 + 40 * MIN).toISOString(), 40 * MIN],
  );
  assert.deepEqual([second!.attempt, second!.outcome, second!.durationMs], [2, 'done', 35 * MIN]);
  const lane = projectTimeline(entries).lanes[0]!;
  assert.equal(lane.downMs, 159 * MIN, 'the lane still draws the run down with the phase in it');
  assert.equal(lane.queuedMs, 10 * MIN);
});

test('AT-2: an attempt takes off exactly the queue its lane draws inside it', () => {
  const entries: JournalEntry[] = [
    at(0, 'phase.start', 5, { attempt: 1 }),
    at(10, 'phase.session', 5, { attempt: 1, mode: 'phase', ms: 10 * MIN }),
    at(10, 'phase.queued', 5, { headClass: 'other-run' }),
    at(40, 'phase.queue-closed', 5, { outcome: 'admitted', ms: 30 * MIN }),
    at(55, 'phase.session', 5, { attempt: 2, mode: 'phase', ms: 15 * MIN }),
    at(55, 'phase.done', 5, {}),
    at(55, 'run.finished'),
  ];
  const lane = projectTimeline(entries).lanes[0]!;
  const [attempt] = attemptsOf(entries, 5);
  assert.equal(lane.queuedMs, 30 * MIN);
  assert.equal(attempt!.durationMs, 55 * MIN - lane.queuedMs);
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

/* ------------------------------------------------------------------ *
 * The cost and token axes — #32's gap 1
 * ------------------------------------------------------------------ */

/**
 * The Gantt answers *when did each phase hold the lane*, past tense, and is
 * correct about it. The question an operator actually has at minute 40 of a
 * phase — *is this one burning faster than the last three?* — had no picture
 * anywhere, although both facts were already journalled: `phase.session`
 * carries an attempt's own dollars and `phase.tokens` its context. The axis
 * was the only thing missing.
 */
test('the cost axis sums an attempt\'s own sessions, on the bars\' own axis', () => {
  const entries: JournalEntry[] = [
    at(0, 'run.start'),
    at(0, 'phase.start', 4, { model: 'claude-opus-5' }),
    at(10, 'phase.session', 4, { costUsd: 2 }),
    at(20, 'phase.session', 4, { costUsd: 3.5 }),
    at(22, 'phase.tokens', 4, { peakContext: 180_000 }),
    at(30, 'phase.done', 4, { costUsd: 5.5, attempts: 1 }),
    at(30, 'run.finished'),
  ];
  const { series, asOf } = projectTimeline(entries, { now: T0 + 30 * MIN });

  assert.equal(series.cost.length, 1, 'one point per attempt window, not per session');
  assert.deepEqual(
    { phase: series.cost[0].phase, attempt: series.cost[0].attempt, value: series.cost[0].value, open: series.cost[0].open },
    { phase: 4, attempt: 1, value: 5.5, open: false },
    'the sum of an attempt\'s sessions IS what that attempt spent — record.costUsd accumulates across attempts',
  );
  assert.equal(series.cost[0].startMs, 0, 'and it sits on the same axis as the bar it describes');
  assert.equal(series.cost[0].endMs, 30 * MIN);

  assert.equal(series.tokens.length, 1);
  assert.equal(series.tokens[0].value, 180_000, 'the window\'s PEAK — a mean says nothing about being near the wall');

  assert.ok(Date.parse(asOf) > 0, 'the axis says when it was taken');
});

test('two attempts are two points, so a retry can be told from a long first try', () => {
  const entries: JournalEntry[] = [
    at(0, 'run.start'),
    at(0, 'phase.start', 2),
    at(15, 'phase.session', 2, { costUsd: 4 }),
    at(16, 'phase.failed', 2),
    at(20, 'phase.start', 2),
    at(28, 'phase.session', 2, { costUsd: 1 }),
    at(30, 'phase.done', 2, { attempts: 2 }),
    at(30, 'run.finished'),
  ];
  const { series } = projectTimeline(entries, { now: T0 + 30 * MIN });

  assert.deepEqual(
    series.cost.map((p) => [p.attempt, p.value]),
    [[1, 4], [2, 1]],
    'the expensive attempt is the FIRST one, and a single cumulative number could never say so',
  );
});

test('an open attempt takes the live lane\'s figures — the journal cannot know them yet', () => {
  const entries: JournalEntry[] = [
    at(0, 'run.start'),
    at(0, 'phase.start', 7),
    at(10, 'phase.tokens', 7, { peakContext: 90_000 }),
  ];
  // `phase.session` is written when a session ENDS, so a window read from the
  // journal alone is $0.00 for as long as the attempt lasts — which is exactly
  // the minute the cost axis is being asked about.
  const cold = projectTimeline(entries, { now: T0 + 40 * MIN });
  assert.equal(cold.series.cost[0].value, 0, 'nothing has ended, so nothing is booked');
  assert.equal(cold.series.cost[0].open, true, 'and the point says the window is still open');

  const live = projectTimeline(entries, {
    now: T0 + 40 * MIN,
    live: [{ phase: 7, spentUsd: 12.25, contextTokens: 340_000 }],
  });
  assert.equal(live.series.cost[0].value, 12.25, '"$0.00 so far" about forty minutes of work is the one certainly wrong reading');
  assert.equal(live.series.tokens[0].value, 340_000, 'and the context the lane is actually at, not the last one it journalled');
});

test('a run with no journal has an empty series rather than no series at all', () => {
  const empty = projectTimeline([], { now: T0 });
  assert.deepEqual(empty.series, { cost: [], tokens: [] });
  assert.equal(empty.asOf, new Date(T0).toISOString());
});

/* ------------------------------------------------------------------ *
 * NT-1 (control-tower phase 96, #142): an operator's notes on the axis
 * ------------------------------------------------------------------ */

test('NT-1: a note on the run ticks the axis, a note naming a running phase ticks its lane, and neither is unmapped', () => {
  const timeline = projectTimeline([
    at(0, 'run.start', undefined, { door: 'operator', by: 'operator' }),
    at(0, 'phase.start', 2, {}),
    at(3, 'run.note', undefined, { id: 'n1', by: 'mobin', text: 'keep this run on admin@ past its weekly limit', pinned: true }),
    at(4, 'run.note', 2, { id: 'n2', by: 'mobin', text: 'bumped P66 ahead of P67: P67 depends on it', pinned: false }),
    // A phase with no lane on this run: the note must not invent one.
    at(5, 'run.note', 9, { id: 'n3', by: 'mobin', text: 'phase 9 must not re-clone the mounts', pinned: false }),
    at(6, 'run.note-pinned', undefined, { id: 'n1', pinned: false, by: 'mobin' }),
    at(50, 'phase.done', 2, {}),
  ]);
  const notes = timeline.marks.filter((mark) => mark.kind === 'note');
  assert.deepEqual(notes.map((mark) => [mark.atMs, mark.phase, mark.label]), [
    [3 * MIN, undefined, 'pinned · mobin: keep this run on admin@ past its weekly limit'],
    [4 * MIN, 2, 'mobin: bumped P66 ahead of P67: P67 depends on it'],
    [5 * MIN, undefined, 'phase 9 · mobin: phase 9 must not re-clone the mounts'],
  ]);
  assert.deepEqual(timeline.lanes.map((lane) => lane.phase), [2], 'a note is not a lane');
  assert.equal(timeline.unmapped, 0);
});
