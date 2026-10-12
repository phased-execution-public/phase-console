/**
 * The slim run — what `run status`, `run wait`, the long poll and, since 7.0,
 * the Runs home read (control-tower phase 98, #75's 2026-09-24T17:08:10Z
 * comment; quiet-console phase 7, #234).
 *
 * `GET /api/runs` answers every run of every plan whole: on the hub, 4.9 MB,
 * because a run record carries every phase's attempts, rungs, liveness
 * snapshots, notes and the resolved manifest. A script asking "is control-
 * tower paused yet?" every 20 seconds paid for all of it, and so did the Runs
 * home on every phase event. The slim projection is the handful of fields a
 * supervising question — and a run's ONE LINE on the Runs home — actually
 * read: the run's status, its halt, the processes it holds, each live lane's
 * liveness, one status word per phase, and the glance facts (what it spent,
 * what it may spend, what it worked, who stopped it, what holds it). The
 * phase RECORDS stay behind: the home reads the whole record only for the
 * row a person opened (`GET /api/run/:slug`).
 */

import { phaseClocks } from '../shared/phase-clocks.js';
import { runLifecycle, undrivenPhases } from '../shared/run-lifecycle.js';
import type { LaneLiveness } from './runner/liveness.ts';
import type { RunState } from './runner/state.ts';
import type { RunFacts } from './triggers.ts';

/**
 * The recovery facts of one phase the run has not settled well — exactly what
 * `haltCtx` (`shared/halt-view.js`) reads off a record to ask the recovery
 * model with, so a slim row answers the halt view's recommended verb the way
 * the whole record does (quiet-console phase 7, #278). Never a session id:
 * only whether one exists.
 */
export type SlimPhaseFacts = {
  resumable: boolean;
  situation: { key: string } | null;
};

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
  /** The recovery facts of every phase not settled well, by phase (7.0). */
  records: Record<string, SlimPhaseFacts>;
  waitUntil: string | null;
  accountId: string | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
  finishedReason: string | null;
  /* ---- the glance facts the Runs home draws (quiet-console phase 7) ---- */
  /** Whether a person dismissed this stop, or the board overtook it. */
  resolved: boolean;
  stoppedBy: 'operator' | 'system' | null;
  onLimit: NonNullable<RunState['onLimit']> | null;
  waitReason: NonNullable<RunState['waitReason']> | null;
  hold: NonNullable<RunState['hold']> | null;
  freeze: RunState['freeze'];
  pause: RunState['pause'];
  /** Booked spend; `liveUsd` is what the sessions in flight have cost so far, booked when each ends. */
  spentUsd: number;
  liveUsd: number;
  runBudgetUsd: number | null;
  /** Wall-clock the phases worked for, freezes subtracted; null when nothing ran. */
  workedMs: number | null;
  model: string;
  effort: string | null;
  maxConsecutiveFailures: number;
  /**
   * The phases the board reads in progress that nothing of this run drives
   * (control-tower phase 79, #114) — the home's undriven card reads them off
   * the slim row (7.0). Empty for every run but a live one with such a phase.
   */
  undriven: ReturnType<typeof undrivenPhases>;
};

/** The field names, as a list a test and a reader can hold the shape to. */
export const SLIM_RUN_FIELDS = Object.freeze([
  'id', 'slug', 'status', 'lifecycle', 'activePhase', 'halt', 'children', 'liveness', 'verifying', 'phases',
  'records', 'waitUntil', 'accountId', 'consecutiveFailures', 'createdAt', 'updatedAt', 'finishedReason',
  'resolved', 'stoppedBy', 'onLimit', 'waitReason', 'hold', 'freeze', 'pause', 'spentUsd', 'liveUsd',
  'runBudgetUsd', 'workedMs', 'model', 'effort', 'maxConsecutiveFailures', 'undriven',
] as const);

/**
 * The run's verifying lanes this console is running NOW (control-tower phase
 * 89): an entry is written by the process that runs the commands, so one
 * stamped with another pid is a pass a dead console left — over, not live.
 */
export function liveVerifying(run: Pick<RunState, 'verifying'>, pid: number = process.pid): NonNullable<RunState['verifying']> {
  return Object.fromEntries(Object.entries(run.verifying ?? {}).filter(([, lane]) => lane?.pid === pid));
}

/** Settled well: done or skipped. A pending phase asked nothing of the run and carries no facts either. */
const SETTLED_OR_UNTOUCHED = new Set(['done', 'skipped', 'pending']);

/** The recovery facts of every phase not settled well — what `haltCtx` reads (7.0). */
export function slimRecords(run: Pick<RunState, 'phases' | 'recoveries'>): Record<string, SlimPhaseFacts> {
  const out: Record<string, SlimPhaseFacts> = {};
  for (const [phase, record] of Object.entries(run.phases ?? {})) {
    if (!record || SETTLED_OR_UNTOUCHED.has(record.status)) continue;
    const errand = run.recoveries?.[phase]?.errand as { situation?: unknown } | undefined;
    const key = record.situation?.key ?? (typeof errand?.situation === 'string' ? errand.situation : undefined);
    out[phase] = {
      resumable: Boolean(record.sessionId ?? record.resumeSessionId),
      situation: key ? { key } : null,
    };
  }
  return out;
}

export function slimRun(run: RunState, liveness: LaneLiveness[], nowMs: number = Date.now()): SlimRun {
  // The in-flight spend rides each live lane's liveness (`Lane.spentUsd`), not
  // the stored record, which books a session only when it ends.
  const liveUsd = liveness.reduce((sum, lane) => sum + (lane.spentUsd ?? 0), 0);
  let workedMs: number | null = null;
  for (const record of Object.values(run.phases ?? {})) {
    if (!record) continue;
    const worked = phaseClocks(record, nowMs).workedMs;
    if (worked != null) workedMs = (workedMs ?? 0) + worked;
  }
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
    records: slimRecords(run),
    waitUntil: run.waitUntil ?? null,
    accountId: run.accountId ?? null,
    consecutiveFailures: run.consecutiveFailures ?? 0,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedReason: run.finishedReason ?? null,
    resolved: Boolean(run.resolved),
    stoppedBy: run.stoppedBy ?? null,
    onLimit: run.onLimit ?? null,
    waitReason: run.waitReason ?? null,
    hold: run.hold ?? null,
    freeze: run.freeze ?? null,
    pause: run.pause ?? null,
    spentUsd: run.spentUsd ?? 0,
    liveUsd,
    runBudgetUsd: run.runBudgetUsd ?? null,
    workedMs,
    model: run.model,
    effort: run.effort ?? null,
    maxConsecutiveFailures: run.maxConsecutiveFailures ?? 0,
    // Through the one reader the whole-list route and the inbox use, so the
    // slim row's list is the record's, never a field the record does not have.
    undriven: undrivenPhases(run),
  };
}

/** A predicate's facts, read off the slim run and the queue — so a wait answers what `status` prints. */
export function factsOf(run: Pick<SlimRun, 'id' | 'status' | 'phases'> | null, queued: readonly number[]): RunFacts | null {
  if (!run) return null;
  return { runId: run.id, status: run.status, phases: run.phases, queued: [...queued] };
}
