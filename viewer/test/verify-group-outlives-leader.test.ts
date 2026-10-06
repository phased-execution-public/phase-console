/**
 * A §Verification line ends — even when its process group outlives its leader
 * (control-tower phase 106, #168).
 *
 * tamagui P4's command 5 was a sweep that started Metro as
 * `( cd … && nohup yarn start … & )`: the redirect covered `yarn` alone, so
 * the backgrounded subshell kept the command's stdout and stderr. The sweep
 * PASSED and its bash — the group leader — exited; `runOne` waited on `close`,
 * which needs the streams' EOF, and at the 30-minute timeout `killLadder`
 * asked whether the LEADER was alive, heard `gone`, and signalled nobody. The
 * phase sat in `verifying` for 50+ minutes holding its grant, and P5 queued
 * behind it with nothing on screen to say why.
 *
 * VE-4  a leader that exits while a group member holds its stdio settles with
 *       ITS exit code after a short grace, the stragglers stopped and named on
 *       the row; at the timeout the ladder reaches the GROUP whether or not its
 *       leader is still there; and a process that left the group still cannot
 *       hold a line past its clock plus the ladder.
 *
 * Real processes on purpose — the claim is about process groups and pipes,
 * and a stubbed signal function would assert the shape of the fix rather than
 * the fact it is supposed to produce.
 */

// Redirects XDG_STATE_HOME before anything resolves it.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { verifyPhase, LEADER_DRAIN_GRACE_MS } = await import('../server/runner/verify.ts');

const TRASH: string[] = [];
const STRAYS: number[] = [];
process.on('exit', () => {
  for (const pid of STRAYS) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const dir of TRASH) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pc-ve4-'));
  TRASH.push(dir);
  return dir;
}

/** `kill(pid, 0)` — is anything there? */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const settle = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function pidIn(dir: string, file: string): number {
  assert.ok(existsSync(join(dir, file)), `${file} was written`);
  const pid = Number(readFileSync(join(dir, file), 'utf8').trim());
  assert.ok(Number.isInteger(pid) && pid > 1, `a real pid, got ${pid}`);
  STRAYS.push(pid);
  return pid;
}

/** The sweep's shape: work that passes, and a background helper left holding stdout. */
function sweep(dir: string, opts: { exit?: number } = {}): string {
  writeFileSync(join(dir, 'sweep.sh'), [
    '#!/usr/bin/env bash',
    // Backgrounded with the command's own stdout and stderr — the Metro line.
    'sleep 25 &',
    'echo $! > straggler.pid',
    'echo "PASS — no red box"',
    `exit ${opts.exit ?? 0}`,
    '',
  ].join('\n'));
  return 'bash ./sweep.sh';
}

test('VE-4: a leader that exits while its group holds stdout settles with ITS exit code after a short grace — the straggler stopped and named', async () => {
  const dir = scratch();
  const started = Date.now();
  const summary = await verifyPhase(`\`${sweep(dir)}\``, { cwd: dir, timeoutMs: 20_000 });
  const took = Date.now() - started;
  const row = summary.ran[0]!;
  const pid = pidIn(dir, 'straggler.pid');

  assert.equal(row.code, 0, 'the leader\'s exit code — not 124');
  assert.equal(row.ok, true, 'the sweep passed, and a straggler does not make it red');
  assert.equal(row.timedOut, undefined, 'its clock never cut it');
  assert.ok(took < 10_000, `settled at the leader's exit plus a grace, not at the 20 s clock (took ${took} ms)`);
  assert.ok(took >= LEADER_DRAIN_GRACE_MS - 250, `the grace was given (took ${took} ms)`);
  assert.deepEqual(row.stragglers?.map((entry) => entry.pid), [pid], 'the straggler is named on the row');
  assert.match(row.output, /PASS — no red box/, 'what it printed before is kept');
  assert.match(row.output, /left 1 process in its group/);
  await settle(300);
  assert.equal(alive(pid), false, `the straggler (pid ${pid}) was stopped`);
});

test('VE-4: a red leader with a straggler is still red — with the leader\'s own code', async () => {
  const dir = scratch();
  const summary = await verifyPhase(`\`${sweep(dir, { exit: 3 })}\``, { cwd: dir, timeoutMs: 20_000, purpose: 'baseline' });
  const row = summary.ran[0]!;
  pidIn(dir, 'straggler.pid');
  assert.equal(row.ok, false);
  assert.equal(row.code, 3);
  assert.equal(row.stragglers?.length, 1);
});

test('VE-4: at its timeout the ladder reaches the GROUP even when the leader has already gone', async () => {
  const dir = scratch();
  const started = Date.now();
  // The clock runs out inside the drain grace: the leader is gone, the group is not.
  const summary = await verifyPhase(`\`${sweep(dir)}\``, { cwd: dir, timeoutMs: 600 });
  const took = Date.now() - started;
  const row = summary.ran[0]!;
  const pid = pidIn(dir, 'straggler.pid');
  assert.ok(took < 12_000, `no line outlives its clock plus the ladder (took ${took} ms)`);
  assert.equal(row.code, 0, 'the leader exited before the cap: its code, not 124');
  assert.equal(row.stragglers?.length, 1);
  await settle(300);
  assert.equal(alive(pid), false, `the straggler (pid ${pid}) was reached through the group`);
});

test('VE-4: a process that LEFT the group cannot hold the line past its clock plus the ladder — the streams are let go', async () => {
  const dir = scratch();
  // A detached child is a group of its own: no group signal reaches it, and it
  // inherits — and holds — the command's stdout.
  writeFileSync(join(dir, 'escape.js'), [
    "const { spawn } = require('node:child_process');",
    "const child = spawn('sleep', ['25'], { detached: true, stdio: 'inherit' });",
    "require('node:fs').writeFileSync('escaped.pid', String(child.pid));",
    'child.unref();',
    "console.log('started a server that outlives me');",
    '',
  ].join('\n'));
  const started = Date.now();
  const summary = await verifyPhase('`node escape.js`', { cwd: dir, timeoutMs: 2_000 });
  const took = Date.now() - started;
  const row = summary.ran[0]!;
  pidIn(dir, 'escaped.pid');
  assert.ok(took < 15_000, `ended at its clock plus the ladder, not at the stray's 25 s (took ${took} ms)`);
  assert.equal(row.code, 0, 'the leader\'s code');
  assert.match(row.output, /outside its group/, 'the record says a process outside the group still held its output');
});
