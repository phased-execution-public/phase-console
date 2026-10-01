/**
 * Every phase lock this console can see, one row each — and, in Pro, the
 * ledger of what happened to each (#24).
 *
 * The lock is what decides whether a phase may board at all, and it was the
 * one object with no view: a reader met it only inside a queue entry, a plan
 * record or a session row, and "why is this phase not starting?" took four
 * sources and a `ps`. The rows are built from the lock FILES, the way
 * `liveLockFiles()` reads them, because `lockView()` carries neither `branch`
 * nor `worktree`; a lapse is `lockLapsed(lock, now, presence)` — the one lock
 * clock, which knows an ENDED session lapses a claim before its lease does —
 * never the bit frozen when the store last scanned; and a row says what it is
 * costing: the queue entries waiting on it, and its holder plan's ETA.
 *
 * The words are `shared/lock-model.js`'s. `GET /api/locks` serves the rows.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { log } from './log.ts';
import type { Lock } from './parse/folder.ts';
import { readLock } from './store.ts';
import { autopilotRunId, lockLapsed, type HolderEta, type QueueEntry } from './runner/scheduler.ts';
import type { Presence } from '../shared/run-lifecycle.js';
import { lockRowRank, type LockEventKind, type LockHolderKind } from '../shared/lock-model.js';
import { scopesIntersect } from '../shared/scope.js';

/** One claim, as `GET /api/locks` serves it. Times are epoch milliseconds. */
export type LockRow = {
  slug: string;
  phase: number;
  phaseTitle: string;
  owner: string;
  host?: string;
  claimedAt?: number;
  leaseUntil?: number;
  /** Empty when the claim named none — which collides with everything. */
  scope: string[];
  session?: string;
  presence: Presence;
  branch?: string;
  worktree?: string;
  /** `lockLapsed(lock, now, presence)`: past its lease, or its session ended. */
  lapsed: boolean;
  holderKind: LockHolderKind;
  /** The run an autopilot claim belongs to (`autopilot/<runId>`). */
  runId?: string;
  /** The queue entries waiting on THIS claim — what it is costing. */
  blocking: { slug: string; phase: number | null; runId: string }[];
  /** The holder plan's remaining-work estimate, as the scheduler computes it. */
  eta?: HolderEta;
};

/** `?held=1`, `?lapsed=1`, `?scope=<repo>` — see `LOCK_FILTERS`. */
export type LockFilter = { held?: true; lapsed?: true; scope?: string };

export type LockRowDeps = {
  /** The lock files as they are on disk now. */
  locks: () => Lock[];
  title: (slug: string, phase: number) => string;
  presence: (lock: Lock) => Presence;
  queue: () => readonly QueueEntry[];
  eta: (slug: string) => HolderEta | undefined;
  now: () => number;
};

/**
 * Every `phase-NN.lock` under the given plans' handoff folders, read off disk
 * now — `liveLockFiles()`'s walk, keeping the whole `Lock` (host, claim time,
 * branch, worktree) rather than the scheduler's narrower view of it.
 */
export function readLockFiles(handoffsDir: string, slugs: readonly string[]): Lock[] {
  const out: Lock[] = [];
  for (const slug of slugs) {
    let files: string[];
    try {
      files = readdirSync(join(handoffsDir, slug, '.locks')).filter((name) => /^phase-\d+\.lock$/.test(name));
    } catch {
      continue;
    }
    for (const file of files) {
      const phase = Number.parseInt(file.slice('phase-'.length), 10);
      if (!Number.isFinite(phase)) continue;
      const lock = readLock(handoffsDir, slug, phase);
      if (lock) out.push(lock);
    }
  }
  return out;
}

/** Autopilot (`autopilot/<runId>`, `scheduler.ts`'s own reading) or a person. */
export function holderKindOf(owner: string): { holderKind: LockHolderKind; runId?: string } {
  const runId = autopilotRunId(owner);
  return runId ? { holderKind: 'autopilot', runId } : { holderKind: 'person' };
}

/** A query string to a filter. `1`, `true` and `yes` switch a flag on; anything else leaves it off. */
export function parseLockFilter(params: URLSearchParams): LockFilter {
  const on = (key: string): boolean => ['1', 'true', 'yes'].includes((params.get(key) ?? '').toLowerCase());
  const scope = (params.get('scope') ?? '').trim();
  return {
    ...(on('held') ? { held: true as const } : {}),
    ...(on('lapsed') ? { lapsed: true as const } : {}),
    ...(scope ? { scope } : {}),
  };
}

/** The rows, filtered, worst-first: lapsed, then live and blocking, then live and idle. */
export function lockRows(deps: LockRowDeps, filter: LockFilter = {}): LockRow[] {
  const now = deps.now();
  const queue = deps.queue();
  const rows = deps.locks().map((lock): LockRow => {
    const presence = deps.presence(lock);
    const blocking = queue
      .filter((entry) => entry.waitingOn.some((holder) =>
        holder.kind === 'lock' && holder.slug === lock.slug && holder.phase === lock.phase))
      .map((entry) => ({ slug: entry.slug, phase: entry.phase, runId: entry.runId }));
    const eta = deps.eta(lock.slug);
    return {
      slug: lock.slug,
      phase: lock.phase,
      phaseTitle: deps.title(lock.slug, lock.phase),
      owner: lock.owner,
      ...(lock.host ? { host: lock.host } : {}),
      ...(lock.claimedAt != null ? { claimedAt: lock.claimedAt } : {}),
      ...(lock.leaseUntil != null ? { leaseUntil: lock.leaseUntil } : {}),
      scope: lock.scope ?? [],
      ...(lock.session ? { session: lock.session } : {}),
      presence,
      ...(lock.branch ? { branch: lock.branch } : {}),
      ...(lock.worktree ? { worktree: lock.worktree } : {}),
      lapsed: lockLapsed(lock, now, presence),
      ...holderKindOf(lock.owner),
      blocking,
      ...(eta ? { eta } : {}),
    };
  });
  return rows
    .filter((row) => !(filter.held && row.lapsed))
    .filter((row) => !(filter.lapsed && !row.lapsed))
    .filter((row) => !filter.scope || scopesIntersect(row.scope, filter.scope))
    .sort((a, b) => lockRowRank(a) - lockRowRank(b) || a.slug.localeCompare(b.slug) || a.phase - b.phase);
}

