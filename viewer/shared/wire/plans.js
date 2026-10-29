/**
 * The wire of plans — the plan surface under `/api/plans/…`: the portfolio, one
 * plan projected, its handoffs, prompts, notes, gates, review, landing, QA
 * verbs and (Pro) its deferred-work ledger (measured-console phase 32).
 *
 * The plan shapes mirror `server/service-core.ts` (`PlanDetail`, `PhaseView`,
 * `RouteView`) and `server/analysis/stats.ts` (`PlanStats`). `state` and
 * `status` stay `string`: the engine owns that vocabulary, and narrowing it
 * here would turn an engine that learned a new word into a type error in the
 * client instead of a chip that paints grey. `asPhaseState()` does the
 * narrowing at the point of paint.
 *
 * Also the home of four shapes other families' routes answer with, because
 * the plan surface's client file declared them first: `EngineQueue`
 * (`GET /api/engine`), `WriteRequest`/`WriteResult` (`POST /api/write`) and
 * `LockRelease` (`POST /api/locks/release`).
 */

/**
 * One row of `GET /api/plans`. Loose on purpose: the portfolio reads a handful
 * of fields and the rest travel under the index signature. `status` and
 * `closed` are named explicitly — the index signature types the rest
 * `unknown`, and closure is read by the nav counts, which cannot cast their
 * way to it.
 * @typedef {{ slug: string; title?: string; kind?: string; phases: number; ready: unknown[]; status?: string; closed?: boolean; [key: string]: unknown }} PlanSummary
 */
/** @typedef {PlanSummary[]} PlanList */

/**
 * @typedef {object} HealthIssue
 * @property {string} slug
 * @property {(typeof import('../ops-vocab.js').HEALTH_SEVERITIES)[number]} severity
 * @property {string} kind
 * @property {string} message
 * @property {number} [phase]
 */

/**
 * @typedef {object} PhaseLock
 * @property {number} [phase]
 * @property {string} owner
 * @property {boolean} expired
 * @property {number} [leaseUntil]
 * @property {string} [host]
 * @property {number} [claimedAt] - when the claim was taken — the other half of "how long has this been held?"
 * @property {string[]} [scope] - what the claim covers; absent is the WIDEST scope (the engine treats it as colliding with everything), not "no scope"
 * @property {string} [session] - the claiming session's own id — joins a claim to the registry and ptys
 */

/**
 * @typedef {object} PlanSummaryFull
 * @property {string} slug
 * @property {string} title
 * @property {string} kind
 * @property {string} [status]
 * @property {boolean} [closed] - terminal status, so no work and no warnings; read it through `lib/closure.ts`'s `isClosed()`. `ready`, `locks`, `qaFailures` and `stuck` stay populated on a closed plan by design
 * @property {string} [closedOn] - the date `close-plan.sh` recorded, when it was closed through the verb
 * @property {string} [closedReason]
 * @property {string} [created]
 * @property {string} [startedAt] - when work on the plan began — its runs' earliest boarding, ISO with time (#28)
 * @property {number} [spanMs] - from `startedAt` to now while a run is live, else to the last recorded end (#28)
 * @property {number} activity
 * @property {number} phases
 * @property {number} [declaredPhases]
 * @property {number | null} done - null when the board could not be read and no reading stands in for it (#96)
 * @property {number[]} ready
 * @property {number} waiting
 * @property {number[]} inProgress
 * @property {number[]} stuck
 * @property {number | null} percent
 * @property {'unknown'} [progress] - `unknown` when this read of the board failed or timed out (#96) — draw it with `progressReading`
 * @property {{ done: number; phases: number; percent: number; at: number; ageMs: number }} [lastGood] - the last good reading beside an unknown progress, and its age when served (#96)
 * @property {number} remainingWeight
 * @property {number} remainingSessions
 * @property {number[]} criticalPath
 * @property {number} criticalWeight
 * @property {number} minimumSessions
 * @property {{ phase: number; blocks: number }} [bottleneck]
 * @property {{ phase: number; unblocks: number }} [nextBest]
 * @property {number} budget
 * @property {string} [targetModel]
 * @property {string} [branch]
 * @property {string[]} skills
 * @property {string[]} mcpServers - `**MCP servers (every session):**` — attached to every phase of this plan
 * @property {string} qaMode
 * @property {string} [qaModeReason] - the engine's reason beside the word (`plan directive: QA gate: on`)
 * @property {number[]} qaFailures
 * @property {number[]} [gated] - the open phases whose heading is GATED (#360) — absent from a server before one-pool phase 17
 * @property {PhaseLock[]} locks
 * @property {string[]} repos
 * @property {number} handoffCount
 * @property {string} [lastCompleted]
 * @property {number} [spanDays]
 * @property {number} [medianGapDays]
 * @property {HealthIssue[]} issues
 * @property {string} [engineError]
 * @property {{ at: number; ageMs: number }} [boardStale] - set when the board is the LAST GOOD one, served because this read timed out (#44)
 * @property {{ error: number; warning: number; info: number }} issueCounts
 * @property {boolean} hasHandoffs
 * @property {import('./runs.js').EtaEstimate} [eta] - how long this plan has left; absent only when nothing is left
 */

/**
 * @typedef {object} PhaseRow
 * @property {number} phase
 * @property {string} title
 * @property {number[]} dependsOn
 * @property {string} parallelSafe
 * @property {string} repos
 * @property {string} exitCriteria
 */

/**
 * @typedef {object} PhaseAnalysis
 * @property {number} phase
 * @property {string} state
 * @property {string} size
 * @property {number} weight
 * @property {number[]} dependsOn
 * @property {number[]} dependents
 * @property {number[]} transitiveDependents
 * @property {number} unblocks
 * @property {boolean} onCriticalPath
 */

/**
 * @typedef {object} PhaseHandoffRef
 * @property {string} file
 * @property {string} status
 * @property {string} [completed]
 * @property {string} title
 * @property {string} [outstanding] - `?include=handoffs`; absent means EITHER no Outstanding section OR the caller did not ask — never render a sentence that distinguishes them
 * @property {string[]} skillsUsed
 * @property {number} prompts
 */

/**
 * This console's own verdict on a phase's diff, as the phase row carries it.
 * @typedef {object} PhaseReviewMark
 * @property {string} verdict
 * @property {string} at
 * @property {string} [by]
 * @property {string} [note]
 * @property {string} [base]
 * @property {string} [tip]
 */

/**
 * @typedef {object} PhaseView
 * @property {number} phase
 * @property {string} title
 * @property {string} state
 * @property {string} size
 * @property {number} weight
 * @property {boolean} gated
 * @property {string} [gates]
 * @property {string} [gateCheck]
 * @property {(typeof import('../plan-vocab.js').GATE_KINDS)[number]} [gateKind] - the gate's category — who can clear it; absent reads as `none`
 * @property {{ value: import('../landing-model.js').LandPolicy; source: 'phase' | 'plan' | 'default' }} [land] - the plan's `Land:` word for this phase and which level said it; absent reads as the default
 * @property {string} [model]
 * @property {string} [effort]
 * @property {string} [goal]
 * @property {string} [readFirst]
 * @property {string} [files]
 * @property {string} [steps]
 * @property {string} [exitCriteria]
 * @property {string} [verification]
 * @property {string[]} [mcpServers] - `**MCP:**` — registry ids this phase needs, on top of the plan-wide line
 * @property {string[]} [plugins] - the plugin kinds the plan gives this phase — its `**Plugins:**` line ∪ its bullet (measured-console phase 27)
 * @property {string} [handoffMustRecord]
 * @property {{ label: string; body: string }[]} [bullets] - `?include=prose` — absent on the board projection
 * @property {PhaseRow} [row]
 * @property {PhaseAnalysis} [analysis]
 * @property {{ result: string; report?: string }} [qa]
 * @property {{ mode: string; source: 'phase' | 'plan' }} [qaMode] - THIS phase's QA regime and which line answered; absent on an older server
 * @property {{ count: number; latest: { round: number; result: string; report?: string } }} [qaRounds] - the rounds the ledger records for this phase
 * @property {{ phase: number; why: string }[]} [blockedBy] - the unmet dependencies holding this phase, with the engine's reason
 * @property {number[]} [qaHeld] - the phases this phase's QA verdict holds — the HELD state
 * @property {PhaseLock} [lock]
 * @property {PhaseHandoffRef} [handoff]
 * @property {import('./runs.js').EvidenceProof} [proof] - claimed versus evidenced (`shared/evidence-model.js`); absent on a server from before Phase 4
 * @property {import('./runs.js').PhaseLive} [live] - what is working this phase right now; absent means nothing live was found
 * @property {PhaseReviewMark} [review] - this console's own verdict on the phase's diff; absent means nobody reviewed it HERE, never "approved by default"
 * @property {number[]} [reviewHold] - the direct dependencies on which changes were requested; non-empty means this console refuses to board the phase
 */

/**
 * @typedef {object} RouteNode
 * @property {number} phase
 * @property {number} layer
 * @property {number} row
 * @property {string} state
 * @property {string} size
 * @property {boolean} gated
 * @property {string} title
 * @property {'live' | 'stale'} [locked] - claimed, and whether the claim still holds; absent on an older server
 */

/**
 * @typedef {object} RouteView
 * @property {RouteNode[]} nodes
 * @property {{ from: number; to: number }[]} edges
 * @property {number} layers
 * @property {number} rows
 */

/**
 * @typedef {object} BatchGroup
 * @property {number} index
 * @property {string} kind
 * @property {string} [weight] - already formatted by the engine — `180K`, not a token count; absent when the engine's batch line names none
 * @property {number[]} phases
 * @property {boolean} gated
 * @property {string} [note]
 */

/**
 * @typedef {object} SessionPlanView
 * @property {number[]} [excluded]
 * @property {BatchGroup[]} groups
 * @property {string} raw
 * @property {string} [budget]
 */

/**
 * `GET /api/plans/:slug/session-plan` — `null` when no plan has that slug.
 * @typedef {SessionPlanView | null} SessionPlanRead
 */

/**
 * @typedef {object} LintResult
 * @property {boolean} ok
 * @property {string[]} issues
 * @property {string} summary
 * @property {boolean} [timedOut]
 * @property {boolean} [crashed] - the engine could not RUN (#17): the reading proves nothing, `ok` is true so nothing reads it as a broken plan; plan health reads "could not run", never red
 * @property {{ at: number; revision: number }} [stale] - set when this is the last verdict that proved something, served while this revision's runs or after it timed out (#44)
 */

/**
 * `GET /api/plans/:slug/lint` — `null` when no plan has that slug.
 * @typedef {LintResult | null} LintRead
 */

/**
 * The engine pool now — reads holding a slot, reads queued behind them, the slot count (`GET /api/engine`).
 * @typedef {object} EngineQueue
 * @property {number} active
 * @property {number} queued
 * @property {number} max
 */

/**
 * @typedef {object} SessionBudgetView
 * @property {string} raw
 * @property {string} [targetModel]
 * @property {string} [budget]
 * @property {string} [branch]
 * @property {string[]} skills
 * @property {string[]} mcpServers - `**MCP servers (every session):**` — attached to every phase of this plan
 * @property {'on' | 'off'} [qaGate]
 * @property {{ id: string; minHeadroom?: number }[]} [accounts] - `**Accounts:**` — the accounts a run may spend, in order, each with its minimum five-hour headroom; absent before 5.0.0
 */

/**
 * One row of the plan's `## Decisions` manifest as it HOLDS — the plan's row
 * with the `decisions.md` twin merged over it (`shared/decisions-model.js`
 * `DecisionRow`; the server's `mergeDecisions`). `blocking` is the normalised
 * `yes`/`no`; `phase` is `null` for a plan-wide row.
 * @typedef {object} DecisionRowView
 * @property {string} key
 * @property {string} value
 * @property {string} owner
 * @property {string} state
 * @property {'yes' | 'no'} blocking
 * @property {string} source
 * @property {string} evidence
 * @property {number | null} phase
 */

/**
 * One place a plan orders its own reviewer: the section it is in, and its words.
 * @typedef {object} PlanReviewer
 * @property {string} section
 * @property {string} excerpt
 */

/**
 * @typedef {object} PlanFile
 * @property {string} slug
 * @property {string} title
 * @property {string} [provenance]
 * @property {string} [context]
 * @property {string} [architecture]
 * @property {string} [endToEnd]
 * @property {SessionBudgetView} sessionBudget
 * @property {PhaseRow[]} [graph] - `?include=document` — Source-tab only
 * @property {string[]} [callouts] - `?include=document` — Source-tab only
 * @property {DecisionRowView[]} [decisions] - `?include=document` — the decision manifest, Source-tab only
 * @property {{ title: string; body: string }[]} [sections] - `?include=document` — the whole plan re-shipped; no client surface reads it
 * @property {string} [path]
 * @property {PlanReviewer[]} [reviewers] - where the plan orders its own in-session reviewer, in the board projection; absent from an older server
 */

/**
 * @typedef {object} HandoffRow
 * @property {number} phase
 * @property {string} file
 * @property {string} title
 * @property {string} status
 * @property {string} [completed]
 * @property {number} bytes
 * @property {number} mtime
 * @property {number} prompts
 * @property {string[]} skillsUsed
 */

/**
 * What "Give this run its own checkout" would DO for this plan — granted (and
 * for a superproject, which repositories the mirror would mount), or refused
 * by name. The launch dialog renders this instead of a checkbox that is
 * guaranteed to be refused.
 * @typedef {object} IsolationPreflight
 * @property {boolean} available
 * @property {'checkout' | 'mirror'} [kind] - `checkout` = one worktree of the root; `mirror` = per-repo worktrees
 * @property {string} [refusal]
 * @property {string} [detail]
 * @property {string[]} [mounts]
 * @property {string[]} [skipped]
 * @property {boolean} multiRepo - the run root is a superproject (`.gitmodules` at its top level)
 */

/**
 * What boarding will find wrong with this plan's §Verification, BEFORE a run
 * exists and before any money is spent. The warnings are the RUN's own
 * `PreflightWarning` — deliberately the same type, computed by the same
 * extractor and lead resolver. None of the four kinds is fatal on its own;
 * only `nothing-runnable` is certain to park the phase. Only OPEN phases
 * appear — a done phase's verification already ran.
 * @typedef {object} VerifyPreflight
 * @property {{ phase: number; warnings: import('./runs.js').PreflightWarning[] }[]} phases
 * @property {string} computedAt
 */

/**
 * One phase's money — `server/analysis/spend.ts` `PhaseCost`. `partial` means
 * the session ran and its spend was never harvested: the figure is a floor,
 * and `$0.00` would read as "this was free".
 * @typedef {object} PhaseCost
 * @property {number} phase
 * @property {number} usd
 * @property {number} attempts
 * @property {boolean} partial
 * @property {number} durationMs
 * @property {string} [model]
 * @property {string} [status]
 * @property {string} [endedAt]
 * @property {number} runs
 * @property {number | null} [forecastUsd] - its forecast at its first boarding, `estimated` (measured-console phase 23); absent when none was made
 */

/**
 * What a plan cost — `server/analysis/spend.ts` `PlanCostView`. `ladderUsd` is
 * a SUBSET of `totalUsd`, never a column to add to it, and `residualUsd` is a
 * reconciliation fault rather than a category.
 * @typedef {object} PlanCost
 * @property {string} slug
 * @property {number} totalUsd
 * @property {number} attributedUsd
 * @property {number} residualUsd
 * @property {number} ladderUsd
 * @property {number[]} partialPhases
 * @property {PhaseCost[]} phases
 * @property {{ model: string; usd: number; phases: number }[]} byModel
 * @property {{ day: string; usd: number }[]} byDay
 * @property {boolean} byDayTruncated
 * @property {{ runId: string; spentUsd: number; budgetUsd: number | null; status?: string }[]} runs
 * @property {PlanActuals} [actuals] - the plan's money after the fact, against its forecasts (measured-console phase 23); absent from an older console
 */

/**
 * `server/analysis/spend.ts` `PlanActuals` — what the plan spent, set against what its phases were forecast to cost.
 * @typedef {object} PlanActuals
 * @property {number} actualUsd
 * @property {number} verifiedPhases
 * @property {number | null} costPerVerifiedPhaseUsd
 * @property {number} costOfFailedAttemptsUsd
 * @property {number} failedAttempts
 * @property {number | null} forecastUsd
 * @property {number | null} forecastActualUsd
 * @property {number | null} deltaUsd
 * @property {number | null} deltaPct
 * @property {number} forecastPhases
 */

/**
 * Why a calendar forecast reads unknown instead of a date — `shared/ops-vocab.js` owns the words.
 * @typedef {(typeof import('../ops-vocab.js').DUTY_UNKNOWN_REASONS)[number]} DutyUnknownReason
 */

/**
 * The share of elapsed wall-clock a plan has spent with a phase actually running.
 * @typedef {object} DutyCycle
 * @property {number} ratio
 * @property {number} samples
 * @property {boolean} known - false when the window cannot say how this plan is being driven — then there is no date
 * @property {DutyUnknownReason} [reason] - why it is not known; absent when `known`
 * @property {number} workingMs
 * @property {number} elapsedMs
 */

/**
 * When a plan finishes — `server/analysis/stats.ts` `Forecast`. The instants
 * are ISO and the client renders them in ITS zone; `assumptions` is printed
 * beside every instant. `earliest`/`expected`/`latest` are present only when
 * `calendar === 'known'`.
 * @typedef {object} Forecast
 * @property {string} [earliest]
 * @property {string} [expected]
 * @property {string} [latest]
 * @property {'calendar'} clock - a calendar figure — stretched by the duty cycle, unlike `EtaEstimate`'s `'working'`
 * @property {'known' | 'unknown'} calendar - whether a date exists at all
 * @property {import('./runs.js').EtaEstimate['basis']} basis
 * @property {number} samples
 * @property {number} missing - finished phases with no usable measurement, reported beside the count
 * @property {number} remainingPhases
 * @property {number} remainingWeight
 * @property {number} workingLowMs
 * @property {number} workingHighMs
 * @property {DutyCycle} duty
 * @property {string[]} assumptions
 * @property {string} label
 */

/**
 * The sizing model as it reads this plan (control-tower phase 59, #83).
 * @typedef {object} PlanSizing
 * @property {string} unit
 * @property {{ sessions: number; phases: number; basis: 'measured' | 'shipped' }} forecast
 * @property {string} forecastLine
 * @property {{ floor: number; slope: number; boot: number; work: number; basis: 'measured' | 'shipped'; samples: number }} context
 * @property {string} bootLine
 */

/**
 * @typedef {object} PlanGitHead
 * @property {string} [sha]
 * @property {string} [subject]
 * @property {string} [author]
 * @property {string} [date]
 * @property {string} [relativeDate]
 * @property {boolean} [dirty]
 */

/**
 * `GET /api/plans/:slug` — one plan, projected (`?include=` names groups from
 * `shared/projection.js`; omitted, the board projection).
 * @typedef {object} PlanDetail
 * @property {PlanSummaryFull} summary
 * @property {PlanFile | null} plan
 * @property {PhaseView[]} phases
 * @property {RouteView} route
 * @property {SessionPlanView | null} batches
 * @property {PlanSizing} [sizing] - the sizing model as it reads this plan; absent from an older server
 * @property {string} boardText
 * @property {LintResult | null} lint
 * @property {HandoffRow[]} handoffs
 * @property {{ phase: number; title: string; status: string; link?: string }[]} index
 * @property {{ plan: import('./runs.js').EtaEstimate | null; perPhase: import('./runs.js').PhaseEta[] }} [eta] - the plan's estimate and one per phase, from one rate reading; optional against a new-UI-old-server
 * @property {PlanCost} [cost] - what this plan cost, phase by phase; same optionality
 * @property {Forecast | null} [forecast] - when it finishes, and every assumption that date rests on
 * @property {import('./runs.js').RunForecastUsdView} [forecastUsd] - what each phase will likely cost, `estimated` (measured-console phase 23); absent from a free or older console
 * @property {{ phase: number; result: string; report?: string }[]} qa
 * @property {Record<number, number[]>} [qaHeld] - which phases each recorded verdict is holding, keyed by the phase whose verdict it is
 * @property {PhaseLock[]} locks
 * @property {PlanGitHead} git
 * @property {{ key: string; path: string; text: string; indexLines: string[] } | null} [memory] - `?include=memory`: ABSENT when nobody asked, `null` when someone did and the plan has no memory file
 */

/**
 * One boot prompt a handoff carries (`server/parse/handoff.ts` `BootPrompt`).
 * @typedef {object} HandoffBootPrompt
 * @property {number} [phase] - the phase the prompt starts, when it can be read out of the text
 * @property {boolean} gated
 * @property {string} text
 */

/**
 * @typedef {object} HandoffDetail
 * @property {string} slug
 * @property {number} phase
 * @property {string} file
 * @property {string} path
 * @property {string} title
 * @property {string} status
 * @property {string} [rawStatus]
 * @property {string} [completed]
 * @property {string} [nextPhase]
 * @property {number[]} dependsOn
 * @property {number[]} blocks
 * @property {number[]} parallelSafe
 * @property {string[]} skillsUsed
 * @property {string[]} keyFiles
 * @property {string} [memoryKey]
 * @property {string} [outstanding]
 * @property {HandoffBootPrompt[]} prompts - the boot prompts the handoff carries, whole — the server always sent these; the phase row's `PhaseHandoffRef.prompts` is the COUNT
 * @property {boolean} [finalPhase]
 * @property {string} body
 * @property {number} bytes
 * @property {number} mtime
 */

/**
 * A `text/plain` answer — a prompt, the raw plan, the board, the memory block.
 * The client's `request` returns a string for a non-JSON content type.
 * @typedef {string} PlanTextBody
 */

/**
 * `phase-graph.sh --gate-status` for one phase.
 * @typedef {object} GateStatus
 * @property {string} kind
 * @property {boolean} clear
 * @property {string} detail
 */

/**
 * `GET /api/plans/:slug/gate/:phase` — `null` when no plan has that slug.
 * @typedef {GateStatus | null} GateRead
 */

/**
 * @typedef {object} GateApprovalBody
 * @property {boolean} approve
 * @property {string} [by]
 * @property {string} [note]
 * @property {boolean} [continueRun]
 */

/**
 * @typedef {object} GateApprovalOutcome
 * @property {boolean} ok
 * @property {GateStatus | null} gate
 * @property {string} detail
 * @property {boolean} [resumed]
 */

/* ---------------- review (server/review.ts) ----------------
 * The diff a phase landed, and this console's verdict on it. */

/** @typedef {'approved' | 'requested-changes' | 'commented'} ReviewVerdict */

/**
 * @typedef {object} DiffLine
 * @property {'context' | 'add' | 'del' | 'meta'} kind
 * @property {string} text
 * @property {number} [oldLine]
 * @property {number} [newLine]
 */

/**
 * @typedef {object} DiffHunk
 * @property {string} header
 * @property {DiffLine[]} lines
 */

/**
 * @typedef {object} DiffFile
 * @property {string} path
 * @property {string} [oldPath]
 * @property {'added' | 'deleted' | 'modified' | 'renamed'} status
 * @property {number} additions
 * @property {number} deletions
 * @property {boolean} binary
 * @property {DiffHunk[]} hunks
 * @property {boolean} [truncated] - the file's hunks were cut at the per-file cap — the COUNTS are still real
 */

/**
 * @typedef {object} ReviewWindow
 * @property {'handoff-window' | 'working-tree' | 'explicit' | 'none'} kind
 * @property {string} [base]
 * @property {string} [tip]
 * @property {string} note - how the bracket was chosen, and what it cannot know; shown verbatim
 */

/**
 * @typedef {object} PhaseDiff
 * @property {string} slug
 * @property {number} phase
 * @property {ReviewWindow} window
 * @property {{ sha: string; subject?: string; date?: string; author?: string }[]} commits
 * @property {DiffFile[]} files
 * @property {number} additions
 * @property {number} deletions
 * @property {boolean} truncated
 * @property {boolean} failed - git could not answer — `files` is empty and means NOTHING
 */

/**
 * One inline comment, anchored to a file and (usually) a line. Schema v2.
 * @typedef {object} ReviewComment
 * @property {string} id
 * @property {string} path
 * @property {number} [line]
 * @property {'old' | 'new'} [side]
 * @property {string} [hunk]
 * @property {string} [code]
 * @property {string} body
 * @property {string} [by]
 * @property {string} at
 * @property {boolean} [resolved] - answered; kept, not deleted — and skipped when a follow-up is composed
 */

/**
 * @typedef {object} ReviewRecord
 * @property {number} version
 * @property {string} slug
 * @property {number} phase
 * @property {ReviewVerdict} verdict
 * @property {string} [note]
 * @property {string} [by]
 * @property {string} at
 * @property {string} [base]
 * @property {string} [tip]
 * @property {ReviewComment[]} [comments]
 */

/**
 * @typedef {object} PhaseReview
 * @property {PhaseDiff} diff
 * @property {ReviewRecord | null} review
 * @property {boolean} staleTip - the phase has landed a commit since the verdict was given
 */

/**
 * @typedef {object} ReviewVerdictBody
 * @property {ReviewVerdict | 'withdraw'} verdict
 * @property {string} [note]
 * @property {string} [by]
 * @property {string} [base]
 * @property {string} [tip]
 */

/**
 * @typedef {{ action: 'add'; path: string; line?: number; side?: 'old' | 'new'; hunk?: string; code?: string; body: string; by?: string }
 *   | { action: 'resolve' | 'unresolve' | 'delete'; id: string }} ReviewCommentBody
 */

/**
 * What a verdict or a comment write answers: the review as it now stands.
 * @typedef {object} ReviewOutcome
 * @property {boolean} ok
 * @property {ReviewRecord | null} review
 * @property {string} detail
 */

/**
 * @typedef {object} SendBackBody
 * @property {string} [by]
 */

/**
 * @typedef {object} SendBackOutcome
 * @property {boolean} ok
 * @property {string} detail
 * @property {string} [followUp]
 * @property {boolean} [boarded]
 */

/* ---------------- forward notes (server/parse/notes.ts) ----------------
 * What earlier phases left for one that has not started. `trailer` is the
 * bound's own row and is never a note. */

/** @typedef {'handoff' | 'deferral' | 'message' | 'trailer'} NoteKind */

/**
 * @typedef {object} PhaseNote
 * @property {string} source - who left it: a handoff's basename, or `phase-<N>` for a ledger line
 * @property {NoteKind} kind
 * @property {string} id - the message or ruling id — `-` for a handoff bullet, which has none
 * @property {string} at - when it was written — `-` when the handoff never said
 * @property {string} text
 */

/**
 * @typedef {object} PhaseNotes
 * @property {string} slug
 * @property {number} phase
 * @property {PhaseNote[]} notes
 */

/* ---------------- landing (server/landing.ts) ----------------
 * How a finished plan leaves the machine: a branch, a commit range, and a
 * packet of files. */

/**
 * @typedef {object} BranchState
 * @property {boolean} available
 * @property {string} [branch]
 * @property {string} [head]
 * @property {string} [upstream]
 * @property {number} [ahead]
 * @property {number} [behind]
 * @property {string[]} dirty
 * @property {boolean} dirtyTruncated
 */

/**
 * @typedef {object} LandingWindow
 * @property {'plan-window' | 'explicit' | 'none'} kind
 * @property {string} [base]
 * @property {string} [tip]
 * @property {string} note
 */

/**
 * @typedef {object} LandingArtifact
 * @property {string} name - relative to the packet directory — and the download key the route accepts
 * @property {'manifest' | 'bundle' | 'patch'} kind
 * @property {number} bytes
 */

/**
 * @typedef {object} LandingPacket
 * @property {number} version
 * @property {string} slug
 * @property {string} at
 * @property {BranchState} repo
 * @property {LandingWindow} window
 * @property {{ sha: string; subject?: string; date?: string; author?: string }[]} commits
 * @property {number} commitCount
 * @property {boolean} commitsTruncated
 * @property {{ name: string; bytes: number; ref: string; prerequisites: string[] }} [bundle]
 * @property {{ dir: string; files: string[] }} patches
 * @property {LandingArtifact[]} files
 * @property {string[]} apply
 * @property {string[]} notes
 */

/**
 * @typedef {object} LandingView
 * @property {string} slug
 * @property {BranchState} repo
 * @property {LandingWindow} window
 * @property {number} commitCount
 * @property {boolean} finished - every phase done — decides how loudly the card presents itself, never whether it works
 * @property {LandingPacket | null} packet
 * @property {boolean} writable
 */

/**
 * @typedef {object} LandingComposeBody
 * @property {string} [base]
 * @property {string} [tip]
 */

/**
 * @typedef {object} LandingComposeOutcome
 * @property {boolean} ok
 * @property {LandingPacket | null} packet
 * @property {string} detail
 */

/* ---------------- QA ---------------- */

/**
 * `POST /api/plans/:slug/qa-mode {mode, phase?}` — the regime the engine reads back.
 * @typedef {object} QaModeSetOutcome
 * @property {boolean} ok
 * @property {string} detail
 * @property {{ mode: string; reason?: string }} [plan]
 * @property {{ phase: number; regime: { mode: string; reason?: string } }} [phase]
 */

/**
 * `POST /api/plans/:slug/qa-mode {phase}` — the older activate verb: QA turned on for a plan that had it off.
 * @typedef {object} QaActivateOutcome
 * @property {boolean} ok
 * @property {string} mode
 * @property {string} detail
 */

/**
 * `{mode, phase?}` sets the regime; `{phase}` alone activates QA.
 * @typedef {object} QaModeBody
 * @property {'on' | 'off' | 'inherit'} [mode]
 * @property {number} [phase]
 */

/** @typedef {QaModeSetOutcome | QaActivateOutcome} QaModeAnswer */

/**
 * `GET /api/plans/:slug/qa-report/:phase?round=N`.
 * @typedef {object} QaReportView
 * @property {string} path
 * @property {number} round
 * @property {string} text
 */

/**
 * @typedef {object} QaWaiveBody
 * @property {number} phase
 * @property {string} reason
 */

/**
 * @typedef {object} QaWaiveOutcome
 * @property {boolean} ok
 * @property {string} verdict
 * @property {number} [round]
 * @property {string} [report]
 * @property {string} detail
 */

/**
 * What is left: its weight, its phases, and the sessions it forecasts at this
 * plan's budget — `null` when no plan has that slug.
 * @typedef {{ weight: number; sessions: number; phases: number } | null} PlanWork
 */

/* ---------------- the guarded write verbs ----------------
 * Every one of them shells out to a phased-execution script, and every one is
 * refused unless the server was started with `--allow-writes`. `dry` returns
 * the exact invocation without running it — the preview the dialog shows. */

/** @typedef {{ action: string; slug?: string; phase?: number; [field: string]: unknown }} WriteRequest */

/**
 * What became of one release attempt. A bulk release returns one per lock.
 * @typedef {object} LockRelease
 * @property {string} slug
 * @property {number} phase
 * @property {boolean} ok
 * @property {string | null} owner - read from the lock file; null when there was no lock to read
 * @property {string} [detail]
 */

/**
 * @typedef {object} WriteResult
 * @property {boolean} [ok] - absent on a dry run — a preview neither succeeded nor failed
 * @property {boolean} [dryRun]
 * @property {string} [command] - the literal command line; present on a dry run and a real one
 * @property {string} [description]
 * @property {number} [code]
 * @property {string} [stdout]
 * @property {string} [stderr]
 */


/**
 * Every route this family owns → the typedef its response is (and, for a write, the one it takes).
 * @type {Readonly<Record<string, { response: string, body?: string }>>}
 */
export const WIRE_ROUTES = Object.freeze({
  'GET /api/plans': { response: 'PlanList' },
  'GET /api/plans/:slug': { response: 'PlanDetail' },
  'GET /api/plans/:slug/raw': { response: 'PlanTextBody' },
  'GET /api/plans/:slug/handoff/:phase': { response: 'HandoffDetail' },
  'GET /api/plans/:slug/qa-report/:phase': { response: 'QaReportView' },
  'GET /api/plans/:slug/prompt/:phase': { response: 'PlanTextBody' },
  'GET /api/plans/:slug/next-prompt/:phase': { response: 'PlanTextBody' },
  'GET /api/plans/:slug/qa-prompt/:phase': { response: 'PlanTextBody' },
  'GET /api/plans/:slug/memory-block': { response: 'PlanTextBody' },
  'GET /api/plans/:slug/notes/:phase': { response: 'PhaseNotes' },
  'GET /api/plans/:slug/verify-preflight': { response: 'VerifyPreflight' },
  'GET /api/plans/:slug/isolation-preflight': { response: 'IsolationPreflight' },
  'GET /api/plans/:slug/board': { response: 'PlanTextBody' },
  'GET /api/plans/:slug/review/:phase': { response: 'PhaseReview' },
  'POST /api/plans/:slug/review/:phase': { response: 'ReviewOutcome', body: 'ReviewVerdictBody' },
  'POST /api/plans/:slug/review-comment/:phase': { response: 'ReviewOutcome', body: 'ReviewCommentBody' },
  'POST /api/plans/:slug/review-send-back/:phase': { response: 'SendBackOutcome', body: 'SendBackBody' },
  'GET /api/plans/:slug/landing': { response: 'LandingView' },
  'POST /api/plans/:slug/landing': { response: 'LandingComposeOutcome', body: 'LandingComposeBody' },
  // A file download — the bundle, a patch or the manifest, streamed with a content-disposition.
  'GET /api/plans/:slug/landing/:file': { response: 'WireOpaque' },
  'GET /api/plans/:slug/gate/:phase': { response: 'GateRead' },
  'POST /api/plans/:slug/gate/:phase': { response: 'GateApprovalOutcome', body: 'GateApprovalBody' },
  'GET /api/plans/:slug/session-plan': { response: 'SessionPlanRead' },
  'GET /api/plans/:slug/lint': { response: 'LintRead' },
  'GET /api/plans/:slug/work': { response: 'PlanWork' },
  'POST /api/plans/:slug/qa-mode': { response: 'QaModeAnswer', body: 'QaModeBody' },
  'POST /api/plans/:slug/qa-waive': { response: 'QaWaiveOutcome', body: 'QaWaiveBody' },
});
