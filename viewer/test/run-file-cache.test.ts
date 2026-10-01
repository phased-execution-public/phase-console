/**
 * Reading a run record — once per version of the file, not once per ask.
 *
 * `listRuns` reads and parses every `run-*.json` a plan owns, and the callers
 * that reach it are not page views. The session-inbox sweep runs every ten
 * seconds over every plan in the store; `recoverApprovals` and `readoptQueued`
 * loop the whole portfolio. On the console where this was measured that was 62
 * files and about seven megabytes of JSON re-read 8,640 times a day, and the
 * stack of the second out-of-memory exit had `ReadFileUtf8` under `RunTimers`
 * in it. A finished run's file does not change; re-parsing it is the purest
 * waste this server does.
 *
 * The split that makes the cache safe is the one the tests below pin. Only the
 * PARSE is cached, keyed on the file's own `(mtimeMs, size)` — the same key
 * `runRulings` already uses, for the same reason. `settle()` is not cached and
 * runs on every read, because its answer depends on which runs are live, and a
 * cache that remembered "this run had no live lane" would keep saying so after
 * one started. And every caller gets a CLONE: `settle`, `reconcileRun` and half
 * the service mutate what they are handed, so a shared object would let one
 * reader's repair become another reader's fact.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  clearRunFileCache,
  listRuns,
  loadRun,
  runFileReads,
  runFile,
  runDir,
  type RunState,
} from '../server/runner/state.ts';

const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'run-file-cache-'));
  roots.push(dir);
  return dir;
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** A finished run record, written straight to disk — no service, no runner. */
function writeRun(base: string, slug: string, id: string, extra: Partial<RunState> = {}): string {
  const state = {
    id,
    slug,
    root: base,
    status: 'finished',
    autonomy: 'keep-going',
    model: 'claude-opus-5',
    phaseBudgetUsd: 10,
    runBudgetUsd: 100,
    spentUsd: 1,
    maxConsecutiveFailures: 3,
    consecutiveFailures: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T01:00:00.000Z',
    activePhase: null,
    child: null,
    waitUntil: null,
    halt: null,
    pause: null,
    freeze: null,
    phases: { 1: { phase: 1, status: 'done', attempts: 1 } },
    ...extra,
  };
  mkdirSync(runDir(base, slug), { recursive: true });
  const target = runFile(base, slug, id);
  writeFileSync(target, `${JSON.stringify(state, null, 2)}\n`);
  return target;
}

test('RFC-1: a run file is read once per (mtimeMs, size), and again when it moves', () => {
  const base = root();
  writeRun(base, 'alpha', 'aaaaaaaa');
  clearRunFileCache();

  const first = runFileReads();
  assert.ok(loadRun(base, 'alpha', 'aaaaaaaa'), 'the fixture is readable');
  assert.equal(runFileReads(), first + 1, 'the first read is a read');

  for (let i = 0; i < 20; i++) loadRun(base, 'alpha', 'aaaaaaaa');
  assert.equal(runFileReads(), first + 1, 'twenty more asks cost no further read');

  // A file that moved is a different file. `size` is half the key precisely
  // because a same-second write of the same length would otherwise read stale.
  writeRun(base, 'alpha', 'aaaaaaaa', { spentUsd: 2, updatedAt: '2026-09-01T02:00:00.000Z' });
  const reread = loadRun(base, 'alpha', 'aaaaaaaa');
  assert.equal(runFileReads(), first + 2, 'a changed file is read again');
  assert.equal(reread?.spentUsd, 2, 'and the new content is what comes back');
});

test('RFC-2: ten sweeps over sixty quiet files do zero re-reads', () => {
  const base = root();
  for (let i = 0; i < 60; i++) writeRun(base, 'quiet', `${i}`.padStart(8, '0'));
  clearRunFileCache();

  const cold = runFileReads();
  assert.equal(listRuns(base, 'quiet').length, 60, 'all sixty are on the board');
  assert.equal(runFileReads(), cold + 60, 'the cold sweep reads each file once');

  const warm = runFileReads();
  for (let sweep = 0; sweep < 10; sweep++) {
    assert.equal(listRuns(base, 'quiet').length, 60);
  }
  assert.equal(
    runFileReads() - warm,
    0,
    'ten sweeps over files nothing wrote cost not one read — this is the 8,640-a-day line',
  );
});

test('RFC-3: every caller gets its own object — a mutating reader cannot reach the cache', () => {
  const base = root();
  writeRun(base, 'beta', 'bbbbbbbb');
  clearRunFileCache();

  const mine = loadRun(base, 'beta', 'bbbbbbbb');
  const yours = loadRun(base, 'beta', 'bbbbbbbb');
  assert.ok(mine && yours);
  assert.notEqual(mine, yours, 'two reads are two objects');
  assert.notEqual(mine.phases, yours.phases, 'and the clone is deep');

  mine.status = 'halted';
  mine.spentUsd = 999;
  mine.phases['1'].status = 'failed';

  assert.equal(yours.status, 'finished', 'the other reader is untouched');
  const later = loadRun(base, 'beta', 'bbbbbbbb');
  assert.equal(later?.status, 'finished', 'and so is the next one');
  assert.equal(later?.spentUsd, 1);
  assert.equal(later?.phases['1'].status, 'done', 'including down inside the records');

  // The same promise through the list path, which is what the sweep uses.
  const listed = listRuns(base, 'beta')[0];
  listed.phases['1'].attempts = 42;
  assert.equal(listRuns(base, 'beta')[0].phases['1'].attempts, 1);
});
