/**
 * Guide markdown, with every status word dressed as its real badge.
 *
 * Markdown cannot colour `halted` the way the app paints it, and a glossary in
 * plain text asks the reader to imagine the mapping. After the sanitizer has
 * filled the DOM, every inline-code or bold token that IS a status word —
 * including the departures spellings, Departed / Boarding / Held — gets the
 * exact class and hover title its badge carries, from the same status model
 * the badges draw (`wearStatusWord`). Unknown words are left alone.
 *
 * The ordering invariant is why this is ONE component rather than a `<Markdown>`
 * beside an effect: `Markdown` fills the DOM in an effect, and this reads that
 * DOM in an effect. React runs a child's effects before its parent's, in every
 * commit and both StrictMode passes — so co-locating them makes the order true
 * however and whenever a card mounts. As siblings, the decoration would race the
 * render it depends on.
 *
 * One of these per card, not one per section: each walk is scoped to its own
 * subtree instead of re-walking all of `reference.md`, and a card that ever
 * mounts late still decorates itself. The walk only writes where
 * `wearStatusWord` returns a match, so running it twice is a no-op.
 */

import { useEffect, useRef } from 'react';
import { describeWord } from '@shared/status-model.js';
import { Markdown } from '@/components/markdown';
import { badgeVariants } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import { isUiState, uiStateTitle, wordTitle, type UiState } from '@/lib/status-vocab';

/** The vocabularies a glossary word is looked up in, in the order the Guide reads them. */
const GUIDE_VOCABS = ['run', 'phase', 'board'] as const;

/**
 * The paint a bare status WORD wears: one of the eight paints names itself (the
 * glossary's eight-states table), and any other word is its vocabulary's view
 * in the status model — `halted` is the run row's quiet wait, never amber,
 * because amber is a summons and a word alone never is one. A word no
 * vocabulary holds answers null, never a guess.
 */
function paintOfWord(word: string): UiState | null {
  if (isUiState(word)) return word;
  for (const vocab of GUIDE_VOCABS) {
    const view = describeWord(vocab, word);
    if (view.known) return view.paint;
  }
  return null;
}

/**
 * Dress a bare status WORD in its badge's clothes — the family's class and a
 * hover title that says what it means and what to do. For the Guide's status
 * tables and headings, which are markdown and cannot colour a word; never a
 * `data-status`, because a word in prose draws no icon and is no badge.
 */
export function wearStatusWord(word: string): { className: string; title: string } | null {
  const paint = paintOfWord(word);
  if (!paint) return null;
  return {
    className: cn(badgeVariants({ tone: 'state', mono: true }), `state-${paint}`),
    title: wordTitle(word) ?? uiStateTitle(paint) ?? '',
  };
}

export function StatusProse({ text, className }: { text?: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const el of root.querySelectorAll('code, strong')) {
      const worn = wearStatusWord(el.textContent ?? '');
      if (!worn) continue;
      el.className = worn.className;
      el.setAttribute('title', worn.title);
    }
  }, [text]);

  if (!text?.trim()) return null;
  return (
    <div ref={ref}>
      <Markdown text={text} className={className} />
    </div>
  );
}
