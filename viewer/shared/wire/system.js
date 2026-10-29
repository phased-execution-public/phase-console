/**
 * The wire of the console itself — the tailnet, the portfolio, search, skills, the directory
 * picker, the desktop launcher, sign-in, restart and shutdown, the owner key, the presence hook's
 * installer, the machine's thin reads, and (Pro) the license and the plugins (measured-console
 * phase 32).
 */

/**
 * How one strength of Shut down is carried out, and what it achieves (SHD-2, SHD-5).
 * @typedef {object} StopPlanView
 * @property {'launchctl' | 'systemctl' | 'exit'} via - `exit` ends the process; `launchctl`/`systemctl` unload AND disable the unit.
 * @property {import('../ops-vocab.js').ShutdownMode} mode
 * @property {import('../ops-vocab.js').ShutdownDurability} durability
 * @property {string} [label]
 * @property {string} [resurrect] - The command that undoes a "stay off".
 * @property {string} detail
 */
/**
 * One in-process clock the exit discards (SHD-1).
 * @typedef {object} InventoryClock
 * @property {string} at
 * @property {import('../ops-vocab.js').ShutdownClockSource} source
 * @property {string} [slug]
 * @property {string} [runId]
 * @property {number} [phase]
 */
/**
 * What Shut down would stop, computed from work rather than guessed (SHD-1).
 * @typedef {object} ShutdownInventory
 * @property {{ slug: string; runId: string; phase: number; pid: number | null; sessionId: string | null }[]} lanes
 * @property {InventoryClock[]} clocks
 * @property {{ slug: string; id: string; status: string; waitUntil: string | null; live: boolean; clock: InventoryClock | null }[]} runs
 * @property {{ sessionId: string; kind: string; pid: number | null; cwd: string; plan: { slug: string; phase: number } | null }[]} liveSessions
 * @property {{ id: string; slug: string; phase: number | null; kind: string; expiresAt: string }[]} pendingApprovals
 * @property {{ sessions: number; outcomes: number }} inboxDepth
 */
/**
 * @typedef {object} ShutdownReadiness
 * @property {import('./state.js').SupervisorInfo} supervisor
 * @property {import('../ops-vocab.js').ShutdownMode} [mode] - The strength a plain press uses.
 * @property {StopPlanView} stop - How that strength stops it.
 * @property {{ exit: StopPlanView; unload: StopPlanView | null }} [modes] - Both strengths — `unload` is null where there is no unit to unload. Absent from a server before 5.0.0.
 * @property {ShutdownInventory} [inventory]
 * @property {boolean} [empty] - Nothing in flight, armed, owed, live, pending or unread.
 * @property {InventoryClock | null} [soonestClock]
 * @property {boolean} busy
 * @property {{ slug: string; status: string } | null} run
 * @property {import('./sessions.js').SessionInventory} sessions
 * @property {string} restartHint - How to get it back after `exit` — the last thing this console will tell you.
 * @property {string | null} [unloadHint] - How to undo a "stay off".
 * @property {import('./state.js').BootHold | null} [bootHold]
 */
/**
 * A refused press answers with what it was about.
 * @typedef {object} ShutdownOutcome
 * @property {boolean} ok
 * @property {string} [reason]
 * @property {'mode' | 'unload' | 'acknowledge'} [needs]
 * @property {import('../ops-vocab.js').ShutdownMode} [mode]
 * @property {StopPlanView} [stop]
 * @property {ShutdownInventory} [inventory]
 */
/**
 * One machine on the tailnet, reduced to what the Settings card renders.
 * @typedef {object} TailscaleDevice
 * @property {string} hostName
 * @property {string} dnsName
 * @property {string[]} ips
 * @property {string} [os]
 * @property {boolean} online
 * @property {string} [lastSeen] - Only present, and only useful, for a device that is offline now.
 */
/**
 * The console a Serve handler forwards to, as this machine's registry names it
 * (`server/tailscale.ts`). `id`, `name` and `liveness` are absent when no
 * registered console claims the port.
 * @typedef {object} ServeOccupant
 * @property {number} port
 * @property {string} [id]
 * @property {string} [name]
 * @property {import('../fleet-model.js').Liveness} [liveness]
 */
/**
 * One handler of the machine's one Serve table; `targetPort` is null for anything not on loopback.
 * @typedef {object} ServeHandler
 * @property {string} host
 * @property {number} httpsPort
 * @property {string} path
 * @property {number | null} targetPort
 * @property {boolean} ours
 * @property {ServeOccupant} [occupant]
 */
/**
 * The serve command decided against the whole table. `displaces` names the
 * live console that holds the natural https port — the reason `httpsPort` is
 * another one.
 * @typedef {object} ServeCommand
 * @property {number} httpsPort
 * @property {string} text
 * @property {{ httpsPort: number; occupant: ServeOccupant } | null} displaces
 */
/**
 * `active` and `forOurPort` stay separate on the wire because they have
 * different fixes: nothing is served, versus something else is — and
 * `targetPort`/`occupant` say which something. Everything past `url` is absent
 * from a server before 5.0.0, which is why it is optional here.
 * @typedef {object} TailscaleServe
 * @property {boolean} active
 * @property {boolean} forOurPort
 * @property {string} [url]
 * @property {number} [targetPort]
 * @property {ServeOccupant} [occupant]
 * @property {ServeHandler[]} [handlers]
 * @property {ServeCommand | null} [command] - `null` once a handler serves this console.
 */
/**
 * The tailnet as this machine sees it.
 * @typedef {{ state: 'not-installed' } | { state: 'installed-not-running'; detail?: string } | { state: 'running'; tailnet?: string; magicDns: boolean; magicDnsSuffix?: string; self: TailscaleDevice; peers: TailscaleDevice[]; serve: TailscaleServe }} TailscaleStatus
 */
/**
 * Where a one-click desktop launcher would land, and whether this platform can.
 * @typedef {object} LauncherPlanView
 * @property {string} platform
 * @property {boolean} supported
 * @property {string} [path]
 * @property {'command' | 'desktop-entry'} [kind]
 * @property {string} note
 * @property {boolean} rootOpen
 * @property {readonly string[]} fullFlags
 */
/**
 * @typedef {object} AuthStatus
 * @property {boolean} loggedIn
 * @property {string} [email]
 * @property {string} [method]
 * @property {string} [organisation]
 * @property {string} [subscription]
 * @property {string} checkedAt
 * @property {string} [detail] - Present when the probe could not answer — different from answering "no".
 */
/**
 * @typedef {object} SkillInfo
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {'personal' | 'project' | 'plugin'} source
 * @property {string} [plugin]
 * @property {string} path
 */
/**
 * @typedef {object} SearchHit
 * @property {string} slug
 * @property {string} kind
 * @property {string} section
 * @property {number} [phase]
 * @property {string} title
 * @property {number} score
 * @property {string} snippet
 */
/**
 * @typedef {object} SearchResult
 * @property {string} query
 * @property {number} total
 * @property {{ slug: string; title: string; hits: SearchHit[] }[]} groups
 */
/**
 * @typedef {object} PortfolioTotals
 * @property {number} plans
 * @property {number} documents
 * @property {number} orphans
 * @property {number} closed - Plans an operator has closed. ⚠️ The census fields (`phases`, `done`, `percent`, `waiting`, `inProgress`, `stuck`) still count them; the forward-looking ones (`ready`, `remainingWeight`, `remainingSessions`) do not. Closing a plan quiets it — it never deletes its history.
 * @property {number} [open] - The plans still open, said by the server so no page subtracts. Absent from a server older than 7.0.
 * @property {number} phases
 * @property {number} done
 * @property {number} ready
 * @property {number} waiting
 * @property {number} inProgress
 * @property {number} stuck
 * @property {number} percent
 * @property {number} remainingWeight
 * @property {number} remainingSessions
 */
/**
 * @typedef {object} Portfolio
 * @property {number} generatedAt
 * @property {PortfolioTotals} totals
 * @property {{ status: string; count: number; closed?: boolean }[]} byStatus - `closed`: this status word is terminal. Carried by the server so a consumer groups the terminal statuses without re-deriving the predicate.
 * @property {{ slug: string; phase: number; owner: string; expired: boolean; leaseUntil?: number; closed?: boolean; session?: string }[]} activeLocks - `closed`: the lock's plan is terminal, so the lock is debris — `phase-lock.sh conflicts` skips it and it blocks nobody. Optional for an older server.
 * @property {import('./plans.js').HealthIssue[]} issues
 * @property {{ week: string; count: number }[]} velocity
 * @property {{ date: string; count: number }[]} calendar
 * @property {number} [medianCycleDays]
 * @property {{ size: string; count: number }[]} sizeMix
 * @property {{ repo: string; count: number }[]} repos
 * @property {{ skill: string; count: number }[]} skills
 * @property {{ model: string; count: number }[]} models
 * @property {{ slug: string; days: number; ready: number[] }[]} stalled
 * @property {{ slug: string; completions: number }[]} busiest
 * @property {{ ratePerWeight: number; floorMs: number; slopeMsPerWeight: number; basis: import('./runs.js').EtaBasis; samples: number; spread: number; missing: number; clock: 'working'; mediumMs?: number }} [rate] - How fast a phase has actually been going lately, pooled across every plan.
 */
/**
 * @typedef {object} DirListing
 * @property {string} path
 * @property {string} [parent]
 * @property {{ name: string; path: string; hasDocs: boolean }[]} entries
 */
/**
 * `server/config.ts` `RootCheck` — `ok` is the only field always meaningful.
 * @typedef {object} RootCheck
 * @property {string} path
 * @property {boolean} ok
 * @property {string} label
 * @property {number} planCount
 * @property {number} handoffCount
 * @property {string} [docsDir]
 * @property {string} [plansDir]
 * @property {string} [reason]
 */
/**
 * @typedef {object} OpenRootResult
 * @property {RootCheck} check
 * @property {import('./state.js').ConsoleState} state
 */
/**
 * @typedef {object} RestartReadiness
 * @property {boolean} ok
 * @property {string} [reason]
 * @property {boolean} [selfRestart] - Nothing supervises this console, so it restarts by re-executing itself with its own argv.
 * @property {import('./state.js').SupervisorInfo} supervisor
 * @property {boolean} busy
 * @property {{ slug: string; status: string; phase?: number } | null} run
 * @property {import('./sessions.js').SessionInventory} [sessions] - A restart has always killed every pty. Now it says so before it does.
 * @property {{ available: boolean; run: RestartUpdateView | null }} [update] - A restart updates the copy first (2026-09-18): whether this console can, and the update in hand — its progress while it runs, what it did after. Absent where the console cannot update itself.
 */
/**
 * What `deploy/self-update.sh` answered — the fields a person reads.
 * @typedef {object} SelfUpdateResultView
 * @property {string} result
 * @property {string} from
 * @property {string} to
 * @property {string} target
 * @property {string} upstream
 * @property {boolean} moved
 * @property {boolean} npmCi
 * @property {string[]} warnings
 * @property {string} reason
 */
/**
 * A restart's update: `running`, then `restarting` or `stopped`, with the sentence saying which.
 * @typedef {object} RestartUpdateView
 * @property {import('../ops-vocab.js').RestartUpdateState} state
 * @property {string} startedAt
 * @property {string} [finishedAt]
 * @property {string} by
 * @property {string} detail
 * @property {SelfUpdateResultView} [result]
 * @property {string} [expectedEnd] - A held restart's drain: when it expects the live lanes to end, and the cap it will not wait past.
 * @property {string} [capAt]
 * @property {number} [lanes] - How many live lanes the drain waits on, and whose plans they are.
 * @property {string[]} [plans]
 */
/**
 * What pressing Restart did. `updating`: the copy updates first, and the
 * process restarts after; `waiting`: pressed mid-run, it restarts once the
 * live sessions have finished.
 * @typedef {object} RestartOutcome
 * @property {boolean} ok
 * @property {string} [reason]
 * @property {boolean} [updating]
 * @property {boolean} [waiting]
 * @property {string} [command] - A refusal's one command — the launch unit's re-install when its node arguments drifted.
 */
/**
 * `GET /api/instances` — the machine's console registry as THIS console reads
 * it (`server/fleet.ts` `census`), and `GET /api/fleet/profile` — the machine
 * profile and what this console takes from it, each field's source named.
 * @typedef {{
 *   rows?: { id: string; name: string; port?: number; liveness?: string; provenance?: string }[];
 *   [key: string]: unknown;
 * }} InstancesView
 */
/**
 * @typedef {object} FleetProfileView
 * @property {Record<string, unknown>} profile - The machine profile, its `secret` fields withheld (#319): a webhook as origin + masked tail, the rest `[withheld]`.
 * @property {Record<string, { hasValue: boolean }>} [secrets] - Whether each withheld field is set.
 * @property {{ id: string; name: string; remoteHosts: string[]; remoteUsers: string[]; notifyCommand: boolean; maxSessions: number; machineMaxSessions: number | null; autostart: boolean | 'once'; sources?: Record<string, string>; overridden: string[] }} console
 */
/**
 * `GET /api/skills` — every skill a session here would see.
 * @typedef {SkillInfo[]} SkillInfoList
 */
/**
 * `POST /api/launcher` — the launcher written, where, and what to do with it.
 * @typedef {object} LauncherCreated
 * @property {true} ok
 * @property {string} path
 * @property {string} note
 */

/* ---------------- the owner key (control-tower phase 148) ---------------- */

/**
 * @typedef {(typeof import('../door-model.js').OWNER_DOOR_STATES)[number]} OwnerDoorState
 */
/**
 * @typedef {object} OwnerKey
 * @property {string} id
 * @property {'ES256' | 'EdDSA'} alg
 * @property {string} label
 * @property {string} origin
 * @property {string} rpId
 * @property {string} createdAt
 * @property {string | null} lastUsedAt
 * @property {number} counter
 * @property {boolean} backedUp
 */
/**
 * @typedef {object} OwnerSession
 * @property {string} id
 * @property {string} keyId
 * @property {string} label
 * @property {string} origin
 * @property {string} startedAt
 * @property {string} lastSeenAt
 * @property {string} assertedAt
 * @property {string} idleEndsAt
 * @property {string} freshUntil
 * @property {boolean} fresh
 */
/**
 * @typedef {object} AuthorityRequest
 * @property {string} id
 * @property {string} at
 * @property {'open' | 'confirmed' | 'refused' | 'failed'} state
 * @property {string} door
 * @property {string} label
 * @property {string} [claims] - What the asker calls itself (its body's `by`) — a claim the page quotes, never the label (#277).
 * @property {string} press
 * @property {string} authority
 * @property {string} risk
 * @property {string} method
 * @property {string} path
 * @property {Record<string, unknown>} body
 * @property {string} summary
 * @property {{ kind: string; id?: string; slug?: string; phase?: number } | null} item
 * @property {number} repeats
 * @property {string} ask - "asked by <label> through <door> — <what> — confirm?"
 * @property {string} [settledAt]
 * @property {string} [settledBy]
 * @property {{ status: number; error?: string }} [result]
 */
/**
 * @typedef {object} OwnerView
 * @property {OwnerDoorState} state
 * @property {(typeof import('../door-model.js').OWNER_DOOR_MODES)[number]} mode
 * @property {OwnerKey[]} keys
 * @property {OwnerSession | null} session
 * @property {AuthorityRequest[]} requests
 * @property {{ id: string; origin: string } | { refused: string }} relyingParty
 */
/**
 * @typedef {object} CreationOptionsJson
 * @property {string} ceremony
 * @property {{ challenge: string; rp: { id: string; name: string }; user: { id: string; name: string; displayName: string }; pubKeyCredParams: { type: 'public-key'; alg: number }[]; authenticatorSelection: AuthenticatorSelectionCriteria; attestation: AttestationConveyancePreference; timeout: number; excludeCredentials: { type: 'public-key'; id: string }[] }} publicKey
 */
/**
 * @typedef {object} RequestOptionsJson
 * @property {string} ceremony
 * @property {{ challenge: string; rpId: string; userVerification: UserVerificationRequirement; timeout: number; allowCredentials: { type: 'public-key'; id: string }[] }} publicKey
 */
/**
 * `POST /api/owner/enroll/link` — `phase-console owner enroll`'s link, or, inside an owner
 * session, one to enrol another browser.
 * @typedef {object} OwnerEnrolLink
 * @property {string} link
 * @property {string[]} [links] - The same link at each `--remote` host, once a key is enrolled.
 * @property {string} expiresAt
 * @property {boolean} first
 */
/**
 * `POST /api/owner/enroll/finish` — the key enrolled, and the owner session it started (null when
 * this browser already held one).
 * @typedef {object} OwnerEnrolFinish
 * @property {OwnerKey} key
 * @property {OwnerSession | null} session
 */
/**
 * `POST /api/owner/assert/finish` — the owner session the touch started or refreshed.
 * @typedef {object} OwnerAssertFinish
 * @property {OwnerSession} session
 * @property {boolean} fresh
 */
/**
 * `POST /api/owner/lock` — how many owner sessions ended, and the door's state after.
 * @typedef {object} OwnerLockAnswer
 * @property {number} ended
 * @property {string} state
 */
/**
 * `DELETE /api/owner/keys/:id` — the key removed, and the door's state after.
 * @typedef {object} OwnerKeyRemoved
 * @property {OwnerKey} removed
 * @property {string} state
 */
/**
 * `POST /api/owner/requests/:id/confirm` — the request as it settled, and the press's own answer.
 * @typedef {object} OwnerRequestConfirmed
 * @property {AuthorityRequest | null} request
 * @property {{ status: number; answer: unknown }} result
 */
/**
 * `POST /api/owner/requests/:id/refuse` — the request as it settled.
 * @typedef {object} OwnerRequestRefused
 * @property {AuthorityRequest | null} request
 */

/* ---------------- the machine's thin reads (quiet-console phase 25) ---------------- */

/**
 * One start ceiling's sliding hour: its counts, its limits (0 is none), and the limit the next automatic start would meet.
 * @typedef {object} CeilingWindow
 * @property {number} starts
 * @property {number} usd
 * @property {{ startsPerHour: number; usdPerHour: number }} limits
 * @property {number} windowMs
 * @property {Record<string, number>} doors
 * @property {'startsPerHour' | 'usdPerHour' | null} full
 * @property {string | null} until
 */
/**
 * The work ceiling every automatic start is counted against, and the MCP probe's own.
 * @typedef {object} StartCeilingCounters
 * @property {CeilingWindow} work
 * @property {CeilingWindow} probe
 */
/**
 * One credential id: held or not, why, whether the registry knows its kind, and the plans that name it — never a value.
 * @typedef {object} HeldCredential
 * @property {string} id
 * @property {import('../ops-vocab.js').ProbeStatus} status
 * @property {string} reason
 * @property {boolean} known
 * @property {{ slug: string; phase?: number }[]} named
 */
/**
 * @typedef {object} HeldCredentials
 * @property {string} at
 * @property {number} cacheMs
 * @property {HeldCredential[]} credentials
 */
/**
 * A console process on this machine whose code is gone.
 * @typedef {object} StrayConsole
 * @property {number} pid
 * @property {number} pgid
 * @property {string} command
 * @property {string} root
 */
/**
 * The strays, listed — `stop` is the command line that stops them; no page does.
 * @typedef {object} StrayConsoles
 * @property {string} at
 * @property {StrayConsole[]} strays
 * @property {string} stop
 */

/* ---------------- the license and the plugins (Pro) ---------------- */


/**
 * Every route this family owns → the typedef its response is (and, for a write, the one it takes).
 * @type {Readonly<Record<string, { response: string, body?: string }>>}
 */
export const WIRE_ROUTES = Object.freeze({
  'GET /api/owner': { response: 'OwnerView' },
  'POST /api/owner/enroll/link': { response: 'OwnerEnrolLink' },
  'POST /api/owner/enroll/begin': { response: 'CreationOptionsJson' },
  'POST /api/owner/enroll/finish': { response: 'OwnerEnrolFinish' },
  'POST /api/owner/assert/begin': { response: 'RequestOptionsJson' },
  'POST /api/owner/assert/finish': { response: 'OwnerAssertFinish' },
  'POST /api/owner/lock': { response: 'OwnerLockAnswer' },
  'DELETE /api/owner/keys/:id': { response: 'OwnerKeyRemoved' },
  'POST /api/owner/requests/:id/confirm': { response: 'OwnerRequestConfirmed' },
  'POST /api/owner/requests/:id/refuse': { response: 'OwnerRequestRefused' },
  'GET /api/hooks-install': { response: 'HooksStatusView' },
  'POST /api/hooks-install': { response: 'HooksWriteView' },
  'GET /api/tailscale': { response: 'TailscaleStatus' },
  'GET /api/launcher': { response: 'LauncherPlanView' },
  'POST /api/launcher': { response: 'LauncherCreated' },
  'GET /api/doctor/strays': { response: 'StrayConsoles' },
  'GET /api/doctor': { response: 'DoctorReport' },
  'GET /api/skills': { response: 'SkillInfoList' },
});
