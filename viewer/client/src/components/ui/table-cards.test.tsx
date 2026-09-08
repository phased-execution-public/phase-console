/**
 * `DataTable` below the shell breakpoint — the card list.
 *
 * Its own file because faking the phone means mocking `@/lib/media` for a whole
 * module (matchMedia answers are cached at module level; `app-phone.test.tsx`
 * exists for the same reason), and `surfaces.test.tsx` describes the desktop.
 *
 * What these hold: the card list is the same table's other rendering, not a
 * reduced one. It carries the SORT the desktop offers (the Plans list had five
 * orders on a desktop and none on a phone), the row's own props (the plans
 * prefetch-on-intent was passed and dropped, so a phone paid the round trip on
 * every open), the row's destination as a real link, and the empty state. The
 * sort chips clear the tap floor, and the chip row may wrap — it grows by one
 * chip per sortable column and a row that cannot wrap pushes the page sideways.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { expectNoAxeViolations } from '@/test/axe';
import { DataTable, type Column } from './table';

vi.mock('@/lib/media', () => ({
  usePhone: () => true,
  useNarrow: () => true,
  useTouch: () => true,
  isPhone: () => true,
}));

interface Plan {
  slug: string;
  title: string;
}

const rows: Plan[] = [
  { slug: 'alpha', title: 'Console speed' },
  { slug: 'beta', title: 'Concurrent plans' },
];

const columns: Column<Plan>[] = [
  { id: 'slug', head: 'Plan', identity: true, priority: 1, cell: (row) => row.slug },
  {
    id: 'title',
    head: 'Title',
    card: 'title',
    priority: 1,
    cell: (row) => row.title,
    sort: { id: 'name', dir: 'ascending' },
  },
  {
    id: 'activity',
    head: 'Activity',
    align: 'end',
    cell: () => '2 h',
    sort: { id: 'activity', dir: 'descending' },
  },
];

const mount = (props: Partial<Parameters<typeof DataTable<Plan>>[0]> = {}) =>
  render(
    <MemoryRouterProvider initial="#/plans" onNavigate={props.rowHref ? undefined : () => {}}>
      <DataTable label="Plans" columns={columns} rows={rows} getRowKey={(row) => row.slug} {...props} />
    </MemoryRouterProvider>,
  );

describe('the card list', () => {
  it('renders records, not a table', () => {
    mount();
    expect(screen.queryByRole('table')).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Plans' })).getAllByRole('listitem')).toHaveLength(2);
  });

  it('offers every sortable column, and says which order is in force', () => {
    const onSort = vi.fn();
    mount({ activeSort: 'activity', onSort });
    const group = screen.getByRole('group', { name: 'Sort' });
    const activity = within(group).getByRole('button', { name: /Activity/ });
    expect(activity).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: /Title/ })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(within(group).getByRole('button', { name: /Title/ }));
    // The same contract the header cell uses: name the sort, the caller decides
    // what pressing the one already in force means.
    expect(onSort).toHaveBeenCalledWith('name');
  });

  it('has no sort control when the caller cannot act on one', () => {
    mount({ activeSort: 'activity' });
    expect(screen.queryByRole('group', { name: 'Sort' })).toBeNull();
  });

  it('gives the sort chips the tap floor and lets the row wrap', () => {
    mount({ activeSort: 'name', onSort: vi.fn() });
    const group = screen.getByRole('group', { name: 'Sort' });
    expect(group.className).toContain('flex-wrap');
    expect(group.className).toContain('min-w-0');
    for (const chip of within(group).getAllByRole('button')) {
      expect(chip.className).toContain('min-h-(--tap-min)');
    }
  });

  it('carries the row props through — prefetch-on-intent is not a desktop feature', () => {
    const onMouseEnter = vi.fn();
    mount({ rowProps: () => ({ onMouseEnter }) });
    fireEvent.mouseEnter(screen.getAllByRole('listitem')[0]!);
    expect(onMouseEnter).toHaveBeenCalled();
  });

  it('makes the destination a real link and the card clickable', () => {
    const onNavigate = vi.fn();
    render(
      <MemoryRouterProvider initial="#/plans" onNavigate={onNavigate}>
        <DataTable
          label="Plans"
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.slug}
          rowHref={(row) => `#/plan/${row.slug}/route`}
        />
      </MemoryRouterProvider>,
    );
    expect(screen.getByRole('link', { name: 'Console speed' })).toHaveAttribute('href', '#/plan/alpha/route');
    fireEvent.click(screen.getAllByRole('listitem')[1]!);
    expect(onNavigate).toHaveBeenCalledWith('#/plan/beta/route');
  });

  it('prints a column that is both the identity and the headline once', () => {
    // Three of the five tables here name the record with the same column you
    // read — a plan's slug, a run's id. The card had a lead slot and a headline
    // slot and filled both from it, so every card said `alpha alpha`.
    render(
      <MemoryRouterProvider initial="#/plans">
        <DataTable
          label="Plans"
          columns={[
            { id: 'slug', head: 'Plan', identity: true, card: 'title', priority: 1, cell: (r) => r.slug },
            { id: 'title', head: 'Title', card: 'meta', cell: (r) => r.title },
          ]}
          rows={[rows[0]!]}
          getRowKey={(row) => row.slug}
        />
      </MemoryRouterProvider>,
    );
    expect(screen.getAllByText('alpha')).toHaveLength(1);
  });

  it('says when there is nothing, in the shape a card has', () => {
    mount({ rows: [], empty: 'No plan is open.' });
    expect(screen.getByText('No plan is open.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Plans' })).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = mount({ activeSort: 'name', onSort: vi.fn() });
    await expectNoAxeViolations(container);
  });
});
