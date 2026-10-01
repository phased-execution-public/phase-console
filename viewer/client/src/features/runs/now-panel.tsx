/**
 * "Now" — what a live phase is doing, answered from the console alone
 * (control-tower phase 95, #163).
 *
 * The report behind it is composed by the server's RULES (`analysis/
 * phase-report.ts`): the active task and its measured operation, what is done
 * and left, what it waits on, why it is slow and when it should finish. This
 * panel draws it in the order a person asks: the plain-language answer first,
 * then the phase's own task strip — each task as wide as the time it took, the
 * active one filled by its operation's progress, the ones left sized by the
 * average — then the causes, each linked to the line it was read from.
 *
 * `LastActivity` is the one-line version for a lane's row: the newest thing
 * the session did, read from its own log (#138), whatever the replay's size.
 */
import { Card, CardBody, CardHeader, CardTitle, Meter, RelativeTime } from '@/components/ui';
import type { ActivityEvent, PhaseActivity, PhaseReport, ReportSource } from '@/lib/api';
import { cn } from '@/lib/cn';
import { duration } from '@/lib/format';
import { usePhaseActivity, usePhaseReport } from '@/lib/queries';

import { journalHref } from './journal';

/** Where a figure came from, as a reader can follow it: a journal line links to it, the rest name themselves. */
function SourceMark({ source }: { source: readonly ReportSource[] }) {
  const journal = source.find((s): s is Extract<ReportSource, { kind: 'journal' }> => s.kind === 'journal');
  const words = source.map(sourceWords).join('; ');
  if (journal) {
    return (
      <a
        href={journalHref(journal.seq)}
        title={words}
        className="text-2xs text-ink-faint underline-offset-2 hover:underline"
      >
        journal {journal.seq}
      </a>
    );
  }
  return (
    <span title={words} className="text-2xs text-ink-faint">
      {source[0] ? sourceWords(source[0]) : ''}
    </span>
  );
}

export function sourceWords(source: ReportSource): string {
  switch (source.kind) {
    case 'journal':
      return `journal line ${source.seq} (${source.event})`;
    case 'session-line':
      return `session log line ${source.line}`;
    case 'task':
      return `task ${source.id}`;
    case 'lane':
      return `lane ${source.field}`;
    case 'record':
      return `phase record ${source.field}`;
    case 'machine':
      return 'machine load average';
  }
}

/**
 * The phase's own tasks on one track. Width is time: a finished task is as wide
 * as it took, the active one as long as it has run so far, and each task left
 * as wide as the finished ones averaged — so the strip's empty end is the ETA,
 * drawn. With nothing timed yet every task gets an equal share.
 */
function TaskStrip({ report }: { report: PhaseReport }) {
  const timed = report.timeline.filter((t) => t.status === 'completed' && t.durationMs != null);
  const avg = timed.length ? timed.reduce((sum, t) => sum + t.durationMs!, 0) / timed.length : null;
  const widths = report.timeline.map((t) => t.durationMs ?? avg ?? 1);
  const total = widths.reduce((a, b) => a + b, 0) || 1;
  const op = report.doing.operation;
  return (
    <div className="flex h-3 w-full gap-px overflow-hidden rounded-sm" aria-hidden="true">
      {report.timeline.map((t, i) => (
        <div
          key={t.id}
          style={{ flexGrow: widths[i]! / total, flexBasis: 0 }}
          title={`${t.text}${t.durationMs != null ? ` — ${duration(t.durationMs)}` : ''}`}
          className={cn(
            'relative min-w-1',
            t.status === 'completed' && 'bg-ink-faint/60',
            t.status === 'in_progress' && 'state-running bg-state/35',
            t.status !== 'completed' &&
              t.status !== 'in_progress' &&
              'border border-dashed border-rule bg-transparent',
          )}
        >
          {t.status === 'in_progress' && op && (
            <div
              className="state-running absolute inset-y-0 left-0 bg-state"
              style={{ width: `${op.pct}%` }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function etaWords(eta: PhaseReport['eta']): string {
  if (!eta.minutes) return 'no estimate yet';
  const { low, high } = eta.minutes;
  return high <= 0 ? 'about to finish' : `${low}–${high} min left`;
}

/** The report, drawn — pure, so a Tower card (phase 19) can reuse it with its own data. */
export function NowReport({ report, className }: { report: PhaseReport; className?: string }) {
  const op = report.doing.operation;
  const active = report.timeline.find((t) => t.status === 'in_progress');
  return (
    <Card className={className} data-testid="now-panel">
      <CardHeader className="flex-wrap items-baseline gap-x-3">
        <CardTitle>Now — phase {report.phase}</CardTitle>
        <span className="ml-auto text-xs text-ink tabular-nums" title={report.eta.basis}>
          {etaWords(report.eta)}
          {report.eta.confidence !== 'none' && (
            <span className="text-ink-faint">, {report.eta.confidence} confidence</span>
          )}
        </span>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="max-w-[75ch] text-sm leading-relaxed text-ink" data-testid="now-summary">
          {report.summary}
        </p>

        {report.timeline.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <TaskStrip report={report} />
            <p className="text-2xs text-ink-faint tabular-nums">
              {report.done.count} of {report.done.total} tasks done
              {active?.startedAt && (
                <>
                  {' '}
                  — on the current one since <RelativeTime at={active.startedAt} />
                </>
              )}
            </p>
          </div>
        )}

        {op && (
          <Meter
            value={op.done}
            max={op.of}
            label={op.label}
            valueText={`${op.done} of ${op.of}`}
            showTicks={false}
            data-testid="now-operation"
          >
            <span className="flex gap-2">
              <span>
                {op.label}: {op.done}/{op.of}
              </span>
              <SourceMark source={op.source} />
            </span>
          </Meter>
        )}

        {report.waitingOn.length > 0 && (
          <section aria-label="Waiting on" className="flex flex-col gap-1">
            <h4 className="text-2xs font-semibold text-ink">Waiting on</h4>
            <ul className="flex flex-col gap-0.5 text-xs text-ink-muted">
              {report.waitingOn.map((w) => (
                <li key={`${w.kind}-${w.text}`} className="flex flex-wrap items-baseline gap-2">
                  <span>{w.text}</span>
                  <SourceMark source={w.source} />
                </li>
              ))}
            </ul>
          </section>
        )}

        {report.whySlow.length > 0 && (
          <section aria-label="Why it is slow" className="flex flex-col gap-1">
            <h4 className="text-2xs font-semibold text-ink">Why it is slow</h4>
            <ul className="flex flex-col gap-0.5 text-xs text-ink-muted">
              {report.whySlow.map((w) => (
                <li key={w.rule} data-rule={w.rule} className="flex flex-wrap items-baseline gap-2">
                  <span>{w.text}</span>
                  <SourceMark source={w.source} />
                </li>
              ))}
            </ul>
          </section>
        )}

        {report.timeline.length > 0 && (
          <ol className="flex flex-col gap-0.5 text-xs" aria-label="Tasks">
            {report.timeline.map((t) => (
              <li
                key={t.id}
                data-status={t.status}
                className={cn(
                  'grid grid-cols-[1fr_auto_auto] items-baseline gap-3',
                  t.status === 'in_progress'
                    ? 'text-ink'
                    : t.status === 'completed'
                      ? 'text-ink-muted'
                      : 'text-ink-faint',
                )}
              >
                <span className={cn('truncate', t.status === 'in_progress' && 'font-semibold')}>
                  {t.text}
                </span>
                <span className="text-2xs text-ink-faint tabular-nums">
                  {t.startedAt ? <RelativeTime at={t.startedAt} /> : 'not started'}
                </span>
                <span className="w-14 text-right text-2xs tabular-nums">
                  {t.durationMs != null ? duration(t.durationMs) : ''}
                </span>
              </li>
            ))}
          </ol>
        )}

        <p className="text-2xs text-ink-muted" title={report.eta.basis}>
          {report.eta.minutes
            ? `ETA from this phase's own rate: ${report.eta.basis}.`
            : `No ETA: ${report.eta.basis}.`}
        </p>
      </CardBody>
    </Card>
  );
}

/** The Now panel for one phase: fetches its report and refreshes with the journal (no reload). */
export function NowPanel({
  slug,
  phase,
  enabled = true,
  className,
}: {
  slug: string;
  phase: number;
  enabled?: boolean;
  className?: string;
}) {
  const { data } = usePhaseReport(slug, phase, enabled);
  if (!data || !('live' in data) || !data.live) return null;
  return <NowReport report={data} className={className} />;
}

/** One event as a line a person reads. */
export function activityLine(event: ActivityEvent): string {
  if (event.kind === 'text') return event.text.replace(/\s+/g, ' ').slice(0, 160);
  if (event.kind === 'marker')
    return `${event.marker === 'input' ? 'told' : event.marker}: ${event.text.replace(/\s+/g, ' ').slice(0, 120)}`;
  const what = event.description ?? event.summary ?? '';
  const state = event.open
    ? 'running'
    : event.exit === 'error'
      ? `failed${event.code != null ? ` (exit ${event.code})` : ''}`
      : '';
  return `${event.name}${what ? ` — ${what.slice(0, 120)}` : ''}${state ? `, ${state}` : ''}`;
}

/** The newest activity as one line — pure, for a card that already holds the payload. */
export function LastActivityLine({
  activity,
  className,
}: {
  activity: PhaseActivity | undefined;
  className?: string;
}) {
  // `events ?? []`: a payload without them (an older server, an error body) is
  // no activity — never a render error that takes the whole board down with it.
  const events = activity?.events ?? [];
  const last = events[events.length - 1];
  if (!last) return null;
  return (
    <span
      className={cn('flex min-w-0 basis-full items-baseline gap-1.5 text-2xs text-ink-muted', className)}
      data-testid="last-activity"
      title={`From the session's own log, line ${last.line}`}
    >
      <span className="truncate">{activityLine(last)}</span>
      <RelativeTime at={last.at} className="shrink-0 text-ink-faint" />
    </span>
  );
}

/** The last thing a live lane did, read from its session's own log (#138). */
export function LastActivity({
  slug,
  phase,
  enabled = true,
  className,
}: {
  slug: string;
  phase: number;
  enabled?: boolean;
  className?: string;
}) {
  const { data } = usePhaseActivity(slug, phase, enabled, 5);
  return <LastActivityLine activity={data} className={className} />;
}

/**
 * A Now panel for each live lane of a run — what the run page shows under its
 * tiles, and what the Tower's lane card reuses (phase 19). Four at most: a run
 * with more lanes than that is read lane by lane, in the drawer.
 */
export function LiveNow({
  slug,
  phases,
  enabled = true,
}: {
  slug: string;
  phases: readonly number[];
  enabled?: boolean;
}) {
  if (!phases.length) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="live-now">
      {phases.slice(0, 4).map((phase) => (
        <NowPanel key={phase} slug={slug} phase={phase} enabled={enabled} />
      ))}
    </div>
  );
}
