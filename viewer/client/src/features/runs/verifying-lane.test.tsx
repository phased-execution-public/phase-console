/**
 * The console's own lane on the Runs page (control-tower phase 89, #68's
 * 2026-09-25 05:44Z comment).
 *
 * The instance that asked for it: a run `running` with `children: {}` while
 * the console ran `pnpm verify:local` itself for twelve minutes, holding P56's
 * grant — and the page drew nothing working. So the first property is exactly
 * that run: `verifying: { '56': … }`, no session, the board already reading the
 * phase done, and the check's row on the board with its command, where it is
 * in the pass, its phase and its clock. Red-prove by dropping the `checks`
 * clause from `boardCards`: the run gets no card at all.
 *
 * The fold half (`verifyingLanes`, `withChecks`) is pure and gets exact
 * assertions; the row is asserted through the Tower (phase 20), the page it sits in.
 */

import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import type { ConsoleState, RunState, VerifyingLane } from '@/lib/api';

// The header's freeze control reads the console state through the shared
// query; answering it here keeps the mount off the network.
const STATE = vi.hoisted(() => ({
  allowRun: false,
  concurrency: { max: 3, live: 0, queued: 0, throttledUntil: null },
  fleet: { frozen: false, at: null, by: null },
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state: vi.fn(async () => STATE) } };
});

import type { NowLane } from '@/features/runs/lanes-model';
import { setPrefs } from '@/lib/prefs';
import { expandStrips } from '@/test/expand';
import { Tower } from './tower/tower';
import { towerModel } from './tower/tower-model';
import { nowLanes } from '@/features/runs/lanes-model';
import { verifyingLanes, withChecks } from './verifying-lane';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

type Phase = { phase: number; status: string };

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
    createdAt: '2026-09-25T05:00:00.000Z',
    updatedAt: '2026-09-25T05:44:00.000Z',
    activePhase: phases[0]?.phase ?? null,
    child: null,
    children: {},
    phases: table,
    ...over,
  } as unknown as RunState;
}

const MIN = 60_000;

/** The check the operator reported: P56's §Verification, command 3 of 5, twelve minutes in. */
const check = (over: Partial<VerifyingLane> = {}): VerifyingLane => ({
  phase: 56,
  purpose: 'verify',
  command: 'pnpm verify:local',
  index: 3,
  total: 5,
  startedAt: new Date(Date.now() - 12 * MIN).toISOString(),
  commandStartedAt: new Date(Date.now() - 2 * MIN).toISOString(),
  pid: 4242,
  ...over,
});

const child = (phase: number) => ({
  pid: 100 + phase,
  phase,
  sessionId: `s${phase}`,
  startedAt: '2026-09-25T05:00:00.000Z',
});

function mount(runs: RunState[]) {
  setPrefs({ stripsOpen: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['state'], STATE);
  const result = render(
    <QueryClientProvider client={client}>
      <Tower
        model={towerModel({ runs, lanes: nowLanes(runs), now: Date.now() })}
        state={STATE as unknown as ConsoleState}
        allowRun={false}
        totalRuns={runs.length}
      />
    </QueryClientProvider>,
  );
  // Each run is a strip (control-tower phase 19): its lanes and checks are the
  // strip's detail, one press away — open every strip, in place.
  expandStrips();
  return result;
}

const cardFor = (slug: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-testid="board-card"][data-slug="${slug}"]`)!;

/* ------------------------------------------------------------------ *
 * The row, on the board
 * ------------------------------------------------------------------ */

describe('the console’s own lane on the Runs board', () => {
  it('draws a run with no session and a check as working, with the check’s own row', () => {
    // The reported instance: the session declared complete (the board reads
    // P56 done), `children` is empty, and the console is three commands into
    // the phase's §Verification. Nothing of the lane fold stands for it.
    const trade = run({ id: 'r-trade', slug: 'trade', verifying: { '56': check() } }, [
      { phase: 56, status: 'done' },
    ]);
    mount([trade]);

    const card = cardFor('trade');
    expect(card).toBeTruthy();
    // Live, never filed as waiting: its one live thing is the console's own check.
    expect(card.dataset.bay).toBe('live');

    const row = within(card).getByTestId('verifying-lane');
    expect(row.dataset.phase).toBe('56');
    const text = row.textContent ?? '';
    expect(text).toContain('P56');
    expect(text).toContain('pnpm verify:local');
    expect(text).toContain('command 3 of 5');
    expect(text).toContain('§Verification');
    expect(text).toContain("the console's own check — no session");
    expect(text).not.toContain('clean checkout');
    // The one vocabulary's badge, never a hue of its own: the typed family's
    // phase word `verifying`, drawn with its icon and painted by the model.
    const badge = row.querySelector('[data-status="verifying"]');
    expect(badge?.getAttribute('data-paint')).toBe('verifying');
    expect(badge?.textContent).toBe('Verifying');
    expect(row.querySelector('[data-state]')).toBeNull();
    // The command is monospace and whole on hover however the row truncates it.
    expect(within(row).getByTitle('pnpm verify:local').className).toContain('font-mono');
    // The clock is the PASS's, a ticking <time> like a lane's elapsed.
    expect(row.querySelector('time')?.getAttribute('datetime')).toMatch(/^PT12M/);
  });

  it('draws no such row for a run the console is not checking', () => {
    const quiet = run({ id: 'r-q', slug: 'quiet', children: { 7: child(7) } }, [
      { phase: 7, status: 'running' },
    ]);
    const empty = run({ id: 'r-e', slug: 'empty', children: { 8: child(8) }, verifying: {} }, [
      { phase: 8, status: 'running' },
    ]);
    mount([quiet, empty]);
    expect(screen.getAllByTestId('board-card')).toHaveLength(2);
    expect(screen.getAllByTestId('board-lane')).toHaveLength(2);
    expect(screen.queryByTestId('verifying-lane')).toBeNull();
  });

  it('stands the check in for a lane with no session, and beside one that has a session', () => {
    // P56 reads `verifying` with no child: that lane IS the check, so one row.
    // P12 has a live session AND a baseline running (rare): both are real.
    const both = run(
      {
        id: 'r-b',
        slug: 'both',
        children: { 12: child(12) },
        verifying: {
          '56': check(),
          '12': check({ phase: 12, purpose: 'baseline', command: 'npm test', index: 1, total: 2 }),
        },
      },
      [
        { phase: 12, status: 'running' },
        { phase: 56, status: 'verifying' },
      ],
    );
    mount([both]);

    const card = cardFor('both');
    const lanes = within(card).getAllByTestId('board-lane');
    expect(lanes.map((row) => row.textContent?.match(/P\d+/)?.[0])).toEqual(['P12']);
    const checks = within(card).getAllByTestId('verifying-lane');
    expect(checks.map((row) => row.dataset.phase).sort()).toEqual(['12', '56']);
    expect(checks.find((row) => row.dataset.phase === '12')?.textContent).toContain(
      'baseline · command 1 of 2',
    );
  });

  it('words each pass, and says when it runs in a clean checkout', () => {
    const gate = run(
      {
        id: 'r-g',
        slug: 'gate',
        verifying: { '9': check({ phase: 9, purpose: 'wip-gate', exported: true, command: 'npm run lint' }) },
      },
      [{ phase: 9, status: 'running' }],
    );
    mount([gate]);
    const text = within(cardFor('gate')).getByTestId('verifying-lane').textContent ?? '';
    expect(text).toContain('wrap-up gate · command 3 of 5');
    expect(text).toContain('clean checkout');
  });
});

/* ------------------------------------------------------------------ *
 * The fold
 * ------------------------------------------------------------------ */

describe('verifyingLanes', () => {
  it('reads the checks in phase order, and nothing from a server that sends none', () => {
    const r = run(
      { id: 'r', slug: 's', verifying: { '9': check({ phase: 9 }), '4': check({ phase: 4 }) } },
      [],
    );
    expect(verifyingLanes(r).map((c) => c.phase)).toEqual([4, 9]);
    expect(verifyingLanes(run({ id: 'r', slug: 's' }, []))).toEqual([]);
    expect(verifyingLanes({})).toEqual([]);
  });
});

describe('withChecks', () => {
  const lane = (phase: number, over: Partial<NowLane> = {}): NowLane => ({
    key: `r#${phase}`,
    slug: 's',
    planTitle: 'S',
    runId: 'r',
    phase,
    status: 'running',
    runStatus: 'running',
    costUsd: 0,
    attempts: 1,
    frozen: false,
    enriched: false,
    ...over,
  });
  const shape = (rows: ReturnType<typeof withChecks>) =>
    rows.map((row) => (row.kind === 'lane' ? `lane ${row.lane.phase}` : `check ${row.check.phase}`));

  it('keeps the lanes untouched and in order when nothing is verifying', () => {
    expect(shape(withChecks([lane(3), lane(1)], []))).toEqual(['lane 3', 'lane 1']);
  });

  it('puts a check in place of its lane when that lane has no session', () => {
    const rows = withChecks(
      [lane(3, { child: child(3) }), lane(56, { status: 'verifying' }), lane(7)],
      [check()],
    );
    expect(shape(rows)).toEqual(['lane 3', 'check 56', 'lane 7']);
  });

  it('draws both when the lane has a session — a QA round counts as one', () => {
    expect(shape(withChecks([lane(12, { child: child(12) })], [check({ phase: 12 })]))).toEqual([
      'lane 12',
      'check 12',
    ]);
    expect(
      shape(withChecks([lane(12, { status: 'done', qa: { round: 1 } })], [check({ phase: 12 })])),
    ).toEqual(['lane 12', 'check 12']);
  });

  it('adds a check whose phase has no lane after the lanes', () => {
    expect(shape(withChecks([lane(3)], [check()]))).toEqual(['lane 3', 'check 56']);
    expect(shape(withChecks([], [check()]))).toEqual(['check 56']);
  });
});
