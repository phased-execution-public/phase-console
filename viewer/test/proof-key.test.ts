/**
 * A proof is keyed to the repository its line runs in (one-pool phase 20,
 * #301).
 *
 * Measured on the hub console, run `04b61dd957b7` phase 20: the session proved
 * six `cd <repo> && … verify:local` lines at the superproject tree, then
 * committed two docs in hub's root. Every proof was refused — "the tree changed
 * since it was proven (2 paths a suite may read)" — and the console re-ran
 * ~1.9 h of suites over a change no suite inside those repositories reads. On
 * 7.1 a proof carried one key, the superproject's working tree.
 *
 *  - PK-1 a `cd <sub> && …` proof records `{repo, repoTree}` — the line's own
 *    repository and its working tree — and a root-only commit leaves it
 *    standing, naming what changed outside;
 *  - PK-2 a change inside `<sub>`, committed or not, re-runs it;
 *  - PK-3 a line with no `cd` keeps the superproject key: the same docs commit
 *    re-runs it;
 *  - PK-4 an older proof with no repository key is judged by the superproject's
 *    paths under `<sub>/` alone.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { judgeProofs, lineDirOf } from '../server/runner/proofs.ts';
import { workingTreeOf } from '../server/runner/worktree.ts';
import { repo } from './fixtures/repo.ts';

/** A repository with one commit (`base`) holding `files`, on git's default branch. */
const baseRepo = (dir: string, files: Record<string, string>): string => repo({ dir, files, branch: null, message: 'base' });

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTCOME = join(REPO_ROOT, 'scripts', 'phase-outcome.sh');

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', '-c', 'init.defaultBranch=main', ...args,
  ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** The hub's shape: a superproject with docs of its own, mounting `sub`. */
function hub(): { root: string; sub: string; ledger: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pc-pk-')));
  TRASH.push(base);
  const origin = baseRepo(join(base, 'origin'), { 'src/app.txt': 'the backend\n' });
  const root = baseRepo(join(base, 'root'), { 'README.md': '# hub\n', 'docs/audits/readiness.md': 'draft\n' });
  git(root, 'submodule', 'add', '-q', origin, 'sub');
  git(root, 'commit', '-q', '-m', 'mount');
  return { root, sub: join(root, 'sub'), ledger: join(base, 'proofs.ndjson') };
}

function prove(f: { root: string; ledger: string }, command: string): void {
  const env = { ...process.env };
  for (const key of ['PE_WORKTREE', 'PE_VERIFY_DIR', 'PE_RUN_ROOT', 'PE_PROOFS_FILE', 'DOCS_ROOT']) delete env[key];
  execFileSync('bash', [OUTCOME, 'demo', '20', 'verified', '--command', command, '--exit', '0'], {
    cwd: f.root,
    env: { ...env, PE_NOW: '2026-10-09T21:43:27Z', PE_PROOFS_FILE: f.ledger, PE_RUN_ROOT: f.root, PE_VERIFY_DIR: f.root },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const SUB_LINE = 'cd sub && task verify:local';

/** The measured delta: a docs commit in the ROOT repository, after the slow verbs were proven. */
function commitRootDocs(root: string): void {
  writeFileSync(join(root, 'docs', 'audits', 'readiness.md'), 'final\n');
  writeFileSync(join(root, 'docs', 'audits', 'review-findings.md'), 'none\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'docs');
}

test('PK-1 (#301): a cd <sub> proof is keyed {repo, repoTree}, and a root-only docs commit leaves it standing', async () => {
  const f = hub();
  prove(f, SUB_LINE);
  const row = JSON.parse(readFileSync(f.ledger, 'utf8').trim().split('\n').pop()!);
  assert.equal(row.repo, 'sub', 'the line\'s own repository');
  assert.equal(row.repo_tree, (await workingTreeOf(f.sub))!.tree, 'and that repository\'s working tree');
  commitRootDocs(f.root);
  const judged = await judgeProofs({ file: f.ledger, slug: 'demo', phase: 20, cwd: f.root });
  assert.deepEqual([...judged.proven.keys()], [SUB_LINE], `refused: ${JSON.stringify(judged.refused)}`);
  const by = judged.proven.get(SUB_LINE)!;
  assert.equal(by.repo, 'sub');
  assert.deepEqual(by.outside?.sort(), ['docs/audits/readiness.md', 'docs/audits/review-findings.md']);
});

test('PK-2 (#301): a change inside <sub> re-runs the line — uncommitted or committed', async () => {
  const f = hub();
  prove(f, SUB_LINE);
  commitRootDocs(f.root);
  writeFileSync(join(f.sub, 'src', 'app.txt'), 'changed\n');
  const dirty = await judgeProofs({ file: f.ledger, slug: 'demo', phase: 20, cwd: f.root });
  assert.equal(dirty.proven.size, 0);
  assert.match(dirty.refused[0]?.why ?? '', /^sub changed since it was proven \(1 path/);
  assert.deepEqual(dirty.refused[0]?.changed, ['sub/src/app.txt']);
  git(f.sub, 'commit', '-q', '-am', 'change');
  const committed = await judgeProofs({ file: f.ledger, slug: 'demo', phase: 20, cwd: f.root });
  assert.equal(committed.proven.size, 0, 'a commit inside the repository is a change its suite reads');
});

test('PK-3 (#301): a line with no cd keeps the superproject key — the same docs commit re-runs it', async () => {
  const f = hub();
  prove(f, 'grep -q final docs/audits/readiness.md');
  const row = JSON.parse(readFileSync(f.ledger, 'utf8').trim());
  assert.equal(row.repo, undefined);
  commitRootDocs(f.root);
  const judged = await judgeProofs({ file: f.ledger, slug: 'demo', phase: 20, cwd: f.root });
  assert.equal(judged.proven.size, 0);
  assert.match(judged.refused[0]?.why ?? '', /the tree changed since it was proven \(2 paths/);
});

test('PK-4 (#301): an older proof with no repository key is judged by the superproject\'s paths under <sub>/ alone', async () => {
  const f = hub();
  prove(f, SUB_LINE);
  // The shape a 7.1 session wrote: the superproject's tree, nothing else.
  const row = JSON.parse(readFileSync(f.ledger, 'utf8').trim());
  delete row.repo; delete row.repo_tree;
  writeFileSync(f.ledger, `${JSON.stringify(row)}\n`);
  commitRootDocs(f.root);
  const judged = await judgeProofs({ file: f.ledger, slug: 'demo', phase: 20, cwd: f.root });
  assert.deepEqual([...judged.proven.keys()], [SUB_LINE], `refused: ${JSON.stringify(judged.refused)}`);
  // …and a moved gitlink is a path under it.
  git(f.sub, 'commit', '-q', '--allow-empty', '-m', 'moved');
  git(f.root, 'add', 'sub');
  git(f.root, 'commit', '-q', '-m', 'bump');
  const moved = await judgeProofs({ file: f.ledger, slug: 'demo', phase: 20, cwd: f.root });
  assert.equal(moved.proven.size, 0, `a moved submodule re-runs it: ${JSON.stringify(moved.proven)}`);
});

test('lineDirOf reads the cd a line starts with, and nothing it cannot resolve without a shell', () => {
  assert.equal(lineDirOf('cd shop/shop-backend && task verify:local'), 'shop/shop-backend');
  assert.equal(lineDirOf('cd ./aws/ && task verify:local'), 'aws');
  assert.equal(lineDirOf('cd "site-admin" && npm run verify:local'), 'site-admin');
  assert.equal(lineDirOf('npm test'), null);
  assert.equal(lineDirOf('cd .. && npm test'), null);
  assert.equal(lineDirOf('cd $REPO && npm test'), null);
  assert.equal(lineDirOf('cd /abs && npm test'), null);
  assert.equal(lineDirOf('cd sub; npm test'), null, 'only a `&&` chain says the rest runs there');
});
