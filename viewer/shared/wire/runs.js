/**
 * The wire of runs — the autopilot's routes: `/api/runs`, `/api/run/:slug/…`
 * (the run, its phases' records, journal, ledger, timeline and every press),
 * `/api/lane/…`, `/api/locks…` and `/api/automation/hold…`
 * (measured-console phase 32).
 *
 * Also the home of the shapes other families' routes answer with, because the
 * run surface's client files declared them first: `Approval`, `DecideResult`
 * (`/api/approvals…`), `LedgerSummary` (`GET /api/ledger`),
 * `ConvergeStatusView` (`GET /api/converge`), `SessionSizing`
 * (`GET /api/sizing`) and `WeekReportAnswer` (`GET /api/report`).
 */

/* ---------------- the autopilot ----------------
 * Mirrors `server/runner/state.ts` (`RunState`, `PhaseRecord`, `VerifySummary`),
 * `server/runner/approvals.ts` (`Approval`), `server/service.ts`
 * (`PhaseDiagnosis`, `RecoveryAction`) and `server/analysis/stats.ts`
 * (`EtaEstimate`). Hand-written for the same reason the plan shapes are: the
 * server is frozen, so a shape that drifts is a decision rather than an accident.
 *
 * `status` unions ARE narrowed here, unlike the plan surface's phase `state`.
 * They are the runner's own closed vocabulary rather than the engine's open one,
 * and every tone table below is keyed by them — an unknown status should be a
 * type error at the table, not a chip that silently paints grey. */

/**
 * The runner's own closed vocabularies, taken from `shared/run-lifecycle.js`
 * where their members are written down once. The per-word notes that used to
 * live here live there — including why `queued` is live to this file and not to
 * the server's `IN_FLIGHT`, and why `parked` was missing from this union for as
 * long as it was while the server emitted it.
 * @typedef {import('../run-lifecycle.js').RunStatus} RunStatus
 */

/**
 * @typedef {import('../run-lifecycle.js').PhaseStatus} PhaseStatus
 */

/**
 * @typedef {import('../run-lifecycle.js').AutonomyMode} Autonomy
 */

/**
 * @typedef {(typeof import('../run-settings.js').PERMISSION_PROFILES)[number]} PermissionProfile
 */

/**
 * The relay's two modes and the probe verdict words — the shared owners' members, by type.
 * @typedef {(typeof import('../run-settings.js').RELAY_MODES)[number]} RelayMode
 */

/**
 * @typedef {(typeof import('../ops-vocab.js').PROBE_STATUSES)[number]} ProbeStatus
 */

/**
 * How a QA recovery boards its fix session — the shared vocabulary's two words.
 * @typedef {(typeof import('../run-settings.js').QA_FIX_STRATEGIES)[number]} QaFixStrategy
 */

/**
 * @typedef {object} VerifyRun
 * @property {string} command
 * @property {boolean} ok
 * @property {number} code
 * @property {{ repo: string; branch: string | null; head: string | null }} [tree] - What it ran AGAINST — the repository, branch and head (control-tower phase 40, #41).
 * @property {boolean} [retry] - The console's own second run of a red command — a rescue when it went green (#45).
 * @property {number} ms
 * @property {string} output
 * @property {'terminal'} [via] - `terminal` when a person re-ran it in the integrated terminal.
 */

/**
 * @typedef {object} VerifySummary
 * @property {boolean} ok
 * @property {string} reason
 * @property {VerifyRun[]} ran
 * @property {{ text: string; reason: string }[]} notRun
 * @property {{ command: string; lead: string; reason: string }[]} [skipped] -  Commands skipped because their lead binary does not exist here —
 *   neither ran nor failed; "I could not check" made explicit.
 * @property {{
 *   repo: string;
 *   branch: string | null;
 *   head: string | null;
 *   role: 'verify-in' | 'scope' | 'named' | 'sibling';
 * }[]} [trees] - The trees the verdict read (control-tower phase 40, #41) — `verify-in`
 *   is the one it ran against; `scope`, `named` and `sibling` the others it
 *   looked at. Drawn as the verdict's `{repo, branch, head}` line (phase 24).
 */

/**
 * One structured boarding-preflight finding (`preflight` is the frozen string twin).
 * @typedef {object} PreflightWarning
 * @property {'human-check' | 'missing-lead' | 'cwd-unpinned' | 'nothing-runnable'} kind
 * @property {string} message
 * @property {string} [lead]
 * @property {string} [command]
 */

/**
 * The episode in progress: which signal, since when, and the one line of evidence.
 * @typedef {object} StallState
 * @property {import('../attention-model.js').StallSignal} signal
 * @property {string} since - ISO — when the condition BECAME true, not when the ticker noticed.
 * @property {string} detail
 * @property {{ tool: string; summary?: string; open: boolean; since: string; ok?: boolean }} [waitingOn] - `silent` only: the call a quiet lane is inside, else its last one (control-tower phase 95, #138).
 */

/**
 * A tool call that went out and has not come back.
 * @typedef {object} OpenTool
 * @property {string} id
 * @property {string} name
 * @property {string} since
 * @property {string} [summary] - The call's own one-line summary — for a `Bash` call, the command.
 */

/**
 * One thing a lane's session did, read from its OWN log (control-tower phase
 * 95, #138) — `line` is the log line's id, what a report links to.
 * @typedef {{
 *     kind: 'tool';
 *     id: string;
 *     name: string;
 *     description?: string;
 *     summary?: string;
 *     at: string;
 *     endedAt?: string;
 *     exit?: 'ok' | 'error';
 *     code?: number;
 *     open?: true;
 *     line: string;
 *   }
 * | { kind: 'text'; at: string; text: string; line: string }
 * | {
 *     kind: 'marker';
 *     at: string;
 *     marker: 'compaction' | 'wrap-up' | 'supervisor' | 'input';
 *     text: string;
 *     line: string;
 *   }} ActivityEvent
 */

/**
 * `GET /api/run/:slug/phase/:n/activity` — always `untrusted`: a model's own words.
 * @typedef {object} PhaseActivity
 * @property {string} slug
 * @property {string} [runId]
 * @property {number} phase
 * @property {string} [sessionId]
 * @property {boolean} live
 * @property {'session-log' | 'none'} source
 * @property {true} untrusted
 * @property {ActivityEvent[]} events
 * @property {number} bytesRead
 * @property {string} [why]
 */

/**
 * A stored trigger — "when X happens, press Y" (`server/triggers.ts`,
 * control-tower phase 98, #137): kept per PLAN, so it outlives the run it was
 * armed on. Its words are `shared/verb-model.js`'s (`TRIGGER_EVENTS`,
 * `TRIGGER_MODES`, `TRIGGER_STATES`).
 * @typedef {object} StoredTrigger
 * @property {string} id
 * @property {string} slug
 * @property {string} when - `parseWhen`'s grammar: `phase-done:4`, `run-paused`, `at:<ISO time>`, …
 * @property {string} verb - A verb the table marks `trigger`.
 * @property {Record<string, unknown>} body
 * @property {(typeof import('../verb-model.js').TRIGGER_MODES)[number]} mode
 * @property {string | null} expiresAt
 * @property {string | null} note
 * @property {string} armedAt
 * @property {{ by: string; via?: string; [key: string]: unknown }} armedBy
 * @property {(typeof import('../verb-model.js').TRIGGER_STATES)[number]} state
 * @property {{ at: string; cause: string; ok: boolean; status: number; error?: string }[]} firings
 * @property {string} [endedAt]
 * @property {string} [endedBy]
 */

/**
 * What arming one sends — the route's own field names (`every: true` is the `every` mode).
 * @typedef {object} TriggerArm
 * @property {string} when
 * @property {string} verb
 * @property {Record<string, unknown>} [body]
 * @property {boolean} [every]
 * @property {string} [expiresAt]
 * @property {string} [note]
 */

/**
 * Where a report's figure came from.
 * @typedef {{ kind: 'journal'; seq: number; event: string }
 * | { kind: 'session-line'; line: string }
 * | { kind: 'task'; id: string }
 * | { kind: 'lane'; field: string }
 * | { kind: 'record'; field: string }
 * | { kind: 'machine'; sample: 'loadavg' }} ReportSource
 */

/**
 * `GET /api/run/:slug/phase/:n/report` — see `server/analysis/phase-report.ts` (#163).
 * @typedef {object} PhaseReport
 * @property {string} slug
 * @property {string} runId
 * @property {number} phase
 * @property {string} at
 * @property {string} status
 * @property {boolean} live
 * @property {{
 *   task?: { id: string; text: string; since?: string; source: ReportSource[] };
 *   operation?: { label: string; done: number; of: number; pct: number; at: string; source: ReportSource[] };
 *   last?: { text: string; at: string; source: ReportSource[] };
 * }} doing
 * @property {{
 *   count: number;
 *   total: number;
 *   items: { id: string; text: string; durationMs?: number; source: ReportSource[] }[];
 * }} done
 * @property {{ count: number; items: { id: string; text: string; status: string; source: ReportSource[] }[] }} left
 * @property {{
 *   kind: 'tool' | 'wait' | 'queue';
 *   text: string;
 *   since?: string;
 *   until?: string;
 *   source: ReportSource[];
 * }[]} waitingOn
 * @property {{ rule: SlowRule; text: string; source: ReportSource[] }[]} whySlow
 * @property {{
 *   minutes: { low: number; high: number } | null;
 *   confidence: PhaseEtaConfidence;
 *   basis: string;
 *   source: ReportSource[];
 * }} eta
 * @property {{
 *   id: string;
 *   text: string;
 *   status: string;
 *   startedAt?: string;
 *   durationMs?: number;
 *   source: ReportSource[];
 * }[]} timeline
 * @property {string} summary
 */

/**
 * One live lane, as `GET /api/run/:slug` reports it (`liveness[]`).
 *
 * `commitsSinceStart` and `treeDirty` cost a subprocess each, so the server
 * refreshes them every five minutes rather than every tick: they answer "has
 * this ATTEMPT produced anything at all", which does not change per turn. Read
 * them as a few minutes old and never as a live clock — and the window really is
 * the attempt's, so a phase that committed on an earlier attempt reads zero here
 * until this one commits.
 * @typedef {object} LaneLiveness
 * @property {number} phase
 * @property {string} lastOutputAt
 * @property {string} [lastToolUseAt]
 * @property {number} turnsSinceLastTool
 * @property {number} commitsSinceStart
 * @property {boolean} treeDirty
 * @property {OpenTool} [openTool]
 * @property {{ tool: string; summary?: string; since: string; ok?: boolean }} [lastCall] - The last call this attempt finished — what a card names when nothing is open (control-tower phase 95).
 * @property {StallState} [stall]
 * @property {{
 *   kind: (typeof import('../attention-model.js').SILENCE_KINDS)[number];
 *   sinceMs: number;
 *   thresholdMs: number;
 *   graceMs?: number;
 * }} [silence] - Which silence the lane is in, since when (epoch ms) and against which
 *   threshold (#28, `server/runner/liveness.ts` `silenceOf`). Absent while the
 *   console itself silenced the lane (verifying, frozen) and on an older server.
 *   A row prints it LABELLED — `SILENCE_LABELS` — never as a bare elapsed.
 * @property {{ count: number; since: string }} [retries] - API retries since the last productive event. Absent while there are none.
 *   See `server/runner/liveness.ts` — without it a retry storm reads as plain
 *   silence on every surface an operator has.
 * @property {LaneTokens} [tokens] - What this attempt's session has cost in context so far. Absent until its
 *   first API call. See `server/runner/liveness.ts` `LaneTokens`.
 * @property {number} [spentUsd] - What the session in flight has cost so far, in dollars — not yet in the
 *   run's `spentUsd`, which books a session when it ends. Absent until its
 *   first `result`. See `server/runner/liveness.ts`.
 */

/**
 * A live lane's context and caching (autopilot-token-drain phase 3).
 *
 * `context` is the newest API call's — what every further call re-reads — and
 * `peak` the largest; `input`, `cacheRead`, `cacheWrite` and `output` are this
 * attempt's sums. `rebuilds` counts calls that wrote the cache again instead of
 * reading it, `pollCalls` the status checks the poll-loop guard counted.
 * `window` is the context window the server judged against, when it knew the
 * model; `stage` is the line the context has passed — `wrap-up` (the session has
 * been told to finish up) or `checkpoint` (the console is ending it and boarding
 * the next attempt fresh) — and absent below both.
 * @typedef {object} LaneTokens
 * @property {number} context
 * @property {number} peak
 * @property {number} calls
 * @property {number} rebuilds
 * @property {number} input
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} output
 * @property {number} pollCalls
 * @property {number} [window]
 * @property {'wrap-up' | 'checkpoint'} [stage]
 */

/* ---------------- rulings (Phase 5's ledger) ---------------- */

/**
 * @typedef {(typeof import('../evidence-model.js').RULING_KINDS)[number]} RulingKind
 */

/**
 * One judgement call a session recorded — `phase-outcome.sh <slug> <N> ruling`.
 *
 * A ruling is not an outcome and never becomes one: nothing acts on it, which
 * is the property that makes it safe for a session to record whenever it is in
 * doubt. `ack` is an annotation, never a resolution — a ruling is never "done",
 * and acking one appends a line to the ledger rather than editing the old one.
 * @typedef {object} Ruling
 * @property {string} id
 * @property {string} slug
 * @property {number} phase
 * @property {RulingKind} kind
 * @property {string} what
 * @property {string} [why]
 * @property {string} [costIfWrong] - The field that makes a ruling worth reading.
 * @property {string} [sessionId]
 * @property {string} at
 * @property {{ at: string; by?: string }} [ack]
 */

/* ---------------- the journal ---------------- */

/* ---- the time axis (`server/analysis/timeline.ts`) ---- */

/**
 * `working` is a session and nothing else; `queued`, `down` (the run itself was
 * stopped, with its cause on `note`) and `verifying` are drawn as themselves
 * (control-tower phase 61, #76).
 * @typedef {'working' | 'verifying' | 'queued' | 'waiting' | 'down' | 'frozen'} BarKind
 */

/**
 * @typedef {object} TimelineBar
 * @property {BarKind} kind
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} attempt
 * @property {boolean} open - Still open when the journal ended — drawn hatched, never as finished.
 * @property {string} [note] - Why — a `down` bar's cause (`halted: plan-lint`, `stopped by operator`).
 */

/**
 * @typedef {'board' | 'verify' | 'rung' | 'park' | 'wall' | 'outcome' | 'session' | 'ask' | 'policy' | 'start' | 'note'} MarkKind
 */

/**
 * @typedef {object} TimelineMark
 * @property {MarkKind} kind
 * @property {number} atMs
 * @property {number} [phase]
 * @property {string} label
 * @property {boolean} [ok]
 */

/**
 * @typedef {object} TimelineLane
 * @property {number} phase
 * @property {TimelineBar[]} bars
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} totalMs
 * @property {number} workingMs
 * @property {number} verifyingMs
 * @property {number} queuedMs
 * @property {number} waitingMs
 * @property {number} downMs
 * @property {number} frozenMs
 * @property {number} measuredMs - Session and verification time on closed bars — the critical path's only weight.
 * @property {number} attempts
 * @property {boolean} partial - The journal's tail cut this lane's opening off.
 * @property {boolean} critical
 */

/**
 * One value over one attempt window, on the bars' own axis (`server/analysis/timeline.ts`).
 * @typedef {object} TimelineSeriesPoint
 * @property {number} phase
 * @property {number} attempt
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} value
 * @property {boolean} open - Still open: `value` is what it has spent SO FAR.
 */

/**
 * @typedef {object} RunTimeline
 * @property {string | null} startedAt
 * @property {string | null} endedAt - `null` while the run is still going — NOT the same as the axis's edge.
 * @property {string} horizonAt
 * @property {number} spanMs
 * @property {TimelineLane[]} lanes
 * @property {TimelineMark[]} marks
 * @property {number[]} criticalPath
 * @property {number} criticalMs
 * @property {boolean} truncated
 * @property {number} unmapped
 * @property {{ cost: TimelineSeriesPoint[]; tokens: TimelineSeriesPoint[] }} [series] - Cost and peak context per attempt window (control-tower phase 7). Optional
 *   on the client because a console older than that answers without it.
 * @property {string} [asOf] - ISO — when the projection was taken; the axis's "now" until a progress frame is newer.
 */

/* ---- the ledger (`server/analysis/ledger.ts`, zero-touch phase 19) ---- */

/**
 * One start of a run, a refused one, or a session started beside it — with the actor's words.
 * @typedef {object} LedgerStart
 * @property {string} at
 * @property {'run.start' | 'run.start-refused' | 'phase.session-start'} event
 * @property {number | null} phase
 * @property {boolean} resumed
 * @property {string | null} door
 * @property {string | null} trigger
 * @property {string | null} guard
 * @property {string | number | null} counter
 * @property {string | null} by
 * @property {string | null} via
 * @property {string | null} origin
 * @property {string | null} remoteUser
 * @property {string | null} account
 * @property {string | null} mode
 * @property {string} said - The actor as one sentence.
 * @property {string | null} reason
 */

/**
 * @typedef {{ value: number; source: string; basis?: string } | null} LedgerCap
 */

/**
 * One `phase.session` line — how a session ended, what it cost, how long it ran, under which caps.
 * @typedef {object} LedgerSession
 * @property {string} at
 * @property {number | null} phase
 * @property {string} mode
 * @property {number | null} attempt
 * @property {string | null} model
 * @property {string | null} sessionId
 * @property {boolean} resumed
 * @property {string | null} endedBy
 * @property {boolean} consoleEnded - The console ended it, rather than the session finishing its turn.
 * @property {boolean} isError
 * @property {number | null} turns - Every prompt's turns, summed — the session's total.
 * @property {string | null} turnsSource
 * @property {number | null} promptTurns - The largest one prompt's turns — what `maxTurns` binds, per prompt
 *   (control-tower phase 89, #62's SIZ-7). `null` on a line from before it.
 * @property {number | null} costUsd - `null` when the session never reported a cost — unknown, never $0.
 * @property {string | null} costSource
 * @property {number | null} ms
 * @property {LedgerCap} maxTurns
 * @property {LedgerCap} maxBudgetUsd
 * @property {string | null} account
 */

/**
 * One rung settlement, with the driver word the ladder table gives its vehicle.
 * @typedef {object} LedgerRung
 * @property {string} at
 * @property {number | null} phase
 * @property {string} rung
 * @property {string | null} driver
 * @property {string} outcome
 * @property {string | null} [cause] - `RUNG_FAILURE_CAUSES` — absent on a server from before control-tower phase 24.
 * @property {string} situation
 * @property {number} costUsd
 * @property {string | null} note
 * @property {string | null} by
 */

/**
 * @typedef {object} LedgerTotals
 * @property {number} sessions
 * @property {number} sessionsUsd
 * @property {number} unknownCost
 * @property {number} turns
 * @property {number} ms
 * @property {number} rungsUsd
 * @property {number | null} spentUsd
 * @property {number | null} gapUsd
 * @property {boolean | null} reconciled - Within a cent with every cost known; `null` when there is no run to hold it to.
 * @property {boolean} truncated
 */

/**
 * @typedef {object} RunLedger
 * @property {string | null} runId
 * @property {LedgerStart[]} starts
 * @property {LedgerSession[]} sessions
 * @property {LedgerRung[]} rungs
 * @property {LedgerTotals} totals
 */

/**
 * @typedef {object} LedgerSummaryRow
 * @property {string} key
 * @property {number} runs
 * @property {number} sessions
 * @property {number} costUsd
 * @property {number} unknownCost
 * @property {number} turns
 * @property {number} ms
 */

/**
 * @typedef {object} LedgerSummary
 * @property {LedgerSummaryRow[]} plans
 * @property {LedgerSummaryRow[]} accounts
 * @property {number} truncatedRuns
 * @property {number} [unknownSessions] - Sessions that never reported a cost, over every run. Absent from a server older than 7.0.
 */

/**
 * @typedef {object} AttemptVerification
 * @property {string} command
 * @property {boolean} ok
 * @property {number} code
 * @property {number} ms
 */

/**
 * @typedef {object} AttemptSummary
 * @property {number} phase
 * @property {number} attempt
 * @property {string} startedAt
 * @property {string | null} endedAt
 * @property {number} durationMs
 * @property {string} outcome
 * @property {string | null} model
 * @property {string | null} effort
 * @property {number | null} costUsd - `null` means nothing was recorded — a different claim from `$0`.
 * @property {number | null} turns
 * @property {number} sessions
 * @property {string[]} rungs
 * @property {{
 *   ok: boolean;
 *   reason: string | null;
 *   cwd: string | null;
 *   ran: AttemptVerification[];
 *   notRun: number;
 *   skipped: number;
 *   trees?: { repo: string; branch: string | null; head: string | null; role?: string }[];
 * } | null} verification - `trees`: The trees that verdict read (`phase.verify` `trees`) — absent from a server before phase 24.
 * @property {string | null} said
 */

/**
 * @typedef {object} VerificationFlip
 * @property {string} command
 * @property {'pass' | 'fail' | 'absent'} from
 * @property {'pass' | 'fail' | 'absent'} to
 * @property {number | null} fromCode
 * @property {number | null} toCode
 * @property {number | null} fromMs
 * @property {number | null} toMs
 */

/**
 * @typedef {object} AttemptComparison
 * @property {number} phase
 * @property {number} from
 * @property {number} to
 * @property {{ from: string; to: string; changed: boolean }} outcome
 * @property {{ from: string | null; to: string | null; changed: boolean }} model
 * @property {{
 *   from: boolean | null;
 *   to: boolean | null;
 *   flips: VerificationFlip[];
 *   unchanged: number;
 * }} verification
 * @property {{ from: string[]; to: string[] }} rungs
 * @property {{ from: number; to: number; deltaMs: number }} durationMs
 * @property {{ from: number | null; to: number | null; deltaUsd: number | null }} costUsd
 * @property {{ from: number | null; to: number | null }} turns
 */

/**
 * @typedef {object} PhaseAttempts
 * @property {string | null} runId
 * @property {AttemptSummary[]} attempts
 * @property {AttemptComparison[]} comparisons
 */

/**
 * One line of a run's journal (`server/runner/journal.ts` `JournalEntry`).
 *
 * `seq` is per run and monotonic, which is what makes a line permalinkable:
 * `#/plan/:slug/run?j=<seq>` names one entry for as long as the run exists.
 * @typedef {object} JournalEntry
 * @property {number} seq
 * @property {string} time
 * @property {string} event
 * @property {number} [phase]
 * @property {Record<string, unknown>} [data]
 */

/* ---------------- claimed vs evidenced ---------------- */

/**
 * `shared/evidence-model.js` `deriveEvidence` output — the four facts behind a
 * claim, and whether they back it.
 *
 * Named `evidenced`, never `done`: the board says a phase is done, and this
 * says whether anything on disk agrees. `why` is never empty.
 * @typedef {object} EvidenceProof
 * @property {(typeof import('../evidence-model.js').BOARD_WORDS)[number]} board
 * @property {(typeof import('../evidence-model.js').HANDOFF_WORDS)[number]} handoff
 * @property {(typeof import('../evidence-model.js').VERIFICATION_WORDS)[number]} verification
 * @property {(typeof import('../plan-vocab.js').QA_DISPLAY_WORDS)[number]} qa
 * @property {boolean} evidenced
 * @property {boolean} [stale] - The board paints work in flight and nothing live was found behind it.
 *
 *   Optional so a client built after a server is not: `undefined` reads as
 *   "this server did not measure it", which is the honest degradation — a warn
 *   chip nobody measured is worse than no chip.
 * @property {string[]} why
 */

/* ---------------- what is actually running a phase ---------------- */

/**
 * Which witness saw a phase being worked. `LIVE_VIA` in
 * `shared/evidence-model.js` is the one definition; this mirrors it.
 * @typedef {'run' | 'lock' | 'registry'} PhaseLiveVia
 */

/**
 * Who is driving a live phase. `PHASE_ACTORS` in `shared/status-vocab.js` is
 * the one definition; this mirrors it (allowed by name in vocab-owners).
 * @typedef {'autopilot' | 'agent' | 'external'} PhaseActor
 */

/**
 * Something OBSERVED to be working this phase right now — the fact the board
 * word is a claim about.
 *
 * ABSENT means nothing live was found, and it also means "a server that does
 * not send this field". The two reading alike is deliberate: both are "we
 * cannot say anything is running", which is the answer a chip should act on.
 * @typedef {object} PhaseLive
 * @property {PhaseLiveVia} via
 * @property {PhaseActor} [actor] - Who is driving — absent from a server older than the field.
 * @property {string} [session] - The Claude session id, when the witness knows one. What a deep link needs.
 * @property {number} [pid] - The process. Only `via: 'run'` ever knows one.
 */

/**
 * One row of a session's task list, as the server folded it.
 *
 * The same shape `shared/task-model.js` produces for the browser's own fold —
 * by construction, not by coincidence: both come out of `foldTaskEvent`, which
 * is what lets the activity panel be SEEDED from the record instead of
 * re-deriving the list from a bounded transcript replay that has no creates in
 * it. `id` is null only for a `TaskCreate` whose id has not come back yet.
 * @typedef {object} PhaseTask
 * @property {string | null} id
 * @property {string} [key] - The `tool_use` id of the create, while it is still waiting for an id.
 * @property {string} content
 * @property {string} [activeForm]
 * @property {string} status
 */

/**
 * One QA round on a phase, as the run recorded it.
 *
 * `verdict` is a plain string, not the verdict union: it comes off a file a
 * person may have hand-broken, and an unparseable cell must be showable rather
 * than throwing. `costUsd`/`turns` are the reviewing SESSION's spend, booked
 * against the first round it produced — a session that recorded two rounds
 * spent its money once.
 * @typedef {object} QaRound
 * @property {number} round
 * @property {string} verdict
 * @property {string} [reportPath] - Relative to the plan's handoff folder, as `test-status.md` records it.
 * @property {string} [sessionId]
 * @property {string} [brief]
 * @property {number} [costUsd]
 * @property {number} [turns]
 * @property {string} [at]
 */

/**
 * The landing engine's position for one phase — `server/runner/state.ts` `PhaseLanding`.
 * @typedef {object} PhaseLanding
 * @property {import('../landing-model.js').LandPolicy} policy - The policy resolved for this phase (`--land N`).
 * @property {import('../landing-model.js').ConflictPolicy} conflict - The conflict policy read once at the landing.
 * @property {import('../landing-model.js').LandingState | 'pending'} state - The ledger's word for the phase as a whole: the least-advanced repository.
 * @property {'local' | 'push' | 'session' | 'verify' | 'watch' | 'done' | 'parked'} step - The engine's own position — finer than the ledger's word.
 * @property {'local' | 'push' | 'session' | 'verify'} [resumeFrom] - Where a PARKED landing resumes from, when it may. Absent on a park a person owns.
 * @property {Record<string, PhaseLandingRepo>} repos - One entry per mounted repository, keyed by the ledger's repo key (`''` is the root).
 * @property {number} attempts - How many times the remote half has been attempted.
 * @property {number} [rebases] - Rebase sessions spent on a lane conflict. Absent means none.
 * @property {string} at - When the landing last moved.
 * @property {string} [note] - Why it parked or degraded, in one sentence.
 */

/**
 * @typedef {object} PhaseLandingRepo
 * @property {string} branch - The branch this repository's work is on — the lane branch, else the run branch.
 * @property {import('../landing-model.js').LandingState | 'pending'} state
 * @property {string} [pushed] - The sha the push put on the remote, once it did.
 * @property {{
 *   repo: string;
 *   number: number;
 *   url: string;
 *   state: string;
 *   mergedAt?: string;
 *   mergeCommit?: string;
 *   checkedAt: string;
 * }} [pr] - The pull request, once verified against `gh pr view`.
 */

/**
 * One phase's §Verification baseline — `server/runner/state.ts` `VerifyBaseline`.
 * @typedef {object} PhaseBaseline
 * @property {string} at
 * @property {string | null} tree
 * @property {string | null} head
 * @property {boolean} [concurrent]
 * @property {{
 *   command: string;
 *   chain?: string;
 *   ok: boolean;
 *   code: number;
 *   failures?: string[];
 *   tail?: string;
 *   environment?: string;
 *   from: 'reused' | 'measured';
 *   once?: true;
 * }[]} commands
 */

/**
 * Which word set a §Verification time limit — `server/runner/state.ts` `VerifyLimitSource`.
 * @typedef {'phase' | 'plan' | 'history' | 'default'} VerifyLimitSource
 */

/**
 * How a measured session cap was derived — `server/runner/session-record.ts` `CapDerivation`.
 * @typedef {object} CapDerivation
 * @property {'this-console' | 'shipped'} basis
 * @property {number} percentile
 * @property {number} headroom
 * @property {number} samples
 * @property {string | null} from
 * @property {string | null} to
 * @property {number} observed
 */

/**
 * One session cap (turns or dollars) and where it came from — `session-record.ts` `Cap`.
 * @typedef {object} Cap
 * @property {number} value
 * @property {import('../run-lifecycle.js').CapSource} source
 * @property {string} [basis]
 * @property {CapDerivation} [derivation]
 */

/**
 * One session's context and token counters — `server/runner/usage.ts` `TokenAttempt`.
 * @typedef {object} TokenAttempt
 * @property {number} calls
 * @property {number} [firstContext] - The first call's context (the boot); absent on counters written before it was kept.
 * @property {number} lastContext
 * @property {number} peakContext
 * @property {number} input
 * @property {number} cacheWrite
 * @property {number} cacheRead
 * @property {number} output
 * @property {number} rebuilds
 * @property {string} mode - What the session was for — `phase`, `qa`, `closeout`, `repair`, `resume`, `pr`, `review`.
 * @property {number} [attempt]
 * @property {string | null} sessionId
 * @property {boolean} resumed
 * @property {string | null} model
 * @property {number | null} window
 * @property {number} [pollCalls]
 * @property {number} [pollDenied]
 * @property {string} [account]
 * @property {string} endedAt
 */

/**
 * A context threshold the console acted on — `usage.ts` `ContextMark`.
 * @typedef {object} ContextMark
 * @property {string | null} sessionId
 * @property {string} at
 * @property {number} context
 * @property {number} window
 * @property {boolean} [delivered]
 * @property {number} [attempts]
 * @property {string} [reason]
 */

/**
 * The newest `partial` a session declared — `usage.ts` `PartialMark`.
 * @typedef {object} PartialMark
 * @property {string | null} sessionId
 * @property {string | null} reason
 * @property {string} at
 */

/**
 * One park, from its own stamps — `server/runner/wait-budget.ts` `WaitEntry`.
 * @typedef {object} WaitEntry
 * @property {string} parkedFrom
 * @property {string} parkedUntil
 * @property {string} [requested]
 * @property {string} [resumedAt]
 * @property {import('../run-lifecycle.js').WaitAuthor} by
 * @property {true} [unbudgeted]
 * @property {'person'} [kind]
 * @property {{ ref: string; result: string; exitedAt?: string }} [unit]
 */

/**
 * One row of the declaration ledger — `state.ts` `DeclarationLedgerRow`.
 * @typedef {object} DeclarationLedgerRow
 * @property {number} count
 * @property {string} lastAt
 * @property {number} [refused]
 */

/**
 * One wall the console recorded for a lane — `server/permissions/walls.ts` `RecordedWall`.
 * @typedef {object} RecordedWall
 * @property {import('../turn-model.js').Wall} wall
 * @property {string} tool
 * @property {string} [rule]
 * @property {string} [command]
 * @property {string} at
 * @property {'hook' | 'cli' | 'landing' | 'preflight' | 'broker'} source
 * @property {string} [reason]
 */

/**
 * What a loop suspicion is evidence of — `server/runner/liveness.ts` `LoopEvidence`.
 * @typedef {object} LoopEvidence
 * @property {string} tool
 * @property {string} summary
 * @property {string} hash
 * @property {number} count
 * @property {string[]} ids
 */

/**
 * A lane the console suspects of going round in circles — `liveness.ts` `PhaseSuspect`.
 * @typedef {object} PhaseSuspect
 * @property {'loop'} kind
 * @property {string} since
 * @property {string} detail
 * @property {LoopEvidence} evidence
 */

/**
 * One judge's word on one numbered exit criterion.
 * @typedef {object} EvaluationCriterion
 * @property {string} id
 * @property {'met' | 'not-met' | 'unknown'} verdict
 * @property {string} evidence
 */

/**
 * The independent evaluator's verdict on a phase (`server/pro/evaluator/index.ts` `PhaseEvaluation`).
 * @typedef {object} PhaseEvaluation
 * @property {number} attempt
 * @property {string} at
 * @property {'advisory' | 'hold' | 'off'} mode
 * @property {'met' | 'not-met' | 'unknown'} verdict
 * @property {{ id: string; text: string }[]} criteria
 * @property {Partial<
 *   Record<
 *     'spec' | 'standards',
 *     { criteria: EvaluationCriterion[]; summary: string; words: number; cut?: boolean }
 *   >
 * >} dimensions
 * @property {boolean} ran
 * @property {string} [why]
 * @property {{ url: string | null; used: boolean; why?: string }} [browser]
 * @property {number} costUsd
 * @property {string} model
 * @property {string} account
 */

/**
 * A red another phase's verification inherited and named this phase for — `state.ts` `OwedRed`.
 * @typedef {object} OwedRed
 * @property {string} command
 * @property {string} [chain]
 * @property {string[]} failures
 * @property {number} by
 * @property {string} at
 * @property {'charged' | 'commit' | 'wip' | 'wip-red'} how
 * @property {string[]} [paths]
 */

/**
 * This phase's committed work-in-progress failed the fast gate — `state.ts` `WipRed`.
 * @typedef {object} WipRed
 * @property {string} sha
 * @property {string[]} [files]
 * @property {{ command: string; failures?: string[] }[]} [lines]
 * @property {string} [at]
 */

/**
 * The operator's one-shot edits for the next boarding — `state.ts` `RetryOverride`.
 * @typedef {RetryEdits & {
 *   at: string;
 *   by?: string;
 * }} RetryOverride
 */

/**
 * @typedef {object} PhaseRecord
 * @property {number} phase
 * @property {PhaseStatus} status
 * @property {import('./state.js').QueueControl} [queueControl] - An operator's standing word on this phase's place in the queue — moved
 *   ahead, held, deferred, withdrawn — with who and why (control-tower phase
 *   99, #135). On the record, so the board and the run card show it whether or
 *   not the phase is queued right now.
 * @property {Record<string, import('../budget-model.js').BudgetFact>} [budgetApproaching] - A budget of this phase's past its warning line and not yet raised (phase 25, #40) — budget → fact.
 * @property {import('../run-lifecycle.js').PhaseLifecycle} [lifecycle] - What the phase IS, and why it stopped — `shared/run-lifecycle.js`.
 *
 *   Written beside `status` since 3.5.0 and absent on any record older than
 *   that, which is why every reader passes it to `phaseUiState` rather than
 *   switching on it: the paint falls back to the status word alone.
 * @property {number} attempts
 * @property {number} costUsd
 * @property {boolean} [costUnknown] - The recorded spend is known to be incomplete — see `PhaseRecord.costUnknown`.
 * @property {number} [turns]
 * @property {number} [durationMs] - On the wire this IS `phaseClocks.workedMs` — the attempt windows minus frozen time (#28).
 * @property {import('../phase-clocks.js').PhaseClocks} [phaseClocks] - The labelled clocks, computed by the server when the payload was built (#28).
 * @property {import('../phase-clocks.js').AttemptWindow[]} [attemptWindows] - Each session's window (#28) — `shared/phase-clocks.js`.
 * @property {number} [queuedMs]
 * @property {string} [queuedAt]
 * @property {number} [serialBehind] - A ready phase serial behind a live lane of its own run (control-tower
 *   phase 60, #64) — `ready (behind this run's P<n>)`, never queued.
 * @property {number} [frozenMs]
 * @property {string} [parkedUntil] - When a `waiting` park elapses and the runner resumes the phase's session.
 * @property {string} [parkReason] - The session's own words for what it is waiting on.
 * @property {string[]} [watch] - Refs for the external things being waited on (`gh:…#run/N`, `lock:slug/N`).
 * @property {{
 *   at: string;
 *   refs: Array<{
 *     ref: string;
 *     scheme: string;
 *     state: import('../run-lifecycle.js').WatchStateWord;
 *     detail?: string;
 *     checkedAt: string;
 *     nextDueAt?: number;
 *     minted?: true;
 *     notRun?: CiNotRunView;
 *   }>;
 * }} [watchState] - What the watch clock last found for each ref, and when it asked — the
 *   record's `watchState` (control-tower phase 88, #148), which the phase row
 *   shows as each ref's last probe. A ref with no row has not been asked yet.
 *   `refs.nextDueAt`: Epoch ms of the next probe; absent means never again (a refused ref).
 *   `refs.minted`: The console minted it from a refused in-turn wait, rather than the session declaring it.
 *   `refs.notRun`: A CI run GitHub never started — what the probe read (control-tower phase 111, #166).
 * @property {number} [waits] - How many waiting-external parks this phase has DECLARED (capped by the runner).
 * @property {number} [watchdogParks] - How many times the console parked this phase by itself — its own allowance, never `waits`.
 * @property {{ ref: string; reason: string }[]} [watchUnpollable] - Declared refs no watch scheme can poll, each with why — named on the park, never dropped.
 * @property {{ status: string; by?: string; requested?: string; reason?: string }} [declared] - Who parked it: the session, a hand session through the inbox, or the console's watchdog.
 * @property {{ sessionId: string; at: string; why: string; pid?: number; lock?: string }} [resumeRefused] - A resume the console refused because the session it would resume is still running.
 * @property {{ state: 'near-full' | 'full'; bytes: number; cap: number; at: string }} [replay] - This phase's replay crossed 80 % of its cap (`near-full`) or reached it
 *   (`full`) — the session pane says so (control-tower phase 94, #133).
 * @property {string} [lockWaitSince] - When this phase started queueing behind a foreign lock.
 * @property {PhaseHolder[]} [waitingOn] - What holds this phase up, as the runner wrote it on the record
 *   (`server/runner/state.ts` `PhaseRecord.waitingOn`): the queue's shadows of
 *   another claim, and — kind `fence` — a sibling phase of this run parked on a
 *   declared EXTERNAL wall whose scope meets this one's (control-tower phase 6,
 *   #19), with the refs it still waits on and when the fence lifts by itself.
 *   The Tower's strips say it (phase 20).
 * @property {Record<string, number>} [mcpCalls] - How many times this phase called each attached MCP server, by id. Zero for
 *   an id means it was attached and never touched — the interesting number,
 *   since every attached server is paid for on every turn.
 * @property {string} [resumeSessionId] - Left by a checkpointed freeze; makes Continue a `--resume` rather than a restart.
 * @property {string} [model]
 * @property {string} [effort]
 * @property {string} [actualModel] - What the session's own `init` said it was running on — not always what it was asked for.
 * @property {{ requested: string; resolved: string; at: string }} [modelMismatch] - Parked on a pinned model the session did not start on (#91) — read with `status: 'parked'`.
 * @property {string} [sessionId]
 * @property {string} [startedAt]
 * @property {string} [endedAt]
 * @property {string} [note]
 * @property {string[]} [preflight] - Boarding-preflight warnings on the §Verification — advisory, absent when clean.
 * @property {PreflightWarning[]} [preflightDetail] - The same findings, structured — what a page filters and badges by.
 * @property {McpDegradation[]} [mcpDegraded] - Servers this phase asked for and boarded without. Absent when all connected.
 * @property {VerifySummary} [verification]
 * @property {PhaseBaseline} [baseline] - What the phase's §Verification lines read on the tree it boarded on —
 *   mirrors `server/runner/state.ts` `VerifyBaseline`. Since control-tower
 *   phase 106 a red line keeps its failing tests and an output `tail` (#195),
 *   and a line the machine stopped says why (`environment`, #185).
 * @property {PhaseLanding} [landing] - Where this phase's landing has got to (many-plans-one-repo phase 8) —
 *   mirrors `server/runner/state.ts` `PhaseLanding`. Absent on every phase
 *   of a plan whose word is `hold`, and on a free console. Read by the run
 *   page's landing card (phase 15).
 * @property {{
 *   at: string;
 *   reason: string;
 *   phase?: number;
 *   kind?: import('../recovery-model.js').HaltKind | (string & {});
 *   accounts?: { unusable: number; total: number };
 * }} [halt] - Why THIS phase stopped, when the run drove on without it — mirrors
 *   `server/runner/state.ts` `PhaseRecord.halt`, written by `settlePhase()`.
 *   A parked landing's halt carries the engine's whole sentence: the run
 *   branch, the conflicted files, the other lanes that wrote the same branch
 *   and where to resolve it (`laneConflictHalt`), which is what the landing
 *   card shows a person verbatim. Absent while the phase runs and on every
 *   record the run-level `halt` still describes.
 *   `accounts`: How many registered accounts the breaker refuses, out of how many exist.
 * @property {QaRound[]} [qa] - Every QA round this phase has been through, oldest first — mirrors
 *   `server/runner/state.ts` `QaRoundRecord`.
 *
 *   Absent on every record written before rounds existed, so read it as
 *   `?? []`. This is the run's OWN view of QA: `PhaseView.qa` on the plan side
 *   is the single current verdict parsed out of `test-status.md`, which is what
 *   gates — this is the history behind it plus what each round cost, which no
 *   run surface could show at all before (issue #7).
 * @property {{ round: number; report: string; verb?: string; sessionId?: string; startedAt: string }} [qaSession] - A QA round in flight on this phase — the runner sets it when the reviewer
 *   is spawned and clears it when the round ends. The record reads `done` the
 *   whole time (a review happens after the work), so this is what makes the
 *   session a lane: a tab, a console and a task list on the run page and Now.
 * @property {{ ok: boolean; summary: string }} [lint]
 * @property {{ at: string; ok: boolean; sessionId?: string; note?: string }} [closeout]
 * @property {string} [said]
 * @property {PhaseTask[]} [tasks] - The session's own task list — what `scripts/phase-tasks.sh` published, or
 *   what the CLI's task tools wrote when it still had them. Folded server-side
 *   so it survives a reload and a console restart; absent when the session
 *   published none.
 * @property {{
 *   tasks?: { total: number; done: number; active: string | null };
 *   spentUsd?: number;
 *   contextTokens?: number;
 *   phaseClocks?: import('../phase-clocks.js').PhaseClocks;
 * }} [live] - What a live lane last REPORTED, written by the `run:progress` patch and by
 *   nothing else — never by the server, and never persisted.
 *
 *   The three fields are the ones a summary surface prints and the record's own
 *   copies of which are only as fresh as the last invalidating event: between
 *   phase boundaries that is never, so a row rendering `tasks`, `costUsd` and
 *   the record's context froze at boot while the session worked. Kept beside
 *   the record's own rather than overwriting it, so "what the checkpoint says"
 *   and "what the lane said three seconds ago" stay two answerable questions.
 *   `phaseClocks`: The labelled clocks as of the last `run:progress` frame (#28).
 * @property {{ key: string; at: string; why?: string[] }} [situation] - The classifier's last word on this phase (`server/runner/situation.ts`),
 *   cached on the record for the table and the Ways-forward strip — `key` is
 *   `id:sub`, `why` the evidence lines. Never an input to anything.
 * @property {BoardingHint} [boardingHint] - A rung's instruction for the NEXT boarding — the brief the runner appends
 *   (`fresh` | `resume` | `unblock` | `continue` | `closeout`) and the session
 *   it resumes, when one exists. Consumed the moment the session spawns.
 * @property {{
 *   account: string;
 *   bucket: string;
 *   latest: string;
 *   probes: number;
 *   lastReading?: { at: string; by: string; ok: boolean; resetsAt?: string };
 * }} [usageWall] - A usage wall this phase is parked on (control-tower phase 54, #78): the
 *   account and window, the reset "at the latest", and the last usage reading
 *   that judged it. Read through `wallReading` (`@shared/situation-model.js`),
 *   never shown raw — the countdown is derived at each reading (phase 86, #132).
 * @property {{ at: string; degraded: McpDegradation[] }} [mcpPark] - A `require` MCP park on its clock: when it parked and what was unreachable.
 * @property {{ clear: boolean; kind: string; detail: string }} [gate] - The gate evaluation at boarding.
 * @property {LaneLiveness} [liveness] - The lane's last liveness snapshot, persisted on the record.
 *
 *   Stale by construction once the lane is gone — it is what the SERVER falls
 *   back to when no runner is live (`service.runLiveness`), and the record's
 *   own `status` is what says whether to believe it. Prefer `RunDetail.liveness`
 *   for anything in flight.
 * @property {StallState} [stall] - The stall episode in progress. Cleared when an attempt is given up on.
 * @property {Omit<import('../run-lifecycle.js').UndrivenPhase, 'phase'>} [undriven] - The board reads this phase in progress (or stuck) and nothing of its live
 *   run drives it (control-tower phase 79, #114). Read through the run's
 *   `undriven` list, which answers only for a live run.
 * @property {string} [attemptStartedAt] - ---- Boarding ---- When the current attempt's boarding started — rewritten at every boarding, unlike `startedAt`.
 * @property {string} [attemptEndedAt] - When the last attempt's session ended.
 * @property {{
 *   mode: import('../run-lifecycle.js').SessionMode;
 *   sessionId: string | null;
 *   at: string;
 *   endedBy: import('../run-lifecycle.js').EndedBy;
 *   subtype?: string;
 *   terminalReason?: string;
 *   maxTurns?: Cap;
 *   maxBudgetUsd?: Cap;
 * }} [lastSession] - How the newest session ended: what it was for, who ended it, and the caps it ran under.
 * @property {string} [sessionAccountId] - The account whose config dir holds `sessionId`'s transcript.
 * @property {{ sessionId: string; at: string; reason: string }} [sessionGone] - A session `--resume` can no longer reach — which one, when, and why.
 * @property {RetryOverride} [retryOverride] - The operator's edits for the NEXT boarding only (Retry with edits); spent when it spawns.
 * @property {{ label: string; done: number; of: number; at: string; task?: string }} [progress] - How far the active task's long operation has got, as the session last said.
 * @property {number} [tasksAt] - Bytes of the session's task file already read — bookkeeping, not for display.
 * @property {number} [idleAttempts] - Attempts in a row that ended with nothing committed and a clean tree (the stalemate count).
 * @property {{
 *   nudges: number;
 *   recycles: number;
 *   nudgedAt?: string;
 *   recycledAt?: string;
 *   attempts?: number[];
 *   retryRecycles?: number;
 *   retryRecycledAt?: string;
 *   retryParkedAt?: string;
 *   localNudges?: number;
 *   localNudgedAt?: string;
 *   externalNudges?: number;
 *   externalNudgedAt?: string;
 * }} [stallRemedy] - What the stall watchdogs already did to this phase: nudges and recycles, per ladder.
 * @property {PhaseSuspect} [suspect] - The console suspects this lane of looping (identical failing calls) and did not act on it.
 * @property {TokenAttempt[]} [tokens] - ---- Context ---- Every session's context and token counters, newest last (at most 20).
 * @property {ContextMark} [contextWrapup] - The wrap-up notice sent at 60 % of the window — which session, what context, did it arrive.
 * @property {ContextMark} [contextCheckpoint] - The checkpoint the console took at 80 % of the window; that session is never resumed.
 * @property {number} [wrapupResumes] - How many times the phase re-boarded fresh because its session obeyed the wrap-up notice.
 * @property {PartialMark} [lastPartial] - The newest `partial` the session declared — which session, why, when.
 * @property {string} [verifiedIn] - ---- Verification ---- Where §Verification ran, relative to the run's root (`.` is the root).
 * @property {string} [verifyingSince] - When the runner started this phase's §Verification; absent while it is not running.
 * @property {string} [baselineSince] - When the baseline measurement started; absent while it is not running.
 * @property {{
 *   at: string;
 *   cause: 'shutdown' | 'stop' | 'crash' | 'checkpoint';
 *   ran?: number;
 *   notRun?: number;
 *   jobs?: string[];
 * }} [reverify] - A §Verification the console cut short — the proof the phase is still owed.
 * @property {{
 *   ms: number;
 *   source: VerifyLimitSource;
 *   commands?: { command: string; ms: number; source: VerifyLimitSource }[];
 * }} [verifyLimit] - The time limit §Verification ran under — the total, its source, and each command's.
 * @property {OwedRed[]} [owed] - Reds other phases' verifications inherited and attributed to THIS phase.
 * @property {PhaseEvaluation} [evaluation] - The independent evaluator's newest verdict on this phase — advisory (measured-console phase 22).
 * @property {WipRed} [wipRed] - This phase's committed work-in-progress is red on the fast gate.
 * @property {{ at: string; trees: { repo: string; branch: string; ahead: number; tracked: boolean }[] }} [unpushed] - Commits this phase made that no push has carried to origin yet — gone once a push lands (measured-console phase 12).
 * @property {{ at: string; failed: string[]; times: number }} [reopened] - A red final verdict re-opened this phase after the board read it done.
 * @property {{ at: string }} [reconciled] - Reconcile closed this record on the board's word, not this run's own verification.
 * @property {number[]} [ownPorts] - Loopback ports this phase's sessions served on — a refused connection to one is the machine's.
 * @property {string} [parkedFrom] - ---- Waits and watches ---- When the park now holding (or the last one) began.
 * @property {WaitEntry[]} [waitHistory] - Every park this phase took, oldest first — what parked time is summed from.
 * @property {number} [parkedMs] - Declared parked time at the last evaluation (ms) — a cache for display.
 * @property {number} [parkedMsCarried] - Parked time (ms) folded out of the history, or accrued before it existed.
 * @property {Partial<Record<import('../run-lifecycle.js').OutcomeStatus, DeclarationLedgerRow>>} [declarations] - Every status the sessions declared, counted: acts taken, the last time, refusals.
 * @property {string} [parkOverdueAnnouncedFor] - The `parkedUntil` whose overrun was already announced once.
 * @property {{ at: string; ref: string; state: import('../run-lifecycle.js').WatchStateWord; detail?: string }} [watchChecked] - The watch poller's last verdict on ONE ref — legacy; read `watchState`.
 * @property {number} [watchResumes] - How many times a landed watch ref has resumed this phase (bounded).
 * @property {string} [watchLandedErrandFor] - The landed ref that already produced an over-cap errand.
 * @property {string[]} [watchLandedDone] - Landed refs the healer answered done — never offered again for this declaration.
 * @property {string[]} [watchLandedJournalledFor] - Refs whose landing has already been journalled once.
 * @property {{ count: number; lastAt: string; reason: string; until?: number }} [watchRejections] - The healer's refusals of landed refs: how many, the last, why, and the backoff (epoch ms).
 * @property {string[]} [watchRetired] - `cmd:` refs this phase will never probe again.
 * @property {{ why: import('../run-lifecycle.js').FenceLiftReason; at: string }} [fenceLifted] - Why an operator's act took this phase's wall down as a fence for its siblings, and when.
 * @property {{ by: string; note: string; at: string; declared?: string }} [errandAnswered] - A person answered this phase's errand: who, their note, when, and which declaration.
 * @property {string} [queueSince] - ---- Queue ---- When the current wait first joined a queue — its age; only an admission clears it.
 * @property {number} [queueWaitedMs] - Queued time (ms) over the current wait's episodes already closed.
 * @property {true} [queueReserving] - The entry had aged into reserving before the wait was interrupted.
 * @property {string} [queueSeenAt] - The last moment the open queue episode was seen waiting.
 * @property {{ class: import('../run-lifecycle.js').HolderClass; since: string }} [queueHead] - The open episode's head holder class, and since when.
 * @property {Partial<Record<import('../run-lifecycle.js').HolderClass, number>>} [queuedByClass] - Closed queue time (ms) by the class of holder at its head.
 * @property {number} [lockBackoffMs] - The boarding check's backoff against a foreign lock (ms, 1 s doubling to 30 s).
 * @property {{ tool: string; rule: string; command?: string; matched?: string; at: string }} [toolDenied] - ---- Walls and permissions ---- The last tool call this console's hook refused for the phase.
 * @property {RecordedWall[]} [walls] - Every wall this phase's lane met, newest last (at most 8).
 * @property {{
 *   kind: 'credential-refused';
 *   class?: import('../ops-vocab.js').CredentialClass;
 *   reason: string;
 *   at: string;
 *   account?: string;
 *   evidence?: import('./accounts.js').RetirementEvidence;
 * }} [cause] - The wall the phase last stopped on — a refused credential: class, reason, account, evidence.
 * @property {{ id: string; reason: string }[]} [credentialsMissing] - Credentials the plan named that were missing at boarding (it boarded anyway, told).
 * @property {{
 *   sha: string;
 *   bytes: number;
 *   path: string;
 *   at: string;
 *   sessionId?: string;
 *   truncated?: boolean;
 *   state: 'pending' | 'approved' | 'rejected' | 'continued';
 *   by?: string;
 *   reason?: string;
 *   decidedAt?: string;
 * }} [planApproval] - The plan the session presented through ExitPlanMode — `pending` awaits Approve or Reject.
 * @property {{ flags: number; tried: string[] }} [safeguard] - The API's safeguards flagged this phase's sessions: how often, and what was tried.
 * @property {import('../situation-model.js').WallReading} [wall] - Wire-only: the usage wall read when the payload was built — its live sentence.
 * @property {{
 *   dir: string;
 *   at: string;
 *   by: string;
 *   mounts: { rel: string; sha: string; pushed: boolean }[];
 * }} [errandTree] - ---- Isolation and trees ---- The errand tree a person asked for: its directory, who, and each mounted repository's sha.
 * @property {{ at: string; reason: string; sessionId: string | null; paths: number }} [keepsLane] - A wrap-up kept its lane: uncommitted work (`paths` files) in a shared tree, scope held.
 * @property {{
 *   at: string;
 *   handedOffAt: string | null;
 *   paths: string[];
 *   agents: { id: string; description?: string; lastText?: string; tool?: string }[];
 * }} [agentsKilled] - Background agents the CLI's ceiling stopped mid-work, and the uncommitted paths left.
 * @property {number} [creditUsd] - ---- Cost ---- The part of `costUsd` spent on credit past a plan window.
 * @property {Record<string, number>} [costHighWater] - Each session's last booked running total (session id → dollars).
 * @property {Record<string, string>} [budgetWarned] - Budgets already warned at 80 % (budget kind → the attempt-and-limit key).
 */

/**
 * What a rung told the runner to do at the phase's next boarding.
 * @typedef {object} BoardingHint
 * @property {string} situation
 * @property {string} rung
 * @property {import('../run-lifecycle.js').BoardingBrief | (string & {})} brief
 * @property {string} [sessionId]
 * @property {string} [instruction]
 * @property {'model'} [escalate]
 * @property {string} at
 * @property {string} [by]
 */

/**
 * What a phase does when one of its MCP servers cannot be reached.
 *
 * `continue` (the shipped default) runs it without that server and says so, in
 * the session's prompt and in the phase record. `require` parks at boarding,
 * which is what every phase used to do — one signed-out server halted a real
 * eleven-phase plan that named no MCP servers of its own.
 * @typedef {import('../run-lifecycle.js').McpPolicy} McpPolicy
 */

/**
 * One server a phase asked for and did not get, with the errand it implies.
 * @typedef {object} McpDegradation
 * @property {string} id
 * @property {'needs-auth' | 'failed' | 'unregistered' | 'switched-off'} reason
 * @property {string} [detail]
 */

/**
 * What "Retry with edits…" sends: an instruction for the boot prompt and/or
 * settings, both for ONE attempt.
 *
 * Deliberately the same `PhaseOptions` the run-setup form already builds —
 * there is one vocabulary for "what a phase runs as", and the attempt is a
 * level of it rather than a new idea. The server coerces it through the same
 * table for the same reason.
 * @typedef {object} RetryEdits
 * @property {string} [addendum]
 * @property {PhaseOptions} [options]
 */

/**
 * @typedef {object} PhaseOptions
 * @property {string} [model]
 * @property {string} [effort]
 * @property {string[]} [tools]
 * @property {string} [permissionMode]
 * @property {string[]} [skills]
 * @property {boolean} [skillsOff] - Drop the RUN's skills for this phase; its own `skills` still apply.
 * @property {string[]} [mcpServers] - MCP servers this phase attaches, on top of the plan's and the run's.
 * @property {boolean} [mcpOff] - Drop the RUN's MCP servers for this phase. The PLAN's own `**MCP:**` bullet
 *   still applies — that is a versioned statement about what the phase needs,
 *   not somebody's preference for one run.
 * @property {McpPolicy} [mcpPolicy] - This phase's answer to an unreachable server. The most specific there is,
 *   and the only one that outranks the plan.
 * @property {string[]} [plugins] - Plugin kinds this phase's session loads on top of the plan's own (`PLUGIN_KINDS`); never a run-wide set.
 * @property {boolean} [autoApprove] - Whether the console answers this phase's permission asks itself.
 *   Tri-state: true/false override, absent inherits (plan → global → ON).
 *   Both values are stored — false is a choice, never silence.
 * @property {boolean} [ultracode] - Fan this phase out (or not), whatever the run says.
 */

/**
 * One live `claude -p` process: which phase it is on, and the session it holds.
 * @typedef {object} ChildRef
 * @property {number} pid
 * @property {number} phase
 * @property {string} sessionId
 * @property {string} startedAt - When the PHASE started — hours from the process's own start on a retry.
 * @property {string} [procStartedAt] - When this PROCESS started, as the console saw it at spawn.
 *
 *   The other half of the `(pid, start-time)` tuple the server uses to tell a
 *   child from whatever recycled its pid. Mirrored here because a pid rendered
 *   without it is a number the operator cannot safely act on, and the client
 *   was silently dropping a field the server had been writing all along.
 *   Optional: records written before it existed have no answer, and that is
 *   different from "it started at the epoch".
 * @property {{ at: string; by: string; escalateAt?: string }} [frozen] - Set while THIS lane sits under SIGSTOP. The run-level `freeze` slot can
 *   only name one lane; with several frozen at once this is the per-lane truth
 *   the controls read.
 *
 *   **`escalateAt` absent is a word, not a gap** — a STANDING freeze, which is
 *   what a fleet Freeze-all writes. It never converts to a checkpoint on a
 *   clock, so there is nothing to count down to; render the freeze without a
 *   deadline rather than inventing one.
 * @property {string} [worktree] - The lane's own checkout. **Absent means shared** — this session is editing
 *   the run's own root, as every run did before worktree lanes existed.
 * @property {string} [branch] - The branch that checkout is on (`pe/<slug>-p<N>`). **Absent means the run's
 *   own branch** — set only alongside `worktree`, never on its own.
 * @property {string} [locked] - The `git worktree lock` reason the runner fastened on `worktree`, written
 *   only when git accepted it (phase 15). **Absent means not locked by this
 *   console** — a shared-root lane, a run-level checkout, or a lock git
 *   refused — so a row that reads "locked" is the runner's own word.
 */

/**
 * One of the console's OWN lanes — mirrors `server/runner/state.ts`
 * `VerifyingLane` (control-tower phase 89, #68's 2026-09-25 05:44Z comment).
 *
 * A pass the runner is running for a phase right now, under the phase's grant,
 * with no session behind it: the phase's §Verification (`verify`), its
 * baseline at boarding (`baseline`) or a context wrap-up's fast gate
 * (`wip-gate`). `children` holds only sessions, so a run mid-verification read
 * `running` with nothing in it and the Runs page showed nothing working.
 * @typedef {object} VerifyingLane
 * @property {number} phase
 * @property {'verify' | 'baseline' | 'wip-gate' | 'fast-gate'} purpose
 * @property {string} command - The command running now, condensed by the server (≤ 200 chars).
 * @property {number} index - 1-based position of that command in the pass, out of `total`.
 * @property {number} total
 * @property {string} startedAt - ISO — when the PASS started.
 * @property {string} commandStartedAt - ISO — when THIS command started.
 * @property {boolean} [exported] - It runs in a clean checkout of the phase's HEAD, not the working tree.
 * @property {number} pid - The console's own pid — the process whose children the commands are.
 * @property {'setup'} [stage] - The pass is in its `Setup:` preamble — `command` is the bring-up command (control-tower phase 105).
 * @property {{ pid: number; procStartedAt: string }} [child] - The running command's own process (control-tower phase 105, #173).
 */

/**
 * One operator's waiver of a §Verification line for one phase, mid-run (one-pool phase 21, #267).
 * @typedef {object} VerifyWaiver
 * @property {number} phase
 * @property {string} fp
 * @property {string} text
 * @property {string} reason
 * @property {string} by
 * @property {string} at
 * @property {string} [rulingId]
 */

/**
 * @typedef {object} RunState
 * @property {Record<string, import('../budget-model.js').BudgetFact>} [budgetApproaching] - A run-wide budget past its warning line and not yet raised (phase 25, #40) — budget → fact.
 * @property {number} [pendingDrafts] - The plan's issue drafts waiting on a person (control-tower phase 84, #118)
 *   — set by `GET /api/runs` on the plan's newest run only, absent at zero.
 * @property {import('../run-lifecycle.js').UndrivenPhase[]} [undriven] - The phases the board reads in progress that nothing of this live run
 *   drives (control-tower phase 79, #114) — `undrivenPhases`, set by
 *   `GET /api/runs` on every run; empty for a run that is not live.
 * @property {string} id
 * @property {string} slug
 * @property {string} root
 * @property {RunStatus} status
 * @property {Autonomy} autonomy
 * @property {string} model
 * @property {string} [effort]
 * @property {{
 *   status: string;
 *   window?: string;
 *   utilization?: number;
 *   utilizationPct?: number;
 *   resetsAt?: number;
 *   at: string;
 *   usingOverage?: boolean;
 *   overageStatus?: string;
 *   overageDisabledReason?: string;
 * }} [limits] - `utilizationPct`: The same reading as a percentage, when the CLI sent one.
 *   `usingOverage`: The session runs on credit past its window (control-tower phase 93, #146), and the CLI's overage words.
 * @property {string} [qaModel] - QA's own model and effort — absent, the phase's and then the run's.
 * @property {string} [qaEffort]
 * @property {number} [qaMaxRounds] - How many rounds QA may fail on one phase before a person is handed it — absent, the shipped default.
 * @property {{ accountId: string; from: string; at: string; by: string }} [accountChoice] - The last account switch a PERSON made on this run: to what, from what, when and who (control-tower phase 78, #106).
 * @property {{ accountId: string; resetsAt: string; at: string; reason: string }} [switchedFrom] - Where an automatic switch moved the run FROM, and that account's reset — the move back waits for it (control-tower phase 92, #100).
 * @property {{
 *   armed: boolean;
 *   version: string | null;
 *   floor: string;
 *   reason?: 'below-floor' | 'version-unknown';
 *   at: string;
 * }} [relayArming] - Whether the relay is armed for this run's sessions, and the CLI version that decided it (phase 14).
 * @property {{
 *   approve: { fp: string; text: string }[];
 *   waive: { phase: number; fp: string; text: string }[];
 *   by?: string;
 *   at?: string;
 * }} [verifyApprovals] - The start door's answers for §Verification: commands it may run, fragments set aside per phase (2026-09-18).
 * @property {VerifyWaiver[]} [verifyWaivers] - An operator's mid-run waivers of single §Verification lines, one per (phase, line) (one-pool phase 21, #267).
 * @property {{
 *   lines: { kind: string; plan: string; run: string; phases?: number[] }[];
 *   ack: 'override' | 'automatic';
 *   by?: string;
 *   at?: string;
 * }} [gitStrategyOverride] - The plan git lines this run runs over, answered `override` at launch — by a person or `automatic` (control-tower phase 11, #18).
 * @property {number | null} phaseBudgetUsd
 * @property {number | null} runBudgetUsd
 * @property {number} spentUsd
 * @property {Partial<Record<import('../run-lifecycle.js').HolderClass, number>>} [blockedMs] - Wall-clock time a phase of this run waited in the queue, by the class that held it — each instant charged once (control-tower phase 60, #64).
 * @property {{ class: import('../run-lifecycle.js').HolderClass; since: string }} [blockedOpen] - The blocked stretch open now: the class it is charged to, and since when.
 * @property {number} [costModel] - The cost model `spentUsd` was booked under (`COST_MODEL`, control-tower phase 46, #62) — absent is 1.
 * @property {number} [clockModel] - The clock model the phases' attempt windows were kept under (`CLOCK_MODEL`, control-tower phase 58, #66) — absent is 1.
 * @property {number[]} [failureStreak] - The failure streak itself: the distinct phases whose ending was a merit failure since the last done one (control-tower phase 45).
 * @property {Record<string, string>} [budgetWarned] - Run-wide budgets already warned at the warning line: budget → the key it was claimed under (control-tower phase 14, #40).
 * @property {number} [creditUsd] - The part of `spentUsd` its sessions spent on credit past a plan window (control-tower phase 93).
 * @property {number} maxConsecutiveFailures
 * @property {number} [ladderPerRunRungs] - The run's own ladder rung caps (#14); absent, the console's preference speaks.
 * @property {number} [ladderPerPhaseRungs]
 * @property {number} consecutiveFailures
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {number | null} activePhase
 * @property {ChildRef | null} child - The mirror lane, and every reader written before the pool.
 *
 *   One run can drive several disjoint-scope phases at once, so this is the
 *   LOWEST-numbered live lane rather than "the" child — chosen for stability, so
 *   it does not flip between lanes on every write. It is load-bearing, not
 *   legacy: `reconcileRun` and every console built before lanes answer "is
 *   something running" from it. `children` is the full picture.
 * @property {Record<string, ChildRef>} [children] - Every live lane, keyed by phase — STRING keys, like `phases`.
 * @property {Record<string, VerifyingLane>} [verifying] - The console's own lanes, keyed by phase like `children` (control-tower
 *   phase 89) — `GET /api/runs` sends only the ones the live console is
 *   running now. Absent or empty when nothing is verifying, and on a server
 *   from before the field.
 * @property {{ at: string; pid: number; procStartedAt: string }} [laneBeat] - The lane's beat: stamped at every lock refresh, with the console process refreshing it (control-tower phase 105, #173).
 * @property {number} [maxParallel] - How many lanes this run may hold at once. Never more than the console's cap.
 * @property {string | null} waitUntil
 * @property {WaitReason | null} [waitReason] - Which wait `waitUntil` is — a usage window to sit out, or a phase parked on
 *   work outside the session. They want opposite advice, and the clock alone
 *   never said which, so this view asserted "usage limit" for both. Absent on
 *   runs written before the field; mirrors `server/runner/state.ts`.
 * @property {import('../run-lifecycle.js').RunLifecycle} [lifecycle] - What the run IS, written beside `status` since 3.5.0 — read through `runLifecycle`, which derives it when absent.
 * @property {RunHalt | null} halt - `kind` is the halt's machine-readable class; absent on older records.  `kind` mirrors `server/runner/state.ts`'s HaltKind (open-ended for
 *   records written by other versions); readers go through the shared
 *   KIND_PROFILE, never string literals.
 * @property {{ phase: number; key: string; label: string }[]} [failureRoots] - What each counted failure was charged ON (control-tower phase 87, #122):
 *   the same block stopping four phases is one cause, charged once.
 * @property {{ requestedAt: string; afterPhase: number | null; by: string } | null} pause
 * @property {{
 *   at: string;
 *   phase: number | null;
 *   pid: number;
 *   by: string;
 *   escalateAt?: string;
 * } | null} freeze
 * @property {string} [finishedReason]
 * @property {number[]} [onlyPhases]
 * @property {Record<string, PhaseOptions>} [phaseOptions]
 * @property {string[]} [skills]
 * @property {string[]} [mcpServers] - MCP servers every phase of this run attaches, on top of the plan's own.
 * @property {McpPolicy} [mcpPolicy] - This run's answer to an unreachable server. Absent = `continue`.
 * @property {PermissionProfile} [permissionProfile]
 * @property {string} [accountId] - The Claude account this run spawns as. Absent = the machine login.
 * @property {{ account: string; key: string; email?: string; org?: string; at: string }} [identity] - Who that account answered when the run bound to it (control-tower phase
 *   91, #131) — a run parked `identity-changed` offers to continue on the new
 *   login or move back to this person's profile.
 * @property {OnLimitPolicy} [onLimit] - What the run does at the shared usage window. Absent = `wait`.
 * @property {import('../run-lifecycle.js').ModelPolicy} [modelPolicy] - Whether the run's model may move (control-tower phase 54, #91): `pinned`
 *   runs on the model it names or parks; `ladder` may fall back, step down at
 *   a wall and escalate. Absent = `ladder`; the plan's `**Model policy:**`
 *   outranks it.
 * @property {Record<string, { resolved: string; at: string; from?: string }>} [resolvedModels] - What each requested model resolved to, as the sessions' own `init` said —
 *   `from` when a request moved within this run (`run.model-resolved`).
 * @property {boolean} [resumeOnRestart] - The run's answers to the decision manifest (phase 11): the launch form's
 *   required fields and the manifest as the door resolved it. Absent on a run
 *   from before 5.0.0.
 * @property {RelayMode} [relay]
 * @property {string} [permissionMode] - The run's default permission mode (control-tower phase 11) — absent means `acceptEdits`.
 * @property {number} [approvalTimeoutMinutes] - Minutes an approval card waits for a person (control-tower phase 97, #140) — absent means the hook call's hour.
 * @property {import('../run-settings.js').CacheTtlAb} [cacheTtlAb] - The session's environment (measured-console phase 6), each absent at its
 *   default: the cache test `off`, no keep-warm, the plan's subagent model, and
 *   `DEFAULT_BASH_MAX_OUTPUT` characters of a command's output read back.
 * @property {number} [keepWarmSec]
 * @property {string} [subagentModel]
 * @property {number} [bashMaxOutput]
 * @property {import('../run-settings.js').HumanStepMode} [humanStepMode] - The platform's pieces (measured-console phase 12), each absent at its
 *   default: a person's step `defer`s on a CLI at `DEFER_CLI_FLOOR` or later
 *   and parks below it (`humanStepModeFor`), the console compacts, and
 *   `native` compacts at `DEFAULT_COMPACTION_WINDOW` tokens.
 * @property {import('../run-settings.js').CompactionMode} [compaction]
 * @property {number} [compactionWindow]
 * @property {QaFixStrategy} [qaFixStrategy] - How a QA recovery's fix session boards, and what one round may spend — absent is `resume` and no ceiling.
 * @property {number | null} [qaRoundBudgetUsd]
 * @property {AccountRequirement[]} [accounts]
 * @property {string[]} [acknowledgedWaivers]
 * @property {ResolvedManifest} [manifest]
 * @property {'new-branch'} [gitMode] - The run's git strategy, echoed off the state file. Absent means
 *   default-branch — including on servers from before the feature — so render
 *   nothing rather than falling back to preferences here: a header states the
 *   run's own record.
 * @property {boolean} [openPr] - Meaningful only with `gitMode: 'new-branch'`; absent there means true.
 * @property {import('../worktree-model.js').SettleStrategy} [settle] - What happens to the run's branch when it finishes — see `SETTLE_STRATEGIES`.
 *
 *   **Never read directly.** An absent `settle` is not "no answer": thousands of
 *   run files predate the field and say `openPr` instead, and `openPr: false`
 *   asked for exactly what `keep` means. `settleOf(run)` in
 *   `shared/worktree-model.js` is the one place that back-compatibility lives.
 * @property {import('../worktree-model.js').IsolationMode} [isolation] - What the run ASKED for — its own checkout, or the shared one. Absent means
 *   `queue`, and the same rule as `gitMode` applies: a surface reads the run's
 *   own record here and never falls back to a preference, because a live run's
 *   setting is a fact rather than a default.
 * @property {import('../worktree-model.js').CheckoutState} [checkout] - What the run actually GOT — the outcome to `isolation`'s request.
 *
 *   Absent means `shared`, including on a server from before the feature.
 *   `refused` means isolation was asked for and could not be given: the run is
 *   working in the console's own checkout with queue semantics, and
 *   `isolationRefusal` names which impossibility it hit.
 * @property {string} [workRoot] - The run's managed checkout, when it has one. Absent means `root`.
 * @property {string[]} [mountedRepos] - The repositories a MIRROR workRoot holds, root-relative — present only
 *   when the run's checkout is a mirror of a superproject's sub-repositories
 *   rather than one worktree of the root.
 * @property {string} [isolationRefusal] - Which impossibility a `refused` run hit — a KEY of `REFUSAL_REASON` in
 *   `shared/worktree-model.js`'s sibling `server/runner/worktree.ts`. The
 *   sentence is looked up, never stored, so a surface can never render prose
 *   that has drifted from the code that decided it.
 * @property {string} [isolationRefusalDetail] - The refusal's own words — git's message, or the occupied mounts and their state (control-tower phase 90).
 * @property {{ at: string; by: string }} [repairCheckout] - A person pressed Repair checkout; the next checkout decision spends it (control-tower phase 90, #139).
 * @property {{ at: string; by: string }} [isolateAtBoundary] - Asked to switch this shared-checkout run to a checkout of its own at its next boundary (#150).
 * @property {number[]} [isolatePhases] - Phases of a shared-checkout run given a worktree of their own (`isolate-phase`, #150).
 * @property {{ phase: number; at: string; mounts: string[] }} [mirrorSettled] - Mounts whose `pe/<slug>` this run deleted before a final §Verification, each detached where it stood (control-tower phase 62, #47).
 * @property {{
 *   at: string;
 *   phase: number | null;
 *   repos: {
 *     mount: string;
 *     branch: string;
 *     tip: string;
 *     into: string;
 *     state: 'contained' | 'ahead' | 'conflicted' | 'unknown';
 *     by?: 'ancestry' | 'content' | 'merge-commit';
 *     at?: string;
 *     fetched?: 'fetched' | 'failed';
 *     files: string[];
 *     tree?: string;
 *     detail?: string;
 *   }[];
 * }} [unlanded] - The repositories whose run branch was not on its trunk when every phase was done (control-tower phase 112, #184).
 * @property {string} [detachAt] - The commit this run's checkout is detached at, when it owns no branch.
 * @property {string} [settledAt] - When this run's branch had its fate decided — the moment the settle ran.
 * @property {Record<string, string>} [treesFound] - The branch each SHARED repository stood on when this run first boarded into it: path → branch (control-tower phase 40, #41).
 * @property {{ repo: string; dir: string; branch: string; foundOn?: string; at: string }[]} [treeHolds] - The shared repositories this run holds on its branch until it settles, one per repository.
 * @property {{
 *   kind: 'worktree' | 'branch';
 *   name: string;
 *   branch?: string;
 *   repo?: string;
 *   phase: number;
 *   at: string;
 *   maker?: 'unknown';
 * }[]} [artefacts] - Checkouts and branches that appeared under this run's sessions and that no sweeper owns — a register, never a bin.
 *   `maker`: `unknown`: it appeared while the phase ran, outside its own lane — named, never credited (#262).
 * @property {import('../orchestration-model.js').RunPriority} [priority] - Which class this run's admissions are scanned in. Absent means `normal`,
 *   the same omission convention `isolation` and `gitMode` use — read it
 *   through `runPriority()` rather than testing the field, so a run file from
 *   before the feature and one that says `normal` are the same fact.
 * @property {string} [baseBranch] - The seven words the launch form gained in many-plans-one-repo phase 15
 *   (mirrors `server/runner/state.ts`). Each is absent when the run said
 *   nothing — the plan's line, the console's preference or the owner's
 *   default then decides — and the plan's own line outranks every one of
 *   them. `baseBranch` is immutable once the run's branch exists;
 *   `issuesMode` may only tighten mid-run (the settings door 409s the other
 *   direction, `screens/launch/sections.tsx` says so beside the control).
 * @property {{
 *   ref: string;
 *   sha: string;
 *   source: 'origin-head' | 'trunk' | 'head' | 'ref' | (string & {});
 *   declaredBy: import('../policy-model.js').PolicySource | (string & {});
 * }} [base] - What that word (or the plan's line, the preference, the shipped default)
 *   RESOLVED to when the run's branch was cut — the ref, the commit, which
 *   arm answered (`origin-head` · `trunk` · `head` · `ref`) and who declared
 *   the word (`plan` · `run` · `console` · `default`). Written once by the
 *   runner (phase 15); absent on a run whose word resolved to nothing and on
 *   every run file from before the field. The lane row reads it — "what was
 *   every lane cut from" is asked most by whoever arrives after the console
 *   that decided.
 * @property {number} [maxConcurrentPerRepo]
 * @property {string} [worktreeRetention]
 * @property {import('../landing-model.js').LandPolicy} [landing]
 * @property {import('../landing-model.js').ConflictPolicy} [conflictPolicy]
 * @property {import('../message-model.js').MessagingWord} [messaging]
 * @property {import('../issues-model.js').IssueMode} [issuesMode]
 * @property {string} [startAfter] - A plan slug this run boards after. Absent means no chain.
 * @property {{ at: string; by?: string } | null} [hold] - The operator's hold: nothing new boards, live lanes keep running.
 * @property {boolean} [reviewEachPhase] - The per-phase auto reviewer. Absent means off — see `server/reviewer.ts`.
 * @property {import('../run-lifecycle.js').ReviewerPolicy} [reviewerPolicy]
 * @property {boolean} [ultracode] - The standing ultracode licence in every prompt. Absent means off.
 * @property {import('../run-lifecycle.js').UltraReviewMode} [ultraReview] - When this run runs `claude ultrareview`. Absent means never.
 * @property {RunResolution | null} [resolved] - Why this stopped run no longer wants a person — the board overtook it
 *   (`auto`), or someone dismissed it. Annotation, never deletion: the run is
 *   still here, still halted, still readable. See `server/runner/state.ts`.
 * @property {string | null} [reopenedAt] - A person put the card back; the board resolver leaves it alone from then on.
 * @property {{ lastNoop: string; at: string } | null} [converge] - The convergence loop's "nothing changed" latch, kept with the run so a restart does not churn again (SLF-7).
 * @property {RunNote[]} [notes] - People's notes on this run, oldest first — `server/runner/state.ts` `RunNote` (control-tower phase 96).
 * @property {'operator' | 'system'} [stoppedBy] - Who last stopped the run — the operator (Stop, Pause, an escalated
 *   freeze) or the system (a halt or park the loop wrote, a console shutdown,
 *   a crash found at boot). The convergence loop picks up only the system's
 *   stops. Absent on runs written before the field existed.
 * @property {Errand | null} [errand] - The run-level ask for a person, when a stop has no phase to hang it on.
 * @property {{ from: number; to: number; pct: number; at: string } | null} [budgetRaise] - The resource ladder raised the run budget once (`budgetAutoRaisePct`); its
 *   presence is what makes the raise happen once per run.
 * @property {Record<string, RecoverySlot>} [recoveries] - Recovery bookkeeping, keyed by phase (`plan` for a plan-wide repair) — see `RecoverySlot`.
 * @property {{ attempts?: number }} [autoRecover] - Present when the run heals its own auto-recoverable halts.
 * @property {Ruling[]} [rulings] - The rulings written SINCE this run started, folded in by the watcher.
 *
 *   A slice, not the ledger: `runs/<instance>/<slug>/rulings.ndjson` is per
 *   plan and outlives every run, so a plan on its fourth run would otherwise
 *   carry three runs of history. `GET /api/run/:slug/rulings` reads the whole
 *   file, which is what the page shows.
 * @property {Record<string, PhaseRecord>} phases
 */

/**
 * Why the run stopped — `RunState.halt` (`server/runner/state.ts` `RunState.halt`), hoisted so its Pro member can sit in a region.
 * @typedef {object} RunHalt
 * @property {string} at
 * @property {string} reason
 * @property {number} [phase]
 * @property {import('../recovery-model.js').HaltKind | (string & {})} [kind]
 * @property {{ unusable: number; total: number }} [accounts] - How many registered accounts the breaker refuses, out of how many exist
 *   — written on halts whose remedy might be "use another account", so a
 *   card can say whether there IS another one. Absent on every other kind,
 *   and on records written before 5.2.0.
 * @property {import('../budget-model.js').BudgetFact} [budget] - The budget a `budget` or `failure-streak` halt spent (control-tower
 *   phase 14, #40) — the run's dollars or the streak, with its arithmetic.
 * @property {HaltHolder[]} [holders] - A `nothing-ready` park's holders, one per phase (server `HaltHolder`, phase 5).
 * @property {import('./accounts.js').RetirementEvidence} [evidence] - What a credential refusal stood on (#57) — the retirement's evidence.
 * @property {string} [approvalId] - The approval card whose timeout raised this park — the park lifts when its phase completes (control-tower phase 97, #140).
 */

/**
 * @typedef {object} RunResolution
 * @property {string} at
 * @property {boolean} auto
 * @property {string} reason
 * @property {string} [by]
 * @property {string} [note]
 */

/**
 * One thing holding a `nothing-ready` park (server `HaltHolder`): its phase, kind, the ONE verb that clears it.
 * @typedef {object} HaltHolder
 * @property {number} phase
 * @property {import('../recovery-model.js').HaltHolderKind} kind
 * @property {import('../recovery-model.js').HaltHolderVerb} verb
 * @property {string} why
 * @property {string} [setting]
 * @property {string} [gate]
 * @property {string} [gateKind] - The gate's `--gate-status` verdict word — a person's (`manual`) or a machine's (`blocked`).
 * @property {{ label: string; phasesLeft?: number; eta?: string }[]} [chain] - The blocker BEHIND a cross-plan gate, link by link (#150 ask 4): the phase
 *   the gate waits on, what holds THAT, and the holder run's phases left and
 *   ETA. Drawn when the server sends it; no server writes it yet.
 */

/**
 * The plan a plan-mode phase presented, as the console kept it (`GET …/plan-text`).
 * @typedef {object} PlanText
 * @property {true} ok
 * @property {number} phase
 * @property {string} sha
 * @property {number} bytes
 * @property {string} at
 * @property {string} state
 * @property {boolean} truncated
 * @property {string} text
 */

/**
 * What a person is asked for, ONCE, when the ladder for a phase is exhausted
 * or the situation is intrinsically human: the situation, what was tried (so
 * nobody tries it again by hand), what is needed, and how to give it.
 * @typedef {object} Errand
 * @property {number} phase
 * @property {string} situation
 * @property {string[]} tried
 * @property {string[]} [earlier] - Rungs climbed for a DIFFERENT situation on this phase (server `Errand.earlier`).
 * @property {string} need
 * @property {string} how
 * @property {string} at
 * @property {string} [said] - The session's own last words, verbatim, when they are the evidence — a
 *   zero-turn exit that named its cause (a refusal, an unloadable skill).
 *   Absent on every other errand. See `server/runner/state.ts`.
 * @property {import('../budget-model.js').BudgetFact} [budget] - The budget that stopped this phase, when a budget did (control-tower phase
 *   14, #40): which one, its arithmetic and what spent it — the raise the card
 *   offers beside the reason. Its headline is already the errand's `need`.
 * @property {string} [cap] - A CAP errand's arithmetic (control-tower phase 5, #14): which cap, spent of allowed, and the setting that raises it.
 * @property {number} [spent]
 * @property {number} [limit]
 * @property {number} [onDonePhases]
 * @property {{ key: string; scope: string; label?: string } | string} [setting]
 * @property {boolean} [replenishes] - Whether a Retry of this phase would forgive what the cap counted — said BEFORE the press (#14 ask 3).
 * @property {number[]} [alsoPhases] - The other phases this ONE errand stands for — siblings that met the same
 *   declared external wall and were folded into it rather than filing a copy
 *   each (control-tower phase 6, #19). Each carries `foldedInto` on its slot.
 */

/**
 * One holder on a phase record's `waitingOn` (`server/runner/state.ts`) — the
 * queue's shadow of another claim (slug and owner), or a `fence`: the sibling
 * phase whose declared external wall holds this one's scope, its live refs,
 * and when it lifts by itself (epoch ms; null for no known end).
 * @typedef {object} PhaseHolder
 * @property {string} slug
 * @property {number} [phase]
 * @property {string} owner
 * @property {import('../run-lifecycle.js').HolderKind} [kind]
 * @property {string[]} [refs]
 * @property {number | null} [until]
 */

/**
 * One rung the ladder climbed on a phase (`server/runner/state.ts` `RungRecord`).
 * @typedef {object} RungRecord
 * @property {string} situation
 * @property {string} rung
 * @property {string} at
 * @property {Record<string, string | number | boolean>} [params]
 * @property {number} [costUsd]
 * @property {import('../run-lifecycle.js').RungOutcome} [outcome]
 * @property {string} [note]
 */

/**
 * A run's recovery bookkeeping for one phase (`server/runner/state.ts`
 * `RunState.recoveries[phase]`). `lastOutcome` is the verdict the server has
 * always written and this type once never carried — `no-defect` ("looked,
 * found nothing wrong") was invisible and toasted as a failure.
 * @typedef {object} RecoverySlot
 * @property {number} attempts
 * @property {string} lastAt
 * @property {string} [lastReason]
 * @property {boolean} [fixed]
 * @property {import('../run-lifecycle.js').SettledRungOutcome} [lastOutcome]
 * @property {RungRecord[]} [rungs] - The ladder's own history for this phase — every rung climbed, in order.
 * @property {Errand} [errand] - The one open ask for a person, when the ladder is exhausted.
 * @property {number} [foldedInto] - This phase's ask is another phase's errand — the one it was folded into (`Errand.alsoPhases`).
 * @property {number} [bootResumes] - Resumes after console restarts killed this phase's lane (bounded).
 */

/**
 * One action of a convergence pass, flattened (`server/converge.ts`
 * `ConvergeActionView`): what the loop did, to which phase, and why.
 * @typedef {object} ConvergeActionView
 * @property {'release-debris' | 'relaunch' | 'errand' | 'heal' | 'skip' | (string & {})} kind
 * @property {number | null} [phase]
 * @property {string} [situation]
 * @property {string} [rung]
 * @property {string} [vehicle]
 * @property {string} [owner]
 * @property {string} [session]
 * @property {{
 *   phase: number;
 *   situation: string;
 *   rung: string;
 *   brief?: string;
 * }[]} [reboard]
 * @property {number[]} [rearm]
 * @property {string} [need]
 * @property {boolean} [launched]
 * @property {boolean} ok
 * @property {string} why
 */

/**
 * The convergence loop's last pass on a plan — the Pulse's convergence line.
 * @typedef {object} ConvergeView
 * @property {string} slug
 * @property {import('../run-lifecycle.js').ConvergeTrigger | (string & {})} trigger
 * @property {string} at
 * @property {boolean} launched
 * @property {boolean} noop
 * @property {ConvergeActionView[]} actions
 * @property {number} errands
 */

/**
 * `GET /api/converge`: whether the loop runs by itself here, its cadence, its queue and its last reports.
 * @typedef {object} ConvergeStatusView
 * @property {boolean} automatic
 * @property {number} everyMs
 * @property {{ slug: string; trigger: string; dueAt: number }[]} pending
 * @property {string[]} running
 * @property {ConvergeView[]} reports
 */

/**
 * Which link of the fallback chain answered — and therefore how much of a claim
 * the number is. `etaLabel()` in `lib/format` turns it into words.
 * @typedef {(typeof import('../ops-vocab.js').ETA_BASES)[number]} EtaBasis
 */

/**
 * How far a live phase's own-rate ETA can be trusted (control-tower phase 95, #163).
 * @typedef {(typeof import('../ops-vocab.js').PHASE_ETA_CONFIDENCES)[number]} PhaseEtaConfidence
 */

/**
 * A why-slow cause's rule (#163).
 * @typedef {(typeof import('../ops-vocab.js').SLOW_RULES)[number]} SlowRule
 */

/**
 * Always a range, always hedged, always naming its clock — see
 * `server/analysis/stats.ts`. `clock` is always `'working'` here: a calendar
 * figure is a different shape, `Forecast` (`data/api/plans`).
 * @typedef {object} EtaEstimate
 * @property {number} ratePerWeight
 * @property {number} floorMs - The affine floor: working time any phase takes before its weight counts.
 * @property {number} slopeMsPerWeight - The affine slope, milliseconds per unit of weight.
 * @property {number} samples - How many measured phases the reading weighted.
 * @property {number} missing - Finished phases with no usable measurement, reported beside the count.
 * @property {EtaBasis} basis
 * @property {number} remainingWeight
 * @property {number} remainingPhases
 * @property {number} lowMs
 * @property {number} highMs
 * @property {'working'} clock - Working time: the remaining phases back to back, nothing parked, queued or overnight.
 * @property {string} label
 */

/**
 * One phase's own estimate — a point, not a range.
 * @typedef {object} PhaseEta
 * @property {number} phase
 * @property {number} weight
 * @property {number} estMs
 * @property {EtaBasis} basis
 * @property {'working'} clock
 * @property {string} label
 */

/* ---------------- the branch probe ----------------
 * Mirrors `server/runner/worktree.ts` (`Divergence`, `CheckoutEntry`,
 * `RadarPair`, `RunGitView`) — the probe phase 9 wired onto `run:git` and the
 * `git` field of `GET /api/run/:slug`.
 *
 * ⚠️ **Every number here is optional, and that is the contract, not laziness.**
 * The probe answers `undefined` for a number, `'unknown'` for a verdict and
 * `[]` for a list rather than failing, because none of those is news about the
 * RUN: a monitoring layer that turns a healthy run's page red is worse than one
 * that occasionally says it does not know. A surface therefore renders an
 * absent fact as a dash, never as an alarm. */

/**
 * How far a branch has moved from the base, both ways.
 * @typedef {object} Divergence
 * @property {number} ahead
 * @property {number} behind
 */

/**
 * A registered checkout of this repository, as `git worktree list` sees it.
 * @typedef {object} CheckoutEntry
 * @property {string} dir - Absolute path, as git prints it (symlinks resolved).
 * @property {string} [branch] - The branch it stands on, absent for a detached HEAD or a bare entry.
 * @property {boolean} root - Is this the repository's own root checkout — the operator's tree?
 * @property {boolean} managed - Does it live under the console's state directory, i.e. did we make it?
 * @property {boolean} prunable - `worktree list` still prints a checkout whose directory is gone.
 * @property {number} [disk] - Bytes on disk, when `du` could answer. Managed trees only.
 * @property {string} [locked] - The `git worktree lock` reason, when the tree is locked. An EMPTY string
 *   is a real answer — git allows a lock with no reason — and a different one
 *   from absent, which means the tree is not locked.
 */

/**
 * What two live branches would do to each other if they met.
 * @typedef {object} RadarPair
 * @property {string} a
 * @property {string} b
 * @property {import('../worktree-model.js').RadarState} state
 * @property {string[]} files - The files the verdict is about: the overlap, or the conflicted subset.
 * @property {string[]} [zones] - The clash zones this pair touches, when it touches any — files that merge
 *   CLEANLY and are wrong afterwards. Absent when it touches none, which is a
 *   different fact from a console with no radar.
 */

/**
 * One run's git situation, as the console observed it from outside.
 * @typedef {object} RunGitView
 * @property {string} at - When this was probed — the whole point of a cached view.
 * @property {string} [base] - The branch everything here is measured against: the root checkout's own.
 * @property {string} [branch] - The run branch, when the run has one.
 * @property {string} [workRoot] - The run's isolated checkout, when it has one.
 * @property {Divergence} [divergence] - Ahead/behind of `branch` vs `base`. Absent = could not ask.
 * @property {string[]} files - Files `branch` changed since it left `base`, capped.
 * @property {boolean} filesTruncated - Were there more than the cap? A list that silently stops is a lie.
 * @property {number} [disk] - Bytes the run's own checkout occupies.
 * @property {CheckoutEntry[]} checkouts - Every checkout of this repository, root included.
 * @property {RadarPair[]} radar - Pairwise verdicts over the live branches, worst first.
 */

/**
 * @typedef {object} RunDetail
 * @property {RunState | null} run
 * @property {RunState[]} history
 * @property {EtaEstimate | null} eta
 * @property {RunGitView | null} [git] - The branch probe's cached view, or `null`.
 *
 *   `null` is the ordinary answer and never an error: `service.runGit` reads the
 *   LIVE runner's cache and never probes on demand, so a shared-checkout run, a
 *   run nobody is driving and a run whose isolation was refused all report it.
 *   The surface says "shared checkout" rather than drawing an empty card.
 * @property {PhaseEta[]} [phaseEta] - One estimate per open lane. The REMAINDER is not here on purpose: the
 *   elapsed clock ticks in the browser, so a server-computed "time left" would
 *   be stale the instant it was serialised. See `server/service.ts`.
 *
 *   Optional for the same reason as `PlanDetail.eta` — an older server process
 *   under a newer client simply does not send it.
 * @property {LaneLiveness[]} [liveness] - One entry per live lane. Rides along for the same reason `eta` does: "is
 *   this lane working" is a question about ONE moment, and a second request
 *   could be answered against a different one.
 *
 *   Optional because an older server process under a newer client simply does
 *   not send it — read an absent array as "this server cannot tell you", never
 *   as "nothing is stalled".
 */

/**
 * @typedef {object} Evidence
 * @property {string} label
 * @property {string} body
 */

/**
 * @typedef {object} Approval
 * @property {string} id
 * @property {string} runId
 * @property {string} slug
 * @property {number | null} phase
 * @property {'gate' | 'tool' | 'verify' | 'question'} kind - `verify` is a question for a person, not a permission question; `question` is a relayed one (phase 14).
 * @property {string} title
 * @property {string} detail
 * @property {Evidence[]} evidence
 * @property {{
 *   name: string;
 *   input?: { command?: string; [key: string]: unknown };
 *   cwd?: string;
 * }} [tool]
 * @property {string} [suggestedRule]
 * @property {string | null} [matched] - The ask rule that matched the call, or null when none did. Absent before 5.0.0.
 * @property {{
 *   key: string;
 *   rule: string;
 *   value: string;
 *   source: string;
 *   answer: 'allow' | 'deny' | null;
 *   why: string;
 *   branch?: string;
 *   bareForm?: string;
 * }} [manifest] - The plan's `permission.destructive` row this call was checked against
 *   (control-tower phase 84, #112): what it answered, and why — on a card a
 *   person must answer, why it did NOT cover this call.
 *   `answer`: `deny`: the row allows the push only in its bare form (`bareForm`) — answered at once, or by the manifest when an automatic actor settled the card (control-tower phase 107, #186); never on a card that waits.
 * @property {string} createdAt
 * @property {string} expiresAt
 * @property {string} [onTimeout] - What the card's timeout will do, said before it happens (control-tower phase 97, #140).
 * @property {string} [hookDeadline] - The hook call's hard limit: an Extend past it makes the card stand instead (#140).
 * @property {string} [standsUntil] - Set by an Extend past `hookDeadline`: the card stands until then (#140).
 * @property {{ at: string }} [converted] - The card outlived its hook call and stands — its session was told no at `at` (#140).
 * @property {string} status - `pending`, `allow`, `deny`, or — for a card a restart left — `unanswerable`.
 * @property {string} [decidedAt]
 * @property {string} [decidedBy]
 * @property {string} [reason]
 * @property {{ at: string; from: string }} [recovered] - A card the console restarted under and kept answerable.
 * @property {{ reason: string; detail: string }} [unanswerable] - Why a recovered card can no longer be answered.
 * @property {{
 *   mechanism: string;
 *   tool: string;
 *   items: {
 *     key: string;
 *     question: string;
 *     header?: string;
 *     options: { label: string; description?: string }[];
 *     multiSelect: boolean;
 *   }[];
 *   answers: Record<string, { label: string; by: string; at: string; ruleId?: string; who?: string }>;
 *   deferred?: { toolUseId: string; at: string; why: string };
 * }} [question] - A relayed question's part (phase 14): the questions the call carries, the
 *   answers so far and who gave them, and — when the console went away with the
 *   window open — the deferral that keeps the call for its session's resume.
 */

/**
 * What answering a relayed question reports (`POST /api/run/:slug/answer`).
 * @typedef {object} AnswerResult
 * @property {boolean} ok
 * @property {string[]} [answered]
 * @property {number} [remaining]
 * @property {string} [error]
 */

/**
 * @typedef {object} DecideResult
 * @property {boolean} [ok]
 * @property {string} [error] - The rule can be refused while the card is still answered — both are reported.
 * @property {string} [wrote]
 * @property {string} [scope]
 */

/**
 * @typedef {object} RecoveryAction
 * @property {'recheck'
 * | 'closeout'
 * | 'resume'
 * | 'retry'
 * | 'skip'
 * | 'fix-agent'
 * | 'mcp-continue'
 * | 'continue-run'
 * | 'release'
 * | 'force-release'
 * | 'dismiss'} id
 * @property {string} label
 * @property {string} detail
 * @property {string} [mechanism] - How it acts: check | own-session | new-agent | run-control | claim | mcp.
 * @property {string | null} [flag] - Which console capability gates it (run | agent | writes), when one does.
 * @property {string} [recoveryClass] - Set on `fix-agent`: which agent briefing to launch.
 */

/**
 * @typedef {object} PhaseDiagnosis
 * @property {string} runId
 * @property {number} phase
 * @property {string} status
 * @property {(typeof import('../plan-vocab.js').BLOCKED_ON)[number] | null} blockedOn
 * @property {string} boardState
 * @property {string | null} said
 * @property {VerifySummary | null} verification
 * @property {string | null} verifiedIn - Where the commands ran, relative to the root — `.` when it is the root.
 * @property {{ ok: boolean; summary: string } | null} lint
 * @property {{
 *   at: string;
 *   ok: boolean;
 *   sessionId?: string;
 *   note?: string;
 * } | null} closeout
 * @property {string | null} sessionId
 * @property {boolean} resumable
 * @property {string | null} note
 * @property {string[]} workingTree
 * @property {string | null} lock
 * @property {RecoveryAction[]} actions
 * @property {{
 *   id: string;
 *   sub?: string;
 *   key: string;
 *   label: string;
 *   blurb: string;
 *   actor: 'machine' | 'person' | 'wait' | 'none' | string;
 *   why: string[];
 * } | null} situation - The classifier's word for the phase and why (`server/runner/situation.ts`); null when it could not read.
 * @property {string[]} [evidence] - The evidence it was decided from, as short lines. Absent on older servers.
 * @property {EvidenceProof} [proof] - Claimed versus evidenced for this phase, from the four facts on disk.
 *   Absent on a server from before Phase 4.
 * @property {PhaseLive} [live] - What is working this phase right now, if anything. Absent means nothing is.
 * @property {Ruling[]} [rulings] - THIS phase's rulings, from the whole ledger — not just this run's slice.
 */

/**
 * @typedef {object} TranscriptEntry
 * @property {number} seq
 * @property {string} at
 * @property {string} event
 * @property {Record<string, unknown>} data
 */

/**
 * One account a run may spend, and the five-hour headroom (percent) it must show first.
 * @typedef {object} AccountRequirement
 * @property {string} id
 * @property {number} minHeadroomPct
 */

/**
 * One manifest row as the door resolved it (`server/prelude.ts`).
 * @typedef {object} PreludeRow
 * @property {string} key
 * @property {string} value
 * @property {string} [owner] - absent where no owner is named (`server/prelude.ts` `PreludeRow.owner` is optional)
 * @property {string} state
 * @property {'yes' | 'no'} blocking
 * @property {string} source
 * @property {string} origin - Where the prelude got the row: the plan (or its twin), the launch form, or a shipped default.
 * @property {'accounts' | 'mcp' | 'credentials' | 'delivery' | 'verification' | 'trees' | 'git-strategy' | 'skill' | 'human-steps'} [probe] - Which probe judged it, for the probed rows.
 */

/**
 * One probe's answer — the word, the reason, the warnings when some but not all failed.
 * @typedef {object} ProbeVerdict
 * @property {ProbeStatus} status
 * @property {boolean} ok
 * @property {string} reason
 * @property {string[]} [warnings]
 * @property {unknown} [detail] - The probe's facts — for `verification`, a `VerificationDetail`.
 */

/**
 * A §Verification fragment the runner will not run on its own, and why (`VerifyNotRun`).
 * @typedef {object} VerificationItem
 * @property {string} text
 * @property {string} reason
 * @property {string} [fp] - The sha256 of the whole command — what an answer is bound to.
 * @property {boolean} [approvable] - One exact approval would make it run. Nothing destructive, off-machine or unparseable ever is.
 */

/**
 * One phase's verification review, as the fifth probe reports it (`runner/verify-review.ts`).
 * @typedef {object} VerificationReviewView
 * @property {number} phase
 * @property {'clear' | 'records' | 'may-ask' | 'asks' | 'parks'} verdict
 * @property {string} [park]
 * @property {string[]} runs
 * @property {VerificationItem[]} items
 * @property {VerificationItem[]} waived
 * @property {VerificationItem[]} setup
 * @property {string[]} missing
 */

/**
 * Probe 5's detail: every open phase's review, the run's scope, and the draft's answers resolved.
 * @typedef {object} VerificationDetail
 * @property {VerificationReviewView[]} reviews
 * @property {number[] | null} scope
 * @property {{
 *   approve: { fp: string; text: string }[];
 *   waive: { phase: number; fp: string; text: string }[];
 * }} [answers]
 */

/**
 * The run-start prelude (`GET /api/run/:slug/prelude`, and the body of a 409 at the start door).
 * @typedef {object} Prelude
 * @property {string} slug
 * @property {PreludeRow[]} rows
 * @property {Record<'accounts' | 'mcp' | 'credentials' | 'delivery', ProbeVerdict> & {
 *   verification?: ProbeVerdict;
 *   trees?: ProbeVerdict;
 *   'git-strategy'?: ProbeVerdict;
 *   'human-steps'?: ProbeVerdict;
 * }} probes - `verification` is absent from a console older than 2026-09-18; `trees`
 *   (probe 6, control-tower phase 40) and `git-strategy` (probe 7, phase 11)
 *   from one older than those phases. Their details are `TreesDetail` and
 *   `{ lines: GitStrategyLine[] }`.
 *   `'human-steps'`: The plan's own human steps, each proof run at the door (control-tower phase 44). Never blocks.
 * @property {{ key: string; why: string }[]} blocking
 * @property {string[]} waived
 * @property {string[]} acknowledged
 * @property {boolean} manifestPresent
 * @property {AccountRequirement[]} accounts
 * @property {{ policy: string; ids: string[]; held: string[]; missing: string[] }} credentials
 * @property {{ ok: boolean; channels: string[]; acknowledged: boolean }} delivery
 * @property {PreludeStep[]} [humanSteps] - The plan-declared human steps of the phases this run will drive — "this
 *   run will need you N times", asked at the door rather than at three in the
 *   morning. Absent from a console older than control-tower phase 44.
 * @property {RunForecastUsdView} [forecast] - What the run will likely cost (measured-console phase 23). Absent from a free or older console.
 * @property {string} at
 */

/**
 * One phase's dollar forecast (`server/analysis/forecast-usd.ts` `PhaseForecastUsd`) — always `estimated`.
 * @typedef {object} PhaseForecastUsdView
 * @property {number} [phase]
 * @property {number | null} usd - USD, or null when nothing prices the phase's model.
 * @property {'estimated' | 'unavailable'} word
 * @property {'forecast'} source
 * @property {number} sessions - Its size's expected sessions.
 * @property {'measured' | 'shipped'} sessionsBasis
 * @property {{
 *   usd: number | null;
 *   basis: 'measured' | 'shipped' | 'unavailable';
 *   samples: number;
 *   model: string;
 *   effort: string;
 *   kind: string;
 * }} perSession
 * @property {string} size
 */

/**
 * A run's dollar forecast: its phases', summed — a floor when any is unpriced.
 * @typedef {object} RunForecastUsdView
 * @property {number | null} usd
 * @property {'estimated' | 'unavailable'} word
 * @property {'forecast'} source
 * @property {PhaseForecastUsdView[]} phases
 * @property {number} unpricedPhases
 */

/**
 * One plan-declared step as the launch door lists it — its proof run at the door.
 * @typedef {object} PreludeStep
 * @property {number} phase
 * @property {import('../human-step-model.js').HumanStepKind} kind
 * @property {string} what
 * @property {import('../human-step-model.js').HumanStepWhere} where
 * @property {'pre-cleared' | 'needed' | 'unchecked'} state - `pre-cleared` — the proof already holds; `needed` — it does not; `unchecked` — it could not be run.
 * @property {{ url: string } | { command: string }} [open]
 * @property {string} [proof]
 * @property {string} [read] - What the proof answered at the door, in its own words.
 * @property {number} [windowMinutes]
 * @property {'host'} [autoOpen] - The plan's `auto-open: host` — opened on the machine at launch, once the door has shown its link.
 * @property {string} [credential]
 * @property {string} [due] - The watch ref it is `upcoming` until (control-tower phase 121).
 * @property {string} [item] - The open item that already asks for it — a launch before this one raised it (control-tower phase 139).
 */

/**
 * The manifest as `run.start` echoed it and the run stores it.
 * @typedef {object} ResolvedManifest
 * @property {Omit<PreludeRow, 'probe'>[]} decisions
 * @property {AccountRequirement[]} accounts
 * @property {Prelude['credentials']} credentials
 * @property {Prelude['delivery']} delivery
 * @property {Record<string, { status: string; reason: string }>} probes
 * @property {{ rows: string[]; by: string; at: string }} [overridden]
 * @property {string} at
 */

/**
 * One plan git line the chosen strategy will not honour (probe 7, #18) — `server/prelude.ts` `GitStrategyLine`.
 * @typedef {object} GitStrategyLine
 * @property {'branch' | 'worktrees' | 'checkout'} kind
 * @property {string} plan - What the plan says.
 * @property {string} run - What this run does instead.
 * @property {boolean} honourable - Whether `honour` can make the plan's line hold.
 * @property {number[]} [phases]
 */

/**
 * Probe 6's facts (control-tower phase 40) — `server/prelude.ts` `TreeFacts`.
 * @typedef {object} TreesDetail
 * @property {{ repo: string; branch: string; run: string; slug: string }[]} held
 * @property {boolean} isolated
 * @property {boolean | null} grantable - Could the console isolate this plan? `null` when that could not be asked.
 * @property {string} [refusal]
 */

/**
 * What a start or a settings change sends. Every field is checked server-side.
 * @typedef {object} RunSettings
 * @property {string} [model]
 * @property {string} [effort]
 * @property {Autonomy} [autonomy]
 * @property {number | null} [phaseBudgetUsd]
 * @property {number | null} [runBudgetUsd]
 * @property {Record<string, PhaseOptions>} [phaseOptions]
 * @property {string[]} [skills]
 * @property {string[]} [mcpServers] - MCP servers every phase of this run attaches, on top of the plan's own.
 * @property {McpPolicy} [mcpPolicy] - What a phase does when one of those will not connect. Absent = the preference.
 * @property {PermissionProfile} [permissionProfile]
 * @property {number[]} [onlyPhases]
 * @property {string} [resumeRunId]
 * @property {import('../run-lifecycle.js').GitMode} [gitMode] - Work on one plan-wide branch (`pe/<slug>`) instead of what is checked out.
 * @property {boolean} [openPr] - New-branch runs only: the final phase pushes and opens a PR.
 * @property {import('../worktree-model.js').IsolationMode} [isolation] - New-branch runs only: ask for a console-managed checkout of the branch.
 * @property {import('../orchestration-model.js').RunPriority} [priority] - The scan class. Absent means `normal`; also accepted by `settings`.
 * @property {string} [startAfter] - A plan slug to board after. Start-only — `settings` never reads it.
 * @property {boolean} [reviewEachPhase] - Launch a fresh reviewer session at each phase-finish. Absent means off.
 * @property {import('../run-lifecycle.js').ReviewerPolicy} [reviewerPolicy] - Whether a reviewer's changes-requested may hold dependents. Absent = no.
 * @property {boolean} [ultracode] - The standing ultracode licence in every prompt this run composes.
 * @property {import('../run-lifecycle.js').UltraReviewMode} [ultraReview] - When to run `claude ultrareview`. `off` is accepted on `settings`.
 * @property {boolean} [attachDefaultSkills] - Seed the machine's default skills into this run.
 * @property {boolean} [qa] - START only: turn the plan's QA gate on before the run begins.
 * @property {string} [accountId] - A registered account id, `default`, or `auto` (most 5-hour headroom).
 * @property {OnLimitPolicy} [onLimit] - What to do at the shared usage window.
 * @property {boolean} [autoRecover] - Heal auto-recoverable halts by launching the fix agent. Sticky on resume.
 * @property {boolean} [resumeOnRestart] - The prelude's required answers (phase 11, START only): how the run resumes
 *   after a console restart, whether the relay is armed, the accounts it may
 *   spend with their minimum headroom, the waived rows it acknowledges, and
 *   the one recorded way past a blocking row.
 * @property {RelayMode} [relay]
 * @property {AccountRequirement[]} [accounts]
 * @property {string[]} [acknowledgedWaivers]
 * @property {{ rows?: string[]; by?: string }} [manifestOverride]
 * @property {string} [qaModel] - The reviewer's own tier and failure budget — see `shared/run-settings.js`.
 * @property {string} [qaEffort]
 * @property {number} [qaMaxRounds]
 * @property {QaFixStrategy} [qaFixStrategy] - QA recovery's two: how a fix session boards, and what ONE round may spend.
 * @property {number | null} [qaRoundBudgetUsd]
 * @property {number | null} [ladderPerRunRungs] - The run's own ladder rung caps (#14): a whole number sets one, `null` clears it.
 * @property {number | null} [ladderPerPhaseRungs]
 */

/**
 * What a QA-recovery verb takes beside its phase — the fix session's own
 * settings, the reviewer's tier, and the loop's two stops.
 *
 * A subset of `RunSettings` rather than the whole of it, and deliberately: a
 * recovery answers one verdict on one phase, so it carries nothing about the
 * run's git strategy, its parallelism or its scope. Naming the subset here is
 * what stops a card from posting a field the recovery door does not read.
 *
 * `strategy`: Which strategy this loop's FIX sessions use. Absent lets the run decide.
 * @typedef {Pick<
 *   RunSettings,
 *   | 'model'
 *   | 'effort'
 *   | 'accountId'
 *   | 'onLimit'
 *   | 'permissionProfile'
 *   | 'skills'
 *   | 'mcpServers'
 *   | 'mcpPolicy'
 *   | 'attachDefaultSkills'
 *   | 'qaModel'
 *   | 'qaEffort'
 *   | 'qaMaxRounds'
 *   | 'qaFixStrategy'
 *   | 'qaRoundBudgetUsd'
 * > & {
 *   strategy?: QaFixStrategy;
 *   by?: string;
 * }} QaRecoverSettings
 */

/**
 * The on-limit policies a run can carry. `wait` is the pre-accounts behavior.
 * @typedef {import('../run-lifecycle.js').OnLimitPolicy} OnLimitPolicy
 */

/**
 * The wait axis's reason — `shared/status-vocab.js` owns the words; this copy once held two of the four (LFC-5).
 * @typedef {import('../status-vocab.js').WaitReason} WaitReason
 */

/**
 * `{ run }` — every mutating run endpoint answers in this envelope.
 * @typedef {object} RunEnvelope
 * @property {RunState | null} run
 * @property {string[]} [preflight] - Start only: phases whose §Verification would park at boarding — advisory.
 * @property {string} [error]
 * @property {PressLaunch} [launched] - A person's press (retry, closeout, resume-phase, delegate): what it launched — only when the phase boarded at that admission.
 * @property {PressQueued} [queued] - …or what it QUEUED instead (control-tower phase 86, RS-5): a re-board is a hint, and a hint is not a launch.
 * @property {string} [rulingId] - Delegate only: the `deviation` ruling it wrote on the plan's ledger.
 */

/**
 * What a person's press launched (control-tower phase 53, #54–#56) — the answer
 * a verb gives instead of 200-and-nothing. `session` is the session it resumed,
 * or `null` when it boarded a FRESH one with the resume brief, and `why` says
 * why the phase's own session was not resumed.
 * @typedef {object} PressLaunch
 * @property {string} runId
 * @property {number} phase
 * @property {string | null} session
 * @property {string} brief
 * @property {string} [why]
 */

/**
 * What a press queued rather than boarded (control-tower phase 86, RS-5): the
 * same account, plus its 1-based place in line — null when the loop decided
 * nothing in time to say — and what it waits behind.
 * @typedef {PressLaunch & {
 *   position: number | null;
 *   behind?: { kind: string; slug: string; phase: number | null; owner: string };
 * }} PressQueued
 */

/**
 * @typedef {object} AskResult
 * @property {boolean} ok
 * @property {boolean} [repeated] - The browser's own retry landed twice; the server saw the key and said so.
 * @property {string} [error] - never sent by the server (`runner/runner-core.ts` `AskResult`): a refusal's words are `reason`
 * @property {string} [reason] - Why it was refused (the 409's body).
 * @property {string} [mark] - Correlates the console's line, the CLI's echo and the session's reply.
 * @property {boolean} [unreachable] - Refused because the phase's session is LIVE but cannot take input (control-tower phase 109, #170).
 */

/**
 * One person's note on a run (control-tower phase 96, #142) — the wire shape
 * of `server/runner/state.ts` `RunNote`. A PINNED note is a standing decision:
 * shown on the run page and read into the boot prompt of every phase it
 * applies to, until somebody unpins it. Both editions: the route and the
 * record are free, so the types stay outside the Pro region below.
 * @typedef {object} RunNote
 * @property {string} id
 * @property {string} at
 * @property {string} by
 * @property {string} text
 * @property {boolean} pinned
 * @property {number} [phase] - The phase it is about; absent for the whole run.
 */

/**
 * @typedef {object} RunNoteResult
 * @property {RunNote} note
 * @property {RunState} run
 */


/**
 * The recovery facts of one phase the run has not settled well — what
 * `haltCtx` reads off a record (`shared/halt-view.js`), so a slim row answers
 * the halt view's recommended verb the way the whole record does (quiet-console
 * phase 7, #278). Never a session id: only whether one exists.
 * @typedef {object} SlimPhaseFacts
 * @property {boolean} resumable
 * @property {{ key: string } | null} situation
 */

/**
 * One run in the slim projection (`server/runs-projection.ts`, its
 * `SLIM_RUN_FIELDS`) — what `?view=slim` lists and `?latest=1&slug=` answers
 * for a strip, and what the Runs home folds its groups from (7.0, #234): the
 * status and its lifecycle, the halt, the processes and lanes the run holds,
 * ONE WORD per phase where the whole record carries every attempt, rung and
 * note of every phase, and the glance facts — what it spent and may spend,
 * what it worked, who stopped it, what holds it. The home reads a whole
 * record only for the row a person opened (`useRun`).
 * @typedef {object} SlimRun
 * @property {string} id
 * @property {string} slug
 * @property {RunState['status']} status
 * @property {import('../run-lifecycle.js').RunLifecycle} lifecycle
 * @property {number | null} activePhase
 * @property {RunState['halt']} halt
 * @property {NonNullable<RunState['children']>} children
 * @property {NonNullable<RunState['verifying']>} verifying
 * @property {LaneLiveness[]} liveness
 * @property {Record<string, PhaseRecord['status']>} phases
 * @property {Record<string, SlimPhaseFacts>} records
 * @property {string | null} waitUntil
 * @property {string | null} accountId
 * @property {number} consecutiveFailures
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string | null} finishedReason
 * @property {boolean} resolved
 * @property {'operator' | 'system' | null} stoppedBy
 * @property {OnLimitPolicy | null} onLimit
 * @property {WaitReason | null} waitReason
 * @property {NonNullable<RunState['hold']> | null} hold
 * @property {RunState['freeze']} freeze
 * @property {RunState['pause']} pause
 * @property {number} spentUsd - Booked spend; `liveUsd` is what the sessions in flight have cost so far, booked when each ends.
 * @property {number} liveUsd
 * @property {number | null} runBudgetUsd
 * @property {number | null} workedMs - Wall-clock the phases worked for, freezes subtracted; null when nothing ran.
 * @property {string} model
 * @property {string | null} effort
 * @property {number} maxConsecutiveFailures
 * @property {NonNullable<RunState['undriven']>} undriven - The phases the board reads in progress that nothing of this run drives (#114) — empty unless live.
 */

/**
 * A CI run GitHub never started, as the watch row carries it (`server/watch-refs.ts` `CiNotRun`).
 * @typedef {object} CiNotRunView
 * @property {string} cause
 * @property {string} repo
 * @property {string} run
 * @property {number} [attempt]
 * @property {number} jobs
 * @property {string} annotation
 * @property {Array<{
 *   scope: 'repository' | 'organization';
 *   name: string;
 *   amount: number;
 *   consumed: number;
 *   stops: boolean;
 * }>} [budgets]
 * @property {string} [unreadable]
 * @property {boolean} [headroom]
 */

/* ------------------------------------------------------------------ *
 * What the open directory's runs measured (quiet-console phase 25) —
 * Insights and the run view's Verification section draw them (phase 26)
 * ------------------------------------------------------------------ */

/**
 * A session cap and where its number came from.
 * @typedef {object} SessionCap
 * @property {number} value
 * @property {string} source
 * @property {string} [basis]
 * @property {{
 *   basis: string;
 *   percentile: number;
 *   headroom: number;
 *   samples: number;
 *   from: string | null;
 *   to: string | null;
 *   observed: number;
 * }} [derivation]
 */

/**
 * Caps by session mode — a mode this console has not measured takes the shipped table's.
 * @typedef {object} SessionCapTable
 * @property {Record<string, { turns?: SessionCap; usd?: SessionCap }>} modes
 * @property {string | null} derivedAt
 */

/**
 * Sessions per phase of one size, measured or shipped.
 * @typedef {object} SessionsPerPhase
 * @property {number} noWrap
 * @property {number} wraps
 * @property {number} wrapRate
 * @property {number} expected
 * @property {number} phases
 * @property {string} basis
 */

/**
 * What a session may spend: the measured caps beside the shipped ones, the context model, sessions per phase.
 * @typedef {object} SessionSizing
 * @property {string | null} derivedAt - Null until this console's first read of its own sessions lands — every answer is then the shipped one.
 * @property {{
 *   measured: SessionCapTable | null;
 *   shipped: SessionCapTable;
 *   phase: { turns: SessionCap; usd: SessionCap };
 * }} caps
 * @property {{
 *   basis: string;
 *   boot: number;
 *   bootMeasured: { tokens: number; samples: number; min: number; max: number } | null;
 *   work: number;
 *   floor: number;
 *   slope: number;
 *   samples: number;
 *   sizes?: { size: string; weight: number; medianPeak: number; samples: number; ratio: number }[];
 * }} context - The context model: a session peaks near `floor` (its boot plus its work) plus `slope` × its weight.
 *   `bootMeasured`: The boot this repository measured, with its evidence; null while the shipped floor stands.
 *   `sizes`: Per size: the median peak, and that median over the model at the size's weight — near 1 is the claim.
 * @property {string} bootLine
 * @property {Record<'S' | 'M' | 'L', SessionsPerPhase>} sessions
 */

/**
 * One estimator's back-test score: the share within ×2 of the truth, and the mean |log| error (MALE).
 * @typedef {object} EtaScore
 * @property {number} n
 * @property {number} male
 * @property {number} within2
 * @property {number} medianRatio
 * @property {number} over2
 * @property {number} under2
 */

/**
 * The week's measurements, each summed and rounded by the server (`server/analysis/week-report.ts`).
 * @typedef {object} WeekMetrics
 * @property {{
 *   runs: { slug: string; run: string; lifeHours: number; downHours: number; share: number }[];
 *   lifeHours: number;
 *   downHours: number;
 *   share: number;
 *   endedBy: Record<'person' | 'console' | 'wait-clock' | 'open', number>;
 * }} down - The share of each run's working life it spent stopped, and the hours each kind of press ended.
 * @property {{ hours: number; byCause: Record<'streak' | 'lint-crash' | 'credential-latch', number> }} avoidable - Stopped time today's rules would not have stopped for.
 * @property {{
 *   total: number;
 *   flagged: number;
 *   byCause: Record<'rescued-command' | 'repeated-phase' | 'wait-budget', number>;
 * }} streakHalts
 * @property {{ halts: number; fromRescued: number }} verifyFailed
 * @property {{
 *   sessions: number;
 *   bookedUsd: number;
 *   finalUsd: number;
 *   phantomUsd: number;
 *   phantomShare: number;
 *   mismatched: number;
 * }} spend - What the ledger booked against the CLI's own final total per session.
 * @property {{
 *   episodes: number;
 *   episodeHours: number;
 *   recordedHours: number;
 *   recordedShare: number;
 *   ownRunHours: number;
 *   ownRunShare: number;
 *   serialHours: number;
 * }} queue
 * @property {{
 *   waits: number;
 *   medianRealisedOverLabel: number;
 *   errorAtMedian: number;
 *   medianLowOverRealised: number;
 *   lowCoverage: number;
 *   bandCoverage: number;
 * }} holderEta - The holder label a queue card showed, against the wait that followed.
 * @property {{ records: number; estimator: EtaScore | null; baseline: EtaScore; ships: boolean | null }} phaseEta - The phase ETA back-test: `estimator` is null when the shown estimate was not journalled.
 * @property {{ count: number; bySignal: Record<string, number> }} stallsOnFinished
 * @property {{ maxTurnsEndings: number; underCloseoutCap: number }} closeoutCapResumes
 * @property {{ count: number; phases: { slug: string; run: string; phase: number }[] }} unrunVerification
 * @property {{ starts: number; differs: number }} modelNamed
 * @property {{
 *   sessions: number;
 *   calls: number;
 *   cacheReadMTokens: number;
 *   meanContextK: number;
 *   bootShare: number | null;
 *   bootMeasured: number;
 * }} context - What re-reading the context cost; `bootShare` is null when no session measured its boot.
 */

/**
 * The week in numbers: the report, its ETA backtest (`metrics.phaseEta`) and its holder ETA (`metrics.holderEta`).
 * @typedef {object} WeekReportAnswer
 * @property {{
 *   instance: string;
 *   since: string;
 *   until: string;
 *   replay: string[];
 *   metrics: WeekMetrics;
 *   targets: { id: string; target: string; value: string; met: boolean | null }[];
 * }} report - `replay`: The models re-derived with today's rules; empty when the report was not replayed.
 *   `targets`: Each acceptance target judged on these numbers — `met: null` when there was nothing to judge.
 * @property {string} readAt
 * @property {boolean} cached - The same question asked inside five minutes is answered from memory.
 */

/**
 * The last proof of one command a session recorded, and the tree it ran against.
 * @typedef {object} RunProof
 * @property {number} phase
 * @property {string} command
 * @property {number} code
 * @property {string} tree
 * @property {string} [head]
 * @property {string} at
 * @property {string} [session]
 */

/**
 * @typedef {object} RunProofs
 * @property {string} slug
 * @property {number | null} phase
 * @property {RunProof[]} proofs
 */

/**
 * One run of one §Verification line — a verdict, or the baseline it was compared with.
 * @typedef {object} RunVerification
 * @property {number} phase
 * @property {string} run
 * @property {string} at
 * @property {'verify' | 'baseline'} kind
 * @property {string} command
 * @property {string} [chain]
 * @property {number} code
 * @property {number} ms
 * @property {boolean} ok
 * @property {boolean} [timedOut]
 * @property {string[]} [failures]
 * @property {string} [tail]
 * @property {string} [environment]
 * @property {string[]} [own]
 */

/**
 * @typedef {object} RunVerifications
 * @property {string} slug
 * @property {RunVerification[]} rows - Newest first.
 * @property {number} total - How many matched before `limit` cut them.
 * @property {number} limit
 */


/* ---------------- the routes' own answers ----------------
 * The envelopes and one-off answers of the run, lane, lock and automation
 * routes, named so each route has one — every field read off the handler in
 * `server/api/routes.ts` and the service method it calls. */

/**
 * `GET /api/runs` — every run, whole; or, with `?view=slim` or `?latest=1`
 * (`&slug=`), the slim projection (`server/runs-projection.ts`). Each whole
 * run carries `undriven` and its live `verifying` lanes.
 * @typedef {RunState[] | SlimRun[]} RunList
 */

/**
 * `GET /api/run/:slug/journal[/:id]` — the run's journal lines, oldest first; `[]` when the plan never ran.
 * @typedef {JournalEntry[]} RunJournal
 */

/**
 * `GET /api/run/:slug/transcript[/:id]` — the session replay, read from the end.
 * @typedef {TranscriptEntry[]} RunTranscript
 */

/**
 * `GET /api/run/:slug/scopes` — each phase's scope (its Repos cell) and what it
 * would collide with if started right now.
 * @typedef {{ scopes: import('./state.js').PhaseScope[] }} RunScopes
 */

/**
 * `GET /api/run/:slug/prelude` — the run-start prelude for the launch form's draft.
 * @typedef {{ prelude: Prelude }} PreludeAnswer
 */

/**
 * `GET /api/run/:slug/rulings` — the PLAN's whole ruling ledger, oldest first.
 * @typedef {{ rulings: Ruling[] }} RulingList
 */

/**
 * `GET /api/run/:slug/wait?for=…&timeout=…` — the long poll (control-tower
 * phase 98, #137 item 4): whether `for` held before the timeout, how long it
 * waited, and the plan's newest run, slim (`server/service-runs.ts` `WaitAnswer`).
 * @typedef {object} RunWaitAnswer
 * @property {boolean} held
 * @property {boolean} timedOut
 * @property {string} for
 * @property {number} waitedMs
 * @property {SlimRun | null} run
 */

/**
 * `GET /api/run/:slug/triggers` — the plan's stored triggers, armed first.
 * @typedef {{ triggers: StoredTrigger[] }} TriggerList
 */

/**
 * `POST /api/run/:slug/triggers` and `…/triggers/:id/cancel` — the trigger as stored now.
 * @typedef {{ trigger: StoredTrigger }} TriggerAnswer
 */

/**
 * What cancelling a trigger takes: why, if anyone said.
 * @typedef {{ reason?: string }} TriggerCancelBody
 */

/**
 * `POST /api/run/:slug/rulings/:id/remember` — the standing answer the ruling
 * became: where it was written (`scope`), the key and value, and whether the
 * ruling was acked in the same breath (`server/service.ts` `rememberRuling`).
 * @typedef {object} RulingRememberAnswer
 * @property {true} ok
 * @property {'plan' | 'global' | 'rule'} scope
 * @property {string} key
 * @property {string} value
 * @property {boolean} ack
 * @property {string} detail
 */

/**
 * What remembering a ruling takes.
 * @typedef {{ scope: 'plan' | 'global' | 'rule' }} RulingRememberBody
 */

/**
 * `POST /api/run/:slug/resume` — the run, and which of the two it did
 * (control-tower phase 77, #102): took back a pause not yet reached, or started
 * a settled pause again — or, since control-tower phase 110 (#176), a parked,
 * halted or interrupted run (`server/service-runs.ts` `ResumeAnswer`).
 * @typedef {RunEnvelope & {
 *   resumed?: {
 *     runId: string;
 *     from: 'pausing' | 'paused' | 'parked' | 'halted' | 'interrupted';
 *     act: 'pause-cancelled' | 'relaunched';
 *   };
 * }} RunResumeAnswer
 */

/**
 * `POST /api/run/:slug/identity` — a person's answer to an identity park
 * (control-tower phase 91, #131), and the account the run moved to.
 * @typedef {RunEnvelope & { accountId?: string }} RunIdentityAnswer
 */

/**
 * What an identity answer takes: `continue` on the new login, or `move` to an account.
 * @typedef {{ choice: 'continue' | 'move'; accountId?: string }} RunIdentityBody
 */

/**
 * `POST /api/run/:slug/run-request` — a phase's run request answered
 * (turn-by-turn phase 6, #286), as the human-steps verbs answer
 * (`server/human-steps.ts` `StepVerbResult`): `ok`, and the step it moved when
 * it moved one, beside whatever else the verb reports.
 * @typedef {{ ok: true; step?: import('./turn.js').HumanStepRecord; [key: string]: unknown }} RunRequestAnswer
 */

/**
 * What a run-request answer takes; `expectRunId` binds it to the run it was raised for.
 * @typedef {{ phase: number; answer: 'approve' | 'deny'; note?: string; act?: string; expectRunId?: string }} RunRequestBody
 */

/**
 * `POST /api/run/:slug/switch-account` — the switch, or with `dry` its preview
 * (`server/service-runs.ts` `switchAccountRun`): the lanes it checkpointed (or
 * would), the phases deferred to their boundary, the sessions re-keyed.
 * @typedef {object} SwitchAccountAnswer
 * @property {boolean} ok
 * @property {string} [reason]
 * @property {RunState | null} [run]
 * @property {number} [checkpointed]
 * @property {number[]} [deferred]
 * @property {number} [rekeyed]
 * @property {number[]} [wouldCheckpoint] - `dry` only: the live lanes the switch would checkpoint now (#107 ask 2).
 * @property {true} [dry]
 * @property {string} [to]
 */

/**
 * What a switch takes: the account (`auto` picks), when, and whether only to preview.
 * @typedef {{ accountId?: string; when?: 'now' | 'boundary'; dry?: boolean }} SwitchAccountBody
 */

/**
 * What a note takes: a new note's text, or a pin change by `id`.
 * @typedef {{ text?: string; pinned?: boolean; phase?: number; id?: string }} RunNoteBody
 */

/**
 * `POST /api/run/:slug/raise-budget` — the budget that stopped the work,
 * raised where it was declared, and whether the phase was retried
 * (control-tower phase 14, #40).
 * @typedef {object} RaiseBudgetAnswer
 * @property {true} ok
 * @property {import('../budget-model.js').BudgetKind} budget
 * @property {number | null} phase
 * @property {number} was
 * @property {number} now
 * @property {boolean} retried
 * @property {RunState | null} run
 */

/**
 * What a raise takes: `add` in the budget's own unit, or `to`.
 * @typedef {{ budget: import('../budget-model.js').BudgetKind; phase?: number; add?: number; to?: number; scope?: 'phase' | 'plan' }} RaiseBudgetBody
 */

/**
 * `POST /api/run/:slug/clear-streak` — the run, and what the streak was.
 * @typedef {RunEnvelope & { was: number }} ClearStreakAnswer
 */

/**
 * `POST /api/run/:slug/retry` — a press's answer; or, for a LIVE phase
 * (measured-console phase 13, #424), the addendum delivered to its session as
 * a message (`server/service-runs.ts` `RetryAnswer`).
 * @typedef {RunEnvelope & {
 *   delivered?: 'message';
 *   message?: { id: string; state: string; via: string; to: string };
 * }} RunRetryAnswer
 */

/**
 * What Retry takes: the phase, and — Retry with edits — the one attempt's words and settings.
 * @typedef {RetryEdits & { phase: number; expectRunId?: string }} RunRetryBody
 */

/**
 * `POST /api/run/:slug/recover` — what the plan-wide Recover did
 * (`server/service-runs.ts` `recoverPlan`). `waiting`, `pid` and `sessionId`:
 * an orphan still working (#21 §2) — the server sends them; the client had not
 * named them.
 * @typedef {object} RecoverAnswer
 * @property {'running' | 'waiting' | 'resumed' | 'recovering' | 'errand' | 'nothing-to-do'} outcome
 * @property {string} detail
 * @property {string[]} steps
 * @property {RunState | null} run
 * @property {Errand} [errand] - The one ask for a person, when the outcome is `errand`.
 * @property {number} [pid] - The orphan still working, when the outcome is `waiting`.
 * @property {string | null} [sessionId]
 */

/**
 * `POST /api/run/:slug/verify-command` — the terminal session the command re-runs in, and its token.
 * @typedef {{ ok: true; sessionId: string; token: string; expiresAt: number }} VerifyCommandAnswer
 */

/**
 * What re-running one verification command takes.
 * @typedef {{ phase: number; command: string }} VerifyCommandBody
 */

/**
 * `POST /api/run/:slug/ultrareview` — one cloud review of the run's branch, and
 * its own result: a review that could not happen is `unknown` with its reason,
 * never "nothing found".
 * @typedef {object} UltraReviewAnswer
 * @property {string} slug
 * @property {number} phase
 * @property {'landed' | 'unknown'} state
 * @property {string} [verdict]
 * @property {number} [findings]
 * @property {string} [reason]
 * @property {number} ms
 */

/**
 * `POST /api/run/:slug/errand-tree` — the stable checkout at the pushed run
 * branch for a phase's errand (#123), and whether an existing one was adopted.
 * @typedef {{ tree: NonNullable<PhaseRecord['errandTree']>; adopted: boolean }} ErrandTreeAnswer
 */

/**
 * `POST /api/run/:slug/verify-waive` — the waiver written, and the run.
 * @typedef {{ waiver: VerifyWaiver; run: RunState }} VerifyWaiveAnswer
 */

/**
 * What waiving one §Verification line takes.
 * @typedef {{ phase: number; line: string; reason: string; expectRunId?: string }} VerifyWaiveBody
 */

/**
 * `POST /api/run/:slug/plan-approval` — the decision recorded on the plan's sha.
 * @typedef {{ ok: true; decision: 'approve' | 'reject'; sha: string }} PlanDecisionAnswer
 */

/**
 * What a plan decision takes.
 * @typedef {{ phase: number; decision: 'approve' | 'reject'; reason?: string }} PlanDecisionBody
 */

/**
 * What a press that names a phase takes (recheck, closeout, resume-phase, delegate, board-at-boundary, skip, isolate-phase, errand-tree, errand-answered).
 * @typedef {{ phase: number; instruction?: string; note?: string; choice?: string; expectRunId?: string }} PhasePressBody
 */

/**
 * What the per-session controls take (pause, hold, freeze, thaw, stop): the lane, when more than one runs.
 * @typedef {{ phase?: number; by?: string; expectRunId?: string }} RunControlBody
 */

/**
 * What resolve and unresolve take: the run whose card it is.
 * @typedef {{ runId: string; note?: string }} RunResolveBody
 */

/**
 * What an ask or a steer takes; `key` is the browser's idempotency key.
 * @typedef {{ question?: string; instruction?: string; key?: string; phase?: number }} AskBody
 */

/**
 * What answering a relayed question takes.
 * @typedef {{ approvalId: string; answers: { key: string; label: string }[] }} AnswerBody
 */

/**
 * What a QA-recovery verb takes: the phase, and the loop's own settings.
 * @typedef {QaRecoverSettings & { phase: number }} QaRecoverBody
 */

/* ---- lanes, locks and the boot hold ---- */

/**
 * `POST /api/lane/pin|unpin|reserve|unreserve` — the queue after the mark, the
 * change it made and, on a Pro console, the queue rules' verdict on it.
 * @typedef {import('./state.js').QueueSnapshot & {
 *   change: { verb: string; slug: string; phase: number | null; changed: boolean };
 *   verdict?: unknown;
 * }} LaneMarkAnswer
 */

/**
 * `POST /api/lane/yield` — the queue after the hand-over, and where the lane
 * went (`server/service-runs.ts` `yieldLane`).
 * @typedef {import('./state.js').QueueSnapshot & {
 *   yield: { ok: true; to: { slug: string; phase: number } | null; steered: boolean; why?: string };
 * }} LaneYieldAnswer
 */

/**
 * What a lane verb takes: the lane, the words it is written down with, and (yield) where it goes.
 * @typedef {{ slug: string; phase: number; reason?: string; to?: string | { slug: string; phase: number } }} LaneBody
 */

/**
 * `GET /api/automation/hold` — whether this console booted holding its automation.
 * @typedef {{ bootHold: import('./state.js').BootHold | null }} BootHoldView
 */

/**
 * `POST /api/automation/hold/release` — the hold released (the held re-adoption
 * and convergence run now), what it was, and the hold now.
 * @typedef {object} BootHoldRelease
 * @property {boolean} ok
 * @property {string} [reason]
 * @property {import('../ops-vocab.js').BootHoldKind} [was]
 * @property {import('./state.js').BootHold | null} bootHold
 */

/**
 * `GET /api/locks` — every lock claim this console can see, worst first (#24).
 * @typedef {{ rows: import('./sessions.js').LockRow[] }} LockRows
 */


/**
 * `POST /api/locks/release` — one claim's release, or with `{expired: true}`
 * every stale one, a result each.
 * @typedef {import('./plans.js').LockRelease | { results: import('./plans.js').LockRelease[]; released: number }} LockReleaseAnswer
 */

/**
 * What a release takes: one claim, or every stale one.
 * @typedef {{ slug?: string; phase?: number; force?: boolean; expired?: true }} LockReleaseBody
 */


/**
 * Every route this family owns → the typedef its response is (and, for a write, the one it takes).
 * @type {Readonly<Record<string, { response: string, body?: string }>>}
 */
export const WIRE_ROUTES = Object.freeze({
  'POST /api/lane/pin': { response: 'LaneMarkAnswer', body: 'LaneBody' },
  'POST /api/lane/unpin': { response: 'LaneMarkAnswer', body: 'LaneBody' },
  'POST /api/lane/reserve': { response: 'LaneMarkAnswer', body: 'LaneBody' },
  'POST /api/lane/unreserve': { response: 'LaneMarkAnswer', body: 'LaneBody' },
  'POST /api/lane/yield': { response: 'LaneYieldAnswer', body: 'LaneBody' },
  'POST /api/lane/isolate': { response: 'RunEnvelope', body: 'LaneBody' },
  'POST /api/lane/isolate-phase': { response: 'RunEnvelope', body: 'LaneBody' },
  'GET /api/automation/hold': { response: 'BootHoldView' },
  'POST /api/automation/hold/release': { response: 'BootHoldRelease' },
  'GET /api/locks': { response: 'LockRows' },
  'POST /api/locks/release': { response: 'LockReleaseAnswer', body: 'LockReleaseBody' },
  'GET /api/runs': { response: 'RunList' },
  'GET /api/run/:slug': { response: 'RunDetail' },
  'GET /api/run/:slug/journal': { response: 'RunJournal' },
  'GET /api/run/:slug/timeline': { response: 'RunTimeline' },
  'GET /api/run/:slug/attempts/:phase': { response: 'PhaseAttempts' },
  'GET /api/run/:slug/ledger': { response: 'RunLedger' },
  'GET /api/run/:slug/phase/:phase/activity': { response: 'PhaseActivity' },
  'GET /api/run/:slug/phase/:phase/report': { response: 'PhaseReport' },
  'GET /api/run/:slug/transcript': { response: 'RunTranscript' },
  'GET /api/run/:slug/diagnosis/:phase': { response: 'PhaseDiagnosis' },
  'GET /api/run/:slug/scopes': { response: 'RunScopes' },
  'GET /api/run/:slug/prelude': { response: 'PreludeAnswer' },
  'GET /api/run/:slug/rulings': { response: 'RulingList' },
  'GET /api/run/:slug/wait': { response: 'RunWaitAnswer' },
  'GET /api/run/:slug/plan-text': { response: 'PlanText' },
  'GET /api/run/:slug/triggers': { response: 'TriggerList' },
  'GET /api/run/:slug/proofs': { response: 'RunProofs' },
  'GET /api/run/:slug/verifications': { response: 'RunVerifications' },
  'POST /api/run/:slug/rulings/:id/remember': {
    response: 'RulingRememberAnswer',
    body: 'RulingRememberBody',
  },
  'POST /api/run/:slug/phase/:n/errand-answered': { response: 'RunEnvelope', body: 'PhasePressBody' },
  'POST /api/run/:slug/start': { response: 'RunEnvelope', body: 'RunSettings' },
  'POST /api/run/:slug/ask': { response: 'AskResult', body: 'AskBody' },
  'POST /api/run/:slug/steer': { response: 'AskResult', body: 'AskBody' },
  'POST /api/run/:slug/answer': { response: 'AnswerResult', body: 'AnswerBody' },
  'POST /api/run/:slug/pause': { response: 'RunEnvelope', body: 'RunControlBody' },
  'POST /api/run/:slug/resume': { response: 'RunResumeAnswer', body: 'RunControlBody' },
  'POST /api/run/:slug/identity': { response: 'RunIdentityAnswer', body: 'RunIdentityBody' },
  'POST /api/run/:slug/run-request': { response: 'RunRequestAnswer', body: 'RunRequestBody' },
  'POST /api/run/:slug/hold': { response: 'RunEnvelope', body: 'RunControlBody' },
  'POST /api/run/:slug/release': { response: 'RunEnvelope', body: 'RunControlBody' },
  'POST /api/run/:slug/switch-account': { response: 'SwitchAccountAnswer', body: 'SwitchAccountBody' },
  'POST /api/run/:slug/freeze': { response: 'RunEnvelope', body: 'RunControlBody' },
  'POST /api/run/:slug/thaw': { response: 'RunEnvelope', body: 'RunControlBody' },
  'POST /api/run/:slug/stop': { response: 'RunEnvelope', body: 'RunControlBody' },
  'POST /api/run/:slug/resolve': { response: 'RunEnvelope', body: 'RunResolveBody' },
  'POST /api/run/:slug/unresolve': { response: 'RunEnvelope', body: 'RunResolveBody' },
  'POST /api/run/:slug/notes': { response: 'RunNoteResult', body: 'RunNoteBody' },
  'POST /api/run/:slug/skip': { response: 'RunEnvelope', body: 'PhasePressBody' },
  'POST /api/run/:slug/raise-budget': { response: 'RaiseBudgetAnswer', body: 'RaiseBudgetBody' },
  'POST /api/run/:slug/clear-streak': { response: 'ClearStreakAnswer' },
  'POST /api/run/:slug/retry': { response: 'RunRetryAnswer', body: 'RunRetryBody' },
  'POST /api/run/:slug/recover': { response: 'RecoverAnswer' },
  'POST /api/run/:slug/verify-command': { response: 'VerifyCommandAnswer', body: 'VerifyCommandBody' },
  'POST /api/run/:slug/mcp-continue': { response: 'RunEnvelope' },
  'POST /api/run/:slug/qa-recover': { response: 'RunEnvelope', body: 'QaRecoverBody' },
  'POST /api/run/:slug/qa-rerun': { response: 'RunEnvelope', body: 'QaRecoverBody' },
  'POST /api/run/:slug/ultrareview': { response: 'UltraReviewAnswer' },
  'POST /api/run/:slug/recheck': { response: 'RunEnvelope', body: 'PhasePressBody' },
  'POST /api/run/:slug/board-at-boundary': { response: 'RunEnvelope', body: 'PhasePressBody' },
  'POST /api/run/:slug/triggers': { response: 'TriggerAnswer', body: 'TriggerArm' },
  'POST /api/run/:slug/triggers/:id/cancel': { response: 'TriggerAnswer', body: 'TriggerCancelBody' },
  'POST /api/run/:slug/closeout': { response: 'RunEnvelope', body: 'PhasePressBody' },
  'POST /api/run/:slug/resume-phase': { response: 'RunEnvelope', body: 'PhasePressBody' },
  'POST /api/run/:slug/repair-checkout': { response: 'RunEnvelope' },
  'POST /api/run/:slug/isolate': { response: 'RunEnvelope' },
  'POST /api/run/:slug/isolate-phase': { response: 'RunEnvelope', body: 'PhasePressBody' },
  'POST /api/run/:slug/errand-tree': { response: 'ErrandTreeAnswer', body: 'PhasePressBody' },
  'POST /api/run/:slug/verify-waive': { response: 'VerifyWaiveAnswer', body: 'VerifyWaiveBody' },
  'POST /api/run/:slug/delegate': { response: 'RunEnvelope', body: 'PhasePressBody' },
  'POST /api/run/:slug/plan-approval': { response: 'PlanDecisionAnswer', body: 'PlanDecisionBody' },
  'POST /api/run/:slug/settings': { response: 'RunEnvelope', body: 'RunSettings' },
});
