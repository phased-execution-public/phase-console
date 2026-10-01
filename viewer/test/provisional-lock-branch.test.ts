/**
 * The provisional claim names the lane's branch (control-tower phase 82, #116,
 * PL-1).
 *
 * `qualificationFor` answers `{branch, tree, repo}`, and the runner's argv
 * builder mapped every key that was not `tree` to `--branch` — so the
 * repository key, a PATH, followed the run branch and won: measured on 4130,
 * phase 54's provisional lock read `branch=<the pe-hub root>` until the
 * session re-claimed. For that window a same-branch sibling in another tree
 * read as DISJOINT (`claimsDisjoint` needs both dimensions to differ), and two
 * lanes could hold overlapping claims. Phase 63 changed the mapping while
 * fixing the lock mirror; this is the proof that it stays changed — the argv
 * the runner sends, and the `branch=` line the real `phase-lock.sh` writes
 * from it.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROVISIONAL_LEASE_S } from '../server/runner/runner-core.ts';
import { drive, harness, repoAt } from './lane-harness.ts';

const SCRIPTS = fileURLToPath(new URL('../../scripts/', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../tests/fixtures/plans/', import.meta.url));

/** A `phase-lock.sh` that records each call's argv — one line per call, fields split by 0x1f. */
const recorder = (state: string): string => `#!/usr/bin/env bash
( IFS=$'\\x1f'; printf '%s\\n' "$*" ) >> "${state}/lock-calls"
exit 0
`;

function calls(state: string): string[][] {
  try {
    return readFileSync(join(state, 'lock-calls'), 'utf8').split('\n').filter(Boolean).map((line) => line.split('\x1f'));
  } catch {
    return [];
  }
}

/** Every value passed after `name`, in order — a repeated flag is the defect. */
const values = (argv: readonly string[], name: string): string[] =>
  argv.flatMap((arg, i) => (arg === name ? [argv[i + 1] ?? ''] : []));

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('PL-1 — the provisional claim passes tree → --worktree and branch → --branch, drops repo, and the lock reads the lane branch', async () => {
  const base = mkdtempSync(join(tmpdir(), 'p82-pl1-'));
  try {
    const root = repoAt(join(base, 'repo'), {
      'README.md': 'root\n', 'docs/plans/demo.md': '# demo\n', 'web/index.html': 'web\n',
    });
    const h = harness(root, { 1: 'web', 2: 'web' }, {}, undefined, { lockScript: recorder });
    const state = await drive(h, { onlyPhases: [1] });
    const tree = String(state.workRoot ?? '');
    assert.ok(tree && tree !== root, `the run took its checkout, so the claim has a tree to name (checkout: ${String(state.checkout)})`);

    const provisional = calls(h.state).find(
      (argv) => argv[1] === 'claim' && values(argv, '--lease')[0] === String(PROVISIONAL_LEASE_S),
    );
    assert.ok(provisional, `no provisional claim among ${JSON.stringify(calls(h.state))}`);
    assert.deepEqual(values(provisional, '--branch'), ['pe/demo'], 'ONE --branch, and it is the lane branch');
    assert.deepEqual(values(provisional, '--worktree'), [realpathSync(tree)], 'the tree rides --worktree');
    assert.equal(provisional.includes('--repo'), false, 'phase-lock.sh takes no --repo');

    // The lock the REAL script writes from that argv — what `conflicts` and
    // every other reader decides on.
    const docs = join(base, 'docs-root');
    mkdirSync(join(docs, 'docs', 'plans'), { recursive: true });
    mkdirSync(join(docs, 'docs', 'handoffs', 'demo'), { recursive: true });
    copyFileSync(join(FIXTURES, 'linear.md'), join(docs, 'docs', 'plans', 'demo.md'));
    execFileSync('bash', [join(SCRIPTS, 'phase-lock.sh'), ...provisional], {
      cwd: docs,
      encoding: 'utf8',
      // File-only, and nothing inherited from a supervisor running this suite:
      // a `PE_BRANCH` in the environment is a second writer of the same line.
      env: { ...process.env, DOCS_ROOT: docs, PE_LOCK_MIRROR: '', PE_BRANCH: '', PE_WORKTREE: '', PE_SCOPE: '', PE_OWNER: '' },
    });
    const lock = readFileSync(join(docs, 'docs', 'handoffs', 'demo', '.locks', 'phase-01.lock'), 'utf8');
    assert.match(lock, /^branch=pe\/demo$/m, `the lock names the lane branch:\n${lock}`);
    assert.match(lock, new RegExp(`^worktree=${escapeRe(realpathSync(tree))}$`, 'm'));
    assert.doesNotMatch(lock, new RegExp(`^branch=${escapeRe(realpathSync(root))}`, 'm'), 'never the repository key');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
