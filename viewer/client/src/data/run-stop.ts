/**
 * The stop a stopped run is about — one reader for the Run view's notes and
 * the Runs home's expanded row (#305), so the two never disagree about whether
 * a parked run has a halt card.
 */

import { SETTLED, SETTLED_WELL, runEndedBadly } from '@shared/run-lifecycle.js';
import type { RunState } from '@/data/api/runs';

/** A phase a stop left behind: settled, and not well. */
const stoppedPhase = (status: string): boolean =>
  (SETTLED as readonly string[]).includes(status) && !(SETTLED_WELL as readonly string[]).includes(status);

/**
 * The stop the card is about. A run that halted carries its own. One that
 * stopped with the cause on a PHASE's record instead — a park on a red
 * verification, a wait that ran out — is about that phase's stop, the
 * lowest-numbered first; every other stopped phase is the Ways forward fold's.
 * A live or resolved run has no phase stop to answer.
 */
export function runStopOf(run: RunState | null, live: boolean): RunState['halt'] {
  if (!run) return null;
  if (run.halt) return run.halt;
  if (live || run.resolved || !runEndedBadly(run)) return null;
  const record = Object.values(run.phases ?? {})
    .filter((one) => one && stoppedPhase(one.status) && one.halt)
    .sort((a, b) => a!.phase - b!.phase)[0];
  return record?.halt ? { ...record.halt, phase: record.halt.phase ?? record.phase } : null;
}
