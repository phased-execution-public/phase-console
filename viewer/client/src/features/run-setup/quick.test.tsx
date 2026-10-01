/**
 * The launch door's banner — "this run will need you N times" (control-tower
 * phase 42, criterion 4): the plan's own human steps for the phases this run
 * drives, each proof already run at the door. A step whose proof holds is
 * shown done; *Do it now* opens a needed one BEFORE anything spawns.
 */

/**
 * The Decisions tile (phase 11 — ZTD-2, gate ACC-1.2; a quick-view tile since
 * control-tower phase 22): an outstanding blocking row disables Launch, names
 * itself and makes the tile the summons; the answers the door requires are in
 * the tile, and the account pool beside the account, in Accounts;
 * acknowledging a waived row (or the missing channel) clears its block; a
 * signed override re-enables Launch and rides the payload; the manifest and
 * the probes render as the console resolved them; and the door's advice that
 * this run take a checkout of its own (probe 6) is a banner with its action.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  skills: vi.fn(),
  runStart: vi.fn(),
  plan: vi.fn(),
  verifyPreflight: vi.fn(),
  policy: vi.fn(),
  accounts: vi.fn(),
  mcp: vi.fn(),
  isolationPreflight: vi.fn(),
  runPrelude: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

const row = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  value: '',
  owner: 'operator',
  state: 'answered',
  blocking: 'no',
  source: 'plan',
  origin: 'plan',
  ...over,
});

const PROBES_OK = {
  accounts: { status: 'ok', ok: true, reason: '1 of 1 declared account usable: the machine login' },
  mcp: { status: 'skip', ok: true, reason: 'no MCP server named' },
  credentials: { status: 'ok', ok: true, reason: '1 of 1 credential held' },
  delivery: { status: 'ok', ok: true, reason: '1 subscribed device' },
};

function prelude(over: Record<string, unknown> = {}) {
  return {
    slug: 'alpha',
    rows: [
      row('credentials', { value: '`gh`; credential policy: require', blocking: 'yes' }),
      row('gates', { value: 'delegated', origin: 'default', source: 'default' }),
    ],
    probes: PROBES_OK,
    blocking: [],
    waived: [],
    acknowledged: [],
    manifestPresent: true,
    accounts: [{ id: 'default', minHeadroomPct: 20 }],
    credentials: { policy: 'require', ids: ['gh'], held: ['gh'], missing: [] },
    delivery: { ok: true, channels: ['1 subscribed device'], acknowledged: false },
    at: '2026-09-14T00:00:00.000Z',
    ...over,
  };
}

async function mount() {
  mocks.state.mockResolvedValue({ prefs: {}, defaultSkills: [], allowAgent: true, allowRun: true });
  const client = new QueryClient(queryClientConfig);
  const { RunSetup } = await import('./run-setup');
  const Setup = RunSetup as unknown as (p: Record<string, unknown>) => React.ReactElement;
  const view = render(
    <QueryClientProvider client={client}>
      <Setup
        mode="start"
        context={{ slug: 'alpha', run: null }}
        planPhases={[]}
        qaMode="off"
        allowWrites
        overlay={{ open: true, onOpenChange: () => {}, title: 'Start a run', description: 'A test.' }}
      />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: 'Start' });
  return view;
}

/** Press a tile's verb — Edit, or Answer while the tile is the summons. */
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.skills.mockResolvedValue([]);
  mocks.runStart.mockResolvedValue({ run: { id: 'r-new', slug: 'alpha' } });
  mocks.plan.mockResolvedValue({
    summary: {
      slug: 'alpha',
      title: 'Alpha plan',
      kind: 'plan',
      phases: 1,
      done: 0,
      ready: [1],
      waiting: 0,
      inProgress: [],
      stuck: [],
      percent: 0,
      remainingWeight: 100_000,
      remainingSessions: 1,
      criticalPath: [1],
      criticalWeight: 0,
      minimumSessions: 1,
      budget: 200_000,
      skills: [],
      mcpServers: [],
      qaMode: 'off',
      qaFailures: [],
      locks: [],
      repos: ['api'],
      handoffCount: 0,
      issues: [],
      issueCounts: { error: 0, warning: 0, info: 0 },
      hasHandoffs: false,
      activity: 0,
    },
    plan: null,
    phases: [{ phase: 1, title: 'the schema', state: 'ready', size: 'S', weight: 100_000, gated: false }],
    route: { nodes: [], edges: [], layers: 0, rows: 0 },
    batches: { groups: [], raw: '', budget: '200K' },
    boardText: '',
    lint: null,
    handoffs: [],
    index: [],
  });
  mocks.verifyPreflight.mockResolvedValue({ phases: [], computedAt: '2026-09-14T00:00:00Z' });
  mocks.policy.mockResolvedValue({
    defaults: { deny: [], ask: [], allow: [] },
    extra: { deny: [], ask: [], allow: [] },
    plan: null,
    effective: { deny: [], ask: [], allow: [] },
    file: '',
    profiles: [],
    inert: [],
    support: [],
    hookTools: [],
    wrappersNotStripped: [],
  });
  mocks.accounts.mockResolvedValue({ accounts: [], allowAccounts: false });
  mocks.mcp.mockResolvedValue({ servers: [], allowMcp: false });
  mocks.isolationPreflight.mockResolvedValue({ available: true, kind: 'checkout', multiRepo: false });
});

const STEPS = [
  {
    phase: 1,
    kind: 'browser-login',
    what: 'Sign the gh CLI in',
    where: 'host',
    state: 'pre-cleared',
    open: { url: 'https://github.com/login' },
    proof: 'cmd:"gh auth status"',
    read: 'landed — exit 0',
  },
  {
    phase: 2,
    kind: 'device-code',
    what: 'Pair the deploy CLI',
    where: 'any',
    state: 'needed',
    open: { url: 'https://example.com/device' },
    proof: 'cmd:"deploy whoami"',
    read: 'pending — exit 1',
  },
  {
    phase: 2,
    kind: 'interactive-prompt',
    what: 'Accept the toolchain licence',
    where: 'host',
    state: 'unchecked',
    open: { command: 'sudo xcodebuild -license' },
  },
];

describe('the launch door lists the run’s turns', () => {
  it('says how many, shows the pre-cleared one done, and Do it now opens a step before anything spawns', async () => {
    mocks.runPrelude.mockResolvedValue({
      prelude: prelude({
        probes: {
          ...PROBES_OK,
          'human-steps': { status: 'ok', ok: true, reason: 'this run will need you 3 times' },
        },
        humanSteps: STEPS,
      }),
    });
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    await mount();

    const banner = await screen.findByTestId('door-steps');
    expect(within(banner).getByTestId('door-steps-title').textContent).toBe(
      'This run will need you 3 times — 1 already done.',
    );
    const rows = within(banner).getAllByTestId('door-step');
    expect(rows.map((row) => row.getAttribute('data-state'))).toEqual(['pre-cleared', 'needed', 'unchecked']);

    // The pre-cleared step reads done and offers nothing to do.
    expect(within(rows[0]!).getByTestId('door-step-state').textContent).toBe(
      'Done — its proof already holds.',
    );
    expect(within(rows[0]!).queryByTestId('door-step-do')).toBeNull();
    // Its kind is named by KIND_META, never re-spelled here.
    expect(within(rows[0]!).getByTestId('step-kind').textContent).toBe('Sign in in a browser');

    // The needed one says what its proof read, and Do it now opens it — here,
    // in a new tab — while nothing starts.
    expect(within(rows[1]!).getByTestId('door-step-state').textContent).toContain('pending — exit 1');
    fireEvent.click(within(rows[1]!).getByTestId('door-step-do'));
    expect(opened).toHaveBeenCalledWith('https://example.com/device', '_blank', 'noopener,noreferrer');
    expect(within(rows[1]!).getByTestId('door-step-do').textContent).toBe('Open again');
    expect(mocks.runStart).not.toHaveBeenCalled();

    // A command step offers the command itself, to run where the person is.
    expect(within(rows[2]!).getByText('sudo xcodebuild -license')).toBeTruthy();
    expect(within(rows[2]!).getByRole('button', { name: /Do it now — copy the command/ })).toBeTruthy();

    // Check again re-reads the door, which re-runs every proof.
    const asked = mocks.runPrelude.mock.calls.length;
    fireEvent.click(within(banner).getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(mocks.runPrelude.mock.calls.length).toBeGreaterThan(asked));
    opened.mockRestore();
  });

  it('draws nothing when the plan declares no step', async () => {
    mocks.runPrelude.mockResolvedValue({ prelude: prelude() });
    await mount();
    await waitFor(() => expect(mocks.runPrelude).toHaveBeenCalled());
    expect(screen.queryByTestId('door-steps')).toBeNull();
  });
});
