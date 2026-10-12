/**
 * The Phases view's `map` reading: the plan drawn as a network (`dag.tsx`),
 * joined to what the route payload does not carry — where the map opens, the
 * critical path, who is driving each phase and what the run is verifying.
 *
 * The page reaches this module through `lazy()`, so the map, its stylesheet
 * and its maths ride a chunk of their own and a plan opened on its table never
 * downloads them.
 */

import { memo, useCallback, useMemo } from 'react';
import type { PlanDetail, RunState } from '@/data/api';
import { navigate, phaseHref } from '@/shell/routes';
import { RouteMap, type PhaseDriver } from './dag';

/**
 * The map, drawn only when what it draws has changed.
 *
 * Memoised HERE rather than at its definition because this is the caller that
 * can hold its props still: `route`, `batches` and `budget` come from a query
 * with structural sharing, and `focus`, `onSelect` and `hrefFor` are
 * stabilised in `MapView` below. A `memo` around a component whose caller mints
 * a new `onSelect` every render costs a comparison and saves nothing.
 */
const MemoRouteMap = memo(RouteMap);

/**
 * The station the map should open looking at.
 *
 * A handoff that reads blocked first, then whatever is moving, then the first
 * thing that COULD move — the order of urgency, because a map of forty phases
 * is drawn small enough that the one node worth seeing is as likely to be in a
 * corner as anywhere.
 *
 * `null` on a plan where nothing wants anything: a map that always snapped
 * somewhere would teach the operator that the snap means nothing.
 */
export function focusPhase(detail: Pick<PlanDetail, 'phases'>): number | null {
  const by = (...states: string[]) => detail.phases.find((p) => states.includes(p.state))?.phase ?? null;
  return by('stuck') ?? by('in-progress') ?? by('ready');
}

/**
 * The phases a run is verifying right now — its records reading `verifying`
 * and not yet ended. The board has no such word, so the map learns it here.
 */
export function verifyingPhases(run: Pick<RunState, 'phases'> | null | undefined): Set<number> {
  const set = new Set<number>();
  for (const record of Object.values(run?.phases ?? {})) {
    if (record.status === 'verifying' && !record.endedAt) set.add(record.phase);
  }
  return set;
}

export function MapView({ detail, run }: { detail: PlanDetail; run?: Pick<RunState, 'phases'> | null }) {
  const slug = detail.summary.slug;
  const focus = useMemo(() => focusPhase(detail), [detail]);
  const verifying = useMemo(() => verifyingPhases(run), [run]);

  /*
   * The two things the map draws that the ROUTE payload does not carry.
   *
   * `RouteView` is the engine's own projection and stays it — fields added
   * there would put analysis and process facts inside the topology. Both are
   * already on `detail.phases` for the table, so they are joined by phase
   * number here, memoised on the phase list so the live stream does not mint a
   * new Map on every tick.
   */
  const critical = useMemo(() => {
    const set = new Set<number>();
    for (const phase of detail.phases) if (phase.analysis?.onCriticalPath) set.add(phase.phase);
    return set.size ? set : null;
  }, [detail.phases]);

  const drivers = useMemo(() => {
    const map = new Map<number, PhaseDriver>();
    for (const phase of detail.phases) {
      const checking = verifying.has(phase.phase);
      if (phase.live || phase.lock || checking) {
        map.set(phase.phase, {
          live: phase.live,
          lock: phase.lock,
          ...(checking ? { verifying: true } : {}),
        });
      }
    }
    return map.size ? map : null;
  }, [detail.phases, verifying]);

  const onSelect = useCallback((phase: number) => navigate(phaseHref(slug, phase)), [slug]);
  const hrefFor = useCallback((phase: number) => phaseHref(slug, phase), [slug]);

  return (
    <MemoRouteMap
      route={detail.route}
      batches={detail.batches}
      budget={detail.summary.budget}
      focus={focus}
      /* The station the map opened on keeps a ring: a map that centred
         somewhere and then said nothing about why has moved for no reason the
         reader can see. Ring only — `focus` never dims the network. */
      selected={focus}
      critical={critical}
      drivers={drivers}
      onSelect={onSelect}
      hrefFor={hrefFor}
    />
  );
}
