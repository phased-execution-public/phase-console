/**
 * Guide markdown, with every status word drawn the way the console draws it.
 *
 * Markdown cannot colour `halted` the way a page paints it, and a glossary in
 * plain text asks the reader to imagine the mapping. After the sanitizer has
 * filled the DOM, every inline-code or bold token that IS a status word —
 * including the departures spellings, Departed / Boarding / Held — is drawn as
 * the status family draws a word (`ui/status`): a 6 px dot painted through
 * `.state-<paint>` beside the word in ink, and the hover title the word carries
 * everywhere else. Unknown words are left alone.
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
 * mounts late still decorates itself. The walk remembers what it has drawn, so
 * running it twice over the same DOM is a no-op.
 */

import { useEffect, useRef } from 'react';
import { describeWord } from '@shared/status-model.js';
import type { UiState } from '@shared/status-vocab.js';
import { cn } from '@/lib/cn';
import { isUiState, uiStateTitle, wordTitle } from '@/lib/status-vocab';
import { Markdown } from '@/ui/markdown';

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

/** The family's dot (`ui/status/dot-word.tsx`): its hue is whatever `.state-<paint>` the word around it sets. */
export const STATUS_WORD_DOT = 'inline-block size-1.5 shrink-0 rounded-full bg-state';

/**
 * Dress a bare status WORD as the family draws one — the dot's paint and a
 * hover title that says what it means and what to do. For the Guide's tables
 * and headings, which are markdown and cannot colour a word. The chip prose
 * draws around inline code goes: a status is a dot and a word, never a box
 * behind the text.
 */
export function wearStatusWord(word: string): { className: string; title: string } | null {
  const paint = paintOfWord(word);
  if (!paint) return null;
  return {
    className: cn(
      'inline-flex items-center gap-1.5 whitespace-nowrap rounded-none border-0 bg-transparent p-0 text-ink',
      `state-${paint}`,
    ),
    title: wordTitle(word) ?? uiStateTitle(paint) ?? '',
  };
}

/** The elements already drawn — a fresh render's elements are new ones, so this never holds a stale node. */
const worn = new WeakSet<Element>();

function dot(): HTMLElement {
  const mark = document.createElement('i');
  mark.setAttribute('aria-hidden', 'true');
  mark.className = STATUS_WORD_DOT;
  return mark;
}

export function StatusProse({ text, className }: { text?: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const el of root.querySelectorAll('code, strong')) {
      // A fenced block's line is a command to copy, not a word to read.
      if (worn.has(el) || el.closest('pre')) continue;
      const dressed = wearStatusWord(el.textContent ?? '');
      if (!dressed) continue;
      el.className = dressed.className;
      el.setAttribute('title', dressed.title);
      el.prepend(dot());
      worn.add(el);
    }
  }, [text]);

  if (!text?.trim()) return null;
  return (
    <div ref={ref}>
      <Markdown text={text} className={className} />
    </div>
  );
}
