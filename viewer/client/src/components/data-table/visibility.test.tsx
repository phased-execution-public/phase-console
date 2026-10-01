/**
 * Column visibility — hiding a column never removes a datum.
 *
 * The design law's first clause is "no datum removed", and a Columns menu is
 * the most direct way to break it: untick a column and its values are gone
 * from the page. So a column the operator hides does what a column the cut
 * could not fit already does — it FOLDS. It leaves the header, joins the
 * folded columns, is counted on the row's `+N`, and is one press away in the
 * row's detail, under its own head.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { getPrefs, setPrefs } from '@/lib/prefs';
import { DataTable, type Column } from '@/components/data-table';

interface Lock {
  phase: string;
  owner: string;
  lease: string;
}

const rows: Lock[] = [
  { phase: 'tower P3', owner: 'autopilot/9c66', lease: '41 min' },
  { phase: 'tower P4', owner: 'mobin@studio', lease: '12 min' },
];

const columns: Column<Lock>[] = [
  { id: 'phase', head: 'Phase', identity: true, priority: 1, flex: true, cell: (row) => row.phase },
  { id: 'owner', head: 'Holder', priority: 1, min: 140, cell: (row) => row.owner, value: (row) => row.owner },
  { id: 'lease', head: 'Lease', min: 96, cell: (row) => row.lease },
];

const mount = (props: Partial<Parameters<typeof DataTable<Lock>>[0]> = {}) =>
  render(
    <MemoryRouterProvider initial="#/sessions/locks" onNavigate={() => {}}>
      <DataTable label="Locks" columns={columns} rows={rows} getRowKey={(row) => row.phase} {...props} />
    </MemoryRouterProvider>,
  );

const header = () => screen.getAllByRole('columnheader').map((th) => th.textContent);

/*
 * Every sheet a test opens, it closes. A modal torn down open by the test's own
 * unmount leaves its dismissable layer registered, and the next test's sheet is
 * then never the top layer — Escape and the next open both go nowhere.
 */
async function close(panel: HTMLElement) {
  fireEvent.keyDown(panel, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

async function hide(head: string) {
  fireEvent.click(await screen.findByRole('button', { name: /^View/ }));
  const panel = await screen.findByRole('dialog', { name: 'View' });
  const box = within(within(panel).getByRole('group', { name: 'Columns' })).getByLabelText(head);
  expect(box).toBeChecked();
  fireEvent.click(box);
  expect(box).not.toBeChecked();
  await close(panel);
}

beforeEach(() => {
  setPrefs({ tables: {} });
});

describe('column visibility', () => {
  it('a hidden column leaves the header and is still in every row’s detail', async () => {
    mount({ toolbar: true, tableId: 'locks-visibility' });
    expect(header()).toEqual(['Phase', 'Holder', 'Lease']);

    await hide('Holder');

    expect(header()).toEqual(['Phase', 'Lease']);
    // Counted where the row says what it folded…
    const toggle = screen.getAllByRole('button', { name: /Show the rest of this row — 1 more column/ })[0]!;
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // …and there, under its own head, with the row's own value.
    const detail = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(within(detail).getByText('Holder')).toBeInTheDocument();
    expect(within(detail).getByText('autopilot/9c66')).toBeInTheDocument();
  });

  it('a narrow identity lays out the room the cut reserved for its fold count', async () => {
    // The cut sets that room aside whenever a column folds, and the flex column
    // used to take it: a 64 px `#` column then split `47` over two lines beside
    // its `+12` on every phase row (control-tower phase 23).
    const narrow: Column<Lock>[] = [
      { id: 'phase', head: 'Phase', identity: true, priority: 1, min: 68, cell: (row) => row.phase },
      ...columns.slice(1),
    ];
    mount({ toolbar: true, tableId: 'locks-owed', columns: narrow });
    const identity = () => screen.getByRole('columnheader', { name: 'Phase' });
    expect(identity().style.width).toBe('68px');

    await hide('Lease');
    expect(identity().style.width).toBe('108px');
  });

  it('the identity column is never offered: the row’s own toggle lives in it', async () => {
    mount({ toolbar: true, tableId: 'locks-identity' });
    fireEvent.click(await screen.findByRole('button', { name: /^View/ }));
    const panel = await screen.findByRole('dialog', { name: 'View' });
    const boxes = within(within(panel).getByRole('group', { name: 'Columns' })).getAllByRole('checkbox');
    expect(boxes.map((b) => b.getAttribute('aria-label') ?? b.closest('label')?.textContent)).toEqual([
      'Holder',
      'Lease',
    ]);
    await close(panel);
  });

  it('what was hidden is kept by tableId, and comes back with one untick', async () => {
    const first = mount({ toolbar: true, tableId: 'locks-kept' });
    await hide('Lease');
    expect(getPrefs().tables['locks-kept']?.hidden).toEqual(['lease']);
    first.unmount();

    mount({ toolbar: true, tableId: 'locks-kept' });
    expect(await screen.findByRole('columnheader', { name: 'Holder' })).toBeInTheDocument();
    expect(header()).toEqual(['Phase', 'Holder']);

    fireEvent.click(await screen.findByRole('button', { name: /^View/ }));
    const panel = await screen.findByRole('dialog', { name: 'View' });
    fireEvent.click(within(within(panel).getByRole('group', { name: 'Columns' })).getByLabelText('Lease'));
    await close(panel);
    expect(header()).toEqual(['Phase', 'Holder', 'Lease']);
    expect(getPrefs().tables['locks-kept']?.hidden).toEqual([]);
  });

  it('the sheet names the table it sets, in words that read for any name', async () => {
    // "What locks shows" was the sheet's own sentence: a table's name is a
    // plural as often as not, so the sentence never leans on its number.
    mount({ toolbar: true, tableId: 'locks-described' });
    fireEvent.click(await screen.findByRole('button', { name: /^View/ }));
    const panel = await screen.findByRole('dialog', { name: 'View' });
    expect(panel).toHaveAccessibleDescription('What to show in the locks, and how.');
    await close(panel);
  });
});
