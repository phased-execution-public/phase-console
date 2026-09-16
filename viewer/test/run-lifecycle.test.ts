/**
 * The lifecycle fold — what a run or a phase IS, beside the word it used to be.
 *
 * Twelve run statuses and twelve phase statuses, several of which were never
 * states: `pausing`/`stopping`/`halting` are acts landing on a running run,
 * `frozen` is a fact about the fleet, `interrupted` is a fact about a dead
 * console, `queued` is a wait whose reason is scope. Every consumer that wanted
 * one of those FACTS had to recover it from the word with its own regex, which
 * is R31 in the design register and five copies of
 * `=== 'pausing' || === 'halting' || === 'stopping'` in `runner.ts`.
 *
 * So 3.5.0 writes a `lifecycle` object beside `status`, and this file is what
 * makes that safe to land. Three claims, and the third is the one that matters:
 *
 * 1. **The fold is TOTAL.** Every status folds, and the compiler holds the
 *    tables total so a thirteenth word breaks the build rather than painting as
 *    `undefined`. Asserted here anyway, because a `Record` is total over the
 *    type and this is total over the VALUES — which is the same thing only for
 *    as long as nobody widens the type.
 * 2. **The fold threw nothing away.** `isRunLifecycleInFlight` and `isRunLive`
 *    are re-derivations of `RUN_IN_FLIGHT` and `LIVE_RUN_STATUSES` through the
 *    lifecycle, and they must agree with them on every status. If they disagree
 *    anywhere, the axes are not carrying something the subsets were.
 * 3. **The dual-write and the derivation agree.** A run file with a stored
 *    `lifecycle` and a run file with only `status` must answer identically —
 *    that is what lets an old file and a new file be read by one reader, and
 *    what lets 3.6.0 delete `status` without a migration.
 *
 * ⚠️ Not to be confused with `lifecycle.test.ts`, which is about the CONSOLE
 * INSTANCE's lifecycle verbs (`start`/`stop`/`list`). Different subject, and the
 * name was taken first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  RUN_STATUSES,
  PHASE_STATUSES,
  RUN_IN_FLIGHT,
  RUN_LIFECYCLE_STATES,
  PHASE_LIFECYCLE_STATES,
  PHASE_STOP_KINDS,
  RUN_PENDING_ACTS,
  runLifecycle,
  phaseLifecycle,
  isRunLifecycleInFlight,
  isRunLive,
  type RunStatus,
  type PhaseStatus,
} from '../shared/run-lifecycle.js';
import {
  LIVE_RUN_STATUSES,
  WAIT_REASONS,
  phaseUiState,
  runUiState,
  waitReasonOf,
  wordUiState,
} from '../shared/status-vocab.js';

/**
 * Every distinct status SHAPE this console had on disk when 3.5.0 was written —
 * 108 run files, anonymised down to the fields the fold reads.
 *
 * A fold table can be total and still be wrong, because totality is a claim
 * about the vocabulary and the vocabulary is a claim about the data. These two
 * came apart in exactly one place and the corpus is what found it: two live run
 * files read `status: "complete"`, a word `RUN_STATUSES` has never held, so a
 * fold whose fallback was anything but `waiting` would have repainted them.
 */
const CORPUS: {
  sampledRunFiles: number;
  runs: { status: string; waitUntil?: string; waitReason?: string; freeze?: unknown }[];
  phases: { status: string; declared?: { status: string }; verification?: { ok: boolean } }[];
} = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/live-status-corpus.json', import.meta.url)), 'utf8'),
);

/* ------------------------------------------------------------------ *
 * 1. Totality
 * ------------------------------------------------------------------ */

test('every run status folds to exactly one lifecycle state', () => {
  const unfolded: string[] = [];
  for (const status of RUN_STATUSES) {
    const { state } = runLifecycle({ status });
    if (!(RUN_LIFECYCLE_STATES as readonly string[]).includes(state)) unfolded.push(status);
  }
  assert.deepEqual(unfolded, [], 'a run status that folds to nothing paints as undefined');
});

test('every phase status folds to exactly one lifecycle state', () => {
  const unfolded: string[] = [];
  for (const status of PHASE_STATUSES) {
    const { state } = phaseLifecycle({ status });
    if (!(PHASE_LIFECYCLE_STATES as readonly string[]).includes(state)) unfolded.push(status);
  }
  assert.deepEqual(unfolded, [], 'a phase status that folds to nothing paints as undefined');
});

test('the fold table is the one written in the plan', () => {
  const runFold = Object.fromEntries(
    RUN_STATUSES.map((status) => [status, runLifecycle({ status }).state]),
  );
  assert.deepEqual(runFold, {
    running: 'running',
    halting: 'running',
    stopping: 'running',
    pausing: 'running',
    frozen: 'running',
    waiting: 'waiting',
    queued: 'waiting',
    parked: 'parked',
    halted: 'halted',
    interrupted: 'halted',
    paused: 'paused',
    finished: 'finished',
  });

  const phaseFold = Object.fromEntries(
    PHASE_STATUSES.map((status) => [status, phaseLifecycle({ status }).state]),
  );
  assert.deepEqual(phaseFold, {
    running: 'running',
    verifying: 'verifying',
    'awaiting-verification': 'parked',
    gated: 'parked',
    parked: 'parked',
    queued: 'waiting',
    waiting: 'waiting',
    pending: 'pending',
    interrupted: 'failed',
    failed: 'failed',
    skipped: 'skipped',
    done: 'done',
  });
});

test('the three transition words are one state with an act pending', () => {
  for (const [status, act] of [
    ['pausing', 'pause'],
    ['stopping', 'stop'],
    ['halting', 'halt'],
  ] as const) {
    const lifecycle = runLifecycle({ status });
    assert.equal(lifecycle.state, 'running', `${status} is a running run with an act landing`);
    assert.equal(lifecycle.pending, act);
    assert.ok((RUN_PENDING_ACTS as readonly string[]).includes(lifecycle.pending!));
  }
  // …and nothing else claims one, or `pending` stops meaning "landing".
  const withAct = RUN_STATUSES.filter((status) => runLifecycle({ status }).pending);
  assert.deepEqual([...withAct].sort(), ['halting', 'pausing', 'stopping']);
});

test('frozen is a running run that is held, not a state of its own', () => {
  assert.deepEqual(runLifecycle({ status: 'frozen' }), { state: 'running', frozen: true });
  // The fleet freeze marks the run without moving its word, so the axis has to
  // read the mark too — otherwise a frozen `running` run looks unheld.
  assert.equal(runLifecycle({ status: 'running', freeze: { at: 'x' } }).frozen, true);
  assert.equal(runLifecycle({ status: 'running' }).frozen, undefined);
});

/* ------------------------------------------------------------------ *
 * 2. The fold threw nothing away
 * ------------------------------------------------------------------ */

test('isRunLifecycleInFlight agrees with RUN_IN_FLIGHT on every status', () => {
  const disagreed: string[] = [];
  for (const status of RUN_STATUSES) {
    const viaList = (RUN_IN_FLIGHT as readonly string[]).includes(status);
    if (isRunLifecycleInFlight({ status }) !== viaList) disagreed.push(status);
  }
  assert.deepEqual(disagreed, [], 'the lifecycle lost something RUN_IN_FLIGHT was carrying');
});

test('isRunLive agrees with LIVE_RUN_STATUSES on every status', () => {
  const disagreed: string[] = [];
  for (const status of RUN_STATUSES) {
    const viaList = (LIVE_RUN_STATUSES as readonly string[]).includes(status);
    if (isRunLive({ status }) !== viaList) disagreed.push(status);
  }
  assert.deepEqual(disagreed, [], 'the lifecycle lost something LIVE_RUN_STATUSES was carrying');
});

test('the difference between the two subsets is queued, and it is the wait kind', () => {
  // This is the three-way split `RUN_SETTLED`'s docblock is about, expressed
  // once as an axis instead of twice as a membership list.
  assert.equal(isRunLive({ status: 'queued' }), true);
  assert.equal(isRunLifecycleInFlight({ status: 'queued' }), false);
  assert.equal(runLifecycle({ status: 'queued' }).wait?.kind, 'scope');
});

/* ------------------------------------------------------------------ *
 * 3. Stored and derived agree
 * ------------------------------------------------------------------ */

test('a stored lifecycle wins, and a legacy file derives the same answer', () => {
  for (const status of RUN_STATUSES) {
    const derived = runLifecycle({ status });
    const stored = runLifecycle({ status, lifecycle: derived });
    assert.deepEqual(stored, derived, `${status}: the dual-write disagrees with the fold`);
  }
  for (const status of PHASE_STATUSES) {
    const derived = phaseLifecycle({ status });
    const stored = phaseLifecycle({ status, lifecycle: derived });
    assert.deepEqual(stored, derived, `${status}: the dual-write disagrees with the fold`);
  }
});

test('a lifecycle whose state is not a state is ignored, not trusted', () => {
  // A file written by a future console, or a corrupted one. Falling through to
  // the derivation is the only answer that cannot paint `undefined`.
  const lifecycle = { state: 'transcending' } as never;
  assert.equal(runLifecycle({ status: 'running', lifecycle }).state, 'running');
  assert.equal(phaseLifecycle({ status: 'done', lifecycle }).state, 'done');
});

/* ------------------------------------------------------------------ *
 * The wait axis
 * ------------------------------------------------------------------ */

test('the wait axis carries a reason from WAIT_REASONS, or scope', () => {
  assert.equal(runLifecycle({ status: 'waiting', waitReason: 'external' }).wait?.kind, 'external');
  assert.equal(
    runLifecycle({ status: 'waiting', waitReason: 'usage-limit' }).wait?.kind,
    'usage-limit',
  );
  // The pre-field fallback, which is what `waitReasonOf` does and why it must
  // stay identical: a run written before `waitReason` existed can only be asked
  // whether any phase declared a wait.
  assert.equal(
    runLifecycle({ status: 'waiting', phases: { '1': { status: 'waiting' } } }).wait?.kind,
    'external',
  );
  assert.equal(runLifecycle({ status: 'waiting' }).wait?.kind, 'usage-limit');

  for (const status of RUN_STATUSES) {
    const kind = runLifecycle({ status }).wait?.kind;
    if (kind === undefined) continue;
    assert.ok(
      (WAIT_REASONS as readonly string[]).includes(kind),
      `${status} waits for '${kind}', which WAIT_REASONS does not hold`,
    );
  }
});

test('only a waiting run carries a wait', () => {
  const carrying = RUN_STATUSES.filter((status) => runLifecycle({ status }).wait);
  assert.deepEqual([...carrying].sort(), ['queued', 'waiting']);
});

/* ------------------------------------------------------------------ *
 * The stop axis, and the one paint change it buys
 * ------------------------------------------------------------------ */

test('a phase stop kind is always one PHASE_STOP_KINDS holds', () => {
  const records: { status: PhaseStatus; [k: string]: unknown }[] = [
    ...PHASE_STATUSES.map((status) => ({ status })),
    { status: 'parked', mcpPark: { server: 'fs' } },
    { status: 'parked', declared: { status: 'needs-human' } },
    { status: 'parked', lockWaitSince: '2026-08-31T00:00:00Z' },
    { status: 'failed', verification: { ok: false } },
    { status: 'waiting', declared: { status: 'waiting-external' } },
  ];
  for (const record of records) {
    const kind = phaseLifecycle(record).stop?.kind;
    if (kind === undefined) continue;
    assert.ok(
      (PHASE_STOP_KINDS as readonly string[]).includes(kind),
      `${record.status} stopped for '${kind}', which PHASE_STOP_KINDS does not hold`,
    );
  }
});

test('a parked phase names who is owed what', () => {
  assert.deepEqual(phaseLifecycle({ status: 'gated' }).stop, { kind: 'gate' });
  assert.deepEqual(phaseLifecycle({ status: 'awaiting-verification' }).stop, {
    kind: 'human-check',
  });
  assert.deepEqual(phaseLifecycle({ status: 'queued' }).stop, { kind: 'scope-cap' });
  assert.deepEqual(phaseLifecycle({ status: 'interrupted' }).stop, { kind: 'interrupted' });
  assert.deepEqual(phaseLifecycle({ status: 'parked', mcpPark: { server: 'fs' } }).stop, {
    kind: 'mcp',
  });
  assert.deepEqual(phaseLifecycle({ status: 'parked', lockWaitSince: 'x' }).stop, {
    kind: 'scope-cap',
  });
  // The declared word rides along, because "declared: needs-human" is the chip
  // and re-deriving it from a note regex is exactly what this replaces.
  assert.deepEqual(phaseLifecycle({ status: 'parked', declared: { status: 'needs-human' } }).stop, {
    kind: 'declared',
    declared: 'needs-human',
  });
});

test('a failed phase separates a red verification from a spent ladder', () => {
  assert.deepEqual(phaseLifecycle({ status: 'failed', verification: { ok: false } }).stop, {
    kind: 'verification',
  });
  assert.deepEqual(phaseLifecycle({ status: 'failed' }).stop, { kind: 'ladder' });
  // …and the console dying on it is neither, which is why it keeps its own word
  // even though it folds to the same state.
  assert.deepEqual(phaseLifecycle({ status: 'interrupted' }).stop, { kind: 'interrupted' });
});

/* ------------------------------------------------------------------ *
 * The dual-write, through the real chokepoints
 * ------------------------------------------------------------------ */

test('a run written by a bare status assignment still lands with a lifecycle', async () => {
  // `state-sandbox.ts` is imported lazily, and `state.ts` with it, because
  // everything above this point is pure `shared/` and must stay runnable with
  // no console state directory at all.
  await import('./state-sandbox.ts');
  const { newRun, phaseRecord, saveRun, loadRun, setRunState, setPhaseState } = await import(
    '../server/runner/state.ts'
  );
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const root = mkdtempSync(join(tmpdir(), 'pc-lifecycle-'));
  try {
    const state = newRun({ slug: 'a-plan', root, model: 'opus' });
    const record = phaseRecord(state, 1);
    phaseRecord(state, 2);

    // The 117-sites case: somebody writes the word and nothing else. This is
    // what `syncLifecycle` exists for — the file must not reach disk with a
    // lifecycle that disagrees, whoever wrote the status.
    state.status = 'halting';
    record.status = 'gated';
    saveRun(state);

    const back = loadRun(root, 'a-plan', state.id)!;
    assert.ok(back.status, 'the legacy word is still written — this is a DUAL write');
    assert.ok(back.lifecycle, 'and the lifecycle landed beside it');
    // The word is asserted to AGREE, not to be a particular one: the read path
    // settles a `halting` run with no loop behind it to `halted`, and the point
    // of putting the sync after `reconcileRun` is that the axes follow.
    const { lifecycle: _run, ...runFacts } = back;
    assert.deepEqual(back.lifecycle, runLifecycle(runFacts), 'the axes describe a different status');
    assert.equal(back.phases['1'].status, 'gated');
    assert.deepEqual(back.phases['1'].lifecycle, { state: 'parked', stop: { kind: 'gate' } });

    // …and a STALE lifecycle is corrected, not preserved. This is the failure
    // mode that makes a half-done refactor worse than none: a record whose axes
    // describe the status it used to have.
    back.status = 'finished';
    saveRun(back);
    assert.equal(loadRun(root, 'a-plan', back.id)!.lifecycle!.state, 'finished');

    // The named writers carry what the fold cannot recover: `queued` is the
    // status for both a scope wait and a schedule one.
    setRunState(back, 'queued', { kind: 'schedule' });
    assert.deepEqual(back.lifecycle, { state: 'waiting', wait: { kind: 'schedule', until: null } });
    setPhaseState(back.phases['2'], 'failed', { kind: 'ladder' });
    assert.deepEqual(back.phases['2'].lifecycle, {
      state: 'failed',
      stop: { kind: 'ladder', stated: true },
    });
    saveRun(back);
    assert.equal(loadRun(root, 'a-plan', back.id)!.lifecycle!.wait!.kind, 'schedule');

    // …and a PERSON's card is a wait the disk keeps (WAI-10, ACC-11.3): the
    // run parked behind a verification or approval card round-trips with the
    // kind and the card's clock — `reconcileRun` turns a `waiting` run with a
    // clock into `paused` with the clock intact, so the boot re-arm fires at
    // the card's expiry like any other wait.
    const until = new Date(Date.now() + 3_600_000).toISOString();
    back.status = 'running';
    back.waitUntil = until;
    setRunState(back, 'waiting', { kind: 'person', until, on: 'phase 2 verification card' });
    assert.deepEqual(back.lifecycle, { state: 'waiting', wait: { kind: 'person', until, on: 'phase 2 verification card' } });
    saveRun(back);
    const person = loadRun(root, 'a-plan', back.id)!;
    // No loop drives this file, so the read path reconciles the wait to
    // `paused` — with the reason and the clock INTACT, which is what the boot
    // re-arm reads (`waitClockVerdict` → `waitReasonOf`). The stored lifecycle
    // is the in-memory one above; the settled one describes the paused run.
    assert.equal(person.status, 'paused');
    assert.equal(person.waitReason, 'person');
    assert.equal(person.waitUntil, until);
    assert.equal(waitReasonOf(person), 'person');
    assert.deepEqual(person.lifecycle, runLifecycle(person), 'the axes follow the settled status');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * The corpus — the fold measured against the data, not against the type
 * ------------------------------------------------------------------ */

test('every shape on disk still paints exactly as it did', () => {
  assert.ok(CORPUS.sampledRunFiles > 100, 'the corpus should be the whole run directory');
  assert.ok(CORPUS.runs.length > 0 && CORPUS.phases.length > 0);

  const repainted: string[] = [];
  for (const run of CORPUS.runs) {
    // Before: the word alone, which is all a 3.4.0 reader had.
    const before = runUiState(run.status);
    // After: the word a 3.6.0 reader will have, which is the LIFECYCLE STATE —
    // the fold's own answer, round-tripped back through the paint table.
    //
    // ⚠️ This used to call `runUiState(run.status)` on both sides, which is a
    // tautology: it could not fail, so it proved nothing about the fold. The
    // real claim is that the state a run folds to paints the same colour the
    // status did, because that is what makes dropping `status` in 3.6.0 a
    // no-op for every screen.
    // The 3.6.0 reading: the lifecycle ALONE, with no status word to fall back
    // on. `runUiState(null, lifecycle)` is the honest form of that — it proves
    // the axes carry the colour, rather than proving the status table still
    // exists.
    const lifecycle = runLifecycle(run);
    const after = lifecycle.pending
      ? runUiState(null, lifecycle)
      : wordUiState(lifecycle.state);
    if (before !== after) repainted.push(`run ${run.status}: ${before} → ${after}`);
    // And the fold must produce a state at all, for every shape that exists.
    assert.ok(
      (RUN_LIFECYCLE_STATES as readonly string[]).includes(runLifecycle(run).state),
      `run '${run.status}' folds to nothing`,
    );
  }
  for (const record of CORPUS.phases) {
    const before = phaseUiState(record.status);
    const after = phaseUiState(record.status, phaseLifecycle(record).stop);
    if (before !== after) repainted.push(`phase ${record.status}: ${before} → ${after}`);
    assert.ok(
      (PHASE_LIFECYCLE_STATES as readonly string[]).includes(phaseLifecycle(record).state),
      `phase '${record.status}' folds to nothing`,
    );
  }
  // Nothing in the corpus is a `parked` phase with a scope-cap or mcp stop, so
  // the one deliberate paint change touches none of it. If a future corpus DOES
  // contain one, this list is where it shows up — and the right answer then is
  // to state the change, not to widen the assertion.
  assert.deepEqual(repainted, [], 'a shape on disk changed colour');
});

test('a status the vocabulary does not hold keeps its colour', () => {
  // `complete` is real: it is on disk twice. `UNKNOWN_STATE` is `waiting`, so
  // the fold's fallback has to be `waiting` too, or the two files turn red.
  const orphan = CORPUS.runs.find((run) => !(RUN_STATUSES as readonly string[]).includes(run.status));
  assert.ok(orphan, 'the corpus should still carry the unknown-word case');
  assert.equal(runUiState(orphan.status), 'waiting');
  assert.equal(runLifecycle(orphan).state, 'waiting');
  assert.equal(phaseLifecycle({ status: 'transcending' }).state, 'waiting');
});

test('scope-cap and mcp are the two parks that are not an ask', () => {
  // The ONE paint change in 3.5.0: a parked phase reads `needs-you` unless
  // nobody is actually being asked for anything.
  assert.equal(phaseUiState('parked', { kind: 'scope-cap' }), 'waiting');
  assert.equal(phaseUiState('parked', { kind: 'mcp' }), 'waiting');
  assert.equal(phaseUiState('parked', { kind: 'gate' }), 'needs-you');
  assert.equal(phaseUiState('parked', { kind: 'declared' }), 'needs-you');
  assert.equal(phaseUiState('parked'), 'needs-you', 'no stop kind is still an ask');
  // Every other status paints exactly as it did — the stop kind is consulted
  // for `parked` and nowhere else.
  for (const status of PHASE_STATUSES) {
    if (status === 'parked') continue;
    assert.equal(
      phaseUiState(status, { kind: 'scope-cap' }),
      phaseUiState(status),
      `${status} must not change colour because a stop kind was passed`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * QA round 2 — the reasons that are STATED, because nothing can re-derive them
 * ------------------------------------------------------------------ */

test('a lock-cap park keeps its scope-cap reason through a save and a load', async () => {
  // 🔑 The three lock-cap parks CLEAR `lockWaitSince` in the same block that
  // sets `parked` — the clock stops with the wait, so a Retry starts the two
  // hours over. That means the evidence the fold reads is gone by the time
  // anything looks, and `scope-cap` could never be derived: every one of these
  // parks painted `needs-you`, which is the half of 3.5.0's one paint change
  // that silently did not happen. The writer states it; `axisStale` keeping a
  // writer's answer where the fold is silent is what makes it survive.
  await import('./state-sandbox.ts');
  const { newRun, phaseRecord, saveRun, loadRun, setPhaseState } = await import(
    '../server/runner/state.ts'
  );
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const root = mkdtempSync(join(tmpdir(), 'pc-scope-cap-'));
  try {
    const state = newRun({ slug: 'a-plan', root, model: 'opus' });
    const record = phaseRecord(state, 1);

    // Exactly what `runner-loop.ts` does, in its order: state the park, then
    // stop the clock.
    setPhaseState(record, 'parked', { kind: 'scope-cap' });
    record.lockWaitSince = undefined;
    saveRun(state);

    const back = loadRun(root, 'a-plan', state.id)!;
    assert.deepEqual(back.phases['1'].lifecycle, {
      state: 'parked',
      stop: { kind: 'scope-cap', stated: true },
    });
    assert.equal(
      phaseUiState(back.phases['1'].status, back.phases['1'].lifecycle?.stop),
      'waiting',
      'a phase queued behind another lane is not an ask',
    );

    // …and a park with no stated reason and no evidence is STILL an ask, which
    // is the safe direction: "we could not tell" must not read as "fine".
    const other = phaseRecord(back, 2);
    other.status = 'parked';
    saveRun(back);
    const again = loadRun(root, 'a-plan', back.id)!;
    assert.equal(again.phases['2'].lifecycle?.stop, undefined);
    assert.equal(phaseUiState('parked'), 'needs-you');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('waitReasonOf knows every word WAIT_REASONS holds', () => {
  // It knew two of four after the list grew, so a recorded `scope` fell
  // through to the phase scan and was reported as a usage limit — the exact
  // lie the recorded field was added to stop.
  for (const kind of WAIT_REASONS) {
    assert.equal(waitReasonOf({ waitReason: kind }), kind, `${kind} must survive the read`);
  }
  // The pre-field fallback is untouched: a run written before `waitReason`
  // existed is still read from its phase records.
  assert.equal(waitReasonOf({ phases: { '1': { status: 'waiting' } } }), 'external');
  assert.equal(waitReasonOf({}), 'usage-limit');
  assert.equal(waitReasonOf({ waitReason: 'nonsense' }), 'usage-limit', 'an unknown word is not a reason');
});

test('the fold and waitReasonOf answer the same thing about one run', () => {
  // Two readers of `run.waitReason`, and only one of them was widened when the
  // list grew to four: for `{status:'waiting', waitReason:'scope'}` the fold
  // said `usage-limit` while `waitReasonOf` said `scope`. `WAIT_REASONS` cannot
  // be imported into `run-lifecycle.js` — `status-vocab.js` imports it, and a
  // cycle between the two owners is worse than a copy — so this is what keeps
  // the copy honest.
  for (const kind of WAIT_REASONS) {
    const run = { status: 'waiting', waitReason: kind };
    assert.equal(
      runLifecycle(run).wait?.kind,
      waitReasonOf(run),
      `waiting + ${kind}: the fold and waitReasonOf disagree`,
    );
  }

  // `queued` is deliberately NOT in that loop: it CONSTRAINS the answer, because
  // a run sitting in `admit()` is waiting on scope or on a schedule and cannot
  // be waiting on a usage window. `waitReasonOf` is the generic reader and hands
  // back whatever was recorded; the fold knows what the status means. That is a
  // difference with a reason, not drift.
  assert.equal(runLifecycle({ status: 'queued', waitReason: 'usage-limit' }).wait?.kind, 'scope');
  assert.equal(runLifecycle({ status: 'queued', waitReason: 'schedule' }).wait?.kind, 'schedule');
});

test('a reason a writer STATED outlives the fold, until the state moves', async () => {
  // ⚠️ **This test was vacuous and a reviewer red-proved it.** It asked
  // `phaseLifecycle`, which returns a stored lifecycle VERBATIM — so both
  // assertions echoed their own input, and deleting the guard they claimed to
  // pin left the entire node suite green. The rule the plan already carries and
  // this file broke: before claiming a fix is pinned, revert it and watch a
  // test fail.
  //
  // The guard lives in `syncLifecycle`, so the test has to cross a save.
  await import('./state-sandbox.ts');
  const { newRun, phaseRecord, saveRun, loadRun, setPhaseState } = await import(
    '../server/runner/state.ts'
  );
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const root = mkdtempSync(join(tmpdir(), 'pc-stated-'));
  try {
    const state = newRun({ slug: 'a-plan', root, model: 'opus' });

    // A lock-cap park, on a record that also carries an unspent declaration —
    // which is what the fold would otherwise answer with, because the writer's
    // own evidence (`lockWaitSince`) is cleared in the same breath.
    const stated = phaseRecord(state, 1);
    stated.declared = { status: 'needs-human', at: new Date().toISOString() };
    setPhaseState(stated, 'parked', { kind: 'scope-cap' });
    stated.lockWaitSince = undefined;

    // …and a park whose reason the fold GUESSED, over a record that has since
    // gained better evidence. This one must be refreshed.
    const guessed = phaseRecord(state, 2);
    guessed.status = 'parked';
    guessed.lifecycle = { state: 'parked', stop: { kind: 'ladder' } };
    guessed.mcpPark = { server: 'fs' };

    saveRun(state);
    const back = loadRun(root, 'a-plan', state.id)!;

    assert.equal(
      back.phases['1'].lifecycle?.stop?.kind,
      'scope-cap',
      'the sync overruled a reason the writer stated',
    );
    assert.equal(
      back.phases['2'].lifecycle?.stop?.kind,
      'mcp',
      'the sync kept a guess the record had outgrown',
    );

    // And a stated reason cannot outlive the park it describes: move the state
    // and the whole lifecycle is re-derived.
    back.phases['1'].status = 'done';
    saveRun(back);
    const moved = loadRun(root, 'a-plan', back.id)!;
    assert.deepEqual(moved.phases['1'].lifecycle, { state: 'done' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
