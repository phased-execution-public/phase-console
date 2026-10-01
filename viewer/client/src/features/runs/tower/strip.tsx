/**
 * The strip — a run drawn as a flight strip (control-tower phase 19,
 * §Architecture 5). The one place the redesign spends its boldness.
 *
 * ```
 * ▌[icon Word] [mark] name ·························· running 12m 03s
 * ▌●●●●◉○○○○  5/9   $4.20/$25        [ the one action ] [v]
 * ▌Bash — npm test, running · 2 minutes ago            (live lanes only)
 *  └ expanded in place: the halt card · lanes · Now · clocks · cost ·
 *    every verb · Inspect · Open run
 * ```
 *
 * Glance first: the edge is the run's paint, the badge its precise word and
 * icon (`describeRun` — never a colour alone), the mark whether it summons a
 * person, then the name, the phase track, ONE labelled clock and the cost —
 * and exactly ONE action (`strip-model.ts` says which, by bay). Everything the
 * old card showed is one press away, in place (`strip-detail.tsx`), and the
 * raw record two (the Inspector).
 *
 * The strip is fed the run the page already holds: a `run:progress` frame
 * patches `['runs']` in place (`lib/queries.ts`), so the word, the track, the
 * clock, the tasks and the in-flight spend move with no refetch. The clock
 * ticks here — each second while a lane is live, each half-minute otherwise.
 */

import { Suspense, lazy, useCallback, useId, useMemo, useState } from 'react';
import { ChevronDown, ExternalLink, Hand, Snowflake } from 'lucide-react';
import { queueMarks } from '../queue-words';

import { planHref } from '@shared/routes.js';
import type { RunCtx } from '@shared/status-model.js';
import { Button, Badge, Inspector, InspectorSection, KeyValue, MonoId } from '@/components/ui';
import { AttentionMark, ViewBadge } from '@/components/ui/status';
import { RunStrip } from '@/components/charts';
import { Peek } from '@/components/peek';
import { useNow } from '@/lib/clock';
import { cn } from '@/lib/cn';
import { clockWords, money, type LabelledClock } from '@/lib/format';
import { usePrefs } from '@/lib/prefs';
import { runRecoverVerb, type RunRecoverVerb } from '@/lib/run-recover';
import { useRunLifecycle, type RunLifecycle } from '@/lib/run-lifecycle';
import type { QueueEntry, RunState, VerifyingLane } from '@/lib/api';
import type { NowLane } from '@/features/runs/lanes-model';
import { LastActivity } from '../now-panel';
import { StripDetail } from './strip-detail';
import { stripModel, type StripAction, type StripModel } from './strip-model';
import { WhyLine } from './why-line';

/** The step card's one action, loaded with the card (control-tower phase 42). */
const StepCard = lazy(() =>
  import('@/components/human-step-card').then((m) => ({ default: m.HumanStepCard })),
);

/** How many expanded strips a person's preferences remember — the newest win. */
const REMEMBERED = 40;

/**
 * The prop contract. Everything is what the page already folded — the strip
 * fetches nothing to draw its glance.
 */
export interface StripProps {
  run: RunState;
  /** This run's lanes, from the page's ONE `nowLanes` fold. */
  lanes: readonly NowLane[];
  /** The console's own checks on this run (`run.verifying`). */
  checks?: readonly VerifyingLane[];
  /** The admission entry of this run's queued lane, when the queue has one. */
  entry?: QueueEntry;
  /** `--allow-run`: without it the one action is Open run and no verb is drawn. */
  allowRun: boolean;
  /** The board column it sits in today — kept as `data-column` until the Tower's bays replace it. */
  column?: string;
  /** `describeRun`'s context — the inbox, a closed plan, a newer run — when the page holds it. */
  ctx?: RunCtx;
  /**
   * `bay` (the Tower's, the default) expands in place; `row` is the run page's
   * HEADER (control-tower phase 24): the page below IS the expansion, so it
   * draws no chevron, no detail and no inspector, its name is not a link to
   * the page it heads, and a verb that needs more than a press is left to the
   * halt card beneath it.
   */
  variant?: 'bay' | 'row';
  /** The phase's own total beside the attempt clock (#28) — the run page's header only. */
  total?: LabelledClock | null;
}

export function Strip({
  run,
  lanes,
  checks,
  entry,
  allowRun,
  column,
  ctx,
  variant = 'bay',
  total,
}: StripProps) {
  const row = variant === 'row';
  const [prefs, setPrefs] = usePrefs();
  const open = prefs.stripsOpen.includes(run.id);
  const setOpen = useCallback(
    (next: boolean) => {
      const others = prefs.stripsOpen.filter((id) => id !== run.id);
      setPrefs({ stripsOpen: next ? [run.id, ...others].slice(0, REMEMBERED) : others });
    },
    [prefs.stripsOpen, run.id, setPrefs],
  );
  const anyLive = lanes.some(
    (lane) => !lane.frozen && (lane.status === 'running' || lane.status === 'verifying'),
  );
  const now = useNow(true, anyLive ? 1000 : 30_000);
  const model = useMemo(
    () =>
      stripModel({
        run,
        lanes,
        now,
        allowRun,
        ...(checks ? { checks } : {}),
        ...(entry ? { entry } : {}),
        ...(ctx ? { ctx } : {}),
      }),
    [run, lanes, checks, entry, allowRun, ctx, now],
  );
  const lifecycle = useRunLifecycle(run.slug, undefined, { queued: model.bay === 'queued' });
  const [inspecting, setInspecting] = useState(false);
  const region = useId();
  const firstLive = model.livePhases[0];
  const { view } = model;

  return (
    <article
      data-testid="board-card"
      data-strip=""
      data-slug={run.slug}
      data-bay={model.bay}
      data-variant={variant}
      data-paint={model.view.paint}
      {...(column ? { 'data-column': column } : {})}
      aria-label={`${run.slug}: ${model.view.label}`}
      className={cn(
        `state-${view.paint}`,
        'flex min-w-0 flex-col rounded-lg border border-rule border-l-4 border-l-state bg-surface',
      )}
    >
      <div className="flex min-w-0 flex-col gap-1.5 px-3 py-2">
        {/* The word, whether it summons you, the name, the one clock. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <ViewBadge view={model.view} pulse={model.pulse} data-pulse={model.pulse ? 'observed' : 'still'} />
          <AttentionMark level={model.view.attention} />
          {row ? (
            <span
              data-testid="strip-name"
              className="min-w-(--strip-name-floor) flex-1 truncate font-mono text-sm text-ink"
            >
              {run.slug}
            </span>
          ) : (
            <Peek label={`${run.slug} at a glance`} content={<StripPeek model={model} run={run} />}>
              <a
                href={planHref(run.slug, 'run')}
                data-testid="strip-name"
                title={`Open ${run.slug}'s run page`}
                className="min-w-(--strip-name-floor) flex-1 truncate font-mono text-sm text-ink hover:underline"
              >
                {run.slug}
              </a>
            </Peek>
          )}
          {model.held && (
            <Badge
              tone="accent"
              dot
              data-testid="hold-chip"
              title={`Held${run.hold?.by ? ` by ${run.hold.by}` : ''} — nothing new is admitted`}
            >
              <Hand size={11} aria-hidden /> held
            </Badge>
          )}
          {model.frozen && (
            <Badge tone="accent" data-testid="frozen-chip">
              <Snowflake size={11} aria-hidden /> frozen
            </Badge>
          )}
          <span
            data-testid="strip-clock"
            className="ml-auto shrink-0 text-2xs text-ink-muted tabular-nums"
            title={model.clock.label ? `The phase's ${model.clock.label} clock` : undefined}
          >
            {clockWords(model.clock)}
            {row && total ? (
              <span
                data-testid="strip-phase-total"
                title={total.label ? `The phase's ${total.label} clock, over every attempt` : undefined}
              >
                {' '}
                · phase total {clockWords(total)}
              </span>
            ) : null}
          </span>
        </div>

        {/* The track, how far, what it cost — then the ONE action and the way in. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          {/* The bar alone on the glance — its key (the tally) is one press in. */}
          {model.track.length > 0 && (
            <RunStrip phases={model.track} tally={false} className="min-w-24 flex-1" />
          )}
          <span
            className="shrink-0 font-mono text-2xs text-ink-muted tabular-nums"
            data-testid="strip-done"
            title={`${model.done} of ${model.total} phase${model.total === 1 ? '' : 's'} done`}
          >
            {model.done}/{model.total}
          </span>
          <span
            className={cn(
              'shrink-0 font-mono text-2xs tabular-nums',
              model.cost.over ? 'text-failed' : 'text-ink-muted',
            )}
            data-testid="strip-cost"
            title={costTitle(model)}
          >
            {money(model.cost.spentUsd)}
            {model.cost.budgetUsd != null ? `/${money(model.cost.budgetUsd)}` : ''}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 max-sm:ml-0 max-sm:basis-full">
            {!(
              row &&
              (model.action.kind === 'open' || (model.action.kind === 'recovery' && model.action.needsMore))
            ) && (
              <StripActionButton action={model.action} lifecycle={lifecycle} onExpand={() => setOpen(true)} />
            )}
            {!row && (
              <button
                type="button"
                data-testid="strip-expand"
                aria-expanded={open}
                aria-controls={open ? region : undefined}
                aria-label={open ? `Fold ${run.slug}` : `Everything about ${run.slug}`}
                onClick={() => setOpen(!open)}
                className="inline-flex size-7 items-center justify-center rounded text-ink-muted hover:bg-surface-raised hover:text-ink [@media(hover:none)]:size-(--tap-min)"
              >
                <ChevronDown
                  size={14}
                  aria-hidden
                  className={cn('transition-transform duration-fast ease-transit', open && 'rotate-180')}
                />
              </button>
            )}
          </span>
        </div>

        {/* What holds it up, when something does — a hold, a fence, a folded
            errand, the queue. "Waiting" alone made you open it to learn why. */}
        {model.waits.length > 0 && (
          <ul data-testid="strip-waits" className="flex min-w-0 flex-col gap-0.5 text-2xs text-ink-muted">
            {model.waits.map((line) => (
              <li
                key={line.key}
                data-testid="strip-wait"
                data-wait={line.kind}
                className="min-w-0 break-words"
              >
                {line.text}
              </li>
            ))}
          </ul>
        )}

        {/* An operator's word on where this run's phases board (control-tower
            phase 99, #135) — a bump, a hold, a deferral, a withdrawal — read
            off the records, with who said it and why. */}
        <QueueMarkLines run={run} />

        {/* Why it is not moving (control-tower phase 102, #163): what the
            supervisor saw, else a live phase's slowness, else what it is doing
            and when it should end — the same report the Now panel draws. */}
        <WhyLine
          slug={run.slug}
          phase={firstLive}
        />

        {/* The last thing a live lane did — and the way to its Now panel, in place. */}
        {firstLive != null && row && (
          <div data-testid="strip-activity" className="flex min-w-0">
            <LastActivity slug={run.slug} phase={firstLive} className="basis-auto" />
          </div>
        )}
        {firstLive != null && !row && (
          <button
            type="button"
            data-testid="strip-activity"
            onClick={() => setOpen(true)}
            aria-controls={open ? region : undefined}
            title="What it did last, from the session's own log — press for its Now panel"
            className="flex min-w-0 text-left hover:underline"
          >
            <LastActivity slug={run.slug} phase={firstLive} className="basis-auto" />
          </button>
        )}
      </div>

      {open && !row && (
        <div className="expand-region">
          <div id={region} className="border-t border-rule">
            <StripDetail
              model={model}
              run={run}
              lanes={lanes}
              {...(checks ? { checks } : {})}
              {...(entry ? { entry } : {})}
              allowRun={allowRun}
              lifecycle={lifecycle}
              now={now}
              onInspect={() => setInspecting(true)}
            />
          </div>
        </div>
      )}

      {!row && (
        <Inspector
          open={inspecting}
          onOpenChange={setInspecting}
          title={run.slug}
          description={`Run ${run.id} — ${model.total} phase${model.total === 1 ? '' : 's'} on record.`}
          meta={
            <>
              <ViewBadge view={model.view} />
              <MonoId id={run.id} />
              {run.model && (
                <Badge tone="neutral" mono>
                  {run.model}
                </Badge>
              )}
            </>
          }
          raw={<pre className="font-mono text-2xs whitespace-pre-wrap">{JSON.stringify(run, null, 2)}</pre>}
        >
          <InspectorSection heading="Where it works">
            <KeyValue
              items={[
                ['Root', run.root],
                [
                  'Checkout',
                  run.checkout === 'worktree'
                    ? (run.workRoot ?? 'a console-managed checkout')
                    : run.checkout === 'refused'
                      ? `shared — ${run.isolationRefusal ?? 'isolation was refused'}`
                      : 'the shared root',
                ],
                Boolean(run.gitMode) && (['Git mode', String(run.gitMode)] as const),
                Boolean(run.startAfter) && (['Chained after', String(run.startAfter)] as const),
              ]}
            />
          </InspectorSection>
          <InspectorSection heading="What it is spending">
            <KeyValue
              items={[
                ['Spent', money(run.spentUsd ?? 0)],
                model.cost.liveUsd > 0 &&
                  (['In flight', `${money(model.cost.liveUsd)} not yet booked`] as const),
                Boolean(run.creditUsd) &&
                  (['On credit', `${money(run.creditUsd ?? 0)} of it past plan limits`] as const),
                ['Phase budget', run.phaseBudgetUsd == null ? 'no ceiling' : money(run.phaseBudgetUsd)],
                ['Run budget', run.runBudgetUsd == null ? 'no ceiling' : money(run.runBudgetUsd)],
                [
                  'Consecutive failures',
                  `${run.consecutiveFailures ?? 0} of ${run.maxConsecutiveFailures ?? '—'}`,
                ],
              ]}
            />
          </InspectorSection>
        </Inspector>
      )}
    </article>
  );
}

/** One line per phase an operator moved, held, deferred or withdrew — the run card's half of the queue's marks. */
function QueueMarkLines({ run }: { run: RunState }) {
  const lines = Object.values(run.phases ?? {})
    .filter((record) => record && record.status !== 'done' && record.status !== 'skipped')
    .flatMap((record) => queueMarks(record!.queueControl).map((mark) => ({ phase: record!.phase, mark })))
    .sort((a, b) => a.phase - b.phase);
  if (!lines.length) return null;
  return (
    <ul data-testid="strip-queue-marks" className="flex min-w-0 flex-col gap-0.5 text-2xs text-ink-muted">
      {lines.map(({ phase, mark }) => (
        <li key={`${phase}:${mark.key}`} className="min-w-0 break-words" data-mark={mark.key}>
          P{phase} {mark.text}
        </li>
      ))}
    </ul>
  );
}

function costTitle(model: StripModel): string {
  const { spentUsd, liveUsd, budgetUsd } = model.cost;
  const of = budgetUsd != null ? ` of a ${money(budgetUsd)} run budget` : ', no run budget set';
  const flight =
    liveUsd > 0 ? ` — ${money(liveUsd)} of it in the session in flight, booked when it ends` : '';
  return `${money(spentUsd)} spent${of}${flight}`;
}

/**
 * The ONE action. `data-testid="strip-action"` names it for a test and for a
 * phone's `elementFromPoint`; `data-action` says which verb it is.
 *
 * A recovery verb that needs more than a press — words, or a dialog — opens
 * the strip instead, where the halt card asks for them; every other verb acts
 * at once through its one door.
 */
export function StripActionButton({
  action,
  lifecycle,
  onExpand,
}: {
  action: StripAction;
  lifecycle: RunLifecycle;
  onExpand: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // On a phone the one action is the width of the strip, at its foot — the
  // thumb's zone (control-tower phase 20; §Architecture 5's phone wireframe).
  const thumb =
    'h-auto min-h-7 py-1 whitespace-normal max-sm:flex-1 max-sm:justify-center [@media(hover:none)]:min-h-(--tap-min)';
  if (action.kind === 'step') {
    return (
      <Suspense
        fallback={
          <Button size="sm" variant="action" disabled data-testid="strip-action">
            {action.label}
          </Button>
        }
      >
        <StepCard item={action.item} variant="primary" testId="strip-action" />
      </Suspense>
    );
  }
  if (action.kind === 'open') {
    return (
      <Button size="sm" variant="action" className={thumb} asChild>
        <a href={action.href} data-testid="strip-action" data-action="open" title={action.title}>
          <ExternalLink size={13} aria-hidden /> {action.label}
        </a>
      </Button>
    );
  }
  if (action.kind === 'lifecycle') {
    return (
      <Button
        size="sm"
        variant="action"
        className={thumb}
        data-testid="strip-action"
        data-action={action.verb}
        title={action.title}
        disabled={lifecycle.busy != null}
        onClick={() => void lifecycle[action.verb]()}
      >
        {lifecycle.busy === action.verb ? 'Working…' : action.label}
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant="action"
      className={thumb}
      data-testid="strip-action"
      data-action={action.id}
      data-recommended={action.id}
      title={action.title}
      disabled={Boolean(action.disabledReason) || busy}
      onClick={() => {
        if (action.needsMore) return onExpand();
        setBusy(true);
        void runRecoverVerb(action.id as RunRecoverVerb, action.target).finally(() => setBusy(false));
      }}
    >
      {busy ? 'Working…' : action.label}
    </Button>
  );
}

/** What the name's peek shows: the facts a person weighs before opening anything. */
function StripPeek({ model, run }: { model: StripModel; run: RunState }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <ViewBadge view={model.view} />
        <MonoId id={run.id} />
      </div>
      <KeyValue
        items={[
          ['Now', clockWords(model.clock)],
          ['Phases', `${model.done} of ${model.total} done`],
          ['Spent', costTitle(model)],
          Boolean(run.model) && (['Model', `${run.model}${run.effort ? ` at ${run.effort}` : ''}`] as const),
          ['Failures in a row', `${run.consecutiveFailures ?? 0} of ${run.maxConsecutiveFailures ?? '—'}`],
        ]}
      />
    </div>
  );
}
