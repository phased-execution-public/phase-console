/**
 * The Locks section at `#/sessions/locks` (#24): every claim, worst-first,
 * with its holder, where its work rides and what it is holding up — and the
 * same Release verb every other surface uses.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { queryClientConfig } from '@/lib/queries';
import type { ConsoleState, LockRow } from '@/lib/api';
import SessionsView from './index';

const { state, locks, releaseLock, lockHistory } = vi.hoisted(() => ({
  state: vi.fn(),
  locks: vi.fn(),
  releaseLock: vi.fn(),
  lockHistory: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, locks, releaseLock, lockHistory } };
});

const NOW = Date.now();

const ROWS: LockRow[] = [
  {
    slug: 'shop',
    phase: 2,
    phaseTitle: 'Checkout',
    owner: 'autopilot/abcdef12',
    scope: ['web'],
    presence: 'unknown',
    lapsed: true,
    holderKind: 'autopilot',
    runId: 'abcdef12',
    blocking: [],
    claimedAt: NOW - 3 * 3_600_000,
    leaseUntil: NOW - 60_000,
  },
  {
    slug: 'shop',
    phase: 5,
    phaseTitle: 'Payments',
    owner: 'sam@laptop',
    host: 'laptop',
    scope: ['app'],
    session: 'c399fe08-0000-0000-0000-000000000001',
    presence: 'live',
    lapsed: false,
    holderKind: 'person',
    branch: 'pe/shop',
    worktree: '/work/shop',
    claimedAt: NOW - 600_000,
    leaseUntil: NOW + 80 * 60_000,
    blocking: [
      { slug: 'blog', phase: 3, runId: 'feedbeef' },
      { slug: 'blog', phase: 4, runId: 'feedbeef' },
    ],
    eta: { label: '~2 h' },
  },
  {
    slug: 'blog',
    phase: 1,
    phaseTitle: 'Drafts',
    owner: 'kim@desk',
    scope: [],
    presence: 'unknown',
    lapsed: false,
    holderKind: 'person',
    blocking: [],
    claimedAt: NOW - 60_000,
    leaseUntil: NOW + 3_600_000,
  },
];

function renderAt(at: string, allowWrites = true) {
  state.mockResolvedValue({
    autopilot: true,
    allowRun: true,
    allowWrites,
    root: { path: '/repo', ok: true, planCount: 2, handoffCount: 1 },
  } as unknown as ConsoleState);
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={at}>
        <SessionsView route={{ name: 'sessions', segments: ['sessions', 'locks'], query: {} } as never} />
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

describe('the Locks section (#/sessions/locks)', () => {
  beforeEach(() => {
    state.mockReset();
    locks.mockReset();
    releaseLock.mockReset();
    locks.mockResolvedValue({ rows: ROWS });
    releaseLock.mockResolvedValue({ slug: 'shop', phase: 2, ok: true, owner: 'autopilot/abcdef12' });
  });

  it('lists every claim in the order the server ranked it, with holder, session, scope, place and what it blocks', async () => {
    renderAt('#/sessions/locks');
    const table = await screen.findByRole('table', { name: /phase claims/i });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    // Worst-first, exactly as served: the lapsed claim, the blocking one, the idle one.
    expect(rows[0].textContent).toMatch(/shop.*P2.*Checkout/);
    expect(rows[1].textContent).toMatch(/shop.*P5.*Payments/);
    expect(rows[2].textContent).toMatch(/blog.*P1.*Drafts/);
    expect(rows[0].textContent).toMatch(/lapsed/i);
    expect(rows[0].textContent).toMatch(/autopilot/i);
    const live = rows[1].textContent ?? '';
    expect(live).toMatch(/sam@laptop/);
    expect(live).toMatch(/live/);
    expect(live).toMatch(/pe\/shop/);
    expect(live).toMatch(/\/work\/shop/);
    expect(live).toMatch(/blocking 2/i);
    expect(live).toMatch(/~2 h/);
    // A claim that named no scope claims everything, and says so.
    expect(rows[2].textContent).toMatch(/everything/i);
  });

  it('releases a lapsed claim through the shared Release verb', async () => {
    renderAt('#/sessions/locks');
    const table = await screen.findByRole('table', { name: /phase claims/i });
    const first = within(table).getAllByRole('row')[1];
    fireEvent.click(within(first).getByRole('button', { name: /release stale claim/i }));
    await waitFor(() => expect(releaseLock).toHaveBeenCalledWith('shop', 2, false));
  });

  it('asks before releasing a live claim, and releases it with force once confirmed', async () => {
    renderAt('#/sessions/locks');
    const table = await screen.findByRole('table', { name: /phase claims/i });
    const live = within(table).getAllByRole('row')[2];
    fireEvent.click(within(live).getByRole('button', { name: /release the claim/i }));
    fireEvent.click(await screen.findByRole('button', { name: /release the claim anyway/i }));
    await waitFor(() => expect(releaseLock).toHaveBeenCalledWith('shop', 5, true));
  });

  it('without --allow-writes the verbs are there, and disabled', async () => {
    renderAt('#/sessions/locks', false);
    const table = await screen.findByRole('table', { name: /phase claims/i });
    const first = within(table).getAllByRole('row')[1];
    await waitFor(() =>
      expect(within(first).getByRole('button', { name: /release stale claim/i })).toHaveProperty(
        'disabled',
        true,
      ),
    );
  });

  it('says so when nothing is claimed', async () => {
    locks.mockResolvedValue({ rows: [] });
    renderAt('#/sessions/locks');
    expect(await screen.findByText(/no phase is claimed/i)).toBeTruthy();
  });
});

describe('the Locks section names what each claim blocks (phase 25)', () => {
  beforeEach(() => {
    locks.mockReset();
    locks.mockResolvedValue({ rows: ROWS });
  });

  it('lists the entries a claim holds up as links to them, beside the holder, the lease and the release', async () => {
    renderAt('#/sessions/locks');
    const table = await screen.findByRole('table', { name: /phase claims/i });
    const live = within(table).getAllByRole('row')[2]!;
    const blocks = within(live).getByTestId('lock-blocks');
    expect(within(blocks).getByRole('link', { name: 'blog P3' }).getAttribute('href')).toContain('blog');
    expect(within(blocks).getByRole('link', { name: 'blog P4' })).toBeTruthy();
    expect(live.textContent).toMatch(/sam@laptop/);
    expect(live.textContent).toMatch(/claimed/);
    expect(within(live).getByRole('button', { name: /release/i })).toBeTruthy();
  });
});

