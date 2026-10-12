/**
 * The unified inbox — what needs a person right now, and what would clear it.
 *
 * Not the NOTIFICATION inbox: `./notifications`'s `InboxPage` / `InboxQuery`
 * are the log of what the console announced. This is the list of what needs a
 * person right now — errands, approvals, gates, sign-ins — each carrying the
 * actions that would clear it. `server/inbox.ts` builds it; `cards/
 * inbox-row.tsx` renders it — in the Tower's Needs-you bay and in the bell
 * drawer.
 */

import { ASK_KINDS } from '@shared/attention-model.js';
import type { HaltCategory } from '@shared/halt-categories.js';
import type { HumanStepView } from '@shared/human-step-model.js';
import type { TurnView } from '../turn';
import { request, post, q } from '../http';

/** What kind of thing is asking. */
export type InboxKind =
  | 'errand'
  | 'approval'
  | 'gate'
  | 'sign-in'
  | 'mcp-auth'
  | 'qa'
  | 'lock'
  | 'health'
  | 'stall'
  | 'ruling'
  | 'session-ask'
  | 'conflict'
  | 'question'
  | 'policy'
  | 'issue-draft'
  | 'message'
  | 'supervisor'
  | 'human-step';

/** How loudly: `urgent` interrupts, `needs-you` waits for a person, `fyi` informs. */
export type InboxSeverity = 'urgent' | 'needs-you' | 'fyi';

/** One thing a person can do about an item, as the server spells it. */
export type InboxAction = {
  verb: string;
  label: string;
  endpoint: string;
  method: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  /** Which console capability gates it (run | agent | writes | …), when one does. */
  flag?: string;
  /**
   * This action can carry words, and this is the body key they go in.
   *
   * The server says which key because the client must not know that a gate
   * wants `note` and a permission card wants `reason` — that would be the
   * start of the routing table `inboxAct` exists to avoid. Absent means the
   * action takes no words.
   */
  says?: { field: string; label: string; placeholder?: string };
};

/**
 * The action a row leads with, and the ones that fold behind it.
 *
 * The server sends the remedies in the order it wants them offered — sign-in
 * before continue, release before stop — so "first" is a decision already
 * made, and this must not re-make it. What it adds is the one rule the wire
 * cannot carry: an action whose capability is OFF (`flag`) is never the
 * primary, because a row whose leading button cannot be pressed reads as a row
 * that cannot be answered. It stays in the rest, disabled, naming the flag.
 */
export function splitActions(item: Pick<InboxItem, 'actions'>): {
  primary?: InboxAction;
  rest: InboxAction[];
} {
  const actions = item.actions ?? [];
  const index = actions.findIndex((action) => !action.flag);
  if (index < 0) return { rest: actions };
  return { primary: actions[index], rest: actions.filter((_, i) => i !== index) };
}

/** What `--allow-<flag>` an action wants, said the way the operator would fix it. */
export const FLAG_REASON: Record<string, string> = {
  run: 'Runs are off. Restart the console with --allow-run.',
  agent: 'Agent sessions are off. Restart the console with --allow-agent.',
  writes: 'Writes are off. Restart the console with --allow-writes.',
  accounts: 'Account management is off. Restart the console with --allow-accounts.',
  mcp: 'MCP management is off. Restart the console with --allow-mcp.',
  terminal: 'Terminals are off. Restart the console with --allow-terminal.',
  publish: 'Publishing is off. Restart the console with --allow-publish.',
};

export const flagReason = (flag: string | undefined): string | undefined =>
  flag ? (FLAG_REASON[flag] ?? `This needs --allow-${flag}.`) : undefined;

/**
 * Live asks first, everything else after — order inside each half preserved
 * (the server already sorted worst-first, oldest-first). The bell's
 * "Sessions asking you" section.
 */
export function partitionAsks(items: readonly InboxItem[] | undefined): {
  asks: InboxItem[];
  rest: InboxItem[];
} {
  const asks: InboxItem[] = [];
  const rest: InboxItem[] = [];
  for (const item of items ?? []) {
    ((ASK_KINDS as readonly string[]).includes(item.kind) ? asks : rest).push(item);
  }
  return { asks, rest };
}

export type InboxItem = {
  id: string;
  kind: InboxKind;
  severity: InboxSeverity;
  slug?: string;
  phase?: number;
  runId?: string;
  title: string;
  /** What is needed. */
  need: string;
  /** How to give it. */
  how: string;
  /** What was already tried, so nobody tries it again by hand. */
  tried?: string[];
  /** ISO 8601 — since when it has been waiting. */
  since: string;
  /** ISO 8601 — when the ask stops being a person's to answer (a relayed question's window). */
  expiresAt?: string;
  actions: InboxAction[];
  /** Where in the console it lives. */
  href: string;
  /** Acknowledged — seen, not cleared. */
  ack?: { at: string; by?: string } | null;
  /**
   * The console that asked, on a list that merges several — absent on a
   * console's own inbox, where every row is that console's. `null` names a row
   * about the machine rather than any one console.
   */
  console?: { id: string; name: string } | null;
  /** The halt family of what stopped the work, word and label (control-tower phase 17). */
  category?: { word: HaltCategory; label: string };
  /**
   * A person's turn (control-tower phase 44): every row that asks a person for
   * an act carries the same view, so ONE card draws them all
   * (`cards/human-step-card.tsx`). The row's `actions` still answer it.
   */
  humanStep?: HumanStepView;
  /**
   * The item of Your turn this row is (control-tower phase 132): which item,
   * which record holds it, its kind, reason, proof type and group. Absent on a
   * row nothing waits on, and on an issue draft (`data/turn.ts`).
   */
  turn?: TurnView;
  /**
   * A supervisor card's own facts (control-tower phase 102): its situation,
   * detection category, evidence, the verb Accept presses or the command an
   * escalation needs, and the cap that held it. Only on a `supervisor` row.
   */
  supervisor?: InboxSupervisorView;
};

/** What a `supervisor` row carries of its card — `server/inbox.ts` `InboxSupervisorView`. */
export type InboxSupervisorView = {
  card: 'suggestion' | 'escalation';
  situation: string;
  category: string;
  verb: string | null;
  why: string;
  evidence: readonly string[];
  command?: string;
  then?: string | null;
  cap?: { cap: string; limit: number; count: number };
};

export type InboxView = {
  items: InboxItem[];
  generatedAt: string;
};

/** What a bulk press answers: one row per item, and the count that succeeded. */
export type BulkAckResult = {
  results: { id: string; ok: boolean; error?: string }[];
  acked?: number;
  unacked?: number;
};

/** The inbox fetchers — merged into `api` by `./index`. */
export const inboxApi = {
  /** `all` includes acknowledged items; by default only what is still open. */
  inbox: (all?: boolean) => request<InboxView>('/api/inbox' + (all ? '?all=1' : '')),
  inboxAck: (id: string) => post<{ ok: boolean }>('/api/inbox/ack', { id }),
  inboxUnack: (id: string) => request<{ ok: boolean }>(`/api/inbox/ack?id=${q(id)}`, { method: 'DELETE' }),

  /**
   * Acknowledge a selection.
   *
   * Answers per item, not per call: seventeen acknowledgements where one
   * refuses is neither a failure nor a success, and the bar that pressed it
   * has to be able to say which. Same shape as `/api/locks/release`.
   */
  inboxAckMany: (ids: string[]) => post<BulkAckResult>('/api/inbox/ack', { ids }),

  /** The other end of it — what Undo presses. */
  inboxUnackMany: (ids: string[]) =>
    request<BulkAckResult>(`/api/inbox/ack?${ids.map((id) => `id=${q(id)}`).join('&')}`, {
      method: 'DELETE',
    }),

  /**
   * Perform a remedy exactly as the server spelled it.
   *
   * The endpoint, the method and the body come off the `InboxAction` verbatim.
   * Nothing here maps a verb to a URL: a client that knew which endpoint
   * answers `recover` would be a second copy of a routing table the server
   * already owns, and the first divergence would be a button that 404s. It is
   * also what lets a NEW kind of item ship with working buttons against a
   * console nobody rebuilt.
   *
   * A body is sent only where one can be: a `GET` with a payload is not a
   * request any of these endpoints accepts.
   */
  inboxAct: (action: InboxAction, says?: string) => {
    // The operator's own words, in the key the SERVER named. Merged only when
    // there are some: an empty box must send the same request as no box, or
    // every action grows a `note: ""` nobody wrote.
    const said = says?.trim();
    const body =
      action.says && said
        ? { ...(action.body as Record<string, unknown> | undefined), [action.says.field]: said }
        : action.body;
    return request<unknown>(action.endpoint, {
      method: action.method,
      ...(body === undefined || action.method === 'GET'
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  },
};
