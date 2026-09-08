/**
 * `server/landing.ts` — the packet a finished plan hands the operator.
 *
 * Every assertion here runs against a real throwaway git repository, for the
 * reason `git.test.ts` gives: these functions shell out, and a mocked git can
 * only prove that the code calls the arguments it was written to call. What
 * matters is whether the bundle git actually wrote can be fetched back and
 * whether the commits that arrive are the ones `git log` names.
 *
 * The two exit criteria this file carries (plan §Phase 15):
 *   1. one compose yields a downloadable bundle + patch series MATCHING git log;
 *   2. …with the never-push invariant intact — `never-push.test.ts` pins that
 *      half statically, and the ref-state assertions here pin it dynamically.
 *
 * Needs `git` on PATH and a writable tmpdir. No plan library, no client build.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  composeLanding, landingFile, planWindow, readLanding,
  LANDING_SCHEMA_VERSION, MANIFEST, PATCH_DIR,
} = await import('../server/landing.ts');

const TRASH: string[] = [];
process.on('exit', () => {
  for (const dir of TRASH) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TRASH.push(dir);
  return dir;
}

/** Identity + signing forced per-invocation: the operator's ~/.gitconfig must not decide a test. */
function git(cwd: string, ...args: string[]): string {
  return String(execFileSync('git', [
    '-c', 'user.name=Phase Console Test',
    '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false',
    '-c', 'init.defaultBranch=main',
    ...args,
  ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
}

function commit(repo: string, path: string, body: string, subject: string): void {
  const full = join(repo, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
  git(repo, 'add', '--', path);
  git(repo, 'commit', '-m', subject);
}

/**
 * A repository with history BEFORE the plan exists, then the plan, then phases.
 *
 * The pre-plan commit is the point: a landing that starts from the root commit
 * would look correct in a repo whose first commit is the plan's.
 */
function planRepo(): { repo: string; planPath: string; handoffDir: string; preSha: string } {
  const repo = scratch('pc-landing-');
  git(repo, 'init', '--quiet', '.');
  commit(repo, 'README.md', 'before the plan\n', 'chore: the repository already existed');
  commit(repo, 'src/app.ts', 'export const a = 1;\n', 'feat: unrelated earlier work');
  const preSha = git(repo, 'rev-parse', 'HEAD').trim();

  commit(repo, 'docs/plans/demo.md', '# demo\n', 'plan(demo): the plan lands first');
  commit(repo, 'src/one.ts', 'export const one = 1;\n', 'feat(demo): phase 1 code');
  commit(repo, 'docs/handoffs/demo/phase-01-one.md', 'p1\n', 'docs(demo): phase 1 handoff');
  commit(repo, 'src/two.ts', 'export const two = 2;\n', 'feat(demo): phase 2 code');
  commit(repo, 'docs/handoffs/demo/phase-02-two.md', 'p2\n', 'docs(demo): phase 2 handoff');

  return { repo, planPath: join(repo, 'docs/plans/demo.md'), handoffDir: join(repo, 'docs/handoffs/demo'), preSha };
}


/* ------------------------------------------------------------------ *
 * planWindow
 * ------------------------------------------------------------------ */

test('planWindow: the base is the commit BEFORE the plan first touched the repo', async () => {
  const { repo, planPath, handoffDir, preSha } = planRepo();

  const window = await planWindow({ root: repo, planPath, handoffDir });
  assert.equal(window.kind, 'plan-window');
  assert.equal(window.base, preSha,
    'not the newest handoff landing (that is the review window) and not the root commit');
  assert.match(window.base ?? '', /^[0-9a-f]{40}$/,
    'the FULL sha: this goes in a manifest another tool resolves, where an abbreviation can collide');
  assert.equal(window.tip, 'HEAD', 'a landing carries what is on the branch NOW, including post-handoff commits');
  assert.match(window.note, /before this plan first touched/);
});

test('planWindow: the plan file counts, not only the handoffs', async () => {
  const { repo, planPath, handoffDir, preSha } = planRepo();

  // Handoffs alone would bracket from the phase-1 handoff's parent, which is
  // inside the plan's own work: the plan commit and phase 1's code would be
  // outside the landing.
  const handoffsOnly = await planWindow({ root: repo, handoffDir });
  const both = await planWindow({ root: repo, planPath, handoffDir });
  assert.notEqual(handoffsOnly.base, both.base, 'the plan commit is older than any handoff here');
  assert.equal(both.base, preSha);
});

test('planWindow: an explicit range wins, and a rev that does not resolve is ignored', async () => {
  const { repo, planPath, handoffDir, preSha } = planRepo();
  const head = git(repo, 'rev-parse', 'HEAD').trim();

  const explicit = await planWindow({ root: repo, planPath, handoffDir, base: preSha, tip: head });
  assert.equal(explicit.kind, 'explicit');
  assert.equal(explicit.base, preSha);

  const nonsense = await planWindow({ root: repo, planPath, handoffDir, base: 'not-a-rev' });
  assert.equal(nonsense.kind, 'plan-window', 'an unresolvable override falls back rather than bracketing on a lie');
});

test('planWindow: nothing committed is `none` with a reason, never a range over the whole repo', async () => {
  const repo = scratch('pc-landing-bare-');
  git(repo, 'init', '--quiet', '.');
  commit(repo, 'README.md', 'x\n', 'chore: init');

  const window = await planWindow({ root: repo, planPath: join(repo, 'docs/plans/ghost.md') });
  assert.equal(window.kind, 'none');
  assert.match(window.note, /Commit the plan first/);
});

/* ------------------------------------------------------------------ *
 * composeLanding — exit criterion 1
 * ------------------------------------------------------------------ */

test('composeLanding: the bundle and the patch series are exactly what git log names', async () => {
  const { repo, planPath, handoffDir, preSha } = planRepo();
  const dir = join(scratch('pc-landing-out-'), 'landing');
  const before = git(repo, 'for-each-ref', '--format=%(refname) %(objectname)');

  const outcome = await composeLanding({ root: repo, slug: 'demo', dir, planPath, handoffDir });
  assert.equal(outcome.ok, true, outcome.detail);
  const packet = outcome.packet!;

  // The manifest's commit list IS `git log base..HEAD`, subject for subject.
  const expected = git(repo, 'log', '--format=%s', `${preSha}..HEAD`).trim().split('\n');
  assert.deepEqual(packet.commits.map((c) => c.subject), expected);
  assert.equal(packet.commitCount, expected.length);
  assert.equal(packet.commitsTruncated, false);
  assert.equal(packet.version, LANDING_SCHEMA_VERSION);
  assert.equal(packet.repo.branch, 'main');

  // Every file the manifest lists is on disk with the size it claims, and
  // nothing the manifest does not list is in the directory. That biconditional
  // is what makes `files` usable as the download whitelist.
  for (const file of packet.files) {
    const abs = join(dir, file.name);
    assert.ok(existsSync(abs), `${file.name} is listed and missing`);
    assert.ok(file.bytes > 0, `${file.name} claims ${file.bytes} bytes`);
  }
  const onDisk = [
    ...readdirSync(dir).filter((n) => n !== PATCH_DIR),
    ...readdirSync(join(dir, PATCH_DIR)).map((n) => `${PATCH_DIR}/${n}`),
  ].sort();
  assert.deepEqual(onDisk, packet.files.map((f) => f.name).sort(), 'no unlisted file in the packet directory');

  // Patch numbering is apply order, and there is one per commit.
  assert.equal(packet.patches.files.length, expected.length);
  assert.match(packet.patches.files[0], /^0001-/);

  assert.equal(git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'), before,
    'composing a landing moved no ref: the console still cannot write to the repository');

  // The strongest form of "matching git log": fetch the bundle back.
  const receiver = scratch('pc-landing-recv-');
  git(receiver, 'clone', '--quiet', repo, '.');
  git(receiver, 'reset', '--hard', preSha);
  git(receiver, 'fetch', join(dir, packet.bundle!.name), 'main');
  assert.deepEqual(git(receiver, 'log', '--format=%s', `${preSha}..FETCH_HEAD`).trim().split('\n'), expected,
    'the bundle really carries the range, into a repository that only had the base');
});

test('composeLanding: the packet says what it does NOT carry', async () => {
  const { repo, planPath, handoffDir } = planRepo();
  writeFileSync(join(repo, 'src/dirty.ts'), 'export const d = 1;\n');
  const dir = join(scratch('pc-landing-dirty-'), 'landing');

  const outcome = await composeLanding({ root: repo, slug: 'demo', dir, planPath, handoffDir });
  assert.equal(outcome.ok, true, outcome.detail);
  const notes = outcome.packet!.notes.join('\n');
  assert.match(notes, /uncommitted/, 'an uncommitted file is silently absent from a bundle unless somebody says so');
  assert.match(notes, /no upstream/, 'and the branch being unpushed is the expected state, stated');
});

test('composeLanding: composing again REPLACES the packet, leaving no stale patch behind', async () => {
  const { repo, planPath, handoffDir } = planRepo();
  const dir = join(scratch('pc-landing-again-'), 'landing');

  const first = await composeLanding({ root: repo, slug: 'demo', dir, planPath, handoffDir });
  assert.equal(first.ok, true, first.detail);
  const firstCount = first.packet!.patches.files.length;

  // A stale `0001-` from the previous series is a DIFFERENT commit from the new
  // one, so leaving it beside the fresh series is worse than leaving nothing.
  writeFileSync(join(dir, PATCH_DIR, '9999-stale-from-an-older-compose.patch'), 'junk\n');
  writeFileSync(join(dir, 'left-over.bundle'), 'junk\n');

  commit(repo, 'src/three.ts', 'export const three = 3;\n', 'feat(demo): phase 3 code');
  const second = await composeLanding({ root: repo, slug: 'demo', dir, planPath, handoffDir });
  assert.equal(second.ok, true, second.detail);
  assert.equal(second.packet!.patches.files.length, firstCount + 1);

  assert.equal(existsSync(join(dir, PATCH_DIR, '9999-stale-from-an-older-compose.patch')), false);
  assert.equal(existsSync(join(dir, 'left-over.bundle')), false, 'an older compose\'s bundle is removed too');
  assert.deepEqual(
    readdirSync(join(dir, PATCH_DIR)).sort(),
    second.packet!.patches.files.slice().sort(),
    'the directory is exactly the manifest',
  );
});

test('composeLanding: an empty range refuses with a reason, and writes no half packet', async () => {
  const repo = scratch('pc-landing-empty-');
  git(repo, 'init', '--quiet', '.');
  commit(repo, 'docs/plans/demo.md', '# demo\n', 'plan(demo): the only commit');
  const dir = join(scratch('pc-landing-emptyout-'), 'landing');

  // The plan IS the repository's first commit, so `base` is absent and the
  // range is everything — which is not empty. Force the empty case honestly:
  // an explicit range from HEAD to HEAD.
  const outcome = await composeLanding({
    root: repo, slug: 'demo', dir, planPath: join(repo, 'docs/plans/demo.md'), base: 'HEAD', tip: 'HEAD',
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.packet, null);
  assert.match(outcome.detail, /nothing to land/);
  assert.equal(existsSync(join(dir, MANIFEST)), false, 'no manifest describing a bundle that was never written');
});

test('composeLanding: a directory that is not a repository is refused, not attempted', async () => {
  const dir = join(scratch('pc-landing-norepo-out-'), 'landing');
  const outcome = await composeLanding({ root: scratch('pc-landing-norepo-'), slug: 'demo', dir });
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /not a git repository/);
});

test('composeLanding: a plan whose first commit is the repository\'s bundles from an empty tree', async () => {
  const repo = scratch('pc-landing-root-');
  git(repo, 'init', '--quiet', '.');
  commit(repo, 'docs/plans/demo.md', '# demo\n', 'plan(demo): the first commit there is');
  commit(repo, 'src/one.ts', 'export const one = 1;\n', 'feat(demo): phase 1');
  const dir = join(scratch('pc-landing-rootout-'), 'landing');

  const outcome = await composeLanding({
    root: repo, slug: 'demo', dir, planPath: join(repo, 'docs/plans/demo.md'),
  });
  assert.equal(outcome.ok, true, outcome.detail);
  assert.equal(outcome.packet!.window.base, undefined, 'a root commit has no parent to bracket from');
  assert.equal(outcome.packet!.commitCount, 2);
  assert.deepEqual(outcome.packet!.bundle!.prerequisites, [], 'nothing is required of the receiver');
});

/* ------------------------------------------------------------------ *
 * readLanding / landingFile — the download whitelist
 * ------------------------------------------------------------------ */

test('readLanding: a future version and a corrupt manifest both read as absent', async () => {
  const { repo, planPath, handoffDir } = planRepo();
  const dir = join(scratch('pc-landing-read-'), 'landing');
  await composeLanding({ root: repo, slug: 'demo', dir, planPath, handoffDir });

  assert.ok(readLanding(dir), 'the packet just written reads back');

  const file = join(dir, MANIFEST);
  const good = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...good, version: LANDING_SCHEMA_VERSION + 1 }));
  assert.equal(readLanding(dir), undefined, 'a newer schema is not half-read');

  writeFileSync(file, '{ "version": 1, "files": ');
  assert.equal(readLanding(dir), undefined, 'a half-written manifest is not parsed');

  assert.equal(readLanding(join(dir, 'nowhere')), undefined);
});

test('landingFile: only a name the manifest lists resolves — traversal is simply not in the list', async () => {
  const { repo, planPath, handoffDir } = planRepo();
  const dir = join(scratch('pc-landing-serve-'), 'landing');
  const outcome = await composeLanding({ root: repo, slug: 'demo', dir, planPath, handoffDir });
  const packet = outcome.packet!;

  for (const file of packet.files) {
    assert.equal(landingFile(dir, file.name), join(dir, file.name), `${file.name} is servable`);
  }

  // A secret beside the packet, and every way of asking for it.
  writeFileSync(join(dir, '..', 'secret.json'), '{"token":"nope"}\n');
  for (const hostile of [
    '../secret.json',
    '../../secret.json',
    'patches/../../secret.json',
    '/etc/passwd',
    './landing.json/../../secret.json',
    'landing.json.tmp',
    'patches',
    '',
  ]) {
    assert.equal(landingFile(dir, hostile), null, `served ${JSON.stringify(hostile)}`);
  }

  // A manifest that outlived its files must not offer a 200 on nothing.
  rmSync(join(dir, packet.bundle!.name));
  assert.equal(landingFile(dir, packet.bundle!.name), null, 'listed but gone is not servable');

  // And with no manifest at all there is no whitelist, so nothing is servable —
  // including files that are plainly sitting there.
  rmSync(join(dir, MANIFEST));
  assert.equal(landingFile(dir, `${PATCH_DIR}/${packet.patches.files[0]}`), null);
});

test('the apply steps name the real bundle and the real branch', async () => {
  const { repo, planPath, handoffDir } = planRepo();
  git(repo, 'checkout', '--quiet', '-b', 'pe/demo');
  const dir = join(scratch('pc-landing-apply-'), 'landing');

  const outcome = await composeLanding({ root: repo, slug: 'demo', dir, planPath, handoffDir });
  const packet = outcome.packet!;
  const apply = packet.apply.join('\n');
  assert.match(apply, /git bundle verify/);
  assert.ok(apply.includes(packet.bundle!.name), 'the steps name the file that exists');
  assert.match(apply, /pe\/demo:pe\/demo/, 'fetched as the branch it was cut from');
  assert.match(apply, /push it yourself/, 'the one act this console will not do is spelled out');
});

test('composeLanding: git failing to write the bundle is reported, not papered over', async () => {
  const { repo, planPath, handoffDir } = planRepo();
  const dir = join(scratch('pc-landing-blocked-'), 'landing');

  // A DIRECTORY where the bundle file must go. git cannot write it, and
  // `resetDir` deliberately does not recursively delete arbitrary entries, so
  // the obstruction survives into the write — which is the point: the guard on
  // `bundleCreate`'s exit status is the only thing between this and a manifest
  // advertising a file that does not exist.
  mkdirSync(join(dir, 'demo.bundle'), { recursive: true });

  const outcome = await composeLanding({ root: repo, slug: 'demo', dir, planPath, handoffDir });
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /could not write the bundle/);
  assert.equal(existsSync(join(dir, MANIFEST)), false, 'and no manifest describes the packet that failed');
});

test('composeLanding: a packet directory that cannot be created is an answer, not a 500', async () => {
  const { repo, planPath, handoffDir } = planRepo();
  // A FILE where the directory must go.
  const base = scratch('pc-landing-blockeddir-');
  writeFileSync(join(base, 'landing'), 'in the way\n');

  const outcome = await composeLanding({ root: repo, slug: 'demo', dir: join(base, 'landing'), planPath, handoffDir });
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /could not be created/);
});
