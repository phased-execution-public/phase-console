/**
 * The service worker. It exists for one reason: to be running when the app is
 * not.
 *
 * Everything else in this client only works while a tab is open. A push
 * arriving at 3am has no tab to arrive in — the browser wakes this file
 * instead, hands it the encrypted payload the browser has already decrypted,
 * and gives it a moment to show something. That is the whole job.
 *
 * It deliberately does not cache anything. An offline console showing a stale
 * board would be worse than an offline console saying so, because the board is
 * the one thing here that must never be out of date.
 *
 * ## Why this file RESTATES `shared/sw-push.js` instead of importing it
 *
 * `client/src/sw.ts` imports that module, because Vite bundles it. This file
 * cannot: it is served raw at `/sw.js` and `lib/pwa.ts` registers it WITHOUT
 * `type: 'module'`, so it is a classic worker — an `import` statement is a
 * syntax error there, the worker fails to install, and a registered worker
 * whose script will not load is unregistered by the browser along with every
 * push subscription bound to it. That is the exact disaster this route exists
 * to prevent, so the emergency worker stays dependency-free on purpose.
 *
 * The copy is therefore held to the original by TEST rather than by import:
 * `test/fallback-sw.test.ts` loads both and asserts they agree. That is the
 * guarantee that matters — the drift it caught (a full-colour badge, and a
 * missing origin clamp on the click target) happened precisely because nothing
 * was watching this file at all.
 */

/* ---------------- restated from shared/sw-push.js — see above ---------------- */

/** The notification's own icon. */
const NOTIFICATION_ICON = '/icons/icon-192.png';

/**
 * The small monochrome mark Android puts in the status bar. It is drawn as a
 * mask — only the alpha channel survives — so a full-colour icon there arrives
 * as a grey blob. This is the mark in flat white for exactly that.
 */
const NOTIFICATION_BADGE = '/icons/icon-badge-96.png';

/**
 * Where a notification click goes, CLAMPED to this origin.
 *
 * Every URL in a real payload is already relative (`/#/plan/…`), written by the
 * console's own `routeFor`, so nothing legitimate changes — but
 * `new URL(absolute, origin)` resolves an absolute URL to wherever it points,
 * and a notification that can open an arbitrary site is a bigger promise than
 * this needs to make.
 */
function clickTarget(info, origin) {
  const base = new URL(origin);
  let target;
  try {
    target = new URL(info?.url || '/', base);
  } catch {
    return new URL('/', base).href;
  }
  if (target.origin !== base.origin) return new URL('/', base).href;
  return target.href;
}

// A new worker should take over immediately rather than waiting for every tab
// to close — otherwise a notification fix ships and does nothing for days.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  // Every push here carries a payload, but a push service is allowed to deliver
  // an empty one, and on iOS a push that shows no notification counts against
  // the app's standing. So there is always something to show.
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* fall through to the default */ }

  const title = data.title || 'Phase Console';
  const options = {
    body: data.body || 'Something needs you.',
    // Same tag replaces rather than stacks: a run that re-renders three times
    // is one line on a lock screen, not three.
    tag: data.tag || 'phase-console',
    renotify: false,
    data: {
      url: data.url || '/',
      category: data.category || null,
      approvalId: data.approvalId || null,
      notificationId: data.notificationId || null,
      actions: notificationActions(data),
      callback: data.callback || null,
    },
    // Answering from the lock screen, without unlocking and finding the queue.
    // (Android and desktop honour these; iOS ignores the array and shows the
    // notification, which is the correct degradation.)
    actions: notificationActions(data),
    icon: NOTIFICATION_ICON,
    // The badge is drawn as a MASK — only the alpha channel survives — so a
    // full-colour icon arrives in the Android status bar as a grey blob.
    // `icon-badge-96.png` is the mark in flat white for exactly this.
    badge: NOTIFICATION_BADGE,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/** Same header the app sends: the server refuses a mutation without it. */
const CONSOLE_HEADERS = { 'content-type': 'application/json', 'x-phase-console': '1' };

/** Restates `shared/sw-push.js` `MAX_NOTIFICATION_ACTIONS`; held to it by test. */
const MAX_NOTIFICATION_ACTIONS = 2;

/** Restates `shared/sw-push.js` `ANSWER_RECEIPTS`; held to it by test. */
const ANSWER_RECEIPTS = {
  allow: 'Allowed. The session is carrying on.',
  deny: 'Denied. The session was told.',
  approve: 'Gate approved. The phase can board.',
};

/**
 * Restates `shared/sw-push.js` `notificationActions`; held to it by test.
 *
 * The `approvalId` fallback is why this cannot simply read `data.actions`: an
 * operator's phone can hold a subscription older than action tokens, and a
 * worker that only understood the new shape would show those cards with no way
 * to answer them.
 */
function notificationActions(data) {
  if (Array.isArray(data.actions)) {
    const clean = data.actions
      .filter((entry) => entry && typeof entry.action === 'string' && entry.action
        && typeof entry.title === 'string' && entry.title)
      .slice(0, MAX_NOTIFICATION_ACTIONS)
      .map((entry) => ({ action: entry.action, title: entry.title }));
    return clean.length ? clean : undefined;
  }
  return data.approvalId
    ? [{ action: 'allow', title: 'Allow' }, { action: 'deny', title: 'Deny' }]
    : undefined;
}

/** Restates `shared/sw-push.js` `actionOf`; held to it by test. */
function actionOf(action, data) {
  if (typeof action !== 'string' || !action) return null;
  const offered = notificationActions(data ?? {});
  if (!offered) return null;
  return offered.some((entry) => entry.action === action) ? action : null;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const info = event.notification.data ?? {};
  const target = clickTarget(info, self.location.origin);
  const decision = event.action === 'allow' ? 'allow' : event.action === 'deny' ? 'deny' : null;
  // Which button, checked against the ones this notification actually offered.
  const verb = actionOf(event.action, info);

  event.waitUntil((async () => {
    // Marking it read here rather than on arrival: a notification you never saw
    // must still be waiting in the inbox when you do look.
    if (info.notificationId) {
      try {
        await fetch('/api/notifications/read', {
          method: 'POST', headers: CONSOLE_HEADERS, body: JSON.stringify({ ids: [info.notificationId] }),
        });
      } catch { /* the row simply stays unread */ }
    }

    // Answering, in the two shapes a payload can arrive in — the signed action
    // token this console mints now, and the bare `approvalId` a payload minted
    // before tokens existed carries. Restates `client/src/sw.ts`.
    const answer = verb && info.callback
      ? { url: '/api/push/action', body: { token: info.callback, action: verb, by: 'notification' } }
      : decision && info.approvalId
        ? {
          url: `/api/approvals/${encodeURIComponent(info.approvalId)}`,
          body: { decision, by: 'notification' },
        }
        : null;

    if (answer) {
      let answered = false;
      try {
        const response = await fetch(answer.url, {
          method: 'POST',
          headers: CONSOLE_HEADERS,
          body: JSON.stringify(answer.body),
        });
        answered = response.ok;
      } catch { /* fall through to opening the queue */ }

      if (answered) {
        // The answer landed and is already broadcast to every open client.
        // Opening a window on top of that would be the console interrupting you
        // a second time for something you have finished with.
        await self.registration.showNotification('Phase Console', {
          body: ANSWER_RECEIPTS[verb || decision] || 'Answered.',
          tag: `answered-${info.approvalId || verb || decision}`,
          data: { url: info.url },
          icon: NOTIFICATION_ICON,
          badge: NOTIFICATION_BADGE,
        });
        return;
      }
      // It did not land — the item may have been cleared, the token may have
      // expired, or this console may lack the capability the action needs.
      // Open the console so it can be seen and answered there.
    }

    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Reuse a window that is already here rather than opening a third console.
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.focus();
      if ('navigate' in client) { try { await client.navigate(target); } catch { /* focus alone is enough */ } }
      return;
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

/**
 * A subscription can be rotated by the push service at any time, and a rotated
 * one that nobody re-registers is a device that has silently stopped being
 * notified. The browser tells us exactly once, here.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const response = await fetch('/api/push');
      const { publicKey } = await response.json();
      if (!publicKey) return;
      const subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: publicKey,
      });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-phase-console': '1' },
        body: JSON.stringify({ subscription: subscription.toJSON(), label: 'a browser (re-registered)' }),
      });
    } catch { /* nothing here can usefully report a failure */ }
  })());
});
