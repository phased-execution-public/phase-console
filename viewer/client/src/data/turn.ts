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

import type { Guide } from '@shared/guide-grammar.js';
import type { HumanStepKind, HumanStepState } from '@shared/human-step-model.js';
import type {
  HANDLED_LINK_KINDS,
  HANDLED_SOURCES,
  ProofType,
  TurnGroup,
  WhyPerson,
} from '@shared/turn-model.js';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { InboxAction, InboxItem } from './api/inbox';
import {
  humanStepsApi,
  type HumanStepRecord,
  type PermissionRecord,
  type StepVerbAnswer,
  type StepVerdictRecord,
} from './human-steps';
import type { AuthorityRequest } from './owner';
import type { GrantRecord } from './permissions';
import { request } from './http';
import { keys } from './keys';
import { press, type Pressed } from './press';

/**
 * Which record holds an item: the human-step ledger, the row's own (a gate, an
 * approval card, …), or — an owner request about no item the turn shows
 * (control-tower phase 148) — the request itself.
 */
export type TurnRecord = 'ledger' | 'projected' | 'request';

/** The `turn` view an inbox row carries when it asks a person for an act. */
export type TurnView = {
  /** The item this row is: a ledger step's id, or the row's own id when the item is projected. */
  item: string;
  record: TurnRecord;
  /** Where it came from — `server/turn/fold.ts` `TURN_SOURCES`. */
  source: string;
  kind: HumanStepKind;
  why: WhyPerson;
  proofType: ProofType;
  group: TurnGroup;
  /** A permission item's record — on a ledger item and on the approval card it projects (phase 135). */
  permission?: PermissionRecord;
};

/** A ledger item's own record — its reason, proof, options, waiters and attempts. Never a value. */
export type TurnStepDetail = {
  id: string;
  kind: HumanStepKind;
  title: string;
  state: HumanStepState;
  why: WhyPerson;
  whySource: 'declared' | 'inferred';
  proofType: ProofType;
  attempts: number;
  waiters: { slug: string; phase: number; runId?: string; sessionId?: string }[];
  declaredAt: string;
  birth: string;
  proof?: string;
  proofWords?: string;
  /** The full guide, as the one grammar parsed it (`shared/guide-grammar.js`). */
  guide?: Guide;
  options?: { id: string; label: string; consequence?: string; recommended?: true }[];
  allowDecline?: boolean;
  effortMin?: number;
  /** The phases it unblocks. */
  unblocks?: { slug: string; phase: number }[];
  until?: string;
  source?: { kind: string; ref?: string };
  read?: string;
  note?: string;
  permission?: PermissionRecord;
};

/** One thing to do, however many inbox rows stand for it. */
export type TurnItem = TurnView & {
  /** Every inbox row this item stands for — an errand row and its step's row are one item. */
  rows: string[];
  title: string;
  need: string;
  how: string;
  severity: string;
  slug?: string;
  phase?: number;
  runId?: string;
  since: string;
  expiresAt?: string;
  href: string;
  actions: InboxAction[];
  humanStep?: InboxItem['humanStep'];
  category?: InboxItem['category'];
  /** A supervisor card's own facts (control-tower phase 139) — the page draws its card inside the item. */
  supervisor?: InboxItem['supervisor'];
  step?: TurnStepDetail;
  /** What other doors asked the owner to press ON this item (phase 148) — each confirmed or refused once. */
  requests?: AuthorityRequest[];
  /** An owner request about no item the turn shows: it is the item (`record: 'request'`). */
  request?: AuthorityRequest;
};

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
 * Does this row ask a person for an act NOW — an item of *Do now* or *Needs
 * one detail from you*? Not one coming up, being checked or done, and never an
 * `fyi` row: the page leaves those out too (`server/turn/index.ts`), and a
 * plan-wide note (a clash zone, an idle plan) asks nobody to press anything.
 */
export function asksNow(row: Pick<InboxItem, 'turn' | 'severity'>): boolean {
  const group = row.turn?.group;
  return row.severity !== 'fyi' && (group === 'now' || group === 'decide');
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

/** One thing the AI handled instead of asking (control-tower phase 136) — `server/turn/handled.ts`. */
export type HandledRow = {
  id: string;
  at: string;
  first: string;
  source: (typeof HANDLED_SOURCES)[number];
  what: string;
  slug?: string;
  phase?: number;
  runId?: string;
  note?: string;
  count: number;
  links: { kind: (typeof HANDLED_LINK_KINDS)[number]; ref: string }[];
};

/** `GET /api/turn`. */
export type TurnAnswer = {
  /** When this was read, and the console's round: `n` rises only when a round changed the turn. */
  round: { at: string; n: number; ranAt: string | null; changedAt: string | null };
  /** One sentence, composed by rules. */
  headline: string;
  groups: Record<TurnGroup, TurnItem[]>;
  /** What the AI handled instead of asking, newest first. */
  handled: HandledRow[];
  /** Per group, the open total, and how many were handled since `seen` (or in the last day). */
  counts: Record<TurnGroup, number> & { total: number; handled: number };
  seen: string | null;
  /** Issue drafts wait on Repo ▸ Issues: how many, and the link. */
  issues: { count: number; href: string } | null;
};

/**
 * One item explained — `GET /api/turn/:id` (quiet-console phase 8; the
 * route is control-tower phase 137's, read by the supervisor's `turn-explain`
 * until now). The ledger's record said in the reader's words: why only a
 * person fits it as a sentence, the guide and the commands it asks for, how it
 * is proven, every verdict so far, who waits on it. Only a LEDGER item has
 * one: a projected item (a gate, an approval card, a relayed question) is its
 * row, and the route answers 404 for it.
 */
export type TurnExplain = {
  id: string;
  kind: HumanStepKind;
  title: string;
  state: HumanStepState;
  birth: string;
  slug: string;
  phase: number;
  why: WhyPerson;
  whySource: 'declared' | 'inferred';
  /** "<label>: <sentence>." */
  whyPerson: string;
  guide?: Guide;
  /** Every command the guide asks for, in order. */
  commands?: string[];
  lines?: string[];
  proofType: ProofType;
  proof?: string;
  proofWords?: string;
  attempts: number;
  verdicts: StepVerdictRecord[];
  escalatedAt?: string;
  waiters: { slug: string; phase: number; runId?: string; sessionId?: string }[];
  declaredAt: string;
  at: string;
  source?: { kind: string; ref?: string };
  note?: string;
};

export const turnApi = {
  /** Every item of Your turn, grouped — `seen` is the person's last look, for the handled count. */
  read: (seen?: string | null): Promise<TurnAnswer> =>
    request<TurnAnswer>(seen ? `/api/turn?seen=${encodeURIComponent(seen)}` : '/api/turn'),
  /** One ledger item, explained (`GET /api/turn/:id`). */
  explain: (id: string): Promise<{ ok: true; item: TurnExplain }> =>
    request<{ ok: true; item: TurnExplain }>(`/api/turn/${encodeURIComponent(id)}`),
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
