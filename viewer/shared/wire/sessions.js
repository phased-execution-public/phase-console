/**
 * The wire of sessions — the browser terminal and claude-kind agent sessions,
 * the session-presence registry and the hooks that feed it, the approval
 * cards and the scoped grants (measured-console phase 32).
 */

/* ---------------- the terminal ---------------- */

/**
 * @typedef {object} TerminalSession
 * @property {string} id
 * @property {string} label
 * @property {'shell' | 'claude'} [kind] - What the session runs. Absent (an older server) means a shell.
 * @property {string} cwd
 * @property {string} shell
 * @property {number} cols
 * @property {number} rows
 * @property {number} pid
 * @property {number} clients
 * @property {number} createdAt
 * @property {number} [lastOutputAt] - When the pty last printed — how a list tells "working" from "waiting".
 * @property {number} [detachedSince] - When the last client detached, while none is attached.
 * @property {TerminalSessionMeta} [meta] - Claude-session facts the UI shows back — never secret.
 * @property {{ code: number; signal?: number; closedByOperator?: boolean }} [exited] - Present once the process has gone. The record now OUTLIVES it until it is dismissed, so this is a state the page renders rather than a moment it catches.
 * @property {number} [exitedAt] - When it ended.
 * @property {{ at: number; by: string; escalateAt: string }} [frozen] - Set while the process group sits under SIGSTOP — who asked, since when, and WHEN IT CONVERTS: past `escalateAt` the session is stopped gracefully, on the clock a phase lane's freeze uses.
 * @property {{ at: number; by: string }} [stopping] - A graceful stop is in flight: SIGTERM sent, SIGKILL armed on a grace.
 * @property {import('./runs.js').PhaseTask[]} [tasks] - A QA reviewer's own task list, folded server-side from the inbox its `PE_TASKS_FILE` names — the shape a lane's record carries. Absent on every session that published none.
 */

/**
 * Claude-session facts the UI shows back — never secret.
 * @typedef {object} TerminalSessionMeta
 * @property {string} [model]
 * @property {string} [effort]
 * @property {string} [permissionMode]
 * @property {string} [claudeSessionId] - What `claude --resume <id>` takes after this pty is gone.
 * @property {import('../run-settings.js').AgentIntent | 'login'} [intent] - The briefing the session was composed from — the owner's list (`AGENT_INTENTS`), or `login` on an account's or a server's sign-in pty (the server's own word, never offered to a person).
 * @property {{ kind: string; slug?: string; phase?: number; runId?: string }} [recovery] - Set by the server on a recovery session — what it was launched to fix.
 * @property {{ slug: string; phase: number; before?: string; beforeReport?: string; round?: number; report?: string }} [qa] - Set by the server on a QA session — which phase it reviews, what `test-status.md` said when it started (how the exit check tells "recorded a verdict" from "ended next to one"), and which round and report it was told to write.
 */

/**
 * `GET /api/terminal`.
 * @typedef {object} TerminalState
 * @property {boolean} allowed - `--allow-terminal` was given.
 * @property {boolean} [agentAllowed] - `--allow-agent` was given — claude sessions may be minted.
 * @property {'yes' | 'no' | 'unknown'} available - Whether `node-pty` actually loaded — `unknown` until something has tried.
 * @property {number} limit
 * @property {number} [live] - Live processes — what `limit` caps. `sessions` also carries ended records.
 * @property {TerminalSession[]} sessions
 */

/**
 * A single-use ticket for one WebSocket upgrade. Never logged, never stored.
 * @typedef {object} TerminalTicket
 * @property {true} ok
 * @property {string} sessionId
 * @property {string} token
 * @property {number} expiresAt
 * @property {string} path
 * @property {TerminalSession} session - The session as it now is — so the caller never races its own creation.
 */

/**
 * A freeze, thaw, stop or dismiss: whether it took, why not, and the list as it now is.
 * @typedef {{ ok: boolean; reason?: string; state: TerminalState }} TerminalVerbAnswer
 */

/**
 * `DELETE /api/terminal?id=` closes the session; `&action=dismiss` drops an ended record instead.
 * @typedef {{ closed: boolean; state: TerminalState } | TerminalVerbAnswer} TerminalDeleteAnswer
 */

/**
 * What a shutdown or a restart does to the live sessions. Both dialogs render it.
 * @typedef {object} SessionInventory
 * @property {number} live
 * @property {number} agent
 * @property {number} terminal
 * @property {number} ended
 * @property {boolean} [survives] - Whether these sessions outlive the console going away — true once the ptys belong to the broker (`server/pty/broker.ts`). The dialogs READ this rather than assume either answer.
 * @property {{ id: string; label: string; kind: 'shell' | 'claude' }[]} sessions
 */

/* ---------------- session presence ---------------- */

/**
 * A Claude session the session-presence hook reported for this instance — a
 * person's own `claude`, a console agent, an autopilot lane (here or in
 * another console) — with the registry's three-valued presence and, when a
 * lock's `session=` says so (strong) or the owner and the clock suggest it
 * (weak), the plan and phase it works.
 * @typedef {object} ForeignSession
 * @property {string} sessionId
 * @property {'autopilot' | 'agent' | 'foreign'} kind
 * @property {string} cwd
 * @property {string} [root]
 * @property {string} [transcript]
 * @property {string} [owner]
 * @property {string} [scope]
 * @property {string} [user]
 * @property {string} [host]
 * @property {number} [pid]
 * @property {string} startedAt
 * @property {string} lastSeen
 * @property {string} [endedAt] - For a reported end the moment it gave; for an inferred one (`endedBy: 'probe'`) the last evidence of life.
 * @property {import('../run-lifecycle.js').PresenceEndSource} [endedBy] - Who said it ended (REG-9) — the session's SessionEnd, or the probe finding its process gone.
 * @property {string} [endedDetectedAt] - When the probe noticed an inferred end.
 * @property {string} [reason]
 * @property {string} [source]
 * @property {number} turns
 * @property {'stream' | 'hook' | 'unknown'} [turnsSource] - Where `turns` came from (REG-9): the run's stream, the hook, or `unknown` — a record that never saw a Stop, whose 0 is not a count. Absent from a server before 5.0.0.
 * @property {import('../run-lifecycle.js').Presence} presence
 * @property {{ slug: string; phase: number; strong: boolean; runId?: string }} [plan] - The plan and phase this session works: `strong` when a lock's `session=` or a run record named it, `false` when only the owner and the clock suggest it; `runId` when a run answered.
 * @property {{ since: string; kind: 'permission' | 'elicitation' | 'input'; note?: string; at?: string }} [waiting] - Set while the session sits blocked on a person — what it wants (`elicitation`: an MCP server asked it a question), since when.
 */

/**
 * `GET /api/sessions/registry`.
 * @typedef {object} SessionRegistryView
 * @property {ForeignSession[]} sessions
 */

/**
 * One hook event as the presence registry recorded it (`server/sessions/registry.ts`).
 * @typedef {object} SessionEventLine
 * @property {string} at
 * @property {string} appliedAt
 * @property {number} lateMs
 * @property {string} via
 * @property {string} event
 * @property {Record<string, unknown>} payload
 */

/**
 * `GET /api/sessions/:id/events` — the raw hook payloads of one session, in order.
 * @typedef {{ sessionId: string; events: SessionEventLine[] }} SessionEventsAnswer
 */

/**
 * `POST /api/sessions/:id/release` — the queue stops waiting on the session at once.
 * @typedef {{ ok: true; sessionId: string; holdReleased?: SessionHoldRelease }} SessionReleaseAnswer
 */

/**
 * An operator's word that a terminal session is not working in this repository (#119) — until `until`, or for as long as it lives.
 * @typedef {{ at: string; by: string; until?: string }} SessionHoldRelease
 */

/**
 * `POST /hooks/session` — what `scripts/session-hook.sh` gets back: the
 * session's presence, the peers sentence a starting session is told (REG-3 iv)
 * and the once-per-run notice that the queue waits on it (#119).
 * @typedef {object} SessionHookAnswer
 * @property {true} ok
 * @property {{ sessionId: string; presence: import('../run-lifecycle.js').Presence }} session
 * @property {string} [peers]
 * @property {string} [notice]
 */


/**
 * One phase claim, as `GET /api/locks` serves it (#24) — `server/locks.ts`'s
 * `LockRow`. Times are epoch milliseconds; `scope` is empty when the claim
 * named none, which collides with everything.
 * @typedef {object} LockRow
 * @property {string} slug
 * @property {number} phase
 * @property {string} phaseTitle
 * @property {string} owner
 * @property {string} [host]
 * @property {number} [claimedAt]
 * @property {number} [leaseUntil]
 * @property {string[]} scope
 * @property {string} [session]
 * @property {import('../run-lifecycle.js').Presence} presence
 * @property {string} [branch]
 * @property {string} [worktree]
 * @property {boolean} lapsed - `lockLapsed` on the server: past its lease, or its session ended.
 * @property {import('../lock-model.js').LockHolderKind} holderKind
 * @property {string} [runId]
 * @property {{ slug: string; phase: number | null; runId: string }[]} blocking - The queue entries waiting on this claim.
 * @property {import('./state.js').HolderEtaView} [eta] - The holder's remaining time — its phase's, or its plan's labelled as such (#63).
 */

/* ---------------- the hooks ---------------- */

/**
 * The session-presence hook, as `~/.claude/settings.json` has it (`GET /api/hooks-install`).
 * @typedef {object} HooksStatusView
 * @property {string} path
 * @property {boolean} exists
 * @property {boolean} installed
 * @property {boolean} partial
 * @property {Record<'SessionStart' | 'SessionEnd' | 'Stop', boolean>} events
 * @property {string} command
 * @property {boolean} stale
 * @property {string} [parseError]
 */

/**
 * `POST /api/hooks-install` — the write, and the status it left.
 * @typedef {object} HooksWriteView
 * @property {true} ok
 * @property {string} path
 * @property {boolean} changed
 * @property {HooksStatusView} status
 */

/**
 * One hook as Settings ▸ Hooks draws it (`server/hooks-install.ts` `HookRow`, measured-console phase 28).
 * @typedef {object} HookRowView
 * @property {'plugin' | 'user' | 'project' | 'run'} source
 * @property {string} file
 * @property {string} event
 * @property {string} [matcher]
 * @property {string} type
 * @property {string} runs
 * @property {number} [timeout]
 * @property {string} [onFailure]
 * @property {string} [when]
 */

/**
 * One hookify rule a plan's row writes (`server/hookify.ts` `HookifyRule`).
 * @typedef {object} HookifyRuleView
 * @property {string} rule
 * @property {string} name
 * @property {string} file
 * @property {string} event
 * @property {'warn' | 'block'} action
 * @property {string} [pattern]
 * @property {{ field: string; operator: string; pattern: string }[]} [conditions]
 * @property {'permission.destructive' | 'never'} source
 * @property {string} words
 */

/**
 * One rule file as it stands on disk.
 * @typedef {object} HookifyOnDiskView
 * @property {string} file
 * @property {string} name
 * @property {string} event
 * @property {string} action
 * @property {boolean} enabled
 * @property {string} [pattern]
 * @property {string} words
 * @property {boolean} current
 */

/**
 * `GET /api/hooks`: every hook, and each plan's hookify rules.
 * @typedef {object} HooksView
 * @property {HookRowView[]} hooks
 * @property {{ slug: string; rules: HookifyRuleView[]; onDisk: HookifyOnDiskView[] }[]} hookify
 */

/* ---------------- approvals ---------------- */

/** `GET /api/approvals` — every pending approval card. @typedef {import('./runs.js').Approval[]} ApprovalList */

/**
 * `POST /api/approvals/:id/extend {minutes}` — the card, later; `standing` when the Extend passed the hook's window and the card now stands (#140).
 * @typedef {{ ok: true; approval: import('./runs.js').Approval; standing: boolean }} ApprovalExtendAnswer
 */

/* ---------------- grants ---------------- */

/** @typedef {(typeof import('../turn-model.js').GRANT_SCOPES)[number]} GrantScope */
/** @typedef {(typeof import('../turn-model.js').GRANT_STATES)[number]} GrantState */

/**
 * EXACTLY what one grant changed — what its row shows and what a revoke undoes.
 * @typedef {{ kind: 'hook'; rule: string; runId: string; phase: number; command?: string }
 *   | { kind: 'settings'; runId: string; list: 'deny' | 'allow'; rule: string }
 *   | { kind: 'policy'; layer: 'plan' | 'repository' | 'machine'; file: string; slug?: string; op: 'strike' | 'remove' | 'add'; list: 'deny' | 'allow'; rule: string }
 *   | { kind: 'capability'; flag: string; unit: string; restart: 'when-idle' }} GrantChange
 */

/**
 * Who a high grant reaches, and until when — the server's computation, shown before the rule is typed.
 * @typedef {object} BlastRadius
 * @property {string[]} runs
 * @property {string[] | 'every'} plans
 * @property {{ slug: string; phase: number }[] | 'every'} phases
 * @property {'this' | 'every'} repositories
 * @property {string | null} until
 * @property {string} sentence
 */

/**
 * One grant — who, which door, the item, the wall, the rule, the scope, the end, what it changed.
 * @typedef {object} GrantRecord
 * @property {string} id
 * @property {string} at
 * @property {string} by
 * @property {string | null} door
 * @property {string | null} item
 * @property {string} [card]
 * @property {(typeof import('../turn-model.js').WALLS)[number]} wall
 * @property {string} tool
 * @property {string} rule
 * @property {string} [command]
 * @property {(typeof import('../turn-model.js').RULE_FAMILIES)[number]} family
 * @property {(typeof import('../turn-model.js').RISK_TIERS)[number]} risk
 * @property {GrantScope} scope
 * @property {string | null} slug
 * @property {number | null} phase
 * @property {string | null} runId
 * @property {string | null} until
 * @property {GrantChange[]} changed
 * @property {string} [reason]
 * @property {BlastRadius} [blast]
 * @property {true} [unkeyed] - A high grant made on a console with no owner key — the typed rule alone.
 * @property {GrantState} state
 * @property {string} [endedAt]
 * @property {string} [endedBy]
 * @property {string} [endReason]
 */

/** `GET /api/permissions/grants` — every grant, newest first, and how many are live. @typedef {{ grants: GrantRecord[]; live: number }} GrantsList */
/** `POST /api/permissions/grants/:id/revoke` — the row, ended. @typedef {{ ok: true; grant: GrantRecord }} GrantRevokeAnswer */
/** `POST /api/permissions/grants/revoke-all` — every row it ended. @typedef {{ ok: true; revoked: number; grants: GrantRecord[] }} GrantsRevokeAllAnswer */

/**
 * Every route this family owns → the typedef its response is (and, for a write, the one it takes).
 * The four run hooks answer `claude` itself in Claude Code's hook-output JSON, which the
 * CLI reads and nobody in the console does; `phase-outcome.sh` reads only the
 * declaration probe's status — so those five are `WireOpaque`.
 * @type {Readonly<Record<string, { response: string, body?: string }>>}
 */
export const WIRE_ROUTES = Object.freeze({
  'POST /hooks/pre-tool-use': { response: 'WireOpaque' },
  'POST /hooks/permission-request': { response: 'WireOpaque' },
  'POST /hooks/stop': { response: 'WireOpaque' },
  'POST /hooks/compact': { response: 'WireOpaque' },
  'POST /hooks/declaration': { response: 'WireOpaque' },
  'POST /hooks/session': { response: 'SessionHookAnswer' },
  'GET /api/sessions/registry': { response: 'SessionRegistryView' },
  'GET /api/sessions/:id/events': { response: 'SessionEventsAnswer' },
  'POST /api/sessions/:id/release': { response: 'SessionReleaseAnswer' },
  'GET /api/hooks': { response: 'HooksView' },
  'GET /api/permissions/grants': { response: 'GrantsList' },
  'POST /api/permissions/grants/:id/revoke': { response: 'GrantRevokeAnswer' },
  'POST /api/permissions/grants/revoke-all': { response: 'GrantsRevokeAllAnswer' },
  'GET /api/terminal': { response: 'TerminalState' },
  'POST /api/terminal': { response: 'TerminalTicket' },
  'DELETE /api/terminal': { response: 'TerminalDeleteAnswer' },
  'POST /api/terminal/:id/freeze': { response: 'TerminalVerbAnswer' },
  'POST /api/terminal/:id/thaw': { response: 'TerminalVerbAnswer' },
  'POST /api/terminal/:id/stop': { response: 'TerminalVerbAnswer' },
  'GET /api/approvals': { response: 'ApprovalList' },
  'POST /api/approvals/:id/extend': { response: 'ApprovalExtendAnswer' },
  'POST /api/approvals/:id': { response: 'DecideResult' },
});
