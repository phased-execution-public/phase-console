/**
 * How each phase's own clock was split (7.0, quiet-console phase 12; the 6.x
 * timeline card).
 *
 * ```
 * How each phase's clock was split
 *        0s          5m          10m
 * P1     ████████████▬▬▬▬▬▬░░░░
 * P2     ███████
 * P3     ▨▨▨▨▨▨▨▨▨▨▨▨▨▨
 * phase 1: 5m working, 3m waiting, 2m frozen, 10m in all     [Reset zoom (×4.0)]
 * ▬ Working ▬ Waiting ▬ Frozen ▨ Still open
 * › The phase clocks (3)
 * ```
 *
 * A run's cost answers "what did this spend". It does not answer what people
 * ask of a run that took four hours — *where did the four hours go* — because
 * a phase's duration is one number covering three different things: working
 * (the session alive and spending), frozen (alive and deliberately stopped, a
 * SIGSTOP that costs nothing and still burns the clock) and waiting (parked on
 * something outside the phase: a waiting-external park, a foreign lock, an MCP
 * wall). Three parts, so the shape of a bar is the diagnosis: a run that was
 * mostly waiting was not slow, it was blocked — a different fix.
 *
 * Every figure comes off the record. `frozenMs` and `durationMs` are the
 * runner's; the waiting part is what the park clocks account for, CLAMPED to
 * the duration rather than trusted — a park that outlived its phase (a console
 * restart across a park, most often) would otherwise paint a bar wider than
 * the phase. Where the two disagree the duration wins: it is the one measured
 * end to end.
 *
 * Every bar starts at the same edge, on ONE scale shared by every row and set
 * by the longest phase: the useful comparison is phase against phase, and a
 * total-scaled bar turns every phase of a long run into a hairline. The scale
 * is the figures' own — the swimlane places each part with `linear` and labels
 * the axis with `durationTicks` — so this picture and the Gantt above it can
 * never read one duration two ways, and a zoom on the duration axis reads the
 * short phases at a scale of their own.
 */

import { useId, useMemo, type ReactNode } from 'react';
import type { BarKind, PhaseRecord } from '@/data/api';
import { useNow } from '@/lib/clock';
import { cn } from '@/lib/cn';
import { duration, plural } from '@/lib/format';
import { Button, Empty, SectionHeading } from '@/ui';
import { FigureNumbers } from '@/ui/figures/numbers';
import { linear } from '@/ui/figures/scales';
import { AXIS, ROW, Swimlane, type SwimlaneRow } from '@/ui/figures/swimlane';
import { useFigure } from '@/ui/figures/use-figure';
import { BAR_STYLE, BarKindKey } from './gantt';

/** One phase's wall clock, split into the three things it can be spent on. */
export interface ClockSpan {
  phase: number;
  /** Total wall clock for the phase, ms. */
  totalMs: number;
  workingMs: number;
  frozenMs: number;
  waitingMs: number;
  /** Still open — the bar is drawn hatched rather than solid. */
  live: boolean;
}

/** How long a record was parked, from the clocks the runner writes. */
function waitingOf(record: PhaseRecord, now: number): number {
  // A park that has not elapsed yet is still being served: count from its
  // start. `parkedUntil` is in the FUTURE while parked, which is why it cannot
  // simply be subtracted from anything.
  if (!record.parkedUntil) return 0;
  const until = Date.parse(record.parkedUntil);
  if (!Number.isFinite(until)) return 0;
  const started = record.startedAt ? Date.parse(record.startedAt) : Number.NaN;
  if (!Number.isFinite(started)) return 0;
  // The park's own window, bounded by now: a park still running has served
  // only up to this moment, and one that elapsed served all of it.
  return Math.max(0, Math.min(until, now) - started);
}

/** The records as spans — the whole of the arithmetic, worth testing without drawing anything. */
export function spansOf(records: readonly PhaseRecord[], now: number): ClockSpan[] {
  return records
    .map((record) => {
      const started = record.startedAt ? Date.parse(record.startedAt) : Number.NaN;
      const ended = record.endedAt ? Date.parse(record.endedAt) : Number.NaN;
      const live = Number.isFinite(started) && !Number.isFinite(ended);
      // The runner's own figure first; the clock for a phase still open, which
      // has no `durationMs` yet by definition.
      const totalMs = Number.isFinite(record.durationMs as number)
        ? Math.max(0, record.durationMs as number)
        : Number.isFinite(started)
          ? Math.max(0, (Number.isFinite(ended) ? ended : now) - started)
          : 0;
      const frozenMs = Math.min(totalMs, Math.max(0, record.frozenMs ?? 0));
      const waitingMs = Math.min(totalMs - frozenMs, waitingOf(record, now));
      return {
        phase: record.phase,
        totalMs,
        frozenMs,
        waitingMs,
        // The remainder, never a fourth measured figure: the three parts sum to
        // the duration, or the bar would lie about its own width.
        workingMs: Math.max(0, totalMs - frozenMs - waitingMs),
        live,
      };
    })
    .filter((span) => span.totalMs > 0)
    .sort((a, b) => a.phase - b.phase);
}

/** The three parts of a phase's clock, in drawing order — each painted as the bar kind it is. */
const PARTS: readonly { key: 'workingMs' | 'waitingMs' | 'frozenMs'; kind: BarKind }[] = [
  { key: 'workingMs', kind: 'working' },
  { key: 'waitingMs', kind: 'waiting' },
  { key: 'frozenMs', kind: 'frozen' },
];

const PART_KINDS = PARTS.map((part) => part.kind);

/** One phase's clock in words — its row's accessible name and the crosshair's readout. */
function spanWords(span: ClockSpan): string {
  const parts = PARTS.filter((part) => span[part.key] > 0).map(
    (part) => `${duration(span[part.key])} ${BAR_STYLE[part.kind].label}`,
  );
  return (
    `phase ${span.phase}: ${parts.join(', ')}` +
    `${parts.length > 1 ? `, ${duration(span.totalMs)} in all` : ''}` +
    `${span.live ? ', still open' : ''}`
  );
}

/** A part's figure in the numbers table — a part with no time in it is a quiet dash, not `0s`. */
const partCell = (ms: number): string => (ms > 0 ? duration(ms) : '—');

export function RunClockSplit({
  phases,
  now: fixed,
  emptyAction,
  className,
}: {
  phases: readonly PhaseRecord[];
  /** Injectable so a test can draw a live phase without a real clock. */
  now?: number;
  /** Where an empty split sends you — the page knows the plan, this does not. */
  emptyAction?: ReactNode;
  className?: string;
}) {
  const heading = useId();
  // A phase still open grows while it is read; a settled run never moves.
  const open = phases.some((record) => Boolean(record.startedAt) && !record.endedAt);
  const ticking = useNow(fixed === undefined && open, 5_000);
  const now = fixed ?? ticking;
  const spans = useMemo(() => spansOf(phases, now), [phases, now]);
  const longest = spans.reduce((max, span) => Math.max(max, span.totalMs), 0);

  const figure = useFigure({
    label: 'Phase clocks',
    count: spans.length,
    bounds: [0, Math.max(longest, 1)],
    // Zooming the duration axis is what a split is read closer for: the short
    // phases, a few pixels each at the scale of the longest.
    minSpan: Math.max(1, longest / 32),
    describe: (i) => (spans[i] ? spanWords(spans[i]) : ''),
    // Rows down the page, so up and down walk them, and so do left and right.
    keySteps: { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -1, ArrowRight: 1 },
    initialStop: 0,
    locate: (clientX, clientY, view, surface) => {
      const rect = surface?.querySelector('svg')?.getBoundingClientRect();
      if (!rect || !(rect.width > 0)) return null;
      const at = linear(view, [rect.left, rect.right]).invert(clientX);
      const index = Math.floor((clientY - rect.top - AXIS) / ROW);
      return { at, stop: index >= 0 && index < spans.length ? index : null };
    },
  });

  const rows: SwimlaneRow[] = spans.map((span, index) => {
    // The parts laid end to end from the phase's own start: a split, not a
    // timeline — WHEN each part happened is the Gantt's question.
    let at = 0;
    const bars = PARTS.flatMap((part) => {
      const ms = span[part.key];
      if (!(ms > 0)) return [];
      const startMs = at;
      at += ms;
      return [
        {
          key: part.kind,
          startMs,
          endMs: at,
          state: BAR_STYLE[part.kind].state,
          open: span.live,
          title: `P${span.phase}: ${duration(ms)} ${BAR_STYLE[part.kind].label}${span.live ? ' so far' : ''}`,
        },
      ];
    });
    return {
      key: String(span.phase),
      label: <span className="px-1 text-meta text-ink-muted tnum">P{span.phase}</span>,
      ariaLabel: spanWords(span),
      bars,
      emphasis: figure.cursor === index,
    };
  });

  return (
    <section
      data-testid="run-clock-split"
      aria-labelledby={heading}
      className={cn('flex min-w-0 flex-col gap-2', className)}
    >
      <SectionHeading
        as="h3"
        id={heading}
        title="Wall clock per phase, split into working, waiting on something outside the phase, and frozen — every bar on the longest phase's scale. Hatched means still open."
      >
        How each phase’s clock was split
      </SectionHeading>
      {!spans.length ? (
        <Empty
          data-testid="clock-split-empty"
          title="Nothing has taken any time yet: a phase appears here once it starts."
          action={emptyAction}
        />
      ) : (
        <>
          <Swimlane
            rows={rows}
            spanMs={longest}
            view={figure.view}
            figure={figure}
            hatchId="pe-clock-split-open"
            tickLabel={duration}
            ariaLabel={`Each phase's clock on one scale, the longest ${duration(longest)}, ${plural(spans.length, 'phase')}`}
          />

          {/* What the crosshair is on, or the scale the bars share — the
              slider's value text says the same words to a screen reader. */}
          <div className="flex min-h-6 min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-meta text-ink-muted">
            <span aria-hidden data-readout className="min-w-0 break-words tnum">
              {figure.cursor !== null
                ? figure.sliderProps['aria-valuetext']
                : `Scaled to the longest phase, ${duration(longest)}`}
            </span>
            {figure.zoomed ? (
              <Button variant="ghost" size="sm" className="tnum" onClick={figure.reset}>
                Reset zoom (×{figure.zoom.toFixed(1)})
              </Button>
            ) : null}
          </div>

          <BarKindKey kinds={PART_KINDS} open={spans.some((span) => span.live)} />

          <FigureNumbers
            label="phase clocks"
            caption="Each phase's wall clock, split into working, waiting and frozen: the numbers behind the bars"
            rows={spans}
            getRowKey={(span) => String(span.phase)}
            columns={[
              { head: 'Phase', cell: (span) => `P${span.phase}${span.live ? ', still open' : ''}` },
              { head: 'Working', cell: (span) => partCell(span.workingMs), align: 'end' },
              { head: 'Waiting', cell: (span) => partCell(span.waitingMs), align: 'end' },
              { head: 'Frozen', cell: (span) => partCell(span.frozenMs), align: 'end' },
              { head: 'In all', cell: (span) => duration(span.totalMs), align: 'end' },
            ]}
          />
        </>
      )}
    </section>
  );
}
