/**
 * The Runs home's data — every run in exactly one group, the lanes a run
 * holds, and what could start next (7.0, quiet-console phase 7).
 *
 * Born as `features/now/model.ts`, the Now page's model; 6.0 folded Now into
 * the Tower on `#/runs` (control-tower phases 20–21) and moved this module
 * beside it as `features/runs/lanes-model.ts`; 7.0 moves it under `data/`,
 * where the header's situation words and the Runs home fold from ONE place.
 * The history below is the page's, and every rule in it still holds.
 *
 * ## Why the whole page is decided here
 *
 * The dashboard this replaces made its decisions inside its render: which run
 * counted as live, which ready phase to recommend, whether a card was a demand
 * or information. Every one of those was then untestable without a server, a
 * fetch mock and a click — so the rules drifted, and the page and the ready
 * board recommended different phases for a fortnight before anyone noticed.
 *
 * **This module decides, the components render, and the server performs.**
 * Nothing in the fold imports React, touches the network or reads a clock it
 * was not handed — `now` is a parameter everywhere, so one render is one
 * consistent answer and a test can state the date. The one hook at the end,
 * `useRunGroups`, only gathers the reads and hands them to the fold.
 *
 * ## Slim rows, whole records
 *
 * The home folds its groups from the SLIM list (`useRunList`, #234): a run's
 * status, lifecycle, halt, lanes, one word per phase and the glance facts —
 * never every phase's attempts and notes. A whole record is read only for the
 * row a person opened. So every reader here takes a `RunLike`: a slim row, or
 * a whole `RunState` (the open row, the corpus the tests fold, a run another
 * surface already holds), and `asRunLike` is the one adapter the status model
 * and the halt view read either shape through. The group fold itself is
 * `run-groups.ts`, which imports the status model — kept off this module so a
 * lane reader never carries the word tables.
 */

import { STALL_DEFAULTS, attentionCount } from '@shared/attention-model.js';
import { isClosed } from '@/lib/closure';
import { plural } from '@/lib/format';
import { isLiveStatus } from '@/lib/status-vocab';
import type { GATE_KINDS } from '@shared/plan-vocab.js';
import type {
  ChildRef,
  ForeignSession,
  InboxItem,
  LaneLiveness,
  PhaseEta,
  PhaseLock,
  PhaseRecord,
  PhaseStatus,
  PhaseTask,
  PhaseView,
  PlanDetail,
  PlanSummaryFull,
  RunState,
  SlimRun,
  VerifyingLane,
} from '@/data/api';

/* ================================================================== *
 * 1 · The inbox
 * ================================================================== */

/**
 * Moved to `@/data/api/inbox` — `splitActions` in quiet-console phase 4, the
 * flag reasons and the ask partition in phase 5 — where the cards in `cards/`
 * and the bell read them too.
 */
export { FLAG_REASON, flagReason, partitionAsks, splitActions } from '@/data/api/inbox';

/**
 * What the badge and the header count.
 *
 * `fyi` is deliberately excluded: a ruling worth reading and a lock nobody is
 * queued behind are both real rows, and neither is a person being waited on.
 * A badge that counts them is a badge that is never zero, and a badge that is
 * never zero stops being read — the exact failure the 182-unread notification
 * inbox demonstrated.
 */
export const needsYouCount = (items: readonly InboxItem[] | undefined): number => attentionCount(items);

/* ================================================================== *
 * 2 · A run, either shape
 * ================================================================== */

/** A run as the fold reads it: a slim row (the list) or a whole record (the open row, a test's corpus). */
export type RunLike = SlimRun | RunState;

/** A slim row's phases are words; a record's are records. The adapter below folds the first into the second. */
export function isSlimRun(run: RunLike): run is SlimRun {
  const first = Object.values(run.phases ?? {})[0];
  return typeof first === 'string' || (first === undefined && 'liveUsd' in run);
}

/** A slim row's phase, as the status model and the halt view read a record. */
export interface FoldedRecord {
  phase: number;
  status: PhaseStatus;
  resumable?: boolean;
  situation?: { key: string } | null;
}

/**
 * The run as `describeRun`, `haltView` and the recovery model read it. A whole
 * record passes through untouched; a slim row's phase words become records
 * carrying the recovery facts the server folded (`records`), so the halt view
 * recommends what the whole record would (#278).
 */
export function asRunLike(
  run: RunLike,
): RunState | (Omit<SlimRun, 'phases'> & { phases: Record<string, FoldedRecord> }) {
  if (!isSlimRun(run)) return run;
  const phases = Object.fromEntries(
    Object.entries(run.phases ?? {}).map(([key, status]) => [
      key,
      { phase: Number(key), status, ...(run.records?.[key] ?? {}) } satisfies FoldedRecord,
    ]),
  );
  return { ...run, phases };
}

/** Run statuses that mean a loop is behind this run right now — `isLiveStatus` over the run's own status. */
export const isLive = (status: string): boolean => isLiveStatus(status);

/** One phase of a run, as every figure reader sees it: the status word, and a record's clocks when the whole record is held. */
export interface GlancePhase {
  phase: number;
  status: string;
  stop?: { kind?: string };
}

/** The figures a run's ONE LINE draws — read off a slim row, or computed from a whole record. */
export interface RunGlance {
  /** Every phase this run touched, in phase order. */
  phases: GlancePhase[];
  done: number;
  spentUsd: number;
  /** The in-flight part — a session's dollars are booked when it ends. */
  liveUsd: number;
  budgetUsd: number | null;
  workedMs: number | null;
  model: string | undefined;
  effort: string | undefined;
}

const recordsOf = (run: RunState): PhaseRecord[] =>
  Object.values(run.phases ?? {})
    .filter((record): record is PhaseRecord => record != null)
    .sort((a, b) => a.phase - b.phase);

export function glanceOf(run: RunLike): RunGlance {
  if (isSlimRun(run)) {
    const phases = Object.entries(run.phases ?? {})
      .map(([key, status]) => ({ phase: Number(key), status }))
      .filter((p) => Number.isFinite(p.phase))
      .sort((a, b) => a.phase - b.phase);
    return {
      phases,
      done: phases.filter((p) => p.status === 'done').length,
      spentUsd: run.spentUsd ?? 0,
      liveUsd: run.liveUsd ?? 0,
      budgetUsd: run.runBudgetUsd ?? null,
      workedMs: run.workedMs ?? null,
      model: run.model,
      effort: run.effort ?? undefined,
    };
  }
  const records = recordsOf(run);
  let liveUsd = 0;
  let worked = 0;
  for (const record of records) {
    if (record.status === 'running' || record.status === 'verifying') liveUsd += record.live?.spentUsd ?? 0;
    worked += record.durationMs ?? 0;
  }
  return {
    phases: records.map((p) => ({
      phase: p.phase,
      status: p.status,
      ...(p.lifecycle?.stop ? { stop: p.lifecycle.stop } : {}),
    })),
    done: records.filter((p) => p.status === 'done').length,
    spentUsd: run.spentUsd ?? 0,
    liveUsd,
    budgetUsd: run.runBudgetUsd ?? null,
    workedMs: worked || null,
    model: run.model,
    effort: run.effort,
  };
}

/* ================================================================== *
 * 3 · The live lanes
 * ================================================================== */

/** One phase being worked on right now, with everything a row shows. */
export interface NowLane {
  /** `${runId}#${phase}` — stable across re-sorts, which is what keys React. */
  key: string;
  slug: string;
  planTitle: string;
  runId: string;
  phase: number;
  /** From the plan detail, once it lands — see `enriched`. */
  title?: string;
  /**
   * Why the lane stopped, when its record says (`lifecycle.stop`).
   *
   * Carried because the strip and the table paint the SAME record and must not
   * disagree: `phaseUiState` reads this to tell the two parks nobody is being
   * asked about — behind another lane's scope, or an MCP server that would not
   * connect — from the six that are an ask. Dropping it here is how one screen
   * came to bucket a phase as "needs you" above a row painting it `waiting`.
   */
  stop?: { kind?: string };
  /** The LANE's status, never the run's: a run runs, a lane may be verifying. */
  status: string;
  runStatus: string;
  model?: string;
  effort?: string;
  /** The live child, when there is one — a queued lane has none. */
  child?: ChildRef;
  /**
   * The console's own check on this phase while one runs — its §Verification,
   * its baseline or a wrap-up's fast gate (`run.verifying`, control-tower
   * phase 105, #193). A phase whose only live work is a check IS a lane: its
   * record may still read `pending` (a baseline before boarding), and the run
   * holds its scope all the same.
   */
  check?: VerifyingLane;
  /**
   * The base the run's branch — and so this lane's — was cut from, as the
   * runner resolved it (`RunState.base`, phase 15). A fact about the RUN,
   * carried on the lane so the branch chip's title can say it without a
   * second fetch. Absent when the run never resolved one.
   */
  base?: RunState['base'];
  startedAt?: string;
  costUsd: number;
  turns?: number;
  attempts: number;
  liveness?: LaneLiveness;
  /** The park's own clock and the session's words for what it waits on. */
  parkedUntil?: string;
  parkReason?: string;
  watch?: string[];
  /** Queued behind somebody else's lock since this instant. */
  lockWaitSince?: string;
  /**
   * The record's own sentence about why it stopped (`PhaseRecord.note`).
   *
   * The fleet table and the phase table have always drawn this; Now never did,
   * and the gap had one sharp edge. The admission cap's two-hour park writes
   * its WHOLE account here — `phase 7 is locked by <owner> and has waited 120
   * minutes for it (its lease ends …)` — and sets `stop.kind` to `scope-cap`.
   * Without the note, a lane parked by the cap rendered on this page as the
   * bare word "parked" with nothing after it, on the destination whose entire
   * question is what is happening and why.
   */
  note?: string;
  /** The server's own estimate for this phase. Never computed here. */
  eta?: PhaseEta;
  /** Frozen under SIGSTOP — the lane's own flag, not the run's single slot. */
  frozen: boolean;
  /**
   * The session's own task list, as the server folded it.
   *
   * Carried on the lane rather than fetched per row because every surface that
   * draws a lane already holds the run record it comes from — and because the
   * one-line summary (`taskSummary`) is what a row shows: `3/7 · Wiring the
   * runner` answers "what is it doing" without opening anything.
   */
  tasks?: PhaseTask[];
  /**
   * A QA round in flight on a phase the board reads `done` — the one lane
   * whose status is not in `LANE_STATUSES`. The round number is what the tab
   * says; everything else about the lane reads as any other.
   */
  qa?: { round: number };
  /** The plan detail has landed, so `title` and `eta` are real. */
  enriched: boolean;
  /**
   * Folded from a SLIM row (7.0): the lane's status, process, check, liveness
   * and clock are real; its cost, turns, tasks, park and note are the whole
   * record's, read when the row is opened.
   */
  slim?: true;
}

/**
 * Lane statuses that are "being worked on" rather than settled.
 *
 * ⚠️ **This is THE lane status set, and there is deliberately only one.**
 * The 6.x session panes had a second, shorter list of their own
 * (`running · verifying · awaiting-verification · queued`) feeding the tab
 * strips, while this one fed `LiveStrip`, the Sessions list and Now. Both were
 * live on `#/runs`, so a parked or gated lane was listed by the strip at the
 * top of the page and then given no tab below it: the same screen showing a
 * lane and denying it exists. The Run view's sessions fold
 * (`screens/plan/run/session-panes.tsx`) and every lane fold filter on this
 * set — a status added here reaches every lane surface at once, which is the
 * property the two lists could not have.
 */
export const LANE_STATUSES: readonly PhaseStatus[] = [
  'running',
  'verifying',
  'awaiting-verification',
  'queued',
  'waiting',
  'parked',
  'gated',
];

const LANE_STATUS_SET = new Set<string>(LANE_STATUSES);

/**
 * Every lane of every live run, worst first.
 *
 * Read from `run.phases` rather than `run.children`, deliberately: `children`
 * holds only lanes with a live process, and a lane queued behind a lock or
 * parked on an external clock is exactly the one somebody is asking about.
 * `child` is then attached where there is one, which is what tells a running
 * lane from a waiting one on the row.
 *
 * Liveness comes off the phase record — `RunDetail.liveness[]` is fresher, but
 * it costs one `GET /api/run/:slug` per plan and this page holds none of them.
 * The record's copy is what the server itself falls back to; the row draws it
 * through `Heartbeat`, which reports silence rather than pretending to a pulse.
 */
export function nowLanes(
  runs: readonly RunState[],
  details: Map<string, PlanDetail> = new Map(),
  now = Date.now(),
): NowLane[] {
  const out: NowLane[] = [];

  for (const run of runs) {
    if (!isLiveRun(run)) continue;
    const detail = details.get(run.slug);
    const phases = new Map((detail?.phases ?? []).map((p: PhaseView) => [p.phase, p]));
    const etas = new Map((detail?.eta?.perPhase ?? []).map((e) => [e.phase, e]));
    const checks = runChecks(run);
    const drawn = new Set<number>();

    for (const [key, record] of Object.entries(run.phases ?? {})) {
      if (!record || !/^\d+$/.test(key)) continue;
      const check = checks.get(record.phase);
      // A `done` phase with a QA round in flight IS a lane — the reviewer is a
      // session the run is paying for, and `done` is the only status a review
      // ever runs under. `LANE_STATUSES` itself is left alone: the round is a
      // marker on the record, not a ninth phase status. So is a phase the
      // console is running a check for (control-tower phase 105, #193): a
      // baseline leaves its record `pending` for as long as it measures, and
      // that lane was on no surface at all.
      const laneStatus = LANE_STATUS_SET.has(record.status) || record.qaSession;
      if (!laneStatus && !check) continue;
      drawn.add(record.phase);
      const child = run.children?.[key] ?? (run.child?.phase === record.phase ? run.child : undefined);
      const view = phases.get(record.phase);
      out.push({
        key: `${run.id}#${record.phase}`,
        slug: run.slug,
        planTitle: detail?.summary?.title || run.slug,
        runId: run.id,
        phase: record.phase,
        ...(view?.title ? { title: view.title } : {}),
        // The check's word for a lane whose record says nothing live yet.
        status: laneStatus ? record.status : 'verifying',
        ...(check ? { check } : {}),
        ...(record.lifecycle?.stop ? { stop: record.lifecycle.stop } : {}),
        runStatus: run.status,
        ...((record.model ?? run.model) ? { model: record.model ?? run.model } : {}),
        ...((record.effort ?? run.effort) ? { effort: record.effort ?? run.effort } : {}),
        ...(child ? { child } : {}),
        ...(run.base ? { base: run.base } : {}),
        ...((child?.startedAt ?? record.startedAt ?? check?.startedAt)
          ? { startedAt: child?.startedAt ?? record.startedAt ?? check?.startedAt }
          : {}),
        costUsd: record.costUsd ?? 0,
        ...(record.turns != null ? { turns: record.turns } : {}),
        attempts: record.attempts ?? 0,
        ...(record.liveness ? { liveness: record.liveness } : {}),
        ...(record.tasks?.length ? { tasks: record.tasks } : {}),
        ...(record.qaSession ? { qa: { round: record.qaSession.round } } : {}),
        ...(record.parkedUntil ? { parkedUntil: record.parkedUntil } : {}),
        ...(record.parkReason ? { parkReason: record.parkReason } : {}),
        ...(record.watch?.length ? { watch: record.watch } : {}),
        ...(record.lockWaitSince ? { lockWaitSince: record.lockWaitSince } : {}),
        ...(record.note ? { note: record.note } : {}),
        ...(etas.get(record.phase) ? { eta: etas.get(record.phase)! } : {}),
        frozen: Boolean(child?.frozen ?? (run.freeze && run.freeze.phase === record.phase)),
        enriched: view != null,
      });
    }
    // A check whose phase has no record at all is a lane all the same: the
    // console is running it, so the run is working.
    for (const check of checks.values()) {
      if (drawn.has(check.phase)) continue;
      const view = phases.get(check.phase);
      out.push({
        key: `${run.id}#${check.phase}`,
        slug: run.slug,
        planTitle: detail?.summary?.title || run.slug,
        runId: run.id,
        phase: check.phase,
        ...(view?.title ? { title: view.title } : {}),
        status: 'verifying',
        check,
        runStatus: run.status,
        startedAt: check.startedAt,
        costUsd: 0,
        attempts: 0,
        frozen: false,
        enriched: view != null,
      });
    }
  }

  return out.sort((a, b) => laneOrder(a, b, now));
}

/**
 * The lanes of a SLIM row (7.0): every phase whose word is a lane status, and
 * every phase the console is checking, with the process, the check, the lane's
 * liveness and its clock — what the glance draws. The record's own facts (its
 * cost, its tasks, its park's words) are the opened row's, through `nowLanes`.
 */
export function slimLanes(run: SlimRun, now = Date.now()): NowLane[] {
  if (!isLiveRun(run)) return [];
  const out: NowLane[] = [];
  const checks = runChecks(run);
  const drawn = new Set<number>();
  const liveness = new Map(run.liveness.map((lane) => [lane.phase, lane]));
  const lane = (phase: number, status: string, check: VerifyingLane | undefined): NowLane => {
    const child = run.children?.[String(phase)];
    const beat = liveness.get(phase);
    const startedAt = child?.startedAt ?? check?.startedAt;
    return {
      key: `${run.id}#${phase}`,
      slug: run.slug,
      planTitle: run.slug,
      runId: run.id,
      phase,
      status,
      ...(check ? { check } : {}),
      runStatus: run.status,
      ...(run.model ? { model: run.model } : {}),
      ...(run.effort ? { effort: run.effort } : {}),
      ...(child ? { child } : {}),
      ...(startedAt ? { startedAt } : {}),
      costUsd: 0,
      attempts: 0,
      ...(beat ? { liveness: beat } : {}),
      frozen: Boolean(child?.frozen ?? (run.freeze && run.freeze.phase === phase)),
      enriched: false,
      slim: true,
    };
  };
  for (const [key, status] of Object.entries(run.phases ?? {})) {
    if (!/^\d+$/.test(key)) continue;
    const phase = Number(key);
    const check = checks.get(phase);
    if (!LANE_STATUS_SET.has(status) && !check) continue;
    drawn.add(phase);
    out.push(lane(phase, LANE_STATUS_SET.has(status) ? status : 'verifying', check));
  }
  for (const check of checks.values()) {
    if (!drawn.has(check.phase)) out.push(lane(check.phase, 'verifying', check));
  }
  return out.sort((a, b) => laneOrder(a, b, now));
}

/** Every lane of every run, either shape, worst first — the one fold the home and the header read. */
export function lanesOf(
  runs: readonly RunLike[],
  details: Map<string, PlanDetail> = new Map(),
  now = Date.now(),
): NowLane[] {
  const out: NowLane[] = [];
  for (const run of runs) {
    if (isSlimRun(run)) out.push(...slimLanes(run, now));
    else out.push(...nowLanes([run], details, now));
  }
  return out.sort((a, b) => laneOrder(a, b, now));
}

/** A run's live console checks by phase — `run.verifying`, entries that name a phase. */
export function runChecks(run: Pick<RunLike, 'verifying'>): Map<number, VerifyingLane> {
  const out = new Map<number, VerifyingLane>();
  for (const check of Object.values(run.verifying ?? {})) {
    if (check != null && Number.isFinite(check.phase)) out.set(check.phase, check);
  }
  return out;
}

/** The console's own checks on a run, in phase order — nothing from a server that sends none. */
export function checksOf(run: Pick<RunLike, 'verifying'>): VerifyingLane[] {
  return [...runChecks(run).values()].sort((a, b) => a.phase - b.phase);
}

/**
 * Worst first, then oldest.
 *
 * A lane that is not moving outranks a healthy one however long the healthy
 * one has been going: the whole reason to look at this list is to find the one
 * that is not working. Within a rank the oldest leads, for the same reason
 * `sortInbox` puts the oldest ask first — the newest thing is the one you
 * already know about.
 *
 * ⚠️ **"Not moving" is TWO facts, and reading only the first is the defect
 * this comment exists for.** `liveness.stall` is the runner's own record,
 * written by a 60-second ticker; `liveness.lastOutputAt` is the raw clock the
 * row's heartbeat draws from. Seen live on the Phase 8 tour: a lane silent for
 * 34 minutes with no `stall` record yet sat BELOW a healthy one, while the
 * heartbeat beside it read `silent 34:29` and the inbox above it carried a
 * stall row about that very phase — three surfaces on one screen, two saying
 * "this one" and the ordering saying "not especially". The CLOCK decides the
 * order; the record only supplies the badge's word.
 */
export function laneOrder(a: NowLane, b: NowLane, now = Date.now()): number {
  const rank = laneRank(a, now) - laneRank(b, now);
  if (rank !== 0) return rank;
  const at = Date.parse(a.startedAt ?? '');
  const bt = Date.parse(b.startedAt ?? '');
  const ax = Number.isFinite(at) ? at : Infinity;
  const bx = Number.isFinite(bt) ? bt : Infinity;
  if (ax !== bx) return ax < bx ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Silent past the runner's own floor, by the lane's own clock.
 *
 * `STALL_DEFAULTS.stallSilentMs` — the same constant the detector uses and the
 * same one the row's `Heartbeat` stops pulsing at, so the order, the dot and
 * the push notification cannot disagree about when silence begins.
 */
export function laneSilent(lane: NowLane, now = Date.now()): boolean {
  if (lane.status !== 'running') return false;
  // A frozen lane is silent BY CONSTRUCTION — the operator stopped it — so
  // every clock that measures silence would report it, and the one thing a
  // deliberate act must never look like is a failure. The server suppresses the
  // same signal at `evaluateStall`; this is the client's half of it, and it is
  // needed separately because this clock runs off `lastOutputAt` on the wire
  // rather than off the runner's episode.
  if (lane.frozen) return false;
  const last = Date.parse(lane.liveness?.lastOutputAt ?? '');
  return Number.isFinite(last) && now - last >= STALL_DEFAULTS.stallSilentMs;
}

function laneRank(lane: NowLane, now: number): number {
  // Before the stall test, not after. A lane is frozen or it is stalled, never
  // both, and asking about the stall first meant a frozen lane sorted into the
  // attention band with a stall episode still on its record from the seconds
  // before the freeze landed.
  if (lane.frozen) return 1;
  if (lane.liveness?.stall || laneSilent(lane, now)) return 0;
  if (lane.status === 'running' || lane.status === 'verifying') return 2;
  return 3;
}

/** Whether a run has a loop behind it — `isLive` over the run's own status. */
export function isLiveRun(run: Pick<RunLike, 'status'> | null | undefined): boolean {
  return run != null && isLiveStatus(run.status);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * The one run per plan this page talks about — the newest that still matters.
 *
 * Moved verbatim from `views/pulse/index.tsx`, whose page this absorbs. Its
 * test moved with it.
 */
export function pulseRuns(runs: readonly RunState[], now = Date.now()): RunState[] {
  const newestPerPlan = new Map<string, RunState>();
  for (const run of runs) {
    const seen = newestPerPlan.get(run.slug);
    if (!seen || Date.parse(run.updatedAt) > Date.parse(seen.updatedAt)) {
      newestPerPlan.set(run.slug, run);
    }
  }
  const rank = (run: RunState): number => {
    if (isLiveRun(run)) return 0;
    if (!run.resolved && ['halted', 'interrupted', 'parked'].includes(run.status)) return 1;
    return 2;
  };
  return [...newestPerPlan.values()]
    .filter((run) => rank(run) < 2 || now - Date.parse(run.updatedAt) < DAY_MS)
    .sort((a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/**
 * Hook-reported sessions no lane row will draw: live ones with no plan (a
 * `claude` in the repository that claimed nothing) or whose plan has no lane
 * here, plus what ended in the last hour — the "just left" an operator asks
 * about. Moved from `views/pulse/index.tsx`.
 */
/** The vehicle a hook-reported session is, in words. */
export function foreignVehicle(session: Pick<ForeignSession, 'kind'>): string {
  return session.kind === 'agent'
    ? 'Console agent'
    : session.kind === 'autopilot'
      ? 'Autopilot session'
      : 'Terminal session';
}

/**
 * How a foreign session's end reads, when it has ended (REG-9): `ended` for one
 * it reported itself, `ended · inferred` for one the probe concluded from a
 * process that was gone — whose `endedAt` is the last evidence of life, not
 * the moment anybody looked. Null while it has not ended.
 */
export function endedLabel(session: Pick<ForeignSession, 'presence' | 'endedBy'>): string | null {
  if (session.presence !== 'ended') return null;
  return session.endedBy === 'probe' ? 'ended · inferred' : 'ended';
}

/**
 * A foreign session's turn count as a page may print it (REG-9): `unknown` when
 * the record moved many times and never saw a Stop — a 0 nobody counted — and
 * the number otherwise, with the stream named when the runner's stream is what
 * counted it (the run's settings displace the machine's Stop hook).
 */
export function turnsLabel(session: Pick<ForeignSession, 'turns' | 'turnsSource'>): string {
  if (session.turnsSource === 'unknown') return 'unknown';
  if (session.turnsSource === 'stream')
    return `${session.turns} (counted by the run's stream — the run's settings displace the Stop hook)`;
  return String(session.turns);
}

export function otherSessions(
  sessions: readonly ForeignSession[] | undefined,
  // A `NowLane` satisfies this, and so does a bare `RunState` — `child` is
  // `ChildRef | null` there. Widening the parameter rather than the field is
  // what lets a caller hand over either without a cast.
  lanes: readonly { slug: string; child?: ChildRef | null }[],
  now = Date.now(),
): ForeignSession[] {
  if (!sessions?.length) return [];
  const shown = new Set(lanes.map((lane) => lane.slug));
  const own = new Set(lanes.map((lane) => lane.child?.sessionId).filter(Boolean));
  return sessions
    .filter((s) => !own.has(s.sessionId))
    .filter(
      (s) =>
        (s.presence === 'live' && !(s.plan && shown.has(s.plan.slug))) ||
        (s.presence === 'ended' && s.endedAt != null && now - Date.parse(s.endedAt) < HOUR_MS),
    )
    .sort(
      (a, b) =>
        (a.presence === 'live' ? 0 : 1) - (b.presence === 'live' ? 0 : 1) ||
        b.lastSeen.localeCompare(a.lastSeen),
    );
}

/* ================================================================== *
 * 4 · Next up — the departures board, moved whole
 *
 * From `views/ready/model.ts`. Nothing about the ranking changed: the Ready
 * page and the dashboard's own "next move" line were two implementations of
 * one decision, and this section is the surviving one.
 * ================================================================== */

/** One phase that could start right now, with everything needed to choose it. */
export interface Departure {
  /** `slug#phase` — stable across re-ranks, which is what keyframes React. */
  key: string;
  slug: string;
  planTitle: string;
  phase: number;
  title?: string;
  size?: string;
  weight?: number;
  gated: boolean;
  gates?: string;
  /** Who can clear the gate — human / ai / auto. Absent on older servers. */
  gateKind?: (typeof GATE_KINDS)[number];
  /** How many phases this one frees. The leverage signal. */
  unblocks: number;
  onCriticalPath: boolean;
  /** A live claim by another session — the reason not to boot this one. */
  lock?: PhaseLock;
  repos: string[];
  branch?: string;
  skills: string[];
  /** MCP servers the plan attaches to every session. */
  mcpServers: string[];
  model?: string;
  effort?: string;
  /** This phase failed its QA gate on a previous attempt. */
  qaFailed: boolean;
  /** The plan's session budget in tokens — what `weight` is a fraction of. */
  budget: number;
  /** Whole days since anything in this plan moved. */
  idleDays: number;
  activity: number;
  planPercent: number;
  planPhases: number;
  planDone: number;
  planErrors: number;
  /** The plan detail has landed, so title/size/weight are real. */
  enriched: boolean;
}

const DAY = 86_400_000;

/** A lock only counts as a claim while its lease is live. */
export const isClaimed = (lock: PhaseLock | undefined): boolean => Boolean(lock && !lock.expired);

/**
 * Build the queue.
 *
 * ## Closed plans never board
 *
 * The highest-stakes closure gate in the client, and the one place the server
 * cannot do it for us: `stats.ready` is `board.ready` verbatim — the engine
 * deliberately still reports what a closed plan never finished, so its own
 * page can say so — and a closed plan therefore arrives here with a populated
 * `ready` array. Every row this emits is an invitation to boot a session, and
 * emitting one for an abandoned plan is the console recommending work the
 * operator has already said will never happen.
 */
export function toDepartures(
  plans: readonly PlanSummaryFull[],
  details: Map<string, PlanDetail>,
  now = Date.now(),
): Departure[] {
  const out: Departure[] = [];

  for (const plan of plans) {
    if (isClosed(plan)) continue;
    const ready = (plan.ready ?? []).filter((n): n is number => typeof n === 'number');
    if (!ready.length) continue;

    const detail = details.get(plan.slug);
    const phases = new Map((detail?.phases ?? []).map((p: PhaseView) => [p.phase, p]));
    const idleDays = plan.activity ? Math.max(0, Math.floor((now - plan.activity) / DAY)) : 0;

    for (const phase of ready) {
      const view = phases.get(phase);
      out.push({
        key: `${plan.slug}#${phase}`,
        slug: plan.slug,
        planTitle: plan.title || plan.slug,
        phase,
        title: view?.title,
        size: view?.size,
        weight: view?.analysis?.weight ?? view?.weight,
        gated: view?.gated ?? false,
        gates: view?.gates,
        gateKind: view?.gateKind,
        // Before the detail lands, the summary knows the leverage of exactly one
        // phase — the one the engine already named as the best next move.
        unblocks: view?.analysis?.unblocks ?? (plan.nextBest?.phase === phase ? plan.nextBest.unblocks : 0),
        onCriticalPath: view?.analysis?.onCriticalPath ?? (plan.criticalPath ?? []).includes(phase),
        lock: view?.lock ?? (plan.locks ?? []).find((l) => l.phase === phase),
        repos: plan.repos ?? [],
        branch: plan.branch,
        skills: plan.skills ?? [],
        mcpServers: plan.mcpServers ?? [],
        model: view?.model ?? plan.targetModel,
        effort: view?.effort,
        qaFailed: (plan.qaFailures ?? []).includes(phase),
        budget: plan.budget || 0,
        idleDays,
        activity: plan.activity ?? 0,
        planPercent: plan.percent ?? 0,
        planPhases: plan.phases ?? 0,
        planDone: plan.done ?? 0,
        planErrors: plan.issueCounts?.error ?? 0,
        enriched: view != null,
      });
    }
  }

  return out;
}

/**
 * Five orders, because "what should I start next" has five defensible answers
 * and which one is right depends on the day. They are deliberately not five
 * sorts of the same list: each leads with a different first key, so the top of
 * the board actually changes.
 *
 * `modified` leads, and is the default: on any day with no particular strategy
 * in mind, the plan you touched last is the one you meant to come back to.
 * It sorts on `activity`, which the store defines as the newest mtime across
 * the plan and every one of its handoff artefacts — so it is last modification
 * in the literal sense, not a proxy for it. There is deliberately no SIXTH
 * order for that: a second comparator on the same first key would be one sort
 * wearing two labels, which is the thing this list exists not to do.
 */
export const RANKS = [
  {
    id: 'momentum',
    label: 'Last modified',
    hint: 'most recently changed',
    blurb:
      'Newest first, by the last change to the plan or any of its handoffs. Where you were working, so the context is still warm — in your head and in the handoff.',
  },
  {
    id: 'leverage',
    label: 'Leverage',
    hint: 'frees the most work',
    blurb: 'Phases that unblock the most other phases first — the fastest way to widen the board.',
  },
  {
    id: 'critical',
    label: 'Critical path',
    hint: 'sets the finish date',
    blurb: 'The chain the plan cannot finish without. Everything else has slack; these do not.',
  },
  {
    id: 'quick',
    label: 'Quick wins',
    hint: 'smallest first',
    blurb: 'Lightest phases first — what fits in the time you actually have.',
  },
  {
    id: 'unstick',
    label: 'Unstick',
    hint: 'idle longest',
    blurb: 'Plans with ready work nobody has touched. These are the ones that quietly rot.',
  },
] as const;

export type RankId = (typeof RANKS)[number]['id'];

/** Unknown weights sort last in every size-sensitive order rather than as zero. */
const weightOf = (d: Departure): number => (d.weight && d.weight > 0 ? d.weight : Number.MAX_SAFE_INTEGER);

const bySlugThenPhase = (a: Departure, b: Departure): number =>
  a.slug.localeCompare(b.slug) || a.phase - b.phase;

const COMPARE: Record<RankId, (a: Departure, b: Departure) => number> = {
  leverage: (a, b) =>
    b.unblocks - a.unblocks ||
    Number(b.onCriticalPath) - Number(a.onCriticalPath) ||
    weightOf(a) - weightOf(b) ||
    bySlugThenPhase(a, b),
  critical: (a, b) =>
    Number(b.onCriticalPath) - Number(a.onCriticalPath) ||
    b.unblocks - a.unblocks ||
    weightOf(a) - weightOf(b) ||
    bySlugThenPhase(a, b),
  quick: (a, b) => weightOf(a) - weightOf(b) || b.unblocks - a.unblocks || bySlugThenPhase(a, b),
  momentum: (a, b) => b.activity - a.activity || a.phase - b.phase || bySlugThenPhase(a, b),
  unstick: (a, b) => b.idleDays - a.idleDays || b.unblocks - a.unblocks || bySlugThenPhase(a, b),
};

/**
 * Rank the queue.
 *
 * A claimed phase is always pushed below the unclaimed ones regardless of
 * order: however good a move it is, it is somebody else's move, and offering
 * it at the top of the board is how two sessions end up in the same phase.
 */
export function rank(departures: readonly Departure[], by: RankId): Departure[] {
  const compare = COMPARE[by] ?? COMPARE.leverage;
  return [...departures].sort(
    (a, b) => Number(isClaimed(a.lock)) - Number(isClaimed(b.lock)) || compare(a, b),
  );
}

/**
 * Why a departure is where it is in the ranking — the chips a Ready row wears,
 * blockers first (a claim, a QA failure, a gate), then what it is worth (what
 * it frees, the critical path), then neglect.
 *
 * Moved here from Now's Next up with the page (control-tower phase 21): the
 * Tower's Ready bay is its one reader now, and it is a fact about a
 * `Departure`, which is this module's to say.
 */
export function reasons(d: Departure): { key: string; text: string; tone: 'good' | 'warn' | 'bad' }[] {
  const out: { key: string; text: string; tone: 'good' | 'warn' | 'bad' }[] = [];
  if (isClaimed(d.lock)) out.push({ key: 'lock', text: `claimed by ${d.lock!.owner}`, tone: 'bad' });
  if (d.qaFailed) out.push({ key: 'qa', text: 'QA failed here before', tone: 'bad' });
  if (d.gated) {
    out.push({
      key: 'gated',
      text:
        d.gateKind === 'ai'
          ? 'gated (ai) — the session clears it on boot'
          : d.gateKind === 'auto'
            ? 'gated — an automatic check must clear'
            : 'gated — a person must approve first',
      tone: 'warn',
    });
  }
  if (d.unblocks > 0)
    out.push({ key: 'unblocks', text: `frees ${plural(d.unblocks, 'phase')}`, tone: 'good' });
  if (d.onCriticalPath) out.push({ key: 'critical', text: 'on the critical path', tone: 'good' });
  if (d.idleDays >= 7)
    out.push({ key: 'idle', text: `untouched for ${plural(d.idleDays, 'day')}`, tone: 'warn' });
  return out;
}

/**
 * ⚠️ `repo` and `plan` have no control on Now — the board's two `<select>`s did
 * not come with it (see this file's header). They stay in the shape because the
 * filter is one function and the plan page will want "this plan only"; the
 * board's `repoOptions` vocabulary builder went, because a list of options for
 * a control that does not exist is dead code the deletion sweep would have to
 * find later.
 */

export interface Load {
  /** 0–1, clamped for drawing. Absent when there is no weight or no budget. */
  fraction: number | null;
  /** For the meter itself, where the bar is the message and the text is a check. */
  short: string;
  /** For prose and for the accessible name, where there is room to be exact. */
  long: string;
  /** The phase is heavier than the plan's own session budget. */
  over: boolean;
}

/**
 * The one number this whole skill is organised around: a phase is sized so its
 * working set fits a session, and a session is budgeted at a fraction of the
 * model's window. `40K` means nothing to read; the same weight against the
 * plan's own budget — `a fifth of a session` — is a decision.
 */
export function load(weight: number | undefined, budget: number): Load {
  if (!weight || !budget) {
    return { fraction: null, short: 'unsized', long: 'no weight declared', over: false };
  }
  const fraction = weight / budget;
  const percent = Math.round(fraction * 100);
  return {
    fraction: Math.min(1, fraction),
    short: fraction > 1 ? 'over' : `${percent}%`,
    long:
      fraction > 1
        ? `${percent}% of a session — more than the plan budgets for one`
        : fraction === 1
          ? 'exactly one session'
          : `${percent}% of a session`,
    over: fraction > 1,
  };
}
