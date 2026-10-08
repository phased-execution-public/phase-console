/**
 * The item row, loaded when a surface first draws one (control-tower phase
 * 139, #216).
 *
 * The Tower, the halt card and the run page draw a person's ask through
 * `item-row.tsx`, which carries the human-step card's glyphs, verbs and
 * terminal sheet — so they reach it through this door, and a page with no ask
 * on it never downloads them. While it loads, the row says what it is and
 * where it lives: the link is the one thing a reader needs from it at once.
 */

import { lazy, Suspense } from 'react';
import type { ItemRowProps } from './item-row';
import { itemHref } from './surfaces';

const Row = lazy(() => import('./item-row'));

export function LazyItemRow(props: ItemRowProps) {
  return (
    <Suspense
      fallback={
        props.primaryOnly ? null : (
          <a href={itemHref(props.row)} data-testid="item-row-pending" className="tap-row text-xs text-ink">
            {props.row.humanStep?.title ?? props.row.title}
          </a>
        )
      }
    >
      <Row {...props} />
    </Suspense>
  );
}
