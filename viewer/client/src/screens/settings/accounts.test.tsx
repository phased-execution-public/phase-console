/**
 * Settings ▸ Accounts (quiet-console phase 22): which Claude account a session
 * runs as, how much of each window is left, and the presses that change what a
 * run may spend.
 *
 * What it must do. Lead with how many accounts there are and whose 5-hour
 * window is fullest, and re-read every one of them in ONE request. Say so when
 * two registrations are one Claude login — the pair looks like failover and is
 * not — and offer to remove the one that adds nothing, never the machine
 * login. Draw each account as one line — its login, its name and email, its
 * 5-hour window or why there is none, the run it pays for, when it was read —
 * that opens in place to every window by its name (a window nobody hard-coded
 * included) with its reset, its burn, its staleness and the walls the machine
 * learned; to who the account resolves to; and to the verb beside a broken
 * login, because re-reading the numbers is the one thing that cannot mend one.
 *
 * Renaming, removing, signing in and adding each change what a future run may
 * spend, so each is a press the server hears once and only when it is meant: a
 * removal behind a confirm that says what goes and what stays, a re-login of
 * the machine login behind the server's own warning. Without
 * `--allow-accounts` the section still meters every account, says what the
 * flag adds in one sentence, and holds those presses — a capability that hides
 * when it is off looks like a bug. Usage alerts have ONE switch, under
 * Notifications; this section says what they announce and links there.
 *
 * The breaker, the last check, the rank, the credits and the tombstones are
 * `accounts-standing.test.tsx`'s. Every case runs on a fixed clock: "read 2
 * minutes ago", "resets in 2h" and the stale words are the clock's.
 */

import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RELOGIN_CONFIRM } from '@shared/ops-vocab.js';
import type { AccountView, BucketForecast } from '@/data/api';
import { keys } from '@/data/keys';
import { dismissToast, useToasts } from '@/ui';
import { renderWithClient, schemaAnswer, sent, type FixtureServer } from './test-kit';

const server = vi.hoisted((): FixtureServer => ({ reads: {}, calls: [] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);

import { MACHINE_LOGIN_COMMAND } from './account-repair';
import {
  AccountsSection,
  accountKindWords,
  accountsSituation,
  duplicateIdentities,
  forecastWords,
  orderedWindows,
  replaceByWords,
  staleWords,
} from './accounts';

/* ---------------- the clock and the accounts ---------------- */

const NOW = Date.parse('2026-10-11T12:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** An instant relative to the fixed clock, as the server writes one. */
const at = (offset: number): string => new Date(NOW + offset).toISOString();

/** A time of day as the page writes one — in the reader's own clock. */
const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The machine's own login: signed in, its 5-hour window at 42 %, read two minutes ago. */
function machine(over: Partial<AccountView> = {}): AccountView {
  return {
    id: 'default',
    kind: 'default',
    builtIn: true,
    email: 'me@example.com',
    plan: 'max',
    authState: 'ok',
    usage: { buckets: { five_hour: { utilization: 42, resetsAt: at(2 * HOUR) } }, fetchedAt: at(-2 * MIN) },
    ...over,
  };
}

/** A profile this console signed in, named "work", its 5-hour window at 82 %, read a minute ago. */
function work(over: Partial<AccountView> = {}): AccountView {
  return {
    id: 'work',
    kind: 'profile',
    builtIn: false,
    name: 'work',
    email: 'work@example.com',
    signedIn: true,
    authState: 'ok',
    usage: { buckets: { five_hour: { utilization: 82, resetsAt: at(3 * HOUR) } }, fetchedAt: at(-MIN) },
    ...over,
  };
}

/** A pasted setup token named "ci": no email, nothing read yet. */
function token(over: Partial<AccountView> = {}): AccountView {
  return { id: 'acct-ci', kind: 'token', builtIn: false, name: 'ci', authState: 'ok', ...over };
}

/** The server's sentence offering the unattended path to a login that lapses. */
const OFFER =
  'For runs left alone for days, add a long-lived token for this login: run claude setup-token, sign in as the same person, and paste it under Add an account.';

interface Answer {
  /** The flag as `GET /api/accounts` says it; `undefined` is an older server that says nothing. */
  allowAccounts?: boolean | undefined;
  /** The flag as the console's state says it; absent, the same as the accounts answer. */
  stateAllows?: boolean;
  /** `notify.limits` as the console holds it; absent, the shipped default. */
  limits?: boolean;
}

/** What the server answers: the accounts and the flag, the console's state, the schema usage alerts read. */
function serve(accounts: AccountView[], answer: Answer = {}) {
  const allowAccounts = 'allowAccounts' in answer ? answer.allowAccounts : true;
  server.reads['/api/accounts'] = allowAccounts === undefined ? { accounts } : { allowAccounts, accounts };
  server.reads['/api/state'] = { prefs: {}, allowAccounts: answer.stateAllows ?? allowAccounts ?? false };
  server.reads['/api/prefs/schema'] = schemaAnswer(
    answer.limits === undefined ? {} : { 'notify.limits': { value: answer.limits, source: 'instance' } },
  );
}

/* ---------------- reading the page ---------------- */

/** The toasts raised, as words — the tray's store, read without the tray. */
function Toasts() {
  const toasts = useToasts();
  return (
    <ul aria-label="toasts">
      {toasts.map((one) => (
        <li key={one.id}>{one.message}</li>
      ))}
    </ul>
  );
}

/** The section and the toasts it raises, once the accounts have answered. */
async function mount() {
  const view = renderWithClient(
    <>
      <AccountsSection />
      <Toasts />
    </>,
  );
  await waitFor(() =>
    expect(screen.getByTestId('accounts-situation')).not.toHaveTextContent('Reading the accounts.'),
  );
  return view;
}

/** One account's line, by id. */
const rowOf = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-account="${id}"]`)!;

/** Open an account's line in place. */
const open = (id: string) =>
  fireEvent.click(within(rowOf(id)).getByRole('button', { name: /^Show details of / }));

/** One fact of an opened account: the value beside its label. */
function fact(id: string, label: string): HTMLElement {
  const term = [...rowOf(id).querySelectorAll('dt')].find((dt) => dt.textContent === label);
  if (!term) throw new Error(`${id} shows no ${label}`);
  return term.nextElementSibling as HTMLElement;
}

/** One window of an opened account, by its bucket key. */
const windowOf = (id: string, key: string): HTMLElement =>
  rowOf(id).querySelector<HTMLElement>(`[data-window="${key}"]`)!;

/** A group of the section, by its id. */
const group = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-settings-group="${id}"]`)!;

/** The buttons in a part of the page, by their words, in order. */
const buttons = (part: HTMLElement): string[] =>
  within(part)
    .queryAllByRole('button')
    .map((button) => button.textContent ?? '');

/** How many times a path was read. */
const reads = (path: string): number =>
  server.calls.filter((call) => call.method === 'GET' && call.path === path).length;

/** Every request that was not a read — a write the page should not have made. */
const writes = () => server.calls.filter((call) => call.method !== 'GET');

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  server.calls = [];
  server.reads = { 'POST /api/accounts/refresh': {} };
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  window.location.hash = '';
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'clipboard');
  // The tray's store is the module's own and outlives a render.
  const { result, unmount } = renderHook(() => useToasts());
  act(() => {
    for (const one of result.current) dismissToast(one.id);
  });
  unmount();
});

/* ---------------- the words ---------------- */

describe('the words the section draws', () => {
  it('names a login’s kind: the machine’s own, a profile, a pasted token', () => {
    expect(accountKindWords({ kind: 'default', builtIn: true })).toBe('This machine’s own claude login');
    expect(accountKindWords({ kind: 'profile', builtIn: false })).toBe(
      'A profile signed in from this console',
    );
    expect(accountKindWords({ kind: 'token', builtIn: false })).toBe('A long-lived setup token');
  });

  it('orders the windows: the session first, the week, each model’s week by name, then any window nobody named', () => {
    const bucket = (utilization: number) => ({ utilization, resetsAt: at(HOUR) });
    const account = machine({
      usage: {
        buckets: {
          seven_day_opus: bucket(10),
          some_new_tier: bucket(20),
          seven_day: bucket(30),
          five_hour: bucket(40),
          seven_day_fable: bucket(50),
        },
      },
    });
    expect(orderedWindows(account).map(({ key, bucket: one }) => [key, one.utilization])).toEqual([
      ['five_hour', 40],
      ['seven_day', 30],
      ['seven_day_fable', 50],
      ['seven_day_opus', 10],
      ['some_new_tier', 20],
    ]);
    expect(orderedWindows(machine({ usage: undefined }))).toEqual([]);
  });

  it('words a window’s forecast only where its burn is measured', () => {
    const forecast = (
      trend: BucketForecast['trend'],
      burnPctPerHour: number | null,
      wallsAt: string | null = null,
    ): BucketForecast => ({
      pct: 78,
      burnPctPerHour,
      trend,
      wallsAt,
      resetsAt: at(4 * HOUR),
      samples: 3,
      spanMs: 30 * MIN,
    });
    expect(forecastWords(undefined)).toBe('');
    expect(forecastWords(forecast('unknown', null))).toBe('');
    expect(forecastWords(forecast('flat', 0))).toBe('and flat');
    expect(forecastWords(forecast('climbing', null))).toBe('and climbing');
    expect(forecastWords(forecast('climbing', 4.25))).toBe('and climbing, +4.3 %/h');
    expect(forecastWords(forecast('climbing', 12, at(170 * MIN)))).toBe(
      `and climbing, +12 %/h, walls at about ${clock(at(170 * MIN))}`,
    );
  });

  it('says why a reading is stale: its window has reset since, or the read is simply old', () => {
    expect(staleWords(at(-HOUR))).toBe('reset since this read');
    expect(staleWords(at(0))).toBe('reset since this read');
    expect(staleWords(at(HOUR))).toBe('stale');
    expect(staleWords('not a time')).toBe('stale');
    expect(staleWords(at(HOUR), NOW + 2 * HOUR)).toBe('reset since this read');
  });

  it('dates a token’s replacement in the reader’s own calendar, and passes on what it cannot read', () => {
    const words = replaceByWords('2026-10-05T12:00:00.000Z');
    expect(words).toMatch(/\b5\b/);
    expect(words).toContain('2026');
    // A day, never a timestamp.
    expect(words).not.toContain(':');
    expect(replaceByWords('next spring')).toBe('next spring');
  });

  it('finds registrations that are one Claude identity, matched on email whatever its case or spaces', () => {
    expect(
      duplicateIdentities([
        machine({ email: 'one@example.com' }),
        work({ id: 'info', email: ' One@Example.com ' }),
        work({ email: 'two@example.com' }),
        // Two tokens with no email are two unknowns, not one identity.
        token(),
        token({ id: 'acct-other' }),
      ]),
    ).toEqual([{ email: 'one@example.com', ids: ['default', 'info'] }]);
    expect(duplicateIdentities([machine(), work()])).toEqual([]);
  });

  it('leads with how many accounts there are and the 5-hour window closest to its wall', () => {
    const five = (utilization: number) => ({ buckets: { five_hour: { utilization, resetsAt: at(HOUR) } } });
    expect(accountsSituation([])).toBe('No account answered yet.');
    expect(accountsSituation([token()])).toBe('1 account. No 5-hour window has been read yet.');
    expect(accountsSituation([machine(), work({ usage: five(81.6) }), token()])).toBe(
      '3 accounts. The fullest 5-hour window is work’s, at 82 %.',
    );
    expect(accountsSituation([machine({ usage: five(97) }), work()])).toBe(
      '2 accounts. The fullest 5-hour window is me@example.com’s, at 97 %.',
    );
  });
});

/* ---------------- the section ---------------- */

describe('the section’s lead', () => {
  it('says how many accounts there are and whose 5-hour window is fullest', async () => {
    serve([machine(), work()]);
    renderWithClient(<AccountsSection />);
    expect(screen.getByTestId('accounts-situation')).toHaveTextContent('Reading the accounts.');
    await waitFor(() =>
      expect(screen.getByTestId('accounts-situation')).toHaveTextContent(
        '2 accounts. The fullest 5-hour window is work’s, at 82 %.',
      ),
    );
  });

  it('re-reads every account in one request, then the list and the header’s copy of it', async () => {
    serve([machine(), work()]);
    let answerRefresh: (value: unknown) => void = () => {};
    server.reads['POST /api/accounts/refresh'] = () =>
      new Promise((resolve) => {
        answerRefresh = resolve;
      });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh every account' }));
    expect(await screen.findByRole('button', { name: 'Reading…' })).toBeDisabled();
    expect(sent(server, 'POST', '/api/accounts/refresh')).toEqual([{}]);
    answerRefresh({ accounts: [machine(), work()] });
    expect(await screen.findByText('Re-read every account.')).toBeInTheDocument();
    expect(reads('/api/accounts')).toBe(2);
    expect(reads('/api/state')).toBe(2);
    expect(screen.getByRole('button', { name: 'Refresh every account' })).toBeEnabled();
  });

  it('says a re-read that failed in the server’s own words', async () => {
    serve([machine()]);
    server.reads['POST /api/accounts/refresh'] = new Error(
      'The usage endpoint answered 429; try again in a minute.',
    );
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh every account' }));
    expect(
      await screen.findByText('The usage endpoint answered 429; try again in a minute.'),
    ).toBeInTheDocument();
  });

  it('says when not even the machine login answered', async () => {
    serve([]);
    await mount();
    expect(screen.getByTestId('accounts-situation')).toHaveTextContent('No account answered yet.');
    expect(
      screen.getByText('Not even the machine login answered — is the server current?'),
    ).toBeInTheDocument();
  });
});

describe('two entries, one identity', () => {
  // The ordinary way here: sign the machine's own login in as the account
  // also registered as a profile. Each entry reads correctly alone.
  const PAIR = [
    machine({ name: 'default', email: 'one@example.com' }),
    work({ id: 'info', name: 'info', email: 'One@Example.com' }),
  ];

  it('says so — the pair looks like failover and is not', async () => {
    serve(PAIR);
    await mount();
    const banner = screen.getByTestId('duplicate-identity');
    expect(banner).toHaveTextContent('default and info are the same Claude account (one@example.com).');
    expect(banner).toHaveTextContent(
      'They share one set of windows, so switching between them buys no headroom — a run set to switch at a limit moves onto the wall it just hit.',
    );
  });

  it('removes the registration that adds nothing, behind a confirm — never the machine login', async () => {
    serve(PAIR);
    server.reads['DELETE /api/accounts/info'] = { removed: true };
    await mount();
    fireEvent.click(
      within(screen.getByTestId('duplicate-identity')).getByRole('button', { name: 'Remove info' }),
    );
    const ask = await screen.findByRole('alertdialog');
    expect(ask).toHaveTextContent('Remove info?');
    expect(ask).toHaveTextContent(
      'It is the same Claude login as the other entry, so no run loses headroom. What this machine has learned about the login stays.',
    );
    expect(writes()).toEqual([]);
    fireEvent.click(within(ask).getByRole('button', { name: 'Remove info' }));
    await waitFor(() => expect(sent(server, 'DELETE', '/api/accounts/info')).toHaveLength(1));
    expect(writes()).toHaveLength(1);
    await waitFor(() => expect(reads('/api/accounts')).toBe(2));
  });

  it('offers the later registration when both are registered', async () => {
    serve([
      machine(),
      work({ id: 'info', name: 'info', email: 'one@example.com' }),
      work({ id: 'info-2', name: 'info again', email: 'one@example.com' }),
    ]);
    await mount();
    const banner = screen.getByTestId('duplicate-identity');
    expect(banner).toHaveTextContent('info and info-2 are the same Claude account (one@example.com).');
    expect(within(banner).getByRole('button', { name: 'Remove info again' })).toBeEnabled();
  });

  it('stays quiet when the logins genuinely differ', async () => {
    serve([machine({ email: 'one@example.com' }), work({ email: 'two@example.com' })]);
    await mount();
    expect(screen.getByTestId('account-list')).toBeInTheDocument();
    expect(screen.queryByTestId('duplicate-identity')).toBeNull();
  });
});

describe('one line per account', () => {
  it('draws each account’s login, name and email, 5-hour window, the run it pays for, and when it was read', async () => {
    serve([
      machine(),
      work({ authState: 'expired', paying: [{ slug: 'demo', runId: 'r1' }] }),
      token({
        email: 'ci@example.com',
        usage: {
          buckets: { five_hour: { utilization: 7.4, resetsAt: at(HOUR) } },
          fetchedAt: at(-3 * HOUR),
        },
      }),
    ]);
    await mount();
    expect(
      [...document.querySelectorAll('[data-account]')].map((row) => row.getAttribute('data-account')),
    ).toEqual(['default', 'work', 'acct-ci']);

    const mine = rowOf('default');
    expect(mine.querySelector('[data-status]')).toHaveAttribute('data-status', 'ok');
    expect(mine.querySelector('[data-status]')).toHaveTextContent('Signed in');
    // The machine login is named by its email, once.
    expect(within(mine).getAllByText('me@example.com')).toHaveLength(1);
    expect(mine).toHaveTextContent('5-hour 42 %');
    expect(mine).toHaveTextContent('read 2 minutes ago');

    const theirs = rowOf('work');
    expect(theirs.querySelector('[data-status]')).toHaveAttribute('data-status', 'expired');
    expect(theirs.querySelector('[data-status]')).toHaveTextContent('Expired');
    expect(within(theirs).getByText('work')).toBeInTheDocument();
    expect(within(theirs).getByText('work@example.com')).toBeInTheDocument();
    expect(theirs).toHaveTextContent('5-hour 82 %');
    expect(theirs).toHaveTextContent('pays for demo');
    expect(theirs).toHaveTextContent('read 1 minute ago');

    // A named token shows its email too: a name says whose it is only to the person who gave it.
    const ci = rowOf('acct-ci');
    expect(within(ci).getByText('ci')).toBeInTheDocument();
    expect(within(ci).getByText('ci@example.com')).toBeInTheDocument();
    expect(ci).toHaveTextContent('5-hour 7 %');
    expect(ci).toHaveTextContent('read 3 hours ago');
    expect(ci).not.toHaveTextContent('pays for');

    for (const id of ['default', 'work', 'acct-ci']) {
      expect(within(rowOf(id)).getByRole('button', { name: 'Refresh' })).toBeEnabled();
      expect(rowOf(id)).not.toHaveAttribute('data-expanded');
    }
  });

  it('says why an account has no 5-hour figure, and draws no read time for one never read', async () => {
    serve([
      machine({ meter: 'broken', authState: 'expired', usage: { buckets: {}, error: 'HTTP 401' } }),
      work({ id: 'spare', name: 'spare', email: 'spare@example.com', meter: 'none', usage: { buckets: {} } }),
      token({ meter: 'unsupported', usage: { buckets: {}, unsupported: true } }),
    ]);
    await mount();
    expect(rowOf('default')).toHaveTextContent('meter broken (HTTP 401)');
    expect(rowOf('spare')).toHaveTextContent('no reading yet');
    expect(rowOf('acct-ci')).toHaveTextContent('the usage endpoint does not serve this credential');
    for (const id of ['default', 'spare', 'acct-ci']) expect(rowOf(id).querySelector('time')).toBeNull();
  });

  it('opens a lone account from the start', async () => {
    serve([machine()]);
    await mount();
    expect(rowOf('default')).toHaveAttribute('data-expanded');
    expect(within(rowOf('default')).getByRole('button', { name: /^Hide details of / })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(fact('default', 'Windows')).toBeInTheDocument();
  });

  it('opens one account of several in place, and leaves the others folded', async () => {
    serve([machine(), work()]);
    await mount();
    expect(rowOf('work').querySelector('dl')).toBeNull();
    open('work');
    expect(rowOf('work')).toHaveAttribute('data-expanded');
    expect(fact('work', 'Windows')).toBeInTheDocument();
    expect(rowOf('default')).not.toHaveAttribute('data-expanded');
    expect(rowOf('default').querySelector('dl')).toBeNull();
  });

  it('re-reads one account from its own line', async () => {
    serve([machine(), work()]);
    await mount();
    fireEvent.click(within(rowOf('work')).getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(sent(server, 'POST', '/api/accounts/refresh')).toEqual([{ accountId: 'work' }]),
    );
    expect(await screen.findByText('Re-read this account.')).toBeInTheDocument();
    expect(reads('/api/accounts')).toBe(2);
  });
});

describe('an account, opened: its windows', () => {
  it('draws every window it reports, by name and in order, with its reading, its paint and its reset', async () => {
    serve([
      machine({
        pollEveryMs: 90_000,
        usage: {
          buckets: {
            seven_day_fable: { utilization: 82, resetsAt: at(3 * DAY) },
            some_new_tier: { utilization: 12, resetsAt: at(5 * HOUR) },
            five_hour: { utilization: 42.4, resetsAt: at(2 * HOUR + 30 * MIN) },
            seven_day: { utilization: 96, resetsAt: at(26 * HOUR) },
          },
          fetchedAt: at(-2 * MIN),
          error: 'The last read was refused (HTTP 429); these are the read before it.',
        },
      }),
    ]);
    await mount();
    const windows = rowOf('default').querySelector<HTMLElement>('[data-windows="default"]')!;
    expect(
      [...windows.querySelectorAll('[data-window]')].map((one) => one.getAttribute('data-window')),
    ).toEqual(['five_hour', 'seven_day', 'seven_day_fable', 'some_new_tier']);
    const words = (key: string) => windowOf('default', key).textContent;
    expect(words('five_hour')).toBe('5-hour window42 %resets in 2h 30m');
    expect(words('seven_day')).toBe('weekly, all models96 %resets in 26h');
    expect(words('seven_day_fable')).toBe('weekly, fable82 %resets in 72h');
    expect(words('some_new_tier')).toBe('some new tier12 %resets in 5h');

    // Each is a meter a screen reader hears whole, painted on the thresholds the server announces at.
    const meter = (key: string) => within(windowOf('default', key)).getByRole('meter');
    expect(meter('five_hour')).toHaveAccessibleName('me@example.com: 5-hour window');
    expect(meter('five_hour')).toHaveAttribute('aria-valuetext', '42 %');
    expect(meter('five_hour')).toHaveClass('state-done');
    expect(meter('seven_day_fable')).toHaveClass('state-needs-you');
    expect(meter('seven_day')).toHaveClass('state-failed');

    // The reading's own facts, and a failed read beside the figures it left standing.
    expect(windows).toHaveTextContent('read 2 minutes ago');
    expect(windows).toHaveTextContent('read every 1m 30s');
    expect(windows).toHaveTextContent('The last read was refused (HTTP 429); these are the read before it.');
  });

  it('says where each window is heading, where the burn walls it, and which runs are burning it', async () => {
    const wallsAt = at(170 * MIN);
    const window = (
      pct: number,
      trend: BucketForecast['trend'],
      burnPctPerHour: number,
      walls: string | null,
    ): BucketForecast => ({
      pct,
      burnPctPerHour,
      trend,
      wallsAt: walls,
      resetsAt: at(4 * HOUR),
      samples: 3,
      spanMs: 30 * MIN,
    });
    serve([
      work({
        usage: {
          buckets: {
            five_hour: { utilization: 78, resetsAt: at(4 * HOUR) },
            seven_day: { utilization: 40, resetsAt: at(3 * DAY) },
          },
          fetchedAt: at(-MIN),
        },
        forecast: {
          buckets: { five_hour: window(78, 'climbing', 12, wallsAt), seven_day: window(40, 'flat', 0, null) },
          wallsAt,
          bucket: 'five_hour',
          burning: [
            { slug: 'demo', runId: 'r1', lanes: [3, 5] },
            { slug: 'docs', runId: 'r2', lanes: [] },
          ],
        },
      }),
    ]);
    await mount();
    expect(windowOf('work', 'five_hour')).toHaveTextContent(
      `and climbing, +12 %/h, walls at about ${clock(wallsAt)}`,
    );
    expect(windowOf('work', 'seven_day')).toHaveTextContent('and flat');
    expect(screen.getByTestId('forecast-walls')).toHaveTextContent(
      `At this burn its 5-hour window walls at about ${clock(wallsAt)}.`,
    );
    const burning = screen.getByTestId('forecast-burning');
    expect(burning).toHaveTextContent('Burning it: demo (2 lanes), docs');
    expect(within(burning).getByRole('link', { name: 'demo' })).toHaveAttribute('href', '#/plan/demo/run');
    expect(within(burning).getByRole('link', { name: 'docs' })).toHaveAttribute('href', '#/plan/docs/run');
  });

  it('names what is stale: a window that reset since its read, or a read that is simply old', async () => {
    serve([
      machine({
        usage: {
          buckets: {
            five_hour: { utilization: 91, resetsAt: at(-20 * MIN), stale: true },
            seven_day: { utilization: 55, resetsAt: at(2 * DAY), stale: true },
            seven_day_opus: { utilization: 30, resetsAt: at(2 * DAY) },
          },
          fetchedAt: at(-3 * HOUR),
        },
      }),
    ]);
    await mount();
    expect(windowOf('default', 'five_hour')).toHaveTextContent('reset due');
    expect(windowOf('default', 'five_hour')).toHaveTextContent('reset since this read');
    expect(windowOf('default', 'seven_day')).toHaveTextContent(/stale$/);
    expect(windowOf('default', 'seven_day')).not.toHaveTextContent('reset since this read');
    expect(windowOf('default', 'seven_day_opus')).not.toHaveTextContent('stale');
  });

  it('names a wall the machine learned, and when the window reopens', async () => {
    serve([machine({ limitedUntil: { five_hour: at(2 * HOUR), seven_day: at(-MIN) } })]);
    await mount();
    expect(screen.getAllByTestId('wall').map((wall) => wall.textContent)).toEqual([
      'Hit its 5-hour window limit; it reopens in 2h.',
      'Hit its weekly, all models limit; it reopens now.',
    ]);
  });

  it('says why there is nothing to draw: a failed read, a credential the endpoint does not serve, or no read yet', async () => {
    serve([
      machine({ meter: 'broken', lastErrorAt: at(-5 * MIN), usage: { buckets: {}, error: 'HTTP 401' } }),
      token({ usage: { buckets: {}, unsupported: true } }),
      work({ id: 'spare', name: 'spare', email: 'spare@example.com', usage: { buckets: {} } }),
    ]);
    await mount();
    for (const id of ['default', 'acct-ci', 'spare']) open(id);
    expect(fact('default', 'Windows')).toHaveTextContent('No usage read yet: HTTP 401.');
    expect(fact('default', 'Windows')).toHaveTextContent('never read here');
    expect(fact('default', 'Windows')).toHaveTextContent('a read failed 5 minutes ago');
    expect(fact('acct-ci', 'Windows')).toHaveTextContent(
      'The usage endpoint does not serve this credential — a limit is learned when a run meets one.',
    );
    expect(fact('spare', 'Windows')).toHaveTextContent('No usage read yet.');
    expect(fact('spare', 'Windows')).toHaveTextContent('never read here');
    for (const id of ['default', 'acct-ci', 'spare'])
      expect(rowOf(id).querySelector('[role="meter"]')).toBeNull();
  });

  it('reads a window credits carry past as on credit, not as spent', async () => {
    serve([
      work({
        usage: {
          buckets: {
            five_hour: { utilization: 100, resetsAt: at(HOUR) },
            seven_day: { utilization: 60, resetsAt: at(2 * DAY) },
          },
          fetchedAt: at(-MIN),
        },
        credits: {
          allowed: true,
          available: true,
          carrying: true,
          reason: 'credits are available',
          used: 12.4,
          limit: null,
          cap: 40,
          remaining: 27.6,
          currency: 'USD',
          onCredit: true,
        },
      }),
    ]);
    await mount();
    const five = within(windowOf('work', 'five_hour')).getByRole('meter');
    expect(five).toHaveAttribute('aria-valuetext', 'on credit');
    expect(five).toHaveClass('state-running');
    expect(windowOf('work', 'five_hour')).toHaveTextContent('on credit');
    expect(windowOf('work', 'five_hour')).not.toHaveTextContent('100 %');
    expect(within(windowOf('work', 'seven_day')).getByRole('meter')).toHaveAttribute(
      'aria-valuetext',
      '60 %',
    );
  });
});

describe('an account, opened: who it is', () => {
  it('says what kind of login it is, who it resolves to now, its plan, its organisation and its fingerprint', async () => {
    serve([
      token({
        email: 'ci@example.com',
        org: 'Example Org',
        orgId: '3f9a1c20',
        credential: 'fp-0123456789abcdef',
        plan: 'max',
      }),
    ]);
    await mount();
    const identity = screen.getByTestId('identity');
    expect(identity).toHaveTextContent('A long-lived setup token');
    expect(identity).toHaveTextContent('Resolves to ci@example.com, Example Org now.');
    expect(identity).toHaveTextContent('max plan');
    expect(within(identity).getByText('acct-ci')).toBeInTheDocument();
    expect(identity).toHaveTextContent('organisation 3f9a1c20');
    // The fingerprint, short, saying what it is for.
    expect(within(identity).getByText('fp-012345678')).toHaveAttribute(
      'title',
      'The login’s fingerprint: two accounts that show one are one login',
    );
  });

  it('names the machine’s own login and a profile, and says nothing it was not told', async () => {
    serve([machine(), work({ email: undefined, plan: undefined })]);
    await mount();
    open('default');
    open('work');
    const mine = within(rowOf('default')).getByTestId('identity');
    expect(mine).toHaveTextContent('This machine’s own claude login');
    expect(mine).toHaveTextContent('Resolves to me@example.com now.');
    expect(mine).toHaveTextContent('max plan');
    const theirs = within(rowOf('work')).getByTestId('identity');
    expect(theirs).toHaveTextContent('A profile signed in from this console');
    expect(theirs).not.toHaveTextContent('Resolves to');
    expect(theirs).not.toHaveTextContent('plan');
    expect(theirs).not.toHaveTextContent('organisation');
  });
});

describe('the repair beside the diagnosis', () => {
  it('offers each broken login its own verb — sign in, sign in again, the command, a new token — and a working one none', async () => {
    serve([
      machine({ authState: 'expired' }),
      work({ id: 'prof', name: 'prof', email: 'prof@example.com', signedIn: false, authState: 'unknown' }),
      work({ id: 'gone', name: 'gone', email: 'gone@example.com', authState: 'signed-out' }),
      token({ usage: { buckets: {}, unsupported: true } }),
      work(),
    ]);
    await mount();
    for (const id of ['default', 'prof', 'gone', 'acct-ci', 'work']) open(id);
    expect(buttons(fact('default', 'Login'))).toEqual(['Sign in again', 'Copy the command']);
    expect(buttons(fact('prof', 'Login'))).toEqual(['Sign in']);
    expect(buttons(fact('gone', 'Login'))).toEqual(['Sign in again']);
    expect(buttons(fact('acct-ci', 'Login'))).toEqual(['Replace token']);
    expect(buttons(fact('work', 'Login'))).toEqual([]);
    // The diagnosis is beside the verb, in the login's own words.
    expect(fact('default', 'Login').querySelector('[data-status]')).toHaveAttribute('data-status', 'expired');
    expect(fact('gone', 'Login')).toHaveTextContent('Signed out');
  });

  it('signs a profile in, in the terminal the console opens, and goes there', async () => {
    serve([machine(), work({ id: 'prof', name: 'prof', email: 'prof@example.com', signedIn: false })]);
    server.reads['POST /api/accounts/login'] = {
      accountId: 'prof',
      command: 'claude auth login',
      mode: 'embedded',
      terminal: { sessionId: 'pty-7', token: 't', expiresAt: NOW + HOUR },
    };
    await mount();
    open('prof');
    fireEvent.click(within(fact('prof', 'Login')).getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(sent(server, 'POST', '/api/accounts/login')).toEqual([{ accountId: 'prof' }]));
    expect(await screen.findByText('Sign in inside the terminal that just opened.')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/sessions/pty-7');
    await waitFor(() => expect(reads('/api/accounts')).toBe(2));
  });

  it('says where to finish when the server opened a terminal of its own', async () => {
    serve([
      machine(),
      work({ id: 'gone', name: 'gone', email: 'gone@example.com', authState: 'signed-out' }),
    ]);
    server.reads['POST /api/accounts/login'] = {
      accountId: 'gone',
      command: 'claude auth login',
      mode: 'external',
    };
    await mount();
    open('gone');
    fireEvent.click(within(fact('gone', 'Login')).getByRole('button', { name: 'Sign in again' }));
    await waitFor(() => expect(sent(server, 'POST', '/api/accounts/login')).toEqual([{ accountId: 'gone' }]));
    expect(
      await screen.findByText('A terminal opened — finish claude auth login there, then refresh.'),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe('');
  });

  it('copies the machine login’s command — the line a person types — and asks the server nothing', async () => {
    serve([machine({ authState: 'expired' })]);
    await mount();
    fireEvent.click(within(fact('default', 'Login')).getByRole('button', { name: 'Copy the command' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(MACHINE_LOGIN_COMMAND));
    expect(MACHINE_LOGIN_COMMAND).toBe('claude auth login');
    expect(
      await screen.findByText('Command copied — run it in a terminal, then refresh'),
    ).toBeInTheDocument();
    expect(writes()).toEqual([]);
  });

  it('asks before signing the machine login in again while a run pays as it, and sends the confirm word only on a yes', async () => {
    serve([machine({ authState: 'expired' })]);
    server.reads['POST /api/accounts/login'] = (body: unknown) =>
      (body as { confirm?: string }).confirm
        ? { accountId: 'default', command: 'claude auth login', mode: 'command' }
        : {
            accountId: 'default',
            command: 'claude auth login',
            mode: 'warn',
            runs: ['alpha'],
            warning: 'alpha is running on the machine login, bound to me@example.com.',
          };
    await mount();
    const signIn = () =>
      fireEvent.click(within(fact('default', 'Login')).getByRole('button', { name: 'Sign in again' }));

    signIn();
    let ask = await screen.findByRole('alertdialog');
    expect(ask).toHaveTextContent('Sign the machine login in again?');
    expect(ask).toHaveTextContent('alpha is running on the machine login, bound to me@example.com.');
    fireEvent.click(within(ask).getByRole('button', { name: 'Leave it signed in' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(sent(server, 'POST', '/api/accounts/login')).toEqual([{ accountId: 'default' }]);
    expect(writeText).not.toHaveBeenCalled();

    signIn();
    ask = await screen.findByRole('alertdialog');
    fireEvent.click(within(ask).getByRole('button', { name: 'Sign in again' }));
    await waitFor(() =>
      expect(sent(server, 'POST', '/api/accounts/login')).toEqual([
        { accountId: 'default' },
        { accountId: 'default' },
        { accountId: 'default', confirm: RELOGIN_CONFIRM },
      ]),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('claude auth login'));
    expect(
      await screen.findByText('Command copied — run it in any terminal, then refresh'),
    ).toBeInTheDocument();
  });

  it('replaces a token in place, keeping its id and its name — never a second account for one login', async () => {
    serve([
      machine(),
      token({ authState: 'signed-out', meter: 'broken', usage: { buckets: {}, error: 'HTTP 401' } }),
    ]);
    server.reads['PUT /api/accounts/acct-ci/credential'] = { account: token() };
    await mount();
    open('acct-ci');
    const replace = () =>
      fireEvent.click(within(fact('acct-ci', 'Login')).getByRole('button', { name: 'Replace token' }));

    // A cancel sends nothing.
    replace();
    fireEvent.click(within(screen.getByTestId('replace-token')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('replace-token')).toBeNull();

    replace();
    const form = screen.getByTestId('replace-token');
    const submit = within(form).getByRole('button', { name: 'Replace token' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(form).getByLabelText('New token for ci'), {
      target: { value: ' a-fresh-setup-token ' },
    });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() =>
      expect(sent(server, 'PUT', '/api/accounts/acct-ci/credential')).toEqual([
        { token: 'a-fresh-setup-token' },
      ]),
    );
    expect(
      await screen.findByText('Token replaced. The account keeps its name, and its meters read again.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('replace-token')).toBeNull();
    expect(writes()).toHaveLength(1);
  });

  it('says when a setup token must be replaced, and that an idle login renews itself — once', async () => {
    serve([
      machine({ authState: 'refreshable', unattended: OFFER }),
      token({
        id: 'unattended',
        name: 'unattended',
        authState: 'expiring',
        tokenExpiresAt: '2026-10-25T12:00:00.000Z',
      }),
    ]);
    await mount();
    open('default');
    open('unattended');
    const login = fact('unattended', 'Login');
    expect(login.querySelector('[data-status]')).toHaveAttribute('data-status', 'expiring');
    expect(login).toHaveTextContent(`replace it by ${replaceByWords('2026-10-25T12:00:00.000Z')}`);
    expect(login).not.toHaveTextContent(/unknown/i);
    expect(fact('default', 'Login')).toHaveTextContent('Idle, renews at next session');
    expect(fact('default', 'Login').textContent!.match(/renews at/gi)).toHaveLength(1);
    // A token is registered, so the unattended path is no longer offered.
    expect(screen.queryByTestId('unattended-offer')).toBeNull();
  });
});

describe('renaming and removing', () => {
  it('renames in place through the PATCH verb — the display name, never the id', async () => {
    serve([machine(), work({ id: 'info', name: 'info', email: 'info@example.com' })]);
    server.reads['PATCH /api/accounts/info'] = { account: work({ id: 'info', name: 'work account' }) };
    await mount();
    open('info');
    expect(fact('info', 'Name')).toHaveTextContent('info');
    fireEvent.click(within(fact('info', 'Name')).getByRole('button', { name: 'Rename' }));
    const field = screen.getByLabelText('A name for info');
    expect(field).toHaveValue('info');
    fireEvent.change(field, { target: { value: '  work account ' } });
    fireEvent.click(within(fact('info', 'Name')).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sent(server, 'PATCH', '/api/accounts/info')).toEqual([{ name: 'work account' }]),
    );
    expect(await screen.findByText('Renamed. The id underneath never changes.')).toBeInTheDocument();
    await waitFor(() => expect(reads('/api/accounts')).toBe(2));
  });

  it('sends nothing for a name that did not change, a cancel or an Escape', async () => {
    serve([machine(), work({ id: 'info', name: 'info' })]);
    await mount();
    open('default');
    open('info');
    // The machine login has no name of its own until one is given.
    expect(fact('default', 'Name')).toHaveTextContent('No name of its own');
    fireEvent.click(within(fact('default', 'Name')).getByRole('button', { name: 'Rename' }));
    expect(screen.getByLabelText('A name for me@example.com')).toHaveAttribute(
      'placeholder',
      'machine login',
    );
    fireEvent.click(within(fact('default', 'Name')).getByRole('button', { name: 'Cancel' }));

    const rename = () =>
      fireEvent.click(within(fact('info', 'Name')).getByRole('button', { name: 'Rename' }));
    rename();
    fireEvent.click(within(fact('info', 'Name')).getByRole('button', { name: 'Save' }));
    rename();
    fireEvent.change(screen.getByLabelText('A name for info'), { target: { value: 'other' } });
    fireEvent.click(within(fact('info', 'Name')).getByRole('button', { name: 'Cancel' }));
    rename();
    fireEvent.change(screen.getByLabelText('A name for info'), { target: { value: 'other' } });
    fireEvent.keyDown(screen.getByLabelText('A name for info'), { key: 'Escape' });
    expect(within(fact('info', 'Name')).getByRole('button', { name: 'Rename' })).toBeInTheDocument();
    expect(fact('info', 'Name')).toHaveTextContent('info');
    expect(writes()).toEqual([]);
  });

  it('removes an account only behind a confirm that says what goes and what stays', async () => {
    serve([machine(), work({ id: 'info', name: 'info', email: 'info@example.com' })]);
    server.reads['DELETE /api/accounts/info'] = { removed: true };
    await mount();
    open('info');
    const remove = () => fireEvent.click(within(rowOf('info')).getByRole('button', { name: 'Remove' }));

    remove();
    let ask = await screen.findByRole('alertdialog');
    expect(ask).toHaveTextContent('Remove info?');
    expect(ask).toHaveTextContent(
      'What goes: this console’s registration of it, its profile directory and that directory’s login (on macOS, its keychain entry too).',
    );
    expect(ask).toHaveTextContent(
      'What stays: the Anthropic account itself, what this machine learned about its login, and every recorded run.',
    );
    expect(ask).toHaveTextContent('A run paying as it refuses the removal — pause or switch it first.');
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(writes()).toEqual([]);

    remove();
    ask = await screen.findByRole('alertdialog');
    fireEvent.click(within(ask).getByRole('button', { name: 'Remove account' }));
    await waitFor(() => expect(sent(server, 'DELETE', '/api/accounts/info')).toHaveLength(1));
    expect(await screen.findByText('Removed info.')).toBeInTheDocument();
    await waitFor(() => expect(reads('/api/accounts')).toBe(2));
  });

  it('says a token’s secret goes with it, offers no removal of the machine login, and says a refusal in its own words', async () => {
    serve([machine(), token()]);
    server.reads['DELETE /api/accounts/acct-ci'] = new Error(
      'ci is paying for demo — pause or switch it first.',
    );
    await mount();
    open('default');
    open('acct-ci');
    expect(within(rowOf('default')).queryByRole('button', { name: 'Remove' })).toBeNull();
    fireEvent.click(within(rowOf('acct-ci')).getByRole('button', { name: 'Remove' }));
    const ask = await screen.findByRole('alertdialog');
    expect(ask).toHaveTextContent('What goes: this console’s registration of it and the stored token.');
    fireEvent.click(within(ask).getByRole('button', { name: 'Remove account' }));
    expect(await screen.findByText('ci is paying for demo — pause or switch it first.')).toBeInTheDocument();
    expect(sent(server, 'DELETE', '/api/accounts/acct-ci')).toHaveLength(1);
  });
});

describe('adding an account', () => {
  it('signs another account in under the name typed, and goes to its terminal', async () => {
    serve([machine()]);
    server.reads['POST /api/accounts/login'] = {
      accountId: 'spare-max',
      command: 'claude auth login',
      mode: 'embedded',
      terminal: { sessionId: 'pty-9', token: 't', expiresAt: NOW + HOUR },
    };
    await mount();
    const add = group('add-account');
    expect(screen.queryByTestId('accounts-flag')).toBeNull();
    const field = within(add).getByLabelText('Sign another account in');
    fireEvent.change(field, { target: { value: '  spare max ' } });
    fireEvent.click(within(add).getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(sent(server, 'POST', '/api/accounts/login')).toEqual([{ name: 'spare max' }]));
    expect(await screen.findByText('Sign in inside the terminal that just opened.')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/sessions/pty-9');
    expect(field).toHaveValue('');
  });

  it('leaves the name to the server when none is typed, and copies the command when nothing could open', async () => {
    serve([machine()]);
    const command = 'CLAUDE_CONFIG_DIR=/home/x/.claude-2 claude auth login';
    server.reads['POST /api/accounts/login'] = { accountId: 'profile-2', command, mode: 'command' };
    await mount();
    fireEvent.click(within(group('add-account')).getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(sent(server, 'POST', '/api/accounts/login')).toEqual([{}]));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(command));
    expect(
      await screen.findByText('Command copied — run it in any terminal, then refresh'),
    ).toBeInTheDocument();
  });

  it('pastes a setup token in a dialog that asks for a name, since a token carries no email', async () => {
    serve([machine()]);
    server.reads['POST /api/accounts'] = { account: token({ name: 'spare max account' }) };
    await mount();
    const paste = () =>
      fireEvent.click(within(group('add-account')).getByRole('button', { name: 'Paste a token' }));

    // A cancel sends nothing.
    paste();
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Add a token account' })).getByRole('button', {
        name: 'Cancel',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    paste();
    const dialog = await screen.findByRole('dialog', { name: 'Add a token account' });
    expect(dialog).toHaveTextContent(
      'Run claude setup-token in any terminal signed in to the account, and paste the token it prints. The name is required: a token carries no email to show.',
    );
    const add = within(dialog).getByRole('button', { name: 'Add account' });
    expect(add).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: ' spare max account ' } });
    expect(add).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Token'), { target: { value: ' a-long-lived-token ' } });
    expect(add).toBeEnabled();
    expect(writes()).toEqual([]);
    fireEvent.click(add);
    await waitFor(() =>
      expect(sent(server, 'POST', '/api/accounts')).toEqual([
        { name: 'spare max account', token: 'a-long-lived-token' },
      ]),
    );
    expect(
      await screen.findByText('Account added. Its meters appear once the endpoint answers.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(reads('/api/accounts')).toBe(2));
  });

  it('offers the unattended path where every account is a login that lapses, beside the paste that takes it', async () => {
    serve([machine({ unattended: OFFER })]);
    await mount();
    const offer = screen.getByTestId('unattended-offer');
    expect(offer).toHaveTextContent(OFFER);
    expect(group('add-account')).toContainElement(offer);
    fireEvent.click(within(group('add-account')).getByRole('button', { name: 'Paste a token' }));
    expect(await screen.findByRole('dialog', { name: 'Add a token account' })).toBeInTheDocument();
  });
});

describe('without --allow-accounts', () => {
  it('still meters every account, says what the flag adds once, and holds every press that changes what a run may spend', async () => {
    serve(
      [
        machine({ authState: 'expired', email: 'one@example.com' }),
        work({ id: 'info', name: 'info', email: 'One@Example.com' }),
        token({ authState: 'signed-out' }),
      ],
      { allowAccounts: false },
    );
    await mount();
    expect(screen.getAllByTestId('accounts-flag')).toHaveLength(1);
    expect(screen.getByTestId('accounts-flag')).toHaveTextContent(
      'Start the console with --allow-accounts to sign more Claude accounts in, paste setup tokens, and pick an account per run. Reading the meters works without it.',
    );

    // Reading never needs the flag.
    expect(rowOf('default')).toHaveTextContent('5-hour 42 %');
    expect(screen.getByRole('button', { name: 'Refresh every account' })).toBeEnabled();
    for (const id of ['default', 'info', 'acct-ci']) {
      expect(within(rowOf(id)).getByRole('button', { name: 'Refresh' })).toBeEnabled();
      open(id);
    }
    expect(within(fact('default', 'Login')).getByRole('button', { name: 'Copy the command' })).toBeEnabled();

    // Every press that changes what a run may spend is held, and says why.
    const add = group('add-account');
    const held = [
      within(add).getByLabelText('Sign another account in'),
      within(add).getByRole('button', { name: 'Sign in' }),
      within(add).getByRole('button', { name: 'Paste a token' }),
      within(screen.getByTestId('duplicate-identity')).getByRole('button', { name: 'Remove info' }),
      within(fact('default', 'Login')).getByRole('button', { name: 'Sign in again' }),
      within(fact('acct-ci', 'Login')).getByRole('button', { name: 'Replace token' }),
      ...['default', 'info', 'acct-ci'].map((id) =>
        within(fact(id, 'Name')).getByRole('button', { name: 'Rename' }),
      ),
      ...['info', 'acct-ci'].map((id) => within(rowOf(id)).getByRole('button', { name: 'Remove' })),
    ];
    for (const control of held) expect(control).toBeDisabled();
    expect(within(add).getByRole('button', { name: 'Paste a token' })).toHaveAttribute(
      'title',
      'Start the console with --allow-accounts to change an account.',
    );
    expect(within(fact('info', 'Name')).getByRole('button', { name: 'Rename' })).toHaveAttribute(
      'title',
      'Start the console with --allow-accounts to change an account.',
    );
    expect(within(fact('default', 'Login')).getByRole('button', { name: 'Sign in again' })).toHaveAttribute(
      'title',
      'Start the console with --allow-accounts to repair an account.',
    );

    // A held press sends nothing and opens nothing.
    for (const control of held) fireEvent.click(control);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes()).toEqual([]);
  });

  it('learns the flag from the accounts answer, and from the console’s state only when that answer says nothing', async () => {
    // The accounts answer is the authority, whatever the state says…
    serve([machine()], { allowAccounts: false, stateAllows: true });
    const first = await mount();
    await waitFor(() => expect(first.client.getQueryState(keys.state())?.status).toBe('success'));
    expect(screen.getByTestId('accounts-flag')).toBeInTheDocument();
    expect(within(group('add-account')).getByRole('button', { name: 'Paste a token' })).toBeDisabled();
    first.unmount();

    // …and an older server's answer, silent on the flag, leaves it to the state.
    serve([machine()], { allowAccounts: undefined, stateAllows: true });
    const second = await mount();
    await waitFor(() => expect(second.client.getQueryState(keys.state())?.status).toBe('success'));
    await waitFor(() =>
      expect(within(group('add-account')).getByRole('button', { name: 'Paste a token' })).toBeEnabled(),
    );
    expect(screen.queryByTestId('accounts-flag')).toBeNull();
  });
});

describe('usage alerts', () => {
  it('says what is announced and links to the one switch, under Notifications — even with nothing to meter', async () => {
    serve([]);
    const view = await mount();
    await waitFor(() => expect(view.client.getQueryState(keys.prefsSchema())?.status).toBe('success'));
    const line = screen.getByTestId('usage-alerts');
    expect(group('accounts')).toContainElement(line);
    expect(line).toHaveTextContent(
      'The console announces a window that was hit, a run parked waiting for one to reopen, and an account that could not sign in.',
    );
    expect(
      within(line).getByRole('link', { name: 'Turn usage alerts off in Notifications' }),
    ).toHaveAttribute('href', '#/settings/notifications');
    // A line, not a second switch: one control for one fact.
    expect(within(line).queryByRole('button')).toBeNull();
    expect(within(line).queryByRole('checkbox')).toBeNull();
    expect(writes()).toEqual([]);
  });

  it('reads the switch the console holds: off, it says runs go quiet about it, and links to turning it back on', async () => {
    serve([machine()], { limits: false });
    await mount();
    const line = screen.getByTestId('usage-alerts');
    await waitFor(() =>
      expect(line).toHaveTextContent(
        'Usage alerts are off: runs still wait, switch or pause as asked, and say nothing about it.',
      ),
    );
    expect(within(line).getByRole('link', { name: 'Turn usage alerts on in Notifications' })).toHaveAttribute(
      'href',
      '#/settings/notifications',
    );
  });
});
