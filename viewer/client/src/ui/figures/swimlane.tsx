/**
 * Rows of bars on one shared time axis — the drawing, with none of the meaning.
 *
 * The caller says what a row IS and what a bar MEANS: the run's Gantt (a row
 * is a phase, a bar a boarding), its clock split (a row is one phase's own
 * clock, its bars that clock's parts) and Logs ▸ Timeline (six kinds of row).
 * This file says where the pixels go, and four rules hold for every caller,
 * because each is a claim the picture makes on its own:
 *
 *   - **an open bar is hatched**, never solid. "Ran for 40 minutes" and "has
 *     been running for 40 minutes so far" are different statements.
 *   - **the axis is the figures' axis.** Where a moment lands is `linear` over
 *     the window on show and which moments are labelled is `durationTicks` —
 *     round units, because a span divided by six gives labels like `10:23`,
 *     which nobody can line up against anything. No ratio or ladder of its own.
 *   - **the drawing is measured, never stretched.** The SVG is drawn at the
 *     width it is read at, so a tick label is the meta size it claims to be and
 *     a strip drawn below on the same window (the run's cost) lines up with the
 *     lanes to the pixel. Everything written in it — a tick, a moment's glyph —
 *     is the figures' one type size (`FIGURE_TYPE`), and every band and row is
 *     cut from that size (quiet-console phase 27: the glyphs were 8 and 9 px).
 *   - **a row's label is real text, outside the SVG.** An `<svg><text>` is not
 *     reachable with a keyboard, and some of these labels are buttons.
 *
 * The one thing this file will not do is name a colour. A bar carries a
 * `.state-*` class, that class sets `--state` (`styles/theme.css`), and every
 * dot, row and segment in the console paints through the same variable.
 * Naming the class is naming the state; the colour follows.
 */

import { useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react';

import { cn } from '@/lib/cn';

import {
  FIGURE_ASCENT,
  FIGURE_BAND,
  FIGURE_DESCENT,
  FIGURE_TYPE,
  inside,
  textWidth,
  useWidth,
} from './paint';
import { durationTicks, linear, type AxisWindow } from './scales';
import type { Figure } from './use-figure';

/**
 * Row geometry, in CSS pixels, cut from the figures' type (`./paint`): a row is
 * two lines of it — the bar, one line thick and centred, and the line under the
 * bar's edge that a moment's glyph hangs into. At 22 a 12.5 px glyph covered
 * half the bar it marks; at 28 it overlaps the bar's edge as the 8 px one did.
 */
export const ROW = 2 * (FIGURE_ASCENT + FIGURE_DESCENT);
export const BAR = ROW / 2;
/** A held stretch's rail — a third of a bar, still a mark against the track. */
export const RAIL = Math.round(BAR / 3);
/** The width a drawing assumes until it has been measured (and always, in jsdom). */
export const TRACK = 1000;
/** The band above the rows the tick labels sit in: one line of the figures' type. */
export const AXIS = FIGURE_BAND;

/**
 * The band under it that the run's own marks sit in, when it has any. In the
 * tick band a glyph sat ON a label — the run's start, at 0, on `0s`.
 */
const MARKS = FIGURE_BAND;

/** How far a tick's label sits from its line. */
const TICK_GAP = 3;

/**
 * Roughly how far apart two tick labels sit, so a phone's axis does not
 * collide: the widest the duration ladder writes, and two type sizes of air.
 */
const TICK_PITCH = textWidth('12h 30m') + 2 * FIGURE_TYPE;

/**
 * The ladder over `[0, spanMs]`, from the one axis primitive — re-exported by
 * this name because "does the axis label the time the journal says" is the
 * cheapest half of the timeline's promise to check, and checkable without an SVG.
 */
export { ticksFor } from './scales';

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
   * "activity" where two neutral hues alone could not (the Gantt's `down`).
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
   * The text beside the axis. A `ReactNode` rather than a string because some
   * of these are buttons, and a button drawn inside the SVG is not one.
   */
  label: ReactNode;
  /** The row's own sentence, for a reader who cannot see the bars. */
  ariaLabel: string;
  bars: SwimlaneBar[];
  marks?: SwimlaneMark[];
  /** Draw this row's empty track darker — the critical path, or the row a crosshair is on. */
  emphasis?: boolean;
};

const FAINT = '[--state:var(--ink-faint)]';

/**
 * A mark that does nothing is drawn, never touched: its glyph sits on a bar's
 * lower edge (the register measured a phase's start mark winning the corner of
 * the bar it starts), and a finger there means the bar. A pointer that can
 * hover keeps the glyph's title — a touch has no hover to show it with.
 */
const INERT = 'pointer-coarse:pointer-events-none';

export function Swimlane({
  rows,
  spanMs,
  ariaLabel,
  axisMarks = [],
  hatchId = 'pe-swimlane-open',
  tickLabel,
  labelWidth = '4.5rem',
  rowHeight = ROW,
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
  /**
   * A row's pitch in px. A caller whose labels are buttons passes the thumb
   * floor on touch, so a 44 px button never spills into the row below it.
   */
  rowHeight?: number;
  /** The part of the axis on show — a zoom. Absent ⇒ the whole span. */
  view?: AxisWindow;
  /** The present, on a live axis: a dashed line the bars grow toward. */
  nowMs?: number;
  /** Where the crosshair is, in ms. */
  cursorMs?: number | null;
  /**
   * The crosshair and zoom (`./use-figure`). Given, the track becomes one
   * `role="slider"` a keyboard can walk and a pinch can zoom, which keeps the
   * page's vertical scroll (`touch-action: pan-y`); absent, it is a static
   * drawing (Logs ▸ Timeline's rows carry buttons, and a button inside a
   * slider is a control nobody can reach).
   */
  figure?: Figure;
  /**
   * A strip drawn under the lanes on the same axis — the run's cost — with its
   * label for the label column and its height, so the two stay level.
   */
  below?: { node: ReactNode; label: ReactNode; height: number };
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box, TRACK);
  const [v0, v1] = view ?? [0, spanMs];
  const target = Math.max(2, Math.min(6, Math.floor(width / TICK_PITCH)));
  const ticks = useMemo(() => durationTicks([v0, v1], target), [v0, v1, target]);
  if (!rows.length) return null;

  const scale = linear([v0, v1], [0, width]);
  const x = (ms: number): number => (v1 > v0 ? scale(ms) : 0);
  const clampX = (px: number): number => Math.min(width, Math.max(0, px));
  const row = rowHeight;
  const bar = Math.round((BAR * row) / ROW);
  const rail = Math.round((RAIL * row) / ROW);
  // The rows start under the tick band, and under the marks' band when the run has marks of its own.
  const top = AXIS + (axisMarks.length ? MARKS : 0);
  const height = top + rows.length * row;
  const write = tickLabel ?? ((ms: number) => String(ms));
  const onAxis = (ms: number | null | undefined): ms is number => ms != null && ms >= v0 && ms <= v1;
  /** A glyph at `px`, held inside the drawing when its moment is at an edge rather than cut in half by it. */
  const glyphAt = (px: number) =>
    px >= 0 && px <= width ? inside(px, FIGURE_TYPE, width) : { textAnchor: 'middle' as const, dx: 0 };

  // Each tick's label, placed: from its line, or read back from it where it
  // would run off the far edge — and one that would touch the label before it
  // is not written (its line still is), so a narrow axis thins rather than
  // overprints.
  let reach = -Infinity;
  const labels = ticks.map((at) => {
    const px = x(at);
    const text = write(at);
    const wide = textWidth(text);
    const end = px + TICK_GAP + wide > width;
    const from = end ? px - TICK_GAP - wide : px + TICK_GAP;
    const shown = from >= reach;
    if (shown) reach = from + wide + FIGURE_TYPE / 2;
    return { at, px, text, end, shown };
  });

  // A bar or a mark that does something is a control. On a static drawing a
  // keyboard reaches it — Tab to it, Enter or Space presses it, as a button —
  // and the drawing is then a GROUP of them, because an image's children are
  // presentational and a button inside one is announced as nothing (axe:
  // `nested-interactive`). With `figure` the track is the one slider and its
  // walk owns the keyboard, so a bar there stays a pointer's target alone.
  const controls =
    !figure &&
    (axisMarks.some((mark) => mark.onSelect) ||
      rows.some(
        (one) => one.bars.some((span) => span.onSelect) || (one.marks ?? []).some((mark) => mark.onSelect),
      ));
  const drawing = controls ? 'group' : 'img';
  const pressable = (name: string | undefined, onSelect: () => void) => ({
    role: 'button',
    // An SVG `<title>` child is a tooltip, not an accessible NAME for an ARIA
    // role — axe's `aria-command-name` is the rule, and a bar a screen reader
    // announces as "button" and nothing else is a button nobody can use. The
    // name is the same sentence the pointer gets.
    'aria-label': name,
    style: { cursor: 'pointer' },
    onClick: onSelect,
    ...(controls
      ? {
          tabIndex: 0,
          onKeyDown: (event: KeyboardEvent<SVGElement>) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            onSelect();
          },
        }
      : {}),
  });

  return (
    <div
      className={cn('grid gap-x-2', className)}
      style={{ gridTemplateColumns: `${labelWidth} minmax(0,1fr)` }}
    >
      {/* Outside the SVG so the labels stay real text — see the file lead —
          at the drawing's own pitch, so each sits level with its row. */}
      <div className="flex min-w-0 flex-col">
        <ol className="flex flex-col" style={{ paddingTop: top }}>
          {rows.map((one) => (
            <li key={one.key} className="flex min-w-0 items-center gap-1" style={{ height: row }}>
              {one.label}
            </li>
          ))}
        </ol>
        {below ? (
          <div className="flex items-center" style={{ height: below.height }}>
            {below.label}
          </div>
        ) : null}
      </div>

      <div
        {...(figure ? { ...figure.sliderProps, ...figure.surfaceProps } : {})}
        className={cn('min-w-0', figure && 'select-none rounded-sm')}
      >
        <div ref={box}>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            // Until the first measure (and in jsdom) the assumed width is
            // stretched to the real one rather than shrunk inside it, so the rows
            // stay level with their labels; once measured, nothing is stretched.
            preserveAspectRatio="none"
            height={height}
            className="block w-full overflow-hidden"
            role={drawing}
            aria-label={ariaLabel}
          >
            <defs>
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

            {labels.map(({ at, px, text, end, shown }) => (
              <g key={at}>
                <line
                  x1={px}
                  y1={AXIS}
                  x2={px}
                  y2={height}
                  stroke="var(--rule)"
                  strokeWidth="0.5"
                  vectorEffect="non-scaling-stroke"
                />
                {shown ? (
                  <text
                    data-tick={at}
                    x={end ? px - TICK_GAP : px + TICK_GAP}
                    y={AXIS - FIGURE_DESCENT}
                    textAnchor={end ? 'end' : 'start'}
                    fontSize={FIGURE_TYPE}
                    className="tnum"
                    fill="var(--ink-faint)"
                  >
                    {text}
                  </text>
                ) : null}
              </g>
            ))}

            {axisMarks.map((mark) => {
              const px = x(mark.atMs);
              return (
                <text
                  key={mark.key}
                  x={px}
                  y={AXIS + MARKS - FIGURE_DESCENT}
                  fontSize={FIGURE_TYPE}
                  {...glyphAt(px)}
                  className={cn(mark.state ?? '[--state:var(--ink-muted)]', !mark.onSelect && INERT)}
                  fill="var(--state)"
                  {...(mark.onSelect ? pressable(mark.title, mark.onSelect) : {})}
                >
                  {mark.glyph}
                  {mark.title ? <title>{mark.title}</title> : null}
                </text>
              );
            })}

            {rows.map((one, index) => {
              const y = top + index * row;
              return (
                <g key={one.key} role={drawing} aria-label={one.ariaLabel}>
                  {/* The row's own track, so an empty stretch reads as a gap in
                      THIS row rather than as page background. */}
                  <rect
                    x={0}
                    y={y + (row - bar) / 2}
                    width={width}
                    height={bar}
                    fill="var(--ground-deep)"
                    opacity={one.emphasis ? 0.9 : 0.5}
                    rx="2"
                  />
                  {one.bars.map((span) =>
                    span.endMs < v0 || span.startMs > v1 ? null : (
                      <rect
                        key={span.key}
                        x={clampX(x(span.startMs))}
                        y={y + (row - (span.rail ? rail : bar)) / 2}
                        width={Math.max(1.5, clampX(x(span.endMs)) - clampX(x(span.startMs)))}
                        height={span.rail ? rail : bar}
                        rx={span.rail ? '1' : '2'}
                        className={span.state}
                        fill={span.open ? `url(#${hatchId})` : 'var(--state)'}
                        // The open-bar hatch paints in `currentColor`, so the state
                        // has to reach it as a colour too.
                        color="var(--state)"
                        stroke={span.outlined ? 'var(--action)' : 'none'}
                        strokeWidth={span.outlined ? 1 : 0}
                        vectorEffect="non-scaling-stroke"
                        {...(span.onSelect ? pressable(span.title, span.onSelect) : {})}
                      >
                        {span.title ? <title>{span.title}</title> : null}
                      </rect>
                    ),
                  )}
                  {(one.marks ?? []).map((mark) => {
                    const px = x(mark.atMs);
                    return (
                      // Hung from the bar's lower edge into the row's second
                      // line, so the glyph marks the bar without hiding it.
                      <text
                        key={mark.key}
                        x={px}
                        y={y + row - 2}
                        fontSize={FIGURE_TYPE}
                        {...glyphAt(px)}
                        className={cn(mark.state ?? FAINT, !mark.onSelect && INERT)}
                        fill="var(--state)"
                        {...(mark.onSelect ? pressable(mark.title, mark.onSelect) : {})}
                      >
                        {mark.glyph}
                        {mark.title ? <title>{mark.title}</title> : null}
                      </text>
                    );
                  })}
                </g>
              );
            })}

            {onAxis(nowMs) ? (
              // The present on a live axis: open bars grow toward it on every
              // progress frame, with no new projection asked for.
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
        </div>
        {below?.node}
      </div>
    </div>
  );
}

export default Swimlane;
