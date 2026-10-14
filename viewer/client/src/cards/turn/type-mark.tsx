/**
 * The type's mark (turn-by-turn phase 8) — Approval · Task · Decision ·
 * Heads-up, a glyph and a word, never a colour. Its own file since phase 10:
 * the rows of the Runs home and the bell draw it too, without the card.
 */

import { CircleHelp, Info, ListChecks, Split, Stamp, type LucideIcon } from 'lucide-react';
import { TYPE_META, type ItemType } from '@shared/turn-model.js';

/** Each type's glyph — the mark is a shape and a word, never a colour. */
const TYPE_ICON: Readonly<Record<ItemType, LucideIcon>> = Object.freeze({
  approve: Stamp,
  do: ListChecks,
  decide: Split,
  know: Info,
});

/** The type's mark: its glyph and its word. */
export function TypeMark({ type }: { type: ItemType | undefined }) {
  const Icon = (type && TYPE_ICON[type]) ?? CircleHelp;
  const meta = type ? TYPE_META[type] : undefined;
  return (
    <span
      data-testid="turn-type"
      data-type={type ?? ''}
      title={meta?.sense}
      className="inline-flex items-center gap-1.5 text-meta font-medium text-ink"
    >
      <Icon size={14} aria-hidden className="shrink-0 text-ink-muted" />
      {meta?.label ?? 'Item'}
    </span>
  );
}
