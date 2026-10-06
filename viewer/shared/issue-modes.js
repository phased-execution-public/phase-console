/**
 * The issue words the console's first paint reads (control-tower phase 123): the
 * issue policy's modes, its default, and the operator's own draft scope.
 *
 * They live apart from `issues-model.js`, which re-exports them, so that the
 * Issues desk's whole model — its triage, fingerprints and author states — stays
 * in the lazy chunks that use it. A module lands in ONE chunk however little of
 * it a chunk reads, so these constants pulled all of it into first paint.
 * `issues-model.js` remains the door every other importer uses.
 */

/**
 * How far a plan lets its sessions go.
 *
 * `off`   — they may not ask. The default: a plan that never considered the
 *           question must not start opening issues on somebody's repository.
 * `draft` — they write drafts; the console holds them in the inbox and a
 *           person presses Approve. The recommended setting.
 * `file`  — they file at once, still through the console's one allow-listed
 *           writer and still inside the budgets.
 */
export const ISSUE_MODES = Object.freeze(/** @type {const} */ (['off', 'draft', 'file']));

/** Silence means off — outward writes are never a default. */
export const DEFAULT_ISSUES = 'off';

/**
 * The ledger scope of a draft an OPERATOR asked for — the issues board's compose
 * door, and `phase-issue.sh` under `PE_ISSUE_DOOR=operator` (control-tower phase
 * 12, #30). Written where a plan slug goes, and it cannot collide with one: a slug
 * starts `[a-z0-9]`. Its phase is always 0, and its draft id is derived from the
 * ticket's session id in the phase's place, so two tickets drafting the same
 * title in the same second are two drafts.
 */
export const OPERATOR_ISSUE_SCOPE = '_operator';
