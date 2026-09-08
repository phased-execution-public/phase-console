/**
 * One plan: its route, its board, its phases, handoffs and analysis.
 *
 * Two things here are deliberate and easy to undo by accident:
 *
 * 1. **The page does not blank while it refreshes.** `usePlan` keeps the last
 *    answer on screen (`keepPreviousData`) instead of dropping to a spinner, so
 *    another session finishing a phase — or a file saved in an editor, or the
 *    watcher warming — no longer throws away the thing you were reading and your
 *    scroll position with it. The one case that *does* fall back to a skeleton
 *    is a different plan, where holding the previous one would be a lie.
 *
 * 2. **The tab strip is a real tablist.** Radix owns roving tabindex, arrow
 *    keys, Home/End and the `aria-controls` wiring; the old client's `div
 *    role=tablist` had `aria-selected` and nothing else, so arrow keys did
 *    nothing and every tab was its own tab stop.
 */

import { Suspense, lazy } from 'react';
import {
  Button,
  PageError,
  Skeleton,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { useAutoReadNotifications, usePlan } from '@/lib/queries';
import { navigate, planHref } from '@shared/routes.js';
import { Page } from '@/components/page';
import { PlanHeader } from './header';
import { RouteTab } from './route-tab';
import { PhasesTab } from './phases-tab';
import {
  DETAIL_TABS,
  TAB_IDS,
  includesForTab,
  isDetailRoute,
  resolveTab,
  sourceViewOf,
  tabLabel,
} from './tabs';
import type { PlanDetail } from '@/lib/api';
import type { ViewProps } from '@/app/router';

/**
 * The autopilot is its own chunk inside the plan chunk.
 *
 * It is the largest surface here by some way — controls, the skill picker, the
 * approval queue, the console model — and most visits to a plan are to read the
 * route map or a handoff. Splitting it keeps that reading path as cheap as it
 * was before the run view existed, for the same reason the plan surface is split
 * from the shell.
 */
const RunView = lazy(() => import('@/features/runs/run-page'));

/**
 * The four tab bodies nobody opens first.
 *
 * `route` is the default and `phases` is what the Route tab BECOMES on a phone,
 * so both stay in this chunk — making them lazy would buy nothing and cost the
 * phone an extra round trip on the one surface where round trips are dearest.
 * The other four are opened deliberately, by someone who has already read the
 * route map, and each drags something the route map does not need: the two
 * handoff surfaces pull the handoff renderer, and Source pulls `marked` and the
 * whole plan document.
 *
 * ⚠️ A helper imported from one of these files is a static import of the file.
 * That is why `sourceViewOf` moved to `./tabs` — see the note there.
 */
const PhasePanel = lazy(() => import('./phase-panel').then((m) => ({ default: m.PhasePanel })));
const HandoffPanel = lazy(() => import('./handoffs-tab').then((m) => ({ default: m.HandoffPanel })));
const HandoffsTab = lazy(() => import('./handoffs-tab').then((m) => ({ default: m.HandoffsTab })));
const QaTab = lazy(() => import('./qa-tab').then((m) => ({ default: m.QaTab })));
const SourceTab = lazy(() => import('./source-tab').then((m) => ({ default: m.SourceTab })));

function PlanSkeleton() {
  return (
    <Page>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    </Page>
  );
}

/** The shape of a tab body, while its chunk is on the way. */
function TabSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/** What each tab shows. Total over `PLAN_TABS` — a client test asserts it. */
function TabBody({
  tab,
  arg,
  detail,
  view,
  report,
}: {
  tab: string;
  arg?: string;
  detail: PlanDetail;
  /** `?view=` — which half of a tab, for the one tab that has two. */
  view?: string;
  /** `?report=<phase>[:<round>]` — the QA report sheet, open ⟺ the address says so. */
  report?: string;
}) {
  const slug = detail.summary.slug;
  switch (tab) {
    case 'phase':
      return <PhasePanel detail={detail} phase={arg} />;
    case 'handoff':
      return <HandoffPanel detail={detail} phase={arg} />;
    case 'phases':
      return <PhasesTab detail={detail} />;
    case 'qa':
      return <QaTab detail={detail} report={report} />;
    case 'handoffs':
      return <HandoffsTab detail={detail} />;
    case 'source':
      return <SourceTab detail={detail} slug={slug} view={sourceViewOf(view)} />;
    case 'run':
      return (
        <Suspense fallback={<Spinner label="Reading run state" />}>
          <RunView detail={detail} />
        </Suspense>
      );
    default:
      return <RouteTab detail={detail} />;
  }
}

export default function PlanView({ route }: ViewProps) {
  const [, slug, segment, arg] = route.segments;
  const tabId = resolveTab(segment);
  const detailKind = isDetailRoute(segment) ? segment : null;

  // What THIS tab renders, and nothing else. The board projection is the
  // default; the phase surfaces add the prose and the handoff references, and
  // the Source tab adds the memory file. Each set is a module-level constant,
  // so a tab keeps one query key across renders — see `usePlan`.
  const { data, error, isPending, refetch } = usePlan(slug, includesForTab(detailKind ?? tabId));

  // Opening a plan — any tab of it, including the autopilot — counts as reading
  // its notifications. Scoped to this slug, so the count drops by exactly the
  // records this page is about and by nothing else.
  useAutoReadNotifications({ slug }, Boolean(slug));

  if (error) {
    return (
      <Page title={slug ?? 'Plan'}>
        <PageError error={error} retry={refetch} />
      </Page>
    );
  }

  // `keepPreviousData` will happily hand over the *previous* plan while a new
  // slug loads. Showing one plan's phases under another's name is worse than a
  // skeleton, so that one case waits.
  if (isPending || !data || (slug && data.summary.slug !== slug)) {
    return <PlanSkeleton />;
  }

  return (
    <Page>
      <PlanHeader detail={data} />

      <Tabs value={tabId} onValueChange={(id) => navigate(planHref(data.summary.slug, id))}>
        <TabsList aria-label="Plan sections">
          {TAB_IDS.map((id) => (
            <TabsTrigger key={id} value={id}>
              {tabLabel(id)}
              {id === 'phases' && <Count n={data.phases.length} />}
              {id === 'handoffs' && <Count n={data.handoffs.length} />}
            </TabsTrigger>
          ))}
        </TabsList>

        {TAB_IDS.map((id) => (
          <TabsContent key={id} value={id} className="pt-4">
            {id === tabId && (
              <>
                {detailKind && (
                  <div className="mb-3">
                    <Button asChild variant="ghost" size="sm">
                      <a href={planHref(data.summary.slug, DETAIL_TABS[detailKind])}>
                        ← All {DETAIL_TABS[detailKind]}
                      </a>
                    </Button>
                  </div>
                )}
                {/* Per PANEL, not per page: the header and the tab strip stay
                    put while a lazy body arrives, so switching tabs never
                    blanks the plan you are reading. `run` keeps a boundary of
                    its own inside `TabBody` — it has a better sentence for the
                    wait than a shape does. */}
                <Suspense fallback={<TabSkeleton />}>
                  <TabBody
                    tab={detailKind ?? tabId}
                    arg={arg}
                    detail={data}
                    view={route.query.view}
                    report={route.query.report}
                  />
                </Suspense>
              </>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </Page>
  );
}

/** The number beside a tab's name — a count, not a badge, so it never shouts. */
function Count({ n }: { n: number }) {
  if (!n) return null;
  return <span className="ml-1.5 font-mono text-2xs text-ink-faint">{n}</span>;
}
