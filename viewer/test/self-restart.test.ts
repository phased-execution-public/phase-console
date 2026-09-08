/**
 * Restart where nothing supervises the console.
 *
 * Under launchd or systemd a clean exit IS the restart. Started from a terminal
 * or the desktop launcher, the console used to refuse the button — exiting would
 * have ended it. It now starts its own successor with its own argv, so the
 * restarted console carries every flag the original was started with. These
 * pin the three pieces: the plan (pure), the verdict (pure) and the spawn.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectSupervisor, reexec, restartVerdict, selfRestartPlan, type SelfRestartPlan, type Supervisor,
} from '../server/lifecycle.ts';

test('selfRestartPlan: the process\'s own executable, its own argv minus the executable, its own cwd', () => {
  const plan = selfRestartPlan(
    ['/opt/node/bin/node', '/srv/console/viewer/server/index.ts', '--allow-run', '--allow-writes', '--port', '4130', '--remote', 'box.ts.net'],
    '/opt/node/bin/node',
    '/srv/console',
  );
  assert.equal(plan.file, '/opt/node/bin/node');
  assert.deepEqual(plan.args, ['/srv/console/viewer/server/index.ts', '--allow-run', '--allow-writes', '--port', '4130', '--remote', 'box.ts.net']);
  assert.equal(plan.cwd, '/srv/console');
  // The command line names the executable by its basename — it is shown to people, and a node path is noise.
  assert.equal(plan.command, 'node /srv/console/viewer/server/index.ts --allow-run --allow-writes --port 4130 --remote box.ts.net');
});

test('selfRestartPlan defaults to this very process', () => {
  const plan = selfRestartPlan();
  assert.equal(plan.file, process.execPath);
  assert.deepEqual(plan.args, process.argv.slice(1));
  assert.equal(plan.cwd, process.cwd());
});

test('restartVerdict: supervised → ok without a self-restart; unsupervised → ok BY self-restart', () => {
  const launchd: Supervisor = detectSupervisor({ XPC_SERVICE_NAME: 'com.phase-console' }, 'darwin');
  assert.equal(launchd.supervised, true);
  assert.deepEqual(restartVerdict(launchd), { ok: true, selfRestart: false });

  const nothing: Supervisor = detectSupervisor({}, 'darwin');
  assert.equal(nothing.supervised, false);
  assert.equal(nothing.kind, 'none');
  assert.deepEqual(restartVerdict(nothing), { ok: true, selfRestart: true });
});

test('restartVerdict: a supervisor declared NOT to restart is the one refusal left', () => {
  const declared: Supervisor = detectSupervisor({ PHASE_CONSOLE_SUPERVISED: '0' }, 'darwin');
  assert.equal(declared.supervised, false);
  assert.notEqual(declared.kind, 'none');
  const verdict = restartVerdict(declared);
  assert.equal(verdict.ok, false);
  assert.match((verdict as { reason: string }).reason, /leave nothing serving this page/);
});

test('reexec: spawns the plan detached with stdio ignored, unrefs the handle, reports success', () => {
  const plan: SelfRestartPlan = { file: '/opt/node/bin/node', args: ['index.ts', '--allow-run'], cwd: '/srv', command: 'node index.ts --allow-run' };
  const calls: unknown[] = [];
  let unrefed = false;
  const spawn = ((file: string, args: readonly string[], opts: unknown) => {
    calls.push([file, args, opts]);
    return { pid: 4242, unref: () => { unrefed = true; } };
  }) as unknown as Parameters<typeof reexec>[1];
  assert.equal(reexec(plan, spawn), true);
  assert.deepEqual(calls, [['/opt/node/bin/node', ['index.ts', '--allow-run'], { cwd: '/srv', detached: true, stdio: 'ignore' }]]);
  assert.equal(unrefed, true, 'the handle must not keep the exiting process alive');
});

test('reexec: a spawn that throws is reported false, never thrown — the exit still proceeds', () => {
  const plan = selfRestartPlan(['node', 'x'], 'node', '/');
  const spawn = (() => { throw new Error('ENOENT'); }) as unknown as Parameters<typeof reexec>[1];
  assert.equal(reexec(plan, spawn), false);
});
