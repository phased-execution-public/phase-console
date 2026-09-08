import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { BOARD_STATES, boardLabel, boardStateTitle, boardUiState, type BoardState } from '@/lib/status-vocab';
import { Badge, badgeVariants, type BadgeTone } from './badge';
import { StatusBadge } from './status-badge';

/**
 * `Chip` — a thin alias over `Badge`, kept for the 2.x views until Phase 11
 * deletes them. New code uses `Badge` (a word), `StatusBadge` (a state) or
 * `CountBadge` (a number) directly.
 *
 * The old tone axis is mapped onto the vocabulary's tone families: `busy` is
 * live (running), `warn`/`gate`/`stuck` all meant "a person is needed" and are
 * the accent, `bad` is failed. The colours therefore come from the same eight
 * tokens every new badge paints with — there is no second palette here.
 */

/** The 2.x tone words → the Badge tone families. */
export const LEGACY_TONE: Readonly<Record<string, BadgeTone>> = Object.freeze({
  neutral: 'neutral',
  ok: 'ok',
  busy: 'live',
  bad: 'bad',
  warn: 'accent',
  gate: 'accent',
  stuck: 'accent',
  state: 'state',
  /* The vocabulary's own family names pass straight through. */
  live: 'live',
  wait: 'wait',
  accent: 'accent',
  solid: 'solid',
});

export type ChipTone = keyof typeof LEGACY_TONE | undefined;

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
  mono?: boolean;
  /** Show the leading dot. */
  dot?: boolean;
}

/** The class a 2.x caller composed by hand. Prefer `badgeVariants`. */
export const chipVariants = ({ tone, mono }: { tone?: ChipTone; mono?: boolean } = {}) =>
  badgeVariants({ tone: LEGACY_TONE[tone ?? 'neutral'] ?? 'neutral', mono: mono ?? false });

export function Chip({ className, tone, mono, dot = false, children, ...props }: ChipProps) {
  return (
    <Badge
      tone={LEGACY_TONE[tone ?? 'neutral'] ?? 'neutral'}
      mono={mono ?? false}
      dot={dot}
      className={cn(className)}
      {...props}
    >
      {children}
    </Badge>
  );
}

/**
 * Phase states, as the engine names them — the KEYS of the shared board table,
 * never a second list. This was a hand-written copy of those seven words sitting
 * in a client that already imported them; two lists that agree today are two
 * lists that disagree the day a word is added.
 */
export const PHASE_STATES: readonly BoardState[] = BOARD_STATES;

export type PhaseState = BoardState;

/**
 * The engine's state strings arrive as plain `string` off the wire, and an
 * unknown one must still paint *something* — `waiting` is the honest default
 * ("we do not know that this can start"), and it is never amber, so an
 * unrecognised state can never be mistaken for an actionable one.
 */
export function asPhaseState(value: string | undefined): PhaseState {
  return (PHASE_STATES as readonly string[]).includes(value ?? '') ? (value as PhaseState) : 'waiting';
}

/**
 * A board state as a `StatusBadge` — the 2.x `StateChip` signature over the
 * vocabulary: the board word becomes its UI state, the label is the plain
 * word ("Next up" for ready), and the hover explains the board state itself.
 *
 * **`pulse` is declared, and it is not optional decoration.** The board word
 * `in-progress` comes from `phase_status()` grepping `^status:` out of a
 * markdown file, and `BOARD_STATE_UI` paints it `running`. A breathing chip
 * over a sentence somebody typed is the whole of B2(a) — so this forwards
 * `pulse`, `StatusBadge` honours it for `running` alone, and every caller must
 * pass a LIVE FACT (`PhaseView.live`), never the board word it already has.
 * Passing nothing is the safe default and stays the default.
 */
export function StateChip({
  state,
  label,
  board: _board,
  dot: _dot,
  className,
  title,
  ...props
}: {
  state: PhaseState | string;
  label?: string;
  /** 2.x: "use the departures vocabulary". The vocabulary is plain words now; accepted and ignored. */
  board?: boolean;
  /** Breathe. Only ever from an observed live fact — see the note above. */
  pulse?: boolean;
} & Omit<ChipProps, 'tone' | 'children'>) {
  const resolved = asPhaseState(state);
  return (
    <StatusBadge
      state={boardUiState(resolved)}
      label={label ?? boardLabel(resolved)}
      title={title ?? boardStateTitle(resolved)}
      className={className}
      {...props}
    />
  );
}
