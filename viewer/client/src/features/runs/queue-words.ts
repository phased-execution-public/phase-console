/**
 * The queue, in words — who holds a phase's scope, and the one line a table
 * cell prints for it.
 *
 * ⚠️ A LEAF: types only, no components, nothing that renders. These four
 * lived in `session-panes.tsx`, beside the live console, the activity panels
 * and the ask box, and the phase table imported them from there — so the plan
 * page, which mounts the table since control-tower phase 23, would have pulled
 * the whole session pane into its chunk for four string functions.
 * `session-panes.tsx` re-exports them, so every older import keeps working.
 */

import type { QueueControl, QueueEntry, QueueHolder } from '@/lib/api';
import { bumpReason, deferReason, entryHoldReason, withdrawnReason } from '@shared/orchestration-model.js';

/**
 * Who is holding it, in the three ways something can be held.
 *
 * `reserved` is not a plan at all — it is the scheduler reporting one of the two
 * non-scope blocks (the session cap, or an account usage window) through the same
 * shape, so that a queue card never has to say "queued" with nothing after it.
 */
export function holderLabel(kind: string, slug: string, phase: number | null): string {
  if (kind === 'reserved') return slug;
  // Its own plan's dependency, taken back from done while it queued
  // (control-tower phase 86, #136) — named by number, never as another run.
  if (kind === 'after')
    return phase != null ? `its dependency P${phase} (not done)` : 'a dependency that is not done';
  const where = phase != null ? `${slug} P${phase}` : slug;
  if (kind === 'session')
    return phase != null
      ? `${where} (a live session, no lock)`
      : 'a terminal session in this repository (no lock)';
  return kind === 'lock' ? `${where} (lock)` : where;
}

/**
 * A terminal session holding the queue, named the way the person in it would
 * recognise it (control-tower phase 82, #119): its id and pid, the scope it
 * holds, and how that scope was read. "Queued" with nothing after it is what
 * an operator saw while their own chat about another repository froze a run.
 */
export function sessionHolderText(holder: QueueHolder): string {
  const id = holder.session ? holder.session.slice(0, 8) : 'unknown';
  const pid = holder.pid ? `, pid ${holder.pid}` : '';
  const how =
    holder.scopeBasis === 'touched'
      ? 'from what it edited'
      : holder.scopeBasis === 'declared'
        ? 'as it declared'
        : holder.scopeBasis === 'unknown'
          ? 'nothing touched yet, so treated as that until its lease ends'
          : '';
  return `your terminal session ${id}${pid} — scope ${holder.scope.join(', ') || 'all'}${how ? ` (${how})` : ''}`;
}

/**
 * A sibling run's BRANCH on a shared checkout (control-tower phase 40, #41) —
 * the run, the branch and the repository. "Waiting on beta" alone reads as a
 * lock beta could release; this wait lifts when beta's tree leaves the branch
 * or beta settles, and the words say which thing to watch.
 */
export function branchHolderText(holder: QueueHolder): string {
  const repo = holder.overlaps[0] ?? holder.scope[0];
  return `${holder.slug}'s branch${holder.branch ? ` ${holder.branch}` : ''}${repo ? ` on ${repo}` : ''}`;
}

/**
 * The one-line version, for a table cell: what this phase is waiting on.
 *
 * Same reading as the card, and deliberately the same function feeding both — a
 * chip that disagreed with the pane beside it would be worse than no chip.
 */
export function waitingLabel(entry: QueueEntry | undefined): string {
  const first = entry?.waitingOn?.[0];
  if (!first) return 'queued';
  const rest = (entry?.waitingOn.length ?? 0) - 1;
  const who =
    first.kind === 'session' && first.session
      ? sessionHolderText(first)
      : first.kind === 'branch'
        ? branchHolderText(first)
        : holderLabel(first.kind, first.slug, first.phase);
  return `queued — waiting on ${who}` + (rest > 0 ? ` +${rest}` : '');
}

/** This plan's entry in the admission queue for one phase, if it has one. */
export function queueEntryFor(
  entries: readonly QueueEntry[] | undefined,
  slug: string,
  phase: number,
): QueueEntry | undefined {
  return (entries ?? []).find((entry) => entry.slug === slug && entry.phase === phase);
}

/** One operator mark on a phase's place in the queue, as the board and the queue page show it. */
export interface QueueMarkWord {
  key: 'withdrawn' | 'hold' | 'defer' | 'bump';
  /** The chip's word. */
  label: string;
  /** The whole sentence — who, and why when they said. */
  text: string;
}

/**
 * The marks an operator left on a phase's place (control-tower phase 99,
 * #135) — read off the phase's RECORD, so the board and the run card show a
 * bump, a hold, a deferral or a withdrawal whether or not the phase is queued
 * right now. The sentences are the server's own (`orchestration-model.js`),
 * never re-spelled here. A deferral whose clock has passed is no longer a mark.
 */
export function queueMarks(control: QueueControl | undefined, nowMs: number = Date.now()): QueueMarkWord[] {
  if (!control) return [];
  const out: QueueMarkWord[] = [];
  if (control.withdrawn)
    out.push({ key: 'withdrawn', label: 'withdrawn', text: withdrawnReason(control.withdrawn) });
  if (control.hold) out.push({ key: 'hold', label: 'held', text: entryHoldReason(control.hold) });
  if (control.defer && Date.parse(control.defer.until) > nowMs) {
    out.push({
      key: 'defer',
      label: `deferred to ${control.defer.until.slice(11, 16)}Z`,
      text: deferReason(control.defer),
    });
  }
  if (control.bump) out.push({ key: 'bump', label: 'moved ahead', text: bumpReason(control.bump) });
  return out;
}
