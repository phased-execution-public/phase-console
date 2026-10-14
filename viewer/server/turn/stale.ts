/**
 * The round's stale pass (turn-by-turn phase 7, §Architecture 5.2): an item
 * nobody needs any more leaves the person's list, with its reason — in both
 * editions, with no model.
 *
 * Each open item is read lane by lane (its own lane, then every waiter G7
 * added). A lane is STALE when:
 *   - its phase is done on the board — nobody waits on it, whatever its kind;
 *   - its run is superseded (`runner/supersede.ts`), resolved or finished;
 *   - or, for an item a console raised from a run's errand, that errand is
 *     gone from a run nothing drives, past the withdraw grace — its cause was
 *     answered or cleared another way.
 * What becomes of a stale lane follows the item: a WORLD act (`outlivesRun` in
 * `shared/turn-model.js` — a sign-in, a secret, a tunnel) on a superseded run
 * MOVES to the successor's lane and stays open, because the plan still owes
 * it; anything else CLOSES. An item closes only when every lane would close,
 * so one stale lane never takes the turn from a phase still parked on it. An
 * item being checked is never touched — its verdict is on its way.
 *
 * Pure: the service hands the facts in (`ServiceRecovery.turnStalePass`) and
 * does the moving, the handled rows and the log lines.
 */

import { outlivesRun } from '../../shared/turn-model.js';
import { runStillLive, supersededBy, supersededReason, type SupersedeFacts } from '../runner/supersede.ts';
import type { RunState } from '../runner/state.ts';

/** One lane of an item: the plan, phase and run it parks under. */
export type StaleLane = { slug: string; phase: number; runId?: string };

/** The item as the pass reads it — the ledger's fields, nothing else. */
export type StaleItem = {
  id: string; kind: string; title: string; state: string; birth: string;
  slug: string; phase: number; runId?: string; declaredAt: string;
  waiters?: readonly StaleLane[];
  source?: { kind: string; ref?: string } | null;
};

export type StaleFacts = {
  /** A run by id, or null when it cannot be read — an unread run is never stale. */
  run: (slug: string, runId: string) => RunState | null;
  /** Every run of a plan — the successors the predicate weighs. */
  runs: (slug: string) => readonly RunState[];
  /** The board's word per phase, or null when it could not be read. */
  board: (slug: string) => Readonly<Record<number, string>> | null;
  /** Liveness for the predicate. */
  live?: SupersedeFacts['live'];
  holdsWork?: SupersedeFacts['holdsWork'];
  /** Is a run's errand on this phase, of this situation, still standing? */
  errandStands: (run: RunState, phase: number, situation: string) => boolean;
  /** The pass's clock, and how old an item must be before its cause may read gone (a raise races its errand's write). */
  now: number;
  graceMs: number;
};

type LaneVerdict =
  | { keep: true }
  | { close: string }
  | { move: string; reason: string };

/** What the pass decided for one item. */
export type StaleAction =
  | { id: string; close: string }
  | { id: string; move: { from: string; to: string; phase: number }[]; reason: string };

const lanesOf = (item: StaleItem): StaleLane[] => {
  const own: StaleLane = { slug: item.slug, phase: item.phase, ...(item.runId ? { runId: item.runId } : {}) };
  const same = (a: StaleLane, b: StaleLane) => a.slug === b.slug && a.phase === b.phase && (a.runId ?? '') === (b.runId ?? '');
  return [own, ...(item.waiters ?? []).filter((lane) => !same(lane, own))];
};

/** One lane's verdict. */
export function staleLane(item: StaleItem, lane: StaleLane, facts: StaleFacts): LaneVerdict {
  const board = facts.board(lane.slug);
  if (board?.[lane.phase] === 'done') return { close: `phase ${lane.phase} is done on the board` };
  if (!lane.runId) return { keep: true };
  const run = facts.run(lane.slug, lane.runId);
  if (!run) return { keep: true };
  const named = run.resolved?.supersededBy;
  const successor = named
    ? (facts.run(lane.slug, named) ?? ({ id: named } as RunState))
    : supersededBy(run, facts.runs(lane.slug), {
      live: facts.live, ...(facts.holdsWork ? { holdsWork: facts.holdsWork } : {}),
      ...(board ? { board, planPhases: Object.keys(board).map(Number).filter(Number.isInteger) } : {}),
    });
  if (successor) {
    const reason = `run ${run.id} was ${supersededReason(successor)}`;
    if (outlivesRun(item)) return successor.id === lane.runId ? { keep: true } : { move: successor.id, reason };
    return { close: reason };
  }
  if (run.status === 'finished') return { close: `run ${run.id} finished` };
  if (run.resolved) return { close: `run ${run.id} is resolved — ${run.resolved.reason}` };
  if (item.birth === 'console' && item.source?.kind === 'errand' && item.source.ref
    && facts.now - Date.parse(item.declaredAt) > facts.graceMs
    && !runStillLive(run, { live: facts.live, ...(facts.holdsWork ? { holdsWork: facts.holdsWork } : {}) })
    && !facts.errandStands(run, lane.phase, item.source.ref)) {
    return { close: `the errand it was raised for on phase ${lane.phase} is gone — answered or cleared` };
  }
  return { keep: true };
}

/** The pass over every open item: what to close, what to move. Items being checked are left alone. */
export function stalePass(items: readonly StaleItem[], facts: StaleFacts): StaleAction[] {
  const out: StaleAction[] = [];
  for (const item of items) {
    if (item.state === 'checking') continue;
    const lanes = lanesOf(item);
    const verdicts = lanes.map((lane) => staleLane(item, lane, facts));
    if (verdicts.every((v) => 'close' in v)) {
      out.push({ id: item.id, close: (verdicts[0] as { close: string }).close });
      continue;
    }
    const move = lanes.flatMap((lane, i) => {
      const v = verdicts[i]!;
      return 'move' in v && lane.runId ? [{ from: lane.runId, to: v.move, phase: lane.phase }] : [];
    });
    if (move.length) out.push({ id: item.id, move, reason: (verdicts.find((v) => 'move' in v) as { reason: string }).reason });
  }
  return out;
}
