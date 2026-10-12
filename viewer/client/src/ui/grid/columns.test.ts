/**
 * The column cut, and the 7.0 column's two readings.
 *
 * jsdom computes no styles (`css: false`), which is why every other size
 * promise in this client is asserted as source text. This one need not be:
 * `planColumns` is arithmetic over declared widths, so it can be asserted as
 * arithmetic — which is the whole reason the decision was pulled out of the
 * component in the first place.
 *
 * What these tests hold: priority 1 is never dropped, so a table can never lose
 * the column naming the record; columns fold cheapest-first; nothing folds
 * while everything fits; an unmeasured table shows everything rather than
 * flashing a folded one and unfolding it a frame later (the WRAPPER is what
 * carries that case honestly — it scrolls until a width exists); and the budget
 * is charged the track the column will actually be LAID OUT on, which is
 * `width` when it declares one. Budgeting `min` while laying out on `width` is
 * how the cut came to say ten columns fit and the layout then drew them 360 px
 * past the box.
 */

import { describe, expect, it } from 'vitest';
import { readingOf, searchColumnOf, type Column } from './column';
import { planColumns } from './layout';

const col = (id: string, priority: number, min: number): Column<unknown> => ({
  id,
  head: id,
  cell: () => null,
  priority,
  min,
});

const ids = (list: readonly { id: string }[]) => list.map((c) => c.id);

describe('planColumns', () => {
  const columns = [
    col('num', 1, 50),
    col('name', 1, 200),
    col('status', 2, 100),
    col('cost', 3, 100),
    col('turns', 4, 100),
  ];

  it('shows everything when it all fits', () => {
    const { shown, folded } = planColumns(columns, 2000);
    expect(ids(shown)).toEqual(['num', 'name', 'status', 'cost', 'turns']);
    expect(folded).toEqual([]);
  });

  it('folds the lowest priority first', () => {
    const { shown, folded } = planColumns(columns, 500);
    expect(ids(folded)).toEqual(['turns']);
    expect(ids(shown)).toEqual(['num', 'name', 'status', 'cost']);
  });

  it('keeps folding as the box narrows', () => {
    expect(ids(planColumns(columns, 400).folded)).toEqual(['cost', 'turns']);
    expect(ids(planColumns(columns, 300).folded)).toEqual(['status', 'cost', 'turns']);
  });

  it('never drops priority 1, even when it cannot fit', () => {
    // A table that has dropped the column naming the record is not a narrower
    // table, it is a different one. The wrapper scrolls instead.
    const { shown, folded } = planColumns(columns, 80);
    expect(ids(shown)).toEqual(['num', 'name']);
    expect(ids(folded)).toEqual(['status', 'cost', 'turns']);
  });

  it('preserves declaration order in what it shows, not priority order', () => {
    const mixed = [col('a', 3, 60), col('b', 1, 60), col('c', 2, 60)];
    expect(ids(planColumns(mixed, 1000).shown)).toEqual(['a', 'b', 'c']);
  });

  it('shows everything while unmeasured', () => {
    // Width 0 is the first paint, and jsdom forever. Folding on it would mean
    // every table flashed narrow and then widened.
    expect(planColumns(columns, 0).folded).toEqual([]);
  });

  it('leaves room for the fold affordance while anything is still unplaced', () => {
    // 350 fits num+name+status exactly on the raw numbers; the affordance is
    // what stops it, because two more columns still have nowhere to go.
    const { folded } = planColumns(columns, 350);
    expect(folded.length).toBeGreaterThan(0);
  });

  it('defaults a column with no priority to the middle of the pack', () => {
    const noPriority: Column<unknown> = { id: 'x', head: 'X', cell: () => null, min: 100 };
    const { folded } = planColumns([col('num', 1, 50), noPriority, col('late', 5, 100)], 200);
    // The unmarked column outranks an explicit 5 and is dropped after it.
    expect(ids(folded)).toEqual(['late']);
  });
});

describe('the budget is charged the track the layout will use', () => {
  const wide = (id: string, priority: number, min: number, width: string): Column<unknown> => ({
    ...col(id, priority, min),
    width,
  });

  it('charges `width`, not `min`, when a column declares one', () => {
    // Three columns of min 100 fit in 340 with the affordance's 40 to spare.
    // The third one has declared it will be laid out at 300, so it does not.
    const columns = [col('num', 1, 100), col('name', 1, 100), wide('cost', 2, 100, '300px')];
    expect(ids(planColumns(columns, 340).folded)).toEqual(['cost']);
    expect(ids(planColumns(columns, 740).folded)).toEqual([]);
  });

  it('counts a declared track in the essential columns too', () => {
    // Priority 1 is kept whatever happens, but what it SPENDS still decides
    // what can join it — the cut was over-optimistic by exactly this margin.
    const columns = [wide('name', 1, 100, '340px'), col('status', 2, 100)];
    expect(ids(planColumns(columns, 400).folded)).toEqual(['status']);
  });

  it('reads px, rem and a bare number, and falls back to `min` for anything else', () => {
    const at = (width: string) => planColumns([col('a', 1, 40), wide('b', 2, 40, width)], 200).folded;
    expect(at('240px')).toHaveLength(1);
    expect(at('15rem')).toHaveLength(1);
    expect(at('240')).toHaveLength(1);
    // A percentage is not a number of pixels; `min` is the safe reading, so the
    // column is budgeted at the 40 it promised it can be read at.
    expect(at('90%')).toHaveLength(0);
  });
});

describe('a 7.0 column declares its floor', () => {
  it('is a type error without a min — the default a 6.x column leaned on does not exist here', () => {
    // @ts-expect-error — `min` is required: the narrowest the column reads at, measured.
    const missing: Column<unknown> = { id: 'name', head: 'Name', cell: () => null };
    expect(missing.id).toBe('name');
  });

  it('is budgeted at exactly the floor it declares', () => {
    // 90 + 90 fit 220 with the fold affordance's 40 to spare; the floor moves the answer.
    const columns = [col('a', 1, 90), col('b', 2, 90)];
    expect(ids(planColumns(columns, 220).folded)).toEqual([]);
    expect(ids(planColumns([col('a', 1, 90), col('b', 2, 140)], 220).folded)).toEqual(['b']);
  });
});

describe('the two readings', () => {
  const columns: Column<unknown>[] = [
    { ...col('name', 1, 160), identity: true, everything: true },
    col('status', 1, 96),
    { ...col('model', 3, 120), everything: true },
    col('cost', 2, 76),
    { ...col('branch', 4, 160), everything: true },
  ];

  it('the essentials withhold the columns Everything adds, in the declared order', () => {
    const { offered, withheld } = readingOf(columns, false);
    expect(ids(offered)).toEqual(['name', 'status', 'cost']);
    expect(ids(withheld)).toEqual(['model', 'branch']);
  });

  it('Everything offers every column and withholds nothing', () => {
    const { offered, withheld } = readingOf(columns, true);
    expect(ids(offered)).toEqual(['name', 'status', 'model', 'cost', 'branch']);
    expect(withheld).toEqual([]);
  });

  it('no reading folds the identity, whatever it is marked', () => {
    expect(ids(readingOf(columns, false).offered)).toContain('name');
  });
});

describe('the search column', () => {
  it('is the first text filter that has a value to test', () => {
    const value = () => 'x';
    const columns: Column<unknown>[] = [
      { ...col('state', 1, 96), filter: 'facet', value },
      { ...col('note', 3, 96), filter: 'text' },
      { ...col('plan', 1, 160), filter: 'text', value },
      { ...col('repo', 2, 120), filter: 'text', value },
    ];
    expect(searchColumnOf(columns)?.id).toBe('plan');
    expect(searchColumnOf(columns.slice(0, 2))).toBeUndefined();
  });
});
