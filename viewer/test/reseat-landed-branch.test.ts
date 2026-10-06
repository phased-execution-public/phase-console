/**
 * A landed branch is re-seated (control-tower phase 112, #183).
 *
 * A release phase squash-merged each repository's `pe/<slug>` and CD deployed
 * `main`. Its §Verification compared the box with the CHECKOUT — and a mirror
 * left on the merged-but-unmoved branch can never match: a squash is a
 * different commit, and `main` had moved on since. The session made the lines
 * green the only way it could, by detaching its own mirror checkout at
 * `origin/main`; the next boarding was refused `isolation-refused` ("standing
 * on a detached HEAD … switch it back or remove it"), and switching it back
 * would have re-reddened both lines. Nothing re-seated the branch on what had
 * landed.
 *
 *   RB-1  a run branch whose content `origin/main` already holds (the merge-tree
 *         proof) is re-seated on `origin/main` in the mirror at the next boundary,
 *         and the proof is journalled
 *   RB-2  a mount detached at `origin/main` with a fully landed branch is
 *         re-seated by itself when clean; when it holds edits, the refusal names
 *         that remedy instead of only "switch it back or remove it"
 *   (RB-3, the guard on a session's own detach, is in `approvals.test.ts`.)
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { drive, git, harness, journal, superRoot } from './lane-harness.ts';
import type { RunState } from '../server/runner/state.ts';

/** Commit one file in a checkout, on whatever it stands on. */
function commitFile(dir: string, file: string, body: string, message: string): string {
  writeFileSync(join(dir, file), body);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/**
 * The release's squash, as the remote sees it: the SAME change as one new
 * commit on the web repository's trunk, fetched into the mounted repository —
 * so `origin/main` holds the branch's content under a commit that is not the
 * branch's own.
 */
function squashOnOrigin(base: string, root: string): string {
  const src = join(base, 'web-src');
  commitFile(src, 'release.txt', 'the release\n', 'squash: the release (#240)');
  git(join(root, 'web'), 'fetch', '-q', 'origin');
  return git(join(root, 'web'), 'rev-parse', 'refs/remotes/origin/main');
}

type Reseat = { mount?: string; branch?: string; from?: string; to?: string; into?: string; by?: string; tree?: string };

const reseats = (root: string): Reseat[] =>
  journal(root, 'run.branch-reseated').map((line) => (line.data ?? line) as Reseat);

test('RB-1 — a squash-landed run branch is re-seated on origin/main at the next boundary, with the proof journalled', async () => {
  const { base, root } = superRoot();
  let tip = '';
  let landed = '';
  let seenByPhase2: { head: string; branch: string } | null = null;
  const h = harness(root, { 1: 'web', 2: 'web' }, { planScope: () => ['web', 'api'] }, (request, runner) => {
    const web = join(String(runner.current()?.workRoot), 'web');
    if (/BOOT phase 1\b/.test(request.prompt)) {
      tip = commitFile(web, 'release.txt', 'the release\n', 'p1: the release');
      landed = squashOnOrigin(base, root);
      return;
    }
    if (/BOOT phase 2\b/.test(request.prompt)) {
      seenByPhase2 = { head: git(web, 'rev-parse', 'HEAD'), branch: git(web, 'symbolic-ref', '--short', 'HEAD') };
    }
  });

  await drive(h, {});
  assert.ok(tip && landed && tip !== landed, 'the squash is a different commit from the branch tip');
  assert.deepEqual(seenByPhase2, { head: landed, branch: 'pe/demo' },
    'phase 2 boarded onto `pe/demo` at what landed, not the pre-squash tip');

  const lines = reseats(root);
  assert.equal(lines.length, 1, `one re-seat: ${JSON.stringify(lines)}`);
  const line = lines[0]!;
  assert.equal(line.mount, 'web');
  assert.equal(line.branch, 'pe/demo');
  assert.equal(line.from, tip);
  assert.equal(line.to, landed);
  assert.equal(line.into, 'origin/main');
  assert.equal(line.by, 'content');
  // The proof itself: merging the old tip into what landed changes nothing.
  const web = join(root, 'web');
  const merged = git(web, 'merge-tree', '--write-tree', 'refs/remotes/origin/main', tip).split('\n')[0];
  assert.equal(line.tree, merged);
  assert.equal(merged, git(web, 'rev-parse', 'refs/remotes/origin/main^{tree}'));
});

test('RB-1 — a branch with work the trunk lacks is never re-seated', async () => {
  const { base, root } = superRoot();
  let tip = '';
  let seen = '';
  const h = harness(root, { 1: 'web', 2: 'web' }, { planScope: () => ['web', 'api'] }, (request, runner) => {
    const web = join(String(runner.current()?.workRoot), 'web');
    if (/BOOT phase 1\b/.test(request.prompt)) {
      tip = commitFile(web, 'release.txt', 'the release\n', 'p1: the release');
      // The squash lands, and the branch then gains one more change of its own.
      squashOnOrigin(base, root);
      tip = commitFile(web, 'more.txt', 'not landed\n', 'p1: more');
      return;
    }
    if (/BOOT phase 2\b/.test(request.prompt)) seen = git(web, 'rev-parse', 'HEAD');
  });
  await drive(h, {});
  assert.equal(seen, tip, 'the branch kept its own tip: one change is not on the trunk');
  assert.deepEqual(reseats(root), []);
});

test('RB-2 — a mount a session detached at origin/main is re-seated when clean; with edits, the refusal names the re-seat', async () => {
  const { base, root } = superRoot();
  let landed = '';
  const h = harness(root, { 1: 'web', 2: 'web' }, { planScope: () => ['web', 'api'] }, (request, runner) => {
    if (!/BOOT phase 1\b/.test(request.prompt)) return;
    const web = join(String(runner.current()?.workRoot), 'web');
    commitFile(web, 'release.txt', 'the release\n', 'p1: the release');
    landed = squashOnOrigin(base, root);
    // What #183's session did to make `task drift:*` green, plus an edit.
    git(web, 'switch', '-q', '--detach', 'refs/remotes/origin/main');
    writeFileSync(join(web, 'drift.log'), 'a check wrote this\n');
    runner.pause();
  });
  const first = await drive(h, { onlyPhases: [1, 2] });
  const web = join(String(first.workRoot), 'web');

  // Dirty: the console will not switch a tree holding edits, so the run parks —
  // and the refusal says what the way out is.
  const second = await drive(h, { resumeRunId: String(first.id), onlyPhases: [1, 2] }) as unknown as RunState;
  assert.equal(second.status, 'parked');
  assert.equal(second.halt?.kind, 'isolation-refused');
  const reason = String(second.halt?.reason);
  assert.match(reason, /detached HEAD/);
  assert.match(reason, /fully landed on origin\/main/, reason);
  assert.match(reason, /re-seats `pe\/demo` on origin\/main/, reason);
  assert.deepEqual(reseats(root), [], 'nothing moved under an edit');

  // Clean: the same mount is re-seated by itself and the run boards on.
  git(web, 'clean', '-q', '-f');
  const third = await drive(h, { resumeRunId: String(first.id), onlyPhases: [1, 2] }) as unknown as RunState;
  assert.notEqual(third.halt?.kind, 'isolation-refused', String(third.halt?.reason ?? ''));
  const lines = reseats(root);
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.equal(lines[0]!.mount, 'web');
  assert.equal(lines[0]!.to, landed);
  assert.equal(git(web, 'symbolic-ref', '--short', 'HEAD'), 'pe/demo');
  assert.equal(git(web, 'rev-parse', 'HEAD'), landed);
});
