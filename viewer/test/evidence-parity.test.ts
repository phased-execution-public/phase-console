/**
 * ONE lock clock, ONE evidence builder.
 *
 * Two derivations in this console used to answer the same question twice, and
 * the copies disagreed in production:
 *
 *  - **The lock clock (D3).** `Scheduler.lockLapsed` decided expiry by the
 *    clock; `Service.evidenceDeps.lock` forwarded the `expired` bit the store
 *    FROZE at its last scan. For the same lock in the same second the scheduler
 *    said "lapsed, the queue may go" while the situation classifier said
 *    `foreign-live` — a situation with no rung — where `foreign-stale` has a
 *    takeover one. The healer could not reach that rung until an unrelated file
 *    changed and the store re-scanned.
 *
 *  - **The evidence builder (D4).** The Service built one set of
 *    `EvidenceDeps`; the Runner built its own. The Runner's lacked
 *    `gateDelegated`, so with `delegateHumanGates` on a delegated gate parked
 *    with an errand for a gate nobody needed to clear — delegation silently did
 *    nothing for exactly the phases it gets turned on for. It also shelled
 *    `phase-lock.sh status` per classification to re-derive a lock the console
 *    already held.
 *
 * So the pins here are equalities, not behaviours: the same function answers
 * "has this lapsed" for every reader, and the two builders produce byte-
 * identical `PhaseEvidence` for one fixture phase under one clock.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { lockLapsed } = await import('../server/runner/scheduler.ts');
const { classifySituation, collectEvidence } = await import('../server/runner/situation.ts');
const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');

type RunState = import('../server/runner/state.ts').RunState;
type PhaseEvidence = import('../server/runner/situation.ts').PhaseEvidence;

const SCRIPTS = join(SKILL_DIR, 'scripts');
const FIXED = new Date('2026-08-23T04:00:00.000Z');

const PLAN = `---
slug: alpha
created: 2026-08-23
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

const OPEN: Array<{ close: () => void }> = [];

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-evidence-parity-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  writeFileSync(
    join(root, 'docs', 'handoffs', 'alpha', 'phase-01-schema.md'),
    '---\nplan: docs/plans/alpha.md\nphase: 1\ntitle: schema\nstatus: complete\n---\n# done\n',
    'utf8',
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: true,
    scriptsDir: SCRIPTS, logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  OPEN.push(svc);
  return svc;
}

function runFor(root: string): RunState {
  const state = newRun({ slug: 'alpha', root, autoRecover: true });
  state.activePhase = 2;
  phaseRecord(state, 2).status = 'failed';
  saveRun(state);
  return state;
}

test.after(() => { for (const svc of OPEN) svc.close(); });

/* ------------------------------------------------------------------ *
 * D3 — the lock clock
 * ------------------------------------------------------------------ */

test('lockLapsed is THE lock clock: the frozen bit, the lease, and the registry', () => {
  const now = 1_000_000;
  const future = { expired: false, leaseUntil: now + 60_000 };
  const past = { expired: false, leaseUntil: now - 1 };

  assert.equal(lockLapsed({ expired: true }, now), true,
    'a store that already decided expired stays expired');
  assert.equal(lockLapsed(past, now), true,
    'a lease that lapsed since the last scan is lapsed NOW — the whole point of a clock');
  assert.equal(lockLapsed(future, now), false);
  assert.equal(lockLapsed({ expired: false }, now), false,
    'no lease and no frozen bit is not evidence of a lapse');

  // Presence outranks the lease in one direction only: an ended session's claim
  // is debris the moment it ends (the registry knows before the lease does), but
  // a LIVE session cannot extend a lease that has already run out.
  assert.equal(lockLapsed(future, now, 'ended'), true);
  assert.equal(lockLapsed(future, now, 'live'), false);
  assert.equal(lockLapsed(future, now, 'unknown'), false);
  assert.equal(lockLapsed(past, now, 'live'), true,
    'a live session does not renew a lapsed lease by existing');
});

test('the classifier reads the lock CLOCK, not the bit the store froze', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const state = runFor(root);

    // Exactly the drift shape: the store scanned while the lease was still
    // good (`expired: false`) and the lease has lapsed since. Nothing on disk
    // changed, so nothing re-scanned it — which is why the frozen bit was
    // wrong for as long as the plan folder sat still.
    const record = svc.store!.get('alpha')!;
    (record as unknown as { locks: unknown[] }).locks = [{
      slug: 'alpha', phase: 2, owner: 'someone/else', expired: false,
      leaseUntil: Date.now() - 60_000, file: join(root, 'docs/handoffs/alpha/.locks/phase-02.lock'),
    }];

    const { evidence, situation } = await svc.classifyPhase('alpha', 2, state, { 1: 'done', 2: 'ready' });
    assert.equal(evidence.lock?.holder, 'someone/else');
    assert.equal(evidence.lock?.expired, true,
      'the frozen bit said false; the clock says the lease is gone');
    assert.notEqual(situation.key.split(':')[0], 'foreign-live',
      'foreign-live has no rung — reaching it on a lapsed lock is the defect');
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * D4 — one evidence builder
 * ------------------------------------------------------------------ */

/** `at` is a timestamp, not a fact about the phase — compare everything else. */
function withoutClock(evidence: PhaseEvidence): Omit<PhaseEvidence, 'at'> {
  const { at: _at, ...rest } = evidence;
  return rest;
}

test('both evidence builders produce identical PhaseEvidence for one fixture phase', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const state = runFor(root);
    const board = { 1: 'done', 2: 'ready' } as Record<number, string>;

    const shared = (svc as unknown as {
      evidenceDeps: (slug: string) => Record<string, unknown>;
    }).evidenceDeps('alpha');

    // The Service's reading, under a fixed clock so `at` is not the difference.
    const fromService = await collectEvidence(
      { ...shared, now: () => FIXED } as never, 'alpha', 2, state, board,
    );

    // The Runner's reading, through the SAME builder plus its run-local overlay.
    const runner = new Runner({
      scriptsDir: SCRIPTS,
      now: () => FIXED,
      evidenceDeps: (slug: string) => shared,
    } as never);
    (runner as unknown as { state: RunState }).state = state;
    const fromRunner = await (runner as unknown as {
      evidenceOf: (phase: number, board: unknown, declared: unknown) => Promise<PhaseEvidence>;
    }).evidenceOf(2, { states: board }, null);

    assert.deepEqual(withoutClock(fromRunner), withoutClock(fromService),
      'the loop and the healer must weigh ONE set of facts about a phase');
    assert.equal(fromRunner.at, fromService.at, 'same clock, same stamp');
  } finally { cleanup(); }
});

test('the runner gains gateDelegated — the fact its own builder never had', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    svc.prefs.delegateHumanGates = true;
    const state = runFor(root);

    const runner = new Runner({
      scriptsDir: SCRIPTS,
      now: () => FIXED,
      evidenceDeps: (slug: string) => (svc as unknown as {
        evidenceDeps: (s: string) => unknown;
      }).evidenceDeps(slug),
    } as never);
    (runner as unknown as { state: RunState }).state = state;

    const evidence = await (runner as unknown as {
      evidenceOf: (phase: number, board: unknown, declared: unknown) => Promise<PhaseEvidence>;
    }).evidenceOf(2, { states: { 1: 'done', 2: 'ready' } }, null);

    assert.equal(evidence.gateDelegated, true,
      'without this the loop parked a delegated gate with an errand for nobody');
  } finally { cleanup(); }
});

test('without a console builder the runner degrades honestly — it does not grow a second one', async () => {
  const { root, cleanup } = scratch();
  try {
    const state = runFor(root);
    const runner = new Runner({ scriptsDir: SCRIPTS, now: () => FIXED } as never);
    (runner as unknown as { state: RunState }).state = state;

    const evidence = await (runner as unknown as {
      evidenceOf: (phase: number, board: unknown, declared: unknown) => Promise<PhaseEvidence>;
    }).evidenceOf(2, { states: { 1: 'done', 2: 'ready' } }, null);

    // A harness with no console behind it knows no lock and no gate. Absent is
    // the honest answer — "a dependency the console lacks stays absent" — and
    // it is what keeps a second implementation from growing back here.
    assert.equal(evidence.lock, null);
    assert.equal(evidence.gate, null);
    // What IS run-local still answers: the board's own word about the handoff.
    assert.equal(evidence.handoff.exists, false);
    assert.equal(evidence.board, 'ready');
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * D2 — one board read
 * ------------------------------------------------------------------ */

test('an unreadable board is refused, never read as "nothing is done"', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    runFor(root);

    // `boardStates` wrapped this in `try/catch { return {} }`, so a failed read
    // and a board on which no phase is done were the SAME value. `recoverPlan`
    // then filtered `{}` for non-done entries, found none, and told the
    // operator "Every phase reads done on the board".
    (svc as unknown as { board: (slug: string) => Promise<unknown> }).board = async () => ({
      phased: true, states: {}, done: [], inProgress: [], stuck: [], ready: [], waiting: [],
      blockedBy: {}, qa: {}, error: 'the engine timed out reading this plan',
    });

    const recovered = await svc.recoverPlan('alpha');
    assert.doesNotMatch(recovered.detail, /every phase reads done/i,
      'a board that could not be read says nothing about what is done');
    assert.match(recovered.detail, /could not read the board/i);

    const healed = await svc.maybeAutoRecover('alpha');
    assert.equal(healed.launched, false);
    assert.match(healed.reason ?? '', /could not read the board/i,
      'the one caller that SPENDS must refuse rather than classify on an empty board');
  } finally { cleanup(); }
});

test('the recovery gate does not RECONCILE against a board it could not read', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const state = runFor(root);
    // A halt with a phase is what routes `maybeAutoRecover` through
    // `preRecoveryGate` — the third caller the exit criteria name, and the one
    // whose `if (board)` was dead code. Reaching it with an unreadable board
    // used to mean reconciling records, auto-resolving the run and retracting
    // the halt on the strength of `{}`.
    state.status = 'halted';
    state.halt = {
      at: new Date().toISOString(), reason: 'phase 2 did not verify', phase: 2, kind: 'verify-failed',
    };
    saveRun(state);

    (svc as unknown as { board: (slug: string) => Promise<unknown> }).board = async () => ({
      phased: true, states: {}, done: [], inProgress: [], stuck: [], ready: [], waiting: [],
      blockedBy: {}, qa: {}, error: 'the engine timed out reading this plan',
    });

    const healed = await svc.maybeAutoRecover('alpha');
    assert.equal(healed.launched, false);
    // Not "the board had already moved past the halt" and not "already
    // resolved" — both are claims ABOUT a board, and there was no board.
    assert.doesNotMatch(healed.reason ?? '', /moved past the halt|already resolved/i);
    assert.match(healed.reason ?? '', /could not read the board/i);

    const after = (await svc.runFor('alpha'))!;
    assert.equal(after.halt?.phase, 2, 'the halt must survive a read that did not happen');
    assert.notEqual(after.resolved, true, 'nothing may auto-resolve on an unread board');
  } finally { cleanup(); }
});
