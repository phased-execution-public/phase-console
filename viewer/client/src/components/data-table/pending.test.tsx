/**
 * Before the engine lands (control-tower phase 23, #26).
 *
 * The row model is a chunk of its own, loaded when a table first asks for a
 * feature. Until it arrived, a table that had asked for a window drew every
 * row it was given — a 72-phase plan's table was in the DOM whole for the
 * frames the chunk took, the very cost the window exists to spare. It draws
 * what it would ever draw whole now, and says how many more are on their way;
 * and a chunk that cannot arrive holds nothing back, so the rows show as given.
 *
 * Each case imports the grid afresh (`vi.resetModules`), because which engine
 * it has is module state, and stands the chunk in: one that never arrives, one
 * that fails.
 */

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Column } from '@/components/data-table';

const ENGINE = '@/components/data-table/engine';

interface Line {
  id: string;
}

const rows: Line[] = Array.from({ length: 72 }, (_, i) => ({ id: `line-${i}` }));

const columns: Column<Line>[] = [
  {
    id: 'id',
    head: 'Line',
    identity: true,
    priority: 1,
    flex: true,
    cell: (row) => row.id,
    value: (row) => row.id,
  },
];

async function mount(): Promise<HTMLElement> {
  const { MemoryRouterProvider } = await import('@/app/router');
  const { DataTable } = await import('@/components/data-table');
  render(
    <MemoryRouterProvider initial="#/debug/delivery" onNavigate={() => {}}>
      <DataTable
        label="Lines"
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.id}
        virtual
        virtualFrom={40}
        toolbar
      />
    </MemoryRouterProvider>,
  );
  return screen.getByRole('table', { name: 'Lines' });
}

describe('before the engine lands', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock(ENGINE);
  });

  it('a table past its threshold draws what it draws whole, and says how many more are coming', async () => {
    vi.doMock(ENGINE, () => new Promise(() => {}));
    const table = await mount();
    expect(table.querySelectorAll('tbody tr')).toHaveLength(41);
    expect(screen.getByRole('status')).toHaveTextContent('40 of 72 rows shown while the table loads.');
    expect(screen.getByText('line-39')).toBeInTheDocument();
    expect(screen.queryByText('line-40')).toBeNull();
    expect(table.hasAttribute('aria-rowcount')).toBe(false);
  });

  it('a chunk that cannot arrive holds nothing back: every row shows as given', async () => {
    vi.doMock(ENGINE, () => {
      throw new Error('the chunk did not arrive');
    });
    const table = await mount();
    await expect.poll(() => table.querySelectorAll('tbody tr').length).toBe(rows.length);
    expect(screen.queryByText(/rows shown while the table loads/)).toBeNull();
    expect(screen.getByText('line-71')).toBeInTheDocument();
  });
});
