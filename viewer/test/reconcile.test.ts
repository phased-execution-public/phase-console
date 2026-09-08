/**
 * The run that says it is running, and is not.
 *
 * Every case here came off a real state file. `run-accf6aa2.json` was found on
 * disk reading `status: "running"`, `halt: null`, `child: {pid: 29069, …}` —
 * with pid 29069 long dead and the run's own journal ending, three lines
 * earlier, in `run.halt`. The console had been SIGKILLed between journalling the
 * halt and checkpointing it, so the last word on disk was a claim nobody was
 * backing. The UI believed it for an hour, offered a Stop button whose handler
 * returned immediately, and said nothing about either.
 *
 * The lesson is not "persist harder" — the writer is exactly the thing that can
 * die. It is that liveness has to be derived at read time from evidence that
 * cannot be stale: whether this is the run the loop is driving, and whether the
 * recorded pid still exists.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  reconcileRun, reconcileRecordsAgainstBoard, newRun, phaseRecord, saveRun, loadRun,
  listRuns, latestRun, runDir, resetForRetry, settleFinishedRun, autoResolveRun,
  flushRunSaves, pendingRunSaves,
  IN_FLIGHT, CONSOLE_STOPPED_NOTE, type RunState,
} from '../server/runner/state.ts';
import { newLaneSignals } from '../server/runner/liveness.ts';

function scratchRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-reconcile-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A pid that is certainly not running. 0 and 1 are both real, so pick high. */
const DEAD_PID = 0x7ffffffe;

function crashedRun(root: string, over: Partial<RunState> = {}): RunState {
  const state = newRun({ slug: 'demo', root, model: 'opus' });
  Object.assign(state, {
    status: 'running',
    activePhase: 12,
    child: { pid: DEAD_PID, phase: 12, sessionId: 'abc', startedAt: new Date().toISOString() },
    ...over,
  });
  const record = phaseRecord(state, 12);
  record.status = 'running';
  return state;
}

test('a run whose writer died stops claiming to be running', () => {
  const state = crashedRun('/tmp/whatever');

  assert.equal(reconcileRun(state, null), true, 'the stale claim should be reclaimed');
  assert.equal(state.status, 'interrupted');
  assert.equal(state.child, null, 'a dead child must not be left on the record');
  assert.match(state.halt?.reason ?? '', /nothing has been driving this run/);
  assert.equal(state.halt?.phase, 12, 'the halt should name the phase that was in flight');
  assert.equal(state.phases['12'].status, 'interrupted',
    'a phase cut off mid-flight is interrupted, never failed — it may have half-committed');
});

test('the run the loop is actually driving is left alone', () => {
  const state = crashedRun('/tmp/whatever');
  assert.equal(reconcileRun(state, state.id), false, 'the live run is the one thing that licenses "running"');
  assert.equal(state.status, 'running');
  assert.equal(state.phases['12'].status, 'running');
});

test('a child that outlived its console parks rather than being reclaimed', () => {
  // Two agents editing one working tree is not a state to quietly recover from.
  const state = crashedRun('/tmp/whatever', {
    child: { pid: process.pid, phase: 7, sessionId: 'x', startedAt: new Date().toISOString() },
  });

  assert.equal(reconcileRun(state, null), true);
  assert.equal(state.status, 'parked');
  assert.ok(state.child, 'the surviving child must stay on the record so it can be found');
  assert.match(state.halt?.reason ?? '', new RegExp(`pid ${process.pid}`));
});

test('an already-settled run is never rewritten', () => {
  for (const status of ['halted', 'finished', 'paused', 'parked', 'interrupted'] as const) {
    const state = crashedRun('/tmp/whatever', { status, child: null });
    assert.equal(reconcileRun(state, null), false, `${status} is terminal and must be left as it is`);
    assert.equal(state.status, status);
  }
});

test('every in-flight status is reclaimable, and the list is the one the code uses', () => {
  // A status added later that nobody adds here would silently become immortal.
  for (const status of IN_FLIGHT) {
    const state = crashedRun('/tmp/whatever', { status });
    assert.equal(reconcileRun(state, null), true, `${status} claims work in flight and must be reclaimed`);
    // A dead `halting` run DID record why it stopped — it finalizes to the
    // `halted` its drive loop never got to write. `interrupted` stays the word
    // for "nothing recorded why".
    assert.equal(state.status, status === 'halting' ? 'halted' : 'interrupted');
  }
});

test('a dead halting run keeps its own halt reason on the way to halted', () => {
  const state = crashedRun('/tmp/whatever', {
    status: 'halting',
    halt: { at: '2026-08-04T12:00:00.000Z', reason: 'phase 2 did not verify: stub', phase: 2 },
  });
  assert.equal(reconcileRun(state, null), true);
  assert.equal(state.status, 'halted');
  assert.equal(state.halt?.reason, 'phase 2 did not verify: stub', 'the reason is the run\'s own, not a reconstruction');
});

test('an existing halt reason is preserved, not overwritten', () => {
  // The journal's `run.halt` may have landed even when the checkpoint did not;
  // whatever the runner managed to record is better than our reconstruction.
  const state = crashedRun('/tmp/whatever', {
    halt: { at: '2026-08-02T12:35:08.078Z', reason: '2 phases failed in a row', phase: 12 },
  });
  reconcileRun(state, null);
  assert.equal(state.halt?.reason, '2 phases failed in a row');
  assert.equal(state.status, 'interrupted', 'the status is still corrected');
});

test('a phase waiting on a human is reclaimed too', () => {
  const state = crashedRun('/tmp/whatever');
  state.phases['12'].status = 'awaiting-verification';
  reconcileRun(state, null);
  assert.equal(state.phases['12'].status, 'interrupted');
  assert.match(state.phases['12'].note ?? '', /waiting to be verified/);
});

/* ------------------------------------------------------------------ *
 * Reading it back off disk
 * ------------------------------------------------------------------ */

test('loading a crashed run corrects it, and the correction is written down', () => {
  const dir = scratchRoot();
  try {
    const state = crashedRun(dir.root);
    saveRun(state);

    const file = join(runDir(dir.root, 'demo'), `run-${state.id}.json`);
    const loaded = loadRun(dir.root, 'demo', state.id, null);
    assert.equal(loaded?.status, 'interrupted', 'the reader must not report a corpse as running');

    // The read itself does NOT write. Every read of every run goes through
    // `settle`, and `listRuns` calls it once per file — so a synchronous
    // fsync'd write here put disk IO inside a GET handler, once per record,
    // per request. The correction is OWED, not skipped.
    const stillOnDisk = JSON.parse(readFileSync(file, 'utf8')) as RunState;
    assert.equal(stillOnDisk.status, 'running', 'the reader must not write on a read path');
    assert.equal(pendingRunSaves(), 1, 'the correction must be owed, not dropped');

    // …and written down, or every read re-derives it and `/api/runs` never
    // settles. This is the half that must never regress: deferring the write
    // is only sound because the write still happens.
    assert.equal(flushRunSaves(), 1);
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as RunState;
    assert.equal(onDisk.status, 'interrupted');
    assert.equal(onDisk.child, null);

    // The correction is done ONCE: with it on disk, a second read owes nothing.
    assert.equal(loadRun(dir.root, 'demo', state.id, null)?.status, 'interrupted');
    assert.equal(pendingRunSaves(), 0, 'a corrected record must not be re-written on every read');
  } finally { flushRunSaves(); dir.cleanup(); }
});

test('listRuns and latestRun reconcile too — the UI reads through both', () => {
  const dir = scratchRoot();
  try {
    saveRun(crashedRun(dir.root));
    assert.equal(listRuns(dir.root, 'demo', null)[0].status, 'interrupted');
    assert.equal(latestRun(dir.root, 'demo', null)?.status, 'interrupted');
  } finally { dir.cleanup(); }
});

test('a live run read through listRuns keeps its status', () => {
  const dir = scratchRoot();
  try {
    const state = crashedRun(dir.root);
    saveRun(state);
    assert.equal(listRuns(dir.root, 'demo', state.id)[0].status, 'running');
  } finally { dir.cleanup(); }
});

test('an unreadable run directory is empty, not an exception', () => {
  const dir = scratchRoot();
  try {
    mkdirSync(runDir(dir.root, 'demo'), { recursive: true });
    writeFileSync(join(runDir(dir.root, 'demo'), 'run-deadbeef.json'), '{ truncated', 'utf8');
    assert.deepEqual(listRuns(dir.root, 'demo', null), []);
  } finally { dir.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Several lanes, one crashed console
 * ------------------------------------------------------------------ */

test('every lane is reconciled, not just the one the mirror named', () => {
  const dir = scratchRoot();
  try {
    // Three lanes recorded, plus the mirror pointing at one of them — exactly
    // what the runner writes while a run drives three phases at once.
    const state = crashedRun(dir.root, {
      children: {
        7: { pid: DEAD_PID, phase: 7, sessionId: 's7', startedAt: new Date().toISOString() },
        9: { pid: DEAD_PID, phase: 9, sessionId: 's9', startedAt: new Date().toISOString() },
        12: { pid: DEAD_PID, phase: 12, sessionId: 'abc', startedAt: new Date().toISOString() },
      },
    });
    for (const phase of [7, 9]) phaseRecord(state, phase).status = 'running';

    assert.equal(reconcileRun(state, null), true);
    assert.equal(state.status, 'interrupted');
    // All three, not one. A lane left `running` on a run nothing is driving is
    // a phase the console goes on reporting as in flight forever.
    for (const phase of [7, 9, 12]) {
      const record = state.phases[String(phase)];
      assert.equal(record.status, 'interrupted', `phase ${phase}`);
      assert.equal(record.resumeSessionId, record.sessionId, `phase ${phase} keeps a session to resume`);
    }
    assert.equal(state.child, null);
    assert.equal(state.children, undefined, 'nothing is left claiming to be alive');
  } finally { dir.cleanup(); }
});

test('a run whose OTHER lane is still alive parks rather than being reclaimed', () => {
  const dir = scratchRoot();
  try {
    // The mirror's child is gone; a second lane's is this very process, which
    // is certainly alive. Reading only `child` would reclaim a run that still
    // has a session editing the working tree — the exact failure `parked` is for.
    const state = crashedRun(dir.root, {
      children: {
        7: { pid: process.pid, phase: 7, sessionId: 's7', startedAt: new Date().toISOString() },
        12: { pid: DEAD_PID, phase: 12, sessionId: 'abc', startedAt: new Date().toISOString() },
      },
    });

    assert.equal(reconcileRun(state, null), true);
    assert.equal(state.status, 'parked');
    assert.match(state.halt!.reason, /still running/);
    assert.match(state.halt!.reason, new RegExp(String(process.pid)), 'and names the pid to look at');
  } finally { dir.cleanup(); }
});

test('a run written before lanes reconciles exactly as it always did', () => {
  const dir = scratchRoot();
  try {
    // No `children` key at all — which is every run file on disk today. The two
    // recordings have to reconcile identically, or the upgrade is a regression.
    const state = crashedRun(dir.root);
    assert.equal(state.children, undefined);
    assert.equal(reconcileRun(state, null), true);
    assert.equal(state.status, 'interrupted');
    assert.equal(state.phases['12'].status, 'interrupted');
    assert.equal(state.child, null);
  } finally { dir.cleanup(); }
});

test('a live-run SET keeps every one of its runs, and reclaims the rest', () => {
  const dir = scratchRoot();
  try {
    const a = crashedRun(dir.root);
    const b = crashedRun(dir.root);
    const c = crashedRun(dir.root);
    // A single id was the whole answer with one runner. With a pool it is a
    // Set — and a Set compared with `===` would mark every live run as dead
    // and reconcile a working fleet into `interrupted`.
    const live = new Set([a.id, b.id]);
    assert.equal(reconcileRun(a, live), false, 'still driving');
    assert.equal(reconcileRun(b, live), false, 'also still driving');
    assert.equal(reconcileRun(c, live), true, 'and this one genuinely is not');
    assert.equal(c.status, 'interrupted');
  } finally { dir.cleanup(); }
});

test('a run asleep on a usage window reconciles to paused, with its clock intact', () => {
  const dir = scratchRoot();
  try {
    const state = crashedRun(dir.root, { status: 'waiting' });
    state.waitUntil = '2026-08-06T20:00:00.000Z';
    state.child = null;
    delete state.children;
    const record = phaseRecord(state, 12);
    record.status = 'running';
    record.sessionId = 'sess-window';

    assert.equal(reconcileRun(state, undefined), true);
    // NOT `interrupted`: this run's "why" IS recorded — the reset time — and a
    // console restart during a long window must not turn a self-resuming run
    // into one waiting for a person.
    assert.equal(state.status, 'paused');
    assert.equal(state.waitUntil, '2026-08-06T20:00:00.000Z', 'the re-arm needs the clock');
    assert.equal(state.halt, null, 'a usage window is not a halt');
    assert.match(state.finishedReason ?? '', /usage limit/i);
    assert.equal(record.status, 'pending');
    assert.equal(record.resumeSessionId, 'sess-window', 'Continue resumes the same session');
  } finally { dir.cleanup(); }
});

test('the usage-window records stay pending through the WHOLE read path', () => {
  const dir = scratchRoot();
  try {
    // `reconcileRun` deliberately writes `pending` here rather than
    // `interrupted`, so the run re-arms itself instead of waiting for a person.
    // `settle()` now runs `settleInFlightRecords` on every read that is not
    // live — INCLUDING after `reconcileRun` returned true — so the two have to
    // be checked together, through `loadRun`, not just at the seam. They agree
    // because `pending` is not a `PHASE_IN_FLIGHT` status; if that ever stops
    // being true, the run stops re-arming and this is the test that says so.
    const state = crashedRun(dir.root, { status: 'waiting' });
    state.waitUntil = '2026-08-06T20:00:00.000Z';
    state.child = null;
    delete state.children;
    const record = phaseRecord(state, 12);
    record.status = 'running';
    record.sessionId = 'sess-window';
    saveRun(state);

    const loaded = loadRun(dir.root, 'demo', state.id, null);
    assert.equal(loaded?.status, 'paused');
    assert.equal(loaded?.phases['12'].status, 'pending', 'not interrupted — the re-arm needs it pending');
    assert.equal(loaded?.waitUntil, '2026-08-06T20:00:00.000Z');
    assert.equal(loaded?.phases['12'].resumeSessionId, 'sess-window');
  } finally { dir.cleanup(); }
});

/**
 * Two waits share one clock, and the clock never said which.
 *
 * `waitUntil` was the only fact recorded, so every reader re-derived the cause:
 * this function and `readoptQueued` scanned the phase records for a `waiting`
 * one, `buildRecoveryContext` ran a regex over `finishedReason`, and the client
 * did not derive it at all — it simply said "usage limit", which is what a live
 * external-work park was announced as on an account with headroom to spare.
 * `waitReason` is the fact itself. The record scan stays as the fallback for
 * runs written before the field, and nothing more.
 */
test('an external park says so even after its records have been settled', () => {
  const dir = scratchRoot();
  try {
    const state = crashedRun(dir.root, { status: 'waiting' });
    state.waitUntil = '2026-08-25T02:40:42.850Z';
    state.waitReason = 'external';
    state.child = null;
    delete state.children;
    // The heuristic's blind spot: no `waiting` record survives here — the
    // settle path rewrote it — so a scan over the records reads "usage limit".
    const record = phaseRecord(state, 2);
    record.status = 'running';

    assert.equal(reconcileRun(state, undefined), true);
    assert.equal(state.status, 'paused');
    assert.equal(state.waitReason, 'external', 'the reason survives the reconcile, like the clock');
    assert.match(state.finishedReason ?? '', /external work/i);
    assert.doesNotMatch(state.finishedReason ?? '', /usage limit/i);
    assert.doesNotMatch(state.finishedReason ?? '', /another account/i);
  } finally { dir.cleanup(); }
});

test('a recorded usage limit is not talked out of it by a waiting record', () => {
  const dir = scratchRoot();
  try {
    const state = crashedRun(dir.root, { status: 'waiting' });
    state.waitUntil = '2026-08-25T02:40:42.850Z';
    state.waitReason = 'usage-limit';
    state.child = null;
    delete state.children;
    // A phase parked on external work AND the run stopped on the wall: the
    // record scan would answer "external" and drop the account advice.
    phaseRecord(state, 3).status = 'waiting';

    assert.equal(reconcileRun(state, undefined), true);
    assert.match(state.finishedReason ?? '', /usage limit/i);
  } finally { dir.cleanup(); }
});

test('a waiting run with no recorded reset still reconciles the old way', () => {
  const dir = scratchRoot();
  try {
    const state = crashedRun(dir.root, { status: 'waiting' });
    state.waitUntil = null;
    assert.equal(reconcileRun(state, undefined), true);
    assert.equal(state.status, 'interrupted', 'without a clock there is nothing to re-arm');
  } finally { dir.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Record-level board reconciliation
 *
 * The live incident this section defends: delivery-overhaul run 647b3ad7
 * ended with EIGHT phase records reading `failed`/`pending` while the board
 * read done on every one of them — the work had been finished by hand, by
 * closeout sessions, or by recoveries whose write-back was skipped, and
 * nothing ever rewrote a record from the board. "Departed" chips over red
 * records.
 * ------------------------------------------------------------------ */

test('records the board has overtaken become done, and the anchored halt clears', () => {
  const state = newRun({ slug: 'demo', root: '/tmp/whatever', model: 'opus' });
  state.status = 'halted';
  state.consecutiveFailures = 2;
  state.halt = { at: new Date().toISOString(), reason: 'no handoff', phase: 8, kind: 'no-handoff' };
  phaseRecord(state, 8).status = 'failed';
  phaseRecord(state, 2).status = 'pending';
  const waiting = phaseRecord(state, 5);
  waiting.status = 'waiting';
  waiting.parkedUntil = '2099-01-01T00:00:00Z';
  waiting.parkReason = 'ci';

  const { changed, closed } = reconcileRecordsAgainstBoard(
    state, { 8: 'done', 2: 'done', 5: 'done' },
  );

  assert.equal(changed, true);
  assert.deepEqual(closed.sort((a, b) => a - b), [2, 5, 8]);
  for (const phase of [2, 5, 8]) {
    assert.equal(state.phases[String(phase)].status, 'done');
    assert.match(state.phases[String(phase)].note ?? '', /closed outside this run/);
  }
  assert.equal(state.phases['5'].parkedUntil, undefined, 'a closed phase keeps no park clock');
  assert.equal(state.halt, null, 'a halt about a phase that is now done is a card about nothing');
  assert.equal(state.consecutiveFailures, 0);
});

test('a failed record whose phase the board does NOT read done is untouched — reconcile never re-runs', () => {
  const state = newRun({ slug: 'demo', root: '/tmp/whatever', model: 'opus' });
  state.status = 'halted';
  state.halt = { at: new Date().toISOString(), reason: 'verify failed', phase: 3, kind: 'verify-failed' };
  phaseRecord(state, 3).status = 'failed';

  const { changed } = reconcileRecordsAgainstBoard(state, { 3: 'ready' });

  assert.equal(changed, false);
  assert.equal(state.phases['3'].status, 'failed');
  assert.ok(state.halt, 'an unresolved halt stands');
});

test('QA gating cannot be reconciled past: a phase the board holds back is not closed', () => {
  // The engine folds QA into the board — a complete handoff whose QA verdict
  // is pending reads `in-progress`/not-done. Keying strictly on board `done`
  // is what keeps reconcile from closing a phase QA still gates.
  const state = newRun({ slug: 'demo', root: '/tmp/whatever', model: 'opus' });
  phaseRecord(state, 4).status = 'failed';

  const { changed } = reconcileRecordsAgainstBoard(state, { 4: 'in-progress' });

  assert.equal(changed, false);
  assert.equal(state.phases['4'].status, 'failed');
});

test('a live lane is never reconciled from under its loop', () => {
  const state = newRun({ slug: 'demo', root: '/tmp/whatever', model: 'opus' });
  phaseRecord(state, 6).status = 'running';

  const { changed } = reconcileRecordsAgainstBoard(state, { 6: 'done' });

  assert.equal(changed, false, 'running/verifying records belong to the loop, not the resolver');
  assert.equal(state.phases['6'].status, 'running');
});

test('a restart mid-park reconciles to paused with the clock and the waiting records intact', () => {
  const dir = scratchRoot();
  try {
    const state = newRun({ slug: 'demo', root: dir.root, model: 'opus' });
    state.status = 'waiting';
    state.waitUntil = '2099-01-01T00:00:00Z';
    const record = phaseRecord(state, 8);
    record.status = 'waiting';
    record.parkedUntil = '2099-01-01T00:00:00Z';
    record.sessionId = 'sess-8';

    assert.equal(reconcileRun(state, null), true);
    assert.equal(state.status, 'paused');
    assert.equal(state.waitUntil, '2099-01-01T00:00:00Z', 'the park clock survives the restart');
    assert.equal(state.phases['8'].status, 'waiting', 'a waiting record has no live child to reclaim');
    assert.equal(state.phases['8'].parkedUntil, '2099-01-01T00:00:00Z');
    assert.match(state.finishedReason ?? '', /external work/,
      'the pause explains itself as a park, not a usage limit');
  } finally { dir.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * One orphan shape, one reset
 * ------------------------------------------------------------------ */

test('a child that outlived its console is an orphaned-session halt on the read path too — the same kind adopt() writes', () => {
  const { root, cleanup } = scratchRoot();
  try {
    const state = crashedRun(root, {
      child: { pid: process.pid, phase: 12, sessionId: 'abc', startedAt: new Date().toISOString() },
    });
    assert.equal(reconcileRun(state, null), true);
    assert.equal(state.status, 'parked');
    assert.equal(state.halt?.kind, 'orphaned-session', 'the read path used to write a kindless halt for the same fact');
    assert.match(state.halt?.reason ?? '', /still running \(pid/);
  } finally { cleanup(); }
});

test('resetForRetry is the single reset: it clears what the last boarding concluded and keeps the history', () => {
  const state = newRun({ slug: 'demo', root: '/tmp/x', model: 'opus' });
  const record = phaseRecord(state, 3);
  Object.assign(record, {
    status: 'failed', note: 'did not verify', endedAt: '2026-08-21T10:00:00Z', attempts: 2, costUsd: 4.5,
    sessionId: 'sess-3', preflight: ['a warning'], preflightDetail: [{ kind: 'human-check', message: 'x' }],
    mcpDegraded: [{ id: 'github', reason: 'needs-auth' }], lockWaitSince: '2026-08-21T09:00:00Z', lockBackoffMs: 8000,
    boardingHint: { situation: 'verify-red', rung: 'resume-own-session', brief: 'continue', at: '2026-08-21T10:01:00Z' },
    verification: { ok: false, reason: 'red', ran: [], notRun: [] },
    stall: { signal: 'silent', since: '2026-08-21T09:40:00Z', detail: 'no output for 20 min' },
    idleAttempts: 2,
    verifyingSince: '2026-08-21T09:55:00Z',
    liveness: { phase: 3, lastOutputAt: '2026-08-21T09:40:00Z', turnsSinceLastTool: 4, commitsSinceStart: 0, treeDirty: false },
  });
  resetForRetry(record);
  assert.equal(record.status, 'pending');
  assert.equal(record.note, undefined);
  assert.equal(record.endedAt, undefined);
  assert.equal(record.preflight, undefined);
  assert.equal(record.preflightDetail, undefined);
  assert.equal(record.mcpDegraded, undefined);
  assert.equal(record.lockWaitSince, undefined, 'Retry means the lock wait starts over');
  assert.equal(record.lockBackoffMs, undefined);
  assert.equal(record.boardingHint, undefined, 'an operator\'s Retry is a fresh boot by definition');
  // The stall episode belongs to the attempt being given up on: kept, it would
  // re-announce on the next tick of a lane that has not had time to do
  // anything, with a clock reading from before the Retry.
  assert.equal(record.stall, undefined);
  assert.equal(record.idleAttempts, undefined, 'a Retry is not the fourth idle attempt');
  assert.equal(record.verifyingSince, undefined);
  // History stays: it is what the next brief and the ladder read.
  assert.equal(record.attempts, 2);
  assert.equal(record.costUsd, 4.5);
  assert.equal(record.sessionId, 'sess-3');
  assert.ok(record.verification);
  // The last liveness snapshot is history too — it is how a killed lane can
  // still say what it was doing when the console went away.
  assert.ok(record.liveness);
});

test('a crashed run is stamped as the system\'s stop; a stop or pause the operator had asked for stays theirs', () => {
  const crashed = crashedRun('/tmp/whatever');
  assert.equal(reconcileRun(crashed, null), true);
  assert.equal(crashed.stoppedBy, 'system', 'a console that died is not the operator');
  assert.match(crashed.phases['12'].note ?? '', CONSOLE_STOPPED_NOTE, 'the killed-lane note the convergence loop reads');

  const stopping = crashedRun('/tmp/whatever', { status: 'stopping' });
  assert.equal(reconcileRun(stopping, null), true);
  assert.equal(stopping.stoppedBy, 'operator', 'the operator had asked — their intent outlives the crash');

  const pausing = crashedRun('/tmp/whatever', {
    pause: { requestedAt: new Date().toISOString(), afterPhase: 12, by: 'console' },
  });
  assert.equal(reconcileRun(pausing, null), true);
  assert.equal(pausing.stoppedBy, 'operator');

  // The wait reconciled to paused is the system's too — and pinned by its clock anyway.
  const waiting = crashedRun('/tmp/whatever', { status: 'waiting', waitUntil: new Date(Date.now() + 60_000).toISOString(), child: null });
  assert.equal(reconcileRun(waiting, null), true);
  assert.equal(waiting.status, 'paused');
  assert.equal(waiting.stoppedBy, 'system');
});

/* ------------------------------------------------------------------ *
 * A run that is over must stop asking for attention
 * ------------------------------------------------------------------ */

test('settleFinishedRun: a run whose board is entirely done stops reading halted', () => {
  // Measured across a real console's fleet: three runs sat at `status: halted`
  // with `halt: null`, an auto `resolved`, and a finishedReason that literally
  // read "the board has since closed it — nothing is left of the halt". One was
  // 15/15 done; another had shipped as v3.0.0. `reconcileRecordsAgainstBoard`
  // dissolves the halt and writes the reason but never touches `status`, and
  // `shared/status-vocab.js` maps `halted` -> `needs-you` — the top attention
  // state. Three finished runs cried wolf for ever, which is how the one run
  // that genuinely needed a person went unnoticed.
  const state = newRun({ slug: 'alpha', root: '/tmp/x' });
  state.status = 'halted';
  state.resolved = { at: new Date().toISOString(), auto: true, reason: 'superseded' };
  state.finishedReason = 'halted on phase 2; the board has since closed it — nothing is left of the halt';
  assert.equal(settleFinishedRun(state, { 1: 'done', 2: 'done' }), true);
  assert.equal(state.status, 'finished');
  assert.equal(state.halt, null);
});

test('settleFinishedRun: work still on the board keeps the run where it is', () => {
  const state = newRun({ slug: 'alpha', root: '/tmp/x' });
  state.status = 'parked';
  assert.equal(settleFinishedRun(state, { 1: 'done', 2: 'ready' }), false);
  assert.equal(state.status, 'parked');
});

test('settleFinishedRun: an unreadable or empty board settles nothing', () => {
  const state = newRun({ slug: 'alpha', root: '/tmp/x' });
  state.status = 'halted';
  assert.equal(settleFinishedRun(state, {}), false, 'uncertainty must keep the card');
  assert.equal(state.status, 'halted');
});

test('settleFinishedRun: a live or already-finished run is left alone', () => {
  const running = newRun({ slug: 'alpha', root: '/tmp/x' });
  running.status = 'running';
  assert.equal(settleFinishedRun(running, { 1: 'done' }), false);
  const finished = newRun({ slug: 'alpha', root: '/tmp/x' });
  finished.status = 'finished';
  assert.equal(settleFinishedRun(finished, { 1: 'done' }), false, 'no needless write');
});

test('settleFinishedRun: a run the OPERATOR stopped is theirs to restart', () => {
  const state = newRun({ slug: 'alpha', root: '/tmp/x' });
  state.status = 'parked';
  state.stoppedBy = 'operator';
  assert.equal(settleFinishedRun(state, { 1: 'done' }), false);
  assert.equal(state.status, 'parked');
});

test('a record closed with no spend is marked unknown, not free', () => {
  // `costUsd` is written only from the CLI's terminal `result` message, so a
  // child the console's own shutdown killed books $0 for hours of real work —
  // and `run.spentUsd` never repairs it. Two runs on a real console read
  // `$0.00` against multi-hour sessions with real commits. A wrong number is
  // worse than an honest gap.
  const state = newRun({ slug: 'alpha', root: '/tmp/x' });
  const ran = phaseRecord(state, 1);
  ran.status = 'interrupted';   // what a child the console killed actually reads
  ran.startedAt = new Date().toISOString();
  ran.costUsd = 0;
  const paid = phaseRecord(state, 2);
  paid.status = 'failed';
  paid.startedAt = new Date().toISOString();
  paid.costUsd = 12.5;
  const never = phaseRecord(state, 3);
  never.status = 'pending';

  reconcileRecordsAgainstBoard(state, { 1: 'done', 2: 'done', 3: 'done' });
  assert.equal(state.phases['1'].costUnknown, true, 'it ran and reported nothing');
  assert.equal(state.phases['2'].costUnknown, undefined, 'a real figure is not a gap');
  assert.equal(state.phases['3'].costUnknown, undefined, 'a phase that never started cost nothing');
});

test('settleFinishedRun: a halt that dissolved stops the run reading halted', () => {
  // The other half of the dissolved-halt story. `reconcileRecordsAgainstBoard`
  // nulls `state.halt` when the board overtakes it, but leaves the status —
  // and `halted` with no halt is a contradiction whether or not the plan is
  // finished. Measured live: a run reading `halted`, `halt: null`, with a phase
  // still in progress on the board and 240 dollars spent. `parked` is the honest
  // word: stopped, work outstanding, nothing wrong that anybody named.
  const state = newRun({ slug: 'alpha', root: '/tmp/x' });
  state.status = 'halted';
  state.halt = null;
  assert.equal(settleFinishedRun(state, { 1: 'done', 2: 'in-progress', 3: 'waiting' }), true);
  assert.equal(state.status, 'parked', 'stopped with work left is parked, not halted');

  // A halt that still STANDS is untouched — it is the record of why.
  const halted = newRun({ slug: 'alpha', root: '/tmp/x' });
  halted.status = 'halted';
  halted.halt = { at: new Date().toISOString(), reason: 'phase 2 did not verify', phase: 2 };
  assert.equal(settleFinishedRun(halted, { 1: 'done', 2: 'ready' }), false);
  assert.equal(halted.status, 'halted');
});

/* ------------------------------------------------------------------ *
 * A QA-held phase does not settle the run that stopped on it
 * ------------------------------------------------------------------ */

test('autoResolveRun: a done phase QA is holding does not read as "nothing is wrong"', () => {
  // Every QA rung anchors on a phase the board reads `done` — that is the point
  // of admitting one as a candidate. So when such a rung's session does not end
  // cleanly, the run halts with a DONE phase attached, and the board resolver
  // reads exactly that ("the board shows phase 1 done") as superseded. It stamps
  // `resolved`, which `converge.ts` treats as pinned: boot, timer, change and
  // halt passes all skip the plan for ever after.
  //
  // Net effect before this: one imperfect QA session — a red verification, a
  // session that refuses, a crash — and the unattended path terminates
  // permanently, silently, on its most likely first stumble. The whole change
  // set exists to remove exactly that shape.
  const held = new Set([1]);

  const stopped = newRun({ slug: 'alpha', root: '/tmp/x' });
  stopped.status = 'halted';
  stopped.halt = { at: new Date().toISOString(), reason: 'phase 1 did not verify', phase: 1, kind: 'verify-failed' };
  assert.equal(autoResolveRun(stopped, { 1: 'done', 2: 'waiting' }, held), false,
    'QA is still holding phase 1 — the stop is about something real');
  assert.equal(stopped.resolved, undefined);

  // The same run, once the verdict is cleared, settles as it always did.
  assert.equal(autoResolveRun(stopped, { 1: 'done', 2: 'waiting' }, new Set()), true);
  assert.ok(stopped.resolved);
});

test('autoResolveRun: the guard covers the activePhase anchor too', () => {
  // `decidingPhases` takes `halt.phase ?? activePhase`, and the common path
  // through a failed verification nulls the halt (the record reconciles first),
  // so the anchor that survives is `activePhase`. A guard that only knew about
  // `halt.phase` would leave the more likely route open.
  const stopped = newRun({ slug: 'alpha', root: '/tmp/x' });
  stopped.status = 'halted';
  stopped.halt = null;
  stopped.activePhase = 1;
  assert.equal(autoResolveRun(stopped, { 1: 'done' }, new Set([1])), false);
  assert.equal(autoResolveRun(stopped, { 1: 'done' }, new Set()), true);
});

test('autoResolveRun: an unrelated QA hold does not pin a run that really is over', () => {
  // Narrow on purpose: only a phase this run STOPPED on matters. A verdict
  // holding some other phase is somebody else's problem, and reading it here
  // would keep finished runs on the attention surface — the failure this
  // resolver exists to prevent.
  const stopped = newRun({ slug: 'alpha', root: '/tmp/x' });
  stopped.status = 'halted';
  stopped.halt = { at: new Date().toISOString(), reason: 'phase 1 failed', phase: 1, kind: 'verify-failed' };
  assert.equal(autoResolveRun(stopped, { 1: 'done', 2: 'done' }, new Set([2])), true);
});


/* ------------------------------------------------------------------ *
 * The orphan handle — it must survive the console that recorded it
 * ------------------------------------------------------------------ */

/**
 * A pid that certainly exists, because `processState` asks `kill(pid, 0)`
 * BEFORE it consults the `ps` seam — existence is the cheap question and the
 * seam only supplies the details. Stubbing `ps` for a pid nobody has would
 * therefore prove nothing.
 */
const LIVE_PID = process.pid;

test('a ChildRef whose process is alive survives into reconcile from a NEW console generation', async () => {
  // The incident, reduced. A checkpoint carries phase 9's live pid; a fresh
  // console starts holding a different lane. `syncMirror` used to project its
  // own lane table wholesale over `children`, erasing the only durable handle
  // on a session that was still editing the tree — after which the run read
  // dead, its lock was released as debris, and its record stayed at "running"
  // with nothing in the console pointing at the process.
  const { setPsReader } = await import('../server/pid.ts');
  const restore = setPsReader(() => ({ stat: 'T', comm: 'claude', lstart: 'Sat Aug 22 20:30:07 2026' }));
  try {
    const state = crashedRun('/tmp/whatever', {
      status: 'running',
      children: { 9: { pid: LIVE_PID, phase: 9, sessionId: 's9', startedAt: '2026-08-22T11:12:14Z' } },
      child: null,
    });

    assert.equal(reconcileRun(state, null), true);
    assert.equal(state.status, 'parked', 'a live child parks the run — it does not reclaim it');
    assert.equal(state.halt?.kind, 'orphaned-session');
    assert.match(state.halt?.reason ?? '', new RegExp(`pid ${LIVE_PID}`));
    assert.match(state.halt?.reason ?? '', new RegExp(`kill -CONT ${LIVE_PID}`),
      'a STOPPED orphan gets the remedy that actually moves it — the probe knows it is stopped '
      + 'even though no `frozen` flag survived the console that stopped it');
    assert.ok(state.children?.['9'], 'and the handle itself is still on the record');
  } finally { setPsReader(restore); }
});

test('a ChildRef whose pid was recycled is NOT mistaken for the child that used to hold it', async () => {
  const { setPsReader } = await import('../server/pid.ts');
  const restore = setPsReader(() => ({ stat: 'S', comm: 'claude', lstart: 'Sun Aug 23 09:00:00 2026' }));
  try {
    const state = crashedRun('/tmp/whatever', {
      status: 'running',
      children: {
        9: {
          pid: LIVE_PID, phase: 9, sessionId: 's9', startedAt: '2026-08-22T11:12:14Z',
          procStartedAt: '2026-08-22T17:30:07Z',   // ours started at 17:30; this one, hours later
        },
      },
      child: null,
    });
    assert.equal(reconcileRun(state, null), true);
    assert.equal(state.status, 'interrupted',
      'the pid belongs to somebody else now, so the run is reclaimed rather than parked forever '
      + 'with kill advice aimed at an innocent process');
  } finally { setPsReader(restore); }
});

/* ------------------------------------------------------------------ *
 * Where the session was editing — it must outlive the console that knew
 * ------------------------------------------------------------------ */

/**
 * `syncMirror` is the write path for `state.children`, and it is protected.
 * Driving it directly is the only way to assert its MERGE rules without
 * spawning a session — the same seam `invariants.test.ts` clause 2 uses.
 */
function syncMirror(runner: unknown): void {
  (runner as { syncMirror: () => void }).syncMirror();
}

function laneOf(phase: number, pid: number, over: Record<string, unknown> = {}) {
  return {
    phase, pid, handle: null, grant: null, frozen: null, freezeTimer: null,
    stopped: null, checkpointed: false, checkpointNote: null, leaseTimer: null,
    signals: newLaneSignals(Date.now()), ...over,
  };
}

async function mirrorRunner(state: RunState): Promise<unknown> {
  const { Runner } = await import('../server/runner/runner.ts');
  const runner = new Runner({ scriptsDir: '/nonexistent', verificationText: () => undefined });
  (runner as unknown as { state: RunState }).state = state;
  return runner;
}

test('a lane checkout and its branch reach the checkpoint, and a shared lane claims neither', async () => {
  // The fact a lane worktree makes true is "this session is NOT editing the
  // run's root", and the process that knows it is the first thing a restart
  // loses. Absent means shared — so the assertion has two halves, and the
  // negative one is the load-bearing half: a lane with no checkout of its own
  // must write no fields at all, or every reader of the convention reads the
  // opposite of the truth.
  // Live pids throughout: the restart half of this test reads the checkpoint
  // back through `loadRun`, which reconciles — and a dead pid is correctly
  // reclaimed, taking `children` with it. The fields are only interesting on a
  // run whose sessions are still there to be found.
  const { setPsReader } = await import('../server/pid.ts');
  const restore = setPsReader(() => ({ stat: 'S', comm: 'claude', lstart: 'Sat Aug 22 20:30:07 2026' }));
  const dir = scratchRoot();
  try {
    const state = newRun({ slug: 'demo', root: dir.root, model: 'opus' });
    phaseRecord(state, 4).status = 'running';
    phaseRecord(state, 7).status = 'running';
    const runner = await mirrorRunner(state);
    const lanes = (runner as { lanes: Map<number, unknown> }).lanes;
    lanes.set(4, laneOf(4, LIVE_PID, {
      worktree: '/tmp/worktrees/r1/p4', branch: 'pe/demo-p4',
    }));
    lanes.set(7, laneOf(7, LIVE_PID));
    syncMirror(runner);

    assert.equal(state.children?.['4']?.worktree, '/tmp/worktrees/r1/p4');
    assert.equal(state.children?.['4']?.branch, 'pe/demo-p4');
    assert.equal(state.children?.['7']?.worktree, undefined,
      'a lane sharing the run root must record NO worktree — absent is how every reader spells shared');
    assert.equal(state.children?.['7']?.branch, undefined);

    // And it survives the console, which is the whole reason it is written at
    // all: `saveRun`/`loadRun` is the restart, reduced to two calls.
    saveRun(state);
    const back = loadRun(dir.root, 'demo', state.id);
    assert.equal(back?.children?.['4']?.worktree, '/tmp/worktrees/r1/p4');
    assert.equal(back?.children?.['4']?.branch, 'pe/demo-p4');
    assert.equal(back?.children?.['7']?.worktree, undefined);
  } finally { setPsReader(restore); dir.cleanup(); }
});

test('a lane that degraded to the shared root does NOT inherit the previous attempt\'s checkout', async () => {
  // The merge rule that differs from `procStartedAt`'s, deliberately. A start
  // time is stamped once and unrecoverable, so it is carried forward; a
  // worktree is decided before the pid exists and lives as long as the lane, so
  // the lane always knows — and carrying one forward would let a second attempt
  // that could NOT get a checkout go on claiming the first attempt's.
  const dir = scratchRoot();
  try {
    const state = newRun({ slug: 'demo', root: dir.root, model: 'opus' });
    phaseRecord(state, 4).status = 'running';
    state.children = {
      4: {
        pid: DEAD_PID, phase: 4, sessionId: 's4', startedAt: '2026-08-22T11:12:14Z',
        worktree: '/tmp/worktrees/r1/p4', branch: 'pe/demo-p4',
      },
    };
    const runner = await mirrorRunner(state);
    (runner as { lanes: Map<number, unknown> }).lanes.set(4, laneOf(4, DEAD_PID));
    syncMirror(runner);

    assert.equal(state.children?.['4']?.worktree, undefined,
      'the retry is working in the shared root and the record must say so');
    assert.equal(state.children?.['4']?.branch, undefined);
  } finally { dir.cleanup(); }
});

test('a FOREIGN lane\'s checkout survives the merge byte-for-byte', async () => {
  // Clause 2 of the invariants, extended to the new fields: this console's
  // lanes are authoritative for their own phases and for nothing else. A
  // foreign entry is the only durable handle on a session that outlived its
  // console — and after these fields it is also the only record of the tree
  // that session is editing, which is exactly what an operator needs to find it.
  const { setPsReader } = await import('../server/pid.ts');
  const restore = setPsReader(() => ({ stat: 'S', comm: 'claude', lstart: 'Sat Aug 22 20:30:07 2026' }));
  const dir = scratchRoot();
  try {
    const state = newRun({ slug: 'demo', root: dir.root, model: 'opus' });
    state.children = {
      9: {
        pid: LIVE_PID, phase: 9, sessionId: 's9', startedAt: '2026-08-22T11:12:14Z',
        worktree: '/tmp/worktrees/r0/p9', branch: 'pe/demo-p9',
      },
    };
    const before = JSON.stringify(state.children['9']);
    const runner = await mirrorRunner(state);
    (runner as { lanes: Map<number, unknown> }).lanes.set(2, laneOf(2, LIVE_PID));
    syncMirror(runner);

    assert.equal(JSON.stringify(state.children?.['9']), before,
      'a lane this console never drove keeps every field it arrived with, worktree included');
  } finally { setPsReader(restore); dir.cleanup(); }
});

test('a pre-`procStartedAt` record gets no identity check — "I cannot tell" is not "it is gone"', async () => {
  const { setPsReader } = await import('../server/pid.ts');
  const restore = setPsReader(() => ({ stat: 'S', comm: 'claude', lstart: 'Sun Aug 23 09:00:00 2026' }));
  try {
    const state = crashedRun('/tmp/whatever', {
      status: 'running',
      children: { 9: { pid: LIVE_PID, phase: 9, sessionId: 's9', startedAt: '2026-08-22T11:12:14Z' } },
      child: null,
    });
    assert.equal(reconcileRun(state, null), true);
    assert.equal(state.status, 'parked',
      'with no recorded process start there is nothing to compare against, and the safe answer '
      + 'for a branch whose "gone" would reclaim a run is to park');
  } finally { setPsReader(restore); }
});

test('a verification this run RAN and failed is not reconciled away by the board (D27)', () => {
  // Measured: `pnpm verify:local` ran 9.7 minutes, failed, halted the run —
  // and sixty seconds later this function wrote `phase.reconciled
  // {outcome: done}` and dissolved the halt, because the phase's own handoff
  // read complete. Two readers, opposite verdicts, one minute apart, and the
  // one that had actually run the commands lost. The board is not overtaking
  // anything here: it is reading the very handoff the verification just
  // contradicted.
  const state = newRun({ slug: 'demo', root: '/tmp/whatever', model: 'opus' });
  state.status = 'halted';
  state.halt = { at: new Date().toISOString(), reason: 'phase 3 did not verify', phase: 3, kind: 'verify-failed' };
  const record = phaseRecord(state, 3);
  record.status = 'failed';
  record.verification = {
    ok: false,
    ran: [{ command: 'pnpm verify:local', ok: false, code: 1, ms: 583_000, output: 'FAIL' }],
  };

  const { changed, closed } = reconcileRecordsAgainstBoard(state, { 3: 'done' });

  assert.equal(changed, false);
  assert.deepEqual(closed, []);
  assert.equal(state.phases['3'].status, 'failed', 'the evidence this process produced stands');
  assert.ok(state.halt, 'and so does the halt it caused');
});

test('every OTHER failed record still reconciles — the D27 hold is narrow', () => {
  // The hold must not turn into "a failed phase is never closed". A session
  // that died, a lint halt, a phase closed by hand while this run was busy
  // elsewhere: all still close on a board that reads done.
  const state = newRun({ slug: 'demo', root: '/tmp/whatever', model: 'opus' });
  phaseRecord(state, 1).status = 'failed';
  const green = phaseRecord(state, 2);
  green.status = 'failed';
  green.verification = { ok: true, ran: [{ command: 'true', ok: true, code: 0, ms: 1, output: '' }] };
  const unrun = phaseRecord(state, 3);
  unrun.status = 'failed';
  // Nothing RAN: an unanswered question is not a verdict, and it must not
  // pin a phase the board has genuinely moved past.
  unrun.verification = { ok: false, ran: [] };

  const { closed } = reconcileRecordsAgainstBoard(state, { 1: 'done', 2: 'done', 3: 'done' });

  assert.deepEqual(closed.sort((a, b) => a - b), [1, 2, 3]);
});
