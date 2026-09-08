/**
 * Who is allowed to run right now.
 *
 * Concurrency in this console is not "how many sessions may exist" — it is
 * "which sessions can safely exist *together*". Two phases that touch
 * different repositories cannot collide however hard they try; two that touch
 * the same one will, and the collision is two agents writing one working tree,
 * which is the failure this whole mechanism exists to prevent. So admission is
 * decided by SCOPE (the plan's Repos column, read through `shared/scope.js`),
 * not by counting.
 *
 * One scheduler owns every admission decision in the process. That is
 * deliberate: the check has to see all of it — every lane of every run, plus
 * every lock on disk written by a bash session or a human — or it is not a
 * check, it is a hope. A second decision-maker with a partial view would admit
 * exactly the pair the first one refused.
 *
 * ## What it is not
 *
 * It has **no persistence of its own**. The pending `admit()` promises ARE the
 * queue; a console restart loses them, which is correct, because the runs they
 * belonged to lost their loops at the same moment. The durable shadow is the
 * run's own `status: 'queued'` checkpoint — and a queued run is the one thing
 * `Service.open()` may re-adopt unasked, precisely because by definition it did
 * nothing.
 *
 * ## Fairness
 *
 * A plain FIFO stalls: a wide `all`-scoped phase at the head blocks a hundred
 * disjoint ones behind it for as long as it waits. So the scan is **first-fit**
 * — a blocked head never stalls a disjoint tail. Pure first-fit starves,
 * though, which is the opposite failure and a worse one, because it is silent:
 * the wide phase waits forever while narrow ones stream past it. The bound is
 * **aging**: once an entry has been bypassed by enough intersecting work, or
 * has simply waited long enough, it RESERVES its tokens against everything
 * behind it and the queue drains toward it. Bounded bypass, not free bypass.
 */

import { randomUUID } from 'node:crypto';

import {
  CHAIN_HOLDER,
  DEFAULT_PRIORITY,
  FLEET_HOLDER,
  HOLD_HOLDER,
  chainReason,
  fleetFreezeReason,
  holdReason,
  priorityRank,
  type RunPriority,
} from '../../shared/orchestration-model.js';
import { scopesIntersect, intersectingTokens, formatScope, claimsDisjoint } from '../../shared/scope.js';
import { scheduleState, type SchedulePolicy } from '../../shared/schedule-policy.js';
import { DEFAULT_MAX_SESSIONS } from '../config.ts';
import { log } from '../log.ts';
import type { Presence } from '../../shared/run-lifecycle.js';
import type { HolderKind, QueueKind } from '../../shared/run-lifecycle.js';

/** How many later intersecting entries may be admitted past a blocked one. */
export const MAX_BYPASS = 4;
/** …and how long it may wait regardless, before it reserves. */
export const AGING_MS = 10 * 60_000;
/** A quiet re-check, so nothing waits on an event that never comes. */
const IDLE_POLL_MS = 60_000;

export { DEFAULT_MAX_SESSIONS };

/** A live claim on a scope. Held by a lane for as long as its session runs. */
export type ScopeGrant = {
  id: string;
  slug: string;
  /** Null for an admission that is not about one phase (a recovery session). */
  phase: number | null;
  runId: string;
  scope: string[];
  /** See `AdmitRequest.branch` — carried so a grant can carve out like a lock. */
  branch?: string;
  /** See `AdmitRequest.tree` — the second carve dimension, carried the same way. */
  tree?: string;
  at: number;
};

export type AdmitRequest = {
  slug: string;
  phase: number | null;
  runId: string;
  scope: string[];
  /**
   * The branch this admission's session will commit on, when it has one of its
   * own — a lane's `pe/<slug>-pN`, or an isolated run's `pe/<slug>`.
   *
   * The SAME answer the lock's `branch=` line carries (`RunnerBase.branchFor`),
   * and it has to be: the scan weighs this request against locks on disk, so a
   * request that named the run branch while its lock named the lane branch
   * would be two claims about one session disagreeing with each other.
   *
   * Absent means the run has no branch at all (default-branch mode). An
   * unqualified claim collides with everything, exactly as every claim did
   * before this field existed. See `claimsDisjoint`.
   */
  branch?: string;
  /**
   * The WORKING TREE this admission's session will edit — the run's own
   * checkout (`workRoot`) when it has one, else the shared root. The second
   * carve dimension: branches alone carved out two sessions editing ONE
   * shared checkout on different branches, so disjointness now needs both
   * the branches AND the trees to differ (`claimsDisjoint`). The SAME answer
   * the lock's `worktree=` line carries (`RunnerBase.treeFor`), for the same
   * one-session-one-claim reason as `branch`.
   */
  tree?: string;
  /**
   * Which Claude account this admission would spend. Absent means the machine
   * login. The throttle is keyed by this: one account hitting its window must
   * not stall a run that pays with a different one.
   */
  accountId?: string;
  /** The run's abort signal — a Stop must not leave admissions pending. */
  signal?: AbortSignal;
  /**
   * What kind of session this admission is for. Only the boarding SCHEDULE
   * reads it, and only to exempt `recovery`: a phase boarding is the autopilot
   * deciding to start work, which is exactly what an operator asleep at 03:00
   * asked the schedule to prevent — while a recovery exists because that
   * operator pressed a button, and a console that refused it until Monday would
   * be answering a question nobody asked. Absent reads as `phase`, so every
   * caller that does not care is governed.
   */
  kind?: QueueKind;
  /**
   * Which class this admission is scanned in. Absent reads as `normal`.
   *
   * The birth value only. An operator who changes a live run's class is served
   * by `reprioritize`, because the entries this request mints may already be
   * waiting by then and re-reading the run from inside the scan would make the
   * scheduler depend on the Service, which is the coupling this class does not
   * have and should not grow.
   */
  priority?: RunPriority;
};

/**
 * How much longer the plan a holder belongs to has left.
 *
 * The one question an operator asks about a queue that the queue could not
 * answer: *how long*. Both fields are nullable and stay absent rather than
 * guessing — an estimate exists only once something of that plan has finished,
 * and a made-up number here would be indistinguishable from a measured one.
 */
export type HolderEta = {
  /** Plan weight still to do — the raw number, for sorting and for a tooltip. */
  remainingWeight?: number;
  /** The hedged range the plan page shows (`~2–4 h left`). */
  label?: string;
};

/** What is standing in an entry's way, in the words the queue page shows. */
export type Holder = {
  kind: HolderKind;
  slug: string;
  phase: number | null;
  owner: string;
  scope: string[];
  /**
   * The branch this holder's work rides, when it declared one. Reported rather
   * than acted on HERE — by the time a holder exists the branch question has
   * already been asked and answered against it (`conflictsFor`); this is so the
   * queue page can say "…and it is on the same branch as you", which is the
   * first thing an operator asks once two trees are in play.
   */
  branch?: string;
  /** The working tree the holder's work rides, when it declared one. */
  tree?: string;
  /** Which tokens actually collided — the *why*, not just the *that*. */
  overlaps: string[];
  /**
   * How much longer the holder's own plan has. Reported, never acted on — a
   * queue that reordered itself on an estimate would be a queue whose order
   * depended on how much history a plan happened to have.
   *
   * Absent for the synthesised CLOCK holders (a boarding window, the session
   * cap, a usage wall): those are not plans, they have no remaining work, and
   * the moment they end is already on `leaseUntil` or in their own words.
   */
  eta?: HolderEta;
  /**
   * When a `lock` holder's lease lapses (ms epoch). The queue page turns it
   * into "lease ends <t>", and the lock timer wakes the scan at the soonest
   * one — a foreign lock's release is the one event this process may never
   * hear otherwise.
   */
  leaseUntil?: number;
  /** The holding session's id (`session=`), when the lock names one. */
  session?: string;
  /**
   * What the session registry says about that session: `live` — a person (or
   * another console) is in it right now, so this is a queue to wait in, not a
   * lease to outlive; `unknown` — no hook reports it, lease rules apply. An
   * `ended` session's lock never reaches a Holder: it lapses at once.
   */
  presence?: 'live' | 'unknown';
  /**
   * This holder is a CLOCK, not another actor: the operator's boarding window,
   * the live-session cap, an account's usage wall. Synthesised by the scheduler
   * rather than read off a grant or a lock — there is nobody to name, nothing to
   * release, and the wait ends by itself at a moment that is already known.
   *
   * The runner's admission cap reads it (D2): a wait on a clock must never be
   * capped into a park, because parking a phase for waiting exactly as long as
   * it was told to is the console punishing its own policy.
   */
  clock?: true;
};

export type QueueEntry = {
  id: string;
  slug: string;
  phase: number | null;
  runId: string;
  scope: string[];
  /** See `AdmitRequest.branch`. Absent means unqualified — collides with all. */
  branch?: string;
  /** See `AdmitRequest.tree`. Absent means unqualified — collides with all. */
  tree?: string;
  /** The account the admission spends — see `AdmitRequest.accountId`. */
  accountId?: string;
  /** See `AdmitRequest.kind`. Absent reads as `phase`. */
  kind?: QueueKind;
  since: number;
  waitingOn: Holder[];
  /** Later intersecting entries admitted past this one. Bounded by `MAX_BYPASS`. */
  bypassed: number;
  /** Aged out — its tokens now block everything behind it. */
  reserving: boolean;
  /** The scan class. Absent reads as `normal`; see `AdmitRequest.priority`. */
  priority?: RunPriority;
  /** Moved to the front of its class by an operator. One-shot — see `bump`. */
  bumped?: true;
  /** The run is held: nothing of it may board. `by` is who said so. */
  held?: { at: string; by?: string };
  /** The plan this entry is chained behind and still waiting on. */
  after?: string;
};

/** A lock on disk, as the store already reads it. Scope absent = never declared. */
export type LockView = {
  slug: string;
  phase: number;
  owner: string;
  expired: boolean;
  scope?: string[];
  /**
   * `lease_until` from the lock file, ms epoch. The `expired` bit above is
   * frozen at store-scan time; this lets the scheduler decide expiry by the
   * clock instead, so a lease that lapses between docs refreshes stops
   * blocking the moment it lapses.
   */
  leaseUntil?: number;
  /** `session=` from the lock file — the key the registry answers presence for. */
  session?: string;
  /**
   * `branch=` from the lock file — which branch the holding session's work
   * rides, or absent when it never said. Half of the carve-out decision;
   * absent is not "unknown, assume the worst" so much as it IS the worst:
   * `claimsDisjoint` reads it as colliding with everything, so every lock
   * written before this line existed serialises exactly as it did.
   */
  branch?: string;
  /**
   * `worktree=` from the lock file — the working tree the holding session
   * edits. The OTHER half of the carve-out: a branch alone proved nothing
   * about two sessions sharing one checkout, so both dimensions must differ.
   */
  tree?: string;
};

/**
 * Has this lock lapsed? THE lock clock — one definition, every reader.
 *
 * Expiry is decided by the clock, not by the bit the store froze at scan time.
 * A lease that lapsed since the last docs refresh must stop blocking NOW —
 * otherwise a dead claim holds the queue until an unrelated file changes.
 *
 * Free and exported deliberately (P6/D3). The scheduler used to own this as a
 * private method while `Service.evidenceDeps.lock` forwarded the store's frozen
 * `expired` bit straight to the situation classifier — so for the SAME lock in
 * the SAME second the scheduler said lapsed (queue may proceed) and the healer
 * said `foreign-live`, a situation with no rung, where `foreign-stale` has a
 * takeover one. Two answers to one question, and the console acted on both.
 *
 * `presence` is the registry's word on the holder's session: a lock whose
 * session has ENDED is debris the moment it ends — the registry knows before
 * the lease does (Phase 5 presence semantics). `unknown` (or absent) leaves the
 * lease-based reading in charge.
 */
export function lockLapsed(
  lock: Pick<LockView, 'expired' | 'leaseUntil'>,
  nowMs: number,
  presence: Presence = 'unknown',
): boolean {
  if (lock.expired) return true;
  if (presence === 'ended') return true;
  return lock.leaseUntil != null && lock.leaseUntil <= nowMs;
}

/**
 * Are the holder and the waiter two actors on ONE unit of work?
 *
 * A slug+phase is one job. Whatever the repository guard says about scopes,
 * two sessions on one phase is never something a scope policy can license:
 * they write the same handoff, take the same lock, and commit each other's
 * half-finished edits. The guard's documented purpose is contention between
 * DIFFERENT work that happens to share a checkout, and that purpose is
 * preserved — a foreign holder on a merely-overlapping *other* phase is still
 * waved through when the guard is off.
 *
 * `phase == null` (a run-level admission, a recovery) is deliberately never a
 * match: "the whole plan" is not a unit of work anyone else can be inside.
 */
function sameUnitOfWork(holder: Pick<Holder, 'slug' | 'phase'>, entry: Pick<Waiting, 'slug' | 'phase'>): boolean {
  return entry.phase != null && holder.phase === entry.phase && holder.slug === entry.slug;
}

/**
 * The learned usage walls, as the Scheduler needs to see them.
 *
 * Deliberately the shape `Accounts` already has (`limitedUntil` / `markLimited`
 * / `accountIds`) rather than a scheduler-flavoured one: the point of the
 * interface is that the registry can BE it, so there is one store rather than
 * one store and a mirror.
 */
export type AccountWalls = {
  /** bucket → ISO reset for this account, windows already lapsed at `nowMs` dropped. */
  limitedUntil(accountId: string, nowMs: number): Record<string, string>;
  markLimited(accountId: string, bucket: string, resetsAt: string): void;
  /** Every account this instance knows — the default first. */
  accountIds(): string[];
};

/**
 * The bucket a wall learned from the admission side is filed under when the
 * caller does not name one. The runner DOES name one (`limitBucket` off the
 * limit message), which is the case that matters; this is for a bare
 * `throttle(untilMs)` — tests, and any future caller that only knows "later".
 */
export const LEARNED_WALL_BUCKET = 'learned_window';

/**
 * The walls when nobody wired a registry in — a Scheduler constructed bare, as
 * every unit test does. Not a second copy of anything: with no registry there
 * is nothing else holding these, so this IS the store, and it is the only
 * configuration in which the Scheduler owns one.
 */
class MemoryWalls implements AccountWalls {
  private byAccount = new Map<string, Record<string, string>>();

  limitedUntil(accountId: string, nowMs: number): Record<string, string> {
    const raw = this.byAccount.get(accountId) ?? {};
    const live: Record<string, string> = {};
    for (const [bucket, iso] of Object.entries(raw)) {
      if (Date.parse(iso) > nowMs) live[bucket] = iso;
    }
    return live;
  }

  markLimited(accountId: string, bucket: string, resetsAt: string): void {
    this.byAccount.set(accountId, { ...this.byAccount.get(accountId), [bucket]: resetsAt });
  }

  accountIds(): string[] {
    return [...new Set(['default', ...this.byAccount.keys()])];
  }
}

export type SchedulerDeps = {
  /**
   * Where the usage walls live. The account registry in the real console — see
   * `AccountWalls`. Absent: an in-memory fallback, for a Scheduler with no
   * registry behind it.
   */
  accountWalls?: AccountWalls;
  /** Lanes allowed live at once, read per call so a settings change lands. */
  max?: number | (() => number);
  /**
   * Every lock on disk, across ALL plans. Synchronous on purpose: the store
   * already holds them and refreshes on the docs watcher, and an async read
   * here would open a window between deciding and granting in which the answer
   * could change — which is the one thing an admission check may not do.
   */
  locks?: () => readonly LockView[];
  /**
   * A phase's declared scope, from the plan's Repos column.
   *
   * Used for a lock that carries no `scope=` line. `phase-lock.sh conflicts`
   * treats such a lock as UNKNOWN and collides with everything, because bash
   * cannot always resolve the plan; the console can, and recovering the
   * declaration the claim would have written is not a weakening — it is the
   * same SSOT, read from the other end. An unknown plan still falls back to
   * `all`, so uncertainty keeps its fail-safe direction.
   */
  scopeFor?: (slug: string, phase: number) => string[] | undefined;
  /**
   * How much longer a holder's plan has, for the queue page's *how long*.
   *
   * SYNCHRONOUS, like `locks()` and `scopeFor` and for the identical reason:
   * an await between deciding and granting is the one window an admission
   * check may not open. The Service answers from a memo it refreshes in the
   * background (`ServiceRuns.etaHint`), so a cold answer is `undefined` —
   * which is the honest one, and which changes no decision, because this is
   * decoration and nothing reads it to admit or refuse anything.
   */
  etaFor?: (slug: string) => HolderEta | undefined;
  now?: () => number;
  /** Called whenever the queue or the grant set changed. Drives `run:queue`. */
  onChange?: (snapshot: SchedulerSnapshot) => void;
  /**
   * A phase's lock read LIVE off disk — the entry's own slug+phase — for the
   * one holder the store-fed `locks()` can lag on: a same-phase foreign claim
   * written seconds ago. Synchronous like `locks()`, for the same reason (an
   * await between deciding and granting is the window an admission check may
   * not open); one small file per queue entry per scan. Absent: the belt-check
   * in the runner is the only live read, and it backs off instead of spinning.
   *
   * 🔴 Its answer OUTRANKS the store's row for that slug+phase, it does not
   * merely fill a gap. The first cut asked it only when the store held NO row
   * for the key — and a store that lags holds a STALE row exactly as often as
   * none: a claim whose lease had lapsed on the store's copy and had just been
   * refreshed or taken over on disk read as lapsed, the live read was skipped
   * because a row existed, and the phase was admitted over a live holder on
   * the very unit of work the lock exists to protect. A `null` answer (no
   * file, or a closed plan) leaves the store's row in charge — that direction
   * only ever blocks longer, never admits sooner.
   */
  liveLock?: (slug: string, phase: number) => LockView | null | undefined;
  /**
   * The repository guard — whether CROSS-RUN scope conflicts block admission.
   * Read per call, like `max`, so a preference flip lands on the next poll.
   * Absent means on: serializing overlapping runs is the safe state and must
   * be the silent one. With the guard off, only a run's own lanes still
   * serialize against each other — two lanes of one run in one checkout are
   * still two agents in one tree — while foreign grants, on-disk locks and
   * other runs' reserved tokens stop blocking. The cap and the usage-window
   * throttle are about the machine and the account, not about scopes, so they
   * hold either way.
   */
  guard?: () => boolean;
  /**
   * Presence of the session a lock names (Phase 5). `ended` — the session
   * registry saw its SessionEnd (or its process is gone): the lock is debris
   * and stops blocking NOW, lease or no lease, exactly as a lapsed lease does;
   * `live` — the holder is named as a live session on the queue; `unknown` —
   * nothing is known and lease rules decide. Synchronous like every other
   * answer an admission check reads. Absent: every lock is `unknown`.
   */
  presence?: (lock: LockView) => Presence;
  /**
   * When this console is willing to START phases — the operator's boarding
   * windows, quiet hours and cron openings (`shared/schedule-policy.js`).
   *
   * Read per call like `max` and `guard`, so a settings change lands on the
   * next scan rather than at the next restart. Absent, or a policy with
   * `enabled: false`, means every hour boards — which is what this console has
   * always done and must keep doing by default: a schedule that appeared out of
   * an upgrade would silently stop somebody's overnight run.
   */
  schedule?: () => SchedulePolicy | undefined;
  /**
   * Is this run HELD — the operator's "board nothing new, finish what you
   * started"? Returns the hold record (so the queue can say who and when) or
   * null. Read per call like `guard`, so a release lands on the next scan.
   *
   * Keyed by slug rather than run id because that is what the Service can
   * answer synchronously: a run's hold lives on its checkpoint, and the live
   * runner for a plan is the one thing the Service has in hand. Absent: nothing
   * is ever held, which is the behaviour before this existed.
   */
  holdFor?: (slug: string, runId: string) => { at: string; by?: string } | null | undefined;
  /**
   * The plan this entry is chained behind and which has not settled yet, or
   * null when it may proceed (`RunState.startAfter`).
   *
   * A scheduler HOLDER rather than a special case in the convergence loop, and
   * deliberately: converge runs on a clock and would release the chain up to a
   * minute late, in a place with no queue entry to name — so the chain would be
   * invisible for the whole of its wait, which is the failure `waitingOn`
   * exists to prevent. As a holder it is a line on the queue page from the
   * first scan, and `Service.runSettled` wakes the scan the moment the
   * predecessor ends.
   */
  chainBlocker?: (slug: string, runId: string) => string | null | undefined;
  /**
   * Is the whole console frozen — the operator's panic button? Returns the
   * marker (so the queue can say who and when) or null. Read per call, like
   * `guard` and `holdFor`, so a thaw lands on the very next scan.
   *
   * It is consulted FIRST, ahead of the boarding window, and it differs from
   * every other pseudo-holder in exactly one way that matters: it does **not**
   * exempt `kind: 'recovery'`. The boarding schedule does, because a recovery
   * is the console repairing something already begun and quiet hours are about
   * not STARTING work. A fleet freeze is the operator saying *stop*, and a
   * console that answered "not you, you are a recovery" would relaunch the
   * very session they just stopped — the "it said frozen but kept working"
   * failure this whole phase exists to close.
   *
   * Absent means nothing is ever frozen, which is the behaviour before this
   * existed and the right answer for a harness not exercising it.
   */
  fleetHold?: () => { at: string; by?: string } | null | undefined;
};

export type SchedulerSnapshot = {
  max: number;
  live: number;
  queued: number;
  /**
   * The SOONEST-ending throttle across every account, kept for older readers
   * that predate per-account windows: "something is throttled" stays true.
   */
  throttledUntil: number | null;
  /** Every account currently told to come back later, with when. */
  throttledAccounts: { accountId: string; until: number }[];
  grants: ScopeGrant[];
  entries: QueueEntry[];
  /** Whether cross-run scope conflicts currently block admission. */
  guard: boolean;
  /**
   * The boarding schedule's answer at snapshot time, or null when no policy is
   * set. Reported even when OPEN: a console with a schedule and nothing queued
   * should still be able to say what its schedule currently thinks, or the only
   * way to find out is to have a phase fail to start.
   */
  schedule?: { open: boolean; opensAt: number | null; reason: string | null } | null;
};

/** Thrown into a pending `admit()` when the run it belonged to was stopped. */
export class AdmissionAborted extends Error {
  constructor(slug: string, phase: number | null) {
    super(`admission for ${slug}${phase == null ? '' : ` phase ${phase}`} was cancelled`);
    this.name = 'AdmissionAborted';
  }
}

/**
 * Thrown into a pending `admit()` when the phase has queued behind a foreign
 * lock for longer than `LOCK_WAIT_CAP_MS`.
 *
 * A separate class from `AdmissionAborted` because the two mean opposite
 * things to the caller: aborted is "the run stopped, nothing is owed an
 * explanation and the phase stays startable"; capped is "this phase waited two
 * hours for somebody else's claim and has been PARKED, with the holder named".
 * They were one class for exactly as long as the cap did not work.
 */
export class AdmissionCapped extends AdmissionAborted {
  /** How long the phase had been queued when the cap fired. */
  readonly waitedMs: number;

  // An explicit field, not a parameter property: the server runs TypeScript
  // through Node's strip-only mode, which refuses `public readonly x` in a
  // constructor signature (it would have to EMIT an assignment, and stripping
  // never emits).
  constructor(slug: string, phase: number | null, waitedMs: number) {
    // A SUBCLASS of AdmissionAborted since 2026-08-30 (R7). It extended `Error`
    // for exactly as long as the cap could not fire on the recovery path: the
    // recovery catches `AdmissionAborted` and rethrows anything else, `recover()`
    // stores `runRecovery()` with a `.finally` and no `.catch`, so a cap thrown
    // into a recovery's admission became an UNHANDLED REJECTION — the run kept
    // claiming `running`, and the watch-landed resume's `.then` ran against it
    // and did nothing. Aborted is still the honest supertype ("this admission
    // will not be granted"); the distinct class is still what tells the caller
    // it was OUR cap and not the operator's stop, and `instanceof` answers both
    // questions now instead of one.
    super(slug, phase);
    this.message = `admission for ${slug}${phase == null ? '' : ` phase ${phase}`} hit the lock-wait cap`;
    this.name = 'AdmissionCapped';
    this.waitedMs = waitedMs;
  }
}

/**
 * May this blocker's wait be capped into a park?
 *
 * The two-hour lock-wait cap exists for ONE shape: a claim nobody is behind —
 * a lock left by a session that died, whose lease has not lapsed yet. Every
 * other blocker is a wait that ends by itself, and parking the waiter for it is
 * the console punishing its own policy:
 *
 *   - a `clock` holder (the boarding window, the live-session cap, a usage
 *     window) ends at a moment that is already known;
 *   - a `grant` or `reserved` holder is a SIBLING LANE of this console. It is
 *     pipelining, not contention: the lane finishes, releases, and the waiter
 *     boards. D2 brought these under the cap so a HUNG sibling could not hold a
 *     run forever — and the cure was worse, because a healthy sibling that
 *     simply takes three hours parked its waiter at two;
 *   - a lock whose session the registry reports LIVE is a person (or another
 *     console) working right now. Their lease is not a deadline for them.
 *
 * A hung sibling is still bounded — by the lane's own liveness watchdog and the
 * grant's lease, both of which act on the hung lane rather than on the innocent
 * one waiting behind it.
 */
export function isCappableBlocker(holder: Holder): boolean {
  if (holder.clock) return false;
  if (holder.kind !== 'lock') return false;
  return holder.presence !== 'live';
}

/** How a run's own locks are owned, so the scheduler never blocks on itself. */
export function autopilotOwner(runId: string): string {
  return `autopilot/${runId}`;
}

/** The run id an autopilot-owned lock names, or null for any other owner. */
export function autopilotRunId(owner: string): string | null {
  const m = /^autopilot\/([0-9a-f]{8})$/.exec(owner);
  return m ? m[1] : null;
}

/**
 * Locks held by autopilot owners whose runs are known to be dead — DEBRIS.
 *
 * A run's lanes claim `autopilot/<runId>` and release on their way out; a
 * console that dies mid-lane leaves the claim behind, unexpired for up to the
 * lease, and every other actor — this console's own queue included — waits on
 * a holder that will never release. The queue already skips LAPSED locks by
 * the clock; this is the other half: a claim whose owner is a run nobody is
 * driving is free the moment that is known, lease or no lease. Only OWN-shaped
 * owners are ever considered — a person's or another console's claim is never
 * debris to us, however dead it looks. The convergence loop (`converge.ts`)
 * releases what this names, through the runner's own release semantics.
 */
export function debrisLocks(locks: readonly LockView[], deadRunIds: ReadonlySet<string>): LockView[] {
  return locks.filter((lock) => {
    const runId = autopilotRunId(lock.owner);
    return runId !== null && deadRunIds.has(runId);
  });
}

type Waiting = QueueEntry & {
  resolve: (grant: ScopeGrant) => void;
  reject: (error: Error) => void;
  /** Removes the abort listener; called on every exit path. */
  detach: () => void;
  settled: boolean;
  /**
   * The bump counter at the moment this entry was bumped, or absent.
   *
   * A monotone stamp rather than a boolean so a second bump orders in front of
   * the first — "front of its class" has to mean something when two entries
   * both claim it, and the later instruction is the one the operator meant.
   */
  bumpedAt?: number;
};

export class Scheduler {
  private deps: SchedulerDeps;
  private grants = new Map<string, ScopeGrant>();
  private queue: Waiting[] = [];
  /**
   * Per-ACCOUNT "come back at" marks — DERIVED, never stored here.
   *
   * This was a `Map<accountId, untilMs>`, and it was the second copy of a fact
   * the account registry already keeps and persists. Both were written from the
   * same event (`runner.ts`'s `wait-until` calls `onAccountLimited` and
   * `throttle` on adjacent lines), so they agreed at birth and diverged
   * afterwards: the registry's copy survives a restart and the scheduler's did
   * not, so after every restart the admission gate believed nothing was
   * throttled while the meters, the pre-flight and `pickAccount` all knew
   * better — and the first entry admitted spent a session rediscovering the
   * wall. Reads go through `walls`; `throttle()` is the write verb, and it
   * writes THROUGH.
   */
  private readonly walls: AccountWalls;
  private throttleTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  /** Armed at the soonest lease expiry among blocking locks. See `armLockTimer`. */
  private lockTimer: NodeJS.Timeout | null = null;
  /** Armed at the boarding window's next opening. See `armScheduleTimer`. */
  private scheduleTimer: NodeJS.Timeout | null = null;
  /** Monotone, so two bumps order against each other. See `Waiting.bumpedAt`. */
  private bumpSeq = 0;
  private closed = false;

  constructor(deps: SchedulerDeps = {}) {
    this.deps = deps;
    this.walls = deps.accountWalls ?? new MemoryWalls();
    this.armIdleTimer();
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  /**
   * When this account is next usable, or null for "not walled".
   *
   * The LAST live window to reset, not the first. An account with a `five_hour`
   * wall to 18:00 and a `seven_day_opus` wall to 12:00 is not admissible at
   * 12:01 — it is admissible at 18:01. Taking the minimum would release it
   * early and spend a session proving it; the maximum is also exactly what the
   * scalar this replaced did, since `throttle()` only ever moved that number
   * further out.
   *
   * (Model-blind, deliberately, and as before: `seven_day_opus` disqualifies
   * only an opus run, but that distinction is `Accounts.rankAccounts`'s — it
   * already makes it, per family — and the admission gate never had it.)
   *
   * `nowMs` is passed down rather than left to `Date.now()` inside the walls:
   * this class runs on an injectable clock, and a derived read that consulted
   * the wall clock instead would answer a different question than every other
   * line in the same scan.
   */
  private walledUntil(accountId: string): number | null {
    const at = Object.values(this.walls.limitedUntil(accountId, this.now()))
      .map((iso) => Date.parse(iso))
      .filter((ms) => Number.isFinite(ms));
    return at.length ? Math.max(...at) : null;
  }

  /**
   * The boarding schedule's answer right now, or null when there is no policy.
   *
   * One call site's worth of coercion lives here rather than in three: the dep
   * may be absent, may throw (it reads preferences off disk in the real
   * console), and may return a policy that says nothing. All three mean the
   * same thing — no schedule — and a schedule that threw must never be read as
   * a schedule that is CLOSED, which would stop every run on a bad config file.
   */
  private scheduleNow(): { open: boolean; opensAt: number | null; reason: string | null } | null {
    if (!this.deps.schedule) return null;
    let policy: SchedulePolicy | undefined;
    try { policy = this.deps.schedule(); } catch { return null; }
    if (!policy) return null;
    return scheduleState(policy, this.now());
  }

  /**
   * The holder that says "this console does not start phases at this hour", or
   * null. A pseudo-holder like the usage-window throttle, so the queue page
   * renders it in the vocabulary it already has — and, like the throttle, it is
   * a SKIP rather than a stop and never ages into `reserving`: the entry is
   * blocked by a clock, not by scope contention, and reserving its tokens would
   * hold a checkout against work that could legitimately run.
   */
  /**
   * The holder that says "the operator froze this console", or null.
   *
   * A pseudo-holder like the boarding window and the hold, and `clock: true`
   * for the same reason both of those are: the runner's two-hour admission cap
   * must never park a phase for obeying an instruction the operator gave it.
   *
   * Two differences from every other holder, and both are the point:
   *
   *  - **No `kind: 'recovery'` exemption.** See `SchedulerDeps.fleetHold`.
   *  - **It is checked before the boarding window**, which is otherwise the
   *    first thing in both scans. When several clocks are against a phase the
   *    most useful sentence is the one nearest the operator's hand, and nothing
   *    is nearer than the button they pressed thirty seconds ago.
   *
   * Like the other two it makes an entry SKIP and never lets it age into
   * `reserving`: a frozen fleet reserving tokens would hold every checkout in
   * the console against work that could legitimately start the moment it thaws,
   * and the thaw would then have to unwind reservations nobody asked for.
   */
  private fleetHolder(): Holder | null {
    let hold: { at: string; by?: string } | null | undefined;
    try { hold = this.deps.fleetHold?.(); } catch { return null; }
    if (!hold) return null;
    return {
      kind: 'reserved', slug: FLEET_HOLDER, phase: null, clock: true,
      owner: fleetFreezeReason(hold.by), scope: ['all'], overlaps: ['all'],
    };
  }

  private scheduleHolder(entry: Pick<Waiting, 'kind'>): Holder | null {
    if (entry.kind === 'recovery') return null;
    const state = this.scheduleNow();
    if (!state || state.open) return null;
    return {
      kind: 'reserved', slug: 'boarding window', phase: null, clock: true,
      owner: state.reason ?? 'outside the boarding schedule',
      scope: ['all'], overlaps: ['all'],
    };
  }

  /**
   * The holder that says "the operator held this run", or null.
   *
   * A pseudo-holder like the boarding window, and `clock: true` for the same
   * reason the boarding window is: the runner's two-hour admission cap must
   * never park a phase for obeying an instruction the operator gave it. A held
   * plan that came back to a parked phase would be the console punishing its
   * own policy — D2's sentence, and the same argument applies verbatim.
   *
   * Unlike the boarding window it does not end at a moment that is known, and
   * that is exactly why it names WHO: an operator reading the queue page needs
   * to know it is a person's hold and not a clock they can wait out.
   */
  private holdHolder(entry: Pick<Waiting, 'slug' | 'runId'>): Holder | null {
    let hold: { at: string; by?: string } | null | undefined;
    try { hold = this.deps.holdFor?.(entry.slug, entry.runId); } catch { return null; }
    if (!hold) return null;
    return {
      kind: 'reserved', slug: HOLD_HOLDER, phase: null, clock: true,
      owner: holdReason(hold.by), scope: ['all'], overlaps: ['all'],
    };
  }

  /** The holder that says "this run begins after another plan", or null. */
  private chainHolder(entry: Pick<Waiting, 'slug' | 'runId'>): Holder | null {
    let after: string | null | undefined;
    try { after = this.deps.chainBlocker?.(entry.slug, entry.runId); } catch { return null; }
    if (!after) return null;
    return {
      kind: 'reserved', slug: CHAIN_HOLDER, phase: null, clock: true,
      owner: chainReason(after), scope: ['all'], overlaps: ['all'],
    };
  }

  /** Every walled account right now, soonest reopening first. */
  private walledAccounts(): { accountId: string; until: number }[] {
    const out: { accountId: string; until: number }[] = [];
    for (const accountId of this.walls.accountIds()) {
      const until = this.walledUntil(accountId);
      if (until !== null && until > this.now()) out.push({ accountId, until });
    }
    return out.sort((a, b) => a.until - b.until);
  }

  private maxLive(): number {
    const max = typeof this.deps.max === 'function' ? this.deps.max() : this.deps.max;
    return Math.max(1, max ?? DEFAULT_MAX_SESSIONS);
  }

  /* ---------------------------------------------------------------- *
   * Admission
   * ---------------------------------------------------------------- */

  /**
   * Ask to run. Resolves with a grant the caller must `release`, or rejects if
   * the run was stopped while it waited.
   *
   * Never resolves synchronously even when the scope is clear: a caller that
   * sometimes continues in the same tick and sometimes does not is a caller
   * with two control flows, and the second one is the one nobody tests.
   */
  admit(request: AdmitRequest): Promise<ScopeGrant> {
    if (this.closed) return Promise.reject(new AdmissionAborted(request.slug, request.phase));
    const scope = request.scope.length ? [...request.scope] : ['all'];

    return new Promise<ScopeGrant>((resolve, reject) => {
      const entry: Waiting = {
        id: randomUUID().slice(0, 8),
        slug: request.slug,
        phase: request.phase,
        runId: request.runId,
        scope,
        // Stored as an omission when unstated, like `accountId` and `kind`: an
        // empty-string branch and an absent one must never be two things, and
        // `claimsDisjoint` already reads both as unqualified.
        ...(request.branch ? { branch: request.branch } : {}),
        ...(request.tree ? { tree: request.tree } : {}),
        ...(request.accountId ? { accountId: request.accountId } : {}),
        ...(request.kind ? { kind: request.kind } : {}),
        // `normal` is stored as an omission here too, so `scanOrder`'s class
        // key is constant across a queue nobody has prioritised and the sort
        // degenerates to the FIFO it has always been.
        ...(request.priority && request.priority !== DEFAULT_PRIORITY
          ? { priority: request.priority } : {}),
        since: this.now(),
        waitingOn: [],
        bypassed: 0,
        reserving: false,
        resolve,
        reject,
        detach: () => {},
        settled: false,
      };

      const signal = request.signal;
      if (signal) {
        if (signal.aborted) {
          reject(new AdmissionAborted(entry.slug, entry.phase));
          return;
        }
        const onAbort = (): void => this.cancel(entry);
        signal.addEventListener('abort', onAbort, { once: true });
        entry.detach = () => signal.removeEventListener('abort', onAbort);
      }

      this.queue.push(entry);
      // A tick later, so the caller's promise exists before it can settle.
      queueMicrotask(() => this.poll());
    });
  }

  /**
   * Would this request have to wait — asked without joining the queue.
   *
   * The same scan `poll` runs, so the two cannot disagree. It exists because
   * "queued" has to be *observable*: `admit()` resolves asynchronously either
   * way, so without asking first, a run blocked behind another plan spends its
   * whole wait reading `running` and the operator is left watching a phase
   * that never starts with nothing anywhere saying why.
   */
  wouldBlock(request: AdmitRequest): Holder[] {
    // The fleet freeze leads everything, in both scans. It is the only holder
    // with no exemptions at all, so anything ahead of it would be a way for
    // some OTHER reason to be reported while the console is switched off — and
    // the operator would read the queue page looking for the freeze they just
    // pressed and not find it.
    const fleet = this.fleetHolder();
    if (fleet) return [fleet];
    // The schedule leads the rest, and does so in both scans for the same reason it
    // leads in `poll`: it is the console's own statement about this hour, so
    // when several clocks are against a phase at once, the one the operator set
    // is the one worth reading first.
    const schedule = this.scheduleHolder({ kind: request.kind });
    if (schedule) return [schedule];
    // Both in the same order `poll` checks them, and for the reason the two
    // scans share one `blocking()`: a `wouldBlock` that did not know about
    // holds would tell the runner an admission was free, the runner would skip
    // the `phase.queued` journal line and the badge with it, and the phase
    // would then sit in `admit()` with nothing anywhere saying it was held.
    const held = this.holdHolder({ slug: request.slug, runId: request.runId });
    if (held) return [held];
    const chained = this.chainHolder({ slug: request.slug, runId: request.runId });
    if (chained) return [chained];
    const throttle = this.throttleFor(request.accountId);
    if (throttle) return [throttle];
    // D28: the session cap is NOT a clock, and it no longer short-circuits.
    //
    // Two defects in one early return. It was marked `clock: true` beside the
    // boarding window and the usage window — but those END at a moment already
    // known, and this one ends when some other lane happens to release, which
    // in the shape that matters (a hung lane holding a grant forever) is never.
    // The runner excludes `clock` holders from the two-hour cap precisely
    // because capping a wait on a known moment would park a phase for obeying
    // policy; excluding THIS one meant a saturated fleet with one wedged lane
    // waited without bound, no `lockWaitSince` stamped, nothing anywhere able
    // to say how long. So the cap is an honest holder: capped like a grant.
    //
    // And it is composed with the holder scan rather than returned instead of
    // it, because at `maxSessions` both can be true at once — being third in
    // line for a lane AND behind a foreign lock on your checkout are different
    // waits with different endings, and reporting only the first taught the
    // queue page to lose the second the moment the fleet got busy.
    const cap: Holder | null = this.grants.size >= this.maxLive()
      ? {
        kind: 'reserved', slug: 'session cap', phase: null,
        owner: `${this.maxLive()} of ${this.maxLive()} lanes`, scope: ['all'], overlaps: ['all'],
      }
      : null;
    const probe: Waiting = {
      id: '', slug: request.slug, phase: request.phase, runId: request.runId,
      scope: request.scope.length ? request.scope : ['all'],
      ...(request.branch ? { branch: request.branch } : {}),
      ...(request.tree ? { tree: request.tree } : {}),
      ...(request.accountId ? { accountId: request.accountId } : {}),
      ...(request.kind ? { kind: request.kind } : {}),
      since: this.now(), waitingOn: [], bypassed: 0, reserving: false,
      resolve: () => {}, reject: () => {}, detach: () => {}, settled: false,
    };
    const holders = this.blocking(probe, this.queue.filter((entry) => entry.reserving));
    return cap ? [cap, ...holders] : holders;
  }

  /**
   * The holder that says "this ACCOUNT was told to come back later", or null.
   * Phrased as a reserved pseudo-holder so the queue page renders it with the
   * same vocabulary as every other reason to wait.
   */
  private throttleFor(accountId: string | undefined): Holder | null {
    const key = accountId ?? 'default';
    const until = this.walledUntil(key);
    if (until === null || until <= this.now()) return null;
    return {
      kind: 'reserved', slug: 'usage window', phase: null, clock: true,
      owner: key === 'default' ? 'the account' : `account ${key}`,
      scope: ['all'], overlaps: ['all'],
    };
  }

  /**
   * Cross-run holders sharing tokens with this request RIGHT NOW — grants of
   * other runs, and locks this console never issued. Never queues, and never
   * consults the guard: this is the honesty probe that lets a prompt say "you
   * are sharing a checkout with someone" even when the guard was turned off,
   * or when a foreign lock appeared after admission.
   *
   * Branch-aware for the same reason admission is, and it MUST be: this probe
   * is what puts the DIY caution in a session's prompt, and firing it between
   * two console-managed trees on two branches would warn about a collision the
   * scheduler had just decided did not exist. The rule lives in `conflictsFor`,
   * which this delegates to — one implementation, two callers.
   */
  overlapsFor(request: AdmitRequest): Holder[] {
    const probe: Waiting = {
      id: '', slug: request.slug, phase: request.phase, runId: request.runId,
      scope: request.scope.length ? request.scope : ['all'],
      ...(request.branch ? { branch: request.branch } : {}),
      ...(request.tree ? { tree: request.tree } : {}),
      since: this.now(), waitingOn: [], bypassed: 0, reserving: false,
      resolve: () => {}, reject: () => {}, detach: () => {}, settled: false,
    };
    const own = autopilotOwner(request.runId);
    return this.conflictsFor(probe, []).filter((holder) => holder.owner !== own);
  }

  /** Hand a grant back. The only thing that lets the queue move on its own. */
  release(grant: ScopeGrant | null | undefined): void {
    if (!grant) return;
    if (!this.grants.delete(grant.id)) return;
    this.poll();
  }

  /**
   * Everything a run holds or is waiting for, dropped at once.
   *
   * A run that ends with a lane still granted — a crash inside `drive`, a
   * shutdown mid-phase — would otherwise hold its scope against every other
   * plan until the process died. The grant is bookkeeping, not a resource: the
   * only thing that made it real was the loop, and the loop is gone.
   */
  releaseRun(runId: string): void {
    for (const [id, grant] of [...this.grants]) {
      if (grant.runId !== runId) continue;
      this.grants.delete(id);
    }
    for (const entry of [...this.queue]) {
      if (entry.runId !== runId) continue;
      this.cancel(entry, false);
    }
    // Unconditional — this is also the SETTLE LISTENER `startAfter` needs.
    //
    // It used to be `if (touched)`, which was right when the only reason to
    // re-scan was that this run had freed something of its own. A chained
    // entry waits on the run's STATUS instead, and a run can settle holding
    // neither a grant nor a queue entry (it parked before it ever boarded) —
    // precisely the case where somebody downstream has been waiting longest.
    // `poll` is idempotent and announces only when the scan moved something,
    // so the unguarded call emits exactly what the guarded one did.
    this.poll();
  }

  /**
   * Everything this run is WAITING for, dropped — and nothing it holds.
   *
   * `releaseRun`'s narrower half, and the difference is the whole point. That
   * one belongs to the loop ending: the grants were only ever real because the
   * loop was, so both go. This one belongs to a run that has decided to stop at
   * a boundary it has not reached yet — the phase in flight keeps its scope
   * until it finishes, which is exactly what "finish this phase, then stop"
   * means, while the phases still queued behind it are already cancelled and
   * only the queue does not know it.
   *
   * Announced explicitly rather than left to `poll`, which announces only when
   * the scan MOVED something: a withdrawal that frees nothing for anyone else
   * still changes what the queue page must show.
   *
   * Returns how many entries were withdrawn.
   */
  withdrawRun(runId: string): number {
    let withdrawn = 0;
    for (const entry of [...this.queue]) {
      if (entry.runId !== runId) continue;
      this.cancel(entry, false);
      withdrawn++;
    }
    if (withdrawn) {
      this.announce();
      // Somebody else may have been queued behind exactly these.
      this.poll();
    }
    return withdrawn;
  }

  /**
   * Admit nothing FOR THIS ACCOUNT until this moment passes.
   *
   * The usage window is an account-wide fact, not a per-run one: when one
   * session is told to come back at 4pm, every other session on the same
   * account would be told the same thing one turn later, each spending a turn
   * to find out. `wait-until` calls this so the rest of that account's fleet
   * waits quietly rather than discovering it the expensive way — while a run
   * paying with a DIFFERENT account is exactly the run that should keep going.
   */
  throttle(untilMs: number, accountId = 'default', bucket = LEARNED_WALL_BUCKET): void {
    if (!Number.isFinite(untilMs) || untilMs <= this.now()) return;
    // Per BUCKET, not per account: a window never gets shorter, but a second,
    // different window is news and must be recorded. The old scalar could only
    // express one wall per account, so learning about `seven_day` threw away
    // what was known about `five_hour`.
    const current = Date.parse(this.walls.limitedUntil(accountId, this.now())[bucket] ?? '');
    if (Number.isFinite(current) && current >= untilMs) return;
    // Write THROUGH to the one store. The runner's `wait-until` passes the real
    // window name, so this lands on the same key `onAccountLimited` writes and
    // the two are one record rather than two that happen to agree.
    this.walls.markLimited(accountId, bucket, new Date(untilMs).toISOString());
    log.info('scheduler.throttled', { account: accountId, bucket, until: new Date(untilMs).toISOString() });
    this.armThrottleTimer();
    this.announce();
  }

  /** Re-run the scan. Safe to call from anything that might have freed a scope. */
  poll(): void {
    if (this.closed) return;
    const now = this.now();

    // No pruning pass any more: `limitedUntil` drops a lapsed window on read,
    // so a reopened one admits on this very scan by construction rather than
    // because a loop above remembered to delete it.
    this.armThrottleTimer();

    // Once for the whole scan, not per entry: the marker is a file read, the
    // answer cannot change halfway down a synchronous loop, and a scan where
    // half the queue saw a freeze and half did not would be a queue page that
    // contradicts itself.
    const fleet = this.fleetHolder();

    let changed = false;
    /** Token sets held back by aged entries ahead in the queue. */
    const reserved: Waiting[] = [];
    /** Blocked entries already passed, so an admission can count its bypass. */
    const blocked: Waiting[] = [];

    for (const entry of this.scanOrder()) {
      if (entry.settled) continue;
      // The cap is a hard stop, not a skip: nothing further down can start
      // either, and scanning on would only mislabel the rest as scope-blocked.
      if (this.grants.size >= this.maxLive()) break;

      // A throttled ACCOUNT is a skip, not a stop — the old scalar returned
      // here, which was right when there was one account and would now let a
      // single limited login stall every other account's queue. The entry is
      // labeled with why it waits, and deliberately never ages into
      // `reserving`: its blockage is a clock, not scope contention, and a
      // reserving throttled entry would hold its tokens against runs that
      // could pay.
      // The fleet freeze, ahead of every other reason and with no exemption of
      // any kind — a `recovery` entry is skipped here exactly like an ordinary
      // one. A skip rather than a `break`, so EVERY waiting entry is labelled
      // with the freeze: the operator who froze the console wants to see the
      // whole queue saying so, not the first line of it.
      if (fleet) {
        entry.waitingOn = [fleet];
        continue;
      }

      // Outside the operator's boarding schedule: a skip for exactly the same
      // reasons the throttle below is one — the entry waits on a clock rather
      // than on scope, so it is labelled with why and never allowed to age into
      // `reserving`. Checked FIRST among the clocks because when several are
      // against a phase, the console's own policy is the more useful sentence.
      const window = this.scheduleHolder(entry);
      if (window) {
        entry.waitingOn = [window];
        continue;
      }

      // A HELD run and a CHAINED one are skips for the same reasons the two
      // clocks below and above are: the entry is blocked by a decision, not by
      // scope contention, so it is labelled with why and never allowed to age
      // into `reserving`. A held entry that reserved would hold its checkout
      // against every run that could legitimately use it — the operator asked
      // for their plan to stand aside, not to become an obstacle.
      const held = this.holdHolder(entry);
      if (held) {
        entry.waitingOn = [held];
        continue;
      }

      const chained = this.chainHolder(entry);
      if (chained) {
        entry.waitingOn = [chained];
        continue;
      }

      const throttle = this.throttleFor(entry.accountId);
      if (throttle) {
        entry.waitingOn = [throttle];
        continue;
      }

      const holders = this.blocking(entry, reserved);
      if (holders.length) {
        entry.waitingOn = holders;
        blocked.push(entry);
        if (this.aging(entry, now)) {
          if (!entry.reserving) changed = true;
          entry.reserving = true;
          reserved.push(entry);
        }
        continue;
      }

      // Admitting this one means every blocked entry ahead of it that shares a
      // token has just been overtaken. Counted here — at the moment it happens
      // — because that is the only place the pair is known.
      //
      // Narrowed by branch like every other scope question here (P8/QA F-3),
      // and for the reason `bypassed` exists at all: it counts the entries this
      // admission actually got in FRONT of, and an entry that could have gone
      // at the same moment was not overtaken. Left un-narrowed, an isolated run
      // admitted beside another aged an entry it does not contend with — and
      // after `MAX_BYPASS` that entry reserves its tokens against everything
      // behind it, which switches the carve-out back off a few admissions later.
      for (const earlier of blocked) {
        if (!scopesIntersect(earlier.scope, entry.scope)) continue;
        if (claimsDisjoint(earlier, entry)) continue;
        earlier.bypassed++;
      }
      this.grant(entry);
      changed = true;
    }

    this.armLockTimer();
    this.armScheduleTimer();
    if (changed) this.announce();
  }

  /**
   * The order `poll` walks the queue in — priority class, then a bump, then
   * age. The ONLY thing priority changes.
   *
   * Three keys, most significant first:
   *
   *   1. **`reserving`** — an entry that has already aged out sorts ahead of
   *      everything, class included. This is what "aging is preserved verbatim
   *      ACROSS classes" means concretely: reservation works by an entry being
   *      seen BEFORE the ones it means to hold back, so a starved `low` scanned
   *      after every fresh `high` would reserve against nothing and starve
   *      exactly as it did before there was an aging rule. Bounded bypass has
   *      to outrank a preference or it is not a bound.
   *   2. **class, then bump** — `high` before `normal` before `low`
   *      (`priorityRank`), and within one class an operator's bump first.
   *   3. **queue position** — FIFO, unchanged, and the tiebreak for every
   *      group above. With no priorities and no bumps set anywhere, every key
   *      but this one is constant and the order is exactly the insertion order
   *      this scheduler has always used. That equivalence is pinned by a test.
   *
   * A fresh array each scan rather than a sorted queue: `this.queue`'s order is
   * arrival order and several things read it as such (`settle` splices by
   * identity, `snapshot` reports it). Sorting in place would make "the queue"
   * mean two things depending on when you looked.
   */
  private scanOrder(): Waiting[] {
    const position = new Map(this.queue.map((entry, index) => [entry, index]));
    return [...this.queue].sort((a, b) => {
      if (a.reserving !== b.reserving) return a.reserving ? -1 : 1;
      const byClass = priorityRank(a.priority) - priorityRank(b.priority);
      if (byClass !== 0) return byClass;
      // Most recently bumped first, so a second bump lands in front of the
      // first — an operator correcting themselves means the correction.
      const bump = (b.bumpedAt ?? 0) - (a.bumpedAt ?? 0);
      if (bump !== 0) return bump;
      return (position.get(a) ?? 0) - (position.get(b) ?? 0);
    });
  }

  /**
   * Move ONE queued entry to the front of its class.
   *
   * One-shot, in the only sense that is honest here: the mark lives on this
   * queue entry and dies with it. A bumped entry that is admitted, cancelled or
   * capped takes the mark with it, so the same phase queueing again later
   * starts from its class's FIFO tail — an operator bumps a wait they can see,
   * not a plan forever.
   *
   * It does not cross a class boundary, and that is deliberate rather than a
   * limitation: bumping a `low` entry past a `high` one would make the queue
   * page's two orderings disagree, and an operator who wants that has the
   * priority control that says so out loud.
   *
   * Returns whether an entry was found — a stale entry id from a page that has
   * been open a while is a 404, not a silent success.
   */
  bump(entryId: string): boolean {
    const entry = this.queue.find((candidate) => candidate.id === entryId && !candidate.settled);
    if (!entry) return false;
    this.bumpSeq += 1;
    entry.bumpedAt = this.bumpSeq;
    log.info('scheduler.bumped', { id: entry.id, slug: entry.slug, phase: entry.phase });
    this.poll();
    this.announce();
    return true;
  }

  /**
   * Move a live run's already-queued entries into a different class.
   *
   * The seed on `AdmitRequest` is the birth value, and without this a priority
   * raised while three phases sat in `admit()` would apply to none of them —
   * the operator's change would look accepted (the run file says `high`) and do
   * nothing until the next phase boarded, which is the shape of setting this
   * codebase keeps deciding not to have.
   */
  reprioritize(runId: string, priority: RunPriority): void {
    let touched = false;
    for (const entry of this.queue) {
      if (entry.runId !== runId || entry.settled) continue;
      const next = priority === DEFAULT_PRIORITY ? undefined : priority;
      if (entry.priority === next) continue;
      if (next) entry.priority = next; else delete entry.priority;
      touched = true;
    }
    if (!touched) return;
    this.poll();
    this.announce();
  }

  /** Everything the queue page and `state().concurrency` read. */
  snapshot(): SchedulerSnapshot {
    const throttledAccounts = this.walledAccounts();
    return {
      max: this.maxLive(),
      guard: this.deps.guard?.() ?? true,
      schedule: this.scheduleNow(),
      live: this.grants.size,
      queued: this.queue.filter((entry) => !entry.settled).length,
      throttledUntil: throttledAccounts[0]?.until ?? null,
      throttledAccounts,
      grants: [...this.grants.values()],
      entries: this.queue.filter((entry) => !entry.settled).map((entry) => this.entryView(entry)),
    };
  }

  /** One queue entry as the page sees it. See `snapshot`. */
  private entryView(entry: Waiting): QueueEntry {
    let held: { at: string; by?: string } | null | undefined;
    let after: string | null | undefined;
    try { held = this.deps.holdFor?.(entry.slug, entry.runId); } catch { held = null; }
    try { after = this.deps.chainBlocker?.(entry.slug, entry.runId); } catch { after = null; }
    return this.entryFields(entry, held ?? null, after ?? null);
  }

  private entryFields(
    entry: Waiting,
    held: { at: string; by?: string } | null,
    after: string | null,
  ): QueueEntry {
    return {
      id: entry.id,
      slug: entry.slug,
      phase: entry.phase,
      runId: entry.runId,
      scope: entry.scope,
      ...(entry.branch ? { branch: entry.branch } : {}),
      ...(entry.tree ? { tree: entry.tree } : {}),
      ...(entry.kind ? { kind: entry.kind } : {}),
      since: entry.since,
      waitingOn: entry.waitingOn,
      bypassed: entry.bypassed,
      reserving: entry.reserving,
      // Omitted at the default, like everywhere else this vocabulary is
      // written: a `normal`, unbumped, unheld, unchained entry serialises
      // byte-identically to one from before this feature existed, so an older
      // client reading this snapshot sees the queue it always saw.
      ...(entry.priority ? { priority: entry.priority } : {}),
      ...(entry.bumpedAt ? { bumped: true as const } : {}),
      // `held`/`after` are DERIVED at snapshot time rather than stored on the
      // entry: they are facts about the run and the fleet right now, and a
      // copy would be a second answer that goes stale the moment an operator
      // presses Release.
      ...(held ? { held } : {}),
      ...(after ? { after } : {}),
    };
  }

  /** Is anything of this run's already granted? Used by the same-slug guard. */
  granted(runId: string): ScopeGrant[] {
    return [...this.grants.values()].filter((grant) => grant.runId === runId);
  }

  /** The locks in this scheduler's view held by dead autopilot runs. See `debrisLocks`. */
  debris(deadRunIds: ReadonlySet<string>): LockView[] {
    return debrisLocks(this.deps.locks?.() ?? [], deadRunIds);
  }

  close(): void {
    this.closed = true;
    if (this.throttleTimer) clearTimeout(this.throttleTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.lockTimer) clearTimeout(this.lockTimer);
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    this.throttleTimer = null;
    this.idleTimer = null;
    this.lockTimer = null;
    this.scheduleTimer = null;
    for (const entry of [...this.queue]) this.cancel(entry, false);
    this.grants.clear();
  }

  /* ---------------------------------------------------------------- *
   * The conflict scan
   * ---------------------------------------------------------------- */

  /**
   * What actually blocks this entry, guard consulted. `poll` and `wouldBlock`
   * both come through here so they cannot disagree about what "queued" means.
   * With the guard off, the only holders that still block are the entry's own
   * run's — its other lanes and their reservations — because turning the guard
   * off is a statement about OTHER runs, not permission for one run to stack
   * two lanes into one checkout.
   *
   * …and, since D1, holders on the very SAME unit of work. The guard governs
   * disjoint-scope contention between DIFFERENT work; it was never a statement
   * that two actors may drive one slug+phase at once. With it off, a phase a
   * person had claimed by hand was admitted straight over their claim — the
   * runner journalled `phase.lock-ignored` and spawned a second session into
   * the same checkout on the same phase, which is the one collision the whole
   * lock exists to prevent. See `sameUnitOfWork`.
   */
  /**
   * The holder's plan's remaining work, as a spreadable `{ eta }` or nothing.
   *
   * Wrapped rather than called inline so a throwing dep can never take an
   * admission scan down with it: this is decoration, and decoration that can
   * stop the queue is worse than no decoration at all. An answer with neither
   * field is dropped, so "nothing is known" and "an empty object arrived" stay
   * the same fact on the wire.
   */
  private etaOf(slug: string): { eta?: HolderEta } {
    try {
      const eta = this.deps.etaFor?.(slug);
      if (!eta || (eta.remainingWeight == null && !eta.label)) return {};
      return { eta };
    } catch { return {}; }
  }

  private blocking(entry: Waiting, reserved: readonly Waiting[]): Holder[] {
    const holders = this.conflictsFor(entry, reserved);
    if (this.deps.guard?.() ?? true) return holders;
    const own = autopilotOwner(entry.runId);
    return holders.filter((holder) => holder.owner === own || sameUnitOfWork(holder, entry));
  }

  /**
   * Everything this entry collides with, or an empty list if it may start.
   *
   * Three sources, and all three matter: the grants this process handed out,
   * the locks on disk (which include sessions this console never started — a
   * human in a terminal, a bash worker), and the tokens reserved by aged
   * entries ahead of it.
   *
   * All three are narrowed by the BRANCH carve-out (`carvedOut` below), which
   * is what makes two isolated runs on one repository admissible together.
   */
  private conflictsFor(entry: Waiting, reserved: readonly Waiting[]): Holder[] {
    const holders: Holder[] = [];

    for (const grant of this.grants.values()) {
      if (grant.runId === entry.runId && grant.phase === entry.phase) continue;
      if (!scopesIntersect(grant.scope, entry.scope)) continue;
      if (this.carvedOut(grant, entry)) continue;
      holders.push({
        kind: 'grant',
        slug: grant.slug,
        phase: grant.phase,
        owner: autopilotOwner(grant.runId),
        scope: grant.scope,
        ...(grant.branch ? { branch: grant.branch } : {}),
        ...(grant.tree ? { tree: grant.tree } : {}),
        overlaps: intersectingTokens(grant.scope, entry.scope),
        ...this.etaOf(grant.slug),
      });
    }

    const own = autopilotOwner(entry.runId);
    for (const lock of this.locksFor(entry)) {
      if (lockLapsed(lock, this.now(), this.presenceOf(lock))) continue;
      // Our own run's locks. Its other lanes claimed them, and the grants above
      // already speak for those.
      if (lock.owner === own) continue;
      // A foreign lock on the very slug+phase being requested blocks like any
      // other. This used to be carved out ("the boarding belt-check parks on
      // it with the holder's name") — and the park was TERMINAL: parked is a
      // settled status, so a phase somebody was working by hand never boarded
      // again for the life of the run. Queueing is not a silent wait any
      // more: the holder is named on the queue page with its lease end, the
      // lock timer wakes the scan when the lease lapses, the docs watcher
      // wakes it when the lock file changes, and the runner's own lock-wait
      // cap turns a wait that outlives all of that into an honest park.

      const scope = this.scopeOfLock(lock);
      if (!scopesIntersect(scope, entry.scope)) continue;
      if (this.carvedOut(lock, entry)) continue;
      const presence = this.presenceOf(lock);
      holders.push({
        kind: 'lock',
        slug: lock.slug,
        phase: lock.phase,
        owner: lock.owner,
        scope,
        ...(lock.branch ? { branch: lock.branch } : {}),
        ...(lock.tree ? { tree: lock.tree } : {}),
        overlaps: intersectingTokens(scope, entry.scope),
        ...this.etaOf(lock.slug),
        ...(lock.leaseUntil != null ? { leaseUntil: lock.leaseUntil } : {}),
        ...(lock.session ? { session: lock.session } : {}),
        ...(presence === 'live' ? { presence } : {}),
      });
    }

    for (const ahead of reserved) {
      if (ahead.id === entry.id) continue;
      if (!scopesIntersect(ahead.scope, entry.scope)) continue;
      if (this.carvedOut(ahead, entry)) continue;
      holders.push({
        kind: 'reserved',
        slug: ahead.slug,
        phase: ahead.phase,
        owner: autopilotOwner(ahead.runId),
        scope: ahead.scope,
        ...(ahead.branch ? { branch: ahead.branch } : {}),
        ...(ahead.tree ? { tree: ahead.tree } : {}),
        overlaps: intersectingTokens(ahead.scope, entry.scope),
        ...this.etaOf(ahead.slug),
      });
    }

    return holders;
  }

  /**
   * Do these two intersecting claims nevertheless not contend, because each
   * rides a branch AND a working tree of its own?
   *
   * THE carve-out, in one place so the three holder sources cannot drift apart.
   * The rule itself lives once per language and is imported, never restated —
   * `claimsDisjoint` here, `claim_disjoint` in `scripts/scope.sh`: *both
   * claims declare a branch and the branches differ, AND both declare a tree
   * and the trees differ ⇒ disjoint.* An unqualified claim on either side, in
   * either dimension, collides with everything — so a fleet with no isolated
   * runs behaves exactly as it did before this existed, and two shared-root
   * runs on different branches still contend, because one directory is one
   * directory whatever its refs are called.
   *
   * 🔴 The same-unit-of-work rule OUTRANKS it, absolutely and with no setting
   * that changes that. Two sessions on one slug+phase write the same handoff
   * and take the same lock, and no arrangement of checkouts makes that safe —
   * a branch is a statement about where commits land, not about who owns a
   * phase. The guard already refuses to be turned off for this case
   * (`sameUnitOfWork` in `blocking`); this is the same wall from the other
   * side, so a run that gave itself a branch cannot walk past a claim the
   * operator would need a `--force` to take by hand.
   */
  private carvedOut(
    holder: { slug: string; phase: number | null; branch?: string; tree?: string },
    entry: Waiting,
  ): boolean {
    if (sameUnitOfWork(holder, entry)) return false;
    return claimsDisjoint(holder, entry);
  }

  /**
   * Every lock the scan weighs for one entry: the store's view, with the
   * entry's own phase read live off disk (`liveLock`) REPLACING whatever the
   * store holds for that slug+phase. The store is a watcher-debounced memory
   * of the files; for the one lock that matters most to this entry the file
   * itself is asked, and the file wins — a row the store has is as likely to
   * be stale as a row it lacks (see `SchedulerDeps.liveLock`). No file, or no
   * live read at all, leaves the store's row standing.
   */
  private locksFor(entry: Waiting): LockView[] {
    const stored = [...(this.deps.locks?.() ?? [])];
    if (entry.phase == null || !this.deps.liveLock) return stored;
    const key = `${entry.slug}:${entry.phase}`;
    let live: LockView | null | undefined;
    try { live = this.deps.liveLock(entry.slug, entry.phase); } catch { live = null; }
    if (!live) return stored;
    return [...stored.filter((lock) => `${lock.slug}:${lock.phase}` !== key), live];
  }

  /** The registry's word on the lock's session; `unknown` when it has none. */
  private presenceOf(lock: LockView): Presence {
    if (!lock.session || !this.deps.presence) return 'unknown';
    try { return this.deps.presence(lock); } catch { return 'unknown'; }
  }

  /**
   * What a lock covers. See `SchedulerDeps.scopeFor` for why a scopeless lock
   * is recovered from the plan rather than read as `all` outright.
   */
  private scopeOfLock(lock: LockView): string[] {
    if (lock.scope?.length) return lock.scope;
    const declared = this.deps.scopeFor?.(lock.slug, lock.phase);
    return declared?.length ? declared : ['all'];
  }

  private aging(entry: Waiting, now: number): boolean {
    return entry.bypassed >= MAX_BYPASS || now - entry.since >= AGING_MS;
  }

  /* ---------------------------------------------------------------- *
   * Bookkeeping
   * ---------------------------------------------------------------- */

  private grant(entry: Waiting): void {
    const grant: ScopeGrant = {
      id: entry.id,
      slug: entry.slug,
      phase: entry.phase,
      runId: entry.runId,
      scope: entry.scope,
      ...(entry.branch ? { branch: entry.branch } : {}),
      ...(entry.tree ? { tree: entry.tree } : {}),
      at: this.now(),
    };
    this.grants.set(grant.id, grant);
    this.settle(entry);
    log.info('scheduler.admitted', {
      slug: entry.slug, phase: entry.phase, runId: entry.runId,
      scope: formatScope(entry.scope), waitedMs: this.now() - entry.since,
    });
    entry.resolve(grant);
  }

  private cancel(entry: Waiting, announce = true): void {
    if (entry.settled) return;
    this.settle(entry);
    entry.reject(new AdmissionAborted(entry.slug, entry.phase));
    if (announce) this.announce();
  }

  private settle(entry: Waiting): void {
    entry.settled = true;
    entry.detach();
    const at = this.queue.indexOf(entry);
    if (at >= 0) this.queue.splice(at, 1);
  }

  private announce(): void {
    try { this.deps.onChange?.(this.snapshot()); } catch { /* the UI must never break admission */ }
  }

  /**
   * Wake at the SOONEST wall expiry. `poll()` re-arms for the next one, so
   * several accounts with different resets each get their scan the moment their
   * own window reopens.
   */
  private armThrottleTimer(): void {
    // Cleared and re-armed unconditionally, the shape `armLockTimer` uses two
    // methods below — and for the same reason. Returning early "because a
    // timer is already pending" meant the scheduler only ever woke at the
    // throttle that happened to be armed FIRST: account A walled until 18:00
    // arms the timer, then account B hits a five-hour wall that reopens at
    // 15:30, and B's entries are correctly skipped by `throttleFor` but
    // nothing wakes at 15:30 to admit them. They wait until 18:00 — or until
    // some unrelated event pokes the queue — on a window that reopened two
    // and a half hours earlier. `walledAccounts()` is sorted, so re-arming
    // always lands on the soonest.
    if (this.throttleTimer) { clearTimeout(this.throttleTimer); this.throttleTimer = null; }
    const walled = this.walledAccounts();
    if (this.closed || !walled.length) return;
    const delay = Math.max(0, walled[0]!.until - this.now());
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      this.poll();
    }, delay);
    this.throttleTimer.unref?.();
  }

  /**
   * Wake at the SOONEST lease expiry among the locks currently blocking the
   * queue. A foreign on-disk lock is the one holder whose release this
   * process may never hear about — the holder is a manual session, another
   * console, another machine — but the lease is its promise to lapse, and
   * this timer turns that promise into an admission the moment it does,
   * instead of a wait for the idle poll or an unrelated docs event. Re-armed
   * on every poll because the blocking set changes under it.
   */
  private armLockTimer(): void {
    if (this.lockTimer) { clearTimeout(this.lockTimer); this.lockTimer = null; }
    if (this.closed) return;
    let soonest = Infinity;
    for (const entry of this.queue) {
      if (entry.settled) continue;
      for (const holder of entry.waitingOn) {
        if (holder.kind !== 'lock' || holder.leaseUntil == null) continue;
        if (holder.leaseUntil < soonest) soonest = holder.leaseUntil;
      }
    }
    if (!Number.isFinite(soonest)) return;
    const delay = Math.max(0, soonest - this.now());
    this.lockTimer = setTimeout(() => {
      this.lockTimer = null;
      this.poll();
    }, delay);
    this.lockTimer.unref?.();
  }

  /**
   * Wake when the boarding window opens.
   *
   * Without it a run that queued at 22:00 would sit until the next idle poll —
   * up to a minute — which is harmless, and then until the poll AFTER the one
   * that happens to straddle the boundary, which is not: the idle poll is the
   * only other thing looking, and a schedule is precisely the case where
   * nothing else is going to happen for hours. `opensAt` may be null (a monthly
   * cron is past the eight-day scan); the idle poll is the honest fallback
   * there, and no timer is armed rather than one at a made-up time.
   */
  private armScheduleTimer(): void {
    if (this.scheduleTimer) { clearTimeout(this.scheduleTimer); this.scheduleTimer = null; }
    if (this.closed) return;
    // Only when something is actually waiting on it: arming a timer for a
    // window nobody is queued for would wake an idle console every night.
    if (!this.queue.some((entry) => !entry.settled
      && entry.waitingOn.some((holder) => holder.slug === 'boarding window'))) return;
    const state = this.scheduleNow();
    if (!state || state.open || state.opensAt === null) return;
    const delay = Math.max(0, state.opensAt - this.now());
    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = null;
      this.poll();
    }, delay);
    this.scheduleTimer.unref?.();
  }

  /**
   * The backstop. Every other wakeup is an event — a release, a lock change, a
   * run ending — and an admission that waits on an event which never arrives
   * waits forever. Ten minutes of aging only helps if something looks again.
   */
  private armIdleTimer(): void {
    this.idleTimer = setInterval(() => this.poll(), IDLE_POLL_MS);
    this.idleTimer.unref?.();
  }
}
