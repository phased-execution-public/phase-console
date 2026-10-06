/**
 * Retention leaves live trees alone (control-tower phase 112, #171).
 *
 * The retention inventory re-measured a kept tree with `du -sk` whenever its
 * mtime moved — and a LIVE run's mirror moves all the time. The per-directory
 * guard stopped two scans of one directory, never a fan-out across a mirror's
 * repositories: three `du` children of the console ran at once at load 279 on
 * 14 cores, one 42 s past its 30 s timeout, and every read API timed out in the
 * window. On a 14-repository mirror 1,419 of 1,419 scans hit the cap and were
 * killed without ever producing a number.
 *
 *   RT-1  a tree whose run is live, or whose mtime moved in the last ten
 *         minutes, is never measured — the last known size is served
 *   RT-2  at most ONE measurement runs console-wide; a `du` past its timeout is
 *         ended through the signals ladder (SIGCONT, SIGTERM to its group, then
 *         SIGKILL), and a tree that timed out is not retried on every poll
 *   RT-3  nothing is measured while the one-minute load exceeds 2× the cores
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectRetention, keptTreeBytes, TREE_QUIET_MS } from '../server/retention.ts';
import { treeDisk, TREE_DISK_RETRY_MS } from '../server/runner/worktree.ts';
import { shell, type ShellOptions, type ShellRun } from '../server/shell.ts';

const settle = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

function tree(base: string, name: string, minutesAgo = 30): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'file.txt'), 'x\n');
  const at = (Date.now() - minutesAgo * 60_000) / 1000;
  utimesSync(dir, at, at);
  return dir;
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'p112-rt-'));
}

test('RT-1 — a live tree, or one that moved in the last ten minutes, is never measured', async () => {
  const base = scratch();
  try {
    let measured = 0;
    const measure = async (): Promise<number> => { measured++; return 4096; };

    const live = tree(base, 'live');
    assert.equal(keptTreeBytes(live, measure, { live: true }), undefined);
    await settle();
    assert.equal(measured, 0, 'a live run\'s tree is not measured, whatever its mtime says');

    const moving = tree(base, 'moving', 2);
    assert.equal(keptTreeBytes(moving, measure, { live: false }), undefined);
    await settle();
    assert.equal(measured, 0, `a tree that moved inside ${TREE_QUIET_MS / 60_000} minutes is still being written`);

    const quiet = tree(base, 'quiet', 11);
    assert.equal(keptTreeBytes(quiet, measure, { live: false }), undefined, 'the first read measures in the background');
    await settle();
    assert.equal(measured, 1);
    assert.equal(keptTreeBytes(quiet, measure, { live: false }), 4096);
    // …and once known, a tree that turns live keeps its LAST size, unmeasured.
    assert.equal(keptTreeBytes(quiet, measure, { live: true }), 4096);
    await settle();
    assert.equal(measured, 1);
    assert.equal(TREE_QUIET_MS, 10 * 60_000);

    // The inventory tells the lookup which trees are live.
    const runsDir = join(base, 'runs');
    const kept = join(runsDir, 'demo', 'worktrees');
    tree(kept, 'aaaaaaaa');
    tree(kept, 'bbbbbbbb');
    const asked: { dir: string; live?: boolean }[] = [];
    collectRetention({
      instanceDir: join(base, 'instance'), runsDir, live: { demo: ['aaaaaaaa'] },
      treeBytes: (dir, facts) => { asked.push({ dir, live: facts?.live }); return undefined; },
    });
    assert.deepEqual(asked.map((entry) => [entry.dir.split('/').pop(), entry.live]).sort(),
      [['aaaaaaaa', true], ['bbbbbbbb', false]]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('RT-2 — one measurement console-wide, a timeout ended through the ladder, a too-large tree not retried every poll', async () => {
  const base = scratch();
  try {
    // The inventory's half: three quiet trees, one pending measurement.
    let pending: ((bytes: number) => void) | null = null;
    let calls = 0;
    const measure = (): Promise<number> => { calls++; return new Promise((resolve) => { pending = resolve; }); };
    const [a, b, c] = ['a', 'b', 'c'].map((name) => tree(base, name, 30));
    keptTreeBytes(a!, measure, { live: false });
    keptTreeBytes(b!, measure, { live: false });
    keptTreeBytes(c!, measure, { live: false });
    assert.equal(calls, 1, 'a fan-out across trees still starts ONE measurement');
    pending!(1024);
    await settle();
    keptTreeBytes(b!, measure, { live: false });
    assert.equal(calls, 2, 'the next one starts only once the first has answered');
    pending!(2048);
    await settle();

    // The primitive's half: `treeDisk` itself runs one `du` at a time, asks for
    // the ladder at its ceiling, and remembers a tree too large to measure.
    const seen: { argv: readonly string[]; options: ShellOptions }[] = [];
    let release: (() => void) | null = null;
    const slow = (_file: string, argv: readonly string[], options: ShellOptions): Promise<ShellRun> => {
      seen.push({ argv, options });
      return new Promise((resolve) => {
        release = () => resolve({ ok: false, code: null, signal: 'SIGTERM', stdout: '', stderr: '', ms: 30_000, truncatedBytes: 0, timedOut: true });
      });
    };
    const load = () => ({ one: 1, cpus: 8 });
    const first = treeDisk(a!, { exec: slow, load });
    assert.equal(await treeDisk(b!, { exec: slow, load }), undefined, 'a second `du` does not start while one runs');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.options.ceiling, 'ladder', 'its ceiling walks the signals ladder');
    assert.deepEqual([...seen[0]!.argv], ['-sk', a]);
    release!();
    assert.equal(await first, undefined, 'a timed-out scan has no size');
    assert.equal(await treeDisk(a!, { exec: slow, load }), undefined);
    assert.equal(seen.length, 1, `a tree too large to measure is not retried for ${TREE_DISK_RETRY_MS / 3_600_000} h`);
    const ok = (_file: string, _argv: readonly string[]): Promise<ShellRun> => Promise.resolve({
      ok: true, code: 0, signal: null, stdout: '12\t/x\n', stderr: '', ms: 3, truncatedBytes: 0, timedOut: false,
    });
    assert.equal(await treeDisk(b!, { exec: ok, load }), 12 * 1024, 'another tree is measured once the slot is free');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('RT-2 — the shell seam\'s ladder ceiling ends a command with SIGTERM to its group, and SIGKILL only if that is refused', async () => {
  const polite = await shell('sleep', ['30'], {
    channel: 'shell', intent: 'rt-ladder', timeout: 300, ceiling: 'ladder', expectFailure: true,
  });
  assert.equal(polite.timedOut, true);
  assert.equal(polite.signal, 'SIGTERM', `a process that honours SIGTERM ends on it: ${JSON.stringify(polite)}`);
  assert.ok(polite.ms < 10_000, `${polite.ms} ms`);

  const stubborn = await shell('sh', ['-c', 'trap "" TERM; sleep 30'], {
    channel: 'shell', intent: 'rt-ladder', timeout: 300, ceiling: 'ladder', expectFailure: true,
  });
  assert.equal(stubborn.timedOut, true);
  assert.equal(stubborn.signal, 'SIGKILL', `one that ignores SIGTERM is killed: ${JSON.stringify(stubborn)}`);
  assert.ok(stubborn.ms < 15_000, `${stubborn.ms} ms`);
});

test('RT-3 — nothing is measured while the one-minute load exceeds 2× the cores', async () => {
  const base = scratch();
  try {
    const dir = tree(base, 'quiet', 30);
    let spawned = 0;
    const exec = (_file: string, _argv: readonly string[]): Promise<ShellRun> => {
      spawned++;
      return Promise.resolve({ ok: true, code: 0, signal: null, stdout: '4\t/x\n', stderr: '', ms: 1, truncatedBytes: 0, timedOut: false });
    };
    assert.equal(await treeDisk(dir, { exec, load: () => ({ one: 29, cpus: 14 }) }), undefined);
    assert.equal(spawned, 0, 'load 29 on 14 cores: the number can wait');
    assert.equal(await treeDisk(dir, { exec, load: () => ({ one: 27, cpus: 14 }) }), 4 * 1024);
    assert.equal(spawned, 1, 'under 2× the cores it measures');
    // A live tree is never handed to `du` at all.
    assert.equal(await treeDisk(dir, { exec, load: () => ({ one: 1, cpus: 14 }), live: true }), undefined);
    assert.equal(spawned, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
