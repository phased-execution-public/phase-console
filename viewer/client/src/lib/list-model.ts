/**
 * The mechanics every list model re-implements — sorting, pinning, filtering.
 *
 * Plans, Runs and Now each grew a model file with the same five shapes in it:
 * a `SORTS` array of `{id, label, hint, blurb}`, an `isSortId` guard over it, a
 * `COMPARE` record keyed by that id, a `sortRows` that copies-then-sorts with a
 * pinned class partitioned to the top, and a `Filters` interface with a
 * `NO_FILTERS` constant and an `applyFilters`. Roughly seventy per cent of
 * those three files was the same code with three vocabularies in it.
 *
 * ## What is shared, and what is emphatically not
 *
 * Shared is the MECHANISM. Not shared is the VOCABULARY: which orders exist,
 * what each one leads with, which rows are pinned, what a filter means. Every
 * one of those is a claim about the domain, and this file must never learn what
 * a plan or a run is — the same split `components/toolbar.tsx` makes for the
 * controls that drive these.
 *
 * ## The two things the copies each got right once
 *
 *  1. **Pinning is not a comparator.** Runs pin live rows and Now pins
 *     unclaimed ones, in EVERY order — "whatever you sorted by, the thing
 *     spending money on your behalf is the row you came to see". Folding that
 *     into each comparator means five places to forget it; here it is one
 *     partition applied before the chosen order.
 *  2. **The sort is stable, and that is load-bearing.** `Array#sort` has been
 *     stable since ES2019, so rows the comparator calls equal keep the order
 *     they arrived in — which is what makes a re-sort after a live update not
 *     reshuffle the rows it did not move.
 */

/* ------------------------------------------------------------------ *
 * Sorting
 * ------------------------------------------------------------------ */

/** One order: what it is called, what it leads with, and how it compares. */
export interface SortSpec<Row> {
  /** The word on the control. */
  label: string;
  /** The short gloss on the button itself (a `title`). */
  hint?: string;
  /** The sentence under the toolbar once it is the chosen order. */
  blurb?: string;
  compare: (a: Row, b: Row) => number;
  /**
   * Pinned to the top of THIS order only.
   *
   * Rare — a pin is nearly always a property of the list rather than of one
   * ordering, which is what `options.pin` is for. Set here only when one order
   * genuinely wants a different class on top.
   */
  pin?: (row: Row) => boolean;
}

/** One entry in a sort control, in the shape `components/toolbar.tsx` wants. */
export interface SortOptionOf<Id extends string> {
  id: Id;
  label: string;
  hint?: string;
  blurb?: string;
}

export interface SortKit<Row, Id extends string> {
  /** The control's own list, in the order the specs were declared. */
  SORTS: readonly SortOptionOf<Id>[];
  /** Is this stored string still an order this list offers? */
  isSortId: (value: string) => value is Id;
  /**
   * A new array in the chosen order, pinned class first.
   *
   * An id this kit does not know falls back to the first spec declared, which
   * is why declaration order is the default order: a preference read off a
   * browser that predates an order being renamed must not render an empty list.
   */
  sortRows: (rows: readonly Row[], by: Id | string, options?: SortCallOptions<Row>) => Row[];
}

export interface SortCallOptions<Row> {
  /**
   * Override the kit's pin for this call — a predicate, or `false` for none.
   *
   * The case this exists for: the same rows drawn twice on one page, where one
   * of the two is already the pinned set and pinning inside it says nothing.
   */
  pin?: ((row: Row) => boolean) | false;
}

export interface SortKitOptions<Row> {
  /**
   * The class that floats to the top of every order.
   *
   * Runs pass `row.live`, Now passes "not claimed by another session". Both are
   * statements about the LIST — the row you came to see, and the row that is
   * somebody else's move — rather than about any one ordering.
   */
  pin?: (row: Row) => boolean;
}

/**
 * Build a list's orders from a record of specs.
 *
 * The record's keys ARE the ids, so the union is inferred and the comparator
 * table is total against it by construction — the shape the three feature files
 * each built by hand out of an `as const` array plus a `Record<SortId, …>` that
 * had to be kept in step with it.
 */
export function defineSorts<Row, Id extends string>(
  specs: Record<Id, SortSpec<Row>>,
  options: SortKitOptions<Row> = {},
): SortKit<Row, Id> {
  const ids = Object.keys(specs) as Id[];
  const first = ids[0];

  const SORTS: readonly SortOptionOf<Id>[] = ids.map((id) => {
    const spec = specs[id];
    return {
      id,
      label: spec.label,
      ...(spec.hint == null ? {} : { hint: spec.hint }),
      ...(spec.blurb == null ? {} : { blurb: spec.blurb }),
    };
  });

  const isSortId = (value: string): value is Id => Object.hasOwn(specs, value);

  const sortRows = (rows: readonly Row[], by: Id | string, call: SortCallOptions<Row> = {}): Row[] => {
    const spec = specs[(isSortId(by) ? by : first) as Id];
    const pin = call.pin === false ? undefined : (call.pin ?? spec.pin ?? options.pin);
    const compare = spec.compare;
    // One copy, one sort. `Number(pin(b)) - Number(pin(a))` puts the pinned
    // class first without a second pass over the array.
    return [...rows].sort(pin ? (a, b) => Number(pin(b)) - Number(pin(a)) || compare(a, b) : compare);
  };

  return { SORTS, isSortId, sortRows };
}

/* ------------------------------------------------------------------ *
 * Filtering
 * ------------------------------------------------------------------ */

/**
 * One filter: its resting value, when it narrows nothing, and what it keeps.
 *
 * `Prepared` is the one performance-shaped hook, and it exists because two of
 * the three models filter on free text: `query.toLowerCase().split(/\s+/)` per
 * ROW is the same work several hundred times per keystroke. `prepare` runs once
 * per pass and `keep` receives its result.
 */
/*
 * ⚠️ The three callables below are METHOD signatures, not function properties,
 * and that is deliberate: TypeScript checks a method's parameters bivariantly.
 * `specs` is a heterogeneous record — one filter prepares a `string[]`, the
 * next never prepares at all — so the mapped type has to accept each spec at
 * `Prepared = unknown`, which a contravariant `(value: Prepared) => boolean`
 * would refuse. Written as arrow properties, every `prepare` in the codebase
 * stops typechecking.
 */
export interface FilterSpec<Row, Value, Prepared = Value> {
  /**
   * What `NO_FILTERS` holds, and what `activeCount` measures against.
   *
   * Deliberately separate from `inert` below: a toggle whose default is *off*
   * and whose *on* position is the one that narrows nothing (plans' "show
   * closed") has a resting value that is not its no-op value, and conflating
   * the two is how "hide closed plans" became "hide nothing".
   */
  initial: Value;
  /**
   * True when this filter narrows nothing and the pass can skip it entirely.
   * Defaults to "the value is the resting one".
   */
  inert?(value: Value): boolean;
  /** Run once per pass. Hoist anything a per-row `keep` would redo. */
  prepare?(value: Value): Prepared;
  /**
   * True to KEEP the row. Receives the whole filter set, because a predicate
   * sometimes depends on a sibling — plans' status sentinels decide what
   * "closed" means for the closed toggle beside them.
   */
  keep(row: Row, value: Prepared, all: Readonly<Record<string, unknown>>): boolean;
  /**
   * Whether a non-resting value counts as a filter the operator has set — the
   * number on the phone's Sort button. Default true. Off for a control that
   * has no UI, or one that is a VIEW rather than a filter.
   */
  counts?: boolean;
}

export interface FilterKit<Row, F> {
  /** Everything, to start with. Frozen: it is a shared constant, not a draft. */
  NO_FILTERS: F;
  applyFilters: (rows: readonly Row[], filters: F) => Row[];
  /** How many filters are away from their resting value. */
  activeCount: (filters: F) => number;
}

/**
 * Build a list's filter set from a record of predicates.
 *
 * The record's keys are the `Filters` field names, so the interface the feature
 * declares and the predicates that implement it cannot drift apart — the copies
 * this replaces each had an `interface Filters`, a `NO_FILTERS` and an
 * `applyFilters` that agreed only by inspection.
 */
export function defineFilters<Row, F extends Record<string, unknown>>(specs: {
  [K in keyof F]: FilterSpec<Row, F[K], unknown>;
}): FilterKit<Row, F> {
  const names = Object.keys(specs) as (keyof F & string)[];

  const NO_FILTERS = Object.freeze(Object.fromEntries(names.map((name) => [name, specs[name].initial]))) as F;

  /** The specs that will actually run this pass, with their per-pass values. */
  const live = (filters: F) => {
    const out: { keep: FilterSpec<Row, unknown, unknown>['keep']; value: unknown }[] = [];
    for (const name of names) {
      const spec = specs[name] as FilterSpec<Row, unknown, unknown>;
      const value = filters[name];
      const skip = spec.inert ? spec.inert(value) : value === spec.initial;
      if (skip) continue;
      out.push({ keep: spec.keep, value: spec.prepare ? spec.prepare(value) : value });
    }
    return out;
  };

  const applyFilters = (rows: readonly Row[], filters: F): Row[] => {
    const active = live(filters);
    if (!active.length) return [...rows];
    return rows.filter((row) => active.every(({ keep, value }) => keep(row, value, filters)));
  };

  const activeCount = (filters: F): number => {
    let n = 0;
    for (const name of names) {
      const spec = specs[name];
      if (spec.counts === false) continue;
      if (filters[name] !== spec.initial) n++;
    }
    return n;
  };

  return { NO_FILTERS, applyFilters, activeCount };
}

/* ------------------------------------------------------------------ *
 * The two predicates every list wanted
 * ------------------------------------------------------------------ */

/**
 * `cart api` finds `cart-api-endpoint`.
 *
 * Words rather than a substring, because slugs are hyphenated and titles are
 * prose, so the thing you remember is rarely contiguous in either. Both list
 * models had this, spelled the same way, over different haystacks.
 */
export const words = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

/** Every word must match, in any order. Pair with `prepare: words`. */
export const matchesWords = (haystack: string, terms: readonly string[]): boolean => {
  if (!terms.length) return true;
  const hay = haystack.toLowerCase();
  return terms.every((word) => hay.includes(word));
};
