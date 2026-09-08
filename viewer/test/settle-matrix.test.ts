/**
 * The record that says a phase is running, over a run that stopped hours ago.
 *
 * `reconcileRun` has always settled phase records — but only after two early
 * returns, and the second is `if (!IN_FLIGHT.includes(state.status)) return`.
 * So the loop was reachable for a run reading `running` and unreachable for one
 * reading `parked`, `halted` or `interrupted`: exactly the statuses a console
 * that died leaves behind. Nothing else closed those records either
 * (`RECONCILABLE` excludes the in-flight statuses, `adopt` needs a non-empty
 * `childrenOf`, `reconcileRecordsAgainstBoard` needs the board to read `done`),
 * so the incident's phase 9 read `running` for three and a half hours over a
 * run that had already parked, and the healer read that record back as evidence
 * that work was in progress and refused to recover it — twice.
 *
 * The claim being wrong is not the interesting part. The interesting part is
 * that it was settled against `state.status`, which is another claim by the
 * same dead writer, instead of against the one thing that cannot be faked: is
 * there a process. So this file is a MATRIX, not a case list — every run status
 * crossed with every in-flight phase status crossed with every answer the probe
 * can give — and it asserts one rule over all of them:
 *
 *     a record claiming work in flight, with its process `gone`, settles.
 *     Anything else about the run is irrelevant to that.
 *
 * The other direction is asserted just as hard, because it is the one that
 * costs a working session: a `running` or `stopped` child is still there, and
 * for `stopped` it is recoverable with one `kill -CONT` — which is the remedy
 * `reconcileRun`'s orphan branch prints on the same screen. A settle that
 * contradicted that advice would be a second lie, not a fix.
 *
 * **`zombie` changed sides in P7 (B2), deliberately.** It sat with `stopped`
 * because the filter asked `processState(...) !== 'gone'` — a question about
 * EXISTENCE — and the rationale written here only ever covered `stopped`. A
 * `Z` process has exited: no file descriptors, no cwd, no next instruction,
 * only its parent's `wait()` outstanding. `orphanAdvice` would tell the
 * operator to "let it finish or stop it" about a process that had already
 * finished, and the phase went on reading `running` with nothing behind it —
 * which is the whole of B2(a). The rule the matrix asserts is now:
 *
 *     a record claiming work in flight, whose process does not HOLD WORK,
 *     settles. `gone` and `zombie` hold none; `running` and `stopped` do.
 *     Anything else about the run is irrelevant to that.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  settleInFlightRecords, reconcileRun, newRun, phaseRecord, saveRun, loadRun,
  IN_FLIGHT, PHASE_IN_FLIGHT, SETTLED,
  type RunState, type RunStatus, type PhaseStatus,
} from '../server/runner/state.ts';
import { setPsReader, forgetPid, type ProcessState } from '../server/pid.ts';

/** Every status a run can hold — the matrix's first axis, from the type. */
const RUN_STATUSES: readonly RunStatus[] = [
  'running', 'pausing', 'paused', 'waiting', 'frozen', 'parked', 'halted',
  'halting', 'finished', 'stopping', 'queued', 'interrupted',
];

/** A pid that is certainly not running. 0 and 1 are both real, so pick high. */
const DEAD_PID = 0x7ffffffe;

function scratchRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-settle-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Make the probe answer `state` for THIS process's pid.
 *
 * `process.pid` and not an invented one: `processState` asks `kill(pid, 0)`
 * BEFORE it consults the `setPsReader` seam, so a stub written for a pid nobody
 * has proves nothing — it returns `gone` on the existence check and never
 * reaches the reader. (That trap cost phase 3 a wrong turn; it is written down
 * here so it costs the next reader nothing.) `gone` is the one answer that
 * cannot be stubbed this way, so it uses a really-dead pid instead.
 */
function withProbe(answer: ProcessState): { pid: number; restore: () => void } {
  if (answer === 'gone') {
    const previous = setPsReader(null);
    return { pid: DEAD_PID, restore: () => { setPsReader(previous); forgetPid(); } };
  }
  const stat = answer === 'stopped' ? 'T' : answer === 'zombie' ? 'Z' : 'S';
  const previous = setPsReader(() => ({ stat, comm: 'claude', lstart: '' }));
  return { pid: process.pid, restore: () => { setPsReader(previous); forgetPid(); } };
}

/**
 * A run in `status` whose phase 12 record claims `record` and whose recorded
 * child is `pid`. No `procStartedAt`: identity is phase 3's concern, and adding
 * it here would make every cell fail its start-time check for the wrong reason.
 */
function runWith(
  root: string, status: RunStatus, record: PhaseStatus, pid: number,
): RunState {
  const state = newRun({ slug: 'demo', root, model: 'opus' });
  state.status = status;
  state.activePhase = 12;
  state.child = { pid, phase: 12, sessionId: 'sess-12', startedAt: new Date().toISOString() };
  state.children = { 12: state.child };
  const held = phaseRecord(state, 12);
  held.status = record;
  // On the RECORD, not only on the child: `resumeSessionId` is copied from
  // `record.sessionId`, and a fixture that set it only on the ChildRef would
  // assert a continuable phase into existence that the code never produced.
  held.sessionId = 'sess-12';
  return state;
}

/* ------------------------------------------------------------------ *
 * The matrix
 * ------------------------------------------------------------------ */

test('the settle matrix leaves no in-flight record standing over a gone process', () => {
  const dir = scratchRoot();
  try {
    let cells = 0;
    for (const answer of ['running', 'stopped', 'zombie', 'gone'] as const) {
      const probe = withProbe(answer);
      try {
        for (const runStatus of RUN_STATUSES) {
          for (const recordStatus of PHASE_IN_FLIGHT) {
            cells++;
            const state = runWith(dir.root, runStatus, recordStatus, probe.pid);
            settleInFlightRecords(state);
            const now = state.phases['12'].status;
            // `gone` and `zombie` hold no work; `running` and `stopped` do.
            if (answer === 'gone' || answer === 'zombie') {
              assert.equal(now, 'interrupted',
                `run ${runStatus} / record ${recordStatus} / probe ${answer} must settle — `
                + 'it holds no work');
            } else {
              assert.equal(now, recordStatus,
                `run ${runStatus} / record ${recordStatus} / probe ${answer} must be left alone`);
            }
          }
        }
      } finally { probe.restore(); }
    }
    // 4 probe answers × 12 run statuses × 3 in-flight record statuses. Asserted
    // rather than commented, so adding a status without adding it here fails.
    assert.equal(cells, 4 * RUN_STATUSES.length * PHASE_IN_FLIGHT.length);
    assert.equal(cells, 144);
  } finally { dir.cleanup(); }
});

test('the run-status axis is the whole vocabulary, and IN_FLIGHT is a subset of it', () => {
  // A status added to the type but not to the matrix would silently stop being
  // tested — the same failure `reconcile.test.ts` guards for `IN_FLIGHT`.
  for (const status of IN_FLIGHT) {
    assert.ok(RUN_STATUSES.includes(status), `${status} is missing from the matrix axis`);
  }
  assert.equal(new Set(RUN_STATUSES).size, RUN_STATUSES.length, 'no duplicates');
});

test('a settled record is never re-settled, whatever the probe says', () => {
  const dir = scratchRoot();
  try {
    const probe = withProbe('gone');
    try {
      for (const status of SETTLED) {
        const state = runWith(dir.root, 'parked', status, probe.pid);
        assert.deepEqual(settleInFlightRecords(state), [],
          `${status} is settled and must not be rewritten`);
        assert.equal(state.phases['12'].status, status);
      }
    } finally { probe.restore(); }
  } finally { dir.cleanup(); }
});

test('the probe is asked per phase, so a surviving lane does not shelter a dead one', () => {
  const dir = scratchRoot();
  try {
    // Phase 9's child is this process — alive. Phase 10 and 11's are dead. The
    // incident's exact shape: one orphan holding a run open while the other
    // lanes' records went on claiming to run for as long as it did.
    const probe = withProbe('running');
    try {
      const state = runWith(dir.root, 'parked', 'running', DEAD_PID);
      // The fixture's own phase 12 is not part of this case — it holds no lane
      // below, so it would settle too and drown out the point being made.
      phaseRecord(state, 12).status = 'pending';
      state.children = {
        9: { pid: probe.pid, phase: 9, sessionId: 's9', startedAt: new Date().toISOString() },
        10: { pid: DEAD_PID, phase: 10, sessionId: 's10', startedAt: new Date().toISOString() },
        11: { pid: DEAD_PID, phase: 11, sessionId: 's11', startedAt: new Date().toISOString() },
      };
      state.child = state.children[9];
      for (const phase of [9, 10, 11]) phaseRecord(state, phase).status = 'running';

      const closed = settleInFlightRecords(state);
      assert.deepEqual(closed.sort((a, b) => a - b), [10, 11]);
      assert.equal(state.phases['9'].status, 'running', 'the live lane is untouched');
      assert.equal(state.phases['10'].status, 'interrupted');
      assert.equal(state.phases['11'].status, 'interrupted');
    } finally { probe.restore(); }
  } finally { dir.cleanup(); }
});

test('a settled record keeps the session that can continue it', () => {
  const dir = scratchRoot();
  try {
    const probe = withProbe('gone');
    try {
      const state = runWith(dir.root, 'halted', 'running', probe.pid);
      phaseRecord(state, 12).sessionId = 'sess-12';
      settleInFlightRecords(state, '2026-08-23T10:00:00.000Z');
      const record = state.phases['12'];
      // An interrupted phase may be twenty minutes of work from done. Losing
      // the session id is the difference between offering to CONTINUE it and
      // offering only to start it over.
      assert.equal(record.resumeSessionId, 'sess-12');
      assert.equal(record.endedAt, '2026-08-23T10:00:00.000Z');
      assert.match(record.note ?? '', /the console stopped while phase 12 was running/);
    } finally { probe.restore(); }
  } finally { dir.cleanup(); }
});

test('a note and an end time already recorded are never overwritten', () => {
  const dir = scratchRoot();
  try {
    const probe = withProbe('gone');
    try {
      const state = runWith(dir.root, 'halted', 'running', probe.pid);
      const record = phaseRecord(state, 12);
      record.note = 'the session said why, and that is better than our reconstruction';
      record.endedAt = '2026-08-01T00:00:00.000Z';
      record.resumeSessionId = 'sess-original';
      settleInFlightRecords(state);
      assert.equal(record.note, 'the session said why, and that is better than our reconstruction');
      assert.equal(record.endedAt, '2026-08-01T00:00:00.000Z');
      assert.equal(record.resumeSessionId, 'sess-original');
      assert.equal(record.status, 'interrupted', 'the status is still corrected');
    } finally { probe.restore(); }
  } finally { dir.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The read path — the cell that produced the incident
 * ------------------------------------------------------------------ */

test('a parked run stops claiming a phase is running the moment it is read back', () => {
  const dir = scratchRoot();
  try {
    const probe = withProbe('gone');
    try {
      // Verbatim the incident: the run parked (so `reconcileRun` returns at its
      // IN_FLIGHT guard and its record loop never runs), the child is long
      // dead, and the record still says `running`. Before this phase, loading
      // this file back gave you the claim, unchanged, for ever.
      const state = runWith(dir.root, 'parked', 'running', probe.pid);
      saveRun(state);

      const loaded = loadRun(dir.root, 'demo', state.id, null);
      assert.ok(loaded);
      assert.equal(loaded.status, 'parked', 'the run itself is left exactly as it was');
      assert.equal(loaded.phases['12'].status, 'interrupted');
      assert.equal(loaded.phases['12'].resumeSessionId, 'sess-12');

      // And it STICKS — the correction is written back, not recomputed on every
      // read by every surface that happens to load the file.
      const again = loadRun(dir.root, 'demo', state.id, null);
      assert.equal(again?.phases['12'].status, 'interrupted');
    } finally { probe.restore(); }
  } finally { dir.cleanup(); }
});

test('the run something is actually driving keeps every record it holds', () => {
  const dir = scratchRoot();
  try {
    const probe = withProbe('gone');
    try {
      // The one exemption. A live loop owns its records: it is mid-spawn, or
      // between the fork and the first `children` write, and a read that
      // settled them would be racing the writer rather than correcting it.
      const state = runWith(dir.root, 'running', 'running', probe.pid);
      saveRun(state);
      const loaded = loadRun(dir.root, 'demo', state.id, state.id);
      assert.equal(loaded?.phases['12'].status, 'running');
      assert.equal(loaded?.status, 'running');

      // Including when the live set is a Set rather than an id.
      const viaSet = loadRun(dir.root, 'demo', state.id, new Set([state.id]));
      assert.equal(viaSet?.phases['12'].status, 'running');
    } finally { probe.restore(); }
  } finally { dir.cleanup(); }
});

test('reconcileRun still settles its own records, unchanged', () => {
  const dir = scratchRoot();
  try {
    const probe = withProbe('gone');
    try {
      // The extraction must be behaviour-identical where the loop already ran:
      // `reconcileRun` reaches it only with `alive` empty, so every per-phase
      // probe answers `gone` too and the same set settles.
      const state = runWith(dir.root, 'running', 'running', probe.pid);
      phaseRecord(state, 7).status = 'verifying';
      assert.equal(reconcileRun(state, null), true);
      assert.equal(state.status, 'interrupted');
      assert.equal(state.phases['12'].status, 'interrupted');
      assert.equal(state.phases['7'].status, 'interrupted');
    } finally { probe.restore(); }
  } finally { dir.cleanup(); }
});

test('a frozen orphan keeps its record, so the kill -CONT advice stays true', () => {
  const dir = scratchRoot();
  try {
    const probe = withProbe('stopped');
    try {
      // `reconcileRun` parks this run and tells the operator to `kill -CONT` the
      // pid. A record rewritten to `interrupted` underneath that advice would
      // contradict it on the same screen — so the two paths share one rule.
      const state = runWith(dir.root, 'running', 'running', probe.pid);
      saveRun(state);
      const loaded = loadRun(dir.root, 'demo', state.id, null);
      assert.equal(loaded?.status, 'parked');
      assert.match(loaded?.halt?.reason ?? '', /kill -CONT/);
      assert.equal(loaded?.phases['12'].status, 'running',
        'the phase is frozen, not interrupted — something is still there to continue');
    } finally { probe.restore(); }
  } finally { dir.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * A phase nothing ever ran is not a phase that failed
 * ------------------------------------------------------------------ */

/**
 * The board reads phase 1 done only once a handoff file exists — the same rule
 * `phase-graph.sh` really applies, so "the board still reads ready" means
 * "nobody wrote the handoff".
 */
function boardHarness(): { root: string; scriptsDir: string; handoff: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-settle-board-'));
  const scriptsDir = join(root, 'scripts');
  const handoff = join(root, 'handoff-1');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(scriptsDir, 'phase-graph.sh'), `#!/bin/bash
case "$2" in
  --memory-block)
    if [ -f "${handoff}" ]; then echo "ready: "; echo "done: 1"; echo "phase 1: done";
    else echo "ready: 1"; echo "done: "; echo "phase 1: ready"; fi ;;
  --gate-status)  echo "clear (no gate)" ;;
  --boot-prompt)  echo "do phase 1" ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });
  return { root, scriptsDir, handoff, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a recheck on a phase nothing ever ran writes interrupted and charges no streak', async () => {
  const { Runner } = await import('../server/runner/runner.ts');
  const h = boardHarness();
  try {
    let spawned = 0;
    const runner = new Runner({
      scriptsDir: h.scriptsDir,
      spawn: async () => { spawned++; throw new Error('a recheck must spawn nothing'); },
      verify: async () => ({ ok: true, reason: 'green', notRun: [], ran: [] }),
      verificationText: () => 'run those commands.',
      origin: 'http://127.0.0.1:4123',
    });

    // A record for a phase this console never boarded: `attempts: 0`, no
    // session. `recheck` reaches `closed()`'s fall-through — `closeout()`
    // declines ("there is no session left to resume") — and that fall-through
    // used to write `failed` and increment the streak, blaming a session that
    // never existed. `failed` and `interrupted` are BOTH in SETTLED, so the
    // status alone is not the harm: the streak is, because two rechecks on two
    // never-boarded phases halt the whole run on `failure-streak` for failures
    // nothing ever performed.
    const state = newRun({ slug: 'demo', root: h.root, model: 'opus' });
    state.status = 'parked';
    state.phases['1'] = { phase: 1, status: 'pending', attempts: 0, costUsd: 0 };
    state.consecutiveFailures = 0;
    saveRun(state);

    const after = await runner.recover({
      slug: 'demo', root: h.root, runId: state.id, phase: 1, mode: 'recheck', by: 'operator',
    });
    await runner.wait();

    assert.equal(spawned, 0, 'a recheck spawns nothing');
    assert.equal(after.phases['1'].status, 'interrupted',
      'nothing ran, so nothing failed — `failed` blames a session that never existed');
    assert.equal(after.consecutiveFailures, 0, 'and the streak is not charged for it');
    // On the PHASE's halt since the halt-kind split: `no-handoff` settles the
    // phase and leaves the run free to drive its other candidates.
    assert.match(after.phases['1'].halt?.reason ?? '', /nothing has been run for phase 1/);
  } finally { h.cleanup(); }
});

test('a recheck on a phase that DID run still fails, and still charges the streak', async () => {
  const { Runner } = await import('../server/runner/runner.ts');
  const h = boardHarness();
  try {
    const runner = new Runner({
      scriptsDir: h.scriptsDir,
      spawn: async () => ({
        signal: { subtype: 'success' as const, code: 0, text: 'done' },
        sessionId: 'sid-1', costUsd: 0, turns: 1, resultText: '', durationMs: 1, argv: [],
      }),
      verify: async () => ({ ok: true, reason: 'green', notRun: [], ran: [] }),
      verificationText: () => 'run those commands.',
      origin: 'http://127.0.0.1:4123',
    });

    // The other side of the same branch: a phase that really did board, really
    // did end without a handoff, and must still be reported as the failure it
    // is. A fix that made every fall-through `interrupted` would delete the
    // failure-streak halt entirely.
    const state = newRun({ slug: 'demo', root: h.root, model: 'opus' });
    state.status = 'parked';
    state.phases['1'] = {
      phase: 1, status: 'interrupted', attempts: 1, costUsd: 2, sessionId: 'sess-1',
      closeout: { at: '2026-08-01T00:00:00.000Z', ran: true },
    } as never;
    state.consecutiveFailures = 0;
    saveRun(state);

    const after = await runner.recover({
      slug: 'demo', root: h.root, runId: state.id, phase: 1, mode: 'recheck', by: 'operator',
    });
    await runner.wait();

    assert.equal(after.phases['1'].status, 'failed');
    assert.equal(after.consecutiveFailures, 1);
    assert.match(after.phases['1'].halt?.reason ?? '', /the session for phase 1 ended cleanly/);
  } finally { h.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The QA-round marker on a done record dies with the child that ran it
 * ------------------------------------------------------------------ */

test('a done record\'s QA-round marker is cleared on read when no child holds work, and kept while one does', () => {
  // `qaSession` says a review is in flight on a phase the board reads done.
  // A console that crashes mid-round leaves the marker behind, and a `done`
  // record is outside `PHASE_IN_FLIGHT` — so the same read-path settle that
  // closes a stale `running` record has to answer for this one too, or the
  // client tabs a phantom "QA round" pane for ever.
  const dir = scratchRoot();
  const gone = withProbe('gone');
  try {
    const state = runWith(dir.root, 'parked', 'done', gone.pid);
    state.phases['12'].qaSession = { round: 2, report: 'reports/phase-12-qa-round2.md', startedAt: new Date().toISOString() };
    settleInFlightRecords(state);
    assert.equal(state.phases['12'].status, 'done', 'the phase itself is finished work and stays so');
    assert.equal(state.phases['12'].qaSession, undefined, 'the marker does not outlive the process');
  } finally { gone.restore(); }
  const live = withProbe('running');
  try {
    const state = runWith(dir.root, 'running', 'done', live.pid);
    state.phases['12'].qaSession = { round: 1, report: 'reports/phase-12-qa.md', startedAt: new Date().toISOString() };
    settleInFlightRecords(state);
    assert.equal(state.phases['12'].qaSession?.round, 1, 'a review whose process is alive is still a review');
  } finally { live.restore(); dir.cleanup(); }
});
