/**
 * Where a run's files live, and the ONE matcher that names them
 * (control-tower phase 94, #133).
 *
 * The session replay was one file per RUN, `run-<id>.log.jsonl`, with a 16 MB
 * hard stop — so a long run's later phases replayed nothing. It is now one file
 * per PHASE beside the record, and the names that say so are composed here, in
 * the leaf every other module already takes its paths from. Three readers used
 * to spell the sidecar pattern for themselves (retention's inventory,
 * `pruneRuns`, the debug bundle), and none of them knew the archived names an
 * operator's workaround left behind on 2026-09-25 (`.old`, `.full-<stamp>`), so
 * those were kept for ever. One matcher, so the next name is added once.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { isRunSidecar, runDir, runSidecarId, transcriptFile, transcriptPhase } from '../server/runner/run-paths.ts';

const ROOT = '/tmp/run-paths-fixture-root';

test('RP-1a — a phase replays from its own file beside the run record; the run keeps one for phase-less lines', () => {
  const dir = runDir(ROOT, 'demo');
  assert.equal(transcriptFile(ROOT, 'demo', 'abcd1234', 7), join(dir, 'run-abcd1234.p7.log.jsonl'));
  assert.equal(transcriptFile(ROOT, 'demo', 'abcd1234', 94), join(dir, 'run-abcd1234.p94.log.jsonl'));
  assert.equal(transcriptFile(ROOT, 'demo', 'abcd1234'), join(dir, 'run-abcd1234.log.jsonl'));
});

test('RP-1b — a live replay name reads back to its phase, and nothing else does', () => {
  assert.equal(transcriptPhase('run-abcd1234.p7.log.jsonl', 'abcd1234'), 7);
  assert.equal(transcriptPhase('run-abcd1234.log.jsonl', 'abcd1234'), null);
  for (const other of [
    // archives are kept evidence, not a replay a writer may append to
    'run-abcd1234.log.jsonl.old',
    'run-abcd1234.log.jsonl.full-20260925T170500Z',
    'run-abcd1234.p7.log.jsonl.old',
    // another run whose id merely starts the same way
    'run-abcd1234bbbb.p7.log.jsonl',
    'run-abcd1234bbbb.log.jsonl',
    // the run's other sidecars
    'run-abcd1234.jsonl',
    'run-abcd1234-p7-tasks.ndjson',
    'run-abcd1234.json',
  ]) {
    assert.equal(transcriptPhase(other, 'abcd1234'), undefined, `${other} is not a live replay of run abcd1234`);
  }
});

test('RP-7a — one matcher names every file a run leaves, archived replays included, by the exact id', () => {
  const id = '9c66853e1db3';
  for (const name of [
    `run-${id}.jsonl`,
    `run-${id}.log.jsonl`,
    `run-${id}.p94.log.jsonl`,
    // the names on this machine on 2026-09-26: the workaround moved full files aside
    `run-${id}.log.jsonl.old`,
    `run-${id}.log.jsonl.full-20260925T170500Z`,
    `run-${id}.p3.log.jsonl.old`,
    `run-${id}.p3.log.jsonl.full-20260926T070000Z`,
    `run-${id}.git.ndjson`,
    `run-${id}-p3-tasks.ndjson`,
    `run-${id}-p3-outcome.json`,
  ]) {
    assert.equal(runSidecarId(name), id, name);
    assert.equal(isRunSidecar(name, id), true, name);
  }
  // The record is not a sidecar of itself, a longer id is a different run, and
  // an unknown suffix is nobody's to delete.
  assert.equal(runSidecarId(`run-${id}.json`), null);
  assert.equal(isRunSidecar(`run-${id}bbbb.p3.log.jsonl`, id), false, 'a prefix match takes another run’s files');
  assert.equal(isRunSidecar(`run-${id}bbbb.log.jsonl.old`, id), false);
  assert.equal(runSidecarId(`run-${id}.log.jsonl.bak`), null);
  assert.equal(runSidecarId(`run-${id}.pX.log.jsonl`), null);
  assert.equal(runSidecarId('notes.txt'), null);
});
