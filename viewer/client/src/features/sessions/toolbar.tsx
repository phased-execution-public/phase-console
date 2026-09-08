/**
 * How the sessions list is searched, filtered and ordered.
 *
 * The mechanism is `components/toolbar.tsx` — the same strip Plans and Runs
 * use, so a person who has learned one control has learned all three. What is
 * here is the vocabulary of a SESSION: the four kinds as chips, the two clocks
 * as orders, and the grouping toggle.
 *
 * The kind chips stay visible in both shapes, for the fleet's reason: they
 * carry their own counts, so the row is simultaneously the filter and the only
 * summary of what this machine is running — three lanes, one shell, nine
 * `claude` processes nobody here started. Folding that into a sheet would hide
 * the answer inside the control.
 */

import { Button } from '@/components/ui';
import { Toolbar, ToolbarSorts, type ToolbarShape } from '@/components/toolbar';
import { cn } from '@/lib/cn';
import { SESSION_GROUPS, type SessionGroupKind } from './list';
import { SORTS, type Filters, type SortId } from './model';

export interface ControlsProps {
  sortId: SortId;
  onSort: (id: SortId) => void;
  filters: Filters;
  onFilters: (patch: Partial<Filters>) => void;
  grouped: boolean;
  onGrouped: (value: boolean) => void;
  counts: Record<SessionGroupKind, number>;
  /** How many rows the filters are hiding right now — never a silent cut. */
  hidden: number;
}

/** A kind with nothing in it is not a filter, it is a dead button. */
function KindChips({
  counts,
  value,
  onChange,
}: {
  counts: Record<SessionGroupKind, number>;
  value: string;
  onChange: (value: string) => void;
}) {
  const live = SESSION_GROUPS.filter((group) => counts[group.kind] > 0);
  if (live.length < 2) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {/* Never amber, even when it is the one selected: showing everything is
          the resting state, and amber is reserved for a view you have
          narrowed. `aria-pressed` carries it for anyone who cannot see which
          chips are lit. */}
      <Button size="sm" aria-pressed={value === ''} onClick={() => onChange('')}>
        Everything
      </Button>
      {live.map((group) => (
        <Button
          key={group.kind}
          size="sm"
          variant={value === group.kind ? 'action' : 'default'}
          aria-pressed={value === group.kind}
          onClick={() => onChange(value === group.kind ? '' : group.kind)}
          title={group.blurb}
          // Spelled out rather than left to the text nodes: the word and the
          // count are separate elements, so the computed name would run them
          // together as "Shells2" and read as something else entirely.
          aria-label={`${group.title}, ${counts[group.kind]}`}
        >
          {group.short}
          <span className="font-mono text-2xs tabular-nums opacity-70">{counts[group.kind]}</span>
        </Button>
      ))}
    </div>
  );
}

function GroupToggle({
  grouped,
  onGrouped,
  shape,
}: Pick<ControlsProps, 'grouped' | 'onGrouped'> & { shape: ToolbarShape }) {
  const stacked = shape === 'sheet';
  return (
    <div className={cn('flex gap-2', stacked ? 'flex-col' : 'flex-wrap items-center')}>
      <Button
        size="sm"
        variant={grouped ? 'action' : 'default'}
        aria-pressed={grouped}
        onClick={() => onGrouped(!grouped)}
        title="Sections per kind. Off is one list in the chosen order — which is what makes an order over the whole list mean anything."
        className={stacked ? 'self-start' : undefined}
      >
        Group by kind
      </Button>
    </div>
  );
}

export function Controls(props: ControlsProps) {
  const order = SORTS.find((sort) => sort.id === props.sortId);
  const body = (shape: ToolbarShape) =>
    shape === 'sheet' ? (
      <>
        <p className="mb-2 text-2xs uppercase tracking-wide text-ink-faint">Order by</p>
        <ToolbarSorts sorts={SORTS} value={props.sortId} onSort={props.onSort} shape="sheet" />
        <hr className="my-3 border-rule" />
        <p className="mb-2 text-2xs uppercase tracking-wide text-ink-faint">Show</p>
        <GroupToggle {...props} shape="sheet" />
      </>
    ) : (
      <>
        <ToolbarSorts sorts={SORTS} value={props.sortId} onSort={props.onSort} shape="inline" />
        <GroupToggle {...props} shape="inline" />
      </>
    );

  return (
    <Toolbar
      search={{
        value: props.filters.query,
        onChange: (query) => props.onFilters({ query }),
        placeholder: 'Name, directory or id',
        label: 'Find a session by name, directory or id',
      }}
      chips={
        <KindChips
          counts={props.counts}
          value={props.filters.kind}
          onChange={(kind) => props.onFilters({ kind })}
        />
      }
      activeCount={Number(Boolean(props.filters.kind)) + Number(Boolean(props.filters.query))}
      sheetTitle="Sort and filter the sessions"
      note={
        [props.hidden > 0 ? `${props.hidden} hidden by filters` : null, !props.grouped ? order?.blurb : null]
          .filter(Boolean)
          .join(' · ') || undefined
      }
    >
      {body}
    </Toolbar>
  );
}
