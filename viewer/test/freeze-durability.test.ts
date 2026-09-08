/**
 * A freeze the console PROMISED to escalate is escalated — across a restart.
 *
 * `state.freeze.escalateAt` is persisted and drawn on the lane card as a
 * commitment ("left frozen past 18:11 it converts to a checkpoint"), but until
 * this phase the only thing keeping it was an `unref`ed `setTimeout` inside the
 * Runner. A console that went away retracted the promise in silence, and the
 * frozen child — a freeze leaves it SIGSTOPped, holding its memory and its
 * working tree — stayed stopped with nothing pointing at it. That is the
 * incident this whole plan closes, in miniature.
 *
 * Pinned here:
 *  - the RULING (`freezeVerdict`): overdue ⇒ escalate, future ⇒ re-arm for the
 *    remainder, unreadable ⇒ leave the operator's freeze standing;
 *  - the cold escalation (`escalatePersistedFreeze`) wakes before it terminates
 *    — the SIGCONT that the incident's shutdown omitted — and leaves a record
 *    Continue can resume;
 *  - `Runner.start()` RULES on an inherited freeze instead of erasing it;
 *  - the service's fourth boot clock does both, on a run nobody is driving.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { newRun, phaseRecord, saveRun, loadRun, journalFile, IN_FLIGHT } = await import('../server/runner/state.ts');
const {
  FREEZE_ESCALATE_MS, checkpointFrozenRecord, escalatePersistedFreeze, freezeVerdict, frozenEntries,
  runFreezeVerdict,
} = await import('../server/runner/freeze.ts');
const { writeFleetHold, clearFleetHold } = await import('../server/fleet-hold.ts');
type RunState = import('../server/runner/state.ts').RunState;

const SCRIPTS = join(SKILL_DIR, 'scripts');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PLAN = `---
slug: alpha
created: 2026-08-23
status: active
phases: 2
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | api | 1 | — | app | it still works |

## Phases

### Phase 1 — schema
- **Size:** S
- **Verification:** \`true\`

### Phase 2 — api
- **Size:** S
- **Verification:** \`true\`
`;

const OPEN: Array<{ close: () => void }> = [];
const CHILDREN: number[] = [];

/**
 * A real, live, throwaway child to stand in for a frozen session.
 *
 * A live pid is not a nicety here, it is the whole test: `reconcileRun` already
 * rules correctly on a freeze whose child is GONE (it settles the record and
 * clears the slot before anything else looks), so a fake pid would exercise the
 * path that was never broken. The incident's child was very much alive — that
 * is the branch `reconcileRun` PARKS with an `orphaned-session` halt, keeping
 * `state.freeze`, and the one this phase's boot clock is here to finish.
 *
 * `detached` so it leads its own process group: the kill ladder signals the
 * GROUP (P1), and an attached child would put the test runner in it.
 */
function liveChild(): number {
  const child = spawn('sleep', ['45'], { detached: true, stdio: 'ignore' });
  child.unref();
  CHILDREN.push(child.pid!);
  return child.pid!;
}

/**
 * What `ps` says about a process: `T` is stopped, `S`/`R` are running.
 *
 * The kernel's answer, not the record's. Every claim in this file about a
 * frozen or woken child is worth exactly as much as the thing that asked, and
 * a record that says "frozen" is the one thing that cannot be evidence for it.
 */
function procState(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' }).trim().slice(0, 1);
  } catch { return ''; }
}

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-freeze-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return {
    root,
    cleanup: () => {
      for (const svc of OPEN.splice(0)) svc.close();
      for (const pid of CHILDREN.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * A run frozen on phase 1, whose escalation deadline is `minutesFromNow` away
 * — negative for a deadline that passed while no console was running.
 *
 * `pid` is `process.pid` by default and that is deliberate, not lazy: the cold
 * escalation asks the probe whether the child is still there, and only a pid
 * somebody actually has can answer "yes". (Same trap `withProbe()` in
 * `settle-matrix.test.ts` encapsulates for the P3/P4 work.)
 */
function frozenRun(root: string, minutesFromNow: number, pid = process.pid): RunState {
  const state = newRun({ slug: 'alpha', root });
  state.status = 'frozen';
  const record = phaseRecord(state, 1);
  record.status = 'running';
  record.sessionId = 'sess-frozen-1';
  state.child = { pid, phase: 1, startedAt: new Date().toISOString() } as never;
  state.freeze = {
    at: new Date(Date.now() - 20 * 60_000).toISOString(),
    phase: 1,
    pid,
    by: 'console',
    escalateAt: new Date(Date.now() + minutesFromNow * 60_000).toISOString(),
  };
  saveRun(state);
  return state;
}

/** A service with the restart stubbed — before `open()`, because the boot pass arms inside it. */
function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: false,
    scriptsDir: SCRIPTS, logFile: null,
  } as never);
  const started: { slug: string; accountId?: string; resumeRunId?: string }[] = [];
  const s = svc as never as {
    startRun: (slug: string, options: Record<string, unknown>) => Promise<unknown>;
    freezeTimers: Map<string, unknown>;
  };
  s.startRun = async (slug, options) => {
    started.push({
      slug,
      accountId: options.accountId as string | undefined,
      resumeRunId: options.resumeRunId as string | undefined,
    });
    return null;
  };
  assert.equal(svc.open(root).ok, true);
  OPEN.push(svc);
  return { svc, started, timers: () => s.freezeTimers };
}

function journal(root: string, runId: string): { event: string; phase?: number; data: Record<string, unknown> }[] {
  const file = journalFile(root, 'alpha', runId);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/* ---------------- the ruling ---------------- */

test('freezeVerdict: overdue escalates, future re-arms for the REMAINDER, unreadable leaves it standing', () => {
  const now = 1_000_000;
  const at = (ms: number) => ({ at: '', phase: 1, pid: 1, by: 'console', escalateAt: new Date(ms).toISOString() });

  assert.deepEqual(freezeVerdict(at(now - 1), now), { kind: 'escalate' });
  assert.deepEqual(freezeVerdict(at(now), now), { kind: 'escalate' }, 'the deadline itself is due');
  assert.deepEqual(freezeVerdict(at(now + 60_000), now), { kind: 'rearm', inMs: 60_000, at: now + 60_000 });

  assert.deepEqual(freezeVerdict(null, now), { kind: 'none' });
  assert.deepEqual(freezeVerdict(undefined, now), { kind: 'none' });
  // A deadline nobody can read is NOT evidence that the deadline passed. The
  // cheapest failure is the one that leaves the operator's freeze in place.
  assert.deepEqual(
    freezeVerdict({ at: '', phase: 1, pid: 1, by: 'console', escalateAt: 'not a date' }, now),
    { kind: 'none' },
  );
});

test('checkpointFrozenRecord: one wording, and a session id Continue can resume', () => {
  const state = newRun({ slug: 'alpha', root: '/tmp' });
  const record = phaseRecord(state, 1);
  record.status = 'running';
  record.sessionId = 'sess-1';
  checkpointFrozenRecord(record);
  assert.equal(record.status, 'pending');
  assert.equal(record.resumeSessionId, 'sess-1', 'without this, Continue pays for every turn again');
  assert.match(record.note ?? '', /Continue resumes session sess-1/);
  assert.match(record.note ?? '', new RegExp(`frozen for ${Math.round(FREEZE_ESCALATE_MS / 60_000)} minutes`));

  // A session that never reported an id says so, rather than promising a
  // resume that would fail with "Session ID … is already in use".
  const anon = phaseRecord(state, 2);
  anon.status = 'running';
  checkpointFrozenRecord(anon);
  assert.equal(anon.resumeSessionId, undefined);
  assert.match(anon.note ?? '', /starts this phase again from its boot prompt/);
});

/* ---------------- the cold escalation ---------------- */

test('escalatePersistedFreeze WAKES before it terminates — the SIGCONT the shutdown omitted', () => {
  const { root, cleanup } = scratch();
  try {
    const state = frozenRun(root, -1);
    const killed: number[] = [];
    const [out, ...rest] = escalatePersistedFreeze(state, {
      probe: () => 'stopped',
      kill: (pid) => killed.push(pid),
    });

    assert.deepEqual(rest, [], 'one frozen child, one escalation');
    assert.equal(out!.escalated, true);
    assert.equal(out!.signalled, true, 'a stopped child is exactly the case the ladder exists for');
    assert.deepEqual(killed, [process.pid], 'the ladder was asked to end the child');
    assert.equal(out!.phase, 1);
    assert.equal(out!.sessionId, 'sess-frozen-1');

    assert.equal(state.freeze, null, 'the freeze has been RULED on');
    assert.equal(state.phases['1']!.status, 'pending');
    assert.equal(state.phases['1']!.resumeSessionId, 'sess-frozen-1');
    assert.equal(state.child, null, 'the mirror stops advertising a child that was just ended');
  } finally { cleanup(); }
});

test('escalatePersistedFreeze converts a freeze whose child is already GONE — no signal, same record', () => {
  const { root, cleanup } = scratch();
  try {
    const state = frozenRun(root, -1);
    const killed: number[] = [];
    const [out] = escalatePersistedFreeze(state, { probe: () => 'gone', kill: (pid) => killed.push(pid) });

    assert.equal(out!.escalated, true);
    assert.equal(out!.signalled, false, 'nothing to signal');
    assert.deepEqual(killed, [], 'and nothing was signalled');
    // The record still claimed to be in flight, which is the fact Continue
    // would otherwise trip over.
    assert.equal(state.phases['1']!.status, 'pending');
    assert.equal(state.freeze, null);
  } finally { cleanup(); }
});

/* ---------------- D14: several frozen children, one restart ---------------- */

/**
 * Two lanes frozen, then a restart — the case the single mirror slot could not
 * express.
 *
 * `state.freeze` holds ONE frozen phase (the lowest), and every reader on the
 * boot path used to read only that. So the second frozen child escalated
 * nowhere: its process stayed SIGSTOPped with no timer, no checkpoint and no
 * advice pointing at it, while its phase record went on claiming to be running
 * — which is the exact orphan shape the escalation exists to prevent, produced
 * by the escalation's own blind spot.
 */
function twoFrozenRun(root: string, minutesFromNow: number, pidA: number, pidB: number): RunState {
  const state = frozenRun(root, minutesFromNow, pidA);
  const second = phaseRecord(state, 2);
  second.status = 'running';
  second.sessionId = 'sess-frozen-2';
  const at = new Date(Date.now() - 20 * 60_000).toISOString();
  const escalateAt = new Date(Date.now() + minutesFromNow * 60_000).toISOString();
  state.children = {
    1: {
      pid: pidA, phase: 1, sessionId: 'sess-frozen-1', startedAt: at,
      frozen: { at, by: 'console', escalateAt },
    },
    2: {
      pid: pidB, phase: 2, sessionId: 'sess-frozen-2', startedAt: at,
      frozen: { at, by: 'console', escalateAt },
    },
  } as never;
  saveRun(state);
  return state;
}

test('frozenEntries: every frozen child, and the mirror slot is not counted twice', () => {
  const { root, cleanup } = scratch();
  try {
    const state = twoFrozenRun(root, -1, 4_242, 4_343);
    const entries = frozenEntries(state);

    assert.deepEqual(
      entries.map((entry) => entry.phase).sort(), [1, 2],
      'both frozen lanes, and the phase-1 mirror slot deduped against its own child',
    );
    assert.deepEqual(entries.map((entry) => entry.pid).sort(), [4_242, 4_343]);
  } finally { cleanup(); }
});

test('two frozen children escalate TOGETHER at the deadline — both signalled, both checkpointed', () => {
  const { root, cleanup } = scratch();
  try {
    const pidA = liveChild();
    const pidB = liveChild();
    const state = twoFrozenRun(root, -1, pidA, pidB);
    const killed: number[] = [];

    const out = escalatePersistedFreeze(state, {
      probe: () => 'stopped',
      kill: (pid) => killed.push(pid),
    });

    assert.equal(out.length, 2, 'one escalation per frozen child — this returned 1 before D14');
    assert.deepEqual(killed.sort(), [pidA, pidB].sort(), 'the ladder was asked to end BOTH');
    assert.deepEqual(
      out.map((one) => one.sessionId).sort(), ['sess-frozen-1', 'sess-frozen-2'],
      'each checkpoint keeps its OWN session id, or Continue re-runs it from the boot prompt',
    );

    // Both records converted, so neither phase is left claiming to be in flight.
    assert.equal(state.phases['1']!.status, 'pending');
    assert.equal(state.phases['2']!.status, 'pending');
    assert.equal(state.phases['1']!.resumeSessionId, 'sess-frozen-1');
    assert.equal(state.phases['2']!.resumeSessionId, 'sess-frozen-2');
    assert.equal(state.freeze, null, 'the run-level slot is ruled on last, once');
    assert.equal(state.children, undefined, 'neither child is advertised any more');
  } finally { cleanup(); }
});

test('runFreezeVerdict arms for the EARLIEST deadline, not the mirror slot"s', () => {
  const { root, cleanup } = scratch();
  try {
    // Phase 1 (the mirror) is 30 minutes out; phase 2 is due in 5. One timer per
    // run, so it must be phase 2's — arming for the slot let the earlier freeze
    // sit past its own deadline until the next restart.
    const state = twoFrozenRun(root, 30, 5_151, 5_252);
    state.children!['2']!.frozen = {
      at: new Date().toISOString(), by: 'console',
      escalateAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };

    const verdict = runFreezeVerdict(state, Date.now());
    assert.equal(verdict.kind, 'rearm');
    assert.ok(
      verdict.kind === 'rearm' && verdict.inMs <= 5 * 60_000 + 1_000,
      `expected the 5-minute deadline, got ${verdict.kind === 'rearm' ? verdict.inMs : verdict.kind}`,
    );

    // And one past due anywhere in the set makes the whole run due now.
    state.children!['2']!.frozen!.escalateAt = new Date(Date.now() - 1_000).toISOString();
    assert.deepEqual(runFreezeVerdict(state, Date.now()), { kind: 'escalate' });
  } finally { cleanup(); }
});

/* ---------------- Runner.start() rules rather than erases ---------------- */

test('start(): an inherited freeze is RULED on, not erased — the child is ended, the phase resumable', async () => {
  const { root, cleanup } = scratch();
  try {
    const state = frozenRun(root, -1, liveChild());
    const { Runner } = await import('../server/runner/runner.ts');
    const runner = new Runner({} as never);
    // Stop after the setup this test is about: `drive()` would spawn `claude`.
    (runner as never as { drive: () => Promise<void> }).drive = async () => {};
    await runner.start({ slug: 'alpha', root, resumeRunId: state.id } as never);

    const after = runner.current()!;
    assert.equal(after.freeze, null);
    assert.equal(after.phases['1']!.status, 'pending', 'the frozen phase is boardable again');
    assert.equal(after.phases['1']!.resumeSessionId, 'sess-frozen-1', 'and it resumes rather than restarts');

    const events = journal(root, state.id).filter((e) => e.event === 'run.freeze-escalated');
    assert.equal(events.length, 1, 'the ruling is journalled — and AFTER the journal exists to hold it');
    assert.equal(events[0]!.data.at, 'start');
    assert.equal(events[0]!.data.overdue, true);
    runner.close?.();
  } finally { cleanup(); }
});

/* ---------------- the fourth boot clock ---------------- */

test('boot: a freeze already past its deadline escalates on the boot pass, journalled and persisted', async () => {
  const { root, cleanup } = scratch();
  try {
    const run = frozenRun(root, -1, liveChild());
    const { svc } = service(root);
    await svc.bootSettled;
    const deadline = Date.now() + 3_000;
    while (loadRun(root, 'alpha', run.id, null)?.freeze && Date.now() < deadline) await sleep(20);

    const after = loadRun(root, 'alpha', run.id, null)!;
    assert.equal(after.freeze, null, 'the promise the card drew was kept');
    assert.equal(after.phases['1']!.status, 'pending');
    assert.equal(after.phases['1']!.resumeSessionId, 'sess-frozen-1');
    assert.equal(after.status, 'paused');
    assert.equal(after.stoppedBy, 'operator', 'the freeze was their act; its escalation is their stop');

    const events = journal(root, run.id).filter((e) => e.event === 'run.freeze-escalated');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.data.at, 'boot');
    assert.equal(events[0]!.data.phase, 1);
  } finally { cleanup(); }
});

test('boot: a freeze still inside its window is ARMED for the remainder, not escalated now', async () => {
  const { root, cleanup } = scratch();
  try {
    const run = frozenRun(root, 30, liveChild());
    const { svc, timers } = service(root);
    await svc.bootSettled;
    await sleep(50);

    const after = loadRun(root, 'alpha', run.id, null)!;
    assert.ok(after.freeze, 'a freeze with time left on it is left standing');
    assert.equal(after.phases['1']!.status, 'running', 'and its phase is untouched');
    assert.equal(timers().size, 1, 'a clock is armed for the remainder — not deferred to the next restart');
    assert.ok(timers().has(`alpha:${run.id}`));
  } finally { cleanup(); }
});

test('boot: a freeze whose child is GONE is reconcile\'s business, and the clock does not double-rule it', async () => {
  const { root, cleanup } = scratch();
  try {
    // The composition, pinned so neither half is later "fixed" into the other.
    // `reconcileRun` runs first and already settles this case — the child is
    // gone, so there is no process to wake and nothing to promise — and the
    // freeze slot is cleared before the boot clock ever reads it. The clock is
    // for the OTHER branch: the one where the child survived its console.
    const run = frozenRun(root, -1, 999_999_999);
    const { svc, timers } = service(root);
    await svc.bootSettled;
    await sleep(50);

    const after = loadRun(root, 'alpha', run.id, null)!;
    assert.equal(after.freeze, null);
    assert.equal(timers().size, 0, 'nothing was armed — there was nothing left to rule on');
    assert.equal(
      journal(root, run.id).filter((e) => e.event === 'run.freeze-escalated').length, 0,
      'and no second escalation was journalled for a freeze reconcile had already ended',
    );
  } finally { cleanup(); }
});

test('boot: a run with no freeze arms nothing', async () => {
  const { root, cleanup } = scratch();
  try {
    const state = newRun({ slug: 'alpha', root });
    state.status = 'interrupted';
    saveRun(state);
    const { svc, timers } = service(root);
    await svc.bootSettled;
    await sleep(50);
    assert.equal(timers().size, 0);
  } finally { cleanup(); }
});

/* ---------------- the FLEET freeze, across a restart ---------------- */

/**
 * A fleet freeze is the same promise as a lane freeze, one level up: it is on
 * disk precisely so that a console which dies, or a laptop that is closed, does
 * not quietly hand the fleet back.
 *
 * These boot from a marker a "previous" console left, and assert the expensive
 * half of exit criterion 2 — **nothing spawned**. `service()` stubs `startRun`
 * and records every call, so "nothing started" is a measurement rather than an
 * absence of evidence.
 */
test('boot: a console that starts under a standing fleet freeze re-adopts NOTHING', async () => {
  const { root, cleanup } = scratch();
  try {
    const state = newRun({ slug: 'alpha', root });
    state.status = 'queued';
    saveRun(state);
    writeFleetHold('mo', new Date(Date.now() - 60_000).toISOString());
    try {
      const { svc, started } = service(root);
      await svc.bootSettled;
      await sleep(50);
      assert.deepEqual(
        started, [],
        'a queued run re-adopted under a freeze is the freeze surviving the restart in name only',
      );
      assert.equal(svc.fleetState().frozen, true, 'and the console still knows it is frozen');
      assert.equal(svc.fleetState().by, 'mo', 'including who froze it, and when');
    } finally { clearFleetHold(); }
  } finally { cleanup(); }
});

test('boot: the same run with no marker IS re-adopted — the refusal is the freeze, not the shape', async () => {
  const { root, cleanup } = scratch();
  try {
    const state = newRun({ slug: 'alpha', root });
    state.status = 'queued';
    saveRun(state);
    clearFleetHold();
    const { svc, started } = service(root);
    await svc.bootSettled;
    await sleep(50);
    assert.deepEqual(started.map((s) => s.slug), ['alpha']);
  } finally { cleanup(); }
});

test('thaw: a wait whose moment passed during the freeze fires ONCE, at the thaw', async () => {
  const { root, cleanup } = scratch();
  try {
    const state = newRun({ slug: 'alpha', root });
    state.status = 'paused';
    // An hour ago: the moment passed while the console was frozen. Nothing
    // rewinds it — the run keeps `waitUntil` on disk, and the re-arm computes
    // a negative delay, which `setTimeout` runs on the next tick.
    state.waitUntil = new Date(Date.now() - 60 * 60_000).toISOString();
    phaseRecord(state, 1).status = 'waiting';
    saveRun(state);
    writeFleetHold('mo');
    const { svc, started } = service(root);
    try {
      await svc.bootSettled;
      await sleep(50);
      assert.deepEqual(started, [], 'the overdue wait is held — not fired, and not lost');
    } finally { /* the thaw removes the marker itself */ }
    await svc.thawFleet('mo');
    await sleep(80);
    assert.deepEqual(started.map((s) => s.slug), ['alpha'], 'exactly one resume, at the thaw');
    assert.equal(svc.fleetState().frozen, false);
  } finally { clearFleetHold(); cleanup(); }
});

/**
 * The verbs themselves: freeze-all and thaw-all over a pool of live runs.
 *
 * Stand-in runners rather than real ones, and deliberately: `Runner.freeze`'s
 * own behaviour — the SIGSTOP, the standing record, no timer — is pinned
 * against a real child in `runner.test.ts`. What is at stake HERE is the
 * fleet-level contract those runners are driven by, and there are four claims
 * in it: the marker goes down BEFORE any lane is signalled, every live run is
 * asked (not just the first), the ask is the STANDING form, and freezing a
 * frozen console is refused rather than silently re-stamped.
 */
function fakeRunner(slug: string, log: string[]) {
  return {
    current: () => ({ slug }),
    // `liveRunners()` is the pool filtered by this — a runner whose loop has
    // ended is not something to signal.
    busy: () => true,
    freeze: (by: string, phase: number | undefined, opts?: { standing?: boolean }) => {
      log.push(`freeze:${slug}:${by}:${phase === undefined ? 'all' : phase}:${opts?.standing ? 'standing' : 'clocked'}`);
      return true;
    },
    thaw: () => { log.push(`thaw:${slug}`); return true; },
  };
}

/**
 * A per-run Freeze pressed WHILE the console is frozen is standing too.
 *
 * The third way round to the same defect, and the last one: `freezeRun` passed
 * no options, so a lane frozen by the run controls during a fleet freeze got
 * the ordinary fifteen-minute clock — an armed `killLadder` inside a freeze the
 * banner calls standing. The operator has not asked for two kinds of freeze;
 * they have asked for one, twice.
 */
test('freezeRun during a fleet freeze writes the standing form, not a fifteen-minute clock', async () => {
  const { root, cleanup } = scratch();
  try {
    clearFleetHold();
    const { svc } = service(root);
    await svc.bootSettled;
    const asked: (boolean | undefined)[] = [];
    const pool = (svc as never as { runners: Map<string, unknown> }).runners;
    pool.set('alpha', {
      current: () => ({ slug: 'alpha' }),
      busy: () => true,
      phaseMismatch: () => null,
      freeze: (_by: string, _phase: number | undefined, opts?: { standing?: boolean }) => {
        asked.push(opts?.standing);
        return true;
      },
      thaw: () => true,
    });

    assert.equal(svc.freezeRun('alpha', 'mo').ok, true);
    assert.equal(asked[0], undefined, 'an ordinary console freezes a run the ordinary way');

    svc.freezeFleet('mo');
    assert.equal(svc.freezeRun('alpha', 'mo').ok, true);
    assert.equal(
      asked[2], true,
      'but under a fleet freeze it is standing — otherwise this one lane carries a clock that '
      + 'kills it fifteen minutes into a freeze nothing else can end',
    );
  } finally { clearFleetHold(); cleanup(); }
});

test('freezeFleet: the marker lands FIRST, then every live run, in the standing form', async () => {
  const { root, cleanup } = scratch();
  try {
    clearFleetHold();
    const { svc } = service(root);
    await svc.bootSettled;
    const log: string[] = [];
    const pool = (svc as never as { runners: Map<string, unknown> }).runners;
    // The freeze verb reads the marker on its way past each runner, so a
    // stand-in that asks is how "the marker is down before any lane is
    // signalled" becomes a measurement rather than a reading of the source.
    const seen: boolean[] = [];
    for (const slug of ['alpha', 'beta']) {
      const fake = fakeRunner(slug, log) as never as { freeze: unknown };
      const inner = fake.freeze as (by: string, phase: number | undefined, opts?: { standing?: boolean }) => boolean;
      (fake as { freeze: unknown }).freeze = (by: string, phase: number | undefined, opts?: { standing?: boolean }) => {
        seen.push(svc.fleetState().frozen);
        return inner(by, phase, opts);
      };
      pool.set(slug, fake);
    }

    const outcome = svc.freezeFleet('mo');
    assert.equal(outcome.ok, true);
    assert.equal(outcome.runs, 2, 'every live run, not just the first');
    assert.deepEqual(
      log,
      ['freeze:alpha:mo:all:standing', 'freeze:beta:mo:all:standing'],
      'every lane of every run, and with no deadline on any of them',
    );
    assert.deepEqual(
      seen, [true, true],
      'the marker is down before the first SIGSTOP — a queue entry admitted between the first '
      + 'and the last would be a session started by the act of stopping',
    );
    assert.equal(svc.fleetState().frozen, true);
    assert.equal(svc.fleetState().by, 'mo');

    const again = svc.freezeFleet('someone else');
    assert.equal(again.ok, false, 'freezing a frozen console is refused…');
    assert.equal(svc.fleetState().by, 'mo', '…and does not re-stamp who froze it, or when');

    log.length = 0;
    const thawed = await svc.thawFleet('mo');
    assert.equal(thawed.ok, true);
    assert.deepEqual(log, ['thaw:alpha', 'thaw:beta'], 'and the undo reaches every one of them');
    assert.equal(svc.fleetState().frozen, false);

    const twice = await svc.thawFleet('mo');
    assert.equal(twice.ok, false, 'thawing a console nobody froze says so rather than pretending');
  } finally { clearFleetHold(); cleanup(); }
});

/**
 * Freeze-all stands a STORED clocked freeze down too.
 *
 * The live half is `Runner.freeze(…, {standing})`; this is the same conversion
 * for a run no live runner owns, and it exists because a console restarted over
 * a clocked freeze arms a boot timer for it. QA round 3 found the fix shipped
 * with no coverage at all: the whole method could be replaced with `return 0`
 * and the suite stayed green, which is the same failure mode as a registry row
 * that pins a gate's text.
 *
 * The deadline must leave the RECORD, not merely the timer — the boot clock
 * reads the record, so a timer dropped without the write is re-armed by the
 * next restart.
 */
test('freezeFleet stands down a clocked freeze on a run nobody is driving', async () => {
  const { root, cleanup } = scratch();
  try {
    clearFleetHold();
    const run = frozenRun(root, 30, liveChild());
    assert.ok(loadRun(root, 'alpha', run.id, null)!.freeze!.escalateAt, 'it starts on a clock');

    const { svc } = service(root);
    await svc.bootSettled;
    const outcome = svc.freezeFleet('mo');
    assert.equal(outcome.ok, true);

    const after = loadRun(root, 'alpha', run.id, null)!;
    assert.ok(after.freeze, 'the freeze itself stands — this converts it, it does not clear it');
    assert.equal(
      after.freeze!.escalateAt, undefined,
      'and the deadline is gone from the RECORD, which is what the boot clock reads',
    );
    assert.equal(
      runFreezeVerdict(after, Date.now() + 60 * 60_000).kind, 'none',
      'an hour later there is still nothing owed — that is what standing means',
    );
  } finally { clearFleetHold(); cleanup(); }
});

/**
 * The boot escalation obeys a fleet freeze — the OTHER rail of the same defect.
 *
 * The standing conversion fixes a live lane. This is the restart case: a
 * console that boots over a clocked freeze arms a timer for it, and if the
 * operator then presses Freeze all, fifteen minutes later that timer would
 * `killLadder` a child inside a freeze the banner calls standing. Same harm,
 * a different rail, and only one of them was closed.
 *
 * The timer is deliberately left armed. The gate is read at FIRE time, so a
 * thaw restores the promise with nothing to rewind — the rule the whole phase
 * is built on.
 */
test('escalation: an overdue lane freeze is NOT escalated while the fleet is frozen', async () => {
  const { root, cleanup } = scratch();
  try {
    const pid = liveChild();
    process.kill(pid, 'SIGSTOP');
    const stopped = Date.now() + 2_000;
    while (procState(pid) !== 'T' && Date.now() < stopped) await sleep(20);

    // Past due by a minute: `runFreezeVerdict` reads `escalate`, so nothing but
    // this gate stands between the timer and a `killLadder`.
    const run = frozenRun(root, -1, pid);
    writeFleetHold('mo');
    const { svc } = service(root);
    await svc.bootSettled;

    // Driven directly, because that is the only honest way to reach this
    // branch: the case it defends is a timer armed by a console that was not
    // frozen, with Freeze all pressed afterwards — and a boot under a marker
    // never arms one at all (`readoptQueued` refuses the whole pass). Firing it
    // by hand is exactly what that surviving timer would do.
    (svc as never as { escalateFrozenRun(slug: string, runId: string): void })
      .escalateFrozenRun('alpha', run.id);
    await sleep(120);

    const after = loadRun(root, 'alpha', run.id, null)!;
    assert.ok(after.freeze, 'the freeze stands — a fleet freeze outranks a lane clock');
    assert.equal(after.phases['1']!.status, 'running', 'and the phase was not checkpointed under it');
    assert.equal(procState(pid), 'T', 'nor was the child signalled, per the kernel');
    assert.deepEqual(
      journal(root, run.id).filter((e) => e.event === 'run.freeze-escalated'), [],
      'and nothing claims an escalation happened',
    );
  } finally { clearFleetHold(); cleanup(); }
});

/**
 * The thaw reaches the runs this console is NOT driving — with a real child.
 *
 * This is the case a fleet thaw meets after a restart, and it is the case the
 * first version missed entirely: `thawFleet` walked `liveRunners()`, the pool
 * was empty by construction, and the SIGSTOPped children stayed stopped for
 * ever. A standing freeze has no escalation clock, so nothing else would ever
 * have come back for them — the original incident, reached through the undo.
 *
 * A live pid is the whole test, for the reason `liveChild` gives: a fake one
 * exercises the path that was never broken.
 */
test('thaw: a frozen child under NO live runner is woken, per the kernel', async () => {
  const { root, cleanup } = scratch();
  try {
    const pid = liveChild();
    // Stop it for real, the way a freeze does. `frozenRun` records the freeze;
    // this is what makes the record true.
    process.kill(pid, 'SIGSTOP');
    const deadline = Date.now() + 2_000;
    while (procState(pid) !== 'T' && Date.now() < deadline) await sleep(20);
    assert.equal(procState(pid), 'T', 'the fixture is genuinely stopped before anything is asked');

    const run = frozenRun(root, 30, pid);
    // A STANDING freeze: no deadline, so nothing else can ever end it.
    delete (run.freeze as { escalateAt?: string }).escalateAt;
    saveRun(run);

    writeFleetHold('mo');
    const { svc, started } = service(root);
    await svc.bootSettled;
    await sleep(50);
    assert.equal(procState(pid), 'T', 'the boot pass leaves a standing freeze exactly alone');

    await svc.thawFleet('mo');
    const woken = Date.now() + 2_000;
    while (procState(pid) === 'T' && Date.now() < woken) await sleep(20);
    assert.notEqual(procState(pid), 'T', 'the thaw wakes it — asked of the kernel, not of the record');

    const after = loadRun(root, 'alpha', run.id, null)!;
    assert.equal(after.freeze, null, 'and the record it released is cleared, not left pointing at nothing');
    assert.notEqual(after.status, 'frozen', 'a run nobody can thaw again must not still say frozen');
    assert.deepEqual(started, [], 'waking is not starting');
  } finally { clearFleetHold(); cleanup(); }
});

/* ---------------- D16: the stored-run `pausing` is unreachable ---------------- */

/**
 * D16 was a CANDIDATE defect — "`pauseRun`'s stored-run fallback writes
 * `pausing`, a word only the drive loop reads, on a run no loop drives" — and
 * it does not reproduce. This test is the evidence, kept so the finding cannot
 * quietly stop being true.
 *
 * The reason is one layer down: every read of a stored run goes through
 * `loadRun`, which RECONCILES. So an undriven run has already been settled by
 * the time the fallback's callback sees it — `interrupted` here, `parked` when
 * a child is still working — and the `IN_FLIGHT` guard is false. The word is
 * never written, because reconcile got there first.
 *
 * The value of pinning it: if a future change makes reconcile lazier, this goes
 * red and D16 becomes real, with the diagnosis already written down.
 */
test('pause on a run nothing drives cannot write `pausing` — reconcile settled it first', async () => {
  const { root, cleanup } = scratch();
  try {
    const { svc } = service(root);
    await svc.bootSettled;
    // Written AFTER the boot pass, so the boot reconcile is not what settles
    // it: this is the freshest possible in-flight record a fallback could meet.
    const state = newRun({ slug: 'alpha', root });
    state.status = 'running';
    phaseRecord(state, 1).status = 'running';
    saveRun(state);

    const paused = svc.pauseRun('alpha', 'operator');
    assert.ok(paused, 'the fallback answered');
    assert.notEqual(
      paused.status, 'pausing',
      'the whole of D16: an instruction only a drive loop can carry out, on a run with no drive loop',
    );
    assert.ok(
      !IN_FLIGHT.includes(paused.status),
      `a run nothing drives comes back settled, not in flight — got ${paused.status}`,
    );
    // And it stays settled on disk: no in-flight record is left for a later
    // pass to find and re-interpret.
    assert.ok(!IN_FLIGHT.includes(loadRun(root, 'alpha', state.id)!.status));
  } finally { cleanup(); }
});
