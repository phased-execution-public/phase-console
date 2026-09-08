/**
 * Auto-recovery — the console launches the fix agent itself, bounded.
 *
 * One click on autopilot should carry a plan to the end. The halts that used
 * to stop it dead fall into two piles: the ones only a person can clear (auth,
 * budget, a denied tool), and the ones the recovery agent clears every time a
 * person pressed the button for it (a red verification, a missing handoff, a
 * crashed phase). This is the console pressing that button by itself — with
 * every guard a person would have applied:
 *
 *  - only halts whose **named kind** is auto-recoverable (old records fall
 *    back to the unmistakable sentences, never the generic ones);
 *  - only within budget: per-phase attempts, a per-run cap, and never twice
 *    against the *identical* failure;
 *  - only when the console may spawn agents at all (`--allow-agent`, node-pty);
 *  - bumped **at launch** and persisted, so a console that dies mid-recovery
 *    relaunches at most what the budget still allows.
 *
 * Nothing here spawns `claude`; the mint is stubbed and everything up to it is
 * real — the guards, the briefing resolution, the bookkeeping.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-autorecover-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');

const { SKILL_DIR } = await import('../server/config.ts');
const { Service, autoRecoveryClass } = await import('../server/service.ts');
const { consumeDeclaration, loadRun, newRun, phaseRecord, runDir, saveRun } = await import('../server/runner/state.ts');
const { WatchScheduler } = await import('../server/watch-scheduler.ts');
type RunState = import('../server/runner/state.ts').RunState;

const SCRIPTS = join(SKILL_DIR, 'scripts');

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
| 2 | cart api endpoint | 1 | — | app | it still works |
| 3 | checkout | 2 | — | app | it ships |

## Phases

### Phase 1 — schema
- **Size:** S

### Phase 2 — cart api endpoint
- **Size:** S

### Phase 3 — checkout
- **Size:** S
`;

const OPEN = new Map<string, Array<{ close: () => void }>>();

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-autorecover-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return {
    root,
    cleanup: () => {
      for (const svc of OPEN.get(root) ?? []) svc.close();
      OPEN.delete(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function service(root: string, flags: Record<string, unknown> = {}) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: true,
    scriptsDir: SCRIPTS, logFile: null, ...flags,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  OPEN.set(root, [...(OPEN.get(root) ?? []), svc]);
  return svc;
}

/** Stub the pty layer: everything up to the mint is real, the mint records. */
function stubMint(svc: ReturnType<typeof service>, availability = 'yes'): Array<Record<string, unknown>> {
  const minted: Array<Record<string, unknown>> = [];
  const t = svc.terminals as never as Record<string, unknown>;
  t.availability = () => availability;
  t.mint = async (_sid: unknown, _size: unknown, launch: Record<string, unknown>) => {
    minted.push(launch);
    return { ok: true, sessionId: 'sess-auto', token: 'tok' };
  };
  return minted;
}

/**
 * Stub the SESSION path: `recoverPhase` records instead of driving a runner.
 *
 * Since Phase 3 the four "briefed agent" rungs are runner sessions under
 * `--allow-run` (`mode: 'repair'`) and only fall back to the pty when the
 * console may mint agents but not run sessions — so a test that asserts on
 * `stubMint` alone is asserting the FALLBACK.
 */
function stubSession(svc: ReturnType<typeof service>): Array<{ phase: number; mode: string; opts: Record<string, unknown> }> {
  const calls: Array<{ phase: number; mode: string; opts: Record<string, unknown> }> = [];
  (svc as never as Record<string, unknown>).recoverPhase =
    async (_slug: string, phase: number, mode: string, opts: Record<string, unknown> = {}) => {
      calls.push({ phase, mode, opts });
      return null;
    };
  return calls;
}

function haltedRun(root: string, over: Partial<RunState> = {}): RunState {
  // Phase 1 finished, so the board reads phase 2 — the phase every run below
  // halts on — as `ready`. A run cannot reach phase 2 with phase 1 unfinished:
  // 2 depends on 1. Leaving it out described an impossible run, which stopped
  // mattering only because nothing consulted the board; the healer's candidate
  // list does now, and it correctly refuses to work a phase still `waiting`.
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(
    join(root, 'docs', 'handoffs', 'alpha', 'phase-01-schema.md'),
    '---\nplan: docs/plans/alpha.md\nphase: 1\ntitle: schema\nstatus: complete\n---\n# done\n',
    'utf8',
  );
  const state = newRun({ slug: 'alpha', root, autoRecover: true });
  state.status = 'halted';
  state.activePhase = 2;
  state.halt = {
    at: new Date().toISOString(),
    reason: 'phase 2 did not verify: 1 of 2 command(s) failed — npm test',
    phase: 2,
    kind: 'verify-failed',
  };
  state.finishedReason = state.halt.reason;
  const record = phaseRecord(state, 2);
  record.status = 'failed';
  Object.assign(state, over);
  saveRun(state);
  return state;
}

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));

/* ------------------------------------------------------------------ *
 * The classifier
 * ------------------------------------------------------------------ */

test('named kinds decide; everything human-shaped answers null', () => {
  const halt = (kind?: string, reason = 'phase 2 stopped') =>
    ({ reason, ...(kind ? { kind } : {}) });

  assert.equal(autoRecoveryClass(halt('verify-failed'), 'halted'), 'halted-verification');
  assert.equal(autoRecoveryClass(halt('plan-lint'), 'halted'), 'halted-verification');
  assert.equal(autoRecoveryClass(halt('no-handoff'), 'halted'), 'halted-missing-handoff');
  assert.equal(autoRecoveryClass(halt('phase-crashed'), 'halted'), 'interrupted-resume');
  for (const kind of ['needs-human', 'budget', 'models-exhausted', 'failure-streak', 'plan-unreadable']) {
    assert.equal(autoRecoveryClass(halt(kind), 'halted'), null, kind);
  }
  // An interrupted run is the crash this console is booting back from.
  assert.equal(autoRecoveryClass(null, 'interrupted'), 'interrupted-resume');
  // A halted run with no halt record says nothing to act on.
  assert.equal(autoRecoveryClass(null, 'halted'), null);
  assert.equal(autoRecoveryClass(null, 'running'), null);
  assert.equal(autoRecoveryClass(null, 'parked'), null);
});

test('records written before kinds are read by their unmistakable sentences only', () => {
  const halt = (reason: string) => ({ reason });
  assert.equal(
    autoRecoveryClass(halt('phase 3 did not verify: 1 of 2 command(s) failed — npm test'), 'halted'),
    'halted-verification');
  assert.equal(
    autoRecoveryClass(halt('phase 3 left the plan failing validate.sh: LINT FAIL'), 'halted'),
    'halted-verification');
  assert.equal(
    autoRecoveryClass(halt('the session for phase 6 ended cleanly but the board still reads "ready" — no handoff was written'), 'halted'),
    'halted-missing-handoff');
  // The client may OFFER a button for these; this must not press it.
  assert.equal(autoRecoveryClass(halt('the run budget of $5 is spent'), 'halted'), null);
  assert.equal(autoRecoveryClass(halt('claude is signed out'), 'halted'), null);
  assert.equal(autoRecoveryClass(halt('the runner itself failed: boom'), 'halted'), null);
});

/* ------------------------------------------------------------------ *
 * The guards, in the order a launch has to pass them
 * ------------------------------------------------------------------ */

test('a phase the board is still WAITING on is not a recovery candidate', async () => {
  // Measured on a real run: the healer boarded a phase 10 whose 7, 8 and 9 were
  // sitting ready and untouched, halting every time with "the session for phase
  // 10 ended cleanly but the board still reads waiting" — the runner correctly
  // describing work it should never have started — until the run's entire
  // recovery budget (5 launches) was spent on a phase that could not run.
  //
  // A waiting phase has unmet dependencies by definition: nothing has started,
  // nothing can start, and no rung has a session worth launching for it.
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    try {
      const state = newRun({ slug: 'alpha', root, autoRecover: true });
      state.status = 'halted';
      // Records for all three, so record-existence is not what excludes them.
      for (const phase of [1, 2, 3]) phaseRecord(state, phase).status = 'failed';
      saveRun(state);

      const board = (await svc.board('alpha')).states;
      assert.equal(board[1], 'ready', 'phase 1 leads the plan');
      assert.equal(board[2], 'waiting', 'phase 2 depends on 1');
      assert.equal(board[3], 'waiting', 'phase 3 depends on 2');

      const open = await svc.classifyOpenPhases('alpha', state, board);
      const phases = open.map((entry) => entry.phase).sort((a, b) => a - b);
      assert.deepEqual(phases, [1], `only the ready phase is a candidate, got ${phases.join(',')}`);

      // …unless this run is actually driving it: out-of-order work is real work.
      state.children = {
        c1: { pid: 1, phase: 3, sessionId: 's', startedAt: new Date().toISOString() },
      } as never;
      const driving = await svc.classifyOpenPhases('alpha', state, board);
      assert.ok(
        driving.some((entry) => entry.phase === 3),
        'a waiting phase with a live lane stays diagnosable',
      );
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('a healable halt launches a REPAIR SESSION under the run, not a pty — and the attempt is persisted at launch', async () => {
  // The behaviour Phase 3 changed. The `fix-agent` rung used to mint an
  // interactive `claude` with no `--settings` (so no deny wall and no hooks),
  // no journal, no lane, no grant and no lease, started in the console's own
  // root. It is now a runner session in the run's own frame; the pty survives
  // only as the `--allow-agent`-without-`--allow-run` fallback.
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const minted = stubMint(svc);
    const sessions = stubSession(svc);
    const run = haltedRun(root);

    const out = await svc.maybeAutoRecover('alpha');

    assert.equal(out.launched, true, out.reason);
    assert.equal(out.vehicle, 'session');
    assert.equal(out.rung, 'fix-agent');
    assert.equal(minted.length, 0, 'no pty is minted while the console may run sessions');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].phase, 2);
    assert.equal(sessions[0].mode, 'repair');
    assert.equal(sessions[0].opts.cls, 'halted-verification');
    assert.equal(sessions[0].opts.situation, 'verify-red');
    // The briefing is composed by the console, not left to the session.
    assert.match(String(sessions[0].opts.instruction ?? ''), /phase 2 of "alpha"/i);
    // Bumped BEFORE the session runs, so a console death cannot forget it.
    const disk = loadRun(root, 'alpha', run.id, null);
    assert.equal(disk?.recoveries?.['2']?.attempts, 1);
  } finally { cleanup(); }
});

test('a run that opted out is left alone', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const minted = stubMint(svc);
    const run = haltedRun(root);
    const onDisk = loadRun(root, 'alpha', run.id, null)!;
    delete onDisk.autoRecover;
    saveRun(onDisk);

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, false);
    assert.equal(minted.length, 0);
  } finally { cleanup(); }
});

test('the per-phase ceiling is `ladderPerPhaseRungs` and nothing shadows it', async () => {
  // This used to pin a SECOND per-phase ceiling: `state.autoRecover.attempts`,
  // hardcoded `2` by `newRun` and unreachable from the UI (the launch dialog's
  // field is a boolean). Both bounded the same counter — `accountRung` moves
  // `attempts` and `rungs` together — so an operator who set
  // `ladderPerPhaseRungs` to 3 still got two, with nothing on any screen saying
  // why. The measured run parked one rung short of its own fix, refusing for
  // ever with "recovery budget is spent (2 launches)".
  //
  // So the pin is now the OPPOSITE claim in its first half: two spent launches
  // under a ceiling of three must climb the third rung.
  const under = scratch();
  try {
    const svc = service(under.root);
    svc.prefs.ladderPerPhaseRungs = 3;
    const minted = stubMint(svc);
    const sessions = stubSession(svc);
    haltedRun(under.root, {
      recoveries: { 2: { attempts: 2, lastAt: new Date().toISOString() } },
    });

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, true, 'two spent under a ceiling of three leaves a third rung');
    // The vehicle is the session path now; what this test is about is the COUNT.
    assert.equal(minted.length + sessions.length, 1);
  } finally { under.cleanup(); }

  // And the ceiling that DOES exist is still a hard stop — reached at the
  // pref's number, refused in the ladder's own words, with the ask written.
  const at = scratch();
  try {
    const svc = service(at.root);
    svc.prefs.ladderPerPhaseRungs = 2;
    const minted = stubMint(svc);
    const sessions = stubSession(svc);
    haltedRun(at.root, {
      recoveries: { 2: { attempts: 2, lastAt: new Date().toISOString() } },
    });

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, false);
    assert.match(out.reason ?? '', /budget/i);
    assert.equal(minted.length + sessions.length, 0);
  } finally { at.cleanup(); }
});

test('the per-run cap counts every phase’s launches together', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    // Stated rather than assumed: the ceiling is `ladderPerRunRungs`, which an
    // operator sets. This used to lean on a hardcoded 5 in `maybeAutoRecover`
    // that silently overrode that preference — so the test read as though it
    // pinned the SUMMING (which is its point) while actually pinning the
    // constant.
    svc.prefs.ladderPerRunRungs = 5;
    const minted = stubMint(svc);
    haltedRun(root, {
      recoveries: {
        1: { attempts: 3, lastAt: new Date().toISOString() },
        3: { attempts: 2, lastAt: new Date().toISOString() },
      },
    });

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, false);
    assert.match(out.reason ?? '', /run.*budget|budget.*run/i);
    assert.equal(minted.length, 0);
  } finally { cleanup(); }
});

test('a legacy attempt on the identical failure counts as the rung the old healer drove — the ladder escalates from it, never repeats it', async () => {
  // Before rungs were recorded, `recoveries[phase]` held only `attempts` and
  // `lastReason`, and the identical reason twice was REFUSED outright — a
  // dead end, not an escalation (the measured "same failure twice — a person
  // should look" on phases a stronger try would have fixed). A legacy slot is
  // now read as having climbed the vehicle the old healer used: the agent,
  // for a phase with no session. verify-red's ladder is [own session, fix
  // agent]; with no session the own-session rung is undrivable and the agent
  // rung reads as tried — so the ladder is exhausted, an Errand is written,
  // and the reason says which rungs were spent, not merely "same failure".
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const minted = stubMint(svc);
    const reason = 'phase 2 did not verify: 1 of 2 command(s) failed — npm test';
    const run = haltedRun(root, {
      recoveries: { 2: { attempts: 1, lastAt: new Date().toISOString(), lastReason: reason } },
    });

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, false);
    assert.equal(out.situation, 'verify-red');
    assert.match(out.reason ?? '', /every rung for verify-red has been tried/);
    assert.equal(minted.length, 0);
    const disk = loadRun(root, 'alpha', run.id, null)!;
    assert.equal(disk.recoveries?.['2']?.errand?.situation, 'verify-red', 'exhaustion writes the errand');
    assert.ok((disk.recoveries?.['2']?.errand?.need ?? '').length > 10);
  } finally { cleanup(); }
});

test('the same failure with a session left is escalated, not refused: own session first, then a stronger agent', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const minted = stubMint(svc);
    const reason = 'phase 2 did not verify: 1 of 2 command(s) failed — npm test';
    const run = haltedRun(root, {
      recoveries: { 2: { attempts: 1, lastAt: new Date().toISOString(), lastReason: reason } },
      phases: { 2: { phase: 2, status: 'failed', attempts: 1, costUsd: 0, sessionId: 'sess-0002' } },
    });
    const resumed: Array<{ phase: number; mode: string }> = [];
    (svc as never as { recoverPhase: (slug: string, phase: number, mode: string) => Promise<null> })
      .recoverPhase = async (_slug: string, phase: number, mode: string) => { resumed.push({ phase, mode }); return null; };

    // The legacy attempt reads as the own-session rung; the next rung is the
    // stronger fresh agent — the escalation the old refusal never offered.
    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, true, out.reason);
    assert.equal(out.rung, 'fix-agent');
    // The stronger try is a FRESH repair session, not a resume of the session
    // that already failed at it — which is what `mode: 'repair'` means.
    assert.equal(out.vehicle, 'session');
    assert.equal(minted.length, 0);
    assert.deepEqual(resumed.map((r) => r.mode), ['repair'],
      'the own session was the legacy attempt — the escalation is a fresh repair');
    const disk = loadRun(root, 'alpha', run.id, null)!;
    assert.equal(disk.recoveries?.['2']?.rungs?.[0]?.rung, 'fix-agent');
    assert.equal(disk.recoveries?.['2']?.attempts, 2);
  } finally { cleanup(); }
});

test('without --allow-agent OR --allow-run the refusal names the flag', async () => {
  // Both off: with `--allow-run` the rung is a session and the agent flag is
  // beside the point, so the console that genuinely cannot climb is the one
  // allowed neither.
  const { root, cleanup } = scratch();
  try {
    const svc = service(root, { allowAgent: false, allowRun: false });
    const minted = stubMint(svc);
    haltedRun(root);

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, false);
    assert.match(out.reason ?? '', /--allow-agent/);
    assert.equal(minted.length, 0);
  } finally { cleanup(); }
});

test('a human-shaped halt is never healed however the run is configured', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const minted = stubMint(svc);
    haltedRun(root, {
      halt: {
        at: new Date().toISOString(),
        reason: 'authentication failed — sign in and continue',
        phase: 2,
        kind: 'needs-human',
      },
    });

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, false);
    assert.equal(minted.length, 0);
  } finally { cleanup(); }
});

test('a recovery already running for the target is not doubled', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const minted = stubMint(svc);
    haltedRun(root);
    (svc.terminals as never as Record<string, unknown>).state = () => ({
      sessions: [{
        id: 'sess-live', label: 'Recover alpha P2', kind: 'claude',
        meta: { intent: 'recovery', recovery: { kind: 'halted-verification', slug: 'alpha', phase: 2 } },
      }],
    });

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, false);
    assert.match(out.reason ?? '', /already running/i);
    assert.equal(minted.length, 0);
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Boot: a console that died mid-halt re-arms the same loop
 * ------------------------------------------------------------------ */

test('readoptQueued schedules auto-recovery for a halted run with the option on', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    stubMint(svc);
    haltedRun(root);
    const scheduled: string[] = [];
    (svc as never as { scheduleAutoRecover: (slug: string) => void }).scheduleAutoRecover =
      (slug: string) => { scheduled.push(slug); };

    await (svc as never as { readoptQueued: () => Promise<void> }).readoptQueued();
    assert.deepEqual(scheduled, ['alpha']);
  } finally { cleanup(); }
});

test('readoptQueued leaves an opted-out halted run for a person', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    stubMint(svc);
    const run = haltedRun(root);
    const onDisk = loadRun(root, 'alpha', run.id, null)!;
    delete onDisk.autoRecover;
    saveRun(onDisk);
    const scheduled: string[] = [];
    (svc as never as { scheduleAutoRecover: (slug: string) => void }).scheduleAutoRecover =
      (slug: string) => { scheduled.push(slug); };

    await (svc as never as { readoptQueued: () => Promise<void> }).readoptQueued();
    assert.deepEqual(scheduled, []);
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The verification-preflight park: the one parked shape an agent heals
 * ------------------------------------------------------------------ */

test('a verification-preflight park classifies as plan-repair — and only exactly that shape', () => {
  const halt = { reason: 'nothing left to run on its own — phase 1 is parked (…§Verification…)', kind: 'verification-preflight' };
  assert.equal(autoRecoveryClass(halt, 'parked'), 'plan-repair');
  // The kind travels with `parked` only: the drive loop never writes it on a
  // halted run, so meeting one there means something else is going on.
  assert.equal(autoRecoveryClass(halt, 'halted'), null);
  // A kindless park (a lock, a live-orphan adoption) stays a person's.
  assert.equal(autoRecoveryClass({ reason: 'phase 1 is locked by someone-else' }, 'parked'), null);
});

/** A run parked at the verification preflight, as the drive loop writes one. */
function verificationParkedRun(root: string, over: Partial<RunState> = {}): RunState {
  const state = newRun({ slug: 'alpha', root, autoRecover: true });
  state.status = 'parked';
  state.halt = {
    at: new Date().toISOString(),
    reason: 'nothing left to run on its own — phase 1 is parked (the plan states no verification '
      + 'for phase 1 — nothing would prove the work. Add a §Verification command to the plan, then '
      + 'Retry.). an unrunnable §Verification takes a plan edit or Repair with AI, then Retry.',
    phase: 1,
    kind: 'verification-preflight',
  };
  state.finishedReason = state.halt.reason;
  const record = phaseRecord(state, 1);
  record.status = 'parked';
  record.note = 'the plan states no verification for phase 1 — nothing would prove the work. '
    + 'Add a §Verification command to the plan, then Retry.';
  Object.assign(state, over);
  saveRun(state);
  return state;
}

test('a verification-preflight park starts on the FREE deterministic rung, not a paid session', async () => {
  // `plan-broken`'s ladder has always been [repair script, repair agent] — but
  // the script did not exist, so `vehicleForRung` answered null for it and
  // every `plan-broken` began at the paid rung (R19). It exists now, so the
  // first thing spent on a broken plan is a subprocess.
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const minted = stubMint(svc);
    const sessions = stubSession(svc);
    const run = verificationParkedRun(root);

    const out = await svc.maybeAutoRecover('alpha');

    assert.equal(out.launched, true, out.reason);
    assert.equal(out.rung, 'plan-repair-script');
    assert.equal(out.vehicle, 'script');
    assert.equal(minted.length, 0, 'no pty');
    assert.equal(sessions.length, 0, 'and no session — this rung costs nothing');
    // Anchored on the halt's own phase — without it the launch dies at
    // "no phase to anchor a recovery on" (activePhase is null after a park).
    assert.equal(out.phase, 1);
    assert.equal(loadRun(root, 'alpha', run.id, null)?.recoveries?.['1']?.attempts, 1);
  } finally { cleanup(); }
});

test('and the paid repair rung behind it is a SESSION carrying the situation', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const minted = stubMint(svc);
    const sessions = stubSession(svc);
    const run = verificationParkedRun(root);
    // The free rung already spent, as the ladder records it.
    const onDisk = loadRun(root, 'alpha', run.id, null)!;
    onDisk.recoveries = {
      1: {
        attempts: 1, lastAt: new Date().toISOString(),
        rungs: [{
          situation: 'plan-broken:verification', rung: 'plan-repair-script',
          at: new Date().toISOString(), outcome: 'no-defect',
        }],
      },
    };
    saveRun(onDisk);

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, true, out.reason);
    assert.equal(out.rung, 'plan-repair-agent');
    assert.equal(out.vehicle, 'session');
    assert.equal(minted.length, 0);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].mode, 'repair');
    assert.equal(sessions[0].opts.cls, 'plan-repair');
    assert.equal(sessions[0].opts.situation, 'plan-broken:verification');
    const brief = String(sessions[0].opts.instruction ?? '');
    // Exit criterion 2: the brief carries the situation key and the issue's
    // detail, and does NOT make a green validate.sh its bar.
    assert.match(brief, /Why this session was started/);
    assert.match(brief, /plan-broken:verification/);
    assert.match(brief, /health issue/);
  } finally { cleanup(); }
});

test('a failed verification repair cannot loop: the ladder climbs each rung ONCE, then asks', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    stubMint(svc);
    stubSession(svc);
    const run = verificationParkedRun(root);

    // Rung 1 — the free script.
    const first = await svc.maybeAutoRecover('alpha');
    assert.equal(first.launched, true, first.reason);
    assert.equal(first.rung, 'plan-repair-script');

    // Rung 2 — the paid repair session. (The script rung is left OPEN by the
    // stubbed drive; `nextRung` counts it as tried either way, which is the
    // point: a rung is not re-climbed because its outcome is unknown.)
    const second = await svc.maybeAutoRecover('alpha');
    assert.equal(second.launched, true, second.reason);
    assert.equal(second.rung, 'plan-repair-agent');

    // The repair came back empty-handed; the sync records the miss under the
    // SAME slot the launcher bumped.
    svc.syncRecoveredRun(
      { kind: 'plan-repair', slug: 'alpha', phase: 1, runId: run.id },
      { fixed: false, headline: '', detail: '' },
    );

    const again = await svc.maybeAutoRecover('alpha');
    assert.equal(again.launched, false);
    // Both rungs are spent, so the ladder is exhausted and the phase carries an
    // errand — the loop ends with a named ask, not a retry.
    assert.match(again.reason ?? '', /every rung for plan-broken:verification has been tried/,
      'the same rung is never climbed twice on one phase, and the loop ends');
    assert.equal(loadRun(root, 'alpha', run.id, null)?.recoveries?.['1']?.errand?.situation, 'plan-broken:verification');
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The vehicle: session-API recovery first, pty only for plan repairs
 * ------------------------------------------------------------------ */

test('a halt with a resumable session takes the session API — under --allow-run alone, no pty minted', async () => {
  const { root, cleanup } = scratch();
  try {
    // Agent capability OFF on purpose: the old router required --allow-agent
    // even though the autopilot itself is --allow-run, so a console without
    // agents silently never healed. The session vehicle needs only the runner.
    const svc = service(root, { allowAgent: false });
    const minted = stubMint(svc);
    const run = haltedRun(root, {
      halt: {
        at: new Date().toISOString(),
        reason: 'the session for phase 2 ended cleanly but the board still reads "ready" — no handoff was written',
        phase: 2, kind: 'no-handoff',
      },
      phases: { 2: { phase: 2, status: 'failed', attempts: 1, costUsd: 0, sessionId: 'sess-0002' } },
    });

    const resumed: Array<{ phase: number; mode: string }> = [];
    (svc as never as { recoverPhase: (slug: string, phase: number, mode: string) => Promise<null> })
      .recoverPhase = async (_slug: string, phase: number, mode: string) => {
        resumed.push({ phase, mode });
        return null;
      };

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, true, out.reason);
    assert.deepEqual(resumed, [{ phase: 2, mode: 'closeout' }],
      'the recovery resumes the phase\'s own session through the runner');
    assert.equal(minted.length, 0, 'no pty agent for a phase whose own session can be resumed');
    const after = loadRun(root, 'alpha', run.id, null)!;
    assert.equal(after.recoveries?.['2']?.attempts, 1, 'the budget was spent at launch');
  } finally { cleanup(); }
});

test('the pre-recovery gate: a board that moved past the halt reconciles the records and launches nothing', async () => {
  // The observed unnecessary-recovery class: sessions launched 19 and 61
  // seconds AFTER the console logged "superseded — the board shows phase N
  // done", because nothing read the board before minting.
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const minted = stubMint(svc);
    const run = haltedRun(root, {
      halt: {
        at: new Date().toISOString(),
        reason: 'no handoff was written', phase: 2, kind: 'no-handoff',
      },
    });
    // Somebody finished phase 2 by hand: a complete handoff appears on disk.
    mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
    writeFileSync(join(root, 'docs', 'handoffs', 'alpha', 'phase-02-cart-api-endpoint.md'),
      '---\nplan: docs/plans/alpha.md\nphase: 2\ntitle: cart\nstatus: complete\n---\n# done\n', 'utf8');
    (svc as never as { reread: (slug: string) => void }).reread('alpha');

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, false);
    // Which layer catches it depends on who read the run first: the read-path
    // resolver may reconcile before the gate ever runs (loading the run IS a
    // read), or the gate does it against a pooled state the read path skips.
    // Either way the contract holds: nothing launched, records closed.
    assert.match(out.reason ?? '',
      /board had already moved past the halt|the halt is not auto-recoverable|already resolved/);
    assert.equal(minted.length, 0, 'nothing was spawned for work somebody already did');

    const after = loadRun(root, 'alpha', run.id, null)!;
    assert.equal(after.phases['2'].status, 'done');
    assert.match(after.phases['2'].note ?? '', /closed outside this run/);
    assert.equal(after.halt, null, 'the halt about the finished phase is stood down');
    assert.ok(after.resolved, 'the run is resolved as superseded');
    assert.match(after.resolved?.reason ?? '', /superseded/);
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The anchor is a SITUATION, not the halt's phase — the measured dead end
 * ------------------------------------------------------------------ */

import { execFileSync } from 'node:child_process';

/** A scratch root that is a clean git repository: the work evidence can then say "nothing" rather than "unreadable". */
function gitInit(root: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q'], { cwd: root, env });
  execFileSync('git', ['add', '-A'], { cwd: root, env });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root, env });
}

test('a parked run whose only open record is interrupted with no work anchors on it and re-boards fresh — no "no phase to anchor"', async () => {
  // The 2026-08-19 P12 specimen: the operator resumed a run, it parked at once
  // on an `interrupted` record (stopped by the operator, 16 turns, during
  // bootstrap), and Recover & continue answered "needs-you: no phase to
  // anchor a recovery on" — twice — before a $3.32 closeout discovered the
  // phase had never been implemented. activePhase is null after a park and
  // the park's halt names no phase, so the old derivation had nothing.
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    const svc = service(root, { allowAgent: false });
    const minted = stubMint(svc);
    const state = newRun({ slug: 'alpha', root, autoRecover: true });
    state.status = 'parked';
    state.activePhase = null;
    state.halt = {
      at: new Date().toISOString(),
      reason: 'nothing left to run on its own — phase 1 is interrupted (stopped by the operator)',
    };
    state.finishedReason = state.halt.reason;
    const record = phaseRecord(state, 1);
    record.status = 'interrupted';
    record.note = 'stopped by the operator';
    record.sessionId = 'sess-0001';
    record.startedAt = new Date(Date.now() + 5_000).toISOString(); // started after the seed commit: nothing since
    record.turns = 16;
    record.costUsd = 1.44;
    saveRun(state);

    const retried: number[] = [];
    (svc as never as { retryPhase: (slug: string, phase: number) => Promise<null> })
      .retryPhase = async (_slug: string, phase: number) => { retried.push(phase); return null; };

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, true, out.reason);
    assert.equal(out.phase, 1);
    assert.equal(out.situation, 'never-started');
    assert.equal(out.rung, 'reboard-fresh');
    assert.equal(out.vehicle, 'retry', 'the runner\'s own re-board — no closeout, no agent, no person');
    assert.deepEqual(retried, [1]);
    assert.equal(minted.length, 0);

    const disk = loadRun(root, 'alpha', state.id, null)!;
    assert.equal(disk.recoveries?.['1']?.rungs?.[0]?.situation, 'never-started');
    assert.equal(disk.recoveries?.['1']?.rungs?.[0]?.rung, 'reboard-fresh');
    assert.equal(disk.recoveries?.['1']?.attempts, 1, 'the legacy counter moves with the rung');
    assert.equal(disk.phases['1'].situation?.key, 'never-started', 'the record caches what it read as');

    // The journal carries the situation and the rung by name.
    const { readFileSync } = await import('node:fs');
    const { journalFile } = await import('../server/runner/state.ts');
    const lines = readFileSync(journalFile(root, 'alpha', state.id), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { event: string; phase?: number; data: Record<string, unknown> });
    const situation = lines.find((l) => l.event === 'phase.situation');
    assert.equal(situation?.phase, 1);
    assert.equal(situation?.data.situation, 'never-started');
    const rung = lines.find((l) => l.event === 'phase.rung');
    assert.equal(rung?.data.rung, 'reboard-fresh');
    assert.equal(rung?.data.vehicle, 'retry');
  } finally { cleanup(); }
});

test('Recover & continue names the step: the phase, what it reads as, and the rung', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    const svc = service(root, { allowAgent: false });
    stubMint(svc);
    const state = newRun({ slug: 'alpha', root });
    state.status = 'parked';
    state.activePhase = null;
    state.halt = { at: new Date().toISOString(), reason: 'nothing left to run on its own — phase 1 is interrupted (stopped by the operator)' };
    state.finishedReason = state.halt.reason;
    const record = phaseRecord(state, 1);
    record.status = 'interrupted';
    record.note = 'stopped by the operator';
    record.startedAt = new Date(Date.now() + 5_000).toISOString();
    saveRun(state);
    (svc as never as { retryPhase: (slug: string, phase: number) => Promise<null> }).retryPhase = async () => null;

    const report = await svc.recoverPlan('alpha');
    assert.equal(report.outcome, 'recovering', report.detail);
    assert.ok(report.steps.some((step) => /phase 1 reads Never started — re-boarding it fresh through the runner \(rung reboard-fresh\)/.test(step)),
      report.steps.join(' | '));
  } finally { cleanup(); }
});

test('a work-in-progress phase with no session left re-boards through the runner WITH the resume brief — the reboard vehicle', async () => {
  // The 2026-08-13 P2 shape, minus the session: unfinished work on disk, no
  // transcript to resume. The ladder's first rung (own session) is not
  // available; the second is the runner's own re-board with a RESUMING brief,
  // driven through `startRun({resumeRunId, reboard})` — never a closeout that
  // may not do the work, never a bare needs-you.
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    writeFileSync(join(root, 'half-done.txt'), 'the work, unfinished');
    const svc = service(root, { allowAgent: false });
    const minted = stubMint(svc);
    const state = newRun({ slug: 'alpha', root, autoRecover: true });
    state.status = 'parked';
    state.activePhase = null;
    state.halt = { at: new Date().toISOString(), reason: 'nothing left to run on its own — phase 1 is interrupted' };
    const record = phaseRecord(state, 1);
    record.status = 'interrupted';
    record.note = 'the console stopped while phase 1 was running';
    record.attempts = 1;
    saveRun(state);

    const starts: Array<Record<string, unknown>> = [];
    (svc as never as { startRun: (slug: string, options: Record<string, unknown>) => Promise<unknown> })
      .startRun = async (_slug: string, options: Record<string, unknown>) => { starts.push(options); return null; };

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, true, out.reason);
    assert.equal(out.phase, 1);
    assert.equal(out.situation, 'work-in-progress');
    assert.equal(out.rung, 'reboard-resume-brief');
    assert.equal(out.vehicle, 'reboard');
    assert.equal(minted.length, 0, 'no agent');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].resumeRunId, state.id);
    const reboard = starts[0].reboard as Array<Record<string, unknown>>;
    assert.equal(reboard.length, 1);
    assert.equal(reboard[0].phase, 1);
    assert.equal(reboard[0].situation, 'work-in-progress');
    assert.equal(reboard[0].rung, 'reboard-resume-brief');
    assert.equal(reboard[0].brief, 'resume');
    assert.equal(reboard[0].sessionId, undefined, 'nothing to resume — the brief is the whole bridge');

    const disk = loadRun(root, 'alpha', state.id, null)!;
    assert.equal(disk.recoveries?.['1']?.rungs?.[0]?.rung, 'reboard-resume-brief', 'the healer accounts the rung; start({reboard}) does not double-count');
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The QA wedge: a stop whose blocker is a phase the board reads DONE
 * ------------------------------------------------------------------ */

/**
 * The measured dead end. Phase 1 finished and its QA verdict is `fail`, so the
 * engine holds 2 and 3 for ever and the board has nothing ready. Every record
 * this run holds reads `done`, so `classifyOpenPhases` — which skips board-done
 * and board-waiting phases — yields no candidate at all, and the healer used to
 * answer "no open phase of this run has a record to act on" with `phase: 0,
 * situation: 'unknown'`, writing no errand and pushing nothing. The operator
 * pressed the button three times and got the same sentence each time.
 */
function qaWedgedRun(root: string): RunState {
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(
    join(root, 'docs', 'handoffs', 'alpha', 'phase-01-schema.md'),
    '---\nplan: docs/plans/alpha.md\nphase: 1\ntitle: schema\nstatus: complete\n---\n# done\n',
    'utf8',
  );
  writeFileSync(
    join(root, 'docs', 'handoffs', 'alpha', 'test-status.md'),
    '# QA\n\n## QA status\n\n| Phase | Result | Report |\n|--:|--|--|\n| 1 | fail | reports/phase-01-qa.md |\n',
    'utf8',
  );
  const state = newRun({ slug: 'alpha', root, autoRecover: true });
  state.status = 'parked';
  state.stoppedBy = 'system';
  const record = phaseRecord(state, 1);
  record.status = 'done';
  record.note = 'closed outside this run (the board reads done)';
  state.halt = {
    at: new Date().toISOString(),
    reason: 'nothing left to run on its own — phase 1 is done but its QA verdict is fail, which holds phases 2, 3.',
    phase: 1,
    kind: 'plan-deadlocked',
  };
  saveRun(state);
  return state;
}

test('the engine really does wedge on a recorded QA fail (the premise)', async () => {
  const s = scratch();
  try {
    const svc = service(s.root);
    qaWedgedRun(s.root);
    const board = (await svc.board('alpha')).states;
    assert.equal(board[1], 'done');
    assert.equal(board[2], 'waiting', 'a fail holds the dependent even though 1 is done');
  } finally { s.cleanup(); }
});

test('a QA-wedged run is climbed, not handed to a person', async () => {
  // Before: "no open phase of this run has a record to act on", three times,
  // with no errand and nothing launched. Then, briefly, an errand — better, but
  // still a person's afternoon. Now the ladder climbs it: the phase that built
  // the work is resumed with the QA report and asked to clear the findings and
  // re-record the verdict. Nothing is asked of anybody unless that runs out.
  const s = scratch();
  try {
    const svc = service(s.root);
    stubMint(svc);
    const state = qaWedgedRun(s.root);
    state.phases['1'].sessionId = 'sess-p1';
    saveRun(state);

    const result = await svc.recoverPlan('alpha');
    assert.equal(result.outcome, 'recovering', 'the wedge is the ladder\'s to clear');
    assert.doesNotMatch(result.detail ?? '', /no open phase/);

    const after = loadRun(s.root, 'alpha', state.id)!;
    const rungs = after.recoveries?.['1']?.rungs ?? [];
    assert.equal(rungs[0]?.rung, 'resume-own-session', 'and it climbed the QA rung');
    assert.equal(rungs[0]?.params?.mode, 'qa-fix');
  } finally { s.cleanup(); }
});
test('a QA wedge the ladder has spent still leaves exactly one errand', async () => {
  // Exhaustion is the only thing that makes a QA verdict a person's again — and
  // when it happens the ask has to be there, naming the report and the two doors
  // (fix and re-record, or waive). This is the errand `ladder.ts` has always
  // carried and nothing could reach.
  const s = scratch();
  try {
    const svc = service(s.root);
    stubMint(svc);
    const state = qaWedgedRun(s.root);
    state.phases['1'].sessionId = 'sess-p1';
    // Both rungs already climbed and failed: nothing left to try.
    state.recoveries = {
      1: {
        attempts: 2, lastAt: new Date().toISOString(),
        rungs: [
          { situation: 'qa-failed', rung: 'resume-own-session', at: new Date().toISOString(), outcome: 'failed', params: { mode: 'qa-fix' } },
          { situation: 'qa-failed', rung: 'fix-agent', at: new Date().toISOString(), outcome: 'failed' },
        ],
      },
    };
    saveRun(state);

    const result = await svc.maybeAutoRecover('alpha');
    assert.equal(result.launched, false, 'every rung is spent');
    const after = loadRun(s.root, 'alpha', state.id)!;
    const errand = after.errand ?? after.recoveries?.['1']?.errand;
    assert.ok(errand, 'an exhausted climb must leave the ask behind');
    assert.match(errand!.need, /QA verdict/);
    assert.match(errand!.how, /qa-record\.sh|QA/);
  } finally { s.cleanup(); }
});
/** `qaWedgedRun` with the verdict still OWED — the P2 incident's shape. */
function qaPendingRun(root: string): RunState {
  const state = qaWedgedRun(root);
  writeFileSync(
    join(root, 'docs', 'handoffs', 'alpha', 'test-status.md'),
    '# QA\n\n## QA status\n\n| Phase | Result | Report |\n|--:|--|--|\n| 1 | pending | — |\n',
    'utf8',
  );
  state.halt = {
    at: new Date().toISOString(),
    reason: 'nothing left to run on its own — phase 1 is done but its QA verdict is pending, which holds phases 2, 3.',
    phase: 1,
    kind: 'plan-deadlocked',
  };
  saveRun(state);
  return state;
}

test('a qa-verdict rung killed by shutdown settles interrupted and the same rung climbs again', async () => {
  // Measured: a console restart killed the qa-verdict resume at 0 turns; the
  // sweep settled the rung `fixed` because the RECORD read done (the rung's
  // goal — a verdict — was nobody's test), the one-rung table exhausted, and
  // the pending verdict held nine phases for sixteen hours.
  const s = scratch();
  try {
    const svc = service(s.root);
    stubMint(svc);
    const state = qaPendingRun(s.root);
    state.phases['1'].sessionId = 'sess-p1';
    state.recoveries = {
      1: {
        attempts: 1, lastAt: new Date().toISOString(),
        rungs: [
          // Open (`running`), with no turns: the console died under it.
          { situation: 'qa-pending', rung: 'resume-own-session', at: new Date().toISOString(), outcome: 'running', params: { mode: 'qa-verdict' } },
        ],
      },
    };
    saveRun(state);

    const result = await svc.maybeAutoRecover('alpha');
    const after = loadRun(s.root, 'alpha', state.id)!;
    const rungs = after.recoveries?.['1']?.rungs ?? [];
    assert.equal(rungs[0]?.outcome, 'interrupted', 'a rung whose session never ran is not consumed');
    assert.equal(result.launched, true, 'the same rung climbs again');
    assert.equal(rungs[1]?.rung, 'resume-own-session');
    assert.equal(rungs[1]?.params?.mode, 'qa-verdict');
  } finally { s.cleanup(); }
});

test('a qa rung is settled by its verdict, not by the phase record', async () => {
  // The record reading `done` was always true — the phase FINISHED before QA
  // was owed. The rung's goal is the verdict, so the verdict is the judge.
  const s = scratch();
  try {
    const svc = service(s.root);
    stubMint(svc);
    const state = qaPendingRun(s.root);
    state.phases['1'].sessionId = 'sess-p1';
    state.recoveries = {
      1: {
        attempts: 1, lastAt: new Date().toISOString(),
        rungs: [
          { situation: 'qa-pending', rung: 'resume-own-session', at: new Date().toISOString(), outcome: 'running', params: { mode: 'qa-verdict' }, turns: 12 },
        ],
      },
    };
    saveRun(state);
    // The verdict landed (the resumed session recorded it before the sweep).
    writeFileSync(
      join(s.root, 'docs', 'handoffs', 'alpha', 'test-status.md'),
      '# QA\n\n## QA status\n\n| Phase | Result | Report |\n|--:|--|--|\n| 1 | pass | reports/phase-01-qa.md |\n',
      'utf8',
    );

    await svc.maybeAutoRecover('alpha');
    const after = loadRun(s.root, 'alpha', state.id)!;
    const rung = after.recoveries?.['1']?.rungs?.[0];
    assert.equal(rung?.outcome, 'fixed');
    assert.match(rung?.note ?? '', /verdict/, 'the note names the goal, not the record');
  } finally { s.cleanup(); }
});

test('a satisfied qa errand dissolves at the sweep', async () => {
  // The view suppresses it (inbox.ts); the record heals here — a standing
  // "needs you" over a recorded verdict is a false ask either way.
  const s = scratch();
  try {
    const svc = service(s.root);
    stubMint(svc);
    const state = qaPendingRun(s.root);
    state.recoveries = {
      1: {
        attempts: 2, lastAt: new Date().toISOString(),
        rungs: [
          { situation: 'qa-pending', rung: 'resume-own-session', at: new Date().toISOString(), outcome: 'failed', params: { mode: 'qa-verdict' }, turns: 8 },
        ],
        errand: {
          phase: 1, situation: 'qa-pending', tried: ['resume-own-session (qa-verdict) → failed'],
          need: 'A QA verdict for this phase — the plan gates on QA and none is recorded.',
          how: 'Run QA from the phase page.', at: new Date().toISOString(),
        },
      },
    };
    saveRun(state);
    writeFileSync(
      join(s.root, 'docs', 'handoffs', 'alpha', 'test-status.md'),
      '# QA\n\n## QA status\n\n| Phase | Result | Report |\n|--:|--|--|\n| 1 | pass | reports/phase-01-qa.md |\n',
      'utf8',
    );

    await svc.maybeAutoRecover('alpha');
    const after = loadRun(s.root, 'alpha', state.id)!;
    assert.equal(after.recoveries?.['1']?.errand, undefined, 'the ask was answered; the errand goes');
  } finally { s.cleanup(); }
});

test('maybeAutoRecover leaves an errand for a stop with no anchor at all', async () => {
  // The unattended half. `maybeAutoRecover` returned at its empty-candidate
  // guard, BEFORE the errand/journal/push machinery, so an unattended console
  // swept the run every five minutes for ever, refused with the same sentence
  // each time, and never once asked the person who could fix it.
  //
  // The QA shapes climb now, so the shape that reaches this guard is one with
  // no record to act on at all — here, a run whose only record the board has
  // overtaken and whose halt names a phase the QA table does not hold.
  const s = scratch();
  try {
    const svc = service(s.root);
    stubMint(svc);
    const state = qaWedgedRun(s.root);
    // Every rung spent, so the climb cannot start; the ask is all that is left.
    state.recoveries = {
      1: {
        attempts: 9, lastAt: new Date().toISOString(),
        rungs: [
          { situation: 'qa-failed', rung: 'resume-own-session', at: new Date().toISOString(), outcome: 'failed', params: { mode: 'qa-fix' } },
          { situation: 'qa-failed', rung: 'fix-agent', at: new Date().toISOString(), outcome: 'failed' },
        ],
      },
    };
    saveRun(state);
    const result = await svc.maybeAutoRecover('alpha');
    assert.equal(result.launched, false);
    const after = loadRun(s.root, 'alpha', state.id)!;
    assert.ok(after.errand ?? after.recoveries?.['1']?.errand, 'the ask must be written, not just returned');
  } finally { s.cleanup(); }
});
test('a spent recovery budget still leaves the errand behind', async () => {
  // Two ceilings sit ahead of the ladder in `maybeAutoRecover`: the run's
  // per-phase launch cap and a hardcoded run-wide 5. Both `refuse` and move on
  // WITHOUT writing an errand — so a phase whose budget ran out went quiet
  // rather than asking. Exhaustion is exactly when a person has to be told:
  // "the ladder climbed everything it had and none of it worked" is the most
  // actionable thing this system ever knows, and it was the one case that said
  // nothing. (`ladder.ts`'s own exhaustion path has always written one.)
  const s = scratch();
  try {
    const svc = service(s.root);
    stubMint(svc);
    const state = haltedRun(s.root);
    // Spend the per-phase budget the way the healer itself would have.
    state.recoveries = { 2: { attempts: 5, lastAt: new Date().toISOString() } };
    saveRun(state);

    const result = await svc.maybeAutoRecover('alpha');
    assert.equal(result.launched, false);
    assert.match(result.reason ?? '', /budget/);
    const after = loadRun(s.root, 'alpha', state.id)!;
    assert.ok(after.recoveries?.['2']?.errand, 'a spent budget is an ask, not a silence');
    assert.ok((after.recoveries!['2'].errand!.need ?? '').length > 0);
  } finally { s.cleanup(); }
});

test('the run-wide recovery ceiling comes from the ladder prefs, not a hardcoded 5', async () => {
  // `if (totalAttempts >= 5)` was a second, silent ceiling that contradicted
  // `ladderPerRunRungs` in Settings — an operator who raised the ladder budget
  // to 20 still got five.
  const s = scratch();
  try {
    const svc = service(s.root);
    svc.prefs.ladderPerRunRungs = 12;
    stubMint(svc);
    const state = haltedRun(s.root);
    state.recoveries = { 2: { attempts: 0, lastAt: new Date().toISOString() } };
    // Six launches across other phases: over the old hardcoded 5, under 12.
    state.recoveries['9'] = { attempts: 6, lastAt: new Date().toISOString() };
    saveRun(state);
    const result = await svc.maybeAutoRecover('alpha');
    assert.doesNotMatch(result.reason ?? '', /5 launches/,
      'the prefs are the ceiling; a second hardcoded one is a setting that lies');
  } finally { s.cleanup(); }
});

test('a rung this console may not drive still leaves an errand naming the flag', async () => {
  // `vehicleForRung` deliberately does NOT consult capability flags: a vehicle
  // the console has but may not use is still the right vehicle, and refusing it
  // BY NAME ("needs --allow-agent") beats skipping it silently, which would read
  // as "nothing to climb" and hide the flag that was actually in the way. That
  // reasoning is sound and stays.
  //
  // What was missing is the other half. The refusal returned without writing an
  // errand, so the reason reached a journal line and a HealResult — and the
  // operator, who is the only one who can restart the console with the flag,
  // was never told. The ladder's own exhaustion path has always written one.
  const s = scratch();
  try {
    const svc = service(s.root, { allowAgent: false, allowRun: false });
    const state = haltedRun(s.root);
    // No resumable session, so the ladder reaches for an agent rung.
    delete state.phases['2'].sessionId;
    delete state.phases['2'].resumeSessionId;
    saveRun(state);

    const result = await svc.maybeAutoRecover('alpha');
    assert.equal(result.launched, false);
    assert.match(result.reason ?? '', /--allow-agent/, 'the refusal still names the flag');
    const after = loadRun(s.root, 'alpha', state.id)!;
    const errand = after.recoveries?.['2']?.errand;
    assert.ok(errand, 'and the person who can supply the flag is asked for it');
    assert.match(`${errand!.need} ${errand!.how}`, /allow-agent/);
  } finally { s.cleanup(); }
});

test('a QA-blocked done phase is a candidate the ladder can actually climb', async () => {
  // When the QA situations had no rungs, admitting a board-`done` phase to the
  // candidate list bought nothing — it produced a better-worded refusal and a
  // push duplicating the inbox's, at the cost of contradicting the documented
  // candidate contract ("their records are closed by the reconcile pass, not
  // diagnosed"). That was the right call then.
  //
  // It is not the right call now: `qa-failed` and `qa-pending` climb, so the
  // phase holding the plan is a phase the ladder can genuinely act on. The guard
  // stays for every OTHER done phase — a settled phase is still settled.
  const s = scratch();
  try {
    const svc = service(s.root);
    stubMint(svc);
    const state = qaWedgedRun(s.root);
    state.phases['1'].sessionId = 'sess-p1';   // the session that built it survives
    saveRun(state);

    const board = (await svc.board('alpha')).states;
    const candidates = await svc.classifyOpenPhases('alpha', state, board);
    assert.equal(candidates.length, 1, 'the phase holding the plan is now reachable');
    assert.equal(candidates[0].phase, 1);
    assert.equal(candidates[0].situation.key, 'qa-failed');
  } finally { s.cleanup(); }
});

test('a genuinely settled done phase is still not a candidate', async () => {
  // The guard's whole purpose: a phase the board reads done, with a clean
  // verdict, is finished work. Diagnosing it would spend a board read and a
  // classify per pass, for ever, on every plan.
  const s = scratch();
  try {
    const svc = service(s.root);
    stubMint(svc);
    // Phase 1 done and QA-passed; the run holds a record for it.
    mkdirSync(join(s.root, 'docs', 'handoffs', 'alpha'), { recursive: true });
    writeFileSync(
      join(s.root, 'docs', 'handoffs', 'alpha', 'phase-01-schema.md'),
      '---\nplan: docs/plans/alpha.md\nphase: 1\ntitle: schema\nstatus: complete\n---\n# done\n', 'utf8',
    );
    writeFileSync(
      join(s.root, 'docs', 'handoffs', 'alpha', 'test-status.md'),
      '# QA\n\n## QA status\n\n| Phase | Result | Report |\n|--:|--|--|\n| 1 | pass | reports/phase-01-qa.md |\n', 'utf8',
    );
    const state = newRun({ slug: 'alpha', root: s.root, autoRecover: true });
    state.status = 'parked';
    phaseRecord(state, 1).status = 'done';
    saveRun(state);

    const board = (await svc.board('alpha')).states;
    const candidates = await svc.classifyOpenPhases('alpha', state, board);
    assert.deepEqual(candidates.map((c) => c.phase), [], 'settled work is not diagnosed');
  } finally { s.cleanup(); }
});

test('a QA rung hands the session real commands, never placeholders', async () => {
  // A resumed session is mid-conversation and will run what it is given. A brief
  // that says `qa-record.sh <slug> <N>` is handing it a guess — and the one thing
  // this rung exists to produce is a verdict recorded in the right place under
  // the right name.
  const s = scratch();
  try {
    const svc = service(s.root);
    const build = (svc as unknown as {
      vehicleForRung: (
        rung: unknown, situation: unknown, record: unknown, evidence: unknown, slug: string,
      ) => { instruction?: string } | null;
    }).vehicleForRung.bind(svc);

    const record = { phase: 7, status: 'done', sessionId: 'sess-p7' };
    const evidence = { phase: 7, handoff: { exists: false }, qa: { mode: 'on', result: 'fail' } };

    for (const mode of ['qa-fix', 'qa-verdict']) {
      const vehicle = build(
        { vehicle: 'resume-own-session', params: { mode } }, { key: 'qa-failed' }, record, evidence, 'alpha',
      );
      const instruction = vehicle?.instruction ?? '';
      assert.match(instruction, /qa-record\.sh alpha 7/, `${mode}: the real slug and phase`);
      assert.match(instruction, /reports\/phase-07-qa\.md/, `${mode}: the real, zero-padded report path`);
      assert.doesNotMatch(instruction, /<slug>|<N>|<NN>/, `${mode}: no placeholder may survive into a brief`);
    }
  } finally { s.cleanup(); }
});

test('a phase whose handoff is on disk reports it as present, not absent', async () => {
  // `handoffFor` answers the parsed handoff or `undefined`; a `Handoff` carries
  // no `exists` field, so `handoff?.exists` was always undefined and EVERY phase
  // with a real handoff derived `{exists: false}`. Live on a real plan: one API
  // response carrying `phase.handoff.status: 'complete'` beside
  // `proof.handoff: 'absent'`, and a phase card telling the operator to "re-scan"
  // a file that was present, complete and already parsed. Two call sites share
  // the predicate, so this asserts through the SERVICE — `evidence-model.js` was
  // always right about what it was handed.
  const s = scratch();
  try {
    qaWedgedRun(s.root);            // writes a real phase-01 handoff, status: complete
    const svc = service(s.root);    // opened after, so the store's first scan sees it
    // `?include=handoffs`: the per-phase handoff REFERENCE has been behind a
    // projection since the payload phase (`shared/projection.js`) — 46.5 KB on
    // a real plan, and only the phase surfaces render it. `proof` is in the
    // board projection either way; this test asks for both in ONE response
    // because its whole subject is the two AGREEING.
    const detail = await svc.detail('alpha', undefined, new Set(['handoffs']));
    const phase1 = detail?.phases.find((p) => p.phase === 1);
    assert.ok(phase1, 'phase 1 must be in the detail');
    assert.equal(phase1!.handoff?.status, 'complete', 'the premise: the store parsed it');
    assert.equal(phase1!.proof?.handoff, 'complete', 'and the evidence must agree with the store');
    assert.ok(
      !(phase1!.proof?.why ?? []).some((w) => /handoff absent|re-scan/i.test(w)),
      `no "re-scan" about a file that is right there: ${(phase1!.proof?.why ?? []).join(' | ')}`,
    );
  } finally { s.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The last gate between a chosen QA rung and an actual launch
 * ------------------------------------------------------------------ */

test('preRecoveryGate: a done phase whose QA holds the plan is NOT superseded', async () => {
  // `preRecoveryGate` is the belt on every launch: it re-reads the board and
  // stands down when the board has moved past the halt. Its test for that is
  // `board[phase] === 'done'` — which is exactly true of the phase a QA verdict
  // is holding, and exactly the wrong conclusion about it. So the ladder chose
  // the right rung, and the gate refused it one line before the spawn:
  // "the board had already moved past the halt — records reconciled, nothing to
  // launch", on a plan where nothing had moved past anything.
  //
  // Keyed on the BOARD FACT, not on the halt's kind: the run that exposed this
  // was parked by an older build, so its halt carries no `kind` and no `phase`
  // at all, and any fix that reads the halt leaves every existing run wedged.
  const s = scratch();
  try {
    qaWedgedRun(s.root);
    const svc = service(s.root);
    const gate = (svc as unknown as {
      preRecoveryGate: (slug: string, state: RunState, phase: number) => Promise<string>;
    }).preRecoveryGate.bind(svc);

    const state = loadRun(s.root, 'alpha', (await svc.runFor('alpha'))!.id)!;
    // An OLD-style halt: no kind, no phase — the shape on disk right now.
    state.halt = { at: new Date().toISOString(), reason: 'nothing is ready to run: 6 phase(s) are still waiting.' };
    saveRun(state);

    assert.equal(await gate('alpha', state, 1), 'proceed',
      'a phase the QA gate is holding has not been overtaken by anything');
  } finally { s.cleanup(); }
});

test('preRecoveryGate: a genuinely finished phase is still superseded', async () => {
  // The guard's real job, unchanged: a phase the board finished and QA passed is
  // done, and launching anything for it would be spending on settled work.
  const s = scratch();
  try {
    mkdirSync(join(s.root, 'docs', 'handoffs', 'alpha'), { recursive: true });
    writeFileSync(
      join(s.root, 'docs', 'handoffs', 'alpha', 'phase-01-schema.md'),
      '---\nplan: docs/plans/alpha.md\nphase: 1\ntitle: schema\nstatus: complete\n---\n# done\n', 'utf8',
    );
    writeFileSync(
      join(s.root, 'docs', 'handoffs', 'alpha', 'test-status.md'),
      '# QA\n\n## QA status\n\n| Phase | Result | Report |\n|--:|--|--|\n| 1 | pass | reports/phase-01-qa.md |\n', 'utf8',
    );
    const svc = service(s.root);
    const gate = (svc as unknown as {
      preRecoveryGate: (slug: string, state: RunState, phase: number) => Promise<string>;
    }).preRecoveryGate.bind(svc);

    const state = newRun({ slug: 'alpha', root: s.root, autoRecover: true });
    state.status = 'parked';
    phaseRecord(state, 1).status = 'failed';
    state.halt = { at: new Date().toISOString(), reason: 'phase 1 failed', phase: 1, kind: 'verify-failed' };
    saveRun(state);

    assert.equal(await gate('alpha', state, 1), 'superseded',
      'finished work is finished — this is what the guard exists for');
  } finally { s.cleanup(); }
});

test('a run parked by an OLDER build still gets its QA wedge climbed', async () => {
  // End to end, on the shape that is actually on disk: a halt with no kind and
  // no phase, both records `done`, a recorded QA fail. Every earlier layer was
  // right — the candidate list admits phase 1, the ladder picks `qa-fix` — and
  // the launch was refused by the gate above. This is the assertion that would
  // have caught it.
  const s = scratch();
  try {
    qaWedgedRun(s.root);
    const svc = service(s.root);
    stubMint(svc);
    const state = loadRun(s.root, 'alpha', (await svc.runFor('alpha'))!.id)!;
    state.halt = { at: new Date().toISOString(), reason: 'nothing is ready to run: 6 phase(s) are still waiting.' };
    state.phases['1'].sessionId = 'sess-p1';
    state.phases['1'].resumeSessionId = 'sess-p1';
    saveRun(state);

    let resumed: { phase?: number; mode?: string; instruction?: string } | null = null;
    const pooled = svc.runnerFor('alpha') as unknown as {
      recover: (o: { phase?: number; mode?: string; instruction?: string }) => Promise<unknown>;
    };
    pooled.recover = async (o) => { resumed = o; return state; };

    const result = await svc.maybeAutoRecover('alpha');
    assert.equal(result.launched, true, `expected a launch, got: ${result.reason}`);
    assert.equal(result.phase, 1);
    assert.equal(result.situation, 'qa-failed');

    // The launch is fire-and-forget by design (the healer answers at once and
    // the session runs on), so wait for the drive rather than racing it.
    const deadline = Date.now() + 5_000;
    while (!resumed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(resumed?.phase, 1, 'and it really drove the phase holding the plan');
    assert.equal(resumed?.mode, 'resume');
    assert.match(resumed?.instruction ?? '', /qa-record\.sh alpha 1/);
  } finally { s.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Per-phase QA: `- **QA:** on|off` in a phase's own section
 * ------------------------------------------------------------------ */

/** A plan that gates on QA, with phase 2 opting out for itself. */
function perPhaseQaPlan(root: string): void {
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), `---
slug: alpha
created: 2026-08-22
status: active
phases: 3
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | docs   | — | — | app | it reads |
| 3 | ship   | 2 | — | app | it ships |

## Session budget

**QA gate:** on

## Phases

### Phase 1 — schema
- **Size:** S

### Phase 2 — docs
- **Size:** S
- **QA:** off

### Phase 3 — ship
- **Size:** S
`, 'utf8');
}

test('the console reads a phase\'s own QA regime, not just the plan\'s', async () => {
  const s = scratch();
  try {
    perPhaseQaPlan(s.root);
    const svc = service(s.root);
    assert.equal((await svc.qaMode('alpha')).mode, 'on', 'the plan gates');
    assert.equal((await svc.qaMode('alpha', 1)).mode, 'on', 'a silent phase inherits it');
    assert.equal((await svc.qaMode('alpha', 2)).mode, 'off', 'and a phase may exempt itself');
    assert.match((await svc.qaMode('alpha', 2)).reason ?? '', /phase directive/,
      'the reason says WHERE the answer came from — "why is this not being reviewed" is the real question');
  } finally { s.cleanup(); }
});

test('a QA-exempt phase is never treated as QA-held by the healer', async () => {
  // `qaHolds` decides whether a board-`done` phase is admitted to the candidate
  // list as a blocker. A phase the plan exempts is done work, not a blocker —
  // admitting it would have the ladder resume a session to produce a verdict
  // nothing is waiting for.
  const s = scratch();
  try {
    perPhaseQaPlan(s.root);
    mkdirSync(join(s.root, 'docs', 'handoffs', 'alpha'), { recursive: true });
    writeFileSync(
      join(s.root, 'docs', 'handoffs', 'alpha', 'test-status.md'),
      '# QA\n\n## QA status\n\n| Phase | Result | Report |\n|--:|--|--|\n| 1 | fail | - |\n| 2 | fail | - |\n',
      'utf8',
    );
    const svc = service(s.root);
    const holds = (svc as unknown as {
      qaHolds: (slug: string, phase: number) => Promise<boolean>;
    }).qaHolds.bind(svc);

    assert.equal(await holds('alpha', 1), true, 'phase 1 gates and its verdict is red');
    assert.equal(await holds('alpha', 2), false, 'phase 2 exempted itself — its row governs nothing');
  } finally { s.cleanup(); }
});

test('a rung is not settled while its own session is still running', async () => {
  // Observed on a live run: the `qa-fix` rung recorded `outcome: 'failed'`, note
  // "the run reads running", while its `claude` process was eight minutes into
  // doing exactly what it was asked. The settle block reads the run's status the
  // moment `recoverPhase` resolves and treats anything that is not
  // parked-without-halt as a failure — but `running` is not a verdict, it is the
  // absence of one, and a run that is still going has not failed at anything.
  //
  // The cost is a lie in the ledger and a premature escalation: the next climb
  // reads rung 1 as spent and reaches for the more expensive rung 2.
  const s = scratch();
  try {
    qaWedgedRun(s.root);
    const svc = service(s.root);
    stubMint(svc);
    const state = loadRun(s.root, 'alpha', (await svc.runFor('alpha'))!.id)!;
    state.halt = { at: new Date().toISOString(), reason: 'nothing is ready to run.' };
    state.phases['1'].sessionId = 'sess-p1';
    state.phases['1'].resumeSessionId = 'sess-p1';
    saveRun(state);

    // The recovery resolves, but the run is still being driven — exactly the
    // shape that produced the false verdict.
    const pooled = svc.runnerFor('alpha') as unknown as {
      recover: (o: unknown) => Promise<unknown>; current: () => unknown;
    };
    // What the real one does: by the time `recoverPhase` resolves, the drive
    // loop owns the run and it reads `running`. The settle block prefers the
    // pooled runner's own `current()` over a load, so that is what is faked —
    // a `loadRun` would reclaim a `running` record whose pid is not alive and
    // report `interrupted`, which is a different story.
    // The run as it really is on disk (rung and all), with the one field that
    // matters overridden — a plain copy of the pre-climb `state` would carry no
    // rung, and the settle would find nothing to settle, which is a green test
    // that proves nothing.
    const asRunning = () => {
      const live = loadRun(s.root, 'alpha', state.id);
      return live ? { ...live, status: 'running' as const } : null;
    };
    pooled.recover = async () => asRunning();
    pooled.current = () => asRunning();

    const result = await svc.maybeAutoRecover('alpha');
    assert.equal(result.launched, true);

    const deadline = Date.now() + 4_000;
    let rung: { outcome?: string } | undefined;
    while (Date.now() < deadline) {
      rung = loadRun(s.root, 'alpha', state.id)?.recoveries?.['1']?.rungs?.[0];
      if (rung?.outcome && rung.outcome !== 'running') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.notEqual(rung?.outcome, 'failed',
      `a rung whose run is still driving has not failed: ${JSON.stringify(rung)}`);
  } finally { s.cleanup(); }
});

test('a QA-held phase is exempt from "superseded" even when other phases are ready', async () => {
  // The exemption was guarded by `wedgeCleared` — "does the BOARD have anything
  // ready or in flight?" — which is a plan-wide fact answering a per-phase
  // question. Whether some unrelated chain has work says nothing about whether
  // THIS phase's verdict is holding its own dependents, and on any plan with a
  // parallel branch the exemption silently evaporated: the ladder picked the QA
  // rung and the gate refused it again, exactly as before the fix.
  //
  // It only looked right because the specimen that exposed the bug happened to
  // have an empty ready set.
  const s = scratch();
  try {
    // A plan with a parallel branch: 1 -> 2, and an independent 3. Phase 1's
    // verdict holds 2 while 3 sits ready — the ordinary shape of any real plan,
    // and the one the guard silently failed on.
    writeFileSync(join(s.root, 'docs', 'plans', 'alpha.md'), `---
slug: alpha
created: 2026-08-22
status: active
phases: 3
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema   | — | — | app | it works |
| 2 | after it | 1 | — | app | it still works |
| 3 | elsewhere| — | — | app | it ships |

## Session budget

**QA gate:** on

## Phases

### Phase 1 — schema
- **Size:** S

### Phase 2 — after it
- **Size:** S

### Phase 3 — elsewhere
- **Size:** S
`, 'utf8');
    qaWedgedRun(s.root);
    const svc = service(s.root);
    const board = (await svc.board('alpha')).states;
    assert.ok(Object.values(board).includes('ready'), `the premise: something else is ready — ${JSON.stringify(board)}`);

    const gate = (svc as unknown as {
      preRecoveryGate: (slug: string, state: RunState, phase: number) => Promise<string>;
    }).preRecoveryGate.bind(svc);
    const state = loadRun(s.root, 'alpha', (await svc.runFor('alpha'))!.id)!;
    assert.equal(await gate('alpha', state, 1), 'proceed',
      'a verdict holding this phase\'s dependents is not settled by other work being ready');
  } finally { s.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Declared parks — the ladder stands down, the watch does the work
 *
 * Specimen: the 2026-08-28 filters incident. A session declared needs-human
 * for a production outage (reason ending "…then run the 4 §Verification
 * cmds"); the healer re-classified the park as plan-broken:verification off
 * that prose, boarded three sessions that each re-confirmed the outage and
 * re-parked (each scored `failed`), spent the ladder, and overwrote the
 * declared errand with a plan-repair prescription. These pin the fixed
 * behaviour end to end at the healer.
 * ------------------------------------------------------------------ */

const OUTAGE = 'Prod outage: boxes down, runners offline. Operator must restore box #2. '
  + 'Then run the 4 §Verification cmds and flip the handoff.';
const OUTAGE_REFS = ['gh:acme/app#run/33123610977'];

/** The incident's disk shape: parked on a declared needs-human, rungs spent, errand overwritten. */
function declaredParkRun(root: string): RunState {
  const state = haltedRun(root, {
    status: 'parked',
    halt: {
      at: new Date().toISOString(),
      // The restart shape on purpose: `park()` wrote no kind before the fix,
      // so the record's persisted declaration must carry the classification.
      reason: `phase 2 needs a person: ${OUTAGE}`,
      phase: 2,
    },
  });
  const record = state.phases['2'];
  record.status = 'parked';
  record.note = OUTAGE;
  record.watch = [...OUTAGE_REFS];
  record.declared = { status: 'needs-human', reason: OUTAGE, watch: [...OUTAGE_REFS], at: new Date().toISOString() };
  record.sessionId = 'sess-own-1';
  (state.recoveries ??= {})['2'] = {
    attempts: 3,
    lastAt: new Date().toISOString(),
    rungs: [
      { situation: 'work-in-progress', rung: 'resume-own-session', at: new Date().toISOString(), outcome: 'interrupted' },
      { situation: 'work-in-progress', rung: 'reboard-resume-brief', at: new Date().toISOString(), outcome: 'failed' },
      { situation: 'work-in-progress', rung: 'reboard-resume-brief', at: new Date().toISOString(), outcome: 'running' },
    ],
    errand: {
      phase: 2, situation: 'plan-broken:verification', at: new Date().toISOString(),
      tried: ['resume-own-session → interrupted', 'reboard-resume-brief → failed'],
      need: 'A plan, handoff or INDEX that passes validate.sh (or a runnable §Verification for the phase).',
      how: 'Open the plan, fix what the health panel names, then Retry — or press Repair with a new agent.',
    },
  };
  saveRun(state);
  return state;
}

/**
 * The healer's OLD probe seam, kept as a tripwire.
 *
 * Polling moved to `watch-scheduler.ts` (console-unattended-autopilot P2): the
 * healer no longer asks about a ref at all, because the convergence sweep is
 * five minutes wide and answers a different question. If a future change puts a
 * poll back on this path, this array stops being empty and the tests below say
 * so — which is more useful than deleting the helper, since "the healer polls
 * again" is exactly the regression that would restore the two-day p12 park.
 */
function stubWatch(svc: ReturnType<typeof service>, state: 'pending' | 'landed' | 'unknown') {
  const probes: string[] = [];
  (svc as unknown as Record<string, unknown>).probeWatch = async (target: { ref: string }) => {
    probes.push(target.ref);
    return { ref: target.ref, state, ...(state === 'landed' ? { detail: 'completed: success' } : {}) };
  };
  return probes;
}

test('a declared needs-human park stands the ladder down: no rung, no-defect settle, the errand heals', async () => {
  const s = scratch();
  try {
    const state = declaredParkRun(s.root);
    const svc = service(s.root);
    const probes = stubWatch(svc, 'pending');

    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, false, 'testimony is not a failure — nothing is boarded against it');
    assert.match(out.reason ?? '', /declared needs-human/);
    assert.match(out.reason ?? '', /watching its refs/,
      'the refs are still named to the operator — the WATCH CLOCK is what checks them');
    assert.deepEqual(probes, [], 'and the healer itself does not poll: that is the scheduler\'s clock now');

    const after = loadRun(s.root, 'alpha', state.id)!;
    const slot = after.recoveries!['2']!;
    // The open rung's session did its job — it re-checked and re-declared the
    // park. `failed` here is what escalated the outage up the model ladder.
    assert.equal(slot.rungs!.at(-1)!.outcome, 'no-defect');
    assert.equal(slot.rungs!.length, 3, 'and no fourth rung was climbed');
    // The overwritten errand heals back to the declaration's own words.
    assert.match(slot.errand!.situation, /^blocked-declared/);
    assert.equal(slot.errand!.need, OUTAGE);
    assert.match(slot.errand!.how, /watching its refs/);
  } finally { s.cleanup(); }
});

test('the healer does not poll refs at all — that clock is the scheduler\'s', async () => {
  // It used to, and the coupling is what cost two days on
  // `aug-create-order-filters-remediation` p12: the poll only happened when a
  // five-minute convergence sweep visited the plan, behind a `noops` latch that
  // was telling the truth (nothing the healer reads HAD changed). The dedupe
  // this test used to assert now lives with the rotation that owns it —
  // `the-clock-is-evidence.test.ts`, "a pending ref inside its cadence costs
  // nothing" and "pending -> pending is not a transition".
  const s = scratch();
  try {
    const state = declaredParkRun(s.root);
    const svc = service(s.root);
    const probes = stubWatch(svc, 'pending');

    await svc.maybeAutoRecover('alpha');
    await svc.maybeAutoRecover('alpha');
    assert.deepEqual(probes, [], 'no probe, however many sweeps');
    const journal = readFileSync(
      join(runDir(s.root, 'alpha'), `run-${state.id}.jsonl`), 'utf8',
    ).trim().split('\n').map((line) => JSON.parse(line) as { event: string });
    assert.equal(journal.filter((row) => row.event === 'phase.watch-checked').length, 0,
      'and no watch line on the converge path');
  } finally { s.cleanup(); }
});

test('a landing resumes the phase\'s own session — the declaration SURVIVES, no rung is charged', async () => {
  const s = scratch();
  try {
    const state = declaredParkRun(s.root);
    const svc = service(s.root);
    const resumed: Array<{ phase: number; mode: string; instruction?: string }> = [];
    (svc as unknown as Record<string, unknown>).recoverPhase = async (
      _slug: string, phase: number, mode: string, opts: { instruction?: string } = {},
    ) => {
      resumed.push({ phase, mode, instruction: opts.instruction });
      // A session ran and ended: the settlement reads the record's own attempt
      // bookkeeping, and a stub that leaves it untouched is a drive that
      // launched NOTHING — which is un-charged by design (H1). Move `endedAt`
      // exactly as a real attempt's teardown would.
      const fresh = loadRun(s.root, 'alpha', state.id)!;
      fresh.phases['2'].endedAt = new Date().toISOString();
      saveRun(fresh);
      return fresh;
    };

    // Driven through the scheduler's one call into the healer, which is how a
    // landing now arrives — the healer is handed a verdict, it does not go and
    // fetch one.
    const live = loadRun(s.root, 'alpha', state.id)!;
    await (svc as unknown as {
      onWatchLanded: (slug: string, st: RunState, phase: number, landed: { ref: string; state: string; detail?: string }) => Promise<void>;
    }).onWatchLanded('alpha', live, 2, {
      ref: OUTAGE_REFS[0], state: 'landed', detail: 'completed: success',
    });

    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].phase, 2);
    assert.equal(resumed[0].mode, 'resume');
    assert.match(resumed[0].instruction ?? '', /has landed: gh:acme\/app#run\/33123610977/);

    const after = loadRun(s.root, 'alpha', state.id)!;
    // The landing rides ON the declaration, so the two are retired together and
    // a landing can never outlive the wait it answers.
    assert.equal(after.phases['2'].declared?.landed?.ref, OUTAGE_REFS[0]);
    assert.equal(after.phases['2'].declared?.landed?.resumes, 1);
    // R1: the declaration is the SESSION's testimony, and the resume it is
    // handed to may queue, cap or fail to spawn. It used to be deleted here,
    // before admission — so exactly the failures this resume exists to survive
    // destroyed the evidence of what the phase was waiting for, and its next
    // classification read "no handoff, no declaration" and called the plan
    // broken. Only the session producing a turn spends it.
    assert.equal(after.phases['2'].declared?.status, 'needs-human', 'the testimony outlives the resume');
    assert.equal(after.phases['2'].watchResumes, 1, 'the landing is counted, so it cannot re-fire for ever');
    assert.equal(after.recoveries!['2']!.attempts, 3, 'the resume is the declared plan, not a ladder spend');
    assert.equal(after.recoveries!['2']!.rungs!.length, 3, 'and no rung was appended for it');
    // The stale `running` rung this fixture carries is settled by the HEALER's
    // arm on its own pass (the first test in this group asserts the
    // `no-defect`), not by a landing. A landing is a fact about the world; it
    // is not an outcome for a rung somebody else opened, and having it settle
    // one would mean the ladder's ledger could be written by a `gh` poll.
  } finally { s.cleanup(); }
});

/**
 * A clock for driving `WatchScheduler.tick()` by hand: its timers never fire,
 * so nothing races the test and nothing holds the process open.
 */
const STILL_CLOCK = {
  now: () => Date.now(),
  setTimeout: (_fn: () => void, _ms: number): unknown => 0,
  clearTimeout: (_h: unknown): void => {},
};

/** The healer's own settlement is asynchronous — let it run. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

test('a REJECTING recoverPhase un-charges the delivery, and the landing is offered again next cadence', async () => {
  // QA round 3, H1(b) — the E1 shape, 5/5 deterministic against `9fd36ad`. The
  // `.catch` rollback un-charged `watchResumes` but its `delete
  // row.deliveredAt` was a NO-OP: the scheduler stamped the receipt AFTER the
  // rejection had already settled, leaving 0 charges (the errand unreachable)
  // AND a permanent gate — an eternal wait with no errand at all. The stamp is
  // now written in `resumeOnWatchLanded`, before the drive, where this rollback
  // can reach it; the hold while the drive settles is `watchResumeInFlight`.
  const s = scratch();
  try {
    const state = declaredParkRun(s.root);
    const svc = service(s.root);
    let calls = 0;
    (svc as unknown as Record<string, unknown>).recoverPhase = async () => {
      calls += 1;
      throw new Error('alpha is in progress. Pause or stop it before recovering a phase.');
    };

    const live = loadRun(s.root, 'alpha', state.id)!;
    const scheduler = new WatchScheduler({
      clock: STILL_CLOCK,
      runs: () => [{ slug: 'alpha', state: live }],
      probe: async (t: { ref: string }) => ({ ref: t.ref, state: 'landed' as const, detail: 'completed: success' }),
      // The `async`/`await` wrapper is LOAD-BEARING for the red-first proof: it
      // adds the one promise hop that pins QA round 3's measured E1 ordering —
      // the healer's `.catch` rollback settling BEFORE the scheduler's stamp
      // used to be written, which is what made the old receipt un-revocable
      // (the delete ran against a row that had no stamp yet). Against the fix
      // the ordering is irrelevant, because the scheduler writes no stamp at
      // all — which is the point.
      onLanded: async (sl: string, st: RunState, ph: number, l: { ref: string; state: string }) =>
        await (svc as unknown as {
          onWatchLanded: (sl: string, st: RunState, ph: number, l: unknown) => Promise<'resumed' | 'deferred' | 'done'>;
        }).onWatchLanded(sl, st, ph, l),
      resumeInFlight: (sl: string, ph: number) => svc.watchResumeInFlight(sl, ph),
      save: () => {},
    });
    scheduler.open();
    try {
      await scheduler.tick();
      await settled();
      assert.equal(calls, 1);

      const rec = () => live.phases['2'];
      const row = () => rec().watchState!.refs[0];
      // The rollback reached BOTH halves of the delivery — the count and the
      // stamp. Deleting the rollback body (mutation M-G1c) turns this red.
      assert.equal(rec().watchResumes, undefined, 'the charge is rolled back — nothing was resumed');
      assert.equal(row().deliveredAt, undefined, 'and the stamp with it — it was written where the rollback lives');

      // Next cadence: the landing is offered AGAIN. At `9fd36ad` the stamp
      // gated this for ever (`endedAt` was never going to move).
      row().nextDueAt = 0;
      await scheduler.tick();
      await settled();
      assert.equal(calls, 2, 'offered again next cadence — the drive settled and held nothing');

      // …and the landing was journalled ONCE, not once per delivery: the
      // dedupe (`watchLandedJournalledFor`) has a test at last (M-G6).
      const journal = readFileSync(
        join(runDir(s.root, 'alpha'), `run-${state.id}.jsonl`), 'utf8',
      ).trim().split('\n').map((line) => JSON.parse(line) as { event: string });
      assert.equal(journal.filter((r) => r.event === 'phase.watch-landed').length, 1,
        'one landing, one line — a re-delivery is the console\'s own willingness to act, not news');
    } finally { scheduler.close(); }
  } finally { s.cleanup(); }
});

test('a recoverPhase that RESOLVES without launching does not spend the offer for ever', async () => {
  // QA round 3, H1(a) — the B2 shape: an adopt-orphan refusal, a cancelled
  // admission, a superseded gate and a null retry all RESOLVE having started
  // no session. Each was stamped as a delivery, and because no attempt would
  // ever end, the stamp gated the landing for ever — one offer in a simulated
  // week, no errand, the p12 park re-created by the receipt meant to end it.
  // The settlement now reads what the drive left behind (`endedAt` unmoved, no
  // runner driving) and un-charges the delivery.
  const s = scratch();
  try {
    const state = declaredParkRun(s.root);
    const svc = service(s.root);
    let calls = 0;
    (svc as unknown as Record<string, unknown>).recoverPhase = async () => {
      calls += 1;
      return loadRun(s.root, 'alpha', state.id); // resolves; launches nothing
    };

    const live = loadRun(s.root, 'alpha', state.id)!;
    const scheduler = new WatchScheduler({
      clock: STILL_CLOCK,
      runs: () => [{ slug: 'alpha', state: live }],
      probe: async (t: { ref: string }) => ({ ref: t.ref, state: 'landed' as const, detail: 'completed: success' }),
      onLanded: (sl: string, st: RunState, ph: number, l: { ref: string; state: string }) =>
        (svc as unknown as {
          onWatchLanded: (sl: string, st: RunState, ph: number, l: unknown) => Promise<'resumed' | 'deferred' | 'done'>;
        }).onWatchLanded(sl, st, ph, l),
      resumeInFlight: (sl: string, ph: number) => svc.watchResumeInFlight(sl, ph),
      save: () => {},
    });
    scheduler.open();
    try {
      await scheduler.tick();
      await settled();
      assert.equal(calls, 1);
      assert.equal(live.phases['2'].watchResumes, undefined,
        'a drive that launched nothing is un-charged at settlement');
      assert.equal(live.phases['2'].watchState!.refs[0].deliveredAt, undefined,
        'and leaves no stamp behind');

      live.phases['2'].watchState!.refs[0].nextDueAt = 0;
      await scheduler.tick();
      await settled();
      assert.equal(calls, 2, 'the offer is not spent for ever');
    } finally { scheduler.close(); }
  } finally { s.cleanup(); }
});

test('a phase\'s SECOND wait gets its own three offers — the first wait\'s spent count does not survive', async () => {
  // QA round 3, H2 — the D2 shape, end to end. `watchResumes` and
  // `watchLandedErrandFor` were deleted only by `resetForRetry`, so a session
  // that produced work and then declared a NEW wait inherited both: its very
  // first landing went straight to the over-cap branch and wrote an errand
  // reading "3 resumes of this phase produced nothing" — about resumes that
  // never happened, for a declaration one landing old.
  const s = scratch();
  try {
    const state = declaredParkRun(s.root);
    const svc = service(s.root);
    const resumed: number[] = [];
    (svc as unknown as Record<string, unknown>).recoverPhase = async (_slug: string, phase: number) => {
      resumed.push(phase);
      // The resume launches: move `endedAt` as a real attempt's teardown would,
      // or the settlement un-charges the delivery as one that started nothing.
      const fresh = loadRun(s.root, 'alpha', state.id)!;
      fresh.phases['2'].endedAt = new Date().toISOString();
      saveRun(fresh);
      return fresh;
    };

    const live = loadRun(s.root, 'alpha', state.id)!;
    const rec = live.phases['2'];
    // The FIRST wait burned all its offers…
    rec.watchResumes = 4;
    rec.watchLandedErrandFor = OUTAGE_REFS[0];
    // …then the resumed session produced a turn (the one licence the boarding
    // path takes), and declared a brand-new wait on a DIFFERENT ref — exactly
    // what the outcome arms write.
    consumeDeclaration(rec, 'session-productive');
    rec.declared = {
      status: 'needs-human', reason: 'the second wait',
      watch: ['gh:acme/app#run/44444444444'], at: new Date().toISOString(),
    };
    rec.watch = ['gh:acme/app#run/44444444444'];
    saveRun(live);

    await (svc as unknown as {
      onWatchLanded: (sl: string, st: RunState, ph: number, l: unknown) => Promise<'resumed' | 'deferred' | 'done'>;
    }).onWatchLanded('alpha', live, 2, {
      ref: 'gh:acme/app#run/44444444444', state: 'landed', detail: 'completed: success',
    });

    assert.deepEqual(resumed, [2], 'the second wait\'s first landing RESUMES — it does not inherit a spent budget');
    assert.equal(live.phases['2'].watchResumes, 1, 'its count starts at one');
    assert.notEqual(live.phases['2'].watchLandedErrandFor, 'gh:acme/app#run/44444444444',
      'and no over-cap errand is written against it');
  } finally { s.cleanup(); }
});

test('a declared park stands down whatever its refs say — never a resume, never the old session burn', async () => {
  // The `unknown` case used to be reachable here because the healer polled.
  // Now it never resumes on this path at all, whatever the world is doing:
  // the ONLY door to a resume is a `landed` verdict handed in by the watch
  // clock, which is a strictly narrower promise than the one this test made.
  const s = scratch();
  try {
    declaredParkRun(s.root);
    const svc = service(s.root);
    const probes = stubWatch(svc, 'unknown');
    const out = await svc.maybeAutoRecover('alpha');
    assert.equal(out.launched, false);
    assert.match(out.reason ?? '', /declared needs-human/);
    assert.deepEqual(probes, []);
  } finally { s.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The posture sweep (console-parallel-repaint P12): standing errands, one
 * more rung while the work is moving, and the switch an errand names
 * ------------------------------------------------------------------ */

test('a person\'s errand STANDS across sweeps: written once, never rewritten with a fresh clock, one journal line', async () => {
  // Measured before this: one manual gate written 51 times in a day, one
  // declared blocker 16 times in five hours — every five-minute sweep re-ran
  // the exhaustion path, minted a new `at`, and (the announcer keys on `at`)
  // re-pushed the same ask.
  const s = scratch();
  try {
    const svc = service(s.root);
    stubMint(svc);
    const state = haltedRun(s.root);
    state.recoveries = { 2: { attempts: 5, lastAt: new Date().toISOString() } };
    saveRun(state);

    const first = await svc.maybeAutoRecover('alpha');
    assert.equal(first.launched, false);
    const written = loadRun(s.root, 'alpha', state.id)!.recoveries?.['2']?.errand;
    assert.ok(written, 'the first sweep writes the errand');

    const second = await svc.maybeAutoRecover('alpha');
    assert.equal(second.launched, false);
    assert.match(second.reason ?? '', /has stood since/, 'the pass says it looked and found the ask already standing');
    const after = loadRun(s.root, 'alpha', state.id)!.recoveries?.['2']?.errand;
    assert.equal(after?.at, written!.at, 'the errand keeps the clock it was first written on');
    const journal = readFileSync(join(runDir(s.root, 'alpha'), `run-${state.id}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as { event: string });
    assert.equal(journal.filter((j) => j.event === 'phase.errand').length, 1, 'one journal line, not one per sweep');
  } finally { s.cleanup(); }
});

test('ladderExtendOnProgress: a spent rung count is widened ONCE when the newest settled rung landed commits — off by default, never twice', async () => {
  const s = scratch();
  try {
    // Dated commits, so "since the rung began" is a fact and not a race:
    // the seed predates the rung, the progress commit follows it.
    const dated = (when: string) => ({
      ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when,
    });
    execFileSync('git', ['init', '-q'], { cwd: s.root, env: dated('2026-01-01T00:00:00Z') });
    execFileSync('git', ['add', '-A'], { cwd: s.root, env: dated('2026-01-01T00:00:00Z') });
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: s.root, env: dated('2026-01-01T00:00:00Z') });
    const svc = service(s.root);
    stubMint(svc);
    const sessions = stubSession(svc);
    svc.prefs.ladderPerPhaseRungs = 1;
    const state = haltedRun(s.root);
    const rungAt = '2026-06-01T00:00:00.000Z';
    state.recoveries = {
      2: {
        attempts: 1, lastAt: rungAt,
        rungs: [{ situation: 'verify-red', rung: 'resume-own-session', params: { mode: 'fix-verification' }, at: rungAt, outcome: 'failed', costUsd: 2 }],
      },
    };
    saveRun(state);

    // Nothing landed since the rung: the count is the count, whatever the switch says.
    svc.prefs.ladderExtendOnProgress = true;
    const flat = await svc.maybeAutoRecover('alpha');
    assert.equal(flat.launched, false);
    assert.match(flat.reason ?? '', /1 of 1 rungs/);

    // A commit lands after the rung began …
    writeFileSync(join(s.root, 'progress.txt'), 'moved\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: s.root, env: dated('2026-08-01T00:00:00Z') });
    execFileSync('git', ['commit', '-qm', 'progress'], { cwd: s.root, env: dated('2026-08-01T00:00:00Z') });

    // … which changes nothing while the switch is off (the shipped default) …
    svc.prefs.ladderExtendOnProgress = false;
    const off = await svc.maybeAutoRecover('alpha');
    assert.equal(off.launched, false, 'off by default: the errand stands');
    assert.match(off.reason ?? '', /1 of 1 rungs/);

    // … and buys exactly one more rung — the stronger agent — when it is on.
    svc.prefs.ladderExtendOnProgress = true;
    const widened = await svc.maybeAutoRecover('alpha');
    assert.equal(widened.launched, true, widened.reason);
    assert.equal(widened.rung, 'fix-agent');
    assert.equal(sessions.length, 1);
    const after = loadRun(s.root, 'alpha', state.id)!;
    assert.equal(after.recoveries?.['2']?.extended?.commits, 1);
    assert.equal(after.recoveries?.['2']?.extended?.since, rungAt);
    assert.equal(after.recoveries?.['2']?.extended?.situation, 'verify-red');
    const journal = () => readFileSync(join(runDir(s.root, 'alpha'), `run-${state.id}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as { event: string; data: Record<string, unknown> });
    const extended = journal().filter((j) => j.event === 'phase.ladder-extended');
    assert.equal(extended.length, 1);
    assert.equal(extended[0].data.perPhaseRungs, 2);
    assert.equal(extended[0].data.by, 'ladderExtendOnProgress');
    assert.match(String(extended[0].data.was), /1 of 1 rungs/);

    // Once per phase: the extra rung climbed, the count is spent again and the
    // grant is not repeated — the errand, not a third session.
    svc.syncRecoveredRun({ kind: 'fix', slug: 'alpha', phase: 2, runId: state.id }, { fixed: false, headline: '', detail: '' });
    const spent = await svc.maybeAutoRecover('alpha');
    assert.equal(spent.launched, false, spent.reason);
    assert.equal(journal().filter((j) => j.event === 'phase.ladder-extended').length, 1, 'never twice');
    assert.equal(sessions.length, 1);
  } finally { s.cleanup(); }
});

test('an errand whose only rung this console cannot drive names the switch — the flag, or the preference — instead of reading as if no rung existed', async () => {
  const { root, cleanup } = scratch();
  try {
    // Without --allow-writes the free deterministic rung is unavailable and
    // `nextRung` answers "no rung … is available on this console yet"; the
    // card used to carry that sentence and nothing a person could do about it.
    const svc = service(root, { allowWrites: false, allowAgent: false, allowRun: false });
    stubMint(svc, 'no');
    const run = verificationParkedRun(root);
    const result = await svc.maybeAutoRecover('alpha');
    assert.equal(result.launched, false);
    const errand = loadRun(root, 'alpha', run.id, null)?.recoveries?.['1']?.errand;
    assert.ok(errand, result.reason);
    assert.match(errand!.how, /repair-artefacts\.sh alpha --apply/);
    assert.match(errand!.how, /--allow-writes/);
  } finally { cleanup(); }
});

test('a ladder whose only rung a PREFERENCE switched off names that preference on the errand', async () => {
  // `unblockAttempts` off makes `unblock-session` undrivable, so `nextRung`
  // answers "no rung … is available on this console yet" — a sentence that
  // reached the journal and never the person who could flip the switch.
  const s = scratch();
  try {
    const svc = service(s.root);
    stubMint(svc);
    stubSession(svc);
    svc.prefs.unblockAttempts = false;
    const state = haltedRun(s.root);
    // A blocked handoff with a blocker no machine category fits.
    writeFileSync(
      join(s.root, 'docs', 'handoffs', 'alpha', 'phase-02-service.md'),
      '---\nplan: docs/plans/alpha.md\nphase: 2\ntitle: service\nstatus: blocked\n---\n# blocked\n\n'
        + '## Outstanding / blockers\n\nThe owner has to decide which of the two schemas the service keeps.\n',
      'utf8',
    );
    const result = await svc.maybeAutoRecover('alpha');
    assert.equal(result.launched, false);
    assert.match(result.reason ?? '', /no rung for blocked-declared:unknown is available/);
    const errand = loadRun(s.root, 'alpha', state.id)?.recoveries?.['2']?.errand;
    assert.ok(errand, result.reason);
    assert.equal(errand!.situation, 'blocked-declared:unknown');
    assert.match(errand!.how, /Unblock attempts are off in Settings ▸ Automation/);
  } finally { s.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * A QA-pending phase whose own session is gone gets a FRESH review
 * ------------------------------------------------------------------ */

function stubQaRecover(svc: ReturnType<typeof service>): Array<{ phase: number; opts: Record<string, unknown> }> {
  const calls: Array<{ phase: number; opts: Record<string, unknown> }> = [];
  (svc as never as Record<string, unknown>).qaRecover =
    async (_slug: string, phase: number, opts: Record<string, unknown> = {}) => {
      calls.push({ phase, opts });
      return null;
    };
  return calls;
}

test('a qa-pending phase whose own session is gone is reviewed by a fresh session, through the QA loop', async () => {
  // Measured (run 65958e6e, phase 7): the only rung `qa-pending` had resumed a
  // session the CLI could not find, and the errand that followed told the
  // operator to run QA from the phase page — a review the console can board
  // itself from the boot prompt, which is exactly what `qa-rerun` does when
  // no session exists.
  const s = scratch();
  try {
    const svc = service(s.root);
    stubMint(svc);
    const calls = stubQaRecover(svc);
    const state = qaPendingRun(s.root);
    const at = new Date().toISOString();
    state.phases['1'].sessionId = 'sess-p1';
    state.phases['1'].sessionGone = { sessionId: 'sess-p1', at, reason: 'the CLI holds no conversation under that id here' };
    state.recoveries = {
      1: {
        attempts: 1, lastAt: at,
        rungs: [{
          situation: 'qa-pending', rung: 'resume-own-session', at, outcome: 'failed',
          params: { mode: 'qa-verdict' }, note: 'session sess-p1 cannot be resumed under this account',
        }],
      },
    };
    saveRun(state);

    const result = await svc.maybeAutoRecover('alpha');
    assert.equal(result.launched, true, JSON.stringify(result));
    assert.equal(result.rung, 'fix-agent');
    assert.equal(result.vehicle, 'qa-rerun');
    assert.equal(calls.length, 1, 'the healer drives the review through the QA recovery loop');
    assert.equal(calls[0].phase, 1);
    assert.equal(calls[0].opts.verb, 'qa-rerun');
    assert.equal(calls[0].opts.strategy, 'fresh');
    assert.equal(calls[0].opts.qaMaxRounds, 1);
    assert.equal(calls[0].opts.by, 'auto-recovery');
    const rungs = loadRun(s.root, 'alpha', state.id)!.recoveries?.['1']?.rungs ?? [];
    assert.equal(rungs.at(-1)?.rung, 'fix-agent');
    assert.equal(rungs.at(-1)?.params?.mode, 'qa-review');
  } finally { s.cleanup(); }
});

test('a gone session skips the own-session rung outright — the fresh review is the first thing tried', async () => {
  const s = scratch();
  try {
    const svc = service(s.root);
    stubMint(svc);
    const calls = stubQaRecover(svc);
    const state = qaPendingRun(s.root);
    state.phases['1'].sessionId = 'sess-p1';
    state.phases['1'].sessionGone = { sessionId: 'sess-p1', at: new Date().toISOString(), reason: 'its transcript is not under the account this run pays with' };
    saveRun(state);

    const result = await svc.maybeAutoRecover('alpha');
    assert.equal(result.launched, true, JSON.stringify(result));
    assert.equal(result.rung, 'fix-agent');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.strategy, 'fresh');
  } finally { s.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The record follows the ledger
 * ------------------------------------------------------------------ */

test('the sweep refreshes the record from the ledger: a later pass lands its round and drops the stale situation', async () => {
  // Measured (run 3cd7abf5, phase 8): the ledger held round 1 fail and round 2
  // pass; the record still said `qa: [{round 1, fail}]` and `situation:
  // qa-failed` from an hour earlier, although the healer had cleared the
  // errand on that very verdict. The merge lived only in `climb()`.
  const s = scratch();
  try {
    const svc = service(s.root);
    stubMint(svc);
    const state = qaWedgedRun(s.root);
    const at = new Date().toISOString();
    state.phases['1'].qa = [{ round: 1, verdict: 'fail', reportPath: 'reports/phase-01-qa.md', at }];
    state.phases['1'].situation = { key: 'qa-failed', at, why: ['the board reads done', 'QA is on and the recorded verdict is fail'] };
    state.recoveries = {
      1: {
        attempts: 1, lastAt: at,
        rungs: [{ situation: 'qa-failed', rung: 'resume-own-session', at, outcome: 'running', params: { mode: 'qa-fix' }, turns: 40 }],
        errand: { phase: 1, situation: 'qa-failed', tried: [], need: 'A QA verdict', how: 'fix it', at },
      },
    };
    saveRun(state);
    // The resumed session fixed it and recorded round 2: a pass, in the ledger.
    writeFileSync(
      join(s.root, 'docs', 'handoffs', 'alpha', 'test-status.md'),
      '# QA\n\n## QA status\n\n| Phase | Result | Report | Round |\n|--:|--|--|--:|\n| 1 | pass | reports/phase-01-qa-round2.md | 2 |\n\n'
      + '## QA rounds\n\n| Phase | Round | Result | Report | Recorded |\n|--:|--:|--|--|--|\n'
      + '| 1 | 1 | fail | reports/phase-01-qa.md | 2026-09-05 |\n| 1 | 2 | pass | reports/phase-01-qa-round2.md | 2026-09-05 |\n',
      'utf8',
    );

    await svc.maybeAutoRecover('alpha');
    const after = loadRun(s.root, 'alpha', state.id)!;
    const record = after.phases['1'];
    assert.deepEqual(record.qa?.map((r) => [r.round, r.verdict]), [[1, 'fail'], [2, 'pass']], 'both rounds, in order, from the file');
    assert.equal(record.qa?.[1]?.reportPath, 'reports/phase-01-qa-round2.md');
    assert.equal(record.situation, undefined, 'a situation the verdict has answered is not left standing');
    assert.equal(after.recoveries?.['1']?.errand, undefined, 'and the errand dissolved with it');
    assert.equal(after.recoveries?.['1']?.rungs?.[0]?.outcome, 'fixed');
  } finally { s.cleanup(); }
});
