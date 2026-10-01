/**
 * Which clock a strip reads, and its verb (control-tower phase 19, #28).
 *
 * A phase has five clocks that answer five questions (`shared/phase-clocks.js`)
 * and a run adds its own moments — when it halted, when it was frozen, how
 * long it has queued. A strip has room for ONE figure, so the choice is the
 * point: the figure that answers "is this one moving, and since when" for the
 * state the run is in, with the verb that says which question it answers.
 *
 * Pure. The strip ticks by calling these again with a later `now` — a frame
 * is not re-sent when only time passed (phase 10), so the anchors are the
 * record's and the clock is the reader's.
 */

import { PHASE_CLOCK_LABELS, PHASE_ROW_CLOCK, phaseClocks } from '@shared/phase-clocks.js';
import type { LabelledClock } from '@/lib/format';
import type { NowLane } from '@/features/runs/lanes-model';
import type { PhaseRecord, QueueEntry, RunState, VerifyingLane } from '@/lib/api';

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
 * One phase's clocks, as of `now`, with the newest frame folded in.
 *
 * `run:progress` writes the server's clocks to `record.live.phaseClocks`
 * rather than onto the record, so a clock computed from the record alone
 * would miss the window a frame just opened. The frame's windows and queue
 * total stand in for the record's; the tick stays this reader's.
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

/**
 * The verb and field of each named clock, for the expanded strip's list —
 * every clock a phase has, each saying what it measured.
 */
export const CLOCK_VERBS = {
  // The attempt's verb is the lane's — `running` while it runs, `ran` after.
  sinceThisAttemptMs: { verb: 'ran', tense: 'for' },
  sinceFirstBoardedMs: { verb: 'boarded', tense: 'ago' },
  workedMs: { verb: 'worked', tense: 'for' },
  queuedMs: { verb: 'queued', tense: 'for' },
  timeToFirstToolMs: { verb: 'first tool after', tense: 'for' },
} as const satisfies Record<string, { verb: string; tense: LabelledClock['tense'] }>;

export type NamedClock = keyof typeof CLOCK_VERBS;

/**
 * Every named clock of one phase, labelled — what the strip's detail lists.
 * `live` says the attempt is still going, so its verb is `running`, not `ran`.
 */
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

/** A lane's own clock, for its row in the expanded strip: this attempt, with the lane's verb. */
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

export interface ClockInput {
  run: RunState;
  bay: string;
  lanes: readonly NowLane[];
  checks?: readonly VerifyingLane[];
  entry?: QueueEntry;
  frozen: boolean;
  /** The run's worked total, freezes subtracted — `RunRow.workedMs`. */
  workedMs: number | null;
  now: number;
}

/**
 * The ONE clock a strip's glance reads, first match:
 *
 *  1. frozen — how long ago somebody froze it;
 *  2. stopped on a halt it is not recovering from — how long ago it halted;
 *  3. live — the moving lane's attempt clock (`PHASE_ROW_CLOCK`), verb
 *     `running` or `verifying`; a run whose only work is the console's own
 *     check reads that check's clock;
 *  4. queued — how long it has queued, from the admission entry, else the
 *     lane's lock wait, else the record's own queue stamp;
 *  5. waiting — how long until it wakes when a clock is known, else how long
 *     it has waited since its attempt ended;
 *  6. settled — what it worked for: `ran`.
 *
 * Nothing measured is still a verb and `—`, never a bare zero.
 */
export function stripClock(input: ClockInput): LabelledClock {
  const { run, bay, lanes, entry, now } = input;
  const records = run.phases ?? {};
  const recordOf = (phase: number | null | undefined) => (phase == null ? undefined : records[String(phase)]);

  if (input.frozen) {
    const frozenAt = run.freeze?.at ?? lanes.find((lane) => lane.frozen)?.child?.frozen?.at;
    return { verb: 'frozen', ms: since(frozenAt, now), tense: 'ago' };
  }
  if (run.halt && bay !== 'live') {
    return { verb: 'halted', ms: since(run.halt.at, now), tense: 'ago' };
  }
  if (bay === 'live') {
    const moving =
      lanes.find((lane) => lane.status === 'running' && !lane.frozen) ??
      lanes.find((lane) => lane.status === 'verifying');
    if (moving) return laneClock(moving, recordOf(moving.phase), now);
    const check = input.checks?.[0];
    if (check) return { verb: 'verifying', ms: since(check.startedAt, now), tense: 'for' };
    return { verb: 'running', ms: since(run.updatedAt, now), tense: 'for' };
  }
  if (bay === 'queued') {
    const lane = lanes.find((l) => l.status === 'queued');
    const stamp = entry?.since ?? lane?.lockWaitSince ?? recordOf(lane?.phase)?.queuedAt;
    return { verb: 'queued', ms: since(stamp, now), tense: 'for' };
  }
  if (bay === 'settled') {
    return { verb: 'ran', ms: input.workedMs, tense: 'for', label: PHASE_CLOCK_LABELS.workedMs };
  }
  // Waiting (and anything the fold has not named): the wake if one is set…
  const parked = lanes.find((lane) => lane.parkedUntil);
  const wake = at(parked?.parkedUntil);
  if (Number.isFinite(wake) && wake > now) return { verb: 'wakes in', ms: wake - now, tense: 'for' };
  // …else how long it has waited since its last attempt ended.
  const last = lanes.map((lane) => recordOf(lane.phase)?.endedAt).find(Boolean);
  if (last) return { verb: 'waiting', ms: since(last, now), tense: 'for' };
  return { verb: 'updated', ms: since(run.updatedAt, now), tense: 'ago' };
}
