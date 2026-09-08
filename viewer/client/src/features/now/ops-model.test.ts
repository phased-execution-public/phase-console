/**
 * The operations fold, as data.
 *
 * The property this file exists for is the plan's first exit criterion:
 * **two live runs on one repository must render as distinct, truthful lanes.**
 * Before the swimlane fold they were six interchangeable rows in one flat list
 * whose only distinguishing mark was a branch chip; the assertions below drive
 * the real `nowLanes` fold from two `RunState` fixtures and then prove that
 * every lane still knows which run, which branch and which checkout it is.
 *
 * The rest are the honesty rules — the ones that are invisible until they are
 * wrong, and each of which is a way a queue can lie:
 *
 *  - a lease that does not exist is not a lease of zero;
 *  - a carve-out is only offered when BOTH dimensions were declared on BOTH
 *    sides and both differ — an unqualified claim collides with everything;
 *  - a clock is never rendered as somebody to go and find;
 *  - a held run's reason is the hold, not whatever it would otherwise queue on.
 */

import { describe, expect, it } from 'vitest';
import type { QueueEntry, QueueHolder, QueueSnapshot, RunState } from '@/lib/api';
import { nowLanes, type NowLane } from './model';
import {
  carveable,
  holderKindWord,
  laneClaim,
  laneWaitKey,
  leaseLapsed,
  leaseRemainingMs,
  sameBranch,
  sameTree,
  swimlanes,
  waitIsForAPerson,
  waitSummary,
  waitedMs,
  waitersByLane,
} from './ops-model';

const NOW = Date.parse('2026-09-01T12:00:00.000Z');

const run = (over: Partial<RunState> = {}): RunState =>
  ({
    id: 'r1',
    slug: 'demo',
    root: '/tmp/demo',
    status: 'running',
    autonomy: 'keep-going',
    model: 'opus',
    phaseBudgetUsd: null,
    runBudgetUsd: null,
    spentUsd: 1,
    maxConsecutiveFailures: 2,
    consecutiveFailures: 0,
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T11:00:00.000Z',
    activePhase: 4,
    child: null,
    waitUntil: null,
    halt: null,
    pause: null,
    freeze: null,
    phases: {},
    ...over,
  }) as unknown as RunState;

const record = (over: Record<string, unknown> = {}) => ({
  phase: 4,
  status: 'running',
  attempts: 1,
  costUsd: 0.5,
  startedAt: '2026-09-01T10:00:00.000Z',
  ...over,
});

const child = (over: Record<string, unknown> = {}) => ({
  pid: 100,
  phase: 4,
  sessionId: 'sess-a',
  startedAt: '2026-09-01T10:00:00.000Z',
  ...over,
});

const holder = (over: Partial<QueueHolder> = {}): QueueHolder =>
  ({
    kind: 'lock',
    slug: 'other',
    phase: 2,
    owner: 'someone@box',
    scope: ['repo'],
    overlaps: ['repo'],
    ...over,
  }) as QueueHolder;

const entry = (over: Partial<QueueEntry> = {}): QueueEntry =>
  ({
    id: 'q1',
    slug: 'demo',
    phase: 7,
    runId: 'r1',
    scope: ['repo'],
    since: NOW - 5 * 60_000,
    waitingOn: [holder()],
    bypassed: 0,
    reserving: false,
    ...over,
  }) as QueueEntry;

const snapshot = (entries: QueueEntry[]): QueueSnapshot =>
  ({ max: 4, live: 2, queued: entries.length, throttledUntil: null, grants: [], entries }) as QueueSnapshot;

/* ================================================================== *
 * Exit criterion 1 — two live runs on one repository
 * ================================================================== */

describe('two live runs of one plan', () => {
  // Both runs are of ONE plan, in ONE repository, each driving its own phase in
  // its own checkout. This is the arrangement the whole worktree feature exists
  // for and the one the flat lane list could not draw.
  const twoRuns = [
    run({
      id: 'runA',
      phases: { 4: record({ phase: 4 }) } as never,
      children: {
        4: child({ sessionId: 'sess-a', worktree: '/tmp/demo-p4', branch: 'pe/demo-p4' }),
      } as never,
    }),
    run({
      id: 'runB',
      phases: { 9: record({ phase: 9, startedAt: '2026-09-01T10:30:00.000Z' }) } as never,
      children: {
        9: child({ phase: 9, sessionId: 'sess-b', worktree: '/tmp/demo-p9', branch: 'pe/demo-p9' }),
      } as never,
    }),
  ];

  it('folds into ONE band whose lanes are distinct records', () => {
    const bands = swimlanes(nowLanes(twoRuns, new Map(), NOW), undefined, NOW);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.slug).toBe('demo');
    expect(bands[0]!.lanes).toHaveLength(2);
    // The lane keys are `${runId}#${phase}` — distinct on BOTH halves here, so
    // a fold that dropped either would collide them into one row.
    expect(new Set(bands[0]!.lanes.map((l) => l.key)).size).toBe(2);
    expect(bands[0]!.lanes.map((l) => l.runId).sort()).toEqual(['runA', 'runB']);
  });

  it('gives each lane its own branch, checkout and session', () => {
    const bands = swimlanes(nowLanes(twoRuns, new Map(), NOW), undefined, NOW);
    const claims = bands[0]!.lanes.map((l) => laneClaim(l));
    expect(claims.map((c) => c.branch).sort()).toEqual(['pe/demo-p4', 'pe/demo-p9']);
    expect(claims.map((c) => c.tree).sort()).toEqual(['/tmp/demo-p4', '/tmp/demo-p9']);
    expect(claims.map((c) => c.session).sort()).toEqual(['sess-a', 'sess-b']);
    // Neither is sharing, and neither is pending: both have a real checkout.
    expect(claims.every((c) => !c.shared && !c.pending)).toBe(true);
  });

  it('counts the distinct CHECKOUTS, which is what makes them parallel', () => {
    const bands = swimlanes(nowLanes(twoRuns, new Map(), NOW), undefined, NOW);
    expect(bands[0]!.trees).toBe(2);
  });

  it('counts two lanes sharing the root as ONE checkout, not two', () => {
    // The normal arrangement, and it must not read as parallelism it does not
    // have: one tree, two lanes, serialized by the tree they share.
    const shared = [
      run({
        id: 'runA',
        phases: { 4: record({ phase: 4 }), 5: record({ phase: 5 }) } as never,
        children: { 4: child({ phase: 4 }), 5: child({ phase: 5, sessionId: 'sess-b' }) } as never,
      }),
    ];
    const bands = swimlanes(nowLanes(shared, new Map(), NOW), undefined, NOW);
    expect(bands[0]!.lanes).toHaveLength(2);
    expect(bands[0]!.trees).toBe(1);
    expect(bands[0]!.lanes.map((l) => laneClaim(l).shared)).toEqual([true, true]);
  });

  it('a queued lane has no claim at all, which is not the same as sharing', () => {
    // Nothing has been checked out for it. Reporting `shared` here would claim
    // it is editing a tree it has not been given.
    const queued = [run({ phases: { 4: record({ status: 'queued' }) } as never })];
    const [lane] = nowLanes(queued, new Map(), NOW);
    const claim = laneClaim(lane as NowLane);
    expect(claim.pending).toBe(true);
    expect(claim.shared).toBe(false);
    expect(claim.branch).toBeUndefined();
    // ...and it contributes no checkout to the band's count.
    expect(swimlanes(nowLanes(queued, new Map(), NOW), undefined, NOW)[0]!.trees).toBe(0);
  });
});

/* ================================================================== *
 * Grouping must not re-rank
 * ================================================================== */

describe('the bands preserve the flat order', () => {
  it('leads with the band holding the worst lane', () => {
    const runs = [
      run({ id: 'rHealthy', slug: 'calm', phases: { 1: record({ phase: 1 }) } as never }),
      run({
        id: 'rStalled',
        slug: 'trouble',
        phases: {
          2: record({ phase: 2, liveness: { stall: { since: '2026-09-01T11:00:00.000Z' } } }),
        } as never,
      }),
    ];
    const flat = nowLanes(runs, new Map(), NOW);
    const bands = swimlanes(flat, undefined, NOW);
    // Whatever the flat fold put first, the first band leads with it.
    expect(bands[0]!.lanes[0]!.key).toBe(flat[0]!.key);
    expect(bands[0]!.slug).toBe('trouble');
  });

  it('a plan with entries and no lane still gets a band, after the running ones', () => {
    const lanes = nowLanes(
      [run({ slug: 'moving', phases: { 1: record({ phase: 1 }) } as never })],
      new Map(),
      NOW,
    );
    const bands = swimlanes(lanes, snapshot([entry({ slug: 'stuck' })]), NOW);
    expect(bands.map((b) => b.slug)).toEqual(['moving', 'stuck']);
    // "Queued behind something, nothing running" is a state the board must show.
    expect(bands[1]!.lanes).toHaveLength(0);
    expect(bands[1]!.waiting).toHaveLength(1);
  });

  it('keeps lanes and admission entries apart', () => {
    // A lane can be frozen; an entry can be bumped. Folding them into one list
    // is how a board offers Freeze on something with no process to stop.
    const lanes = nowLanes([run({ phases: { 4: record() } as never })], new Map(), NOW);
    const [band] = swimlanes(lanes, snapshot([entry()]), NOW);
    expect(band!.lanes).toHaveLength(1);
    expect(band!.waiting).toHaveLength(1);
    expect(band!.lanes[0]!.phase).toBe(4);
    expect(band!.waiting[0]!.phase).toBe(7);
  });
});

/* ================================================================== *
 * The honesty rules
 * ================================================================== */

describe('a lease that does not exist is not a lease of zero', () => {
  it('answers null for a holder with no lease', () => {
    // A `grant` holds its scope for as long as it runs. There is no instant to
    // count down to, and `0` would say it is about to be released.
    expect(leaseRemainingMs(holder({ kind: 'grant' }), NOW)).toBeNull();
    expect(leaseLapsed(holder({ kind: 'grant' }), NOW)).toBe(false);
  });

  it('measures a real lease, and calls a passed one lapsed', () => {
    expect(leaseRemainingMs(holder({ leaseUntil: NOW + 600_000 }), NOW)).toBe(600_000);
    expect(leaseLapsed(holder({ leaseUntil: NOW + 600_000 }), NOW)).toBe(false);
    expect(leaseLapsed(holder({ leaseUntil: NOW - 1 }), NOW)).toBe(true);
  });

  it('never reports a negative wait', () => {
    expect(waitedMs(entry({ since: NOW + 5_000 }), NOW)).toBe(0);
    expect(waitedMs(entry({ since: NOW - 5_000 }), NOW)).toBe(5_000);
  });
});

describe('a carve-out needs BOTH dimensions on BOTH sides', () => {
  const e = entry({ branch: 'pe/mine', tree: '/tmp/mine' });

  it('offers one only when both differ', () => {
    expect(carveable(e, holder({ branch: 'pe/theirs', tree: '/tmp/theirs' }))).toBe(true);
  });

  it('refuses when the branch matches, however different the trees', () => {
    expect(carveable(e, holder({ branch: 'pe/mine', tree: '/tmp/theirs' }))).toBe(false);
  });

  it('refuses when the tree matches, however different the branches', () => {
    expect(carveable(e, holder({ branch: 'pe/theirs', tree: '/tmp/mine' }))).toBe(false);
  });

  it('says "cannot tell" — never "different" — when either half is unstated', () => {
    // An unqualified claim collides with everything. Rendering silence as a
    // difference is how an operator concludes a carve-out was available when
    // the scheduler had already ruled it out.
    expect(carveable(e, holder({ tree: '/tmp/theirs' }))).toBeNull();
    expect(carveable(e, holder({ branch: 'pe/theirs' }))).toBeNull();
    expect(carveable(entry({ branch: 'pe/mine' }), holder({ branch: 'pe/theirs', tree: '/t' }))).toBeNull();
    expect(sameBranch(entry(), holder())).toBeNull();
    expect(sameTree(entry(), holder())).toBeNull();
  });
});

describe('a clock is not somebody to go and find', () => {
  it('names it as a clock whatever its kind says', () => {
    expect(holderKindWord(holder({ kind: 'reserved', clock: true, owner: 'the boarding window' }))).toBe(
      'a clock',
    );
    expect(holderKindWord(holder({ kind: 'lock' }))).toBe('a claim on disk');
    expect(holderKindWord(holder({ kind: 'grant' }))).toBe('another lane here');
    expect(holderKindWord(holder({ kind: 'reserved' }))).toBe('a console policy');
  });

  it('summarises a clock in its OWN words, with no slug or phase', () => {
    const clock = holder({
      kind: 'reserved',
      clock: true,
      owner: 'the boarding window',
      slug: 'boarding window',
      phase: null,
    });
    expect(waitSummary(entry({ waitingOn: [clock] }))).toBe('the boarding window');
  });

  it('is never a wait for a person', () => {
    expect(waitIsForAPerson(holder({ kind: 'reserved', clock: true, presence: 'live' }))).toBe(false);
    expect(waitIsForAPerson(holder({ kind: 'lock', presence: 'live' }))).toBe(true);
    expect(waitIsForAPerson(holder({ kind: 'lock', presence: 'unknown' }))).toBe(false);
    // A grant is this console's own lane: it ends when the lane does, and there
    // is no person in it to wait for.
    expect(waitIsForAPerson(holder({ kind: 'grant', presence: 'live' }))).toBe(false);
  });
});

describe('why an entry is not moving, in the order that outranks', () => {
  it('leads with the hold, not with what it would otherwise queue on', () => {
    // Nothing of a held run boards at all, so the holder is not the answer.
    expect(waitSummary(entry({ held: { at: 'now', by: 'mobin' }, waitingOn: [holder()] }))).toBe(
      'held by mobin',
    );
    expect(waitSummary(entry({ held: { at: 'now' }, waitingOn: [holder()] }))).toBe('held');
  });

  it('then the chain, then the holder', () => {
    expect(waitSummary(entry({ after: 'upstream', waitingOn: [holder()] }))).toBe('chained behind upstream');
    expect(waitSummary(entry())).toBe('behind other P2');
    expect(waitSummary(entry({ waitingOn: [holder({ phase: null })] }))).toBe('behind other');
    expect(waitSummary(entry({ waitingOn: [] }))).toBe('waiting for admission');
  });
});

describe('who waits on whom', () => {
  it('files an entry under the lane of this console it waits on', () => {
    const waiters = waitersByLane(
      snapshot([entry({ id: 'q1', waitingOn: [holder({ kind: 'grant', slug: 'demo', phase: 4 })] })]),
    );
    expect([...waiters.keys()]).toEqual([laneWaitKey('demo', 4)]);
    expect(waiters.get('demo#4')!.map((w) => w.id)).toEqual(['q1']);
  });

  it('leaves a FOREIGN claim out — no lane here matches it', () => {
    // A lock is somebody else's session. Filing it under a lane would draw an
    // arrow from a row that is not the one holding anything.
    expect(waitersByLane(snapshot([entry({ waitingOn: [holder({ kind: 'lock' })] })])).size).toBe(0);
    // ...and so does a grant with no phase: "the whole plan" is not a lane.
    expect(
      waitersByLane(snapshot([entry({ waitingOn: [holder({ kind: 'grant', phase: null })] })])).size,
    ).toBe(0);
  });

  it('collects several waiters behind one lane', () => {
    const behind = holder({ kind: 'grant', slug: 'demo', phase: 4 });
    const waiters = waitersByLane(
      snapshot([entry({ id: 'q1', waitingOn: [behind] }), entry({ id: 'q2', waitingOn: [behind] })]),
    );
    expect(waiters.get('demo#4')!.map((w) => w.id)).toEqual(['q1', 'q2']);
  });

  it('is empty rather than throwing when there is no queue at all', () => {
    expect(waitersByLane(undefined).size).toBe(0);
    expect(swimlanes([], undefined, NOW)).toEqual([]);
  });
});
