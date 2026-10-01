/**
 * Foreign content at a mount is quarantined, never deleted (control-tower
 * phase 90, #123 #139).
 *
 * Measured on hub 4123 (observability-plane run 86103bfe79aa, P28): a session
 * cloned seven repositories into the EMPTY mount paths of its run's mirror to
 * read their workflows. At the next re-board `ensureMirror` met
 * `aws: … already exists`, refused `worktree-failed`, and the run fell back to
 * the shared checkout for 10 h 51 min until a person moved the clones aside.
 * And the failure path it took ran `rm -rf` on the integration directory
 * whenever no mount had been adopted — a directory it had not created.
 *
 *  - QC-1 `ensureMirror`'s failure path never removes a directory it did not
 *    create: a pre-existing integration directory is ADOPTED, and an adopted
 *    directory is never removed wholesale;
 *  - QC-2 a clean, pushed clone at a mount is moved to
 *    `<run>/stale-mounts/<ts>/<mount>` by itself and the mount rebuilt;
 *  - QC-3 a dirty or unpushed one is never moved without a person's word — the
 *    refusal (`mount-occupied`) names each mount and its git state, and the
 *    confirmed repair moves it;
 *  - QC-4 the runner journals `run.mount-quarantined` and the mirror is rebuilt
 *    in the same heal pass; no prune or sweep deletes the quarantine.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  ensureMirror, laneNames, pruneMirror, repairMirror, resolveMounts, staleMountsDir, sweepStale, validateMirror,
} from '../server/runner/worktree.ts';
import type { MirrorMount } from '../server/runner/worktree.ts';
import { drive, git, harness, journal, superRoot, until } from './lane-harness.ts';

for (const key of ['PE_WORKTREE', 'PE_BRANCH', 'PE_SCOPE', 'PE_OWNER', 'PE_LOCK_MIRROR']) delete process.env[key];

async function mirrorOf(root: string, base: string, runId: string): Promise<{
  names: ReturnType<typeof laneNames>; mounts: MirrorMount[];
}> {
  const res = await resolveMounts(root, ['web', 'api']);
  assert.equal(res.ok, true);
  const mounts = (res as { mounts: MirrorMount[] }).mounts;
  const names = laneNames({ stateDir: join(base, 'state'), runId, slug: 'demo', phase: 0 });
  return { names, mounts };
}

/** Replace a standing mount with a standalone clone of its repository — what the session did. */
function cloneOver(root: string, base: string, integration: string, rel: 'web' | 'api'): string {
  const dir = join(integration, rel);
  git(join(root, rel), 'worktree', 'remove', '--force', dir);
  git(base, 'clone', '-q', join(base, `${rel}-src`), dir);
  return dir;
}

/* ------------------------------------------------------------------ QC-1 */

test('QC-1 — a failed build never removes an integration directory it did not create', async () => {
  const { base, root } = superRoot();
  const { names, mounts } = await mirrorOf(root, base, 'r-qc1');
  // A directory this call did not make, holding something a person put there.
  mkdirSync(names.integration, { recursive: true });
  writeFileSync(join(names.integration, 'NOTES.md'), "a person's notes\n");
  // …and a build that must fail: `web`'s run branch is checked out in the
  // submodule itself, so `worktree add` refuses branch-in-use after `api` was
  // already created.
  git(join(root, 'web'), 'switch', '-q', '-c', 'pe/demo');

  const made = await ensureMirror({ names, runId: 'r-qc1', slug: 'demo', mounts });
  assert.equal(made.ok, false);
  assert.equal(made.refusal, 'branch-in-use');
  assert.equal(readFileSync(join(names.integration, 'NOTES.md'), 'utf8'), "a person's notes\n",
    'the failure path removed a directory it did not create');
  assert.equal(existsSync(join(names.integration, 'api')), false, 'what the call DID create is still discarded');
});

test('QC-1 — a directory the failed call created itself is still cleaned up', async () => {
  const { base, root } = superRoot();
  const { names, mounts } = await mirrorOf(root, base, 'r-qc1b');
  git(join(root, 'web'), 'switch', '-q', '-c', 'pe/demo');
  const made = await ensureMirror({ names, runId: 'r-qc1b', slug: 'demo', mounts });
  assert.equal(made.ok, false);
  assert.equal(existsSync(names.integration), false, 'a fresh directory is the call\'s own to remove');
});

/* ------------------------------------------------------------------ QC-2 */

test('QC-2 — a clean, pushed clone at a mount is quarantined by itself and the mount rebuilt', async () => {
  const { base, root } = superRoot();
  const { names, mounts } = await mirrorOf(root, base, 'r-qc2');
  assert.equal((await ensureMirror({ names, runId: 'r-qc2', slug: 'demo', mounts })).ok, true);
  const clone = cloneOver(root, base, names.integration, 'web');
  assert.equal(existsSync(join(clone, '.git')), true);

  const fixed = await repairMirror(names, { runId: 'r-qc2', slug: 'demo' });
  assert.equal(fixed.ok, true, `repair refused: ${fixed.detail}`);
  assert.equal(fixed.quarantined?.length, 1);
  const moved = fixed.quarantined![0]!;
  assert.equal(moved.rel, 'web');
  assert.equal(moved.kind, 'clone');
  assert.equal(moved.clean, true);
  assert.equal(moved.confirmed, false, 'clean and pushed content needs nobody\'s word');
  assert.ok(moved.to.startsWith(join(staleMountsDir(names.integration), '')), `moved to ${moved.to}`);
  assert.equal(dirname(dirname(moved.to)), staleMountsDir(names.integration), '<run>/stale-mounts/<ts>/<mount>');
  assert.equal(existsSync(join(moved.to, '.git')), true, 'the clone survives, git directory and all');
  assert.equal(readFileSync(join(moved.to, 'index.html'), 'utf8'), 'web\n');
  assert.equal(await validateMirror(names.integration, names.runBranch), true, 'the mirror stands again');
  assert.equal(git(join(names.integration, 'web'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo');
});

/* ------------------------------------------------------------------ QC-3 */

test('QC-3 — a dirty clone is never moved without a person\'s word; the confirmed repair moves it', async () => {
  const { base, root } = superRoot();
  const { names, mounts } = await mirrorOf(root, base, 'r-qc3');
  assert.equal((await ensureMirror({ names, runId: 'r-qc3', slug: 'demo', mounts })).ok, true);
  const clone = cloneOver(root, base, names.integration, 'web');
  writeFileSync(join(clone, 'wip.txt'), 'a session was in the middle of this\n');

  const asked = await repairMirror(names, { runId: 'r-qc3', slug: 'demo' });
  assert.equal(asked.ok, false);
  assert.equal(asked.refusal, 'mount-occupied');
  assert.equal(asked.occupied?.length, 1);
  assert.equal(asked.occupied![0]!.rel, 'web');
  assert.deepEqual(asked.occupied![0]!.dirty, ['wip.txt']);
  assert.match(String(asked.detail), /web/);
  assert.match(String(asked.detail), /wip\.txt/);
  assert.equal(readFileSync(join(clone, 'wip.txt'), 'utf8'), 'a session was in the middle of this\n', 'untouched');
  assert.equal(existsSync(staleMountsDir(names.integration)), false, 'nothing was moved');

  const confirmed = await repairMirror(names, { runId: 'r-qc3', slug: 'demo', quarantine: 'confirmed' });
  assert.equal(confirmed.ok, true, `confirmed repair refused: ${confirmed.detail}`);
  assert.equal(confirmed.quarantined?.[0]?.confirmed, true);
  assert.equal(readFileSync(join(confirmed.quarantined![0]!.to, 'wip.txt'), 'utf8'), 'a session was in the middle of this\n');
  assert.equal(await validateMirror(names.integration, names.runBranch), true);
});

test('QC-3 — an unpushed commit asks first, exactly as a dirty file does', async () => {
  const { base, root } = superRoot();
  const { names, mounts } = await mirrorOf(root, base, 'r-qc3b');
  assert.equal((await ensureMirror({ names, runId: 'r-qc3b', slug: 'demo', mounts })).ok, true);
  const clone = cloneOver(root, base, names.integration, 'api');
  writeFileSync(join(clone, 'api.txt'), 'changed\n');
  git(clone, '-c', 'user.name=p90', '-c', 'user.email=p90@example.invalid', 'commit', '-q', '-am', 'only here');

  const asked = await repairMirror(names, { runId: 'r-qc3b', slug: 'demo' });
  assert.equal(asked.refusal, 'mount-occupied');
  assert.equal(asked.occupied![0]!.unpushed, 1);
  assert.deepEqual(asked.occupied![0]!.dirty, []);
  assert.match(String(asked.detail), /1 unpushed commit/);
  assert.equal(git(clone, 'log', '-1', '--format=%s'), 'only here', 'the commit is where the session left it');
});

/* ------------------------------------------------------------------ QC-4 */

test('QC-4 — the runner journals run.mount-quarantined and rebuilds the mirror in the same pass', async () => {
  const { base, root } = superRoot();
  let cloned = '';
  const h = harness(root, { 1: 'web', 2: 'web' }, { planScope: () => ['web', 'api'] }, (request, runner) => {
    if (/BOOT phase 1\b/.test(request.prompt)) runner.pause();
  });
  const first = await drive(h, { onlyPhases: [1, 2] });
  assert.equal(first.status, 'paused');
  const workRoot = String(first.workRoot);
  await until(() => journal(root, 'run.worktrees-kept').length > 0, 'the loop end to keep the trees');

  // While the run is stopped a session reads another repository the only way
  // it knew how: a clone into the mount path.
  cloned = cloneOver(join(root), base, workRoot, 'web');
  assert.equal(existsSync(join(cloned, '.git')), true);

  const second = await drive(h, { resumeRunId: String(first.id), onlyPhases: [2] });
  assert.equal(second.checkout, 'worktree', `isolation was lost (refusal: ${String(second.isolationRefusal)})`);
  const phase2 = h.requests.find((q) => /BOOT phase 2\b/.test(q.prompt));
  assert.equal(phase2?.cwd, workRoot, 'phase 2 boarded in the rebuilt mirror');
  const lines = journal(root, 'run.mount-quarantined');
  assert.equal(lines.length, 1);
  const data = lines[0]!.data as Record<string, unknown>;
  assert.equal(data.mount, 'web');
  assert.equal(data.kind, 'clone');
  assert.equal(data.confirmed, false);
  assert.equal(existsSync(join(String(data.to), '.git')), true, 'the quarantined clone is on disk');
  assert.equal(git(join(workRoot, 'web'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo');
});

test('QC-4 — neither the mirror prune nor the stale sweep deletes quarantined or foreign content', async () => {
  const { base, root } = superRoot();
  const { names, mounts } = await mirrorOf(root, base, 'r-qc4');
  const stateDir = join(base, 'state');
  assert.equal((await ensureMirror({ names, runId: 'r-qc4', slug: 'demo', mounts })).ok, true);
  cloneOver(root, base, names.integration, 'web');
  const fixed = await repairMirror(names, { runId: 'r-qc4', slug: 'demo' });
  assert.equal(fixed.ok, true);
  const to = fixed.quarantined![0]!.to;

  // A second clone lands at the other mount after the repair — the prune must
  // not take it either, quarantined or not.
  const stray = cloneOver(root, base, names.integration, 'api');
  const pruned = await pruneMirror({ integration: names.integration, mounts });
  assert.ok(pruned.kept.some((path) => path === stray || stray.startsWith(`${path}/`)),
    `the prune kept the foreign clone: kept ${JSON.stringify(pruned.kept)}`);
  assert.equal(existsSync(join(stray, '.git')), true, 'the prune deleted a clone it did not make');

  const swept = await sweepStale(root, { stateDir, slug: 'demo', liveRunIds: [], resumable: () => false });
  assert.ok(!swept.runs.includes('r-qc4') || existsSync(to), 'the sweep removed the run directory with its quarantine');
  assert.equal(existsSync(join(to, '.git')), true, 'quarantined content outlives the run');
  assert.ok(readdirSync(staleMountsDir(names.integration)).length > 0);
});
