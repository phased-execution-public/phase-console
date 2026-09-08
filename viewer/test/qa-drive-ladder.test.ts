/**
 * The drive loop's half of "a QA verdict is not a dead end".
 *
 * `auto-recovery.test.ts` pins the HEALER's half: `classifyOpenPhases` admits a
 * phase the board reads `done` whose recorded verdict still holds its
 * dependents, because `qa-failed` and `qa-pending` have rungs and the phase
 * holding the plan is one the ladder can genuinely act on. That change landed
 * on the service and stopped there.
 *
 * The drive loop kept the old guard. `climbLadder` skipped every phase the
 * board read `done` — and a QA situation is DEFINED by the board reading done,
 * because the phase finished and only then did the verdict come back. So the
 * two rungs were unreachable from the loop, and the only path to them was the
 * long way round: no candidate left, so the loop halts the run
 * `plan-deadlocked`, and the convergence pass picks the stopped run up on a
 * later tick.
 *
 * Measured on `phase-console-commerce`: a round-1 `fail` on phase 8 stopped the
 * run under "nothing left to run on its own", the operator read the halt as a
 * summons and intervened by hand — on a phase the loop had the board for and
 * could have re-boarded in the same pass.
 *
 * Four properties, because the guard still has a job for every OTHER done phase.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PHASE_CONSOLE_LOG = '';

const { Runner } = await import('../server/runner/runner.ts');
const { newRun, phaseRecord } = await import('../server/runner/state.ts');
type RunState = ReturnType<typeof newRun>;

/**
 * A runner with a state installed, no loop and no vehicles.
 *
 * `climbLadder` and `climb` are both `protected` — a subclass may reach them
 * and a stranger may not — so the seam is here: the pass runs for real and
 * `climb` records which phases it was handed instead of boarding anything.
 */
class Probe extends Runner {
  climbed: number[] = [];

  install(state: RunState): void {
    (this as unknown as { state: RunState }).state = state;
  }

  async pass(board: unknown): Promise<void> {
    await (this as unknown as {
      climbLadder(board: unknown, asked: Set<number> | null): Promise<void>;
    }).climbLadder(board, null);
  }

  protected override async climb(record: { phase: number }): Promise<boolean> {
    this.climbed.push(record.phase);
    return true;
  }
}

/** One phase done, two waiting on it, and the verdict that decides. */
function board(qa: Record<number, string>) {
  return {
    phased: true,
    states: { 1: 'done', 2: 'waiting', 3: 'waiting' },
    done: [1],
    inProgress: [],
    stuck: [],
    ready: [],
    waiting: [2, 3],
    blockedBy: { 2: [1], 3: [1] },
    qa,
  };
}

function wedged(recordStatus = 'done'): { probe: Probe; state: RunState } {
  const state = newRun({ slug: 'alpha', root: '/repo', autoRecover: true });
  const record = phaseRecord(state, 1);
  record.status = recordStatus as typeof record.status;
  record.note = 'closed outside this run (the board reads done)';
  record.sessionId = 'sess-p1';
  const probe = new Probe({ scriptsDir: '/nonexistent', verificationText: () => undefined } as never);
  probe.install(state);
  return { probe, state };
}

test('the drive loop climbs a done phase whose QA verdict holds the plan', async () => {
  const { probe } = wedged();
  await probe.pass(board({ 1: 'fail' }));
  assert.deepEqual(probe.climbed, [1], 'the phase holding the plan is reachable from the loop');
});

test('a pending verdict holds dependents as hard as a fail, and climbs the same way', async () => {
  const { probe } = wedged();
  await probe.pass(board({ 1: 'pending' }));
  assert.deepEqual(probe.climbed, [1]);
});

test('a genuinely settled done phase is still not climbed', async () => {
  // The guard's whole purpose. A phase the board reads done with a clean
  // verdict is finished work, and diagnosing it would cost a classify per pass,
  // for ever, on every plan. `waived` counts as clean — it is a verdict.
  for (const qa of [{ 1: 'pass' }, { 1: 'waived' }, {}]) {
    const { probe } = wedged();
    await probe.pass(board(qa));
    assert.deepEqual(probe.climbed, [], `nothing to climb for ${JSON.stringify(qa)}`);
  }
});

test('a QA holder whose own session is still in flight is left alone', async () => {
  // Not stalled: the lane is finishing, or `maybeQaVerdict` is chasing the
  // verdict warm inside it. Climbing over that would put a second session on
  // the phase lock the first one holds.
  for (const status of ['running', 'verifying']) {
    const { probe } = wedged(status);
    await probe.pass(board({ 1: 'fail' }));
    assert.deepEqual(probe.climbed, [], `a ${status} record is not a candidate`);
  }
});

test('the same unchanged verdict climbs once, and a changed one climbs again', async () => {
  // `ladderSeen` is what stops a hot loop, and the verdict had to join its
  // fingerprint: every other field is stable across a QA round, so a fail that
  // came back fail would otherwise read as "the same unchanged record" for the
  // life of the process.
  const { probe } = wedged();
  await probe.pass(board({ 1: 'fail' }));
  await probe.pass(board({ 1: 'fail' }));
  assert.deepEqual(probe.climbed, [1], 'the second pass adds nothing');

  await probe.pass(board({ 1: 'pending' }));
  assert.deepEqual(probe.climbed, [1, 1], 'a verdict that moved is new information');
});
