/**
 * Notifications — the inbox of records the console has announced, and the push
 * register. (The unified WORK inbox — errands, approvals, gates — is `./inbox`;
 * `InboxPage` here is the notification inbox's own shape.) The shapes are the
 * wire's (`shared/wire/notifications.js`).
 */

import { request, post, q } from '../http';
import type { InboxQuery } from '../inbox';
import type {
  DeliveryTestAnswer,
  InboxPage,
  NotificationClearResult,
  NotificationScope,
  PushActionAnswer,
  PushDeviceAnswer,
  PushQuietHours,
  PushState,
  PushSubscribeAnswer,
  PushSubscribeBody,
  PushUnsubscribeAnswer,
  ReadResult,
} from '@shared/wire/notifications.js';

export type {
  DeliveryOutcome,
  DeliveryRecord,
  InboxPage,
  NotificationCategory,
  NotificationRecord,
  NotificationScope,
  PushDevice,
  PushQuietHours,
  PushState,
  ReadResult,
} from '@shared/wire/notifications.js';

/** The notification and push fetchers — merged into `api` by `./index`. */
export const notificationsApi = {
  /* ---- the notification inbox ---- */
  notifications: (query: InboxQuery = {}) =>
    request<InboxPage>(
      `/api/notifications?${new URLSearchParams(
        Object.entries(query)
          .filter(([, v]) => v != null && v !== '' && v !== false)
          .map(([k, v]) => [k, v === true ? '1' : String(v)]),
      )}`,
    ),
  markNotificationsRead: (ids?: string[]) =>
    post<ReadResult>('/api/notifications/read', ids?.length ? { ids } : {}),
  // Scoped: only the records that are *about* this thing. An empty scope
  // matches nothing on the server, so a slug that has not resolved yet cannot
  // clear the inbox by accident.
  markNotificationsReadFor: (scope: NotificationScope) => post<ReadResult>('/api/notifications/read', scope),
  // Put back (#334): the named records become unread again — never a delete.
  // Ids only; an empty list changes nothing on the server.
  markNotificationsUnread: (ids: string[]) => post<ReadResult>('/api/notifications/unread', { ids }),
  clearNotifications: (what: 'read' | 'all' | { id: string }) =>
    request<NotificationClearResult>(
      `/api/notifications?${typeof what === 'string' ? `scope=${what}` : `id=${q(what.id)}`}`,
      { method: 'DELETE' },
    ),

  /* ---- push: the register, not the browser half ----
     Subscribing is `lib/push.ts` — it needs a service worker and a permission
     prompt, neither of which belongs in a fetch helper. */
  push: () => request<PushState>('/api/push'),
  /**
   * Answer a notification from the app with the same signed token its phone
   * buttons carry (`POST /api/push/action`) — one answer per notification,
   * whichever device or drawer gives it first.
   */
  pushAction: (token: string, action: string) =>
    post<PushActionAnswer>('/api/push/action', { token, action }),
  pushSubscribe: (body: PushSubscribeBody) => post<PushSubscribeAnswer>('/api/push/subscribe', body),
  pushUnsubscribe: (endpoint: string) => post<PushUnsubscribeAnswer>('/api/push/unsubscribe', { endpoint }),
  pushCategories: (id: string, categories: Record<string, boolean>) =>
    post<PushDeviceAnswer>('/api/push/categories', { id, categories }),
  // `null` clears the window; the server refuses a malformed one with a 400.
  pushQuiet: (id: string, quiet: PushQuietHours | null) =>
    post<PushDeviceAnswer>('/api/push/quiet', { id, quiet }),
  pushTest: (id: string) => post<DeliveryTestAnswer>('/api/push/test', { id }),
};
