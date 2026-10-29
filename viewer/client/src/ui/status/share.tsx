import { WORD_ROWS, type StatusRow, type StatusView } from '@shared/status-model.js';
import { BOARD_STATE_UI, type BOARD_BUCKETS, type UiState } from '@shared/status-vocab.js';
import { DotWord } from './dot-word';
import type { Chrome } from './view';

/**
 * A plan's phases, counted — the legend of its line (design.md §7) drawn as
 * the family's badge: each share a count in words with its icon, and the
 * share done as a percentage, the line's readout.
 *
 * The PAINT is the line's own, never a second opinion: a share wears exactly
 * the hue its segment of the plan's line wears (`BOARD_STATE_UI`, the board's
 * paint table, which `screens/plans/track-bar.tsx` paints its segments from),
 * so a badge and the stretch of the line it names are one colour, and a stuck
 * share is amber in its legend because it is amber on the line. The icon and
 * what the word means are the board word's own row (`WORD_ROWS.board`); held
 * by QA is QA's fail, and never ran a skipped phase.
 *
 * A count asks nobody for anything — the plan's status beside it does that —
 * so a share carries no attention. Drawn inside a picture (the track's one
 * `role="img"`, whose name already reads every count), a caller passes
 * `tabIndex={-1}`: the badge keeps its tooltip for a pointer and a tap, and is
 * no tab stop of its own.
 */

type Bucket = (typeof BOARD_BUCKETS)[number];

/**
 * A share the line paints in a state: a board bucket, the gate's mark over
 * next up and waiting, a phase QA's verdict holds back, a phase a closed plan
 * never ran. What no bucket accounts for — the bare track — has no state, and
 * is said as a plain word beside the badges.
 */
export type ShareWord = Bucket | 'gated' | 'held-by-qa' | 'never';

/** The row a share takes its icon, tense and sentences from. */
function rowOf(share: ShareWord): StatusRow {
  if (share === 'held-by-qa') return WORD_ROWS['qa-result'].fail;
  if (share === 'never') return WORD_ROWS.phase.skipped;
  return WORD_ROWS.board[share];
}

/** The hue a share wears — the one its segment of the line wears. */
export function sharePaint(share: ShareWord): UiState {
  if (share === 'held-by-qa' || share === 'never') return rowOf(share).paint;
  return BOARD_STATE_UI[share];
}

/** What a share is called on its own — the board word's label, QA's hold, a phase that never ran. */
export function shareName(share: ShareWord): string {
  if (share === 'held-by-qa') return 'Held by QA';
  if (share === 'never') return 'Never ran';
  return WORD_ROWS.board[share].label;
}

function shareView(share: ShareWord, count: number, label?: string): StatusView {
  const row = rowOf(share);
  return {
    vocab: 'share',
    word: share,
    known: true,
    label: label ?? `${count} ${share === 'held-by-qa' ? 'held by QA' : shareName(share).toLowerCase()}`,
    icon: row.icon,
    paint: sharePaint(share),
    tense: row.tense,
    attention: 'none',
    ...(row.outcome ? { outcome: row.outcome } : {}),
    meaning: row.meaning,
    next: row.next,
  };
}

/** One share of a plan's phases as a badge — "41 done", "1 held by QA". */
export function PhaseShare({
  share,
  count,
  label,
  chrome = 'badge',
  ...rest
}: {
  share: ShareWord;
  count: number;
  /** The legend's own words for it; by default the count and the board word. */
  label?: string;
} & Omit<Chrome, 'live' | 'withNote'>) {
  return (
    <DotWord
      view={shareView(share, count, label)}
      chrome={chrome}
      withNote={false}
      data-share={share}
      data-count={count}
      {...rest}
    />
  );
}

/**
 * The share of a plan's phases that are done, as a badge in done's hue —
 * "56 %". It goes quiet once the plan is over (`settled`), the way a settled
 * badge does: its hue kept at a lighter outline.
 */
export function PlanProgress({
  percent,
  settled = false,
  chrome = 'badge',
  ...rest
}: { percent: number; settled?: boolean } & Omit<Chrome, 'live' | 'withNote'>) {
  const done = WORD_ROWS.board.done;
  const view: StatusView = {
    vocab: 'progress',
    word: 'percent',
    known: true,
    label: `${percent} %`,
    icon: WORD_ROWS.verification.green.icon,
    paint: done.paint,
    tense: settled ? 'settled' : 'standing',
    attention: 'none',
    ...(settled ? { outcome: 'ok' as const } : {}),
    meaning: 'The share of the plan’s phases that are done.',
    next: settled ? 'Nothing to do: the plan is over.' : 'It grows as each phase’s handoff lands complete.',
  };
  return <DotWord view={view} chrome={chrome} withNote={false} data-percent={percent} {...rest} />;
}
