/**
 * The repository browse surface, against real git and against fixtures.
 *
 * Two halves, and the split is deliberate:
 *
 *  - **Parsers take fixtures.** A two-parent commit, a decoration list with an
 *    arrow and a tag in it, and the two OPPOSITE orders git prints ahead/behind
 *    in are all one string each. Building a repository to produce them would
 *    make the assertions depend on the git installed here — and one of those
 *    two orders is only reachable on git ≥ 2.41, so a real-repo-only test
 *    would silently cover one path on one machine and the other on another.
 *  - **Everything with a threat model takes real git.** An injection attempt is
 *    only proven by a repository that did not get injected, and the run join is
 *    only proven by a lane checkout that git itself registered — including
 *    after the run that made it has stopped, which is the gap this whole
 *    surface exists to close.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BRANCH_CAP, DIFF_FILE_CAP, GRAPH_LIMIT_MAX, PATCH_BYTES_MAX, SETTLE_CAP, SETTLE_EVENT_NAMES,
  attributeCheckouts, branchList, checkoutList, commitGraph, divergences, gitEnv, localRefs,
  submoduleDirs,
  parseAheadBehind, parseBatchAheadBehind, parseGraph, parseRefs, parseRunBranch, pickTarget,
  repoDiff, repoTargets, rootTarget, safePath, safeRev, settleHistory, treeClaims, trunkOf,
} from '../server/git-browse.ts';
import { stagingNames, type CheckoutEntry } from '../server/runner/worktree.ts';
import type { JournalEntry } from '../server/runner/journal.ts';
import type { RunState } from '../server/runner/state.ts';

const SEP = '\x00';

/** `git`, throwing on failure — a broken FIXTURE must not read as a finding. */
function git(cwd: string, ...args: string[]): string {
  return String(execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      LC_ALL: 'C',
      GIT_AUTHOR_NAME: 'p8', GIT_AUTHOR_EMAIL: 'p8@example.invalid',
      GIT_COMMITTER_NAME: 'p8', GIT_COMMITTER_EMAIL: 'p8@example.invalid',
    },
  })).trim();
}

const trash: string[] = [];
process.on('exit', () => {
  for (const dir of trash) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/**
 * A repository on `main` with three commits, a `pe/demo` run branch two
 * commits ahead of it, and a state directory beside it.
 */
function fixture(): { base: string; root: string; stateDir: string } {
  const raw = mkdtempSync(join(tmpdir(), 'p8-browse-'));
  trash.push(raw);
  // Realpath'd, because `checkouts()` reports what git prints. The dedicated
  // symlink test above is where the UN-resolved spelling is the subject.
  const base = realpathSync(raw);
  const root = join(base, 'repo');
  const stateDir = join(base, 'state');
  execFileSync('mkdir', ['-p', root, stateDir]);
  git(root, 'init', '-q', '-b', 'main');
  for (const n of [1, 2, 3]) {
    writeFileSync(join(root, `f${n}.txt`), `base ${n}\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', `base ${n}`);
  }
  git(root, 'branch', 'pe/demo');
  return { base, root, stateDir };
}

/** Add `count` commits to `branch` without leaving the root checkout. */
function advance(root: string, branch: string, count: number): void {
  const here = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  git(root, 'switch', '-q', branch);
  for (let n = 0; n < count; n += 1) {
    writeFileSync(join(root, `${branch.replace(/\//g, '-')}-${n}.txt`), `work ${n}\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', `${branch} ${n}`);
  }
  git(root, 'switch', '-q', here);
}

/* ================================================================== *
 * Parsers — fixtures, not repositories
 * ================================================================== */

test('parseGraph reads parents, decorations and an empty subject', () => {
  // `git log -z` terminates each RECORD with a NUL as well, so the stream is
  // flat: fields and records are separated by the same byte.
  const rows = parseGraph([
    ['aaaa1111', 'aaaa111', 'bbbb2222 cccc3333', 'HEAD -> main, tag: v1, pe/demo', 'a merge', 'Ann', '2026-09-01T10:00:00+00:00'].join(SEP),
    ['bbbb2222', 'bbbb222', 'dddd4444', '', '', 'Bo', '2026-08-31T09:00:00+00:00'].join(SEP),
  ].join(SEP) + SEP);

  assert.equal(rows.length, 2);
  // A two-parent commit is the shape a linear parser silently flattens.
  assert.deepEqual(rows[0].parents, ['bbbb2222', 'cccc3333']);
  // `HEAD -> main` is ONE ref called `main`, and `tag: v1` is ONE called `v1`.
  assert.deepEqual(rows[0].refs, ['main', 'v1', 'pe/demo']);
  assert.equal(rows[0].short, 'aaaa111');
  // An undecorated commit has no refs, and an empty subject is a real commit.
  assert.deepEqual(rows[1].refs, []);
  assert.deepEqual(rows[1].parents, ['dddd4444']);
  assert.equal(rows[1].subject, '');
});

test('parseGraph drops a record with no sha rather than emitting a blank commit', () => {
  assert.deepEqual(parseGraph(''), []);
  assert.deepEqual(parseGraph('\n\n'), []);
  assert.equal(parseGraph(['', '', '', '', 's', 'a', 't'].join(SEP) + SEP).length, 0);
  // A half-written trailing record is dropped, not read as a short commit.
  assert.equal(parseGraph(['aaaa', 'aaa'].join(SEP)).length, 0);
});

test('repository CONTENT cannot forge a field — the separator is one git will not carry', async () => {
  // 🔴 QA round 4's Medium. The separator was `\x1f`, which a commit subject may
  // legally contain, so a crafted message shifted every field after it: the
  // commit reported an author and an author DATE of its own choosing, and the
  // fabricated date parsed. Proven here against real git, end to end.
  const { root } = fixture();
  const forged = `innocent\x1fFAKE-AUTHOR\x1f1999-01-01T00:00:00Z`;
  writeFileSync(join(root, 'evil.txt'), 'x\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', forged);

  const graph = await commitGraph(root, { limit: 1 });
  assert.ok(graph);
  const tip = graph.commits[0];
  assert.equal(tip.subject, forged, 'the whole subject belongs to the subject');
  assert.equal(tip.author, 'p8', 'the author is git, not the commit message');
  assert.notEqual(tip.at, '1999-01-01T00:00:00Z');
  assert.match(tip.at, /^2\d{3}-/, 'the date is git, not the commit message');

  // …and the ref reader shifts identically when it shifts at all: a branch on
  // that commit must not gain an upstream, or lose its `current` marker.
  git(root, 'branch', 'forged-subject');
  const refs = await branchList(root);
  const row = refs.branches.find((b) => b.name === 'forged-subject');
  assert.ok(row);
  assert.equal('upstream' in row, false, 'a subject must not fabricate an upstream');
  assert.equal(row.subject, forged);
  assert.equal(refs.branches.filter((b) => b.current).length, 1,
    'exactly one branch is checked out, whatever a subject says');
});

test('a comma in a branch name does not become two refs', async () => {
  // QA round 4's Medium, second half: git joins decorations with `, ` and a ref
  // name may contain a comma but never a space, so splitting on the comma alone
  // invented refs that do not exist.
  const { root } = fixture();
  git(root, 'branch', 'feat,with-a-comma');
  const graph = await commitGraph(root, { refs: ['feat,with-a-comma'], limit: 1 });
  assert.ok(graph);
  assert.ok(graph.commits[0].refs.includes('feat,with-a-comma'),
    `got ${JSON.stringify(graph.commits[0].refs)}`);
  assert.equal(graph.commits[0].refs.includes('feat'), false, 'no ref named `feat` exists');
});

test('parseRefs keeps an absent upstream absent rather than empty', () => {
  // Records are newline-terminated and fields are NUL-separated, which is what
  // `for-each-ref --format=…%00…` emits.
  const rows = parseRefs([
    ['main', 'a'.repeat(40), 'aaaaaaa', '2026-09-01T10:00:00+00:00', 'subject', 'Ann', 'origin/main', '*'].join(SEP),
    ['pe/demo', 'b'.repeat(40), 'bbbbbbb', '2026-09-01T11:00:00+00:00', 'work', 'Bo', '', ''].join(SEP),
  ].join('\n') + '\n');   // for-each-ref has no -z: records are newline-terminated

  assert.equal(rows.length, 2);
  assert.equal(rows[0].upstream, 'origin/main');
  assert.equal(rows[0].current, true);
  // Absent, not `''` — "no upstream" and "we could not ask" must not look alike.
  assert.equal('upstream' in rows[1], false);
  assert.equal(rows[1].current, false);
});

test('the two ahead/behind readers parse git’s two OPPOSITE orders', () => {
  // `rev-list --left-right --count main...pe/demo` prints `<behind> <ahead>`.
  assert.deepEqual(parseAheadBehind('1\t2\n'), { ahead: 2, behind: 1 });
  // `%(ahead-behind:main)` prints `<ahead> <behind>` — the other way round.
  const batch = parseBatchAheadBehind(`pe/demo${SEP}2 1\nmain${SEP}0 0\n`);
  assert.deepEqual(batch.get('pe/demo'), { ahead: 2, behind: 1 });
  // A git that does not know the placeholder prints it back, or nothing. Both
  // must read as "could not answer" so the caller falls back.
  assert.equal(parseBatchAheadBehind(`pe/demo${SEP}%(ahead-behind:main)\n`).size, 0);
  assert.equal(parseBatchAheadBehind('pe/demo\n').size, 0);
  assert.equal(parseAheadBehind(''), undefined);
  assert.equal(parseAheadBehind('nonsense'), undefined);
});

test('parseRunBranch reads the LAST -p<N>, so a slug may contain one', () => {
  assert.deepEqual(parseRunBranch('pe/demo'), { slug: 'demo' });
  assert.deepEqual(parseRunBranch('pe/demo-p4'), { slug: 'demo', phase: 4 });
  assert.deepEqual(parseRunBranch('pe/demo-p12'), { slug: 'demo', phase: 12 });
  // The trap: a plan whose own name ends in a phase-looking token.
  assert.deepEqual(parseRunBranch('pe/console-p8-repaint'), { slug: 'console-p8-repaint' });
  assert.deepEqual(parseRunBranch('pe/console-p8-repaint-p3'), { slug: 'console-p8-repaint', phase: 3 });
  assert.equal(parseRunBranch('main'), null);
  assert.equal(parseRunBranch('pe/'), null);
  assert.equal(parseRunBranch(''), null);
});

/* ================================================================== *
 * The safety envelope
 * ================================================================== */

test('safeRev refuses a flag, a range and anything outside the charset', () => {
  // The whole injection class: an argument read as an OPTION.
  for (const bad of [
    '--upload-pack=touch /tmp/x', '--output=/tmp/x', '-c', '--exec=x',
    'a..b', 'a...b',                       // a smuggled range
    'a;rm -rf /', 'a b', 'a|b', 'a$(id)', 'a`id`', 'a\\b', 'HEAD:file',
    '', '   ', 'x'.repeat(201),
  ]) {
    assert.equal(safeRev(bad), null, `safeRev must refuse ${JSON.stringify(bad)}`);
  }
  for (const good of [
    'HEAD', 'main', 'pe/demo-p4', 'HEAD~3', 'HEAD^', 'v1.2.3', 'a'.repeat(40), 'origin/main',
    'HEAD@{1}',
    // Legal in a ref and inert as an argument — a branch called
    // `feat,with-a-comma` was refused until QA round 4 found it.
    'feat,with-a-comma', 'feat+plus',
  ]) {
    assert.equal(safeRev(good), good, `safeRev must allow ${good}`);
  }
  // …and the four things a character must not be able to turn an argument into
  // stay refused: a glob (`for-each-ref` reads a PATTERN), a `rev:path`.
  for (const stillBad of ['ma*', 'ma?n', 'ma[i]n', 'HEAD:file', 'a b']) {
    assert.equal(safeRev(stillBad), null, `safeRev must still refuse ${stillBad}`);
  }
  assert.equal(safeRev('  main  '), 'main');
  assert.equal(safeRev(undefined), null);
  assert.equal(safeRev(42), null);
});

test('safePath refuses an escape, an absolute path, a flag and a magic pathspec', () => {
  for (const bad of [
    '../../etc/passwd', 'a/../../b', '..', '/etc/passwd', '-x', '--output=x',
    ':(glob)**', ':!secret', 'a\0b', 'a*b', 'a?b', 'a"b', 'a\\b', '', 'x'.repeat(4097),
  ]) {
    assert.equal(safePath(bad), null, `safePath must refuse ${JSON.stringify(bad)}`);
  }
  for (const good of ['README.md', 'src/a/b.ts', 'a..b.txt', 'dir/.hidden']) {
    assert.equal(safePath(good), good, `safePath must allow ${good}`);
  }
});

test('gitEnv hands the child git’s own variables and NOTHING else', () => {
  const env = gitEnv({
    PATH: '/usr/bin', HOME: '/home/x',
    // The three shapes worth naming: a run token, an account credential, and
    // an inherited git override that would change what a read MEANS.
    PE_RUN_TOKEN: 'secret', ANTHROPIC_API_KEY: 'secret', GIT_DIR: '/elsewhere/.git',
  });
  assert.deepEqual(Object.keys(env).sort(), [
    'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'HOME', 'LC_ALL', 'NO_COLOR', 'PATH', 'TERM',
  ]);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.LC_ALL, 'C');
  // A read must never take index.lock, and must never hang on a prompt.
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  // A missing PATH must not become `undefined` — an unfindable git is a
  // different failure from a git that ran and said nothing.
  assert.equal(typeof gitEnv({}).PATH, 'string');
  assert.ok((gitEnv({}).PATH ?? '').length > 0);
});

test('an injected flag reaches git as nothing at all', async () => {
  const { base, root } = fixture();
  const bomb = join(base, 'pwned');

  // Each of these would be an OPTION if it were passed through: two that write
  // a file, one that runs a program, one that reads a different repository.
  for (const rev of [`--output=${bomb}`, '--upload-pack=touch ' + bomb, '-c', `--git-dir=${base}`]) {
    assert.equal(await repoDiff(root, { base: rev }), null, `base ${rev} must be refused`);
    assert.equal(await repoDiff(root, { tip: rev }), null, `tip ${rev} must be refused`);
  }
  // A path that escapes the repository, and a magic pathspec.
  assert.equal(await repoDiff(root, { tip: 'HEAD', path: '../../etc/passwd' }), null);
  assert.equal(await repoDiff(root, { tip: 'HEAD', path: ':(glob)**' }), null);
  // And the proof the refusals were real: nothing was written.
  assert.equal(existsSync(bomb), false, 'a refused flag must not have reached git');
});

test('a well-formed rev that does not resolve here is refused too', async () => {
  const { root } = fixture();
  // Shape alone is not membership: this passes `safeRev` and is not a commit.
  assert.equal(await repoDiff(root, { base: 'no-such-branch' }), null);
  assert.equal(await repoDiff(root, { base: 'f'.repeat(40) }), null);
  // …and a real one is not refused, which is what makes the above a test.
  const ok = await repoDiff(root, { base: 'HEAD~1', tip: 'HEAD' });
  assert.ok(ok, 'a resolvable range must be answered');
});

test('a caller-named graph ref must be a ref this repository HAS', async () => {
  const { root } = fixture();
  const trunk = await trunkOf(root);
  assert.equal(trunk, 'main');

  // Refused by shape — a leading `-` — so it never reaches the tips, and a
  // caller who named ONLY that gets a refusal rather than a graph of something
  // else (QA round 4's Low; the fall-back-to-default behaviour was the bug).
  assert.equal(await commitGraph(root, { refs: ['--all'] }), null);
  // Refused by MEMBERSHIP: well-formed, validated, and not a branch here.
  assert.equal(await commitGraph(root, { refs: ['ghost-branch'] }), null);
  // A real one is honoured.
  const named = await commitGraph(root, { refs: ['pe/demo'] });
  assert.ok(named);
  assert.deepEqual(named.tips, ['pe/demo']);
  // …and naming nothing still walks the defaults.
  const fallback = await commitGraph(root);
  assert.ok(fallback);
  assert.deepEqual(fallback.tips.sort(), ['main', 'pe/demo']);
});

/* ================================================================== *
 * The graph
 * ================================================================== */

test('the graph is bounded, says when it cut, and pages with its own cursor', async () => {
  const { root } = fixture();

  const page = await commitGraph(root, { limit: 2 });
  assert.equal(page.commits.length, 2);
  assert.equal(page.truncated, true, 'three commits, a page of two');
  assert.equal(page.nextCursor, '2');
  assert.equal(page.trunk, 'main');

  const next = await commitGraph(root, { limit: 2, cursor: page.nextCursor });
  assert.equal(next.commits.length, 1);
  assert.equal(next.truncated, false);
  assert.equal(next.nextCursor, undefined, 'the last page offers no cursor');
  // The pages are disjoint and in order — the property a broken skip loses.
  const seen = new Set(page.commits.map((c) => c.sha));
  assert.equal(seen.has(next.commits[0].sha), false);

  // Every commit carries a full sha, a short one, an author and a date.
  for (const commit of page.commits) {
    assert.match(commit.sha, /^[0-9a-f]{40}$/);
    assert.ok(commit.short.length >= 4);
    assert.equal(commit.author, 'p8');
    assert.match(commit.at, /^\d{4}-\d{2}-\d{2}T/);
  }
  // The tip carries its decorations, which is what a graph draws refs from.
  const tip = page.commits[0];
  assert.ok(tip.refs.includes('main') || tip.refs.includes('pe/demo'), `no refs on ${tip.short}`);

  // A limit past the cap is clamped rather than honoured.
  const huge = await commitGraph(root, { limit: GRAPH_LIMIT_MAX * 10 });
  assert.ok(huge.commits.length <= GRAPH_LIMIT_MAX);
  // A nonsense cursor is a start, not a crash.
  assert.equal((await commitGraph(root, { cursor: 'nonsense' })).commits.length, 3);
});

test('the default tips are the trunk and the run branches, and `all` widens them', async () => {
  const { root } = fixture();
  git(root, 'branch', 'feature/unrelated');

  const narrow = await commitGraph(root);
  assert.deepEqual(narrow.tips.sort(), ['main', 'pe/demo']);
  assert.equal(narrow.tipsTruncated, false);

  const wide = await commitGraph(root, { all: true });
  assert.ok(wide.tips.includes('feature/unrelated'));
  assert.equal(wide.tipsTruncated, false);
});

test('a tip set cut at the cap SAYS so — a partial graph must not read as complete', async () => {
  // QA round 1's Low. `all` over a repository with more branches than the cap
  // silently dropped whole branches out of the walk and reported nothing.
  const { root } = fixture();
  for (let n = 0; n < BRANCH_CAP + 3; n += 1) git(root, 'branch', `bulk/${n}`);

  const wide = await commitGraph(root, { all: true, limit: 5 });
  assert.equal(wide.tips.length, BRANCH_CAP);
  assert.equal(wide.tipsTruncated, true, 'a cut tip set must say it was cut');
  // The narrow default is still complete on the same repository — the flag is
  // about the WALK, not about the repository having many branches.
  assert.equal((await commitGraph(root)).tipsTruncated, false);
});

test('the TRUNK survives a repository with more branches than the cap', async () => {
  // 🔴 QA round 4's Medium. The round-3 fix hardened the run-branch half of the
  // default candidate set and left the other half — the trunk — resolving
  // through the same capped, date-sorted window. A stale `main` therefore fell
  // out of it, `trunkOf` degraded to whatever HEAD was standing on, and the
  // default walk lost `main`'s history while reporting itself complete.
  const { root } = fixture();
  git(root, 'switch', '-q', '-c', 'feature/x');
  for (let n = 0; n < BRANCH_CAP + 25; n += 1) {
    writeFileSync(join(root, `bulk-${n}.txt`), `${n}\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', `bulk ${n}`);
    git(root, 'branch', `bulk/${n}`);
  }

  assert.equal(await trunkOf(root), 'main', 'a stale trunk is still the trunk');
  const graph = await commitGraph(root, { limit: 5 });
  assert.ok(graph);
  assert.equal(graph.trunk, 'main');
  assert.ok(graph.tips.includes('main'), `got ${graph.tips.join(', ')}`);
});

test('the run branches survive a repository with more branches than the cap', async () => {
  // 🔴 QA round 3's Medium, and the reason the fix is a second QUERY rather
  // than a second flag. `localRefs` windows the ref universe at the cap sorted
  // by committer date; make the `pe/*` branches the OLDEST and they fall out of
  // that window entirely, so the default walk answered `tips: ['main']` and
  // `tipsTruncated: false` — a graph missing exactly the branches the Repo
  // destination exists to show, presented as complete.
  const { root } = fixture();          // `pe/demo` is created here, at the start
  for (let n = 0; n < BRANCH_CAP + 60; n += 1) {
    // Every one of these is NEWER than `pe/demo`, so the general window fills
    // with them.
    writeFileSync(join(root, `bulk-${n}.txt`), `${n}\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', `bulk ${n}`);
    git(root, 'branch', `bulk/${n}`);
  }

  const narrow = await commitGraph(root, { limit: 5 });
  assert.ok(narrow.tips.includes('pe/demo'),
    `the run branch must be walked; got ${narrow.tips.join(', ')}`);
  assert.ok(narrow.tips.includes('main'));
  assert.equal(narrow.tipsTruncated, false, 'the run-branch query was not cut');

  // …and a caller naming a branch far outside the general window is still
  // honoured, because membership is asked of git rather than of that window.
  const named = await commitGraph(root, { refs: ['pe/demo'], limit: 5 });
  assert.deepEqual(named.tips, ['pe/demo']);
});

test('more run branches than the cap DOES report a cut tip set', async () => {
  const { root } = fixture();
  for (let n = 0; n < BRANCH_CAP + 3; n += 1) git(root, 'branch', `pe/bulk-${n}`);
  const out = await commitGraph(root, { limit: 5 });
  assert.ok(out);
  assert.equal(out.tipsTruncated, true, 'the run-branch query hit its own cap');
});

test('the run-branch query’s OWN cap is what reports, not the tip-list cap beside it', async () => {
  // QA round 4's Low: the test above passes through `candidates.length >
  // tips.length` and never exercises the `runRefs.truncated` term the round-3
  // fix added — an unpinned term is how round 1's fix rotted into round 3's
  // Medium. Isolated by removing the trunk from the candidate set: with no
  // `main`/`master`/`trunk` and a detached HEAD, `candidates` is exactly the
  // capped 300, so only the query's own flag can speak.
  const { root } = fixture();
  git(root, 'branch', '-m', 'main', 'release/2');
  for (let n = 0; n < BRANCH_CAP + 3; n += 1) git(root, 'branch', `pe/bulk-${n}`);
  git(root, 'switch', '-q', '--detach');

  assert.equal(await trunkOf(root), undefined, 'this repository has no trunk to add');
  const out = await commitGraph(root, { limit: 5 });
  assert.ok(out);
  assert.equal(out.tips.length, BRANCH_CAP);
  assert.equal(out.tipsTruncated, true, 'the run-branch query’s own cap must report');
});

test('a named-ref walk is never called partial by a window it did not consult', async () => {
  // QA round 4's Low: `?ref=X&all=1` ORed in the general window's truncation on
  // a walk that only ever looked at X.
  const { root } = fixture();
  for (let n = 0; n < BRANCH_CAP + 3; n += 1) git(root, 'branch', `bulk/${n}`);
  const named = await commitGraph(root, { refs: ['pe/demo'], all: true, limit: 5 });
  assert.ok(named);
  assert.deepEqual(named.tips, ['pe/demo']);
  assert.equal(named.tipsTruncated, false, 'one branch, fully walked');
});

test('a named ref this repository does not have is a REFUSAL, not the default graph', async () => {
  // QA round 4's Low: it silently answered the default graph, so a client asking
  // about a branch that had been deleted got a picture of something else.
  const { root } = fixture();
  assert.equal(await commitGraph(root, { refs: ['ghost'] }), null);
  assert.equal(await commitGraph(root, { refs: ['--all'] }), null, 'refused by shape counts too');
  // Partial resolution is honoured — the caller gets what this repository can give.
  const partial = await commitGraph(root, { refs: ['ghost', 'pe/demo'], limit: 2 });
  assert.ok(partial);
  assert.deepEqual(partial.tips, ['pe/demo']);
  // …and naming nothing at all is still the default walk, not a refusal.
  assert.ok(await commitGraph(root, { limit: 2 }));
});

test('a repeated ref is de-duplicated BEFORE the cap', async () => {
  // QA round 3's Low: `?ref=main` three hundred times filled the window with
  // one branch and reported a truncation that never happened.
  const { root } = fixture();
  const out = await commitGraph(root, { refs: Array.from({ length: BRANCH_CAP + 5 }, () => 'main') });
  assert.deepEqual(out.tips, ['main']);
  assert.equal(out.tipsTruncated, false);
});

/* ================================================================== *
 * Branches
 * ================================================================== */

test('branches carry ahead/behind the trunk, the right way round', async () => {
  const { root } = fixture();
  advance(root, 'pe/demo', 2);
  advance(root, 'main', 1);

  const out = await branchList(root);
  assert.equal(out.trunk, 'main');
  const demo = out.branches.find((b) => b.name === 'pe/demo');
  assert.ok(demo, 'pe/demo must be listed');
  // Two of its own, one it has not got. A swapped pair reads (1, 2).
  assert.equal(demo.ahead, 2);
  assert.equal(demo.behind, 1);
  assert.deepEqual(demo.run, { slug: 'demo' });
  assert.equal(demo.trunk, false);

  const main = out.branches.find((b) => b.name === 'main');
  assert.equal(main?.trunk, true);
  assert.equal(out.truncated, false);
  assert.equal(out.divergenceTruncated, false);
});

test('divergences answers the same numbers whichever path git takes', async () => {
  const { root } = fixture();
  advance(root, 'pe/demo', 2);
  advance(root, 'main', 1);
  const names = (await localRefs(root)).refs.map((ref) => ref.name);

  const out = await divergences(root, 'main', names);
  assert.deepEqual(out.map.get('pe/demo'), { ahead: 2, behind: 1 });
  // The trunk is never measured against itself.
  assert.equal(out.map.has('main'), false);
  assert.equal(out.truncated, false);
});

test('a lane branch says which phase it belongs to, and who is holding it', async () => {
  const { root, stateDir } = fixture();
  git(root, 'branch', 'pe/demo-p4');
  const lane = join(stateDir, 'worktrees', 'run1', 'p4');
  git(root, 'worktree', 'add', '-q', lane, 'pe/demo-p4');

  const out = await branchList(root, { managed: [stateDir] });
  const p4 = out.branches.find((b) => b.name === 'pe/demo-p4');
  assert.ok(p4);
  assert.deepEqual(p4.run, { slug: 'demo', phase: 4 });
  assert.deepEqual(p4.heldBy, [lane]);
  // A branch nobody is standing on says so by omission, not by an empty list.
  const demo = out.branches.find((b) => b.name === 'pe/demo');
  assert.equal('heldBy' in (demo ?? {}), false);
});

/* ================================================================== *
 * Checkouts, and the run join that outlives the run
 * ================================================================== */

/** A run record, as `listRuns` would hand one back. */
function runState(over: Partial<RunState> & { id: string; slug: string }): RunState {
  return {
    root: '/repo', status: 'finished', autonomy: 'auto', model: 'claude-opus-5',
    phaseBudgetUsd: null, runBudgetUsd: null, spentUsd: 0,
    maxConsecutiveFailures: 3, consecutiveFailures: 0,
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    activePhase: null, phases: {},
    ...over,
  } as unknown as RunState;
}

test('treeClaims attributes a run root and every lane, from the RECORD', () => {
  const claims = treeClaims([{
    state: runState({
      id: 'run1', slug: 'demo', workRoot: '/state/worktrees/run1/integration',
      phases: {
        4: { worktree: '/state/worktrees/run1/p4' },
        5: { worktree: '/state/worktrees/run1/p5' },
        6: {},
      },
    } as Partial<RunState> & { id: string; slug: string }),
    live: false,
  }]);

  assert.equal(claims.get('/state/worktrees/run1/integration')?.phase, undefined);
  assert.equal(claims.get('/state/worktrees/run1/p4')?.phase, 4);
  assert.equal(claims.get('/state/worktrees/run1/p5')?.phase, 5);
  assert.equal(claims.size, 3, 'a phase with no tree claims none');
  assert.equal(claims.get('/state/worktrees/run1/p4')?.runId, 'run1');
  assert.equal(claims.get('/state/worktrees/run1/p4')?.live, false);
});

test('attributeCheckouts prefers a record over a name, and names the debris', () => {
  const entries: CheckoutEntry[] = [
    { dir: '/repo', root: true, managed: false, prunable: false, branch: 'main' },
    { dir: '/state/worktrees/run1/p4', root: false, managed: true, prunable: false, branch: 'pe/demo-p4' },
    { dir: '/state/worktrees/run1/integration', root: false, managed: true, prunable: false, branch: 'pe/demo' },
    { dir: '/state/worktrees/dead/p9', root: false, managed: true, prunable: false, branch: 'pe/gone-p9' },
    { dir: '/home/op/repo-pe-demo', root: false, managed: false, prunable: false, branch: 'pe/demo' },
  ];
  const claims = treeClaims([{
    state: runState({
      id: 'run1', slug: 'demo', status: 'finished',
      workRoot: '/state/worktrees/run1/integration',
      phases: { 4: { worktree: '/state/worktrees/run1/p4' } },
    } as Partial<RunState> & { id: string; slug: string }),
  }]);

  const rows = attributeCheckouts(entries, claims);
  const by = (dir: string) => rows.find((row) => row.dir === dir)!;

  assert.equal(by('/repo').role, 'root');
  assert.equal(by('/state/worktrees/run1/p4').role, 'lane');
  assert.equal(by('/state/worktrees/run1/p4').via, 'record');
  assert.equal(by('/state/worktrees/run1/p4').run?.phase, 4);
  assert.equal(by('/state/worktrees/run1/p4').run?.status, 'finished');
  assert.equal(by('/state/worktrees/run1/integration').role, 'run');
  // A record and a NAME both point at this tree; the record wins, and `via`
  // says so. Inverting that would attribute a tree by a string an operator can
  // pick for themselves while ignoring the console's own written record.
  assert.equal(by('/state/worktrees/run1/integration').via, 'record');
  assert.equal(by('/state/worktrees/run1/integration').run?.runId, 'run1');

  // The row this whole surface exists for: managed, unclaimed by any surviving
  // record — a console that was killed left it, and nothing else reports it.
  assert.equal(by('/state/worktrees/dead/p9').role, 'debris');
  assert.equal(by('/state/worktrees/dead/p9').via, 'branch');
  assert.deepEqual(by('/state/worktrees/dead/p9').run, { slug: 'gone', phase: 9 });

  // An operator's own tree that happens to stand on one of our branches is
  // attributed by NAME and labelled as such — a guess, not evidence.
  assert.equal(by('/home/op/repo-pe-demo').role, 'operator');
  assert.equal(by('/home/op/repo-pe-demo').via, 'branch');
});

test('staging is the tree pe/integration lives in — NOT any path ending in "integration"', () => {
  // QA round 1's High, and the pin is the pair. The console's staging checkout
  // is `<stateRoot>/staging` (`worktree.ts` §stagingNames); a RUN's own tree is
  // `<runDir>/worktrees/<runId>/integration` (§laneNames). A regex over the
  // path shape got them exactly backwards, so the one tree that must never be
  // swept reported `debris` and an orphaned run tree reported `staging`.
  const stateRoot = '/state';
  const staging = stagingNames(stateRoot).dir;
  assert.equal(staging, '/state/staging', 'the fixture must use the real spelling');

  const rows = attributeCheckouts([
    { dir: staging, root: false, managed: true, prunable: false, branch: 'pe/integration' },
    { dir: '/state/demo/worktrees/dead/integration', root: false, managed: true, prunable: false, branch: 'pe/gone' },
  ], new Map(), { staging: [staging] });

  const by = (dir: string) => rows.find((row) => row.dir === dir)!;
  assert.equal(by(staging).role, 'staging');
  assert.equal(by('/state/demo/worktrees/dead/integration').role, 'debris',
    'an orphaned run tree is debris however its directory is spelled');

  // And with no staging directory known, nothing is promoted to `staging` on a
  // guess — an unknown fact reads as the conservative answer.
  const blind = attributeCheckouts([
    { dir: staging, root: false, managed: true, prunable: false, branch: 'pe/integration' },
  ], new Map());
  assert.equal(blind[0].role, 'debris');
});

test('attribution is one of THREE shapes, and a name-only row carries no record fields', () => {
  // QA round 1's Medium. `runId`/`status`/`live` come from a RECORD, and a
  // `via: 'branch'` row has none — which is exactly the orphan row a reclaim
  // surface renders. The type is a discriminated union on `via` so Phase 9's
  // compiler asks the question; these assertions are the runtime half.
  const rows = attributeCheckouts([
    { dir: '/home/op/repo-pe-demo', root: false, managed: false, prunable: false, branch: 'pe/demo-p4' },
    { dir: '/state/worktrees/run1/p4', root: false, managed: true, prunable: false, branch: 'pe/demo-p4' },
    { dir: '/somewhere/else', root: false, managed: false, prunable: false, branch: 'main' },
  ], treeClaims([{
    state: runState({
      id: 'run1', slug: 'demo', status: 'finished',
      phases: { 4: { worktree: '/state/worktrees/run1/p4' } },
    } as Partial<RunState> & { id: string; slug: string }),
    live: true,
  }]));

  const [byName, byRecord, unattributed] = rows;

  assert.equal(byName.via, 'branch');
  assert.deepEqual(byName.run, { slug: 'demo', phase: 4 });
  for (const field of ['runId', 'status', 'live']) {
    assert.equal(field in (byName.run ?? {}), false, `a name-only row must not carry ${field}`);
  }

  assert.equal(byRecord.via, 'record');
  assert.equal(byRecord.run?.slug, 'demo');
  assert.equal((byRecord.run as { runId?: string }).runId, 'run1');
  assert.equal((byRecord.run as { live?: boolean }).live, true);

  // The third arm: neither a record nor a name we recognise.
  assert.equal(unattributed.via, undefined);
  assert.equal(unattributed.run, undefined);
});

test('no checkout row carries a disk figure — this surface never measures one', async () => {
  // QA round 1's Medium: `CheckoutEntry` has the field because the five-minute
  // probe fills it; a browse read must not pay a `du` per tree, so the type
  // must not advertise a number that is always absent.
  const { root, stateDir } = fixture();
  const out = await checkoutList({ root, managed: [stateDir], staging: [stagingNames(stateDir).dir], runs: [] });
  assert.ok(out.checkouts.length > 0);
  for (const row of out.checkouts) {
    assert.equal('disk' in row, false, `${row.dir} carried a disk figure`);
  }
});

test('a real lane checkout is attributed AFTER its run has stopped', async () => {
  const { root, stateDir } = fixture();
  git(root, 'branch', 'pe/demo-p4');
  const lane = join(stateDir, 'worktrees', 'run1', 'p4');
  git(root, 'worktree', 'add', '-q', lane, 'pe/demo-p4');

  // `live: false` is the point: `runGit` answers null for a run nobody is
  // driving, so before this surface a stopped run's lane was unattributable.
  const out = await checkoutList({
    root,
    managed: [stateDir],
    runs: [{
      state: runState({
        id: 'run1', slug: 'demo', status: 'finished',
        phases: { 4: { worktree: lane } },
      } as Partial<RunState> & { id: string; slug: string }),
      live: false,
    }],
  });

  const row = out.checkouts.find((c) => c.dir === lane);
  assert.ok(row, `the lane must be in ${out.checkouts.map((c) => c.dir).join(', ')}`);
  assert.equal(row.role, 'lane');
  assert.equal(row.via, 'record');
  assert.equal(row.run?.slug, 'demo');
  assert.equal(row.run?.phase, 4);
  assert.equal(row.run?.live, false);
  assert.equal(row.managed, true);
  assert.equal(row.branch, 'pe/demo-p4');

  const rootRow = out.checkouts.find((c) => c.root);
  assert.equal(rootRow?.role, 'root');
});

test('the run join survives a SYMLINKED state directory', async () => {
  // The defect this pins, found by the first run of this suite: `checkouts()`
  // reports what git prints (symlinks resolved) and a run record stores what
  // the console constructed. On macOS `$TMPDIR` is `/var/folders/…`, a symlink
  // to `/private/var/folders/…`, so the two spellings of ONE directory differ
  // — and a join done with `resolve()` attributes nothing at all: every lane
  // of every run reads as unclaimed debris.
  const base = mkdtempSync(join(tmpdir(), 'p8-link-'));
  trash.push(base);
  const root = join(base, 'repo');
  const stateDir = join(base, 'state');
  execFileSync('mkdir', ['-p', root, stateDir]);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'a\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'branch', 'pe/demo');
  git(root, 'branch', 'pe/demo-p4');

  // Deliberately the UN-realpath'd spelling on both the fixture and the
  // record, which is what a run file actually holds. BOTH arms of the join are
  // exercised — `workRoot` (the run's own tree) and `phases[N].worktree` (a
  // lane's) are two separate lookups, and one of them being right proves
  // nothing about the other.
  const lane = join(stateDir, 'worktrees', 'run1', 'p4');
  const own = join(stateDir, 'worktrees', 'run1', 'integration');
  git(root, 'worktree', 'add', '-q', lane, 'pe/demo-p4');
  git(root, 'worktree', 'add', '-q', own, 'pe/demo');
  assert.notEqual(realpathSync(base), base, 'this test needs a symlinked tmpdir to mean anything');

  const out = await checkoutList({
    root,
    managed: [stateDir],
    runs: [{
      state: runState({
        id: 'run1', slug: 'demo', status: 'finished',
        workRoot: own, phases: { 4: { worktree: lane } },
      } as Partial<RunState> & { id: string; slug: string }),
      live: false,
    }],
  });

  const row = out.checkouts.find((c) => c.dir === realpathSync(lane));
  assert.ok(row, 'the lane must be listed under its real path');
  assert.equal(row.role, 'lane', 'a symlinked state dir must not turn a lane into debris');
  assert.equal(row.via, 'record');
  assert.equal(row.run?.phase, 4);

  const runRow = out.checkouts.find((c) => c.dir === realpathSync(own));
  assert.ok(runRow, 'the run tree must be listed under its real path');
  assert.equal(runRow.role, 'run', 'a symlinked state dir must not turn a run tree into debris');
  assert.equal(runRow.via, 'record');
  assert.equal(runRow.run?.phase, undefined);
});

test('a detached checkout is named the way the lock names it', async () => {
  const { root, stateDir } = fixture();
  const sha = git(root, 'rev-parse', 'HEAD');
  const detached = join(stateDir, 'worktrees', 'run2', 'integration');
  git(root, 'worktree', 'add', '-q', '--detach', detached, sha);

  const out = await checkoutList({ root, managed: [stateDir], staging: [stagingNames(stateDir).dir], runs: [] });
  const row = out.checkouts.find((c) => c.dir === detached);
  assert.ok(row);
  assert.equal(row.branch, undefined, 'a detached checkout stands on no branch');
  assert.equal(row.detached, `detached@${sha.slice(0, 12)}`);
});

/* ================================================================== *
 * Targets — the allowlist
 * ================================================================== */

test('targets are the root plus what git registered, and an unknown key is refused', async () => {
  const { root, stateDir } = fixture();
  git(root, 'branch', 'pe/demo-p4');
  const lane = join(stateDir, 'worktrees', 'run1', 'p4');
  git(root, 'worktree', 'add', '-q', lane, 'pe/demo-p4');

  const targets = await repoTargets({ root, managed: [stateDir] });
  assert.equal(targets[0].key, 'root');
  assert.equal(targets[0].kind, 'root');
  assert.equal(targets[0].dir, root);
  assert.ok(targets.some((t) => t.dir === lane && t.kind === 'linked'));
  // No duplicate for the root, which `worktree list` also prints.
  assert.equal(targets.filter((t) => t.dir === root).length, 1);

  assert.equal(pickTarget(targets, undefined)?.key, 'root');
  assert.equal(pickTarget(targets, 'root')?.dir, root);
  // The refusal, and its shape: null, never a quiet fall back to the root.
  for (const bad of ['/etc', '../../etc', 'nope', join(stateDir, 'worktrees', 'run9')]) {
    assert.equal(pickTarget(targets, bad), null, `${bad} must not resolve`);
  }
});

test('a superproject answers for every initialised submodule, and the registry spans them all', async () => {
  // A docs hub is several repositories: the root that holds the plans and the
  // submodules the phases edit. The Repo destination used to list the root and
  // stop — a hub console showed one repository's branches and none of the trees
  // a phase's worktree or a reviewer's checkout of a submodule actually are.
  const { base, root, stateDir } = fixture();

  // A second repository, added as the submodule `lib` (file transport must be
  // allowed explicitly since git 2.38).
  const libSrc = join(base, 'libsrc');
  execFileSync('mkdir', ['-p', libSrc]);
  git(libSrc, 'init', '-q', '-b', 'main');
  writeFileSync(join(libSrc, 'lib.txt'), 'lib\n');
  git(libSrc, 'add', '-A');
  git(libSrc, 'commit', '-q', '-m', 'lib 1');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', libSrc, 'lib');
  git(root, 'commit', '-q', '-m', 'add lib');
  const lib = join(root, 'lib');
  // A declared submodule nobody initialised: listed in `.gitmodules`, no `.git`.
  writeFileSync(join(root, '.gitmodules'), `${readFileSync(join(root, '.gitmodules'), 'utf8')}[submodule "ghost"]\n\tpath = ghost\n\turl = ./ghost\n`);
  // And a linked checkout OF THE SUBMODULE, the shape a lane or a reviewer makes.
  git(lib, 'branch', 'pe/demo-p2');
  const lane = join(stateDir, 'worktrees', 'run1', 'lib-p2');
  git(lib, 'worktree', 'add', '-q', lane, 'pe/demo-p2');

  const targets = await repoTargets({ root, managed: [stateDir] });
  assert.equal(targets[0].key, 'root');
  const sub = targets.find((t) => t.key === 'lib');
  assert.ok(sub, `the submodule is a target: ${JSON.stringify(targets)}`);
  assert.equal(sub.kind, 'submodule');
  assert.equal(sub.dir, realpathSync(lib));
  assert.equal(sub.label, 'lib');
  assert.ok(targets.some((t) => t.dir === realpathSync(lane) && t.kind === 'linked'), 'the submodule\'s worktree is a target too');
  assert.ok(!targets.some((t) => t.key === 'ghost'), 'an uninitialised submodule answers nothing');
  assert.equal(pickTarget(targets, 'lib')?.dir, realpathSync(lib));

  // Branches of the submodule, through the same resolver a route uses.
  const branches = await branchList(pickTarget(targets, 'lib')!.dir, { managed: [stateDir] });
  assert.ok(branches.branches.some((b) => b.name === 'pe/demo-p2'));

  const out = await checkoutList({ root, managed: [stateDir], staging: [stagingNames(stateDir).dir], runs: [] });
  const rows = out.checkouts;
  assert.equal(rows.find((c) => c.dir === realpathSync(root))?.repo, 'root');
  const main = rows.find((c) => c.dir === realpathSync(lib));
  assert.ok(main, 'the submodule\'s own checkout is in the registry');
  assert.equal(main.repo, 'lib');
  assert.equal(main.role, 'root', 'its main checkout is that repository\'s root tree');
  const laneRow = rows.find((c) => c.dir === realpathSync(lane));
  assert.ok(laneRow, 'and so is its worktree');
  assert.equal(laneRow.repo, 'lib');
  assert.equal(laneRow.branch, 'pe/demo-p2');
  // Every row names its repository — no third shape.
  assert.ok(rows.every((c) => typeof c.repo === 'string' && c.repo.length > 0));
  // The submodule walk is what a plain single repository never pays for.
  assert.deepEqual(submoduleDirs(root).map((s) => s.rel), ['lib']);
});

test('the root short-circuit is byte-identical to the first row of the list', async () => {
  // The service answers a caller who named no repository WITHOUT assembling
  // the allowlist — that would cost a `worktree list` and a scan of every
  // plan's run records to resolve the absence of a parameter. The only way
  // that stays honest is if the two spellings of the root cannot drift.
  const { root, stateDir } = fixture();
  git(root, 'worktree', 'add', '-q', join(stateDir, 'worktrees', 'run1', 'p4'), 'pe/demo');
  assert.deepEqual(rootTarget(root), (await repoTargets({ root, managed: [stateDir] }))[0]);
  // …including the symlink resolution, which is where they would differ first.
  assert.equal(rootTarget(root).dir, realpathSync(root));
});

test('a mount is admitted only as a repository-relative path', async () => {
  const { root, stateDir } = fixture();
  const targets = await repoTargets({
    root, managed: [stateDir], staging: [stagingNames(stateDir).dir],
    mounts: ['web-admin', '../../etc', '/etc', '-x', 'ok/nested'],
  });
  const labels = targets.filter((t) => t.kind === 'mount').map((t) => t.label);
  assert.deepEqual(labels, ['web-admin', 'ok/nested']);
});

/* ================================================================== *
 * Diffs
 * ================================================================== */

test('a diff lists files always and hunks only on request, both bounded', async () => {
  const { root } = fixture();
  writeFileSync(join(root, 'f1.txt'), 'changed\n');
  writeFileSync(join(root, 'new.txt'), 'added\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'edit');

  const list = await repoDiff(root, { base: 'HEAD~1', tip: 'HEAD' });
  assert.ok(list);
  assert.equal(list.fileCount, 2);
  assert.equal(list.filesTruncated, false);
  assert.deepEqual(list.files.map((f) => f.path).sort(), ['f1.txt', 'new.txt']);
  // No path asked for, so no patch — the whole point of the split.
  assert.equal(list.patch, undefined);

  const one = await repoDiff(root, { base: 'HEAD~1', tip: 'HEAD', path: 'f1.txt' });
  assert.ok(one?.patch);
  assert.equal(one.patch.path, 'f1.txt');
  assert.match(one.patch.text, /-base 1/);
  assert.match(one.patch.text, /\+changed/);
  // The other file's hunks are NOT in it.
  assert.equal(/new\.txt/.test(one.patch.text), false);
  assert.equal(one.patch.truncated, false);
  assert.equal(one.patch.failed, false);
});

test('a patch over the byte budget is cut and SAYS it was cut', async () => {
  const { root } = fixture();
  writeFileSync(join(root, 'big.txt'), 'x'.repeat(400_000).replace(/x{80}/g, (m) => `${m}\n`));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'big');

  const cut = await repoDiff(root, { base: 'HEAD~1', tip: 'HEAD', path: 'big.txt', maxBytes: 64 * 1024 });
  assert.ok(cut?.patch);
  assert.equal(cut.patch.truncated, true, 'a cut diff must say so, not read as empty');
  assert.ok(cut.patch.text.length <= 64 * 1024);
  // …and the FILE LIST is still complete and honest, which is what makes a
  // truncated patch survivable.
  assert.equal(cut.fileCount, 1);
  assert.equal(cut.filesTruncated, false);

  // A byte budget past the cap is CLAMPED, not honoured — and the only way to
  // tell a clamp from a default is a diff bigger than the cap. An unclamped
  // budget is a real memory door: it becomes `execFile`'s `maxBuffer`, so a
  // caller asking for a gigabyte gets a gigabyte-sized buffer.
  const huge = 'y'.repeat(PATCH_BYTES_MAX + 512 * 1024).replace(/y{80}/g, (m) => `${m}\n`);
  writeFileSync(join(root, 'huge.txt'), huge);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'huge');

  const clamped = await repoDiff(root, {
    base: 'HEAD~1', tip: 'HEAD', path: 'huge.txt', maxBytes: PATCH_BYTES_MAX * 100,
  });
  assert.ok(clamped?.patch);
  assert.equal(clamped.patch.truncated, true, 'a budget past the cap must still be capped');
  assert.ok(clamped.patch.text.length <= PATCH_BYTES_MAX);
});

test('an inherited GIT_DIR cannot steer a browse read to another repository', async () => {
  // QA round 1's Medium. The four surfaces that go through this module's own
  // `git()` were already fenced; the diff surface and the checkout registry
  // reach `git.ts` and `worktree.ts`, which inherit. An operator's shell (or a
  // parent process) exporting GIT_DIR made those two answer about a DIFFERENT
  // repository than the one the caller named.
  const a = fixture();
  const b = fixture();
  writeFileSync(join(a.root, 'only-in-a.txt'), 'a\n');
  git(a.root, 'add', '-A');
  git(a.root, 'commit', '-q', '-m', 'only in a');
  // A checkout that exists ONLY in `a`, so the registry read has something to
  // be wrong about: `worktree list` under a stolen GIT_DIR reports `b`'s.
  const aLane = join(a.stateDir, 'worktrees', 'run1', 'p4');
  git(a.root, 'worktree', 'add', '-q', aLane, 'pe/demo');

  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = join(b.root, '.git');
  try {
    const diff = await repoDiff(a.root, { base: 'HEAD~1', tip: 'HEAD' });
    assert.ok(diff, 'the diff must still resolve against the repository it was ASKED about');
    assert.deepEqual(diff.files.map((f) => f.path), ['only-in-a.txt']);

    const out = await checkoutList({ root: a.root, managed: [a.stateDir], staging: [stagingNames(a.stateDir).dir], runs: [] });
    assert.deepEqual(out.checkouts.map((c) => c.dir).sort(),
      [realpathSync(a.root), realpathSync(aLane)].sort());

    // `heldBy` is the branch surface's own registry read, and it is a SECOND
    // call site — one of them being fenced proves nothing about the other.
    const branches = await branchList(a.root, { managed: [a.stateDir] });
    const demo = branches.branches.find((br) => br.name === 'pe/demo');
    assert.ok(demo, 'the branch list must still be the repository we asked about');
    assert.deepEqual(demo.heldBy, [realpathSync(aLane)]);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  }
});

test('a patch carries the standard a/ and b/ prefixes whatever the reader configured', async () => {
  // QA round 2's Low: `diff.mnemonicPrefix` renames them per operation (`c/`
  // and `w/` for a working-tree diff), so a client parsing `+++ b/<path>` reads
  // every path wrong on a machine that has it set. The flags are pinned, so an
  // operator's own config cannot change the wire format.
  const { root } = fixture();
  git(root, 'config', 'diff.mnemonicPrefix', 'true');
  writeFileSync(join(root, 'f1.txt'), 'changed\n');

  const tree = await repoDiff(root, { base: 'HEAD', path: 'f1.txt' });
  assert.ok(tree?.patch);
  assert.match(tree.patch.text, /^--- a\/f1\.txt$/m);
  assert.match(tree.patch.text, /^\+\+\+ b\/f1\.txt$/m);
  assert.equal(/^--- c\//m.test(tree.patch.text), false, 'a mnemonic prefix must not reach a client');
});

test('the default patch carries context lines — an absent unified is not zero', async () => {
  // The runtime half of QA round 2's High. The route reader was the defect, but
  // the property a client depends on is this one: ask for a patch and get
  // readable context, not a bare changed line.
  const { root } = fixture();
  // Nine lines, one edited in the middle — the only shape on which "context"
  // and "no context" are distinguishable at all.
  const lines = (mid: string) => ['a', 'b', 'c', 'd', mid, 'f', 'g', 'h', 'i'].join('\n') + '\n';
  writeFileSync(join(root, 'wide.txt'), lines('BEFORE'));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'wide');
  writeFileSync(join(root, 'wide.txt'), lines('AFTER'));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'edit');

  const patch = await repoDiff(root, { base: 'HEAD~1', tip: 'HEAD', path: 'wide.txt' });
  assert.ok(patch?.patch);
  // Three lines either side is git's default and what a reader expects to see.
  assert.match(patch.patch.text, /^ b$/m, 'the default patch must carry context lines');
  assert.match(patch.patch.text, /^ h$/m);

  const bare = await repoDiff(root, { base: 'HEAD~1', tip: 'HEAD', path: 'wide.txt', unified: 0 });
  assert.ok(bare?.patch);
  assert.equal(/^ b$/m.test(bare.patch.text), false, 'unified=0 must carry none');
  assert.notEqual(bare.patch.text, patch.patch.text);
});

test('a base with no tip diffs the WORKING TREE, which is what an in-flight phase changed', async () => {
  const { root } = fixture();
  writeFileSync(join(root, 'f1.txt'), 'uncommitted\n');

  const out = await repoDiff(root, { base: 'HEAD' });
  assert.ok(out);
  assert.deepEqual(out.files.map((f) => f.path), ['f1.txt']);
  assert.equal(out.tip, undefined);
});

/* ================================================================== *
 * Settle history
 * ================================================================== */

/** A journal line, as `Journal.read` hands one back. */
function entry(seq: number, event: string, time: string, over: Partial<JournalEntry> = {}): JournalEntry {
  return { seq, event, time, ...over };
}

test('settle history joins the record and the journal, newest first', () => {
  const out = settleHistory([
    {
      state: runState({
        id: 'run1', slug: 'demo', gitMode: 'new-branch', settle: 'pr',
        settledAt: '2026-09-01T12:00:00Z',
      } as Partial<RunState> & { id: string; slug: string }),
      entries: [
        entry(1, 'phase.worktree-landed', '2026-09-01T10:00:00Z', { phase: 4 }),
        entry(2, 'phase.start', '2026-09-01T10:30:00Z', { phase: 5 }),
        entry(3, 'phase.worktree-failed', '2026-09-01T11:00:00Z', { phase: 5, data: { reason: 'conflict in a.ts' } }),
        entry(4, 'run.settled', '2026-09-01T12:00:00Z', { data: { strategy: 'pr' } }),
      ],
    },
  ]);

  assert.equal(out.truncated, false);
  // Newest first, and `phase.start` is not part of the settle story.
  assert.deepEqual(out.events.map((e) => e.kind), ['settled', 'settled', 'failed', 'landed']);
  assert.deepEqual(out.events.map((e) => e.at), [
    '2026-09-01T12:00:00Z', '2026-09-01T12:00:00Z', '2026-09-01T11:00:00Z', '2026-09-01T10:00:00Z',
  ]);
  // The record row and the journal row for the same moment are BOTH kept, and
  // say which they are — they carry different evidence.
  assert.deepEqual(out.events.slice(0, 2).map((e) => e.via).sort(), ['journal', 'record']);
  // Every row carries the run branch, spelled the way the lock spells it.
  for (const event of out.events) {
    assert.equal(event.branch, 'pe/demo');
    assert.equal(event.strategy, 'pr');
    assert.equal(event.slug, 'demo');
    assert.equal(event.runId, 'run1');
  }
  const failed = out.events.find((e) => e.kind === 'failed');
  assert.equal(failed?.phase, 5);
  assert.equal(failed?.detail, 'conflict in a.ts');
});

test('a default-branch run has no branch to name, and a detached one is named by where it stands', () => {
  const out = settleHistory([
    {
      state: runState({ id: 'a', slug: 'plain', settledAt: '2026-09-01T01:00:00Z' } as Partial<RunState> & { id: string; slug: string }),
    },
    {
      state: runState({
        id: 'b', slug: 'loose', gitMode: 'new-branch', detachAt: 'abcdef0123456789',
        settledAt: '2026-09-01T02:00:00Z',
      } as Partial<RunState> & { id: string; slug: string }),
    },
  ]);
  const plain = out.events.find((e) => e.slug === 'plain');
  const loose = out.events.find((e) => e.slug === 'loose');
  assert.equal('branch' in (plain ?? {}), false, 'a default-branch run owns no branch');
  assert.equal(loose?.branch, 'detached@abcdef012345');
});

test('a run that never settled contributes nothing, and the list is capped', () => {
  const quiet = settleHistory([{ state: runState({ id: 'x', slug: 'never' }) }]);
  assert.deepEqual(quiet.events, []);

  const many = settleHistory([{
    state: runState({ id: 'y', slug: 'loud' }),
    entries: Array.from({ length: SETTLE_CAP + 5 }, (_unused, i) => entry(i, 'run.settled', `2026-09-01T00:00:${String(i).padStart(2, '0')}Z`)),
  }]);
  assert.equal(many.events.length, SETTLE_CAP);
  assert.equal(many.truncated, true);
});

test('the settle vocabulary is the journal’s own words', () => {
  // A typo here is invisible at runtime — the event simply never matches and
  // the history silently loses a row. Pinning the list is what makes a rename
  // in the runner a red test rather than an empty page.
  for (const name of ['run.settled', 'phase.worktree-landed', 'run.branches-pruned']) {
    assert.ok(SETTLE_EVENT_NAMES.includes(name), `${name} must be part of the settle story`);
  }
  assert.equal(SETTLE_EVENT_NAMES.includes('phase.start'), false);
});

/* ================================================================== *
 * Caps exist and are sane
 * ================================================================== */

test('every cap is a positive number the surfaces actually report against', () => {
  for (const [name, value] of Object.entries({
    BRANCH_CAP, DIFF_FILE_CAP, GRAPH_LIMIT_MAX, PATCH_BYTES_MAX, SETTLE_CAP,
  })) {
    assert.equal(typeof value, 'number', `${name} must be a number`);
    assert.ok(value > 0, `${name} must be positive`);
  }
});

test('a directory that is not a repository answers empty rather than throwing', async () => {
  const base = mkdtempSync(join(tmpdir(), 'p8-bare-'));
  trash.push(base);
  assert.deepEqual(await localRefs(base), { refs: [], truncated: false });
  const graph = await commitGraph(base);
  assert.deepEqual(graph.commits, []);
  assert.deepEqual(graph.tips, []);
  const branches = await branchList(base);
  assert.deepEqual(branches.branches, []);
});
