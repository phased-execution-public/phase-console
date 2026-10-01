/**
 * What a session's own §Verification proved, and whether it still holds
 * (control-tower phase 62, #68, AUD-10).
 *
 * The console used to re-run a phase's whole §Verification after the session
 * exited, with no record of what the session had just proved at which tree. In
 * one measured week that was 21 phases re-running a suite (398 min) after
 * 640 min of the same suites run in-turn — on a laptop where one command's
 * duration varies 4–6×, holding the lock and the scope grant the whole time.
 *
 * A session now records each command it ran — `phase-outcome.sh <slug> <N>
 * verified --command … --exit …` — as one line of a per-PLAN ledger naming the
 * WORKING tree it ran against. The console honours a green proof when the tree
 * it is about to verify is EQUIVALENT: the proven tree itself, or one where only
 * paperwork changed since. Paperwork is what a phase writes after its suite ran
 * green and what no suite reads — its handoff, its lock, the changelog. Anything
 * else re-runs, and so does a red proof: a red is not a proof of anything, and
 * the console's own run of that command is the verdict.
 *
 * Nothing here runs a command or changes a repository; the tree reads are
 * `worktree.ts`'s (`workingTreeOf`, `treeChanges`), the one file allowed them.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runDir } from './run-paths.ts';
import { foldCommand } from './verify.ts';
import { treeChanges, workingTreeOf } from './worktree.ts';

export { foldCommand };

/** The plan's proof ledger — per PLAN, beside `rulings.ndjson`, like the script's fallback. */
export function proofsFile(root: string, slug: string): string {
  return join(runDir(root, slug), 'proofs.ndjson');
}

/** One recorded run of one command by a session. */
export type Proof = {
  command: string;
  code: number;
  /** The working tree the command ran against — a git tree object. */
  tree: string;
  head?: string;
  at: string;
  session?: string;
};

/** A proof the console honours instead of running the command. */
export type ProvenBy = {
  tree: string;
  at: string;
  session?: string;
  /** The paperwork paths changed since the proven tree — empty when it IS the tree. */
  paperwork: string[];
};

/** Everything the console concluded about one phase's proofs, before it verified. */
export type ProofJudgement = {
  /** The last proof of each command on file for this phase. */
  recorded: Map<string, Proof>;
  /** The commands proven green at an equivalent tree, keyed by folded text. */
  proven: Map<string, ProvenBy>;
  /** Every other recorded proof, and why the console will run the command itself. */
  refused: { command: string; why: string; changed?: string[] }[];
  /** The tree about to be verified — null when nothing was on file, or git could not name it. */
  tree: string | null;
};

/**
 * Paths a phase writes AFTER its suite ran green and that no suite reads: the
 * handoffs (and their locks), any `.locks/` directory, the root changelog. A
 * narrow list on purpose — every path left off it is a path whose change makes
 * the console run the command again, which is the safe direction.
 */
export function isPaperwork(path: string): boolean {
  return path.startsWith('docs/handoffs/') || /(^|\/)\.locks\//.test(path) || path === 'CHANGELOG.md';
}

const TREE = /^[0-9a-f]{40,64}$/;

/**
 * The proofs one phase of one plan recorded, the LAST per command — a session
 * that re-ran a command after fixing it superseded its own red. Lines that do
 * not parse, name another plan or phase, or carry no tree are skipped: the
 * ledger is append-only and written by scripts, never trusted to be tidy.
 */
export function readProofs(file: string, slug: string, phase: number): Map<string, Proof> {
  const out = new Map<string, Proof>();
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (row?.type !== 'proof' || row.slug !== slug || row.phase !== phase) continue;
    if (typeof row.command !== 'string' || typeof row.code !== 'number' || typeof row.tree !== 'string') continue;
    if (!TREE.test(row.tree)) continue;
    const command = foldCommand(row.command);
    if (!command) continue;
    out.set(command, {
      command, code: row.code, tree: row.tree,
      ...(typeof row.head === 'string' && row.head ? { head: row.head } : {}),
      at: typeof row.at === 'string' ? row.at : '',
      ...(typeof row.session_id === 'string' && row.session_id ? { session: row.session_id } : {}),
    });
  }
  return out;
}

/**
 * Which of a phase's recorded proofs hold for the tree at `cwd`.
 *
 * Git is asked nothing when nothing is on file — a phase whose session
 * recorded no proof costs exactly what it cost before. One diff per distinct
 * proven tree, however many commands share it.
 */
export async function judgeProofs(opts: {
  file: string; slug: string; phase: number; cwd: string;
}): Promise<ProofJudgement> {
  const recorded = readProofs(opts.file, opts.slug, opts.phase);
  const proven = new Map<string, ProvenBy>();
  const refused: ProofJudgement['refused'] = [];
  if (!recorded.size) return { recorded, proven, refused, tree: null };

  const current = await workingTreeOf(opts.cwd).catch(() => null);
  if (!current) {
    for (const proof of recorded.values()) {
      refused.push({ command: proof.command, why: 'the tree about to be verified could not be read' });
    }
    return { recorded, proven, refused, tree: null };
  }

  const diffs = new Map<string, Promise<string[] | null>>();
  const changesSince = (tree: string) => {
    if (!diffs.has(tree)) diffs.set(tree, treeChanges(current.top, tree, current.tree).catch(() => null));
    return diffs.get(tree)!;
  };
  for (const proof of recorded.values()) {
    if (proof.code !== 0) {
      refused.push({ command: proof.command, why: `it exited ${proof.code} when the session ran it — a red is not a proof` });
      continue;
    }
    const changed = await changesSince(proof.tree);
    if (changed === null) {
      refused.push({ command: proof.command, why: 'the proven tree is not an object of this repository' });
      continue;
    }
    const real = changed.filter((path) => !isPaperwork(path));
    if (real.length) {
      refused.push({
        command: proof.command,
        why: `the tree changed since it was proven (${real.length} path${real.length === 1 ? '' : 's'} a suite may read)`,
        changed: real.slice(0, 20),
      });
      continue;
    }
    proven.set(proof.command, {
      tree: proof.tree, at: proof.at, ...(proof.session ? { session: proof.session } : {}), paperwork: changed,
    });
  }
  return { recorded, proven, refused, tree: current.tree };
}
