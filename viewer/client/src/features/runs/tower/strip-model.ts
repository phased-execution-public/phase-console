/**
 * The strip's model — a run drawn as a flight strip (control-tower phase 19).
 *
 * §Architecture 5's anatomy, as data: a state edge, the precise word with its
 * icon, the attention mark, the name, the phase track, ONE labelled clock, the
 * cost, and exactly ONE action — everything else one expansion away. Pure, so
 * the Tower (phase 20) can fold runs into bays without rendering one.
 *
 * ## The words are the status model's, never this file's
 *
 * `describeRun` says what the run IS (its word, icon, paint, tense and
 * attention) and `bayOf` which bay that puts it in (`shared/status-model.js`,
 * phase 16). The strip reads both and re-derives neither: the edge is the
 * view's paint, the mark its attention, and the bay picks the action.
 *
 * ## One action, chosen by bay
 *
 * First match — through the run lifecycle (`lib/run-lifecycle.ts`) or the
 * recovery model (`recoveryActionsFor`), never a third source:
 *
 *   1. a console without `--allow-run` — **Open run**: the one move no flag
 *      guards, rather than a button that answers 403;
 *   2. frozen — **Thaw**;
 *   3. pausing — **Cancel pause** (the lifecycle's resume);
 *   4. paused — **Resume**;
 *   5. stopped on a halt it is not recovering from (any bay but Live), or in
 *      Needs you — the halt card's recommended verb: `recoveryActionsFor`'s
 *      first that a strip can press (a run-route verb or a fresh agent — the
 *      same filter `RecoveryActions` draws its buttons through, so it is the
 *      button the card draws first); with none, **Open run**;
 *   6. Live — **Pause** at the next boundary;
 *   7. Queued — **Hold**, or **Release** when it is held;
 *   8. Waiting — the recovery model's first verb for the waiting phase, else
 *      **Pause**;
 *   9. Settled or Ready — **Open run**.
 */

import { bayOf, describeRun, type RunCtx, type StatusView } from '@shared/status-model.js';
import { haltCtx } from '@shared/halt-view.js';
import { planHref } from '@shared/routes.js';
import { recoveryActionsFor } from '@/lib/recovery';
import { isRunRecoverVerb } from '@/lib/run-recover-verbs';
import type { LabelledClock } from '@/lib/format';
import type { LifecycleVerb } from '@/lib/run-lifecycle';
import type { RecoveryCtx } from '@/components/recovery-actions';
import { laneSilent, type NowLane } from '@/features/runs/lanes-model';
import type { InboxItem, PhaseRecord, QueueEntry, RunState, VerifyingLane } from '@/lib/api';
import { runItems } from '@/features/turn/surfaces';
import { toRows, type RunRow } from '../model';
import { stripClock } from './clocks';
import { waitLines, type WaitLine } from './waits';

export type Bay = ReturnType<typeof bayOf>;

/** What the strip is handed — the run, and the facts the page already folded. */
export interface StripInput {
  run: RunState;
  /** This run's lanes, from the ONE `nowLanes` fold the page drew. */
  lanes: readonly NowLane[];
  /** The console's own checks on this run (`run.verifying`), phase 89. */
  checks?: readonly VerifyingLane[];
  /** The admission entry for a queued lane, when the queue snapshot has one. */
  entry?: QueueEntry;
  /** Epoch ms — the strip's clock. Passed in, so the model stays pure. */
  now: number;
  /** `--allow-run`: whether a lifecycle or recovery verb could be pressed at all. */
  allowRun: boolean;
  /** `describeRun`'s context — the inbox, a closed plan, a newer run — when the page holds it. */
  ctx?: RunCtx;
}

/** The one thing to press, and whose door it goes through. */
export type StripAction =
  | { kind: 'lifecycle'; verb: LifecycleVerb; label: string; title: string }
  | {
      kind: 'recovery';
      /** The recovery model's verb id (`ACTION_VOCAB`). */
      id: string;
      label: string;
      title: string;
      /** Whether pressing it needs more than a press — words, a dialog — so the strip opens instead. */
      needsMore: boolean;
      disabledReason?: string;
      target: { slug: string; phase?: number; runId?: string };
      ctx: RecoveryCtx;
    }
  | { kind: 'open'; label: string; title: string; href: string }
  /** A person's turn on this run (control-tower phase 42): the step's own primary act. */
  | { kind: 'step'; label: string; title: string; item: InboxItem };

export interface StripModel {
  key: string;
  slug: string;
  runId: string;
  /** What the run IS — `describeRun`'s answer, drawn by the typed badge. */
  view: StatusView;
  bay: Bay;
  /** The fleet table's own derivation of the run: phases, spend, the printed word. */
  row: RunRow;
  /** The phase track — every phase touched, in order. */
  track: { phase: number; status: string; stop?: { kind?: string } }[];
  done: number;
  total: number;
  clock: LabelledClock;
  cost: {
    /** Booked spend plus what the sessions in flight have cost so far. */
    spentUsd: number;
    /** The in-flight part of `spentUsd` — a session's dollars are booked when it ends. */
    liveUsd: number;
    budgetUsd: number | null;
    /** 0–1 for drawing; null without a budget to be a fraction of. */
    fraction: number | null;
    over: boolean;
  };
  action: StripAction;
  held: boolean;
  frozen: boolean;
  /** The lanes a session is observed working in right now — what may breathe. */
  observed: NowLane[];
  /** The badge pulses only on an observed live lane. */
  pulse: boolean;
  /** The phases whose Now panel the expanded strip carries — the live lanes'. */
  livePhases: number[];
  /**
   * What holds it up, in words — a hold, a scope fence, a folded errand, the
   * queue (`waits.ts`, control-tower phase 20). Empty when nothing does.
   */
  waits: WaitLine[];
}

/**
 * A lane a session is OBSERVED working in, now.
 *
 * `running` is a claim by the record; the pulse is reserved for the fact
 * (`docs/design.md` §5 — pulse means "alive right now"). So a lane breathes only
 * with a process behind it, not frozen, heard from (a `lastOutputAt` on its
 * liveness), with no stall the runner recorded and no silence past the stall
 * floor by its own clock (`laneSilent`, the constant the detector and the
 * heartbeat already share).
 */
export function observedLive(lane: NowLane, now: number): boolean {
  if (lane.frozen || lane.status !== 'running' || !lane.child) return false;
  const beat = Date.parse(lane.liveness?.lastOutputAt ?? '');
  if (!Number.isFinite(beat)) return false;
  return !lane.liveness?.stall && !laneSilent(lane, now);
}

const LIFECYCLE_WORDS: Record<LifecycleVerb, { label: string; title: string }> = {
  pause: { label: 'Pause', title: 'Stop at the next phase boundary' },
  resume: { label: 'Resume', title: 'Carry on from where it stopped' },
  hold: { label: 'Hold', title: 'The running phases finish; nothing new is admitted' },
  release: { label: 'Release', title: 'Let this run be admitted again' },
  freeze: { label: 'Freeze', title: 'Stop every session of this run where it stands' },
  thaw: { label: 'Thaw', title: 'Continue — the session picks up mid-token' },
  stop: { label: 'Stop', title: 'Its sessions get SIGTERM and the run winds down' },
};

export function lifecycleAction(verb: LifecycleVerb, label?: string, title?: string): StripAction {
  const words = LIFECYCLE_WORDS[verb];
  return { kind: 'lifecycle', verb, label: label ?? words.label, title: title ?? words.title };
}

/** The verbs that need more than a press — words, or a dialog — which the expanded card asks for. */
const NEEDS_MORE = new Set(['resume', 'delegate', 'errand-answered', 'retry-edits', 'fix-agent']);

/**
 * The recovery model's first verb a strip can press — the button the halt card
 * (and every `RecoveryActions`) draws first: not an overflow verb, and one the
 * run's own route performs or a fresh agent takes. A surface-owned verb (dismiss,
 * force-release) needs a surface that says how, and the strip is not one.
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

function openAction(run: RunState, title = 'Open the run page'): StripAction {
  return { kind: 'open', label: 'Open run', title, href: planHref(run.slug, 'run') };
}

function recoveryAction(
  run: RunState,
  ctx: RecoveryCtx,
  phase: number | undefined,
  allowRun: boolean,
): StripAction | null {
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

/** The phase a waiting run waits on — the first lane not running, with its record. */
function waitingPhase(
  run: RunState,
  lanes: readonly NowLane[],
): { phase: number; record: PhaseRecord } | null {
  for (const lane of lanes) {
    if (lane.status === 'running' || lane.status === 'verifying') continue;
    const record = run.phases?.[String(lane.phase)];
    if (record) return { phase: lane.phase, record };
  }
  return null;
}

export function stripAction(
  input: StripInput,
  bay: Bay,
  facts: { frozen: boolean; held: boolean },
): StripAction {
  const { run, lanes, allowRun } = input;
  // 0. A person's turn: the run's OLDEST item's primary IS the one thing to
  // press (control-tower phases 42, 139) — a step's act, a card's Allow, a
  // gate's Approve — and nothing else the run could be told moves it on.
  // Only for a run a person's turn summoned: a plan-wide row names no run, and
  // must not take a Live strip's Pause or a Settled one's Open run.
  const item =
    bay === 'needs-you' ? runItems(input.ctx?.inbox as readonly InboxItem[] | undefined, run)[0] : undefined;
  // Its label is the item row's own, drawn by the lazy button — kept off the
  // first paint, which reads only that it is a person's turn.
  if (item)
    return {
      kind: 'step',
      label: 'Your turn',
      title: `Your turn — ${item.humanStep?.title ?? item.title}`,
      item,
    };
  if (!allowRun) return openAction(run, 'This console cannot drive runs — open the run page to read it');
  if (facts.frozen) return lifecycleAction('thaw');
  if (run.status === 'pausing')
    return lifecycleAction('resume', 'Cancel pause', 'Carry on past the next phase boundary');
  if (run.status === 'paused') return lifecycleAction('resume');

  if ((run.halt && bay !== 'live') || bay === 'needs-you') {
    if (run.halt) {
      const ctx = { ...haltCtx(run), run } as RecoveryCtx;
      return recoveryAction(run, ctx, run.halt.phase ?? undefined, allowRun) ?? openAction(run);
    }
    const waiting = waitingPhase(run, lanes);
    const ctx = { run, ...(waiting ? { record: waiting.record } : {}) } as RecoveryCtx;
    return (
      recoveryAction(run, ctx, waiting?.phase, allowRun) ?? openAction(run, 'Open the run page to answer it')
    );
  }

  if (bay === 'live') return lifecycleAction('pause');
  if (bay === 'queued') return facts.held ? lifecycleAction('release') : lifecycleAction('hold');
  if (bay === 'waiting') {
    const waiting = waitingPhase(run, lanes);
    const ctx = { run, ...(waiting ? { record: waiting.record } : {}) } as RecoveryCtx;
    return recoveryAction(run, ctx, waiting?.phase, allowRun) ?? lifecycleAction('pause');
  }
  return openAction(run);
}

/** Everything a strip draws for one run. */
export function stripModel(input: StripInput): StripModel {
  const { run, lanes, now } = input;
  const view = describeRun(run as Parameters<typeof describeRun>[0], { now, ...input.ctx });
  const bay = bayOf(view);
  const row = toRows([run])[0]!;
  const frozen =
    run.status === 'frozen' ||
    Boolean(run.freeze) ||
    (lanes.length > 0 && lanes.every((lane) => lane.frozen));
  const held = Boolean(run.hold);

  const observed = lanes.filter((lane) => observedLive(lane, now));
  // What the sessions in flight have cost so far — not yet in `spentUsd`,
  // which books a session when it ends. `run:progress` moves it every frame.
  let liveUsd = 0;
  for (const record of Object.values(run.phases ?? {})) {
    if (record && (record.status === 'running' || record.status === 'verifying')) {
      liveUsd += record.live?.spentUsd ?? 0;
    }
  }
  const spentUsd = row.spentUsd + liveUsd;
  const budgetUsd = row.budgetUsd;

  return {
    key: run.id,
    slug: run.slug,
    runId: run.id,
    view,
    bay,
    row,
    track: row.phases.map((p) => ({
      phase: p.phase,
      status: p.status,
      ...(p.lifecycle?.stop ? { stop: p.lifecycle.stop } : {}),
    })),
    done: row.phasesDone,
    total: row.phases.length,
    clock: stripClock({
      run,
      bay,
      lanes,
      ...(input.checks ? { checks: input.checks } : {}),
      ...(input.entry ? { entry: input.entry } : {}),
      frozen,
      workedMs: row.workedMs,
      now,
    }),
    cost: {
      spentUsd,
      liveUsd,
      budgetUsd,
      fraction: budgetUsd ? Math.min(1, spentUsd / budgetUsd) : null,
      over: budgetUsd != null && spentUsd > budgetUsd,
    },
    action: stripAction(input, bay, { frozen, held }),
    held,
    frozen,
    observed,
    pulse: observed.length > 0,
    livePhases: lanes
      .filter((lane) => (lane.status === 'running' || lane.status === 'verifying') && !lane.frozen)
      .map((lane) => lane.phase),
    waits: waitLines(run, lanes, input.entry, now),
  };
}
