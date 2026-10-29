/**
 * Plans — the library (7.0, quiet-console phase 9; the estate since 3.0).
 *
 * ```
 * Plans                                                                      [ New plan ⌄ ]
 * 2 things waiting on you, 1 running and 3 phases ready to start.
 * [Find a plan…]  Filter  Group  Sort Recent  View List                          ⋯  Everything
 * ● Needs you ◎ Active  Why   cart api             ▮▮▮▯▯▯▯▯▯ (33 %)   —            You, on phase 4   …  ⇢
 * ● Running ◎ Active  Why     storefront redesign  ▮▮▮▮▮▮▮▮▯▯ (56 %)  P42 ● Running  —                 …  ⇢
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * › Closed plans (71)
 * › Documents (15)
 * ```
 *
 * One question: where does everything stand? Every open plan as one line —
 * its mark (a button: *Why* opens the panel on the reasons behind the word),
 * its name, its line, what is live now, what it waits on, its items on Your
 * turn, the work left, its spend, who pays and when it last moved, the table
 * scrolling sideways with the status and the name pinned — in the
 * order the person asked for, as a list or as cards. The closed estate and
 * the documents are on the page too, folded under the list with their counts
 * named: never hidden, never a banner about something missing. A plan the
 * engine cannot read is named once, at the top, because every figure below
 * it is a guess. Each line expands in place, inspects in the panel, and opens
 * its plan.
 *
 * It reads the list, the SLIM runs (#234), the inbox the bell already holds
 * and the accounts — nothing per plan until a pointer rests on one, or the
 * panel opens on it (`why-panel.tsx` reads its detail, its run and the queue).
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { PlanSummaryFull } from '@/data/api';
import { useAccounts } from '@/data/accounts';
import { useConsoleState, usePrefsWrite } from '@/data/console';
import { useAttentionInbox } from '@/data/inbox';
import { usePlans } from '@/data/plans';
import { useRunList } from '@/data/runs';
import { usePrefs } from '@/lib/prefs';
import { plural } from '@/lib/format';
import { Banner, Button, Empty, Page, SectionHeading, Skeleton, useEverything } from '@/ui';
import { Disclosure } from '@/ui/disclosure';
import { useInspected } from '@/shell/panel/inspector-host';
import { planHref, runHref, type Route } from '@/shell/routes';
import { PlanCards } from './card';
import { inspectPlan, planRecordKey } from './inspector';
import { PlanList } from './list';
import {
  NO_FILTERS,
  estateOf,
  groupRows,
  hiddenBreakdown,
  isGroupBy,
  isSortId,
  layoutOf,
  repoOptions,
  rowTotals,
  statusOptions,
  toRows,
  workSentence,
  type Filters,
  type PlanRow,
  type PlansLayout,
  type SortId,
} from './model';
import { NewPlanMenu } from './new-plan';
import { ConcernLines, NextUpLinks } from './row';
import { PlansToolbar } from './toolbar';

/** The per-visit filters — a repository, a status, the words. */
type Local = Pick<Filters, 'query' | 'repo' | 'status'>;
const NO_LOCAL: Local = { query: '', repo: '', status: '' };

export default function PlansLibrary(_props: { route: Route }) {
  const plansQuery = usePlans();
  const { data: state } = useConsoleState();
  const [prefs, setPrefs] = usePrefs();
  const { mutate: writePrefs } = usePrefsWrite();
  const everything = useEverything('plans');
  const [local, setLocal] = useState<Local>(NO_LOCAL);

  // A server that predates the autopilot has no run endpoints; wait for
  // `/api/state` to answer rather than ask one that is not there.
  const { data: runs } = useRunList(state != null && state.autopilot !== false);
  const { data: inbox } = useAttentionInbox();
  // Who pays for each plan's newest run, named as the account names itself.
  const { data: accounts } = useAccounts();

  const summaries = useMemo(() => (plansQuery.data ?? []) as unknown as PlanSummaryFull[], [plansQuery.data]);
  const all = useMemo(
    () => toRows(summaries, runs ?? [], Date.now(), inbox?.items ?? [], accounts?.accounts),
    [summaries, runs, inbox, accounts],
  );

  const filters: Filters = useMemo(
    () => ({ ...local, showDocuments: prefs.showDocuments, showClosed: prefs.showClosed }),
    [local, prefs.showDocuments, prefs.showClosed],
  );
  // The order is the person's, on the server (Settings ▸ Appearance writes it
  // too), so every browser and every console of theirs opens on it; this
  // browser's own copy answers only a server that does not say.
  const held = state?.prefs?.sort ?? '';
  const sort: SortId = isSortId(held) ? held : isSortId(prefs.sort) ? prefs.sort : 'activity';
  const onSort = useCallback(
    (id: string) => {
      if (!isSortId(id)) return;
      setPrefs({ sort: id });
      writePrefs({ sort: id });
    },
    [setPrefs, writePrefs],
  );
  const layout = layoutOf(prefs.plansLayout);
  const group = isGroupBy(prefs.plansGroup) ? prefs.plansGroup : 'none';

  const estate = useMemo(() => estateOf(all, filters, sort), [all, filters, sort]);
  const groups = useMemo(() => groupRows(estate.list, group), [estate.list, group]);
  const repos = useMemo(() => repoOptions(all), [all]);
  const statuses = useMemo(() => statusOptions(all), [all]);
  const hiddenBy = useMemo(() => hiddenBreakdown(all, filters), [all, filters]);
  const lead = workSentence(rowTotals(all));
  const inspected = useInspected()?.key;

  const onFilters = useCallback(
    (patch: Partial<Filters>) => {
      const { showDocuments, showClosed, ...rest } = patch;
      if (showDocuments !== undefined || showClosed !== undefined) {
        setPrefs({
          ...(showDocuments !== undefined ? { showDocuments } : {}),
          ...(showClosed !== undefined ? { showClosed } : {}),
        });
      }
      if (Object.keys(rest).length) setLocal((current) => ({ ...current, ...rest }));
    },
    [setPrefs],
  );
  const clear = useCallback(() => {
    setLocal(NO_LOCAL);
    setPrefs({ showDocuments: NO_FILTERS.showDocuments, showClosed: NO_FILTERS.showClosed });
  }, [setPrefs]);
  const onInspect = useCallback((row: PlanRow) => inspectPlan(row, state), [state]);

  const actions = (
    <NewPlanMenu allowAgent={state?.allowAgent === true} allowWrites={state?.allowWrites === true} />
  );

  if (plansQuery.error) {
    return (
      <Page title="Plans" actions={actions} data-testid="plans-library">
        <Empty
          title={`The plans could not be read: ${String((plansQuery.error as Error).message ?? plansQuery.error)}`}
          action={
            <Button size="sm" onClick={() => void plansQuery.refetch()}>
              Read them again
            </Button>
          }
        />
      </Page>
    );
  }

  if (plansQuery.isPending) {
    return (
      <Page title="Plans" lead="Reading the source" data-testid="plans-library">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-8" />
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-7" />
          ))}
        </div>
      </Page>
    );
  }

  if (!all.length) {
    return (
      <Page title="Plans" actions={actions} data-testid="plans-library">
        <Empty title="No plans in this source yet. A plan is a markdown file under docs/plans/ with a phase table." />
      </Page>
    );
  }

  /** One set of rows, drawn the way the person chose. */
  const view = (rows: readonly PlanRow[], key: string, label: string): ReactNode =>
    layout === 'cards' ? (
      <PlanCards
        rows={rows}
        onInspect={onInspect}
        inspected={inspected}
        label={label}
        everything={everything.on}
      />
    ) : (
      <PlanList
        rows={rows}
        everything={everything}
        sort={sort}
        onSort={onSort}
        // The status's *Why* opens the same record Inspect does, on its reasons.
        onWhy={onInspect}
        inspected={inspected}
        detail={(row) => (
          <RowDetail row={row} onInspect={onInspect} inspected={inspected === planRecordKey(row.slug)} />
        )}
        label={label}
        tableId="plans"
        key={key}
      />
    );

  return (
    <Page title="Plans" lead={lead || undefined} actions={actions} data-testid="plans-library">
      <PlansToolbar
        filters={filters}
        onFilters={onFilters}
        sort={sort}
        onSort={onSort}
        group={group}
        onGroup={(next) => setPrefs({ plansGroup: next })}
        layout={layout}
        onLayout={(next: PlansLayout) => setPrefs({ plansLayout: next })}
        everything={everything}
        repos={repos}
        statuses={statuses}
        hiddenBy={hiddenBy}
        shown={estate.list.length}
        onClear={clear}
      />

      <BrokenPlans rows={all.filter((row) => row.errors > 0 && !row.isClosed)} />


      {estate.list.length === 0 ? (
        <NothingListed
          all={all}
          estate={estate}
          searching={hiddenBy.search > 0}
          onInclude={() => onFilters({ showClosed: true })}
          onClear={clear}
        />
      ) : group === 'none' ? (
        view(estate.list, 'all', 'Plans')
      ) : (
        <div className="flex min-w-0 flex-col gap-6">
          {groups.map((section, i) => (
            <section
              key={section.key}
              aria-labelledby={`plans-group-${section.key}`}
              className={
                i ? 'flex min-w-0 flex-col gap-2 border-t border-rule pt-4' : 'flex min-w-0 flex-col gap-2'
              }
            >
              <SectionHeading id={`plans-group-${section.key}`} count={section.rows.length}>
                {section.label}
              </SectionHeading>
              {view(section.rows, section.key, `Plans: ${section.label}`)}
            </section>
          ))}
        </div>
      )}

      <Folds estate={estate} view={view} />
    </Page>
  );
}

/**
 * The closed plans and the documents, folded under the list with their counts
 * named — on the page, one press from every row. A fold is drawn only for rows
 * the list does not already hold.
 */
function Folds({
  estate,
  view,
}: {
  estate: ReturnType<typeof estateOf>;
  view: (rows: readonly PlanRow[], key: string, label: string) => ReactNode;
}) {
  if (!estate.closed.length && !estate.documents.length) return null;
  return (
    <div className="flex min-w-0 flex-col gap-3 border-t border-rule pt-4" data-testid="plans-folds">
      {estate.closed.length > 0 && (
        <Disclosure
          label="Closed plans"
          openLabel="Fold the closed plans"
          count={estate.closed.length}
          testId="plans-closed-fold"
          bodyClassName="pt-3"
        >
          {view(estate.closed, 'closed', 'Closed plans')}
        </Disclosure>
      )}
      {estate.documents.length > 0 && (
        <Disclosure
          label="Documents"
          openLabel="Fold the documents"
          count={estate.documents.length}
          testId="plans-documents-fold"
          bodyClassName="pt-3"
        >
          {view(estate.documents, 'documents', 'Documents')}
        </Disclosure>
      )}
    </div>
  );
}

/**
 * The list is empty — and why, in the one sentence that is true: every plan is
 * closed, every match is closed, or the search left nothing. The folds below
 * still hold what they hold, so the sentence never contradicts them.
 */
function NothingListed({
  all,
  estate,
  searching,
  onInclude,
  onClear,
}: {
  all: readonly PlanRow[];
  estate: ReturnType<typeof estateOf>;
  searching: boolean;
  onInclude: () => void;
  onClear: () => void;
}) {
  const plans = all.filter((row) => row.isPlan);
  if (plans.length && plans.every((row) => row.isClosed) && !searching) {
    return (
      <Empty
        title="Every plan here is closed — none has work left to run."
        action={
          <Button size="sm" onClick={onInclude}>
            Put them in the list
          </Button>
        }
      />
    );
  }
  if (estate.closed.length > 0) {
    return (
      <Empty
        title={`Every match is a closed plan: ${plural(estate.closed.length, 'plan')}, folded below.`}
        action={
          <Button size="sm" onClick={onInclude}>
            Put them in the list
          </Button>
        }
      />
    );
  }
  if (!plans.length) return <Empty title="This source holds documents and no plans." />;
  return (
    <Empty
      title="Nothing matches the filters."
      action={
        <Button size="sm" onClick={onClear}>
          Clear the filters
        </Button>
      }
    />
  );
}

/**
 * What opens in place under a line: the phases that could start, what is
 * wrong, and the ways on — the panel, the plan, its run.
 */
function RowDetail({
  row,
  onInspect,
  inspected,
}: {
  row: PlanRow;
  onInspect: (row: PlanRow) => void;
  inspected: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="plan-row-detail">
      <NextUpLinks row={row} />
      <ConcernLines row={row} />
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" aria-pressed={inspected} onClick={() => onInspect(row)}>
          Inspect
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <a href={planHref(row.slug)}>Open the plan</a>
        </Button>
        {row.run && (
          <Button size="sm" variant="ghost" asChild>
            <a href={runHref(row.slug)}>Open its run</a>
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Plans the engine reports errors in, named once at the top: a board that did
 * not parse reports zero ready and zero left, numbers that look like
 * "finished" and mean "unknown". A closed plan is not named — the server
 * demotes its structural issues, and its own row still says so.
 */
function BrokenPlans({ rows }: { rows: readonly PlanRow[] }) {
  if (!rows.length) return null;
  return (
    <Banner severity="error" data-testid="plans-broken">
      <span className="flex min-w-0 flex-col gap-1">
        <span>
          {rows.length === 1 ? 'One plan has' : `${rows.length} plans have`} errors, so what the list says
          about {rows.length === 1 ? 'it' : 'them'} may be wrong.
        </span>
        <ul className="flex min-w-0 flex-col gap-0.5">
          {rows.slice(0, 3).map((row) => (
            <li key={row.slug} className="min-w-0 break-words">
              <a href={planHref(row.slug)} className="font-medium underline-offset-2 hover:underline">
                {row.title}
              </a>
              {row.firstIssue ? `: ${row.firstIssue}` : ''}
            </li>
          ))}
          {rows.length > 3 && <li>{plural(rows.length - 3, 'more plan')}</li>}
        </ul>
      </span>
    </Banner>
  );
}
