/**
 * Worktree-per-phase, against real git.
 *
 * Nothing here is mocked. `server/runner/worktree.ts` is the one module in the
 * server allowed to mutate a repository, so the only test of it worth having is
 * one that lets it mutate a repository and then asks git what happened. Each
 * case builds a throwaway repo in `tmpdir()`, and every assertion is a `git`
 * read of the result rather than a claim about what the module returned.
 *
 * The three exit criteria of console-audit-hardening P22 are the three headings
 * below: two disjoint lanes land, a conflict halts recoverably, and an
 * un-opted-in plan behaves exactly as it did before any of this existed.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { worktreeRootOf } from '../shared/worktree-model.js';

import {
  acquireLane, checkAvailable, checkouts, copyEnvFiles, discardFreshTree, divergence,
  detectMirror, ensureIntegration, ensureMirror, isRegistered, landIntegration, landLane,
  laneNames, optedIn, pairKey, parseGitmodulesPaths, probeRunGit, pruneMirror, pruneRun,
  previewIsolation,
  pruneRunTree, radarPair, readMirror, resolveMounts, runSetup, sameGitFacts, scopeConfined,
  stagingNames, sweepStale, sweepUnmanaged, treeDisk, validateMirror,
  branchAt, commitOf, defaultBranchOf, deleteMergedBranches, ensureDetachedIntegration,
  reclaimBranch, runBranches, holdsDetached, holdsBranch,
  REFUSAL_REASON, mirrorManifestPath,
  laneHome,
  managedRoots,
  realish,
  stagingHome,
  worktreeHome,
  worktreesRoot,
} from '../server/runner/worktree.ts';

/** `git`, throwing on failure — a broken FIXTURE must not read as a finding. */
function git(cwd: string, ...args: string[]): string {
  return String(execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      LC_ALL: 'C',
      GIT_AUTHOR_NAME: 'p22', GIT_AUTHOR_EMAIL: 'p22@example.invalid',
      GIT_COMMITTER_NAME: 'p22', GIT_COMMITTER_EMAIL: 'p22@example.invalid',
    },
  })).trim();
}

const trash: string[] = [];
process.on('exit', () => {
  for (const dir of trash) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/** A repository with one commit on `main`, and a state directory beside it. */
function fixture(files: Record<string, string> = { 'README.md': 'base\n' }): {
  root: string; stateDir: string;
} {
  const base = mkdtempSync(join(tmpdir(), 'p22-wt-'));
  trash.push(base);
  const root = join(base, 'repo');
  const stateDir = join(base, 'state');
  execFileSync('mkdir', ['-p', root, stateDir]);
  git(root, 'init', '-q', '-b', 'main');
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return { root, stateDir };
}

/** Commit `body` to `file` inside a lane's worktree. */
function commitIn(dir: string, file: string, body: string, message: string): void {
  writeFileSync(join(dir, file), body);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

/** Does `branch` contain `other`'s tip? The question a merge-back answers. */
function contains(root: string, branch: string, other: string): boolean {
  const out = git(root, 'rev-list', '--count', `${branch}..${other}`);
  return Number(out) === 0;
}

/* ------------------------------------------------------------------ *
 * The naming, which is a pure function and the thing two callers could
 * disagree about.
 * ------------------------------------------------------------------ */

test('a lane names its own directory and branch, and shares one integration tree', () => {
  const a = laneNames({ stateDir: '/s', runId: 'r1', slug: 'demo', phase: 7 });
  const b = laneNames({ stateDir: '/s', runId: 'r1', slug: 'demo', phase: 11 });

  assert.equal(a.runBranch, 'pe/demo');
  assert.equal(a.laneBranch, 'pe/demo-p7');
  assert.equal(a.dir, '/s/worktrees/r1/p7');
  assert.equal(b.laneBranch, 'pe/demo-p11');
  assert.notEqual(a.dir, b.dir, 'two lanes must not share a checkout');
  assert.equal(a.integration, b.integration, 'both land on the same run branch');

  // Two runs of the same plan do not collide, which is what the runId is for.
  const other = laneNames({ stateDir: '/s', runId: 'r2', slug: 'demo', phase: 7 });
  assert.notEqual(a.dir, other.dir);
});

/* ------------------------------------------------------------------ *
 * Where the trees live — inside the project by default, and the older
 * state-directory home is still a home.
 * ------------------------------------------------------------------ */

test('the worktree root is inside the project by default, and the state directory on request', () => {
  const stateDir = '/s/runs/i-x/demo';
  assert.equal(worktreesRoot('/r'), '/r/.worktrees');
  assert.equal(worktreeHome({ mode: 'project', root: '/r', slug: 'demo', stateDir }), '/r/.worktrees/runs/demo');
  assert.equal(worktreeHome({ mode: 'state', root: '/r', slug: 'demo', stateDir }), '/s/runs/i-x/demo/worktrees');
  assert.equal(stagingHome({ mode: 'project', root: '/r', consoleDir: '/s/runs/i-x' }), '/r/.worktrees');
  assert.equal(stagingHome({ mode: 'state', root: '/r', consoleDir: '/s/runs/i-x' }), '/s/runs/i-x');
  // The two spellings of a home fold to one path, so no caller builds it twice.
  assert.equal(laneHome({ home: '/h' }), '/h');
  assert.equal(laneHome({ stateDir: '/s/runs/i-x/demo' }), '/s/runs/i-x/demo/worktrees');
  assert.equal(
    laneNames({ home: '/r/.worktrees/runs/demo', runId: 'r1', slug: 'demo', phase: 7 }).dir,
    '/r/.worktrees/runs/demo/r1/p7',
  );
  // A hand session's lanes share the folder and are NOT the console's to manage.
  assert.deepEqual(
    managedRoots({ root: '/r', consoleDir: '/s/runs/i-x' }),
    ['/s/runs/i-x', '/r/.worktrees/runs', '/r/.worktrees/staging'],
  );
  // Only the exact word leaves the project — a typo keeps the trees findable.
  assert.equal(worktreeRootOf('state'), 'state');
  assert.equal(worktreeRootOf('State'), 'project');
  assert.equal(worktreeRootOf(undefined), 'project');
});

test('a tree under <root>/.worktrees is excluded from the root\'s own git status, once', async () => {
  const { root, stateDir } = fixture();
  const home = worktreeHome({ mode: 'project', root, slug: 'demo', stateDir });
  const names = laneNames({ home, runId: 'r1', slug: 'demo', phase: 3 });
  assert.equal((await ensureIntegration(root, names)).ok, true);
  assert.equal((await acquireLane(root, names)).ok, true);
  assert.ok(names.dir.startsWith(join(root, '.worktrees', 'runs', 'demo', 'r1')));

  const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((line) => line === '/.worktrees/').length, 1);
  assert.equal(git(root, 'status', '--porcelain'), '', 'the root tree stays clean');

  // A second creation writes nothing more.
  assert.equal((await ensureIntegration(root, names)).ok, true);
  const again = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(again, exclude);

  // And the registry knows the tree as OURS when the project home is a managed root.
  const managed = await checkouts(root, managedRoots({ root, consoleDir: stateDir }));
  assert.equal(managed.find((entry) => entry.dir === realish(names.dir))?.managed, true);
  const legacyOnly = await checkouts(root, stateDir);
  assert.equal(legacyOnly.find((entry) => entry.dir === realish(names.dir))?.managed, false);
});

test('a superproject mirror mount under <hub>/.worktrees excludes the folder in the HUB', async () => {
  const { root, stateDir } = superFixture();
  const home = worktreeHome({ mode: 'project', root, slug: 'demo', stateDir });
  // A submodule's tree placed where a mirror mount goes: the folder sits in
  // the hub's working tree, so it is the hub's exclude file that matters.
  const names = laneNames({ home, runId: 'r1', slug: 'demo', phase: 0 });
  const mount = { ...names, integration: join(names.integration, 'web') };
  assert.equal((await ensureIntegration(join(root, 'web'), mount)).ok, true);
  const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
  assert.ok(exclude.split('\n').includes('/.worktrees/'));
  assert.ok(!git(root, 'status', '--porcelain').includes('.worktrees'), 'the hub tree stays clean');
});

test('the staging tree ITSELF reads as managed under the project root — equality, not only prefix', async () => {
  const { root, stateDir } = fixture();
  const consoleDir = join(stateDir, 'runs', 'i-x');
  const staging = stagingNames(stagingHome({ mode: 'project', root, consoleDir }));
  assert.equal(staging.dir, join(root, '.worktrees', 'staging'));
  // The tree as the console's first integration settle makes it (`landIntegration`).
  execFileSync('mkdir', ['-p', join(root, '.worktrees')]);
  git(root, 'worktree', 'add', '-q', '-b', staging.branch, staging.dir, 'main');
  const rows = await checkouts(root, managedRoots({ root, consoleDir }));
  const row = rows.find((entry) => entry.dir === realish(staging.dir));
  assert.ok(row, 'the staging tree is registered');
  assert.equal(row.managed, true, 'the one tree pe/integration lives in is the console\'s own');
});

test('the exclude line lands in the NEAREST root when the instance root itself sits under a .worktrees folder', async () => {
  // A root that stands inside somebody else's `.worktrees/` — a hand lane, a
  // mirror mount — must write ITS OWN exclude, not the outer hub's.
  const base = mkdtempSync(join(tmpdir(), 'p22-nested-'));
  trash.push(base);
  const outer = join(base, 'outer');
  const root = join(outer, '.worktrees', 'hand', 'x', 'repo');
  execFileSync('mkdir', ['-p', root]);
  git(outer, 'init', '-q', '-b', 'main');
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'nested\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const stateDir = join(base, 'state');
  const home = worktreeHome({ mode: 'project', root, slug: 'demo', stateDir });
  const names = laneNames({ home, runId: 'r1', slug: 'demo', phase: 0 });
  assert.equal((await ensureIntegration(root, names)).ok, true);
  const own = join(root, '.git', 'info', 'exclude');
  assert.ok(existsSync(own) && readFileSync(own, 'utf8').split('\n').includes('/.worktrees/'), 'the nested root excludes its own folder');
  const outerExclude = join(outer, '.git', 'info', 'exclude');
  assert.ok(!existsSync(outerExclude) || !readFileSync(outerExclude, 'utf8').includes('/.worktrees/'),
    'the OUTER repository was written to instead');
});

test('a sweep reads BOTH homes, so a tree made under the other setting is never orphaned', async () => {
  const { root, stateDir } = fixture();
  const project = worktreeHome({ mode: 'project', root, slug: 'demo', stateDir });
  const legacy = worktreeHome({ mode: 'state', root, slug: 'demo', stateDir });
  const a = laneNames({ home: project, runId: 'r1', slug: 'demo', phase: 1 });
  const b = laneNames({ home: legacy, runId: 'r2', slug: 'demo', phase: 2 });
  assert.equal((await ensureIntegration(root, a)).ok, true);
  assert.equal((await acquireLane(root, a)).ok, true);
  // The second run's lane is made by hand under the OLDER home: git allows
  // `pe/demo` one tree, so it cannot have an integration tree of its own while
  // r1 holds it — and a lane alone is exactly what a dead run leaves behind.
  mkdirSync(join(legacy, 'r2'), { recursive: true });
  git(root, 'worktree', 'add', '-b', b.laneBranch, b.dir, b.runBranch);

  const swept = await sweepStale(root, { homes: [project, legacy], slug: 'demo', liveRunIds: [] });
  assert.deepEqual(swept.kept, []);
  assert.deepEqual([...swept.runs].sort(), ['r1', 'r2']);
  assert.ok(swept.removed.includes(a.dir));
  assert.ok(swept.removed.includes(a.integration));
  assert.ok(swept.removed.includes(b.dir));
  assert.equal(existsSync(join(project, 'r1')), false);
  assert.equal(existsSync(join(legacy, 'r2')), false);
});

/* ------------------------------------------------------------------ *
 * EC3, first: the default is OFF, and every refusal is NAMED.
 * ------------------------------------------------------------------ */

test('EC3 — silence means off, and `off` means off', () => {
  assert.equal(optedIn(undefined), false, 'a plan that never said must not get worktrees');
  assert.equal(optedIn('off'), false);
  assert.equal(optedIn('on'), true);
});

test('EC3 — an un-opted-in plan is refused before git is touched at all', async () => {
  const { root } = fixture();
  const before = git(root, 'worktree', 'list');

  assert.equal(
    await checkAvailable({ root, gitMode: 'new-branch', directive: undefined }),
    'not-opted-in',
  );
  assert.equal(
    await checkAvailable({ root, gitMode: 'new-branch', directive: 'off' }),
    'not-opted-in',
  );
  assert.equal(git(root, 'worktree', 'list'), before, 'a refusal must not create anything');
  assert.equal(git(root, 'branch', '--format=%(refname:short)'), 'main', 'no branch either');
});

test('a run with no run branch, a non-repo, and a superproject are each refused BY NAME', async () => {
  const { root } = fixture();

  // No run branch: worktree lanes land on `pe/<slug>`, and a default-branch run
  // has nowhere to land.
  assert.equal(
    await checkAvailable({ root, gitMode: 'default', directive: 'on' }),
    'no-run-branch',
  );

  // Not a repository.
  const loose = mkdtempSync(join(tmpdir(), 'p22-loose-'));
  trash.push(loose);
  assert.equal(
    await checkAvailable({ root: loose, gitMode: 'new-branch', directive: 'on' }),
    'not-a-repo',
  );

  // A superproject. This is the refusal that matters most: `git worktree add`
  // on a repo with submodules produces EMPTY submodule directories, so a phase
  // scoped to one would board a session into nothing and work confidently on
  // nothing.
  writeFileSync(join(root, '.gitmodules'), '[submodule "x"]\n\tpath = x\n\turl = ./x\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'submodules');
  assert.equal(
    await checkAvailable({ root, gitMode: 'new-branch', directive: 'on' }),
    'has-submodules',
  );

  // Every refusal has a sentence a person can act on.
  for (const [kind, reason] of Object.entries(REFUSAL_REASON)) {
    assert.ok(reason.length > 30, `${kind}'s reason is not a sentence`);
  }
});

/* ------------------------------------------------------------------ *
 * EC1: two disjoint lanes run at once, in separate worktrees, and both
 * land on the run branch.
 * ------------------------------------------------------------------ */

test('EC1 — two lanes work in separate trees and BOTH land on the run branch', async () => {
  const { root, stateDir } = fixture({ 'README.md': 'base\n' });
  const opts = { stateDir, runId: 'run1', slug: 'demo' };
  const a = laneNames({ ...opts, phase: 4 });
  const b = laneNames({ ...opts, phase: 9 });

  assert.equal((await acquireLane(root, a)).ok, true);
  assert.equal((await acquireLane(root, b)).ok, true);

  // They are genuinely different working trees — the property the whole
  // feature exists for. Same object database, three checkouts, one branch each.
  assert.ok(existsSync(join(a.dir, 'README.md')));
  assert.ok(existsSync(join(b.dir, 'README.md')));
  assert.notEqual(a.dir, b.dir);
  assert.equal(git(a.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo-p4');
  assert.equal(git(b.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo-p9');
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main',
    "the operator's own checkout must never move");

  // Both commit AT THE SAME TIME, to different files — the disjoint-scope case.
  commitIn(a.dir, 'alpha.txt', 'from phase 4\n', 'phase 4 work');
  commitIn(b.dir, 'beta.txt', 'from phase 9\n', 'phase 9 work');

  // Lane A lands first: nothing else has moved the run branch, so it is a
  // fast-forward.
  const first = await landLane(root, a);
  assert.deepEqual(first, { kind: 'merged', fastForward: true, commits: 1 });

  // Lane B lands second, onto a run branch that has moved. It cannot
  // fast-forward, and a merge commit is the honest record of that.
  const second = await landLane(root, b);
  assert.equal(second.kind, 'merged');
  assert.equal((second as { fastForward: boolean }).fastForward, false);

  // The run branch now carries both — asked of git, not of the return values.
  assert.ok(contains(root, 'pe/demo', 'pe/demo-p4'), "phase 4's commits are missing");
  assert.ok(contains(root, 'pe/demo', 'pe/demo-p9'), "phase 9's commits are missing");
  assert.equal(readFileSync(join(a.integration, 'alpha.txt'), 'utf8'), 'from phase 4\n');
  assert.equal(readFileSync(join(a.integration, 'beta.txt'), 'utf8'), 'from phase 9\n');
  assert.equal(git(root, 'rev-parse', 'main'), git(root, 'rev-parse', 'main'));
  assert.notEqual(git(root, 'rev-parse', 'main'), git(root, 'rev-parse', 'pe/demo'),
    'the default branch must not have moved');
});

test('a lane that committed nothing lands as `empty`, not as a failure', async () => {
  const { root, stateDir } = fixture();
  const names = laneNames({ stateDir, runId: 'run1', slug: 'demo', phase: 2 });
  assert.equal((await acquireLane(root, names)).ok, true);

  assert.deepEqual(await landLane(root, names), { kind: 'empty' });
});

test('a retried lane REUSES its worktree — the first attempt\'s commits survive', async () => {
  const { root, stateDir } = fixture();
  const names = laneNames({ stateDir, runId: 'run1', slug: 'demo', phase: 3 });

  assert.equal((await acquireLane(root, names)).ok, true);
  commitIn(names.dir, 'work.txt', 'attempt one\n', 'attempt one');
  const afterFirst = git(names.dir, 'rev-parse', 'HEAD');

  // The runner calls `acquireLane` once per boarding, and a retry is a second
  // boarding of the same phase. Recreating the directory here would throw away
  // whatever the first attempt committed.
  const again = await acquireLane(root, names);
  assert.equal(again.ok, true);
  assert.equal(again.dir, names.dir);
  assert.equal(git(names.dir, 'rev-parse', 'HEAD'), afterFirst, 'the first attempt was discarded');
  assert.equal(readFileSync(join(names.dir, 'work.txt'), 'utf8'), 'attempt one\n');
});

/* ------------------------------------------------------------------ *
 * EC2: a conflict halts with both lanes named, and NOTHING is lost.
 * ------------------------------------------------------------------ */

test('EC2 — a conflicting lane is refused, the merge is ABORTED, and every commit survives', async () => {
  const { root, stateDir } = fixture({ 'shared.txt': 'base\n' });
  const opts = { stateDir, runId: 'run1', slug: 'demo' };
  const a = laneNames({ ...opts, phase: 4 });
  const b = laneNames({ ...opts, phase: 9 });

  assert.equal((await acquireLane(root, a)).ok, true);
  assert.equal((await acquireLane(root, b)).ok, true);

  // Both edit the SAME line of the same file — the case git cannot resolve and
  // must not guess at.
  commitIn(a.dir, 'shared.txt', 'phase 4 wrote this\n', 'phase 4');
  commitIn(b.dir, 'shared.txt', 'phase 9 wrote this\n', 'phase 9');

  assert.equal((await landLane(root, a)).kind, 'merged');

  const clash = await landLane(root, b);
  assert.equal(clash.kind, 'conflict');
  assert.deepEqual((clash as { files: string[] }).files, ['shared.txt'],
    'the halt must be able to name the files');
  assert.ok((clash as { detail: string }).detail.length > 0, 'git said why; that must be carried');

  // NOTHING LOST — the whole point. Both lane branches still hold their work,
  // and the integration tree is clean rather than sitting in a half-merge with
  // conflict markers nobody downstream could interpret.
  assert.equal(git(root, 'rev-parse', '--verify', 'pe/demo-p4^{commit}').length, 40);
  assert.equal(git(root, 'rev-parse', '--verify', 'pe/demo-p9^{commit}').length, 40);
  assert.equal(readFileSync(join(b.dir, 'shared.txt'), 'utf8'), 'phase 9 wrote this\n',
    "the losing lane's own tree is untouched");
  assert.equal(git(a.integration, 'status', '--porcelain'), '',
    'the integration tree must not be left mid-merge');
  assert.ok(!existsSync(join(a.integration, '.git', 'MERGE_HEAD')));
  // …and the run branch still carries the lane that DID land.
  assert.ok(contains(root, 'pe/demo', 'pe/demo-p4'));
  assert.ok(!contains(root, 'pe/demo', 'pe/demo-p9'));

  // …and the verdict is stable. An operator who hits Retry gets the same
  // answer rather than a different failure, because the abort really did put
  // the integration tree back where it started.
  const again = await landLane(root, b);
  assert.equal(again.kind, 'conflict');
  assert.deepEqual((again as { files: string[] }).files, ['shared.txt']);
  assert.equal(git(a.integration, 'status', '--porcelain'), '');
});

test('landing a lane that never existed says so instead of throwing', async () => {
  const { root, stateDir } = fixture();
  const names = laneNames({ stateDir, runId: 'run1', slug: 'demo', phase: 5 });
  const result = await landLane(root, names);
  assert.equal(result.kind, 'failed');
  assert.match((result as { detail: string }).detail, /pe\/demo-p5/);
});

/* ------------------------------------------------------------------ *
 * Prune — which is also about never destroying work.
 * ------------------------------------------------------------------ */

test('prune removes landed lanes and KEEPS one whose commits have not landed', async () => {
  const { root, stateDir } = fixture({ 'shared.txt': 'base\n' });
  const opts = { stateDir, runId: 'run1', slug: 'demo' };
  const a = laneNames({ ...opts, phase: 4 });
  const b = laneNames({ ...opts, phase: 9 });

  await acquireLane(root, a);
  await acquireLane(root, b);
  commitIn(a.dir, 'shared.txt', 'phase 4\n', 'phase 4');
  commitIn(b.dir, 'shared.txt', 'phase 9\n', 'phase 9');
  await landLane(root, a);
  assert.equal((await landLane(root, b)).kind, 'conflict');

  const { removed, kept } = await pruneRun(root, { ...opts, phases: [4, 9] });
  assert.deepEqual(removed, [a.dir], 'the landed lane is finished with');
  assert.ok(kept.includes(b.dir), 'a lane holding unlanded commits must NOT be removed');
  assert.ok(!existsSync(a.dir));
  assert.ok(existsSync(join(b.dir, 'shared.txt')), "the conflicted lane's tree is still there");
  assert.ok(await isRegistered(root, b.dir));
  // The integration tree stays too — the survivor has nowhere else to land.
  assert.ok(await isRegistered(root, a.integration));
});

test('prune clears everything when every lane landed', async () => {
  const { root, stateDir } = fixture();
  const opts = { stateDir, runId: 'run1', slug: 'demo' };
  const a = laneNames({ ...opts, phase: 1 });
  const b = laneNames({ ...opts, phase: 2 });

  await acquireLane(root, a);
  await acquireLane(root, b);
  commitIn(a.dir, 'one.txt', '1\n', 'one');
  commitIn(b.dir, 'two.txt', '2\n', 'two');
  await landLane(root, a);
  await landLane(root, b);

  const { removed, kept } = await pruneRun(root, { ...opts, phases: [1, 2] });
  assert.deepEqual(kept, []);
  assert.equal(removed.length, 3, 'two lanes and the integration tree');
  assert.ok(!existsSync(join(stateDir, 'worktrees', 'run1')));

  // The branches are NOT deleted — they are the record of which lane produced
  // which commits, and they cost nothing.
  const branches = git(root, 'branch', '--format=%(refname:short)').split('\n');
  assert.ok(branches.includes('pe/demo-p1'));
  assert.ok(branches.includes('pe/demo-p2'));
  assert.ok(contains(root, 'pe/demo', 'pe/demo-p1'));
  assert.ok(contains(root, 'pe/demo', 'pe/demo-p2'));
});

test('the integration tree is created once, whichever lane asks first', async () => {
  const { root, stateDir } = fixture();
  const opts = { stateDir, runId: 'run1', slug: 'demo' };
  const a = laneNames({ ...opts, phase: 4 });

  assert.equal((await ensureIntegration(root, a)).ok, true);
  const head = git(a.integration, 'rev-parse', 'HEAD');
  assert.equal((await ensureIntegration(root, a)).ok, true, 'it must be idempotent');
  assert.equal(git(a.integration, 'rev-parse', 'HEAD'), head);
  assert.equal(git(a.integration, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo');
});

test('a run branch already checked out somewhere else is refused IN WORDS, not in git-speak', async () => {
  const { root, stateDir } = fixture();
  const names = laneNames({ stateDir, runId: 'run1', slug: 'demo', phase: 4 });

  // The overwhelmingly likely holder is the operator's own tree: the console's
  // new-branch strategy tells sessions to check `pe/<slug>` out there, and git
  // allows a branch exactly one working tree.
  git(root, 'checkout', '-q', '-b', 'pe/demo');
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo');

  const refused = await ensureIntegration(root, names);
  assert.equal(refused.ok, false);
  assert.match(refused.detail ?? '', /already checked out at/);
  assert.match(refused.detail ?? '', /one working tree/);
  assert.ok(!existsSync(names.integration), 'nothing is left behind by the refusal');
  assert.ok(!existsSync(join(stateDir, 'worktrees')), 'not even the parent directory');

  // A lane inherits the refusal rather than half-creating itself.
  const lane = await acquireLane(root, names);
  assert.equal(lane.ok, false);
  assert.equal(lane.dir, undefined);
  assert.ok(!existsSync(names.dir));

  // …and once the branch is free, the same call succeeds. The refusal is about
  // the state of the world, not a permanent verdict on the run.
  git(root, 'checkout', '-q', 'main');
  assert.equal((await ensureIntegration(root, names)).ok, true);
  assert.equal(git(names.integration, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo');
});

/* ------------------------------------------------------------------ *
 * D9: a reused lane is caught up with the run branch BEFORE it boards.
 *
 * The defect this closes cost the operator their own work. After a
 * merge conflict the console halts and says "resolve it by hand in
 * `integration/`, then Retry". They do — and Retry reused the lane at
 * its PRE-resolution fork point, so the phase ran again from before the
 * fix and conflicted on the same lines a second time. The resolution
 * was never wrong; it was never visible.
 * ------------------------------------------------------------------ */

test('D9 — a retried lane arrives holding the hand-resolution made in `integration/`', async () => {
  const { root, stateDir } = fixture({ 'shared.txt': 'base\n' });
  const opts = { stateDir, runId: 'run1', slug: 'demo' };
  const a = laneNames({ ...opts, phase: 4 });
  const b = laneNames({ ...opts, phase: 9 });

  await acquireLane(root, a);
  await acquireLane(root, b);
  commitIn(a.dir, 'shared.txt', 'phase 4 wrote this\n', 'phase 4');
  commitIn(b.dir, 'shared.txt', 'phase 9 wrote this\n', 'phase 9');
  await landLane(root, a);
  assert.equal((await landLane(root, b)).kind, 'conflict', 'the halt this whole path is about');

  // The operator does exactly what the halt tells them to: finish the merge by
  // hand, in `integration/`. The resolution is therefore a merge commit whose
  // second parent IS the lane — which is what makes the lane's own tip an
  // ancestor of the run branch, and the resync below a fast-forward.
  try { git(a.integration, 'merge', '--no-edit', 'pe/demo-p9'); } catch { /* conflicts, as it must */ }
  writeFileSync(join(a.integration, 'shared.txt'), 'both, resolved by hand\n');
  git(a.integration, 'add', '-A');
  git(a.integration, 'commit', '-q', '--no-edit');

  // Retry. This is the call the runner makes on a second boarding.
  const retry = await acquireLane(root, b);
  assert.equal(retry.ok, true);
  assert.equal(retry.dir, b.dir, 'the lane is reused, not recreated');
  assert.equal(retry.resync?.kind, 'merged');
  assert.ok((retry.resync as { behind: number }).behind > 0, 'it was genuinely behind');

  // The point: the resolution is IN the lane now, so the session boards on top
  // of it instead of re-doing the work that caused the clash.
  assert.equal(readFileSync(join(b.dir, 'shared.txt'), 'utf8'), 'both, resolved by hand\n');
  assert.ok(contains(root, 'pe/demo-p9', 'pe/demo'), 'the lane carries the run branch');

  // …and it now lands cleanly, which is the operator-visible end of the story.
  commitIn(b.dir, 'later.txt', 'phase 9, second attempt\n', 'phase 9 again');
  assert.equal((await landLane(root, b)).kind, 'merged');
});

test('D9 — a lane that is already current is not merged, and says nothing', async () => {
  const { root, stateDir } = fixture();
  const names = laneNames({ stateDir, runId: 'run1', slug: 'demo', phase: 3 });

  assert.equal((await acquireLane(root, names)).ok, true);
  commitIn(names.dir, 'work.txt', 'attempt one\n', 'attempt one');
  const head = git(names.dir, 'rev-parse', 'HEAD');

  const again = await acquireLane(root, names);
  assert.equal(again.resync, undefined, 'nothing to resync must not journal a resync');
  assert.equal(git(names.dir, 'rev-parse', 'HEAD'), head, 'and it must not make a merge commit');
});

test('D9 — a resync that CONFLICTS aborts, keeps every commit, and says which files', async () => {
  const { root, stateDir } = fixture({ 'shared.txt': 'base\n' });
  const opts = { stateDir, runId: 'run1', slug: 'demo' };
  const a = laneNames({ ...opts, phase: 4 });
  const b = laneNames({ ...opts, phase: 9 });

  await acquireLane(root, a);
  await acquireLane(root, b);
  commitIn(a.dir, 'shared.txt', 'phase 4 wrote this\n', 'phase 4');
  commitIn(b.dir, 'shared.txt', 'phase 9 wrote this\n', 'phase 9');
  await landLane(root, a);

  // Retrying phase 9 now pulls a run branch that clashes with its own commit.
  const retry = await acquireLane(root, b);
  assert.equal(retry.resync?.kind, 'conflict');
  assert.deepEqual((retry.resync as { files: string[] }).files, ['shared.txt'],
    'the halt must be able to name the files');

  // NOTHING LOST, and no half-merge left behind — the same contract `landLane`
  // keeps, because an operator opening this directory next must find a tree
  // they can work in rather than a mess with no note saying who made it.
  assert.equal(readFileSync(join(b.dir, 'shared.txt'), 'utf8'), 'phase 9 wrote this\n');
  assert.equal(git(b.dir, 'status', '--porcelain'), '');
  assert.ok(!existsSync(join(b.dir, '.git', 'MERGE_HEAD')));
  assert.equal(git(root, 'rev-parse', '--verify', 'pe/demo-p9^{commit}').length, 40);
});

test('D9 — a lane left DIRTY is boarded as it stands, never halted over', async () => {
  const { root, stateDir } = fixture({ 'shared.txt': 'base\n' });
  const opts = { stateDir, runId: 'run1', slug: 'demo' };
  const a = laneNames({ ...opts, phase: 4 });
  const b = laneNames({ ...opts, phase: 9 });

  await acquireLane(root, a);
  await acquireLane(root, b);
  commitIn(a.dir, 'alpha.txt', 'phase 4\n', 'phase 4');
  await landLane(root, a);

  // A session killed mid-edit, on the very file the run branch is bringing in.
  // git refuses to merge over an untracked file it would overwrite — and
  // refusing to BOARD the phase over that would be a worse answer than boarding
  // it on a stale base.
  writeFileSync(join(b.dir, 'alpha.txt'), 'half-typed\n');

  const retry = await acquireLane(root, b);
  assert.equal(retry.ok, true, 'the phase must still board');
  assert.equal(retry.dir, b.dir);
  assert.equal(retry.resync?.kind, 'skipped', 'and the run must be told it is on a stale base');
  assert.ok((retry.resync as { detail: string }).detail.length > 0, 'git said why');
  assert.equal(readFileSync(join(b.dir, 'alpha.txt'), 'utf8'), 'half-typed\n',
    'the uncommitted edit is untouched');
});

/* ------------------------------------------------------------------ *
 * D10: a dead run's worktrees are swept, and work is never swept.
 *
 * `git worktree prune` ignores an INTACT directory, so a console that
 * was killed left `integration/` registered on `pe/<slug>` forever and
 * every later run of that plan degraded to a shared checkout with
 * nothing saying why.
 * ------------------------------------------------------------------ */

test('D10 — a dead run\'s wedged integration is swept, and the next run can have it', async () => {
  const { root, stateDir } = fixture();
  const dead = { stateDir, runId: 'run1', slug: 'demo' };
  const a = laneNames({ ...dead, phase: 4 });

  await acquireLane(root, a);
  commitIn(a.dir, 'one.txt', '1\n', 'one');
  await landLane(root, a);

  // The console is SIGKILLed here: nothing pruned, the trees are intact, and
  // `pe/demo` is checked out inside run1's integration directory.
  assert.ok(await isRegistered(root, a.integration));

  // The next run cannot have the run branch — this is the whole defect, proved
  // before the fix is applied to it.
  const next = laneNames({ stateDir, runId: 'run2', slug: 'demo', phase: 4 });
  const wedged = await ensureIntegration(root, next);
  assert.equal(wedged.ok, false);
  assert.match(wedged.detail ?? '', /already checked out at/);

  const swept = await sweepStale(root, { stateDir, slug: 'demo', liveRunIds: ['run2'] });
  assert.deepEqual(swept.kept, [], 'nothing here held work');
  assert.deepEqual(swept.runs, ['run1']);
  assert.ok(swept.removed.includes(a.dir));
  assert.ok(swept.removed.includes(a.integration));
  assert.ok(!existsSync(join(stateDir, 'worktrees', 'run1')));

  // …and now it can.
  assert.equal((await ensureIntegration(root, next)).ok, true);
  assert.equal(git(next.integration, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo');
  // The commits are still on the run branch. A sweep clears CHECKOUTS.
  assert.ok(contains(root, 'pe/demo', 'pe/demo-p4'));
});

test('D10 — two belts hold the sweep off: a live run, and a dead one whose child is still up', async () => {
  const { root, stateDir } = fixture();
  const names = laneNames({ stateDir, runId: 'run1', slug: 'demo', phase: 1 });
  await acquireLane(root, names);
  commitIn(names.dir, 'one.txt', '1\n', 'one');
  await landLane(root, names);
  // Nothing here holds work, so ONLY the two belts can save it — which is
  // exactly what makes this a test of the belts.

  // Belt 1: this console is driving run1 right now.
  const live = await sweepStale(root, { stateDir, slug: 'demo', liveRunIds: ['run1'] });
  assert.deepEqual(live, { removed: [], kept: [], runs: [] });
  assert.ok(await isRegistered(root, names.dir), 'a live run must be untouched');

  // Belt 2: run1 is NOT this console's — it belongs to a console that died —
  // but a session it spawned outlived it and is still writing that lane. A
  // directory scan alone would delete the tree out from under a working agent.
  const held = await sweepStale(root, {
    stateDir,
    slug: 'demo',
    liveRunIds: [],
    children: (runId) => (runId === 'run1' ? [4242] : []),
    probe: (pid) => pid === 4242,
  });
  assert.deepEqual(held, { removed: [], kept: [], runs: [] });
  assert.ok(await isRegistered(root, names.dir));

  // …and once that pid is gone, the same call sweeps.
  const gone = await sweepStale(root, {
    stateDir,
    slug: 'demo',
    liveRunIds: [],
    children: (runId) => (runId === 'run1' ? [4242] : []),
    probe: () => false,
  });
  assert.deepEqual(gone.runs, ['run1']);
  assert.ok(!existsSync(names.dir));
});

test('D10 — the sweep never deletes work: unlanded commits and uncommitted edits both survive', async () => {
  const { root, stateDir } = fixture();
  const opts = { stateDir, runId: 'run1', slug: 'demo' };
  const unlanded = laneNames({ ...opts, phase: 4 });
  const dirty = laneNames({ ...opts, phase: 9 });
  const clean = laneNames({ ...opts, phase: 11 });

  await acquireLane(root, unlanded);
  await acquireLane(root, dirty);
  await acquireLane(root, clean);

  // Committed but never merged — the conflict-halt state.
  commitIn(unlanded.dir, 'unlanded.txt', 'phase 4\n', 'phase 4');
  // Never committed at all — the killed-session state, and the one `diff` alone
  // cannot see, because the file was never added.
  writeFileSync(join(dirty.dir, 'scratch.txt'), 'work nobody committed\n');

  const swept = await sweepStale(root, { stateDir, slug: 'demo', liveRunIds: [] });

  assert.deepEqual(swept.removed, [clean.dir], 'only the lane holding nothing goes');
  assert.deepEqual(swept.kept.sort(), [unlanded.dir, dirty.dir].sort());
  assert.deepEqual(swept.runs, [], 'a run with a kept tree is not cleared away');
  assert.ok(existsSync(join(unlanded.dir, 'unlanded.txt')));
  assert.equal(readFileSync(join(dirty.dir, 'scratch.txt'), 'utf8'), 'work nobody committed\n');
  // The integration tree stays while a lane survives: it is the only thing
  // those lanes have to be merged into.
  assert.ok(await isRegistered(root, unlanded.integration));
});

test('D10 — an operator\'s uncommitted hand-resolution in `integration/` is never swept away', async () => {
  const { root, stateDir } = fixture({ 'shared.txt': 'base\n' });
  const opts = { stateDir, runId: 'run1', slug: 'demo' };
  const a = laneNames({ ...opts, phase: 4 });

  await acquireLane(root, a);
  commitIn(a.dir, 'shared.txt', 'phase 4\n', 'phase 4');
  await landLane(root, a);
  // Mid-resolution: edited, not yet committed. Deleting this is the one
  // unrecoverable thing a sweep could do.
  writeFileSync(join(a.integration, 'shared.txt'), 'being resolved right now\n');

  const swept = await sweepStale(root, { stateDir, slug: 'demo', liveRunIds: [] });
  assert.deepEqual(swept.removed, [a.dir], 'the landed lane still goes');
  assert.deepEqual(swept.kept, [a.integration]);
  assert.equal(readFileSync(join(a.integration, 'shared.txt'), 'utf8'), 'being resolved right now\n');
});

test('D10 — a plan that never used worktrees costs the sweep nothing', async () => {
  const { root, stateDir } = fixture();
  const swept = await sweepStale(root, { stateDir, slug: 'demo', liveRunIds: [] });
  assert.deepEqual(swept, { removed: [], kept: [], runs: [] });
  assert.equal(git(root, 'worktree', 'list').split('\n').length, 1, 'nothing was created');
});

/* ------------------------------------------------------------------ *
 * D11-docs: the header says what the code does.
 * ------------------------------------------------------------------ */

test('D11 — the module header spells lane branches the only way git allows', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../server/runner/worktree.ts', import.meta.url)), 'utf8',
  );
  const header = source.slice(0, source.indexOf('import '));
  // The layout block's lane lines, and only those — the prose below them now
  // names the impossible spelling on purpose, to explain why it is impossible.
  const lanes = header.split('\n').filter((line) => /^\s*\*\s+p\d+\//.test(line));
  assert.equal(lanes.length, 2, 'the layout example must still show two lanes');
  for (const line of lanes) {
    assert.match(line, /pe\/<slug>-p\d/, 'a lane branch is a SIBLING of the run branch');
    assert.ok(
      !/pe\/<slug>\/p\d/.test(line),
      'the header showed `pe/<slug>/pN`, a name git cannot hold while `pe/<slug>` exists',
    );
  }
});

/* ------------------------------------------------------------------ *
 * D6: where a lane session's WORK-STATE lands.
 *
 * The defect this closes was not subtle in its effect and completely
 * invisible in its cause: a lane session did the work, committed it,
 * wrote its handoff — and the board still read `no-handoff`, because
 * every skill script resolves its docs root from cwd, and in a linked
 * worktree `git rev-parse --show-toplevel` answers the WORKTREE. The
 * paperwork was filed inside the lane, where the engine, the store and
 * the scheduler (all reading `state.root`) never look.
 *
 * So this is deliberately not a test of a string. It runs the REAL
 * `new-handoff.sh` from a REAL linked worktree, twice — once with the
 * environment the console now injects and once without it — and asks
 * the filesystem where the file went. The second half is the
 * failing-before proof, executed rather than asserted: it is the old
 * behaviour, and it still lands in the wrong place.
 * ------------------------------------------------------------------ */

/** The scripts directory of the checkout under test — not the installed skill. */
const SCRIPTS = join(fileURLToPath(new URL('../..', import.meta.url)), 'scripts');

/** A minimal but REAL plan, so `new-handoff.sh` runs its real code path. */
const PLAN = [
  '---', 'slug: demo', 'created: 2026-08-26', 'status: active', '---', '',
  '## Phase graph', '',
  '| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |',
  '|------:|-------|-----------|--------------------|-------|---------------|',
  '| 1 | One | — | — | demo-repo | it works |', '',
  '## Phases', '', '### Phase 1 — One', '- **Verification:** `true`', '',
].join('\n');

/**
 * `env` is passed VERBATIM — it is not merged with `process.env` here.
 *
 * It used to be (`{ ...process.env, ...env }`), and that made the "without
 * DOCS_ROOT" half of D6 untestable in the one environment that matters most:
 * a session Phase Console spawned. The console exports `DOCS_ROOT` into every
 * such session, a caller that DELETES the key from its copy cannot un-set it by
 * spreading (a missing key does not override a present one), so the bare call
 * inherited the console's own DOCS_ROOT and wrote the fixture's handoff into the
 * REAL repository — failing the assertion, and leaving a stray
 * `docs/handoffs/demo/` behind that made every later run of this suite fail on
 * "refusing to overwrite existing handoff".
 */
function newHandoff(cwd: string, env: NodeJS.ProcessEnv): void {
  execFileSync('bash', [join(SCRIPTS, 'new-handoff.sh'), 'demo', '1', 'alpha', 'complete'], {
    cwd, encoding: 'utf8', env,
  });
}

test('D6 — a lane session\'s handoff lands at the RUN ROOT, not inside its worktree', () => {
  const { root, stateDir } = fixture({ 'README.md': 'base\n' });
  execFileSync('mkdir', ['-p', join(root, 'docs', 'plans')]);
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), PLAN);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'plan');

  const names = laneNames({ stateDir, runId: 'run1', slug: 'demo', phase: 1 });
  execFileSync('git', ['worktree', 'add', '-q', '-b', names.laneBranch, names.dir, 'main'], { cwd: root });

  // The lane really is a separate tree that answers for ITSELF — the whole
  // reason the cwd-upward fallback gets this wrong.
  assert.notEqual(git(names.dir, 'rev-parse', '--show-toplevel'), git(root, 'rev-parse', '--show-toplevel'));

  // WITH the environment the console now injects (`sessionEnv` sets DOCS_ROOT
  // for every spawned session): the handoff lands where the engine reads.
  newHandoff(names.dir, { ...process.env, DOCS_ROOT: root });
  const atRoot = join(root, 'docs', 'handoffs', 'demo', 'phase-01-alpha.md');
  assert.ok(existsSync(atRoot), 'the handoff did not land at the run root');
  assert.ok(!existsSync(join(names.dir, 'docs', 'handoffs', 'demo', 'phase-01-alpha.md')),
    'the handoff was ALSO written inside the lane — the routing is not exclusive');

  // …and the board, run at the run root exactly as the console runs it, can
  // therefore see the phase. This is the assertion the defect actually broke:
  // the file existing somewhere was never the problem.
  const board = String(execFileSync('bash', [join(SCRIPTS, 'phase-graph.sh'), 'demo'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, DOCS_ROOT: root },
  }));
  assert.match(board, /1\s+done/, `the board does not see the phase done:\n${board}`);

  // WITHOUT it — the scripts' OWN resolver now reads the lane's common git
  // directory (`pe_git_main_root`, scripts/instance.sh) and answers the main
  // tree, so a hand session working in a lane lands its handoff at the run
  // root too. (It used to land in the lane, which is precisely why every
  // worktree-lane phase halted `no-handoff` before the console injected
  // DOCS_ROOT; the injection stays — belt and braces.)
  rmSync(join(root, 'docs', 'handoffs'), { recursive: true, force: true });
  const bare = { ...process.env };
  delete bare.DOCS_ROOT;
  newHandoff(names.dir, bare);
  assert.ok(existsSync(atRoot), 'without DOCS_ROOT the resolver must still find the run root from a lane');
  assert.ok(!existsSync(join(names.dir, 'docs', 'handoffs', 'demo', 'phase-01-alpha.md')),
    'the handoff must never land inside the lane');
});

/* ------------------------------------------------------------------ *
 * Phase 6 — the RUN checkout's own refusals, at the unit level.
 *
 * A lane refuses for four reasons `checkAvailable` can answer on its
 * own. A run refuses for four more that only the drive preamble knows
 * about — a cap, a plan's scopes, a branch someone else holds, a setup
 * command that failed — and the ones below are the two that are pure
 * functions of a repository plus the cleanup rule for the tree itself.
 * The other two are decisions the runner makes, and they are proven
 * end-to-end in `git-strategy.test.ts` where a real Runner makes them.
 * ------------------------------------------------------------------ */

test('every refusal reason is a sentence, and every reason has a key', () => {
  // The two halves of one bijection. A refusal the runner can produce with no
  // sentence beside it renders as a bare slug on the run page; a sentence with
  // no producer is a claim about a state that cannot happen.
  const keys = Object.keys(REFUSAL_REASON).sort();
  assert.deepEqual(keys, [
    'branch-in-use', 'cap-reached', 'has-submodules', 'no-run-branch',
    'not-a-repo', 'not-opted-in', 'root-scoped', 'scope-outside-root', 'scope-unmapped',
    'setup-failed', 'worktree-failed',
  ]);
  for (const [key, text] of Object.entries(REFUSAL_REASON)) {
    assert.ok(text.length > 20, `${key}'s reason is too short to explain anything`);
    // The operator reads these next to the word "refused"; a reason that only
    // repeats the key tells them nothing they did not already see.
    assert.notEqual(text.trim(), key);
  }
});

test('scope confinement: `all`, the repo\'s own name, and a real path are inside', () => {
  const { root } = fixture({ 'README.md': 'base\n' });
  execFileSync('mkdir', ['-p', join(root, 'packages', 'cart-api')]);

  const own = root.split('/').pop()!.toLowerCase();
  assert.equal(scopeConfined(root, ['all']), true, '`all` names no tree, so it names no tree outside');
  assert.equal(scopeConfined(root, [own]), true, "the repo's own basename is the ordinary spelling");
  assert.equal(scopeConfined(root, ['packages/cart-api']), true, 'a real path under the root');
  assert.equal(scopeConfined(root, ['all', own, 'packages/cart-api']), true);
  assert.equal(scopeConfined(root, []), true, 'a plan that declares nothing confines nothing');
});

test('scope confinement: a sibling repository, a path that is not there, and `..` are OUT', () => {
  const { root } = fixture();

  // The shape this check exists for: a superproject's plans name its sibling
  // repositories — `phased-execution`, `checkout-service`, `billing` — which
  // are NOT inside the run root the console was pointed at. A
  // checkout of the root would not contain the work, and the session would
  // edit the shared tree from a cwd that swore it was isolated.
  assert.equal(scopeConfined(root, ['phased-execution']), false);
  // Not a claim about a name — a claim about a tree that is not there.
  assert.equal(scopeConfined(root, ['packages/cart-api']), false,
    'the directory does not exist in this fixture, so nothing vouches for it');
  // 🔴 `../elsewhere` is NOT the interesting case and asserting it proves
  // nothing about the prefix test: `normalizeToken` strips leading punctuation,
  // so that token arrives as `elsewhere` and is refused for not existing. A
  // token escapes only with a `..` in the MIDDLE, which normalization keeps
  // (`/` and `.` are both in its allowed set) — and that is the one `resolve`
  // has to collapse before the prefix test can answer.
  assert.equal(scopeConfined(root, ['../elsewhere']), false);
  assert.equal(scopeConfined(root, ['docs/../../elsewhere']), false);
  // One bad token is enough. A plan is confined or it is not.
  const own = root.split('/').pop()!.toLowerCase();
  assert.equal(scopeConfined(root, ['all', own, 'phased-execution']), false);
});

test('scope confinement: a sibling whose name merely starts with the root\'s is OUT', () => {
  const { root } = fixture();
  // The segment-wise rule, in the one place a naive `startsWith` gets it wrong:
  // `/tmp/p22-wt-xxx/repo-other` is not inside `/tmp/p22-wt-xxx/repo`, and it
  // EXISTS — so the existence check cannot be what refuses it, and only the
  // trailing-separator prefix test can. Spelled with a mid-token `..` because
  // that is the only spelling `normalizeToken` passes through intact.
  const sibling = `${root.split('/').pop()}-other`;
  execFileSync('mkdir', ['-p', `${root}-other`]);
  assert.equal(existsSync(`${root}-other`), true, 'the fixture did not build');
  assert.equal(scopeConfined(root, [`docs/../../${sibling}`]), false);
  // …and the same path one segment deeper IS inside, so the rule is not merely
  // "refuse anything with a `..` in it".
  execFileSync('mkdir', ['-p', join(root, 'docs', 'inner')]);
  assert.equal(scopeConfined(root, ['docs/../docs/inner']), true);
});

test('the setup command runs IN the new tree, and a failure is a failure', async () => {
  const { root, stateDir } = fixture();
  const names = laneNames({ stateDir, runId: 'r-setup', slug: 'demo', phase: 0 });
  assert.equal((await ensureIntegration(root, names)).ok, true);

  const ok = await runSetup(names.integration, 'pwd > .setup-ran');
  assert.equal(ok.ok, true);
  // In the TREE, not in the root — the whole point of a setup command.
  assert.ok(existsSync(join(names.integration, '.setup-ran')));
  assert.ok(!existsSync(join(root, '.setup-ran')));

  const bad = await runSetup(names.integration, 'echo nope >&2; exit 3');
  assert.equal(bad.ok, false);
  assert.match(bad.output, /nope/, 'the output an operator needs is the one on stderr');

  // A command that cannot be spawned at all is a failure, never a throw: the
  // caller's answer to both is identical, and a throw here would fail the RUN.
  const missing = await runSetup(names.integration, 'definitely-not-a-real-binary-9f3a');
  assert.equal(missing.ok, false);
});

test('the `.env*` copy takes top-level files and nothing else', async () => {
  const { root, stateDir } = fixture();
  writeFileSync(join(root, '.env'), 'A=1\n');
  writeFileSync(join(root, '.env.local'), 'B=2\n');
  writeFileSync(join(root, 'envelope.md'), 'not an env file\n');
  execFileSync('mkdir', ['-p', join(root, 'nested')]);
  writeFileSync(join(root, 'nested', '.env'), 'C=3\n');

  const names = laneNames({ stateDir, runId: 'r-env', slug: 'demo', phase: 0 });
  assert.equal((await ensureIntegration(root, names)).ok, true);

  const copied = await copyEnvFiles(root, names.integration);
  assert.deepEqual(copied.sort(), ['.env', '.env.local']);
  assert.equal(readFileSync(join(names.integration, '.env'), 'utf8'), 'A=1\n');
  // `envelope.md` starts with neither `.env` nor anything else that matters,
  // and the nested one is not copied at all — a recursive walk would reach
  // `node_modules`, which is not what this setting is for.
  assert.ok(!existsSync(join(names.integration, 'envelope.md')));
  assert.ok(!existsSync(join(names.integration, 'nested', '.env')));
});

test('pruneRunTree KEEPS the integration tree while a lane still has to land in it', async () => {
  const { root, stateDir } = fixture();
  {
    const opts = { stateDir, runId: 'r-lane', slug: 'demo' };
    const names = laneNames({ ...opts, phase: 1 });
    await ensureIntegration(root, names);
    await acquireLane(root, names);
    assert.equal(existsSync(names.dir), true, 'no lane was made, so this proves nothing');
    writeFileSync(join(names.dir, 'lane-unsaved.txt'), 'a session was working here\n');

    // 🔴 The mechanism behind the worst defect this phase produced. `pruneRun`
    // with NO phases never examines a lane, so `kept` came back empty however
    // much lane work was on disk — and it then reaches its terminal
    // `rm -rf <stateDir>/worktrees/<runId>`, taking every lane checkout with
    // it. A lane merges INTO the integration tree; removing that tree while a
    // lane survives leaves the lane nothing to land on, and deleting the lane
    // itself destroys work no commit holds.
    const out = await pruneRunTree(root, opts);
    assert.deepEqual(out.removed, [], 'the integration tree went while a lane still needed it');
    assert.deepEqual(out.kept, [names.integration]);
    assert.equal(readFileSync(join(names.dir, 'lane-unsaved.txt'), 'utf8'),
      'a session was working here\n', 'a lane checkout was deleted');
    assert.equal(existsSync(join(stateDir, 'worktrees', 'r-lane')), true,
      "the run's whole worktree directory was removed");
  }
});

test('pruneRunTree removes a CLEAN run checkout and keeps a dirty one', async () => {
  const { root, stateDir } = fixture();
  const opts = { stateDir, runId: 'r-clean', slug: 'demo' };
  const names = laneNames({ ...opts, phase: 0 });
  assert.equal((await ensureIntegration(root, names)).ok, true);

  // Commits are NOT what holds a tree — they are on the branch, which survives.
  commitIn(names.integration, 'work.txt', 'landed\n', 'the run did something');
  const clean = await pruneRunTree(root, opts);
  assert.deepEqual(clean.kept, []);
  assert.deepEqual(clean.removed, [names.integration]);
  assert.equal(await isRegistered(root, names.integration), false);
  // …and the branch is still there, holding the commit.
  assert.equal(Number(git(root, 'rev-list', '--count', 'pe/demo')), 2);

  // Uncommitted work IS. `worktree remove --force` would delete it without
  // asking, and nothing anywhere else holds it.
  const dirty = { stateDir, runId: 'r-dirty', slug: 'demo' };
  const second = laneNames({ ...dirty, phase: 0 });
  assert.equal((await ensureIntegration(root, second)).ok, true);
  writeFileSync(join(second.integration, 'unsaved.txt'), 'never committed\n');
  const held = await pruneRunTree(root, dirty);
  assert.deepEqual(held.removed, []);
  assert.deepEqual(held.kept, [second.integration]);
  assert.equal(await isRegistered(root, second.integration), true);
  assert.equal(readFileSync(join(second.integration, 'unsaved.txt'), 'utf8'), 'never committed\n');
});

test('scope confinement follows SYMLINKS — a link out of the root is not inside it', () => {
  const { root } = fixture();
  // A symlink is the one way a token can name a path that passes both a string
  // prefix test and an existence test while being another repository entirely.
  // `docs/vendor -> ../../elsewhere` reads as `<root>/docs/vendor` — plainly
  // inside — and is not.
  const outside = mkdtempSync(join(tmpdir(), 'p6-outside-'));
  trash.push(outside);
  execFileSync('mkdir', ['-p', join(root, 'docs')]);
  execFileSync('ln', ['-s', outside, join(root, 'docs', 'vendor')]);

  assert.equal(existsSync(join(root, 'docs', 'vendor')), true, 'the fixture link is broken');
  assert.equal(scopeConfined(root, ['docs/vendor']), false);

  // …and a link that stays INSIDE is still inside, so the rule is not "refuse
  // every symlink".
  execFileSync('mkdir', ['-p', join(root, 'packages', 'cart-api')]);
  execFileSync('ln', ['-s', join(root, 'packages', 'cart-api'), join(root, 'docs', 'cart')]);
  assert.equal(scopeConfined(root, ['docs/cart']), true);
});

test('a discarded fresh tree goes even when the setup left files in it', async () => {
  const { root, stateDir } = fixture();
  const names = laneNames({ stateDir, runId: 'r-discard', slug: 'demo', phase: 0 });
  assert.equal((await ensureIntegration(root, names)).created, true);

  // Exactly what a failing `npm ci` leaves: files nothing has committed.
  writeFileSync(join(names.integration, 'leftover.txt'), 'half a build\n');
  execFileSync('mkdir', ['-p', join(names.integration, 'junk')]);

  // `pruneRunTree` refuses this, rightly — uncommitted work is unrecoverable.
  const refused = await pruneRunTree(root, { stateDir, runId: 'r-discard', slug: 'demo' });
  assert.deepEqual(refused.kept, [names.integration], 'the dirty-tree rule stopped protecting work');
  assert.equal(await isRegistered(root, names.integration), true);

  // `discardFreshTree` does not, and may not: its caller made the tree seconds
  // ago and no session has been near it.
  const gone = await discardFreshTree(root, names);
  assert.equal(gone.removed, true, gone.detail ?? '');
  assert.equal(await isRegistered(root, names.integration), false);
  assert.equal(existsSync(names.integration), false);
  // The branch survives, as it does everywhere else in this module.
  assert.equal(git(root, 'rev-parse', '--verify', '--quiet', 'pe/demo^{commit}').length > 0, true);
});

test('ensureIntegration says whether it CREATED the tree or adopted one', async () => {
  const { root, stateDir } = fixture();
  const names = laneNames({ stateDir, runId: 'r-created', slug: 'demo', phase: 0 });
  // The flag two callers depend on: the setup command runs only for a tree this
  // call minted, and only such a tree may be force-discarded.
  assert.equal((await ensureIntegration(root, names)).created, true);
  assert.equal((await ensureIntegration(root, names)).created, false);
});

test('a worktree whose directory was deleted still reads as REGISTERED, and is swept', async () => {
  const { root, stateDir } = fixture();
  const names = laneNames({ stateDir, runId: 'r-prunable', slug: 'demo', phase: 0 });
  assert.equal((await ensureIntegration(root, names)).ok, true);

  // `rm -rf` by hand. git keeps the registration and marks it PRUNABLE — the
  // entry is still there, still holding `pe/demo`.
  rmSync(names.integration, { recursive: true, force: true });
  assert.match(git(root, 'worktree', 'list', '--porcelain'), /prunable/,
    'git dropped the registration itself — this test cannot prove anything');

  // 🔴 The bug this pins: `realish` could not resolve a vanished path, so it
  // compared `/var/…` with the `/private/var/…` git prints, and `isRegistered`
  // answered NO about a registration that plainly exists. Both `pruneRun` and
  // `sweepStale` `continue` past a tree they think is unregistered, so the
  // entry — and its hold on `pe/demo` — would have survived every cleanup this
  // module has, for ever.
  assert.equal(await isRegistered(root, names.integration), true);

  // …and because it is seen, it is cleared, and the branch is free again.
  const out = await pruneRunTree(root, { stateDir, runId: 'r-prunable', slug: 'demo' });
  assert.deepEqual(out.kept, []);
  assert.equal(await isRegistered(root, names.integration), false);
  assert.doesNotMatch(git(root, 'worktree', 'list', '--porcelain'), /prunable/);
  // The proof it is really free: it can be checked out again.
  assert.equal((await ensureIntegration(root, names)).created, true);
});

/* ------------------------------------------------------------------ *
 * P9 — the monitoring probe.
 *
 * Same discipline as everything above: real git, no mocks, and every
 * assertion a question put to the repository rather than a claim about
 * what the module returned. The probe's whole value is that it reports
 * facts an operator could otherwise only get by opening four terminals,
 * so a test that stubbed git would be testing the arithmetic and not the
 * facts.
 * ------------------------------------------------------------------ */

test('P9 — the probe reports divergence, changed files, disk and every checkout', async () => {
  const { root, stateDir } = fixture({ 'README.md': 'base\n', 'f.txt': 'a\nb\nc\n' });
  const names = laneNames({ stateDir, runId: 'r-probe', slug: 'demo', phase: 0 });
  assert.equal((await ensureIntegration(root, names)).ok, true);

  commitIn(names.integration, 'f.txt', 'a\nB-from-demo\nc\n', 'demo edits f');
  commitIn(names.integration, 'new.txt', 'only demo has this\n', 'demo adds a file');

  const view = await probeRunGit({
    root, branch: names.runBranch, workRoot: names.integration, stateRoot: stateDir,
  });

  // The base is OBSERVED, not configured: whatever the operator's own checkout
  // is standing on is what everything else is measured against.
  assert.equal(view.base, 'main');
  assert.equal(view.branch, 'pe/demo');
  assert.deepEqual(view.divergence, { ahead: 2, behind: 0 },
    'two commits on the branch, none on main since');
  assert.deepEqual(view.files.sort(), ['f.txt', 'new.txt']);
  assert.equal(view.filesTruncated, false);
  assert.ok((view.disk ?? 0) > 0, `the checkout measured ${view.disk} bytes`);

  // The registry: the operator's own tree, flagged as the root, and ours,
  // flagged as managed — the distinction `du` is allowed to act on.
  const home = view.checkouts.find((entry) => entry.root);
  const ours = view.checkouts.find((entry) => entry.branch === 'pe/demo');
  assert.ok(home, `no root checkout in ${JSON.stringify(view.checkouts)}`);
  assert.equal(home.branch, 'main');
  assert.equal(home.managed, false, "the operator's own tree is not ours to measure");
  assert.ok(ours, 'the run checkout is missing from the registry');
  assert.equal(ours.managed, true);
  assert.ok((ours.disk ?? 0) > 0);

  // And the numbers are git's, not ours: ask it the same question by hand.
  assert.equal(git(root, 'rev-list', '--count', 'main..pe/demo'), '2');
});

test('P9 — divergence counts BOTH ways, and a branch that fell behind says so', async () => {
  const { root, stateDir } = fixture({ 'f.txt': 'a\n' });
  const names = laneNames({ stateDir, runId: 'r-behind', slug: 'demo', phase: 0 });
  assert.equal((await ensureIntegration(root, names)).ok, true);
  commitIn(names.integration, 'f.txt', 'a\nfrom demo\n', 'demo moves');
  // …and the operator commits in their own tree, which is the case a
  // one-directional count gets wrong: the branch is 1 ahead AND 2 behind, and
  // only the pair says whether a merge-back is going to be interesting.
  commitIn(root, 'g.txt', 'main moved\n', 'main moves');
  commitIn(root, 'h.txt', 'main moved again\n', 'main moves again');

  assert.deepEqual(await divergence(root, 'pe/demo', 'main'), { ahead: 1, behind: 2 });
});

test('P9 — the radar tells clean, overlap and conflicted apart, against real merges', async () => {
  // `g.txt` is deliberately LONG. Two edits to one file only merge cleanly
  // when git can see unchanged context between them, so a two-line fixture
  // makes every shared file a conflict and `overlap` unreachable — which is
  // what the first version of this test proved, in red.
  const g = `${Array.from({ length: 21 }, (_, i) => `line ${i}`).join('\n')}\n`;
  const gTop = g.replace('line 0\n', 'line 0 — LEFT\n');
  const gBottom = g.replace('line 20\n', 'line 20 — NEAR\n');
  const { root } = fixture({ 'f.txt': 'a\nb\nc\n', 'g.txt': g });

  // Four branches off one base:
  //   left  — edits line 2 of f.txt, and the TOP of g.txt
  //   right — edits line 2 of f.txt differently        → CONFLICTED with left
  //   near  — edits the BOTTOM of g.txt, not f.txt     → OVERLAP with left
  //   far   — touches a file nobody else does          → CLEAN with everyone
  for (const [branch, files] of [
    ['left', { 'f.txt': 'a\nLEFT\nc\n', 'g.txt': gTop }],
    ['right', { 'f.txt': 'a\nRIGHT\nc\n' }],
    ['near', { 'g.txt': gBottom }],
    ['far', { 'other.txt': 'nobody else\n' }],
  ] as const) {
    git(root, 'branch', branch, 'main');
    const dir = join(root, '..', `wt-${branch}`);
    git(root, 'worktree', 'add', '-q', dir, branch);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', branch);
  }

  const conflicted = await radarPair(root, 'left', 'right');
  assert.equal(conflicted.state, 'conflicted');
  assert.deepEqual(conflicted.files, ['f.txt'], 'the conflicted path, named');

  // 🔴 The verdict that justifies the whole feature. `near` and `left` both
  // changed `g.txt` and git merges them without complaint — so a radar built
  // on merge results alone would say nothing until the day it says
  // "conflicted", which is the day it is too late to serialize the two lanes
  // cheaply. `overlap` is the warning; `conflicted` is the incident.
  const overlap = await radarPair(root, 'left', 'near');
  assert.equal(overlap.state, 'overlap');
  assert.deepEqual(overlap.files, ['g.txt']);
  // …and the proof that it really would merge, which is what makes `overlap`
  // a different fact from `conflicted` rather than a softer word for it.
  assert.equal(
    git(root, 'merge-tree', '--write-tree', '--name-only', 'left', 'near').split('\n').length, 1,
    'merge-tree printed conflicts for a pair the radar called overlap',
  );

  assert.equal((await radarPair(root, 'left', 'far')).state, 'clean');
  assert.deepEqual((await radarPair(root, 'left', 'far')).files, []);

  // Order does not matter: a pair is a question about two branches, not about
  // which one was asked first.
  assert.equal((await radarPair(root, 'right', 'left')).state, 'conflicted');
  assert.equal(pairKey('left', 'right'), pairKey('right', 'left'));
});

test('P9 — the whole-run probe finds the conflicting pair among live checkouts', async () => {
  const { root, stateDir } = fixture({ 'f.txt': 'a\nb\nc\n' });
  const mine = laneNames({ stateDir, runId: 'r-mine', slug: 'mine', phase: 0 });
  assert.equal((await ensureIntegration(root, mine)).ok, true);
  commitIn(mine.integration, 'f.txt', 'a\nMINE\nc\n', 'mine');

  // A second run of a second plan, in its own checkout — the shape P8's
  // carve-out admits alongside the first, and therefore the shape this radar
  // exists to watch.
  const theirs = laneNames({ stateDir, runId: 'r-theirs', slug: 'theirs', phase: 0 });
  assert.equal((await ensureIntegration(root, theirs)).ok, true);
  commitIn(theirs.integration, 'f.txt', 'a\nTHEIRS\nc\n', 'theirs');

  const view = await probeRunGit({
    root, branch: mine.runBranch, workRoot: mine.integration, stateRoot: stateDir,
  });

  const pair = view.radar.find((entry) => pairKey(entry.a, entry.b) === pairKey('pe/mine', 'pe/theirs'));
  assert.ok(pair, `pe/mine × pe/theirs missing from ${JSON.stringify(view.radar)}`);
  assert.equal(pair.state, 'conflicted');
  assert.deepEqual(pair.files, ['f.txt']);
  // Worst first, so a card that shows three rows shows the three that matter.
  assert.equal(view.radar[0].state, 'conflicted');
  // …and the pairs nobody is fighting over are still reported, as `clean`,
  // because "no row" and "nothing wrong" must not look the same.
  assert.ok(view.radar.some((entry) => entry.state === 'clean'),
    `no clean pair reported at all: ${JSON.stringify(view.radar)}`);
});

test('P9 — a probe that cannot run answers `unknown`, never an error', async () => {
  const { root, stateDir } = fixture();

  // A branch that does not exist. Every one of these is a real state — a
  // branch an operator deleted while a run held it — and none is news about
  // the run, which is why the answer is a shrug and not a throw.
  assert.equal(await divergence(root, 'no-such-branch', 'main'), undefined);
  const pair = await radarPair(root, 'no-such-branch', 'main');
  assert.equal(pair.state, 'unknown');
  assert.deepEqual(pair.files, []);

  // A directory that is not there measures nothing rather than failing.
  assert.equal(await treeDisk(join(stateDir, 'nope')), undefined);

  // …and a path that is not a repository at all yields an empty registry,
  // which is what `probeRunGit` then renders as "we do not know".
  assert.deepEqual(await checkouts(stateDir), []);
  const view = await probeRunGit({ root: stateDir, branch: 'pe/demo', stateRoot: stateDir });
  assert.equal(view.base, undefined);
  assert.deepEqual(view.checkouts, []);
  assert.deepEqual(view.radar, []);
  assert.deepEqual(view.files, []);
});

test('P9 — two probes of an unchanged repository compare EQUAL, which is what bounds the journal', async () => {
  const { root, stateDir } = fixture({ 'f.txt': 'a\n' });
  const names = laneNames({ stateDir, runId: 'r-same', slug: 'demo', phase: 0 });
  assert.equal((await ensureIntegration(root, names)).ok, true);
  commitIn(names.integration, 'f.txt', 'a\nb\n', 'demo');

  const opts = { root, branch: names.runBranch, workRoot: names.integration, stateRoot: stateDir };
  const first = await probeRunGit(opts);
  const second = await probeRunGit(opts);

  // 🔴 `at` differs by construction — it is the probe's own clock — so a naive
  // deep-equal would call every tick news and the five-minute timer would
  // become a five-minute event. `sameGitFacts` is the predicate the runner
  // emits on, and this is the assertion that it excludes the one field that
  // always moves and nothing else.
  assert.notEqual(first.at, second.at, 'the two probes are the same object — this proves nothing');
  assert.equal(sameGitFacts(first, second), true);

  // …and that it is not simply always true: a commit is a change.
  commitIn(names.integration, 'f.txt', 'a\nb\nc\n', 'demo again');
  assert.equal(sameGitFacts(first, await probeRunGit(opts)), false);
  assert.equal(sameGitFacts(null, first), false);
  assert.equal(sameGitFacts(null, null), true);
});

/* ------------------------------------------------------------------ *
 * P12 — the `integration` settle strategy: a finished RUN branch folded
 * into the console's own staging tree, with no remote anywhere near it.
 * ------------------------------------------------------------------ */

test('P12 — an integration settle merges the run branch into the console staging tree', async () => {
  const { root, stateDir } = fixture();
  const names = laneNames({ stateDir, runId: 'run1', slug: 'demo', phase: 1 });
  // Give the run a branch with work on it, the way a finished run has one.
  assert.equal((await ensureIntegration(root, names)).ok, true);
  commitIn(names.integration, 'work.txt', 'the run did this\n', 'phase 1');

  const staging = stagingNames(join(stateDir, 'console'));
  const landed = await landIntegration(root, { branch: names.runBranch, staging });

  assert.equal(landed.kind, 'merged');
  assert.equal((landed as { commits: number }).commits, 1);
  assert.ok(contains(root, staging.branch, names.runBranch),
    'the staging branch must contain the run branch');
  assert.equal(readFileSync(join(staging.dir, 'work.txt'), 'utf8'), 'the run did this\n');

  // The operator's own checkout is untouched — the same property the lane
  // merges have, and for the same reason.
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(contains(root, 'main', names.runBranch), false, 'main must not have moved');
});

test('P12 — a second plan settles into the SAME staging tree, which is why it is console-wide', async () => {
  const { root, stateDir } = fixture();
  const consoleDir = join(stateDir, 'console');
  const staging = stagingNames(consoleDir);
  // Two plans, two run branches, one staging checkout. A per-plan staging
  // directory would fail here: git allows a branch exactly one working tree.
  const alpha = laneNames({ stateDir, runId: 'r1', slug: 'alpha', phase: 1 });
  const beta = laneNames({ stateDir, runId: 'r2', slug: 'beta', phase: 1 });
  assert.equal((await ensureIntegration(root, alpha)).ok, true);
  assert.equal((await ensureIntegration(root, beta)).ok, true);
  commitIn(alpha.integration, 'alpha.txt', 'alpha\n', 'alpha work');
  commitIn(beta.integration, 'beta.txt', 'beta\n', 'beta work');

  assert.equal((await landIntegration(root, { branch: alpha.runBranch, staging })).kind, 'merged');
  assert.equal((await landIntegration(root, { branch: beta.runBranch, staging })).kind, 'merged');

  assert.ok(contains(root, staging.branch, alpha.runBranch));
  assert.ok(contains(root, staging.branch, beta.runBranch));
  assert.equal(stagingNames(consoleDir).dir, staging.dir, 'the path is a pure function of the console dir');
});

test('P12 — an integration settle of a branch already staged reports `empty`, not a merge', async () => {
  const { root, stateDir } = fixture();
  const names = laneNames({ stateDir, runId: 'run1', slug: 'demo', phase: 1 });
  assert.equal((await ensureIntegration(root, names)).ok, true);
  commitIn(names.integration, 'work.txt', 'once\n', 'phase 1');
  const staging = stagingNames(join(stateDir, 'console'));

  assert.equal((await landIntegration(root, { branch: names.runBranch, staging })).kind, 'merged');
  // A resumed run that settles a second time must not make an empty merge
  // commit on the staging branch.
  const at = git(root, 'rev-parse', staging.branch);
  assert.deepEqual(await landIntegration(root, { branch: names.runBranch, staging }), { kind: 'empty' });
  assert.equal(git(root, 'rev-parse', staging.branch), at, 'the staging branch must not have moved');
});

test('P12 — a conflicting integration settle ABORTS and every commit survives', async () => {
  const { root, stateDir } = fixture({ 'shared.txt': 'base\n' });
  const staging = stagingNames(join(stateDir, 'console'));
  const alpha = laneNames({ stateDir, runId: 'r1', slug: 'alpha', phase: 1 });
  const beta = laneNames({ stateDir, runId: 'r2', slug: 'beta', phase: 1 });
  assert.equal((await ensureIntegration(root, alpha)).ok, true);
  assert.equal((await ensureIntegration(root, beta)).ok, true);
  commitIn(alpha.integration, 'shared.txt', 'alpha wrote this\n', 'alpha');
  commitIn(beta.integration, 'shared.txt', 'beta wrote this\n', 'beta');

  assert.equal((await landIntegration(root, { branch: alpha.runBranch, staging })).kind, 'merged');
  const clash = await landIntegration(root, { branch: beta.runBranch, staging });

  assert.equal(clash.kind, 'conflict');
  assert.deepEqual((clash as { files: string[] }).files, ['shared.txt']);
  // NOTHING LOST, and the staging tree is not left mid-merge — the next plan's
  // settle must not fail for a reason that belongs to this one.
  assert.equal(git(staging.dir, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(beta.integration, 'shared.txt'), 'utf8'), 'beta wrote this\n');
  assert.ok(git(root, 'rev-parse', '--verify', beta.runBranch).length > 0);
});

test('P12 — an integration settle of a branch that does not exist FAILS, and creates nothing', async () => {
  const { root, stateDir } = fixture();
  const staging = stagingNames(join(stateDir, 'console'));
  const before = git(root, 'worktree', 'list');

  const out = await landIntegration(root, { branch: 'pe/never-was', staging });

  assert.equal(out.kind, 'failed');
  assert.match((out as { detail: string }).detail, /pe\/never-was/);
  assert.equal(git(root, 'worktree', 'list'), before, 'a failure must not mint a staging tree');
  assert.equal(existsSync(staging.dir), false);
});

/* ------------------------------------------------------------------ *
 * The mirror — a superproject run's checkout, one worktree per scoped
 * sub-repository. Real nested submodules, real git, no mocks: `repo`
 * holds `web` and `lib` (declared, deinitialized), plus `app`, itself a
 * superproject holding `core` and `ui`. Two levels, like life.
 * ------------------------------------------------------------------ */

/** A two-level superproject with one uninitialized submodule. */
function superFixture(): { root: string; stateDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'p22-mirror-'));
  trash.push(base);
  const stateDir = join(base, 'state');
  execFileSync('mkdir', ['-p', stateDir]);

  const src = (name: string, files: Record<string, string>): string => {
    const dir = join(base, `${name}-src`);
    execFileSync('mkdir', ['-p', dir]);
    git(dir, 'init', '-q', '-b', 'main');
    for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    return dir;
  };
  const web = src('web', { 'index.html': 'web\n' });
  const core = src('core', { 'core.txt': 'core\n' });
  const ui = src('ui', { 'ui.txt': 'ui\n' });
  const lib = src('lib', { 'lib.txt': 'lib\n' });
  const app = src('app', { 'app.txt': 'app\n' });
  git(app, '-c', 'protocol.file.allow=always', 'submodule', 'add', core, 'core');
  git(app, '-c', 'protocol.file.allow=always', 'submodule', 'add', ui, 'ui');
  git(app, 'commit', '-q', '-m', 'submodules');

  const root = join(base, 'repo');
  execFileSync('mkdir', ['-p', join(root, 'docs')]);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'root\n');
  writeFileSync(join(root, 'docs', 'notes.md'), 'notes\n');
  git(root, 'add', '-A');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', web, 'web');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', app, 'app');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', lib, 'lib');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive');
  git(root, 'submodule', 'deinit', '-f', 'lib');
  return { root, stateDir };
}

/** Registered worktrees of a repository, as a count. */
function worktreeCount(repo: string): number {
  return git(repo, 'worktree', 'list', '--porcelain')
    .split('\n').filter((line) => line.startsWith('worktree ')).length;
}

test('mounts: a token mounts its containing repository, and a mounted superproject expands to its initialized submodules', async () => {
  const { root } = superFixture();

  const one = await resolveMounts(root, ['web']);
  assert.equal(one.ok, true);
  assert.deepEqual((one as { mounts: { rel: string }[] }).mounts.map((m) => m.rel), ['web']);

  const child = await resolveMounts(root, ['app/core']);
  assert.equal(child.ok, true);
  assert.deepEqual((child as { mounts: { rel: string }[] }).mounts.map((m) => m.rel), ['app/core'],
    'a child token mounts the child alone, not its superproject');

  const expanded = await resolveMounts(root, ['app', 'web']);
  assert.equal(expanded.ok, true);
  const shape = expanded as { mounts: { rel: string }[]; skipped: string[] };
  assert.deepEqual(shape.mounts.map((m) => m.rel), ['app', 'web', 'app/core', 'app/ui'],
    'parents first, then the initialized children of a mounted superproject');
  assert.deepEqual(shape.skipped, []);
  assert.deepEqual(parseGitmodulesPaths(root).sort(), ['app', 'lib', 'web']);
});

test('mounts: the root, `all`, and a plain directory MOUNT the root and expand into it; nothing on disk and an uninitialized submodule refuse scope-unmapped', async () => {
  const { root } = superFixture();

  // The class this closes: one root-meaning token in one phase of a
  // monorepo-of-submodules plan used to refuse the WHOLE run's isolation.
  for (const token of ['all', 'docs', root.split('/').pop()!]) {
    const out = await resolveMounts(root, [token]);
    assert.equal(out.ok, true, `\`${token}\` must mount, not refuse`);
    const shape = out as { mounts: { rel: string }[]; skipped: string[] };
    assert.deepEqual(shape.mounts.map((m) => m.rel), ['', 'app', 'web', 'app/core', 'app/ui'],
      `\`${token}\`: the root first, then its initialized submodules, parents before children`);
    assert.deepEqual(shape.skipped, ['lib'],
      'the deinit\'d submodule is NAMED, never left an empty directory pretending');
  }

  // The root beside an explicit submodule is one mount, not two.
  const both = await resolveMounts(root, [root.split('/').pop()!, 'web']);
  assert.equal(both.ok, true);
  assert.equal((both as { mounts: { rel: string }[] }).mounts.filter((m) => m.rel === 'web').length, 1,
    'a repository named twice mounts once');

  const missing = await resolveMounts(root, ['nope']);
  assert.equal(missing.ok, false);
  assert.equal((missing as { refusal: string }).refusal, 'scope-unmapped');

  const uninit = await resolveMounts(root, ['lib']);
  assert.equal(uninit.ok, false);
  assert.equal((uninit as { refusal: string }).refusal, 'scope-unmapped');
  assert.match((uninit as { detail: string }).detail, /git submodule update --init lib/,
    'the refusal carries the command that fixes it');
});

test('mounts: an uninitialized child of a mounted superproject is SKIPPED and named, never left an empty directory pretending', async () => {
  const { root } = superFixture();
  git(join(root, 'app'), 'submodule', 'deinit', '-f', 'ui');

  const out = await resolveMounts(root, ['app']);
  assert.equal(out.ok, true);
  const shape = out as { mounts: { rel: string }[]; skipped: string[] };
  assert.deepEqual(shape.mounts.map((m) => m.rel), ['app', 'app/core']);
  assert.deepEqual(shape.skipped, ['app/ui']);
});

test('the mirror builds every mount on the run branch, writes its manifest LAST, adopts on re-run, and never touches the superproject', async () => {
  const { root, stateDir } = superFixture();
  const names = laneNames({ stateDir, runId: 'r1', slug: 'demo', phase: 0 });
  const res = await resolveMounts(root, ['app', 'web']);
  assert.equal(res.ok, true);
  const mounts = (res as { mounts: { rel: string; source: string }[] }).mounts;

  const made = await ensureMirror({ names, runId: 'r1', slug: 'demo', mounts });
  assert.equal(made.ok, true, made.detail);
  assert.deepEqual([...made.created].sort(), ['app', 'app/core', 'app/ui', 'web']);

  for (const mount of mounts) {
    const dir = join(names.integration, mount.rel);
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo',
      `${mount.rel} stands on the run branch`);
  }
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the root checkout is never switched');
  assert.equal(worktreeCount(root), 1, 'no worktree of the superproject itself exists');

  const manifest = await readMirror(names.integration);
  assert.ok(manifest, 'the manifest is there once the build completed');
  assert.equal(manifest!.branch, 'pe/demo');
  assert.deepEqual(manifest!.mounts.map((m) => m.rel), ['app', 'web', 'app/core', 'app/ui']);

  const again = await ensureMirror({ names, runId: 'r1', slug: 'demo', mounts });
  assert.equal(again.ok, true);
  assert.deepEqual(again.created, [], 'a standing mirror is adopted, not rebuilt');
  assert.deepEqual([...again.adopted].sort(), ['app', 'app/core', 'app/ui', 'web']);

  assert.equal(await validateMirror(names.integration, 'pe/demo'), true);
  assert.equal(await validateMirror(names.integration, 'pe/other'), false,
    'a mirror on another branch is not this run\'s mirror');
});

test('a branch held in one sub-repository refuses branch-in-use, NAMES the repository, and tears down what this call minted', async () => {
  const { root, stateDir } = superFixture();
  git(join(root, 'web'), 'switch', '-q', '-c', 'pe/demo');
  const names = laneNames({ stateDir, runId: 'r1', slug: 'demo', phase: 0 });
  const res = await resolveMounts(root, ['app', 'web']);
  const mounts = (res as { mounts: { rel: string; source: string }[] }).mounts;

  const made = await ensureMirror({ names, runId: 'r1', slug: 'demo', mounts });
  assert.equal(made.ok, false);
  assert.equal(made.refusal, 'branch-in-use');
  assert.match(made.detail ?? '', /^web: /, 'the refusal names WHICH repository holds the branch');
  assert.equal(existsSync(names.integration), false, 'nothing this call minted survives the refusal');
  assert.equal(worktreeCount(join(root, 'app')), 1, 'the app mount created before the failure is discarded');
});

test('pruneMirror removes clean mounts deepest-first — gitlink drift is not dirt — and the committed work survives on the branch', async () => {
  const { root, stateDir } = superFixture();
  const names = laneNames({ stateDir, runId: 'r1', slug: 'demo', phase: 0 });
  const res = await resolveMounts(root, ['app', 'web']);
  const mounts = (res as { mounts: { rel: string; source: string }[] }).mounts;
  const made = await ensureMirror({ names, runId: 'r1', slug: 'demo', mounts });
  assert.equal(made.ok, true, made.detail);

  // A commit in a child moves the parent's recorded gitlink — which is NOT dirt.
  commitIn(join(names.integration, 'app', 'core'), 'core.txt', 'v2\n', 'work');

  const pruned = await pruneMirror({ integration: names.integration, mounts });
  assert.deepEqual(pruned.kept, []);
  assert.equal(existsSync(names.integration), false, 'an empty mirror is gone entirely');
  assert.equal(worktreeCount(join(root, 'app')), 1);
  assert.equal(worktreeCount(join(root, 'app', 'core')), 1);
  assert.equal(git(join(root, 'app', 'core'), 'rev-list', '--count', 'main..pe/demo'), '1',
    'the committed work is on the branch, which a prune never deletes');
});

test('pruneMirror keeps a dirty mount AND the superproject mount that contains it — force-removing the parent would delete the work', async () => {
  const { root, stateDir } = superFixture();
  const names = laneNames({ stateDir, runId: 'r2', slug: 'demo', phase: 0 });
  const res = await resolveMounts(root, ['app', 'web']);
  const mounts = (res as { mounts: { rel: string; source: string }[] }).mounts;
  const made = await ensureMirror({ names, runId: 'r2', slug: 'demo', mounts });
  assert.equal(made.ok, true, made.detail);
  writeFileSync(join(names.integration, 'app', 'core', 'wip.txt'), 'uncommitted\n');

  const pruned = await pruneMirror({ integration: names.integration, mounts });
  assert.ok(pruned.kept.some((k) => k.endsWith(join('app', 'core'))), 'the dirty mount is kept');
  assert.ok(pruned.kept.some((k) => k.endsWith(`${sep}app`)), 'and so is the superproject that contains it');
  assert.ok(pruned.removed.some((k) => k.endsWith(`${sep}web`)), 'an unrelated clean mount still goes');
  assert.equal(readFileSync(join(names.integration, 'app', 'core', 'wip.txt'), 'utf8'), 'uncommitted\n',
    'the uncommitted work is exactly where it was');
});

test('the sweep clears a dead run\'s mirror — manifest or crash shape alike — and pruneRun\'s terminal never deletes a dirty one', async () => {
  const { root, stateDir } = superFixture();

  // A complete mirror whose run is over: swept away, run directory included.
  const a = laneNames({ stateDir, runId: 'r-done', slug: 'demo', phase: 0 });
  const resA = await resolveMounts(root, ['web']);
  const mountsA = (resA as { mounts: { rel: string; source: string }[] }).mounts;
  assert.equal((await ensureMirror({ names: a, runId: 'r-done', slug: 'demo', mounts: mountsA })).ok, true);
  const sweep1 = await sweepStale(root, { stateDir, slug: 'demo', liveRunIds: [] });
  assert.ok(sweep1.removed.some((k) => k.endsWith(`${sep}web`)));
  assert.ok(sweep1.runs.includes('r-done'), 'the run directory is gone entirely');
  assert.equal(worktreeCount(join(root, 'web')), 1);

  // The crash shape: checkouts, no manifest. Detected by walk, swept the same.
  const b = laneNames({ stateDir, runId: 'r-crash', slug: 'demo', phase: 0 });
  const resB = await resolveMounts(root, ['app/core']);
  const mountsB = (resB as { mounts: { rel: string; source: string }[] }).mounts;
  assert.equal((await ensureMirror({ names: b, runId: 'r-crash', slug: 'demo', mounts: mountsB })).ok, true);
  rmSync(mirrorManifestPath(b.integration));
  assert.deepEqual((await detectMirror(b.integration)).map((m) => m.rel), ['app/core'],
    'the walk finds the manifest-less mount and its source');
  const sweep2 = await sweepStale(root, { stateDir, slug: 'demo', liveRunIds: [] });
  assert.ok(sweep2.runs.includes('r-crash'));
  assert.equal(worktreeCount(join(root, 'app', 'core')), 1);

  // A DIRTY mirror meets pruneRun: kept, named, and the terminal rm never fires.
  const c = laneNames({ stateDir, runId: 'r-dirty', slug: 'demo', phase: 0 });
  const resC = await resolveMounts(root, ['web']);
  const mountsC = (resC as { mounts: { rel: string; source: string }[] }).mounts;
  assert.equal((await ensureMirror({ names: c, runId: 'r-dirty', slug: 'demo', mounts: mountsC })).ok, true);
  writeFileSync(join(c.integration, 'web', 'wip.txt'), 'uncommitted\n');
  const prunedC = await pruneRun(root, { stateDir, runId: 'r-dirty', slug: 'demo', phases: [] });
  assert.ok(prunedC.kept.some((k) => k.endsWith(`${sep}web`)), 'pruneRun keeps the dirty mount');
  assert.equal(existsSync(join(c.integration, 'web', 'wip.txt')), true,
    'the run directory terminal did NOT fire over a kept mirror');
  const treeC = await pruneRunTree(root, { stateDir, runId: 'r-dirty', slug: 'demo' });
  assert.ok(treeC.kept.some((k) => k.endsWith(`${sep}web`)), 'pruneRunTree diverts to the mirror rule too');
});

test('the ROOT mount: a superproject mirror stands, validates, and prunes — and the manifest never dirties it', async () => {
  const { root, stateDir } = superFixture();
  const names = laneNames({ stateDir, runId: 'r-root', slug: 'demo', phase: 0 });

  const res = await resolveMounts(root, [root.split('/').pop()!]);
  assert.equal(res.ok, true);
  const mounts = (res as { mounts: { rel: string; source: string }[] }).mounts;
  assert.equal(mounts[0]?.rel, '', 'the root mounts first — git refuses to add a worktree over a non-empty dir');

  const made = await ensureMirror({ names, runId: 'r-root', slug: 'demo', mounts });
  assert.equal(made.ok, true, made.detail ?? 'the rooted mirror must build');

  // The point of the root mount: the submodule directories a linked worktree
  // of a superproject leaves EMPTY are real checkouts.
  assert.equal(existsSync(join(names.integration, 'README.md')), true, 'the root tree is checked out');
  assert.equal(existsSync(join(names.integration, 'web', 'index.html')), true, 'and so is a submodule under it');
  assert.equal(existsSync(join(names.integration, 'app', 'core', 'core.txt')), true, 'recursively');
  assert.equal(await holdsBranch(root, names.integration, names.runBranch), true,
    'the root mount stands on the run branch, like every other mount');
  assert.equal(await validateMirror(names.integration, names.runBranch), true);

  // 🔴 The regression the manifest move exists for: an untracked console file
  // inside the root mount makes it permanently dirty, and `pruneMirror` keeps
  // a dirty tree — so the mirror, and its hold on `pe/demo`, would be forever.
  assert.equal(existsSync(join(names.integration, '.pe-mirror.json')), false,
    'the manifest lives BESIDE the mirror, never inside a repository it borrows');
  assert.equal(existsSync(mirrorManifestPath(names.integration)), true);

  const pruned = await pruneMirror({ integration: names.integration, mounts });
  assert.deepEqual(pruned.kept, [], 'a clean rooted mirror is removed whole');
  assert.equal(existsSync(names.integration), false);
  assert.equal(existsSync(mirrorManifestPath(names.integration)), false, 'and its manifest goes with it');
  assert.equal(worktreeCount(root), 1, 'the operator\'s own checkout is the only one left');
  assert.equal(worktreeCount(join(root, 'web')), 1);
  assert.equal(worktreeCount(join(root, 'app', 'core')), 1);
});

test('the ROOT mount: a manifest-less rooted mirror is still recognised as one, not as a single-repo checkout', async () => {
  const { root, stateDir } = superFixture();
  const names = laneNames({ stateDir, runId: 'r-root-crash', slug: 'demo', phase: 0 });
  const res = await resolveMounts(root, [root.split('/').pop()!]);
  const mounts = (res as { mounts: { rel: string; source: string }[] }).mounts;
  assert.equal((await ensureMirror({ names, runId: 'r-root-crash', slug: 'demo', mounts })).ok, true);

  // The crash shape. `integration/` is now a REGISTERED worktree of the root,
  // which used to be proof of the single-repo shape; what tells them apart is
  // what is nested under it.
  rmSync(mirrorManifestPath(names.integration));
  const swept = await sweepStale(root, { stateDir, slug: 'demo', liveRunIds: [] });
  assert.ok(swept.runs.includes('r-root-crash'), 'the rooted mirror is swept, not stranded');
  assert.equal(worktreeCount(root), 1);
  assert.equal(worktreeCount(join(root, 'app', 'ui')), 1);
});

/* ------------------------------------------------------------------ *
 * The preview — what the checkbox would DO, answered without doing it.
 * Untested at 3.4.0, and it showed: the live answer said "mirror, three
 * mounts" while every actual decide refused `branch-in-use`.
 * ------------------------------------------------------------------ */

test('preview: a plain repository answers checkout — and a held run branch answers branch-in-use by path', async () => {
  const { root } = fixture();
  execFileSync('mkdir', ['-p', join(root, 'docs')]);
  const free = await previewIsolation(root, 'plain-slug', new Set(['docs']));
  assert.deepEqual(free, { available: true, kind: 'checkout', multiRepo: false });

  git(root, 'worktree', 'add', '-q', '-b', 'pe/plain-slug', join(root, '..', 'held'));
  const held = await previewIsolation(root, 'plain-slug', new Set(['docs']));
  assert.equal(held.available, false);
  assert.equal(held.kind, 'checkout');
  assert.equal(held.refusal, 'branch-in-use');
  assert.match(held.detail ?? '', /pe\/plain-slug is already checked out at/);
});

test('preview: a superproject answers mirror with its mounts — and a source holding the run branch answers branch-in-use naming the repo', async () => {
  const { root } = superFixture();
  const scopes = new Set(['app', 'web']);
  const free = await previewIsolation(root, 'demo-slug', scopes);
  assert.equal(free.available, true);
  assert.equal(free.kind, 'mirror');
  assert.equal(free.multiRepo, true);
  assert.deepEqual(free.mounts, ['app', 'web', 'app/core', 'app/ui']);

  // The shared checkout squats on the run branch — the live incident's shape.
  git(join(root, 'web'), 'checkout', '-q', '-b', 'pe/demo-slug');
  const held = await previewIsolation(root, 'demo-slug', scopes);
  assert.equal(held.available, false);
  assert.equal(held.kind, 'mirror');
  assert.equal(held.refusal, 'branch-in-use');
  assert.match(held.detail ?? '', /^web: pe\/demo-slug is already checked out at/);
  assert.deepEqual(held.mounts, ['app', 'web', 'app/core', 'app/ui'],
    'the refusal still names the shape it would have built');
});

test('preview: a mount refusal passes through by name', async () => {
  const { root } = superFixture();
  const out = await previewIsolation(root, 'demo-slug', new Set(['lib']));
  assert.equal(out.available, false);
  assert.equal(out.refusal, 'scope-unmapped');
  assert.match(out.detail ?? '', /git submodule update --init lib/);
});


/* ================================================================== *
 * P6 — two plans on one repository.
 *
 * The reclaim, the detached shape, the hygiene sweeps and the branch
 * deletion, each against a real repository. Every assertion is a `git`
 * read of what happened, never a claim about what the module returned.
 * ================================================================== */

/** A fixture whose root is CHECKED OUT on `pe/<slug>` — the wedge itself. */
function heldFixture(slug = 'demo'): { root: string; stateDir: string; branch: string } {
  const { root, stateDir } = fixture();
  const branch = `pe/${slug}`;
  git(root, 'switch', '-q', '-c', branch);
  return { root, stateDir, branch };
}

test('defaultBranchOf: origin/HEAD wins, then main, then master, then nothing', async () => {
  const { root } = fixture();
  // No `origin` at all — the ordinary case for a fixture, and for any
  // repository not made by `clone`. The fallbacks answer.
  assert.equal(await defaultBranchOf(root), 'main');

  // `master` when that is the only one that exists.
  git(root, 'branch', '-m', 'main', 'master');
  assert.equal(await defaultBranchOf(root), 'master');

  // And a repository with neither gets `undefined` rather than a guess — the
  // caller is about to MOVE a working tree onto the answer, so a name that
  // resolves to nothing would turn a reclaim into a `git switch` failure.
  git(root, 'branch', '-m', 'master', 'trunk');
  assert.equal(await defaultBranchOf(root), undefined);

  // …and `origin/HEAD` outranks the lot when the repository states it, because
  // it is what the repository SAYS rather than what a list of names guesses.
  git(root, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
  git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  assert.equal(await defaultBranchOf(root), 'trunk');
});

test('reclaim: a CLEAN checkout on the run branch is switched to the default', async () => {
  const { root, branch } = heldFixture();
  const result = await reclaimBranch({ root, held: root, branch, allowed: [root] });

  assert.equal(result.kind, 'reclaimed');
  // Ask GIT, not the return value: the tree is on `main` now…
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  // …and the branch still EXISTS, exactly where it was. A reclaim frees a
  // working tree; it never deletes work.
  assert.equal(git(root, 'rev-parse', '--verify', branch), git(root, 'rev-parse', 'main'));
});

test('reclaim: a DIRTY checkout is refused and names its paths', async () => {
  const { root, branch } = heldFixture();
  writeFileSync(join(root, 'scratch.txt'), 'a session was here\n');

  const result = await reclaimBranch({ root, held: root, branch, allowed: [root] });
  assert.equal(result.kind, 'dirty');
  assert.ok(result.kind === 'dirty' && result.paths.includes('scratch.txt'),
    `the refusal must name the file that stopped it: ${JSON.stringify(result)}`);
  // Untouched — the whole point. `diff` cannot see an untracked file, which is
  // exactly what a killed session leaves, so the check is `status --porcelain`.
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), branch);
  assert.ok(existsSync(join(root, 'scratch.txt')));
});

test('reclaim: a tree the caller did not name is FOREIGN and never moved', async () => {
  const { root, stateDir, branch } = heldFixture();
  // `allowed` is the console's entitlement: the run root, and a mirror's mount
  // sources. Anything else is somebody else's checkout.
  const result = await reclaimBranch({
    root, held: root, branch, allowed: [join(stateDir, 'somewhere-else')],
  });
  assert.equal(result.kind, 'foreign');
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), branch);
});

test('reclaim: dryRun answers the same question and moves nothing', async () => {
  const { root, branch } = heldFixture();
  const dry = await reclaimBranch({ root, held: root, branch, allowed: [root], dryRun: true });
  assert.equal(dry.kind, 'reclaimed');
  // The preflight and the decide must not have two implementations of "would
  // this be reclaimed" — that dishonesty is what `previewIsolation` exists to
  // end. Same verdict; nothing moved.
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), branch);
});

test('the isolation preflight says it will reclaim, and refuses a dirty tree', async () => {
  const { root, branch } = heldFixture();
  const willReclaim = await previewIsolation(root, 'demo', new Set(['.']));
  assert.equal(willReclaim.available, true, JSON.stringify(willReclaim));
  assert.deepEqual(willReclaim.reclaims?.map((path) => path.endsWith('repo')), [true]);

  // …and with the pref off it is the refusal it always was.
  const off = await previewIsolation(root, 'demo', new Set(['.']), 'never');
  assert.equal(off.available, false);
  assert.equal(off.refusal, 'branch-in-use');

  writeFileSync(join(root, 'scratch.txt'), 'work\n');
  const dirty = await previewIsolation(root, 'demo', new Set(['.']));
  assert.equal(dirty.available, false);
  assert.match(String(dirty.detail), /scratch\.txt/);
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), branch);
});

test('a detached checkout owns no branch, and is adopted when it stands at the commit', async () => {
  const { root, stateDir } = fixture();
  const dir = join(stateDir, 'detached');
  const head = await commitOf(root, 'main');

  const made = await ensureDetachedIntegration(root, dir, head);
  assert.equal(made.ok, true, made.detail);
  assert.equal(made.created, true);
  assert.equal(await isRegistered(root, dir), true);
  // The whole point: NO branch. `branchAt` says so, and git agrees.
  assert.equal(await branchAt(root, dir), undefined);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);

  // Idempotent — the second call adopts rather than rebuilding, which is what
  // lets the drive preamble re-run on every resume.
  const again = await ensureDetachedIntegration(root, dir, head);
  assert.equal(again.ok, true);
  assert.equal(again.created, false);

  // …and a run branch may exist and be checked out ELSEWHERE at the same time,
  // which is the situation the shape exists for.
  git(root, 'switch', '-q', '-c', 'pe/demo');
  const beside = await ensureDetachedIntegration(root, join(stateDir, 'beside'), head);
  assert.equal(beside.ok, true, beside.detail);
});

/** Move `root`'s trunk forward by one commit and return the new head. */
async function advanceTrunk(root: string, name = 'second.txt'): Promise<string> {
  writeFileSync(join(root, name), 'more\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', name);
  return commitOf(root, 'main');
}

test('a detached checkout at the WRONG commit is MOVED, and the directory survives', async () => {
  const { root, stateDir } = fixture();
  const dir = join(stateDir, 'detached');
  await ensureDetachedIntegration(root, dir, await commitOf(root, 'main'));
  const second = await advanceTrunk(root);

  const made = await ensureDetachedIntegration(root, dir, second);
  assert.equal(made.ok, true, made.detail);
  // 🔴 `created: false` — the tree is the SAME directory, moved. It used to
  // read `true`, because the first cut `worktree remove --force`d the tree and
  // built a new one. A setup command must not run again over a prepared
  // checkout either, which is the other half of what this word means.
  assert.equal(made.created, false, 'a tree at the wrong commit is moved, never rebuilt');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), second);
  assert.equal(await branchAt(root, dir), undefined, 'and it still owns no branch');
});

test('a DIRTY detached checkout is refused, not destroyed — the trunk moving is not a licence', async () => {
  // 🔴 THE regression. This path runs on every drive whose trunk has moved,
  // and the first cut reached `worktree remove --force` here: a session's
  // uncommitted edits AND its untracked files went, with no commit required
  // and nothing said. The branch shape refuses in the identical situation.
  const { root, stateDir } = fixture();
  const dir = join(stateDir, 'detached');
  await ensureDetachedIntegration(root, dir, await commitOf(root, 'main'));

  writeFileSync(join(dir, 'work-in-progress.txt'), 'a session was here\n');
  writeFileSync(join(dir, 'README.md'), 'edited\n');
  const second = await advanceTrunk(root);

  const made = await ensureDetachedIntegration(root, dir, second);
  assert.equal(made.ok, false, 'a tree holding work must be refused');
  assert.match(String(made.detail), /work-in-progress\.txt/);
  // Everything is still there. This is the assertion the phase exists for.
  assert.ok(existsSync(join(dir, 'work-in-progress.txt')), 'the untracked file survived');
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'edited\n');
  assert.equal(await isRegistered(root, dir), true, 'the checkout is still registered');
});

test('a detached checkout holding commits on NO branch is refused', async () => {
  // Clean, so the dirty guard says nothing — but its HEAD is reachable from
  // no ref, and moving away would leave those commits in the reflog and
  // nowhere a person looks.
  const { root, stateDir } = fixture();
  const dir = join(stateDir, 'detached');
  await ensureDetachedIntegration(root, dir, await commitOf(root, 'main'));
  commitIn(dir, 'session-work.txt', 'committed by a session\n', 'session work');
  const orphan = git(dir, 'rev-parse', 'HEAD');
  const second = await advanceTrunk(root);

  const made = await ensureDetachedIntegration(root, dir, second);
  assert.equal(made.ok, false, 'commits on no branch must not be moved away from');
  assert.match(String(made.detail), /on no branch/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), orphan, 'the tree did not move');
  assert.ok(existsSync(join(dir, 'session-work.txt')));
});

test('holdsDetached is what a detached run asks instead of holdsBranch', async () => {
  // The run preamble's probe. `holdsBranch` can never be true of a tree that
  // owns no branch, so a preamble asking only that concluded on EVERY drive
  // that the run held nothing — which is how the destructive path above came
  // to be reachable at all.
  const { root, stateDir } = fixture();
  const detached = join(stateDir, 'detached');
  await ensureDetachedIntegration(root, detached, await commitOf(root, 'main'));
  assert.equal(await holdsDetached(root, detached), true);
  assert.equal(await holdsBranch(root, detached, 'main'), false,
    'the probe that was being used cannot answer for this shape');

  const onBranch = join(stateDir, 'on-branch');
  git(root, 'worktree', 'add', '-q', '-b', 'pe/x', onBranch, 'main');
  assert.equal(await holdsDetached(root, onBranch), false, 'a tree on a branch is not detached');
  assert.equal(await holdsDetached(root, join(stateDir, 'nothing-here')), false);
});

test('reclaim refuses to clobber an IGNORED file the target branch tracks', async () => {
  // git refuses to overwrite an untracked file and silently overwrites an
  // ignored one, so a `.env` gitignored here and committed on the trunk went
  // with no message at all.
  const { root } = fixture();
  writeFileSync(join(root, '.env'), 'TRUNK=1\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'trunk tracks .env');

  git(root, 'switch', '-q', '-c', 'pe/demo');
  git(root, 'rm', '-q', '--cached', '.env');
  writeFileSync(join(root, '.gitignore'), '.env\n');
  writeFileSync(join(root, '.env'), 'MINE=secret\n');
  git(root, 'add', '.gitignore');
  git(root, 'commit', '-q', '-m', 'ignore it here');

  const result = await reclaimBranch({ root, held: root, branch: 'pe/demo', allowed: [root] });
  assert.equal(result.kind, 'dirty', `switching would have overwritten it: ${JSON.stringify(result)}`);
  assert.ok(result.kind === 'dirty' && result.paths.includes('.env'));
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'MINE=secret\n', 'the file is untouched');
});

test('reclaim sees an untracked file even where status is configured not to show one', async () => {
  const { root } = fixture();
  git(root, 'switch', '-q', '-c', 'pe/demo');
  // The config that made the porcelain silent about exactly the class this
  // check exists for.
  git(root, 'config', 'status.showUntrackedFiles', 'no');
  writeFileSync(join(root, 'scratch.txt'), 'a session was here\n');

  const result = await reclaimBranch({ root, held: root, branch: 'pe/demo', allowed: [root] });
  assert.equal(result.kind, 'dirty', 'the flag must be stated, not left to the caller\'s config');
  assert.ok(result.kind === 'dirty' && result.paths.includes('scratch.txt'));
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo');
});

test('runBranches does not eat a plan whose slug it merely PREFIXES', async () => {
  // `pe/state-path-*` matches `pe/state-path-hardening`, a different plan's
  // branch — and this list feeds a DELETE.
  const { root } = fixture();
  for (const branch of ['pe/state-path', 'pe/state-path-p4', 'pe/state-path-hardening', 'pe/state-path-pX']) {
    git(root, 'branch', branch, 'main');
  }
  assert.deepEqual((await runBranches(root, 'state-path')).sort(),
    ['pe/state-path', 'pe/state-path-p4'],
    'only the run branch and its -p<N> lanes; a longer slug is a different plan');
});

test('a detached mirror mounts, validates, and survives a re-validate', async () => {
  const { root, stateDir } = fixture();
  const names = laneNames({ stateDir, runId: 'r1', slug: 'demo', phase: 0 });
  const mounts = [{ rel: '', source: root }];

  const made = await ensureMirror({ names, runId: 'r1', slug: 'demo', mounts, detach: true });
  assert.equal(made.ok, true, made.detail);
  const manifest = await readMirror(names.integration);
  assert.equal(manifest?.detached, true);
  // `holdsBranch` would fail every mount of a detached mirror and the run would
  // rebuild a perfectly good one on every drive.
  assert.equal(await validateMirror(names.integration, names.runBranch), true);
  assert.equal(await branchAt(root, join(names.integration, '')), undefined);
});

test('sweepUnmanaged prunes a vanished registration and only REPORTS a live one', async () => {
  const { root, stateDir } = fixture();

  // A registration whose directory an operator deleted. `git worktree list`
  // keeps printing it and it goes on holding its branch for ever.
  const ghost = join(stateDir, 'ghost');
  git(root, 'worktree', 'add', '-q', '-b', 'pe/ghost', ghost, 'main');
  rmSync(ghost, { recursive: true, force: true });

  // …and a hand-made one that is very much alive, on a `pe/*` branch.
  const byHand = join(stateDir, 'by-hand');
  git(root, 'worktree', 'add', '-q', '-b', 'pe/by-hand', byHand, 'main');

  const swept = await sweepUnmanaged(root, { managed: [join(stateDir, 'managed')] });
  assert.equal(swept.pruned.length, 1, JSON.stringify(swept));
  assert.deepEqual(swept.unmanaged.map((tree) => tree.branch), ['pe/by-hand']);
  // Reported, NEVER removed: it may hold work, and every sweep in this module
  // keeps a checkout that does.
  assert.ok(existsSync(byHand));
  assert.equal(await isRegistered(root, byHand), true);
  // The ghost's registration is gone, so its branch is takeable again.
  assert.equal(await isRegistered(root, ghost), false);
});

test('sweepUnmanaged leaves a NON-pe checkout alone entirely', async () => {
  const { root, stateDir } = fixture();
  const mine = join(stateDir, 'my-feature');
  git(root, 'worktree', 'add', '-q', '-b', 'feature/mine', mine, 'main');
  const swept = await sweepUnmanaged(root, { managed: [] });
  // A developer's own second tree is none of this console's business, and
  // saying so would be noise.
  assert.deepEqual(swept.unmanaged, []);
  assert.deepEqual(swept.pruned, []);
});

test('runBranches finds the run branch and its lane siblings, and nothing else', async () => {
  const { root } = fixture();
  for (const branch of ['pe/demo', 'pe/demo-p4', 'pe/demo-p11', 'pe/other', 'feature/x']) {
    git(root, 'branch', branch, 'main');
  }
  const found = (await runBranches(root, 'demo')).sort();
  assert.deepEqual(found, ['pe/demo', 'pe/demo-p11', 'pe/demo-p4']);
});

test('deleteMergedBranches deletes ONLY what the target already contains', async () => {
  const { root } = fixture();
  // Merged: a branch at main's own tip.
  git(root, 'branch', 'pe/demo-p1', 'main');
  // Unmerged: a branch with a commit main has never seen.
  git(root, 'switch', '-q', '-c', 'pe/demo-p2');
  commitIn(root, 'work.txt', 'unmerged\n', 'lane work');
  git(root, 'switch', '-q', 'main');

  const swept = await deleteMergedBranches({
    repos: [{ rel: '', source: root }],
    branches: ['pe/demo-p1', 'pe/demo-p2'],
    target: 'main',
  });

  assert.deepEqual(swept.deleted, ['pe/demo-p1']);
  // Ask git, not the return value.
  assert.deepEqual((await runBranches(root, 'demo')).sort(), ['pe/demo-p2']);
  // 🔴 …and the unmerged one was never ATTEMPTED. Measured by mutation: with
  // the `--merged` read removed, `git branch -d` still refuses the unmerged
  // branch, so every assertion above stayed green and the read looked
  // redundant. It is not — it is what makes this function ask the question
  // rather than discover the answer from an error. Without it `pe/demo-p2`
  // lands in `kept` carrying git's `fatal:`, which is the shape an operator
  // reads as "the console tried to delete my work and git stopped it".
  assert.deepEqual(swept.kept, [],
    'an unmerged branch must be filtered out by the --merged read, not by git declining');
});

test('deleteMergedBranches keeps a merged branch that is CHECKED OUT, and says why', async () => {
  const { root, stateDir } = fixture();
  const dir = join(stateDir, 'holding');
  git(root, 'worktree', 'add', '-q', '-b', 'pe/demo-p3', dir, 'main');

  const swept = await deleteMergedBranches({
    repos: [{ rel: '', source: root }], branches: ['pe/demo-p3'], target: 'main',
  });
  assert.deepEqual(swept.deleted, []);
  assert.equal(swept.kept.length, 1);
  assert.match(swept.kept[0].reason, /checked out at/);
  assert.deepEqual(await runBranches(root, 'demo'), ['pe/demo-p3']);
});

/* ================================================================== *
 * console-parallel-repaint P1 — the audit's pins (W1, W4, W7).
 * ================================================================== */

test('P1/W1 — reclaim: a tree a LIVE lock names is HELD and never moved, however clean', async () => {
  const { root, branch } = heldFixture();
  // Clean, on the branch, HEAD at the tip: every question git can answer says
  // "movable". The lock table says a session is in it right now — it just
  // committed, it is between two edits — and that outranks all of them.
  const result = await reclaimBranch({
    root, held: root, branch, allowed: [root],
    occupied: [{ tree: root, by: 'sam@laptop, other-plan phase 3' }],
  });
  assert.equal(result.kind, 'held');
  assert.ok(result.kind === 'held' && result.by.includes('other-plan phase 3'));
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), branch, 'moved under a live session');

  // Segment-wise and through `realish`: a claim naming a directory INSIDE the
  // tree (a mirror mount, a cwd-derived toplevel) holds it; a neighbour whose
  // path merely shares the prefix does not.
  const inside = await reclaimBranch({
    root, held: root, branch, allowed: [root],
    occupied: [{ tree: join(root, 'packages', 'x'), by: 'inside' }],
  });
  assert.equal(inside.kind, 'held');
  const neighbour = await reclaimBranch({
    root, held: root, branch, allowed: [root], dryRun: true,
    occupied: [{ tree: `${root}-b`, by: 'neighbour' }],
  });
  assert.equal(neighbour.kind, 'reclaimed', 'a neighbouring path is not this ground');
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), branch, 'dryRun moved nothing');

  // …and the preflight refuses exactly what the decide refuses, naming the
  // holder — one list, one answer, so it cannot promise a reclaim the launch
  // would then refuse.
  const preview = await previewIsolation(root, 'demo', new Set(['.']), 'clean-only',
    [{ tree: root, by: 'sam@laptop, other-plan phase 3' }]);
  assert.equal(preview.available, false);
  assert.equal(preview.refusal, 'branch-in-use');
  assert.match(String(preview.detail), /live session holds it \(sam@laptop, other-plan phase 3\)/);
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), branch);
});

test('P1/W4 — sameGitFacts ignores the two clocks (at, disk) and nothing else', async () => {
  const { root, stateDir } = fixture({ 'f.txt': 'a\n' });
  const names = laneNames({ stateDir, runId: 'r-disk', slug: 'demo', phase: 0 });
  assert.equal((await ensureIntegration(root, names)).ok, true);
  const opts = { root, branch: names.runBranch, workRoot: names.integration, stateRoot: stateDir };
  const first = await probeRunGit(opts);
  assert.ok(first.checkouts.some((entry) => entry.managed), 'no managed checkout, so `disk` is never measured and this proves nothing');

  // A session writing files moves `du` on every tick. That is not news, and
  // the first cut (strip `at`, compare the rest) fired the `run:git` stream on
  // a timer for as long as a lane lived.
  const grown = {
    ...first, at: 'later', disk: (first.disk ?? 0) + 4096,
    checkouts: first.checkouts.map((entry) => ({ ...entry, disk: (entry.disk ?? 0) + 4096 })),
  };
  assert.equal(sameGitFacts(first, grown), true, 'disk growth alone must not emit');

  // Everything a person can act on still IS news: a checkout going, a branch
  // moving, a file changing, a radar verdict.
  assert.equal(sameGitFacts(first, { ...first, checkouts: [] }), false);
  assert.equal(sameGitFacts(first, { ...first, branch: 'pe/other' }), false);
  assert.equal(sameGitFacts(first, { ...first, files: ['new.txt'] }), false);
  assert.equal(sameGitFacts(first, {
    ...first, radar: [{ a: 'main', b: 'pe/demo', state: 'conflicted', files: ['f.txt'] }],
  }), false);
});

test('P1/W7 — a lane whose run branch is GONE is kept, not read as landed', async () => {
  const { root, stateDir } = fixture({ 'shared.txt': 'base\n' });
  const opts = { stateDir, runId: 'run-gone', slug: 'demo' };
  const lane = laneNames({ ...opts, phase: 3 });
  await acquireLane(root, lane);
  commitIn(lane.dir, 'shared.txt', 'phase 3\n', 'phase 3'); // unlanded work

  // The run branch is deleted out from under the lane — the pull request
  // merged, the integration tree went, `pe/demo` with it — while the lane's
  // own branch survives because the lane is checked out on it. `rev-list
  // pe/demo..pe/demo-p3` now FAILS, and a failed read is not a zero.
  git(root, 'worktree', 'remove', '--force', lane.integration);
  git(root, 'branch', '-D', 'pe/demo');

  const { removed, kept } = await pruneRun(root, { ...opts, phases: [3] });
  assert.deepEqual(removed, []);
  assert.ok(kept.includes(lane.dir), 'a failed rev-list read as "nothing to land" removes a lane whose commits landed nowhere');
  assert.ok(existsSync(join(lane.dir, 'shared.txt')));
  assert.ok(await isRegistered(root, lane.dir));
});

test('P1/QA-F1 — a live claim that named NO tree holds every tree the reclaim may move', async () => {
  const { root, branch } = heldFixture();
  // The boot prompt's own claim shape: `claim N --scope … --git`, no `--here`,
  // no PE_WORKTREE — a lock with no `worktree=` line. The first cut read it as
  // "occupies nothing" and moved that session's clean root; an unqualified
  // claim collides with everything, and here that means: holds every tree.
  const claim = { by: 'sam@laptop, other-plan phase 2', owner: 'sam@laptop' };
  const result = await reclaimBranch({ root, held: root, branch, allowed: [root], occupied: [claim] });
  assert.equal(result.kind, 'held');
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), branch, 'moved under an unqualified live claim');

  const preview = await previewIsolation(root, 'demo', new Set(['.']), 'clean-only', [claim]);
  assert.equal(preview.available, false);
  assert.equal(preview.refusal, 'branch-in-use');
  assert.match(String(preview.detail), /live session holds it \(sam@laptop, other-plan phase 2\)/);
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), branch);
});
