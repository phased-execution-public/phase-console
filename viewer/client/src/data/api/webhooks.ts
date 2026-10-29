/**
 * Outbound webhooks — the register, from the browser's side.
 *
 * There is no browser half to this one (unlike push, which needs a service
 * worker and a permission prompt): a webhook is entirely a server-side row, and
 * these are the four verbs that change it plus the read that lists them. The
 * shapes are the wire's (`shared/wire/notifications.js`).
 *
 * ⚠️ **A row never carries its URL.** The server omits it deliberately — a
 * webhook URL is a bearer credential for somebody's chat channel — so a row is
 * identified by `origin` + `tail` and there is no "edit the URL" verb. Changing
 * one means adding it again, which replaces the row.
 */

import { post, request } from '../http';
import type {
  DeliveryTestAnswer,
  WebhookAddBody,
  WebhookAnswer,
  WebhookRemoveAnswer,
  WebhooksState,
} from '@shared/wire/notifications.js';

export type { WebhookRow, WebhooksState } from '@shared/wire/notifications.js';

export const webhooksApi = {
  webhooks: () => request<WebhooksState>('/api/webhooks'),
  webhookAdd: (body: WebhookAddBody) => post<WebhookAnswer>('/api/webhooks/add', body),
  webhookRemove: (id: string) => post<WebhookRemoveAnswer>('/api/webhooks/remove', { id }),
  webhookCategories: (id: string, categories: Record<string, boolean>) =>
    post<WebhookAnswer>('/api/webhooks/categories', { id, categories }),
  webhookTest: (id: string) => post<DeliveryTestAnswer>('/api/webhooks/test', { id }),
};
