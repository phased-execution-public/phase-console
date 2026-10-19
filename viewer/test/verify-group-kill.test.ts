/**
 * autopilot-6 — a timed-out §Verification takes its children with it.
 *
 * `runOne` used to be an `execFile` with node's own `timeout`, which sends
 * SIGTERM to the `bash` it spawned and to nothing else. Every command this
 * codebase actually expects in a §Verification does its work in CHILDREN of
 * that bash — `npm test`, `docker compose run … pytest`, a `task` target — so
 * a timeout killed the shell and left the real work running: the run recorded
 * a clean 124 and the machine kept a test runner, or a container, or both.
 *
 * A real process test on purpose. The claim is about process groups, and a
 * stubbed signal function would assert the shape of the fix rather than the
 * fact it is supposed to produce.
 */

// Redirects XDG_STATE_HOME before anything resolves it.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { verifyPhase } = await import('../server/runner/verify.ts');

/** `kill(pid, 0)` — is anything there? */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function settle(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

test('a timed-out verification kills the whole group, not just the bash (autopilot-6)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-verify-group-'));
  const pidFile = join(dir, 'grandchild.pid');
  try {
    // A grandchild that would outlive its bash by a long way, recording its own
    // pid so the test can ask about it directly. It lives in a SCRIPT because
    // the command extractor (rightly) refuses an inline `>` redirect as
    // something that mutates state — `bash ./spawner.sh` is the shape a real
    // §Verification uses anyway.
    writeFileSync(join(dir, 'spawner.sh'), [
      '#!/usr/bin/env bash',
      'sleep 120 &',
      'echo $! > grandchild.pid',
      'wait',
      '',
    ].join('\n'));
    const summary = await verifyPhase(
      '- `bash ./spawner.sh`',
      { cwd: dir, timeoutMs: 1_500 },
    );

    assert.equal(summary.ok, false, 'a command we killed proves nothing');
    const run = summary.ran[0]!;
    assert.equal(run.code, 124, 'reported as a timeout');
    assert.match(run.output, /timed out or cancelled/);
    // The new field: a 124 that does not say whether the children were reaped
    // is a 124 nobody can act on.
    assert.ok(run.how === 'exited' || run.how === 'killed' || run.how === 'gone',
      `the ladder recorded how it ended, got ${String(run.how)}`);

    assert.ok(existsSync(pidFile), 'the grandchild got far enough to record its pid');
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(Number.isInteger(pid) && pid > 0, `a real pid, got ${pid}`);

    // The assertion this file exists for. Before the fix this pid was still
    // alive here, holding whatever the command had started, for its full 120s.
    await settle(300);
    assert.equal(alive(pid), false,
      `the grandchild (pid ${pid}) outlived the verification that spawned it`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * one-pool phase 26 (#222) — a `node --test` a SESSION started does not
 * outlive it. Claude Code runs each Bash command in a process group of its own,
 * so the session's group cannot reach a background suite: the reaper records
 * the session's descendants while it lives and ends the orphaned test runners
 * when it ends — with their group — and whatever stayed in the session's own
 * group. Real processes, for the reason this file gives at its top.
 */
test('RG-1: a session\'s orphaned `node --test` and its own group are ended with it (#222)', async () => {
  const { SessionReaper } = await import('../server/runner/reap.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pc-reap-'));
  const runnerPid = join(dir, 'runner.pid');
  const memberPid = join(dir, 'member.pid');
  writeFileSync(join(dir, 'hang.test.mjs'), "import test from 'node:test';\ntest('hangs', () => new Promise(() => { setInterval(() => {}, 1000); }));\n");
  // The "session": a group leader whose one command starts a suite in a group
  // of its own (`set -m`, as Claude Code's Bash tool does) and leaves a
  // `sleep` in the leader's group.
  const { spawn } = await import('node:child_process');
  const leader = spawn('bash', ['-c', [
    `sleep 120 & echo $! > ${JSON.stringify(memberPid)}`,
    'set -m',
    `node --test ${JSON.stringify(join(dir, 'hang.test.mjs'))} >${JSON.stringify(join(dir, 'runner.out'))} 2>&1 & echo $! > ${JSON.stringify(runnerPid)}`,
    'sleep 120',
  ].join('\n')], { detached: true, stdio: 'ignore', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST'))) });
  const strays: number[] = [];
  try {
    const reaper = new SessionReaper();
    reaper.begin(leader.pid!, { sessionId: 'rg-1' });
    for (let i = 0; i < 100 && !(existsSync(runnerPid) && existsSync(memberPid)); i++) await settle(50);
    const runner = Number(readFileSync(runnerPid, 'utf8'));
    const member = Number(readFileSync(memberPid, 'utf8'));
    strays.push(runner, member);
    await settle(400);
    await reaper.observe();
    assert.ok(reaper.tracked(leader.pid!)?.has(runner), 'the suite was recorded while the session lived');

    // The session ends — its leader alone; the suite is orphaned to launchd.
    const exited = new Promise((done) => leader.once('exit', done));
    process.kill(leader.pid!, 'SIGKILL');
    await exited;
    await settle(200);
    assert.equal(alive(runner), true, `before the reap the suite outlives its session — the bug (${existsSync(join(dir, 'runner.out')) ? readFileSync(join(dir, 'runner.out'), 'utf8').slice(0, 400) : 'no output'})`);

    const reaped = await reaper.ended(leader.pid!);
    await settle(300);
    assert.equal(alive(runner), false, `the orphaned suite (pid ${runner}) was ended with its session`);
    assert.equal(alive(member), false, `what stayed in the session's own group (pid ${member}) too`);
    assert.ok(reaped.some((row) => row.pid === runner && /node --test/.test(row.command)), `named: ${JSON.stringify(reaped)}`);
  } finally {
    for (const pid of strays) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    try { process.kill(-leader.pid!, 'SIGKILL'); } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
