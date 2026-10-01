/**
 * The run's own mirror branches, settled by what the trunk HOLDS (control-tower
 * phase 89, the half of #47 phase 62 left) — and the stderr mirror's clock
 * (#71's CON-6).
 *
 * Phase 62 settled a mount's `pe/<slug>` before the LAST phase's §Verification
 * when `for-each-ref --merged` listed it — 0 commits ahead of the trunk — and
 * never the root mount. Two run-owned refs therefore went on tripping hygiene
 * contract 5 ("fully merged into main; delete it"): the root's own branch,
 * checked out by the run's integration worktree so that nobody else could
 * delete it, and any branch whose pull request was SQUASH-merged, whose
 * commits are on no trunk by identity although every change in them is.
 *
 *   HY-3  the root mount is settled like the others, and only when merged and
 *         clean; "merged" is what the trunk HOLDS — a squash merge, a trunk
 *         that moved on since, the trunk's `origin/` copy — and a branch with
 *         one change the trunk lacks, or one a merge would conflict over, is
 *         never touched
 *   HY-4  the stderr mirror opens with the entry's own ISO-8601 instant,
 *         where the Debug index's supervisor reader looks for one
 *
 * (HY-1 and HY-2 are lint F32's, in `tests/unit/verification-fleetwide.bats`.)
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ensureMirror, laneNames, resolveMounts, restoreSettledMirror, settleIdleMirrorBranches,
  type LaneNames,
} from '../server/runner/worktree.ts';
import { log, recent, revertLevel } from '../server/log.ts';
import { readSupervisorLogs, supervisorLogPaths } from '../server/debug/sources.ts';

// The console exports its claim variables into every session it spawns —
// this suite's own included, when an autopilot runs it.
for (const key of ['PE_WORKTREE', 'PE_BRANCH', 'PE_SCOPE', 'PE_OWNER', 'PE_PROOFS_FILE', 'PE_OUTCOME_FILE']) {
  delete process.env[key];
}

const GIT_ENV = {
  ...process.env, LC_ALL: 'C',
  GIT_AUTHOR_NAME: 'hy', GIT_AUTHOR_EMAIL: 'hy@example.invalid',
  GIT_COMMITTER_NAME: 'hy', GIT_COMMITTER_EMAIL: 'hy@example.invalid',
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hasBranch = (repo: string, branch: string): boolean =>
  git(repo, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${branch}`) === branch;
const standsOn = (dir: string): string => git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');

/** Write one file and commit it — the whole of what a phase's session does here. */
function commit(dir: string, file: string, text: string, message: string): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-qm', message);
}

/**
 * Act on `main` of the repository at `source` — where it is checked out, or in
 * a throwaway worktree when it is not (a submodule's checkout may stand
 * detached at its gitlink). The source's own checkout never moves.
 */
function onTrunk(source: string, act: (dir: string) => void): void {
  let here = false;
  try { here = git(source, 'symbolic-ref', '--short', '-q', 'HEAD') === 'main'; } catch { /* detached */ }
  const at = here ? source : mkdtempSync(join(tmpdir(), 'pc-mirror-trunk-'));
  if (!here) git(source, 'worktree', 'add', '-q', at, 'main');
  try {
    act(at);
  } finally {
    if (!here) git(source, 'worktree', 'remove', '--force', at);
  }
}

/**
 * Squash-merge `branch` into `main` of the repository at `source`, the way a
 * pull request's squash button does — ONE new commit on the trunk, none of the
 * branch's own — and then, unless told otherwise, move the trunk on with a
 * commit of its own, so its tip tree is no longer the branch's.
 */
function squashInto(source: string, branch: string, opts: { later?: boolean } = { later: true }): void {
  onTrunk(source, (at) => {
    git(at, 'merge', '--squash', '-q', branch);
    git(at, 'commit', '-qm', `squash ${branch}`);
    if (opts.later) commit(at, 'later.txt', 'the trunk moved on\n', 'the trunk moves on');
  });
}

/** A superproject root{ web, app{ core } } whose submodules are real checkouts — VG-4's shape. */
function superproject(): { base: string; root: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'pc-mirror-branches-'));
  const src = (name: string): string => {
    const dir = join(base, `src-${name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.txt`), `${name}\n`);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    return dir;
  };
  const core = src('core');
  const app = src('app');
  git(app, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', core, 'core');
  git(app, 'commit', '-qm', 'core');
  const web = src('web');
  const root = join(base, 'repo');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'README.md'), 'root\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', web, 'web');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', app, 'app');
  git(root, 'commit', '-qm', 'submodules');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init', '--recursive');
  return { base, root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** The run's mirror over every mount of `root`, standing on `pe/demo`. */
async function mirror(s: { base: string; root: string }): Promise<{ names: LaneNames; at: (rel: string) => string }> {
  const names = laneNames({ stateDir: join(s.base, 'state'), runId: 'r1', slug: 'demo', phase: 0 });
  const resolved = await resolveMounts(s.root, ['all']);
  assert.equal(resolved.ok, true);
  const mounts = (resolved as { mounts: { rel: string; source: string }[] }).mounts;
  assert.deepEqual(mounts.map((m) => m.rel), ['', 'app', 'web', 'app/core']);
  const made = await ensureMirror({ names, runId: 'r1', slug: 'demo', mounts });
  assert.equal(made.ok, true, made.detail);
  return { names, at: (rel: string) => join(names.integration, rel) };
}

/* ------------------------------------------------------------------ *
 * HY-3 — the root mount, and "merged" by what the trunk holds
 * ------------------------------------------------------------------ */

test('HY-3: the root mount\'s pe/<slug>, merged and clean, is settled like the others — a dirty root is kept — and restoring puts back exactly what was there', async () => {
  const s = superproject();
  try {
    const { names, at } = await mirror(s);
    const rootTip = git(at(''), 'rev-parse', 'HEAD');

    // A root holding uncommitted work is kept, whatever its branch holds.
    writeFileSync(join(at(''), 'scratch.txt'), 'scratch\n');
    let out = await settleIdleMirrorBranches(names.integration, names.runBranch);
    assert.deepEqual(out.kept, [{ mount: '', reason: 'the mount holds uncommitted work' }]);
    assert.deepEqual(out.settled, ['app', 'web', 'app/core']);
    assert.equal(standsOn(at('')), 'pe/demo', 'a dirty root stays on its branch');
    assert.deepEqual(await restoreSettledMirror(names.integration, names.runBranch, out.settled),
      { restored: ['app', 'web', 'app/core'], failed: [] });

    // Clean, and 0 commits ahead of the trunk: settled like every other mount.
    rmSync(join(at(''), 'scratch.txt'));
    out = await settleIdleMirrorBranches(names.integration, names.runBranch);
    assert.deepEqual(out.settled, ['', 'app', 'web', 'app/core']);
    assert.deepEqual(out.kept, []);
    assert.equal(standsOn(at('')), 'HEAD', 'the root mount is detached…');
    assert.equal(git(at(''), 'rev-parse', 'HEAD'), rootTip, '…at the very commit it stood on');
    assert.equal(hasBranch(s.root, 'pe/demo'), false, 'and the superproject\'s run branch is gone');
    assert.deepEqual(out.proofs.find((p) => p.mount === ''), { mount: '', by: 'ancestry', into: 'main', tip: rootTip });
    // Detaching the root moved nothing nested in it: each nested mount stands
    // where its OWN settle left it, at its own commit.
    assert.equal(standsOn(at('app')), 'HEAD');
    assert.equal(git(at('app'), 'rev-parse', 'HEAD'), out.proofs.find((p) => p.mount === 'app')!.tip);

    const back = await restoreSettledMirror(names.integration, names.runBranch, out.settled);
    assert.deepEqual(back, { restored: ['', 'app', 'web', 'app/core'], failed: [] });
    assert.equal(standsOn(at('')), 'pe/demo');
    assert.equal(git(at(''), 'rev-parse', 'HEAD'), rootTip);
    assert.equal(hasBranch(s.root, 'pe/demo'), true);
  } finally {
    s.cleanup();
  }
});

test('HY-3: a squash-merged run branch is merged by TREE CONTENT — in a submodule mount and in the root — though --merged says it is not', async () => {
  const s = superproject();
  try {
    const { names, at } = await mirror(s);
    // The root carries a landing of its own and `app` two commits of work; each
    // pull request was squash-merged, and each trunk has moved on since.
    commit(at(''), join('docs', 'landed.md'), 'landed\n', 'the run\'s landing');
    squashInto(s.root, 'pe/demo');
    commit(at('app'), 'one.txt', 'one\n', 'work, part one');
    commit(at('app'), 'two.txt', 'two\n', 'work, part two');
    squashInto(join(s.root, 'app'), 'pe/demo');
    const tips = { root: git(at(''), 'rev-parse', 'HEAD'), app: git(at('app'), 'rev-parse', 'HEAD') };

    // What phase 62 asked, and why it kept both: neither tip is on its trunk.
    for (const repo of [s.root, join(s.root, 'app')]) {
      assert.equal(git(repo, 'for-each-ref', '--merged', 'main', '--format=%(refname:short)', 'refs/heads/pe/demo'), '');
    }

    const out = await settleIdleMirrorBranches(names.integration, names.runBranch);
    assert.deepEqual(out.settled, ['', 'app', 'web', 'app/core']);
    assert.deepEqual(out.kept, []);
    assert.deepEqual(Object.fromEntries(out.proofs.map((p) => [p.mount, [p.by, p.into]])), {
      '': ['content', 'main'], app: ['content', 'main'], web: ['ancestry', 'main'], 'app/core': ['ancestry', 'main'],
    });
    assert.equal(hasBranch(s.root, 'pe/demo'), false);
    assert.equal(hasBranch(join(s.root, 'app'), 'pe/demo'), false);
    // The proof carries the tip the branch named, which is what a person — or
    // the restore — re-creates it at.
    assert.equal(out.proofs.find((p) => p.mount === '')!.tip, tips.root);
    assert.equal(out.proofs.find((p) => p.mount === 'app')!.tip, tips.app);

    const back = await restoreSettledMirror(names.integration, names.runBranch, out.settled);
    assert.deepEqual(back.failed, []);
    assert.equal(git(at(''), 'rev-parse', 'pe/demo'), tips.root, 'the root\'s branch comes back at its own commit');
    assert.equal(git(at('app'), 'rev-parse', 'pe/demo'), tips.app, 'and so does app\'s, both commits of work on it');
  } finally {
    s.cleanup();
  }
});

test('HY-3: a branch its trunk holds only in the origin/ copy counts — a pull request squash-merged on the remote, fetched, never pulled', async () => {
  const s = superproject();
  try {
    const { names, at } = await mirror(s);
    const web = join(s.root, 'web');
    commit(at('web'), 'w.txt', 'w\n', 'web work');
    // The "remote" is web's origin (the source it was cloned from): it takes
    // the branch, squash-merges it on its main, and web fetches — its local
    // `main` stays where it was, exactly as after a merge on GitHub.
    const remote = join(s.base, 'src-web');
    git(remote, '-c', 'protocol.file.allow=always', 'fetch', '-q', web, 'pe/demo:incoming');
    squashInto(remote, 'incoming', {});
    git(remote, 'branch', '-q', '-D', 'incoming');
    git(web, '-c', 'protocol.file.allow=always', 'fetch', '-q', 'origin');
    assert.notEqual(git(web, 'merge-tree', '--write-tree', 'main', 'pe/demo'), git(web, 'rev-parse', 'main^{tree}'),
      'the local trunk does not hold it');

    const out = await settleIdleMirrorBranches(names.integration, names.runBranch);
    assert.ok(out.settled.includes('web'), JSON.stringify(out));
    assert.deepEqual(out.proofs.find((p) => p.mount === 'web')?.into, 'origin/main');
    assert.equal(out.proofs.find((p) => p.mount === 'web')?.by, 'content');
    assert.equal(hasBranch(web, 'pe/demo'), false);
  } finally {
    s.cleanup();
  }
});

test('HY-3: never a commit the trunk lacks — a root with a landing of its own, a squash-merged branch with one more change, and a squash its trunk has since edited over are not settled', async () => {
  const s = superproject();
  try {
    const { names, at } = await mirror(s);
    // The root: a landing its trunk has never seen.
    commit(at(''), join('docs', 'landing.md'), 'landing\n', 'a landing');
    // `app`: squash-merged, then one more commit of work on the branch.
    commit(at('app'), 'one.txt', 'one\n', 'work');
    squashInto(join(s.root, 'app'), 'pe/demo');
    commit(at('app'), 'two.txt', 'two\n', 'more work, after the squash');
    // `app/core`: squash-merged, then its trunk rewrote the same line. The
    // trunk no longer holds the branch's version, and a merge would conflict:
    // a conflict is never read as merged.
    commit(at('app/core'), 'core.txt', 'core, by the run\n', 'the run edits core');
    squashInto(join(s.root, 'app', 'core'), 'pe/demo', {});
    onTrunk(join(s.root, 'app', 'core'), (trunk) =>
      commit(trunk, 'core.txt', 'core, by somebody else\n', 'the trunk edits the same line'));
    assert.throws(() => git(join(s.root, 'app', 'core'), 'merge-tree', '--write-tree', 'main', 'pe/demo'),
      'the fixture really is a conflict');

    const out = await settleIdleMirrorBranches(names.integration, names.runBranch);
    assert.deepEqual(out.settled, ['web'], 'only the mount whose branch holds nothing the trunk lacks');
    assert.deepEqual(out.kept, [], 'the others were never candidates at all');
    assert.deepEqual(out.proofs.map((p) => p.mount), ['web']);
    for (const [rel, repo] of [['', s.root], ['app', join(s.root, 'app')], ['app/core', join(s.root, 'app', 'core')]] as const) {
      assert.equal(standsOn(at(rel)), 'pe/demo', `${rel || 'the root'} stays on its branch`);
      assert.equal(hasBranch(repo, 'pe/demo'), true, `${rel || 'the root'}'s branch is kept`);
    }
  } finally {
    s.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * HY-4 — the stderr mirror's clock
 * ------------------------------------------------------------------ */

test('HY-4: the stderr mirror opens with the entry\'s own ISO-8601 instant, which the Debug index places the line at', () => {
  revertLevel();
  delete process.env.PHASE_CONSOLE_LOG_LEVEL;
  delete process.env.PHASE_CONSOLE_DEBUG;
  const written: string[] = [];
  const stderr = process.stderr as unknown as { write: (chunk: unknown, ...rest: unknown[]) => boolean };
  const original = stderr.write;
  stderr.write = (chunk: unknown): boolean => { written.push(String(chunk)); return true; };
  try {
    log.warn('journal.full', { bytes: 3 });
    // `info` and `debug` never reach stderr — unchanged.
    log.info('start', {});
  } finally {
    stderr.write = original;
  }
  assert.equal(written.length, 1, written.join(''));
  const line = written[0]!;
  const stamped = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) \[phase-console\] warn journal\.full \{"bytes":3\}\n$/.exec(line);
  assert.ok(stamped, `a UTC ISO-8601 instant first, then the line as before: ${JSON.stringify(line)}`);
  const entry = recent(5).find((e) => e.event === 'journal.full');
  assert.ok(entry);
  assert.equal(stamped[1], entry.time, 'the instant the log entry records — not a second clock read');

  // What the stamp is for: the supervisor's stderr file carries no per-line
  // time of its own, and the Debug index reads a LEADING stamp to place a line
  // (#71: the only record of two OOMs was an undated trace in that file).
  const { err } = supervisorLogPaths();
  mkdirSync(dirname(err), { recursive: true });
  writeFileSync(err, line);
  const row = readSupervisorLogs().entries.find((e) => e.text.includes('journal.full'));
  assert.equal(row?.at, entry.time);
});
