/**
 * Scope drift credits only what the phase itself did (control-tower phase 63, #88).
 *
 * The probe credited every commit that moved an unscoped repository's HEAD
 * while a phase ran. Over one week that was 79 lines on two consoles — lock
 * commits, other plans' handoffs, a person's audit — and this plan's own
 * journal carried one per phase: 54 lines, 155 commits, not one of them the
 * phase leaving its scope. These tests hold the credit (`scope-drift.ts`):
 *
 *   SD-1  a `phase-lock:` commit is never credited — on the lane's branch,
 *         printed by its own session, it does not matter;
 *   SD-2  another plan's commit, a write inside the declared scope, and a
 *         commit neither on the lane's branch nor printed by its session are
 *         never credited;
 *   SD-3  what IS credited: a commit the session printed or one on the lane's
 *         branch that left the declared scope — proved against a real
 *         repository and real `git commit` output — and replaying this plan's
 *         journal leaves no drift line at all.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  creditCommit, creditDrift, printedCommits, type DriftCommit, type DriftContext,
} from '../server/runner/scope-drift.ts';
import { commitsWithPaths } from '../server/runner/worktree.ts';

const REPLAY = fileURLToPath(new URL('./fixtures/scope-drift/control-tower-run-9c66853e1db3.jsonl', import.meta.url));

function ctx(over: Partial<DriftContext> = {}): DriftContext {
  return { slug: 'control-tower', scope: ['phased-execution'], rel: '', onLaneBranch: false, sessionCommits: [], ...over };
}

/* ------------------------------------------------------------------ *
 * SD-1 — a lock commit is nobody's drift
 * ------------------------------------------------------------------ */

test('SD-1: a phase-lock: commit is never credited, whoever made it and wherever it stands', () => {
  const lock: DriftCommit = {
    sha: 'e49e610', subject: 'phase-lock: release phase 3 (control-tower) by autopilot/9c66853e1db3',
    paths: ['docs/handoffs/control-tower/.locks/phase-03.lock'],
  };
  assert.equal(creditCommit(lock, ctx()), 'phase-lock');
  assert.equal(creditCommit(lock, ctx({ onLaneBranch: true, sessionCommits: ['e49e610'] })), 'phase-lock');
  // Another plan's lock, and one whose paths could not be read.
  assert.equal(creditCommit({ sha: 'a1b2c3d', subject: 'phase-lock: claim phase 9 (vca-refactor) by hub/1', paths: [] }, ctx({ onLaneBranch: true })), 'phase-lock');
});

/* ------------------------------------------------------------------ *
 * SD-2 — other plans, other writers, declared writes
 * ------------------------------------------------------------------ */

test('SD-2: another plan\'s commit is never credited, even on the lane\'s branch and printed by its session', () => {
  const other: DriftCommit = {
    sha: 'b2c3d4e', subject: 'docs(vca-refactor): phase 4 complete',
    paths: ['docs/handoffs/vca-refactor/phase-04-x.md', 'docs/handoffs/vca-refactor/INDEX.md', 'docs/plans/vca-refactor.md'],
  };
  assert.equal(creditCommit(other, ctx({ onLaneBranch: true, sessionCommits: ['b2c3d4e'] })), 'other-plan');
});

test('SD-2: a write inside the declared scope is the phase\'s own — its handoff, its plan\'s documents, a scoped gitlink', () => {
  const printed = ctx({ sessionCommits: ['c3d4e5f', 'd4e5f6a', 'e5f6a7b'], onLaneBranch: true });
  assert.equal(creditCommit({
    sha: 'c3d4e5f', subject: 'docs(control-tower): phase 63 handoff',
    paths: ['docs/handoffs/control-tower/phase-63-x.md', 'docs/handoffs/control-tower/INDEX.md'],
  }, printed), 'declared');
  assert.equal(creditCommit({
    sha: 'd4e5f6a', subject: 'docs(control-tower): amend — phases 76–85',
    paths: ['docs/plans/control-tower.md', 'docs/plans/control-tower-issues/issue-92.md'],
  }, printed), 'declared');
  assert.equal(creditCommit({
    sha: 'e5f6a7b', subject: 'chore(gitlink): phased-execution -> 8bd2f800 (control-tower phase 57)',
    paths: ['phased-execution'],
  }, printed), 'declared');
});

test('SD-2: a commit neither on the lane\'s branch nor printed by its session is not the phase\'s', () => {
  const audit: DriftCommit = {
    sha: 'ee708a2', subject: 'docs(audits): commit the autopilot-week audit of 2026-09-23',
    paths: ['docs/audits/autopilot-week-2026-09-23/90-all-findings.md'],
  };
  assert.equal(creditCommit(audit, ctx()), 'not-ours');
  // A submodule another plan's lanes commit into while this one runs.
  const foreign: DriftCommit = { sha: 'f6a7b8c', subject: 'feat(app): tamagui upgrade', paths: ['src/app.tsx'] };
  assert.equal(creditCommit(foreign, ctx({ rel: 'vendor-commissioner-app', sessionCommits: ['0a1b2c3'] })), 'not-ours');
});

/* ------------------------------------------------------------------ *
 * SD-3 — what is credited, end to end, and the replay
 * ------------------------------------------------------------------ */

test('SD-3: a commit the session printed, or one on the lane\'s branch, that left the declared scope IS drift', () => {
  const left: DriftCommit = { sha: '9f0eb98aa1', subject: 'fix(site): a stray edit', paths: ['app/page.tsx'] };
  assert.equal(creditCommit(left, ctx({ rel: 'phase-console-site', sessionCommits: ['9f0eb98'] })), 'credited', 'git\'s abbreviation matches the longer one');
  assert.equal(creditCommit(left, ctx({ rel: 'phase-console-site', onLaneBranch: true })), 'credited');
  // A merge lists no paths: nothing to declare it by, so attribution alone decides.
  assert.equal(creditCommit({ sha: '1234567', subject: 'Merge branch x' }, ctx({ sessionCommits: ['1234567'] })), 'credited');
  assert.equal(creditCommit({ sha: '1234567', subject: 'Merge branch x' }, ctx()), 'not-ours');
  // A six-character "sha" is no commit git would print.
  assert.equal(creditCommit({ sha: '123456', subject: 'x', paths: ['a'] }, ctx({ sessionCommits: ['123456'] })), 'not-ours');
});

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return `${run.stdout}`;
}

function commitFile(cwd: string, path: string, subject: string): string {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), `${subject}\n`);
  git(cwd, 'add', '--', path);
  return git(cwd, 'commit', '-m', subject);
}

test('SD-3: printedCommits reads git\'s own summary lines — a commit, the first commit, a detached HEAD — and nothing else', () => {
  const repo = mkdtempSync(join(tmpdir(), 'drift-print-'));
  try {
    git(repo, 'init', '-q', '-b', 'main', '.');
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 't');
    const first = commitFile(repo, 'a.txt', 'first');
    assert.deepEqual(printedCommits(first), [git(repo, 'rev-parse', '--short', 'HEAD').trim()]);
    const second = commitFile(repo, 'b.txt', 'second');
    assert.deepEqual(printedCommits(`hook output\n${'x'.repeat(400)}\n${second}`), [git(repo, 'rev-parse', '--short', 'HEAD').trim()],
      'behind a hook\'s output, past the stream\'s 200-character clip');
    git(repo, 'checkout', '-q', '--detach');
    const detached = commitFile(repo, 'c.txt', 'third');
    assert.deepEqual(printedCommits(detached), [git(repo, 'rev-parse', '--short', 'HEAD').trim()]);
    // A log, a status, a cat of a file that merely mentions brackets: nothing.
    assert.deepEqual(printedCommits(git(repo, 'log', '--oneline')), []);
    assert.deepEqual(printedCommits('see [the docs] and [main abc] for more'), []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('SD-3: against a real repository, only the session\'s own out-of-scope commit is credited', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drift-root-'));
  try {
    git(root, 'init', '-q', '-b', 'main', '.');
    git(root, 'config', 'user.email', 't@t.t');
    git(root, 'config', 'user.name', 't');
    commitFile(root, 'README.md', 'init');
    const start = git(root, 'rev-parse', 'HEAD').trim();
    commitFile(root, 'docs/handoffs/control-tower/.locks/phase-63.lock', 'phase-lock: claim phase 63 (control-tower) by autopilot/r1');
    commitFile(root, 'docs/handoffs/vca-refactor/phase-04-x.md', 'docs(vca-refactor): phase 4 complete');
    const handoff = commitFile(root, 'docs/handoffs/control-tower/phase-63-x.md', 'docs(control-tower): phase 63 handoff');
    const stray = commitFile(root, 'CLAUDE.md', 'docs: a stray edit to the root');
    commitFile(root, 'docs/audits/x.md', 'docs(audits): a person\'s commit');
    const commits = await commitsWithPaths(root, start);
    assert.equal(commits.length, 5);
    assert.deepEqual(commits.find((c) => c.subject.startsWith('docs(vca'))?.paths, ['docs/handoffs/vca-refactor/phase-04-x.md']);
    const { credited, excluded } = creditDrift(commits, ctx({
      sessionCommits: [...printedCommits(handoff), ...printedCommits(stray)],
    }));
    assert.deepEqual(credited.map((c) => c.subject), ['docs: a stray edit to the root']);
    assert.deepEqual(excluded, { 'phase-lock': 1, 'other-plan': 1, declared: 1, 'not-ours': 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

type ReplayLine = { seq: number; phase: number; repo: string; scope: string; commits: { sha: string; subject: string; paths: string[] }[] };

function replayLines(): ReplayLine[] {
  return readFileSync(REPLAY, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as ReplayLine);
}

test('SD-3: replaying this plan\'s journal (run 9c66853e1db3, 54 drift lines) leaves no drift line', () => {
  const lines = replayLines();
  assert.equal(lines.length, 54);
  assert.equal(lines.reduce((n, line) => n + line.commits.length, 0), 156);
  let left = 0;
  const totals: Record<string, number> = {};
  for (const line of lines) {
    // The facts of the time: the docs root stood on `main` and every lane of the
    // run committed on `pe/control-tower`, so nothing in the root was on the
    // lane's branch. The commits a session made are the ones naming its phase —
    // its handoff, its gitlink, its locks — which is the most the journal can say.
    const own = new RegExp(`\\bphase ${line.phase}(?!\\d)`);
    const { credited, excluded } = creditDrift(line.commits, ctx({
      scope: line.scope.split(','),
      rel: line.repo === '.' ? '' : line.repo,
      sessionCommits: line.commits.filter((c) => own.test(c.subject)).map((c) => c.sha),
    }));
    if (credited.length) left++;
    for (const [why, n] of Object.entries(excluded)) totals[why] = (totals[why] ?? 0) + (n ?? 0);
  }
  assert.equal(left, 0, 'no line survives');
  assert.deepEqual(totals, { 'phase-lock': 92, declared: 63, 'not-ours': 1 });
});

test('SD-3: at WORST — every commit treated as the session\'s own — only the operator\'s audit commit is left, and attribution is what removes it', () => {
  const credited = new Set<string>();
  for (const line of replayLines()) {
    const result = creditDrift(line.commits, ctx({
      scope: line.scope.split(','),
      rel: line.repo === '.' ? '' : line.repo,
      sessionCommits: line.commits.map((c) => c.sha),
    }));
    for (const commit of result.credited) credited.add(`${commit.sha} ${commit.subject}`);
  }
  assert.deepEqual([...credited], ['ee708a2 docs(audits): commit the autopilot-week audit of 2026-09-23']);
});
