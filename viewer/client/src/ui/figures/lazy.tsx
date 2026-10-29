/**
 * The figures — their names, their numbers, and the one door to their drawings
 * (control-tower phase 29; the 7.0 tree's since quiet-console phase 19).
 *
 * **Two kinds of chart, and the difference decides what each owes.** A FIGURE
 * is a block that carries its own data: the only thing in its card, its rows
 * nowhere else on the screen, and a reader who cannot see it — a screen
 * reader, a phone with no hover — has no other way to the numbers. So every
 * figure here ships its numbers (`FigureNumbers`): a fold, then the table it
 * was drawn from, built in rather than offered, because a call site that can
 * forget will. A MARK is one datum of a row, whose row is its table; the line
 * draws it (`ui/track/meter.tsx`). `FIGURES` and `MARKS` are that split written
 * down, and `figures.test.tsx` holds it closed against this module's own
 * exports, so a new chart has to say which kind it is.
 *
 * **The door.** The drawings are visx — a crosshair, a zoom and keyboard reach
 * are axis work (design.md §8.2) — and the pages that draw a figure are pages
 * every operator opens, so a static import of a drawing would put visx in
 * their first load. This file is the ONLY one that reaches `./bars` and
 * `./run-chart`, each through `import()`, and `scripts/check-dist.mjs` asserts
 * both chunks stay lazy — no static importer, never modulepreloaded — finding
 * them by the `data-figure` they spell. Two things it does that a bare
 * `lazy()` would not:
 *
 *   - **A loaded chunk renders synchronously.** Once a chunk has arrived, a
 *     figure mounted later draws in its first render instead of flashing a
 *     placeholder — the second figure on a page never waits.
 *   - **A figure keeps the path it mounted with.** Switching a mounted figure
 *     from the `Suspense` path to the direct one would remount its drawing and
 *     drop its zoom, its crosshair and its keyboard focus, so the choice is
 *     made once.
 *
 * The placeholder has the drawing's height, so the numbers folded under a
 * figure do not jump when the picture arrives.
 *
 * **Paint is a state.** A figure's tone is one of the eight UI states, by name
 * (`FigureTone`), and the drawings paint it through `.state-<tone>` and
 * `var(--state)` — the indirection every dot, station and segment uses — so a
 * figure cannot be given a colour the design system does not have.
 */

import {
  createElement,
  lazy,
  Suspense,
  useMemo,
  useState,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from 'react';
import type { UiState } from '@shared/status-vocab.js';
import { cn } from '@/lib/cn';
import { useNarrow } from '@/lib/media';
import { Legend } from '@/ui/legend';

import { FigureNumbers } from './numbers';
import { seriesHeight } from './paint';

/**
 * The figures — a block with its own data, which therefore owes its numbers.
 * Closed on purpose: a chart added here is a name in one of these two lists,
 * and the test then requires a figure to render its table.
 */
export const FIGURES = Object.freeze(['Bars', 'Calendar', 'BarList', 'StackBar', 'Series'] as const);
export type FigureName = (typeof FIGURES)[number];

/** The marks — one datum of a row, drawn on the line's tokens (`ui/track/meter.tsx`). */
export const MARKS = Object.freeze(['LoadMeter'] as const);

/**
 * The only paints a figure may use: the eight UI states, by name. Every chart
 * on a page is counting things in some state, so a bar's paint and a dot's
 * paint mean the same thing on the same screen.
 */
export type FigureTone = UiState;

export interface BarPoint {
  week: string;
  count: number;
}

export interface CalendarDay {
  date: string;
  count: number;
}

/** One day of a `Calendar`: where it sits (week column, weekday row) and how full it is. */
export interface CalendarCell {
  date: string;
  count: number;
  week: number;
  day: number;
  intensity: number;
}

/**
 * The cells of a `span`-week calendar ending today, oldest first — built here,
 * beside the table, so the numbers under the figure and the squares in it are
 * the same days by construction.
 *
 * ⚠️ `today` is read once per build rather than per cell: building 180 cells
 * each of which asks the clock is how a chart ends up straddling midnight.
 */
export function calendarCells(data: readonly CalendarDay[], span: number): CalendarCell[] {
  const byDate = new Map(data.map((d) => [d.date, d.count]));
  const max = Math.max(1, ...data.map((d) => d.count));
  const today = new Date();
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - span * 7 - start.getUTCDay());
  const out: CalendarCell[] = [];
  for (let week = 0; week <= span; week++) {
    for (let day = 0; day < 7; day++) {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + week * 7 + day);
      if (date > today) continue;
      const key = date.toISOString().slice(0, 10);
      const count = byDate.get(key) ?? 0;
      out.push({ date: key, count, week, day, intensity: count ? 0.25 + (count / max) * 0.75 : 0 });
    }
  }
  return out;
}

export interface BarListItem {
  name: string;
  value: number;
}

/**
 * One part of a `StackBar`. `tone` is a state name rather than a colour, which
 * is what makes the key and the bar unable to disagree: both read the same
 * token from the same place.
 */
export interface StackSegment {
  label: string;
  value: number;
  tone: FigureTone;
}

/** One bucket of a `Series`' time axis, as the ledger cut it (UTC instants). */
export interface SeriesBucket {
  start: string;
  end: string;
}

/** One strip of a `Series`: what it is, and one value per bucket, in the buckets' order. */
export interface SeriesRow {
  name: string;
  values: readonly number[];
}

/* ------------------------------------------------------------------ *
 * The door
 * ------------------------------------------------------------------ */

type BarDrawings = typeof import('./bars');
type RunFigures = typeof import('./run-chart');

let bars: BarDrawings | null = null;
let runChart: RunFigures | null = null;
let barsPending: Promise<BarDrawings> | null = null;
let runChartPending: Promise<RunFigures> | null = null;
let bothPending: Promise<unknown> | null = null;

function loadBars(): Promise<BarDrawings> {
  barsPending ??= import('./bars').then((drawings) => {
    bars = drawings;
    return drawings;
  });
  return barsPending;
}

function loadRunChart(): Promise<RunFigures> {
  runChartPending ??= import('./run-chart').then((drawings) => {
    runChart = drawings;
    return drawings;
  });
  return runChartPending;
}

/**
 * Fetch both chunks once — the four figures' drawings and the run's cost strip
 * — so a caller that preloads "the figures" (the test setup) gets every
 * drawing. A figure on its own fetches only its own chunk. Safe to call often.
 */
export function loadFigures(): Promise<unknown> {
  bothPending ??= Promise.all([loadBars(), loadRunChart()]);
  return bothPending;
}

/**
 * A drawing behind the door: the direct path once its chunk has arrived, the
 * `Suspense` path (a placeholder of the drawing's height) before it — chosen
 * by each mount's first render and kept (see the file lead).
 */
function behindTheDoor<Drawings, Props extends object>(
  name: string,
  load: () => Promise<Drawings>,
  loaded: () => Drawings | null,
  pick: (drawings: Drawings) => ComponentType<Props>,
  height: (props: Props) => number,
) {
  const Deferred = lazy(() => load().then((drawings) => ({ default: pick(drawings) })));
  function Drawing(props: Props) {
    const [direct] = useState(() => loaded() !== null);
    const drawings = loaded();
    if (direct && drawings) return createElement(pick(drawings), props);
    return (
      <Suspense
        fallback={
          <div aria-busy="true" className="rounded-sm bg-track/40" style={{ height: height(props) }} />
        }
      >
        {createElement(Deferred, props)}
      </Suspense>
    );
  }
  Drawing.displayName = `Lazy(${name})`;
  return Drawing;
}

/** The line under every drawing — the readout and the way back from a zoom — in px. */
const LINE = 28;

const LazyBars = behindTheDoor(
  'Bars',
  loadBars,
  () => bars,
  (drawings) => drawings.BarsDrawing,
  (props) => props.height + LINE,
);
const LazyCalendar = behindTheDoor(
  'Calendar',
  loadBars,
  () => bars,
  (drawings) => drawings.CalendarDrawing,
  () => 86 + LINE,
);
const LazyBarList = behindTheDoor(
  'BarList',
  loadBars,
  () => bars,
  (drawings) => drawings.BarListDrawing,
  (props) => props.items.length * 22 + LINE,
);
const LazyStackBar = behindTheDoor(
  'StackBar',
  loadBars,
  () => bars,
  (drawings) => drawings.StackBarDrawing,
  () => 10 + LINE,
);
const LazySeries = behindTheDoor(
  'Series',
  loadBars,
  () => bars,
  (drawings) => drawings.SeriesDrawing,
  (props) => seriesHeight(props.rows.length) + LINE,
);
const LazyRunCost = behindTheDoor(
  'RunCost',
  loadRunChart,
  () => runChart,
  (drawings) => drawings.RunCostChart,
  (props) => props.height,
);

/* ------------------------------------------------------------------ *
 * Bars — weekly completions
 * ------------------------------------------------------------------ */

/**
 * Weekly completions on a count axis. The current week is drawn apart, in the
 * action's ink, because it is the only bar still being written.
 */
export function Bars({
  data,
  height = 92,
  label = 'completions',
}: {
  data: readonly BarPoint[];
  height?: number;
  /** What one bar counts, plural and lower case — "phases". */
  label?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <LazyBars data={data} height={height} label={label} />
      <FigureNumbers
        label="weeks"
        caption={`${label} per week, the numbers behind the figure`}
        rows={data}
        getRowKey={(point, i) => point.week ?? String(i)}
        columns={[
          { head: 'Week', cell: (point) => <span className="tnum">{point.week}</span> },
          { head: label, cell: (point) => point.count, align: 'end' },
        ]}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Calendar — completions by day, one square per day
 * ------------------------------------------------------------------ */

/**
 * Half the range on a phone: 26 weeks across 358 px is a 12 px square, and 13
 * doubles it. It is a display rather than a control, so the squares are
 * deliberately not thumb-sized (26 of those would be 1144 px wide) — the
 * readout under it, which a tap or a key answers, is what makes it legible
 * without one.
 */
export function Calendar({ data, weeks = 26 }: { data: readonly CalendarDay[]; weeks?: number }) {
  const narrow = useNarrow();
  const span = narrow ? Math.min(weeks, 13) : weeks;
  const cells = useMemo(() => calendarCells(data, span), [data, span]);
  // Only the days something landed on. A window of squares is ~180 rows of
  // which most are zero, and a table whose every other row says `0` buries the
  // answer it exists to give — the empty squares ARE the absence, and the note
  // says how many there were.
  const days = useMemo(() => cells.filter((cell) => cell.count > 0), [cells]);

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <LazyCalendar cells={cells} span={span} />
      <FigureNumbers
        label="days with a completion"
        caption={`Phase completions by day over the last ${span} weeks`}
        rows={days}
        getRowKey={(cell) => cell.date}
        columns={[
          { head: 'Day', cell: (cell) => <span className="tnum">{cell.date}</span> },
          { head: 'Phases', cell: (cell) => cell.count, align: 'end' },
        ]}
        note={`${cells.length} days in the window; the rest completed nothing.`}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * BarList — ranked rows on a value axis
 * ------------------------------------------------------------------ */

/** Repos, skills, models, days of spend — anything ranked by a number. */
export function BarList({
  items,
  unit = '',
  format,
  tone = 'running',
  label,
  heads,
  empty,
  className,
}: {
  items: readonly BarListItem[];
  /** Written after every value when there is no `format` — " USD". */
  unit?: string;
  /** A value as the page writes it. Wins over `unit`, in the drawing, the readout and the numbers alike. */
  format?: (value: number) => string;
  tone?: FigureTone;
  /** What one row IS, plural and lower case — names the numbers fold and its table. */
  label?: string;
  /**
   * The numbers table's column heads, from the caller who knows what a row is
   * (#339): a list of days heads its first column Day, not Name. Each defaults
   * to Name and Value; Share is always a share.
   */
  heads?: { name?: string; value?: string };
  /** The one line drawn when there is nothing to rank. */
  empty?: ReactNode;
  className?: string;
}) {
  if (!items.length) {
    return (
      <div className={cn('text-meta text-ink-muted', className)}>{empty ?? 'Nothing recorded yet.'}</div>
    );
  }
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const valueText = (value: number) => (format ? format(value) : `${value}${unit}`);

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <LazyBarList items={items} tone={tone} valueText={valueText} />
      {/* Two things the ranked bars cannot say: the name in full — the rows
          truncate, and four plan slugs sharing a dated prefix truncate to the
          same few characters — and each row's share of the whole, which is the
          question a ranking invites and never answers. */}
      <FigureNumbers
        label={label ? `${label}, in full` : 'rows, in full'}
        caption={
          label ? `${label}, with each row's share of the total` : 'Every row, with its share of the total'
        }
        rows={items}
        getRowKey={(item) => item.name}
        columns={[
          { head: heads?.name ?? 'Name', cell: (item) => <span className="break-words">{item.name}</span> },
          { head: heads?.value ?? 'Value', cell: (item) => valueText(item.value), align: 'end' },
          {
            head: 'Share',
            cell: (item) => (total ? `${Math.round((item.value / total) * 100)}%` : '—'),
            align: 'end',
          },
        ]}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * StackBar — a proportional stack with its key
 * ------------------------------------------------------------------ */

/** The size mix, the status split: one whole, in parts, with the kit's key under it. */
export function StackBar({ segments, label }: { segments: readonly StackSegment[]; label?: string }) {
  const sum = segments.reduce((running, segment) => running + segment.value, 0);
  // The divisor, never zero. `sum` stays honest for the share column: an
  // all-empty stack is 0 of 0, not 0 of 1, and "—" is the truthful share.
  const total = sum || 1;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <LazyStackBar segments={segments} />
      {/* The key draws each segment's own paint, through the same
          `.state-<tone>` the bar wears, so the two cannot disagree. */}
      <Legend
        entries={segments.map((segment) => ({
          key: segment.label,
          label: segment.label,
          paint: segment.tone,
          count: segment.value,
        }))}
      />
      {/* The key gives the counts; only the table gives the proportions, which
          is the entire reason a stack was drawn instead of a list. A 2 px
          segment and a 3 px segment are the same segment to the eye. */}
      <FigureNumbers
        label={label ? `${label} as numbers` : 'segments as numbers'}
        caption={label ? `${label}, by count and share` : 'Every segment, by count and share'}
        rows={segments}
        getRowKey={(segment) => segment.label}
        columns={[
          { head: 'Segment', cell: (segment) => segment.label },
          { head: 'Count', cell: (segment) => segment.value, align: 'end' },
          {
            head: 'Share',
            cell: (segment) => (sum ? `${Math.round((segment.value / total) * 100)}%` : '—'),
            align: 'end',
          },
        ]}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Series — small multiples on one time axis
 * ------------------------------------------------------------------ */

/**
 * A value over time for each of a few rows — what each account spent, bucket
 * by bucket. A strip per row on one shared scale and one crosshair, never a
 * stack of colours: the row is named in words, and its strip is the one paint.
 * The numbers are the buckets as rows and the strips as columns, with a total.
 */
export function Series({
  buckets,
  rows,
  format,
  timeText,
  label,
  heads,
  tone = 'running',
  empty,
  summed = true,
}: {
  buckets: readonly SeriesBucket[];
  rows: readonly SeriesRow[];
  /** A value as the page writes it, in the drawing, the readout and the numbers alike. */
  format: (value: number) => string;
  /** A bucket's start as a person reads it — the axis, the readout and the numbers' first column. */
  timeText: (start: string) => string;
  /** What the figure shows, as a sentence's subject — "Spend over time, by account". */
  label: string;
  /** The numbers' first column's head — "Time (UTC)". */
  heads?: { time?: string };
  tone?: FigureTone;
  /** The one line drawn when no row has a value. */
  empty?: ReactNode;
  /**
   * Whether the values add up (dollars, tokens). A rate, a load or a delta does not, and gets no
   * total: its strip is named with its newest value, and the numbers carry no Total column.
   */
  summed?: boolean;
}) {
  const nonZero = rows.some((row) => row.values.some((value) => value > 0));
  if (!buckets.length || !rows.length || !nonZero) {
    return <div className="text-meta text-ink-muted">{empty ?? 'Nothing recorded yet.'}</div>;
  }
  const kept = buckets
    .map((bucket, i) => ({ bucket, i, total: rows.reduce((sum, row) => sum + (row.values[i] ?? 0), 0) }))
    .filter((point) => point.total > 0);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <LazySeries
        buckets={buckets}
        rows={rows}
        tone={tone}
        valueText={format}
        timeText={timeText}
        label={label}
        summed={summed}
      />
      {/* Only the buckets something was spent in: a day of five-minute bars is
          288 rows of which most are nothing, and the empty columns ARE the
          absence. */}
      <FigureNumbers
        label="buckets with a value"
        caption={`${label}: each bucket with a value, by row`}
        rows={kept}
        getRowKey={(point) => point.bucket.start || String(point.i)}
        columns={[
          {
            head: heads?.time ?? 'Time',
            cell: (point) => <span className="tnum">{timeText(point.bucket.start)}</span>,
          },
          ...rows.map((row) => ({
            head: row.name,
            cell: (point: (typeof kept)[number]) => format(row.values[point.i] ?? 0),
            align: 'end' as const,
          })),
          ...(summed && rows.length > 1
            ? [
                {
                  head: 'Total',
                  cell: (point: (typeof kept)[number]) => format(point.total),
                  align: 'end' as const,
                },
              ]
            : []),
        ]}
        note={`${buckets.length} buckets in the window; the rest held nothing.`}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The run's cost strip
 * ------------------------------------------------------------------ */

/**
 * What each attempt cost, on the lanes' own window — `RunCostChart`, behind
 * the door. Its numbers are the Gantt's fold, not its own: it is a second
 * reading drawn under the lanes, on their axis and their crosshair.
 */
export function RunCostFigure(props: ComponentProps<RunFigures['RunCostChart']>) {
  return <LazyRunCost {...props} />;
}
