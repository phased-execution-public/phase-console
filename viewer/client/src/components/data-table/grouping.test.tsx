/**
 * Grouping — the headings are rows of ONE table, and the state outlives the table.
 *
 * A group is not a second table. The run page's phase list learned that the
 * hard way (`features/runs/phase-table.tsx`, "a separate table per group is how
 * a phone ends up with five different column widths"), so the grid does what
 * that table does: each group is a heading row of the same `<table>` whose
 * button carries `aria-expanded` and names the rows it controls, and the rows
 * themselves sit in the same column tracks.
 *
 * And the choice is the operator's, kept by `tableId` in `lib/prefs.ts`
 * (`tables`): a group they folded stays folded on the next visit, and a
 * grouping they picked in the View panel is the one the table opens with.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { getPrefs, setPrefs } from '@/lib/prefs';
import { expectNoAxeViolations } from '@/test/axe';
import { DataTable, type Column } from '@/components/data-table';

interface Lane {
  id: string;
  kind: string;
  cost: number;
}

const rows: Lane[] = [
  { id: 'alpha', kind: 'running', cost: 4 },
  { id: 'beta', kind: 'waiting', cost: 9 },
  { id: 'gamma', kind: 'running', cost: 1 },
  { id: 'delta', kind: 'waiting', cost: 2 },
  { id: 'epsilon', kind: 'waiting', cost: 7 },
];

const columns: Column<Lane>[] = [
  {
    id: 'id',
    head: 'Lane',
    identity: true,
    priority: 1,
    flex: true,
    cell: (row) => row.id,
    value: (row) => row.id,
  },
  {
    id: 'kind',
    head: 'State',
    priority: 1,
    min: 96,
    cell: (row) => row.kind,
    value: (row) => row.kind,
    groupable: true,
  },
  {
    id: 'cost',
    head: 'Cost',
    align: 'end',
    min: 76,
    cell: (row) => `$${row.cost}`,
    value: (row) => row.cost,
  },
];

const mount = (props: Partial<Parameters<typeof DataTable<Lane>>[0]> = {}) =>
  render(
    <MemoryRouterProvider initial="#/runs" onNavigate={() => {}}>
      <DataTable label="Lanes" columns={columns} rows={rows} getRowKey={(row) => row.id} {...props} />
    </MemoryRouterProvider>,
  );

beforeEach(() => {
  setPrefs({ tables: {} });
});

describe('grouping', () => {
  it('draws each group as a heading row of the one table, aria-expanded and naming its rows', async () => {
    const { container } = mount({ groupBy: 'kind', tableId: 'lanes-grouped' });
    const running = await screen.findByRole('button', { name: /running/ });

    // ONE table, whatever the grouping: the groups share its column tracks.
    expect(container.querySelectorAll('table')).toHaveLength(1);
    const table = screen.getByRole('table', { name: 'Lanes' });
    const waiting = screen.getByRole('button', { name: /waiting/ });
    for (const heading of [running, waiting]) {
      expect(heading).toHaveAttribute('aria-expanded', 'true');
      // The heading is a row of that same table, not a caption above it…
      expect(table.contains(heading.closest('tr'))).toBe(true);
      // …and it names what it opens: `aria-expanded` alone says that something
      // opened, not what.
      const controls = heading.getAttribute('aria-controls');
      expect(controls).toBeTruthy();
      expect(table.querySelector(`#${CSS.escape(controls!)}`)).not.toBeNull();
    }
    // Its count is drawn, so a folded group still says how much it holds.
    expect(within(running).getByText('2')).toBeInTheDocument();
    expect(within(waiting).getByText('3')).toBeInTheDocument();
    // First appearance orders the groups, and the rows keep the caller's order.
    const cells = [...table.querySelectorAll('tbody tr')].map((tr) => tr.textContent);
    expect(cells.findIndex((t) => t?.includes('running'))).toBeLessThan(
      cells.findIndex((t) => t?.includes('waiting')),
    );
    await expectNoAxeViolations(container);
  });

  it('folds a group in place and keeps what it holds counted', async () => {
    mount({ groupBy: 'kind', tableId: 'lanes-fold' });
    const waiting = await screen.findByRole('button', { name: /waiting/ });
    expect(screen.getByText('beta')).toBeInTheDocument();

    fireEvent.click(waiting);

    expect(waiting).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('beta')).toBeNull();
    expect(screen.queryByText('epsilon')).toBeNull();
    // The other group is untouched, and the folded one still counts its rows.
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(within(waiting).getByText('3')).toBeInTheDocument();
  });

  it('keeps the folded groups and the chosen grouping by tableId, across a remount', async () => {
    const first = mount({ groupBy: 'kind', tableId: 'lanes-kept' });
    fireEvent.click(await screen.findByRole('button', { name: /waiting/ }));
    expect(getPrefs().tables['lanes-kept']?.collapsed).toEqual(['kind:waiting']);
    first.unmount();

    mount({ groupBy: 'kind', tableId: 'lanes-kept' });
    const waiting = await screen.findByRole('button', { name: /waiting/ });
    expect(waiting).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('beta')).toBeNull();
  });

  it('an operator who turned grouping off keeps it off, whatever the table defaults to', async () => {
    const first = mount({ groupBy: 'kind', tableId: 'lanes-ungrouped', toolbar: true });
    await screen.findByRole('button', { name: /running/ });
    fireEvent.click(screen.getByRole('button', { name: /^View/ }));
    const panel = await screen.findByRole('dialog', { name: 'View' });
    fireEvent.click(
      within(within(panel).getByRole('radiogroup', { name: 'Group by' })).getByLabelText('None'),
    );
    expect(getPrefs().tables['lanes-ungrouped']?.groupBy).toBeNull();
    // Closed before the unmount: a modal torn down open leaves its layer behind.
    fireEvent.keyDown(panel, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    first.unmount();

    mount({ groupBy: 'kind', tableId: 'lanes-ungrouped', toolbar: true });
    await screen.findByText('alpha');
    // Settle the engine before asserting an absence.
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /running/ })).toBeNull();
    expect(screen.getAllByRole('row').length).toBe(rows.length + 1);
  });

  it('without a tableId the grouping still works, and nothing is written to the prefs', async () => {
    mount({ groupBy: 'kind' });
    fireEvent.click(await screen.findByRole('button', { name: /waiting/ }));
    expect(screen.queryByText('beta')).toBeNull();
    expect(getPrefs().tables).toEqual({});
  });
});
