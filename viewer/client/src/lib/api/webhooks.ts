/**
 * Outbound webhooks — the register, from the browser's side.
 *
 * There is no browser half to this one (unlike push, which needs a service
 * worker and a permission prompt): a webhook is entirely a server-side row, and
 * these are the four verbs that change it plus the read that lists them.
 *
 * ⚠️ **A row never carries its URL.** The server omits it deliberately — a
 * webhook URL is a bearer credential for somebody's chat channel — so a row is
 * identified by `origin` + `tail` and there is no "edit the URL" verb. Changing
 * one means adding it again, which replaces the row.
 */

import { post, request } from './client';
import type { NotificationCategory } from './notifications';

export interface WebhookRow {
  id: string;
  label: string;
  /** `https://hooks.example.com` — never the path that authorises. */
  origin: string;
  /** The last few characters of the path, so two rows on one host differ. */
  tail: string;
  categories: Record<string, boolean>;
  createdAt: string;
  lastOkAt: string | null;
  failures: number;
  lastFailure?: { at: string; status: number; reason: string | null };
  /** Epoch ms this row is backing off until. Absent when it is not. */
  quietUntil?: number;
}

export interface WebhooksState {
  /** `--allow-webhooks`. Reading the list never needs it; changing one does. */
  allowWebhooks: boolean;
  hooks: WebhookRow[];
  categories: NotificationCategory[];
}

export const webhooksApi = {
  webhooks: () => request<WebhooksState>('/api/webhooks'),
  webhookAdd: (body: { url: string; label?: string; categories?: Record<string, boolean> }) =>
    post<{ hook?: WebhookRow; state?: WebhooksState; error?: string }>('/api/webhooks/add', body),
  webhookRemove: (id: string) =>
    post<{ removed?: boolean; state?: WebhooksState }>('/api/webhooks/remove', { id }),
  webhookCategories: (id: string, categories: Record<string, boolean>) =>
    post<{ hook?: WebhookRow }>('/api/webhooks/categories', { id, categories }),
  webhookTest: (id: string) => post<{ ok: boolean; detail: string }>('/api/webhooks/test', { id }),
};
