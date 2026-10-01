/**
 * The Runs ledger and the run page, mounted against a whole-API mock — ported
 * from `views/views.test.tsx` when Phase 11 deleted `views/`.
 *
 * These cases are about the SHELL of those two surfaces: what the header says
 * when nothing is running, that every run links to its own tab, that a queued
 * phase says what it is behind. Per-component behaviour lives beside each
 * component in the other `features/runs/*.test.tsx` files.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import { setPrefs } from '@/lib/prefs';
import { RUN_SECTIONS } from './run-sections';
import type { ConsoleState, PlanDetail, RunState } from '@/lib/api';

/* ------------------------------------------------------------------ *
 * One api mock for every view under test.
 * ------------------------------------------------------------------ */

// `vi.hoisted`, not plain `const`: a `vi.mock` factory is hoisted above every
// declaration in the file, so a top-level `const` it closes over is in its
// temporal dead zone when the factory runs. The failure reads as "Cannot access
// 'state' before initialization" from inside an unrelated module.
const { state, search, runs, notifications, browse, checkRoot, write, run, queue, runScopes } = vi.hoisted(
  () => ({
    state: vi.fn(),
    search: vi.fn(),
    runs: vi.fn(),
    notifications: vi.fn(),
    browse: vi.fn(),
    checkRoot: vi.fn(),
    write: vi.fn(),
    run: vi.fn(),
    queue: vi.fn(),
    runScopes: vi.fn(),
  }),
);

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      state,
      search,
      runs,
      notifications,
      browse,
      checkRoot,
      write,
      run,
      queue,
      runScopes,
      plans: vi.fn(async () => []),
      stats: vi.fn(async () => null),
      approvals: vi.fn(async () => []),
      auth: vi.fn(async () => ({ loggedIn: true, checkedAt: '2026-08-03T00:00:00Z' })),
      runTranscript: vi.fn(async () => []),
      policy: vi.fn(async () => {
        throw new Error('no policy endpoint');
      }),
      restartReadiness: vi.fn(async () => {
        throw new Error('no restart endpoint');
      }),
      push: vi.fn(async () => ({ publicKey: 'k', devices: [], categories: [] })),
    },
  };
});

const BASE_STATE: ConsoleState = {
  autopilot: true,
  allowRun: true,
  allowWrites: false,
  staticRoot: 'not-built',
  root: { path: '/repo', ok: true, planCount: 3, handoffCount: 2 },
  scriptsDir: '/scripts',
  sizing: { S: 15_000, M: 40_000, L: 90_000, budgetBig: 200_000, budgetHaiku: 40_000 },
  searchDocs: 42,
  supervisor: { detail: 'launchd' },
  repo: { available: true, branch: 'main', dirty: [] },
  recentRoots: [],
  unread: 0,
};

function mount(node: React.ReactElement) {
  const client = new QueryClient(queryClientConfig);
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/*
 * Every case here mounts a page through a dynamic `import()`, and vitest's
 * default per-test timeout is five seconds. In isolation that is ample; under
 * the full 95-file parallel suite it is not, and the failure surfaces as a
 * bare "Test timed out" that reads like a hung assertion rather than a slow
 * module load. Raised for the file, not retried — a test that genuinely hangs
 * must still fail.
 */
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  vi.clearAllMocks();
  state.mockResolvedValue(BASE_STATE);
  search.mockResolvedValue({ query: '', total: 0, groups: [] });
  runs.mockResolvedValue([]);
  notifications.mockResolvedValue({
    items: [],
    total: 0,
    unread: 0,
    more: false,
    categories: [],
    devices: 0,
    outOfBand: { configured: false },
  });
  browse.mockResolvedValue({ path: '/repo', parent: '/', entries: [] });
  checkRoot.mockResolvedValue({
    path: '/repo',
    ok: false,
    label: 'repo',
    planCount: 0,
    handoffCount: 0,
    reason: 'No docs/plans directory here',
  });
  write.mockResolvedValue({ dryRun: true, command: 'new-handoff.sh demo 2 x complete' });
  run.mockResolvedValue({ run: null, history: [], eta: null });
  queue.mockResolvedValue({ max: 3, live: 0, queued: 0, throttledUntil: null, grants: [], entries: [] });
  runScopes.mockResolvedValue({ scopes: [] });
  // Browser-local and therefore sticky across cases in this file: a test that
  // opens the runs console would otherwise leave it open for the next one.
  // The fleet section opens on the BOARD since phase 19; the cases here that
  // read the fleet are table cases, so the view is named rather than
  // inherited from whatever the default happens to be.
  setPrefs({ runsConsole: false, runsView: 'table' });
  window.location.hash = '';
});
/* ------------------------------------------------------------------ *
 * The write menu — the carry-forward this phase owed
 * ------------------------------------------------------------------ */

const DETAIL = {
  summary: { slug: 'demo', title: 'demo plan', kind: 'plan', phases: 3, ready: [2] },
  plan: { path: '/repo/docs/plans/demo.md' },
  phases: [],
} as unknown as PlanDetail;

/* ------------------------------------------------------------------ *
 * Runs
 * ------------------------------------------------------------------ */

const RUN = {
  id: 'abc123',
  slug: 'demo',
  root: '/repo',
  status: 'finished',
  autonomy: 'keep-going',
  model: 'opus',
  phaseBudgetUsd: null,
  runBudgetUsd: null,
  spentUsd: 1.65,
  maxConsecutiveFailures: 2,
  consecutiveFailures: 0,
  createdAt: '2026-08-03T00:00:00Z',
  updatedAt: '2026-08-03T01:00:00Z',
  activePhase: null,
  child: null,
  waitUntil: null,
  halt: null,
  pause: null,
  freeze: null,
  phases: {},
} as unknown as RunState;

describe('runs', () => {
  it('explains a stale server rather than showing a wall of failed requests', async () => {
    state.mockResolvedValue({ ...BASE_STATE, autopilot: false });
    const { default: RunsView } = await import('@/features/runs');
    mount(<RunsView />);
    expect(await screen.findByText(/older build/i)).toBeTruthy();
    expect(runs).not.toHaveBeenCalled();
  });

  it('says nothing is running rather than leaving the header empty', async () => {
    // The situation line is the header's since 6.0 (control-tower phase 21);
    // the page under it says it once, not twice.
    const { default: RunsView } = await import('@/features/runs');
    const { default: HeaderSituation } = await import('@/app/shell/situation');
    mount(
      <>
        <HeaderSituation state={BASE_STATE} phone={false} />
        <RunsView />
      </>,
    );
    expect(await screen.findByText(/Nothing running right now/i)).toBeTruthy();
    expect(screen.getAllByTestId('situation-line')).toHaveLength(1);
  });


  it('names the live run in the header when there is one', async () => {
    runs.mockResolvedValue([{ ...RUN, status: 'running', activePhase: 3 }]);
    const { default: HeaderSituation } = await import('@/app/shell/situation');
    mount(<HeaderSituation state={BASE_STATE} phone={false} />);
    expect(await screen.findByText(/demo is running — phase 3/i)).toBeTruthy();
  });

  /**
   * Issue #7: this page is about every run there has ever been, and its console
   * could reach exactly one session. With two plans live it showed one of them
   * and gave no sign the other existed.
   */
  it('reaches every live session across plans as its own tab', async () => {
    runs.mockResolvedValue([
      { ...RUN, id: 'r1', slug: 'alpha', status: 'running', activePhase: 5, phases: RECORDS(5) },
      { ...RUN, id: 'r2', slug: 'beta', status: 'running', activePhase: 2, phases: RECORDS(2) },
    ]);
    const { default: RunsView } = await import('@/features/runs');
    mount(<RunsView />);

    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['alphaP5', 'betaP2']);
  });

  /**
   * C1: the page showed a lane and then denied it existed.
   *
   * `LiveStrip` at the top of this page reads `nowLanes()`, whose lane status
   * set is seven long (`parked`, `waiting` and `gated` included); the tab strip
   * under it read a four-status list of its own. So a phase parked on an
   * external clock — the single most common thing to come looking for, because
   * it is the one that looks like nothing is happening — was listed in the
   * strip with its reason on it, and had no tab. Two folds, one page, opposite
   * answers.
   *
   * **Red before the fix**, on the tab assertion: the strip already listed the
   * parked lane, and `tabs` came back `['alpha P5']` alone.
   */
  it('gives a parked lane a tab, because the strip above it already lists one', async () => {
    runs.mockResolvedValue([
      {
        ...RUN,
        id: 'r1',
        slug: 'alpha',
        status: 'running',
        activePhase: 5,
        phases: {
          ...RECORDS(5),
          8: {
            phase: 8,
            status: 'parked',
            attempts: 1,
            costUsd: 0,
            parkReason: 'waiting on the image build',
          },
        },
      },
    ]);
    setPrefs({ runsView: 'board' });
    const { default: RunsView } = await import('@/features/runs');
    mount(<RunsView />);

    // The Tower's reading, first (control-tower phase 20 retired the live
    // strip for the bays): the run is in Live, and its parked lane is one of
    // the lanes its strip carries — which is what makes a missing tab a
    // contradiction rather than merely an omission.
    const live = await screen.findByRole('region', { name: /^Live/ });
    const strip = within(live).getByRole('article', { name: /^alpha/ });
    fireEvent.click(within(strip).getByTestId('strip-expand'));
    const lanes = within(strip)
      .getAllByTestId('board-lane')
      .map((row) => row.textContent ?? '');
    expect(lanes.some((text) => /P8/.test(text) && /parked/.test(text))).toBe(true);

    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['alphaP5', 'alphaP8']);
  });

  it('keeps the single console for a finished run, which has no lane', async () => {
    // The fallback is not dead code: a run you picked to re-read has no session
    // to tab to, and neither does a page with nothing running at all.
    runs.mockResolvedValue([RUN]);
    const { default: RunsView } = await import('@/features/runs');
    setPrefs({ runsConsole: true });
    mount(<RunsView />);

    expect(await screen.findByRole('log', { name: 'Session console' })).toBeTruthy();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * The autopilot page — one window per session
 * ------------------------------------------------------------------ */

/** Phase records, keyed by the phase number **as a string**. */
const RECORDS = (...live: number[]) =>
  Object.fromEntries(
    live.map((phase) => [String(phase), { phase, status: 'running', attempts: 1, costUsd: 0 }]),
  );

const PLAN_PHASES = [
  {
    phase: 1,
    title: 'the api',
    state: 'ready',
    size: 'M',
    weight: 40_000,
    gated: false,
    bullets: [],
    row: {
      phase: 1,
      title: 'the api',
      dependsOn: [],
      parallelSafe: '',
      repos: 'packages/cart-api',
      exitCriteria: '',
    },
  },
  {
    phase: 2,
    title: 'the docs',
    state: 'waiting',
    size: 'S',
    weight: 15_000,
    gated: false,
    bullets: [],
    row: { phase: 2, title: 'the docs', dependsOn: [1], parallelSafe: '', repos: '', exitCriteria: '' },
  },
];

const planDetail = () => ({ ...DETAIL, phases: PLAN_PHASES }) as unknown as PlanDetail;

describe('the autopilot page', () => {
  // These read what the page's folds hold, not the folds themselves
  // (`run-page.test.tsx` owns those): every section opens as a person who had
  // opened them all would find it (control-tower phase 24).
  beforeEach(() => setPrefs({ runSectionsOpen: [...RUN_SECTIONS] }));
  it('gives every live and queued phase a tab of its own, beside the run', async () => {
    run.mockResolvedValue({
      run: {
        ...RUN,
        status: 'running',
        activePhase: 1,
        phases: {
          ...RECORDS(1),
          2: { phase: 2, status: 'queued', attempts: 0, costUsd: 0 },
        },
      },
      history: [],
      eta: null,
    });
    queue.mockResolvedValue({
      max: 3,
      live: 1,
      queued: 1,
      throttledUntil: null,
      grants: [],
      entries: [
        {
          id: 'q1',
          slug: 'demo',
          phase: 2,
          runId: 'abc123',
          scope: ['hub-docs'],
          since: Date.now(),
          bypassed: 0,
          reserving: false,
          waitingOn: [
            {
              kind: 'grant',
              slug: 'other-plan',
              phase: 4,
              owner: 'claude-a/x',
              scope: ['hub-docs'],
              overlaps: ['hub-docs'],
            },
          ],
        },
      ],
    });

    const { default: RunView } = await import('@/features/runs/run-page');
    mount(<RunView detail={planDetail()} />);

    // The count on Run is the lane count — the one number that says "there is
    // more than one thing happening" without opening anything.
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Run2', 'Phase 1', 'Phase 2queued']);
  });

  it('points the ask box at the tab you are on, not at whatever is active', async () => {
    // The whole reason to open a lane's tab is to talk to THAT session. An ask
    // box that silently addressed `activePhase` would send it to another one.
    run.mockResolvedValue({
      run: { ...RUN, status: 'running', activePhase: 1, phases: RECORDS(1, 2) },
      history: [],
      eta: null,
    });
    const { default: RunView } = await import('@/features/runs/run-page');
    mount(<RunView detail={planDetail()} />);

    await screen.findAllByRole('tab');
    fireEvent.click(screen.getByRole('tab', { name: 'Phase 2' }));
    await waitFor(() => expect(screen.getByPlaceholderText(/ask the session running phase 2/i)).toBeTruthy());
  });

  it('says what a queued phase is behind rather than just that it is queued', async () => {
    run.mockResolvedValue({
      run: {
        ...RUN,
        status: 'running',
        phases: { 2: { phase: 2, status: 'queued', attempts: 0, costUsd: 0 } },
      },
      history: [],
      eta: null,
    });
    queue.mockResolvedValue({
      max: 3,
      live: 0,
      queued: 1,
      throttledUntil: null,
      grants: [],
      entries: [
        {
          id: 'q1',
          slug: 'demo',
          phase: 2,
          runId: 'abc123',
          scope: ['hub-docs'],
          since: Date.now(),
          bypassed: 0,
          reserving: false,
          waitingOn: [
            {
              kind: 'grant',
              slug: 'other-plan',
              phase: 4,
              owner: 'claude-a/x',
              scope: ['hub-docs'],
              overlaps: ['hub-docs'],
            },
          ],
        },
      ],
    });

    const { default: RunView } = await import('@/features/runs/run-page');
    mount(<RunView detail={planDetail()} />);

    // On the row, and again in the pane behind the tab — both from one reading.
    expect(await screen.findByText('queued — waiting on other-plan P4')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Phase 2/ }));
    await waitFor(() => expect(screen.getByText('Phase 2 is queued')).toBeTruthy());
  });

  /**
   * The plan that has never been run — the state every plan is in before its
   * first boarding, and the one every child of this page has to survive.
   *
   * Reported: it rendered "Why this is stopped — and the way forward" naming a
   * gate on a phase eleven un-started dependencies down, and a card headed "No
   * run yet" saying nothing had been run for the plan, in place of the phase
   * board it had every phase for.
   */
  it('reads as a plan that has not started, not as one that has stopped', async () => {
    run.mockResolvedValue({ run: null, history: [], eta: null });
    const { default: RunView } = await import('@/features/runs/run-page');
    mount(<RunView detail={planDetail()} />);

    // The board is drawn from the PLAN, so it is there before any run exists.
    expect(await screen.findByRole('link', { name: 'the api' })).toBeTruthy();
    // Nothing claims a run has stopped, or that the plan is empty.
    expect(screen.queryByText(/Why this is stopped/)).toBeNull();
    expect(screen.queryByText(/Nothing has been run for/)).toBeNull();
    // …and the one control that matters offers to start one.
    expect(screen.getByRole('button', { name: /Start a run/i })).toBeTruthy();
  });

  /** Issue #17: the Repos cell has been parsed since before there was concurrency. */
  it('shows what each phase touches, and calls a blank cell what it is', async () => {
    const { default: RunView } = await import('@/features/runs/run-page');
    mount(<RunView detail={planDetail()} />);

    const row = (await screen.findByRole('link', { name: 'the api' })).closest('tr')!;
    expect(within(row).getByText('packages/cart-api')).toBeTruthy();

    // A blank Repos cell is `all` — the phase might touch anything, which is why
    // it runs alone. Rendering it as an empty cell hid the reason.
    const blank = screen.getByRole('link', { name: 'the docs' }).closest('tr')!;
    expect(within(blank).getByText('all')).toBeTruthy();
  });
});

describe('the live strip and the closure cut', () => {
  it('says the situation in one line above the bays, and draws the live run in Live with its clock', async () => {
    // The live strip's job, since control-tower phase 20: the situation line
    // in the header names what is running, and the Live bay draws its strip.
    runs.mockResolvedValue([{ ...RUN, id: 'r1', status: 'running', activePhase: 3, phases: RECORDS(3) }]);
    setPrefs({ runsView: 'board' });
    const { default: RunsView } = await import('@/features/runs');
    const { default: HeaderSituation } = await import('@/app/shell/situation');
    mount(
      <>
        <HeaderSituation state={BASE_STATE} phone={false} />
        <RunsView />
      </>,
    );
    const line = await screen.findByTestId('situation-line');
    expect(line.textContent).toContain('demo is running — phase 3');
    const live = await screen.findByRole('region', { name: /^Live, 1/ });
    const strip = within(live).getByRole('article', { name: /^demo/ });
    expect(within(strip).getByTestId('strip-clock').textContent).toMatch(/^running/);
  });

});

describe('the fleet has two shapes and one switch', () => {

  /**
   * C2: one page, two answers about the same park — QA round 2's M2.
   *
   * 3.5.0 taught `phaseUiState` a second argument: a phase parked behind
   * another lane's scope, or on an MCP server that would not connect, is not an
   * ask, and paints `waiting` rather than `needs-you`. Five surfaces were
   * taught to pass it and two were not — `LiveStrip` and the sessions list read
   * a `NowLane`, which had no field to carry it, and `nowLanes()` read the
   * record that had one and dropped it.
   *
   * So this page rendered the strip and the table over the SAME record with
   * opposite answers. Exactly C1's class, and worse in one way: before the
   * change every surface agreed, so the release introduced the disagreement it
   * was meant to be removing.
   *
   * **Red before the fix**: the strip's dot read `needs-you`.
   */
  it('paints a park the same way in the strip and in the table', async () => {
    const parked = {
      phase: 4,
      status: 'parked' as const,
      attempts: 1,
      costUsd: 0,
      lifecycle: { state: 'parked' as const, stop: { kind: 'mcp' as const } },
      note: 'the fs server would not connect',
    };
    runs.mockResolvedValue([
      {
        ...RUN,
        id: 'r1',
        slug: 'alpha',
        status: 'running',
        activePhase: 5,
        phases: { ...RECORDS(5), 4: parked },
      },
    ]);
    const { default: RunsView } = await import('@/features/runs');
    mount(<RunsView />);

    // Every rendered state for this one record, wherever it is painted.
    await screen.findAllByRole('tab');
    const painted = [...document.querySelectorAll('[class*="state-"]')]
      .map((el) => [...el.classList].find((c) => c.startsWith('state-')))
      .filter((c): c is string => Boolean(c));
    expect(painted.includes('state-needs-you'), 'a park nobody is asked about read as an ask').toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The Tower — `#/runs` as the live management page (control-tower phase 20)
 * ------------------------------------------------------------------ */

describe('the Tower', () => {
  it('keeps the approval queue and the auth card first, above every bay', async () => {
    const { api } = await import('@/lib/api');
    setPrefs({ runsView: 'board' });
    runs.mockResolvedValue([{ ...RUN, id: 'r1', status: 'running', activePhase: 3, phases: RECORDS(3) }]);
    vi.mocked(api.approvals).mockResolvedValue([
      {
        id: 'a1',
        runId: 'r1',
        slug: 'demo',
        phase: 3,
        kind: 'permission',
        title: 'Bash: npm publish',
        detail: 'Phase 3 of demo asks to run npm publish.',
        evidence: [],
        createdAt: new Date().toISOString(),
        status: 'pending',
      },
    ] as never);
    vi.mocked(api.auth).mockResolvedValue({ loggedIn: false, checkedAt: '2026-08-03T00:00:00Z' } as never);
    try {
      const { default: RunsView } = await import('@/features/runs');
      const { default: HeaderSituation } = await import('@/app/shell/situation');
      mount(
        <>
          <HeaderSituation state={BASE_STATE} phone={false} />
          <RunsView />
        </>,
      );
      const queue = await screen.findByText('Waiting on you');
      const signedOut = await screen.findByText('Claude Code is signed out');
      const firstBay = (await screen.findAllByTestId('bay'))[0]!;
      const before = (a: Node, b: Node) =>
        Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      expect(before(queue, firstBay), 'the approvals come before the bays').toBe(true);
      expect(before(signedOut, firstBay), 'the auth card comes before the bays').toBe(true);
      // And the situation line counts the card with the bays: it needs you too.
      expect((await screen.findByTestId('situation-line')).textContent).toContain('1 needs you');
    } finally {
      vi.mocked(api.approvals).mockImplementation(async () => []);
      vi.mocked(api.auth).mockImplementation(
        async () => ({ loggedIn: true, checkedAt: '2026-08-03T00:00:00Z' }) as never,
      );
    }
  });

  it('says in Waiting and Queued what each run waits on — a fence, a hold, a sibling run’s branch', async () => {
    setPrefs({ runsView: 'board' });
    runs.mockResolvedValue([
      {
        ...RUN,
        id: 'r-fenced',
        slug: 'fenced',
        status: 'waiting',
        waitReason: 'external',
        phases: {
          4: { phase: 4, status: 'parked', attempts: 1, costUsd: 0 },
          5: {
            phase: 5,
            status: 'queued',
            attempts: 0,
            costUsd: 0,
            waitingOn: [
              {
                slug: 'fenced',
                phase: 4,
                owner: 'this run',
                kind: 'fence',
                refs: ['gh:acme/web#pr/12'],
                until: null,
              },
            ],
          },
        },
      },
      {
        ...RUN,
        id: 'r-held',
        slug: 'held',
        status: 'queued',
        hold: { at: '2026-08-03T00:30:00Z', by: 'you' },
        phases: { 2: { phase: 2, status: 'queued', attempts: 0, costUsd: 0 } },
      },
      {
        ...RUN,
        id: 'r-branch',
        slug: 'behind',
        status: 'queued',
        phases: { 3: { phase: 3, status: 'queued', attempts: 0, costUsd: 0 } },
      },
    ]);
    queue.mockResolvedValue({
      max: 3,
      live: 0,
      queued: 1,
      throttledUntil: null,
      grants: [],
      entries: [
        {
          id: 'e1',
          slug: 'behind',
          phase: 3,
          runId: 'r-branch',
          scope: ['phased-execution'],
          since: Date.parse('2026-08-03T00:40:00Z'),
          bypassed: 0,
          reserving: false,
          waitingOn: [
            {
              kind: 'branch',
              slug: 'beta',
              phase: null,
              owner: 'run b1 of beta holds phased-execution on pe/beta',
              scope: ['phased-execution'],
              overlaps: ['phased-execution'],
              branch: 'pe/beta',
            },
          ],
        },
      ],
    });
    const { default: RunsView } = await import('@/features/runs');
    mount(<RunsView />);

    const waits = async (bay: RegExp, slug: RegExp) => {
      const region = await screen.findByRole('region', { name: bay });
      const strip = within(region).getByRole('article', { name: slug });
      return within(strip)
        .getAllByTestId('strip-wait')
        .map((el) => el.textContent);
    };
    expect(await waits(/^Waiting/, /^fenced/)).toContain(
      "P5 is fenced by P4's external wall, waiting on gh:acme/web#pr/12",
    );
    expect(await waits(/^Queued/, /^held/)).toContain('Held by you: nothing new boards until it is released');
    await waitFor(async () =>
      expect(await waits(/^Queued/, /^behind/)).toContain(
        "P3 queued — waiting on beta's branch pe/beta on phased-execution",
      ),
    );
  });

  it('opens on the bay an address names, even over a stored table preference', async () => {
    setPrefs({ runsView: 'table' });
    runs.mockResolvedValue([{ ...RUN, id: 'r1', status: 'running', activePhase: 3, phases: RECORDS(3) }]);
    const { default: RunsView } = await import('@/features/runs');
    const { parseHash } = await import('@shared/routes.js');
    mount(<RunsView route={parseHash('#/runs?bay=live')} />);
    const live = await screen.findByRole('region', { name: /^Live/ });
    expect(live.getAttribute('data-focused')).toBe('true');
  });
});
