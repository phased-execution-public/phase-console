/**
 * The grid on a desk — one column array, the wide table and its folded cut.
 *
 * What these hold (quiet-console phase 6, exit criterion 1 and the grid's own
 * features): a column the cut cannot fit, a column only Everything draws and a
 * column the operator hid all FOLD — counted on the row's `+N`, listed under
 * their heads when the row opens — and none of them leaves the page; with
 * Everything on every column is drawn and nothing is cut; the groups are rows
 * of ONE table; a pick is a row key; the window says how many rows it holds;
 * a grid whose engine has not landed says how many rows are on their way, and
 * one whose engine cannot land holds nothing back; and the view an operator
 * builds is kept by `tableId`. jsdom lays nothing out, so where a width matters
 * the two numbers `useTableFit` reads are stated.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPrefs, setPrefs } from '@/lib/prefs';
import { expectNoAxeViolations } from '@/test/axe';
import type { Column } from './column';
import { Grid, type GridProps } from './grid';
import { VIRTUAL_FROM } from './layout';

interface Lock {
  phase: string;
  owner: string;
  lease: string;
  state: string;
  cost: number;
  model: string;
}

const rows: Lock[] = [
  { phase: 'tower-p3', owner: 'autopilot/9c66', lease: '41 min', state: 'running', cost: 4, model: 'opus' },
  { phase: 'tower-p4', owner: 'mobin@studio', lease: '12 min', state: 'waiting', cost: 9, model: 'fable' },
  { phase: 'tower-p5', owner: 'autopilot/9c66', lease: '3 min', state: 'running', cost: 1, model: 'opus' },
];

const columns: Column<Lock>[] = [
  {
    id: 'phase',
    head: 'Phase',
    identity: true,
    priority: 1,
    min: 140,
    flex: true,
    cell: (r) => r.phase,
    value: (r) => r.phase,
    filter: 'text',
  },
  {
    id: 'state',
    head: 'State',
    priority: 1,
    min: 96,
    cell: (r) => r.state,
    value: (r) => r.state,
    filter: 'facet',
    groupable: true,
  },
  { id: 'owner', head: 'Holder', priority: 2, min: 140, cell: (r) => r.owner, value: (r) => r.owner },
  { id: 'lease', head: 'Lease', priority: 3, min: 96, cell: (r) => r.lease },
  {
    id: 'cost',
    head: 'Cost',
    align: 'end',
    priority: 4,
    min: 76,
    cell: (r) => `$${r.cost}`,
    value: (r) => r.cost,
  },
  { id: 'model', head: 'Model', everything: true, min: 96, cell: (r) => r.model, value: (r) => r.model },
];

/** The box the wrapper reports (0 = unmeasured) and the width the table says it needs. */
let box = 0;
let need = 0;

beforeEach(() => {
  setPrefs({ tables: {}, everything: {} });
  box = 0;
  need = 0;
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
    return this.firstElementChild?.tagName === 'TABLE' ? box : 0;
  });
  vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
    return this.tagName === 'TABLE' ? need : 0;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const mount = (props: Partial<GridProps<Lock>> = {}) =>
  render(<Grid label="Locks" columns={columns} rows={rows} getRowKey={(r) => r.phase} {...props} />);

const header = () => screen.getAllByRole('columnheader').map((th) => th.textContent);
const toggleOf = (phase: string) =>
  within(screen.getByText(phase).closest('tr')!).getByRole('button', { name: /the rest of this row/ });
const detailOf = (toggle: HTMLElement) => document.getElementById(toggle.getAttribute('aria-controls')!)!;

/*
 * Every popover or sheet a test opens, it closes: one torn down open by the
 * test's own unmount leaves its dismissable layer registered, and the next
 * test's overlay is then never the top layer.
 */
async function close(layer: HTMLElement) {
  fireEvent.keyDown(layer, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

describe('one column array, the wide table', () => {
  it('draws every column the essentials offer when they fit, and folds nothing', () => {
    box = 2000;
    need = 1000;
    mount();
    expect(header()).toEqual(['Phase', 'State', 'Holder', 'Lease', 'Cost']);
    // The Everything column is the one thing folded, and it is counted.
    expect(toggleOf('tower-p3')).toHaveAccessibleName('Show the rest of this row — 1 more column');
  });

  it('folds what the box cannot fit, cheapest first, and counts it on the row', () => {
    box = 440; // Phase 140 + State 96 + Holder 140 = 376, with the fold's 40: Lease and Cost fold
    need = 400;
    mount();
    expect(header()).toEqual(['Phase', 'State', 'Holder']);
    const toggle = toggleOf('tower-p3');
    expect(toggle).toHaveAccessibleName('Show the rest of this row — 3 more columns');
    expect(within(screen.getByText('tower-p3').closest('td')!).getByText('+3')).toBeInTheDocument();

    // The floor is the drawn tracks and the fold count's room: 140 + 96 + 140 + 40.
    expect(screen.getByRole('table', { name: 'Locks' }).style.minWidth).toBe('416px');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // Each folded column under its own head, with this row's value — in the order declared.
    const detail = detailOf(toggle);
    expect([...detail.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual([
      'Lease',
      'Cost',
      'Model',
    ]);
    expect(within(detail).getByText('41 min')).toBeInTheDocument();
    expect(within(detail).getByText('$4')).toBeInTheDocument();
    expect(within(detail).getByText('opus')).toBeInTheDocument();
  });

  it('never folds priority 1, however narrow the box', () => {
    box = 120;
    need = 400;
    mount();
    expect(header()).toEqual(['Phase', 'State']);
  });

  it('lays out the room the cut reserved for the fold count on the identity', () => {
    box = 2000;
    need = 1000;
    const narrow: Column<Lock>[] = [{ ...columns[0]!, flex: undefined, min: 68 }, ...columns.slice(1)];
    mount({ columns: narrow });
    // 68 of its own and the 40 the `+1` needs: a two-digit number never splits beside it.
    expect(screen.getByRole('columnheader', { name: 'Phase' }).style.width).toBe('108px');
  });
});

describe('Everything', () => {
  it('off, a column marked `everything` is no column at all — it is in the row’s details', () => {
    box = 2000;
    need = 1000;
    mount({ everything: false });
    expect(header()).not.toContain('Model');
    const toggle = toggleOf('tower-p4');
    fireEvent.click(toggle);
    expect(within(detailOf(toggle)).getByText('fable')).toBeInTheDocument();
  });

  it('on, every column is drawn, nothing is cut, and the wrapper scrolls instead', () => {
    box = 440;
    need = 760;
    mount({ everything: { on: true, toggle: () => {} } });
    expect(header()).toEqual(['Phase', 'State', 'Holder', 'Lease', 'Cost', 'Model']);
    expect(screen.queryByRole('button', { name: /the rest of this row/ })).toBeNull();
    expect(screen.getByRole('table', { name: 'Locks' }).parentElement).toHaveAttribute('data-scrolls');
  });

  it('lays the table out no narrower than every drawn track, so the flex column keeps its floor', () => {
    box = 440;
    need = 760;
    mount({ everything: { on: true, toggle: () => {} } });
    // 140 + 96 + 140 + 96 + 76 + 96: the flex Phase column is never crushed under its 140.
    expect(screen.getByRole('table', { name: 'Locks' }).style.minWidth).toBe('644px');
  });

  it('draws the page’s switch as the toolbar’s last word', async () => {
    const toggle = vi.fn();
    mount({ toolbar: true, everything: { on: false, toggle } });
    const control = screen.getByRole('switch', { name: 'Everything' });
    expect(control).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(control);
    expect(toggle).toHaveBeenCalledOnce();
  });
});

describe('a hidden column folds into the row’s detail', () => {
  async function hide(head: string) {
    fireEvent.click(screen.getByRole('button', { name: /^Columns/ }));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    const box = within(within(panel).getByRole('group', { name: 'Columns' })).getByRole('checkbox', {
      name: head,
    });
    expect(box).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(box);
    expect(box).toHaveAttribute('aria-checked', 'false');
    await close(panel);
  }

  it('leaves the header, is counted, and is one press away under its head', async () => {
    box = 2000;
    need = 1000;
    mount({ toolbar: true, tableId: 'locks-hide' });
    await hide('Holder');
    expect(header()).toEqual(['Phase', 'State', 'Lease', 'Cost']);
    const toggle = toggleOf('tower-p3');
    expect(toggle).toHaveAccessibleName('Show the rest of this row — 2 more columns');
    fireEvent.click(toggle);
    const detail = detailOf(toggle);
    expect(within(detail).getByText('Holder')).toBeInTheDocument();
    expect(within(detail).getByText('autopilot/9c66')).toBeInTheDocument();
    expect(getPrefs().tables['locks-hide']?.hidden).toEqual(['owner']);
  });

  it('is kept by tableId, and the identity is never offered: the row’s toggle lives in it', async () => {
    box = 2000;
    need = 1000;
    setPrefs({ tables: { 'locks-kept': { hidden: ['lease'] } } });
    mount({ toolbar: true, tableId: 'locks-kept' });
    expect(header()).toEqual(['Phase', 'State', 'Holder', 'Cost']);
    fireEvent.click(screen.getByRole('button', { name: /^Columns/ }));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    const names = within(within(panel).getByRole('group', { name: 'Columns' }))
      .getAllByRole('checkbox')
      .map((b) => b.closest('label')?.textContent);
    expect(names).toEqual(['State', 'Holder', 'Lease', 'Cost']);
    // The essentials say what Everything would add.
    expect(within(panel).getByText(/Everything adds 1 more column/)).toBeInTheDocument();
    await close(panel);
  });
});

describe('grouping', () => {
  it('draws each group as a heading row of the one table, aria-expanded and naming its rows', async () => {
    const { container } = mount({ groupBy: 'state', tableId: 'locks-grouped' });
    const running = await screen.findByRole('button', { name: /running/ });
    expect(container.querySelectorAll('table')).toHaveLength(1);
    const table = screen.getByRole('table', { name: 'Locks' });
    for (const heading of [running, screen.getByRole('button', { name: /waiting/ })]) {
      expect(heading).toHaveAttribute('aria-expanded', 'true');
      expect(table.contains(heading.closest('tr'))).toBe(true);
      const controls = heading.getAttribute('aria-controls');
      expect(table.querySelector(`#${CSS.escape(controls!)}`)).not.toBeNull();
    }
    expect(within(running).getByText('2')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('folds a group in place, keeps it counted, and remembers it by tableId', async () => {
    const first = mount({ groupBy: 'state', tableId: 'locks-fold' });
    const waiting = await screen.findByRole('button', { name: /waiting/ });
    fireEvent.click(waiting);
    expect(waiting).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('tower-p4')).toBeNull();
    expect(within(waiting).getByText('1')).toBeInTheDocument();
    expect(getPrefs().tables['locks-fold']?.collapsed).toEqual(['state:waiting']);
    first.unmount();

    mount({ groupBy: 'state', tableId: 'locks-fold' });
    expect(await screen.findByRole('button', { name: /waiting/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('turned off by the operator, stays off whatever the grid defaults to', async () => {
    mount({ groupBy: 'state', tableId: 'locks-ungrouped', toolbar: true });
    await screen.findByRole('button', { name: /running/ });
    fireEvent.click(screen.getByRole('button', { name: /^Group/ }));
    const panel = await screen.findByRole('dialog', { name: 'Group' });
    fireEvent.click(within(panel).getByRole('radio', { name: 'None' }));
    expect(getPrefs().tables['locks-ungrouped']?.groupBy).toBeNull();
    await close(panel);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /running/ })).toBeNull();
  });
});

describe('filters, through the toolbar', () => {
  it('searches by the first text column and says how many rows it left', async () => {
    mount({ toolbar: true, tableId: 'locks-search' });
    const search = screen.getByRole('searchbox', { name: 'Search the locks by phase' });
    fireEvent.change(search, { target: { value: 'p4' } });
    await waitFor(() => expect(screen.queryByText('tower-p3')).toBeNull());
    expect(screen.getByText('tower-p4')).toBeInTheDocument();
    expect(screen.getByText('1 of 3 shown')).toBeInTheDocument();

    // The way back is on the same line.
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getByText('tower-p3')).toBeInTheDocument());
    expect(getPrefs().tables['locks-search']?.filters).toEqual({});
  });

  it('hints with the head by default, or with the page’s shorter words — the name stays the columns’', () => {
    const { unmount } = mount({ toolbar: true, tableId: 'locks-hint' });
    expect(screen.getByRole('searchbox', { name: 'Search the locks by phase' })).toHaveAttribute(
      'placeholder',
      'Search by phase',
    );
    unmount();
    // A long head is cut mid-word in a 14rem box (Logs ▸ Delivery's
    // "Announcement"), so a page may say it in fewer words.
    mount({ toolbar: { placeholder: 'Find one' }, tableId: 'locks-hint-own' });
    expect(screen.getByRole('searchbox', { name: 'Search the locks by phase' })).toHaveAttribute(
      'placeholder',
      'Find one',
    );
  });

  it('lists a facet’s values with their counts, and keeps what was ticked', async () => {
    mount({ toolbar: true, tableId: 'locks-facet' });
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    const running = await within(panel).findByRole('checkbox', { name: /running/ });
    expect(running.closest('label')).toHaveTextContent('running2');
    fireEvent.click(running);
    await close(panel);
    await waitFor(() => expect(screen.queryByText('tower-p4')).toBeNull());
    expect(screen.getByRole('button', { name: /^Filter/ })).toHaveAccessibleName(/1 in use/);
    expect(getPrefs().tables['locks-facet']?.filters).toEqual({ state: ['running'] });
  });

  it('says so inside the table when the filters leave nothing', async () => {
    setPrefs({ tables: { 'locks-none': { filters: { phase: 'nothing-matches' } } } });
    mount({ toolbar: true, tableId: 'locks-none' });
    expect(await screen.findByText('No rows match these filters.')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Locks' })).toContainElement(
      screen.getByText('No rows match these filters.'),
    );
  });
});

describe('selection', () => {
  it('picks by key, picks every row shown, and offers its verbs over exactly those', async () => {
    const onRun = vi.fn();
    mount({ selection: { verbs: [{ id: 'release', label: 'Release locks', onRun }] } });
    const pick = await screen.findByRole('checkbox', { name: 'Select tower-p4' });
    fireEvent.click(pick);
    const bar = screen.getByRole('region', { name: 'Selected rows' });
    expect(within(bar).getByText('1 selected')).toBeInTheDocument();
    fireEvent.click(within(bar).getByRole('button', { name: 'Release locks' }));
    expect(onRun).toHaveBeenCalledWith([rows[1]]);

    const all = screen.getByRole('checkbox', { name: 'Select every row shown' });
    expect(all).toHaveAttribute('aria-checked', 'mixed');
    fireEvent.click(all);
    expect(within(bar).getByText('3 selected')).toBeInTheDocument();
    fireEvent.click(within(bar).getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByRole('region', { name: 'Selected rows' })).toBeNull();
  });
});

describe('the row’s link', () => {
  it('is a real link in the identity cell, and a plain click on the row follows it', () => {
    const followed = vi.fn((event: Event) => event.preventDefault());
    mount({ rowHref: (r) => `#/sessions/locks?phase=${r.phase}` });
    const link = screen.getByRole('link', { name: 'tower-p3' });
    expect(link).toHaveAttribute('href', '#/sessions/locks?phase=tower-p3');
    link.addEventListener('click', followed);
    fireEvent.click(within(screen.getByText('tower-p3').closest('tr')!).getByText('autopilot/9c66'));
    expect(followed).toHaveBeenCalledOnce();
    // A press on a control in the row is the control's, never the row's.
    fireEvent.click(toggleOf('tower-p3'));
    expect(followed).toHaveBeenCalledOnce();
  });
});

describe('empty', () => {
  it('stands in for the rows inside the table’s frame, under its named columns', () => {
    mount({ rows: [], empty: 'No locks are held.' });
    const table = screen.getByRole('table', { name: 'Locks' });
    expect(within(table).getByText('No locks are held.')).toBeInTheDocument();
    expect(header()).toContain('Phase');
  });
});

describe('the window', () => {
  const many: Lock[] = Array.from({ length: VIRTUAL_FROM + 50 }, (_, i) => ({
    ...rows[0]!,
    phase: `line-${i}`,
  }));

  it('past 150 rows, a virtual grid settles and says how many rows it holds', async () => {
    render(
      <main>
        <Grid label="Locks" columns={columns} rows={many} getRowKey={(r) => r.phase} virtual toolbar />
      </main>,
    );
    const table = await screen.findByRole('table', { name: 'Locks' });
    await expect.poll(() => table.getAttribute('aria-rowcount')).toBe(String(many.length + 1));
  });

  it('at or under the threshold, nothing is windowed and every row is drawn', async () => {
    const few = many.slice(0, VIRTUAL_FROM);
    mount({ rows: few, virtual: true, toolbar: true });
    await screen.findByRole('searchbox');
    await act(async () => {});
    const table = screen.getByRole('table', { name: 'Locks' });
    expect(table.hasAttribute('aria-rowcount')).toBe(false);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(few.length);
  });
});

describe('before the engine lands', () => {
  const ENGINE = '@/ui/grid/engine';
  const lines: Lock[] = Array.from({ length: 72 }, (_, i) => ({ ...rows[0]!, phase: `line-${i}` }));

  async function mountFresh(): Promise<HTMLElement> {
    const { Grid: Fresh } = await import('./grid');
    render(
      <Fresh
        label="Lines"
        columns={columns}
        rows={lines}
        getRowKey={(r) => r.phase}
        virtual
        virtualFrom={40}
        toolbar
      />,
    );
    return screen.getByRole('table', { name: 'Lines' });
  }

  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock(ENGINE);
  });

  it('a grid past its threshold draws what it draws whole, and says how many more are coming', async () => {
    vi.doMock(ENGINE, () => new Promise(() => {}));
    const table = await mountFresh();
    expect(table.querySelectorAll('tbody tr')).toHaveLength(41);
    expect(screen.getByText('40 of 72 rows shown while the table loads.')).toBeInTheDocument();
    expect(screen.queryByText('line-40')).toBeNull();
  });

  it('a chunk that cannot arrive holds nothing back: every row shows as given', async () => {
    vi.doMock(ENGINE, () => {
      throw new Error('the chunk did not arrive');
    });
    const table = await mountFresh();
    await expect.poll(() => table.querySelectorAll('tbody tr').length).toBe(lines.length);
    expect(screen.queryByText(/rows shown while the table loads/)).toBeNull();
  });
});

describe('strips — a row that is one record in one state (Tower strips)', () => {
  const paintOf = (r: Lock) => (r.state === 'running' ? ('running' as const) : ('waiting' as const));

  it('is opt-in: a grid with no rowPaint draws no edge, no tint and its own toggle', () => {
    box = 2000;
    need = 1000;
    const { container } = mount();
    expect(container.querySelector('[data-strip-edge]')).toBeNull();
    expect(container.querySelector('tr[data-strip]')).toBeNull();
    const toggle = toggleOf('tower-p3');
    fireEvent.click(toggle);
    expect(detailOf(toggle)).toHaveClass('bg-ground-deep');
  });

  it('draws the state’s edge on the first cell, and an open strip and its detail on the state’s tint, the edge running down', () => {
    box = 2000;
    need = 1000;
    mount({ rowPaint: paintOf });
    const row = screen.getByText('tower-p3').closest('tr')!;
    expect(row).toHaveAttribute('data-strip', 'running');
    // The edge is the FIRST cell's, in the state's vivid hue — a state class's, never a page's.
    const first = row.querySelector('td')!;
    const edge = first.querySelector('[data-strip-edge]')!;
    expect(edge).toHaveClass('state-running', 'bg-state-vivid', 'start-0', 'w-1');
    expect(edge).toHaveAttribute('aria-hidden');
    expect(row.querySelectorAll('[data-strip-edge]')).toHaveLength(1);
    expect(screen.getByText('tower-p4').closest('tr')!.querySelector('[data-strip-edge]')).toHaveClass(
      'state-waiting',
    );
    // Folded, the strip sits on the table's ground.
    expect(row).not.toHaveClass('bg-state-tint');

    const toggle = toggleOf('tower-p3');
    // The toggle keeps its words, and is a 44 px target around a round plate that turns.
    expect(toggle).toHaveAccessibleName('Show the rest of this row — 1 more column');
    expect(toggle).toHaveClass('size-(--tap-min)', 'rounded-full');
    fireEvent.click(toggle);
    expect(toggle).toHaveAccessibleName('Hide the rest of this row — 1 more column');
    expect(toggle.querySelector('svg')).toHaveClass('rotate-90');
    expect(row).toHaveClass('state-running', 'bg-state-tint');
    const detail = detailOf(toggle);
    expect(detail).toHaveClass('state-running', 'bg-state-tint');
    expect(detail).not.toHaveClass('bg-ground-deep');
    expect(detail.querySelector('[data-strip-edge]')).toHaveClass('state-running');
  });

  it('a row the paint leaves out draws as any table’s row', () => {
    box = 2000;
    need = 1000;
    mount({ rowPaint: (r) => (r.phase === 'tower-p4' ? undefined : paintOf(r)) });
    expect(screen.getByText('tower-p4').closest('tr')!.querySelector('[data-strip-edge]')).toBeNull();
    expect(screen.getByText('tower-p3').closest('tr')!.querySelector('[data-strip-edge]')).not.toBeNull();
  });
});

describe('a grid with every door open', () => {
  it('has no axe violation', async () => {
    box = 440;
    need = 400;
    const { container } = mount({
      toolbar: { more: [{ id: 'export', label: 'Export the locks', onSelect: () => {} }] },
      tableId: 'locks-axe',
      selection: { verbs: [{ id: 'release', label: 'Release locks', onRun: () => {} }] },
      rowHref: (r) => `#/sessions/locks?phase=${r.phase}`,
      everything: { on: false, toggle: () => {} },
    });
    await screen.findByRole('checkbox', { name: 'Select tower-p3' });
    fireEvent.click(toggleOf('tower-p3'));
    await expectNoAxeViolations(container);
  });

  it('has no axe violation as strips, one open', async () => {
    box = 440;
    need = 400;
    const { container } = mount({ rowPaint: () => 'needs-you', tableId: 'locks-strips-axe' });
    fireEvent.click(toggleOf('tower-p3'));
    await expectNoAxeViolations(container);
  });
});
