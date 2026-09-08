/**
 * ONE DERIVATION OF ATTENTION — the tables that turn a SITUATION into the row
 * that asks about it and the channel that announces it.
 *
 * The console classifies a stopped phase exactly once, in
 * `server/runner/situation.ts`, and that answer is the good one: it reads the
 * declaration, the handoff, the board, the halt, the gate, the locks and the
 * plan's health together, in a precedence order three QA rounds have argued
 * over. Then three other surfaces threw it away and re-derived a worse answer
 * from whatever they happened to hold:
 *
 *   - the **inbox** asked `run.halt?.kind` and `plan.issues` directly, so a
 *     phase whose session honestly declared `waiting-external` raised a
 *     `health:stale-handoff` row — the classifier's single most common wrong
 *     classification, 92 times in 34 runs, and the reason the sample run sat
 *     parked for two days;
 *   - the **push catalogue** had no `gate` category at all, so a manual gate —
 *     the one situation that is a person's by construction — announced as
 *     `needs-you` or not at all;
 *   - the **chips** painted from `record.status`, which cannot tell a park the
 *     console made from a park the session asked for.
 *
 * Three derivations of one fact is three answers, and the operator sees all
 * three at once. So: the classifier answers, and everything downstream LOOKS
 * THE ANSWER UP here.
 *
 * ------------------------------------------------------------------
 * What is in the tables, and what is deliberately not
 * ------------------------------------------------------------------
 *
 * `SITUATION_FACTS` is keyed by situation ID and `SITUATION_SUB_FACTS` carries
 * only the sub-kinds whose answer DIFFERS — `resource-wall:auth` is a sign-in
 * row and `resource-wall:budget` is an errand, and nothing else about
 * `resource-wall` changes. A full id×sub table would be forty rows of which
 * thirty-four repeat their parent, and a repeated row is a row that drifts.
 * `factsFor(id, sub)` resolves the pair; `test/fact-map.test.ts` walks every
 * `SITUATIONS × SUB_KINDS` combination through it.
 *
 * `HALT_KIND_SITUATION` is total over `HALT_KINDS` because a halt kind with no
 * situation is a stop nothing can classify, and the classifier's fallback for
 * one is `unknown` — which reads to a person as "the console has no idea",
 * from a console that has an eighteen-word table saying exactly what happened.
 *
 * `inboxKind: null` is a real answer and means **raise nothing**: `superseded`
 * and `work-in-progress` are the board and a live session doing their jobs.
 * Nothing about them needs a person, and a row that cannot be acted on is a
 * row that teaches an operator to skim the list.
 */

/*
 * `attention-model.js` is deliberately NOT imported: it imports THIS file (that
 * is where `deriveAttention` reads the tables from), and a cycle between two
 * frozen-data modules is a load order nobody should have to reason about. The
 * totality assertions that would need both live in `test/fact-map.test.ts`,
 * which imports each owner directly.
 */

/**
 * @typedef {object} SituationFacts
 * @property {string|null} inboxKind   Which inbox kind raises the row, or null for none.
 * @property {string|null} pushCategory Which push category announces it, or null for none.
 * @property {string} [haltKind]  The halt kind this situation is USUALLY reached through.
 * @property {string} [waitKind]  What it is waiting on, when it is waiting on something.
 */

/**
 * Every situation, and what it turns into.
 *
 * @type {Readonly<Record<string, SituationFacts>>}
 */
export const SITUATION_FACTS = Object.freeze({
  /** The board overtook the record. Nothing is wrong and nothing needs saying. */
  superseded: Object.freeze({ inboxKind: null, pushCategory: null }),

  /** A recorded QA failure. The `qa` kind owns it; `health:qa-fail` must not double it. */
  'qa-failed': Object.freeze({ inboxKind: 'qa', pushCategory: 'qa' }),
  /** A verdict nothing dispatches by itself, holding every dependent for ever. */
  'qa-pending': Object.freeze({ inboxKind: 'qa', pushCategory: 'qa' }),

  /** Somebody else's session is working the phase right now. Time settles it. */
  'foreign-live': Object.freeze({ inboxKind: null, pushCategory: null, waitKind: 'lock' }),
  /**
   * A lock whose session ended — debris, and only a person or a lease clears
   * it. An ERRAND, not a `lock` row: the lock table raises its own row from
   * `Service.allLocks()` for every stale lock on the machine, and a run that
   * happens to be behind one must not double it. The errand's actions carry the
   * release door.
   */
  'foreign-stale': Object.freeze({ inboxKind: 'errand', pushCategory: 'needs-you', waitKind: 'lock' }),

  /**
   * The session declared a wait and named what it is waiting on. THE row this
   * whole file exists for: it is an errand (the operator can act if they want
   * to), never a `health` issue, because a declared wait is the protocol
   * working rather than a plan that will not parse.
   */
  'waiting-external': Object.freeze({
    inboxKind: 'errand',
    pushCategory: 'parked',
    haltKind: 'waiting-external-timeout',
    waitKind: 'external',
  }),

  /** A gate a person must clear. The only situation with its own push category. */
  'gated-manual': Object.freeze({ inboxKind: 'gate', pushCategory: 'gate', waitKind: 'gate' }),

  /**
   * A server the phase names will not connect. The `mcp-auth` row is the MCP
   * registry's, raised for every server that needs a person whether or not a
   * run is waiting on one; what the SITUATION raises is the errand offering
   * "continue without these servers".
   */
  'mcp-unavailable': Object.freeze({
    inboxKind: 'errand',
    pushCategory: 'needs-you',
    haltKind: 'mcp-preflight',
  }),

  /** A wall: budget, usage, models, credentials. See the sub-table for `auth`. */
  'resource-wall': Object.freeze({ inboxKind: 'errand', pushCategory: 'limits', haltKind: 'budget' }),

  /** The session said it is blocked, or wrote a `blocked` handoff. */
  'blocked-declared': Object.freeze({
    inboxKind: 'errand',
    pushCategory: 'needs-you',
    haltKind: 'phase-blocked',
  }),

  /**
   * The plan, handoff or INDEX genuinely will not read. The ONE situation that
   * may raise `health:stale-handoff` — guarded here rather than at the row, so
   * a fourth surface cannot re-invent the leak.
   */
  'plan-broken': Object.freeze({ inboxKind: 'health', pushCategory: 'health', haltKind: 'plan-lint' }),

  /** §Verification was red. */
  'verify-red': Object.freeze({ inboxKind: 'errand', pushCategory: 'halted', haltKind: 'verify-failed' }),

  /** The work looks done and no handoff records it. */
  'done-unrecorded': Object.freeze({
    inboxKind: 'errand',
    pushCategory: 'needs-you',
    haltKind: 'no-handoff',
  }),

  /** A session of this console is on it right now. Nothing to ask. */
  'work-in-progress': Object.freeze({ inboxKind: null, pushCategory: null }),

  /** The session produced nothing. Its sub-kinds are the three measured shapes. */
  'never-started': Object.freeze({ inboxKind: 'errand', pushCategory: 'needs-you' }),

  /** Nothing above fitted. An errand, because a person is the remaining remedy. */
  unknown: Object.freeze({ inboxKind: 'errand', pushCategory: 'needs-you' }),
});

/**
 * The sub-kinds whose answer differs from their parent's, and only those.
 *
 * Keyed `id:sub`, the same shape `situationKey()` mints, so a caller that
 * already holds a key can index straight in.
 *
 * @type {Readonly<Record<string, Partial<SituationFacts>>>}
 */
export const SITUATION_SUB_FACTS = Object.freeze({
  /**
   * A credential wall stays an errand and gains the sign-in door in its
   * ACTIONS. The `sign-in` row is the accounts list's own, raised whether or
   * not a run is stopped on it; raising a second one from here would be one
   * fact with two ids and two acks, and acknowledging either would leave the
   * other.
   */
  'resource-wall:auth': Object.freeze({ pushCategory: 'needs-you' }),
  /** Usage and model walls are the limits channel's, and they announce there. */
  'resource-wall:usage': Object.freeze({ haltKind: 'models-exhausted' }),
  'resource-wall:model': Object.freeze({ haltKind: 'models-exhausted' }),
  /** A declared block on a foreign lock. The lock table owns the `lock` row. */
  'blocked-declared:lock': Object.freeze({ waitKind: 'lock' }),
  /** A credential the session named. Same reasoning as `resource-wall:auth`. */
  'blocked-declared:credential': Object.freeze({ pushCategory: 'needs-you' }),
  /**
   * A session that declared itself blocked ON A GATE is the one sub-kind that
   * changes the row's kind: the gate card is the door, and an errand beside it
   * would ask the same person for the same act twice.
   */
  'blocked-declared:gate': Object.freeze({ inboxKind: 'gate', waitKind: 'gate' }),
  'blocked-declared:external': Object.freeze({ waitKind: 'external' }),
  /** The plan cannot be parsed at all — a different halt from a lint failure. */
  'plan-broken:unreadable': Object.freeze({ haltKind: 'plan-unreadable' }),
  'plan-broken:verification': Object.freeze({ haltKind: 'verification-preflight' }),
});

/**
 * Resolve a situation to its facts, sub-kind applied.
 *
 * An unknown id answers `unknown`'s facts rather than throwing: this runs on
 * the SSE path, and a word from a newer build must degrade to "a person should
 * look" rather than take the inbox down.
 *
 * @param {string|null|undefined} id
 * @param {string|null|undefined} [sub]
 * @returns {SituationFacts}
 */
export function factsFor(id, sub) {
  const base = SITUATION_FACTS[String(id ?? '')] ?? SITUATION_FACTS.unknown;
  if (!sub) return base;
  const override = SITUATION_SUB_FACTS[`${id}:${sub}`];
  return override ? Object.freeze({ ...base, ...override }) : base;
}

/**
 * Split a situation key into `[id, sub]`.
 *
 * `situation-model.js` has `parseSituationKey`, which returns an object and
 * validates the id against `SITUATIONS`. This returns the pair `factsFor` takes
 * and validates nothing, because `factsFor` already degrades an unknown id to
 * `unknown` — two validations of one string is how the two answers drift.
 *
 * @param {string|null|undefined} key
 * @returns {[string, string|undefined]}
 */
export function splitSituation(key) {
  const text = String(key ?? '');
  const colon = text.indexOf(':');
  return colon === -1 ? [text, undefined] : [text.slice(0, colon), text.slice(colon + 1)];
}

/**
 * Every halt kind → the situation it IS.
 *
 * Total over `HALT_KINDS` by construction (`test/fact-map.test.ts` asserts it),
 * because the alternative is a halt the console can name and cannot explain.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const HALT_KIND_SITUATION = Object.freeze({
  'verify-failed': 'verify-red',
  'no-handoff': 'done-unrecorded',
  'phase-blocked': 'blocked-declared',
  'waiting-external-timeout': 'waiting-external',
  /** A declared ask for a person is a declared block — the sub-kind carries the flavour. */
  'needs-human': 'blocked-declared',
  'plan-lint': 'plan-broken',
  'plan-unreadable': 'plan-broken',
  'verification-preflight': 'plan-broken',
  'mcp-preflight': 'mcp-unavailable',
  budget: 'resource-wall',
  'models-exhausted': 'resource-wall',
  /** `start()` refused on an auth/config preflight — a wall before any work. */
  'run-preflight': 'resource-wall',
  /** `adopt()` found a live session from an earlier console: somebody else holds it. */
  'orphaned-session': 'foreign-stale',
  /**
   * The four crash-shaped kinds. `unknown` is the honest answer and the
   * classifier's own: a process that died has told us nothing about the phase,
   * and dressing that up as `verify-red` or `plan-broken` would send the ladder
   * to fix something that is not broken.
   */
  'phase-crashed': 'unknown',
  'failure-streak': 'unknown',
  'recovery-failed': 'unknown',
  'runner-crashed': 'unknown',
  'worktree-merge': 'unknown',
});

/**
 * What a session DECLARED → the situation that declaration puts the phase in.
 *
 * Five words, and `complete` is the one worth the comment: a session that
 * declared complete and whose board reads done is `superseded` — the record
 * says one thing, the board says the work is recorded, and the board wins.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const DECLARED_SITUATION = Object.freeze({
  complete: 'superseded',
  'waiting-external': 'waiting-external',
  blocked: 'blocked-declared',
  'needs-human': 'blocked-declared',
  partial: 'work-in-progress',
});

/**
 * The runner's own stall SIGNAL → the inbox stall kind that speaks for it.
 *
 * `null` is a mapped answer and means no row exists yet. `stalemate` and
 * `spinning` are both real signals with real remedies (a different
 * instruction, not another try) and NEITHER is a silence — raising them as
 * `session-silent` would put the word "silent" on a session that is talking,
 * which is worse than saying nothing. The entry is here, explicitly null, so
 * the day a detector lands it is a value change rather than a new table.
 *
 * @type {Readonly<Record<string, string|null>>}
 */
export const STALL_SIGNAL_KIND = Object.freeze({
  silent: 'session-silent',
  retrying: 'session-retrying',
  /** A session watching a clock it does not control is a park that has overrun. */
  'external-wait': 'park-overdue',
  stalemate: null,
  spinning: null,
});

/**
 * Who decides that a row of this kind exists.
 *
 *   - `derived`     — a shared table decides: the classifier's situation
 *     through `SITUATION_FACTS`, or one of the maps above. The producer may not
 *     decide for itself, because the whole defect this file closes is four
 *     surfaces deciding differently about one fact.
 *   - `independent` — the producer owns the decision, because its fact is not
 *     about a run at all: a permission card the hook opened, an account that is
 *     signed out, an MCP server that needs a person, a lock on this machine, a
 *     pair of branches that will not merge.
 *
 * The two overlap in one direction and never the other: an INDEPENDENT kind may
 * be *pointed at* by a derived row's actions (a `resource-wall:auth` errand
 * offers the sign-in door), but a derived kind is never raised from raw facts.
 * `health` is the one kind on both sides — the console's OWN health (a deaf
 * watcher, a bad PATH) carries no situation — and it is `derived` because the
 * half that CAN drift is the plan half: `plan-broken` is the only situation
 * allowed to raise one, and that is exactly the guard that was missing.
 *
 * @type {Readonly<Record<string, 'derived'|'independent'>>}
 */
export const INBOX_KIND_SOURCE = Object.freeze({
  errand: 'derived',
  gate: 'derived',
  qa: 'derived',
  health: 'derived',
  stall: 'derived',
  ruling: 'derived',
  'session-ask': 'derived',
  approval: 'independent',
  'sign-in': 'independent',
  'mcp-auth': 'independent',
  lock: 'independent',
  conflict: 'independent',
});
