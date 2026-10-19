/**
 * A run's mirror grows when its plan names a new repository (one-pool phase
 * 20, #356).
 *
 * Measured: robot-platform-tags run `c67783c2b173`. `run.isolation` mounted
 * two repositories at the drive's start; phase 3 was added to the plan ~5 h
 * later with a third in its Repos cell, admitted into the same mirror, and
 * its baseline read every line red from its own `cd <repo>`. At a
 * boundary `checkoutBeforeBoarding` returned early on a mirror that stood, so
 * the scope-grew build ran only when a drive started; the session, told the
 * repository was read-only, could only park.
 *
 *  - MG-1 a plan that gains a phase on a new repository mid-drive gets that
 *    mount before the phase boards, journalled `run.mirror-grown`;
 *  - MG-2 the source holds the boundary's growth and its refusal.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drive, git, harness, journal, superRoot } from './lane-harness.ts';

for (const key of ['PE_WORKTREE', 'PE_BRANCH', 'PE_SCOPE', 'PE_OWNER', 'PE_LOCK_MIRROR']) delete process.env[key];

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server');

test('MG-1 (#356): a phase added mid-drive on a new repository boards into a mirror that mounts it', async () => {
  const { root } = superRoot();
  // The plan as phase 1 boarded: one repository. Phase 2's cell names the
  // second — the plan gained it while phase 1 worked.
  let scope = ['web'];
  const h = harness(root, { 1: 'web', 2: 'api' }, { planScope: () => scope }, (request) => {
    if (/BOOT phase 1\b/.test(request.prompt)) scope = ['web', 'api'];
  });
  const state = await drive(h, { onlyPhases: [1, 2] });
  const workRoot = String(state.workRoot ?? '');
  assert.ok(workRoot && workRoot !== root, `the run took its mirror; requests went to ${h.requests.map((q) => q.cwd).join(', ')}`);
  const first = journal(root, 'run.isolation')[0]!.data as { mounts: string[] };
  assert.deepEqual(first.mounts, ['web'], 'the drive started with the one repository its plan named');
  const phase2 = h.requests.find((q) => /BOOT phase 2\b/.test(q.prompt));
  assert.ok(phase2, 'phase 2 boarded');
  assert.equal(phase2!.cwd, workRoot, 'into the same mirror');
  assert.equal(existsSync(join(workRoot, 'api')), true, 'which now mounts its repository');
  assert.equal(git(join(workRoot, 'api'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo', 'on the run branch');
  const grown = journal(root, 'run.mirror-grown');
  assert.equal(grown.length, 1, 'journalled once');
  assert.deepEqual((grown[0]!.data as { added: string[] }).added, ['api']);
  assert.deepEqual((state.mountedRepos as string[]).slice().sort(), ['api', 'web']);
});

test('MG-2 (#356): the boundary asks what the mirror lacks before it trusts a mirror that stands, and never boards past a refusal', () => {
  const text = readFileSync(join(SERVER, 'runner', 'runner-loop.ts'), 'utf8');
  const at = text.indexOf('protected override async checkoutBeforeBoarding(');
  const body = text.slice(at, text.indexOf('\n  }\n', at));
  const stands = body.indexOf('await this.runTreeStands(state)');
  assert.ok(stands > 0);
  assert.ok(body.indexOf('this.mirrorLacks(state)', stands) > stands, 'a standing mirror is asked what it lacks');
  assert.ok(body.indexOf('this.growMirror(state, lacking)', stands) > stands);
  const grow = text.slice(text.indexOf('private async growMirror('), text.indexOf('private async runTreeStands('));
  assert.match(grow, /'run\.mirror-grown'/);
  assert.match(grow, /'run\.mirror-grow-refused'/);
  assert.match(grow, /'isolation-refused'/, 'a mirror that could not grow parks by name');
});
