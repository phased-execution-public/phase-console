/**
 * The whole queue of one console, as one answer (control-tower phase 99, #135
 * A, I and J; #67's last ask) — what `GET /api/queue` serves and the queue page
 * (`#/queue`) draws, so a terminal, the CLI and the supervisor read exactly
 * what a person sees.
 *
 * Pure: the scheduler's snapshot, the live runs' records, the hinted phases
 * and the journal's queue lines go in; every entry comes out with its plan,
 * phase, title, class, clocks, holder, account and the REASON it sits where it
 * does (`shared/queue-model.js`), in the order it will board. Beside them:
 * the lanes and who each is holding up — a lane polling its own job named as
 * such (#67) — the hinted-not-queued phases with the press that queues one,
 * the withdrawn phases with the press that brings one back, and the audit
 * strip: every queue change, newest first, with who and why.
 */

import type { Holder, QueueEntry, SchedulerSnapshot } from './runner/scheduler.ts';
import type { PhaseRecord, QueueControl, RunState } from './runner/state.ts';
import { seniorityOf } from './runner/queue-episodes.ts';
import { holderWords, laneWaitOf, queueOrderReason } from '../shared/queue-model.js';
import { runPriority, withdrawnReason } from '../shared/orchestration-model.js';

/** A holder as the view shows it: the lane's wait, when the holder is a lane in a wait chain (#67). */
export type QueueViewHolder = Holder & { laneWait?: ReturnType<typeof laneWaitOf> & object };

export type QueueViewEntry = Omit<QueueEntry, 'waitingOn'> & {
  waitingOn: QueueViewHolder[];
  /** 1-based place in the scan — the order it will board in. */
  position: number;
  title?: string;
  /** The class, always named — `normal` included. */
  class: string;
  /** The account it will board on, always named — `default` included. */
  account: string;
  clocks: { since: string; waitedMs: number; seniority?: { clock: string; since: string } };
  /** Why it sits where it does: the first of the scan's keys that applies, and all that do. */
  reason: ReturnType<typeof queueOrderReason>;
  /** What it waits on, in words — the head holder's sentence. */
  waits: string;
};

export type QueueLane = {
  slug: string; phase: number | null; runId: string; scope: string[];
  account: string; since: string; title?: string;
  /** The lane is in a wait chain — polling its own job, or on an outside clock (#67). */
  wait?: NonNullable<ReturnType<typeof laneWaitOf>>;
  /** The entries whose head holder is this lane. */
  behind: { slug: string; phase: number | null }[];
};

type Press = { verb: string; method: 'POST'; endpoint: string; body: Record<string, unknown> };

export type QueueHintedRow = {
  slug: string; runId: string; phase: number; since: string; waitedMs: number;
  rung: string; brief: string | null; by: string | null; serialBehind?: number; title?: string; why: string;
  control?: QueueControl;
  /** The press that queues it now — a bump: first in its run's next lane, first in its class. */
  queue: Press;
};

export type QueueWithdrawnRow = {
  slug: string; runId: string; phase: number; at: string; by: string; reason?: string; title?: string;
  text: string;
  requeue: Press;
};

/** One journal line the audit strip may show — what `queueAuditRows` reads. */
export type QueueAuditLine = {
  slug: string; runId: string; at?: string; event: string; phase?: number | null; data?: Record<string, unknown>;
};

export type QueueAuditRow = {
  at: string | null; slug: string; runId: string; phase: number | null;
  verb: string; by: string | null; reason?: string; text: string;
};

export type QueueView = {
  entries: QueueViewEntry[];
  lanes: QueueLane[];
  hinted: QueueHintedRow[];
  withdrawn: QueueWithdrawnRow[];
  audit: QueueAuditRow[];
};

/** The journal events the audit strip reads, and the verb each is. */
const AUDIT_VERBS: Readonly<Record<string, string>> = Object.freeze({
  'phase.queue-bumped': 'bump',
  'phase.queue-held': 'hold',
  'phase.queue-released': 'release',
  'phase.queue-deferred': 'defer',
  'phase.queue-withdrawn': 'withdraw',
  'phase.queue-requeued': 'requeue',
  'run.queue-reordered': 'reorder',
  // The lane verbs (control-tower phase 100).
  'phase.lane-pinned': 'pin',
  'phase.lane-unpinned': 'unpin',
  'phase.lane-reserved': 'reserve',
  'phase.lane-unreserved': 'unreserve',
  'phase.lane-yielded': 'yield',
});

/** Is this journal event one the audit strip shows? */
export function isQueueAuditEvent(event: string): boolean {
  return event in AUDIT_VERBS;
}

/** `{slug, phase}` in words, or null. */
const laneOf = (value: unknown): string | null => {
  const lane = value as { slug?: unknown; phase?: unknown } | null | undefined;
  return lane && typeof lane.slug === 'string' && typeof lane.phase === 'number' ? `${lane.slug} P${lane.phase}` : null;
};

const ordinal = (n: number): string => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
};

/**
 * The audit strip (control-tower phase 99, #135 I.30): every queue change,
 * newest first, each one sentence — who did what to which phase, and why.
 */
export function queueAuditRows(lines: readonly QueueAuditLine[], limit = 50): QueueAuditRow[] {
  const rows: QueueAuditRow[] = [];
  for (const line of lines) {
    const verb = AUDIT_VERBS[line.event];
    if (!verb) continue;
    const data = line.data ?? {};
    const by = typeof data.by === 'string' ? data.by : null;
    const reason = typeof data.reason === 'string' && data.reason ? data.reason : undefined;
    const phase = typeof line.phase === 'number' ? line.phase : null;
    const target = `${line.slug}${phase != null ? ` P${phase}` : ''}`;
    const order = data.order as { before?: number; after?: number } | undefined;
    const moved = order && typeof order.before === 'number' && typeof order.after === 'number'
      ? ` (${ordinal(order.before + 1)} → ${ordinal(order.after + 1)})` : '';
    const what = verb === 'bump' ? `moved ${target} ahead${moved}`
      : verb === 'hold' ? `held ${target}`
        : verb === 'release' ? `released ${target}`
          : verb === 'defer' ? `deferred ${target} until ${String(data.until ?? '?')}`
            : verb === 'withdraw' ? `withdrew ${target} from the queue`
              : verb === 'requeue' ? `re-queued ${target}${data.position === 'front' ? ' at the front' : ''}`
                : verb === 'pin' ? `pinned ${target} next in its plan`
                  : verb === 'unpin' ? `unpinned ${target}`
                    : verb === 'reserve' ? `kept the next lane for ${target}${laneOf(data.lane) ? ` when ${laneOf(data.lane)} ends` : ''}`
                      : verb === 'unreserve' ? `lifted the lane kept for ${target}`
                        : verb === 'yield' ? `asked ${target} to yield its lane${laneOf(data.to) ? ` to ${laneOf(data.to)}` : ''}`
                          : `reordered ${line.slug}: ${(Array.isArray(data.phases) ? data.phases : []).map((p) => `P${p}`).join(', ')}`;
    rows.push({
      at: line.at ?? null, slug: line.slug, runId: line.runId, phase, verb, by,
      ...(reason ? { reason } : {}),
      text: `${by ?? 'somebody'} ${what}${reason ? ` — ${reason}` : ''}`,
    });
  }
  return rows.sort((a, b) => Date.parse(b.at ?? '') - Date.parse(a.at ?? '')).slice(0, limit);
}

export type QueueViewInput = {
  snapshot: SchedulerSnapshot;
  hinted: readonly { slug: string; runId: string; phase: number; since: string; rung: string; brief: string | null; by: string | null; serialBehind?: number }[];
  /** The runs whose records the view reads — the live ones; their records carry the clocks, the stalls and the marks. */
  runs: readonly RunState[];
  now: number;
  title?: (slug: string, phase: number) => string | undefined;
  audit?: readonly QueueAuditLine[];
};

const iso = (ms: number): string => new Date(ms).toISOString();

/** The whole queue, seen. See the file header. */
export function queueView(input: QueueViewInput): QueueView {
  const { snapshot, now } = input;
  const runById = new Map(input.runs.map((run) => [run.id, run] as const));
  const recordOf = (runId: string, phase: number | null): PhaseRecord | undefined =>
    phase == null ? undefined : runById.get(runId)?.phases[String(phase)];
  const titleOf = (slug: string, phase: number | null): string | undefined => {
    if (phase == null || !input.title) return undefined;
    try { return input.title(slug, phase) || undefined; } catch { return undefined; }
  };
  const grantOf = (holder: Holder) => snapshot.grants.find((grant) => grant.slug === holder.slug && grant.phase === holder.phase);
  const laneWaitFor = (runId: string, phase: number | null) => laneWaitOf(recordOf(runId, phase)?.stall, now) ?? undefined;

  const entries: QueueViewEntry[] = [...snapshot.entries]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((entry, index) => {
      const waitingOn: QueueViewHolder[] = entry.waitingOn.map((holder) => {
        const grant = holder.kind === 'grant' ? grantOf(holder) : undefined;
        const laneWait = grant ? laneWaitFor(grant.runId, grant.phase) : undefined;
        return { ...holder, ...(laneWait ? { laneWait } : {}) };
      });
      const record = recordOf(entry.runId, entry.phase);
      const senior = record ? seniorityOf(record, iso(now)) : null;
      const head = waitingOn[0];
      return {
        ...entry,
        waitingOn,
        position: index + 1,
        ...(titleOf(entry.slug, entry.phase) ? { title: titleOf(entry.slug, entry.phase)! } : {}),
        class: runPriority(entry.priority),
        account: entry.accountId ?? 'default',
        clocks: {
          since: iso(entry.since), waitedMs: Math.max(0, now - entry.since),
          ...(senior ? { seniority: { clock: senior.clock, since: senior.at } } : {}),
        },
        reason: queueOrderReason(entry, {
          nowMs: now,
          bump: entry.control?.bump ?? record?.queueControl?.bump ?? null,
          pin: entry.control?.pin ?? record?.queueControl?.pin ?? null,
          seniority: senior ? { clock: senior.clock, since: senior.at } : null,
        }),
        waits: head ? holderWords(head, { laneWait: head.laneWait ?? null }) + (waitingOn.length > 1 ? ` +${waitingOn.length - 1} more` : '') : 'nothing — it boards on the next scan',
      };
    });

  const lanes: QueueLane[] = snapshot.grants.map((grant) => {
    const wait = laneWaitFor(grant.runId, grant.phase);
    return {
      slug: grant.slug, phase: grant.phase, runId: grant.runId, scope: grant.scope,
      account: grant.accountId ?? 'default', since: iso(grant.at),
      ...(titleOf(grant.slug, grant.phase) ? { title: titleOf(grant.slug, grant.phase)! } : {}),
      ...(wait ? { wait } : {}),
      behind: entries
        .filter((entry) => entry.waitingOn[0]?.kind === 'grant' && entry.waitingOn[0].slug === grant.slug && entry.waitingOn[0].phase === grant.phase)
        .map((entry) => ({ slug: entry.slug, phase: entry.phase })),
    };
  });

  const hinted: QueueHintedRow[] = input.hinted
    .filter((row) => !recordOf(row.runId, row.phase)?.queueControl?.withdrawn)
    .map((row) => {
      const control = recordOf(row.runId, row.phase)?.queueControl;
      return {
        // Phase 86's row whole — what `hintedPhases` said — and the view's additions.
        ...row,
        waitedMs: Math.max(0, now - Date.parse(row.since)),
        ...(titleOf(row.slug, row.phase) ? { title: titleOf(row.slug, row.phase)! } : {}),
        why: row.serialBehind != null
          ? `re-boarded, and waiting behind its own run's P${row.serialBehind}`
          : 're-boarded, and waiting for one of its run\'s lanes',
        ...(control ? { control } : {}),
        queue: { verb: 'bump', method: 'POST', endpoint: '/api/queue/bump', body: { slug: row.slug, phase: row.phase } },
      };
    });

  const withdrawn: QueueWithdrawnRow[] = [];
  for (const run of input.runs) {
    for (const record of Object.values(run.phases)) {
      const mark = record?.queueControl?.withdrawn;
      if (!mark || record.status === 'done' || record.status === 'skipped') continue;
      withdrawn.push({
        slug: run.slug, runId: run.id, phase: record.phase, at: mark.at, by: mark.by,
        ...(mark.reason ? { reason: mark.reason } : {}),
        ...(titleOf(run.slug, record.phase) ? { title: titleOf(run.slug, record.phase)! } : {}),
        text: withdrawnReason(mark),
        requeue: { verb: 'requeue', method: 'POST', endpoint: '/api/queue/requeue', body: { slug: run.slug, phase: record.phase } },
      });
    }
  }
  withdrawn.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return { entries, lanes, hinted, withdrawn, audit: queueAuditRows(input.audit ?? []) };
}
