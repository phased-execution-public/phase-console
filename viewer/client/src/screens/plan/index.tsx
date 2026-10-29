/**
 * One plan — `#/plan/:slug` (7.0, quiet-console phase 10).
 *
 * The glance first (which plan, what it is doing, its line, what is left, the
 * one act), then what changes how the page reads (trouble, the QA gate, the
 * banners), the plan's facts behind one fold, and its three views as real
 * links: **Phases** (the one grid, or the map), **Run** (the live run and
 * every run before it, `screens/plan/run/`, its own chunk) and **Source** (the
 * plan as written, and the engine's own words about it). A phase and a handoff are
 * pages of their own under the plan (`/phase/:n`, `/handoff/:n`), reached from
 * the grid; the view navigation still marks Phases there.
 *
 * Two things here are deliberate and easy to undo by accident:
 *
 * 1. **The page does not blank while it refreshes.** `usePlan` keeps the last
 *    answer on screen, so a session finishing a phase elsewhere never throws
 *    away the thing being read; only a DIFFERENT plan waits on a skeleton,
 *    because holding the previous one would be a lie.
 * 2. **What a view fetches is what it renders** (`tabs.ts`, `TAB_INCLUDES`):
 *    the board projection for Phases, the prose for a phase page and the Run
 *    view, the document and memory for Source — never all of it for every view.
 */

import { Suspense, lazy } from 'react';
import { Activity, FileText, Hand, ListTree, type LucideIcon } from 'lucide-react';
import { useAutoReadNotifications } from '@/data/inbox';
import { useEngineQueue, usePlan } from '@/data/plans';
import { useTurn, type TurnAnswer } from '@/data/turn';
import { TURN_GROUPS } from '@shared/turn-model.js';
import { readSeen } from '@/screens/turn/seen';
import type { PlanDetail } from '@/data/api';
import { Button, Empty, Skeleton, Spinner, useEverything, type Everything } from '@/ui';
import { SectionNav } from '@/shell/section-nav';
import { planHref, planViewHref, type Route } from '@/shell/routes';
import { PlanGlance } from './glance';
import { PlanBanners, PlanFacts, QaLine } from './header';
import { PlanTrouble } from './phases/health';
import { PhasesView } from './phases/view';
import {
  DETAIL_TABS,
  TAB_IDS,
  includesForTab,
  isDetailRoute,
  phasesViewOf,
  resolveTab,
  sourceViewOf,
  tabLabel,
} from './tabs';

/** Each view's glyph in the bay — the Phases list, the run's pulse, the hand that is yours, the file. */
const VIEW_ICONS: Readonly<Record<string, LucideIcon>> = {
  phases: ListTree,
  run: Activity,
  turn: Hand,
  source: FileText,
};

/**
 * The bodies nobody opens first, each its own chunk: the phase page pulls every
 * prose field's renderer, the handoff page the handoff's, and Source the whole
 * plan document. ⚠️ A helper imported from one of these files is a static
 * import of the file — which is why the view helpers live in `./tabs`.
 */
const PhasePanel = lazy(() => import('./phases/panel').then((m) => ({ default: m.PhasePanel })));
const HandoffPanel = lazy(() => import('./phases/handoff-panel').then((m) => ({ default: m.HandoffPanel })));
const SourceTab = lazy(() => import('./source/source-tab').then((m) => ({ default: m.SourceTab })));
const RunView = lazy(() => import('./run'));
// The plan's Your turn (one-pool phase 14, #366): the page's own body, scoped.
const TurnBody = lazy(() => import('@/screens/turn').then((m) => ({ default: m.TurnBody })));

const FRAME = 'mx-auto flex w-full min-w-0 max-w-(--content-max) flex-col gap-6 px-(--pad-x) py-(--pad-y)';

/** Why the page is still empty (#44): a cold plan's board queues behind every other engine read. */
function EngineQueueLine() {
  const { data } = useEngineQueue(true);
  const queued = data?.queued ?? 0;
  return (
    <p className="text-body text-ink-muted" role="status">
      {queued > 0 ? `Computing the board, ${queued} queued` : 'Computing the board'}
    </p>
  );
}

function PlanSkeleton() {
  return (
    <div data-page className={FRAME} aria-busy="true">
      <Skeleton className="h-7 w-72" />
      <EngineQueueLine />
      <Skeleton className="h-4 w-96 max-w-full" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-96 w-full" />
    </div>
  );
}

/** The shape of a view's body while its chunk is on the way. */
function ViewSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/** What each view shows. Total over `PLAN_TABS` and the two detail pages. */
function ViewBody({
  tab,
  arg,
  detail,
  view,
  report,
  everything,
  route,
}: {
  tab: string;
  arg?: string | undefined;
  detail: PlanDetail;
  view?: string | undefined;
  report?: string | undefined;
  everything: Everything;
  route: Route;
}) {
  const slug = detail.summary.slug;
  switch (tab) {
    case 'turn':
      return <TurnBody route={route} base={`plan/${slug}/turn`} focus={arg ?? null} plan={slug} />;
    case 'phase':
      return <PhasePanel detail={detail} phase={arg} />;
    case 'handoff':
      return <HandoffPanel detail={detail} phase={arg} />;
    case 'source':
      return <SourceTab detail={detail} slug={slug} view={sourceViewOf(view)} />;
    case 'run':
      return (
        <Suspense fallback={<Spinner label="Reading the run" />}>
          <RunView detail={detail} view={view} everything={everything} />
        </Suspense>
      );
    // `phases` is also the fallback, so a view the vocabulary gains before its
    // body lands draws the grid rather than nothing.
    case 'phases':
    default:
      return (
        <PhasesView
          detail={detail}
          view={phasesViewOf(view)}
          report={report}
          everything={everything}
          query={route.query}
        />
      );
  }
}

/** How many of a plan's items are open on Your turn — every group but Done. */
function openTurnOf(answer: TurnAnswer | undefined, slug: string): number {
  if (!answer?.groups) return 0;
  return TURN_GROUPS.filter((group) => group !== 'done').reduce(
    (n, group) => n + (answer.groups[group] ?? []).filter((item) => item.slug === slug).length,
    0,
  );
}

export default function PlanPage({ route }: { route: Route }) {
  const [, slug, segment, arg] = route.segments;
  const tabId = resolveTab(segment);
  const detailKind = isDetailRoute(segment) ? segment : null;
  const everything = useEverything('plan');
  const { data, error, isPending, refetch } = usePlan(slug, includesForTab(detailKind ?? tabId));
  // The Your turn view's count: what in this plan waits on a person, from the one source.
  const turn = useTurn(Boolean(slug), readSeen());

  // Opening a plan — any view of it — counts as reading its notifications,
  // scoped to this slug.
  useAutoReadNotifications({ slug }, Boolean(slug));

  if (error) {
    return (
      <div data-page className={FRAME}>
        <h1 className="text-title text-ink">{slug ?? 'Plan'}</h1>
        <Empty
          title={(error as Error).message || 'The plan could not be read.'}
          action={
            <Button size="sm" onClick={() => void refetch()}>
              Read it again
            </Button>
          }
        />
      </div>
    );
  }
  if (isPending || !data || (slug && data.summary.slug !== slug)) return <PlanSkeleton />;

  const s = data.summary;
  const sections = TAB_IDS.map((id) => ({
    id,
    label: tabLabel(id),
    href: planHref(s.slug, id),
    ...(VIEW_ICONS[id] ? { icon: VIEW_ICONS[id] } : {}),
    ...(id === 'phases' && data.phases.length ? { count: data.phases.length } : {}),
    ...(id === 'turn' ? { count: openTurnOf(turn.data, s.slug) } : {}),
  }));

  return (
    <div data-page className={FRAME} data-testid="plan-page" data-slug={s.slug}>
      {/* On the Run view the run's own head carries its one act and its card
          the stop: drawn here as well, each would be on the page twice. */}
      <PlanGlance detail={data} titleAs={detailKind ? 'p' : 'h1'} act={tabId !== 'run'} />
      <PlanTrouble detail={data} withRun={tabId !== 'run'} />
      {s.qaMode && s.qaMode !== 'off' && <QaLine detail={data} />}
      <PlanBanners detail={data} />
      <PlanFacts detail={data} {...(everything.on ? { open: true } : {})} />
      <div className="flex min-w-0 flex-col gap-4">
        <SectionNav
          sections={sections}
          current={detailKind ? DETAIL_TABS[detailKind] : tabId}
          label="Views of the plan"
        />
        {detailKind && (
          <a
            href={
              detailKind === 'handoff'
                ? planViewHref(s.slug, 'handoffs')
                : planHref(s.slug, DETAIL_TABS[detailKind])
            }
            className="self-start text-meta text-ink-muted underline-offset-2 hover:text-ink hover:underline"
          >
            {detailKind === 'handoff' ? 'All handoffs' : 'All phases'}
          </a>
        )}
        {/* Per view, not per page: the glance and the navigation stay put
            while a lazy body arrives, so switching views never blanks the plan. */}
        <Suspense fallback={<ViewSkeleton />}>
          <ViewBody
            tab={detailKind ?? tabId}
            arg={arg}
            detail={data}
            view={route.query.view}
            report={route.query.report}
            everything={everything}
            route={route}
          />
        </Suspense>
      </div>
    </div>
  );
}
