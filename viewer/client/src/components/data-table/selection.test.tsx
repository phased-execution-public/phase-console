/**
 * Selection — a tick is a row's KEY, so it survives the table being re-sorted.
 *
 * The issues board's pick column held its own `Set` and its own bar; this is
 * that, once, in the grid: a pick box per row, one "every row shown" box in the
 * header, and a bar that appears while anything is picked and offers the
 * table's bulk verbs over exactly the rows picked. The tick is keyed by
 * `getRowKey`, never by position, so a sort the caller applies between the
 * tick and the press moves the rows and not the choice.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { expectNoAxeViolations } from '@/test/axe';
import { DataTable, type BulkVerb, type Column } from '@/components/data-table';

interface Issue {
  ref: string;
  title: string;
}

const rows: Issue[] = [
  { ref: '#41', title: 'Queue reads stale holders' },
  { ref: '#42', title: 'Lease clock drifts' },
  { ref: '#43', title: 'Streak counts attempts' },
];

const columns: Column<Issue>[] = [
  {
    id: 'ref',
    head: 'Issue',
    identity: true,
    priority: 1,
    min: 72,
    cell: (row) => row.ref,
    value: (row) => row.ref,
  },
  { id: 'title', head: 'Title', flex: true, priority: 1, cell: (row) => row.title },
];

function mount(verbs: BulkVerb<Issue>[], list: Issue[] = rows) {
  const tree = (items: Issue[]) => (
    <MemoryRouterProvider initial="#/repo/issues" onNavigate={() => {}}>
      <DataTable
        label="Issues"
        columns={columns}
        rows={items}
        getRowKey={(row) => row.ref}
        selection={{ verbs }}
      />
    </MemoryRouterProvider>
  );
  const view = render(tree(list));
  return { ...view, resort: (items: Issue[]) => view.rerender(tree(items)) };
}

const bar = () => screen.queryByRole('region', { name: 'Selected rows' });

describe('selection', () => {
  it('a pick drives the bulk-verb bar, and the verb gets exactly the rows picked', async () => {
    const close = vi.fn();
    const { container } = mount([{ id: 'close', label: 'Close issues', onRun: close }]);
    const first = await screen.findByRole('checkbox', { name: 'Select #41' });
    expect(bar()).toBeNull();

    fireEvent.click(first);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select #43' }));

    expect(within(bar()!).getByText('2 selected')).toBeInTheDocument();
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Close issues' }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(close.mock.calls[0]![0].map((row: Issue) => row.ref)).toEqual(['#41', '#43']);
    await expectNoAxeViolations(container);
  });

  it('survives a sort: the same rows stay picked after the caller reorders them', async () => {
    const run = vi.fn();
    const { resort } = mount([{ id: 'label', label: 'Label', onRun: run }]);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select #41' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select #42' }));

    resort([...rows].reverse());

    // The order moved…
    const order = screen
      .getAllByRole('row')
      .slice(1)
      .map((tr) => within(tr).getAllByRole('cell')[1]?.textContent);
    expect(order).toEqual(['#43', '#42', '#41']);
    // …and the choice did not.
    expect(screen.getByRole('checkbox', { name: 'Select #41' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select #42' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select #43' })).not.toBeChecked();
    expect(within(bar()!).getByText('2 selected')).toBeInTheDocument();
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Label' }));
    expect(run.mock.calls[0]![0].map((row: Issue) => row.ref).sort()).toEqual(['#41', '#42']);
  });

  it('the header box picks every row shown, says when only some are, and Clear empties the bar', async () => {
    mount([{ id: 'close', label: 'Close issues', onRun: () => {} }]);
    const all = await screen.findByRole('checkbox', { name: 'Select every row shown' });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select #42' }));
    expect((all as HTMLInputElement).indeterminate).toBe(true);

    fireEvent.click(all);
    expect(all).toBeChecked();
    expect(within(bar()!).getByText('3 selected')).toBeInTheDocument();

    fireEvent.click(within(bar()!).getByRole('button', { name: 'Clear selection' }));
    expect(bar()).toBeNull();
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked();
  });

  it('a row that leaves the data leaves the selection with it', async () => {
    const run = vi.fn();
    const { resort } = mount([{ id: 'close', label: 'Close issues', onRun: run }]);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select #41' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select #42' }));

    resort(rows.filter((row) => row.ref !== '#42'));

    expect(within(bar()!).getByText('1 selected')).toBeInTheDocument();
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Close issues' }));
    expect(run.mock.calls[0]![0].map((row: Issue) => row.ref)).toEqual(['#41']);
  });
});
