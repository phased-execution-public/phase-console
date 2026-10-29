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
import type { BulkAckResult, InboxAckOne, InboxAction, InboxItem, InboxView } from '@shared/wire/turn.js';
import { request, post, q } from '../http';

export type {
  ApprovalBlock,
  BulkAckResult,
  InboxAckAnswer,
  InboxAckBody,
  InboxAckOne,
  InboxAction,
  InboxItem,
  InboxKind,
  InboxSeverity,
  InboxSupervisorView,
  InboxView,
  TurnOption,
} from '@shared/wire/turn.js';

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

/** The inbox fetchers — merged into `api` by `./index`. */
/**
 * The body a remedy is sent with: its own, with the operator's words merged in
 * the key the SERVER named. Merged only when there are some: an empty box must
 * send the same request as no box, or every action grows a `note: ""` nobody
 * wrote. One reading, for the press and for the press sent as the page goes
 * away (`sendOnLeave`).
 */
export function actionBody(action: Pick<InboxAction, 'body' | 'says'>, says?: string): unknown {
  const said = says?.trim();
  return action.says && said
    ? { ...(action.body as Record<string, unknown> | undefined), [action.says.field]: said }
    : action.body;
}

export const inboxApi = {
  /** `all` includes acknowledged items; by default only what is still open. */
  inbox: (all?: boolean) => request<InboxView>('/api/inbox' + (all ? '?all=1' : '')),
  inboxAck: (id: string) => post<InboxAckOne>('/api/inbox/ack', { id }),
  inboxUnack: (id: string) => request<InboxAckOne>(`/api/inbox/ack?id=${q(id)}`, { method: 'DELETE' }),

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
    const body = actionBody(action, says);
    return request<unknown>(action.endpoint, {
      method: action.method,
      ...(body === undefined || action.method === 'GET'
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  },
};
