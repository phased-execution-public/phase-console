/**
 * Waiting is a state, not a failure — the six promises of Phase 1.
 *
 * Provenance: `console-unattended-autopilot` §Phase 1, register R1–R13. Every
 * assertion below is one of the six exit criteria, in order:
 *
 *   1. `AdmissionCapped` is an `AdmissionAborted`, so the recovery path that
 *      catches the abort cannot leave the cap as an unhandled rejection.
 *   2. A sibling GRANT, and a lock whose session the registry says is LIVE,
 *      are never capped; a dead or unknown foreign lock still is. A
 *      declaration ends the wait, so the next admission measures from zero.
 *   3. The halt kinds split: phase-level kinds settle the PHASE (`record.halt`),
 *      run-level kinds stop the RUN (`state.halt`).
 *   4. `record.declared` is deleted only by `consumeDeclaration`, under a named
 *      licence.
 *   5. A `blocked` handoff is `blocked-declared:*`, never `plan-broken`;
 *      `stale-handoff` is a warning; the plan-broken errand quotes the issue.
 *   6. `interrupted` rungs count toward no cap; an errand's `tried` is the
 *      current situation's rungs and `earlier` carries the rest.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADJUDICATED_HALT_KINDS, HALT_KINDS, PHASE_HALT_KINDS, RUN_HALT_KINDS, isAdjudicatedHalt,
} from '../shared/recovery-model.js';
import { SITUATIONS } from '../shared/situation-model.js';
import { AdmissionAborted, AdmissionCapped, isCappableBlocker } from '../server/runner/scheduler.ts';
import { loadRun, runFile } from '../server/runner/state.ts';
import { haltKindLiterals } from './halt-kind-scan.ts';
import { fixtureRuns } from './journal-fixture.ts';
import {
  consumeDeclaration, endLockWait, newRun, phaseRecord, reconcileRecordsAgainstBoard, resetForRetry,
  latestEnding, resolveRunsAgainst, retirePhaseHalt, saveRun, journalFile,
  DECLARATION_CONSUMERS, DECLARATION_CONSUMED_EVENT,
  type PhaseRecord, type RungRecord,
} from '../server/runner/state.ts';
import { classifySituation, type PhaseEvidence } from '../server/runner/situation.ts';
import { errandFor, nextRung } from '../server/runner/ladder.ts';
import { evidenceFingerprint } from '../server/converge.ts';

/* ------------------------------------------------------------------ *
 * 1. A capped admission is an aborted admission
 * ------------------------------------------------------------------ */

test('AdmissionCapped is an AdmissionAborted — one catch covers both', () => {
  const capped = new AdmissionCapped('alpha', 3, 7_200_000);
  assert.ok(capped instanceof AdmissionAborted,
    'the recovery path catches AdmissionAborted; a cap that is not one is an unhandled rejection');
  assert.ok(capped instanceof Error);
  assert.equal(capped.name, 'AdmissionCapped');
  assert.equal(capped.waitedMs, 7_200_000);
  // …and the two stay distinguishable in the other direction.
  assert.equal(new AdmissionAborted('alpha', 3) instanceof AdmissionCapped, false);
});

/* ------------------------------------------------------------------ *
 * 2. What may be capped, and when the clock starts over
 * ------------------------------------------------------------------ */

test('only a foreign lock whose session is not live may be capped', () => {
  const lock = (extra: Record<string, unknown> = {}) =>
    ({ kind: 'lock', owner: 'someone/else', slug: 'beta', phase: 2, overlaps: ['app'], ...extra } as never);

  assert.equal(isCappableBlocker(lock()), true, 'a foreign lock with no presence reading still caps');
  assert.equal(isCappableBlocker(lock({ presence: 'unknown' })), true);
  assert.equal(isCappableBlocker(lock({ presence: 'live' })), false,
    'a lock the registry says is LIVE is somebody working, not a dead claim');
  assert.equal(isCappableBlocker({ kind: 'grant', owner: 'autopilot/x', slug: 'alpha', overlaps: [] } as never), false,
    'a sibling grant is pipelining — capping it parks the waiter for waiting well');
  assert.equal(isCappableBlocker({ kind: 'reserved', owner: 'autopilot/x', slug: 'alpha', overlaps: [] } as never), false);
  assert.equal(isCappableBlocker({ kind: 'lock', owner: 'x', slug: 'a', overlaps: [], clock: true } as never), false,
    'a clock blocker ends by itself');
});

test('endLockWait clears the wait so the next admission measures from zero', () => {
  const record: PhaseRecord = phaseRecord(newRun({ slug: 'alpha', root: '/tmp/x' }), 1);
  record.lockWaitSince = '2026-08-01T00:00:00.000Z';
  record.waitingOn = [{ slug: 'beta', phase: 2, owner: 'someone/else' }];
  endLockWait(record);
  assert.equal(record.lockWaitSince, undefined);
  assert.equal(record.waitingOn, undefined);
  // Idempotent: a park that follows a declaration must not throw.
  endLockWait(record);
  assert.equal(record.lockWaitSince, undefined);
});

/* ------------------------------------------------------------------ *
 * 3. The halt split
 * ------------------------------------------------------------------ */

/**
 * The walk runs over every halt-kind literal a WRITER under `server/` names —
 * `test/halt-kind-scan.ts` — unioned with `HALT_KINDS`, not over `HALT_KINDS`
 * alone. Iterating the list proves the list agrees with itself; the drive loop
 * wrote `plan-deadlocked` for weeks while this test was green, because the
 * word was in no list for it to iterate (sep-review LFC-1, gate ACC-11.1).
 */
const writtenKinds = (): Set<string> => new Set([...HALT_KINDS, ...haltKindLiterals().keys()]);

test('every halt kind a writer names is in HALT_KINDS — no word escapes the vocabulary', () => {
  const literals = haltKindLiterals();
  assert.ok(literals.size >= 15, `the scan found only ${literals.size} kinds written under server/ — it is not reading the writers`);
  const unlisted = [...literals].filter(([kind]) => !(HALT_KINDS as readonly string[]).includes(kind))
    .map(([kind, sites]) => `${kind} at ${sites.map((s) => `${s.file}:${s.line}`).join(', ')}`);
  assert.deepEqual(unlisted, [], 'a writer names a halt kind HALT_KINDS does not hold — add it to the list, a side and KIND_PROFILE');
  // The four the census found: written, and now listed.
  for (const kind of ['plan-deadlocked', 'nothing-ready', 'interrupted-by-restart', 'operator-stop']) {
    assert.ok(literals.has(kind), `${kind} has no writer under server/ any more`);
  }
});

test('every halt kind is phase-level or run-level, and never both', () => {
  const phase = new Set<string>(PHASE_HALT_KINDS);
  const run = new Set<string>(RUN_HALT_KINDS);
  for (const kind of writtenKinds()) {
    assert.equal(phase.has(kind) !== run.has(kind), true, `${kind} must be in exactly one list`);
  }
  assert.equal(phase.size + run.size, HALT_KINDS.length, 'no kind may be listed twice');
  // The plan's table, pinned: a phase-level kind must not stop the run.
  for (const kind of [
    'verify-failed', 'no-handoff', 'phase-blocked', 'needs-human', 'waiting-external-timeout',
    'verification-preflight', 'mcp-preflight', 'recovery-failed', 'orphaned-session',
    'phase-crashed', 'worktree-merge', 'landing-conflict',
  ]) assert.ok(phase.has(kind), `${kind} is a fact about one phase`);
  for (const kind of [
    'budget', 'failure-streak', 'models-exhausted', 'run-preflight', 'plan-unreadable',
    'plan-lint', 'runner-crashed',
  ]) assert.ok(run.has(kind), `${kind} is a fact about the whole run`);
});

/**
 * The board/lock/validate stubs a Runner needs to drive a one-phase plan.
 * Same shape as `settle-matrix.test.ts`'s, kept local so this file states its
 * own fixture rather than importing one across test files.
 */
function boardHarness(): { root: string; scriptsDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-wias-'));
  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(scriptsDir, 'phase-graph.sh'), `#!/bin/bash
case "$2" in
  --memory-block) echo "ready: 1"; echo "done: "; echo "phase 1: ready" ;;
  --gate-status)  echo "clear (no gate)" ;;
  --boot-prompt)  echo "do phase 1" ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });
  return { root, scriptsDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * The MECHANISM half of exit criterion 3. Its end-to-end half — the queued
 * sibling actually boarding, with zero `phase.not-started` — needs two lanes and
 * a scheduler, so it lives beside that fixture:
 * `runner-parallel.test.ts` → "criterion 3: a phase-level ending settles ONE
 * phase — the queued sibling boards, never phase.not-started".
 */
test('a phase-level kind settles the PHASE and leaves the run boardable', async () => {
  const { Runner } = await import('../server/runner/runner.ts');
  const h = boardHarness();
  try {
    const runner = new Runner({
      scriptsDir: h.scriptsDir,
      spawn: async () => { throw new Error('a recheck must spawn nothing'); },
      verify: async () => ({ ok: true, reason: 'green', notRun: [], ran: [] }),
      verificationText: () => 'run those commands.',
      origin: 'http://127.0.0.1:4123',
    });
    // A phase that boarded, ended, and left the board reading `ready` — the
    // `no-handoff` shape, which is PHASE-level.
    const state = newRun({ slug: 'demo', root: h.root, model: 'opus' });
    state.status = 'parked';
    state.phases['1'] = {
      phase: 1, status: 'interrupted', attempts: 1, costUsd: 1, sessionId: 'sess-1',
      closeout: { at: '2026-08-01T00:00:00.000Z', ran: true },
    } as never;
    saveRun(state);

    const after = await runner.recover({
      slug: 'demo', root: h.root, runId: state.id, phase: 1, mode: 'recheck', by: 'operator',
    });
    await runner.wait();

    assert.equal(after.phases['1'].halt?.kind, 'no-handoff', 'the ending is on the PHASE');
    assert.match(after.phases['1'].halt?.reason ?? '', /the board still reads/);
    // …and NOT on the run. This is the whole sibling-drain fix, at its
    // mechanism: `boardingBlocked()` answers `halted` if and only if
    // `state.halt` is set, so an empty one is what lets a lane already queued
    // on its scope keep its place instead of being drained with
    // `phase.not-started` (125 of those in the corpus).
    assert.equal(after.halt, null, 'a phase-level kind must not stop the run');
  } finally { h.cleanup(); }
});

test('a retired ending is retired on the PHASE too — a stale record.halt cannot pin a phase', () => {
  const run = newRun({ slug: 'alpha', root: '/tmp/x' });
  const record = phaseRecord(run, 1);
  record.status = 'failed';
  record.halt = { at: '2026-08-30T10:00:00.000Z', reason: 'red', phase: 1, kind: 'verify-failed' };

  resetForRetry(record, { by: 'operator', journal: () => {} });
  assert.equal(record.halt, undefined,
    'a Retry is a fresh attempt; the reason the last one stopped describes nothing');

  // …and the helper the other retire paths call is idempotent and null-safe.
  retirePhaseHalt(record);
  retirePhaseHalt(undefined);
});

test('SKIP retires the ending too — a skipped phase is never re-boarded, so nothing else would', () => {
  const run = newRun({ slug: 'alpha', root: '/tmp/x' });
  const record = phaseRecord(run, 1);
  record.status = 'failed';
  record.halt = { at: '2026-08-30T10:00:00.000Z', reason: 'the box is unreachable', phase: 1, kind: 'needs-human' };

  // What `Runner.skip` and `Service.skipPhase` both do to the record. Skip is
  // PERMANENT — nothing re-boards or retries a skipped record — so an ending
  // left here is one the classifier reads for the life of the run, and a
  // `needs-human`/`phase-blocked` kind keeps `declaredBlocked` true, which
  // suppresses all three plan-health arms with it.
  record.status = 'skipped';
  record.note = 'skipped by the operator';
  retirePhaseHalt(record);

  assert.equal(record.halt, undefined);
  assert.equal(classifySituation({
    ...EVIDENCE,
    board: 'ready',
    handoff: { exists: false },
    record: { status: 'skipped', attempts: 0, note: 'skipped by the operator' },
    run: { status: 'parked', halt: null, waitUntil: null, resolved: false },
    health: [],
    work: { did: false, why: 'clean tree', dirty: 0, commits: 0 },
  } as PhaseEvidence).id, 'never-started', 'the skipped phase is not pinned by an ending nobody will retire');
});

/* The board-overtake door, which is the FIFTH retire site and the one a
 * `record.halt` can quietly close. `reconcileRecordsAgainstBoard` holds a
 * record back — never closing it, so never retiring its ending — when this run
 * ADJUDICATED the phase's §Verification and said no. It must not hold one back
 * when the run merely never got there: for those, a board that now reads `done`
 * is a handoff that did not exist when the run stopped, which is exactly what
 * "closed outside this run" means. Getting this wrong re-opens round 1's wedge
 * through a new door — the ending is never retired, the classifier keeps
 * reading it (`rec.halt ?? state.halt`), and `endedBadly` keeps the run out of
 * `finished` for as long as it lives. */

test('the adjudicated kinds are a strict subset of the phase-level ones', () => {
  for (const kind of ADJUDICATED_HALT_KINDS) {
    assert.ok(PHASE_HALT_KINDS.includes(kind),
      `${kind} adjudicates a phase, so it must be phase-level`);
  }
  assert.ok(ADJUDICATED_HALT_KINDS.length < PHASE_HALT_KINDS.length,
    'a verdict about the work is a strict subset of the endings a phase can have');
  assert.equal(isAdjudicatedHalt('no-handoff'), false, 'no handoff is "we never got there"');
  assert.equal(isAdjudicatedHalt('verify-failed'), true);
  assert.equal(isAdjudicatedHalt(undefined), false);
});

test('the board overtakes a "never got there" ending — and retires it', () => {
  // A session that ended without writing a handoff, and a person who wrote one
  // afterwards. The halt says "no handoff was written"; the board now reads
  // done, so a handoff exists and the complaint is void.
  const run = newRun({ slug: 'alpha', root: '/tmp/x' });
  const record = phaseRecord(run, 1);
  record.status = 'failed';
  record.attempts = 1;
  record.halt = { at: '2026-08-30T10:00:00.000Z', reason: 'no handoff was written', phase: 1, kind: 'no-handoff' };

  const { changed, closed } = reconcileRecordsAgainstBoard(run, { 1: 'done' });

  assert.equal(changed, true);
  assert.deepEqual(closed, [1], 'the board overtook it, so reconcile closes it');
  assert.equal(record.status, 'done');
  assert.equal(record.halt, undefined,
    'a halt anchored to a phase that is now done is a card about nothing — and nothing else '
    + 'would ever retire this one: the phase is done, so it never re-boards and never retries');
});

test('the board does NOT overtake a verification this run ran and failed', () => {
  // D27, unchanged: the board is reading the very handoff the red verdict
  // contradicts, so "the board has overtaken it" is false — the board never knew.
  const run = newRun({ slug: 'alpha', root: '/tmp/x' });
  const record = phaseRecord(run, 1);
  record.status = 'failed';
  record.verification = { ok: false, reason: 'suite red', ran: [{ command: 'npm test', ok: false, output: '' }], notRun: [] } as never;
  record.halt = { at: '2026-08-30T10:00:00.000Z', reason: 'did not verify', phase: 1, kind: 'verify-failed' };

  const { closed } = reconcileRecordsAgainstBoard(run, { 1: 'done' });

  assert.deepEqual(closed, [], 'evidence this process produced itself; no handoff outranks it');
  assert.equal(record.status, 'failed');
  assert.equal(record.halt?.kind, 'verify-failed');
});

test('the board does NOT overtake a manual sign-off a person rejected', () => {
  // The case with NOTHING on `record.verification.ran` to hold it: the plan's
  // §Verification was pure prose, a person was asked, and they said no. Held by
  // the halt KIND, which is the only evidence left of that answer.
  const run = newRun({ slug: 'alpha', root: '/tmp/x' });
  const record = phaseRecord(run, 1);
  record.status = 'failed';
  record.halt = {
    at: '2026-08-30T10:00:00.000Z', phase: 1, kind: 'needs-human',
    reason: 'phase 1 was not verified: the gate box never rendered',
  };

  const { closed } = reconcileRecordsAgainstBoard(run, { 1: 'done' });

  assert.deepEqual(closed, [], 'a person looked and said no; the handoff does not outrank them');
  assert.equal(record.halt?.kind, 'needs-human');
});

test('a stale phase halt no longer decides the situation after a retry', () => {
  const stale: PhaseEvidence = {
    ...EVIDENCE,
    board: 'ready',
    handoff: { exists: false },
    record: { status: 'pending', attempts: 0, note: null },
    run: { status: 'parked', halt: null, waitUntil: null, resolved: false },
    handoffOutstandingUnused: undefined,
    health: [],
    work: { did: false, why: 'clean tree, no commits', dirty: 0, commits: 0 },
  } as PhaseEvidence;
  assert.equal(classifySituation(stale).id, 'never-started',
    'a reset phase reads from its evidence, not from an ending that was retired');

  // The failure this pins: with the halt still on the record, `verify-failed`
  // pinned the phase at `verify-red` for the life of the run, and a
  // `needs-human`/`phase-blocked` one kept `declaredBlocked` true — which
  // suppressed all three plan-health arms for ever.
  const pinned: PhaseEvidence = {
    ...stale,
    record: { ...stale.record!, halt: { kind: 'verify-failed', reason: 'red', phase: 12 } },
  };
  assert.equal(classifySituation(pinned).id, 'verify-red',
    'the reader still honours a halt that is genuinely there — the fix is the WRITER retiring it');
});

test('the fingerprint moves when a phase-level halt is written', () => {
  const run = newRun({ slug: 'alpha', root: '/tmp/x' });
  const record = phaseRecord(run, 2);
  record.status = 'failed';
  const before = evidenceFingerprint(run, { 2: 'ready' }, []);
  record.halt = { at: '2026-08-30T10:00:00.000Z', reason: 'verification failed', phase: 2, kind: 'verify-failed' };
  assert.notEqual(evidenceFingerprint(run, { 2: 'ready' }, []), before,
    'a settled phase is a new fact; without it converge latches on "nothing has changed"');
});

/* ------------------------------------------------------------------ *
 * 4. The declaration outlives every re-board
 * ------------------------------------------------------------------ */

test('consumeDeclaration is the only way a declaration is spent, and it says why', () => {
  const record: PhaseRecord = phaseRecord(newRun({ slug: 'alpha', root: '/tmp/x' }), 1);
  record.declared = { status: 'needs-human', reason: 'the box is unreachable', at: '2026-08-29T00:00:00.000Z' };
  record.watchChecked = { at: '2026-08-29T00:00:00.000Z', ref: 'gh:o/r#run/1', state: 'pending' };

  const spent = consumeDeclaration(record, 'new-outcome');
  assert.ok(spent, 'a declaration that was there is consumed');
  assert.equal(spent.why, 'new-outcome');
  assert.equal(spent.status, 'needs-human');
  assert.equal(record.declared, undefined);
  assert.equal(record.watchChecked, undefined);

  // Nothing to consume: the caller gets null and journals nothing.
  assert.equal(consumeDeclaration(record, 'board-closed'), null);
});

/**
 * WAI-9 — every licence journals, through its real caller. Two of the four
 * (`new-outcome`, `session-productive`) journalled; `board-closed` and `retry`
 * spent testimony in silence — and `board-closed` is the commonest ending a
 * declaration has (19 of the audit's 22 never-resumed waits). The four
 * callers, and where each is held to exactly one line:
 *   - `board-closed` → `reconcileRecordsAgainstBoard` (here, both sinks);
 *   - `retry`        → `resetForRetry` (here, with `by`);
 *   - `new-outcome`  → `routeOutcome` / `declareOutcome` / the stored twin
 *     (`runner.test.ts` "WAI-9: a new declaration spends the old one once",
 *     `sessions-presence.test.ts` "WAI-8 / SLF-4 … stallRemedy survives");
 *   - `session-productive` → `onStream` on a durable-progress event
 *     (`runner.test.ts` "WAI-4: a resumed wait that only LOOKS keeps its declaration").
 */
test('WAI-9: board-closed journals exactly one phase.declaration-consumed — through the run\'s own journal when nobody passes one', () => {
  assert.deepEqual([...DECLARATION_CONSUMERS], ['new-outcome', 'session-productive', 'board-closed', 'retry']);
  const root = mkdtempSync(join(tmpdir(), 'pc-wai9-'));
  try {
    const state = newRun({ slug: 'alpha', root, model: 'opus' });
    state.status = 'parked';
    const record = phaseRecord(state, 3);
    record.status = 'waiting';
    record.waits = 2;
    record.parkedUntil = '2026-08-29T12:00:00.000Z';
    record.declared = { status: 'waiting-external', reason: 'the image build', watch: ['gh:o/r#run/1'], at: '2026-08-29T00:00:00.000Z' };
    saveRun(state);
    // No sink passed: the run's own journal takes the line (a read path's shape).
    const result = reconcileRecordsAgainstBoard(state, { 3: 'done' });
    assert.deepEqual(result, { changed: true, closed: [3] });
    assert.equal(record.status, 'done');
    assert.equal(record.declared, undefined);
    const lines = readFileSync(journalFile(root, 'alpha', state.id), 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; phase?: number; data: Record<string, unknown> });
    const spent = lines.filter((l) => l.event === DECLARATION_CONSUMED_EVENT);
    assert.equal(spent.length, 1, 'exactly one line');
    assert.equal(spent[0].phase, 3);
    assert.equal(spent[0].data.why, 'board-closed');
    assert.equal(spent[0].data.status, 'waiting-external');
    assert.equal(spent[0].data.waits, 2);
    assert.equal(typeof spent[0].data.parkedMs, 'number');
    assert.equal(typeof spent[0].data.spentAt, 'string');
    assert.deepEqual(spent[0].data.watch, ['gh:o/r#run/1']);
    // A second reconcile spends nothing and writes nothing.
    reconcileRecordsAgainstBoard(state, { 3: 'done' });
    const again = readFileSync(journalFile(root, 'alpha', state.id), 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(again.length, lines.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  // …and a live runner's sink takes it instead — never a second Journal over one file.
  const live = newRun({ slug: 'alpha', root: '/tmp/x' });
  live.status = 'parked';
  const rec = phaseRecord(live, 1);
  rec.status = 'parked';
  rec.declared = { status: 'needs-human', reason: 'the token', at: '2026-08-29T00:00:00.000Z' };
  const seen: { event: string; data: Record<string, unknown>; phase?: number }[] = [];
  reconcileRecordsAgainstBoard(live, { 1: 'done' }, undefined, (event, data, phase) => { seen.push({ event, data, phase }); });
  assert.deepEqual(seen.map((l) => [l.event, l.data.why, l.phase]), [[DECLARATION_CONSUMED_EVENT, 'board-closed', 1]]);
});

test('WAI-9: retry journals exactly one phase.declaration-consumed, naming who asked', () => {
  const record: PhaseRecord = phaseRecord(newRun({ slug: 'alpha', root: '/tmp/x' }), 2);
  record.status = 'parked';
  record.waits = 1;
  record.declared = { status: 'blocked', reason: 'a foreign lock', watch: ['lock:beta/3'], at: '2026-08-29T00:00:00.000Z' };
  const seen: { event: string; data: Record<string, unknown>; phase?: number }[] = [];
  const spent = resetForRetry(record, { by: 'operator', journal: (event, data, phase) => { seen.push({ event, data, phase }); } });
  assert.ok(spent);
  assert.equal(spent.why, 'retry');
  assert.equal(seen.length, 1, 'exactly one line');
  assert.equal(seen[0].event, DECLARATION_CONSUMED_EVENT);
  assert.equal(seen[0].phase, 2);
  assert.equal(seen[0].data.why, 'retry');
  assert.equal(seen[0].data.by, 'operator');
  assert.equal(seen[0].data.status, 'blocked');
  assert.equal(record.declared, undefined);
  // Nothing to spend: nothing journalled, and the reset still happens.
  record.status = 'failed';
  assert.equal(resetForRetry(record, { by: 'console', journal: (event, data, phase) => { seen.push({ event, data, phase }); } }), null);
  assert.equal(seen.length, 1);
  assert.equal(record.status, 'pending');
});

/* ------------------------------------------------------------------ *
 * 5. A declared blocker outranks a plan-health claim
 * ------------------------------------------------------------------ */

const EVIDENCE: PhaseEvidence = {
  slug: 'alpha', phase: 12, board: 'stuck',
  handoff: {
    exists: true, status: 'blocked',
    outstanding: 'The deploy box is unreachable — every ssh times out. Nothing here can proceed.',
  },
  record: { status: 'failed', attempts: 1, note: null },
  run: { status: 'halted', halt: null, waitUntil: null, resolved: false },
  lock: null, declared: null, gate: null, mcp: null, registry: null, auth: null,
  qa: { mode: 'off' },
  work: { did: true, why: 'commits exist', dirty: 0, commits: 3 },
  health: [{
    severity: 'error', kind: 'stale-handoff', phase: 12,
    detail: 'Phase 12 handoff is blocked, untouched 2d',
  }] as never,
  at: '2026-08-30T00:00:00.000Z',
};

test('a blocked handoff with a stale-handoff health error is blocked-declared, never plan-broken', () => {
  const got = classifySituation(EVIDENCE);
  assert.equal(got.id, 'blocked-declared', `classified ${got.key} instead`);
  assert.ok(got.why.some((w) => /Outstanding/.test(w)), 'the blocker statement is the evidence');
});

test('blocked-declared precedes plan-broken in the vocabulary', () => {
  assert.ok(SITUATIONS.indexOf('blocked-declared') < SITUATIONS.indexOf('plan-broken'),
    'the list is precedence order and testimony outranks a health claim');
});

test('the plan-broken errand quotes the issue instead of prescribing validate.sh', () => {
  const errand = errandFor('plan-broken:stale-handoff', [], 12, '2026-08-30T00:00:00.000Z', null, {
    kind: 'stale-handoff', detail: 'Phase 12 handoff is blocked, untouched 2d', validateOk: true,
  });
  assert.match(errand.need, /stale-handoff/);
  assert.match(errand.need, /untouched 2d/);
  assert.doesNotMatch(`${errand.need} ${errand.how}`, /passes validate\.sh/,
    'validate.sh was green for all 50 of these; prescribing it is why nobody could act on the card');
  assert.match(errand.how, /validate\.sh/, 'the verdict is still reported — as evidence, not as the ask');
});

/* ------------------------------------------------------------------ *
 * 6. Honest ladder accounting
 * ------------------------------------------------------------------ */

const rung = (situation: string, vehicle: string, outcome: RungRecord['outcome'], costUsd = 0): RungRecord =>
  ({ situation, rung: vehicle, at: '2026-08-30T00:00:00.000Z', outcome, costUsd });

test('interrupted rungs count toward no rung cap', () => {
  const history = [
    rung('verify-red', 'resume-own-session', 'interrupted'),
    rung('verify-red', 'fix-agent', 'interrupted'),
    rung('verify-red', 'closeout-agent', 'interrupted'),
  ];
  const next = nextRung({ situation: 'verify-red', history, caps: { perPhaseRungs: 3 } as never });
  assert.equal(next.ok, true, 'three consoles dying under a climb is not three remedies tried');
});

test('a rung that really ran still counts', () => {
  const history = [
    rung('verify-red', 'resume-own-session', 'failed'),
    rung('verify-red', 'fix-agent', 'failed'),
    rung('verify-red', 'closeout-agent', 'failed'),
  ];
  const next = nextRung({ situation: 'verify-red', history, caps: { perPhaseRungs: 3 } as never });
  assert.equal(next.ok, false);
});

test("an errand's tried lists this situation's rungs; earlier carries the rest", () => {
  const history = [
    rung('never-started', 'reboard-fresh', 'failed'),
    rung('verify-red', 'fix-agent', 'failed'),
  ];
  const errand = errandFor('verify-red', history, 4);
  assert.equal(errand.tried.length, 1, `tried was ${JSON.stringify(errand.tried)}`);
  assert.match(errand.tried[0], /fix-agent/);
  assert.equal(errand.earlier?.length, 1);
  assert.match(errand.earlier![0], /reboard-fresh/);
});

/* The board-overtake retire, on the READ path. `reconcileRecordsAgainstBoard`
 * is only half the story: for a run nothing is driving, the door is
 * `resolveRunsAgainst`, and it gated the record half on `RESOLVABLE`
 * (`halted`/`interrupted`). A phase-level ending leaves the run `parked` — that
 * is the whole point of the split — so the runs THIS PHASE creates were exactly
 * the ones the read path would not reconcile. Third door on the same wedge. */

test('the read path reconciles a PARKED run — the status a phase-level ending leaves', () => {
  const boards = new Map([['alpha', { 1: 'done' } as Record<number, string>]]);

  const parked = newRun({ slug: 'alpha', root: '/tmp/x' });
  parked.status = 'parked';
  const pr = phaseRecord(parked, 1);
  pr.status = 'failed';
  pr.attempts = 1;
  pr.halt = { at: '2026-08-30T10:00:00.000Z', reason: 'no handoff was written', phase: 1, kind: 'no-handoff' };

  // The same run in the status the read path DID cover, as the control.
  const halted = newRun({ slug: 'alpha', root: '/tmp/x' });
  halted.status = 'halted';
  const hr = phaseRecord(halted, 1);
  hr.status = 'failed';
  hr.attempts = 1;
  hr.halt = { at: '2026-08-30T10:00:00.000Z', reason: 'no handoff was written', phase: 1, kind: 'no-handoff' };

  resolveRunsAgainst([parked, halted], boards);

  assert.equal(hr.status, 'done', 'the control: a halted run was always reconciled');
  assert.equal(pr.status, 'done',
    'a parked run is what a phase-level ending produces — its overtaken records must close too, '
    + 'or every read shows a red failed chip over a board reading done');
  assert.equal(pr.halt, undefined, 'and the ending goes with it');
});

test('a run a person REOPENED is still left alone on the read path', () => {
  const boards = new Map([['alpha', { 1: 'done' } as Record<number, string>]]);
  const run = newRun({ slug: 'alpha', root: '/tmp/x' });
  run.status = 'parked';
  run.reopenedAt = '2026-08-30T11:00:00.000Z';
  const record = phaseRecord(run, 1);
  record.status = 'failed';
  record.halt = { at: '2026-08-30T10:00:00.000Z', reason: 'no handoff', phase: 1, kind: 'no-handoff' };

  resolveRunsAgainst([run], boards);

  assert.equal(record.status, 'failed', "a person's veto is never re-inferred away");
  assert.equal(record.halt?.kind, 'no-handoff');
});

test('the parked headline quotes the ending that happened LAST, not the highest phase number', () => {
  // Same defect as the one fixed in the `!candidates.length` branch, 180 lines
  // away in the same function: `Object.values(state.phases)` is integer-keyed,
  // so "the last one" is the biggest phase number, not the newest stop.
  const run = newRun({ slug: 'alpha', root: '/tmp/x' });
  const five = phaseRecord(run, 5);
  five.halt = { at: '2026-08-30T10:00:00.000Z', reason: 'no handoff was written', phase: 5, kind: 'no-handoff' };
  const two = phaseRecord(run, 2);
  two.halt = { at: '2026-08-30T12:00:00.000Z', reason: 'did not verify', phase: 2, kind: 'verify-failed' };

  assert.equal(latestEnding(Object.values(run.phases))?.phase, 2,
    'phase 2 settled two hours after phase 5; quoting phase 5 sends a person to the wrong page');
  // …and the two edges the drive loop hands it: a run with no ending at all
  // (the ordinary finish) must not throw, which an unseeded `reduce` does.
  assert.equal(latestEnding([]), null);
  assert.equal(latestEnding(Object.values(newRun({ slug: 'a', root: '/tmp/x' }).phases)), null);
});

/* Exit criterion 1's RECOVERY half, which every other cap test reaches through
 * BOARDING. `recover()` returns synchronously and stores its promise on the
 * runner, so anything `runRecovery` throws past its own handlers is an
 * unhandled rejection node reports on stderr and the console never hears — the
 * measured shape (R7) being the lock-wait cap, which is why `AdmissionCapped`
 * had to become an `AdmissionAborted`. Spied exactly as the criterion words it. */

test('criterion 1: a recovery whose admission caps is a settled fact, not an unhandled rejection', async () => {
  const { Runner } = await import('../server/runner/runner.ts');
  const { Scheduler } = await import('../server/runner/scheduler.ts');
  const h = boardHarness();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  // The blocker the admission caps on comes from the SCHEDULER's lock provider,
  // not from `phase-lock.sh`: a foreign lock on an overlapping scope, with no
  // `session` — so presence is unknown and `isCappableBlocker` says yes.
  const scheduler = new Scheduler({
    locks: () => [{
      slug: 'other-plan', phase: 9, owner: 'someone/else', expired: false,
      scope: [h.root], leaseUntil: Date.now() + 60 * 60_000,
    }],
  });
  try {
    const events: { event: string; phase?: number }[] = [];
    const journal: string[] = [];
    const runner = new Runner({
      scriptsDir: h.scriptsDir,
      spawn: async () => { throw new Error('a capped recovery must spawn nothing'); },
      verificationText: () => 'run those commands.',
      scheduler,
      onEvent: (event, data) => {
        events.push({ event, phase: (data as { phase?: number })?.phase });
        const inner = (data as { event?: string })?.event;
        if (event === 'run:journal' && inner) journal.push(inner);
      },
    });

    const state = newRun({ slug: 'demo', root: h.root, model: 'opus' });
    state.status = 'parked';
    const record = phaseRecord(state, 1);
    record.status = 'failed';
    record.attempts = 1;
    // Already three hours behind this lock; the cap is two, so the admission
    // caps rather than queueing.
    record.lockWaitSince = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    saveRun(state);

    await runner.recover({
      slug: 'demo', root: h.root, runId: state.id, phase: 1, mode: 'reboard', by: 'operator',
    });
    await runner.wait();
    // Let any rejection that escaped reach the handler before we look.
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(unhandled, [],
      'a capped recovery must be caught: AdmissionCapped extends AdmissionAborted so ONE catch covers both');
    const after = runner.current()!;
    // The cap is what fired — not some other recovery outcome that would make
    // this test green while proving nothing.
    assert.ok(journal.includes('phase.lock-wait-capped'),
      `the admission capped and said so — journal was ${JSON.stringify(journal)}`);
    assert.equal(after.phases['1'].status, 'parked', 'a capped wait parks the phase');
    assert.match(after.phases['1'].note ?? '', /locked by someone\/else and has waited/);
    // …and the recovery that could not run is recorded as a settled fact — on
    // the PHASE, because `recovery-failed` is a phase-level kind. That is the
    // criterion-1 and criterion-3 halves meeting: the cap is caught rather than
    // escaping as a rejection, AND it does not stop the run.
    assert.equal(after.phases['1'].halt?.kind, 'recovery-failed');
    assert.equal(after.halt, null, 'a capped recovery must not halt the RUN');
    // The clock stops with the wait (R8): left standing, the NEXT admission
    // computes a negative remainder and fires its cap immediately.
    assert.equal(after.phases['1'].lockWaitSince, undefined);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    scheduler.close();
    h.cleanup();
  }
});

test('a needs-human ending that adjudicated NOTHING is still overtaken by the board', () => {
  // `needs-human` is the impure member of `ADJUDICATED_HALT_KINDS`: only the
  // rejected sign-off actually judges the work. The no-broker halt ("needs a
  // person to verify it, and there is no way to ask") and the credential wall
  // judge nothing, and are excluded from the hold only because they leave the
  // record `awaiting-verification`/`parked` rather than `failed`. Pinned so the
  // coupling is a decision, not an accident: a person who then finishes the
  // phase must be able to close it.
  const run = newRun({ slug: 'alpha', root: '/tmp/x' });
  const record = phaseRecord(run, 1);
  record.status = 'parked';
  record.halt = {
    at: '2026-08-30T10:00:00.000Z', phase: 1, kind: 'needs-human',
    reason: 'phase 1 needs a person to verify it, and there is no way to ask',
  };

  const { closed } = reconcileRecordsAgainstBoard(run, { 1: 'done' });

  assert.deepEqual(closed, [1], 'nobody judged this phase; the person who finished it decides');
  assert.equal(record.halt, undefined);
});

test('only the adjudicating needs-human writer may mark the record failed', () => {
  // The pin the prose alone could not give. `needs-human` sits in
  // `ADJUDICATED_HALT_KINDS`, which makes `reconcileRecordsAgainstBoard` refuse
  // to let the board overtake it — but ONLY for a record reading `failed`. Just
  // one of the three writers adjudicates anything (`Runner.askHuman`'s deny
  // arm: a person looked and said no); the no-broker halt and the credential
  // wall judge nothing and are excluded from the hold only because they leave
  // the record `awaiting-verification`/`parked`.
  //
  // A one-word edit to either — `record.status = 'failed'` — passes every
  // behavioural suite in the repo and silently pins a phase halted on an
  // expired login that a person then completes, for the life of the run. So the
  // coupling is asserted at the source, where the edit would be made.
  //
  // Structural rather than positional: each `this.halt(…, 'needs-human')` is
  // attributed the NEAREST preceding `record.status` assignment, and the walk
  // back stops at the previous `this.halt(` so one arm can never be charged
  // with another's. Moving code around therefore does not make this fail; only
  // changing what an arm actually writes does.
  const here = dirname(fileURLToPath(import.meta.url));
  const adjudicating: string[] = [];
  for (const file of ['server/runner/runner.ts', 'server/runner/runner-attempt.ts']) {
    const lines = readFileSync(join(here, '..', file), 'utf8').split('\n');
    const haltAt = lines.flatMap((line, i) => (/this\.halt\(/.test(line) ? [i] : []));
    haltAt.forEach((i, n) => {
      // The whole call, however it is wrapped, up to the next statement.
      const call = lines.slice(i, i + 8).join('\n').split(');')[0] ?? '';
      if (!call.includes("'needs-human'")) return;
      const floor = n === 0 ? 0 : haltAt[n - 1]! + 1;
      for (let j = i; j >= floor; j -= 1) {
        const status = /record\.status\s*=\s*'([a-z-]+)'/.exec(lines[j]!);
        if (!status) continue;
        if (status[1] === 'failed') adjudicating.push(`${file}:${j + 1}`);
        break;
      }
    });
  }
  assert.equal(adjudicating.length, 1,
    'exactly one needs-human writer may adjudicate (askHuman\'s deny arm). A new one that sets '
    + '`failed` must either genuinely judge the work, or the kind must be split — see '
    + `ADJUDICATED_HALT_KINDS. Found: ${JSON.stringify(adjudicating)}`);
  assert.match(adjudicating[0]!, /runner\.ts:/,
    'the adjudicating writer is askHuman\'s deny arm in runner.ts');
});


test('the board does not close a phase whose FROZEN child is still on the machine', () => {
  // The regression the widened read-path gate introduced, and the reason the
  // guard asks the PROCESS rather than the status. `Runner.adopt` writes a
  // frozen orphan's record `interrupted` — which IS in `RECONCILABLE` — while
  // the run parks with the halt naming its pid and the `kill -CONT` that
  // recovers it. Closing that record would overwrite the note and dissolve the
  // one instruction an operator has.
  const run = newRun({ slug: 'alpha', root: '/tmp/x' });
  const record = phaseRecord(run, 1);
  record.status = 'interrupted';
  record.note = 'frozen by the operator (pid 4242) and left behind by the console that stopped it';
  // `process.pid` is this test's own process: alive, so `pidHoldsWork` is true.
  run.children = { '1': { phase: 1, pid: process.pid, startedAt: '2026-08-30T10:00:00.000Z' } as never };

  const { closed } = reconcileRecordsAgainstBoard(run, { 1: 'done' });

  assert.deepEqual(closed, [], 'a process is a fact; the board is reading a handoff that cannot know');
  assert.equal(record.status, 'interrupted');
  assert.match(record.note ?? '', /frozen by the operator/, 'the recovery instruction survives');

  // …and once the process is gone, the board closes it exactly as before.
  //
  // `2 ** 31 - 1` is above `pid_max` on both release-gate platforms, so it
  // cannot exist anywhere. A small number is NOT interchangeable here: pid 2 is
  // nothing on macOS but `kthreadd` on Linux, and `pid.ts`'s `exists()` counts
  // `EPERM` as existing — so a root-owned low pid reads as HOLDING WORK on the
  // ubuntu leg of CI (a release gate) while every local run stays green.
  const GONE = 2 ** 31 - 1;
  run.children = { '1': { phase: 1, pid: GONE, startedAt: '2026-08-30T10:00:00.000Z' } as never };
  const after = reconcileRecordsAgainstBoard(run, { 1: 'done' });
  assert.deepEqual(after.closed, [1], 'no surviving child, so the board overtakes it');
  assert.equal(record.status, 'done');
});

/* ------------------------------------------------------------------ *
 * 3b. The kind reaches disk — and legacy files answer with one (LFC-1)
 * ------------------------------------------------------------------ */

/**
 * Of the hub's 53 run files, four carried a `halt` and none carried a `kind`
 * — all four from the drive loop's park, whose kind was conditional on three
 * predicates and `{}` otherwise. The fixture holds two of them, verbatim. A
 * reader that keys on the kind (`classifyRun`, `situationOfHalt`) must get one
 * from every file the loader accepts, so `settle()` names a legacy halt from
 * its sentence (`healLegacyHalt`) and this walks every fixture run through the
 * real loader to prove it.
 */
test('no run file under the journal fixture produces a halt without a kind from HALT_KINDS', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-fixture-runs-'));
  try {
    const runs = fixtureRuns();
    assert.ok(runs.length >= 9, `the fixture holds ${runs.length} run files; expected the six plans' nine`);
    let legacy = 0;
    for (const { slug, runId, state } of runs) {
      const halt = state.halt as { kind?: string } | null | undefined;
      if (halt && !halt.kind) legacy++;
      const target = runFile(root, slug, runId);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(state));
      const loaded = loadRun(root, slug, runId);
      assert.ok(loaded, `${slug}/${runId} did not load`);
      if (!loaded.halt) continue;
      assert.ok((HALT_KINDS as readonly string[]).includes(loaded.halt.kind as string),
        `${slug}/${runId}: loaded with halt.kind ${JSON.stringify(loaded.halt.kind)} — reason "${loaded.halt.reason.slice(0, 60)}"`);
    }
    // The fixture is the evidence: at least the two kindless parks the audit
    // counted are still in it raw, and the loader healed them above.
    assert.ok(legacy >= 2, `the fixture no longer holds the raw kindless halts (found ${legacy}) — was it rebuilt from a healed corpus?`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no phase.waiting payload lacks `requested` — every park says what was asked beside what was granted (WAI-1)', () => {
  // The clamp recorded only the instant it granted, so a window cut from 48 h to
  // eight was indistinguishable from one asked for eight. Every writer of the
  // event, in both twins, now carries the ask, the grant and whether it was capped.
  const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'server');
  const files = ['runner/runner-attempt.ts', 'service-runs.ts'];
  let writers = 0;
  for (const rel of files) {
    const lines = readFileSync(join(serverDir, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/(?:record|append)\('phase\.waiting', \{/.test(line)) return;
      writers += 1;
      const payload = lines.slice(i, i + 14).join('\n');
      const end = payload.indexOf('}, phase)');
      const body = end >= 0 ? payload.slice(0, end) : payload;
      for (const key of ['requested:', 'granted:', 'capped:', 'budgetRemainingMs:', 'by']) {
        assert.ok(body.includes(key), `${rel}:${i + 1} writes phase.waiting without \`${key.replace(':', '')}\``);
      }
    });
  }
  assert.equal(writers, 2, 'the two parks — the runner\'s and the unsupervised twin');
});
