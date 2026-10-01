/**
 * An operator's word on one phase's place in the queue, applied to its RECORD
 * (control-tower phase 99, #135 B and E).
 *
 * One pure function for both doors — a live run's `Runner.queueControl` and a
 * stopped run's stored record (`ServiceRuns.queueControl`) — so the two can
 * never disagree about what a hold is. It decides the mark and the journal
 * line; the caller persists, journals and tells the scheduler. A word that
 * changes nothing (releasing what is not held) writes nothing: a second
 * identical press is not a second decision — except a bump, which is a new
 * instruction and orders in front of the one before it.
 */

import type { Actor, PhaseRecord, QueueControl, QueueMark, RunState } from './state.ts';
import type { LaneMarkVerb, QueueVerb } from '../../shared/orchestration-model.js';

/**
 * The verbs that act on ONE phase — `QUEUE_VERBS` less the run-level `reorder`,
 * and the lane marks (control-tower phase 100): a pin and a reservation.
 */
export type PhaseQueueVerb = Exclude<QueueVerb, 'reorder'> | LaneMarkVerb;

/**
 * The journal line each verb writes on the phase's run — literals, one per
 * verb, so `docs/journal-events.md` documents each (`docs-parity.test.ts`).
 */
export const QUEUE_CONTROL_EVENTS: Readonly<Record<PhaseQueueVerb, string>> = Object.freeze({
  bump: 'phase.queue-bumped',
  hold: 'phase.queue-held',
  release: 'phase.queue-released',
  defer: 'phase.queue-deferred',
  withdraw: 'phase.queue-withdrawn',
  requeue: 'phase.queue-requeued',
  pin: 'phase.lane-pinned',
  unpin: 'phase.lane-unpinned',
  reserve: 'phase.lane-reserved',
  unreserve: 'phase.lane-unreserved',
});

/** The line a yield writes on the YIELDING phase's run (control-tower phase 100, #135 D.15). */
export const LANE_YIELDED_EVENT = 'phase.lane-yielded';

/**
 * Why a lane mark may not go on this phase of this run, or null. A pin or a
 * reservation never WIDENS a scoped run (`onlyPhases`): the run finishes when
 * its scope settles (`honestScopedFinish`), so a mark on a phase outside it
 * would promise a lane the run will never board.
 */
export function laneMarkRefusal(state: Pick<RunState, 'onlyPhases'>, phase: number, verb: string): string | null {
  if (verb !== 'pin' && verb !== 'reserve') return null;
  const scope = state.onlyPhases;
  if (!scope?.length || scope.includes(phase)) return null;
  return `P${phase} is outside this run's scope (${scope.map((n) => `P${n}`).join(', ')}) — a ${verb} never widens a scoped run; start a run for it`;
}

/** The run-level line a reorder writes — one for the whole list. */
export const QUEUE_REORDERED_EVENT = 'run.queue-reordered';

/** Record statuses a queue word no longer means anything for. */
const FINISHED: readonly string[] = ['done', 'skipped'];

export type QueueControlOptions = {
  /** `defer`: the ISO moment the deferral ends. */
  until?: string;
  /** `reserve`: the live lane whose end the reservation waits for (a yield's). */
  lane?: { slug: string; phase: number };
  /** `reserve`: made by a yield. */
  via?: 'yield';
  /** `bump`: the stamp to order by (a reorder hands each phase its own). */
  stamp?: number;
  /** `requeue`: `front` also bumps it. */
  position?: 'front';
  /** The stamp source when none is given — the scheduler's `nextStamp`. */
  nextStamp?: () => number;
  now?: () => Date;
};

export type QueueControlChange = {
  verb: PhaseQueueVerb;
  event: string;
  /** The journal line's data: the actor (who, via, origin, why) and the verb's own facts. */
  data: Record<string, unknown>;
  control: QueueControl;
};

export type QueueControlResult =
  | { ok: true; changed: false }
  | { ok: true; changed: true; change: QueueControlChange }
  | { ok: false; status: number; error: string };

/** Who, when, why — the mark every verb leaves, from the actor that pressed it. */
export function queueMark(actor: Actor, at: Date): QueueMark {
  return { at: at.toISOString(), by: actor.by, ...(actor.reason ? { reason: actor.reason } : {}) };
}

/**
 * Apply one verb to one phase's record. Mutates `record.queueControl` on a
 * change and answers what to journal; refuses (with a status) a phase that is
 * finished or a deferral with no clock.
 */
export function applyQueueControl(
  record: PhaseRecord,
  verb: PhaseQueueVerb,
  actor: Actor,
  opts: QueueControlOptions = {},
): QueueControlResult {
  if (FINISHED.includes(record.status)) {
    return { ok: false, status: 409, error: `phase ${record.phase} is ${record.status} — there is no place in the queue to change` };
  }
  const at = opts.now?.() ?? new Date();
  const mark = queueMark(actor, at);
  const before: QueueControl = { ...record.queueControl };
  const next: QueueControl = { ...before };
  const facts: Record<string, unknown> = {};
  switch (verb) {
    case 'bump': {
      const stamp = opts.stamp ?? opts.nextStamp?.() ?? at.getTime();
      next.bump = { ...mark, stamp };
      break;
    }
    case 'hold':
      if (before.hold) return { ok: true, changed: false };
      next.hold = mark;
      break;
    case 'release':
      if (!before.hold && !before.defer) return { ok: true, changed: false };
      delete next.hold;
      delete next.defer;
      facts.lifted = [...(before.hold ? ['hold'] : []), ...(before.defer ? ['defer'] : [])];
      break;
    case 'defer': {
      const until = Date.parse(opts.until ?? '');
      if (!Number.isFinite(until)) return { ok: false, status: 400, error: 'a deferral needs its clock: pass {until: <ISO time>}' };
      if (until <= at.getTime()) return { ok: false, status: 400, error: `${opts.until} has already passed` };
      next.defer = { ...mark, until: new Date(until).toISOString() };
      facts.until = next.defer.until;
      break;
    }
    case 'withdraw':
      if (before.withdrawn) return { ok: true, changed: false };
      next.withdrawn = mark;
      break;
    case 'requeue':
      if (!before.withdrawn && opts.position !== 'front') return { ok: true, changed: false };
      delete next.withdrawn;
      if (opts.position === 'front') {
        next.bump = { ...mark, stamp: opts.stamp ?? opts.nextStamp?.() ?? at.getTime() };
        facts.position = 'front';
      }
      break;
    case 'pin':
      if (before.pin) return { ok: true, changed: false };
      next.pin = mark;
      break;
    case 'unpin':
      if (!before.pin) return { ok: true, changed: false };
      delete next.pin;
      break;
    case 'reserve':
      // A second reservation naming the same lane is the same decision; one
      // naming another lane (or none) replaces it — the latest word stands.
      if (before.reserve && before.reserve.lane?.slug === opts.lane?.slug && before.reserve.lane?.phase === opts.lane?.phase) {
        return { ok: true, changed: false };
      }
      next.reserve = { ...mark, ...(opts.lane ? { lane: { ...opts.lane } } : {}), ...(opts.via ? { via: opts.via } : {}) };
      if (opts.lane) facts.lane = { ...opts.lane };
      if (opts.via) facts.via = opts.via;
      break;
    case 'unreserve':
      if (!before.reserve) return { ok: true, changed: false };
      delete next.reserve;
      break;
  }
  if (Object.keys(next).length) record.queueControl = next; else delete record.queueControl;
  return {
    ok: true,
    changed: true,
    change: { verb, event: QUEUE_CONTROL_EVENTS[verb], data: { ...actor, ...facts }, control: next },
  };
}

/**
 * A phase's control as its scheduler entry carries it — the bump, hold,
 * deferral and pin; `withdrawn` never reaches an entry, and a reservation is
 * the scheduler's own registry (`Scheduler.reserveLane`), because it stands
 * while the phase has no entry at all. Undefined when nothing applies.
 */
export function entryControlOf(control: QueueControl | undefined): Omit<QueueControl, 'withdrawn' | 'reserve'> | undefined {
  if (!control) return undefined;
  const { withdrawn: _withdrawn, reserve: _reserve, ...rest } = control;
  return Object.keys(rest).length ? rest : undefined;
}

/** Is this phase deferred or held right now — boarded last by its own run, and only to wait in the queue? */
export function standsAside(control: QueueControl | undefined, nowMs: number): boolean {
  if (control?.hold) return true;
  const until = Date.parse(control?.defer?.until ?? '');
  return Number.isFinite(until) && until > nowMs;
}
