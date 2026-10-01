/**
 * The breaker on a console that keeps dying.
 *
 * The measured incident is the design brief. A console reached V8's default
 * heap twice in five minutes; launchd's `KeepAlive` with a ten-second throttle
 * brought it back each time; and each boot adopted the surviving `claude`
 * children of the two runs the previous console had been driving and parked
 * both as `orphaned-session` — while the children carried on at PPID 1, editing
 * repositories with nobody supervising them. The second console's entire life
 * was a transcript check, two token adoptions and twenty hook answers.
 *
 * Four claims here, and the fourth is the one that was missing.
 *
 *   **CL-1..3** — the ledger: one bounded record per crashed boot, and the
 *   arithmetic that turns three of them inside ten minutes into a loop.
 *
 *   **CL-4** — that loop is a boot hold, of the same kind the stop marker and
 *   `autostart: false` already produce, lifted only by a release.
 *
 *   **CL-6** — and the hold reaches the act that actually parked the runs. The
 *   existing hold gated `readoptQueued` and `convergeAutomatic()`; the park was
 *   written by `reconcileRun` on the run-file READ path, with `recoverApprovals`
 *   adopting the token beside it. A breaker that stops the two doors nobody
 *   went through is a breaker that reads green through the whole incident.
 *
 *   **CL-5, CL-7** — and a person is told, once, with the snapshot's path when
 *   there is one to name.
 *
 *   **CL-8** — and the endings it counts are the ones the boot marker caught.
 *   A breaker fed by a verdict that could not see past a few hundred log lines
 *   never counted the slow deaths at all; one fed by the marker counts every
 *   console that owned its port and ended hard, and no launch that never did.
 *
 * `crashes.json` is written under the sandboxed state directory, so nothing
 * here can see or touch the operator's own ledger.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

import {
  CRASH_LEDGER_MAX,
  CRASH_LOOP_BOOTS,
  CRASH_LOOP_WINDOW_MS,
  adoptionHeld,
  crashLedgerFile,
  crashLoop,
  latestHeapSnapshot,
  readCrashLedger,
  recordCrashedBoot,
  releaseBootMarker,
  setAdoptionHold,
  settleBootMarkers,
  writeBootMarker,
} from '../server/crash-ledger.ts';
import { BOOT_HOLD_KINDS } from '../shared/ops-vocab.js';
import { nodeArgsFor } from '../shared/instances.mjs';
import { RETENTION_DEFAULTS } from '../server/retention-policy.ts';

const VIEWER = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirs: string[] = [];

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crash-ledger-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  setAdoptionHold(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

test('CL-1: a crashed boot is recorded where the console can count it, not only where a person can read it', () => {
  const dir = stateDir();
  assert.deepEqual(readCrashLedger(dir), [], 'a console that has never crashed has no ledger');

  recordCrashedBoot({ pid: 769 }, dir);
  recordCrashedBoot({ pid: 23875, snapshot: '/tmp/diag/Heap.20260921.heapsnapshot' }, dir);

  const ledger = readCrashLedger(dir);
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].pid, 769);
  assert.equal(ledger[1].snapshot, '/tmp/diag/Heap.20260921.heapsnapshot');
  assert.ok(Date.parse(ledger[1].at) > 0, 'each entry is stamped');
  assert.ok(readFileSync(crashLedgerFile(dir), 'utf8').startsWith('['), 'it is a file a person can open');
});

test('CL-2: the ledger is bounded — a console in a loop must not also fill a disk', () => {
  const dir = stateDir();
  for (let i = 0; i < CRASH_LEDGER_MAX + 15; i++) recordCrashedBoot({ pid: 1000 + i }, dir);

  const ledger = readCrashLedger(dir);
  assert.equal(ledger.length, CRASH_LEDGER_MAX);
  assert.equal(ledger[ledger.length - 1].pid, 1000 + CRASH_LEDGER_MAX + 14, 'the newest is kept');
  assert.equal(ledger[0].pid, 1015, 'the oldest is what goes');
});

test('CL-3: three hard endings inside the window is a loop; two, or three spread out, are not', () => {
  const dir = stateDir();
  recordCrashedBoot({ pid: 1, at: ago(60_000) }, dir);
  recordCrashedBoot({ pid: 2, at: ago(30_000) }, dir);
  assert.equal(crashLoop(Date.now(), dir), null, `${CRASH_LOOP_BOOTS - 1} is an incident, not a loop`);

  recordCrashedBoot({ pid: 3, at: ago(5_000) }, dir);
  const loop = crashLoop(Date.now(), dir);
  assert.ok(loop, 'and the third inside ten minutes is');
  assert.equal(loop.boots, 3);
  assert.equal(loop.since, readCrashLedger(dir)[0].at, 'named from the first of the run, not the last');

  // A console that crashes once a day for three days is a different problem.
  const spread = stateDir();
  recordCrashedBoot({ pid: 1, at: ago(CRASH_LOOP_WINDOW_MS * 3) }, spread);
  recordCrashedBoot({ pid: 2, at: ago(CRASH_LOOP_WINDOW_MS * 2) }, spread);
  recordCrashedBoot({ pid: 3, at: ago(10) }, spread);
  assert.equal(crashLoop(Date.now(), spread), null, 'the window is what makes it a loop');
});

test('CL-4: a crash loop is a boot-hold kind, owned where the other two live', () => {
  assert.ok(
    BOOT_HOLD_KINDS.includes('crash-loop'),
    'the breaker produces the same shape the stop marker and autostart-off do — a hold an operator releases',
  );
  assert.deepEqual([...BOOT_HOLD_KINDS], ['stopped', 'autostart-off', 'crash-loop']);
});

test('CL-6: every writer of the orphan park consults the hold', () => {
  // The claim this test exists for is a source claim, because the two writers
  // are on opposite sides of the service boundary and no single call can reach
  // both: `reconcileRun` is in `runner/state.ts`, below the service, and
  // `recoverApprovals` is on it. What must be true is that neither can park or
  // adopt without asking, and that is a property of the code, not of a run.
  const state = readFileSync(join(VIEWER, 'server/runner/state.ts'), 'utf8');
  const base = readFileSync(join(VIEWER, 'server/service-base.ts'), 'utf8');

  const orphanPark = state.indexOf("kind: 'orphaned-session'");
  assert.ok(orphanPark > 0, 'the read-path park is still written in state.ts');
  const guardAt = state.indexOf('adoptionHeld()');
  assert.ok(guardAt > 0 && guardAt < orphanPark, 'and it is asked BEFORE the park is written');

  const adoptAt = base.indexOf('adoptToken(');
  assert.ok(adoptAt > 0, 'recoverApprovals still adopts a surviving child\'s token');
  const baseGuard = base.indexOf('adoptionHeld()');
  assert.ok(baseGuard > 0 && baseGuard < adoptAt, 'and it too asks first');

  // And the latch actually latches.
  assert.equal(adoptionHeld(), null);
  setAdoptionHold('crash-loop');
  assert.equal(adoptionHeld(), 'crash-loop');
  setAdoptionHold(null);
  assert.equal(adoptionHeld(), null, 'a release lets the read path speak again');
});

test('CL-5: the crash is a row and a push, and the ledger has a retention sink', () => {
  // The row's own assembly is `inbox.test.ts`'s; what belongs here is that the
  // fact reaches it at all, and that the files it names are swept.
  const inbox = readFileSync(join(VIEWER, 'server/inbox.ts'), 'utf8');
  assert.ok(inbox.includes("subject: 'previous-run-crashed'"), 'the inbox raises the row');
  const base = readFileSync(join(VIEWER, 'server/service-base.ts'), 'utf8');
  assert.ok(base.includes('announceCrashedBoot'), 'and the console says it once per boot');
  assert.ok(
    base.includes("tagFor('health', 'previous-run-crashed'"),
    'as a health push, tagged so a restart storm is not a notification storm',
  );
  assert.equal(
    typeof RETENTION_DEFAULTS.crashRetainDays,
    'number',
    'a snapshot is the size of the heap that wrote it — it needs a policy row',
  );
});

test('CL-7: the near-limit snapshot is a profile key, off by default, beside the heap size', () => {
  const plain = nodeArgsFor({}, { diagDir: '/state/diag', totalBytes: 64 * 1024 ** 3 });
  assert.deepEqual(plain, ['--max-old-space-size=6144'], 'off by default: a snapshot costs a heap of disk');

  const hunting = nodeArgsFor(
    { heapSnapshotOnNearLimit: true },
    { diagDir: '/state/diag', totalBytes: 64 * 1024 ** 3 },
  );
  assert.deepEqual(hunting, [
    '--max-old-space-size=6144',
    '--heapsnapshot-near-heap-limit=1',
    '--diagnostic-dir=/state/diag',
  ], 'and when it is on, the snapshot lands in the instance\'s own state directory');

  // Clamped to half of RAM: a heap larger than the machine turns an
  // out-of-memory exit, which restarts, into swap death, which does not.
  assert.deepEqual(
    nodeArgsFor({ heapMb: 65536 }, { totalBytes: 8 * 1024 ** 3 }),
    ['--max-old-space-size=4096'],
  );
  assert.deepEqual(nodeArgsFor({ heapMb: 2048 }, { totalBytes: 64 * 1024 ** 3 }), ['--max-old-space-size=2048']);

  // And the path the crash row names is found where node was told to write it.
  const dir = stateDir();
  assert.equal(latestHeapSnapshot(dir), null, 'no snapshot is not an error');
  mkdirSync(join(dir, 'diag'), { recursive: true });
  writeFileSync(join(dir, 'diag', 'Heap.20260921.093000.heapsnapshot'), '{}');
  assert.equal(latestHeapSnapshot(dir), join(dir, 'diag', 'Heap.20260921.093000.heapsnapshot'));
});

test('CL-8: the breaker counts the hard endings the boot marker caught, and never a launch the port refused', async () => {
  const dir = stateDir();
  const port = 4130;
  for (let boot = 1; boot <= CRASH_LOOP_BOOTS; boot++) {
    // A console that owned its port and is gone — reaped, with no exit record
    // behind it — and the boot after it, finding its marker.
    const startedAt = new Date().toISOString();
    const { pid } = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    writeBootMarker(port, { pid, startedAt, stateDir: dir });
    const settled = await settleBootMarkers({ pid: 8000 + boot, stateDir: dir });
    assert.deepEqual(settled.crashed.map((marker) => marker.pid), [pid], `boot ${boot} noticed the ending before it`);
    assert.equal(crashLoop(Date.now(), dir) !== null, boot === CRASH_LOOP_BOOTS,
      `after ${boot} of ${CRASH_LOOP_BOOTS} marker-caught endings the breaker must ${boot === CRASH_LOOP_BOOTS ? '' : 'not yet '}trip`);
  }

  // A duplicate launched beside a console that is running — this test process,
  // as far as its marker says — settles at boot, is refused the port and
  // leaves. It met a live owner, so the count must not move.
  writeBootMarker(port, { pid: process.pid, startedAt: new Date(performance.timeOrigin).toISOString(), stateDir: dir });
  const duplicate = await settleBootMarkers({ pid: 8100, stateDir: dir });
  assert.deepEqual(duplicate.crashed, []);
  assert.equal(releaseBootMarker({ pid: 8100, stateDir: dir }), false);

  const loop = crashLoop(Date.now(), dir);
  assert.ok(loop, 'the marker-caught endings are a loop');
  assert.equal(loop.boots, CRASH_LOOP_BOOTS, 'exactly the hard endings — the refused launch added nothing');
  assert.deepEqual(
    readCrashLedger(dir).map((entry) => entry.pid),
    Array.from({ length: CRASH_LOOP_BOOTS }, (_, i) => 8001 + i),
    'each stamped by the boot that noticed it',
  );
});
