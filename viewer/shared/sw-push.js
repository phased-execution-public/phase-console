/**
 * The decisions a service worker makes, lifted out of the service worker.
 *
 * `client/src/sw.ts` runs in a worker: no DOM, no test runner, and no way to
 * import it from `node --test` without faking half a browser. But almost
 * nothing in it is actually about being a worker — it is "which title does this
 * payload get", "does this click mean allow", "where does that URL point". Those
 * are ordinary functions over ordinary values, and this is where they live so
 * they can be tested as such (`test/sw-push.test.ts`).
 *
 * What stays in the worker is the part that genuinely needs one: registering
 * listeners, awaiting `showNotification`, matching clients, and the fetch. Those
 * are four lines each and they read as plumbing, which is what they are.
 *
 * Ported from `web/sw.js`. The behaviour is the same one the two live push
 * subscriptions already rely on, with a single deliberate change, marked below.
 *
 * Plain `.js` + JSDoc on purpose — the same file `node --test` imports directly
 * and Vite bundles into the worker, with no build step between them.
 */

/** Same header the app sends: the server refuses a mutation without it. */
export const CONSOLE_HEADERS = Object.freeze({
  'content-type': 'application/json',
  'x-phase-console': '1',
});

/** The icon on the notification itself. */
export const NOTIFICATION_ICON = '/icons/icon-192.png';

/**
 * The small monochrome mark Android puts in the status bar. It is drawn as a
 * mask — only the alpha channel survives — so a full-colour icon there arrives
 * as a grey blob. `icon-badge-96.png` is the mark in flat white for exactly this.
 */
export const NOTIFICATION_BADGE = '/icons/icon-badge-96.png';

/**
 * @typedef {object} PushPayload
 * @property {string} [title]
 * @property {string} [body]
 * @property {string} [tag]
 * @property {string} [url]
 * @property {string|null} [category]
 * @property {string|null} [approvalId]
 * @property {string|null} [notificationId]
 * @property {{action: string, title: string}[]|null} [actions]
 * @property {string|null} [callback]
 * @property {{id?: string, name?: string}|null} [console] which console spoke (zero-touch phase 17, FLT-4)
 */

/**
 * A push service is allowed to deliver an empty payload, and a malformed one is
 * indistinguishable from that at this end. Both become `{}` rather than an
 * exception, because on iOS a push that shows *no* notification counts against
 * the app's standing — there always has to be something to show.
 *
 * @param {string|null|undefined} text the raw body, or nothing
 * @returns {PushPayload}
 */
export function parsePayload(text) {
  if (typeof text !== 'string' || text.trim() === '') return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * @param {PushPayload} data
 * @returns {string}
 */
export function notificationTitle(data) {
  const title = data.title || 'Phase Console';
  const name = consoleName(data);
  return name && !title.includes(name) ? `${title} · ${name}` : title;
}

/**
 * The console a payload names, or null (FLT-4). One device can hear several
 * consoles — and, once the fleet has one subscription, every console's traffic
 * arrives through it — so a card that does not say whose it is sends the
 * operator to the wrong console. A name, never an id: the id is for the
 * machine, the name is what the operator called the project.
 *
 * @param {PushPayload} data
 * @returns {string|null}
 */
export function consoleName(data) {
  const spoke = data.console;
  if (!spoke || typeof spoke !== 'object' || typeof spoke.name !== 'string') return null;
  const name = spoke.name.trim();
  return name ? name.slice(0, 40) : null;
}

/**
 * @param {PushPayload} data
 * @returns {NotificationOptions}
 */
export function notificationOptions(data) {
  return {
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
      // Carried onto the notification because `notificationclick` fires with
      // only `event.notification`: whatever is not copied here is gone by the
      // time a button is pressed, which may be hours later.
      actions: notificationActions(data) || null,
      callback: data.callback || null,
      console: consoleName(data),
    },
    // Answering from the lock screen, without unlocking and finding the queue.
    // (Android and desktop honour these; iOS ignores the array and shows the
    // notification, which is the correct degradation and the reason nothing
    // here may depend on a button existing.)
    actions: notificationActions(data),
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_BADGE,
  };
}

/**
 * How many buttons a notification may carry. Android renders two and silently
 * drops the rest; the server caps at the same number (`push/actions.ts`
 * `MAX_NOTIFICATION_ACTIONS`) and this is the second half of that agreement.
 */
export const MAX_NOTIFICATION_ACTIONS = 2;

/**
 * The buttons, from a payload of either generation.
 *
 * A server that knows about action tokens sends `actions` — an explicit list,
 * already ordered and capped, whose verbs the token it rides with authorises.
 * A server that predates them sends only `approvalId`, and the two buttons an
 * approval has always had are synthesised for it. That fallback is not
 * politeness: an operator's phone can hold a subscription made months ago and
 * a worker that only understood the new shape would show a card with no way to
 * answer it.
 *
 * Anything malformed produces NO buttons rather than a partial row — a
 * notification you can only open is the state this whole feature improves on,
 * so degrading to it is always safe.
 *
 * @param {PushPayload} data
 * @returns {NotificationAction[]|undefined}
 */
export function notificationActions(data) {
  if (Array.isArray(data.actions)) {
    const clean = data.actions
      .filter(
        (entry) =>
          entry &&
          typeof entry.action === 'string' &&
          entry.action &&
          typeof entry.title === 'string' &&
          entry.title,
      )
      .slice(0, MAX_NOTIFICATION_ACTIONS)
      .map((entry) => ({ action: entry.action, title: entry.title }));
    return clean.length ? clean : undefined;
  }
  return data.approvalId
    ? [
        { action: 'allow', title: 'Allow' },
        { action: 'deny', title: 'Deny' },
      ]
    : undefined;
}

/**
 * Which button was pressed, as a decision. Anything that is not one of the two
 * action buttons — including the body of the notification — is not an answer.
 *
 * @param {string|undefined} action
 * @returns {'allow'|'deny'|null}
 */
export function decisionOf(action) {
  if (action === 'allow') return 'allow';
  if (action === 'deny') return 'deny';
  return null;
}

/**
 * Which button was pressed, as a verb the callback route will accept.
 *
 * Deliberately checked against the payload's OWN action list rather than a
 * vocabulary held here: the server decided which verbs this notification may
 * carry when it minted the token, and a worker that believed a fourth verb
 * existed would post one the route refuses. Tapping the body of the
 * notification — `action` is `''` — is not a press.
 *
 * @param {string|undefined} action
 * @param {PushPayload} data
 * @returns {string|null}
 */
export function actionOf(action, data) {
  if (typeof action !== 'string' || !action) return null;
  const offered = notificationActions(data ?? {});
  if (!offered) return null;
  return offered.some((entry) => entry.action === action) ? action : null;
}

/**
 * Answering from the notification, through the one route that accepts one.
 *
 * The token is a capability over a specific inbox item and a specific set of
 * verbs (`server/push/actions.ts`); this request is the only thing a worker
 * ever does with it. Note what is NOT here: no endpoint, no method, no body
 * from the payload. A worker that could be told where to POST would be a
 * request generator sitting in a notification shade.
 *
 * @param {string} token the payload's `callback`
 * @param {string} action the verb that was pressed
 * @returns {{url: string, init: RequestInit}}
 */
export function actionRequest(token, action) {
  return {
    url: '/api/push/action',
    init: {
      method: 'POST',
      headers: { ...CONSOLE_HEADERS },
      body: JSON.stringify({ token, action, by: 'notification' }),
    },
  };
}

/**
 * Where a click should land.
 *
 * ⚠️ The one deliberate deviation from `web/sw.js`: the result is clamped to
 * this origin. Every URL in a real payload is already relative (`/#/plan/…`),
 * written by the console's own `routeFor`, so nothing legitimate changes — but
 * `new URL(absolute, origin)` would happily resolve to somewhere else, and a
 * notification that can open an arbitrary site is a bigger promise than this
 * needs to make.
 *
 * @param {{url?: string}|null|undefined} info the notification's `data`
 * @param {string} origin
 * @returns {string} an absolute URL on `origin`
 */
export function clickTarget(info, origin) {
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

/**
 * Marking a notification read happens on *click*, not on arrival: one you never
 * saw must still be waiting in the inbox when you do look.
 *
 * @param {string|null|undefined} notificationId
 * @returns {{url: string, init: RequestInit}|null} null when there is nothing to mark
 */
export function readRequest(notificationId) {
  if (!notificationId) return null;
  return {
    url: '/api/notifications/read',
    init: {
      method: 'POST',
      headers: { ...CONSOLE_HEADERS },
      body: JSON.stringify({ ids: [notificationId] }),
    },
  };
}

/**
 * Answering an approval from the lock screen — the round trip that is the
 * whole product.
 *
 * @param {string} approvalId
 * @param {'allow'|'deny'} decision
 * @returns {{url: string, init: RequestInit}}
 */
export function decisionRequest(approvalId, decision) {
  return {
    url: `/api/approvals/${encodeURIComponent(approvalId)}`,
    init: {
      method: 'POST',
      headers: { ...CONSOLE_HEADERS },
      body: JSON.stringify({ decision, by: 'notification' }),
    },
  };
}

/**
 * What each answer is reported as, once it has landed.
 *
 * One sentence per verb, in the past tense, saying what the answer DID rather
 * than that it was recorded — "Allowed" is a receipt, "Your decision was
 * submitted" is a progress bar. An unknown verb (a newer server, an older
 * worker) still gets a receipt rather than silence: the answer did land, and
 * the operator has no way to check from a lock screen.
 */
export const ANSWER_RECEIPTS = Object.freeze({
  allow: 'Allowed. The session is carrying on.',
  deny: 'Denied. The session was told.',
  approve: 'Gate approved. The phase can board.',
});

/**
 * The receipt shown when an answer landed. Opening a window on top of that
 * would be the console interrupting you a second time for something you have
 * already finished with.
 *
 * @param {string} verb `allow`, `deny`, `approve` — or anything a newer server sent
 * @param {{url?: string, approvalId?: string|null, callback?: string|null}} info
 * @returns {[string, NotificationOptions]} arguments for `showNotification`
 */
export function answeredNotification(verb, info) {
  return [
    'Phase Console',
    {
      body: ANSWER_RECEIPTS[verb] || 'Answered.',
      // The approval id when there is one, so a re-answered card replaces its
      // own receipt; otherwise the verb, which still collapses a double-tap.
      tag: `answered-${info.approvalId || verb}`,
      data: { url: info.url },
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_BADGE,
    },
  ];
}

/**
 * Re-registering after the push service rotates a subscription. A rotated
 * subscription nobody re-registers is a device that has silently stopped being
 * notified, and the browser says so exactly once.
 *
 * @param {object} subscription the result of `subscription.toJSON()`
 * @param {string} [label]
 * @returns {{url: string, init: RequestInit}}
 */
export function resubscribeRequest(subscription, label = 'a browser (re-registered)') {
  return {
    url: '/api/push/subscribe',
    init: {
      method: 'POST',
      headers: { ...CONSOLE_HEADERS },
      body: JSON.stringify({ subscription, label }),
    },
  };
}
