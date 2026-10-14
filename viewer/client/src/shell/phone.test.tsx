/**
 * The phone shell (7.0, quiet-console phase 3): header, the one scroller and
 * the tab bar as the three rows of one grid; four tabs and More; the sheet that
 * holds everything the tabs do not.
 *
 * Ported from `app/shell/phone.test.tsx`, which pinned the two places a phone
 * puts a number next to an icon. Both were drawing the count ON TOP of the
 * glyph it counts — measured on a 390 px viewport, the bell was 18 px wide at
 * x 359–377 and its badge sat at 366–386, and at three digits the badge grew
 * across the whole bell and off the screen. The answers survive: the header
 * sets the count BESIDE the bell, and the tab bar keeps the corner idiom but
 * caps the number so the badge stays a circle. 7.0 adds what this file now
 * also holds: the situation words' own padded row (#284), the tab bar leaving
 * while a software keyboard is up, the sheet's bands and its plain words (no
 * amber: "writes on" is not a summons), the sheet closing on any navigation,
 * and every destination one press or two away.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleState, SlimRun } from '@/data/api';
import type { ShellCounts } from '@/data/console';
import { keys, queryClientConfig } from '@/data/keys';
import type { TurnAnswer } from '@/data/turn';
import { ShellLayout } from './layout';
import { visibleNav } from './nav';
import { MemoryRouterProvider, useNavigate, useRoute } from './router';
import { hrefOf } from './routes';
import { TabBar } from './tab-bar';

const { keyboard, state, runList, queue, plans, spend, accounts } = vi.hoisted(() => ({
  keyboard: { open: false },
  state: vi.fn(),
  runList: vi.fn(),
  queue: vi.fn(),
  plans: vi.fn(),
  spend: vi.fn(),
  accounts: vi.fn(),
}));

// Whether a SOFTWARE keyboard is up is the viewport module's to judge (focus on
// a touch device AND the visual viewport giving up room — `app-phone.test.tsx`
// drives that whole chain); what the layout does with the answer is this file's.
vi.mock('@/lib/viewport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/viewport')>()),
  useKeyboardOpen: () => keyboard.open,
}));

vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return { ...actual, runList, api: { ...actual.api, state, queue, plans, spend, accounts } };
});

const SESSIONS_ON: ConsoleState = {
  autopilot: true,
  allowRun: true,
  allowWrites: false,
  allowTerminal: true,
  allowAgent: true,
  root: { path: '/repo', label: 'repo', ok: true },
  instance: { id: 'f922d743-pe-hub', name: 'pe-hub', pinned: false },
  unread: 0,
};

/** A console that can open neither a shell nor an agent: Sessions is not offered at all. */
const SESSIONS_OFF: ConsoleState = { ...SESSIONS_ON, allowTerminal: false, allowAgent: false };

/**
 * The tab bar's fourth slot: Insights in the free tree, the Supervisor's in
 * Pro (control-tower phase 28) — the first of these DECLARED, as `TAB_BAR` is.
 */
const FOURTH = [
  'Insights',
][0]!;

/** The record band of the sheet: Insights is in it wherever the Supervisor took its tab. */
const RECORD_IN_SHEET = [
  'Repo',
  'Logs',
];

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

const NO_TURN = {
  round: { at: '2026-10-09T00:00:00.000Z', n: 0, ranAt: null, changedAt: null },
  headline: 'Nothing needs you now.',
  groups: { approve: [], now: [], decide: [], upcoming: [], checking: [], done: [] },
  handled: [],
  counts: { approve: 0, now: 0, decide: 0, upcoming: 0, checking: 0, done: 0, total: 0, handled: 0 },
  seen: null,
  issues: null,
} as TurnAnswer;

const live = {
  id: 'r1',
  slug: 'demo',
  status: 'running',
  activePhase: 3,
  verifying: {},
  liveness: [],
  phases: { '3': 'running' },
} as unknown as SlimRun;

/** Where the shell navigates from outside the sheet — the Back gesture, a link, a push. */
let go: (path: string) => void = () => {};

/** The phone shell as `App.tsx` mounts it: the route from the router, a page inside the one scroller. */
function PhoneShell({ state: consoleState, counts }: { state: ConsoleState; counts: ShellCounts }) {
  const route = useRoute();
  go = useNavigate();
  return (
    <ShellLayout state={consoleState} counts={counts} route={route} phone>
      <p>The page.</p>
    </ShellLayout>
  );
}

function mount(consoleState: ConsoleState = SESSIONS_ON, counts: Partial<ShellCounts> = {}) {
  const onNavigate = vi.fn();
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  client.setQueryData(keys.turn(), NO_TURN);
  client.setQueryData(keys.state(), consoleState);
  // A fresh element every time, so a re-render reaches the layout (an
  // identical element would bail out at the root).
  const ui = () => (
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={hrefOf('runs')} onNavigate={onNavigate}>
        <PhoneShell state={consoleState} counts={{ ...COUNTS, ...counts }} />
      </MemoryRouterProvider>
    </QueryClientProvider>
  );
  const view = render(ui());
  return { ...view, onNavigate, rerender: () => view.rerender(ui()) };
}

/** Open More and wait for its lazily loaded sheet. */
async function openMore(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  return screen.findByRole('dialog', { name: 'More' });
}

/** A label as the first words of a row whose note follows it. */
const startsWith = (labels: readonly string[]) =>
  labels.map((label) => expect.stringMatching(new RegExp(`^${label}`)));

beforeEach(() => {
  vi.clearAllMocks();
  keyboard.open = false;
  state.mockResolvedValue(SESSIONS_ON);
  runList.mockResolvedValue([]);
  queue.mockResolvedValue({ entries: [], advice: [] });
  plans.mockResolvedValue([]);
  spend.mockResolvedValue({ today: { settledUsd: 0, ladderUsd: 0, capUsd: null }, runs: [], series: [] });
  accounts.mockResolvedValue({ accounts: [] });
});

describe('the phone shell', () => {
  it('is three rows of one grid — the header, the one scroller, the tab bar — with no rail', () => {
    const { container } = mount();
    const grid = container.querySelector('.is-phone')!;
    expect(grid.className).toMatch(/(^|\s)grid-rows-\[auto_minmax\(0,1fr\)_auto\](\s|$)/);
    expect([...grid.children].map((row) => row.tagName)).toEqual(['HEADER', 'MAIN', 'NAV']);
    expect(within(grid.children[1] as HTMLElement).getByText('The page.')).toBeInTheDocument();
    // The tab bar is the only navigation: there is no rail on a phone.
    expect(screen.getAllByRole('navigation')).toEqual([grid.children[2]]);
  });

  it('hides the tab bar while a software keyboard is up, and brings it back after', () => {
    const view = mount();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    keyboard.open = true;
    view.rerender();
    // Typing is never a navigation moment, and those 60 px keep a prompt in view.
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(screen.getByRole('main')).toBeInTheDocument();
    keyboard.open = false;
    view.rerender();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  });

  it('gives the situation words a row of their own, with inline padding (#284), as plain words', async () => {
    runList.mockResolvedValue([live]);
    mount(SESSIONS_ON, { needsYou: 1 });
    const header = screen.getByRole('banner');
    const line = await within(header).findByTestId('situation-line');
    expect(line.textContent).toBe('1 needs you, demo is running — phase 3');
    // A row of the header's own — not squeezed into the row the title and the
    // buttons share — whose words never touch the screen's edge.
    const row = line.parentElement!;
    expect(row.parentElement).toBe(header);
    expect(row.className).toMatch(/(^|\s)px-\S+/);
    const first = header.firstElementChild!;
    expect(within(first as HTMLElement).getByTestId('header-title').textContent).toBe('Runs');
    expect(first.contains(line)).toBe(false);
    // Six links would be six targets under the tap floor; the Runs tab is the press.
    expect(within(line).queryAllByRole('link')).toEqual([]);
  });
});

describe('the announcement count in the phone header', () => {
  it('sits beside the bell rather than on top of it', () => {
    mount(SESSIONS_ON, { unread: 4 });
    const bell = screen.getByRole('button', { name: 'Announcements, 4 unread' });
    const badge = within(bell).getByText('4');
    // Nothing between the badge and the button may take it out of the flow.
    for (let node: HTMLElement = badge; node !== bell; node = node.parentElement!) {
      expect(node.className).not.toMatch(/\babsolute\b/);
    }
  });

  it('keeps four digits on the screen — capped, and still the whole figure to a screen reader', () => {
    mount(SESSIONS_ON, { unread: 1284 });
    const bell = screen.getByRole('button', { name: 'Announcements, 1284 unread' });
    expect(within(bell).getByText('99+')).toBeInTheDocument();
  });

  it('draws nothing at all when there is nothing unread', () => {
    mount();
    expect(screen.getByRole('button', { name: 'Announcements' }).textContent).toBe('');
  });
});

describe('the tab bar', () => {
  const bar = (over: Partial<ShellCounts> = {}, head = 'runs', moreOpen = false) =>
    render(
      <MemoryRouterProvider initial={hrefOf(head)}>
        <TabBar
          state={SESSIONS_ON}
          counts={{ ...COUNTS, ...over }}
          head={head}
          moreOpen={moreOpen}
          onMore={() => {}}
        />
      </MemoryRouterProvider>,
    );

  it('offers Runs, Plans, Sessions, the fourth and More — and marks where you are', () => {
    bar();
    const tabs = within(screen.getByRole('navigation', { name: 'Main' })).getAllByRole('button');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Runs', 'Plans', 'Sessions', FOURTH, 'More']);
    expect(screen.getByRole('button', { name: 'Runs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('lights Sessions for a terminal deep link, not Runs', () => {
    // The 2.x bar had no Sessions entry, so `#/terminal/abc` lit nothing and the
    // app read as though you had left it.
    bar({}, 'terminal');
    expect(screen.getByRole('button', { name: 'Sessions' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Runs' })).not.toHaveAttribute('aria-current');
  });

  it('marks More, and nothing under it, while the sheet is open', () => {
    bar({}, 'runs', true);
    expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Runs' })).not.toHaveAttribute('aria-current');
  });

  it('caps the corner badge at 9+, so it cannot grow into the next tab', () => {
    bar({ ready: 42 });
    expect(screen.getByText('9+')).toBeInTheDocument();
    expect(screen.queryByText('42')).toBeNull();
    // The figure itself is the tab's name.
    expect(screen.getByRole('button', { name: 'Plans, 42' })).toBeInTheDocument();
  });

  it('rings the badge in the bar so the glyph reads out from under it, deaf to the tap', () => {
    bar({ ready: 3 });
    const badge = screen.getByText('3');
    expect(badge.className).toMatch(/ring-ground-deep/);
    // It never swallows the tap meant for the tab it decorates.
    expect(badge.parentElement!.className).toMatch(/pointer-events-none/);
  });

  it('wears the summons hue on the one count that is a summons — needs you — and on no other', () => {
    bar({ needsYou: 2, ready: 3, sessions: 1 });
    expect(screen.getByText('2').className).toMatch(/\bbg-accent\b/);
    for (const quiet of ['3', '1']) expect(screen.getByText(quiet).className).not.toMatch(/accent/);
  });
});

describe('the More sheet', () => {
  it('holds what the tabs do not, under the band each belongs to', async () => {
    mount();
    const sheet = await openMore();
    const labels = (band: string) =>
      within(within(sheet).getByRole('group', { name: band }))
        .getAllByRole('button')
        .map((row) => row.textContent);
    expect(labels('The record')).toEqual(startsWith(RECORD_IN_SHEET));
    expect(labels('The console')).toEqual(startsWith(['Settings']));
    // Every place of the work is a tab, and a heading over nothing is a lie.
    expect(within(sheet).queryByRole('group', { name: 'The work' })).toBeNull();
    expect(within(sheet).queryByRole('heading', { name: 'The work' })).toBeNull();
  });

  it('goes where a row says, and closes behind it', async () => {
    const { onNavigate } = mount();
    const sheet = await openMore();
    fireEvent.click(within(sheet).getByRole('button', { name: /^Repo/ }));
    expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('repo'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'More' })).toBeNull());
  });

  it('opens Help over the page you are on, and the usage limits in Settings ▸ Accounts', async () => {
    const { onNavigate } = mount();
    let sheet = await openMore();
    expect(within(sheet).getByRole('heading', { name: 'Over this page' })).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: /^Help/ }));
    expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('runs', { help: '' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'More' })).toBeNull());
    sheet = await openMore();
    fireEvent.click(within(sheet).getByRole('button', { name: /^Claude usage limits/ }));
    expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('settings/accounts'));
  });

  it('says whether this console may write as a plain word — never a badge, never amber', async () => {
    for (const [consoleState, word] of [
      [SESSIONS_ON, 'read-only'],
      [{ ...SESSIONS_ON, allowWrites: true }, 'on'],
    ] as const) {
      // Something needs you on the tab bar, so the summons hue IS on the page —
      // just never inside the sheet.
      const { unmount } = mount(consoleState, { needsYou: 2, ready: 1 });
      const sheet = await openMore();
      const said = within(sheet).getByText(word, { exact: true });
      expect(said.previousElementSibling?.textContent).toBe('Writes');
      expect(said.className).toMatch(/(^|\s)text-ink(\s|$)/);
      expect(sheet.querySelector('[class*="accent"], [class*="amber"], [class*="needs-you"]')).toBeNull();
      unmount();
    }
  });

  it('closes on ANY navigation — Back included — not only on its own rows', async () => {
    mount();
    await openMore();
    act(() => go(hrefOf('plans')));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'More' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Plans' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('every destination, on a phone', () => {
  for (const [what, consoleState] of [
    ['with Sessions on', SESSIONS_ON],
    ['with Sessions gated off', SESSIONS_OFF],
  ] as const) {
    it(`is one tab or one row of More away — never both, never neither (${what})`, async () => {
      mount(consoleState);
      const destinations = visibleNav(consoleState).map((item) => item.label);
      // Read before the sheet opens: an open sheet hides the page behind it.
      const tabs = within(screen.getByRole('navigation', { name: 'Main' }))
        .getAllByRole('button')
        .map((tab) => tab.textContent ?? '');
      const sheet = await openMore();
      const rows = within(sheet)
        .getAllByRole('button')
        .map((row) => row.textContent ?? '');
      const inSheet = destinations.filter((label) => rows.some((row) => row.startsWith(label)));
      const onBar = destinations.filter((label) => tabs.includes(label));
      expect(destinations.filter((label) => !onBar.includes(label) && !inSheet.includes(label))).toEqual([]);
      expect(onBar.filter((label) => inSheet.includes(label))).toEqual([]);
      // A gated place is gone from both, not a dead entry on either.
      if (!consoleState.allowTerminal) {
        expect(tabs).not.toContain('Sessions');
        expect(rows.some((row) => row.startsWith('Sessions'))).toBe(false);
      }
    });
  }
});
