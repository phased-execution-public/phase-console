/**
 * The window — asked for, it settles.
 *
 * jsdom lays nothing out, so what a window DRAWS is the real browser's to say
 * (`viewer/e2e/tables.spec.ts`: a thousand rows, fewer than eighty `<tr>`, a
 * sticky header). What jsdom can say is the thing that broke first: the
 * engine hands its window up to the grid through a layout effect, and a window
 * that was a new object on every render — the virtualizer re-measures every
 * row when its `getItemKey` changes — handed itself up forever. React stops
 * that with "Maximum update depth exceeded" and the table never appears.
 */

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { DataTable, VIRTUAL_FROM, type Column } from '@/components/data-table';

interface Line {
  id: string;
  outcome: string;
}

const rows: Line[] = Array.from({ length: VIRTUAL_FROM + 50 }, (_, i) => ({
  id: `line-${i}`,
  outcome: i % 2 ? 'sent' : 'failed',
}));

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
  {
    id: 'outcome',
    head: 'Outcome',
    min: 96,
    cell: (row) => row.outcome,
    value: (row) => row.outcome,
    filter: 'facet',
  },
];

describe('the window', () => {
  it('past the threshold, a virtual table settles and says how many rows it holds', async () => {
    render(
      <MemoryRouterProvider initial="#/debug/delivery" onNavigate={() => {}}>
        <main>
          <DataTable
            label="Lines"
            columns={columns}
            rows={rows}
            getRowKey={(row) => row.id}
            virtual
            toolbar
          />
        </main>
      </MemoryRouterProvider>,
    );
    const table = await screen.findByRole('table', { name: 'Lines' });
    await expect.poll(() => table.getAttribute('aria-rowcount')).toBe(String(rows.length + 1));
  });

  it('at or under the threshold, nothing is windowed and every row is drawn', async () => {
    const few = rows.slice(0, VIRTUAL_FROM);
    render(
      <MemoryRouterProvider initial="#/debug/delivery" onNavigate={() => {}}>
        <DataTable label="Lines" columns={columns} rows={few} getRowKey={(row) => row.id} virtual toolbar />
      </MemoryRouterProvider>,
    );
    await screen.findByRole('button', { name: /^View/ });
    const table = screen.getByRole('table', { name: 'Lines' });
    expect(table.hasAttribute('aria-rowcount')).toBe(false);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(few.length);
  });
});

/*
 * Where the window starts. The rows are placed from the table's own top inside
 * the shell's scroller, and whatever sits above the table decides where that is
 * — so the window measures it. It once never did: the measuring effect ran
 * before the grid had drawn the element it measures, found nothing, and never
 * ran again, and every window was placed for a table at the scroller's top
 * edge. In a browser that is a band of bare spacer under the header, as tall as
 * everything above the table less the overscan (`e2e/tables.spec.ts`).
 *
 * jsdom lays nothing out, so the layout is stated here: the scroller is 768 px
 * tall, a row is 44 px (the estimate), and the table's body starts `origin` px
 * down it. From 660 px only rows 0–2 reach into view, so eleven are drawn with
 * the overscan of eight; a window that thinks the body starts at 0 draws 26.
 */
describe("the window's origin", () => {
  const SCROLLER = 768;
  const ROW = 44;
  let origin = 660;
  const observers: RecordingObserver[] = [];

  class RecordingObserver {
    readonly observed = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }
    observe(node: Element): void {
      this.observed.add(node);
    }
    unobserve(node: Element): void {
      this.observed.delete(node);
    }
    disconnect(): void {
      this.observed.clear();
    }
  }

  const isOrigin = (node: Element): boolean =>
    node.tagName === 'TBODY' && node.parentElement?.querySelector('tbody') === node;

  // The setup file's stand-in is writable but not configurable, so it is
  // swapped by assignment rather than `vi.stubGlobal`.
  const standIn = globalThis.ResizeObserver;

  beforeEach(() => {
    origin = 660;
    observers.length = 0;
    globalThis.ResizeObserver = RecordingObserver as unknown as typeof ResizeObserver;
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.tagName === 'MAIN') return SCROLLER;
      return this.hasAttribute('data-index') ? ROW : 0;
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const top = isOrigin(this) ? origin : 0;
      const height = this.tagName === 'MAIN' ? SCROLLER : 0;
      return { top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top } as DOMRect;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.ResizeObserver = standIn;
  });

  const drawn = (table: HTMLElement): number => table.querySelectorAll('tbody[data-index]').length;

  function renderBelow(): { table: () => HTMLElement; above: HTMLElement } {
    render(
      <MemoryRouterProvider initial="#/debug/delivery" onNavigate={() => {}}>
        <main>
          <section data-testid="page">
            <p>What sits above the table.</p>
            <DataTable
              label="Lines"
              columns={columns}
              rows={rows}
              getRowKey={(row) => row.id}
              virtual
              toolbar
            />
          </section>
        </main>
      </MemoryRouterProvider>,
    );
    return {
      table: () => screen.getByRole('table', { name: 'Lines' }),
      above: screen.getByTestId('page'),
    };
  }

  it('is measured once the grid has drawn it, so the window starts where the table does', async () => {
    const { table } = renderBelow();
    await screen.findByRole('table', { name: 'Lines' });
    await expect.poll(() => table().getAttribute('aria-rowcount')).toBe(String(rows.length + 1));
    await expect.poll(() => drawn(table())).toBe(11);
  });

  it('is measured again when what sits above the table changes height', async () => {
    const { table, above } = renderBelow();
    await screen.findByRole('table', { name: 'Lines' });
    await expect.poll(() => drawn(table())).toBe(11);

    // A query above the table lands: the table moves down 100 px. Neither the
    // scroller nor the origin changed size — the box around both did.
    origin = 760;
    act(() => {
      for (const observer of observers) {
        if (!observer.observed.has(above)) continue;
        observer.callback([], observer as unknown as ResizeObserver);
      }
    });
    // From 760 px only row 0 reaches into view: nine drawn.
    await expect.poll(() => drawn(table())).toBe(9);
  });
});
