/**
 * The pinned rail — its arithmetic, and the grid that draws it.
 *
 * `railOffsets` is pure, so it is asserted as arithmetic (it moved here with
 * `layout.ts`). The grid half is the pair `ui/table.tsx` describes: when the
 * table is measured to overflow its box the wrapper scrolls, the header does
 * NOT stick (sticky inside an overflow-x box binds to a box that never scrolls
 * vertically), and the run of columns up to the identity pins at the start,
 * each at the tracks in front of it, opaque over whatever the row is tinted.
 * When it fits, the other branch: no scroll container, a sticky header, nothing
 * pinned. jsdom lays nothing out, so the two widths `useTableFit` reads are
 * stated here.
 */

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPrefs } from '@/lib/prefs';
import type { Column } from './column';
import { Grid } from './grid';
import { railOffsets, trackOf, type ColumnTrack } from './layout';

const track = (over: Partial<ColumnTrack> & Pick<ColumnTrack, 'id' | 'min'>): ColumnTrack => ({ ...over });

describe('railOffsets', () => {
  it('pins only the identity when the identity is the first column', () => {
    const shown = [track({ id: 'a', min: 100, identity: true }), track({ id: 'b', min: 100 })];
    expect([...railOffsets(shown, shown[0], 1000).entries()]).toEqual([['a', 0]]);
  });

  it('pins the whole run up to the identity, each at the tracks in front of it', () => {
    const shown = [
      track({ id: 'pick', min: 40, width: '40px' }),
      track({ id: 'number', min: 92, identity: true }),
      track({ id: 'title', min: 200, flex: true }),
    ];
    const rail = railOffsets(shown, shown[1], 1000);
    expect([...rail.entries()]).toEqual([
      ['pick', 0],
      ['number', 40],
    ]);
    expect(rail.has('title')).toBe(false);
  });

  it('refuses a rail wider than half the box and falls back to the identity at 0', () => {
    const shown = [
      track({ id: 'pick', min: 40, width: '40px' }),
      track({ id: 'number', min: 92, identity: true }),
    ];
    expect([...railOffsets(shown, shown[1], 200).entries()]).toEqual([['number', 0]]);
    expect([...railOffsets(shown, shown[1], 400).entries()]).toEqual([
      ['pick', 0],
      ['number', 40],
    ]);
  });

  it('never refuses when the box is unmeasured', () => {
    const shown = [
      track({ id: 'pick', min: 40, width: '40px' }),
      track({ id: 'number', min: 80, identity: true }),
    ];
    expect(railOffsets(shown, shown[1], 0).size).toBe(2);
  });

  it('pins nothing when the identity is not among the shown columns', () => {
    const shown = [track({ id: 'a', min: 100 })];
    expect(railOffsets(shown, track({ id: 'ghost', min: 100, identity: true }), 1000).size).toBe(0);
    expect(railOffsets(shown, undefined, 1000).size).toBe(0);
  });

  it('offsets on the declared track, the same number the cut and the layout use', () => {
    const shown = [
      track({ id: 'a', min: 50, width: '7rem' }), // 112
      track({ id: 'b', min: 76, align: 'end' }), //   76, its min: no width declared
      track({ id: 'c', min: 100, identity: true }),
    ];
    expect(trackOf(shown[0]!)).toBe(112);
    expect(trackOf(shown[1]!)).toBe(76);
    expect([...railOffsets(shown, shown[2], 2000).entries()]).toEqual([
      ['a', 0],
      ['b', 112],
      ['c', 188],
    ]);
  });
});

/* ------------------------------------------------------------------------- *
 * The grid draws it
 * ------------------------------------------------------------------------- */

interface Lane {
  id: string;
  state: string;
  plan: string;
  cost: number;
  branch: string;
}

const rows: Lane[] = [
  { id: 'a1', state: 'running', plan: 'quiet-console', cost: 4, branch: 'pe/quiet-console' },
  { id: 'b2', state: 'waiting', plan: 'control-tower', cost: 9, branch: 'pe/control-tower' },
];

const columns: Column<Lane>[] = [
  { id: 'state', head: 'State', priority: 1, min: 96, cell: (r) => r.state },
  { id: 'plan', head: 'Plan', identity: true, priority: 1, min: 120, cell: (r) => r.plan },
  { id: 'cost', head: 'Cost', align: 'end', min: 76, cell: (r) => `$${r.cost}`, cellClassName: 'align-top' },
  { id: 'branch', head: 'Branch', min: 200, flex: true, cell: (r) => r.branch },
];

/** The box the wrapper reports, and the width the table reports it needs. */
let box = 500;
let need = 1100;

beforeEach(() => {
  setPrefs({ tables: {} });
  box = 500;
  need = 1100;
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

const mount = () =>
  render(
    <Grid label="Lanes" columns={columns} rows={rows} getRowKey={(r) => r.id} everything cards={false} />,
  );

const wrapper = () => screen.getByRole('table', { name: 'Lanes' }).parentElement!;
const cellsOf = (text: string) => screen.getByText(text).closest('td')!;
const head = (name: string) => screen.getByRole('columnheader', { name });

describe('the grid, overflowing its box', () => {
  it('scrolls inside its own box, and its header does not stick', () => {
    mount();
    expect(wrapper()).toHaveAttribute('data-scrolls');
    expect(wrapper().className).toContain('overflow-x-auto');
    for (const th of screen.getAllByRole('columnheader')) expect(th.className).not.toContain('top-0');
  });

  it('pins the run up to the identity at the start, each at the tracks in front of it', () => {
    mount();
    expect(cellsOf('running').style.insetInlineStart).toBe('');
    expect(cellsOf('quiet-console').style.insetInlineStart).toBe('96px');
    expect(head('Plan').style.insetInlineStart).toBe('96px');
    // Past the identity nothing pins.
    expect(cellsOf('$4').className).not.toContain('sticky');
    expect(cellsOf('pe/quiet-console').className).not.toContain('sticky');
  });

  it('paints every pinned cell opaque under the row’s own tint, and draws the rail’s rule on its end side', () => {
    mount();
    for (const text of ['running', 'quiet-console']) {
      const td = cellsOf(text);
      expect(td.className).toContain('sticky');
      expect(td.className).toContain('start-0');
      expect(td.className).toContain('before:bg-surface');
      expect(td.className).toContain('after:bg-inherit');
      expect(td.className).toContain('isolate');
    }
    // Only the identity — the rail's last column — draws the rule, mirrored under rtl.
    expect(cellsOf('quiet-console').className).toContain('shadow-[1px_0_0_0_var(--rule)]');
    expect(cellsOf('quiet-console').className).toContain('rtl:shadow-[-1px_0_0_0_var(--rule)]');
    expect(cellsOf('running').className).not.toContain('shadow-[1px_0_0_0_var(--rule)]');
  });

  it('pins only the identity, at 0, when the run would be more than half the box', () => {
    box = 400; // the run is 216 px: more than half
    mount();
    expect(cellsOf('running').className).not.toContain('sticky');
    expect(cellsOf('quiet-console').className).toContain('sticky');
    expect(cellsOf('quiet-console').style.insetInlineStart).toBe('');
  });
});

describe('the grid, fitting its box', () => {
  it('is no scroll container, sticks its header to the shell’s scroller and pins nothing', () => {
    box = 1200;
    need = 1100;
    mount();
    expect(wrapper()).not.toHaveAttribute('data-scrolls');
    for (const th of screen.getAllByRole('columnheader')) expect(th.className).toContain('sticky top-0');
    expect(cellsOf('quiet-console').className).not.toContain('before:bg-surface');
  });

  it('scrolls until the box has answered: unmeasured is not "it fits"', () => {
    box = 0;
    mount();
    expect(wrapper()).toHaveAttribute('data-scrolls');
    for (const th of screen.getAllByRole('columnheader')) expect(th.className).not.toContain('top-0');
  });
});

describe('Column.cellClassName', () => {
  it('lands on the cell and not on the header', () => {
    mount();
    expect(cellsOf('$4').className).toContain('align-top');
    expect(head('Cost').className).not.toContain('align-top');
  });
});
