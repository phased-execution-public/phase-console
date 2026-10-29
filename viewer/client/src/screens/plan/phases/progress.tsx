/**
 * The Phases view's `schedule` and `burnup` readings (one-pool phase 16, #376):
 * the plan's schedule and its burn-up, drawn from the run record — each phase's
 * own start and end as the run kept them — joined to the plan's estimates, its
 * cost record, its handoffs' dates and its forecast.
 *
 * The page reaches this module through `lazy()`, so the two drawings ride a
 * chunk of their own, like the map.
 */

import { useMemo } from 'react';
import type { PlanDetail, RunState } from '@/data/api';
import { useNow } from '@/ui/clock';
import { BurnupFigure, type BurnupInput } from '@/ui/figures/burnup';
import { ScheduleFigure, type ScheduleInput } from '@/ui/figures/schedule';

/** Each phase's start and end: the run record first, the cost record's end beside its duration where the run has none. */
export function recordsOf(
  detail: Pick<PlanDetail, 'cost'>,
  run: Pick<RunState, 'phases'> | null | undefined,
): Map<number, { startedAt?: string; endedAt?: string }> {
  const out = new Map<number, { startedAt?: string; endedAt?: string }>();
  for (const cost of detail.cost?.phases ?? []) {
    const end = cost.endedAt ? Date.parse(cost.endedAt) : Number.NaN;
    if (Number.isFinite(end) && cost.durationMs > 0) {
      out.set(cost.phase, {
        startedAt: new Date(end - cost.durationMs).toISOString(),
        endedAt: cost.endedAt!,
      });
    }
  }
  for (const record of Object.values(run?.phases ?? {})) {
    if (!record.startedAt) continue;
    out.set(record.phase, {
      startedAt: record.startedAt,
      ...(record.endedAt ? { endedAt: record.endedAt } : {}),
    });
  }
  return out;
}

export function scheduleInputOf(
  detail: Pick<PlanDetail, 'phases' | 'route' | 'eta' | 'cost' | 'forecastUsd'>,
  run: Pick<RunState, 'phases'> | null | undefined,
  now: number,
): ScheduleInput {
  return {
    phases: detail.phases.map((p) => ({ phase: p.phase, title: p.title, state: p.state })),
    edges: detail.route.edges,
    estimates: new Map((detail.eta?.perPhase ?? []).map((e) => [e.phase, e.estMs])),
    records: recordsOf(detail, run),
    // What each phase will likely cost, and did (measured-console phase 23).
    ...(detail.forecastUsd?.phases.length
      ? {
          forecasts: new Map(
            detail.forecastUsd.phases.filter((f) => f.phase !== undefined).map((f) => [f.phase!, f.usd]),
          ),
        }
      : {}),
    ...(detail.cost?.phases.length
      ? { costs: new Map(detail.cost.phases.map((c) => [c.phase, c.usd])) }
      : {}),
    now,
  };
}

export function burnupInputOf(
  detail: Pick<PlanDetail, 'phases' | 'cost' | 'forecast'>,
  run: Pick<RunState, 'phases'> | null | undefined,
  now: number,
): BurnupInput {
  const records = recordsOf(detail, run);
  return {
    phases: detail.phases.map((p) => {
      const ended = records.get(p.phase)?.endedAt;
      const completed = p.handoff?.completed;
      const at = ended ? Date.parse(ended) : completed ? Date.parse(completed) : Number.NaN;
      return {
        phase: p.phase,
        weight: p.weight ?? 0,
        state: p.state,
        ...(Number.isFinite(at) ? { doneAt: at } : {}),
      };
    }),
    forecast: detail.forecast ?? null,
    now,
  };
}

/** A minute is fine enough for a plan's progress; a live phase still moves the bars. */
const TICK = 60_000;

export function ScheduleView({ detail, run }: { detail: PlanDetail; run?: Pick<RunState, 'phases'> | null }) {
  const now = useNow(true, TICK);
  const minute = Math.floor(now / TICK) * TICK;
  const input = useMemo(() => scheduleInputOf(detail, run, minute), [detail, run, minute]);
  return <ScheduleFigure input={input} />;
}

export function BurnupView({ detail, run }: { detail: PlanDetail; run?: Pick<RunState, 'phases'> | null }) {
  const now = useNow(true, TICK);
  const minute = Math.floor(now / TICK) * TICK;
  const input = useMemo(() => burnupInputOf(detail, run, minute), [detail, run, minute]);
  return <BurnupFigure input={input} />;
}
