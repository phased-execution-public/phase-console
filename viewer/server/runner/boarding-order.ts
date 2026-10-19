/**
 * The order ONE run boards its candidates in — extracted pure from the runner's
 * fill pass (one-pool phase 39, #380), so the queue forecast replays the very
 * ranker the runner boards by and never a re-typed copy
 * (`forecast-parity.test.ts`). The runner calls it, then journals who moved
 * past whom (`phase.seniority`); the forecast calls it on a simulated world.
 *
 * SENIORITY (control-tower phase 86, #128 #132 #114), never "the board's ready
 * phases first":
 *
 *   0. a PERSON's re-board (`boardingHint.by` is the person slot): an
 *      operator's resume-phase or Retry outranks every console candidate;
 *   ⅒. a wrap-up that KEEPS its lane (`keepsLane`, control-tower phase 109,
 *      #192) — it handed off `partial` with its own WIP uncommitted in a
 *      shared tree, so no sibling boards into that tree before it;
 *   ¼. an operator's PIN, then a lane KEPT for it (control-tower phase 100,
 *      #135 B.8, D.16) — the plan's next lane, by a person's word;
 *   ½. an operator's BUMP (control-tower phase 99) or ORDER (one-pool phase
 *      39): `first` beyond every bump, `last` behind every rank but a phase
 *      standing aside, and before/after a sibling half a step either side of
 *      it — an order anchored on another plan boards like a bump, so its run
 *      hands it to the scheduler early and the scheduler places it;
 *   1. a phase whose committed WIP is RED (`wipRed`, control-tower phase 89,
 *      #127) — a rank, not a seniority clock: its red is every sibling's base;
 *   1¾. a phase the scheduling POLICY promotes (control-tower phase 100);
 *   2. a landing's reservation (`landWatch`);
 *   3. an owed re-verification (`record.reverify`);
 *   4. every phase with a seniority clock (`seniorityOf`), OLDEST first;
 *   5. the rest — phases that never waited — in the board's own order;
 *   6. a held or deferred phase, last — only to wait in the queue.
 *
 * Stable: a tie keeps the candidate order, which is the board's.
 */

import type { PhaseRecord } from './state.ts';
import type { Promotion } from './scheduler.ts';
import { owesVerification } from './state.ts';
import { PERSON_SLOT_BY } from '../../shared/ladder-model.js';
import { seniorityOf } from './queue-episodes.ts';
import { standsAside } from './queue-control.ts';

/** How far an order's `first` sits beyond every bump stamp (stamps are clock milliseconds). */
const ORDER_EDGE = 1e15;

export type BoardingInput = {
  /** This run's plan — what tells a sibling anchor from another plan's. */
  slug: string;
  /** The phase's record (created on read, as `phaseRecord` does). */
  recordOf: (phase: number) => PhaseRecord;
  /** Now, as an ISO string. */
  now: string;
  /** The scheduling policy's word on a phase. */
  promotionOf: (phase: number) => Promotion | null;
  /** Phases a landing watch reserved a lane for. */
  landingReserve?: ReadonlySet<number>;
};

/** One candidate's place: its rank, its clock within the rank, and the WHY a journal line names. */
export type BoardingRow = {
  phase: number;
  /** Its place among the candidates as given (the board's order). */
  index: number;
  rank: number;
  clock: number;
  why: { clock: string; since: string } | null;
};

/** The candidates, ranked. See the file header for the ranks. */
export function boardingOrderOf(phases: readonly number[], input: BoardingInput): BoardingRow[] {
  const nowMs = Date.parse(input.now);
  const keyed = phases.map((phase, index): BoardingRow & { anchor?: { phase: number; side: 'before' | 'after' } } => {
    const record = input.recordOf(phase);
    const senior = seniorityOf(record, input.now);
    const person = record.boardingHint?.by === PERSON_SLOT_BY;
    // A phase whose committed WIP is red boards next after a person's press
    // (control-tower phase 89, #127): every sibling on the branch builds on
    // that red, and only its owner can take it away.
    const wipRed = !person && Boolean(record.wipRed);
    // An operator's word on the queue (control-tower phase 99, #135): a bump
    // is a person's order, so it boards right after a person's re-board — the
    // most recent bump first — and a held or deferred phase boards LAST, only
    // to wait in the queue, so its run's lanes go to its siblings first.
    const aside = standsAside(record.queueControl, nowMs);
    const order = !person && !aside ? record.queueControl?.order : undefined;
    const bump = !person && !order ? record.queueControl?.bump : undefined;
    // A wrap-up that keeps its lane (control-tower phase 109, #192).
    const keeps = !person && !aside ? record.keepsLane : undefined;
    // A pin and a kept lane (control-tower phase 100).
    const pin = !person && !aside && !keeps ? record.queueControl?.pin : undefined;
    const kept = !person && !aside && !keeps && !pin ? record.queueControl?.reserve : undefined;
    const promoted = !person && !aside && !keeps && !pin && !kept && !bump && !order && !wipRed ? input.promotionOf(phase) : null;
    const sibling = order && typeof order.anchor === 'object' && order.anchor.slug === input.slug ? order.anchor.phase : null;
    const rank = aside ? 6 : person ? 0 : keeps ? 0.1 : pin ? 0.25 : kept ? 0.3
      : order ? (order.anchor === 'last' ? 5.5 : 0.5)
        : bump ? 0.5 : wipRed ? 1 : promoted ? 1.75 : input.landingReserve?.has(phase) ? 2 : owesVerification(record) ? 3 : senior ? 4 : 5;
    const at = keeps ? Date.parse(keeps.at)
      : pin ? Date.parse(pin.at)
        : kept ? Date.parse(kept.at)
          : order ? (order.anchor === 'first' ? -(ORDER_EDGE + order.stamp) : -order.stamp)
            : bump && !aside ? -bump.stamp
              : promoted ? -promoted.rank
                : Date.parse((person ? record.boardingHint!.at : wipRed ? record.wipRed!.at : senior?.at) ?? '');
    return {
      phase, index, rank, clock: Number.isFinite(at) ? at : Number.POSITIVE_INFINITY,
      ...(sibling != null && sibling !== phase ? { anchor: { phase: sibling, side: order!.side } } : {}),
      why: person
        ? { clock: 'operator', since: record.boardingHint!.at }
        : keeps
          ? { clock: 'lane-kept', since: keeps.at }
          : pin
            ? { clock: 'pin', since: pin.at }
            : kept
              ? { clock: 'reserved', since: kept.at }
              : order
                ? { clock: 'order', since: order.at }
                : bump && !aside
                  ? { clock: 'bump', since: bump.at }
                  : wipRed
                    ? { clock: 'wip-red', since: record.wipRed!.at ?? record.wipRed!.sha }
                    : promoted
                      ? { clock: promoted.policy, since: promoted.text }
                      : senior ? { clock: senior.clock, since: senior.at } : null,
    };
  });
  // An order anchored on a sibling candidate sits half a step either side of
  // it, in its rank; one whose sibling is not a candidate now keeps the bump's.
  // Half a step on the anchor's clock when it has one, else on its place among
  // the candidates (`slot`): an anchor with no clock (+∞) is placed by its
  // index, and a finite stand-in clock would sort an `after` move AHEAD of it
  // (one-pool phase 41, found by the tower rehearsal's `queue` group).
  const slots = new Map<BoardingRow, number>(keyed.map((row) => [row, row.index]));
  const byPhase = new Map(keyed.map((row) => [row.phase, row] as const));
  for (const row of keyed) {
    const anchor = row.anchor ? byPhase.get(row.anchor.phase) : undefined;
    if (!anchor || anchor.anchor) continue;
    const step = row.anchor!.side === 'before' ? -0.5 : 0.5;
    row.rank = anchor.rank;
    row.clock = anchor.clock + step;
    slots.set(row, anchor.index + step);
  }
  // Two clocks of +∞ subtract to NaN, which is no answer, so the slot decides.
  return [...keyed]
    .sort((a, b) => a.rank - b.rank || a.clock - b.clock || slots.get(a)! - slots.get(b)!)
    .map(({ anchor: _anchor, ...row }) => row);
}
