/**
 * The operations fold: lanes and admission entries, grouped by the PLAN they
 * belong to.
 *
 * ## Why the plan is the group and the lane is still the unit
 *
 * `nowLanes` returns every lane of every live run, worst first, and that flat
 * order is the right answer to "which one is not working". It is the wrong
 * answer to the other question this console exists for: *what is this machine
 * doing right now*. Two runs of one plan, three lanes each, read as six
 * interchangeable rows — and the only thing that tells them apart, the branch
 * and the checkout each lane rides, sits in a chip on row four.
 *
 * Grouping by plan makes the concurrency visible AS concurrency: one band per
 * plan, its lanes inside it, and — the half nothing on this page has ever
 * drawn — the entries of that plan still waiting for a scope somebody else
 * holds.
 *
 * Within a band the flat order is preserved exactly (`nowLanes` has already
 * sorted worst-first), and the BANDS are ordered by their own worst lane. So
 * the first lane on the page is still the first lane the flat list would have
 * shown. That is deliberate: grouping must not quietly re-rank the thing an
 * operator came here to find.
 *
 * ## Nothing here computes a fact the server did not send
 *
 * Every figure below is transported, not derived: the lease instant is
 * `QueueHolder.leaseUntil`, the estimate is `QueueHolder.eta.label` (the
 * server's own rate reading), the collided tokens are `overlaps`. The two
 * functions that look like arithmetic — `leaseRemainingMs` and `waitedMs` —
 * subtract a transported instant from the clock, and `leaseRemainingMs`
 * returns `null` rather than a number when there is no instant. An invented
 * figure here would be indistinguishable from a measured one, which is the
 * failure mode the whole queue surface exists to avoid.
 */

import type { QueueEntry, QueueHolder, QueueSnapshot } from '@/lib/api';
import { laneOrder, type NowLane } from './model';

/**
 * The claim a lane's session actually rides — branch AND working tree.
 *
 * Both come off the live child, and **both absent means shared**: the lane is
 * editing the run's own root on the run's own branch, as every run did before
 * worktree lanes existed (`ChildRef.worktree` / `ChildRef.branch`, which is
 * "set only alongside `worktree`, never on its own").
 *
 * A QUEUED lane has no child at all, so it has no claim yet — `pending` says
 * so. That is the honest answer rather than a gap: nothing has been checked
 * out for it, and drawing it as "shared" would claim it is editing a tree it
 * has not been given.
 *
 * Kept as a function over `NowLane` rather than folded into it so the two
 * questions stay apart: `NowLane` is what the phase RECORD says, this is what
 * the live process holds.
 */
export interface LaneClaim {
  branch?: string;
  tree?: string;
  /** The `git worktree lock` reason on `tree`, when the runner fastened one (phase 15). */
  locked?: string;
  session?: string;
  /** A live child with no checkout of its own — the run's root and branch. */
  shared: boolean;
  /** No live child at all: nothing has been checked out for this lane yet. */
  pending: boolean;
}

export function laneClaim(lane: NowLane): LaneClaim {
  const child = lane.child;
  const branch = child?.branch;
  const tree = child?.worktree;
  return {
    ...(branch ? { branch } : {}),
    ...(tree ? { tree } : {}),
    ...(tree && child?.locked ? { locked: child.locked } : {}),
    ...(child?.sessionId ? { session: child.sessionId } : {}),
    shared: child != null && !tree,
    pending: child == null,
  };
}

/** One plan's whole operational story: what is moving, and what cannot yet. */
export interface Swimlane {
  slug: string;
  /** The plan's title once its detail has landed; the slug until then. */
  planTitle: string;
  /** In flight, worst first — `nowLanes`' order, unchanged. */
  lanes: NowLane[];
  /**
   * Admission entries of this plan that are still waiting for a scope.
   *
   * Deliberately NOT merged into `lanes`: a queued LANE is a phase whose run
   * has started and whose record exists, while an admission ENTRY is a request
   * that has not been granted. They answer to different verbs — a lane can be
   * frozen, an entry can be bumped — and folding them into one list is how a
   * board comes to offer Freeze on something with no process to stop.
   */
  waiting: QueueEntry[];
  /**
   * How many distinct CHECKOUTS this plan's live lanes are working in.
   *
   * Checkouts, not branches: two lanes on one branch in one tree are one unit
   * of work however they are labelled, and the tree is the dimension that
   * proves physical disjointness (P1's W3 carve — "the same branch is the same
   * work, however many trees" is true of a ref and false of a detached HEAD).
   * `1` with several lanes means they share the root, which is the normal and
   * correct arrangement, not a warning.
   */
  trees: number;
}

/** The key `waitersByLane` files a grant holder under. */
export const laneWaitKey = (slug: string, phase: number): string => `${slug}#${phase}`;

/**
 * Group the flat lane list by plan, and hang each plan's queued admissions off
 * its band.
 *
 * A plan with entries and no live lane still gets a band: "queued behind
 * something, nothing running" is a state an operations board must be able to
 * show, and dropping it is how a plan waiting two hours becomes invisible on
 * the one page whose whole job is to say what is happening.
 */
export function swimlanes(
  lanes: readonly NowLane[],
  queue: QueueSnapshot | undefined,
  now = Date.now(),
): Swimlane[] {
  const bands = new Map<string, Swimlane>();

  const band = (slug: string, title?: string): Swimlane => {
    const existing = bands.get(slug);
    if (existing) {
      // The first real title wins. A band created by a queue entry knows only
      // the slug; the lane that arrives later carries the plan's own title.
      if (title && existing.planTitle === slug) existing.planTitle = title;
      return existing;
    }
    const made: Swimlane = { slug, planTitle: title || slug, lanes: [], waiting: [], trees: 0 };
    bands.set(slug, made);
    return made;
  };

  for (const lane of lanes) band(lane.slug, lane.planTitle).lanes.push(lane);
  for (const entry of queue?.entries ?? []) band(entry.slug).waiting.push(entry);

  for (const made of bands.values()) {
    const trees = new Set<string>();
    for (const lane of made.lanes) {
      const claim = laneClaim(lane);
      // A lane with no checkout of its own counts as the shared root, and a
      // lane with no child yet counts as nothing: it has not been given a tree,
      // so counting it as one would report a checkout that does not exist.
      if (claim.pending) continue;
      trees.add(claim.tree ?? '');
    }
    made.trees = trees.size;
  }

  // Bands ordered by their own worst lane, so the page's first row is still the
  // row the flat list led with. A band with no lane at all sorts after every
  // band that has one: its entries are waiting, which is real, but nothing of
  // it is in trouble because nothing of it is running.
  return [...bands.values()].sort((a, b) => {
    const al = a.lanes[0];
    const bl = b.lanes[0];
    if (al && bl) return laneOrder(al, bl, now);
    if (al) return -1;
    if (bl) return 1;
    return a.slug.localeCompare(b.slug);
  });
}

/**
 * How much of a holder's lease is left, in ms — or `null` when it has none.
 *
 * A `grant` holder (a sibling lane of this very console) has no lease: it holds
 * its scope for exactly as long as it runs, and there is no instant to count
 * down to. Only a `lock` on disk carries `lease_until`.
 *
 * ⚠️ `null` and `0` are different answers and the page must not merge them.
 * `null` is "there is no lease"; a negative number is "the lease has lapsed and
 * this claim is debris". A countdown that renders `0:00` for the first says a
 * lane is about to be released when nothing of the sort is true.
 */
export function leaseRemainingMs(holder: QueueHolder, now = Date.now()): number | null {
  if (holder.leaseUntil == null) return null;
  return holder.leaseUntil - now;
}

/** Has this holder's lease already lapsed? `false` when it has no lease at all. */
export function leaseLapsed(holder: QueueHolder, now = Date.now()): boolean {
  const left = leaseRemainingMs(holder, now);
  return left != null && left <= 0;
}

/** How long an entry has been waiting, in ms. `since` is always transported. */
export function waitedMs(entry: QueueEntry, now = Date.now()): number {
  return Math.max(0, now - entry.since);
}

/**
 * Does this holder stand on the same branch as the entry waiting behind it?
 *
 * The first thing an operator asks once two trees are in play, and the
 * difference between a collision that could have been carved out of and one
 * that could not: two claims whose scopes intersect are nevertheless disjoint
 * only when BOTH declare a branch AND a tree and both differ.
 *
 * An unqualified claim on either side collides with everything, so `null` —
 * "cannot say" — is the honest answer when either half is missing, and the page
 * must not render it as "different". Rendering a missing branch as a difference
 * is how an operator concludes a carve-out was available when the scheduler had
 * already ruled it out.
 */
export function sameBranch(entry: QueueEntry, holder: QueueHolder): boolean | null {
  if (!entry.branch || !holder.branch) return null;
  return entry.branch === holder.branch;
}

/** The same question for the working tree — the other half of the carve-out. */
export function sameTree(entry: QueueEntry, holder: QueueHolder): boolean | null {
  if (!entry.tree || !holder.tree) return null;
  return entry.tree === holder.tree;
}

/**
 * Could this collision have been carved out of?
 *
 * `true` only when both dimensions are declared on both sides and both differ —
 * the scheduler's own rule, stated in the direction an operator reads it. Any
 * missing half makes it `null`, never `false`: "nobody said" and "they match"
 * are different facts and only one of them is somebody's mistake.
 */
export function carveable(entry: QueueEntry, holder: QueueHolder): boolean | null {
  const branch = sameBranch(entry, holder);
  const tree = sameTree(entry, holder);
  if (branch == null || tree == null) return null;
  return !branch && !tree;
}

/**
 * What KIND of thing is in the way, in the words the queue page shows.
 *
 * The kind is the whole sentence structure: a `lock` is somebody else's claim
 * on disk and has a lease that ends; a `grant` is another lane of this console
 * and ends when it does; a CLOCK is not an actor at all — a boarding window,
 * the session cap, a usage wall, a freeze, a hold, a chain.
 *
 * ⚠️ A clock never gets "waiting for <owner>". There is nobody to name and
 * nothing to release, and naming a policy as if it were a rival session is how
 * an operator comes to go looking for a run that does not exist.
 */
export function holderKindWord(holder: QueueHolder): string {
  if (holder.clock) return 'a clock';
  switch (holder.kind) {
    case 'lock':
      return 'a claim on disk';
    case 'grant':
      return 'another lane here';
    case 'reserved':
      return 'a console policy';
    default:
      return holder.kind;
  }
}

/**
 * Is this a queue to wait in, or a lease to outlive?
 *
 * `live` presence means a session is in it right now and the wait ends when
 * they finish; anything else leaves the lease rules in charge. The two want
 * opposite offers from the page — patience for the first, a takeover for the
 * second — so a surface that cannot tell them apart makes the wrong one.
 */
export function waitIsForAPerson(holder: QueueHolder): boolean {
  return holder.kind === 'lock' && holder.presence === 'live';
}

/**
 * The one-line reason an entry is not moving, for a band header.
 *
 * Ordered by what OUTRANKS what, not by what is most interesting: `held` first,
 * because nothing of a held run boards at all and whatever it would otherwise
 * be waiting on is simply not the answer to "why is this not running"; then a
 * chain; then the first real holder.
 */
export function waitSummary(entry: QueueEntry): string {
  if (entry.held) return `held${entry.held.by ? ` by ${entry.held.by}` : ''}`;
  if (entry.after) return `chained behind ${entry.after}`;
  const holder = entry.waitingOn[0];
  if (!holder) return 'waiting for admission';
  if (holder.clock) return holder.owner;
  return `behind ${holder.slug}${holder.phase == null ? '' : ` P${holder.phase}`}`;
}

/**
 * Every entry waiting on a lane of THIS console, keyed by the lane it waits on
 * — the "who waits on whom" edge, in the direction a lane row needs.
 *
 * A `grant` holder names a slug and a phase, which is exactly the identity a
 * `NowLane` carries, so the join is exact rather than a guess. A `lock` holder
 * is somebody else's session and matches no lane here; those entries stay out
 * of this map and are drawn on the queue card, where the holder can be named as
 * the foreign claim it is.
 */
export function waitersByLane(queue: QueueSnapshot | undefined): Map<string, QueueEntry[]> {
  const out = new Map<string, QueueEntry[]>();
  for (const entry of queue?.entries ?? []) {
    for (const holder of entry.waitingOn) {
      if (holder.kind !== 'grant' || holder.phase == null) continue;
      const key = laneWaitKey(holder.slug, holder.phase);
      const list = out.get(key);
      if (list) list.push(entry);
      else out.set(key, [entry]);
    }
  }
  return out;
}
