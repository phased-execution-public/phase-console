/**
 * Repo's words and keys — what a section's row and the record's inspector both
 * say, kept in one pure module so neither imports the other (7.0, quiet-console
 * phase 17).
 */

import type { CheckoutRole, RepoBranch, RepoCheckout, RepoSettleEvent, SettleKind } from '@/data/api';
import { homePath } from '@/lib/format';

/** The dash: one spelling for "not measured", the same in every row. */
export const NOT_MEASURED = '—';

/**
 * `3 ahead, 1 behind`, or the dash — and the dash is never zero. Each side is
 * reported on its own: a branch with no trunk to measure against is not "up to
 * date", it was not measured, and a pass that stopped early leaves rows that
 * were never asked.
 */
export function divergenceWords(branch: Pick<RepoBranch, 'ahead' | 'behind'>): string {
  if (branch.ahead === undefined && branch.behind === undefined) return NOT_MEASURED;
  const ahead = branch.ahead === undefined ? NOT_MEASURED : String(branch.ahead);
  const behind = branch.behind === undefined ? NOT_MEASURED : String(branch.behind);
  return `${ahead} ahead, ${behind} behind`;
}

/** A run read off a branch NAME — `quiet-console P17` — which a person can type, so a reading. */
export function runWords(run: { slug: string; phase?: number } | undefined): string | undefined {
  if (!run) return undefined;
  return run.phase === undefined ? run.slug : `${run.slug} P${run.phase}`;
}

/**
 * What each working-tree role IS, in one sentence. The role is decided by
 * identity on the server; these are what a reader checks it against.
 */
export const ROLE_BLURB: Readonly<Record<CheckoutRole, string>> = {
  root: 'The main working tree: the repository itself, not a linked checkout.',
  run: "A run's own checkout, holding that whole run's work.",
  lane: 'One phase of one run, in a checkout of its own so it can run beside its siblings.',
  staging: "Every plan's folded work waits here. This one is never swept.",
  operator: 'A linked checkout the console did not create.',
  debris: 'Under the console’s state directory, and no surviving run record claims it.',
};

/** The attribution column's word: written evidence, a guess at a name, or nothing. */
export function attributionWord(checkout: RepoCheckout): 'record' | 'by name' | 'unattributed' {
  if (checkout.via === 'record') return 'record';
  if (checkout.via === 'branch') return 'by name';
  return 'unattributed';
}

/** The attribution, said in full — what a reclaim decision reads. */
export function attributionSentence(checkout: RepoCheckout): string {
  if (checkout.via === 'record') {
    const { slug, phase, runId, status, live } = checkout.run;
    return `The run record says so: ${slug}${phase === undefined ? '' : `, phase ${phase}`}, run ${runId}${
      status ? `, ${status}` : ''
    }, and ${live ? 'a runner is driving it now' : 'it has stopped'}.`;
  }
  if (checkout.via === 'branch') {
    const { slug, phase } = checkout.run;
    return `Only the name says so, read as ${slug}${
      phase === undefined ? '' : `, phase ${phase}`
    }: a reading, not evidence. No record claims this tree; it may be a killed console's leftover, or a checkout somebody made by hand and is working in now.`;
  }
  return 'Nothing claims it, and nothing about its name suggests a run.';
}

/** Where a tree stands: its branch, the commit a detached one names, or nothing. */
export function standingOn(checkout: RepoCheckout): string | undefined {
  return checkout.branch ?? checkout.detached;
}

/** A tree's directory as a person reads it — under `~` when it is under the home. */
export const treeName = (checkout: Pick<RepoCheckout, 'dir'>, home: string | undefined): string =>
  homePath(checkout.dir, home) ?? checkout.dir;

/**
 * What each settle means. Its word and paint are the model's (`settle` in
 * `shared/status-model.js`): `pending` and `unsupported` are not failures —
 * one has not happened yet, the other is a standing fact about the repository.
 */
export const SETTLE_BLURB: Readonly<Record<SettleKind, string>> = {
  settled: 'The lane folded back into the run branch.',
  landed: 'The work reached the trunk.',
  pushed: "The console pushed the phase's branch to its origin, the one publication it makes.",
  pending: 'A settle that has not happened yet. Not a failure.',
  unsupported: 'This repository cannot settle that way: a configuration fact, not an error.',
  failed: 'The settle did not complete. The detail says what stopped it.',
  released: 'The lane let go of its scope.',
  pruned: 'The checkout was removed.',
};

/**
 * Which source carried a settle row — not the checkout's `via`. The record
 * survives a trimmed journal and carries the strategy; the journal carries the
 * per-lane detail; one moment legitimately appears from both.
 */
export const SOURCE_BLURB: Readonly<Record<RepoSettleEvent['via'], string>> = {
  record: 'From the run record: it survives a trimmed journal and carries the strategy.',
  journal: 'From the run journal: it carries the per-lane detail.',
};

/**
 * A settle row's identity. No index in it: a new settle arriving at the head
 * would shift every key below and an open row would jump to another event. The
 * phase is what tells apart two rows one run writes at the same instant.
 */
export const settleKey = (e: RepoSettleEvent): string =>
  `${e.runId}:${e.at}:${e.kind}:${e.via}:${e.phase ?? ''}`;
