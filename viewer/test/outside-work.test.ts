/**
 * Work done OUTSIDE the console, and how the console finds out.
 *
 * A plan is not only driven by the autopilot. An operator finishes a phase by
 * hand in their own Claude session, writes the handoff, commits it — and the
 * console, which is holding a run that stopped on that very phase, has to
 * notice. If it does not, it goes on asking for help with work that is already
 * done: the phase card stays red, the inbox keeps its errand, and the healer
 * classifies a finished phase as broken and spends money re-doing it. That is
 * `plan-broken:stale-handoff`, which this console recorded 92 times.
 *
 * The machinery already exists and is spread across three files, which is
 * exactly why it deserves a test that names the whole path rather than its
 * parts:
 *
 *   the docs watcher sees the handoff land
 *     → `ConvergeScheduler` debounces and converges the plan
 *       → `convergeDeps.runs` loads through `runsFor`
 *         → `resolveAgainstBoard` reads the ENGINE's board
 *           → `reconcileRecordsAgainstBoard` closes the overtaken record
 *             and dissolves the halt anchored to it.
 *
 * Nothing in that chain is new. What is new is this file asserting it end to
 * end, because every link was tested alone and the claim "the console captures
 * work done elsewhere" was tested nowhere — and a chain of six tested links
 * with an untested join is how a run sat halted on a phase whose handoff had
 * been complete for three hours.
 *
 * ⚠️ The board here is the REAL engine (`phase-graph.sh`) over a real fixture
 * plan and a real handoff. Stubbing it would make this a test of the stub: the
 * whole question is whether the console believes the engine over its own
 * stored record, so the engine has to be the thing that answers.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newRun, phaseRecord, saveRun, loadRun, listRuns } from '../server/runner/state.ts';
import { Service } from '../server/service.ts';

const SKILL_DIR = new URL('../..', import.meta.url).pathname;

/** A two-phase plan whose §Verification is `true`, so nothing needs running. */
const PLAN = `---
slug: outside-work
created: 2026-09-01
status: active
phases: 2
---

# Outside work

## Session budget

**Target model:** \`claude-opus-5\` · **Budget:** ~200K weight/session

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | First | — | — | \`demo\` | it is done |
| 2 | Second | 1 | — | \`demo\` | it is done |

## Phases

### Phase 1 — First
- **Size:** S
- **Verification:** \`true\`

### Phase 2 — Second
- **Size:** S
- **Verification:** \`true\`

## End-to-end verification

1. \`true\`
`;

function handoff(phase: number, status: string): string {
  return `---
plan: docs/plans/outside-work.md
phase: ${phase}
title: p${phase}
status: ${status}
---
# Phase ${phase} — done by hand, in somebody's own session
`;
}

function scratchPlan(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-outside-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'outside-work'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'outside-work.md'), PLAN);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A console that may read and converge, pointed at the scratch plan. */
function service(root: string): Service {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false, allowRun: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  return svc;
}

test('a phase finished by hand outside the console closes its record and dissolves the halt', async () => {
  const { root, cleanup } = scratchPlan();
  const svc = service(root);
  try {
    // The console drove phase 1, failed it, and halted asking for a person.
    const state = newRun({ slug: 'outside-work', root, model: 'opus' });
    const record = phaseRecord(state, 1);
    record.status = 'failed';
    record.note = 'verification was red';
    state.status = 'halted';
    state.halt = {
      at: new Date().toISOString(),
      reason: 'phase 1 failed verification',
      phase: 1,
      kind: 'verify-failed',
    };
    saveRun(state);

    // Nothing has changed yet: the console is right to still be asking.
    let runs = await svc.runsFor('outside-work');
    assert.equal(runs[0].phases['1'].status, 'failed', 'the record stands while the board disagrees');
    assert.equal(runs[0].status, 'halted');

    // …and now a person finishes phase 1 in their own session and commits the
    // handoff. The console is told nothing; the only evidence is on disk.
    writeFileSync(
      join(root, 'docs', 'handoffs', 'outside-work', 'phase-01-first.md'),
      handoff(1, 'complete'),
    );

    // The docs watcher's own signal. Without it the board is served from cache
    // and the read is answered from the world as it was before the handoff
    // landed — which is the honest shape of this: the console does not stat the
    // plan on every read, it is TOLD the docs changed and drops what it knew.
    // `invalidateAll` is exactly what the watcher calls.
    svc.invalidateAll();

    // Now one read is enough — the resolver runs on the read path, which is
    // what makes this work for a person refreshing the page as well as for the
    // convergence loop's own load.
    runs = await svc.runsFor('outside-work');
    assert.equal(
      runs[0].phases['1'].status,
      'done',
      'the board overtook the record and the console did not notice',
    );
    assert.match(runs[0].phases['1'].note ?? '', /outside this run/i);
    assert.equal(runs[0].halt, null, 'the halt was anchored to a phase that is now done');
    // NOT `resolved`: phase 2 is still open, so the run has not stopped
    // mattering — it has stopped being STUCK. Resolution is for a run the
    // board has finished, and asserting it here would have been asserting
    // that the console gives up on a plan with work left in it.
    assert.equal(runs[0].resolved, undefined);

    // The correction STICKS — it is written back, not recomputed per read, so
    // a console that dies right after still comes back with it.
    const persisted = loadRun(root, 'outside-work', state.id)!;
    assert.equal(persisted.phases['1'].status, 'done');
  } finally {
    svc.close();
    cleanup();
  }
});

test('the capture runs on the convergence pass, not only when somebody looks', async () => {
  // The read path above covers a person opening the page. The autopilot needs
  // the same answer with nobody looking at all — otherwise a console left alone
  // over a weekend keeps an errand alive for work that was finished on Friday.
  const { root, cleanup } = scratchPlan();
  const svc = service(root);
  try {
    const state = newRun({ slug: 'outside-work', root, model: 'opus' });
    const record = phaseRecord(state, 1);
    record.status = 'failed';
    state.status = 'halted';
    state.halt = { at: new Date().toISOString(), reason: 'red', phase: 1, kind: 'verify-failed' };
    saveRun(state);

    writeFileSync(
      join(root, 'docs', 'handoffs', 'outside-work', 'phase-01-first.md'),
      handoff(1, 'complete'),
    );

    // The trigger a docs change produces. `convergeNow` is what the watcher
    // calls once its debounce elapses.
    await svc.convergeNow('outside-work', 'change');

    const [run] = listRuns(root, 'outside-work');
    assert.equal(run.phases['1'].status, 'done', 'converge did not capture the outside work');
    assert.equal(run.halt, null);
  } finally {
    svc.close();
    cleanup();
  }
});

test('an operator-paused run is corrected too — a pause is not a reason to be wrong', async () => {
  // `SETTLEABLE` is `halted | parked | interrupted`, so a run an operator
  // PAUSED was never board-resolved: its records kept whatever they said, for
  // ever. That is defensible for anything that would RESTART the run — an
  // operator's stop is respected, and this console has four paused runs that
  // must stay paused — but it was applied to the read as well, so a paused run
  // showed phase 1 as failed months after it had been finished by hand.
  //
  // Correcting a record is not resuming a run. Nothing here starts anything.
  const { root, cleanup } = scratchPlan();
  const svc = service(root);
  try {
    const state = newRun({ slug: 'outside-work', root, model: 'opus' });
    const record = phaseRecord(state, 1);
    record.status = 'failed';
    state.status = 'paused';
    state.stoppedBy = 'operator';
    saveRun(state);

    writeFileSync(
      join(root, 'docs', 'handoffs', 'outside-work', 'phase-01-first.md'),
      handoff(1, 'complete'),
    );

    const runs = await svc.runsFor('outside-work');
    assert.equal(runs[0].phases['1'].status, 'done', 'a paused run still reads a stale record');
    // …and it is STILL paused, and still the operator's.
    assert.equal(runs[0].status, 'paused', 'correcting a record must never resume a run');
    assert.equal(runs[0].stoppedBy, 'operator');
  } finally {
    svc.close();
    cleanup();
  }
});
