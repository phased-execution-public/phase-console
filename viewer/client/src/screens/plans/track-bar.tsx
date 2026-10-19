/**
 * A plan's phases in proportion (#360) — the line at the size of a row,
 * drawn so it carries the counts: every board bucket a segment whose length
 * is its share of the phases, and under it one worded legend naming every
 * non-zero count and the percentage (design.md §7). Colour is never the only
 * carrier: the legend says each count, and the whole is one `role="img"`
 * whose name reads them, so a screen reader hears the words once and never a
 * row of colours.
 *
 * ```
 * ████████████████████▌█▐██▌▒▒▒░░░░░░░░░░░░
 * 41 done · 1 held by QA · 1 in progress · 2 stuck · 1 next up · 3 waiting · 25 left · 56 %
 * ```
 *
 * The counts are `countsOf` (`./model`), read off the `/api/plans` row with
 * no fetch of its own, the segments always summing to the phase count. Two
 * overlays never double-count: held by QA is a segment carved out of done,
 * and a gate is a hatch drawn OVER next up and waiting, never a segment. An
 * unread board draws its last good reading and the rest hatched, its legend
 * the shared reading (#96). Paint is a state, through `.state-<paint>` and
 * `bg-state` (§1 rule 4 lets a hue paint a track segment); the bare remainder
 * is the neutral track.
 *
 * Drawn by the plans list, the cards, the panel, the plan's glance and Your
 * turn's *Where the plans stand* — one graphic, five places.
 */

import type { CSSProperties } from 'react';
import { progressReading } from '@shared/plan-vocab.js';
import { BOARD_STATE_UI } from '@shared/status-vocab.js';
import { cn } from '@/lib/cn';
import {
  countsLabel,
  countsOf,
  legendOf,
  segmentsOf,
  type CountsSource,
  type PlanRow,
  type TrackSegment,
} from './model';

/** A hatch in the segment's own state — a share whose state is not known, or the gate's mark. */
const HATCH: CSSProperties = {
  backgroundImage: 'repeating-linear-gradient(135deg, var(--state) 0 2px, transparent 2px 4px)',
};

function Segment({ segment }: { segment: TrackSegment }) {
  const { paint } = segment;
  return (
    <span
      data-segment={segment.key}
      data-count={segment.count}
      data-paint={paint ?? 'track'}
      title={segment.label}
      className={cn(
        'block h-full min-w-[3px]',
        paint ? `state-${paint}` : 'bg-track',
        paint && !segment.hatch && 'bg-state',
      )}
      style={{ flex: `${segment.count} 1 0`, ...(segment.hatch ? HATCH : {}) }}
    />
  );
}

export function PlanTrack({
  row,
  className,
  nowMs,
}: {
  row: CountsSource & Pick<PlanRow, 'title'>;
  className?: string;
  /** The clock an unread board's "last read … ago" is said against. */
  nowMs?: number;
}) {
  const counts = countsOf(row);
  const segments = segmentsOf(counts);
  // The gate's mark lies over next up and waiting, which sit side by side:
  // the two are drawn in one span so the hatch spans exactly them.
  const marked = segments.filter((s) => s.key === 'ready' || s.key === 'waiting');
  const markedCount = marked.reduce((sum, s) => sum + s.count, 0);
  const gated = counts.gated > 0 && markedCount > 0;
  const firstMarked = gated ? segments.indexOf(marked[0]!) : -1;
  const reading = counts.known ? null : progressReading(row, nowMs);
  /** The gate's paint — the board table's word for a gated phase. */
  const paint = BOARD_STATE_UI.gated;
  return (
    <div
      role="img"
      aria-label={countsLabel(row, nowMs)}
      data-testid="plan-track"
      data-phases={counts.phases}
      data-known={counts.known ? undefined : 'false'}
      title={reading?.title}
      className={cn('flex min-w-0 flex-col gap-1', className)}
    >
      <div data-bar className="flex h-1.5 w-full min-w-24 gap-px overflow-hidden rounded-full">
        {segments.map((segment, index) => {
          if (!gated || (segment.key !== 'ready' && segment.key !== 'waiting')) {
            return <Segment key={segment.key} segment={segment} />;
          }
          if (index !== firstMarked) return null;
          return (
            <span
              key="gate"
              data-gate-group
              className="relative flex h-full gap-px"
              style={{ flex: `${markedCount} 1 0` }}
            >
              {marked.map((s) => (
                <Segment key={s.key} segment={s} />
              ))}
              <span
                data-gated={counts.gated}
                title={`${counts.gated} gated`}
                className={cn('absolute inset-y-0 start-0', `state-${paint}`)}
                style={{ inlineSize: `${(counts.gated / markedCount) * 100}%`, ...HATCH }}
              />
            </span>
          );
        })}
      </div>
      <p data-testid="plan-legend" className="min-w-0 break-words text-meta text-ink-muted tnum">
        {legendOf(row, nowMs)}
      </p>
    </div>
  );
}
