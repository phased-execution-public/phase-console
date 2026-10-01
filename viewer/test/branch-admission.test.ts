/**
 * Admit on the branch, not just the lock (control-tower phase 40, #41) —
 * criteria BA-1 … BA-10.
 *
 * A phase lock says who may WRITE a repository for one phase; the branch a
 * new-branch run leaves a SHARED checkout on belongs to the whole RUN. These
 * tests build a real superproject (the root plus two initialized repositories
 * `app` and `api` under it, declared in `.gitmodules`), stand its trees on
 * other runs' branches through real hold records under the sandboxed state
 * home, and drive a real `Runner` over a stub engine — the same records the
 * bash door (`phase-lock.sh conflicts`) reads in BA-9.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';
// A console-spawned test run carries its own claim; the fixtures state theirs.
for (const key of ['PE_WORKTREE', 'PE_BRANCH', 'PE_SCOPE', 'PE_OWNER', 'PE_SESSION_ID']) delete process.env[key];

const { SKILL_DIR } = await import('../server/config.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { Scheduler } = await import('../server/runner/scheduler.ts');
const { journalFile, newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { branchHolderOf, readHolds, readTrees, treesDir, writeHold } = await import('../server/runner/tree-state.ts');
const { claimsDisjoint } = await import('../shared/scope.js');
type SpawnFn = import('../server/runner/spawn.ts').SpawnFn;
type RunState = import('../server/runner/state.ts').RunState;

type Line = { event: string; data: Record<string, unknown>; phase?: number };

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function git(cwd: string, ...args: string[]): string {
  return String(execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env, LC_ALL: 'C',
      GIT_AUTHOR_NAME: 'p40', GIT_AUTHOR_EMAIL: 'p40@example.invalid',
      GIT_COMMITTER_NAME: 'p40', GIT_COMMITTER_EMAIL: 'p40@example.invalid',
    },
  })).trim();
}

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

type Estate = { root: string; scripts: string; stub: string; cleanup: () => void };

/**
 * A superproject whose board reads phases 1–`phases` ready until each is done:
 * the root on `main`, with `app` and `api` — each a repository of its own on
 * `main` — declared in `.gitmodules` and initialized under it.
 */
function estate(phases = 2): Estate {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-branch-adm-')));
  const scripts = join(root, 'scripts');
  const stub = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(stub, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), '# alpha\n');
  writeFileSync(join(stub, 'done'), '');
  const list = Array.from({ length: phases }, (_, i) => i + 1).join(' ');
  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
S="${stub}"
slug="$1"; shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    d=""; r=""
    for p in ${list}; do
      if grep -qx "$p" "$S/done" 2>/dev/null; then d="$d$p,"; else r="$r$p,"; fi
    done
    echo "done: \${d%,}"; echo "in-progress: "; echo "stuck: "
    echo "ready: \${r%,}"; echo "waiting: "
    ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  --repos)
    if [ -n "$arg" ] && [ -f "$S/repos-$arg" ]; then cat "$S/repos-$arg"
    elif [ -f "$S/repos" ]; then cat "$S/repos"
    else echo all; fi
    ;;
  *) echo "" ;;
esac
`);
  write(join(scripts, 'phase-lock.sh'), '#!/usr/bin/env bash\n[ "${2:-}" = "status" ] && echo "phase ${3:-?}: free"\nexit 0\n');
  write(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  write(join(scripts, 'next-phase-prompt.sh'), '#!/usr/bin/env bash\nexit 0\n');
  write(join(scripts, 'new-handoff.sh'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(join(root, '.gitmodules'),
    '[submodule "app"]\n\tpath = app\n\turl = ./app\n[submodule "api"]\n\tpath = api\n\turl = ./api\n');
  writeFileSync(join(root, '.gitignore'), '.stub/\napp/\napi/\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  for (const sub of ['app', 'api']) {
    const dir = join(root, sub);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), `# ${sub}\n`);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `${sub} base`);
  }
  return {
    root, scripts, stub,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(treesDir(), { recursive: true, force: true });
    },
  };
}

/**
 * Another run's hold: `rel` checked out onto `pe/<slug>` and a hold record
 * naming the run, whose state file reads `status`.
 */
function holdBy(e: Estate, run: string, slug: string, rel: string, status = 'running'): { runFile: string } {
  const dir = rel ? join(e.root, rel) : e.root;
  git(dir, 'checkout', '-q', '-B', `pe/${slug}`);
  const runFile = join(e.stub, `run-${run}.json`);
  writeFileSync(runFile, `{\n  "id": "${run}",\n  "slug": "${slug}",\n  "status": "${status}"\n}\n`);
  writeHold({
    run, slug, owner: `autopilot/${run}`, repo: realpathSync(dir), rel, root: e.root,
    branch: `pe/${slug}`, foundOn: 'main', at: new Date().toISOString(), runFile,
  });
  return { runFile };
}

function driver(e: Estate, scopes: Record<number, string[]>, deps: Record<string, unknown> = {}) {
  const spawned: number[] = [];
  const prompts = new Map<number, string>();
  const scheduler = new Scheduler({ max: 3, locks: () => [] });
  const onSpawn = (deps.onSpawn as ((phase: number) => void) | undefined);
  // The engine's own answer to `--repos`, which isolation reads.
  for (const [phase, scope] of Object.entries(scopes)) writeFileSync(join(e.stub, `repos-${phase}`), `${scope.join(',')}\n`);
  writeFileSync(join(e.stub, 'repos'), `${[...new Set(Object.values(scopes).flat())].join(',')}\n`);
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1]);
    spawned.push(phase);
    prompts.set(phase, request.prompt);
    onSpawn?.(phase);
    appendFileSync(join(e.stub, 'done'), `${phase}\n`);
    return {
      signal: { subtype: 'success', code: 0, text: '' }, sessionId: `sess-${phase}`, costUsd: 0, turns: 1,
      resultText: 'done', durationMs: 1, argv: ['-p', '<prompt>'],
    } as never;
  };
  const runner = new Runner({
    scriptsDir: e.scripts, spawn, scheduler, maxParallel: 3,
    verificationText: () => '`true`',
    phaseScope: (_slug: string, phase: number) => scopes[phase] ?? ['all'],
    // What isolation resolves its mounts from — the plan's whole scope.
    planScope: () => [...new Set(Object.values(scopes).flat())],
    treePollMs: 40,
    ...deps,
  } as never);
  return { runner, scheduler, spawned, prompts, close: () => { scheduler.close(); runner.close(); } };
}

function journalOf(root: string, slug: string, runId: string): Line[] {
  let text = '';
  try { text = readFileSync(journalFile(root, slug, runId), 'utf8'); } catch { return []; }
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Line);
}

async function until(what: string, predicate: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const queuedLines = (lines: Line[], phase: number) => lines.filter((l) => l.event === 'phase.queued' && l.phase === phase);

/* ------------------------------------------------------------------ *
 * BA-1..3 — the loop and the heal never board into another run's branch
 * ------------------------------------------------------------------ */

test('BA-1 — a phase whose scoped repository stands on another open run\'s branch queues behind it; a disjoint phase boards; it boards when the tree returns', async () => {
  const e = estate();
  holdBy(e, 'r-beta', 'beta', 'app');
  const d = driver(e, { 1: ['app'], 2: ['api'] });
  try {
    await d.runner.start({ slug: 'alpha', root: e.root, autonomy: 'keep-going' } as never);
    const state = (): RunState => d.runner.current()!;
    await until('phase 1 to queue behind the branch', () => state()?.phases['1']?.status === 'queued' && d.spawned.includes(2));
    assert.deepEqual(d.spawned, [2], 'the disjoint phase boarded; the held one did not');
    const record = state().phases['1'];
    assert.equal(record.waitingOn?.[0]?.kind, 'branch');
    assert.equal(record.waitingOn?.[0]?.repo, 'app');
    assert.equal(record.waitingOn?.[0]?.branch, 'pe/beta');
    assert.equal(record.waitingOn?.[0]?.run, 'r-beta');
    const snapshot = d.scheduler.snapshot().entries.find((entry) => entry.phase === 1);
    assert.equal(snapshot?.waitingOn[0]?.kind, 'branch', 'the queue page sees the holder kind');

    // The tree comes back to the trunk: nothing else changes, and it boards.
    git(join(e.root, 'app'), 'checkout', '-q', 'main');
    await d.runner.wait();
    assert.deepEqual(d.spawned.sort(), [1, 2]);
    const lines = journalOf(e.root, 'alpha', state().id);
    const queued = queuedLines(lines, 1);
    assert.equal(queued.length, 1, 'one phase.queued line for the whole wait');
    assert.equal(queued[0].data.headKind, 'branch');
    const holder = (queued[0].data.waitingOn as Record<string, unknown>[])[0];
    assert.equal(holder.kind, 'branch');
    assert.equal(holder.repo, 'app');
    assert.equal(holder.branch, 'pe/beta');
    assert.equal(holder.run, 'r-beta');
    assert.equal(state().phases['1'].waitingOn, undefined, 'the holders are history once admitted');
  } finally {
    d.close();
    e.cleanup();
  }
});

test('BA-2 — the holder settling frees the tree without anyone moving it, and its hold record is swept', async () => {
  const e = estate(1);
  const { runFile } = holdBy(e, 'r-beta', 'beta', 'app');
  const d = driver(e, { 1: ['app'] });
  try {
    await d.runner.start({ slug: 'alpha', root: e.root, autonomy: 'keep-going' } as never);
    await until('phase 1 to queue', () => d.runner.current()?.phases['1']?.status === 'queued');
    assert.deepEqual(d.spawned, []);
    assert.equal(readHolds().length, 1);
    // The other run settles — its state file says so; no release ran (a
    // console that died, a stop of a run nobody was driving).
    writeFileSync(runFile, '{\n  "id": "r-beta",\n  "status": "finished"\n}\n');
    await d.runner.wait();
    assert.deepEqual(d.spawned, [1], 'boarded while the tree still stands on the settled run\'s branch');
    assert.equal(git(join(e.root, 'app'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/beta');
    assert.equal(readHolds().length, 0, 'a lapsed hold is swept as it is read');
  } finally {
    d.close();
    e.cleanup();
  }
});

test('BA-3 — the heal\'s door (a stored run resumed) does not board a held phase either', async () => {
  const e = estate(1);
  holdBy(e, 'r-beta', 'beta', 'app');
  const d = driver(e, { 1: ['app'] });
  try {
    const stored = newRun({ slug: 'alpha', root: e.root });
    stored.status = 'parked';
    phaseRecord(stored, 1).status = 'failed';
    saveRun(stored);
    await d.runner.start({ slug: 'alpha', root: e.root, resumeRunId: stored.id, autonomy: 'keep-going' } as never);
    await until('the resumed phase to queue', () => d.runner.current()?.phases['1']?.status === 'queued');
    assert.deepEqual(d.spawned, [], 'no session boarded into the held tree');
    assert.equal(d.runner.current()!.phases['1'].waitingOn?.[0]?.kind, 'branch');
    git(join(e.root, 'app'), 'checkout', '-q', 'main');
    await d.runner.wait();
    assert.deepEqual(d.spawned, [1]);
  } finally {
    d.close();
    e.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * BA-4 — a run holds the branch until the RUN settles
 * ------------------------------------------------------------------ */

test('BA-4 — a run that checked a shared repository onto its branch holds it across phases, and releases it — back on the branch it was found on — when the run settles', async () => {
  const e = estate(2);
  const seen: { phase: number; holds: string[] }[] = [];
  const app = join(e.root, 'app');
  const d = driver(e, { 1: ['app'], 2: ['app'] }, {
    // The session does what the git strategy tells it: check the run branch out.
    onSpawn: (phase: number) => {
      seen.push({ phase, holds: readHolds().map((hold) => `${hold.rel}@${hold.branch}`) });
      git(app, 'checkout', '-q', '-B', 'pe/alpha');
      writeFileSync(join(app, `p${phase}.txt`), 'work\n');
      git(app, 'add', '-A');
      git(app, 'commit', '-q', '-m', `phase ${phase}`);
    },
  });
  try {
    await d.runner.start({
      slug: 'alpha', root: e.root, autonomy: 'keep-going', gitMode: 'new-branch', onlyPhases: [1, 2],
    } as never);
    await d.runner.wait();
    const state = d.runner.current()!;
    assert.equal(state.status, 'finished');
    // Both phases are ready at once and share the scope, so either may board
    // first; the second always boards into the tree the first left held.
    assert.deepEqual(seen.map((s) => s.phase).sort(), [1, 2]);
    assert.deepEqual(seen[0].holds, [], 'nothing is held before the run checked anything out');
    assert.deepEqual(seen[1].holds, ['app@pe/alpha'], 'the first phase ended and its lock went — the RUN still holds the tree');
    const lines = journalOf(e.root, 'alpha', state.id);
    const holds = lines.filter((l) => l.event === 'run.tree-hold');
    assert.equal(holds.length, 1, 'one hold per repository per run, not one per phase');
    assert.equal(holds[0].data.repo, 'app');
    assert.equal(holds[0].data.branch, 'pe/alpha');
    assert.equal(holds[0].data.foundOn, 'main');
    const released = lines.filter((l) => l.event === 'run.tree-released');
    assert.equal(released.length, 1);
    assert.equal(released[0].data.repo, 'app');
    assert.equal(released[0].data.to, 'main');
    assert.equal(git(app, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the last holder returned the tree');
    assert.equal(readHolds().length, 0);
    assert.equal(state.treeHolds, undefined, 'the run record holds nothing once settled');
  } finally {
    d.close();
    e.cleanup();
  }
});

test('BA-4 — a tree with uncommitted work is released but never moved', async () => {
  const e = estate(1);
  const app = join(e.root, 'app');
  const d = driver(e, { 1: ['app'] }, {
    onSpawn: () => {
      git(app, 'checkout', '-q', '-B', 'pe/alpha');
      writeFileSync(join(app, 'README.md'), '# app — edited, not committed\n');
    },
  });
  try {
    await d.runner.start({ slug: 'alpha', root: e.root, autonomy: 'keep-going', gitMode: 'new-branch', onlyPhases: [1] } as never);
    await d.runner.wait();
    const released = journalOf(e.root, 'alpha', d.runner.current()!.id).filter((l) => l.event === 'run.tree-released');
    assert.equal(released.length, 1);
    assert.equal(released[0].data.to, undefined);
    assert.match(String(released[0].data.kept), /uncommitted/);
    assert.equal(git(app, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/alpha');
    assert.equal(readHolds().length, 0, 'released all the same — the run is over');
  } finally {
    d.close();
    e.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * BA-5 — a superproject scope reads its submodules
 * ------------------------------------------------------------------ */

test('BA-5 — the superproject on one run\'s branch and its submodule on another\'s: a root-scoped phase queues; the reader lists every repository', async () => {
  const e = estate(1);
  holdBy(e, 'r-x', 'x', '');
  holdBy(e, 'r-y', 'y', 'app');
  const trees = await readTrees(e.root, ['all']);
  assert.deepEqual(trees.map((t) => `${t.rel || '.'}@${t.branch}`), ['.@pe/x', 'api@main', 'app@pe/y']);
  assert.ok(trees.every((t) => /^[0-9a-f]{40}$/.test(t.head ?? '')), 'each with its head');
  // The submodule alone, from the root's own scope.
  const holds = readHolds();
  const self = { run: 'r-alpha', slug: 'alpha' };
  const claim = { branch: 'pe/alpha', tree: e.root };
  assert.equal(branchHolderOf(await readTrees(e.root, ['app']), holds, self, claim)?.run, 'r-y');
  assert.equal(branchHolderOf(await readTrees(e.root, ['api']), holds, self, claim), null);

  const d = driver(e, { 1: ['all'] });
  try {
    await d.runner.start({ slug: 'alpha', root: e.root, autonomy: 'keep-going' } as never);
    await until('the root-scoped phase to queue', () => d.runner.current()?.phases['1']?.status === 'queued');
    const holder = d.runner.current()!.phases['1'].waitingOn?.[0];
    assert.equal(holder?.kind, 'branch');
    assert.equal(holder?.repo, '.', 'the superproject itself, first');
    assert.equal(holder?.run, 'r-x');
    // The superproject returns; the submodule still stands on another run's branch.
    git(e.root, 'checkout', '-q', 'main');
    await until('the holder to become the submodule', () => d.runner.current()?.phases['1']?.waitingOn?.[0]?.run === 'r-y'
      || d.scheduler.snapshot().entries.some((entry) => entry.waitingOn[0]?.run === 'r-y'));
    assert.deepEqual(d.spawned, []);
    git(join(e.root, 'app'), 'checkout', '-q', 'main');
    await d.runner.wait();
    assert.deepEqual(d.spawned, [1]);
  } finally {
    d.close();
    e.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * BA-6 — the boot prompt warns
 * ------------------------------------------------------------------ */

test('BA-6 — a phase boarding into a repository on a foreign pe/ branch carries the warning block; one on the trunk does not', async () => {
  const e = estate(2);
  // A branch some other plan left behind, with no open run holding it: nothing
  // queues on it, and the session must still be told.
  git(join(e.root, 'app'), 'checkout', '-q', '-b', 'pe/gamma');
  const d = driver(e, { 1: ['app'], 2: ['api'] });
  try {
    await d.runner.start({ slug: 'alpha', root: e.root, autonomy: 'keep-going' } as never);
    await d.runner.wait();
    assert.deepEqual(d.spawned.sort(), [1, 2]);
    const warned = d.prompts.get(1)!;
    assert.match(warned, /ANOTHER PLAN'S BRANCH IS CHECKED OUT IN YOUR SCOPE/);
    assert.match(warned, /`app` stands on `pe\/gamma`/);
    assert.match(warned, /no open run holds it/);
    assert.doesNotMatch(d.prompts.get(2)!, /ANOTHER PLAN'S BRANCH/, 'the trunk warns nobody');
  } finally {
    d.close();
    e.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * BA-7 / BA-8 — a run whose trees are its own is untouched
 * ------------------------------------------------------------------ */

test('BA-7 / BA-8 — an isolated run (here the mirror a superproject takes) is never queued by the branch rule, and writes no hold', async () => {
  const e = estate(1);
  holdBy(e, 'r-beta', 'beta', 'app');
  const d = driver(e, { 1: ['app'] });
  try {
    await d.runner.start({
      slug: 'alpha', root: e.root, autonomy: 'keep-going', onlyPhases: [1], gitMode: 'new-branch', isolation: 'worktree',
    } as never);
    // Fails fast rather than hanging if isolation is ever refused here: a
    // refused run falls back to the shared checkout, where the rule applies.
    await until('the isolated phase to board', () => d.spawned.includes(1));
    await d.runner.wait();
    const state = d.runner.current()!;
    assert.equal(state.checkout, 'worktree', `isolation was granted (${state.isolationRefusal ?? 'no refusal'})`);
    assert.deepEqual(d.spawned, [1], 'boarded at once in its own tree');
    const lines = journalOf(e.root, 'alpha', state.id);
    assert.equal(queuedLines(lines, 1).length, 0, 'no queue entry, no phase.queued');
    assert.equal(lines.filter((l) => l.event === 'run.tree-hold' || l.event === 'run.tree-released').length, 0);
    assert.doesNotMatch(d.prompts.get(1)!, /ANOTHER PLAN'S BRANCH/, 'its trees are its own');
    assert.deepEqual(readHolds().map((hold) => hold.run), ['r-beta'], 'the other run\'s hold is untouched');
  } finally {
    d.close();
    e.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * BA-9 — the bash door answers what the scheduler answers
 * ------------------------------------------------------------------ */

function conflicts(e: Estate, args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('PE_') && key !== 'DOCS_ROOT') clean[key] = value;
  }
  const run = spawnSync('/bin/bash', [join(SKILL_DIR, 'scripts', 'phase-lock.sh'), 'alpha', 'conflicts', ...args], {
    cwd: e.root, encoding: 'utf8', env: { ...clean, DOCS_ROOT: e.root, ...env },
  });
  return { code: run.status ?? -1, out: `${run.stdout}${run.stderr}` };
}

test('BA-9 — phase-lock.sh conflicts names a repository another RUN holds on its branch, exactly when the scheduler\'s rule does', async () => {
  const e = estate(1);
  holdBy(e, 'r-beta', 'beta', 'app');
  const self = { run: 'r-alpha', slug: 'alpha' };
  const ask = async (scope: string[], claim: { branch?: string; tree?: string }) =>
    branchHolderOf(await readTrees(e.root, scope), readHolds(), self, claim);
  try {
    const shared = ['--scope', 'app', '--branch', 'pe/alpha', '--worktree', e.root];
    // Held: the tree is shared, the branch is someone else's.
    const held = conflicts(e, shared);
    assert.equal(held.code, 1, held.out);
    assert.match(held.out, /CONFLICT beta run r-beta — holds app on pe\/beta/);
    assert.equal((await ask(['app'], { branch: 'pe/alpha', tree: e.root }))?.run, 'r-beta');
    // A superproject scope reaches the submodule; a disjoint one does not.
    assert.equal(conflicts(e, ['--scope', 'all', '--branch', 'pe/alpha', '--worktree', e.root]).code, 1);
    assert.equal(conflicts(e, ['--scope', 'api', '--branch', 'pe/alpha', '--worktree', e.root]).code, 0);
    assert.equal(await ask(['api'], { branch: 'pe/alpha', tree: e.root }), null);
    // An unqualified hand session collides — it may be standing in the tree.
    assert.equal(conflicts(e, ['--scope', 'app']).code, 1);
    assert.equal((await ask(['app'], {}))?.run, 'r-beta');
    // A checkout of its own is carved away.
    const lane = join(e.root, '.worktrees', 'hand', 'alpha', 'p1');
    mkdirSync(lane, { recursive: true });
    assert.equal(conflicts(e, ['--scope', 'app', '--branch', 'pe/alpha-p1', '--worktree', lane]).code, 0);
    assert.equal(await ask(['app'], { branch: 'pe/alpha-p1', tree: lane }), null);
    // The holding run's own session is not blocked by its own hold.
    assert.equal(conflicts(e, shared, { PE_OWNER: 'autopilot/r-beta' }).code, 0);
    // The tree returns: both doors clear.
    git(join(e.root, 'app'), 'checkout', '-q', 'main');
    assert.equal(conflicts(e, shared).code, 0);
    assert.equal(await ask(['app'], { branch: 'pe/alpha', tree: e.root }), null);
  } finally {
    e.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * BA-10 — a reservation never passes a branch hold (phase 6's note)
 * ------------------------------------------------------------------ */

test('BA-10 — a reserved admission waits behind a branch hold like every clock, and the probe says so', async () => {
  const scheduler = new Scheduler({ max: 4, locks: () => [] });
  let held = true;
  const branchHold = () => (held ? { repo: 'app', dir: '/w/app', branch: 'pe/beta', run: 'r-beta', slug: 'beta' } : null);
  try {
    const request = { slug: 'alpha', phase: 1, runId: 'r-alpha', scope: ['app'], reserve: true, branchHold };
    const probe = scheduler.wouldBlock(request as never);
    assert.equal(probe[0]?.kind, 'branch');
    assert.equal(probe[0]?.owner.includes('r-beta'), true);
    const admitted = scheduler.admit(request as never);
    let done = false;
    void admitted.then(() => { done = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(done, false, 'reserve does not pass a branch hold');
    const entry = scheduler.snapshot().entries[0];
    assert.equal(entry.waitingOn[0].kind, 'branch');
    assert.equal(entry.reserving, false, 'a branch hold is a skip, never a reservation of tokens');
    // A disjoint scope is none of its business.
    const other = await scheduler.admit({ slug: 'alpha', phase: 2, runId: 'r-alpha', scope: ['api'] });
    assert.equal(other.phase, 2);
    held = false;
    scheduler.poll();
    assert.equal((await admitted).phase, 1);
  } finally {
    scheduler.close();
  }
});

test('the reader: no hold file, no hold; a hold on a repository that left the branch holds nothing', async () => {
  const e = estate(1);
  try {
    assert.equal(existsSync(treesDir()), false);
    assert.deepEqual(readHolds(), []);
    holdBy(e, 'r-beta', 'beta', 'app');
    git(join(e.root, 'app'), 'checkout', '-q', 'main');
    assert.equal(branchHolderOf(await readTrees(e.root, ['app']), readHolds(), { run: 'r-alpha', slug: 'alpha' }, {}), null);
  } finally {
    e.cleanup();
  }
});

test('claimsDisjoint learns the RUN hold: the held branch is no collision, a different branch on the same ground always is', () => {
  const hold = { hold: true, branch: 'pe/beta', tree: '/w/hub/app' };
  const cases: [{ branch?: string; tree?: string }, boolean, string][] = [
    [{ branch: 'pe/beta', tree: '/w/hub' }, true, 'the tree already stands where this claim needs it'],
    [{ branch: 'pe/alpha', tree: '/w/hub' }, false, 'the superproject is the same ground as its submodule'],
    [{ branch: 'pe/alpha', tree: '/w/hub/app' }, false, 'the held repository itself'],
    [{ tree: '/w/hub' }, false, 'a run on the trunk names no branch — it needs the tree back'],
    [{ branch: 'pe/alpha' }, false, 'no tree: it may be standing in the held one'],
    [{}, false, 'unqualified collides, as everywhere'],
    [{ branch: 'pe/alpha-p2', tree: '/w/hub/.worktrees/runs/alpha/p2' }, true, 'a lane worktree is a tree of its own'],
    [{ branch: 'pe/alpha', tree: '/w/other' }, true, 'another checkout entirely'],
  ];
  for (const [claim, disjoint, why] of cases) {
    assert.equal(claimsDisjoint(hold, claim), disjoint, why);
    assert.equal(claimsDisjoint(claim, hold), disjoint, `${why} — either side may carry the hold`);
  }
  // Two LOCKS naming different branches in different trees stay disjoint: the
  // hold changes nothing about the lock rule.
  assert.equal(claimsDisjoint({ branch: 'pe/a', tree: '/w/a' }, { branch: 'pe/b', tree: '/w/b' }), true);
});
