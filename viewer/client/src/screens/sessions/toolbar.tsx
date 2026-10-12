/**
 * The sessions' toolbar — the one grammar (design.md principle 8): search ·
 * filter · group · sort · ⋯ · Everything, and below 900 the same words in one
 * View sheet (7.0, quiet-console phase 15). The mechanism is `ui/toolbar.tsx`;
 * what is here is a SESSION's vocabulary: the four kinds, with how many of
 * each this machine is running; the two shapes (a section per kind, or one
 * list); the three orders; and the one act a session page has always offered
 * beside its own, a plan written with AI.
 *
 * The kind, the shape and the order persist (`prefs.sessionsKind`,
 * `sessionsGroup`, `sessionsSort` — the 6.x keys, reused): a kind is a view a
 * person left set. The words are per visit — a search term is a question asked
 * a moment ago, and would startle anyone still narrowing the list tomorrow.
 */

import { Suspense, lazy, useId, useState } from 'react';
import { plural } from '@/lib/format';
import { Button, type Everything } from '@/ui';
import { RadioGroup, RadioItem } from '@/ui/radio-group';
import { Toolbar, type ToolbarVerb } from '@/ui/toolbar';
import {
  SESSION_GROUPINGS,
  SESSION_GROUPS,
  SORTS,
  kindOf,
  type SessionFilters,
  type SessionGroupBy,
  type SessionGroupKind,
  type SessionSortId,
} from './model';

/** The plan wizard's dialog — its own chunk, shared with the library's New plan, fetched when asked for. */
const NewPlanWizard = lazy(() => import('@/screens/plans/wizard'));

const AGENT_OFF = 'This console opens no sessions (no --allow-agent).';

export interface SessionsToolbarProps {
  filters: SessionFilters;
  onFilters: (patch: Partial<SessionFilters>) => void;
  sort: SessionSortId;
  onSort: (id: SessionSortId) => void;
  group: SessionGroupBy;
  onGroup: (group: SessionGroupBy) => void;
  everything: Everything;
  /** How many of each kind exist — counted over every row, never over what a filter left. */
  counts: Readonly<Record<SessionGroupKind, number>>;
  /** Every row, and how many the list draws now. */
  total: number;
  shown: number;
  /** Put every filter back to where the page opens. */
  onClear: () => void;
  allowAgent: boolean;
}

/**
 * The kinds as one choice, each with its count — the filter is also the only
 * summary of what this machine runs: three lanes, one shell, nine `claude`
 * processes nobody here started. A kind with nothing in it is not offered (a
 * choice that empties the list is a dead control) unless it is the one chosen,
 * which must stay visible to be undone.
 */
function KindPanel({
  value,
  counts,
  onChange,
}: {
  value: SessionGroupKind | '';
  counts: Readonly<Record<SessionGroupKind, number>>;
  onChange: (kind: SessionGroupKind | '') => void;
}) {
  const id = useId();
  const total = SESSION_GROUPS.reduce((n, group) => n + counts[group.kind], 0);
  const offered = SESSION_GROUPS.filter((group) => counts[group.kind] > 0 || group.kind === value);
  return (
    <RadioGroup
      aria-label="Which kind of session"
      value={value || 'every'}
      onValueChange={(next) => onChange(next === 'every' ? '' : kindOf(next))}
      data-testid="sessions-filter-kind"
    >
      <RadioItem
        id={`${id}-every`}
        value="every"
        label={
          <>
            Every kind <span className="tnum text-ink-muted">{total}</span>
          </>
        }
      />
      {offered.map((group) => (
        <RadioItem
          key={group.kind}
          id={`${id}-${group.kind}`}
          value={group.kind}
          label={
            <>
              {group.title} <span className="tnum text-ink-muted">{counts[group.kind]}</span>
            </>
          }
          description={group.blurb}
        />
      ))}
    </RadioGroup>
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

export function SessionsToolbar(props: SessionsToolbarProps) {
  const { filters, onFilters, sort, onSort, group, onGroup, everything, counts, total, shown, onClear } =
    props;
  const [wizard, setWizard] = useState(false);
  const kind = kindOf(filters.kind);
  const sortSpec = SORTS.find((s) => s.id === sort) ?? SORTS[0]!;
  const groupSpec = SESSION_GROUPINGS.find((g) => g.id === group) ?? SESSION_GROUPINGS[0]!;
  const kinds = SESSION_GROUPS.filter((one) => counts[one.kind] > 0).length;
  const query = filters.query.trim();
  const narrowed = Boolean(kind || query);
  const hidden = Math.max(0, total - shown);

  const verbs: ToolbarVerb[] = [
    {
      id: 'wizard',
      label: 'New plan with AI',
      onSelect: () => setWizard(true),
      ...(props.allowAgent ? {} : { disabled: AGENT_OFF }),
    },
  ];
  if (narrowed) verbs.push({ id: 'clear', label: 'Clear the filters', onSelect: onClear });

  return (
    <>
      <Toolbar
        label="Sessions"
        search={{
          value: filters.query,
          onChange: (next) => onFilters({ query: next }),
          placeholder: 'Find a session',
          label: 'Find a session by name, directory or id',
        }}
        // One kind and nothing chosen is no choice: the filter would offer the
        // list it already shows, twice.
        {...(kinds > 1 || kind
          ? {
              filter: {
                ...(kind ? { value: SESSION_GROUPS.find((one) => one.kind === kind)?.short ?? kind } : {}),
                active: kind ? 1 : 0,
                panel: (
                  <KindPanel value={kind} counts={counts} onChange={(next) => onFilters({ kind: next })} />
                ),
              },
            }
          : {})}
        group={{
          value: groupSpec.label,
          // A section per kind is where the page opens; one list is the choice.
          active: group === 'none' ? 1 : 0,
          panel: (
            <Choices name="Group the sessions" value={group} options={SESSION_GROUPINGS} onChange={onGroup} />
          ),
        }}
        sort={{
          value: sortSpec.label,
          panel: <Choices name="Order the sessions" value={sort} options={SORTS} onChange={onSort} />,
        }}
        more={verbs}
        everything={everything}
        note={
          narrowed && hidden > 0 ? (
            <>
              <span data-testid="sessions-filtered" className="min-w-0">
                Showing {shown} of {plural(total, 'session')}
                {query ? ` for “${query}”` : ''}: {hidden} hidden by the filters.
              </span>
              <Button size="sm" variant="ghost" onClick={onClear}>
                Clear the filters
              </Button>
            </>
          ) : undefined
        }
      />
      {wizard && (
        <Suspense fallback={null}>
          <NewPlanWizard onClose={() => setWizard(false)} />
        </Suspense>
      )}
    </>
  );
}
