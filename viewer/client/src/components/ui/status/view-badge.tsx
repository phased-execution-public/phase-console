import type { HTMLAttributes } from 'react';
import {
  FACT_META,
  type StatusFact,
  type StatusView,
  type StatusVocab,
  type WORD_ROWS,
} from '@shared/status-model.js';
import { cn } from '@/lib/cn';
import { badgeVariants } from '../badge';
import { statusIcon } from './status-icons';

/**
 * The one renderer every badge of the family draws through — a `StatusView`
 * from `shared/status-model.js`, worn on the existing badge core.
 *
 * It ALWAYS draws an icon and a word, and always carries the three facts a test
 * or a stylesheet asks of a status: `data-status` (the word as given),
 * `data-paint` (the hue, worn as `.state-<paint>`) and `data-attention` (does a
 * person have to act). Colour is never the only carrier (WCAG 1.4.1): a badge
 * whose paint you cannot see still says what it is.
 *
 * The wrappers (`RunStatusBadge`, `QaBadge`, …) exist so a caller cannot hand a
 * badge a word from the wrong vocabulary — each types its word from the model's
 * own table for that vocabulary. This renderer takes a finished view and asks
 * nothing.
 */

/** The words of one vocabulary, typed from the model's table for it (which the node suite holds equal to the owner list). */
export type WordOf<V extends StatusVocab> = Extract<keyof (typeof WORD_ROWS)[V], string>;

/** What every badge of the family accepts besides its word. */
export interface BadgeChrome extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  size?: 'sm' | 'md';
  mono?: boolean;
  /** Breathe — honoured only for a live thing painted running, and only while it is live. */
  pulse?: boolean;
  /** Draw the view's fact (a count, a reason) inside the badge. Default yes. */
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

/** A view's fact, as the family draws it: its own icon, its own paint. */
export function FactPart({ fact, size = 'sm' }: { fact: StatusFact; size?: 'sm' | 'md' }) {
  const meta = FACT_META[fact.kind];
  const Icon = statusIcon(meta.icon);
  return (
    <span
      data-fact={fact.kind}
      className={cn('inline-flex items-center gap-1 text-state', `state-${fact.paint ?? meta.paint}`)}
    >
      <Icon size={size === 'md' ? 12 : 10} strokeWidth={2.25} aria-hidden className="shrink-0" />
      {fact.text}
    </span>
  );
}

export function ViewBadge({
  view,
  size = 'sm',
  mono = false,
  pulse = false,
  withNote = true,
  className,
  title,
  ...props
}: { view: StatusView } & BadgeChrome) {
  const Icon = statusIcon(view.icon);
  const note = withNote ? view.note : undefined;
  return (
    <span
      data-status={view.word ?? ''}
      data-paint={view.paint}
      data-attention={view.attention}
      data-vocab={view.vocab}
      className={cn(badgeVariants({ tone: 'state', size, mono }), `state-${view.paint}`, className)}
      title={title ?? viewTitle(view)}
      {...props}
    >
      <Icon
        size={size === 'md' ? 13 : 11}
        strokeWidth={2.25}
        aria-hidden
        className={cn(
          'shrink-0',
          pulse && view.tense === 'live' && view.paint === 'running' && 'animate-pulse-soft',
        )}
      />
      {view.label}
      {note && (
        <>
          {/* A divider, not a middle dot: the fact is a second datum, and a
              screen reader hears the comma the eye sees as a rule. */}
          <span className="sr-only">, </span>
          <span aria-hidden className="mx-0.5 h-3 w-px shrink-0 bg-current opacity-35" />
          <FactPart fact={note} size={size} />
        </>
      )}
    </span>
  );
}
