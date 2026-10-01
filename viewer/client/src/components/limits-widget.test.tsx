/**
 * The usage-alert mute.
 *
 * The property worth pinning is that this control and the one on
 * Notifications ▸ Settings are the SAME preference, not two that agree by
 * habit. It renders from `/api/state` and writes the same `notify.limits`
 * delta, so a second switch cannot drift out of step with the first.
 *
 * The other property is the copy: turning this off also silences a run that
 * parked waiting for a window and an account that could not sign in, and a
 * console that goes quiet about those looks exactly like one that has stopped
 * working. The warning is part of the control, not a footnote elsewhere.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClientConfig } from '@/lib/queries';
import { RELOGIN_CONFIRM } from '@shared/ops-vocab.js';
import { LimitsWidget } from './limits-widget';
import { LimitsOverview } from './limits-overview';

const savePrefs = vi.fn(async (_patch: Record<string, unknown>) => ({}));
const accountLogin = vi.fn(async (_body: Record<string, unknown>) => ({}) as Record<string, unknown>);
let notify: Record<string, boolean> = {};
let registered: unknown[] = [];
let allowAccounts = false;

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      state: vi.fn(async () => ({ prefs: { notify }, allowAccounts })),
      accounts: vi.fn(async () => ({ accounts: registered, allowAccounts: true })),
      savePrefs: (patch: Record<string, unknown>) => savePrefs(patch),
      accountLogin: (body: Record<string, unknown>) => accountLogin(body),
    },
  };
});

function renderOverview(accounts?: Parameters<typeof LimitsOverview>[0]['accounts']) {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <LimitsOverview accounts={accounts} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  savePrefs.mockClear();
  accountLogin.mockReset();
  notify = {};
  registered = [];
  allowAccounts = false;
});

/**
 * A verb beside each diagnosis (control-tower phase 13, #33). The dialog named
 * four failures and offered only "re-read the numbers" — the one thing that
 * cannot help a login that broke.
 */
describe('the repair beside the diagnosis', () => {
  const BROKEN = [
    { id: 'default', kind: 'default', builtIn: true, email: 'me@example.com', authState: 'expired' },
    { id: 'prof', kind: 'profile', builtIn: false, name: 'prof', signedIn: false },
    { id: 'gone', kind: 'profile', builtIn: false, name: 'gone', signedIn: true, authState: 'signed-out' },
    { id: 'tok', kind: 'token', builtIn: false, name: 'tok', usage: { buckets: {}, unsupported: true } },
  ];

  it('offers sign-in for a login, the command for the machine login, and replace for a token', async () => {
    renderOverview(BROKEN as never);
    expect(await screen.findAllByRole('button', { name: 'Sign in again' })).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace token' })).toBeTruthy();
  });

  it('asks before signing the machine login in again while a run pays as it', async () => {
    allowAccounts = true;
    accountLogin
      .mockResolvedValueOnce({
        accountId: 'default',
        command: 'claude auth login',
        mode: 'warn',
        runs: ['alpha'],
        warning: 'alpha is running on the machine login, bound to me@example.com.',
      })
      .mockResolvedValueOnce({ accountId: 'default', command: 'claude auth login', mode: 'command' });
    renderOverview([BROKEN[0]] as never);
    const signIn = await screen.findByRole('button', { name: 'Sign in again' });
    await waitFor(() => expect(signIn).not.toBeDisabled());
    fireEvent.click(signIn);
    const ask = await screen.findByRole('alertdialog');
    expect(ask.textContent).toMatch(/bound to me@example\.com/);
    expect(accountLogin).toHaveBeenCalledTimes(1);
    fireEvent.click(within(ask).getByRole('button', { name: 'Sign in again' }));
    await waitFor(() => expect(accountLogin).toHaveBeenCalledTimes(2));
    expect(accountLogin.mock.calls[1]![0]).toEqual({ accountId: 'default', confirm: RELOGIN_CONFIRM });
  });
});

/**
 * The chrome answers for EVERY account and EVERY window.
 *
 * It used to render one number — the worst 5-hour figure anywhere — which
 * cannot say which login is near its wall, nor that the other one is empty,
 * nor that a weekly window is the real constraint. On a machine with two
 * accounts that is the difference between "stop working" and "switch account".
 */
describe('two entries, one identity', () => {
  it('says so — the pair looks like failover and is not', async () => {
    // The ordinary way to reach this: sign the machine's own `claude` login in
    // as the account you also registered as a profile. Each entry reads
    // correctly alone; only together are they a trap.
    renderOverview([
      { id: 'default', kind: 'default', builtIn: true, name: 'default', email: 'one@example.com' },
      { id: 'info', kind: 'profile', builtIn: false, name: 'info', email: 'One@Example.com' },
    ] as never);
    expect(await screen.findByText(/are the same Claude account/)).toBeTruthy();
    expect(screen.getByText('default and info')).toBeTruthy();
  });

  it('carries an action: remove the registered duplicate, never the machine login (phase 25, #33)', async () => {
    const accountDelete = vi.fn(async () => ({ ok: true }));
    const { api } = await import('@/lib/api');
    (api as unknown as { accountDelete: typeof accountDelete }).accountDelete = accountDelete;
    renderOverview([
      { id: 'default', kind: 'default', builtIn: true, name: 'default', email: 'one@example.com' },
      { id: 'info', kind: 'profile', builtIn: false, name: 'info', email: 'One@Example.com' },
    ] as never);
    const banner = await screen.findByTestId('duplicate-identity');
    const remove = await within(banner).findByRole('button', { name: 'Remove info' });
    await waitFor(() => expect(remove.hasAttribute('disabled')).toBe(false));
    fireEvent.click(remove);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove info' }, { container: document.body }));
    await waitFor(() => expect(accountDelete).toHaveBeenCalledWith('info'));
  });

  it('stays quiet when the logins genuinely differ', async () => {
    renderOverview([
      { id: 'default', kind: 'default', builtIn: true, name: 'default', email: 'one@example.com' },
      { id: 'work', kind: 'profile', builtIn: false, name: 'work', email: 'two@example.com' },
    ] as never);
    await screen.findByText(/Polled on a budget/);
    expect(screen.queryByText(/are the same Claude account/)).toBeNull();
  });
});

describe('the usage indicator', () => {
  const account = (id: string, buckets: Record<string, number>) => ({
    id,
    kind: id === 'default' ? 'default' : 'profile',
    builtIn: id === 'default',
    name: id,
    usage: {
      buckets: Object.fromEntries(
        Object.entries(buckets).map(([key, utilization]) => [key, { utilization, resetsAt: null }]),
      ),
    },
  });

  it('draws a bar per window for every account, per-model windows included', async () => {
    registered = [
      account('default', { five_hour: 94, seven_day: 52 }),
      account('info', { five_hour: 0, seven_day: 65, seven_day_fable: 30 }),
    ];
    const client = new QueryClient(queryClientConfig);
    render(
      <QueryClientProvider client={client}>
        <LimitsWidget variant="header" />
      </QueryClientProvider>,
    );
    // One labelled group per account, naming each window it reports — so a
    // window that ships tomorrow is drawn tomorrow, by key.
    expect(await screen.findByLabelText('default: 5-hour session 94%, Weekly (all models) 52%')).toBeTruthy();
    expect(
      await screen.findByLabelText('info: 5-hour session 0%, Weekly (all models) 65%, Weekly (Fable) 30%'),
    ).toBeTruthy();
  });

  it('FC-5: 78 % and climbing draws the next hour faint above its fill; 78 % and flat draws none (#33)', async () => {
    const forecast = (trend: 'climbing' | 'flat', burn: number) => ({
      pct: 78,
      burnPctPerHour: burn,
      trend,
      wallsAt: null,
      resetsAt: '2026-09-30T12:00:00Z',
      samples: 3,
      spanMs: 1_800_000,
    });
    registered = [
      {
        ...account('default', { five_hour: 78 }),
        forecast: {
          buckets: { five_hour: forecast('climbing', 12) },
          wallsAt: null,
          bucket: null,
          burning: [],
        },
      },
      {
        ...account('info', { five_hour: 78 }),
        forecast: { buckets: { five_hour: forecast('flat', 0) }, wallsAt: null, bucket: null, burning: [] },
      },
    ];
    const client = new QueryClient(queryClientConfig);
    render(
      <QueryClientProvider client={client}>
        <LimitsWidget variant="header" />
      </QueryClientProvider>,
    );
    const climbing = await screen.findByLabelText('default: 5-hour session 78% and climbing · +12 %/h');
    const flat = await screen.findByLabelText('info: 5-hour session 78% and flat');
    expect(climbing.querySelector('[data-forecast="climbing"]')).toBeTruthy();
    expect(flat.querySelector('[data-forecast="climbing"]')).toBeNull();
  });

  it('an account reporting nothing still has a bar — broken drawn as broken — and hides none of the others (phase 25)', async () => {
    registered = [
      { ...account('default', {}), meter: 'broken', usage: { buckets: {}, error: 'HTTP 401' } },
      { ...account('spare', {}), meter: 'none' },
      account('info', { five_hour: 12 }),
    ];
    const client = new QueryClient(queryClientConfig);
    render(
      <QueryClientProvider client={client}>
        <LimitsWidget variant="header" />
      </QueryClientProvider>,
    );
    expect(await screen.findByLabelText('info: 5-hour session 12%')).toBeTruthy();
    const broken = screen.getByLabelText('default: meter broken (HTTP 401)');
    expect(broken.getAttribute('data-meter')).toBe('broken');
    expect(broken.querySelector('.state-failed')).toBeTruthy();
    expect(screen.getByLabelText('spare: no reading yet').getAttribute('data-meter')).toBe('none');
  });

  it('marks the account a live run pays as (phase 25, #33)', async () => {
    registered = [
      { ...account('default', { five_hour: 20 }), paying: [{ slug: 'demo', runId: 'abc' }] },
      account('info', { five_hour: 12 }),
    ];
    const client = new QueryClient(queryClientConfig);
    render(
      <QueryClientProvider client={client}>
        <LimitsWidget variant="header" />
      </QueryClientProvider>,
    );
    const paying = await screen.findByLabelText('default: 5-hour session 20% — paying for demo');
    expect(paying.getAttribute('data-paying')).toBe('true');
    expect(screen.getByLabelText('info: 5-hour session 12%').getAttribute('data-paying')).toBeNull();
  });
});

describe('the overview says what each account is now (phase 25)', () => {
  it('shows the email beside a named account, the identity it resolves to, the paying run, and the forecast', async () => {
    renderOverview([
      {
        id: 'acct-work',
        kind: 'token',
        name: 'work',
        email: 'work@example.com',
        org: 'Example Org',
        paying: [{ slug: 'demo', runId: 'abc' }],
        usage: { buckets: { five_hour: { utilization: 60, resetsAt: null } } },
        forecast: {
          buckets: {},
          wallsAt: '2026-09-29T10:50:00.000Z',
          bucket: 'five_hour',
          burning: [{ slug: 'demo', runId: 'abc', lanes: [3, 5] }],
        },
      },
    ] as never);
    expect(await screen.findByText('work@example.com')).toBeTruthy();
    expect(screen.getByTestId('identity')).toHaveTextContent(
      'Resolves to work@example.com · Example Org now.',
    );
    expect(screen.getByTestId('paying')).toHaveTextContent('pays for demo');
    expect(screen.getByTestId('forecast-walls')).toHaveTextContent(
      /At this burn the 5-hour session window walls ≈/,
    );
    const burning = screen.getByTestId('forecast-burning');
    expect(within(burning).getByRole('link', { name: 'demo' }).getAttribute('href')).toBe('#/plan/demo/run');
    expect(burning).toHaveTextContent('(2 lanes)');
  });

  it('renders a retirement’s evidence and the read that contradicted it (#57)', async () => {
    renderOverview([
      {
        id: 'acct-work',
        kind: 'token',
        name: 'work',
        usage: { buckets: {} },
        meter: 'broken',
        entitlement: {
          state: 'suspect',
          via: 'probe',
          evidence: { source: 'api', matched: 'credit balance is too low', phase: 4, slug: 'demo' },
          contradicted: {
            at: '2026-09-29T09:00:00.000Z',
            by: 'usage-poll',
            reason: 'a usage read answered 200',
          },
        },
      },
    ] as never);
    expect(await screen.findByTestId('retirement-evidence')).toHaveTextContent(
      'Was retired on from the API · “credit balance is too low” · phase 4 of demo',
    );
    expect(screen.getByTestId('retirement-contradicted')).toHaveTextContent('a usage read answered 200');
  });
});

describe('usage alerts', () => {
  it('offers the mute even when there is nothing to meter', async () => {
    // A console with no registered account still runs work as the default one,
    // and still announces when that hits a window.
    renderOverview([]);
    expect(await screen.findByRole('button', { name: 'Turn off' })).toBeTruthy();
  });

  it('writes the same notify.limits delta the notifications page writes', async () => {
    renderOverview([]);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    await waitFor(() => {
      expect(savePrefs).toHaveBeenCalledWith({ notify: { limits: false } });
    });
  });

  it('reads its state from the server, not from a local copy', async () => {
    notify = { limits: false };
    renderOverview([]);
    const button = await screen.findByRole('button', { name: 'Turn on' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('says what goes quiet with it, not just that something does', async () => {
    notify = { limits: false };
    renderOverview([]);
    // The three that are easy to miss: a parked run, a failed sign-in, and the
    // fact that the meters keep working.
    expect(await screen.findByText(/Runs still wait, switch account or pause as you asked/i)).toBeTruthy();
    expect(screen.getByText(/meters above keep updating/i)).toBeTruthy();
  });
});

describe('the compact meters read the worst account', () => {
  it('shows every account honestly in the overview, auth state included', async () => {
    renderOverview([
      {
        id: 'default',
        kind: 'default',
        builtIn: true,
        email: 'main@example.com',
        authState: 'ok',
        usage: {
          buckets: { five_hour: { utilization: 12, resetsAt: '2026-08-06T20:00:00Z' } },
          fetchedAt: '2026-08-06T15:00:00Z',
        },
      },
      {
        id: 'info',
        kind: 'profile',
        builtIn: false,
        name: 'info',
        email: 'info@example.com',
        signedIn: true,
        authState: 'expired',
        usage: {
          buckets: { seven_day_fable: { utilization: 82, resetsAt: '2026-08-12T00:00:00Z' } },
          fetchedAt: '2026-08-06T15:00:00Z',
        },
      },
    ]);
    // A broken login is a badge beside the account, where the meters are.
    expect(await screen.findByText('login expired')).toBeTruthy();
    // A per-model bucket renders by its key — Fable's window the day it ships.
    expect(screen.getByText('Weekly (Fable)')).toBeTruthy();
    expect(screen.getByText('info')).toBeTruthy();
  });
});
