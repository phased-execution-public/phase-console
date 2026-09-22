/**
 * The never-push invariant, as a test rather than a promise.
 *
 * This console reads a repository, spawns sessions that work in it, and writes
 * artefacts beside it. It does not publish. Nothing in `viewer/server` may run
 * a git verb that talks to a remote, and nothing may pass `--git` to a
 * phased-execution script — that flag is what makes `phase-lock.sh`,
 * `qa-record.sh` and friends commit AND push their writes.
 *
 * Why it is a gate and not a convention. `--allow-run` spawns unattended
 * sessions that edit a repository for hours; the board they steer by is parsed
 * from markdown. One misparse away from a bad boarding is survivable while the
 * blast radius is a local branch. It stops being survivable the moment the
 * console can put that branch somewhere other people build on — and in THIS
 * repository a push to `main` is a plugin release. So the handover is a file
 * (`server/landing.ts`), and this test is what keeps it that way when somebody
 * later reaches for the obvious two-line convenience.
 *
 * ## The one exemption, and why it is a FILE
 *
 * Phase 22 (worktree-per-phase) needs the console to create a linked checkout
 * and fold a lane's commits back into the run branch. That is `worktree` and
 * `merge` — a local checkout and a local integration, no remote in sight, but
 * unmistakably repository-mutating. The choice was between widening the ban
 * list for all sixty-odd server files and exempting ONE file, and the exemption
 * won: `server/runner/worktree.ts` may run the verbs in `WORKTREE_VERBS`
 * and nothing else, no other file may run any of them, and the remote-talking
 * verbs stay banned there exactly as they are banned everywhere. Three separate
 * assertions, so widening any one of them is a visible edit to this file.
 *
 * What it does NOT claim:
 *   - the sessions the console spawns commit, and can push. That is a session
 *     doing what its phase says, under its own account — and the console's
 *     permission layer is where it is governed, not here: a `git push` from a
 *     session is DENIED unless the run is a new-branch run with Open a PR on,
 *     in which case it becomes an `ask` — a card and one human tap
 *     (`openPrCarveOut`, `runner/approvals.ts`). Either way a person is in the
 *     loop; what this file forbids is the SERVER pushing by itself.
 *   - `--allow-terminal` opens a real shell. The operator's own hands are not
 *     this invariant's business.
 *   - the scripts themselves accept `--git` and use it. The rule is that the
 *     CONSOLE never passes it.
 *
 * The method is deliberately syntactic: every array literal made entirely of
 * string literals is an argv in this codebase, and an argv is what gets
 * executed. Prose is exempt on purpose — `recovery.ts` prints `--git` in the
 * commands it tells an operator to run by hand, and `review.ts` parses
 * `diff --git` headers. Banning the characters would break both and prove
 * nothing; banning the ARGUMENT is the real rule.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { argvLiterals } from './argv-scan.ts';
import { PUSH_ARGV } from '../shared/landing-model.js';
import { PUSH_REF, pushRef } from '../server/runner/worktree.ts';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'server');

/**
 * Git verbs that reach a remote. Banned in EVERY server file, the worktree
 * module included — the exemption below is about local repository mutation,
 * and publication is a different thing that nothing here is allowed to do.
 */
const REMOTE_VERBS = ['push', 'fetch', 'pull', 'remote', 'clone', 'init'];

/**
 * Git verbs that change the repository without talking to anyone. Banned
 * everywhere except `EXEMPT_FILE`.
 */
const MUTATING_VERBS = [
  'commit', 'merge', 'rebase', 'reset', 'checkout', 'restore',
  'am', 'apply', 'cherry-pick', 'revert', 'stash', 'clean',
  'update-ref', 'symbolic-ref', 'filter-branch', 'gc', 'prune',
];

const FORBIDDEN = [...REMOTE_VERBS, ...MUTATING_VERBS];

/**
 * The ONE file allowed to mutate a repository, and the only verbs it may use.
 *
 * `worktree` was always going to be here — the earlier version of this gate
 * left it off the ban list with a note naming this phase. `merge` is the half
 * that had to be decided: a lane's commits reach the run branch or the feature
 * does not exist. `rev-parse`/`rev-list`/`diff` are reads it needs in the same
 * breath (does this branch exist, how far ahead is it, which files conflicted).
 *
 * `status` is the sixth and it was added deliberately, with `sweepStale`. That
 * function decides whether to DELETE a checkout, `worktree remove --force`
 * deletes a dirty one without asking, and `diff` cannot see the file a killed
 * session created and never added — so `status --porcelain` is the only verb
 * that can answer "is there work in here". It is a READ; it is in the
 * console-wide `ALLOWED` list below already. Widening this list is the
 * reviewable act, and this is what the review was for.
 *
 * `merge-tree` is the seventh, added with the branch radar (P9). It is the one
 * verb that answers "would these two branches conflict" without building a
 * checkout and merging into it: `--write-tree` merges two commits in memory,
 * writes loose objects, moves no ref, touches no working tree, and exits 1 with
 * the conflicted paths. So it is a read in every sense that matters here — and
 * it is NOT in the console-wide `ALLOWED` list on purpose. A verb one hyphen
 * away from `merge` belongs where somebody reviewing this file can see it, and
 * a probe that wanted it elsewhere would be a probe that had left the gate.
 *
 * 🔴 It must also be in `GIT_VERBS` below, and that is not bookkeeping: the
 * scoped-exemption test only inspects an argv whose head that set recognises,
 * so a verb missing from it is not "banned by omission" — it is INVISIBLE, and
 * would sail past both the exemption check and the console-wide allow-list.
 *
 * `switch`, `symbolic-ref` and `branch` are the eighth, ninth and tenth, added
 * with the reclaim and the branch hygiene, and each is here rather than in the
 * console-wide list for a reason of its own:
 *
 *  - `switch` MOVES A WORKING TREE. It is the whole mechanism of
 *    `reclaimBranch` — a clean checkout sitting on `pe/<slug>` is switched to
 *    the default branch so the run can have its branch back — and it is
 *    fenced by three preconditions in that function (the tree is one this
 *    console may move, `status --porcelain` is empty, HEAD is the branch's own
 *    tip). A verb that can discard somebody's work if any of those is wrong
 *    belongs where a reviewer sees it.
 *  - `symbolic-ref` is on the MUTATING list above, and rightly: it is how you
 *    move `HEAD`. It is exempted here for exactly one call — reading
 *    `refs/remotes/origin/HEAD` to learn what this repository calls its trunk
 *    — which writes nothing. The exemption is the read; a write through it
 *    would be a defect this comment does not license.
 *  - `for-each-ref` is the eleventh, and it is a pure READ that is on the
 *    console-wide `ALLOWED` list already — listed here for the same reason
 *    `status` was: this test asks that the exempt file run ONLY the verbs its
 *    own exemption names, so a console-wide read is invisible to it unless it
 *    is named here too. It answers two questions the branch hygiene needs
 *    without touching the dangerous verb: which `pe/<slug>*` branches exist,
 *    and which of them the trunk already contains (`--merged`). Asking those
 *    with `git branch` would have widened the delete verb's job.
 *  - `branch` is exempted for its DELETE form alone (`branch -d`), used once
 *    the run's pull request has merged. `-d` is git's own refusal to delete an
 *    unmerged branch and `-D` is that same command with the refusal removed,
 *    so `-D` must never appear in this repository — asserted below by name.
 *    The READ half deliberately does not use this verb: "which branches are
 *    merged into the target" is asked with `for-each-ref --merged`, which is
 *    already on the console-wide list, so the exemption covers the delete and
 *    nothing else.
 *  - `log` is the twelfth, and it is named here for exactly the reason `status`
 *    and `for-each-ref` are: a pure READ already on the console-wide `ALLOWED`
 *    list is still invisible to THIS test, which asks that the exempt file run
 *    only the verbs its own exemption names. It answers "which commits did this
 *    repository gain since <sha>" for `phase.scope-drift`, and it is here rather
 *    than in a fresh file so this gate keeps having exactly one argv surface to
 *    reason about.
 *  - `push` is the thirteenth, and it is the one this file was written to
 *    refuse for ever — until many-plans-one-repo decision 7 (phase 8): the
 *    console may push `pe/*` refs, and nothing else, so a phase's landing does
 *    not depend on a session being resumable to run `git push`. It is exempted
 *    for exactly ONE argv (`pushRef`), and the SHAPE section at the bottom of
 *    this file is what bounds that argv: it opens with `PUSH_ARGV`, it carries
 *    one remote and one fully-qualified refspec, it carries no force, delete,
 *    mirror or tags flag, and it exists in this file alone. `REMOTE_VERBS`
 *    still bans `push` in every OTHER file, and `fetch`, `pull`, `remote`,
 *    `clone` and `init` everywhere including here.
 */
const EXEMPT_FILE = 'runner/worktree.ts';
const WORKTREE_VERBS = [
  'worktree', 'merge', 'merge-tree', 'rev-parse', 'rev-list', 'diff', 'status',
  'switch', 'symbolic-ref', 'branch', 'for-each-ref', 'log', 'push',
];

/** The flag that makes a phased-execution script commit and push its write. */
const GIT_FLAG = '--git';

/**
 * Git verbs the console MAY run. Reads, plus the two that write a file and
 * touch no ref (`server/git.ts` §Landing plumbing).
 *
 * A new verb here is a decision, taken once, in this list — which is the point.
 */
const ALLOWED = [
  'rev-parse', 'rev-list', 'log', 'status', 'diff', 'show', 'cat-file',
  'ls-files', 'for-each-ref', 'merge-base', 'describe', 'bundle', 'format-patch',
];

/**
 * A broad git vocabulary, so "this array is a git argv" is answerable.
 *
 * 🔴 Spelled out, NOT spread from `WORKTREE_VERBS`. Deriving it from the
 * exemption looks tidier and quietly disarms the gate: every check below only
 * inspects an argv whose head this set recognises, so a verb that lives in both
 * lists disappears from the vocabulary the moment somebody takes it out of the
 * exemption — and the real `merge-tree` call in `worktree.ts` then reads as not
 * a git command at all. Measured: with `...WORKTREE_VERBS` here, deleting
 * `merge-tree` from the exemption left BOTH real-tree assertions green. The
 * vocabulary must know about a verb whether or not it is allowed; that is the
 * difference between "banned" and "invisible".
 */
const GIT_VERBS = new Set([...FORBIDDEN, ...ALLOWED, 'add', 'rm', 'mv', 'tag', 'branch', 'switch', 'worktree', 'merge-tree', 'blame', 'grep', 'config']);

/**
 * The argv scanner is `test/argv-scan.ts` — one definition, shared with
 * `issues-readonly.test.ts`, which applies the same method to `gh`.
 *
 * It used to live here and be imported from there, which re-registered all
 * eleven of this file's tests inside that one (QA round 1, Low). It is not a
 * `*.test.ts`, so importing it runs nothing. Its own header records the two
 * holes it has had; the self-test at the bottom of this file still proves the
 * scanner can FAIL, against this file's own rules.
 */
export { argvLiterals } from './argv-scan.ts';
import type { Argv } from './argv-scan.ts';
export type { Argv };

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // `node_modules`, and any local-only generated output directory beside the
    // source. A knowledge-graph build left one of the latter inside this tree;
    // it is gitignored, so it exists on some machines only — which is exactly
    // the kind of thing that makes a gate pass here and fail in CI. Matched by
    // the `-out` convention rather than by name: naming the tool that produced
    // it is what the public-repo scrub (`.github/scripts/scrub.sh`) forbids,
    // and the class is the real subject anyway.
    if (entry.name === 'node_modules' || entry.name.endsWith('-out')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(path, out);
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

const FILES = tsFiles(SERVER_DIR);
const ARGVS = FILES.flatMap((file) => argvLiterals(readFileSync(file, 'utf8'), relative(SERVER_DIR, file)));

test('the scanner is looking at the real server, not at nothing', () => {
  // A gate whose input silently became empty passes for ever. Both floors are
  // far below the real counts (60+ files, 200+ argv literals as of P15).
  assert.ok(FILES.length > 30, `only ${FILES.length} server files found`);
  assert.ok(ARGVS.length > 100, `only ${ARGVS.length} argv literals found`);
});

test('the exempt file exists and is the only one — the scanner is not policing a ghost', () => {
  // Both halves matter. Without the first, deleting `worktree.ts` would make
  // every assertion below vacuously true; without the second, the exemption
  // could be copied into a neighbour and this file would never say so.
  assert.ok(
    FILES.some((f) => relative(SERVER_DIR, f) === EXEMPT_FILE),
    `${EXEMPT_FILE} is missing — the exemption below now protects nothing`,
  );
  const holders = ARGVS
    .filter((argv) => argv.args.some((a) => a === 'worktree' || a === 'merge'))
    .map((argv) => argv.file)
    .filter((file, i, all) => all.indexOf(file) === i);
  assert.deepEqual(holders, [EXEMPT_FILE],
    'exactly one file may hold the repository-mutating exemption');
});

test('no argument list in viewer/server can fetch, pull or otherwise reach a remote — and only the one shaped push may push', () => {
  // `worktree.ts` is scanned like every other file for every remote verb but
  // one: the single `push` argv `pushRef` holds, which the SHAPE section below
  // bounds (frozen head, one refspec, no force flag, this file alone). Local
  // mutation was the first decision; ONE bounded publication was the second
  // (many-plans-one-repo decision 7), and everything else stays banned.
  const banned = new Set(REMOTE_VERBS);
  const isTheOnePush = (argv: Argv): boolean =>
    argv.file === EXEMPT_FILE
    && argv.args[0] === 'push'
    && argv.args.slice(0, PUSH_ARGV.length).join('\u0000') === PUSH_ARGV.join('\u0000');
  const offences = ARGVS
    .filter((argv) => argv.args.some((a) => banned.has(a)))
    .filter((argv) => !isTheOnePush(argv))
    .map((argv) => `${argv.file}:${argv.line} ${JSON.stringify(argv.args)}`);

  assert.deepEqual(offences, [], 'a remote-talking git verb reached an argument list');
  // …and there IS exactly one such push, so the exemption above describes the
  // code rather than a hole nothing uses.
  assert.equal(ARGVS.filter(isTheOnePush).length, 1, 'exactly one push argv, in the worktree module');
});

test('no argument list OUTSIDE the worktree module may mutate the repository', () => {
  const banned = new Set(MUTATING_VERBS);
  const offences = ARGVS
    .filter((argv) => argv.file !== EXEMPT_FILE)
    .filter((argv) => argv.args.some((a) => banned.has(a)))
    // `['wait', 'switch', 'pause']` in runner/state.ts is a vocabulary of run
    // situations, not an argv — which is why `switch` is not on the list. Any
    // future collision gets the same treatment: name it, do not widen the ban.
    .map((argv) => `${argv.file}:${argv.line} ${JSON.stringify(argv.args)}`);

  assert.deepEqual(offences, [], 'a repository-mutating git verb reached an argument list');
});

test('the worktree module runs ONLY the verbs its exemption names', () => {
  const allowed = new Set(WORKTREE_VERBS);
  const offences = ARGVS
    .filter((argv) => argv.file === EXEMPT_FILE)
    .filter((argv) => GIT_VERBS.has(argv.args[0]))
    .filter((argv) => !allowed.has(argv.args[0]))
    .map((argv) => `${argv.file}:${argv.line} ${JSON.stringify(argv.args)}`);

  assert.deepEqual(offences, [],
    `the exemption is ${WORKTREE_VERBS.length} verbs; widening it is an edit to this file`);

  // The positive half, for the same reason `bundle`/`format-patch` are asserted
  // below: an exemption nothing uses is a hole waiting for a first user.
  const used = new Set(ARGVS.filter((a) => a.file === EXEMPT_FILE).map((a) => a.args[0]));
  assert.ok(used.has('worktree') && used.has('merge'),
    `the exempt file uses neither worktree nor merge — is it still the right file?`);
  // …and the same demand of the verb that was ADDED here, which is the half a
  // widening slips through: `merge-tree` entered `WORKTREE_VERBS` for the branch
  // radar, so if nothing runs it any more the entry is a hole and not a licence.
  assert.ok(used.has('merge-tree'),
    'merge-tree is exempted but unused — take it out of WORKTREE_VERBS rather than leaving it open');
  // …and of the three the reclaim and the branch hygiene added. Same rule,
  // same reason: an exemption nothing uses is a hole waiting for a first user,
  // and these three are the most dangerous entries on the list.
  for (const verb of ['switch', 'symbolic-ref', 'branch', 'for-each-ref', 'push']) {
    assert.ok(used.has(verb),
      `${verb} is exempted but unused — take it out of WORKTREE_VERBS rather than leaving it open`);
  }
});

test('the branch exemption is the DELETE form, and -D appears nowhere', () => {
  // `-d` refuses to delete a branch whose commits are reachable from nothing
  // else; `-D` is the same command with that refusal removed. The merge check
  // in `deleteMergedBranches` is belt and `-d` is braces, and the one thing
  // that function may never do is destroy a commit that exists nowhere else —
  // so the force form must not be reachable at all.
  const forced = ARGVS
    .filter((argv) => argv.args[0] === 'branch')
    .filter((argv) => argv.args.some((a) => a === '-D' || a === '--delete--force' || a === '--force'))
    .map((argv) => `${argv.file}:${argv.line} ${JSON.stringify(argv.args)}`);
  assert.deepEqual(forced, [], 'git branch -D destroys unmerged commits; only -d may be used');

  // And it really is used for deleting, not quietly for something else.
  const uses = ARGVS.filter((argv) => argv.args[0] === 'branch');
  assert.ok(uses.length > 0, 'branch is exempted but no argument list uses it');
  assert.ok(uses.every((argv) => argv.args.includes('-d')),
    `every git branch invocation must be the -d delete form: ${uses
      .map((argv) => `${argv.file}:${argv.line} ${JSON.stringify(argv.args)}`).join(', ')}`);
});

test('no argument list in viewer/server passes --git to a script', () => {
  const offences = ARGVS
    .filter((argv) => argv.args.includes(GIT_FLAG))
    .map((argv) => `${argv.file}:${argv.line} ${JSON.stringify(argv.args)}`);

  assert.deepEqual(offences, [], '--git makes a script commit and push; the console must never pass it');
});

test('the git verbs the console runs are exactly the reads plus the two file-writers', () => {
  const offences: string[] = [];
  const used = new Set<string>();
  for (const argv of ARGVS) {
    const verb = argv.args.find((a) => GIT_VERBS.has(a));
    if (!verb || argv.args[0] !== verb) continue;
    used.add(verb);
    const allowed = argv.file === EXEMPT_FILE
      ? new Set([...ALLOWED, ...WORKTREE_VERBS])
      : new Set(ALLOWED);
    if (!allowed.has(verb)) offences.push(`${argv.file}:${argv.line} ${JSON.stringify(argv.args)}`);
  }

  assert.deepEqual(offences, [], 'a git verb outside the allow-list — add it there deliberately, or do not run it');
  // The positive half: the two landing verbs really are in use, so this list is
  // a description of the code rather than an aspiration nobody reaches.
  assert.ok(used.has('bundle') && used.has('format-patch'), `landing verbs missing from ${[...used].sort().join(', ')}`);
});

test('the scanner can FAIL — the same rules against sources that break them', () => {
  // One variable among the arguments, which is how a real push would be
  // written — and the shape the first version of this scanner could not see.
  const pushes = argvLiterals("await git(root, ['push', 'origin', branch]);");
  assert.equal(pushes.length, 1);
  assert.ok(pushes[0].args.includes('push'), 'a push must be visible to the ban');

  // Every quote style, for the same reason.
  for (const source of [
    'await git(root, ["push", "origin", branch]);',
    'await git(root, [`push`, branch]);',
  ]) {
    assert.ok(argvLiterals(source).some((a) => a.args.includes('push')), `invisible: ${source}`);
  }

  // An index access is not an argument list, and must not be reported as one.
  assert.deepEqual(argvLiterals("const handler = handlers['push'];"), [],
    'reading a property named push executes nothing');

  const flagged = argvLiterals("run(opts, 'phase-lock.sh', [slug, 'claim', '4', '--git']);");
  assert.ok(flagged.some((a) => a.args.includes('--git')), 'a --git argument must be visible to the ban');

  const verb = argvLiterals("git(root, ['remote', 'add', 'origin', url]);");
  assert.equal(verb[0].args[0], 'remote', 'a new verb must be visible to the allow-list check');

  // And the exemptions really are exempt: neither of these is an argv.
  assert.deepEqual(argvLiterals("log.info('run `phase-lock.sh release 4 --git` yourself');"), [],
    'prose telling an operator what to type is not an argument list');
  assert.deepEqual(argvLiterals("if (raw.startsWith('diff --git ')) return;"), [],
    'a diff header being parsed is not an argument list');
});

test('the exemption is SCOPED — the same three rules, run against sources that break them', () => {
  // The rules are re-applied here to synthetic files, so each assertion proves
  // its own predicate rather than trusting that the real tree happens to pass.
  const mutating = new Set(MUTATING_VERBS);
  const remote = new Set(REMOTE_VERBS);
  const allowed = new Set(WORKTREE_VERBS);

  // 1. A merge in a NEIGHBOUR of the exempt file is caught.
  const neighbour = argvLiterals(
    "await git(dir, ['merge', '--ff-only', branch]);", 'runner/runner-loop.ts',
  );
  assert.ok(
    neighbour.some((a) => a.file !== EXEMPT_FILE && a.args.some((x) => mutating.has(x))),
    'a merge outside the worktree module must be visible',
  );

  // 2. A push INSIDE the exempt file is caught — the exemption is local
  //    mutation, never publication.
  const insidePush = argvLiterals(
    "await git(root, ['push', 'origin', names.laneBranch]);", EXEMPT_FILE,
  );
  assert.ok(
    insidePush.some((a) => a.args.some((x) => remote.has(x))),
    'the exempt file is scanned for remote verbs like every other file',
  );

  // 3. A verb the exemption does not name, inside the exempt file, is caught.
  const insideReset = argvLiterals(
    "await git(names.integration, ['reset', '--hard', names.runBranch]);", EXEMPT_FILE,
  );
  assert.ok(
    insideReset.some((a) => GIT_VERBS.has(a.args[0]) && !allowed.has(a.args[0])),
    'the exemption is a list of verbs, not a licence',
  );

  // 4. The verb added for the radar is caught OUTSIDE the exempt file — which
  //    is what makes putting it in `WORKTREE_VERBS` a decision rather than a
  //    console-wide widening. Nothing else asserts this: `merge-tree` is not in
  //    `MUTATING_VERBS` (it mutates nothing), so the rule that stops a
  //    neighbour running it is the allow-list check, re-applied here.
  const neighbourRadar = argvLiterals(
    "await git(root, ['merge-tree', '--write-tree', a, b]);", 'runner/runner-loop.ts',
  );
  assert.ok(
    neighbourRadar.some((a) => GIT_VERBS.has(a.args[0])
      && !new Set(ALLOWED).has(a.args[0])
      && a.file !== EXEMPT_FILE),
    'merge-tree outside the worktree module must be an offence — it is exempt, not allowed',
  );
  // And the same argv INSIDE the exempt file is not, which is the pair that
  // makes the assertion above about scope rather than about the verb.
  assert.ok(
    argvLiterals("await git(root, ['merge-tree', '--write-tree', a, b]);", EXEMPT_FILE)
      .every((a) => allowed.has(a.args[0])),
    'the exempt file may run the verbs its exemption names',
  );
});

test('the two script runners refuse --git at runtime, not only in review', async () => {
  const { run } = await import('../server/engine.ts');
  const { runWrite } = await import('../server/writes.ts');

  await assert.rejects(
    () => run({ scriptsDir: SERVER_DIR, root: SERVER_DIR }, 'phase-graph.sh', ['demo', '--git']),
    /--git/,
    'engine.run must refuse before it spawns anything',
  );
  await assert.rejects(
    () => runWrite(
      { script: 'phase-lock.sh', args: ['demo', 'claim', '1', '--git'], description: 'claim' },
      { scriptsDir: SERVER_DIR, root: SERVER_DIR },
    ),
    /--git/,
    'runWrite must refuse before it spawns anything',
  );
});

/* ------------------------------------------------------------------ *
 * The allow-list SHAPE the landing engine must fill (phase 8)
 * ------------------------------------------------------------------ */

/**
 * Written before the behaviour, deliberately.
 *
 * Every test above asserts an ABSENCE — no push argv anywhere — and that is a
 * gate which stops meaning anything the day the console has to push, which is
 * phase 8. The three below assert the SHAPE instead: if a push argv exists it
 * is in one file, it begins with one frozen literal, and it carries none of
 * the six flags that turn a push into a thing no `git reset` takes back.
 *
 * So they are green today against a `pushRef` that refuses everything, green
 * in phase 8 against one that works, and red for the two cases exit criterion
 * 4 names — a push outside `runner/worktree.ts`, and a push with `--force`.
 * Both are proved by the self-test at the end, because a rule that has never
 * been seen to fail is a rule nobody can trust.
 */

/** The flags that make a push irreversible, or make it carry more than it was asked to. */
const PUSH_FORBIDDEN_FLAGS = [
  '--force', '-f', '--force-with-lease', '--force-if-includes',
  '--delete', '-d', '--mirror', '--tags', '--follow-tags', '--all', '--prune',
];

const pushArgvs = () => ARGVS.filter((a) => a.args.includes('push'));

test('a push argv may exist in exactly one file, and it is the worktree module', () => {
  const holders = [...new Set(pushArgvs().map((a) => a.file))];
  assert.deepEqual(holders.filter((f) => f !== EXEMPT_FILE), [],
    'a push reached an argument list outside the one file allowed to hold it');
  assert.ok(holders.length <= 1, `push argvs in ${holders.length} files`);
});

test('a push argv begins with the frozen literal, and carries one refspec and no more', () => {
  assert.deepEqual([...PUSH_ARGV], ['push', '--porcelain', '--no-follow-tags'],
    'the literal itself changed — every assertion below was written against these three words');
  for (const argv of pushArgvs()) {
    assert.deepEqual(argv.args.slice(0, PUSH_ARGV.length), [...PUSH_ARGV],
      `${argv.file}: a push must open with PUSH_ARGV — the porcelain reply is what the landing ledger is written from`);
  }
  // And the constant itself reaches one file. This is what keeps the check
  // above from going vacuous the day phase 8 writes `[...PUSH_ARGV, remote,
  // refspec]`: a spread carries no `'push'` literal, so the argv scanner sees
  // nothing and every assertion in this file would pass over a real push.
  const users = FILES
    .filter((file) => /\bPUSH_ARGV\b/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(SERVER_DIR, file));
  assert.deepEqual(users.filter((f) => f !== EXEMPT_FILE), [],
    'PUSH_ARGV was referenced outside the one file allowed to push');
});

/**
 * The two verbs allowed to carry one of those flags, each for a measured reason.
 *
 * `worktree` — `worktree remove --force` takes a CHECKOUT, never a ref: the
 *   commits are on the branch afterwards exactly as they were before. And it is
 *   already refused on a tree this console locked: phase 1's arm G-3 measured
 *   that one `-f` exits 128 with *"use 'remove -f -f' to override or unlock
 *   first"*, so the console cannot take a live lane's tree even by mistake.
 *   `-f -f` appears nowhere and is asserted absent below.
 * `branch` — `-d`, the form that REFUSES to delete an unmerged branch, with
 *   `-D` banned by name in its own test above.
 *
 * Every other verb is an offence, which is where the force flags actually bite:
 * `checkout --force`, `clean -f`, `reset` and a forced push all destroy work
 * that exists nowhere else.
 */
const FORCE_ALLOWED_VERBS = new Set(['worktree', 'branch']);

test('a force, delete, mirror or tags flag reaches only the two verbs that may carry one', () => {
  const carriers = ARGVS
    .filter((a) => GIT_VERBS.has(a.args[0]))
    .filter((a) => a.args.some((arg) => PUSH_FORBIDDEN_FLAGS.includes(arg)));
  const offences = carriers
    .filter((a) => !FORCE_ALLOWED_VERBS.has(a.args[0]))
    .map((a) => `${a.file}: ${a.args.join(' ')}`);
  assert.deepEqual(offences, [],
    'a force/delete/mirror/tags flag reached a verb that moves refs or reaches a remote — none of that is recoverable');

  // The carve-out is exactly as wide as its reasons. `worktree` may force only
  // `remove`, and never twice: `-f -f` is the escape hatch that DOES take a
  // locked tree, which is the one thing a sweep must never be able to do.
  for (const argv of carriers.filter((a) => a.args[0] === 'worktree')) {
    assert.ok(argv.args.includes('remove'), `${argv.file}: only \`worktree remove\` may be forced`);
    assert.ok(argv.args.filter((arg) => arg === '--force' || arg === '-f').length === 1,
      `${argv.file}: \`-f -f\` overrides a lock and would let a sweep take a live lane's tree (phase 1, arm G-3)`);
  }
  for (const argv of carriers.filter((a) => a.args[0] === 'branch')) {
    assert.ok(argv.args.includes('-d'), `${argv.file}: only the refusing delete form is allowed`);
  }
});

test('ls-remote is banned: a landing must read its own ledger, not the network', () => {
  const offences = ARGVS.filter((a) => a.args.includes('ls-remote')).map((a) => a.file);
  assert.deepEqual(offences, [],
    'ls-remote asks the network a question the landing ledger already answers, and asks it on a '
    + 'clock nobody controls — a gate that shells out gives different callers different answers');
});

test('the Pro tree holds no git argv at all — git lives in the free half', () => {
  // `viewer/server/pro/` does not exist yet; phase 8 creates it. The rule is
  // written now because the moment it exists it will be the obvious place to
  // put "the bit that pushes", and the whole point of the allow-list is that
  // there is exactly one such place and it is not edition-dependent.
  const offences = ARGVS
    .filter((a) => a.file.startsWith('pro/'))
    .filter((a) => GIT_VERBS.has(a.args[0]))
    .map((a) => `${a.file}: ${a.args.join(' ')}`);
  assert.deepEqual(offences, [],
    'a git argv under server/pro/ — the free tree would ship a console that cannot do it');
});

test('the SHAPE rules can FAIL — the same four rules against sources that break them', () => {
  // Exit criterion 4's two named cases, and the two beside them.
  const outside = argvLiterals("await git(['push', '--porcelain', '--no-follow-tags', 'origin', 'refs/heads/x:refs/heads/x']);", 'runner/land.ts');
  assert.equal(outside.length, 1, 'a push in another file must be visible');
  assert.notEqual(outside[0].file, EXEMPT_FILE, 'and must not be mistaken for the exempt one');

  const forced = argvLiterals("await git(['push', '--force', 'origin', 'main']);", EXEMPT_FILE);
  assert.ok(forced.some((a) => a.args.some((arg) => PUSH_FORBIDDEN_FLAGS.includes(arg))),
    'a --force must be visible to the flag ban');

  const wrongHead = argvLiterals("await git(['push', 'origin', 'main']);", EXEMPT_FILE);
  assert.notDeepEqual(wrongHead[0].args.slice(0, PUSH_ARGV.length), [...PUSH_ARGV],
    'a push that skips the frozen literal must be visible to the shape check');

  const remote = argvLiterals("await git(['ls-remote', '--heads', 'origin']);", EXEMPT_FILE);
  assert.ok(remote.some((a) => a.args.includes('ls-remote')), 'ls-remote must be visible to its ban');
});

test('the seam refuses BEFORE spawning — a caller not allowed learns nothing, and a trunk is never a candidate', async () => {
  // The placeholder phase 2 wrote here threw for everything and named phase 8.
  // Phase 8 filled it, and what survives of that test is its point: a caller
  // "landing" a phase by doing nothing must be impossible, and so must a
  // caller pushing anything the shape does not admit. Both refusals are
  // answered against a cwd that is NOT a repository — had git been spawned,
  // the answer would have been a git failure and not the named word.
  const nowhere = join(tmpdir(), `never-push-nowhere-${process.pid}`);
  const forbidden = await pushRef(nowhere, 'pe/x', { remote: 'origin', allowed: false });
  assert.ok(!forbidden.ok && forbidden.reason === 'not-allowed', JSON.stringify(forbidden));
  const trunk = await pushRef(nowhere, 'main', { remote: 'origin', allowed: true });
  assert.ok(!trunk.ok && trunk.reason === 'ref-not-pe', JSON.stringify(trunk));
  const mapping = await pushRef(nowhere, 'pe/x:main', { remote: 'origin', allowed: true });
  assert.ok(!mapping.ok && mapping.reason === 'refspec', JSON.stringify(mapping));
  // The shape the regex admits is exactly the two branch shapes `laneNames` mints.
  assert.ok(PUSH_REF.test('pe/x') && PUSH_REF.test('pe/x-p3') && !PUSH_REF.test('main'));
});
