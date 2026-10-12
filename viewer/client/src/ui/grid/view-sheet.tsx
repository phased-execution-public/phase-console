import { ArrowDown, ArrowUp } from 'lucide-react';
import { useId } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '../button';
import { Checkbox } from '../checkbox';
import { Input } from '../input';
import { RadioGroup, RadioItem } from '../radio-group';
import { groupLabel } from './card-list';
import type { Column } from './column';
import type { Facet } from './engine';
import { canHide, type FilterValue } from './layout';
import type { GridView } from './view';

/**
 * The grid's view, as panels — one per slot of the toolbar grammar
 * (`ui/toolbar.tsx`): what to keep (filter), what to gather (group), the order
 * (sort) and what to show (the columns). Each is drawn once and shown twice: in
 * the slot's popover on a desk, as a section of the one View sheet on a phone.
 */

/** The row every choice sits on: a whole-width label, thumb-high on touch. */
const CHOICE =
  'flex min-h-8 min-w-0 cursor-pointer items-center gap-2 text-body text-ink [@media(hover:none)]:min-h-(--tap-min)';

/** What to keep: a field per extra text column, the facet values with their counts, a range's two ends. */
export function FilterPanel<T>({
  columns,
  view,
  facet,
  table,
}: {
  /** The filterable columns this panel offers — the toolbar's search column is not among them. */
  columns: Column<T>[];
  view: GridView;
  /** The engine's facets — absent until it has loaded, when the lists say so. */
  facet?: (columnId: string) => Facet;
  /** The grid's name, for the fields' accessible names. */
  table: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {columns.map((c) =>
        c.filter === 'text' ? (
          <TextFilter key={c.id} column={c} view={view} table={table} />
        ) : c.filter === 'facet' ? (
          <FacetFilter key={c.id} column={c} view={view} facet={facet?.(c.id)} />
        ) : (
          <RangeFilter key={c.id} column={c} view={view} facet={facet?.(c.id)} />
        ),
      )}
    </div>
  );
}

function TextFilter<T>({ column, view, table }: { column: Column<T>; view: GridView; table: string }) {
  const value = view.filters[column.id];
  return (
    <Input
      type="search"
      block
      aria-label={`Filter the ${table.toLowerCase()} by ${column.head.toLowerCase()}`}
      placeholder={`Filter by ${column.head.toLowerCase()}`}
      value={typeof value === 'string' ? value : ''}
      onChange={(event) => view.setFilter(column.id, event.target.value)}
    />
  );
}

function FacetFilter<T>({
  column,
  view,
  facet,
}: {
  column: Column<T>;
  view: GridView;
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
      <legend className="mb-1 text-meta text-ink-muted">{column.head}</legend>
      {values.length === 0 && <p className="text-meta text-ink-muted">No values yet.</p>}
      {values.map((v) => (
        <label key={v.value} className={CHOICE}>
          <Checkbox checked={chosen.includes(v.value)} onCheckedChange={() => toggle(v.value)} />
          <span className="min-w-0 flex-1 break-words">
            {column.groupLabel?.(v.value) ?? groupLabel(v.value)}
          </span>
          <span className="tnum text-meta text-ink-muted">{v.count}</span>
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
  view: GridView;
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
      <legend className="mb-1 text-meta text-ink-muted">{column.head}</legend>
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
        <span aria-hidden="true" className="text-meta text-ink-muted">
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

/** What to gather: no grouping, or one groupable column. */
export function GroupPanel<T>({
  columns,
  view,
  ungroupedLabel = 'None',
}: {
  columns: Column<T>[];
  view: GridView;
  ungroupedLabel?: string;
}) {
  const ids = useId();
  // Not the empty string: a radio's value has to be a word, and no column id
  // starts with two underscores.
  const NONE = '__none';
  return (
    <RadioGroup
      aria-label="Group by"
      value={view.groupBy ?? NONE}
      onValueChange={(value) => view.setGroupBy(value === NONE ? null : value)}
    >
      <RadioItem id={`${ids}-none`} value={NONE} label={ungroupedLabel} />
      {columns.map((c) => (
        <RadioItem key={c.id} id={`${ids}-${c.id}`} value={c.id} label={c.head} />
      ))}
    </RadioGroup>
  );
}

/**
 * The orders the columns offer, as buttons rather than radios: pressing the
 * order in force asks the page to reverse it — the `onSort(id)` the header
 * sends — and a radio cannot be pressed twice.
 */
export function SortPanel<T>({
  columns,
  activeSort,
  onSort,
}: {
  columns: Column<T>[];
  activeSort?: string;
  onSort: (id: string) => void;
}) {
  return (
    <div role="group" aria-label="Sort by" className="flex min-w-0 flex-wrap gap-1.5">
      {columns.map((c) => {
        const active = activeSort === c.sort!.id;
        const Arrow = c.sort!.dir === 'ascending' ? ArrowUp : ArrowDown;
        return (
          <Button key={c.id} aria-pressed={active} onClick={() => onSort(c.sort!.id)}>
            {c.head}
            <Arrow size={12} aria-hidden className={cn(!active && 'opacity-0')} />
          </Button>
        );
      })}
    </div>
  );
}

/**
 * What to show: a box per column the operator may hide, in this reading. A
 * hidden column folds into each row's detail; the columns Everything adds are
 * counted, so the essentials never pretend to be all there is.
 */
export function ColumnsPanel<T>({
  columns,
  view,
  withheld,
}: {
  /** The columns this reading draws. */
  columns: Column<T>[];
  view: GridView;
  /** How many columns only Everything draws. */
  withheld: number;
}) {
  const ids = useId();
  const hideable = columns.filter(canHide);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {hideable.length > 0 && (
        <div
          role="group"
          aria-label="Columns"
          aria-describedby={`${ids}-note`}
          className="flex min-w-0 flex-col gap-0.5"
        >
          {hideable.map((c) => (
            <label key={c.id} className={CHOICE}>
              <Checkbox
                checked={!view.hidden.includes(c.id)}
                onCheckedChange={(checked) => view.setHidden(c.id, checked !== true)}
              />
              {c.head}
            </label>
          ))}
        </div>
      )}
      <p id={`${ids}-note`} className="text-meta text-ink-muted">
        A hidden column stays in each row’s details.
        {withheld > 0 && ` Everything adds ${withheld} more column${withheld === 1 ? '' : 's'}.`}
      </p>
      <div>
        <Button variant="ghost" onClick={view.reset}>
          Reset view
        </Button>
      </div>
    </div>
  );
}
