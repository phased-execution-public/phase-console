/**
 * Where an older surface finds the item it draws (control-tower phase 139,
 * #216, §Architecture 19 "how each surface moves in").
 *
 * Six surfaces drew a person's ask each in a shape of its own: the approval
 * queue and its question card, the gate card, the errand card, the launch
 * door's list and the Needs-you bay's loose rows. Now each draws the ITEM —
 * the row variant (`item-row.tsx`) and a link to its place on Your turn. The
 * item is already on the wire: every inbox row that asks a person for an act
 * carries its `turn` view (`server/turn/fold.ts`), an errand and the step it
 * describes folded into ONE item. So a surface needs no read of its own; it
 * picks its rows out of the inbox it already holds, with these helpers.
 *
 * Small and pure on purpose: the Tower and the halt card are first paint, so
 * the row itself is reached through `lazy-item-row.tsx`, and only this file
 * rides along with them.
 */

import { turnHref } from '@/app/routes';
import type { InboxItem } from '@/lib/api';

type Row = Pick<InboxItem, 'id' | 'turn'>;

/** The item a row stands for: its turn view's id, else — a projected card — the row's own. */
export function itemIdOf(row: Row): string {
  return row.turn?.item ?? row.id;
}

/** The item's place on the page, `#/turn/<id>`. */
export function itemHref(row: Row): string {
  return turnHref(itemIdOf(row));
}

/**
 * Does this row ask a person for an act NOW — an item of *Do now* or *Needs
 * one detail from you*? Not one coming up, being checked or done, and never an
 * `fyi` row: the page leaves those out too (`server/turn/index.ts`), and a
 * plan-wide note (a clash zone, an idle plan) asks nobody to press anything.
 */
export function asksNow(row: Pick<InboxItem, 'turn' | 'severity'>): boolean {
  const group = row.turn?.group;
  return row.severity !== 'fyi' && (group === 'now' || group === 'decide');
}

/**
 * One row per item, oldest first. An errand row and its step's row are ONE
 * item; the ledger's row is the one drawn, because its step view carries the
 * kind's own verbs (open, check) where the errand row has only the ladder's.
 */
export function itemRows<T extends Pick<InboxItem, 'id' | 'turn' | 'kind' | 'since'>>(
  rows: readonly T[],
): T[] {
  const byItem = new Map<string, T>();
  for (const row of rows) {
    if (!row.turn) continue;
    const id = itemIdOf(row);
    const held = byItem.get(id);
    if (!held || (held.kind !== 'human-step' && row.kind === 'human-step')) byItem.set(id, row);
  }
  return [...byItem.values()].sort((a, b) => stamp(a.since) - stamp(b.since));
}

/** A row with no clock (a gate, a QA verdict) sorts LAST, as the inbox's own order puts it. */
const stamp = (iso: string | undefined): number => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
};

/** The items a person owes now, one row each, oldest first — *Your turn (n)* counts these. */
export function itemsNow<T extends Pick<InboxItem, 'id' | 'turn' | 'kind' | 'since' | 'severity'>>(
  rows: readonly T[],
): T[] {
  return itemRows(rows.filter(asksNow));
}

type Scope = { runId?: string | undefined; slug?: string | undefined };

/** Is this row about that run (by id) or that plan (by slug)? A run's own rule: the id wins when both have one. */
function inScope(row: Pick<InboxItem, 'runId' | 'slug'>, scope: Scope): boolean {
  if (scope.runId && row.runId) return row.runId === scope.runId;
  return !scope.slug || row.slug === scope.slug;
}

/**
 * The approval queue's items: every broker card and relayed question that
 * asks now, of that run or that plan (every one when no scope is named).
 */
export function approvalRows(rows: readonly InboxItem[], scope: Scope = {}): InboxItem[] {
  return itemsNow(
    rows.filter((row) => (row.kind === 'approval' || row.kind === 'question') && inScope(row, scope)),
  );
}

/** The gate's item, when the gate on that phase is a person's ask today. */
export function gateRow(rows: readonly InboxItem[], slug: string, phase: number): InboxItem | undefined {
  return rows.find((row) => row.kind === 'gate' && row.turn && row.slug === slug && row.phase === phase);
}

/**
 * The errand's item: the step it IS (the one the console raised for it, the
 * one a session declared, the one its phase is parked on), else the errand row
 * itself — of that plan and phase, and of that run when both name one.
 */
export function errandRow(
  rows: readonly InboxItem[],
  at: { slug?: string | undefined; phase?: number | null | undefined; runId?: string | undefined },
): InboxItem | undefined {
  const mine = rows.filter(
    (row) =>
      Boolean(row.turn) &&
      (row.kind === 'errand' || row.turn?.source === 'errand') &&
      row.slug === at.slug &&
      (at.phase == null || row.phase === at.phase) &&
      inScope(row, { runId: at.runId }),
  );
  const errand = mine[0];
  if (!errand) return undefined;
  const id = itemIdOf(errand);
  return rows.find((row) => row.kind === 'human-step' && itemIdOf(row) === id) ?? errand;
}

/** This run's items, oldest first — the strip's ONE action is the first one's primary. */
export function runItems(
  rows: readonly InboxItem[] | undefined,
  run: { id: string; slug: string },
): InboxItem[] {
  return itemsNow((rows ?? []).filter((row) => inScope(row, { runId: run.id, slug: run.slug })));
}
