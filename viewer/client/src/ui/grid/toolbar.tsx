import { Button } from '../button';
import type { Everything } from '../everything';
import { Toolbar, type ToolbarSlot, type ToolbarVerb } from '../toolbar';
import { searchColumnOf, type Column } from './column';
import type { Facet } from './engine';
import { canHide } from './layout';
import type { GridView } from './view';
import { ColumnsPanel, FilterPanel, GroupPanel, SortPanel } from './view-sheet';

/**
 * The grid's toolbar: the toolbar grammar (`ui/toolbar.tsx`) with its slots
 * filled from the grid's own column array and view.
 *
 *   search      the first `text` filter column — on the bar at every width;
 *   filter      the other filters: facets with their counts, ranges, text;
 *   group       the groupable columns, and none;
 *   sort        the page's own orders when it has them, else the columns';
 *   view        the columns the operator may hide in this reading;
 *   ⋯           the page's verbs;
 *   Everything  the page's switch.
 *
 * Under the bar, while a filter is in force, how many rows it left of how many
 * and the way to clear it — a narrowed list always says that it is narrowed,
 * because a filter nobody can see in force is how a record "goes missing".
 */
export function GridToolbar<T>({
  label,
  columns,
  offered,
  withheld,
  view,
  facet,
  shown,
  total,
  activeSort,
  onSort,
  sort,
  more,
  everything,
  ungroupedLabel,
  placeholder,
}: {
  label: string;
  /** Every column the grid declares. */
  columns: readonly Column<T>[];
  /** The columns this reading draws (Everything's, or the essentials). */
  offered: Column<T>[];
  /** How many columns only Everything draws. */
  withheld: number;
  view: GridView;
  facet?: (columnId: string) => Facet;
  shown?: number;
  total?: number;
  activeSort?: string;
  onSort?: (id: string) => void;
  /** The page's own orders, when they are not the columns'. */
  sort?: ToolbarSlot;
  more?: readonly ToolbarVerb[];
  everything?: Everything;
  ungroupedLabel?: string;
  /** The page's hint for the search box (`GridToolbarOptions.placeholder`). */
  placeholder?: string;
}) {
  const search = searchColumnOf(columns);
  const searchValue = search ? view.filters[search.id] : undefined;
  const filterable = columns.filter((c) => c.filter && c.value && c !== search);
  const groupable = columns.filter((c) => c.groupable && c.value);
  const sortable = columns.filter((c) => c.sort);
  const narrowing = Object.keys(view.filters).filter((id) => id !== search?.id).length;
  const filtering = Object.keys(view.filters).length > 0;
  const grouped = groupable.find((c) => c.id === view.groupBy);
  const ordered = sortable.find((c) => c.sort!.id === activeSort);

  const sortSlot: ToolbarSlot | undefined =
    sort ??
    (sortable.length && onSort
      ? {
          ...(ordered ? { value: ordered.head } : {}),
          panel: <SortPanel columns={sortable} {...(activeSort ? { activeSort } : {})} onSort={onSort} />,
        }
      : undefined);

  return (
    <Toolbar
      label={label}
      {...(search
        ? {
            search: {
              value: typeof searchValue === 'string' ? searchValue : '',
              onChange: (value: string) => view.setFilter(search.id, value),
              placeholder: placeholder ?? `Search by ${search.head.toLowerCase()}`,
              label: `Search the ${label.toLowerCase()} by ${search.head.toLowerCase()}`,
            },
          }
        : {})}
      {...(filterable.length
        ? {
            filter: {
              active: narrowing,
              panel: (
                <FilterPanel columns={filterable} view={view} table={label} {...(facet ? { facet } : {})} />
              ),
            },
          }
        : {})}
      {...(groupable.length
        ? {
            group: {
              ...(grouped ? { value: grouped.head } : {}),
              active: grouped ? 1 : 0,
              panel: (
                <GroupPanel columns={groupable} view={view} {...(ungroupedLabel ? { ungroupedLabel } : {})} />
              ),
            },
          }
        : {})}
      {...(sortSlot ? { sort: sortSlot } : {})}
      {...(offered.some(canHide) || withheld > 0
        ? {
            view: {
              label: 'Columns',
              active: view.hidden.length,
              panel: <ColumnsPanel columns={offered} view={view} withheld={withheld} />,
            },
          }
        : {})}
      {...(more?.length ? { more } : {})}
      {...(everything ? { everything } : {})}
      note={
        filtering && shown !== undefined && total !== undefined ? (
          <>
            <span className="tnum" aria-live="polite">{`${shown} of ${total} shown`}</span>
            <Button size="sm" variant="ghost" onClick={view.clearFilters}>
              Clear filters
            </Button>
          </>
        ) : undefined
      }
    />
  );
}

/** A verb the selection bar offers over the picked rows. */
export interface BulkVerb<T> {
  id: string;
  /** What the button says — the verb itself ("Close issues"), never "Apply". */
  label: string;
  onRun: (rows: T[]) => void;
  tone?: 'default' | 'danger';
}

/**
 * The selection's bar: how many rows are picked, the grid's verbs over exactly
 * those, and a way to let go of them. It exists only while something is picked
 * — a bar of verbs over nothing is a bar of disabled buttons.
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
      className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg bg-surface-raised px-(--tile-pad-x) py-2"
    >
      <span className="tnum text-body font-medium text-ink" aria-live="polite">{`${count} selected`}</span>
      {verbs.map((verb) => (
        <Button
          key={verb.id}
          variant={verb.tone === 'danger' ? 'danger' : 'default'}
          onClick={() => verb.onRun(rows)}
        >
          {verb.label}
        </Button>
      ))}
      <Button variant="ghost" onClick={onClear}>
        Clear selection
      </Button>
    </div>
  );
}
