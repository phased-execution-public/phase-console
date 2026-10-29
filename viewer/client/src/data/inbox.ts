/**
 * What waits on a person and what the console said: the attention inbox, the
 * announcement log, reading by looking, and the push register.
 */

import { useEffect } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, type NotificationScope } from './api';
import { useConsoleState } from './console';
import { keys } from './keys';

/** What a page of the notification inbox asks `GET /api/notifications` for — its query, not a wire shape. */
export interface InboxQuery {
  category?: string;
  unread?: boolean;
  limit?: number;
  before?: string;
}

/** How long a page has to stay open before opening it counts as reading. */
const AUTO_READ_DELAY_MS = 1_200;

/**
 * Opening the page that a notification is about counts as reading it.
 *
 * The 182-unread inbox was two failures compounding. P1 fixed the first — a
 * category that was off still recorded. This is the second: nothing ever became
 * read *by being looked at*, so the only way the count ever fell was a bulk
 * clear, which is indistinguishable from giving up on the inbox entirely.
 *
 * Three properties make it safe to do automatically:
 *
 *  - **Scoped, never global.** The server matches on the record's own `slug` /
 *    `runId` / `phase`, and an empty scope matches nothing — so a route whose
 *    slug has not parsed yet clears zero records rather than the inbox.
 *  - **Delayed.** Tabbing through plans should not silently mark six plans'
 *    notifications read; staying long enough to read one should.
 *  - **Only when there is something to clear.** Gated on the unread count the
 *    shell already holds, so the ordinary visit costs no request at all.
 *
 * The badge and any open inbox update from the `notification:read` event the
 * server emits, which is why nothing is invalidated here.
 */
export function useAutoReadNotifications(scope: NotificationScope, enabled = true): void {
  const { data: state } = useConsoleState();
  const unread = state?.unread ?? 0;
  // A stable identity for the scope object, so a caller may build it inline.
  const key = JSON.stringify(scope);

  useEffect(() => {
    if (!enabled || unread < 1) return undefined;
    const parsed = JSON.parse(key) as NotificationScope;
    if (!Object.values(parsed).some((value) => value !== undefined && value !== '')) return undefined;

    const timer = setTimeout(() => {
      // Fire-and-forget: a failed read marker must never surface as an error on
      // a page the operator opened to read something else.
      void api.markNotificationsReadFor(parsed).catch(() => {});
    }, AUTO_READ_DELAY_MS);
    return () => clearTimeout(timer);
  }, [enabled, key, unread]);
}

/**
 * Everything that needs a person, in one list.
 *
 * `all` includes what has been acknowledged — the drawer's "show everything"
 * view. Acknowledgement is an annotation and never a resolution, so an acked
 * row is still a row; it is only hidden by default.
 *
 * `placeholderData` because the SSE `inbox` event invalidates this whenever
 * anything moves, and a list that blanked to a skeleton every time a run
 * emitted a phase would be unreadable exactly while there is something to
 * read. `retry: false`: a console whose server predates the endpoint answers
 * 404 and will keep answering 404 — the section says so instead of asking
 * again at somebody.
 */
export function useAttentionInbox(all = false, enabled = true) {
  return useQuery({
    queryKey: keys.inbox(all),
    queryFn: () => api.inbox(all),
    enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/**
 * One page of the inbox.
 *
 * The filters are part of the key: "unread only, approvals, 60 rows" is a
 * different answer from the server, not a client-side slice of one. `EVENT_
 * EFFECTS` invalidates the `notifications` prefix on all four inbox events, so
 * every variant a tab is holding refreshes together — which is what makes a
 * card answered on a phone take the badge down here.
 */
export function useInbox(query: InboxQuery) {
  return useQuery({
    queryKey: [...keys.notifications(), query.category ?? '', query.unread ?? false, query.limit ?? 60],
    queryFn: () => api.notifications(query),
    placeholderData: keepPreviousData,
  });
}

/** The push register: which devices are subscribed, and to what. */
export function usePush(enabled = true) {
  return useQuery({ queryKey: keys.push(), queryFn: api.push, enabled, retry: false });
}
