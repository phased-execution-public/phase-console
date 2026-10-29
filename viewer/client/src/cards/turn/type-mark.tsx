/**
 * The type's mark (turn-by-turn phase 8) — Approval · Task · Decision ·
 * Heads-up, a glyph and a word, never a colour. Its own file since phase 10:
 * the rows of the Runs home and the bell draw it too, without the card.
 *
 * On the card's head it is a PLATE (Tower strips, 2026-10-20): the same glyph
 * and word in ink on the deep ground, a box that tells the type apart from the
 * status badges beside it without borrowing their hues — a type is what the
 * item IS, never how it stands.
 */

import { CircleHelp, Info, ListChecks, Split, Stamp, type LucideIcon } from 'lucide-react';
import { TYPE_META, type ItemType } from '@shared/turn-model.js';
import { cn } from '@/lib/cn';

/** Each type's glyph — the mark is a shape and a word, never a colour. */
const TYPE_ICON: Readonly<Record<ItemType, LucideIcon>> = Object.freeze({
  approve: Stamp,
  do: ListChecks,
  decide: Split,
  know: Info,
});

/** The type's mark: its glyph and its word — on a neutral plate where `plate` (the card's head). */
export function TypeMark({ type, plate = false }: { type: ItemType | undefined; plate?: boolean }) {
  const Icon = (type && TYPE_ICON[type]) ?? CircleHelp;
  const meta = type ? TYPE_META[type] : undefined;
  return (
    <span
      data-testid="turn-type"
      data-type={type ?? ''}
      data-plate={plate ? '' : undefined}
      title={meta?.sense}
      className={cn(
        'inline-flex items-center gap-1.5 text-meta font-medium text-ink',
        plate && 'rounded-sm bg-ground-deep px-1.5 py-px',
      )}
    >
      <Icon size={14} aria-hidden className={cn('shrink-0', plate ? 'text-ink' : 'text-ink-muted')} />
      {meta?.label ?? 'Item'}
    </span>
  );
}
