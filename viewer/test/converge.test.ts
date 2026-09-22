/**
 * The convergence loop — converge, classify, climb, with nobody looking.
 *
 * Three layers, each pinned on its own:
 *
 *  - the PLANNER (`planConvergence`), pure over fixtures: the specimens (a
 *    parked run over an interrupted never-started record; a console restart's
 *    killed lanes; a shutdown between phases; an orphaned session), debris
 *    locks, the lock-cap re-arm, and every pin — the operator's stop, a
 *    resolved run, a live run, a run on its own clock, unchanged evidence;
 *  - the EXECUTOR (`executeConvergence`) with stub deps: what is journalled,
 *    what is written on the run, that the run is started ONCE;
 *  - the CLOCK (`ConvergeScheduler`) with a fake clock: change is a trailing
 *    debounce, the halt's quiet minute is not shortened by a change, the sweep
 *    runs every interval, the button is now, and a pass in flight queues one
 *    re-run;
 *  - and the SERVICE end to end: with no reads and no runner events a stopped
 *    run is re-boarded within one sweep (fake clock), killed lanes resume at
 *    boot (and wait with an errand when the preference is off), debris of a
 *    dead run is released at boot while a person's claim stays, and a halt
 *    event arms the minute.
 *
 * Nothing here spawns `claude`: the run starts are stubbed where they are
 * asserted, and everything up to them is real.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const {
  planConvergence, executeConvergence, ConvergeScheduler, stoppedByOperator, runIsDead, evidenceFingerprint,
  CHANGE_DEBOUNCE_MS, HALT_DELAY_MS, MAX_BOOT_RESUMES, MIN_SWEEP_MS, WAIT_OVERDUE_GRACE_MS, PRESS_ONLY_HALT_KINDS,
} = await import('../server/converge.ts');
const { newRun, phaseRecord, saveRun, loadRun, journalFile, consoleStoppedNote } = await import('../server/runner/state.ts');
const { START_DOORS } = await import('../shared/run-lifecycle.js');
const { lockPath, readLock } = await import('../server/store.ts');
type RunState = import('../server/runner/state.ts').RunState;
type PhaseRecord = import('../server/runner/state.ts').PhaseRecord;
type ConvergeFacts = import('../server/converge.ts').ConvergeFacts;
type ConvergeDeps = import('../server/converge.ts').ConvergeDeps;
type ConvergeReport = import('../server/converge.ts').ConvergeReport;
type ConvergeTrigger = import('../server/converge.ts').ConvergeTrigger;
type LockView = import('../server/runner/scheduler.ts').LockView;

const SCRIPTS = join(SKILL_DIR, 'scripts');
const NOW = Date.parse('2026-08-21T10:00:00Z');

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function run(over: Partial<RunState> = {}, phases: (Partial<PhaseRecord> & { phase: number })[] = []): RunState {
  const state = newRun({ slug: 'alpha', root: '/tmp/alpha' });
  Object.assign(state, over);
  for (const p of phases) Object.assign(phaseRecord(state, p.phase), p);
  return state;
}

function facts(over: Partial<ConvergeFacts> = {}): ConvergeFacts {
  return {
    slug: 'alpha', now: NOW, trigger: 'timer',
    board: { 1: 'done', 2: 'ready', 3: 'waiting' },
    runs: [], live: new Set(), locks: [],
    // `auto`, explicitly. These cases are about what a relaunch DOES, and were
    // written when resuming at boot was the only behaviour there was. Since
    // 3.5.0 the shipped default is `ask`, which defers instead — that path has
    // its own tests below, and leaving it as the default here would have turned
    // every relaunch assertion into an assertion about the question.
    prefs: { resumeAtBoot: 'auto' }, pidAlive: () => false,
    ...over,
  };
}

const kinds = (plan: { actions: { kind: string }[] }) => plan.actions.map((a) => a.kind);
const skipWhy = (plan: { actions: ({ kind: string } & { why?: string })[] }) =>
  plan.actions.filter((a) => a.kind === 'skip').map((a) => a.why ?? '').join(' | ');

/* ------------------------------------------------------------------ *
 * Reading a run
 * ------------------------------------------------------------------ */

test('stoppedByOperator: the field decides; old records fall back on the operator verbs\' shapes only', () => {
  assert.equal(stoppedByOperator(run({ status: 'paused', stoppedBy: 'operator' })), true);
  assert.equal(stoppedByOperator(run({ status: 'paused', stoppedBy: 'system' })), false, 'a console shutdown is not the operator');
  assert.equal(stoppedByOperator(run({ status: 'paused' })), true, 'before the field, a pause was always somebody\'s');
  assert.equal(stoppedByOperator(run({ status: 'halted' })), false, 'a halt the loop wrote is the system\'s');
  assert.equal(stoppedByOperator(run({ status: 'interrupted', halt: { at: '', reason: 'stopped by the operator' } })), true);
  assert.equal(stoppedByOperator(run({ status: 'interrupted', halt: { at: '', reason: 'nothing has been driving this run since …' } })), false);
  assert.equal(stoppedByOperator(run({ status: 'parked' })), false);
});

test('runIsDead: live, in flight, queued and orphan-alive runs are not dead; the rest are', () => {
  const alive = run({ status: 'halted' });
  assert.equal(runIsDead(alive, new Set([alive.id]), () => false), false, 'driven here');
  assert.equal(runIsDead(run({ status: 'running' }), new Set(), () => false), false, 'in flight under someone');
  assert.equal(runIsDead(run({ status: 'queued' }), new Set(), () => false), false);
  const orphan = run({ status: 'parked', children: { 2: { pid: 4242, phase: 2, startedAt: '' } } });
  assert.equal(runIsDead(orphan, new Set(), () => true), false, 'a session still writing');
  assert.equal(runIsDead(orphan, new Set(), () => false), true, '…until it is gone');
  assert.equal(runIsDead(run({ status: 'halted' }), new Set(), () => false), true);
  assert.equal(runIsDead(run({ status: 'finished' }), new Set(), () => false), true);
});

/* ------------------------------------------------------------------ *
 * The planner — specimens and pins
 * ------------------------------------------------------------------ */

test('planner: the P12 specimen — a parked run over an interrupted never-started record goes to the healer', () => {
  // A:211 resumed → A:212 parked at once; the record's note is the EARLIER
  // operator stop, but the run's own last stop is the loop's park.
  const r = run({
    status: 'parked', activePhase: null,
    halt: { at: '', reason: 'nothing left to run on its own — phase 2 is interrupted (stopped by the operator)' },
  }, [{ phase: 2, status: 'interrupted', note: 'stopped by the operator', attempts: 1 }]);
  const plan = planConvergence(facts({ runs: [r] }));
  assert.deepEqual(kinds(plan), ['heal'], skipWhy(plan));
  const heal = plan.actions[0];
  assert.equal(heal.kind === 'heal' && heal.runId, r.id);
});

test('planner: a run the operator paused or stopped is pinned — and the operator\'s own press is not', () => {
  const paused = run({ status: 'paused', stoppedBy: 'operator' }, [{ phase: 2, status: 'interrupted', note: 'stopped by the operator' }]);
  assert.deepEqual(kinds(planConvergence(facts({ runs: [paused] }))), ['skip']);
  assert.match(skipWhy(planConvergence(facts({ runs: [paused] }))), /operator stopped it/);
  // Before the field: any pause is read as the operator's.
  const old = run({ status: 'paused' }, [{ phase: 2, status: 'interrupted' }]);
  assert.match(skipWhy(planConvergence(facts({ runs: [old] }))), /operator stopped it/);
  // The press IS the operator: the same run is healed.
  assert.deepEqual(kinds(planConvergence(facts({ runs: [paused], trigger: 'button' }))), ['heal']);
});

test('planner: a resolved run, a live run, a finished run, a queued run and a run on its own clock are left alone', () => {
  const resolved = run({ status: 'halted', resolved: { at: '', auto: false, reason: 'dismissed' } }, [{ phase: 2, status: 'failed' }]);
  assert.match(skipWhy(planConvergence(facts({ runs: [resolved] }))), /resolved/);
  const live = run({ status: 'halted' }, [{ phase: 2, status: 'failed' }]);
  assert.match(skipWhy(planConvergence(facts({ runs: [live], live: new Set([live.id]) }))), /live/);
  assert.match(skipWhy(planConvergence(facts({ runs: [run({ status: 'finished' })] }))), /finished/);
  assert.match(skipWhy(planConvergence(facts({ runs: [run({ status: 'queued' })] }))), /queued/);
  const waiting = run({ status: 'paused', stoppedBy: 'system', waitUntil: '2026-08-21T12:00:00Z' });
  assert.match(skipWhy(planConvergence(facts({ runs: [waiting] }))), /own clock/);
  assert.match(skipWhy(planConvergence(facts({ runs: [] }))), /no run/);
  // The board unreadable: nothing is decided on nothing.
  const halted = run({ status: 'halted' }, [{ phase: 2, status: 'failed' }]);
  assert.match(skipWhy(planConvergence(facts({ runs: [halted], board: null }))), /board could not be read/);
});

test('planner: killed lanes relaunch with the own-session hint; without a session the brief is a resume; capped per phase', () => {
  const killed = run({ status: 'interrupted', stoppedBy: 'system' }, [
    { phase: 2, status: 'interrupted', note: consoleStoppedNote(2), sessionId: 'sess-2', resumeSessionId: 'sess-2' },
  ]);
  const plan = planConvergence(facts({ runs: [killed], board: { 1: 'done', 2: 'in-progress', 3: 'waiting' } }));
  assert.deepEqual(kinds(plan), ['relaunch']);
  const relaunch = plan.actions[0];
  assert.ok(relaunch.kind === 'relaunch');
  assert.deepEqual(relaunch.reboard, [{
    phase: 2, situation: 'work-in-progress', rung: 'resume-own-session', brief: 'continue', sessionId: 'sess-2', by: 'converge',
  }]);
  assert.deepEqual(relaunch.rearm, []);
  assert.match(relaunch.why.join(' '), /restart killed/);

  // No session id survived: the brief is the resume block on a fresh boot.
  const sessionless = run({ status: 'interrupted', stoppedBy: 'system' }, [{ phase: 2, status: 'interrupted', note: consoleStoppedNote(2) }]);
  const p2 = planConvergence(facts({ runs: [sessionless], board: { 1: 'done', 2: 'in-progress', 3: 'waiting' } }));
  assert.equal(p2.actions[0].kind === 'relaunch' && p2.actions[0].reboard[0].brief, 'resume');

  // Resumed MAX times already: an errand, not a fourth resume.
  const capped = run({ status: 'interrupted', stoppedBy: 'system', recoveries: { 2: { attempts: 0, lastAt: '', bootResumes: MAX_BOOT_RESUMES } } },
    [{ phase: 2, status: 'interrupted', note: consoleStoppedNote(2), sessionId: 'sess-2' }]);
  const p3 = planConvergence(facts({ runs: [capped], board: { 1: 'done', 2: 'in-progress', 3: 'waiting' } }));
  assert.deepEqual(kinds(p3), ['errand']);
  const errand = p3.actions[0];
  assert.ok(errand.kind === 'errand' && errand.phase === 2 && /restarts in a row/.test(errand.errand.need));
  assert.deepEqual(errand.kind === 'errand' && errand.errand.tried, [`resume-at-boot ×${MAX_BOOT_RESUMES}`]);
});

test('planner: with resume-at-boot off, killed lanes wait for a person with one errand each — nothing is launched', () => {
  const killed = run({ status: 'interrupted', stoppedBy: 'system' }, [
    { phase: 2, status: 'interrupted', note: consoleStoppedNote(2), sessionId: 'sess-2' },
    { phase: 3, status: 'interrupted', note: consoleStoppedNote(3) },
  ]);
  const plan = planConvergence(facts({ runs: [killed], prefs: { resumeAtBoot: false }, board: { 1: 'done', 2: 'in-progress', 3: 'in-progress' } }));
  assert.deepEqual(kinds(plan), ['errand', 'errand']);
  for (const action of plan.actions) {
    assert.ok(action.kind === 'errand' && /resuming killed lanes at boot is switched off/.test(action.errand.need), JSON.stringify(action));
    assert.ok(action.kind === 'errand' && /Resume at boot/.test(action.errand.how));
  }
});

test('planner: a shutdown between phases continues the run; the same stop by the operator does not; nothing left → nothing', () => {
  const shutdown = run({ status: 'paused', stoppedBy: 'system', finishedReason: 'the console shut down while this run was working' });
  const plan = planConvergence(facts({ runs: [shutdown] }));
  assert.deepEqual(kinds(plan), ['relaunch']);
  assert.ok(plan.actions[0].kind === 'relaunch' && plan.actions[0].reboard.length === 0);
  assert.match(plan.actions[0].kind === 'relaunch' ? plan.actions[0].why.join(' ') : '', /shut down/);
  // Scoped: the stop counts only the asked phases.
  const scoped = run({ status: 'paused', stoppedBy: 'system', onlyPhases: [1] });
  assert.match(skipWhy(planConvergence(facts({ runs: [scoped] }))), /nothing remains/);
  // An old interrupted run (no field) is NOT relaunched wholesale — it goes to the healer, which is bounded.
  const old = run({ status: 'interrupted', halt: { at: '', reason: 'nothing has been driving this run since …', phase: 2 } }, [{ phase: 2, status: 'interrupted', note: consoleStoppedNote(2) }]);
  const p2 = planConvergence(facts({ runs: [old], board: { 1: 'done', 2: 'in-progress', 3: 'waiting' } }));
  assert.deepEqual(kinds(p2), ['relaunch'], 'a killed lane is a killed lane, whatever stamped the run');
  const oldNoLanes = run({ status: 'interrupted', halt: { at: '', reason: 'nothing has been driving this run since …' } });
  assert.deepEqual(kinds(planConvergence(facts({ runs: [oldNoLanes] }))), ['heal']);
});

test('planner: an orphaned session still alive is waited for; once it is gone the run relaunches and adopt settles it', () => {
  const orphan = run({
    status: 'parked', halt: { at: '', reason: 'a session from an earlier console is still running (pid 4242, phase 2)', kind: 'orphaned-session', phase: 2 },
    children: { 2: { pid: 4242, phase: 2, startedAt: '' } },
  }, [{ phase: 2, status: 'running', sessionId: 'sess-2' }]);
  assert.match(skipWhy(planConvergence(facts({ runs: [orphan], pidAlive: () => true }))), /still running/);
  const gone = planConvergence(facts({ runs: [orphan], pidAlive: () => false, board: { 1: 'done', 2: 'in-progress', 3: 'waiting' } }));
  assert.deepEqual(kinds(gone), ['relaunch']);
  assert.match(gone.actions[0].kind === 'relaunch' ? gone.actions[0].why.join(' ') : '', /outlived the earlier console has ended/);
});

test('planner: debris — an autopilot claim of a dead run is released; a live run\'s, an orphan-alive run\'s and a person\'s are kept', () => {
  const dead = run({ status: 'halted' }, [{ phase: 2, status: 'failed' }]);
  const live = run({ status: 'running' });
  const orphanAlive = run({ status: 'parked', halt: { at: '', reason: 'orphan', kind: 'orphaned-session' }, children: { 4: { pid: 99, phase: 4, startedAt: '' } } });
  const locks: LockView[] = [
    { slug: 'alpha', phase: 3, owner: `autopilot/${dead.id}`, expired: false, leaseUntil: NOW + 600_000 },
    { slug: 'alpha', phase: 5, owner: `autopilot/${dead.id}`, expired: true },
    { slug: 'alpha', phase: 4, owner: `autopilot/${live.id}`, expired: false },
    { slug: 'alpha', phase: 6, owner: `autopilot/${orphanAlive.id}`, expired: false },
    { slug: 'alpha', phase: 2, owner: 'sam@laptop/p2', expired: false, leaseUntil: NOW + 600_000 },
  ];
  const plan = planConvergence(facts({
    runs: [live, orphanAlive, dead], live: new Set([live.id]), locks,
    pidAlive: (pid) => pid === 99,
  }));
  const released = plan.actions.filter((a) => a.kind === 'release-debris');
  assert.deepEqual(released.map((a) => a.kind === 'release-debris' && [a.phase, a.owner]).sort(),
    [[3, `autopilot/${dead.id}`], [5, `autopilot/${dead.id}`]].sort(), 'expired or not, the dead run\'s own claims — nothing else');
  // The latest run is the live one: the rest of the plan is a skip.
  assert.match(skipWhy(plan), /live/);
});

test('planner: a lock-cap park re-arms when the lock it waited out is gone — and stays parked while it is held', () => {
  const parked = run({ status: 'parked', stoppedBy: 'system', halt: { at: '', reason: 'nothing left to run on its own — phase 2 is parked' } }, [
    { phase: 2, status: 'parked', note: 'phase 2 is locked by sam@laptop/p2 and has waited 121 minutes for it — phase 2: held by sam@laptop/p2' },
  ]);
  const free = planConvergence(facts({ runs: [parked] }));
  assert.deepEqual(kinds(free), ['relaunch']);
  assert.ok(free.actions[0].kind === 'relaunch' && free.actions[0].rearm.length === 1 && free.actions[0].rearm[0] === 2);
  assert.match(free.actions[0].kind === 'relaunch' ? free.actions[0].why.join(' ') : '', /waited out is gone/);
  const held = planConvergence(facts({
    runs: [parked], locks: [{ slug: 'alpha', phase: 2, owner: 'sam@laptop/p2', expired: false, leaseUntil: NOW + 600_000 }],
  }));
  assert.ok(!kinds(held).includes('relaunch'), `still held: ${kinds(held).join(',')}`);
  // A lapsed lease is gone too.
  const lapsed = planConvergence(facts({
    runs: [parked], locks: [{ slug: 'alpha', phase: 2, owner: 'sam@laptop/p2', expired: false, leaseUntil: NOW - 1 }],
  }));
  assert.deepEqual(kinds(lapsed), ['relaunch']);
});

test('planner: the same evidence is not healed twice — until something changes, or the operator presses', () => {
  const halted = run({ status: 'halted', halt: { at: '', reason: 'phase 2 did not verify', phase: 2, kind: 'verify-failed' } }, [{ phase: 2, status: 'failed' }]);
  const first = planConvergence(facts({ runs: [halted] }));
  assert.equal(first.actions[0].kind, 'heal');
  const fingerprint = first.actions[0].kind === 'heal' ? first.actions[0].fingerprint : '';
  assert.equal(fingerprint, evidenceFingerprint(halted, facts().board!, []));
  assert.match(skipWhy(planConvergence(facts({ runs: [halted], lastNoop: fingerprint }))), /nothing has changed/);
  // A lock appearing or a record moving is a change.
  const changed = planConvergence(facts({ runs: [halted], lastNoop: fingerprint, locks: [{ slug: 'alpha', phase: 2, owner: 'x/y', expired: false }] }));
  assert.equal(changed.actions[0].kind, 'heal');
  assert.equal(planConvergence(facts({ runs: [halted], lastNoop: fingerprint, trigger: 'button' })).actions[0].kind, 'heal');
});

test('SLF-7: the noop latch rides the RUN — two passes over identical evidence write one run.converge across a simulated restart', async () => {
  const halted = run({ status: 'halted', halt: { at: '', reason: 'phase 2 did not verify', phase: 2, kind: 'verify-failed' } }, [{ phase: 2, status: 'failed' }]);
  // Pass 1, in a process whose scheduler has no memory of this plan: the heal
  // runs, finds nothing, journals once, and writes the latch onto the run.
  const firstDeps = stubDeps(halted);
  const first = await executeConvergence(planConvergence(facts({ runs: [halted], lastNoop: null })), firstDeps);
  assert.equal(firstDeps.lines.filter((l) => l.event === 'run.converge').length, 1);
  assert.ok(first.noop, 'the pass reports its fingerprint');
  assert.equal(halted.converge?.lastNoop, first.noop, 'persisted on the run, where its evidence lives');
  // Pass 2 after a RESTART: the scheduler's memory is blank (`lastNoop: null`),
  // the evidence is identical, the run remembers. Nothing healed, nothing written.
  const secondDeps = stubDeps(halted);
  const second = await executeConvergence(planConvergence(facts({ runs: [halted], lastNoop: null })), secondDeps);
  assert.equal(secondDeps.lines.filter((l) => l.event === 'run.converge').length, 0, 'the restart did not heal the same evidence again');
  assert.equal(second.actions[0].kind, 'skip');
  // …and a pass that LAUNCHES clears the latch, so the next pass looks again.
  const healing = stubDeps(halted, { heal: async () => ({ launched: true, phase: 2, situation: 'verify-red', rung: 'fix-verification' }) });
  const third = await executeConvergence(planConvergence(facts({ runs: [halted], lastNoop: null, trigger: 'button' })), healing);
  assert.equal(third.launched, true);
  assert.equal(halted.converge, null, 'a launch clears the latch');
  assert.equal(healing.lines.filter((l) => l.event === 'run.converge').length, 1);
});

test('SLF-7: a refused cmd: row with a past nextDueAt does not move the fingerprint — stable across two minutes', () => {
  const parked = run({ status: 'parked', halt: { at: '', reason: 'phase 2 needs a person', phase: 2, kind: 'needs-human' } }, [{
    phase: 2, status: 'parked',
    declared: { status: 'needs-human', reason: 'the token', watch: ['cmd:npm ci'], at: '2026-08-21T09:00:00.000Z' },
    // A row written before the scheduler dropped a refused row's clock: past
    // its due, `refused`, and never advanced by anybody.
    watchState: { at: '2026-08-21T09:30:00.000Z', refs: [{ ref: 'cmd:npm ci', scheme: 'cmd', state: 'refused', checkedAt: '2026-08-21T09:30:00.000Z', nextDueAt: NOW - 3_600_000, runs: 12 }] },
  } as never]);
  const board = facts().board!;
  const at = evidenceFingerprint(parked, board, [], null, null, NOW);
  const later = evidenceFingerprint(parked, board, [], null, null, NOW + 2 * 60_000);
  assert.equal(at, later, 'a refused row is not "due" — the term does not tick with the minute');
  // The same row `pending` IS live evidence, and does move the term.
  (parked.phases['2'].watchState!.refs[0] as { state: string }).state = 'pending';
  assert.notEqual(evidenceFingerprint(parked, board, [], null, null, NOW), evidenceFingerprint(parked, board, [], null, null, NOW + 2 * 60_000));
});

test('planner: clearing a gate is a change — the healer is asked again about a phase a person just unblocked', () => {
  // The shape this was written for, measured on a real run: a manual gate parks
  // the phase, the healer finds nothing to climb (only a person CAN clear it),
  // and the operator then does exactly what the errand asked. Approving writes
  // `gate-status.md` and moves nothing else this fingerprint reads — same run,
  // same records, and the board word stays `ready` either way — so the loop
  // skipped with "nothing has changed" against a gate that was already open,
  // and the run sat halted for hours.
  const halted = run(
    { status: 'halted', halt: { at: '', reason: 'phase 2 is gated', phase: 2, kind: 'no-handoff' } },
    [{ phase: 2, status: 'parked' }],
  );
  const before = planConvergence(facts({ runs: [halted], gateStamp: '111:80' }));
  assert.equal(before.actions[0].kind, 'heal');
  const fingerprint = before.actions[0].kind === 'heal' ? before.actions[0].fingerprint : '';
  assert.match(
    skipWhy(planConvergence(facts({ runs: [halted], lastNoop: fingerprint, gateStamp: '111:80' }))),
    /nothing has changed/,
  );
  // The approval: same run, same records, same board — a new gate stamp.
  const approved = planConvergence(facts({ runs: [halted], lastNoop: fingerprint, gateStamp: '222:140' }));
  assert.equal(approved.actions[0].kind, 'heal', 'an approved gate re-asks the healer');
  // And a plan with no gate file at all is not a permanent change: null is stable.
  const noGate = planConvergence(facts({ runs: [halted], gateStamp: null }));
  const noGatePrint = noGate.actions[0].kind === 'heal' ? noGate.actions[0].fingerprint : '';
  assert.match(
    skipWhy(planConvergence(facts({ runs: [halted], lastNoop: noGatePrint, gateStamp: null }))),
    /nothing has changed/,
  );
});

/* ------------------------------------------------------------------ *
 * The executor
 * ------------------------------------------------------------------ */

function stubDeps(state: RunState, over: Partial<ConvergeDeps> = {}): ConvergeDeps & {
  started: unknown[]; journal: ConvergeDeps['journal']; lines: { runId: string; event: string; data: Record<string, unknown>; phase?: number }[];
  released: { phase: number; owner: string }[]; poked: string[];
} {
  const started: unknown[] = [];
  const lines: { runId: string; event: string; data: Record<string, unknown>; phase?: number }[] = [];
  const released: { phase: number; owner: string }[] = [];
  const poked: string[] = [];
  return {
    started, lines, released, poked,
    now: () => NOW,
    runs: () => [state],
    live: () => new Set(),
    board: async () => ({ 1: 'done', 2: 'in-progress', 3: 'waiting' }),
    locks: () => [],
    prefs: () => ({}),
    pidAlive: () => false,
    heal: async () => ({ launched: false, reason: 'nothing to climb' }),
    startRun: async (slug, options) => { started.push({ slug, ...options }); return null; },
    editRun: (_slug, _runId, apply) => { apply(state); return state; },
    releaseLock: async (_slug, phase, owner) => { released.push({ phase, owner }); return { ok: true, detail: 'released' }; },
    journal: (_slug, runId, event, data, phase) => { lines.push({ runId, event, data, ...(phase === undefined ? {} : { phase }) }); },
    locksChanged: (slug) => { poked.push(slug); },
    ...over,
  };
}

test('executor: a relaunch bumps bootResumes, journals phase.resume-automatic + run.converge, and starts the run once', async () => {
  const state = run({ status: 'interrupted', stoppedBy: 'system', onlyPhases: [2, 3], skills: ['tdd'] }, [
    { phase: 2, status: 'interrupted', note: consoleStoppedNote(2), sessionId: 'sess-2' },
  ]);
  const deps = stubDeps(state);
  const plan = planConvergence(facts({ runs: [state], board: { 1: 'done', 2: 'in-progress', 3: 'waiting' } }));
  const report = await executeConvergence(plan, deps);
  assert.equal(report.launched, true);
  assert.equal(deps.started.length, 1, 'one launch per run');
  const start = deps.started[0] as { resumeRunId: string; reboard: unknown[]; onlyPhases: number[]; skills: string[] };
  assert.equal(start.resumeRunId, state.id);
  assert.equal(start.reboard.length, 1);
  assert.deepEqual(start.onlyPhases, [2, 3], 'a scoped run keeps its scope through the relaunch');
  assert.deepEqual(start.skills, ['tdd'], 'and its skills');
  assert.equal(state.recoveries?.['2']?.bootResumes, 1, 'the resume is counted on the run');
  // Named for what it is, with what woke it (LFC-7): `phase.resume-at-boot`
  // was true of 15 of its 25 lines.
  assert.ok(deps.lines.some((l) => l.event === 'phase.resume-automatic' && l.phase === 2 && l.data.count === 1
    && l.data.sessionId === 'sess-2' && l.data.path === 'killed-lane' && l.data.trigger === 'timer'));
  assert.ok(!deps.lines.some((l) => l.event === 'phase.resume-at-boot'), 'the retired name is never written');
  assert.ok(deps.lines.some((l) => l.event === 'run.converge' && l.data.action === 'relaunch'));
  // SLF-1: the start names its door — `run.start` will carry this actor whole —
  // with the loop's trigger, the planner's reason, the guard and the counter.
  const actor = (deps.started[0] as { actor: Record<string, unknown> }).actor;
  assert.equal(actor.door, 'converge-relaunch');
  assert.ok((START_DOORS as readonly string[]).includes(String(actor.door)));
  assert.equal(actor.by, 'converge');
  assert.equal(actor.via, 'timer', 'the sweep is a clock of the console\'s own');
  assert.equal(actor.origin, 'converge:timer');
  assert.equal(actor.guard, 'automaticResumeGate');
  assert.equal(actor.counter, `MAX_BOOT_RESUMES:1/${MAX_BOOT_RESUMES}`);
  assert.equal(actor.remoteUser, null);
});

test('SLF-1: the heal action hands the healer the pass — its trigger and evidence fingerprint — and a boot relaunch says boot', async () => {
  const halted = run({ status: 'halted', stoppedBy: 'system' }, [{ phase: 2, status: 'failed', note: 'phase 2 did not verify' }]);
  const passes: unknown[] = [];
  const deps = stubDeps(halted, { heal: async (_slug, pass) => { passes.push(pass); return { launched: false, reason: 'nothing to climb' }; } });
  const plan = planConvergence(facts({ runs: [halted], board: { 1: 'done', 2: 'in-progress', 3: 'waiting' }, trigger: 'halt' }));
  assert.deepEqual(kinds(plan), ['heal']);
  await executeConvergence(plan, deps);
  assert.equal(passes.length, 1);
  const pass = passes[0] as { trigger: string; fingerprint: string };
  assert.equal(pass.trigger, 'halt');
  assert.equal(typeof pass.fingerprint, 'string');
  assert.ok(pass.fingerprint.length > 10, 'the planner\'s fingerprint, not a placeholder');

  // A boot-triggered relaunch is `via: boot` with the boot as its origin.
  const state = run({ status: 'interrupted', stoppedBy: 'system' }, [{ phase: 2, status: 'interrupted', note: consoleStoppedNote(2), sessionId: 'sess-2' }]);
  const bootDeps = stubDeps(state, { prefs: () => ({ resumeAtBoot: 'auto' }) });
  const bootPlan = planConvergence(facts({ runs: [state], board: { 1: 'done', 2: 'in-progress', 3: 'waiting' }, trigger: 'boot' }));
  await executeConvergence(bootPlan, bootDeps);
  const actor = (bootDeps.started[0] as { actor: Record<string, unknown> }).actor;
  assert.equal(actor.door, 'converge-relaunch');
  assert.equal(actor.via, 'boot');
  assert.equal(actor.origin, 'converge:boot');
});

test('executor: debris release journals run.lock-debris-released on the DEAD run and pokes the locks', async () => {
  const dead = run({ status: 'halted', resolved: { at: '', auto: true, reason: 'superseded' } });
  const deps = stubDeps(dead, { locks: () => [{ slug: 'alpha', phase: 3, owner: `autopilot/${dead.id}`, expired: false }] });
  const plan = planConvergence(facts({ runs: [dead], locks: deps.locks('alpha') }));
  assert.deepEqual(kinds(plan), ['release-debris', 'skip']);
  const report = await executeConvergence(plan, deps);
  assert.deepEqual(deps.released, [{ phase: 3, owner: `autopilot/${dead.id}` }]);
  assert.deepEqual(deps.poked, ['alpha']);
  const line = deps.lines.find((l) => l.event === 'run.lock-debris-released');
  assert.equal(line?.runId, dead.id);
  assert.equal(line?.phase, 3);
  assert.equal(line?.data.ok, true);
  assert.equal(report.launched, false);
});

test('executor: an errand lands on the record and in the journal; a heal that finds nothing sets the noop fingerprint', async () => {
  const off = run({ status: 'interrupted', stoppedBy: 'system' }, [{ phase: 2, status: 'interrupted', note: consoleStoppedNote(2) }]);
  const deps = stubDeps(off, { prefs: () => ({ resumeAtBoot: false }) });
  const report = await executeConvergence(planConvergence(facts({ runs: [off], prefs: { resumeAtBoot: false }, board: { 1: 'done', 2: 'in-progress', 3: 'waiting' } })), deps);
  assert.equal(off.recoveries?.['2']?.errand?.situation, 'work-in-progress');
  assert.ok(deps.lines.some((l) => l.event === 'phase.errand' && l.phase === 2));
  assert.equal(report.errands.length, 1);
  assert.equal(deps.started.length, 0);

  const halted = run({ status: 'halted', halt: { at: '', reason: 'x', phase: 2 } }, [{ phase: 2, status: 'failed' }]);
  const d2 = stubDeps(halted);
  const plan = planConvergence(facts({ runs: [halted] }));
  const r2 = await executeConvergence(plan, d2);
  assert.equal(r2.noop, plan.actions[0].kind === 'heal' ? plan.actions[0].fingerprint : null, 'remembered so the same evidence is not re-read');
  assert.ok(d2.lines.some((l) => l.event === 'run.converge' && l.data.action === 'heal' && l.data.launched === false));
  const d3 = stubDeps(halted, { heal: async () => ({ launched: true, phase: 2, situation: 'verify-red', rung: 'resume-own-session', vehicle: 'session' }) });
  const r3 = await executeConvergence(plan, d3);
  assert.equal(r3.noop, null);
  assert.equal(r3.launched, true);
});

/* ------------------------------------------------------------------ *
 * The clock
 * ------------------------------------------------------------------ */

class FakeClock {
  time = NOW;
  now = (): number => this.time;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private seq = 0;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.push({ at: this.time + ms, fn, id });
    return id;
  };
  clearTimeout = (handle: unknown): void => { this.timers = this.timers.filter((t) => t.id !== handle); };
  /** Advance, firing every timer due on the way, in order. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = due.at;
      due.fn();
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.time = target;
    await new Promise((resolve) => setImmediate(resolve));
  }
  pendingCount(): number { return this.timers.length; }
}

function scheduler(opts: { everyMs?: number; slugs?: string[]; run?: (slug: string, trigger: ConvergeTrigger) => Promise<ConvergeReport | null> } = {}) {
  const clock = new FakeClock();
  const passes: { slug: string; trigger: ConvergeTrigger; at: number }[] = [];
  const s = new ConvergeScheduler({
    run: async (slug, trigger) => {
      passes.push({ slug, trigger, at: clock.time });
      return opts.run ? opts.run(slug, trigger) : null;
    },
    slugs: () => opts.slugs ?? ['alpha'],
    everyMs: () => opts.everyMs,
    clock,
  });
  return { s, clock, passes };
}

test('scheduler: change is a trailing debounce, the halt\'s quiet minute is not shortened by a change, the button is now', async () => {
  const { s, clock, passes } = scheduler();
  s.request('alpha', 'change');
  await clock.advance(500);
  s.request('alpha', 'change');
  await clock.advance(500);
  s.request('alpha', 'change');
  await clock.advance(CHANGE_DEBOUNCE_MS - 1);
  assert.equal(passes.length, 0, 'a burst of writes is one pass after the LAST of them');
  await clock.advance(1);
  await s.idle();
  assert.deepEqual(passes.map((p) => p.trigger), ['change']);
  assert.equal(passes[0].at, NOW + 1000 + CHANGE_DEBOUNCE_MS);

  s.request('beta', 'halt');
  await clock.advance(1000);
  s.request('beta', 'change');
  await clock.advance(CHANGE_DEBOUNCE_MS + 1000);
  assert.equal(passes.filter((p) => p.slug === 'beta').length, 0, 'the minute stands');
  await clock.advance(HALT_DELAY_MS);
  await s.idle();
  assert.deepEqual(passes.filter((p) => p.slug === 'beta').map((p) => p.trigger), ['halt']);

  s.request('gamma', 'halt');
  const report = await s.converge('gamma', 'button');
  assert.equal(report, null, 'the stub run answers null');
  assert.deepEqual(passes.filter((p) => p.slug === 'gamma').map((p) => p.trigger), ['button'], 'now, and the pending halt is folded into it');
  await clock.advance(HALT_DELAY_MS * 2);
  assert.equal(passes.filter((p) => p.slug === 'gamma').length, 1);
  s.close();
});

test('scheduler: a halt REPLACES a pending change, and takes its own later minute', async () => {
  // The other half of the rule above, and the ordering that loses it is the
  // ordinary one — a lane's session ends (`onPresenceChange` → a 2s `change`),
  // then the run halts milliseconds later. The halt's dueAt is ~60s out, so
  // `dueAt >= current.dueAt && trigger !== 'change'` RETURNED and the halt was
  // dropped outright: the pass then fired two seconds after the break, which is
  // the console launching something the same second something broke — exactly
  // what HALT_DELAY_MS exists to prevent. Worse, a pass that healed nothing
  // latched a noop fingerprint, so the next sweep skipped too and the halt got
  // no second chance at all.
  const { s, clock, passes } = scheduler();
  s.request('delta', 'change');
  await clock.advance(500);
  s.request('delta', 'halt');

  await clock.advance(CHANGE_DEBOUNCE_MS + 1000);
  assert.equal(passes.length, 0, 'the change must NOT fire — the halt replaced it');

  await clock.advance(HALT_DELAY_MS);
  await s.idle();
  assert.deepEqual(passes.map((p) => p.trigger), ['halt'], 'one pass, and it is the halt');
  assert.equal(passes[0].at, NOW + 500 + HALT_DELAY_MS, 'at the halt\'s own due time, never shortened');
  s.close();
});

test('scheduler: a halt behind a pending HALT does not restart the minute', async () => {
  // Narrow on purpose: the replacement rule is halt-over-CHANGE only. If a halt
  // could displace a pending halt, a run halting repeatedly would push its own
  // quiet minute out forever and the healer would never run.
  const { s, clock, passes } = scheduler();
  s.request('epsilon', 'halt');
  await clock.advance(30_000);
  s.request('epsilon', 'halt');
  await clock.advance(HALT_DELAY_MS - 30_000);
  await s.idle();
  assert.deepEqual(passes.map((p) => p.trigger), ['halt']);
  assert.equal(passes[0].at, NOW + HALT_DELAY_MS, 'the FIRST halt\'s minute, not the second\'s');
  s.close();
});

test('scheduler: the sweep visits every plan each interval (floored), re-armed after it completes; close stops it', async () => {
  const { s, clock, passes } = scheduler({ everyMs: 1_000, slugs: ['alpha', 'beta'] });
  s.start();
  await clock.advance(MIN_SWEEP_MS - 1);
  assert.equal(passes.length, 0, 'a preference below the floor is read as the floor');
  await clock.advance(1);
  await s.idle();
  assert.deepEqual(passes.map((p) => `${p.slug}:${p.trigger}`), ['alpha:timer', 'beta:timer']);
  await clock.advance(MIN_SWEEP_MS);
  await s.idle();
  assert.equal(passes.length, 4, 'and again next interval');
  s.close();
  await clock.advance(MIN_SWEEP_MS * 3);
  assert.equal(passes.length, 4, 'closed: nothing more');
});

test('scheduler: convergeEveryMs 0 disarms the timer sweep — the non-timer doors stay open', async () => {
  const { s, clock, passes } = scheduler({ everyMs: 0, slugs: ['alpha'] });
  s.start();
  await clock.advance(MIN_SWEEP_MS * 10);
  await s.idle();
  assert.equal(passes.length, 0, 'zero means OFF, not a floored 30-second sweep');
  s.request('alpha', 'change');
  await clock.advance(CHANGE_DEBOUNCE_MS);
  await s.idle();
  assert.deepEqual(passes.map((p) => p.trigger), ['change'], 'change and halt passes are not the timer\'s');
  s.close();
});

test('scheduler: single-flight — requests during a pass queue ONE re-run; the boot pass is every plan now', async () => {
  let release: (() => void) | null = null;
  const { s, clock, passes } = scheduler({
    run: () => new Promise<ConvergeReport | null>((resolve) => { release = () => resolve(null); }),
  });
  s.request('alpha', 'boot');
  await clock.advance(0);
  assert.equal(passes.length, 1);
  s.request('alpha', 'change', 0);
  s.request('alpha', 'halt', 0);
  await clock.advance(10);
  assert.equal(passes.length, 1, 'nothing runs beside the pass in flight');
  release!();
  await clock.advance(0);
  await clock.advance(0);
  assert.equal(passes.length, 2, 'one re-run, not two');
  release!();
  await clock.advance(0);
  assert.equal(passes.length, 2);
  const booted = s.boot(['alpha', 'beta']);
  await clock.advance(0);
  assert.deepEqual(passes.slice(2).map((p) => `${p.slug}:${p.trigger}`), ['alpha:boot'], 'one plan at a time');
  release!();
  await clock.advance(0);
  await clock.advance(0);
  assert.deepEqual(passes.slice(2).map((p) => `${p.slug}:${p.trigger}`), ['alpha:boot', 'beta:boot']);
  release!();
  await booted;
  s.close();
});

/* ------------------------------------------------------------------ *
 * The service, end to end
 * ------------------------------------------------------------------ */

const PLAN = `---
slug: alpha
created: 2026-08-06
status: active
phases: 3
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | cart api | 1 | — | app | it still works |
| 3 | checkout | 2 | — | app | it ships |

## Phases

### Phase 1 — schema
- **Size:** S

### Phase 2 — cart api
- **Size:** S

### Phase 3 — checkout
- **Size:** S
`;

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-converge-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function gitInit(root: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q'], { cwd: root, env });
  execFileSync('git', ['add', '-A'], { cwd: root, env });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root, env });
}

function handoff(root: string, phase: number, title: string, status: string): void {
  const pad = String(phase).padStart(2, '0');
  writeFileSync(join(root, 'docs', 'handoffs', 'alpha', `phase-${pad}-${title}.md`), `---
plan: docs/plans/alpha.md
phase: ${phase}
title: ${title}
status: ${status}
---
# Phase ${phase} — ${title}
`, 'utf8');
}

/** A lock exactly as `phase-lock.sh claim` writes it. */
function claim(root: string, slug: string, phase: number, owner: string, leaseFromNowS: number): string {
  const dir = join(root, 'docs', 'handoffs', slug, '.locks');
  mkdirSync(dir, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  const file = lockPath(join(root, 'docs', 'handoffs'), slug, phase);
  writeFileSync(file, [`slug=${slug}`, `phase=${phase}`, `owner=${owner}`, 'host=test', `claimed_at=${now - 60}`, `lease_until=${now + leaseFromNowS}`, ''].join('\n'), 'utf8');
  return file;
}

/** The converge-on flag set a console built from argv carries; a bare harness has it off. */
function service(root: string, flags: Record<string, unknown> = {}, before?: (svc: InstanceType<typeof Service>) => void) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: false,
    scriptsDir: SCRIPTS, logFile: null, converge: true, ...flags,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  // `auto`, for the same reason the planner fixture takes it: these cases are
  // about what a boot resume DOES. The shipped default is `ask`, which defers
  // and launches nothing, and it has its own tests at the end of this file.
  svc.prefs.resumeAtBoot = 'auto';
  before?.(svc);
  assert.equal(svc.open(root).ok, true);
  return svc;
}

/** The boot work done — queued runs re-adopted, the boot pass over every plan complete. */
async function settle(svc: InstanceType<typeof Service>): Promise<void> {
  await svc.bootSettled;
  await svc.converger.idle();
}

function journalEvents(root: string, runId: string): { event: string; phase?: number; data: Record<string, unknown> }[] {
  const file = journalFile(root, 'alpha', runId);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { event: string; phase?: number; data: Record<string, unknown> });
}

test('service: with no reads and no runner events, a stopped run with a re-boardable record is re-boarded within one sweep (fake clock)', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    const clock = new FakeClock();
    clock.time = Date.now();
    const retried: number[] = [];
    const svc = service(root, {}, (s) => {
      s.prefs.convergeEveryMs = MIN_SWEEP_MS;
      s.converger.setClock(clock);
      (s as never as { retryPhase: (slug: string, phase: number) => Promise<null> }).retryPhase =
        async (_slug: string, phase: number) => { retried.push(phase); return null; };
    });
    try {
      // Boot found nothing (no run yet). Now the P12 shape lands on disk with
      // nobody reading it: parked, one interrupted never-started record.
      await settle(svc);
      const state = newRun({ slug: 'alpha', root, autoRecover: true });
      state.status = 'parked';
      state.activePhase = null;
      state.halt = { at: new Date().toISOString(), reason: 'nothing left to run on its own — phase 1 is interrupted (stopped by the operator)' };
      const record = phaseRecord(state, 1);
      record.status = 'interrupted';
      record.note = 'stopped by the operator';
      record.startedAt = new Date(Date.now() + 5_000).toISOString();
      saveRun(state);

      await clock.advance(MIN_SWEEP_MS - 1);
      await svc.converger.idle();
      assert.deepEqual(retried, [], 'not before the interval');
      await clock.advance(1);
      await svc.converger.idle();
      assert.deepEqual(retried, [1], 'the healer re-boarded the never-started phase through the runner, unasked');
      const report = svc.convergeReports().find((r) => r.slug === 'alpha')!;
      assert.equal(report.trigger, 'timer');
      assert.equal(report.launched, true);
      assert.ok(report.actions.some((a) => a.kind === 'heal'));
      const events = journalEvents(root, state.id);
      assert.ok(events.some((e) => e.event === 'run.converge' && e.data.trigger === 'timer' && e.data.launched === true));
      assert.ok(events.some((e) => e.event === 'phase.rung' && e.data.rung === 'reboard-fresh'));
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('service: a stop event asks for a pass a minute out; without the converge flag nothing is armed', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    try {
      await settle(svc);
      const state = newRun({ slug: 'alpha', root, autoRecover: true });
      state.status = 'halted';
      state.halt = { at: new Date().toISOString(), reason: 'phase 2 did not verify', phase: 2, kind: 'verify-failed' };
      (svc as never as { onRunnerEvent: (event: string, data: unknown) => void }).onRunnerEvent('run:run', { state });
      const snap = svc.converger.snapshot();
      assert.equal(snap.pending.length, 1);
      assert.equal(snap.pending[0].trigger, 'halt');
      assert.ok(snap.pending[0].dueAt - Date.now() > HALT_DELAY_MS - 2_000);
    } finally { svc.close(); }

    const bare = service(root, { converge: undefined });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const state = newRun({ slug: 'alpha', root, autoRecover: true });
      state.status = 'halted';
      state.halt = { at: new Date().toISOString(), reason: 'x', phase: 2, kind: 'verify-failed' };
      (bare as never as { onRunnerEvent: (event: string, data: unknown) => void }).onRunnerEvent('run:run', { state });
      assert.equal(bare.converger.snapshot().pending.length, 0, 'a harness that never asked for the loop does not get it');
      assert.deepEqual(bare.convergeSlugs(), []);
    } finally { bare.close(); }
  } finally { cleanup(); }
});

test('service: at boot, lanes a console restart killed resume their own session through the runner', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    handoff(root, 1, 'schema', 'complete');
    handoff(root, 2, 'cart-api', 'in-progress');
    // The shutdown checkpoint's shape: paused by the system, phase 2's lane
    // interrupted with the killed-lane note and its session kept for --resume.
    const state = newRun({ slug: 'alpha', root, autoRecover: true });
    state.status = 'paused';
    state.stoppedBy = 'system';
    state.finishedReason = 'the console shut down while this run was working';
    const one = phaseRecord(state, 1); one.status = 'done';
    const two = phaseRecord(state, 2);
    two.status = 'interrupted';
    two.note = consoleStoppedNote(2);
    two.sessionId = 'sess-2';
    two.resumeSessionId = 'sess-2';
    saveRun(state);

    const started: { slug: string; options: Record<string, unknown> }[] = [];
    const svc = service(root, {}, (s) => {
      (s as never as { startRun: (slug: string, options: Record<string, unknown>) => Promise<unknown> }).startRun =
        async (slug: string, options: Record<string, unknown>) => { started.push({ slug, options }); return null; };
    });
    try {
      await settle(svc);
      assert.equal(started.length, 1, 'one launch at boot');
      assert.equal(started[0].options.resumeRunId, state.id);
      assert.deepEqual(started[0].options.reboard, [{
        phase: 2, situation: 'work-in-progress', rung: 'resume-own-session', brief: 'continue', sessionId: 'sess-2', by: 'converge',
      }]);
      const disk = loadRun(root, 'alpha', state.id, null)!;
      assert.equal(disk.recoveries?.['2']?.bootResumes, 1);
      const events = journalEvents(root, state.id);
      assert.ok(events.some((e) => e.event === 'phase.resume-automatic' && e.phase === 2 && e.data.sessionId === 'sess-2'
        && e.data.trigger === 'boot' && e.data.path === 'killed-lane'));
      assert.ok(events.some((e) => e.event === 'run.converge' && e.data.trigger === 'boot' && e.data.action === 'relaunch'));
      const report = svc.convergeReports().find((r) => r.slug === 'alpha')!;
      assert.equal(report.trigger, 'boot');
      assert.equal(report.launched, true);
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('service: with resume-at-boot off, the killed lane waits for a person with an errand — nothing launched', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    handoff(root, 1, 'schema', 'complete');
    const state = newRun({ slug: 'alpha', root, autoRecover: true });
    state.status = 'interrupted';
    state.stoppedBy = 'system';
    const two = phaseRecord(state, 2);
    two.status = 'interrupted';
    two.note = consoleStoppedNote(2);
    two.sessionId = 'sess-2';
    saveRun(state);

    const started: unknown[] = [];
    const svc = service(root, {}, (s) => {
      s.prefs.resumeAtBoot = false;
      (s as never as { startRun: (slug: string, options: unknown) => Promise<unknown> }).startRun =
        async (_slug: string, options: unknown) => { started.push(options); return null; };
    });
    try {
      await settle(svc);
      assert.equal(started.length, 0);
      const disk = loadRun(root, 'alpha', state.id, null)!;
      const errand = disk.recoveries?.['2']?.errand;
      assert.ok(errand, 'the one ask is on the record');
      assert.match(errand!.need, /switched off/);
      assert.match(errand!.how, /Resume at boot/);
      assert.ok(journalEvents(root, state.id).some((e) => e.event === 'phase.errand' && e.phase === 2));
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('service: at boot, an autopilot claim of a dead run is released through phase-lock.sh and journalled; a person\'s live claim stays', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    // A dead run — halted and already resolved, so the only thing the pass
    // can do for it is free what it left behind.
    const dead = newRun({ slug: 'alpha', root });
    dead.status = 'halted';
    dead.halt = { at: new Date().toISOString(), reason: 'phase 2 did not verify', phase: 2, kind: 'verify-failed' };
    dead.resolved = { at: new Date().toISOString(), auto: false, reason: 'dismissed', by: 'sam' };
    phaseRecord(dead, 2).status = 'failed';
    saveRun(dead);
    const ours = claim(root, 'alpha', 2, `autopilot/${dead.id}`, 1200);
    const theirs = claim(root, 'alpha', 3, 'sam@laptop/p3', 1200);

    const svc = service(root);
    try {
      await settle(svc);
      assert.equal(existsSync(ours), false, 'the dead run\'s unexpired claim is gone');
      assert.equal(existsSync(theirs), true, 'the person\'s claim is not ours to touch');
      assert.equal(readLock(join(root, 'docs', 'handoffs'), 'alpha', 3)?.owner, 'sam@laptop/p3');
      const line = journalEvents(root, dead.id).find((e) => e.event === 'run.lock-debris-released');
      assert.ok(line, 'journalled on the dead run');
      assert.equal(line!.phase, 2);
      assert.equal(line!.data.ok, true);
      assert.equal(line!.data.owner, `autopilot/${dead.id}`);
      const report = svc.convergeReports().find((r) => r.slug === 'alpha')!;
      assert.ok(report.actions.some((a) => a.kind === 'release-debris'));
      assert.ok(report.actions.some((a) => a.kind === 'skip' && /resolved/.test(a.why)), 'the resolved run itself is pinned');
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('service: a lock-cap park on a stopped run re-arms and the run relaunches once the lock is gone', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    handoff(root, 1, 'schema', 'complete');
    const state = newRun({ slug: 'alpha', root, autoRecover: true });
    state.status = 'parked';
    state.stoppedBy = 'system';
    state.halt = { at: new Date().toISOString(), reason: 'nothing left to run on its own — phase 2 is parked (phase 2 is locked by sam@laptop/p2 and has waited 121 minutes for it)' };
    phaseRecord(state, 1).status = 'done';
    const two = phaseRecord(state, 2);
    two.status = 'parked';
    two.note = 'phase 2 is locked by sam@laptop/p2 and has waited 121 minutes for it — phase 2: held by sam@laptop/p2 since now';
    saveRun(state);
    claim(root, 'alpha', 2, 'sam@laptop/p2', 1200);

    const started: unknown[] = [];
    const svc = service(root, {}, (s) => {
      (s as never as { startRun: (slug: string, options: unknown) => Promise<unknown> }).startRun =
        async (_slug: string, options: unknown) => { started.push(options); return null; };
    });
    try {
      await settle(svc);
      assert.equal(started.length, 0, 'held: the park stands');
      // The holder releases — the docs watcher would see it; the press stands in for the change trigger here.
      rmSync(lockPath(join(root, 'docs', 'handoffs'), 'alpha', 2));
      svc.invalidateAll();
      const report = await svc.converger.converge('alpha', 'change');
      assert.ok(report?.actions.some((a) => a.kind === 'relaunch' && a.rearm.includes(2)), JSON.stringify(report?.actions));
      assert.equal(started.length, 1);
      const disk = loadRun(root, 'alpha', state.id, null)!;
      assert.equal(disk.phases['2'].status, 'pending', 'reset for the boarding, no Retry pressed');
      assert.ok(journalEvents(root, state.id).some((e) => e.event === 'phase.lock-cap-rearmed' && e.phase === 2));
    } finally { svc.close(); }
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Presence (Phase 5): a session's claim is debris the moment its session ends
 * ------------------------------------------------------------------ */

const { endedSessionLocks } = await import('../server/converge.ts');

test('planner: a lock naming a session the registry shows ENDED is released — a person\'s or a foreign run\'s — and a live run\'s own claim is not', () => {
  const r = run({ status: 'halted', halt: { at: '', reason: 'x' } }, [{ phase: 2, status: 'failed' }]);
  const locks: LockView[] = [
    { slug: 'alpha', phase: 2, owner: 'sam@laptop', expired: false, leaseUntil: NOW + 3_600_000, session: 'ended-1' },
    { slug: 'alpha', phase: 3, owner: 'autopilot/deadbeef', expired: false, leaseUntil: NOW + 3_600_000, session: 'ended-2' },
    { slug: 'alpha', phase: 1, owner: 'sam@laptop', expired: false, leaseUntil: NOW + 3_600_000, session: 'live-1' },
    { slug: 'alpha', phase: 4, owner: 'sam@laptop', expired: false, leaseUntil: NOW + 3_600_000 },
  ];
  const presence = (lock: LockView) => (lock.session?.startsWith('ended') ? 'ended' : lock.session ? 'live' : 'unknown');
  assert.deepEqual(endedSessionLocks(locks, new Set(), presence).map((l) => l.phase), [2, 3]);
  assert.deepEqual(endedSessionLocks(locks, new Set(['deadbeef']), presence).map((l) => l.phase), [2], 'a live run\'s lane is its runner\'s to release');
  assert.deepEqual(endedSessionLocks(locks, new Set()).map((l) => l.phase), [], 'no registry, no verdict');
  const plan = planConvergence(facts({ runs: [r], locks, presence }));
  const debris = plan.actions.filter((a) => a.kind === 'release-debris');
  assert.deepEqual(debris.map((a) => a.kind === 'release-debris' && [a.phase, a.owner, a.runId, a.session]),
    [[2, 'sam@laptop', null, 'ended-1'], [3, 'autopilot/deadbeef', null, 'ended-2']]);
  assert.match((debris[0] as { why: string }).why, /session ended-1 has ended/);
  // The healer still runs for the run itself.
  assert.ok(kinds(plan).includes('heal'));
});

test('planner: a lock-cap park re-arms when the lock it waited on is held by an ENDED session', () => {
  const r = run({ status: 'halted', stoppedBy: 'system', halt: { at: '', reason: 'x' } }, [
    { phase: 2, status: 'parked', note: 'phase 2 is locked by sam@laptop and has waited 121 minutes for it — held' },
  ]);
  const locks: LockView[] = [{ slug: 'alpha', phase: 2, owner: 'sam@laptop', expired: false, leaseUntil: NOW + 3_600_000, session: 'gone' }];
  const held = planConvergence(facts({ runs: [r], locks }));
  assert.ok(!kinds(held).includes('relaunch'), 'without the registry the unexpired lock still holds the park');
  const freed = planConvergence(facts({ runs: [r], locks, presence: () => 'ended' }));
  const relaunch = freed.actions.find((a) => a.kind === 'relaunch');
  assert.ok(relaunch && relaunch.kind === 'relaunch' && relaunch.rearm.includes(2), skipWhy(freed));
});

test('executor: a session\'s debris (runId null) is released as its owner and journalled on the plan\'s latest run', async () => {
  const state = run({ status: 'halted', halt: { at: '', reason: 'x' } }, [{ phase: 2, status: 'failed' }]);
  const deps = stubDeps(state);
  const plan = {
    slug: 'alpha', trigger: 'change' as const, at: new Date(NOW).toISOString(),
    actions: [
      { kind: 'release-debris' as const, runId: null, phase: 2, owner: 'sam@laptop', session: 'gone', why: 'an unexpired claim of sam@laptop, whose session gone has ended' },
      { kind: 'skip' as const, runId: state.id, why: 'the healer already ran' },
    ],
  };
  const report = await executeConvergence(plan, deps);
  assert.equal(report.outcomes[0].ok, true);
  assert.deepEqual(deps.released, [{ phase: 2, owner: 'sam@laptop' }]);
  const line = deps.lines.find((j) => j.event === 'run.lock-debris-released');
  assert.ok(line, 'journalled');
  assert.equal(line!.runId, state.id, 'on the latest run, since the claim has no run of its own');
  assert.equal(line!.data.session, 'gone');
});

/* ------------------------------------------------------------------ *
 * The view a reader gets
 * ------------------------------------------------------------------ */

const { convergeView: convergeViewFn } = await import('../server/converge.ts');

test('convergeView flattens a report: every action with its outcome, the relaunch phase by phase, the heal by its answer', () => {
  const relaunch = { kind: 'relaunch', runId: 'r1', reboard: [{ phase: 12, situation: 'never-started', rung: 'reboard-fresh', brief: 'fresh' }], rearm: [5], why: ['phase 12 never started', 'phase 5 lock gone'] } as const;
  const debris = { kind: 'release-debris', runId: null, phase: 3, owner: 'mobin@host', why: 'its session ended', session: 'abc' } as const;
  const heal = { kind: 'heal', runId: 'r1', fingerprint: 'f', why: 'open records' } as const;
  const errand = { kind: 'errand', runId: 'r1', phase: 7, errand: { phase: 7, situation: 'gated-manual', tried: [], need: 'A person.', how: 'Approve.', at: 'x' }, why: 'exhausted' } as const;
  const report = {
    slug: 'demo', trigger: 'boot', at: '2026-08-21T10:00:00.000Z',
    actions: [debris, relaunch, heal, errand],
    outcomes: [
      { action: debris, ok: true },
      { action: relaunch, ok: true },
      { action: heal, ok: true, heal: { launched: true, phase: 2, situation: 'verify-red', rung: 'fix-agent', vehicle: 'agent' } },
      { action: errand, ok: true },
    ],
    launched: true, errands: [errand.errand], noop: null,
  };
  const view = convergeViewFn(report as never);
  assert.deepEqual(view.actions.map((a) => a.kind), ['release-debris', 'relaunch', 'heal', 'errand']);
  assert.deepEqual(view.actions[0], { kind: 'release-debris', phase: 3, owner: 'mobin@host', ok: true, why: 'its session ended', session: 'abc' });
  assert.deepEqual(view.actions[1].reboard, [{ phase: 12, situation: 'never-started', rung: 'reboard-fresh', brief: 'fresh' }]);
  assert.deepEqual(view.actions[1].rearm, [5]);
  assert.equal(view.actions[1].why, 'phase 12 never started; phase 5 lock gone');
  assert.deepEqual(view.actions[2], { kind: 'heal', ok: true, why: 'open records', phase: 2, situation: 'verify-red', rung: 'fix-agent', vehicle: 'agent', launched: true });
  assert.equal(view.actions[3].need, 'A person.');
  assert.equal(view.errands, 1);
  assert.equal(view.launched, true);
  assert.equal(view.noop, false);
  // A pass that only looked and remembered its fingerprint reads as a noop.
  const quiet = convergeViewFn({ ...report, actions: [heal], outcomes: [{ action: heal, ok: true, heal: { launched: false, reason: 'nothing to climb' } }], launched: false, errands: [], noop: 'fp' } as never);
  assert.equal(quiet.noop, true);
  assert.equal(quiet.actions[0].why, 'nothing to climb');
});

/* ------------------------------------------------------------------ *
 * The QA wedge: noticing the unblock, and continuing afterwards
 * ------------------------------------------------------------------ */

test('fingerprint: a QA verdict changing is a change — the same shape as clearing a gate', () => {
  // Measured on a real run. Recording pass/waived for the phase whose verdict
  // wedged the plan moves NOTHING this fingerprint used to read: the run is the
  // same, its records are the same, and the blocking phase's board word is
  // `done` before and after. So the healer's "found nothing to climb" latched
  // for ever against a plan the operator had just repaired — exactly the bug
  // the gate stamp was added to fix, in the one other place it could happen.
  const parked = run({ status: 'parked', halt: { at: '', reason: 'nothing is ready', phase: 1, kind: 'plan-deadlocked' } },
    [{ phase: 1, status: 'done' }]);
  const wedged = { 1: 'done', 2: 'waiting', 3: 'waiting' } as Record<number, string>;
  const before = evidenceFingerprint(parked, wedged, [], null, { 1: 'fail' });
  const after = evidenceFingerprint(parked, wedged, [], null, { 1: 'pass' });
  assert.notEqual(before, after, 'the verdict is the only thing that moved, and it must count');
});

test('fingerprint: a lease KEEPALIVE is not a change — it is a timer, and only a timer', () => {
  // The measured shape this closes. A live lane refreshes its own phase lock
  // every ten minutes (`LEASE_REFRESH_MS`) so a long phase cannot silently
  // lose its claim mid-work. That moved `leaseUntil`, which moved this
  // fingerprint, which told the healer "something has changed" — from a lane
  // that had done nothing whatsoever. It is evidence that a process is ALIVE
  // and never evidence that it is PROGRESSING, and a session squatting a lock
  // on somebody else's clock is exactly where those two come apart.
  const driving = run({ status: 'running' }, [{ phase: 1, status: 'running' }]);
  const board = { 1: 'in-progress' } as Record<number, string>;
  const held = (leaseUntil: number) => ([{
    slug: 'x', phase: 1, owner: 'autopilot/abc', expired: false, leaseUntil, file: '/tmp/x.lock',
  }] as unknown as Parameters<typeof evidenceFingerprint>[2]);

  assert.equal(
    evidenceFingerprint(driving, board, held(1_000_000)),
    evidenceFingerprint(driving, board, held(1_000_000 + 10 * 60_000)),
    'ten more minutes of lease is not ten minutes of work',
  );
});

test('fingerprint: a lock LAPSING, or changing hands, still is a change', () => {
  // The other half of dropping `leaseUntil`: the transitions that actually
  // mean something must survive. `expired` is derived from the lease against
  // the read clock (`parse/folder.ts`), so a lapse registers on the tick it
  // happens even though the timestamp itself is gone.
  const driving = run({ status: 'running' }, [{ phase: 1, status: 'running' }]);
  const board = { 1: 'in-progress' } as Record<number, string>;
  const lock = (patch: Record<string, unknown>) => ([{
    slug: 'x', phase: 1, owner: 'autopilot/abc', expired: false, leaseUntil: 1_000_000,
    file: '/tmp/x.lock', ...patch,
  }] as unknown as Parameters<typeof evidenceFingerprint>[2]);

  const healthy = evidenceFingerprint(driving, board, lock({}));
  assert.notEqual(healthy, evidenceFingerprint(driving, board, lock({ expired: true })),
    'a lapsed lease is a phase anyone may now take — the healer must see it');
  assert.notEqual(healthy, evidenceFingerprint(driving, board, lock({ owner: 'someone/else' })),
    'a takeover is a change of holder');
  assert.notEqual(healthy, evidenceFingerprint(driving, board, []),
    'a holder releasing IS a change — the comment has always said so');
});

test('fingerprint: the board opening up on a RECORD-LESS phase is a change', () => {
  // The other half. Once the verdict is fixed, phase 2 goes waiting -> ready —
  // but phase 2 has no record (it was never boarded), and the fingerprint only
  // ever walked `run.phases`. The one event that means "this run can move
  // again" was invisible to the loop that exists to notice it.
  const parked = run({ status: 'parked', halt: { at: '', reason: 'nothing is ready', phase: 1 } },
    [{ phase: 1, status: 'done' }]);
  const wedged = evidenceFingerprint(parked, { 1: 'done', 2: 'waiting' }, []);
  const open = evidenceFingerprint(parked, { 1: 'done', 2: 'ready' }, []);
  assert.notEqual(wedged, open);
});

test('planner: a parked run whose board has ready work it never boarded is relaunched', () => {
  // `systemStop` only reaches `relaunch` for paused/interrupted runs, so the
  // runner's own "nothing is ready" park always fell through to `heal` — and
  // the healer only ever acts on phases that already have RECORDS. A phase that
  // was never boarded has none, so nothing continued the run even after a
  // person cleared what was blocking it.
  const parked = run({ status: 'parked', stoppedBy: 'system', halt: { at: '', reason: 'nothing is ready to run', phase: 1 } },
    [{ phase: 1, status: 'done' }]);
  const plan = planConvergence(facts({ runs: [parked], board: { 1: 'done', 2: 'ready', 3: 'waiting' } }));
  assert.ok(kinds(plan).includes('relaunch'), `expected a relaunch, got: ${kinds(plan).join(',')}`);
});

test('RCV-11: a run halt() stopped and relaunched gives a why that never says the console shut down — and a restart-interrupted run naming its own halt says which', () => {
  // (a) A `halt()`-stopped run — `halted`, never `systemStop` — relaunches
  // only for the board opening up (or a restart's killed lanes), and the
  // sentence says that: "shut down" is a claim about the console, and the
  // console did nothing to this run.
  const halted = run({ status: 'halted', stoppedBy: 'system', halt: { at: '', reason: 'nothing can proceed — phase 2 holds every dependent', phase: 2, kind: 'plan-deadlocked' } },
    [{ phase: 1, status: 'done' }]);
  const plan = planConvergence(facts({ runs: [halted], board: { 1: 'done', 2: 'ready', 3: 'waiting' } }));
  const relaunch = plan.actions.find((a) => a.kind === 'relaunch');
  assert.ok(relaunch, `expected a relaunch, got ${kinds(plan).join(',')}`);
  const why = relaunch.kind === 'relaunch' ? relaunch.why.join(' ') : '';
  assert.ok(!/shut down/.test(why), why);
  assert.match(why, /the board has ready work again/);
  // …and a killed lane on a halted run relaunches for the lane, in the lane's words.
  const withLane = run({ status: 'halted', stoppedBy: 'system', halt: { at: '', reason: 'phase 2 did not verify', phase: 2, kind: 'verify-failed' } },
    [{ phase: 2, status: 'interrupted', note: consoleStoppedNote(2) }]);
  const p2 = planConvergence(facts({ runs: [withLane], board: { 1: 'done', 2: 'in-progress', 3: 'waiting' } }));
  const r2 = p2.actions.find((a) => a.kind === 'relaunch');
  assert.ok(r2 && r2.kind === 'relaunch');
  assert.ok(!/shut down/.test(r2.why.join(' ')), r2.why.join(' '));
  assert.match(r2.why.join(' '), /a console restart killed/);
  // (b) The system-stop sentence stays true for the run it was written for —
  // one the console's own restart interrupted, no halt of its own…
  const interrupted = run({ status: 'interrupted', stoppedBy: 'system', halt: { at: '', reason: 'nothing has been driving this run since …', phase: 2, kind: 'interrupted-by-restart' } });
  const p3 = planConvergence(facts({ runs: [interrupted] }));
  const r3 = p3.actions.find((a) => a.kind === 'relaunch');
  assert.ok(r3 && r3.kind === 'relaunch', kinds(p3).join(','));
  assert.match(r3.why.join(' '), /the console shut down while this run was working/);
  // …and names the run's OWN halt when a stale one rides the restart-interrupted run.
  const stale = run({ status: 'interrupted', stoppedBy: 'system', halt: { at: '', reason: 'every model is exhausted', phase: 2, kind: 'models-exhausted' } });
  const p4 = planConvergence(facts({ runs: [stale] }));
  const r4 = p4.actions.find((a) => a.kind === 'relaunch');
  assert.ok(r4 && r4.kind === 'relaunch', kinds(p4).join(','));
  assert.match(r4.why.join(' '), /shut down after this run stopped on its own \(models-exhausted/);
  assert.ok(!/while this run was working/.test(r4.why.join(' ')));
});

test('ACC-5.1 (RCV-3): a run halted failure-streak is relaunched by no trigger but button — every automatic trigger falls through to the healer', () => {
  // The audit's shape: the streak halted the run, phase 2 is ready and never
  // boarded, killed lanes from a restart sit beside it — three relaunch doors,
  // each of which used to answer the halt and zero the counter on the way in.
  const spent = (over: Partial<RunState> = {}) => run({
    status: 'halted', stoppedBy: 'system', consecutiveFailures: 2, maxConsecutiveFailures: 2,
    halt: { at: '', reason: '2 phases failed in a row', phase: 1, kind: 'failure-streak' },
    ...over,
  }, [{ phase: 1, status: 'failed', halt: { at: '', reason: 'red', phase: 1, kind: 'verify-failed' } }]);
  for (const trigger of ['timer', 'boot', 'change', 'halt'] as const) {
    const plan = planConvergence(facts({ runs: [spent()], board: { 1: 'stuck', 2: 'ready', 3: 'waiting' }, trigger }));
    assert.ok(!kinds(plan).includes('relaunch'), `${trigger}: no relaunch — got ${kinds(plan).join(',')}`);
    assert.ok(kinds(plan).includes('heal'), `${trigger}: the phases' own ladders still climb — got ${kinds(plan).join(',')}`);
  }
  // …a restart's killed lanes included: that was the door the measured reset came through.
  const killed = spent({ status: 'halted' });
  Object.assign(phaseRecord(killed, 2), { status: 'interrupted', note: consoleStoppedNote(2), sessionId: 'sess-2', resumeSessionId: 'sess-2' });
  const afterRestart = planConvergence(facts({ runs: [killed], board: { 1: 'stuck', 2: 'in-progress', 3: 'waiting' }, trigger: 'boot' }));
  assert.ok(!kinds(afterRestart).includes('relaunch'), `boot after a restart: ${kinds(afterRestart).join(',')}`);
  // A person's press is the one door left open.
  const pressed = planConvergence(facts({ runs: [spent()], board: { 1: 'stuck', 2: 'ready', 3: 'waiting' }, trigger: 'button' }));
  assert.ok(kinds(pressed).includes('relaunch'), `button: ${kinds(pressed).join(',')}`);
  // The same for a refused credential (RCV-1): the breaker opens only for a
  // person, so a relaunch by clock would park on the same wall.
  const refused = run({
    status: 'halted', stoppedBy: 'system', consecutiveFailures: 1,
    halt: { at: '', reason: 'organization policy blocks this credential (account: p)', phase: 1, kind: 'credential-refused' },
  }, [{ phase: 1, status: 'parked', cause: { kind: 'credential-refused', class: 'org-policy', reason: 'organization policy blocks this credential', at: '' } }]);
  const byClock = planConvergence(facts({ runs: [refused], board: { 1: 'ready', 2: 'ready', 3: 'waiting' } }));
  assert.ok(!kinds(byClock).includes('relaunch'), `credential-refused by timer: ${kinds(byClock).join(',')}`);
  assert.ok(kinds(byClock).includes('heal'));
  const byPress = planConvergence(facts({ runs: [refused], board: { 1: 'ready', 2: 'ready', 3: 'waiting' }, trigger: 'button' }));
  assert.ok(kinds(byPress).includes('relaunch'), `credential-refused by button: ${kinds(byPress).join(',')}`);
  assert.deepEqual([...PRESS_ONLY_HALT_KINDS], ['failure-streak', 'credential-refused']);
});

test('planner: a parked run with nothing ready is NOT relaunched — it would only re-park', () => {
  const parked = run({ status: 'parked', stoppedBy: 'system', halt: { at: '', reason: 'nothing is ready to run', phase: 1 } },
    [{ phase: 1, status: 'done' }]);
  const plan = planConvergence(facts({ runs: [parked], board: { 1: 'done', 2: 'waiting', 3: 'waiting' } }));
  assert.ok(!kinds(plan).includes('relaunch'), `nothing to run: ${kinds(plan).join(',')}`);
});

test('planner: an operator-stopped run is still never relaunched by the loop', () => {
  const stopped = run({ status: 'parked', stoppedBy: 'operator' }, [{ phase: 1, status: 'done' }]);
  const plan = planConvergence(facts({ runs: [stopped], board: { 1: 'done', 2: 'ready' } }));
  assert.ok(!kinds(plan).includes('relaunch'));
});

test('scheduler: the noop latch survives a skip pass — it used to erase itself', () => {
  // `noop` is assigned only in the heal branch, so a pass whose single action is
  // a `skip` — including the skip whose whole PURPOSE is the latch ("nothing has
  // changed since the last pass found nothing to climb") — reported `noop: null`,
  // and the scheduler then deleted the fingerprint it had just honoured. The next
  // sweep had nothing to compare against, planned a heal, refused, latched, and
  // skipped again: a board read, a healer pass and a journal line every OTHER
  // sweep, for ever, on a run nobody could move.
  const kept = new Map<string, string>();
  const apply = (report: { noop: string | null; launched: boolean }) => {
    if (report.noop) kept.set('alpha', report.noop);
    else if (report.launched) kept.delete('alpha');
  };
  apply({ noop: 'FP', launched: false });          // the healer found nothing
  assert.equal(kept.get('alpha'), 'FP');
  apply({ noop: null, launched: false });          // the guard skip
  assert.equal(kept.get('alpha'), 'FP', 'a skip must not forget why it skipped');
  apply({ noop: null, launched: true });           // something actually moved
  assert.equal(kept.get('alpha'), undefined, 'a launch invalidates the latch');
});

test('planner: a GRANT-caused wait-cap park is NOT re-armed — this pass can only see locks', () => {
  // D2 armed the two-hour cap for `grant` and `reserved` holders as well, so a
  // park can now be caused by a sibling lane that hangs rather than by a lock.
  // `heldByAnother` reads LOCKS, so for a grant it reports the way clear —
  // relaunch, meet the same grant, park again, with a `why` line ("the lock it
  // waited out is gone") that is simply false. `runner.ts`'s own re-arm was
  // narrowed to `LOCK_CAP_PARK_BY_LOCK`; this is the second reader of that
  // predicate, and narrowing only one of the two left this one to defeat it.
  const parked = run({ status: 'parked', stoppedBy: 'system', halt: { at: '', reason: 'nothing left to run on its own — phase 2 is parked' } }, [
    { phase: 2, status: 'parked', note: 'phase 2 is held by autopilot/r-foreign (other phase 9) and has waited 121 minutes for it' },
  ]);
  const plan = planConvergence(facts({ runs: [parked] }));
  const relaunch = plan.actions.find((a) => a.kind === 'relaunch');
  assert.ok(!relaunch || (relaunch.kind === 'relaunch' && !relaunch.rearm.includes(2)),
    `a grant park must not be re-armed by a pass that cannot see grants: ${JSON.stringify(plan.actions)}`);

  // …and the LOCK wording is untouched: the narrowing must not disarm the case
  // this pass was built for.
  const byLock = run({ status: 'parked', stoppedBy: 'system', halt: { at: '', reason: 'nothing left to run on its own — phase 2 is parked' } }, [
    { phase: 2, status: 'parked', note: 'phase 2 is locked by sam@laptop/p2 and has waited 121 minutes for it' },
  ]);
  const still = planConvergence(facts({ runs: [byLock] }));
  assert.ok(still.actions.some((a) => a.kind === 'relaunch' && a.rearm.includes(2)),
    'a lock park still re-arms');
});

test('planner: a SESSION-CAP park re-arms only once a lane is free (D28/P8)', () => {
  // The third cause, and the second answerable one. D28 made the session cap an
  // honest holder, so a phase can be parked for having waited two hours on a
  // FULL FLEET rather than on anyone's claim — and that park had no way back:
  // it is not `BY_LOCK`, so neither re-arm reader would touch it, and a console
  // running three long lanes stranded every fourth phase until a person pressed
  // Retry. Its question is not `heldByAnother` (there is no holder to find) but
  // `facts.laneFree`.
  const capped = run({ status: 'parked', stoppedBy: 'system', halt: { at: '', reason: 'nothing left to run on its own — phase 2 is parked' } }, [
    { phase: 2, status: 'parked', note: 'phase 2 is held by 3 of 3 lanes (session cap) and has waited 121 minutes for it' },
  ]);

  const full = planConvergence(facts({ runs: [capped], laneFree: () => false }));
  const held = full.actions.find((a) => a.kind === 'relaunch');
  assert.ok(!held || (held.kind === 'relaunch' && !held.rearm.includes(2)),
    `a still-full fleet must not re-arm: ${JSON.stringify(full.actions)}`);

  const free = planConvergence(facts({ runs: [capped], laneFree: () => true }));
  assert.ok(free.actions.some((a) => a.kind === 'relaunch' && a.rearm.includes(2)),
    'a freed lane is exactly the event this park was waiting for');

  // No answer to hand ⇒ no re-arm. The fail-safe direction: a park that stays
  // is a phase a person can Retry; a park cleared on a guess re-boards straight
  // back into the same full fleet.
  const unknown = planConvergence(facts({ runs: [capped] }));
  const guessed = unknown.actions.find((a) => a.kind === 'relaunch');
  assert.ok(!guessed || (guessed.kind === 'relaunch' && !guessed.rearm.includes(2)),
    'with no `laneFree` dep the pass must not guess');
});

test('planner: `laneFree` does not leak into a LOCK park`s question', () => {
  // The two predicates are disjoint by construction (`locked by` vs `held by`)
  // and so are their questions. A fleet with no free lane must not hold back a
  // lock park whose lock is gone — that would make an unrelated fact a second,
  // invisible condition on the case this pass was built for.
  const byLock = run({ status: 'parked', stoppedBy: 'system', halt: { at: '', reason: 'nothing left to run on its own — phase 2 is parked' } }, [
    { phase: 2, status: 'parked', note: 'phase 2 is locked by sam@laptop/p2 and has waited 121 minutes for it' },
  ]);
  const plan = planConvergence(facts({ runs: [byLock], laneFree: () => false }));
  assert.ok(plan.actions.some((a) => a.kind === 'relaunch' && a.rearm.includes(2)),
    'a lock park is decided by the lock, and by nothing else');
});

/* ------------------------------------------------------------------ *
 * The wait that nothing woke (run 258e1cc7, 2026-08-26)
 * ------------------------------------------------------------------ */

test('planner: a waiting run whose clock has PASSED is resumed — the timer it trusted is gone', () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  // `paused` is the reconciled shape a dead waiting run reads as by the time
  // the planner sees it — raw `waiting` is IN_FLIGHT and pinned earlier.
  const parked = (until: string, over: Partial<RunState> = {}) =>
    run({ status: 'paused', stoppedBy: 'system', waitReason: 'external', waitUntil: until, ...over },
      [{ phase: 2, status: 'waiting', parkedUntil: until }]);
  const past = iso(NOW - WAIT_OVERDUE_GRACE_MS - 5_000);

  // Inside the grace the armed timer still owns the resume — both would race
  // to the same startRun otherwise.
  const graced = planConvergence(facts({ runs: [parked(iso(NOW - WAIT_OVERDUE_GRACE_MS + 5_000))] }));
  assert.match(skipWhy(graced), /own clock/);

  // Past the grace the loop does what the operator's Recheck would.
  const overdue = planConvergence(facts({ runs: [parked(past)] }));
  assert.deepEqual(kinds(overdue), ['relaunch'], skipWhy(overdue));
  const act = overdue.actions[0];
  assert.ok(act.kind === 'relaunch' && act.reboard.length === 0 && act.rearm.length === 0);
  assert.match(act.kind === 'relaunch' ? act.why.join(' ') : '', /passed and nothing resumed it/);

  // The operator's own stop stays pinned, overdue or not.
  assert.match(skipWhy(planConvergence(facts({
    runs: [parked(past, { status: 'paused', stoppedBy: 'operator' })],
  }))), /own clock/);

  // A usage wait honors `onLimit: 'pause'` — the operator chose to stay down…
  const pausedPolicy = run({
    status: 'paused', stoppedBy: 'system', waitReason: 'usage-limit', onLimit: 'pause', waitUntil: past,
  });
  assert.match(skipWhy(planConvergence(facts({ runs: [pausedPolicy] }))), /own clock/);

  // …and under `wait` (the default) an overdue usage clock resumes too.
  const waitPolicy = run({
    status: 'paused', stoppedBy: 'system', waitReason: 'usage-limit', onLimit: 'wait', waitUntil: past,
  });
  assert.deepEqual(kinds(planConvergence(facts({ runs: [waitPolicy] }))), ['relaunch']);
});

test('service: a SECOND park while the run is already waiting re-arms the resume clock — the arm must not ride the announcement dedupe', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    const started: { slug: string; options: Record<string, unknown> }[] = [];
    const svc = service(root, {}, (s) => {
      (s as never as { startRun: (slug: string, options: Record<string, unknown>) => Promise<null> }).startRun =
        async (slug: string, options: Record<string, unknown>) => { started.push({ slug, options }); return null; };
    });
    try {
      await settle(svc);
      // First park: phase 3 declares a wait a minute out. The run announces
      // `waiting` and arms its resume for that clock.
      const state = newRun({ slug: 'alpha', root });
      state.status = 'waiting';
      state.stoppedBy = 'system';
      state.waitReason = 'external';
      state.waitUntil = new Date(Date.now() + 60_000).toISOString();
      const three = phaseRecord(state, 3);
      three.status = 'waiting';
      three.parkedUntil = state.waitUntil;
      saveRun(state);
      const emit = svc as never as { onRunnerEvent: (event: string, data: unknown) => void };
      emit.onRunnerEvent('run:run', { state });

      // Second park, minutes later in the incident: phase 2 parks too, the
      // status is STILL `waiting` — only the clock moved. With the arm inside
      // the announcement switch the dedupe returned first and the new clock
      // was never armed; run 258e1cc7 then slept from 02:53Z until a person
      // pressed Recheck at 06:52Z.
      three.status = 'done';
      delete three.parkedUntil;
      state.waitUntil = new Date(Date.now() + 300).toISOString();
      const two = phaseRecord(state, 2);
      two.status = 'waiting';
      two.parkedUntil = state.waitUntil;
      saveRun(state);
      emit.onRunnerEvent('run:run', { state });

      const deadline = Date.now() + 3_000;
      while (!started.length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(started.length, 1, 'the moved clock fired and resumed the run');
      assert.equal(started[0].slug, 'alpha');
      assert.equal(started[0].options.resumeRunId, state.id);
    } finally { svc.close(); }
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * `resumeAtBoot: 'ask'` — the shipped default since 3.5.0
 * ------------------------------------------------------------------ */

test('planner: with ask, a restart-stopped run neither relaunches nor writes an errand', () => {
  const killed = run({
    status: 'interrupted', stoppedBy: 'system',
    phases: {
      1: { phase: 1, status: 'done', attempts: 1, costUsd: 0 },
      2: {
        phase: 2, status: 'interrupted', attempts: 1, costUsd: 0,
        note: consoleStoppedNote(2), sessionId: 'sess-2', resumeSessionId: 'sess-2',
      },
    },
  });
  const plan = planConvergence(facts({
    runs: [killed],
    prefs: { resumeAtBoot: 'ask' },
    board: { 1: 'done', 2: 'in-progress', 3: 'waiting' },
  }));
  assert.deepEqual(kinds(plan), ['await-decision']);
  const [action] = plan.actions as [{ kind: string; phases: number[]; sessions: string[] }];
  assert.deepEqual(action.phases, [2], 'the question names the phases it would pick up');
  assert.deepEqual(action.sessions, ['sess-2'], '…and the sessions it would resume');
  // The whole point: nothing is launched, and no errand is raised. An errand is
  // a job somebody owes; this is a question only the person here can answer.
  assert.ok(!kinds(plan).includes('relaunch'));
  assert.ok(!kinds(plan).includes('errand'));
});

test('planner: an answered ask behaves exactly like the mode it answers to', () => {
  const killed = () => run({
    status: 'interrupted', stoppedBy: 'system',
    phases: {
      1: { phase: 1, status: 'done', attempts: 1, costUsd: 0 },
      2: {
        phase: 2, status: 'interrupted', attempts: 1, costUsd: 0,
        note: consoleStoppedNote(2), sessionId: 'sess-2', resumeSessionId: 'sess-2',
      },
    },
  });
  const board = { 1: 'done', 2: 'in-progress', 3: 'waiting' };

  const yes = planConvergence(facts({
    runs: [killed()], prefs: { resumeAtBoot: 'ask' }, board,
    resumeDecision: () => 'continue',
  }));
  assert.deepEqual(kinds(yes), ['relaunch'], 'continue resumes, like `auto`');

  // …and `dismiss` is NOT `off`. "Not now" leaves the run exactly as the
  // restart left it and stops asking — no relaunch, and no errand either. An
  // errand is a job in the inbox, and putting one there for work the operator
  // has just declined contradicts the dialog that promised nothing would
  // change. `off` is a standing policy and keeps its errand; a dismissal
  // answers one question on one boot.
  const no = planConvergence(facts({
    runs: [killed()], prefs: { resumeAtBoot: 'ask' }, board,
    resumeDecision: () => 'dismiss',
  }));
  assert.deepEqual(kinds(no), ['skip'], 'a declined question is not a job for the inbox');
  assert.match(skipWhy(no), /declined to pick this run up/);

  const off = planConvergence(facts({
    runs: [killed()], prefs: { resumeAtBoot: 'off' }, board,
  }));
  assert.deepEqual(kinds(off), ['errand'], 'the standing policy still writes one');
});

test('planner: the RUN\'s own resumeOnRestart decides the boot relaunch — true relaunches, false writes the errand, only a run with neither asks (ZTD-8)', async () => {
  const killed = (over: Record<string, unknown> = {}) => run({
    status: 'interrupted', stoppedBy: 'system', ...over,
    phases: {
      1: { phase: 1, status: 'done', attempts: 1, costUsd: 0 },
      2: {
        phase: 2, status: 'interrupted', attempts: 1, costUsd: 0,
        note: consoleStoppedNote(2), sessionId: 'sess-2', resumeSessionId: 'sess-2',
      },
    },
  });
  const board = { 1: 'done', 2: 'in-progress', 3: 'waiting' };
  // The console says `ask`; the run said `continue` at its door — no question, no errand, a relaunch.
  const yes = planConvergence(facts({ runs: [killed({ resumeOnRestart: true })], prefs: { resumeAtBoot: 'ask' }, board }));
  assert.deepEqual(kinds(yes), ['relaunch']);
  assert.ok(!kinds(yes).includes('await-decision'));
  // The run said `hold`, and the console's `auto` does not overrule it: the errand names the run's own word.
  const no = planConvergence(facts({ runs: [killed({ resumeOnRestart: false })], prefs: { resumeAtBoot: 'auto' }, board }));
  assert.deepEqual(kinds(no), ['errand']);
  const [errand] = no.actions as [{ kind: string; errand: { need: string; how: string; decisionKey?: string }; why: string }];
  assert.match(errand.why, /launched with resume-on-restart off/);
  assert.match(errand.errand.need, /this run was launched with resume-on-restart off/);
  assert.doesNotMatch(errand.errand.how, /Resume at boot on/, 'the console setting is not the remedy for the run\'s own answer');
  assert.equal(errand.errand.decisionKey, 'resume.on-restart');
  // A person's `continue` on the boot card still outranks a stored `false` — the card is answered per boot.
  const pressed = planConvergence(facts({
    runs: [killed({ resumeOnRestart: false })], prefs: { resumeAtBoot: 'auto' }, board, resumeDecision: () => 'continue',
  }));
  assert.deepEqual(kinds(pressed), ['relaunch']);
  // A run carrying neither (before the field existed) falls through to the console's word — the ask.
  const neither = planConvergence(facts({ runs: [killed()], prefs: { resumeAtBoot: 'ask' }, board }));
  assert.deepEqual(kinds(neither), ['await-decision']);
  // The same three answers on the wait-clock path (an armed wait whose clock
  // went by while nothing ran, past the grace).
  const late = (over: Partial<RunState> = {}) => overdue(WAIT_OVERDUE_GRACE_MS + 10 * 60_000, over);
  assert.equal(waitClockVerdict(late({ resumeOnRestart: true }), facts({ prefs: { resumeAtBoot: 'ask' } })).verdict, 'resume');
  const waitOff = waitClockVerdict(late({ resumeOnRestart: false }), facts({ prefs: { resumeAtBoot: 'auto' } }));
  assert.equal(waitOff.verdict, 'errand');
  assert.match(waitOff.why, /launched with resume-on-restart off/);
  assert.equal(waitClockVerdict(late(), facts({ prefs: { resumeAtBoot: 'ask' } })).verdict, 'ask');
  // And the executor: a run that answered `true` journals its relaunch and never `run.resume-asked`.
  const state = killed({ resumeOnRestart: true });
  const deps = stubDeps(state, { prefs: () => ({ resumeAtBoot: 'ask' }) });
  await executeConvergence(yes, deps as never);
  assert.equal(deps.started.length, 1, 'relaunched');
  assert.ok(!deps.lines.some((l) => l.event === 'run.resume-asked'), 'nobody was asked');
});

test('planner: a stored boolean `true` reads as ask, not as auto', () => {
  // The migration that matters. `true` was the only value that resumed at all,
  // so every console that wanted resuming has it — reading it as `auto` would
  // keep the surprise for exactly the installs that reported it.
  const killed = run({
    status: 'interrupted', stoppedBy: 'system',
    phases: {
      1: { phase: 1, status: 'done', attempts: 1, costUsd: 0 },
      2: { phase: 2, status: 'interrupted', attempts: 1, costUsd: 0, note: consoleStoppedNote(2) },
    },
  });
  const plan = planConvergence(facts({
    runs: [killed], prefs: { resumeAtBoot: true },
    board: { 1: 'done', 2: 'in-progress', 3: 'waiting' },
  }));
  assert.deepEqual(kinds(plan), ['await-decision']);
});

test('executor: an await-decision registers the question and journals it, launching nothing', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    handoff(root, 1, 'schema', 'complete');
    const state = newRun({ slug: 'alpha', root, autoRecover: true });
    state.status = 'interrupted';
    state.stoppedBy = 'system';
    const two = phaseRecord(state, 2);
    two.status = 'interrupted';
    two.note = consoleStoppedNote(2);
    two.sessionId = 'sess-2';
    saveRun(state);

    const started: unknown[] = [];
    const svc = service(root, {}, (s) => {
      s.prefs.resumeAtBoot = 'ask';
      (s as never as { startRun: (slug: string, o: unknown) => Promise<unknown> }).startRun =
        async (slug: string, options: unknown) => { started.push({ slug, options }); return null; };
    });
    try {
      // `service()` sets `auto`; the mutator above puts it back to the shipped
      // default before the root is opened and the boot pass runs.
      await settle(svc);
      assert.deepEqual(started, [], 'the question launched something');
      const asks = [...svc.resumeAsks.values()];
      assert.equal(asks.length, 1);
      assert.equal(asks[0].slug, 'alpha');
      assert.deepEqual(asks[0].phases, [2]);
      const events = journalEvents(root, state.id);
      assert.ok(events.some((e) => e.event === 'run.resume-asked'));
      // The run file is untouched: the question is about this console boot, and
      // a run that recorded "somebody was asked" would still say so after the
      // restart that makes the question new again.
      const disk = loadRun(root, 'alpha', state.id, null)!;
      assert.equal(disk.errand, undefined);
      assert.equal(disk.recoveries?.['2']?.bootResumes ?? 0, 0);
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('executor: an errand that already stands is not rewritten, journalled or announced again — its clock survives the sweep', async () => {
  // Measured: one manual gate written 51 times in a day, one declared blocker
  // 16 times in five hours, each rewrite a fresh `at` and — because the
  // announcer keys on `at` — a fresh push. The ask stands with the clock it
  // was first written on; the pass records that it looked and found nothing.
  const off = run({ status: 'interrupted', stoppedBy: 'system' }, [{ phase: 2, status: 'interrupted', note: consoleStoppedNote(2) }]);
  const announced: unknown[] = [];
  const deps = stubDeps(off, {
    prefs: () => ({ resumeAtBoot: 'off' }),
    announceErrand: (...args: unknown[]) => { announced.push(args); },
  });
  const plan = () => planConvergence(facts({ runs: [off], prefs: { resumeAtBoot: 'off' }, board: { 1: 'done', 2: 'in-progress', 3: 'waiting' } }));
  const first = await executeConvergence(plan(), deps);
  assert.equal(first.errands.length, 1);
  const standing = off.recoveries?.['2']?.errand;
  assert.ok(standing, 'the first pass writes the errand');
  const firstAt = standing!.at;
  assert.equal(deps.lines.filter((l) => l.event === 'phase.errand').length, 1);
  assert.equal(announced.length, 1);

  // The next sweep, a minute later, derives the same ask.
  const later = stubDeps(off, {
    prefs: () => ({ resumeAtBoot: 'off' }),
    now: () => NOW + 60_000,
    announceErrand: (...args: unknown[]) => { announced.push(args); },
  });
  const second = await executeConvergence(plan(), later);
  assert.equal(second.errands.length, 0, 'nothing new to ask');
  assert.equal(off.recoveries?.['2']?.errand?.at, firstAt, 'the errand keeps the clock it was first written on');
  assert.equal(later.lines.filter((l) => l.event === 'phase.errand').length, 0, 'no second journal line');
  assert.equal(announced.length, 1, 'no second push');
  const outcome = second.outcomes.find((o) => o.action.kind === 'errand');
  assert.match(outcome?.detail ?? '', /has stood since/);
  assert.equal(outcome?.ok, true);

  // A DIFFERENT ask is news and is written: the operator turns resume-at-boot
  // back on, the lane has already been resumed the maximum number of times,
  // and the planner's errand is now the capped one, not the switched-off one.
  off.recoveries!['2'].bootResumes = MAX_BOOT_RESUMES;
  const capped = planConvergence(facts({ runs: [off], prefs: { resumeAtBoot: 'auto' }, board: { 1: 'done', 2: 'in-progress', 3: 'waiting' } }));
  const third = await executeConvergence(capped, stubDeps(off, { prefs: () => ({ resumeAtBoot: 'auto' }), now: () => NOW + 120_000 }));
  assert.equal(third.errands.length, 1, 'a changed ask is written again');
  assert.match(off.recoveries?.['2']?.errand?.need ?? '', /restarts in a row/);
});

/* ------------------------------------------------------------------ *
 * zero-touch-console phase 5: one wait predicate, one gate, one counter
 * ------------------------------------------------------------------ */

const { waitClockVerdict, automaticResumeGate } = await import('../server/converge.ts');

/** A run a restart left sleeping on a wait clock that went by `lateMs` ago. */
function overdue(lateMs: number, over: Partial<RunState> = {}): RunState {
  const until = new Date(NOW - lateMs).toISOString();
  return run({ status: 'paused', stoppedBy: 'system', waitReason: 'external', waitUntil: until, ...over },
    [{ phase: 2, status: 'waiting', parkedUntil: until, sessionId: 'sess-w', resumeSessionId: 'sess-w' }]);
}

test('LFC-7: with ask and no decision, an armed wait whose clock has passed registers the question and launches nothing', () => {
  const late = overdue(WAIT_OVERDUE_GRACE_MS + 10 * 60_000);
  const asked = planConvergence(facts({ runs: [late], prefs: { resumeAtBoot: 'ask' } }));
  assert.deepEqual(kinds(asked), ['await-decision']);
  const ask = asked.actions[0] as { phases: number[]; sessions: string[] };
  assert.deepEqual(ask.phases, [2]);
  assert.deepEqual(ask.sessions, ['sess-w']);
  // Answered: continue relaunches as a RULED wait, and the answer is spent by it.
  const yes = planConvergence(facts({ runs: [late], prefs: { resumeAtBoot: 'ask' }, resumeDecision: () => 'continue' }));
  assert.deepEqual(kinds(yes), ['relaunch']);
  const relaunch = yes.actions[0];
  assert.ok(relaunch.kind === 'relaunch' && relaunch.wait && relaunch.decided === true);
  assert.deepEqual(relaunch.kind === 'relaunch' && relaunch.wait?.phases, [2]);
  assert.match(skipWhy(planConvergence(facts({ runs: [late], prefs: { resumeAtBoot: 'ask' }, resumeDecision: () => 'dismiss' }))), /declined/);
  assert.deepEqual(kinds(planConvergence(facts({ runs: [late], prefs: { resumeAtBoot: 'off' } }))), ['errand']);
  // Inside the grace the armed timer still owns it — no question, no launch.
  assert.deepEqual(kinds(planConvergence(facts({ runs: [overdue(WAIT_OVERDUE_GRACE_MS - 5_000)], prefs: { resumeAtBoot: 'ask' } }))), ['skip']);
});

test('SLF-6: an operator-stopped run with a past waitUntil is held by ONE predicate — the boot and the loop give the same why', async () => {
  const stopped = overdue(3 * 60 * 60_000, { stoppedBy: 'operator' });
  const verdict = waitClockVerdict(stopped, { now: NOW, prefs: { resumeAtBoot: 'auto' } });
  assert.equal(verdict.verdict, 'hold');
  const why = verdict.verdict === 'hold' ? verdict.why : '';
  assert.match(why, /operator stopped it/);
  assert.equal(skipWhy(planConvergence(facts({ runs: [stopped] }))), why, 'the loop answers in the same words');

  // …and the boot's re-adoption, through the real service: nothing armed, nothing started.
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    const state = newRun({ slug: 'alpha', root });
    state.status = 'paused';
    state.stoppedBy = 'operator';
    state.waitReason = 'external';
    state.waitUntil = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    phaseRecord(state, 2).status = 'waiting';
    saveRun(state);
    const started: unknown[] = [];
    const svc = service(root, { converge: false }, (s) => {
      (s as never as { startRun: (slug: string, o: unknown) => Promise<unknown> }).startRun = async (slug, o) => { started.push({ slug, o }); return null; };
    });
    try {
      await svc.bootSettled;
      const timers = (svc as unknown as { limitResumeTimers: Map<string, unknown> }).limitResumeTimers;
      assert.equal(timers.has('alpha'), false, 'the boot no longer arms a clock the operator stopped');
      assert.deepEqual(started, []);
      const held = waitClockVerdict(loadRun(root, 'alpha', state.id, null)!, { now: Date.now(), prefs: svc.prefs });
      assert.equal(held.verdict === 'hold' && held.why, why, 'the boot reads the same predicate, so the same why');
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('LFC-7: the one gate — restart-caused resumes answer to resume-at-boot, every path is counted, and the count binds across triggers', () => {
  assert.equal(automaticResumeGate({ prefs: { resumeAtBoot: 'ask' }, decision: null, restartCaused: true, count: 0 }), 'ask');
  assert.equal(automaticResumeGate({ prefs: { resumeAtBoot: 'ask' }, decision: null, restartCaused: false, count: 0 }), 'proceed',
    'a live console\'s own resume is not asked about — that would stop every declared wait for a person');
  assert.equal(automaticResumeGate({ prefs: { resumeAtBoot: 'auto' }, decision: null, restartCaused: false, count: MAX_BOOT_RESUMES }), 'capped');
  assert.equal(automaticResumeGate({ prefs: { resumeAtBoot: 'off' }, decision: 'continue', restartCaused: true, count: 0 }), 'proceed');

  // A lock-cap re-arm is counted, and at the bound it is an errand — whatever woke the loop.
  // The session-cap park's own sentence (the fixture beside D28/P8), so this is
  // the re-arm path for real and not a fixture the planner ignores.
  const rearmed = (count: number) => run({
    status: 'parked', stoppedBy: 'system', halt: { at: '', reason: 'nothing left to run on its own — phase 2 is parked' },
    recoveries: { 2: { attempts: 0, lastAt: '', bootResumes: count } },
  }, [{ phase: 2, status: 'parked', note: 'phase 2 is held by 3 of 3 lanes (session cap) and has waited 121 minutes for it', resumeSessionId: 'sess-2' }]);
  for (const trigger of ['timer', 'change', 'halt'] as const) {
    const under = planConvergence(facts({ runs: [rearmed(1)], trigger, laneFree: () => true }));
    const relaunch = under.actions.find((a) => a.kind === 'relaunch');
    assert.ok(relaunch && relaunch.kind === 'relaunch' && relaunch.rearm.includes(2), `${trigger}: ${kinds(under).join(', ')}`);
    assert.deepEqual(relaunch.counted?.map((c) => [c.phase, c.path]), [[2, 'rearm']], trigger);
    const capped = planConvergence(facts({ runs: [rearmed(MAX_BOOT_RESUMES)], trigger, laneFree: () => true }));
    assert.deepEqual(kinds(capped), ['errand'], `${trigger}: the bound holds on every trigger`);
  }
});

test('LFC-7: a shutdown between lanes counts the checkpointed resume, and the executor journals every automatic resume with its trigger and path', async () => {
  const stopped = run({ status: 'paused', stoppedBy: 'system' }, [
    { phase: 1, status: 'done' },
    { phase: 2, status: 'pending', sessionId: 'sess-2', resumeSessionId: 'sess-2' },
  ]);
  const plan = planConvergence(facts({ runs: [stopped], trigger: 'boot', board: { 1: 'done', 2: 'ready', 3: 'waiting' } }));
  const relaunch = plan.actions.find((a) => a.kind === 'relaunch');
  assert.ok(relaunch && relaunch.kind === 'relaunch');
  assert.deepEqual(relaunch.counted, [{ phase: 2, path: 'system-stop', sessionId: 'sess-2' }]);
  const deps = stubDeps(stopped);
  await executeConvergence(plan, deps);
  const automatic = deps.lines.filter((l) => l.event === 'phase.resume-automatic');
  assert.equal(automatic.length, 1);
  assert.deepEqual([automatic[0].phase, automatic[0].data.path, automatic[0].data.trigger, automatic[0].data.count], [2, 'system-stop', 'boot', 1]);
  assert.equal(stopped.recoveries?.['2']?.bootResumes, 1);
  // At the bound it stops being a relaunch.
  stopped.recoveries!['2'].bootResumes = MAX_BOOT_RESUMES;
  assert.deepEqual(kinds(planConvergence(facts({ runs: [stopped], trigger: 'timer', board: { 1: 'done', 2: 'ready', 3: 'waiting' } }))), ['errand']);
});

test('service: an answered continue relaunches end to end — the boot-resume answer reaches the planner, and is spent by the launch', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    handoff(root, 1, 'schema', 'complete');
    handoff(root, 2, 'cart-api', 'in-progress');
    const state = newRun({ slug: 'alpha', root, autoRecover: true });
    state.status = 'interrupted';
    state.stoppedBy = 'system';
    const two = phaseRecord(state, 2);
    two.status = 'interrupted';
    two.note = consoleStoppedNote(2);
    two.sessionId = 'sess-2';
    saveRun(state);
    const started: unknown[] = [];
    const svc = service(root, {}, (s) => {
      s.prefs.resumeAtBoot = 'ask';
      (s as never as { startRun: (slug: string, o: unknown) => Promise<unknown> }).startRun = async (slug, o) => { started.push({ slug, o }); return null; };
    });
    try {
      await settle(svc);
      assert.deepEqual(started, [], 'asked, nothing launched');
      assert.ok(svc.resumeAsks.has(state.id));
      // What POST /api/boot-resume {decision: continue} does: record the answer, then press.
      svc.resumeDecisions.set(state.id, 'continue');
      await svc.convergeNow('alpha', 'button');
      assert.equal(started.length, 1, 'the answer used to be dropped before the planner, and continue launched nothing');
      assert.equal(svc.resumeDecisions.has(state.id), false, 'spent by the launch it authorised — the next restart asks again');
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('WAI-6: an overdue park is announced ONCE — on the inbox row\'s own condition, stamped on the record, silent after a restart', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    const announced: { title: string; phase?: number }[] = [];
    const capture = (svc: InstanceType<typeof Service>) => {
      (svc as never as { announce: (c: string, m: { title: string }, ctx: { phase?: number }) => null }).announce =
        (_category, message, ctx) => { announced.push({ title: message.title, phase: ctx.phase }); return null; };
    };
    // A read-only console: `allowRun` off, so nothing will ever fire this clock
    // — exactly the console whose overdue parks are worth a phone's attention.
    const svc = service(root, { allowRun: false }, capture);
    try {
      await settle(svc);
      const past = new Date(Date.now() - 15 * 60_000).toISOString();
      const state = newRun({ slug: 'alpha', root });
      state.status = 'paused';
      state.stoppedBy = 'system';
      state.waitUntil = past;
      state.waitReason = 'external';
      const record = phaseRecord(state, 1);
      record.status = 'waiting';
      record.parkedUntil = past;
      record.declared = { status: 'waiting-external', reason: 'the image build', at: past };
      saveRun(state);

      await svc.convergeNow('alpha', 'timer');
      await svc.convergeNow('alpha', 'timer');
      const overdue = announced.filter((m) => /park is overdue/.test(m.title));
      assert.equal(overdue.length, 1, `announced once, not per pass (${announced.map((m) => m.title).join(', ')})`);
      assert.equal(overdue[0].phase, 1);
      const stored = loadRun(root, 'alpha', state.id)!;
      assert.equal(stored.phases[1].parkOverdueAnnouncedFor, past, 'the stamp rides the record');
      assert.equal(stored.phases[1].status, 'waiting', 'the console\'s own clock: settlement leaves it standing');
    } finally {
      await svc.close();
    }
    // A restart reads the stamp and says nothing more.
    announced.length = 0;
    const again = service(root, { allowRun: false }, capture);
    try {
      await settle(again);
      await again.convergeNow('alpha', 'timer');
      assert.equal(announced.filter((m) => /park is overdue/.test(m.title)).length, 0);
    } finally {
      await again.close();
    }
  } finally {
    cleanup();
  }
});

// ── S5-a — a live lane's lock read `ended` between its own attempts ──────────
// Two consoles on one root. Console B sees a lock owned `autopilot/<runId>`
// belonging to console A's run. `lockPresenceFor` demoted such a lock to
// `unknown` only when the run was one of THIS console's live runners — which it
// never is, from B's side. So B fell through to the raw registry, which answers
// about the session the lock NAMES; a lane's lock outlives its attempt's
// session by design, so the answer was `ended`, and `ended` means debris: B
// admitted over the claim and then released it.
//
// The fact that settles it is on disk: A's run file. If that run is in flight,
// somebody is holding this lock, whoever's console it is.
const { lockHeldByLiveRun } = await import('../server/converge.ts');

test('S5-a: a lock owned by a FOREIGN run that is in flight is held', () => {
  const foreign = run({ status: 'running' });
  assert.equal(
    lockHeldByLiveRun(`autopilot/${foreign.id}`, new Set(), [foreign], () => false), true,
    "another console's running run still holds its lane's lock");
});

test('S5-a: this console\'s own live run is held too, exactly as before', () => {
  const mine = run({ status: 'running' });
  assert.equal(lockHeldByLiveRun(`autopilot/${mine.id}`, new Set([mine.id]), [], () => false), true,
    'the live-runner set alone still answers, with no run file to read');
});

test('S5-a: a finished foreign run holds nothing', () => {
  const over = run({ status: 'finished' });
  assert.equal(lockHeldByLiveRun(`autopilot/${over.id}`, new Set(), [over], () => false), false);
});

test('S5-a: a stopped run whose child is still alive is held', () => {
  // `runIsDead`'s own rule, which is the point of reusing it rather than
  // writing a second opinion: a record can say `halted` while its process runs.
  const halted = run({ status: 'halted', children: [{ pid: 4242, phase: 1, startedAt: new Date().toISOString(), procStartedAt: 1 }] as never });
  assert.equal(lockHeldByLiveRun(`autopilot/${halted.id}`, new Set(), [halted], (pid) => pid === 4242), true);
  assert.equal(lockHeldByLiveRun(`autopilot/${halted.id}`, new Set(), [halted], () => false), false);
});

test('S5-a: an owner that is not an autopilot lane holds nothing here', () => {
  // A person's lock is the registry's question, not this one's.
  const live = run({ status: 'running' });
  assert.equal(lockHeldByLiveRun('sam@mac', new Set([live.id]), [live], () => false), false);
  assert.equal(lockHeldByLiveRun(`autopilot/${live.id}`, new Set(), [], () => false), false,
    'and a run nobody can find is not evidence of anything');
});


/* ── G-PIN12 — the seven mutation-proved pins from the phase-12 QA report ─────
 * `console-parallel-repaint` phase 12's QA round found five arms the phase had
 * changed with no test that bites: reverting each left the phase's own suites
 * green. QA wrote the pins, mutation-proved every one of them RED against the
 * committed code — and did not commit them, because a QA round's job is the
 * verdict. They have sat in an appendix ever since, which is the same as not
 * existing: the arms are unguarded and the next refactor takes them silently.
 * Adopted here verbatim in intent, adjusted only where this tree's helpers
 * have moved on. */
test('P12-QA executor: a RUN-level standing errand (no phase behind it) keeps its clock across sweeps too', async () => {
  const off = run({ status: 'interrupted', stoppedBy: 'system' }, []);
  const announced: unknown[] = [];
  const mk = (now: number) => stubDeps(off, {
    prefs: () => ({ resumeAtBoot: 'off' }), now: () => now,
    announceErrand: (...args: unknown[]) => { announced.push(args); },
  });
  const plan = (now: number) => planConvergence(facts({ now, runs: [off], prefs: { resumeAtBoot: 'off' }, board: { 1: 'done', 2: 'ready', 3: 'waiting' } }));
  const first = await executeConvergence(plan(NOW), mk(NOW));
  assert.equal(first.errands.length, 1, 'the run-level errand is written');
  assert.ok(off.errand, 'on the run, not a phase');
  const firstAt = off.errand!.at;
  assert.equal(announced.length, 1);

  const later = mk(NOW + 60_000);
  const second = await executeConvergence(plan(NOW + 60_000), later);
  assert.equal(second.errands.length, 0, 'nothing new to ask');
  assert.equal(off.errand!.at, firstAt, 'the clock survives');
  assert.equal(later.lines.filter((l) => l.event === 'run.errand').length, 0, 'no second journal line');
  assert.equal(announced.length, 1, 'no second push');
  const outcome = second.outcomes.find((o) => o.action.kind === 'errand');
  assert.match(outcome?.detail ?? '', /has stood since/);
});

// ── PRS-1 — the must-not-fire case ───────────────────────────────────────────
// `/clear` fires SessionEnd for a process that is still in front of the
// operator. `presenceOf` used to answer `ended` outright for any record with an
// `endedAt`, and `ended` is the ONE answer that makes a foreign lock debris:
// converge released it, boarding started a second session in the same working
// tree, and the first one was still typing.
//
// The rule now asks the pid and answers `unknown` when the two witnesses
// disagree. This is the half of that rule converge owns — `unknown` must
// release NOTHING. Written as a must-not-fire because the failure was silent:
// the lock simply vanished, and the release looked exactly like every correct
// one beside it.
test('PRS-1: a cleared session\'s lock (endedAt, process alive ⇒ unknown) is never released as debris', () => {
  const r = run({ status: 'halted', halt: { at: '', reason: 'x' } }, [{ phase: 2, status: 'failed' }]);
  const locks: LockView[] = [
    // The cleared session: the hook said ended, the pid says otherwise.
    { slug: 'alpha', phase: 2, owner: 'sam@laptop', expired: false, leaseUntil: NOW + 3_600_000, session: 'cleared-1' },
    // A genuinely finished one beside it, so the test proves the rule NARROWS
    // rather than simply switching debris collection off.
    { slug: 'alpha', phase: 3, owner: 'sam@laptop', expired: false, leaseUntil: NOW + 3_600_000, session: 'ended-1' },
  ];
  const presence = (lock: LockView) => (lock.session === 'cleared-1' ? 'unknown' : 'ended');

  assert.deepEqual(endedSessionLocks(locks, new Set(), presence).map((l) => l.phase), [3],
    'only the session the registry can prove has ended');

  const plan = planConvergence(facts({ runs: [r], locks, presence }));
  const debris = plan.actions.filter((a) => a.kind === 'release-debris');
  assert.deepEqual(debris.map((a) => a.kind === 'release-debris' && a.phase), [3],
    'converge releases nothing for the cleared session');
  assert.equal(debris.some((a) => a.kind === 'release-debris' && a.session === 'cleared-1'), false,
    'and names it nowhere');
});
