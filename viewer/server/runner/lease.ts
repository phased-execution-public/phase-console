/**
 * What one lease refresh SAID, and what the lane does about it (control-tower
 * phase 56, #77).
 *
 * The runner refreshes its lane's phase lock every `LEASE_REFRESH_MS` under the
 * shared owner, and a refusal is an instruction: somebody else holds the phase,
 * so the lane stands down rather than fight a person for a lock. The defect was
 * in the word "refusal". `refreshLease` read ANY non-zero exit as one — and the
 * engine maps a run killed at its ceiling to code 1. On 2026-09-22 a starved
 * console let one refresh run 310 s against a 45 s ceiling; the script had
 * already printed `lock refreshed for autopilot/24fcba33`, and the runner
 * stopped the live session holding that very lock (35.8 min, 99 turns, $23.24).
 *
 * So the verdict is read from what the script said, not from how its process
 * ended:
 *
 *   - `keep`: the script says the lease moved (`lock refreshed for <us>` or
 *     `claimed by <us>`) whatever happened to the process after it said so, or
 *     it exited 0 by itself.
 *   - `stand-down`: ONLY an explicit refusal that names ANOTHER owner, from a
 *     run that ended by itself — `phase-lock.sh`'s three refusal sentences.
 *   - `retry`: everything else — a timeout, a crash, a usage error, silence.
 *     The 5400 s lease leaves eight missable refresh cadences of headroom
 *     (`RUNNER_LEASE_S`), so the next tick is the retry, and a lock a person
 *     really took is learned at the first refresh that ANSWERS.
 *
 * Pure, so the whole table is testable without a runner
 * (`test/lease-refresh-verdict.test.ts`). The journal names stay at the one
 * call site in `runner.ts`, where `docs-parity.test.ts` can read them.
 */

import type { EngineResult } from '../engine.ts';

/** How much of what the script said rides the journal line. */
const DETAIL_CHARS = 200;

/**
 * `phase-lock.sh claim`'s refusals — each names the holder. The first is the
 * held-and-live answer, the second `_confirm_held` losing a race, the third a
 * `--git` publish that found the upstream taken (the runner never passes
 * `--git`; it is here so a future caller cannot read it as silence).
 */
const REFUSALS: readonly RegExp[] = [
  /is being worked by (\S+)/,
  /lost to (\S+) — that session holds the lock now/,
  /the upstream lock is held by (\S+) — NOT claimed/,
];

export type LeaseRefreshRun = Pick<EngineResult, 'code' | 'stdout' | 'stderr' | 'timedOut'>
  & Partial<Pick<EngineResult, 'crashed' | 'signal'>>;

export type LeaseAction =
  | { act: 'keep'; detail: string }
  | { act: 'stand-down'; holder: string; code: number; timedOut: false; detail: string }
  | { act: 'retry'; why: 'timed-out' | 'crashed' | 'no-verdict'; code: number; timedOut: boolean; detail: string };

export function leaseAction(run: LeaseRefreshRun, owner: string): LeaseAction {
  const said = `${run.stdout}\n${run.stderr}`.trim();
  const detail = said.slice(0, DETAIL_CHARS);
  // The script's own word that the lease moved outranks how its process ended.
  if (said.includes(`lock refreshed for ${owner} (`) || said.includes(`claimed by ${owner} (`)) {
    return { act: 'keep', detail };
  }
  if (run.timedOut) return { act: 'retry', why: 'timed-out', code: run.code, timedOut: true, detail };
  if (run.crashed || run.signal) return { act: 'retry', why: 'crashed', code: run.code, timedOut: false, detail };
  if (run.code === 0) return { act: 'keep', detail };
  if (run.code === 1) {
    for (const refusal of REFUSALS) {
      const holder = refusal.exec(said)?.[1];
      if (holder && holder !== owner) return { act: 'stand-down', holder, code: 1, timedOut: false, detail };
    }
  }
  return { act: 'retry', why: 'no-verdict', code: run.code, timedOut: false, detail };
}
