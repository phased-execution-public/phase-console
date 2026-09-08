/**
 * The generic list mechanics, and their parity with the model they were lifted
 * from.
 *
 * What these hold:
 *
 *  - `defineSorts` takes its ids and its default order from the record's own
 *    keys, sorts stably, and applies a pin at three precedences (the call, the
 *    spec, the kit) with `pin: false` as the one way to turn it off;
 *  - `defineFilters` skips a filter that narrows nothing, distinguishes the
 *    RESTING value from the NO-OP value (the trap that would turn "hide closed
 *    plans" into "hide nothing"), prepares once per pass rather than once per
 *    row, and lets a predicate read a sibling field;
 *  - and the whole kit reproduces `features/plans/model.ts` exactly, on a
 *    fixture, for every order it offers and every filter combination that has
 *    a control. That is the assertion that makes migrating the three feature
 *    models a mechanical change rather than a rewrite.
 *
 * The sort-parity comparators are DERIVED from the feature's own `sortRows`
 * (a two-row oracle), so the parity is against shipped behaviour rather than
 * against a second implementation of it. That derivation is only a valid total
 * order while no two fixture rows tie, which is why every sort key in the
 * fixture below is distinct — a tie would make the oracle return `-1` where a
 * real comparator returns `0`.
 */

import { describe, expect, it, vi } from 'vitest';
import { defineFilters, defineSorts, matchesWords, words, type SortSpec } from './list-model';
import {
  CLOSED_ONLY,
  OPEN_ONLY,
  SORTS as PLAN_SORTS,
  applyFilters as planApplyFilters,
  isSortId as planIsSortId,
  matches as planMatches,
  sortRows as planSortRows,
  type Filters as PlanFilters,
  type PlanRow,
  type SortId as PlanSortId,
} from '@/features/plans/model';

/* ------------------------------------------------------------------ *
 * defineSorts
 * ------------------------------------------------------------------ */

interface Row {
  id: string;
  n: number;
  live?: boolean;
}

const rows = (...spec: [string, number, boolean?][]): Row[] =>
  spec.map(([id, n, live]) => ({ id, n, ...(live == null ? {} : { live }) }));

const ids = (list: readonly Row[]): string => list.map((r) => r.id).join('');

const kit = () =>
  defineSorts<Row, 'up' | 'down'>({
    up: { label: 'Smallest', hint: 'ascending', compare: (a, b) => a.n - b.n },
    down: { label: 'Largest', blurb: 'Biggest first.', compare: (a, b) => b.n - a.n },
  });

describe('defineSorts', () => {
  it('takes the control list from the record, in declaration order', () => {
    expect(kit().SORTS).toEqual([
      { id: 'up', label: 'Smallest', hint: 'ascending' },
      { id: 'down', label: 'Largest', blurb: 'Biggest first.' },
    ]);
  });

  it('guards a stored id, and falls back to the first order for one it does not know', () => {
    const { isSortId, sortRows } = kit();
    expect(isSortId('up')).toBe(true);
    expect(isSortId('sideways')).toBe(false);
    // A preference read off a browser that predates a rename must not render
    // an empty list — it renders the default order.
    expect(ids(sortRows(rows(['a', 3], ['b', 1]), 'sideways'))).toBe('ba');
  });

  it('never mutates the caller’s array', () => {
    const input = rows(['a', 3], ['b', 1]);
    kit().sortRows(input, 'up');
    expect(ids(input)).toBe('ab');
  });

  it('is stable — equal rows keep the order they arrived in', () => {
    const { sortRows } = kit();
    expect(ids(sortRows(rows(['a', 1], ['b', 1], ['c', 1]), 'up'))).toBe('abc');
    expect(ids(sortRows(rows(['c', 1], ['b', 1], ['a', 1]), 'up'))).toBe('cba');
  });

  it('floats the kit’s pinned class to the top of EVERY order', () => {
    const pinned = defineSorts<Row, 'up' | 'down'>(
      {
        up: { label: 'Smallest', compare: (a, b) => a.n - b.n },
        down: { label: 'Largest', compare: (a, b) => b.n - a.n },
      },
      { pin: (row) => row.live === true },
    );
    const list = rows(['a', 3], ['b', 1], ['c', 9, true]);
    expect(ids(pinned.sortRows(list, 'up'))).toBe('cba');
    expect(ids(pinned.sortRows(list, 'down'))).toBe('cab');
  });

  it('lets one order pin a different class, and a call override both', () => {
    const mixed = defineSorts<Row, 'up' | 'down'>(
      {
        up: { label: 'Smallest', compare: (a, b) => a.n - b.n },
        down: { label: 'Largest', compare: (a, b) => b.n - a.n, pin: (row) => row.id === 'a' },
      },
      { pin: (row) => row.live === true },
    );
    const list = rows(['a', 3], ['b', 1], ['c', 9, true]);
    expect(ids(mixed.sortRows(list, 'up'))).toBe('cba');
    // The spec's own pin wins over the kit's on the order that declares one.
    expect(ids(mixed.sortRows(list, 'down'))).toBe('acb');
    expect(ids(mixed.sortRows(list, 'up', { pin: (row) => row.id === 'b' }))).toBe('bac');
    // `false`, not `undefined`: turning a pin OFF has to be sayable.
    expect(ids(mixed.sortRows(list, 'up', { pin: false }))).toBe('bac');
  });
});

/* ------------------------------------------------------------------ *
 * defineFilters
 * ------------------------------------------------------------------ */

interface Doc {
  name: string;
  closed: boolean;
  repo: string;
}

const docs: Doc[] = [
  { name: 'cart api endpoint', closed: false, repo: 'web' },
  { name: 'billing rewrite', closed: true, repo: 'web' },
  { name: 'cart checkout', closed: false, repo: 'api' },
];

interface DocFilters extends Record<string, unknown> {
  query: string;
  showClosed: boolean;
  repo: string;
}

const docKit = (spy?: (value: string) => string[]) =>
  defineFilters<Doc, DocFilters>({
    query: {
      initial: '',
      prepare: spy ?? words,
      keep: (row, terms) => matchesWords(row.name, terms as string[]),
    },
    showClosed: {
      initial: false,
      // The trap: the RESTING value is `false` (a list opens on open work) and
      // the NO-OP value is `true`. Defaulting `inert` to "value === initial"
      // here would keep every closed row.
      inert: (value) => value === true,
      keep: (row) => !row.closed,
    },
    repo: { initial: '', keep: (row, value) => row.repo === value, counts: false },
  });

const names = (list: readonly Doc[]): string[] => list.map((d) => d.name);

describe('defineFilters', () => {
  it('builds NO_FILTERS from the resting values, frozen', () => {
    const { NO_FILTERS } = docKit();
    expect(NO_FILTERS).toEqual({ query: '', showClosed: false, repo: '' });
    expect(Object.isFrozen(NO_FILTERS)).toBe(true);
  });

  it('applies only the filters that are narrowing something', () => {
    const { NO_FILTERS, applyFilters } = docKit();
    // `showClosed: false` is the resting value AND narrows — the closed row goes.
    expect(names(applyFilters(docs, NO_FILTERS))).toEqual(['cart api endpoint', 'cart checkout']);
    expect(names(applyFilters(docs, { ...NO_FILTERS, showClosed: true }))).toHaveLength(3);
  });

  it('returns a copy, never the caller’s array, when nothing narrows', () => {
    const { applyFilters } = defineFilters<Doc, { repo: string }>({
      repo: { initial: '', keep: (row, value) => row.repo === value },
    });
    const out = applyFilters(docs, { repo: '' });
    expect(out).toEqual(docs);
    expect(out).not.toBe(docs);
  });

  it('prepares once per pass, not once per row', () => {
    const prepare = vi.fn((value: string) => words(value));
    const { NO_FILTERS, applyFilters } = docKit(prepare);
    applyFilters(docs, { ...NO_FILTERS, query: 'cart' });
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('matches every word, in any order, over the haystack the spec chose', () => {
    const { NO_FILTERS, applyFilters } = docKit();
    expect(names(applyFilters(docs, { ...NO_FILTERS, query: 'api cart' }))).toEqual(['cart api endpoint']);
    expect(names(applyFilters(docs, { ...NO_FILTERS, query: 'cart' }))).toHaveLength(2);
  });

  it('lets a predicate read a sibling field', () => {
    const kit = defineFilters<Doc, { repo: string; invert: boolean }>({
      repo: {
        initial: '',
        keep: (row, value, all) => (all.invert ? row.repo !== value : row.repo === value),
      },
      invert: { initial: false, inert: () => true, keep: () => true },
    });
    expect(names(kit.applyFilters(docs, { repo: 'api', invert: false }))).toEqual(['cart checkout']);
    expect(names(kit.applyFilters(docs, { repo: 'api', invert: true }))).toHaveLength(2);
  });

  it('counts what is away from resting, skipping the specs that opted out', () => {
    const { NO_FILTERS, activeCount } = docKit();
    expect(activeCount(NO_FILTERS)).toBe(0);
    expect(activeCount({ ...NO_FILTERS, query: 'cart' })).toBe(1);
    expect(activeCount({ ...NO_FILTERS, query: 'cart', showClosed: true })).toBe(2);
    // `counts: false` — a filter with no control on screen must not put a
    // number on the button that opens the controls.
    expect(activeCount({ ...NO_FILTERS, repo: 'web' })).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Parity with features/plans/model.ts
 * ------------------------------------------------------------------ */

const plan = (over: Partial<PlanRow> & Pick<PlanRow, 'slug'>): PlanRow => ({
  title: over.slug,
  kind: 'plan',
  status: 'active',
  isPlan: true,
  isComplete: false,
  isClosed: false,
  phases: 10,
  done: 0,
  percent: 0,
  readyPhases: [],
  inProgress: [],
  stuck: [],
  waiting: 0,
  qaFailures: [],
  remainingSessions: 0,
  repos: ['web'],
  handoffCount: 0,
  activity: 0,
  idleDays: 0,
  errors: 0,
  warnings: 0,
  needsYou: 0,
  ...over,
});

/** Every sort key distinct — see this file's header for why that matters. */
const PLANS: PlanRow[] = [
  plan({ slug: 'cart-api', title: 'Cart API', activity: 500, percent: 10, done: 1, readyPhases: [1] }),
  plan({
    slug: 'billing',
    title: 'Billing rewrite',
    activity: 400,
    percent: 40,
    done: 4,
    readyPhases: [2, 3],
    remainingSessions: 2,
    idleDays: 9,
    errors: 1,
    repos: ['api'],
  }),
  plan({
    slug: 'search-index',
    title: 'Search index',
    activity: 300,
    percent: 90,
    done: 9,
    readyPhases: [4, 5, 6],
    remainingSessions: 3,
    idleDays: 2,
    warnings: 2,
    status: 'complete',
    isComplete: true,
    isClosed: true,
    closedStatus: 'complete',
  }),
  plan({
    slug: 'notes',
    title: 'Notes',
    kind: 'document',
    isPlan: false,
    activity: 200,
    percent: 20,
    done: 2,
    idleDays: 5,
  }),
];

/**
 * A comparator derived from the shipped sorter — the oracle described in the
 * header. Two rows in, whichever the feature puts first wins.
 */
const oracle = (id: PlanSortId) => (a: PlanRow, b: PlanRow) => (planSortRows([a, b], id)[0] === a ? -1 : 1);

const planKit = defineSorts<PlanRow, PlanSortId>(
  Object.fromEntries(
    PLAN_SORTS.map((sort) => [
      sort.id,
      { label: sort.label, hint: sort.hint, blurb: sort.blurb, compare: oracle(sort.id) },
    ]),
  ) as unknown as Record<PlanSortId, SortSpec<PlanRow>>,
);

/**
 * `Filters` is a declared interface, so it has no index signature and does not
 * satisfy `Record<string, unknown>` — which the kit needs in order to hand a
 * predicate its siblings. The intersection is the whole adaptation, and it is
 * the same one a feature file will write when it migrates.
 */
type PlanFilterSet = PlanFilters & Record<string, unknown>;

const planFilterKit = defineFilters<PlanRow, PlanFilterSet>({
  query: {
    initial: '',
    keep: (row, value) => planMatches(row, value as string),
  },
  showDocuments: { initial: false, inert: (value) => value === true, keep: (row) => row.isPlan },
  showClosed: {
    initial: false,
    // Closure is answered by the status control when it holds a sentinel or a
    // named status, which is exactly the cross-field read `all` exists for.
    inert: (value) => value === true,
    keep: (row, _value, all) => !row.isClosed || all.status === CLOSED_ONLY || all.status === row.status,
  },
  repo: { initial: '', keep: (row, value) => row.repos.includes(value as string) },
  status: {
    initial: '',
    keep: (row, value) => {
      if (value === OPEN_ONLY) return !row.isClosed;
      if (value === CLOSED_ONLY) return row.isClosed;
      return row.status === value;
    },
  },
});

describe('parity with features/plans/model.ts', () => {
  it('offers the same orders, with the same words', () => {
    expect(planKit.SORTS).toEqual(PLAN_SORTS.map((s) => ({ ...s })));
  });

  it('guards ids the same way', () => {
    for (const id of ['activity', 'progress', 'ready', 'attention', 'name', '', 'nope']) {
      expect(planKit.isSortId(id)).toBe(planIsSortId(id));
    }
  });

  it('produces the same order for every sort the page offers', () => {
    for (const sort of PLAN_SORTS) {
      expect(
        planKit.sortRows(PLANS, sort.id).map((r) => r.slug),
        `order "${sort.id}" diverged`,
      ).toEqual(planSortRows(PLANS, sort.id).map((r) => r.slug));
    }
  });

  it('produces the same rows for every filter combination with a control', () => {
    const combos: PlanFilterSet[] = [];
    for (const query of ['', 'cart', 'search index'])
      for (const showDocuments of [false, true])
        for (const showClosed of [false, true])
          for (const repo of ['', 'web', 'api'])
            for (const status of ['', OPEN_ONLY, CLOSED_ONLY, 'active', 'complete'])
              combos.push({ query, showDocuments, showClosed, repo, status });

    for (const filters of combos) {
      expect(
        planFilterKit.applyFilters(PLANS, filters).map((r) => r.slug),
        `filters ${JSON.stringify(filters)} diverged`,
      ).toEqual(planApplyFilters(PLANS, filters).map((r) => r.slug));
    }
  });
});
