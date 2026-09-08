/**
 * The words the operator steers the queue in, owned once.
 *
 * `worktree-model.js` owns how a run is CHECKED OUT; this file owns the
 * orthogonal question of what runs FIRST. Three knobs, and they are deliberately
 * three rather than one number:
 *
 *   RUN_PRIORITIES        which class an admission is scanned in  (a setting)
 *   ORCHESTRATION_VERBS   what an operator can do to the queue    (an action)
 *   the hold/chain holders   why an entry is not moving           (a reason)
 *
 * None of them reorders anything by itself. Priority is an INPUT to the same
 * deterministic first-fit scan the scheduler has always run; hold and the
 * `startAfter` chain are pseudo-holders that make an entry skip, in exactly the
 * vocabulary the queue page already renders a throttle or a boarding window in.
 * The scheduler never invents an order — that is the whole reason this is data
 * and not a heuristic, and it is why the aging/starvation promotion survives
 * priority unchanged: a class is a preference, and starvation is a bug.
 *
 * ⚠️ Data only, no imports — the client bundles this module and `node --test`
 * imports it directly, so it must stay free of anything either cannot resolve.
 * `test/vocab-owners.test.ts` registers every list here: a second spelling of
 * one anywhere under `shared/`, `server/` or `client/src/` fails that scan.
 */

/**
 * Which class an admission is scanned in.
 *
 * Ordered most-urgent first, and that order IS the scan order — `indexOf` on
 * this array is the rank, so adding a class between two others is one edit
 * here rather than a comparator somewhere else.
 *
 * **Absent means `normal`**, the same omission convention `isolation` and
 * `gitMode` use and for the same reason: every run file written before
 * priorities existed must keep meaning exactly what it meant, and the safe
 * answer must be the one you get by saying nothing.
 * @typedef {'high'|'normal'|'low'} RunPriority
 * @type {readonly RunPriority[]}
 */
export const RUN_PRIORITIES = Object.freeze(/** @type {const} */ (['high', 'normal', 'low']));

/** The class a run is in when it never said. Named, so no reader re-types it. */
export const DEFAULT_PRIORITY = /** @type {const} */ ('normal');

/** What the operator reads next to each choice. */
export const PRIORITY_LABELS = Object.freeze({
  high: 'High — scanned before everything that is not starving',
  normal: 'Normal — the shipped behaviour, first come first served',
  low: 'Low — yields to everything until it starves, then it does not',
});

/**
 * Coerce anything at all to a class, by EXACT literal.
 *
 * The `isolationMode()` rule, for the same reason: a typo in a run file, a
 * stale client or a hand-edited checkpoint must never be what moves a run to
 * the front of the queue. Only the three words, spelled exactly; everything
 * else — including `'High'`, `1`, `true` and `undefined` — reads as `normal`.
 * @param {unknown} value
 * @returns {RunPriority}
 */
export function runPriority(value) {
  return RUN_PRIORITIES.includes(/** @type {never} */ (value))
    ? /** @type {RunPriority} */ (value)
    : DEFAULT_PRIORITY;
}

/**
 * Where a class sits in the scan. Lower is scanned first.
 *
 * A free function rather than a comparator so both languages of this codebase
 * — the scheduler's sort and the client's queue rendering — rank identically
 * without either owning the rule.
 * @param {unknown} value
 * @returns {number}
 */
export function priorityRank(value) {
  return RUN_PRIORITIES.indexOf(runPriority(value));
}

/**
 * What an operator may do to the queue, by name.
 *
 * `hold`/`release` are RUN-level and durable — they live on the run's
 * checkpoint, so a held run is still held after a console restart. `bump` is
 * ENTRY-level and ephemeral: it names one queue entry, and the pending
 * `admit()` promises that entry belongs to do not survive a restart either, so
 * neither does the bump. Keeping the two apart is why this is one list of verbs
 * and not one verb with a scope argument.
 * @typedef {'hold'|'release'|'bump'} OrchestrationVerb
 * @type {readonly OrchestrationVerb[]}
 */
export const ORCHESTRATION_VERBS = Object.freeze(/** @type {const} */ (['hold', 'release', 'bump']));

/**
 * The pseudo-holder `slug` a held run's entries wait on.
 *
 * A held entry is not blocked by scope, so it must not be described as if it
 * were — the queue page reads `slug`/`owner` off a holder and would otherwise
 * say a plan was waiting for itself.
 */
export const HOLD_HOLDER = /** @type {const} */ ('hold');

/** The pseudo-holder `slug` an entry chained behind another plan waits on. */
export const CHAIN_HOLDER = /** @type {const} */ ('chain');

/**
 * The pseudo-holder `slug` every entry waits on while the whole fleet is frozen.
 *
 * A third holder rather than a wider reading of the first two, because it
 * answers a different question: `hold` is about ONE plan standing aside,
 * `chain` is about one plan following another, and this is about the console as
 * a whole having been switched off at the wall. The queue page has to be able
 * to say which of the three it is — an operator reading "held" against eleven
 * queued entries goes looking for eleven holds they never set.
 */
export const FLEET_HOLDER = /** @type {const} */ ('fleet freeze');

/**
 * The sentence every entry shows while the fleet is frozen. One function, for
 * the reason `chainReason` is one: the server writes it into the holder and the
 * client renders it, and two spellings of it would be a fourth vocabulary.
 * @param {string|undefined} by
 * @returns {string}
 */
export function fleetFreezeReason(by) {
  return by ? `the console is frozen by ${by}` : 'the console is frozen';
}

/**
 * The sentence a chained entry shows. One function, because the server writes
 * it into the holder and the client renders it, and a chain that said two
 * different things on two surfaces would be a fourth vocabulary.
 * @param {string} slug
 * @returns {string}
 */
export function chainReason(slug) {
  return `waiting for ${slug} to settle`;
}

/**
 * The sentence a held run's entries show.
 * @param {string|undefined} by
 * @returns {string}
 */
export function holdReason(by) {
  return by ? `held by ${by}` : 'held';
}
