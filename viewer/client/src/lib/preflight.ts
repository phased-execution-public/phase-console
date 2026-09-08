/**
 * How a boarding-preflight finding reads — the words and the weight, once.
 *
 * Two surfaces show the same findings: the plan's health panel ("Before it
 * boards") and the launch flow's review stage. They must not disagree about
 * which kind is a certainty and which is a prediction, so the table lives
 * here and both import it.
 *
 * Only `nothing-runnable` is certain: a phase with no executable §Verification
 * WILL park at boarding. The other three are predictions about this machine —
 * a lead that is not on this PATH, a check only a person can answer, commands
 * that will run at the repository root. Painting all four the same red is how
 * a panel gets ignored.
 */

import type { PreflightWarning } from '@/lib/api';

export const PREFLIGHT_TONE: Readonly<Record<PreflightWarning['kind'], 'bad' | 'warn' | 'neutral'>> =
  Object.freeze({
    'nothing-runnable': 'bad',
    'missing-lead': 'warn',
    'human-check': 'neutral',
    'cwd-unpinned': 'neutral',
  });

export const PREFLIGHT_LABEL: Readonly<Record<PreflightWarning['kind'], string>> = Object.freeze({
  'nothing-runnable': 'will park',
  'missing-lead': 'missing lead',
  'human-check': 'needs a person',
  'cwd-unpinned': 'no Verify in',
});

/** The phases boarding will certainly park — the ones with nothing runnable. */
export function willPark(phases: readonly { phase: number; warnings: PreflightWarning[] }[]): number[] {
  return phases.filter((p) => p.warnings.some((w) => w.kind === 'nothing-runnable')).map((p) => p.phase);
}
