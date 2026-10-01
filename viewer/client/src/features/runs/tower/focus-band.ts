/**
 * `?focus=` has to move something.
 *
 * `app/routes.ts` redirects `#/ready` → `#/now?focus=next` and `#/pulse` →
 * `#/now?focus=lanes`, and says in a comment that both "kept their whole
 * meaning by keeping their `?focus=`". They did not: `focused` reached a
 * `data-focused` attribute and nothing else — no CSS rule anywhere targeted it
 * and no scroll was ever performed. Two shipped addresses, one of them the
 * target of a redirect the router documents, landed at the top of Now exactly
 * as `#/now` does. A deep link that lands somewhere other than it names is the
 * defect class `#/plan/x/autopilot` already cost this project once.
 *
 * So the band gets a ref, and arriving focused scrolls it into the shell's one
 * scroller. `data-focused` stays: it is what the tests read, and it is the hook
 * a later stylesheet would use to flash the band.
 */

import { useEffect, useRef } from 'react';
import { scrollIntoScroller } from '@/lib/scroll';

/**
 * A ref for a band that `?focus=` can name. Scrolls it to the top of its own
 * scroller when `focused` turns true — once per arrival, not on every render,
 * because a band that re-scrolls while you are reading it is worse than one
 * that never scrolled.
 *
 * NEVER `scrollIntoView`: it moves every scrollable ancestor, including the
 * horizontal one on a phone. `scrollIntoScroller` moves exactly the one that
 * owns the element (`lib/scroll.ts`).
 */
export function useFocusBand<T extends HTMLElement>(focused: boolean) {
  const ref = useRef<T>(null);
  const wasFocused = useRef(false);
  useEffect(() => {
    if (focused && !wasFocused.current && ref.current) {
      scrollIntoScroller(ref.current, 'start');
    }
    wasFocused.current = focused;
  }, [focused]);
  return ref;
}
