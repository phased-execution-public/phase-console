/**
 * What runs — the head of the departure notice (7.0, quiet-console phase 13).
 *
 * A launch is a departure, and the notice opens the way a platform board
 * does: one sentence saying where this run goes and on what terms (the
 * departure line, composed from the values by `summary.ts`, so it cannot
 * disagree with the payload), and under it the route — the plan's line, its
 * finished phases folded into one hollow station, a station for each phase
 * this run boards first, and what follows them folded into one more. The line
 * is the console's one graphic (design.md §7), drawn here small and labelled,
 * station by station. The plan's phases, the sessions they fall into and
 * what will hold sit one fold below.
 */

import { describeWord } from '@shared/status-model.js';
import type { UiState } from '@shared/status-vocab.js';
import { Disclosure } from '@/ui/disclosure';
import { Station } from '@/ui/track/station';
import { Track } from '@/ui/track/track';
import { useSetupForm } from './form-context';
import { BoardingNotes } from './findings';
import { WhatRuns } from './what-runs';
import { liveClaim, useLaunchFacts, type LaunchFactsView } from './model/facts';
import { departureLine } from './model/summary';

/** The departure line and the facts it was read from — the notice's first words. */
export function useDeparture() {
  const f = useSetupForm();
  const facts = useLaunchFacts();
  const line = departureLine(
    f.mode,
    f.values,
    f.context,
    {
      slug: facts.slug,
      ready: facts.ready.map((p) => p.phase),
      scoped: facts.scoped,
      resumeRunId: facts.resumeRunId,
    },
    { permission: f.permissionName, account: f.accountName },
  );
  return { line, facts };
}

/** One station of the route — a phase this run boards, or a fold of several. */
export interface RouteStation {
  key: string;
  /** The word beside the dot: a station is never colour alone. */
  label: string;
  paint: UiState;
  settled: boolean;
  phase?: number;
  count?: number;
}

/** The most boarding phases drawn one by one; past it, the rest fold into one station. */
const BOARDING_DRAWN = 3;

/**
 * The route a launch takes along its plan: the phases already done (one
 * hollow station), each phase it boards first (its board state's paint, with
 * a gate or a live claim said in its word), and every other open phase (one
 * hollow station). Pure, so a test reads the stations the notice draws.
 */
export function routeStations(facts: Pick<LaunchFactsView, 'phases' | 'willRun'>): RouteStation[] {
  if (!facts.phases.length) return [];
  const boarding = new Set(facts.willRun.map((p) => p.phase));
  const done = facts.phases.filter((p) => p.state === 'done' && !boarding.has(p.phase));
  const after = facts.phases.filter((p) => p.state !== 'done' && !boarding.has(p.phase));
  const out: RouteStation[] = [];
  if (done.length)
    out.push({ key: 'done', label: `${done.length} done`, paint: 'done', settled: true, count: done.length });
  const drawn =
    facts.willRun.length > BOARDING_DRAWN ? facts.willRun.slice(0, BOARDING_DRAWN - 1) : facts.willRun;
  for (const p of drawn) {
    const holds = p.gated ? ' gated' : liveClaim(p) ? ' claimed' : '';
    out.push({
      key: `p${p.phase}`,
      label: `P${p.phase}${holds}`,
      paint: describeWord('board', p.state).paint,
      settled: false,
      phase: p.phase,
    });
  }
  const more = facts.willRun.length - drawn.length;
  if (more > 0)
    out.push({
      key: 'more',
      label: `${more} more`,
      paint: describeWord('board', 'ready').paint,
      settled: false,
      count: more,
    });
  if (after.length)
    out.push({
      key: 'after',
      label: `${after.length} after`,
      paint: 'queued',
      settled: true,
      count: after.length,
    });
  return out;
}

export function Departure() {
  const f = useSetupForm();
  const { line, facts } = useDeparture();
  const narrow = f.mode === 'phase' || f.mode === 'live' || facts.scoped;
  const stations = routeStations(facts);
  return (
    <section aria-label="What runs" className="flex min-w-0 flex-col gap-2.5">
      <p
        data-testid="departure-line"
        className="max-w-(--measure) text-section font-semibold text-ink sm:text-title"
      >
        {line}
      </p>
      {!narrow && facts.ready.length > 0 && (
        <p className="text-meta text-ink-muted">
          Then whatever those unblock, until the plan ends or a stop condition hits.
        </p>
      )}
      {stations.length > 0 && (
        // The legs are as long as the stations need, never the whole measure:
        // two stations an arm's length apart read as one route, not a ruler.
        <Track
          label="Where this run boards"
          data-testid="departure-route"
          className="py-1"
          style={{ maxWidth: `min(var(--measure), ${stations.length * 8}rem)` }}
        >
          {stations.map((station) => (
            <Station
              key={station.key}
              paint={station.paint}
              settled={station.settled}
              data-phase={station.phase}
              data-count={station.count}
              className="text-meta text-ink"
            >
              {station.label}
            </Station>
          ))}
        </Track>
      )}
      <Disclosure
        label="The plan, its phases and what will hold"
        openLabel="The plan, its phases and what will hold"
        testId="departure-fold"
      >
        <div className="flex min-w-0 flex-col gap-5 pt-3">
          <WhatRuns />
          <BoardingNotes />
        </div>
      </Disclosure>
    </section>
  );
}
