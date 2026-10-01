/**
 * One journal counter per run file (#51, control-tower phase 52).
 *
 * A journal line's `seq` is what a reader resumes from, so a seq written twice
 * hides one of the two lines from any client whose cursor sits between them.
 * It happened on a live run: the watch scheduler appended through a fresh
 * `new Journal(…)`, which read the tail (488) and wrote 489, while the live
 * runner's own long-lived instance — still believing 488 — wrote its next line
 * as 489 too. Two causes, two answers, both pinned here:
 *
 * - one instance per run file per process — `Journal.for`, the registry every
 *   writer under `server/` goes through (`invariants.test.ts` refuses a
 *   `new Journal(` anywhere else there);
 * - and the FILE is the counter's truth when something the registry does not
 *   own moved it — a writer outside the registry (another process, a test's own
 *   instance) or a file that shrank or vanished.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { Journal, type JournalEntry } from '../server/runner/journal.ts';
import { journalFile } from '../server/runner/run-paths.ts';

function root(): string {
  return mkdtempSync(join(tmpdir(), 'phase-console-journal-counter-'));
}

function seqs(dir: string, slug: string, id: string): number[] {
  return readFileSync(journalFile(dir, slug, id), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as JournalEntry).seq);
}

function strictlyIncreasing(values: number[]): boolean {
  return values.every((value, i) => i === 0 || value > values[i - 1]);
}

test('JC-1: Journal.for returns ONE instance per run file per process — and it numbers on from the file it finds', () => {
  const dir = root();
  try {
    const first = Journal.for(dir, 'plan', 'run1');
    assert.equal(Journal.for(dir, 'plan', 'run1'), first, 'the same run file is the same instance');
    // `instanceId` resolves the root lexically, so two spellings of it are one
    // instance directory, one file — and so must be one counter.
    assert.equal(Journal.for(`${dir}/`, 'plan', 'run1'), first, 'a trailing slash is the same root');
    assert.notEqual(Journal.for(dir, 'plan', 'run2'), first, 'another run is another file');
    assert.notEqual(Journal.for(dir, 'other', 'run1'), first, 'another plan is another file');

    // A run this process has never touched continues the numbering on disk.
    const path = journalFile(dir, 'plan', 'run3');
    const written = new Journal(dir, 'plan', 'run3');
    for (let i = 0; i < 4; i++) written.append('phase.tool', { i });
    assert.equal(Journal.for(dir, 'plan', 'run3').append('run.resume').seq, 5, `continues ${path}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JC-2: appends from a second caller between two of the first\'s keep seqs strictly increasing — through the registry, and from a writer outside it', () => {
  const dir = root();
  try {
    // The shape of run 006df40b: the runner holds its journal for the life of
    // the run; the watch scheduler reaches for one per append.
    const runner = Journal.for(dir, 'tamagui-upgrade', '006df40b');
    runner.append('run.start');
    Journal.for(dir, 'tamagui-upgrade', '006df40b').append('phase.watch-checked', { ref: 'lock:tamagui-upgrade/4', state: 'pending' }, 4);
    runner.append('phase.ruling', { id: 'e88ea20539da' }, 4);
    assert.deepEqual(seqs(dir, 'tamagui-upgrade', '006df40b'), [1, 2, 3], 'the ruling is 3, not a second 2');

    // A writer the registry does not own — another process on the same state
    // directory, stood in for by a direct construction. It read the tail when
    // it was built, and so did the runner's instance; the file decides.
    const outside = new Journal(dir, 'tamagui-upgrade', '006df40b');
    outside.append('phase.declaration-consumed', {}, 4);
    runner.append('run.converge');
    outside.append('phase.wait-settled', {}, 9);
    runner.append('run.plan-recover');
    const all = seqs(dir, 'tamagui-upgrade', '006df40b');
    assert.deepEqual(all, [1, 2, 3, 4, 5, 6, 7]);
    assert.ok(strictlyIncreasing(all), `strictly increasing: ${all.join(',')}`);
    assert.equal(new Set(all).size, all.length, 'no seq twice');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JC-4: a file that shrank or vanished under the instance is numbered from what is on disk — and a vanished directory is made again', () => {
  const dir = root();
  try {
    const journal = Journal.for(dir, 'plan', 'run1');
    for (let i = 0; i < 5; i++) journal.append('phase.tool', { i });
    const path = journalFile(dir, 'plan', 'run1');

    // Cut back to its first two lines (a hand edit, a restore): the next line
    // follows the file, exactly as a fresh construction would number it.
    const kept = readFileSync(path, 'utf8').split('\n').slice(0, 2).join('\n');
    writeFileSync(path, `${kept}\n`);
    assert.equal(journal.append('run.after-cut').seq, 3);
    assert.deepEqual(seqs(dir, 'plan', 'run1'), [1, 2, 3]);

    // The run's whole directory goes (a deleted run). The one instance that
    // outlives it writes again rather than warning forever.
    rmSync(dirname(path), { recursive: true, force: true });
    const entry = journal.append('run.after-delete');
    assert.equal(entry.seq, 1, 'a file that is gone starts where a new one would');
    assert.deepEqual(seqs(dir, 'plan', 'run1'), [1], 'and the line is on disk');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
