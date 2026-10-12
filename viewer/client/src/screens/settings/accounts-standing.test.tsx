/**
 * Settings ▸ Accounts — where each account stands with the console that
 * spends it (quiet-console phase 22; zero-touch-console phase 15 and
 * control-tower phases 76 and 93 before it).
 *
 * What it must never do is re-derive a rule: every sentence on an account's
 * row is the server's — the breaker's word, who wrote it and why, what a
 * retirement stood on, the rank's verdict, the last check, the credits. So
 * each case feeds the section what the server would send and asserts that the
 * state reaches the page with its reason: a retired account with the refusal
 * that retired it, a cooling one with its clock, a removed id by the name it
 * was removed under.
 *
 * The verbs that change what a run may spend are asserted on the wire.
 * *Probe entitlement* is one POST, held while its check runs — a second press
 * would be a second session. *Clear retired* asks first, and keeping it
 * retired sends nothing. The credits switch sends exactly `{allowed, capUsd?}`.
 * Without `--allow-accounts` every one of them is held and sends nothing.
 *
 * Since 7.0 all of this is in both trees, the free one included: the breaker's
 * two verbs, the credits switch and the removed accounts were Pro's alone in
 * 6.x. Every case runs on a fixed clock, so "since", "until" and "ago" never
 * read the wall clock's minute.
 */

import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evidenceLine } from '@/cards/retirement-evidence';
import type {
  AccountProbeResult,
  AccountView,
  AccountsState,
  BucketForecast,
  CreditView,
  RetirementEvidence,
  TombstoneView,
} from '@/data/api';
import { ApiError } from '@/data/http';
import { dismissToast, useToasts } from '@/ui';
import { renderWithClient, schemaAnswer, sent, type FixtureServer } from './test-kit';

const server = vi.hoisted((): FixtureServer => ({ reads: {}, calls: [] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);

import {
  AccountsSection,
  wallClockWords,
  forecastWords,
  probeSentence,
  staleWords,
  standingWords,
} from './accounts';
import { CreditsControl, creditWords, spendWords } from './credits';
import { TombstonesGroup } from './tombstones';

const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** An instant relative to the fixed clock, written as the server writes one. */
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
const EARLIER = at(-HOUR);
const SOON = at(HOUR);

/** What a retirement stood on: a refusal on the API's channel, in a session of a phase. */
const EVIDENCE: RetirementEvidence = {
  source: 'api',
  matched: 'credential refused (org policy)',
  session: 'a1b2c3d4e5f6',
  phase: 12,
  slug: 'demo',
};

/** The machine's own login: entitled by the poller, first in the rank, checked three times. */
const MACHINE: AccountView = {
  id: 'default',
  kind: 'default',
  builtIn: true,
  email: 'me@example.com',
  credential: '0123456789abcdef',
  authState: 'ok',
  entitlement: {
    state: 'entitled',
    via: 'credential',
    at: EARLIER,
    by: 'poller',
    reason: 'the usage endpoint answered',
  },
  usage: {
    buckets: {
      five_hour: { utilization: 42, resetsAt: SOON },
      seven_day: { utilization: 61, resetsAt: SOON },
    },
    fetchedAt: EARLIER,
  },
  pollEveryMs: 600_000,
  breaker: { candidate: true, rank: 1 },
  probe: {
    at: EARLIER,
    status: 'ok',
    reason: 'a one-turn session under this account completed',
    by: 'operator',
    costUsd: 0.0021,
    count: 3,
  },
};

/** A profile retired with its organisation, on the API's refusal. */
const RETIRED: AccountView = {
  id: 'work',
  kind: 'profile',
  builtIn: false,
  name: 'Work Max',
  credential: 'fedcba9876543210',
  orgId: 'e462cb3c',
  authState: 'unusable',
  entitlement: {
    state: 'retired',
    via: 'org',
    class: 'org-policy',
    reason: 'organization policy blocks this credential',
    at: EARLIER,
    by: 'classifier',
    evidence: EVIDENCE,
  },
  usage: { buckets: {}, lastErrorAt: EARLIER, error: 'credential was refused' },
  lastErrorAt: EARLIER,
  breaker: {
    candidate: false,
    why: 'retired with its organisation — organization policy blocks this credential',
  },
};

/** A token account cooling off a walled window: out of the rank until it reopens. */
const COOLING: AccountView = {
  id: 'spare',
  kind: 'token',
  builtIn: false,
  name: 'Spare Max',
  credential: 'aaaabbbbccccdddd',
  authState: 'unknown',
  entitlement: {
    state: 'cooling',
    via: 'credential',
    until: SOON,
    reason: 'usage limit hit',
    by: 'live-wall',
  },
  limitedUntil: { five_hour: SOON },
  breaker: { candidate: false, why: 'its five_hour window is walled', until: SOON },
};

/** A registration this console removed, still named by the learned store. */
const SUPPORT: TombstoneView = {
  id: 'support',
  name: 'Support Max',
  retiredAt: EARLIER,
  credential: '1111222233334444',
  entitlement: { state: 'unknown', via: 'none' },
};

const STATE: AccountsState = {
  allowAccounts: true,
  accounts: [MACHINE, RETIRED, COOLING],
  tombstones: [SUPPORT],
};
const IDS = ['default', 'work', 'spare'];

/** Credits carrying a full window: switched on, there, 12.34 of the 40.00 cap used this month. */
const CARRYING: CreditView = {
  allowed: true,
  available: true,
  carrying: true,
  reason: '12.34 of 40.00 USD used',
  used: 12.34,
  limit: 40,
  cap: 40,
  remaining: 27.66,
  currency: 'USD',
  onCredit: true,
};

/** Credits the account has, not switched on: the operator's word is off by default. */
const OFF: CreditView = {
  allowed: false,
  available: true,
  carrying: false,
  reason: '5.00 of 40.00 USD used',
  used: 5,
  limit: 40,
  cap: 40,
  remaining: 35,
  currency: 'USD',
  onCredit: false,
};

/** The toasts as a list a case can read — the store is the module's own. */
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

/** What the toasts said, oldest first — read past an open dialog, which hides the rest of the page. */
const said = (): string[] =>
  [...document.querySelectorAll('[aria-label="toasts"] li')].map((li) => li.textContent ?? '');

/** The section over a registry the server would answer, with the toasts beside it. */
function mount(state: AccountsState = STATE) {
  server.reads['/api/accounts'] = state;
  return renderWithClient(
    <>
      <AccountsSection />
      <Toasts />
    </>,
  );
}

/** One account's row, as drawn. */
function rowOf(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-account="${id}"]`);
  if (!row) throw new Error(`No row for ${id} yet`);
  return row;
}

/** One account's row, opened in place — a list of more than one draws each folded. */
async function open(id: string): Promise<HTMLElement> {
  const row = await waitFor(() => rowOf(id));
  const toggle = within(row).queryByRole('button', { expanded: false, name: /^Show / });
  if (toggle) fireEvent.click(toggle);
  return row;
}

/** The value an opened row gives beside one label: Entitlement, Rank, Credits, … */
function fact(row: HTMLElement, label: string): HTMLElement {
  return within(row).getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement;
}

/** A status word drawn in `scope`, by its vocabulary — the dot and word carry the word as given. */
const word = (scope: HTMLElement, vocab: string) =>
  scope.querySelector<HTMLElement>(`[data-vocab="${vocab}"]`);

/**
 * The moment the clause that opens with `lead` (“until”) in `scope` points at,
 * as the page gives it on hover — the absolute time, whether the clause draws
 * a `<time>` or says the clock in words.
 */
function clockOf(scope: HTMLElement, lead: string): string | null {
  const clause = [...scope.querySelectorAll<HTMLElement>('span')].find((one) =>
    one.textContent?.startsWith(`${lead} `),
  );
  if (!clause) return null;
  return (clause.querySelector('[title]') ?? clause).getAttribute('title');
}

/** An instant as a person reads it on hover. */
const absolute = (iso: string) => new Date(iso).toLocaleString();

/** Every request that would change something — whatever was read, nothing of this was sent. */
const writes = () => server.calls.filter((call) => call.method !== 'GET');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  server.calls = [];
  server.reads = {
    '/api/state': { prefs: {}, allowAccounts: true },
    '/api/prefs/schema': schemaAnswer(),
  };
});

afterEach(() => {
  // The tray's store is the module's own and outlives a render.
  const { result, unmount } = renderHook(() => useToasts());
  act(() => {
    for (const one of result.current) dismissToast(one.id);
  });
  unmount();
  vi.useRealTimers();
});

describe('each account’s standing, as its row says it', () => {
  it('says the breaker’s word, who wrote it and why, the last check, and its place first in the rank', async () => {
    mount();
    const row = await open('default');
    const entitlement = fact(row, 'Entitlement');
    expect(word(entitlement, 'entitlement')).toHaveAttribute('data-status', 'entitled');
    expect(entitlement).toHaveTextContent('Entitled');
    expect(entitlement).toHaveTextContent('the usage endpoint answered');
    expect(entitlement).toHaveTextContent('since 1 hour ago');
    expect(entitlement).toHaveTextContent('by poller');
    // The last check: its answer, when, who pressed it, how many in all, what it cost, and why.
    const check = within(row).getByTestId('last-check');
    expect(word(check, 'probe')).toHaveAttribute('data-status', 'ok');
    expect(check).toHaveTextContent('Last check');
    expect(check).toHaveTextContent('OK');
    expect(check).toHaveTextContent('1 hour ago');
    expect(check).toHaveTextContent('by operator');
    expect(check).toHaveTextContent('3 checks in all');
    expect(check).toHaveTextContent('$0.0021');
    expect(check).toHaveTextContent('a one-turn session under this account completed');
    expect(fact(row, 'Rank')).toHaveTextContent('Number 1 in the rank an automatic pick walks');
    // Read on its budget: when last, and how often.
    expect(fact(row, 'Windows')).toHaveTextContent('read 1 hour ago');
    expect(fact(row, 'Windows')).toHaveTextContent('read every 10m');
  });

  it('says what retired an account and what it stood on, and why the rank leaves it out', async () => {
    mount();
    const row = await open('work');
    const entitlement = fact(row, 'Entitlement');
    const retired = word(entitlement, 'entitlement');
    expect(retired).toHaveAttribute('data-status', 'retired');
    expect(retired).toHaveTextContent('Retired');
    // Only a person mends a retirement, and the word itself says so.
    expect(retired).toHaveAttribute('data-attention', 'needs-you');
    expect(entitlement).toHaveTextContent('through its organisation');
    expect(entitlement).toHaveTextContent('org-policy');
    expect(entitlement).toHaveTextContent('organization policy blocks this credential');
    expect(within(entitlement).getByTestId('retirement-evidence')).toHaveTextContent(
      'Retired on from the API · “credential refused (org policy)” · session a1b2c3d4 · phase 12 of demo',
    );
    expect(entitlement).toHaveTextContent('since 1 hour ago');
    expect(entitlement).toHaveTextContent('by classifier');
    expect(word(fact(row, 'Login'), 'auth')).toHaveAttribute('data-status', 'unusable');
    expect(fact(row, 'Identity')).toHaveTextContent('organisation e462cb3c');
    expect(fact(row, 'Rank')).toHaveTextContent(
      'Out of the rank: retired with its organisation — organization policy blocks this credential',
    );
    expect(fact(row, 'Windows')).toHaveTextContent('never read here');
  });

  it('says when a cooling account is a candidate again — on the breaker’s word, the rank’s and the wall’s', async () => {
    mount();
    const row = await open('spare');
    const entitlement = fact(row, 'Entitlement');
    expect(word(entitlement, 'entitlement')).toHaveAttribute('data-status', 'cooling');
    expect(entitlement).toHaveTextContent('usage limit hit');
    expect(entitlement).toHaveTextContent('by live-wall');
    expect(clockOf(entitlement, 'until')).toBe(absolute(SOON));
    // Ahead, in its clock and how far off — never the past's "just now".
    expect(entitlement).toHaveTextContent(`until ${wallClockWords(SOON, NOW)}, in 1h`);
    const rank = fact(row, 'Rank');
    expect(rank).toHaveTextContent('Out of the rank: its five_hour window is walled');
    expect(clockOf(rank, 'until')).toBe(absolute(SOON));
    expect(rank).toHaveTextContent(`until ${wallClockWords(SOON, NOW)}, in 1h`);
    expect(row).not.toHaveTextContent('just now');
    const wall = within(row).getByTestId('wall');
    expect(wall).toHaveTextContent('Hit its 5-hour window limit; it reopens in 1h.');
    expect(wall).toHaveAttribute('title', absolute(SOON));
  });

  it('says a suspect retirement was demoted, what it stood on, and the read that argues with it', async () => {
    mount({
      allowAccounts: true,
      accounts: [
        {
          id: 'side',
          kind: 'profile',
          builtIn: false,
          name: 'Side Max',
          authState: 'ok',
          entitlement: {
            state: 'suspect',
            via: 'credential',
            evidence: EVIDENCE,
            contradicted: { at: EARLIER, by: 'poller', reason: 'a usage read succeeded after it' },
          },
        },
      ],
    });
    // One account opens by itself.
    const entitlement = fact(await open('side'), 'Entitlement');
    expect(word(entitlement, 'entitlement')).toHaveAttribute('data-status', 'suspect');
    expect(within(entitlement).getByTestId('retirement-evidence')).toHaveTextContent(
      'Was retired on from the API · “credential refused (org policy)” · session a1b2c3d4 · phase 12 of demo',
    );
    expect(within(entitlement).getByTestId('retirement-contradicted')).toHaveTextContent(
      'contradicted 1 hour ago by poller — a usage read succeeded after it',
    );
    // The line alone: a session that spent nothing says so, and no evidence or no retirement says nothing.
    expect(
      evidenceLine({ state: 'retired', via: 'credential', evidence: { source: 'text', matched: 'x' } }),
    ).toBe('from a session that spent nothing · “x”');
    expect(evidenceLine({ state: 'retired', via: 'credential' })).toBeNull();
    expect(evidenceLine({ state: 'entitled', via: 'credential', evidence: EVIDENCE })).toBeNull();
  });

  it('says so when the server reports no breaker and nothing was ever checked, and draws no rank it was not given', async () => {
    mount({
      allowAccounts: true,
      accounts: [{ id: 'default', kind: 'default', builtIn: true, email: 'me@example.com', authState: 'ok' }],
    });
    const row = await open('default');
    expect(fact(row, 'Entitlement')).toHaveTextContent('This server does not report the breaker.');
    expect(fact(row, 'Entitlement')).toHaveTextContent('Never checked.');
    expect(within(row).queryByText('Rank', { selector: 'dt' })).toBeNull();
    expect(within(row).queryByText('Credits', { selector: 'dt' })).toBeNull();
  });

  it('words the rank’s verdict from the server’s standing alone', () => {
    expect(standingWords(undefined)).toBeNull();
    expect(standingWords({ candidate: true, rank: 2 })).toBe('Number 2 in the rank an automatic pick walks');
    expect(standingWords({ candidate: true })).toBe('A candidate for an automatic pick');
    expect(standingWords({ candidate: false, why: 'its five_hour window is walled', until: SOON })).toBe(
      'Out of the rank: its five_hour window is walled',
    );
  });
});

describe('Probe entitlement', () => {
  it('says what a check found as a sentence: the verdict, the server’s reason, the breaker’s move', () => {
    expect(probeSentence('work', { status: 'ok', reason: 'The API took work under it.' })).toBe(
      'Checked work: it may run work. The API took work under it.',
    );
    expect(
      probeSentence(
        'work',
        { status: 'fail', reason: 'credential refused' },
        { from: 'entitled', to: 'retired' },
      ),
    ).toBe('Checked work: it was refused. credential refused. The breaker moved from entitled to retired.');
    expect(probeSentence('work', { status: 'skip', reason: '' })).toBe(
      'Checked work: it could not be asked.',
    );
  });

  it('writes a moment ahead as today’s clock, or with its date when it is further off', () => {
    const today = new Date(NOW + HOUR);
    expect(wallClockWords(today.toISOString(), NOW)).toBe(
      today.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    );
    const later = new Date(NOW + 3 * DAY);
    expect(wallClockWords(later.toISOString(), NOW)).toBe(
      `${later.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${later.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    );
    expect(wallClockWords('not a time', NOW)).toBe('not a time');
  });

  it('sends one check, holds the button while it runs so a second press is not a second session, and puts the answer on the row', async () => {
    let finish: (answer: AccountProbeResult) => void = () => {};
    server.reads['POST /api/accounts/default/probe-entitlement'] = () =>
      new Promise<AccountProbeResult>((resolve) => {
        finish = resolve;
      });
    mount();
    for (const id of IDS) await open(id);
    const machine = rowOf('default');
    fireEvent.click(within(machine).getByRole('button', { name: 'Probe entitlement' }));
    await waitFor(() =>
      expect(sent(server, 'POST', '/api/accounts/default/probe-entitlement')).toEqual([{}]),
    );
    const held = within(machine).getByRole('button', { name: 'Probing…' });
    expect(held).toBeDisabled();
    fireEvent.click(held);
    expect(sent(server, 'POST', '/api/accounts/default/probe-entitlement')).toHaveLength(1);
    // Another account’s check is not held by this one.
    for (const id of ['work', 'spare']) {
      expect(within(rowOf(id)).getByRole('button', { name: 'Probe entitlement' })).toBeEnabled();
    }

    const answered: AccountView = {
      ...MACHINE,
      entitlement: {
        state: 'retired',
        via: 'credential',
        reason: 'a one-turn check was refused: the check was refused',
        at: at(0),
        by: 'probe',
      },
      probe: { at: at(0), status: 'fail', reason: 'the check was refused', by: 'operator', count: 4 },
    };
    // The list the re-read returns is the server's, which now carries the answer too.
    server.reads['/api/accounts'] = { ...STATE, accounts: [answered, RETIRED, COOLING] };
    await act(async () => {
      finish({
        spent: true,
        account: answered,
        probe: answered.probe!,
        moved: { from: 'entitled', to: 'retired' },
      });
    });
    await waitFor(() => expect(within(machine).queryByRole('button', { name: 'Probing…' })).toBeNull());
    const check = within(machine).getByTestId('last-check');
    expect(word(check, 'probe')).toHaveAttribute('data-status', 'fail');
    expect(check).toHaveTextContent('4 checks in all');
    expect(check).toHaveTextContent('the check was refused');
    expect(word(fact(machine, 'Entitlement'), 'entitlement')).toHaveAttribute('data-status', 'retired');
    // And the toast says what the check found, and that it moved the breaker.
    await waitFor(() => expect(said()).toHaveLength(1));
    expect(said()[0]).toMatch(/^Checked me@example\.com: it was refused\. /);
    expect(said()[0]).toContain('the check was refused');
    expect(said()[0]).toContain('The breaker moved from entitled to retired.');
  });

  it('says the server’s refusal in its own words, and gives the button back', async () => {
    const refusal = 'A check of Spare Max is already running — its answer lands on the row when it finishes.';
    server.reads['POST /api/accounts/spare/probe-entitlement'] = new ApiError(
      refusal,
      409,
      '/api/accounts/spare/probe-entitlement',
    );
    mount();
    const row = await open('spare');
    fireEvent.click(within(row).getByRole('button', { name: 'Probe entitlement' }));
    await waitFor(() => expect(said()).toEqual([refusal]));
    expect(within(row).getByRole('button', { name: 'Probe entitlement' })).toBeEnabled();
    expect(sent(server, 'POST', '/api/accounts/spare/probe-entitlement')).toEqual([{}]);
  });
});

describe('Clear retired', () => {
  it('is offered only where there is a retirement, asks first — keeping it sends nothing — and confirmed, clears it', async () => {
    const cleared: AccountView = {
      ...RETIRED,
      authState: 'ok',
      entitlement: { state: 'unknown', via: 'org', at: at(0), by: 'operator', reason: 'cleared by a person' },
      breaker: { candidate: true, rank: 2 },
    };
    server.reads['POST /api/accounts/work/clear-retired'] = { account: cleared };
    mount();
    for (const id of IDS) await open(id);
    const offered = screen.getAllByRole('button', { name: 'Clear retired' });
    expect(offered).toHaveLength(1);
    expect(rowOf('work')).toContainElement(offered[0]!);

    fireEvent.click(offered[0]!);
    let question = await screen.findByRole('alertdialog');
    expect(question).toHaveTextContent('Clear the retirement of Work Max?');
    // A retirement through an organisation clears for every account in it, and the question says so.
    expect(question).toHaveTextContent(
      'The breaker opens to unknown for this login and every account in its organisation.',
    );
    fireEvent.click(within(question).getByRole('button', { name: 'Keep it retired' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(writes()).toEqual([]);

    server.reads['/api/accounts'] = { ...STATE, accounts: [MACHINE, cleared, COOLING] };
    fireEvent.click(within(rowOf('work')).getByRole('button', { name: 'Clear retired' }));
    question = await screen.findByRole('alertdialog');
    fireEvent.click(within(question).getByRole('button', { name: 'Clear retired' }));
    await waitFor(() => expect(sent(server, 'POST', '/api/accounts/work/clear-retired')).toEqual([{}]));
    await waitFor(() => expect(said()).toEqual(['Work Max is unknown again.']));
    await waitFor(() =>
      expect(word(fact(rowOf('work'), 'Entitlement'), 'entitlement')).toHaveAttribute(
        'data-status',
        'unknown',
      ),
    );
    expect(within(rowOf('work')).queryByRole('button', { name: 'Clear retired' })).toBeNull();
    expect(fact(rowOf('work'), 'Rank')).toHaveTextContent('Number 2 in the rank an automatic pick walks');
  });
});

describe('without --allow-accounts', () => {
  it('holds every verb that changes what a run may spend, says why, and sends nothing', async () => {
    server.reads['/api/state'] = { prefs: {}, allowAccounts: false };
    mount({ ...STATE, allowAccounts: false, accounts: [{ ...MACHINE, credits: OFF }, RETIRED, COOLING] });
    for (const id of IDS) await open(id);
    const probes = screen.getAllByRole('button', { name: 'Probe entitlement' });
    expect(probes).toHaveLength(3);
    for (const probe of probes) {
      expect(probe).toBeDisabled();
      expect(probe).toHaveAttribute('title', 'Start the console with --allow-accounts to change an account.');
    }
    const clear = screen.getByRole('button', { name: 'Clear retired' });
    expect(clear).toBeDisabled();
    const credits = within(rowOf('default')).getByRole('button', { name: 'Use credits past plan limits' });
    expect(credits).toBeDisabled();
    expect(credits).toHaveAttribute('title', 'Start the console with --allow-accounts to change this.');
    expect(screen.getByLabelText('Stop at, in dollars a month')).toBeDisabled();
    for (const button of [...probes, clear, credits]) fireEvent.click(button);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(writes()).toEqual([]);
  });
});

describe('credits', () => {
  it('words what an account’s credits are doing, and what this month has cost', () => {
    expect(creditWords(CARRYING)).toBe('Uses credits past its plan limits');
    expect(creditWords({ ...CARRYING, available: false, carrying: false, reason: 'out of credits' })).toBe(
      'Allowed, and stopped: out of credits',
    );
    expect(creditWords({ ...OFF, available: false, reason: 'out of credits' })).toBe('Off: out of credits');
    expect(creditWords(OFF)).toBe('Off; credits are available');
    expect(creditWords({ ...OFF, available: null })).toBe('Off; the credit state is unknown');
    expect(creditWords(undefined)).toBe('Credit state unknown');
    expect(spendWords(CARRYING)).toBe('12.34 of 40.00 USD used this month, 27.66 left');
    expect(spendWords({ ...CARRYING, cap: null, remaining: null, currency: null })).toBe(
      '12.34 used this month',
    );
    expect(spendWords({ ...CARRYING, used: null })).toBeNull();
    expect(spendWords(undefined)).toBeNull();
  });

  it('reads “on credit” where credits carry a full window — never a red, spent meter — and stops them with {allowed: false}', async () => {
    const onCredit: AccountView = {
      ...MACHINE,
      email: 'admin@example.com',
      usage: {
        buckets: { five_hour: { utilization: 100, resetsAt: SOON, polledAt: EARLIER, stale: false } },
        fetchedAt: EARLIER,
      },
      credits: CARRYING,
    };
    const stopped: AccountView = {
      ...onCredit,
      credits: { ...CARRYING, allowed: false, carrying: false, onCredit: false },
    };
    server.reads['POST /api/accounts/default/overage'] = { account: stopped };
    mount({ allowAccounts: true, accounts: [onCredit] });
    // Folded too, and in the section's lead: on credit, never "100 %" alone.
    await waitFor(() =>
      expect(screen.getByTestId('accounts-situation')).toHaveTextContent(
        'The fullest 5-hour window is admin@example.com’s, at 100 %, and credits carry it.',
      ),
    );
    expect(rowOf('default')).toHaveTextContent('5-hour on credit');
    const row = await open('default');
    const meter = within(row).getByRole('meter', { name: 'admin@example.com: 5-hour window' });
    expect(meter).toHaveAttribute('aria-valuetext', 'on credit');
    expect(meter).toHaveClass('state-running');
    expect(meter).not.toHaveClass('state-failed');
    expect(row.querySelector('[data-window="five_hour"]')).not.toHaveTextContent('100 %');
    const credits = fact(row, 'Credits');
    expect(credits).toHaveTextContent('Uses credits past its plan limits');
    expect(credits).toHaveTextContent('12.34 of 40.00 USD used this month, 27.66 left');
    expect(credits).toHaveTextContent('A session is running on credit now.');
    // Switched on already: no cap to type, one switch back.
    expect(within(credits).queryByLabelText('Stop at, in dollars a month')).toBeNull();

    server.reads['/api/accounts'] = { allowAccounts: true, accounts: [stopped] };
    fireEvent.click(within(credits).getByRole('button', { name: 'Stop using credits' }));
    await waitFor(() =>
      expect(sent(server, 'POST', '/api/accounts/default/overage')).toEqual([{ allowed: false }]),
    );
    await waitFor(() => expect(said()).toEqual(['admin@example.com is back on its plan limits.']));
    expect(
      await within(fact(rowOf('default'), 'Credits')).findByRole('button', {
        name: 'Use credits past plan limits',
      }),
    ).toBeEnabled();
  });

  it('switches credits on with no cap — the account’s own limit is the only one — or with a monthly cap in dollars', async () => {
    const account: AccountView = { ...MACHINE, credits: OFF };
    server.reads['POST /api/accounts/default/overage'] = {
      account: { ...account, credits: { ...OFF, allowed: true, carrying: true } },
    };
    renderWithClient(
      <>
        <CreditsControl account={account} allowed />
        <Toasts />
      </>,
    );
    const cap = screen.getByLabelText('Stop at, in dollars a month');
    expect(cap).toHaveValue(null);
    expect(cap).toHaveAttribute('placeholder', 'its own limit');
    fireEvent.click(screen.getByRole('button', { name: 'Use credits past plan limits' }));
    await waitFor(() =>
      expect(sent(server, 'POST', '/api/accounts/default/overage')).toEqual([{ allowed: true }]),
    );
    await waitFor(() => expect(said()).toEqual(['me@example.com now uses credits past its plan limits.']));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Use credits past plan limits' })).toBeEnabled(),
    );
    fireEvent.change(cap, { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use credits past plan limits' }));
    await waitFor(() =>
      expect(sent(server, 'POST', '/api/accounts/default/overage')).toEqual([
        { allowed: true },
        { allowed: true, capUsd: 25 },
      ]),
    );
  });

  it('reads the cap before anything is sent: one that is not a number of dollars is refused in words', async () => {
    renderWithClient(<CreditsControl account={{ ...MACHINE, credits: OFF }} allowed />);
    const cap = screen.getByLabelText('Stop at, in dollars a month');
    fireEvent.change(cap, { target: { value: '-3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use credits past plan limits' }));
    expect(await screen.findByText('Type a number of dollars, 0 or more.')).toBeInTheDocument();
    expect(cap).toHaveAttribute('aria-invalid', 'true');
    expect(writes()).toEqual([]);
  });

  it('says why an account cannot before anyone presses, and the server’s reason when it refuses', async () => {
    const refusal = 'me@example.com cannot use credits past its plan limits: out of credits';
    server.reads['POST /api/accounts/default/overage'] = new ApiError(
      refusal,
      409,
      '/api/accounts/default/overage',
    );
    mount({
      allowAccounts: true,
      accounts: [{ ...MACHINE, credits: { ...OFF, available: false, reason: 'out of credits' } }],
    });
    const credits = fact(await open('default'), 'Credits');
    expect(credits).toHaveTextContent('Off: out of credits');
    fireEvent.click(within(credits).getByRole('button', { name: 'Use credits past plan limits' }));
    await waitFor(() => expect(said()).toEqual([refusal]));
    expect(sent(server, 'POST', '/api/accounts/default/overage')).toEqual([{ allowed: true }]);
    await waitFor(() =>
      expect(within(credits).getByRole('button', { name: 'Use credits past plan limits' })).toBeEnabled(),
    );
  });
});

describe('the windows and the login, as the row reads them (control-tower phase 76)', () => {
  const polledAt = at(-3 * MINUTE);
  const resetsAt = at(96 * HOUR);
  const wallsAt = at(105 * MINUTE);
  const climbing: BucketForecast = {
    pct: 51,
    burnPctPerHour: 28,
    trend: 'climbing',
    wallsAt,
    resetsAt,
    samples: 3,
    spanMs: 1_800_000,
  };
  const flat: BucketForecast = {
    pct: 78,
    burnPctPerHour: 0.1,
    trend: 'flat',
    wallsAt: null,
    resetsAt,
    samples: 3,
    spanMs: 1_800_000,
  };
  const admin = (over: Partial<AccountView>): AccountView => ({
    id: 'acct-346a',
    kind: 'profile',
    builtIn: false,
    name: 'admin',
    credential: 'aaaabbbbccccdddd',
    authState: 'ok',
    entitlement: { state: 'entitled', via: 'credential' },
    pollEveryMs: 600_000,
    ...over,
  });

  it('says whether each window is climbing — its burn and its projected wall — or flat', async () => {
    mount({
      allowAccounts: true,
      accounts: [
        admin({
          usage: {
            buckets: {
              five_hour: { utilization: 51, resetsAt, polledAt, stale: false },
              seven_day: { utilization: 78, resetsAt, polledAt, stale: false },
            },
            fetchedAt: polledAt,
          },
          forecast: {
            buckets: { five_hour: climbing, seven_day: flat },
            wallsAt,
            bucket: 'five_hour',
            burning: [],
          },
        }),
      ],
    });
    const row = await open('acct-346a');
    const clock = new Date(wallsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    expect(row.querySelector('[data-window="five_hour"]')).toHaveTextContent(
      `and climbing, +28 %/h, walls at about ${clock}`,
    );
    const week = row.querySelector('[data-window="seven_day"]');
    expect(week).toHaveTextContent('and flat');
    expect(week).not.toHaveTextContent('%/h');
    expect(within(row).getByTestId('forecast-walls')).toHaveTextContent(
      `At this burn its 5-hour window walls at about ${clock}.`,
    );
    // Nothing while the burn is not measured.
    expect(forecastWords(undefined)).toBe('');
    expect(forecastWords({ ...flat, trend: 'unknown' })).toBe('');
    expect(forecastWords({ ...climbing, burnPctPerHour: null, wallsAt: null })).toBe('and climbing');
  });

  it('says why a stale window is stale, and the failed read beside the windows', async () => {
    mount({
      allowAccounts: true,
      accounts: [
        admin({
          usage: {
            buckets: {
              five_hour: { utilization: 65, resetsAt: at(-HOUR), polledAt, stale: true },
              seven_day: { utilization: 14, resetsAt, polledAt, stale: false },
            },
            fetchedAt: polledAt,
            lastErrorAt: at(-MINUTE),
            error: 'could not reach the usage endpoint: fetch failed',
          },
          lastErrorAt: at(-MINUTE),
        }),
      ],
    });
    const row = await open('acct-346a');
    const five = row.querySelector('[data-window="five_hour"]');
    expect(five).toHaveTextContent('reset due');
    expect(five).toHaveTextContent('reset since this read');
    const week = row.querySelector('[data-window="seven_day"]');
    expect(week).toHaveTextContent('resets in 96h');
    expect(week).not.toHaveTextContent('stale');
    expect(week).not.toHaveTextContent('reset since this read');
    const windows = fact(row, 'Windows');
    expect(windows).toHaveTextContent('read 3 minutes ago');
    expect(windows).toHaveTextContent('a read failed 1 minute ago');
    expect(windows).toHaveTextContent('could not reach the usage endpoint: fetch failed');
    expect(staleWords(at(HOUR))).toBe('stale');
    expect(staleWords(at(-HOUR))).toBe('reset since this read');
  });

  it('reads an idle login, renewed at its next session, as idle in the signed-in hue — never expired', async () => {
    mount({ allowAccounts: true, accounts: [admin({ authState: 'refreshable' })] });
    const row = await open('acct-346a');
    const login = fact(row, 'Login');
    const idle = word(login, 'auth');
    expect(idle).toHaveAttribute('data-status', 'refreshable');
    expect(idle).toHaveAttribute('data-paint', 'done');
    expect(idle).toHaveTextContent('Idle, renews at next session');
    expect(row).not.toHaveTextContent(/expired/i);
    // Nothing to mend, so no sign-in is offered.
    expect(within(row).queryByRole('button', { name: /^Sign in/ })).toBeNull();
  });
});

describe('Removed, still remembered', () => {
  it('names a removed id by the name it was removed under, with what the machine still knows of its login', () => {
    renderWithClient(
      <TombstonesGroup
        rows={[
          SUPPORT,
          {
            id: 'acct-3',
            name: 'old laptop',
            retiredAt: at(-2 * DAY),
            credential: '5555666677778888',
            orgId: '3f9a1c20',
            entitlement: { state: 'retired', via: 'org' },
          },
        ]}
      />,
    );
    const group = screen.getByRole('region', { name: 'Removed, still remembered' });
    expect(group).toHaveTextContent('A removed account stays named here');
    const support = group.querySelector<HTMLElement>('[data-tombstone="support"]')!;
    expect(support).toHaveTextContent('Support Max');
    expect(within(support).getByText('support', { selector: 'code' })).toBeInTheDocument();
    expect(support).toHaveTextContent('removed 1 hour ago');
    expect(word(support, 'entitlement')).toHaveAttribute('data-status', 'unknown');
    // A retired login stays retired if it is registered again — with its organisation.
    const laptop = group.querySelector<HTMLElement>('[data-tombstone="acct-3"]')!;
    expect(laptop).toHaveTextContent('old laptop');
    expect(laptop).toHaveTextContent('removed 2 days ago');
    expect(word(laptop, 'entitlement')).toHaveAttribute('data-status', 'retired');
    expect(laptop).toHaveTextContent('organisation 3f9a1c20');
  });

  it('sits under the accounts in the section, and is not drawn when nothing was removed', async () => {
    const view = mount();
    const group = await screen.findByRole('region', { name: 'Removed, still remembered' });
    expect(group.querySelector('[data-tombstone="support"]')).toHaveTextContent('Support Max');
    view.unmount();

    // An empty list, or a server older than tombstones, draws no group at all.
    mount({ allowAccounts: true, accounts: [MACHINE] });
    await open('default');
    expect(screen.queryByRole('region', { name: 'Removed, still remembered' })).toBeNull();
    const empty = renderWithClient(<TombstonesGroup rows={[]} />);
    expect(empty.container).toBeEmptyDOMElement();
  });
});
