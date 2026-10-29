/**
 * The run record's persist, measured (measured-console phase 17, B5).
 *
 * The fixture is one-pool's run `410a042587c8` on the pe-hub instance, in SHAPE:
 * read 2026-10-27 it was 1,168,594 bytes of pretty JSON — 41 phase records
 * (10.6 KB smallest, 18.2 KB median, 49.2 KB largest) under 56 top-level fields
 * (158 KB, `rulings` 110 KB of it) — beside a 2,298,683-byte journal. The test
 * builds a record of that shape rather than reading the operator's file: a test
 * never touches the operator's state (`state-isolation.test.ts`).
 *
 * The workload is what a live phase does to its record: one phase record moves,
 * and a save follows. Before (`persistModel` 1, every save the whole record) and
 * after (2: the changed records appended to `run-<id>.json.delta`, the whole
 * record at most every `persistFullEveryMs` or on a status change), each with
 * ONE fsync per write. The bounds below are the ones the handoff records.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = await import('../server/runner/state.ts');
const { newRun, saveRun, loadRun, runFile, setPersistFullEvery, persistStats } = state;
const { runDeltaFile } = await import('../server/runner/run-paths.ts');

/** A string of `bytes` characters, varied so nothing compresses it into a lie. */
function pad(bytes: number, seed: number): string {
  let out = '';
  for (let i = 0; out.length < bytes; i++) out += `${seed}:${i}:${'abcdefghij'.slice(i % 10)} `;
  return out.slice(0, bytes);
}

/** A run record of one-pool's shape: 41 phases, the median and the extremes, a 110 KB rulings list. */
function onePoolShaped(root: string) {
  const run = newRun({ slug: 'one-pool', root, model: 'claude-opus-5-5' });
  // The median phase is 18.2 KB pretty-printed with its fields; its padding is set so the record totals one-pool's 1.17 MB.
  const sizes = Array.from({ length: 41 }, (_, i) => (i === 0 ? 10_600 : i === 40 ? 49_000 : 24_500));
  run.phases = Object.fromEntries(sizes.map((bytes, i) => [String(i + 1), {
    phase: i + 1, status: 'done', attempts: 1, note: pad(bytes, i), startedAt: '2026-10-17T00:00:00.000Z',
  }])) as never;
  (run as unknown as Record<string, unknown>).rulings = Array.from({ length: 220 }, (_, i) => ({ id: `r${i}`, what: pad(480, 1000 + i) }));
  (run as unknown as Record<string, unknown>).notes = pad(7_700, 7);
  return run;
}

/** Move one phase record and save, `saves` times; what each save cost. */
function workload(run: ReturnType<typeof newRun>, saves: number) {
  const target = runFile(run.root, run.slug, run.id);
  const before = persistStats();
  const started = performance.now();
  for (let i = 0; i < saves; i++) {
    const record = run.phases[String((i % 41) + 1)] as unknown as Record<string, unknown>;
    record.attempts = i + 2;
    record.progress = `tick ${i}`;
    saveRun(run);
  }
  const ms = performance.now() - started;
  const after = persistStats();
  return {
    msPerSave: ms / saves,
    bytesPerSave: (after.bytes - before.bytes) / saves,
    fsyncsPerSave: (after.fsyncs - before.fsyncs) / saves,
    fileBytes: statSync(target).size,
  };
}

test('B5 — the one-pool-shaped record persists only what changed, under the recorded bound, with one fsync per write', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'persist-bench-'));
  try {
    const SAVES = 60;
    // Before: every save the whole record (a full write every time).
    setPersistFullEvery(0);
    const full = onePoolShaped(root);
    saveRun(full);
    const old = workload(full, SAVES);
    // After: the changed records, a full write at most every minute.
    setPersistFullEvery(60_000);
    const inc = onePoolShaped(root);
    saveRun(inc);
    const now = workload(inc, SAVES);
    t.diagnostic(`before: ${old.msPerSave.toFixed(2)} ms/save, ${Math.round(old.bytesPerSave)} B/save, ${old.fsyncsPerSave} fsync/save, file ${old.fileBytes} B`);
    t.diagnostic(`after:  ${now.msPerSave.toFixed(2)} ms/save, ${Math.round(now.bytesPerSave)} B/save, ${now.fsyncsPerSave} fsync/save`);
    assert.ok(old.bytesPerSave > 1_000_000, `the full record is one-pool's size (${Math.round(old.bytesPerSave)} B)`);
    assert.equal(old.fsyncsPerSave, 1, 'a full write is one fsync');
    assert.equal(now.fsyncsPerSave, 1, 'an incremental write is one fsync');
    assert.ok(now.bytesPerSave < 64 * 1024, `a save writes the record that moved, not the run (${Math.round(now.bytesPerSave)} B)`);
    assert.ok(now.bytesPerSave * 15 < old.bytesPerSave, 'at least fifteen times fewer bytes per save');
    // Time is measured, never the bound: each save still serializes the record to find what
    // moved, so the win is the bytes and the fsync'd size — and it must never cost more.
    assert.ok(now.msPerSave < old.msPerSave * 1.25, `never slower (${now.msPerSave.toFixed(2)} vs ${old.msPerSave.toFixed(2)} ms)`);
    // What a reader sees is the record as it is, base and delta folded.
    const read = loadRun(root, inc.slug, inc.id, null)!;
    assert.equal(read.persistModel, 2);
    for (const [key, record] of Object.entries(inc.phases)) {
      assert.deepEqual(read.phases[key], JSON.parse(JSON.stringify(record)), `phase ${key} reads back as written`);
    }
    assert.ok(statSync(runDeltaFile(runFile(root, inc.slug, inc.id))).size > 0, 'the moves are in the delta file');
    // A status change is a full write, so a reader of the base file alone sees it at once.
    inc.status = 'finished';
    saveRun(inc);
    assert.equal(statSync(runDeltaFile(runFile(root, inc.slug, inc.id)), { throwIfNoEntry: false })?.size ?? 0, 0, 'the delta is folded into the base');
  } finally {
    setPersistFullEvery(60_000);
    rmSync(root, { recursive: true, force: true });
  }
});
