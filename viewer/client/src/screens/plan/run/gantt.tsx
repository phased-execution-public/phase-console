/**
 * When each phase held the lane — the run on one time axis (7.0, quiet-console
 * phase 12; the 6.x run timeline card).
 *
 * ```
 * When each phase held the lane
 * From 14:02 · Journal truncated
 *        0s          15m          30m          45m
 * P1 ◆   ██████████▨▨▨
 * P2 ×2               ──────██████████
 * Cost   ▂▂▂▂          ▅▅▅▅▅▅
 * 21m in · P1 working, P2 run down (halted: plan-lint)     [Reset zoom (×2.0)]
 * ▬ Working ▬ Verifying ▬ Queued ▬ Waiting ─ Run down ▬ Frozen ▨ Still open ▢ Critical path
 * Critical path P1 → P2, 45m
 * › The attempt costs (3)   › The lanes (2)
 * ```
 *
 * One shared axis, one row per phase, bars bracketed by journal entries —
 * `server/analysis/timeline.ts` does the projection and nothing is modelled
 * here. The clock split beside it (`./timeline`) starts every bar at the same
 * edge, which is what makes it the wrong picture for this question: WHEN did
 * each phase hold the lane, what was waiting meanwhile, and which chain of
 * phases made the run as long as it was.
 *
 * Three claims the chart would otherwise make silently are said outright:
 *
 *   - **an open bar is hatched.** "Worked for 40 minutes" and "has been
 *     working for 40 minutes so far" are different statements.
 *   - **a truncated journal says so**, with why on hover. The projection reads
 *     a tail; a lane whose opening it cut starts mid-flight, and a confident
 *     wrong picture is the failure mode here.
 *   - **the critical path is named in text**, not only outlined — the outline
 *     is a highlight, the line under the key is what someone can act on.
 *
 * The drawing is `ui/figures/swimlane` on the figures' axis and crosshair, with
 * each attempt's cost on the same window underneath; this file says a row is a
 * PHASE, a bar is a boarding, and a lane with two attempts behind it opens
 * their comparison. Every figure owes its numbers, so the costs and the lanes
 * each fold their table under the key.
 */

import { useEffect, useId, useMemo, type ReactNode } from 'react';
import type {
  BarKind,
  RunState,
  RunTimeline,
  TimelineLane,
  TimelineMark,
  TimelineSeriesPoint,
} from '@/data/api';
import { cn } from '@/lib/cn';
import { clockTime, duration, money, plural } from '@/lib/format';
import { useTouch } from '@/lib/media';
import { Button, Empty, SectionHeading } from '@/ui';
import { RunCostFigure } from '@/ui/figures/lazy';
import { FigureNumbers } from '@/ui/figures/numbers';
import { linear } from '@/ui/figures/scales';
import { ROW, Swimlane, type SwimlaneRow } from '@/ui/figures/swimlane';
import { useFigure } from '@/ui/figures/use-figure';
import { ZoomControls, zoomWindowOf } from '@/ui/figures/zoom-controls';

/**
 * What each bar kind means, and the one CLASS that decides its colour — never a
 * hue: a `.state-*` class sets `--state`, and every dot, row and segment paints
 * through that one variable (`styles/theme.css`), so naming the class is naming
 * the state. The clock split and Logs ▸ Timeline paint the same kinds from here.
 *
 * `frozen` is deliberately NOT a status hue: nothing is wrong and nothing is
 * moving, so it sets the variable to the neutral ink. A run that was down
 * paints `skipped` — the neutral that keeps the status lightness — rather than
 * amber: amber is a summons, and a bar is history; its cause is in its title.
 */
export const BAR_STYLE: Record<BarKind, { label: string; state: string; rail?: true }> = {
  working: { label: 'working', state: 'state-running' },
  verifying: { label: 'verifying', state: 'state-verifying' },
  queued: { label: 'queued', state: 'state-queued' },
  waiting: { label: 'waiting', state: 'state-waiting' },
  // A rail, not a block: the lane was held and nothing ran on it — which is also
  // what tells it from `queued`, a neutral of the same lightness.
  down: { label: 'run down', state: 'state-skipped', rail: true },
  frozen: { label: 'frozen', state: '[--state:var(--ink-faint)]' },
};

/** The kinds in the table's own order — the key's, the sentence's and the readout's. */
const KINDS = Object.keys(BAR_STYLE) as BarKind[];

/** Sentence case for a word the vocabulary writes to run on inside a sentence. */
const upper = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1);

/** A bar in words: its kind, and why when the projection said (a down bar's cause). */
const barWords = (bar: { kind: BarKind; note?: string }): string =>
  `${BAR_STYLE[bar.kind].label}${bar.note ? ` (${bar.note})` : ''}`;

const MARK_GLYPH: Record<TimelineMark['kind'], string> = {
  board: '▏',
  verify: '◆',
  rung: '▲',
  park: '❚',
  wall: '✖',
  outcome: '●',
  session: '▾',
  ask: '?',
  policy: '§',
  start: '▶',
  note: '✎',
};

/** The cost strip's height, in px — the swimlane keeps its label level with it. */
const COST_HEIGHT = 40;

/** A row's pitch when its label is a button on touch: the thumb floor, `--tap-min`. */
const TAP_ROW = 44;

/** Where one lane's time went, kind by kind — only the kinds it has time in. */
function partsOf(lane: TimelineLane): string {
  return KINDS.flatMap((kind) => {
    const ms = lane[`${kind}Ms` as const];
    return ms > 0 ? [`${duration(ms)} ${BAR_STYLE[kind].label}`] : [];
  }).join(', ');
}

/** One lane's numbers as a sentence — its row's accessible name and the lanes table's reading. */
export function laneLabel(lane: TimelineLane): string {
  const parts = partsOf(lane);
  const attempts = `${lane.attempts} attempt${lane.attempts === 1 ? '' : 's'}`;
  return (
    `phase ${lane.phase}: ${attempts}${parts ? `, ${parts}` : ''}` +
    (lane.partial ? ' (journal truncated — this lane starts mid-flight)' : '')
  );
}

/**
 * Where "now" is on a live axis, in ms from its left edge — `undefined` for a
 * run that has ended, whose axis has an end rather than a present.
 *
 * The projection's own stamp (`asOf`) is the floor; `seenAt` — when the cached
 * run last moved, which a `run:progress` frame does by patching it — moves it
 * on. That is the whole of "the axis advances with no refetch": the frame is
 * already in the cache, and the picture reads the cache.
 */
export function liveNowMs(timeline: RunTimeline, seenAt?: number): number | undefined {
  if (timeline.endedAt !== null || !timeline.startedAt) return undefined;
  const t0 = Date.parse(timeline.startedAt);
  const projected = Date.parse(timeline.asOf ?? timeline.horizonAt);
  const now = Math.max(projected, seenAt ?? -Infinity) - t0;
  return Number.isFinite(now) ? Math.max(0, now) : undefined;
}

/** The lanes at one moment, in words — the crosshair's readout. */
function momentLabel(atMs: number, lanes: readonly TimelineLane[], nowMs: number | undefined): string {
  const busy = lanes.flatMap((lane) => {
    const bar = lane.bars.find(
      (b) =>
        atMs >= b.startMs && atMs <= (b.open && nowMs !== undefined ? Math.max(b.endMs, nowMs) : b.endMs),
    );
    return bar ? [`P${lane.phase} ${barWords(bar)}`] : [];
  });
  const when =
    nowMs !== undefined && Math.abs(atMs - nowMs) < 500
      ? `now (${duration(atMs)} in)`
      : `${duration(atMs)} in`;
  return `${when} · ${busy.length ? busy.join(', ') : 'nothing on the lane'}`;
}

/** The axis's first moment as the journal lines read: the clock, with the day once it is not today. */
function stampOf(ms: number): string {
  const at = new Date(ms);
  if (at.toDateString() === new Date().toDateString()) return clockTime(ms);
  return `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${clockTime(ms)}`;
}

/**
 * A figure's key: each mark beside the word it means — the bar's own paint at
 * key size, a rail for a held stretch — plus the hatch and the critical-path
 * outline when the figure draws them. Shared with the clock split, whose bars
 * are the same kinds; `data-slot="legend"` is the console's marker for a key
 * of the shared shape.
 */
export function BarKindKey({
  kinds,
  open = false,
  critical = false,
  className,
}: {
  kinds: readonly BarKind[];
  /** Something on the figure is still open — say what the hatch means. */
  open?: boolean;
  /** The figure outlines a critical path. */
  critical?: boolean;
  className?: string;
}) {
  return (
    <ul
      data-slot="legend"
      aria-label="Key"
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-meta text-ink-muted',
        className,
      )}
    >
      {kinds.map((kind) => (
        <li key={kind} className="flex items-center gap-1.5">
          <i
            aria-hidden
            className={cn(
              'shrink-0 bg-state',
              BAR_STYLE[kind].rail ? 'h-0.5 w-3 rounded-full' : 'h-2 w-3 rounded-sm',
              BAR_STYLE[kind].state,
            )}
          />
          {upper(BAR_STYLE[kind].label)}
        </li>
      ))}
      {open && (
        <li className="flex items-center gap-1.5">
          <i
            aria-hidden
            className="h-2 w-3 shrink-0 rounded-sm [--state:var(--ink-muted)] bg-[repeating-linear-gradient(135deg,var(--state)_0_1.5px,transparent_1.5px_3px)]"
          />
          Still open
        </li>
      )}
      {critical && (
        <li className="flex items-center gap-1.5">
          <i aria-hidden className="size-2.5 shrink-0 rounded-sm border border-action" />
          Critical path
        </li>
      )}
    </ul>
  );
}

export function RunGantt({
  timeline,
  run,
  onCompare,
  emptyAction,
  zoom,
  onZoom,
  className,
}: {
  timeline: RunTimeline;
  /**
   * The run as the cache holds it, `run:progress` patches included. Given for
   * a live run, the axis's "now" follows the lanes' own frames; absent, the
   * axis is the projection and nothing more.
   */
  run?: Pick<RunState, 'phases'> | null;
  /** Opens the attempt comparison. Absent ⇒ a lane label is not a button. */
  onCompare?: (phase: number) => void;
  /** Where an empty axis sends you — the caller knows the plan, this does not. */
  emptyAction?: ReactNode;
  /** The window the address asks for — `?zoom=` (`ui/figures/zoom-controls`). */
  zoom?: string | undefined;
  /** Writes the window to the address; absent, the zoom stays the figure's own. */
  onZoom?: (param: string | null) => void;
  className?: string;
}) {
  const { lanes, marks } = timeline;
  const heading = useId();
  const touch = useTouch();
  // When the cached run last moved. A progress frame patches it into a new
  // object; reading the clock then, and only then, is the frame's arrival.
  const seenAt = useMemo(() => (run ? Date.now() : undefined), [run]);
  const nowMs = liveNowMs(timeline, seenAt);
  // A live axis reaches the present even when the projection is older than it.
  const spanMs = Math.max(timeline.spanMs, nowMs ?? 0);
  const grow = (bar: { endMs: number; open: boolean }) =>
    bar.open && nowMs !== undefined ? Math.max(bar.endMs, nowMs) : bar.endMs;

  const marksByPhase = useMemo(() => {
    const map = new Map<number, TimelineMark[]>();
    for (const mark of marks) {
      if (mark.phase === undefined) continue;
      if (!map.has(mark.phase)) map.set(mark.phase, []);
      map.get(mark.phase)!.push(mark);
    }
    return map;
  }, [marks]);

  /** Cost per attempt window; an open one reads its lane's live spend when that is newer. */
  const cost: TimelineSeriesPoint[] = useMemo(
    () =>
      (timeline.series?.cost ?? []).map((point) => {
        if (!point.open) return point;
        const spent = run?.phases?.[String(point.phase)]?.live?.spentUsd;
        return {
          ...point,
          endMs: nowMs !== undefined ? Math.max(point.endMs, nowMs) : point.endMs,
          value: typeof spent === 'number' ? Math.max(point.value, spent) : point.value,
        };
      }),
    [timeline.series, run, nowMs],
  );

  /** The moments a keyboard can rest on: every bar's edges, every mark, and now. */
  const stops = useMemo(() => {
    const at = new Set<number>([0, spanMs]);
    for (const lane of lanes) {
      for (const bar of lane.bars) {
        at.add(bar.startMs);
        at.add(grow(bar));
      }
    }
    for (const mark of marks) at.add(mark.atMs);
    if (nowMs !== undefined) at.add(nowMs);
    return [...at].filter((ms) => ms >= 0 && ms <= spanMs).sort((a, b) => a - b);
    // `grow` reads only `nowMs`, which is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lanes, marks, nowMs, spanMs]);

  const figure = useFigure({
    label: 'Run timeline',
    count: stops.length,
    bounds: [0, Math.max(spanMs, 1)],
    // Closer than a minute of a many-hour run is noise; a short run zooms to a sixteenth.
    minSpan: Math.max(1, Math.min(60_000, spanMs / 16)),
    describe: (i) => momentLabel(stops[i], lanes, nowMs),
    stopAt: (i) => stops[i],
    initialStop: nowMs !== undefined ? Math.max(0, stops.indexOf(nowMs)) : stops.length - 1,
    locate: (clientX, _clientY, view, surface) => {
      const rect = surface?.querySelector('svg')?.getBoundingClientRect();
      if (!rect || !(rect.width > 0)) return null;
      const at = linear(view, [rect.left, rect.right]).invert(clientX);
      let stop = 0;
      for (let i = 1; i < stops.length; i++)
        if (Math.abs(stops[i] - at) < Math.abs(stops[stop] - at)) stop = i;
      return { at, stop };
    },
  });
  const cursorMs = figure.cursor !== null ? (stops[figure.cursor] ?? null) : null;

  // The window the address names, taken once the axis has a span (#376).
  const hasSpan = spanMs > 0;
  const { zoomTo, reset } = figure;
  useEffect(() => {
    if (!hasSpan) return;
    const window = zoomWindowOf(zoom, spanMs);
    if (window) zoomTo(window);
    else if (!zoom) reset();
    // The span grows under a live run; the address is read when it changes, not on every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, hasSpan, zoomTo, reset]);

  const rows: SwimlaneRow[] = useMemo(
    () =>
      lanes.map((lane) => ({
        key: String(lane.phase),
        ariaLabel: laneLabel(lane),
        emphasis: lane.critical,
        label: (
          <>
            {lane.attempts >= 2 && onCompare ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-auto min-w-0 gap-1 px-1 py-0 tnum"
                onClick={() => onCompare(lane.phase)}
                title={`Compare phase ${lane.phase}'s ${lane.attempts} attempts`}
                aria-label={`Compare phase ${lane.phase}'s ${lane.attempts} attempts`}
              >
                P{lane.phase}
                <span className="text-ink-faint">×{lane.attempts}</span>
              </Button>
            ) : (
              <span className="px-1 text-meta text-ink-muted tnum">P{lane.phase}</span>
            )}
            {lane.critical ? (
              <span className="text-meta text-ink" title="On the measured critical path" aria-hidden>
                ◆
              </span>
            ) : null}
          </>
        ),
        bars: lane.bars.map((bar, i) => ({
          key: `${bar.kind}-${bar.startMs}-${i}`,
          startMs: bar.startMs,
          // An open bar grows to the present on every progress frame.
          endMs: grow(bar),
          state: BAR_STYLE[bar.kind].state,
          ...(BAR_STYLE[bar.kind].rail ? { rail: true } : {}),
          open: bar.open,
          outlined: lane.critical,
          title:
            `P${lane.phase} attempt ${bar.attempt}: ${BAR_STYLE[bar.kind].label} ` +
            `${duration(grow(bar) - bar.startMs)}${bar.note ? ` (${bar.note})` : ''}` +
            `${bar.open ? ' (still open)' : ''}`,
        })),
        marks: (marksByPhase.get(lane.phase) ?? []).map((mark, i) => ({
          key: `${mark.kind}-${mark.atMs}-${i}`,
          atMs: mark.atMs,
          glyph: MARK_GLYPH[mark.kind],
          state: mark.ok === false ? 'state-failed' : undefined,
          title: `${duration(mark.atMs)} · ${mark.kind}: ${mark.label}`,
        })),
      })),
    // `grow` reads only `nowMs`, which is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lanes, marksByPhase, onCompare, nowMs],
  );

  const axisMarks = useMemo(
    () =>
      marks
        .filter((mark) => mark.phase === undefined)
        .map((mark, i) => ({
          key: `run-${mark.kind}-${mark.atMs}-${i}`,
          atMs: mark.atMs,
          glyph: MARK_GLYPH[mark.kind],
          title: `${duration(mark.atMs)} · ${mark.kind}: ${mark.label}`,
        })),
    [marks],
  );

  const started = timeline.startedAt ? Date.parse(timeline.startedAt) : Number.NaN;
  const open = lanes.some((lane) => lane.bars.some((bar) => bar.open));
  const buttons = Boolean(onCompare) && lanes.some((lane) => lane.attempts >= 2);
  const criticalText = timeline.criticalPath.length
    ? `${timeline.criticalPath.map((phase) => `P${phase}`).join(' → ')}, ${duration(timeline.criticalMs)}`
    : null;

  return (
    <section
      data-testid="run-gantt"
      aria-labelledby={heading}
      className={cn('flex min-w-0 flex-col gap-2', className)}
    >
      <SectionHeading
        as="h3"
        id={heading}
        title="Working bars are sessions; queueing, a run that was down and verification are drawn as themselves. Hatched means still open."
      >
        When each phase held the lane
      </SectionHeading>
      {!lanes.length ? (
        <Empty
          data-testid="gantt-empty"
          title="Nothing on the axis yet: bars are bracketed by journal entries, and the journal has none for a phase."
          action={emptyAction}
        />
      ) : (
        <>
          {(Number.isFinite(started) || timeline.truncated) && (
            <p className="flex min-w-0 flex-wrap gap-x-3 text-meta text-ink-muted">
              {Number.isFinite(started) && (
                <span title={`The axis starts ${new Date(started).toLocaleString()}`} className="tnum">
                  From {stampOf(started)}
                </span>
              )}
              {timeline.truncated && (
                <span
                  data-testid="gantt-truncated"
                  title="The journal was read as a tail, so a lane marked partial begins mid-flight rather than at its first boarding."
                >
                  Journal truncated
                </span>
              )}
            </p>
          )}

          <ZoomControls
            figure={figure}
            spanMs={spanMs}
            quick
            current={zoom}
            {...(onZoom ? { onZoom } : {})}
          />

          <Swimlane
            rows={rows}
            spanMs={spanMs}
            view={figure.view}
            nowMs={nowMs}
            cursorMs={cursorMs}
            figure={figure}
            axisMarks={axisMarks}
            hatchId="pe-run-gantt-open"
            tickLabel={duration}
            rowHeight={touch && buttons ? TAP_ROW : ROW}
            ariaLabel={`Run timeline over ${duration(spanMs)}, ${plural(lanes.length, 'phase')}`}
            {...(cost.length
              ? {
                  below: {
                    height: COST_HEIGHT,
                    label: <span className="px-1 text-meta text-ink-muted">Cost</span>,
                    node: (
                      <RunCostFigure
                        points={cost}
                        view={figure.view}
                        nowMs={nowMs}
                        cursorMs={cursorMs}
                        height={COST_HEIGHT}
                        describe={(point) =>
                          `P${point.phase} attempt ${point.attempt}: ${money(point.value)}` +
                          `${point.open ? ' so far' : ''} over ${duration(point.endMs - point.startMs)}`
                        }
                      />
                    ),
                  },
                }
              : {})}
          />

          {/* What the crosshair is on, or what the axis is. The slider's value
              text says the same words to a screen reader, so this is hidden
              from one; the way back from a zoom sits beside it, never inside
              the slider. */}
          <div className="flex min-h-6 min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-meta text-ink-muted">
            <span aria-hidden data-readout className="min-w-0 break-words tnum">
              {cursorMs !== null
                ? figure.sliderProps['aria-valuetext']
                : nowMs !== undefined
                  ? `The axis follows the lanes live, now ${duration(nowMs)} in`
                  : `${duration(spanMs)} end to end`}
            </span>
            {figure.zoomed ? (
              <Button
                variant="ghost"
                size="sm"
                className="tnum"
                onClick={() => {
                  figure.reset();
                  onZoom?.(null);
                }}
              >
                Reset zoom (×{figure.zoom.toFixed(1)})
              </Button>
            ) : null}
          </div>

          <BarKindKey kinds={KINDS} open={open} critical={criticalText !== null} />

          {criticalText ? (
            <p
              data-testid="gantt-critical"
              className="text-meta text-ink-muted tnum"
              title="The longest dependency chain, weighted by each phase's measured session and verification time and never by a bar still open — not the plan's estimate, which answers what is left rather than what happened."
            >
              <span className="text-ink">Critical path</span> {criticalText}
            </p>
          ) : null}

          <div className="flex min-w-0 flex-col gap-1">
            <FigureNumbers
              label="attempt costs"
              caption="What each attempt cost: the numbers behind the cost strip"
              rows={cost}
              getRowKey={(point) => `${point.phase}-${point.attempt}`}
              columns={[
                { head: 'Attempt', cell: (point) => `P${point.phase} attempt ${point.attempt}` },
                {
                  head: 'Cost',
                  cell: (point) => `${money(point.value)}${point.open ? ' so far' : ''}`,
                  align: 'end',
                },
                {
                  head: 'Window',
                  cell: (point) => `${duration(point.startMs)} → ${duration(point.endMs)}`,
                  align: 'end',
                },
              ]}
            />
            <FigureNumbers
              label="lanes"
              caption="Each phase's time on the run's axis, by what its bars were: the numbers behind the lanes"
              rows={lanes}
              getRowKey={(lane) => String(lane.phase)}
              columns={[
                {
                  head: 'Phase',
                  cell: (lane) => `P${lane.phase}${lane.partial ? ', starts mid-flight' : ''}`,
                },
                { head: 'Attempts', cell: (lane) => lane.attempts, align: 'end' },
                { head: 'Where its time went', cell: (lane) => partsOf(lane) || '—' },
                { head: 'On the axis', cell: (lane) => duration(lane.totalMs), align: 'end' },
              ]}
            />
          </div>
        </>
      )}
    </section>
  );
}
