/**
 * The bell drawer — two panels.
 *
 * The announcements were a tab on a page until 3.0, so those are its cases,
 * moved: the store exists because a phone asleep and no tab open used to mean
 * the event had simply never happened, and every row has to say not only what
 * was announced but *what became of it* — a silent delivery failure being
 * exactly the thing that is invisible otherwise.
 *
 * What the move added is the open state. The drawer is `?bell=1` on whatever
 * route you are on, which is what lets `#/notifications` retire into it without
 * breaking a link, and what keeps the page you were reading underneath.
 *
 * Phase 8 added the second panel — the same `GET /api/inbox` rows Now leads
 * with, rendered by the same component. The default is Needs you, because the
 * bell carries a count and the count is of things still waiting; the
 * announcements panel is `?panel=announcements`, which is exactly what
 * `#/notifications` redirects to.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { parseHash, type Route } from '@/app/routes';
import { queryClientConfig } from '@/lib/queries';
import { expectNoAxeViolations } from '@/test/axe';
import { NotificationsDrawer, categoryChips, deliverySummary, groupByDay } from './drawer';

const { notifications, markRead, clear, inbox, inboxAckMany } = vi.hoisted(() => ({
  notifications: vi.fn(),
  markRead: vi.fn(),
  clear: vi.fn(),
  inbox: vi.fn(),
  inboxAckMany: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      notifications,
      markNotificationsRead: markRead,
      clearNotifications: clear,
      inbox,
      inboxAckMany,
    },
  };
});

/** The push catalogue's own shape, for the chips that read their labels off it. */
const category = (id: string, label: string) => ({ id, label, detail: 'x', byDefault: true, urgent: false });

const EMPTY = {
  items: [],
  total: 0,
  unread: 0,
  more: false,
  categories: [],
  devices: 0,
  outOfBand: { configured: false },
};

const record = (over: Record<string, unknown> = {}) => ({
  id: 'n1',
  at: new Date().toISOString(),
  category: 'approval',
  title: 'Permission needed',
  body: 'A session is blocked.',
  url: '/#/plan/demo/run',
  urgent: true,
  read: false,
  delivery: [{ device: 'd1', label: 'Mac · Chrome', outcome: 'sent', at: '' }],
  ...over,
});

const route = (hash: string): Route => parseHash(hash) as Route;

/** One inbox row, in the shape `server/inbox.ts` mints. */
const item = (over: Record<string, unknown> = {}) => ({
  id: 'errand:demo:4::verify-red',
  kind: 'errand',
  severity: 'needs-you',
  slug: 'demo',
  phase: 4,
  title: 'demo — phase 4 needs you',
  need: 'The SSH key the session named.',
  how: 'Provide it where the handoff says, then recover.',
  since: new Date().toISOString(),
  href: '#/plan/demo/run',
  actions: [
    { verb: 'recover', label: 'Recover & continue', endpoint: '/api/run/demo/recover', method: 'POST' },
  ],
  ...over,
});

/** The announcements panel is no longer the default — name it. */
const ANNOUNCEMENTS = '#/now?bell=1&panel=announcements';

function mount(hash = '#/now?bell=1') {
  const onNavigate = vi.fn();
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={hash} onNavigate={onNavigate}>
        <NotificationsDrawer route={route(hash)} />
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
  return { ...view, onNavigate };
}

beforeEach(() => {
  vi.clearAllMocks();
  notifications.mockResolvedValue(EMPTY);
  markRead.mockResolvedValue({ changed: 1, unread: 0 });
  clear.mockResolvedValue({ ok: true });
  inbox.mockResolvedValue({ items: [], generatedAt: new Date().toISOString() });
  inboxAckMany.mockResolvedValue({ results: [], acked: 0 });
});

/** The address a navigation landed on, parsed — order in a query string is not a promise. */
const wentTo = (onNavigate: ReturnType<typeof vi.fn>): Route =>
  route(String(onNavigate.mock.calls.at(-1)?.[0]));

describe('the open state is the URL', () => {
  it('renders nothing at all without ?bell=', () => {
    mount('#/now');
    expect(screen.queryByRole('dialog')).toBeNull();
    // And asks the server for nothing: a closed drawer has no business holding
    // a paged query open — of EITHER panel.
    expect(notifications).not.toHaveBeenCalled();
    expect(inbox).not.toHaveBeenCalled();
  });

  it('opens on ?bell= from any page, and closing leaves that page behind', async () => {
    const { onNavigate } = mount('#/plan/demo/run?bell=1');
    expect(await screen.findByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('#/plan/demo/run'));
  });
});

describe('what the drawer says about a delivery', () => {
  it('says nothing can reach you when no device and no command are set', async () => {
    mount(ANNOUNCEMENTS);
    expect(await screen.findByText(/Nothing can reach you out of band yet/i)).toBeTruthy();
  });

  it('renders a row as a link built from the server-supplied url', async () => {
    notifications.mockResolvedValue({
      ...EMPTY,
      items: [record()],
      total: 1,
      unread: 1,
      categories: [
        { id: 'approval', label: 'Permission needed', detail: 'x', byDefault: true, urgent: true },
      ],
      devices: 1,
    });
    mount(ANNOUNCEMENTS);

    const link = await screen.findByRole('link', { name: /Permission needed/ });
    // Never assembled here — `routeFor` on the server builds it, `toHash`
    // normalises the `/#/…` form a push payload carries.
    expect(link.getAttribute('href')).toBe('#/plan/demo/run');
    expect(screen.getByText('sent to 1')).toBeTruthy();
  });

  it('says a notification reached no device rather than implying it was delivered', async () => {
    notifications.mockResolvedValue({
      ...EMPTY,
      items: [
        record({
          id: 'n2',
          category: 'halted',
          title: 'Run halted',
          url: '/#/runs',
          read: true,
          delivery: [],
        }),
      ],
      total: 1,
      devices: 0,
      outOfBand: { configured: true },
    });
    mount(ANNOUNCEMENTS);
    expect(await screen.findByText('no device')).toBeTruthy();
  });

  it('marks a row read on the way to what it is about', async () => {
    notifications.mockResolvedValue({ ...EMPTY, items: [record()], total: 1, unread: 1, devices: 1 });
    const { onNavigate } = mount(ANNOUNCEMENTS);

    fireEvent.click(await screen.findByRole('link', { name: /Permission needed/ }));
    await waitFor(() => expect(markRead).toHaveBeenCalledWith(['n1']));
    // A bare href cannot mark anything read, which is why the click is
    // intercepted — but the href stays so it can still be middle-clicked.
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('#/plan/demo/run'));
  });

  it('offers Mark all read only when something is unread', async () => {
    notifications.mockResolvedValue({ ...EMPTY, items: [record({ read: true })], total: 1, devices: 1 });
    mount(ANNOUNCEMENTS);
    const button = await screen.findByRole('button', { name: 'Mark all read' });
    expect(button).toBeDisabled();
  });
});

describe('the needs-you panel — the SAME rows Now leads with', () => {
  it('is the default panel, and it renders the inbox rather than the announcements', async () => {
    inbox.mockResolvedValue({ items: [item()], generatedAt: '' });
    mount();
    expect(await screen.findByText('demo — phase 4 needs you')).toBeTruthy();
    // The row carries the server's own remedy, with the server's own label.
    expect(screen.getByRole('button', { name: /Recover & continue/ })).toBeTruthy();
    // And the announcements query is not held open while its panel is closed.
    expect(notifications).not.toHaveBeenCalled();
  });

  it('switching panels is a navigation, so the address says which half is open', async () => {
    const { onNavigate } = mount();
    fireEvent.click(await screen.findByRole('button', { name: /Announcements/ }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith(ANNOUNCEMENTS));
  });

  /**
   * The three overlays were the only surfaces in this client with no axe pass,
   * and they are the ones most likely to fail one: an overlay owns focus,
   * names itself and must be escapable. Mounted OPEN with a row that carries
   * an action, because an empty drawer proves nothing about the rows.
   */
  it('opens with no axe violations, on a row that carries an action', async () => {
    inbox.mockResolvedValue({ items: [item()], generatedAt: '' });
    const { container } = mount();
    await screen.findByText('demo — phase 4 needs you');
    await expectNoAxeViolations(container);
  });

  it('an action whose capability is off is offered, disabled, never hidden', async () => {
    inbox.mockResolvedValue({
      items: [
        item({
          actions: [
            {
              verb: 'recover',
              label: 'Recover & continue',
              endpoint: '/api/run/demo/recover',
              method: 'POST',
              flag: 'run',
            },
          ],
        }),
      ],
      generatedAt: '',
    });
    mount();
    const button = await screen.findByRole('button', { name: /Recover & continue/ });
    expect(button).toBeDisabled();
    expect(button.getAttribute('title')).toContain('--allow-run');
  });
});

describe('the dedicated asks section', () => {
  it('groups session asks under their own heading when both kinds are present', async () => {
    inbox.mockResolvedValue({
      items: [
        item({
          id: 'session-ask::::sess-1',
          kind: 'session-ask',
          severity: 'urgent',
          title: 'A session is waiting on your permission',
          actions: [],
        }),
        item(),
      ],
      generatedAt: '',
    });
    mount();
    expect(await screen.findByText('Sessions asking you')).toBeTruthy();
    expect(screen.getByText('Also waiting')).toBeTruthy();
    expect(screen.getByText('A session is waiting on your permission')).toBeTruthy();
    expect(screen.getByText('demo — phase 4 needs you')).toBeTruthy();
  });

  it('renders one flat list when everything (or nothing) is an ask — a heading over all of it says nothing', async () => {
    inbox.mockResolvedValue({
      items: [
        item({
          id: 'approval:demo:4:run-1:a1',
          kind: 'approval',
          severity: 'urgent',
          title: 'Bash: git push',
        }),
      ],
      generatedAt: '',
    });
    mount();
    expect(await screen.findByText('Bash: git push')).toBeTruthy();
    expect(screen.queryByText('Sessions asking you')).toBeNull();
    expect(screen.queryByText('Also waiting')).toBeNull();
  });
});

/**
 * The defect this file exists to keep closed: the drawer could not be
 * scrolled.
 *
 * Two boxes both claimed the overflow — the sheet, and a panel asking for
 * `h-full` against a parent with no definite height — so the panel grew past
 * the viewport, its own `overflow-y-auto` had nothing left to scroll, and the
 * outer one had been told everything fitted. Under that, the bulk bar sat in
 * flow BELOW the list, which on a hundred-row inbox is a hundred rows past a
 * fold that would not move: the operator's reading was that the drawer had no
 * bulk actions at all.
 *
 * So: exactly one scrolling box, nothing above it scrolls, and the two things
 * that must never scroll away — the panel switch and the bulk bar — are
 * outside it. Asserted on the class attribute rather than on computed style,
 * because jsdom computes none.
 */
describe('exactly one thing in the drawer scrolls', () => {
  it('has one scrolling region, and no ancestor of it scrolls too', async () => {
    inbox.mockResolvedValue({ items: [item()], generatedAt: '' });
    mount();
    await screen.findByText('demo — phase 4 needs you');

    const dialog = screen.getByRole('dialog');
    const scrollers = dialog.querySelectorAll('[data-testid="drawer-scroller"]');
    expect(scrollers).toHaveLength(1);

    const scroller = scrollers[0] as HTMLElement;
    // A scroller needs all three: something to scroll, permission to shrink
    // below its content, and a share of a definite height to shrink within.
    expect(scroller.className).toMatch(/\boverflow-y-auto\b/);
    expect(scroller.className).toMatch(/\bmin-h-0\b/);
    expect(scroller.className).toMatch(/\bflex-1\b/);

    // The sheet hands the scrolling DOWN — every box between here and the
    // dialog is a flex column that scrolls nothing.
    for (
      let node = scroller.parentElement;
      node && node !== dialog.parentElement;
      node = node.parentElement
    ) {
      expect(node.className, `${node.tagName}.${node.className} also scrolls`).not.toMatch(
        /\boverflow-y-auto\b/,
      );
    }
  });

  it('keeps the panel switch and the bulk bar out of it', async () => {
    inbox.mockResolvedValue({ items: [item()], generatedAt: '' });
    mount();
    await screen.findByText('demo — phase 4 needs you');

    const scroller = screen.getByTestId('drawer-scroller');
    expect(scroller.contains(screen.getByRole('button', { name: /Announcements/ }))).toBe(false);
    expect(scroller.contains(screen.getByTestId('selection-bar'))).toBe(false);
  });
});

/**
 * Bulk, and the "for all" verbs beside it.
 *
 * On Now the bar arrives with the first tick, which is right on a page you can
 * see all of. In the drawer it is DOCKED — present the moment there is
 * anything to act on — because a control nobody can discover is a control
 * nobody has. The whole-list verbs and the selection verbs never share the
 * bar: they are alternatives, and side by side they are one mis-click apart.
 */
describe('acting on more than one, from the drawer', () => {
  const two = [item(), item({ id: 'errand:demo:5::verify-red', title: 'demo — phase 5 needs you' })];

  it('shows the bar before anything is ticked, offering the whole-list verb', async () => {
    inbox.mockResolvedValue({ items: two, generatedAt: '' });
    mount();
    await screen.findByText('demo — phase 5 needs you');
    const bar = screen.getByTestId('selection-bar');
    expect(within(bar).getByRole('button', { name: 'Acknowledge all' })).toBeTruthy();
    expect(bar.textContent).toContain('Nothing picked');
  });

  it('names what Acknowledge all will touch, and acknowledges it in ONE request', async () => {
    inbox.mockResolvedValue({ items: two, generatedAt: '' });
    mount();
    await screen.findByText('demo — phase 5 needs you');

    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge all' }));
    // Nothing yet: a toolbar button is too small a gesture for clearing a list.
    expect(inboxAckMany).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Acknowledge 2 things?');
    // Named, not counted — the list is what says whether they are the ones you meant.
    expect(dialog.textContent).toContain('demo — phase 4 needs you');
    expect(dialog.textContent).toContain('demo — phase 5 needs you');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Acknowledge them' }));
    await waitFor(() => expect(inboxAckMany).toHaveBeenCalledTimes(1));
    expect(inboxAckMany).toHaveBeenCalledWith([two[0].id, two[1].id]);
  });

  it('swaps the whole-list verbs for the selection ones the moment something is ticked', async () => {
    inbox.mockResolvedValue({ items: two, generatedAt: '' });
    mount();
    await screen.findByText('demo — phase 5 needs you');

    fireEvent.click(screen.getAllByRole('checkbox')[0] as HTMLElement);
    const bar = screen.getByTestId('selection-bar');
    expect(bar.textContent).toContain('1 selected');
    expect(within(bar).queryByRole('button', { name: 'Acknowledge all' })).toBeNull();
    expect(within(bar).getByRole('button', { name: 'Acknowledge' })).toBeTruthy();
  });

  it('gives the announcements panel the same bar, with its own vocabulary', async () => {
    notifications.mockResolvedValue({ ...EMPTY, items: [record()], total: 1, unread: 1, devices: 1 });
    mount(ANNOUNCEMENTS);
    const bar = await screen.findByTestId('selection-bar');
    // Reading is this list's verb; the three whole-list ones live beside it.
    expect(within(bar).getByRole('button', { name: 'Mark all read' })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Clear read' })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Clear all' })).toBeTruthy();

    fireEvent.click(screen.getAllByRole('checkbox')[0] as HTMLElement);
    expect(within(bar).getByRole('button', { name: 'Mark read' })).toBeTruthy();
    expect(within(bar).queryByRole('button', { name: 'Mark all read' })).toBeNull();
  });

  it('asks before deleting the log, and says how many', async () => {
    notifications.mockResolvedValue({ ...EMPTY, items: [record()], total: 12, unread: 1, devices: 1 });
    mount(ANNOUNCEMENTS);
    fireEvent.click(await screen.findByRole('button', { name: 'Clear all' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Delete all 12 notifications?');
    expect(clear).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete them' }));
    await waitFor(() => expect(clear).toHaveBeenCalledWith('all'));
  });
});

/**
 * The filters are part of the address.
 *
 * `?panel=` is the precedent: what the drawer is SHOWING is a fact about where
 * you are, so it can be linked, reloaded and shared. The plumbing was there —
 * `useInbox` has keyed on `category` since it shipped — with nothing on screen
 * to set it and nowhere for it to be remembered.
 */
describe('the announcement filters ride in the URL', () => {
  const twoCategories = {
    ...EMPTY,
    items: [record(), record({ id: 'n2', category: 'halted', title: 'Run halted', read: true })],
    total: 2,
    unread: 1,
    devices: 1,
    categories: [category('approval', 'Permission needed'), category('halted', 'Run halted')],
  };

  it('puts unread-only in the query rather than in component state', async () => {
    notifications.mockResolvedValue(twoCategories);
    const { onNavigate } = mount(ANNOUNCEMENTS);
    fireEvent.click(await screen.findByRole('button', { name: 'Unread only' }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
    expect(wentTo(onNavigate).query).toMatchObject({
      bell: '1',
      panel: 'announcements',
      unread: '1',
    });
  });

  it('offers a chip per category it has seen, and asks the server for the one pressed', async () => {
    notifications.mockResolvedValue(twoCategories);
    const { onNavigate } = mount(ANNOUNCEMENTS);
    const chips = await screen.findByRole('group', { name: 'Filter by category' });
    // The word each ROW wears, so the link between the filter and what it keeps
    // needs no explaining; the catalogue's sentence is the hover.
    const halted = within(chips).getByRole('button', { name: 'halted' });
    expect(halted.getAttribute('title')).toBe('Run halted');

    fireEvent.click(halted);
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
    expect(wentTo(onNavigate).query).toMatchObject({ panel: 'announcements', category: 'halted' });
  });

  it('reads the address on arrival — a filtered drawer is reloadable', async () => {
    notifications.mockResolvedValue(twoCategories);
    mount('#/now?bell=1&panel=announcements&category=halted&unread=1');
    await waitFor(() => expect(notifications).toHaveBeenCalled());
    expect(notifications.mock.calls.at(-1)![0]).toMatchObject({ category: 'halted', unread: true });
  });

  it('always leaves a way back to the whole log, even on a cold reload into a filter', async () => {
    // The narrowed page holds exactly one category, so a chip row derived from
    // the page alone would be a filter that could do nothing but re-press
    // itself. "All" is what makes an address into a filter rather than a trap.
    notifications.mockResolvedValue({
      ...twoCategories,
      items: [twoCategories.items[1]],
      total: 1,
      unread: 0,
    });
    const { onNavigate } = mount('#/now?bell=1&panel=announcements&category=halted');
    const chips = await screen.findByRole('group', { name: 'Filter by category' });
    expect(
      within(chips)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['All', 'halted']);

    fireEvent.click(within(chips).getByRole('button', { name: 'All' }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
    expect(wentTo(onNavigate).query.category).toBeUndefined();
  });

  it('takes the filters with it when the drawer closes', async () => {
    notifications.mockResolvedValue(twoCategories);
    const { onNavigate } = mount('#/now?bell=1&panel=announcements&category=halted&unread=1');
    await screen.findByRole('dialog');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    // A `?category=` left on the address describes a panel that is not open and
    // survives every later navigation — the reason `panel` is dropped too.
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('#/now'));
  });

  it('says the filters are why it is empty, and offers to clear them', async () => {
    notifications.mockResolvedValue({ ...EMPTY, total: 3, devices: 1 });
    mount('#/now?bell=1&panel=announcements&unread=1');
    expect(await screen.findByText('Nothing matches')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear the filters' })).toBeTruthy();
  });
});

describe('the two pure helpers', () => {
  it('names today and yesterday, and dates everything else', () => {
    const day = 86_400_000;
    const groups = groupByDay([
      record({ id: 'a', at: new Date().toISOString() }),
      record({ id: 'b', at: new Date(Date.now() - day).toISOString() }),
      record({ id: 'c', at: new Date(Date.now() - 6 * day).toISOString() }),
      record({ id: 'd', at: 'not a date' }),
    ] as never);
    const names = groups.map(([name]) => name);
    expect(names[0]).toBe('Today');
    expect(names[1]).toBe('Yesterday');
    expect(names[3]).toBe('Undated');
    // Every record lands in exactly one bucket.
    expect(groups.reduce((n, [, items]) => n + items.length, 0)).toBe(4);
  });

  it('orders the category chips by the catalogue, and keeps ones it does not know', () => {
    const registry = [category('approval', 'Permission needed'), category('halted', 'Run halted')];
    // Catalogue order is graded by what stops work, so the chips do not
    // reshuffle as records arrive — and an id the catalogue has never heard of
    // (an older server, a category since retired) sorts last under its own name
    // rather than vanishing.
    expect(categoryChips(['halted', 'legacy', 'approval'], registry)).toEqual([
      { id: 'approval', label: 'Permission needed' },
      { id: 'halted', label: 'Run halted' },
      { id: 'legacy', label: 'legacy' },
    ]);
    // Seen twice is one chip.
    expect(categoryChips(['halted', 'halted'], registry)).toHaveLength(1);
    expect(categoryChips([], registry)).toEqual([]);
  });

  it('counts a partial delivery as a failure, in the fewest words that are true', () => {
    expect(deliverySummary(record({ delivery: [] }) as never)).toEqual({
      text: 'no device',
      failed: false,
    });
    expect(
      deliverySummary(
        record({
          delivery: [
            { device: 'a', label: 'a', outcome: 'sent', at: '' },
            { device: 'b', label: 'b', outcome: 'failed', at: '' },
          ],
        }) as never,
      ),
    ).toEqual({ text: '1/2 not delivered', failed: true });
    expect(
      deliverySummary(record({ delivery: [{ device: 'a', label: 'a', outcome: 'sent', at: '' }] }) as never),
    ).toEqual({ text: 'sent to 1', failed: false });
  });

  it('reads a device in its quiet hours as held, never as a failure', () => {
    const row = (device: string, outcome: string) => ({ device, label: device, outcome, at: '' });
    expect(deliverySummary(record({ delivery: [row('a', 'quiet')] }) as never)).toEqual({
      text: 'held by quiet hours',
      failed: false,
    });
    expect(deliverySummary(record({ delivery: [row('a', 'sent'), row('b', 'quiet')] }) as never)).toEqual({
      text: 'sent to 1 · 1 quiet',
      failed: false,
    });
    // A real failure beside a held device is still a failure.
    expect(deliverySummary(record({ delivery: [row('a', 'failed'), row('b', 'quiet')] }) as never)).toEqual({
      text: '1/2 not delivered',
      failed: true,
    });
  });
});
