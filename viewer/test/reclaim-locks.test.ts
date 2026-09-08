/**
 * The reclaim's fourth precondition, driven by REAL lock files through the
 * Service — QA round 1's F1 on console-parallel-repaint P1.
 *
 * `reclaimBranch` is handed the live claims by `Service.occupiedTrees(scope)`,
 * and the first cut of that method read a lock with no `worktree=` line as
 * "occupies nothing". The boot prompt's own claim command writes exactly such
 * a lock (`claim N --scope … --git`, no `--here`, no PE_WORKTREE), so the hand
 * session F9 was about still had its clean root switched to the trunk. The
 * rule now is the one every other reader holds: an unqualified claim collides
 * with everything — here, holds every tree — when its scope intersects the
 * run's; a claim on another repository blocks nothing; a claim that named a
 * tree holds that ground and no other. And the files are read LIVE, not from
 * the watcher-debounced store, so a claim written a second ago counts.
 *
 * Every lock here is written by `scripts/phase-lock.sh` itself, with the
 * environment a hand session has — no `PE_*`, no `DOCS_ROOT` but the docs root
 * under test — so the shape under test is the shipped script's, not a fixture's.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Service } from '../server/service.ts';

const SKILL_DIR = new URL('../..', import.meta.url).pathname;
const LOCK_SCRIPT = join(SKILL_DIR, 'scripts', 'phase-lock.sh');

const PLAN = `---
slug: demo
created: 2026-09-01
status: active
phases: 1
---

# Demo

## Session budget

**Target model:** \`claude-opus-5\` · **Budget:** ~200K weight/session

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | First | — | — | \`api\` | it is done |

## Phases

### Phase 1 — First
- **Size:** S
- **Verification:** \`true\`

## End-to-end verification

1. \`true\`
`;

function git(cwd: string, ...args: string[]): string {
  return String(execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: {
      ...process.env, LC_ALL: 'C',
      GIT_AUTHOR_NAME: 'p1', GIT_AUTHOR_EMAIL: 'p1@example.invalid',
      GIT_COMMITTER_NAME: 'p1', GIT_COMMITTER_EMAIL: 'p1@example.invalid',
    },
  })).trim();
}

/**
 * A docs root that is ALSO the repository the plan scopes (`api/` is a real
 * directory, so `scopeConfined` is satisfied and the preflight reaches the
 * reclaim), checked out CLEAN on `pe/demo` — the wedge the reclaim exists for.
 */
function heldRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-reclaim-locks-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'demo'), { recursive: true });
  mkdirSync(join(root, 'api'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), PLAN);
  writeFileSync(join(root, 'api', 'README.md'), 'api\n');
  // The docs root IS the repository here, so a lock file would dirty the tree
  // and the reclaim would refuse `dirty` before the lock table was ever asked
  // — which is what a hand claim WITHOUT `--git` does in production, and not
  // the case under test. `--git` commits the lock; ignoring `.locks/` is the
  // cheaper way to the same clean tree.
  writeFileSync(join(root, '.gitignore'), 'docs/handoffs/*/.locks/\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'switch', '-q', '-c', 'pe/demo');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** The shipped script, with a hand session's environment: nothing exported by a console. */
function claim(root: string, phase: number, ...args: string[]): string {
  const env = { ...process.env, DOCS_ROOT: root };
  for (const key of ['PE_WORKTREE', 'PE_BRANCH', 'PE_SCOPE', 'PE_OWNER', 'PE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID']) {
    delete (env as Record<string, string | undefined>)[key];
  }
  execFileSync('bash', [LOCK_SCRIPT, 'demo', 'claim', String(phase), ...args], { cwd: root, env, encoding: 'utf8' });
  return readFileSync(join(root, 'docs', 'handoffs', 'demo', '.locks', `phase-0${phase}.lock`), 'utf8');
}

function service(root: string): Service {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false, allowRun: false,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  return svc;
}

test('QA-F1 — a live lock with NO worktree= line, on an intersecting scope, holds the root the reclaim would move', async () => {
  const { root, cleanup } = heldRoot();
  const svc = service(root);
  try {
    // Written AFTER the store's scan — the watcher's debounce would hide it,
    // and the reclaim must read the file itself (round 1's F2).
    const lock = claim(root, 2, '--owner', 'sam@laptop', '--scope', 'api');
    assert.doesNotMatch(lock, /^worktree=/m, 'the shipped claim shape names no tree — that is the point');
    assert.match(lock, /^scope=api$/m);

    const preview = await svc.isolationPreflight('demo');
    assert.ok(preview, 'no preflight answer');
    assert.equal(preview.available, false, JSON.stringify(preview));
    assert.equal(preview.refusal, 'branch-in-use');
    assert.match(String(preview.detail), /live session holds it \(sam@laptop, demo phase 2\)/);
    assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo', 'a preview moves nothing');
  } finally { svc.close(); cleanup(); }
});

test('QA-F1 — a tree-less lock on a DISJOINT scope blocks nothing, and a lapsed one is debris', async () => {
  const { root, cleanup } = heldRoot();
  const svc = service(root);
  try {
    claim(root, 2, '--owner', 'sam@laptop', '--scope', 'other-repo');
    let preview = await svc.isolationPreflight('demo');
    assert.equal(preview?.available, true, JSON.stringify(preview));
    assert.deepEqual(preview?.reclaims?.length, 1, 'the clean root would be reclaimed');

    // An intersecting claim whose lease has lapsed is nobody's — the same
    // clock the scheduler reads (`lockLapsed`).
    claim(root, 3, '--owner', 'sam@laptop', '--scope', 'api', '--lease', '1');
    await new Promise((resolve) => { setTimeout(resolve, 1200); });
    preview = await svc.isolationPreflight('demo');
    assert.equal(preview?.available, true, 'a lapsed lock must not hold the root');
  } finally { svc.close(); cleanup(); }
});

test('QA-F1 — a lock that NAMED a tree holds that ground and no other', async () => {
  const { root, cleanup } = heldRoot();
  const svc = service(root);
  try {
    // Somewhere else entirely — a linked worktree of another repository.
    const elsewhere = mkdtempSync(join(tmpdir(), 'pc-elsewhere-'));
    try {
      claim(root, 2, '--owner', 'sam@laptop', '--scope', 'api', '--worktree', elsewhere);
      let preview = await svc.isolationPreflight('demo');
      assert.equal(preview?.available, true, JSON.stringify(preview));

      // …and the root itself, by its own spelling.
      claim(root, 2, '--owner', 'sam@laptop', '--scope', 'api', '--worktree', root);
      preview = await svc.isolationPreflight('demo');
      assert.equal(preview?.available, false);
      assert.match(String(preview?.detail), /live session holds it/);
      assert.ok(existsSync(join(root, 'api', 'README.md')));
    } finally { rmSync(elsewhere, { recursive: true, force: true }); }
  } finally { svc.close(); cleanup(); }
});
