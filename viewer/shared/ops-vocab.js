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
 * Why an account's credits are off, in words (control-tower phase 93, #146).
 * The usage endpoint's `extra_usage.disabled_reason` and the CLI's
 * `overageDisabledReason` speak one vocabulary (read in the CLI 2.1.283
 * binary); a word not listed here is shown as itself, underscores as spaces,
 * rather than dropped — an unknown reason is still a reason.
 */
export const CREDIT_REASON_WORDS = Object.freeze({
  out_of_credits: 'out of credits',
  org_level_disabled: 'turned off for the organisation',
  org_level_disabled_until: 'turned off for the organisation for now',
  org_service_level_disabled: 'turned off for this service',
  org_spend_cap_reached: "the organisation's spend cap is reached",
  seat_tier_level_disabled: "not available on this seat's tier",
});

/**
 * @param {string | null | undefined} reason
 * @returns {string | null}
 */
export function creditReasonPhrase(reason) {
  if (typeof reason !== 'string' || !reason) return null;
  return Object.hasOwn(CREDIT_REASON_WORDS, reason)
    ? CREDIT_REASON_WORDS[/** @type {keyof typeof CREDIT_REASON_WORDS} */ (reason)]
    : reason.replace(/_/g, ' ');
}

/**
 * How long a session's "running on credit" stays a present-tense fact on the
 * account (control-tower phase 93, #146): past it, with no newer reading, the
 * account no longer says a session is spending credit right now.
 */
export const CREDIT_SESSION_FRESH_MS = 10 * 60_000;

/**
 * The account forecast (control-tower phase 92, #141): a least-squares line
 * through each window's readings of the last `FORECAST_WINDOW_MS`, measured
 * only once two readings lie `FORECAST_MIN_SPAN_MS` apart — two polls a minute
 * apart are noise, not a rate. Under `FORECAST_FLAT_PCT_PER_HOUR` a window
 * reads flat. `usage-climbing` warns `FORECAST_LEAD_HOURS` before an account
 * serving live runs is projected to wall, unless the operator sets another lead.
 */
export const FORECAST_WINDOW_MS = 60 * 60_000;
export const FORECAST_MIN_SPAN_MS = 10 * 60_000;
export const FORECAST_FLAT_PCT_PER_HOUR = 0.5;
export const FORECAST_LEAD_HOURS = 2;

/**
 * The trend in words, as the account bar and card draw it (#33): "78 % and
 * climbing" is a different decision from "78 % and flat". Nothing for a window
 * whose burn is not measured yet — silence rather than a guess.
 * @param {{ trend?: string } | null | undefined} forecast
 * @returns {string}
 */
export function trendPhrase(forecast) {
  if (forecast?.trend === 'climbing') return 'and climbing';
  if (forecast?.trend === 'flat') return 'and flat';
  return '';
}

/**
 * A measured burn in words — `+4 %/h`, one decimal under ten — or nothing when
 * the window is not burning or its burn is not measured.
 * @param {number | null | undefined} pctPerHour
 * @returns {string}
 */
export function burnPhrase(pctPerHour) {
  if (typeof pctPerHour !== 'number' || !(pctPerHour > 0)) return '';
  const shown = pctPerHour >= 10 ? Math.round(pctPerHour) : Math.round(pctPerHour * 10) / 10;
  return `+${Number.isInteger(shown) ? shown : shown.toFixed(1)} %/h`;
}

/**
 * Whether an account can currently start a session. `unknown` is honest — a
 * profile the console has not probed — and must never paint as `ok`.
 * `unusable` is the breaker's word (zero-touch-console phase 8): a credential
 * the API REFUSED on a ground no re-login mends — an organisation policy, a
 * billing hold, a revoked key — retired until a person clears it. It is not a
 * login state the CLI can report, which is why it sits beside `signed-out`
 * rather than replacing it: the login may be perfectly valid and still be
 * refused work. `refreshable` (control-tower phase 76, #111) is an idle login
 * whose ACCESS token lapsed while its blob still holds what renews it: the CLI
 * renews it at the next session, so it stays a candidate and is still polled —
 * `expired` is the endpoint refusing a live token, never a clock running out.
 * @typedef {'ok'|'expiring'|'refreshable'|'expired'|'signed-out'|'unknown'|'unusable'} AuthState
 * @type {readonly AuthState[]}
 */
export const AUTH_STATES = Object.freeze(
  /** @type {const} */ (['ok', 'expiring', 'refreshable', 'expired', 'signed-out', 'unknown', 'unusable']),
);

/**
 * What an account's METER can say, whatever its buckets (control-tower phase
 * 13, #33) — so every registered account gets a bar, and a broken login is
 * drawn as broken rather than absent. The bar drew only accounts with buckets,
 * so a signed-out profile, an expired login and a token the endpoint does not
 * serve all vanished from the chrome whose job is to warn.
 *
 *   ok           live buckets on a login that works;
 *   broken       the login is expired, signed out or unusable, or a read
 *                failed with nothing to show;
 *   unsupported  the usage endpoint does not serve this kind of credential;
 *   none         never read yet.
 * @typedef {'ok'|'broken'|'unsupported'|'none'} MeterState
 * @type {readonly MeterState[]}
 */
export const METER_STATES = Object.freeze(/** @type {const} */ (['ok', 'broken', 'unsupported', 'none']));

/**
 * The word a machine-login sign-in carries to go ahead while a live run pays
 * as the machine login (control-tower phase 13, the fifth amendment's #131
 * hazard): a re-login that changes the machine login's identity ends the
 * sessions on it, so the door warns, names the runs, and waits for this.
 */
export const RELOGIN_CONFIRM = /** @type {const} */ ('ends-live-sessions');

/**
 * Where a credential stands with the organisation that pays for it — the
 * breaker, learned machine-wide and keyed by `orgId` as well as by account
 * (zero-touch-console phase 8, SES-2/ACT-8). Five states, one machine:
 *
 *   unknown  → entitled | retired
 *   entitled → cooling  | retired
 *   cooling  → entitled | retired
 *   suspect  → entitled | retired | unknown
 *   retired  → unknown  | suspect  (a person clears it, the orgId changes, or evidence contradicts it)
 *
 * `unknown` is a credential nobody has proved can pay; `entitled` is one that
 * has — a successful meter read, or a session that spent under it; `cooling`
 * is one a usage wall left, excluded for the wall's own reset or, when none
 * parsed, `ACCOUNT_COOLDOWN_MS`; `retired` is the credential-class refusal
 * (org policy · auth · billing), which excludes EVERY account sharing the
 * orgId until a person clears it. `suspect` (control-tower phase 54, #57) is a
 * retirement the CLASSIFIER wrote that a later green read or check
 * contradicts: still out of the rotation, and cleared by a check the API
 * takes, a spend, or the contradiction standing (`SUSPECT_CLEAR_MS`). `unknown`
 * ranks below `entitled`.
 * @typedef {'unknown'|'entitled'|'cooling'|'suspect'|'retired'} EntitlementState
 * @type {readonly EntitlementState[]}
 */
export const ENTITLEMENT_STATES = Object.freeze(
  /** @type {const} */ (['unknown', 'entitled', 'cooling', 'suspect', 'retired']),
);

/**
 * The transitions the breaker accepts, `from → to[]`. A write outside this
 * table is refused and logged rather than applied — a `retired` credential
 * does not become `entitled` because a poll happened to succeed; a person's
 * clearance (or a new orgId) opens it to `unknown`, and a green read or check
 * later than a classifier's retirement moves it to `suspect` — never further in
 * one step.
 * @type {Readonly<Record<EntitlementState, readonly EntitlementState[]>>}
 */
export const ENTITLEMENT_TRANSITIONS = Object.freeze({
  unknown: Object.freeze(/** @type {const} */ (['entitled', 'retired'])),
  entitled: Object.freeze(/** @type {const} */ (['cooling', 'retired'])),
  cooling: Object.freeze(/** @type {const} */ (['entitled', 'retired'])),
  suspect: Object.freeze(/** @type {const} */ (['entitled', 'retired', 'unknown'])),
  retired: Object.freeze(/** @type {const} */ (['unknown', 'suspect'])),
});

/**
 * Where a credential verdict came from (control-tower phase 54, #57): `api`, a
 * kind the API returned as data (an `api_retry` category, an API-error
 * message's `error`); `text`, a sentence matched on one of the CLI's API-error
 * channels. Carried on a retirement's evidence, so a person can tell the two.
 * @typedef {'api'|'text'} CredentialEvidenceSource
 * @type {readonly CredentialEvidenceSource[]}
 */
export const CREDENTIAL_EVIDENCE_SOURCES = Object.freeze(/** @type {const} */ (['api', 'text']));

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
 * The credential-class refusals the classifier can name. Spelled once here;
 * `runner/errors.ts` reads them off the CLI's own `api_retry` categories and
 * the API's sentences. `certificate` joined in zero-touch-console phase 9: two
 * of the audit's zero-cost sessions died to a TLS interception between this
 * machine and the API, which no re-board and no other phase can get past, and
 * which the patterns did not know (RCV-2).
 *
 * Every class used to retire the account's whole organisation. That is now
 * `ORG_SCOPED_CLASSES` below, and it is a different and much smaller question.
 * @typedef {'org-policy'|'auth'|'billing'|'certificate'} CredentialClass
 * @type {readonly CredentialClass[]}
 */
export const CREDENTIAL_CLASSES = Object.freeze(
  /** @type {const} */ (['org-policy', 'auth', 'billing', 'certificate']),
);

/**
 * The credential classes whose refusal is a statement about the ORGANISATION
 * rather than about one login — the only ones that may ever write the learned
 * store's `orgs` row, and then only when the API returned the verdict as
 * structured data (`LeaveReason.structured`).
 *
 * Both halves were learned the same day. A half-hour of no network retired 7
 * accounts across 2 organisations and both consoles, because one session's
 * transient stop wrote the org row and the org's word outranks every
 * credential's own — so multi-account failover, the feature that exists for
 * exactly "this credential cannot spend", was removed by the event it should
 * have absorbed. A certificate is a property of the network PATH and an
 * expired login is a property of ONE login; neither says anything about the
 * organisation, so neither is here.
 *
 * And membership alone is not enough. `org-policy` and `billing` are both
 * reachable from a prose match, so a phase whose output merely quotes one of
 * those sentences would still retire the organisation — the shape that made
 * writing up an outage undo the repair for that outage. The structured
 * verdict is the second half of the gate, in `leaveAccount`.
 * @type {readonly CredentialClass[]}
 */
export const ORG_SCOPED_CLASSES = Object.freeze(/** @type {const} */ (['org-policy', 'billing']));

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
 * work unattended; `crash-loop` — this console has ended hard three times in ten
 * minutes, and a supervisor's ten-second restart is about to do it again. While
 * any of them holds, nothing is re-adopted, nothing converges and no run is
 * re-parked as orphaned on the read path; an operator's release (Settings, or
 * `phase-console start` for the marker) lifts it.
 * @typedef {(typeof BOOT_HOLD_KINDS)[number]} BootHoldKind
 */
export const BOOT_HOLD_KINDS = Object.freeze(
  /** @type {const} */ (['stopped', 'autostart-off', 'crash-loop']),
);

/**
 * Where a restart's update stands (2026-09-18) — a restart brings the console
 * back on the latest version, so it runs `deploy/self-update.sh` first:
 * `waiting` — pressed mid-run, it waits for the live sessions to finish while
 * no new phase boards; `running` — the updater is working and every automatic
 * start waits; `restarting` — it answered with a copy that is safe to run, and
 * the process is on its way out; `stopped` — it answered, and the restart did
 * NOT follow (the copy could not be vouched for, another update held it, a run
 * started meanwhile, or somebody cancelled the wait). The sentence saying
 * which rides beside the word.
 * @typedef {(typeof RESTART_UPDATE_STATES)[number]} RestartUpdateState
 */
export const RESTART_UPDATE_STATES = Object.freeze(
  /** @type {const} */ (['waiting', 'running', 'restarting', 'stopped']),
);

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
 * What a terminal THIS console owns (a pty on the sessions page) is doing —
 * the word its row and its inspector paint (control-tower phase 24). A pty is
 * not a lane and not a registry session, so neither the phase words nor the
 * presence words say it: `exited` is a clean end, `failed` an exit with a
 * non-zero code — the one difference the old dot drew in red.
 * @typedef {'running'|'frozen'|'stopping'|'exited'|'failed'} TerminalState
 * @type {readonly TerminalState[]}
 */
export const TERMINAL_STATES = Object.freeze(
  /** @type {const} */ (['running', 'frozen', 'stopping', 'exited', 'failed']),
);

/**
 * What an ETA was computed FROM, weakest evidence last — so the console can
 * say how much to trust the number instead of presenting all three alike.
 * @typedef {'plan'|'portfolio'|'heuristic'} EtaBasis
 * @type {readonly EtaBasis[]}
 */
export const ETA_BASES = Object.freeze(/** @type {const} */ (['plan', 'portfolio', 'heuristic']));

/**
 * How far a LIVE phase's own-rate ETA can be trusted (control-tower phase 95,
 * #163) — its finished tasks and its measured operation, never the plan's
 * weights. `none` is an answer too: nothing has finished and nothing reports
 * progress, so the report gives no minutes rather than a guess.
 * @typedef {'high'|'medium'|'low'|'none'} PhaseEtaConfidence
 * @type {readonly PhaseEtaConfidence[]}
 */
export const PHASE_ETA_CONFIDENCES = Object.freeze(/** @type {const} */ (['high', 'medium', 'low', 'none']));

/**
 * Why a live phase is slow — each a RULE over one fact the console holds
 * (control-tower phase 95, #163): a verification the run already ran, the
 * machine's load above its guard, context past the wrap-up line, an in-turn
 * wait nearing the local-job guard, a queue hold behind a named holder.
 * @typedef {'repeat-verification'|'machine-load'|'context-wrap-up'|'in-turn-wait'|'queue-hold'} SlowRule
 * @type {readonly SlowRule[]}
 */
export const SLOW_RULES = Object.freeze(
  /** @type {const} */ ([
    'repeat-verification',
    'machine-load',
    'context-wrap-up',
    'in-turn-wait',
    'queue-hold',
  ]),
);

/**
 * Which clock a remaining-time figure is on (control-tower phase 58, #66).
 * `working` is session time — the phases run back to back, nothing parked,
 * queued or overnight; `calendar` is a date, stretched by the plan's recent
 * duty cycle. Every figure names its clock, because the two differ by 0.15–2.9×
 * in both directions and an unlabelled one is read as whichever the reader
 * assumed.
 * @typedef {'working'|'calendar'} EtaClock
 * @type {readonly EtaClock[]}
 */
export const ETA_CLOCKS = Object.freeze(/** @type {const} */ (['working', 'calendar']));

/**
 * Why a finished phase is NOT evidence for the rate (EE-1..3). Reported, never
 * silently dropped: `no-duration` — no session time recorded at all (closed
 * outside the run, or by hand); `near-zero` — under `ETA_MIN_EVIDENCE_MS`, which
 * no session boots and works a phase in; `closeout-only` — its only real time is
 * a closeout's paperwork, the work was done somewhere nothing measured.
 * @typedef {'no-duration'|'near-zero'|'closeout-only'} EtaMissingReason
 * @type {readonly EtaMissingReason[]}
 */
export const ETA_MISSING_REASONS = Object.freeze(
  /** @type {const} */ (['no-duration', 'near-zero', 'closeout-only']),
);

/**
 * Why a calendar forecast reads unknown instead of a date (EE-4..5):
 * `too-few` — fewer than three dated completions in the recent window;
 * `idle-history` — the window's duty cycle is under the floor, a plan that
 * mostly sat rather than a pace to project; `stale` — the newest completion is
 * older than the window, so no recent pace exists.
 * @typedef {'too-few'|'idle-history'|'stale'} DutyUnknownReason
 * @type {readonly DutyUnknownReason[]}
 */
export const DUTY_UNKNOWN_REASONS = Object.freeze(
  /** @type {const} */ (['too-few', 'idle-history', 'stale']),
);

/** @param {unknown} v @returns {v is DeliveryOutcome} */
export function isDeliveryOutcome(v) {
  return typeof v === 'string' && DELIVERY_OUTCOMES.includes(/** @type {DeliveryOutcome} */ (v));
}

/** @param {unknown} v @returns {v is EtaBasis} */
export function isEtaBasis(v) {
  return typeof v === 'string' && ETA_BASES.includes(/** @type {EtaBasis} */ (v));
}
