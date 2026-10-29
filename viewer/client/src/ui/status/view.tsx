import type { HTMLAttributes } from 'react';
import type { StatusView, StatusVocab, WORD_ROWS } from '@shared/status-model.js';

/**
 * What every member of the family shares: the typing of a word, the chrome a
 * caller may pass, and the one sentence a hover says.
 *
 * The members (`RunStatus`, `QaStatus`, …) exist so a caller cannot hand the
 * renderer a word from the wrong vocabulary — each types its word from the
 * model's own table for that vocabulary. `DotWord` takes a finished view and
 * asks nothing.
 */

/** The words of one vocabulary, typed from the model's table for it (which the node suite holds equal to the owner list). */
export type WordOf<V extends StatusVocab> = Extract<keyof (typeof WORD_ROWS)[V], string>;

/** What every member accepts besides its word. */
export interface Chrome extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** `sm` is the meta size (12.5 px), `md` the body size (14 px). */
  size?: 'sm' | 'md';
  /** This thing is being OBSERVED live. Honoured only for a live view painted running — the one thing that may breathe. */
  live?: boolean;
  /** Draw the view's fact (a count, a reason) beside the word. Default yes. */
  withNote?: boolean;
  /**
   * `dot` (the default) is a 6 px dot and a word. `badge` is the same view as
   * a bordered pill — the status's icon and word in its hue, never a fill —
   * for the status of a plan or a phase where it is the row's headline
   * (#361, design.md §1 rule 4). A settled badge keeps its hue, muted, so
   * Done and Complete do not read as grey text. `tint` is the LEAD badge of a
   * strip or a card (2026-10-20, Tower strips): the same pill on its state's
   * tint, its icon in the vivid hue, its word in the state's own — one per row
   * or card, the thing the row is about (design.md §3.2).
   */
  chrome?: 'dot' | 'badge' | 'tint';
}

/** The tooltip's first line: the word, its fact, and whether it asks for you. */
export function viewHeadline(view: StatusView): string {
  if (!view.known) return view.label;
  const parts = [view.label, view.note?.text].filter(Boolean).join(', ');
  if (view.attention === 'urgent') return `${parts} — urgent: this needs you now.`;
  if (view.attention === 'needs-you') return `${parts} — this needs you.`;
  return parts;
}

/**
 * Everything a hover says, as one plain string — the headline, what the word
 * means here and what comes next (#365). The family's tooltip draws the same
 * parts; this is for a surface that can carry only a line of text.
 */
export function viewTitle(view: StatusView): string {
  return [viewHeadline(view), view.meaning, view.next].filter(Boolean).join(' ');
}

/**
 * A settled thing goes quiet — a hollow dot, the word in muted ink — unless it
 * ended badly: a failed or partial outcome keeps its hue, because a bad ending
 * is still a signal (design.md §3).
 */
export function isQuiet(view: Pick<StatusView, 'tense' | 'outcome'>): boolean {
  return view.tense === 'settled' && view.outcome !== 'failed' && view.outcome !== 'partial';
}
