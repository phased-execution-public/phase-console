/**
 * Your turn — the one read (control-tower phase 132, #209).
 *
 * The server owns the turn: `server/turn/fold.ts` folds each inbox row that
 * asks a person for an act into an item (which item, which record, its kind,
 * reason, proof type and group), and `server/turn/index.ts` `turnView`
 * projects them — an errand and the step it describes are ONE item, grouped by
 * `groupOf`, a ledger item with the ledger's own record. This file is the typed
 * door to `GET /api/turn`. An item is pressed through its own `actions`,
 * verbatim, as every inbox action is: a ledger item's `/api/human-steps/:id/…`,
 * a projected item's own endpoints.
 */

import type {
  InboxAction,
  InboxItem,
  TurnAnswer,
  TurnCannotAnswer,
  TurnExplainAnswer,
  TurnHandOffAnswer,
  TurnNoteAnswer,
  TurnOption,
} from '@shared/wire/turn.js';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { inboxApi } from './api/inbox';
import { humanStepsApi, type HumanStepRecord, type StepVerbAnswer } from './human-steps';
import type { GrantRecord } from './permissions';
import { post, request, sendOnLeave } from './http';
import { keys } from './keys';
import { press, type Pressed } from './press';

export type {
  HandledRow,
  TurnAnswer,
  TurnCannotAnswer,
  TurnExplain,
  TurnExplainAnswer,
  TurnHandOffAnswer,
  TurnItem,
  TurnNoteAnswer,
  TurnRecord,
  TurnSettled,
  TurnStepDetail,
  TurnStrip,
  TurnView,
} from '@shared/wire/turn.js';

/**
 * The item an inbox row stands for: its turn view's id, else — a projected
 * card — the row's own. Pure and on first paint already, so a surface links to
 * an item (`#/turn/<id>`) before the row that draws it has loaded.
 */
export function itemIdOf(row: Pick<InboxItem, 'id' | 'turn'>): string {
  return row.turn?.item ?? row.id;
}

/** Is this row about that run (by id) or that plan (by slug)? A run's own rule: the id wins when both have one. */
export function rowInScope(
  row: Pick<InboxItem, 'runId' | 'slug'>,
  scope: { runId?: string | undefined; slug?: string | undefined },
): boolean {
  if (scope.runId && row.runId) return row.runId === scope.runId;
  return !scope.slug || row.slug === scope.slug;
}

/**
 * The errand's item: the step it IS (the one the console raised for it, the
 * one a session declared, the one its phase is parked on), else the errand row
 * itself — of that plan and phase, and of that run when both name one. The
 * errand card (`cards/errand.tsx`) draws it in place of the ladder's how.
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
      rowInScope(row, { runId: at.runId }),
  );
  const errand = mine[0];
  if (!errand) return undefined;
  const id = itemIdOf(errand);
  return rows.find((row) => row.kind === 'human-step' && itemIdOf(row) === id) ?? errand;
}

/* ------------------------------------------------------------------ *
 * Where a surface finds the items it draws (control-tower phase 139, #216;
 * under `data/` since quiet-console phase 7, where the Runs home and the
 * cards read them). Every inbox row that asks a person for an act carries its
 * `turn` view, an errand and the step it describes folded into ONE item, so a
 * surface picks its rows out of the inbox it already holds.
 * ------------------------------------------------------------------ */

/**
 * Does this row ask a person for an act NOW — an item of *Approve*, *Do now*
 * or *Decide* (`TURN_OPEN_GROUPS`, the groups v2 of turn-by-turn phase 9)?
 * Not one coming up, being checked or done, and never an `fyi` row: the page
 * leaves those out too (`server/turn/index.ts`), and a plan-wide note (a clash zone, an idle plan) asks nobody to press anything.
 */
export function asksNow(row: Pick<InboxItem, 'turn' | 'severity'>): boolean {
  const group = row.turn?.group;
  return row.severity !== 'fyi' && (group === 'approve' || group === 'now' || group === 'decide');
}

/** A row with no clock (a gate, a QA verdict) sorts LAST, as the inbox's own order puts it. */
const sinceStamp = (iso: string | undefined): number => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
};

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
  return [...byItem.values()].sort((a, b) => sinceStamp(a.since) - sinceStamp(b.since));
}

/** The items a person owes now, one row each, oldest first — *Your turn (n)* counts these. */
export function itemsNow<T extends Pick<InboxItem, 'id' | 'turn' | 'kind' | 'since' | 'severity'>>(
  rows: readonly T[],
): T[] {
  return itemRows(rows.filter(asksNow));
}

/**
 * The approval queue's items: every broker card and relayed question that
 * asks now, of that run or that plan (every one when no scope is named).
 */
export function approvalRows(
  rows: readonly InboxItem[],
  scope: { runId?: string | undefined; slug?: string | undefined } = {},
): InboxItem[] {
  return itemsNow(
    rows.filter((row) => (row.kind === 'approval' || row.kind === 'question') && rowInScope(row, scope)),
  );
}

/** The gate's item, when the gate on that phase is a person's ask today. */
export function gateRow(rows: readonly InboxItem[], slug: string, phase: number): InboxItem | undefined {
  return rows.find((row) => row.kind === 'gate' && row.turn && row.slug === slug && row.phase === phase);
}

/** This run's items, oldest first — a run row's ONE action is the first one's primary. */
export function runItems(
  rows: readonly InboxItem[] | undefined,
  run: { id: string; slug: string },
): InboxItem[] {
  return itemsNow((rows ?? []).filter((row) => rowInScope(row, { runId: run.id, slug: run.slug })));
}

export const turnApi = {
  /** Every item of Your turn, grouped — `seen` is the person's last look, for the handled count. */
  read: (seen?: string | null): Promise<TurnAnswer> =>
    request<TurnAnswer>(seen ? `/api/turn?seen=${encodeURIComponent(seen)}` : '/api/turn'),
  /** One ledger item, explained (`GET /api/turn/:id`). */
  explain: (id: string): Promise<TurnExplainAnswer> =>
    request<TurnExplainAnswer>(`/api/turn/${encodeURIComponent(id)}`),
};

/**
 * Your turn, as the shell counts it (the situation words, 7.0): under the
 * inbox prefix (`keys.turn()`), so the `turn` event and every inbox
 * invalidation re-read it. `retry: false` — a server that predates the page
 * answers 404 and keeps answering it. The page passes `seen`, the person's
 * last look, which the handled count is taken from.
 */
export function useTurn(enabled = true, seen?: string | null) {
  return useQuery({
    queryKey: keys.turn(seen),
    queryFn: () => turnApi.read(seen),
    enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/**
 * An item's explain view, read when its inspector opens — never before, and
 * never for a projected item, whose record is its row. A 404 is the answer
 * for one, not an error to retry.
 */
export function useTurnItem(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.turnItem(id ?? ''),
    queryFn: () => turnApi.explain(id ?? '').then((answer) => answer.item),
    enabled: enabled && Boolean(id),
    staleTime: 15_000,
    retry: false,
  });
}

/**
 * *Withdraw* — the owner takes an open item off the page (quiet-console phase
 * 8), through the owner door like every press. The item is NOT taken off
 * here: it leaves the list when the server's `turn` event says the turn moved
 * (#270's rule), so a withdrawal the door only wrote down (202) still reads
 * as waiting, never as done.
 */
export function withdrawItem(id: string, note?: string): Promise<Pressed<StepVerbAnswer>> {
  return press(() => humanStepsApi.humanStepWithdraw(id, note));
}

/**
 * *Undo* on an item being checked (turn-by-turn phase 5): the check is taken
 * back while it runs, and the item is To do — or Redo — again. Through the
 * owner door like every press; the item moves when the `turn` event says so.
 */
export function undoCheck(id: string): Promise<Pressed<StepVerbAnswer>> {
  return press(() => humanStepsApi.humanStepUndo(id));
}

/**
 * *I can't do this* on an item the console projects (2026-10-20) — a gate, a
 * sign-in, a conflict, a ladder's errand: the person's reason goes with it, the
 * item moves to Done as Not doing, and whoever it goes to is told. Through the
 * owner door like every press; a ledger item's is its step's own verb.
 */
export function cannotItem(id: string, reason: string): Promise<Pressed<TurnCannotAnswer>> {
  return press(() => post<TurnCannotAnswer>(`/api/turn/${encodeURIComponent(id)}/cannot`, { reason }));
}

/**
 * A comment to the AI on an item (2026-10-20) — the decision card's box when
 * the way on the person chose carries no words of its own: whoever the item
 * goes to is told, and the item stays as open as it was.
 */
export function noteItem(id: string, text: string): Promise<Pressed<TurnNoteAnswer>> {
  return press(() => post<TurnNoteAnswer>(`/api/turn/${encodeURIComponent(id)}/note`, { text }));
}

/**
 * *Hand it to the AI* (2026-10-20): a decision's last option, through the
 * turn's own verb — the AI takes it with the person's note: a session's
 * decision is answered "decide it yourself", a stopped phase resumes, a
 * conflict's run is told. The server refuses it on a choice only a person
 * may make.
 */
export function handOffItem(id: string, note?: string): Promise<Pressed<TurnHandOffAnswer>> {
  return press(() =>
    post<TurnHandOffAnswer>(`/api/turn/${encodeURIComponent(id)}/hand-off`, note ? { note } : {}),
  );
}

/** The same comment, as the page goes away inside the undo window — sent once, unanswered. */
export function noteOnLeave(id: string, text: string): boolean {
  return sendOnLeave(`/api/turn/${encodeURIComponent(id)}/note`, { text });
}

/**
 * *Give back to Phase N* (turn-by-turn phase 5): the item is handed back to
 * the phase that raised it — the step is withdrawn and its raiser resumed to
 * do it another way, or ask again better. The escalation's *Rewrite the guide*
 * presses the same verb; this is the door any open ledger item of a phase has.
 */
export function giveBack(id: string, note?: string): Promise<Pressed<StepVerbAnswer>> {
  return press(() => humanStepsApi.humanStepRewrite(id, note));
}

/**
 * Press one of an item's options (turn-by-turn phase 5): its own verb, sent
 * as the server bound it — the method, the endpoint and the body, with what
 * the person typed in the field the option names (`says`), and only when they
 * typed something. A run's verb carries `expectRunId`, so a card left open on
 * a run that moved on is refused with a sentence (`PressRefusal.stale`) and
 * presses nothing. A flagged option is off: it is never sent.
 */
export function pressOption(option: TurnOption, typed?: string): Promise<Pressed<unknown>> {
  if (option.flag) return Promise.reject(new Error(`${option.label} is off on this console.`));
  const action: InboxAction = {
    verb: option.id,
    label: option.label,
    endpoint: option.verb.endpoint,
    method: option.verb.method,
    ...(option.verb.body !== undefined ? { body: option.verb.body } : {}),
    ...(option.says ? { says: option.says } : {}),
  };
  return press(() => inboxApi.inboxAct(action, typed));
}


/**
 * Revoke one live grant (quiet-console phase 22): exactly what it changed is
 * undone and nothing another live grant still holds, and the reason is kept
 * on the grant's row and in the journal. Taking authority back needs no owner
 * key — the door table lets this machine, a paired device and the owner
 * decline — but it is pressed through the owner door like every press, so a
 * door that may only ask reads `asked`, never done.
 */
export function revokeGrant(
  id: string,
  { reason }: { reason?: string } = {},
): Promise<Pressed<{ ok: true; grant: GrantRecord }>> {
  return press(() => import('./permissions').then((grants) => grants.permissionsApi.revoke(id, reason)));
}

/** Revoke every live grant at once, each undone as its own row says, with one reason for all of them. */
export function revokeAll({ reason }: { reason?: string } = {}): Promise<
  Pressed<{ ok: true; revoked: number; grants: GrantRecord[] }>
> {
  return press(() => import('./permissions').then((grants) => grants.permissionsApi.revokeAll(reason)));
}

/** The ledger's record of one item, when the page holds the ledger. */
export function recordOf(
  steps: readonly HumanStepRecord[] | undefined,
  id: string,
): HumanStepRecord | undefined {
  return steps?.find((step) => step.id === id);
}

/**
 * The human-step ledger — every step with its moves, the reminder clock's
 * words and what this console can do on the machine (control-tower phase 43):
 * the records Your turn's items and the step card read whole. Patched in place
 * by the `human-step` event (`patchHumanStep`), so a page reads it once.
 */
export function useHumanSteps(enabled = true) {
  return useQuery({
    queryKey: keys.humanSteps(),
    queryFn: () => humanStepsApi.humanSteps(),
    enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}
