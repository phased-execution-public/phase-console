/**
 * The "in this tab" leg: a page-raised Notification off the server's
 * `notification` event.
 *
 * Promised on the Devices card for as long as the card has existed ("Raised by
 * the page. Costs nothing and needs no setup, but only exists while a tab is
 * open") and never wired: `lib/notify.ts` asked for the permission, the card
 * displayed it, and no call site ever raised one — a setting with no behaviour.
 * This is the behaviour.
 *
 * Three gates, each the reason a card would otherwise be noise rather than
 * news:
 *
 *  - **permission `granted`** — asked for from the card's button, never here;
 *  - **the tab is hidden** — a visible tab already shows the bell badge and
 *    the toast; an OS card over a page you are looking at is a second copy;
 *  - **this browser holds no push subscription** — a subscribed browser's
 *    service worker shows the push card for the same event, and the two
 *    cannot collapse (the record carries no push tag), so it would show twice.
 *
 * And the event must be a FRESH announcement. The same `notification` event
 * carries annotation re-emissions — a halt resolving itself, a record marked
 * read — and an `EventSource` reconnect replays from `Last-Event-ID`, so a
 * card is raised only for an unread, unresolved record younger than a minute.
 *
 * `tag: record.id` collapses the card across several hidden tabs of one
 * console: the OS replaces by origin+tag, so three tabs raise one card.
 */

import type { NotificationRecord } from './api';
import { notifyState, type NotifyState } from './notify';
import { currentEndpoint } from './push';
import { onSse } from './sse';
import { consolePath } from './base';

/** A replayed or annotated record older than this is history, not news. */
export const TAB_NOTIFY_FRESH_MS = 60_000;

export type TabNotifyDeps = {
  permission: () => NotifyState;
  hidden: () => boolean;
  /** Whether THIS browser is push-subscribed (its service worker will show the card). */
  subscribed: () => Promise<boolean>;
  raise: (record: NotificationRecord) => void;
  now: () => number;
};

/** Is this event a fresh announcement rather than an annotation or a replay? */
export function isFreshAnnouncement(record: unknown, now = Date.now()): record is NotificationRecord {
  const r = record as Partial<NotificationRecord> | null;
  if (!r || typeof r !== 'object' || !r.id || !r.title) return false;
  if (r.read || r.resolved) return false;
  const at = Date.parse(String(r.at ?? ''));
  return Number.isFinite(at) && now - at < TAB_NOTIFY_FRESH_MS;
}

/**
 * Build and show the card. Exported for the arm below and for nothing else —
 * every other caller goes through the server's `notification` event, which
 * is the one wording and the one destination.
 */
export function raiseTabNotification(record: NotificationRecord): Notification | null {
  if (typeof Notification === 'undefined') return null;
  let card: Notification;
  try {
    card = new Notification(record.title, {
      body: record.body,
      tag: record.id,
      // A quiet category stays quiet; only the catalogue's urgent ones sound.
      silent: !record.urgent,
      data: { url: record.url },
    });
  } catch {
    // Chrome on Android refuses page-side construction outright and asks for
    // the service worker instead — which is the push leg's job, not this one's.
    return null;
  }
  card.onclick = () => {
    try {
      window.focus();
    } catch {
      /* a window that cannot be focused is still navigated */
    }
    const url = String(record.url ?? '');
    const hash = url.indexOf('#');
    if (hash >= 0) window.location.hash = url.slice(hash);
    else if (url) window.location.assign(consolePath(url));
    card.close();
  };
  return card;
}

const DEFAULT_DEPS: TabNotifyDeps = {
  permission: notifyState,
  hidden: () => typeof document !== 'undefined' && document.hidden,
  subscribed: async () => Boolean(await currentEndpoint()),
  raise: (record) => {
    raiseTabNotification(record);
  },
  now: Date.now,
};

/**
 * Decide, then raise. Async because the subscription question needs the
 * service worker; the cheap gates go first so a visible tab never pays for
 * it.
 */
export async function considerTabNotification(record: unknown, deps: TabNotifyDeps): Promise<boolean> {
  if (deps.permission() !== 'granted') return false;
  if (!deps.hidden()) return false;
  if (!isFreshAnnouncement(record, deps.now())) return false;
  if (await deps.subscribed()) return false;
  deps.raise(record);
  return true;
}

let disarm: (() => void) | null = null;

/**
 * Subscribe the leg to the stream. Idempotent: a second arm is a no-op with
 * the first's disarm. Returns the disarm for an effect's cleanup.
 */
export function armTabNotifications(deps: TabNotifyDeps = DEFAULT_DEPS): () => void {
  if (disarm) return disarm;
  const off = onSse('notification', (data) => {
    void considerTabNotification(data, deps).catch(() => {
      /* a card that could not be raised is a card, not a run */
    });
  });
  disarm = () => {
    off();
    disarm = null;
  };
  return disarm;
}
