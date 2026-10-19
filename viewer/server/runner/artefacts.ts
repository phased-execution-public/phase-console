/**
 * What a phase's session left behind — the register's two halves, a scan and a
 * diff, kept free of the runner so a test can drive them over real git
 * repositories (one-pool phase 20, #262).
 *
 * Measured (#262): worktrees share ONE git directory across every checkout of
 * a repository, so a tree or a `pe/<other-slug>` branch that ANOTHER run's lane
 * machinery made in the same repository while this phase ran was credited to
 * this phase — a fleet-sweep run's mirror listed as "made" by an ai-builder
 * phase, a supervisor's scratch trees by an issues-sweep phase. The register
 * exists to make a session's own leaks visible, and a false entry hides the
 * real ones in the noise. So:
 *
 *  1. a tree under ANY console-managed root (every run's `worktrees/`, the
 *     staging checkout) is the console's, never a session's — unless it stands
 *     inside this phase's own lane tree, where only its session works;
 *  2. a `pe/<slug>` branch (or a lane's `pe/<slug>-p<N>`) of a plan this
 *     instance runs is the console's lane machinery, never a session's;
 *  3. any other tree that appears is said to have APPEARED while the phase
 *     ran, maker unknown — a shared git directory has more writers than one
 *     phase's process tree.
 */
import { readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { RunArtefact } from './state.ts';
import { realish } from './worktree.ts';

export type ArtefactSnapshot = {
  repo: string;
  trees: Map<string, { branch?: string; managed: boolean }>;
  branches: Set<string>;
}[];

const inside = (dir: string, root: string): boolean => dir === root || dir.startsWith(`${root}${sep}`);

/**
 * The plans this instance has run state for — the slugs whose `pe/<slug>`
 * branches the console's own lane machinery makes. Read from the instance's
 * runs directory (`consoleRunsDir`), one directory per plan; unreadable → none.
 */
export function instanceSlugs(runsDir: string): string[] {
  try {
    return readdirSync(runsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch { return []; }
}

/** Is `name` a branch the console's lane machinery makes for one of `slugs` — `pe/<slug>` or `pe/<slug>-p<N>[-qa<R>]`? */
export function consoleBranch(name: string, slugs: readonly string[]): boolean {
  return slugs.some((slug) => name === `pe/${slug}` || new RegExp(`^pe/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-p\\d+(?:-qa\\d+)?$`).test(name));
}

/**
 * What appeared between two scans that this phase's session could have made.
 * `laneTree` is the phase's own lane checkout (absent: it shares the run's
 * checkout); `slugs` every plan of this instance, this one included.
 */
export function artefactsMade(
  before: ArtefactSnapshot, after: ArtefactSnapshot,
  opts: { phase: number; at: string; laneTree?: string | null; slugs: readonly string[] },
): RunArtefact[] {
  const lane = opts.laneTree ? realish(resolve(opts.laneTree)) : null;
  const made: RunArtefact[] = [];
  for (const now of after) {
    // Matched by REPO. A scope that appeared or vanished between the two
    // scans is compared against nothing rather than against a neighbour's
    // refs, which would report every one of them as new.
    const was = before.find((b) => b.repo === now.repo);
    if (!was) continue;
    for (const [dir, tree] of now.trees) {
      if (was.trees.has(dir)) continue;
      const own = lane !== null && dir !== lane && inside(dir, lane);
      if (tree.managed && !own) continue;
      made.push({
        kind: 'worktree', name: dir, repo: now.repo, ...(tree.branch ? { branch: tree.branch } : {}),
        phase: opts.phase, at: opts.at, ...(own ? {} : { maker: 'unknown' as const }),
      });
    }
    for (const name of now.branches) {
      if (was.branches.has(name) || consoleBranch(name, opts.slugs)) continue;
      made.push({ kind: 'branch', name, repo: now.repo, phase: opts.phase, at: opts.at });
    }
  }
  return made;
}

/** One line per artefact, for the journal and the page: "made by phase N" or "appeared while phase N ran". */
export function artefactWords(artefact: RunArtefact): string {
  const what = artefact.kind === 'worktree' ? `worktree ${artefact.name}` : `branch ${artefact.name}`;
  return artefact.maker === 'unknown'
    ? `${what} appeared while phase ${artefact.phase} ran (maker unknown)`
    : `${what} made by phase ${artefact.phase}`;
}

/** Where a scope directory is, relative to the run root (`.` = the root). */
export function scopeAbs(root: string, dir: string): string {
  return dir === '.' ? root : join(root, dir);
}
