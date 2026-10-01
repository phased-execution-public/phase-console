/**
 * A phase's queue EPISODES — the record's half of the queue clock
 * (control-tower phase 60, #81, #82).
 *
 * The scheduler keeps no state of its own that survives anything: its pending
 * `admit()` promises ARE the queue. The phase record is therefore the only
 * place a wait can be remembered, and before this it remembered almost none of
 * one. `waitedMs` was reported only at admission, so a pause, a halt, a park, a
 * console restart or the lock-wait cap each threw away the clock AND the
 * entry's place in the queue — about half of all real queue time was never
 * recorded, and a sibling's halt sent every waiter to the back of the line.
 *
 * So a wait is a sequence of episodes. One OPENS when the phase is seen queued
 * (`openQueueEpisode`); it CLOSES exactly once (`closeQueueEpisode`) with its
 * length and one of `QUEUE_OUTCOMES`, and the length joins the record's
 * cumulative `queuedMs`. Inside an episode the head holder may change
 * (`noteQueueHead`), and each stretch is charged to that holder's CLASS
 * (`queuedByClass`).
 *
 * That is the PHASE's lane-time. "Blocked by others" is a question about the
 * RUN, and its answer is wall-clock: `foldRunBlocked` keeps one stretch open
 * while any phase of the run waits, charged to the most external class heading
 * one (`BLOCKED_BY_ORDER`), so three siblings behind one stranger for an hour
 * are one blocked hour — never three (#64). Every caller that opens, re-heads or
 * closes an episode folds the run after it.
 *
 * The entry's AGE (`queueSince`) spans episodes AND admissions (control-tower
 * phase 86, #128): a withdraw-then-resume — across a restart too — is born
 * where the last entry stood, and so is a re-board after the phase WORKED (a
 * wrap-up, a checkpoint, a console re-brief). Only the aging reservation
 * (`queueReserving`) and the wait's own length end at an admission. The age is
 * one of the three clocks `seniorityOf` reads.
 *
 * Pure functions over the record, no clock of their own: every caller passes
 * its instant, which is what lets a test replay an hour in a millisecond.
 */

import { BLOCKED_BY_ORDER } from '../../shared/run-lifecycle.js';
import type { HolderClass, QueueOutcome } from '../../shared/run-lifecycle.js';
import type { PhaseRecord, RunState } from './state.ts';

/** What `closeQueueEpisode` reports — the `phase.queue-closed` line's data. */
export type QueueEpisodeClose = {
  outcome: QueueOutcome;
  /** This episode's length. */
  ms: number;
  /** The phase's cumulative queued time, this episode included. */
  queuedMs: number;
  /** The CURRENT wait's queued time — every episode since its entry was first queued (`queueSince`). */
  waitedMs: number;
  /** When the episode opened. */
  since: string;
  /** Why a `withdrawn` episode was withdrawn: `pause`, `halt`, `park`, `stop`, `serial`. */
  why?: string;
};

/** The record fields an episode reads and writes. */
type EpisodeRecord = Pick<PhaseRecord,
  'queuedAt' | 'queuedMs' | 'queueSince' | 'queueReserving' | 'queueHead' | 'queuedByClass' | 'queueSeenAt' | 'queueWaitedMs'>;

const ms = (iso: string | undefined): number => (iso ? Date.parse(iso) : NaN);

/**
 * Open an episode at `at`, unless one is already open — an admission that
 * queues, backs off and queues again is still one wait. Stamps the entry's
 * age on the first episode of a wait. Returns whether it opened one.
 */
export function openQueueEpisode(record: EpisodeRecord, at: string, head?: HolderClass): boolean {
  if (record.queuedAt) return false;
  record.queuedAt = at;
  record.queueSince ??= at;
  record.queueSeenAt = at;
  if (head) record.queueHead = { class: head, since: at };
  return true;
}

/**
 * The head holder's class is now `head` (or nothing holds it): the stretch
 * since the last change is charged to the class that held it. A no-op outside
 * an episode and when the class did not change.
 */
export function noteQueueHead(record: EpisodeRecord, head: HolderClass | null, at: string): void {
  if (!record.queuedAt) return;
  if (record.queueHead?.class === head) return;
  chargeHead(record, at);
  if (head) record.queueHead = { class: head, since: at };
  else delete record.queueHead;
}

function chargeHead(record: EpisodeRecord, at: string): void {
  const head = record.queueHead;
  if (!head) return;
  const spent = Math.max(0, ms(at) - ms(head.since));
  if (Number.isFinite(spent) && spent > 0) {
    record.queuedByClass = { ...record.queuedByClass, [head.class]: (record.queuedByClass?.[head.class] ?? 0) + spent };
  }
}

/**
 * Close the open episode at `at` with `outcome`: its length joins `queuedMs`,
 * and — on an admission only — the wait and its reservation end with it. The
 * AGE does not (#128): a phase admitted, worked and re-boarded keeps the
 * seniority it queued with, which is what puts it ahead of phases that never
 * started. Returns what closed, or null when no episode was open (so a close
 * raced by another close is a no-op, never a second line).
 */
export function closeQueueEpisode(
  record: EpisodeRecord, outcome: QueueOutcome, at: string, why?: string,
): QueueEpisodeClose | null {
  const since = record.queuedAt;
  if (!since) return null;
  const spent = Math.max(0, ms(at) - ms(since));
  const length = Number.isFinite(spent) ? spent : 0;
  chargeHead(record, at);
  delete record.queueHead;
  record.queuedMs = (record.queuedMs ?? 0) + length;
  const waitedMs = (record.queueWaitedMs ?? 0) + length;
  delete record.queuedAt;
  delete record.queueSeenAt;
  if (outcome === 'admitted') {
    delete record.queueReserving;
    delete record.queueWaitedMs;
  } else {
    record.queueWaitedMs = waitedMs;
  }
  return { outcome, ms: length, queuedMs: record.queuedMs, waitedMs, since, ...(why ? { why } : {}) };
}

/** Which of the three clocks a phase's seniority was read from. */
export type SeniorityClock = 'queue' | 'hint' | 'park';

/**
 * How long this phase has had a claim on a lane — the OLDEST of its three
 * clocks (control-tower phase 86, #128 #132 #114):
 *
 *   - `queue` — when its current wait first joined a queue (`queueSince`),
 *     carried across withdrawals, restarts and admissions;
 *   - `hint`  — when a re-board asked for it (`boardingHint.at`): a wrap-up, a
 *     Retry, the ladder, an operator's resume;
 *   - `park`  — when a park it sat out EXPIRED (`parkedUntil`, a `waiting`
 *     record only): a usage wall's window, a declared wait's clock. A park
 *     still running is no claim.
 *
 * `null` for a phase with none — one that never waited, which is exactly the
 * phase every seniority-bearing one boards ahead of. The drive loop's boarding
 * order and the admission's `since` both read this and nothing else.
 */
export function seniorityOf(
  record: Pick<PhaseRecord, 'queueSince' | 'boardingHint' | 'status' | 'parkedUntil'>,
  now: string = new Date().toISOString(),
): { at: string; clock: SeniorityClock } | null {
  const clocks: { at: string; clock: SeniorityClock }[] = [];
  if (record.queueSince && Number.isFinite(ms(record.queueSince))) clocks.push({ at: record.queueSince, clock: 'queue' });
  const hinted = record.boardingHint?.at;
  if (hinted && Number.isFinite(ms(hinted))) clocks.push({ at: hinted, clock: 'hint' });
  const until = record.status === 'waiting' ? record.parkedUntil : undefined;
  if (until && Number.isFinite(ms(until)) && ms(until) <= ms(now)) clocks.push({ at: until, clock: 'park' });
  if (!clocks.length) return null;
  return clocks.reduce((oldest, next) => (ms(next.at) < ms(oldest.at) ? next : oldest));
}

/** The run fields `foldRunBlocked` reads and writes. */
type BlockedRun = Pick<RunState, 'blockedMs' | 'blockedOpen'> & {
  phases: Record<string, Pick<PhaseRecord, 'queuedAt' | 'queueHead'> | undefined>;
};

/**
 * The class a run is blocked by right now: the first in `BLOCKED_BY_ORDER`
 * heading any of its open episodes, or null when none of its phases waits.
 */
export function runBlockedClass(run: Pick<BlockedRun, 'phases'>): HolderClass | null {
  let best = BLOCKED_BY_ORDER.length;
  for (const record of Object.values(run.phases)) {
    if (!record?.queuedAt || !record.queueHead) continue;
    const rank = BLOCKED_BY_ORDER.indexOf(record.queueHead.class);
    if (rank >= 0 && rank < best) best = rank;
  }
  return BLOCKED_BY_ORDER[best] ?? null;
}

/**
 * Bring the run's blocked stretch up to date at `at`, after an episode of one
 * of its phases opened, changed head or closed (#64). A stretch whose class
 * changed or ended is charged to `blockedMs` — once, however many phases
 * waited through it — and a new one opens when something still waits.
 */
export function foldRunBlocked(run: BlockedRun, at: string): void {
  const now = runBlockedClass(run);
  const open = run.blockedOpen;
  if (open?.class === now) return;
  if (open) {
    const spent = Math.max(0, ms(at) - ms(open.since));
    if (Number.isFinite(spent) && spent > 0) {
      run.blockedMs = { ...run.blockedMs, [open.class]: (run.blockedMs?.[open.class] ?? 0) + spent };
    }
    delete run.blockedOpen;
  }
  if (now) run.blockedOpen = { class: now, since: at };
}

/**
 * Where an episode a dead console left open ENDED: the last moment anything
 * saw it waiting (`queueSeenAt`, refreshed while it waits), never before it
 * opened. The time the console was down is not queue time — nothing was queued.
 */
export function restartedAt(record: EpisodeRecord, fallback: string): string {
  const seen = ms(record.queueSeenAt);
  const opened = ms(record.queuedAt);
  if (Number.isFinite(seen) && (!Number.isFinite(opened) || seen >= opened)) return record.queueSeenAt!;
  return Number.isFinite(opened) ? record.queuedAt! : fallback;
}
