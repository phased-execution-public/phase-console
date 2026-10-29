/**
 * The wire of accounts — the Claude accounts registry (always redacted), its
 * sign-in and repairs, the spend and ledger reads, the credentials and the CLI's
 * own login, and (Pro) the pool's API-key accounts, settings, catalog and usage
 * statistics (measured-console phase 32).
 */

/* ---------------- Claude accounts ---------------- */

/**
 * One usage window, as the meter reads it.
 * @typedef {object} UsageBucket
 * @property {number} utilization - percent, 0–100
 * @property {string} resetsAt - ISO 8601
 * @property {string} [polledAt] - ISO — when the read behind this bucket was made; the server's view sets it (#109)
 * @property {boolean} [stale] - older than twice the poll interval, past its own reset, or never read successfully (#109)
 */

/**
 * An account's meters.
 * @typedef {object} AccountUsage
 * @property {Record<string, UsageBucket>} buckets - keyed by the endpoint's own names — `five_hour`, `seven_day`, `seven_day_opus`, …
 * @property {string} [fetchedAt] - ISO — the last read that SUCCEEDED; absent when none ever has
 * @property {string} [lastErrorAt] - ISO — the last read that FAILED; advances on every failure
 * @property {boolean} [unsupported] - the endpoint will never serve this credential kind — "no usage data", not an error
 * @property {string} [error]
 */

/**
 * The breaker's word for a credential (or its organisation), effective now —
 * `unknown → entitled | retired`, `entitled → cooling | retired`,
 * `cooling → entitled | retired`, `retired → unknown` (a person clears it).
 * @typedef {object} EntitlementView
 * @property {(typeof import('../ops-vocab.js').ENTITLEMENT_STATES)[number]} state
 * @property {'credential' | 'org' | 'none'} via - which record answered: the credential's own row, its organisation's, or nothing learned yet
 * @property {string} [reason]
 * @property {string} [at]
 * @property {string} [detail]
 * @property {string} [until] - `cooling` only: ISO — when the account is a candidate again
 * @property {(typeof import('../ops-vocab.js').CREDENTIAL_CLASSES)[number]} [class] - `retired` and `suspect`: which credential class refused
 * @property {string} [by] - who wrote the word — `classifier`, `live-wall`, `preflight`, `operator`, `poller`, `probe`, …
 * @property {RetirementEvidence} [evidence] - `retired` and `suspect` (#57): what the verdict stood on — `api` or `text`, the words that matched, whose stop it was
 * @property {{ at?: string; by?: string; reason?: string }} [retired] - `suspect` only: the retirement it demoted
 * @property {{ at: string; by: string; reason: string }} [contradicted] - `suspect` only: the green read or check that contradicts the retirement
 */

/**
 * A retirement's evidence, as the breaker keeps it (#57).
 * @typedef {object} RetirementEvidence
 * @property {'api' | 'text'} source
 * @property {string} matched
 * @property {string} [session]
 * @property {number} [phase]
 * @property {string} [slug]
 * @property {string} [runId]
 */

/**
 * The newest one-turn check of whether a credential may run work (phase 15) —
 * `ok` the API took work under it, `fail` it refused the credential, `skip` it
 * could not be asked. Machine-wide, like the breaker it may have moved.
 * @typedef {object} AccountProbe
 * @property {string} at
 * @property {(typeof import('../ops-vocab.js').PROBE_STATUSES)[number]} status
 * @property {string} reason
 * @property {string} by - who pressed it — the request's derived actor
 * @property {(typeof import('../ops-vocab.js').CREDENTIAL_CLASSES)[number]} [class]
 * @property {number} [costUsd]
 * @property {number} [ms]
 * @property {string} [ending]
 * @property {string} [cliVersion]
 * @property {number} count - every check this credential has had, on any console
 */

/**
 * Would the rank pick this account now? `rank` is its place among the
 * candidates (1 first — the order an `auto` pick walks); `why` is the rank's
 * own reason when it is out, `until` when a clock ends it.
 * @typedef {{ candidate: true; rank?: number } | { candidate: false; why: string; until?: string }} AccountStanding
 */

/**
 * A registration this console removed, still answered from the learned store's tombstone.
 * @typedef {object} TombstoneView
 * @property {string} id
 * @property {string} name
 * @property {string} retiredAt
 * @property {string} credential
 * @property {string} [orgId] - hashed, like every orgId that leaves the server
 * @property {EntitlementView} entitlement
 */

/**
 * One window's forecast (control-tower phase 92, #141): the burn a line through
 * the last hour's readings measures, and when it walls the window — null when
 * it is flat, unmeasured, or resets first.
 * @typedef {object} BucketForecast
 * @property {number} pct
 * @property {number | null} burnPctPerHour
 * @property {'climbing' | 'flat' | 'unknown'} trend
 * @property {string | null} wallsAt
 * @property {string} resetsAt
 * @property {number} samples
 * @property {number} spanMs
 */

/**
 * An account's forecast: every live window, the soonest projected wall, and the runs burning it.
 * @typedef {object} AccountForecast
 * @property {Record<string, BucketForecast>} buckets
 * @property {string | null} wallsAt
 * @property {string | null} bucket
 * @property {{ slug: string; runId: string; lanes: number[] }[]} burning
 */

/**
 * An account's credits as the console acts on them (control-tower phase 93,
 * #146) — the server's `CreditView`: the operator's "use credits past plan
 * limits" (`allowed`, off by default), the account's own credit state
 * (`available`, null when unknown), and `carrying`, both at once.
 * @typedef {object} CreditView
 * @property {boolean} allowed
 * @property {boolean | null} available
 * @property {boolean} carrying
 * @property {string} reason
 * @property {number | null} used
 * @property {number | null} limit
 * @property {number | null} cap
 * @property {number | null} remaining
 * @property {string | null} currency
 * @property {number} [capUsd]
 * @property {boolean} onCredit
 * @property {string} [readAt]
 */

/**
 * One registered Claude identity, redacted: never a token, never a path, never a raw orgId.
 * @typedef {object} AccountView
 * @property {string} id
 * @property {(typeof import('../ops-vocab.js').ACCOUNT_KINDS)[number]} kind
 * @property {boolean} builtIn - the machine's own login — always present, never removable
 * @property {string} [name]
 * @property {string} [email]
 * @property {string} [org]
 * @property {string} [orgId] - the organisation's id, HASHED (eight hex) — two accounts showing one share an organisation
 * @property {string} [credential] - the credential's fingerprint — two ids showing one are one login; the server always sends it, optional so an older server still renders
 * @property {string} [plan]
 * @property {boolean} [signedIn] - profiles only: whether `claude auth login` has completed in it
 * @property {(typeof import('../ops-vocab.js').AUTH_STATES)[number]} [authState] - where the login stands — a setup-token's is read from its age since phase 91; `unusable` is a retired credential
 * @property {EntitlementView} [entitlement] - the breaker's word; the server always sends it, optional so an older server's list still renders
 * @property {AccountUsage} [usage]
 * @property {AccountForecast} [forecast] - each window's forecast and who is burning the account (control-tower phase 92); absent from an older server
 * @property {CreditView} [credits] - its credits and whether they carry its runs past its plan windows (control-tower phase 93); absent from an older server
 * @property {string} [lastErrorAt] - ISO — the last meter read that failed, from the machine-wide learned store
 * @property {string} [lastSuccessAt] - ISO — the last meter read that SUCCEEDED on any console on this machine
 * @property {Record<string, string>} [limitedUntil] - windows learned exhausted the hard way — bucket → ISO reset time; machine-wide since 5.0.0
 * @property {{ name: string; retiredAt: string }} [tombstone] - the name a REMOVED registration was known by, when this id is answered from a tombstone
 * @property {{ at: string; by: string; kind: (typeof import('../ops-vocab.js').LEAVE_KINDS)[number]; reason: string }} [lastLeftAt] - the last time a run moved OFF this account, who moved it and why
 * @property {AccountProbe} [probe] - the newest one-turn check of this credential (phase 15)
 * @property {number} [pollEveryMs] - how often this console reads the meters for this account now, in ms
 * @property {AccountStanding} [breaker] - the rank's verdict on this account right now
 * @property {string} [tokenExpiresAt] - token accounts: when the setup-token stops working — a year after it was added (control-tower phase 91)
 * @property {string} [unattended] - login-backed accounts: the unattended path, offered — a long-lived token does not lapse between sessions (#147)
 * @property {(typeof import('../ops-vocab.js').METER_STATES)[number]} [meter] - what its meter can say whatever its buckets (control-tower phase 13, #33); the server always sends it, absent from an older server
 * @property {{ slug: string; runId: string }[]} [paying] - the live runs set to pay as this account (phase 13); the server always sends it, absent from an older server
 */

/**
 * `GET /api/accounts`: every account, the flag, and the tombstones.
 * @typedef {object} AccountsState
 * @property {AccountView[]} accounts
 * @property {boolean} allowAccounts
 * @property {TombstoneView[]} [tombstones] - the registrations this console removed that the learned store still remembers; absent on an older server
 */

/**
 * What a one-turn check found and did.
 * @typedef {object} AccountProbeResult
 * @property {AccountView} account
 * @property {AccountProbe} probe
 * @property {boolean} spent - did a session actually start? A signed-out login or a missing token is refused before any spend
 * @property {{ from: EntitlementView['state']; to: EntitlementView['state'] }} [moved]
 */

/**
 * `POST /api/accounts/login`: how the sign-in was put in front of the operator.
 * @typedef {object} AccountLoginStart
 * @property {string} accountId
 * @property {string} command - the exact command, for the operator to run themselves when nothing opened
 * @property {'embedded' | 'external' | 'command' | 'replace-token' | 'warn'} mode - `embedded` a pty on the Agent page; `external` Terminal.app opened; `command` copy-paste; `replace-token` a token account, whose credential is replaced (phase 13); `warn` the machine login while a live run pays as it — nothing ran, `warning` says why (#131)
 * @property {{ sessionId: string; token: string; expiresAt: number }} [terminal]
 * @property {string} [detail]
 * @property {string} [warning]
 * @property {string[]} [runs]
 */

/**
 * A write on one account, answered with the account as it now is.
 * @typedef {{ account: AccountView }} AccountAnswer
 */

/**
 * `DELETE /api/accounts/:id`: removed (a missing one is a 404 `WireError`).
 * @typedef {{ removed: true }} AccountRemoved
 */

/**
 * `POST /api/accounts/refresh`: one account re-read, or — with no id — every one.
 * @typedef {object} AccountRefreshAnswer
 * @property {AccountView} [account]
 * @property {AccountView[]} [accounts]
 */

/* ---------------- spend, the ledger, credentials, the CLI's login ---------------- */

/**
 * `GET /api/spend` — `today` is the day cap's view (settled runs plus what the
 * ladder spent, against `ladderPerDayUsd` — `null` when no cap is set); `runs`
 * is each run against its own budget; `series` is the per-day history a chart
 * draws. The server's `server/analysis/spend.ts` `SpendView`.
 * @typedef {object} SpendView
 * @property {{ settledUsd: number; ladderUsd: number; capUsd: number | null; ladderLeftUsd?: number | null }} today - `ladderLeftUsd`: the cap less today's ladder spend, never below zero; null with no cap
 * @property {{ runId: string; slug: string; spentUsd: number; budgetUsd: number | null }[]} runs
 * @property {{ day: string; settledUsd: number; ladderUsd: number; usd?: number }[]} series - `usd`: the day's settled and ladder spend together, summed by the server
 * @property {{ settledUsd: number; ladderUsd: number; usd: number }} [total] - the series summed by the server (quiet-console phase 19); absent from a server older than 7.0
 */

/**
 * `GET /api/ledger`: every open plan's ledgers per plan and per account — the runs family's shape.
 * @typedef {import('./runs.js').LedgerSummary} LedgerAnswer
 */

/**
 * `GET /api/credentials` and `POST /api/credentials/probe`: each credential id's verdict — the system family's shape.
 * @typedef {import('./system.js').HeldCredentials} CredentialsAnswer
 */

/**
 * `GET /api/auth`: `claude auth status`, memoised — the system family's shape.
 * @typedef {import('./system.js').AuthStatus} AuthAnswer
 */

/**
 * `POST /api/auth/login`: a real terminal opened on `claude auth login`, or the command to paste.
 * @typedef {object} AuthLoginStart
 * @property {boolean} opened
 * @property {string} command
 * @property {string} [detail]
 */


/**
 * Every route this family owns → the typedef its response is (and, for a write, the one it takes).
 * @type {Readonly<Record<string, { response: string, body?: string }>>}
 */
export const WIRE_ROUTES = Object.freeze({
  'GET /api/accounts': { response: 'AccountsState' },
  'POST /api/accounts/login': { response: 'AccountLoginStart' },
  'PUT /api/accounts/:id/credential': { response: 'AccountAnswer' },
  'POST /api/accounts/refresh': { response: 'AccountRefreshAnswer' },
  'POST /api/accounts/:id/clear-retired': { response: 'AccountAnswer' },
  'POST /api/accounts/:id/probe-entitlement': { response: 'AccountProbeResult' },
  'POST /api/accounts': { response: 'AccountAnswer' },
  'DELETE /api/accounts/:id': { response: 'AccountRemoved' },
  'DELETE /api/accounts': { response: 'AccountRemoved' },
  'POST /api/accounts/:id/overage': { response: 'AccountAnswer' },
  'PATCH /api/accounts/:id': { response: 'AccountAnswer' },
  'GET /api/spend': { response: 'SpendView' },
  'GET /api/ledger': { response: 'LedgerAnswer' },
  'GET /api/credentials': { response: 'CredentialsAnswer' },
  'POST /api/credentials/probe': { response: 'CredentialsAnswer' },
  'GET /api/auth': { response: 'AuthAnswer' },
  'POST /api/auth/login': { response: 'AuthLoginStart' },
});
