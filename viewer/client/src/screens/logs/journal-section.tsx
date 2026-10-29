/**
 * Logs ▸ Journal — one run, drawn as it happened, and why a phase is not done.
 *
 * ```
 * Plan quiet-console ▾   Run a0de94f27bb4 ▾   Phase 7 ▾              Export this run
 * ▁▁▁▁▁▁ the run's Gantt ▁▁▁▁▁▁
 * Why phase 7 is not done
 *   Status       parked
 *   Situation    Waiting on a sibling — phase 6 has not finished
 *   Last words   …
 * ```
 *
 * A READER, not a second projection: it picks a plan and a run — finished
 * ones included, which the run view does not reach — and draws the run view's
 * own Gantt over the server's timeline, with the server's diagnosis of one
 * phase under it. The phase is in the address, because "look at why phase 7
 * stopped" has to be a link.
 */

import { consolePath } from '@/lib/base';
import { ApiError, api } from '@/data/api';
import { useDiagnosis, useTimeline } from '@/data/runs';
import { navigate, type Route } from '@/shell/routes';
import { Banner, Button, Empty, KeyValue, SectionHeading, Skeleton } from '@/ui';
import { RunGantt } from '@/screens/plan/run/gantt';
import { logsSectionHref, phaseOf } from './routes';
import { RunPick, useRunPick } from './run-pick';

export default function JournalSection({ route }: { route: Route }) {
  const { plans, slug, runId, runs } = useRunPick(route.query);
  const timeline = useTimeline(slug || undefined, runId, Boolean(slug));
  const phaseRaw = route.query.phase ?? '';
  const phase = phaseOf(phaseRaw);
  // Only a phase this run boarded is asked about: a phase of another run would
  // come back as "no run has a record of it", the wrong answer to the right words.
  const phases = (timeline.data?.lanes ?? []).map((lane) => lane.phase);
  const phaseInRun = phase !== undefined && phases.includes(phase);
  const diagnosis = useDiagnosis(slug || undefined, phase, phaseInRun);

  const go = (next: { slug?: string; run?: string; phase?: string }) =>
    navigate(logsSectionHref('journal', { slug, run: runId, phase: phaseRaw, ...next }));

  if (!plans.length) {
    return (
      <Empty title="No run has been recorded here. A journal is written by an autopilot run, and a plan that has run once is readable here, finished runs included." />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="journal">
      <RunPick
        plans={plans}
        slug={slug}
        runs={runs}
        runId={runId}
        phases={phases}
        phase={phaseInRun ? phaseRaw : undefined}
        onChange={go}
        action={
          slug && runId ? (
            <Button size="sm" asChild>
              <a
                href={consolePath(api.runBundleHref(slug, runId))}
                download
                title="Everything about this run, redacted, as a tar.gz — attach it to an issue or hand it to a model."
              >
                Export this run
              </a>
            </Button>
          ) : undefined
        }
      />

      {timeline.error ? (
        <Banner
          severity="error"
          action={
            <Button size="sm" variant="ghost" onClick={() => void timeline.refetch()}>
              Try again
            </Button>
          }
        >
          The run’s timeline could not be read: {timeline.error.message}
        </Banner>
      ) : !timeline.data ? (
        <div aria-busy="true" aria-label="Projecting the run" className="h-48">
          <Skeleton className="size-full" />
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-2">
          {timeline.data.truncated && (
            <Banner severity="warn">
              This run’s journal was longer than the projection reads, so its earliest work is not drawn.
            </Banner>
          )}
          {/* A lane with two attempts names its phase here, which is exactly
              what the diagnosis below needs. */}
          <RunGantt timeline={timeline.data} onCompare={(lane) => go({ phase: String(lane) })} />
        </div>
      )}


      <section aria-labelledby="journal-why" className="flex min-w-0 flex-col gap-3" data-testid="diagnosis">
        <SectionHeading id="journal-why">
          {phaseInRun ? `Why phase ${phase} is not done` : 'Why a phase is not done'}
        </SectionHeading>
        {phase !== undefined && timeline.data && !phaseInRun ? (
          <p className="text-body text-ink-muted" data-testid="phase-not-in-run">
            {`Phase ${phase} is not in ${runId ? `run ${runId}` : 'this run'}. Pick one of its phases above.`}
          </p>
        ) : phase === undefined ? (
          <p className="max-w-(--measure) text-body text-ink-muted">
            Pick a phase above: the console reads its command output, the session’s closing words, the lint
            and the board against the handoff into one answer.
          </p>
        ) : diagnosis.error ? (
          // A 404 is an ANSWER — no run of this plan has a record of the
          // phase. Anything else is a failed read, and says so.
          diagnosis.error instanceof ApiError && diagnosis.error.status === 404 ? (
            <p className="text-body text-ink-muted">{`No run of ${slug} has a record of phase ${phase}.`}</p>
          ) : (
            <Banner
              severity="error"
              action={
                <Button size="sm" variant="ghost" onClick={() => void diagnosis.refetch()}>
                  Try again
                </Button>
              }
            >
              The diagnosis could not be read: {diagnosis.error.message}
            </Banner>
          )
        ) : !diagnosis.data ? (
          <Skeleton className="h-24 max-w-md" />
        ) : (
          <KeyValue
            items={[
              ['Status', diagnosis.data.status || 'unknown'],
              diagnosis.data.blockedOn ? ['Blocked on', diagnosis.data.blockedOn] : null,
              diagnosis.data.situation
                ? [
                    'Situation',
                    `${diagnosis.data.situation.label}${diagnosis.data.situation.blurb ? ` — ${diagnosis.data.situation.blurb}` : ''}`,
                  ]
                : null,
              diagnosis.data.said ? ['Last words', diagnosis.data.said] : null,
              diagnosis.data.note ? ['Note', diagnosis.data.note] : null,
              ['Resumable', diagnosis.data.resumable ? 'yes' : 'no'],
              diagnosis.data.lint ? ['Lint', diagnosis.data.lint.summary] : null,
              diagnosis.data.lock ? ['Lock', diagnosis.data.lock] : null,
              diagnosis.data.workingTree.length
                ? ['Uncommitted', diagnosis.data.workingTree.join(', ')]
                : null,
              diagnosis.data.evidence?.length ? ['Evidence', diagnosis.data.evidence.join('; ')] : null,
            ]}
          />
        )}
      </section>
    </div>
  );
}
