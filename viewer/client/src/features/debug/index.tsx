/**
 * Debug — the destination that answers what the console SAW.
 *
 * The console has always kept a great deal it never showed anybody: an NDJSON
 * log with no endpoint at all, a supervisor stdout/stderr pair with no
 * programmatic access whatsoever, a couple of hundred kinds of journal event reachable one run
 * at a time, a delivery ledger rendered nowhere, a watch clock whose own source
 * said "nothing reads it yet", and a metrics endpoint with a link and no
 * reader. Every one of those was a file, and reading one meant knowing which
 * file and leaving the console for a terminal.
 *
 * Four sections over one server module, and one more surface underneath them
 * that is not for a person at all: `/api/debug/bundle`, a redacted snapshot
 * sized for a model's context. "Make future debugging easy" means both readers.
 *
 * The L0 card stays exactly what Phase 4 shipped, including its three-way
 * watcher reading. This is the page you open BECAUSE the console is
 * misbehaving, so a failed `/api/state` must not leave it quietly reporting
 * "watching" — the one lie a diagnostics page cannot afford, and now the first
 * thing a reader sees above four sections that could each fail differently.
 */

import type { ViewProps } from '@/app/router';
import { Page } from '@/components/page';
import { Card, CardBody, CardHeader, CardSkeleton, CardTitle, PageError } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useConsoleState } from '@/lib/queries';
import { DEBUG_SECTIONS, debugHref, sectionFor, type DebugSection } from './routes';
import LogSection from './log-section';
import JournalSection from './journal-section';
import DeliverySection from './delivery-section';
import HealthSection from './health-section';

const SUBTITLE = 'Logs, journals and diagnostics — what the console saw';

/**
 * Every body in the destination's own chunk, for Repo's reason: none of them
 * pulls a dependency the rest of the app does not already have, so splitting
 * further would only add round trips and grow the service worker's precache
 * list. The map is keyed by `DebugSection`, so a section added to
 * `DEBUG_SECTIONS` without a body here is a compile error rather than a blank
 * page — which is also what keeps the two Pro sections' marker regions
 * matched: strip one half and the other stops typechecking.
 */
const SECTION_BODY: Record<DebugSection, React.ComponentType<{ route: ViewProps['route'] }>> = {
  logs: LogSection,
  journal: JournalSection,
  delivery: DeliverySection,
  health: HealthSection,
};

/**
 * One fact, with the structural uppercase of design.md §9 over it.
 *
 * The classes are `SectionHeading`'s `band` size verbatim rather than a fourth
 * spelling of it — the kit component cannot be used here because a definition
 * list's term must be a `<dt>` and its `as` union has no `'dt'`. If that union
 * ever grows one, this becomes `<SectionHeading as="dt">`.
 */
function Fact({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div>
      <dt className="text-2xs font-medium tracking-[0.14em] text-ink-faint uppercase">{label}</dt>
      {/* `break-words`, not `truncate`. A fact whose whole value lives in a
          `title` is a fact a phone cannot read at all — there is no hover — and
          the longest one here is the supervisor sentence (`launchd ·
          com.phase-console · KeepAlive is on, so a clean exit comes straight
          back`), which was cut at EVERY width: 693px of text in a 559px cell at
          1440. It is two lines of prose, not an identifier; wrapping costs a
          line and truncating cost the sentence. The `title` stays for the
          pointer, where it is a convenience rather than the only copy. */}
      <dd className="mt-0.5 font-mono text-xs break-words" title={title ?? value}>
        {value}
      </dd>
    </div>
  );
}

function SectionNav({ current }: { current: DebugSection }) {
  return (
    <nav aria-label="Debug sections" className="flex flex-wrap gap-1">
      {DEBUG_SECTIONS.map((section) => (
        <a
          key={section.id}
          href={debugHref(section.id)}
          title={section.blurb}
          aria-current={section.id === current ? 'page' : undefined}
          className={cn(
            'min-h-(--tap-min) rounded px-3 py-1.5 text-sm transition-colors sm:min-h-0',
            section.id === current
              ? 'bg-surface-raised text-ink'
              : 'text-ink-muted hover:bg-surface hover:text-ink',
          )}
        >
          {section.label}
        </a>
      ))}
    </nav>
  );
}

export default function DebugPage({ route }: ViewProps) {
  const { data: state, isPending, error, refetch } = useConsoleState();
  const section = sectionFor(route.segments[1]);
  const Body = SECTION_BODY[section];

  if (isPending) {
    return (
      <Page title="Debug" subtitle={SUBTITLE}>
        <CardSkeleton loading />
      </Page>
    );
  }

  if (error) {
    return (
      <Page title="Debug" subtitle={SUBTITLE}>
        <PageError error={error} retry={() => void refetch()} />
      </Page>
    );
  }

  // Three readings, not two: stopped (it said so), watching (it said so), and
  // unknown (nothing said anything). Collapsing the third into "watching" is
  // how a diagnostics page reassures you about the thing that is broken.
  const watcher = state?.watcher
    ? state.watcher.ok === false
      ? (state.watcher.detail ?? 'stopped')
      : 'watching'
    : 'unknown';

  return (
    <Page title="Debug" subtitle={SUBTITLE}>
      <Card>
        <CardHeader>
          <CardTitle>What this console is</CardTitle>
        </CardHeader>
        <CardBody>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <Fact label="Supervisor" value={state?.supervisor?.detail ?? 'unknown'} />
            <Fact label="Platform" value={state?.platform ?? 'unknown'} />
            <Fact label="Source" value={state?.root?.path ?? 'none open'} />
            <Fact label="File watcher" value={watcher} />
          </dl>
        </CardBody>
      </Card>

      <div className="mt-6 flex flex-col gap-3">
        <SectionNav current={section} />
        <Body route={route} />
      </div>
    </Page>
  );
}
