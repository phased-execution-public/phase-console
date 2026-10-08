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
import type { InboxAction, InboxItem } from './inbox';
import type { PermissionRecord } from './human-steps';
import type { AuthorityRequest } from './owner';
import { request } from './client';

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

export const turnApi = {
  /** Every item of Your turn, grouped — `seen` is the person's last look, for the handled count. */
  read: (seen?: string | null): Promise<TurnAnswer> =>
    request<TurnAnswer>(seen ? `/api/turn?seen=${encodeURIComponent(seen)}` : '/api/turn'),
};
