/**
 * Where a run's files live — the leaf `state.ts` and `journal.ts` share.
 *
 * These four helpers were `state.ts`'s until phase 6 of `zero-touch-console`
 * needed the run journal from INSIDE the state module: a `waiting` record
 * whose clock died is settled on load (`settleWaitingRecords`), and a
 * settlement that changes a record without a journal line is the audit's
 * WAI-6 all over again. `journal.ts` imported `journalFile` from `state.ts`,
 * so `state.ts` importing `Journal` back would have been a cycle; the paths
 * moved down here instead, and both modules import them from the leaf.
 * `state.ts` re-exports them, so every existing importer keeps its spelling.
 */

import { join } from 'node:path';

import { instanceId } from '../../shared/instances.mjs';
import { STATE_DIR } from '../config.ts';

/**
 * One directory per (source directory, plan). The hash keeps two checkouts of
 * the same repo apart; the basename keeps the path readable for a human who
 * goes looking, which they will the first time a run halts.
 *
 * The key is `instanceId()` — the same function that names a console instance,
 * imported rather than reimplemented. It was computed here first and the
 * instance registry adopted it, so the import direction looks backwards; it is
 * the right way round anyway, because the two must never drift and only one of
 * them can be the definition. `runs/` stays under the SHARED `STATE_DIR` rather
 * than moving into a per-instance directory: it is already keyed by root, so
 * two consoles cannot collide here, and moving it would orphan every run
 * journal on the machine to buy nothing.
 */
export function runDir(root: string, slug: string): string {
  return join(STATE_DIR, 'runs', instanceId(root), slug);
}

/**
 * The state directory shared by every plan in ONE console checkout.
 *
 * `runDir` is exactly this plus the plan's slug — the two are written next to
 * each other so they cannot drift — and this is the right scope for anything
 * console-wide rather than plan-wide. The staging worktree of `pe/integration`
 * is the first such thing: git allows a branch one working tree, so a staging
 * directory under a plan's own `runDir` would mean the second plan to settle
 * that way found the branch already checked out.
 */
export function consoleRunsDir(root: string): string {
  return join(STATE_DIR, 'runs', instanceId(root));
}

export function runFile(root: string, slug: string, id: string): string {
  return join(runDir(root, slug), `run-${id}.json`);
}

export function journalFile(root: string, slug: string, id: string): string {
  return join(runDir(root, slug), `run-${id}.jsonl`);
}
