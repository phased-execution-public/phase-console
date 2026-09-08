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
