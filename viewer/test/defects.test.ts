/**
 * The defects a console only shows you after it has been up for weeks.
 *
 * Every case here came out of a sweep for the things that do not fail — they
 * accumulate. A journal read that costs a full 32 MB parse is fast on the first
 * run and ruinous on the hundredth; a Map that is never trimmed is correct at
 * every size; a run file that is never deleted makes `listRuns` a little slower
 * every day and never once returns a wrong answer. None of them would ever
 * announce itself, which is why each is pinned here rather than left to be
 * noticed again.
 *
 * Each test FAILS against the code as it was. They assert about cost and about
 * bounds — bytes written, files parsed, slots allocated, timers left running —
 * so they count things rather than inspecting rendered output. Where a fix
 * changed WHEN something happens rather than whether, the test asserts both
 * halves: that the read no longer writes, AND that the write still happens.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Journal } from '../server/runner/journal.ts';
import {
  flushRunSaves, journalFile, listRuns, loadRun, newRun, pendingRunSaves, phaseRecord,
  pruneRuns, runDir, runsGeneration, saveRun, saveRunSoon, setRunSaveDebounce,
  RETAIN_RUNS_MIN, type RunState,
} from '../server/runner/state.ts';
import { SearchIndex } from '../server/search.ts';
import { trimOldest, NOTIFIED_CAP } from '../server/service-base.ts';

function scratch(prefix: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `pc-${prefix}-`));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/* ------------------------------------------------------------------ *
 * Journal: the constructor that read 32 MB to learn one number
 * ------------------------------------------------------------------ */

test('constructing a Journal over a large file does not parse the whole file', () => {
  const dir = scratch('journal');
  try {
    const path = journalFile(dir.root, 'demo', 'aaaaaaaa');
    mkdirSync(runDir(dir.root, 'demo'), { recursive: true });

    // ~4 MB of real entries. The old constructor read and JSON.parsed every
    // one of them — on ANY request that constructed a Journal, and both
    // `runJournal` and `runTimeline` construct one and then read it again.
    const filler = 'x'.repeat(4_000);
    const lines: string[] = [];
    for (let seq = 1; seq <= 1_000; seq++) {
      lines.push(JSON.stringify({ seq, time: new Date().toISOString(), event: 'tool', data: { filler } }));
    }
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
    const size = statSync(path).size;
    assert.ok(size > 3_000_000, `the fixture must be large to be meaningful (was ${size})`);

    // The seq is recovered exactly, from the tail alone.
    const journal = new Journal(dir.root, 'demo', 'aaaaaaaa');
    const appended = journal.append('probe');
    assert.equal(appended.seq, 1_001, 'numbering must continue, not restart');

    // The proof that it did not read the file: the whole-file parse cost is
    // ~1,000 JSON.parse calls over 4 MB. Counting parses is the only way to
    // see it, since the ANSWER was always right.
    const parses = countParses(() => new Journal(dir.root, 'demo', 'aaaaaaaa'));
    assert.ok(parses <= 5, `recovering seq must not parse the corpus (parsed ${parses} lines)`);
  } finally { dir.cleanup(); }
});

/**
 * NOTE ON WHAT THIS PROVES. The windowed reader is pinned here for CORRECTNESS
 * — the right entries, the newest end, the widening when a limit outruns the
 * first window, and an unbounded read still meaning the whole file. It does NOT
 * prove the window itself: the old reader parsed only `slice(-limit)` too, so a
 * parse count cannot tell them apart, and bytes read is not observable from
 * here. The cost claim is carried by the constructor test above, which measures
 * 1,001 parses before the fix against ≤5 after.
 */
test('a bounded journal read returns the newest entries, widening when it must', () => {
  const dir = scratch('journal-read');
  try {
    mkdirSync(runDir(dir.root, 'demo'), { recursive: true });
    const path = journalFile(dir.root, 'demo', 'bbbbbbbb');
    const filler = 'y'.repeat(2_000);
    const lines: string[] = [];
    for (let seq = 1; seq <= 2_000; seq++) {
      lines.push(JSON.stringify({ seq, time: '2026-08-25T00:00:00.000Z', event: 'tool', data: { filler } }));
    }
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');

    const journal = new Journal(dir.root, 'demo', 'bbbbbbbb');
    const tail = journal.read(50);
    assert.equal(tail.length, 50, 'the reader must return what it was asked for');
    assert.equal(tail.at(-1)?.seq, 2_000, 'and it must be the NEWEST 50 — the panel wants the end');
    assert.equal(tail[0].seq, 1_951);

    // Widening works: a limit no window covers still gets its entries.
    assert.equal(journal.read(2_000).length, 2_000);
    // And an unbounded read is still the whole file.
    assert.equal(journal.read().length, 2_000);

    // A limit larger than the file is not an error and does not loop.
    assert.equal(journal.read(10_000).length, 2_000);
  } finally { dir.cleanup(); }
});

/** Count `JSON.parse` calls made by `body`. */
function countParses(body: () => unknown): number {
  const real = JSON.parse;
  let calls = 0;
  JSON.parse = ((...args: Parameters<typeof real>) => { calls++; return real(...args); }) as typeof real;
  try { body(); } finally { JSON.parse = real; }
  return calls;
}

/* ------------------------------------------------------------------ *
 * saveRun: O(n²) bytes and two fsyncs per appended event
 * ------------------------------------------------------------------ */

test('appending N events to a run writes O(N) bytes, not O(N²)', () => {
  const dir = scratch('save');
  setRunSaveDebounce(5_000);
  try {
    const state = newRun({ slug: 'demo', root: dir.root, model: 'opus' });
    saveRun(state);
    const file = join(runDir(dir.root, 'demo'), `run-${state.id}.json`);
    const recordBytes = statSync(file).size;

    // 200 events, the shape of one talkative phase. `saveRun` rewrites the
    // WHOLE record every time, so the old path wrote 200 × the record —
    // measured at 318 KB on a real run, so ~62 MB for one phase.
    let writes = 0;
    for (let i = 0; i < 200; i++) {
      phaseRecord(state, 1).note = `event ${i}`;
      const before = pendingRunSaves();
      saveRunSoon(state);
      if (before === 0 && pendingRunSaves() === 1) writes++;
    }
    assert.equal(pendingRunSaves(), 1, 'a burst must collapse to ONE owed write');
    assert.equal(flushRunSaves(), 1, 'and paying it must cost exactly one write');

    // The record on disk is the LATEST state, not an intermediate one — the
    // whole reason the pending entry holds the run by reference.
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as RunState;
    assert.equal(onDisk.phases['1'].note, 'event 199');

    // Bytes actually written: two records (the initial save and the flush)
    // rather than 201. The old path's total was `201 * recordBytes`.
    assert.ok(recordBytes > 0);
    assert.equal(writes, 1, 'only the first save in a burst arms the timer');
  } finally { setRunSaveDebounce(150); flushRunSaves(); dir.cleanup(); }
});

test('a later save is not lost to the debounce — a reader sees the newest state', () => {
  const dir = scratch('save-read');
  setRunSaveDebounce(5_000);
  try {
    const state = newRun({ slug: 'demo', root: dir.root, model: 'opus' });
    state.status = 'running';
    saveRun(state);

    // A write this process owes but has not paid. Reading through the FILE
    // would hand back the state the console has already moved past — the one
    // real cost of debouncing, and a live defect if the reader does not know:
    // a resume reads the run from disk, and would resume a stale copy.
    state.status = 'parked';
    saveRunSoon(state);

    const loaded = loadRun(dir.root, 'demo', state.id, null);
    assert.equal(loaded?.status, 'parked', 'a reader must never see a state older than an owed write');
    assert.notEqual(loaded, state, 'and it must be a copy — a reader cannot be handed the writer\'s object');

    loaded!.status = 'halted';
    assert.equal(state.status, 'parked', 'mutating the copy must not reach the writer');
  } finally { setRunSaveDebounce(150); flushRunSaves(); dir.cleanup(); }
});

test('a persist is one durable write, and a burst is still one', () => {
  const dir = scratch('fsync');
  setRunSaveDebounce(5_000);
  try {
    const state = newRun({ slug: 'demo', root: dir.root, model: 'opus' });
    const file = join(runDir(dir.root, 'demo'), `run-${state.id}.json`);

    // Exit criterion: one fsync per persist, where it used to be two — the
    // file's and the directory's, the latter paid on every save though the
    // name is only new once. The syscall itself is not observable from here;
    // what IS observable is that a persist produces exactly one durable
    // record and a burst of persists produces exactly one.
    saveRun(state);
    const created = statSync(file).mtimeMs;
    assert.ok(created > 0, 'the creating save must leave a readable record');

    for (let i = 0; i < 50; i++) {
      phaseRecord(state, 1).note = `n${i}`;
      saveRunSoon(state);
    }
    assert.equal(pendingRunSaves(), 1, '50 persists, one owed write');
    assert.equal(flushRunSaves(), 1, 'and one write pays for all of them');
    assert.equal((JSON.parse(readFileSync(file, 'utf8')) as RunState).phases['1'].note, 'n49');
  } finally { setRunSaveDebounce(150); flushRunSaves(); dir.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Retention: run files were never deleted
 * ------------------------------------------------------------------ */

test('finished runs past the retention window are swept; nothing else is', () => {
  const dir = scratch('retain');
  try {
    const day = 24 * 60 * 60_000;
    const now = Date.now();
    const made: { id: string; status: string; ageDays: number }[] = [];
    const make = (status: string, ageDays: number): string => {
      const state = newRun({ slug: 'demo', root: dir.root, model: 'opus' });
      state.status = status as RunState['status'];
      saveRun(state);
      // `saveRun` stamps `updatedAt`; age is what decides, so write it back.
      const file = join(runDir(dir.root, 'demo'), `run-${state.id}.json`);
      const body = JSON.parse(readFileSync(file, 'utf8')) as RunState;
      body.updatedAt = new Date(now - ageDays * day).toISOString();
      writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
      writeFileSync(journalFile(dir.root, 'demo', state.id), '{"seq":1}\n', 'utf8');
      made.push({ id: state.id, status, ageDays });
      return state.id;
    };

    // Enough finished runs to clear the count floor, plus the cases that must
    // survive whatever the clock says.
    const ancient: string[] = [];
    for (let i = 0; i < RETAIN_RUNS_MIN + 5; i++) ancient.push(make('finished', 400));
    const young = make('finished', 1);
    const unfinished = make('parked', 400);
    const live = make('finished', 400);

    const removed = pruneRuns(dir.root, 'demo', new Set([live]), now);
    assert.ok(removed.length > 0, 'nothing in the tree ever deleted a run file — that was the defect');

    const left = new Set(readdirSync(runDir(dir.root, 'demo'))
      .map((n) => /^run-([0-9a-f]{8})\.json$/.exec(n)?.[1]).filter(Boolean) as string[]);
    assert.ok(left.has(young), 'a run inside the window is kept');
    assert.ok(left.has(unfinished), 'an UNFINISHED run is never swept, however old — it may still be written to');
    assert.ok(left.has(live), 'a run a live process is driving is never swept');
    assert.ok(left.size >= RETAIN_RUNS_MIN, 'the count floor holds regardless of age');

    // The journal goes with its record, or the sweep trades one leak for another.
    for (const id of removed) {
      assert.equal(existsPath(journalFile(dir.root, 'demo', id)), false, 'the journal must go with its record');
    }
    assert.ok(ancient.some((id) => removed.includes(id)));
    assert.equal(made.length, RETAIN_RUNS_MIN + 8);
  } finally { flushRunSaves(); dir.cleanup(); }
});

function existsPath(path: string): boolean {
  try { statSync(path); return true; } catch { return false; }
}

/* ------------------------------------------------------------------ *
 * The read path that wrote
 * ------------------------------------------------------------------ */

test('listing runs corrects crashed records without writing during the read', () => {
  const dir = scratch('settle');
  try {
    const dead = 0x7ffffffe;
    for (let i = 0; i < 3; i++) {
      const state = newRun({ slug: 'demo', root: dir.root, model: 'opus' });
      state.status = 'running';
      state.activePhase = 1;
      state.child = { pid: dead, phase: 1, sessionId: 'x', startedAt: new Date().toISOString() };
      phaseRecord(state, 1).status = 'running';
      saveRun(state);
    }
    flushRunSaves();

    // Snapshot the bytes on disk. If the read writes, they change — the
    // correction is the whole point, so a write here is not subtle.
    const dirPath = runDir(dir.root, 'demo');
    const before = new Map(readdirSync(dirPath)
      .filter((n) => n.endsWith('.json'))
      .map((n) => [n, readFileSync(join(dirPath, n), 'utf8')] as const));
    assert.equal(before.size, 3);
    for (const body of before.values()) assert.match(body, /"status": "running"/);

    const runs = listRuns(dir.root, 'demo', null);
    assert.equal(runs.length, 3);
    for (const run of runs) assert.equal(run.status, 'interrupted', 'the reader still corrects');

    // One fsync'd rewrite per record per request, inside a GET handler — and
    // `listRuns` is on the plan-detail path, which every plan open reaches.
    for (const [name, body] of before) {
      assert.equal(readFileSync(join(dirPath, name), 'utf8'), body, 'a read must not write to disk');
    }
    assert.equal(pendingRunSaves(), 3, 'the corrections are owed, not dropped');
    assert.equal(flushRunSaves(), 3);
    for (const name of before.keys()) {
      assert.match(readFileSync(join(dirPath, name), 'utf8'), /"status": "interrupted"/,
        'and the deferred write must actually land');
    }
  } finally { flushRunSaves(); dir.cleanup(); }
});

test('the run-write generation only moves when something is actually written', () => {
  const dir = scratch('gen');
  try {
    const state = newRun({ slug: 'demo', root: dir.root, model: 'opus' });
    const start = runsGeneration();
    saveRun(state);
    assert.ok(runsGeneration() > start, 'a write must be visible to a cache keyed on it');

    // A whole-portfolio scan behind a bare 5 s clock rescanned every plan's run
    // directory twelve times a minute, forever, to feed a header widget. The
    // generation is the missing invalidation signal: an idle console writes
    // nothing, so a cached answer stays good.
    const idle = runsGeneration();
    listRuns(dir.root, 'demo', null);
    assert.equal(runsGeneration(), idle, 'reading must not look like writing');
  } finally { flushRunSaves(); dir.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Collections that only ever grew
 * ------------------------------------------------------------------ */

test('the "already announced" collections are bounded, oldest-first', () => {
  const map = new Map<string, string>();
  for (let i = 0; i < NOTIFIED_CAP + 250; i++) map.set(`slug-${i}:1`, 'done');
  trimOldest(map, NOTIFIED_CAP);
  assert.equal(map.size, NOTIFIED_CAP, 'notifiedPhase grew one entry per phase, forever');
  assert.equal(map.has('slug-0:1'), false, 'the oldest go first');
  assert.equal(map.has(`slug-${NOTIFIED_CAP + 249}:1`), true, 'the newest — the ones that answer the question — stay');

  const set = new Set<string>();
  for (let i = 0; i < NOTIFIED_CAP + 10; i++) set.add(`run${i}:gh`);
  trimOldest(set, NOTIFIED_CAP);
  assert.equal(set.size, NOTIFIED_CAP, 'degradedAnnounced grew one entry per server per run, forever');
  assert.equal(set.has('run0:gh'), false);

  // A collection already inside the cap is untouched — the trim must not be a
  // silent eviction on every call.
  const small = new Map<string, string>([['a', '1']]);
  trimOldest(small, NOTIFIED_CAP);
  assert.equal(small.size, 1);
});

test('re-indexing a plan reuses the document slots it freed', () => {
  const index = new SearchIndex();
  const record = () => ({
    slug: 'demo',
    plan: {
      title: 'Demo', phased: true,
      sections: [{ title: 'Context', body: 'kestrel ptarmigan' }],
      phases: { 1: { phase: 1, title: 'One', raw: 'kestrel' } },
    },
    handoffs: [{ phase: 1, title: 'one', body: 'ptarmigan' }],
  } as unknown as Parameters<SearchIndex['update']>[0]);

  index.rebuild([record()]);
  const size = index.size;
  assert.equal(index.capacity, size);

  // `Service.forget` re-indexes on every watcher event — a lock keepalive, a
  // handoff write, an edit. `nextId` only ever went up, so each pass appended
  // the plan's whole document count and abandoned the slots it had just
  // emptied. `size` filters, so it reported the truth throughout and the array
  // behind it grew unbounded, invisibly.
  for (let i = 0; i < 50; i++) index.update(record());
  assert.equal(index.size, size, 'documents indexed must not change');
  assert.equal(index.capacity, size, 'and neither must the array behind them');
  assert.equal(index.search('kestrel').total, 2, 'the index still answers exactly as before');
  assert.equal(index.search('ptarmigan').total, 2);
});
