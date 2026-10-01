/**
 * A stable ERRAND TREE for a person's commands (control-tower phase 90, #123).
 *
 * Measured on hub 4123 (observability-plane run 86103bfe79aa): a parked
 * phase's handoff gave the operator `!` lines that `cd` into the run's mirror,
 * and the console pruned that mirror at the end of the very session that wrote
 * them — the production apply lines pointed at a directory that was gone. A
 * person's commands need a directory on the PERSON's schedule:
 *
 *  - ET-1 `ensureErrandTree` makes `.worktrees/hand/<slug>/p<N>-errand`,
 *    DETACHED in every mounted repository at the PUSHED run branch (the local
 *    tip only when nothing was pushed, and it says so), locked with a reason
 *    that is not the console's; a second press adopts it as it stands; no
 *    sweep or prune of this console takes it;
 *  - the runner names it on the phase's record and journals
 *    `phase.errand-tree` — from the run's recorded mounts when the mirror's
 *    manifest is gone, which is exactly when a person needs the tree;
 *  - the errand card names the tree in its `how`.
 *
 * ET-2 (the `validate.sh` warning on a `!` line into a run tree) is
 * `tests/unit/validate.bats`.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildInbox } from '../server/inbox.ts';
import {
  ensureErrandTree, errandTreeDir, resolveMounts, sweepStale, worktreeHome,
} from '../server/runner/worktree.ts';
import type { MirrorMount } from '../server/runner/worktree.ts';
import { verbNamed } from '../shared/verb-model.js';
import { ourWorktreeLock, WORKTREE_ROOTS } from '../shared/worktree-model.js';
import { drive, git, harness, journal, superRoot } from './lane-harness.ts';

for (const key of ['PE_WORKTREE', 'PE_BRANCH', 'PE_SCOPE', 'PE_OWNER', 'PE_LOCK_MIRROR']) delete process.env[key];

const SERVER = fileURLToPath(new URL('../server/', import.meta.url));

/** The lock reason git holds for a linked worktree, or undefined when it holds none. */
function lockReasonOf(source: string, dir: string): string | undefined {
  const real = git(dir, 'rev-parse', '--show-toplevel');
  const blocks = git(source, 'worktree', 'list', '--porcelain').split('\n\n');
  const block = blocks.find((text) => text.split('\n').some((line) => line === `worktree ${real}`));
  const line = block?.split('\n').find((l) => l.startsWith('locked'));
  return line === undefined ? undefined : line.replace(/^locked ?/, '');
}

/**
 * A superproject whose run branch stands three ways: `web` PUSHED to a bare
 * origin and then moved on locally, `api` on a local branch nobody pushed, and
 * the root with no run branch at all.
 */
function runBranches(): { base: string; root: string; pushed: string; webTip: string; apiTip: string; rootTip: string } {
  const { base, root } = superRoot();
  const web = join(root, 'web');
  const bare = join(base, 'web.git');
  git(base, 'clone', '-q', '--bare', join(base, 'web-src'), bare);
  git(web, 'remote', 'set-url', 'origin', bare);
  git(web, 'switch', '-q', '-c', 'pe/demo');
  git(web, 'commit', '-q', '--allow-empty', '-m', 'the run\'s pushed work');
  git(web, 'push', '-q', 'origin', 'pe/demo');
  const pushed = git(web, 'rev-parse', 'HEAD');
  git(web, 'commit', '-q', '--allow-empty', '-m', 'a later commit nobody pushed');
  const webTip = git(web, 'rev-parse', 'HEAD');
  git(web, 'switch', '-q', 'main');

  const api = join(root, 'api');
  git(api, 'switch', '-q', '-c', 'pe/demo');
  git(api, 'commit', '-q', '--allow-empty', '-m', 'local only');
  const apiTip = git(api, 'rev-parse', 'HEAD');
  git(api, 'switch', '-q', 'main');
  return { base, root, pushed, webTip, apiTip, rootTip: git(root, 'rev-parse', 'HEAD') };
}

async function mountsOf(root: string): Promise<MirrorMount[]> {
  const res = await resolveMounts(root, ['repo', 'web', 'api']);
  assert.equal(res.ok, true, JSON.stringify(res));
  return (res as { mounts: MirrorMount[] }).mounts;
}

/* ------------------------------------------------------------------ ET-1 */

test('ET-1 — the errand tree stands detached at the PUSHED run branch in every mounted repository', async () => {
  const { root, pushed, webTip, apiTip, rootTip } = runBranches();
  const made = await ensureErrandTree({ root, slug: 'demo', phase: 7, mounts: await mountsOf(root) });
  assert.equal(made.ok, true, made.detail);
  assert.equal(made.adopted, false);
  assert.equal(made.dir, errandTreeDir(root, 'demo', 7));
  assert.equal(made.dir, join(root, '.worktrees', 'hand', 'demo', 'p7-errand'));

  const byRel = new Map(made.mounts.map((mount) => [mount.rel, mount]));
  assert.deepEqual([...byRel.keys()].sort(), ['', 'api', 'web']);
  // web: the PUSHED sha, never the local tip that moved on after it.
  assert.equal(byRel.get('web')!.sha, pushed);
  assert.notEqual(pushed, webTip);
  assert.equal(byRel.get('web')!.pushed, true);
  assert.equal(byRel.get('web')!.ref, 'refs/remotes/origin/pe/demo');
  // api: nothing pushed, so the local run branch — and the mount says so.
  assert.equal(byRel.get('api')!.sha, apiTip);
  assert.equal(byRel.get('api')!.pushed, false);
  // the root has no run branch: its default branch's head.
  assert.equal(byRel.get('')!.sha, rootTip);
  assert.equal(byRel.get('')!.pushed, false);

  // On disk: detached, at those commits, with the files a person reads.
  for (const [rel, sha] of [['', rootTip], ['web', pushed], ['api', apiTip]] as const) {
    const at = join(made.dir, rel);
    assert.equal(git(at, 'rev-parse', 'HEAD'), sha, `${rel || '.'} stands at the wrong commit`);
    assert.equal(git(at, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', `${rel || '.'} holds a branch`);
  }
  assert.equal(readFileSync(join(made.dir, 'README.md'), 'utf8'), 'root\n');
  assert.equal(readFileSync(join(made.dir, 'web', 'index.html'), 'utf8'), 'web\n');
  assert.equal(readFileSync(join(made.dir, 'api', 'api.txt'), 'utf8'), 'api\n');
  // Holding no branch, it never blocks the run: the run branch is still free
  // to be checked out elsewhere.
  git(join(root, 'web'), 'switch', '-q', 'pe/demo');
  git(join(root, 'web'), 'switch', '-q', 'main');
});

test('ET-1 — locked with a reason that is not the console\'s, adopted on a second press, and no sweep takes it', async () => {
  const { base, root, pushed } = runBranches();
  const mounts = await mountsOf(root);
  const first = await ensureErrandTree({ root, slug: 'demo', phase: 7, mounts });
  assert.equal(first.ok, true, first.detail);

  for (const mount of mounts) {
    const reason = lockReasonOf(mount.source, join(first.dir, mount.rel));
    assert.ok(reason, `${mount.rel || '.'} is not locked`);
    assert.equal(ourWorktreeLock(reason), false, `the console would read "${reason}" as its own lock and free it`);
    assert.match(reason!, /errand tree of demo phase 7/);
  }

  // A second press adopts the tree as it stands — a person may be working in it.
  git(join(first.dir, 'web'), 'commit', '-q', '--allow-empty', '-m', 'a person\'s own commit');
  const personal = git(join(first.dir, 'web'), 'rev-parse', 'HEAD');
  const second = await ensureErrandTree({ root, slug: 'demo', phase: 7, mounts });
  assert.equal(second.ok, true, second.detail);
  assert.equal(second.adopted, true);
  assert.equal(second.dir, first.dir);
  assert.equal(second.mounts.find((m) => m.rel === 'web')!.sha, personal, 'the adopted tree reports where it stands');
  assert.notEqual(personal, pushed);

  // The console's own sweep, over both of its homes, and git's prune in every
  // repository: the tree is under `hand/`, and it is locked by a person's word.
  const stateDir = mkdtempSync(join(tmpdir(), 'p90-errand-state-'));
  try {
    const swept = await sweepStale(root, {
      homes: WORKTREE_ROOTS.map((mode) => worktreeHome({ mode, root, slug: 'demo', stateDir })),
      slug: 'demo',
      liveRunIds: [],
    });
    assert.deepEqual(swept.removed, []);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
  for (const mount of mounts) git(mount.source, 'worktree', 'prune');
  for (const mount of mounts) {
    const at = join(first.dir, mount.rel);
    assert.ok(existsSync(at), `${mount.rel || '.'} was removed`);
    assert.ok(lockReasonOf(mount.source, at), `${mount.rel || '.'} lost its lock`);
  }
  assert.equal(git(join(first.dir, 'web'), 'rev-parse', 'HEAD'), personal);
  void base;
});

test('ET-1 — a single-repository run gets a one-tree errand tree of its root', async () => {
  const { root, rootTip } = runBranches();
  const made = await ensureErrandTree({ root, slug: 'demo', phase: 2 });
  assert.equal(made.ok, true, made.detail);
  assert.deepEqual(made.mounts.map((mount) => mount.rel), ['']);
  assert.equal(git(made.dir, 'rev-parse', 'HEAD'), rootTip);
});

/* ------------------------------------------------------------------ the runner */

test('ET-1 — the runner names the tree on the phase\'s record and journals phase.errand-tree', async () => {
  const { root, pushed } = runBranches();
  let answer: { ok: boolean; error?: string } | undefined;
  const h = harness(root, { 1: 'web', 2: 'web' }, { planScope: () => ['web', 'api'] }, async (request, runner) => {
    if (/BOOT phase 1\b/.test(request.prompt)) answer = await runner.prepareErrandTree(1, 'operator');
  });
  const state = await drive(h, { onlyPhases: [1] });
  assert.equal(state.checkout, 'worktree', `isolation refused: ${String(state.isolationRefusal)}`);
  assert.ok(answer?.ok, JSON.stringify(answer));

  const tree = (state.phases as Record<string, { errandTree?: { dir: string; by: string; mounts: { rel: string; sha: string; pushed: boolean }[] } }>)['1']?.errandTree;
  assert.ok(tree, 'the phase record does not name the errand tree');
  assert.equal(tree!.dir, errandTreeDir(root, 'demo', 1));
  assert.equal(tree!.by, 'operator');
  assert.deepEqual(tree!.mounts.map((mount) => mount.rel).sort(), ['api', 'web'], 'the tree holds the run\'s mounts');
  assert.equal(tree!.mounts.find((m) => m.rel === 'web')!.sha, pushed);
  assert.ok(existsSync(join(tree!.dir, 'web', 'index.html')));

  const lines = journal(root, 'phase.errand-tree');
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.phase, 1);
  const data = lines[0]!.data as { dir: string; by: string; adopted: boolean };
  assert.equal(data.dir, tree!.dir);
  assert.equal(data.by, 'operator');
  assert.equal(data.adopted, false);
});

test('ET-1 — with the mirror (and its manifest) gone, the tree is made from the run\'s recorded mounts', async () => {
  // The moment a person needs an errand tree is the moment the run's own
  // checkout is not there: a manifest read that fails must not shrink the
  // tree to a bare worktree of the superproject with empty submodules.
  const { root } = runBranches();
  let answer: { ok: boolean; tree?: { mounts: { rel: string }[] }; error?: string } | undefined;
  const h = harness(root, { 1: 'web', 2: 'web' }, { planScope: () => ['web', 'api'] }, async (request, runner) => {
    if (!/BOOT phase 1\b/.test(request.prompt)) return;
    // A prune takes the run's whole directory: the mirror AND the manifest
    // beside it (`mirrorManifestPath`).
    const cwd = String(request.cwd);
    for (const rel of ['web', 'api']) git(join(root, rel), 'worktree', 'remove', '--force', join(cwd, rel));
    rmSync(dirname(cwd), { recursive: true, force: true });
    answer = await runner.prepareErrandTree(1, 'operator') as never;
  });
  await drive(h, { onlyPhases: [1] });
  assert.ok(answer?.ok, JSON.stringify(answer));
  assert.deepEqual(answer!.tree!.mounts.map((mount) => mount.rel).sort(), ['api', 'web']);
  const dir = errandTreeDir(root, 'demo', 1);
  assert.ok(existsSync(join(dir, 'web', 'index.html')), 'web is missing from the errand tree');
  assert.ok(existsSync(join(dir, 'api', 'api.txt')), 'api is missing from the errand tree');
});

test('ET-1 — the verb reaches the runner from the API and from the verb table', () => {
  const routes = readFileSync(join(SERVER, 'api/routes.ts'), 'utf8');
  assert.match(routes, /case 'errand-tree': \{\s*const answer = await service\.errandTree\(slug, Number\(body\.phase\)/);
  const row = verbNamed('errand-tree');
  assert.equal(row?.route, 'POST /api/run/:slug/errand-tree');
  assert.equal(row?.method, 'errandTree');
  // The shape `phase-console run errand-tree <slug> <phase>` speaks once the
  // CLI reads the table (phase 98): the slug fills the route, the phase rides the body.
  assert.deepEqual(row?.cli, { args: ['slug', 'phase'], flags: {} });
});

/* ------------------------------------------------------------------ the card */

test('ET-1 — the errand card names the tree its commands run in', () => {
  const NOW = Date.parse('2026-09-26T12:00:00.000Z');
  const run = (errandTree?: { dir: string; at: string; by: string; mounts: { rel: string; sha: string; pushed: boolean }[] }) => ({
    id: 'run-1', slug: 'demo', status: 'parked', updatedAt: '2026-09-26T10:00:00.000Z',
    halt: { at: '2026-09-26T09:00:00.000Z', reason: 'phase 4 needs a person', phase: 4, kind: 'verify-failed' },
    phases: { 4: { phase: 4, status: 'failed', ...(errandTree ? { errandTree } : {}) } },
    recoveries: {
      4: {
        errand: {
          phase: 4, situation: 'verify-red', tried: ['re-ran the suite'],
          need: 'A person to apply the migration.', how: 'Run the apply lines in the handoff.',
          at: '2026-09-26T09:30:00.000Z',
        },
      },
    },
  });
  const dir = '/home/op/work/shop/.worktrees/hand/demo/p4-errand';
  const withTree = buildInbox({
    runs: [run({ dir, at: '2026-09-26T09:40:00.000Z', by: 'operator', mounts: [{ rel: '', sha: 'a'.repeat(40), pushed: true }] }) as never],
    flags: { allowRun: true, allowWrites: true } as never,
  }, NOW).items.find((item) => item.kind === 'errand' && item.slug === 'demo');
  assert.ok(withTree);
  assert.match(withTree!.how, /^Run the apply lines in the handoff\./);
  assert.ok(withTree!.how.includes(dir), withTree!.how);
  assert.match(withTree!.how, /never in the run's own mirror/);

  const without = buildInbox({ runs: [run() as never], flags: { allowRun: true, allowWrites: true } as never }, NOW)
    .items.find((item) => item.kind === 'errand' && item.slug === 'demo');
  assert.equal(without!.how, 'Run the apply lines in the handoff.');
});
