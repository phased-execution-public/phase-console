/**
 * #18 in the launch form (control-tower phase 22): the plan's git lines this
 * launch will not honour are answered in the Git tile's reconcile panel —
 * which appears ONLY when the prelude reports a difference, holds Launch until
 * it is answered, carries the honour-or-override choice (honour withheld for
 * a line no checkout can fix), and posts `gitStrategyAck`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  skills: vi.fn(),
  runStart: vi.fn(),
  runPrelude: vi.fn(),
  accounts: vi.fn(),
  mcp: vi.fn(),
  isolationPreflight: vi.fn(),
  verifyPreflight: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

const PRELUDE = {
  slug: 'alpha',
  rows: [],
  blocking: [],
  waived: [],
  acknowledged: [],
  manifestPresent: false,
  probes: {
    accounts: { status: 'ok', ok: true, reason: 'ok' },
    mcp: { status: 'skip', ok: true, reason: 'none' },
    credentials: { status: 'skip', ok: true, reason: 'none' },
    delivery: { status: 'ok', ok: true, reason: '1 subscribed device' },
  },
  accounts: [{ id: 'default', minHeadroomPct: 0 }],
  credentials: { policy: 'continue', ids: [], held: [], missing: [] },
  delivery: { ok: true, channels: ['1 subscribed device'], acknowledged: false },
  at: '2026-09-29T00:00:00.000Z',
};

const withLines = (lines: unknown[]) => ({
  ...PRELUDE,
  probes: {
    ...PRELUDE.probes,
    'git-strategy': {
      status: 'ok',
      ok: true,
      reason: `${lines.length} of the plan's git lines not honoured`,
      warnings: [],
      detail: { lines },
    },
  },
});

const CHECKOUT = {
  kind: 'checkout',
  plan: 'Checkout: main on phase 4',
  run: 'inert in the shared checkout — the phase stands on whatever it has checked out',
  honourable: true,
  phases: [4],
};
const BRANCH = {
  kind: 'branch',
  plan: 'feature/alpha, cut from main',
  run: "every phase works on `pe/alpha`; the plan's branch is never created",
  honourable: false,
};

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
        qaMode="off"
        allowWrites
        overlay={{ open: true, onOpenChange: () => {}, title: 'Start a run' }}
      />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: 'Start' });
}

const git = () => screen.getByRole('region', { name: 'Git' });
const launch = () => screen.getByTestId('launch-submit');

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.skills.mockResolvedValue([]);
  mocks.runStart.mockResolvedValue({ run: { id: 'r-new', slug: 'alpha' } });
  mocks.accounts.mockResolvedValue({ allowAccounts: false, accounts: [] });
  mocks.mcp.mockResolvedValue({ servers: [], allowMcp: false });
  mocks.isolationPreflight.mockResolvedValue({ available: true, kind: 'checkout', multiRepo: false });
  mocks.verifyPreflight.mockResolvedValue({ phases: [], computedAt: '2026-09-29T00:00:00Z' });
});

describe('the reconcile panel', () => {
  it('is absent when the plan and the launch agree, and nothing is posted for it', async () => {
    mocks.runPrelude.mockResolvedValue({ prelude: PRELUDE });
    await mount();
    await waitFor(() => expect(mocks.runPrelude).toHaveBeenCalled());
    // The draft tells probe 7 which strategy it is judging.
    expect(mocks.runPrelude.mock.calls.at(-1)![1]).toMatchObject({ gitMode: 'default-branch' });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Git' }));
    expect(within(git()).getByLabelText('Branch')).toBeTruthy();
    expect(screen.queryByTestId('git-reconcile')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Plan git lines' })).toBeNull();
    expect(launch()).not.toBeDisabled();
    fireEvent.click(launch());
    await waitFor(() => expect(mocks.runStart).toHaveBeenCalledTimes(1));
    expect('gitStrategyAck' in (mocks.runStart.mock.calls[0]![1] as object)).toBe(false);
  });

  it('appears on a mismatch, holds Launch with its reason, and posts honour once chosen', async () => {
    mocks.runPrelude.mockResolvedValue({ prelude: withLines([CHECKOUT]) });
    await mount();
    // Summoned: a banner with its action, and the Git tile asks to be answered.
    expect(await screen.findByText('Launch waits for the plan’s git lines.')).toBeTruthy();
    const tile = screen
      .getByRole('list', { name: 'Settings by category' })
      .querySelector('li[data-category="git"]')!;
    expect(tile.getAttribute('data-summons')).toBe('true');
    expect(within(tile as HTMLElement).getByText('Plan lines differ')).toBeTruthy();
    await waitFor(() => expect(launch()).toBeDisabled());
    expect(launch().getAttribute('title')).toBe(
      'Answer the plan’s git lines first — honour or override, in Git.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Choose' }));
    const panel = within(git()).getByTestId('git-reconcile');
    expect(within(panel).getByText('Checkout: main on phase 4')).toBeTruthy();
    expect(within(panel).getByText(/inert in the shared checkout/)).toBeTruthy();
    const choice = within(panel).getByRole('radiogroup', { name: 'Plan git lines' });
    fireEvent.click(within(choice).getByRole('radio', { name: /Honour the plan/ }));

    await waitFor(() => expect(launch()).not.toBeDisabled());
    expect(within(tile as HTMLElement).getByText('Plan lines: honour')).toBeTruthy();
    fireEvent.click(launch());
    await waitFor(() => expect(mocks.runStart).toHaveBeenCalledTimes(1));
    expect(mocks.runStart.mock.calls[0]![1]).toMatchObject({ gitStrategyAck: 'honour' });
  });

  it('withholds honour for a line no checkout can fix, and posts override', async () => {
    mocks.runPrelude.mockResolvedValue({ prelude: withLines([BRANCH, CHECKOUT]) });
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Answer Git' }));
    const panel = await within(git()).findByTestId('git-reconcile');
    expect(within(panel).getByText(/no checkout of its own can make this line hold/)).toBeTruthy();
    const choice = within(panel).getByRole('radiogroup', { name: 'Plan git lines' });
    expect(within(choice).getByRole('radio', { name: /Honour the plan/ })).toBeDisabled();
    fireEvent.click(within(choice).getByRole('radio', { name: /Override the plan/ }));
    await waitFor(() => expect(launch()).not.toBeDisabled());
    fireEvent.click(launch());
    await waitFor(() => expect(mocks.runStart).toHaveBeenCalledTimes(1));
    expect(mocks.runStart.mock.calls[0]![1]).toMatchObject({ gitStrategyAck: 'override' });
  });
});
