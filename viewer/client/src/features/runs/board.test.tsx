/**
 * The orchestration board.
 *
 * Two halves, tested as two halves. The FOLD (`boardCards`, `columnOf`,
 * `suggestedOrder`) is pure and gets exact assertions with no DOM in them; the
 * BOARD is mounted against a mocked `api` so that "every inline control
 * round-trips" is a fact about the wire rather than about a button existing.
 *
 * The properties worth pinning, in the order they would break:
 *
 *  1. **A frozen LANE does not freeze the run.** The commonest wrong fold, and
 *     the one that would put a running run in the Frozen column and offer it a
 *     Thaw it does not want. Asserted with a run that has one frozen lane and
 *     one running one, beside a run whose only lane is frozen.
 *  2. **Every verb goes through the shared hook**, which the source guard in
 *     `lib/run-lifecycle.test.ts` already pins by mention — here it is pinned
 *     by BEHAVIOUR: pressing Freeze reaches `api.runFreeze`.
 *  3. **Freeze all confirms.** It is one reflex from Stop, and unlike Stop it
 *     acts on every run on the machine.
 *  4. **The advisory declines more often than it speaks.** An estimate that
 *     exists only sometimes must be silent the rest of the time, or a made-up
 *     ordering is indistinguishable from a measured one.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { ConsoleState, QueueAdvice, QueueEntry, RunState } from '@/lib/api';

const doors = vi.hoisted(() => ({
  runFreeze: vi.fn(async () => ({ run: null })),
  runThaw: vi.fn(async () => ({ run: null })),
  runStop: vi.fn(async () => ({ run: null })),
  runPause: vi.fn(async () => ({ run: null })),
  runResume: vi.fn(async () => ({ run: null })),
  runHold: vi.fn(async () => ({ run: null })),
  runRelease: vi.fn(async () => ({ run: null })),
  runSettings: vi.fn(async () => ({ run: null })),
  queueBump: vi.fn(async () => ({})),
  fleetFreeze: vi.fn(async () => ({ runs: 2 })),
  fleetThaw: vi.fn(async () => ({ runs: 2 })),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, ...doors } };
});

import { RunsBoard, boardCards, columnCards, columnOf, suggestedOrder } from './board';
import { nowLanes } from '@/features/now/model';

/* ------------------------------------------------------------------ *
 * Fixtures — the five-run situation the plan's exit criterion names
 * ------------------------------------------------------------------ */

type Phase = { phase: number; status: string; attempts?: number; costUsd?: number };

function run(over: Partial<RunState> & { id: string; slug: string }, phases: Phase[]): RunState {
  const table: Record<string, unknown> = {};
  for (const p of phases) table[String(p.phase)] = { attempts: 1, costUsd: 0, ...p };
  return {
    root: '/repo',
    status: 'running',
    model: 'opus',
    autonomy: 'keep-going',
    spentUsd: 1,
    runBudgetUsd: 10,
    createdAt: '2026-08-27T09:00:00.000Z',
    updatedAt: '2026-08-27T10:00:00.000Z',
    activePhase: phases[0]?.phase ?? null,
    phases: table,
    ...over,
  } as unknown as RunState;
}

const child = (phase: number, over: Record<string, unknown> = {}) => ({
  pid: 100 + phase,
  phase,
  sessionId: `s${phase}`,
  startedAt: '2026-08-27T09:30:00.000Z',
  ...over,
});

/** Two running (one with a frozen lane), one queued, one waiting, one held. */
function fleet(): RunState[] {
  return [
    run({ id: 'r-alpha', slug: 'alpha', children: { 3: child(3) } }, [{ phase: 3, status: 'running' }]),
    run(
      {
        id: 'r-beta',
        slug: 'beta',
        children: { 4: child(4), 5: child(5, { frozen: { at: 'x', by: 'me' } }) },
      },
      [
        { phase: 4, status: 'running' },
        { phase: 5, status: 'running' },
      ],
    ),
    run({ id: 'r-gamma', slug: 'gamma', status: 'queued' }, [{ phase: 1, status: 'queued' }]),
    run({ id: 'r-delta', slug: 'delta', status: 'waiting' }, [{ phase: 2, status: 'parked' }]),
    run({ id: 'r-eps', slug: 'eps', status: 'queued', hold: { at: '2026-08-27T09:00:00.000Z', by: 'me' } }, [
      { phase: 7, status: 'queued' },
    ]),
  ];
}

const ENTRY: QueueEntry = {
  id: 'e1',
  slug: 'gamma',
  phase: 1,
  runId: 'r-gamma',
  scope: ['repo'],
  since: Date.parse('2026-08-27T09:55:00.000Z'),
  waitingOn: [
    { kind: 'grant', slug: 'alpha', phase: 3, owner: 'console', scope: ['repo'], overlaps: ['repo'] },
  ],
  bypassed: 0,
  reserving: false,
};

const STATE = {
  allowRun: true,
  concurrency: { max: 3, live: 2, queued: 2, throttledUntil: null },
  fleet: { frozen: false, at: null, by: null },
} as unknown as ConsoleState;

function mount(
  over: { runs?: RunState[]; state?: ConsoleState; entries?: QueueEntry[]; advice?: QueueAdvice[] } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const state = over.state ?? STATE;
  // The header's freeze pair is `components/fleet-freeze.tsx` now, and that
  // component reads the console state from the SHARED query rather than from a
  // prop — which is the point of it: one answer to "may this console run", not
  // a copy handed down that can go stale. Seeding the cache is what the running
  // app does for free, so the test does it explicitly.
  client.setQueryData(['state'], state);
  const onShowTable = vi.fn();
  const result = render(
    <QueryClientProvider client={client}>
      <RunsBoard
        runs={over.runs ?? fleet()}
        state={state}
        entries={over.entries ?? [ENTRY]}
        advice={over.advice}
        allowRun={over.state ? Boolean(over.state.allowRun) : true}
        onShowTable={onShowTable}
        totalRuns={(over.runs ?? fleet()).length}
      />
    </QueryClientProvider>,
  );
  return { ...result, onShowTable };
}

/** The card for one plan. Queried by slug because the columns re-order. */
const cardFor = (slug: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-testid="board-card"][data-slug="${slug}"]`)!;

beforeEach(() => {
  for (const door of Object.values(doors)) door.mockClear();
});

/* ------------------------------------------------------------------ *
 * The fold
 * ------------------------------------------------------------------ */

describe('columnOf', () => {
  it('leaves a run with ONE frozen lane running, and files one with only frozen lanes as frozen', () => {
    // The rule that is easy to get backwards. A freeze is a SIGSTOP, so a
    // frozen lane's status is still `running`; asking "is anything running"
    // before "is this frozen" files a stopped run under Running and offers it
    // a Stop where it wants a Thaw. Red-prove by moving the frozen test below
    // the bucket test: `solo` moves to `running`.
    const runs = fleet();
    const lanes = nowLanes(runs);
    const beta = runs.find((r) => r.id === 'r-beta')!;
    const betaLanes = lanes.filter((l) => l.runId === 'r-beta');
    expect(betaLanes.filter((l) => l.frozen)).toHaveLength(1);
    expect(columnOf(beta, betaLanes)).toBe('running');

    const solo = run(
      { id: 'r-solo', slug: 'solo', children: { 1: child(1, { frozen: { at: 'x', by: 'me' } }) } },
      [{ phase: 1, status: 'running' }],
    );
    expect(columnOf(solo, nowLanes([solo]))).toBe('frozen');
  });

  it('reads a RUN-level freeze whatever its lanes say', () => {
    const frozen = run({ id: 'r-f', slug: 'f', status: 'frozen', children: { 1: child(1) } }, [
      { phase: 1, status: 'running' },
    ]);
    expect(columnOf(frozen, nowLanes([frozen]))).toBe('frozen');
  });

  it('prefers running to queued when a run is doing both', () => {
    // A run with three lanes, one of them moving, is a run whose clock is
    // spending money. Filing it under Queued would bury the only card on the
    // board whose cost is going up.
    const mixed = run({ id: 'r-m', slug: 'm', children: { 1: child(1) } }, [
      { phase: 1, status: 'running' },
      { phase: 2, status: 'queued' },
    ]);
    expect(columnOf(mixed, nowLanes([mixed]))).toBe('running');
  });
});

describe('boardCards', () => {
  it('puts the plan’s five-run situation in five places, one card each', () => {
    const runs = fleet();
    const cards = boardCards(runs, nowLanes(runs), [ENTRY]);
    const where = Object.fromEntries(cards.map((c) => [c.run.slug, c.column]));
    expect(where).toEqual({
      alpha: 'running',
      beta: 'running',
      gamma: 'queued',
      delta: 'waiting',
      eps: 'queued',
    });
    expect(columnCards(cards, 'running').map((c) => c.run.slug)).toEqual(['alpha', 'beta']);
  });

  it('attaches the queue entry to the run whose queued lane it is about', () => {
    const runs = fleet();
    const cards = boardCards(runs, nowLanes(runs), [ENTRY]);
    expect(cards.find((c) => c.run.slug === 'gamma')?.entry?.id).toBe('e1');
    // `eps` is queued too and has no entry in the snapshot — an absent entry is
    // "the scheduler has not answered", never another run's.
    expect(cards.find((c) => c.run.slug === 'eps')?.entry).toBeUndefined();
  });

  it('draws no card for a run the lane fold dropped', () => {
    // The board and the strip above it read ONE fold. A finished run has no
    // lane in it, so it has no card — the table is where it lives.
    const done = run({ id: 'r-d', slug: 'done', status: 'finished' }, [{ phase: 1, status: 'done' }]);
    expect(boardCards([done], nowLanes([done]))).toEqual([]);
  });
});

describe('suggestedOrder', () => {
  const entries = (...slugs: string[]): QueueEntry[] =>
    slugs.map((slug, i) => ({ ...ENTRY, id: `e${i}`, slug, runId: `r-${slug}` }));
  const advice = (rows: [string, number | null][]): QueueAdvice[] =>
    rows.map(([slug, remainingWeight]) => ({ slug, remainingWeight, remainingPhases: null, label: null }));

  it('names the lightest queued plan when it is not already at the head', () => {
    const out = suggestedOrder(
      entries('alpha', 'beta'),
      advice([
        ['alpha', 300_000],
        ['beta', 40_000],
      ]),
    );
    expect(out).toMatchObject({ slug: 'beta', ahead: 'alpha', remainingWeight: 40_000 });
    expect(out?.demote).toEqual(['alpha']);
  });

  it('says nothing when the lightest plan already leads', () => {
    // Advice that restates what is already happening is noise, and noise is
    // how an advisory line stops being read.
    expect(
      suggestedOrder(
        entries('beta', 'alpha'),
        advice([
          ['alpha', 300_000],
          ['beta', 40_000],
        ]),
      ),
    ).toBeNull();
  });

  it('says nothing without two MEASURED plans', () => {
    // An estimate exists only once something of that plan has finished. A
    // suggestion built on a missing weight would look exactly like one built
    // on a measured one.
    expect(suggestedOrder(entries('alpha', 'beta'), advice([['beta', 40_000]]))).toBeNull();
    expect(
      suggestedOrder(
        entries('alpha', 'beta'),
        advice([
          ['alpha', 300_000],
          ['beta', null],
        ]),
      ),
    ).toBeNull();
    expect(suggestedOrder(entries('alpha'), advice([['alpha', 10]]))).toBeNull();
    expect(suggestedOrder(undefined, undefined)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The board
 * ------------------------------------------------------------------ */

describe('RunsBoard', () => {
  it('draws four columns, each card in its own, with the holder named', () => {
    mount();
    const columns = screen.getAllByTestId('board-column');
    expect(columns.map((c) => c.dataset.column)).toEqual(['running', 'queued', 'waiting', 'frozen']);
    expect(screen.getAllByTestId('board-card')).toHaveLength(5);

    const queued = columns.find((c) => c.dataset.column === 'queued')!;
    expect(within(queued).getAllByTestId('board-card')).toHaveLength(2);
    // The holder, in the queue's own words — the same `waitingLabel` the
    // queued pane reads, so a card and a pane never disagree.
    expect(within(cardFor('gamma')).getByTestId('board-holder').textContent).toMatch(/waiting on alpha P3/);
    // `eps` is queued too and the scheduler has not named a holder for it —
    // "queued" with nothing after it, which is the honest answer and NOT
    // gamma's sentence borrowed.
    expect(within(cardFor('eps')).getByTestId('board-holder').textContent).toMatch(/^queued$/);
    // And the hold is a fact about `eps`, not a column: both cards sit in
    // Queued and only one is held.
    expect(within(queued).getAllByTestId('hold-chip')).toHaveLength(1);
    expect(within(cardFor('eps')).getByTestId('hold-chip')).toBeTruthy();
  });

  it('shows how full the console is — the figure nothing has ever drawn', () => {
    mount();
    expect(screen.getByTestId('board-lanes').textContent).toBe('2/3');
  });

  it('sends every lifecycle verb through the ONE hook', async () => {
    mount();
    const alpha = cardFor('alpha');
    fireEvent.click(within(alpha).getByRole('button', { name: /Freeze/ }));
    await waitFor(() => expect(doors.runFreeze).toHaveBeenCalledWith('alpha', undefined));

    fireEvent.click(within(alpha).getByRole('button', { name: /Pause/ }));
    await waitFor(() => expect(doors.runPause).toHaveBeenCalledWith('alpha'));

    fireEvent.click(within(alpha).getByRole('button', { name: /Hold/ }));
    await waitFor(() => expect(doors.runHold).toHaveBeenCalledWith('alpha'));
  });

  it('offers Release rather than Hold on a run already held, and Thaw on a frozen one', async () => {
    mount();
    const held = cardFor('eps');
    expect(within(held).queryByRole('button', { name: /^Hold/ })).toBeNull();
    fireEvent.click(within(held).getByRole('button', { name: /Release/ }));
    await waitFor(() => expect(doors.runRelease).toHaveBeenCalledWith('eps'));
  });

  it('sets a priority and bumps through the settings doors, never the queue order', async () => {
    mount();
    const gamma = cardFor('gamma');
    fireEvent.change(within(gamma).getByRole('combobox', { name: 'Queue priority for gamma' }), {
      target: { value: 'high' },
    });
    await waitFor(() => expect(doors.runSettings).toHaveBeenCalledWith('gamma', { priority: 'high' }));

    fireEvent.click(within(gamma).getByRole('button', { name: /Bump/ }));
    await waitFor(() => expect(doors.queueBump).toHaveBeenCalledWith('e1'));
  });

  it('carries an L2 inspector down to the raw record', async () => {
    // The `Inspector` primitive and its `raw` slot shipped with the disclosure
    // ladder and had NO consumer anywhere in the client, so "an L3 raw view
    // exists" was true of the kit and false of every page. A card shows the
    // eight facts that decide whether to care; the record behind it has forty.
    mount();
    const alpha = cardFor('alpha');
    fireEvent.click(within(alpha).getByRole('button', { name: 'inspect' }));
    expect(await screen.findByText(/Run r-alpha/)).toBeTruthy();
    // L1 inside L2: the raw record is folded until it is asked for.
    expect(screen.queryByText(/"slug": "alpha"/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Raw record/ }));
    expect(screen.getByText(/"slug": "alpha"/)).toBeTruthy();
  });

  it('names what a refused checkout got, and why, rather than only that it was refused', async () => {
    // `checkout` is what the run GOT; the refusal reason is the half an
    // operator needs, and the card has only room for the chip.
    mount({
      runs: fleet().map((r) =>
        r.slug === 'alpha'
          ? ({ ...r, checkout: 'refused', isolationRefusal: 'the trunk is not a worktree' } as RunState)
          : r,
      ),
    });
    fireEvent.click(within(cardFor('alpha')).getByRole('button', { name: 'inspect' }));
    expect(await screen.findByText(/the trunk is not a worktree/)).toBeTruthy();
  });

  it('confirms before stopping a run, and does nothing if the dialog is cancelled', async () => {
    mount();
    const alpha = cardFor('alpha');
    fireEvent.click(within(alpha).getByRole('button', { name: /Stop/ }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(doors.runStop).not.toHaveBeenCalled();
  });

  it('freezes the fleet only through the confirm, and thaws without one', async () => {
    const { unmount } = mount();
    fireEvent.click(screen.getByRole('button', { name: /Freeze all/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(doors.fleetFreeze).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Freeze all' }));
    await waitFor(() => expect(doors.fleetFreeze).toHaveBeenCalled());
    unmount();

    // Thawing restores and phase 15 made it exact, so it is one press. The
    // asymmetry is deliberate and this is what pins it.
    mount({ state: { ...STATE, fleet: { frozen: true, at: null, by: 'me' } } as unknown as ConsoleState });
    expect(screen.getByTestId('board-frozen-chip')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Thaw all' }));
    await waitFor(() => expect(doors.fleetThaw).toHaveBeenCalled());
  });

  it('offers no control at all without --allow-run, and still draws the board', () => {
    // A read-only console must still be readable. What it must not do is offer
    // a button that answers 403.
    mount({ state: { ...STATE, allowRun: false } as unknown as ConsoleState });
    expect(screen.getAllByTestId('board-card')).toHaveLength(5);
    expect(screen.queryByRole('button', { name: /Freeze all/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Stop/ })).toBeNull();
  });

  it('applies the suggested order as ONE raise and the rest levelled', async () => {
    // Three classes cannot express an N-way ordering, and the button says so.
    mount({
      entries: [
        { ...ENTRY, id: 'e1', slug: 'gamma', runId: 'r-gamma' },
        { ...ENTRY, id: 'e2', slug: 'eps', runId: 'r-eps' },
      ],
      advice: [
        { slug: 'gamma', remainingWeight: 400_000, remainingPhases: 4, label: null },
        { slug: 'eps', remainingWeight: 50_000, remainingPhases: 1, label: null },
      ],
    });
    const advice = screen.getByTestId('board-advice');
    expect(advice.textContent).toMatch(/let eps go first/);
    fireEvent.click(within(advice).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(doors.runSettings).toHaveBeenCalledWith('eps', { priority: 'high' }));
    await waitFor(() => expect(doors.runSettings).toHaveBeenCalledWith('gamma', { priority: 'normal' }));
  });

});
