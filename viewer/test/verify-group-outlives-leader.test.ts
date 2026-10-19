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

/* ------------------------------------------------------------------ *
 * one-pool phase 26 (#222) — the orphan sweep's rule, on a process table
 * ------------------------------------------------------------------ */

test('RG-2: an orphan is a recorded descendant, alive with the same start, parented by pid 1, a test runner, started before its session ended', async () => {
  const { orphansOf, testRunnerCommand, descendantsOf } = await import('../server/runner/reap.ts');
  const t0 = Date.parse('2026-10-04T07:38:00Z');
  const end = t0 + 60 * 60_000;
  const seen = new Map([
    [41831, { startedMs: t0, command: 'node --test --test-force-exit --test-concurrency=1 --test-reporter=tap test/assert-no-pro.test.ts' }],
    [15710, { startedMs: t0 + 5_000, command: 'node --test --test-force-exit viewer/test/allow-issues-flag.test.ts' }],
    [500, { startedMs: t0, command: 'sleep 999' }],
    [600, { startedMs: t0, command: 'npx vitest run' }],
  ]);
  const rows = [
    { pid: 41831, ppid: 1, pgid: 41831, startedMs: t0, command: 'node --test --test-force-exit --test-concurrency=1 --test-reporter=tap test/assert-no-pro.test.ts' },
    { pid: 15710, ppid: 1, pgid: 15710, startedMs: t0 + 9 * 60 * 60_000, command: 'node --test x.test.ts' }, // a recycled pid
    { pid: 500, ppid: 1, pgid: 500, startedMs: t0, command: 'sleep 999' },                                 // not a test runner
    { pid: 600, ppid: 4242, pgid: 600, startedMs: t0, command: 'npx vitest run' },                         // still parented
    { pid: 700, ppid: 1, pgid: 700, startedMs: end + 1_000, command: 'node --test y.test.ts' },            // never recorded
  ];
  assert.deepEqual(orphansOf(rows, seen, end).map((row) => row.pid), [41831], 'the 8 h 23 min spinner of #222, and nothing else');
  assert.deepEqual(descendantsOf([
    { pid: 2, ppid: 1, pgid: 2, startedMs: null, command: 'claude' }, { pid: 3, ppid: 2, pgid: 3, startedMs: null, command: 'zsh' },
    { pid: 4, ppid: 3, pgid: 3, startedMs: null, command: 'node --test' }, { pid: 5, ppid: 1, pgid: 5, startedMs: null, command: 'other' },
  ], 2).map((row) => row.pid), [3, 4]);
  for (const runner of ['node --test a.ts', 'npx vitest run', 'node /x/node_modules/vitest/vitest.mjs', '/bin/bash /opt/homebrew/bin/bats tests', 'python3 -m pytest']) {
    assert.equal(testRunnerCommand(runner), true, runner);
  }
  for (const other of ['node server/index.ts', 'claude -p', 'bash /tmp/p13op/run.sh', 'sleep 30', 'grep vitest file']) {
    assert.equal(testRunnerCommand(other), false, other);
  }
});

test('RG-3: a session that PARKED keeps its detached suite for the spare window; the sweep ends it after — and ends at once the orphans of one that did not', async () => {
  const { SessionReaper, REAP_SPARE_MS, parkedOutcome } = await import('../server/runner/reap.ts');
  let clock = Date.parse('2026-10-18T12:00:00Z');
  let table: { pid: number; ppid: number; pgid: number; startedMs: number | null; command: string }[] = [];
  const ended: number[] = [];
  const reaper = new SessionReaper({
    table: async () => table, now: () => clock,
    end: async (pid) => { ended.push(pid); table = table.filter((row) => row.pid !== pid); return 'exited'; },
  });
  const suite = { pid: 301, ppid: 300, pgid: 301, startedMs: clock, command: 'bash -c node --test --test-concurrency=1 viewer/test/a.test.ts' };
  const runner = { pid: 302, ppid: 301, pgid: 301, startedMs: clock, command: 'node --test --test-concurrency=1 viewer/test/a.test.ts' };
  try {
    // Parked: the suite it detached is its own job, waited on.
    reaper.begin(100);
    table = [{ pid: 100, ppid: 1, pgid: 100, startedMs: clock, command: 'claude -p' }, { pid: 300, ppid: 100, pgid: 300, startedMs: clock, command: 'zsh' }, suite, runner];
    await reaper.observe();
    table = [{ ...suite, ppid: 1 }, { ...runner }];
    clock += 60_000;
    assert.deepEqual(await reaper.ended(100, { spare: true }), [], 'a parked session keeps its job');
    clock += 60 * 60_000;
    assert.deepEqual(await reaper.sweep(), [], 'and keeps it while its wait may still run');
    clock += REAP_SPARE_MS;
    const swept = await reaper.sweep();
    assert.deepEqual(swept.map((row) => row.pid), [301], 'past the spare it is an orphan older than its session');
    assert.deepEqual(ended, [301]);

    // Not parked: ended with the session.
    ended.length = 0;
    reaper.begin(200);
    const vitest = { pid: 401, ppid: 400, pgid: 401, startedMs: clock, command: 'npx vitest run' };
    table = [{ pid: 200, ppid: 1, pgid: 200, startedMs: clock, command: 'claude -p' }, { pid: 400, ppid: 200, pgid: 400, startedMs: clock, command: 'zsh' }, vitest,
      { pid: 210, ppid: 200, pgid: 200, startedMs: clock, command: 'npx some-mcp-server' }];
    await reaper.observe();
    table = [{ ...vitest, ppid: 1 }, { pid: 210, ppid: 1, pgid: 200, startedMs: clock, command: 'npx some-mcp-server' }];
    const reaped = await reaper.ended(200);
    assert.deepEqual(reaped.map((row) => row.pid).sort(), [210, 401], 'its group (an MCP server left in it) and its orphaned suite');
    assert.deepEqual(ended.sort(), [200, 401], 'the group through its leader\'s id, the suite through its own');
  } finally {
    reaper.stop();
  }

  const dir = scratch();
  writeFileSync(join(dir, 'parked.json'), JSON.stringify({ status: 'waiting-external', watch: ['cmd:"test -f /tmp/x"'] }));
  writeFileSync(join(dir, 'done.json'), JSON.stringify({ status: 'complete' }));
  assert.equal(parkedOutcome(join(dir, 'parked.json')), true);
  assert.equal(parkedOutcome(join(dir, 'done.json')), false);
  assert.equal(parkedOutcome(join(dir, 'missing.json')), false, 'unreadable is no: the default is the reap');
  assert.equal(parkedOutcome(undefined), false);
});
