/**
 * The plans' toolbar — the one grammar (design.md principle 8): search ·
 * filter · group · sort · view · ⋯ · Everything, and below 900 the same words
 * in one View sheet. The mechanism is `ui/toolbar.tsx`; what is here is the
 * plans' own vocabulary: the repository and the status, whether closed plans
 * and documents join the list or wait folded under it, the three groupings,
 * the five orders and the two views.
 *
 * The order, the grouping and the view persist (`prefs.sort`, `plansGroup`,
 * `plansLayout` — the 6.x keys, reused); the two include switches persist as
 * well (`showClosed`, `showDocuments`), because they are the shape of the
 * page, not a search. The repository, the status and the text are per visit:
 * a hidden row that survives a reload is how a plan goes missing for a week.
 */

import { useId } from 'react';
import { describeWord } from '@shared/status-model.js';
import { plural } from '@/lib/format';
import { Button, ButtonGroup, type Everything } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import { NativeSelect } from '@/ui/native-select';
import { RadioGroup, RadioItem } from '@/ui/radio-group';
import { Toolbar, type ToolbarVerb } from '@/ui/toolbar';
import {
  CLOSED_ONLY,
  OPEN_ONLY,
  PLAN_GROUPS,
  SORTS,
  activeCount,
  type Filters,
  type GroupBy,
  type HiddenBreakdown,
  type PlansLayout,
  type SortId,
} from './model';

export interface PlansToolbarProps {
  filters: Filters;
  onFilters: (patch: Partial<Filters>) => void;
  sort: SortId;
  onSort: (id: SortId) => void;
  group: GroupBy;
  onGroup: (group: GroupBy) => void;
  layout: PlansLayout;
  onLayout: (layout: PlansLayout) => void;
  everything: Everything;
  repos: readonly string[];
  statuses: readonly string[];
  hiddenBy: HiddenBreakdown;
  /** How many rows the list draws now. */
  shown: number;
  /** Put every filter back to where the page opens. */
  onClear: () => void;
}

/** What the status control says for a stored word — the status model's label, or the word itself. */
const statusLabel = (status: string): string => {
  const view = describeWord('plan', status);
  return view.known ? view.label : status;
};

function FilterPanel({ filters, onFilters, repos, statuses, hiddenBy }: PlansToolbarProps) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="plans-filter">
      {(repos.length > 1 || filters.repo) && (
        <label className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
          Repository
          <NativeSelect
            value={filters.repo}
            onChange={(event) => onFilters({ repo: event.target.value })}
            className="w-full max-w-none"
            data-testid="plans-filter-repo"
          >
            <option value="">Any repository</option>
            {repos.map((repo) => (
              <option key={repo} value={repo}>
                {repo}
              </option>
            ))}
          </NativeSelect>
        </label>
      )}
      <label className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
        Status
        <NativeSelect
          value={filters.status}
          onChange={(event) => onFilters({ status: event.target.value })}
          className="w-full max-w-none"
          data-testid="plans-filter-status"
        >
          <option value="">Any status</option>
          {/* "Closed" is three statuses, so no one of them says it. */}
          <optgroup label="Open or closed">
            <option value={OPEN_ONLY}>Open plans only</option>
            <option value={CLOSED_ONLY}>Closed plans only</option>
          </optgroup>
          <optgroup label="By status">
            {statuses.map((status) => (
              <option key={status} value={status}>
                {statusLabel(status)}
              </option>
            ))}
          </optgroup>
        </NativeSelect>
      </label>
      <div className="flex min-w-0 flex-col gap-2">
        <IncludeSwitch
          id={`${id}-closed`}
          checked={filters.showClosed}
          onChange={(showClosed) => onFilters({ showClosed })}
          label="Closed plans in the list"
          gain={filters.showClosed ? 0 : hiddenBy.closed}
          hint="Otherwise folded under it."
        />
        <IncludeSwitch
          id={`${id}-documents`}
          checked={filters.showDocuments}
          onChange={(showDocuments) => onFilters({ showDocuments })}
          label="Documents in the list"
          gain={filters.showDocuments ? 0 : hiddenBy.documents}
          hint="A document has no phases to run."
        />
      </div>
    </div>
  );
}

/** One include switch, saying what turning it on brings into the list. */
function IncludeSwitch({
  id,
  checked,
  onChange,
  label,
  gain,
  hint,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  /** How many rows turning it on brings into the list — in the accessible name too. */
  gain: number;
  hint: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
        aria-describedby={`${id}-hint`}
        className="mt-0.5"
      />
      <label htmlFor={id} className="min-w-0 text-body text-ink">
        {label}
        {gain > 0 && <span className="tnum text-ink-muted"> ({gain} more)</span>}
        <span id={`${id}-hint`} className="block text-meta text-ink-muted">
          {hint}
        </span>
      </label>
    </div>
  );
}

function Choices<V extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: V;
  options: readonly { id: V; label: string; blurb?: string }[];
  onChange: (value: V) => void;
}) {
  const id = useId();
  return (
    <RadioGroup aria-label={name} value={value} onValueChange={(next) => onChange(next as V)}>
      {options.map((option) => (
        <RadioItem
          key={option.id}
          id={`${id}-${option.id}`}
          value={option.id}
          label={option.label}
          description={option.blurb}
        />
      ))}
    </RadioGroup>
  );
}

function LayoutChoice({ layout, onLayout }: Pick<PlansToolbarProps, 'layout' | 'onLayout'>) {
  return (
    <ButtonGroup aria-label="How the plans are drawn" data-testid="plans-view">
      <Button
        size="sm"
        variant="ghost"
        aria-pressed={layout === 'list'}
        data-view="list"
        onClick={() => onLayout('list')}
      >
        List
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-pressed={layout === 'cards'}
        data-view="cards"
        onClick={() => onLayout('cards')}
      >
        Cards
      </Button>
    </ButtonGroup>
  );
}

export function PlansToolbar(props: PlansToolbarProps) {
  const { filters, onFilters, sort, onSort, group, onGroup, layout, onLayout, everything, hiddenBy } = props;
  const sortSpec = SORTS.find((s) => s.id === sort) ?? SORTS[0];
  const groupSpec = PLAN_GROUPS.find((g) => g.id === group) ?? PLAN_GROUPS[0];
  const filtering = activeCount(filters);
  const repoOrStatus = [filters.repo, filters.status && statusWord(filters.status)].filter(Boolean);

  const verbs: ToolbarVerb[] = [];
  if (hiddenBy.closed || hiddenBy.documents) {
    verbs.push({
      id: 'widen',
      label: 'Put closed plans and documents in the list',
      onSelect: () => onFilters({ showClosed: true, showDocuments: true }),
    });
  }
  if (filtering || filters.query.trim()) {
    verbs.push({ id: 'clear', label: 'Clear the filters', onSelect: props.onClear });
  }

  const searched = hiddenBy.search > 0;
  return (
    <Toolbar
      label="Plans"
      search={{
        value: filters.query,
        onChange: (query) => onFilters({ query }),
        placeholder: 'Find a plan',
        label: 'Find a plan by name or slug',
      }}
      filter={{
        ...(repoOrStatus.length ? { value: repoOrStatus.join(', ') } : {}),
        active: filtering,
        panel: <FilterPanel {...props} />,
      }}
      group={{
        value: groupSpec.label,
        active: group === 'none' ? 0 : 1,
        panel: <Choices name="Group the plans" value={group} options={PLAN_GROUPS} onChange={onGroup} />,
      }}
      sort={{
        value: sortSpec.label,
        panel: <Choices name="Order the plans" value={sort} options={SORTS} onChange={onSort} />,
      }}
      view={{
        value: layout === 'cards' ? 'Cards' : 'List',
        panel: <LayoutChoice layout={layout} onLayout={onLayout} />,
        inline: <LayoutChoice layout={layout} onLayout={onLayout} />,
      }}
      more={verbs}
      everything={everything}
      note={
        searched ? (
          <>
            <span data-testid="plans-filtered" className="min-w-0">
              {plural(props.shown, 'plan')} {props.shown === 1 ? 'matches' : 'match'}
              {filters.query.trim() ? ` “${filters.query.trim()}”` : ''}. {hiddenBy.search} left out.
            </span>
            <Button size="sm" variant="ghost" onClick={props.onClear}>
              Clear the filters
            </Button>
          </>
        ) : undefined
      }
    />
  );
}

/** A status filter's value, in words: a closure question or a status's label. */
function statusWord(status: string): string {
  if (status === OPEN_ONLY) return 'open only';
  if (status === CLOSED_ONLY) return 'closed only';
  return statusLabel(status);
}
