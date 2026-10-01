/**
 * The run on one time axis — what was happening at 14:20, and what was waiting.
 *
 * The `Timeline` card beside this one answers a different question well: how
 * each phase's own wall clock was split. Every bar there starts at the same
 * left edge, which is exactly what makes it useless for the question this
 * chart exists for — *when* did each phase hold the lane, and which chain of
 * them made the run as long as it was.
 *
 * So: one shared axis, one row per phase, bars bracketed by journal entries
 * (`server/analysis/timeline.ts` does the projection; nothing is modelled
 * here). Three things are deliberately visible rather than tucked into a
 * tooltip, because each is a claim the chart would otherwise make silently:
 *
 *   - **an open bar is hatched.** "This phase worked for 40 minutes" and "has
 *     been working for 40 minutes so far" are different statements and a solid
 *     bar tells the first one.
 *   - **a truncated journal says so.** The projection reads a tail; if the
 *     tail cut a lane's opening off, that lane's bars start mid-flight and the
 *     header says which. A confident wrong picture is the failure mode here.
 *   - **the critical path is named in text**, not only drawn. The overlay is a
 *     highlight; the sentence under it is what someone can act on.
 *
 * Since many-plans-one-repo phase 13 the DRAWING is
 * `components/swimlane.tsx` — the geometry, the tick ladder, the hatch and the
 * `.state-*` bridge, with no opinion about what a row is — and this file is the
 * adapter that says a row is a PHASE, a bar is a boarding, and a label with two
 * attempts behind it is a button. Debug ▸ Timeline draws six other kinds of row
 * through the same primitive, and the alternative was a second copy of all four
 * constants: the bar table had already drifted once that way, painting
 * `verifying` with `--action` while every badge in the console painted it
 * `--status-verifying`.
 */

import { useMemo, type ReactNode } from 'react';

import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Empty, Legend } from '@/components/ui';
import { ChartNumbers } from '@/components/charts';
import { RunCostFigure } from '@/components/figures/lazy';
import { useFigure } from '@/components/figures/use-figure';
import { AXIS, ROW, Swimlane, ticksFor, type SwimlaneRow } from '@/components/swimlane';
import { duration, money } from '@/lib/format';
import { cn } from '@/lib/cn';
import type {
  BarKind,
  RunState,
  RunTimeline,
  TimelineLane,
  TimelineMark,
  TimelineSeriesPoint,
} from '@/lib/api';

/**
 * Re-exported rather than re-declared: the geometry moved to the primitive, and
 * this module's own tests plus `features/runs`'s callers name it here. One
 * definition, two addresses — the alternative is the drift the file lead names.
 */
export { ticksFor, AXIS, ROW };

/**
 * What each bar kind means, and the one CLASS that decides its colour.
 *
 * Not a hue. This table used to name `var(--status-running)` and
 * `var(--status-waiting)` directly, which made it a second status→colour table
 * living one directory from the first — and it had already drifted: `verifying`
 * was painted `--action` here while every badge in the console paints it
 * `--status-verifying`. A `.state-*` class sets `--state` and every badge, dot,
 * row and map segment paints through that one variable (`styles/theme.css`),
 * so naming the class is naming the state and the colour follows.
 *
 * `frozen` is deliberately NOT a status hue: nothing is wrong and nothing is
 * moving. It sets the same variable to the neutral ink, so it goes through the
 * bridge like everything else rather than round it.
 *
 * `queued` and `down` joined in control-tower phase 61 (#76), when `working`
 * narrowed to session time. Queueing is the console's own `queued` state. A
 * run that was down paints `skipped` — the neutral that keeps the status
 * lightness — rather than amber: amber means somebody has to act NOW, and a
 * bar is history; its cause is in the tooltip, not in the hue.
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

/** The kinds in the table's own order — the legend's, the label's and the readout's. */
const KINDS = Object.keys(BAR_STYLE) as BarKind[];

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

/** One lane's numbers as a sentence — the screen-reader text and the tooltip. */
export function laneLabel(lane: TimelineLane): string {
  const parts: string[] = [];
  for (const kind of KINDS) {
    const ms = lane[`${kind}Ms` as const];
    if (ms > 0) parts.push(`${duration(ms)} ${BAR_STYLE[kind].label}`);
  }
  const attempts = `${lane.attempts} attempt${lane.attempts === 1 ? '' : 's'}`;
  return (
    `phase ${lane.phase}: ${attempts}${parts.length ? `, ${parts.join(', ')}` : ''}` +
    (lane.partial ? ' (journal truncated — this lane starts mid-flight)' : '')
  );
}

/** The cost strip's height, in px — the Swimlane keeps its label level with it. */
const COST_HEIGHT = 40;

/**
 * Where "now" is on a live axis, in ms from its left edge — `undefined` for a
 * run that has ended, whose axis has an end rather than a present.
 *
 * The projection's own stamp (`asOf`) is the floor; `seenAt` — when the cached
 * run last moved, which a `run:progress` frame does by patching it — moves it
 * on. That is the whole of "the axis advances with no refetch" (#32 gap 1):
 * the frame is already in the cache, and the picture reads the cache.
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
    return bar ? [`p${lane.phase} ${barWords(bar)}`] : [];
  });
  const when =
    nowMs !== undefined && Math.abs(atMs - nowMs) < 500
      ? `now (${duration(atMs)} in)`
      : `${duration(atMs)} in`;
  return `${when} · ${busy.length ? busy.join(', ') : 'nothing on the lane'}`;
}

export function Gantt({
  timeline,
  run,
  onCompare,
  emptyAction,
  className,
}: {
  timeline: RunTimeline;
  /**
   * The run as the cache holds it, `run:progress` patches included. Given for
   * a live run, the axis's "now" follows the lanes' own frames; absent (Debug ▸
   * Journal), the axis is the projection and nothing more.
   */
  run?: Pick<RunState, 'phases'> | null;
  /** Opens the attempt comparison. Absent ⇒ the lane label is not a button. */
  onCompare?: (phase: number) => void;
  /**
   * Where an empty axis sends you. Passed in rather than built here: this
   * panel is handed a timeline and knows no plan, so it cannot name a
   * destination without being told one.
   */
  emptyAction?: ReactNode;
  className?: string;
}) {
  const { lanes, marks } = timeline;
  // When the cached run last moved. A progress frame patches it into a new
  // object; reading the clock then, and only then, is the frame's arrival —
  // with no stamp in the patch, which is first-paint code.
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
    label: 'Run timeline — read a moment',
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
      const at = view[0] + ((clientX - rect.left) / rect.width) * (view[1] - view[0]);
      let stop = 0;
      for (let i = 1; i < stops.length; i++)
        if (Math.abs(stops[i] - at) < Math.abs(stops[stop] - at)) stop = i;
      return { at, stop };
    },
  });
  const cursorMs = figure.cursor !== null ? (stops[figure.cursor] ?? null) : null;

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
                className="h-auto px-1 py-0 font-mono text-2xs"
                onClick={() => onCompare(lane.phase)}
                title={`Compare phase ${lane.phase}'s ${lane.attempts} attempts`}
              >
                p{lane.phase}
                <span className="ml-1 text-ink-faint">×{lane.attempts}</span>
              </Button>
            ) : (
              <span className="px-1 font-mono text-2xs text-ink-faint tabular-nums">p{lane.phase}</span>
            )}
            {lane.critical ? (
              <span className="text-2xs text-action" title="On the measured critical path" aria-hidden="true">
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
            `p${lane.phase} attempt ${bar.attempt}: ${BAR_STYLE[bar.kind].label} ` +
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

  const criticalText = timeline.criticalPath.length
    ? `${timeline.criticalPath.map((phase) => `p${phase}`).join(' → ')} · ${duration(timeline.criticalMs)}`
    : null;

  return (
    <Card className={className}>
      <CardHeader className="flex-wrap items-baseline gap-x-3">
        <CardTitle>Run timeline</CardTitle>
        <span className="max-w-prose text-2xs text-ink-faint">
          Working bars are sessions; queueing, a run that was down and verification are drawn as themselves.
          Hatched means still open.
          {timeline.startedAt ? ` Axis starts ${new Date(timeline.startedAt).toLocaleString()}.` : ''}
        </span>
        {timeline.truncated ? (
          <Badge
            tone="wait"
            title="The projection read the newest entries only; lanes marked partial begin mid-flight."
          >
            journal truncated
          </Badge>
        ) : null}
      </CardHeader>
      <CardBody>
        {lanes.length ? (
          <>
            <Swimlane
              rows={rows}
              spanMs={spanMs}
              view={figure.view}
              nowMs={nowMs}
              cursorMs={cursorMs}
              figure={figure}
              axisMarks={axisMarks}
              hatchId="pe-gantt-open"
              tickLabel={duration}
              ariaLabel={`Run timeline over ${duration(spanMs)}, ${lanes.length} phases`}
              {...(cost.length
                ? {
                    below: {
                      height: COST_HEIGHT,
                      label: <span className="px-1 font-mono text-2xs text-ink-faint">cost</span>,
                      node: (
                        <RunCostFigure
                          points={cost}
                          view={figure.view}
                          nowMs={nowMs}
                          cursorMs={cursorMs}
                          height={COST_HEIGHT}
                          describe={(point) =>
                            `p${point.phase} attempt ${point.attempt}: ${money(point.value)}` +
                            `${point.open ? ' so far' : ''} over ${duration(point.endMs - point.startMs)}`
                          }
                        />
                      ),
                    },
                  }
                : {})}
            />

            {/* The crosshair's line: what it is on, or how to reach it. The
                slider's value text says the same words to a screen reader. */}
            <div className="mt-1 flex min-h-[1.5rem] items-center justify-between gap-2 text-2xs text-ink-faint">
              <span aria-hidden="true" data-readout className="min-w-0 truncate">
                {cursorMs !== null
                  ? figure.sliderProps['aria-valuetext']
                  : nowMs !== undefined
                    ? `live · the axis follows the lanes' progress, now ${duration(nowMs)} in`
                    : `${duration(spanMs)} end to end`}
              </span>
              {figure.zoomed ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto shrink-0 px-1 py-0 text-2xs"
                  onClick={figure.reset}
                >
                  Reset zoom · ×{figure.zoom.toFixed(1)}
                </Button>
              ) : null}
            </div>

            {/* The shared key — the bar's own paint at legend size, since a
                gantt band and a legend dot must be the same mark. */}
            <Legend
              className="mt-3 gap-x-4"
              entries={[
                ...KINDS.map((kind) => ({
                  key: kind,
                  label: BAR_STYLE[kind].label,
                  mark: (
                    <span
                      className={cn(
                        'shrink-0 bg-state',
                        BAR_STYLE[kind].rail ? 'h-0.5 w-3 rounded-full' : 'size-2 rounded-full',
                        BAR_STYLE[kind].state,
                      )}
                      aria-hidden="true"
                    />
                  ),
                })),
                {
                  key: 'critical',
                  label: 'critical path',
                  mark: (
                    <span className="size-2 shrink-0 rounded-full border border-action" aria-hidden="true" />
                  ),
                },
              ]}
            />

            {criticalText ? (
              <p className="mt-2 max-w-prose text-2xs text-ink-faint">
                <span className="text-ink">Critical path:</span> {criticalText}. The longest dependency chain
                weighted by each phase&apos;s measured session and verification time, never by a bar still
                open — not the plan&apos;s estimate, which answers what is left rather than what happened.
              </p>
            ) : null}

            {timeline.truncated ? (
              <p className="mt-1 max-w-prose text-2xs text-ink-faint">
                The journal was read as a tail, so any lane marked partial begins mid-flight rather than at
                its first boarding.
              </p>
            ) : null}

            {/* The cost strip's own table: a strip is a figure, and a figure
                owes its numbers — the dollars a 40px bar can only suggest. */}
            <ChartNumbers
              label="attempt costs"
              caption="What each attempt cost, the numbers behind the cost strip"
              rows={cost}
              getRowKey={(point) => `${point.phase}-${point.attempt}`}
              columns={[
                { head: 'Attempt', cell: (point) => `p${point.phase} attempt ${point.attempt}` },
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
          </>
        ) : (
          <Empty
            title="Nothing on the axis yet"
            body="A phase appears here once its first journal entry lands. Bars are bracketed by journal entries, so an empty axis means an empty journal — not a phase that took no time."
            {...(emptyAction ? { action: emptyAction } : {})}
          />
        )}
      </CardBody>
    </Card>
  );
}

export default Gantt;
