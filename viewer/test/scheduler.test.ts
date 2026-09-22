/**
 * Admission: who runs now, who waits, and — the part that is easy to get
 * plausibly wrong — who is guaranteed to run eventually.
 *
 * The scheduler is pure bookkeeping with injected clocks and an injected view
 * of the locks on disk, so all of this is exercised without a repo, a child
 * process or a timer that anyone has to wait out.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PHASE_CONSOLE_LOG = '';

const { Scheduler, AdmissionAborted, MAX_BYPASS, AGING_MS } = await import('../server/runner/scheduler.ts');
import type { AccountWalls, LockView, ScopeGrant } from '../server/runner/scheduler.ts';

/** Let the microtask `admit()` schedules actually run. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Has this admission genuinely not settled — the thing "still queued" means.
 *
 * Raced against a macrotask rather than a resolved promise: `Promise.race`
 * against `Promise.resolve()` reports *every* promise as pending, because an
 * already-fulfilled one still needs a microtask to deliver, and the marker is
 * ready first. That version passes whatever you assert, which is worse than
 * failing.
 */
async function pending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending');
  const settled = promise.then(() => 'settled' as const, () => 'settled' as const);
  const later = new Promise<symbol>((resolve) => setImmediate(() => resolve(marker)));
  return await Promise.race([settled, later]) === marker;
}

function scheduler(options: {
  max?: number; locks?: () => LockView[]; now?: () => number;
  scopeFor?: (slug: string, phase: number) => string[] | undefined;
  guard?: () => boolean;
  presence?: (lock: LockView) => 'live' | 'ended' | 'unknown';
  accountWalls?: AccountWalls;
  etaFor?: (slug: string) => { remainingWeight?: number; label?: string } | undefined;
  maxPerRepo?: () => number;
} = {}) {
  return new Scheduler({
    maxPerRepo: options.maxPerRepo,
    max: options.max ?? 8,
    locks: options.locks ?? (() => []),
    now: options.now,
    scopeFor: options.scopeFor,
    guard: options.guard,
    presence: options.presence,
    accountWalls: options.accountWalls,
    etaFor: options.etaFor,
  });
}

/**
 * A stand-in for the account registry — the ONE store the scheduler reads its
 * usage walls from. Deliberately shaped like `Accounts` (`limitedUntil` /
 * `markLimited` / `accountIds`), because the point of the seam is that the
 * real registry can BE it.
 */
function registry(seed: Record<string, Record<string, string>> = {}) {
  const byAccount = new Map(Object.entries(seed).map(([id, w]) => [id, { ...w }]));
  const walls: AccountWalls = {
    limitedUntil(accountId, nowMs) {
      const live: Record<string, string> = {};
      for (const [bucket, iso] of Object.entries(byAccount.get(accountId) ?? {})) {
        if (Date.parse(iso) > nowMs) live[bucket] = iso;
      }
      return live;
    },
    markLimited(accountId, bucket, resetsAt) {
      byAccount.set(accountId, { ...byAccount.get(accountId), [bucket]: resetsAt });
    },
    accountIds: () => [...new Set(['default', ...byAccount.keys()])],
  };
  return { walls, byAccount };
}

test('two disjoint scopes are admitted together; an intersecting one waits for the release', async () => {
  const s = scheduler();

  const api = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  const web = await s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['web'] });
  assert.equal(s.snapshot().live, 2, 'disjoint repos have no reason to serialise');

  const alsoApi = s.admit({ slug: 'c', phase: 1, runId: 'r3', scope: ['api'] });
  await tick();
  assert.ok(await pending(alsoApi), 'the same repo must serialise');

  const [entry] = s.snapshot().entries;
  assert.equal(entry.waitingOn[0].kind, 'grant');
  assert.equal(entry.waitingOn[0].slug, 'a', 'the queue says WHO it is waiting on');
  assert.deepEqual(entry.waitingOn[0].overlaps, ['api'], '…and on which token');

  s.release(api);
  assert.equal((await alsoApi).scope[0], 'api');
  s.release(web);
});

test('a blocked head does not stall a disjoint tail', async () => {
  const s = scheduler();
  const held = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });

  // Queued first, and blocked.
  const head = s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['api'] });
  // Queued second, and disjoint from everything live.
  const tail = s.admit({ slug: 'c', phase: 1, runId: 'r3', scope: ['docs'] });
  await tick();

  assert.ok(await pending(head), 'still behind the api grant');
  assert.equal((await tail).slug, 'c', 'first-fit: the tail is not held hostage by the head');

  s.release(held);
  assert.equal((await head).slug, 'b');
});

test('a bypassed entry ages out and reserves its tokens against everything behind it', async () => {
  const s = scheduler();
  const blocker = await s.admit({ slug: 'holder', phase: 1, runId: 'r0', scope: ['api'] });

  const starved = s.admit({ slug: 'starved', phase: 1, runId: 'rS', scope: ['api', 'web'] });
  await tick();
  assert.ok(await pending(starved));

  // Each of these intersects `starved` (on `web`) and not the live `api` grant,
  // so pure first-fit would let them stream past it forever.
  const bypassers: ScopeGrant[] = [];
  for (let i = 0; i < MAX_BYPASS; i++) {
    const grant = await s.admit({ slug: `w${i}`, phase: 1, runId: `rw${i}`, scope: ['web'] });
    bypassers.push(grant);
    s.release(grant);
  }

  const entry = s.snapshot().entries.find((e) => e.slug === 'starved');
  assert.ok(entry, 'still queued');
  assert.equal(entry.bypassed, MAX_BYPASS, 'every overtaking admission was counted');
  assert.equal(entry.reserving, true, 'and at the bound it starts reserving');

  // Now a later `web` entry must queue behind the reservation rather than
  // overtake it a fifth time.
  const late = s.admit({ slug: 'late', phase: 1, runId: 'rL', scope: ['web'] });
  await tick();
  assert.ok(await pending(late), 'the reservation holds the queue open for the starved entry');
  const lateEntry = s.snapshot().entries.find((e) => e.slug === 'late');
  assert.equal(lateEntry?.waitingOn[0].kind, 'reserved');

  // …and when the thing it was actually waiting for lets go, it goes first.
  s.release(blocker);
  const won = await starved;
  assert.equal(won.slug, 'starved');
  assert.ok(await pending(late), 'still behind it — now on the grant itself, not the reservation');

  // Only once the starved entry is done does the one it held back proceed.
  s.release(won);
  assert.equal((await late).slug, 'late');
  s.close();
});

test('waiting long enough is enough on its own — no bypass required', async () => {
  let clock = 1_000;
  const s = scheduler({ now: () => clock });
  const held = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });

  const waiting = s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['api'] });
  await tick();
  assert.equal(s.snapshot().entries[0].reserving, false);

  clock += AGING_MS;
  s.poll();
  assert.equal(s.snapshot().entries[0].reserving, true, 'ten minutes is its own bound');

  s.release(held);
  assert.equal((await waiting).slug, 'b');
});

test('the cap stops admission even when every scope is disjoint', async () => {
  const s = scheduler({ max: 2 });
  await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  const second = await s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['web'] });

  const third = s.admit({ slug: 'c', phase: 1, runId: 'r3', scope: ['docs'] });
  await tick();
  assert.ok(await pending(third), 'nothing collides — the machine is simply full');
  assert.equal(s.snapshot().max, 2);

  s.release(second);
  assert.equal((await third).slug, 'c');
});

test('a live lock on disk blocks an intersecting phase, and an expired one does not', async () => {
  let locks: LockView[] = [
    { slug: 'other', phase: 2, owner: 'someone/else', expired: false, scope: ['api'] },
  ];
  const s = scheduler({ locks: () => locks });

  const blocked = s.admit({ slug: 'mine', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(blocked), 'a session this console never started still owns the tree');
  assert.equal(s.snapshot().entries[0].waitingOn[0].owner, 'someone/else');

  // The lease elapses; `phase-lock.sh` would let anyone take it over.
  locks = [{ ...locks[0], expired: true }];
  s.poll();
  assert.equal((await blocked).slug, 'mine');
});

test('S4-a: a scopeless lock collides with everything — the console reads it exactly as bash does', async () => {
  // A lock with no `scope=` line was written by an older script, or by a
  // session that never said. `phase-lock.sh conflicts` treats it as UNKNOWN and
  // collides with everything; the scheduler used to RECOVER what the plan says
  // that phase touches and narrow the lock to it.
  //
  // The recovery is a better guess and a worse contract. The two halves of one
  // guard gave different answers about the same lock file, and the narrower
  // answer was the console's — so the console admitted a lane into a working
  // tree that bash had just refused, which is the one disagreement this system
  // may not have (conventions.md: an unstated scope reads as unknown, and
  // unknown collides). A guess that is usually right is not a guard.
  const locks: LockView[] = [{ slug: 'legacy', phase: 3, owner: 'old/session', expired: false }];

  // Even with the plan perfectly readable, the lock is unknown and collides.
  const known = scheduler({
    locks: () => locks,
    scopeFor: (slug, phase) => (slug === 'legacy' && phase === 3 ? ['docs'] : undefined),
  });
  const disjoint = known.admit({ slug: 'mine', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(disjoint), 'an unstated scope is not a narrow scope');
  known.close();

  const unknown = scheduler({ locks: () => locks });
  const anything = unknown.admit({ slug: 'mine', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(anything), 'and with no plan to read, the same answer');
  unknown.close();
});

test('S4-a: a lock that STATES its scope still carves, exactly as before', async () => {
  // The narrowing that is legitimate: the holder said what it touches.
  const locks: LockView[] = [{ slug: 'legacy', phase: 3, owner: 'old/session', expired: false, scope: ['docs'] }];
  const s = scheduler({ locks: () => locks });
  const grant = await s.admit({ slug: 'mine', phase: 1, runId: 'r1', scope: ['api'] });
  assert.equal(grant.slug, 'mine');
  s.close();
});


test("a run's own lock never blocks its own next lane", async () => {
  const locks: LockView[] = [
    { slug: 'mine', phase: 1, owner: 'autopilot/r1', expired: false, scope: ['api'] },
  ];
  const s = scheduler({ locks: () => locks });

  // Phase 2 of the same run, same repo: the lock is ours, so the only thing
  // that may refuse this is a grant — and there is none.
  const next = await s.admit({ slug: 'mine', phase: 2, runId: 'r1', scope: ['api'] });
  assert.equal(next.phase, 2);
});

test('a foreign lock on the very phase being asked for QUEUES behind the holder, and frees on release', async () => {
  // This used to be carved out — admitted, with the runner's belt-check left
  // to refuse it by name. The refusal was a TERMINAL park (`parked` is a
  // settled status), so a phase a person was working by hand never boarded
  // again for the life of the run — observed live on delivery-overhaul
  // phase 8. Now it queues like any other lock conflict, holder named, and
  // admits the moment the lock goes away.
  let locks: LockView[] = [
    { slug: 'mine', phase: 1, owner: 'someone/else', expired: false, scope: ['api'] },
  ];
  const s = scheduler({ locks: () => locks });

  const blocked = s.admit({ slug: 'mine', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(blocked), 'a manual session owns this very phase');
  const holder = s.snapshot().entries[0].waitingOn[0];
  assert.equal(holder.kind, 'lock');
  assert.equal(holder.owner, 'someone/else');

  locks = [];
  s.poll();
  assert.equal((await blocked).phase, 1);
  s.close();
});

test('a lease that lapses on the clock stops blocking even when the stored bit is stale', async () => {
  // `LockView.expired` is frozen at store-scan time; the scheduler must judge
  // by the clock, or a dead claim blocks until an unrelated docs change.
  let clock = 1_000;
  const locks: LockView[] = [
    { slug: 'other', phase: 2, owner: 'someone/else', expired: false, scope: ['api'], leaseUntil: 5_000 },
  ];
  const s = scheduler({ locks: () => locks, now: () => clock });

  const blocked = s.admit({ slug: 'mine', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(blocked), 'the lease still has four seconds to run');
  assert.equal(s.snapshot().entries[0].waitingOn[0].leaseUntil, 5_000);

  clock = 5_001;
  s.poll();
  assert.equal((await blocked).phase, 1);
  s.close();
});

test('the lock timer wakes the scan at the lease expiry with no external poke', async () => {
  const locks: LockView[] = [
    {
      slug: 'other', phase: 2, owner: 'someone/else', expired: false,
      scope: ['api'], leaseUntil: Date.now() + 60,
    },
  ];
  const s = scheduler({ locks: () => locks });

  const blocked = s.admit({ slug: 'mine', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(blocked), 'the lease has not lapsed yet');
  // No poll(), no release, no docs event — the armed timer must do it alone.
  const grant = await Promise.race([
    blocked,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('the lock timer never fired')), 2_000).unref?.();
    }),
  ]);
  assert.equal(grant.phase, 1);
  s.close();
});

test('a throttle holds every admission until it expires', async () => {
  let clock = 1_000;
  const s = scheduler({ now: () => clock });

  s.throttle(clock + 60_000);
  const waiting = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(waiting), 'the usage window is account-wide, so nothing starts');
  assert.equal(s.snapshot().throttledUntil, 61_000);

  clock += 60_001;
  s.poll();
  assert.equal((await waiting).slug, 'a');
  assert.equal(s.snapshot().throttledUntil, null);
});

/**
 * autopilot-13 — a sooner wall has to move the alarm.
 *
 * `armThrottleTimer` returned early whenever a timer was already pending, so
 * the scheduler only ever woke at the throttle that happened to be armed
 * FIRST. Account A walled until late arms the timer; account B then hits a
 * five-hour wall that reopens much sooner; B's entries are correctly skipped
 * by `throttleFor`, and then nothing wakes to admit them when B's window
 * actually reopens. They wait for A's window, or for some unrelated event to
 * poke the queue — measured as a run idle for hours on an account that was
 * free the whole time.
 *
 * Real timers and a real clock, because the claim IS about the timer.
 */
test('a throttle that reopens sooner than the armed one re-arms the wake (autopilot-13)', async () => {
  const { walls } = registry();
  const s = scheduler({ accountWalls: walls });

  // A is walled a long way out, and something queues behind it — this is what
  // arms the timer at A's expiry.
  walls.markLimited('slow', 'five_hour', new Date(Date.now() + 30_000).toISOString());
  const slow = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'], accountId: 'slow' });
  await tick();
  assert.ok(await pending(slow), 'A is walled, so it waits');

  // B's window reopens almost immediately — and is learned AFTER the timer was
  // armed, which is the whole shape of the bug.
  walls.markLimited('quick', 'five_hour', new Date(Date.now() + 150).toISOString());
  const quick = s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['web'], accountId: 'quick' });
  await tick();
  assert.ok(await pending(quick), 'B is walled too, for now');

  // No poll(), no release, no unrelated event: only the scheduler's own timer
  // can admit B here.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await pending(quick), false,
    'B\'s window reopened and nothing woke to admit it — the alarm never moved off A');
  assert.equal((await quick).slug, 'b');
  assert.ok(await pending(slow), 'and A is still properly walled');

  s.close();
});

test('a wall the REGISTRY already knows holds admissions with nothing ever calling throttle()', async () => {
  // The restart case, and the whole reason the second copy had to go. The
  // registry persists its walls; the scheduler's `Map` did not, so after a
  // restart the admission gate believed nothing was throttled and the first
  // entry in the queue spent a whole session rediscovering the wall.
  let clock = 1_000;
  const { walls } = registry({ work: { five_hour: new Date(61_000).toISOString() } });
  const s = scheduler({ now: () => clock, accountWalls: walls });

  const held = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'], accountId: 'work' });
  await tick();
  assert.ok(await pending(held), 'a wall learned before this process existed still holds');
  assert.deepEqual(s.snapshot().throttledAccounts, [{ accountId: 'work', until: 61_000 }]);

  clock += 60_001;
  s.poll();
  assert.equal((await held).slug, 'a');
  assert.equal(s.snapshot().throttledUntil, null, 'a lapsed window is dropped on READ, not by a prune pass');
  s.close();
});

test('throttle() writes THROUGH to the registry — there is no second copy to diverge', async () => {
  let clock = 1_000;
  const { walls, byAccount } = registry();
  const s = scheduler({ now: () => clock, accountWalls: walls });

  s.throttle(clock + 60_000, 'work', 'five_hour');
  assert.equal(
    byAccount.get('work')?.five_hour, new Date(61_000).toISOString(),
    'the mark landed in the store, under the window name the runner passes',
  );

  // …and a scheduler that never saw the call reads the same wall, because the
  // store is the only place it was ever written.
  const fresh = scheduler({ now: () => clock, accountWalls: walls });
  assert.deepEqual(fresh.snapshot().throttledAccounts, [{ accountId: 'work', until: 61_000 }]);

  // An account is usable when its LAST wall lapses, so a second, NEARER window
  // is recorded without releasing it any earlier.
  s.throttle(clock + 10_000, 'work', 'seven_day_opus');
  assert.equal(byAccount.get('work')?.seven_day_opus, new Date(11_000).toISOString(), 'the second window is learned');
  assert.equal(s.snapshot().throttledUntil, 61_000, 'and the account is still held by the further one');

  // A window never gets shorter — but the guard is per BUCKET, so the scalar's
  // old failure (learning about one window forgetting the other) cannot recur.
  s.throttle(clock + 30_000, 'work', 'five_hour');
  assert.equal(byAccount.get('work')?.five_hour, new Date(61_000).toISOString(), 'not shortened');
  s.throttle(clock + 120_000, 'work', 'five_hour');
  assert.equal(s.snapshot().throttledUntil, 121_000, 'but extended');
  s.close();
  fresh.close();
});

test('a throttle is per ACCOUNT: the limited login queues, everyone else keeps flowing', async () => {
  let clock = 1_000;
  const s = scheduler({ now: () => clock });

  s.throttle(clock + 60_000, 'work');
  const held = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'], accountId: 'work' });
  await tick();
  assert.ok(await pending(held), 'the account that hit the wall waits');

  // A DIFFERENT account — and the unnamed machine login — sail through, on
  // scopes that do not even collide with the throttled entry's.
  const other = await s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['web'], accountId: 'spare' });
  assert.equal(other.slug, 'b');
  const machine = await s.admit({ slug: 'c', phase: 1, runId: 'r3', scope: ['docs'] });
  assert.equal(machine.slug, 'c');

  const snap = s.snapshot();
  assert.deepEqual(snap.throttledAccounts, [{ accountId: 'work', until: 61_000 }]);
  assert.equal(snap.throttledUntil, 61_000, 'the legacy field still says "something is throttled"');

  // The queued entry says WHY it waits, in holder vocabulary.
  const entry = snap.entries.find((e) => e.slug === 'a');
  assert.equal(entry?.waitingOn[0]?.owner, 'account work');

  clock += 60_001;
  s.poll();
  assert.equal((await held).slug, 'a', 'the reset admits it on that very scan');
  assert.equal(s.snapshot().throttledUntil, null);
});

test('the unnamed machine login and `default` are the same throttle key', async () => {
  let clock = 1_000;
  const s = scheduler({ now: () => clock });
  s.throttle(clock + 30_000);   // no accountId — the machine login
  const waiting = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(waiting));
  assert.deepEqual(s.wouldBlock({ slug: 'x', phase: 2, runId: 'r9', scope: ['web'] })[0]?.owner, 'the account');
  assert.equal(
    s.wouldBlock({ slug: 'x', phase: 2, runId: 'r9', scope: ['web'], accountId: 'spare' }).length,
    0,
    'a named account is not the machine login',
  );
  clock += 30_001;
  s.poll();
  await waiting;
});

test('two throttled accounts wake independently, soonest first', async () => {
  let clock = 1_000;
  const s = scheduler({ now: () => clock });
  s.throttle(clock + 10_000, 'fast');
  s.throttle(clock + 60_000, 'slow');
  const fast = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'], accountId: 'fast' });
  const slow = s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['web'], accountId: 'slow' });
  await tick();
  assert.equal(s.snapshot().throttledUntil, 11_000, 'min over the map');

  clock += 10_001;
  s.poll();
  assert.equal((await fast).slug, 'a');
  await tick();
  assert.ok(await pending(slow), 'the other account is still inside its window');
  assert.deepEqual(s.snapshot().throttledAccounts.map((t) => t.accountId), ['slow']);

  clock += 50_000;
  s.poll();
  await slow;
});

test('stopping a run cancels the admissions it was still waiting on', async () => {
  const s = scheduler();
  const held = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });

  const controller = new AbortController();
  const waiting = s.admit({
    slug: 'b', phase: 1, runId: 'r2', scope: ['api'], signal: controller.signal,
  });
  await tick();
  assert.ok(await pending(waiting));

  controller.abort();
  await assert.rejects(waiting, (error: Error) => error instanceof AdmissionAborted);
  assert.equal(s.snapshot().queued, 0, 'a cancelled admission leaves nothing behind');

  s.release(held);
});

test('releaseRun drops the grants AND the queue entries of a run that ended', async () => {
  const s = scheduler();
  const first = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  const second = s.admit({ slug: 'a', phase: 2, runId: 'r1', scope: ['api'] });
  await tick();
  assert.equal(s.snapshot().live, 1);
  assert.equal(s.snapshot().queued, 1);

  s.releaseRun('r1');
  await assert.rejects(second, (error: Error) => error instanceof AdmissionAborted);
  assert.equal(s.snapshot().live, 0, 'a grant is bookkeeping — the loop that made it real is gone');
  assert.equal(s.snapshot().queued, 0);
  s.release(first); // already gone; must not throw
});

test('an admission that names no repos is treated as `all`', async () => {
  const s = scheduler();
  const wide = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: [] });
  assert.deepEqual(wide.scope, ['all']);

  const anything = s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['some-repo'] });
  await tick();
  assert.ok(await pending(anything), 'saying nothing must not read as colliding with nothing');
  s.release(wide);
  assert.equal((await anything).slug, 'b');
});

test('the snapshot reports what the queue page and the run header render', async () => {
  const s = scheduler({ max: 4 });
  const held = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  s.admit({ slug: 'b', phase: 7, runId: 'r2', scope: ['api', 'web'] });
  await tick();

  const snap = s.snapshot();
  assert.equal(snap.max, 4);
  assert.equal(snap.live, 1);
  assert.equal(snap.queued, 1);
  assert.equal(snap.grants[0].slug, 'a');
  assert.equal(snap.entries[0].phase, 7);
  assert.deepEqual(snap.entries[0].scope, ['api', 'web']);
  assert.deepEqual(snap.entries[0].waitingOn[0].overlaps, ['api']);
  s.release(held);
  s.close();
});

/* ------------------------------------------------------------------ *
 * The repository guard
 * ------------------------------------------------------------------ */

test('guard off: two runs sharing a repo are admitted together', async () => {
  const s = scheduler({ guard: () => false });
  const first = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  const second = await s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['api'] });
  assert.equal(s.snapshot().live, 2, 'the operator turned serialization off, so nothing queues');
  s.release(first);
  s.release(second);
  s.close();
});

test('guard off is about OTHER runs — one run still cannot stack two lanes on a repo', async () => {
  const s = scheduler({ guard: () => false });
  const lane = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  const secondLane = s.admit({ slug: 'a', phase: 2, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(secondLane), 'two lanes of one run in one checkout is never the deal');
  s.release(lane);
  assert.equal((await secondLane).phase, 2);
  s.close();
});

test('guard off ignores foreign locks, and the cap still holds', async () => {
  const locks: LockView[] = [
    { slug: 'other', phase: 3, owner: 'sam@example-host', expired: false, scope: ['api'] },
  ];
  const s = scheduler({ max: 1, locks: () => locks, guard: () => false });
  // The foreign lock shares the scope; with the guard off it does not block.
  const granted = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  // But the session cap is about the machine, not about scopes.
  const blocked = s.wouldBlock({ slug: 'b', phase: 1, runId: 'r2', scope: ['docs'] });
  assert.equal(blocked[0]?.slug, 'session cap');
  s.release(granted);
  s.close();
});

test('overlapsFor reports the cross-run truth whatever the guard says', async () => {
  let guard = false;
  const locks: LockView[] = [
    { slug: 'held', phase: 2, owner: 'sam@example-host', expired: false, scope: ['api'] },
  ];
  const s = scheduler({ locks: () => locks, guard: () => guard });
  const mine = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  const overlaps = s.overlapsFor({ slug: 'a', phase: 2, runId: 'r1', scope: ['api'] });
  // The run's own grant is not an overlap — the probe is about who ELSE is here.
  assert.ok(!overlaps.some((h) => h.owner === 'autopilot/r1'));
  assert.ok(overlaps.some((h) => h.kind === 'lock' && h.slug === 'held'), 'the foreign lock is named');
  const foreign = s.overlapsFor({ slug: 'b', phase: 1, runId: 'r2', scope: ['api'] });
  assert.ok(foreign.some((h) => h.kind === 'grant' && h.slug === 'a'), 'the live grant is named');
  guard = true;
  assert.deepEqual(s.overlapsFor({ slug: 'b', phase: 1, runId: 'r2', scope: ['api'] }), foreign,
    'the probe never consults the guard');
  s.release(mine);
  s.close();
});

test('a guard flip lands on the next poll — queued work is re-judged, not stranded', async () => {
  let guard = true;
  const s = scheduler({ guard: () => guard });
  const held = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  const waiting = s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['api'] });
  await tick();
  assert.ok(await pending(waiting), 'guard on: the overlap queues');
  guard = false;
  s.poll();
  assert.equal((await waiting).slug, 'b', 'guard off: the same entry is admitted');
  assert.equal(s.snapshot().guard, false, 'the snapshot says which regime is in force');
  s.release(held);
  s.close();
});

/* ------------------------------------------------------------------ *
 * The live lock read and the belt-check's observation
 * ------------------------------------------------------------------ */

test('a same-phase foreign lock the store has not scanned yet still blocks, read live off disk', async () => {
  let onDisk: LockView | null = {
    slug: 'a', phase: 1, owner: 'mobin@laptop', expired: false, scope: ['api'], leaseUntil: Date.now() + 60_000,
  };
  const s = new Scheduler({
    max: 8,
    locks: () => [],                       // the store's view: nothing
    liveLock: (slug, phase) => (slug === 'a' && phase === 1 ? onDisk : null),
  });
  const admission = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.equal(await pending(admission), true, 'admission waits on the lock the belt-check would otherwise have found');
  const entry = s.snapshot().entries[0];
  assert.equal(entry.waitingOn[0]?.kind, 'lock');
  assert.equal(entry.waitingOn[0]?.owner, 'mobin@laptop');

  onDisk = null; // the holder released
  s.poll();
  await tick();
  assert.equal(await pending(admission), false, 'and admits the moment the file is gone');
  s.release(await admission);
  s.close();
});

/* ---------------- presence (Phase 5): the registry's word beats the lease ---------------- */

test('a lock whose session the registry shows ENDED stops blocking at once, lease or no lease', async () => {
  let presence: 'live' | 'ended' | 'unknown' = 'live';
  const locks: LockView[] = [{ slug: 'a', phase: 1, owner: 'sam@laptop', expired: false, scope: ['api'], leaseUntil: Date.now() + 3_600_000, session: 's1' }];
  const s = scheduler({ locks: () => locks, presence: (lock) => (lock.session === 's1' ? presence : 'unknown') });
  const want = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(want), 'a live session holds its lock');
  const [entry] = s.snapshot().entries;
  assert.equal(entry.waitingOn[0].kind, 'lock');
  assert.equal(entry.waitingOn[0].session, 's1', 'the queue names the session');
  assert.equal(entry.waitingOn[0].presence, 'live', '…and says it is live');
  // The hook reported SessionEnd (or the process is gone): the same lock is debris now.
  presence = 'ended';
  s.poll();
  assert.equal((await want).scope[0], 'api');
  s.release(await want);
});

test('a lock whose session is UNKNOWN to the registry keeps lease rules; a lock naming no session is never asked about', async () => {
  const asked: string[] = [];
  const locks: LockView[] = [
    { slug: 'a', phase: 1, owner: 'sam@laptop', expired: false, scope: ['api'], leaseUntil: Date.now() + 3_600_000, session: 's9' },
    { slug: 'b', phase: 2, owner: 'old-script', expired: false, scope: ['web'], leaseUntil: Date.now() + 3_600_000 },
  ];
  const s = scheduler({ locks: () => locks, presence: (lock) => { asked.push(lock.session ?? '?'); return 'unknown'; } });
  const api = s.admit({ slug: 'x', phase: 1, runId: 'r1', scope: ['api'] });
  const web = s.admit({ slug: 'y', phase: 1, runId: 'r2', scope: ['web'] });
  await tick();
  assert.ok(await pending(api));
  assert.ok(await pending(web));
  assert.ok(asked.includes('s9'));
  assert.ok(!asked.includes('?'), 'no session line, no question');
  const entries = s.snapshot().entries;
  assert.equal(entries.find((e) => e.slug === 'x')!.waitingOn[0].presence, undefined, 'unknown is not shown as live');
  s.close();
});

/* ------------------------------------------------------------------ *
 * The boarding schedule
 *
 * The one clock that is the OPERATOR'S rather than the machine's: when this
 * console is willing to start phases at all. Driven here with an injected
 * `now`, so a window that opens at nine in the morning is tested in a
 * millisecond rather than waited for.
 * ------------------------------------------------------------------ */

/** 2026-08-24 is a Monday. `wd(24, 9)` is Monday 09:00, local. */
const wd = (day: number, hour: number, minute = 0): number =>
  new Date(2026, 7, day, hour, minute, 0, 0).getTime();

/** Office hours, weekdays. The policy every test below varies from. */
const OFFICE = { enabled: true, windows: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }] };

test('outside the boarding window a ready phase QUEUES, with the opening time on the entry', async () => {
  let now = wd(24, 20); // Monday evening
  const s = new Scheduler({ max: 8, now: () => now, schedule: () => OFFICE });
  const want = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(want), 'nothing boards outside the window');

  const entry = s.snapshot().entries[0]!;
  assert.equal(entry.waitingOn[0].kind, 'reserved');
  assert.equal(entry.waitingOn[0].slug, 'boarding window');
  assert.match(entry.waitingOn[0].owner, /boarding opens tomorrow 09:00/);
  // …and the snapshot says it about the console as a whole, so a header can
  // show it before any phase has failed to start.
  assert.equal(s.snapshot().schedule!.open, false);
  assert.equal(s.snapshot().schedule!.opensAt, wd(25, 9));

  // Inside the window it boards, on the very next scan.
  now = wd(25, 9, 30); // Tuesday morning
  s.poll();
  const grant = await want;
  assert.equal(grant.slug, 'a');
  assert.equal(s.snapshot().schedule!.open, true);
  s.close();
});

test('quiet hours beat an otherwise-open window, and the reason says which', async () => {
  let now = wd(24, 23);
  const policy = { ...OFFICE, windows: [{ from: '00:00', to: '23:59' }], quiet: [{ from: '22:00', to: '07:00' }] };
  const s = new Scheduler({ max: 8, now: () => now, schedule: () => policy });
  const want = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(want));
  assert.match(s.snapshot().entries[0]!.waitingOn[0].owner, /^quiet hours —/);
  now = wd(25, 8);
  s.poll();
  assert.equal((await want).slug, 'a');
  s.close();
});

test('a RECOVERY is exempt: the schedule governs what the autopilot starts, not what an operator asks for', async () => {
  const now = wd(24, 3); // the middle of the night
  const s = new Scheduler({ max: 8, now: () => now, schedule: () => OFFICE });
  const phase = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  const repair = s.admit({ slug: 'b', phase: 2, runId: 'r2', scope: ['web'], kind: 'recovery' });
  await tick();
  assert.ok(await pending(phase), 'the phase waits for the morning');
  assert.equal((await repair).slug, 'b', 'the recovery runs now');
  assert.deepEqual(s.wouldBlock({ slug: 'b', phase: 2, runId: 'r2', scope: ['web'], kind: 'recovery' }), []);
  s.close();
});

test('a schedule-blocked entry never ages into `reserving` — it waits on a clock, not on scope', async () => {
  let now = wd(24, 20);
  const s = new Scheduler({ max: 8, now: () => now, schedule: () => OFFICE });
  const blocked = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  now += AGING_MS * 3;
  s.poll();
  assert.equal(s.snapshot().entries[0]!.reserving, false,
    'reserving would hold `api` against work that could legitimately run');
  assert.ok(await pending(blocked));
  s.close();
});

test('no policy, or one that is off, is the console this has always been', async () => {
  const now = wd(24, 3);
  for (const schedule of [undefined, () => undefined, () => ({ ...OFFICE, enabled: false })]) {
    const s = new Scheduler({ max: 8, now: () => now, ...(schedule ? { schedule } : {}) });
    assert.equal((await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] })).slug, 'a');
    assert.equal(s.snapshot().schedule?.open ?? true, true);
    s.close();
  }
});

test('a schedule that THROWS is read as no schedule — a bad config file must not stop every run', async () => {
  const now = wd(24, 3);
  const s = new Scheduler({
    max: 8,
    now: () => now,
    schedule: () => { throw new Error('config.json is a directory'); },
  });
  assert.equal((await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] })).slug, 'a');
  assert.equal(s.snapshot().schedule, null);
  s.close();
});

test('the schedule is read per call, so a settings change lands on the next poll', async () => {
  const now = wd(24, 3);
  let policy: unknown = OFFICE;
  const s = new Scheduler({ max: 8, now: () => now, schedule: () => policy as never });
  const want = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(want));
  policy = { ...OFFICE, enabled: false }; // the operator turns the schedule off
  s.poll();
  assert.equal((await want).slug, 'a');
  s.close();
});

test('the schedule is asked BEFORE the account wall, so the console`s own policy is the sentence shown', async () => {
  const now = wd(24, 20);
  const { walls } = registry({ default: { five_hour: new Date(wd(24, 21)).toISOString() } });
  const s = new Scheduler({ max: 8, now: () => now, schedule: () => OFFICE, accountWalls: walls });
  const want = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(want));
  assert.equal(s.snapshot().entries[0]!.waitingOn[0].slug, 'boarding window');
  s.close();
});

test('the scheduler WAKES at the opening rather than waiting for the idle poll', async (t) => {
  // Without this the queue would sit until the next 60-second sweep — harmless
  // once, and not harmless at all in the case a schedule exists FOR: nothing
  // else is going to happen for hours, so the idle poll is the only other thing
  // looking. Node's timer mock plus an injected clock makes the wait a `tick`.
  let now = wd(24, 20); // Monday evening; office hours open at 09:00
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = new Scheduler({ max: 8, now: () => now, schedule: () => OFFICE });
  try {
    const want = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
    await tick();
    assert.ok(await pending(want), 'queued outside the window');

    // Move the world to the opening and let the armed timer fire — nothing
    // calls `poll()` by hand here, which is the whole point.
    const openMs = wd(25, 9) - now;
    now = wd(25, 9);
    t.mock.timers.tick(openMs);
    assert.equal((await want).slug, 'a');
  } finally {
    s.close();
    t.mock.timers.reset();
  }
});

/* --- D1: the guard governs different work, never one unit of work ---------- */

test('D1: guard off — a foreign lock on the REQUESTED slug+phase still blocks', async () => {
  // The guard is a statement about disjoint-scope contention between DIFFERENT
  // work. It was read as permission to walk over a claim on the very phase
  // being requested, so a phase a person was working by hand got a second
  // session admitted straight onto it — the one collision the lock exists for.
  const locks: LockView[] = [
    { slug: 'a', phase: 1, owner: 'sam@example-host', expired: false, scope: ['api'] },
  ];
  const s = scheduler({ locks: () => locks, guard: () => false });
  const mine = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(mine), 'the same-phase foreign lock queues the lane, guard or no guard');

  const blockers = s.wouldBlock({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  assert.equal(blockers[0]?.kind, 'lock');
  assert.equal(blockers[0]?.owner, 'sam@example-host', 'and the holder is named');

  // Released: the wait was a queue, not a refusal.
  locks.length = 0;
  s.poll();
  const granted = await mine;
  assert.equal(granted.slug, 'a');
  s.release(granted);
  s.close();
});

test('D1: guard off — a foreign lock on a merely-overlapping OTHER phase is still admitted', async () => {
  // The guard's documented purpose, preserved. Same repo, different unit of
  // work: this is exactly the pair an operator turns the guard off for.
  const locks: LockView[] = [
    { slug: 'a', phase: 2, owner: 'sam@example-host', expired: false, scope: ['api'] },
    { slug: 'other', phase: 1, owner: 'sam@example-host', expired: false, scope: ['api'] },
  ];
  const s = scheduler({ locks: () => locks, guard: () => false });
  const granted = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  assert.equal(granted.phase, 1);
  s.release(granted);
  s.close();
});

test('D1: guard ON is unchanged — a same-phase foreign lock blocked before and blocks now', async () => {
  const locks: LockView[] = [
    { slug: 'a', phase: 1, owner: 'sam@example-host', expired: false, scope: ['api'] },
  ];
  const s = scheduler({ locks: () => locks, guard: () => true });
  const mine = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(mine));
  locks.length = 0;
  s.poll();
  s.release(await mine);
  s.close();
});

test('D1: a run-level admission (phase null) is not a unit of work anyone can be inside', async () => {
  // `phase: null` is a recovery or a run-scoped admission. With the guard off it
  // must keep behaving exactly as it did — "the whole plan" is not one job that
  // two actors could be stacked on, and treating it as one would re-serialize
  // every recovery behind every lock in the plan.
  const locks: LockView[] = [
    { slug: 'a', phase: 1, owner: 'sam@example-host', expired: false, scope: ['api'] },
  ];
  const s = scheduler({ locks: () => locks, guard: () => false });
  const granted = await s.admit({ slug: 'a', phase: null, runId: 'r1', scope: ['api'], kind: 'recovery' });
  assert.equal(granted.phase, null);
  s.release(granted);
  s.close();
});

test('D1/D2/D28: the clocks are marked as clocks — and the session cap is NOT one', async () => {
  // The runner's admission cap reads `clock` to decide what may be capped into
  // a park. A wait on the boarding window or a usage wall ends by itself; a
  // wait on a grant or a lock may not.
  //
  // D28 moved the session cap from the first list to the second, and this
  // assertion is the one that used to say the opposite. It ends when some
  // OTHER lane happens to release, which for a saturated fleet with one wedged
  // lane is never — so calling it a clock exempted the one wait shape nothing
  // in the console could bound. Not a regression in the fix: the wording here
  // was the defect, stated as a test.
  const s = scheduler({ max: 1, guard: () => true });
  const held = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  const capped = s.wouldBlock({ slug: 'b', phase: 1, runId: 'r2', scope: ['docs'] });
  assert.equal(capped[0]?.slug, 'session cap');
  assert.equal(capped[0]?.clock, undefined, 'the cap is a holder, not a clock — it may be capped');
  void held;
  s.close();
});

/* --- QA extension (phase 1): exit criterion 6's first half ------------------
 *
 * "A queued phase whose blocking lease expires (or whose holder's session
 * ends) mid-wait admits at the next lease-expiry wake — never at the 2-hour
 * cap." Phase 1 shipped a test for the OTHER half of that criterion (the
 * `waitedMs` honesty fix) and none for this one, which is the half the live
 * incident was about: 120 minutes waited against a lease that died at minute
 * 29. These pin the behaviour the fix relies on.
 */

test('D25: a lock whose LEASE lapses mid-wait admits at the lease wake, not at the cap', async () => {
  // Nothing frees this lock: it is still on disk, still owned, still returned
  // by `locks()`. Only its lease has run out — and `armLockTimer` turns that
  // promise into an admission at exactly the moment it lapses.
  const locks: LockView[] = [{
    slug: 'a', phase: 1, owner: 'sam@example-host', expired: false,
    scope: ['api'], leaseUntil: Date.now() + 150,
  }];
  const s = scheduler({ locks: () => locks, guard: () => true });
  const mine = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(mine), 'blocked while the lease is alive');

  const granted = await mine;
  assert.equal(granted.phase, 1);
  assert.equal(locks.length, 1, 'and nothing released it — the lease simply lapsed');
  s.release(granted);
  s.close();
});

test('D25: a holder whose SESSION has ended stops blocking the moment the scan looks again', async () => {
  // Presence beats the lease: an hour of lease left, but the registry has seen
  // the holder's SessionEnd. Woken here by an explicit poll, which is what the
  // docs watcher and the 60-second idle poll do in the console — deliberately
  // NOT the two-hour cap.
  let ended = false;
  const locks: LockView[] = [{
    slug: 'a', phase: 1, owner: 'sam@example-host', expired: false, scope: ['api'],
    session: 'sess-sam', leaseUntil: Date.now() + 60 * 60_000,
  }];
  const s = scheduler({
    locks: () => locks, guard: () => true,
    presence: () => (ended ? 'ended' : 'live'),
  });
  const mine = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(mine), 'a live session with an hour of lease left holds the phase');

  ended = true;
  s.poll();
  const granted = await mine;
  assert.equal(granted.phase, 1);
  s.release(granted);
  s.close();
});

/* ------------------------------------------------------------------ *
 * Orchestration: priority, hold, bump, chain (console-concurrent-plans P17)
 *
 * All four are INPUTS to the scan above, never a second scan. The tests that
 * matter most here are the two that pin what did NOT change: an unprioritised
 * queue is still FIFO, and a starved entry still outranks everything however
 * its class compares.
 * ------------------------------------------------------------------ */

/** Admit `n` entries on one token, all blocked behind a live grant. */
async function queueAll(
  s: InstanceType<typeof Scheduler>,
  specs: { slug: string; priority?: 'high' | 'normal' | 'low' }[],
): Promise<void> {
  for (const spec of specs) {
    // The rejection is caught here rather than left floating: `s.close()` at
    // the end of each test cancels every pending admission, and an unhandled
    // AdmissionAborted takes the whole node --test process down.
    void s.admit({
      slug: spec.slug, phase: 1, runId: `r-${spec.slug}`, scope: ['api'],
      ...(spec.priority ? { priority: spec.priority } : {}),
    }).catch(() => {});
  }
  await tick();
}

test('with nobody prioritised the scan order is exactly the FIFO it has always been', async () => {
  // The equivalence test. `scanOrder`'s class and bump keys are constant across
  // a queue nobody has touched, so the sort degenerates to queue position —
  // and the whole feature has to be provably invisible to a console whose
  // operator never opens the control.
  const s = scheduler({ max: 1 });
  const held = await s.admit({ slug: 'holder', phase: 1, runId: 'r0', scope: ['api'] });
  await queueAll(s, [{ slug: 'first' }, { slug: 'second' }, { slug: 'third' }]);

  s.release(held);
  await tick();
  assert.equal(s.snapshot().grants[0]?.slug, 'first', 'oldest first, unchanged');
  s.close();
});

test('a high entry is admitted before a normal one queued earlier', async () => {
  const s = scheduler({ max: 1 });
  const held = await s.admit({ slug: 'holder', phase: 1, runId: 'r0', scope: ['api'] });
  // `slow` is queued FIRST and would win on FIFO alone.
  await queueAll(s, [{ slug: 'slow', priority: 'normal' }, { slug: 'urgent', priority: 'high' }]);

  s.release(held);
  await tick();
  assert.equal(s.snapshot().grants[0]?.slug, 'urgent', 'class outranks arrival order');
  assert.equal(s.snapshot().entries[0]?.slug, 'slow', '…and the normal one is still waiting');
  s.close();
});

test('FIFO still decides WITHIN a class', async () => {
  const s = scheduler({ max: 1 });
  const held = await s.admit({ slug: 'holder', phase: 1, runId: 'r0', scope: ['api'] });
  await queueAll(s, [
    { slug: 'low-old', priority: 'low' },
    { slug: 'high-old', priority: 'high' },
    { slug: 'high-new', priority: 'high' },
  ]);

  s.release(held);
  await tick();
  assert.equal(s.snapshot().grants[0]?.slug, 'high-old', 'the older of the two highs');
  s.close();
});

test('a starved LOW entry outranks a fresh HIGH one — aging survives priority', async () => {
  // Exit criterion 1's second half, and the one that would be quietly wrong if
  // `scanOrder` ranked class above `reserving`: the low entry would be scanned
  // after every fresh high, reserve against nothing, and starve exactly as it
  // did before there was an aging rule at all. Bounded bypass has to outrank a
  // preference or it is not a bound.
  // The session cap is left wide (`max` 8) on purpose: `poll` BREAKS on a full
  // cap before it reads a single entry, so a cap-blocked queue never ages at
  // all. What has to be contended here is a SCOPE.
  let clock = 1_000;
  const s = scheduler({ now: () => clock });
  const held = await s.admit({ slug: 'holder', phase: 1, runId: 'r0', scope: ['api'] });

  // Blocked on `api`, and sharing `web` with everything that comes later.
  const starved = s.admit({
    slug: 'starved', phase: 1, runId: 'rS', scope: ['api', 'web'], priority: 'low',
  });
  await tick();
  assert.ok(await pending(starved));

  clock += AGING_MS;
  s.poll();
  assert.equal(
    s.snapshot().entries.find((e) => e.slug === 'starved')?.reserving, true,
    'ten minutes is its own bound, class or no class',
  );

  // A fresh `high` arrives AFTER the reservation and must queue behind it.
  const fresh = s.admit({ slug: 'fresh', phase: 1, runId: 'rN', scope: ['web'], priority: 'high' });
  await tick();
  assert.ok(await pending(fresh), 'the starved low reserves against the high');
  assert.equal(
    s.snapshot().entries.find((e) => e.slug === 'fresh')?.waitingOn[0]?.kind, 'reserved',
    'and the queue page says which',
  );

  s.release(held);
  const won = await starved;
  assert.equal(won.slug, 'starved', 'and it goes first');
  assert.ok(await pending(fresh), 'the high one is now behind the grant itself');
  s.release(won);
  assert.equal((await fresh).slug, 'fresh', '…and proceeds the moment the tokens are free');
  s.close();
});

test('bump moves one entry to the front of its class, and never past the class above', async () => {
  const s = scheduler({ max: 1 });
  const held = await s.admit({ slug: 'holder', phase: 1, runId: 'r0', scope: ['api'] });
  await queueAll(s, [
    { slug: 'high-one', priority: 'high' },
    { slug: 'normal-one' },
    { slug: 'normal-two' },
  ]);

  const target = s.snapshot().entries.find((e) => e.slug === 'normal-two')!;
  assert.equal(s.bump(target.id), true);
  assert.equal(
    s.snapshot().entries.find((e) => e.slug === 'normal-two')?.bumped, true,
    'the queue page can say it was moved',
  );

  s.release(held);
  await tick();
  assert.equal(s.snapshot().grants[0]?.slug, 'high-one', 'a bump does NOT cross a class boundary');

  s.release(s.snapshot().grants[0]!);
  await tick();
  assert.equal(s.snapshot().grants[0]?.slug, 'normal-two', 'but it does jump its own class');
  s.close();
});

test('a second bump lands in front of the first, and a stale id is refused', async () => {
  const s = scheduler({ max: 1 });
  const held = await s.admit({ slug: 'holder', phase: 1, runId: 'r0', scope: ['api'] });
  await queueAll(s, [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }]);

  const byName = (slug: string) => s.snapshot().entries.find((e) => e.slug === slug)!;
  s.bump(byName('c').id);
  s.bump(byName('b').id);

  s.release(held);
  await tick();
  assert.equal(s.snapshot().grants[0]?.slug, 'b', 'the operator correcting themselves means the correction');
  assert.equal(s.bump('no-such-entry'), false, 'a stale id from a page left open is not a silent success');
  s.close();
});

test('a HELD run boards nothing, and the queue says who held it', async () => {
  let held: { at: string; by?: string } | null = null;
  const s = new Scheduler({ max: 8, locks: () => [], holdFor: () => held });

  const first = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  s.release(first);

  held = { at: '2026-08-26T00:00:00.000Z', by: 'sam' };
  const second = s.admit({ slug: 'a', phase: 2, runId: 'r1', scope: ['api'] });
  await tick();
  assert.ok(await pending(second), 'a hold refuses the next admission');

  const entry = s.snapshot().entries[0]!;
  assert.equal(entry.waitingOn[0]?.slug, 'hold');
  assert.equal(entry.waitingOn[0]?.owner, 'held by sam', 'it is a person, not a clock to wait out');
  assert.equal(entry.waitingOn[0]?.clock, true, 'so the runner cap never parks a phase for obeying it');
  assert.deepEqual(entry.held, held, 'and the entry carries the record for the page');
  assert.equal(entry.reserving, false);

  // Release admits on the next scan; nothing else about the run changed.
  held = null;
  s.poll();
  assert.equal((await second).phase, 2);
  s.close();
});

test('a hold never ages into a reservation — it must not become an obstacle', async () => {
  // The operator asked for their plan to stand aside. A held entry that
  // reserved would hold its checkout against every run that could use it,
  // which is the exact opposite of what was asked for.
  let clock = 1_000;
  const s = new Scheduler({
    max: 8, locks: () => [], now: () => clock,
    holdFor: (slug) => (slug === 'held' ? { at: 'x', by: 'sam' } : null),
  });
  void s.admit({ slug: 'held', phase: 1, runId: 'rH', scope: ['api'] }).catch(() => {});
  await tick();
  clock += AGING_MS * 3;
  s.poll();
  assert.equal(s.snapshot().entries[0]?.reserving, false, 'a clock is not scope contention');

  // …and an unheld run on the same token walks straight past it.
  const other = await s.admit({ slug: 'other', phase: 1, runId: 'rO', scope: ['api'] });
  assert.equal(other.slug, 'other');
  s.close();
});

test('a chained run boards nothing until the plan it names settles', async () => {
  let predecessorLive = true;
  const s = new Scheduler({
    max: 8,
    locks: () => [],
    chainBlocker: (slug) => (slug === 'follower' && predecessorLive ? 'leader' : null),
  });

  const chained = s.admit({ slug: 'follower', phase: 1, runId: 'rF', scope: ['api'] });
  await tick();
  assert.ok(await pending(chained), 'the chain holds it before any scope is even consulted');

  const entry = s.snapshot().entries[0]!;
  assert.equal(entry.waitingOn[0]?.slug, 'chain');
  assert.equal(entry.waitingOn[0]?.owner, 'waiting for leader to settle');
  assert.equal(entry.after, 'leader', 'the page can name the predecessor without parsing prose');

  predecessorLive = false;
  s.poll();
  assert.equal((await chained).slug, 'follower');
  s.close();
});

test('the settle listener is `releaseRun` — a predecessor that held nothing still releases the chain', async () => {
  // The bug this pins: `releaseRun` used to poll only when the ending run had
  // freed a grant or an entry of its own. A chained entry waits on the
  // predecessor's STATUS, and a run can settle holding neither (it parked
  // before it ever boarded) — precisely the case where somebody downstream has
  // been waiting the longest. Without the unconditional poll the chain would
  // release on the sixty-second idle timer instead.
  let predecessorLive = true;
  const s = new Scheduler({
    max: 8,
    locks: () => [],
    chainBlocker: () => (predecessorLive ? 'leader' : null),
  });
  const chained = s.admit({ slug: 'follower', phase: 1, runId: 'rF', scope: ['api'] });
  await tick();
  assert.ok(await pending(chained));

  // `rLeader` holds no grant and owns no queue entry — exactly the shape that
  // used to leave `touched` false.
  predecessorLive = false;
  s.releaseRun('rLeader');
  // Within a macrotask, NOT "eventually": with the guard back the idle timer
  // still frees this — measured at 60,011 ms, i.e. exactly one `IDLE_POLL_MS`
  // — so an `await chained` would go green after a minute of dead console and
  // pin nothing at all.
  assert.equal(await pending(chained), false, 'released on the settle, not on the idle timer');
  assert.equal((await chained).slug, 'follower');
  s.close();
});

test('reprioritize moves entries that are ALREADY waiting', async () => {
  // Without it, an operator who raises a plan's class while three of its
  // phases sit in `admit()` gets a run file that says `high` and a queue that
  // ignores it until the next phase boards.
  const s = scheduler({ max: 1 });
  const held = await s.admit({ slug: 'holder', phase: 1, runId: 'r0', scope: ['api'] });
  await queueAll(s, [{ slug: 'ordinary' }, { slug: 'later' }]);

  s.reprioritize('r-later', 'high');
  assert.equal(s.snapshot().entries.find((e) => e.slug === 'later')?.priority, 'high');

  s.release(held);
  await tick();
  assert.equal(s.snapshot().grants[0]?.slug, 'later');
  s.close();
});

test('wouldBlock sees a hold and a chain, or the badge never appears', async () => {
  // `wouldBlock` is what the runner asks BEFORE joining the queue, and it is
  // the only thing that writes `phase.queued` and lights the badge. One that
  // did not know about holds would report the admission free, the runner would
  // skip the journal line, and the phase would then sit in `admit()` with
  // nothing anywhere saying it was held.
  const s = new Scheduler({
    max: 8,
    locks: () => [],
    holdFor: (slug) => (slug === 'held' ? { at: 'x', by: 'sam' } : null),
    chainBlocker: (slug) => (slug === 'chained' ? 'leader' : null),
  });
  assert.equal(s.wouldBlock({ slug: 'held', phase: 1, runId: 'r1', scope: ['api'] })[0]?.slug, 'hold');
  assert.equal(s.wouldBlock({ slug: 'chained', phase: 1, runId: 'r2', scope: ['api'] })[0]?.slug, 'chain');
  assert.deepEqual(s.wouldBlock({ slug: 'free', phase: 1, runId: 'r3', scope: ['api'] }), []);
  s.close();
});

test('a dep that throws is not a hold and not a chain — uncertainty never stops a plan', async () => {
  // The `scheduleNow` posture: these read run state that a broken checkpoint
  // could make unreadable, and a throw that read as HELD would stop every run
  // on the machine over one bad file.
  const s = new Scheduler({
    max: 8,
    locks: () => [],
    holdFor: () => { throw new Error('unreadable checkpoint'); },
    chainBlocker: () => { throw new Error('unreadable checkpoint'); },
  });
  const granted = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  assert.equal(granted.slug, 'a');
  s.close();
});

/* --- P8: the branch carve-out, and the session cap's honesty (D28) ---------
 *
 * Scope answers "which repository", and a repository was as fine as admission
 * got: two runs on one repo serialised however separate their work was. P7
 * gave a claim a BRANCH and both languages one rule for what that makes
 * disjoint; this is the layer that acts on it.
 *
 * The rule is a NARROWING and never a replacement (`claimsDisjoint`): both
 * claims must declare a branch AND a working tree, and both must differ. Every
 * case below is either that carve-out working, or one of the walls that must
 * survive it — an unqualified claim (either dimension), a shared tree, the
 * same unit of work, and the guard.
 */

test('P8: two isolated runs on ONE repo are admitted together — the branch is what carves', async () => {
  const s = scheduler({ guard: () => true });
  const first = await s.admit({
    slug: 'a', phase: 1, runId: 'r1', scope: ['hub'], branch: 'pe/a', tree: '/state/r1/integration',
  });
  // Same repo, guard ON, nothing released: before P8 this waited for `first`.
  const second = await s.admit({
    slug: 'b', phase: 1, runId: 'r2', scope: ['hub'], branch: 'pe/b', tree: '/state/r2/integration',
  });
  assert.equal(second.slug, 'b');
  assert.equal(second.branch, 'pe/b', 'the grant carries the branch it was admitted on');
  assert.equal(second.tree, '/state/r2/integration', '…and the tree, the other carve dimension');
  assert.equal(s.snapshot().live, 2);
  s.release(first); s.release(second);
  s.close();
});

test('P8: an isolated run carves past a QUALIFIED shared run — the live scenario', async () => {
  // The exact shape that sat queued on the operator's console: one run live in
  // the SHARED checkout on its own branch (its claims name `pe/x` and the
  // shared root — the un-gated truth), a second run isolated in its own tree.
  // Different branches, different trees: nothing they do can meet.
  const locks: LockView[] = [
    // The shared run's OTHER lane's lock — owned by the same run, so its own
    // admission skips it, while the isolated run below meets it as a foreign,
    // fully qualified holder.
    {
      slug: 'filters', phase: 10, owner: 'autopilot/rf', expired: false,
      scope: ['hub'], branch: 'pe/filters', tree: '/home/sam/hub',
    },
  ];
  const s = scheduler({ locks: () => locks, guard: () => true });
  const shared = await s.admit({
    slug: 'filters', phase: 12, runId: 'rf', scope: ['hub'], branch: 'pe/filters', tree: '/home/sam/hub',
  });
  const isolated = await s.admit({
    slug: 'dsl', phase: 1, runId: 'rd', scope: ['hub'], branch: 'pe/dsl', tree: '/state/rd/integration',
  });
  assert.equal(isolated.slug, 'dsl', 'admitted beside a live shared run, not behind it');
  assert.equal(s.snapshot().live, 2);
  s.release(shared); s.release(isolated);
  s.close();
});

test('P8: two SHARED runs on different branches still collide — one directory is one directory', async () => {
  // The wall the tree dimension exists for. Un-gating `branchFor` gave every
  // new-branch run a branch; if branches alone carved, two runs editing the
  // ONE shared checkout would have been admitted together the same day.
  const s = scheduler({ guard: () => true });
  const first = await s.admit({
    slug: 'a', phase: 1, runId: 'r1', scope: ['hub'], branch: 'pe/a', tree: '/home/sam/hub',
  });
  const second = s.admit({
    slug: 'b', phase: 1, runId: 'r2', scope: ['hub'], branch: 'pe/b', tree: '/home/sam/hub',
  });
  await tick();
  assert.ok(await pending(second), 'same tree ⇒ the branches change nothing');
  s.release(first);
  await second.then((grant) => { s.release(grant); });
  s.close();
});

test('P8: an UNQUALIFIED hand lock still queues an isolated run', async () => {
  // The wall that makes this safe to ship: a person at a terminal, or any lock
  // written before `branch=` existed, says nothing about which branch it rides
  // — so it may be riding yours. It collides with everything, exactly as it did.
  const locks: LockView[] = [
    { slug: 'other', phase: 2, owner: 'sam@example-host', expired: false, scope: ['hub'] },
  ];
  const s = scheduler({ locks: () => locks });
  const mine = s.admit({
    slug: 'a', phase: 1, runId: 'r1', scope: ['hub'], branch: 'pe/a', tree: '/state/r1/integration',
  });
  await tick();
  assert.ok(await pending(mine), 'an unqualified holder is never carved out');

  locks.length = 0;
  s.poll();
  s.release(await mine);
  s.close();
});

test('P8: …and the reverse — an unqualified RUN queues behind a branch-qualified lock', async () => {
  // The rule is symmetric, and it has to be: the shared-checkout session is the
  // one with something to lose. It is editing the tree everybody shares.
  const locks: LockView[] = [
    {
      slug: 'other', phase: 2, owner: 'autopilot/beefbeef', expired: false, scope: ['hub'],
      branch: 'pe/other', tree: '/state/other/integration',
    },
  ];
  const s = scheduler({ locks: () => locks });
  const mine = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['hub'] });
  await tick();
  assert.ok(await pending(mine), 'no branch of my own ⇒ no carve-out');

  locks.length = 0;
  s.poll();
  s.release(await mine);
  s.close();
});

test('P8: two isolated claims on the SAME branch queue — defensive, and the reason is the point', async () => {
  // Normally impossible (a run branch is `pe/<slug>` and a lane branch carries
  // its phase), but the rule is "the branches DIFFER", not "both have one" —
  // two sessions committing to one branch contend however many checkouts they
  // have between them, which is the whole reason scope was not enough either.
  const locks: LockView[] = [
    {
      slug: 'other', phase: 2, owner: 'autopilot/beefbeef', expired: false, scope: ['hub'],
      branch: 'pe/same', tree: '/state/other/integration',
    },
  ];
  const s = scheduler({ locks: () => locks });
  const mine = s.admit({
    slug: 'a', phase: 1, runId: 'r1', scope: ['hub'], branch: 'pe/same', tree: '/state/r1/integration',
  });
  await tick();
  assert.ok(await pending(mine), 'one branch, two sessions — the collision the field exists to see');

  locks.length = 0;
  s.poll();
  s.release(await mine);
  s.close();
});

test('P8: a branch NEVER carves out the same slug+phase — the belt-check rule is absolute', async () => {
  // Two actors on one unit of work write the same handoff and take the same
  // lock. `sameUnitOfWork` outranks the carve-out for the same reason it
  // outranks the guard being off (D1): no arrangement of checkouts makes it
  // safe, and a run that gave itself a branch must not walk past a claim an
  // operator would need `--force` to take by hand.
  for (const guard of [true, false]) {
    const locks: LockView[] = [
      {
        slug: 'a', phase: 1, owner: 'sam@example-host', expired: false, scope: ['hub'],
        branch: 'pe/theirs', tree: '/home/sam/wt/theirs',
      },
    ];
    const s = scheduler({ locks: () => locks, guard: () => guard });
    const mine = s.admit({
      slug: 'a', phase: 1, runId: 'r1', scope: ['hub'], branch: 'pe/mine', tree: '/home/sam/wt/mine',
    });
    await tick();
    assert.ok(await pending(mine), `same slug+phase blocks with the guard ${guard ? 'on' : 'off'}`);

    const blockers = s.wouldBlock({
      slug: 'a', phase: 1, runId: 'r1', scope: ['hub'], branch: 'pe/mine', tree: '/home/sam/wt/mine',
    });
    assert.equal(blockers[0]?.kind, 'lock');
    assert.equal(blockers[0]?.owner, 'sam@example-host', 'and the holder is still named');
    assert.equal(blockers[0]?.branch, 'pe/theirs', 'with the branch it rides, so the queue can say why');

    locks.length = 0;
    s.poll();
    s.release(await mine);
    s.close();
  }
});

test('P8: guard OFF still ignores exactly what it ignored before', async () => {
  // The carve-out only ever REMOVES holders, so guard-off cannot have grown:
  // a merely-overlapping other phase was already admitted, and the same-phase
  // claim is still refused (above). What this pins is the middle case — a
  // branch-qualified holder on another phase, with the guard off, is admitted
  // for the guard's reason and not for the branch's.
  const locks: LockView[] = [
    { slug: 'other', phase: 2, owner: 'sam@example-host', expired: false, scope: ['hub'] },
  ];
  const s = scheduler({ locks: () => locks, guard: () => false });
  const granted = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['hub'] });
  assert.equal(granted.phase, 1);
  s.release(granted);
  s.close();
});

test('P8: a RESERVING entry is carved out by branch too — all three holder sources agree', async () => {
  // The third holder source. An aged entry reserves its TOKENS against
  // everything behind it, and a carve-out that stopped at grants and locks
  // would admit an isolated run for ten minutes and then serialise it against
  // an entry whose only claim on the repository is that it has waited a while.
  let now = 0;
  const locks: LockView[] = [
    { slug: 'wall', phase: 1, owner: 'sam@example-host', expired: false, scope: ['hub'] },
  ];
  const s = scheduler({ now: () => now, locks: () => locks });

  // An isolated run, starved behind an unqualified hand lock until it ages out.
  const aged = s.admit({
    slug: 'y', phase: 1, runId: 'ry', scope: ['hub'], branch: 'pe/y', tree: '/state/ry/integration',
  });
  await tick();
  now += AGING_MS + 1;
  s.poll();
  assert.equal(s.snapshot().entries[0]?.reserving, true, 'the fixture must actually reserve');

  // The lock goes, but nothing polls — so the reservation is still standing and
  // is the ONLY holder either question below can hit.
  locks.length = 0;

  assert.deepEqual(
    s.wouldBlock({
      slug: 'z', phase: 1, runId: 'rz', scope: ['hub'], branch: 'pe/z', tree: '/state/rz/integration',
    }), [],
    'a reservation on another branch holds nothing back',
  );
  const shared = s.wouldBlock({ slug: 'z', phase: 1, runId: 'rz', scope: ['hub'] });
  assert.equal(shared[0]?.kind, 'reserved');
  assert.equal(shared[0]?.slug, 'y', 'and it still holds back a session sharing the tree');
  assert.equal(shared[0]?.branch, 'pe/y');

  s.poll();
  s.release(await aged);
  s.close();
});

test('P8: overlapsFor reports branch-disjoint pairs as NOT overlapping', async () => {
  // The honesty probe is what puts the DIY CAUTION in a session's prompt.
  // Firing it between two console-managed trees on two branches would warn
  // about a collision admission had just decided did not exist — the console
  // contradicting itself inside one phase's boot.
  const locks: LockView[] = [
    {
      slug: 'other', phase: 2, owner: 'autopilot/beefbeef', expired: false, scope: ['hub'],
      branch: 'pe/other', tree: '/state/other/integration',
    },
  ];
  const s = scheduler({ locks: () => locks, guard: () => false });
  assert.deepEqual(
    s.overlapsFor({
      slug: 'a', phase: 1, runId: 'r1', scope: ['hub'], branch: 'pe/a', tree: '/state/r1/integration',
    }), [],
    'two branches, two trees — nothing to caution about',
  );
  // …and it still tells the truth for a session that has no branch of its own.
  const shared = s.overlapsFor({ slug: 'a', phase: 1, runId: 'r1', scope: ['hub'] });
  assert.equal(shared.length, 1);
  assert.equal(shared[0]?.owner, 'autopilot/beefbeef');
  s.close();
});

test('D28: at the session cap the holder scan is REPORTED, not skipped', async () => {
  // The early return was two bugs. This is the second: at `maxSessions` the
  // scan stopped at the cap, so a phase that was ALSO behind a foreign lock on
  // its checkout was told only that the machine was busy — and the moment a
  // lane freed, the queue page changed its mind about why it was waiting.
  const locks: LockView[] = [
    { slug: 'other', phase: 2, owner: 'sam@example-host', expired: false, scope: ['hub'] },
  ];
  const s = scheduler({ max: 1, locks: () => locks });
  const held = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['web'] });
  await tick();

  const blockers = s.wouldBlock({ slug: 'b', phase: 1, runId: 'r2', scope: ['hub'] });
  assert.equal(blockers[0]?.slug, 'session cap', 'the cap leads — it is the nearer fact');
  assert.ok(blockers.some((h) => h.kind === 'lock' && h.owner === 'sam@example-host'),
    'and the lock behind it is still named');

  // Nothing has changed for a request the cap alone blocks.
  const clear = s.wouldBlock({ slug: 'c', phase: 1, runId: 'r3', scope: ['docs'] });
  assert.deepEqual(clear.map((h) => h.slug), ['session cap']);

  s.release(await held);
  s.close();
});

test('D28: a cap-blocked wait is CAPPABLE — nothing about it is a clock', async () => {
  // What the runner does with this: `blockers.filter((h) => !h.clock)` decides
  // whether `lockWaitSince` is stamped and the two-hour bound armed. An empty
  // list there is an unbounded wait, and at `maxSessions` that list was always
  // empty. The runner-side proof is in `runner-parallel.test.ts`; this is the
  // scheduler's half of the contract it reads.
  const s = scheduler({ max: 1 });
  const held = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['web'] });
  await tick();
  const blockers = s.wouldBlock({ slug: 'b', phase: 1, runId: 'r2', scope: ['docs'] });
  assert.equal(blockers.filter((h) => !h.clock).length, 1, 'the cap arms the bound');
  s.release(await held);
  s.close();
});

test('D28: the boarding window and the usage wall are still clocks, and still lead', async () => {
  // The other half of the same change: exempting a wait that ends at a moment
  // already known is correct, and D28 must not have swept those along with it.
  // Fill the single lane FIRST, then raise the wall: a throttle armed before
  // the admission would have queued that one too, and closing the scheduler on
  // a still-pending promise rejects it into nobody's hands.
  const s = scheduler({ max: 1 });
  const held = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['web'] });
  s.throttle(Date.now() + 60_000);
  const blockers = s.wouldBlock({ slug: 'b', phase: 1, runId: 'r2', scope: ['docs'] });
  assert.equal(blockers[0]?.slug, 'usage window');
  assert.equal(blockers[0]?.clock, true, 'a wall with a reset time is a clock');
  assert.equal(blockers.length, 1, 'and it short-circuits ahead of the cap, as it always did');
  s.release(held);
  s.close();
});

test('P8: the snapshot carries branches, so the queue page can say which tree is which', async () => {
  const s = scheduler({ guard: () => true });
  const first = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['hub'], branch: 'pe/a' });
  const queued = s.admit({ slug: 'a', phase: 2, runId: 'r1', scope: ['hub'], branch: 'pe/a' });
  await tick();

  const snap = s.snapshot();
  assert.equal(snap.grants[0]?.branch, 'pe/a');
  assert.equal(snap.entries[0]?.branch, 'pe/a');
  assert.equal(snap.entries[0]?.waitingOn[0]?.branch, 'pe/a', 'the holder names its branch too');

  s.release(first);
  s.release(await queued);
  s.close();
});

test('P8/QA F-3: a branch-disjoint admission does not count as a BYPASS', async () => {
  // `bypassed` counts the entries an admission actually got in FRONT of, and
  // after `MAX_BYPASS` of them an entry reserves its tokens against everything
  // behind it. An entry that could have gone at the same moment was not
  // overtaken — so counting a branch-disjoint admission against it manufactures
  // a reservation out of concurrency the carve-out had just licensed, and the
  // carve-out switches itself back off a few admissions later.
  let now = 0;
  // A wall that blocks `pe/y` and NOTHING else — same repo, same branch. An
  // unqualified one would block the passers too and prove nothing.
  const locks: LockView[] = [
    {
      slug: 'wall', phase: 1, owner: 'sam@example-host', expired: false, scope: ['hub'],
      branch: 'pe/y', tree: '/home/sam/wt/wall',
    },
  ];
  const s = scheduler({ now: () => now, locks: () => locks });

  const starved = s.admit({
    slug: 'y', phase: 1, runId: 'ry', scope: ['hub'], branch: 'pe/y', tree: '/state/ry/integration',
  });
  await tick();

  // MAX_BYPASS + 1 admissions on OTHER branches in OTHER trees, each of which
  // the old counter would have called an overtake.
  const passers: Promise<unknown>[] = [];
  for (let i = 0; i <= MAX_BYPASS; i++) {
    passers.push(s.admit({
      slug: `z${i}`, phase: 1, runId: `rz${i}`, scope: ['hub'],
      branch: `pe/z${i}`, tree: `/state/rz${i}/integration`,
    }));
  }
  await tick();
  await Promise.all(passers);
  assert.equal(s.snapshot().entries.find((e) => e.slug === 'y')?.reserving, false,
    'nothing overtook it — those admissions were never in its way');

  locks.length = 0;
  now += AGING_MS + 1;
  s.poll();
  await starved;
  s.close();
});

/* ------------------------------------------------------------------ *
 * The queue's *how long* — `Holder.eta`.
 *
 * Decoration, and the tests say so in both directions: the number
 * reaches the holder, and NOTHING about the queue's decisions moves
 * when it is absent, empty or throwing. A queue that reordered itself
 * on an estimate would be a queue whose order depended on how much
 * history a plan happened to have.
 * ------------------------------------------------------------------ */

test('a blocking holder carries how long its own plan has left', async () => {
  const s = scheduler({
    etaFor: (slug) => (slug === 'a' ? { remainingWeight: 310_000, label: '~2–4 h out' } : undefined),
  });
  const held = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });

  const waiting = s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['api'] });
  await tick();
  assert.ok(await pending(waiting), 'the same repo must serialise, or this proves nothing');

  const [entry] = s.snapshot().entries;
  assert.equal(entry.waitingOn[0].slug, 'a');
  assert.deepEqual(entry.waitingOn[0].eta, { remainingWeight: 310_000, label: '~2–4 h out' },
    'the queue must say how long the thing ahead of it has, not only who it is');

  s.release(held);
  await waiting;
});

test('an ETA that is absent, empty or throwing changes nothing at all', async () => {
  // Three shapes of "no answer", and the queue must be identical under each:
  // a cold memo, a plan with nothing finished (no rate to measure), and a dep
  // that throws — which must never take an admission scan down with it.
  for (const etaFor of [
    undefined,
    () => undefined,
    () => ({}),
    () => { throw new Error('the board could not be read'); },
  ] as (((slug: string) => { remainingWeight?: number; label?: string } | undefined) | undefined)[]) {
    const s = scheduler(etaFor ? { etaFor } : {});
    const held = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
    const waiting = s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['api'] });
    await tick();
    assert.ok(await pending(waiting), 'the collision itself must be unaffected');

    const [entry] = s.snapshot().entries;
    assert.equal(entry.waitingOn[0].slug, 'a', 'the holder is still named');
    assert.equal(entry.waitingOn[0].eta, undefined,
      'an unknown ETA must be ABSENT — an empty object on the wire reads as a measured zero');

    s.release(held);
    await waiting;
  }
});

test('a disjoint scope is still admitted at once, ETA or no ETA', async () => {
  // The one thing that must never happen: an estimate becoming an input to the
  // decision. Same scheduler, same request, an ETA that says the holder has
  // days left — and the disjoint entry starts immediately regardless.
  const s = scheduler({ etaFor: () => ({ remainingWeight: 9_999_999, label: '~3 weeks out' }) });
  await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  const other = await s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['docs'] });
  assert.equal(other.scope[0], 'docs');
  assert.equal(s.snapshot().live, 2);
  assert.equal(s.snapshot().entries.length, 0, 'nothing queued, so nothing was decided on an estimate');
});

/* ------------------------------------------------------------------ *
 * console-parallel-repaint P1 — W8: the live read outranks a stale row
 * ------------------------------------------------------------------ */

test('P1/W8 — the live read OUTRANKS a stale store row: a lapsed-then-refreshed lock still blocks', async () => {
  const stale: LockView = {
    slug: 'a', phase: 1, owner: 'mobin@laptop', expired: true, scope: ['api'], leaseUntil: Date.now() - 60_000,
  };
  let onDisk: LockView | null = {
    slug: 'a', phase: 1, owner: 'mobin@laptop', expired: false, scope: ['api'], leaseUntil: Date.now() + 3_600_000,
  };
  const s = new Scheduler({
    max: 8,
    locks: () => [stale],                  // the store's memory: the lease lapsed
    liveLock: (slug, phase) => (slug === 'a' && phase === 1 ? onDisk : null),
  });
  const admission = s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  await tick();
  // The first cut skipped the live read whenever the store held ANY row for
  // the key, so this admitted over a holder who had just refreshed their
  // claim — two sessions on one slug+phase, the collision the lock exists for.
  assert.equal(await pending(admission), true, "the file says the holder refreshed; the store's stale row must not admit over them");
  assert.equal(s.snapshot().entries[0]?.waitingOn[0]?.kind, 'lock');
  assert.equal(s.snapshot().entries[0]?.waitingOn[0]?.leaseUntil, onDisk.leaseUntil, 'the LIVE lease is the one reported');

  onDisk = null;                            // released: only the stale, lapsed row is left
  s.poll();
  await tick();
  assert.equal(await pending(admission), false, 'no file leaves the store row in charge, and it is lapsed');
  s.release(await admission);
  s.close();
});

/* ------------------------------------------------------------------ *
 * Zero-touch phase 16 — a peer in the repository, with no lock (REG-3)
 * ------------------------------------------------------------------ */

test('ACC-7.3 (REG-3): a live session in the repository with no lock is a `session` holder — named, scope-aware, never cappable, and the only thing the guard keeps is a peer on the same phase', async () => {
  const { isCappableBlocker } = await import('../server/runner/scheduler.ts');
  let peers: {
    sessionId: string; pid: number | null; cwd: string; presence: 'live' | 'unknown'; owner: string;
    scope: string[]; plan: { slug: string; phase: number } | null;
  }[] = [
    { sessionId: 's-hand-peer-0001', pid: 4242, cwd: '/work/hub', presence: 'live', owner: 'sam@laptop', scope: ['all'], plan: null },
    { sessionId: 's-other-repo-0002', pid: 4343, cwd: '/work/hub/site', presence: 'live', owner: 'kim@desk', scope: ['site'], plan: null },
  ];
  const asked: { slug: string; phase: number; scope: readonly string[] }[] = [];
  let guard = true;
  const s = new Scheduler({
    max: 8, locks: () => [], guard: () => guard,
    peers: (entry) => { asked.push({ slug: entry.slug, phase: entry.phase, scope: entry.scope }); return peers; },
  });
  try {
    const request = { slug: 'alpha', phase: 2, runId: 'run-a', scope: ['app'] };
    const holders = s.wouldBlock(request);
    assert.equal(holders.length, 1, 'the session in `site` is disjoint from `app`; the one in the root is not');
    const [holder] = holders;
    assert.equal(holder.kind, 'session');
    assert.equal(holder.session, 's-hand-peer-0001');
    assert.equal(holder.pid, 4242);
    assert.equal(holder.cwd, '/work/hub');
    assert.equal(holder.presence, 'live');
    assert.equal(holder.owner, 'session s-hand-p (pid 4242)');
    assert.equal(holder.phase, null, 'uncorrelated: it could be about to work anything in its scope');
    assert.equal(isCappableBlocker(holder), false, 'a person in the tree is not a lease to outlive — never capped into a park');
    assert.deepEqual(asked.at(-1), { slug: 'alpha', phase: 2, scope: ['app'] });

    // A run-level admission is not a unit of work a peer can be inside.
    assert.deepEqual(s.wouldBlock({ slug: 'alpha', phase: null, runId: 'run-a', scope: ['app'] }), []);

    // Queued, and admitted when the peer goes.
    const admission = s.admit(request);
    assert.equal(await pending(admission), true, 'queued behind the peer');
    peers = [];
    s.poll();
    assert.equal(await pending(admission), false, 'the peer gone, the scan admits');
    s.release(await admission);

    // With the repository guard OFF, an uncorrelated peer stops blocking — the
    // guard's documented purpose — but a peer correlated to THIS phase is the
    // same unit of work, which no setting licenses.
    guard = false;
    peers = [{ sessionId: 's-hand-peer-0001', pid: 4242, cwd: '/work/hub', presence: 'live', owner: 'sam@laptop', scope: ['all'], plan: null }];
    assert.deepEqual(s.wouldBlock(request), []);
    peers = [{ sessionId: 's-hand-peer-0001', pid: 4242, cwd: '/work/hub', presence: 'live', owner: 'sam@laptop', scope: ['all'], plan: { slug: 'alpha', phase: 2 } }];
    const same = s.wouldBlock(request);
    assert.equal(same.length, 1);
    assert.equal(same[0].phase, 2);
  } finally { s.close(); }
});

test('REG-3 claim window: a peer\'s window end is its holder\'s leaseUntil, and the lock timer wakes the scan there with no external poke', async () => {
  const { isCappableBlocker } = await import('../server/runner/scheduler.ts');
  // Wide enough that a loaded machine still reaches `admit` before the window shuts.
  const shuts = Date.now() + 500;
  const s = new Scheduler({
    max: 8, locks: () => [],
    peers: () => (Date.now() < shuts
      ? [{ sessionId: 's-hand-peer-0003', pid: 4545, cwd: '/work/hub', presence: 'live', owner: 'sam@laptop', scope: ['all'], plan: null, claimUntil: shuts }]
      : []),
  });
  try {
    const request = { slug: 'alpha', phase: 2, runId: 'run-w', scope: ['app'] };
    const [holder] = s.wouldBlock(request);
    assert.equal(holder?.kind, 'session');
    assert.equal(holder.leaseUntil, shuts, 'the queue can say when the hold lapses');
    assert.equal(isCappableBlocker(holder), false, 'a window that ends by itself is never capped into a park');

    const blocked = s.admit(request);
    await tick();
    assert.ok(await pending(blocked), 'the window is still open');
    // No poll(), no release, no presence event — the armed timer must do it alone
    // (the idle poll is a minute away).
    const grant = await Promise.race([
      blocked,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('the lock timer never fired for the session holder')), 5_000).unref?.();
      }),
    ]);
    assert.equal(grant.phase, 2);
    s.release(grant);
  } finally { s.close(); }
});

/* ------------------------------------------------------------------ *
 * The machine ceiling (zero-touch phase 17, FLT-7 / ACC-10.7)
 * ------------------------------------------------------------------ */

test('ACC-10.7: with a machine cap of 1 and two consoles, the second queues behind a holder naming the first — and a release admits it', async (t) => {
  const { MachineLanes } = await import('../server/fleet.ts');
  const { MACHINE_HOLDER } = await import('../server/runner/scheduler.ts');
  const { laneTokensDir, liveLaneTokens, updateFleetProfile } = await import('../shared/instances.mjs');
  // The machine profile both consoles read: one lane on the whole machine.
  assert.ok(updateFleetProfile((profile) => ({ ...profile, maxSessions: 1 })), 'the profile is written');
  t.after(() => { updateFleetProfile((profile) => { const next = { ...profile }; delete next.maxSessions; return next; }); });

  // Two consoles in one sandbox — one XDG state home, two instance ids — each
  // allowed three lanes of its own, so only the MACHINE can hold the second.
  const alpha = new Scheduler({ max: 3, machine: new MachineLanes('11111111-alpha', { name: 'alpha', port: () => 4555 }) });
  const beta = new Scheduler({ max: 3, machine: new MachineLanes('22222222-beta', { name: 'beta', port: () => 4556 }) });
  t.after(() => { alpha.close(); beta.close(); });

  const first = await alpha.admit({ slug: 'one', phase: 1, runId: 'run-a', scope: ['repo-a'] });
  assert.equal(liveLaneTokens().length, 1, 'the lane is a token every console on the machine counts');

  let admitted = false;
  const second = beta.admit({ slug: 'two', phase: 4, runId: 'run-b', scope: ['repo-b'] }).then((grant) => { admitted = true; return grant; });
  await tick();
  await tick();
  assert.equal(admitted, false, 'a disjoint scope on another console still waits: the machine is full');

  const entry = beta.snapshot().entries.find((e) => e.slug === 'two');
  assert.ok(entry, 'the lane is queued, not refused');
  const holder = entry.waitingOn.find((h) => h.slug === MACHINE_HOLDER);
  assert.ok(holder, `the holder is the machine cap: ${JSON.stringify(entry.waitingOn)}`);
  assert.equal(holder.instance?.id, '11111111-alpha', 'and it names the OTHER console');
  assert.match(holder.owner, /the machine is full — 1 of 1 lane: alpha \(one P1\)/);
  assert.deepEqual(beta.snapshot().machine, { live: 1, max: 1 });
  // The console's own ceiling is a different sentence, and it is not the one in force.
  assert.ok(!entry.waitingOn.some((h) => h.slug === 'session cap'));

  // The first console gives its lane back; the second hears it through the token directory.
  alpha.release(first);
  const grant = await Promise.race([
    second,
    new Promise<null>((resolve) => setTimeout(() => { beta.poll(); }, 1_500)).then(() => second),
  ]);
  assert.equal(grant.slug, 'two', 'releasing the first admits the second');
  assert.equal(liveLaneTokens().length, 1);
  assert.equal(liveLaneTokens()[0]!.instance, '22222222-beta');
  beta.release(grant);
  assert.equal(liveLaneTokens().length, 0, 'and the machine is empty again');
  assert.ok(laneTokensDir().endsWith('/fleet/lanes'));
});

test('FLT-7: with no machine ceiling a lane is still counted, and the console cap alone decides', async (t) => {
  const { MachineLanes } = await import('../server/fleet.ts');
  const { liveLaneTokens } = await import('../shared/instances.mjs');
  const gamma = new Scheduler({ max: 2, machine: new MachineLanes('33333333-gamma', { name: 'gamma', port: () => 4557 }) });
  t.after(() => gamma.close());
  const a = await gamma.admit({ slug: 'g', phase: 1, runId: 'run-g', scope: ['x'] });
  const b = await gamma.admit({ slug: 'g', phase: 2, runId: 'run-g', scope: ['y'] });
  assert.equal(liveLaneTokens().filter((lane) => lane.instance === '33333333-gamma').length, 2);
  assert.deepEqual(gamma.snapshot().machine, { live: 2, max: null });
  gamma.release(a);
  gamma.release(b);
  assert.equal(liveLaneTokens().filter((lane) => lane.instance === '33333333-gamma').length, 0);
});


/**
 * console-open-findings O4 — the usage brake, pinned. `scheduler.test.ts` had no
 * brake test at all, which is how the finding could be true for a release
 * without anything noticing.
 *
 * Two facts, and they are deliberately different from each other:
 *
 *  - the brake is keyed by ACCOUNT and held in memory, per console. It is a
 *    reading this console's own sessions took; another console's sessions are
 *    not its to brake.
 *  - a live lane counts against the account it was ADMITTED on, for as long as
 *    it lives — `ScopeGrant.accountId`, copied from the request and never
 *    rewritten. So a lane the live wall later moves to another account is still
 *    counted where it boarded.
 *
 * That second one is what the finding names, and it is by design: the grant is
 * the record of an admission that already happened, and re-pointing it would
 * make the count disagree with the decision that produced it. What matters is
 * that it is WRITTEN DOWN — the brake reads `state.accountId` (the account
 * paying NOW) while `liveOn` counts the admitted one, and a reader who assumes
 * those are the same number will be wrong the moment an account switches.
 */
test('O4: the brake is per account, and a live lane counts against the account it boarded on', async () => {
  const s = scheduler({ max: 4 });
  const a = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'], accountId: 'acct-a' });
  await s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['web'], accountId: 'acct-b' });

  assert.equal(s.liveOn('acct-a'), 1, 'one lane boarded on acct-a');
  assert.equal(s.liveOn('acct-b'), 1);
  assert.equal(s.liveOn('acct-c'), 0, 'an account nothing boarded on holds nothing');

  // A brake on one account says nothing about another.
  assert.equal(s.brake('acct-a', { untilMs: null, pct: 96 }), true);
  assert.ok(s.brakeOf('acct-a'), 'acct-a is braked');
  assert.equal(s.brakeOf('acct-b'), null, 'acct-b is not');

  // The grant is the record of an admission that happened: releasing the lane
  // is what stops it counting, not re-pointing it at another account.
  s.release(a);
  assert.equal(s.liveOn('acct-a'), 0, 'a released lane counts nowhere');

  s.releaseBrake('acct-a');
  assert.equal(s.brakeOf('acct-a'), null, 'and the brake lifts by account too');
});

// ── S9-b — a run id is the lock-owner identity, and it was 8 hex ─────────────
// `autopilot/<runId>` is what a lane writes into `owner=`, so a run id is not
// merely a filename: it is the name two consoles use to decide whose lock a
// lock is. Eight hex digits is ~4.3e9 values, and the birthday bound over the
// runs one machine accumulates is not the comfortable margin it looks like —
// two runs sharing an id share their locks, their journal and their run file.
// Twelve costs nothing and moves the collision out of reach.
//
// FIVE readers spell the shape, in four files (`autopilotRunId`, `listRuns`
// twice, `recovery.ts`, `debug/index.ts`), and each was written independently
// against the eight. This test is the net that holds them together: a freshly
// minted id must be accepted by every one of them, so widening the writer
// without widening a reader fails here rather than in production.
const { newRun } = await import('../server/runner/state.ts');
const { autopilotOwner, autopilotRunId } = await import('../server/runner/scheduler.ts');
const { RUN_ID_RE: DEBUG_RUN_ID_RE } = await import('../server/debug/index.ts');

function mintedRunId(): string {
  return newRun({ slug: 'demo', root: '/tmp/demo' }).id;
}

test('S9-b: a minted run id is twelve lowercase hex digits', () => {
  for (let i = 0; i < 50; i++) {
    const id = mintedRunId();
    assert.match(id, /^[0-9a-f]{12}$/, `minted ${id}`);
  }
});

test('S9-b: every reader of the run-id shape accepts a minted id', () => {
  const id = mintedRunId();
  assert.equal(autopilotRunId(autopilotOwner(id)), id, 'the lock-owner round trip');
  assert.equal(DEBUG_RUN_ID_RE.test(id), true, 'debug/index.ts');
  // `listRuns` reads `run-<id>.json`; the file name is the reader's input.
  assert.match(`run-${id}.json`, /^run-([0-9a-f]{8,32})\.json$/);
});

test('S9-b: the eight-hex ids already on disk are still read', () => {
  // Widening a reader may never retire what it used to accept: every run file
  // and every lock written before this change carries an eight-hex id.
  assert.equal(autopilotRunId('autopilot/0a1b2c3d'), '0a1b2c3d');
  assert.equal(DEBUG_RUN_ID_RE.test('0a1b2c3d'), true);
});

test('S9-b: an owner that is not an autopilot lane is still nobody', () => {
  assert.equal(autopilotRunId('sam@mac'), null);
  assert.equal(autopilotRunId('autopilot/'), null);
  assert.equal(autopilotRunId('autopilot/../../etc'), null);
  assert.equal(DEBUG_RUN_ID_RE.test('../secrets'), false);
  assert.equal(DEBUG_RUN_ID_RE.test(''), false);
});

// ── PRS-2 — a peer session holder could never be capped ──────────────────────
// `isCappableBlocker` refused anything that is not `kind: 'lock'`, and a
// `session` holder — a live peer in the repository, REG-3's holder-with-no-lock
// — has no lease at all. So a SIGSTOPped hand `claude`, or one whose window was
// closed without the hook firing, held every plan in the repository behind it
// for the full 24 h peer window with nothing able to time it out. The lock-wait
// cap exists for exactly this shape: a claim nobody is behind.
const { isCappableBlocker: cappable } = await import('../server/runner/scheduler.ts');

test('PRS-2: a session peer that is not live may be capped', () => {
  const peer = (presence: 'live' | 'ended' | 'unknown') => ({
    kind: 'session' as const, slug: 'other', phase: 4, presence,
  });
  assert.equal(cappable(peer('unknown')), true, 'a stopped or unvouched peer');
  assert.equal(cappable(peer('ended')), true);
});

test('PRS-2: a LIVE session peer is never capped', () => {
  // Unchanged, and the reason the rule is `!== live` rather than a kind test:
  // a person typing in the next window is not debris, however long they take.
  assert.equal(cappable({ kind: 'session', slug: 'other', phase: 4, presence: 'live' }), false);
});

test('PRS-2: a clock holder is still never capped, session or not', () => {
  // A clock ends at a moment already known; capping it is the console
  // punishing its own policy.
  assert.equal(cappable({ kind: 'session', slug: 'other', phase: 4, presence: 'unknown', clock: true }), false);
  assert.equal(cappable({ kind: 'reserved', slug: 'other', phase: null, presence: 'unknown', clock: true }), false);
});

test('PRS-2: a sibling lane of this console is still never capped', () => {
  // `grant`/`reserved` are pipelining, not contention — D2 brought them under
  // the cap and the cure was worse than the disease.
  assert.equal(cappable({ kind: 'grant', slug: 'other', phase: 4, presence: 'unknown' }), false);
  assert.equal(cappable({ kind: 'reserved', slug: 'other', phase: 4, presence: 'unknown' }), false);
});

/* ------------------------------------------------------------------ *
 * Phase 7 — a per-REPOSITORY cap, beside the machine-wide one.
 * ------------------------------------------------------------------ */

test('P7 — the fourth isolated run on ONE repository waits on `repo cap`; another repository is admitted', async () => {
  const s = scheduler({ max: 16, maxPerRepo: () => 3 });

  // Three isolated runs of three different plans, all in `/repos/root`. Their
  // scopes are disjoint, so nothing but the cap can serialise them — which is
  // the whole point: this is a cap, not a conflict.
  const live: ScopeGrant[] = [];
  for (const [n, token] of [[1, 'api'], [2, 'web'], [3, 'docs']] as const) {
    live.push(await s.admit({
      slug: `p${n}`, phase: 1, runId: `r${n}`, scope: [token],
      branch: `pe/p${n}`, tree: `/repos/root/.worktrees/runs/p${n}/r${n}/integration`,
      repo: '/repos/root',
    }));
  }
  assert.equal(s.snapshot().live, 3, 'three disjoint scopes in one repository have no reason to queue');

  // The fourth in the SAME repository waits…
  const fourth = s.admit({
    slug: 'p4', phase: 1, runId: 'r4', scope: ['infra'],
    branch: 'pe/p4', tree: '/repos/root/.worktrees/runs/p4/r4/integration',
    repo: '/repos/root',
  });
  await tick();
  assert.ok(await pending(fourth), 'the cap must hold the fourth');
  const waiting = s.snapshot().entries.find((entry) => entry.slug === 'p4');
  assert.equal(waiting?.waitingOn[0]?.slug, 'repo cap', 'and the queue must SAY it is the cap');
  assert.match(String(waiting?.waitingOn[0]?.owner), /\/repos\/root/, '…naming the repository');

  // …while a run in ANOTHER repository is admitted at once. A cap that bound
  // the console rather than the repository would hold this one too, which is
  // exactly the bug `worktreeMaxConcurrent` alone has.
  const elsewhere = await s.admit({
    slug: 'p5', phase: 1, runId: 'r5', scope: ['api'],
    branch: 'pe/p5', tree: '/repos/other/.worktrees/runs/p5/r5/integration',
    repo: '/repos/other',
  });
  assert.equal(elsewhere.slug, 'p5');

  // Releasing one lets the fourth through — a cap, never a park.
  s.release(live[0]);
  assert.equal((await fourth).slug, 'p4');
  assert.deepEqual(s.snapshot().capacity, [
    { repo: '/repos/other', live: 1, max: 3 },
    { repo: '/repos/root', live: 3, max: 3 },
  ]);
});

test('P15 — a run\'s own repo threshold holds it below the console\'s cap, and never above it', async () => {
  const s = scheduler({ max: 16, maxPerRepo: () => 3 });
  const one = await s.admit({
    slug: 'p1', phase: 1, runId: 'r1', scope: ['api'],
    branch: 'pe/p1', tree: '/repos/root/.worktrees/runs/p1/r1/integration', repo: '/repos/root',
  });
  // A run that said `maxConcurrentPerRepo: 1` will not be the second in its
  // repository, though the console would allow three.
  const shy = s.admit({
    slug: 'p2', phase: 1, runId: 'r2', scope: ['web'],
    branch: 'pe/p2', tree: '/repos/root/.worktrees/runs/p2/r2/integration', repo: '/repos/root',
    repoCap: 1,
  });
  await tick();
  assert.ok(await pending(shy), 'the run\'s own threshold holds it');
  const waiting = s.snapshot().entries.find((entry) => entry.slug === 'p2');
  assert.equal(waiting?.waitingOn[0]?.slug, 'repo cap');
  assert.match(String(waiting?.waitingOn[0]?.owner), /1 of 1/, 'the sentence names the run\'s own number');
  // …while a run that asked for MORE than the console allows is clamped to
  // the console's number: the second and third are admitted, the fourth waits.
  const bold2 = await s.admit({
    slug: 'p3', phase: 1, runId: 'r3', scope: ['docs'],
    branch: 'pe/p3', tree: '/repos/root/.worktrees/runs/p3/r3/integration', repo: '/repos/root', repoCap: 9,
  });
  const bold3 = await s.admit({
    slug: 'p4', phase: 1, runId: 'r4', scope: ['infra'],
    branch: 'pe/p4', tree: '/repos/root/.worktrees/runs/p4/r4/integration', repo: '/repos/root', repoCap: 9,
  });
  const bold4 = s.admit({
    slug: 'p5', phase: 1, runId: 'r5', scope: ['ops'],
    branch: 'pe/p5', tree: '/repos/root/.worktrees/runs/p5/r5/integration', repo: '/repos/root', repoCap: 9,
  });
  await tick();
  assert.ok(await pending(bold4), 'a run cannot outbid the console\'s cap');
  assert.match(String(s.snapshot().entries.find((entry) => entry.slug === 'p5')?.waitingOn[0]?.owner), /3 of 3/);
  // One release lets the fourth through under the console's cap…
  s.release(one);
  const fourth = await bold4;
  assert.equal(fourth.slug, 'p5');
  // …and the shy run boards only once its repository is EMPTY — a threshold
  // of one means "beside nobody", so every other grant has to go first.
  s.release(bold2);
  s.release(bold3);
  await tick();
  assert.ok(await pending(shy), 'one lane still live is one too many for a threshold of one');
  s.release(fourth);
  assert.equal((await shy).slug, 'p2');
});

test('P7 — a run with NO repo key is never capped, and never counts against one', async () => {
  const s = scheduler({ max: 16, maxPerRepo: () => 1 });
  // A shared-checkout run states no tree and no repository: it is serialised
  // by scope, which is a stronger guarantee than a count. Counting it would
  // cap a repository against runs that are already taking turns in it.
  const a = await s.admit({ slug: 'a', phase: 1, runId: 'r1', scope: ['api'] });
  const b = await s.admit({ slug: 'b', phase: 1, runId: 'r2', scope: ['web'] });
  assert.equal(s.snapshot().live, 2);
  assert.deepEqual(s.snapshot().capacity, [], 'an uncapped run appears in no repository tally');
  s.release(a);
  s.release(b);
});

/* ------------------------------------------------------------------ *
 * The snapshot's `order` — the scan order, stamped (phase 9)
 * ------------------------------------------------------------------ */

test('snapshot stamps each entry with its scan position: a bumped entry reads first while arrival order stands', async () => {
  const s = scheduler({ max: 1 });
  const head = await s.admit({ slug: 'head', phase: 1, runId: 'r0', scope: ['api'] });
  s.admit({ slug: 'first', phase: 1, runId: 'r1', scope: ['api'] }).catch(() => {});
  s.admit({ slug: 'second', phase: 1, runId: 'r2', scope: ['api'] }).catch(() => {});
  await tick();
  // Arrival order is the array's order and, with nothing bumped, the scan order too.
  assert.deepEqual(s.snapshot().entries.map((entry) => [entry.slug, entry.order]), [['first', 0], ['second', 1]]);

  const second = s.snapshot().entries.find((entry) => entry.slug === 'second')!;
  assert.ok(s.bump(second.id));
  // The array keeps arrival order — every reader of it still sees the queue it always saw —
  // while `order` says who the scan will reach first.
  assert.deepEqual(s.snapshot().entries.map((entry) => [entry.slug, entry.order]), [['first', 1], ['second', 0]]);
  s.release(head);
  s.close();
});

/* ------------------------------------------------------------------ *
 * The radar hold — `radarSerialize` (phase 9)
 * ------------------------------------------------------------------ */

