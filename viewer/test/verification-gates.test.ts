/**
 * §Verification is a gate (control-tower phase 62, #68 and #47, AUD-10).
 *
 * The console ran a phase's §Verification only once the board read the phase
 * done, and then let the board's word stand over a red verdict: the verdict
 * travelled on a record that read `done`, the dependents boarded on it, and
 * nothing it said could change any outcome — while its retries held the lock
 * and the scope grant (2.0 h of still-red retry rows in one audited week). A
 * red FINAL verdict now re-opens the phase.
 *
 *   VG-1  a red final verdict on a phase the board reads done RE-OPENS it —
 *         `phase.verification-failed`, never a `phase.done` over the red
 *   VG-2  while it is re-opened its dependents are held and the run is not
 *         finished; a green re-verification closes it and releases them
 *   VG-3  exactly one fix rung — the phase's own session, resumed with the
 *         failure — then the errand; what it holds never boards
 *   VG-4  before the LAST phase's §Verification the run settles its own
 *         mirror branches that hold nothing (#47), and gives them back before
 *         any session can commit into the mirror again
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Runner } from '../server/runner/runner.ts';
import type { SpawnOutcome, SpawnRequest } from '../server/runner/spawn.ts';
import {
  ensureMirror, laneNames, reattachMirror, resolveMounts, restoreSettledMirror, settleIdleMirrorBranches,
} from '../server/runner/worktree.ts';

// The console exports its claim variables into every session it spawns —
// this suite's own included, when an autopilot runs it.
for (const key of ['PE_WORKTREE', 'PE_BRANCH', 'PE_SCOPE', 'PE_OWNER', 'PE_PROOFS_FILE', 'PE_OUTCOME_FILE']) {
  delete process.env[key];
}

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server');

const GIT_ENV = {
  ...process.env, LC_ALL: 'C',
  GIT_AUTHOR_NAME: 'vg', GIT_AUTHOR_EMAIL: 'vg@example.invalid',
  GIT_COMMITTER_NAME: 'vg', GIT_COMMITTER_EMAIL: 'vg@example.invalid',
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hasBranch = (repo: string, branch: string): boolean =>
  git(repo, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${branch}`) === branch;

const OUTCOME: SpawnOutcome = {
  signal: { subtype: 'success', code: 0, text: 'done' },
  sessionId: 'sess-gates', costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [],
};

type Journalled = { event: string; phase?: number; data: Record<string, unknown> };

/**
 * A git repository that is also the run's root, under a phase-graph stub over
 * a small DAG: a phase reads done once its boot prompt was served, ready once
 * every dependency reads done, and waiting otherwise.
 */
function plan(deps: Record<number, number[]>): { dir: string; stub: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-gates-'));
  const stub = join(dir, '.stub');
  mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), '.stub/\n');
  writeFileSync(join(dir, 'README.md'), 'gates\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  stubGraph(stub, deps);
  return { dir, stub, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The phase-graph, lock and validate stubs `plan` describes, under `stub/scripts`. */
function stubGraph(stub: string, deps: Record<number, number[]>): void {
  const scripts = join(stub, 'scripts');
  const served = join(stub, 'served');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(served, { recursive: true });
  const phases = Object.keys(deps).map(Number).sort((a, b) => a - b);
  writeFileSync(join(scripts, 'phase-graph.sh'), `#!/bin/bash
S="${served}"
deps_of() {
  case "$1" in
${phases.map((p) => `    ${p}) echo "${(deps[p] ?? []).join(' ')}" ;;`).join('\n')}
  esac
}
case "$2" in
  --memory-block)
    d=""; r=""; w=""
    for p in ${phases.join(' ')}; do
      if [ -f "$S/$p" ]; then d="$d$p,"; continue; fi
      ok=1
      for q in $(deps_of "$p"); do [ -f "$S/$q" ] || ok=0; done
      if [ "$ok" = 1 ]; then r="$r$p,"; else w="$w$p,"; fi
    done
    # The engine's own shape: comma-separated, one bucket a line.
    echo "ready: \${r%,}"; echo "done: \${d%,}"; echo "waiting: \${w%,}" ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $3"; touch "$S/$3" ;;
  *) exit 2 ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(scripts, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(scripts, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });
}

/** One Runner over `plan`'s stub, with every spawn and journal line kept in one ordered list. */
function drive(stub: string, opts: {
  deps: Record<number, number[]>;
  verification: (phase: number) => string;
  session?: (request: SpawnRequest) => void;
  /** Further `RunnerDeps`, as the service would supply them. */
  extra?: Record<string, unknown>;
}) {
  const events: Journalled[] = [];
  const spawned: SpawnRequest[] = [];
  const instance = new Runner({
    scriptsDir: join(stub, 'scripts'),
    spawn: async (request: SpawnRequest) => {
      spawned.push(request);
      events.push({ event: 'spawn', data: { prompt: request.prompt, resume: request.resume ?? null } });
      opts.session?.(request);
      return OUTCOME;
    },
    verificationText: (_slug: string, phase: number) => opts.verification(phase),
    phaseDependencies: (_slug: string, phase: number) => opts.deps[phase] ?? [],
    onEvent: (event: string, data: Record<string, unknown>) => {
      if (event === 'run:journal') {
        events.push({ event: String(data.event), phase: data.phase as number | undefined, data: (data.data ?? {}) as Record<string, unknown> });
      }
    },
    ...opts.extra,
  } as never);
  const journalled = (name: string, phase?: number) => events
    .filter((e) => e.event === name && (phase === undefined || e.phase === phase))
    .map((e) => e.data);
  const at = (match: (e: Journalled) => boolean) => events.findIndex(match);
  return { instance, events, spawned, journalled, at };
}

const booted = (phase: number) => (e: Journalled) => e.event === 'spawn' && new RegExp(`BOOT phase ${phase}\\b`).test(String(e.data.prompt));

/* ------------------------------------------------------------------ *
 * VG-1 — a red final verdict re-opens
 * ------------------------------------------------------------------ */

test('VG-1: a red final verdict on a phase the board reads done RE-OPENS it — never a done phase with a red verdict on it', async () => {
  const p = plan({ 1: [] });
  try {
    const { instance, journalled } = drive(p.stub, { deps: { 1: [] }, verification: () => '- `false`' });
    await instance.start({ slug: 'demo', root: p.dir, autonomy: 'keep-going', autoRecover: true });
    await instance.wait();

    const [failed] = journalled('phase.verification-failed', 1);
    assert.ok(failed, 'the red verdict re-opened the phase');
    assert.equal(failed.reopened, true);
    assert.equal(failed.times, 1);
    assert.deepEqual(failed.failed, ['false']);
    assert.equal(journalled('phase.verify-overtaken').length, 0, "the board's word no longer stands over a red");
    assert.equal(journalled('phase.done').length, 0, 'no done over the red, however the board reads');

    const state = instance.current()!;
    const record = state.phases['1'];
    assert.notEqual(record.status, 'done');
    assert.equal(record.verification?.ok, false);
    assert.deepEqual(record.reopened?.failed, ['false'], 'the record says what re-opened it');
    assert.notEqual(state.halt?.kind, 'verify-failed', 'a re-open is not the halt that reconcile used to dissolve');
    assert.match(String(record.note ?? '') + String(state.phases['1'].errand?.need ?? ''), /re-opened|handoff reads complete/);
  } finally {
    p.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * VG-2 — dependents are held; green closes and releases
 * ------------------------------------------------------------------ */

test('VG-2: while a phase is re-opened its dependents are held; a green re-verification closes it and releases them', async () => {
  const p = plan({ 1: [], 2: [1] });
  try {
    const { instance, journalled, spawned, at } = drive(p.stub, {
      deps: { 1: [], 2: [1] },
      verification: (phase) => (phase === 1 ? '- `test -f .stub/fixed`' : '- `true`'),
      // The phase's first session hands off with its check red; the fix
      // session — anything that is not a boarding — makes it green.
      session: (request) => {
        if (!/BOOT phase/.test(request.prompt)) writeFileSync(join(p.stub, 'fixed'), '');
      },
    });
    await instance.start({ slug: 'demo', root: p.dir, autonomy: 'keep-going', autoRecover: true });
    await instance.wait();

    const reopenedAt = at((e) => e.event === 'phase.verification-failed' && e.phase === 1);
    const closedAt = at((e) => e.event === 'phase.done' && e.phase === 1);
    const secondAt = at(booted(2));
    assert.ok(reopenedAt >= 0, 'phase 1 was re-opened');
    assert.ok(closedAt > reopenedAt, 'and closed by a later green verdict');
    assert.ok(secondAt > closedAt, 'phase 2 boarded only once phase 1 was closed');

    const [held] = journalled('phase.verification-held', 2);
    assert.ok(held, 'the hold on the dependent is journalled');
    assert.deepEqual(held.held, [1]);
    assert.equal(journalled('phase.verification-held', 2).length, 1, 'once per change of holder, not once per tick');

    const [done] = journalled('phase.done', 1);
    assert.equal(done.reopened, 1, 'the close says the phase had been re-opened');
    const state = instance.current()!;
    assert.equal(state.phases['1'].status, 'done');
    assert.equal(state.phases['1'].reopened, undefined, 'a green verdict is what ends a re-open');
    assert.equal(state.phases['2'].status, 'done');
    assert.equal(spawned.length, 3, 'boarding 1, the one fix session, boarding 2');
  } finally {
    p.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * VG-3 — one fix rung, then the errand
 * ------------------------------------------------------------------ */

test('VG-3: one fix rung — the phase\'s own session, resumed with the failure — then the errand; what it holds never boards', async () => {
  const p = plan({ 1: [], 2: [1] });
  try {
    const { instance, journalled, spawned, at } = drive(p.stub, {
      deps: { 1: [], 2: [1] },
      verification: (phase) => (phase === 1 ? '- `false`' : '- `true`'),
    });
    await instance.start({ slug: 'demo', root: p.dir, autonomy: 'keep-going', autoRecover: true });
    await instance.wait();

    const rungs = journalled('phase.rung', 1);
    assert.equal(rungs.length, 1, 'exactly one rung for a re-opened phase');
    assert.equal(rungs[0].situation, 'verify-red:reopened');
    assert.equal(rungs[0].rung, 'resume-own-session');
    assert.deepEqual(rungs[0].params, { mode: 'fix-verification' });

    assert.equal(spawned.length, 2, 'the boarding and the one fix session');
    assert.equal(spawned[1].resume, 'sess-gates', "the fix is the phase's OWN session, resumed");
    assert.match(spawned[1].prompt, /false/, 'and it is told which command is red');

    const [errand] = journalled('phase.errand', 1);
    assert.ok(errand, 'the ladder ends in an errand');
    assert.match(String(errand.need), /handoff reads complete/);
    assert.equal(at(booted(2)), -1, 'the dependent never boards over a red phase');
    const state = instance.current()!;
    assert.notEqual(state.phases['1'].status, 'done');
    assert.notEqual(state.phases['2']?.status, 'done');
    assert.notEqual(state.status, 'done', 'a run holding a re-opened phase is not finished');
  } finally {
    p.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * VG-4 — the run's own idle mirror branches, before the last phase's checks
 * ------------------------------------------------------------------ */

/** A superproject root{ web, app{ core } } whose submodules are real checkouts. */
function superproject(): { base: string; root: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'pc-gates-mirror-'));
  const src = (name: string): string => {
    const dir = join(base, `src-${name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.txt`), `${name}\n`);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    return dir;
  };
  const core = src('core');
  const app = src('app');
  git(app, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', core, 'core');
  git(app, 'commit', '-qm', 'core');
  const web = src('web');
  const root = join(base, 'repo');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'README.md'), 'root\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', web, 'web');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', app, 'app');
  git(root, 'commit', '-qm', 'submodules');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init', '--recursive');
  return { base, root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('VG-4: settling deletes the run branch only where it holds nothing — the root mount only when merged and clean, never work, never a dirty mount — and restoring puts back exactly what was there', async () => {
  const s = superproject();
  try {
    const names = laneNames({ stateDir: join(s.base, 'state'), runId: 'r1', slug: 'demo', phase: 0 });
    const resolved = await resolveMounts(s.root, ['all']);
    assert.equal(resolved.ok, true);
    const mounts = (resolved as { mounts: { rel: string; source: string }[] }).mounts;
    assert.deepEqual(mounts.map((m) => m.rel), ['', 'app', 'web', 'app/core']);
    const made = await ensureMirror({ names, runId: 'r1', slug: 'demo', mounts });
    assert.equal(made.ok, true, made.detail);
    const at = (rel: string) => join(names.integration, rel);

    // `app` holds this run's work; `web` and `app/core` hold nothing, and the
    // root is 0 ahead and clean too — so since phase 89 it is settled like
    // them (a root carrying a landing the trunk lacks is not: mirror-branches.test.ts).
    writeFileSync(join(at('app'), 'work.txt'), 'work\n');
    git(at('app'), 'add', 'work.txt');
    git(at('app'), 'commit', '-qm', 'the run\'s work');
    const coreTip = git(at('app/core'), 'rev-parse', 'HEAD');
    // A dirty idle mount is kept, whatever its branch holds.
    writeFileSync(join(at('web'), 'scratch.txt'), 'scratch\n');

    let out = await settleIdleMirrorBranches(names.integration, names.runBranch);
    assert.deepEqual(out.settled, ['', 'app/core']);
    assert.deepEqual(out.kept, [{ mount: 'web', reason: 'the mount holds uncommitted work' }]);
    assert.equal(git(at(''), 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'the root mount, merged and clean, is settled like the others');
    assert.equal(hasBranch(s.root, 'pe/demo'), false);
    assert.equal(git(at('app'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo', 'a branch with work is never a candidate');
    assert.equal(git(at('app/core'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'the settled mount is detached…');
    assert.equal(git(at('app/core'), 'rev-parse', 'HEAD'), coreTip, '…at the very commit it stood on');
    assert.equal(hasBranch(join(s.root, 'app', 'core'), 'pe/demo'), false, 'and its branch is gone');
    assert.equal(hasBranch(join(s.root, 'app'), 'pe/demo'), true);

    // Restoring: the branch re-created where the mount stands, the mount on it.
    const back = await restoreSettledMirror(names.integration, names.runBranch, out.settled);
    assert.deepEqual(back, { restored: ['', 'app/core'], failed: [] });
    assert.equal(git(at('app/core'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo');
    assert.equal(git(at('app/core'), 'rev-parse', 'HEAD'), coreTip);

    // …and the next drive's reattach heals a settled mount by itself.
    rmSync(join(at('web'), 'scratch.txt'));
    out = await settleIdleMirrorBranches(names.integration, names.runBranch);
    assert.deepEqual(out.settled, ['', 'web', 'app/core']);
    const moved = await reattachMirror(names.integration, names.runBranch);
    assert.equal(moved.ok, true, moved.detail);
    assert.deepEqual([...moved.moved].sort(), ['', 'app/core', 'web']);
    for (const rel of ['', 'web', 'app/core']) {
      assert.equal(git(at(rel), 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo', `${rel} is back on the run branch`);
    }
  } finally {
    s.cleanup();
  }
});

test('VG-4: the LAST phase\'s §Verification runs over a mirror without the run\'s idle branches; an earlier phase\'s does not, and a red verdict gives them back before the fix session boards', async () => {
  const s = superproject();
  const stub = join(s.base, 'stub');
  mkdirSync(join(s.root, 'docs', 'plans'), { recursive: true });
  stubGraph(stub, { 1: [], 2: [1] });

  // Phase 1 commits into `app`; nothing ever commits into `web` or `app/core`.
  // Each phase's check asserts what its checkout looks like when it runs.
  const idle = '! git -C web show-ref --verify --quiet refs/heads/pe/demo && ! git -C app/core show-ref --verify --quiet refs/heads/pe/demo';
  const standing = 'git -C web show-ref --verify --quiet refs/heads/pe/demo';
  let fixed = false;
  const seenAtFix: string[] = [];
  const { instance, journalled, spawned } = drive(stub, {
    deps: { 1: [], 2: [1] },
    extra: { planScope: () => ['app', 'web'] },
    verification: (phase) => (phase === 1
      ? `- \`bash -c "${standing}"\``
      : `- \`bash -c "${idle}"\`\n- \`test -f fixed\``),
    session: (request) => {
      if (/BOOT phase 1\b/.test(request.prompt)) {
        writeFileSync(join(request.cwd, 'app', 'work.txt'), 'work\n');
        git(join(request.cwd, 'app'), 'add', 'work.txt');
        git(join(request.cwd, 'app'), 'commit', '-qm', 'phase 1');
      } else if (!/BOOT phase/.test(request.prompt)) {
        // The fix session: what it finds is what it would commit onto.
        seenAtFix.push(git(join(request.cwd, 'web'), 'rev-parse', '--abbrev-ref', 'HEAD'));
        writeFileSync(join(request.cwd, 'fixed'), '');
        fixed = true;
      }
    },
  });
  try {
    await instance.start({
      slug: 'demo', root: s.root, autonomy: 'keep-going', autoRecover: true, gitMode: 'new-branch', isolation: 'worktree', openPr: false,
    } as never);
    await instance.wait();
    const state = instance.current()!;
    assert.deepEqual(state.mountedRepos, ['app', 'web', 'app/core'], 'the run stood on a mirror');

    assert.equal(state.phases['1'].status, 'done', 'phase 1\'s check saw its branches standing — it was not the last');
    const settles = journalled('run.mirror-branches-settled');
    assert.ok(settles.length >= 1, 'the last phase settled the idle branches');
    assert.ok(settles.every((line) => line.phase === 2), 'only the last phase settles');
    assert.deepEqual(settles[0].settled, ['web', 'app/core'], '`app` holds phase 1\'s work and is never a candidate');
    // Each deleted branch is journalled with its proof and tip (phase 89, #47),
    // so it can always be named and re-created from the journal alone.
    assert.deepEqual(
      (settles[0].proofs as { mount: string; by: string; tip: string }[]).map((p) => [p.mount, p.by, /^[0-9a-f]{40}$/.test(p.tip)]),
      [['web', 'ancestry', true], ['app/core', 'ancestry', true]],
    );

    // The first pass of phase 2 was red (no `fixed` yet): the branches came
    // back AT ONCE, so the fix session boarded onto a mirror on its branch.
    const [restored] = journalled('run.mirror-branches-restored');
    assert.ok(restored, 'a red final verdict gives the branches back');
    assert.equal(restored.cause, 'not-green');
    assert.deepEqual(restored.restored, ['web', 'app/core']);
    assert.ok(fixed, 'the fix session ran');
    assert.deepEqual(seenAtFix, ['pe/demo'], 'no session is ever spawned into a settled mount');

    // Its second pass settled again, ran green, and closed the phase.
    assert.equal(state.phases['2'].status, 'done', state.phases['2'].note);
    assert.equal(settles.length, 2);
    assert.equal(hasBranch(join(s.root, 'web'), 'pe/demo'), false, 'the idle branches end the run settled');
    assert.equal(hasBranch(join(s.root, 'app'), 'pe/demo'), true, 'the branch holding the run\'s work stays');
    assert.equal(spawned.length, 3);
  } finally {
    s.cleanup();
  }
});

test('VG-4: the one spawn door puts a settled mirror back before anything else — no session is spawned onto a detached mount', () => {
  const source = readFileSync(join(SERVER, 'runner', 'runner-base.ts'), 'utf8');
  const door = source.slice(source.indexOf('protected async spawnSession('));
  const opens = 'Promise<SpawnOutcome> {';
  const body = door.slice(door.indexOf(opens) + opens.length);
  const firstStatement = body.split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('//'));
  assert.equal(firstStatement, "await this.restoreIdleMirror('spawn');");
});
