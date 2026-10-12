/**
 * The sessions' toolbar (7.0, quiet-console phase 15) — the one grammar on the
 * kit `Toolbar`: search · Filter · Group · Sort · ⋯ · Everything.
 *
 * What is asserted is what the bar has to promise on a page whose rows are
 * processes:
 *
 *  - **the search reaches the three things that tell two sessions apart** —
 *    the name, the directory and an id;
 *  - **the filter is also the only summary of what this machine runs**: each
 *    kind with its count, the word and the figure said as two things, never
 *    run together ("Shells1" reads as a different word). A kind with nothing in
 *    it is not offered — a choice that empties the list is a dead control —
 *    unless it is the one chosen, which must stay to be undone; and one kind
 *    with nothing chosen is no choice at all;
 *  - **the shape and the order say what is chosen** on their buttons, and every
 *    order explains itself where it is chosen;
 *  - **the cut is never silent** — the note says how many rows the filters are
 *    holding back, and clears them in one press;
 *  - **the one act beside the page's own**, a plan written with AI, says why it
 *    cannot be pressed on a console that opens no sessions.
 *
 * jsdom answers no media query, so this is the DESK shape — a button and its
 * popover per slot; the phone's View sheet holds the same panels and is
 * `ui/toolbar.test.tsx`'s to exercise.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalSession } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import type { NowLane } from '@/data/lanes';
import { expectNoAxeViolations } from '@/test/axe';
import { SessionList } from './list';
import {
  NO_FILTERS,
  applyFilters,
  kindCounts,
  sessionRows,
  sortRows,
  type SessionFilters,
  type SessionGroupBy,
  type SessionRow,
  type SessionSortId,
} from './model';
import { SessionsToolbar, type SessionsToolbarProps } from './toolbar';

// The wizard is the library's (`screens/plans/wizard.tsx`, with its own test):
// here only that ⋯ opens it, and that it can be closed again.
vi.mock('@/screens/plans/wizard', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ onClose }: { onClose: () => void }) =>
      createElement(
        'div',
        { role: 'dialog', 'aria-label': 'New plan' },
        createElement('button', { type: 'button', onClick: onClose }, 'Close the wizard'),
      ),
  };
});

vi.setConfig({ testTimeout: 20_000 });

const COUNTS = { lane: 2, agent: 0, shell: 1, foreign: 3 } as const;
const ESSENTIALS = { on: false, toggle: () => {} };

function mount(over: Partial<SessionsToolbarProps> = {}) {
  const props: SessionsToolbarProps = {
    filters: NO_FILTERS,
    onFilters: vi.fn(),
    sort: 'activity',
    onSort: vi.fn(),
    group: 'kind',
    onGroup: vi.fn(),
    everything: ESSENTIALS,
    counts: { ...COUNTS },
    total: 6,
    shown: 6,
    onClear: vi.fn(),
    allowAgent: true,
    ...over,
  };
  return { props, ...render(<SessionsToolbar {...props} />) };
}

/** Open a slot's popover by its button's spoken name, and read the choice inside it. */
async function choices(button: string, group: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: button }));
  return screen.findByRole('radiogroup', { name: group });
}

async function openMore(): Promise<HTMLElement> {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }), { button: 0, ctrlKey: false });
  return screen.findByRole('menu');
}

describe('the sessions toolbar', () => {
  it('searches by the three things that tell two sessions apart', () => {
    const { props } = mount();
    const search = screen.getByRole('searchbox', { name: 'Find a session by name, directory or id' });
    expect(search).toHaveAttribute('placeholder', 'Find a session');
    fireEvent.change(search, { target: { value: 'pty-771' } });
    expect(props.onFilters).toHaveBeenCalledWith({ query: 'pty-771' });
  });

  it('offers each kind that has rows, with its count beside it, and none for a kind that has none', async () => {
    const { props } = mount();
    const kinds = await choices('Filter', 'Which kind of session');
    // The word and its count, a space apart: two things, never "Shells1".
    expect(within(kinds).getByRole('radio', { name: /^Every kind 6/ })).toBeChecked();
    expect(within(kinds).getByRole('radio', { name: /^Autopilot lanes 2/ })).toBeInTheDocument();
    expect(within(kinds).getByRole('radio', { name: /^Shells 1/ })).toBeInTheDocument();
    expect(
      within(kinds).getByRole('radio', { name: /^Other sessions on this machine 3/ }),
    ).toBeInTheDocument();
    expect(within(kinds).queryByRole('radio', { name: /^Agent sessions/ })).toBeNull();
    expect(within(kinds).getAllByRole('radio')).toHaveLength(4);
    // Each kind says what it is beside its name.
    expect(within(kinds).getByText(/Plain shells on this machine/)).toBeInTheDocument();

    fireEvent.click(within(kinds).getByRole('radio', { name: /^Shells 1/ }));
    expect(props.onFilters).toHaveBeenCalledWith({ kind: 'shell' });
  });

  it('draws no filter at all when there is only one kind — unless one is chosen, which stays to be undone', async () => {
    // One kind and nothing chosen is no choice: the filter would offer the
    // list it already shows, twice.
    const { unmount } = mount({ counts: { lane: 0, agent: 0, shell: 4, foreign: 0 } });
    expect(screen.queryByRole('button', { name: /^Filter/ })).toBeNull();
    unmount();

    // A kind left set from a visit when this machine ran some, and runs none now.
    mount({ counts: { lane: 0, agent: 0, shell: 4, foreign: 0 }, filters: { ...NO_FILTERS, kind: 'lane' } });
    const kinds = await choices('Filter, Lanes', 'Which kind of session');
    expect(within(kinds).getByRole('radio', { name: /^Autopilot lanes 0/ })).toBeChecked();
    expect(within(kinds).getByRole('radio', { name: /^Shells 4/ })).not.toBeChecked();
    expect(within(kinds).queryByRole('radio', { name: /^Agent sessions/ })).toBeNull();
  });

  it('names the chosen kind on its button, and lets every kind back in with one press', async () => {
    const { props } = mount({ filters: { ...NO_FILTERS, kind: 'shell' } });
    const kinds = await choices('Filter, Shells', 'Which kind of session');
    expect(within(kinds).getByRole('radio', { name: /^Shells 1/ })).toBeChecked();
    // Narrowed is not "every kind", and says so.
    const every = within(kinds).getByRole('radio', { name: /^Every kind 6/ });
    expect(every).not.toBeChecked();
    fireEvent.click(every);
    expect(props.onFilters).toHaveBeenCalledWith({ kind: '' });
  });

  it('names the two shapes, and the one chosen', async () => {
    const { props, unmount } = mount();
    const shapes = await choices('Group, Kind', 'Group the sessions');
    expect(within(shapes).getByRole('radio', { name: /^Kind/ })).toBeChecked();
    fireEvent.click(within(shapes).getByRole('radio', { name: /^None/ }));
    expect(props.onGroup).toHaveBeenCalledWith('none');
    unmount();

    mount({ group: 'none' });
    expect(screen.getByRole('button', { name: 'Group, None' })).toBeInTheDocument();
  });

  it('names the three orders and marks the chosen one', async () => {
    const { props } = mount({ sort: 'created' });
    const orders = await choices('Sort, Started', 'Order the sessions');
    expect(within(orders).getAllByRole('radio')).toHaveLength(3);
    expect(within(orders).getByRole('radio', { name: /^Started/ })).toBeChecked();
    expect(within(orders).getByRole('radio', { name: /^Activity/ })).not.toBeChecked();
    fireEvent.click(within(orders).getByRole('radio', { name: /^Kind/ }));
    expect(props.onSort).toHaveBeenCalledWith('kind');
  });

  it('explains every order where it is chosen, grouped or not', async () => {
    // 6.2 said the chosen order's sentence under the bar once the sections
    // were off; 7.0 says every order's beside it in the Sort panel, and leaves
    // the line under the bar to the cut.
    mount({ group: 'none', sort: 'created' });
    const orders = await choices('Sort, Started', 'Order the sessions');
    expect(within(orders).getByText(/When each session began/)).toBeInTheDocument();
    expect(within(orders).getByText(/Live first, then whatever last printed/)).toBeInTheDocument();
    expect(screen.queryByTestId('sessions-filtered')).toBeNull();
  });

  it('never cuts the list silently', () => {
    const { props, unmount } = mount({ filters: { ...NO_FILTERS, kind: 'lane' }, total: 6, shown: 2 });
    expect(screen.getByTestId('sessions-filtered')).toHaveTextContent(
      'Showing 2 of 6 sessions: 4 hidden by the filters.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear the filters' }));
    expect(props.onClear).toHaveBeenCalledOnce();
    unmount();

    // The question asked is part of the answer.
    const searched = mount({ filters: { ...NO_FILTERS, query: ' repo ' }, total: 6, shown: 1 });
    expect(screen.getByTestId('sessions-filtered')).toHaveTextContent(
      'Showing 1 of 6 sessions for “repo”: 5 hidden by the filters.',
    );
    searched.unmount();

    // Nothing held back, nothing said.
    mount({ filters: { ...NO_FILTERS, query: 'repo' }, total: 6, shown: 6 });
    expect(screen.queryByTestId('sessions-filtered')).toBeNull();
  });

  it('keeps the one act beside the page’s own behind ⋯, and says why it cannot be pressed', async () => {
    mount({ allowAgent: false });
    const menu = await openMore();
    const wizard = within(menu).getByRole('menuitem', { name: /New plan with AI/ });
    expect(wizard).toHaveAttribute('data-disabled');
    expect(wizard).toHaveTextContent('This console opens no sessions (no --allow-agent).');
    // Nothing to clear at rest, so no verb that would clear it.
    expect(within(menu).queryByRole('menuitem', { name: /Clear the filters/ })).toBeNull();
  });

  it('offers to clear the filters from ⋯ once the list is narrowed', async () => {
    const { props } = mount({ filters: { ...NO_FILTERS, query: 'zsh' } });
    const menu = await openMore();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Clear the filters' }));
    expect(props.onClear).toHaveBeenCalledOnce();
  });

  it('opens the plan wizard from ⋯ on a console that may start a session', async () => {
    mount({ allowAgent: true });
    const menu = await openMore();
    const wizard = within(menu).getByRole('menuitem', { name: 'New plan with AI' });
    expect(wizard).not.toHaveAttribute('data-disabled');
    fireEvent.click(wizard);
    const dialog = await screen.findByRole('dialog', { name: 'New plan' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close the wizard' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New plan' })).toBeNull());
  });

  it('has no axe violations with every control on screen', async () => {
    // The rendered fragment, not `document`: jsdom's own page has no <title>
    // and no lang, and neither is this component's to fix.
    const { container } = mount({ filters: { query: 'repo', kind: 'lane' }, total: 6, shown: 2 });
    await expectNoAxeViolations(container);
    // …and the panel a slot opens, which is drawn outside it.
    await choices('Filter, Lanes', 'Which kind of session');
    await expectNoAxeViolations(screen.getByRole('dialog', { name: 'Filter' }));
  });
});

/* ------------------------------------------------------------------ *
 * The toolbar and the list together, wired the way the page wires them
 * ------------------------------------------------------------------ */

function Driven({ rows }: { rows: readonly SessionRow[] }) {
  const [filters, setFilters] = useState<SessionFilters>(NO_FILTERS);
  const [group, setGroup] = useState<SessionGroupBy>('kind');
  const [sort, setSort] = useState<SessionSortId>('activity');
  const shown = sortRows(applyFilters(rows, filters), sort);
  return (
    <>
      <SessionsToolbar
        filters={filters}
        onFilters={(patch) => setFilters((was) => ({ ...was, ...patch }))}
        sort={sort}
        onSort={setSort}
        group={group}
        onGroup={setGroup}
        everything={ESSENTIALS}
        counts={kindCounts(rows)}
        total={rows.length}
        shown={shown.length}
        onClear={() => setFilters(NO_FILTERS)}
        allowAgent
      />
      <SessionList rows={shown} by={group} everything={ESSENTIALS} sort={sort} onSort={setSort} />
    </>
  );
}

describe('the list the toolbar drives', () => {
  const NOW = Date.now();
  const shell: TerminalSession = {
    id: 's1',
    label: 'Terminal 1',
    cwd: '/repo',
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
    pid: 1,
    clients: 1,
    createdAt: NOW - 60_000,
  };
  const lane: NowLane = {
    key: 'run-1#3',
    slug: 'alpha',
    planTitle: 'Alpha',
    runId: 'run-1',
    phase: 3,
    status: 'running',
    runStatus: 'running',
    costUsd: 0,
    attempts: 1,
    frozen: false,
    enriched: false,
  };
  const rows: SessionRow[] = sessionRows({ terminals: [shell], lanes: [lane], now: NOW });

  function mountDriven() {
    const client = new QueryClient({
      ...queryClientConfig,
      defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
    });
    return render(
      <QueryClientProvider client={client}>
        <Driven rows={rows} />
      </QueryClientProvider>,
    );
  }

  const listedKeys = () =>
    [...document.querySelectorAll('[data-session-row]')].map((el) => el.getAttribute('data-session-row'));

  it('groups by kind by default — the shape the page has always had', async () => {
    mountDriven();
    expect(await screen.findByRole('region', { name: /^Shells/ })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /^Autopilot lanes/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Group, Kind' })).toBeInTheDocument();
  });

  it('drops the sections when ungrouped, and moves the kind word onto the row', async () => {
    mountDriven();
    const shapes = await choices('Group, Kind', 'Group the sessions');
    fireEvent.click(within(shapes).getByRole('radio', { name: /^None/ }));
    await waitFor(() => expect(screen.queryByRole('region', { name: /^Shells/ })).toBeNull());
    const list = screen.getByRole('table', { name: 'Sessions' });
    // The heading is gone, so the row says what it is — the Kind column, up
    // from Everything onto the glance.
    expect(within(list).getByRole('cell', { name: 'Shells' })).toBeInTheDocument();
    expect(within(list).getByRole('cell', { name: 'Autopilot lanes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Group, None' })).toBeInTheDocument();
  });

  it('narrows the list to one kind, says what it held back, and clears in one press', async () => {
    mountDriven();
    await waitFor(() => expect(listedKeys()).toHaveLength(2));
    const kinds = await choices('Filter', 'Which kind of session');
    fireEvent.click(within(kinds).getByRole('radio', { name: /^Shells 1/ }));
    await waitFor(() => expect(listedKeys()).toEqual(['pty:s1']));
    expect(screen.getByTestId('sessions-filtered')).toHaveTextContent(
      'Showing 1 of 2 sessions: 1 hidden by the filters.',
    );
    expect(screen.getByRole('button', { name: 'Filter, Shells' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear the filters' }));
    await waitFor(() => expect(listedKeys()).toHaveLength(2));
    expect(screen.queryByTestId('sessions-filtered')).toBeNull();
  });
});
