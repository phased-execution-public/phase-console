/**
 * Unpushed work in a session's trees (measured-console phase 12; #397, #418's
 * third ask).
 *
 * A context wrap-up used to leave committed work on the run branch UNPUSHED:
 * the session committed what was green, declared `partial` and stopped, and
 * the commits lived only in the mirror — a console restart that rebuilt it, a
 * machine that died, lost them, and nothing on the phase said they existed.
 * This module answers the two questions the wrap-up now asks of each tree a
 * session can reach (`git-guard.ts` `configTreesOf`):
 *
 *   - how far is its branch ahead of `origin/<branch>`? (`unpushedIn`) — read
 *     from the LOCAL remote-tracking ref, never a fetch: the console asks after
 *     every working session, and the answer it needs is "has this checkout
 *     pushed what it made", which the tracking ref a push moves answers;
 *   - push its fast-forward (`pushFastForward`) — `git push origin <branch>`,
 *     never forced, so a branch that is not a fast-forward of its remote is
 *     refused by git itself; only a run or lane branch (`pe/…`), never a trunk;
 *     and only to the `origin` the tree had BEFORE the session ran
 *     (`originPin`, read at the spawn): a session that re-pointed its
 *     remote does not get the console to push there for it.
 *
 * Every git call here is the console's hardened one (`git-guard.ts`
 * `hardenedGitEnv`): no repository hook, fsmonitor, pager or credential helper
 * a session could have planted runs under the console's name — the push runs
 * no pre-push hook, exactly as no other console git call runs one.
 *
 * Whether the console MAY push is not this module's question: the caller asks
 * the plan's `permission.destructive` row (`Service.runBranchPushAllowed`).
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

import { hardenedGitEnv } from '../git-guard.ts';

/** One tree whose branch is ahead of its remote: the wire's and the record's shape. */
export type UnpushedTree = {
  /** The tree, relative to the session's root (`.` for the root itself). */
  repo: string;
  branch: string;
  /** Commits on `branch` not on `origin/<branch>` (every commit not on any remote, when that ref is absent). */
  ahead: number;
  /** False when `origin/<branch>` does not exist yet — the branch was never pushed. */
  tracked: boolean;
};

/** The branches the console ever pushes for a session: a run's or a lane's, never a trunk. */
export function pushableBranch(branch: string | null | undefined): branch is string {
  return typeof branch === 'string' && /^pe\/[A-Za-z0-9._/-]+$/.test(branch) && !branch.includes('..');
}

const gitEnv = (): NodeJS.ProcessEnv => hardenedGitEnv({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });

function git(cwd: string, args: string[], timeoutMs = 10_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: gitEnv(), timeout: timeoutMs, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      resolve({ code, out: String(stdout ?? '').trim(), err: String(stderr ?? '').trim() });
    });
  });
}

/** One tree's unpushed count, or null for a tree that is not a repository on a pushable branch. */
export async function unpushedOf(tree: string, root: string = tree): Promise<UnpushedTree | null> {
  if (!existsSync(join(tree, '.git'))) return null;
  const head = await git(tree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = head.code === 0 ? head.out : '';
  if (!pushableBranch(branch)) return null;
  const tracking = await git(tree, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
  const tracked = tracking.code === 0 && Boolean(tracking.out);
  const counted = tracked
    ? await git(tree, ['rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`])
    : await git(tree, ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']);
  const ahead = counted.code === 0 ? Number.parseInt(counted.out, 10) : Number.NaN;
  if (!Number.isFinite(ahead)) return null;
  return { repo: relative(root, tree) || '.', branch, ahead, tracked };
}

/** Every tree of the set whose branch is ahead of its remote, in the set's order. */
export async function unpushedIn(trees: readonly string[], root: string): Promise<UnpushedTree[]> {
  const read = await Promise.all([...new Set(trees)].map((tree) => unpushedOf(tree, root).catch(() => null)));
  return read.filter((entry): entry is UnpushedTree => Boolean(entry && entry.ahead > 0));
}

/**
 * Where `git push origin` sends a tree's commits (`originPin`, read at the
 * spawn), and the push itself (`pushFastForward`): both live in
 * `worktree.ts`, the one server file `never-push.test.ts` lets push, and the
 * push is its shaped `pushRef` (measured-console phase 14, #441).
 */
export { originPin, pushFastForward, type OriginPin } from './worktree.ts';
