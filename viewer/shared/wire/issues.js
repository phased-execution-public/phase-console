/**
 * The wire of issues — the estate surface under `/api/issues`: the cached
 * board, its refresh, and in Pro the composer and the author pipeline's jobs
 * (measured-console phase 32).
 *
 * Three things the shapes say that a renderer must not flatten:
 *
 * - **`state` is three-valued and `unknown` is not "empty".** A repository whose
 *   probe could not answer keeps its last good rows, with their real age beside
 *   the failure. `fresh | stale | unknown` are three different sentences.
 * - **`never-fetched` is the reason that is NOT a fault.** Nobody has pressed
 *   Refresh yet — the idle sweep deliberately never discovers a repository it
 *   has not been asked about, so an untouched console spends no GitHub quota.
 * - **`body` absent ≠ body empty.** A body arrives only once something asked for
 *   one, within the fetch pass's budget.
 */

/**
 * Why a repository's issues could not be refreshed.
 * @typedef {'no-gh' | 'no-auth' | 'rate-limited' | 'no-remote' | 'never-fetched' | 'failed'} IssueReason
 */

/**
 * How old — and how trustworthy — a repository's rows are.
 * @typedef {'fresh' | 'stale' | 'unknown'} IssueFreshness
 */

/**
 * What kind of repository this is: the estate's own (`root`, `submodule`), or
 * one the operator ADDED to the desk by its `owner/name` (control-tower phase
 * 118) — read and refreshed like the rest, and outside this console.
 * @typedef {'root' | 'submodule' | 'added'} IssueRepoKind
 */

/**
 * What the desk reads off an issue — `shared/issues-model.js` `triageOf`,
 * joined on by the server (with the phase a local plan's `Fixes:` line names).
 * @typedef {object} IssueTriage
 * @property {import('../issues-model.js').IssueCategory} category
 * @property {import('../issues-model.js').IssueSeverityWord} severity
 * @property {{ state: import('../issues-model.js').IssuePlanState; slug?: string; phases?: number[] }} plan
 */

/**
 * Where a session-filed issue came from.
 * @typedef {object} IssueProvenance
 * @property {string} slug
 * @property {number} phase
 * @property {string} [runId]
 * @property {string} draftId
 */

/**
 * @typedef {object} Issue
 * @property {number} number
 * @property {string} state - `OPEN` | `CLOSED`, as `gh` spells it; compared case-insensitively
 * @property {string} title
 * @property {string[]} labels
 * @property {string[]} assignees
 * @property {string} [author] - who opened it — a login; absent when GitHub named nobody, or from a server before 6.1
 * @property {string} [createdAt] - ISO 8601, as GitHub sent it
 * @property {string} updatedAt - ISO 8601, as GitHub sent it
 * @property {string} [closedAt] - ISO 8601 — a closed issue's only
 * @property {string} url
 * @property {IssueTriage} [triage] - category, severity and plan state; absent from a server before 6.1 — read it through `triageOfIssue`
 * @property {string} [body] - present only once a body was asked for; plain text, never rendered as markup
 * @property {boolean} [bodyTruncated] - true when `body` was cut at the server's byte ceiling
 * @property {IssueProvenance} [provenance] - which plan, phase and run FILED this issue, when a session of this console did (phase 12); absent on every issue a person opened
 */

/**
 * @typedef {object} RepoIssues
 * @property {string} key - `root`, or the root-relative submodule path; the ONLY way to name one
 * @property {string} label
 * @property {string} scopeToken - the plan Repos-column token for this repository
 * @property {IssueRepoKind} kind
 * @property {string} [remote] - absent when this repository has no origin at all
 * @property {string} [nameWithOwner] - absent unless the remote is GitHub — and then it is `owner/repo`
 * @property {IssueFreshness} state
 * @property {IssueReason} [reason] - only with `unknown`
 * @property {string} [detail] - only with `unknown` — what `gh` said, already bounded by the server
 * @property {number} [fetchedAt] - epoch ms of the last SUCCESSFUL fetch; absent if there has never been one
 * @property {number} [ageMs] - how old that data is, measured by the SERVER against the payload's own `at`; travels with `fetchedAt` — the age to render
 * @property {number} [retryAt] - epoch ms before which a refresh will not happen; present ONLY with `rate-limited`
 * @property {boolean} [truncated] - more issues exist than the server's list cap holds (2,000 since control-tower phase 118)
 * @property {Issue[]} issues
 */

/**
 * @typedef {object} IssuesPayload
 * @property {number} at - when this payload was assembled — NOT when its data was fetched
 * @property {boolean} refreshing - true while any repository is being fetched right now
 * @property {RepoIssues[]} repos - every repository, always — `unknown` ones included
 */

/**
 * `POST /api/issues/refresh` — one repository by its inventory key, or every askable one when absent.
 * @typedef {object} IssuesRefreshBody
 * @property {string} [repo]
 */


/**
 * Every route this family owns → the typedef its response is (and, for a write, the one it takes).
 * @type {Readonly<Record<string, { response: string, body?: string }>>}
 */
export const WIRE_ROUTES = Object.freeze({
  'GET /api/issues': { response: 'IssuesPayload' },
  'POST /api/issues/refresh': { response: 'IssuesPayload', body: 'IssuesRefreshBody' },
});
