/**
 * The console's own lane (7.0, quiet-console phase 11; the cases of
 * `features/runs/verifying-lane.test.tsx`, control-tower phase 89, #68's
 * 2026-09-25 05:44Z comment).
 *
 * The instance that asked for it: a run `running` with `children: {}` while
 * the console ran `pnpm verify:local` itself for twelve minutes, holding P56's
 * grant — and the page drew nothing working. So the first property is exactly
 * that run: `verifying: { '56': … }`, no session, the board already reading the
 * phase done — filed live by the home's fold, never waiting, and its check
 * drawn among the run's lanes with its command, where it is in the pass, its
 * phase and its clock.
 *
 * The fold half (`verifyingLanes`, `withChecks`) is pure and gets exact
 * assertions; the line is asserted where the run view draws it, `RunLanes`.
 */

import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

// The lanes' neighbours fetch on their own; a lane's newest event is not this suite's.
vi.mock('./activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./activity')>()),
  LastActivity: () => null,
}));
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  return { ...actual, request: async () => ({ live: false }) };
});

import type { PlanDetail, RunState, VerifyingLane } from '@/data/api';
import { nowLanes, type NowLane } from '@/data/lanes';
import { groupRuns } from '@/data/run-groups';
import { RunLanes } from './lanes';
import { VerifyingLaneRow, verifyingLanes, withChecks } from './verifying';

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

const detailOf = (slug: string) => ({ summary: { slug }, phases: [] }) as unknown as PlanDetail;

function mount(r: RunState) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RunLanes slug={r.slug} run={r} detail={detailOf(r.slug)} live allowRun={false} />
    </QueryClientProvider>,
  );
}

/** Every line of the lane list, in order, as `<kind> <phase>`. */
const lines = (): string[] =>
  [...screen.getByTestId('run-lanes').querySelectorAll<HTMLElement>('li[data-testid]')].map(
    (li) => `${li.dataset.testid === 'verifying-lane' ? 'check' : 'lane'} ${li.dataset.phase}`,
  );

/* ------------------------------------------------------------------ *
 * The line, among the run's lanes
 * ------------------------------------------------------------------ */

describe('the console’s own lane on a run’s page', () => {
  it('draws a run with no session and a check as working, with the check’s own line', () => {
    // The reported instance: the session declared complete (the board reads
    // P56 done), `children` is empty, and the console is three commands into
    // the phase's §Verification. Nothing of the lane fold stands for it.
    const trade = run({ id: 'r-trade', slug: 'trade', verifying: { '56': check() } }, [
      { phase: 56, status: 'done' },
    ]);
    // Live, never filed as waiting: its one live thing is the console's own check.
    const placed = groupRuns({ runs: [trade], lanes: nowLanes([trade]), now: Date.now() }).runs[0]!;
    expect(placed.bay).toBe('live');
    expect(placed.group).toBe('live');

    mount(trade);
    expect(lines()).toEqual(['check 56']);
    const row = screen.getByTestId('verifying-lane');
    const text = row.textContent ?? '';
    expect(text).toContain('P56');
    expect(text).toContain('pnpm verify:local');
    expect(text).toContain('§Verification, command 3 of 5');
    expect(text).toContain('the console’s own check with no session');
    expect(text).not.toContain('clean checkout');
    expect(text).not.toContain(' · ');
    // The one vocabulary's mark, never a hue of its own: the typed family's
    // phase word `verifying`, painted by the model.
    const badge = row.querySelector('[data-status="verifying"]');
    expect(badge?.getAttribute('data-paint')).toBe('verifying');
    expect(badge?.textContent).toBe('Verifying');
    expect(row.querySelector('[data-state]')).toBeNull();
    // The command is a machine value, whole on hover however the line cuts it.
    expect(within(row).getByTitle('pnpm verify:local').className).toContain('font-mono');
    // The clock is the PASS's, labelled, with its machine twin.
    const clock = within(row).getByTestId('check-clock');
    expect(clock.getAttribute('datetime')).toMatch(/^PT12M/);
    expect(clock.textContent).toMatch(/^verifying 12m \d{2}s$/);
  });

  it('draws no such line for a run the console is not checking', () => {
    const quiet = run({ id: 'r-q', slug: 'quiet', children: { 7: child(7) } }, [
      { phase: 7, status: 'running' },
    ]);
    const { unmount } = mount(quiet);
    expect(lines()).toEqual(['lane 7']);
    unmount();

    const empty = run({ id: 'r-e', slug: 'empty', children: { 8: child(8) }, verifying: {} }, [
      { phase: 8, status: 'running' },
    ]);
    mount(empty);
    expect(lines()).toEqual(['lane 8']);
    expect(screen.queryByTestId('verifying-lane')).toBeNull();
  });

  it('stands the check in for a lane with no session, and beside one that has a session', () => {
    // P56 reads `verifying` with no child: that lane IS the check, so one line.
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
    mount(both);
    // The session's lane, its check right after it, then the check standing in for P56.
    expect(lines()).toEqual(['lane 12', 'check 12', 'check 56']);
    const p12 = screen.getAllByTestId('verifying-lane').find((li) => li.dataset.phase === '12');
    expect(p12?.textContent).toContain('baseline, command 1 of 2');
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
    mount(gate);
    const text = screen.getByTestId('verifying-lane').textContent ?? '';
    expect(text).toContain('wrap-up gate, command 3 of 5');
    expect(text).toContain(', in a clean checkout');
  });

  it('names a pass still in its setup, and ticks by itself unless the list hands it a clock', () => {
    const pass = check();
    const started = Date.parse(pass.startedAt);
    const { rerender } = render(
      <ul>
        <VerifyingLaneRow check={check({ purpose: 'baseline', stage: 'setup', index: 1, total: 1 })} />
      </ul>,
    );
    expect(screen.getByTestId('verifying-lane').textContent).toContain('baseline setup, command 1 of 1');
    expect(screen.getByTestId('check-clock').textContent).toMatch(/^verifying 12m \d{2}s$/);

    rerender(
      <ul>
        <VerifyingLaneRow check={pass} now={started + 5 * MIN} current />
      </ul>,
    );
    expect(screen.getByTestId('check-clock').textContent).toBe('verifying 5m 00s');
    expect(screen.getByTestId('verifying-lane')).toHaveAttribute('data-current');
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
