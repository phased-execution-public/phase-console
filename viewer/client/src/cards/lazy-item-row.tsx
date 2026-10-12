/**
 * The item row, loaded when a surface first draws one (control-tower phase
 * 139, #216).
 *
 * A surface that may hold a person's ask draws it through `item-row.tsx`,
 * which carries the human-step card's glyphs, verbs and terminal sheet — so it
 * reaches the row through this door, and a page with no ask on it never
 * downloads them. While the row loads it says what it is and where it lives:
 * the link is the one thing a reader needs from it at once.
 */

import { lazy, Suspense } from 'react';
import { itemIdOf } from '@/data/turn';
import { turnHref } from '@/shell/routes';
import type { ItemRowProps } from './item-row';

const Row = lazy(() => import('./item-row'));

export function LazyItemRow(props: ItemRowProps) {
  return (
    <Suspense
      fallback={
        props.primaryOnly ? null : (
          <a
            href={turnHref(itemIdOf(props.row))}
            data-testid="item-row-pending"
            className="tap-row text-body text-ink"
          >
            {props.row.humanStep?.title ?? props.row.title}
          </a>
        )
      }
    >
      <Row {...props} />
    </Suspense>
  );
}
