/**
 * The run row's model — a run drawn as ONE LINE (7.0, quiet-console phase 7;
 * the strip's anatomy since control-tower phase 19, §Architecture 2's one line
 * per thing): a status dot and its word · the name · the track · one labelled
 * clock · the cost · ONE action — everything else one expansion away.
 *
 * Pure. The group a run sits in is the data layer's (`data/run-groups.ts`,
 * `bayOf(describeRun(run, ctx))` — the status model's answer, never this
 * file's), and the placed run travels here with the context it was placed
 * under, so the row's reading IS the group it sits in. Every reader takes a
 * `RunLike`: the slim row the home folds from (#234) or the whole record the
 * opened row reads, through `asRunLike`.
 *
 * ## One action, in order (#278)
 *
 * The 6.2 strip put a person's turn BEFORE the halt, so an older plan-wide
 * item took a halted run's action. Now the halt view decides first:
 *
 *   1. stopped on a halt it is not recovering from (any group but Running),
 *      on a console that may drive runs — the halt card's RECOMMENDED verb,
 *      `recoveryActionsFor(haltCtx)`'s first a row can press; with none, Open run;
 *   2. a person's turn on this run — the run's oldest item's primary, through
 *      the lazy item row;
 *   3. a console without `--allow-run` — Open run, the one move no flag guards;
 *   4. frozen — Thaw; pausing — Cancel pause; paused — Resume;
 *   5. by group: Running — Pause; Queued — Hold, or Release when held;
 *      Waiting — the recovery model's first verb for the waiting phase, else
 *      Pause; Settled — Open run.
 *
 * Through the lifecycle (`data/lifecycle.ts`) or the recovery model, never a
 * third source.
 */

import { PHASE_CLOCK_LABELS, PHASE_ROW_CLOCK, phaseClocks } from '@shared/phase-clocks.js';
import { haltCtx } from '@shared/halt-view.js';
import { haltSentence } from '@shared/halt-categories.js';
import { heldStopReason } from '@shared/orchestration-model.js';
import { describePhase, type StatusView } from '@shared/status-model.js';
import type { UiState } from '@shared/status-vocab.js';
import type { RecoveryCtx } from '@/cards/recovery-actions';
import type {
  ConvergeStatusView,
  FleetState,
  InboxItem,
  PhaseRecord,
  QueueEntry,
  RunState,
  VerifyingLane,
} from '@/data/api';
import { asRunLike, glanceOf, isSlimRun, laneSilent, type NowLane, type RunLike } from '@/data/lanes';
import { LIFECYCLE_WORDS, type LifecycleVerb } from '@/data/lifecycle';
import { waitingLabel } from '@/data/queue-words';
import type { PlacedRun, RunGroup } from '@/data/run-groups';
import { runItems } from '@/data/turn';
import type { LabelledClock } from '@/lib/format';
import { plural } from '@/lib/format';
import { recoveryActionsFor } from '@/lib/recovery';
import { isRunRecoverVerb } from '@/lib/run-recover-verbs';
import { runStatusWord, waitReasonOf } from '@/lib/status-vocab';
import { runHref } from '@/shell/routes';

/* ================================================================== *
 * 1 · The one action
 * ================================================================== */

/** The one thing to press, and whose door it goes through. */
export type RowAction =
  | { kind: 'lifecycle'; verb: LifecycleVerb; label: string; title: string }
  | {
      kind: 'recovery';
      /** The recovery model's verb id (`ACTION_VOCAB`). */
      id: string;
      label: string;
      title: string;
      /** Whether pressing it needs more than a press — words, a dialog — so the row opens instead. */
      needsMore: boolean;
      disabledReason?: string;
      target: { slug: string; phase?: number; runId?: string };
      ctx: RecoveryCtx;
    }
  | { kind: 'open'; label: string; title: string; href: string }
  /** A person's turn on this run (control-tower phase 42): the item's own primary act. */
  | { kind: 'step'; label: string; title: string; item: InboxItem };

export function lifecycleAction(verb: LifecycleVerb, label?: string, title?: string): RowAction {
  const words = LIFECYCLE_WORDS[verb];
  return { kind: 'lifecycle', verb, label: label ?? words.label, title: title ?? words.title };
}

/** The verbs that need more than a press — words, or a dialog — which the expanded row asks for. */
const NEEDS_MORE = new Set(['resume', 'delegate', 'errand-answered', 'retry-edits', 'fix-agent']);

/**
 * The recovery model's first verb a row can press — the button the halt card
 * draws first: not an overflow verb, and one the run's own route performs or a
 * fresh agent takes. A surface-owned verb (dismiss, force-release) needs a
 * surface that says how, and the row is not one.
 */
export function recommendedRecovery(
  ctx: RecoveryCtx,
  allowRun: boolean,
): ReturnType<typeof recoveryActionsFor>[number] | null {
  const actions = recoveryActionsFor({ ...ctx, flags: { allowRun } } as Parameters<
    typeof recoveryActionsFor
  >[0]);
  return (
    actions.find(
      (action) => action.group !== 'overflow' && (isRunRecoverVerb(action.id) || action.id === 'fix-agent'),
    ) ?? null
  );
}

function openAction(run: RunLike, title = 'Open the run page'): RowAction {
  return { kind: 'open', label: 'Open run', title, href: runHref(run.slug) };
}

function recoveryAction(
  run: RunLike,
  ctx: RecoveryCtx,
  phase: number | undefined,
  allowRun: boolean,
): RowAction | null {
  const found = recommendedRecovery(ctx, allowRun);
  if (!found) return null;
  return {
    kind: 'recovery',
    id: found.id,
    label: found.label,
    title: found.disabledReason ?? found.blurb,
    needsMore: NEEDS_MORE.has(found.id),
    ...(found.disabledReason ? { disabledReason: found.disabledReason } : {}),
    target: { slug: run.slug, ...(phase != null ? { phase } : {}), ...(run.id ? { runId: run.id } : {}) },
    ctx,
  };
}

/** A run's phase as the recovery model reads it — the whole record's, or the slim row's folded facts. */
type FoldedPhases = Record<
  string,
  { phase: number; status: string; resumable?: boolean; situation?: { key: string } | null }
>;

function foldedPhases(run: RunLike): FoldedPhases {
  return (asRunLike(run).phases ?? {}) as FoldedPhases;
}

/** The phase a waiting run waits on — the first lane not running, with its record. */
function waitingPhase(
  run: RunLike,
  lanes: readonly NowLane[],
): { phase: number; record: NonNullable<RecoveryCtx['record']> } | null {
  const phases = foldedPhases(run);
  for (const lane of lanes) {
    if (lane.status === 'running' || lane.status === 'verifying') continue;
    const record = phases[String(lane.phase)];
    if (record) {
      return {
        phase: lane.phase,
        record: {
          status: record.status,
          ...(record.resumable != null ? { resumable: record.resumable } : {}),
          ...(record.situation ? { situation: record.situation } : {}),
        },
      };
    }
  }
  return null;
}

export interface RowInput {
  placed: PlacedRun;
  /** Epoch ms — the row's clock. Passed in, so the model stays pure. */
  now: number;
  /** `--allow-run`: whether a lifecycle or recovery verb could be pressed at all. */
  allowRun: boolean;
}

export function rowAction(input: RowInput, facts: { frozen: boolean; held: boolean }): RowAction {
  const { placed, allowRun } = input;
  const { run, lanes, bay, ctx } = placed;
  const runCtx = { ...haltCtx(asRunLike(run) as Parameters<typeof haltCtx>[0]), run } as RecoveryCtx;

  // 1. A stop the halt view can recommend a way out of — before any item a
  // person's turn raised, which may be older and about something else (#278).
  if (run.halt && bay !== 'live' && allowRun) {
    return recoveryAction(run, runCtx, run.halt.phase ?? undefined, allowRun) ?? openAction(run);
  }
  // 2. A person's turn: the run's OLDEST item's primary IS the one thing to
  // press (control-tower phases 42, 139) — a step's act, a card's Allow, a
  // gate's Approve. Only a run a person's turn summoned: a plan-wide row names
  // no run, and must not take a Running row's Pause.
  const item =
    bay === 'needs-you' ? runItems(ctx.inbox as readonly InboxItem[] | undefined, run)[0] : undefined;
  if (item) {
    return {
      kind: 'step',
      label: 'Your turn',
      title: `Your turn — ${item.humanStep?.title ?? item.title}`,
      item,
    };
  }
  if (!allowRun) return openAction(run, 'This console cannot drive runs — open the run page to read it');
  if (facts.frozen) return lifecycleAction('thaw');
  if (run.status === 'pausing')
    return lifecycleAction('resume', 'Cancel pause', 'Carry on past the next phase boundary');
  if (run.status === 'paused') return lifecycleAction('resume');

  if (bay === 'needs-you') {
    const waiting = waitingPhase(run, lanes);
    const waitCtx = { run, ...(waiting ? { record: waiting.record } : {}) } as RecoveryCtx;
    return (
      recoveryAction(run, waitCtx, waiting?.phase, allowRun) ??
      openAction(run, 'Open the run page to answer it')
    );
  }
  if (bay === 'live') return lifecycleAction('pause');
  if (bay === 'queued') return facts.held ? lifecycleAction('release') : lifecycleAction('hold');
  if (bay === 'waiting') {
    const waiting = waitingPhase(run, lanes);
    const waitCtx = { run, ...(waiting ? { record: waiting.record } : {}) } as RecoveryCtx;
    return recoveryAction(run, waitCtx, waiting?.phase, allowRun) ?? lifecycleAction('pause');
  }
  return openAction(run);
}

/* ================================================================== *
 * 2 · The clocks (control-tower phase 19, #28)
 * ================================================================== */

type Clocks = ReturnType<typeof phaseClocks>;

const at = (value: string | number | null | undefined): number => {
  if (typeof value === 'number') return value;
  return value ? Date.parse(value) : Number.NaN;
};
const since = (value: string | number | null | undefined, now: number): number | null => {
  const t = at(value);
  return Number.isFinite(t) ? Math.max(0, now - t) : null;
};

/**
 * One phase's clocks, as of `now`, with the newest frame folded in:
 * `run:progress` writes the server's clocks to `record.live.phaseClocks`
 * rather than onto the record, so a clock computed from the record alone
 * would miss the window a frame just opened.
 */
export function recordClocks(record: PhaseRecord, now: number): Clocks {
  const frame = record.live?.phaseClocks;
  const merged = frame
    ? {
        ...record,
        ...(Array.isArray(frame.attemptWindows) && frame.attemptWindows.length
          ? { attemptWindows: frame.attemptWindows }
          : {}),
        ...(typeof frame.queuedMs === 'number' ? { queuedMs: frame.queuedMs } : {}),
      }
    : record;
  return phaseClocks(merged as Parameters<typeof phaseClocks>[0], now);
}

/** The verb and field of each named clock, for the expanded row's list. */
export const CLOCK_VERBS = {
  // The attempt's verb is the lane's — `running` while it runs, `ran` after.
  sinceThisAttemptMs: { verb: 'ran', tense: 'for' },
  sinceFirstBoardedMs: { verb: 'boarded', tense: 'ago' },
  workedMs: { verb: 'worked', tense: 'for' },
  queuedMs: { verb: 'queued', tense: 'for' },
  timeToFirstToolMs: { verb: 'first tool after', tense: 'for' },
} as const satisfies Record<string, { verb: string; tense: LabelledClock['tense'] }>;

export type NamedClock = keyof typeof CLOCK_VERBS;

/** Every named clock of one phase, labelled. `live` says the attempt is still going: its verb is `running`. */
export function phaseClockList(
  record: PhaseRecord,
  now: number,
  live = false,
): (LabelledClock & { field: NamedClock; label: string })[] {
  const clocks = recordClocks(record, now);
  return (Object.keys(CLOCK_VERBS) as NamedClock[]).map((field) => ({
    field,
    verb: field === 'sinceThisAttemptMs' && live ? 'running' : CLOCK_VERBS[field].verb,
    tense: CLOCK_VERBS[field].tense,
    ms: clocks[field],
    label: PHASE_CLOCK_LABELS[field],
  }));
}

/** A lane's own clock, for its row in the expanded run: this attempt, with the lane's verb. */
export function laneClock(lane: NowLane, record: PhaseRecord | undefined, now: number): LabelledClock {
  const verb = lane.frozen ? 'frozen' : lane.status === 'verifying' ? 'verifying' : lane.status;
  if (record) {
    const clocks = recordClocks(record, now);
    if (clocks[PHASE_ROW_CLOCK] != null) {
      return { verb, ms: clocks[PHASE_ROW_CLOCK], tense: 'for', label: PHASE_CLOCK_LABELS[PHASE_ROW_CLOCK] };
    }
  }
  if (lane.status === 'queued' && lane.lockWaitSince) {
    return { verb: 'queued', ms: since(lane.lockWaitSince, now), tense: 'for' };
  }
  return { verb, ms: since(lane.startedAt, now), tense: 'for' };
}

/** The whole record's phase, when the row holds the whole record. A slim row carries none. */
const recordOf = (run: RunLike, phase: number | null | undefined): PhaseRecord | undefined =>
  phase == null || isSlimRun(run) ? undefined : run.phases?.[String(phase)];

export interface ClockInput {
  run: RunLike;
  bay: RunGroup;
  lanes: readonly NowLane[];
  checks?: readonly VerifyingLane[];
  entry?: QueueEntry;
  frozen: boolean;
  /** The run's worked total, freezes subtracted. */
  workedMs: number | null;
  now: number;
}

/**
 * The ONE clock a row's glance reads, first match:
 *
 *  1. frozen — how long ago somebody froze it;
 *  2. stopped on a halt it is not recovering from — how long ago it halted;
 *  3. running — the moving lane's attempt clock, verb `running` or
 *     `verifying`; a run whose only work is the console's own check reads that
 *     check's clock;
 *  4. queued — how long it has queued, from the admission entry, else the
 *     lane's lock wait, else the record's own queue stamp;
 *  5. waiting — how long until it wakes when a clock is known, else how long
 *     it has waited since its attempt ended;
 *  6. settled — what it worked for: `ran`.
 *
 * Nothing measured is still a verb and `—`, never a bare zero.
 */
export function rowClock(input: ClockInput): LabelledClock {
  const { run, bay, lanes, entry, now } = input;
  if (input.frozen) {
    const frozenAt = run.freeze?.at ?? lanes.find((lane) => lane.frozen)?.child?.frozen?.at;
    return { verb: 'frozen', ms: since(frozenAt, now), tense: 'ago' };
  }
  if (run.halt && bay !== 'live') {
    return { verb: 'halted', ms: since(run.halt.at, now), tense: 'ago' };
  }
  if (bay === 'live' || (bay === 'needs-you' && lanes.some((lane) => lane.status === 'running'))) {
    const moving =
      lanes.find((lane) => lane.status === 'running' && !lane.frozen) ??
      lanes.find((lane) => lane.status === 'verifying');
    if (moving) return laneClock(moving, recordOf(run, moving.phase), now);
    const check = input.checks?.[0];
    if (check) return { verb: 'verifying', ms: since(check.startedAt, now), tense: 'for' };
    return { verb: 'running', ms: since(run.updatedAt, now), tense: 'for' };
  }
  if (bay === 'queued') {
    const lane = lanes.find((l) => l.status === 'queued');
    const stamp = entry?.since ?? lane?.lockWaitSince ?? recordOf(run, lane?.phase)?.queuedAt;
    return { verb: 'queued', ms: since(stamp, now), tense: 'for' };
  }
  if (bay === 'settled') {
    return { verb: 'ran', ms: input.workedMs, tense: 'for', label: PHASE_CLOCK_LABELS.workedMs };
  }
  // Waiting (and anything the fold has not named): the wake if one is set…
  const parked = lanes.find((lane) => lane.parkedUntil);
  const wake = at(parked?.parkedUntil ?? run.waitUntil);
  if (Number.isFinite(wake) && wake > now) return { verb: 'wakes in', ms: wake - now, tense: 'for' };
  // …else how long it has waited since its last attempt ended.
  const last = lanes.map((lane) => recordOf(run, lane.phase)?.endedAt).find(Boolean);
  if (last) return { verb: 'waiting', ms: since(last, now), tense: 'for' };
  return { verb: 'updated', ms: since(run.updatedAt, now), tense: 'ago' };
}

/* ================================================================== *
 * 3 · What holds it up (control-tower phase 20)
 * ================================================================== */

export interface WaitLine {
  /** Stable across polls — keys React. */
  key: string;
  kind: 'hold' | 'fence' | 'fold' | 'queue';
  text: string;
}

/** `P7, P8 and P9` — how the console names a run of phases in a sentence. */
export function phaseList(phases: readonly number[]): string {
  const names = phases.map((phase) => `P${phase}`);
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** `14:05Z` — the wall-clock end of a fence, in the words the wait notes use. */
function clockOf(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)}Z`;
}

/**
 * Four things hold a run up without being a stop somebody must answer, and
 * the record already carries each: the operator's HOLD, a SCOPE FENCE (a
 * sibling phase's external wall whose scope meets this one's), a FOLDED ERRAND
 * (one ask standing for several phases) and the ADMISSION QUEUE's holder. A
 * slim row carries the hold and the queue; the fences and the folds are the
 * whole record's, read when the row is opened.
 */
export function waitLines(
  run: RunLike,
  lanes: readonly NowLane[],
  entry: QueueEntry | undefined,
  now: number,
): WaitLine[] {
  const out: WaitLine[] = [];
  if (run.hold) {
    out.push({
      key: 'hold',
      kind: 'hold',
      text: `Held${run.hold.by ? ` by ${run.hold.by}` : ''}: nothing new boards until it is released`,
    });
  }
  if (!isSlimRun(run)) {
    const records = Object.values(run.phases ?? {})
      .filter((record) => record != null)
      .sort((a, b) => a.phase - b.phase);
    for (const record of records) {
      for (const holder of record.waitingOn ?? []) {
        if (holder.kind !== 'fence' || holder.phase == null) continue;
        const refs = holder.refs?.length ? holder.refs.join(', ') : 'the errand it filed';
        const lifts =
          holder.until != null && holder.until > now
            ? `; the fence lifts by itself at ${clockOf(holder.until)}`
            : '';
        out.push({
          key: `fence:${record.phase}`,
          kind: 'fence',
          text: `P${record.phase} is fenced by P${holder.phase}'s external wall, waiting on ${refs}${lifts}`,
        });
      }
    }
    for (const [key, slot] of Object.entries(run.recoveries ?? {})) {
      const also = slot?.errand?.alsoPhases?.filter((phase) => String(phase) !== key) ?? [];
      if (!also.length) continue;
      out.push({
        key: `fold:${key}`,
        kind: 'fold',
        text: `P${key}'s errand also stands for ${phaseList([...also].sort((a, b) => a - b))}: one wall, one ask`,
      });
    }
  }
  const queued = lanes.find((lane) => lane.status === 'queued');
  if (queued) {
    const said = waitingLabel(entry);
    // Only when the queue snapshot names a holder: the word already reads
    // "queued", and repeating the bare word under it says nothing.
    if (said !== 'queued')
      out.push({ key: `queue:${queued.phase}`, kind: 'queue', text: `P${queued.phase} ${said}` });
  }
  return out;
}

/* ================================================================== *
 * 4 · The track, compacted (design.md §7)
 * ================================================================== */

/** One station of the row's track — a phase, or a fold of several. */
export interface TrackStation {
  key: string;
  /** The word beside the dot — a station is never colour alone (`e2e/status.spec.ts`). */
  label: string;
  paint: UiState;
  settled: boolean;
  /** Observed live right now — the only station that may breathe. */
  live: boolean;
  /** The phase, for a station that is one; a fold has none. */
  phase?: number;
  /** How many phases a fold stands for. */
  count?: number;
}

/** Settled well: done or skipped. Untouched: pending. Everything else stands on its own. */
const SETTLED_WELL = new Set(['done', 'skipped']);

function phaseView(status: string, stop: { kind?: string } | undefined): StatusView {
  return describePhase(
    { status, ...(stop ? { lifecycle: { stop } } : {}) } as Parameters<typeof describePhase>[0],
    {},
  );
}

/**
 * A 35-phase run cannot draw 35 labelled stations on one line, so the glance
 * folds: the phases settled well into one hollow station ("6 done"), each
 * unsettled phase as its own ("P7 running", its state in the word because
 * unsettled dots differ by hue alone), the phases not yet touched into one
 * ("28 left"). The full track, every phase a station, is the expanded row's.
 */
export function compactTrack(
  phases: readonly { phase: number; status: string; stop?: { kind?: string } }[],
  observed: readonly number[] = [],
): TrackStation[] {
  const done = phases.filter((p) => SETTLED_WELL.has(p.status));
  const left = phases.filter((p) => p.status === 'pending');
  const standing = phases.filter((p) => !SETTLED_WELL.has(p.status) && p.status !== 'pending');
  const out: TrackStation[] = [];
  if (done.length)
    out.push({
      key: 'done',
      label: `${done.length} done`,
      paint: 'done',
      settled: true,
      live: false,
      count: done.length,
    });
  for (const p of standing) {
    const view = phaseView(p.status, p.stop);
    out.push({
      key: `p${p.phase}`,
      label: `P${p.phase} ${view.label.toLowerCase()}`,
      paint: view.paint,
      settled: view.tense === 'settled',
      live: observed.includes(p.phase),
      phase: p.phase,
    });
  }
  if (left.length)
    out.push({
      key: 'left',
      label: `${left.length} left`,
      paint: 'queued',
      settled: true,
      live: false,
      count: left.length,
    });
  return out;
}

/** Every phase its own station — the expanded row's track. */
export function fullTrack(
  phases: readonly { phase: number; status: string; stop?: { kind?: string } }[],
  observed: readonly number[] = [],
): TrackStation[] {
  return phases.map((p) => {
    const view = phaseView(p.status, p.stop);
    return {
      key: `p${p.phase}`,
      label: `P${p.phase} ${view.label.toLowerCase()}`,
      paint: view.paint,
      settled: view.tense === 'settled',
      live: observed.includes(p.phase),
      phase: p.phase,
    };
  });
}

/* ================================================================== *
 * 5 · The row, whole
 * ================================================================== */

/**
 * A lane a session is OBSERVED working in, now. `running` is a claim by the
 * record; the pulse is reserved for the fact: a process behind it, not frozen,
 * heard from, with no stall the runner recorded and no silence past the stall
 * floor by its own clock.
 */
export function observedLive(lane: NowLane, now: number): boolean {
  if (lane.frozen || lane.status !== 'running' || !lane.child) return false;
  const beat = Date.parse(lane.liveness?.lastOutputAt ?? '');
  if (!Number.isFinite(beat)) return false;
  return !lane.liveness?.stall && !laneSilent(lane, now);
}

export interface RunRowModel {
  key: string;
  slug: string;
  runId: string;
  /** What the run IS — `describeRun`'s answer, drawn by the typed family. */
  view: StatusView;
  bay: RunGroup;
  /** The glance's track, folded. */
  track: TrackStation[];
  done: number;
  total: number;
  clock: LabelledClock;
  cost: {
    /** Booked spend plus what the sessions in flight have cost so far. */
    spentUsd: number;
    liveUsd: number;
    budgetUsd: number | null;
    over: boolean;
  };
  action: RowAction;
  held: boolean;
  frozen: boolean;
  /** The lanes a session is observed working in right now — what may breathe. */
  observed: number[];
  pulse: boolean;
  /** The phases whose Now panel the expanded row carries — the live lanes'. */
  livePhases: number[];
  waits: WaitLine[];
  /** The run summons a person: its mark wears the summons whatever group it sits in. */
  summons: boolean;
}

export function rowModel(input: RowInput): RunRowModel {
  const { placed, now } = input;
  const { run, lanes, view, bay } = placed;
  const glance = glanceOf(run);
  const frozen =
    run.status === 'frozen' ||
    Boolean(run.freeze) ||
    (lanes.length > 0 && lanes.every((lane) => lane.frozen));
  const held = Boolean(run.hold);
  const observed = lanes.filter((lane) => observedLive(lane, now)).map((lane) => lane.phase);
  const spentUsd = glance.spentUsd + glance.liveUsd;
  const budgetUsd = glance.budgetUsd;
  return {
    key: run.id,
    slug: run.slug,
    runId: run.id,
    view,
    bay,
    track: compactTrack(glance.phases, observed),
    done: glance.done,
    total: glance.phases.length,
    clock: rowClock({
      run,
      bay,
      lanes,
      checks: placed.checks,
      ...(placed.entry ? { entry: placed.entry } : {}),
      frozen,
      workedMs: glance.workedMs,
      now,
    }),
    cost: { spentUsd, liveUsd: glance.liveUsd, budgetUsd, over: budgetUsd != null && spentUsd > budgetUsd },
    action: rowAction(input, { frozen, held }),
    held,
    frozen,
    observed,
    pulse: observed.length > 0,
    livePhases: lanes
      .filter((lane) => (lane.status === 'running' || lane.status === 'verifying') && !lane.frozen)
      .map((lane) => lane.phase),
    waits: waitLines(run, lanes, placed.entry, now),
    summons: bay === 'needs-you',
  };
}

/* ================================================================== *
 * 6 · Words the home says
 * ================================================================== */

/** The fold's clock period, in ms — the loop's own figure is printed through this, never a bare divisor. */
const MINUTE = 60_000;

/**
 * When the loop next looks at all this by itself — said under an empty Your
 * turn: "Nothing needs you" alone reads as "and nothing ever will", and an
 * operator who has watched the console park a run wants to know whether
 * anything is coming back round.
 */
export function nextSweepWords(converge: ConvergeStatusView | undefined): string {
  if (!converge) return 'The convergence loop re-reads the board whenever anything changes.';
  if (!converge.automatic) {
    return 'Convergence is manual on this console (runs are off, or --no-converge) — Recover & continue runs a pass.';
  }
  const every = converge.everyMs > 0 ? ` and every ${Math.round(converge.everyMs / MINUTE)} min` : '';
  const queued = converge.pending.length ? ` ${plural(converge.pending.length, 'pass')} queued.` : '';
  return `The loop sweeps at boot, on a docs change, a minute after a stop${every}.${queued}`;
}

/** A hold as the shared sentences read it. */
export type FleetHoldView = { at: string | null; by: string | null; scope?: 'machine' | 'restart' };

/**
 * The hold binding this console's runs now, in the shape `heldStopReason`
 * reads: its own freeze first, then the machine's. Null when neither stands —
 * the one reading under which a stopped run's "it continues by itself" is true
 * (control-tower phase 81, #93).
 */
export function bindingHoldOf(state: { fleet?: FleetState } | undefined): FleetHoldView | null {
  const fleet = state?.fleet;
  if (!fleet) return null;
  if (fleet.frozen) return { at: fleet.at, by: fleet.by };
  return fleet.hold ? { at: fleet.hold.at, by: fleet.hold.by, scope: fleet.hold.scope ?? 'machine' } : null;
}

/**
 * Why a run is where it is, in one sentence — the All runs grid's Why column.
 * The runner already writes it down: the halt card's sentence for a stop,
 * `finishedReason` in the operator's words; everything below those two is
 * derived from state the run is carrying anyway, because a row that says only
 * `interrupted` has told you the least useful true thing about itself.
 */
export function stopReason(run: RunLike, hold?: FleetHoldView | null): string {
  const sentence = haltSentence(run.halt);
  if (sentence) return run.halt?.phase != null ? `${sentence} (phase ${run.halt.phase})` : sentence;
  if (run.finishedReason) return heldStopReason(run.finishedReason, hold);
  if (run.freeze) {
    const where = run.freeze.phase != null ? `phase ${run.freeze.phase}` : 'mid-phase';
    return `frozen at ${where} by ${run.freeze.by}`;
  }
  if (run.pause) {
    const where = run.pause.afterPhase != null ? ` after phase ${run.pause.afterPhase}` : '';
    return run.status === 'paused'
      ? `paused${where} by ${run.pause.by}`
      : `pausing${where}, asked by ${run.pause.by}`;
  }
  if (run.waitUntil) {
    const reason = waitReasonOf(run as Parameters<typeof waitReasonOf>[0]);
    if (reason === 'external') return `waiting on external work until ${run.waitUntil}`;
    if (reason === 'person') return `waiting for a person to answer a card, until ${run.waitUntil}`;
    if (reason === 'connectivity') return `waiting for the network until ${run.waitUntil}`;
    if (reason === 'engine-busy')
      return `the machine is too busy to read the plan — reading it again at ${run.waitUntil}`;
    return `waiting for the usage window until ${run.waitUntil}`;
  }
  switch (run.status) {
    case 'running':
      return run.activePhase != null ? `phase ${run.activePhase} is running` : 'starting';
    case 'stopping':
      return 'winding the session down';
    case 'parked':
      return 'every remaining phase needs a person';
    case 'finished':
      return 'nothing left to do on this plan';
    case 'interrupted':
      return 'nothing is driving it, and nothing recorded why';
    default:
      return run.status;
  }
}

/** The word a row PRINTS for its run — `paused` asleep on a clock nobody paused reads `waiting` (#148). */
export const printedWord = (run: RunLike): string =>
  runStatusWord(run as Parameters<typeof runStatusWord>[0]);

/** The newest run of a plan, which a launch continues from — or none. */
export function latestRunOf<T extends RunLike>(runs: readonly T[], slug: string): T | null {
  let best: T | null = null;
  for (const run of runs) {
    if (run.slug !== slug) continue;
    if (!best || Date.parse(run.createdAt ?? '') > Date.parse(best.createdAt ?? '')) best = run;
  }
  return best;
}

/** The whole record, when the opened row holds it — the one of the run's id among the detail's run and its history. */
export function recordOfId(
  detail: { run: RunState | null; history: RunState[] } | undefined,
  id: string,
): RunState | undefined {
  if (!detail) return undefined;
  return [detail.run, ...detail.history].find((run): run is RunState => run != null && run.id === id);
}
