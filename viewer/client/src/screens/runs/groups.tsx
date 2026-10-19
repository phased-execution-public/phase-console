/**
 * The groups — the home's runs, most urgent first (7.0, quiet-console phase 7;
 * the Tower's bays since control-tower phase 20, §Architecture 3).
 *
 * Six places a thing can be, in the order it costs to ignore them: Your turn,
 * Running, Waiting, Queued, Ready to start, Settled today (`BAYS`, the status
 * model's own list). Your turn is the ACTS, one line each; a run is one line
 * (`run-row.tsx`) handed the context its group was computed with, so the row
 * and the group cannot disagree. Ready to start is plans, not runs. Settled is
 * quiet — folded until asked, newest first.
 *
 * An empty group stays as one line saying so: the order is the thing a glance
 * learns, and a group that vanished when empty would move every group below
 * it. `?group=` scrolls its section into the one scroller and opens it when it
 * is folded.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CreditCard } from 'lucide-react';
import { BAYS } from '@shared/bays.js';
import { budgetClause, type CiRefusal, type CiRefusedPhase } from '@shared/ci-refusal.js';
import type { ConsoleState, ConvergeStatusView } from '@/data/api';
import { GROUP_LABELS, type PlacedRun, type RunGroup, type RunGroups } from '@/data/run-groups';
import { plural } from '@/lib/format';
import { usePrefs } from '@/lib/prefs';
import { scrollIntoScroller } from '@/lib/scroll';
import { SectionHeading } from '@/ui';
import { Disclosure } from '@/ui/disclosure';
import { phaseList } from './model';
import { Ready } from './ready';
import { RunRow } from './run-row';
import { YourTurn, YourTurnAside } from './your-turn';

/* ------------------------------------------------------------------ *
 * CI GitHub will not start, one line per repository (control-tower phase
 * 111, #166). When a repository's Actions budget is spent, or its account
 * cannot pay, GitHub ends every run on it in seconds without starting a job.
 * The wall is the repository's, so the home says it once per repository:
 * what the budget reads, and which phases wait on it. Ink, no hue: the
 * phases' own errands are the summons.
 * ------------------------------------------------------------------ */

/** `vca-refactor P11 and P12, hub-tidy P3` — who waits, plan by plan. */
export function waitersOf(phases: readonly CiRefusedPhase[]): string {
  const bySlug = new Map<string, number[]>();
  for (const p of phases) bySlug.set(p.slug, [...(bySlug.get(p.slug) ?? []), p.phase]);
  return [...bySlug].map(([slug, list]) => `${slug} ${phaseList(list)}`).join(', ');
}

/** The sentence after the label: the budget as read, then who waits. */
export function ciRefusedSentence(item: CiRefusal): string {
  const budget = budgetClause({ budgets: item.budgets, unreadable: item.unreadable });
  const waits = item.phases.length === 1 ? 'waits' : 'wait';
  return `GitHub is not starting jobs for ${item.repo}: ${budget}. ${waitersOf(item.phases)} ${waits} on it.`;
}

export function CiRefusedLines({ items }: { items: readonly CiRefusal[] }) {
  if (!items.length) return null;
  return (
    <ul
      aria-label="Repositories GitHub is not running CI for"
      data-testid="ci-refused"
      className="flex min-w-0 flex-col gap-1"
    >
      {items.map((item) => (
        <li
          key={item.repo}
          data-testid="ci-refused-repo"
          data-repo={item.repo}
          className="flex min-w-0 items-start gap-2 text-meta text-ink-muted"
        >
          <CreditCard size={12} aria-hidden className="mt-0.5 shrink-0 text-ink" />
          <span className="min-w-0 break-words">
            <span className="font-medium text-ink">{item.label}</span> {ciRefusedSentence(item)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What an empty group says — a fact about the console, not a mood. */
const EMPTY: Record<RunGroup, string> = {
  'needs-you': 'Nothing needs you right now.',
  live: 'No session is working right now.',
  waiting: 'Nothing is parked on a clock, a wall or a hold.',
  queued: 'Nothing is waiting for a scope or a slot.',
  ready: 'No phase of an open plan is ready to start.',
  settled: 'Nothing has settled yet.',
};

/** How many settled rows are drawn before "Show every one". */
const SETTLED_SHOWN = 20;

export interface GroupsProps {
  /** The groups, already filtered. */
  model: RunGroups;
  allowRun: boolean;
  state: ConsoleState | undefined;
  /** `?group=` — the group an address names: scrolled to, and opened when folded. */
  focus?: RunGroup | undefined;
  /** The Ready group's plans are still being read; its rows upgrade in place. */
  readyLoading?: boolean;
  /** A filter narrows the groups — an empty one then says so, not that the console is idle. */
  filtered?: boolean;
  /** The convergence loop's clock, for what an empty Your turn says about the next sweep. */
  converge?: ConvergeStatusView | undefined;
}

export function Groups({
  model,
  allowRun,
  state,
  focus,
  readyLoading = false,
  filtered = false,
  converge,
}: GroupsProps) {
  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="groups">
      {BAYS.map((group) => (
        <GroupSection
          key={group}
          group={group}
          count={model.counts[group]}
          focused={focus === group}
          aside={
            group === 'needs-you' ? (
              <YourTurnAside model={model} />
            ) : group === 'settled' ? (
              <SettledSummary model={model} />
            ) : null
          }
          empty={filtered ? 'Nothing here matches the filter.' : EMPTY[group]}
        >
          {bodyOf(group)}
        </GroupSection>
      ))}
    </div>
  );

  function bodyOf(group: RunGroup): ReactNode {
    if (group === 'needs-you') return <YourTurn model={model} converge={converge} />;
    if (group === 'ready') {
      return model.ready.length ? (
        <Ready
          departures={model.ready}
          runs={model.runs.map((t) => t.run)}
          allowRun={allowRun}
          loading={readyLoading}
        />
      ) : null;
    }
    if (group === 'settled')
      return (
        <Settled runs={model.groups.settled} allowRun={allowRun} state={state} focused={focus === group} />
      );
    const runs = model.groups[group];
    return runs.length ? <Rows runs={runs} allowRun={allowRun} state={state} /> : null;
  }
}

/**
 * A ref for a section `?group=` can name. Scrolls it to the top of its own
 * scroller when `focused` turns true — once per arrival, not on every render.
 * Never `scrollIntoView`: it moves every scrollable ancestor, including the
 * horizontal one on a phone; `scrollIntoScroller` moves exactly the one that
 * owns the element.
 */
function useFocusGroup<T extends HTMLElement>(focused: boolean) {
  const ref = useRef<T>(null);
  const wasFocused = useRef(false);
  useEffect(() => {
    if (focused && !wasFocused.current && ref.current) scrollIntoScroller(ref.current, 'start');
    wasFocused.current = focused;
  }, [focused]);
  return ref;
}

function GroupSection({
  group,
  count,
  focused,
  aside,
  empty,
  children,
}: {
  group: RunGroup;
  count: number;
  focused: boolean;
  aside?: ReactNode;
  /** What the group says when it holds nothing. */
  empty: string;
  children?: ReactNode;
}) {
  const ref = useFocusGroup<HTMLElement>(focused);
  return (
    <section
      ref={ref}
      aria-label={`${GROUP_LABELS[group]}, ${count}`}
      data-testid="bay"
      data-bay={group}
      data-count={count}
      {...(focused ? { 'data-focused': 'true' } : {})}
      className="flex min-w-0 scroll-mt-4 flex-col gap-2"
    >
      <SectionHeading count={count} aside={aside}>
        {GROUP_LABELS[group]}
      </SectionHeading>
      {children ?? <p className="text-meta text-ink-faint">{empty}</p>}
    </section>
  );
}

function Rows({
  runs,
  allowRun,
  state,
}: {
  runs: readonly PlacedRun[];
  allowRun: boolean;
  state: ConsoleState | undefined;
}) {
  return (
    // The rows lay themselves out by the room this list has (`@container/strips`):
    // a page column beside the open panel is a tablet's, whatever the viewport.
    <div className="@container/strips flex min-w-0 flex-col divide-y divide-rule">
      {runs.map((t) => (
        <RunRow key={t.key} placed={t} allowRun={allowRun} state={state} />
      ))}
    </div>
  );
}

function SettledSummary({ model }: { model: RunGroups }) {
  const { today, dormant } = model.settled;
  if (today === 0 && dormant === 0) return null;
  return (
    <span className="text-meta text-ink-muted" data-testid="settled-summary">
      {today} today, {dormant} dormant
    </span>
  );
}

function Settled({
  runs,
  allowRun,
  state,
  focused,
}: {
  runs: readonly PlacedRun[];
  allowRun: boolean;
  state: ConsoleState | undefined;
  focused: boolean;
}) {
  const [prefs, setPrefs] = usePrefs();
  const [every, setEvery] = useState(false);
  if (!runs.length) return null;
  const shown = every ? runs : runs.slice(0, SETTLED_SHOWN);
  return (
    <Disclosure
      label={`Show ${plural(runs.length, 'settled run')}`}
      openLabel="Hide the settled runs"
      open={prefs.towerSettledOpen || focused}
      onOpenChange={(next) => setPrefs({ towerSettledOpen: next })}
      testId="settled-toggle"
      bodyClassName="flex min-w-0 flex-col gap-2 pt-2"
    >
      <Rows runs={shown} allowRun={allowRun} state={state} />
      {runs.length > shown.length && (
        <button
          type="button"
          onClick={() => setEvery(true)}
          className="self-start text-meta text-ink-muted hover:text-ink [@media(hover:none)]:min-h-(--tap-min)"
        >
          Show every one of the {runs.length}
        </button>
      )}
    </Disclosure>
  );
}
