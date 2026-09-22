/**
 * `server/git.ts` — the docs tree's git context, against real throwaway repos.
 *
 * Everything here is read-only by contract ("nothing here writes to a
 * repository"), and every function funnels through one `execFile` helper that
 * swallows a non-zero exit into the empty string. That swallow is the whole
 * risk: a repo that does not exist, a path git has never heard of and a
 * genuinely broken invocation are indistinguishable to the caller, so the only
 * way to know these functions answer correctly is to run them against real
 * repositories in real states (coverage-11).
 *
 * P13's diff-review page reads `lastCommit` and `commitsTouching` to decide
 * what a phase touched, so their shapes are a prerequisite for it, not a
 * nicety.
 *
 * Needs `git` on PATH and a writable tmpdir. No plan library, no
 * PHASE_CONSOLE_TEST_ROOT, no client build.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  repoInfo, lastCommit, commitsTouching, uncommitted,
  branchState, bundleCreate, bundleVerify, formatPatch,
} = await import('../server/git.ts');

const TRASH: string[] = [];

process.on('exit', () => {
  for (const dir of TRASH) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TRASH.push(dir);
  return dir;
}

/** Identity + signing are forced per-invocation: the operator's ~/.gitconfig must not decide a test. */
function git(cwd: string, ...args: string[]): string {
  return String(execFileSync('git', [
    '-c', 'user.name=Phase Console Test',
    '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false',
    '-c', 'init.defaultBranch=main',
    ...args,
  ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
}

function commit(repo: string, path: string, body: string, subject: string): void {
  const full = join(repo, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
  git(repo, 'add', '--', path);
  git(repo, 'commit', '-m', subject);
}

/** A repo with one commit touching `docs/plans/demo.md`. */
function seeded(prefix = 'pc-git-'): string {
  const repo = scratch(prefix);
  git(repo, 'init');
  commit(repo, 'docs/plans/demo.md', '# demo\n', 'docs: the first plan');
  return repo;
}

test('repoInfo: a directory that is not a repository is `available: false`, never a throw', async () => {
  const plain = scratch('pc-git-plain-');
  const info = await repoInfo(plain);
  assert.equal(info.available, false);
  assert.deepEqual(info.dirty, [], 'an unavailable repo reports no dirty paths rather than guessing');
  assert.equal(info.branch, undefined);

  // A path that does not exist at all takes the same door: execFile fails to
  // spawn with that cwd, the helper swallows it, and `inside` is not 'true'.
  const gone = await repoInfo(join(plain, 'no', 'such', 'dir'));
  assert.equal(gone.available, false);
});

test('repoInfo: a clean repo reports its branch and nothing dirty', async () => {
  const repo = seeded();
  const info = await repoInfo(repo);
  assert.equal(info.available, true);
  assert.equal(info.branch, 'main');
  assert.deepEqual(info.dirty, []);
  // No upstream configured — the rev-list fails, the helper returns '', and
  // both counts stay undefined. `0` would be a claim ("in sync") this repo
  // cannot support.
  assert.equal(info.ahead, undefined, 'no upstream must not read as in-sync');
  assert.equal(info.behind, undefined);
});

test('repoInfo: porcelain is parsed past the two status columns, for every state', async () => {
  const repo = seeded();

  writeFileSync(join(repo, 'docs/plans/demo.md'), '# demo\nedited\n');   // ' M' modified
  writeFileSync(join(repo, 'docs/plans/new.md'), 'fresh\n');            // '??' untracked
  commit(repo, 'docs/plans/doomed.md', 'x\n', 'docs: doomed');
  rmSync(join(repo, 'docs/plans/doomed.md'));                           // ' D' deleted
  writeFileSync(join(repo, 'docs/plans/staged.md'), 'staged\n');
  git(repo, 'add', '--', 'docs/plans/staged.md');                       // 'A ' added

  const { dirty } = await repoInfo(repo);
  assert.deepEqual([...dirty].sort(), [
    'docs/plans/demo.md',
    'docs/plans/doomed.md',
    'docs/plans/new.md',
    'docs/plans/staged.md',
  ], 'modified, deleted, untracked and staged all count as uncommitted');

  // `slice(3)` is what strips the XY columns and the space. A path that
  // survived with a leading space would never match a caller's path.
  for (const path of dirty) assert.ok(!/^\s/.test(path), `"${path}" kept a status column`);
});

test('repoInfo: docsDir narrows the scope, so noise outside docs/ is not reported', async () => {
  const repo = seeded();
  writeFileSync(join(repo, 'docs/plans/demo.md'), 'edited\n');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/app.ts'), 'export const x = 1;\n');

  const scoped = await repoInfo(repo, join(repo, 'docs'));
  assert.deepEqual(scoped.dirty, ['docs/plans/demo.md'], 'only docs/ is the console\'s business');

  const wide = await repoInfo(repo);
  assert.equal(wide.dirty.length, 2, 'unscoped, the same repo reports both');

  // docsDir === root collapses to '.', which git accepts as "everything".
  const here = await repoInfo(repo, repo);
  assert.equal(here.dirty.length, 2, 'a docsDir equal to the root must not narrow to nothing');
});

test('repoInfo: ahead and behind are counted from the real upstream, in that order', async () => {
  const origin = scratch('pc-git-origin-');
  git(origin, 'init', '--bare');

  const work = seeded('pc-git-work-');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-u', 'origin', 'main');

  let info = await repoInfo(work);
  assert.equal(info.ahead, 0, 'freshly pushed');
  assert.equal(info.behind, 0);

  commit(work, 'docs/plans/second.md', '2\n', 'docs: a second plan');
  info = await repoInfo(work);
  assert.equal(info.ahead, 1, 'one local commit the upstream does not have');
  assert.equal(info.behind, 0);

  // Someone else pushes two commits; we fetch but do not merge.
  const peer = scratch('pc-git-peer-');
  git(peer, 'clone', origin, '.');
  commit(peer, 'docs/plans/peer-a.md', 'a\n', 'docs: peer a');
  commit(peer, 'docs/plans/peer-b.md', 'b\n', 'docs: peer b');
  git(peer, 'push', 'origin', 'main');

  git(work, 'fetch', 'origin');
  info = await repoInfo(work);
  assert.equal(info.ahead, 1, 'still one of ours');
  assert.equal(info.behind, 2, 'and two of theirs — left is ahead, right is behind');
});

test('lastCommit: the newest commit touching a path, and {} for a path git never saw', async () => {
  const repo = seeded();
  commit(repo, 'docs/plans/demo.md', '# demo\nv2\n', 'docs: the second word on it');
  commit(repo, 'docs/plans/other.md', 'other\n', 'docs: unrelated');

  const info = await lastCommit(repo, 'docs/plans/demo.md');
  assert.equal(info.subject, 'docs: the second word on it', 'newest, not first');
  assert.equal(info.author, 'Phase Console Test');
  assert.match(info.sha ?? '', /^[0-9a-f]{7,}$/, 'an abbreviated sha');
  assert.match(info.date ?? '', /^\d{4}-\d{2}-\d{2}T/, '%aI is strict ISO');
  assert.ok(info.relativeDate, '%ar is what the UI actually shows');

  // The SEP-joined format has to survive a subject that is itself
  // shell-hostile; the separator is a control character precisely so no
  // subject can forge a field boundary.
  commit(repo, 'docs/plans/tricky.md', 'x\n', 'docs: a | subject, with "quotes" and \\slashes');
  assert.equal(
    (await lastCommit(repo, 'docs/plans/tricky.md')).subject,
    'docs: a | subject, with "quotes" and \\slashes',
  );

  assert.deepEqual(await lastCommit(repo, 'docs/plans/never-existed.md'), {},
    'an unknown path is the empty answer, not a partly-filled one');
  assert.deepEqual(await lastCommit(scratch('pc-git-none-'), 'anything'), {}, 'and so is a non-repo');
});

test('commitsTouching: newest first, limit clamped to 1..1000, empty for an unknown path', async () => {
  const repo = seeded();
  for (let i = 2; i <= 6; i += 1) commit(repo, 'docs/plans/demo.md', `v${i}\n`, `docs: revision ${i}`);

  const all = await commitsTouching(repo, 'docs/plans/demo.md', 10);
  assert.equal(all.length, 6);
  assert.equal(all[0].subject, 'docs: revision 6', 'newest first');
  assert.equal(all.at(-1)?.subject, 'docs: the first plan');
  for (const entry of all) {
    assert.match(entry.sha, /^[0-9a-f]{7,}$/);
    assert.match(entry.date ?? '', /^\d{4}-\d{2}-\d{2}$/, '--date=short');
  }

  assert.equal((await commitsTouching(repo, 'docs/plans/demo.md', 2)).length, 2);
  assert.equal((await commitsTouching(repo, 'docs/plans/demo.md')).length, 5, 'the default limit is 5');
  assert.equal((await commitsTouching(repo, 'docs/plans/demo.md', 0)).length, 1, '0 clamps up to 1');
  assert.equal((await commitsTouching(repo, 'docs/plans/demo.md', -7)).length, 1, 'negative clamps up to 1');
  assert.equal((await commitsTouching(repo, 'docs/plans/demo.md', 999)).length, 6, 'more asked than exists');

  assert.deepEqual(await commitsTouching(repo, 'docs/plans/never.md', 5), []);
  assert.deepEqual(await commitsTouching(scratch('pc-git-none2-'), 'anything', 5), [], 'a non-repo is empty, not a throw');
});

test('uncommitted: the subset of the given paths that are actually dirty', async () => {
  const repo = seeded();
  commit(repo, 'docs/handoffs/demo/phase-01.md', 'one\n', 'docs: handoff 1');
  commit(repo, 'docs/handoffs/demo/phase-02.md', 'two\n', 'docs: handoff 2');
  writeFileSync(join(repo, 'docs/handoffs/demo/phase-02.md'), 'two, edited\n');

  const dirty = await uncommitted(repo, [
    'docs/handoffs/demo/phase-01.md',
    'docs/handoffs/demo/phase-02.md',
  ]);
  assert.ok(dirty instanceof Set);
  assert.deepEqual([...dirty], ['docs/handoffs/demo/phase-02.md'], 'only the edited one');

  // The empty-input short circuit matters: `git status -- ` with no pathspec
  // would report the WHOLE repo, and every caller would read that as "all of
  // your zero paths are dirty".
  assert.equal((await uncommitted(repo, [])).size, 0, 'no paths asked, no paths answered');
  assert.equal((await uncommitted(scratch('pc-git-none3-'), ['x'])).size, 0, 'a non-repo answers empty');
});

/* ------------------------------------------------------------------ *
 * Landing plumbing (P15) — the two verbs that write a FILE.
 *
 * Neither writes to the repository, and that is the property the console's
 * never-push invariant rests on. It is asserted the only way it can honestly
 * be: by recording the repository's whole ref state before and after.
 * ------------------------------------------------------------------ */

/** Every ref and where it points — the thing a write to the repository would move. */
function refState(repo: string): string {
  return git(repo, 'for-each-ref', '--format=%(refname) %(objectname)') + git(repo, 'rev-parse', 'HEAD');
}

test('commitsTouching: the cap is 1000, not the silent 20 that truncated a long plan', async () => {
  const repo = seeded();
  // 24 > the old cap. A 23-phase plan lands more handoff commits than that, and
  // the truncation put the review window's base in the middle of the plan.
  for (let i = 2; i <= 24; i += 1) commit(repo, 'docs/plans/demo.md', `v${i}\n`, `docs: revision ${i}`);

  const all = await commitsTouching(repo, 'docs/plans/demo.md', 500);
  assert.equal(all.length, 24, 'every commit, not the newest twenty');
  assert.equal(all.at(-1)?.subject, 'docs: the first plan', 'the OLDEST is what a landing brackets from');
});

test('commitsTouching: several paths are ONE log, in git ordering', async () => {
  const repo = seeded();
  commit(repo, 'docs/handoffs/demo/phase-01.md', 'one\n', 'docs: handoff 1');
  commit(repo, 'docs/plans/demo.md', 'v2\n', 'docs: plan revised');
  commit(repo, 'docs/handoffs/demo/phase-02.md', 'two\n', 'docs: handoff 2');

  const both = await commitsTouching(repo, ['docs/plans/demo.md', 'docs/handoffs/demo'], 50);
  assert.deepEqual(both.map((c) => c.subject), [
    'docs: handoff 2', 'docs: plan revised', 'docs: handoff 1', 'docs: the first plan',
  ], 'interleaved by git, not two lists stapled together');

  // The same-day tie is exactly what two separate newest-first lists cannot
  // resolve: every commit here shares one `--date=short`.
  assert.equal(new Set(both.map((c) => c.date)).size, 1, 'all on one day');
  assert.deepEqual(await commitsTouching(repo, [], 5), [], 'no paths asked, no answer invented');
});

test('branchState: a clean branch with no upstream — the unpushed plan branch', async () => {
  const repo = seeded();
  const state = await branchState(repo);
  assert.equal(state.available, true);
  assert.equal(state.branch, 'main');
  assert.match(state.head ?? '', /^[0-9a-f]{40}$/, 'the full sha, for a manifest');
  assert.equal(state.upstream, undefined, 'no remote is not an error');
  assert.equal(state.ahead, undefined);
  assert.deepEqual(state.dirty, []);
  assert.equal(state.dirtyTruncated, false);

  assert.equal((await branchState(scratch('pc-git-nb-'))).available, false, 'a non-repo answers, never throws');
});

test('branchState: dirty is the WHOLE tree, not just docs/ — a bundle carries none of it', async () => {
  const repo = seeded();
  writeFileSync(join(repo, 'src.ts'), 'export const x = 1;\n');
  writeFileSync(join(repo, 'docs/plans/demo.md'), 'edited\n');

  const state = await branchState(repo);
  assert.deepEqual(state.dirty.sort(), ['docs/plans/demo.md', 'src.ts'],
    'repoInfo scopes to docs/; this one must not, or the packet omits work silently');

  // The cap exists so a repo mid-rebase cannot put ten thousand paths in a
  // manifest, and it REPORTS itself rather than quietly shortening the list.
  for (let i = 0; i < 60; i += 1) writeFileSync(join(repo, `junk-${i}.txt`), 'x\n');
  const many = await branchState(repo);
  assert.equal(many.dirty.length, 50);
  assert.equal(many.dirtyTruncated, true);
});

test('branchState: a detached HEAD has no branch, and says so rather than guessing one', async () => {
  const repo = seeded();
  commit(repo, 'docs/plans/demo.md', 'v2\n', 'docs: revision 2');
  git(repo, 'checkout', '--detach', 'HEAD~1');

  const state = await branchState(repo);
  assert.equal(state.available, true);
  assert.equal(state.branch, undefined, '`git rev-parse --abbrev-ref HEAD` says "HEAD"; that is not a branch name');
  assert.match(state.head ?? '', /^[0-9a-f]{40}$/);
});

test('branchState: ahead and behind are counted against a real upstream', async () => {
  const origin = seeded();
  const clone = scratch('pc-git-clone-');
  git(clone, 'clone', '--quiet', origin, '.');
  git(clone, 'config', 'user.name', 'Phase Console Test');
  git(clone, 'config', 'user.email', 'test@example.invalid');
  commit(clone, 'docs/plans/demo.md', 'local\n', 'docs: a local commit');

  const state = await branchState(clone);
  assert.match(state.upstream ?? '', /^origin\//);
  assert.equal(state.ahead, 1, 'one commit the upstream has not seen');
  assert.equal(state.behind, 0);
});

test('bundleCreate + bundleVerify: a real bundle, fetchable into a repo that has the base', async () => {
  const repo = seeded();
  for (let i = 2; i <= 4; i += 1) commit(repo, 'docs/plans/demo.md', `v${i}\n`, `docs: revision ${i}`);
  const base = git(repo, 'rev-parse', 'HEAD~2').trim();
  const before = refState(repo);

  const out = join(scratch('pc-git-bundle-'), 'demo.bundle');
  const made = await bundleCreate(repo, out, { base, ref: 'main' });
  assert.equal(made.ok, true, made.error);
  assert.ok(statSync(out).size > 0);

  assert.equal(refState(repo), before, 'creating a bundle moved no ref and wrote no object into the repo');

  const verified = await bundleVerify(repo, out);
  assert.equal(verified.ok, true);
  assert.ok(verified.prerequisites.some((sha) => base.startsWith(sha) || sha.startsWith(base.slice(0, 7))),
    `the required ref is the base: ${JSON.stringify(verified.prerequisites)}`);

  // The claim is not "a file appeared" — it is that git can read it back and
  // the commits arrive intact. Fetched into a fresh clone of the base.
  const receiver = scratch('pc-git-recv-');
  git(receiver, 'clone', '--quiet', repo, '.');
  git(receiver, 'reset', '--hard', base);
  git(receiver, 'fetch', out, 'main');
  const landed = git(receiver, 'log', '--format=%s', `${base}..FETCH_HEAD`).trim().split('\n');
  assert.deepEqual(landed, ['docs: revision 4', 'docs: revision 3'], 'exactly the range, in order');
});

test('bundleCreate: an empty range is git refusing, reported — never a silent zero-byte file', async () => {
  const repo = seeded();
  const out = join(scratch('pc-git-empty-'), 'empty.bundle');

  const made = await bundleCreate(repo, out, { base: 'HEAD', ref: 'HEAD' });
  assert.equal(made.ok, false, 'git refuses to create an empty bundle');
  assert.match(made.error ?? '', /empty bundle/i, 'git\'s own words, not a paraphrase');
  assert.equal(existsSync(out), false, 'and no file was written, so nothing can advertise one');
});

test('formatPatch: the series is git-ordered, applies, and writes nothing into the repo', async () => {
  const repo = seeded();
  for (let i = 2; i <= 4; i += 1) commit(repo, 'docs/plans/demo.md', `v${i}\n`, `docs: revision ${i}`);
  const base = git(repo, 'rev-parse', 'HEAD~2').trim();
  const before = refState(repo);

  const dir = join(scratch('pc-git-patch-'), 'patches');
  const made = await formatPatch(repo, dir, { base, ref: 'main' });
  assert.equal(made.ok, true, made.error);
  assert.equal(made.files.length, 2);
  assert.deepEqual(made.files.map((f) => f.split('/').pop()), ['0001-docs-revision-3.patch', '0002-docs-revision-4.patch'],
    'numbered in apply order');
  assert.equal(refState(repo), before, 'format-patch is a log with a different renderer');

  // The proof a patch series is worth shipping: `git am` accepts it.
  const receiver = scratch('pc-git-am-');
  git(receiver, 'clone', '--quiet', repo, '.');
  git(receiver, 'config', 'user.name', 'Phase Console Test');
  git(receiver, 'config', 'user.email', 'test@example.invalid');
  git(receiver, 'reset', '--hard', base);
  for (const file of made.files) git(receiver, 'am', file);
  assert.deepEqual(git(receiver, 'log', '--format=%s', `${base}..HEAD`).trim().split('\n'),
    ['docs: revision 4', 'docs: revision 3']);
});

test('formatPatch: a range git cannot resolve is a reported failure, not an empty success', async () => {
  const repo = seeded();
  const dir = join(scratch('pc-git-badpatch-'), 'patches');
  const made = await formatPatch(repo, dir, { base: 'no-such-rev', ref: 'main' });
  assert.equal(made.ok, false);
  assert.deepEqual(made.files, []);
  assert.ok((made.error ?? '').length > 0, 'git said why');
});

/* ------------------------------------------------------------------ *
 * many-plans-one-repo phase 4 — G-FS: the `\x1f` forgery.
 * ------------------------------------------------------------------ */

test('G-FS: a commit subject carrying the old separator cannot shift the fields', () => {
  // `git-browse.ts` moved to NUL in P8 QA round 4 and left a 🔴 note saying
  // "git.ts uses \x1f and this module copied it, which was wrong the moment the
  // fields came from repository CONTENT". The note was right and `git.ts` was
  // never fixed: a subject may legally contain \x1f, and `%h\x1f%s\x1f%an…`
  // then hands the parser a record whose every later field is the attacker's.
  const repo = scratch('pc-git-sep-');
  git(repo, 'init', '-q', '-b', 'main');
  const US = String.fromCharCode(31);
  const forged = `innocent${US}forged-author${US}2001-01-01T00:00:00+00:00${US}20 years ago`;
  writeFileSync(join(repo, 'f.txt'), 'x\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', forged);

  const info = lastCommit(repo, 'f.txt');
  return info.then((one) => {
    assert.equal(one.subject, forged, 'the whole subject is the subject, separator bytes and all');
    assert.equal(one.author, 'Phase Console Test', 'the author is git’s, never the message’s');
    assert.notEqual(one.date, '2001-01-01T00:00:00+00:00');
    assert.notEqual(one.relativeDate, '20 years ago');
  });
});

test('G-FS: commitsTouching keeps one row per commit under the same forgery', async () => {
  const repo = scratch('pc-git-sep2-');
  git(repo, 'init', '-q', '-b', 'main');
  const US = String.fromCharCode(31);
  writeFileSync(join(repo, 'f.txt'), 'a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', `first${US}2099-12-31`);
  writeFileSync(join(repo, 'f.txt'), 'b\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'second');

  const rows = await commitsTouching(repo, 'f.txt', 10);
  assert.equal(rows.length, 2, 'two commits, two rows');
  assert.equal(rows[0]!.subject, 'second');
  assert.equal(rows[1]!.subject, `first${US}2099-12-31`);
  assert.notEqual(rows[1]!.date, '2099-12-31', 'the date is git’s --date=short, never the message’s');
});
