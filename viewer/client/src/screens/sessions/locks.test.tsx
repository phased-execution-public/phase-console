/**
 * The Locks section at `#/sessions/locks` (#24; 7.0, quiet-console phase 15),
 * mounted as the shell mounts it — inside the router, over a client of the
 * app's own config, with the console's state already read — against a stubbed
 * server that records every request.
 *
 * What is pinned: every claim in the order the server ranked it, one row each
 * in the kit grid — its state, its phase (a link, with the phase's title), its
 * holder, its lease and its Release — with the rest folded into the row and
 * drawn as columns under Everything: what it holds up (as links), its session
 * and presence, its scope ("everything" when it named none), its branch and
 * tree, when it was claimed, the host and the holder's time left. The page
 * says the claims in words and links the two sections with their counts. The
 * narrowing is the SERVER's — Held, Lapsed and a scope are asked of
 * `GET /api/locks`, never folded here — while the scopes offered and the
 * counts are the unfiltered list's, and the filters last one visit. The one
 * Release: plain on a lapsed claim, behind a confirm on a live one (sent with
 * force), the bulk release in the ⋯ menu, every one refused with the
 * `--allow-writes` sentence on a console without it, and a 409 said in the
 * server's own words. No claims, no table.
 */

import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockRow } from '@/data/api';
import { keys, queryClientConfig } from '@/data/keys';
import { getPrefs, setPrefs } from '@/lib/prefs';
import { MemoryRouterProvider } from '@/shell/router';
import { parseHash, type Route } from '@/shell/routes';
import { expectNoAxeViolations } from '@/test/axe';
import { Toaster, dismissToast, useToasts } from '@/ui';
import { TooltipProvider } from '@/ui/tooltip';
import { __resetInspectorForTests, useInspected } from '@/shell/panel/inspector-host';
import { EVERY_REPO, claimState, lockLanes } from './lock-map';
import LocksSection, { lockScopes, lockSituation, lockStateText } from './locks';

vi.setConfig({ testTimeout: 20_000 });

const NOW = Date.now();

/** Worst first, as the server ranks them: a lapsed claim, a live one holding work up, a live one holding nothing. */
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
    eta: { label: '~2 h', of: 'phase' },
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

/** The refusal every write-class surface says on a console started without the flag. */
const WRITES_OFF = 'Writes are disabled. Restart the console with --allow-writes to release a claim.';

/** One live shell — the count the Sessions link carries beside the claims'. */
const TERMINALS = {
  allowed: true,
  available: 'yes',
  limit: 8,
  live: 1,
  sessions: [
    {
      id: 'sh-1',
      label: 'zsh',
      kind: 'shell',
      cwd: '/work/shop',
      shell: '/bin/zsh',
      cols: 80,
      rows: 24,
      pid: 4242,
      clients: 0,
      createdAt: NOW,
    },
  ],
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let claims: LockRow[] = [];
let state: Record<string, unknown> = {};
/** Every request the page made, in order: the method, the address, and what a POST carried. */
let sent: { method: string; url: string; body?: Record<string, unknown> }[] = [];
/** How `POST /api/locks/release` answers. The owner comes off the lock file on the server, as it does there. */
let release: (body: Record<string, unknown>) => Response;

/** `GET /api/locks`, narrowed the way `server/locks.ts` narrows it: a claim that names no scope meets every scope. */
const narrowed = (query: URLSearchParams): LockRow[] =>
  claims.filter(
    (row) =>
      (query.get('held') !== '1' || !row.lapsed) &&
      (query.get('lapsed') !== '1' || row.lapsed) &&
      (!query.get('scope') || !row.scope.length || row.scope.includes(query.get('scope')!)),
  );

function answer(method: string, url: string, body: Record<string, unknown>): Response {
  const { pathname, searchParams } = new URL(url, 'http://console.test');
  if (method === 'POST' && pathname === '/api/locks/release') return release(body);
  if (pathname === '/api/locks') return json({ rows: narrowed(searchParams) });
  if (pathname === '/api/state') return json(state);
  if (pathname === '/api/terminal') return json(TERMINALS);
  if (pathname === '/api/sessions/registry') return json({ sessions: [] });
  if (pathname === '/api/runs' || pathname === '/api/approvals') return json([]);
  return json({});
}

beforeEach(() => {
  sent = [];
  localStorage.clear();
  // The shipped defaults: Everything off, no table view kept.
  setPrefs({ everything: {}, tables: {} });
  claims = ROWS;
  state = {
    autopilot: true,
    allowRun: true,
    allowWrites: true,
    allowTerminal: true,
    root: { path: '/repo', ok: true, planCount: 2, handoffCount: 1 },
  };
  release = (body) => {
    if (body.expired) {
      const lapsed = claims.filter((row) => row.lapsed);
      return json({
        results: lapsed.map((row) => ({ slug: row.slug, phase: row.phase, ok: true, owner: row.owner })),
        released: lapsed.length,
      });
    }
    const held = claims.find((row) => row.slug === body.slug && row.phase === body.phase);
    return json({ slug: body.slug, phase: body.phase, ok: true, owner: held?.owner ?? null });
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      sent.push({ method, url, ...(body ? { body } : {}) });
      return answer(method, url, body ?? {});
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  // The tray's store is the module's own and outlives a render: what one case
  // raised is not the next case's news.
  const { result, unmount } = renderHook(() => useToasts());
  act(() => {
    for (const one of result.current) dismissToast(one.id);
  });
  unmount();
});

function mount(address = '#/sessions/locks', extra?: ReactNode) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  // Read already, as the shell has it before any page mounts — and answered
  // again by the stub should anything ask.
  client.setQueryData(keys.state(), state);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={address}>
        <TooltipProvider>
          <LocksSection route={parseHash(address) as Route} />
          {extra}
          <Toaster />
        </TooltipProvider>
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

const gets = () => sent.filter((one) => one.method === 'GET').map((one) => one.url);
const reads = (url: string) => gets().filter((one) => one === url).length;
const posts = () => sent.filter((one) => one.method === 'POST').map(({ url, body }) => ({ url, body }));

/** The claims drawn, by their `data-lock`, in the order drawn. */
const listed = () =>
  [...document.querySelectorAll('[data-lock]')].map((row) => row.getAttribute('data-lock'));
const rowOf = (key: string): HTMLElement => {
  const row = document.querySelector<HTMLElement>(`[data-lock="${key}"]`);
  if (!row) throw new Error(`no row for ${key}`);
  return row;
};
const findRow = (key: string) => waitFor(() => rowOf(key));
const heads = () =>
  within(screen.getByRole('table', { name: 'Phase claims' }))
    .getAllByRole('columnheader')
    .map((th) => th.textContent);
/** A row's cells, by their column's head. */
function cellsOf(key: string): Record<string, HTMLElement> {
  const cells = within(rowOf(key)).getAllByRole('cell');
  return Object.fromEntries(heads().map((head, i) => [head, cells[i]!]));
}
const filterButton = () => screen.getByRole('button', { name: /^Filter/ });
async function openFilter(): Promise<HTMLElement> {
  fireEvent.click(filterButton());
  return screen.findByRole('radiogroup', { name: 'Which claims' });
}
async function openMore(): Promise<HTMLElement> {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }), { button: 0, ctrlKey: false });
  return screen.findByRole('menu');
}

describe('every claim, as the server ranked it', () => {
  it('draws one row per claim in the order served: its state, its phase, its holder, its lease, its Release', async () => {
    const { container } = mount();
    await waitFor(() => expect(listed()).toEqual(['shop/2', 'shop/5', 'blog/1']));
    expect(heads()).toEqual(['State', 'Phase', 'Holder', 'Lease', 'Release']);
    expect(rowOf('shop/2')).toHaveAttribute('data-lapsed');
    expect(rowOf('shop/5')).not.toHaveAttribute('data-lapsed');

    const lapsed = cellsOf('shop/2');
    expect(lapsed.State).toHaveTextContent('Lapsed, still on disk');
    const phase = within(lapsed.Phase).getByRole('link', { name: /^shop P2/ });
    expect(phase).toHaveAttribute('href', '#/plan/shop/phase/2');
    expect(phase).toHaveTextContent('Checkout');
    expect(lapsed.Holder).toHaveTextContent('autopilot/abcdef12');
    expect(lapsed.Holder).toHaveTextContent('the autopilot of run abcdef12');
    expect(lapsed.Lease).toHaveTextContent('lapsed');
    expect(within(lapsed.Release).getByRole('button', { name: 'Release' })).toBeEnabled();

    const live = cellsOf('shop/5');
    expect(live.State).toHaveTextContent('Holding up 2');
    expect(within(live.Phase).getByRole('link', { name: /^shop P5/ })).toHaveTextContent('Payments');
    expect(live.Holder).toHaveTextContent('sam@laptop');
    expect(live.Holder).toHaveTextContent('a person');
    expect(live.Lease).toHaveTextContent('1h left');

    const idle = cellsOf('blog/1');
    expect(idle.State).toHaveTextContent(/^Held$/);
    expect(idle.Holder).toHaveTextContent('kim@desk');

    await expectNoAxeViolations(container);
  });

  it('folds the rest of a claim into its row at the glance — counted, one press away', async () => {
    mount();
    const live = await findRow('shop/5');
    expect(within(live).getByText('+7')).toBeInTheDocument();
    const toggle = within(live).getByRole('button', { name: 'Show the rest of this row — 7 more columns' });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const detail = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect([...detail.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual([
      'Holding up',
      'Session',
      'Scope',
      'Branch and tree',
      'Claimed',
      'Host',
      'Time left',
    ]);
    // What it holds up is the list itself, each a link — never a count behind a hover.
    const blocks = within(detail).getByTestId('lock-blocks');
    expect(within(blocks).getByRole('link', { name: 'blog P3' })).toHaveAttribute(
      'href',
      '#/plan/blog/phase/3',
    );
    expect(within(blocks).getByRole('link', { name: 'blog P4' })).toHaveAttribute(
      'href',
      '#/plan/blog/phase/4',
    );
  });

  it('draws every column with Everything on, and keeps that for this page', async () => {
    mount();
    await findRow('shop/5');
    fireEvent.click(screen.getByRole('switch', { name: 'Everything' }));
    await waitFor(() =>
      expect(heads()).toEqual([
        'State',
        'Phase',
        'Holder',
        'Lease',
        'Release',
        'Holding up',
        'Session',
        'Scope',
        'Branch and tree',
        'Claimed',
        'Host',
        'Time left',
      ]),
    );
    expect(getPrefs().everything.locks).toBe(true);

    const live = cellsOf('shop/5');
    expect(
      within(within(live['Holding up']).getByTestId('lock-blocks'))
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')]),
    ).toEqual([
      ['blog P3', '#/plan/blog/phase/3'],
      ['blog P4', '#/plan/blog/phase/4'],
    ]);
    // The session, short and copyable whole, and whether it lives.
    expect(within(live.Session).getByRole('button', { name: 'c399fe08-000' })).toHaveAttribute(
      'title',
      'c399fe08-0000-0000-0000-000000000001 — press to copy',
    );
    expect(live.Session).toHaveTextContent('Live');
    expect(live.Scope).toHaveTextContent('app');
    expect(live['Branch and tree']).toHaveTextContent('pe/shop');
    expect(live['Branch and tree']).toHaveTextContent('/work/shop');
    expect(live.Claimed).toHaveTextContent('10 minutes ago');
    expect(live.Host).toHaveTextContent('laptop');
    expect(live['Time left']).toHaveTextContent('P5 has ~2 h');

    const idle = cellsOf('blog/1');
    // A claim that named no scope collides with every other, and says so.
    expect(idle.Scope).toHaveTextContent('everything');
    expect(idle.Session).toHaveTextContent('none named');
    expect(idle['Branch and tree']).toHaveTextContent('not said');
    expect(idle['Holding up']).toHaveTextContent('—');
  });

  it('says the claims in words and links the two sections, each with its count', async () => {
    mount();
    expect(
      await screen.findByText('1 lapsed and still on disk, 1 holding up other work and 1 held.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Locks' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Every session' })).toHaveAttribute('href', '#/sessions');

    const sections = screen.getByRole('navigation', { name: 'Sessions sections' });
    const processes = within(sections).getByRole('link', { name: /^Sessions/ });
    expect(processes).toHaveAttribute('href', '#/sessions');
    await waitFor(() => expect(processes).toHaveTextContent(/^Sessions\s*1$/));
    const locks = within(sections).getByRole('link', { name: /^Locks/ });
    expect(locks).toHaveAttribute('href', '#/sessions/locks');
    expect(locks).toHaveAttribute('aria-current', 'page');
    expect(locks).toHaveTextContent(/^Locks\s*3$/);
  });

  it('says nothing is claimed, draws no table over nothing, and leads with no figure', async () => {
    claims = [];
    mount();
    expect(
      await screen.findByText(
        'No phase is claimed right now. A claim shows here the moment a session takes one, from this console or by hand.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Locks' }).nextElementSibling).toBeNull();
  });

  it('reads an unknown view as the claims', async () => {
    mount('#/sessions/locks?view=board');
    expect(await screen.findByRole('table', { name: 'Phase claims' })).toBeInTheDocument();
  });
});

describe('the narrowing is the server’s', () => {
  it('asks for the held claims, draws exactly what came back, and keeps the counts unfiltered', async () => {
    mount();
    await waitFor(() => expect(listed()).toHaveLength(3));
    expect(gets()).toContain('/api/locks');

    const which = await openFilter();
    const [every, held, lapsed] = within(which).getAllByRole('radio');
    expect(every).toHaveAccessibleName(/^Every claim/);
    expect(held).toHaveAccessibleName(/^Held/);
    expect(lapsed).toHaveAccessibleName(/^Lapsed/);
    expect(every).toBeChecked();
    fireEvent.click(held!);
    await waitFor(() => expect(listed()).toEqual(['shop/5', 'blog/1']));
    expect(gets()).toContain('/api/locks?held=1');
    expect(filterButton()).toHaveAccessibleName('Filter, Held');
    expect(screen.getByTestId('locks-filtered')).toHaveTextContent(
      'Showing 2 of 3 claims: 1 hidden by the filters.',
    );
    // The situation and the section's count are the whole list's, whatever the filter shows.
    expect(
      screen.getByText('1 lapsed and still on disk, 1 holding up other work and 1 held.'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('navigation', { name: 'Sessions sections' })).getByRole('link', {
        name: /^Locks/,
      }),
    ).toHaveTextContent(/^Locks\s*3$/);

    // Held, in one repository — both asked in one question.
    fireEvent.change(screen.getByTestId('locks-filter-scope'), { target: { value: 'web' } });
    await waitFor(() => expect(listed()).toEqual(['blog/1']));
    expect(gets()).toContain('/api/locks?held=1&scope=web');
    expect(filterButton()).toHaveAccessibleName('Filter, Held, web');

    // Every claim again is the unfiltered read, already in hand.
    fireEvent.change(screen.getByTestId('locks-filter-scope'), { target: { value: '' } });
    fireEvent.click(every!);
    await waitFor(() => expect(listed()).toEqual(['shop/2', 'shop/5', 'blog/1']));
    expect(filterButton()).toHaveAccessibleName('Filter');
    expect(screen.queryByTestId('locks-filtered')).toBeNull();
  });

  it('asks for the lapsed claims, and still offers every scope the claims name', async () => {
    mount();
    await waitFor(() => expect(listed()).toHaveLength(3));
    fireEvent.click(within(await openFilter()).getByRole('radio', { name: /^Lapsed/ }));
    await waitFor(() => expect(listed()).toEqual(['shop/2']));
    expect(gets()).toContain('/api/locks?lapsed=1');
    // The lapsed claims name only `web`; the choice is read off the unfiltered list.
    expect(
      within(screen.getByTestId('locks-filter-scope'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Any repository', 'app', 'web']);
  });

  it('says when the server’s answer is empty, and clears the filter it asked with', async () => {
    claims = ROWS.filter((row) => !row.lapsed);
    mount();
    await waitFor(() => expect(listed()).toHaveLength(2));
    fireEvent.click(within(await openFilter()).getByRole('radio', { name: /^Lapsed/ }));
    const none = await screen.findByText('No claim matches the filters.');
    expect(gets()).toContain('/api/locks?lapsed=1');
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(within(none.parentElement!).getByRole('button', { name: 'Clear the filters' }));
    await waitFor(() => expect(listed()).toEqual(['shop/5', 'blog/1']));
    expect(filterButton()).toHaveAccessibleName('Filter');
  });

  it('asks for one repository’s claims by its scope', async () => {
    mount();
    await waitFor(() => expect(listed()).toHaveLength(3));
    await openFilter();
    fireEvent.change(screen.getByTestId('locks-filter-scope'), { target: { value: 'app' } });
    // The claim that names no scope meets every scope, so the server keeps it.
    await waitFor(() => expect(listed()).toEqual(['shop/5', 'blog/1']));
    expect(gets()).toContain('/api/locks?scope=app');
    expect(filterButton()).toHaveAccessibleName('Filter, app');
  });

  it('keeps the filters for one visit: the next opens on every claim', async () => {
    const first = mount();
    await waitFor(() => expect(listed()).toHaveLength(3));
    fireEvent.click(within(await openFilter()).getByRole('radio', { name: /^Held/ }));
    await waitFor(() => expect(listed()).toHaveLength(2));
    first.unmount();

    sent = [];
    mount();
    await waitFor(() => expect(listed()).toEqual(['shop/2', 'shop/5', 'blog/1']));
    expect(filterButton()).toHaveAccessibleName('Filter');
    expect(gets().filter((url) => url.startsWith('/api/locks?'))).toEqual([]);
  });

  it('searches the claims on the page, and says when nothing matches', async () => {
    mount();
    await waitFor(() => expect(listed()).toHaveLength(3));
    const search = screen.getByRole('searchbox', {
      name: 'Find a claim by plan, phase, holder, host, branch or scope',
    });
    expect(search).toHaveAttribute('placeholder', 'Find a claim');

    fireEvent.change(search, { target: { value: 'kim' } });
    await waitFor(() => expect(listed()).toEqual(['blog/1']));
    fireEvent.change(search, { target: { value: 'pe/shop' } });
    await waitFor(() => expect(listed()).toEqual(['shop/5']));
    // The search narrows what is in hand; nothing it typed was asked of the server.
    expect(gets().filter((url) => url.startsWith('/api/locks?'))).toEqual([]);

    fireEvent.change(search, { target: { value: 'nothing-holds-this' } });
    const none = await screen.findByText('No claim matches the filters.');
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(within(none.parentElement!).getByRole('button', { name: 'Clear the filters' }));
    await waitFor(() => expect(listed()).toHaveLength(3));
    expect(search).toHaveValue('');
  });
});

describe('Release — the one verb', () => {
  it('releases a lapsed claim with one press, without force, and reads the claims again', async () => {
    mount();
    const lapsed = await findRow('shop/2');
    const before = reads('/api/locks');
    const press = within(lapsed).getByRole('button', { name: 'Release' });
    expect(press).toHaveAttribute('title', 'Release the lapsed claim on shop P2');
    fireEvent.click(press);
    await waitFor(() =>
      expect(posts()).toEqual([{ url: '/api/locks/release', body: { slug: 'shop', phase: 2 } }]),
    );
    // The page sent no owner: the server read it off the lock file, and the toast says whose it was.
    expect(
      await screen.findByText('Released shop P2 — it was held by autopilot/abcdef12'),
    ).toBeInTheDocument();
    await waitFor(() => expect(reads('/api/locks')).toBeGreaterThan(before));
  });

  it('asks before releasing a live claim, naming its holder, and releases it with force once meant', async () => {
    mount();
    const live = await findRow('shop/5');
    fireEvent.click(within(live).getByRole('button', { name: 'Release' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Release shop P5 while it is held?' });
    expect(ask).toHaveTextContent(
      'It is held by sam@laptop on laptop, claimed 10 minutes ago, and its lease runs 1h more.',
    );
    // Leaving it held sends nothing.
    fireEvent.click(within(ask).getByRole('button', { name: 'Leave it held' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(posts()).toEqual([]);

    fireEvent.click(within(live).getByRole('button', { name: 'Release' }));
    const again = await screen.findByRole('alertdialog', { name: 'Release shop P5 while it is held?' });
    fireEvent.click(within(again).getByRole('button', { name: 'Release the claim anyway' }));
    await waitFor(() =>
      expect(posts()).toEqual([{ url: '/api/locks/release', body: { slug: 'shop', phase: 5, force: true } }]),
    );
  });

  it('says a refused release in the server’s own words, and reports nothing released', async () => {
    const words = 'shop P2 is still held: autopilot/abcdef12 refreshed its lease a minute ago.';
    release = () => json({ error: words }, 409);
    mount();
    fireEvent.click(within(await findRow('shop/2')).getByRole('button', { name: 'Release' }));
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(screen.queryByText(/^Released/)).toBeNull();
  });

  it('without --allow-writes every Release is drawn and disabled, and the page says why', async () => {
    state = { ...state, allowWrites: false };
    mount();
    const lapsed = within(await findRow('shop/2')).getByRole('button', { name: 'Release' });
    expect(lapsed).toBeDisabled();
    expect(lapsed).toHaveAttribute('title', WRITES_OFF);
    expect(within(rowOf('shop/5')).getByRole('button', { name: 'Release' })).toBeDisabled();
    expect(within(rowOf('blog/1')).getByRole('button', { name: 'Release' })).toBeDisabled();
    // Said once, under the toolbar — never a button that does nothing.
    expect(screen.getByText(WRITES_OFF)).toBeInTheDocument();
    fireEvent.click(lapsed);
    expect(posts()).toEqual([]);
  });
});

describe('the ⋯ menu', () => {
  it('releases every lapsed claim in one press, and says how many', async () => {
    mount();
    await waitFor(() => expect(listed()).toHaveLength(3));
    const all = within(await openMore()).getByRole('menuitem', { name: /^Release every lapsed claim \(1\)/ });
    expect(all).not.toHaveAttribute('data-disabled');
    fireEvent.click(all);
    await waitFor(() => expect(posts()).toEqual([{ url: '/api/locks/release', body: { expired: true } }]));
    expect(await screen.findByText('Released 1 lapsed claim.')).toBeInTheDocument();
  });

  it('refuses the bulk release with its reason: nothing has lapsed', async () => {
    claims = ROWS.filter((row) => !row.lapsed);
    mount();
    await waitFor(() => expect(listed()).toHaveLength(2));
    const all = within(await openMore()).getByRole('menuitem', { name: /^Release every lapsed claim/ });
    expect(all).toHaveAttribute('data-disabled');
    expect(all).toHaveTextContent('No claim has lapsed.');
  });

  it('refuses the bulk release with its reason: writes are off', async () => {
    state = { ...state, allowWrites: false };
    mount();
    await waitFor(() => expect(listed()).toHaveLength(3));
    const all = within(await openMore()).getByRole('menuitem', { name: /^Release every lapsed claim \(1\)/ });
    expect(all).toHaveAttribute('data-disabled');
    expect(all).toHaveTextContent(WRITES_OFF);
    fireEvent.click(all);
    expect(posts()).toEqual([]);
  });
});

describe('the words', () => {
  const holding = ROWS[1]!.blocking;

  it('says what a claim is doing to the rest of the machine — a lapse first', () => {
    expect(lockStateText({ lapsed: true, blocking: holding })).toBe('Lapsed, still on disk');
    expect(lockStateText({ lapsed: false, blocking: holding })).toBe('Holding up 2');
    expect(lockStateText({ lapsed: false, blocking: [] })).toBe('Held');
  });

  it('says the claims at a glance, only the figures that are not zero', () => {
    const held = { lapsed: false, blocking: [] };
    expect(lockSituation([])).toBe('');
    expect(lockSituation(ROWS)).toBe('1 lapsed and still on disk, 1 holding up other work and 1 held.');
    expect(lockSituation([held, held])).toBe('2 held.');
    expect(lockSituation([ROWS[0]!, held, held])).toBe('1 lapsed and still on disk and 2 held.');
  });

  it('reads each scope the claims name once, in order — a claim that names none adds none', () => {
    expect(lockScopes(ROWS)).toEqual(['app', 'web']);
    expect(lockScopes([{ scope: ['web', 'app'] }, { scope: ['app'] }, { scope: [] }])).toEqual([
      'app',
      'web',
    ]);
  });
});


/**
 * The lock map (one-pool phase 16, #364): one lane per repository, each claim a
 * lease bar, a claim with no scope on every lane, overlaps stacked, and a bar
 * that opens the claim in the panel with its Release.
 */
describe('the lock map', () => {
  afterEach(() => __resetInspectorForTests());

  it('lays one lane per repository, a claim with no scope on every one, overlaps stacked', () => {
    const lanes = lockLanes(ROWS, NOW);
    expect(lanes.map((lane) => lane.repo)).toEqual(['app', 'web']);
    // blog P1 names no scope: it is on both lanes, and on each it overlaps the other claim.
    for (const lane of lanes) {
      expect(lane.claims.map((c) => `${c.row.slug}/${c.row.phase}`)).toContain('blog/1');
    }
    const app = lanes.find((lane) => lane.repo === 'app')!;
    expect(app.depth).toBe(2);
    expect(app.claims.map((c) => c.stack).sort()).toEqual([0, 1]);
    // A lease bar: claimed to the end of its lease.
    const shop5 = app.claims.find((c) => c.row.phase === 5)!;
    expect([shop5.start, shop5.end]).toEqual([ROWS[1]!.claimedAt, ROWS[1]!.leaseUntil]);
    // With nothing but unscoped claims, there is one lane for every repository.
    expect(lockLanes([ROWS[2]!], NOW).map((lane) => lane.repo)).toEqual([EVERY_REPO]);
    expect(lockLanes([], NOW)).toEqual([]);
  });

  it('paints a claim by what it does to the machine', () => {
    expect(claimState(ROWS[0]!)).toBe('state-skipped');
    expect(claimState(ROWS[1]!)).toBe('state-waiting');
    expect(claimState(ROWS[2]!)).toBe('state-running');
  });

  it('is the section’s map view, at its own address, with the lanes and the lease bars', async () => {
    mount();
    await findRow('shop/2');
    const views = screen.getByRole('navigation', { name: 'What the locks show' });
    expect(within(views).getByRole('link', { name: 'Map' })).toHaveAttribute(
      'href',
      '#/sessions/locks?view=map',
    );
  });

  it('draws the lanes, the lapsed claim hatched, and inspects a bar with its Release', async () => {
    function Probe() {
      const record = useInspected();
      return record ? <div data-testid="panel">{record.actions}</div> : null;
    }
    mount('#/sessions/locks?view=map', <Probe />);
    const map = await screen.findByTestId('lock-map');
    expect(within(map).getByText('app')).toBeInTheDocument();
    expect(within(map).getByText('web')).toBeInTheDocument();
    expect(screen.getByTestId('lock-map-lead')).toHaveTextContent(
      // On web, shop P2's lease ended the minute blog P1 was claimed: one after the other, not at once.
      '2 repositories under 3 claims; app is held by more than one at once',
    );
    const svg = map.querySelector('svg')!;
    // Four bars: shop P2 on web, shop P5 on app, and blog P1 on both.
    const bars = [...svg.querySelectorAll('[role="button"]')];
    expect(bars).toHaveLength(4);
    expect(svg.querySelectorAll('rect.state-skipped').length).toBeGreaterThan(0);
    expect(svg.innerHTML).toContain('url(#pe-lock-map-lapsed)');
    // The two entries shop P5 holds up are ghosts at its lease's end.
    expect(
      [...svg.querySelectorAll('text')].filter((t) => t.textContent?.startsWith('◌')).length,
    ).toBeGreaterThan(0);
    const shop5 = bars.find((bar) => bar.getAttribute('aria-label')?.startsWith('shop P5'))!;
    expect(shop5.getAttribute('aria-label')).toMatch(
      /a person, 1h 19m left|a person, 1h 20m left|holding up 2 entries/,
    );
    fireEvent.click(shop5);
    expect(await screen.findByTestId('panel')).toHaveTextContent('Release');
    expect(screen.queryByRole('table', { name: 'Phase claims' })).toBeNull();
  });
});
