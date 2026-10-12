/**
 * One session, open (7.0, quiet-console phase 15): `session-page.tsx` mounted
 * at its address inside the memory router, over a client of the app's own
 * config, beside the shell's panel host — against a stubbed server that
 * answers by path and records what it was sent.
 *
 * (`index.test.tsx` is the place around it — the list and the launch doors —
 * and `keybar.test.tsx` the key bar. The split is by SUBJECT, as it was when
 * this was two pages.)
 *
 * xterm is stubbed out wholesale (`./pane`). It measures a real font in a real
 * layout engine and owns a live socket, and jsdom has neither — and none of
 * what is worth asserting here is xterm's behaviour anyway. What is, is ours
 * and invisible until it is wrong:
 *
 * - **One line of chrome, then the terminal.** The way back, the session's
 *   word, its name as the heading, the Switch menu — every other pty of this
 *   console's, both kinds in one list, and the two starts, refused by name at
 *   the cap the two kinds share — and Details, whose pressed state IS the
 *   panel's.
 * - **The panel.** The page hands it the session on arrival WITHOUT opening
 *   it — the facts (the mode it was LAUNCHED in among them) and the acts are
 *   there for whenever it stands — and takes it back when the page goes.
 * - **Every way there is no terminal says which**: the flags (both named),
 *   `node-pty`, an address that names nothing. And none of them flashes while
 *   a list is still being read — the `isFetching` gate, and the registry's.
 * - **No shell opens as a side effect of arriving**: only a press mints, at
 *   the size the pane will settle on.
 * - **Ended** is a state the page renders: what it exited with, Resume here
 *   for a conversation, Dismiss — and where the address goes after.
 * - **A session this console does not own** (since Phase 8): its conversation
 *   resumed here, behind a confirm wherever that is a second process or an
 *   unfamiliar directory; refused by flag, and readable without one.
 * - The plan-writing session's banner, reading a session's notifications by
 *   opening it, and the composer's one line.
 *
 * Dropped from 6.2, by design: the strip — one tab list over every session,
 * its tabs and its close buttons. 7.0's head is one line; the Switch menu is
 * the way to another session and Close lives in the panel's Actions, both
 * pinned below.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleState, ForeignSession, TerminalSession, TerminalState } from '@/data/api';
import { keys, queryClientConfig } from '@/data/keys';
import { PREF_DEFAULTS, getPrefs, setPrefs } from '@/lib/prefs';
import { InspectorHost, __resetInspectorForTests, inspect } from '@/shell/panel/inspector-host';
import { MemoryRouterProvider, useRoute } from '@/shell/router';
import { sessionsHref } from '@/shell/routes';
import { expectNoAxeViolations } from '@/test/axe';
import { TooltipProvider } from '@/ui/tooltip';
import { Composer } from './composer';
import { foreignAction, unfamiliarDirectory } from './foreign';
import SessionPage from './session-page';

vi.setConfig({ testTimeout: 20_000 });

/* ------------------------------------------------------------------ *
 * The emulator
 * ------------------------------------------------------------------ */

// `vi.hoisted`: a `vi.mock` factory runs above every top-level `const` in the
// file, so anything it closes over has to be created here.
const { pane } = vi.hoisted(() => ({ pane: vi.fn() }));

// ONLY the emulator is stubbed: the ended and gone states, the head, the
// panel's facts and acts reach the page from their own modules and are under
// test for real. `default` is what the page's `lazy()` resolves — the emulator
// stays out of the precached chunk behind that dynamic import, and a mock
// without it renders an empty Suspense forever. Like a real pane, it reports
// the size it settled on once it has measured its glass; `data-born` is the
// session it was MOUNTED for, which a reused pane would go on saying.
vi.mock('./pane', async () => {
  const { useEffect, useRef } = await import('react');
  function Pane(props: {
    sessionId: string;
    composer?: boolean;
    onSize?: (size: { cols: number; rows: number }) => void;
  }) {
    const { sessionId, composer = false, onSize } = props;
    const born = useRef(sessionId);
    pane(sessionId, composer);
    useEffect(() => {
      onSize?.({ cols: 120, rows: 40 });
    }, [onSize]);
    return (
      <div data-testid="pane" data-born={born.current}>
        {sessionId}
      </div>
    );
  }
  return { default: Pane };
});

/* ------------------------------------------------------------------ *
 * The server
 * ------------------------------------------------------------------ */

const NOW = Date.now();
const MIN = 60_000;
const CONVERSATION = '00000000-0000-4000-8000-000000000000';

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

const SECOND: TerminalSession = { ...SHELL, id: 'def456', label: 'Terminal 2', pid: 901 };

const CLAUDE: TerminalSession = {
  ...SHELL,
  id: 'c1',
  label: 'Claude: hello',
  kind: 'claude',
  shell: 'claude',
  pid: 902,
  meta: { model: 'opus', claudeSessionId: CONVERSATION },
};

const listOf = (...sessions: TerminalSession[]): TerminalState => ({
  allowed: true,
  agentAllowed: true,
  available: 'yes',
  limit: 8,
  sessions,
});

interface Sent {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

/** An answer the test gives when it chooses — how "still being read" is staged. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let state: ConsoleState;
let terminals: TerminalState;
let registry: ForeignSession[];
let plans: { slug: string; phases: number; ready: number[] }[];
let sent: Sent[];
/** The registry's answer, held open until the test gives it. */
let registryHold: Promise<unknown> | null;
/** Hold the list's NEXT read once something mints — "invalidated, not yet read again". */
let holdListAfterMint: boolean;
let listHold: Deferred<void> | null;
/** An older server's ticket: the id, and not the record it opened. */
let bareTicket: boolean;

/** A stateful mint: the session it opens is in the next listing, or no test could see the bug it exists for. */
function mint(body: Record<string, unknown>) {
  const claude = body.kind === 'claude';
  const session: TerminalSession = claude
    ? {
        ...CLAUDE,
        id: 'resumed1',
        label: 'Resumed: demo P3',
        meta: { claudeSessionId: String(body.resume ?? CONVERSATION) },
      }
    : { ...SHELL, id: 'new1', label: 'Terminal 3' };
  terminals = { ...terminals, sessions: [...terminals.sessions, session] };
  if (holdListAfterMint) listHold = deferred();
  return {
    ok: true,
    sessionId: session.id,
    token: 't',
    expiresAt: 0,
    path: '/ws/terminal',
    ...(bareTicket ? {} : { session }),
  };
}

function answer(call: Sent): unknown {
  const [path, search = ''] = call.url.split('?');
  if (path === '/api/state') return state;
  if (path === '/api/terminal') {
    if (call.method === 'POST') return mint(call.body ?? {});
    if (call.method === 'DELETE') {
      const id = new URLSearchParams(search).get('id');
      terminals = { ...terminals, sessions: terminals.sessions.filter((one) => one.id !== id) };
      return search.includes('action=dismiss')
        ? { ok: true, state: terminals }
        : { closed: true, state: terminals };
    }
    const hold = listHold;
    return hold ? hold.promise.then(() => terminals) : terminals;
  }
  if (path === '/api/sessions/registry') return registryHold ?? { sessions: registry };
  if (/^\/api\/sessions\/[^/]+\/events$/.test(path)) return { sessionId: '', events: [] };
  if (path === '/api/plans') return plans;
  if (path === '/api/notifications/read') return { changed: 1, unread: 0 };
  return {};
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
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
  plans = [];
  sent = [];
  registryHold = null;
  holdListAfterMint = false;
  listHold = null;
  bareTicket = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const call: Sent = {
        method: (init.method ?? 'GET').toUpperCase(),
        url: String(input),
        ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
      };
      sent.push(call);
      const body = await answer(call);
      return new Response(JSON.stringify(body), {
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

/**
 * The page at the session its address names — the place's own rule
 * (`index.tsx`), so a navigation the page makes is followed the way the shell
 * follows it. Anywhere else is a line saying it left.
 */
function Routed() {
  const route = useRoute();
  const [head, id] = route.segments;
  if (head === 'sessions' && id && id !== 'locks') return <SessionPage sessionId={id} />;
  return <p data-testid="left">{route.path}</p>;
}

function mount(id: string) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  // The shell mounts no page before `/api/state` has answered (`App.tsx`), so
  // the page meets it answered — never a refusal drawn over flags not yet read.
  client.setQueryData(keys.state(), state);
  const navigations: string[] = [];
  const view = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouterProvider initial={sessionsHref(id)} onNavigate={(to) => navigations.push(to)}>
          <Routed />
          {/* The shell's panel, in Details: where an inspected record draws. */}
          <InspectorHost />
        </MemoryRouterProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...view, client, navigations };
}

/** The record the panel holds — its frame is labelled with the record's title. */
const inspector = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-inspector]');

async function inspectorTitled(title: string): Promise<HTMLElement> {
  await waitFor(() => expect(inspector()).toHaveAttribute('aria-label', title));
  return inspector()!;
}

/** One fact of a `KeyValue`, by its label — the `dd` beside the `dt`. */
function fact(scope: HTMLElement, label: string): string | null {
  const term = [...scope.querySelectorAll('dt')].find((dt) => dt.textContent === label);
  return term?.nextElementSibling?.textContent ?? null;
}

/** Radix opens a menu on pointerdown — jsdom's click alone never gets there. */
async function openSwitch(): Promise<HTMLElement> {
  fireEvent.pointerDown(await screen.findByTestId('session-switch'), { button: 0, ctrlKey: false });
  return screen.findByRole('menu');
}

/** Radix activates a tab on mousedown, and the click follows. */
function chooseTab(scope: HTMLElement, name: string) {
  const tab = within(scope).getByRole('tab', { name });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
}

const posts = () => sent.filter((call) => call.method === 'POST' && call.url === '/api/terminal');
const terminalReads = () => sent.filter((call) => call.method === 'GET' && call.url === '/api/terminal');

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
 * The one line above the terminal
 * ------------------------------------------------------------------ */

describe('the one line above the terminal', () => {
  it('says the way back, the session’s word and its name — and attaches the pane to it', async () => {
    const { navigations } = mount('abc123');

    expect(await screen.findByTestId('pane')).toHaveTextContent('abc123');
    // A shell gets no composer: that is the agent's line.
    expect(pane).toHaveBeenCalledWith('abc123', false);
    const head = screen.getByTestId('session-head');
    expect(within(head).getByRole('link', { name: 'Every session' })).toHaveAttribute('href', '#/sessions');
    expect(within(head).getByRole('heading', { level: 1, name: 'Terminal 1' })).toBeInTheDocument();
    // A dot and a word, in the terminal's own vocabulary.
    const word = head.querySelector('[data-status]');
    expect(word).toHaveAttribute('data-status', 'running');
    expect(word).toHaveAttribute('data-vocab', 'terminal');
    expect(word).toHaveTextContent('Running');
    // The two controls are glyphs on a phone, so each carries its name.
    expect(within(head).getByTestId('session-switch')).toHaveAccessibleName('Switch to another session');
    expect(within(head).getByTestId('session-details')).toHaveAccessibleName('Details');
    // Arriving is reading, never starting: under StrictMode a mount that
    // spawned a pty would spawn two.
    expect(posts()).toEqual([]);
    expect(navigations).toEqual([]);
  });

  it('gives an agent session the composer', async () => {
    terminals = listOf(CLAUDE);
    mount('c1');
    expect(await screen.findByTestId('pane')).toHaveTextContent('c1');
    expect(pane).toHaveBeenCalledWith('c1', true);
  });

  it('switches to another pty of this console’s — both kinds in ONE list', async () => {
    terminals = listOf(SHELL, SECOND, CLAUDE);
    const { navigations } = mount('abc123');
    await screen.findByTestId('pane');

    const menu = await openSwitch();
    // The whole point of the 3.0 merge: a shell and a Claude session side by
    // side, never two pages that each pretend the other kind does not exist.
    // The open one is not offered to itself.
    expect(within(menu).queryByRole('menuitem', { name: /^Terminal 1/ })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: /^Claude: hello/ })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Terminal 2/ }));

    await waitFor(() => expect(navigations).toEqual(['#/sessions/def456']));
    await waitFor(() => expect(screen.getByTestId('pane')).toHaveTextContent('def456'));
    // Keyed by session: a NEW pane bound to the new pty — one re-pointed would
    // replay somebody else's scrollback into it.
    expect(screen.getByTestId('pane')).toHaveAttribute('data-born', 'def456');
    expect(screen.getByRole('heading', { level: 1, name: 'Terminal 2' })).toBeInTheDocument();
  });

  it('New session goes to the launch door, never straight to a pty', async () => {
    const { navigations } = mount('abc123');
    const menu = await openSwitch();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^New session/ }));

    // `?new=agent` rather than a mint: the choices that must exist before an
    // agent pty does are what the launch door is for.
    await waitFor(() => expect(navigations).toEqual(['#/sessions?new=agent']));
    expect(posts()).toEqual([]);
  });

  it('New shell opens one at the size its pane will settle on, and lands on it', async () => {
    const { navigations } = mount('abc123');
    const menu = await openSwitch();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^New shell/ }));

    await waitFor(() => expect(posts()).toHaveLength(1));
    // A shell has nothing to choose: the size, and nothing else.
    expect(Object.keys(posts()[0]!.body ?? {}).sort()).toEqual(['cols', 'rows']);
    expectSized(posts()[0]!.body);
    await waitFor(() => expect(navigations).toEqual(['#/sessions/new1']));
    await waitFor(() => expect(screen.getByTestId('pane')).toHaveTextContent('new1'));
  });

  it('refuses both starts at the cap — counted across BOTH kinds — and says why', async () => {
    // Seven Claude sessions and one shell. The cap has always been the
    // unfiltered total; a page that disabled New over seven sessions the
    // reader could not see is what one list ended.
    const agents = Array.from({ length: 7 }, (_, i) => ({ ...CLAUDE, id: `c${i}`, label: `Claude ${i}` }));
    terminals = listOf(SHELL, ...agents);
    const { navigations } = mount('abc123');

    const menu = await openSwitch();
    for (const name of [/^New session/, /^New shell/]) {
      const item = within(menu).getByRole('menuitem', { name });
      expect(item).toHaveAttribute('data-disabled');
      // Said, not titled: a finger cannot hover a disabled item.
      expect(item).toHaveTextContent('8 sessions are running, the most this console allows at once');
    }
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^New shell/ }));
    expect(posts()).toEqual([]);
    expect(navigations).toEqual([]);
  });

  it('an ended record holds no slot', async () => {
    // Eight records, one of them over: seven processes, so a start is still offered.
    const agents = Array.from({ length: 7 }, (_, i) => ({ ...CLAUDE, id: `c${i}`, label: `Claude ${i}` }));
    terminals = listOf({ ...SHELL, exited: { code: 130 }, exitedAt: NOW - 5_000 }, ...agents);
    mount('abc123');

    const menu = await openSwitch();
    expect(within(menu).getByRole('menuitem', { name: /^New shell/ })).not.toHaveAttribute('data-disabled');
    expect(within(menu).getByRole('menuitem', { name: /^New session/ })).not.toHaveAttribute('data-disabled');
  });

  it('Details is the panel: pressed exactly while the panel stands in Details', async () => {
    mount('abc123');
    const details = await screen.findByTestId('session-details');
    expect(details).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(details);
    expect(details).toHaveAttribute('aria-pressed', 'true');
    expect(getPrefs().panel).toMatchObject({ open: true, mode: 'details' });

    fireEvent.click(details);
    expect(details).toHaveAttribute('aria-pressed', 'false');
    expect(getPrefs().panel.open).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The panel
 * ------------------------------------------------------------------ */

describe('the panel', () => {
  it('is handed the session on arrival, and is NOT opened by it', async () => {
    terminals = listOf(CLAUDE, SHELL);
    mount('c1');

    const panel = await inspectorTitled('Claude: hello');
    // There for whenever the panel stands — Details, ⌘I — and the opening is
    // the person's: a page whose subject is one record does not push a
    // column in beside it.
    expect(getPrefs().panel.open).toBe(false);
    expect(screen.getByTestId('session-details')).toHaveAttribute('aria-pressed', 'false');
    // Read live, so the size is the one the pane SETTLED on, not the record's.
    await waitFor(() => expect(fact(panel, 'Size')).toBe('120 columns, 40 rows'));
    expect(fact(panel, 'Directory')).toBe('/repo');
    // The mode it was LAUNCHED in. No mode on the record is the CLI's own
    // default — an omission, not a value — and the word still has to name it.
    expect(fact(panel, 'Launched in')).toBe('default');
    // …and it admits it is a record of the launch: ⇧Tab changes the mode
    // inside the session and tells nothing out here, so a word read as live
    // would be wrong within a keystroke.
    expect(fact(panel, 'About the mode')).toMatch(/does not update this label/);
    expect(fact(panel, 'Modes')).toMatch(/⇧Tab inside the session cycles the permission modes/);
  });

  it('follows the page to the next session — the launch mode both ways', async () => {
    const planned: TerminalSession = {
      ...CLAUDE,
      id: 'c2',
      label: 'Claude: plan it',
      meta: { ...CLAUDE.meta, permissionMode: 'plan' },
    };
    terminals = listOf(CLAUDE, planned);
    mount('c1');
    expect(fact(await inspectorTitled('Claude: hello'), 'Launched in')).toBe('default');

    fireEvent.click(within(await openSwitch()).getByRole('menuitem', { name: /^Claude: plan it/ }));
    expect(fact(await inspectorTitled('Claude: plan it'), 'Launched in')).toBe('plan');
    expect(getPrefs().panel.open).toBe(false);
  });

  it('is cleared when the page goes', async () => {
    const { navigations } = mount('abc123');
    await inspectorTitled('Terminal 1');
    fireEvent.click(within(await openSwitch()).getByRole('menuitem', { name: 'Every session' }));
    await screen.findByTestId('left');
    expect(navigations).toEqual(['#/sessions']);
    // A record of a page nobody is on would be a panel about nothing.
    expect(inspector()).toBeNull();
    expect(screen.getByText(/Nothing is inspected/)).toBeInTheDocument();
  });

  it('leaves a record somebody put there since standing when the page goes', async () => {
    mount('abc123');
    await inspectorTitled('Terminal 1');
    act(() => inspect({ key: 'run:elsewhere', title: 'Something else', overview: <p>else</p> }));
    await inspectorTitled('Something else');

    fireEvent.click(within(await openSwitch()).getByRole('menuitem', { name: 'Every session' }));
    await screen.findByTestId('left');
    expect(inspector()).toHaveAttribute('aria-label', 'Something else');
  });

  it('Close in its Actions kills the session, removes the record and moves to the next one', async () => {
    terminals = listOf(SHELL, SECOND);
    const { navigations } = mount('abc123');
    const panel = await inspectorTitled('Terminal 1');
    chooseTab(panel, 'Actions');
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    // A kill is never one press: the confirm says the record goes with it.
    const dialog = await screen.findByRole('alertdialog');
    expect(sent.some((call) => call.method === 'DELETE')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close the session' }));

    await waitFor(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({ method: 'DELETE', url: '/api/terminal?id=abc123' }),
      ),
    );
    await waitFor(() => expect(navigations).toEqual(['#/sessions/def456']));
    await waitFor(() => expect(screen.getByTestId('pane')).toHaveTextContent('def456'));
  });
});

/* ------------------------------------------------------------------ *
 * The ways there is no terminal
 * ------------------------------------------------------------------ */

describe('the ways there is no terminal', () => {
  it('says the flags are off, names BOTH, and asks nothing of a server that said no', async () => {
    state = { ...BASE_STATE, allowTerminal: false, allowAgent: false };
    mount('abc123');

    // One page, so one sentence that covers both kinds: a page that named only
    // the flag you happened to arrive under would send half its readers to
    // restart with a flag they already have.
    const said = await screen.findByText(/opens no sessions of its own/);
    expect(said).toHaveTextContent('--allow-terminal');
    expect(said).toHaveTextContent('--allow-agent');
    expect(sent.filter((call) => call.url.startsWith('/api/terminal'))).toEqual([]);
    expect(screen.queryByTestId('pane')).toBeNull();
  });

  it('distinguishes “node-pty did not load” from “the flags are off”', async () => {
    terminals = { ...listOf(), available: 'no' };
    mount('abc123');

    // "terminal", not "shell": node-pty is the layer BOTH kinds need. And the
    // distinction is the point: the same words for both would send someone to
    // restart with a flag they already have.
    const said = await screen.findByText(/No terminal is available/);
    expect(said).toHaveTextContent('node-pty did not load');
    expect(screen.queryByText(/opens no sessions of its own/)).toBeNull();
  });

  it('says a session is gone instead of bouncing off its own address', async () => {
    terminals = listOf(SECOND);
    const { navigations } = mount('long-gone');

    // This used to navigate away silently, which was defensible while sessions
    // timed out on their own. They do not any more: an address naming nothing
    // means the record was dismissed or retired, and on a phone a redirect
    // reads as a tap that did nothing.
    const gone = await screen.findByTestId('session-gone');
    expect(gone).toHaveTextContent(/not here any more/);
    // The way on is whichever kind this console can start — a shell first.
    expect(within(gone).getByRole('link', { name: 'Open a new shell' })).toHaveAttribute(
      'href',
      '#/sessions?new=shell',
    );
    expect(within(gone).getByRole('link', { name: 'Every session' })).toHaveAttribute('href', '#/sessions');
    expect(navigations).toEqual([]);
  });

  it('offers a new Claude session from the gone page on a console that starts no shells', async () => {
    state = { ...BASE_STATE, allowTerminal: false };
    terminals = listOf();
    mount('long-gone');
    const gone = await screen.findByTestId('session-gone');
    expect(within(gone).getByRole('link', { name: 'Start a new session' })).toHaveAttribute(
      'href',
      '#/sessions?new=agent',
    );
  });

  it('does not flash “gone” over a session while the list is being read again', async () => {
    // ⚠️ The `isFetching` gate. A mint invalidates the very list the page
    // resolves its address against; an answer that does not carry the record
    // (an older server) seeds nothing, so for the length of the re-read the
    // address names a session the cache has never seen. Without the gate the
    // page says "gone" over the session that was just created.
    bareTicket = true;
    holdListAfterMint = true;
    const { navigations } = mount('abc123');
    fireEvent.click(within(await openSwitch()).getByRole('menuitem', { name: /^New shell/ }));
    await waitFor(() => expect(navigations).toEqual(['#/sessions/new1']));

    // The wait is real and deliberate: "gone" appearing one frame late is the
    // failure this pins, so the assertion has to outlive the render that would show it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(screen.queryByTestId('session-gone')).toBeNull();
    expect(screen.getByText('Opening the session')).toBeInTheDocument();

    act(() => listHold!.resolve());
    await waitFor(() => expect(screen.getByTestId('pane')).toHaveTextContent('new1'));
    expect(screen.queryByTestId('session-gone')).toBeNull();
    expect(navigations).toEqual(['#/sessions/new1']);
  });
});

/* ------------------------------------------------------------------ *
 * A session that has ended
 * ------------------------------------------------------------------ */

describe('a session that has ended', () => {
  it('offers resume for a conversation, as a button and as a copyable command', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      terminals = { ...listOf({ ...CLAUDE, exited: { code: 0 }, exitedAt: NOW - MIN }), live: 0 };
      const { navigations } = mount('c1');

      // The record outlives the CLI, so this is a state the page renders
      // rather than a moment it had ~30 seconds to catch — with its scrollback.
      const ended = await screen.findByTestId('session-ended');
      expect(ended).toHaveTextContent(/This session exited cleanly/);
      expect(ended).toHaveAttribute('data-severity', 'info');
      expect(screen.getByTestId('session-head').querySelector('[data-status]')).toHaveAttribute(
        'data-status',
        'exited',
      );
      expect(await screen.findByTestId('pane')).toHaveTextContent('c1');

      fireEvent.click(within(ended).getByRole('button', { name: 'Copy resume command' }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(`claude --resume ${CONVERSATION}`));

      fireEvent.click(within(ended).getByRole('button', { name: /Resume here/ }));
      await waitFor(() => expect(posts()).toHaveLength(1));
      // The id and the size — the server reads its own record for the rest.
      expect(posts()[0]!.body).toMatchObject({ kind: 'claude', resume: CONVERSATION });
      expect(Object.keys(posts()[0]!.body ?? {}).sort()).toEqual(['cols', 'kind', 'resume', 'rows']);
      expectSized(posts()[0]!.body);
      await waitFor(() => expect(navigations).toEqual(['#/sessions/resumed1']));
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('reports a session a signal killed as failed, and offers to clear the record', async () => {
    terminals = { ...listOf({ ...CLAUDE, exited: { code: 1, signal: 9 }, exitedAt: NOW - 1_000 }), live: 0 };
    mount('c1');

    // A signal is the case a bare exit code loses: killed by 9 with code 1 is
    // not "exited cleanly", and the banner must not say it was.
    const ended = await screen.findByTestId('session-ended');
    expect(ended).toHaveTextContent(/killed by signal 9/);
    expect(ended).toHaveAttribute('data-severity', 'error');
    expect(within(ended).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(screen.getByTestId('session-head').querySelector('[data-status]')).toHaveAttribute(
      'data-status',
      'failed',
    );
  });

  it('keeps an ended shell with its exit code — and Dismiss moves to the next session', async () => {
    terminals = listOf({ ...SHELL, exited: { code: 130 }, exitedAt: NOW - 5_000 }, SECOND);
    const { navigations } = mount('abc123');

    const ended = await screen.findByTestId('session-ended');
    expect(ended).toHaveTextContent(/exited with code 130/);
    // A shell has no conversation to pick up.
    expect(within(ended).queryByRole('button', { name: /Resume here/ })).toBeNull();
    expect(await screen.findByTestId('pane')).toHaveTextContent('abc123');

    fireEvent.click(within(ended).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({ method: 'DELETE', url: '/api/terminal?id=abc123&action=dismiss' }),
      ),
    );
    await waitFor(() => expect(navigations).toEqual(['#/sessions/def456']));
  });

  it('Dismiss on the last record lands on the list', async () => {
    terminals = { ...listOf({ ...SHELL, exited: { code: 0 }, exitedAt: NOW - 5_000 }), live: 0 };
    const { navigations } = mount('abc123');
    fireEvent.click(
      within(await screen.findByTestId('session-ended')).getByRole('button', { name: 'Dismiss' }),
    );
    await waitFor(() => expect(navigations).toEqual(['#/sessions']));
  });

  it('says to close a live session first when a resume would pass the cap', async () => {
    const live = Array.from({ length: 8 }, (_, i) => ({ ...SHELL, id: `s${i}`, label: `Terminal ${i}` }));
    terminals = listOf({ ...CLAUDE, exited: { code: 0 }, exitedAt: NOW - MIN }, ...live);
    mount('c1');

    // Said, not only titled: a finger cannot hover a disabled button.
    const ended = await screen.findByTestId('session-ended');
    expect(ended).toHaveTextContent('Close a live session first to resume it.');
    expect(within(ended).getByRole('button', { name: /Resume here/ })).toBeDisabled();
  });
});

/* ------------------------------------------------------------------ *
 * The plan-created banner
 * ------------------------------------------------------------------ */

describe('the plan-created banner', () => {
  it('appears when a NEW slug enters the plans list, and links to it', async () => {
    terminals = listOf({ ...CLAUDE, meta: { ...CLAUDE.meta, intent: 'plan' } });
    plans = [{ slug: 'existing', phases: 1, ready: [] }];
    const { client } = mount('c1');
    await screen.findByTestId('pane');

    // The baseline must exist before the "new" list arrives — flipping the
    // answer while the FIRST read is still in flight lets the cache dedupe the
    // re-read, and the diff never sees a second list.
    await waitFor(() => expect(client.getQueryData(keys.plans())).toBeTruthy());
    expect(screen.queryByTestId('plan-created')).toBeNull();

    // `new-plan.sh` writes the file → the watcher emits `changed` → the plans
    // are read again → the re-read is what the watcher diffs.
    plans = [...plans, { slug: 'cart-api-endpoint', phases: 4, ready: [] }];
    await act(() => client.invalidateQueries({ queryKey: keys.plans() }));

    const banner = await screen.findByTestId('plan-created');
    expect(banner).toHaveTextContent('The plan cart-api-endpoint was written.');
    expect(within(banner).getByRole('link', { name: 'Open the plan' })).toHaveAttribute(
      'href',
      '#/plan/cart-api-endpoint/phases',
    );
    // Dismiss is a choice, not a timeout.
    fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('plan-created')).toBeNull();
  });

  it('does not watch a session that is not writing a plan', async () => {
    terminals = listOf(CLAUDE);
    mount('c1');
    await screen.findByTestId('pane');
    expect(sent.some((call) => call.url === '/api/plans')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Reading by looking
 * ------------------------------------------------------------------ */

describe('reading by looking', () => {
  it('opening a session marks ITS notifications read, and nothing wider', async () => {
    state = { ...BASE_STATE, unread: 3 };
    mount('abc123');
    // The record carries the session id (`server/notifications.ts`), so the
    // count drops by exactly this session's endings — after a delay long
    // enough that tabbing through sessions reads none of them.
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: 'POST',
        url: '/api/notifications/read',
        body: { sessionId: 'abc123' },
      }),
    );
  });
});

/* ------------------------------------------------------------------ *
 * The composer
 * ------------------------------------------------------------------ */

describe('the composer', () => {
  it('sends the line WITH its Enter — text + \\r — and clears for the next one', () => {
    const lines: string[] = [];
    render(<Composer onSend={(data) => lines.push(data)} />);
    const input = screen.getByRole('textbox', { name: /message/i });
    // A command line, not prose: nothing may rewrite it on the way in.
    expect(input).toHaveAttribute('autocapitalize', 'off');
    expect(input).toHaveAttribute('autocorrect', 'off');
    expect(input).toHaveAttribute('spellcheck', 'false');
    expect(input).toHaveAttribute('enterkeyhint', 'send');

    const send = screen.getByRole('button', { name: /send/i });
    expect(send).toBeDisabled();
    fireEvent.change(input, { target: { value: 'run the tests' } });
    expect(send).not.toBeDisabled();
    fireEvent.click(send);
    expect(lines).toEqual(['run the tests\r']);
    expect(input).toHaveValue('');
  });

  it('Enter in the field submits, and a blank line sends nothing', () => {
    const lines: string[] = [];
    render(<Composer onSend={(data) => lines.push(data)} />);
    const input = screen.getByRole('textbox', { name: /message/i });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form')!);
    expect(lines).toEqual([]);
    fireEvent.change(input, { target: { value: 'y' } });
    fireEvent.submit(input.closest('form')!);
    expect(lines).toEqual(['y\r']);
  });
});

/* ------------------------------------------------------------------ *
 * A session this console does NOT own (Phase 8)
 * ------------------------------------------------------------------ */

/**
 * The presence hook reports every `claude` on this machine. Until Phase 8 the
 * Sessions list could only say one EXISTS: the row built no id, so
 * `#/sessions/<conversation>` resolved to nothing and the page said "gone".
 *
 * What it can honestly do is resume the CONVERSATION — a new process on the
 * same transcript, in a pty this console owns. Nothing attaches to a terminal
 * someone else is typing in; there is no multiplexer in this tree. So the two
 * verbs differ by presence, and the difference is the point: over an `ended`
 * session Resume is plain and safe, and over a LIVE one the same press starts
 * a second process on one conversation and has to say so first.
 */
const FOREIGN: ForeignSession = {
  sessionId: '11111111-2222-4333-8444-555555555555',
  kind: 'foreign',
  cwd: '/repo/sub',
  owner: 'sam',
  startedAt: new Date(NOW - 60 * MIN).toISOString(),
  lastSeen: new Date(NOW - 10 * MIN).toISOString(),
  turns: 4,
  presence: 'ended',
};

function withForeign(over: Partial<ForeignSession> = {}) {
  registry = [{ ...FOREIGN, ...over }];
}

const resumeButton = () => screen.findByRole('button', { name: /^Resume$/ });

describe('a session this console does not own', () => {
  it('decides the verb from presence, and the flag decides whether there is one', () => {
    // The rule itself, without a DOM — the renders below prove it reaches the
    // page, this proves what it says.
    expect(foreignAction({ presence: 'ended' }, true)).toMatchObject({ kind: 'resume', confirm: false });
    expect(foreignAction({ presence: 'live' }, true)).toMatchObject({ kind: 'takeover', confirm: true });
    // Nobody can vouch for `unknown`, so it is read as live — the same
    // conservative reading the registry uses everywhere else.
    expect(foreignAction({ presence: 'unknown' }, true)).toMatchObject({ kind: 'takeover', confirm: true });
    for (const presence of ['ended', 'live', 'unknown'] as const) {
      expect(foreignAction({ presence }, false)).toMatchObject({ kind: 'refused' });
    }
  });

  it('has a page — the address the list links to resolves', async () => {
    withForeign({ plan: { slug: 'demo', phase: 3, strong: true } });
    mount(FOREIGN.sessionId);

    const page = await screen.findByTestId('foreign-session');
    expect(within(page).getByRole('heading', { level: 1, name: 'demo P3' })).toBeInTheDocument();
    // The facts that decide whether resuming is the right idea, said on the
    // page — the directory twice over, because where a resume RUNS is the one
    // fact a person cannot recover after the fact.
    expect(within(page).getAllByText('/repo/sub').length).toBeGreaterThan(1);
    expect(within(page).getByText(FOREIGN.sessionId)).toBeInTheDocument();
    // Its presence, as a dot and a word.
    expect(page.querySelector('[data-status]')).toHaveAttribute('data-status', 'ended');
    // And NOT the panel that used to answer this address.
    expect(screen.queryByTestId('session-gone')).toBeNull();
  });

  it('resumes an ended one plainly, and lands on the terminal it started', async () => {
    withForeign();
    const { navigations } = mount(FOREIGN.sessionId);

    fireEvent.click(await resumeButton());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toMatchObject({ kind: 'claude', resume: FOREIGN.sessionId });
    // The browser sends an id and nothing else about the session — no cwd, no
    // argv. The server reads the registry for the rest.
    expect(Object.keys(posts()[0]!.body ?? {}).sort()).toEqual(['cols', 'kind', 'resume', 'rows']);
    await waitFor(() => expect(navigations).toEqual(['#/sessions/resumed1']));
    await waitFor(() => expect(screen.getByTestId('pane')).toHaveTextContent('resumed1'));
  });

  it('asks before starting anything in a directory the console does not know', async () => {
    // 🔴 The escalation Phase 8 introduced, and the guard for it. A session
    // record is written by `POST /hooks/session`, which is deliberately exempt
    // from the console-header and Origin checks — so the cwd it names is not a
    // fact this console can vouch for, and that cwd is where a resume SPAWNS.
    // A directory chooses a project's settings and hooks.
    //
    // Nothing is refused: an ENDED session (which would otherwise resume with
    // one plain press) takes the confirm, and the path is put in front of the
    // person pressing.
    withForeign({ cwd: '/somewhere/else' });
    mount(FOREIGN.sessionId);

    expect(await screen.findByTestId('foreign-unfamiliar')).toBeInTheDocument();
    fireEvent.click(await resumeButton());
    expect(posts()).toEqual([]);

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('/somewhere/else');
    expect(dialog).toHaveTextContent(/not the open root/i);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start it there' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
  });

  it('does not ask twice for a directory it recognises — a recent root counts', async () => {
    state = { ...BASE_STATE, recentRoots: [{ path: '/elsewhere/repo', label: 'elsewhere' }] };
    withForeign({ cwd: '/elsewhere/repo/packages/ui' });
    mount(FOREIGN.sessionId);

    fireEvent.click(await resumeButton());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByTestId('foreign-unfamiliar')).toBeNull();
  });

  it('is not fooled by a path that only LOOKS like it is under the root', () => {
    // 🔴 The first version of this guard was defeated by its own commit
    // message's example: `/repo/../../tmp/evil` starts with `/repo/` and read
    // as familiar, while the server's `firstDir` resolves it through `statSync`
    // and spawns in `/tmp/evil`. A record written by a shell hook carries `$PWD`
    // and never has a `..` segment, so anything denormalized is unfamiliar on
    // that fact alone.
    expect(unfamiliarDirectory('/repo/sub', ['/repo'])).toBe(false);
    expect(unfamiliarDirectory('/repo', ['/repo'])).toBe(false);
    expect(unfamiliarDirectory('/repo-evil', ['/repo'])).toBe(true);
    expect(unfamiliarDirectory('/repo/../../tmp/evil', ['/repo'])).toBe(true);
    expect(unfamiliarDirectory('/repo/..', ['/repo'])).toBe(true);
    expect(unfamiliarDirectory('/repo/./sub', ['/repo'])).toBe(true);
    expect(unfamiliarDirectory('/repo/sub/', ['/repo'])).toBe(true);
    expect(unfamiliarDirectory('', ['/repo'])).toBe(true);
    expect(unfamiliarDirectory('relative/path', ['/repo'])).toBe(true);
    expect(unfamiliarDirectory('/anywhere', [])).toBe(true);
  });

  it('takes the confirm for a traversal that resolves outside the root', async () => {
    withForeign({ cwd: '/repo/../../tmp/evil' });
    mount(FOREIGN.sessionId);

    fireEvent.click(await resumeButton());
    expect(posts()).toEqual([]);
    // The page shows the string the RECORD holds, not a tidied one — a
    // normalized path the record does not contain would hide the trick.
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('/repo/../../tmp/evil');
  });

  it('does not mistake a SIBLING that merely shares the root’s first characters', async () => {
    withForeign({ cwd: '/repo-evil' });
    mount(FOREIGN.sessionId);

    fireEvent.click(await resumeButton());
    expect(posts()).toEqual([]);
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('/repo-evil');
  });

  it('makes taking over a LIVE one an explicit answer, and says what it costs', async () => {
    withForeign({ presence: 'live' });
    mount(FOREIGN.sessionId);

    const button = await screen.findByRole('button', { name: /Take over/ });
    // 🔴 The press alone must start nothing — the confirm IS the guard.
    fireEvent.click(button);
    expect(posts()).toEqual([]);

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/SECOND claude on the same conversation/);
    expect(dialog).toHaveTextContent(/keeps running: this does not stop it/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start a second session' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toMatchObject({ kind: 'claude', resume: FOREIGN.sessionId });
  });

  it('treats `unknown` as live — the conservative reading, and it asks', async () => {
    withForeign({ presence: 'unknown' });
    mount(FOREIGN.sessionId);

    expect(await screen.findByRole('button', { name: /Take over/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Resume$/ })).toBeNull();
  });

  it('says the cap instead of starting a session it would refuse', async () => {
    const shells = Array.from({ length: 8 }, (_, i) => ({ ...SHELL, id: `s${i}`, label: `Terminal ${i}` }));
    terminals = listOf(...shells);
    withForeign();
    mount(FOREIGN.sessionId);

    // The cap is known once the ptys have answered — the registry alone draws the page.
    expect(
      await screen.findByText(/8 sessions are running, the most this console allows at once/),
    ).toBeInTheDocument();
    expect(await resumeButton()).toBeDisabled();
  });

  it('refuses without --allow-agent, by naming the flag, and starts nothing', async () => {
    // `--allow-terminal` alone: this console opens shells but mints no Claude
    // session, so the page is READABLE (the registry needs no flag) and the
    // action is not offered at all.
    state = { ...BASE_STATE, allowAgent: false };
    withForeign();
    mount(FOREIGN.sessionId);

    expect(await screen.findByTestId('foreign-refused')).toHaveTextContent(/Restart with --allow-agent/);
    expect(screen.queryByRole('button', { name: /Resume|Take over/ })).toBeNull();
    expect(posts()).toEqual([]);
  });

  it('is readable on a console with NO session flags at all', async () => {
    // Reading who else is in your repository is display — the same rule
    // `GET /api/sessions/registry` follows. A page about somebody else's
    // session must not answer "this console opens no sessions of its own".
    state = { ...BASE_STATE, allowTerminal: false, allowAgent: false };
    withForeign();
    mount(FOREIGN.sessionId);

    expect(await screen.findByTestId('foreign-refused')).toHaveTextContent(/Restart with --allow-agent/);
    expect(screen.queryByText(/opens no sessions of its own/)).toBeNull();
  });

  it('does not flash “gone” while the registry is still answering', async () => {
    // 🔴 The guard QA broke once and nothing caught: `settled` includes the
    // registry read, because whether an id is a CONVERSATION is only knowable
    // from it. Without that term the page renders "gone" over a foreign
    // session for as long as the read takes — and then replaces it, which is
    // the worst of both (a wrong answer, briefly, on the page whose whole job
    // is to be honest).
    const registryAnswer = deferred<{ sessions: ForeignSession[] }>();
    registryHold = registryAnswer.promise;
    mount(FOREIGN.sessionId);

    // The ptys' read settles while the registry's does not, so every OTHER
    // term of `settled` is true here. The wait is real and deliberate.
    await waitFor(() => expect(terminalReads().length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(screen.queryByTestId('session-gone')).toBeNull();

    act(() => registryAnswer.resolve({ sessions: [FOREIGN] }));
    expect(await screen.findByRole('heading', { level: 1, name: 'sam' })).toBeInTheDocument();
    expect(screen.queryByTestId('session-gone')).toBeNull();
  });

  it('once resumed, the SAME address opens the terminal instead of offering again', async () => {
    // The address of a conversation stays the address of the conversation.
    // The pty that resumed it carries `meta.claudeSessionId`, and the broker
    // hands that meta back to the console that adopts the session after a
    // restart — so this is also what makes the link survive one.
    withForeign();
    terminals = listOf({
      ...SHELL,
      id: 'pty-9',
      kind: 'claude',
      meta: { claudeSessionId: FOREIGN.sessionId },
    });
    mount(FOREIGN.sessionId);

    await waitFor(() => expect(screen.getByTestId('pane')).toHaveTextContent('pty-9'));
    expect(screen.queryByTestId('foreign-session')).toBeNull();
    expect(screen.queryByRole('button', { name: /Resume|Take over/ })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Accessibility
 * ------------------------------------------------------------------ */

describe('accessibility', () => {
  // The destinations' sweep (`screens/pages.a11y.test.tsx`) walks `#/sessions`, the
  // list; an open session is a page of its own, and is walked here.
  it('an open session passes axe — its head, an ended banner, and the Switch menu open', async () => {
    terminals = { ...listOf({ ...CLAUDE, exited: { code: 0 }, exitedAt: NOW - MIN }, SECOND), live: 1 };
    mount('c1');
    await screen.findByTestId('session-ended');
    await screen.findByTestId('pane');
    await expectNoAxeViolations(screen.getByTestId('session-page'));

    // Portalled: the menu is checked where it is drawn.
    await expectNoAxeViolations(await openSwitch());
  });

  it('a session this console does not own passes axe, its confirm open', async () => {
    withForeign({ cwd: '/somewhere/else' });
    mount(FOREIGN.sessionId);
    await expectNoAxeViolations(await screen.findByTestId('foreign-session'));

    fireEvent.click(await resumeButton());
    await expectNoAxeViolations(await screen.findByRole('alertdialog'));
  });
});
