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

import { cn } from '@/lib/cn';

/** Row geometry, in the SVG's own units. The viewBox does the scaling. */
export const ROW = 22;
export const BAR = 11;
export const TRACK = 1000;
export const AXIS = 16;

/**
 * Tick every 1, 2, 5 … of a sane unit, aiming for six or so labels.
 *
 * Exported because "does the axis label the time the journal says" is the
 * cheapest half of the timeline's exit criterion to check, and it should be
 * checkable without rendering an SVG.
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
  className?: string;
}) {
  const ticks = useMemo(() => ticksFor(spanMs), [spanMs]);
  if (!rows.length) return null;

  const x = (ms: number): number => (spanMs > 0 ? (ms / spanMs) * TRACK : 0);
  const height = AXIS + rows.length * ROW;
  const write = tickLabel ?? ((ms: number) => String(ms));

  return (
    <div className={cn('grid gap-x-2', className)} style={{ gridTemplateColumns: `${labelWidth} 1fr` }}>
      {/* Outside the SVG so the labels stay real text — see the file lead. */}
      <ol className="flex flex-col" style={{ paddingTop: `${(AXIS / height) * 100}%` }}>
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
              {row.bars.map((bar) => (
                <rect
                  key={bar.key}
                  x={x(bar.startMs)}
                  y={y + (ROW - BAR) / 2}
                  width={Math.max(1.5, x(bar.endMs) - x(bar.startMs))}
                  height={BAR}
                  rx="2"
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
              ))}
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
      </svg>
    </div>
  );
}

export default Swimlane;
