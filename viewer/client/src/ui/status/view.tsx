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
}

/** One line a hover can carry: the word, its fact, and whether it asks for you. */
export function viewTitle(view: StatusView): string {
  if (!view.known) {
    return view.word == null || view.word === ''
      ? 'No status was given here.'
      : `“${view.word}” is not a word this console knows here.`;
  }
  const parts = [view.label, view.note?.text].filter(Boolean).join(', ');
  if (view.attention === 'urgent') return `${parts} — urgent: this needs you now.`;
  if (view.attention === 'needs-you') return `${parts} — this needs you.`;
  return parts;
}

/**
 * A settled thing goes quiet — a hollow dot, the word in muted ink — unless it
 * ended badly: a failed or partial outcome keeps its hue, because a bad ending
 * is still a signal (design.md §3).
 */
export function isQuiet(view: Pick<StatusView, 'tense' | 'outcome'>): boolean {
  return view.tense === 'settled' && view.outcome !== 'failed' && view.outcome !== 'partial';
}
