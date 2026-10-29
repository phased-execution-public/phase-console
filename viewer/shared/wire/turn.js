/**
 * The wire of turn — what needs a person: the attention inbox (`/api/inbox`),
 * Your turn (`/api/turn`) and the human-step ledger and its verbs
 * (`/api/human-steps`) (measured-console phase 32).
 *
 * The server owns all three: `server/inbox.ts` builds the inbox,
 * `server/turn/` folds and composes Your turn, `server/human-steps.ts` folds
 * the ledger and `service-recovery.ts` answers each verb — every word here is
 * already redacted there.
 */

/* ------------------------------------------------------------------ *
 * The attention inbox — `GET /api/inbox`, `POST|DELETE /api/inbox/ack`
 * ------------------------------------------------------------------ */

/**
 * What kind of thing is asking.
 * @typedef {'errand' | 'approval' | 'gate' | 'sign-in' | 'mcp-auth' | 'qa' | 'lock' | 'health' | 'stall' | 'ruling' | 'session-ask' | 'conflict' | 'question' | 'policy' | 'issue-draft' | 'message' | 'supervisor' | 'human-step'} InboxKind
 */

/**
 * How loudly: `urgent` interrupts, `needs-you` waits for a person, `fyi` informs.
 * @typedef {'urgent' | 'needs-you' | 'fyi'} InboxSeverity
 */

/**
 * One thing a person can do about an item, as the server spells it.
 * @typedef {object} InboxAction
 * @property {string} verb
 * @property {string} label
 * @property {string} endpoint
 * @property {'GET' | 'POST' | 'DELETE'} method
 * @property {unknown} [body]
 * @property {string} [flag] - which console capability gates it (run | agent | writes | …), when one does
 * @property {{ field: string; label: string; placeholder?: string }} [says] - this action can carry words, and this is the body key they go in. The server says which key because the client must not know that a gate wants `note` and a permission card wants `reason` — that would be the start of the routing table `inboxAct` exists to avoid. Absent means the action takes no words.
 */

/**
 * One row of the attention inbox: what is needed, how to give it, and the
 * actions that would clear it.
 * @typedef {object} InboxItem
 * @property {string} id
 * @property {InboxKind} kind
 * @property {InboxSeverity} severity
 * @property {string} [slug]
 * @property {number} [phase]
 * @property {string} [runId]
 * @property {string} title
 * @property {string} need - what is needed
 * @property {string} how - how to give it
 * @property {string[]} [tried] - what was already tried, so nobody tries it again by hand
 * @property {string} since - ISO 8601 — since when it has been waiting
 * @property {string} [expiresAt] - ISO 8601 — when the ask stops being a person's to answer (a relayed question's window)
 * @property {string} [openUntil] - ISO 8601 — when a person's act stops being open (a human step's window) — never a countdown (#341)
 * @property {InboxAction[]} actions
 * @property {string} href - where in the console it lives
 * @property {{ at: string; by?: string } | null} [ack] - acknowledged — seen, not cleared
 * @property {{ id: string; name: string } | null} [console] - the console that asked, on a list that merges several — absent on a console's own inbox, where every row is that console's; `null` names a row about the machine rather than any one console
 * @property {{ word: import('../halt-categories.js').HaltCategory; label: string }} [category] - the halt family of what stopped the work, word and label (control-tower phase 17)
 * @property {import('../human-step-model.js').HumanStepView} [humanStep] - a person's turn (control-tower phase 44): every row that asks a person for an act carries the same view, so ONE card draws them all (`cards/item-card.tsx`); the row's `actions` still answer it
 * @property {TurnView} [turn] - the item of Your turn this row is (control-tower phase 132): which item, which record holds it, its kind, reason, proof type and group; absent on a row nothing waits on, and on an issue draft
 * @property {InboxSupervisorView} [supervisor] - a supervisor card's own facts (control-tower phase 102): its situation, detection category, evidence, the verb Accept presses or the command an escalation needs, and the cap that held it; only on a `supervisor` row
 * @property {TurnOption[]} [options] - the ways on, each bound to the verb that takes it, at most one recommended (turn-by-turn phase 4) — an errand's, a conflict's, a QA verdict's, a relayed question's and a session's ask; the row's `actions` stay its buttons
 * @property {ApprovalBlock} [approval] - a yes or a no's block: what, who asked, if approved, if denied (turn-by-turn phase 4)
 * @property {string} [headline] - the row's whole words when its title was cut to the title rule — at most 80 characters (#377)
 * @property {{ repo: string; paths: string[] }[]} [files] - the landing errand's files, grouped by repository — the card's folded *Details* (#377)
 */

/**
 * One way on, bound to its verb — `server/turn/compose.ts` `TurnOption`.
 * @typedef {object} TurnOption
 * @property {string} id
 * @property {string} label
 * @property {string} [consequence]
 * @property {boolean} [recommended]
 * @property {{ method: 'POST' | 'GET' | 'DELETE'; endpoint: string; body?: unknown }} verb
 * @property {{ field: string; label: string; placeholder?: string }} [says]
 * @property {string} [flag]
 */

/**
 * What a yes or a no is about — `server/turn/compose.ts` `ApprovalBlock`.
 * @typedef {object} ApprovalBlock
 * @property {string} what
 * @property {string} askedBy
 * @property {string} ifApproved
 * @property {string} ifDenied
 * @property {readonly string[]} [scopes]
 */

/**
 * What a `supervisor` row carries of its card — `server/inbox.ts` `InboxSupervisorView`.
 * @typedef {object} InboxSupervisorView
 * @property {'suggestion' | 'escalation'} card
 * @property {string} situation
 * @property {string} category
 * @property {string | null} verb
 * @property {string} why
 * @property {readonly string[]} evidence
 * @property {string} [command]
 * @property {string | null} [then]
 * @property {{ cap: string; limit: number; count: number }} [cap]
 */

/**
 * `GET /api/inbox` — what needs a person right now, worst first, oldest first.
 * @typedef {object} InboxView
 * @property {InboxItem[]} items
 * @property {string} generatedAt
 */

/**
 * One acknowledgement's answer — `POST /api/inbox/ack {id}`, `DELETE /api/inbox/ack?id=`.
 * @typedef {{ ok: boolean }} InboxAckOne
 */

/**
 * What a bulk press answers: one row per item, and the count that succeeded.
 * @typedef {object} BulkAckResult
 * @property {{ id: string; ok: boolean; error?: string }[]} results
 * @property {number} [acked]
 * @property {number} [unacked]
 */

/**
 * An acknowledgement answers per item when it named several (`ids`, `?id=` repeated), else one `ok`.
 * @typedef {InboxAckOne | BulkAckResult} InboxAckAnswer
 */

/**
 * What `POST /api/inbox/ack` takes: one id (with the option an ack-bound
 * answer names, turn-by-turn phase 5), or a selection.
 * @typedef {{ id: string; answer?: string } | { ids: string[] }} InboxAckBody
 */

/* ------------------------------------------------------------------ *
 * Your turn — `GET /api/turn`, `GET /api/turn/:id`, `POST /api/turn/:id/<verb>`
 * ------------------------------------------------------------------ */

/**
 * Which record holds an item: the human-step ledger, the row's own (a gate, an
 * approval card, …), or — an owner request about no item the turn shows
 * (control-tower phase 148) — the request itself. Owned by
 * `shared/turn-model.js` (`TURN_RECORDS`) since turn-by-turn phase 1.
 * @typedef {import('../turn-model.js').TurnRecord} TurnRecord
 */

/**
 * The `turn` view an inbox row carries when it asks a person for an act.
 * @typedef {object} TurnView
 * @property {string} item - the item this row is: a ledger step's id, or the row's own id when the item is projected
 * @property {TurnRecord} record
 * @property {string} source - where it came from — `shared/turn-model.js` `TURN_SOURCES`
 * @property {import('../human-step-model.js').HumanStepKind} kind
 * @property {import('../turn-model.js').WhyPerson} why
 * @property {import('../turn-model.js').ProofType} proofType
 * @property {import('../turn-model.js').TurnGroup} group
 * @property {PermissionRecord} [permission] - a permission item's record — on a ledger item and on the approval card it projects (phase 135)
 * @property {import('../turn-model.js').ItemType} [type] - the card's words a ROW carries (turn-by-turn phase 10, `server/turn/fold.ts` `withRowWords`): the type, whether it is due, and NOT YET's *when* — so the Runs home and the bell say what the card says
 * @property {import('../turn-model.js').Readiness} [readiness]
 * @property {string} [startWhen]
 */

/**
 * A ledger item's own record — its reason, proof, options, waiters and attempts. Never a value.
 * @typedef {object} TurnStepDetail
 * @property {string} id
 * @property {import('../human-step-model.js').HumanStepKind} kind
 * @property {string} title
 * @property {import('../human-step-model.js').HumanStepState} state
 * @property {import('../turn-model.js').WhyPerson} why
 * @property {'declared' | 'inferred'} whySource
 * @property {import('../turn-model.js').ProofType} proofType
 * @property {number} attempts
 * @property {{ slug: string; phase: number; runId?: string; sessionId?: string }[]} waiters
 * @property {string} declaredAt
 * @property {string} birth
 * @property {string} [proof]
 * @property {string} [proofWords]
 * @property {import('../guide-grammar.js').Guide} [guide] - the full guide, as the one grammar parsed it (`shared/guide-grammar.js`)
 * @property {{ id: string; label: string; consequence?: string; recommended?: true }[]} [options]
 * @property {boolean} [allowDecline]
 * @property {number} [effortMin]
 * @property {{ slug: string; phase: number }[]} [unblocks] - the phases it unblocks
 * @property {string} [until]
 * @property {{ kind: string; ref?: string }} [source]
 * @property {string} [read]
 * @property {string} [note]
 * @property {PermissionRecord} [permission]
 * @property {{ attempt: number; text: string; at: string; by?: string }[]} [notes] - what the person wrote with each check (turn-by-turn phase 5), oldest first — the card shows the latest
 * @property {{ id: string; phase: number; title: string }} [coveredBy] - a plan item's session item that covers it (turn-by-turn phase 7) — linked, never merged
 * @property {{ id: string; phase: number; title: string }[]} [covers] - the plan items this session item covers
 */

/**
 * How a pressed projected item ended (turn-by-turn phase 5) — an approval
 * card, a gate, a plan approval, an answered question, an ack-bound option:
 * passed or closed, by whom, when, and what was pressed, in words; not doing
 * when the person said *I can't do this* (2026-10-20).
 * @typedef {object} TurnSettled
 * @property {'passed' | 'closed' | 'not-doing'} outcome
 * @property {string} by
 * @property {string} at
 * @property {string} what
 */

/**
 * Who was told of a person's word on an item — the run's pinned note, the supervisor's chat.
 * @typedef {{ note: string | null; chat: string | null }} TurnTold
 */

/**
 * What *I can't do this* on a projected item answered: the item, how it settled, and who was told.
 * @typedef {object} TurnCannotAnswer
 * @property {true} ok
 * @property {string} item
 * @property {TurnSettled | null} settled
 * @property {TurnTold} told
 */

/**
 * What *Hand it to the AI* answered: the item, and how the AI took it — answered, its recommendation taken, resumed, or its run told.
 * @typedef {object} TurnHandOffAnswer
 * @property {true} ok
 * @property {string} item
 * @property {'answered' | 'recommended' | 'resumed' | 'told'} how
 * @property {TurnTold} told
 */

/**
 * What a comment on an item answered: who was told — the run's pinned note, the supervisor's chat.
 * @typedef {object} TurnNoteAnswer
 * @property {true} ok
 * @property {string} item
 * @property {TurnTold} told
 */

/** `POST /api/turn/:id/cannot` — the person's reason. @typedef {{ reason: string }} TurnCannotBody */

/** `POST /api/turn/:id/hand-off` — the person's note, when there is one. @typedef {{ note?: string }} TurnHandOffBody */

/** `POST /api/turn/:id/note` — the comment. @typedef {{ text: string }} TurnNoteBody */

/**
 * One thing to do, however many inbox rows stand for it.
 * @typedef {TurnView & TurnItemOwn} TurnItem
 */

/**
 * A `TurnItem`'s own members beyond its `TurnView`.
 * @typedef {object} TurnItemOwn
 * @property {string[]} rows - every inbox row this item stands for — an errand row and its step's row are one item
 * @property {string} title
 * @property {string} need
 * @property {string} how
 * @property {string} severity
 * @property {string} [slug]
 * @property {number} [phase]
 * @property {string} [runId]
 * @property {string} since
 * @property {string} [expiresAt]
 * @property {string} [openUntil] - a human step's window end (#341) — when the act stops being open, never a countdown
 * @property {string} href
 * @property {InboxAction[]} actions
 * @property {import('../turn-model.js').ItemType} [type] - the card's words (turn-by-turn phase 1, `server/turn/fold.ts` `CardWords`): what is asked, where the person stands, whether it is due, where a press goes and who checks it; optional so a 7.0 answer still reads
 * @property {import('../turn-model.js').PersonStatus} [personStatus]
 * @property {import('../turn-model.js').Readiness} [readiness]
 * @property {import('../turn-model.js').RouteTo} [route] - *Goes to* — `ROUTE_META[route]` says it; never `supervisor` in the Free edition
 * @property {string} [checkedBy] - *Checked by*, in words (`CHECKED_BY_LABEL`)
 * @property {TurnSettled} [settled] - a Done item that was pressed: passed or closed, by whom, when (turn-by-turn phase 5)
 * @property {string} [meta] - the composer's words (turn-by-turn phase 3, `server/turn/compose.ts`): the meta in words, the steps by precedence and where they came from, the check in words, the clocks, and the check's verdicts; optional so a 7.0 console's answer still reads
 * @property {import('../guide-grammar.js').Guide['steps']} [steps]
 * @property {import('../turn-model.js').StepsFrom} [stepsFrom]
 * @property {string} [check]
 * @property {import('../guide-grammar.js').Guide['trouble']} [trouble]
 * @property {{ assignedAt: string; startAt?: string; startWhen?: string; deadline?: string; openUntil?: string; submittedAt?: string; checkedAt?: string }} [timing]
 * @property {StepVerdictRecord | null} [verdict]
 * @property {StepVerdictRecord[]} [verdicts]
 * @property {TurnOption[]} [options] - what each source says (turn-by-turn phase 4): the ways on, each bound to its verb, at most one recommended; optional so a 7.0 answer still reads
 * @property {ApprovalBlock | null} [approval] - the approval block of a yes or a no
 * @property {InboxItem['humanStep']} [humanStep]
 * @property {InboxItem['category']} [category]
 * @property {InboxSupervisorView} [supervisor] - a supervisor card's own facts (control-tower phase 139) — the page draws its card inside the item
 * @property {TurnStepDetail} [step]
 * @property {import('./system.js').AuthorityRequest[]} [requests] - what other doors asked the owner to press ON this item (phase 148) — each confirmed or refused once
 * @property {import('./system.js').AuthorityRequest} [request] - an owner request about no item the turn shows: it is the item (`record: 'request'`)
 * @property {string} [headline] - the title rule (#377, `server/turn/compose.ts` `shortTitle`): `title` is sentence case and at most 80 characters; `headline` is the act's whole words when the title had to be cut
 * @property {string} [errandRef] - the plan's errands-table ref ("E-4") drawn as a chip
 * @property {InboxItem['files']} [files] - the landing errand's files grouped by repository — the card's folded *Details*
 */

/**
 * One thing the AI handled instead of asking (control-tower phase 136) — `server/turn/handled.ts`.
 * @typedef {object} HandledRow
 * @property {string} id
 * @property {string} at
 * @property {string} first
 * @property {(typeof import('../turn-model.js').HANDLED_SOURCES)[number]} source
 * @property {string} what
 * @property {string} [slug]
 * @property {number} [phase]
 * @property {string} [runId]
 * @property {string} [note]
 * @property {number} count
 * @property {{ kind: (typeof import('../turn-model.js').HANDLED_LINK_KINDS)[number]; ref: string }[]} links
 */

/**
 * `GET /api/turn` — every item of Your turn, grouped.
 * @typedef {object} TurnAnswer
 * @property {{ at: string; n: number; ranAt: string | null; changedAt: string | null }} round - when this was read, and the console's round: `n` rises only when a round changed the turn
 * @property {string} headline - one sentence, composed by rules
 * @property {Record<import('../turn-model.js').TurnGroup, TurnItem[]>} groups
 * @property {HandledRow[]} handled - what the AI handled instead of asking, newest first
 * @property {Record<import('../turn-model.js').TurnGroup, number> & { total: number; handled: number }} counts - per group, the open total, and how many were handled since `seen` (or in the last day)
 * @property {string | null} seen
 * @property {{ count: number; href: string } | null} issues - issue drafts wait on Repo ▸ Issues: how many, and the link
 * @property {TurnItem[]} [headsUp] - the plans' heads-ups (turn-by-turn phase 4): an `## Operator errands` row no bullet names, with its steps — in no group and never counted; optional so a 7.0 answer still reads
 * @property {TurnStrip} [strip] - the page's strip (turn-by-turn phase 9, `server/turn/index.ts` `stripOf`): to do, checking, passed today and the nearest deadline; optional so a 7.0 answer still reads
 */

/**
 * The strip's numbers and its *Next deadline* — `TurnAnswer.strip`.
 * @typedef {object} TurnStrip
 * @property {number} todo
 * @property {number} checking
 * @property {number} passedToday
 * @property {{ at: string; item: string; title: string } | null} nextDeadline
 */

/**
 * One item explained — `GET /api/turn/:id` (quiet-console phase 8; the
 * route is control-tower phase 137's). A LEDGER item's record said in the
 * reader's words: why only a person fits it as a sentence, the guide and the
 * commands it asks for, how it is proven, every verdict so far, who waits on
 * it — and, when the turn shows it, its card. Since turn-by-turn phase 3 a
 * projected item (a gate, an approval card, a relayed question) answers too,
 * with only `id`, `record`, `source`, `kind`, `title`, `slug`, `phase`, `why`,
 * `proofType`, `check`, `timing` and `card`: the ledger's members below are
 * absent on it (`server/service.ts` `turnItemExplain`), which is why the page
 * reads this view for ledger items only.
 * @typedef {object} TurnExplain
 * @property {string} id
 * @property {import('../human-step-model.js').HumanStepKind} kind
 * @property {string} title
 * @property {import('../human-step-model.js').HumanStepState} state
 * @property {string} birth
 * @property {string} slug
 * @property {number} phase
 * @property {import('../turn-model.js').WhyPerson} why
 * @property {'declared' | 'inferred'} whySource
 * @property {string} whyPerson - "<label>: <sentence>."
 * @property {import('../guide-grammar.js').Guide} [guide]
 * @property {string[]} [commands] - every command the guide asks for, in order
 * @property {string[]} [lines]
 * @property {import('../turn-model.js').ProofType} proofType
 * @property {string} [proof]
 * @property {string} [proofWords]
 * @property {number} attempts
 * @property {StepVerdictRecord[]} verdicts
 * @property {string} [escalatedAt]
 * @property {{ slug: string; phase: number; runId?: string; sessionId?: string }[]} waiters
 * @property {string} declaredAt
 * @property {string} at
 * @property {{ kind: string; ref?: string }} [source]
 * @property {string} [note]
 * @property {TurnItem} [card] - the item's card as `GET /api/turn` draws it, when the turn shows the item (turn-by-turn phase 3)
 */

/** `GET /api/turn/:id`'s answer. @typedef {{ ok: true; item: TurnExplain }} TurnExplainAnswer */

/* ------------------------------------------------------------------ *
 * The human-step ledger — `GET /api/human-steps`, `POST /api/human-steps/…`
 * ------------------------------------------------------------------ */

/**
 * One move a step made after its declaration — an open, a check and what it read, a reminder.
 * @typedef {object} HumanStepMoveView
 * @property {import('../human-step-model.js').HumanStepState} state
 * @property {import('../human-step-model.js').HumanStepMove} verb
 * @property {string} at
 * @property {string} [by]
 * @property {string} [note] - words about the move — what a check read, why a person could not; never a value
 * @property {'here' | 'host' | 'terminal'} [where] - where an open happened: this browser, the machine, or the embedded terminal
 * @property {boolean} [pushed]
 * @property {string} [snoozeUntil]
 */

/**
 * One step as `GET /api/human-steps` answers it (`StepView`): the folded step, its window and its moves.
 * @typedef {object} HumanStepRecord
 * @property {string} id
 * @property {import('../human-step-model.js').HumanStepKind} kind
 * @property {string} title
 * @property {import('../human-step-model.js').HumanStepWhere} where
 * @property {import('../human-step-model.js').HumanStepBirth} birth
 * @property {string} slug
 * @property {number} phase
 * @property {string} [runId]
 * @property {string} [sessionId]
 * @property {string} [openUrl]
 * @property {string} [openCommand]
 * @property {string} [proof] - the ref that proves it — a `cmd:` or `gh:` watch — when the step names one
 * @property {string[]} [lines]
 * @property {string} [code] - a `device-code` step's code — the one code a step shows on purpose
 * @property {string} [credential]
 * @property {'host'} [autoOpen]
 * @property {string} [until]
 * @property {string} [dueWhen] - the watch ref an `upcoming` step waits on before it is due (control-tower phase 121)
 * @property {string} [dueAt] - when that ref landed and the step became due — its window starts here, not at the birth
 * @property {import('../human-step-model.js').HumanStepState} state
 * @property {string} declaredAt
 * @property {string} at - when it reached the state it is in
 * @property {number} opened - how often a person opened it — *Open again* included
 * @property {boolean} [pushed]
 * @property {'keychain' | 'file'} [stored]
 * @property {string} [note]
 * @property {string} [notifiedAt]
 * @property {number} [reminders]
 * @property {string} [remindedAt]
 * @property {string} [openedAt]
 * @property {number} [checks]
 * @property {string} [checkedAt]
 * @property {string} [read] - what the proof read at the last check, in its own words
 * @property {string} [snoozeUntil]
 * @property {string} [actedAt]
 * @property {string} [provenBy]
 * @property {string} [windowEnd] - when the window closes — seven days when the step named none
 * @property {string | null} [nextReminderAt]
 * @property {HumanStepMoveView[]} [moves]
 * @property {import('../turn-model.js').WhyPerson} [why] - Your turn (control-tower phase 130), the record's v2 fields: why only a person fits it — declared by the raiser, or the kind's default (`inferred`)
 * @property {'declared' | 'inferred'} [whySource]
 * @property {import('../guide-grammar.js').Guide} [guide] - the full guide, as the one grammar parsed it
 * @property {number} [effortMin] - how many minutes it takes the person
 * @property {{ slug: string; phase: number }[]} [unblocks] - the phases it unblocks
 * @property {import('../turn-model.js').ProofType} [proofType] - how it is proven
 * @property {string} [proofWords] - the proof in words a person can read
 * @property {{ slug: string; phase: number; runId?: string; sessionId?: string }[]} [waiters] - every session this one item unblocks (G7)
 * @property {{ kind: string; ref?: string }} [source] - what raised it
 * @property {string} [tried] - what the session tried before asking (G4's `--tried`)
 * @property {true} [overruled] - whether that overruled the guard
 * @property {{ id: string; label: string; consequence?: string; recommended?: true }[]} [options] - the owner's moves (control-tower phase 133): a decision's options, one recommended
 * @property {boolean} [allowDecline] - whether the person may decline it
 * @property {string} [decisionKey] - the `## Decisions` key the decision answers — its answer goes to the plan's table first
 * @property {StepAnswerRecord} [answer]
 * @property {{ at: string; text: string; by?: string; door?: string }[]} [question]
 * @property {StepEvidenceRecord[]} [evidence]
 * @property {string} [secretWhere] - `secret-entry`: where the value goes, in words — the console never takes it
 * @property {number} [attempts] - the check (phase 134): how many checks it had
 * @property {StepVerdictRecord} [verdict] - the last verdict
 * @property {StepVerdictRecord[]} [verdicts] - every verdict
 * @property {string} [escalatedAt] - the escalation
 * @property {PermissionRecord} [permission] - a permission item's record (phase 135): what stopped the AI, why it was needed, its risk, what Grant does today
 */

/**
 * A permission item's record (control-tower phase 135, #212) — the server's
 * `PermissionDetail` (`server/permissions/walls.ts`): the wall, the tool, the
 * rule, the command, why the phase needed it, the risk tier, the scopes a
 * grant may be offered at (none for `never`, with why and the manual path) and
 * what Grant does until phase 149 — the broker's Allow or the widen's strike.
 * @typedef {object} PermissionRecord
 * @property {(typeof import('../turn-model.js').WALLS)[number]} wall
 * @property {string} [tool]
 * @property {string} [rule]
 * @property {string} [command]
 * @property {string} [need]
 * @property {(typeof import('../turn-model.js').RULE_FAMILIES)[number]} [family]
 * @property {(typeof import('../turn-model.js').RISK_TIERS)[number]} [risk]
 * @property {(typeof import('../turn-model.js').GRANT_SCOPES)[number][]} [scopes]
 * @property {{ why: string; manual: string }} [never]
 * @property {{ effect: 'broker' | 'strike'; approvalId: string; label: string } | { effect: 'capability'; label: string }} [grant]
 * @property {string} [ownRule]
 * @property {'hook' | 'cli' | 'landing' | 'preflight' | 'broker'} [source]
 * @property {string} [at]
 */

/**
 * One verdict (phase 134): passed, rejected with what to redo, or needs-info — and who wrote it.
 * @typedef {object} StepVerdictRecord
 * @property {(typeof import('../turn-model.js').VERDICTS)[number]} state
 * @property {string} note
 * @property {string[]} redo
 * @property {string[]} read
 * @property {string} at
 * @property {(typeof import('../turn-model.js').VERDICT_BY)[number]} by
 * @property {number} attempt
 * @property {true} [unverified]
 */

/**
 * A decision's answer: the option chosen (id and label), the note, and the door it came through.
 * @typedef {object} StepAnswerRecord
 * @property {string} [option]
 * @property {string} [label]
 * @property {string} [note]
 * @property {string} at
 * @property {string} [by]
 * @property {string} [door]
 */

/**
 * One piece of evidence, as the ledger keeps it — by content hash; the bytes stay on the machine.
 * @typedef {object} StepEvidenceRecord
 * @property {number} attempt
 * @property {'note' | 'image' | 'file'} kind
 * @property {string} ref
 * @property {number} bytes
 * @property {string} mime
 * @property {string} [name]
 * @property {string} at
 * @property {string} [by]
 */

/**
 * What a person attaches (`POST /api/human-steps/:id/evidence`): a note's text, or a file or an image as base64.
 * @typedef {{ kind: 'note'; text: string; name?: string } | { kind: 'image'; data: string; mime: string; name?: string } | { kind: 'file'; data?: string; text?: string; name?: string }} StepEvidenceInput
 */

/**
 * One waiter an answer or a decline resumed — or why it could not.
 * @typedef {{ slug: string; phase: number; launched: boolean; why?: string }} StepResume
 */

/**
 * The reminder clock's words, as the list answers them.
 * @typedef {{ start: string; end: string }} ReminderQuiet
 */

/**
 * `GET /api/human-steps` — every step (or `?open=1`, the ones still waiting on a person).
 * @typedef {object} HumanStepsList
 * @property {HumanStepRecord[]} steps
 * @property {{ series: number[]; quiet: ReminderQuiet | null; windows: ReminderQuiet[] }} reminders - `windows` are the devices' quiet hours a reminder waits out (control-tower phase 138), `quiet` the one window when every such device shares it, else null
 * @property {{ openHost: boolean; terminal: boolean; resume: boolean }} can - what this console can do on the machine: open a link there, run a command, resume a session
 */

/**
 * A terminal the console minted for a step's command — the sessions pane's lazy door opens it.
 * @typedef {{ sessionId: string; token: string; expiresAt: number }} StepTerminalTicket
 */

/**
 * What a verb answers: the step as it now reads, and the verb's own fact.
 * @typedef {object} StepVerbAnswer
 * @property {true} ok
 * @property {HumanStepRecord} [step]
 * @property {{ url: string; where: 'host' }} [confirm] - *Open on the machine* first answers the full URL; the second press sends it back as `confirm`
 * @property {{ n: number; where: 'here' | 'host' | 'terminal'; what: 'url' | 'command'; url?: string; command?: string; terminal?: StepTerminalTicket; why?: string }} [opened] - an open; `why` says why the embedded terminal did not open — the command then runs in a terminal of the person's own
 * @property {{ landed?: boolean; read?: string; ref?: string; state?: string; by?: string; attempt?: number; why?: string }} [check] - a check's answer — since phase 134 its verdict's state too, or `checking` while the checker reads
 * @property {StepVerdictRecord} [verdict]
 * @property {true} [escalated]
 * @property {{ at: string }} [rewrite]
 * @property {{ to: 'opened' | 'returned'; attempt: number }} [undo] - `undo` (turn-by-turn phase 5): the running check taken back — where the item now stands, and the attempt dropped
 * @property {{ launched: boolean; why?: string }} [resumed]
 * @property {{ until: string }} [snoozed]
 * @property {StepAnswerRecord} [answered] - `answer` / `decline` (phase 133): what was recorded
 * @property {{ reason: string; at: string }} [declined]
 * @property {StepResume[]} [resumes] - the ONE resume each waiter got
 * @property {{ key: string; written: true }} [decision]
 * @property {{ at: string; text: string }} [asked]
 * @property {{ ref: string; kind: StepEvidenceRecord['kind']; bytes: number; attempt: number }} [attached]
 * @property {true} [already] - *Make it a person's turn* pressed a second time: the step the first press made
 */

/**
 * `POST /api/human-steps/:id/open` — `here` answers the link for this browser; `host` opens it on the machine.
 * @typedef {{ where?: 'here' | 'host'; what?: 'url' | 'command'; confirm?: string }} StepOpenBody
 */

/** A verb's optional words — `check`, `dismiss`, `override`, `rewrite`. @typedef {{ note?: string }} StepNoteBody */

/** `snooze` — for how long, minutes. @typedef {{ minutes?: number }} StepSnoozeBody */

/** `cannot`, `decline` — the person's reason. @typedef {{ reason: string }} StepReasonBody */

/** `deny` — the reason is optional. @typedef {{ reason?: string }} StepDenyBody */

/** `answer` — one of its options, a note, or both. @typedef {{ option?: string; note?: string }} StepAnswerBody */

/** `ask` — the question. @typedef {{ text: string }} StepAskBody */

/** `grant` — one scope the item offers; a high one carries the rule typed back. @typedef {{ scope: string; rule?: string; reason?: string }} StepGrantBody */

/** `POST /api/human-steps/suspected` — a silent lane's suspected step, converted on a person's word. @typedef {{ slug: string; phase: number }} StepSuspectedBody */

/**
 * Every route this family owns → the typedef its response is (and, for a write, the one it takes).
 * @type {Readonly<Record<string, { response: string, body?: string }>>}
 */
export const WIRE_ROUTES = Object.freeze({
  'GET /api/turn': { response: 'TurnAnswer' },
  'GET /api/turn/:id': { response: 'TurnExplainAnswer' },
  'POST /api/turn/:id/cannot': { response: 'TurnCannotAnswer', body: 'TurnCannotBody' },
  'POST /api/turn/:id/hand-off': { response: 'TurnHandOffAnswer', body: 'TurnHandOffBody' },
  'POST /api/turn/:id/note': { response: 'TurnNoteAnswer', body: 'TurnNoteBody' },
  'GET /api/human-steps': { response: 'HumanStepsList' },
  'POST /api/human-steps/suspected': { response: 'StepVerbAnswer', body: 'StepSuspectedBody' },
  'POST /api/human-steps/:id/open': { response: 'StepVerbAnswer', body: 'StepOpenBody' },
  'POST /api/human-steps/:id/check': { response: 'StepVerbAnswer', body: 'StepNoteBody' },
  'POST /api/human-steps/:id/snooze': { response: 'StepVerbAnswer', body: 'StepSnoozeBody' },
  'POST /api/human-steps/:id/cannot': { response: 'StepVerbAnswer', body: 'StepReasonBody' },
  'POST /api/human-steps/:id/dismiss': { response: 'StepVerbAnswer', body: 'StepNoteBody' },
  'POST /api/human-steps/:id/answer': { response: 'StepVerbAnswer', body: 'StepAnswerBody' },
  'POST /api/human-steps/:id/decline': { response: 'StepVerbAnswer', body: 'StepReasonBody' },
  'POST /api/human-steps/:id/ask': { response: 'StepVerbAnswer', body: 'StepAskBody' },
  'POST /api/human-steps/:id/evidence': { response: 'StepVerbAnswer', body: 'StepEvidenceInput' },
  'POST /api/human-steps/:id/override': { response: 'StepVerbAnswer', body: 'StepNoteBody' },
  'POST /api/human-steps/:id/rewrite': { response: 'StepVerbAnswer', body: 'StepNoteBody' },
  'POST /api/human-steps/:id/undo': { response: 'StepVerbAnswer' },
  'POST /api/human-steps/:id/deny': { response: 'StepVerbAnswer', body: 'StepDenyBody' },
  'POST /api/human-steps/:id/convert': { response: 'StepVerbAnswer' },
  'POST /api/human-steps/:id/grant': { response: 'StepVerbAnswer', body: 'StepGrantBody' },
  'GET /api/inbox': { response: 'InboxView' },
  'POST /api/inbox/ack': { response: 'InboxAckAnswer', body: 'InboxAckBody' },
  'DELETE /api/inbox/ack': { response: 'InboxAckAnswer' },
});
