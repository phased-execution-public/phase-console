/**
 * The artefacts register credits a phase with its own trees only (one-pool
 * phase 20, #262).
 *
 * Measured on the hub console: `run.agent-artefacts` credited an ai-builder
 * phase with the fleet-sweep run's mirror and its `pe/fleet-sweep-2026-10`
 * branches, and an issues-sweep phase with a supervisor's scratch trees —
 * worktrees share ONE git directory across every checkout of a repository, and
 * the scan passed only this run's directory as "managed". On 7.1 the diff
 * credited every tree and every `pe/*` branch that appeared.
 *
 *  - AR-1 another run's lane trees and `pe/<slug>` branches in the same
 *    repository leave no row for this phase;
 *  - AR-2 a tree outside every managed root is NAMED as having appeared while
 *    the phase ran, maker unknown — never credited;
 *  - AR-3 a tree this phase's session makes inside its own lane, and a branch
 *    no plan's lane machinery names, are still credited — the register still
 *    catches a real leak.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  artefactsMade, artefactWords, consoleBranch, instanceSlugs, type ArtefactSnapshot,
} from '../server/runner/artefacts.ts';
import { checkouts, managedRoots } from '../server/runner/worktree.ts';
import { repo } from './fixtures/repo.ts';

const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

function hubRepo(): { root: string; consoleDir: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pc-artefacts-')));
  const root = repo({ dir: join(base, 'hub'), files: {}, message: 'root' });
  const consoleDir = join(base, 'state', 'runs', 'abcd1234-hub');
  // Two plans of this instance have run state: this one (A) and another (B).
  mkdirSync(join(consoleDir, 'plan-a'), { recursive: true });
  mkdirSync(join(consoleDir, 'plan-b'), { recursive: true });
  return { root, consoleDir };
}

async function scan(root: string, consoleDir: string): Promise<ArtefactSnapshot> {
  const managed = managedRoots({ root, consoleDir });
  const trees: ArtefactSnapshot[number]['trees'] = new Map();
  for (const entry of await checkouts(root, managed)) {
    trees.set(entry.dir, { ...(entry.branch ? { branch: entry.branch } : {}), managed: entry.managed });
  }
  const branches = new Set(run(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/pe/')
    .split('\n').map((line) => line.trim()).filter(Boolean));
  return [{ repo: '.', trees, branches }];
}

test('AR-1 (#262): another run\'s lane trees and pe/<slug> branches in a shared repository are not this phase\'s', async () => {
  const { root, consoleDir } = hubRepo();
  const slugs = instanceSlugs(consoleDir);
  assert.deepEqual(slugs.sort(), ['plan-a', 'plan-b']);
  const before = await scan(root, consoleDir);
  // Run B's lane machinery, between run A's two scans: its mirror under
  // `.worktrees/runs/…`, a state-directory lane, its run and lane branches.
  run(root, 'worktree', 'add', '-q', '-b', 'pe/plan-b', join(root, '.worktrees', 'runs', 'plan-b', 'bbbbbbbbbbbb', 'integration'));
  run(root, 'worktree', 'add', '-q', '-b', 'pe/plan-b-p3', join(consoleDir, 'plan-b', 'worktrees', 'bbbbbbbbbbbb', 'p3'));
  run(root, 'branch', 'pe/plan-b-p4-qa2');
  const after = await scan(root, consoleDir);
  const made = artefactsMade(before, after, { phase: 7, at: 'now', laneTree: null, slugs });
  assert.deepEqual(made, [], `nothing B made is A's — got ${JSON.stringify(made)}`);
});

test('AR-2 (#262): a tree outside every managed root appeared while the phase ran — named, maker unknown, never credited', async () => {
  const { root, consoleDir } = hubRepo();
  const before = await scan(root, consoleDir);
  // A supervisor terminal session's scratch trees (the measured row 4).
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pc-artefacts-scratch-')));
  run(root, 'worktree', 'add', '-q', '-b', 'tf-errcopy', join(scratch, 'wt', 'tf-errcopy'));
  const after = await scan(root, consoleDir);
  const made = artefactsMade(before, after, { phase: 27, at: 'now', laneTree: null, slugs: instanceSlugs(consoleDir) });
  assert.equal(made.length, 1, JSON.stringify(made));
  assert.equal(made[0]!.kind, 'worktree');
  assert.equal(made[0]!.maker, 'unknown');
  assert.match(artefactWords(made[0]!), /appeared while phase 27 ran \(maker unknown\)/);
  assert.doesNotMatch(artefactWords(made[0]!), /made by/);
});

test('AR-3 (#262): a tree the phase\'s session makes inside its own lane, and a branch no lane names, are still registered', async () => {
  const { root, consoleDir } = hubRepo();
  const lane = join(root, '.worktrees', 'runs', 'plan-a', 'aaaaaaaaaaaa', 'p7');
  run(root, 'worktree', 'add', '-q', '-b', 'pe/plan-a-p7', lane);
  const before = await scan(root, consoleDir);
  run(lane, 'worktree', 'add', '-q', '-b', 'scratch-by-session', join(lane, 'scratch'));
  run(root, 'branch', 'pe/made-by-the-session');
  const after = await scan(root, consoleDir);
  const made = artefactsMade(before, after, { phase: 7, at: 'now', laneTree: lane, slugs: instanceSlugs(consoleDir) });
  const tree = made.find((a) => a.kind === 'worktree');
  assert.ok(tree, `the session's own tree is registered — got ${JSON.stringify(made)}`);
  assert.equal(tree!.maker, undefined, 'credited to the phase');
  assert.match(artefactWords(tree!), /made by phase 7/);
  assert.ok(made.find((a) => a.kind === 'branch' && a.name === 'pe/made-by-the-session'));
});

test('consoleBranch names a plan\'s run branch and its lane branches, and nothing that only shares a prefix', () => {
  const slugs = ['fleet-sweep-2026-10', 'a.b'];
  assert.equal(consoleBranch('pe/fleet-sweep-2026-10', slugs), true);
  assert.equal(consoleBranch('pe/fleet-sweep-2026-10-p21', slugs), true);
  assert.equal(consoleBranch('pe/fleet-sweep-2026-10-p21-qa3', slugs), true);
  assert.equal(consoleBranch('pe/fleet-sweep-2026-10-fix', slugs), false);
  assert.equal(consoleBranch('pe/axb-p1', slugs), false, 'a dot in a slug is literal');
  assert.equal(consoleBranch('pe/made-by-the-session', slugs), false);
});
