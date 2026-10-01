import { useId } from 'react';
import { Button, CountBadge, Input, Sheet, SheetContent, SheetTrigger } from '@/components/ui';
import type { BulkVerb, TableView } from './data-table';
import type { Facet } from './engine';
import { groupLabel } from './card-list';
import { canHide, type Column, type FilterValue } from './layout';

/**
 * The grid's controls: the filters, the View sheet, and the selection's bar.
 *
 * ## One control, then everything else
 *
 * A table's view has four kinds of setting — what to keep (filters), what to
 * gather (grouping), what to show (columns) and what to act on (selection) —
 * and a toolbar that drew a control for each would be louder than the table
 * it serves. So the desk shows the one setting people reach for most, typing
 * to narrow the rows, and ONE "View" button that opens a sheet with the rest.
 * A phone has no room for even the text box, so there the View sheet holds
 * everything and the toolbar is that button and a count.
 *
 * The button carries how many settings are in use, and the line beside it how
 * many rows are shown of how many there are, so a narrowed table always says
 * that it is narrowed — a filter nobody can see is in force is how a record
 * "goes missing".
 */

/** How many of this view's settings are in force — the number on the View button. */
const inForce = (view: TableView): number =>
  Object.keys(view.filters).length + view.hidden.length + (view.groupBy ? 1 : 0);

export function Toolbar<T>({
  label,
  columns,
  view,
  phone,
  facet,
  shown,
  total,
  ungroupedLabel,
}: {
  label: string;
  columns: Column<T>[];
  view: TableView;
  /** The card list's width: every control moves into the sheet. */
  phone: boolean;
  /** What "no grouping" is called here — `None` unless the table knows better. */
  ungroupedLabel?: string;
  /** The engine's facets — absent until it has loaded, when the lists are empty. */
  facet?: (columnId: string) => Facet;
  shown?: number;
  total?: number;
}) {
  const texts = columns.filter((c) => c.filter === 'text' && c.value);
  const active = inForce(view);
  const filtering = Object.keys(view.filters).length > 0;
  const clearFilters = () => {
    for (const id of Object.keys(view.filters)) view.setFilter(id, null);
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {!phone &&
        texts.map((c) => (
          <TextFilter key={c.id} column={c} table={label} view={view} className="w-56 max-w-full" />
        ))}
      <Sheet>
        <SheetTrigger asChild>
          <Button size="sm">
            View
            <CountBadge count={active} label={`setting${active === 1 ? '' : 's'} in use`} />
          </Button>
        </SheetTrigger>
        <SheetContent
          title="View"
          showTitle
          side={phone ? 'bottom' : 'right'}
          description={`What to show in the ${label.toLowerCase()}, and how.`}
        >
          <ViewPanel
            label={label}
            columns={columns}
            view={view}
            withText={phone}
            {...(ungroupedLabel ? { ungroupedLabel } : {})}
            {...(facet ? { facet } : {})}
          />
        </SheetContent>
      </Sheet>
      {filtering && shown !== undefined && total !== undefined && (
        <span className="text-xs text-ink-muted tabular-nums" aria-live="polite">
          {`${shown} of ${total} shown`}
        </span>
      )}
      {filtering && (
        <Button size="sm" variant="ghost" onClick={clearFilters}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

function TextFilter<T>({
  column,
  table,
  view,
  className,
}: {
  column: Column<T>;
  table: string;
  view: TableView;
  className?: string;
}) {
  const value = view.filters[column.id];
  return (
    <Input
      type="search"
      aria-label={`Filter ${table.toLowerCase()} by ${column.head.toLowerCase()}`}
      placeholder={`Filter by ${column.head.toLowerCase()}`}
      value={typeof value === 'string' ? value : ''}
      onChange={(event) => view.setFilter(column.id, event.target.value)}
      className={className}
    />
  );
}

/** A heading for one of the sheet's sections, and the id that names its group. */
function SectionTitle({ id, children }: { id: string; children: string }) {
  return (
    <h3 id={id} className="text-sm font-medium text-ink">
      {children}
    </h3>
  );
}

/** The row every choice in the sheet sits on: a whole-width label, a thumb high on touch. */
const CHOICE =
  'flex min-h-(--tap-min) min-w-0 cursor-pointer items-center gap-2 text-sm [@media(hover:hover)]:min-h-8';

function ViewPanel<T>({
  label,
  columns,
  view,
  withText,
  facet,
  ungroupedLabel = 'None',
}: {
  label: string;
  columns: Column<T>[];
  view: TableView;
  withText: boolean;
  facet?: (columnId: string) => Facet;
  ungroupedLabel?: string;
}) {
  const ids = useId();
  // The text filters first, where the desk's toolbar puts its box: on a phone
  // the sheet holds the only one, and in column order it came after every
  // facet value. The sort is stable, so the rest keep the columns' order.
  const filtered = columns
    .filter((c) => c.filter && c.value && (withText || c.filter !== 'text'))
    .sort((a, b) => Number(b.filter === 'text') - Number(a.filter === 'text'));
  const groupable = columns.filter((c) => c.groupable && c.value);
  const hideable = columns.filter(canHide);

  return (
    <div className="flex flex-col gap-5 p-3">
      {filtered.length > 0 && (
        <section aria-labelledby={`${ids}-filter`} className="flex flex-col gap-3">
          <SectionTitle id={`${ids}-filter`}>Filter</SectionTitle>
          {filtered.map((c) =>
            c.filter === 'text' ? (
              <TextFilter key={c.id} column={c} table={label} view={view} className="w-full" />
            ) : c.filter === 'facet' ? (
              <FacetFilter key={c.id} column={c} view={view} facet={facet?.(c.id)} />
            ) : (
              <RangeFilter key={c.id} column={c} view={view} facet={facet?.(c.id)} />
            ),
          )}
        </section>
      )}

      {groupable.length > 0 && (
        <div role="radiogroup" aria-labelledby={`${ids}-group`} className="flex flex-col gap-1">
          <SectionTitle id={`${ids}-group`}>Group by</SectionTitle>
          {[null, ...groupable].map((c) => (
            <label key={c?.id ?? 'none'} className={CHOICE}>
              <input
                type="radio"
                name={`${ids}-group`}
                checked={view.groupBy === (c?.id ?? null)}
                onChange={() => view.setGroupBy(c?.id ?? null)}
                className="size-4 accent-[var(--accent)]"
              />
              {c ? c.head : ungroupedLabel}
            </label>
          ))}
        </div>
      )}

      {hideable.length > 0 && (
        <div
          role="group"
          aria-labelledby={`${ids}-columns`}
          aria-describedby={`${ids}-columns-note`}
          className="flex flex-col gap-1"
        >
          <SectionTitle id={`${ids}-columns`}>Columns</SectionTitle>
          <p id={`${ids}-columns-note`} className="text-xs text-ink-muted">
            A hidden column is still in each row’s detail.
          </p>
          {hideable.map((c) => (
            <label key={c.id} className={CHOICE}>
              <input
                type="checkbox"
                checked={!view.hidden.includes(c.id)}
                onChange={(event) => view.setHidden(c.id, !event.target.checked)}
                className="size-4 accent-[var(--accent)]"
              />
              {c.head}
            </label>
          ))}
        </div>
      )}

      <div>
        <Button size="sm" variant="ghost" onClick={view.reset}>
          Reset view
        </Button>
      </div>
    </div>
  );
}

function FacetFilter<T>({
  column,
  view,
  facet,
}: {
  column: Column<T>;
  view: TableView;
  facet: Facet | undefined;
}) {
  const kept = view.filters[column.id];
  const chosen = Array.isArray(kept) ? (kept as string[]) : [];
  // A value the operator kept is listed even when no row carries it under the
  // OTHER filters — otherwise it could not be un-ticked.
  const values = [...(facet?.values ?? [])];
  for (const value of chosen) if (!values.some((v) => v.value === value)) values.push({ value, count: 0 });
  const toggle = (value: string) =>
    view.setFilter(
      column.id,
      chosen.includes(value) ? chosen.filter((v) => v !== value) : [...chosen, value],
    );
  return (
    <fieldset className="flex min-w-0 flex-col gap-1">
      <legend className="mb-1 text-xs text-ink-muted">{column.head}</legend>
      {values.length === 0 && <p className="text-xs text-ink-faint">No values yet.</p>}
      {values.map((v) => (
        <label key={v.value} className={CHOICE}>
          <input
            type="checkbox"
            checked={chosen.includes(v.value)}
            onChange={() => toggle(v.value)}
            className="size-4 accent-[var(--accent)]"
          />
          <span className="min-w-0 flex-1 break-words">{groupLabel(v.value)}</span>
          <span className="font-mono text-xs text-ink-faint tabular-nums">{v.count}</span>
        </label>
      ))}
    </fieldset>
  );
}

function RangeFilter<T>({
  column,
  view,
  facet,
}: {
  column: Column<T>;
  view: TableView;
  facet: Facet | undefined;
}) {
  const kept = view.filters[column.id];
  const [min, max] =
    Array.isArray(kept) && kept.length === 2 && typeof kept[0] !== 'string'
      ? (kept as [number | null, number | null])
      : [null, null];
  const parse = (text: string): number | null => {
    if (text.trim() === '') return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  };
  const set = (next: FilterValue) => view.setFilter(column.id, next);
  const span = facet?.range;
  return (
    <fieldset className="flex min-w-0 flex-col gap-1">
      <legend className="mb-1 text-xs text-ink-muted">{column.head}</legend>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Input
          type="number"
          inputMode="decimal"
          aria-label={`${column.head} from`}
          placeholder={span ? String(span[0]) : 'From'}
          value={min ?? ''}
          onChange={(event) => set([parse(event.target.value), max])}
          className="w-28"
        />
        <span aria-hidden="true" className="text-xs text-ink-faint">
          to
        </span>
        <Input
          type="number"
          inputMode="decimal"
          aria-label={`${column.head} to`}
          placeholder={span ? String(span[1]) : 'To'}
          value={max ?? ''}
          onChange={(event) => set([min, parse(event.target.value)])}
          className="w-28"
        />
      </div>
    </fieldset>
  );
}

/**
 * The selection's bar: how many rows are picked, the table's verbs over
 * exactly those, and a way to let go of them. It exists only while something
 * is picked — a bar of verbs over nothing is a bar of disabled buttons.
 */
export function BulkBar<T>({
  count,
  verbs,
  rows,
  onClear,
}: {
  count: number;
  verbs: BulkVerb<T>[];
  rows: T[];
  onClear: () => void;
}) {
  return (
    <div
      role="region"
      aria-label="Selected rows"
      className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-rule bg-surface-raised px-(--tile-pad-x) py-2"
    >
      <span className="text-sm font-medium tabular-nums" aria-live="polite">{`${count} selected`}</span>
      {verbs.map((verb) => (
        <Button
          key={verb.id}
          size="sm"
          variant={verb.tone === 'danger' ? 'danger' : 'default'}
          onClick={() => verb.onRun(rows)}
        >
          {verb.label}
        </Button>
      ))}
      <Button size="sm" variant="ghost" onClick={onClear}>
        Clear selection
      </Button>
    </div>
  );
}
