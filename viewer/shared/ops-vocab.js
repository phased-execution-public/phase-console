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

/**
 * What the permission policy in force can be warned about (zero-touch phase
 * 12, chapter 08 TRS-9): `ask-empty` — the merged ask list holds nothing, so
 * no profile asks and the three postures are one; `deny-struck` — a shipped
 * deny rule is struck out of the wall that holds with the console dead. Each
 * is emitted once per boot (`policy.advisory`), carried by `GET /api/policy`
 * and acknowledged by the operator against the rule set it named — a changed
 * set stands again. Owner; the server and the policy page import it.
 * @typedef {'ask-empty'|'deny-struck'} PolicyAdvisoryKind
 * @type {readonly PolicyAdvisoryKind[]}
 */
export const POLICY_ADVISORY_KINDS = Object.freeze(/** @type {const} */ (['ask-empty', 'deny-struck']));

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
 * The usage levels the console acts on, in PERCENT (0–100) — the account
 * meters' unit, and the unit `utilizationPct` carries on an in-session
 * `rate_limit_event`. At `WARN_PCT` an account's meter is announced; at
 * `ALERT_PCT` it is announced urgently, and a session's `allowed_warning` past
 * it becomes a journalled decision (`run.usage-decision`) rather than a line
 * nothing reads. One pair for both readings, so a meter and a live session can
 * never disagree about when "high" begins.
 */
export const WARN_PCT = 80;
export const ALERT_PCT = 95;

/**
 * A meter at or past this, in percent, IS a wall: the poller stops asking an
 * account with a live session about it more often than an idle one, and a
 * session's own `rate_limit_event` at this utilization counts as a wall hit
 * whatever the status word says (the audit's ACT-7: `rejected` had arrived
 * zero times in 7 326 events, so a detector keyed on the word alone never
 * fired; `allowed_warning` at 0.99 is the shape that does arrive).
 */
export const WALL_PCT = 99;

/**
 * Whether an account can currently start a session. `unknown` is honest — a
 * profile the console has not probed — and must never paint as `ok`.
 * `unusable` is the breaker's word (zero-touch-console phase 8): a credential
 * the API REFUSED on a ground no re-login mends — an organisation policy, a
 * billing hold, a revoked key — retired until a person clears it. It is not a
 * login state the CLI can report, which is why it sits beside `signed-out`
 * rather than replacing it: the login may be perfectly valid and still be
 * refused work.
 * @typedef {'ok'|'expiring'|'expired'|'signed-out'|'unknown'|'unusable'} AuthState
 * @type {readonly AuthState[]}
 */
export const AUTH_STATES = Object.freeze(
  /** @type {const} */ (['ok', 'expiring', 'expired', 'signed-out', 'unknown', 'unusable']),
);

/**
 * Where a credential stands with the organisation that pays for it — the
 * breaker, learned machine-wide and keyed by `orgId` as well as by account
 * (zero-touch-console phase 8, SES-2/ACT-8). Four states, one machine:
 *
 *   unknown  → entitled | retired
 *   entitled → cooling  | retired
 *   cooling  → entitled | retired
 *   retired  → unknown            (an operator clears it, or the orgId changes)
 *
 * `unknown` is a credential nobody has proved can pay; `entitled` is one that
 * has — a successful meter read, or a session that spent under it; `cooling`
 * is one a usage wall left, excluded for the wall's own reset or, when none
 * parsed, `ACCOUNT_COOLDOWN_MS`; `retired` is the credential-class refusal
 * (org policy · auth · billing), which excludes EVERY account sharing the
 * orgId until a person clears it. `unknown` ranks below `entitled`.
 * @typedef {'unknown'|'entitled'|'cooling'|'retired'} EntitlementState
 * @type {readonly EntitlementState[]}
 */
export const ENTITLEMENT_STATES = Object.freeze(
  /** @type {const} */ (['unknown', 'entitled', 'cooling', 'retired']),
);

/**
 * The transitions the breaker accepts, `from → to[]`. A write outside this
 * table is refused and logged rather than applied — a `retired` credential
 * does not become `entitled` because a poll happened to succeed; only a
 * person's clearance (or a new orgId) opens it, and then only to `unknown`.
 * @type {Readonly<Record<EntitlementState, readonly EntitlementState[]>>}
 */
export const ENTITLEMENT_TRANSITIONS = Object.freeze({
  unknown: Object.freeze(/** @type {const} */ (['entitled', 'retired'])),
  entitled: Object.freeze(/** @type {const} */ (['cooling', 'retired'])),
  cooling: Object.freeze(/** @type {const} */ (['entitled', 'retired'])),
  retired: Object.freeze(/** @type {const} */ (['unknown'])),
});

/**
 * Why a run LEFT an account — the one helper's vocabulary (`leaveAccount`).
 * `usage` is a window (a wall the classifier or the live stream saw);
 * `credential` is the refusal class that retires; `operator` is a person's
 * switch, recorded and never held against the account.
 * @typedef {'usage'|'credential'|'operator'} LeaveKind
 * @type {readonly LeaveKind[]}
 */
export const LEAVE_KINDS = Object.freeze(/** @type {const} */ (['usage', 'credential', 'operator']));

/**
 * The credential-class refusals the classifier can name — each one retires
 * the account's orgId. Spelled once here; `runner/errors.ts` reads them off
 * the CLI's own `api_retry` categories and the API's sentences.
 * `certificate` joined in zero-touch-console phase 9: two of the audit's
 * zero-cost sessions died to "Self-signed certificate detected" — a TLS
 * interception between this machine and the API, which no re-board and no
 * other phase can get past, and which the patterns did not know (RCV-2).
 * @typedef {'org-policy'|'auth'|'billing'|'certificate'} CredentialClass
 * @type {readonly CredentialClass[]}
 */
export const CREDENTIAL_CLASSES = Object.freeze(
  /** @type {const} */ (['org-policy', 'auth', 'billing', 'certificate']),
);

/** @param {unknown} v @returns {v is AccountKind} */
export function isAccountKind(v) {
  return typeof v === 'string' && ACCOUNT_KINDS.includes(/** @type {AccountKind} */ (v));
}

/** @param {unknown} v @returns {v is AuthState} */
export function isAuthState(v) {
  return typeof v === 'string' && AUTH_STATES.includes(/** @type {AuthState} */ (v));
}

/** @param {unknown} v @returns {v is EntitlementState} */
export function isEntitlementState(v) {
  return typeof v === 'string' && ENTITLEMENT_STATES.includes(/** @type {EntitlementState} */ (v));
}

/**
 * May the breaker move `from` to `to`? The same state twice is a no-op, not a
 * transition, and is answered true so a re-write of the same fact is idempotent.
 * @param {EntitlementState} from @param {EntitlementState} to
 */
export function entitlementMayMove(from, to) {
  return from === to || ENTITLEMENT_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Shutdown and boot (zero-touch phase 16)
// ---------------------------------------------------------------------------

/**
 * How strong a Shut down press is (SHD-2). `exit` ends the process — under a
 * supervisor that keeps the job alive it comes straight back, which is what
 * makes it the default there; `unload` is the explicit "stay off": the unit is
 * unloaded AND disabled and a marker is written that a boot honours, so not
 * even a login brings the automation back until somebody clears it.
 * @typedef {(typeof SHUTDOWN_MODES)[number]} ShutdownMode
 */
export const SHUTDOWN_MODES = Object.freeze(/** @type {const} */ (['exit', 'unload']));

/**
 * What a stop plan achieves once carried out (SHD-5), said on
 * `shutdown.requested` and by the dialog before the press: `returns` — a
 * supervisor brings it straight back; `until-login` — nothing brings it back
 * now, and the next login (or boot) starts the unit again; `stays-off` —
 * nothing starts it again at all; `disabled` — the unit is unloaded and
 * disabled and the stop marker holds the boot, so not even a login restarts
 * the work until the marker is cleared.
 * @typedef {(typeof SHUTDOWN_DURABILITIES)[number]} ShutdownDurability
 */
export const SHUTDOWN_DURABILITIES = Object.freeze(
  /** @type {const} */ (['returns', 'until-login', 'stays-off', 'disabled']),
);

/**
 * Why the process is going away (SHD-8), beside the signal that carried it:
 * `shutdown` — somebody pressed Shut down (the API); `restart` — somebody
 * pressed Restart; `signal` — a SIGTERM/SIGINT no request explains (a logout,
 * a `kill`, launchd stopping the job). `exit` and `shutdown.begin` carry it,
 * and so does every `run.shutdown-child` and `run.console-shutdown`.
 * @typedef {(typeof SHUTDOWN_INTENTS)[number]} ShutdownIntent
 */
export const SHUTDOWN_INTENTS = Object.freeze(/** @type {const} */ (['shutdown', 'restart', 'signal']));

/**
 * The in-process clocks a shutdown discards (SHD-1), each named with its
 * moment on the readiness inventory: `wait-resume` — a usage window's or a
 * declared park's resume (`armLimitResume`); `freeze-escalation` — a freeze's
 * promise to convert; `mcp-require` — a `require` park's continue-without
 * clock; `outcome-inbox` — an unsupervised declaration not yet read (its
 * debounce); `session-inbox` — presence drops not yet drained; `converge` — a
 * convergence pass already booked. Every one is re-armed from disk by the next
 * boot, and the inventory says so rather than calling them lost.
 * @typedef {(typeof SHUTDOWN_CLOCK_SOURCES)[number]} ShutdownClockSource
 */
export const SHUTDOWN_CLOCK_SOURCES = Object.freeze(
  /** @type {const} */ ([
    'wait-resume',
    'freeze-escalation',
    'mcp-require',
    'outcome-inbox',
    'session-inbox',
    'converge',
  ]),
);

/**
 * Why a console boots holding its automation (SHD-5, FLT-9): `stopped` — the
 * stop marker a `mode: 'unload'` shutdown wrote is still on disk; `autostart-off`
 * — the machine profile (`fleet.json`) says this instance does not start its
 * work unattended. While either holds, nothing is re-adopted and nothing
 * converges; an operator's release (Settings, or `phase-console start` for the
 * marker) lifts it.
 * @typedef {(typeof BOOT_HOLD_KINDS)[number]} BootHoldKind
 */
export const BOOT_HOLD_KINDS = Object.freeze(/** @type {const} */ (['stopped', 'autostart-off']));

// ---------------------------------------------------------------------------
// Push delivery + ETA
// ---------------------------------------------------------------------------

/**
 * What happened to one push notification. `gone` is a subscription the browser
 * has retired (HTTP 404/410) — the console drops it rather than retrying.
 * `quiet` is a device inside its own quiet hours: nothing was attempted, on
 * purpose, and the ledger says so rather than reading as a failure.
 * `skipped` (zero-touch phase 16, SHD-4) is the console's own row on an
 * announcement it could not see delivered — the shutdown announcement, whose
 * process exits inside its bounded wait, or one with no device to send to —
 * written so the ledger says why it is empty instead of being `[]`. Its
 * `detail` is the why.
 * `no-device` (zero-touch phase 17, FLT-1) is push's row on an announcement no
 * device was there to take — none subscribed, or none to that category — so
 * "did it arrive?" reads "there was nobody to send it to" instead of `[]`.
 * @typedef {(typeof DELIVERY_OUTCOMES)[number]} DeliveryOutcome
 */
export const DELIVERY_OUTCOMES = Object.freeze(
  /** @type {const} */ (['sent', 'throttled', 'failed', 'gone', 'quiet', 'skipped', 'no-device']),
);

/**
 * What one PROBE answered — the run-start prelude's four (accounts, MCP,
 * credentials, delivery) and every `phase-console doctor` row (phase 11).
 * `skip` is "could not be asked here" (no console running, no unit on this
 * platform, no probe for this credential id), which is a different fact from
 * `fail`: a probe that could not RUN never refuses a start, the same rule the
 * MCP preflight has always kept. Every verdict carries a `reason` a stranger
 * can act on and never a secret's value.
 * @typedef {'ok'|'fail'|'skip'} ProbeStatus
 * @type {readonly ProbeStatus[]}
 */
export const PROBE_STATUSES = Object.freeze(/** @type {const} */ (['ok', 'fail', 'skip']));

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
