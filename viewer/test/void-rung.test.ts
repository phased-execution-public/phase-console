/**
 * A rung that never boarded is void.
 *
 * The ladder's bookkeeping had no word for "nothing happened". Every rung it
 * opened settled into a verdict — `fixed`, `no-defect`, `failed` — and a rung
 * whose lane was never spawned at all got the last of those, because the only
 * question asked was "what does the record say now?" and the record said
 * `pending`.
 *
 * The measured run (#16, fixture `fixtures/journals/run-24fcba33.json`): the
 * heal opened `reboard-fresh` for phase 5; the scheduler admitted phase 6 —
 * a sibling on the same scope — ahead of it; phase 6 ran, declared
 * `needs-human`, and the park withdrew the queue phase 5 was still sitting in.
 * Phase 5 never spawned. The rung settled `FAILED` with the note "the record
 * reads pending" — which is the PROOF that no attempt happened — and that one
 * failure exhausted the one-rung `never-started` table, filed an errand keyed
 * `budgets` (no answer to which lifts the park), and every heal pass for the
 * next five hours read `candidates: 7 … chose: null`. Nothing was ever wrong
 * with phase 5. A bare Retry boarded it first time.
 *
 * So `withdrawn`: a settlement that costs nothing, counts for nothing, keeps
 * its rung available, and writes no errand — from BOTH settlement doors, since
 * either can be the one that finds the record. And the heal pass that meets a
 * stale errand of this kind over a phase the board still calls `ready` has all
 * the evidence it needs to board the phase itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import './state-sandbox.ts';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { journalFile, loadRun, newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { Runner } = await import('../server/runner/runner.ts');
const {
  countedRungs, triedRungKeys, rungWasWithdrawn,
} = await import('../shared/ladder-model.js');
const { RUNG_OUTCOMES, SETTLED_RUNG_OUTCOMES } = await import('../shared/run-lifecycle.js');
const { FIXTURE_DIR } = await import('./journal-fixture.ts');
type RunState = import('../server/runner/state.ts').RunState;

const SCRIPTS = join(SKILL_DIR, 'scripts');

const PLAN = `---
slug: alpha
created: 2026-09-20
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

const OPEN: Service[] = [];

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-voidrung-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  // Phase 1 complete, so the board reads phase 2 `ready` — the shape every
  // test below needs, and one a run cannot reach any other way.
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
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

/**
 * Capture what `reboard-fresh` actually drives — the `retry` vehicle, which is
 * the same door the operator's Retry press goes through (`retryPhase`), and the
 * one a bare `POST …/retry {"phase":5}` used on the measured run when the heal
 * loop would not. `startRun` is stubbed beside it so nothing spawns `claude`.
 */
function stubDrive(svc: Service): { retried: number[]; started: Record<string, unknown>[] } {
  const retried: number[] = [];
  const started: Record<string, unknown>[] = [];
  (svc as never as Record<string, unknown>).retryPhase =
    async (_slug: string, phase: number) => { retried.push(phase); return null; };
  (svc as never as Record<string, unknown>).startRun =
    async (_slug: string, opts: Record<string, unknown> = {}) => {
      started.push(opts);
      return { ok: true, runId: 'stub' };
    };
  return { retried, started };
}

/** The #16 run, with its root and slug pointed at this test's scratch plan. */
function fixtureRun(root: string): RunState {
  const raw = JSON.parse(
    readFileSync(join(FIXTURE_DIR, 'run-24fcba33.json'), 'utf8'),
  ) as Record<string, unknown>;
  const state = newRun({ slug: 'alpha', root, autoRecover: true });
  // The fixture's phases 4/5/6 become 1/2/3 of the scratch plan: phase 2 is the
  // one whose lane never spawned, and phase 3 is the sibling that parked the run.
  const fixturePhases = raw.phases as Record<string, Record<string, unknown>>;
  const fixtureRecoveries = raw.recoveries as Record<string, Record<string, unknown>>;
  state.status = 'parked';
  state.halt = { ...(raw.halt as Record<string, unknown>), phase: 3 } as never;
  state.phases['1'] = { ...phaseRecord(state, 1), status: 'done' } as never;
  state.phases['2'] = { ...phaseRecord(state, 2), ...fixturePhases['5'], phase: 2 } as never;
  state.phases['3'] = { ...phaseRecord(state, 3), ...fixturePhases['6'], phase: 3 } as never;
  state.recoveries = { 2: { ...fixtureRecoveries['5'] } } as never;
  saveRun(state);
  return state;
}

/** The `data` of every journal line with this name, read back off disk. */
function journalled(root: string, runId: string, name: string): Record<string, unknown>[] {
  const file = journalFile(root, 'alpha', runId);
  return readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === name)
    .map((entry) => ({ ...(entry.data as Record<string, unknown> ?? {}), phase: entry.phase }));
}

test.after(() => { for (const svc of OPEN) svc.close(); });

/* ------------------------------------------------------------------ *
 * The word itself
 * ------------------------------------------------------------------ */

test('VR-2: `withdrawn` is a rung outcome, and a settled one', () => {
  assert.ok(RUNG_OUTCOMES.includes('withdrawn'));
  assert.ok(SETTLED_RUNG_OUTCOMES.includes('withdrawn'),
    'it has finished — it just finished without an opinion');
});

test('VR-2: the void predicate is "pending, with no attempt after the rung"', () => {
  const rung = { at: '2026-09-20T14:46:41.219Z' };

  assert.equal(rungWasWithdrawn({ status: 'pending' }, rung), true,
    'no attemptStartedAt at all — the lane never spawned');
  assert.equal(rungWasWithdrawn({ status: 'pending', attemptStartedAt: '2026-09-20T09:00:00.000Z' }, rung), true,
    'an attempt from BEFORE the rung is a previous lane, not this one');

  assert.equal(rungWasWithdrawn({ status: 'pending', attemptStartedAt: '2026-09-20T14:47:00.000Z' }, rung), false,
    'an attempt after the rung DID board — the rung was tried');
  assert.equal(rungWasWithdrawn({ status: 'failed' }, rung), false, 'a record that moved is evidence');
  assert.equal(rungWasWithdrawn({ status: 'done' }, rung), false);
  assert.equal(rungWasWithdrawn(undefined, rung), false);
});

test('VR-2: countedRungs and triedRungKeys ignore a withdrawn record', () => {
  const history = [
    { situation: 'never-started', rung: 'reboard-fresh', at: '2026-09-20T14:46:41.219Z', outcome: 'withdrawn' },
  ];
  assert.deepEqual(countedRungs(history), [], 'nothing was spent, so nothing is counted');
  assert.equal(triedRungKeys(history).size, 0, 'and the rung is still available to climb');

  // It does not break an interruption streak either: nothing happened, so
  // nothing about the streak changed.
  const streak = [
    { situation: 's', rung: 'r', at: '1', outcome: 'interrupted' },
    { situation: 's', rung: 'r', at: '2', outcome: 'withdrawn' },
    { situation: 's', rung: 'r', at: '3', outcome: 'interrupted' },
  ];
  assert.equal(countedRungs(streak).length, 2,
    'two interruptions in a row still count, with a void record between them');
});

/* ------------------------------------------------------------------ *
 * VR-1 / VR-3 — the two doors, replaying #16
 * ------------------------------------------------------------------ */

test('VR-1: the heal sweep settles a rung over a never-started record `withdrawn`', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    stubDrive(svc);
    const run = fixtureRun(root);

    await svc.maybeAutoRecover('alpha');

    const disk = loadRun(root, 'alpha', run.id, null)!;
    const rungs = disk.recoveries!['2']!.rungs!;
    assert.equal(rungs[0].outcome, 'withdrawn',
      `the lane never spawned; got ${rungs[0].outcome} (${rungs[0].note ?? 'no note'})`);
    assert.equal(rungs[0].costUsd ?? 0, 0, 'nothing was spent on it');
    assert.match(String(rungs[0].note), /never spawned/);
  } finally { cleanup(); }
});

test('VR-1: the runner door settles it too — a lane that ended before it spawned', () => {
  // The other door. `settleRungsAfterAttempt` used to return in silence here,
  // leaving the rung `running` for ever; the service door then scored it
  // `failed` on its next sweep. Both doors, one rule.
  const instance = new Runner({ scriptsDir: SCRIPTS, spawn: async () => { throw new Error('never spawned'); } });
  const state = newRun({ slug: 'alpha', root: '/tmp/none', autoRecover: true });
  state.phases['2'] = { ...phaseRecord(state, 2), status: 'pending' } as never;
  state.recoveries = {
    2: {
      attempts: 1,
      lastAt: '2026-09-20T14:46:41.219Z',
      rungs: [{ situation: 'never-started', rung: 'reboard-fresh', at: '2026-09-20T14:46:41.219Z', outcome: 'running' }],
    },
  } as never;
  (instance as never as Record<string, unknown>).state = state;

  (instance as never as Record<string, unknown> as {
    settleRungsAfterAttempt: (phase: number, since: string) => void;
  }).settleRungsAfterAttempt(2, '2026-09-20T15:17:14.000Z');

  const rung = state.recoveries!['2']!.rungs![0];
  assert.equal(rung.outcome, 'withdrawn', `got ${rung.outcome ?? 'still open'}`);
});

test('VR-3: a withdrawn rung writes no errand, and the phase is boarded again', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const drive = stubDrive(svc);
    const run = fixtureRun(root);
    // The errand #16 filed is the thing under test in VR-4; here the question
    // is whether a void settlement produces one of its own.
    delete run.recoveries!['2']!.errand;
    saveRun(run);

    const out = await svc.maybeAutoRecover('alpha');

    const disk = loadRun(root, 'alpha', run.id, null)!;
    assert.equal(disk.recoveries!['2']!.errand, undefined,
      'nothing is in the way, so there is nothing to ask a person');
    assert.equal(out.launched, true, out.reason);
    assert.equal(out.phase, 2);
    assert.equal(out.rung, 'reboard-fresh', 'the rung is available again — it was never tried');
    assert.deepEqual(drive.retried, [2],
      'and the phase is boarded, not left for a person');
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * VR-4 — and a stale errand does not outlive its condition
 * ------------------------------------------------------------------ */

test('VR-4: a stale never-started errand over a ready phase is cleared, and the phase re-boards', async () => {
  // The second occurrence in #16: the errand had stood since 15:17Z and the
  // heal loop refused for five hours — "every rung for never-started has been
  // tried on this phase" — over a phase a bare Retry boarded first time. The
  // evidence needed is all on disk: the record reads `pending`, the board reads
  // `ready`, and nothing holds a queue entry for it.
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const drive = stubDrive(svc);
    const run = fixtureRun(root);
    // The legacy shape: the rung already settled `failed` under the old rule,
    // and the errand it produced is still standing.
    run.recoveries!['2']!.rungs![0].outcome = 'failed';
    run.recoveries!['2']!.rungs![0].note = 'the record reads pending';
    saveRun(run);

    const out = await svc.maybeAutoRecover('alpha');

    const disk = loadRun(root, 'alpha', run.id, null)!;
    assert.equal(disk.recoveries!['2']!.errand, undefined,
      'the errand named a condition that is no longer true');
    assert.equal(disk.recoveries!['2']!.rungs![0].outcome, 'withdrawn',
      're-settled by the same rule: the record never moved');

    // And it is written down: a retraction nobody can see is a retraction
    // nobody can audit when the phase parks again for a real reason.
    const cleared = journalled(root, run.id, 'phase.errand-cleared');
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0].reason, 'never-ran');
    assert.equal(cleared[0].phase, 2);

    assert.equal(out.launched, true, out.reason);
    assert.equal(out.rung, 'reboard-fresh');
    assert.deepEqual(drive.retried, [2],
      'a bare Retry boarded it first time — so can the heal pass');
  } finally { cleanup(); }
});
