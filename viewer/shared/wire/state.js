/**
 * The wire of the console shell — `/api/state` and its preferences, the live stream, the
 * console's own reads (the directory picker, restart and shutdown, search, the portfolio, the
 * machine's ceilings) and the admission queue's shapes the queue family answers with
 * (measured-console phase 32).
 */

/**
 * A directory the console has read, as `/api/state` reports it.
 * @typedef {object} RootInfo
 * @property {string} [path]
 * @property {string} [label]
 * @property {boolean} [ok]
 * @property {string} [docsDir]
 * @property {string} [plansDir]
 * @property {number} [planCount]
 * @property {number} [handoffCount]
 * @property {string} [reason]
 */
/**
 * The phase weights and session budgets the engine's `sizing.env` declares (`server/analysis/graph.ts`
 * `Sizing`). Optional on this side: an older server sent fewer keys.
 * @typedef {object} Sizing
 * @property {number} [S]
 * @property {number} [M]
 * @property {number} [L]
 * @property {number} [budgetHaiku]
 * @property {number} [budgetBig]
 * @property {number} [budgetDefault]
 * @property {number} [budget1m] - Any model carrying the `[1m]` window suffix.
 * @property {number} [bootFloor] - The session model (control-tower phase 59, #83): a fresh phase session's peak context ≈ `bootFloor + workFloor + slopePct/100 × weight`.
 * @property {number} [workFloor]
 * @property {number} [slopePct]
 * @property {number} [targetPct] - The share of the window a session is sized to stay under (the console's wrap-up line).
 * @property {Record<'S' | 'M' | 'L', { noWrapX100: number; wrapX100: number; wrapPct: number }>} [sessions] - Measured sessions per phase, by size and by whether the phase wrapped — the forecast's unit.
 */
/**
 * What `lifecycle.ts` reports about whatever started this process.
 *
 * `supervised` — not `ok`. The field was declared as `ok` here and has always
 * been sent as `supervised`, so every read of it was `undefined`; nothing
 * happened to notice because only `detail` was ever read. A page that gated a
 * button on it would have found the console permanently unsupervised.
 * @typedef {object} SupervisorInfo
 * @property {boolean} [supervised] - Whether a clean exit is expected to come back.
 * @property {'launchd' | 'systemd' | 'declared' | 'none'} [kind]
 * @property {string} [detail]
 * @property {boolean} [assumed] - True when supervision is inferred rather than read from a plist.
 */
/**
 * How full the console is right now: lanes in use, lanes allowed, and anything
 * waiting for a scope to clear.
 *
 * `throttledUntil` is an ACCOUNT usage window, not a per-run one — the soonest
 * expiry across every throttled account, kept for older readers. With several
 * accounts, `throttledAccounts` says which login was told to come back when;
 * a run paying with a different one keeps going.
 * @typedef {object} Concurrency
 * @property {number} max
 * @property {number} live
 * @property {number} queued
 * @property {number | null} throttledUntil
 * @property {{ accountId: string; until: number }[]} [throttledAccounts]
 * @property {{ open: boolean; opensAt: number | null; reason: string | null } | null} [schedule] - The boarding schedule's answer at the moment of the snapshot, or null when no policy is set. Present even when OPEN, so a header can say what the schedule thinks without a phase having to fail to start first.
 * @property {{ live: number; max: number }} [console] - This console's own ceiling — `max`/`live` above, named (zero-touch phase 17, FLT-7).
 * @property {{ live: number; max: number | null } | null} [machine] - Every console's live lanes on this machine against `fleet.json` `maxSessions`; null when not wired.
 */
/**
 * The panic button's state: is this whole console frozen, since when, by whom?
 *
 * One shape read from two places — `/api/state` (where the app-wide banner
 * gets it) and the `run:queue` event (which the freeze/thaw verbs emit) — so
 * the banner and the queue page can never disagree about whether the console
 * is switched off.
 * @typedef {object} FleetState
 * @property {boolean} frozen
 * @property {string | null} at
 * @property {string | null} by
 * @property {string | null} [url] - The machine's supervisor, when this build knows of one: its loopback URL. Absent on a build without it.
 * @property {boolean} [reachable] - Does a supervisor beat on this machine right now? What offers the machine-wide destination.
 * @property {{ at: string; by: string; scope?: 'machine' | 'restart' } | null} [hold] - A hold on every console of the machine, beside this console's own freeze.
 */
/**
 * `state.reach` — the Settings card's one line about the fleet's door.
 * @typedef {object} ReachState
 * @property {string} mode
 * @property {string | null} host
 * @property {number | null} port
 * @property {string | null} exposure
 * @property {string | null} door
 */
/**
 * Why this console boots holding its automation (SHD-5, FLT-9): `stopped` — a
 * Shut down with "stay off" left its marker; `autostart-off` — the machine
 * profile says this console does not start its work unattended. Nothing is
 * re-adopted or converged until it is released. Null when nothing holds.
 * @typedef {object} BootHold
 * @property {import('../ops-vocab.js').BootHoldKind} kind
 * @property {string} at
 * @property {string} by
 * @property {string} why
 * @property {{ resurrect?: string; label?: string; durability?: string }} [marker]
 */
/**
 * A holder's remaining time, as the queue reports it (`HolderEta` on the
 * server). `of` says whose: the holder `phase` (its estimate minus what it has
 * worked — what the wait actually runs to), or its `plan` where no phase is
 * known. A figure from before 6.0 has no `of`, and was always the plan's.
 * @typedef {object} HolderEtaView
 * @property {number} [remainingWeight]
 * @property {string} [label]
 * @property {'phase' | 'plan'} [of]
 * @property {number} [remainingMs]
 * @property {number} [lowMs]
 * @property {number} [highMs]
 * @property {boolean} [overrun]
 */
/**
 * Who is holding a scope an entry is waiting on, and which tokens collided.
 * @typedef {object} QueueHolder
 * @property {import('../run-lifecycle.js').HolderKind} kind
 * @property {string} slug
 * @property {number | null} phase
 * @property {string} owner
 * @property {string[]} scope
 * @property {string[]} overlaps
 * @property {number} [leaseUntil] - When a `lock` holder's lease lapses (ms epoch) — "lease ends <t>".
 * @property {string} [branch] - The branch this holder's work rides, when it declared one. The scheduler has carried it since phase 8 (`Holder.branch`) and this type dropped it. Reported, never acted on: by the time a holder exists the branch question has already been asked and answered against it. Its job is to let the wait read in reverse — "queued behind X, **and X is on your branch**" is the difference between a collision that could have been carved out of and one that could not.
 * @property {string} [tree] - The working tree the holder's work rides, when it declared one.
 * @property {{ claim: 'this' | 'holder'; missing: ('branch' | 'tree')[]; reason: string }} [unqualified] - The carve-out would have parted this pair but for a dimension a claim left undeclared (`Holder.unqualified`, control-tower phase 90, #149) — `claim` says whose (`this` is the waiting entry's) and `reason` is the sentence: "blocked: this claim declares no branch, so the carve-out cannot apply".
 * @property {HolderEtaView} [eta] - How much longer the holder has (`Holder.eta`) — the holder PHASE's remaining working time since control-tower phase 60 (#63), or its plan's, labelled `plan remaining`, where no phase is known. See `holderEtaText`. The question a queue could not answer: *how long*. Absent whenever nothing is known, because a number invented for the card would read exactly like a measured one.
 * @property {string} [session] - The holding session's id (`Holder.session`, off the lock's `session=`). Third of the three fields the scheduler has always sent and this type dropped — `entryFields` passes `waitingOn` through verbatim, so every one of them has been on the wire the whole time. Without it a queue can say a session is in the way and give no way to go and look at it.
 * @property {'live' | 'unknown'} [presence] - What the session registry says about that session (`Holder.presence`). `live` — somebody (or another console) is in it right now, so this is a queue to WAIT IN rather than a lease to outlive; `unknown` — no hook reports it and the lease rules decide. An `ended` session's lock never reaches a holder at all: it lapses the moment the registry says so. The distinction is the difference between "this clears when they finish" and "this clears when the lease lapses", and a page that cannot draw it offers a takeover for the first and patience for the second.
 * @property {number} [pid] - A `session` holder's process (REG-3) — a peer in the repository that holds no lock yet.
 * @property {string} [cwd] - A `session` holder's working directory: where the peer is standing.
 * @property {'declared' | 'touched' | 'unknown' | (string & {})} [scopeBasis] - How a `session` holder's scope was read (control-tower phase 82, #119): `declared` (its `PE_SCOPE`), `touched` (what its transcript shows it edited, changed or named), `unknown` (nothing touched yet — what its cwd could reach, for a bounded lease). The card names the terminal by it.
 * @property {string[]} [evidence] - What that reading rests on, a few lines.
 * @property {true} [clock] - This holder is a CLOCK, not another actor (`Holder.clock`): the operator's boarding window, the live-session cap, an account's usage wall, a fleet freeze, a hold, a chain. ⚠️ **Never render a clock as somebody to go and find.** There is nobody to name, nothing to release, and the wait ends by itself at a moment that is already known. `kind: 'reserved'` is the neighbouring signal but not the same one — the scheduler sets `clock` explicitly, and the runner's own admission cap reads it so that a wait on a clock is never capped into a park (D2: parking a phase for waiting exactly as long as it was told to is the console punishing its own policy).
 * @property {{ run: string; slug: string; remainingPhases?: number }} [holderRun] - A `branch` holder is a RUN (control-tower phase 90, #150): which run, of which plan, with how many phases left — and the ways out a person can take instead of waiting for it to finish.
 * @property {{ verb: string; label: string; endpoint: string; method: 'POST'; body?: Record<string, unknown> }[]} [escapes]
 */
/**
 * @typedef {object} QueueEntry
 * @property {string} id
 * @property {string} slug
 * @property {number | null} phase
 * @property {string} runId
 * @property {string[]} scope
 * @property {string} [branch] - The branch THIS entry's session would commit on, when qualified. The server has always sent it (`entryFields`); this type dropped it, so the queue page could name the holder's branch and never the requester's — "you: pe/x · them: pe/y" needs both halves.
 * @property {string} [tree] - The working tree this entry's session would edit, when qualified.
 * @property {string} [accountId] - The account this entry's session would spend — `default` for the machine login (control-tower phase 78, #92). A switch re-keys it, so an entry held by `usage window · account A` while it names account B is a defect you can see, not one only the code can say.
 * @property {number} since
 * @property {QueueHolder[]} waitingOn
 * @property {number} bypassed
 * @property {boolean} reserving
 * @property {import('../orchestration-model.js').RunPriority} [priority] - The scan class. Absent means `normal` — see `shared/orchestration-model.js`.
 * @property {true} [bumped] - An operator moved this entry to the front of its class.
 * @property {{ at: string; by?: string }} [held] - The run is held: nothing of it boards until someone releases it.
 * @property {string} [after] - The plan this entry is chained behind and still waiting on.
 * @property {number} [order] - Its place in the scan, 0-based — the order it will board in.
 * @property {QueueControl} [control] - An operator's marks on it, with who and why (control-tower phase 99, #135).
 */
/**
 * Who set an operator's queue mark, when, and why (control-tower phase 99).
 * @typedef {object} QueueMark
 * @property {string} at
 * @property {string} [by]
 * @property {string} [reason]
 */
/**
 * An operator's standing word on one phase's place in the queue — on the
 * phase's record (`PhaseRecord.queueControl`), so it outlives the entry.
 * @typedef {object} QueueControl
 * @property {QueueMark & { stamp: number }} [bump]
 * @property {QueueMark} [hold]
 * @property {QueueMark & { until: string }} [defer]
 * @property {QueueMark} [withdrawn]
 * @property {QueueMark} [pin] - Pinned next in its plan (control-tower phase 100) — spent when it boards.
 * @property {QueueMark & { lane?: { slug: string; phase: number }; via?: 'yield' }} [reserve] - The next lane on its scope is kept for it (control-tower phase 100) — spent when it boards.
 * @property {QueueMark & { anchor: { slug: string; phase: number } | 'first' | 'last'; side: 'before' | 'after'; stamp: number }} [order] - An operator's order (one-pool phase 39): first, last, or before/after a phase of any open plan. Spent when it boards; it lapses when its anchor settles or is withdrawn.
 */
/**
 * A press the queue view carries — the route and body that act on a row.
 * @typedef {object} QueuePress
 * @property {string} verb
 * @property {'POST'} method
 * @property {string} endpoint
 * @property {Record<string, unknown>} body
 */
/**
 * One entry as `GET /api/queue` widens it (control-tower phase 99, #135 A):
 * everything the queue page shows, so the CLI and the supervisor read the
 * same words a person does.
 *
 * - `position`: 1-based place in the scan.
 * - `class`: The class, always named — `normal` included.
 * - `account`: The account it will board on, always named — `default` included.
 * - `reason`: Why it sits where it does: the first of the scan's keys that applies, and all that do.
 * - `waits`: What it waits on, in words.
 * - `pinned`: Pinned next in its plan (control-tower phase 100).
 * - `laneReserved`: A lane is kept for it (control-tower phase 100).
 * - `promotion`: The scheduling policy's promotion, when one applies.
 * - `share`: Its fair-share turn, when the turn put it behind a younger entry of another plan.
 * @typedef {QueueEntry & {
 *   waitingOn: (QueueHolder & { laneWait?: QueueLaneWait })[];
 *   position: number;
 *   title?: string;
 *   class: string;
 *   account: string;
 *   clocks: { since: string; waitedMs: number; seniority?: { clock: string; since: string } };
 *   reason: { key: string; text: string; all: { key: string; text: string }[] };
 *   waits: string;
 *   pinned?: true;
 *   laneReserved?: { by?: string; reason?: string; lane?: { slug: string; phase: number } };
 *   promotion?: { policy: string; rank: number; text: string; holdsSiblings?: boolean };
 *   share?: { round: number; lanes: number };
 * }} QueueViewEntry
 */
/**
 * The machine-load guard's reading (control-tower phase 100). `factor` null: the guard is off.
 * @typedef {object} QueueLoad
 * @property {number} avg5
 * @property {number} cores
 * @property {number | null} factor
 * @property {number | null} threshold - The 5-minute average's ceiling (one-pool phase 26: `factor × cores × 2`).
 * @property {number | null} [busy] - The share of the CPU busy over the last 30 s, 0–1, or null before two samples.
 * @property {number | null} [busyLimit] - The CPU-busy share new work waits at.
 * @property {boolean} holding
 * @property {'cpu' | 'ceiling' | null} [cause] - What holds: the CPU, the 5-minute ceiling, or nothing.
 */
/**
 * A lane kept for a phase (control-tower phase 100) — armed once the lane it waits for has ended.
 * @typedef {object} QueueReservation
 * @property {string} slug
 * @property {string} runId
 * @property {number} phase
 * @property {string[]} scope
 * @property {string} at
 * @property {boolean} armed
 * @property {string} [by]
 * @property {string} [reason]
 * @property {{ slug: string; phase: number }} [lane]
 */
/**
 * A lane in a wait chain — polling its own job, or on an outside clock (#67).
 * @typedef {object} QueueLaneWait
 * @property {'local' | 'external'} scope
 * @property {number} minutes
 * @property {number} [calls]
 * @property {string} text
 */
/**
 * @typedef {object} QueueLane
 * @property {string} slug
 * @property {number | null} phase
 * @property {string} runId
 * @property {string[]} scope
 * @property {string} account
 * @property {string} since
 * @property {string} [title]
 * @property {QueueLaneWait} [wait]
 * @property {{ slug: string; phase: number | null }[]} behind - The entries whose head holder is this lane.
 */
/**
 * @typedef {object} QueueHintedRow
 * @property {string} slug
 * @property {string} runId
 * @property {number} phase
 * @property {string} since
 * @property {number} waitedMs
 * @property {string} rung
 * @property {string | null} brief
 * @property {string | null} by
 * @property {number} [serialBehind]
 * @property {string} [title]
 * @property {string} why
 * @property {QueueControl} [control]
 * @property {QueuePress} queue - The press that queues it now.
 */
/**
 * @typedef {object} QueueWithdrawnRow
 * @property {string} slug
 * @property {string} runId
 * @property {number} phase
 * @property {string} at
 * @property {string} by
 * @property {string} [reason]
 * @property {string} [title]
 * @property {string} text
 * @property {QueuePress} requeue
 */
/**
 * One queue change, as the audit strip shows it — newest first.
 * @typedef {object} QueueAuditRow
 * @property {string | null} at
 * @property {string} slug
 * @property {string} runId
 * @property {number | null} phase
 * @property {string} verb
 * @property {string | null} by
 * @property {string} [reason]
 * @property {string} text
 */
/**
 * `GET /api/queue`, widened (control-tower phase 99).
 *
 * - `policy`: The scheduling policy — the console's, each plan's own, the default (control-tower phase 100).
 * - `load`: The machine-load guard's reading.
 * - `reservations`: The lanes kept for a phase.
 * @typedef {Omit<QueueSnapshot, 'entries'> & {
 *   entries: QueueViewEntry[];
 *   lanes: QueueLane[];
 *   hinted: QueueHintedRow[];
 *   withdrawn: QueueWithdrawnRow[];
 *   audit: QueueAuditRow[];
 *   policy?: { console: string; plans: Record<string, string>; default: string };
 *   load?: QueueLoad;
 *   reservations?: QueueReservation[];
 * }} QueueView
 */
/**
 * What it would cost to let one queued plan go first — advisory ONLY.
 *
 * Nothing on the server reads this back: the scheduler never reorders itself,
 * and this is the figure an operator looks at before deciding to. Every field
 * is nullable because an estimate exists only once something of that plan has
 * finished, and a made-up number would be indistinguishable from a measured
 * one on the page that draws it.
 * @typedef {object} QueueAdvice
 * @property {string} slug
 * @property {number | null} remainingWeight
 * @property {number | null} remainingPhases
 * @property {string | null} label
 */
/**
 * - `advice`: Present on `GET /api/queue` and deliberately absent from the `state` payload and the `run:queue` event: it costs a board read per queued plan, and those two are emitted on every admission change.
 * @typedef {Concurrency & {
 *   grants: { id: string; slug: string; phase: number | null; runId: string; scope: string[]; at: number }[];
 *   entries: QueueEntry[];
 *   advice?: QueueAdvice[];
 * }} QueueSnapshot
 */
/**
 * A phase's declared scope, and what it would collide with if started now.
 * @typedef {object} PhaseScope
 * @property {number} phase
 * @property {string[]} scope
 * @property {string[]} conflicts
 */
/**
 * @typedef {object} InstanceInfo
 * @property {string} id
 * @property {string} name
 * @property {boolean} pinned - A console that serves one project and refuses to be repointed.
 */
/**
 * How many cards a console has put in front of a person, and since when
 * (`server/runner/approvals.ts` `ApprovalCounts`, plus the cards up right now).
 * @typedef {object} ApprovalCounts
 * @property {number} raised
 * @property {number} autoGranted
 * @property {string} since
 * @property {string | null} lastRaisedAt
 * @property {number} pending
 */
/**
 * One config dir's plugin install of the skill, as `server/skill-copy.ts` reads `installed_plugins.json`.
 * @typedef {object} SkillCopyEntry
 * @property {string} configDir
 * @property {{ id: string; scope: string; installPath: string; version: string | null; commit: string | null } | null} install
 * @property {string | null} skillDir - A `skills/phased-execution` directory beside the plugin — a second copy.
 * @property {string} [parseError]
 */
/**
 * The skill copies sessions load, against the console's commit (#151) — `SkillCopyReport` on the wire.
 * @typedef {object} SkillCopyView
 * @property {string} plugin
 * @property {string | null} consoleRev
 * @property {SkillCopyEntry[]} copies
 * @property {SkillCopyEntry[]} drift - The copies at another commit than the console's; empty when either side is unknown.
 * @property {string} update - How a person moves the skill to the console, in this edition's words.
 */
/**
 * `GET /api/state` — the console shell's one read: who this console is, its flags, its
 * preferences, how full it is and what holds it. Every member is optional: a new client can be
 * talking to an older server, and a missing answer reads as "this server cannot say".
 * @typedef {object} ConsoleState
 * @property {number} [generation] - Counts the docs changes this console has read; rides the `hello` and `changed` frames too.
 * @property {string[]} [execArgv] - The arguments node started this process with — the heap limit among them (phase 48).
 * @property {RootInfo | null} [root] - The open source directory; null while none is open (the server sends `null`, never omits it).
 * @property {InstanceInfo} [instance] - Which console this is, on a machine that may be running several. Optional like everything else on this type: a new client can be talking to a server started before instances existed, and every consumer must read a missing answer as "this server cannot say" rather than inventing one.
 * @property {boolean} [allowWrites]
 * @property {boolean} [allowRun]
 * @property {{ issues: { kind: string; detail: string; fix: string }[] }} [environment] - The environment doctor's findings (PATH rot, broken push delivery).
 * @property {boolean} [allowTerminal] - `--allow-terminal`: the shell gate the nav reads on every page.
 * @property {boolean} [allowAgent] - `--allow-agent`: interactive claude sessions in the browser terminal.
 * @property {boolean} [allowAccounts] - `--allow-accounts`: registering Claude accounts. The meters are always on.
 * @property {boolean} [allowMcp] - Whether MCP servers may be REGISTERED here. Reading the registry, the catalog and the connection statuses never needs it.
 * @property {boolean} [allowWebhooks] - `--allow-webhooks`: whether outbound webhook destinations may be REGISTERED here — and, underneath, whether any POST is made at all. Reading the destination list never needs it.
 * @property {boolean} [allowPublish] - `--allow-publish`: whether a finished phase's `pe/*` branch may be pushed and an issue draft filed on the repository. Off means the landing engine holds and `Issues: file` holds drafts for a person — the launch form says so beside the two controls.
 * @property {boolean} [autopilot]
 * @property {boolean} [serverStale] - True once `server/` on disk is newer than the process serving this page.
 * @property {string} [bootedAt] - When the process serving this page started — also its identity: a restart is over for a page when the console answers with a different one. Absent from a server before 2026-09-18.
 * @property {import('./system.js').RestartUpdateView | null} [restartUpdate] - A restart's update, while it runs and after it answered. Absent where the console cannot update itself.
 * @property {'dist' | 'not-built'} [staticRoot] - Which static root answered — the migration seam, surfaced in Settings.
 * @property {string | null} [distRev] - The commit `dist` was built from (`dist/.build-rev`); null when unstamped.
 * @property {SkillCopyView | null} [skillCopy] - The skill copy each Claude Code config dir's sessions load, against the console's commit (control-tower phase 98, #151) — `server/skill-copy.ts`. Absent from a server before it.
 * @property {SupervisorInfo} [supervisor]
 * @property {number} [unread]
 * @property {ApprovalCounts} [approvals] - Cards raised and auto-granted since the console started counting (TRS-5). Absent on a build before 5.0.0.
 * @property {string} [scriptsDir]
 * @property {string[]} [defaultSkills] - Skills a NEW run would start with (`--default-skills` / `PHASE_CONSOLE_DEFAULT_SKILLS`). Not what a run HAS — that is on the run.
 * @property {string[]} [models] - Every model this console will START a phase on, strongest first — the server's own `offeredModels()`, read from `scripts/models.env`. Optional like everything else here: an older server cannot say, and the form falls back to its build's copy rather than offering nothing. Offering and ACCEPTING are different questions — the door still takes any spelling `models.env` knows, including ones absent from this list.
 * @property {string[]} [remoteHosts] - `--remote` / `--remote-user`. Optional like everything else here: a new client can be talking to a server started before these existed, and a missing answer must read as "this server cannot say", never as "none".
 * @property {string[]} [remoteUsers]
 * @property {{ path: string; present: boolean; sources: Partial<Record<'remoteHosts' | 'remoteUsers' | 'notifyCommand' | 'webhooks' | 'categories' | 'quietHours' | 'maxSessions', string>>; overridden: string[] } | null} [profile] - Where the settings the machine profile can supply came from — a flag, the environment, this console's own override in `fleet.json`, or the machine profile (zero-touch phase 17, FLT-3). Null or absent from an older server.
 * @property {{ served: { local: number; remote: number }; lastRemoteAt: string | null; identities: { host: string; loginHash: string; first: string; last: string; count: number }[] }} [access] - What this console has served, by scope, and when a phone last reached it (FLT-10). Logins are hashed.
 * @property {number} [port] - The port this console is served on — setup commands embed it.
 * @property {string} [platform] - Which OS the SERVER runs on — the setup commands differ per platform.
 * @property {string} [home] - The server's home dir, so absolute paths render as "$HOME/…".
 * @property {Record<string, string>} [refusalReasons] - `REFUSAL_REASON` — the sentence for each `isolationRefusal` KEY a run record can carry (G-20). A surface that meets the key looks it up here and falls back to the key: an older server sends no table, and a newer refusal may not be in this one.
 * @property {Record<string, string>} [refusalFixes] - `REFUSAL_FIX` — what fixes each refusal (control-tower phase 90). A run that asked for its own checkout and was refused PARKS, so the card names the remedy beside the reason.
 * @property {Sizing} [sizing]
 * @property {number} [searchDocs]
 * @property {{ available?: boolean; branch?: string; ahead?: number; behind?: number; dirty?: string[] }} [repo]
 * @property {{ path: string; label: string }[]} [recentRoots]
 * @property {{ healthy?: boolean; watching?: number; expected?: number; failures?: number; ok?: boolean; detail?: string }} [watcher] - The docs watcher: `healthy`, the folders `watching` of `expected`, and its `failures`. `ok`/`detail` are never sent by this server — kept optional for the readers that still ask.
 * @property {unknown} [health]
 * @property {unknown[]} [runs] - Every live run. The singular `run` field is gone — "the first live run of ANY plan" reads plan B's run while looking at plan A the moment two drive.
 * @property {Concurrency} [concurrency] - How full the console is, straight from the scheduler.
 * @property {{ slug: string; runId: string; phases: number[]; sessions: string[]; at: string }[]} [resumeAsk] - Runs this console's own restart stopped, waiting on an answer (`resumeAtBoot: 'ask'`). Empty on every normal load; the app opens the question only when there is one. Absent on a server before 3.5.0.
 * @property {FleetState} [fleet] - The panic button: is this whole console frozen, since when, by whom? On the state rather than only on `/api/queue` because the banner it drives renders on EVERY destination — a frozen console has to say so on whatever page the operator is looking at, not only on the one about runs. Absent from an older server, which reads as not frozen.
 * @property {ReachState} [reach] - How a phone reaches the fleet (many-plans-one-repo phase 23): the machine profile's mode, where the direct door is, and the door's state as the supervisor's beat last said — `null` while no live supervisor runs one. Absent from a free build and from a server before 5.1.0.
 * @property {BootHold | null} [bootHold] - See `BootHold`. Absent from a server before 5.0.0, which never held.
 * @property {ConsolePrefs} [prefs] - Server-side preferences — see `ConsolePrefs`.
 * @property {import('./system.js').OwnerDoorState} [ownerDoor] - The owner door as THIS request sees it (control-tower phase 148): `unlocked` when it carries a live owner session.
 */
/**
 * Server-side preferences (`server/config.ts` `Prefs`) — what `state.prefs` carries and
 * `POST /api/prefs` answers with, every key sanitised. `notify` is the global per-category switch the
 * console consults before it announces anything at all — server truth, deliberately NOT mirrored into
 * `lib/prefs.ts` (browser-local UI settings), because a notification suppressed in one tab has to stay
 * suppressed for the process, not for the tab that happened to set it.
 * @typedef {object} ConsolePrefs
 * @property {Record<string, boolean>} [notify]
 * @property {string} [theme] - The five person-wide keys (`config.json`, every console of the person): the plans library's order and the model a session plan is sized for are read from here (quiet-console phase 21); the theme, the density and the palette (#362) stay this browser's own (`lib/prefs.ts`).
 * @property {string} [density]
 * @property {string} [palette]
 * @property {string} [sort]
 * @property {string} [model]
 * @property {boolean} [attachDefaultSkills] - Automation defaults — the opening values for every launch surface. Each launch can override them for itself. Resolve absent keys through `automationPrefs`, never ad hoc, so every surface agrees on defaults.
 * @property {boolean} [qaByDefault]
 * @property {import('../run-lifecycle.js').GitMode} [gitMode]
 * @property {boolean} [openPrOnComplete]
 * @property {import('../worktree-model.js').SettleStrategy} [settle] - What a finished work branch does by default — `SETTLE_STRATEGIES`. The newer, more specific spelling of `openPrOnComplete`. Never read on its own: a `config.json` written before it existed carries only the boolean, and the server hands back a `settle` that is merely the shipped default beside it. `automationPrefs` below does the fold.
 * @property {boolean} [reviewEachPhaseByDefault]
 * @property {import('../run-lifecycle.js').ReviewerPolicy} [reviewerPolicy]
 * @property {boolean} [repoGuard]
 * @property {boolean} [radarSerialize] - Serialise a `conflicted` radar pair by landing order (phase 9). Off by default.
 * @property {import('../worktree-model.js').IsolationMode} [isolation] - What a new run ASKS for: the shared checkout (`queue`, today's behaviour) or one of its own. Meaningful only with `gitMode: 'new-branch'` — which is why the launch dialog renders its control only there.
 * @property {number} [worktreeMaxConcurrent]
 * @property {string} [worktreeSetup]
 * @property {boolean} [worktreeCopyEnv]
 * @property {import('../worktree-model.js').WorktreeRoot} [worktreeRoot] - Where console-made trees live: inside the project (`.worktrees/`) or the state directory.
 * @property {import('../worktree-model.js').IsolationReclaim} [isolationReclaim] - May a run switch a CLEAN checkout off its run branch to take it?
 * @property {boolean} [deleteMergedRunBranches] - Delete `pe/*` branches once their pull request has MERGED (`-d` only).
 * @property {number} [maxConcurrentPerRepo] - Phase 7's three console defaults, homed with their controls in phase 15: the per-repository cap, what becomes of a settled run's tree, and the base a run branch is cut from when the plan does not say.
 * @property {string} [worktreeRetention]
 * @property {string} [baseBranch]
 * @property {import('../landing-model.js').LandPolicy | (string & {})} [landing] - Phase 15's four launch defaults — the words a fresh run opens on when its plan is silent: `LAND_POLICIES`, `CONFLICT_POLICIES`, `MESSAGING_WORDS`, `ISSUE_MODES`.
 * @property {import('../landing-model.js').ConflictPolicy | (string & {})} [conflictPolicy]
 * @property {import('../message-model.js').MessagingWord | (string & {})} [messaging]
 * @property {import('../issues-model.js').IssueMode | (string & {})} [issuesMode] - These four the server stores as plain strings; read them through their owners' coercers (`automationPrefs` does).
 * @property {string[]} [issueRepos] - The Issues desk's repositories outside this console (control-tower phase 118): `owner/name`s added to read beside the estate. Absent when none.
 * @property {boolean} [autoRecoverByDefault]
 * @property {boolean} [autoContinueRecovery]
 * @property {boolean} [watchCmdRefs]
 * @property {boolean} [watchMintedCmdRefs]
 * @property {import('./runs.js').McpPolicy} [mcpPolicy]
 * @property {number} [ladderPerPhaseRungs] - The remediation ladder's caps and toggles (server `Prefs`; Settings ▸ Automation renders them).
 * @property {number} [ladderPerPhaseUsd]
 * @property {number} [ladderPerRunRungs]
 * @property {number} [ladderPerRunUsd]
 * @property {number} [ladderPerDayUsd]
 * @property {number} [ceilingStartsPerHour] - The per-instance start ceiling (server `start-ceiling.ts`): automatic starts and session dollars per sliding hour; 0 = off.
 * @property {number} [ceilingUsdPerHour]
 * @property {number} [usageForecastLeadHours]
 * @property {boolean} [usageForecastHold]
 * @property {boolean} [unblockAttempts]
 * @property {boolean} [staleClaimTakeover]
 * @property {import('../automation-model.js').ResumeAtBootMode | boolean} [resumeAtBoot] - `ask` (shipped) · `auto` · `off`. A boolean on a console from before 3.5.0 — read it through `resumeAtBootMode`, never directly, because a stored `true` means `ask` and not `auto`.
 * @property {boolean} [autoAccountSwitch]
 * @property {boolean} [delegateHumanGates] - An overdue gate is briefed to the phase's own session to verify and clear — never a `manual` one (#174). ON by default since 5.0.0 (`gates: delegated`) — see `server/config.ts`.
 * @property {Partial<Record<string, string>>} [policy] - This console's answers to the decision manifest's rows, keyed by decision key (`shared/policy-model.js` `DECISION_ANSWERS`). Read below a plan's `## Decisions` row and above the shipped defaults. Phase 12's policy editor writes it.
 * @property {boolean} [allowUnverifiedPhases] - A phase whose plan states no §Verification boards and passes on its handoff alone. Off by default.
 * @property {boolean} [ladderExtendOnProgress] - One more rung, once per phase, when the newest settled rung landed commits. Off by default.
 * @property {number} [convergeEveryMs]
 * @property {number} [budgetAutoRaisePct] - A spent run budget is raised ONCE by this percentage (0 = never) — the resource ladder's `raise-budget` rung.
 * @property {number} [mcpRequireTimeoutMs] - How long a `require` MCP park waits for the server before continuing without it (0 = forever).
 * @property {number} [stallSilentMs] - When a live lane stops being work (`shared/attention-model.js` `STALL_DEFAULTS`, Phase 5). Thresholds, not policy: crossing one announces and journals, it never acts — with the single exception of `stallExternalWaitMs`, which parks the phase and releases its lock, because a lane waiting on somebody else's clock is holding an exclusive claim that blocks every session whose scope intersects it.
 * @property {number} [stallSpinTurns]
 * @property {number} [stallStalemateAttempts]
 * @property {number} [stallRetryBurst]
 * @property {number} [stallExternalWaitMs]
 * @property {number} [stallLoopRun] - Identical failing tool calls in a row before a lane reads as `looping` (phase 13).
 * @property {number} [stallLocalJobMs] - The same call when it waits on a job this session started itself.
 * @property {boolean} [stallAutomaticPark] - May the stall watchdog park a lane by itself? Absent reads as on — see `server/config.ts`.
 * @property {boolean} [checkJudgement] - The check (control-tower phase 134): judgement on, the checker's model and effort, the escalation count.
 * @property {string} [checkModel]
 * @property {string} [checkEffort]
 * @property {number} [turnEscalateAfter]
 * @property {number} [stallEscalateMs] - The clock on the ANNOUNCEMENT rather than on a detector: how long before a stall the operator has not acted on is said again. Declared late — `ladder.tsx` has read it since it shipped, through the index signature below rather than through a field, so it type-checked while being invisible to every reader of this type. That is the same shape of gap as `settle` being in the prefs loader and not the writer, and it is fixed here for the same reason.
 * @property {import('../schedule-policy.js').SchedulePolicy} [boardingSchedule] - When this console is willing to START phases (`shared/schedule-policy.js`). `enabled: false` — the default — means every hour boards. Recoveries are exempt: the schedule governs what the autopilot starts, never what an operator asks for.
 * @property {unknown[]} [relayRules] - The relay's rule table (phase 14) — `shared/relay-model.js` `RelayRule`, coerced on read.
 */
/**
 * `POST /api/events/subscribe` — the runs the named stream now takes `run:stream` partials for.
 * @typedef {object} EventsSubscribeAnswer
 * @property {true} ok
 * @property {string} connection - The stream's name, as its hello frame carried it.
 * @property {readonly string[]} streams - The run ids the stream takes partials for from now on.
 */
/**
 * `POST /api/boot-resume` — which interrupted runs the answer covered, and what it was.
 * @typedef {object} BootResumeAnswer
 * @property {string[]} answered - The run ids answered.
 * @property {'continue' | 'dismiss'} decision
 */
/**
 * One key as the server describes it: the shared table's facts, its default, its value, where that came from.
 * @typedef {object} PrefSchemaRow
 * @property {string} key - `theme` · `notify.needs-you` · `retention.runRetainDays` · `profile.heapMb`.
 * @property {string} group
 * @property {string} type
 * @property {readonly string[]} [words]
 * @property {string} [unit]
 * @property {string} description
 * @property {unknown} [default] - Absent for a key with no shipped default.
 * @property {unknown} value - A `secret` key's is said without the secret: a webhook's origin and masked tail, anything else as `[withheld]`.
 * @property {boolean} [secret] - The value is a credential or may carry one, so the server never serves it.
 * @property {import('../prefs-model.js').PrefSource} source
 * @property {boolean} writable
 * @property {string | null} cli - The line that changes it from a terminal, where there is one.
 */
/**
 * `GET /api/prefs/schema` (quiet-console phase 25) — every preference and machine-profile field,
 * described, with its value and its source.
 * @typedef {object} PrefsSchemaAnswer
 * @property {{ instance: string; config: string; profile: string }} files
 * @property {PrefSchemaRow[]} rows
 */

/**
 * Every route this family owns → the typedef its response is (and, for a write, the one it takes).
 * @type {Readonly<Record<string, { response: string, body?: string }>>}
 */
export const WIRE_ROUTES = Object.freeze({
  'GET /events': { response: 'WireOpaque' },
  'POST /api/events/subscribe': { response: 'EventsSubscribeAnswer' },
  'GET /api/state': { response: 'ConsoleState' },
  'GET /api/engine': { response: 'EngineQueue' },
  'GET /api/converge': { response: 'ConvergeStatusView' },
  'GET /api/fs': { response: 'DirListing' },
  'GET /api/root': { response: 'RootCheck' },
  'POST /api/root': { response: 'OpenRootResult' },
  'GET /api/prefs/schema': { response: 'PrefsSchemaAnswer' },
  'POST /api/prefs': { response: 'ConsolePrefs', body: 'ConsolePrefs' },
  'POST /api/boot-resume': { response: 'BootResumeAnswer' },
  'GET /api/restart': { response: 'RestartReadiness' },
  'POST /api/restart': { response: 'RestartOutcome' },
  'GET /api/shutdown': { response: 'ShutdownReadiness' },
  'POST /api/shutdown': { response: 'ShutdownOutcome' },
  'GET /api/instances': { response: 'InstancesView' },
  'GET /api/health/series': { response: 'HealthSeriesView' },
  'GET /api/metrics': { response: 'WireOpaque' },
  'GET /api/ceiling': { response: 'StartCeilingCounters' },
  'GET /api/sizing': { response: 'SessionSizing' },
  'GET /api/report': { response: 'WeekReportAnswer' },
  'GET /api/stats': { response: 'Portfolio' },
  'GET /api/search': { response: 'SearchResult' },
  'POST /api/write': { response: 'WriteResult', body: 'WriteRequest' },
  'POST /otel/v1/logs': { response: 'WireOpaque' },
  'POST /otel/v1/metrics': { response: 'WireOpaque' },
});
