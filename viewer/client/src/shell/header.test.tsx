/**
 * The header (7.0, quiet-console phase 3): the four things that are true on
 * every page — where you are, what the situation is, the way to anything, and
 * what the console has said.
 *
 * Its 6.x test pinned two console chips (the heap meter and the presence chip)
 * and the asks chip; this phase's ruling took all three out, with the theme
 * toggle, and put the meter on the rail — so their cases are gone and one case
 * here pins that they stay gone. What is pinned instead: the title is the
 * place in a word (a head's own, else the place it lights), the situation
 * words ride the desk's one row, the palette is a wide labelled affordance on
 * a desk and a magnifier on a phone, and the bell names its count and opens
 * the drawer over the page you are on. The phone's own measurements — the
 * count beside the bell, the situation row's padding — are `phone.test.tsx`'s.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleState, SlimRun } from '@/data/api';
import type { ShellCounts } from '@/data/console';
import { keys, queryClientConfig } from '@/data/keys';
import type { TurnAnswer } from '@/data/turn';
import { MemoryRouterProvider } from './router';
import { hrefOf, parseHash, type Route } from './routes';
import { Header } from './header';

const { state, runList, queue, plans, spend, inbox } = vi.hoisted(() => ({
  state: vi.fn(),
  runList: vi.fn(),
  queue: vi.fn(),
  plans: vi.fn(),
  spend: vi.fn(),
  inbox: vi.fn(),
}));

vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return { ...actual, runList, api: { ...actual.api, state, queue, plans, spend, inbox } };
});

const STATE: ConsoleState = {
  autopilot: true,
  allowRun: true,
  root: { path: '/repo', label: 'repo', ok: true },
  instance: { id: 'f922d743-pe-hub', name: 'pe-hub', pinned: false },
  unread: 0,
};

const COUNTS: ShellCounts = {
  plans: 0,
  phases: 0,
  ready: 0,
  approvals: 0,
  unread: 0,
  needsYou: 0,
  asks: 0,
  sessions: 0,
  agentSessions: 0,
  terminalSessions: 0,
  mcpAttention: 0,
};

/** Your turn, answered with nothing in it — seeded, because its read is not on `api`. */
const NO_TURN = {
  round: { at: '2026-10-09T00:00:00.000Z', n: 0, ranAt: null, changedAt: null },
  headline: 'Nothing needs you now.',
  groups: { approve: [], now: [], decide: [], upcoming: [], checking: [], done: [] },
  handled: [],
  counts: { approve: 0, now: 0, decide: 0, upcoming: 0, checking: 0, done: 0, total: 0, handled: 0 },
  seen: null,
  issues: null,
} as TurnAnswer;

/** One slim row, as the server projects it — the situation words fold their groups from it (7.0). */
const live = {
  id: 'r1',
  slug: 'demo',
  status: 'running',
  lifecycle: { state: 'running' },
  activePhase: 3,
  children: {},
  verifying: {},
  liveness: [],
  phases: { '3': 'running' },
} as unknown as SlimRun;

/**
 * The header at an address, the way the shell mounts it: inside the router it
 * navigates through (`onNavigate` is where a press lands), over a client whose
 * `/api/state` is the same state the header is handed — as in `App.tsx`.
 * `console: null` is the boot: `/api/state` has not answered yet.
 */
function mount(
  address: string,
  options: { phone?: boolean; counts?: Partial<ShellCounts>; console?: ConsoleState | null } = {},
) {
  const { phone = false, counts = {} } = options;
  const consoleState = options.console === null ? undefined : (options.console ?? STATE);
  const onNavigate = vi.fn();
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  client.setQueryData(keys.turn(), NO_TURN);
  if (consoleState) client.setQueryData(keys.state(), consoleState);
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={address} onNavigate={onNavigate}>
        <Header
          state={consoleState}
          counts={{ ...COUNTS, ...counts }}
          route={parseHash(address) as Route}
          phone={phone}
        />
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
  return { ...view, onNavigate, header: screen.getByRole('banner') };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.mockResolvedValue(STATE);
  runList.mockResolvedValue([]);
  queue.mockResolvedValue({ entries: [], advice: [] });
  plans.mockResolvedValue([]);
  spend.mockResolvedValue({ today: { settledUsd: 0, ladderUsd: 0, capUsd: null }, runs: [], series: [] });
  inbox.mockResolvedValue({ items: [] });
});

describe('the title', () => {
  // A head's own word, else the word of the place it lights: a redirect head
  // names where it lands, and an unknown one the home.
  const WORDS: [string, string][] = [
    [hrefOf('runs'), 'Runs'],
    [hrefOf('runs', { group: 'needs-you' }), 'Runs'],
    [hrefOf('plan/demo/run'), 'Plan'],
    [hrefOf('turn/abc'), 'Your turn'],
    [hrefOf('logs/health'), 'Logs'],
    [hrefOf('debug/health'), 'Logs'],
    [hrefOf('terminal/abc'), 'Sessions'],
    [hrefOf('settings/accounts'), 'Settings'],
    [hrefOf('nonsense'), 'Runs'],
  ];

  for (const [address, word] of WORDS) {
    it(`says where ${address} is, in a word: ${word}`, () => {
      const { header } = mount(address, { console: null });
      expect(within(header).getByTestId('header-title').textContent).toBe(word);
    });
  }

  it('is the chrome’s word, never a second heading — the page’s own <h1> is the title', () => {
    const { header } = mount(hrefOf('plans'), { console: null });
    expect(within(header).queryByRole('heading')).toBeNull();
  });
});

describe('the situation words', () => {
  it('ride the desk header’s one row, between the title and the way to anything', async () => {
    runList.mockResolvedValue([live]);
    const { header } = mount(hrefOf('runs'));
    const line = await within(header).findByTestId('situation-line');

    // ONE row: everything the header holds is in the row it draws.
    expect(header.className).toMatch(/(^|\s)h-\(--header-height\)(\s|$)/);
    expect(header.children).toHaveLength(1);
    const title = within(header).getByTestId('header-title');
    const palette = within(header).getByTitle('Go anywhere, find anything, run a verb');
    const follows = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(title, line), 'the words follow the title').toBe(true);
    expect(follows(line, palette), 'the buttons follow the words').toBe(true);
    // The desk's reading: every figure is a link to where it is answered.
    expect(within(line).getByRole('link', { name: 'demo is running — phase 3' })).toBeInTheDocument();
  });

  it('are not drawn before /api/state has answered', async () => {
    const { header } = mount(hrefOf('runs'), { console: null });
    await Promise.resolve();
    expect(within(header).queryByTestId('situation-line')).toBeNull();
    expect(runList).not.toHaveBeenCalled();
  });
});

describe('the way to anything', () => {
  it('is a wide, labelled affordance on a desk, with its chord printed on it', () => {
    const { header, onNavigate } = mount(hrefOf('runs', { group: 'live' }));
    const palette = within(header).getByTitle('Go anywhere, find anything, run a verb');
    expect(palette.tagName).toBe('BUTTON');
    // 224 px: a palette nobody knows about is a palette nobody opens.
    expect(palette.className).toMatch(/(^|\s)w-56(\s|$)/);
    expect([...palette.querySelectorAll('kbd')].map((key) => key.textContent)).toEqual(['⌘', 'K']);
    fireEvent.click(palette);
    // ON the page you are on, its own query kept — opening it is not a navigation.
    expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('runs', { group: 'live', k: '' }));
  });

  it('is a magnifier on a phone: no chord to print, no width to spare', () => {
    const { header, onNavigate } = mount(hrefOf('plans'), { phone: true });
    const search = within(header).getByRole('button', { name: 'Search and commands' });
    expect(search.querySelector('kbd')).toBeNull();
    expect(within(header).queryByTitle('Go anywhere, find anything, run a verb')).toBeNull();
    fireEvent.click(search);
    expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('plans', { k: '' }));
  });
});

describe('the bell', () => {
  it('names the unread count, and opens the drawer over the page you are on', () => {
    const { header, onNavigate } = mount(hrefOf('plans', { view: 'table' }), { counts: { unread: 3 } });
    const bell = within(header).getByRole('button', { name: 'Announcements, 3 unread' });
    expect(within(bell).getByText('3')).toBeInTheDocument();
    fireEvent.click(bell);
    expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('plans', { view: 'table', bell: '1' }));
  });

  it('is only the bell when nothing is unread', () => {
    const { header } = mount(hrefOf('runs'));
    expect(within(header).getByRole('button', { name: 'Announcements' }).textContent).toBe('');
  });
});

describe('nothing else (7.0)', () => {
  it('carries no theme toggle, no chips and no second meter — and on a desk, no switcher', async () => {
    runList.mockResolvedValue([live]);
    const { header } = mount(hrefOf('runs'), { counts: { unread: 1, needsYou: 2, asks: 2, sessions: 3 } });
    await within(header).findByTestId('situation-line');

    // Theme and density live in Settings ▸ Appearance and the palette now…
    expect(within(header).queryByRole('group', { name: 'Theme' })).toBeNull();
    for (const name of [
      /theme/i,
      /^(auto|night|paper)$/i,
      /waiting on you/i,
      /phone/i,
      /usage limits/i,
      /heap/i,
    ]) {
      expect(within(header).queryByRole('button', { name }), String(name)).toBeNull();
    }
    // …the account meter on the rail, and the process's health in Logs.
    expect(within(header).queryByRole('meter')).toBeNull();
    for (const id of ['runtime-chip', 'presence-chip', 'asks-chip']) {
      expect(within(header).queryByTestId(id), id).toBeNull();
    }
    // The rail carries the switcher on a desk.
    expect(within(header).queryByRole('button', { name: /^This console:/ })).toBeNull();
    // Two presses, and only two: the way to anything, and the bell.
    expect(
      within(header)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label') ?? button.title),
    ).toEqual(['Go anywhere, find anything, run a verb', 'Announcements, 1 unread']);
  });

  it('carries the instance switcher on a phone, where there is no rail to carry it', () => {
    const { header } = mount(hrefOf('runs'), { phone: true });
    expect(
      within(header).getByRole('button', {
        name: 'This console: pe-hub, on repo. Switch console or source.',
      }),
    ).toBeInTheDocument();
  });
});

