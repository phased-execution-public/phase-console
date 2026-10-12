/**
 * Logs — what the console SAW (7.0, quiet-console phase 20; Debug until 7.0).
 *
 * ```
 * Logs
 * Watching pe-hub on darwin. Supervised by launchd, so a clean exit comes back.
 * Logs   Journal   Delivery   Timeline   Git   Health   Access
 * …the section…
 * ```
 *
 * The console keeps a great deal nobody reads until something goes wrong: its
 * own log, the supervisor's stdout and stderr, every run's journal, what each
 * announcement did on each device, the doctor's probes, the process's own
 * gauges, who it has served. Seven sections over them, each an address
 * (`routes.ts`), and one surface that is not for a person at all — the
 * redacted bundle on Health, sized for a model's context.
 *
 * The glance is what this console is (`facts.tsx`), read from its own state;
 * a failed read says so there and leaves every section working, because this
 * is the page a person opens BECAUSE the console misbehaves.
 */

import { Suspense, lazy, type ComponentType } from 'react';
import { useConsoleState } from '@/data/console';
import type { Route } from '@/shell/routes';
import { SectionNav } from '@/shell/section-nav';
import { Page, Skeleton } from '@/ui';
import AccessSection from './access-section';
import DeliverySection from './delivery-section';
import { LogsFacts } from './facts';
import HealthSection from './health-section';
import LogsSection from './logs-section';
import { LOGS_SECTIONS, logsSectionHref, logsSectionOf, type LogsSectionId } from './routes';

/**
 * The journal arrives when it is opened: it draws the run view's own Gantt,
 * and a reader of the log explorer should not download the run view's figures.
 */
const JournalSection = lazy(() => import('./journal-section'));

/**
 * Keyed by the section id, so a section added to `LOGS_SECTIONS` without a
 * body is a type error rather than a blank page — which also keeps the two Pro
 * sections' marker regions matched.
 */
const BODIES: Readonly<Record<LogsSectionId, ComponentType<{ route: Route }>>> = {
  logs: LogsSection,
  journal: JournalSection,
  delivery: DeliverySection,
  health: HealthSection,
  access: AccessSection,
};

export default function LogsPlace({ route }: { route: Route }) {
  const section = logsSectionOf(route.segments[1]);
  const state = useConsoleState();
  const Body = BODIES[section];

  return (
    <Page
      title="Logs"
      lead={<LogsFacts state={state.data} error={state.error} retry={() => void state.refetch()} />}
      data-testid="logs-page"
      data-section={section}
    >
      <div className="flex min-w-0 flex-col gap-4">
        <SectionNav
          label="Logs sections"
          current={section}
          sections={LOGS_SECTIONS.map((s) => ({ id: s.id, label: s.label, href: logsSectionHref(s.id) }))}
        />
        <Suspense
          fallback={
            <div className="flex flex-col gap-3" aria-busy="true" aria-label="Opening the section">
              <Skeleton className="h-8 max-w-sm" />
              <Skeleton className="h-40" />
            </div>
          }
        >
          <Body route={route} />
        </Suspense>
      </div>
    </Page>
  );
}
