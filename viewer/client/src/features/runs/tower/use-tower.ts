/**
 * The Tower's ONE fold — the model the bays draw and the situation line counts
 * (control-tower phases 20–21).
 *
 * Its own module rather than `tower.tsx`'s, because it has two callers that
 * load at different times: the Runs page, which draws the bays, and the
 * shell's header, which shows the situation line on every page and loads it
 * lazily after first paint. From here the header's chunk carries the model and
 * none of the Tower's bays, strips or annunciator.
 */

import { useMemo } from 'react';

import type { PlanSummary, PlanSummaryFull, QueueEntry, RunState } from '@/lib/api';
import { useNow } from '@/lib/clock';
import { isClosed } from '@/lib/closure';
import { useAttentionInbox, usePlanDetails } from '@/lib/queries';
import { toDepartures, type NowLane } from '@/features/runs/lanes-model';
import { towerModel, type TowerModel } from './tower-model';

/** The fold's clock period — a re-fold, never a printed duration. */
const MINUTE = 60_000;

/** The page's one fold of the Tower — the model, and whether the Ready bay is still reading plans. */
export function useTower(input: {
  runs: readonly RunState[];
  lanes: readonly NowLane[];
  entries?: readonly QueueEntry[] | undefined;
  plans: readonly PlanSummary[];
  /** The run endpoints answer (the stale-server guard). */
  enabled: boolean;
  /** Read the Ready bay's plan details — one engine read each, so only when the Tower is drawn. */
  details: boolean;
}): { model: TowerModel; readyLoading: boolean } {
  const { runs, lanes, entries, plans, enabled, details } = input;
  const inbox = useAttentionInbox(false, enabled);
  const summaries = plans as unknown as readonly PlanSummaryFull[];
  const readySlugs = useMemo(
    () => summaries.filter((p) => !isClosed(p) && (p.ready?.length ?? 0) > 0).map((p) => p.slug),
    [summaries],
  );
  const { bySlug, loading } = usePlanDetails(readySlugs, details && readySlugs.length > 0);
  const departures = useMemo(() => toDepartures(summaries, bySlug), [summaries, bySlug]);
  const closedSlugs = useMemo(
    () => new Set(summaries.filter((p) => isClosed(p)).map((p) => p.slug)),
    [summaries],
  );
  // The fold's own clock — "today" and "dormant" move on the minute, not the
  // second; each strip keeps its own finer clock.
  const minute = Math.floor(useNow(true, MINUTE) / MINUTE) * MINUTE;
  const items = inbox.data?.items;
  const model = useMemo(
    () => towerModel({ runs, lanes, entries, inbox: items, departures, closedSlugs, now: minute }),
    [runs, lanes, entries, items, departures, closedSlugs, minute],
  );
  return { model, readyLoading: details && loading };
}
