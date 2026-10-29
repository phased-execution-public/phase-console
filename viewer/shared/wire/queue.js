/**
 * The wire of queue — admission: the queue's read and an operator's word on a
 * phase's place (`/api/queue`) (measured-console phase 32).
 *
 * Today's queue view itself — `QueueView`, `QueueSnapshot`, `QueueControl`,
 * `QueueLoad` — is `state.js`'s, as the console's state carries it.
 */

/* ------------------------------------------------------------------ *
 * The queue — `GET /api/queue`, `POST /api/queue/<verb>`, `POST /api/queue/policy`
 * ------------------------------------------------------------------ */

/**
 * A queue move's target — a phase of a run, or an entry by id — and what it is
 * written down with (`POST /api/queue/<verb>`, control-tower phase 99).
 * @typedef {object} QueueMoveBody
 * @property {string} [slug]
 * @property {number} [phase]
 * @property {string} [entryId]
 * @property {string} [reason]
 * @property {string} [until] - `defer`: when the hold lifts by itself, an ISO time
 * @property {'front'} [position] - `requeue`: back in at the front rather than at its seniority
 * @property {number[]} [phases] - `reorder`: the run's phases in their new order
 */

/**
 * What a queue verb answers: the snapshot after it, and what changed.
 * @typedef {import('./state.js').QueueSnapshot & QueueChange} QueueActAnswer
 */

/**
 * The change a queue verb made — `changed: false` when the mark was already there.
 * @typedef {object} QueueChange
 * @property {{ verb: string; slug: string; phase: number | null; changed: boolean }} change
 */

/**
 * What the queue's policy door takes: the console's word, a plan's own (`slug`; `null` gives it back), the load factor.
 * @typedef {object} QueuePolicyChange
 * @property {string | null} [policy]
 * @property {string} [slug]
 * @property {number} [loadFactor]
 * @property {string} [reason]
 */

/**
 * `POST /api/queue/policy` — the whole policy and the load reading after the change.
 * @typedef {{ policy: NonNullable<import('./state.js').QueueView['policy']>; load: import('./state.js').QueueLoad }} QueuePolicyAnswer
 */


/**
 * Every route this family owns → the typedef its response is (and, for a write, the one it takes).
 * @type {Readonly<Record<string, { response: string, body?: string }>>}
 */
export const WIRE_ROUTES = Object.freeze({
  'GET /api/queue': { response: 'QueueView' },
  'POST /api/queue/bump': { response: 'QueueActAnswer', body: 'QueueMoveBody' },
  'POST /api/queue/hold': { response: 'QueueActAnswer', body: 'QueueMoveBody' },
  'POST /api/queue/release': { response: 'QueueActAnswer', body: 'QueueMoveBody' },
  'POST /api/queue/defer': { response: 'QueueActAnswer', body: 'QueueMoveBody' },
  'POST /api/queue/withdraw': { response: 'QueueActAnswer', body: 'QueueMoveBody' },
  'POST /api/queue/requeue': { response: 'QueueActAnswer', body: 'QueueMoveBody' },
  'POST /api/queue/reorder': { response: 'QueueActAnswer', body: 'QueueMoveBody' },
  'POST /api/queue/policy': { response: 'QueuePolicyAnswer', body: 'QueuePolicyChange' },
});
