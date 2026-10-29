import { useCallback, useEffect, useRef } from 'react';

/**
 * A drawer that never narrows while it is open (2026-10-20). Its width
 * follows its content — `max-content`, inside its measure (`.sheet-fit` in
 * `styles/theme.css`) — but a section folding or data arriving must not pull
 * the text from under the reader. A ResizeObserver remembers the widest the
 * drawer has been and holds it there as `--sheet-settled`, the floor
 * `.sheet-fit` reads; the measure's own bounds and the viewport still cap it.
 * A drawer opened afresh is a fresh element, so it fits its own content again;
 * one that stays (the panel's column) lets go when `subject` changes — a new
 * record is a new fit — without remounting, so focus inside it stays put.
 *
 * A ref callback: hand it to the drawer's box. `enabled` is false for a side
 * whose width is the screen's (a bottom sheet, a full one) or a person's.
 */
export function useSettledWidth<T extends HTMLElement>(
  enabled: boolean,
  subject?: string,
): (node: T | null) => void {
  const watch = useRef<ResizeObserver | null>(null);
  const box = useRef<T | null>(null);
  const widest = useRef(0);
  useEffect(() => {
    widest.current = 0;
    box.current?.style.removeProperty('--sheet-settled');
  }, [subject, enabled]);
  return useCallback(
    (node: T | null) => {
      watch.current?.disconnect();
      watch.current = null;
      box.current = node;
      if (!node || !enabled || typeof ResizeObserver === 'undefined') return;
      watch.current = new ResizeObserver(() => {
        const width = node.getBoundingClientRect().width;
        if (width <= widest.current + 0.5) return;
        widest.current = width;
        node.style.setProperty('--sheet-settled', `${Math.round(width)}px`);
      });
      watch.current.observe(node);
    },
    [enabled],
  );
}
