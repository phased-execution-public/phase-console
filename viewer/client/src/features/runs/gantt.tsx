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
import { AXIS, ROW, Swimlane, ticksFor, type SwimlaneRow } from '@/components/swimlane';
import { duration } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { BarKind, RunTimeline, TimelineLane, TimelineMark } from '@/lib/api';

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
 */
export const BAR_STYLE: Record<BarKind, { label: string; state: string }> = {
  working: { label: 'working', state: 'state-running' },
  verifying: { label: 'verifying', state: 'state-verifying' },
  waiting: { label: 'waiting', state: 'state-waiting' },
  frozen: { label: 'frozen', state: '[--state:var(--ink-faint)]' },
};

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
};

/** One lane's numbers as a sentence — the screen-reader text and the tooltip. */
export function laneLabel(lane: TimelineLane): string {
  const parts: string[] = [];
  for (const kind of ['working', 'verifying', 'waiting', 'frozen'] as const) {
    const ms = lane[`${kind}Ms` as const];
    if (ms > 0) parts.push(`${duration(ms)} ${BAR_STYLE[kind].label}`);
  }
  const attempts = `${lane.attempts} attempt${lane.attempts === 1 ? '' : 's'}`;
  return (
    `phase ${lane.phase}: ${attempts}${parts.length ? `, ${parts.join(', ')}` : ''}` +
    (lane.partial ? ' (journal truncated — this lane starts mid-flight)' : '')
  );
}

export function Gantt({
  timeline,
  onCompare,
  emptyAction,
  className,
}: {
  timeline: RunTimeline;
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
  const { lanes, spanMs, marks } = timeline;
  const marksByPhase = useMemo(() => {
    const map = new Map<number, TimelineMark[]>();
    for (const mark of marks) {
      if (mark.phase === undefined) continue;
      if (!map.has(mark.phase)) map.set(mark.phase, []);
      map.get(mark.phase)!.push(mark);
    }
    return map;
  }, [marks]);

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
          endMs: bar.endMs,
          state: BAR_STYLE[bar.kind].state,
          open: bar.open,
          outlined: lane.critical,
          title:
            `p${lane.phase} attempt ${bar.attempt}: ${BAR_STYLE[bar.kind].label} ` +
            `${duration(bar.endMs - bar.startMs)}${bar.open ? ' (still open)' : ''}`,
        })),
        marks: (marksByPhase.get(lane.phase) ?? []).map((mark, i) => ({
          key: `${mark.kind}-${mark.atMs}-${i}`,
          atMs: mark.atMs,
          glyph: MARK_GLYPH[mark.kind],
          state: mark.ok === false ? 'state-failed' : undefined,
          title: `${duration(mark.atMs)} · ${mark.kind}: ${mark.label}`,
        })),
      })),
    [lanes, marksByPhase, onCompare],
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
          Every bar is bracketed by two journal entries. Hatched means still open.
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
              axisMarks={axisMarks}
              hatchId="pe-gantt-open"
              tickLabel={duration}
              ariaLabel={`Run timeline over ${duration(spanMs)}, ${lanes.length} phases`}
            />

            {/* The shared key — the bar's own paint at legend size, since a
                gantt band and a legend dot must be the same mark. */}
            <Legend
              className="mt-3 gap-x-4"
              entries={[
                ...(Object.keys(BAR_STYLE) as BarKind[]).map((kind) => ({
                  key: kind,
                  label: BAR_STYLE[kind].label,
                  mark: (
                    <span
                      className={cn('size-2 shrink-0 rounded-full bg-state', BAR_STYLE[kind].state)}
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
                weighted by what each lane actually took — not the plan&apos;s estimate, which answers what is
                left rather than what happened.
              </p>
            ) : null}

            {timeline.truncated ? (
              <p className="mt-1 max-w-prose text-2xs text-ink-faint">
                The journal was read as a tail, so any lane marked partial begins mid-flight rather than at
                its first boarding.
              </p>
            ) : null}
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
