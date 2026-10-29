/**
 * The wire of notifications — the inbox of records the console announced
 * (`/api/notifications`), the push register (`/api/push`) and the outbound
 * webhooks (`/api/webhooks`) (measured-console phase 32).
 */

/* ---------------- the notification inbox ---------------- */

/**
 * What happened when a notification was handed to one device.
 * @typedef {(typeof import('../ops-vocab.js').DELIVERY_OUTCOMES)[number]} DeliveryOutcome
 */

/**
 * One device's delivery of one notification (`server/notifications.ts`).
 * @typedef {object} DeliveryRecord
 * @property {string} device - the push register's device id
 * @property {string} label - what that browser called itself, so a row still reads after the device is gone
 * @property {DeliveryOutcome} outcome
 * @property {string} at
 * @property {string} [detail]
 */

/**
 * One record the console announced (`server/notifications.ts` `NotificationRecord`).
 * @typedef {object} NotificationRecord
 * @property {string} id
 * @property {string} at
 * @property {string} category
 * @property {string} title
 * @property {string} body
 * @property {string} url - built by the server's `routeFor` and never by hand
 * @property {string} [slug] - what it is about — the fields a scoped read matches on
 * @property {string} [runId]
 * @property {number} [phase]
 * @property {string} [sessionId]
 * @property {boolean} urgent
 * @property {boolean} read
 * @property {DeliveryRecord[]} delivery
 * @property {{ at: string; reason: string }} [resolved] - its subject dissolved on its own (the board moved past the halt)
 * @property {{ action: string; title: string }[]} [actions] - the buttons the phone's notification offered (phase 25)
 * @property {string} [callback] - the one-shot token that answers those buttons
 */

/**
 * One announcement category of the catalogue (`server/push/catalogue.ts` `Category`).
 * @typedef {object} NotificationCategory
 * @property {string} id
 * @property {string} label
 * @property {string} detail
 * @property {boolean} byDefault - on for a new subscription unless it is asked to be otherwise
 * @property {boolean} urgent - interrupts a focus mode; reserved for "nothing proceeds without you"
 */

/**
 * `GET /api/notifications`: one page of the inbox, newest first, with the two
 * facts that explain a notification you never got.
 * @typedef {object} InboxPage
 * @property {NotificationRecord[]} items
 * @property {number} total
 * @property {number} unread
 * @property {boolean} more - `items` was cut short — so "Show older" can be offered honestly
 * @property {readonly NotificationCategory[]} categories
 * @property {number} devices - how many devices are subscribed; a count, not the register
 * @property {{ configured: boolean }} outOfBand
 */

/**
 * Which records a scoped read marks. Every field given must match, and an
 * empty scope matches **nothing** — a page whose slug has not resolved yet must
 * not clear the whole inbox.
 * @typedef {object} NotificationScope
 * @property {string} [slug]
 * @property {string} [category]
 * @property {string} [runId]
 * @property {string} [sessionId]
 * @property {number} [phase]
 */

/**
 * `POST /api/notifications/read`'s body: a scope (any of its keys present), or
 * the ids to mark — none meaning every unread one.
 * @typedef {NotificationScope | { ids?: string[] }} NotificationReadBody
 */

/**
 * `POST /api/notifications/unread`'s body: only ids — an empty list changes nothing.
 * @typedef {{ ids: string[] }} NotificationUnreadBody
 */

/**
 * What a read or put-back changed, and the unread count after it.
 * @typedef {object} ReadResult
 * @property {number} changed
 * @property {number} unread
 */

/**
 * `DELETE /api/notifications?id=|?scope=read|all`: how many records went, and the unread count after.
 * @typedef {object} NotificationClearResult
 * @property {number} removed
 * @property {number} unread
 */

/* ---------------- push ----------------
 * The endpoint and keys never leave the server; `service` is the endpoint's
 * origin, which is the only thing a browser can match its own subscription
 * against. */

/**
 * A device's daily do-not-disturb window, 'HH:MM' on the server's own clock —
 * which is the operator's clock, since the console runs on their machine.
 * Absent means off. `allowUrgent` lets the "nothing proceeds without you"
 * categories break through; it defaults on.
 * @typedef {object} PushQuietHours
 * @property {string} start
 * @property {string} end
 * @property {boolean} allowUrgent
 */

/**
 * A device as the page sees it (`server/push/index.ts` `PublicDevice`): never its endpoint.
 * @typedef {object} PushDevice
 * @property {string} id
 * @property {string} label
 * @property {string} service
 * @property {string} [endpointTag] - sha256 of the device's endpoint, first 16 hex — how a page finds its own row (#325)
 * @property {Record<string, boolean>} categories
 * @property {string} createdAt
 * @property {string | null} lastOkAt
 * @property {number} failures
 * @property {{ at: string; status: number; reason: string | null }} [lastReject] - the most recent rejection, classified (the server sends it; no page reads it yet)
 * @property {PushQuietHours} [quiet]
 * @property {string} [site] - the origin the subscription came in under, when its caller said (the server sends it; no page reads it yet)
 * @property {string} [deviceId] - the paired device it belongs to, when admitted as one (the server sends it; no page reads it yet)
 */

/**
 * `GET /api/push`: the public key, the register and the catalogue.
 * @typedef {object} PushState
 * @property {string} publicKey
 * @property {PushDevice[]} devices
 * @property {readonly NotificationCategory[]} categories
 */

/**
 * `POST /api/push/subscribe`'s body: the browser's `PushSubscription.toJSON()`.
 * @typedef {object} PushSubscribeBody
 * @property {unknown} subscription
 * @property {string} label
 * @property {Record<string, boolean>} [categories]
 */

/**
 * `POST /api/push/subscribe`: the device as registered, and the register after.
 * @typedef {object} PushSubscribeAnswer
 * @property {PushDevice} device
 * @property {PushState} state
 * @property {string} [error] - never on a 200: a refused subscription is a 400 whose body is `{ error }`
 */

/**
 * `POST /api/push/unsubscribe`'s body: the endpoint (a page's own browser) or the device id.
 * @typedef {object} PushUnsubscribeBody
 * @property {string} [endpoint]
 * @property {string} [id]
 */

/**
 * `POST /api/push/unsubscribe`: whether a row went, and the register after.
 * @typedef {object} PushUnsubscribeAnswer
 * @property {boolean} removed
 * @property {PushState} state
 */

/**
 * The body naming one row (a device or a webhook) and nothing else.
 * @typedef {object} DeliveryTargetBody
 * @property {string} id
 */

/**
 * The body setting one row's (a device's or a webhook's) categories.
 * @typedef {object} DeliveryCategoriesBody
 * @property {string} id
 * @property {Record<string, boolean>} categories
 */

/**
 * `POST /api/push/quiet`'s body: `null` clears the window; a malformed one is a 400.
 * @typedef {object} PushQuietBody
 * @property {string} id
 * @property {PushQuietHours | null} quiet
 */

/**
 * `POST /api/push/categories` and `/quiet`: the device as it now is, and the register after.
 * @typedef {object} PushDeviceAnswer
 * @property {PushDevice} device
 * @property {PushState} state
 */

/**
 * `POST /api/push/test` and `/api/webhooks/test`: whether the one delivery was handed on, in words.
 * @typedef {object} DeliveryTestAnswer
 * @property {boolean} ok
 * @property {string} detail
 */

/**
 * `POST /api/push/action`'s body: the signed token a notification's buttons carry, and the verb pressed.
 * @typedef {object} PushActionBody
 * @property {string} token
 * @property {string} action
 */

/**
 * `POST /api/push/action`: the answer taken — which verb, on which inbox item.
 * Every refusal is a plain status (403, 409, …) whose body is `{ error }`.
 * @typedef {object} PushActionAnswer
 * @property {true} ok
 * @property {string} verb
 * @property {string} item
 */

/* ---------------- outbound webhooks ---------------- */

/**
 * One webhook as the API serves it (`server/webhooks.ts` `PublicWebhook`). A
 * row never carries its URL — a webhook URL is a bearer credential — so it is
 * identified by `origin` + `tail`.
 * @typedef {object} WebhookRow
 * @property {string} id
 * @property {string} label
 * @property {string} origin - `https://hooks.example.com` — never the path that authorises
 * @property {string} tail - the last few characters of the path, so two rows on one host differ
 * @property {Record<string, boolean>} categories
 * @property {string} createdAt
 * @property {string | null} lastOkAt
 * @property {number} failures
 * @property {{ at: string; status: number; reason: string | null }} [lastFailure]
 * @property {number} [quietUntil] - epoch ms this row is backing off until; absent when it is not
 * @property {true} [profile] - a row read from the machine profile (`fleet.json`): delivered to, never removed here
 * @property {string | null} [secretHint] - the signing secret's last characters (phase 17); null on a profile row that names none; always sent by the server
 * @property {number} [queued] - announcements held while it backs off; always sent by the server
 * @property {string} [secret] - the secret WHOLE — on the add's answer only, the one time it is shown
 */

/**
 * `GET /api/webhooks`: the register, and the catalogue its rows pick from.
 * @typedef {object} WebhooksState
 * @property {boolean} allowWebhooks - `--allow-webhooks`; reading the list never needs it, changing one does
 * @property {WebhookRow[]} hooks
 * @property {readonly NotificationCategory[]} categories
 */

/**
 * `POST /api/webhooks/add`'s body.
 * @typedef {object} WebhookAddBody
 * @property {string} url
 * @property {string} [label]
 * @property {Record<string, boolean>} [categories]
 */

/**
 * `POST /api/webhooks/add` and `/categories`: the row as it now is, and the register after.
 * A refused add is a 400 whose body is `{ error }`.
 * @typedef {object} WebhookAnswer
 * @property {WebhookRow} hook
 * @property {WebhooksState} state
 */

/**
 * `POST /api/webhooks/remove`: whether a row went, and the register after.
 * @typedef {object} WebhookRemoveAnswer
 * @property {boolean} removed
 * @property {WebhooksState} state
 */

/**
 * Every route this family owns → the typedef its response is (and, for a write, the one it takes).
 * @type {Readonly<Record<string, { response: string, body?: string }>>}
 */
export const WIRE_ROUTES = Object.freeze({
  'GET /api/push': { response: 'PushState' },
  'POST /api/push/subscribe': { response: 'PushSubscribeAnswer', body: 'PushSubscribeBody' },
  'POST /api/push/unsubscribe': { response: 'PushUnsubscribeAnswer', body: 'PushUnsubscribeBody' },
  'POST /api/push/categories': { response: 'PushDeviceAnswer', body: 'DeliveryCategoriesBody' },
  'POST /api/push/quiet': { response: 'PushDeviceAnswer', body: 'PushQuietBody' },
  'POST /api/push/test': { response: 'DeliveryTestAnswer', body: 'DeliveryTargetBody' },
  'POST /api/push/action': { response: 'PushActionAnswer', body: 'PushActionBody' },
  'GET /api/webhooks': { response: 'WebhooksState' },
  'POST /api/webhooks/add': { response: 'WebhookAnswer', body: 'WebhookAddBody' },
  'POST /api/webhooks/remove': { response: 'WebhookRemoveAnswer', body: 'DeliveryTargetBody' },
  'POST /api/webhooks/categories': { response: 'WebhookAnswer', body: 'DeliveryCategoriesBody' },
  'POST /api/webhooks/test': { response: 'DeliveryTestAnswer', body: 'DeliveryTargetBody' },
  'GET /api/notifications': { response: 'InboxPage' },
  'POST /api/notifications/read': { response: 'ReadResult', body: 'NotificationReadBody' },
  'POST /api/notifications/unread': { response: 'ReadResult', body: 'NotificationUnreadBody' },
  'DELETE /api/notifications': { response: 'NotificationClearResult' },
});
