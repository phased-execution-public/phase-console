/**
 * Selecting many inbox items at once.
 *
 * ## Why this is a `Set` of ids and not a list of indices
 *
 * The inbox refetches constantly — `service-live.ts` fires an `inbox` event,
 * debounced to 400ms, whenever any of its dozen sources moves — and every
 * refetch can reorder the list, because `sortInbox` ranks by severity and then
 * by age. An index-based selection would silently drift onto other rows
 * between the press and the release. Ids do not: `inboxItemId` is injective
 * and stable by construction ("identity is WHAT is asking, never WHEN").
 *
 * ## Why it prunes
 *
 * The other half of the same fact: an item that has been answered leaves the
 * list. A selection holding ids that no longer exist would report "12
 * selected" over eight rows and then acknowledge four things that are not
 * there. So the set is intersected with what is on screen on every render.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

/** Where a range extends from, and what the tri-state box should draw. */
export type SelectionState = 'none' | 'some' | 'all';

export interface Selection {
  /** Ids currently picked, already pruned to what is on screen. */
  ids: string[];
  has: (id: string) => boolean;
  count: number;
  state: SelectionState;
  /** Toggle one. `extend` picks the whole run from the last press to this one. */
  toggle: (id: string, extend?: boolean) => void;
  /** Everything on screen, or nothing — whichever the current state is not. */
  toggleAll: () => void;
  clear: () => void;
  /** Put a set back, which is what Undo does after a bulk acknowledge. */
  restore: (ids: string[]) => void;
}

export function useSelection(ordered: readonly { id: string }[]): Selection {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  // The anchor for a shift-press. Kept in a ref because moving it must never
  // be a reason to paint.
  const anchor = useRef<string | null>(null);

  const order = useMemo(() => ordered.map((row) => row.id), [ordered]);

  // Pruned on read rather than in an effect: an effect would let one paint
  // through where the count disagrees with the rows under it.
  const ids = useMemo(() => order.filter((id) => picked.has(id)), [order, picked]);

  const toggle = useCallback(
    (id: string, extend = false) => {
      setPicked((prev) => {
        const next = new Set(prev);
        const from = anchor.current;
        const a = from ? order.indexOf(from) : -1;
        const b = order.indexOf(id);

        if (extend && a >= 0 && b >= 0) {
          // A range press adds the run; it never removes one. Shift-clicking
          // across a stretch you have already picked should not unpick it —
          // that reads as the selection fighting you.
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (const between of order.slice(lo, hi + 1)) next.add(between);
          return next;
        }

        if (!next.delete(id)) next.add(id);
        anchor.current = id;
        return next;
      });
    },
    [order],
  );

  const toggleAll = useCallback(() => {
    setPicked((prev) => {
      const allPicked = order.length > 0 && order.every((id) => prev.has(id));
      anchor.current = null;
      return allPicked ? new Set() : new Set(order);
    });
  }, [order]);

  const clear = useCallback(() => {
    anchor.current = null;
    setPicked(new Set());
  }, []);

  const restore = useCallback((next: string[]) => setPicked(new Set(next)), []);

  const state: SelectionState = ids.length === 0 ? 'none' : ids.length === order.length ? 'all' : 'some';

  return {
    ids,
    has: (id: string) => picked.has(id),
    count: ids.length,
    state,
    toggle,
    toggleAll,
    clear,
    restore,
  };
}

/**
 * The verbs every one of these items offers.
 *
 * A bulk button that works on nine of twelve rows is worse than one that is
 * not there: the press reports success and three asks are still waiting. So
 * the bar shows the INTERSECTION, and a verb one item cannot do is a verb
 * nobody is offered. A flagged action (its capability is off) counts as not
 * offered, for the same reason it is unpressable on the row.
 */
export function sharedVerbs(items: { actions?: { verb: string; label: string; flag?: string }[] }[]): {
  verb: string;
  label: string;
}[] {
  if (!items.length) return [];
  const [first, ...rest] = items;
  const pressable = (item: (typeof items)[number]) => (item.actions ?? []).filter((action) => !action.flag);

  let common = pressable(first).map((action) => ({ verb: action.verb, label: action.label }));
  for (const item of rest) {
    const verbs = new Set(pressable(item).map((action) => action.verb));
    common = common.filter((action) => verbs.has(action.verb));
    if (!common.length) break;
  }
  return common;
}
