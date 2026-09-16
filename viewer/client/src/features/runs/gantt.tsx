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
 */

import { useMemo, type ReactNode } from 'react';

import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Empty, Legend } from '@/components/ui';
import { duration } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { BarKind, RunTimeline, TimelineLane, TimelineMark } from '@/lib/api';

/** Row geometry, in the SVG's own units. The viewBox does the scaling. */
const ROW = 22;
const BAR = 11;
const TRACK = 1000;
const AXIS = 16;

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

/**
 * Tick every 1, 2, 5 … of a sane unit, aiming for six or so labels.
 *
 * Exported because "does the axis label the time the journal says" is the
 * cheapest half of exit criterion 1 to check, and it should be checkable
 * without rendering an SVG.
 */
export function ticksFor(spanMs: number, target = 6): number[] {
  if (!(spanMs > 0)) return [];
  const raw = spanMs / target;
  const units = [
    1_000,
    5_000,
    15_000,
    30_000,
    60_000,
    5 * 60_000,
    15 * 60_000,
    30 * 60_000,
    3_600_000,
    2 * 3_600_000,
    6 * 3_600_000,
    12 * 3_600_000,
    86_400_000,
    7 * 86_400_000,
  ];
  const step = units.find((unit) => unit >= raw) ?? units.at(-1)!;
  const out: number[] = [];
  for (let at = 0; at <= spanMs; at += step) out.push(at);
  return out;
}

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
  const ticks = useMemo(() => ticksFor(spanMs), [spanMs]);
  const x = (ms: number): number => (spanMs > 0 ? (ms / spanMs) * TRACK : 0);
  const height = AXIS + lanes.length * ROW;
  const marksByPhase = useMemo(() => {
    const map = new Map<number, TimelineMark[]>();
    for (const mark of marks) {
      if (mark.phase === undefined) continue;
      if (!map.has(mark.phase)) map.set(mark.phase, []);
      map.get(mark.phase)!.push(mark);
    }
    return map;
  }, [marks]);

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
            <div className="grid grid-cols-[4.5rem_1fr] gap-x-2">
              {/* The labels sit outside the SVG so they stay real text: a
                  phase with two attempts is a BUTTON, and an <svg><text> is
                  not something anyone can click with a keyboard. */}
              <ol className="flex flex-col" style={{ paddingTop: `${(AXIS / height) * 100}%` }}>
                {lanes.map((lane) => (
                  <li
                    key={lane.phase}
                    className="flex items-center gap-1"
                    style={{ height: `${(ROW / height) * 100}%`, minHeight: '1.25rem' }}
                  >
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
                      <span className="px-1 font-mono text-2xs text-ink-faint tabular-nums">
                        p{lane.phase}
                      </span>
                    )}
                    {lane.critical ? (
                      <span
                        className="text-2xs text-action"
                        title="On the measured critical path"
                        aria-hidden="true"
                      >
                        ◆
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>

              <svg
                viewBox={`0 0 ${TRACK} ${height}`}
                preserveAspectRatio="none"
                className="w-full"
                style={{ height: `${Math.max(height, 40)}px` }}
                role="img"
                aria-label={`Run timeline over ${duration(spanMs)}, ${lanes.length} phases`}
              >
                <defs>
                  {/* An open bar is hatched. `patternUnits` in userSpace so the
                      hatch does not stretch with the non-uniform viewBox. */}
                  <pattern
                    id="pe-gantt-open"
                    width="6"
                    height="6"
                    patternUnits="userSpaceOnUse"
                    patternTransform="rotate(35)"
                  >
                    <rect width="6" height="6" fill="var(--ground-deep)" />
                    <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="3" opacity="0.55" />
                  </pattern>
                </defs>

                {/* The axis: a gridline and a label per tick. */}
                {ticks.map((at) => (
                  <g key={at}>
                    <line
                      x1={x(at)}
                      y1={AXIS}
                      x2={x(at)}
                      y2={height}
                      stroke="var(--rule)"
                      strokeWidth="0.5"
                      vectorEffect="non-scaling-stroke"
                    />
                    <text x={x(at) + 2} y={11} fontSize="9" fill="var(--ink-faint)">
                      {duration(at)}
                    </text>
                  </g>
                ))}

                {/* Run-level marks — each start of the run, with its door — sit on
                    the axis itself: they belong to no lane. */}
                {marks
                  .filter((mark) => mark.phase === undefined)
                  .map((mark, i) => (
                    <text
                      key={`run-${mark.kind}-${mark.atMs}-${i}`}
                      x={x(mark.atMs)}
                      y={AXIS - 2}
                      fontSize="8"
                      textAnchor="middle"
                      className="[--state:var(--ink-muted)]"
                      fill="var(--state)"
                    >
                      {MARK_GLYPH[mark.kind]}
                      <title>{`${duration(mark.atMs)} · ${mark.kind}: ${mark.label}`}</title>
                    </text>
                  ))}

                {lanes.map((lane, row) => {
                  const y = AXIS + row * ROW;
                  return (
                    <g key={lane.phase} role="img" aria-label={laneLabel(lane)}>
                      {/* The lane's own track, so an empty stretch reads as a
                          gap in THIS phase rather than as page background. */}
                      <rect
                        x={0}
                        y={y + (ROW - BAR) / 2}
                        width={TRACK}
                        height={BAR}
                        fill="var(--ground-deep)"
                        opacity={lane.critical ? 0.9 : 0.5}
                        rx="2"
                      />
                      {lane.bars.map((bar, i) => {
                        const style = BAR_STYLE[bar.kind];
                        const width = Math.max(1.5, x(bar.endMs) - x(bar.startMs));
                        return (
                          <rect
                            key={`${bar.kind}-${bar.startMs}-${i}`}
                            x={x(bar.startMs)}
                            y={y + (ROW - BAR) / 2}
                            width={width}
                            height={BAR}
                            rx="2"
                            className={style.state}
                            fill={bar.open ? 'url(#pe-gantt-open)' : 'var(--state)'}
                            // The open-bar hatch paints in `currentColor`, so
                            // the state has to reach it as a colour too.
                            color="var(--state)"
                            stroke={lane.critical ? 'var(--action)' : 'none'}
                            strokeWidth={lane.critical ? 1 : 0}
                            vectorEffect="non-scaling-stroke"
                          >
                            <title>
                              {`p${lane.phase} attempt ${bar.attempt}: ${style.label} ` +
                                `${duration(bar.endMs - bar.startMs)}${bar.open ? ' (still open)' : ''}`}
                            </title>
                          </rect>
                        );
                      })}
                      {(marksByPhase.get(lane.phase) ?? []).map((mark, i) => (
                        <text
                          key={`${mark.kind}-${mark.atMs}-${i}`}
                          x={x(mark.atMs)}
                          y={y + ROW - 2}
                          fontSize="7"
                          textAnchor="middle"
                          className={mark.ok === false ? 'state-failed' : '[--state:var(--ink-faint)]'}
                          fill="var(--state)"
                        >
                          {MARK_GLYPH[mark.kind]}
                          <title>{`${duration(mark.atMs)} · ${mark.kind}: ${mark.label}`}</title>
                        </text>
                      ))}
                    </g>
                  );
                })}
              </svg>
            </div>

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
