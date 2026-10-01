/**
 * A timeout ends the whole job it timed out, and nothing it had already said
 * (control-tower phase 56, #75 CON-7 / #77).
 *
 * `shell()` used to SIGKILL the direct child alone and resolve only on
 * `close` — so a grandchild holding the pipe kept the call (and the engine slot
 * under it) open for as long as it liked: 141 engine commands in a week ran up
 * to 6.89x their 45 s ceiling, one phase-lock claim for 310 s. And a timer that
 * fired late set `timedOut` over an answer that had already arrived, which is
 * how a refresh that printed "lock refreshed" read as a lost lock.
 *
 *   SG-1  At the ceiling the whole process GROUP is killed — a grandchild the
 *         command started is gone too — and the call answers at the ceiling.
 *   SG-2  A command that answered before its ceiling keeps its answer: a
 *         grandchild still holding the pipe is ended at the ceiling, and the
 *         result is the command's own exit, not a timeout.
 *   SG-3  A real timeout keeps the output completed before the timer; and a
 *         timer that fires in the same loop pass as an exit that had already
 *         happened (a starved loop) does not call that exit a timeout.
 *   SG-4  The engine slot comes back at the ceiling, not when a grandchild
 *         finally lets go.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { engineQueue, run as engineRun, setEngineTimeouts } from '../server/engine.ts';
import { shell } from '../server/shell.ts';

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** A killed grandchild is reaped by init a moment later; poll rather than race it. */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !alive(pid);
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'pe-sg-'));
}

test('SG-1: at the ceiling the whole group goes, and the call answers at the ceiling', async () => {
  const dir = scratch();
  const pidFile = join(dir, 'grandchild.pid');
  try {
    const started = Date.now();
    const out = await shell('bash', ['-c', 'sleep 30 & echo $! > "$0"; wait', pidFile], {
      channel: 'shell', intent: 'sg-1', timeout: 400,
    });
    const took = Date.now() - started;
    assert.equal(out.timedOut, true);
    assert.equal(out.ok, false);
    assert.ok(took < 3_000, `answered ${took} ms after a 400 ms ceiling — the call waited on the grandchild`);
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(grandchild > 1);
    assert.ok(await goneWithin(grandchild, 2_000), 'the grandchild outlived the timeout: only the direct child was killed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SG-2: an answer given before the ceiling is kept, and the grandchild holding the pipe is ended', async () => {
  const dir = scratch();
  const pidFile = join(dir, 'grandchild.pid');
  try {
    const started = Date.now();
    // bash prints its answer and exits 0 at once; the backgrounded sleep
    // inherits stdout and holds the pipe, so `close` cannot come by itself.
    const out = await shell('bash', ['-c', 'echo answer; sleep 30 & echo $! > "$0"', pidFile], {
      channel: 'shell', intent: 'sg-2', timeout: 400,
    });
    const took = Date.now() - started;
    assert.ok(took < 3_000, `answered ${took} ms after a 400 ms ceiling`);
    assert.equal(out.timedOut, false, 'the command answered before its ceiling — that is not a timeout');
    assert.equal(out.ok, true);
    assert.equal(out.code, 0);
    assert.equal(out.stdout.trim(), 'answer');
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(await goneWithin(grandchild, 2_000), 'the grandchild holding the pipe was left running');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SG-3: a real timeout keeps what was said before the timer', async () => {
  const out = await shell('bash', ['-c', 'echo partial; exec sleep 30'], {
    channel: 'shell', intent: 'sg-3', timeout: 400,
  });
  assert.equal(out.timedOut, true);
  assert.equal(out.code, null);
  assert.match(out.stdout, /partial/, 'the output completed before the timer was thrown away');
});

test('SG-3: a timer that fires in the same pass as an exit that already happened is not a timeout', async () => {
  const pending = shell('bash', ['-c', 'echo fast'], { channel: 'shell', intent: 'sg-3-starved', timeout: 150 });
  // Starve the loop well past the ceiling: the child exits meanwhile, and the
  // timer and the exit are delivered in one pass — timers first.
  const until = Date.now() + 700;
  while (Date.now() < until) { /* a loop that cannot answer */ }
  const out = await pending;
  assert.equal(out.timedOut, false, 'the late timer overruled an exit that had already arrived');
  assert.equal(out.ok, true);
  assert.equal(out.stdout.trim(), 'fast');
});

test('SG-4: the engine slot comes back at the ceiling', async () => {
  const dir = scratch();
  setEngineTimeouts({ board: 400 });
  try {
    const script = join(dir, 'phase-graph.sh');
    writeFileSync(script, '#!/bin/bash\nsleep 30 &\nwait\n');
    chmodSync(script, 0o755);
    const started = Date.now();
    const result = await engineRun({ scriptsDir: dir, root: dir }, 'phase-graph.sh', ['slug', '--memory-block']);
    const took = Date.now() - started;
    assert.equal(result.timedOut, true);
    assert.ok(took < 3_000, `the slot was held ${took} ms against a 400 ms ceiling`);
    assert.equal(engineQueue().active, 0, 'the slot was not released');
  } finally {
    setEngineTimeouts(null);
    rmSync(dir, { recursive: true, force: true });
  }
});
