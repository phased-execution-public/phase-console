/**
 * History's drawing — the lanes beside real table rows (7.0, quiet-console
 * phase 17).
 *
 * A history is a list a person reads line by line, copies a sha out of and
 * opens, so each commit is a real `<tr>` of one fixed height, and its first
 * cell is an SVG of exactly that height carrying its slice of the lanes. A
 * zoomable canvas would cost the three things a list has for free: the page's
 * one scroller, keyboard order and a screen reader's table.
 *
 * A row's slice is self-contained. The band between two commits crosses the
 * bottom half of the upper row and the top half of the lower one, so a row
 * draws its own links out of `packLanes` below its dot, and above it a stub in
 * each lane the row above sent something into — no measured heights, nothing
 * positioned, nothing to drift when the density changes the padding.
 *
 * The drawing is the console's line at repository scale (design.md §7):
 * neutral lines in the track's colour and every commit a station on them. A
 * tip — a commit a ref points at — is ink; a merge is a ring; an edge into
 * history this walk did not reach is dashed, because it continues below rather
 * than ending. No hue: a lane is not a status, and amber is a summons. The
 * gutter is `aria-hidden` — every fact it draws is in the row beside it.
 */

import { GitBranch, Tag } from 'lucide-react';
import type { RepoCommit, RepoGraph } from '@/data/api';
import { cn } from '@/lib/cn';
import { Mono, RelativeTime } from '@/ui';
import { TD, TR } from '@/ui/table';
import { decorateRef, packLanes, type DecoratedRef, type GraphLink, type GraphRow } from './lanes';

/** One row's height in CSS pixels, and the SVG's own — the same number by construction. */
export const ROW_H = 44;
/** One lane's width: a dot and air on both sides. */
export const LANE_W = 16;
/** How many lanes are drawn before the rest are counted instead. */
export const LANE_CAP = 8;
/** The gutter's widest drawing — `LANE_W` × `LANE_CAP`, 128 px. */
export const GUTTER_MAX = LANE_W * LANE_CAP;
/**
 * The server's ceiling on one walk (`GRAPH_LIMIT_MAX` in `server/git-browse.ts`),
 * mirrored as a wire fact: asking past it returns the same page, so the button
 * that asks stops here.
 */
export const GRAPH_LIMIT_MAX = 500;

const x = (lane: number) => lane * LANE_W + LANE_W / 2;

/** The line's paint: the track's own neutral, and a fainter dash for history beyond the walk. */
const LINE = 'var(--track)';
const BEYOND = 'var(--ink-faint)';

function LaneCell({
  row,
  incoming,
  lanes,
  bare,
}: {
  row: GraphRow;
  /**
   * The row above's links — the links, not their lanes, so an arriving line
   * keeps the dash it was drawn with above: half a dashed line followed by half
   * a solid one would be two claims about one edge.
   */
  incoming: readonly GraphLink[];
  lanes: number;
  /** The dot alone: a search has cut the rows apart, and a line between two non-neighbours says nothing. */
  bare: boolean;
}) {
  const w = lanes * LANE_W;
  const mid = ROW_H / 2;
  const cx = x(row.lane);
  // A dot in a lane past the cut is not drawn: put on the last lane, it would
  // claim a line that is somebody else's.
  const drawn = row.lane < lanes;
  const tip = row.commit.refs.length > 0;
  const merge = row.commit.parents.length > 1;
  return (
    <svg width={w} height={ROW_H} viewBox={`0 0 ${w} ${ROW_H}`} aria-hidden="true" className="block shrink-0">
      {!bare &&
        incoming
          .filter((link) => link.to < lanes)
          .map((link) => {
            const to = link.to;
            // A lane ENDS here when it was waiting for this very commit (the
            // packer names those — an index is not an identity); otherwise it
            // runs on past.
            const ends = row.merged.includes(to);
            const stroke = link.dangling ? BEYOND : LINE;
            const dash = link.dangling ? { strokeDasharray: '2 3' } : {};
            return ends ? (
              <path
                key={`in-${to}`}
                d={`M ${x(to)} 0 C ${x(to)} ${mid / 2}, ${cx} ${mid / 3}, ${cx} ${mid}`}
                fill="none"
                stroke={stroke}
                strokeWidth={2}
                strokeLinecap="round"
                data-lane="merge"
                {...dash}
              />
            ) : (
              <line
                key={`in-${to}`}
                x1={x(to)}
                y1={0}
                x2={x(to)}
                y2={mid}
                stroke={stroke}
                strokeWidth={2}
                strokeLinecap="round"
                data-lane="through"
                {...dash}
              />
            );
          })}
      {!bare &&
        row.links
          .filter((link) => link.to < lanes && link.from < lanes)
          .map((link) => {
            const x1 = x(link.from);
            const x2 = x(link.to);
            return (
              <path
                key={`out-${link.from}-${link.to}`}
                // A cubic rather than an elbow: two lines meeting at a right
                // angle read as unrelated, which is the one thing a merge must not.
                d={
                  x1 === x2
                    ? `M ${x1} ${mid} L ${x2} ${ROW_H}`
                    : `M ${x1} ${mid} C ${x1} ${mid + ROW_H / 3}, ${x2} ${mid + ROW_H / 6}, ${x2} ${ROW_H}`
                }
                fill="none"
                stroke={link.dangling ? BEYOND : LINE}
                strokeWidth={2}
                strokeLinecap="round"
                data-lane={link.dangling ? 'beyond' : 'out'}
                {...(link.dangling ? { strokeDasharray: '2 3' } : {})}
              />
            );
          })}
      {/* The station: a halo of the ground cuts the line around the dot. */}
      {drawn && (
        <circle
          cx={cx}
          cy={mid}
          r={merge ? 4.5 : tip ? 4 : 3.25}
          fill={merge ? 'var(--ground)' : tip ? 'var(--ink)' : 'var(--ink-faint)'}
          stroke={merge ? 'var(--ink-muted)' : 'var(--ground)'}
          strokeWidth={2}
          data-station={merge ? 'merge' : tip ? 'tip' : 'commit'}
        />
      )}
    </svg>
  );
}

/* ---------------- the refs a commit carries ---------------- */

const REF_TITLE: Readonly<Record<DecoratedRef['kind'], string>> = {
  trunk: 'The trunk this repository settles onto.',
  run: "A run's own branch: every phase of that plan commits here.",
  lane: 'A lane branch: one phase of one run, merged back when the phase settles.',
  tag: 'A tag.',
  head: 'Where HEAD is.',
  branch: 'A branch nothing in the console claims.',
};

/** What a ref is, in words — a name is typed by people, so a run read off it is a reading. */
export function refBlurb({ kind, run }: DecoratedRef): string {
  if (!run) return REF_TITLE[kind];
  const read = `${run.slug}${run.phase === undefined ? '' : `, phase ${run.phase}`}`;
  return `${REF_TITLE[kind]} Read from the name as ${read}, which is a reading, not evidence.`;
}

/** The hover's words: the ref's name, then what it is. */
export const refTitle = (decorated: DecoratedRef): string => `${decorated.name}: ${refBlurb(decorated)}`;

/** One ref: a glyph for its kind and its name, the console's own ones in ink. */
export function RefName({ decorated }: { decorated: DecoratedRef }) {
  const Icon = decorated.kind === 'tag' ? Tag : GitBranch;
  const own = decorated.kind === 'trunk' || decorated.kind === 'head' || decorated.run !== undefined;
  return (
    <span
      data-testid="ref-name"
      data-kind={decorated.kind}
      title={refTitle(decorated)}
      className={cn(
        'inline-flex min-w-0 items-center gap-1 font-mono text-meta',
        own ? 'text-ink' : 'text-ink-muted',
      )}
    >
      <Icon size={11} aria-hidden className="shrink-0 text-ink-faint" />
      <span className="min-w-0 truncate">{decorated.name}</span>
    </span>
  );
}

/**
 * A commit's refs on one line — a row is one fixed height. The first ref git
 * names is drawn whole as far as the track allows and the rest are counted:
 * three refs shrunk side by side read as `m…`, `origi…`, `v6…`, which names
 * nothing. Every one of them is on the hover and in the panel's Refs.
 */
function RefLine({ refs, trunk }: { refs: readonly string[]; trunk: string | undefined }) {
  const [first, ...rest] = refs;
  if (first === undefined) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={refs.join('\n')}>
      <RefName decorated={decorateRef(first, trunk)} />
      {rest.length > 0 && (
        <span className="tnum shrink-0 text-meta text-ink-muted">
          +{rest.length}
          <span className="sr-only"> more</span>
        </span>
      )}
    </span>
  );
}

/* ---------------- the columns ---------------- */

/** The columns a row may draw beside the gutter and the subject, in the order they stand. */
export type GraphColumnId = 'refs' | 'author' | 'at' | 'commit';

const COLUMN_ORDER: readonly GraphColumnId[] = ['refs', 'author', 'at', 'commit'];
/** Which column goes first when the width runs out — the sha last of all, since it names the row. */
const COLUMN_PRIORITY: readonly GraphColumnId[] = ['commit', 'at', 'refs', 'author'];

/** Each column's track in pixels. The subject takes what is left and never less than `SUBJECT_MIN`. */
export const GRAPH_TRACK: Readonly<Record<GraphColumnId, number>> = {
  refs: 176,
  author: 144,
  at: 120,
  commit: 96,
};

export const SUBJECT_MIN = 200;

/** The gutter cell's start pad, as the arithmetic counts it (`--tile-pad-x`, comfortable). */
const GUTTER_PAD = 12;

/** The gutter's track: its lanes, and the cell's start pad. */
export const gutterTrack = (lanes: number): string => `calc(${lanes * LANE_W}px + var(--tile-pad-x))`;

/**
 * The columns a table this wide draws, cut by priority the way the grid cuts:
 * after the gutter and the subject's floor, each column in turn while it
 * fits, and the sha always. Everything draws every one of them; an unmeasured
 * table (no layout yet) draws every one of them too.
 */
export function graphColumns(width: number | undefined, everything: boolean, lanes: number): GraphColumnId[] {
  if (everything || width === undefined) return [...COLUMN_ORDER];
  let left = width - (lanes * LANE_W + GUTTER_PAD) - SUBJECT_MIN;
  const kept = new Set<GraphColumnId>();
  for (const id of COLUMN_PRIORITY) {
    if (id !== 'commit' && left < GRAPH_TRACK[id]) break;
    kept.add(id);
    left -= GRAPH_TRACK[id];
  }
  return COLUMN_ORDER.filter((id) => kept.has(id));
}

/** What the drawn columns ask of the table's width, so Everything scrolls rather than crushing the subject. */
export function graphMinWidth(columns: readonly GraphColumnId[], lanes: number): number {
  return columns.reduce((sum, id) => sum + GRAPH_TRACK[id], lanes * LANE_W + GUTTER_PAD + SUBJECT_MIN);
}

/* ---------------- one commit ---------------- */

export function CommitRow({
  row,
  incoming,
  lanes,
  columns,
  trunk,
  href,
  active,
  bare = false,
  onOpen,
}: {
  row: GraphRow;
  /** The row above's links — see `LaneCell`. */
  incoming: readonly GraphLink[];
  lanes: number;
  columns: readonly GraphColumnId[];
  trunk?: string;
  /** Where the row goes: this commit, inspected. */
  href: string;
  active: boolean;
  bare?: boolean;
  /** Show it now — the address may already name it, and following the same link moves nothing. */
  onOpen: (commit: RepoCommit) => void;
}) {
  const { commit } = row;
  return (
    <TR
      data-testid="commit-row"
      data-sha={commit.sha}
      aria-current={active ? 'true' : undefined}
      className={active ? 'bg-surface-raised' : undefined}
    >
      {/* `py-0` on both cells: the row is exactly `ROW_H` because the gutter's
          SVG is, and padding on top of the subject's 44 px floor would grow
          the row past the drawing and break every line at its boundary. */}
      <TD className="py-0 pe-0 align-middle" style={{ height: ROW_H, width: gutterTrack(lanes) }}>
        <LaneCell row={row} incoming={incoming} lanes={lanes} bare={bare} />
      </TD>
      <TD className="min-w-0 py-0 align-middle">
        <a
          href={href}
          data-row-link=""
          onClick={() => onOpen(commit)}
          aria-label={`Commit ${commit.short}: ${commit.subject}`}
          className="flex min-h-(--tap-min) w-full min-w-0 items-center text-start text-body text-ink hover:underline hover:decoration-ink-faint hover:underline-offset-2"
        >
          <span className="min-w-0 truncate" title={commit.subject}>
            {commit.subject}
          </span>
        </a>
      </TD>
      {columns.includes('refs') && (
        <TD className="align-middle" style={{ width: GRAPH_TRACK.refs }}>
          <RefLine refs={commit.refs} trunk={trunk} />
        </TD>
      )}
      {columns.includes('author') && (
        <TD className="align-middle text-meta text-ink-muted" style={{ width: GRAPH_TRACK.author }}>
          <span className="block min-w-0 truncate" title={commit.author}>
            {commit.author}
          </span>
        </TD>
      )}
      {columns.includes('at') && (
        <TD className="align-middle text-meta text-ink-muted" style={{ width: GRAPH_TRACK.at }}>
          <RelativeTime at={commit.at} live={false} />
        </TD>
      )}
      {columns.includes('commit') && (
        <TD className="align-middle" style={{ width: GRAPH_TRACK.commit }}>
          <Mono value={commit.short} title={commit.sha} />
        </TD>
      )}
    </TR>
  );
}

/**
 * The rows and the gutter's width for a graph answer.
 *
 * The cap is a drawing decision, not a data one: past `LANE_CAP` lanes the
 * gutter would outgrow the subject beside it, so the lanes past the cut are not
 * drawn and their count is said instead. Every commit still has its row, and a
 * dot whose lane is past the cut is not drawn.
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
