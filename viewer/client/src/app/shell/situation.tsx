/**
 * The situation line, in the header — on every page (control-tower phase 21).
 *
 * The Tower's one sentence — "3 need you · 2 live · 1 waiting · $41 today",
 * drawn as separate words — answers "does anything need me?" in the two
 * seconds §Architecture 5 asks for; it answers it from anywhere now, not only
 * from `#/runs`, and every figure in it is a link to the bay it counts.
 *
 * Loaded after first paint, as the console chips are: it folds the runs, the
 * queue, the inbox and the plans through the status model, none of which a
 * first screen needs and all of which first paint is held under its budget
 * without (`check-dist.mjs`). It is the SAME fold the Runs page draws its bays
 * from (`useTower`), over the same queries — on `#/runs` the two share one
 * cache entry per request, so the line and the bays cannot disagree. The Ready
 * count reads the plan summaries alone (`details: false`): the header never
 * spends an engine read.
 */

import { useMemo } from 'react';
import type { ConsoleState } from '@/lib/api';
import { useApprovals, usePlans, useQueue, useRuns } from '@/lib/queries';
import { nowLanes } from '@/features/runs/lanes-model';
import { useTower } from '@/features/runs/tower/use-tower';
import { SituationLine } from '@/features/runs/tower/situation-line';

export default function HeaderSituation({
  state,
  phone,
}: {
  state: ConsoleState | undefined;
  phone: boolean;
}) {
  // The stale-server guard every run-reading surface keeps: a server that
  // predates the autopilot has no run endpoints to ask.
  const enabled = state != null && state.autopilot !== false;
  const { data: runs } = useRuns(enabled);
  const { data: queue } = useQueue(enabled);
  const { data: plans } = usePlans(enabled);
  const { data: approvals } = useApprovals(enabled);
  const lanes = useMemo(() => nowLanes(runs ?? []), [runs]);
  const tower = useTower({
    runs: runs ?? [],
    lanes,
    entries: queue?.entries,
    plans: plans ?? [],
    enabled,
    details: false,
  });
  // Nothing to say until the runs have answered: a line reading "Nothing
  // running right now" before the list arrives would be a claim, not a fact.
  if (!enabled || !runs) return null;
  const pending = (approvals ?? []).filter((approval) => approval.status === 'pending').length;
  if (phone) {
    // A phone gives the line a row of its own, as plain words: a row of links
    // would be six targets under the tap floor, and a row a thumb could meet
    // would cost the page 44 px of a 740 px screen. The Runs tab, one thumb
    // away with the same count on it, is the press.
    return (
      <div className="pb-1.5">
        <SituationLine
          tower={tower.model}
          approvals={pending}
          enabled={enabled}
          className="text-xs text-ink-muted"
        />
      </div>
    );
  }
  return (
    <SituationLine
      tower={tower.model}
      approvals={pending}
      enabled={enabled}
      links
      // A desk header is one row of a fixed height, so the line keeps to it and
      // gives way from its END, whole parts at a time (`SituationLine`'s
      // `useOneRow`) — the parts are ordered by what it costs to miss them, the
      // money last. The end padding keeps the last figure clear of the
      // header's own buttons.
      className="pe-3 text-sm text-ink-muted"
    />
  );
}
