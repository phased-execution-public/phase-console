/**
 * Runs — the fleet, and whatever it is asking of you.
 *
 * This is a route of its own rather than a tab of the run view because it
 * answers a different question. `#/plan/:slug/run` is *this plan's* autopilot,
 * with its controls; this is every run there has ever been.
 *
 * ## Ordered by urgency, not by category
 *
 * The same rule the dashboard follows. A session parked with its hand up outranks
 * a session that is merely running, which outranks the record of two hundred that
 * have finished. So: approvals, then the login that is blocking one, then the
 * live console, then the fleet.
 *
 * ## The console gets out of the way
 *
 * It used to occupy a fixed sixteen rems whether or not anything was running,
 * which pushed the page's actual content below the fold on every screen and
 * fetched a transcript nobody had asked to read. Now a live run opens it and an
 * idle one collapses it to a line naming the last run — expandable, and only
 * then is the transcript fetched.
 *
 * ## Every live session, not the one that happened to be first
 *
 * The console watched a single run, which was the whole truth until a pool could
 * drive several at once — and then it was a page about "every run there has ever
 * been" that could show exactly one of the two that were live, with nothing on
 * screen admitting the other existed. It is a tab strip now, one per live lane
 * across every plan, labelled `slug · P<n>` because two tabs reading "Phase 5"
 * here are two different plans.
 *
 * The single console survives for the case that has no lane: a finished run you
 * picked in order to re-read it.
 *
 * ## What is not re-implemented here
 *
 * The approval queue, the auth card, and the session panes (console, panels, ask
 * box) all come from `views/run/*`. What is specific to "every run at once" is
 * picking which lane to watch, and the fleet itself.
 */

import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Radio } from 'lucide-react';
import { api, type QueueEntry, type RunState } from '@/lib/api';
import {
  keys,
  useApiMutation,
  useApprovals,
  useAuth,
  useConsoleState,
  usePlans,
  useQueue,
  useRuns,
} from '@/lib/queries';
import { usePrefs } from '@/lib/prefs';
import { relativeTime } from '@/lib/format';
import { Button, Card, Chip, Empty, PageError, Skeleton, toast } from '@/components/ui';
import { ApprovalQueue, type Answer, type Decide } from './approvals';

/**
 * What answering one approval card takes, named off the callback's own type —
 * so the two cannot drift and neither respells `allow`/`deny`.
 */
type DecideArgs = {
  id: Parameters<Decide>[0];
  decision: Parameters<Decide>[1];
  reason: Parameters<Decide>[2];
  remember: Parameters<Decide>[3];
  rule: Parameters<Decide>[4];
};
import { LiveConsole } from './console';
import { isLive } from './defaults';
import { LaneTabStrip, type LaneTabItem } from './lanes';
import { LanePane } from './pane-host';
import { SessionPanes, crossLaneId, laneOf, type Lane } from './session-panes';
import { AuthCard, StaleServerNote, looksLikeAuthFailure } from './status-strip';
import { Page } from '@/components/page';
import { Controls } from './fleet-toolbar';
import { LiveStrip } from './live-strip';
import { BoardToggle, RunsBoard } from './board';
import { plansHref, runsHref, runsViewOf, type RunsView, type Route } from '@/app/routes';
import { useNavigate } from '@/app/router';
import { nowLanes } from '@/features/now/model';
import { isClosed } from '@/lib/closure';
import {
  NO_FILTERS,
  applyFilters,
  isSortId,
  outcomeCounts,
  partitionClosed,
  planOptions,
  sortRows,
  toRows,
  type Filters,
  type SortId,
} from './model';

export default function RunsView({ route }: { route?: Route }) {
  const client = useQueryClient();
  const { data: state } = useConsoleState();
  const [prefs, setPrefs] = usePrefs();

  /**
   * Board or table: the address wins for this visit, the preference otherwise.
   *
   * The same rule `?focus=`, `?panel=` and `?lane=` follow, and it exists for
   * one caller — the palette's "Freeze all", which navigates here rather than
   * firing. Landing on the table would land beside no Freeze all at all, so
   * the link says which shape it means. An unrecognised `?view=` is ignored
   * rather than guessed at.
   */
  // Which views this tree HAS. The table compares many runs side by side, which
  // is the fleet — Pro — so a stored preference or a hand-typed `/runs/table`
  // address resolves back to the board rather than drawing a filter toolbar
  // above no rows at all.
  const VIEWS: RunsView[] = [
    'board',
  ];
  const asked: RunsView = (route ? runsViewOf(route) : undefined) ?? prefs.runsView;
  const view: RunsView = VIEWS.includes(asked) ? asked : 'board';
  const go = useNavigate();

  // The client is served fresh from disk; the server is whatever Node loaded at
  // startup. Upgrading the skill under a running console leaves this page
  // talking to an API that has no run endpoints, and the honest thing to show
  // is why — not a stack of failed requests.
  //
  // `enabled` waits for `/api/state` to answer rather than assuming the server
  // is current: `stale` is false while the state query is still pending, so
  // gating on `!stale` alone fires every run request once *before* learning the
  // endpoints are not there — the 404s this check exists to prevent.
  const stale = state != null && state.autopilot === false;
  const enabled = state != null && !stale;
  const allowRun = Boolean(state?.allowRun);

  const { data: runs, isPending, error, refetch } = useRuns(enabled);
  // The day cap's own figure, not the sum of the rows on screen — see
  // `FleetTiles`. Held here so the tiles stay a pure render of what they are
  // given, which is what lets them be tested without a query client.
  const { data: queue } = useApprovals(enabled);
  const { data: auth } = useAuth(enabled);

  const [watchId, setWatchId] = useState<string | undefined>();
  const [tab, setTab] = useState<string | undefined>();
  const [local, setLocal] = useState({ query: '', plan: '' });

  // The run worth watching: whichever one you picked, else the live one, else
  // the most recent. `useRuns` returns them newest-first, so `[0]` is the
  // fallback. A pick wins over a live run — you asked for that one.
  const active = (runs ?? []).find((r) => isLive(r.status));
  const picked = watchId ? (runs ?? []).find((r) => r.id === watchId) : undefined;
  const watching = picked ?? active ?? runs?.[0];

  // Open when something is running, or when you opened it. A collapsed console
  // fetches nothing: a transcript is the largest payload this console reads, and
  // reading one to render a box nobody expanded is the cost the old page paid on
  // every visit.
  const consoleOpen = Boolean(active) || prefs.runsConsole;

  /* ---------------- every live session, whoever owns it ---------------- */

  /**
   * This page's question is "every run there has ever been", so its console has
   * to reach every session there is now — including two plans running at once,
   * which the single watched console could not express at all. It showed one
   * run's lines and no way to know the others existed.
   *
   * ⚠️ **The strip and the tabs are ONE fold now, and that is the C1 fix.**
   * They were two: `LiveStrip` read `nowLanes()` (seven lane statuses) and the
   * tab strip read `lanesAcross()` (four), on the same page — so a parked,
   * waiting or gated lane was listed at the top and then had no tab below it,
   * the page showing a lane and denying it exists. `laneOf` projects the one
   * fold into the tab's view of a lane; they cannot disagree.
   */
  const stripLanes = useMemo(() => nowLanes(runs ?? []), [runs]);
  const lanes = useMemo(() => stripLanes.map(laneOf), [stripLanes]);
  // The board reads the queue for more than its tabs — the holder facts, the
  // hold/bump/chain chips and the suggested order all come off this snapshot,
  // and its `advice` is only on `GET /api/queue`. The table view keeps the
  // narrow condition it had: one fetch per page for a card nobody opened is
  // exactly what the collapsed console exists to avoid.
  const { data: admission } = useQueue(enabled && (view === 'board' || lanes.some((l) => l.queued)));

  // A pick of a FINISHED run is a request to read that one, and there is no lane
  // for it — so the old single console survives exactly for that, and for a page
  // with nothing live at all.
  const replaying = picked && !isLive(picked.status) ? picked : lanes.length ? undefined : watching;

  const approvals = (queue ?? []).filter((a) => a.status === 'pending');

  /**
   * Answer a card, then re-read — the re-read in `onSettled`, never in the
   * success leg.
   *
   * A card answered on a phone leaves this tab holding one that no longer
   * exists; pressing it 404s, and that failure is exactly the case where
   * re-reading matters most. `useApiMutation` is what holds that rule now, so
   * the only thing written out here is what this particular write MEANS — and
   * the bundle is `afterInboxAct`, deliberately the widest one there is: an
   * inbox verb can approve a permission, recover a run, unblock a phase and
   * clear a badge in one press.
   *
   * The toast is `onDone` rather than `say`, because the server answers three
   * different ways: a rule it could not parse (a warning, not a failure), a
   * rule it wrote (worth naming the file), and a plain answer.
   */
  const answer = useApiMutation<DecideArgs, Awaited<ReturnType<typeof api.decide>>>({
    fn: ({ id, decision, reason, remember, rule }) => api.decide(id, decision, reason, remember, rule),
    invalidates: keys.afterInboxAct(),
    onDone: (result, { decision }) => {
      if (result?.error) toast(result.error, 'warn');
      else if (result?.wrote) {
        toast(
          `${decision === 'allow' ? 'Approved' : 'Denied'} · wrote ${result.wrote} (${result.scope})`,
          'ok',
        );
      } else {
        toast(decision === 'allow' ? 'Approved' : 'Denied', decision === 'allow' ? 'ok' : 'warn');
      }
    },
  });
  const { mutate: answerCard } = answer;
  const decide: Decide = useCallback(
    (id, decision, reason, remember, rule) => answerCard({ id, decision, reason, remember, rule }),
    [answerCard],
  );
  // A pick on a relayed question (phase 14) — the same invalidation bundle as a
  // card's answer, since it takes a card down too.
  const pick = useApiMutation<
    { slug: string; approvalId: string; key: string; label: string },
    Awaited<ReturnType<typeof api.answerQuestion>>
  >({
    fn: ({ slug, approvalId, key, label }) => api.answerQuestion(slug, approvalId, [{ key, label }]),
    invalidates: keys.afterInboxAct(),
    onDone: (result, { label }) => {
      if (!result?.ok) toast(result?.error ?? 'the question could not be answered', 'warn');
      else
        toast(
          result.remaining ? `Answered “${label}” · ${result.remaining} left` : `Answered “${label}”`,
          'ok',
        );
    },
  });
  const { mutate: pickOption } = pick;
  const answerQuestion: Answer = useCallback(
    (approval, key, label) => pickOption({ slug: approval.slug, approvalId: approval.id, key, label }),
    [pickOption],
  );



  /* ---------------- the fleet ---------------- */

  const all = useMemo(() => toRows(runs ?? []), [runs]);
  // The plans list feeds two different needs here: the repo chips below, and
  // the closure cut — runs of a closed plan are history, not fleet, and are
  // hidden until the toolbar's "Show closed plans" reveals them.
  const { data: summaries } = usePlans(enabled);
  const closedSlugs = useMemo(
    () => new Set((summaries ?? []).filter((s) => isClosed(s)).map((s) => s.slug)),
    [summaries],
  );
  const cut = useMemo(() => partitionClosed(all, closedSlugs), [all, closedSlugs]);
  // Everything downstream — chips, counts, tiles, grouping, the hidden note —
  // reads the closure-cut base, so no number counts a row the table hides.
  const base = prefs.runsShowClosed ? all : cut.open;
  const filters: Filters = useMemo(
    () => ({ ...local, outcome: prefs.runsOutcome ?? '' }),
    [local, prefs.runsOutcome],
  );
  const sortId: SortId = isSortId(prefs.runsSort) ? prefs.runsSort : 'updated';
  const visible = useMemo(() => sortRows(applyFilters(base, filters), sortId), [base, filters, sortId]);
  const counts = useMemo(() => outcomeCounts(base), [base]);
  const plans = useMemo(() => planOptions(base), [base]);

  /**
   * Change the shape, and stop the address arguing with the preference.
   *
   * A press that only wrote the pref would be undone on the next render while
   * `?view=board` is still in the bar — the operator would press Table and stay
   * on the board. Clearing the query is what makes the choice stick, and the
   * navigation is `replace` because "I looked at the table" is not a step in
   * anybody's history.
   */
  const onView = useCallback(
    (next: RunsView) => {
      setPrefs({ runsView: next });
      if (route && runsViewOf(route)) go(runsHref(), { replace: true });
    },
    [setPrefs, route, go],
  );

  const onFilters = (patch: Partial<Filters>) => {
    const { outcome, ...rest } = patch;
    if (outcome !== undefined) setPrefs({ runsOutcome: outcome });
    if (Object.keys(rest).length) setLocal((current) => ({ ...current, ...rest }));
  };

  /* ---------------- the branches ---------------- */

  if (stale) {
    return (
      <Page title="Runs">
        <StaleServerNote />
      </Page>
    );
  }

  if (error) {
    return (
      <Page title="Runs">
        <PageError error={error} retry={() => void refetch()} />
      </Page>
    );
  }

  if (isPending && !runs) {
    return (
      <Page title="Runs" subtitle="Reading runs">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-20" />
          <Skeleton className="h-64" />
        </div>
      </Page>
    );
  }

  return (
    <Page
      title="Runs"
      subtitle={
        active
          ? `${active.slug} is running — phase ${active.activePhase ?? '?'}`
          : 'Nothing running right now'
      }
      actions={approvals.length ? <Chip tone="warn">{approvals.length} waiting on you</Chip> : undefined}
    >
      <div className="flex flex-col gap-4">
        {/* The vital signs, one glance high — a status line, not a workload
            item, which is why it sits above even the approval queue: its
            needs-you chip points DOWN at the queue and the fleet. */}
        <LiveStrip lanes={stripLanes} />

        {/* Then, always: a session parked with its hand up is the first thing
            on this page that is waiting on a person. */}
        <ApprovalQueue
          approvals={approvals}
          allowRun={allowRun}
          onDecide={decide}
          onAnswer={answerQuestion}
        />

        {looksLikeAuthFailure(active ?? null, auth) && (
          <AuthCard
            auth={auth}
            allowRun={allowRun}
            onRecheck={() => {
              void client.invalidateQueries({ queryKey: keys.auth() });
              void api.auth(true).then((fresh) => client.setQueryData(keys.auth(), fresh));
            }}
          />
        )}

        {consoleOpen ? (
          <div className="flex flex-col gap-3">
            {replaying ? (
              <SessionPanes
                slug={replaying.slug}
                runId={replaying.id}
                live={isLive(replaying.status)}
                allowRun={allowRun}
                enabled={enabled}
                title="Session console"
                subtitle={consoleSubtitle(active, replaying)}
                askPhase={isLive(replaying.status) ? replaying.activePhase : null}
              />
            ) : lanes.length ? (
              <LaneTabs
                lanes={lanes}
                runs={runs}
                picked={tab}
                onPick={setTab}
                preferredRunId={picked && isLive(picked.status) ? picked.id : undefined}
                allowRun={allowRun}
                enabled={enabled}
                entries={admission?.entries}
              />
            ) : (
              // Opened on a source that has never run anything: an empty tab
              // strip is a thinner nothing than the console saying what it
              // would show, and that copy is the whole point of opening it.
              <LiveConsole lines={[]} title="Session console" subtitle="idle" />
            )}
            {!active && (
              <button
                type="button"
                onClick={() => {
                  setPrefs({ runsConsole: false });
                  setWatchId(undefined);
                }}
                className="self-start text-2xs text-ink-faint hover:text-action"
              >
                Hide the console while nothing is running
              </button>
            )}
          </div>
        ) : (
          <IdleConsole run={watching} onOpen={() => setPrefs({ runsConsole: true })} />
        )}

        {base.length || cut.closed.length ? (
          <section className="flex flex-col gap-3" aria-label="This console's runs">
            {/* The switch, in BOTH shapes — a toggle only reachable from one
                side of itself is a trap door. */}
            <div className="flex items-center justify-end">
              <BoardToggle view={view} onView={onView} />
            </div>
            {view === 'board' ? (
              <RunsBoard
                runs={runs ?? []}
                state={state}
                entries={admission?.entries}
                advice={admission?.advice}
                allowRun={allowRun}
                totalRuns={all.length}
              />
            ) : (
              <>
                <Card className="p-3">
                  <Controls
                    sortId={sortId}
                    onSort={(id) => setPrefs({ runsSort: id })}
                    filters={filters}
                    onFilters={onFilters}
                    grouped={Boolean(prefs.runsGroup)}
                    onGrouped={(value) => setPrefs({ runsGroup: value })}
                    counts={counts}
                    plans={plans}
                    hidden={base.length - visible.length}
                    showClosed={Boolean(prefs.runsShowClosed)}
                    onShowClosed={(value) => setPrefs({ runsShowClosed: value })}
                    hiddenClosed={prefs.runsShowClosed ? 0 : cut.closed.length}
                  />
                </Card>
                {/* Two conditionals rather than one ternary, so the Pro half is
                    a whole marker region: exactly one of them still renders,
                    and the free tree keeps the empty state it would otherwise
                    have lost with the table. */}
                {!visible.length && (
                  <Empty
                    title="No run matches"
                    body={
                      base.length
                        ? `This console holds ${base.length} run${base.length === 1 ? '' : 's'}. Widen the filters to see them.`
                        : `${cut.closed.length} run${cut.closed.length === 1 ? '' : 's'} belong${cut.closed.length === 1 ? 's' : ''} to closed plans.`
                    }
                    action={
                      base.length ? (
                        <button
                          type="button"
                          className="text-sm text-action hover:underline"
                          onClick={() => {
                            setLocal({ query: '', plan: '' });
                            setPrefs({ runsOutcome: NO_FILTERS.outcome });
                          }}
                        >
                          Clear the filters
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="text-sm text-action hover:underline"
                          onClick={() => setPrefs({ runsShowClosed: true })}
                        >
                          Show closed plans
                        </button>
                      )
                    }
                  />
                )}
              </>
            )}
          </section>
        ) : (
          <Empty
            title="No runs yet"
            body="Open a plan and use its Autopilot tab to start one. Runs are recorded outside the repository, so nothing here shows up in git status."
            action={
              <Button size="sm" variant="action" asChild>
                <a href={plansHref()}>Pick a plan to run</a>
              </Button>
            }
          />
        )}
      </div>
    </Page>
  );
}

/**
 * Every live session on the machine, one tab each.
 *
 * Labelled `slug · P<n>` rather than by phase alone, because on this page two
 * tabs reading "Phase 5" are two different plans — the fact the run page can take
 * for granted and this one cannot.
 *
 * `forceMount` for the reason it is used on the run page: a pane that unmounts
 * unsubscribes, and the lines it misses while hidden are newer than the replay
 * that would otherwise have covered them.
 */
function LaneTabs({
  lanes,
  runs,
  picked,
  onPick,
  preferredRunId,
  allowRun,
  enabled,
  entries,
}: {
  lanes: readonly Lane[];
  /** The runs behind the lanes — where each lane's freeze is recorded. */
  runs: readonly RunState[] | undefined;
  picked: string | undefined;
  onPick: (id: string) => void;
  /** The run the fleet's Watch button asked for, until a tab is chosen by hand. */
  preferredRunId: string | undefined;
  allowRun: boolean;
  enabled: boolean;
  entries?: QueueEntry[] | undefined;
}) {
  const ids = lanes.map(crossLaneId);
  const runOf = (lane: Lane) => (runs ?? []).find((run) => run.id === lane.runId);
  const preferred = preferredRunId
    ? ids[lanes.findIndex((lane) => lane.runId === preferredRunId)]
    : undefined;
  const value = picked && ids.includes(picked) ? picked : (preferred ?? ids[0] ?? '');

  // The BODIES are `LanePane`'s, not this file's. This strip inlined its own
  // `QueuedPane`/`SessionPanes` pair — a second rendering of a lane, under a
  // second set of rules, which is how the run page and this one came to
  // disagree about what a queued lane shows. A lane whose run this page cannot
  // find is dropped rather than half-drawn: `LanePane` reads the run for the
  // lane's freeze, and a control that cannot see one offers a button that
  // answers 404.
  const items: LaneTabItem[] = lanes.flatMap((lane) => {
    const run = runOf(lane);
    if (!run) return [];
    return [
      {
        id: crossLaneId(lane),
        label: (
          <>
            <span className="font-mono">{lane.slug}</span>
            <span className="ml-1.5 text-ink-faint">P{lane.phase}</span>
            {lane.queued && <span className="ml-1.5 text-2xs text-ink-faint">queued</span>}
            {lane.qa && <span className="ml-1.5 text-2xs text-ink-faint">QA round {lane.qa.round}</span>}
          </>
        ),
        body: (
          <LanePane
            slug={lane.slug}
            run={run}
            lane={lane}
            live
            allowRun={allowRun}
            enabled={enabled}
            entries={entries}
            title={`${lane.slug} · phase ${lane.phase}`}
            subtitle={lane.status}
          />
        ),
      },
    ];
  });

  return <LaneTabStrip value={value} onValueChange={onPick} items={items} />;
}

/** What the console is showing: the live run, the one you picked, or nothing. */
function consoleSubtitle(active: RunState | undefined, watching: RunState | undefined): string {
  if (watching && !isLive(watching.status)) return `${watching.slug} · ${watching.id} · ${watching.status}`;
  if (active) return `${active.slug} · phase ${active.activePhase ?? '?'} · ${active.model}`;
  if (watching) return `${watching.slug} · ${watching.id} · ${watching.status}`;
  return 'idle';
}

/**
 * The console, folded away.
 *
 * It still names what it would show, because "Session console" alone gives no
 * reason to press it — and the reason is usually that the last run is the one
 * you came to read about.
 */
function IdleConsole({ run, onOpen }: { run: RunState | undefined; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={false}
      className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-rule bg-surface-raised px-3 py-2 text-left hover:border-rule-strong [@media(hover:none)]:min-h-(--tap-min)"
    >
      <Radio size={14} className="shrink-0 text-ink-faint" aria-hidden />
      <span className="shrink-0 text-sm">Session console</span>
      <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-faint">
        {run
          ? `idle · last: ${run.slug} ${run.status} ${relativeTime(Date.parse(run.updatedAt))}`
          : 'idle · nothing has run in this source'}
      </span>
      <ChevronRight size={14} className="shrink-0 text-ink-faint" aria-hidden />
    </button>
  );
}
