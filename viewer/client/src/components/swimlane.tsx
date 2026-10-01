/**
 * Rows of bars on one shared time axis — the drawing, with none of the meaning.
 *
 * This is `Gantt`'s geometry, lifted out. The Gantt answered one question well
 * — *when did each PHASE hold the lane* — and to answer it, it grew four
 * constants, a tick ladder, a hatch pattern and the `.state-*` bridge that
 * keeps a bar's colour and a badge's colour the same variable. Debug ▸ Timeline
 * asks the same question of six different kinds of row (the run, its phases,
 * its sessions, the console's own warnings, git commands, HTTP requests), and
 * the alternative to extracting this was a second copy of all four — which is
 * how the bar table came to name `var(--action)` for `verifying` while every
 * badge in the console named `var(--status-verifying)`.
 *
 * So: the caller says what a row IS and what a bar MEANS; this file says where
 * the pixels go. Three rules survive the move intact, because each is a claim
 * the picture makes on its own and losing one would make it lie:
 *
 *   - **an open bar is hatched**, never solid. "Ran for 40 minutes" and "has
 *     been running for 40 minutes so far" are different statements.
 *   - **the axis lands on round units.** A span divided by six gives labels
 *     like `10:23`, which nobody can line up against anything.
 *   - **a row's label is real text, outside the SVG.** An `<svg><text>` is not
 *     reachable with a keyboard, and half of these labels are buttons.
 *
 * The one thing this file will not do is name a colour. A bar carries a
 * `.state-*` class, that class sets `--state` (`styles/theme.css`), and every
 * badge, dot, row and map segment in the console paints through the same
 * variable. Naming the class is naming the state; the colour follows.
 */

import { useMemo, type ReactNode } from 'react';

import { durationTicks, type AxisWindow } from '@/components/figures/scales';
import type { Figure } from '@/components/figures/use-figure';
import { cn } from '@/lib/cn';

/** Row geometry, in the SVG's own units. The viewBox does the scaling. */
export const ROW = 22;
export const BAR = 11;
/** A held stretch's rail — a third of a bar, still a mark against the track. */
export const RAIL = 4;
export const TRACK = 1000;
export const AXIS = 16;

/**
 * Tick every 1, 2, 5 … of a sane unit, aiming for six or so labels.
 *
 * The ladder lives in `components/figures/scales.ts` since control-tower phase
 * 29 — one axis primitive for the run's time axis, the insights figures and
 * Debug ▸ Timeline, not two. Re-exported by its old name because "does the
 * axis label the time the journal says" is still the cheapest half of the
 * timeline's exit criterion to check, and still checkable without an SVG.
 */
export { ticksFor } from '@/components/figures/scales';

/** One span on a row. `state` is a CLASS, never a hue — see the file lead. */
export type SwimlaneBar = {
  key: string;
  startMs: number;
  endMs: number;
  /** A `.state-*` class, or an arbitrary-value `[--state:…]` for a neutral. */
  state: string;
  /** Still open at the horizon: drawn hatched, never as a finished bar. */
  open?: boolean;
  /** An outline rather than a fill change — the critical-path overlay. */
  outlined?: boolean;
  /**
   * A HELD stretch rather than an active one, drawn as a thin rail through the
   * row's middle: the lane was occupied and nothing ran on it. Thickness says
   * "activity" where two neutral hues alone could not (the Gantt's `down`,
   * control-tower phase 61).
   */
  rail?: boolean;
  title?: string;
  onSelect?: () => void;
};

/** A moment worth a glyph rather than a span. */
export type SwimlaneMark = {
  key: string;
  atMs: number;
  glyph: string;
  /** As `SwimlaneBar.state`. Defaults to the faint ink. */
  state?: string;
  title?: string;
  onSelect?: () => void;
};

export type SwimlaneRow = {
  key: string;
  /**
   * The text beside the axis. A `ReactNode` rather than a string because half
   * of these are buttons, and a button drawn inside the SVG is not one.
   */
  label: ReactNode;
  /** The row's own sentence, for a reader who cannot see the bars. */
  ariaLabel: string;
  bars: SwimlaneBar[];
  marks?: SwimlaneMark[];
  /** Draw this row's empty track darker — the Gantt's critical-path emphasis. */
  emphasis?: boolean;
};

const FAINT = '[--state:var(--ink-faint)]';

export function Swimlane({
  rows,
  spanMs,
  ariaLabel,
  axisMarks = [],
  hatchId = 'pe-swimlane-open',
  tickLabel,
  labelWidth = '4.5rem',
  view,
  nowMs,
  cursorMs,
  figure,
  below,
  className,
}: {
  rows: readonly SwimlaneRow[];
  /** The axis's width in ms. Zero draws nothing. */
  spanMs: number;
  ariaLabel: string;
  /** Marks belonging to no row — drawn on the axis itself. */
  axisMarks?: readonly SwimlaneMark[];
  /**
   * The hatch pattern's id, which is a DOCUMENT-wide name: two swimlanes on one
   * page sharing one would have the second's `url(#…)` resolve to the first's
   * pattern, and nothing would look wrong until the two used different grounds.
   */
  hatchId?: string;
  /** How a tick is written. Absent ⇒ the raw millisecond count. */
  tickLabel?: (ms: number) => string;
  /** The label column's width, as a CSS length. */
  labelWidth?: string;
  /** The part of the axis on show — a zoom. Absent ⇒ the whole span. */
  view?: AxisWindow;
  /** The present, on a live axis: a dashed line the bars grow toward. */
  nowMs?: number;
  /** Where the crosshair is, in ms. */
  cursorMs?: number | null;
  /**
   * The crosshair and zoom (`figures/use-figure`). Given, the track becomes one
   * `role="slider"` a keyboard can walk and a pinch can zoom; absent, it is the
   * static drawing it always was (Debug ▸ Timeline's rows carry buttons, and a
   * button inside a slider is a control nobody can reach).
   */
  figure?: Figure;
  /**
   * A strip drawn under the lanes on the same axis — the run's cost — with its
   * label for the label column and its height, so the two stay level.
   */
  below?: { node: ReactNode; label: ReactNode; height: number };
  className?: string;
}) {
  const [v0, v1] = view ?? [0, spanMs];
  const ticks = useMemo(() => durationTicks([v0, v1]), [v0, v1]);
  if (!rows.length) return null;

  const x = (ms: number): number => (v1 > v0 ? ((ms - v0) / (v1 - v0)) * TRACK : 0);
  const clampX = (px: number): number => Math.min(TRACK, Math.max(0, px));
  const height = AXIS + rows.length * ROW;
  const write = tickLabel ?? ((ms: number) => String(ms));
  const onAxis = (ms: number | null | undefined): ms is number => ms != null && ms >= v0 && ms <= v1;

  return (
    <div className={cn('grid gap-x-2', className)} style={{ gridTemplateColumns: `${labelWidth} 1fr` }}>
      {/* Outside the SVG so the labels stay real text — see the file lead.
          With a strip below, the list is held to the lanes' own height: its
          rows are shares of it, and the strip must not stretch them. */}
      <div className="flex min-w-0 flex-col">
        <ol
          className="flex flex-col"
          style={{
            paddingTop: `${(AXIS / height) * 100}%`,
            ...(below ? { height: `${Math.max(height, 40)}px` } : { flexGrow: 1 }),
          }}
        >
          {rows.map((row) => (
            <li
              key={row.key}
              className="flex items-center gap-1"
              style={{ height: `${(ROW / height) * 100}%`, minHeight: '1.25rem' }}
            >
              {row.label}
            </li>
          ))}
        </ol>
        {below ? (
          <div className="flex items-center" style={{ height: `${below.height}px` }}>
            {below.label}
          </div>
        ) : null}
      </div>

      <div
        {...(figure ? { ...figure.sliderProps, ...figure.surfaceProps } : {})}
        className={cn('min-w-0', figure && 'select-none rounded-sm')}
      >
        <svg
          viewBox={`0 0 ${TRACK} ${height}`}
          preserveAspectRatio="none"
          className="w-full"
          style={{ height: `${Math.max(height, 40)}px` }}
          role="img"
          aria-label={ariaLabel}
        >
          <defs>
            {/* `patternUnits` in userSpace so the hatch does not stretch with the
              non-uniform viewBox. */}
            <pattern
              id={hatchId}
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(35)"
            >
              <rect width="6" height="6" fill="var(--ground-deep)" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="3" opacity="0.55" />
            </pattern>
          </defs>

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
                {write(at)}
              </text>
            </g>
          ))}

          {axisMarks.map((mark) => (
            <text
              key={mark.key}
              x={x(mark.atMs)}
              y={AXIS - 2}
              fontSize="8"
              textAnchor="middle"
              className={mark.state ?? '[--state:var(--ink-muted)]'}
              fill="var(--state)"
              {...(mark.onSelect
                ? {
                    role: 'button',
                    'aria-label': mark.title,
                    style: { cursor: 'pointer' },
                    onClick: mark.onSelect,
                  }
                : {})}
            >
              {mark.glyph}
              {mark.title ? <title>{mark.title}</title> : null}
            </text>
          ))}

          {rows.map((row, index) => {
            const y = AXIS + index * ROW;
            return (
              <g key={row.key} role="img" aria-label={row.ariaLabel}>
                {/* The row's own track, so an empty stretch reads as a gap in
                  THIS row rather than as page background. */}
                <rect
                  x={0}
                  y={y + (ROW - BAR) / 2}
                  width={TRACK}
                  height={BAR}
                  fill="var(--ground-deep)"
                  opacity={row.emphasis ? 0.9 : 0.5}
                  rx="2"
                />
                {row.bars.map((bar) =>
                  bar.endMs < v0 || bar.startMs > v1 ? null : (
                    <rect
                      key={bar.key}
                      x={clampX(x(bar.startMs))}
                      y={y + (ROW - (bar.rail ? RAIL : BAR)) / 2}
                      width={Math.max(1.5, clampX(x(bar.endMs)) - clampX(x(bar.startMs)))}
                      height={bar.rail ? RAIL : BAR}
                      rx={bar.rail ? '1' : '2'}
                      className={bar.state}
                      fill={bar.open ? `url(#${hatchId})` : 'var(--state)'}
                      // The open-bar hatch paints in `currentColor`, so the state
                      // has to reach it as a colour too.
                      color="var(--state)"
                      stroke={bar.outlined ? 'var(--action)' : 'none'}
                      strokeWidth={bar.outlined ? 1 : 0}
                      vectorEffect="non-scaling-stroke"
                      {...(bar.onSelect
                        ? {
                            role: 'button',
                            // An SVG `<title>` child is a tooltip, not an accessible
                            // NAME for an ARIA role — axe's `aria-command-name` is
                            // the rule, and a bar a screen reader announces as
                            // "button" and nothing else is a button nobody can use.
                            // The name is the same sentence the pointer gets.
                            'aria-label': bar.title,
                            style: { cursor: 'pointer' },
                            onClick: bar.onSelect,
                          }
                        : {})}
                    >
                      {bar.title ? <title>{bar.title}</title> : null}
                    </rect>
                  ),
                )}
                {(row.marks ?? []).map((mark) => (
                  <text
                    key={mark.key}
                    x={x(mark.atMs)}
                    y={y + ROW - 2}
                    fontSize="7"
                    textAnchor="middle"
                    className={mark.state ?? FAINT}
                    fill="var(--state)"
                    {...(mark.onSelect
                      ? {
                          role: 'button',
                          'aria-label': mark.title,
                          style: { cursor: 'pointer' },
                          onClick: mark.onSelect,
                        }
                      : {})}
                  >
                    {mark.glyph}
                    {mark.title ? <title>{mark.title}</title> : null}
                  </text>
                ))}
              </g>
            );
          })}

          {onAxis(nowMs) ? (
            // The present on a live axis: open bars grow toward it on every
            // progress frame, with no new projection asked for (#32 gap 1).
            <line
              data-now-ms={Math.round(nowMs)}
              x1={x(nowMs)}
              y1={0}
              x2={x(nowMs)}
              y2={height}
              className="state-running"
              stroke="var(--state)"
              strokeWidth="1"
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          {onAxis(cursorMs) ? (
            <line
              data-cursor-ms={Math.round(cursorMs)}
              x1={x(cursorMs)}
              y1={AXIS}
              x2={x(cursorMs)}
              y2={height}
              stroke="var(--ink-muted)"
              strokeWidth="1"
              strokeDasharray="2 2"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        {below?.node}
      </div>
    </div>
  );
}

export default Swimlane;
