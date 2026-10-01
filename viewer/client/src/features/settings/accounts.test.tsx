/**
 * The accounts card: meters always, registration only behind the flag.
 *
 * The card's one design rule is that a disabled capability explains itself —
 * a console without `--allow-accounts` still meters the machine login and
 * names the flag, because a card that hides when disabled looks like a bug.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import type { AccountsState } from '@/lib/api';

const { accountsMock } = vi.hoisted(() => ({
  accountsMock: vi.fn<() => Promise<AccountsState>>(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, accounts: accountsMock, state: vi.fn(async () => ({})) } };
});
// `useNavigate` too: the Pro tree draws the dashboard card under this one, and
// its table reaches for it.
vi.mock('@/app/router', () => ({ navigate: vi.fn(), useNavigate: () => vi.fn() }));

import { AccountsCard } from './accounts';

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AccountsCard />
    </QueryClientProvider>,
  );
}

const STATE: AccountsState = {
  allowAccounts: false,
  accounts: [
    {
      id: 'default',
      kind: 'default',
      builtIn: true,
      email: 'me@example.com',
      plan: 'max',
      usage: {
        buckets: {
          five_hour: { utilization: 42, resetsAt: '2026-08-06T20:00:00Z' },
          seven_day_fable: { utilization: 78, resetsAt: '2026-08-12T00:00:00Z' },
        },
        fetchedAt: '2026-08-06T10:00:00Z',
      },
    },
  ],
};

describe('the accounts card', () => {
  it('meters the machine login and explains the disabled registration', async () => {
    accountsMock.mockResolvedValue(STATE);
    mount();
    // At least once: the Pro tree's dashboard names the login again, on its own row.
    expect((await screen.findAllByText('me@example.com')).length).toBeGreaterThanOrEqual(1);
    // Bucket keys render by NAME, so a window that ships tomorrow appears
    // tomorrow — including a per-model one nobody hard-coded.
    expect(screen.getByText('5-hour session')).toBeTruthy();
    expect(screen.getByText('Weekly (Fable)')).toBeTruthy();
    expect(screen.getAllByText(/--allow-accounts/).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole('button', { name: 'Sign in…' })).toBeNull();
  });

  it('offers registration when the flag is on', async () => {
    accountsMock.mockResolvedValue({ ...STATE, allowAccounts: true });
    mount();
    expect(await screen.findByRole('button', { name: 'Sign in…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Paste a token…' })).toBeTruthy();
  });
});

describe('rename, remove, and a broken login', () => {
  const TWO: AccountsState = {
    allowAccounts: true,
    accounts: [
      { id: 'default', kind: 'default', builtIn: true, email: 'me@example.com' },
      {
        id: 'info',
        kind: 'profile',
        builtIn: false,
        name: 'info',
        email: 'info@example.com',
        signedIn: true,
        authState: 'expired',
      },
    ],
  };

  it('renames through the PATCH verb — the display name, never the id', async () => {
    accountsMock.mockResolvedValue(TWO);
    const rename = vi.fn(async () => ({ account: TWO.accounts[1] }));
    const { api } = await import('@/lib/api');
    (api as unknown as Record<string, unknown>).accountRename = rename;
    mount();

    const renames = await screen.findAllByRole('button', { name: 'Rename' });
    fireEvent.click(renames[1]);
    const input = await screen.findByPlaceholderText('info');
    fireEvent.change(input, { target: { value: 'work account' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(rename).toHaveBeenCalledWith('info', 'work account'));
  });

  it('confirms a removal in a dialog before any DELETE leaves the page', async () => {
    accountsMock.mockResolvedValue(TWO);
    const del = vi.fn(async () => ({ removed: true }));
    const { api } = await import('@/lib/api');
    (api as unknown as Record<string, unknown>).accountDelete = del;
    mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(del).not.toHaveBeenCalled();
    // The dialog states the cost before the choice: what goes, what stays.
    expect(await screen.findByText(/What stays: the Anthropic account itself/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove account' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('info'));
  });

  it('badges an expired login and offers the sign-in where the badge is', async () => {
    accountsMock.mockResolvedValue(TWO);
    mount();
    // Twice, deliberately: once beside the meters, once on the account row.
    expect((await screen.findAllByText('login expired')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy();
  });
});

describe('the unattended path (control-tower phase 91, #147)', () => {
  const OFFER =
    'For runs left alone for days, add a long-lived token for this login: run `claude setup-token`, sign in as the same person, and paste the token under Add account ▸ Token.';

  it('offers a long-lived token where every account is a login that lapses, and opens the paste dialog from it', async () => {
    accountsMock.mockResolvedValue({
      allowAccounts: true,
      accounts: [
        {
          id: 'default',
          kind: 'default',
          builtIn: true,
          email: 'me@example.com',
          authState: 'ok',
          unattended: OFFER,
        },
      ],
    });
    mount();
    expect(await screen.findByText(/For runs left alone for days/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add a long-lived token…' }));
    expect(await screen.findByText('Add a token account')).toBeTruthy();
  });

  it('names when a token must be replaced, and warns in its last fortnight — never "unknown"', async () => {
    accountsMock.mockResolvedValue({
      allowAccounts: true,
      accounts: [
        { id: 'default', kind: 'default', builtIn: true, email: 'me@example.com', unattended: OFFER },
        {
          id: 'unattended',
          kind: 'token',
          builtIn: false,
          name: 'unattended',
          authState: 'expiring',
          tokenExpiresAt: '2026-10-05T00:00:00.000Z',
        },
      ],
    });
    mount();
    expect(await screen.findByText(/replace by/)).toBeTruthy();
    expect(screen.queryByText(/For runs left alone for days/)).toBeNull();
  });
});

describe('every row: its email, a verb beside each diagnosis, a retirement’s evidence (phase 25, #33)', () => {
  it('offers the machine login’s sign-in and a token’s replacement where their diagnoses are', async () => {
    accountsMock.mockResolvedValue({
      allowAccounts: true,
      accounts: [
        { id: 'default', kind: 'default', builtIn: true, email: 'me@example.com', authState: 'expired' },
        {
          id: 'acct-ci',
          kind: 'token',
          builtIn: false,
          name: 'ci',
          email: 'ci@example.com',
          authState: 'signed-out',
          meter: 'broken',
          entitlement: {
            state: 'retired',
            via: 'session',
            evidence: {
              source: 'api',
              matched: 'invalid x-api-key',
              session: '0123456789abcdef',
              phase: 2,
              slug: 'demo',
            },
          },
        },
      ],
    } as AccountsState);
    mount();
    // The email on every row — the named token's included, where its name alone says nothing.
    expect((await screen.findAllByText('ci@example.com')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('me@example.com').length).toBeGreaterThanOrEqual(1);
    // A verb beside each diagnosis, whatever the kind: before phase 25 only a profile had one here.
    expect(screen.getAllByRole('button', { name: 'Sign in again' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: 'Copy command' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: 'Replace token' }).length).toBeGreaterThanOrEqual(1);
    // And what the retirement stood on.
    expect(
      screen
        .getAllByTestId('retirement-evidence')
        .some((node) =>
          node.textContent?.includes(
            'from the API · “invalid x-api-key” · session 01234567 · phase 2 of demo',
          ),
        ),
    ).toBe(true);
  });
});
