/**
 * The words for a phase lock seen from outside its plan (#24).
 *
 * A lock is what decides whether a phase may board at all, and until 6.0 it
 * had no view of its own: it reached a reader only as an ingredient of a
 * queue entry, a plan record or a session row. `GET /api/locks` lists every
 * claim this console can see, one row each, and the history ledger
 * (`locks.ndjson`, Pro) records what happened to each. The vocabulary those
 * two speak lives here, imported by identity by the server, the client and
 * the tests (`test/vocab-owners.test.ts`).
 */

/**
 * Who holds a claim: the console's own autopilot (`autopilot/<runId>`, the
 * shape `scheduler.ts`'s `autopilotRunId` reads), or anybody else — a person
 * driving a phase by hand, under whatever owner string they claimed with.
 *
 * @typedef {'autopilot'|'person'} LockHolderKind
 * @type {readonly LockHolderKind[]}
 */
export const LOCK_HOLDER_KINDS = Object.freeze(/** @type {const} */ (['autopilot', 'person']));

/**
 * What the history ledger records, one line per change it observed:
 * - `claimed` — a lock file appeared.
 * - `refreshed` — the same owner renewed it (the lease moved, or the session).
 * - `released` — the file went away.
 * - `lapsed` — still on disk, but its lease ran out or its session ended
 *   (`lockLapsed`), and nobody has taken it yet.
 * - `taken-over` — another owner claimed it after it had lapsed.
 * - `forced` — another owner claimed it while it was still live, or the
 *   console released it with force.
 *
 * @typedef {'claimed'|'refreshed'|'released'|'lapsed'|'taken-over'|'forced'} LockEventKind
 * @type {readonly LockEventKind[]}
 */
export const LOCK_EVENT_KINDS = Object.freeze(
  /** @type {const} */ (['claimed', 'refreshed', 'released', 'lapsed', 'taken-over', 'forced']),
);

/**
 * The narrowing a reader may ask `GET /api/locks` for: `?held=1` (live claims
 * only), `?lapsed=1` (lapsed ones only), `?scope=<repo>` (claims whose scope
 * intersects that token — "who has `app/backend`?").
 *
 * @typedef {'held'|'lapsed'|'scope'} LockFilterKey
 * @type {readonly LockFilterKey[]}
 */
export const LOCK_FILTERS = Object.freeze(/** @type {const} */ (['held', 'lapsed', 'scope']));

/**
 * A row's place in the worst-first order: a lapsed claim still on disk first
 * (it blocks for no reason), then a live one blocking something, then a live
 * one blocking nothing.
 *
 * @param {{ lapsed: boolean, blocking: readonly unknown[] }} row
 * @returns {0 | 1 | 2}
 */
export function lockRowRank(row) {
  if (row.lapsed) return 0;
  return row.blocking.length ? 1 : 2;
}
