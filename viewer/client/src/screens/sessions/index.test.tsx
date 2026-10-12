/**
 * Sessions, the place (7.0, quiet-console phase 15): `index.tsx` mounted as
 * the shell mounts it — reading its address from the router, over a client of
 * the app's own config — against a stubbed server that answers by path and
 * records what it was sent.
 *
 * (`session-page.test.tsx` is one session open, `locks.test.tsx` the claims,
 * and `list.test.tsx` / `toolbar.test.tsx` the list's grid and its controls.
 * What is here is the place that holds them.)
 *
 * What is pinned:
 *
 * - **One place, four addresses.** `#/sessions` the list, `#/sessions/locks`
 *   the claims — a section, never a session — `#/sessions/<id>` one session
 *   open, and `?new=agent|shell` the two launch doors.
 * - **The list's frame.** The situation as its lead, and the cap said there at
 *   the cap; New session a LINK to its launch door and New shell one press,
 *   each only on a console with its flag; the two sections as real links with
 *   their counts; the toolbar only where there is something to control; every
 *   empty state one line and the way on — and both flags named where the
 *   console opens nothing of its own.
 * - **What it reads**: the SLIM run list (#234) and never the whole one, the
 *   approvals and the presence registry, the ptys only on a console that can
 *   have one, and no run at all from a server with no autopilot.
 * - **What it keeps**: the kind, the order and the grouping in the 6.x keys
 *   (`sessionsKind`, `sessionsSort`, `sessionsGroup` — a boolean); the words
 *   for one visit only.
 * - **The launch doors, from 6.2.** Visiting one starts nothing — under
 *   StrictMode a mount that minted would mint twice. Only its press mints:
 *   the agent's with exactly what the form collected plus the size its pane
 *   will settle on, the shell's with the size alone. Each lands on what it
 *   opened and STAYS there while its own mint's re-read lands (the
 *   `isFetching` bounce). Each is refused by its flag, at the cap, and where
 *   node-pty did not load — never a press that can only be refused.
 *
 * The emulator is stubbed (`./pane`): xterm measures real fonts and owns a
 * socket, and jsdom has neither. The launch form is the REAL one — the
 * `session` mode of the one launch form, through the launch door — so the body
 * a Claude session starts with is pinned end to end.
 *
 * Moved to `session-page.test.tsx`, with the page they are about: the mode a
 * session was launched in (the panel's facts now), the ended and gone states,
 * the cap counted across both kinds, and the plan-created banner. Dropped by
 * design: the strip as a tab list — 7.0's session head is one line, and its
 * Switch menu is the way between sessions.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleState, ForeignSession, TerminalSession, TerminalState } from '@/data/api';
import { keys, queryClientConfig } from '@/data/keys';
import { PREF_DEFAULTS, getPrefs, setPrefs } from '@/lib/prefs';
import { __resetInspectorForTests } from '@/shell/panel/inspector-host';
import { MemoryRouterProvider, useRoute } from '@/shell/router';
import { TooltipProvider } from '@/ui/tooltip';
import SessionsPlace from './index';

vi.setConfig({ testTimeout: 20_000 });

/**
 * Below the shell breakpoint while `media.phone` is set — a desk otherwise,
 * as the shared setup answers. `lib/media` keeps each query's list for the
 * whole module, so `matches` is read live rather than fixed when it is made.
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

/* ------------------------------------------------------------------ *
 * The emulator
 * ------------------------------------------------------------------ */

const { pane } = vi.hoisted(() => ({ pane: vi.fn() }));

// ONLY the emulator is stubbed. `default` is what the session page's `lazy()`
// resolves — the emulator stays out of the precached chunk behind that dynamic
// import, and a mock without it renders an empty Suspense forever.
vi.mock('./pane', () => ({
  default: (props: { sessionId: string }) => {
    pane(props.sessionId);
    return <div data-testid="pane">{props.sessionId}</div>;
  },
}));

/* ------------------------------------------------------------------ *
 * The server
 * ------------------------------------------------------------------ */

const NOW = Date.now();
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const BASE_STATE: ConsoleState = {
  autopilot: true,
  allowRun: false,
  allowWrites: false,
  allowTerminal: true,
  allowAgent: true,
  root: { path: '/repo', ok: true, planCount: 1, handoffCount: 1 },
  recentRoots: [],
  unread: 0,
};

const SHELL: TerminalSession = {
  id: 'abc123',
  label: 'Terminal 1',
  kind: 'shell',
  cwd: '/repo',
  shell: '/bin/zsh',
  cols: 100,
  rows: 30,
  pid: 900,
  clients: 1,
  createdAt: NOW - 12 * MIN,
};

const CLAUDE: TerminalSession = {
  ...SHELL,
  id: 'c1',
  label: 'Claude: hello',
  kind: 'claude',
  shell: 'claude',
  pid: 901,
  meta: { model: 'opus', claudeSessionId: '00000000-0000-4000-8000-000000000000' },
};

const listOf = (...sessions: TerminalSession[]): TerminalState => ({
  allowed: true,
  agentAllowed: true,
  available: 'yes',
  limit: 8,
  sessions,
});

const shells = (count: number): TerminalSession[] =>
  Array.from({ length: count }, (_, i) => ({ ...SHELL, id: `s${i}`, label: `Terminal ${i}`, pid: 950 + i }));

/** A run with one lane at work, as the SLIM list carries it (#234): one word per phase. */
const slimRun = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  slug: 'quiet-console',
  status: 'running',
  activePhase: 15,
  halt: null,
  children: { '15': { pid: 4242, phase: 15, sessionId: 'lane-15', startedAt: iso(NOW - 4 * MIN) } },
  verifying: {},
  liveness: [],
  phases: { '14': 'done', '15': 'running' },
  records: {},
  createdAt: iso(NOW - 60 * MIN),
  updatedAt: iso(NOW - MIN),
  resolved: false,
  spentUsd: 1,
  liveUsd: 0,
  runBudgetUsd: null,
  workedMs: 1000,
  model: 'opus',
  ...over,
});

/** Somebody's own `claude`, live and stopped on a permission prompt. */
const WAITING: ForeignSession = {
  sessionId: '11111111-2222-4333-8444-555555555555',
  kind: 'foreign',
  cwd: '/elsewhere',
  owner: 'sam',
  startedAt: iso(NOW - 30 * MIN),
  lastSeen: iso(NOW - MIN),
  turns: 4,
  presence: 'live',
  waiting: { since: iso(NOW - MIN), kind: 'permission' },
};

interface Sent {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

let state: ConsoleState;
let terminals: TerminalState;
let registry: ForeignSession[];
let runs: unknown[];
let approvals: unknown[];
let locks: unknown[];
let sent: Sent[];

/** A stateful mint: the session it opens is in the next listing, or no test could see the bounce it exists for. */
function mint(body: Record<string, unknown>) {
  const session: TerminalSession =
    body.kind === 'claude'
      ? { ...CLAUDE, id: 'a1', label: 'Claude: say hello' }
      : { ...SHELL, id: 'new1', label: 'Terminal 2' };
  terminals = { ...terminals, sessions: [...terminals.sessions, session] };
  return { ok: true, sessionId: session.id, token: 't', expiresAt: 0, path: '/ws/terminal', session };
}

function answer(call: Sent): unknown {
  const [path] = call.url.split('?');
  if (path === '/api/state') return state;
  if (path === '/api/terminal') return call.method === 'POST' ? mint(call.body ?? {}) : terminals;
  if (path === '/api/sessions/registry') return { sessions: registry };
  if (path === '/api/runs') return runs;
  if (path === '/api/approvals') return approvals;
  if (path === '/api/locks') return { rows: locks };
  if (path === '/api/plans') return [];
  // What the launch form reads for its choices.
  if (path === '/api/skills') return [];
  if (path === '/api/accounts') return { accounts: [] };
  if (path === '/api/mcp') return { servers: [] };
  return {};
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // The shipped defaults, so every case opens on what an operator opens on.
  setPrefs({
    sessionsKind: '',
    sessionsSort: 'activity',
    sessionsGroup: true,
    everything: {},
    tables: {},
    panel: { ...PREF_DEFAULTS.panel },
  });
  __resetInspectorForTests();
  state = { ...BASE_STATE };
  terminals = listOf(SHELL);
  registry = [];
  runs = [];
  approvals = [];
  locks = [];
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const call: Sent = {
        method: (init.method ?? 'GET').toUpperCase(),
        url: String(input),
        ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
      };
      sent.push(call);
      return new Response(JSON.stringify(answer(call)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

/* ------------------------------------------------------------------ *
 * The harness
 * ------------------------------------------------------------------ */

/** The place reading its route live, the way the shell hands it one — so a navigation is followed. */
function Place() {
  return <SessionsPlace route={useRoute()} />;
}

function mount(address = '#/sessions') {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  // The shell mounts no page before `/api/state` has answered (`App.tsx`), so
  // the place meets it answered — never a refusal drawn over flags not yet read.
  client.setQueryData(keys.state(), state);
  const navigations: string[] = [];
  const view = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouterProvider initial={address} onNavigate={(to) => navigations.push(to)}>
          <Place />
        </MemoryRouterProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...view, client, navigations };
}

/** The rows the list draws, by key, in the order it draws them. */
const listed = (): string[] =>
  [...document.querySelectorAll('[data-session-row]')].map((row) => row.getAttribute('data-session-row')!);

const posts = () => sent.filter((call) => call.method === 'POST' && call.url === '/api/terminal');
const reads = (url: string) => sent.filter((call) => call.method === 'GET' && call.url === url);

/** A mint carries the size the pane will settle on, inside the server's clamps. */
function expectSized(body: Record<string, unknown> | undefined) {
  expect(body).toBeDefined();
  expect(body!.cols).toEqual(expect.any(Number));
  expect(body!.rows).toEqual(expect.any(Number));
  expect(body!.cols as number).toBeGreaterThanOrEqual(20);
  expect(body!.cols as number).toBeLessThanOrEqual(500);
  expect(body!.rows as number).toBeGreaterThanOrEqual(5);
  expect(body!.rows as number).toBeLessThanOrEqual(200);
}

/* ------------------------------------------------------------------ *
 * One place, four addresses
 * ------------------------------------------------------------------ */

describe('one place, four addresses', () => {
  it('#/sessions is the list', async () => {
    mount('#/sessions');
    const page = await screen.findByTestId('sessions-list');
    expect(within(page).getByRole('heading', { level: 1, name: 'Sessions' })).toBeInTheDocument();
    await waitFor(() => expect(listed()).toEqual(['pty:abc123']));
  });

  it('#/sessions/locks is the claims — a section, never a session called "locks"', async () => {
    mount('#/sessions/locks');
    expect(await screen.findByTestId('locks-section')).toBeInTheDocument();
    expect(screen.queryByTestId('session-page')).toBeNull();
    expect(pane).not.toHaveBeenCalled();
  });

  it('#/sessions/<id> is that session, open', async () => {
    mount('#/sessions/abc123');
    expect(await screen.findByTestId('pane')).toHaveTextContent('abc123');
    expect(screen.getByTestId('session-page')).toBeInTheDocument();
    expect(screen.queryByTestId('sessions-list')).toBeNull();
  });

  it('?new=agent and ?new=shell are the two launch doors', async () => {
    const agent = mount('#/sessions?new=agent');
    expect(
      within(await screen.findByTestId('session-launcher')).getByRole('heading', {
        level: 1,
        name: 'New session',
      }),
    ).toBeInTheDocument();
    agent.unmount();

    mount('#/sessions?new=shell');
    expect(
      within(await screen.findByTestId('shell-launcher')).getByRole('heading', {
        level: 1,
        name: 'New shell',
      }),
    ).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * The list
 * ------------------------------------------------------------------ */

describe('the list', () => {
  it('leads with the situation, and offers each start on a console with its flag', async () => {
    runs = [slimRun()];
    registry = [WAITING];
    mount();

    await waitFor(() => expect(listed()).toHaveLength(3));
    // A summons is counted once, under "needs you", whatever its own word is.
    expect(screen.getByText('1 needs you and 2 running.')).toBeInTheDocument();
    // New session is a LINK to its door: the choices that must exist before
    // an agent pty does are what the door is for. New shell is one press.
    expect(screen.getByTestId('new-session')).toHaveAttribute('href', '#/sessions?new=agent');
    expect(screen.getByTestId('new-shell')).toHaveTextContent('New shell');
    // The page's first press is its own, and nothing was minted to draw it.
    expect(posts()).toEqual([]);
  });

  it('offers only the start its flag allows', async () => {
    state = { ...BASE_STATE, allowTerminal: false };
    const agentOnly = mount();
    await screen.findByTestId('sessions-list');
    expect(screen.getByTestId('new-session')).toBeInTheDocument();
    expect(screen.queryByTestId('new-shell')).toBeNull();
    agentOnly.unmount();

    state = { ...BASE_STATE, allowAgent: false };
    mount();
    await screen.findByTestId('sessions-list');
    expect(await screen.findByTestId('new-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('new-session')).toBeNull();
  });

  it('says the cap in its lead, and refuses both starts at it', async () => {
    terminals = listOf(...shells(8));
    mount();

    await waitFor(() => expect(listed()).toHaveLength(8));
    expect(
      screen.getByText(
        '8 running. 8 sessions are running, the most this console allows at once: close one to start another.',
      ),
    ).toBeInTheDocument();
    // A refused start is a button that says so, never a link that goes somewhere to be refused.
    expect(screen.queryByTestId('new-session')).toBeNull();
    expect(screen.getByRole('button', { name: 'New session' })).toBeDisabled();
    expect(screen.getByTestId('new-shell')).toBeDisabled();
  });

  it('New shell opens one at the size its pane will settle on, and lands on it', async () => {
    const { navigations } = mount();
    await waitFor(() => expect(listed()).toEqual(['pty:abc123']));
    fireEvent.click(screen.getByTestId('new-shell'));

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(Object.keys(posts()[0]!.body ?? {}).sort()).toEqual(['cols', 'rows']);
    expectSized(posts()[0]!.body);
    await waitFor(() => expect(navigations).toEqual(['#/sessions/new1']));
    await waitFor(() => expect(screen.getByTestId('pane')).toHaveTextContent('new1'));
  });

  it('draws its two sections as real links, each with its count', async () => {
    terminals = listOf(SHELL, CLAUDE);
    locks = [
      { slug: 'alpha', phase: 2 },
      { slug: 'beta', phase: 1 },
    ];
    mount();

    const nav = await screen.findByRole('navigation', { name: 'Sessions sections' });
    const list = within(nav).getByRole('link', { name: /^Sessions/ });
    const claims = within(nav).getByRole('link', { name: /^Locks/ });
    // The list says how many claims are held, and the claims how many
    // processes there are — one glance either way.
    await waitFor(() => expect(list).toHaveTextContent('Sessions2'));
    await waitFor(() => expect(claims).toHaveTextContent('Locks2'));
    expect(list).toHaveAttribute('href', '#/sessions');
    expect(list).toHaveAttribute('aria-current', 'page');
    expect(claims).toHaveAttribute('href', '#/sessions/locks');
    expect(claims).not.toHaveAttribute('aria-current');
  });

  it('offers only Everything over a list one shell long — and the whole bar over two', async () => {
    const one = mount();
    await waitFor(() => expect(listed()).toEqual(['pty:abc123']));
    // Controls only where there is something to control: one line is nothing
    // to search, narrow, group or order…
    expect(screen.queryByRole('searchbox')).toBeNull();
    for (const slot of [/^Filter/, /^Group/, /^Sort/, /^More actions/]) {
      expect(screen.queryByRole('button', { name: slot })).toBeNull();
    }
    // …but the line still folds facts away, so the third door stands over it:
    // the bar's last slot, alone (quiet-console phase 27).
    expect(screen.getByRole('switch', { name: 'Everything' })).toHaveAttribute('aria-checked', 'false');
    one.unmount();

    terminals = listOf(SHELL, CLAUDE);
    mount();
    expect(await screen.findByRole('searchbox', { name: /Find a session/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Group, Kind' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Everything' })).toBeInTheDocument();
  });

  it('turns a list of one into all of it from the switch, and keeps the answer for the page', async () => {
    mount();
    await waitFor(() => expect(listed()).toEqual(['pty:abc123']));
    // The columns only Everything draws are folded at the glance…
    expect(screen.queryByRole('columnheader', { name: /^Began/ })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Everything' }));
    // …and the switch puts them on the one line, kept for this page alone.
    expect(await screen.findByRole('columnheader', { name: /^Began/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^Terminal/ })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Everything' })).toHaveAttribute('aria-checked', 'true');
    expect(getPrefs().everything).toEqual({ sessions: true });
    // Still nothing to search over one line.
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('draws no bar at all over an empty list: there is nothing for Everything to unfold', async () => {
    terminals = listOf();
    mount();
    await screen.findByText(
      'Nothing is running: no lane, no session of yours, and no other Claude on this machine.',
    );
    expect(screen.queryByRole('switch', { name: 'Everything' })).toBeNull();
    expect(document.querySelector('[data-toolbar]')).toBeNull();
  });

  describe('on a phone', () => {
    beforeEach(() => {
      media.phone = true;
    });
    afterEach(() => {
      media.phone = false;
    });

    it('keeps the switch in the View sheet over a list of one, and nothing else in the sheet', async () => {
      mount();
      await waitFor(() => expect(listed()).toEqual(['pty:abc123']));
      expect(screen.queryByRole('searchbox')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'View' }));
      const sheet = await screen.findByRole('dialog', { name: 'View' });
      const flip = within(sheet).getByRole('switch', { name: 'Everything' });
      // The switch is the sheet's one control: no section for a slot one line has no use for.
      expect(within(sheet).queryAllByRole('heading', { level: 3 })).toEqual([]);
      expect(within(sheet).queryAllByRole('radio')).toEqual([]);
      fireEvent.click(flip);
      expect(flip).toHaveAttribute('aria-checked', 'true');
      expect(getPrefs().everything).toEqual({ sessions: true });
    });
  });

  it('says nothing is running in one line, with the way to start something', async () => {
    terminals = listOf();
    mount();

    expect(
      await screen.findByText(
        'Nothing is running: no lane, no session of yours, and no other Claude on this machine.',
      ),
    ).toBeInTheDocument();
    // A shell first, as it always was — and the list opens nothing by itself.
    expect(screen.getByRole('button', { name: 'Open a shell' })).toBeEnabled();
    expect(posts()).toEqual([]);
  });

  it('offers to start a Claude session from the empty list on a console that opens no shells', async () => {
    state = { ...BASE_STATE, allowTerminal: false };
    terminals = listOf();
    mount();
    expect(await screen.findByRole('link', { name: 'Start a session' })).toHaveAttribute(
      'href',
      '#/sessions?new=agent',
    );
  });

  it('names BOTH flags where the console opens nothing of its own, and asks for no pty', async () => {
    state = { ...BASE_STATE, allowAgent: false, allowTerminal: false };
    mount();

    // Two pages each named their own flag once; one page that named only the
    // flag you happened to arrive under would send half its readers to
    // restart with a flag they already have.
    const said = await screen.findByText(/opens no sessions of its own/);
    expect(said).toHaveTextContent('--allow-agent');
    expect(said).toHaveTextContent('--allow-terminal');
    expect(screen.queryByTestId('new-session')).toBeNull();
    expect(screen.queryByTestId('new-shell')).toBeNull();
    expect(sent.filter((call) => call.url.startsWith('/api/terminal'))).toEqual([]);
  });

  it('says nothing matches, with the way back', async () => {
    terminals = listOf(SHELL, CLAUDE);
    mount();
    fireEvent.change(await screen.findByRole('searchbox', { name: /Find a session/ }), {
      target: { value: 'zzzz' },
    });
    // One line, and the way back beside it.
    const empty = (await screen.findByText('Nothing matches the filters.')).parentElement!;
    expect(listed()).toEqual([]);

    fireEvent.click(within(empty).getByRole('button', { name: 'Clear the filters' }));
    await waitFor(() => expect(listed()).toHaveLength(2));
    expect(screen.getByRole('searchbox', { name: /Find a session/ })).toHaveValue('');
  });

  it('keeps its toolbar over a short list while a kind left set narrows it', async () => {
    // A kind is a view left set, so it can outlive the kind's last process —
    // and it must stay undoable from where the list is drawn.
    setPrefs({ sessionsKind: 'lane' });
    mount();

    const empty = (await screen.findByText('Nothing matches the filters.')).parentElement!;
    expect(screen.getByRole('searchbox', { name: /Find a session/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filter, Lanes' })).toBeInTheDocument();

    fireEvent.click(within(empty).getByRole('button', { name: 'Clear the filters' }));
    await waitFor(() => expect(listed()).toEqual(['pty:abc123']));
    expect(getPrefs().sessionsKind).toBe('');
    // One shell and nothing narrowing it: nothing left to control but how much it shows.
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Filter/ })).toBeNull();
    expect(screen.getByRole('switch', { name: 'Everything' })).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * What it reads
 * ------------------------------------------------------------------ */

describe('what it reads', () => {
  it('reads the slim runs — never the whole list (#234) — the approvals and the registry', async () => {
    runs = [slimRun()];
    mount();

    await waitFor(() => expect(listed()).toContain('lane:r1#15'));
    expect(reads('/api/runs?view=slim')).not.toHaveLength(0);
    expect(reads('/api/runs')).toEqual([]);
    expect(reads('/api/approvals')).not.toHaveLength(0);
    expect(reads('/api/sessions/registry')).not.toHaveLength(0);
    expect(reads('/api/terminal')).not.toHaveLength(0);
  });

  it('marks the lane a pending permission card names as waiting on a person', async () => {
    runs = [slimRun()];
    approvals = [
      { id: 'ap1', status: 'pending', runId: 'r1', phase: 15, tool: 'Bash', createdAt: iso(NOW - MIN) },
      // An answered card names the same lane and holds nobody.
      { id: 'ap0', status: 'approved', runId: 'r1', phase: 15, tool: 'Bash', createdAt: iso(NOW - 9 * MIN) },
    ];
    mount();

    await waitFor(() =>
      expect(document.querySelector('[data-session-row="lane:r1#15"]')).toHaveAttribute(
        'data-attention',
        'needs-you',
      ),
    );
    expect(document.querySelector('[data-session-row="pty:abc123"]')).not.toHaveAttribute('data-attention');
    expect(screen.getByText('1 needs you and 1 running.')).toBeInTheDocument();
  });

  it('asks a server with no autopilot for no runs', async () => {
    // The stale-server guard: a console whose server predates the autopilot
    // has no run endpoints, and asking anyway fills the log with 404s.
    state = { ...BASE_STATE, autopilot: false };
    mount();
    await waitFor(() => expect(listed()).toEqual(['pty:abc123']));
    expect(sent.filter((call) => call.url.startsWith('/api/runs'))).toEqual([]);
    expect(reads('/api/approvals')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * What it keeps
 * ------------------------------------------------------------------ */

describe('what it keeps — the 6.x keys for a view left set, nothing for the words', () => {
  beforeEach(() => {
    runs = [slimRun()];
    // Two shells whose orders differ: one began long ago and printed a minute
    // ago, one began five minutes ago and has been quiet since.
    terminals = listOf(
      {
        ...SHELL,
        id: 'old',
        label: 'old shell',
        cwd: '/repo/api',
        createdAt: NOW - 60 * MIN,
        lastOutputAt: NOW - MIN,
      },
      {
        ...SHELL,
        id: 'new',
        label: 'new shell',
        cwd: '/repo/web',
        createdAt: NOW - 5 * MIN,
        lastOutputAt: NOW - 4 * MIN,
      },
    );
  });

  it('keeps the kind in `sessionsKind`, across a visit', async () => {
    const first = mount();
    await waitFor(() => expect(listed()).toEqual(['lane:r1#15', 'pty:old', 'pty:new']));
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.click(await screen.findByRole('radio', { name: /^Shells/ }));

    await waitFor(() => expect(listed()).toEqual(['pty:old', 'pty:new']));
    expect(getPrefs().sessionsKind).toBe('shell');
    first.unmount();

    // A kind is a view a person left set: the next visit opens on it.
    mount();
    await waitFor(() => expect(listed()).toEqual(['pty:old', 'pty:new']));
    expect(screen.getByRole('button', { name: 'Filter, Shells' })).toBeInTheDocument();
  });

  it('keeps the order in `sessionsSort`', async () => {
    mount();
    await waitFor(() => expect(listed()).toEqual(['lane:r1#15', 'pty:old', 'pty:new']));
    fireEvent.click(screen.getByRole('button', { name: 'Sort, Activity' }));
    fireEvent.click(await screen.findByRole('radio', { name: /^Started/ }));

    await waitFor(() => expect(listed()).toEqual(['lane:r1#15', 'pty:new', 'pty:old']));
    expect(getPrefs().sessionsSort).toBe('created');
    expect(screen.getByRole('button', { name: 'Sort, Started' })).toBeInTheDocument();
  });

  it('keeps the grouping in `sessionsGroup`, a boolean — true is a section per kind', async () => {
    mount();
    await waitFor(() => expect(listed()).toHaveLength(3));
    expect(document.querySelector('[data-group="lane"]')).not.toBeNull();
    expect(document.querySelector('[data-group="shell"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Group, Kind' }));
    fireEvent.click(await screen.findByRole('radio', { name: /^None/ }));
    await waitFor(() => expect(document.querySelector('[data-group]')).toBeNull());
    expect(getPrefs().sessionsGroup).toBe(false);
    expect(listed()).toHaveLength(3);

    fireEvent.click(screen.getByRole('radio', { name: /^Kind/ }));
    await waitFor(() => expect(document.querySelector('[data-group="shell"]')).not.toBeNull());
    expect(getPrefs().sessionsGroup).toBe(true);
  });

  it('keeps the words for this visit only', async () => {
    const before = JSON.stringify(getPrefs());
    const first = mount();
    await waitFor(() => expect(listed()).toHaveLength(3));
    // The directory is the only thing that tells two shells apart.
    fireEvent.change(screen.getByRole('searchbox', { name: /Find a session/ }), {
      target: { value: '/repo/web' },
    });
    await waitFor(() => expect(listed()).toEqual(['pty:new']));
    expect(screen.getByTestId('sessions-filtered')).toHaveTextContent(
      'Showing 1 of 3 sessions for “/repo/web”: 2 hidden by the filters.',
    );
    // A search term is a question asked a moment ago, and would startle anyone
    // still narrowing the list tomorrow.
    expect(JSON.stringify(getPrefs())).toBe(before);
    first.unmount();

    mount();
    await waitFor(() => expect(listed()).toHaveLength(3));
    expect(screen.getByRole('searchbox', { name: /Find a session/ })).toHaveValue('');
  });
});

/* ------------------------------------------------------------------ *
 * The launch door for a Claude session
 * ------------------------------------------------------------------ */

describe('the launch door for a Claude session (?new=agent)', () => {
  it('is a page, and visiting it starts nothing', async () => {
    mount('#/sessions?new=agent');

    const door = await screen.findByTestId('session-launcher');
    expect(door).toHaveTextContent('Claude Code in a terminal, running in /repo.');
    expect(await screen.findByRole('button', { name: /Start session/ })).toBeEnabled();
    // Under StrictMode a mount that minted would mint twice.
    expect(posts()).toEqual([]);
  });

  it('sends exactly what the form collected, plus the size, and stays on the session it opened', async () => {
    terminals = listOf();
    const { navigations } = mount('#/sessions?new=agent');
    fireEvent.change(await screen.findByPlaceholderText(/Sent as your first message/), {
      target: { value: 'say hello' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Start session/ }));

    await waitFor(() => expect(posts()).toHaveLength(1));
    const body = posts()[0]!.body;
    // Enum choices, a bounded prompt, the size the CLI is born at — nothing executable.
    expect(body).toMatchObject({
      kind: 'claude',
      model: 'opus',
      effort: 'max',
      permissionMode: '',
      prompt: 'say hello',
    });
    expect(Object.keys(body ?? {}).sort()).toEqual([
      'cols',
      'effort',
      'kind',
      'model',
      'permissionMode',
      'prompt',
      'rows',
    ]);
    expectSized(body);
    await waitFor(() => expect(navigations).toEqual(['#/sessions/a1']));
    await waitFor(() => expect(screen.getByTestId('pane')).toHaveTextContent('a1'));

    // ⚠️ The bounce: the mint invalidates the very list the session page
    // resolves its address against. Without the isFetching gate the page
    // says "gone" — or once, navigated straight back off — the session it
    // just opened.
    await waitFor(() => expect(reads('/api/terminal').length).toBeGreaterThanOrEqual(2));
    expect(navigations).toEqual(['#/sessions/a1']);
    expect(screen.getByTestId('pane')).toHaveTextContent('a1');
    expect(screen.queryByTestId('session-gone')).toBeNull();
  });

  it('hides the skills when no source directory is open, and never asks for them', async () => {
    state = { ...BASE_STATE, root: undefined };
    mount('#/sessions?new=agent');

    expect(
      await screen.findByText('Open a source directory to pick skills for the session.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('session-launcher')).toHaveTextContent('running in your home directory');
    await screen.findByRole('button', { name: /Start session/ });
    // `/api/skills` sits behind the open-root wall server-side — a hidden
    // picker must not turn into a 409 toast.
    expect(sent.some((call) => call.url.startsWith('/api/skills'))).toBe(false);
  });

  it('refuses without --allow-agent, naming the flag, and asks the server nothing', async () => {
    state = { ...BASE_STATE, allowAgent: false };
    mount('#/sessions?new=agent');

    expect(
      await screen.findByText('Agent sessions are disabled. Restart with --allow-agent to enable them.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start session/ })).toBeNull();
    expect(sent.filter((call) => call.url.startsWith('/api/terminal'))).toEqual([]);
  });

  it('is blocked at the cap, and says why where the press would be', async () => {
    terminals = listOf(...shells(8));
    mount('#/sessions?new=agent');

    expect(
      await screen.findByText(/8 sessions are running, the most this console allows at once/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start session/ })).toBeDisabled();
  });
});

/* ------------------------------------------------------------------ *
 * The launch door for a shell
 * ------------------------------------------------------------------ */

describe('the launch door for a shell (?new=shell)', () => {
  it('is one press away, and visiting it opens nothing', async () => {
    terminals = listOf();
    mount('#/sessions?new=shell');

    expect(await screen.findByText('No shell is open. A new one starts in /repo.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open a shell' })).toBeEnabled();
    // Under StrictMode a mount that spawned a pty would spawn two — and this
    // address asked for a shell by name, the strongest form of the temptation.
    expect(posts()).toEqual([]);
  });

  it('opens one when asked, and stays on it', async () => {
    terminals = listOf();
    const { navigations } = mount('#/sessions?new=shell');
    fireEvent.click(await screen.findByRole('button', { name: 'Open a shell' }));

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(Object.keys(posts()[0]!.body ?? {}).sort()).toEqual(['cols', 'rows']);
    // The address is what makes a reload — or a phone killing the tab — come
    // back to the same shell rather than a new one.
    await waitFor(() => expect(navigations).toEqual(['#/sessions/new1']));
    await waitFor(() => expect(screen.getByTestId('pane')).toHaveTextContent('new1'));

    // ⚠️ The regression this guards: the press invalidates the very list the
    // page reads, and a page that decided mid-re-read that the new session did
    // not exist left a terminal that never appeared.
    await waitFor(() => expect(reads('/api/terminal').length).toBeGreaterThanOrEqual(2));
    expect(navigations).toEqual(['#/sessions/new1']);
    expect(screen.getByTestId('pane')).toHaveTextContent('new1');
    expect(screen.queryByTestId('session-gone')).toBeNull();
  });

  it('says the flag is off without --allow-terminal', async () => {
    state = { ...BASE_STATE, allowTerminal: false };
    mount('#/sessions?new=shell');

    expect(
      await screen.findByText('This console opens no shells (no --allow-terminal).'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open a shell' })).toBeNull();
  });

  it('says the cap instead of offering a press the server would refuse', async () => {
    terminals = listOf(...shells(8));
    mount('#/sessions?new=shell');

    expect(
      await screen.findByText(
        '8 sessions are running, the most this console allows at once: close one to start another.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open a shell' })).toBeDisabled();
  });
});

/* ------------------------------------------------------------------ *
 * Both doors, when there is no terminal to open
 * ------------------------------------------------------------------ */

describe('both launch doors, when node-pty did not load', () => {
  it('say so — the open session’s words — instead of offering a start that cannot work', async () => {
    // 6.2 pinned this on both doors: "node-pty did not load" and "the flag is
    // off" are different problems with different fixes, and a door that
    // offered its press anyway would answer it with a refusal after the fact.
    // The open session's page says the same (`session-page.test.tsx`).
    terminals = { ...listOf(), available: 'no' };
    const shell = mount('#/sessions?new=shell');
    const shellDoor = await screen.findByTestId('shell-launcher');
    await waitFor(() => expect(shellDoor).toHaveTextContent('node-pty did not load'));
    expect(screen.queryByRole('button', { name: 'Open a shell' })).toBeNull();
    shell.unmount();

    mount('#/sessions?new=agent');
    const agentDoor = await screen.findByTestId('session-launcher');
    await waitFor(() => expect(agentDoor).toHaveTextContent('node-pty did not load'));
    expect(screen.queryByRole('button', { name: /Start session/ })).toBeNull();
  });
});
