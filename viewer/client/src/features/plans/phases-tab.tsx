/**
 * The Phases tab — every phase of the plan, ONCE (control-tower phase 23, #26 #27).
 *
 * Four tabs used to list the same phases: Route (a departures board), Phases (a
 * card per phase), QA (a table of verdicts) and Handoffs (a table of files),
 * each with a third of a phase's facts, so every question about one phase was a
 * tour of four tabs. They are one table now — `features/runs/phase-table.tsx`,
 * the same table the Autopilot tab draws, from the same column array — and the
 * four readings are its VIEWS, addressed by `?view=` (`PLAN_PHASE_VIEWS`):
 * `table`, `map`, `qa` and `handoffs`. The retired tab ids redirect onto them
 * carrying their view (`app/routes.ts` `planTabRedirect`), so every old
 * address lands where it meant — including the `#/plan/:slug/route` the server
 * still mints into every plan push.
 *
 * Around every view: the plan's health, in two parts (`HealthPanel`) — what is
 * wrong, and what boarding will find, above the table, so a halted run is still
 * the first thing on the tab; the heartbeat, the autopilot and what is left
 * below it, with the cards about the plan rather than one phase (`PlanCards`).
 * The table is where the plan is up to, and the whole panel above it had put
 * the table a screen and a half down a desk. Mounted once for the whole tab,
 * never per row: the phase sheet (L2) and the QA report sheet, which keeps its
 * `?report=` address.
 *
 * The table reads the plan's run through `useRun` — ONE request when the tab
 * opens — and from then on `run:progress` patches that cache in place, so the
 * lane clocks, the tasks and the spend move with no request per frame (#25).
 */

import { useMemo, useState } from 'react';
import { useConsoleState, useRun, useSessions } from '@/lib/queries';
import { navigate, planViewHref } from '@shared/routes.js';
import { PhaseTable, type PhaseRecovery, type PhaseTableContext } from '@/features/runs/phase-table';
import { isLive } from '@/features/runs/defaults';
import { parseReportParam } from '@/lib/qa';
import { cn } from '@/lib/cn';
import type { PlanDetail } from '@/lib/api';
import { HealthPanel } from './health-panel';
import { MapView, PlanCards } from './map-view';
import { PhaseInspector } from './phase-inspector';
import { QaReportSheet } from './qa-report-sheet';
import { PHASES_VIEW_IDS, PHASES_VIEW_LABELS, type PhasesViewId } from './tabs';

/** Which reading of the one table each view is. `map` draws no table. */
const READING: Record<Exclude<PhasesViewId, 'map'>, PhaseTableContext> = {
  table: 'plan',
  qa: 'plan-qa',
  handoffs: 'plan-handoffs',
};

export function PhasesTab({
  detail,
  view = 'table',
  report,
}: {
  detail: PlanDetail;
  /** `?view=` — already resolved by `phasesViewOf`. */
  view?: PhasesViewId;
  /** `?report=<phase>[:<round>]` — the QA report sheet, open ⟺ the address says so. */
  report?: string | undefined;
}) {
  const slug = detail.summary.slug;
  const { data: state } = useConsoleState();
  // A server from before the autopilot has no run endpoints; asking would be a
  // failed request per plan open for a column that has nothing to say.
  const { data: runDetail } = useRun(slug, state?.autopilot !== false);
  const { data: terminals } = useSessions(state);
  const run = runDetail?.run ?? null;

  // By NUMBER, re-read live: a stream tick replaces every `PhaseView`, and a
  // sheet holding the old object would keep showing pre-tick state.
  const [inspecting, setInspecting] = useState<number | null>(null);
  const inspected = inspecting == null ? null : (detail.phases.find((p) => p.phase === inspecting) ?? null);
  const open = parseReportParam(report);
  const etaOf = (phase: number) => detail.eta?.perPhase.find((e) => e.phase === phase);

  const recovery = useMemo<PhaseRecovery>(
    () => ({
      allowAgent: Boolean(state?.allowAgent),
      ...(terminals?.sessions ? { sessions: terminals.sessions } : {}),
      qaMode: detail.summary.qaMode,
      planSkills: detail.plan?.sessionBudget?.skills ?? [],
      planReviewers: detail.plan?.reviewers ?? [],
      allowWrites: Boolean(state?.allowWrites),
    }),
    [state?.allowAgent, state?.allowWrites, terminals?.sessions, detail.summary.qaMode, detail.plan],
  );

  return (
    <div className="flex flex-col gap-3">
      <HealthPanel detail={detail} part="trouble" />
      <ViewSwitch slug={slug} view={view} />
      {view === 'map' ? (
        <MapView detail={detail} run={run} />
      ) : (
        <PhaseTable
          context={READING[view]}
          slug={slug}
          run={run}
          planPhases={detail.phases}
          live={isLive(run?.status)}
          allowRun={Boolean(state?.allowRun)}
          recovery={recovery}
          phaseEta={detail.eta?.perPhase}
          liveness={runDetail?.liveness}
          qaHeld={detail.qaHeld}
          handoffs={detail.handoffs}
          index={detail.index}
          onInspect={setInspecting}
        />
      )}
      <HealthPanel detail={detail} part="context" />
      <PlanCards detail={detail} />
      {inspected && (
        <PhaseInspector
          slug={slug}
          phase={inspected}
          eta={etaOf(inspected.phase)}
          open
          onOpenChange={(next) => !next && setInspecting(null)}
        />
      )}
      {open && (
        <QaReportSheet
          slug={slug}
          phase={open.phase}
          {...(open.round ? { round: open.round } : {})}
          {...(detail.phases.find((p) => p.phase === open.phase)?.qaRounds
            ? { rounds: detail.phases.find((p) => p.phase === open.phase)!.qaRounds!.count }
            : {})}
          onClose={() => navigate(planViewHref(slug, view))}
        />
      )}
    </div>
  );
}

/**
 * The four views, as ADDRESSES — links, not a toggle, because each is a place
 * a push, a handoff or a colleague can send someone to.
 */
function ViewSwitch({ slug, view }: { slug: string; view: PhasesViewId }) {
  return (
    <nav aria-label="Views of the phases" className="flex flex-wrap items-center gap-1">
      {PHASES_VIEW_IDS.map((id) => (
        <a
          key={id}
          href={planViewHref(slug, id)}
          aria-current={id === view ? 'page' : undefined}
          className={cn(
            'inline-flex items-center rounded-md border px-2.5 py-1 text-xs [@media(hover:none)]:min-h-(--tap-min)',
            id === view
              ? 'border-ink bg-ink font-medium text-ground'
              : 'border-rule text-ink-muted hover:border-rule-strong hover:text-ink',
          )}
        >
          {PHASES_VIEW_LABELS[id]}
        </a>
      ))}
    </nav>
  );
}
