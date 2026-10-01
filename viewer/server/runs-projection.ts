/**
 * The slim run — what `run status`, `run wait` and the long poll read
 * (control-tower phase 98, #75's 2026-09-24T17:08:10Z comment).
 *
 * `GET /api/runs` answers every run of every plan whole: on the hub, 4.9 MB,
 * because a run record carries every phase's attempts, rungs, liveness
 * snapshots, notes and the resolved manifest. A script asking "is control-
 * tower paused yet?" every 20 seconds paid for all of it. The slim projection
 * is the handful of fields that question — and every other supervising
 * question — actually reads: the run's status, its halt, the processes it
 * holds, each live lane's liveness, and one status word per phase.
 */

import { runLifecycle } from '../shared/run-lifecycle.js';
import type { LaneLiveness } from './runner/liveness.ts';
import type { RunState } from './runner/state.ts';
import type { RunFacts } from './triggers.ts';

export type SlimRun = {
  id: string;
  slug: string;
  status: RunState['status'];
  /**
   * The run's lifecycle, derived from the WHOLE run (control-tower phase 88,
   * #148): a `paused` run asleep on a clock nobody paused is `waiting`, and
   * only the fields this row drops — `stoppedBy`, `resolved`, `onLimit` — can
   * say so. With it on the row, `runStatusWord(row)` prints what every other
   * surface prints, and `lifecycle.wait` says on what and until when.
   */
  lifecycle: NonNullable<RunState['lifecycle']>;
  activePhase: number | null;
  halt: RunState['halt'];
  /** The processes the run holds, by phase — a pid and when it started. */
  children: RunState['children'] & object;
  /**
   * The console's own lanes, by phase (control-tower phase 89, #68): a
   * §Verification, a baseline or a wrap-up gate running under the phase's grant
   * with no session. Only this process's — one a dead console left is over.
   */
  verifying: NonNullable<RunState['verifying']>;
  /** Every live lane: last output, last tool call, the open tool, the stall episode. */
  liveness: LaneLiveness[];
  /** One word per phase record. */
  phases: Record<string, string>;
  waitUntil: string | null;
  accountId: string | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
  finishedReason: string | null;
};

/** The field names, as a list a test and a reader can hold the shape to. */
export const SLIM_RUN_FIELDS = Object.freeze([
  'id', 'slug', 'status', 'lifecycle', 'activePhase', 'halt', 'children', 'liveness', 'verifying', 'phases',
  'waitUntil', 'accountId', 'consecutiveFailures', 'createdAt', 'updatedAt', 'finishedReason',
] as const);

/**
 * The run's verifying lanes this console is running NOW (control-tower phase
 * 89): an entry is written by the process that runs the commands, so one
 * stamped with another pid is a pass a dead console left — over, not live.
 */
export function liveVerifying(run: Pick<RunState, 'verifying'>, pid: number = process.pid): NonNullable<RunState['verifying']> {
  return Object.fromEntries(Object.entries(run.verifying ?? {}).filter(([, lane]) => lane?.pid === pid));
}

export function slimRun(run: RunState, liveness: LaneLiveness[]): SlimRun {
  return {
    id: run.id,
    slug: run.slug,
    status: run.status,
    lifecycle: runLifecycle(run),
    activePhase: run.activePhase ?? null,
    halt: run.halt ?? null,
    children: run.children ?? {},
    verifying: liveVerifying(run),
    liveness,
    phases: Object.fromEntries(Object.entries(run.phases ?? {}).map(([phase, record]) => [phase, record.status])),
    waitUntil: run.waitUntil ?? null,
    accountId: run.accountId ?? null,
    consecutiveFailures: run.consecutiveFailures ?? 0,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedReason: run.finishedReason ?? null,
  };
}

/** A predicate's facts, read off the slim run and the queue — so a wait answers what `status` prints. */
export function factsOf(run: Pick<SlimRun, 'id' | 'status' | 'phases'> | null, queued: readonly number[]): RunFacts | null {
  if (!run) return null;
  return { runId: run.id, status: run.status, phases: run.phases, queued: [...queued] };
}
