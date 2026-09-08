/**
 * A lane's facts — one vocabulary, one order, one set of hedges.
 *
 * ## What was wrong
 *
 * Four surfaces drew "a lane" and each re-picked its facts and its order from
 * scratch: `now/lane-row.tsx` (state · beat · liveness · elapsed · cost · ETA ·
 * model), `runs/live-strip.tsx` (beat · elapsed · cost · model · frozen),
 * `sessions/list.tsx` (a note and a start time) and `components/pulse.tsx`
 * (elapsed and cost in a right-hand column, model as a chip). Same run record,
 * four readings — so "what has this lane spent" was a `Badge` on one page, a
 * bare `<span>` on another, and absent on a third, and each of them formatted
 * a missing value its own way. `LaneRow` printed `~~45 min` for a while
 * because it prefixed a hedge onto a label that already carried one.
 *
 * None of that is a bug you can see from inside one file, which is why it
 * survived four rewrites of the pages themselves.
 *
 * ## What this is
 *
 * A **fact bag** and the atoms that draw it. Deliberately NOT `NowLane`: the
 * pulse's lane shape (`PulseLane`) is its own, built from `RunState.children`
 * rather than from `nowLanes()`, and a primitive that demanded one model would
 * simply not be reachable from half the surfaces that need it. `laneFacts()`
 * adapts a `NowLane`; anything else builds the bag by hand, which is four
 * fields.
 *
 * The ORDER is the vocabulary: **beat · elapsed · cost · ETA · model ·
 * frozen** — cheapest-to-read first, and the two that answer "is this alive"
 * ahead of the two that answer "what is it costing". `LaneFactRow` is that
 * order; a surface with its own layout (the pulse's two-line column) composes
 * the atoms instead and still gets the formatting and the hedges.
 *
 * Phase 18 extracts it and converts `LiveStrip` and `PlanPulse`. `LaneRow` and
 * the Sessions list have layouts of their own and ride phase 19, where the
 * board needs the same row a third time.
 */

import { Snowflake } from 'lucide-react';
import { Badge, Duration, Heartbeat } from '@/components/ui';
import { money } from '@/lib/format';
import { cn } from '@/lib/cn';
import { STALL_DEFAULTS } from '@shared/attention-model.js';
import type { NowLane } from '@/features/now/model';

/** The stall detector's own floor, so a dot and the runner agree on "silent". */
const SILENT_AFTER_MS: number = STALL_DEFAULTS.stallSilentMs;

/** What every surface knows about a lane, in the one shape they all have. */
export interface LaneFacts {
  /** Epoch ms, or `null` when the lane has not started. */
  startedAt: number | null;
  /** Epoch ms of the last thing this session said, for the heartbeat. */
  lastOutputAt: number | null;
  costUsd: number | null;
  model: string | null;
  effort: string | null;
  /** Already hedged by the server (`~45 min`) — never prefix a second `~`. */
  etaLabel: string | null;
  frozen: boolean;
}

/** The `NowLane` adapter — the one model most surfaces already hold. */
export function laneFacts(lane: NowLane): LaneFacts {
  const started = lane.startedAt ? Date.parse(lane.startedAt) : NaN;
  const beat = lane.liveness?.lastOutputAt ? Date.parse(lane.liveness.lastOutputAt) : NaN;
  return {
    startedAt: Number.isFinite(started) ? started : null,
    lastOutputAt: Number.isFinite(beat) ? beat : null,
    costUsd: lane.costUsd ?? null,
    model: lane.model ?? null,
    effort: lane.effort ?? null,
    etaLabel: lane.eta?.label ?? null,
    frozen: Boolean(lane.frozen),
  };
}

/**
 * Silence, drawn as silence.
 *
 * It stops pulsing once the gap passes the stall floor and writes the gap out
 * instead. A dot that keeps beating over a wedged session is the lie this
 * console exists not to tell.
 */
export function LaneBeat({ facts, live }: { facts: LaneFacts; live: boolean }) {
  return (
    <Heartbeat lastBeatAt={facts.lastOutputAt} staleAfterMs={SILENT_AFTER_MS} live={live} label="lane" />
  );
}

/** How long it has been going. Renders `—` rather than nothing when unknown. */
export function LaneElapsed({
  facts,
  live,
  className,
}: {
  facts: LaneFacts;
  live: boolean;
  className?: string;
}) {
  return (
    <Duration since={facts.startedAt} live={live} className={cn('text-2xs text-ink-muted', className)} />
  );
}

/** What this lane has spent so far. Absent, not zero, when nothing is known. */
export function LaneCost({ facts, className }: { facts: LaneFacts; className?: string }) {
  if (facts.costUsd == null) return null;
  return (
    <Badge tone="neutral" mono title="what this lane has spent so far" className={className}>
      {money(facts.costUsd)}
    </Badge>
  );
}

/**
 * The server's estimate, never arithmetic done here.
 *
 * `PhaseEta.label` arrives already hedged (`~45 min`); prefixing a second `~`
 * printed `~~45 min` on the live page, which reads as a typo rather than as an
 * estimate.
 */
export function LaneEta({ facts }: { facts: LaneFacts }) {
  if (!facts.etaLabel) return null;
  return (
    <Badge
      tone="neutral"
      mono
      title="The server's estimate for a phase this size, from its own rate reading. A range, never a promise."
    >
      {facts.etaLabel}
    </Badge>
  );
}

/** Model, with effort when there is one — one string, never two badges. */
export function LaneModel({ facts }: { facts: LaneFacts }) {
  if (!facts.model) return null;
  return (
    <Badge tone="neutral" mono>
      {facts.model}
      {facts.effort ? ` · ${facts.effort}` : ''}
    </Badge>
  );
}

/** Stopped where it stood. A frozen lane is alive, which is the whole point. */
export function LaneFrozen({ facts }: { facts: LaneFacts }) {
  if (!facts.frozen) return null;
  return (
    <Badge tone="wait">
      <Snowflake size={11} aria-hidden />
      frozen
    </Badge>
  );
}

/**
 * The whole vocabulary, in its order.
 *
 * `live` is the caller's word for "is this lane actually moving" — it must be
 * false for a frozen lane, whose status is still `running` because a freeze is
 * a SIGSTOP and not a status change. Passing `lane.status === 'running'`
 * unqualified is how a badge came to breathe while the kernel was not
 * scheduling the process.
 */
export function LaneFactRow({
  facts,
  live,
  className,
}: {
  facts: LaneFacts;
  live: boolean;
  className?: string;
}) {
  return (
    <span className={cn('flex shrink-0 items-center gap-2', className)}>
      <LaneBeat facts={facts} live={live} />
      <LaneElapsed facts={facts} live={live} />
      <LaneCost facts={facts} />
      <LaneEta facts={facts} />
      <LaneModel facts={facts} />
      <LaneFrozen facts={facts} />
    </span>
  );
}
