/**
 * A `nothing-ready` halt names what holds it, as data (#14's cousin, the halt
 * card of phase 17).
 *
 * The halt used to be ONE sentence — "nothing left to run on its own — phase
 * 4 needs you — …; phase 6 is gated (…). a phase parked with an errand takes
 * that errand, then Retry" — and every surface that wanted to offer the one
 * action per holder had to parse it back. `holders[]` is the same facts the
 * sentence is built from, one row per phase that holds the run: the phase,
 * what kind of thing holds it, and the verb that clears it.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Runner } = await import('../server/runner/runner.ts');
const { haltHolders } = await import('../server/runner/runner-loop.ts');
const { newRun, phaseRecord } = await import('../server/runner/state.ts');
const { HALT_HOLDER_KINDS, HALT_HOLDER_VERBS } = await import('../shared/recovery-model.js');
import type { SpawnFn } from '../server/runner/spawn.ts';

const at = '2026-09-22T10:00:00.000Z';

/* ------------------------------------------------------------------ *
 * HH-1 — every holder has its phase, its kind and its verb
 * ------------------------------------------------------------------ */

test('HH-1: the holder vocabulary is closed, and every kind has a clearing verb', () => {
  for (const kind of ['gate', 'errand', 'lock', 'retry', 'cap']) {
    assert.ok((HALT_HOLDER_KINDS as readonly string[]).includes(kind), kind);
  }
  assert.ok((HALT_HOLDER_VERBS as readonly string[]).includes('approve-gate'));
  assert.ok((HALT_HOLDER_VERBS as readonly string[]).includes('retry'));
});

test('HH-1: a mixture of holders is decomposed one row per phase, each with its own verb', () => {
  const state = newRun({ slug: 'demo', root: '/tmp/none' });
  const gated = phaseRecord(state, 2);
  gated.status = 'gated';
  gated.note = 'gate not clear: manual: confirm the rollout window';
  gated.gate = { clear: false, kind: 'manual', detail: 'manual: confirm the rollout window' };
  const failed = phaseRecord(state, 3);
  failed.status = 'failed';
  failed.note = 'the verification is red';
  const locked = phaseRecord(state, 5);
  locked.status = 'parked';
  locked.note = 'waited 2 h for the lock held by someone/else — lock-wait cap reached';
  const errandRecord = phaseRecord(state, 4);
  errandRecord.status = 'parked';
  const capped = phaseRecord(state, 6);
  capped.status = 'parked';

  const holders = haltHolders({
    readyRecords: [{ p: 2, record: gated }, { p: 3, record: failed }, { p: 5, record: locked }],
    errands: [
      { p: 4, errand: { phase: 4, situation: 'blocked-declared:unknown', tried: [], need: 'what it names', how: 'clear it', at } },
      {
        p: 6,
        errand: {
          phase: 6, situation: 'work-in-progress', tried: [], need: 'the run\'s ladder budget is spent', how: 'raise it', at,
          cap: 'run-rungs', spent: 10, limit: 10, onDonePhases: 9, setting: 'ladderPerRunRungs',
        },
      },
    ],
    stuck: [7],
    qaHolders: [],
    lockCapPark: (note) => /lock-wait cap/.test(note),
  });

  const byPhase = new Map(holders.map((h) => [h.phase, h]));
  assert.deepEqual([...byPhase.keys()].sort((a, b) => a - b), [2, 3, 4, 5, 6, 7], 'every phase that holds the run, once');
  assert.deepEqual({ kind: byPhase.get(2)!.kind, verb: byPhase.get(2)!.verb }, { kind: 'gate', verb: 'approve-gate' });
  assert.deepEqual({ kind: byPhase.get(3)!.kind, verb: byPhase.get(3)!.verb }, { kind: 'retry', verb: 'retry' });
  // A declared block is a person's errand, and the verb that clears it is
  // their answer — "Done — continue" — not a Retry of the stale declaration
  // (control-tower phase 88, #124).
  assert.deepEqual({ kind: byPhase.get(4)!.kind, verb: byPhase.get(4)!.verb }, { kind: 'errand', verb: 'errand-answered' });
  assert.equal(byPhase.get(5)!.kind, 'lock');
  assert.deepEqual({ kind: byPhase.get(6)!.kind, verb: byPhase.get(6)!.verb, setting: byPhase.get(6)!.setting },
    { kind: 'cap', verb: 'settings', setting: 'ladderPerRunRungs' }, 'a cap is cleared by its setting, not by a Retry');
  assert.equal(byPhase.get(7)!.kind, 'blocked');
  for (const holder of holders) {
    assert.ok((HALT_HOLDER_KINDS as readonly string[]).includes(holder.kind), holder.kind);
    assert.ok((HALT_HOLDER_VERBS as readonly string[]).includes(holder.verb), holder.verb);
    assert.ok(holder.why.length > 0, `phase ${holder.phase} says why`);
  }
});

test('HH-1: an errand holder carries its errand’s situation, so the park can say what kind of wall holds it', () => {
  // Control-tower phase 33 (the tower rehearsal): continued past a declared
  // external wall, a run parks `nothing-ready` behind it, and the holder that
  // names the wall used to drop the errand's `blocked-declared:external`.
  const holders = haltHolders({
    readyRecords: [],
    errands: [
      { p: 1, errand: { phase: 1, situation: 'blocked-declared:external', tried: [], need: 'the upstream is down', how: 'x', at } },
      {
        p: 3,
        errand: {
          phase: 3, situation: 'work-in-progress', tried: [], need: 'the ladder is spent', how: 'raise it', at,
          cap: 'run-rungs', spent: 10, limit: 10, onDonePhases: 9, setting: 'ladderPerRunRungs',
        },
      },
    ],
    stuck: [],
    qaHolders: [],
  });
  assert.deepEqual(
    { kind: holders[0].kind, verb: holders[0].verb, situation: holders[0].situation },
    { kind: 'errand', verb: 'retry', situation: 'blocked-declared:external' },
    'an external wall is answered by the world, and keeps Retry',
  );
  assert.equal(holders[1].kind, 'cap');
  assert.equal(holders[1].situation, undefined, 'a spent cap is cleared by its setting, not by what the errand was about');
});

test('HH-3: a QA verdict that holds the plan is a holder too — the done phase that holds it', () => {
  const holders = haltHolders({
    readyRecords: [], errands: [], stuck: [],
    qaHolders: [{ p: 2, verdict: 'fail', blocks: [3, 4] }],
    lockCapPark: () => false,
  });
  assert.equal(holders.length, 1);
  assert.deepEqual({ phase: holders[0].phase, kind: holders[0].kind, verb: holders[0].verb }, { phase: 2, kind: 'qa', verb: 'qa-recover' });
  assert.match(holders[0].why, /fail/);
});

/* ------------------------------------------------------------------ *
 * HH-2 — a run held only by a gate names that gate, end to end
 * ------------------------------------------------------------------ */

function gatedRepo(): { root: string; scripts: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-holders-'));
  const scripts = join(root, 'scripts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  const write = (name: string, body: string) => { writeFileSync(join(scripts, name), body, 'utf8'); chmodSync(join(scripts, name), 0o755); };
  // Two phases: 1 is ready and gated by a person, 2 waits on it.
  write('phase-graph.sh', `#!/usr/bin/env bash
mode="\${2:-}"; arg="\${3:-}"
case "$mode" in
  --memory-block) echo "done: "; echo "in-progress: "; echo "stuck: "; echo "ready: 1"; echo "waiting: 2" ;;
  --gate-status) if [ "$arg" = "1" ]; then echo "manual: confirm the rollout window"; exit 1; fi; echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $arg" ;;
  --size) echo M ;;
  *) echo "unsupported stub mode: $mode" >&2; exit 2 ;;
esac
`);
  write('phase-lock.sh', '#!/usr/bin/env bash\n[ "${2:-}" = "status" ] && echo "phase ${3:-?}: free"\nexit 0\n');
  write('validate.sh', '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return { root, scripts, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('HH-2: a run held only by a gate halts nothing-ready, and its one holder names that gate', async () => {
  const r = gatedRepo();
  try {
    const spawn: SpawnFn = async () => { throw new Error('a gated phase never spawns'); };
    const instance = new Runner({ scriptsDir: r.scripts, spawn, verificationText: () => '`true`', delegateHumanGates: () => false });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await instance.wait();
    const state = instance.current()!;
    assert.equal(state.status, 'parked');
    assert.equal(state.halt?.kind, 'nothing-ready');
    const holders = state.halt?.holders ?? [];
    assert.equal(holders.length, 1, JSON.stringify(holders));
    assert.equal(holders[0].phase, 1);
    assert.equal(holders[0].kind, 'gate');
    assert.equal(holders[0].verb, 'approve-gate');
    assert.match(holders[0].why, /confirm the rollout window/, 'the gate itself, not "waiting on a gate"');
  } finally { r.cleanup(); }
});
