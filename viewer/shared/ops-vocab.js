/**
 * The CONSOLE-OPERATIONS vocabularies — words about the machinery the console
 * runs on, rather than about a plan on disk (`plan-vocab.js`) or what a run is
 * doing (`status-vocab.js`).
 *
 * Health issues, MCP servers, Claude accounts, push delivery and ETA basis all
 * live here for the same reason: each had its members written out in a server
 * file AND again in a client API type, and two lists that agree today are two
 * lists that disagree the day a word is added.
 *
 * Dependency-free ESM. `test/vocab-owners.test.ts` holds every importer to
 * this file by import identity.
 */

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * How bad a portfolio health issue is (`analysis/stats.ts`'s `HealthIssue`).
 *
 * ⚠️ NOT the same vocabulary as a Banner's or a chip's `severity`/tone prop,
 * which spells the middle word `warn`. The two are related by a MAPPING, not
 * by being copies — `insights/portfolio.tsx`'s `SEVERITY_TONE` is that map
 * (`warning` → the tone `warn`) — and merging them would tie a data word to a
 * design-system token. An audit flagged `warn` vs `warning` in two adjacent
 * client files as suspected drift; it is not. Leave both spellings alone.
 * @typedef {'error'|'warning'|'info'} HealthSeverity
 * @type {readonly HealthSeverity[]}
 */
export const HEALTH_SEVERITIES = Object.freeze(/** @type {const} */ (['error', 'warning', 'info']));

/** Worst first — the sort order of every issue list. @type {readonly HealthSeverity[]} */
export const HEALTH_SEVERITY_ORDER = HEALTH_SEVERITIES;

/** @param {unknown} v @returns {v is HealthSeverity} */
export function isHealthSeverity(v) {
  return typeof v === 'string' && HEALTH_SEVERITIES.includes(/** @type {HealthSeverity} */ (v));
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

/**
 * What a probe found out about one MCP server. `needs-auth` is the one that
 * earns a person: nothing an unattended session can do will sign a server in.
 * @typedef {'connected'|'needs-auth'|'pending'|'failed'|'unknown'} McpStatus
 * @type {readonly McpStatus[]}
 */
export const MCP_STATUSES = Object.freeze(
  /** @type {const} */ (['connected', 'needs-auth', 'pending', 'failed', 'unknown']),
);

/**
 * Transports, exactly as the CLI spells them in `.mcp.json`.
 *
 * `streamable-http` is the MCP specification's own name for `http` and the CLI
 * accepts it as an alias, so a config pasted from a server's own documentation
 * works unedited. It is normalised to `http` on the way in — one spelling in
 * the registry, both spellings accepted from the world.
 * @typedef {'http'|'sse'|'ws'|'stdio'} McpTransport
 * @type {readonly McpTransport[]}
 */
export const MCP_TRANSPORTS = Object.freeze(/** @type {const} */ (['http', 'sse', 'ws', 'stdio']));

/** @param {unknown} v @returns {v is McpStatus} */
export function isMcpStatus(v) {
  return typeof v === 'string' && MCP_STATUSES.includes(/** @type {McpStatus} */ (v));
}

/** @param {unknown} v @returns {v is McpTransport} */
export function isMcpTransport(v) {
  return typeof v === 'string' && MCP_TRANSPORTS.includes(/** @type {McpTransport} */ (v));
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/**
 * How a registered Claude account authenticates: the CLI's own logged-in
 * default, a named profile directory, or a bare API token.
 * @typedef {'default'|'profile'|'token'} AccountKind
 * @type {readonly AccountKind[]}
 */
export const ACCOUNT_KINDS = Object.freeze(/** @type {const} */ (['default', 'profile', 'token']));

/**
 * Whether an account can currently start a session. `unknown` is honest — a
 * profile the console has not probed — and must never paint as `ok`.
 * @typedef {'ok'|'expiring'|'expired'|'signed-out'|'unknown'} AuthState
 * @type {readonly AuthState[]}
 */
export const AUTH_STATES = Object.freeze(
  /** @type {const} */ (['ok', 'expiring', 'expired', 'signed-out', 'unknown']),
);

/** @param {unknown} v @returns {v is AccountKind} */
export function isAccountKind(v) {
  return typeof v === 'string' && ACCOUNT_KINDS.includes(/** @type {AccountKind} */ (v));
}

/** @param {unknown} v @returns {v is AuthState} */
export function isAuthState(v) {
  return typeof v === 'string' && AUTH_STATES.includes(/** @type {AuthState} */ (v));
}

// ---------------------------------------------------------------------------
// Push delivery + ETA
// ---------------------------------------------------------------------------

/**
 * What happened to one push notification. `gone` is a subscription the browser
 * has retired (HTTP 404/410) — the console drops it rather than retrying.
 * `quiet` is a device inside its own quiet hours: nothing was attempted, on
 * purpose, and the ledger says so rather than reading as a failure.
 * @typedef {'sent'|'throttled'|'failed'|'gone'|'quiet'} DeliveryOutcome
 * @type {readonly DeliveryOutcome[]}
 */
export const DELIVERY_OUTCOMES = Object.freeze(
  /** @type {const} */ (['sent', 'throttled', 'failed', 'gone', 'quiet']),
);

/**
 * What an ETA was computed FROM, weakest evidence last — so the console can
 * say how much to trust the number instead of presenting all three alike.
 * @typedef {'plan'|'portfolio'|'heuristic'} EtaBasis
 * @type {readonly EtaBasis[]}
 */
export const ETA_BASES = Object.freeze(/** @type {const} */ (['plan', 'portfolio', 'heuristic']));

/** @param {unknown} v @returns {v is DeliveryOutcome} */
export function isDeliveryOutcome(v) {
  return typeof v === 'string' && DELIVERY_OUTCOMES.includes(/** @type {DeliveryOutcome} */ (v));
}

/** @param {unknown} v @returns {v is EtaBasis} */
export function isEtaBasis(v) {
  return typeof v === 'string' && ETA_BASES.includes(/** @type {EtaBasis} */ (v));
}
