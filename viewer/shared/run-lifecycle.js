/**
 * THE LIFECYCLE VOCABULARY — every word a run, a phase, a rung, a queue entry
 * or a watch ref can be, written down once.
 *
 * `console-autopilot-orphans` P10 found 27 status word-lists living outside
 * `shared/`; `console-audit-hardening` P23 gave twenty-five of them owners and
 * `test/vocab-owners.test.ts` to stop them being re-copied. Sixteen were left
 * homeless, and they are the ones the autopilot actually turns on: a run's own
 * status, a phase record's status, how the CLI's exit was dispositioned, how a
 * ladder rung ended, what a watch ref saw, what a session DECLARED, whether a
 * session is live, who is holding a queue entry up, what kind of entry it is,
 * which brief a boarding carries, what woke the convergence loop, and the five
 * policy words an operator sets on a run.
 *
 * Each of the sixteen was spelled out in two to five places — a server type, a
 * client mirror, a paint table's `@type`, a JSON validator, a bash script. The
 * cost is never the duplication; it is the day a word is added to one of them.
 * `queued` exists in `RUN_STATUSES` and NOT in `RUN_IN_FLIGHT`, and the
 * difference is the whole reason a queued run once painted as *interrupted* on
 * the fleet page while its plan offered a Start button the server 409'd.
 *
 * ------------------------------------------------------------------
 * The rules this file is built around
 * ------------------------------------------------------------------
 *
 * **1. The full list is the declaration; every subset is DERIVED from it.**
 * `RUN_IN_FLIGHT`, `PHASE_IN_FLIGHT` and `SETTLED` are `.filter()`s over the
 * arrays above them, never second literals. A subset written out by hand is a
 * list that agrees today and disagrees the day a word lands.
 *
 * **2. Consumers take the TYPE from the array**, `(typeof X)[number]`, so the
 * compiler holds a `Record` over it total and a new word breaks the build at
 * the table that forgot it rather than at runtime in front of an operator.
 *
 * **3. Order is meaning where it is meaning, and nowhere else.** `RUN_STATUSES`
 * and `PHASE_STATUSES` are written live-first → settled-last because that is
 * the order the derived subsets read in, and `status-vocab.js` paints from the
 * same order. Nothing sorts by index here; `attention-model.js`'s severities
 * are the file where index IS rank, and this one says so rather than implying
 * it.
 *
 * **4. `unknown` is a member wherever "we could not ask" is a real answer** —
 * `PRESENCE` and `WATCH_STATES` both carry it, for the reason
 * `worktree-model.js`'s `RADAR_STATES` does: folding could-not-measure into
 * measured-safe turns a broken probe into a green light.
 *
 * This file is pure data and two type-free helpers. It imports nothing, so it
 * is safe from every layer — the bash halves included, which read the same
 * words out of `scripts/`.
 */

/* ------------------------------------------------------------------ *
 * Runs
 * ------------------------------------------------------------------ */

/**
 * Every status a RUN can hold — `server/runner/state.ts` `RunStatus`, and the
 * client's mirror of it.
 *
 * Live first, then the waits, then the settled words. `queued` sits with the
 * settled group deliberately: the run holds no child and no lock, which is
 * exactly why the SERVER keeps it out of `RUN_IN_FLIGHT` — and why the client
 * nevertheless calls it live (`LIVE_RUN_STATUSES` in `status-vocab.js`), since
 * a loop IS behind it, sitting in `admit()`. Two questions, two subsets, one
 * membership list.
 *
 */
export const RUN_STATUSES = Object.freeze(
  /** @type {const} */ ([
    /** A session of this run is spawned and spending. */
    'running',
    /** A halt is landing: the loop is winding its lanes down. */
    'halting',
    /** Stopped on something that must not be automated past. */
    'halted',
    /** Every remaining phase needs a person, or a clock. Not an error. */
    'parked',
    /** The console died under it — no loop, no corpse, work possibly intact. */
    'interrupted',
    /** Asleep on a clock it does not control: a usage window, a declared park. */
    'waiting',
    /** An operator's pause has landed. */
    'paused',
    /** A pause is landing. */
    'pausing',
    /** Held exactly where it stands, by an operator or the fleet freeze. */
    'frozen',
    /** A stop is landing. */
    'stopping',
    /** Admitted to the queue and waiting for scope, a window or an account. */
    'queued',
    /** The plan ran out of phases to drive. The only happy terminal. */
    'finished',
  ]),
);

/**
 * @typedef {(typeof RUN_STATUSES)[number]} RunStatus
 */

/**
 * The run statuses the SERVER counts as in flight — a live child, a held lock,
 * or a loop winding one of those down.
 *
 * Derived, and the exclusions are the content: `queued` holds nothing yet
 * (`admit()` has not returned), `paused` has already released, and the three
 * terminal words are over.
 *
 * @type {readonly RunStatus[]}
 */
export const RUN_IN_FLIGHT = Object.freeze(
  RUN_STATUSES.filter(
    (status) => !['queued', 'paused', 'halted', 'parked', 'interrupted', 'finished'].includes(status),
  ),
);

/**
 * The run statuses nothing will move by itself: the run is over, or it is
 * waiting on a person.
 *
 * NOT the complement of `RUN_IN_FLIGHT` — `queued` is in neither, and that is
 * the whole point of it. A queued run holds no child and no lock (so it is not
 * in flight) and yet a loop IS behind it, sitting in `admit()` (so it is not
 * settled either). Writing the two as complements would put `queued` on one
 * side or the other and make one of the two questions answer wrongly; a test
 * pins the three-way split.
 *
 * @type {readonly RunStatus[]}
 */
export const RUN_SETTLED = Object.freeze(
  RUN_STATUSES.filter((status) => ['halted', 'parked', 'interrupted', 'finished', 'paused'].includes(status)),
);

/* ------------------------------------------------------------------ *
 * Phases
 * ------------------------------------------------------------------ */

/**
 * Every status a PHASE RECORD can hold — `state.ts` `PhaseStatus`.
 *
 */
export const PHASE_STATUSES = Object.freeze(
  /** @type {const} */ ([
    /** A session is spawned on it. */
    'running',
    /** The session is gone and its §Verification commands are executing. */
    'verifying',
    /** Verification passed and the loop signed it off. */
    'awaiting-verification',
    /** Admitted, waiting on scope. */
    'queued',
    /** The loop has not reached it. */
    'pending',
    /** Asleep on a clock — a declared park, or a watch ref not yet landed. */
    'waiting',
    /** Its gate is not clear and the console may not clear it. */
    'gated',
    /** Stopped needing a person, with the errand that says what for. */
    'parked',
    /** The console died with the session open. */
    'interrupted',
    /** Not run, and deliberately so — `onlyPhases`, or the board overtook it. */
    'skipped',
    /** Verification was red, or the ladder gave up. */
    'failed',
    /** Done, verified, handed off. */
    'done',
  ]),
);

/**
 * @typedef {(typeof PHASE_STATUSES)[number]} PhaseStatus
 */

/**
 * The phase statuses that hold a lane — a spawned session, or the verification
 * that runs after one. `awaiting-verification` is in flight because the loop
 * still owns the record and will write a terminal word to it.
 *
 * @type {readonly PhaseStatus[]}
 */
export const PHASE_IN_FLIGHT = Object.freeze(
  PHASE_STATUSES.filter((status) => ['running', 'verifying', 'awaiting-verification'].includes(status)),
);

/**
 * The phase statuses the drive loop will not pick up again on its own.
 *
 * `gated` is settled and `waiting` is NOT, which is the distinction worth the
 * comment: a gate is a decision somebody has to make, while a wait is a clock
 * that runs out by itself and hands the phase back.
 *
 * @type {readonly PhaseStatus[]}
 */
export const SETTLED = Object.freeze(
  PHASE_STATUSES.filter((status) =>
    ['done', 'skipped', 'failed', 'parked', 'interrupted', 'gated'].includes(status),
  ),
);

/* ------------------------------------------------------------------ *
 * How an attempt ended, and what the console did about it
 * ------------------------------------------------------------------ */

/**
 * What `errors.ts` decided an exited session MEANS — the disposition, one word
 * per remedy the runner has.
 *
 * `ok` is a member because "nothing is wrong" is a disposition and the caller
 * must handle it; a list that omitted it would push the happy path into a
 * default arm, which is exactly where a mis-classification hides.
 *
 */
export const DISPOSITION_KINDS = Object.freeze(
  /** @type {const} */ ([
    /** Transient. Try the same phase again shortly. */
    'retry',
    /** A window is exhausted. Sleep until it reopens, then retry. */
    'wait-until',
    /** Only this model is walled; the run continues on another. */
    'switch-model',
    /** The work is unfinished but intact — resume that session with a bigger cap. */
    'resume',
    /** Nothing automatic will fix this. */
    'needs-human',
    /** The phase itself failed; the run may still drive its siblings. */
    'phase-failed',
    /** The session ended cleanly. */
    'ok',
  ]),
);

/**
 * @typedef {(typeof DISPOSITION_KINDS)[number]} DispositionKind
 */

/**
 * How a ladder RUNG ended.
 *
 * `no-defect` and `fixed` are two different endings and the difference is
 * load-bearing: only `fixed` retires a halt. "Found nothing wrong" is not
 * "fixed it", and clearing a halt on it sends the run back into the same wall
 * to re-discover it (Phase 3, decision 2).
 *
 */
export const RUNG_OUTCOMES = Object.freeze(
  /** @type {const} */ ([
    /** The rung is still climbing. */
    'running',
    /** It found a defect and fixed it. The ONLY outcome that retires a halt. */
    'fixed',
    /** It looked and found nothing wrong. Not a fix. */
    'no-defect',
    /** The board moved under it — the situation it was climbing is gone. */
    'superseded',
    /** It ran and did not hold. */
    'failed',
    /** Cut short. Counts toward no rung cap, and it can run again. */
    'interrupted',
    /** It declared `partial` — still going, and it asked to be resumed. */
    'work-in-progress',
  ]),
);

/**
 * @typedef {(typeof RUNG_OUTCOMES)[number]} RungOutcome
 */

/**
 * The rung outcomes that are a VERDICT — a rung that has finished having an
 * opinion. `running` and `work-in-progress` are excluded because neither is
 * one: the first has not finished and the second asked to be resumed.
 *
 * Derived, and the derivation matters: this subset was spelled out three times
 * and one of the three had drifted to four members, silently dropping
 * `interrupted` — so a rung cut short could not be recorded as the ladder's
 * `lastOutcome` at all.
 *
 * @type {readonly RungOutcome[]}
 */
export const SETTLED_RUNG_OUTCOMES = Object.freeze(
  RUNG_OUTCOMES.filter((outcome) => !['running', 'work-in-progress'].includes(outcome)),
);

/**
 * @typedef {(typeof SETTLED_RUNG_OUTCOMES)[number]} SettledRungOutcome
 */

/**
 * What a session may DECLARE through `scripts/phase-outcome.sh` — the
 * session→runner channel's whole vocabulary.
 *
 * `no-defect` is here and not in the skill's own documentation of the script
 * because a RECOVERY session declares it (Phase 3) and an ordinary phase
 * session cannot: the script rejects it for a phase run. One list, because the
 * reader is one function.
 *
 */
export const OUTCOME_STATUSES = Object.freeze(
  /** @type {const} */ (['complete', 'waiting-external', 'blocked', 'needs-human', 'partial', 'no-defect']),
);

/**
 * @typedef {(typeof OUTCOME_STATUSES)[number]} OutcomeStatus
 */

/**
 * What a watch ref's last probe saw.
 *
 * `unknown` is "I could not ask" — no `gh`, no auth, no oracle wired — and the
 * caller behaves exactly as it did before the module existed. `refused` is
 * terminal and different: the policy has judged this command and will judge it
 * identically for ever, so it is journalled once and dropped from the rotation
 * rather than re-argued every minute.
 *
 */
export const WATCH_STATES = Object.freeze(/** @type {const} */ (['pending', 'landed', 'unknown', 'refused']));

/**
 * @typedef {(typeof WATCH_STATES)[number]} WatchStateWord
 */

/* ------------------------------------------------------------------ *
 * Sessions, queue and boarding
 * ------------------------------------------------------------------ */

/**
 * Whether a session is still alive — `sessions/registry.ts` `SessionPresence`.
 *
 * `unknown` is a first-class answer: the registry measures presence against a
 * pid and a heartbeat, and a session on another machine has neither. Only
 * `ended` makes an unexpired lock debris; `unknown` releases nothing.
 *
 */
export const PRESENCE = Object.freeze(/** @type {const} */ (['live', 'ended', 'unknown']));

/**
 * @typedef {(typeof PRESENCE)[number]} Presence
 */

/**
 * What is holding a queue entry up — `runner/scheduler.ts` `Holder.kind`.
 *
 */
export const HOLDER_KINDS = Object.freeze(
  /** @type {const} */ ([
    /** Another admitted entry of this console holds the scope. */
    'grant',
    /** A phase lock on disk — possibly another machine's, possibly debris. */
    'lock',
    /** A clock or a policy, not scope: a freeze, a window, a hold, a throttle. */
    'reserved',
  ]),
);

/**
 * @typedef {(typeof HOLDER_KINDS)[number]} HolderKind
 */

/**
 * What KIND of thing is queued. Absent reads as `phase`.
 *
 * The split exists because the boarding schedule exempts `recovery` and the
 * fleet freeze deliberately does not — a recovery is still work, and an
 * operator who froze the console froze it.
 *
 */
export const QUEUE_KINDS = Object.freeze(/** @type {const} */ (['phase', 'recovery']));

/**
 * @typedef {(typeof QUEUE_KINDS)[number]} QueueKind
 */

/**
 * Which brief a boarding carries — what the session is told about the state it
 * is walking into.
 *
 */
export const BOARDING_BRIEFS = Object.freeze(
  /** @type {const} */ ([
    /** Nothing has run. The plain boot prompt. */
    'fresh',
    /** An attempt stopped unfinished: the handoff, the uncommitted paths, the last words. */
    'resume',
    /** The handoff reads `blocked` — explicitly allowed to do the unblocking work. */
    'unblock',
    /** The same session, continued: it declared `partial` and asked for this. */
    'continue',
    /** The board is finished; run §End-to-end verification and close the plan. */
    'closeout',
  ]),
);

/**
 * @typedef {(typeof BOARDING_BRIEFS)[number]} BoardingBrief
 */

/**
 * What woke the convergence loop.
 *
 */
export const CONVERGE_TRIGGERS = Object.freeze(
  /** @type {const} */ (['boot', 'change', 'timer', 'halt', 'button']),
);

/**
 * @typedef {(typeof CONVERGE_TRIGGERS)[number]} ConvergeTrigger
 */

/* ------------------------------------------------------------------ *
 * The six policy words an operator sets
 * ------------------------------------------------------------------ */

/**
 * How much the run asks about — `state.ts` `Autonomy`.
 */
export const AUTONOMY_MODES = Object.freeze(/** @type {const} */ (['halt-on-everything', 'keep-going']));

/** @typedef {(typeof AUTONOMY_MODES)[number]} AutonomyMode */

/**
 * What the run does when an account hits a usage wall.
 */
export const ON_LIMIT_POLICIES = Object.freeze(/** @type {const} */ (['wait', 'switch', 'pause']));

/** @typedef {(typeof ON_LIMIT_POLICIES)[number]} OnLimitPolicy */

/**
 * What a phase does when an MCP server it names will not connect.
 *
 * `continue` is the default and `require` is the sharp edge: a parked phase
 * with no other ready phase behind it halts the whole plan.
 */
export const MCP_POLICIES = Object.freeze(/** @type {const} */ (['continue', 'require']));

/** @typedef {(typeof MCP_POLICIES)[number]} McpPolicy */

/**
 * Whether a run gets a branch of its own.
 */
export const GIT_MODES = Object.freeze(/** @type {const} */ (['default-branch', 'new-branch']));

/** @typedef {(typeof GIT_MODES)[number]} GitMode */

/**
 * What a phase reviewer's verdict may DO — `server/reviewer.ts`.
 *
 * `may-hold` lets a reviewer's `requested-changes` hold the phase's dependents
 * exactly as a person's would; `comment-only` records the same verdict and
 * moves on.
 */
export const REVIEWER_POLICIES = Object.freeze(/** @type {const} */ (['comment-only', 'may-hold']));

/** @typedef {(typeof REVIEWER_POLICIES)[number]} ReviewerPolicy */

/**
 * When the run reaches for `claude ultrareview` — the CLI's cloud multi-agent
 * review — `server/runner/ultrareview.ts`.
 *
 * `off` is the default and the whole list is deliberately small: this is billed
 * cloud work on the operator's own account, so the two words that are not `off`
 * each name a moment rather than a rate. `each-phase` reviews the phase that
 * just finished, in the checkout that phase worked in; `at-settle` reviews the
 * run's branch once, after the last phase and before the branch's fate is
 * decided. There is no `both`: two answers to "when" is a bill, not a policy.
 *
 * What a verdict from either may DO is `REVIEWER_POLICIES` above — one rule,
 * two readers, so an operator who said a reviewer may not hold work has said it
 * about this one too.
 */
export const ULTRA_REVIEW_MODES = Object.freeze(/** @type {const} */ (['off', 'each-phase', 'at-settle']));

/** @typedef {(typeof ULTRA_REVIEW_MODES)[number]} UltraReviewMode */

/* ------------------------------------------------------------------ *
 * The lifecycle — what a run or a phase IS, kept apart from why it stopped
 * ------------------------------------------------------------------ */

/**
 * What a RUN is, once the transitions and the reasons are lifted out of the
 * status word.
 *
 * Six words, against `RUN_STATUSES`' twelve, and the six that left are the
 * argument for this list. `pausing`, `stopping` and `halting` are not states a
 * run is IN, they are acts landing ON one — a halting run is still running,
 * with a halt pending, which is why `RUN_IN_FLIGHT` has to include all three
 * and why five separate `=== 'pausing' || === 'halting' || === 'stopping'`
 * chains grew across `runner.ts`. `frozen` is a fact about the fleet, not about
 * the run: a frozen run is a running run whose child holds a SIGSTOP. `queued`
 * is a WAIT whose reason happens to be scope. And `interrupted` is a fact about
 * a dead console, which is a halt with a known cause.
 *
 * So: the state says what to do about it, and the axes below say why. A reader
 * that wants "is anything happening" asks the state; a reader that wants to
 * write a sentence for an operator asks the axis. Neither re-derives the other.
 */
export const RUN_LIFECYCLE_STATES = Object.freeze(
  /** @type {const} */ ([
    /** A loop owns it: spending, winding down, or held mid-token. */
    'running',
    /** Asleep on a clock — a usage window, a declared park, scope, a schedule. */
    'waiting',
    /** Every remaining phase needs a person. Not an error. */
    'parked',
    /** Stopped on something that must not be automated past. */
    'halted',
    /** An operator's pause has landed. */
    'paused',
    /** The plan ran out of phases to drive. The only happy terminal. */
    'finished',
  ]),
);

/** @typedef {(typeof RUN_LIFECYCLE_STATES)[number]} RunLifecycleState */

/**
 * What a PHASE RECORD is. Nine words against `PHASE_STATUSES`' twelve.
 *
 * `queued` folds into `waiting` (its reason is scope), `gated` and
 * `awaiting-verification` into `parked` (their reason is a decision somebody
 * owes), and `interrupted` into `failed` — which is the fold that lets
 * `LADDER_STATUSES` shrink to one word, since a dead console's record and a red
 * verification want the same treatment and differ only in the reason.
 */
export const PHASE_LIFECYCLE_STATES = Object.freeze(
  /** @type {const} */ ([
    /** A session is spawned on it. */
    'running',
    /** The session is gone and its §Verification commands are executing. */
    'verifying',
    /** The loop has not reached it. */
    'pending',
    /** Asleep on a clock, or behind somebody else's scope. */
    'waiting',
    /** Stopped needing a person or a decision. */
    'parked',
    /** Not run, and deliberately so. */
    'skipped',
    /** Verification was red, the ladder gave up, or the console died on it. */
    'failed',
    /** Done, verified, handed off. */
    'done',
  ]),
);

/** @typedef {(typeof PHASE_LIFECYCLE_STATES)[number]} PhaseLifecycleState */

/**
 * The act landing on a `running` run — the three transition words, as the
 * transitions they always were.
 */
export const RUN_PENDING_ACTS = Object.freeze(/** @type {const} */ (['pause', 'stop', 'halt']));

/** @typedef {(typeof RUN_PENDING_ACTS)[number]} RunPendingAct */

/**
 * Why a phase stopped — the axis that used to be spread over the status word, a
 * halt kind, a note regex and a declaration.
 *
 * `scope-cap` and `mcp` are the two that PAINT differently (`status-vocab.js`
 * folds them to `waiting` rather than `needs-you`): nobody is being asked for
 * anything, the phase is behind a queue or a server that is expected back. The
 * rest all mean a person owes a decision.
 */
export const PHASE_STOP_KINDS = Object.freeze(
  /** @type {const} */ ([
    /** Its gate is not clear and the console may not clear it. */
    'gate',
    /** Verification passed and a person still owes the sign-off. */
    'human-check',
    /** Behind another lane's scope, or the lock-wait cap. */
    'scope-cap',
    /** An MCP server the phase names would not connect. */
    'mcp',
    /** The session said so itself — `stop.declared` carries which word. */
    'declared',
    /** §Verification ran and was red. */
    'verification',
    /** The ladder spent its rungs or its dollars. */
    'ladder',
    /** The console died with the session open. */
    'interrupted',
  ]),
);

/** @typedef {(typeof PHASE_STOP_KINDS)[number]} PhaseStopKind */

/**
 * @typedef {object} RunLifecycle
 * @property {RunLifecycleState} state
 * @property {{ kind: string, until?: string|null, on?: string }} [wait]
 * @property {RunPendingAct} [pending]
 * @property {boolean} [frozen]
 */

/**
 * @typedef {object} PhaseLifecycle
 * @property {PhaseLifecycleState} state
 * @property {{ kind: PhaseStopKind, declared?: string, stated?: true }} [stop]
 */

/**
 * The run fold. Total over `RUN_STATUSES` — the compiler holds it so, and a
 * thirteenth status breaks the build here rather than painting as `undefined`.
 * @type {Readonly<Record<RunStatus, RunLifecycleState>>}
 */
const RUN_STATE_FOLD = Object.freeze({
  running: 'running',
  halting: 'running',
  stopping: 'running',
  pausing: 'running',
  frozen: 'running',
  waiting: 'waiting',
  queued: 'waiting',
  parked: 'parked',
  halted: 'halted',
  interrupted: 'halted',
  paused: 'paused',
  finished: 'finished',
});

/**
 * Which act is landing, for the three statuses that are one.
 * @type {Readonly<Record<RunStatus, RunPendingAct|null>>}
 */
const RUN_PENDING_FOLD = Object.freeze({
  pausing: 'pause',
  stopping: 'stop',
  halting: 'halt',
  running: null,
  frozen: null,
  waiting: null,
  queued: null,
  parked: null,
  halted: null,
  interrupted: null,
  paused: null,
  finished: null,
});

/**
 * The phase fold, total over `PHASE_STATUSES`.
 * @type {Readonly<Record<PhaseStatus, PhaseLifecycleState>>}
 */
const PHASE_STATE_FOLD = Object.freeze({
  running: 'running',
  verifying: 'verifying',
  'awaiting-verification': 'parked',
  gated: 'parked',
  parked: 'parked',
  queued: 'waiting',
  waiting: 'waiting',
  pending: 'pending',
  interrupted: 'failed',
  failed: 'failed',
  skipped: 'skipped',
  done: 'done',
});

/**
 * The stop kind a status implies ON ITS OWN, before the record's own evidence
 * is consulted. `null` means the status says nothing and the record decides.
 * @type {Readonly<Record<PhaseStatus, PhaseStopKind|null>>}
 */
const PHASE_STOP_FOLD = Object.freeze({
  gated: 'gate',
  'awaiting-verification': 'human-check',
  queued: 'scope-cap',
  interrupted: 'interrupted',
  running: null,
  verifying: null,
  parked: null,
  waiting: null,
  pending: null,
  failed: null,
  skipped: null,
  done: null,
});

/**
 * What this run IS — the stored `lifecycle` when a writer left one, the
 * derivation from `status` when it did not.
 *
 * That "when it did not" is the whole migration: 3.5.0 writes both shapes, so
 * every run file this console produces answers from `lifecycle`, and every run
 * file written before it answers identically from `status`. 3.6.0 drops
 * `status` and this function keeps the same signature.
 *
 * @param {{ status?: string, lifecycle?: RunLifecycle, waitUntil?: string|null,
 *           waitReason?: string|null, freeze?: unknown,
 *           phases?: Record<string, {status?: string}> }|null|undefined} run
 * @returns {RunLifecycle}
 */
export function runLifecycle(run) {
  const stored = run?.lifecycle;
  if (stored && /** @type {readonly string[]} */ (RUN_LIFECYCLE_STATES).includes(stored.state)) {
    return stored;
  }
  const status = /** @type {RunStatus} */ (run?.status ?? '');
  // A word the vocabulary does not hold folds to `waiting`, and the choice is
  // forced rather than aesthetic: `status-vocab.js` paints an unrecognised word
  // as `UNKNOWN_STATE`, which IS `waiting`, so any other fallback would repaint
  // it. There is live data that needs this — two run files on this machine read
  // `status: "complete"`, a word `RUN_STATUSES` has never held — and a fold
  // that turned those red would be a regression shipped as a cleanup.
  const state = RUN_STATE_FOLD[status] ?? 'waiting';
  /** @type {RunLifecycle} */
  const lifecycle = { state };

  const pending = RUN_PENDING_FOLD[status];
  if (pending) lifecycle.pending = pending;
  if (status === 'frozen' || Boolean(run?.freeze)) lifecycle.frozen = true;

  if (state === 'waiting') {
    // `queued` is the one wait whose reason the status itself carries: the run
    // is in `admit()`, behind somebody else's scope. Every other wait reads the
    // recorded reason, and falls back the way `waitReasonOf` does — which is
    // the only answer a run written before that field can be given.
    const recorded = run?.waitReason;
    const kind =
      status === 'queued'
        ? // Both scope and schedule are spelled `queued`, so the status alone
          // cannot tell them apart — the recorded reason is the only thing that
          // can, and `scope` is what a queued run was before schedules existed.
          recorded === 'schedule' || recorded === 'scope'
          ? recorded
          : 'scope'
        : // Any recorded member, exactly as `waitReasonOf` reads it. Widening
          // one and not the other is the drift the vocabulary rule exists to
          // stop: the two answered `scope` and `usage-limit` about one run.
          // ⚠️ The word list is spelled here rather than imported because
          // `status-vocab.js` (which owns `WAIT_REASONS`) imports THIS file —
          // `test/run-lifecycle.test.ts` asserts the two agree over every
          // member, which is what holds the copy honest.
          recorded === 'external' ||
            recorded === 'usage-limit' ||
            recorded === 'scope' ||
            recorded === 'schedule'
          ? recorded
          : Object.values(run?.phases ?? {}).some((record) => record?.status === 'waiting')
            ? 'external'
            : 'usage-limit';
    lifecycle.wait = { kind, until: run?.waitUntil ?? null };
  }
  return lifecycle;
}

/**
 * What this phase record IS. Same contract as `runLifecycle`.
 *
 * The stop kind is read from the status first and from the record's own
 * evidence second, because a `parked` status says only that somebody is owed
 * something — `mcpPark`, `declared` and the lock wait are what say who.
 *
 * @param {{ status?: string, lifecycle?: PhaseLifecycle, mcpPark?: unknown,
 *           declared?: { status?: string }|null, lockWaitSince?: unknown,
 *           verification?: { ok?: boolean }|null }|null|undefined} record
 * @returns {PhaseLifecycle}
 */
export function phaseLifecycle(record) {
  const stored = record?.lifecycle;
  if (stored && /** @type {readonly string[]} */ (PHASE_LIFECYCLE_STATES).includes(stored.state)) {
    return stored;
  }
  const status = /** @type {PhaseStatus} */ (record?.status ?? '');
  // `waiting` for the same reason as the run fold: it is what `UNKNOWN_STATE`
  // paints, so an unrecognised word keeps the colour it has always had.
  const state = PHASE_STATE_FOLD[status] ?? 'waiting';
  /** @type {PhaseLifecycle} */
  const lifecycle = { state };

  let kind = PHASE_STOP_FOLD[status];
  if (!kind && state === 'parked') {
    kind = record?.mcpPark
      ? 'mcp'
      : record?.declared
        ? 'declared'
        : record?.lockWaitSince
          ? 'scope-cap'
          : null;
  }
  if (!kind && state === 'failed') {
    kind = record?.verification?.ok === false ? 'verification' : 'ladder';
  }
  if (!kind && state === 'waiting' && record?.declared) kind = 'declared';
  if (kind) {
    lifecycle.stop = record?.declared?.status ? { kind, declared: record.declared.status } : { kind };
  }
  return lifecycle;
}

/* ------------------------------------------------------------------ *
 * Two helpers, so nothing has to write `.includes` against a frozen array
 * ------------------------------------------------------------------ */

/**
 * Is this run status one the server counts as in flight?
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function isRunInFlight(status) {
  return /** @type {readonly string[]} */ (RUN_IN_FLIGHT).includes(status ?? '');
}

/**
 * Is this phase record settled — nothing will pick it up again by itself?
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function isSettledPhase(status) {
  return /** @type {readonly string[]} */ (SETTLED).includes(status ?? '');
}

/**
 * The same two questions, asked of the LIFECYCLE rather than of the word.
 *
 * These exist to be proved redundant. `test/run-lifecycle.test.ts` asserts each
 * agrees with its status-list twin over every member of `RUN_STATUSES` — that
 * equality is what makes the dual-write safe to land, because it says the fold
 * threw nothing away that either subset was carrying. When 3.6.0 drops
 * `status`, these are what the subsets become.
 *
 * @param {{ status?: string, lifecycle?: RunLifecycle, waitReason?: string|null,
 *           phases?: Record<string, {status?: string}> }|null|undefined} run
 * @returns {boolean}
 */
export function isRunLifecycleInFlight(run) {
  const { state, wait } = runLifecycle(run);
  // `queued` is the exclusion `RUN_IN_FLIGHT` exists for: a run in `admit()`
  // holds no child and no lock, and scope is the only wait that means that.
  return state === 'running' || (state === 'waiting' && wait?.kind !== 'scope');
}

/**
 * Is a loop behind this run — the CLIENT's question, which counts a queued run
 * as live because `admit()` is a loop even though it holds nothing.
 *
 * @param {{ status?: string, lifecycle?: RunLifecycle, waitReason?: string|null,
 *           phases?: Record<string, {status?: string}> }|null|undefined} run
 * @returns {boolean}
 */
export function isRunLive(run) {
  const { state } = runLifecycle(run);
  return state === 'running' || state === 'waiting';
}
