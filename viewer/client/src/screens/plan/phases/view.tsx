/**
 * The Phases view (7.0, quiet-console phase 10): the one grid in its three
 * readings — the table, QA by phase, handoffs by phase — or the route map,
 * then the foot, where everything about the plan rather than one phase waits
 * folded with a count: the boot prompts, the end-of-phase banner, what is
 * left before the work boards, and the landing.
 *
 * The readings are addresses (`?view=`), never a toggle held in state: each is
 * a place a push, a handoff or a colleague can send someone to. The map is its
 * own chunk — most visits read the table, and the map is the console's
 * largest drawing.
 */

import { Suspense, lazy, useMemo } from 'react';
import type { PlanDetail } from '@/data/api';
import { useConsoleState } from '@/data/console';
import { isLive } from '@/data/lanes';
import { useRun } from '@/data/runs';
import { useSessions } from '@/data/sessions';
import { parseReportParam } from '@/lib/qa';
import { Skeleton } from '@/ui';
import { Disclosure } from '@/ui/disclosure';
import type { Everything } from '@/ui/everything';
import { SectionNav } from '@/shell/section-nav';
import { navigate, planViewHref } from '@/shell/routes';
import { PHASES_VIEW_IDS, PHASES_VIEW_LABELS, type PhasesViewId } from '../tabs';
import { BeforeItBoards, WorkForecast, WorkLeft } from './health';
import { LandingCard } from './landing';
import type { PhaseRecovery, PhaseTableContext } from './model';
import { PromptFold } from './prompt';
import { QaReportSheet } from './qa-report';
import { PhaseTable } from './table';

const MapView = lazy(() => import('../map/map-view').then((m) => ({ default: m.MapView })));

/** Which reading of the one grid each view is. `map` draws no grid. */
const READING: Record<Exclude<PhasesViewId, 'map'>, PhaseTableContext> = {
  table: 'plan',
  qa: 'plan-qa',
  handoffs: 'plan-handoffs',
};

export function PhasesView({
  detail,
  view,
  report,
  everything,
}: {
  detail: PlanDetail;
  view: PhasesViewId;
  /** `?report=<phase>[:<round>]` — the QA report sheet, open ⟺ the address says so. */
  report?: string | undefined;
  everything: Everything;
}) {
  const slug = detail.summary.slug;
  const { data: state } = useConsoleState();
  // A server from before the autopilot has no run endpoints; asking would be a
  // failed request per plan open for a column that has nothing to say.
  const { data: runDetail } = useRun(slug, state?.autopilot !== false);
  const { data: terminals } = useSessions(state);
  const run = runDetail?.run ?? null;
  const open = parseReportParam(report);

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

  const sections = PHASES_VIEW_IDS.map((id) => ({
    id,
    label: PHASES_VIEW_LABELS[id],
    href: planViewHref(slug, id),
  }));
  const reportPhase = open ? detail.phases.find((p) => p.phase === open.phase) : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="phases-view">
      <SectionNav sections={sections} current={view} label="Readings of the phases" />
      {view === 'map' ? (
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <MapView detail={detail} run={run} />
        </Suspense>
      ) : (
        <PhaseTable
          context={READING[view]}
          slug={slug}
          run={run}
          planPhases={detail.phases}
          live={isLive(run?.status ?? '')}
          allowRun={Boolean(state?.allowRun)}
          recovery={recovery}
          phaseEta={detail.eta?.perPhase}
          liveness={runDetail?.liveness}
          qaHeld={detail.qaHeld}
          handoffs={detail.handoffs}
          index={detail.index}
          inspectable
          everything={everything}
        />
      )}
      <PhasesFoot detail={detail} everything={everything.on} />
      {open && (
        <QaReportSheet
          slug={slug}
          phase={open.phase}
          {...(open.round ? { round: open.round } : {})}
          {...(reportPhase?.qaRounds ? { rounds: reportPhase.qaRounds.count } : {})}
          onClose={() => navigate(planViewHref(slug, view))}
        />
      )}
    </div>
  );
}

/**
 * What the plan owes beyond its rows, folded — each fold names what it holds
 * and how much. A prompt is an engine shell-out on the server, so each one is
 * fetched only when its own fold opens: a plan with four ready phases opens
 * without four engine runs (`first-paint.test.tsx`).
 */
export function PhasesFoot({ detail, everything = false }: { detail: PlanDetail; everything?: boolean }) {
  const s = detail.summary;
  const slug = s.slug;
  const closed = Boolean(s.closed);
  const ready = closed ? [] : s.ready;
  const lastDone = useMemo(() => {
    const done = detail.phases.filter((p) => p.state === 'done').map((p) => p.phase);
    return done.length ? Math.max(...done) : null;
  }, [detail.phases]);
  const openAll = everything ? { open: true } : {};

  return (
    <div className="flex min-w-0 flex-col gap-3 border-t border-rule pt-4" data-testid="phases-foot">
      {closed && (
        <p className="max-w-(--measure) text-body text-ink-muted">
          No sessions to plan: this plan is closed, so the engine batches nothing. The phases above are the
          record of where the work stopped; reopen the plan to put its remaining phases back on the board.
        </p>
      )}
      {ready.length > 0 && (
        <Disclosure
          label="Boot prompts"
          openLabel="Boot prompts"
          count={ready.length}
          testId="foot-prompts"
          bodyClassName="flex flex-col gap-3 pt-2 ps-4"
          {...openAll}
        >
          {ready.map((phase) => (
            <PromptFold key={phase} slug={slug} phase={phase} title={`Boot prompt for phase ${phase}`} />
          ))}
        </Disclosure>
      )}
      {lastDone != null && (
        <Disclosure
          label="End-of-phase banner"
          openLabel="End-of-phase banner"
          testId="foot-banner"
          bodyClassName="pt-2 ps-4"
          {...openAll}
        >
          <PromptFold
            slug={slug}
            phase={lastDone}
            kind="next"
            title={`After phase ${lastDone}`}
            note="the board, batching advice and each ready phase's boot"
          />
        </Disclosure>
      )}
      {/* A phase certain to park is said where it is seen, never behind a fold. */}
      {!closed && <BeforeItBoards detail={detail} />}
      {/* A closed plan claims no work: the sentence above is its whole answer,
          and a fold here would open onto a forecast of work nobody will do. */}
      {!closed && (
        <Disclosure
          label="What is left"
          openLabel="What is left"
          testId="foot-left"
          bodyClassName="flex flex-col gap-4 pt-2 ps-4"
          {...openAll}
        >
          <WorkLeft detail={detail} />
          <WorkForecast slug={slug} />
        </Disclosure>
      )}
      <LandingCard detail={detail} />
    </div>
  );
}
