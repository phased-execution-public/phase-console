/**
 * Settled means landed (control-tower phase 112, #184).
 *
 * A run on a hub console settled `keep` and reported `run.finished
 * {outstanding: []}` while its ROOT repository's run branch held the last two
 * phases' docs — conflicting with `main` in six files, never pushed. The plan
 * read closed complete; the work existed on one local branch nobody was told
 * about. "Settled" meant "the console stopped", not "the work landed".
 *
 * The rule these cases pin: a run reports `finished` with nothing outstanding
 * only when every mounted repository's run branch — the root's included — is
 * held by `origin/<trunk>`, proved by tree containment (`git merge-tree
 * --write-tree` equal to the trunk's own tree, never `git cherry`). Anything
 * else parks the run `unlanded` with ONE operator errand naming the branch, the
 * repository and the files, and a card whose first action opens a merge errand
 * tree. The closing brief under `landing: hold` says nothing lands the branch by
 * itself, and generated untracked files never pin a mount at the prune.
 *
 *   SL-1  a conflicted root branch parks the run `unlanded` — never `finished`,
 *         never a silent keep — with the files on the card and a merge errand tree
 *   SL-2  the proof itself (content, ancestry, ahead, conflicted — against
 *         origin/<trunk>); a squash-landed run finishes clean, its branch
 *         re-seated on what landed; one merged into LOCAL main only does not
 *   SL-3  the closing brief under `landing: hold` says nothing lands it by itself
 *   SL-4  untracked generated files are preserved under the run's state and the
 *         mount goes; a mount holding tracked edits is kept and named as an errand
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drive, git, harness, journal, superRoot, until } from './lane-harness.ts';
import { buildInbox, type InboxRun } from '../server/inbox.ts';
import { resolveRunsAgainst } from '../server/runner/state.ts';
import { landingProofs } from '../server/runner/worktree.ts';
import type { RunState } from '../server/runner/state.ts';

/**
 * A superproject whose ROOT has a bare `origin` with `origin/HEAD → main`, as
 * a clone has. The submodules' origins are their source directories already.
 */
function withOrigin(): { base: string; root: string; origin: string } {
  const { base, root } = superRoot();
  const origin = join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', 'origin', 'main');
  git(root, 'fetch', '-q', 'origin');
  git(root, 'remote', 'set-head', 'origin', 'main');
  return { base, root, origin };
}

/** Commit one file on the branch a checkout stands on. */
function commitFile(dir: string, file: string, body: string, message: string): string {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), body);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

type Proof = { mount: string; branch: string; state: string; by?: string; into?: string; files?: string[] };

function proofsOf(root: string): Proof[] {
  const lines = journal(root, 'run.landing-proof');
  assert.ok(lines.length >= 1, 'a landing proof at the settle');
  return ((lines[0]!.data ?? lines[0]) as { repos?: Proof[] }).repos ?? [];
}

test('SL-1 — a root branch that conflicts with main parks the run `unlanded`: no `finished`, the files named, a merge errand tree offered', async () => {
  const { root } = withOrigin();
  const h = harness(root, { 1: 'web', 2: 'repo' }, { planScope: () => ['web', 'repo'] }, (request, runner) => {
    if (!/BOOT phase 2\b/.test(request.prompt)) return;
    const workRoot = String(runner.current()?.workRoot);
    // The final phase's docs, on the ROOT's run branch in the mirror…
    commitFile(workRoot, 'docs/closeout.md', 'P2 closeout — the run branch\n', 'p2: closeout');
    // …while another plan's edit to the same file lands on main and is pushed.
    commitFile(root, 'docs/closeout.md', 'another plan wrote this on main\n', 'other: closeout');
    git(root, 'push', '-q', 'origin', 'main');
  });

  const state = await drive(h, {}) as unknown as RunState;
  assert.equal(state.status, 'parked', `a run whose root branch is not on origin/main is not finished: ${state.finishedReason}`);
  assert.equal(state.halt?.kind, 'unlanded');
  assert.deepEqual(journal(root, 'run.finished'), [], 'never `run.finished {outstanding: []}` over unlanded work');

  // The proof, per mounted repository, the root included.
  const proofs = proofsOf(root);
  const rootProof = proofs.find((p) => p.mount === '');
  assert.ok(rootProof, `the root is proved too: ${JSON.stringify(proofs)}`);
  assert.equal(rootProof!.state, 'conflicted');
  assert.equal(rootProof!.into, 'origin/main', 'proved against the REMOTE trunk');
  assert.deepEqual(rootProof!.files, ['docs/closeout.md']);
  const webProof = proofs.find((p) => p.mount === 'web');
  assert.equal(webProof?.state, 'contained', 'a branch with nothing of its own is held by its trunk');

  // One errand, in the words the card shows.
  assert.match(String(state.errand?.need), /pe\/demo conflicts with main in docs\/closeout\.md/);
  assert.match(String(state.halt?.reason), /conflicts with main/);
  assert.equal(journal(root, 'run.errand').length, 1);
  const parked = journal(root, 'run.parked').at(-1)!;
  const data = (parked.data ?? parked) as { outstanding?: unknown[]; unlanded?: unknown[] };
  assert.deepEqual(data.outstanding, []);
  assert.equal(data.unlanded?.length, 1, 'the park names what is unlanded');

  // The run keeps its trees: a merge errand needs the branch where it stands.
  await until(() => journal(root, 'run.worktrees-kept').length > 0, 'trees kept');
  assert.ok(existsSync(String(state.workRoot)), 'the mirror stands');

  // The card: needs-you, a conflict, and its first action opens the merge errand tree.
  const inbox = buildInbox({ runs: [state as unknown as InboxRun], flags: { allowRun: true } });
  const row = inbox.items.find((item) => item.kind === 'errand' && item.slug === 'demo');
  assert.ok(row, `an errand row: ${JSON.stringify(inbox.items.map((item) => item.kind))}`);
  assert.equal(row!.category?.word, 'conflict');
  assert.match(String(row!.title), /pe\/demo conflicts with main in docs\/closeout\.md/);
  const open = row!.actions?.[0];
  assert.equal(open?.verb, 'errand-tree');
  assert.equal(open?.label, 'Open a merge errand tree');
  assert.deepEqual(open?.body, { phase: 2 });
  assert.ok(row!.actions?.some((action) => action.verb === 'recover'), 'and the re-check once it is landed');

  // The read path leaves it parked: the board reading every phase done is not
  // what is outstanding — the landing is.
  const changed = resolveRunsAgainst([state], new Map([['demo', { 1: 'done', 2: 'done' }]]));
  assert.deepEqual(changed, []);
  assert.equal(state.status, 'parked');
  assert.equal(state.halt?.kind, 'unlanded');

  // A person lands it — the merge, resolved, pushed — and continues the run:
  // it is proved again, finishes, and the errand that asked goes with it.
  git(root, 'merge', '-q', '-X', 'theirs', '-m', 'land pe/demo', 'pe/demo');
  git(root, 'push', '-q', 'origin', 'main');
  const after = await drive(h, { resumeRunId: state.id }) as unknown as RunState;
  assert.equal(after.status, 'finished', String(after.halt?.reason ?? after.finishedReason));
  assert.equal(after.errand ?? null, null);
  assert.equal(after.unlanded, undefined);
  const verdicts = journal(root, 'run.landing-proof').map((line) => (line.data ?? line) as { landed?: boolean });
  assert.deepEqual(verdicts.map((line) => line.landed), [false, true]);
});

test('SL-2 — the proof is tree containment in origin/<trunk>: content, ancestry, ahead and conflicted, asked of the remote copy', async () => {
  const base = mkdtempSync(join(tmpdir(), 'p112-proof-'));
  try {
    const repo = join(base, 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    commitFile(repo, 'README.md', 'base\n', 'base');
    const origin = join(base, 'origin.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', origin);
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'remote', 'set-head', 'origin', 'main');
    git(repo, 'switch', '-q', '-c', 'pe/demo');
    const tip = commitFile(repo, 'docs/closeout.md', 'P2 closeout\n', 'p2: closeout');
    git(repo, 'switch', '-q', 'main');
    const proof = async () => (await landingProofs({ root: repo, runBranch: 'pe/demo' }))[0]!;

    // Not on the remote yet — merged into the LOCAL trunk only is not landed.
    git(repo, 'merge', '-q', '--squash', 'pe/demo');
    git(repo, 'commit', '-q', '-m', 'local squash');
    const local = await proof();
    assert.deepEqual([local.mount, local.branch, local.tip, local.into, local.state, local.files],
      ['', 'pe/demo', tip, 'origin/main', 'ahead', ['docs/closeout.md']]);
    // Pushed: the squash is a different commit, and the tree says it landed.
    git(repo, 'push', '-q', 'origin', 'main');
    const squashed = await proof();
    assert.equal(squashed.state, 'contained');
    assert.equal(squashed.by, 'content');
    assert.equal(squashed.tip, tip);
    assert.equal(squashed.tree, git(repo, 'rev-parse', 'refs/remotes/origin/main^{tree}'));
    // One more change of the branch's own: not landed, and named.
    git(repo, 'switch', '-q', 'pe/demo');
    commitFile(repo, 'docs/more.md', 'more\n', 'p2: more');
    git(repo, 'switch', '-q', 'main');
    assert.deepEqual([(await proof()).state, (await proof()).files], ['ahead', ['docs/more.md']]);
    // A trunk that changed the same file differently: a conflict, with its path.
    commitFile(repo, 'docs/more.md', 'other\n', 'other: more');
    git(repo, 'push', '-q', 'origin', 'main');
    assert.deepEqual([(await proof()).state, (await proof()).files], ['conflicted', ['docs/more.md']]);
    // A fast-forward is held by ancestry.
    git(repo, 'switch', '-q', '-c', 'pe/ff', 'refs/remotes/origin/main');
    assert.equal((await landingProofs({ root: repo, runBranch: 'pe/ff' }))[0]!.by, 'ancestry');
    // No branch at all: nothing of the run's lives here.
    assert.deepEqual(await landingProofs({ root: repo, runBranch: 'pe/none' }), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('SL-2 — a squash-landed run finishes clean, its branch re-seated on what landed; one merged into LOCAL main only is unlanded', async () => {
  {
    const { root } = withOrigin();
    const h = harness(root, { 1: 'web', 2: 'repo' }, { planScope: () => ['web', 'repo'] }, (request, runner) => {
      if (!/BOOT phase 2\b/.test(request.prompt)) return;
      const workRoot = String(runner.current()?.workRoot);
      commitFile(workRoot, 'docs/closeout.md', 'P2 closeout\n', 'p2: closeout');
      // The release's squash: the same content, a different commit, on origin/main.
      commitFile(root, 'docs/closeout.md', 'P2 closeout\n', 'squash: P2 closeout (#7)');
      git(root, 'push', '-q', 'origin', 'main');
    });
    const state = await drive(h, {}) as unknown as RunState;
    assert.equal(state.status, 'finished', `contained work finishes: ${String(state.halt?.reason ?? '')}`);
    assert.equal(state.halt ?? null, null);
    const finished = journal(root, 'run.finished');
    assert.equal(finished.length, 1);
    assert.deepEqual(((finished[0]!.data ?? finished[0]) as { outstanding?: unknown[] }).outstanding, []);
    // The root's branch was put on what landed before the phase's own
    // verification (#183), by the content proof — and is held by the trunk.
    const reseat = journal(root, 'run.branch-reseated').map((line) => (line.data ?? line) as { mount?: string; by?: string; into?: string });
    assert.deepEqual(reseat.map((line) => [line.mount, line.by, line.into]), [['', 'content', 'origin/main']]);
    const rootProof = proofsOf(root).find((p) => p.mount === '');
    assert.equal(rootProof?.state, 'contained');
    assert.equal(rootProof?.into, 'origin/main');
  }
  {
    const { root } = withOrigin();
    const h = harness(root, { 1: 'web', 2: 'repo' }, { planScope: () => ['web', 'repo'] }, (request, runner) => {
      if (!/BOOT phase 2\b/.test(request.prompt)) return;
      const workRoot = String(runner.current()?.workRoot);
      commitFile(workRoot, 'docs/closeout.md', 'P2 closeout\n', 'p2: closeout');
      // Merged on the LOCAL trunk, never pushed: not landed.
      commitFile(root, 'docs/closeout.md', 'P2 closeout\n', 'local: P2 closeout');
    });
    const state = await drive(h, {}) as unknown as RunState;
    assert.equal(state.status, 'parked', 'main holding it locally is not origin/main holding it');
    assert.equal(state.halt?.kind, 'unlanded');
    const rootProof = proofsOf(root).find((p) => p.mount === '');
    assert.equal(rootProof?.state, 'ahead');
    assert.equal(rootProof?.into, 'origin/main');
    assert.deepEqual(rootProof?.files, ['docs/closeout.md']);
    assert.match(String(state.errand?.need), /origin\/main does not hold/);
  }
});

test('SL-3 — under `landing: hold` the closing brief says nothing lands the branch by itself', async () => {
  const { root } = withOrigin();
  const prompts: string[] = [];
  const h = harness(root, { 1: 'web', 2: 'repo' }, { planScope: () => ['web', 'repo'] }, (request) => {
    prompts.push(request.prompt);
  });
  await drive(h, { landing: 'hold' });
  const closing = prompts.find((prompt) => /BOOT phase 2\b/.test(prompt));
  assert.ok(closing, 'the final phase boarded');
  assert.match(closing!, /Landing is `hold`/);
  assert.match(closing!, /nothing moves `pe\/demo` onto `main` by itself/);
  assert.doesNotMatch(closing!, /console (?:lands|will land|merges it into main|pushes it)/i,
    'a brief that promises a landing nobody will do is how #184 ended');
});

test('SL-4 — generated untracked files never pin a mount; a mount with tracked edits is kept and named as an errand', async () => {
  {
    const { root } = withOrigin();
    const h = harness(root, { 1: 'web', 2: 'web' }, { planScope: () => ['web', 'api'] }, (request, runner) => {
      if (!/BOOT phase 2\b/.test(request.prompt)) return;
      const web = join(String(runner.current()?.workRoot), 'web');
      // What a verification run leaves behind: caches, an empty data dir, a report.
      mkdirSync(join(web, '.statepath_cache'), { recursive: true });
      writeFileSync(join(web, '.statepath_cache', 'a.py'), 'cache\n');
      mkdirSync(join(web, 'data'), { recursive: true });
      mkdirSync(join(web, 'reports'), { recursive: true });
      writeFileSync(join(web, 'reports', 'e2e_ai_flow_live.json'), '{}\n');
    });
    const state = await drive(h, {}) as unknown as RunState;
    assert.equal(state.status, 'finished');
    await until(() => journal(root, 'run.worktrees-pruned').length > 0, 'the prune');
    const pruned = journal(root, 'run.worktrees-pruned')[0]!;
    const data = (pruned.data ?? pruned) as { kept?: string[]; preserved?: { mount: string; to: string; paths: string[] }[] };
    // Only the preserved files' own folder is kept — content a person clears,
    // like any quarantine — and no mount.
    assert.deepEqual(data.kept?.filter((dir) => !dir.endsWith(`${'/'}stale-mounts`)), [],
      `untracked generated files pinned nothing: ${JSON.stringify(data)}`);
    const web = data.preserved?.find((entry) => entry.mount === 'web');
    assert.ok(web, `the web mount's untracked files were preserved: ${JSON.stringify(data.preserved)}`);
    assert.ok(existsSync(join(web!.to, '.statepath_cache', 'a.py')), 'kept under the run\'s state, never deleted');
    assert.ok(existsSync(join(web!.to, 'reports', 'e2e_ai_flow_live.json')));
    assert.ok(!existsSync(join(String(state.workRoot), 'web')), 'and the mount went');
    assert.deepEqual(journal(root, 'run.errand'), [], 'nothing was left for a person');
  }
  {
    const { root } = withOrigin();
    const h = harness(root, { 1: 'web', 2: 'web' }, { planScope: () => ['web', 'api'] }, (request, runner) => {
      if (!/BOOT phase 2\b/.test(request.prompt)) return;
      // A tracked edit nobody committed: work, not debris.
      writeFileSync(join(String(runner.current()?.workRoot), 'web', 'index.html'), 'edited, never committed\n');
    });
    const state = await drive(h, {}) as unknown as RunState;
    await until(() => journal(root, 'run.worktrees-pruned').length > 0, 'the prune');
    const data = (journal(root, 'run.worktrees-pruned')[0]!.data ?? {}) as { kept?: string[] };
    assert.ok(data.kept?.some((dir) => dir.endsWith(`${'/'}web`)), `the dirty mount is kept: ${JSON.stringify(data)}`);
    assert.ok(existsSync(join(String(state.workRoot), 'web', 'index.html')), 'its edit is where it was');
    await until(() => journal(root, 'run.errand').length > 0, 'the kept mount reported');
    const errand = journal(root, 'run.errand')[0]!;
    const words = (errand.data ?? errand) as { need?: string; how?: string; mounts?: string[] };
    assert.match(String(words.need), /kept/);
    assert.deepEqual(words.mounts, ['web']);
    assert.match(String(words.how), /index\.html/);
    assert.ok(readdirSync(join(String(state.workRoot), 'web')).includes('index.html'));
  }
});
