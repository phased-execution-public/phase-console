/**
 * The PLAN-FILE vocabularies — every word the console reads out of a plan, a
 * handoff folder or `phase-graph.sh`, each defined exactly once.
 *
 * Four vocabularies live here because they are the same KIND of fact: things
 * true of a plan or a phase *on disk*, which the engine can answer and the
 * console only reports. (What a RUN is doing is `status-vocab.js`; how the
 * console is configured is `ops-vocab.js`.)
 *
 * Dependency-free ESM, like every module in `shared/`: the node suite imports
 * it directly, the server through a relative path, the client through the
 * `@shared/` alias. `test/vocab-owners.test.ts` holds every importer to this
 * file by import IDENTITY — equal-by-value is exactly the failure that made
 * this module necessary, so a copy that merely agrees today still fails.
 *
 * ── Why the QA words are THREE lists and not one ──────────────────────────
 * The single most expensive thing a reader could do here is "simplify" the QA
 * vocabulary into one union. `off` and `unknown` are DIFFERENT FACTS:
 *
 *   off      — this plan has no QA gate at all.
 *   unknown  — there IS a gate, and something could not be read: a
 *              `test-status.md` row that does not parse (a result), or a plan
 *              whose mode could not be determined (a mode).
 *
 * Collapsing them makes an unreadable verdict indistinguishable from a plan
 * that never asked for QA — i.e. it turns a broken gate into a green light.
 */

// ---------------------------------------------------------------------------
// Plan status
// ---------------------------------------------------------------------------

/**
 * A plan's `status:` — the STORED decision "does anyone still care?", which no
 * board can compute (`.claude/rules/phased-execution.md` §Status source of
 * truth). Seven words: four open, three terminal.
 * @typedef {'active'|'approved'|'proposal'|'backlog'|'complete'|'abandoned'|'superseded'} PlanStatus
 * @type {readonly PlanStatus[]}
 */
export const PLAN_STATUSES = Object.freeze(
  /** @type {const} */ ([
    /** Being worked on. The default for a scaffolded plan. */
    'active',
    /** Signed off, not started. */
    'approved',
    /** Drafted, not signed off. */
    'proposal',
    /** Parked deliberately, with intent to return. */
    'backlog',
    /** Finished. Terminal. */
    'complete',
    /** Dropped. Terminal. */
    'abandoned',
    /** Replaced by another plan. Terminal. */
    'superseded',
  ]),
);

/**
 * The three TERMINAL statuses — a plan carrying one is CLOSED: it stops
 * reporting ready phases, boot prompts, batching and stuck/QA warnings, while
 * its board still renders and search still finds it.
 *
 * `plan_is_closed()` in `phase-graph.sh` is the real authority; this list is
 * the console's mirror of it and the option list `close-plan.sh --status`
 * accepts. Order is the one the close menu offers.
 * @type {readonly ('abandoned'|'superseded'|'complete')[]}
 */
export const CLOSED_PLAN_STATUSES = Object.freeze(
  /** @type {const} */ (['abandoned', 'superseded', 'complete']),
);

/**
 * Plan statuses in the order a reader wants them listed: what is live first,
 * what is finished last. Members come from `PLAN_STATUSES` — only the ORDER is
 * decided here, so a new status cannot be added to one list and forgotten in
 * the other.
 * @type {readonly PlanStatus[]}
 */
export const PLAN_STATUS_ORDER = Object.freeze(
  ['active', 'approved', 'proposal', 'backlog', 'complete', 'superseded', 'abandoned'].filter((s) =>
    PLAN_STATUSES.includes(/** @type {PlanStatus} */ (s)),
  ),
);

/** Is this a plan status the console knows? @param {unknown} v @returns {v is PlanStatus} */
export function isPlanStatus(v) {
  return typeof v === 'string' && PLAN_STATUSES.includes(/** @type {PlanStatus} */ (v));
}

/** Does this status mean the plan is closed? @param {unknown} v @returns {boolean} */
export function isClosedPlanStatus(v) {
  return typeof v === 'string' && CLOSED_PLAN_STATUSES.includes(/** @type {PlanStatus} */ (v));
}

// ---------------------------------------------------------------------------
// Handoff status
// ---------------------------------------------------------------------------

/**
 * A handoff's `status:` — the word the BOARD reads to decide whether a phase
 * is done (`phase-graph.sh:557-562` maps `complete → done`,
 * `in-progress → in-progress`, `blocked → stuck`, anything else →
 * `not-started`).
 *
 * ⚠️ FROZEN. `CLAUDE.md` names this vocabulary load-bearing: every surface in
 * the console and every script in the skill agrees on these four words, and a
 * fifth would change what "done" means. Consolidating the three listings that
 * existed was in scope; WIDENING it is not.
 * @typedef {'complete'|'in-progress'|'blocked'|'pending'} HandoffStatus
 * @type {readonly HandoffStatus[]}
 */
export const HANDOFF_STATUSES = Object.freeze(
  /** @type {const} */ (['complete', 'in-progress', 'blocked', 'pending']),
);

/**
 * What a handoff file can READ as: the four writable statuses plus `unknown`
 * for a file whose `status:` is none of them. Parsers use this; writers use
 * `HANDOFF_STATUSES`. (`evidence-model.js`'s `HANDOFF_WORDS` adds a sixth,
 * `absent`, for no file at all — a third fact again, and deliberately its own
 * list.)
 * @typedef {HandoffStatus|'unknown'} HandoffStatusWord
 * @type {readonly HandoffStatusWord[]}
 */
export const HANDOFF_STATUS_WORDS = Object.freeze([...HANDOFF_STATUSES, 'unknown']);

/** @param {unknown} v @returns {v is HandoffStatus} */
export function isHandoffStatus(v) {
  return typeof v === 'string' && HANDOFF_STATUSES.includes(/** @type {HandoffStatus} */ (v));
}

// ---------------------------------------------------------------------------
// QA — three vocabularies, deliberately (see the module header)
// ---------------------------------------------------------------------------

/**
 * A phase's recorded QA VERDICT — the four words `qa-record.sh` will write
 * into `test-status.md`, and the only four a row may legally hold.
 * @typedef {'pass'|'fail'|'waived'|'pending'} QaResult
 * @type {readonly QaResult[]}
 */
export const QA_RESULTS = Object.freeze(/** @type {const} */ (['pass', 'fail', 'waived', 'pending']));

/**
 * What a row in `test-status.md` can READ as: the four writable verdicts plus
 * `unknown` for a row that exists but does not parse. Parsers use this;
 * writers use `QA_RESULTS`.
 * @typedef {QaResult|'unknown'} QaResultWord
 * @type {readonly QaResultWord[]}
 */
export const QA_RESULT_WORDS = Object.freeze([...QA_RESULTS, 'unknown']);

/**
 * The PLAN's QA regime — a different vocabulary from a phase's verdict, and
 * they share the word `waived` while meaning different things (`waived` here
 * is "the plan turned the gate off"; `waived` as a RESULT is "a person
 * decided this phase, and that is a verdict").
 *
 * QA gating is on iff `test-status.md` exists (`phase-graph.sh:965-967`), and
 * `**QA gate:** off` in the plan yields the mode `waived`, NOT `off` — while
 * any `fail` row already on disk still gates the phase's dependents
 * (`phase-graph.sh:991-993`).
 * @typedef {'off'|'on'|'waived'|'unknown'} QaMode
 * @type {readonly QaMode[]}
 */
export const QA_MODES = Object.freeze(/** @type {const} */ (['off', 'on', 'waived', 'unknown']));

/**
 * What a QA directive may be SET to — the writer's vocabulary (`qa-mode.sh`,
 * the console's toggle), distinct from `QA_MODES`, which is what the engine
 * READS back: writing `off` to a plan whose ledger exists reads as `waived`.
 * `inherit` is a phase's word only — it deletes the phase's own
 * `- **QA:** …` bullet so the plan's regime applies; a plan has nothing to
 * inherit from.
 * @typedef {'on'|'off'|'inherit'} QaDirective
 * @type {readonly QaDirective[]}
 */
export const QA_DIRECTIVES = Object.freeze(/** @type {const} */ (['on', 'off', 'inherit']));

/**
 * The QA gate as it bears on ONE phase, for DISPLAY, in classifier order: the
 * four verdicts plus `off` for a plan with no gate. Deliberately not
 * `QA_RESULT_WORDS` — a plan with no gate and a row that will not parse are
 * opposite facts and must never paint the same.
 * @typedef {QaResult|'off'} QaWord
 * @type {readonly QaWord[]}
 */
export const QA_DISPLAY_WORDS = Object.freeze(['off', 'fail', 'pending', 'pass', 'waived']);

/** Is this a writable QA verdict? @param {unknown} v @returns {v is QaResult} */
export function isQaResult(v) {
  return typeof v === 'string' && QA_RESULTS.includes(/** @type {QaResult} */ (v));
}

/** Is this a plan QA regime word? @param {unknown} v @returns {v is QaMode} */
export function isQaMode(v) {
  return typeof v === 'string' && QA_MODES.includes(/** @type {QaMode} */ (v));
}

/**
 * Is the QA gate HOLDING this phase's dependents right now — and on which of
 * the two words?
 *
 * The one predicate behind every QA-recovery surface, here because it is a
 * statement about these vocabularies and nothing else. It has two members and
 * that is the whole subtlety: a `pending` row holds dependents **exactly as
 * hard as a `fail`** (`_is_verified` in `phase-graph.sh` accepts only
 * `pass`/`waived`), and every surface that treated `fail` as the QA problem
 * and `pending` as "not reviewed yet" left the deadlock issue #11 was written
 * about — six phases of a real plan held behind a verdict nothing in the
 * system would ever give.
 *
 * `mode` is the PLAN's regime, and only `on` gates: under `off` there is no
 * gate, and under `waived` (`**QA gate:** off` in writing) the verdicts stay
 * recorded and stop holding anyone. Anything unreadable answers `undefined` —
 * this predicate is asked before spending money, so uncertainty is a no.
 *
 * @param {unknown} mode    The plan's QA regime (`QA_MODES`).
 * @param {unknown} result  The phase's recorded verdict (`QA_RESULTS`), or absent for no row.
 * @returns {'fail'|'pending'|undefined}
 */
export function qaGateHolds(mode, result) {
  if (mode !== 'on') return undefined;
  return result === 'fail' || result === 'pending' ? result : undefined;
}

/**
 * Is the gate DEMONSTRABLY not there — the two words that definitely mean "no
 * gate", and nothing else?
 *
 * The inverse of `qaGateHolds` is not this, and the difference is the whole
 * reason it has a name. `qaGateHolds` answers a display question ("should these
 * controls appear?") where uncertainty must read as a no; this answers a
 * REFUSAL question ("may I decline the operator's explicit press?") where
 * uncertainty must read as a no *to the refusal*.
 *
 * `unknown` is what `readQaMode` resolves to when the engine could not be run
 * or its answer could not be parsed — and `Service.qaMode` caches by plan
 * revision with no TTL, so a transient failure would otherwise become that
 * revision's permanent answer and hard-block a legitimate recovery on a
 * genuinely failing phase, with a confidently false message. That is the same
 * class this codebase names for the MCP preflight — **"a probe that could not
 * RUN never degrades anything"**; `off` and `waived` are claims, `unknown` is
 * the absence of one. (QA round 2, M1.)
 *
 * @param {unknown} mode  The plan's QA regime (`QA_MODES`).
 * @returns {boolean}
 */
export function qaGateOff(mode) {
  return mode === 'off' || mode === 'waived';
}

/**
 * What a phase's closeout is waiting on when it cannot finish itself — the
 * three things the runner checks after the work is done. `null` (not a member)
 * means nothing is blocking.
 * @typedef {'board'|'verification'|'lint'} BlockedOn
 * @type {readonly BlockedOn[]}
 */
export const BLOCKED_ON = Object.freeze(/** @type {const} */ (['board', 'verification', 'lint']));

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * What CATEGORY a phase's gate is — who or what can clear it. The split that
 * matters operationally: `ai` is the default and a fresh session clears it
 * itself; `human` stops everything until a person approves; `auto` answers by
 * itself (a date, a phase count, a command); `none` is an ungated phase.
 *
 * The gate TYPES themselves (`date`, `phase`, `cmd`, …) are data, read from
 * `scripts/gates.env` at runtime by `analysis/gates.ts` — deliberately not
 * frozen here, because the shell owns that list.
 * @typedef {'human'|'ai'|'auto'|'none'} GateKind
 * @type {readonly GateKind[]}
 */
export const GATE_KINDS = Object.freeze(/** @type {const} */ (['human', 'ai', 'auto', 'none']));

/** @param {unknown} v @returns {v is GateKind} */
export function isGateKind(v) {
  return typeof v === 'string' && GATE_KINDS.includes(/** @type {GateKind} */ (v));
}
