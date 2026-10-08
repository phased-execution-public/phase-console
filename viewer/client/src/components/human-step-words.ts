/**
 * A person's turn in words — which act a step leads with, what its button
 * says, and where it is done (control-tower phase 42).
 *
 * Its own module, and deliberately tiny: the Tower's strip model reads these
 * on the first-paint path, while the card that draws them
 * (`human-step-card.tsx`) is loaded lazily (`human-step-lazy.tsx`) — the
 * first paint's budget (`check-dist`, 190 KB) has no room for the card, its
 * glyphs and the step model's tables. Types only from the model.
 */

import type { HumanStepKind, HumanStepView } from '@shared/human-step-model.js';
import type { InboxItem } from '@/lib/api';

/**
 * Is this inbox row an act that is not due yet — *Coming up* (control-tower
 * phase 121, #182)? A ledger step born `upcoming` is shown, never a summons:
 * the Tower and the approve head list it after what is due, and no run is
 * summoned by it until its due-when ref lands.
 */
export function isUpcomingItem(item: Pick<InboxItem, 'humanStep' | 'ack'>): boolean {
  // Only a ledger step is ever `upcoming` — a folded card has no such state.
  return item.humanStep?.state === 'upcoming' && !item.ack;
}

/**
 * The five acts a card can lead with. `open` follows the step's link here;
 * `terminal` runs its command in the embedded terminal; `machine` is the same
 * terminal for a code the person types AT the machine; `approve` answers a
 * decision; `check` runs the proof now.
 */
export type PrimaryAct = 'open' | 'terminal' | 'machine' | 'approve' | 'check';

/** The act each kind leads with — §Architecture 12's catalogue, one word each. */
export const PRIMARY_ACT: Readonly<Record<HumanStepKind, PrimaryAct>> = Object.freeze({
  'browser-login': 'open',
  'device-code': 'open',
  'one-time-code': 'machine',
  'secret-entry': 'check',
  'claude-login': 'open',
  'mcp-login': 'open',
  'os-prompt': 'terminal',
  'os-permission': 'check',
  'third-party-approval': 'open',
  physical: 'check',
  'person-check': 'approve',
  decision: 'approve',
  'protected-path': 'check',
  'interactive-prompt': 'terminal',
  captcha: 'open',
  'email-link': 'open',
  'operator-act': 'terminal',
  // A wall the AI met (control-tower phase 130): it ends by a grant or a denial.
  permission: 'approve',
});

/** The kinds whose link is a sign-in — every other link is just a link. */
const SIGN_IN_KINDS: ReadonlySet<HumanStepKind> = new Set([
  'browser-login',
  'device-code',
  'claude-login',
  'mcp-login',
]);

/**
 * The check's one wording (control-tower phase 137): the act it records — the
 * person says they did it, and the console checks. The same words on the
 * card, the item's row and the page, so the button a guide names is the
 * button a person finds.
 */
export const CHECK_LABEL = "I've done this — check";

/** What the primary button says. */
export function primaryLabel(act: PrimaryAct, kind: HumanStepKind): string {
  switch (act) {
    case 'open':
      return SIGN_IN_KINDS.has(kind) ? 'Open sign-in' : 'Open the link';
    case 'terminal':
      return 'Open in terminal';
    case 'machine':
      return 'Enter it at the machine';
    case 'approve':
      return 'Approve';
    case 'check':
      return CHECK_LABEL;
  }
}

/**
 * The act a step can actually lead with: the kind's, unless the step lacks
 * what that act needs — a link to open, a command to run — in which case the
 * other opener, and failing both, the check.
 */
export function primaryActOf(view: Pick<HumanStepView, 'kind' | 'openUrl' | 'openCommand'>): PrimaryAct {
  const act = PRIMARY_ACT[view.kind] ?? 'check';
  if (act === 'open' && !view.openUrl) return view.openCommand ? 'terminal' : 'check';
  if ((act === 'terminal' || act === 'machine') && !view.openCommand) return view.openUrl ? 'open' : 'check';
  return act;
}

export const WHERE_LABEL = { host: 'At the machine', any: 'Any device' } as const;
