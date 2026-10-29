/**
 * The plan's Run view — `#/plan/:slug/run` (7.0, quiet-console phase 11).
 *
 * Two readings, as real links: the run in front of you (no `?view=`), and
 * `?view=history` — every run of the plan, a past one opened with `?run=`.
 *
 * The live reading opens on a glance, in the order a person asks: the run's
 * row as its head (one action, the halt view first), what waits on a person
 * (its asks), why it stopped (the halt card, its one recommended move inside)
 * and every standing notice, a budget near its line, the lanes with their
 * clocks, then the verbs. Everything else is folded under a row that names
 * what opening it shows and how much is in it — the phases, the sessions and
 * their consoles, the journal, what the ladder tried, what each phase's
 * §Verification came to, the stored triggers, the time, the cost, the notes,
 * the mailbox, the checkout, the landing, the ways forward and the raw
 * record — remembered per person, and all open under the
 * page's Everything. Inspect puts the run in the panel: its eight sections and
 * its Actions.
 *
 * Every number comes from the run's own record, re-read on the run's events
 * (`data/live.ts`): nothing here is recomputed in the browser, for the reason
 * the board never is — two sources of truth disagree eventually, and the one on
 * screen is the one believed.
 *
 * The figures of the time fold and a phase's attempts are lazy chunks of their
 * own, fetched the first time they are drawn.
 */

import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { api, type PlanDetail, type RunDetail, type RunState } from '@/data/api';
import { useAccounts } from '@/data/accounts';
import { useConsoleState } from '@/data/console';
import { keys } from '@/data/keys';
import { isLive, lanesOf } from '@/data/lanes';
import { useAuth } from '@/data/machine';
import { useQueue, useRunScopes } from '@/data/queue';
import { useJournal, useLedger, useRulings, useRun, useTimeline, useTriggers } from '@/data/runs';
import { useSessions } from '@/data/sessions';
import { useRunVerifications } from '@/data/verification';
import { useNow } from '@/ui/clock';
import { cn } from '@/lib/cn';
import { looksLikeAuthFailure } from '@/lib/failures';
import { scrollIntoScroller } from '@/lib/scroll';
import { Button, Spinner, type Everything } from '@/ui';
import { useRoute } from '@/shell/router';
import { navigate, runPaneOf, runViewHref, withQuery } from '@/shell/routes';
import { SectionNav } from '@/shell/section-nav';
import { PhaseTable } from '@/screens/plan/phases/table';
import { ACCOUNT_RECOVERY_PARTS } from '@/screens/settings/account-row';
import { runViewOf } from '../tabs';
import { bindingHoldOf } from '@/screens/runs/model';
import { RunCheckout } from './git-card';
import { RunGlance } from './glance';
import { AuthCard, RunAsks, RunBudgetBanners, RunNotes, StaleServerNote } from './halt';
import { RunHistoryView } from './history';
import { inspectRunView } from './inspector';
import { JOURNAL_PARAM, RunJournal } from './journal';
import { RunLanes } from './lanes';
import { RunCostLedger } from './ledger';
import { RunOperatorNotes } from './notes';
import { RunRungs } from './rungs';
import { RUN_FOLD_WORDS, useRunFold, type RunFoldId } from './sections';
import { RunSessions } from './session-panes';
import { RunVerbs } from './settings-sheet';
import { RunTriggers } from './triggers';
import { RunVerificationFold } from './verification';
import { RunWaysForward } from './ways-forward';
import { RunWhyStarted } from './why-started';

/** The time fold's figures and a phase's attempts: their own chunks, fetched when first drawn. */
const RunGantt = lazy(() => import('./gantt').then((m) => ({ default: m.RunGantt })));
const RunClockSplit = lazy(() => import('./timeline').then((m) => ({ default: m.RunClockSplit })));
const RunAttempts = lazy(() => import('./attempts').then((m) => ({ default: m.RunAttempts })));

/** The phase statuses a stopped phase settles in — the ways-forward fold counts them. */
const STOPPED = new Set(['failed', 'interrupted', 'parked']);

export default function RunView({
  detail,
  view,
  everything,
}: {
  detail: PlanDetail;
  view?: string | undefined;
  everything?: Everything | undefined;
}) {
  const slug = detail.summary.slug;
  const route = useRoute();
  const { data: state } = useConsoleState();
  // A console whose server predates the autopilot has no run endpoints: the
  // honest page says why, rather than a stack of failed requests.
  const stale = state != null && state.autopilot === false;
  const { data: detailRun, isPending } = useRun(slug, !stale);
  const reading = runViewOf(view);

  if (stale) return <StaleServerNote />;
  if (isPending && !detailRun) return <Spinner label="Reading the run" />;

  const history = detailRun?.history ?? [];
  const run = detailRun?.run ?? null;
  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="run-view" data-reading={reading}>
      <SectionNav
        label="Readings of the run"
        current={reading}
        sections={[
          { id: 'live', label: 'This run', href: runViewHref(slug) },
          {
            id: 'history',
            label: 'History',
            href: runViewHref(slug, 'history'),
            ...(history.length ? { count: history.length } : {}),
          },
        ]}
      />
      {reading === 'history' ? (
        <RunHistoryView
          slug={slug}
          detail={detail}
          history={history}
          currentId={run?.id ?? null}
          picked={route.query.run ?? null}
        />
      ) : (
        <LiveRun detail={detail} detailRun={detailRun} everything={Boolean(everything?.on)} />
      )}
    </div>
  );
}

function LiveRun({
  detail,
  detailRun,
  everything,
}: {
  detail: PlanDetail;
  detailRun: RunDetail | undefined;
  everything: boolean;
}) {
  const slug = detail.summary.slug;
  const route = useRoute();
  const client = useQueryClient();
  const { data: state } = useConsoleState();
  const allowRun = Boolean(state?.allowRun);
  const allowWrites = Boolean(state?.allowWrites);
  const run = detailRun?.run ?? null;
  const live = isLive(run?.status ?? '');
  const liveness = detailRun?.liveness ?? [];
  const stillWorking = !live && liveness.length > 0;
  const now = useNow(live, 1000);

  const lanes = useMemo(
    () => (run ? lanesOf([run], new Map([[slug, detail]]), now) : []),
    [run, slug, detail, now],
  );
  const queuedHere = lanes.some((lane) => lane.status === 'queued');
  const { data: admission } = useQueue(queuedHere);
  const { data: scopes } = useRunScopes(slug, Boolean(run));
  const { data: journal } = useJournal(slug, undefined, 500, Boolean(run));
  const { data: timeline } = useTimeline(slug, undefined, Boolean(run));
  const { data: ledger } = useLedger(slug, undefined, Boolean(run));
  // The fold's own first read, so its row can say how much it holds.
  const { data: verifications } = useRunVerifications(slug, { enabled: Boolean(run) });
  const { data: rulings } = useRulings(slug);
  const { data: triggers } = useTriggers(slug);
  const { data: auth } = useAuth(Boolean(run));
  const { data: accountsState } = useAccounts();
  const { data: terminals } = useSessions(state);
  const [comparePhase, setComparePhase] = useState<number | null>(null);

  // The run's OWN account decides an auth halt: the machine login's probe
  // says nothing about the profile a pinned run pays with.
  const runAccount = run?.accountId
    ? accountsState?.accounts.find((candidate) => candidate.id === run.accountId)
    : undefined;
  const authFailure = Boolean(looksLikeAuthFailure(run, auth, runAccount));
  const haltPhase = run?.halt?.phase ?? run?.activePhase ?? undefined;
  const target = {
    slug,
    ...(haltPhase != null ? { phase: haltPhase } : {}),
    ...(run?.id ? { runId: run.id } : {}),
  };
  const planSkills = detail.plan?.sessionBudget?.skills ?? [];
  const planMcp = detail.plan?.sessionBudget?.mcpServers ?? [];
  const planReviewers = detail.plan?.reviewers ?? [];
  const records = useMemo(() => Object.values(run?.phases ?? {}).sort((a, b) => a.phase - b.phase), [run]);
  const stopped = records.filter((record) => STOPPED.has(record.status)).length;
  // A link that names a pane (`?lane=p7`, `?lane=run`) or a journal line (`?j=`) lands in its fold.
  const laneAsked = /^p(\d{1,4})$/.exec(route.query.lane ?? '')?.[1];
  const paneAsked = runPaneOf(route) != null;
  const journalLinked = route.query[JOURNAL_PARAM] != null;
  // The run timeline's window (#376): `?zoom=` opens its fold and names what it shows.
  const zoomAsked = route.query.zoom != null;
  const onZoom = useCallback(
    (zoom: string | null) => {
      const { zoom: _drop, ...rest } = route.query;
      navigate(withQuery(route, zoom ? { ...rest, zoom } : rest), { replace: true });
    },
    [route],
  );

  const recheck = useCallback(() => {
    if (run?.accountId) {
      // That account, not the machine login: "I signed in over there, look again".
      void api
        .accountRefresh(run.accountId)
        .finally(() => void client.invalidateQueries({ queryKey: keys.accounts() }));
      return;
    }
    void client.invalidateQueries({ queryKey: keys.auth() });
    void api.auth(true).then((fresh) => client.setQueryData(keys.auth(), fresh));
  }, [client, run?.accountId]);

  const inspectRun = useCallback(() => {
    if (run) inspectRunView({ run, slug, state, allowRun });
  }, [run, slug, state, allowRun]);

  // A verb the head cannot press alone (it needs words or a dialog) is the
  // halt card's: bring the card to the middle of the screen.
  const toHalt = useCallback(() => {
    const card = document.querySelector('[data-testid="run-notes"] [data-halt-category]');
    if (card) scrollIntoScroller(card, 'center');
  }, []);

  return (
    <>
      {run ? (
        <RunGlance
          run={run}
          detail={detail}
          state={state}
          allowRun={allowRun}
          live={live}
          now={now}
          eta={detailRun?.eta ?? null}
          phaseEta={detailRun?.phaseEta ?? []}
          liveness={liveness}
          onInspect={inspectRun}
          onAct={toHalt}
        />
      ) : (
        <p className="text-body text-ink-muted" data-testid="run-none">
          This plan has no run yet.
        </p>
      )}

      {/* First, always: a session parked with its hand up is the one thing here waiting on a person. */}
      <RunAsks {...(run?.id ? { runId: run.id } : {})} slug={slug} />

      {authFailure && <AuthCard auth={auth} allowRun={allowRun} account={runAccount} onRecheck={recheck} />}

      <RunNotes
        slug={slug}
        run={run}
        live={live}
        allowRun={allowRun}
        git={detailRun?.git ?? null}
        fleetHold={bindingHoldOf(state)}
        authFailure={authFailure}
        target={target}
      />

      {run && live && <RunBudgetBanners slug={slug} run={run} />}

      {run && (
        <RunLanes
          slug={slug}
          run={run}
          detail={detail}
          live={live}
          allowRun={allowRun}
          phaseEta={detailRun?.phaseEta ?? []}
          {...(laneAsked ? { laneAsked: Number(laneAsked) } : {})}
        />
      )}

      <RunVerbs
        slug={slug}
        run={run}
        live={live}
        stillWorking={stillWorking}
        allowRun={allowRun}
        allowWrites={allowWrites}
        planPhases={detail.phases}
        planSkills={planSkills}
        planMcp={planMcp}
        planReviewers={planReviewers}
        {...(detail.summary.qaMode ? { qaMode: detail.summary.qaMode } : {})}
      />

      <div
        className="flex min-w-0 flex-col border-t border-rule pt-2"
        data-testid="run-sections"
        role="group"
        aria-label="Everything else about this run"
      >
        <RunFold id="phases" count={detail.phases.length} everything={everything}>
          <PhaseTable
            slug={slug}
            run={run}
            planPhases={detail.phases}
            live={live}
            allowRun={allowRun}
            queue={admission?.entries}
            scopes={scopes?.scopes}
            phaseEta={detail.eta?.perPhase}
            liveness={liveness}
            rulings={rulings?.rulings}
            inspectable
            recovery={{
              allowAgent: Boolean(state?.allowAgent),
              authFailure,
              sessions: terminals?.sessions,
              ...(detail.summary.qaMode ? { qaMode: detail.summary.qaMode } : {}),
              planSkills,
              planReviewers,
              allowWrites,
            }}
          />
        </RunFold>

        {/* The consoles keep their lines and their stream in their panes, so
            once opened the fold hides rather than unmounts them — a pane that
            unmounts loses lines no replay refills. */}
        {run && (
          <RunFold
            id="sessions"
            count={lanes.length}
            keepMounted
            forceOpen={paneAsked}
            everything={everything}
          >
            <RunSessions
              slug={slug}
              run={run}
              detail={detail}
              live={live}
              allowRun={allowRun}
              enabled
              entries={admission?.entries}
              scopes={scopes?.scopes}
              phaseEta={detailRun?.phaseEta ?? []}
            />
          </RunFold>
        )}

        {run && (
          <RunFold
            id="journal"
            count={journal ? journal.length : null}
            forceOpen={journalLinked}
            everything={everything}
          >
            <RunJournal entries={journal ?? []} />
          </RunFold>
        )}

        {run && (
          <RunFold id="rungs" count={ledger ? ledger.rungs.length : null} everything={everything}>
            <RunRungs ledger={ledger} />
          </RunFold>
        )}

        {run && (
          <RunFold
            id="verification"
            count={verifications ? verifications.total : null}
            everything={everything}
          >
            <RunVerificationFold slug={slug} run={run} planPhases={detail.phases} />
          </RunFold>
        )}

        {/* Per PLAN: a stored trigger outlives the run it was armed on, and a
            plan with no run yet can hold one. */}
        <RunFold id="triggers" count={triggers ? triggers.length : null} everything={everything}>
          <RunTriggers slug={slug} allowRun={allowRun} />
        </RunFold>

        {run && (
          <RunFold id="time" count={records.length} everything={everything} forceOpen={zoomAsked}>
            <Suspense fallback={<Spinner label="Drawing the time" />}>
              <div className="flex min-w-0 flex-col gap-6">
                {timeline ? (
                  <RunGantt
                    timeline={timeline}
                    run={run}
                    onCompare={setComparePhase}
                    zoom={route.query.zoom}
                    onZoom={onZoom}
                  />
                ) : null}
                <RunClockSplit phases={records} />
              </div>
            </Suspense>
          </RunFold>
        )}

        {run && (
          <RunFold id="ledger" count={ledger ? ledger.sessions.length : null} everything={everything}>
            <div className="flex min-w-0 flex-col gap-6">
              <RunWhyStarted ledger={ledger} manifest={run.manifest ?? null} everything={everything} />
              <RunCostLedger ledger={ledger} everything={everything} />
            </div>
          </RunFold>
        )}

        {run && (run.notes?.length || allowRun) ? (
          <RunFold id="notes" count={run.notes?.length ?? 0} everything={everything}>
            <RunOperatorNotes run={run} allowRun={allowRun} everything={everything} />
          </RunFold>
        ) : null}


        {run && (run.checkout === 'worktree' || run.checkout === 'refused' || detailRun?.git != null) && (
          <RunFold id="git" count={detailRun?.git?.checkouts.length ?? null} everything={everything}>
            <RunCheckout run={run} git={detailRun?.git} />
          </RunFold>
        )}


        {!live && stopped > 0 && (
          <RunFold id="ways" count={stopped} everything={everything}>
            <RunWaysForward
              slug={slug}
              planPhases={detail.phases}
              run={run}
              live={live}
              authFailure={authFailure}
              parts={ACCOUNT_RECOVERY_PARTS}
            />
          </RunFold>
        )}

        {run && (
          <RunFold id="raw" everything={everything}>
            <RawRecord run={run} />
          </RunFold>
        )}
      </div>

      {comparePhase != null && (
        <Suspense fallback={null}>
          <RunAttempts slug={slug} phase={comparePhase} onClose={() => setComparePhase(null)} />
        </Suspense>
      )}
    </>
  );
}

/** The record as the machine holds it. */
function RawRecord({ run }: { run: RunState }) {
  return (
    <pre
      data-testid="run-raw"
      className="max-h-[60vh] min-w-0 overflow-auto rounded-sm border border-rule p-2 font-mono text-meta whitespace-pre-wrap"
    >
      {JSON.stringify(run, null, 2)}
    </pre>
  );
}

/**
 * One fold: a row that names what opening it shows and, folded, how much is
 * in it. Open while the person left it open, while a link points into it, or
 * under the page's Everything. A `keepMounted` fold mounts its body the first
 * time it opens and from then on hides it instead of unmounting it — nothing
 * is fetched or held for a fold nobody opened.
 */
function RunFold({
  id,
  count,
  forceOpen = false,
  keepMounted = false,
  everything,
  children,
}: {
  id: RunFoldId;
  /** How much is folded — drawn only while folded; `null` draws none (not read yet). */
  count?: number | null;
  forceOpen?: boolean;
  keepMounted?: boolean;
  everything: boolean;
  children: ReactNode;
}) {
  const [remembered, setOpen] = useRunFold(id);
  const open = remembered || forceOpen || everything;
  const [opened, setOpened] = useState(open);
  useEffect(() => {
    if (open) setOpened(true);
  }, [open]);
  const mounted = keepMounted && (open || opened);
  const region = useId();
  const words = RUN_FOLD_WORDS[id];
  return (
    <section
      data-section={id}
      data-open={open ? 'true' : 'false'}
      aria-label={words.name}
      className="min-w-0"
    >
      <Button
        variant="ghost"
        aria-expanded={open}
        aria-controls={open || mounted ? region : undefined}
        onClick={() => setOpen(!open)}
        title={words.counts}
        data-testid="run-section-toggle"
        className={cn(
          'h-auto min-h-9 w-full min-w-0 justify-start gap-2 px-0 py-1.5 text-body text-ink',
          'hover:bg-transparent [@media(hover:none)]:min-h-(--tap-min)',
        )}
      >
        <ChevronRight
          size={14}
          aria-hidden
          className={cn(
            'shrink-0 text-ink-muted transition-transform duration-fast ease-transit',
            open && 'rotate-90',
          )}
        />
        <span className="min-w-0 truncate">{words.name}</span>
        {count != null && !open && (
          <span className="tnum shrink-0 text-meta text-ink-muted" data-testid="run-section-count">
            ({count})
          </span>
        )}
      </Button>
      {keepMounted
        ? mounted && (
            <div id={region} hidden={!open} className="pb-3 pt-1">
              {children}
            </div>
          )
        : open && (
            <div className="expand-region">
              <div id={region} className="pb-3 pt-1">
                {children}
              </div>
            </div>
          )}
    </section>
  );
}
