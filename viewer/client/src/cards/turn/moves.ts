/**
 * The card's ONE primary, by type × status × readiness × record (turn-by-turn
 * phase 8, IC-v2) — the move table is the contract, and the card draws what it
 * says and nothing else.
 *
 *   status Passed, Not doing or Closed   → nothing to press (settled)
 *   type Heads-up                        → *Got it*
 *   status Checking                      → a ledger item's *Undo: I'm not finished*; else nothing
 *   status Waiting for the owner         → the request's first pressable action (Confirm)
 *   readiness Not yet                    → nothing to press until it is due
 *   a supervisor's card (Pro)            → the card's own one action
 *   type Approval                        → *Approve* (beside it *Deny*) — a permission's
 *                                          through its grant; a projected one with no
 *                                          yes-or-no pair, its row's first action
 *   type Decision                        → its options and *Send my decision*
 *   type Task                            → a ledger item's *I've done this — check*, or
 *                                          *I've redone it* on Redo — never the opener,
 *                                          never a terminal; a projected one, its row's
 *                                          first pressable action
 *
 * A row action whose capability is off (`flag`) is never the primary: it is
 * drawn disabled beside the form with the flag that turns it on.
 */

import type { HumanStepKind } from '@shared/human-step-model.js';
import type { ItemType, PersonStatus, ProofType, Readiness, TurnRecord } from '@shared/turn-model.js';
import type { InboxAction } from '@/data/api';
import { CHECK_LABEL } from '../human-step-words';

/** What the card's one primary is. */
export type CardMove =
  | { move: 'none'; why: 'settled' | 'not-yet' | 'checking' | 'no-action' }
  | { move: 'undo' }
  | { move: 'check'; redo: boolean }
  | { move: 'decide' }
  | { move: 'approve' }
  | { move: 'grant' }
  | { move: 'card' }
  | { move: 'got-it' }
  | { move: 'row'; action: InboxAction };

export type CardMoveInput = {
  type: ItemType;
  personStatus: PersonStatus;
  readiness: Readiness;
  record: TurnRecord;
  kind: HumanStepKind;
  proofType?: ProofType | null | undefined;
  /** The row's own actions that no option already stands for. */
  actions: readonly InboxAction[];
  /** The ways on: a ledger decision's options, or a projected item's bound ones. */
  options: readonly { id: string; label: string; flag?: string | undefined }[];
  /** A supervisor's card (Pro): it draws its own one action. */
  supervisor?: boolean;
};

const SETTLED: ReadonlySet<PersonStatus> = new Set(['passed', 'not-doing', 'closed']);

/** The ids and verbs that say yes, and those that say no — an approval's pair. */
export const APPROVE_WORDS: ReadonlySet<string> = new Set(['approve', 'allow', 'grant', 'yes', 'accept']);
export const DENY_WORDS: ReadonlySet<string> = new Set(['deny', 'reject', 'refuse', 'no', 'decline']);

const said = (word: string) => word.toLowerCase().replace(/[^a-z].*$/, '');

/** Does the option or action say yes (or no)? By its id or verb, else the first word of its label. */
export function saysYes(choice: { id?: string; verb?: string; label: string }): boolean {
  return APPROVE_WORDS.has(choice.id ?? choice.verb ?? '') || APPROVE_WORDS.has(said(choice.label));
}
export function saysNo(choice: { id?: string; verb?: string; label: string }): boolean {
  return DENY_WORDS.has(choice.id ?? choice.verb ?? '') || DENY_WORDS.has(said(choice.label));
}

/**
 * An approval's yes, said as *Approve*: a label that already leads with the
 * act ("Approve the gate on Phase 3", "Allow once") keeps its words; a grant's
 * ("Grant — this phase") is said as Approve with its scope; anything else is
 * plain *Approve*.
 */
export function approveLabelOf(label: string | undefined): string {
  if (!label) return MOVE_LABEL.approve;
  if (/^(approve|allow)\b/i.test(label)) return label;
  if (/^grant\b/i.test(label)) return label.replace(/^grant/i, MOVE_LABEL.approve);
  return MOVE_LABEL.approve;
}

/** An approval's no, said as *Deny* — a label that already leads with a refusal keeps its words. */
export function denyLabelOf(label: string | undefined): string {
  return label && /^(deny|reject|refuse)\b/i.test(label) ? label : MOVE_LABEL.deny;
}

/** A permission item ends by a grant — the permission card's, or its row's. */
export function isGrantItem(input: Pick<CardMoveInput, 'kind' | 'proofType' | 'record'>): boolean {
  return input.record === 'ledger' && (input.kind === 'permission' || input.proofType === 'grant');
}

/** Does an approval have a yes to press — an option, a row action, or (a ledger item) its answer? */
export function hasApprovePair(input: Pick<CardMoveInput, 'record' | 'actions' | 'options'>): boolean {
  if (input.options.some((option) => !option.flag && saysYes(option))) return true;
  if (input.actions.some((action) => !action.flag && saysYes(action))) return true;
  return input.record === 'ledger' && !input.options.length;
}

export function cardMoveOf(input: CardMoveInput): CardMove {
  if (SETTLED.has(input.personStatus)) return { move: 'none', why: 'settled' };
  if (input.type === 'know') return { move: 'got-it' };
  const first = input.actions.find((action) => !action.flag);
  if (input.personStatus === 'checking') {
    return input.record === 'ledger' ? { move: 'undo' } : { move: 'none', why: 'checking' };
  }
  if (input.personStatus === 'owner')
    return first ? { move: 'row', action: first } : { move: 'none', why: 'no-action' };
  if (input.readiness === 'not-yet') return { move: 'none', why: 'not-yet' };
  if (input.supervisor) return { move: 'card' };
  switch (input.type) {
    case 'approve':
      if (isGrantItem(input)) return { move: 'grant' };
      if (hasApprovePair(input)) return { move: 'approve' };
      if (input.options.length) return { move: 'decide' };
      return first ? { move: 'row', action: first } : { move: 'none', why: 'no-action' };
    case 'decide':
      if (input.options.length || input.record === 'ledger') return { move: 'decide' };
      return first ? { move: 'row', action: first } : { move: 'none', why: 'no-action' };
    default:
      if (input.record === 'ledger') return { move: 'check', redo: input.personStatus === 'redo' };
      if (input.options.length) return { move: 'decide' };
      return first ? { move: 'row', action: first } : { move: 'none', why: 'no-action' };
  }
}

/** The words the card's primaries say — one wording each, the row's own label for a row. */
export const MOVE_LABEL = Object.freeze({
  check: CHECK_LABEL,
  redo: "I've redone it",
  undo: "Undo: I'm not finished",
  decide: 'Send my decision',
  approve: 'Approve',
  deny: 'Deny',
  gotIt: 'Got it',
  cannot: "I can't do this",
});

/** What the primary says, or null when there is nothing to press (the card's own lent pieces name theirs). */
export function cardMoveLabel(move: CardMove): string | null {
  switch (move.move) {
    case 'check':
      return move.redo ? MOVE_LABEL.redo : MOVE_LABEL.check;
    case 'undo':
      return MOVE_LABEL.undo;
    case 'decide':
      return MOVE_LABEL.decide;
    case 'approve':
    case 'grant':
      return MOVE_LABEL.approve;
    case 'got-it':
      return MOVE_LABEL.gotIt;
    case 'row':
      return move.action.label;
    default:
      return null;
  }
}

/** Why there is nothing to press, in a person's words — said where the act form would be. */
export const NONE_WORDS: Readonly<Record<Extract<CardMove, { move: 'none' }>['why'], string>> = Object.freeze(
  {
    settled: 'Nothing to do — it is settled.',
    'not-yet': 'Nothing to do yet — it opens when it is due.',
    checking: 'Being checked — nothing to press until the verdict lands.',
    'no-action': 'Nothing to press here — open it where it lives.',
  },
);
