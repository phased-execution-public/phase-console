/**
 * A run's mirror stands on the FETCHED trunk (measured-console phase 13, #383
 * #403).
 *
 * #383, measured: run `4c381ce83aba` forked aws's `pe/ai-builder-e2e-fixes-r4`
 * from the shared checkout's local `main` — five days behind `origin/main` —
 * because the mirror fetched nothing; every sibling reading `../aws` saw a
 * five-day-old tree. #403, measured: run `3cc434cbd53e` mounted MQL52026 (no
 * phase scoped it) at the run-start commit, and nothing ever moved it while
 * its origin went eight commits on; tb's vendored-copy test read it red.
 *
 *  - WM-1 (#383) a mirror built when the local trunk is behind `origin` forks
 *    each new run branch at the fetched `origin/<trunk>`, records the fork in
 *    the manifest, and never moves a run branch that already exists;
 *  - WM-2 (#383) a local trunk AHEAD of `origin` keeps its commits: the fork
 *    is at the local trunk;
 *  - WM-3 (#403) an out-of-scope mount is refreshed to the fetched trunk at a
 *    boundary when the trunk moved — never a scoped one, never a dirty one
 *    (warned), never one carrying commits of its own;
 *  - WM-4 (#383 #403) no remote, or a fetch that fails, falls back to the
 *    local trunk without throwing, and says so;
 *  - WM-5 (#403) the runner refreshes at a phase boundary: phase 2 boards into
 *    an out-of-scope mount at the trunk origin reached during phase 1,
 *    journalled `run.mirror-refreshed`.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as wt from '../server/runner/worktree.ts';
import { drive, git, harness, journal, superRoot } from './lane-harness.ts';

for (const key of ['PE_WORKTREE', 'PE_BRANCH', 'PE_SCOPE', 'PE_OWNER', 'PE_LOCK_MIRROR']) delete process.env[key];

/** Move a source repository's `main` on by one commit — `origin` moving under the shared checkout. */
function advance(source: string, tag: string): string {
  writeFileSync(join(source, `${tag}.txt`), `${tag}\n`);
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', tag);
  return git(source, 'rev-parse', 'HEAD');
}

/** The mirror over `scope`, built the way the runner builds it. */
async function build(base: string, root: string, scope: string[]) {
  const names = wt.laneNames({ stateDir: join(base, 'state'), runId: 'r1', slug: 'demo', phase: 0 });
  const resolved = await wt.resolveMounts(root, scope);
  assert.equal(resolved.ok, true);
  const mounts = (resolved as { mounts: wt.MirrorMount[] }).mounts;
  const made = await wt.ensureMirror({ names, runId: 'r1', slug: 'demo', mounts });
  assert.equal(made.ok, true, made.detail);
  return { names, mounts, at: (rel: string) => join(names.integration, rel) };
}

/** `refreshMirrorMounts`, asserted to exist — so the red on unfixed code is an assertion, not a load error. */
function refresher() {
  const fn = (wt as Record<string, unknown>).refreshMirrorMounts;
  assert.equal(typeof fn, 'function', 'worktree.ts exports refreshMirrorMounts (#403)');
  return fn as (opts: { integration: string; runBranch: string; root: string; scope: readonly string[] }) => Promise<{
    moved: { mount: string; from: string; to: string }[];
    warnings: { mount: string; reason: string }[];
    kept: { mount: string; reason: string }[];
  }>;
}

test('WM-1 (#383): a mirror forks each NEW run branch at the fetched origin trunk, records it, and never moves an existing one', async () => {
  const { base, root } = superRoot();
  const webSrc = join(base, 'web-src');
  const stale = git(join(root, 'web'), 'rev-parse', 'main');
  const ahead = advance(webSrc, 'origin-moved');
  assert.notEqual(stale, ahead);
  assert.equal(git(join(root, 'web'), 'rev-parse', 'main'), stale, 'the shared checkout has not fetched');

  const { names } = await build(base, root, ['docs', 'web']);
  assert.equal(git(join(root, 'web'), 'rev-parse', 'refs/heads/pe/demo'), ahead,
    'the scoped repository\'s run branch forks at origin/main, not at the stale local main');
  assert.equal(git(join(root, 'api'), 'rev-parse', 'refs/heads/pe/demo'), git(join(base, 'api-src'), 'rev-parse', 'HEAD'));
  assert.equal(git(join(root, 'web'), 'rev-parse', 'main'), stale, 'the local trunk itself is never moved');

  const manifest = await wt.readMirror(names.integration) as wt.MirrorManifest & {
    forks?: { mount: string; at: string; from: string; fetched: string }[];
  };
  const web = manifest.forks?.find((fork) => fork.mount === 'web');
  assert.ok(web, `the manifest records where web forked: ${JSON.stringify(manifest.forks)}`);
  assert.equal(web!.at, ahead);
  assert.equal(web!.from, 'origin/main');
  assert.equal(web!.fetched, 'fetched');

  // A resumed run: the branch exists, origin moves again, the mirror is
  // adopted — and the run branch stays exactly where the run put it.
  advance(webSrc, 'origin-moved-again');
  const again = await wt.ensureMirror({
    names, runId: 'r1', slug: 'demo', mounts: manifest.mounts,
  });
  assert.equal(again.ok, true, again.detail);
  assert.equal(git(join(root, 'web'), 'rev-parse', 'refs/heads/pe/demo'), ahead, 'an existing run branch is never moved');
});

test('WM-2 (#383): a local trunk AHEAD of origin keeps its commits — the fork is at the local trunk', async () => {
  const { base, root } = superRoot();
  // A commit on the shared checkout's own main that origin has never seen.
  const local = advance(join(root, 'web'), 'unpushed');
  await build(base, root, ['web']);
  assert.equal(git(join(root, 'web'), 'rev-parse', 'refs/heads/pe/demo'), local,
    'forking at origin/main would drop the local trunk\'s unpushed commit');
});

test('WM-3 (#403): an out-of-scope mount follows the fetched trunk at a boundary — never a scoped, dirty or own-commit one', async () => {
  const refresh = refresher();
  const { base, root } = superRoot();
  const scope = ['docs', 'web'];
  const { names, at } = await build(base, root, scope);
  const opts = { integration: names.integration, runBranch: names.runBranch, root, scope };

  // Nothing moved: nothing to do, and no fetch failed.
  const quiet = await refresh(opts);
  assert.deepEqual(quiet.moved, []);
  assert.deepEqual(quiet.warnings, []);

  const webBefore = git(at('web'), 'rev-parse', 'HEAD');
  advance(join(base, 'web-src'), 'web-moved');
  const apiNow = advance(join(base, 'api-src'), 'api-moved');
  const first = await refresh(opts);
  assert.deepEqual(first.moved.map((m) => m.mount), ['api'], 'only the out-of-scope mount moves');
  assert.equal(git(at('api'), 'rev-parse', 'HEAD'), apiNow, 'api stands at the fetched trunk');
  assert.equal(git(at('api'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo', 'still on the run branch');
  assert.equal(git(at('web'), 'rev-parse', 'HEAD'), webBefore, 'a scoped mount is the run\'s, never moved');
  assert.equal(await wt.validateMirror(names.integration, names.runBranch), true, 'the mirror still validates');
  const manifest = await wt.readMirror(names.integration) as wt.MirrorManifest & { forks?: { mount: string; at: string }[] };
  assert.equal(manifest.forks?.find((fork) => fork.mount === 'api')?.at, apiNow, 'the manifest names where api now stands');

  // Dirty: left alone, with a warning.
  writeFileSync(join(at('api'), 'scratch.txt'), 'a session\'s file\n');
  const apiDirty = advance(join(base, 'api-src'), 'api-moved-2');
  const dirty = await refresh(opts);
  assert.deepEqual(dirty.moved, []);
  assert.deepEqual(dirty.warnings.map((w) => w.mount), ['api']);
  assert.match(dirty.warnings[0]!.reason, /uncommitted/);
  assert.equal(git(at('api'), 'rev-parse', 'HEAD'), apiNow);

  // Commits of its own: never moved (and not a warning — it is work).
  git(at('api'), 'add', '-A');
  git(at('api'), 'commit', '-q', '-m', 'the run wrote here');
  const own = git(at('api'), 'rev-parse', 'HEAD');
  const owned = await refresh(opts);
  assert.deepEqual(owned.moved, []);
  assert.deepEqual(owned.kept.map((k) => k.mount), ['api']);
  assert.equal(git(at('api'), 'rev-parse', 'HEAD'), own);
  assert.notEqual(own, apiDirty);

  // `all` scopes every mount: nothing is out of scope, nothing moves.
  advance(join(base, 'web-src'), 'web-moved-2');
  const everything = await refresh({ ...opts, scope: ['all'] });
  assert.deepEqual(everything.moved, []);
});

test('WM-4 (#383 #403): no remote, or a fetch that fails, falls back to the local trunk without throwing', async () => {
  const refresh = refresher();
  const { base, root } = superRoot();
  const local = git(join(root, 'web'), 'rev-parse', 'main');
  advance(join(base, 'web-src'), 'unreachable');
  // origin/main is known, so the fetch is attempted — and the remote is gone.
  git(join(root, 'web'), 'remote', 'set-url', 'origin', join(base, 'no-such-remote'));
  git(join(root, 'api'), 'remote', 'set-url', 'origin', join(base, 'no-such-remote'));

  const { names } = await build(base, root, ['docs', 'web']);
  assert.equal(git(join(root, 'web'), 'rev-parse', 'refs/heads/pe/demo'), local, 'the local trunk, exactly as before');
  const manifest = await wt.readMirror(names.integration) as wt.MirrorManifest & {
    forks?: { mount: string; from: string; fetched: string; detail?: string }[];
  };
  const web = manifest.forks?.find((fork) => fork.mount === 'web');
  assert.equal(web?.fetched, 'failed');
  assert.equal(web?.from, 'main');
  assert.ok(web?.detail, 'the failure says why');
  // The root has no remote at all: the local trunk, and no failure claimed.
  assert.equal(manifest.forks?.find((fork) => fork.mount === '')?.fetched, 'no-remote');

  const out = await refresh({ integration: names.integration, runBranch: names.runBranch, root, scope: ['docs', 'web'] });
  assert.deepEqual(out.moved, []);
  assert.deepEqual(out.warnings.map((w) => w.mount), ['api'], 'the failed fetch is a warning, not a throw');
  assert.match(out.warnings[0]!.reason, /fetch/);
});

test('WM-5 (#403): phase 2 boards into an out-of-scope mount at the trunk origin reached during phase 1', async () => {
  const { base, root } = superRoot();
  let moved = '';
  let seen = '';
  const h = harness(root, { 1: 'web', 2: 'web' }, { planScope: () => ['docs', 'web'] }, (request) => {
    if (/BOOT phase 1\b/.test(request.prompt)) moved = advance(join(base, 'api-src'), 'during-phase-1');
    if (/BOOT phase 2\b/.test(request.prompt)) seen = git(join(request.cwd, 'api'), 'rev-parse', 'HEAD');
  });
  const state = await drive(h, { onlyPhases: [1, 2] });
  assert.ok(String(state.workRoot ?? '') !== root, 'the run took its mirror');
  assert.deepEqual((state.mountedRepos as string[]).slice().sort(), ['', 'api', 'web']);
  assert.ok(moved && seen, `both phases boarded: ${h.requests.map((q) => q.prompt.slice(0, 20)).join(' | ')}`);
  assert.equal(seen, moved, 'the out-of-scope mount was refreshed at the boundary');
  const lines = journal(root, 'run.mirror-refreshed');
  assert.equal(lines.length, 1, 'journalled once');
  assert.deepEqual(((lines[0]!.data as { moved: { mount: string }[] }).moved).map((m) => m.mount), ['api']);
});
