/**
 * A run as ONE LINE (7.0, quiet-console phase 7; the strip since control-tower
 * phase 19, §Architecture 2) — the one place the home spends its boldness.
 *
 * ```
 * ▌● Running   storefront   ○ 6 done ─ ● P7 running ─ ○ 28 left   running 12m 03s  2/35  $4.20/$25   [ Pause ] ⌄
 *  └ what holds it up · the queue's marks · why it is not moving
 *  └ expanded in place: the halt card · lanes · Now · clocks · the full track · every verb · Inspect · Open run
 * ```
 *
 * Glance first: the edge is the run's paint, the mark its precise word
 * (`describeRun`, through the status family — never a colour alone), then the
 * name, the track folded to labelled stations, ONE labelled clock, the cost
 * and exactly ONE action (`model.ts` says which, the halt view first — #278).
 * Everything the 6.2 card showed is one press away, in place
 * (`run-detail.tsx`), and the raw record two (the panel's Inspector).
 *
 * The row is fed the SLIM run the page folded (#234): the word, the track,
 * the clock and the in-flight spend move with the list, and nothing is
 * fetched to draw the glance. On a phone the line stacks — the mark, the name
 * and the fold on one row, the track under them, the clock, then the one
 * action the width of the row at the foot: the thumb's zone.
 */

import { useCallback, useId, useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ConsoleState, PhaseReport, RunState } from '@/data/api';
import { isSlimRun } from '@/data/lanes';
import { useLifecycle } from '@/data/lifecycle';
import { queueMarks } from '@/data/queue-words';
import type { PlacedRun } from '@/data/run-groups';
import { usePhaseReport } from '@/data/runs';
import { useAccounts } from '@/data/accounts';
import { accountLine } from '@/lib/account-line';
import { useNow } from '@/lib/clock';
import { cn } from '@/lib/cn';
import { clockWords, money } from '@/lib/format';
import { usePrefs } from '@/lib/prefs';
import { Button, Money } from '@/ui';
import { DotWord } from '@/ui/status';
import { Station } from '@/ui/track/station';
import { Track } from '@/ui/track/track';
import { useInspected } from '@/shell/panel/inspector-host';
import { runHref } from '@/shell/routes';
import { inspectRun } from './inspector';
import { rowModel, type RunRowModel, type TrackStation } from './model';
import { RowActionButton } from './row-action';
import { RunDetail } from './run-detail';

/** How many expanded rows a person's preferences remember — the newest win. */
const REMEMBERED = 40;

export interface RunRowProps {
  placed: PlacedRun;
  /** `--allow-run`: without it the one action is Open run and no verb is drawn. */
  allowRun: boolean;
  state: ConsoleState | undefined;
  /** The whole record, when the caller holds it — the detail then fetches nothing. */
  record?: RunState | undefined;
  /**
   * `header`: the row heads the run's own view (quiet-console phase 11) — the
   * same line, but the page below IS its expansion, so it neither folds nor
   * links to itself, its last cell is Inspect, and a live phase's report is
   * its lane's line below rather than the row's. `onAct` takes a verb that
   * needs words or a dialog to where the view asks for them.
   */
  variant?: 'row' | 'header';
  onInspect?: () => void;
  onAct?: () => void;
}

/**
 * Where each cell of the row sits, by variant — literal classes, so the
 * stylesheet's scanner finds them. On the home the row has three widths: a
 * phone stacks (mark · name · fold, then the track, the clock, the action in
 * the thumb's zone); a tablet keeps one line of facts and gives the track a
 * line of its own, so no station is squeezed to its dot; a desk draws the six
 * cells on one line. The desk line is chosen by the room the LIST has (its
 * `@container/strips`, `Rows` in `groups.tsx`), never by the viewport: with the
 * panel open beside the page at 1280 the column is a tablet's 790 px, and a
 * viewport rule drew the desk line there and squeezed "2 done" onto two lines
 * (#342). As the Run view's head it keeps the tablet's two lines at every width
 * from `sm` up, for the same reason.
 */
const CELLS = {
  row: {
    grid: 'sm:grid-cols-[auto_minmax(var(--strip-name-floor),1fr)_auto_auto_auto] @min-[56rem]/strips:grid-cols-[auto_minmax(var(--strip-name-floor),16rem)_minmax(var(--strip-track-floor),1fr)_auto_auto_auto]',
    mark: '@max-[56rem]/strips:order-1',
    name: '@max-[56rem]/strips:order-2',
    track: '@max-[56rem]/strips:col-span-full max-sm:order-4 sm:@max-[56rem]/strips:order-6',
    facts: 'max-sm:order-5 max-sm:col-span-full sm:@max-[56rem]/strips:order-3',
    action: 'max-sm:order-6 max-sm:col-span-full sm:@max-[56rem]/strips:order-4',
    last: 'max-sm:order-3 sm:@max-[56rem]/strips:order-5',
    waits: '@max-[56rem]/strips:order-7',
    after: '@max-[56rem]/strips:order-8',
  },
  header: {
    grid: 'sm:grid-cols-[auto_minmax(var(--strip-name-floor),1fr)_auto_auto_auto]',
    mark: 'order-1',
    name: 'order-2',
    track: 'col-span-full max-sm:order-4 sm:order-6',
    facts: 'max-sm:order-5 max-sm:col-span-full sm:order-3',
    action: 'max-sm:order-6 max-sm:col-span-full sm:order-4',
    last: 'max-sm:order-3 sm:order-5',
    waits: 'order-7',
    after: 'order-8',
  },
} as const;

export function RunRow({ placed, allowRun, state, record, variant = 'row', onInspect, onAct }: RunRowProps) {
  const { run, lanes } = placed;
  const [prefs, setPrefs] = usePrefs();
  const accounts = useAccounts();
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
  // The clock ticks here — each second while a lane is live, each half-minute otherwise.
  const now = useNow(true, anyLive ? 1000 : 30_000);
  const model = useMemo(() => rowModel({ placed, now, allowRun }), [placed, now, allowRun]);
  const lifecycle = useLifecycle(run.slug, undefined, { queued: placed.bay === 'queued' });
  const inspected = useInspected()?.key === run.id;
  const region = useId();
  const firstLive = model.livePhases[0];
  const { view } = model;
  const whole = record ?? (isSlimRun(run) ? undefined : run);
  const header = variant === 'header';
  const at = CELLS[variant];

  return (
    <article
      data-strip=""
      data-variant={variant}
      data-slug={run.slug}
      data-bay={placed.bay}
      data-group={placed.group}
      data-paint={view.paint}
      data-pulse={model.pulse ? 'observed' : 'still'}
      {...(inspected ? { 'data-inspected': '' } : {})}
      aria-label={`${run.slug}: ${view.label}`}
      className={cn(
        `state-${view.paint}`,
        'grid min-w-0 items-center gap-x-3 gap-y-1.5 border-s-2 border-state py-2 ps-3',
        // The widths, by variant: `CELLS`.
        'grid-cols-[auto_minmax(0,1fr)_auto]',
        at.grid,
        inspected && 'bg-surface-raised',
      )}
    >
      {/* The mark: the word, whether it summons you, observed live or not. */}
      <DotWord view={view} live={model.pulse} withNote={false} className={at.mark} />

      {header ? (
        <span
          data-testid="strip-name"
          className={cn('min-w-(--strip-name-floor) truncate text-body text-ink', at.name)}
        >
          {run.slug}
        </span>
      ) : (
        <a
          href={runHref(run.slug)}
          data-testid="strip-name"
          title={`Open ${run.slug}'s run page`}
          className={cn('min-w-(--strip-name-floor) truncate text-body text-ink hover:underline', at.name)}
        >
          {run.slug}
        </a>
      )}

      {/* The track, folded to labelled stations — the glance's one graphic. */}
      <div className={cn('min-w-0', at.track)}>
        {model.track.length > 0 && <GlanceTrack stations={model.track} />}
      </div>

      {/* The one clock, how far, what it cost. */}
      <span
        className={cn('flex min-w-0 flex-wrap items-baseline gap-x-3 text-meta text-ink-muted', at.facts)}
      >
        <span
          data-testid="strip-clock"
          className="tnum"
          title={model.clock.label ? `The phase's ${model.clock.label} clock` : undefined}
        >
          {clockWords(model.clock)}
        </span>
        <span
          data-testid="strip-done"
          className="tnum"
          title={`${model.done} of ${model.total} phase${model.total === 1 ? '' : 's'} done`}
        >
          {model.done}/{model.total}
        </span>
        <Money
          usd={model.cost.spentUsd}
          against={model.cost.budgetUsd}
          data-testid="strip-cost"
          title={costTitle(model)}
        />
        <span
          data-testid="strip-account"
          className="min-w-0 break-words"
          title="Who pays: account · provider · model"
        >
          {accountLine(run.accountId ?? null, accounts.data?.accounts, run.model)}
        </span>
      </span>

      {/* The ONE action — and on a phone, the thumb's zone at the foot. */}
      <span className={cn('flex min-w-0 shrink-0 items-center', at.action)}>
        <RowActionButton
          action={model.action}
          lifecycle={lifecycle}
          onExpand={() => (header ? onAct?.() : setOpen(true))}
        />
      </span>

      {header ? (
        <Button
          size="sm"
          variant="ghost"
          data-testid="strip-inspect"
          onClick={onInspect}
          title="Everything this console knows about this run, in the panel"
          className={at.last}
        >
          Inspect
        </Button>
      ) : (
        <Button
          size="icon"
          variant="ghost"
          data-testid="strip-expand"
          aria-expanded={open}
          aria-controls={open ? region : undefined}
          aria-label={open ? `Fold ${run.slug}` : `Everything about ${run.slug}`}
          onClick={() => setOpen(!open)}
          className={at.last}
        >
          <ChevronDown
            size={14}
            aria-hidden
            className={cn('transition-transform duration-fast ease-transit', open && 'rotate-180')}
          />
        </Button>
      )}

      {/* What holds it up, when something does — a hold, a fence, a folded
          errand, the queue. "Waiting" alone made you open it to learn why. */}
      {model.waits.length > 0 && (
        <ul
          data-testid="strip-waits"
          className={cn('col-span-full flex min-w-0 flex-col gap-0.5 text-meta text-ink-muted', at.waits)}
        >
          {model.waits.map((line) => (
            <li key={line.key} data-testid="strip-wait" data-wait={line.kind} className="min-w-0 break-words">
              {line.text}
            </li>
          ))}
        </ul>
      )}

      {/* An operator's word on where this run's phases board (control-tower
          phase 99, #135) — read off the whole record, when the row holds it. */}
      {whole && <QueueMarkLines run={whole} at={at.after} />}

      {/* Why it is not moving (control-tower phase 102, #163): what the
          supervisor saw, else a live phase's slowness, else what it is doing
          and when it should end — the same report the Now panel draws. As the
          Run view's head, the phase's report is its lane's line below, so the
          head keeps only what is about the whole run. */}
      <WhyLine
        slug={run.slug}
        phase={header ? undefined : firstLive}
        at={at.after}
      />

      {open && !header && (
        <div className="expand-region col-span-full max-lg:order-9">
          <div id={region} className="border-t border-rule">
            <RunDetail
              placed={placed}
              model={model}
              record={whole}
              allowRun={allowRun}
              lifecycle={lifecycle}
              now={now}
              onInspect={(held) => inspectRun({ placed, record: held, state })}
            />
          </div>
        </div>
      )}
    </article>
  );
}

/** The glance's track: a station per fold, each with its word. */
/**
 * The folded track. A station's words never break ("2" over "done", #342):
 * each label keeps one line and each station is at least as wide as its dot,
 * its words and the shortest leg, so where room runs out the legs shorten
 * first, and below that the row gives the track a line of its own.
 */
function GlanceTrack({ stations }: { stations: readonly TrackStation[] }) {
  return (
    <Track
      label="Phases"
      data-glance=""
      className="min-w-0 [&>.ui-station]:min-w-max [&_.ui-station-label]:whitespace-nowrap"
    >
      {stations.map((station) => (
        <Station
          key={station.key}
          paint={station.paint}
          settled={station.settled}
          live={station.live}
          data-phase={station.phase}
          data-count={station.count}
        >
          {station.label}
        </Station>
      ))}
    </Track>
  );
}

/** One line per phase an operator moved, held, deferred or withdrew — the run row's half of the queue's marks. */
function QueueMarkLines({ run, at }: { run: RunState; at: string }) {
  const lines = Object.values(run.phases ?? {})
    .filter((record) => record && record.status !== 'done' && record.status !== 'skipped')
    .flatMap((record) => queueMarks(record!.queueControl).map((mark) => ({ phase: record!.phase, mark })))
    .sort((a, b) => a.phase - b.phase);
  if (!lines.length) return null;
  return (
    <ul
      data-testid="strip-queue-marks"
      className={cn('col-span-full flex min-w-0 flex-col gap-0.5 text-meta text-ink-muted', at)}
    >
      {lines.map(({ phase, mark }) => (
        <li key={`${phase}:${mark.key}`} className="min-w-0 break-words" data-mark={mark.key}>
          P{phase} {mark.text}
        </li>
      ))}
    </ul>
  );
}

function costTitle(model: RunRowModel): string {
  const { spentUsd, liveUsd, budgetUsd } = model.cost;
  const of = budgetUsd != null ? ` of a ${money(budgetUsd)} run budget` : ', no run budget set';
  const flight =
    liveUsd > 0 ? ` — ${money(liveUsd)} of it in the session in flight, booked when it ends` : '';
  return `${money(spentUsd)} spent${of}${flight}`;
}

/* ------------------------------------------------------------------ *
 * Why it is not moving (control-tower phase 102, #145 E and #163)
 * ------------------------------------------------------------------ */

/** A sentence someone else composed — the supervisor's, in the Pro tree. */
export interface WhyNote {
  text: string;
  /** Its first piece of evidence, as the line's title. */
  title?: string | undefined;
}

/** The report's line: why it is slow when it is, else what it is doing and when it should end. */
export function reportWhy(report: PhaseReport): { kind: 'slow' | 'doing'; text: string } | null {
  if (!report.live) return null;
  const [slow, ...more] = report.whySlow;
  if (slow) {
    const others = more.length ? ` (and ${more.length} more)` : '';
    return { kind: 'slow', text: `Slow: ${slow.text}${others}.` };
  }
  const task = report.doing.task;
  const op = report.doing.operation;
  const parts = [task ? `On ${task.text}` : `Phase ${report.phase} is ${report.status}`];
  if (op) parts.push(`${op.label} ${op.done}/${op.of}`);
  const eta = report.eta.minutes;
  const when = eta ? ` — about ${eta.low}–${eta.high} min left` : '';
  return { kind: 'doing', text: `${parts.join(', ')}${when}.` };
}

const WHY_LINE = 'col-span-full min-w-0 break-words text-meta text-ink-muted';

function WhyLine({
  slug,
  phase,
  at,
  detection,
}: {
  slug: string;
  /** The first live phase, when one is live — the report's subject. */
  phase: number | undefined;
  /** Where the line sits in the row (`CELLS`). */
  at: string;
  detection?: WhyNote | null | undefined;
}) {
  if (detection) {
    return (
      <p data-testid="strip-why" data-why="detection" className={cn(WHY_LINE, at)} title={detection.title}>
        {detection.text}
      </p>
    );
  }
  if (phase == null) return null;
  return <ReportWhy slug={slug} phase={phase} at={at} />;
}

function ReportWhy({ slug, phase, at }: { slug: string; phase: number; at: string }) {
  const { data } = usePhaseReport(slug, phase);
  const line = data ? reportWhy(data) : null;
  if (!line) return null;
  return (
    <p data-testid="strip-why" data-why={line.kind} className={cn(WHY_LINE, at)} title={data?.summary}>
      {line.text}
    </p>
  );
}
