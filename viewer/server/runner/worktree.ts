/**
 * Worktree-per-phase — the one module in `viewer/server` allowed to mutate a
 * repository.
 *
 * ## Why this file is special, and why it is only this file
 *
 * The console's standing invariant is that it never publishes and never
 * rewrites a repository: `test/never-push.test.ts` scans every argument list
 * under `viewer/server` and fails on `push`, `merge`, `checkout`, `reset` and
 * their relatives. That gate deliberately left `worktree` off its ban list with
 * a note pointing here — a linked checkout is not a publication — but `merge`
 * was on it, and merge-back is half of what this feature is.
 *
 * So the exemption is a FILE, not a widened list. Everything below runs from
 * `worktree.ts` and nowhere else; the gate now asserts both halves (only this
 * file may use the mutating verbs, and this file may use only these verbs).
 * The remote-talking verbs — `push`, `fetch`, `pull`, `remote`, `clone` — stay
 * banned here exactly as they are banned everywhere else. The console still
 * does not publish; it only builds and folds together trees that it created
 * itself, under its own worktree root (`worktreeHome` below).
 *
 * ## The layout
 *
 *     <home>/<runId>/            `home` is `worktreeHome()`: by default
 *                                `<root>/.worktrees/runs/<slug>` INSIDE the
 *                                instance root, or the older
 *                                `<stateDir>/worktrees` (`worktreeRoot: state`)
 *         integration/     the run branch itself (`pe/<slug>`)
 *         p7/              lane for phase 7, branch `pe/<slug>-p7`
 *         p11/             lane for phase 11, branch `pe/<slug>-p11`
 *
 * The hyphen in a lane branch is not a typo for a slash and it is not
 * cosmetic — `LaneNames.laneBranch` below explains why `pe/<slug>/p7` is a name
 * git cannot hold while `pe/<slug>` exists. This header said the impossible
 * thing for as long as the code did the possible one (D11).
 *
 * Two properties matter and both are deliberate:
 *
 *  - **The operator's own checkout is never touched.** The run branch is
 *    checked out a second time, in `integration/`, and every merge happens
 *    there. A console that merged in the operator's tree would swap files under
 *    whatever they were doing, and would fail outright if that tree were dirty —
 *    which, on the machine that runs this, it usually is.
 *  - **A lane's commits survive every failure.** They live on `pe/<slug>/pN`,
 *    a real branch in the shared object database. A merge conflict aborts and
 *    halts; nothing is deleted, and the branch is still there to be merged by
 *    hand or by the next attempt.
 *
 * ## Why it refuses on a superproject
 *
 * `git worktree add` on a repository with submodules produces a tree whose
 * submodule directories are EMPTY. A phase whose scope names a submodule
 * would then board a session into a directory with nothing in it and work
 * confidently on nothing. There is no cheap honest fix (each submodule would
 * need its own linked worktree and a rewritten `.git` file), so this refuses,
 * says why, and the run carries on sharing the root checkout exactly as it did
 * before the feature existed. Default OFF plus a refusal that names its reason
 * is the whole safety story.
 *
 * ### The refusal was REOPENED, and this is how each finding was answered
 * ### (superseding the phase-14 deferral of 2026-08-27; implemented 2026-08-28)
 *
 * The extension weighed and deferred then — mount the SUB-REPOSITORIES the
 * scope names, rather than the (refused) superproject root — is now the
 * MIRROR (§The mirror, below). The four findings that decided the deferral,
 * and their answers:
 *
 *  1. 🔴 **"A branch name is not a claim until you say which repository it is
 *     in."** Answered by the TREE dimension rather than by repo-qualifying
 *     every branch: `claimsDisjoint` carves only when the branches AND the
 *     working trees both differ, so physical disjointness is proven by paths
 *     — two mirrors are two directories, a mirror and the shared root are two
 *     directories — and equal branch names in unrelated object databases stop
 *     mattering, because equal branch names never carve at all. The radar's
 *     pair keys are repo-qualified besides (`qualifiedRef`), so N repos'
 *     `pe/<slug>`s render as N facts.
 *  2. **"Per-submodule isolation would be invisible to the scheduler."**
 *     Isolation stayed per-RUN: one mirror per run, decided in the drive
 *     preamble, admission presents the run's branch and the mirror's path —
 *     one claim, visible at the moment the scheduler decides.
 *  3. **"The settle cannot finish."** The console still never moves a
 *     superproject's recorded gitlink shas. The one-tree settles
 *     (`integration`, `merge-queue`) refuse a multi-repo run BY NAME
 *     (`run.settle-unsupported`) and the run keeps its branches; `pr` opens
 *     one pull request per mounted repository that has commits.
 *  4. **"The submodules ARE the production repos."** Merges stay human: the
 *     only settle that leaves the machine is `pr`, which pushes a branch and
 *     opens a request for a person — the same one-human-tap deal every push
 *     already has.
 *
 * What still refuses, by name: a scope naming no repository or an
 * uninitialized submodule (`scope-unmapped`, with the
 * `git submodule update --init` hint), and per-LANE worktrees under a
 * superproject — phases share the run's mirror, serialized per scope, exactly
 * as a single-repo run's lanes would share its checkout when lanes are off.
 *
 * ### The ROOT mount (2026-09-05) — why `root-scoped` stopped firing
 *
 * The mirror mounted every repository the scope named EXCEPT the one the run
 * is rooted in, and refused the whole run when a scope token meant that tree
 * (`all`, the root's basename, a plain directory of it). The stated reason was
 * the empty-submodule-directories problem — but the recursive expansion in
 * `resolveMounts` had already been solving exactly that for every non-root
 * superproject a scope names. One rule, two answers.
 *
 * The cost was not theoretical: a monorepo-of-submodules plan whose phases say
 * the root's own name beside a submodule path — the ordinary shape — could not
 * take an isolated checkout at all, and one such token in one phase of twenty-six was
 * enough, because the resolution is plan-wide. So the root mounts, as
 * `rel: ''`, first (`byMountDepth`), with its initialized submodules under it.
 * `root-scoped` is kept as a vocabulary member — journals and run records
 * written before this still name it — and is no longer produced.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { normalizeToken } from '../../shared/scope.js';
import {
  pairKey, qualifiedRef, type RadarState, type IsolationReclaim, type WorktreeRoot,
} from '../../shared/worktree-model.js';

/** How long any one git invocation may take. A wedged merge must end. */
const GIT_TIMEOUT_MS = 120_000;

/**
 * The verbs this module may run are `worktree`, `merge`, `merge-tree`,
 * `rev-parse`, `rev-list`, `diff` and `status` — and that list lives in
 * `test/never-push.test.ts` (`WORKTREE_VERBS`), not here, because a gate whose
 * rules live in the file it is policing is not a gate. Adding an eighth means
 * editing the gate, which is a decision somebody reviews.
 *
 * `merge-tree` is the seventh and it arrived with the monitoring probe at the
 * bottom of this file. It is here rather than in the console-wide read list for
 * one reason: it is the only way to answer *"would these two branches
 * conflict"* without a checkout and a merge somebody then has to abort. With
 * `--write-tree` it merges two commits in memory, writes loose objects only,
 * moves no ref, touches no working tree, and exits 1 with the conflicted paths.
 * Nothing it does is visible to any branch — but it shares a prefix with a verb
 * that very much is, and a gate that let it through on a `startsWith` would be
 * a gate that lets `merge` through. Hence: named in full, in the list.
 *
 * `status` was the sixth, added with `sweepStale`. A sweep decides whether to
 * DELETE a checkout, and the one thing it must never delete is work: `diff`
 * answers for tracked edits and says nothing at all about a file the session
 * created and never added, which is precisely the shape a killed session
 * leaves behind. `status --porcelain` is a read — it is in the console-wide
 * `ALLOWED` list of `never-push.test.ts` already — and it is the only verb
 * that can answer the question the sweep has to ask.
 */
export type GitRun = { ok: boolean; stdout: string; stderr: string };

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<GitRun> {
  return new Promise((done) => {
    execFile('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      // Nothing below parses git's prose, and pinning the locale keeps it that
      // way — the same reasoning as `server/git.ts`.
      //
      // `env` overrides the inherited set entirely, for a caller that must not
      // inherit one: `GIT_DIR` in the console's own environment makes every
      // read below answer about a DIFFERENT repository, and a read a browser
      // can cause (`git-browse.ts`) must not be steerable that way. Absent, the
      // behaviour is exactly what it was.
      env: env ?? { ...process.env, LC_ALL: 'C', NO_COLOR: '1', TERM: 'dumb', GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout, stderr) => {
      done({ ok: !error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * Why worktree mode is not available. `null` means it is.
 *
 * ONE list for two features, on purpose. The per-PHASE lanes
 * (`**Worktrees:** on`) and the per-RUN checkout (`isolation: worktree`) both
 * make the same kind of thing out of the same repository, so an impossibility
 * that stops one stops the other, and a second vocabulary would mean two
 * spellings of *"this repository has submodules"* that could drift. The first
 * four are what `checkAvailable` answers; the last four are decided by the
 * runner's drive preamble, which is the only place that knows about caps, plan
 * scopes, a branch someone else holds, and a setup command that failed.
 */
export type WorktreeRefusal =
  | 'not-a-repo'
  | 'has-submodules'
  | 'no-run-branch'
  | 'not-opted-in'
  | 'scope-outside-root'
  | 'root-scoped'
  | 'scope-unmapped'
  | 'branch-in-use'
  | 'cap-reached'
  | 'setup-failed'
  | 'worktree-failed';

export const REFUSAL_REASON: Readonly<Record<WorktreeRefusal, string>> = Object.freeze({
  'not-a-repo': 'the run root is not a git working tree, so there is nothing to make a worktree of',
  'has-submodules': 'the run root has submodules, and a linked worktree of a superproject has EMPTY '
    + 'submodule directories — a scoped phase would board a session into an empty tree',
  'no-run-branch': 'worktree lanes land on the run branch, so the run must use the new-branch git '
    + 'strategy (Settings > Git strategy)',
  'not-opted-in': "the plan's §Session budget does not say `- **Worktrees:** on`",
  'scope-outside-root': 'a phase of this plan declares a scope that is not inside the run root, so a '
    + 'checkout of the root would not contain the work — the session would edit the shared tree from '
    + 'a worktree that told it otherwise',
  // 🔴 LEGACY, never produced since the root mount (2026-09-05). Kept because
  // journals and run records written before it name this refusal, and a reader
  // that cannot spell a stored word renders a blank where a reason was.
  'root-scoped': 'a phase of this plan declares a scope that means the superproject\'s own tree '
    + '(the root, `all`, or a plain directory of it) — a linked worktree of a superproject has '
    + 'EMPTY submodule directories, so the run keeps the shared checkout',
  'scope-unmapped': 'no scope token of this plan resolves to a git repository under the run '
    + 'root, so there is no sub-repository to mount an isolated checkout of; the detail on the '
    + 'run\'s isolation entry names the token that decided it',
  'branch-in-use': 'the run branch is already checked out in another working tree, and git allows a '
    + 'branch only one — switch that checkout to another branch and the run can have it',
  'cap-reached': 'the console already holds as many managed worktrees as `worktreeMaxConcurrent` '
    + 'allows (Settings > Automation); each one is a full checkout on disk',
  'setup-failed': 'the worktree setup command failed in the fresh tree, so the tree was removed '
    + 'rather than left half-prepared',
  // 🔴 Distinct from `setup-failed`, which used to be its catch-all. git can
  // decline `worktree add` for reasons that have nothing to do with a setup
  // command — a full disk, a permission, a lock — and on a console where no
  // setup command is configured, telling the operator "the setup command
  // failed" names something that does not exist and sends them to a setting
  // they never set. The refusal carries git's own words as its `detail`.
  'worktree-failed': 'git declined to create the worktree; its own message is on the run\'s '
    + 'isolation entry',
});

/**
 * The refusals that say the TREE is unusable, as opposed to the ones that say a
 * run may not TAKE one.
 *
 * 🔴 The distinction decides whether a run already standing on its checkout may
 * keep it. `cap-reached` and `scope-outside-root` are policy about taking a
 * slot, and a run that has already taken one is not asking that question — it
 * keeps its tree and the refusal binds the next run. `has-submodules` and
 * `not-a-repo` are about the checkout itself: a linked worktree of a
 * superproject has EMPTY submodule directories, so keeping a run in one to
 * avoid a degrade would hand its sessions a tree with the work missing.
 * `no-run-branch` is the same class — there is no branch for the tree to stand
 * on. Those degrade, and a degrade releases.
 */
export const UNUSABLE_TREE: ReadonlySet<WorktreeRefusal> = new Set<WorktreeRefusal>([
  'not-a-repo', 'has-submodules', 'no-run-branch',
]);

/** Is this plan opted in? Written as a function so the default is stated once. */
export function optedIn(directive?: 'on' | 'off'): boolean {
  return directive === 'on';
}

/**
 * Can this run use worktree lanes? Every refusal is a named reason, never a
 * silent `false` — the runner journals it and the run continues shared.
 */
export async function checkAvailable(opts: {
  root: string;
  gitMode?: string;
  directive?: 'on' | 'off';
}): Promise<WorktreeRefusal | null> {
  if (!optedIn(opts.directive)) return 'not-opted-in';
  if (opts.gitMode !== 'new-branch') return 'no-run-branch';

  const root = resolve(opts.root);
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') return 'not-a-repo';

  // `.gitmodules` at the top level is the cheap, honest question. A repository
  // that once had submodules and no longer declares them is not a superproject,
  // whatever `.git/modules` still holds.
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).stdout.trim() || root;
  if (existsSync(join(top, '.gitmodules'))) return 'has-submodules';

  return null;
}

/**
 * Is every scope this plan declares actually INSIDE the run root?
 *
 * The question a per-run checkout has to ask and a per-phase lane never did.
 * A lane is taken because two phases of one plan would otherwise fight over one
 * tree; the run checkout exists so a session works somewhere the console
 * controls. Both promises are void the moment a phase's work lives somewhere
 * else: give a run of `hub` its own worktree, and a phase whose Repos cell says
 * `phased-execution` still edits `~/.claude/skills/phased-execution` — the
 * shared tree, from a session whose cwd swore it was isolated. The run would
 * then be admitted alongside another run of the same repository (phase 8's
 * carve-out reads `checkout`), and the two would write the same files.
 *
 * Three tokens are inside, and nothing else is:
 *
 *  - `all` — the fail-safe cell, which means "this repository, all of it". It
 *    cannot name a tree outside the root because it names no tree at all.
 *  - the root's own basename, normalized the way a Repos cell is normalized.
 *    `phased-execution`, `checkout-service`, `monorepo` — the ordinary way a
 *    plan says "the repo I am in".
 *  - an existing path under the root: `packages/cart-api`, `docs`. Existing,
 *    because a token that names nothing on disk is a token this cannot vouch
 *    for, and the safe direction is to refuse.
 *
 * A superproject's submodule paths would pass the third rule — and are refused
 * one step earlier by `has-submodules`, for the harder reason that a linked
 * worktree of a superproject has EMPTY submodule directories.
 */
export function scopeConfined(root: string, scopes: Iterable<string>): boolean {
  const top = realish(resolve(root));
  const own = normalizeToken(basename(top));
  for (const raw of scopes) {
    const token = normalizeToken(raw);
    // An unusable token (punctuation, a stray number) is not a claim about a
    // tree, so it cannot be a claim about a tree outside this one.
    if (!token || token === 'all') continue;
    if (own && token === own) continue;
    // `resolve` collapses `..`; `realish` then follows symlinks, and it has to,
    // because a symlink is the one way a token can name a path that LOOKS
    // inside the root and is not. `docs/vendor -> ~/other-repo` passes both a
    // string prefix test and an existence test while being another repository
    // entirely, which is the exact thing this function exists to catch.
    // Symlinks resolved on BOTH sides, since on macOS the root itself is
    // usually reached through one (`/tmp` → `/private/tmp`).
    const path = realish(resolve(top, token));
    // The trailing separator is what makes the prefix test segment-wise, so
    // `/repo-other` is never read as inside `/repo`.
    if (path !== top && !path.startsWith(top + sep)) return false;
    if (!existsSync(path)) return false;
  }
  return true;
}

/** How long the operator's setup command may take before it is killed. */
export const SETUP_TIMEOUT_MS = 10 * 60_000;

/**
 * Run the operator's `worktreeSetup` command once in a freshly created tree.
 *
 * `sh -c`, because the setting is a command line an operator typed
 * (`npm ci && ln -s …`), not an argv. It runs in the NEW tree and nowhere else,
 * and the caller removes that tree when this fails — a half-prepared checkout
 * is worse than none, because the session boarded into it would fail somewhere
 * far from the cause.
 *
 * Never throws: a setup that cannot even be spawned is a setup that failed, and
 * the caller's answer to both is the same.
 */
export async function runSetup(
  dir: string, command: string, timeoutMs = SETUP_TIMEOUT_MS,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((done) => {
    execFile('sh', ['-c', command], {
      cwd: dir,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', NO_COLOR: '1', TERM: 'dumb', GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout, stderr) => {
      const output = `${String(stdout)}${String(stderr)}`.trim();
      done({
        ok: !error,
        // Bounded: this goes in a journal entry an operator reads in a browser,
        // and `npm ci` alone is thousands of lines.
        output: output.length > 4000 ? `${output.slice(0, 4000)}\n…(truncated)` : output,
      });
    });
  });
}

/**
 * Copy the source checkout's top-level `.env*` files into a new tree.
 *
 * TOP LEVEL only, and only files: a recursive copy of everything matching
 * `.env*` would walk `node_modules`, and the setting exists for the handful of
 * ignored files at a repo root that a build needs. OFF by default in
 * `WORKTREE_DEFAULTS` for the reason the default matters — copying secrets into
 * a second directory is a decision an operator makes, never one they discover.
 *
 * Best effort per file: one unreadable `.env` must not fail a checkout that is
 * otherwise fine, and the count is journalled so the operator can see what
 * happened rather than infer it.
 */
export async function copyEnvFiles(from: string, to: string): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(from, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.startsWith('.env'))
      .map((entry) => entry.name);
  } catch { return []; }

  const copied: string[] = [];
  for (const name of names) {
    try {
      await copyFile(join(from, name), join(to, name));
      copied.push(name);
    } catch { /* one file's permissions must not fail the checkout */ }
  }
  return copied;
}

/**
 * Give a run's own integration tree back, if it holds nothing that is not a commit.
 *
 * `status --porcelain` decides, because commits live on the branch and only
 * UNCOMMITTED work is unrecoverable. A dirty tree is kept and named; the branch
 * is never deleted either way.
 *
 * 🔴 It used to be `pruneRun(…, { phases: [] })`, and that was a catastrophe
 * hiding behind an elegant line. With no phases the lane loop that fills `kept`
 * never runs, so `kept` came back empty however much lane work was on disk —
 * and `pruneRun` then reaches its terminal `rm -rf <stateDir>/worktrees/<runId>`,
 * which deletes every LANE checkout of the run, including one the settle had
 * deliberately kept because it was dirty. Asking a lane-pruning function to
 * prune no lanes does not mean "ignore lanes"; it means "no lane can object".
 *
 * So this asks its own question, and asks about lanes explicitly: a lane merges
 * INTO the integration tree, so removing it while one survives would leave that
 * lane nothing to land on. Nothing here removes a directory that is not the
 * integration tree.
 */
export async function pruneRunTree(
  root: string, opts: LaneHome & { runId: string; slug: string },
): Promise<{ removed: string[]; kept: string[] }> {
  const names = laneNames({ ...opts, phase: 0 });
  const removed: string[] = [];
  const kept: string[] = [];

  const mirror = await mirrorShape(root, names.integration);
  if (mirror) return pruneMirror({ integration: names.integration, mounts: mirror });

  if (!(await isRegistered(root, names.integration))) {
    await git(root, ['worktree', 'prune']);
    return { removed, kept };
  }
  const lanes = await registeredLanes(root, opts, names.integration);
  if (lanes.length || await isDirty(names.integration)) {
    kept.push(names.integration);
    return { removed, kept };
  }
  const out = await git(root, ['worktree', 'remove', '--force', names.integration]);
  if (out.ok) {
    removed.push(names.integration);
    await git(root, ['worktree', 'prune']);
  } else {
    kept.push(names.integration);
  }
  return { removed, kept };
}

/** Every registered worktree of this run that is not its integration tree. */
async function registeredLanes(
  root: string, opts: LaneHome & { runId: string }, integration: string,
): Promise<string[]> {
  const out = await git(root, ['worktree', 'list', '--porcelain']);
  if (!out.ok) return [];
  const base = `${realish(join(laneHome(opts), opts.runId))}/`;
  const skip = realish(integration);
  return out.stdout.split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => realish(line.slice('worktree '.length).trim()))
    .filter((dir) => dir.startsWith(base) && dir !== skip);
}

export type LaneNames = {
  /** `pe/<slug>` — the branch every lane lands on. */
  runBranch: string;
  /**
   * `pe/<slug>-p<N>` — the branch this lane commits to.
   *
   * 🔴 A SIBLING of the run branch, not a child, and the hyphen is load-bearing.
   * `pe/<slug>/p4` is impossible in git while `pe/<slug>` exists: refs are
   * files in a directory tree, so `refs/heads/pe/demo` being a file means
   * `refs/heads/pe/demo/p4` cannot be created — *"cannot lock ref …:
   * 'refs/heads/pe/demo' exists"*. The obvious name is the one name this
   * scheme can never use.
   */
  laneBranch: string;
  /** Absolute path of the lane's checkout. */
  dir: string;
  /** Absolute path of the run branch's own checkout, where merges happen. */
  integration: string;
};

/**
 * Where a run's worktrees live and what its branches are called.
 *
 * A pure function of (home, runId, slug, phase) so tests can assert the
 * layout without creating anything, and so two callers cannot disagree about a
 * path by constructing it twice. The home is `worktreeHome()`'s answer (or the
 * older `stateDir` spelling, folded by `laneHome`).
 */
export function laneNames(opts: LaneHome & { runId: string; slug: string; phase: number }): LaneNames {
  const base = join(laneHome(opts), opts.runId);
  return {
    runBranch: `pe/${opts.slug}`,
    laneBranch: `pe/${opts.slug}-p${opts.phase}`,
    dir: join(base, `p${opts.phase}`),
    integration: join(base, 'integration'),
  };
}

/** The folder under an instance root that holds every tree the console makes there. */
export const WORKTREES_DIR = '.worktrees';

/** `<root>/.worktrees` — one folder, inside the project, for every console-made tree. */
export function worktreesRoot(root: string): string {
  return join(root, WORKTREES_DIR);
}

/**
 * Where a plan's run trees live — the `home` every `laneNames` call takes,
 * holding one `<runId>/` per run.
 *
 * `project` (the default) is `<root>/.worktrees/runs/<slug>`: inside the
 * instance root, beside the work, where a person finds it and where the
 * docs-root walk of every skill script still resolves. `state` is the older
 * `<stateDir>/worktrees` under the console's XDG state directory. Both are
 * derived HERE so a sweep, a prune and a boarding cannot disagree about a
 * path; `RunnerBase.worktreeHomes` asks for both and creates in whichever a
 * run's tree already stands in.
 */
export function worktreeHome(opts: {
  mode: WorktreeRoot; root: string; slug: string; stateDir: string;
}): string {
  return opts.mode === 'state'
    ? join(opts.stateDir, 'worktrees')
    : join(worktreesRoot(opts.root), 'runs', opts.slug);
}

/**
 * Where the console-wide staging checkout (`pe/integration`) lives: under
 * `<root>/.worktrees` for `project`, under the console's runs directory for
 * `state`. `stagingNames()` adds the `staging/` leaf.
 */
export function stagingHome(opts: { mode: WorktreeRoot; root: string; consoleDir: string }): string {
  return opts.mode === 'state' ? opts.consoleDir : worktreesRoot(opts.root);
}

/**
 * Every directory a console-MADE tree may stand under, whichever root is
 * configured — what `checkouts()` decides `managed` against and what the
 * unmanaged sweep leaves alone. `hand/` is deliberately absent: a hand
 * session's lane (`scripts/phase-lane.sh`) lives in the same `.worktrees/`
 * folder but is that session's to remove, so the console reports it once as
 * unmanaged and never touches it.
 */
export function managedRoots(opts: { root: string; consoleDir: string }): string[] {
  return [
    opts.consoleDir,
    join(worktreesRoot(opts.root), 'runs'),
    join(worktreesRoot(opts.root), 'staging'),
  ];
}

/**
 * The two spellings of a home. `home` is any directory holding `<runId>/…`;
 * `stateDir` is the older spelling — the console's per-plan state directory,
 * whose `worktrees/` child is the home. Folded to ONE path here, so every
 * reader of a state-directory tree keeps reading it and no caller builds the
 * path a second way.
 */
export type LaneHome = { home: string } | { stateDir: string };

export function laneHome(opts: LaneHome): string {
  return 'home' in opts ? opts.home : join(opts.stateDir, 'worktrees');
}

export type WorktreeStep = { ok: boolean; detail?: string };

/** Does this ref resolve to a commit here? */
async function refExists(root: string, ref: string): Promise<boolean> {
  const out = await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return out.ok && Boolean(out.stdout.trim());
}

/**
 * A path as git would print it: symlinks resolved where they resolve.
 *
 * 🔴 `resolve()` is not enough, and the difference is not academic. On macOS
 * `/tmp` and `/var/folders` — where the state directory and every test fixture
 * live — are symlinks into `/private`, and `git worktree list` prints the
 * REAL path. Comparing `resolve('/tmp/…')` with git's `/private/tmp/…` says
 * "not registered" about a worktree that plainly is, so every call re-ran
 * `worktree add` and got *"already exists"* — an idempotent function that was
 * idempotent nowhere it actually runs.
 *
 * 🔴 A path that does NOT exist gets the same treatment, resolved through its
 * nearest existing ancestor, and the plain `resolve` fallback this used to have
 * was wrong in exactly the case that matters most. `git worktree list` keeps
 * printing a checkout whose directory has been deleted — it marks it
 * `prunable` — and prints it as `/private/var/…`, while `resolve()` of the
 * vanished path yields `/var/…`. They compare unequal, so `isRegistered` said
 * NO about a registration that is very much still there: `pruneRun` and
 * `sweepStale` both `continue` past such a tree, leaving the stale registration
 * (and its hold on `pe/<slug>`) on the machine for ever, and the next
 * `worktree add` fails on a branch git says is already in use. Walking up to
 * something that exists costs one `realpathSync` on the parent and makes the
 * answer true on both platforms.
 */
/**
 * One directory, or one inside the other — the ground a session's edits land
 * on. Segment-wise, exactly like `claimsDisjoint`'s tree test, so `/w/a-b` is
 * not inside `/w/a`. Both sides must already be `realish`.
 */
function sameGround(a: string, b: string): boolean {
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}

/**
 * A path canonicalised the way `worktree list` prints one — symlinks resolved,
 * and a path that does not exist yet resolved as far up as it does.
 *
 * 🔴 EXPORTED because it is the contract for comparing two directories, not a
 * convenience. `checkouts()` reports what git prints, which is real; a run
 * RECORD stores the path the console constructed, which may not be. On macOS
 * `$TMPDIR` alone is enough to make those two spellings of one directory
 * differ, and a join done with `resolve()` then silently attributes nothing —
 * every lane of every run reads as debris. Both sides of any directory
 * comparison go through this. (`git-browse.ts` §`treeClaims` is the second
 * caller; console-parallel-repaint P8.)
 */
export function realish(path: string): string {
  const full = resolve(path);
  try { return realpathSync(full); } catch { /* not there — walk up */ }
  let head = dirname(full);
  const tail: string[] = [basename(full)];
  // A bounded walk: `dirname('/')` is `/`, which ends it either way.
  while (head !== dirname(head)) {
    try { return join(realpathSync(head), ...tail.reverse()); } catch { /* keep going */ }
    tail.push(basename(head));
    head = dirname(head);
  }
  return full;
}

/**
 * The commit `ref` resolves to in `repo`, or an empty string when it does not.
 *
 * Exported so callers outside this module never grow a git runner of their
 * own: `never-push.test.ts` polices the argument lists under `server/`, and one
 * more file that shells git is one more surface for that gate to have to
 * reason about. `refExists` stays private because it is this module's own
 * question; this is the answer other modules actually need — an existence
 * check AND the sha, from one read.
 */
export async function commitOf(repo: string, ref: string): Promise<string> {
  const out = await git(repo, ['rev-parse', '--verify', '--quiet', ref]);
  return out.ok ? out.stdout.trim() : '';
}

/** Is `dir` already registered as a worktree of this repository? */
export async function isRegistered(root: string, dir: string): Promise<boolean> {
  const out = await git(root, ['worktree', 'list', '--porcelain']);
  if (!out.ok) return false;
  const target = realish(dir);
  return out.stdout.split('\n')
    .filter((line) => line.startsWith('worktree '))
    .some((line) => realish(line.slice('worktree '.length).trim()) === target);
}

/**
 * Which branch is the worktree registered at `dir` standing on?
 *
 * `undefined` for a directory that is not a registered worktree, and for one on
 * a detached HEAD — which is not a branch, and saying so is the point.
 */
export async function branchAt(root: string, dir: string): Promise<string | undefined> {
  const out = await git(root, ['worktree', 'list', '--porcelain']);
  if (!out.ok) return undefined;
  const target = realish(dir);
  let here = false;
  for (const raw of out.stdout.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('worktree ')) {
      if (here) return undefined; // the entry ended without a `branch` line
      here = realish(line.slice('worktree '.length).trim()) === target;
    } else if (here && line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    }
  }
  return undefined;
}

/**
 * Is `dir` registered as a worktree of this repository AND standing on `branch`?
 *
 * 🔴 Registration alone is not the question a caller adopting a tree has.
 * `isRegistered` answers *"is there a checkout here"*, and a tree an operator
 * switched to another branch answers YES to that — so a run that adopted on
 * registration alone kept `checkout: 'worktree'` and handed its sessions
 * `PE_BRANCH=pe/<slug>`, the carve-out phase 8 admits on, for a tree standing
 * somewhere else entirely.
 */
export async function holdsBranch(root: string, dir: string, branch: string): Promise<boolean> {
  return (await branchAt(root, dir)) === branch;
}

/**
 * The run branch, checked out a second time under the state directory.
 *
 * Idempotent: called once per lane, and the second call finds the directory
 * already registered and returns. The branch is created from the CURRENT HEAD
 * when it does not exist, which is the same rule the boot prompt gives a
 * session ("check it out, otherwise create it from the default branch") — with
 * the difference that here it is created without ever moving the operator's own
 * HEAD.
 */
export async function ensureIntegration(
  root: string, names: LaneNames,
): Promise<WorktreeStep & { created?: boolean }> {
  return ensureCheckout(root, { dir: names.integration, branch: names.runBranch });
}

/**
 * The same tree, DETACHED at a commit instead of standing on a branch.
 *
 * For a run whose `pe/<slug>` has been merged and deleted and which still has
 * phases to drive: the code is right, the ref is gone, and re-creating the
 * branch would re-open work the merge closed. It owns no ref, so GIT lets it
 * stand beside whoever holds the branch and beside any number of other
 * detached trees. The LOCK story is on `CheckoutAt` below: the claim is
 * `detached@<sha12>` plus the tree's own path, so it contends with nobody
 * holding a real ref and with another detached claim only on the SAME tree —
 * and the next run of the same plan is refused by `sameUnitOfWork` before any
 * carve is asked.
 */
export async function ensureDetachedIntegration(
  root: string, dir: string, sha: string,
): Promise<WorktreeStep & { created?: boolean }> {
  return ensureCheckout(root, { dir, detachAt: sha });
}

/**
 * The body of `ensureIntegration`, parameterised by (directory, branch).
 *
 * Extracted in P12 rather than copied, because the settle strategies need a
 * SECOND managed checkout — the console-wide staging tree on `pe/integration`
 * — and every red-flagged lesson below was learned the expensive way exactly
 * once. A second copy of this function is a second place for a prunable
 * registration, an adopted tree standing on the wrong branch, or a throw that
 * escapes the refusal story to come back.
 */
export type CheckoutAt =
  /** A checkout that OWNS a branch — git allows it exactly one working tree. */
  | { dir: string; branch: string }
  /**
   * A checkout DETACHED at a commit, owning no branch at all.
   *
     * The third shape, and it exists for one situation the first two cannot
   * describe: a run whose `pe/<slug>` has been merged and deleted still has
   * phases to drive. There is no branch left to stand on, and minting one
   * would re-open work the merge just closed. A detached tree at the default
   * branch's head is a real checkout of the right code that claims no ref, so
   * GIT lets any number of them exist beside each other and beside whoever
   * holds the branch — which is exactly what "two plans on one repository"
   * needs.
   *
   * ⚠️ **The LOCK is a narrower story, and the two must not be confused.** A
   * detached claim is qualified `detached@<sha12>` (`worktree-model.js`
   * §`detachedRef`) beside the tree's own path. It contends with nobody holding
   * a real ref, and two detached claims contend only when they name the SAME
   * working tree (or one inside the other): the branch string names no ref, so
   * two trees detached at one commit — the common case, since both resolve the
   * same trunk — have nowhere for their commits to collide, and the tree
   * dimension alone decides them (`claimsDisjoint`; P6 serialised this pair as
   * an accepted tradeoff, console-parallel-repaint P1 re-priced it). What
   * still serialises two detached runs is one tree, or two runs of ONE plan
   * (`sameUnitOfWork`).
   *
   * Its adoption test is the mirror image of the branch shape's: a detached
   * HEAD is the EXPECTED state here, and the question is whether it sits at
   * the commit asked for.
   */
  | { dir: string; detachAt: string };

/**
 * Keep a console-made tree under `<root>/.worktrees` out of the root's own
 * `git status`.
 *
 * `.git/info/exclude`, never a tracked `.gitignore`: it is the ONE file git
 * gives a tool for ignore rules it did not commit, it is per clone (exactly the
 * scope of a linked worktree), and the console never commits. The repository
 * asked is the one whose working tree the folder sits in — for a mirror that
 * is the SUPERPROJECT, whose submodules' trees are what the folder holds.
 * Best effort and silent: a root that is not a repository, or an unwritable
 * git directory, costs a dirty `git status` and nothing else — the tree
 * itself is unaffected, and a line already present is never written twice.
 */
const excludedRoots = new Set<string>();

async function ensureExcluded(docsRoot: string): Promise<void> {
  // Once per root per process: every resume and every mirror mount comes
  // through here, and the answer does not change under a running console.
  if (excludedRoots.has(docsRoot)) return;
  try {
    const out = await git(docsRoot, ['rev-parse', '--git-path', 'info/exclude']);
    const spelled = out.ok ? out.stdout.trim() : '';
    if (!spelled) return;
    const file = isAbsolute(spelled) ? spelled : join(docsRoot, spelled);
    const line = `/${WORKTREES_DIR}/`;
    let body = '';
    try { body = await readFile(file, 'utf8'); } catch { body = ''; }
    if (body.split('\n').some((entry) => entry.trim() === line)) { excludedRoots.add(docsRoot); return; }
    await mkdir(dirname(file), { recursive: true });
    const glue = body && !body.endsWith('\n') ? '\n' : '';
    await writeFile(file, `${body}${glue}${line}\n`);
    excludedRoots.add(docsRoot);
  } catch {
    // Best effort, by design (see above).
  }
}

async function ensureCheckout(
  root: string, at: CheckoutAt,
): Promise<WorktreeStep & { created?: boolean }> {
  // Both halves read ONCE, here, from the discriminant — rather than asking
  // `'branch' in at` at each site. Exactly one of them is defined, and every
  // branch below is written against that pair, so the two shapes cannot drift
  // apart in the middle of a function this long.
  const wanted = 'branch' in at ? at.branch : undefined;
  const detachAt = 'branch' in at ? undefined : at.detachAt;
  const names = { integration: at.dir, runBranch: wanted ?? '' };
  // A tree placed INSIDE an instance root must not turn that root's own
  // `git status` red: the root is the prefix before `/.worktrees/`, and its
  // exclude file gets the folder once. Every shape — single tree, lane,
  // mirror mount, staging — comes through here, so this is the one site.
  // The NEAREST `.worktrees` above the tree names the root — an instance root
  // may itself stand inside somebody's `.worktrees/` (a hand lane, a mirror
  // mount), and the console never nests a second one below a root's own.
  const marker = `${sep}${WORKTREES_DIR}${sep}`;
  const cut = at.dir.lastIndexOf(marker);
  if (cut > 0) await ensureExcluded(at.dir.slice(0, cut));
  // `created` distinguishes "I made this tree just now" from "it was already
  // here", and both callers need the difference. A run-level preamble runs
  // again on every resume, and it must run its setup command — and, on a
  // failure, FORCE-REMOVE the tree — only for a tree it minted itself. Doing
  // either to an adopted tree would re-run `npm ci` over somebody's work, or
  // delete it.
  //
  // 🔴 REGISTERED IS NOT ENOUGH — the directory has to be there. `git worktree
  // list` keeps printing a registration whose directory an operator deleted
  // (git calls it *prunable*), so `isRegistered` alone said "adopt this" about
  // nothing at all: the caller then set `workRoot` to a path that does not
  // exist and spawned its sessions into it. Same failure shape as a refusal
  // that forgets to clear `workRoot`, reached from the other side. `prune`
  // drops exactly these stale registrations, and then the code below builds the
  // tree properly and reports `created: true` — so the setup command runs for
  // it, which is right, because it IS a new tree.
  if (await isRegistered(root, names.integration)) {
    if (existsSync(names.integration)) {
      // 🔴 …and standing on the RIGHT branch. Adopting on registration alone
      // handed a session `PE_BRANCH=pe/<slug>` — the carve-out phase 8 admits
      // on — for a tree an operator had switched to something else. The
      // console will not switch it back: that was a deliberate act by a person
      // and the tree may hold their uncommitted work. It says which branch it
      // found instead, which is the one fact that makes the situation fixable.
      const on = await branchAt(root, names.integration);
      if (!wanted) {
        // The DETACHED shape. `branchAt` returning undefined is what this one
        // wants — the refusal above is inverted here, and deliberately: a tree
        // standing on a BRANCH is the wrong state for a checkout that must own
        // none. The commit is then asked for directly, because a detached tree
        // left at last week's head is a session compiling last week's code.
        if (on) {
          return {
            ok: false,
            detail: `the console's own worktree at ${names.integration} is standing on `
              + `\`${on}\`, and this run needs it detached — switch it off that branch `
              + 'or remove it, and the run can have its checkout',
          };
        }
        const head = await git(names.integration, ['rev-parse', '--verify', '--quiet', 'HEAD']);
        const at = head.stdout.trim();
        if (at === detachAt) return { ok: true, created: false };
        // 🔴 At the wrong commit, and this is where the first cut DESTROYED
        // WORK. It read "the tree is ours, a rebuild is cheap" and ran
        // `worktree remove --force`, which deletes a dirty tree without
        // asking — and this branch is reached on every drive whose trunk has
        // simply MOVED, so a session's uncommitted edits, its untracked files
        // and even its commits went with it. Twice reproduced. The branch
        // shape above refuses in the identical situation, and this one must
        // hold the same line: NOTHING here removes a tree.
        //
        // A detached tree is moved, not rebuilt. `switch --detach` costs one
        // ref update and keeps the directory — but only when moving it loses
        // nothing, which is two questions, asked in the order that a "no"
        // costs least:
        const status = await git(names.integration, ['status', '--porcelain', '--untracked-files=normal']);
        const dirty = status.stdout.split('\n').map((line) => line.slice(3).trim()).filter(Boolean);
        if (!status.ok || dirty.length) {
          return {
            ok: false,
            detail: `the console's own worktree at ${names.integration} holds uncommitted work `
              + `(${dirty.slice(0, DIRTY_PATH_CAP).join(', ') || 'git could not read its status'}) `
              + `and stands at ${at.slice(0, 12) || 'an unknown commit'}, not `
              + `${detachAt!.slice(0, 12)} — commit or clear it and the run can have its checkout`,
          };
        }
        // …and the commit it stands at must be reachable from somewhere else,
        // or moving away leaves it in the reflog and nowhere a person looks.
        // `for-each-ref --contains` is the read that answers it without the
        // `branch` verb, whose exemption here is the DELETE form alone.
        const held = await git(root, ['for-each-ref', '--contains', at, '--format=%(refname:short)', 'refs/heads/']);
        if (at && !held.stdout.trim()) {
          return {
            ok: false,
            detail: `the console's own worktree at ${names.integration} stands at ${at.slice(0, 12)}, `
              + 'which is on no branch — moving it would leave those commits reachable from nothing. '
              + 'Give them a branch, or remove the tree, and the run can have its checkout',
          };
        }
        const moved = await git(names.integration, ['switch', '--detach', detachAt!]);
        if (!moved.ok) {
          return { ok: false, detail: firstLine(moved.stderr) || 'git could not move the detached checkout' };
        }
        // Adopted, not created: the tree is the same directory it was, so the
        // setup command must NOT run again over a checkout already prepared.
        return { ok: true, created: false };
      } else {
        if (on === names.runBranch) return { ok: true, created: false };
        return {
          ok: false,
          detail: `the console's own worktree at ${names.integration} is standing on `
            + `${on ? `\`${on}\`` : 'a detached HEAD'}, not \`${names.runBranch}\` — switch it back `
            + 'or remove it, and the run can have its checkout',
        };
      }
    } else {
      await git(root, ['worktree', 'prune']);
    }
  }

  // 🔴 The run branch may already be checked out — most likely in the
  // operator's OWN tree, because the console's new-branch strategy tells
  // sessions to check it out there. git refuses a second checkout of one
  // branch, and it is right to: two trees on one branch is how a commit made
  // in the wrong window disappears. Say so in words an operator can act on
  // rather than passing git's `is already used by worktree at …` up as-is,
  // which reads like a bug in the console.
  // Asked only of the shape that OWNS a branch. A detached checkout takes no
  // ref at all, which is the whole reason it exists: any number of them may
  // stand beside each other and beside whoever holds the branch.
  const held = wanted ? await checkedOutIn(root, names.runBranch) : undefined;
  if (held && realish(held) !== realish(names.integration)) {
    return {
      ok: false,
      detail: `${names.runBranch} is already checked out at ${held}, and git allows a branch only `
        + 'one working tree. Switch that checkout to another branch (or turn Worktrees off for this '
        + 'plan) and the lanes can have it.',
    };
  }

  // After the guard, not before: a refusal must leave nothing behind at all.
  //
  // 🔴 And it THROWS, which is the one thing this function may not do. An
  // unwritable state directory — a permission, a full disk, a read-only mount —
  // raised straight out through `ensureRunCheckout`, past every refusal in it,
  // so the whole "every impossibility degrades to the shared checkout with a
  // named reason" story ended in a rejected promise instead. A caller that
  // handles eight refusals by name and then dies on the ninth has handled none.
  try {
    await mkdir(dirname(names.integration), { recursive: true });
  } catch (error) {
    return {
      ok: false,
      detail: (error as Error)?.message ?? 'could not create the worktree directory',
    };
  }

  const exists = wanted ? await refExists(root, names.runBranch) : false;
  const args = !wanted
    ? ['worktree', 'add', '--detach', names.integration, detachAt!]
    : exists
      ? ['worktree', 'add', names.integration, names.runBranch]
      : ['worktree', 'add', '-b', names.runBranch, names.integration, 'HEAD'];
  const out = await git(root, args);
  if (out.ok) return { ok: true, created: true };
  return { ok: false, detail: firstLine(out.stderr) || 'git worktree add failed' };
}

/**
 * Is `dir` this repository's registered worktree, standing on NO branch?
 *
 * The detached shape's answer to `holdsBranch`, and the run preamble needs it
 * for the same reason the mirror needed `validateMirror`: `holdsBranch` can
 * never be true of a detached tree, so a preamble asking only that question
 * concluded on EVERY drive that the run held nothing and fell through to the
 * build. That is how a moving trunk came to delete a session's work.
 */
export async function holdsDetached(root: string, dir: string): Promise<boolean> {
  if (!(await isRegistered(root, dir))) return false;
  return (await branchAt(root, dir)) === undefined;
}

/**
 * Delete a tree this process created moments ago, whatever is in it.
 *
 * The ONE place `--force` is used without asking whether the tree holds work,
 * and the caller's obligation is the whole justification: it may be called only
 * for a tree `ensureIntegration` reported `created: true` for, in the same
 * breath, before any session has been anywhere near it.
 *
 * `pruneRunTree` is the wrong tool here and the difference cost a wedge. It
 * refuses a DIRTY tree — rightly, since uncommitted work is unrecoverable — and
 * a setup command that fails is precisely what leaves files behind (`npm ci`
 * dying halfway is a `node_modules` and a lockfile). So the refusal fired every
 * time, the half-prepared tree stayed registered holding `pe/<slug>`, nothing
 * pointed at it, `sweepStale` kept it forever because it was dirty, and every
 * later run of that plan refused `branch-in-use`. The branch is never deleted.
 */
export async function discardFreshTree(
  root: string, names: LaneNames,
): Promise<{ removed: boolean; detail?: string }> {
  return discardFreshDir(root, names.integration);
}

/** The body, by directory — the mirror discards per-mount fresh trees the same way. */
async function discardFreshDir(
  root: string, dir: string,
): Promise<{ removed: boolean; detail?: string }> {
  if (!(await isRegistered(root, dir))) return { removed: true };
  const out = await git(root, ['worktree', 'remove', '--force', dir]);
  if (!out.ok) return { removed: false, detail: firstLine(out.stderr) || 'git worktree remove failed' };
  await git(root, ['worktree', 'prune']);
  return { removed: true };
}

/**
 * Where `branch` is checked out, when that is NOT this root's own checkout.
 *
 * 🔴 ASKED, never remembered. The first attempt at this recorded the holder on
 * `RunState` when a release could not remove a tree — and a fact about the
 * filesystem stored on a run goes stale in both directions. It went stale the
 * moment the operator did what the prompt asked and removed the tree (every
 * later phase was still told the branch was held, and told to commit
 * somewhere else); and it was never set at all for the case that matters most,
 * a NEW run of the same plan meeting the previous run's kept tree, because that
 * run never held anything. One git question at the moment the prompt is written
 * has neither failure, and `git worktree list` is cheap.
 */
export async function heldElsewhere(root: string, branch: string): Promise<string | undefined> {
  const at = await checkedOutIn(root, branch);
  return at && realish(at) !== realish(root) ? at : undefined;
}

/** The answer `GET /api/plans/<slug>/isolation-preflight` renders. */
export type IsolationPreview = {
  available: boolean;
  kind?: 'checkout' | 'mirror';
  refusal?: string;
  detail?: string;
  mounts?: string[];
  skipped?: string[];
  multiRepo: boolean;
  /**
   * Checkouts the launch would SWITCH off the run branch to free it.
   *
   * The one thing this preflight promises that is not merely a read: an
   * operator ticking the box deserves to know that their own terminal's
   * checkout is about to move. Asked through `reclaimBranch`'s own
   * preconditions with `dryRun`, so the preview and the decide cannot drift.
   */
  reclaims?: string[];
};

/**
 * What "Give this run its own checkout" would DO at `root` for `slug`,
 * without doing any of it — the same reads the real decide makes, in the same
 * order, `branch-in-use` included. The live incident that forced the branch
 * probe: this answer said "mirror, three mounts" while every actual decide
 * refused `branch-in-use`, because the shared checkouts sat on the run
 * branch — the exact tickable-but-guaranteed-refused dishonesty the preflight
 * exists to end. Moment-in-time, like any preflight: a branch freed or taken
 * between this answer and the launch is the decide's call.
 */
export async function previewIsolation(
  root: string, slug: string, scopes: Set<string>,
  /** `never` turns the reclaim off, exactly as the pref does at launch. */
  reclaim: IsolationReclaim = 'clean-only',
  /**
   * The live claims (`reclaimBranch` precondition 4) — the SAME list the decide
   * will be handed, for this plan's scope, so the preview cannot promise a
   * reclaim the launch would refuse.
   */
  occupied: Iterable<OccupiedTree> = [],
): Promise<IsolationPreview> {
  const multiRepo = existsSync(join(root, '.gitmodules'));
  const refusal = await checkAvailable({ root, gitMode: 'new-branch', directive: 'on' });
  if (refusal && refusal !== 'has-submodules') {
    return { available: false, refusal, detail: REFUSAL_REASON[refusal], multiRepo };
  }
  if (!scopeConfined(root, scopes)) {
    return {
      available: false, refusal: 'scope-outside-root',
      detail: REFUSAL_REASON['scope-outside-root'], multiRepo,
    };
  }
  const runBranch = `pe/${slug}`;
  if (!refusal) {
    const held = await checkedOutIn(root, runBranch);
    if (held) {
      const would = reclaim === 'never' ? null : await reclaimBranch({
        root, held, branch: runBranch, allowed: [root], occupied, dryRun: true,
      });
      if (would?.kind === 'reclaimed') {
        return { available: true, kind: 'checkout', multiRepo, reclaims: [would.tree] };
      }
      return {
        available: false, kind: 'checkout', refusal: 'branch-in-use',
        detail: `${runBranch} is already checked out at ${held}`
          + `${would?.kind === 'dirty' ? ` and it holds uncommitted work (${would.paths.join(', ')})` : ''}`
          + `${would?.kind === 'held' ? ` and a live session holds it (${would.by})` : ''}`
          + ', and git allows a branch only one '
          + 'working tree. Switch that checkout to another branch and the run can have its own.',
        multiRepo,
      };
    }
    return { available: true, kind: 'checkout', multiRepo };
  }
  const resolved = await resolveMounts(root, scopes);
  if (!resolved.ok) {
    return { available: false, refusal: resolved.refusal, detail: resolved.detail, multiRepo };
  }
  const conflicts: string[] = [];
  const reclaims: string[] = [];
  for (const mount of resolved.mounts) {
    const held = await checkedOutIn(mount.source, runBranch);
    if (!held) continue;
    const would = reclaim === 'never' ? null : await reclaimBranch({
      root: mount.source, held, branch: runBranch, allowed: [mount.source], occupied, dryRun: true,
    });
    if (would?.kind === 'reclaimed') { reclaims.push(would.tree); continue; }
    conflicts.push(`${mount.rel}: ${runBranch} is already checked out at ${held}`
      + (would?.kind === 'dirty' ? ` and it holds uncommitted work (${would.paths.join(', ')})` : '')
      + (would?.kind === 'held' ? ` and a live session holds it (${would.by})` : ''));
  }
  const shape = {
    multiRepo,
    mounts: resolved.mounts.map((mount) => mount.rel),
    ...(resolved.skipped.length ? { skipped: resolved.skipped } : {}),
    ...(reclaims.length ? { reclaims } : {}),
  };
  if (conflicts.length) {
    return {
      available: false, kind: 'mirror', refusal: 'branch-in-use',
      detail: `${conflicts.join('; ')} — git allows a branch only one working tree; switch `
        + `${conflicts.length === 1 ? 'that checkout' : 'those checkouts'} to another branch and `
        + `the mirror can mount ${conflicts.length === 1 ? 'it' : 'them'}.`,
      ...shape,
    };
  }
  return { available: true, kind: 'mirror', ...shape };
}

/** Which working tree has `branch` checked out, if any — this root's own included. */
export async function checkedOutIn(root: string, branch: string): Promise<string | undefined> {
  const out = await git(root, ['worktree', 'list', '--porcelain']);
  if (!out.ok) return undefined;
  let dir: string | undefined;
  for (const line of out.stdout.split('\n')) {
    if (line.startsWith('worktree ')) dir = line.slice('worktree '.length).trim();
    else if (line.trim() === `branch refs/heads/${branch}`) return dir;
  }
  return undefined;
}

/**
 * The branch this repository considers its trunk.
 *
 * `refs/remotes/origin/HEAD` first, because it is what the repository itself
 * says rather than what this file guesses — a fork whose trunk is `develop`,
 * or a repo renamed years ago, answers correctly and no list of names could.
 * It is a symbolic ref, so reading it moves nothing; the verb is in
 * `WORKTREE_VERBS` for the read alone.
 *
 * 🔴 The fallbacks are asked as REFS, not assumed. `main` then `master`, each
 * checked with `rev-parse --verify`, and `undefined` when neither exists —
 * because every caller of this function is about to move a working tree onto
 * the answer, and a name that resolves to nothing would turn a reclaim into a
 * `git switch` failure at the worst possible moment (a run's preamble, with
 * the tree half-considered). A repository with no trunk this can name simply
 * does not get reclaimed, which is the honest ending.
 *
 * `origin/HEAD` is itself often absent — it is set by `clone` and by
 * `remote set-head`, and a repository built any other way never has one. That
 * is not an error and is not journalled: it is the ordinary case the fallbacks
 * exist for.
 */
export async function defaultBranchOf(repo: string): Promise<string | undefined> {
  const head = await git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (head.ok) {
    const name = head.stdout.trim().replace(/^origin\//, '');
    if (name && await refExists(repo, name)) return name;
  }
  for (const name of ['main', 'master']) {
    if (await refExists(repo, name)) return name;
  }
  return undefined;
}

/**
 * A LIVE claim the reclaim must not move under — an unexpired lock whose
 * session has not ended, from any plan — with who holds it, for the sentence.
 * The reclaim's fourth precondition (see `reclaimBranch`). Built by the Service
 * from the same lock table the scheduler admits against
 * (`RunnerDeps.occupiedTrees`); this module reads no lock file itself.
 *
 * `tree` is the lock's `worktree=` line when it wrote one — a named place,
 * compared by path. 🔴 ABSENT means the claim never said where its work rides,
 * and the answer is the same one `claimsDisjoint` gives an unqualified claim:
 * it may be riding ANY tree of the repository its scope names, so it holds
 * every tree the caller may move. The designed hand flow writes exactly such
 * a lock (the boot prompt's `claim … --scope … --git` derives no `--here`),
 * and reading it as "occupies nothing" moved that session's clean root — QA
 * round 1's F1 on console-parallel-repaint P1. The Service includes a
 * tree-less lock only when its scope intersects the asking run's, so a claim
 * on an unrelated repository blocks nothing.
 *
 * `owner` lets a runner drop its OWN claims (`autopilot/<runId>`): a run's own
 * lock is never a reason to refuse that run its checkout.
 */
export type OccupiedTree = { tree?: string; by: string; owner?: string };

/** What a reclaim did, or why it did nothing. */
export type Reclaim =
  /** The tree was switched off the run branch, which is now free. */
  | { kind: 'reclaimed'; tree: string; from: string; to: string }
  /** It holds work. NOT touched — the caller refuses `branch-in-use` with these paths. */
  | { kind: 'dirty'; tree: string; paths: string[] }
  /** Not a tree this console may move: somebody else's checkout, or a managed lane. */
  | { kind: 'foreign'; tree: string }
  /**
   * A LIVE lock names this tree: a session is working in it right now, however
   * clean it happens to read at this instant. NOT touched — the caller refuses
   * `branch-in-use` naming the holder.
   */
  | { kind: 'held'; tree: string; by: string }
  /** Nothing to do, or nothing safe to do. The reason is for the journal, not the operator. */
  | { kind: 'skipped'; reason: string };

/** How many dirty paths are worth naming before the list stops being a list. */
const DIRTY_PATH_CAP = 10;

/**
 * How many changed paths the ignored-file probe will ask about.
 *
 * A bound, not a rule: the probe asks git which of the paths a switch would
 * touch are IGNORED here, and a branch pair with ten thousand changed files
 * would otherwise build an argv git refuses. Past the cap the reclaim proceeds
 * — a run branch that far from the trunk is not the shape this protects.
 */
const IGNORED_PROBE_CAP = 200;

/**
 * Take the run branch back from a CLEAN checkout that is sitting on it.
 *
 * The wedge this ends: the console's new-branch strategy tells sessions to
 * check `pe/<slug>` out, so the operator's own root ends up standing on it —
 * and then every later run of that plan meets `branch-in-use` and silently
 * degrades to sharing that same checkout, forever, until a person switches it
 * back by hand. Nobody ever did, because nothing said so. A tree with nothing
 * in it to lose can simply be moved aside, and that is what this does.
 *
 * FOUR preconditions, and every one of them is about not destroying work:
 *
 *  1. **`allowed` names the tree.** The caller passes the trees this console is
 *     entitled to move — the run's own root and, for a mirror, each mount
 *     source. A checkout that is not on that list is somebody else's: another
 *     console's managed lane, a second clone, a person's scratch tree. Moving
 *     one would be the console reaching outside the run it is driving, and the
 *     `foreign` answer exists so the caller can say so rather than guess.
 *     Compared through `realish`, like every other path question here, because
 *     `/tmp` is `/private/tmp` to git and to nobody else.
 *  2. **`status --porcelain` is EMPTY.** Not `diff` — `diff` cannot see the
 *     file a session created and never added, which is exactly what a killed
 *     session leaves behind. Untracked counts as work.
 *  3. **HEAD is the branch's own tip.** A clean tree can still be detached at
 *     a commit that is not on any ref, and switching away from that loses it
 *     with nothing but the reflog to say so. `branchAt` says which branch the
 *     tree stands on; this asks the second half — that standing on it means
 *     HEAD and `refs/heads/<branch>` are the same commit — so `git switch`
 *     genuinely leaves nothing behind.
 *
 *  4. **No LIVE LOCK names the tree.** `occupied` is every unexpired claim's
 *     `worktree=` line whose session has not ended, across every plan — the
 *     same table the scheduler admits against, handed in by the caller
 *     (`RunnerDeps.occupiedTrees`) the way `sweepStale` is handed its pid
 *     probe, so this module reads no lock file and the preflight
 *     (`previewIsolation`) and the decide answer from ONE list. A tree a live
 *     claim names is a tree a session is working in RIGHT NOW, however clean
 *     it reads at this instant — it just committed, it is between two edits —
 *     and moving it puts that session's next commit on the operator's trunk.
 *     Until console-parallel-repaint P1 (QA round 1's F9) dirtiness was the
 *     only guard, which protected a live session's tree most of the time.
 *     Compared through `realish` and segment-wise (`sameGround`), so a claim
 *     naming a mount inside the tree, or the tree by its symlinked spelling,
 *     still holds it.
 *
 * (A fifth read, not a precondition: a file this checkout IGNORES that the
 * target branch TRACKS would be overwritten by the switch without a word, so
 * the paths the switch would touch are probed and such a file refuses as
 * `dirty` — see the end of the function.)
 *
 * Then, and only then, `git switch <default>`. The branch is never deleted and
 * never moved: it is exactly where it was, with one fewer working tree on it,
 * which is the whole point.
 *
 * The CALLER journals the result as `run.isolation-reclaimed {tree, from, to}`
 * — this module holds no journal, by the same rule that keeps `pid.ts`'s probe
 * out of `sweepStale`. Named here anyway so the event and the code that causes
 * it can be found from each other: `docs/journal-events.md` has the row, and
 * `runner-loop.ts` §`reclaimRunBranch` writes it.
 */
export async function reclaimBranch(opts: {
  root: string;
  held: string;
  branch: string;
  /** Trees this console may move — the run root, and every mirror mount source. */
  allowed: Iterable<string>;
  /** Trees live locks name, with their holders. Absent means none are known. */
  occupied?: Iterable<OccupiedTree>;
  /** The trunk to switch to. Resolved from `held` when absent. */
  defaultBranch?: string;
  /**
   * Ask every question and move nothing.
   *
   * The preflight (`previewIsolation`) and the real decide must not have two
   * implementations of "would this be reclaimed" — the whole reason the
   * preflight exists is that it once said *mirror, three mounts* while every
   * actual decide refused `branch-in-use`. One function, one set of
   * preconditions, one flag deciding whether the last line runs.
   */
  dryRun?: boolean;
}): Promise<Reclaim> {
  const tree = realish(opts.held);
  const permitted = new Set([...opts.allowed].map((path) => realish(path)));
  if (!permitted.has(tree)) return { kind: 'foreign', tree };

  // Precondition 4, asked BEFORE the tree is touched by any git read: a live
  // claim on this ground ends the question, whatever `status` would say. A
  // claim that named no tree holds every tree (see `OccupiedTree`).
  const holder = [...(opts.occupied ?? [])]
    .find((claim) => !claim.tree || sameGround(realish(claim.tree), tree));
  if (holder) return { kind: 'held', tree, by: holder.by };

  // It has to still be ON the branch. Between the caller's `checkedOutIn` and
  // this call an operator may have switched it themselves, and switching a
  // tree that is already somewhere else is a change nobody asked for.
  const on = await branchAt(opts.root, tree);
  if (on !== opts.branch) return { kind: 'skipped', reason: `the tree stands on ${on ?? 'a detached HEAD'}` };

  // 🔴 `--untracked-files=normal` is STATED, not left to the default. A repo
  // (or a person's global config) that sets `status.showUntrackedFiles=no`
  // makes the porcelain output silent about exactly the class this check
  // exists for — the file a killed session created and never added — so the
  // tree reads clean and gets moved. Stating the flag costs nothing and takes
  // the answer out of the caller's configuration. NOT `-c …` before the verb:
  // that would put a flag at argv[0] and make the whole call invisible to
  // `never-push.test.ts`, which keys on the verb being first.
  const status = await git(tree, ['status', '--porcelain', '--untracked-files=normal']);
  if (!status.ok) return { kind: 'skipped', reason: 'git could not read the tree status' };
  const paths = status.stdout.split('\n').map((line) => line.slice(3).trim()).filter(Boolean);
  if (paths.length) {
    return { kind: 'dirty', tree, paths: paths.slice(0, DIRTY_PATH_CAP) };
  }

  // Clean, and standing on the branch — but is the branch where HEAD is? See
  // precondition 3.
  const [head, ref] = await Promise.all([
    git(tree, ['rev-parse', '--verify', '--quiet', 'HEAD']),
    git(opts.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${opts.branch}`]),
  ]);
  const at = head.stdout.trim();
  const tip = ref.stdout.trim();
  if (!at || !tip || at !== tip) {
    return { kind: 'skipped', reason: 'HEAD is not the branch tip — there would be commits to lose' };
  }

  const to = opts.defaultBranch ?? await defaultBranchOf(tree);
  if (!to) return { kind: 'skipped', reason: 'the repository names no default branch to switch to' };
  if (to === opts.branch) return { kind: 'skipped', reason: 'the run branch IS the default branch' };

  // 🔴 One more thing a clean tree can lose, and git will not stop it: a file
  // this checkout IGNORES which the target branch TRACKS. `git switch`
  // refuses to clobber an untracked file, and silently overwrites an ignored
  // one — so a `.env` that is gitignored here and committed on the trunk is
  // gone with no message at all. Asked only of the paths the switch would
  // actually touch, so the cost is the size of the diff and not of the tree.
  const changed = await git(tree, ['diff', '--name-only', `HEAD..${to}`]);
  const candidates = changed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    .filter((rel) => existsSync(join(tree, rel)))
    .slice(0, IGNORED_PROBE_CAP);
  if (candidates.length) {
    const ignored = await git(tree, ['status', '--porcelain', '--ignored', '--', ...candidates]);
    const clobbered = ignored.stdout.split('\n')
      .filter((line) => line.startsWith('!! '))
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    if (clobbered.length) {
      return { kind: 'dirty', tree, paths: clobbered.slice(0, DIRTY_PATH_CAP) };
    }
  }

  if (opts.dryRun) return { kind: 'reclaimed', tree, from: opts.branch, to };
  const out = await git(tree, ['switch', to]);
  if (!out.ok) return { kind: 'skipped', reason: firstLine(out.stderr) || 'git switch declined' };
  return { kind: 'reclaimed', tree, from: opts.branch, to };
}

/** What a lane reuse did to catch the lane up with the run branch. */
export type LaneResync =
  /** The run branch had `behind` commits this lane lacked; they are in it now. */
  | { kind: 'merged'; behind: number }
  /** git declined, and named the files. The merge was aborted; nothing is lost. */
  | { kind: 'conflict'; behind: number; files: string[]; detail: string }
  /**
   * git declined for a reason that is not a content clash — most often a lane
   * left dirty by a session that was killed mid-edit. NOT a halt: the lane is
   * usable exactly as it stands, it is simply older than the run branch, and
   * refusing to board a phase over an uncommitted file would be a worse answer
   * than boarding it with a stale base and saying so.
   */
  | { kind: 'skipped'; behind: number; detail: string };

/**
 * Catch a REUSED lane up with the run branch before its session boards.
 *
 * Two things go wrong without this, and the first one is the expensive one:
 *
 *  - **A hand-resolved conflict is thrown away.** When a lane's merge conflicts
 *    the run halts and tells the operator to resolve it in `integration/`. They
 *    do, they commit, they press Retry — and Retry reuses the lane at its
 *    pre-resolution fork point, so the phase runs again from before the fix and
 *    conflicts on the same files a second time (or, worse, duplicates the
 *    resolved work). Merging the run branch FORWARD into the lane is what makes
 *    their resolution the lane's own history.
 *  - **A retried lane cannot see its siblings.** Every other lane that landed
 *    while this phase was failing is on the run branch and nowhere else, so a
 *    retry re-ran against a base that had moved on without it.
 *
 * Forward only. This never touches the run branch — `landLane` is the only
 * function that moves it — so a resync cannot lose a sibling's commit, and a
 * conflict here aborts exactly as a landing conflict does.
 */
async function resyncLane(root: string, names: LaneNames): Promise<LaneResync | null> {
  const out = await git(root, ['rev-list', '--count', `${names.laneBranch}..${names.runBranch}`]);
  const behind = Number(out.stdout.trim()) || 0;
  if (!behind) return null;

  const merge = await git(names.dir, ['merge', '--no-edit', names.runBranch]);
  if (merge.ok) return { kind: 'merged', behind };

  const files = await conflictedFiles(names.dir);
  // Safe with no merge in progress: it fails harmlessly and changes nothing.
  await git(names.dir, ['merge', '--abort']);
  const detail = firstLine(merge.stderr) || firstLine(merge.stdout) || 'git merge failed';
  if (!files.length) return { kind: 'skipped', behind, detail };
  return { kind: 'conflict', behind, files, detail };
}

/**
 * A lane's own checkout, branched from the run branch.
 *
 * A lane directory that already exists is REUSED rather than recreated: a
 * retried phase must not lose the commits its first attempt made, and the whole
 * point of keeping the branch is that they are still there. Reuse is also where
 * the lane is caught up with the run branch — see `resyncLane`.
 */
export async function acquireLane(
  root: string, names: LaneNames,
): Promise<WorktreeStep & { dir?: string; resync?: LaneResync }> {
  const integration = await ensureIntegration(root, names);
  if (!integration.ok) return integration;

  if (await isRegistered(root, names.dir)) {
    const resync = await resyncLane(root, names);
    return { ok: true, dir: names.dir, ...(resync ? { resync } : {}) };
  }
  await mkdir(dirname(names.dir), { recursive: true });

  const exists = await refExists(root, names.laneBranch);
  const args = exists
    ? ['worktree', 'add', names.dir, names.laneBranch]
    : ['worktree', 'add', '-b', names.laneBranch, names.dir, names.runBranch];
  const out = await git(root, args);
  if (!out.ok) return { ok: false, detail: firstLine(out.stderr) || 'git worktree add failed' };
  return { ok: true, dir: names.dir };
}

export type LandResult =
  /** Nothing to land — the lane made no commits. Not a failure. */
  | { kind: 'empty' }
  /** The run branch now contains the lane's commits. */
  | { kind: 'merged'; fastForward: boolean; commits: number }
  /** git could not merge them. The merge was aborted; every commit survives. */
  | { kind: 'conflict'; files: string[]; detail: string }
  /** Something else went wrong (a missing branch, a wedged git). */
  | { kind: 'failed'; detail: string };

/**
 * Fold a settled lane's commits into the run branch.
 *
 * Fast-forward first, because the common case — one lane at a time, or two
 * lanes whose second started after the first landed — really is one. Only when
 * that is refused does it make a merge commit, which is the honest record of
 * two branches that diverged.
 *
 * On conflict it ABORTS. A half-merged integration worktree with conflict
 * markers in it is the one state nothing downstream could interpret: the next
 * lane's merge would fail for a reason that has nothing to do with the next
 * lane, and an operator opening the directory would find a mess with no note
 * saying who made it.
 */
export async function landLane(
  root: string, names: LaneNames,
): Promise<LandResult> {
  if (!(await refExists(root, names.laneBranch))) {
    return { kind: 'failed', detail: `the lane branch ${names.laneBranch} does not exist` };
  }
  if (!(await isRegistered(root, names.integration))) {
    const ensured = await ensureIntegration(root, names);
    if (!ensured.ok) return { kind: 'failed', detail: ensured.detail ?? 'no integration worktree' };
  }

  const ahead = await git(root, ['rev-list', '--count', `${names.runBranch}..${names.laneBranch}`]);
  const commits = Number(ahead.stdout.trim()) || 0;
  if (!commits) return { kind: 'empty' };

  const ff = await git(names.integration, ['merge', '--ff-only', names.laneBranch]);
  if (ff.ok) return { kind: 'merged', fastForward: true, commits };

  const merge = await git(names.integration, [
    'merge', '--no-ff', '--no-edit', '-m',
    `Merge ${names.laneBranch} into ${names.runBranch}`, names.laneBranch,
  ]);
  if (merge.ok) return { kind: 'merged', fastForward: false, commits };

  // Conflicted, or refused for another reason. `--abort` is safe either way:
  // with no merge in progress it fails harmlessly and changes nothing.
  const files = await conflictedFiles(names.integration);
  await git(names.integration, ['merge', '--abort']);
  const detail = firstLine(merge.stderr) || firstLine(merge.stdout) || 'git merge failed';
  if (!files.length) return { kind: 'failed', detail };
  return { kind: 'conflict', files, detail };
}

/**
 * The console's own staging branch — one per machine, shared by every plan.
 *
 * ONE name, deliberately, and not `pe/<slug>-integration`: the whole value of a
 * staging branch is that several plans' finished work meets on it before
 * anything is pushed, which is what makes an integration settle different from
 * a pull request. A per-plan staging branch would be a second copy of the run
 * branch with nothing to compare it against.
 */
export const STAGING_BRANCH = 'pe/integration';

export type StagingNames = {
  /** `pe/integration` — where finished run branches are folded together. */
  branch: string;
  /** Absolute path of the staging checkout. */
  dir: string;
};

/**
 * Where the staging checkout lives: ONE per console checkout, never per run.
 *
 * git allows a branch exactly one working tree, so a per-run (or per-plan)
 * staging directory would mean the second plan to settle finding
 * `pe/integration` already checked out and refusing — an honest failure, and a
 * useless one, since the whole point is that the branches meet. `consoleDir` is
 * the per-repository state directory (`runs/<instanceId>`), which is the exact
 * scope the branch has: two consoles on two repositories never collide, and two
 * plans in one repository share the tree they are supposed to share.
 */
export function stagingNames(consoleDir: string): StagingNames {
  return { branch: STAGING_BRANCH, dir: join(consoleDir, 'staging') };
}

/**
 * Fold a finished run's branch into the console's staging tree.
 *
 * `landLane` one level up: same fast-forward-then-merge-then-abort discipline,
 * same guarantee that a conflict destroys nothing — the merge is aborted and
 * every commit is still on `pe/<slug>`, which this never deletes. What differs
 * is only which branch goes into which, and that the target is console-wide.
 *
 * It talks to no remote. That is the strategy's entire safety story: an
 * `integration` settle is the one that ends with the work merged and NOTHING
 * published, so it runs inside the console (`worktree.ts`, merge verbs only)
 * rather than as a session with a push carve-out.
 */
export async function landIntegration(
  root: string, opts: { branch: string; staging: StagingNames },
): Promise<LandResult> {
  const { branch, staging } = opts;
  if (!(await refExists(root, branch))) {
    return { kind: 'failed', detail: `the run branch ${branch} does not exist` };
  }
  const ensured = await ensureCheckout(root, { dir: staging.dir, branch: staging.branch });
  if (!ensured.ok) {
    return { kind: 'failed', detail: ensured.detail ?? 'no staging worktree' };
  }

  // Counted against the STAGING branch, not against a merge base: the question
  // is "does this branch hold anything staging does not", and a run whose work
  // is already in there (a re-settle, a resumed run that settled once) must
  // report `empty` rather than making an empty merge commit.
  const ahead = await git(root, ['rev-list', '--count', `${staging.branch}..${branch}`]);
  const commits = Number(ahead.stdout.trim()) || 0;
  if (!commits) return { kind: 'empty' };

  const ff = await git(staging.dir, ['merge', '--ff-only', branch]);
  if (ff.ok) return { kind: 'merged', fastForward: true, commits };

  const merge = await git(staging.dir, [
    'merge', '--no-ff', '--no-edit', '-m', `Merge ${branch} into ${staging.branch}`, branch,
  ]);
  if (merge.ok) return { kind: 'merged', fastForward: false, commits };

  // Aborted, exactly as `landLane` aborts, and for the same reason: a staging
  // tree left holding conflict markers would break the NEXT plan's settle for a
  // reason that has nothing to do with it.
  const files = await conflictedFiles(staging.dir);
  await git(staging.dir, ['merge', '--abort']);
  const detail = firstLine(merge.stderr) || firstLine(merge.stdout) || 'git merge failed';
  if (!files.length) return { kind: 'failed', detail };
  return { kind: 'conflict', files, detail };
}


/* ================================================================== *
 * The mirror: a run's own checkout of a SUPERPROJECT's repositories.
 *
 * `git worktree add` of a superproject leaves its submodule directories
 * EMPTY, so a run under one cannot hold a single tree of the root. What
 * it CAN hold is one linked worktree per sub-repository its plan
 * actually scopes, laid out at their root-relative paths under the
 * run's `integration/` directory — which is then a plain directory, not
 * a repository. The superproject's own tree, and its recorded gitlink
 * shas, are never touched.
 * ================================================================== */

/** One mounted repository of a mirror. */
export type MirrorMount = {
  /** Root-relative path of the repository — `web-admin`, `app/core`. */
  rel: string;
  /** Absolute path of the shared checkout this mount is a worktree of. */
  source: string;
};

/**
 * The manifest naming what a mirror holds — written LAST, so its presence
 * means the mirror was complete once. A crash mid-build leaves nested
 * checkouts and no manifest, and `detectMirror` reads that shape by walk.
 * `integration/` is not a repository, so the file is invisible to git.
 */
export const MIRROR_MANIFEST = '.pe-mirror.json';

export type MirrorManifest = {
  version: 1;
  runId: string;
  slug: string;
  branch: string;
  mounts: MirrorMount[];
  /**
   * This mirror's mounts are DETACHED — they own no branch at all.
   *
   * Optional, and absent on every manifest written before the detached shape
   * existed, which reads as the branch mirror it was. `branch` still carries
   * the run branch's NAME on a detached manifest, because it is what the run
   * is called and what a person reads on the page; the flag is what decides
   * how the mounts are validated.
   */
  detached?: true;
};

/** Parents before children, so a superproject mounts before what it contains. */
function byMountDepth(a: MirrorMount, b: MirrorMount): number {
  return a.rel.split(sep).length - b.rel.split(sep).length || a.rel.localeCompare(b.rel);
}

/**
 * The `path =` lines of a `.gitmodules`, read with fs — a superproject
 * declares its submodules in an INI whose one key this needs is `path`,
 * and asking git would mean a verb the gate does not list.
 */
export function parseGitmodulesPaths(repoTop: string): string[] {
  try {
    const text = readFileSync(join(repoTop, '.gitmodules'), 'utf8');
    const paths: string[] = [];
    for (const line of text.split('\n')) {
      const m = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
      if (m && m[1]) paths.push(m[1]);
    }
    return paths;
  } catch {
    return [];
  }
}

/** A declared-but-uninitialized submodule that `rel` is (or is under), if any. */
function uninitializedUnder(repoTop: string, rel: string): string | undefined {
  for (const declared of parseGitmodulesPaths(repoTop)) {
    if (rel !== declared && !rel.startsWith(declared + '/')) continue;
    if (!existsSync(join(repoTop, declared, '.git'))) return declared;
  }
  return undefined;
}

export type MountResolution =
  | { ok: true; mounts: MirrorMount[]; skipped: string[] }
  | { ok: false; refusal: 'scope-unmapped'; detail: string };

/** How deep a nest of superprojects the expansion will follow. */
const MOUNT_DEPTH_CAP = 5;

/**
 * Which repositories a plan's scope actually lives in.
 *
 * A token mounts the toplevel of the repository CONTAINING its path, so
 * `app/core/src` mounts `app/core`. A token that resolves to the
 * superproject's own tree — `all`, the root's basename, a plain directory —
 * mounts the ROOT, as `rel: ''`. A token that maps to nothing refuses
 * `scope-unmapped`, and a DECLARED submodule that is simply not initialized
 * says so by name, with the command that fixes it.
 *
 * A mounted superproject's scope covers its submodules, so its INITIALIZED
 * ones mount too — recursively, depth-capped — and every one it skips
 * because it is not initialized is named in `skipped` rather than silently
 * left an empty directory.
 *
 * 🔴 The root mount is that same rule applied to the one repository it used to
 * exclude, and it is why `root-scoped` no longer fires. The refusal existed
 * because a linked worktree of a superproject has EMPTY submodule directories
 * — but that is precisely what the recursive expansion above fixes, and it has
 * been fixing it for every NON-root superproject (`app`, holding `app/core`)
 * since the mirror shipped. Refusing the root while mounting `app` was one rule
 * with two answers. A plan whose phases name the root at all — the root's own
 * name beside a submodule path, the ordinary shape of a monorepo-of-submodules
 * plan — could not have an isolated checkout because of it, which is the whole
 * class the mirror was reopened for.
 */
export async function resolveMounts(
  root: string, scopes: Iterable<string>,
): Promise<MountResolution> {
  const top = realish(resolve(root));
  const own = normalizeToken(basename(top));
  const byRel = new Map<string, MirrorMount>();

  for (const raw of scopes) {
    const token = normalizeToken(raw);
    if (!token) continue;
    if (token === 'all' || (own && token === own)) {
      if (!byRel.has('')) byRel.set('', { rel: '', source: top });
      continue;
    }
    const path = realish(resolve(top, token));
    if (path !== top && !path.startsWith(top + sep)) {
      return {
        ok: false, refusal: 'scope-unmapped',
        detail: `the scope token \`${token}\` resolves outside the run root`,
      };
    }
    if (!existsSync(path)) {
      return {
        ok: false, refusal: 'scope-unmapped',
        detail: `the scope token \`${token}\` names nothing on disk under the run root`,
      };
    }
    const at = (await stat(path)).isDirectory() ? path : dirname(path);
    const found = await git(at, ['rev-parse', '--show-toplevel']);
    const repoTop = found.ok ? realish(found.stdout.trim()) : '';
    if (!repoTop) {
      return {
        ok: false, refusal: 'scope-unmapped',
        detail: `the scope token \`${token}\` is not inside a git repository`,
      };
    }
    if (repoTop === top) {
      const declared = uninitializedUnder(top, token);
      if (declared) {
        return {
          ok: false, refusal: 'scope-unmapped',
          detail: `the scope token \`${token}\` names the declared submodule \`${declared}\`, `
            + `which is not initialized — run \`git submodule update --init ${declared}\` `
            + 'in the run root and start the run again',
        };
      }
      // A plain directory of the root — `docs`, `scripts` — is the root's own
      // tree, so it mounts the root. Checked AFTER `uninitializedUnder`, which
      // is the one shape that resolves here and is not the root at all: a
      // deinit'd submodule is an empty directory whose `--show-toplevel`
      // answers the superproject.
      if (!byRel.has('')) byRel.set('', { rel: '', source: top });
      continue;
    }
    // Inside a MOUNTED repository, the same uninitialized question one level
    // down: `app/core` with `app` initialized and `core` not resolves into
    // `app`, and mounting `app` would board the phase into an empty `core/`.
    const inner = path === repoTop ? '' : path.slice(repoTop.length + 1);
    if (inner) {
      const declared = uninitializedUnder(repoTop, inner);
      if (declared) {
        const fix = `${repoTop.slice(top.length + 1)}/${declared}`;
        return {
          ok: false, refusal: 'scope-unmapped',
          detail: `the scope token \`${token}\` reaches through the declared submodule `
            + `\`${fix}\`, which is not initialized — run \`git submodule update --init ${fix}\` `
            + 'in the run root and start the run again',
        };
      }
    }
    const rel = repoTop.slice(top.length + 1);
    if (!byRel.has(rel)) byRel.set(rel, { rel, source: repoTop });
  }

  if (!byRel.size) {
    return {
      ok: false, refusal: 'scope-unmapped',
      detail: 'no scope token of this plan resolves to a repository under the run root',
    };
  }

  const skipped: string[] = [];
  const queue = [...byRel.values()];
  const seen = new Set(queue.map((mount) => mount.source));
  while (queue.length) {
    const mount = queue.shift()!;
    if (mount.rel.split(sep).length >= MOUNT_DEPTH_CAP) continue;
    for (const sub of parseGitmodulesPaths(mount.source)) {
      const childDir = join(mount.source, sub);
      const childRel = join(mount.rel, sub);
      if (!existsSync(join(childDir, '.git'))) {
        skipped.push(childRel);
        continue;
      }
      const childTop = realish(childDir);
      if (seen.has(childTop)) continue;
      seen.add(childTop);
      if (byRel.has(childRel)) continue;
      const child: MirrorMount = { rel: childRel, source: childTop };
      byRel.set(childRel, child);
      queue.push(child);
    }
  }

  return { ok: true, mounts: [...byRel.values()].sort(byMountDepth), skipped: skipped.sort() };
}

/**
 * Build (or adopt) the mirror: one `ensureCheckout` per mount, parents first,
 * every hard-won behavior of the single-repo path inherited per repository —
 * prunable registrations, adopted-tree branch checks, `branch-in-use` by name.
 *
 * All-or-nothing: the first failure tears down every mount THIS call created,
 * deepest first, touches nothing it adopted, and the manifest is written only
 * after the last mount succeeded — so a manifest's presence means the mirror
 * was complete once, and a crash mid-build is a recognisable shape.
 */
export async function ensureMirror(opts: {
  names: LaneNames; runId: string; slug: string; mounts: MirrorMount[];
  /**
   * Detach every mount instead of standing it on the run branch.
   *
   * Per MOUNT, because a mirror's repositories are unrelated object databases
   * that merely share a ref name: each one detaches at its OWN default
   * branch's head, resolved here. A repository that names no default branch
   * cannot be detached and refuses `worktree-failed` by name — the same
   * all-or-nothing discipline every other step of this function keeps.
   */
  detach?: boolean;
}): Promise<{
  ok: boolean;
  created: string[];
  adopted: string[];
  refusal?: 'branch-in-use' | 'worktree-failed';
  detail?: string;
}> {
  const { names, mounts } = opts;
  const created: MirrorMount[] = [];
  const adopted: string[] = [];

  const fail = async (refusal: 'branch-in-use' | 'worktree-failed', detail: string) => {
    for (const mount of [...created].sort(byMountDepth).reverse()) {
      await discardFreshDir(mount.source, join(names.integration, mount.rel));
    }
    if (!adopted.length) {
      await rm(names.integration, { recursive: true, force: true });
      await rm(mirrorManifestPath(names.integration), { force: true });
    }
    return { ok: false, created: [], adopted, refusal, detail };
  };

  try {
    await mkdir(names.integration, { recursive: true });
  } catch (error) {
    return {
      ok: false, created: [], adopted, refusal: 'worktree-failed',
      detail: (error as Error)?.message ?? 'could not create the mirror directory',
    };
  }

  for (const mount of mounts) {
    const dir = join(names.integration, mount.rel);
    let at: CheckoutAt = { dir, branch: names.runBranch };
    if (opts.detach) {
      const trunk = await defaultBranchOf(mount.source);
      const head = trunk
        ? await git(mount.source, ['rev-parse', '--verify', '--quiet', trunk])
        : null;
      const sha = head?.stdout.trim();
      if (!sha) {
        return fail('worktree-failed',
          `${mount.rel}: the repository names no default branch to detach at`);
      }
      at = { dir, detachAt: sha };
    }
    const made = await ensureCheckout(mount.source, at);
    if (made.ok) {
      if (made.created) created.push(mount); else adopted.push(mount.rel);
      continue;
    }
    const detail = `${mount.rel}: ${made.detail ?? 'git worktree add failed'}`;
    const refusal = /already checked out at/.test(made.detail ?? '') ? 'branch-in-use' : 'worktree-failed';
    return fail(refusal, detail);
  }

  const manifest: MirrorManifest = {
    version: 1, runId: opts.runId, slug: opts.slug, branch: names.runBranch, mounts,
    ...(opts.detach ? { detached: true as const } : {}),
  };
  try {
    await writeFile(mirrorManifestPath(names.integration), JSON.stringify(manifest, null, 2));
  } catch (error) {
    return fail('worktree-failed',
      (error as Error)?.message ?? 'could not write the mirror manifest');
  }

  return { ok: true, created: created.map((mount) => mount.rel), adopted };
}

/**
 * Where the manifest lives: BESIDE the mirror, in the run's own directory,
 * never inside it.
 *
 * 🔴 It used to live at `integration/.pe-mirror.json`, which was harmless
 * while `integration/` was a plain directory the console owned. With the ROOT
 * mount that directory IS a git checkout, and an untracked file in it makes
 * the mount permanently `isDirty` — so `pruneMirror` would keep the root
 * forever, `integration/` would never be removed, and the run's own branch
 * would stay held. A console artifact does not belong inside a repository it
 * is only borrowing. Reads still fall back to the old path so a mirror built
 * by an earlier console still validates instead of being rebuilt.
 */
export function mirrorManifestPath(integration: string): string {
  return join(dirname(integration), MIRROR_MANIFEST);
}

/** The manifest for `integration`, when there is one this code once wrote. */
export async function readMirror(integration: string): Promise<MirrorManifest | null> {
  try {
    const text = await readFile(mirrorManifestPath(integration), 'utf8')
      .catch(() => readFile(join(integration, MIRROR_MANIFEST), 'utf8'));
    const parsed = JSON.parse(text) as MirrorManifest;
    if (parsed?.version !== 1 || !Array.isArray(parsed.mounts)) return null;
    if (!parsed.mounts.every((m) => m && typeof m.rel === 'string' && typeof m.source === 'string')) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The crash shape: nested checkouts under `integration/` and no manifest.
 * A bounded walk for directories holding a `.git` FILE (a linked worktree's
 * signature); each one's source repository is the MAIN entry of its own
 * `worktree list`, which is how the sweep knows where to return it.
 */
export async function detectMirror(integration: string): Promise<MirrorMount[]> {
  const found: MirrorMount[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > MOUNT_DEPTH_CAP + 1) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (rel && entries.some((entry) => entry.name === '.git' && entry.isFile())) {
      const list = await git(dir, ['worktree', 'list', '--porcelain']);
      const main = list.ok
        ? list.stdout.split('\n').find((line) => line.startsWith('worktree '))
        : undefined;
      const source = main ? realish(main.slice('worktree '.length).trim()) : '';
      if (source && source !== realish(dir)) found.push({ rel, source });
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      await walk(join(dir, entry.name), rel ? join(rel, entry.name) : entry.name, depth + 1);
    }
  };
  await walk(integration, '', 0);
  return found.sort(byMountDepth);
}

/**
 * Is this mirror standing, complete, and on the run branch — per MOUNT?
 * The `holding` question `holdsBranch` answers for a single-repo checkout,
 * asked of every repository the manifest names.
 */
export async function validateMirror(integration: string, runBranch: string): Promise<boolean> {
  const manifest = await readMirror(integration);
  if (!manifest || !manifest.mounts.length) return false;
  for (const mount of manifest.mounts) {
    const dir = join(integration, mount.rel);
    if (!existsSync(dir)) return false;
    // A DETACHED mirror's mounts own no branch, so `holdsBranch` would fail
    // every one of them and the run would rebuild a perfectly good mirror on
    // every drive. The question for this shape is the one it can answer:
    // is the mount still a registered worktree standing on no branch at all?
    if (manifest.detached) {
      if (!(await isRegistered(mount.source, dir))) return false;
      if (await branchAt(mount.source, dir)) return false;
      continue;
    }
    if (!(await holdsBranch(mount.source, dir, runBranch))) return false;
  }
  return true;
}

/**
 * Discard mounts THIS process created moments ago — the mirror's spelling of
 * `discardFreshTree`, with the same one justification: only for trees minted
 * in the same breath, before any session has been near them. Deepest first,
 * and the integration directory itself goes only when the caller says nothing
 * adopted remains in it.
 */
export async function discardFreshMounts(
  names: LaneNames, mounts: MirrorMount[], opts?: { integration?: boolean },
): Promise<{ removed: boolean; detail?: string }> {
  let ok = true;
  let detail: string | undefined;
  for (const mount of [...mounts].sort(byMountDepth).reverse()) {
    const out = await discardFreshDir(mount.source, join(names.integration, mount.rel));
    if (!out.removed) {
      ok = false;
      detail = `${mount.rel}: ${out.detail ?? 'git worktree remove failed'}`;
    }
  }
  if (ok && opts?.integration) {
    await rm(names.integration, { recursive: true, force: true });
    await rm(mirrorManifestPath(names.integration), { force: true });
  }
  return { removed: ok, ...(detail ? { detail } : {}) };
}

/** The mounts of a mirror at `integration`, or null when it is not one. */
async function mirrorShape(root: string, integration: string): Promise<MirrorMount[] | null> {
  const manifest = await readMirror(integration);
  if (manifest) return manifest.mounts;
  if (!existsSync(integration)) return null;
  const detected = await detectMirror(integration);
  // A registered directory used to be proof of the single-repo integration
  // worktree. Since the ROOT mount it is also what a mirror's `rel: ''` looks
  // like, and the two are told apart by what is NESTED under it: a single-repo
  // checkout has no linked worktrees inside it, a rooted mirror has one per
  // submodule. Getting this wrong in the manifest-less crash shape would hand
  // `pruneRunTree` a `worktree remove` git refuses ("contains submodules") and
  // leave the whole mirror standing with nothing owning it.
  if (await isRegistered(root, integration)) {
    return detected.length ? [{ rel: '', source: realish(root) }, ...detected] : null;
  }
  return detected.length ? detected : null;
}

/**
 * Remove a mirror's mounts, deepest first, under the one rule every prune
 * here obeys: a tree holding work is KEPT and named. A superproject mount
 * git refuses to remove ("contains submodules") after its children are gone
 * and its own tree is clean gets the operator-deleted-tree treatment —
 * delete the directory, then `worktree prune` the stale registration.
 */
export async function pruneMirror(opts: {
  integration: string; mounts: MirrorMount[];
}): Promise<{ removed: string[]; kept: string[] }> {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const mount of [...opts.mounts].sort(byMountDepth).reverse()) {
    const dir = join(opts.integration, mount.rel);
    if (!(await isRegistered(mount.source, dir))) continue;
    // 🔴 BEFORE any removal attempt: `worktree remove --force` deletes a tree
    // that contains submodules, so removing a superproject mount while a kept
    // child still lives inside it would delete the exact work the child was
    // kept FOR. A surviving child keeps its parents, full stop.
    if (kept.some((path) => path.startsWith(dir + sep))) {
      kept.push(dir);
      continue;
    }
    if (await isDirty(dir)) {
      kept.push(dir);
      continue;
    }
    const out = await git(mount.source, ['worktree', 'remove', '--force', dir]);
    if (out.ok) {
      removed.push(dir);
      await git(mount.source, ['worktree', 'prune']);
      continue;
    }
    // A clean, child-free tree git still refuses (an older git refuses any
    // submodule-containing worktree outright) gets the operator-deleted-tree
    // treatment: delete the directory, then prune the stale registration.
    await rm(dir, { recursive: true, force: true });
    await git(mount.source, ['worktree', 'prune']);
    removed.push(dir);
  }
  if (!kept.length) {
    await rm(opts.integration, { recursive: true, force: true });
    // The manifest sits BESIDE the mirror (`mirrorManifestPath`), so removing
    // the directory no longer takes it with it — and a manifest outlasting its
    // mounts is what would make the next `mirrorShape` claim a mirror that is
    // not there. The legacy in-tree copy went with the directory above.
    await rm(mirrorManifestPath(opts.integration), { force: true });
  }
  return { removed, kept };
}

/**
 * Does this checkout hold anything that is not in a commit?
 *
 * `status --porcelain` rather than `diff`, and the difference is the whole
 * point: `diff` answers for tracked edits and is silent about a file the
 * session created and never `git add`ed — which is exactly what a session
 * killed mid-phase leaves behind. Both callers below use this to decide
 * whether a directory may be DELETED, so a false "clean" is unrecoverable and
 * a false "dirty" costs nothing but a directory left on disk.
 *
 * A tree git cannot read at all reads DIRTY, for the same asymmetry.
 */
async function isDirty(dir: string): Promise<boolean> {
  // 🔴 A directory that is NOT THERE holds no work, and is the one case the
  // fail-safe below gets backwards. `git status` cannot run in a path that does
  // not exist, so a checkout an operator deleted by hand read DIRTY — and every
  // caller therefore KEPT it: `pruneRun` and `sweepStale` both refuse to remove
  // a dirty tree, so the stale registration and its hold on `pe/<slug>` would
  // have survived every cleanup this module has, permanently, and the next
  // `worktree add` fails on a branch git says is already in use. Absent is not
  // unreadable: there is nothing here to lose.
  if (!existsSync(dir)) return false;
  // `--ignore-submodules=all`, because a mounted superproject would otherwise read
  // permanently dirty the moment a nested mount's checkout advanced a gitlink the
  // console never moves — the same false witness `situation.ts` silences the same way.
  const out = await git(dir, ['status', '--porcelain', '--ignore-submodules=all']);
  if (!out.ok) return true;
  return out.stdout.trim().length > 0;
}

/** The paths git marked as conflicted, capped so a halt message stays readable. */
async function conflictedFiles(cwd: string, cap = 20): Promise<string[]> {
  const out = await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
  if (!out.ok) return [];
  return out.stdout.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, cap);
}

/**
 * Remove a run's worktrees.
 *
 * Two rules, both about never destroying work:
 *
 *  - a lane whose branch still has commits the run branch does not have is
 *    LEFT ALONE, and named in the return value. That is the state after a
 *    conflict halt, and removing it would take the only checkout of the work
 *    with it. (The branch would survive — but "your commits are on a branch
 *    somewhere" is a worse answer than a directory that is still there.)
 *  - a lane with UNCOMMITTED work in it is left alone for the same reason and
 *    with less room for argument: `worktree remove --force` deletes a dirty
 *    tree without asking, and there is no branch holding that work at all.
 *  - branches are never deleted here at all. `pe/<slug>-pN` is cheap, and it is
 *    the audit trail of which lane produced which commits.
 */
export async function pruneRun(
  root: string, opts: LaneHome & { runId: string; slug: string; phases: number[] },
): Promise<{ removed: string[]; kept: string[] }> {
  const removed: string[] = [];
  const kept: string[] = [];

  for (const phase of opts.phases) {
    const names = laneNames({ ...opts, phase });
    if (!(await isRegistered(root, names.dir))) continue;
    if (!(await landed(root, names))) { kept.push(names.dir); continue; }
    const out = await git(root, ['worktree', 'remove', '--force', names.dir]);
    if (out.ok) removed.push(names.dir); else kept.push(names.dir);
  }

  // The integration worktree goes last and only when every lane has gone: it is
  // the checkout the merges happened in, and removing it while a lane survives
  // would leave that lane nothing to be merged into.
  if (!kept.length) {
    const names = laneNames({ ...opts, phase: 0 });
    const mirror = await mirrorShape(root, names.integration);
    if (mirror) {
      const pruned = await pruneMirror({ integration: names.integration, mounts: mirror });
      removed.push(...pruned.removed);
      kept.push(...pruned.kept);
    } else if (await isRegistered(root, names.integration)) {
      if (await isDirty(names.integration)) {
        kept.push(names.integration);
      } else {
        const out = await git(root, ['worktree', 'remove', '--force', names.integration]);
        if (out.ok) removed.push(names.integration); else kept.push(names.integration);
      }
    }
    // Only when nothing is left: `worktree prune` drops registrations whose
    // directories are already gone, which is exactly the state a `rm -rf` by an
    // operator leaves behind.
    if (!kept.length) {
      await git(root, ['worktree', 'prune']);
      await rm(join(laneHome(opts), opts.runId), { recursive: true, force: true });
    }
  }

  return { removed, kept };
}

/**
 * Is everything in this lane's checkout safely somewhere else?
 *
 * Both halves, because either alone deletes work: the branch must hold no
 * commit the run branch is missing, AND the tree must hold nothing that is not
 * in a commit at all. The first is the conflict-halt case, the second is the
 * killed-session case, and the sweep meets far more of the second than the
 * live prune ever does.
 */
async function landed(root: string, names: LaneNames): Promise<boolean> {
  const ahead = await git(root, ['rev-list', '--count', `${names.runBranch}..${names.laneBranch}`]);
  // 🔴 A read that FAILED is not a zero. `rev-list` fails when the run branch
  // is gone — deleted after its pull request merged while this lane's tree
  // survived (a checked-out branch cannot be deleted, so the lane's is still
  // there) — and `Number('') || 0` read that as "nothing to land", so the
  // sweep force-removed a lane whose commits had landed NOWHERE. The commits
  // survived on `pe/<slug>-pN`, but the rule this function exists for is
  // that such a tree is KEPT and named, and a failed question is the one
  // answer that cannot say it was.
  if (!ahead.ok) return false;
  if ((Number(ahead.stdout.trim()) || 0) > 0) return false;
  return !(await isDirty(names.dir));
}

/** What a sweep did, in paths, so the caller can journal it in words. */
export type SweepResult = {
  /** Checkouts removed. */
  removed: string[];
  /** Checkouts deliberately left standing, because they hold work. */
  kept: string[];
  /** The run ids whose directory is now gone entirely. */
  runs: string[];
};

/**
 * Clear away the worktrees of runs that are over — the one thing nothing did.
 *
 * A console that is killed (a crash, a SIGKILL, a machine that lost power)
 * leaves its `integration/` registered and CHECKED OUT on `pe/<slug>` forever.
 * `git worktree prune` will not touch it — prune drops registrations whose
 * DIRECTORY is gone, and this one is intact — so every later run of that plan
 * meets `ensureIntegration`'s "already checked out at …" refusal and silently
 * degrades to sharing the root checkout, until a person runs
 * `git worktree remove --force` by hand. Nobody ever did, because nothing said
 * so. Lane directories wedge the same way: `pe/<slug>-pN` is per-plan-per-phase
 * and NOT per-run, so a stale `p7` blocks the next run's phase 7 too.
 *
 * Two questions decide that a run is over, and both must say yes:
 *
 *  - it is not in `liveRunIds` — the runs this console is driving right now;
 *  - none of the pids it recorded still holds work. That is the previous
 *    console's children, and it is why this is not merely a directory scan: a
 *    session can outlive the console that spawned it, and its lane is the tree
 *    it is still writing.
 *
 * Then the ordinary rule applies per tree, unchanged and for the same reason:
 * a checkout holding commits the run branch lacks, or holding anything not yet
 * committed at all, is KEPT and named. A sweep exists to unwedge the next run,
 * never to tidy up after a session.
 *
 * `probe` and `children` are injected rather than imported so this module keeps
 * no opinion about process liveness — `pid.ts` is the machine's one probe, and
 * every caller here passes it through (`test/invariants.test.ts` holds that
 * line). Both default to "nothing recorded", which is the honest answer for a
 * caller that has no run records to offer.
 */
export async function sweepStale(root: string, opts: ({ homes: readonly string[] } | { stateDir: string }) & {
  slug: string;
  liveRunIds: Iterable<string>;
  /** The pids a run recorded for its children — `childrenOf(loadRun(...))`, injected. */
  children?: (runId: string) => readonly (number | null | undefined)[];
  /** Does this pid still hold work? `pid.ts`'s `pidHoldsWork`, injected. */
  probe?: (pid: number) => boolean;
}): Promise<SweepResult> {
  // BOTH homes, whatever the setting says today: a tree made under the other
  // one is still this console's to sweep.
  const homes = 'homes' in opts ? [...new Set(opts.homes)] : [join(opts.stateDir, 'worktrees')];
  const live = new Set(opts.liveRunIds);
  const childrenOfRun = opts.children ?? (() => []);
  const probe = opts.probe ?? (() => false);
  const removed: string[] = [];
  const kept: string[] = [];
  const runs: string[] = [];

  for (const base of homes) {
    let entries: string[];
    try {
      entries = (await readdir(base, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      // No worktrees directory at all under this home — the overwhelmingly
      // common case, and the reason this is cheap enough to run at every boot
      // and every drive.
      continue;
    }

    for (const runId of entries) {
      if (live.has(runId)) continue;
      const pids = childrenOfRun(runId).filter((pid): pid is number => typeof pid === 'number' && pid > 0);
      if (pids.some((pid) => probe(pid))) continue;

      const dir = join(base, runId);
      let trees: string[];
      try {
        trees = (await readdir(dir, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch { continue; }

      const keptHere: string[] = [];
      for (const tree of trees) {
        const phase = /^p(\d+)$/.exec(tree);
        if (!phase) continue; // the integration tree goes last — see below
        const names = laneNames({
          home: base, runId, slug: opts.slug, phase: Number(phase[1]),
        });
        if (!(await isRegistered(root, names.dir))) continue;
        if (!(await landed(root, names))) { keptHere.push(names.dir); continue; }
        const out = await git(root, ['worktree', 'remove', '--force', names.dir]);
        if (out.ok) removed.push(names.dir); else keptHere.push(names.dir);
      }

      // The integration worktree goes last and only when every lane has gone —
      // the same rule, and the same reason, as `pruneRun`: it is the checkout the
      // merges happen in, and removing it while a lane survives leaves that lane
      // nothing to be merged into. It is also the one tree whose dirtiness is
      // somebody's HAND-RESOLUTION in progress, which is the single most
      // expensive thing this function could delete.
      if (!keptHere.length) {
        const names = laneNames({ home: base, runId, slug: opts.slug, phase: 0 });
        const mirror = await mirrorShape(root, names.integration);
        if (mirror) {
          const pruned = await pruneMirror({ integration: names.integration, mounts: mirror });
          removed.push(...pruned.removed);
          keptHere.push(...pruned.kept);
        } else if (await isRegistered(root, names.integration)) {
          if (await isDirty(names.integration)) {
            keptHere.push(names.integration);
          } else {
            const out = await git(root, ['worktree', 'remove', '--force', names.integration]);
            if (out.ok) removed.push(names.integration); else keptHere.push(names.integration);
          }
        }
      }

      kept.push(...keptHere);
      if (!keptHere.length) {
        await rm(dir, { recursive: true, force: true });
        runs.push(runId);
      }
    }
  }

  // Once, at the end: registrations whose directories are gone — the ones this
  // sweep just removed by hand, and any an operator deleted themselves.
  if (removed.length || runs.length) await git(root, ['worktree', 'prune']);
  return { removed, kept, runs };
}

/** What a registration sweep found: what it dropped, and what it will not touch. */
export type UnmanagedSweep = {
  /** Registrations whose directory is gone. Dropped by `git worktree prune`. */
  pruned: string[];
  /** Live checkouts on a `pe/*` branch that this console did not make. Reported only. */
  unmanaged: { dir: string; branch: string }[];
};

/**
 * The registrations `sweepStale` cannot see, because they were never ours.
 *
 * `sweepStale` walks the console's own `worktrees/<runId>/` directories, so it
 * is blind to two shapes that wedge a repository just as effectively:
 *
 *  - a **prunable** registration — `git worktree list` keeps printing a
 *    checkout whose directory somebody deleted, and it goes on HOLDING that
 *    checkout's branch. `pe/<slug>` stays taken, every later run of the plan
 *    refuses `branch-in-use`, and the only thing that clears it is a
 *    `git worktree prune` nothing was running. That is a pure repair with
 *    nothing to lose — the directory is already gone — so it is done, not
 *    reported.
 *  - a **hand-made** worktree on a `pe/*` branch — an operator who ran
 *    `git worktree add ../scratch pe/demo` to look at a run's work. It is
 *    real, it may hold real work, and it is holding the branch. That is a
 *    fact somebody needs told and NOT a thing to delete: the whole discipline
 *    of the sweeps is that a checkout holding work is kept and named.
 *
 * Only `pe/*` is reported, because only `pe/*` is this console's naming. A
 * developer's own feature branch checked out in their own second tree is none
 * of its business and saying so would be noise.
 */
export async function sweepUnmanaged(root: string, opts?: {
  /** Directories the console manages — the state root(s); anything under them is ours. */
  managed?: Iterable<string>;
}): Promise<UnmanagedSweep> {
  const out = await git(root, ['worktree', 'list', '--porcelain']);
  if (!out.ok) return { pruned: [], unmanaged: [] };

  const managed = [...(opts?.managed ?? [])].map((dir) => realish(dir));
  const ours = (dir: string): boolean => managed.some(
    (base) => dir === base || `${dir}/`.startsWith(`${base}/`),
  );

  const pruned: string[] = [];
  const unmanaged: { dir: string; branch: string }[] = [];
  let dir = '';
  let branch = '';
  let prunable = false;
  const flush = (): void => {
    if (!dir) return;
    if (prunable) pruned.push(dir);
    else if (/^pe\//.test(branch) && !ours(dir) && realish(dir) !== realish(root)) {
      unmanaged.push({ dir, branch });
    }
    dir = ''; branch = ''; prunable = false;
  };
  for (const raw of out.stdout.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('worktree ')) {
      flush();
      dir = realish(line.slice('worktree '.length).trim());
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      prunable = true;
    }
  }
  flush();

  // One prune for the lot: it drops every registration whose directory is
  // gone, which is exactly the set collected above.
  if (pruned.length) await git(root, ['worktree', 'prune']);
  return { pruned, unmanaged };
}

/**
 * Every branch this console minted for `slug`, in one repository.
 *
 * `pe/<slug>` and its lane siblings `pe/<slug>-p<N>` — the hyphen is what makes
 * them siblings rather than children, because `pe/<slug>/p4` is impossible in
 * git while `pe/<slug>` exists. `for-each-ref` rather than `git branch`: the
 * read is on the console-wide allow-list already, so the `branch` exemption
 * covers the DELETE and nothing else.
 */
export async function runBranches(repo: string, slug: string): Promise<string[]> {
  const out = await git(repo, [
    'for-each-ref', '--format=%(refname:short)', `refs/heads/pe/${slug}`, `refs/heads/pe/${slug}-*`,
  ]);
  if (!out.ok) return [];
  // 🔴 …and then filtered EXACTLY, because the glob is not the rule. Slugs
  // share prefixes: `pe/state-path-*` matches `pe/state-path-hardening`, a
  // different plan's branch, and this list feeds a DELETE. The lane form is
  // `-p<N>` and nothing else, so say so — a glob that is one character wider
  // than its intent is a glob that eventually deletes somebody's work.
  const lane = new RegExp(`^pe/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-p\\d+)?$`);
  return out.stdout.split('\n').map((line) => line.trim())
    .filter((name) => lane.test(name));
}

/** What a merged-branch deletion did, per repository. */
export type BranchSweep = {
  /** Branches deleted, `<repo-rel> · <branch>` for a mirror, bare for one repo. */
  deleted: string[];
  /** Branches left standing, with why — unmerged, checked out, or git declined. */
  kept: { branch: string; reason: string }[];
};

/**
 * Delete the run's own branches once their work has landed.
 *
 * The hygiene half of "two plans on one repository": a console that drives
 * thirty runs leaves thirty `pe/<slug>` refs and every lane branch beside
 * them, for ever, and `git branch` becomes unreadable. Once the pull request
 * is MERGED the commits are on the target and the branch is a name for
 * something that already happened.
 *
 * 🔴 `-d`, NEVER `-D`, and that is the whole safety argument rather than a
 * style preference. `-d` is git's own refusal to delete a branch whose commits
 * are not reachable from somewhere else; `-D` is the same command with the
 * refusal removed. The merge check below is belt, `-d` is braces, and the one
 * thing this function may never do is destroy a commit that exists nowhere
 * else — so if the two ever disagree, git wins and the branch stays.
 *
 * The read is `for-each-ref --merged`, not `git branch --merged`: it answers
 * the identical question with a verb that is already on the console-wide
 * allow-list, so the exemption `branch` needs is for the DELETE alone.
 */
export async function deleteMergedBranches(opts: {
  /** Where to run: one repository, or every mount of a mirror. */
  repos: { rel: string; source: string }[];
  /** The branches to retire, in order. */
  branches: string[];
  /** What they must be merged into — the PR's base, or the default branch. */
  target: string;
}): Promise<BranchSweep> {
  const deleted: string[] = [];
  const kept: { branch: string; reason: string }[] = [];

  for (const repo of opts.repos) {
    // Which of the candidates are merged into the target HERE. A mirror's
    // repositories are unrelated object databases, so this is asked per mount
    // and never once for the lot.
    const listed = await git(repo.source, [
      'for-each-ref', '--merged', opts.target, '--format=%(refname:short)', 'refs/heads/',
    ]);
    if (!listed.ok) continue;
    const merged = new Set(listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean));

    for (const branch of opts.branches) {
      const label = qualifiedRef(repo.rel, branch);
      if (!merged.has(branch)) continue; // not here, or not merged — either way, not ours to delete
      // A branch that is still CHECKED OUT somewhere cannot be deleted and
      // git would say so; asking first turns a `fatal:` into a sentence.
      const held = await checkedOutIn(repo.source, branch);
      if (held) { kept.push({ branch: label, reason: `checked out at ${held}` }); continue; }
      const out = await git(repo.source, ['branch', '-d', branch]);
      if (out.ok) deleted.push(label);
      else kept.push({ branch: label, reason: firstLine(out.stderr) || 'git declined' });
    }
  }

  return { deleted, kept };
}

/**
 * The line worth reporting from a failed git invocation.
 *
 * NOT simply the first one. `git worktree add` opens with a progress line —
 * *"Preparing worktree (new branch 'pe/demo-p4')"* — and prints the reason it
 * failed underneath, so taking line one reported a cheerful sentence about
 * something that did not happen and hid the `fatal:` entirely. The error lines
 * win; the first line is the fallback for the verbs that lead with theirs.
 */
function firstLine(text: string): string {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^(fatal|error|warning):/i.test(l)) ?? lines[0] ?? '';
}

/* ================================================================== *
 * The monitoring probe.
 *
 * Everything above BUILDS trees; everything below only LOOKS at them.
 * It lives in this file for one reason and it is the gate: `never-push`
 * lets exactly one file run a repository verb, so a probe anywhere else
 * would have to widen the ban list for all sixty-odd server files to ask
 * a read-only question. The verbs it adds — `merge-tree`, and nothing
 * else — are named in `test/never-push.test.ts`'s `WORKTREE_VERBS`,
 * which is the reviewable act.
 *
 * `merge-tree --write-tree` is the whole reason a radar is affordable.
 * It merges two commits in memory, writes only loose objects, touches no
 * ref, needs no checkout, and exits 1 when the result would conflict —
 * so "would these two branches collide" costs one process instead of a
 * throwaway worktree and a merge somebody then has to abort. It is not a
 * mutating verb in the sense the ban list means: nothing it does is
 * visible to any branch, any index, or any working tree.
 *
 * ## Every probe answers `unknown`, never an error
 *
 * A probe is a supervision aid. A repository that has moved under us, a
 * branch an operator deleted, a `du` that is not on this machine — none
 * of those is news about the RUN, and a monitoring layer that can turn a
 * healthy run's page red is worse than one that occasionally says it
 * does not know. So each function below has exactly one failure mode:
 * `undefined` for a number, `'unknown'` for a verdict, `[]` for a list.
 * ================================================================== */

/** How far a branch has moved from the base, both ways. `undefined` = unknown. */
export type Divergence = { ahead: number; behind: number };

/** A registered checkout of this repository, as `worktree list` sees it. */
export type CheckoutEntry = {
  /** Absolute path, as git prints it (symlinks resolved). */
  dir: string;
  /** The branch it stands on, absent for a detached HEAD or a bare entry. */
  branch?: string;
  /** Is this the repository's own root checkout — the operator's tree? */
  root: boolean;
  /** Does it live under the console's state directory, i.e. did we make it? */
  managed: boolean;
  /** `worktree list` still prints a checkout whose directory is gone. */
  prunable: boolean;
  /** Bytes on disk, when `du` could answer. Managed trees only. */
  disk?: number;
  /**
   * Which mounted repository this entry belongs to (root-relative), present
   * only on a MIRROR probe's entries — a mirror's registry spans N
   * repositories, and a path alone does not say which one answered.
   */
  repo?: string;
};

/**
 * What two branches would do to each other if they met.
 *
 * The words are `shared/worktree-model.js`'s (`RADAR_STATES`), declared
 * there in phase 5 ahead of the probe that measures them and re-exported
 * here so a server-side reader has one import rather than two.
 * `overlap` is the one that justifies the feature: it is the state
 * BEFORE the textual conflict — two lanes editing the same file merge
 * cleanly right up until the edits touch the same lines, and the useful
 * moment to tell an operator is while serializing them is still cheap.
 */
export type { RadarState };

export type RadarPair = {
  a: string;
  b: string;
  state: RadarState;
  /** The files the verdict is about: the overlap, or the conflicted subset. */
  files: string[];
};

/** One run's git situation, as the console can observe it from outside. */
export type RunGitView = {
  /** When this was probed — the whole point of a cached view. */
  at: string;
  /** The branch everything here is measured against: the root checkout's own. */
  base?: string;
  /** The run branch, when the run has one. */
  branch?: string;
  /** The run's isolated checkout, when it has one. */
  workRoot?: string;
  /** Ahead/behind of `branch` vs `base`. Absent = could not ask. */
  divergence?: Divergence;
  /** Files `branch` changed since it left `base`, capped. */
  files: string[];
  /** Were there more than the cap? A list that silently stops is a lie. */
  filesTruncated: boolean;
  /** Bytes the run's own checkout occupies. */
  disk?: number;
  /** Every checkout of this repository, root included. */
  checkouts: CheckoutEntry[];
  /** Pairwise verdicts over the live branches, worst first. */
  radar: RadarPair[];
};

/** Files listed on the run's own card. Enough to read, small enough to send. */
const FILE_CAP = 200;

/** Files named by a radar verdict. A pair's story, not a file listing. */
const RADAR_FILE_CAP = 20;

/**
 * The branch the operator's own checkout is standing on.
 *
 * This is the "default branch" every measurement below is relative to, and
 * it is deliberately OBSERVED rather than configured: the console never
 * touches the root checkout, so whatever is standing there is what the
 * operator considers home, whether that is `main`, a release branch, or a
 * plan branch from last week. A detached root yields `undefined` and every
 * comparison downgrades to `unknown` rather than guessing at `main`.
 */
export async function baseBranch(root: string): Promise<string | undefined> {
  const out = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = out.ok ? out.stdout.trim() : '';
  return name && name !== 'HEAD' ? name : undefined;
}

/**
 * How far `branch` has moved from `base`, both ways, in one process.
 *
 * `rev-list --count --left-right base...branch` answers both halves at
 * once — `behind<TAB>ahead` — where two separate `--count` runs would be
 * two forks and, worse, two moments: a commit landing between them makes
 * the pair describe a repository that never existed.
 */
export async function divergence(
  root: string, branch: string, base: string,
): Promise<Divergence | undefined> {
  const out = await git(root, ['rev-list', '--left-right', '--count', `${base}...${branch}`]);
  if (!out.ok) return undefined;
  const [behind, ahead] = out.stdout.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return undefined;
  return { ahead, behind };
}

/**
 * The files `b` changed since it and `a` last agreed.
 *
 * Three dots, not two, and the difference is the whole reason a radar can
 * treat the base as just another participant. `a..b` is "everything b has
 * that a lacks", which after the base moves on includes commits that have
 * nothing to do with b's work; `a...b` is measured from the merge base, so
 * it is exactly what THIS branch did. Both sides of a pair are asked the
 * same way, which makes the intersection below symmetric.
 */
async function changedFiles(root: string, a: string, b: string, cap: number): Promise<string[]> {
  const out = await git(root, ['diff', '--name-only', `${a}...${b}`]);
  if (!out.ok) return [];
  return out.stdout.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, cap);
}

/** The same, plus whether the cap swallowed anything. */
export async function changedSince(
  root: string, base: string, branch: string, cap = FILE_CAP,
): Promise<{ files: string[]; truncated: boolean }> {
  const files = await changedFiles(root, base, branch, cap + 1);
  return { files: files.slice(0, cap), truncated: files.length > cap };
}

/**
 * Every checkout of this repository.
 *
 * One `worktree list --porcelain` for two questions the operator asks
 * separately — "what else is checked out" and "who is holding my branch" —
 * because they are one fact and two calls could disagree about it.
 *
 * `managed` is decided by PATH, not by branch name: the console's trees
 * live under its own state directory and an operator's hand-made
 * `../repo-pe-<slug>` does not, even though both stand on a `pe/…` branch.
 * The distinction matters exactly once, for `disk` — we may report on what
 * we made, and measuring someone else's checkout is not our business.
 */
export async function checkouts(
  root: string, stateRoot?: string | readonly string[], env?: NodeJS.ProcessEnv,
): Promise<CheckoutEntry[]> {
  const out = await git(root, ['worktree', 'list', '--porcelain'], env);
  if (!out.ok) return [];
  const home = realish(root);
  // Every home a console-made tree may stand in — the configured root AND the
  // older one, so a tree made before the setting flipped still reads as ours.
  const managedBases = (typeof stateRoot === 'string' ? [stateRoot] : [...(stateRoot ?? [])])
    .map((dir) => realish(dir));
  // A base names either a PARENT of our trees (`runs/`, the state directory)
  // or one tree itself (the staging checkout), so equality counts too — the
  // same two arms `sweepUnmanaged` uses, or the two would disagree about the
  // one tree `pe/integration` lives in.
  const ours = (dir: string): boolean => managedBases.some((base) => dir === base || dir.startsWith(`${base}${sep}`));
  const entries: CheckoutEntry[] = [];
  let current: CheckoutEntry | null = null;

  for (const raw of out.stdout.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('worktree ')) {
      const dir = realish(line.slice('worktree '.length).trim());
      current = {
        dir,
        root: dir === home,
        managed: ours(dir),
        prunable: false,
      };
      entries.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true;
    }
  }

  // git's own quirk, corrected here so every reader sees a tree: inside a
  // repository whose git directory lives elsewhere — a submodule's
  // `.git/modules/<name>` under its superproject — `worktree list` prints THAT
  // directory as the main working tree rather than the tree itself. The
  // repository's working directory is the one we were asked about, and it is
  // the row a person is looking for.
  if (!entries.some((entry) => entry.dir === home)) {
    const common = await git(root, ['rev-parse', '--git-common-dir'], env);
    const spelled = common.ok ? common.stdout.trim() : '';
    const commonDir = spelled ? realish(isAbsolute(spelled) ? spelled : join(root, spelled)) : '';
    for (const entry of entries) {
      if (commonDir && entry.dir === commonDir) {
        entry.dir = home;
        entry.root = true;
        entry.managed = ours(home);
      }
    }
  }
  return entries;
}

/**
 * Bytes a directory occupies, or `undefined`.
 *
 * `du -sk` rather than a recursive walk in node: a checkout of this
 * repository is tens of thousands of files, and a probe that costs a
 * hundred thousand `stat` calls every five minutes is a monitoring layer
 * that becomes the thing worth monitoring. A machine without `du`, or a
 * directory that has gone, answers `undefined` like every other probe.
 */
export async function treeDisk(dir: string): Promise<number | undefined> {
  if (!existsSync(dir)) return undefined;
  const out = await new Promise<{ ok: boolean; stdout: string }>((done) => {
    execFile('du', ['-sk', dir], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', BLOCKSIZE: '1024' },
    }, (error, stdout) => done({ ok: !error, stdout: String(stdout) }));
  });
  if (!out.ok) return undefined;
  const kb = Number(out.stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(kb) ? kb * 1024 : undefined;
}

/**
 * Would these two branches collide?
 *
 * Two rungs, cheapest first, because the expensive one is only ever
 * interesting when the cheap one already said yes:
 *
 *  1. **Do they touch the same files at all?** The intersection of what
 *     each changed since their merge base. Empty means `clean`, and that
 *     is the overwhelmingly common answer for two phases of one plan —
 *     one `diff --name-only` each and we are done.
 *  2. **Would the merge itself conflict?** Only then, `merge-tree
 *     --write-tree`, which merges in memory and exits 1 with the
 *     conflicted paths.
 *
 * So `overlap` is the honest middle: the same files, no textual conflict
 * YET. That is the state where serializing the two lanes is still cheap,
 * which is the only reason a radar is worth having — a `conflicted`
 * verdict arrives when the damage is already done.
 */
export async function radarPair(root: string, a: string, b: string): Promise<RadarPair> {
  const [fromA, fromB] = await Promise.all([
    changedFiles(root, b, a, FILE_CAP),
    changedFiles(root, a, b, FILE_CAP),
  ]);
  // A branch that answered nothing at all is not the same as a branch that
  // changed nothing, and only one of the two is safe to call `clean`.
  const ok = await refExists(root, a) && await refExists(root, b);
  if (!ok) return { a, b, state: 'unknown', files: [] };

  const inB = new Set(fromB);
  const overlap = fromA.filter((file) => inB.has(file));
  if (!overlap.length) return { a, b, state: 'clean', files: [] };

  const merged = await git(root, ['merge-tree', '--write-tree', '--name-only', a, b]);
  // Exit 1 IS the conflict answer, so a non-ok run is not a failed probe —
  // it is the interesting result. A probe that could not run at all prints
  // nothing on stdout, and that is the case that stays `unknown`.
  const lines = merged.stdout.split('\n');
  if (!merged.ok && lines.length > 1) {
    // `<tree oid>` then the conflicted paths, then a blank line and git's
    // prose. Only the middle section is data.
    const files: string[] = [];
    for (const raw of lines.slice(1)) {
      const line = raw.trim();
      if (!line) break;
      files.push(line);
    }
    if (files.length) return { a, b, state: 'conflicted', files: files.slice(0, RADAR_FILE_CAP) };
  }
  if (!merged.ok) return { a, b, state: 'unknown', files: overlap.slice(0, RADAR_FILE_CAP) };
  return { a, b, state: 'overlap', files: overlap.slice(0, RADAR_FILE_CAP) };
}

/**
 * Do two probes say the same thing about the repository?
 *
 * Compared through an ALLOWLIST of the facts an operator reads off the card,
 * never by stripping the fields known to move. Two move on their own: `at`, the
 * probe's own clock, and `disk` — `du` of a tree a session is writing into,
 * which changes on every tick for as long as the session lives. The first cut
 * stripped `at` alone, so every five-minute probe of a run with a live lane was
 * "news" and the `run:git` stream fired on a timer — the firehose the
 * transition rule exists to prevent (console-parallel-repaint P1, W4). And a
 * strip-list is the wrong shape for that: the next timestamp-ish field would
 * have re-opened the firehose silently. The allowlist is typed TOTAL over
 * `RunGitView` minus the two clocks, so adding a field to the view is a type
 * error here until somebody decides whether it is a fact or a clock.
 *
 * What survives is everything a person can act on: a commit (`divergence`,
 * `files`), a new or vanished checkout, a branch moving, a radar verdict.
 */
export function sameGitFacts(a: RunGitView | null, b: RunGitView | null): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(gitFacts(a)) === JSON.stringify(gitFacts(b));
}

/** The facts of a view — total over the type minus its two clocks, by construction. */
function gitFacts(view: RunGitView): Record<Exclude<keyof RunGitView, 'at' | 'disk'>, unknown> {
  return {
    base: view.base,
    branch: view.branch,
    workRoot: view.workRoot,
    divergence: view.divergence,
    files: view.files,
    filesTruncated: view.filesTruncated,
    // Per-checkout `disk` is the same clock, one level down.
    checkouts: view.checkouts.map(({ disk: _disk, ...entry }) => entry),
    radar: view.radar,
  };
}

/**
 * Worst first, so a truncated render still shows the thing that matters.
 *
 * `unknown` sorts ABOVE `clean` on purpose and that is the ordering
 * `RADAR_STATES`'s own doc argues for: a pair the probe could not measure
 * is not a safe pair, and burying it under the ones that were measured
 * and found fine is how it would come to read as one.
 *
 * A `Record<RadarState, …>` and not an ordered array of the words: the
 * compiler holds the keys total against the vocabulary's owner, so a
 * fifth verdict is a type error here rather than a rank of `undefined`
 * that sorts silently — and `test/vocab-owners.test.ts` permits exactly
 * this shape for exactly that reason, while a re-typed array or union of
 * the same four words is the second source of truth it forbids.
 */
const RADAR_RANK: Record<RadarState, number> = { conflicted: 0, overlap: 1, unknown: 2, clean: 3 };

/**
 * A pair's identity, order-independent — `a×b` and `b×a` are one question.
 *
 * Re-exported, not defined: `shared/worktree-model.js` owns it so that
 * `server/inbox.ts` can recognise a key without importing this module (the
 * `RadarState` arrangement, for the same reason). Every server-side caller
 * keeps its one import from here.
 */
export { pairKey };

/**
 * Everything a run's Git card needs, in one pass.
 *
 * Deliberately ONE function rather than a surface per fact: the numbers
 * only mean anything together (ahead of WHAT, overlapping with WHOM), and
 * a caller assembling them from four awaits would be describing four
 * different moments of a repository that other sessions are committing to.
 *
 * The radar's participants are every branch with a live checkout —
 * console-managed or not — plus the base. Not "the branches this console
 * started", because a conflict does not care who created the tree: the
 * operator's own hand-made worktree on `pe/<other-plan>` collides exactly
 * as hard, and it is the one the console would otherwise never mention.
 */
export async function probeRunGit(opts: {
  root: string;
  branch?: string;
  workRoot?: string;
  /** The console's managed directories (every worktree home), to tell our trees from an operator's. */
  stateRoot?: string | readonly string[];
}): Promise<RunGitView> {
  const { root, branch, workRoot } = opts;
  const at = new Date().toISOString();
  const base = await baseBranch(root);
  const registry = await checkouts(root, opts.stateRoot);

  for (const entry of registry) {
    if (entry.managed && !entry.prunable) entry.disk = await treeDisk(entry.dir);
  }

  const view: RunGitView = {
    at,
    ...(base ? { base } : {}),
    ...(branch ? { branch } : {}),
    ...(workRoot ? { workRoot } : {}),
    files: [],
    filesTruncated: false,
    checkouts: registry,
    radar: [],
  };

  if (branch && base && await refExists(root, branch)) {
    view.divergence = await divergence(root, branch, base);
    const changed = await changedSince(root, base, branch);
    view.files = changed.files;
    view.filesTruncated = changed.truncated;
  }
  if (workRoot) {
    const here = registry.find((entry) => entry.dir === realish(workRoot));
    view.disk = here?.disk ?? await treeDisk(workRoot);
  }

  // The participants: every branch that has a checkout right now, plus the
  // base. A `Set` because the base usually IS the root checkout's branch,
  // and asking a branch about itself is not a question.
  const live = new Set<string>();
  for (const entry of registry) {
    if (entry.branch && !entry.prunable) live.add(entry.branch);
  }
  if (base) live.add(base);
  const participants = [...live].sort();

  for (let i = 0; i < participants.length; i += 1) {
    for (let j = i + 1; j < participants.length; j += 1) {
      view.radar.push(await radarPair(root, participants[i], participants[j]));
    }
  }
  view.radar.sort((x, y) => RADAR_RANK[x.state] - RADAR_RANK[y.state]
    || pairKey(x.a, x.b).localeCompare(pairKey(y.a, y.b)));

  return view;
}

/**
 * `probeRunGit` for a MIRROR: each mounted repository is probed on its own —
 * base, divergence, files, checkouts, radar — and the answers aggregate into
 * ONE view whose checkout entries say which repository they belong to and
 * whose radar keys are repo-qualified (`qualifiedRef`), because `pe/<slug>`
 * in two mounted repositories is two unrelated refs that happen to share a
 * name. No top-level `base` or `divergence`: there is no honest single
 * number over N repositories, and `unknown` beats a made-up one.
 */
export async function probeMirrorGit(opts: {
  root: string;
  branch: string;
  workRoot: string;
  /** Root-relative paths of the mounted repositories. */
  mounts: readonly string[];
  stateRoot?: string | readonly string[];
}): Promise<RunGitView> {
  const view: RunGitView = {
    at: new Date().toISOString(),
    branch: opts.branch,
    workRoot: opts.workRoot,
    files: [],
    filesTruncated: false,
    checkouts: [],
    radar: [],
  };
  view.disk = await treeDisk(opts.workRoot);

  for (const rel of opts.mounts) {
    const source = join(opts.root, rel);
    const base = await baseBranch(source);
    const registry = await checkouts(source, opts.stateRoot);
    for (const entry of registry) {
      if (entry.managed && !entry.prunable) entry.disk = await treeDisk(entry.dir);
      view.checkouts.push({ ...entry, repo: rel });
    }
    if (base && await refExists(source, opts.branch)) {
      const changed = await changedSince(source, base, opts.branch);
      view.files.push(...changed.files.map((file) => join(rel, file)));
      if (changed.truncated) view.filesTruncated = true;
    }
    // The radar, per repository: every branch with a live checkout HERE, plus
    // this repository's own base. Cross-repository pairs are never asked —
    // two refs in unrelated object databases have no merge-base to measure.
    const live = new Set<string>();
    for (const entry of registry) {
      if (entry.branch && !entry.prunable) live.add(entry.branch);
    }
    if (base) live.add(base);
    const participants = [...live].sort();
    for (let i = 0; i < participants.length; i += 1) {
      for (let j = i + 1; j < participants.length; j += 1) {
        const pair = await radarPair(source, participants[i], participants[j]);
        view.radar.push({
          ...pair,
          a: qualifiedRef(rel, pair.a),
          b: qualifiedRef(rel, pair.b),
          files: pair.files.map((file) => join(rel, file)),
        });
      }
    }
  }

  if (view.files.length > FILE_CAP) {
    view.files = view.files.slice(0, FILE_CAP);
    view.filesTruncated = true;
  }
  view.radar.sort((x, y) => RADAR_RANK[x.state] - RADAR_RANK[y.state]
    || pairKey(x.a, x.b).localeCompare(pairKey(y.a, y.b)));
  return view;
}
