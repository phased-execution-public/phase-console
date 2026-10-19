/**
 * The landing proof fetches before it compares, and reads a squash the trunk
 * has moved past (one-pool phase 21, #370 #336).
 *
 *   #370  a run mirror nobody had fetched held `origin/main` two days old and
 *         called a branch the supervisor had squash-merged that morning
 *         unlanded; a `git fetch origin main` alone made the proof pass;
 *   #336  a squash-merged branch read unlanded once `main` moved on.
 *
 *   LPF-1  the proof fetches `origin/<trunk>` first: a squash pushed from
 *          another clone is `contained` (`fetched: fetched`) — and the same
 *          proof without the fetch reads `ahead`, which is #370;
 *   LPF-2  a squash the trunk moved past (a later commit edited the same
 *          file) is `contained` `by: merge-commit`, `at` the squash;
 *   LPF-3  a branch nothing on the trunk holds stays `ahead`, naming its file;
 *   LPF-4  a fetch that fails proves against the last fetch and says so;
 *   LPF-5  the fetch moves the trunk's remote-tracking ref and nothing else:
 *          no other remote branch, no tag, no FETCH_HEAD.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { landingProofs } = await import('../server/runner/worktree.ts');

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

/**
 * An origin with `main`, the run's clone (`work`) on `pe/demo` with one change
 * to `ledger.py`, and a second clone (`other`) that squash-merges it and pushes.
 */
function estate() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pc-lpf-')));
  TRASH.push(dir);
  const origin = join(dir, 'origin.git');
  git(dir, 'init', '-q', '--bare', origin);
  const seed = join(dir, 'seed');
  git(dir, 'clone', '-q', origin, seed);
  writeFileSync(join(seed, 'ledger.py'), 'one\ntwo\n');
  writeFileSync(join(seed, 'readme.md'), 'base\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'base');
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const work = join(dir, 'work');
  git(dir, 'clone', '-q', origin, work);
  git(work, 'switch', '-q', '-c', 'pe/demo');
  writeFileSync(join(work, 'ledger.py'), 'one\ntwo\nthree\n');
  git(work, 'commit', '-q', '-am', 'the run\'s change');
  git(work, 'push', '-q', 'origin', 'pe/demo');
  const other = join(dir, 'other');
  git(dir, 'clone', '-q', origin, other);
  return { dir, origin, work, other };
}

/** `other` squash-merges `pe/demo` into main and pushes; returns the squash commit. */
function squashFromOther(other: string): string {
  git(other, 'fetch', '-q', 'origin');
  writeFileSync(join(other, 'readme.md'), 'base\nmain moved first\n');
  git(other, 'commit', '-q', '-am', 'main moves before the squash');
  git(other, 'merge', '-q', '--squash', 'origin/pe/demo');
  git(other, 'commit', '-q', '-m', 'Squash pe/demo (#12)');
  const squash = git(other, 'rev-parse', 'HEAD');
  git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  return squash;
}

test('LPF-1 (#370): the proof fetches origin/<trunk> first — a squash pushed elsewhere is contained; unfetched it read ahead', async () => {
  const { work, other } = estate();
  squashFromOther(other);
  const stale = await landingProofs({ root: work, runBranch: 'pe/demo', fetch: false });
  assert.equal(stale.length, 1);
  assert.equal(stale[0]!.state, 'ahead', `without the fetch the stale origin/main misses the squash — #370: ${JSON.stringify(stale[0])}`);
  assert.deepEqual(stale[0]!.files, ['ledger.py']);
  const [proof] = await landingProofs({ root: work, runBranch: 'pe/demo' });
  assert.equal(proof!.fetched, 'fetched');
  assert.equal(proof!.state, 'contained', JSON.stringify(proof));
  assert.equal(proof!.into, 'origin/main');
});

test('LPF-2 (#336): a squash the trunk moved past — a later edit to the same file — is contained by its merge commit', async () => {
  const { work, other } = estate();
  const squash = squashFromOther(other);
  // main moves on AFTER the squash, taking the run's line back out.
  writeFileSync(join(other, 'ledger.py'), 'one\ntwo\n');
  git(other, 'commit', '-q', '-am', 'a later commit edits the file');
  git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  const [proof] = await landingProofs({ root: work, runBranch: 'pe/demo' });
  assert.equal(proof!.state, 'contained', `merging into main's head changes ledger.py again, its squash held it: ${JSON.stringify(proof)}`);
  assert.equal(proof!.by, 'merge-commit');
  assert.equal(proof!.at, squash, 'the squash commit is named');
});

test('LPF-3: a branch nothing on the trunk holds stays ahead, naming its file', async () => {
  const { work, other } = estate();
  git(other, 'fetch', '-q', 'origin');
  writeFileSync(join(other, 'readme.md'), 'base\nsomething else\n');
  git(other, 'commit', '-q', '-am', 'unrelated');
  git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  const [proof] = await landingProofs({ root: work, runBranch: 'pe/demo' });
  assert.equal(proof!.state, 'ahead');
  assert.deepEqual(proof!.files, ['ledger.py']);
  assert.equal(proof!.by, undefined);
});

test('LPF-4: a fetch that fails proves against the last fetch, and says so', async () => {
  const { work, origin } = estate();
  rmSync(origin, { recursive: true, force: true });
  const [proof] = await landingProofs({ root: work, runBranch: 'pe/demo' });
  assert.equal(proof!.fetched, 'failed');
  assert.equal(proof!.state, 'ahead', 'the proof still answers, from what it has');
  assert.match(proof!.detail ?? '', /the fetch failed .*proved against the last fetch/);
});

test('LPF-5: the fetch moves origin/<trunk> alone — no other remote branch, no tag, no FETCH_HEAD', async () => {
  const { work, other } = estate();
  git(other, 'fetch', '-q', 'origin');
  git(other, 'switch', '-q', '-c', 'feature/elsewhere');
  writeFileSync(join(other, 'readme.md'), 'base\nfeature\n');
  git(other, 'commit', '-q', '-am', 'a branch the proof must not fetch');
  git(other, 'tag', 'v9.9.9');
  git(other, 'push', '-q', 'origin', 'feature/elsewhere', 'v9.9.9');
  rmSync(join(work, '.git', 'FETCH_HEAD'), { force: true });
  await landingProofs({ root: work, runBranch: 'pe/demo' });
  assert.equal(git(work, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/feature'), '', 'no other remote branch arrived');
  assert.equal(git(work, 'tag', '--list'), '', 'no tag arrived');
  assert.ok(!existsSync(join(work, '.git', 'FETCH_HEAD')), 'no FETCH_HEAD written');
});
