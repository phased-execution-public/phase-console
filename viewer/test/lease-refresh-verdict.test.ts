/**
 * A lease refresh that merely ran slow never kills the session it protects
 * (control-tower phase 56, #77).
 *
 * On 2026-09-22 the runner's periodic `phase-lock.sh claim` for a live phase
 * ran 310 s against a 45 s ceiling on a starved console. Its own output said
 * `lock refreshed for autopilot/24fcba33`; the engine mapped the killed run's
 * `null` code to 1; and `refreshLease` read any non-zero code as a foreign
 * takeover and stopped the session holding that very lock.
 *
 *   LR-1  Only an explicit refusal naming ANOTHER owner stands the lane down,
 *         and the stand-down carries the exit code and `timedOut` it acted on.
 *   LR-2  A refresh that timed out is retried — or kept, when the script had
 *         already said the lease moved. Never a stand-down.
 *   LR-3  A crash, a usage error or silence is no verdict, and is retried.
 *   LR-4  Refreshes run outside the 8-slot engine pool that page reads fill.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { engineQueue, run as engineRun, runOutsidePool } from '../server/engine.ts';
import { leaseAction, type LeaseRefreshRun } from '../server/runner/lease.ts';

const OWNER = 'autopilot/24fcba33';
const ran = (over: Partial<LeaseRefreshRun>): LeaseRefreshRun =>
  ({ code: 0, stdout: '', stderr: '', timedOut: false, crashed: false, signal: null, ...over });

test('LR-1: an explicit refusal naming another owner stands the lane down, with the code and timedOut it read', () => {
  const held = leaseAction(ran({
    code: 1,
    stderr: 'phase 52 is being worked by alice@laptop (lease until 2026-09-22T14:00:00Z).\n'
      + '  → stop that session, re-run with --force to take over, or start another ready phase.',
  }), OWNER);
  assert.equal(held.act, 'stand-down');
  assert.ok(held.act === 'stand-down');
  assert.equal(held.holder, 'alice@laptop');
  assert.equal(held.code, 1);
  assert.equal(held.timedOut, false);
  assert.match(held.detail, /being worked by alice@laptop/);

  const raced = leaseAction(ran({ code: 1, stderr: 'phase 52: refresh lost to bob/s1 — that session holds the lock now.' }), OWNER);
  assert.equal(raced.act, 'stand-down');
  assert.ok(raced.act === 'stand-down' && raced.holder === 'bob/s1');

  const upstream = leaseAction(ran({
    code: 1, stderr: 'phase 52: the refresh could not be published and the upstream lock is held by carol/x — NOT claimed.',
  }), OWNER);
  assert.ok(upstream.act === 'stand-down' && upstream.holder === 'carol/x');

  // A "refusal" that names US is no takeover: nobody else holds anything.
  const ourselves = leaseAction(ran({ code: 1, stderr: `phase 52 is being worked by ${OWNER} (lease until later).` }), OWNER);
  assert.equal(ourselves.act, 'retry');
});

test('LR-2: a refresh that timed out is retried, or kept when the script had already said so — never a stand-down', () => {
  // #77 exactly: killed at the ceiling after the script printed its success.
  const theIncident = leaseAction(ran({
    code: 1, timedOut: true, signal: 'SIGKILL',
    stdout: `phase 52: lock refreshed for ${OWNER} (lease 5400s)`,
  }), OWNER);
  assert.equal(theIncident.act, 'keep', 'the lease moved; the process being killed afterwards changes nothing');

  const silent = leaseAction(ran({ code: 1, timedOut: true, signal: 'SIGKILL' }), OWNER);
  assert.equal(silent.act, 'retry');
  assert.ok(silent.act === 'retry');
  assert.equal(silent.why, 'timed-out');
  assert.equal(silent.timedOut, true);

  // Even a timed-out run whose text reads like a refusal proves nothing: the
  // run did not end by itself, so it is retried and the next answer decides.
  const muddled = leaseAction(ran({ code: 1, timedOut: true, stderr: 'phase 52 is being worked by alice@laptop' }), OWNER);
  assert.equal(muddled.act, 'retry');
});

test('LR-3: a crash, a usage error or silence is no verdict, and is retried', () => {
  const crashed = leaseAction(ran({ code: 137, crashed: true, signal: 'SIGKILL' }), OWNER);
  assert.ok(crashed.act === 'retry' && crashed.why === 'crashed');
  const usage = leaseAction(ran({ code: 2, stderr: '--lease must be a positive number of seconds, got: x' }), OWNER);
  assert.ok(usage.act === 'retry' && usage.why === 'no-verdict');
  const mute = leaseAction(ran({ code: 1 }), OWNER);
  assert.ok(mute.act === 'retry' && mute.why === 'no-verdict', 'code 1 with no holder named is not a refusal');
  const missing = leaseAction(ran({ code: 127, stderr: 'bash: phase-lock.sh: No such file or directory' }), OWNER);
  assert.equal(missing.act, 'retry');

  // …and the plain successes still read as successes.
  assert.equal(leaseAction(ran({ code: 0, stdout: `phase 52: lock refreshed for ${OWNER} (lease 5400s)` }), OWNER).act, 'keep');
  assert.equal(leaseAction(ran({ code: 0, stdout: 'phase 52: takeover — previous lease (held by alice) had expired' }), OWNER).act, 'keep');
});

test('LR-1/2/3: the runner acts on the verdict — stand down only on a refusal, journal what it read, retry on the next tick', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../server/runner/runner.ts'), 'utf8');
  const start = source.indexOf('private async refreshLease(');
  assert.ok(start > 0, 'refreshLease is where the verdict is acted on');
  const body = source.slice(start, source.indexOf('\n  }\n', start));
  assert.match(body, /leaseAction\(result, owner\)/, 'the verdict comes from leaseAction, not from the exit code');
  assert.doesNotMatch(body, /result\.code\s*[!=]==/, 'nothing in the refresh reads the raw exit code any more');
  const retry = body.slice(body.indexOf("action.act === 'retry'"), body.indexOf('} else {', body.indexOf("action.act === 'retry'")));
  assert.match(retry, /'phase\.lock-refresh-unanswered'/, 'an unanswered refresh is on the record');
  assert.doesNotMatch(retry, /stopPhase|clearLeaseTimer/, 'no verdict neither stops the session nor ends the keepalive');
  const lost = body.slice(body.indexOf("'phase.lock-lost'"));
  assert.match(lost, /code: action\.code, timedOut: action\.timedOut/, 'the stand-down journals the code and timedOut it acted on');
});

test('LR-4: a refresh runs outside the engine pool that page reads fill', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pe-lr-'));
  try {
    const slow = join(dir, 'slow.sh');
    writeFileSync(slow, '#!/bin/bash\nsleep 2\n');
    chmodSync(slow, 0o755);
    const lock = join(dir, 'phase-lock.sh');
    writeFileSync(lock, `#!/bin/bash\necho "phase 52: lock refreshed for ${OWNER} (lease 5400s)"\n`);
    chmodSync(lock, 0o755);
    const opts = { scriptsDir: dir, root: dir };

    // Nine page reads: eight hold every slot, one queues behind them.
    const reads = Array.from({ length: 9 }, () => engineRun(opts, 'slow.sh', []));
    assert.equal(engineQueue().active, 8, 'the pool is full');
    assert.equal(engineQueue().queued, 1);

    const started = Date.now();
    const refresh = await runOutsidePool(opts, 'phase-lock.sh', ['demo', 'claim', '52']);
    const took = Date.now() - started;
    assert.equal(refresh.code, 0);
    assert.ok(took < 1_500, `the refresh waited ${took} ms behind the pool`);
    assert.equal(engineQueue().active, 8, 'it took no slot and freed none');
    assert.equal(leaseAction(refresh, OWNER).act, 'keep');
    await Promise.all(reads);

    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../server/runner/runner.ts'), 'utf8');
    const refreshBody = source.slice(source.indexOf('private async refreshLease('));
    assert.match(refreshBody.slice(0, refreshBody.indexOf('\n  }\n')), /this\.lockScript\('phase-lock\.sh'/,
      'the keepalive claims through the unpooled door');
    const door = source.slice(source.indexOf('protected lockScript('));
    assert.match(door.slice(0, door.indexOf('\n  }\n')), /runOutsidePool\(/);
    await assert.rejects(runOutsidePool(opts, 'phase-lock.sh', ['demo', 'claim', '52', '--git']), /--git/,
      'the unpooled door refuses --git exactly as the pooled one does');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
