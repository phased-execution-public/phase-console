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
  useApprovals,
  useAuth,
  useConsoleState,
  useConverge,
  usePlans,
  useQueue,
  useRuns,
} from '@/lib/queries';
import { usePrefs } from '@/lib/prefs';
import { relativeTime } from '@/lib/format';
import {
  Button,
  Badge,
  Empty,
  PageError,
  Skeleton,
} from '@/components/ui';
import { ApprovalQueue } from './approvals';
import { UndrivenCard } from './undriven';
import { LiveConsole } from './console';
import { isLive } from './defaults';
import { LaneTabStrip, type LaneTabItem } from './lanes';
import { LanePane } from './pane-host';
import { SessionPanes, crossLaneId, laneOf, type Lane } from './session-panes';
import { AuthCard, StaleServerNote, looksLikeAuthFailure } from './status-strip';
import { Page } from '@/components/page';
import { bindingHoldOf, type FleetHoldView } from '@/components/fleet-freeze';
import { BoardToggle } from './board';
import { Tower } from './tower/tower';
import { useTower } from './tower/use-tower';
import { plansHref, runsBayOf, runsHref, runsViewOf, type RunsView, type Route } from '@/app/routes';
import { useNavigate } from '@/app/router';
import { nowLanes } from '@/features/runs/lanes-model';
import { isClosed } from '@/lib/closure';
import {
  partitionClosed,
  toRows,
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
  // `?bay=` names a bay of the Tower, so it asks for the Tower for this visit
  // exactly as `?view=board` does (control-tower phase 20).
  const bay = route ? runsBayOf(route) : undefined;
  const asked: RunsView = (route ? runsViewOf(route) : undefined) ?? (bay ? 'board' : prefs.runsView);
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
  // What an empty Needs-you bay says about the loop's next look (Now said it
  // until 6.0) — read only while the Tower is the shape on screen.
  const { data: converge } = useConverge(enabled && view === 'board');
  const { data: auth } = useAuth(enabled);

  const [watchId, setWatchId] = useState<string | undefined>();
  const [tab, setTab] = useState<string | undefined>();

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



  /* ---------------- the fleet ---------------- */

  // A stopped run's promise to continue is read through the hold binding the
  // console now — a freeze is named instead of "it continues by itself" (#93).
  // Keyed by its words, so a poll that re-reads the same hold keeps the rows.
  const holdKey = JSON.stringify(bindingHoldOf(state));
  const all = useMemo(() => toRows(runs ?? [], JSON.parse(holdKey) as FleetHoldView | null), [runs, holdKey]);
  // The plans list feeds two different needs here: the repo chips below, and
  // the closure cut — runs of a closed plan are history, not fleet, and are
  // hidden until the toolbar's "Show closed plans" reveals them.
  const { data: summaries } = usePlans(enabled);
  const closedSlugs = useMemo(
    () => new Set((summaries ?? []).filter((s) => isClosed(s)).map((s) => s.slug)),
    [summaries],
  );
  const cut = useMemo(() => partitionClosed(all, closedSlugs), [all, closedSlugs]);
  // Everything downstream — the ledger's filters, tiles and groups, and the
  // count of what the cut holds back — reads the closure-cut base, so no
  // number counts a row the table hides.
  const base = prefs.runsShowClosed ? all : cut.open;

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

  /**
   * The Tower's ONE fold (control-tower phase 20) — the bays below and the
   * situation line in the page's header read the same model. The inbox is read
   * whichever shape is showing (the shell's bell already holds it); the Ready
   * bay's plan details, one engine read each, only while the Tower is drawn.
   */
  const tower = useTower({
    runs: runs ?? [],
    lanes: stripLanes,
    entries: admission?.entries,
    plans: summaries ?? [],
    enabled,
    details: enabled && view === 'board',
  });

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
    // The situation line is the header's since 6.0 (control-tower phase 21):
    // it sits above this title on every page, so the page does not say it twice.
    <Page
      title="Runs"
      actions={approvals.length ? <Badge tone="accent">{approvals.length} waiting on you</Badge> : undefined}
    >
      <div className="flex flex-col gap-4">
        {/* Then, always: a session parked with its hand up is the first thing
            on this page that is waiting on a person. */}
        <ApprovalQueue />

        {/* Beside it, the other ask only a person answers: a phase the board
            reads in progress that nothing of its live run drives (#114). */}
        <UndrivenCard runs={runs ?? []} allowRun={allowRun} />


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

        {base.length || cut.closed.length || (view === 'board' && tower.model.ready.length) ? (
          <section className="flex flex-col gap-3" aria-label="This console's runs">
            {/* The switch, in BOTH shapes — a toggle only reachable from one
                side of itself is a trap door. The Tower draws it at the end of
                its own toolbar row. */}
            {view !== 'board' && (
              <div className="flex items-center justify-end">
                <BoardToggle view={view} onView={onView} />
              </div>
            )}
            {view === 'board' && (
              <Tower
                model={tower.model}
                state={state}
                entries={admission?.entries}
                advice={admission?.advice}
                allowRun={allowRun}
                focus={bay}
                readyLoading={tower.readyLoading}
                switcher={<BoardToggle view={view} onView={onView} />}
                totalRuns={all.length}
                converge={converge}
              />
            )}
            {/* The ledger is the Pro tree's second shape (control-tower phase
                21: `DataTable`'s `runs-ledger`); the free tree has only the
                Tower, so this is one whole marker region. */}
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

        {/* The sessions themselves, below the Tower: the bays answer "does
            anything need me", and a transcript is what you read once you know. */}
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
