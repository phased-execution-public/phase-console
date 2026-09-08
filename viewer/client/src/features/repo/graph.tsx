/**
 * The commit graph — lanes drawn beside real table rows.
 *
 * ## Why a table and not a canvas
 *
 * The plan's instruction for this graph was to prefer the machinery already in
 * the client over a new dependency, and no dependency was added: `lanes.ts` is
 * the whole algorithm and this file is the whole drawing. But the route map's
 * PAN-AND-ZOOM canvas (`useMapView`) is deliberately not what a commit graph
 * gets, and the reason is worth writing down because it looks like a reuse
 * opportunity being passed up.
 *
 * A plan DAG is a picture: a few dozen stations whose position carries the
 * meaning, small enough to fit a frame, with nothing to read line by line. A
 * commit history is a LIST — hundreds of rows in an order git already chose,
 * each of which is a sentence somebody reads, copies a sha out of, and opens.
 * Putting that inside a zoomable viewport costs the three things a list has for
 * free: the page's one scroller (the shell owns it and a page must not make a
 * second), keyboard order, and a screen reader's table semantics. GitLens and
 * every web forge draw it the same way for the same reason.
 *
 * So each row is a real `<tr>` of a fixed height, and its first cell is a small
 * SVG of exactly that height carrying its slice of the lanes.
 *
 * ## How a row's slice is self-contained
 *
 * The band between two commits crosses the bottom half of the upper row and the
 * top half of the lower one, so a row draws:
 *
 * - **bottom half** — one path per link out of `packLanes`: a lane the commit
 *   sent a parent into leaves the dot and curves to its column; every other
 *   occupied lane runs straight down.
 * - **top half** — a vertical stub in each lane the row above sent something
 *   into, which is exactly the `to` set of the previous row's links.
 *
 * That makes alignment a non-problem: no absolute positioning, no measured row
 * heights, nothing to drift when density changes the padding around it.
 */

import { GitBranch, GitCommitHorizontal, GitMerge, Tag } from 'lucide-react';
import type { RepoCommit, RepoGraph } from '@/lib/api';
import { Chip, TD, TR } from '@/components/ui';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/format';
import { decorateRef, packLanes, type DecoratedRef, type GraphLink, type GraphRow } from './lanes';

/** One row's height in CSS pixels, and the SVG's own — they are the same number by construction. */
export const ROW_H = 44;
/** One lane's width. Wide enough for a 3.5px dot plus air on both sides. */
export const LANE_W = 16;
/** How wide the gutter may get before lanes stop being drawn and start being counted. */
export const LANE_CAP = 8;
/**
 * The server's own ceiling on a walk (`GRAPH_LIMIT_MAX` in `git-browse.ts`).
 * Mirrored, not imported: it is a wire fact like every other number this client
 * re-declares from the contract. Asking past it does not fail — it silently
 * returns the same page, which is worse than a button that stops.
 */
export const GRAPH_LIMIT_MAX = 500;

/** A lane's colour, by index. Six hues that read apart in both themes, then they repeat. */
const LANE_TONES = [
  'var(--color-accent)',
  'var(--color-done)',
  'var(--color-running)',
  'var(--color-gated)',
  'var(--color-verifying)',
  'var(--color-needs-you)',
] as const;

export const laneTone = (lane: number): string => LANE_TONES[lane % LANE_TONES.length];

const x = (lane: number) => lane * LANE_W + LANE_W / 2;

/**
 * How a decoration paints.
 *
 * The console's own branches are the point of this destination, so they are the
 * ones that get a colour: a run branch and its lane branches are what parallel
 * execution looks like from the repository's side. Everything else is a chip in
 * the ordinary ink — a person's branch is not news here.
 */
const REF_TONE: Record<DecoratedRef['kind'], 'accent' | 'ok' | 'neutral' | 'warn'> = {
  trunk: 'ok',
  run: 'accent',
  lane: 'accent',
  tag: 'warn',
  head: 'neutral',
  branch: 'neutral',
};

const REF_TITLE: Record<DecoratedRef['kind'], string> = {
  trunk: 'The trunk this repository settles onto.',
  run: "A run's own branch — every phase of that plan commits here.",
  lane: 'A lane branch: one phase of one run, merged back when the phase settles.',
  tag: 'A tag.',
  head: 'Where HEAD is.',
  branch: 'A branch. Nothing in the console claims it.',
};

export function RefChip({ decorated }: { decorated: DecoratedRef }) {
  const { kind, name, run } = decorated;
  return (
    <Chip
      tone={REF_TONE[kind]}
      mono
      data-testid="ref-chip"
      data-kind={kind}
      title={
        run
          ? `${REF_TITLE[kind]} Parsed from the name as ${run.slug}${
              run.phase === undefined ? '' : ` phase ${run.phase}`
            } — a branch name is something an operator can type, so this is a reading, not evidence.`
          : REF_TITLE[kind]
      }
    >
      {kind === 'tag' ? <Tag size={10} aria-hidden /> : <GitBranch size={10} aria-hidden />}
      {name}
    </Chip>
  );
}

/**
 * One row's lanes.
 *
 * `incoming` is the previous row's `to` set — see the file lead. A merge (two or
 * more parents) draws its extra edges as curves out of the dot, which is the one
 * place the picture says something the sha list cannot.
 */
function LaneCell({
  row,
  incoming,
  lanes,
}: {
  row: GraphRow;
  /** The row above's links — the LINKS, not their lane indices, so an arriving
   *  line keeps the `dangling` styling it was drawn with in the row above. Half
   *  a dashed line followed by half a solid one is two different claims about
   *  one edge (QA round 2, L-1). */
  incoming: GraphLink[];
  lanes: number;
}) {
  const w = lanes * LANE_W;
  const mid = ROW_H / 2;
  const cx = x(row.lane);
  return (
    <svg
      width={w}
      height={ROW_H}
      viewBox={`0 0 ${w} ${ROW_H}`}
      // Decorative: every fact it draws is in the row beside it, and a screen
      // reader reading out eighteen path elements per commit would bury them.
      aria-hidden="true"
      className="shrink-0"
    >
      {incoming.map((link) => {
        // An arriving lane either CONTINUES past this row or ENDS at it — and
        // the packer is the one that knows which, because a freed slot is
        // re-allocated within the same row whenever this commit has a second
        // parent. "Is that index occupied below?" answers yes for a lane whose
        // OCCUPANT changed; `row.merged` names the lanes that were waiting for
        // THIS commit, which is the identity question.
        const lane = link.to;
        const ends = row.merged.includes(lane);
        const stroke = link.dangling ? 'var(--color-ink-faint)' : laneTone(lane);
        const dash = link.dangling ? { strokeDasharray: '2 3' } : {};
        return ends ? (
          <path
            key={`in-${lane}`}
            d={`M ${x(lane)} 0 C ${x(lane)} ${mid / 2}, ${cx} ${mid / 3}, ${cx} ${mid}`}
            fill="none"
            stroke={stroke}
            strokeWidth={1.5}
            strokeLinecap="round"
            data-testid="lane-merge"
            {...dash}
          />
        ) : (
          <line
            key={`in-${lane}`}
            x1={x(lane)}
            y1={0}
            x2={x(lane)}
            y2={mid}
            stroke={stroke}
            strokeWidth={1.5}
            strokeLinecap="round"
            data-testid="lane-through"
            {...dash}
          />
        );
      })}
      {row.links.map((link) => {
        const x1 = x(link.from);
        const x2 = x(link.to);
        return (
          <path
            key={`out-${link.from}-${link.to}`}
            d={
              x1 === x2
                ? `M ${x1} ${mid} L ${x2} ${ROW_H}`
                : // A cubic rather than an elbow: a merge that turns a right
                  // angle reads as two unrelated lines meeting, which is the
                  // one thing this drawing must not say.
                  `M ${x1} ${mid} C ${x1} ${mid + ROW_H / 3}, ${x2} ${mid + ROW_H / 6}, ${x2} ${ROW_H}`
            }
            fill="none"
            // A lane waiting for a commit this walk never reached is dashed and
            // faint: history CONTINUES below the window rather than ending. It
            // used to be a second stub drawn at the same coordinates as the
            // solid link, which is to say it was never visible at all.
            stroke={link.dangling ? 'var(--color-ink-faint)' : laneTone(link.to)}
            strokeWidth={1.5}
            strokeLinecap="round"
            {...(link.dangling ? { strokeDasharray: '2 3' } : {})}
          />
        );
      })}
      <circle
        cx={cx}
        cy={mid}
        r={row.commit.parents.length > 1 ? 4.5 : 3.5}
        fill="var(--color-ground)"
        stroke={laneTone(row.lane)}
        strokeWidth={2}
      />
    </svg>
  );
}

/**
 * One declaration per column, read by the header and by every row.
 *
 * The commit table is laid out `fixed` on these tracks, and that is the whole
 * fix for the defect the Phase 6 register measured at 1822 px on a 334 px box at
 * every viewport: under AUTO layout a column sizes to its widest cell across
 * every row, so `truncate` on the subject never engaged — one 1216 px commit
 * message made the column 1216 px wide and the three `whitespace-nowrap`
 * columns beside it added their own longest values on top. Declared tracks are
 * what make `truncate` mean anything.
 *
 * The narrow widths drop columns rather than squeezing them. Nothing is lost by
 * dropping one: the row's own button opens the commit inspector, which carries
 * the refs, the author, the full date and the sha in full. A column here is a
 * convenience for scanning, and a convenience that squeezes the subject to
 * forty pixels is not one.
 *
 * `whitespace-nowrap` is deliberately absent from all four. Under `table-fixed`
 * a cell that refuses to wrap does not widen its column — it escapes it, and
 * the wrapper then scrolls for the sake of one long author name and takes the
 * sticky header with it.
 */
export const GRAPH_TRACK = {
  /** Sized by its own SVG — `lanes * LANE_W` plus the cell's left padding. */
  lanes: (lanes: number) => `calc(${lanes * LANE_W}px + var(--tile-pad-x))`,
  refs: '10rem',
  author: '8.5rem',
  at: '7rem',
  short: '5.5rem',
} as const;

/** Which columns exist at which width. Header and row must say the same thing. */
export const GRAPH_SHOWN = {
  refs: 'hidden lg:table-cell',
  author: 'hidden xl:table-cell',
  at: 'hidden sm:table-cell',
} as const;

export function CommitRow({
  row,
  incoming,
  lanes,
  trunk,
  active,
  onPick,
}: {
  row: GraphRow;
  /** The row above's links — see `LaneCell`. */
  incoming: GraphLink[];
  lanes: number;
  trunk?: string;
  active: boolean;
  onPick: (commit: RepoCommit) => void;
}) {
  const { commit } = row;
  const merge = commit.parents.length > 1;
  const at = Date.parse(commit.at);
  return (
    <TR
      data-testid="commit-row"
      data-sha={commit.sha}
      aria-current={active ? 'true' : undefined}
      className={active ? 'bg-surface' : undefined}
    >
      <TD className="py-0 pr-0 align-middle" style={{ height: ROW_H, width: GRAPH_TRACK.lanes(lanes) }}>
        <LaneCell row={row} incoming={incoming} lanes={lanes} />
      </TD>
      {/* `py-0` is what lets the button below claim the whole row.

          The row is exactly `ROW_H` because `LaneCell`'s SVG is drawn at that
          height, and that is what makes the lane lines join across boundaries —
          the alignment this file's header calls "a non-problem, by
          construction". So the tap floor may not GROW this row: a
          `min-h-(--tap-min)` against the cell's default `py-(--tile-pad-y)`
          pushes it to 64px (56 compact) while the SVG stays at 44, and
          `align-middle` leaves a gap in every line. With the cell's padding
          removed, `min-h-(--tap-min)` on the button resolves to exactly
          `ROW_H` — the row does not move and the target is the full 44.

          Growing the hit area with negative margin instead (the first attempt
          at this) leaves the target at 40px comfortable / 32px compact: better
          than the ~20px it started at, still under the floor. */}
      <TD className="min-w-0 py-0 align-middle">
        <button
          type="button"
          onClick={() => onPick(commit)}
          className="flex min-h-(--tap-min) w-full min-w-0 items-center gap-1.5 text-left"
          // The subject alone is ambiguous across a rebase; the sha is what the
          // reader is being offered, so it is in the name.
          aria-label={`Commit ${commit.short}: ${commit.subject}`}
        >
          {merge ? (
            <GitMerge size={12} className="shrink-0 text-ink-faint" aria-hidden />
          ) : (
            <GitCommitHorizontal size={12} className="shrink-0 text-ink-faint" aria-hidden />
          )}
          <span className="min-w-0 truncate text-sm text-ink" title={commit.subject}>
            {commit.subject}
          </span>
        </button>
      </TD>
      <TD className={cn('align-middle', GRAPH_SHOWN.refs)} style={{ width: GRAPH_TRACK.refs }}>
        <span className="flex flex-wrap items-center gap-1">
          {commit.refs.map((ref) => (
            <RefChip key={ref} decorated={decorateRef(ref, trunk)} />
          ))}
        </span>
      </TD>
      <TD
        className={cn('align-middle text-2xs text-ink-muted', GRAPH_SHOWN.author)}
        style={{ width: GRAPH_TRACK.author }}
      >
        <span className="block min-w-0 truncate" title={commit.author}>
          {commit.author}
        </span>
      </TD>
      <TD
        className={cn('align-middle text-2xs text-ink-faint', GRAPH_SHOWN.at)}
        style={{ width: GRAPH_TRACK.at }}
        title={Number.isNaN(at) ? commit.at : new Date(at).toLocaleString()}
      >
        {Number.isNaN(at) ? commit.at : relativeTime(at)}
      </TD>
      <TD className="align-middle font-mono text-2xs text-ink-faint" style={{ width: GRAPH_TRACK.short }}>
        {commit.short}
      </TD>
    </TR>
  );
}

/**
 * The rows and the lane width for a graph answer.
 *
 * The cap is a drawing decision, not a data one: past `LANE_CAP` columns the
 * gutter is wider than the subject beside it and stops being readable, so the
 * lanes are clipped and the count is said out loud instead. Nothing is dropped —
 * every commit still has its row.
 */
export function graphRows(graph: RepoGraph | undefined) {
  const packed = packLanes(graph?.commits ?? []);
  return {
    rows: packed.rows,
    lanes: Math.min(packed.laneCount, LANE_CAP),
    lanesClipped: packed.laneCount > LANE_CAP,
    laneCount: packed.laneCount,
  };
}
