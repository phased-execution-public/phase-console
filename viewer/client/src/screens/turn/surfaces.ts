/**
 * Where a surface finds the item it draws (control-tower phase 139, #216,
 * §Architecture 19 "how each surface moves in").
 *
 * The helpers live in `@/data/turn` (since quiet-console phase 7, where the
 * Runs home and the cards read them); this module keeps the one that spells
 * an address — the item's place on the page — and re-exports the rest for a
 * reader that starts from the screen.
 */

import type { InboxItem } from '@/data/api';
import { itemIdOf } from '@/data/turn';
import { turnHref } from '@/shell/routes';

export {
  approvalRows,
  asksNow,
  errandRow,
  gateRow,
  itemIdOf,
  itemRows,
  itemsNow,
  runItems,
} from '@/data/turn';

type Row = Pick<InboxItem, 'id' | 'turn'>;

/** The item's place on the page, `#/turn/<id>`. */
export function itemHref(row: Row): string {
  return turnHref(itemIdOf(row));
}
