/**
 * The one legend in the console: a mark, the word it means, and — when the
 * surface counts — how many.
 *
 * There were four, each written from scratch inside the component that needed
 * it (the route map, the gantt, the timeline, `StackBar`), and none at all on
 * the two most-looked-at bars in the product: `RouteStrip` on the Runs board and
 * `RunStrip` in the fleet table, whose only explanation of any colour was a
 * per-segment `title` — a desktop hover, which is no explanation at all on a
 * phone. Four private solutions is why some surfaces solved it and some did not,
 * and why every new chart either reinvented one or shipped without.
 *
 * Two rules come with it, both inherited from the route map's version, which was
 * the good one:
 *
 * 1. **Draw the real mark.** An entry renders the mark its surface actually
 *    draws, at legend size — the map hands in its own station glyph, not a
 *    stand-in dot. A legend of plain dots beside a map of glyphs is a legend
 *    that teaches the wrong thing. `mark` is how a surface says so; the default
 *    swatch is for the surfaces whose mark IS a dot.
 * 2. **The words come from the palette.** `stateEntries` walks `UI_STATES`
 *    worst-first and names each PAINT by the palette's own name (`uiLabel`),
 *    so a ninth paint appears in every tally the day it is added and nobody
 *    edits a chart. The counts are keyed by paint, and the caller reads each
 *    paint off the status model (`describePhase(…).paint`): this file is first
 *    paint and knows no status word.
 *
 * `stateTally` is the sentence half of the same fact — `12 phases · 9 done ·
 * 1 running` — and it exists so a bar's accessible name and the text printed
 * under it cannot say different things. `SegmentBar` reads it too.
 */

import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { UI_STATES, uiLabel, type UiState } from '@/lib/status-vocab';

/** How many phases (or runs, or anything) wear each paint. */
export interface LegendCounts extends Partial<Record<UiState, number>> {}

/** A paint's name, as a legend and a tally say it: "needs you", "running". */
const paintName = (paint: UiState) => uiLabel(paint).toLowerCase();

export interface LegendEntry {
  /** Stable across renders; the paint's name where there is one. */
  key: string;
  label: string;
  /**
   * The paint this entry explains. Paints the default swatch, and is what a
   * caller passes when its mark is an ordinary dot.
   */
  paint?: UiState;
  /** The surface's OWN mark, drawn at legend size. Wins over the swatch. */
  mark?: ReactNode;
  /** Shown after the label when the surface counts as well as paints. */
  count?: number;
  /** The longer reading, on hover. */
  title?: string;
}

/**
 * The default mark: a dot painted through `state-<paint>`, never a colour of
 * its own — the same token the bar beside it uses, which is what makes the two
 * unable to disagree.
 */
export function LegendSwatch({ paint, className }: { paint?: UiState; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-2 shrink-0 rounded-full bg-state',
        paint ? `state-${paint}` : '[--state:var(--ink-faint)]',
        className,
      )}
    />
  );
}

/**
 * The key itself.
 *
 * A list, because that is what it is — `inline` swaps the elements for spans so
 * it can sit inside a table cell or another span, where a `<ul>` cannot go, and
 * keeps the list semantics through roles.
 */
export function Legend({
  entries,
  inline = false,
  className,
  ...props
}: {
  entries: readonly LegendEntry[];
  /** Render as spans rather than a `<ul>` — for the inside of a cell or a span. */
  inline?: boolean;
} & HTMLAttributes<HTMLElement>) {
  if (!entries.length) return null;
  const Wrapper = inline ? 'span' : 'ul';
  const Item = inline ? 'span' : 'li';
  return (
    <Wrapper
      // The marker `legend.test.tsx` counts consumers by. There is no other way
      // to ask "is this surface's key the shared one or another hand-rolled
      // row" — which is the property the whole primitive exists to hold.
      data-slot="legend"
      {...(inline ? { role: 'list' } : {})}
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-faint',
        inline && 'min-w-0',
        className,
      )}
      {...props}
    >
      {entries.map((entry) => (
        <Item
          key={entry.key}
          {...(inline ? { role: 'listitem' } : {})}
          className="flex items-center gap-1.5"
          {...(entry.title ? { title: entry.title } : {})}
        >
          {entry.mark ?? <LegendSwatch {...(entry.paint ? { paint: entry.paint } : {})} />}
          {entry.label}
          {entry.count != null && <span className="font-mono tabular-nums text-ink">{entry.count}</span>}
        </Item>
      ))}
    </Wrapper>
  );
}

/**
 * Legend entries for a set of counts, worst-first, zero-count paints dropped.
 *
 * This is the half that makes a new paint free: the order and the words are the
 * palette's, so nothing here has to be edited when one is added.
 */
export function stateEntries(
  counts: LegendCounts,
  opts: {
    /** Keep a paint whose count is zero — for a key that must show the full set. */
    showZero?: boolean;
    /** Drop the numbers and leave a pure colour key. */
    countless?: boolean;
  } = {},
): LegendEntry[] {
  return UI_STATES.filter((paint) => opts.showZero || (counts[paint] ?? 0) > 0).map((paint) => ({
    key: paint,
    label: paintName(paint),
    paint,
    ...(opts.countless ? {} : { count: counts[paint] ?? 0 }),
  }));
}

/**
 * `9 of 12 phases: 7 done, 1 running, 1 failed` — the sentence half of the same
 * fact the entries above are the marks of.
 *
 * It is `SegmentBar`'s wording because `SegmentBar` had it right and had it
 * first: the counting, the ordering and the labels were already written there,
 * and the only thing wrong with it was that it lived in one component and was
 * called by nothing. Now a bar's accessible name and the key printed under it
 * are computed from the same walk of the same vocabulary, so they cannot come
 * to say different things.
 *
 * `total` is the denominator when the caller has one larger than the counts (a
 * `SegmentBar` may leave track unpainted); otherwise it is the sum.
 */
export function stateTally(
  counts: LegendCounts,
  { total, label = 'phases' }: { total?: number; label?: string } = {},
): string {
  const present = UI_STATES.filter((paint) => (counts[paint] ?? 0) > 0);
  if (!present.length) return `no ${label}`;
  const sum = present.reduce((acc, paint) => acc + Math.max(0, counts[paint] ?? 0), 0);
  const denominator = Math.max(total ?? sum, sum, 1);
  const parts = present.map((paint) => `${counts[paint]} ${paintName(paint)}`);
  return `${sum} of ${denominator} ${label}: ${parts.join(', ')}`;
}
