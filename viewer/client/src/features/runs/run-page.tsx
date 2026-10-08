/**
 * The autopilot: what the run is doing, and the controls to change it.
 *
 * Two audiences at once. Sitting at the desk you want the transcript, the costs
 * and the board. On a phone at 11pm you want one question answered — "does this
 * need me?" — so approvals come first, carry their evidence, and are answerable
 * without scrolling past anything.
 *
 * Every number here comes from the server's run state. Nothing is recomputed in
 * the browser, for the same reason the board never is: two sources of truth
 * disagree eventually, and the one on screen is the one that gets believed.
 *
 * ## What changed from the 1,646-line original
 *
 * - **The nine-plus banners are one `StatusStack`** with a declared priority
 *   (`status.tsx`), instead of eleven independent call sites in source order.
 * - **The data plane is TanStack Query**, so the page no longer blanks itself on
 *   every event: the old view held the run in `useState` and set it to `null`
 *   before each refetch. Nothing here calls `refresh()`; the cache is
 *   invalidated by `EVENT_EFFECTS` and re-renders when the answer changes.
 * - **The firehose stays out of the cache.** `run:stream` is subscribed to
 *   directly (`useSessionStream`, inside each `SessionPanes`) and appended.
 * - **The monolith is eight modules.** This one is composition and the two
 *   things that genuinely need to live at the top: the `act()` wrapper and the
 *   `busy` label it drives.
 *
 * ## A glance, then everything (control-tower phase 24)
 *
 * The page opens on a glance: the run's strip as its header (the Tower's
 * strip, `row` variant — the word, the attempt clock with the phase total, the
 * track, the cost, the one action), the facts the strip does not carry, the
 * asks, the halt card when the run is stopped, the verbs and the four figures.
 * Everything else — phases, sessions and their consoles, where the time went,
 * why it started and what it cost, notes, messages, the checkout, the landing,
 * the journal, earlier runs and the raw record — is folded under a row that
 * names it and counts it (`run-sections.tsx`), remembered per person. Nothing
 * the page showed is gone: every datum is at most two presses away
 * (`run-page.datums.test.tsx`).
 *
 * ## One window per session
 *
 * The page had one console because a run had one session. It can now drive
 * several phases at once, so the console is a tab strip: a **Run** tab carrying
 * the whole run's narration, and one tab per live or queued lane, each owning its
 * own console, task list and tool log (`session-panes.tsx`). Two sessions'
 * sentences in one window is a page that is wrong with nothing on it to say so.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Spinner, toast } from '@/components/ui';
import { api, type PlanDetail } from '@/lib/api';
import {
  useAccounts,
  useApiMutation,
  useAuth,
  useConsoleState,
  useJournal,
  useQueue,
  useTimeline,
  useLedger,
  useRulings,
  useRun,
  useRunScopes,
  useSessions,
} from '@/lib/queries';
import { keys } from '@/lib/queries';
import { useQueryClient } from '@tanstack/react-query';
import { planHref } from '@/app/routes';
import { useNow } from '@/lib/clock';
import type { LabelledClock } from '@/lib/format';
import { PHASE_CLOCK_LABELS } from '@shared/phase-clocks.js';
import { isLive } from './defaults';
import { ApprovalQueue } from './approvals';
import { Controls } from './lane-setup';
import { LiveConsole } from './console';
import { RunHeader, RunTiles } from './tiles';
import { GitCard, hasGitStory } from './git-card';
import { PhaseTable } from './phase-table';
import { NextSteps } from './ways-forward';
import { SessionTabs } from './lanes';
import { LiveNow } from './now-panel';
import { BudgetApproaching } from './budget-approaching';
import { ReviewNow } from './review-now';
import { lanesOf } from './session-panes';
import { AuthCard, RunStatusStack, StaleServerNote, looksLikeAuthFailure } from './status-strip';
import { bindingHoldOf } from '@/components/fleet-freeze';
import { RunHistory } from './history';
import { Timeline } from './timeline';
import { Gantt } from './gantt';
import { AttemptCompare } from './attempt-compare';
import { Journal, linkedSeq } from './journal';
import { nowLanes } from './lanes-model';
import { RunSection } from './run-sections';
import { Strip } from './tower/strip';
import { recordClocks } from './tower/clocks';
import { LedgerCard } from './ledger';
// A run's notes are both editions' (phase 96's route and record are free).
import { NotesCard } from './notes';
import { WhyStarted } from './why-started';
import { RecoveryActions } from '@/components/recovery-actions';

/** Does the address name one of the journal's lines (`?j=<seq>`, the Now panel's links)? */
function useJournalLink(): boolean {
  const [linked, setLinked] = useState(() => linkedSeq() != null);
  useEffect(() => {
    const read = () => setLinked(linkedSeq() != null);
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  return linked;
}

export function RunView({ detail }: { detail: PlanDetail }) {
  const slug = detail.summary.slug;
  const planPhases = detail.phases;
  const planSkills = detail.plan?.sessionBudget?.skills ?? [];
  const planMcp = detail.plan?.sessionBudget?.mcpServers ?? [];
  const planReviewers = detail.plan?.reviewers ?? [];

  const client = useQueryClient();
  const { data: state } = useConsoleState();
  // The client is served fresh from disk; the server is whatever Node loaded at
  // startup. Upgrading the skill under a running console leaves this page talking
  // to an API that has no run endpoints, and the honest thing to show is why —
  // not a stack of failed requests.
  const stale = state != null && state.autopilot === false;
  const allowRun = Boolean(state?.allowRun);
  const enabled = !stale;

  const { data: detailRun, isPending } = useRun(slug, enabled);
  const { data: auth } = useAuth(enabled);

  const run = detailRun?.run ?? null;
  const live = isLive(run?.status);

  // Admission — the only place an answer to "why is this not running" can come
  // from, because the answer is always about some OTHER plan. The queue is asked
  // for only when this run actually has a phase in it: on the ordinary page
  // nothing renders the answer, and a request whose result is never read is a
  // request that should not have been made.
  const queuedHere = lanesOf(run).some((lane) => lane.queued);
  const { data: admission } = useQueue(enabled && queuedHere);
  const { data: scopes } = useRunScopes(slug, enabled && Boolean(run));
  // The audit trail and the ledger. The journal is per RUN and asked for only
  // once there is one; the ledger is per PLAN and answers before any run
  // exists — which is every plan somebody is driving by hand.
  const { data: journal } = useJournal(slug, undefined, 500, enabled && Boolean(run));
  const { data: timeline } = useTimeline(slug, undefined, enabled && Boolean(run));
  // Why each start happened and what every session cost (phase 19) — the run's
  // ledger, read from the same journal the timeline projects.
  const { data: runLedger } = useLedger(slug, undefined, enabled && Boolean(run));
  // Which phase's attempts are open in the drawer. `null` is closed; the Gantt
  // is the only thing that opens it, and only for a phase with two boardings.
  const [comparePhase, setComparePhase] = useState<number | null>(null);
  const { data: ledger } = useRulings(slug, enabled);

  // The strip's lanes, from the same fold the Tower draws (`nowLanes`), so the
  // header of this page and this run's strip in the Tower are one reading.
  const stripLanes = useMemo(
    () => (run ? nowLanes([run], new Map([[slug, detail]])) : []),
    [run, slug, detail],
  );
  // The phase total beside the strip's attempt clock (#28): the phase that
  // clock is about — the lane moving now, else the stop, else the active one.
  const now = useNow(live, 1000);
  const totalPhase = lanesOf(run).find((lane) => !lane.queued)?.phase ?? run?.halt?.phase ?? run?.activePhase;
  const totalRecord = totalPhase != null ? run?.phases?.[String(totalPhase)] : undefined;
  const phaseTotal: LabelledClock | null =
    totalRecord && (live || run?.halt)
      ? {
          verb: 'worked',
          ms: recordClocks(totalRecord, now).workedMs,
          tense: 'for',
          label: PHASE_CLOCK_LABELS.workedMs,
        }
      : null;
  const journalLinked = useJournalLink();

  /* ---- recovery: what an AI session could put right, and whether one is on it ---- */
  const { data: terminals } = useSessions(state);
  const allowAgent = Boolean(state?.allowAgent);
  // The run's OWN account decides whether this is an auth halt: the machine
  // login's probe says nothing about the profile a pinned run pays with.
  const { data: accountsState } = useAccounts();
  const runAccount = run?.accountId
    ? accountsState?.accounts.find((candidate) => candidate.id === run.accountId)
    : undefined;
  const authFailure = Boolean(looksLikeAuthFailure(run, auth, runAccount));
  const haltPhase = run?.halt?.phase ?? run?.activePhase ?? undefined;

  /**
   * Run one action, then re-read.
   *
   * The mechanism is the shared `useApiMutation`, which is what puts the
   * re-read in `onSettled` — the whole point. A card answered on a phone leaves
   * this tab holding one that no longer exists; pressing it 404s, the error is
   * toasted, and with the refresh in the success leg it was skipped, so the
   * phantom stayed on screen and the next press 404'd again. The failure is
   * exactly the case where re-reading matters most.
   *
   * What is local is the LABEL. Every verb on this page disables itself and
   * renames itself while it is in flight ("Stopping…", "Arming…"), and the
   * mutation's own `variables` is where the label in flight lives — one
   * mutation, one label, no second piece of state to leave set when a request
   * dies with the tab.
   */
  const action = useApiMutation<{ label: string; call: () => Promise<unknown> }, unknown>({
    fn: ({ call }) => call(),
    invalidates: keys.afterRunAct(slug),
  });
  const { mutateAsync } = action;
  const busy = action.isPending ? (action.variables?.label ?? '') : '';

  const act = useCallback(
    (label: string, call: () => Promise<unknown>): Promise<void> =>
      // Settled, never rejected: every caller writes `void act(…)`, and a
      // rejection here would be an unhandled one. The failure has already been
      // reported — `useApiMutation` toasts the server's own words.
      mutateAsync({ label, call }).then(
        () => undefined,
        () => undefined,
      ),
    [mutateAsync],
  );

  if (stale) return <StaleServerNote />;
  if (isPending && !detailRun) return <Spinner label="Reading run state" />;

  const phases = Object.values(run?.phases ?? {}).sort((a, b) => a.phase - b.phase);
  const history = detailRun?.history ?? [];

  return (
    <div className="flex flex-col gap-4">
      {/* The glance: the run's strip heads its own page (control-tower phase
          24), with the facts it does not carry on the line beneath. */}
      {run && (
        <div className="flex flex-col gap-1.5" data-testid="run-head">
          <Strip
            run={run}
            lanes={stripLanes}
            {...(admission?.entries?.find((entry) => entry.slug === slug)
              ? { entry: admission.entries.find((entry) => entry.slug === slug)! }
              : {})}
            allowRun={allowRun}
            variant="row"
            total={phaseTotal}
          />
          <RunHeader
            run={run}
            live={live}
            eta={detailRun?.eta ?? null}
            phaseEta={detailRun?.phaseEta ?? []}
          />
        </div>
      )}

      {/* First, always: a session parked with its hand up is the only thing on
          this page that is waiting on a person — each ask drawn as its item. */}
      <ApprovalQueue runId={run?.id} slug={slug} />

      {authFailure && (
        <AuthCard
          auth={auth}
          allowRun={allowRun}
          account={runAccount}
          onRecheck={() => {
            if (run?.accountId) {
              // Re-read THAT account, not the machine login — this is the
              // "I signed in over there, look again" button.
              void api
                .accountRefresh(run.accountId)
                .then(() => client.invalidateQueries({ queryKey: keys.accounts() }))
                .catch(() => client.invalidateQueries({ queryKey: keys.accounts() }));
              return;
            }
            void client.invalidateQueries({ queryKey: keys.auth() });
            void api.auth(true).then((fresh) => client.setQueryData(keys.auth(), fresh));
          }}
        />
      )}

      <RunStatusStack
        run={run}
        live={live}
        allowRun={allowRun}
        busy={busy}
        git={detailRun?.git}
        fleetHold={bindingHoldOf(state)}
        onClearScope={() =>
          void act('scope', async () => {
            await api.runSettings(slug, { onlyPhases: [] });
            toast('Scope cleared — this run continues through the whole plan', 'ok');
          })
        }
        onGuard={() =>
          void act('profile', async () => {
            await api.runSettings(slug, { permissionProfile: 'guarded' });
            toast('Back to Guarded — the next call that matters raises a card', 'ok');
          })
        }
        recovery={{
          ...(authFailure ? { authFailure: true } : {}),
          target: {
            slug,
            ...(haltPhase != null ? { phase: haltPhase } : {}),
            ...(run?.id ? { runId: run.id } : {}),
          },
        }}
      />

      {/* The plan-level recovery, one press: confirm the stop against the
          board, stand down what it settled, recover or continue what is real.
          The phase-level offers live on the halt banner and each row. */}
      {run && !live && !run.resolved && ['halted', 'interrupted', 'parked'].includes(run.status) && (
        <RecoveryActions target={{ slug, runId: run.id }} ctx={{ run }} max={2} legend account />
      )}

      {/* Every stopped phase's cause in its own words, with the action that
          moves it — a status word alone was a dead end (reported twice). */}
      <NextSteps slug={slug} planPhases={planPhases} run={run} live={live} authFailure={authFailure} />

      <Controls
        slug={slug}
        run={run}
        live={live}
        busy={busy}
        allowRun={allowRun}
        planPhases={planPhases}
        planSkills={planSkills}
        planMcp={planMcp}
        planReviewers={planReviewers}
        qaMode={detail.summary.qaMode}
        allowWrites={Boolean(state?.allowWrites)}
        liveness={detailRun?.liveness}
      />

      {run && (
        <RunTiles run={run} phases={phases} total={detail.phases.length} liveness={detailRun?.liveness} />
      )}

      {/* A budget near its end, with its raise, before the park (phase 25, #40). */}
      {run && live && <BudgetApproaching slug={slug} run={run} />}
      {/* One cloud review of the branch, on a person's press (phase 25). */}
      {run && (
        <div className="flex justify-end">
          <ReviewNow slug={slug} disabled={!allowRun} />
        </div>
      )}

      {/* What each live lane is doing, what is done and left, what it waits
          on, why it is slow and when it should finish (control-tower phase 95,
          #163) — refreshed by the journal, no reload. */}
      {run && live && (
        <LiveNow
          slug={slug}
          phases={[
            ...new Set(
              lanesOf(run)
                .filter((lane) => !lane.qa)
                .map((lane) => lane.phase),
            ),
          ]}
        />
      )}

      {/* Everything else, one press away — each fold names what it shows and,
          while folded, how much is in it; remembered per person. */}
      <div
        className="flex min-w-0 flex-col gap-1 border-t border-rule pt-2"
        data-testid="run-sections"
        aria-label="Everything else about this run"
        role="group"
      >
        {/* Always there: a plan with no phase graph is a fact about the PLAN,
            and the table says so in the plan's words. */}
        <RunSection
          id="phases"
          name="Phases"
          count={planPhases.length}
          hint="Every phase of the plan, with this run's record of each"
        >
          <PhaseTable
            slug={slug}
            run={run}
            planPhases={planPhases}
            live={live}
            allowRun={allowRun}
            queue={admission?.entries}
            scopes={scopes?.scopes}
            phaseEta={detail.eta?.perPhase}
            liveness={detailRun?.liveness}
            rulings={ledger?.rulings}
            recovery={{
              allowAgent,
              authFailure,
              sessions: terminals?.sessions,
              qaMode: detail.summary.qaMode,
              planSkills,
              planReviewers,
              allowWrites: Boolean(state?.allowWrites),
            }}
          />
        </RunSection>

        {/* The console: what each session is saying, with its ask box. Kept
            mounted while folded — a pane that unmounts loses stream lines no
            replay refills (`lanes.tsx`). */}
        <RunSection
          id="sessions"
          name="Sessions and their consoles"
          count={lanesOf(run).length}
          hint="Sessions in flight or queued"
          keepMounted
        >
          {run ? (
            <SessionTabs
              slug={slug}
              run={run}
              live={live}
              allowRun={allowRun}
              enabled={enabled}
              entries={admission?.entries}
              scopes={scopes?.scopes}
              phaseEta={detailRun?.phaseEta ?? []}
              detail={detail}
            />
          ) : (
            <LiveConsole lines={[]} subtitle="idle" />
          )}
        </RunSection>

        {/* Two timelines, two questions: WHEN each phase held the lane (the
            Gantt), and how each phase's own clock was split (the card). */}
        {run && (
          <RunSection
            id="time"
            name="Where the time went"
            count={phases.length}
            hint="Phases this run has a record of"
          >
            <div className="flex flex-col gap-4">
              {timeline ? (
                <Gantt
                  timeline={timeline}
                  // The cached run, `run:progress` patches included: the axis's
                  // "now" follows the lanes' own frames.
                  run={run}
                  onCompare={setComparePhase}
                  emptyAction={
                    <Button size="sm" variant="default" asChild>
                      <a href={planHref(slug, 'route')}>See the planned order</a>
                    </Button>
                  }
                />
              ) : null}
              <Timeline
                phases={phases}
                emptyAction={
                  <Button size="sm" variant="default" asChild>
                    <a href={planHref(slug, 'phases')}>Open the phase board</a>
                  </Button>
                }
              />
            </div>
          </RunSection>
        )}

        {/* Why this run started, and what it cost and ran session by session —
            the rung ledger with it: the two questions an unattended run is most
            often opened to answer. */}
        {run && (
          <RunSection
            id="ledger"
            name="Why it started and what it cost"
            count={runLedger ? runLedger.sessions.length : null}
            hint="Sessions this run has ended"
          >
            <div className="flex flex-col gap-4">
              <WhyStarted ledger={runLedger} manifest={run.manifest ?? null} />
              <LedgerCard ledger={runLedger} />
            </div>
          </RunSection>
        )}

        {/* What people decided about this run, and why (control-tower phase 96,
            #142) — free, and above the mailbox. */}
        {run && (run.notes?.length || allowRun) ? (
          <RunSection
            id="notes"
            name="Notes"
            count={run.notes?.length ?? 0}
            hint="Notes people left on this run"
          >
            <NotesCard run={run} allowRun={allowRun} />
          </RunSection>
        ) : null}


        {/* Where the work IS — only for a run with a checkout story. */}
        {run && hasGitStory(run, detailRun?.git) && (
          <RunSection
            id="git"
            name="Checkout"
            count={detailRun?.git?.checkouts.length ?? null}
            hint="Checkouts this run's work stands in"
          >
            <GitCard run={run} git={detailRun?.git} />
          </RunSection>
        )}


        {/* The audit trail — opened by itself when a link names one of its lines. */}
        {run && (
          <RunSection
            id="journal"
            name="Journal"
            count={journal ? journal.length : null}
            hint="The run's latest journal lines, up to 500"
            forceOpen={journalLinked}
          >
            <Journal entries={journal ?? []} />
          </RunSection>
        )}

        {history.length > 1 && (
          <RunSection
            id="history"
            name="Earlier runs of this plan"
            count={history.length - 1}
            hint="Runs before this one"
          >
            <RunHistory history={history} />
          </RunSection>
        )}

        {/* L3: the record as the machine holds it. */}
        {run && (
          <RunSection id="raw" name="Raw record">
            <pre
              data-testid="run-raw"
              className="max-h-[60vh] min-w-0 overflow-auto rounded-md border border-rule p-2 font-mono text-2xs whitespace-pre-wrap"
            >
              {JSON.stringify(run, null, 2)}
            </pre>
          </RunSection>
        )}
      </div>

      <AttemptCompare slug={slug} phase={comparePhase} onClose={() => setComparePhase(null)} />
    </div>
  );
}

export default RunView;
