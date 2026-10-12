/**
 * Logs ▸ Access (control-tower phase 25; 7.0, quiet-console phase 20) — the
 * access cases of 6.2's Debug page suite, ported to the kit grid.
 *
 * `state.access` answers "has the phone path ever worked?", and since 7.0's
 * header carries no presence chip this is its only home. Pinned: the requests
 * counted by scope; every phone login seen, hashed and newest first, on a desk
 * and on a phone; "never" for a phone that never came, said in words rather
 * than left blank; and an older server that sends no ledger said as such,
 * never drawn as a console nobody reached.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The server's answers by path (the part before `?`). */
const server = vi.hoisted(() => ({ reads: {} as Record<string, unknown> }));
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  const answer = async (path: string) => {
    const read = server.reads[path.split('?')[0]!];
    if (typeof read === 'function') return (read as (path: string) => unknown)(path);
    if (read !== undefined) return read;
    throw new actual.ApiError(`Nothing is fixtured for ${path}`, 404, path);
  };
  return { ...actual, request: (path: string) => answer(path), post: (path: string) => answer(path) };
});

import type { ConsoleState } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { setPrefs } from '@/lib/prefs';
import { MemoryRouterProvider } from '@/shell/router';
import { parseHash, type Route } from '@/shell/routes';
import { TooltipProvider } from '@/ui/tooltip';
import AccessSection, { when } from './access-section';
import { logsSectionHref } from './routes';

/**
 * Below the shell breakpoint while `media.phone` is set. `lib/media` caches
 * each query's list the first time it is asked, so `matches` is read live.
 */
const media = { phone: false };
window.matchMedia = (query: string) =>
  ({
    media: query,
    get matches() {
      return media.phone && /max-width: 899px/.test(query);
    },
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

/* ---------------- the server's answers ---------------- */

const ACCESS: NonNullable<ConsoleState['access']> = {
  served: { local: 1204, remote: 7 },
  lastRemoteAt: '2026-09-29T09:58:00.000Z',
  identities: [
    {
      host: 'tablet.tail',
      loginHash: 'cccc3333dddd4444',
      first: '2026-09-20T08:00:00.000Z',
      last: '2026-09-21T08:00:00.000Z',
      count: 2,
    },
    {
      host: 'phone.tail',
      loginHash: 'aaaa1111bbbb2222',
      first: '2026-09-28T08:00:00.000Z',
      last: '2026-09-29T09:58:00.000Z',
      count: 5,
    },
  ],
};

const stateWith = (access: ConsoleState['access']) =>
  ({ root: { path: '/repo', ok: true }, access }) as unknown as ConsoleState;

/* ---------------- the page ---------------- */

function mount() {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  const address = logsSectionHref('access');
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={address}>
        <TooltipProvider>
          <AccessSection route={parseHash(address) as Route} />
        </TooltipProvider>
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

/** A KeyValue's rows inside `root`, label → its value cell. */
function facts(root: HTMLElement): Record<string, HTMLElement> {
  return Object.fromEntries(
    [...root.querySelectorAll('dt')].map((dt) => [
      dt.textContent ?? '',
      dt.nextElementSibling as HTMLElement,
    ]),
  );
}

beforeEach(() => {
  media.phone = false;
  localStorage.clear();
  setPrefs({ tables: {}, everything: {} });
  server.reads = { '/api/state': stateWith(ACCESS) };
});
afterEach(() => {
  media.phone = false;
});

describe('Logs ▸ Access draws state.access — who this console has served', () => {
  it('counts requests by scope and says when a phone last reached it', async () => {
    mount();
    const page = await screen.findByTestId('access');
    const served = within(page).getByRole('region', { name: 'Served since this process booted' });
    const rows = facts(served);
    expect(Object.keys(rows)).toEqual(['On this machine', 'Remotely', 'A phone last reached it']);
    // Grouped like the Requests column: `1,204` in this reader's own locale.
    expect(rows['On this machine']).toHaveTextContent(`${(1204).toLocaleString()} requests`);
    expect(rows.Remotely).toHaveTextContent('7 requests');
    expect(rows['A phone last reached it']).toHaveTextContent(when('2026-09-29T09:58:00.000Z'));
  });

  it('lists every phone login it has seen, newest first, hashed and with its own counts', async () => {
    mount();
    const page = await screen.findByTestId('access');
    const table = within(page).getByRole('table', { name: 'Phones seen' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Host', 'Login (hashed)', 'First seen', 'Last seen', 'Requests']);
    const rows = within(page).getAllByTestId('access-identity');
    expect(rows.map((row) => within(row).getAllByRole('cell')[0]!.textContent)).toEqual([
      'phone.tail',
      'tablet.tail',
    ]);
    const phone = within(rows[0]!).getAllByRole('cell');
    // Hashed, drawn short; the whole hash is one hover away.
    const login = within(phone[1]!).getByText('aaaa1111bbbb');
    expect(login).toHaveAttribute('title', 'aaaa1111bbbb2222');
    expect(phone[2]).toHaveTextContent(when('2026-09-28T08:00:00.000Z'));
    expect(phone[3]).toHaveTextContent(when('2026-09-29T09:58:00.000Z'));
    expect(phone[4]).toHaveTextContent('5');
  });

  it('keeps the same records, newest first, as a list on a phone', async () => {
    media.phone = true;
    mount();
    const page = await screen.findByTestId('access');
    expect(within(page).queryByRole('table')).toBeNull();
    const rows = within(page).getAllByTestId('access-identity');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('phone.tail'),
      expect.stringContaining('tablet.tail'),
    ]);
  });

  it('says only this machine has been served when no phone ever reached it', async () => {
    server.reads['/api/state'] = stateWith({
      served: { local: 3, remote: 0 },
      lastRemoteAt: null,
      identities: [],
    });
    mount();
    const page = await screen.findByTestId('access');
    expect(
      within(page).getByText('No phone has reached this console; only this machine has.'),
    ).toBeInTheDocument();
    expect(within(page).queryByRole('table')).toBeNull();
    const rows = facts(page);
    expect(rows.Remotely).toHaveTextContent('0 requests');
    // Never, in words — not a blank and not the epoch.
    expect(rows['A phone last reached it']).toHaveTextContent('never');
  });

  it('says an older server keeps no access ledger, rather than drawing a console nobody reached', async () => {
    server.reads['/api/state'] = stateWith(undefined);
    mount();
    expect(
      await screen.findByText(
        'This console does not report who it serves: an older server sends no access ledger. Restart it onto this build to count requests.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('access')).toBeNull();
    expect(screen.queryByText(/0 requests/)).toBeNull();
  });

  it('holds its place, busy, while the state is read', () => {
    server.reads['/api/state'] = () => new Promise(() => {});
    mount();
    expect(screen.getByLabelText('Reading who this console served')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByTestId('access')).toBeNull();
  });
});

describe('when', () => {
  it('says never for a moment that did not happen, and keeps a moment it cannot read as written', () => {
    expect(when(null)).toBe('never');
    expect(when(undefined)).toBe('never');
    expect(when('')).toBe('never');
    expect(when('not a date')).toBe('not a date');
    expect(when('2026-09-29T09:58:00.000Z')).toBe(new Date('2026-09-29T09:58:00.000Z').toLocaleString());
  });
});
