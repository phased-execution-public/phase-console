/**
 * The queue page's pure half (control-tower phase 99, #135): which verbs a row
 * offers, the body each press sends, and the one-line sentence each lane says.
 * The words themselves are the server's (`GET /api/queue` writes them through
 * `shared/queue-model.js`); nothing here re-derives why an entry sits where it
 * does — it only decides what a person may press about it.
 */

import type { QueueLane, QueuePress, QueueView, QueueViewEntry } from '@/lib/api';
import { SCHEDULING_POLICY_LABELS } from '@shared/orchestration-model.js';

/** A press a row offers: the verb, the button's words, and what it sends. */
export interface QueueRowVerb {
  verb: string;
  label: string;
  /** What the button's title says will happen. */
  says: string;
  body: Record<string, unknown>;
}

const HOUR = 60 * 60_000;

/** The body that names this entry: by id while it waits, which is the one thing a stale page cannot mistake. */
const target = (entry: QueueViewEntry): Record<string, unknown> => ({ entryId: entry.id });

/**
 * The verbs one waiting entry offers. A held or deferred entry offers the
 * release; a bumped one does not offer the bump again at the top of its class.
 */
export function entryVerbs(entry: QueueViewEntry, nowMs: number = Date.now()): QueueRowVerb[] {
  const control = entry.control ?? {};
  const deferred = control.defer && Date.parse(control.defer.until) > nowMs;
  const verbs: QueueRowVerb[] = [];
  if (!(entry.bumped && entry.position === 1)) {
    verbs.push({
      verb: 'bump',
      label: 'Move ahead',
      body: target(entry),
      says: 'To the front of its class. It stays there when its entry is re-created, until it boards.',
    });
  }
  if (control.hold || deferred) {
    verbs.push({
      verb: 'release',
      label: 'Release',
      body: target(entry),
      says: 'Lift the hold or the deferral: it boards on its turn.',
    });
  } else {
    verbs.push({
      verb: 'hold',
      label: 'Hold',
      body: target(entry),
      says: 'Keep it in the queue, never admitted, until you release it. Its run boards its other phases first.',
    });
    verbs.push({
      verb: 'defer',
      label: 'Defer 1 h',
      body: { ...target(entry), until: new Date(nowMs + HOUR).toISOString() },
      says: 'Not before an hour from now; it boards by itself after that.',
    });
  }
  verbs.push({
    verb: 'withdraw',
    label: 'Withdraw',
    body: target(entry),
    says: 'Out of the queue: its run boards its other phases, and names this one until you re-queue it.',
  });
  return verbs;
}

/** The body a press sends: the press's own body, and the reason when the operator gave one. */
export function pressBody(body: Record<string, unknown>, reason: string): Record<string, unknown> {
  const why = reason.trim();
  return why ? { ...body, reason: why } : body;
}

/** A press the view carried (a hinted row's queue, a withdrawn row's re-queue), as the verb and body to send. */
export function carriedPress(press: QueuePress): { verb: string; body: Record<string, unknown> } {
  const verb = press.endpoint.split('/').filter(Boolean).pop() ?? press.verb;
  return { verb, body: press.body };
}

/** What a lane is doing and who it holds up, in one line. */
export function laneLine(lane: QueueLane): string {
  const held = lane.behind.length
    ? `holding up ${lane.behind.map((entry) => `${entry.slug}${entry.phase != null ? ` P${entry.phase}` : ''}`).join(', ')}`
    : 'nobody waiting on it';
  return lane.wait ? `${lane.wait.text} — ${held}` : held;
}

/** The lane verbs, which go to `POST /api/lane/<verb>` rather than the queue's door (control-tower phase 100). */
export const LANE_PRESSES: ReadonlySet<string> = new Set(['pin', 'unpin', 'reserve', 'unreserve', 'yield']);

/**
 * The lane presses one queued phase offers (control-tower phase 100): pin it
 * next in its plan, or keep the next lane on its scope for it — each undone by
 * its own press. Named by `{slug, phase}`: the mark is the phase's, not the entry's.
 */
export function laneVerbs(entry: QueueViewEntry): QueueRowVerb[] {
  if (entry.phase == null) return [];
  const phase = { slug: entry.slug, phase: entry.phase };
  return [
    entry.pinned
      ? {
          verb: 'unpin',
          label: 'Unpin',
          body: phase,
          says: "Lift the pin: its run's other phases board in their own order again.",
        }
      : {
          verb: 'pin',
          label: 'Pin next',
          body: phase,
          says: "Its plan's next lane is this phase's: its run's other phases wait while it waits for one.",
        },
    entry.laneReserved
      ? {
          verb: 'unreserve',
          label: 'Free lane',
          body: phase,
          says: "Lift the kept lane: its scope and slot are the queue's again.",
        }
      : {
          verb: 'reserve',
          label: 'Keep a lane',
          body: phase,
          says: 'Keep the next lane on its scope for it — nothing else on that scope boards until it does, even while it is parked.',
        },
  ];
}

/**
 * The line that says what orders this queue and what may be holding all of it
 * (control-tower phase 100): the console's policy, each plan's own, the load.
 */
export function capacityLine(view: Pick<QueueView, 'policy' | 'load'> | undefined): string {
  if (!view?.policy && !view?.load) return '';
  const labels = SCHEDULING_POLICY_LABELS as Record<string, string>;
  const policy = view.policy ? (labels[view.policy.console] ?? view.policy.console) : '';
  const own = Object.entries(view.policy?.plans ?? {}).map(([slug, word]) => `${slug}: ${word}`);
  const load = view.load
    ? view.load.threshold === null
      ? `load ${view.load.avg5}, guard off`
      : view.load.holding
        ? `the machine is loaded — ${view.load.avg5} over ${view.load.threshold} (${view.load.factor} × ${view.load.cores} cores); new work waits`
        : `load ${view.load.avg5} of ${view.load.threshold} (${view.load.factor} × ${view.load.cores} cores)`
    : '';
  return [policy, own.length ? `plans: ${own.join(', ')}` : '', load].filter(Boolean).join(' · ');
}
