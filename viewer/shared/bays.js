/**
 * The Tower's bays, most urgent first (control-tower §Architecture 5) — the
 * places a run can sit on `#/runs`.
 *
 * A leaf of its own so the ROUTES can hold `?bay=` to it: `client/src/app/
 * routes.ts` is first paint, and `status-model.js` — which owns what puts a
 * run in a bay (`bayOf`) — is not (check-dist: first paint carries none of the
 * status word tables). `status-model.js` re-exports this very object, so every
 * reader holds one list, and `test/vocab-owners.test.ts` names this file its
 * owner. Dependency-free ESM.
 *
 * @typedef {(typeof BAYS)[number]} Bay
 */

export const BAYS = Object.freeze(
  /** @type {const} */ (['needs-you', 'live', 'waiting', 'queued', 'ready', 'settled']),
);
