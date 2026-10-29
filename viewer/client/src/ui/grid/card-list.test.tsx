/**
 * The grid below 900 — the same column array, as a list of records.
 *
 * Its own file because faking the phone means mocking `@/lib/media` for the
 * whole module. What these hold (quiet-console phase 6, exit criterion 1): a
 * record is ONE line at the glance — the identity, the headline as the record's
 * link, the quiet `meta` line and the one action — and every other column is a
 * fact one press away, under its head; with Everything on the facts are on the
 * record and only what the operator hid stays folded; a column hidden by the
 * operator is still in the fold; `card: 'none'` draws nothing; the groups are
 * heading items with their counts; the orders reach a phone; the toolbar is a
 * search and one View button. No datum removed.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setPrefs } from '@/lib/prefs';
import { expectNoAxeViolations } from '@/test/axe';
import type { Column } from './column';
import { Grid, type GridProps } from './grid';

vi.mock('@/lib/media', () => ({
  usePhone: () => true,
  useNarrow: () => true,
  useTouch: () => true,
  isPhone: () => true,
}));

interface Run {
  id: string;
  plan: string;
  state: string;
  clock: string;
  cost: number;
  branch: string;
  model: string;
}

const rows: Run[] = [
  {
    id: 'r1',
    plan: 'quiet-console',
    state: 'running',
    clock: '12 min',
    cost: 4,
    branch: 'pe/quiet',
    model: 'opus',
  },
  {
    id: 'r2',
    plan: 'control-tower',
    state: 'waiting',
    clock: '2 h',
    cost: 9,
    branch: 'pe/tower',
    model: 'fable',
  },
];

const columns: Column<Run>[] = [
  { id: 'id', head: 'Run', identity: true, priority: 1, min: 64, cell: (r) => r.id, value: (r) => r.id },
  {
    id: 'plan',
    head: 'Plan',
    card: 'title',
    priority: 1,
    min: 160,
    flex: true,
    cell: (r) => r.plan,
    value: (r) => r.plan,
    filter: 'text',
    sort: { id: 'plan', dir: 'ascending' },
  },
  {
    id: 'state',
    head: 'State',
    card: 'meta',
    min: 96,
    cell: (r) => r.state,
    value: (r) => r.state,
    groupable: true,
    filter: 'facet',
  },
  {
    id: 'clock',
    head: 'Updated',
    card: 'meta',
    min: 96,
    cell: (r) => r.clock,
    sort: { id: 'updated', dir: 'descending' },
  },
  { id: 'cost', head: 'Cost', align: 'end', min: 76, cell: (r) => `$${r.cost}` },
  { id: 'branch', head: 'Branch', min: 160, cell: (r) => r.branch },
  { id: 'model', head: 'Model', everything: true, min: 96, cell: (r) => r.model },
  {
    id: 'act',
    head: 'Action',
    card: 'action',
    min: 96,
    cell: (r) => <button type="button">{`Open ${r.id}`}</button>,
  },
  { id: 'mark', head: 'Mark', card: 'none', min: 24, cell: () => 'never-drawn-on-a-card' },
];

beforeEach(() => {
  setPrefs({ tables: {}, everything: {} });
});

const mount = (props: Partial<GridProps<Run>> = {}) =>
  render(<Grid label="Runs" columns={columns} rows={rows} getRowKey={(r) => r.id} {...props} />);

const recordOf = (text: string) => screen.getByText(text).closest('li')!;
const foldOf = (record: HTMLElement) => within(record).getByRole('button', { name: /details/i });

describe('one column array, the phone’s records', () => {
  it('draws a list, not a table: one record per row', () => {
    mount();
    expect(screen.queryByRole('table')).toBeNull();
    const list = screen.getByRole('list', { name: 'Runs' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(rows.length);
  });

  it('is one line at the glance: the identity, the headline, the quiet line and the one action', () => {
    mount({ rowHref: (r) => `#/plan/${r.plan}/run` });
    const record = recordOf('quiet-console');
    expect(within(record).getByText('r1')).toBeInTheDocument();
    expect(within(record).getByRole('link', { name: 'quiet-console' })).toHaveAttribute(
      'href',
      '#/plan/quiet-console/run',
    );
    expect(within(record).getByText('running')).toBeInTheDocument();
    expect(within(record).getByText('12 min')).toBeInTheDocument();
    expect(within(record).getByRole('button', { name: 'Open r1' })).toBeInTheDocument();
    // The facts are folded, and the fold counts them — Cost, Branch and Everything's Model.
    expect(within(record).queryByText('pe/quiet')).toBeNull();
    expect(foldOf(record)).toHaveTextContent('(3)');
  });

  it('keeps every other column one press away, under its head, in the order declared', () => {
    mount();
    const record = recordOf('quiet-console');
    fireEvent.click(foldOf(record));
    const facts = [...record.querySelectorAll('dt')].map((dt) => dt.textContent);
    expect(facts).toEqual(['Cost', 'Branch', 'Model']);
    expect(within(record).getByText('pe/quiet')).toBeInTheDocument();
    expect(within(record).getByText('opus')).toBeInTheDocument();
  });

  it('never draws a `card: none` column on a record', () => {
    mount();
    fireEvent.click(foldOf(recordOf('quiet-console')));
    expect(screen.queryByText('never-drawn-on-a-card')).toBeNull();
  });

  it('with Everything on, draws the facts on the record and folds only what the operator hid', () => {
    setPrefs({ tables: { 'runs-phone': { hidden: ['branch'] } } });
    mount({ tableId: 'runs-phone', everything: { on: true, toggle: () => {} } });
    const record = recordOf('quiet-console');
    expect(within(record).getByText('$4')).toBeInTheDocument();
    expect(within(record).getByText('opus')).toBeInTheDocument();
    // The hidden one is still a press away — hiding is not deleting.
    expect(within(record).queryByText('pe/quiet')).toBeNull();
    const fold = foldOf(record);
    expect(fold).toHaveTextContent('(1)');
    fireEvent.click(fold);
    expect(within(record).getByText('pe/quiet')).toBeInTheDocument();
  });

  it('follows the record’s link on a plain click, and leaves a control’s press to the control', () => {
    const followed = vi.fn((event: Event) => event.preventDefault());
    mount({ rowHref: (r) => `#/plan/${r.plan}/run` });
    const record = recordOf('quiet-console');
    within(record).getByRole('link').addEventListener('click', followed);
    fireEvent.click(within(record).getByText('running'));
    expect(followed).toHaveBeenCalledOnce();
    fireEvent.click(within(record).getByRole('button', { name: 'Open r1' }));
    expect(followed).toHaveBeenCalledOnce();
  });

  it('carries the row’s own props to the record', () => {
    mount({ rowProps: (r) => ({ 'data-run': r.id }) });
    expect(recordOf('control-tower')).toHaveAttribute('data-run', 'r2');
  });

  it('shows the empty line where the records would be', () => {
    mount({ rows: [], empty: 'No runs yet.' });
    expect(screen.getByText('No runs yet.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });
});

describe('strips on a phone (Tower strips)', () => {
  it('a record in a state wears its edge, and sits on its tint while open — and only when the grid asks', () => {
    const { unmount } = mount();
    expect(recordOf('quiet-console').querySelector('[data-strip-edge]')).toBeNull();
    unmount();
    mount({ rowPaint: (r) => (r.state === 'running' ? 'running' : 'waiting') });
    const record = recordOf('quiet-console');
    expect(record).toHaveAttribute('data-strip', 'running');
    expect(record).toHaveClass('relative');
    expect(record.querySelector('[data-strip-edge]')).toHaveClass(
      'state-running',
      'bg-state-vivid',
      'start-0',
    );
    expect(recordOf('control-tower').querySelector('[data-strip-edge]')).toHaveClass('state-waiting');
    expect(record).not.toHaveClass('bg-state-tint');
    fireEvent.click(foldOf(record));
    expect(record).toHaveClass('state-running', 'bg-state-tint');
  });
});

describe('groups and orders on a phone', () => {
  it('draws each group as a heading item with its count, and folds it in place', async () => {
    mount({ groupBy: 'state' });
    const waiting = await screen.findByRole('button', { name: /waiting/ });
    expect(waiting).toHaveAttribute('aria-expanded', 'true');
    expect(within(waiting).getByText('1')).toBeInTheDocument();
    fireEvent.click(waiting);
    expect(screen.queryByText('control-tower')).toBeNull();
    expect(screen.getByText('quiet-console')).toBeInTheDocument();
  });

  it('offers the orders a desk reaches from its headers, when no toolbar carries them', () => {
    const onSort = vi.fn();
    mount({ onSort, activeSort: 'updated' });
    const orders = screen.getByRole('group', { name: 'Sort' });
    expect(within(orders).getByRole('button', { name: 'Updated' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(orders).getByRole('button', { name: 'Plan' }));
    expect(onSort).toHaveBeenCalledWith('plan');
  });
});

describe('the toolbar on a phone', () => {
  it('is the search and one View button; the sheet holds the grammar’s other words in order', async () => {
    const { container } = mount({
      toolbar: true,
      onSort: () => {},
      everything: { on: true, toggle: () => {} },
    });
    const bar = container.querySelector('[data-toolbar]')!;
    expect(
      within(bar as HTMLElement).getByRole('searchbox', { name: 'Search the runs by plan' }),
    ).toBeInTheDocument();
    const view = within(bar as HTMLElement).getByRole('button', { name: /^View/ });
    // Everything on is a setting in use.
    expect(view).toHaveAccessibleName('View, 1 in use');
    expect(within(bar as HTMLElement).queryByRole('button', { name: /^Filter/ })).toBeNull();
    // With the toolbar there, the orders live in its sort slot, not above the list.
    expect(screen.queryByRole('group', { name: 'Sort' })).toBeNull();

    fireEvent.click(view);
    const sheet = await screen.findByRole('dialog', { name: 'View' });
    const order = [...sheet.querySelectorAll('[data-slot]')].map((el) => el.getAttribute('data-slot'));
    expect(order).toEqual(['filter', 'group', 'sort', 'view', 'everything']);
    expect(within(sheet).getByRole('heading', { name: 'Columns' })).toBeInTheDocument();
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('has no axe violation, folds open', async () => {
    const { container } = mount({ toolbar: true, groupBy: 'state', rowHref: (r) => `#/plan/${r.plan}/run` });
    await screen.findByRole('button', { name: /running/ });
    fireEvent.click(foldOf(recordOf('quiet-console')));
    await expectNoAxeViolations(container);
  });
});
