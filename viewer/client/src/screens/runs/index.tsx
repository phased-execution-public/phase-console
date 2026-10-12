/**
 * Runs — 7.0's home (quiet-console phase 7; the Tower since control-tower
 * phase 20, §Architecture 2 and 3).
 *
 * ```
 * 2 need you, storefront is running — phase 7, 1 waiting, $41 today   ← the heading IS the situation
 * [Filter by plan…]  Filter  View  Groups | All runs       ⋯  Everything
 * Your turn 2 ──────────────────────────────────────────
 *   item · item
 * Running 1 ───  Waiting 1 ───  Queued 0 ───  Ready to start 4 ───  Settled today 3
 *   ▌● word  name  ○─●─○ track  clock  2/9  $4.20/$25  [ the one action ] ⌄
 * ```
 *
 * One question, answered in two seconds: does anything need me? Your turn
 * first — the acts, one line each, the primary move inline — then the runs in
 * groups by what each IS (`data/run-groups.ts`, the ONE fold the header's
 * situation words share). Each run is one line that expands in place and
 * inspects in the panel. The nine lamps are the Filter slot; the text filter
 * and the lamp are remembered (`prefs.towerQuery`, `prefs.towerCategory`),
 * because a question a person set is one they are still asking the next time
 * they look. *All runs* is the grid (`all-runs.tsx`), one View away.
 *
 * It reads the SLIM list (#234) and nothing whole: the open row reads its own
 * record. `?group=` lands on a group, `?view=` on a shape, and the 6.x
 * spellings (`?bay=`, `board`, `table`) still land.
 */

import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { HALT_CATEGORY_LABELS, isHaltCategory } from '@shared/halt-categories.js';
import { api, type RunState } from '@/data/api';
import { useAttentionInbox } from '@/data/inbox';
import { keys } from '@/data/keys';
import { asRunLike, needsYouCount } from '@/data/lanes';
import { pressFleet } from '@/data/lifecycle';
import { useConsoleState } from '@/data/console';
import { useAuth } from '@/data/machine';
import { filterGroups, useRunGroups } from '@/data/run-groups';
import { useConverge, useSpend } from '@/data/runs';
import { useTurn } from '@/data/turn';
import { looksLikeAuthFailure } from '@/lib/failures';
import { usePrefs } from '@/lib/prefs';
import { Button, ButtonGroup, Empty, Page, Skeleton, useEverything } from '@/ui';
import { Toolbar, type ToolbarVerb } from '@/ui/toolbar';
import { useNavigate } from '@/shell/router';
import {
  plansHref,
  runsBayOf,
  runsHref,
  runsViewOf,
  runsViewWord,
  type Route,
  type RunsView,
} from '@/shell/routes';
import { situationParts, situationSentence, turnsOf } from '@/shell/situation-line';
import { AuthCard, StaleServerNote } from '@/screens/plan/run/halt';
import { UndrivenCard } from '@/screens/plan/run/undriven';
import { AllRuns } from './all-runs';
import { LAMP_LABELS, Lamps } from './filter';
import { CiRefusedLines, Groups } from './groups';

export default function RunsHome({ route }: { route: Route }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { data: state } = useConsoleState();
  const [prefs, setPrefs] = usePrefs();

  // The client is served fresh from disk; the server is whatever Node loaded
  // at startup. A server that predates the autopilot has no run endpoints, and
  // the honest thing to show is why — not a stack of failed requests.
  const stale = state != null && state.autopilot === false;
  const enabled = state != null && !stale;
  const allowRun = Boolean(state?.allowRun);

  /**
   * Groups or All runs: the address wins for this visit, the preference
   * otherwise — the rule `?group=` follows too, since a group is on the groups.
   */
  const focus = runsBayOf(route);
  const asked: RunsView | undefined = runsViewOf(route) ?? (focus ? 'groups' : runsViewWord(prefs.runsView));
  const home: RunsView = asked ?? 'groups';

  const { model, runs, pending, readyLoading, entries } = useRunGroups({
    enabled,
    details: enabled && home === 'groups',
  });
  const { data: converge } = useConverge(enabled && home === 'groups');
  const { data: spend } = useSpend(enabled);
  const { data: turn } = useTurn(enabled);
  const { data: auth } = useAuth(enabled);
  const inbox = useAttentionInbox(false, enabled);
  const everything = useEverything('runs');

  const category = isHaltCategory(prefs.towerCategory) ? prefs.towerCategory : null;
  const query = prefs.towerQuery ?? '';
  const shown = useMemo(
    () =>
      filterGroups(model, {
        category,
        query,
      }),
    [
      model,
      category,
      query,
    ],
  );
  const filtered = [
    category,
    query.trim(),
  ].some(Boolean);

  const parts = situationParts({
    model,
    needsYou: needsYouCount(inbox.data?.items),
    turns: turnsOf(turn),
    queued: entries?.length ?? 0,
    spend,
  });
  const title = runs ? situationSentence(parts) : 'Runs';

  /**
   * Change the shape, and stop the address arguing with the preference: a
   * press that only wrote the pref would be undone on the next render while
   * `?view=` is still in the bar. The navigation is `replace`, because "I
   * looked at the grid" is not a step in anybody's history.
   */
  const onView = (next: RunsView) => {
    setPrefs({ runsView: next });
    if (runsViewOf(route) || focus) navigate(runsHref(), { replace: true });
  };

  // The grid's rows: every run, less a closed plan's unless asked for.
  const allRows = useMemo(
    () => (prefs.runsShowClosed ? model.runs : model.runs.filter((t) => !t.ctx.planClosed)),
    [model.runs, prefs.runsShowClosed],
  );
  const hiddenClosed = model.runs.length - allRows.length;

  const verbs: ToolbarVerb[] = [
    {
      id: 'freeze',
      label: 'Freeze everything',
      onSelect: () => void pressFleet(client, 'freeze'),
      ...(allowRun ? {} : { disabled: 'This console cannot drive runs (no --allow-run)' }),
    },
    {
      id: 'thaw',
      label: 'Thaw everything',
      onSelect: () => void pressFleet(client, 'thaw'),
      ...(allowRun ? {} : { disabled: 'This console cannot drive runs (no --allow-run)' }),
    },
    ...(home === 'all'
      ? [
          {
            id: 'closed',
            label: prefs.runsShowClosed
              ? 'Hide closed plans’ runs'
              : `Show closed plans’ runs${hiddenClosed ? ` (${hiddenClosed})` : ''}`,
            onSelect: () => setPrefs({ runsShowClosed: !prefs.runsShowClosed }),
          } satisfies ToolbarVerb,
        ]
      : []),
  ];

  const clear = () => {
    setPrefs({ towerCategory: '', towerQuery: '' });
  };

  const viewChoice = (
    <ButtonGroup aria-label="Which shape the runs take" data-testid="runs-view">
      <Button
        size="sm"
        variant="ghost"
        aria-pressed={home === 'groups'}
        data-view="groups"
        onClick={() => onView('groups')}
      >
        Groups
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-pressed={home === 'all'}
        data-view="all"
        onClick={() => onView('all')}
      >
        All runs
      </Button>
    </ButtonGroup>
  );

  /* ---------------- the branches ---------------- */

  if (stale) {
    return (
      <Page title="Runs" data-testid="runs-home">
        <StaleServerNote />
      </Page>
    );
  }

  if (pending) {
    return (
      <Page title="Runs" lead="Reading runs" data-testid="runs-home">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-8" />
          <Skeleton className="h-20" />
          <Skeleton className="h-48" />
        </div>
      </Page>
    );
  }

  const [liveRun] = model.groups.live;
  const authFailing = looksLikeAuthFailure(liveRun ? (asRunLike(liveRun.run) as RunState) : null, auth);
  const nothing = model.runs.length === 0 && model.ready.length === 0 && model.items.length === 0;

  return (
    <Page title={title} data-testid="runs-home">
      <Toolbar
        label="Runs"
        search={{
          value: query,
          onChange: (value) => setPrefs({ towerQuery: value }),
          placeholder: 'Filter by plan',
          label: 'Filter the runs by plan',
        }}
        filter={{
          ...(category ? { value: LAMP_LABELS[category] } : {}),
          active:
            (category ? 1 : 0) +
            0,
          panel: (
            <div className="flex min-w-0 flex-col gap-3">
              <Lamps
                lamps={shown.lamps}
                pressed={category}
                onPress={(next) => setPrefs({ towerCategory: next ?? '' })}
              />
            </div>
          ),
        }}
        view={{
          value: home === 'groups' ? 'Groups' : 'All runs',
          active: home === 'groups' ? 0 : 1,
          panel: viewChoice,
          inline: viewChoice,
        }}
        more={verbs}
        everything={everything}
        note={
          filtered ? (
            <>
              <span data-testid="tower-filtered" className="min-w-0">
                Showing only {category ? HALT_CATEGORY_LABELS[category].toLowerCase() : 'what matches'}
                {query.trim() ? ` in plans matching “${query.trim()}”` : ''}.
              </span>
              <Button size="sm" variant="ghost" onClick={clear}>
                Clear the filter
              </Button>
            </>
          ) : undefined
        }
      />


      {/* CI GitHub will not start, one line per repository (control-tower phase 111, #166). */}
      <CiRefusedLines items={shown.ciRefused} />

      {/* A phase the board reads in progress that nothing of its live run drives (#114). */}
      <UndrivenCard runs={(runs ?? []).map((run) => asRunLike(run) as RunState)} allowRun={allowRun} />

      {authFailing && (
        <AuthCard
          auth={auth}
          allowRun={allowRun}
          onRecheck={() => {
            void client.invalidateQueries({ queryKey: keys.auth() });
            void api.auth(true).then((fresh) => client.setQueryData(keys.auth(), fresh));
          }}
        />
      )}

      {nothing && !filtered ? (
        <Empty
          title="No runs yet. Open a plan and start one; runs are recorded outside the repository."
          action={
            <Button size="sm" asChild>
              <a href={plansHref()}>Pick a plan to run</a>
            </Button>
          }
        />
      ) : home === 'groups' ? (
        <Groups
          model={shown}
          allowRun={allowRun}
          state={state}
          focus={focus}
          readyLoading={readyLoading}
          filtered={filtered}
          converge={converge}
        />
      ) : (
        <AllRuns
          rows={filtered ? shown.runs : allRows}
          everything={everything}
          state={state}
          allowRun={allowRun}
        />
      )}
    </Page>
  );
}
