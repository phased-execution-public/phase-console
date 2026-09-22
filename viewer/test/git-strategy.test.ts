/**
 * The git-strategy block — what a session is told about branches, and when.
 *
 * The base invariant is silence: a run without `gitMode: 'new-branch'` composes
 * a prompt byte-identical to the one it composed before this feature existed.
 * On top of that, four shapes are pinned: the BRANCH block and its position
 * (after the engine's text, before the skill directive — the plan speaks first,
 * the directive keeps the last word); the WORKTREE escalation exactly when a
 * cross-run holder shares a repository right now; the MISMATCH note only when
 * the plan's own prose names a real branch; and the PR block only on the phase
 * that is genuinely the plan's last — never on a scoped run, never when the
 * operator said no PR.
 *
 * Everything runs against the stub engine from the default-skills harness; the
 * prompt handed to the stubbed spawn is the only honest place to assert any of
 * this.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-gitstrat-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
// The config guard too: the registry read at import was reaching the
// operator's REAL ~/.config/phase-console before the belt existed.
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');
process.env.PHASE_CONSOLE_LOG = '';
// 🔴 The console exports `PE_*` into every session it spawns — including the
// one running THIS suite under an autopilot. `sessionEnv` spreads
// `process.env`, so an assertion that a claim variable is ABSENT read the
// supervisor's own `PE_WORKTREE` and failed for a reason that had nothing to
// do with the runner (the third harness this leak has reached — see
// `worktree.test.ts` and `wire-formats.test.ts` for the first two).
for (const key of ['PE_WORKTREE', 'PE_BRANCH', 'PE_SCOPE', 'PE_OWNER']) delete process.env[key];

/**
 * The PHYSICAL spelling of a path — what `PE_WORKTREE` carries since SCH-1.
 *
 * 🔴 The claim's tree dimension is compared physically on BOTH sides now
 * (phase 3, `realish()` in `treeFor`; `pwd -P` in `phase-lock.sh`), because
 * `/tmp/x` and `/private/tmp/x` are one directory and a string compare carved
 * a session away from itself. macOS's `$TMPDIR` is exactly that symlink, so a
 * fixture's `cwd` and the claim it produces are two spellings of one tree and
 * these assertions have to say which one they mean.
 */
const phys = (dir: string): string => { try { return realpathSync.native(dir); } catch { return dir; } };

const { Runner } = await import('../server/runner/runner.ts');
const { Scheduler } = await import('../server/runner/scheduler.ts');
const { SHARED_CHECKOUT_TOKEN } = await import('../shared/scope.js');
// Dynamic for the same reason as the two above: `runDir` resolves through
// `STATE_DIR`, which config.ts reads at import time from the env set just above.
const { runDir, consoleRunsDir } = await import('../server/runner/state.ts');
const { ensureIntegration, holdsBranch, isRegistered, laneNames, worktreeHome } = await import('../server/runner/worktree.ts');
import type { LockView } from '../server/runner/scheduler.ts';
import type { SpawnFn, SpawnOutcome, SpawnRequest } from '../server/runner/spawn.ts';
// Dynamic, for exactly the reason the four above are: a STATIC import hoists
// over the `XDG_STATE_HOME` assignment at the top of this file, and
// `config.ts` resolves `STATE_DIR` at module load — so the belt in
// `state-sandbox.ts` fires and the suite refuses to run.
const { INSTANCE } = await import('../server/config.ts');
const { configureLog } = await import('../server/log.ts');
const { runTraceId } = await import('../server/trace.ts');

type Repo = { root: string; scripts: string; state: string; cleanup: () => void };

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-gitstrat-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(state, 'done'), '');

  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
S="${state}"
shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    d=""; r=""
    for p in 1 2; do
      if grep -qx "$p" "$S/done" 2>/dev/null; then d="$d$p,"; else r="$r$p,"; fi
    done
    echo "done: \${d%,}"
    echo "ready: \${r%,}"
    echo "waiting:"
    ;;
  --boot-prompt) echo "BOOT phase $arg" ;;
  --gate-status) echo "clear" ;;
  --repos) echo "demo-repo" ;;
  *) echo "" ;;
esac
`);
  write(join(scripts, 'phase-lock.sh'), '#!/usr/bin/env bash\nexit 0\n');
  write(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  write(join(scripts, 'next-phase-prompt.sh'), '#!/usr/bin/env bash\nexit 0\n');
  write(join(scripts, 'new-handoff.sh'), '#!/usr/bin/env bash\nexit 0\n');

  return { root, scripts, state, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

/** `git`, throwing on failure — a broken FIXTURE must not read as a finding. */
function git(cwd: string, ...args: string[]): string {
  return String(execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      LC_ALL: 'C',
      GIT_AUTHOR_NAME: 'p2', GIT_AUTHOR_EMAIL: 'p2@example.invalid',
      GIT_COMMITTER_NAME: 'p2', GIT_COMMITTER_EMAIL: 'p2@example.invalid',
    },
  })).trim();
}

/**
 * Turn a stub repo into a REAL one that worktree lanes can be taken from.
 *
 * `checkAvailable` refuses anything else BY NAME — not a repo, no run branch,
 * has submodules — and every refusal degrades silently to the shared root. A
 * lane test that skipped this would assert against the shared-root path and
 * pass for entirely the wrong reason.
 */
function makeGitRepo(r: Repo): void {
  git(r.root, 'init', '-q', '-b', 'main');
  git(r.root, 'add', '-A');
  git(r.root, 'commit', '-q', '-m', 'base');
}

function outcome(): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-0001', costUsd: 0, turns: 1, resultText: 'done',
    durationMs: 10, argv: ['-p', '<prompt>'],
  };
}

/**
 * Drive the stub plan and hand back every prompt spawned, in phase order.
 * Options ride straight into `Runner.start`; deps are per-test injections.
 */
async function promptsFor(
  r: Repo,
  options: Record<string, unknown>,
  deps: Record<string, unknown> = {},
): Promise<string[]> {
  return (await requestsFor(r, options, deps)).map((request) => request.prompt);
}

/**
 * The same drive, handing back the WHOLE spawn request rather than its prompt.
 *
 * Where the session runs, what it may also write, and what it is told about
 * where its work-state goes are three facts of one decision, and the request is
 * the only place all three are visible together.
 *
 * `onSpawn` is the HARNESS's own hook, not a `RunnerDeps` field: it stands in
 * for what a real session does to the tree it was given — leave a file, commit
 * something — which is the only way to test what the settle does with a tree
 * that is not clean.
 */
async function requestsFor(
  r: Repo,
  options: Record<string, unknown>,
  deps: Record<string, unknown> = {},
  onSpawn?: (request: SpawnRequest) => void,
): Promise<SpawnRequest[]> {
  const { requests } = await driveOn(makeRunner(r, deps, onSpawn), r, options);
  assert.ok(requests.length, 'no phase ever started, so there is no prompt to read');
  return requests;
}

type Driver = { runner: InstanceType<typeof Runner>; requests: SpawnRequest[] };

/**
 * ONE `Runner`, reusable across several `start()` calls.
 *
 * 🔴 The shape production actually has, and the shape `requestsFor` does NOT:
 * `Service.runnerFor(slug)` pools one `Runner` per plan for the console's whole
 * lifetime and never deletes it, so every resume of a plan re-enters `drive()`
 * on the SAME object. A helper that builds a fresh `Runner` per drive resets
 * every per-instance flag by construction — which is how a memoized preamble
 * that skipped its own re-evaluation on resume shipped with a green suite.
 * Any test about a resume must drive one of these twice.
 */
function makeRunner(
  r: Repo,
  deps: Record<string, unknown> = {},
  onSpawn?: (request: SpawnRequest) => void,
): Driver {
  const requests: SpawnRequest[] = [];
  const done = join(r.state, 'done');
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    requests.push(request);
    onSpawn?.(request);
    const phase = /BOOT phase (\d+)/.exec(request.prompt)?.[1];
    if (phase) writeFileSync(done, `${phase}\n`, { flag: 'a' });
    return outcome();
  };
  const runner = new Runner({
    scriptsDir: r.scripts,
    spawn,
    verificationText: () => '`true`',
    ...deps,
  } as never);
  return { runner, requests };
}

async function driveOn(
  driver: Driver, r: Repo, options: Record<string, unknown>,
): Promise<Driver> {
  await driver.runner.start(
    { slug: 'demo', root: r.root, ...options } as Parameters<Driver['runner']['start']>[0],
  );
  await driver.runner.wait();
  return driver;
}

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));

test('a default-branch run composes the prompt it always composed — not one byte more', async () => {
  const r = repo();
  try {
    const prompts = await promptsFor(r, { onlyPhases: [1], skills: ['graph-tool'] });
    assert.doesNotMatch(prompts[0]!, /Git strategy/);
    assert.doesNotMatch(prompts[0]!, /pe\/demo/);
    assert.doesNotMatch(prompts[0]!, /worktree/i);
  } finally { r.cleanup(); }
});

test('a new-branch run states the branch rule between the plan and the directive', async () => {
  const r = repo();
  try {
    const prompts = await promptsFor(r, {
      onlyPhases: [1], gitMode: 'new-branch', skills: ['graph-tool'],
    });
    const text = prompts[0]!;
    assert.match(text, /Git strategy for this run/);
    assert.match(text, /ONE plan-wide branch: `pe\/demo`/);
    assert.match(text, /Never commit to the default branch/);
    // The ordering is the contract: the engine's text first, the strategy
    // before the skill directive, the directive last.
    const boot = text.indexOf('BOOT phase 1');
    const git = text.indexOf('Git strategy');
    const directive = text.indexOf('/graph-tool');
    assert.ok(boot >= 0 && boot < git, 'the plan speaks first');
    assert.ok(git < directive, 'the directive keeps the last word');
    // A scoped run is not the plan finishing, so no PR is asked for.
    assert.doesNotMatch(text, /pull request/i);
    // And nothing about sharing: nobody else is here.
    assert.doesNotMatch(text, /worktree/i);
  } finally { r.cleanup(); }
});

test('the mismatch note appears exactly when the plan names a real branch', async () => {
  const r = repo();
  try {
    const quiet = await promptsFor(r, { onlyPhases: [1], gitMode: 'new-branch' },
      { planBranch: () => 'current branch (no new branch).' });
    assert.doesNotMatch(quiet[0]!, /discrepancy/, 'the default idiom is not a named branch');

    // The first drive marked phase 1 done in the stub; put it back.
    writeFileSync(join(r.state, 'done'), '');
    const named = await promptsFor(r, { onlyPhases: [1], gitMode: 'new-branch' },
      { planBranch: () => 'feature/checkout' });
    assert.match(named[0]!, /names the branch `feature\/checkout`/);
    assert.match(named[0]!, /record the discrepancy in your\s+handoff/);
  } finally { r.cleanup(); }
});

test('a cross-run holder in a shared repository warns and offers the QUEUE — never a worktree', async () => {
  // This arm used to prescribe making a sibling worktree by hand, and that
  // advice was the source of the debris: nothing in the console sweeps a
  // session-made tree or branch, so every session that took it left something
  // permanent behind (five under /private/tmp, plus branches nobody could
  // attribute). What survives is the true half of the warning and an exit that
  // costs nothing — declare the block, name the lock, let admission queue.
  const r = repo();
  try {
    // The real guard-off shape: a foreign lock shares the scope, admission is
    // allowed anyway, and the honesty probe reports the neighbour.
    const locks: LockView[] = [
      { slug: 'other-plan', phase: 3, owner: 'sam@example-host', expired: false, scope: ['all'] },
    ];
    const scheduler = new Scheduler({ locks: () => locks, guard: () => false });
    const prompts = await promptsFor(r, { onlyPhases: [1], gitMode: 'new-branch' }, { scheduler });
    const text = prompts[0]!;
    assert.match(text, /CAUTION — another live session shares a repository/);
    assert.match(text, /other-plan P3 \(sam@example-host\)/);
    assert.match(text, /Do NOT create a worktree either/);
    assert.doesNotMatch(text, /git worktree add \.\.\//,
      'the prescription is gone — a tree a session makes is a tree nothing removes');
    assert.match(text, /phase-outcome\.sh demo <N> blocked/);
    assert.match(text, /--watch lock:demo\/<N>/);
    assert.doesNotMatch(text, /BEFORE editing anything: if `pe\/demo` exists/,
      'the warning bullet replaces the checkout bullet, not joins it');
    scheduler.close();
  } finally { r.cleanup(); }
});

test('the PR block lands on the last phase and only there', async () => {
  const r = repo();
  try {
    const prompts = await promptsFor(r, { gitMode: 'new-branch' },
      { planTitle: () => 'Demo: the whole feature' });
    assert.equal(prompts.length, 2, 'the stub plan has two phases and both ran');
    assert.doesNotMatch(prompts[0]!, /pull request/i, 'phase 1 is not the last — phase 2 is not done');
    assert.match(prompts[1]!, /Opening the pull request — this is the plan's LAST remaining phase/);
    assert.match(prompts[1]!, /git push -u origin pe\/demo/);
    assert.match(prompts[1]!, /title: "Demo: the whole feature"/);
    assert.match(prompts[1]!, /write the exact commands you would\s+have run into the handoff/);
  } finally { r.cleanup(); }
});

test('openPr: false keeps the branch and drops the PR ask', async () => {
  const r = repo();
  try {
    const prompts = await promptsFor(r, { gitMode: 'new-branch', openPr: false });
    assert.match(prompts[1]!, /ONE plan-wide branch/);
    assert.doesNotMatch(prompts[1]!, /pull request/i);
  } finally { r.cleanup(); }
});

test('a scoped run finishing the board\'s last open phase still opens no PR', async () => {
  const r = repo();
  try {
    // Phase 2 is already done; the run is scoped to phase 1. Every OTHER phase
    // is done and this is the sole lane — but the run was never the plan.
    writeFileSync(join(r.state, 'done'), '2\n');
    const prompts = await promptsFor(r, { onlyPhases: [1], gitMode: 'new-branch' });
    assert.doesNotMatch(prompts[0]!, /pull request/i);
  } finally { r.cleanup(); }
});


/* ------------------------------------------------------------------ *
 * The LANE variant (D6 injection + D8's lane half).
 *
 * A lane phase is the one case where every bullet in the base block is
 * not merely unnecessary but WRONG: `pe/demo` is checked out in the
 * run's integration worktree, so "check it out" is impossible and
 * `git worktree add`-ing it is a hard git failure. The session is
 * already where it needs to be; what it does not know, and cannot work
 * out from its cwd, is that its work-state belongs somewhere else.
 * ------------------------------------------------------------------ */

test('a lane phase is told it ALREADY has its tree — never to check out or add one', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const requests = await requestsFor(
      r,
      { onlyPhases: [1], gitMode: 'new-branch' },
      { planWorktrees: () => 'on' },
    );
    const { cwd, prompt } = requests[0]!;

    // It really got a lane — otherwise everything below asserts the
    // shared-root path and passes for the wrong reason.
    assert.notEqual(cwd, r.root, 'no worktree was taken, so this proves nothing');
    assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo-p1');

    assert.match(prompt, /cwd is ALREADY this phase's own worktree/);
    assert.match(prompt, /`pe\/demo-p1`/);
    assert.ok(prompt.includes(cwd), 'the prompt must name the directory it means');

    // The two impossible instructions, neither of which may appear.
    assert.doesNotMatch(prompt, /BEFORE editing anything: if `pe\/demo` exists/);
    assert.doesNotMatch(prompt, /git worktree add \.\.\//);
    assert.doesNotMatch(prompt, /CAUTION — another live session/);
  } finally { r.cleanup(); }
});

test('a lane phase is told where work-state goes, and CAN write there', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const requests = await requestsFor(
      r,
      { onlyPhases: [1], gitMode: 'new-branch' },
      { planWorktrees: () => 'on' },
    );
    const { cwd, prompt, env, addDirs } = requests[0]!;
    assert.notEqual(cwd, r.root, 'no worktree was taken, so this proves nothing');

    // Told (D6): the scripts read `$DOCS_ROOT` before their cwd-upward walk,
    // and in a linked worktree that walk answers the WORKTREE.
    assert.equal(env?.DOCS_ROOT, r.root);
    // …and told in words too, because a session that does not know this reaches
    // for `--root` flags and copies files around.
    assert.match(prompt, /Work-state — the handoff, INDEX, `\.locks\/`, QA rows/);
    assert.ok(prompt.includes(r.root), 'the prompt must name the root it means');

    // ALLOWED (the other half): knowing where the handoff goes is useless if
    // the session may not write there. This fails on `new-handoff.sh`, at the
    // very end of a phase that otherwise succeeded.
    assert.deepEqual(addDirs, [r.root]);
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * D10, wired: the drive preamble sweeps a DEAD run's trees before this
 * run asks for one.
 *
 * `git worktree prune` ignores an intact directory, so a console that
 * was killed left `integration/` registered and checked out on
 * `pe/<slug>` forever — and every later run of that plan met
 * `ensureIntegration`'s refusal and degraded to the shared checkout
 * with nothing but a journal line to say why. `worktree.test.ts` proves
 * the sweep; this proves the runner runs it.
 * ------------------------------------------------------------------ */

test('a dead run\'s wedged integration no longer costs the next run its lanes', async () => {
  const r = repo();
  try {
    makeGitRepo(r);

    // A previous run of this plan, killed. Its integration tree is intact and
    // holds `pe/demo`, which is the one branch the next run's lanes need.
    const dead = laneNames({
      stateDir: runDir(r.root, 'demo'), runId: 'dead-run', slug: 'demo', phase: 1,
    });
    mkdirSync(join(runDir(r.root, 'demo'), 'worktrees', 'dead-run'), { recursive: true });
    git(r.root, 'worktree', 'add', '-q', '-b', 'pe/demo', dead.integration, 'HEAD');

    // Failing-before, executed rather than asserted: as things stood, this is
    // the refusal every subsequent run of the plan received, forever.
    const next = laneNames({
      stateDir: runDir(r.root, 'demo'), runId: 'whatever', slug: 'demo', phase: 1,
    });
    const wedged = await ensureIntegration(r.root, next);
    assert.equal(wedged.ok, false, 'the defect did not reproduce — re-derive it before trusting this');
    assert.match(wedged.detail ?? '', /already checked out at/);

    const requests = await requestsFor(
      r,
      { onlyPhases: [1], gitMode: 'new-branch' },
      { planWorktrees: () => 'on' },
    );
    const { cwd } = requests[0]!;

    assert.notEqual(cwd, r.root, 'the run still degraded to the shared checkout');
    assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo-p1');
    // …and the dead run's directory is gone, not merely stepped around.
    assert.equal(await isRegistered(r.root, dead.integration), false);
  } finally { r.cleanup(); }
});

test('DOCS_ROOT is set for EVERY session, and a shared-root one asks for no extra directory', async () => {
  const r = repo();
  try {
    // No worktrees: the overwhelmingly common run. The environment still says
    // where work-state goes — it is simply the directory the session is in —
    // and argv gains nothing, so the spawn is what it always was.
    const requests = await requestsFor(r, { onlyPhases: [1], gitMode: 'new-branch' });
    const { cwd, env, addDirs, prompt } = requests[0]!;
    assert.equal(cwd, r.root);
    assert.equal(env?.DOCS_ROOT, r.root);
    assert.equal(addDirs, undefined, 'a session already at the root needs no --add-dir');
    // And it is told to check the branch out, exactly as before.
    assert.match(prompt, /BEFORE editing anything: if `pe\/demo` exists/);
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Phase 6 — the RUN checkout.
 *
 * The orthogonal shape to a lane: no phase gets a tree of its own, the
 * whole RUN does, and every session of it — boot, verification,
 * closeout — works in the console's managed checkout of `pe/<slug>`.
 *
 * Every case below drives a REAL Runner over a REAL git repository and
 * then asks git and the run file what happened, because the two facts
 * that matter (where the session ran, what the run recorded) are the
 * two a mocked preamble would assert about itself.
 * ------------------------------------------------------------------ */

/**
 * The NEWEST run file in this plan's state directory.
 *
 * Newest rather than "the only one": a test that drives the plan twice has two,
 * and the earlier version of this helper asserted there was exactly one — which
 * quietly pushed every such test into deleting the state directory between
 * drives. That deletion is not something production does, and it removed the
 * very leftovers one of those tests existed to detect.
 */
function runStateAfter(r: Repo): Record<string, unknown> {
  const dir = runDir(r.root, 'demo');
  const files = readdirSync(dir).filter((f) => /^run-.*\.json$/.test(f));
  assert.ok(files.length, `no run file in ${dir}`);
  const newest = files
    .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0]!.f;
  return JSON.parse(readFileSync(join(dir, newest), 'utf8')) as Record<string, unknown>;
}

/**
 * Wait for the settle's prune to finish.
 *
 * `pruneWorktrees` is fired and NOT awaited by the loop's `finally`, on purpose:
 * that block is not a place to await minutes of git, and a tree left standing is
 * a directory rather than a lost commit. So `runner.wait()` returning says
 * nothing about the tree yet, and a test that asserted straight after it would
 * be asserting on a race — green on a fast machine, red on a loaded one.
 */
async function settled(check: () => Promise<boolean>, what: string): Promise<void> {
  // 20 s, not 5. This is a POLL, so a generous ceiling costs nothing when the
  // condition holds at once — and under the full suite it does not: `npm test`
  // runs files in parallel and the settle's chain of `git worktree remove`
  // calls, each with its own process spawn, was measured taking longer than a
  // 5 s window on a loaded machine. A tight window here is a flake pretending
  // to be a finding, which is the most expensive kind of red on this plan.
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((done) => { setTimeout(done, 50); });
  }
  assert.fail(`timed out waiting for the settle: ${what}`);
}

/**
 * Wait until the settle's prune has finished AND written its result.
 *
 * 🔴 NOT `!isRegistered(root, tree)`, which is what three tests used and what
 * QA round 3 measured as a structural race: `pruneRun` removes the checkout,
 * then runs `git worktree prune` and `rm -rf` (`worktree.ts`), and only when
 * all of that returns does the caller delete `state.workRoot` and persist it
 * (`runner-loop.ts`). The gap measured **[11, 12, 10] ms on an idle machine**,
 * so a test that waits on the registration and then asserts on `workRoot` is
 * asserting inside the window, not after it. One full `npm test` went red there.
 *
 * Widening the poll cannot fix it — the wait was on the wrong EVENT, not on too
 * short a clock. `run.worktrees-pruned` is journalled after the persist, so it
 * is the one signal that means "the run file now says what it will say".
 */
async function pruned(r: Repo): Promise<void> {
  await settled(
    () => Promise.resolve(journalEvents(r, 'run.worktrees-pruned').length > 0),
    'the settle never pruned at all',
  );
}

/** Every journal line of one kind this drive wrote. */
function journalEvents(r: Repo, event: string): Record<string, unknown>[] {
  const dir = runDir(r.root, 'demo');
  const file = readdirSync(dir).find((f) => /^run-.*\.jsonl$/.test(f));
  if (!file) return [];
  return readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === event);
}

/** Every `run.isolation` line this drive journalled. */
function isolationEvents(r: Repo): Record<string, unknown>[] {
  return journalEvents(r, 'run.isolation');
}

/** The options every isolated-run case starts from. */
const ISOLATED_RUN = { onlyPhases: [1], gitMode: 'new-branch', isolation: 'worktree' } as const;

test('EC1 — an isolated run spawns in the managed tree, on the run branch', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const requests = await requestsFor(r, { ...ISOLATED_RUN });
    const { cwd, env, addDirs, prompt } = requests[0]!;

    // It really got one — otherwise every assertion below is about the shared
    // root and passes for entirely the wrong reason.
    assert.notEqual(cwd, r.root, 'no run checkout was taken, so this proves nothing');
    // …and it lives INSIDE the project, under the one folder every console-made
    // tree shares, which the root's own git status never shows.
    assert.ok(cwd.startsWith(join(r.root, '.worktrees', 'runs', 'demo')), `not under the project: ${cwd}`);
    assert.ok(readFileSync(join(r.root, '.git', 'info', 'exclude'), 'utf8').split('\n').includes('/.worktrees/'));
    assert.doesNotMatch(git(r.root, 'status', '--porcelain'), /\.worktrees/, 'the folder must not show in the root status');
    assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo');
    // The console's OWN checkout is untouched — the whole safety story.
    assert.equal(git(r.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');

    // …and the run recorded both facts, together.
    const state = runStateAfter(r);
    assert.equal(state.checkout, 'worktree');
    assert.equal(state.workRoot, cwd);
    assert.equal(state.isolationRefusal, undefined);

    // Work-state still belongs to the run root, and the session may write there.
    assert.equal(env?.DOCS_ROOT, r.root);
    assert.deepEqual(addDirs, [r.root]);

    // EC4: the isolated bullet, and never the DIY CAUTION.
    assert.match(prompt, /cwd IS a console-managed worktree/);
    assert.ok(prompt.includes(cwd), 'the prompt must name the directory it means');
    assert.doesNotMatch(prompt, /CAUTION — another live session/);
    assert.doesNotMatch(prompt, /git worktree add \.\.\//);
    assert.doesNotMatch(prompt, /BEFORE editing anything: if `pe\/demo` exists/);
    // …and not the LANE bullet either: this run has no lane, and telling it it
    // is on `pe/demo-p1` would send its commits to a branch nothing merges.
    assert.doesNotMatch(prompt, /pe\/demo-p1/);

    // One line, saying what it got.
    const events = isolationEvents(r);
    assert.equal(events.length, 1, 'the isolation decision is journalled exactly once');
    assert.equal((events[0]!.data as Record<string, unknown>).checkout, 'worktree');
  } finally { r.cleanup(); }
});

test('P6 — a CLEAN root sitting on the run branch is reclaimed, and the run takes it', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // The wedge itself, and the console is what creates it: the work-branch
    // strategy tells every session to check `pe/demo` out, so the operator's
    // own root ends up holding it — and git allows a branch exactly one tree.
    git(r.root, 'switch', '-q', '-c', 'pe/demo');

    const requests = await requestsFor(r, { ...ISOLATED_RUN });
    const { cwd } = requests[0]!;

    // The run got its own checkout, on the branch, rather than degrading.
    assert.notEqual(cwd, r.root, 'the run degraded instead of reclaiming');
    assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo');
    // …because the root was switched aside. Ask git, not the journal.
    assert.equal(git(r.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    // The branch still exists — a reclaim frees a working tree, never work.
    assert.equal(git(r.root, 'rev-parse', '--verify', 'pe/demo').length, 40);

    const state = runStateAfter(r);
    assert.equal(state.checkout, 'worktree');
    assert.equal(state.isolationRefusal, undefined);

    const reclaimed = journalEvents(r, 'run.isolation-reclaimed');
    assert.equal(reclaimed.length, 1, 'the reclaim is journalled exactly once');
    const data = reclaimed[0]!.data as Record<string, unknown>;
    assert.equal(data.from, 'pe/demo');
    assert.equal(data.to, 'main');
  } finally { r.cleanup(); }
});

test('P6 — a DIRTY root is never moved, and the refusal names the files', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    git(r.root, 'switch', '-q', '-c', 'pe/demo');
    // Untracked, deliberately: `diff` cannot see the file a killed session
    // created and never added, which is exactly the shape this must not lose.
    writeFileSync(join(r.root, 'scratch.txt'), 'a session was here\n');

    await requestsFor(r, { ...ISOLATED_RUN });

    // Untouched. Everything else in this test is about SAYING so.
    assert.equal(git(r.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo');
    assert.ok(existsSync(join(r.root, 'scratch.txt')));

    const state = runStateAfter(r);
    assert.equal(state.checkout, 'refused');
    assert.equal(state.isolationRefusal, 'branch-in-use');
    assert.equal(journalEvents(r, 'run.isolation-reclaimed').length, 0);
    // "Switch that checkout to another branch" is advice an operator cannot
    // act on until they know why the console would not do it for them.
    const refused = journalEvents(r, 'run.isolation');
    assert.match(String((refused[0]!.data as Record<string, unknown>).reason ?? ''), /scratch\.txt/);
  } finally { r.cleanup(); }
});

test('P6 — isolationReclaim: never leaves the tree exactly as it was', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    git(r.root, 'switch', '-q', '-c', 'pe/demo');

    await requestsFor(r, { ...ISOLATED_RUN }, {
      worktreePrefs: () => ({ reclaim: 'never' }),
    });

    assert.equal(git(r.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo');
    assert.equal(journalEvents(r, 'run.isolation-reclaimed').length, 0);
    assert.equal(runStateAfter(r).isolationRefusal, 'branch-in-use');
  } finally { r.cleanup(); }
});

test('P6 — a plan that says `Checkout: main` boards DETACHED, and its lock says so', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const requests = await requestsFor(r, { ...ISOLATED_RUN }, {
      // What the Service answers off the parsed plan. Asked as ONE question
      // over the run's phases: `ensureRunCheckout` decides one tree per drive.
      detachRequested: () => true,
    });
    const { cwd, env } = requests[0]!;

    assert.notEqual(cwd, r.root, 'no run checkout was taken, so this proves nothing');
    // The whole point: it owns NO ref, so it cannot collide with whoever holds
    // the branch — including the next run of the same plan.
    assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
    assert.equal(git(cwd, 'rev-parse', 'HEAD'), git(r.root, 'rev-parse', 'main'));

    const head = git(r.root, 'rev-parse', 'main');
    // The lock's qualification — a string that differs exactly when the trees
    // do, which is why `claimsDisjoint` needed no new rule for it.
    assert.equal(env?.PE_BRANCH, `detached@${head.slice(0, 12)}`);

    const detached = journalEvents(r, 'run.isolation-detached');
    assert.equal(detached.length, 1, 'the detach decision is journalled exactly once');
    assert.equal((detached[0]!.data as Record<string, unknown>).at, head);

    // …and the boot prompt says what the session is actually standing on. The
    // run arm's "already on `pe/demo` … Commit only to `pe/demo`" would be an
    // impossible order here: the tree owns no branch, and `pe/demo` may not
    // exist at all.
    const prompt = requests[0]!.prompt;
    assert.match(prompt, /DETACHED at\n  `detached@/, 'the cwd bullet names the detached state');
    assert.match(prompt, /no branch to commit to/, 'the commit rule matches the cwd bullet');
    assert.doesNotMatch(prompt, /already on\n  `pe\/demo`/, 'the branch-tree bullet is the wrong story');
    assert.doesNotMatch(prompt, /Commit only to `pe\/demo`/, 'no impossible order');

    const strategy = journalEvents(r, 'phase.git-strategy');
    assert.equal((strategy.at(-1)!.data as Record<string, unknown>).checkout, 'detached',
      'the journal can answer "was this phase told it had a detached tree?"');
  } finally { r.cleanup(); }
});

test('P6 — a run whose branch has not been created yet does NOT detach', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // The defect this guards: a brand-new run's `pe/demo` is absent too — it is
    // minted by `worktree add -b` seconds later — so "the branch is gone" is
    // indistinguishable from "the branch is not here yet" without `settledAt`.
    // Every first drive detached before this, and the whole P8 suite went red.
    const requests = await requestsFor(r, { ...ISOLATED_RUN });
    assert.equal(git(requests[0]!.cwd!, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo');
    assert.equal(journalEvents(r, 'run.isolation-detached').length, 0);
    assert.equal(runStateAfter(r).detachAt, undefined);
  } finally { r.cleanup(); }
});

test('P6 — a refusal after the detach decision clears detachAt with the tree', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // The phase-1 "session" takes a branch in the detached tree and leaves
    // work-in-progress. The dirt is what makes the settle's prune KEEP the
    // tree (a clean one is removed the moment the run finishes), and the
    // branch is what makes the resume's probe say the run no longer holds a
    // DETACHED tree — so the re-ensure runs, meets a tree standing on a
    // branch, and refuses.
    let seeded = false;
    const driver = makeRunner(r, { detachRequested: () => true }, (request) => {
      if (seeded) return;
      seeded = true;
      git(request.cwd!, 'switch', '-q', '-c', 'wip');
      writeFileSync(join(request.cwd!, 'work-in-progress.txt'), 'not yet committed\n');
    });
    await driveOn(driver, r, { ...ISOLATED_RUN });
    await pruned(r);

    const tree = driver.requests[0]!.cwd!;
    assert.notEqual(tree, r.root, 'drive 1 never took a detached tree, so this proves nothing');
    assert.ok(existsSync(join(tree, 'work-in-progress.txt')), 'the prune removed the dirty tree');

    const before = driver.requests.length;
    await driveOn(driver, r, { resumeRunId: String(runStateAfter(r).id), onlyPhases: [2] });
    const resumed = driver.requests[before]!;

    // The refusal must take the detach decision with it, or the degraded run
    // writes PE_BRANCH=detached@<sha> and a lock qualified by a commit its
    // session is not standing at.
    assert.equal(resumed.cwd, r.root, 'the refusal degrades the resumed phase to the shared root');
    assert.equal(resumed.env?.PE_BRANCH, 'pe/demo',
      'PE_BRANCH names the run branch again — never a commit the session is not standing at');

    const state = runStateAfter(r);
    assert.equal(state.checkout, 'refused');
    assert.equal(state.detachAt, undefined, 'the detach decision goes with the tree');

    const refused = isolationEvents(r)
      .find((entry) => (entry.data as Record<string, unknown>).checkout === 'refused');
    assert.ok(refused, 'the refusal is on the record');
    assert.match(String((refused!.data as Record<string, unknown>).reason ?? ''),
      /standing on .*wip/, 'the refusal names the branch that is in the way');
  } finally { r.cleanup(); }
});

test('P6 — turning isolation OFF clears detachAt too, the second door out', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const driver = makeRunner(r, { detachRequested: () => true });
    await driveOn(driver, r, { ...ISOLATED_RUN });
    assert.ok(runStateAfter(r).detachAt, 'drive 1 never detached, so this proves nothing');

    // The operator turns isolation off between drives. The not-opted-in arm is
    // the SECOND door out of the worktree shape — it deletes the tree pointer,
    // and it must delete the detach decision with it, or `branchFor` writes
    // `PE_BRANCH=detached@<sha>` for a session working in the shared root.
    const before = driver.requests.length;
    await driveOn(driver, r, {
      resumeRunId: String(runStateAfter(r).id), onlyPhases: [2], isolation: 'queue',
    });
    const resumed = driver.requests[before]!;

    assert.equal(resumed.cwd, r.root, 'the drop degrades the resumed phase to the shared root');
    assert.ok(!String(resumed.env?.PE_BRANCH ?? '').startsWith('detached@'),
      'a shared-root session must never claim a commit it is not standing at');

    const state = runStateAfter(r);
    assert.equal(state.checkout, 'shared');
    assert.equal(state.detachAt, undefined, 'the detach decision goes with the shape');
  } finally { r.cleanup(); }
});

test('P6 — the drive sweep reads EVERY plan managed dir, not this run own', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // A sibling plan's lane under the console's own runs dir. `managed` is what
    // "the console did not make this" is decided against, so a sweep scoped to
    // THIS plan's dir would report a tree the console minted itself — on every
    // drive, precisely in the two-plans-on-one-repo case this phase is about.
    const otherLane = join(consoleRunsDir(r.root), 'other-plan', 'worktrees', 'r1', 'p3');
    mkdirSync(join(consoleRunsDir(r.root), 'other-plan', 'worktrees', 'r1'), { recursive: true });
    git(r.root, 'worktree', 'add', '-q', '-b', 'pe/other-plan-p3', otherLane, 'main');

    await requestsFor(r, { ...ISOLATED_RUN });
    assert.equal(journalEvents(r, 'run.worktrees-unmanaged').length, 0,
      'a sibling plan lane under the console runs dir is managed, never hand-made');
  } finally { r.cleanup(); }
});

test('P6 — an unmanaged tree is journalled once per decision, not once per drive', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // A genuinely hand-made tree on a pe/* branch, outside every managed dir.
    const byHand = join(r.state, 'by-hand');
    git(r.root, 'worktree', 'add', '-q', '-b', 'pe/by-hand', byHand, 'main');

    // TWO drives of ONE runner — a start and a resume — because one start is
    // one preamble pass however many phases it boards, and the once-per-
    // decision rule only means anything on the second pass.
    const driver = makeRunner(r);
    await driveOn(driver, r, { ...ISOLATED_RUN });
    await driveOn(driver, r, { resumeRunId: String(runStateAfter(r).id), onlyPhases: [2] });

    const noted = journalEvents(r, 'run.worktrees-unmanaged');
    assert.equal(noted.length, 1,
      'once per DECISION: the set of hand-made trees did not change between the two drives');
    assert.match(JSON.stringify(noted[0]!.data), /by-hand/,
      'the one line names the tree an operator would go looking for');
  } finally { r.cleanup(); }
});

test('EC1 — verification and the closeout run in the managed tree too', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // `pwd` is the one verification command whose OUTPUT answers the question:
    // a suite run against the shared root while the phase's commits are on
    // `pe/demo` in the managed tree is a green that means nothing.
    const requests = await requestsFor(r, { ...ISOLATED_RUN }, {
      verificationText: () => '`pwd`',
    });
    const { cwd } = requests[0]!;
    assert.notEqual(cwd, r.root, 'no run checkout was taken, so this proves nothing');

    // Every session this run spawned — the phase, and whatever followed it —
    // is in the tree. A closeout run at the shared root writes its handoff
    // against a checkout that does not hold the phase's commits.
    for (const request of requests) {
      assert.equal(request.cwd, cwd, 'a session of this run ran outside the managed tree');
    }

    const state = runStateAfter(r);
    const phase = (state.phases as Record<string, Record<string, unknown>>)['1']!;
    // `verifiedIn` is stored RELATIVE to the lane root, so "." is the claim
    // that the run's own tree is what it was measured against…
    assert.equal(phase.verifiedIn, '.');
    // …and `pwd`'s own output is the proof of it, which is a different fact:
    // the first is what the runner believes, the second is where the shell was.
    const verification = phase.verification as { ran?: { output?: string }[] } | undefined;
    const printed = (verification?.ran ?? []).map((run) => String(run.output ?? '')).join('\n');
    assert.ok(printed.includes(realpathSync(cwd!)) || printed.includes(cwd!),
      `verification ran somewhere else:\n${printed}`);
  } finally { r.cleanup(); }
});

/* Each refusal row: degrades to shared, names its reason, journals once. */

test('EC2 — cap-reached: the console already holds as many trees as it may', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const requests = await requestsFor(r, { ...ISOLATED_RUN }, {
      worktreePrefs: () => ({ maxConcurrent: 2 }),
      isolatedCheckouts: () => 2,
    });
    assert.equal(requests[0]!.cwd, r.root, 'the run took a tree it was not allowed');
    assert.equal(requests[0]!.addDirs, undefined, 'a shared-root session needs no --add-dir');

    const state = runStateAfter(r);
    assert.equal(state.checkout, 'refused');
    assert.equal(state.isolationRefusal, 'cap-reached');
    assert.equal(state.workRoot, undefined, 'a refused run must never claim a tree');

    const events = isolationEvents(r);
    assert.equal(events.length, 1);
    const data = events[0]!.data as Record<string, unknown>;
    assert.equal(data.refusal, 'cap-reached');
    assert.match(String(data.reason), /worktreeMaxConcurrent/);

    // And the prompt is the ordinary shared one, in every particular.
    assert.match(requests[0]!.prompt, /BEFORE editing anything: if `pe\/demo` exists/);
    assert.doesNotMatch(requests[0]!.prompt, /cwd IS a console-managed worktree/);
  } finally { r.cleanup(); }
});

test('EC2 — scope-outside-root: a plan whose work is not in this repository', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // The hub shape: a run rooted at one repository, phases declaring another.
    // A checkout of the root would not contain the work, so the run keeps
    // queueing — which is exactly what it did before isolation existed.
    const requests = await requestsFor(r, { ...ISOLATED_RUN }, {
      planScope: () => ['all', 'phased-execution'],
    });
    assert.equal(requests[0]!.cwd, r.root);

    const state = runStateAfter(r);
    assert.equal(state.checkout, 'refused');
    assert.equal(state.isolationRefusal, 'scope-outside-root');
    assert.equal(state.workRoot, undefined);
    assert.equal(isolationEvents(r).length, 1);
  } finally { r.cleanup(); }
});

test('EC2 — branch-in-use: somebody else has `pe/demo` checked out', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // Deliberately OUTSIDE the state directory, so the drive preamble's sweep
    // has no business with it: this is the operator's own second checkout, the
    // case `ensureIntegration` refuses in words rather than in git-speak.
    const held = join(r.root, '..', `held-${Date.now()}`);
    git(r.root, 'worktree', 'add', '-q', '-b', 'pe/demo', held, 'HEAD');
    try {
      const requests = await requestsFor(r, { ...ISOLATED_RUN });
      assert.equal(requests[0]!.cwd, r.root);

      const state = runStateAfter(r);
      assert.equal(state.checkout, 'refused');
      assert.equal(state.isolationRefusal, 'branch-in-use');
      assert.equal(state.workRoot, undefined);
      // 🔴 The PATH, not the phrase. This asserted `/already checked out/`
      // against `reason` — a substring `REFUSAL_REASON['branch-in-use']`
      // contains verbatim — so it stayed green when the parameterised
      // `refuse()` dropped git's own words and left only the generic sentence.
      // The one fact an operator needs is WHICH tree holds the branch, and
      // since F5-1 that holder is often the console's own orphan.
      const line = isolationEvents(r)[0]!.data as Record<string, unknown>;
      assert.ok(String(line.detail ?? '').includes(held),
        `the refusal does not name the tree holding the branch: ${JSON.stringify(line)}`);
      assert.match(String(line.detail), /already checked out/);
    } finally { rmSync(held, { recursive: true, force: true }); }
  } finally { r.cleanup(); }
});

test('EC2 — setup-failed: the tree is REMOVED, not left half-prepared', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const names = laneNames({
      stateDir: runDir(r.root, 'demo'), runId: 'unknown', slug: 'demo', phase: 0,
    });
    const requests = await requestsFor(r, { ...ISOLATED_RUN }, {
      worktreePrefs: () => ({ setup: 'echo "no build here" >&2; exit 7' }),
    });
    assert.equal(requests[0]!.cwd, r.root);

    const state = runStateAfter(r);
    assert.equal(state.checkout, 'refused');
    assert.equal(state.isolationRefusal, 'setup-failed');
    assert.equal(state.workRoot, undefined);

    // The tree really is gone. Leaving it would make the NEXT drive find it
    // registered and skip the setup entirely — a checkout whose `npm ci` never
    // ran, that nothing would ever try to prepare again.
    const dir = join(runDir(r.root, 'demo'), 'worktrees');
    assert.equal(existsSync(join(dir, String(state.id), 'integration')), false);
    assert.equal(await isRegistered(r.root, names.integration), false);

    // The operator gets the command's own words, not a category.
    const setup = readFileSync(
      join(runDir(r.root, 'demo'), readdirSync(runDir(r.root, 'demo')).find((f) => f.endsWith('.jsonl'))!),
      'utf8',
    );
    assert.match(setup, /run\.worktree-setup/);
    assert.match(setup, /no build here/);
  } finally { r.cleanup(); }
});

test('EC2 — not-a-repo and has-submodules both degrade, and both say so', async () => {
  const bare = repo();
  try {
    // No `makeGitRepo`: there is nothing to make a worktree of.
    const requests = await requestsFor(bare, { ...ISOLATED_RUN });
    assert.equal(requests[0]!.cwd, bare.root);
    const state = runStateAfter(bare);
    assert.equal(state.checkout, 'refused');
    assert.equal(state.isolationRefusal, 'not-a-repo');
  } finally { bare.cleanup(); }

  const sub = repo();
  try {
    makeGitRepo(sub);
    // A superproject no longer refuses OUTRIGHT — it takes a MIRROR of the
    // repositories the plan's scope names. This plan names none (and the one
    // declared submodule is not initialized), so there is nothing to mount,
    // and THAT is the refusal: scope-unmapped, with the detail naming why.
    writeFileSync(join(sub.root, '.gitmodules'), '[submodule "x"]\n\tpath = x\n\turl = ./x\n');
    const requests = await requestsFor(sub, { ...ISOLATED_RUN });
    assert.equal(requests[0]!.cwd, sub.root);
    const state = runStateAfter(sub);
    assert.equal(state.checkout, 'refused');
    assert.equal(state.isolationRefusal, 'scope-unmapped');
    assert.match(String((isolationEvents(sub)[0]!.data as Record<string, unknown>).reason),
      /resolves to a repository under the run root/);
  } finally { sub.cleanup(); }
});

test('EC2 — a default-branch run never asks, so it never refuses', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // `newRun` refuses to STORE isolation without a branch (P5): a run with no
    // branch has nothing to check out, and a stored request it can never honour
    // is the "reads as configured, does nothing" shape this codebase keeps
    // refusing. So the run does not reach `no-run-branch` — it reaches
    // `not-opted-in`, which is silence, and that is the honest answer.
    const requests = await requestsFor(r, { onlyPhases: [1], isolation: 'worktree' });
    assert.equal(requests[0]!.cwd, r.root);
    const state = runStateAfter(r);
    assert.equal(state.isolation, undefined, 'a branchless run must not store an isolation request');
    assert.equal(state.checkout, 'shared');
    assert.equal(state.isolationRefusal, undefined);
    assert.deepEqual(isolationEvents(r), [], 'nobody asked, so there is nothing to report');
  } finally { r.cleanup(); }
});

test('a queue run is byte-identical to what it was: `shared`, no tree, no line', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const requests = await requestsFor(r, { onlyPhases: [1], gitMode: 'new-branch' });
    assert.equal(requests[0]!.cwd, r.root);
    assert.equal(requests[0]!.addDirs, undefined);
    const state = runStateAfter(r);
    assert.equal(state.checkout, 'shared');
    assert.equal(state.workRoot, undefined);
    assert.deepEqual(isolationEvents(r), []);
    assert.equal(existsSync(join(runDir(r.root, 'demo'), 'worktrees')), false);
  } finally { r.cleanup(); }
});

test('EC3 — a clean settle removes the tree; a second run then starts cleanly', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const first = await requestsFor(r, { ...ISOLATED_RUN });
    const tree = first[0]!.cwd;
    assert.notEqual(tree, r.root, 'no run checkout was taken, so this proves nothing');

    // Settled and clean: the tree is gone, the branch is not.
    await pruned(r);
    assert.equal(existsSync(tree!), false);
    assert.equal(git(r.root, 'rev-parse', '--verify', '--quiet', 'pe/demo^{commit}').length > 0, true,
      'the branch must survive the tree — it is where the commits are');

    // `workRoot` goes with the directory; `checkout` records what the run got.
    const state = runStateAfter(r);
    assert.equal(state.workRoot, undefined, 'workRoot points at a tree that no longer exists');
    assert.equal(state.checkout, 'worktree', 'what the run GOT does not stop being true');

    // And the next run of the plan gets its own, rather than meeting a wedge.
    writeFileSync(join(r.state, 'done'), '');
    rmSync(runDir(r.root, 'demo'), { recursive: true, force: true });
    const second = await requestsFor(r, { ...ISOLATED_RUN });
    assert.notEqual(second[0]!.cwd, r.root, 'the second run degraded — the first one wedged it');
    assert.equal(git(second[0]!.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo');
  } finally { r.cleanup(); }
});

test('EC3 — a DIRTY run tree is kept, and the run says where it is', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // The session leaves a file it never committed — what a killed session
    // leaves, and the one thing `worktree remove --force` would delete without
    // asking with nothing anywhere else holding it.
    const requests = await requestsFor(r, { ...ISOLATED_RUN }, {}, (request) => {
      writeFileSync(join(request.cwd!, 'unsaved.txt'), 'never committed\n');
    });
    const tree = requests[0]!.cwd;
    assert.notEqual(tree, r.root, 'no run checkout was taken, so this proves nothing');

    // Wait for the prune to have RUN before asserting it kept the tree —
    // otherwise this passes because nothing has happened yet, which is the
    // wrong reason and would hide a prune that deletes dirty trees.
    await pruned(r);
    assert.equal(existsSync(join(tree!, 'unsaved.txt')), true, 'the work was deleted');
    assert.equal(await isRegistered(r.root, tree!), true, 'a dirty tree must be KEPT');
    const state = runStateAfter(r);
    assert.equal(state.workRoot, tree, 'the run must still point at the tree it kept');
    assert.equal(state.checkout, 'worktree');
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The carve-out P7 shipped the field for and could not reach.
 *
 * P7 gated the lock's `branch=` line on `lane.branch`, which is set only
 * for a worktree LANE. A run-level isolated run has no lane and no
 * `lane.branch`, so it wrote an UNQUALIFIED lock — colliding with every
 * other claim on the repository — and got no carve-out at all: the
 * field shipped, the rule shipped, and the one run shape they exist for
 * was not covered. Both readers now go through `RunnerBase`.
 * ------------------------------------------------------------------ */

test('an isolated run tells its session the branch its lock must name', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const requests = await requestsFor(r, { ...ISOLATED_RUN });
    const { cwd, env } = requests[0]!;
    assert.notEqual(cwd, r.root, 'no run checkout was taken, so this proves nothing');

    // BOTH dimensions are ACTED ON — `phase-lock.sh conflicts` reads two
    // claims on one repository as disjoint only when both name a branch AND a
    // tree and both differ.
    assert.equal(env?.PE_BRANCH, 'pe/demo');
    assert.equal(env?.PE_WORKTREE, phys(cwd));
    // …and the SCOPE is untouched. Isolation carves by the branch+tree pair
    // and only by it: a run that narrowed its scope because it had a tree
    // would claim two sessions cannot collide when they plainly can. `all` is
    // what this harness's `scopeFor` answers with no `phaseScope` injected,
    // isolated or not; the assertion is that isolation did not touch it.
    assert.equal(env?.PE_SCOPE, 'all');
  } finally { r.cleanup(); }
});

test('a shared-checkout run writes a QUALIFIED lock — its branch, plus the shared tree', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // The claim now says what the session actually does: it commits on
    // `pe/demo` (the boot prompt's own instruction) IN THE SHARED ROOT. Safety
    // used to be withholding the branch; it now rides the tree — every shared
    // run names the SAME tree, so two of them collide exactly as before, while
    // an isolated run's own tree is what carves it out past this one.
    const requests = await requestsFor(r, { onlyPhases: [1], gitMode: 'new-branch' });
    assert.equal(requests[0]!.cwd, r.root);
    assert.equal(requests[0]!.env?.PE_BRANCH, 'pe/demo');
    assert.equal(requests[0]!.env?.PE_WORKTREE, phys(r.root),
      'the shared root IS the tree this session edits, and the claim says so');
  } finally { r.cleanup(); }
});

test('a REFUSED run claims the shared tree — qualified, and colliding exactly as it should', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // The subtle one. The run ASKED for isolation and did not get it, so it is
    // in the shared checkout, committing on `pe/demo` there. Its claim says
    // both facts — and the TREE is what keeps it honest: naming the shared
    // root, it collides with every other claim on that root, so the refusal
    // grants it nothing an unqualified claim would not have. What it gains is
    // truthful narrowing the other way: an ISOLATED neighbour in its own tree
    // can now be admitted past this run instead of behind it.
    const requests = await requestsFor(r, { ...ISOLATED_RUN }, { isolatedCheckouts: () => 99 });
    assert.equal(requests[0]!.cwd, r.root);
    assert.equal(runStateAfter(r).checkout, 'refused');
    assert.equal(requests[0]!.env?.PE_BRANCH, 'pe/demo');
    assert.equal(requests[0]!.env?.PE_WORKTREE, phys(r.root),
      'refused means the shared tree, and the claim names it');
  } finally { r.cleanup(); }
});

test('the lease refresh names the same branch the session was given', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // The defect to fear is not a wrong verdict but the field FALLING OFF a
    // keepalive: the run keeps working while admission quietly re-serialises a
    // third of a lease in. So the refresh's own argv is the thing to read.
    const log = join(r.state, 'lock-argv');
    write(join(r.scripts, 'phase-lock.sh'), `#!/usr/bin/env bash\necho "$@" >> "${log}"\nexit 0\n`);

    await requestsFor(r, { ...ISOLATED_RUN }, { leaseRefreshMs: 10 });
    const lines = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    const refreshes = lines.filter((line) => / claim /.test(line));
    assert.ok(refreshes.length, `no claim was ever made:\n${lines.join('\n')}`);
    for (const line of refreshes) {
      assert.match(line, /--branch pe\/demo(\s|$)/, `a claim lost its branch:\n${line}`);
      assert.match(line, /--worktree \S+integration(\s|$)/, `a claim lost its worktree:\n${line}`);
    }
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The third `isolation` reader — P5's own deferral.
 *
 * `newRun`/`applySettings` and the two API doors were covered and
 * red-proved in P5; `Runner.start`'s resume branch was not, for want of
 * a two-start harness. It is exactly the shape that defeated P1 — a
 * predicate with two readers narrowed in one place — and this is the
 * phase where a wrong answer puts a half-finished run in a checkout its
 * earlier phases never used.
 * ------------------------------------------------------------------ */

test('isolation is STICKY across a resume that does not mention it', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // ONE Runner, driven twice — this file's own rule for any test about a
    // resume, and it was the one resume test not following it. It is not a
    // detail: `Service.runnerFor` pools one Runner per plan for the console's
    // lifetime, and the end-of-loop worktree sweep is held on THAT instance for
    // the next drive to wait on (`prunePending`). A fresh Runner per drive has
    // nothing to wait on, so the resume raced the sweep and boarded into a
    // directory being deleted — which is what CI's macOS leg kept catching.
    let branchDuring = '';
    let branchError = '';
    const driver = makeRunner(r, {}, (request) => {
      if (!request.cwd) return;
      // CAUGHT, not thrown: this runs inside the stub spawn, so an exception
      // here is swallowed as a failed session and the assertion below reads a
      // bare '' with nothing to say why.
      try { branchDuring = git(request.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'); }
      catch (error) { branchError = String((error as Error)?.message ?? error); }
    });

    // Phase 1 only, so the run settles with phase 2 still open to resume into.
    await driveOn(driver, r, { ...ISOLATED_RUN });
    const tree = driver.requests[0]!.cwd;
    assert.notEqual(tree, r.root, 'no run checkout was taken, so this proves nothing');
    assert.ok(tree, 'the first phase was spawned with no checkout at all');
    const runId = String(runStateAfter(r).id);

    // Resume, saying nothing about isolation — which is what every resume
    // does. The run must keep it: the alternative is a run whose phase 1 is
    // committed in a worktree and whose phase 2 starts in the shared root.
    const before = driver.requests.length;
    branchDuring = '';
    await driveOn(driver, r, { resumeRunId: runId, onlyPhases: [2] });
    const resumed = driver.requests[before];
    assert.ok(resumed, 'the resume never spawned phase 2');
    assert.equal(branchError, '',
      'the resumed phase was spawned into a tree git could not read — the previous drive\'s '
      + 'worktree sweep is still removing it, and `ensureRunCheckout` is meant to wait for that');
    assert.equal(runStateAfter(r).isolation, 'worktree', 'the resume dropped the request');
    assert.equal(runStateAfter(r).checkout, 'worktree', 'the resume dropped the checkout');
    assert.ok(resumed.cwd, 'the resumed phase was spawned with no checkout at all');
    assert.notEqual(resumed.cwd, r.root, 'the resumed phase ran in the shared root');
    // Read DURING the spawn: a clean settle sweeps the tree at run end (EC3),
    // so asking git afterwards is a race against the removal.
    assert.equal(branchDuring, 'pe/demo');
  } finally { r.cleanup(); }
});

test('a resume that DROPS isolation moves the run back to the shared checkout', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    await requestsFor(r, { ...ISOLATED_RUN });
    const runId = String(runStateAfter(r).id);

    // One way, and only down (`RunSettingsPatch.isolation`). Dropping is safe
    // at any moment; raising would have to move a run that already has commits
    // on a branch, in a checkout its live sessions sit in.
    const second = await requestsFor(r, {
      resumeRunId: runId, onlyPhases: [2], isolation: 'queue',
    });
    assert.equal(runStateAfter(r).isolation, undefined, 'the drop did not land');
    assert.equal(second.at(-1)!.cwd, r.root);
  } finally { r.cleanup(); }
});

test('an isolated run SUPPRESSES the DIY-worktree CAUTION a neighbour would trigger', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // 🔴 Written this way because the obvious version proves nothing. `EC1`
    // asserts the CAUTION is absent, and it is absent there because NOBODY IS
    // THERE — no foreign lock, no overlap, no escalation to suppress. Deleting
    // the suppression left that assertion green. The neighbour has to exist.
    const locks: LockView[] = [
      { slug: 'other-plan', phase: 3, owner: 'sam@example-host', expired: false, scope: ['all'] },
    ];
    const scheduler = new Scheduler({ locks: () => locks, guard: () => false });

    // Failing-before, executed rather than asserted: the same neighbour, on a
    // SHARED run, really does produce the CAUTION.
    const shared = await promptsFor(r, { onlyPhases: [1], gitMode: 'new-branch' }, { scheduler });
    assert.match(shared[0]!, /CAUTION — another live session shares a repository/,
      'the escalation did not fire at all — this test cannot prove a suppression');

    writeFileSync(join(r.state, 'done'), '');
    const requests = await requestsFor(r, { ...ISOLATED_RUN }, { scheduler });
    const { cwd, prompt } = requests[0]!;
    assert.notEqual(cwd, r.root, 'no run checkout was taken, so this proves nothing');

    // Same neighbour, isolated run: the advice is not merely unnecessary but
    // WRONG. `git worktree add ../<repo>-pe-demo pe/demo` is a hard git failure
    // when `pe/demo` is already checked out — which it is, in this very cwd.
    assert.doesNotMatch(prompt, /CAUTION — another live session/);
    assert.doesNotMatch(prompt, /git worktree add \.\.\//);
    assert.match(prompt, /cwd IS a console-managed worktree/);
    scheduler.close();
  } finally { r.cleanup(); }
});

test('an isolated run does not journal `phase.shared-checkout` — it is not in one', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // The `overlaps` guard's own job, which is NOT the suppression above: the
    // bullet is chosen by the ternary's order, and this guard decides whether
    // the honesty probe is asked at all. Without it an isolated phase records
    // `phase.shared-checkout` naming a neighbour it cannot possibly collide
    // with — a journal line that would send an operator hunting a conflict
    // between two sessions in two different directories.
    const locks: LockView[] = [
      { slug: 'other-plan', phase: 3, owner: 'sam@example-host', expired: false, scope: ['all'] },
    ];
    const scheduler = new Scheduler({ locks: () => locks, guard: () => false });

    // Failing-before: the same neighbour on a shared run really does record it.
    await requestsFor(r, { onlyPhases: [1], gitMode: 'new-branch' }, { scheduler });
    assert.ok(journalEvents(r, 'phase.shared-checkout').length,
      'the probe never fired at all — this test cannot prove it was held off');

    writeFileSync(join(r.state, 'done'), '');
    rmSync(runDir(r.root, 'demo'), { recursive: true, force: true });
    const requests = await requestsFor(r, { ...ISOLATED_RUN }, { scheduler });
    assert.notEqual(requests[0]!.cwd, r.root, 'no run checkout was taken, so this proves nothing');
    assert.deepEqual(journalEvents(r, 'phase.shared-checkout'), []);
    // …and the strategy line says which bullet the session actually got, which
    // is the first question of every isolation bug report.
    const strategy = journalEvents(r, 'phase.git-strategy').at(-1)!;
    assert.equal((strategy.data as Record<string, unknown>).checkout, 'run');
    scheduler.close();
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * QA round 1, F-1 and F-2. Both were demonstrated end-to-end against a
 * green suite, and both are the same lesson from different angles: the
 * TEST HARNESS was kinder than production.
 *
 * `requestsFor` builds a fresh `Runner` per drive; `Service.runnerFor`
 * pools ONE per plan for the console's lifetime. Every test below
 * therefore drives a single `makeRunner()` twice.
 * ------------------------------------------------------------------ */

test('F-1 — a resumed run does not claim a carve-out whose tree the settle removed', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // ONE Runner, driven twice — the whole point. With a fresh Runner per drive
    // the preamble re-runs by accident and this passes for the wrong reason.
    const driver = makeRunner(r);
    await driveOn(driver, r, { ...ISOLATED_RUN });
    const tree = driver.requests[0]!.cwd!;
    assert.notEqual(tree, r.root, 'no run checkout was taken, so this proves nothing');
    await pruned(r);

    // The settle removed the tree and cleared `workRoot`; `checkout` stays
    // `worktree` on purpose, as the history of what the run got. A plain
    // Continue — no settings change at all — must NOT read that word as
    // "there is a tree", because there is not one.
    const before = driver.requests.length;
    await driveOn(driver, r, { resumeRunId: String(runStateAfter(r).id), onlyPhases: [2] });
    const resumed = driver.requests[before]!;

    if (resumed.cwd === r.root) {
      // It degraded to the shared root, so it must claim NOTHING: a lock
      // qualified by `pe/demo` here is a carve-out the run does not have, and
      // phase 8 admits on exactly that.
      assert.equal(resumed.env?.PE_BRANCH, undefined,
        'the resumed session claimed pe/demo while working in the SHARED tree');
      assert.equal(resumed.env?.PE_WORKTREE, undefined);
    } else {
      // Or it re-made the tree, which is the other honest answer — and then the
      // claim is true and the run's own record must agree with it.
      assert.equal(git(resumed.cwd!, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo');
      assert.equal(resumed.env?.PE_BRANCH, 'pe/demo');
      assert.equal(runStateAfter(r).workRoot, resumed.cwd);
    }
    // Either way, the invariant: the claim and the directory agree.
    assert.equal(
      resumed.env?.PE_BRANCH === undefined, resumed.cwd === r.root,
      'the lock claim and the working directory disagree',
    );
  } finally { r.cleanup(); }
});

test('F-1 — a resume that DROPS isolation really moves, on a pooled Runner', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const driver = makeRunner(r);
    await driveOn(driver, r, { ...ISOLATED_RUN });
    assert.notEqual(driver.requests[0]!.cwd, r.root, 'no tree was taken, so this proves nothing');

    // Isolation is one-way DOWN, and the lever has to work on the object the
    // console actually holds. Memoized, the preamble skipped re-deciding and
    // the setting was inert: `state.isolation` cleared, everything else stood.
    const before = driver.requests.length;
    await driveOn(driver, r, {
      resumeRunId: String(runStateAfter(r).id), onlyPhases: [2], isolation: 'queue',
    });
    const resumed = driver.requests[before]!;
    const state = runStateAfter(r);
    assert.equal(state.isolation, undefined, 'the drop did not land');
    assert.equal(state.workRoot, undefined, 'the run still points at a tree it gave up');
    assert.equal(state.checkout, 'shared');
    assert.equal(resumed.cwd, r.root, 'the resumed session stayed in the worktree');
    // Still a new-branch run: it commits on `pe/demo` — now in the shared
    // root, and the claim says BOTH facts. The tree is what changed hands.
    assert.equal(resumed.env?.PE_BRANCH, 'pe/demo');
    assert.equal(resumed.env?.PE_WORKTREE, phys(r.root));
  } finally { r.cleanup(); }
});

test('F-1 — a second drive does NOT re-run the setup command', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const marker = join(r.state, 'setup-runs');
    // The setup leaves an untracked file IN the tree, which is what makes the
    // tree DIRTY and therefore survive the settle — and surviving is the whole
    // premise. A setup whose output lands outside the tree leaves it clean, the
    // settle removes it, and the second drive legitimately CREATES a new one
    // and legitimately prepares it: that is correct behaviour, not the adopt
    // case, and asserting "ran once" over it fails for the right reason.
    // (A real `npm ci` is the clean shape — `node_modules` is gitignored and
    // `status --porcelain` does not report ignored files.)
    const driver = makeRunner(r, {
      worktreePrefs: () => ({ setup: `echo ran >> "${marker}"; echo prepared > .prepared` }),
    });
    await driveOn(driver, r, { ...ISOLATED_RUN });
    assert.equal(readFileSync(marker, 'utf8').trim().split('\n').length, 1);
    const tree = driver.requests[0]!.cwd!;
    assert.notEqual(tree, r.root, 'no tree was taken, so this proves nothing');

    // The tree really did survive, so the next drive ADOPTS it.
    await settled(() => isRegistered(r.root, tree), 'the dirty tree was removed');
    assert.equal(existsSync(join(tree, '.prepared')), true);

    // Dropping the memo made every step re-run; the setup command must NOT.
    // Re-running `npm ci` over a checkout a session has been working in is
    // somewhere between wasteful and destructive, so it is gated on `created`.
    const before = driver.requests.length;
    await driveOn(driver, r, { resumeRunId: String(runStateAfter(r).id), onlyPhases: [2] });
    assert.ok(driver.requests.length > before, 'the resume never spawned');
    assert.equal(driver.requests[before]!.cwd, tree, 'the resume did not adopt the tree');
    assert.equal(readFileSync(marker, 'utf8').trim().split('\n').length, 1,
      'the setup command ran a second time over an adopted tree');
  } finally { r.cleanup(); }
});

test('F-2 — a setup command that leaves FILES still gets its tree discarded', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const names = laneNames({
      stateDir: runDir(r.root, 'demo'), runId: 'unknown', slug: 'demo', phase: 0,
    });
    // 🔴 The shipped test's command wrote only to stderr, so the tree was CLEAN
    // and `pruneRunTree` removed it — proving nothing about the real case. A
    // failing `npm ci` leaves a `node_modules` and a lockfile, and `pruneRunTree`
    // refuses a dirty tree by design. The refusal fired every time: the tree
    // stayed registered holding `pe/demo`, nothing pointed at it, the sweep kept
    // it forever because it was dirty, and every later run refused
    // `branch-in-use` — a permanent, silent wedge of the whole plan.
    const requests = await requestsFor(r, { ...ISOLATED_RUN }, {
      worktreePrefs: () => ({ setup: 'echo half > leftover.txt; mkdir -p junk; exit 7' }),
    });
    assert.equal(requests[0]!.cwd, r.root);

    const state = runStateAfter(r);
    assert.equal(state.checkout, 'refused');
    assert.equal(state.isolationRefusal, 'setup-failed');
    assert.equal(state.workRoot, undefined);

    // The tree is GONE — registration and directory both.
    assert.equal(await isRegistered(r.root, names.integration), false,
      'the half-prepared tree is still registered, holding pe/demo');
    assert.equal(existsSync(join(runDir(r.root, 'demo'), 'worktrees', String(state.id), 'integration')),
      false);
    assert.doesNotMatch(git(r.root, 'worktree', 'list'), /integration/);
  } finally { r.cleanup(); }
});

test('F-2 — and the NEXT run of the plan is not wedged by it', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // The consequence, executed rather than reasoned about: a leftover tree
    // holds `pe/demo`, and git allows a branch one working tree, so every later
    // run of the plan meets `branch-in-use` forever.
    await requestsFor(r, { ...ISOLATED_RUN }, {
      worktreePrefs: () => ({ setup: 'echo half > leftover.txt; exit 7' }),
    });
    assert.equal(runStateAfter(r).isolationRefusal, 'setup-failed');

    // 🔴 The state directory is deliberately NOT deleted between the two runs.
    // Doing so removes the leftover tree that IS the wedge, and this test then
    // passes with the defect fully present — which is how the first version of
    // it went green against the shipped `pruneRunTree` call.
    writeFileSync(join(r.state, 'done'), '');
    const second = await requestsFor(r, { ...ISOLATED_RUN });
    assert.notEqual(second[0]!.cwd, r.root,
      'the next run was refused — the failed setup wedged the plan');
    assert.equal(runStateAfter(r).checkout, 'worktree');
    assert.equal(git(second[0]!.cwd!, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo');
  } finally { r.cleanup(); }
});

test('F-4 — an isolated run\'s durable child record names its tree and branch', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // `ChildRef.worktree` is the DURABLE handle on a session that outlived its
    // console — what `reconcileRun`'s orphan branch and `adopt` read. Its
    // documented convention is "absent means this session shared the run's
    // root", so an isolated session with no entry said the exact opposite of
    // where its process was.
    // 🔴 The stub spawn MUST REPORT A PID, and the first version of this test
    // did not. `syncMirror` skips every lane whose `pid` is null, so a harness
    // that never calls `request.onPid` writes NO children at all — `seen` stays
    // empty, `seen.every(...)` is vacuously true, and the two assertions also
    // admitted `undefined` outright. Measured in QA round 2: with the fix
    // reverted to `lane.worktree`/`lane.branch`, this file was 38/38 green.
    // `onPid` runs `syncMirror()` + `persist()` synchronously, so the run file
    // holds the child by the time the call returns.
    const seen: Record<string, unknown>[] = [];
    await requestsFor(r, { ...ISOLATED_RUN }, {}, (request) => {
      request.onPid?.(process.pid);
      const dir = runDir(r.root, 'demo');
      const file = readdirSync(dir).find((f) => /^run-.*\.json$/.test(f));
      if (file) {
        const live = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
        const children = (live.children ?? {}) as Record<string, Record<string, unknown>>;
        for (const child of Object.values(children)) seen.push(child);
      }
    });
    const state = runStateAfter(r);
    const tree = state.workRoot;
    assert.ok(tree, 'no run checkout was taken, so this proves nothing');
    assert.ok((state.phases as Record<string, Record<string, unknown>>)['1'],
      'phase 1 left no record at all');
    // Non-vacuity first: an empty `seen` makes every assertion below true.
    assert.ok(seen.length, 'no child record was written at all — the rest would be vacuous');
    // …and then the claim itself, POSITIVELY. `absent` is not an acceptable
    // answer here: `ChildRef.worktree`'s documented convention reads it as
    // "this session shared the run's root", the opposite of where it was.
    for (const child of seen) {
      assert.equal(child.worktree, tree,
        `a child claimed a checkout that is not the run's: ${JSON.stringify(child)}`);
      assert.equal(child.branch, 'pe/demo',
        `a child claimed a branch that is not the run's: ${JSON.stringify(child)}`);
    }
  } finally { r.cleanup(); }
});

test('P15 — a LANE\'s durable child record says its tree is locked, and the run its base', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // Two facts a person reading the Now page asks of a lane, both decided
    // by the runner and, until now, both kept only where their process was:
    // the `git worktree lock` phase 7 fastens on the lane (in git's registry,
    // read back by `checkouts()` for the git card alone) and the base the
    // lane's branch was cut from (in memory, `baseResolved`, and the journal).
    // The row is drawn from the run record, so the run record carries them.
    const seen: Record<string, unknown>[] = [];
    await requestsFor(
      r,
      { onlyPhases: [1], gitMode: 'new-branch' },
      { planWorktrees: () => 'on' },
      (request) => {
        request.onPid?.(process.pid);
        const dir = runDir(r.root, 'demo');
        const file = readdirSync(dir).find((f) => /^run-.*\.json$/.test(f));
        if (file) {
          const live = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
          const children = (live.children ?? {}) as Record<string, Record<string, unknown>>;
          for (const child of Object.values(children)) seen.push(child);
        }
      },
    );
    assert.ok(seen.length, 'no child record was written at all — the rest would be vacuous');
    for (const child of seen) {
      assert.equal(child.branch, 'pe/demo-p1', `not a lane: ${JSON.stringify(child)}`);
      assert.match(String(child.locked), /^phase-console lane demo p1 /,
        `the lane's lock reason is not on its record: ${JSON.stringify(child)}`);
    }
    const state = runStateAfter(r);
    const base = state.base as { ref?: string; sha?: string; source?: string; declaredBy?: string } | undefined;
    assert.ok(base, 'the resolved base is not on the run record');
    assert.equal(base.ref, 'main');
    assert.match(String(base.sha), /^[0-9a-f]{40}$/);
    // The fixture has no remote, so `origin/HEAD` falls to the local trunk —
    // and nobody declared a word, so the shipped default answered.
    assert.equal(base.source, 'trunk');
    assert.equal(base.declaredBy, 'default');
  } finally { r.cleanup(); }
});

test('F-3 — the cap counts a run that is still ACQUIRING, not just one that finished', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // The race, made deterministic. Everything after the cap check awaits — a
    // scope check, `git worktree add`, a setup command that may run for ten
    // minutes — while `checkout: 'worktree'` is written only at the very end.
    // Two runs starting together both read the pre-count and both passed a cap
    // of one. A slow setup command is simply the window held open.
    const runners: { holds: () => boolean }[] = [];
    const driver = makeRunner(r, {
      worktreePrefs: () => ({ maxConcurrent: 1, setup: 'sleep 0.5' }),
      // The service's own reading, verbatim: `holdsIsolatedCheckout()`, not
      // `current().checkout`. Reading the word alone is what made the cap a
      // suggestion.
      isolatedCheckouts: () => runners.filter((x) => x.holds()).length,
    });
    runners.push({ holds: () => false });

    const holds = () => (driver.runner as unknown as { holdsIsolatedCheckout(): boolean })
      .holdsIsolatedCheckout();
    const written = () => driver.runner.current()?.checkout === 'worktree';
    const spy = { early: false as boolean };
    // 🔴 The discriminating sample is `holds() && !written()` — holding a slot
    // BEFORE `checkout: 'worktree'` exists. Two weaker versions of this loop
    // went green with the reservation deleted: one polled a fixed number of
    // ticks and ran past the end of the drive, the other stopped at the end of
    // the drive but still sampled the long stretch AFTER the preamble, when
    // `checkout` is written and `holds()` is true for the ordinary reason. The
    // window the cap cares about is the one where the tree does not exist yet
    // and the run is nonetheless entitled to a slot.
    let running = true;
    const started = driveOn(driver, r, { ...ISOLATED_RUN }).finally(() => { running = false; });
    while (running && !spy.early) {
      spy.early = holds() && !written();
      await new Promise((done) => { setTimeout(done, 20); });
    }
    await started;

    assert.equal(spy.early, true,
      'the run never reported holding a checkout while it was still acquiring one — '
      + 'the cap cannot see a run mid-acquisition, so two can pass a cap of one');
    assert.notEqual(driver.requests[0]!.cwd, r.root, 'no tree was taken, so this proves nothing');
    // …and the reservation is RELEASED, or the run would hold a slot for ever.
    assert.equal(holds(), runStateAfter(r).checkout === 'worktree',
      'after the drive, holding must mean exactly what `checkout` says');
  } finally { r.cleanup(); }
});

test('F-1a — after the settle the run claims NOTHING, though `checkout` still says worktree', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // The divergent window `branchFor`'s pair rule exists for, pinned directly.
    //
    // A clean settle deletes `workRoot` and deliberately KEEPS
    // `checkout: 'worktree'` as the history of what the run got. Anything that
    // reads the word ALONE in that window — the lease-refresh timer is the live
    // one — hands out `--branch pe/<slug>`, claiming the carve-out phase 8
    // admits on, for a run that is not in a tree at all.
    //
    // 🔴 The two F-1 drive tests do NOT cover this: dropping the memo makes the
    // preamble re-pair the fields before any session spawns, so with `branchFor`
    // reverted to `checkout` this file was 38/38 green in QA round 2. Only the
    // post-settle state tells the two halves apart.
    const driver = makeRunner(r);
    await driveOn(driver, r, { ...ISOLATED_RUN });
    const tree = driver.requests[0]!.cwd!;
    assert.notEqual(tree, r.root, 'no run checkout was taken, so this proves nothing');
    await pruned(r);

    const state = runStateAfter(r);
    assert.equal(state.checkout, 'worktree', 'the history word was cleared — this pins nothing now');
    assert.equal(state.workRoot, undefined, 'the settle left a path to a directory it removed');

    const reader = driver.runner as unknown as {
      branchFor(phase: number): string | undefined;
      treeFor(phase: number): string | undefined;
      worktreeFor(phase: number): string | undefined;
    };
    // The branch stays claimed — a new-branch run's sessions commit on
    // `pe/demo` wherever they stand — and the TREE tells the truth about
    // where: the shared root, now that the settle removed the worktree. The
    // pair collides with every other claim on the root, which is exactly the
    // carve-out this run no longer holds.
    assert.equal(reader.branchFor(1), 'pe/demo');
    assert.equal(reader.treeFor(1), phys(r.root),
      'with the worktree gone, the claimed tree is the shared root');
    assert.equal(reader.worktreeFor(1), undefined,
      'the run names a checkout the settle has already removed');
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * QA round 3. All six round-1 findings were confirmed closed; these
 * are the three the idempotent preamble INTRODUCED, plus the half of
 * exit criterion 3 nothing was executing.
 * ------------------------------------------------------------------ */

test('Q-2 — the `.env*` copy seeds a NEW tree and never overwrites an edit in one', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    writeFileSync(join(r.root, '.env'), 'FROM=root\n');
    const driver = makeRunner(r, { worktreePrefs: () => ({ copyEnv: true }) });
    await driveOn(driver, r, { ...ISOLATED_RUN });
    const tree = driver.requests[0]!.cwd!;
    assert.notEqual(tree, r.root, 'no tree was taken, so this proves nothing');
    assert.equal(readFileSync(join(tree, '.env'), 'utf8'), 'FROM=root\n', 'the seed never happened');

    // An operator (or the setup command, or the session) edits it in the tree.
    // Make the tree DIRTY too, so it survives the settle and the next drive
    // ADOPTS it — which is the only case this rule is about.
    writeFileSync(join(tree, '.env'), 'FROM=operator-edit\n');
    writeFileSync(join(tree, '.keep-me-dirty'), 'so the settle keeps this tree\n');
    await pruned(r);
    assert.equal(await isRegistered(r.root, tree), true, 'the dirty tree was removed');

    // 🔴 `copyFile` OVERWRITES, and the preamble re-runs on every drive. The
    // price of the idempotence that fixed the resume was very nearly this:
    // a silent revert of a file the operator changed.
    const before = driver.requests.length;
    await driveOn(driver, r, { resumeRunId: String(runStateAfter(r).id), onlyPhases: [2] });
    assert.equal(driver.requests[before]!.cwd, tree, 'the resume did not adopt the tree');
    assert.equal(readFileSync(join(tree, '.env'), 'utf8'), 'FROM=operator-edit\n',
      'the resume re-copied the root .env over the one in the tree');
  } finally { r.cleanup(); }
});

test('Q-3 — a resume journals no SECOND `run.isolation` line', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // The plan asks for one line. The preamble re-runs on every drive by
    // design, so "once" has to mean once per DECISION — an unchanged answer
    // repeated at every resume is a line an operator learns to scroll past.
    const driver = makeRunner(r, { worktreePrefs: () => ({ setup: 'touch .keep-me-dirty' }) });
    await driveOn(driver, r, { ...ISOLATED_RUN });
    const tree = driver.requests[0]!.cwd!;
    assert.notEqual(tree, r.root, 'no tree was taken, so this proves nothing');
    assert.equal(isolationEvents(r).length, 1);

    await pruned(r);
    assert.equal(await isRegistered(r.root, tree), true, 'the dirty tree was removed');
    await driveOn(driver, r, { resumeRunId: String(runStateAfter(r).id), onlyPhases: [2] });
    assert.equal(isolationEvents(r).length, 1,
      'the resume repeated a decision that had not changed');
  } finally { r.cleanup(); }
});

test('EC3 — a second run after a DIRTY settle degrades honestly, and says which', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // After a dirty settle the tree is KEPT — deliberately, it holds
    // uncommitted work — and it holds `pe/demo`. The next run used to degrade
    // to the shared root with `branch-in-use`, naming a directory the console
    // had made itself; since G9 it ADOPTS it, because a kept tree is kept
    // precisely because it holds this plan's own unfinished work and the run
    // that wants it is the same plan's next attempt.
    const first = await requestsFor(r, { ...ISOLATED_RUN }, {}, (request) => {
      writeFileSync(join(request.cwd!, 'unsaved.txt'), 'never committed\n');
    });
    const tree = first[0]!.cwd!;
    assert.notEqual(tree, r.root, 'no tree was taken, so this proves nothing');
    await pruned(r);
    assert.equal(await isRegistered(r.root, tree), true, 'the dirty tree must be KEPT');

    writeFileSync(join(r.state, 'done'), '');
    const second = await requestsFor(r, { ...ISOLATED_RUN });
    assert.equal(second[0]!.cwd, phys(tree), 'the second run takes the tree its own plan left');
    const state = runStateAfter(r);
    assert.equal(state.checkout, 'worktree');
    assert.equal(state.isolationRefusal, undefined, 'nothing was refused');
    assert.equal(state.workRoot, phys(tree));
    // …and the killed session's uncommitted work is still exactly where it was:
    // adopting moves nothing and removes nothing.
    assert.equal(readFileSync(join(tree, 'unsaved.txt'), 'utf8'), 'never committed\n');
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * QA round 4. Round 3 fixed the SUCCESS path of `buildRunCheckout`;
 * the REFUSAL path kept both defects, and no test reached it because
 * every refusal test refuses on a run's FIRST drive — where the field
 * in question was never set in the first place.
 *
 * So every test here lands its refusal on the SECOND drive of a pooled
 * `Runner`, which is the only place the two paths can be told apart.
 * ------------------------------------------------------------------ */

/**
 * Take `pe/demo` away from the run: remove its tree, hold the branch elsewhere.
 *
 * The `unlock` is the operator's own hand, and it is load-bearing since phase
 * 7: a run's checkout is `git worktree lock`ed while the run holds it, and
 * `git worktree prune` SKIPS a locked registration — so a person who deletes
 * the directory and prunes finds the branch still held, with git saying
 * "skipping locked worktree". That is the lock working. The console's own
 * paths unlock first (`pruneRegistrations`), which is what R4-4 proves.
 */
function stealTheBranch(r: Repo, tree: string): string {
  rmSync(tree, { recursive: true, force: true });
  try { git(r.root, 'worktree', 'unlock', tree); } catch { /* not locked: nothing to undo */ }
  git(r.root, 'worktree', 'prune');
  const held = join(r.root, '..', `held-${basename(r.root)}`);
  git(r.root, 'worktree', 'add', '-q', held, 'pe/demo');
  return held;
}

test('R4-1 — a resume REFUSED `branch-in-use` clears the tree it can no longer have', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const driver = makeRunner(r, { worktreePrefs: () => ({ setup: 'touch .keep-me-dirty' }) });
    await driveOn(driver, r, { ...ISOLATED_RUN });
    const tree = driver.requests[0]!.cwd!;
    assert.notEqual(tree, r.root, 'no tree was taken, so this proves nothing');
    await pruned(r);
    assert.equal(await isRegistered(r.root, tree), true, 'the dirty tree was removed');
    assert.equal(runStateAfter(r).workRoot, tree, 'the run does not point at its tree');

    // The operator tidies the tree away and checks the branch out somewhere
    // else — an ordinary thing to do, and the run cannot have `pe/demo` back.
    const held = stealTheBranch(r, tree);
    try {
      const before = driver.requests.length;
      await driveOn(driver, r, { resumeRunId: String(runStateAfter(r).id), onlyPhases: [2] });
      const resumed = driver.requests[before]!;
      const state = runStateAfter(r);

      assert.equal(state.checkout, 'refused');
      assert.equal(state.isolationRefusal, 'branch-in-use');
      // 🔴 The finding. This branch set the three fields by hand and omitted
      // the one line that matters, so the run read `refused` while still
      // pointing at a directory that is gone — and spawned into it.
      assert.equal(state.workRoot, undefined,
        'a refused run still points at a tree it does not have');
      assert.equal(resumed.cwd, r.root, 'the session was spawned into the vanished tree');
      assert.equal(existsSync(resumed.cwd!), true, 'the session was spawned into a missing cwd');
      // …and its claim tells the truth: `pe/demo` in the SHARED root. The
      // tree dimension is what keeps that from being a carve-out — the shared
      // root collides with every claim on it, and the held tree's `pe/demo`
      // collides on the branch besides.
      assert.equal(resumed.env?.PE_BRANCH, 'pe/demo');
      assert.equal(resumed.env?.PE_WORKTREE, phys(r.root));
    } finally { rmSync(held, { recursive: true, force: true }); }
  } finally { r.cleanup(); }
});

test('R4-2 — a permanently-refused run journals its reason ONCE, not once per resume', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // `scope-outside-root` is the refusal every hub-rooted plan gets, for ever.
    // The success path was gated on the decision in round 3; this path was not,
    // so each resume appended another identical line.
    const driver = makeRunner(r, { planScope: () => ['phased-execution'] });
    await driveOn(driver, r, { ...ISOLATED_RUN });
    assert.equal(runStateAfter(r).isolationRefusal, 'scope-outside-root');
    assert.equal(isolationEvents(r).length, 1);

    await driveOn(driver, r, { resumeRunId: String(runStateAfter(r).id), onlyPhases: [2] });
    assert.equal(runStateAfter(r).isolationRefusal, 'scope-outside-root');
    assert.equal(isolationEvents(r).length, 1,
      'the resume repeated a refusal that had not changed');
  } finally { r.cleanup(); }
});

test('R4-3 — a CHANGED refusal is still journalled, so the gate is not simply silence', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // The other side of R4-2. Gating on the decision must not mean "say nothing
    // after the first time" — a run whose refusal CHANGES has news, and an
    // operator reading `cap-reached` when the reason is now `scope-outside-root`
    // is being told the wrong thing.
    let cap = 0;
    const driver = makeRunner(r, {
      worktreePrefs: () => ({ maxConcurrent: 1 }),
      isolatedCheckouts: () => cap,
      planScope: () => ['phased-execution'],
    });
    cap = 1;
    await driveOn(driver, r, { ...ISOLATED_RUN });
    assert.equal(runStateAfter(r).isolationRefusal, 'cap-reached');
    assert.equal(isolationEvents(r).length, 1);

    cap = 0; // the cap frees, and now the SCOPE is what refuses
    await driveOn(driver, r, { resumeRunId: String(runStateAfter(r).id), onlyPhases: [2] });
    assert.equal(runStateAfter(r).isolationRefusal, 'scope-outside-root');
    assert.equal(isolationEvents(r).length, 2, 'a refusal that CHANGED went unreported');
  } finally { r.cleanup(); }
});

test('R4-4 — a registration whose directory an operator deleted is rebuilt, not adopted', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const driver = makeRunner(r, { worktreePrefs: () => ({ setup: 'touch .keep-me-dirty' }) });
    await driveOn(driver, r, { ...ISOLATED_RUN });
    const tree = driver.requests[0]!.cwd!;
    assert.notEqual(tree, r.root, 'no tree was taken, so this proves nothing');
    await pruned(r);
    assert.equal(await isRegistered(r.root, tree), true, 'the dirty tree was removed');

    // `rm -rf` by hand, leaving the registration behind. `git worktree list`
    // still prints it (git calls it PRUNABLE), so `isRegistered` says yes about
    // a directory that is gone — and the preamble would "adopt" nothing at all,
    // set `workRoot` to it, and spawn into it.
    rmSync(tree, { recursive: true, force: true });
    assert.equal(await isRegistered(r.root, tree), true,
      'the stale registration did not survive — this test cannot prove anything');
    assert.equal(existsSync(tree), false);

    const before = driver.requests.length;
    await driveOn(driver, r, { resumeRunId: String(runStateAfter(r).id), onlyPhases: [2] });
    const resumed = driver.requests[before]!;
    assert.equal(existsSync(resumed.cwd!), true, 'the session was spawned into a missing directory');
    assert.notEqual(resumed.cwd, r.root, 'the run gave up a tree it could have rebuilt');
    assert.equal(git(resumed.cwd!, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo');
    assert.equal(runStateAfter(r).workRoot, resumed.cwd);
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * QA round 5 — the fifth instance of this phase's one failure mode.
 *
 * Rounds 1-4 each fixed the RECORD of a refusal. None of them released
 * the RESOURCE: a refusal arriving on a LATER drive meets a run that
 * already HAS its checkout, and clearing `workRoot` only stops the run
 * pointing at a tree that is still registered and still holding
 * `pe/<slug>`.
 * ------------------------------------------------------------------ */

test('R6-1 — a refusal on a resume does NOT take the checkout away from a run holding it', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // Drive once with the scope confined so the run really gets a tree, then
    // move the scope out from under it — a refusal that can only ever arrive on
    // a later drive.
    let scope = ['all'];
    const driver = makeRunner(r, { planScope: () => scope }, (request) => {
      writeFileSync(join(request.cwd!, 'unsaved.txt'), 'never committed\n');
    });
    await driveOn(driver, r, { ...ISOLATED_RUN });
    const tree = driver.requests[0]!.cwd!;
    assert.notEqual(tree, r.root, 'no tree was taken, so this proves nothing');
    await pruned(r);
    assert.equal(await isRegistered(r.root, tree), true,
      'the settle removed the tree, so the resume meets no held checkout at all');

    scope = ['phased-execution'];
    const before = driver.requests.length;
    await driveOn(driver, r, { resumeRunId: String(runStateAfter(r).id), onlyPhases: [2] });
    const state = runStateAfter(r);

    // 🔴 The invariant, stated as one sentence: a run is NEVER degraded to the
    // shared root while a console-managed tree still holds its branch. Round 5
    // tried to reach it by releasing the tree; releasing is what deleted lane
    // work (R6-2). The refusal is about TAKING a checkout, and this run has
    // already taken one — so it keeps it, and the refusal applies to the next
    // run, where it costs nothing.
    assert.equal(state.checkout, 'worktree');
    assert.equal(state.isolationRefusal, undefined,
      'the resume surrendered a checkout it was already using');
    assert.equal(state.workRoot, tree);
    assert.equal(driver.requests[before]!.cwd, tree, 'the session was sent to the shared root');
    assert.equal(readFileSync(join(tree, 'unsaved.txt'), 'utf8'), 'never committed\n');

    // Said once, and said in words — a silent override is as bad as a silent
    // degrade, which is the rule this whole preamble is written to.
    const kept = journalEvents(r, 'run.isolation-kept');
    assert.equal(kept.length, 1, 'the override was silent');
    assert.equal((kept[0]!.data as Record<string, unknown>).refusal, 'scope-outside-root');
  } finally { r.cleanup(); }
});

test('R6-1 — the override is journalled ONCE, not once per drive', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    let scope = ['all'];
    // Dirtied, so the settle KEEPS the tree and the resumes meet a run that
    // genuinely holds one — a clean tree is pruned at settle and there is
    // nothing left to override a refusal about.
    const driver = makeRunner(r, { planScope: () => scope }, (request) => {
      writeFileSync(join(request.cwd!, 'unsaved.txt'), 'never committed\n');
    });
    await driveOn(driver, r, { ...ISOLATED_RUN });
    const tree = driver.requests[0]!.cwd!;
    assert.notEqual(tree, r.root, 'no tree was taken');
    await pruned(r);
    assert.equal(await isRegistered(r.root, tree), true, 'the settle removed the tree');
    scope = ['phased-execution'];
    const id = String(runStateAfter(r).id);
    await driveOn(driver, r, { resumeRunId: id, onlyPhases: [2] });
    await driveOn(driver, r, { resumeRunId: id, onlyPhases: [3] });
    assert.equal(journalEvents(r, 'run.isolation-kept').length, 1,
      'a run that drives four times says the same thing four times');
  } finally { r.cleanup(); }
});

test('R6-2 — a refusal on a resume never deletes a LANE checkout', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // The regression QA round 6 demonstrated end-to-end. Round 5's release
    // called `pruneRunTree`, which is `pruneRun` with NO phases: the lane loop
    // that fills `kept` never runs, so `kept` came back empty however much lane
    // work was on disk, and the terminal `rm -rf <stateDir>/worktrees/<runId>`
    // took every lane checkout with it — including one the settle had
    // deliberately KEPT because it was dirty.
    let scope = ['all'];
    const driver = makeRunner(
      r,
      { planScope: () => scope, planWorktrees: () => 'on' },
      (request) => {
        if (/BOOT phase 1/.test(request.prompt)) {
          writeFileSync(join(request.cwd!, 'lane-unsaved.txt'), 'a session was working here\n');
        }
      },
    );
    await driveOn(driver, r, { ...ISOLATED_RUN });
    const lane = driver.requests.find((q) => /BOOT phase 1/.test(q.prompt))!.cwd!;
    assert.notEqual(lane, r.root, 'no lane tree was taken, so this proves nothing');
    assert.equal(existsSync(join(lane, 'lane-unsaved.txt')), true, 'the lane work was never made');
    await pruned(r);
    assert.equal(existsSync(join(lane, 'lane-unsaved.txt')), true,
      'the settle already removed it, so the refusal cannot be what does');

    scope = ['phased-execution'];
    await driveOn(driver, r, { resumeRunId: String(runStateAfter(r).id), onlyPhases: [3] });

    assert.equal(readFileSync(join(lane, 'lane-unsaved.txt'), 'utf8'),
      'a session was working here\n',
      'a refusal deleted a lane checkout holding uncommitted work');
  } finally { r.cleanup(); }
});

test('R7-3 — a tree switched to ANOTHER branch is not adopted, and the run does not claim it', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const driver = makeRunner(r, {}, (request) => {
      writeFileSync(join(request.cwd!, 'unsaved.txt'), 'never committed\n');
    });
    await driveOn(driver, r, { ...ISOLATED_RUN });
    const tree = driver.requests[0]!.cwd!;
    assert.notEqual(tree, r.root, 'no tree was taken, so this proves nothing');
    await pruned(r);
    assert.equal(await isRegistered(r.root, tree), true, 'the settle removed the tree');

    // An operator switches the console's own tree to something else. It is
    // still REGISTERED — all the previous version of this test asked — but it
    // is not this run's checkout, and adopting it would send the session there
    // with `PE_BRANCH=pe/demo` for a tree standing somewhere else.
    //
    // 🔴 This DRIVES the run. The version this replaces only called
    // `holdsBranch` and `isRegistered` directly, so reverting the exemption to
    // `isRegistered` left it green — the seventh instance of this phase's one
    // failure mode, in a test written to guard against the sixth.
    git(tree, 'checkout', '-q', '-b', 'operator-was-here');
    assert.equal(await isRegistered(r.root, tree), true, 'the switch unregistered the tree');

    const before = driver.requests.length;
    await driveOn(driver, r, { resumeRunId: String(runStateAfter(r).id), onlyPhases: [2] });
    const state = runStateAfter(r);
    assert.notEqual(state.checkout, 'worktree',
      'the run adopted a tree standing on another branch');
    assert.equal(state.workRoot, undefined);
    assert.notEqual(driver.requests[before]!.cwd, tree,
      'a session was sent into a tree that is not on this run\'s branch');
    // And the refusal names the branch it actually found, which is the one fact
    // that makes the situation fixable.
    const line = isolationEvents(r).at(-1)!.data as Record<string, unknown>;
    assert.match(String(line.detail ?? line.reason), /operator-was-here/);
  } finally { r.cleanup(); }
});

test('R7-1 — turning isolation OFF gives the tree back, and never leaves the branch held silently', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // A CLEAN tree: the drop can release it outright, so the branch is free and
    // the ordinary shared-checkout instruction is true again.
    const driver = makeRunner(r);
    await driveOn(driver, r, { ...ISOLATED_RUN });
    const tree = driver.requests[0]!.cwd!;
    assert.notEqual(tree, r.root, 'no tree was taken');
    // Re-register by hand so the resume meets a run that genuinely holds one.
    await pruned(r);
    if (!(await isRegistered(r.root, tree))) {
      git(r.root, 'worktree', 'add', '-q', tree, 'pe/demo');
      const dir = runDir(r.root, 'demo');
      const file = readdirSync(dir).filter((f) => /^run-.*\.json$/.test(f))[0]!;
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
      raw.workRoot = tree; raw.checkout = 'worktree';
      writeFileSync(join(dir, file), JSON.stringify(raw));
    }

    const before = driver.requests.length;
    await driveOn(driver, r, {
      resumeRunId: String(runStateAfter(r).id), onlyPhases: [2], isolation: 'queue',
    });
    const state = runStateAfter(r);
    assert.equal(state.checkout, 'shared');
    assert.equal(state.workRoot, undefined);
    assert.equal(await isRegistered(r.root, tree), false, 'the drop kept the tree');
    // The proof the branch is genuinely free: the shared checkout can have it.
    git(r.root, 'checkout', '-q', 'pe/demo');
    assert.match(driver.requests[before]!.prompt, /BEFORE editing anything/);
  } finally { r.cleanup(); }
});

test('R7-1 — a DIRTY tree is kept, and the prompt stops telling the session to check the branch out', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const driver = makeRunner(r, {}, (request) => {
      if (/BOOT phase 1/.test(request.prompt)) {
        writeFileSync(join(request.cwd!, 'unsaved.txt'), 'never committed\n');
      }
    });
    await driveOn(driver, r, { ...ISOLATED_RUN });
    const tree = driver.requests[0]!.cwd!;
    assert.notEqual(tree, r.root, 'no tree was taken');
    await pruned(r);
    assert.equal(await isRegistered(r.root, tree), true, 'the settle removed the dirty tree');

    const before = driver.requests.length;
    await driveOn(driver, r, {
      resumeRunId: String(runStateAfter(r).id), onlyPhases: [2], isolation: 'queue',
    });
    const state = runStateAfter(r);
    assert.equal(state.checkout, 'shared');
    assert.equal(driver.requests[before]!.cwd, r.root);
    // Uncommitted work outranks a tidy branch, so the tree stays...
    assert.equal(readFileSync(join(tree, 'unsaved.txt'), 'utf8'), 'never committed\n');
    // ...and because it stays, the session must NOT be told to take the branch:
    // `git checkout pe/demo` in the root answers `fatal: … already used by
    // worktree at …`, naming a directory the session has never heard of.
    const prompt = driver.requests[before]!.prompt;
    assert.doesNotMatch(prompt, /BEFORE editing anything: if `pe\/demo` exists/);
    assert.match(prompt, /is checked out in another working tree at/);
    assert.ok(prompt.includes(tree), 'the prompt does not say WHERE the branch is held');
    // The two branch bullets must AGREE: telling a session to work on the
    // current branch and then "Commit only to `pe/demo`" is two incompatible
    // orders in one prompt, with the root standing on `main`.
    assert.doesNotMatch(prompt, /Commit only to `pe\/demo`/);
    assert.match(prompt, /commit on the branch this checkout\n  is already on/);
  } finally { r.cleanup(); }
});

/**
 * Stage a fresh run of the same plan: forget the previous run's records, KEEP
 * whatever it left on disk.
 *
 * 🔴 Not `rm -rf` of the whole run directory, which is what the tests that
 * stage a second run do — that takes `worktrees/` with it, and the case under
 * test here is precisely a tree the previous run LEFT BEHIND.
 */
function stageNextRun(r: Repo): void {
  writeFileSync(join(r.state, 'done'), '');
  const dir = runDir(r.root, 'demo');
  for (const f of readdirSync(dir)) {
    if (/^run-.*\.json$/.test(f) || f.endsWith('.jsonl')) rmSync(join(dir, f), { force: true });
  }
}

test('QA8-3 — a NEW run meeting the previous run\'s kept tree is told the truth, not "check it out"', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // A killed session leaves the integration tree dirty; the settle keeps it
    // on purpose, because uncommitted work outranks a tidy branch. The next run
    // of the same plan has never held anything — so a holder recorded on the
    // PREVIOUS run's state could never have helped it, which is exactly why the
    // prompt asks git instead of remembering.
    const first = makeRunner(r, {}, (request) => {
      writeFileSync(join(request.cwd!, 'unsaved.txt'), 'a killed session left this\n');
    });
    await driveOn(first, r, { ...ISOLATED_RUN });
    const tree = first.requests[0]!.cwd!;
    assert.notEqual(tree, r.root, 'no tree was taken, so this proves nothing');
    await pruned(r);
    assert.equal(await isRegistered(r.root, tree), true, 'the settle removed the dirty tree');

    // A SECOND run of the same plan — and the previous run's tree stays where
    // the settle deliberately left it.
    stageNextRun(r);
    const second = await requestsFor(r, { ...ISOLATED_RUN });
    const prompt = second[0]!.prompt;
    // Since G9 the second run does not meet that refusal at all: the holder is
    // this plan's OWN previous integration tree under the console's worktree
    // home, so it is adopted and the session is boarded INTO it. The bullet the
    // old assertion guarded against ("check out pe/demo") is never reached,
    // because a run with its own checkout is told it already has one.
    assert.equal(second[0]!.cwd, phys(tree), 'the kept tree is adopted, not refused');
    assert.doesNotMatch(prompt, /BEFORE editing anything: if `pe\/demo` exists/,
      'the new run was told to check out a branch git will refuse it');
    assert.match(prompt, /Your cwd IS a console-managed worktree/, 'the session is told it has its checkout');
    // And git really would have refused a checkout in the root, which is what
    // made the old bullet a lie and what adoption sidesteps entirely.
    assert.throws(() => git(r.root, 'checkout', 'pe/demo'),
      (error: unknown) => /already used by worktree/.test(String((error as { stderr?: string }).stderr ?? error)),
      'git allowed the checkout, so the honest bullet is not needed here');
  } finally { r.cleanup(); }
});

test('QA9-1 — a HELD branch outranks the neighbour CAUTION, and the prompt never contradicts itself', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // The previous run leaves a dirty tree the settle keeps — round 8's
    // scenario — and this time a neighbour is live too, which is this plan's
    // own premise rather than an exotic case.
    const first = makeRunner(r, {}, (request) => {
      writeFileSync(join(request.cwd!, 'unsaved.txt'), 'a killed session left this\n');
    });
    await driveOn(first, r, { ...ISOLATED_RUN });
    const tree = first.requests[0]!.cwd!;
    assert.notEqual(tree, r.root, 'no tree was taken, so this proves nothing');
    await pruned(r);
    assert.equal(await isRegistered(r.root, tree), true, 'the settle removed the dirty tree');

    const locks: LockView[] = [
      { slug: 'other-plan', phase: 3, owner: 'sam@example-host', expired: false, scope: ['all'] },
    ];
    const scheduler = new Scheduler({ locks: () => locks, guard: () => false });
    stageNextRun(r);
    const requests = await requestsFor(r, { onlyPhases: [1], gitMode: 'new-branch' }, { scheduler });
    const { cwd, prompt } = requests[0]!;
    assert.equal(cwd, r.root, 'the run got a tree, so no branch is held and this proves nothing');

    // 🔴 The CAUTION's remedy is `git worktree add … pe/demo` — the SAME
    // request as `git checkout pe/demo`, and refused for the same reason. Below
    // the CAUTION in the ternary, the prompt told the session to run it AND,
    // two bullets later, to commit on the branch it was already on: two orders
    // that cannot both be obeyed, one of which is a hard git failure.
    assert.match(prompt, /is checked out in another working tree at/,
      'the neighbour CAUTION won, and its advice is a command git refuses');
    assert.doesNotMatch(prompt, /git worktree add \.\.\//);
    assert.doesNotMatch(prompt, /Commit only to `pe\/demo`/);
    assert.match(prompt, /commit on the branch this checkout\n  is already on/);
    // The neighbour still matters — it rides along rather than being replaced.
    assert.match(prompt, /A live session also shares a repository with this phase/);
    assert.ok(prompt.includes('other-plan P3'), 'the neighbour is not named');

    // And git really would have refused the CAUTION's command.
    assert.throws(() => git(r.root, 'worktree', 'add', join(r.root, '..', 'diy'), 'pe/demo'),
      (error: unknown) => /already used by worktree/.test(
        String((error as { stderr?: string }).stderr ?? error)),
      'git allowed it, so the old advice was not actually broken');
    scheduler.close();
  } finally { r.cleanup(); }
});

test('QA9-2 — the held bullet says only what is true of ANY holder', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // The holder is the OPERATOR's own worktree, not a console-managed one, and
    // it is clean. The bullet used to assert both the opposite things — that it
    // was console-managed and that it held uncommitted work — because that was
    // the case that prompted it. `heldElsewhere` asks about every worktree of
    // the repository, so a sentence that guesses is a sentence that misleads.
    const mine = join(r.root, '..', `operator-${basename(r.root)}`);
    git(r.root, 'worktree', 'add', '-q', '-b', 'pe/demo', mine);
    try {
      const requests = await requestsFor(r, { onlyPhases: [1], gitMode: 'new-branch' });
      const prompt = requests[0]!.prompt;
      assert.match(prompt, /is checked out in another working tree at/);
      assert.ok(prompt.includes(mine), 'the prompt does not say WHERE the branch is held');
      assert.doesNotMatch(prompt, /console-managed worktree at/,
        "the operator's own checkout was described as the console's");
      assert.doesNotMatch(prompt, /which holds uncommitted work/,
        'a clean tree was described as holding uncommitted work');
    } finally { rmSync(mine, { recursive: true, force: true }); }
  } finally { r.cleanup(); }
});

test('QA8-2 — once the operator frees the branch, the very next prompt says so', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // A dirty tree the settle keeps, exactly as QA8-3 stages it.
    const first = makeRunner(r, {}, (request) => {
      writeFileSync(join(request.cwd!, 'unsaved.txt'), 'never committed\n');
    });
    await driveOn(first, r, { ...ISOLATED_RUN });
    const tree = first.requests[0]!.cwd!;
    assert.notEqual(tree, r.root, 'no tree was taken, so this proves nothing');
    await pruned(r);
    assert.equal(await isRegistered(r.root, tree), true, 'the settle removed the dirty tree');

    // A shared run while the branch is held: it must be told the truth.
    // 🔴 ONE Runner across both prompts. `Service.runnerFor` pools one per plan
    // for the console's lifetime, so a holder cached anywhere on the runner —
    // not only on `RunState` — would survive into the second prompt. A test
    // that made a fresh Runner each time could not tell a remembered answer
    // from an asked one, and would have passed against the very design this
    // replaces.
    const shared = makeRunner(r);
    stageNextRun(r);
    await driveOn(shared, r, { onlyPhases: [1], gitMode: 'new-branch' });
    assert.match(shared.requests[0]!.prompt, /is checked out in another working tree at/,
      'the held branch was not reported at all, so the second half proves nothing');

    // 🔴 The operator does exactly what that bullet asked. A holder REMEMBERED
    // anywhere would still be remembered now, and every later prompt would keep
    // telling sessions the branch is held and to commit somewhere else — the
    // stale half of the defect, and the reason this is a question for git and
    // never for state.
    // The unlock is part of "exactly what that bullet asked" since phase 7:
    // the console locks its own run checkout, and `git worktree remove` refuses
    // a locked tree (git wants `--force` TWICE). One `unlock` is the whole
    // remedy, and it is what `docs/controls.md` now tells an operator to do.
    git(r.root, 'worktree', 'unlock', tree);
    git(r.root, 'worktree', 'remove', '--force', tree);
    assert.equal(await isRegistered(r.root, tree), false, 'the tree survived the removal');
    stageNextRun(r);
    const before = shared.requests.length;
    await driveOn(shared, r, { onlyPhases: [1], gitMode: 'new-branch' });
    assert.ok(shared.requests.length > before, 'no phase boarded, so this proves nothing');
    const prompt = shared.requests[before]!.prompt;
    assert.doesNotMatch(prompt, /is checked out in another working tree at/,
      'the branch is free, and the session was still told it is held');
    assert.match(prompt, /BEFORE editing anything: if `pe\/demo` exists/);
    assert.match(prompt, /Commit only to `pe\/demo`/);
  } finally { r.cleanup(); }
});

test('R7-6 — a run whose repository gains submodules degrades, and does not keep an empty tree', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const driver = makeRunner(r);
    await driveOn(driver, r, { ...ISOLATED_RUN });
    const tree = driver.requests[0]!.cwd!;
    assert.notEqual(tree, r.root, 'no tree was taken');
    await pruned(r);
    if (!(await isRegistered(r.root, tree))) {
      git(r.root, 'worktree', 'add', '-q', tree, 'pe/demo');
      const dir = runDir(r.root, 'demo');
      const file = readdirSync(dir).filter((f) => /^run-.*\.json$/.test(f))[0]!;
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
      raw.workRoot = tree; raw.checkout = 'worktree';
      writeFileSync(join(dir, file), JSON.stringify(raw));
    }

    // A linked worktree of a superproject has EMPTY submodule directories, so
    // keeping a run in one to avoid a degrade hands its sessions a tree with
    // the work missing. The ROOT worktree is still released for exactly that
    // reason; what follows it is now the MIRROR question — and with no scope
    // token mapping to a sub-repository, the answer is scope-unmapped.
    writeFileSync(join(r.root, '.gitmodules'), '[submodule "x"]\n\tpath = x\n\turl = ./x\n');
    await driveOn(driver, r, { resumeRunId: String(runStateAfter(r).id), onlyPhases: [2] });
    const state = runStateAfter(r);
    assert.equal(state.checkout, 'refused');
    assert.equal(state.isolationRefusal, 'scope-unmapped');
    assert.equal(state.workRoot, undefined);
    assert.equal(await isRegistered(r.root, tree), false,
      'the unusable tree was kept, so the branch stays held for every later run');
  } finally { r.cleanup(); }
});

test('R5-1 — a run that already HOLDS its tree does not re-compete for a cap slot', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    let others = 0;
    const driver = makeRunner(r, {
      worktreePrefs: () => ({ maxConcurrent: 1, setup: 'touch .keep-me-dirty' }),
      isolatedCheckouts: () => others,
    });
    await driveOn(driver, r, { ...ISOLATED_RUN });
    const tree = driver.requests[0]!.cwd!;
    assert.notEqual(tree, r.root, 'no tree was taken, so this proves nothing');
    await pruned(r);
    assert.equal(await isRegistered(r.root, tree), true, 'the dirty tree was removed');

    // Another run takes the only other slot. The cap bounds how many checkouts
    // EXIST — and this run's is one of them, so re-asking is not that question.
    // Without the exemption the resume refused `cap-reached` and SURRENDERED a
    // checkout it had been using perfectly well, for no gain at all.
    others = 1;
    const before = driver.requests.length;
    await driveOn(driver, r, { resumeRunId: String(runStateAfter(r).id), onlyPhases: [2] });
    const state = runStateAfter(r);
    assert.equal(state.isolationRefusal, undefined,
      `the resume surrendered its own checkout: ${JSON.stringify(state.isolationRefusal)}`);
    assert.equal(state.checkout, 'worktree');
    assert.equal(state.workRoot, tree);
    assert.equal(driver.requests[before]!.cwd, tree);
  } finally { r.cleanup(); }
});

test('R5-3 — a git failure that is not a setup command says so', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // `setup-failed` used to be the catch-all for ANY non-branch `worktree add`
    // failure, so a console with no setup command configured told its operator
    // "the setup command failed" — naming a setting they never set. git's own
    // words ride along as `detail` either way.
    //
    // Staged by making the state directory unwritable, which is the honest
    // shape of a disk/permission failure at `worktree add`.
    // …at the home the run would create in: the project's `.worktrees/runs/<slug>`.
    const home = worktreeHome({ mode: 'project', root: r.root, slug: 'demo', stateDir: runDir(r.root, 'demo') });
    mkdirSync(home, { recursive: true });
    execFileSync('chmod', ['500', home]);
    try {
      const requests = await requestsFor(r, { ...ISOLATED_RUN });
      assert.equal(requests[0]!.cwd, r.root);
      const state = runStateAfter(r);
      assert.equal(state.checkout, 'refused');
      assert.equal(state.isolationRefusal, 'worktree-failed',
        'a plain git failure was reported as a setup-command failure');
      assert.equal(state.workRoot, undefined);
      // git's own message, not a category.
      const line = isolationEvents(r)[0]!.data as Record<string, unknown>;
      assert.ok(String(line.detail ?? '').length > 0, 'git said nothing an operator can act on');
    } finally { execFileSync('chmod', ['700', home]); }
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The MIRROR — a superproject run's checkout, end-to-end through the
 * real Runner: per-repo worktrees, the mirror boot arm, the mounts
 * journal, adoption on resume, and a drop that releases every mount.
 * ------------------------------------------------------------------ */

/** Turn the stub root into a two-level SUPERPROJECT: root{ web, app{ core } }. */
function makeSuperRepo(r: Repo): void {
  makeGitRepo(r);
  const src = (name: string): string => {
    const dir = join(r.state, `src-${name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.txt`), `${name}\n`);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    return dir;
  };
  const core = src('core');
  const app = src('app');
  git(app, '-c', 'protocol.file.allow=always', 'submodule', 'add', core, 'core');
  git(app, 'commit', '-q', '-m', 'core');
  const web = src('web');
  git(r.root, '-c', 'protocol.file.allow=always', 'submodule', 'add', web, 'web');
  git(r.root, '-c', 'protocol.file.allow=always', 'submodule', 'add', app, 'app');
  git(r.root, 'commit', '-q', '-m', 'submodules');
  git(r.root, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive');
}

test('EC1-mirror — a superproject run gets a MIRROR: per-repo worktrees, the mirror boot arm, a mounts journal, adoption, and a clean drop', async () => {
  const r = repo();
  try {
    makeSuperRepo(r);
    const driver = makeRunner(r, { planScope: () => ['app', 'web'] });
    await driveOn(driver, r, { ...ISOLATED_RUN });
    const state = runStateAfter(r);
    assert.equal(state.checkout, 'worktree');
    assert.ok(state.workRoot, 'the run holds its mirror');
    assert.deepEqual(state.mountedRepos, ['app', 'web', 'app/core'],
      'parents first, then the initialized children of a mounted superproject');

    const request = driver.requests[0]!;
    assert.equal(request.cwd, state.workRoot, 'the session boards INTO the mirror');
    assert.match(request.prompt, /console-built MIRROR/);
    assert.match(request.prompt, /^ {6}app\/$/m);
    assert.match(request.prompt, /^ {6}web\/$/m);
    assert.match(request.prompt, /NOT listed above\s+lives only in the shared root/);
    assert.match(request.prompt, /a plain\s+directory, NOT a repository itself/,
      'a mirror with no ROOT mount still says the mirror directory is not a repo');

    for (const rel of state.mountedRepos as string[]) {
      assert.equal(
        git(join(String(state.workRoot), rel), 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo',
        `${rel} stands on the run branch`,
      );
    }
    assert.equal(git(r.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main',
      'the superproject checkout is never switched');

    const grants = isolationEvents(r)
      .filter((e) => (e.data as Record<string, unknown>).checkout === 'worktree');
    assert.equal(grants.length, 1);
    assert.deepEqual((grants[0]!.data as Record<string, unknown>).mounts, ['app', 'web', 'app/core']);

    // Resume: the standing mirror is ADOPTED — same tree, no new journal line.
    await driveOn(driver, r, { resumeRunId: String(state.id), onlyPhases: [2] });
    const after = runStateAfter(r);
    assert.equal(after.workRoot, state.workRoot);
    assert.deepEqual(after.mountedRepos, ['app', 'web', 'app/core']);
    assert.equal(isolationEvents(r)
      .filter((e) => (e.data as Record<string, unknown>).checkout === 'worktree').length, 1,
    'an unchanged answer is not journalled again');

    // Drop on resume: every mount is released and no repository still holds
    // `pe/demo` in a second tree.
    await driveOn(driver, r, {
      resumeRunId: String(state.id), onlyPhases: [2], isolation: 'queue',
    });
    const dropped = runStateAfter(r);
    assert.equal(dropped.checkout, 'shared');
    assert.equal(dropped.workRoot, undefined);
    assert.equal(dropped.mountedRepos, undefined);
    for (const rel of ['app', 'web', 'app/core']) {
      const list = git(join(r.root, rel), 'worktree', 'list', '--porcelain');
      assert.equal(list.split('\n').filter((l) => l.startsWith('worktree ')).length, 1,
        `${rel} still holds a second checkout`);
    }
  } finally { r.cleanup(); }
});

test('EC1-root — a plan naming the superproject ITSELF mounts the root, and the boot arm says so instead of printing a bare slash', async () => {
  const r = repo();
  try {
    makeSuperRepo(r);
    // The shape that could not have isolation at all before the root mount:
    // one root-meaning token beside the submodule tokens — the ordinary
    // monorepo-of-submodules plan.
    const driver = makeRunner(r, { planScope: () => [basename(r.root), 'app', 'web'] });
    await driveOn(driver, r, { ...ISOLATED_RUN });
    const state = runStateAfter(r);

    assert.equal(state.checkout, 'worktree', 'a root-meaning token no longer refuses the whole run');
    assert.deepEqual(state.mountedRepos, ['', 'app', 'web', 'app/core'],
      'the root mounts FIRST — git refuses to add a worktree over a non-empty directory');
    assert.equal(
      git(String(state.workRoot), 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo',
      'the root mount stands on the run branch like every other mount',
    );
    assert.equal(existsSync(join(String(state.workRoot), 'web', 'web.txt')), true,
      'and the submodule directories a linked worktree leaves EMPTY are real checkouts');
    assert.equal(git(r.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main',
      'the operator\'s own superproject checkout is still never switched');

    const request = driver.requests[0]!;
    assert.match(request.prompt, /a checkout of\s+the superproject itself/);
    assert.match(request.prompt, /^ {6}\.\/ {2}\(the superproject itself\)$/m,
      'the root mount renders as the mirror directory, never as a bare `/`');
    assert.match(request.prompt, /an EMPTY\s+directory, which is what an unmounted submodule looks like/);
  } finally { r.cleanup(); }
});

/* ================================================================== *
 * console-parallel-repaint P1 — the audit's runner-level pins.
 * W1 the lock-aware reclaim · W2 the resume reader's two unwritten arms ·
 * W5 a scope outside the root is an unqualified claim · W6 the fifth door.
 * ================================================================== */

test('P1/W1 — the reclaim leaves a tree a LIVE lock names alone, and the refusal names the holder', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // Clean and on the branch: by every git read, reclaimable. A hand session
    // is working in it right now — its lock says so — and it just committed.
    git(r.root, 'switch', '-q', '-c', 'pe/demo');
    await requestsFor(r, { ...ISOLATED_RUN }, {
      occupiedTrees: () => [{ tree: r.root, by: 'sam@laptop, other-plan phase 3' }],
    });
    assert.equal(git(r.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo', 'moved under a live session');
    assert.equal(journalEvents(r, 'run.isolation-reclaimed').length, 0);
    const state = runStateAfter(r);
    assert.equal(state.checkout, 'refused');
    assert.equal(state.isolationRefusal, 'branch-in-use');
    // "Switch that checkout to another branch" is advice about somebody
    // else's terminal, so the refusal says WHOSE.
    const refused = journalEvents(r, 'run.isolation');
    assert.match(String((refused[0]!.data as Record<string, unknown>).reason ?? ''),
      /held by a live session \(sam@laptop, other-plan phase 3\)/);
  } finally { r.cleanup(); }
});

test('P1/W2 — the resume reader can never RAISE isolation on a run that never had it', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const driver = makeRunner(r);
    await driveOn(driver, r, { onlyPhases: [1], gitMode: 'new-branch' }); // shared, by omission
    assert.equal(driver.requests[0]!.cwd, r.root);

    const before = driver.requests.length;
    await driveOn(driver, r, {
      resumeRunId: String(runStateAfter(r).id), onlyPhases: [2], isolation: 'worktree',
    });
    // One way, downward: phase 1's commits are on the branch in the shared
    // checkout, and a tree minted now would hold none of them.
    assert.equal(driver.requests[before]!.cwd, r.root, 'the resume minted a checkout the run never had');
    const state = runStateAfter(r);
    assert.equal('isolation' in state, false, 'the resume wrote the key');
    assert.notEqual(state.checkout, 'worktree');
    assert.equal(isolationEvents(r).length, 0);
  } finally { r.cleanup(); }
});

test('P1/W2 — giving up the branch on a resume gives up isolation with it', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const driver = makeRunner(r);
    await driveOn(driver, r, { ...ISOLATED_RUN });
    assert.notEqual(driver.requests[0]!.cwd, r.root, 'no run checkout was taken, so this proves nothing');
    assert.equal(runStateAfter(r).isolation, 'worktree');

    const before = driver.requests.length;
    await driveOn(driver, r, {
      resumeRunId: String(runStateAfter(r).id), onlyPhases: [2], gitMode: 'default-branch',
    });
    await pruned(r);
    // The same rule `applySettings` holds: isolation without a branch of the
    // run's own is a setting that reads as configured and does nothing.
    const state = runStateAfter(r);
    assert.equal('gitMode' in state, false);
    assert.equal('isolation' in state, false, 'the checkout request must go with the branch');
    assert.equal(driver.requests[before]!.cwd, r.root, 'a default-branch run has nothing to check out');
  } finally { r.cleanup(); }
});

test('P1/W5 — a scope the run root does not contain makes the claim UNQUALIFIED: no branch, no tree', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const scheduler = new Scheduler({ max: 8 });
    let granted: { branch?: string; tree?: string }[] = [];
    const driver = makeRunner(r, {
      scheduler,
      // A Repos cell naming a repository ELSEWHERE on the machine — a skill
      // checkout under the home directory, driven from a hub. `pe/demo` plus
      // the run root would be an exact claim about a tree nobody edits.
      phaseScope: () => ['elsewhere-repo'],
    }, () => { granted = scheduler.snapshot().grants; });
    await driveOn(driver, r, { onlyPhases: [1], gitMode: 'new-branch' });
    const { env } = driver.requests[0]!;
    assert.equal(env?.PE_SCOPE, 'elsewhere-repo');
    assert.equal(env?.PE_BRANCH, undefined, 'a branch claim about a tree the session never edits');
    assert.equal(env?.PE_WORKTREE, undefined, 'a tree claim about a tree the session never edits');
    assert.equal(granted.length, 1, 'the phase was admitted');
    assert.equal(granted[0]!.branch, undefined, 'admission must weigh the same unqualified claim');
    assert.equal(granted[0]!.tree, undefined);
    scheduler.close();
  } finally { r.cleanup(); }
});

test('P1/W5 — …and a confined scope keeps the exact pair a shared run states', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const scheduler = new Scheduler({ max: 8 });
    let granted: { branch?: string; tree?: string }[] = [];
    const driver = makeRunner(r, {
      scheduler, phaseScope: () => ['all'],
    }, () => { granted = scheduler.snapshot().grants; });
    await driveOn(driver, r, { onlyPhases: [1], gitMode: 'new-branch' });
    const { env, cwd } = driver.requests[0]!;
    assert.equal(env?.PE_BRANCH, 'pe/demo');
    assert.equal(env?.PE_WORKTREE, phys(cwd), 'the shared root is the tree, and it is what keeps two shared runs colliding');
    assert.equal(granted[0]!.branch, 'pe/demo');
    assert.equal(granted[0]!.tree, phys(cwd));
    scheduler.close();
  } finally { r.cleanup(); }
});

test("P1/W6 — a finished detached run's detachAt goes with its tree", async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const driver = makeRunner(r, { detachRequested: () => true });
    await driveOn(driver, r, { ...ISOLATED_RUN });
    await pruned(r);
    assert.equal(journalEvents(r, 'run.isolation-detached').length, 1, 'the run never detached, so this proves nothing');
    const state = runStateAfter(r);
    assert.equal(state.workRoot, undefined, 'the clean tree was pruned');
    // The FIFTH door out of the worktree shape. `branchFor` reads `detachAt`
    // unconditionally, so a decision outliving its tree qualified the next
    // lease refresh and the next session's env with a commit nothing stands at.
    assert.equal(state.detachAt, undefined, 'a detach decision must not outlive the tree it was made for');
  } finally { r.cleanup(); }
});

test("P1/QA-F1 — a tree-less live claim on the plan's scope refuses the reclaim, asked with the PLAN scope", async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    git(r.root, 'switch', '-q', '-c', 'pe/demo');
    const asked: string[][] = [];
    await requestsFor(r, { ...ISOLATED_RUN }, {
      planScope: () => ['all'],
      // A claim that never said where its work rides — the boot prompt's own
      // shape — on an intersecting scope. The Service decides the intersection;
      // the runner's duty is to ASK with the whole plan's scope and to honour
      // the answer before it touches the tree.
      occupiedTrees: (scope: readonly string[]) => {
        asked.push([...scope]);
        return [{ by: 'sam@laptop, other-plan phase 2', owner: 'sam@laptop' }];
      },
    });
    assert.deepEqual(asked, [['all']], 'the reclaim asks once, with the plan scope');
    assert.equal(git(r.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo', 'moved under an unqualified live claim');
    assert.equal(journalEvents(r, 'run.isolation-reclaimed').length, 0);
    assert.equal(runStateAfter(r).isolationRefusal, 'branch-in-use');
  } finally { r.cleanup(); }
});

test("P1/QA-F1 — the run's OWN claim is never a reason to refuse it its checkout", async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    git(r.root, 'switch', '-q', '-c', 'pe/demo');
    let sawOwn = false;
    // Answered at reclaim time — before the run file is on disk — from the
    // live Runner's own state: the claim names THIS run as its owner (the
    // keepalive's `autopilot/<runId>`), which the reclaim must drop.
    let driver: Driver | undefined;
    driver = makeRunner(r, {
      planScope: () => ['all'],
      occupiedTrees: () => {
        const id = driver?.runner.current()?.id;
        assert.ok(id, 'no live run at reclaim time — this would prove nothing');
        sawOwn = true;
        return [{ by: `autopilot/${id}, demo phase 1`, owner: `autopilot/${id}` }];
      },
    });
    await driveOn(driver, r, { ...ISOLATED_RUN });
    assert.ok(sawOwn, 'the reclaim never asked');
    assert.equal(git(r.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', "the run's own claim blocked its own reclaim");
    assert.equal(journalEvents(r, 'run.isolation-reclaimed').length, 1);
    assert.equal(runStateAfter(r).checkout, 'worktree');
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * many-plans-one-repo phase 4 — the decisions that left no trace, and
 * the settle that claimed more than it did.
 * ------------------------------------------------------------------ */

test('S10 — a settle session that ends badly leaves the run PENDING, never "pushed"', async () => {
  // A usage wall, a permission refusal or a crash still leaves `resultText`
  // non-null, and `settleSession` returned it — so the caller answered "the
  // last phase's session was asked to push and open the pull request" and the
  // run FINISHED. The branch was never pushed and nothing anywhere said so.
  const r = repo();
  try {
    makeGitRepo(r);
    const requests: SpawnRequest[] = [];
    const done = join(r.state, 'done');
    // Phases succeed; the SETTLE session hits a wall. Keyed on the settle's own
    // prompt, which is the only thing that tells the two spawns apart.
    const spawn: SpawnFn = async (request) => {
      requests.push(request);
      const phase = /BOOT phase (\d+)/.exec(request.prompt)?.[1];
      if (phase) writeFileSync(done, `${phase}\n`, { flag: 'a' });
      if (!/settles through the MERGE QUEUE/.test(request.prompt)) return outcome();
      return {
        ...outcome(),
        signal: { subtype: 'error_max_turns', code: 1, text: 'usage limit reached' },
        resultText: 'I ran out of turns before pushing anything',
      };
    };
    const runner = new Runner({
      scriptsDir: r.scripts, spawn, verificationText: () => '`true`',
    } as never);
    // `merge-queue` rather than `pr`, because with `openPr` on the LAST phase's
    // own prompt carries the PR block and `prBlockEmitted` closes the settle
    // before a session is ever spent. Both strategies go through the one
    // `settleSession`, which is where the dishonesty was.
    await runner.start({
      slug: 'demo', root: r.root, gitMode: 'new-branch', openPr: false, settle: 'merge-queue',
    } as never);
    await runner.wait();

    const settle = requests.filter((q) => /settles through the MERGE QUEUE/.test(q.prompt));
    assert.equal(settle.length, 1, 'a settle session was spent, or this proves nothing');
    const pending = journalEvents(r, 'run.settle-pending')
      .map((line) => line.data as Record<string, unknown>);
    assert.ok(pending.length > 0, 'a settle that did not end well leaves the branch PENDING');
    assert.ok(
      pending.some((line) => typeof line.reason === 'string' && /ended/.test(String(line.reason))),
      `and it says WHY the session could not settle it: ${JSON.stringify(pending)}`,
    );
    assert.deepEqual(journalEvents(r, 'run.settled'), [],
      'nothing claims the branch was rebased and published');
  } finally { r.cleanup(); }
});

test('BASE-1/S12 — run.isolation names the base the run branch forked from', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // The root stands on ANOTHER plan's branch, which is the ordinary state of
    // the machine this runs on — and what `worktree add -b … HEAD` used to fork
    // from.
    const trunk = git(r.root, 'rev-parse', 'HEAD');
    git(r.root, 'checkout', '-q', '-b', 'pe/other');
    writeFileSync(join(r.root, 'other.txt'), 'other\n');
    git(r.root, 'add', '-A');
    git(r.root, 'commit', '-q', '-m', "another plan's work");

    await requestsFor(r, { ...ISOLATED_RUN });
    const line = isolationEvents(r).at(-1)?.data as Record<string, unknown> | undefined;
    assert.ok(line, 'the isolation decision is journalled');
    assert.equal(line!.base, 'main', 'the base is NAMED, not inferred from HEAD');
    assert.equal(line!.baseSha, trunk);
    assert.equal(git(r.root, 'rev-parse', 'pe/demo'), trunk, 'and the branch really forked there');
  } finally { r.cleanup(); }
});

test('S12 — phase.admitted is journalled even when nothing blocked', async () => {
  // It sat inside `if (blockers.length)`, so the ordinary case — an admission
  // that waited for nothing, which is where the CARVE-OUT does its work — left
  // no record at all.
  const r = repo();
  try {
    makeGitRepo(r);
    // A scheduler, because `admit()` is what journals this and it returns null
    // without one — a harness with no scheduler never admits at all.
    const scheduler = new Scheduler({ max: 8 });
    await driveOn(makeRunner(r, { scheduler }), r, { onlyPhases: [1], gitMode: 'new-branch' });
    scheduler.close();
    const admitted = journalEvents(r, 'phase.admitted')
      .map((entry) => entry.data as Record<string, unknown>);
    assert.equal(admitted.length, 1, 'one admission, one line');
    assert.equal(typeof admitted[0]!.waitedMs, 'number', 'waitedMs: 0 is a fact, not noise');
    assert.equal(admitted[0]!.scope, 'all');
  } finally { r.cleanup(); }
});

test('S11-c — two shared-root new-branch runs serialise, however disjoint their scopes', async () => {
  // Both are told to stand the ONE shared checkout on their own `pe/<slug>`,
  // and git allows a branch one working tree. Disjoint SCOPES do not make two
  // branches fit in one directory, and nothing in the vocabulary said so.
  const r = repo();
  try {
    makeGitRepo(r);
    const scheduler = new Scheduler({ max: 8 });
    let granted: { scope?: readonly string[] }[] = [];
    const driver = makeRunner(r, {
      scheduler, phaseScope: () => ['web'],
    }, () => { granted = scheduler.snapshot().grants; });
    await driveOn(driver, r, { onlyPhases: [1], gitMode: 'new-branch' });
    const claimed = granted[0]?.scope ?? [];
    assert.ok(claimed.includes(SHARED_CHECKOUT_TOKEN),
      `a shared-root new-branch run claims the whole checkout: ${JSON.stringify(claimed)}`);
    // …and the token never reaches the lock file or the session, because it
    // names no repository.
    assert.equal(driver.requests[0]!.env?.PE_SCOPE, 'web');
    scheduler.close();
  } finally { r.cleanup(); }
});

test('S11-c — a run with its own checkout does NOT claim it', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const scheduler = new Scheduler({ max: 8 });
    let granted: { scope?: readonly string[] }[] = [];
    const driver = makeRunner(r, { scheduler }, () => { granted = scheduler.snapshot().grants; });
    await driveOn(driver, r, { ...ISOLATED_RUN, onlyPhases: [1] });
    assert.notEqual(driver.requests[0]!.cwd, r.root, 'no tree was taken, so this proves nothing');
    assert.ok(!(granted[0]?.scope ?? []).includes(SHARED_CHECKOUT_TOKEN),
      'an isolated run makes no claim on the shared checkout');
    scheduler.close();
  } finally { r.cleanup(); }
});

test('S6 — a phase that commits OUTSIDE its Repos cell is journalled', async () => {
  // Nothing detected this at all. The Repos cell is what admission carves on,
  // what the lock records, and what two plans are allowed to run concurrently
  // on the strength of — and it was enforced nowhere.
  const r = repo();
  try {
    makeGitRepo(r);
    // A submodule the phase's scope does NOT name, and a scoped directory it does.
    const web = join(r.root, 'web');
    mkdirSync(web, { recursive: true });
    git(web, 'init', '-q', '-b', 'main');
    writeFileSync(join(web, 'app.ts'), 'export const a = 1;\n');
    git(web, 'add', '-A');
    git(web, 'commit', '-q', '-m', 'web base');
    mkdirSync(join(r.root, 'docs'), { recursive: true });
    writeFileSync(join(r.root, 'docs', 'note.md'), 'scoped\n');
    git(r.root, 'add', '-A');
    git(r.root, 'commit', '-q', '-m', 'docs + gitmodules');
    writeFileSync(join(r.root, '.gitmodules'),
      '[submodule "web"]\n\tpath = web\n\turl = ../web\n');
    git(r.root, 'add', '-A');
    git(r.root, 'commit', '-q', '-m', 'gitmodules');

    // The session commits in `web`, which its scope never named.
    const driver = makeRunner(r, { phaseScope: () => ['docs'] }, (request) => {
      if (!/BOOT phase/.test(request.prompt)) return;
      writeFileSync(join(web, 'app.ts'), 'export const a = 2;\n');
      git(web, 'add', '-A');
      git(web, 'commit', '-q', '-m', 'work the plan never declared');
    });
    await driveOn(driver, r, { onlyPhases: [1] });

    const drift = journalEvents(r, 'phase.scope-drift')
      .map((line) => line.data as Record<string, unknown>);
    assert.equal(drift.length, 1, `exactly the undeclared repository: ${JSON.stringify(drift)}`);
    assert.equal(drift[0]!.repo, 'web');
    assert.equal(drift[0]!.scope, 'docs');
    assert.deepEqual(
      (drift[0]!.commits as { subject: string }[]).map((c) => c.subject),
      ['work the plan never declared'],
    );
  } finally { r.cleanup(); }
});

test('S6 — a phase that stays inside its scope journals nothing', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const web = join(r.root, 'web');
    mkdirSync(web, { recursive: true });
    git(web, 'init', '-q', '-b', 'main');
    writeFileSync(join(web, 'app.ts'), 'export const a = 1;\n');
    git(web, 'add', '-A');
    git(web, 'commit', '-q', '-m', 'web base');
    mkdirSync(join(r.root, 'docs'), { recursive: true });
    writeFileSync(join(r.root, 'docs', 'note.md'), 'scoped\n');
    git(r.root, 'add', '-A');
    git(r.root, 'commit', '-q', '-m', 'docs');
    writeFileSync(join(r.root, '.gitmodules'), '[submodule "web"]\n\tpath = web\n\turl = ../web\n');
    git(r.root, 'add', '-A');
    git(r.root, 'commit', '-q', '-m', 'gitmodules');

    await driveOn(makeRunner(r, { phaseScope: () => ['docs'] }), r, { onlyPhases: [1] });
    assert.deepEqual(journalEvents(r, 'phase.scope-drift'), [],
      'a probe that fires on a clean run is a probe an operator learns to ignore');
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The trace — one id from the drive to every line it causes (phase 5)
 * ------------------------------------------------------------------ */

test('TRC-1 — a drive stamps ONE derived trace on its journal and on what it logs', async () => {
  const r = repo();
  const logFile = join(r.root, 'console.ndjson');
  configureLog(logFile);
  const wasDebug = process.env.PHASE_CONSOLE_DEBUG;
  process.env.PHASE_CONSOLE_DEBUG = '*';
  try {
    makeGitRepo(r);
    await driveOn(makeRunner(r), r, { ...ISOLATED_RUN });

    const runId = String(runStateAfter(r).id);
    const expected = runTraceId(INSTANCE.id, 'demo', runId);

    // 1. Every journal line of the run carries it — not only the ones written
    //    inside a span, because the id belongs to the RUN, not to the writer.
    const dir = runDir(r.root, 'demo');
    const file = readdirSync(dir).find((f) => /^run-.*\.jsonl$/.test(f))!;
    const journal = readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(journal.length > 3, `expected a real journal, got ${journal.length} lines`);
    for (const line of journal) {
      assert.equal(line.traceId, expected, `${String(line.event)} carries another run's trace`);
      assert.equal(line.v, 2);
    }

    // 2. The snapshot line, so a reader with only the journal can find the id
    //    without knowing how it is derived.
    const snapshot = journal.filter((l) => l.event === 'run.trace');
    assert.equal(snapshot.length, 1, 'one run.trace per drive');
    assert.equal((snapshot[0]!.data as Record<string, unknown>).traceId, expected);

    // 3. And the console log written DURING the drive carries the same id,
    //    which is the whole point: one `grep` instead of the six-step walk.
    const logged = readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.traceId === expected);
    assert.ok(logged.length > 0, 'nothing the drive logged joined the run’s trace');
    assert.ok(
      logged.some((l) => String(l.event).startsWith('git.')),
      'the git the drive ran is in it — that is the join that did not exist before',
    );

    // 4. A phase span inside it: the same trace, a different span, and the
    //    phase number on the line.
    const phaseLines = logged.filter((l) => l.phase === 1);
    assert.ok(phaseLines.length > 0, 'no line was written inside the phase span');
    assert.notEqual(phaseLines[0]!.spanId, snapshot[0]!.spanId, 'the phase has a span of its own');
  } finally {
    configureLog(null);
    if (wasDebug === undefined) delete process.env.PHASE_CONSOLE_DEBUG;
    else process.env.PHASE_CONSOLE_DEBUG = wasDebug;
    r.cleanup();
  }
});

test('TRC-2 — a RESUMED drive rejoins the same trace, because it recomputes rather than remembers', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const driver = makeRunner(r);
    await driveOn(driver, r, { ...ISOLATED_RUN });
    const runId = String(runStateAfter(r).id);
    await driveOn(driver, r, { resumeRunId: runId, onlyPhases: [2] });

    const traces = new Set(journalEvents(r, 'run.trace').map((l) => (l.data as Record<string, unknown>).traceId));
    assert.deepEqual([...traces], [runTraceId(INSTANCE.id, 'demo', runId)],
      'two drives of one run are one trace — a minted id would have made them two');
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Phase 7 — a PHASE may ask for a checkout of its own, or decline one.
 * ------------------------------------------------------------------ */

test('P7 — a phase saying `worktree` gets a lane on a plan whose Worktrees directive is off', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const requests = await requestsFor(
      r,
      { onlyPhases: [1], gitMode: 'new-branch' },
      // The plan says nothing at all about worktrees; the PHASE says yes.
      { planIsolation: () => 'worktree' },
    );
    const { cwd } = requests[0]!;
    assert.notEqual(cwd, r.root, 'the phase asked for a lane and did not get one');
    assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo-p1');
  } finally { r.cleanup(); }
});

test('P7 — a phase saying `shared` declines a lane the PLAN turned on', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    const requests = await requestsFor(
      r,
      { onlyPhases: [1], gitMode: 'new-branch' },
      // 🔴 Both ways, and this is the direction that matters: a phase that
      // must see its siblings' work as it lands cannot be given a lane by a
      // plan-wide setting it has explicitly carved itself out of.
      { planWorktrees: () => 'on', planIsolation: () => 'shared' },
    );
    assert.equal(requests[0]!.cwd, r.root, 'the phase declined a lane and was given one anyway');
  } finally { r.cleanup(); }
});

test('P7 — the run branch is cut from the base the PLAN names, and the prompt says which', async () => {
  const r = repo();
  try {
    makeGitRepo(r);
    // A branch the plan names as its base, holding a commit `main` lacks.
    git(r.root, 'branch', 'release/5.1');
    writeFileSync(join(r.root, 'on-main.txt'), 'main moved on\n');
    git(r.root, 'add', '-A');
    git(r.root, 'commit', '-q', '-m', 'a commit only main has');

    const requests = await requestsFor(
      r,
      { onlyPhases: [1], gitMode: 'new-branch' },
      { planWorktrees: () => 'on', planBaseBranch: () => 'release/5.1' },
    );
    const { cwd } = requests[0]!;
    assert.notEqual(cwd, r.root, 'no lane was taken, so this proves nothing');
    // The lane forks from the run branch, which forked from the NAMED base —
    // so main's extra commit must not be in it.
    assert.equal(
      git(cwd, 'rev-list', '--count', 'release/5.1..HEAD'), '0',
      'the run branch was cut from somewhere other than the base the plan named',
    );
  } finally { r.cleanup(); }
});
