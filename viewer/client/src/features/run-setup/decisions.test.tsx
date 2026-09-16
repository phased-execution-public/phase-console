/**
 * The Decisions stage (phase 11 — ZTD-2, gate ACC-1.2): an outstanding
 * blocking row disables Launch and names itself; the four answers the door
 * requires are on the stage; acknowledging a waived row (or the missing
 * channel) clears its block; a signed override re-enables Launch and rides the
 * payload; the manifest and the probes render as the console resolved them.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import { expectNoAxeViolations } from '@/test/axe';

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
  render(
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
}

const panel = () => screen.getByRole('tabpanel');

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

describe('the Decisions stage', () => {
  it('opens first with the four answers the door requires, the manifest and the probes', async () => {
    mocks.runPrelude.mockResolvedValue({ prelude: prelude() });
    await mount();
    expect(screen.getByRole('tab', { name: /Decisions/ }).getAttribute('aria-selected')).toBe('true');
    const stage = panel();
    expect(within(stage).getByText('What the door requires')).toBeTruthy();
    expect(
      within(stage).getByRole('checkbox', { name: /If the console restarts, continue this run/ }),
    ).toBeTruthy();
    expect(within(stage).getByLabelText('Relay questions to a person')).toBeTruthy();
    // The account list is seeded from the prelude's resolved clause — the
    // plan's `default:20` — and reads as the plan's word, not a change.
    const accounts = await within(stage).findByDisplayValue('default:20');
    expect(accounts).toBeTruthy();
    expect(within(stage).getAllByText('from the plan').length).toBeGreaterThan(0);
    // The manifest, row by row, with its state and where it came from.
    const manifest = within(stage).getByRole('list', { name: 'Decision manifest' });
    expect(within(manifest).getByText('credentials')).toBeTruthy();
    expect(within(manifest).getByText('blocks a start')).toBeTruthy();
    expect(within(manifest).getByText('the shipped default')).toBeTruthy();
    // The four probes.
    const probes = within(stage).getByRole('list', { name: 'Probe verdicts' });
    expect(within(probes).getByText(/1 of 1 credential held/)).toBeTruthy();
    expect(within(probes).getByText(/no MCP server named/)).toBeTruthy();
    // Nothing is open: Launch is live, and the payload carries the answers.
    const start = screen.getByRole('button', { name: 'Start' });
    expect(start.hasAttribute('disabled')).toBe(false);
    fireEvent.click(start);
    await waitFor(() => expect(mocks.runStart).toHaveBeenCalledTimes(1));
    const body = mocks.runStart.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.resumeOnRestart).toBe(true);
    expect(body.relay).toBe('off');
    expect(body.accounts).toEqual([{ id: 'default', minHeadroomPct: 20 }]);
    expect('manifestOverride' in body).toBe(false);
  });

  it('an outstanding blocking row disables Launch and names it — on every stage', async () => {
    mocks.runPrelude.mockResolvedValue({
      prelude: prelude({
        rows: [row('credentials', { state: 'outstanding', blocking: 'yes', owner: 'the operator' })],
        blocking: [{ key: 'credentials', why: 'outstanding — owed by the operator' }],
      }),
    });
    await mount();
    const start = await screen.findByRole('button', { name: 'Start' });
    await waitFor(() => expect(start.hasAttribute('disabled')).toBe(true));
    expect(start.getAttribute('title')).toMatch(
      /Decision outstanding: credentials — outstanding — owed by the operator/,
    );
    const banner = await screen.findByTestId('decisions-blocking');
    expect(banner.textContent).toMatch(
      /One decision is still open — Launch is disabled until each is answered/,
    );
    expect(banner.textContent).toMatch(/credentials — outstanding — owed by the operator/);
    // The footer names it on the other stages too, and nothing is posted.
    fireEvent.click(screen.getByRole('tab', { name: /Review/ }));
    expect(screen.getByRole('button', { name: 'Start' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(mocks.runStart).not.toHaveBeenCalled();
  });

  it('a signed override re-enables Launch and rides the payload as who signed it', async () => {
    mocks.runPrelude.mockResolvedValue({
      prelude: prelude({
        rows: [row('credentials', { state: 'outstanding', blocking: 'yes', owner: 'the operator' })],
        blocking: [{ key: 'credentials', why: 'outstanding — owed by the operator' }],
      }),
    });
    await mount();
    const start = await screen.findByRole('button', { name: 'Start' });
    await waitFor(() => expect(start.hasAttribute('disabled')).toBe(true));
    fireEvent.change(screen.getByLabelText('Start anyway, recorded as'), {
      target: { value: 'the operator' },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start' }).hasAttribute('disabled')).toBe(false),
    );
    expect(screen.getByTestId('decisions-blocking').textContent).toMatch(/recorded as an override/);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(mocks.runStart).toHaveBeenCalledTimes(1));
    expect((mocks.runStart.mock.calls[0]![1] as Record<string, unknown>).manifestOverride).toEqual({
      by: 'the operator',
    });
  });

  it('a waived row and a missing delivery channel each need an acknowledgement, which rides the payload', async () => {
    // The first draft has a waived row and no channel; once the boxes are
    // ticked the (re-asked) prelude answers with nothing open.
    mocks.runPrelude.mockImplementation((_slug: string, draft: { acknowledgedWaivers?: string[] }) => {
      const acked = new Set(draft.acknowledgedWaivers ?? []);
      const blocking = [
        ...(acked.has('relay')
          ? []
          : [{ key: 'relay', why: 'waived row not acknowledged — every phase is hand-driven' }]),
        ...(acked.has('announce')
          ? []
          : [{ key: 'announce', why: 'no delivery channel — acknowledge to start anyway' }]),
      ];
      return Promise.resolve({
        prelude: prelude({
          rows: [row('relay', { state: 'waived', value: 'every phase is hand-driven', blocking: 'yes' })],
          probes: {
            ...PROBES_OK,
            delivery: {
              status: 'fail',
              ok: false,
              reason:
                'no delivery channel: no subscribed device, no PHASE_CONSOLE_NOTIFY command, no webhook',
            },
          },
          waived: ['relay'],
          acknowledged: [...acked],
          blocking,
          delivery: { ok: false, channels: [], acknowledged: acked.has('announce') },
        }),
      });
    });
    await mount();
    const start = await screen.findByRole('button', { name: 'Start' });
    await waitFor(() => expect(start.hasAttribute('disabled')).toBe(true));
    expect(start.getAttribute('title')).toMatch(/Decision outstanding: relay/);
    fireEvent.click(await screen.findByRole('checkbox', { name: /relay — waived/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start' }).getAttribute('title')).toMatch(/announce/),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /Start anyway with no delivery channel/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start' }).hasAttribute('disabled')).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(mocks.runStart).toHaveBeenCalledTimes(1));
    expect((mocks.runStart.mock.calls[0]![1] as Record<string, unknown>).acknowledgedWaivers).toEqual([
      'relay',
      'announce',
    ]);
  });

  it('a plan with no manifest says so, and axe finds nothing', async () => {
    mocks.runPrelude.mockResolvedValue({
      prelude: prelude({
        manifestPresent: false,
        rows: [row('gates', { value: 'delegated', origin: 'default', source: 'default' })],
      }),
    });
    await mount();
    // The prelude is asked after mount; wait for its note (the text is split
    // around the `<code>` span, so match on the paragraph).
    await waitFor(() =>
      expect(
        within(panel()).getAllByText(
          (_, node) => node?.tagName === 'P' && /This plan writes no/.test(node.textContent ?? ''),
        ).length,
      ).toBeGreaterThan(0),
    );
    await expectNoAxeViolations(document.body);
  }, 30_000);
});
