/**
 * Plans — the whole estate, in the order you are asking about.
 *
 * ## What the page is for
 *
 * The console has four list surfaces and they answer four different questions.
 * Now's **Next up** answers *what next* — one phase, promoted, with its boot
 * prompt (it was `#/ready` until Phase 8).
 * `#/dashboard` answers *what now* — whatever is blocked on a person this
 * minute. `#/stats` answers *over time*. This one answers **where does
 * everything stand**: every plan side by side, comparable, findable, and sorted
 * by whichever of five questions you actually have.
 *
 * The dashboard shows six plans as route strips and links here; that is a teaser
 * of the same vocabulary, not a smaller copy of this page. Six needs a per-plan
 * engine read and sixty-five does not.
 *
 * ## What is on screen and why
 *
 * - **A track per plan.** The signature, and the reason the page is worth
 *   scrolling: a plan's shape reads before its name does. See `row.tsx`.
 * - **Documents are hidden by default.** This source holds sixty-five plans and
 *   fifteen documents, and a document has no phases to run. `prefs` has said so
 *   since the first phase; until now nothing read it.
 * - **The filters say what they are hiding.** A count of dropped rows, always.
 *   A filter that silently cuts is indistinguishable from missing data.
 * - **Broken plans are named once, at the top.** A plan the engine cannot read
 *   is not a row-level detail; it means every number below it is a guess.
 */

import { useMemo, useState } from 'react';
import { FileText, Filter, X } from 'lucide-react';
import { useAttentionInbox, useConsoleState, usePlans, useRuns } from '@/lib/queries';
import { usePrefs } from '@/lib/prefs';
import { plural } from '@/lib/format';
import {
  Banner,
  Button,
  Card,
  Disclosure,
  Empty,
  PageError,
  Skeleton,
  StatusStack,
  type StatusNote,
} from '@/components/ui';
import { NewPlanButton } from '@/components/write-menu';
// The AI wizard, NOT gated on allowWrites: the claude session writes the plan,
// not the console — `allowAgent` is its capability. It never imports the pane,
// so mounting it here costs the plans chunk no xterm.
import { NewPlanWizardButton } from '@/features/sessions/wizard';
import { planHref } from '@shared/routes.js';
import type { PlanSummaryFull } from '@/lib/api';
import { Page } from '@/components/page';
import { Controls } from './toolbar';
import { PlanCard } from './card';
import { PlanTable } from './list';
import {
  NO_FILTERS,
  applyFilters,
  groupRows,
  hiddenBreakdown,
  isSortId,
  repoOptions,
  rowTotals,
  sortRows,
  statusOptions,
  toRows,
  type Filters,
  type GroupBy,
  type PlanRow,
  type SortId,
} from './model';

export default function PlansView() {
  const { data: plans, isPending, error, refetch } = usePlans();
  const { data: state } = useConsoleState();
  const [prefs, setPrefs] = usePrefs();

  // A repo or status filter is per-visit, like the search: it hides rows, and a
  // hidden row that survives a reload is how a plan goes missing for a week.
  // `showDocuments` and `showClosed` persist because they are shape, not
  // search — and because their toggles are on screen the whole time.
  const [local, setLocal] = useState({ query: '', repo: '', status: '' });

  // The same gate the runs page uses: a console whose server predates the
  // autopilot has no `/api/runs`, and `enabled` waits for `/api/state` to
  // *answer* rather than assuming — gating on `!stale` alone fires the request
  // once before learning the endpoint is not there.
  const runsEnabled = state != null && state.autopilot !== false;
  const { data: runs } = useRuns(runsEnabled);
  // What is waiting on a PERSON, per plan. Already fetched and cached by the
  // shell's bell badge, so on almost every visit this costs one cache read —
  // and it is the one fact a row could not derive from `/api/plans`.
  const { data: inbox } = useAttentionInbox();

  // Memoised: a fresh `[]` per render would re-run every memo below on every render.
  const summaries = useMemo(() => (plans ?? []) as unknown as PlanSummaryFull[], [plans]);
  const all = useMemo(
    () => toRows(summaries, runs ?? [], Date.now(), inbox?.items ?? []),
    [summaries, runs, inbox],
  );

  const filters: Filters = useMemo(
    () => ({ ...local, showDocuments: prefs.showDocuments, showClosed: prefs.showClosed }),
    [local, prefs.showDocuments, prefs.showClosed],
  );

  const sortId: SortId = isSortId(prefs.sort) ? prefs.sort : 'activity';
  const layout = prefs.plansLayout === 'table' ? 'table' : 'board';
  const group = (prefs.plansGroup ?? 'none') as GroupBy;

  const visible = useMemo(() => sortRows(applyFilters(all, filters), sortId), [all, filters, sortId]);
  /*
   * The closed estate — folded, in place, rather than absent.
   *
   * Hiding closed plans is the right default (they report no work) and it was
   * being done by simply not drawing them, which on a source where 71 of 72
   * plans are closed reads as data loss. A banner was patching that over. This
   * is the shape the disclosure ladder already has for it: the section is
   * always on the page, its count is drawn while folded, and one press puts
   * every row back — L1, in place, with nothing to dismiss.
   *
   * Measured through the REAL filter with one flag moved, exactly as
   * `hiddenBreakdown` is, so the search/repo/status fields narrow the closed
   * estate the same way they narrow the list above it. A second copy of "is
   * this row dropped" is a second thing to keep in step.
   *
   * ⚠️ The guard is "is this row ALREADY on the page", not "is the toggle on",
   * and the difference is a real defect this shipped with for a round. The
   * `showClosed` predicate stands down whenever the status control names a
   * closure (`model.ts` — picking `closed only` from the dropdown and getting
   * an empty list would read as a broken control), so with `Status → closed
   * only` the toggle is INERT: every closed plan is in the list above AND the
   * re-filter returns exactly the same set. A 72-plan source drew 142 rows for
   * 71 plans. Excluding what `visible` already holds is correct on every path —
   * the toggle, a sentinel, or a concrete closed status.
   */
  const closedRows = useMemo(() => {
    const shown = new Set(visible.map((row) => row.slug));
    return sortRows(
      applyFilters(all, { ...filters, showClosed: true }).filter(
        (row) => row.isClosed && !shown.has(row.slug),
      ),
      sortId,
    );
  }, [all, visible, filters, sortId]);
  const groups = useMemo(() => groupRows(visible, group), [visible, group]);
  const totals = rowTotals(visible);
  const repos = useMemo(() => repoOptions(all), [all]);
  const statuses = useMemo(() => statusOptions(all), [all]);
  const hiddenBy = useMemo(() => hiddenBreakdown(all, filters), [all, filters]);

  const onSort = (id: SortId) => setPrefs({ sort: id });

  const onFilters = (patch: Partial<Filters>) => {
    const { showDocuments, showClosed, ...rest } = patch;
    if (showDocuments !== undefined) setPrefs({ showDocuments });
    if (showClosed !== undefined) setPrefs({ showClosed });
    if (Object.keys(rest).length) setLocal((current) => ({ ...current, ...rest }));
  };

  const clearFilters = () => {
    setLocal({ query: '', repo: '', status: '' });
    setPrefs({ showDocuments: NO_FILTERS.showDocuments, showClosed: NO_FILTERS.showClosed });
  };

  // Deliberately NOT `clearFilters`. Clearing restores the DEFAULTS, and both
  // defaults hide — so on this estate "Clear the filters" makes the list
  // smaller, which is the opposite of what someone pressing it wants. Widening
  // is its own verb, and it leaves the search fields alone: whatever you typed
  // is not what you are trying to undo.
  const showEverything = () => setPrefs({ showDocuments: true, showClosed: true });

  const newPlan = (
    <div className="flex items-center gap-2">
      <NewPlanWizardButton allowAgent={state?.allowAgent === true} />
      <NewPlanButton allowWrites={Boolean(state?.allowWrites)} />
    </div>
  );

  if (error) {
    return (
      <Page title="Plans">
        <PageError error={error} retry={refetch} />
      </Page>
    );
  }

  if (isPending) {
    return (
      <Page title="Plans" subtitle="Reading the source">
        <Skeleton className="h-20" />
        <div className="mt-3 flex flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      </Page>
    );
  }

  if (!all.length) {
    return (
      <Page title="Plans" actions={newPlan}>
        <Empty
          icon={<FileText size={22} />}
          title="No plans here"
          body="This source has no docs/plans/*.md yet. A plan is a markdown file with a phase table; the skill can scaffold one for you."
          action={newPlan}
        />
      </Page>
    );
  }

  const controls = (
    <Controls
      sortId={sortId}
      onSort={onSort}
      filters={filters}
      onFilters={onFilters}
      layout={layout}
      onLayout={(value) => setPrefs({ plansLayout: value })}
      group={group}
      onGroup={(value) => setPrefs({ plansGroup: value })}
      repos={repos}
      statuses={statuses}
      hiddenBy={hiddenBy}
      onShowEverything={showEverything}
    />
  );

  if (!visible.length) {
    // Clearing the filters restores the DEFAULTS, and hiding closed plans is now
    // one of them — so on a source where every plan is closed, "Clear the
    // filters" would leave the page exactly as empty as it found it. Name the
    // real cause and offer the control that actually fixes it.
    const allClosed = all.every((row) => row.isClosed);
    /*
     * "Every plan is filtered out" over a live fold saying "Closed plans (1)"
     * is the page contradicting itself three lines apart — the same class of
     * defect as the note that went on calling a fold hidden. When the survivors
     * are all closed, say THAT: the list above is empty because the board leaves
     * closed plans out, and they are directly below.
     */
    const onlyClosed = !allClosed && closedRows.length > 0;
    return (
      <Page title="Plans" subtitle={`${plural(all.length, 'plan')} in this source`} actions={newPlan}>
        <Card className="mb-3 px-(--pad-x) py-(--pad-y)">{controls}</Card>
        <Empty
          icon={<Filter size={22} />}
          title={
            allClosed
              ? 'Every plan here is closed'
              : onlyClosed
                ? 'Every match is a closed plan'
                : 'Every plan is filtered out'
          }
          body={
            allClosed
              ? `All ${plural(all.length, 'plan')} in this source are complete, abandoned or superseded, so the list leaves them out. Nothing is wrong — there is just no open work.`
              : onlyClosed
                ? `${plural(closedRows.length, 'closed plan')} still match, folded below. The board leaves closed plans out until you ask.`
                : `${plural(all.length, 'plan')} are in this source. Widen the filters to see them.`
          }
          action={
            allClosed || onlyClosed ? (
              <Button onClick={() => onFilters({ showClosed: true })}>Show the closed plans</Button>
            ) : (
              <Button onClick={clearFilters}>Clear the filters</Button>
            )
          }
        />
        {/* Not only explained — REACHABLE. This branch used to be the whole
            page on a source where every plan is closed: a sentence about
            eighty-seven plans and no way to see one without finding a toggle
            first. The fold is the way. */}
        <ClosedEstate rows={closedRows} layout={layout} sortId={sortId} onSort={onSort} />
      </Page>
    );
  }

  return (
    <Page title="Plans" subtitle={subtitle(totals, all.length, hiddenBy)} actions={newPlan}>
      <Card className="mb-3 px-(--pad-x) py-(--pad-y)">{controls}</Card>

      <HiddenBand
        hiddenBy={hiddenBy}
        shown={visible.length}
        dismissed={prefs.plansHiddenBannerOff === true}
        onDismiss={() => setPrefs({ plansHiddenBannerOff: true })}
        onShowEverything={showEverything}
      />
      <AttentionBand rows={visible} />

      {groups.map((section) => (
        <section key={section.key} className={group === 'none' ? undefined : 'mb-5'}>
          {group !== 'none' && (
            <h2 className="mb-2 flex items-baseline gap-2 text-2xs font-medium uppercase tracking-[0.14em] text-ink-faint">
              {section.label}
              <span className="font-mono tabular-nums">{section.rows.length}</span>
            </h2>
          )}
          {layout === 'table' ? (
            <PlanTable rows={section.rows} sortId={sortId} onSort={onSort} />
          ) : (
            <div className="grid gap-2 lg:grid-cols-2">
              {section.rows.map((row, i) => (
                <PlanCard key={row.slug} row={row} index={i} />
              ))}
            </div>
          )}
        </section>
      ))}

      <ClosedEstate rows={closedRows} layout={layout} sortId={sortId} onSort={onSort} />
    </Page>
  );
}

/**
 * Plans nobody is working on any more, one press away.
 *
 * A closed plan reports no ready phases and no remaining sessions, so listing
 * it beside live work would put a row of em-dashes between every two rows that
 * mean something. But leaving it out entirely is what made this page say
 * "1 plan" over a source holding eighty-seven, and no amount of banner fixed
 * that: the estate is part of "where does everything stand".
 *
 * So it is folded rather than absent. The label names what opens and the count
 * is drawn while folded (`docs/design.md` §8) — which means the number is on
 * screen at rest, which is the whole thing the old arrangement could not do.
 * The rows are the same rows in the same layout: a closed plan is not a
 * different kind of record, it is a record with a lock on its name.
 */
function ClosedEstate({
  rows,
  layout,
  sortId,
  onSort,
}: {
  rows: PlanRow[];
  layout: 'table' | 'board';
  sortId: SortId;
  onSort: (id: SortId) => void;
}) {
  if (!rows.length) return null;
  return (
    <Disclosure
      className="mt-5 border-t border-rule pt-3"
      label="Closed plans"
      openLabel="Hide the closed plans"
      count={rows.length}
      bodyClassName="mt-2"
    >
      <p className="mb-2 text-2xs text-ink-faint">
        Complete, abandoned or superseded. They report no ready work, so the board above leaves them out —
        reopen one to put its remaining phases back on it.
      </p>
      {layout === 'table' ? (
        <PlanTable rows={rows} sortId={sortId} onSort={onSort} />
      ) : (
        <div className="grid gap-2 lg:grid-cols-2">
          {rows.map((row, i) => (
            <PlanCard key={row.slug} row={row} index={i} />
          ))}
        </div>
      )}
    </Disclosure>
  );
}

/**
 * What is on screen, counted the way the list beside it counts.
 *
 * The plan count says `4 of 87` whenever the filters are dropping anything.
 * Bare, it read `4 plans` on a source holding eighty-seven of them — a true
 * sentence about the list and a false one about the source, and the page's own
 * heading is the last place that should need a caveat.
 */
function subtitle(
  totals: ReturnType<typeof rowTotals>,
  total: number,
  hiddenBy: ReturnType<typeof hiddenBreakdown>,
): string {
  const shown = totals.plans + totals.documents;
  const parts = [hiddenBy.total > 0 ? `${shown} of ${plural(total, 'row')}` : plural(totals.plans, 'plan')];
  if (hiddenBy.total === 0 && totals.documents) parts.push(plural(totals.documents, 'document'));
  // Only worth saying when they are on screen — with the filter at its default
  // the count is always zero, and a permanent "0 closed" is noise.
  if (totals.closed) parts.push(`${totals.closed} closed`);
  if (totals.ready) parts.push(`${totals.ready} ready`);
  if (totals.sessions) parts.push(`${plural(totals.sessions, 'session')} of work left`);
  if (totals.running) parts.push(`${totals.running} running`);
  return parts.join(' · ');
}

/**
 * Say what the list is leaving out, when leaving it out is most of the estate.
 *
 * Now's Next up has said this for phases since the closure work landed —
 * *"N phases in closed plans are not counted — reopen a plan to put its work
 * back on the board"* — and this page, which is the one whose whole job is
 * "where does everything stand", said nothing but a grey count. On the source
 * this was written against that meant showing 1 row of 87 with no explanation
 * a person would find, which reads as data loss.
 *
 * Deliberately NOT a change to the default. Hiding closed plans is the
 * operator's own decision and the list should still open on the work; what was
 * wrong was doing it quietly. The threshold is proportional rather than a count:
 * hiding 71 of 72 needs saying, hiding 3 of 90 does not.
 */
function HiddenBand({
  hiddenBy,
  shown,
  dismissed,
  onDismiss,
  onShowEverything,
}: {
  hiddenBy: ReturnType<typeof hiddenBreakdown>;
  shown: number;
  dismissed: boolean;
  onDismiss: () => void;
  onShowEverything: () => void;
}) {
  /*
   * Documents only, now — closed plans are no longer HIDDEN.
   *
   * This band used to speak for both shape toggles, because both simply did not
   * draw their rows. The closed estate is a fold at the foot of the page now:
   * always there, its count on the fold, one press from every row. A banner
   * announcing that something is missing, over a section showing exactly how
   * much of it there is, would be the console disagreeing with itself.
   *
   * A document is still genuinely absent — it has no phases, so it has no row
   * shape to fold into — and that is what is left to say.
   */
  const byShape = hiddenBy.documents;
  if (!byShape) return null;
  // Most of the source is missing, and the operator did not do it this session.
  if (byShape <= shown * 2) return null;
  if (dismissed) return null;

  return (
    <Banner severity="info" className="mb-3 flex items-start gap-2">
      <span className="min-w-0 flex-1">
        {plural(byShape, 'document')} {byShape === 1 ? 'is' : 'are'} not listed. A document has no phases to
        run, so this page leaves them out until you ask — nothing is missing from the source.
      </span>
      <Button size="sm" className="shrink-0" onClick={onShowEverything}>
        Show everything
      </Button>
      {/* Dismissing loses nothing: the counts stay on the toggles themselves and
          in the line under the controls. This silences the loud form of a fact
          that is still on screen — which is the only kind of banner that has
          earned a close button. */}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss — the count stays on the filter button"
        title="Dismiss. The count stays on the Documents button."
        // 28 px is a comfortable target for a pointer and a miss for a thumb,
        // so the box grows to the tap floor exactly where there is no hover.
        className="-mr-1 grid size-7 shrink-0 place-items-center rounded text-ink-faint hover:bg-surface-raised hover:text-ink [@media(hover:none)]:size-(--tap-min)"
      >
        <X size={14} aria-hidden />
      </button>
    </Banner>
  );
}

/**
 * Plans the engine could not read, named once.
 *
 * These are not a row-level detail. A plan whose phase table failed to parse
 * reports zero ready phases and zero remaining sessions — numbers that look like
 * "finished" and mean "unknown". Saying so at the top is the difference between
 * a quiet list and a lie.
 *
 * Closed plans are left out even when they carry an `engineError`. This band is
 * an error-severity call to action, and the server demotes a closed plan's
 * structural issues to `info` for exactly this reason — the plan still shows the
 * damage on its own row and its own page, it just stops interrupting.
 */
function AttentionBand({ rows }: { rows: PlanRow[] }) {
  const broken = rows.filter((row) => row.errors > 0 && !row.isClosed);
  if (!broken.length) return null;

  const notes: StatusNote[] = broken.map((row) => ({
    id: row.slug,
    severity: 'error',
    title: (
      <a href={planHref(row.slug)} className="font-medium hover:text-action">
        {row.title}
      </a>
    ),
    body: row.firstIssue ?? plural(row.errors, 'error'),
  }));

  return <StatusStack notes={notes} max={3} className="mb-3" />;
}
