/**
 * Seven hand-drawn charts. One accent hue per meaning, tabular figures, no
 * decoration that does not carry data.
 *
 * Ported from `web/components/charts.js` — restyled, not redesigned. The
 * geometry is unchanged; what changed is that **every colour is a token**.
 * The old versions took a `color` string per segment and the call sites passed
 * `var(--line-done)` by hand, which meant a chart could be given a raw hex and
 * nothing would notice. Here the palette is a closed set of state names and the
 * component resolves them, so a chart cannot be painted a colour the design
 * system does not have. `charts.test.tsx` asserts that.
 *
 * No chart library. These are seven shapes totalling ~300 lines; the smallest
 * charting dependency is larger than the whole plan surface's chunk, and it
 * would arrive with its own colour vocabulary to fight.
 *
 * **The seven are two kinds, and the difference decides what each one owes.**
 *
 * A **figure** is a block that carries its own data: it is the only thing in
 * its card, its rows exist nowhere else on the screen, and a reader who cannot
 * see it — a screen reader, a phone with no hover — has no other way to the
 * numbers. So every figure ships `ChartNumbers`: a fold, then the table it was
 * drawn from. That is the disclosure ladder's L3 for a picture, and it is built
 * in rather than offered, because a call site that can forget will.
 *
 * A **mark** is one datum of a row, drawn: a session load in a fleet cell, a
 * plan's shape in a list row. Its data is the row it sits in, already spelled
 * out in the cells beside it — a table under a mark would be the same numbers a
 * third time, and it cannot even be built, since a mark renders inside a
 * `<span>` or a `<td>` where a `<table>` is invalid.
 *
 * `CHART_FIGURES` / `CHART_MARKS` below are that split, written down;
 * `charts.test.tsx` holds the inventory closed against this module's own export
 * surface, so a new chart has to say which kind it is — or be written down there
 * as one of the named non-charts — and a figure cannot quietly ship without its
 * numbers.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { useNarrow } from '@/lib/media';
import { cn } from '@/lib/cn';
import { Disclosure } from '@/components/ui/disclosure';
import { Legend, stateEntries, stateTally, type LegendCounts } from '@/components/ui/legend';
import { useTableFit } from '@/components/ui/table';
import { UI_STATES, boardUiState, phaseUiState, type UiState } from '@/lib/status-vocab';

/**
 * The only colours a chart may use: the eight UI states of the status
 * vocabulary, by name.
 *
 * Deliberately the *state* palette rather than a decorative one: every chart on
 * the statistics page is counting phases in some state, so a bar's colour and a
 * badge's colour mean the same thing on the same screen.
 */
export const CHART_TONES = UI_STATES;

export type ChartTone = UiState;

/**
 * The figures — a block with its own data, which therefore owes a table.
 *
 * Closed on purpose (`charts.test.tsx`): adding a chart to this file means
 * adding its name to one of these two lists, and the test then requires a
 * figure to render its numbers. The alternative — a convention in a comment —
 * is how six of the seven came to have a `<title>` tooltip and one did not.
 */
export const CHART_FIGURES = Object.freeze(['Bars', 'Calendar', 'BarList', 'StackBar'] as const);

/** The marks — one datum of a row, drawn. The row beside it is its table. */
export const CHART_MARKS = Object.freeze(['LoadMeter', 'RouteStrip', 'RunStrip'] as const);

/** A tone name → the CSS custom property that holds it. Nothing else is legal. */
export const toneVar = (tone: ChartTone): string => `var(--status-${tone})`;

/* ------------------------------------------------------------------ *
 * The numbers under a chart — every figure's L3
 * ------------------------------------------------------------------ */

/**
 * A chart is a reading of its data, and the reading is lossy on purpose: a
 * 26-week bar chart answers *is this speeding up* in one glance and cannot
 * answer *how many landed in week 31*. The disclosure ladder's rule is that
 * every fold carries its own way back, and for a figure the way back is the
 * table it was drawn from — the L3 of a chart is its data.
 *
 * Three reasons it is built INTO the chart rather than offered at the call
 * site. A call site can forget, and the one that forgets is the one nobody
 * checks. A chart's rows are already in its hands, so a call site table would
 * be the same numbers derived twice, free to drift from the picture above it.
 * And it is the only honest answer for the two readings SVG cannot give: a
 * screen reader gets `aria-label` and a shape, and a phone has no hover at all
 * — the `<title>` tooltips below are a pointer's affordance and nothing else.
 */
export interface ChartColumn<T> {
  head: string;
  cell: (row: T) => ReactNode;
  align?: 'start' | 'end';
}

export function ChartNumbers<T>({
  label,
  caption,
  columns,
  rows,
  getRowKey,
  note,
  className,
}: {
  /** What one row IS, plural and lower case — "weeks", "days with a completion". */
  label: string;
  /** The table's accessible name: a whole sentence naming what was charted. */
  caption: string;
  columns: ChartColumn<T>[];
  rows: T[];
  getRowKey: (row: T, index: number) => string;
  /** Anything the table cannot say about itself — a bound, an exclusion. */
  note?: ReactNode;
  className?: string;
}) {
  const { wrapRef, tableRef, overflows, measured } = useTableFit();
  // Nothing charted, nothing to tabulate. The chart's own empty state is the
  // message; a fold labelled "(0)" is an invitation to a blank table.
  if (!rows.length) return null;
  const scrolls = overflows || !measured;

  return (
    <Disclosure
      label={`The ${label}`}
      openLabel={`Hide the ${label}`}
      count={rows.length}
      className={cn('mt-2', className)}
    >
      {/* Bounded and scrollable: a year of completions is 180 rows, and a fold
          that pushes the next card off the screen is worse than the picture it
          explains. `tabIndex` because a scrollable region that only a mouse can
          reach is one nobody using a keyboard can read to the end.

          The height cap is `[@media(hover:hover)]`, not unconditional, and that
          is the same rule `components/ui/table.tsx` states for `TableWrap`: a
          height-capped box is a second VERTICAL scroller, and on a touch device
          it swallows the flick meant for the page. A quarter of a phone's
          height is a trap you escape by finding the few pixels beside it. Where
          there is a pointer there is a wheel and a scrollbar, and the cap earns
          its keep; where there is not, the fold was opened deliberately and the
          page can carry it.

          And the horizontal scroller is MEASURED, exactly the way `TableWrap`
          measures its own. It used to be unconditional, and that quietly took
          the sticky head away on touch: a box with one axis set to anything but
          `visible` computes the other axis to `auto` too, so `overflow-x-auto`
          alone still made this div a scroll container on both axes — `sticky
          top-0` then bound to IT, and with no height cap its scrollport is
          exactly its content, so the head never engaged. Gated, the common case
          on a phone is a table that fits: no scroll container, and the head
          binds to `<main>`, which is the shell's one scroller. A table that
          genuinely is wider than the box still scrolls sideways and still has
          an inert sticky head — the same trade every scrolling table here
          makes, and the reason `DataTable` measures rather than assumes. */}
      <div
        ref={wrapRef}
        className={cn(
          'mt-1.5 rounded border border-rule',
          scrolls && 'overflow-x-auto overscroll-x-contain',
          '[@media(hover:hover)]:max-h-64 [@media(hover:hover)]:overflow-y-auto',
        )}
        tabIndex={0}
        role="group"
        aria-label={caption}
      >
        {/* hand-rolled because: it is the numbers BEHIND a chart, not a record
            list. Its columns come from the chart's own series, it has no
            identity column to pin and no record to fold into a card — a
            `CardList` of eighteen dates would be the fold's whole point
            inverted. What it does take from the primitive is the ban above. */}
        <table ref={tableRef} className="w-full border-collapse text-2xs">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.head}
                  scope="col"
                  className={cn(
                    // Sticky so the heads survive the scroll above — on `--surface`
                    // rather than transparent, or the rows read through them.
                    // It binds to the nearest scrollport: the capped box where
                    // there is a pointer, and `<main>` on a phone, where the
                    // wrapper only becomes a scroll container if the table
                    // genuinely does not fit (see the note on the wrapper).
                    'sticky top-0 z-1 bg-surface px-2 py-1 font-medium text-ink-muted',
                    'border-b border-rule',
                    column.align === 'end' ? 'text-right' : 'text-left',
                  )}
                >
                  {column.head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={getRowKey(row, index)} className="border-b border-rule/60 last:border-b-0">
                {columns.map((column) => (
                  <td
                    key={column.head}
                    className={cn(
                      'px-2 py-1 text-ink',
                      column.align === 'end' ? 'tnum text-right font-mono' : 'text-left',
                    )}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note && <p className="mt-1 text-2xs text-ink-faint">{note}</p>}
    </Disclosure>
  );
}

/* ------------------------------------------------------------------ *
 * Bars — weekly completions
 * ------------------------------------------------------------------ */

export interface BarPoint {
  week: string;
  count: number;
}

/**
 * Weekly completions. The current week is amber, because it is the only bar
 * that is still being written.
 */
export function Bars({
  data,
  height = 92,
  label = 'completions',
}: {
  data: BarPoint[];
  height?: number;
  label?: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.count));
  const width = 100;
  const gap = 1.2;
  const barWidth = Math.max(0.8, width / Math.max(1, data.length) - gap);

  const chart = (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      height={height}
      className="w-full"
      role="img"
      aria-label={`${label} per week`}
    >
      {data.map((point, i) => {
        const barHeight = (point.count / max) * (height - 14);
        const current = i === data.length - 1;
        return (
          <rect
            key={point.week ?? i}
            x={i * (barWidth + gap)}
            y={height - 12 - barHeight}
            width={barWidth}
            height={Math.max(point.count ? 1.5 : 0, barHeight)}
            rx="0.6"
            fill={current ? 'var(--action)' : toneVar('running')}
            opacity={current ? 1 : 0.75}
          >
            <title>{`${point.week}: ${point.count} ${label}`}</title>
          </rect>
        );
      })}
      <line
        x1="0"
        y1={height - 11}
        x2={width}
        y2={height - 11}
        stroke="var(--rule)"
        strokeWidth="0.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );

  return (
    <>
      {chart}
      <ChartNumbers
        label="weeks"
        caption={`${label} per week, the numbers behind the chart`}
        rows={data}
        getRowKey={(point, i) => point.week ?? String(i)}
        columns={[
          { head: 'Week', cell: (point) => <span className="font-mono">{point.week}</span> },
          { head: label, cell: (point) => point.count, align: 'end' },
        ]}
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Calendar — a year of completions, one square per day
 * ------------------------------------------------------------------ */

export interface CalendarDay {
  date: string;
  count: number;
}

/**
 * Half the range on a phone.
 *
 * 26 weeks across 358px is a 12px square, and the readout under it used to be
 * `onMouseEnter`-only — so on a phone the whole chart was a texture with no way
 * to ask it anything. 13 weeks doubles the square and a tap answers. It is a
 * display rather than a control, so the squares are deliberately not 44px
 * (26 of those would be 1144px wide) — the readout below is what makes it
 * legible without one.
 *
 * ⚠️ `today` is read once per render rather than per cell: building 180 cells
 * each of which asks the clock is how a chart ends up straddling midnight.
 */
export function Calendar({ data, weeks = 26 }: { data: CalendarDay[]; weeks?: number }) {
  const [picked, setPicked] = useState<CalendarDay | null>(null);
  const narrow = useNarrow();
  const span = narrow ? Math.min(weeks, 13) : weeks;

  const cells = useMemo(() => {
    const byDate = new Map(data.map((d) => [d.date, d.count]));
    const max = Math.max(1, ...data.map((d) => d.count));
    const today = new Date();
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - span * 7 - start.getUTCDay());

    const out: { date: string; count: number; x: number; y: number; intensity: number }[] = [];
    for (let w = 0; w <= span; w++) {
      for (let d = 0; d < 7; d++) {
        const date = new Date(start);
        date.setUTCDate(start.getUTCDate() + w * 7 + d);
        if (date > today) continue;
        const key = date.toISOString().slice(0, 10);
        const count = byDate.get(key) ?? 0;
        out.push({
          date: key,
          count,
          x: w * 11,
          y: d * 11,
          intensity: count ? 0.25 + (count / max) * 0.75 : 0,
        });
      }
    }
    return out;
  }, [data, span]);

  return (
    <div>
      <svg
        viewBox={`0 0 ${(span + 1) * 11} 78`}
        height="86"
        className="w-full"
        role="img"
        aria-label="Phase completions by day"
      >
        {cells.map((cell) => (
          <rect
            key={cell.date}
            x={cell.x}
            y={cell.y}
            width="9"
            height="9"
            rx="1.5"
            fill={
              cell.count
                ? `color-mix(in oklab, ${toneVar('done')} ${Math.round(cell.intensity * 100)}%, var(--track))`
                : 'var(--track)'
            }
            onMouseEnter={() => setPicked(cell)}
            onMouseLeave={() => setPicked(null)}
            onClick={() => setPicked((current) => (current?.date === cell.date ? null : cell))}
          >
            <title>{`${cell.date}: ${cell.count} phase${cell.count === 1 ? '' : 's'}`}</title>
          </rect>
        ))}
      </svg>
      <div className="min-h-[1.2em] text-2xs text-ink-faint">
        {picked
          ? `${picked.date} · ${picked.count} phase${picked.count === 1 ? '' : 's'} completed`
          : `last ${span} weeks`}
      </div>
      {/* Only the days something landed on. A year of squares is ~180 rows of
          which most are zero, and a table whose every other row says `0` buries
          the answer it exists to give — the empty squares ARE the absence, and
          the note says how many there were. */}
      <ChartNumbers
        label="days with a completion"
        caption={`Phase completions by day over the last ${span} weeks`}
        rows={cells.filter((cell) => cell.count > 0)}
        getRowKey={(cell) => cell.date}
        columns={[
          { head: 'Day', cell: (cell) => <span className="font-mono">{cell.date}</span> },
          { head: 'Phases', cell: (cell) => cell.count, align: 'end' },
        ]}
        note={`${cells.length} days in the window; the rest completed nothing.`}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * BarList — ranked horizontal bars
 * ------------------------------------------------------------------ */

export interface BarListItem {
  name: string;
  value: number;
}

/** Repos, skills, models — anything ranked by a count. */
export function BarList({
  items,
  unit = '',
  tone = 'running',
  label,
  className,
}: {
  items: BarListItem[];
  unit?: string;
  tone?: ChartTone;
  /** What one row IS, plural — names the numbers fold and its table. */
  label?: string;
  className?: string;
}) {
  const max = Math.max(1, ...items.map((item) => item.value));
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (!items.length) return <span className="text-sm text-ink-faint">Nothing recorded yet.</span>;

  return (
    <div className={cn('min-w-0', className)}>
      <div className="flex flex-col gap-1">
        {items.map((item) => (
          <div
            key={item.name}
            className="grid grid-cols-[minmax(0,1fr)_2.5fr_auto] items-center gap-2"
            // The whole row, not just the truncated name: a pointer asking a
            // 6px bar what it is should get the reading, not the label it can
            // already see. The table below is the same answer for everyone else.
            title={`${item.name}: ${item.value}${unit}`}
          >
            <span className="truncate text-xs text-ink-muted">{item.name}</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-track">
              <span
                className="block h-full rounded-full"
                style={{ width: `${(item.value / max) * 100}%`, background: toneVar(tone) }}
              />
            </span>
            <span className="text-right font-mono text-2xs tabular-nums text-ink">
              {item.value}
              {unit}
            </span>
          </div>
        ))}
      </div>
      {/* Two things the ranked bars cannot say: the name in full — the rows
          truncate, and four plan slugs sharing a dated prefix truncate to the
          same six characters — and each row's share of the whole, which is the
          question a ranking invites and never answers. */}
      <ChartNumbers
        label={label ? `${label}, in full` : 'rows, in full'}
        caption={
          label ? `${label}, with each row's share of the total` : 'Every row, with its share of the total'
        }
        rows={items}
        getRowKey={(item) => item.name}
        columns={[
          { head: 'Name', cell: (item) => <span className="break-all">{item.name}</span> },
          {
            head: 'Value',
            cell: (item) => `${item.value}${unit}`,
            align: 'end',
          },
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
 * StackBar — a proportional stack with its own legend
 * ------------------------------------------------------------------ */

export interface StackSegment {
  label: string;
  value: number;
  tone: ChartTone;
}

/**
 * The size mix, the status split.
 *
 * `tone` is a state name rather than a colour string — the change that makes
 * the legend and the bar unable to disagree, because both read the same token
 * from the same place.
 */
export function StackBar({ segments, label }: { segments: StackSegment[]; label?: string }) {
  const sum = segments.reduce((running, segment) => running + segment.value, 0);
  // The divisor, never zero. `sum` stays honest for the share column: an
  // all-empty stack is 0 of 0, not 0 of 1, and "—" is the truthful share.
  const total = sum || 1;
  return (
    <div>
      <div
        className="flex h-2.5 overflow-hidden rounded-full bg-track"
        role="img"
        aria-label={segments.map((s) => `${s.label} ${s.value}`).join(', ')}
      >
        {segments.map((segment) => (
          // `title` the ATTRIBUTE, not a `<title>` child. `Bars` and `Calendar`
          // put a `<title>` inside a `<rect>` and that is correct — inside the
          // SVG namespace `<title>` IS the tooltip element. This bar is HTML: a
          // `<title>` here is the HEAD element, parsed out of place, so the
          // segments had no tooltip at all and stray `<title>` nodes leaked
          // into the document.
          <span
            key={segment.label}
            title={`${segment.label}: ${segment.value}`}
            style={{ width: `${(segment.value / total) * 100}%`, background: toneVar(segment.tone) }}
          />
        ))}
      </div>
      {/* The shared key, drawing each segment's own paint at legend size. */}
      <Legend
        className="mt-2 text-ink-muted"
        entries={segments.map((segment) => ({
          key: segment.label,
          label: segment.label,
          count: segment.value,
          mark: (
            <span
              className="size-[7px] shrink-0 rounded-full"
              style={{ background: toneVar(segment.tone) }}
              aria-hidden
            />
          ),
        }))}
      />
      {/* The legend gives the counts; only the table gives the proportions,
          which is the entire reason a stack was drawn instead of a list. A
          2px segment and a 3px segment are the same segment to the eye. */}
      <ChartNumbers
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
 * LoadMeter — one phase against one session
 * ------------------------------------------------------------------ */

/**
 * How much of a session a phase would take.
 *
 * This is the number the whole skill is organised around: phases are sized so a
 * session's working set stays inside a fraction of the model's window, and the
 * plan declares the budget that fraction is of. A weight alone ("40K") is a fact
 * nobody can act on; the same weight drawn against the budget is the answer to
 * "can I start this before the meeting".
 *
 * The quarter ticks are not decoration — they are what makes the bar readable
 * without a number beside it, which is what a phone needs.
 */
export function LoadMeter({
  fraction,
  label,
  description,
  tone = 'running',
  className,
}: {
  /** 0–1, or null when the phase has no weight or the plan no budget. */
  fraction: number | null;
  /** Kept to a few characters — the bar is the message, this is the check. */
  label: string;
  /** The exact reading, for the accessible name and the tooltip. */
  description?: string;
  tone?: ChartTone;
  className?: string;
}) {
  if (fraction == null) {
    return <span className={cn('text-2xs text-ink-faint', className)}>{label}</span>;
  }
  return (
    <span
      className={cn('flex min-w-0 items-center gap-2', className)}
      role="img"
      aria-label={`session load: ${description ?? label}`}
      title={description ?? label}
    >
      <span className="relative block h-1.5 min-w-12 flex-1 overflow-hidden rounded-full bg-track">
        <span
          className="block h-full rounded-full"
          style={{ width: `${Math.round(fraction * 100)}%`, background: toneVar(tone) }}
        />
        {[0.25, 0.5, 0.75].map((tick) => (
          <span
            key={tick}
            className="absolute inset-y-0 w-px bg-ground/70"
            style={{ left: `${tick * 100}%` }}
            aria-hidden
          />
        ))}
      </span>
      {/* A fixed width so a column of meters has its bars start and end on the
          same pixel — a ragged right edge reads as noise, not as data. */}
      <span className="w-9 shrink-0 text-right font-mono text-2xs tabular-nums text-ink-faint">{label}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * RouteStrip — a whole plan, at a glance
 * ------------------------------------------------------------------ */

export interface StripPhase {
  phase: number;
  state: string;
  title?: string;
}

/**
 * The states a strip's segments are in, tallied.
 *
 * Walked through `UI_STATES` by `stateEntries`/`stateTally` afterwards, so a
 * ninth state counts itself: nothing here names a state, which is the point —
 * both strips used to compute `done` and only `done`, and "9 done" out of 12
 * does not say whether the other three are running, waiting on a lock, or red.
 */
function tally(states: readonly UiState[]): LegendCounts {
  const counts: LegendCounts = {};
  for (const state of states) counts[state] = (counts[state] ?? 0) + 1;
  return counts;
}

/**
 * The numbers under a strip — the counting the strips were already doing and
 * rendering to nothing but the accessibility tree.
 *
 * `aria-hidden`, because the bar above it carries the same sentence as its
 * accessible name (`stateTally`): the fix for "the screen reader is better
 * informed than the screen" is to put the facts on the screen, not to say them
 * twice.
 */
function StripTally({ counts, total }: { counts: LegendCounts; total: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-ink-faint"
    >
      <span className="whitespace-nowrap">
        <span className="font-mono tabular-nums text-ink">{total}</span> phases
      </span>
      <Legend inline entries={stateEntries(counts)} className="gap-x-2" />
    </span>
  );
}

/**
 * A plan's phases as one line of track.
 *
 * The route map answers "what depends on what"; this answers "how far along is
 * this, and where is the work" in the width of a list row. Every phase is one
 * segment in plan order, painted by state, so the shape of a plan — a solid run
 * of green with an amber notch two thirds along — is legible before any of the
 * words are.
 *
 * Segments flex rather than taking a fixed width, so a 31-phase plan and a
 * 4-phase plan both fill the row and neither can push a phone sideways. Like
 * `Calendar`, it is a display and not a control: 31 tappable 44px targets do not
 * fit on a phone, so the strip as a whole is the link and the ready phases get
 * their own targets in the row beside it.
 */
export function RouteStrip({
  phases,
  tally: showTally = true,
  className,
}: {
  phases: StripPhase[];
  /** The counts and key under the bar. Off only where the row has no second line. */
  tally?: boolean;
  className?: string;
}) {
  if (!phases.length) return null;
  const counts = tally(phases.map((p) => boardUiState(p.state)));
  const name = stateTally(counts, { total: phases.length });

  return (
    <span className={cn('flex min-w-0 flex-col gap-1', className)}>
      <span className="flex h-3 w-full min-w-0 items-stretch gap-px" role="img" aria-label={name}>
        {phases.map((p) => {
          const ready = p.state === 'ready';
          return (
            <span
              key={p.phase}
              className={cn(
                'block min-w-0 flex-1 rounded-[1px] first:rounded-l-sm last:rounded-r-sm',
                // The one state you can act on is drawn full-height; everything
                // else is a band. Amber alone would be a colour difference on a
                // 6px segment, which is not a difference on a phone in daylight.
                ready ? 'self-stretch' : 'my-[3px]',
              )}
              // The board word → its UI state, through the vocabulary: an engine
              // that learns a new word paints it as the unknown state, never as an
              // undeclared custom property (transparent — "this phase does not exist").
              style={{ background: toneVar(boardUiState(p.state)) }}
              title={`P${p.phase} · ${p.state}${p.title ? ` · ${p.title}` : ''}`}
            />
          );
        })}
      </span>
      {showTally && <StripTally counts={counts} total={phases.length} />}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * RunStrip — what a run actually did to a plan
 * ------------------------------------------------------------------ */

export interface RunPhase {
  phase: number;
  /** A `PhaseStatus` from the runner — a different vocabulary to a plan's. */
  status: string;
  /**
   * Why it stopped, when the record carries it (`lifecycle.stop`). The two
   * parks nobody is being asked about — behind another lane's scope, or an MCP
   * server that would not connect — paint `waiting` rather than `needs-you`,
   * and the status word alone cannot tell them from the six that ARE an ask.
   */
  stop?: { kind?: string };
  /** The caller's one-line reading, for the tooltip. Cost and attempts belong here. */
  detail?: string;
}

/**
 * One run as a line of track.
 *
 * `/api/runs` already carries a full `PhaseRecord` for every phase of every run,
 * and until now no page read any of it — a run was six columns, of which one was
 * a status word for the run as a whole. This is that record made legible in the
 * width of a table cell: eight phases done and one red is a different run from
 * one phase done and eight pending, and the status word `halted` cannot tell
 * them apart.
 *
 * The running phase is drawn full-height for the same reason `RouteStrip` does
 * that to a ready one: it is the segment you are looking for, and on a 6px
 * segment a hue change alone is not a difference.
 */
export function RunStrip({
  phases,
  tally: showTally = true,
  className,
}: {
  phases: RunPhase[];
  /** The counts and key under the bar. Off only where the row has no second line. */
  tally?: boolean;
  className?: string;
}) {
  if (!phases.length) return null;
  const counts = tally(phases.map((p) => phaseUiState(p.status, p.stop)));
  const name = stateTally(counts, { total: phases.length });

  return (
    <span className={cn('flex min-w-0 flex-col gap-1', className)}>
      <span className="flex h-3 w-full min-w-0 items-stretch gap-px" role="img" aria-label={name}>
        {phases.map((p) => {
          const active = p.status === 'running' || p.status === 'verifying';
          return (
            <span
              key={p.phase}
              className={cn(
                'block min-w-0 flex-1 rounded-[1px] first:rounded-l-sm last:rounded-r-sm',
                active ? 'self-stretch' : 'my-[3px]',
              )}
              // The runner's word → its UI state, through the same vocabulary a
              // badge reads: `parked` needs a person (never red), `failed` is red.
              style={{ background: toneVar(phaseUiState(p.status, p.stop)) }}
              title={`P${p.phase} · ${p.status}${p.detail ? ` · ${p.detail}` : ''}`}
            />
          );
        })}
      </span>
      {showTally && <StripTally counts={counts} total={phases.length} />}
    </span>
  );
}
