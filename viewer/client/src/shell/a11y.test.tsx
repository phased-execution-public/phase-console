/**
 * The shell's own accessibility contracts (7.0, quiet-console phase 3).
 *
 * The chrome is the one part of the app that is on screen on every page, so a
 * failure here is a failure everywhere, and it is exactly the kind that
 * survives a screenshot: a place with no spoken name, a landmark declared
 * twice, a badge whose number is announced as a bare number with nothing to say
 * what it counts, a navigation a screen reader is never told about.
 *
 * What this holds is what axe cannot see: that every page head has a name to
 * be announced by, that there is one of each landmark in both shapes, that the
 * skip link is first and goes somewhere, and that a hash change — which a
 * browser does not treat as a navigation — is announced and moves focus. Axe
 * over every destination in both shapes is `screens/a11y.test.tsx`'s; the More
 * sheet, an overlay no destination opens by itself, is run through it here.
 *
 * jsdom lays nothing out, so contrast is not asked here — `styles/contrast.test
 * .ts` computes every (state, surface) pair from the stylesheet instead.
 */

import { act, lazy, type ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESTINATIONS, ROUTE_HEADS } from '@shared/route-meta.js';
import type { AccountsState, ConsoleState } from '@/data/api';
import type { ShellCounts } from '@/data/console';
import { queryClientConfig } from '@/data/keys';
import { expectNoAxeViolations } from '@/test/axe';
import { ShellLayout } from './layout';
import { NAV, TAB_BAR, navItem } from './nav';
import { REDIRECTS } from './redirects';
import { RouteFrame, SPOKEN, routeAnnouncement, spokenHead } from './route-frame';
import { MemoryRouterProvider, ROUTE_TABLE, useNavigate, useRoute } from './router';
import {
  destinationFor,
  hrefOf,
  logsHref,
  paletteHref,
  parseHash,
  planHref,
  settingsHref,
  turnHref,
  type Route,
} from './routes';

/* ---------------- the console the shell is drawn for ---------------- */

const STATE: ConsoleState = {
  autopilot: true,
  allowRun: true,
  allowWrites: true,
  allowTerminal: true,
  allowAgent: true,
  staticRoot: 'dist',
  root: { path: '/repo', ok: true, label: 'repo', planCount: 3, handoffCount: 2 },
  instance: { id: 'a1b2c3d4-repo', name: 'repo', pinned: false },
  recentRoots: [{ path: '/other', label: 'other' }],
  unread: 7,
};

// Every badge lit: a count that renders nothing cannot fail a name check.
const COUNTS: ShellCounts = {
  plans: 3,
  phases: 11,
  ready: 2,
  approvals: 1,
  needsYou: 1,
  asks: 1,
  sessions: 4,
  unread: 7,
  agentSessions: 1,
  terminalSessions: 3,
  mcpAttention: 1,
};

const ACCOUNTS: AccountsState = {
  allowAccounts: false,
  accounts: [
    {
      id: 'default',
      kind: 'default',
      builtIn: true,
      usage: { buckets: { five_hour: { utilization: 42, resetsAt: '2026-10-09T12:00:00.000Z' } } },
    },
  ],
};

/** The wire, by path: what the chrome reads. Anything not here answers 404, as an older server would. */
const WIRE: Record<string, unknown> = {
  '/api/state': STATE,
  '/api/accounts': ACCOUNTS,
  '/api/runs?view=slim': [{ id: 'r1', slug: 'demo', status: 'running', activePhase: 3, verifying: {} }],
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const body = WIRE[String(input)];
      return new Response(JSON.stringify(body ?? { error: 'not here' }), {
        status: body === undefined ? 404 : 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/* ---------------- the harness ---------------- */

const client = () =>
  new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });

/** A page: its own heading, and the route it was handed. */
const Page = lazy(async () => ({
  default: ({ route }: { route: Route }) => <h1>{`the page at ${route.path}`}</h1>,
}));

/**
 * The shell as `App.tsx` composes it: the layout, and the page in its frame,
 * both reading the memory router — so a press on the rail is a navigation.
 */
function Shell({ phone, framed = false }: { phone: boolean; framed?: boolean }) {
  const route = useRoute();
  return (
    <ShellLayout state={STATE} counts={COUNTS} route={route} phone={phone}>
      {framed ? <RouteFrame view={Page} route={route} /> : <h1>{spokenHead(route.segments[0])}</h1>}
    </ShellLayout>
  );
}

/** Every address the shell navigated to, newest last. */
let navigations: string[] = [];
beforeEach(() => {
  navigations = [];
});

const mount = (ui: ReactElement, at: string = hrefOf('runs')) =>
  render(
    <QueryClientProvider client={client()}>
      <MemoryRouterProvider initial={at} onNavigate={(to) => navigations.push(to)}>
        {ui}
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );

const route = (hash: string): Route => parseHash(hash) as Route;
const pages = () =>
  Object.entries(ROUTE_TABLE)
    .filter(([, entry]) => entry.kind === 'page')
    .map(([head]) => head);

/* ---------------- the spoken names ---------------- */

describe('every place has a name to be announced by', () => {
  it('names every page head the table registers, and nothing else', () => {
    // Complete over `ROUTE_HEADS`' pages in both directions: a page with no
    // word is announced as its destination's (or as Runs), and a word with no
    // page is a place that was renamed in one file and not the other.
    expect(Object.keys(SPOKEN).sort()).toEqual(pages().sort());
    for (const head of pages()) expect(ROUTE_HEADS as readonly string[], head).toContain(head);
  });

  it('speaks each drawn place by the word the rail and the tab bar print', () => {
    // The header's title, the announcer and the nav are three readings of one
    // place; a fourth word for it is how a person hears one name and sees
    // another.
    for (const id of new Set([...DESTINATIONS, ...TAB_BAR])) {
      expect(SPOKEN[id], id).toBe(navItem(id)!.label);
    }
    for (const item of NAV) expect(spokenHead(item.id), item.id).toBe(item.label);
  });

  it('speaks a redirect head as the place it lights while it moves', () => {
    for (const head of Object.keys(REDIRECTS)) {
      expect(spokenHead(head), head).toBe(SPOKEN[destinationFor(head)!]);
    }
    // Debug became Logs (7.0): the old head says the new name.
    expect(spokenHead('debug')).toBe('Logs');
    expect(spokenHead('now')).toBe('Runs');
    expect(spokenHead('terminal')).toBe('Sessions');
    expect(spokenHead('stats')).toBe('Insights');
    expect(spokenHead('mcp')).toBe('Settings');
  });

  it('falls back to the home’s name for an address that says nothing, or nothing this build knows', () => {
    expect(spokenHead(undefined)).toBe('Runs');
    expect(spokenHead('')).toBe('Runs');
    expect(spokenHead('nope')).toBe('Runs');
  });

  it('announces the place and where in it, never the raw hash', () => {
    expect(routeAnnouncement(route(hrefOf('runs')))).toBe('Runs');
    // The retired home is a redirect head now (6.0): it announces where it lands.
    expect(routeAnnouncement(route('#/now'))).toBe('Runs');
    expect(routeAnnouncement(route(settingsHref('automation')))).toBe('Settings, automation');
    // A page that is not a destination has a name of its own (7.0).
    expect(
      routeAnnouncement({ segments: ['plan', 'demo', 'route'], query: {}, path: 'plan/demo/route' }),
    ).toBe('Plan, demo route');
    expect(routeAnnouncement(route(turnHref('abc')))).toBe('Your turn, abc');
    expect(routeAnnouncement(route('#/debug/health?since=1'))).toBe('Logs, health');
    expect(routeAnnouncement(route(logsHref('health', { since: '1' })))).toBe('Logs, health');
    // The slug is spoken decoded, and the query never.
    expect(routeAnnouncement(route(planHref('a/b', 'run')))).toBe('Plan, a/b run');
    expect(routeAnnouncement(route('#/'))).toBe('Runs');
    for (const head of ROUTE_HEADS as readonly string[]) {
      expect(routeAnnouncement(route(hrefOf(`${head}/x`, { k: 'y' }))), head).not.toMatch(/[#?=/]/);
    }
  });
});

/* ---------------- landmarks ---------------- */

describe('one of each landmark, in both shapes', () => {
  it('on a desk: the rail is the one Main navigation, beside one header and one main', async () => {
    const { container } = mount(<Shell phone={false} />);
    expect(await screen.findAllByRole('navigation', { name: 'Main' })).toHaveLength(1);
    expect(screen.getAllByRole('navigation')).toHaveLength(1);
    expect(screen.getAllByRole('banner')).toHaveLength(1);
    const main = screen.getByRole('main');
    expect(main.id).toBe('main');
    // Focusable only programmatically: out of the tab order, but a target.
    expect(main.getAttribute('tabindex')).toBe('-1');
    expect(container.querySelector('.is-phone')).toBeNull();
  });

  it('on a phone: the tab bar is the one Main navigation — never the rail as well', async () => {
    // Both carry `aria-label="Main"`; rendering both at once would announce two
    // main navigations to a screen reader, which is the failure a media query
    // hides from everyone who can see.
    const { container } = mount(<Shell phone />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(screen.getAllByRole('navigation')).toHaveLength(1);
    expect(within(nav).getByRole('button', { name: 'More' })).toBeTruthy();
    expect(screen.getAllByRole('banner')).toHaveLength(1);
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(container.querySelector('.is-phone')).not.toBeNull();
  });
});

/* ---------------- the skip link ---------------- */

describe('the skip link', () => {
  it('is the first focusable thing on the page, hidden until it is focused', async () => {
    const { container } = mount(<Shell phone={false} />);
    const skip = await screen.findByRole('link', { name: 'Skip to content' });
    const focusable = container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    expect(focusable[0]).toBe(skip);
    // Visually hidden until focused — `sr-only` plus a `focus:not-sr-only`
    // escape. A skip link that is always visible is the one everybody deletes.
    expect(skip.className).toContain('sr-only');
    expect(skip.className).toContain('focus:not-sr-only');
    // A real link to the page's main landmark, which is what makes it a link.
    expect(skip.getAttribute('href')).toBe(`#${screen.getByRole('main').id}`);
  });

  it('moves focus into the page — and leaves the address alone, which a hash router would read as a route', async () => {
    const before = window.location.hash;
    mount(<Shell phone />);
    fireEvent.click(await screen.findByRole('link', { name: 'Skip to content' }));
    expect(document.activeElement).toBe(screen.getByRole('main'));
    expect(window.location.hash).toBe(before);
  });
});

/* ---------------- the navigation names itself ---------------- */

describe('the navigation names itself', () => {
  it('names every destination on the rail by its word, with its count for a screen reader', async () => {
    mount(<Shell phone={false} />);
    const rail = await screen.findByRole('navigation', { name: 'Main' });
    // The badge is a decoration (`aria-hidden`); the count is in the name.
    // The summons count is Your turn's since one-pool phase 14; Runs is unbadged.
    for (const name of [
      'Runs',
      'Your turn, 1',
      'Plans, 2',
      'Sessions, 4',
      'Repo',
      'Insights',
      'Logs',
      'Settings',
    ]) {
      expect(within(rail).getByRole('button', { name }), name).toBeTruthy();
    }
  });

  it('announces the rail bands, which it draws as a hairline and nothing else', async () => {
    // The grouping is real information — the work, the record, the console —
    // and on the rail it is carried ENTIRELY by a 1 px rule. Without a named
    // group it is the one reading a screen reader cannot get (WCAG 1.3.1).
    mount(<Shell phone={false} />);
    const rail = await screen.findByRole('navigation', { name: 'Main' });
    expect(
      within(rail)
        .getAllByRole('group')
        .map((el) => el.getAttribute('aria-label')),
    ).toEqual(['The work', 'The record', 'The console']);
    expect(
      within(within(rail).getByRole('group', { name: 'The record' })).getAllByRole('button'),
    ).toHaveLength(3);
  });

  it('marks where you are — a deeper head lights the place it belongs under', async () => {
    for (const [at, current] of [
      [hrefOf('runs'), 'Runs'],
      [planHref('demo', 'run'), 'Plans, 2'],
      // The old head lights the new place for the instant its redirect runs.
      ['#/debug/health', 'Logs'],
      [turnHref('abc'), 'Your turn, 1'],
    ] as const) {
      const { unmount } = mount(<Shell phone={false} />, at);
      const rail = await screen.findByRole('navigation', { name: 'Main' });
      const marked = within(rail)
        .getAllByRole('button')
        .filter((button) => button.getAttribute('aria-current') === 'page');
      expect(
        marked.map((button) => button.textContent),
        at,
      ).toHaveLength(1);
      expect(marked[0], at).toBe(within(rail).getByRole('button', { name: current }));
      unmount();
    }
  });

  it('titles the header with the place’s spoken word', async () => {
    for (const [at, title] of [
      [hrefOf('runs'), 'Runs'],
      [planHref('demo', 'run'), 'Plan'],
      [turnHref(), 'Your turn'],
      [logsHref('health'), 'Logs'],
    ] as const) {
      const { unmount } = mount(<Shell phone={false} />, at);
      // Exactly the word: `Plan` is a page of its own, never `Plans`.
      expect((await screen.findByTestId('header-title')).textContent, at).toBe(title);
      unmount();
    }
  });

  it('names the bell with what its number counts', async () => {
    mount(<Shell phone={false} />);
    expect(await screen.findByRole('button', { name: 'Announcements, 7 unread' })).toBeTruthy();
  });

  it('names every tab on a phone, and says whether More is open', async () => {
    mount(<Shell phone />);
    const bar = await screen.findByRole('navigation', { name: 'Main' });
    for (const id of TAB_BAR.slice(0, 4)) {
      const item = navItem(id)!;
      expect(
        within(bar).getByRole('button', { name: new RegExp(`^${item.label}(, \\d+)?$`) }),
        id,
      ).toBeTruthy();
    }
    const more = within(bar).getByRole('button', { name: 'More' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('dialog', { name: 'More' })).toBeTruthy();
  });
});

describe('the More sheet', () => {
  it('names its bands from the headings it already draws, and holds what the tabs do not', async () => {
    mount(<Shell phone />);
    fireEvent.click(await screen.findByRole('button', { name: 'More' }));
    const sheet = await screen.findByRole('dialog', { name: 'More' });
    // Queried BY NAME, which is the whole claim: the group points at the
    // heading it draws (`aria-labelledby`) rather than repeating it. Matching
    // on text instead stays green when `aria-labelledby` is deleted. The tab
    // bar takes the work band — in Pro all but Sessions, which yields its slot
    // to the Supervisor — so the sheet holds the other two, and Sessions in Pro.
    expect(within(sheet).getByRole('group', { name: 'The record' })).toBeTruthy();
    expect(within(sheet).getByRole('group', { name: 'The console' })).toBeTruthy();
    const work = within(sheet).queryByRole('group', { name: 'The work' });
    if (STATE.chat) expect(within(work!).getByRole('button', { name: /^Sessions/ })).toBeTruthy();
    else expect(work).toBeNull();
    expect(within(sheet).getByRole('button', { name: /^Logs/ })).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: /^Settings/ })).toBeTruthy();
  });

  it('has no axe violations while it is open', async () => {
    mount(<Shell phone />);
    fireEvent.click(await screen.findByRole('button', { name: 'More' }));
    await screen.findByRole('dialog', { name: 'More' });
    // Sheets portal to the body, so the whole document is the subject.
    await expectNoAxeViolations(document.body);
  });
});

/* ---------------- a hash change is a navigation ---------------- */

describe('a hash change is a navigation, and is treated as one', () => {
  it('announces the new place and moves focus into it — on a PATH change, never on load or a query change', async () => {
    mount(<Shell phone={false} framed />);
    await screen.findByText('the page at runs');
    const main = screen.getByRole('main');
    const live = main.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    // Nothing on the FIRST paint: nothing was navigated from, and stealing
    // focus on load is noise on top of the page the reader just opened.
    expect(live!.textContent).toBe('');
    expect(document.activeElement).not.toBe(main);

    const rail = screen.getByRole('navigation', { name: 'Main' });
    fireEvent.click(within(rail).getByRole('button', { name: 'Plans, 2' }));
    await screen.findByText('the page at plans');
    await waitFor(() => expect(document.activeElement).toBe(main));
    // Politely, and only the name: an assertive region would interrupt
    // whatever is being read.
    expect(live!.textContent).toBe('Plans');
    expect(live).toHaveAttribute('aria-atomic', 'true');

    // A query change is not a navigation: opening the palette must not steal
    // focus from where it is, nor say anything.
    const bell = screen.getByRole('button', { name: 'Announcements, 7 unread' });
    bell.focus();
    fireEvent.click(screen.getByRole('button', { name: /Search or jump to/ }));
    expect(navigations.at(-1)).toBe(paletteHref('', route(hrefOf('plans'))));
    expect(screen.getByText('the page at plans')).toBeTruthy();
    expect(document.activeElement).toBe(bell);
    expect(live!.textContent).toBe('Plans');

    fireEvent.click(within(rail).getByRole('button', { name: 'Logs' }));
    await screen.findByText('the page at logs');
    await waitFor(() => expect(document.activeElement).toBe(main));
    expect(live!.textContent).toBe('Logs');
  });

  it('knows every head the routes name: none falls through to the home’s name unannounced', () => {
    // A head missing from the table resolves to Runs — and is announced as
    // Runs wherever it really leads (quiet-console phase 27).
    for (const head of ROUTE_HEADS as readonly string[]) {
      expect(Object.keys(ROUTE_TABLE), head).toContain(head);
      const entry = ROUTE_TABLE[head]!;
      const word = entry.kind === 'page' ? SPOKEN[head] : SPOKEN[destinationFor(head) ?? ''];
      expect(word, `${head} has no word to be announced by`).toBeTruthy();
      expect(spokenHead(head), head).toBe(word);
    }
  });

  it('announces every head by its name when a person arrives at it, and moves focus into it', async () => {
    // One navigation per head the table knows — every destination, every head
    // a destination has not absorbed, every old address that redirects — each
    // read back from the live region exactly as a screen reader would hear it.
    let go: ((path: string) => void) | undefined;
    function Driver() {
      go = useNavigate();
      return null;
    }
    mount(
      <>
        <Driver />
        <Shell phone={false} framed />
      </>,
    );
    await screen.findByText('the page at runs');
    const main = screen.getByRole('main');
    const live = main.querySelector('[aria-live="polite"]')!;
    // From somewhere else each time, so every head is a PATH change.
    const heads = (Object.keys(ROUTE_TABLE) as string[]).filter((head) => head !== 'runs');
    for (const head of [...heads, 'runs']) {
      const deep = head === 'plan' ? `${head}/demo` : head;
      act(() => go!(hrefOf(deep)));
      await waitFor(() => expect(live.textContent, head).toBe(routeAnnouncement(route(hrefOf(deep)))));
      expect(live.textContent, head).toMatch(new RegExp(`^${spokenHead(head)}(, |$)`));
      await waitFor(() => expect(document.activeElement, head).toBe(main));
      act(() => (document.activeElement as HTMLElement | null)?.blur());
    }
  });
});
