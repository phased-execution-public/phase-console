/**
 * A plan's phases in proportion (#360), drawn as a pipeline — the line at
 * the size of a row, drawn so it carries the counts: every phase a cell of
 * the bar in its share's paint, each board bucket a segment whose length is
 * its share of the phases, the percentage done as a badge at the bar's end,
 * and under it one legend naming every non-zero share as the status family's
 * badge (design.md §7). Colour is never the only carrier: each badge says its
 * count in words, and the whole is one `role="img"` whose name reads them, so
 * a screen reader hears the words once and never a row of colours — and no
 * badge inside it is a tab stop of its own.
 *
 * ```
 * ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▯▯▯▯▯▯▯▯▯▯▯▯   (56 %)
 * (41 done) (1 held by QA) (1 in progress) (2 stuck) (1 next up) (3 waiting)  25 left
 * ```
 *
 * The counts are `countsOf` (`./model`), read off the `/api/plans` row with
 * no fetch of its own, the segments always summing to the phase count. Up to
 * `PIPELINE_MAX` phases every phase is its own cell, so a plan reads as the
 * stops of a line; past it a row cannot tell cells apart, and each share is
 * one stretch. Given the phases in their own ORDER (`pipelineOf` over a plan's
 * detail — the panel's line), each cell stands where its phase does, its
 * title its phase's, a gate hatched over it. Two overlays never double-count:
 * held by QA is a segment carved out of done, and a gate is a hatch drawn OVER
 * next up and waiting, never a segment. An unread board draws its last good
 * reading and the rest hatched, its legend the shared reading (#96) — never a
 * badge at 0 %. Paint is a state, through `.state-<paint>` and `bg-state`
 * (§1 rule 4 lets a hue paint a track segment); the bare remainder is the
 * neutral track. Each badge wears its segment's paint (`sharePaint`, the same
 * table), so the legend and the line are one colour per share.
 *
 * Drawn by the plans list, the cards, the panel, the plan's glance and Your
 * turn's *Where the plans stand* — one graphic, five places.
 */

import type { CSSProperties } from 'react';
import { progressReading } from '@shared/plan-vocab.js';
import { BOARD_STATE_UI, type UiState } from '@shared/status-vocab.js';
import { cn } from '@/lib/cn';
import { PhaseShare, PlanProgress, shareName, sharePaint, type ShareWord } from '@/ui/status';
import {
  countsLabel,
  countsOf,
  segmentsOf,
  type CountsSource,
  type PipelineStop,
  type PlanCounts,
  type PlanRow,
  type TrackSegment,
} from './model';

/** A hatch in the segment's own state — a share whose state is not known, or the gate's mark. */
const HATCH: CSSProperties = {
  backgroundImage: 'repeating-linear-gradient(135deg, var(--state) 0 2px, transparent 2px 4px)',
};

/**
 * The most phases a row's bar draws as cells of their own — at a row's
 * width a cell narrower than this is a smear, not a stop on a line.
 */
export const PIPELINE_MAX = 48;

/**
 * The gate's mark: a hatch in the board table's paint for a gated phase,
 * laid over what it holds — a share of the bar, or one phase's cell.
 */
function GateHatch({ count, share }: { count?: number; share?: number }) {
  const paint = BOARD_STATE_UI.gated;
  return (
    <span
      data-gated={count ?? ''}
      {...(count ? { title: `${count} gated` } : {})}
      className={cn('absolute inset-y-0 start-0', share == null && 'end-0', `state-${paint}`)}
      style={{ ...(share != null ? { inlineSize: `${share * 100}%` } : {}), ...HATCH }}
    />
  );
}

/**
 * A segment as a share the family paints: every segment but the two with no
 * state — what no bucket accounts for, and what an unread board left unread.
 */
const shareOf = (key: TrackSegment['key']): ShareWord | null =>
  key === 'rest' || key === 'unread' ? null : key;

function Cells({ count, paint, hatch }: { count: number; paint: UiState | null; hatch?: boolean }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          data-cell=""
          className={cn('block h-full min-w-px flex-1', paint && !hatch ? 'bg-state' : !paint && 'bg-track')}
          style={hatch ? HATCH : undefined}
        />
      ))}
    </>
  );
}

function Segment({ segment, cells }: { segment: TrackSegment; cells: boolean }) {
  const { paint } = segment;
  return (
    <span
      data-segment={segment.key}
      data-count={segment.count}
      data-paint={paint ?? 'track'}
      title={segment.label}
      className={cn(
        'h-full min-w-[3px]',
        // As cells, the segment is only their row: each cell wears the paint,
        // and the gaps between them show the line's own ground.
        cells ? 'flex gap-px' : 'block',
        paint ? `state-${paint}` : !cells && 'bg-track',
        paint && !segment.hatch && !cells && 'bg-state',
      )}
      style={{ flex: `${segment.count} 1 0`, ...(segment.hatch && !cells ? HATCH : {}) }}
    >
      {cells && <Cells count={segment.count} paint={paint} {...(segment.hatch ? { hatch: true } : {})} />}
    </span>
  );
}

/** The bar grouped by share: the list's line, read off the counts alone. */
function SharesBar({ counts, cells }: { counts: PlanCounts; cells: boolean }) {
  const segments = segmentsOf(counts);
  // The gate's mark lies over next up and waiting, which sit side by side:
  // the two are drawn in one span so the hatch spans exactly them.
  const marked = segments.filter((s) => s.key === 'ready' || s.key === 'waiting');
  const markedCount = marked.reduce((sum, s) => sum + s.count, 0);
  const gated = counts.gated > 0 && markedCount > 0;
  const firstMarked = gated ? segments.indexOf(marked[0]!) : -1;
  return (
    <div
      data-bar=""
      data-pipeline={cells ? 'phases' : 'shares'}
      className="flex h-2 min-w-24 flex-1 gap-px overflow-hidden rounded-full"
    >
      {segments.map((segment, index) => {
        if (!gated || (segment.key !== 'ready' && segment.key !== 'waiting')) {
          return <Segment key={segment.key} segment={segment} cells={cells} />;
        }
        if (index !== firstMarked) return null;
        return (
          <span
            key="gate"
            data-gate-group=""
            className="relative flex h-full gap-px"
            style={{ flex: `${markedCount} 1 0` }}
          >
            {marked.map((s) => (
              <Segment key={s.key} segment={s} cells={cells} />
            ))}
            <GateHatch count={counts.gated} share={counts.gated / markedCount} />
          </span>
        );
      })}
    </div>
  );
}

/** The bar in phase order: the panel's line, each phase where it stands. */
function OrderedBar({ order }: { order: readonly PipelineStop[] }) {
  // Past what a row can tell apart the cells stand flush, so a run of one
  // share reads as one stretch, still in the phases' own order.
  const apart = order.length <= PIPELINE_MAX;
  return (
    <div
      data-bar=""
      data-pipeline="ordered"
      className={cn('flex h-2 min-w-24 flex-1 overflow-hidden rounded-full', apart && 'gap-px')}
    >
      {order.map((stop) => {
        const paint = stop.share ? sharePaint(stop.share) : null;
        const word = stop.share ? shareName(stop.share) : 'Not on the board';
        return (
          <span
            key={stop.phase}
            data-cell=""
            data-phase={stop.phase}
            data-share={stop.share ?? 'rest'}
            data-paint={paint ?? 'track'}
            title={`P${stop.phase} ${word}${stop.gated ? ', gated' : ''}${stop.title ? `: ${stop.title}` : ''}`}
            className={cn(
              'relative block h-full min-w-px flex-1',
              paint ? `state-${paint} bg-state` : 'bg-track',
            )}
          >
            {stop.gated && <GateHatch />}
          </span>
        );
      })}
    </div>
  );
}

/**
 * The legend: a badge per share, in the line's order — the gate's right after
 * the shares it marks — then what no bucket accounts for, in plain words.
 */
function Legend({ counts }: { counts: PlanCounts }) {
  const segments = segmentsOf(counts);
  const lastMarked = segments.findLastIndex((s) => s.key === 'ready' || s.key === 'waiting');
  const rest = segments.find((s) => s.key === 'rest');
  return (
    <div data-testid="plan-legend" className="flex min-w-0 flex-wrap items-center gap-1">
      {segments.map((segment, index) => {
        const share = shareOf(segment.key);
        const gate =
          counts.gated > 0 && index === lastMarked ? (
            <PhaseShare
              key="gated"
              share="gated"
              count={counts.gated}
              tabIndex={-1}
              data-testid="plan-share"
            />
          ) : null;
        if (!share) return gate;
        return [
          <PhaseShare
            key={segment.key}
            share={share}
            count={segment.count}
            label={segment.label}
            tabIndex={-1}
            data-testid="plan-share"
          />,
          gate,
        ];
      })}
      {rest && (
        <span data-testid="plan-rest" className="ms-1 text-meta text-ink-muted tnum">
          {rest.label}
        </span>
      )}
    </div>
  );
}

export function PlanTrack({
  row,
  className,
  nowMs,
  order,
}: {
  row: CountsSource & Pick<PlanRow, 'title'>;
  className?: string;
  /** The clock an unread board's "last read … ago" is said against. */
  nowMs?: number;
  /**
   * The phases in their own order (`pipelineOf`, from the plan's detail). Drawn
   * only when it covers every phase; otherwise the cells are grouped by share.
   */
  order?: readonly PipelineStop[] | null;
}) {
  const counts = countsOf(row);
  const reading = counts.known ? null : progressReading(row, nowMs);
  const ordered = counts.known && order && order.length === counts.phases ? order : null;
  const cells = counts.phases > 0 && counts.phases <= PIPELINE_MAX;
  return (
    <div
      role="img"
      aria-label={countsLabel(row, nowMs)}
      data-testid="plan-track"
      data-phases={counts.phases}
      data-known={counts.known ? undefined : 'false'}
      title={reading?.title}
      className={cn('flex min-w-0 flex-col gap-1.5', className)}
    >
      <div className="flex min-w-0 items-center gap-2">
        {ordered ? <OrderedBar order={ordered} /> : <SharesBar counts={counts} cells={cells} />}
        {counts.known && (
          <PlanProgress
            percent={counts.percent}
            settled={counts.closed || counts.percent >= 100}
            tabIndex={-1}
            data-testid="plan-percent"
            className="shrink-0"
          />
        )}
      </div>
      {reading ? (
        <p data-testid="plan-legend" className="min-w-0 break-words text-meta text-ink-muted tnum">
          {reading.text}
        </p>
      ) : (
        <Legend counts={counts} />
      )}
    </div>
  );
}
