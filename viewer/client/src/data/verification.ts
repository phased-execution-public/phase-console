/**
 * A plan's §Verification on file (quiet-console phase 26): what its sessions
 * proved, and every run of its lines the console made — a phase's verdict, or
 * the baseline its lines read at boarding. The run view's Verification fold
 * reads both through these two hooks.
 *
 * Both answers come from the plan's ledgers rather than the run
 * (`proofs.ndjson`, `verifications.ndjson`), so a finished run answers too.
 * Their keys hang off the run's prefix on purpose: a verdict is written as a
 * phase verifies and a baseline as it boards, which is when `run:verify` and
 * `run:phase` invalidate `['run', slug]` — and only a query a page draws is
 * fetched again, so a folded section pays nothing for it.
 */

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { keys } from './keys';
import { readRunProofs, readRunVerifications, type RunVerification, type RunVerifications } from './runs';

export type { RunProof, RunProofs } from './runs';

/** How many rows the ledger answers when asked for none, and the most it answers (`verify-ledger.ts`). */
export const VERIFICATIONS_PAGE = 200;
export const VERIFICATIONS_PAGE_MAX = 2_000;

/**
 * One run of one line as the wire carries it: the ledger row also names the
 * working tree it ran against and that tree's HEAD, which `RunVerification`
 * leaves out.
 */
export interface VerificationRow extends RunVerification {
  tree?: string | null;
  head?: string | null;
}

export interface VerificationPage extends Omit<RunVerifications, 'rows'> {
  /** Newest first. */
  rows: VerificationRow[];
}

/** What a phase's sessions proved — the last proof of each command, by phase; one phase's alone when `phase` is given. */
export function useRunProofs(
  slug: string | undefined,
  options: { phase?: number | undefined; enabled?: boolean } = {},
) {
  const { phase, enabled = true } = options;
  return useQuery({
    queryKey: [...keys.run(slug ?? ''), 'proofs', phase ?? 'all'] as const,
    queryFn: () => readRunProofs(slug!, phase),
    enabled: Boolean(slug) && enabled,
    // A narrower or wider read keeps the rows on screen until its answer lands.
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/**
 * The console's verification ledger, newest first: narrowed to one `phase`
 * and one `run` when asked, at most `limit` rows (the server's 200 when
 * none, never past 2,000), with how many matched before the cut.
 */
export function useRunVerifications(
  slug: string | undefined,
  options: {
    phase?: number | undefined;
    run?: string | undefined;
    limit?: number | undefined;
    enabled?: boolean;
  } = {},
) {
  const { phase, run, limit, enabled = true } = options;
  return useQuery({
    queryKey: [
      ...keys.run(slug ?? ''),
      'verifications',
      phase ?? 'all',
      run ?? 'all',
      limit ?? VERIFICATIONS_PAGE,
    ] as const,
    queryFn: () => readRunVerifications(slug!, { phase, run, limit }) as Promise<VerificationPage>,
    enabled: Boolean(slug) && enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}
