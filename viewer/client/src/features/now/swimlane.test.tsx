/**
 * The operations board, mounted.
 *
 * `ops-model.test.ts` pins the FOLD as arithmetic. This file pins what a person
 * can actually see, because every defect this phase set out to fix was a fact
 * the fold already had and the page did not draw:
 *
 *  1. two live runs of one plan render as ONE band with TWO distinguishable
 *     lanes, each naming its own branch and checkout — the plan's first exit
 *     criterion, and the thing a flat list could not show;
 *  2. a `parked` lane says WHY (the admission cap writes its whole account to
 *     `note`, and this page used to render the bare word "parked");
 *  3. the L2 inspector exists and carries an L3 raw record — the primitive had
 *     zero consumers in the whole client before this phase;
 *  4. a clock holder is never drawn as somebody to go and find;
 *  5. a lease that does not exist is not rendered as a lease of zero.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { QueueEntry, QueueHolder, QueueSnapshot, RunState } from '@/lib/api';
import { LiveLanes } from './live-lanes';
import { WaitingRow } from './swimlane';
import { nowLanes } from './model';

const record = (over: Record<string, unknown> = {}) => ({
  phase: 4,
  status: 'running',
  attempts: 1,
  costUsd: 0.5,
  startedAt: '2026-09-01T10:00:00.000Z',
  ...over,
});

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
    since: Date.now() - 60_000,
    waitingOn: [holder()],
    bypassed: 0,
    reserving: false,
    ...over,
  }) as QueueEntry;

const snapshot = (entries: QueueEntry[]): QueueSnapshot =>
  ({ max: 4, live: 1, queued: entries.length, throttledUntil: null, grants: [], entries }) as QueueSnapshot;

const lanesOf = (runs: RunState[]) => nowLanes(runs, new Map());

const board = (props: Partial<Parameters<typeof LiveLanes>[0]> = {}) =>
  render(
    <LiveLanes
      lanes={props.lanes ?? []}
      allowRun={props.allowRun ?? true}
      signedOut={false}
      ready={0}
      needsYou={0}
      others={[]}
      {...(props.queue ? { queue: props.queue } : {})}
    />,
  );

/* ================================================================== *
 * 1 — two live runs of one repository
 * ================================================================== */

describe('two live runs of one plan, on the page', () => {
  const twoRuns = [
    run({
      id: 'runA',
      phases: { 4: record({ phase: 4 }) } as never,
      children: {
        4: {
          pid: 1,
          phase: 4,
          sessionId: 'sess-a',
          startedAt: '2026-09-01T10:00:00.000Z',
          worktree: '/tmp/demo-p4',
          branch: 'pe/demo-p4',
        },
      } as never,
    }),
    run({
      id: 'runB',
      phases: { 9: record({ phase: 9 }) } as never,
      children: {
        9: {
          pid: 2,
          phase: 9,
          sessionId: 'sess-b',
          startedAt: '2026-09-01T10:00:00.000Z',
          worktree: '/tmp/demo-p9',
          branch: 'pe/demo-p9',
        },
      } as never,
    }),
  ];

  it('draws ONE band holding TWO lanes', () => {
    board({ lanes: lanesOf(twoRuns) });
    const bands = screen.getAllByTestId('swimlane');
    expect(bands).toHaveLength(1);
    expect(bands[0]).toHaveAttribute('data-slug', 'demo');
    expect(within(bands[0]!).getAllByTestId('lane-row')).toHaveLength(2);
  });

  it('names each lane’s own branch AND its own checkout', () => {
    // The branch alone was already drawn before this phase. The checkout was
    // not — and a branch without a tree is half of the only fact that makes
    // two lanes of one plan genuinely parallel rather than serialized.
    board({ lanes: lanesOf(twoRuns) });
    const rows = screen.getAllByTestId('lane-row');
    expect(within(rows[0]!).getByText('pe/demo-p4')).toBeTruthy();
    expect(within(rows[0]!).getByText('demo-p4')).toBeTruthy();
    expect(within(rows[1]!).getByText('pe/demo-p9')).toBeTruthy();
    expect(within(rows[1]!).getByText('demo-p9')).toBeTruthy();
  });

  it('says how many CHECKOUTS the band is working in', () => {
    board({ lanes: lanesOf(twoRuns) });
    expect(screen.getByText('2 checkouts')).toBeTruthy();
  });

  it('calls two lanes in one tree ONE checkout, not two', () => {
    board({
      lanes: lanesOf([
        run({
          phases: { 4: record({ phase: 4 }), 5: record({ phase: 5 }) } as never,
          children: {
            4: { pid: 1, phase: 4, sessionId: 'a', startedAt: '2026-09-01T10:00:00.000Z' },
            5: { pid: 2, phase: 5, sessionId: 'b', startedAt: '2026-09-01T10:00:00.000Z' },
          } as never,
        }),
      ]),
    });
    expect(screen.getByText('one checkout')).toBeTruthy();
    expect(screen.getAllByText('shared root')).toHaveLength(2);
  });

  it('gives each plan its own band', () => {
    board({
      lanes: lanesOf([
        run({ id: 'a', slug: 'alpha', phases: { 1: record({ phase: 1 }) } as never }),
        run({ id: 'b', slug: 'beta', phases: { 1: record({ phase: 1 }) } as never }),
      ]),
    });
    expect(
      screen
        .getAllByTestId('swimlane')
        .map((b) => b.getAttribute('data-slug'))
        .sort(),
    ).toEqual(['alpha', 'beta']);
  });
});

/* ================================================================== *
 * 2 — a parked lane says why
 * ================================================================== */

describe('a parked lane', () => {
  it('prints the record’s own account of the park', () => {
    // The admission cap's two-hour park writes the whole sentence to `note`.
    // Before this phase, Now rendered the bare word "parked" and nothing else.
    board({
      lanes: lanesOf([
        run({
          phases: {
            4: record({
              status: 'parked',
              lifecycle: { stop: { kind: 'scope-cap' } },
              note: 'phase 4 is locked by mobin@box and has waited 120 minutes for it',
            }),
          } as never,
        }),
      ]),
    });
    expect(screen.getByTestId('park-note').textContent).toContain('waited 120 minutes');
  });
});

/* ================================================================== *
 * 3 — the L2 inspector and its L3 raw record
 * ================================================================== */

describe('the inspector', () => {
  it('opens on a lane and carries a raw record behind a disclosure', () => {
    board({ lanes: lanesOf([run({ phases: { 4: record() } as never })]) });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    expect(screen.getByText('demo — phase 4')).toBeTruthy();
    // L3. The `raw` slot had NO consumer anywhere in the client before this.
    const raw = screen.getByRole('button', { name: /Raw record/ });
    fireEvent.click(raw);
    expect(screen.getByText(/"runId": "r1"/)).toBeTruthy();
  });

  it('reads an absent branch as the run’s own ground, never as blank', () => {
    board({
      lanes: lanesOf([
        run({
          phases: { 4: record() } as never,
          children: {
            4: { pid: 1, phase: 4, sessionId: 's', startedAt: '2026-09-01T10:00:00.000Z' },
          } as never,
        }),
      ]),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    expect(screen.getByText("the run's own branch")).toBeTruthy();
    expect(screen.getByText("the run's own root")).toBeTruthy();
  });

  it('says a queued lane has nothing checked out, rather than calling it shared', () => {
    board({ lanes: lanesOf([run({ phases: { 4: record({ status: 'queued' }) } as never })]) });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    expect(screen.getAllByText('nothing checked out yet').length).toBeGreaterThan(0);
    expect(screen.queryByText('shared root')).toBeNull();
  });
});

/* ================================================================== *
 * 4 + 5 — the waiting rows
 * ================================================================== */

describe('an admission waiting for a scope', () => {
  it('gets a band even when nothing of that plan is running', () => {
    board({ lanes: [], queue: snapshot([entry({ slug: 'stuck' })]) });
    const bands = screen.getAllByTestId('swimlane');
    expect(bands).toHaveLength(1);
    expect(bands[0]).toHaveAttribute('data-slug', 'stuck');
    expect(screen.getByTestId('waiting-row')).toBeTruthy();
    // ...and it is NOT drawn as a lane: it has no process to freeze or tail.
    expect(screen.queryByTestId('lane-row')).toBeNull();
  });

  it('names a foreign claim, what collided, and when the lease ends', () => {
    render(
      <WaitingRow
        entry={entry({ waitingOn: [holder({ leaseUntil: Date.now() + 600_000, overlaps: ['repo'] })] })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /phase 7/ }));
    expect(screen.getByText('a claim on disk')).toBeTruthy();
    expect(screen.getByText(/collided on repo/)).toBeTruthy();
    expect(screen.getByText(/lease ends in/)).toBeTruthy();
  });

  it('never renders a missing lease as a lease of zero', () => {
    // A grant holds its scope for as long as it runs. `0:00` would say it is
    // about to be released, which is a different and false thing.
    render(<WaitingRow entry={entry({ waitingOn: [holder({ kind: 'grant' })] })} />);
    fireEvent.click(screen.getByRole('button', { name: /phase 7/ }));
    expect(screen.getByText('no lease')).toBeTruthy();
    expect(screen.queryByText(/lease ends in/)).toBeNull();
  });

  it('calls a lapsed lease debris', () => {
    render(<WaitingRow entry={entry({ waitingOn: [holder({ leaseUntil: Date.now() - 1000 })] })} />);
    fireEvent.click(screen.getByRole('button', { name: /phase 7/ }));
    expect(screen.getByText(/lease has lapsed/)).toBeTruthy();
  });

  it('draws a CLOCK as a policy, with nobody to name and nothing to release', () => {
    render(
      <WaitingRow
        entry={entry({
          waitingOn: [
            holder({
              kind: 'reserved',
              clock: true,
              owner: 'the boarding window',
              slug: 'boarding window',
              phase: null,
            }),
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /phase 7/ }));
    expect(screen.getByText('a clock')).toBeTruthy();
    expect(screen.getByText(/nobody to ask/)).toBeTruthy();
    // The one thing it must never say about a policy.
    expect(screen.queryByText(/held by/)).toBeNull();
  });

  it('offers a carve-out only when both dimensions differ', () => {
    render(
      <WaitingRow
        entry={entry({
          branch: 'pe/mine',
          tree: '/tmp/mine',
          waitingOn: [holder({ branch: 'pe/theirs', tree: '/tmp/theirs' })],
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /phase 7/ }));
    expect(screen.getByText(/can carve past this/)).toBeTruthy();
  });

  it('says "same ground" when the branch matches, however different the trees', () => {
    render(
      <WaitingRow
        entry={entry({
          branch: 'pe/mine',
          tree: '/tmp/mine',
          waitingOn: [holder({ branch: 'pe/mine', tree: '/tmp/theirs' })],
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /phase 7/ }));
    expect(screen.getByText(/same ground as you/)).toBeTruthy();
  });

  it('leads with the hold rather than with what it would otherwise queue on', () => {
    render(<WaitingRow entry={entry({ held: { at: 'now', by: 'mobin' } })} />);
    expect(screen.getByRole('button', { name: /held by mobin/ })).toBeTruthy();
  });

  it('carries a raw record of its own', () => {
    render(<WaitingRow entry={entry()} />);
    fireEvent.click(screen.getByRole('button', { name: /phase 7/ }));
    fireEvent.click(screen.getByRole('button', { name: /Raw record/ }));
    expect(screen.getByText(/"id": "q1"/)).toBeTruthy();
  });
});

/* ================================================================== *
 * who waits on whom, from the holding end
 * ================================================================== */

describe('a lane that is making other plans wait', () => {
  it('says so on the row', () => {
    board({
      lanes: lanesOf([run({ phases: { 4: record() } as never })]),
      queue: snapshot([
        entry({
          id: 'q1',
          slug: 'other',
          phase: 3,
          waitingOn: [holder({ kind: 'grant', slug: 'demo', phase: 4 })],
        }),
      ]),
    });
    const note = screen.getByTestId('lane-waiters');
    expect(note.textContent).toContain('1 admission is');
    expect(note.textContent).toContain('other P3');
  });

  it('stays silent when a FOREIGN lock is what is in the way', () => {
    // A lock is somebody else's session and matches no lane here. Drawing an
    // arrow from this row would point at something that holds nothing.
    board({
      lanes: lanesOf([run({ phases: { 4: record() } as never })]),
      queue: snapshot([entry({ slug: 'other', waitingOn: [holder({ kind: 'lock' })] })]),
    });
    expect(screen.queryByTestId('lane-waiters')).toBeNull();
  });
});
