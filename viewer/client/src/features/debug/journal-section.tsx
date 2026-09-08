/**
 * One run, drawn as it happened — and why a phase is not done.
 *
 * Everything here already existed on the server and none of it was reachable
 * from a page a person opens when something is wrong: `projectTimeline` had a
 * renderer on the Runs destination but only for the CURRENT run of a plan you
 * were already looking at, and `phaseDiagnosis` — the richest payload this
 * console has for "why is this not done" — had an endpoint and no reader at
 * all outside a run row.
 *
 * So this section is deliberately a READER, not a second projection: it picks
 * a plan and a run (including finished ones), draws `Gantt` over the existing
 * timeline, and anchors the diagnosis beside it. A second Gantt with its own
 * geometry would be a second thing to keep true.
 */

import { Activity } from 'lucide-react';

import type { ViewProps } from '@/app/router';
import { useNavigate } from '@/app/router';
import {
  Banner,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Empty,
  KeyValue,
  PageError,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from '@/components/ui';
import type { ApiError } from '@/lib/api';
import { Gantt } from '@/features/runs/gantt';
import { useConsoleState, useDebugRuns, useDiagnosis, useTimeline } from '@/lib/queries';
import { debugHref } from './routes';

/**
 * The plans offered.
 *
 * Read off `/api/state`'s runs rather than the plan list: this section is
 * about runs, and a plan that has never run has no journal to draw. Falling
 * back to the index's own slug list would offer plans whose picker then
 * showed no runs, which reads as a broken picker rather than as an honest
 * "nothing has run here".
 */
function planOptions(runs: { slug: string }[] | undefined): string[] {
  const seen = new Set<string>();
  for (const run of runs ?? []) seen.add(run.slug);
  return [...seen].sort();
}

export default function JournalSection({ route }: { route: ViewProps['route'] }) {
  const navigate = useNavigate();
  const { data: state } = useConsoleState();
  const plans = planOptions(state?.runs as { slug: string }[] | undefined);

  const slug = route.query.slug || plans[0] || '';
  const { data: runs } = useDebugRuns(slug || undefined);
  const runId = route.query.run || runs?.runs[0] || undefined;

  const timeline = useTimeline(slug || undefined, runId, Boolean(slug));
  // In the URL, not in `useState`. Two reasons, and the second is the one that
  // matters: a diagnosis is EVIDENCE, so "look at why phase 7 stopped" has to
  // be a link — and `onCompare` is only offered on a lane with two or more
  // attempts (`features/runs/gantt.tsx:181`), so a bar was never a way to reach
  // the diagnosis for a phase that failed on its first try, which is most of
  // them.
  const phaseRaw = route.query.phase ?? '';
  const phase = phaseRaw && Number.isFinite(Number(phaseRaw)) ? Number(phaseRaw) : null;
  // Only for a phase this run actually boarded. Without the check the page
  // fired a request whose answer it would not render — and then rendered the
  // 404's sentence ("no run has a record of phase N") over a phase that simply
  // belongs to a different run, which is the wrong answer to the right words.
  const phaseInRun = phase !== null && Boolean(timeline.data?.lanes.some((lane) => lane.phase === phase));
  const diagnosis = useDiagnosis(slug || undefined, phase ?? undefined, phaseInRun);

  const go = (next: Record<string, string | undefined>) =>
    navigate(debugHref('journal', { slug, run: runId, phase: phaseRaw, ...next }));

  if (!plans.length) {
    return (
      <Empty
        icon={<Activity size={20} aria-hidden />}
        title="No run has been recorded here"
        // No `action`: what would fill this is a run somebody starts on the
        // Plans destination, not a button on a diagnostics page.
        body="A journal is written by an autopilot run. Once a plan has run once, its timeline and every attempt’s reasoning are readable here — including for runs that have finished."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-2xs text-ink-faint uppercase">
          Plan
          <Select value={slug} onValueChange={(next) => go({ slug: next, run: undefined })}>
            <SelectTrigger className="min-w-44" aria-label="Plan">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {plans.map((one) => (
                <SelectItem key={one} value={one}>
                  {one}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-1 text-2xs text-ink-faint uppercase">
          Phase
          <Select value={phaseRaw} onValueChange={(next) => go({ phase: next })}>
            <SelectTrigger className="min-w-28" aria-label="Phase">
              <SelectValue placeholder="pick one" />
            </SelectTrigger>
            <SelectContent>
              {(timeline.data?.lanes ?? []).map((lane) => (
                <SelectItem key={lane.phase} value={String(lane.phase)}>
                  {`Phase ${lane.phase}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-1 text-2xs text-ink-faint uppercase">
          Run
          <Select value={runId ?? ''} onValueChange={(next) => go({ run: next })}>
            <SelectTrigger className="min-w-40" aria-label="Run">
              <SelectValue placeholder="newest" />
            </SelectTrigger>
            <SelectContent>
              {(runs?.runs ?? []).map((one) => (
                <SelectItem key={one} value={one}>
                  {one}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>

      {timeline.isPending ? (
        <div className="grid place-items-center py-16">
          <Spinner />
        </div>
      ) : null}
      {timeline.error ? <PageError error={timeline.error} retry={() => void timeline.refetch()} /> : null}

      {timeline.data ? (
        <>
          {timeline.data.truncated ? (
            <Banner severity="warn">
              This run’s journal was longer than the projection reads, so the earliest work is not drawn.
            </Banner>
          ) : null}
          <Gantt
            timeline={timeline.data}
            // The Gantt's own compare affordance is a phase number, which is
            // exactly what the diagnosis needs — so clicking a bar asks "why
            // is this one not done" rather than opening a second page.
            onCompare={(lane) => go({ phase: String(lane) })}
          />
        </>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Why a phase is not done</CardTitle>
        </CardHeader>
        <CardBody>
          {phase !== null && timeline.data && !phaseInRun ? (
            // An out-of-range `?phase=` is a real URL somebody can arrive with —
            // a link to a phase this RUN never boarded. Saying which run is
            // being read is the difference between "that phase does not exist"
            // and "you are looking at the wrong run".
            <p className="text-sm text-ink-muted" data-testid="phase-not-in-run">
              {`Phase ${phase} is not in ${runId ? `run ${runId}` : 'this run'}. Pick one above.`}
            </p>
          ) : phase === null ? (
            <p className="text-sm text-ink-muted">
              Pick a phase above. The console reads the command output, the session’s closing words, the lint
              summary and the board-vs-handoff disagreement into one answer.
            </p>
          ) : diagnosis.isPending ? (
            <Spinner />
          ) : diagnosis.error ? (
            // A 404 here is an ANSWER — no run of this plan has a record of
            // that phase. ANYTHING ELSE IS A FAILED READ, and the first cut
            // printed the answer for both: a 500, or a tailnet that dropped,
            // rendered a definitive negative in the panel titled "Why a phase
            // is not done" — 35 lines below `timeline.error` doing it right.
            // The status decides which sentence this is.
            (diagnosis.error as ApiError)?.status === 404 ? (
              <p className="text-sm text-ink-muted">{`No run of ${slug} has a record of phase ${phase}.`}</p>
            ) : (
              <PageError error={diagnosis.error} retry={() => void diagnosis.refetch()} />
            )
          ) : diagnosis.data ? (
            <KeyValue
              items={[
                ['Phase', String(diagnosis.data.phase)],
                ['Status', diagnosis.data.status ?? 'unknown'],
                diagnosis.data.blockedOn ? ['Blocked on', diagnosis.data.blockedOn] : null,
                diagnosis.data.situation ? ['Situation', String(diagnosis.data.situation)] : null,
                diagnosis.data.said ? ['Last words', diagnosis.data.said] : null,
                diagnosis.data.note ? ['Note', diagnosis.data.note] : null,
                ['Resumable', diagnosis.data.resumable ? 'yes' : 'no'],
              ]}
            />
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
