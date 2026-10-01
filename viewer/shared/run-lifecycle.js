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

/**
 * The terminal run statuses that mean "this did not end well".
 *
 * `keep-on-failure`'s one question (phase 7). DERIVED, like every other subset
 * here, and the exclusions are the content: `finished` is the only happy
 * terminal, and `paused` is a person's deliberate act rather than a failure —
 * a paused run's tree is kept for the reason every live run's is, not because
 * anything went wrong. A run still in flight is not asked at all: its tree is
 * not being swept.
 *
 * @type {readonly RunStatus[]}
 */
export const RUN_ENDED_BADLY = Object.freeze(
  RUN_STATUSES.filter((status) => ['halted', 'parked', 'interrupted'].includes(status)),
);

/**
 * Did this run end badly? `undefined` — a run record that could not be read —
 * answers NO: inventing a failure would keep every unreadable run's tree for
 * ever, which is the leak the retention policy exists to bound.
 * @param {{status?: string} | null | undefined} run
 * @returns {boolean}
 */
export function runEndedBadly(run) {
  return RUN_ENDED_BADLY.includes(/** @type {never} */ (run?.status));
}

/**
 * The run statuses a loop comes back to — by itself (a clock, the boot resume,
 * a converge) or at an operator's Resume — and so the statuses whose trees no
 * sweep may take (control-tower phase 82, #94).
 *
 * DERIVED, and the exclusions are the content: `finished` is over, and
 * `interrupted` is decided by the run's own `resumeOnRestart` in
 * `runResumable` below. A sweep that read "not live" as "over" deleted two of a
 * paused run's four mirror mounts at a console restart and again at a pause,
 * and the resume that followed fell back to the shared checkout.
 *
 * @type {readonly RunStatus[]}
 */
export const RUN_RESUMABLE = Object.freeze(
  RUN_STATUSES.filter((status) => !['finished', 'interrupted'].includes(status)),
);

/**
 * Will anything drive this run again? `interrupted` only when the run did not
 * say `resumeOnRestart: false` — absent (a run from before the answer existed)
 * falls back to the console's own default, and a tree kept by mistake costs a
 * directory while a tree swept by mistake costs the run its isolation. A
 * resolved run is over whatever its status says, and an unreadable one is not
 * kept for ever (the leak `runEndedBadly` also refuses to invent).
 * @param {{status?: string, resolved?: unknown, resumeOnRestart?: boolean | null} | null | undefined} run
 * @returns {boolean}
 */
export function runResumable(run) {
  if (!run || run.resolved) return false;
  if (run.status === 'interrupted') return run.resumeOnRestart !== false;
  return RUN_RESUMABLE.includes(/** @type {never} */ (run.status));
}

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
    /** Every command that could run has passed; a person still owes the sign-off on the checks that could not (`PHASE_STOP_FOLD` → `human-check`). */
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

/**
 * The phase statuses that are settled WELL: the only ones a run may call its
 * work over (#43). `done`, and `skipped` — which has exactly two writers, the
 * operator's Skip and its stored-run twin, both noting "skipped by the
 * operator".
 *
 * An allow-list of the good words, never a deny-list of the bad ones. The
 * scoped finish used to ask whether an asked phase was `parked`, `gated` or
 * `failed`, so a `pending` phase with an open errand and one that never
 * boarded both read as settled — and so would the next status anybody adds.
 *
 * @type {readonly PhaseStatus[]}
 */
export const SETTLED_WELL = Object.freeze(
  PHASE_STATUSES.filter((status) => ['done', 'skipped'].includes(status)),
);

/**
 * Is this phase settled WELL — may a run that asked for it say it is over?
 *
 * Its status is one of `SETTLED_WELL`, and it holds no standing recovery
 * errand whatever that status says: an errand is an ask nobody has answered,
 * and a phase that has one is still owed something (#43).
 *
 * The one predicate the drive loop's scoped finish, the read path's
 * correction of a stored run (`runner/state.ts`) and the inbox's attention
 * gate ask, so the three cannot disagree. It lives here, beside `SETTLED`,
 * because a status model on the client has to ask it too.
 *
 * @param {{ status?: string }|null|undefined} record
 * @param {unknown} [errand]  the phase's standing errand (`recoveries[N].errand`), when it has one
 * @returns {boolean}
 */
export function phaseSettledWell(record, errand) {
  if (errand) return false;
  return /** @type {readonly string[]} */ (SETTLED_WELL).includes(record?.status ?? '');
}

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
    /**
     * The API refused the run's OWN credential. Run-level since
     * zero-touch-console phase 9, and absent from this list until 5.2.0 —
     * which is the drift the owner exists to prevent: the runner had an arm
     * for it, the vocabulary did not have the word.
     */
    'credential-refused',
    /**
     * This machine could not reach the API. Not the credential's fault, not
     * the phase's and not the plan's — so it charges nothing at all and the
     * lane simply backs off and tries again. It had no name until 5.2.0, and
     * an outage-shaped stop therefore fell through to `phase-failed`, which
     * spends the run's "this plan is broken" bound on the weather.
     */
    'connectivity',
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
 * Why an ending is OFFERED to the run's failure streak — the one argument
 * `chargeFailure` takes besides the phase (control-tower phase 45, #45, #59).
 *
 * The streak is the run's single "this plan is broken, stop" bound, and
 * `failure-streak` is a press-only halt, so what may spend it is the whole
 * question. It used to be answered by counting ENDINGS: a rescued flake, the
 * same phase ending twice, a wait the budget refused — each was "a phase failed
 * in a row". Measured over one week: all six verify-failed halts were commands
 * rescued on their retry, and three of the six streak halts counted one phase
 * twice or a refused wait. The streak is now the ordered set of DISTINCT phases
 * whose ending is a MERIT failure (`MERIT_FAILURE_CAUSES`), and an ending whose
 * cause is not one of those is journalled as held and moves nothing.
 *
 * Not in this list at all, because they never reach `chargeFailure`: a rescued
 * command (the verdict is green — `verificationVerdict`), a wait the budget
 * refused (a BUDGET event: the phase parks `waiting` with a `budgets` errand)
 * and a refused credential (phase 3). The other two rules are properties, not
 * causes: a second ending of a phase already in the set charges nothing, and a
 * phase the board closes leaves the set.
 */
export const FAILURE_CAUSES = Object.freeze(
  /** @type {const} */ ([
    /** A §Verification command whose FINAL attempt is red. */
    'verify-red',
    /** The phase left the plan failing `validate.sh` — the verification's own second check. */
    'plan-lint',
    /** A person marked the manual checks failed. */
    'checks-failed',
    /** The session ended with no complete handoff and nothing on disk. */
    'no-handoff',
    /** The handoff, or the session itself, declared the phase blocked. */
    'declared-blocked',
    /** Every attempt the phase's session got ended in failure. */
    'crash',
    /**
     * No complete handoff, but the session's work is on disk (commits or a
     * dirty tree in its scope). Unfinished paperwork, not a broken plan: the
     * ladder's `work-in-progress` rungs are what answer it.
     */
    'no-handoff-worked',
    /**
     * The attempts ran out on the network (half a day unreachable, or a
     * session that died before its first turn every time). The weather says
     * nothing about the plan (phase 3).
     */
    'connectivity',
    /**
     * A declared block naming a ref the watch clock can poll (control-tower
     * phase 87, #122). The runner parks it `waiting` on that ref and never
     * offers it here; one that reaches the charge anyway — a record no park
     * could take — is a wait someone else's work will end, not a claim about
     * the plan.
     */
    'declared-wait',
  ]),
);

/**
 * @typedef {(typeof FAILURE_CAUSES)[number]} FailureCause
 */

/**
 * The failure causes that are a claim about the PLAN — the only ones the
 * streak counts. Derived, and the exclusions are the content: `no-handoff-worked`
 * (work on disk, paperwork missing), `connectivity` (the weather) and
 * `declared-wait` (a block the watch clock can end — someone else's work).
 *
 * @type {readonly FailureCause[]}
 */
export const MERIT_FAILURE_CAUSES = Object.freeze(
  FAILURE_CAUSES.filter(
    (cause) => cause !== 'no-handoff-worked' && cause !== 'connectivity' && cause !== 'declared-wait',
  ),
);

/** Does an ending with this cause advance the failure streak? */
export function isMeritFailure(cause) {
  return MERIT_FAILURE_CAUSES.includes(/** @type {never} */ (cause));
}

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
    /**
     * Its lane never spawned: a sibling took the scope, or a park withdrew the
     * queue entry it was waiting in. NOTHING HAPPENED — so it costs nothing,
     * counts toward no cap, does not consume its own rung, and writes no
     * errand.
     *
     * Distinct from `superseded`, which is a rung whose GOAL was met by
     * something else, and from `failed`, which is a verdict. Reading this state
     * as `failed` is what exhausted a one-rung table over a phase nothing was
     * wrong with, and parked a zero-touch run for five hours (#16).
     */
    'withdrawn',
    /** It ran and did not hold. */
    'failed',
    /**
     * Cut short. Counts toward no rung cap, and it can run again. Also what a
     * rung settles to when the console's own watchdog parked its attempt — the
     * watchdog's act, never the session's declaration (control-tower phase 47,
     * #52: such a rung used to read `no-defect`, "the session declared …").
     */
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
 * The licences under which a phase's standing declaration may be SPENT — the
 * only ways `record.declared` is ever deleted (`consumeDeclaration` in
 * `server/runner/state.ts` is the one writer, and takes one of these as `why`).
 *
 * `new-outcome`: the session declared something else, and the new word
 * supersedes the old. `session-productive`: the parked session resumed and made
 * durable progress (a commit, a `phase-outcome.sh` call), so the wait it
 * declared is over. `board-closed`: the board reads the phase done, whatever the
 * record still says. `retry`: a Retry — an operator's press, or a console path
 * that says so — asks for the phase again from the top.
 *
 * Every one of them journals `phase.declaration-consumed` naming itself (the
 * audit's WAI-9 found two of the four spending testimony in silence, and the
 * commonest ending — the board closing a parked phase — leaving no line at
 * all). Owned here since zero-touch-console phase 6, so the server's type is
 * derived and a fifth licence is one edit.
 *
 */
export const DECLARATION_CONSUMERS = Object.freeze(
  /** @type {const} */ (['new-outcome', 'session-productive', 'board-closed', 'retry']),
);

/**
 * @typedef {(typeof DECLARATION_CONSUMERS)[number]} DeclarationConsumer
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
 * Why a `lock:` watch naming the DECLARING phase's own lock is refused (#42).
 *
 * The declarer is the holder: the console claims a phase's lock before its
 * session boards and releases it at that session's closeout, so a watch on it
 * fires on the phase's own teardown and resumes a session for external work
 * that never existed. `phase-outcome.sh` refuses the flag with this sentence
 * (exit 2, word for word), the console refuses the ref at ingest for a
 * declaration an older script wrote, and the watch clock refuses one armed
 * before either existed.
 */
export const OWN_LOCK_WATCH_REFUSAL =
  "a lock: watch is for somebody else's lock: this one names the declaring phase's own lock, which its own " +
  'closeout releases, so the watch would fire on its own teardown (#42). Name the lock phase-lock.sh conflicts ' +
  'reported instead, or declare --needs lock with no watch and the console queues the phase behind whoever holds ' +
  'it; a phase blocked on a person takes no watch at all.';

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
 * Who said a session ended — `sessions/registry.ts` `SessionRecord.endedBy`
 * (zero-touch phase 16, REG-9). `hook` is a SessionEnd the session reported
 * itself, at the moment it gave; `probe` is the registry finding the process
 * gone, which is an INFERENCE: `endedAt` is then the last evidence of life
 * (`lastSeen`) and `endedDetectedAt` the moment the probe noticed, and every
 * page draws it differently from a reported end.
 */
export const PRESENCE_END_SOURCES = Object.freeze(/** @type {const} */ (['hook', 'probe']));

/**
 * @typedef {(typeof PRESENCE_END_SOURCES)[number]} PresenceEndSource
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
    /**
     * A live Claude session the presence registry shows in this repository,
     * holding no lock (zero-touch phase 16, REG-3) — the first minute of every
     * hand session, before its claim. Named with its session id, pid and cwd;
     * queued behind, never capped into a park, never force-released.
     */
    'session',
    /**
     * A phase of the SAME run parked on an external wall its session declared
     * (`needs-human`/`blocked` with `--needs external`) while it still holds a
     * live watch ref or an in-budget errand — the scope fence (control-tower
     * phase 6, #19). Written on the fenced phase's `waitingOn` by the drive
     * loop and the healer, never by the scheduler's scan: it is a statement
     * about this run's own wall, not about another claim on the repository.
     * Lifted by a landing, an operator's Retry or Release of the fencing
     * phase, or the end of its wait budget (`FENCE_LIFT_REASONS`).
     */
    'fence',
    /**
     * A repository in this admission's scope stands on the branch ANOTHER open
     * run put there (control-tower phase 40, #41). A lock is per phase; the
     * branch a run checks a shared repository onto is per RUN, so a phase that
     * boarded between that run's phases would build and verify against its
     * in-flight work. Named with the repository, the branch and the run; asked
     * only of a run in the SHARED checkout (a mirror, a lane or an isolated
     * run stands in trees of its own). Lifted when the tree leaves that branch
     * or the holding run settles; a skip, never a reservation, never capped.
     */
    'branch',
    /**
     * A dependency of this entry's phase, in its own plan, is not done
     * (control-tower phase 86, #136): the board took it back from done — a
     * `partial` after an INDEX flip, a red final verification, a reconcile —
     * after this phase was queued. Named with the dependency's number; asked
     * of the runner's latest board at every scan and re-checked on a fresh
     * board at the grant. A skip, never a reservation, never capped; the
     * entry keeps its place and its age, and is admitted the scan it clears.
     */
    'after',
  ]),
);

/**
 * @typedef {(typeof HOLDER_KINDS)[number]} HolderKind
 */

/**
 * Why a scope fence came down — the `why` on `phase.fence-lifted`
 * (control-tower phase 6, #19):
 *
 *   - `landed` — a watch ref of the fencing phase landed; its own session
 *     resumes, and its siblings queue behind it rather than into the wall.
 *   - `retry` — an operator's Retry of the fencing phase spent its declaration.
 *   - `release` — an operator released the fencing phase's lock.
 *   - `budget` — the fencing phase's wait budget ran out.
 *   - `cleared` — the wall stopped standing some other way: the phase was
 *     skipped or finished, or it holds neither a live ref nor its errand.
 */
export const FENCE_LIFT_REASONS = Object.freeze(
  /** @type {const} */ (['landed', 'retry', 'release', 'budget', 'cleared']),
);

/**
 * @typedef {(typeof FENCE_LIFT_REASONS)[number]} FenceLiftReason
 */

/**
 * What KIND of thing is queued. Absent reads as `phase`.
 *
 * The split exists because the boarding schedule exempts `recovery` and the
 * fleet freeze deliberately does not — a recovery is still work, and an
 * operator who froze the console froze it.
 *
 * `agent` is the one kind with no run behind it (control-tower phase 12, #29):
 * a ticket a person minted from a button — "Fix this issue" — holding its
 * repository's scope for as long as its terminal lives. It never QUEUES: a
 * person is waiting at the button, so an intersecting lock or grant is a 409
 * naming the holder (`Scheduler.grantAgent`), and its grant carries a ticket
 * where every other grant carries a `runId`.
 */
export const QUEUE_KINDS = Object.freeze(/** @type {const} */ (['phase', 'recovery', 'agent']));

/**
 * @typedef {(typeof QUEUE_KINDS)[number]} QueueKind
 */

/**
 * When an account switch takes the run's live lanes with it (control-tower
 * phase 78, #107). `now` — the default — checkpoints every live lane that is
 * still working; a lane only closing out (its handoff reads complete, or its
 * session has declared its outcome) finishes where it is either way.
 * `boundary` checkpoints none: every live lane finishes on the account it
 * started on, and every later admission — the queued ones included — is on the
 * new one. The one press that splits load across accounts without killing work.
 */
export const SWITCH_WHEN = Object.freeze(/** @type {const} */ (['now', 'boundary']));

/**
 * @typedef {(typeof SWITCH_WHEN)[number]} SwitchWhen
 */

/**
 * How a queue EPISODE ended — the `outcome` on `phase.queue-closed`
 * (control-tower phase 60, #81). An episode opens with `phase.queued` and closes
 * exactly once, its length folded into the record's cumulative `queuedMs`:
 *
 *   - `admitted` — the scope was granted (`phase.admitted` names what released it);
 *   - `withdrawn` — the run paused, halted, parked or stopped while it waited,
 *     or its only holders became its own run's live lanes (`why: 'serial'`);
 *   - `restarted` — the console that held the queue went away, and the next one
 *     found the episode still open;
 *   - `capped` — the two-hour lock-wait cap parked it behind a claim nobody is behind.
 *
 * A withdrawn or restarted episode keeps the entry's AGE and aging reservation
 * on the record (`queueSince`, `queueReserving`), so the next admission is born
 * where the last one stood rather than at the back of the queue.
 */
export const QUEUE_OUTCOMES = Object.freeze(
  /** @type {const} */ (['admitted', 'withdrawn', 'restarted', 'capped']),
);

/**
 * @typedef {(typeof QUEUE_OUTCOMES)[number]} QueueOutcome
 */

/**
 * Who a queue holder IS, for the question "is this run blocked by others?"
 * (control-tower phase 60, #64). The holder KIND says what the claim is made
 * of; the CLASS says whose it is — which is what queue metrics split by:
 *
 *   - `own-run` — this run's own lane, reservation or wall: pipelining, not
 *     contention. A ready phase behind a LIVE own lane is never queued at all
 *     (`serialBehind`); this class is the brief window before that is seen;
 *   - `other-run` — another autopilot run's grant, lock, reservation, branch,
 *     radar order or console;
 *   - `hand` — a person's lock or a live session with no claim;
 *   - `clock` — a policy or capacity: a freeze, the boarding window, a hold, a
 *     chain, a usage wall or brake, a session, repository or machine cap.
 */
export const HOLDER_CLASSES = Object.freeze(/** @type {const} */ (['own-run', 'other-run', 'hand', 'clock']));

/**
 * @typedef {(typeof HOLDER_CLASSES)[number]} HolderClass
 */

/**
 * The order a run's BLOCKED wall-clock is charged in (control-tower phase 60,
 * #64) when several of its phases wait at once behind holders of different
 * classes: each instant goes to exactly one class — the first in this list
 * heading any of them — so the split sums to the time the run was blocked and
 * never to its phases' lane-time. Everyone else before the run itself, in
 * `HOLDER_CLASSES` order: another run, then a person, then a clock.
 */
export const BLOCKED_BY_ORDER = Object.freeze(
  /** @type {readonly HolderClass[]} */ ([
    ...HOLDER_CLASSES.filter((klass) => klass !== 'own-run'),
    'own-run',
  ]),
);

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

/**
 * What woke an automatic resume — the `trigger` on `phase.resume-automatic`
 * (LFC-7). The convergence loop's own triggers, plus the resumes that are not
 * the loop's: a landed watch ref (`watch`), the outcome inbox acting on a
 * session's declaration (`inbox`), and the runner acting on one it read
 * itself (`outcome` — the wrap-up resume). The event used to be called
 * `phase.resume-at-boot`, and that name was true of 15 of its 25 lines: the
 * rest were a docs change and a sweep.
 * @type {readonly (ConvergeTrigger | 'watch' | 'inbox')[]}
 */
export const RESUME_TRIGGERS = Object.freeze([...CONVERGE_TRIGGERS, 'watch', 'inbox', 'outcome']);

/** @typedef {(typeof RESUME_TRIGGERS)[number]} ResumeTrigger */

/**
 * WHICH automatic resume it was — the `path` on `phase.resume-automatic`. The
 * ways the console resumes a phase with no person in the loop, and until
 * zero-touch-console phase 5 the shipped ask and its counter bounded two:
 *
 *   - `killed-lane` — a lane a console restart cut off, resumed on its own session.
 *   - `overdue-wait` — a park whose clock went by while nothing ran, ruled on
 *     (lateness journalled, refs checked, budget re-read) before it resumed.
 *   - `rearm` — a lock-cap park whose lock is gone.
 *   - `system-stop` — a run a console shutdown stopped between lanes.
 *   - `inbox-partial` — a session nobody here started declared `partial`.
 *   - `watch-landed` — a declared watch ref landed.
 *   - `wrapup` — a session the console's own wrap-up notice reached declared
 *     `partial --reason context|budget`, as told; it boards fresh with the
 *     resume brief and spends no ladder rung (control-tower phase 5, #14).
 *   - `live-lane` — a declared watch ref landed while this run's loop is LIVE:
 *     the phase is handed to the run's own lanes (`Runner.landWatch`) and
 *     admitted with a reservation, never through `recoverPhase`, whose busy
 *     refusal used to spend the landing (control-tower phase 6, #15).
 *   - `gate-cleared` — a phase the run boarded and parked `gated` whose
 *     automatic gate now reads clear — another plan landing, a date passing
 *     (control-tower phase 51, #48).
 */
export const RESUME_PATHS = Object.freeze(
  /** @type {const} */ ([
    'killed-lane',
    'overdue-wait',
    'rearm',
    'system-stop',
    'inbox-partial',
    'watch-landed',
    'wrapup',
    'live-lane',
    'gate-cleared',
  ]),
);

/** @typedef {(typeof RESUME_PATHS)[number]} ResumePath */

/**
 * Who parked a phase — `by` on the declaration and on `phase.waiting` (SLF-9).
 * The session itself (`phase-outcome.sh` under a supervisor), a session nobody
 * here started, through the inbox (`unsupervised`), the console's own stall
 * watchdog (`watchdog`) — whose park is the console's inference, never the
 * session's testimony, and spends a ledger of its own (WAI-5) — or the
 * ladder (`ladder`, zero-touch-console phase 10): a `wait-window`, `poll-park`
 * or `timed-park` rung the healer climbed on a stopped run, bounded by the
 * rung caps and the same-rung-once rule rather than by the declared wait
 * budget, and, like the watchdog's, shown but never budgeted.
 */
export const WAIT_AUTHORS = Object.freeze(
  /** @type {const} */ (['session', 'watchdog', 'unsupervised', 'ladder']),
);

/** @typedef {(typeof WAIT_AUTHORS)[number]} WaitAuthor */

/* ------------------------------------------------------------------ *
 * The doors an automatic start comes through, and who opened one
 * ------------------------------------------------------------------ */

/**
 * Every code path that starts a `claude` process with no person in the loop —
 * the sep-review audit's chapter 02 census (SLF-1). Sixteen doors: nine are
 * `startRun` callers, five spawn a session some other way and two — a stored
 * trigger (control-tower phase 98) and the supervisor (phase 101) — ride their
 * verb's own door, and until this
 * list existed no record named which one had opened — 324 of 326 `run.start`
 * lines carried no `by` at all, and "the autopilot keeps invoking itself"
 * needed three logs correlated by timestamp to attribute.
 *
 * The list is the VOCABULARY, and since zero-touch-console phase 7 every site
 * says its word: `run.start` carries an `Actor` with a `door` always, a lint
 * in `test/invariants.test.ts` fails any `startRun(` site naming none, and
 * `test/vocab-owners.test.ts` holds the members to this one owner. Order is
 * the census's: the nine `startRun` doors first, then the seven that are not.
 * A verb several doors share (`retryPhase`, `recoverPhase`) carries its
 * CALLER's actor through rather than naming a door of its own — the door is
 * where the decision to start was made, not where the start happens.
 *
 *   - `boot-readopt` — `open()` re-adopting a `queued` run at console boot.
 *   - `wait-clock` — `armLimitResume`'s timer firing on a `waitUntil`.
 *   - `converge-relaunch` — the convergence loop's `relaunch` verb, on any of
 *     its triggers (`CONVERGE_TRIGGERS`).
 *   - `converge-heal` — the convergence loop's `heal` verb climbing a ladder.
 *   - `recovery-continue` — a ladder recovery resolved `fixed`, so the run
 *     continues.
 *   - `pty-continue` — a pty recovery agent exited `fixed`, so the run
 *     continues.
 *   - `watch-landed` — a watch ref landed, the drive settled, the run continues.
 *   - `mcp-require-timeout` — the `require` park's clock ran out and the run
 *     continues without the server.
 *   - `outcome-inbox` — the unsupervised outcome inbox re-boarding a session
 *     that declared `waiting-external` or `partial`.
 *   - `mcp-health-probe` — the MCP registry's `claude --print ok` health probe.
 *   - `mcp-boarding-preflight` — the per-boarding MCP preflight session.
 *   - `auto-reviewer` — the automatic reviewer session over a finished phase.
 *   - `ultrareview` — the cloud `ultrareview` child.
 *   - `ladder-pty-agent` — the ladder's interactive pty agent.
 *   - `trigger` — a stored trigger firing its verb (control-tower phase 98,
 *     #137): a person armed it, nobody pressed it. It opens no `startRun` site
 *     of its own — its actor rides the verb's own door (`resumeRun`,
 *     `pressRetry`, `pressResume`, the boundary re-board), so whatever it
 *     starts is an automatic start the per-instance ceiling counts.
 *   - `supervisor` — the supervisor's detect → remedy pass pressing a remedy
 *     under its `act` policy (control-tower phase 101, #145): nobody pressed
 *     it. Like `trigger` it opens no `startRun` site of its own — it presses
 *     the verb's own `Service` method (`server/verb-press.ts`) — so whatever
 *     it starts is an automatic start the ceiling counts.
 */
export const START_DOORS = Object.freeze(
  /** @type {const} */ ([
    'boot-readopt',
    'wait-clock',
    'converge-relaunch',
    'converge-heal',
    'recovery-continue',
    'pty-continue',
    'watch-landed',
    'mcp-require-timeout',
    'outcome-inbox',
    'mcp-health-probe',
    'mcp-boarding-preflight',
    'auto-reviewer',
    'ultrareview',
    'ladder-pty-agent',
    'trigger',
    'supervisor',
  ]),
);

/** @typedef {(typeof START_DOORS)[number]} StartDoor */

/**
 * How an actor reached the console — the transport a verb arrived by. `api`
 * is an HTTP request (a browser, a phone, a curl), `cli` the command line
 * (`bin/btw`, `phase-console`), `signal` a process signal (SIGTERM, a launchd
 * unload), `timer` one of the console's own clocks, `boot` the console
 * starting up, `hook` a Claude Code hook body (a session's presence or
 * permission traffic), and `event` something the console OBSERVED rather than
 * scheduled — a recovery session exiting, a declaration landing in the
 * outcome inbox. Phase 7 added `event` when it wired the doors: three of the
 * fourteen are opened by an observation, and calling that a `timer` would
 * have been the record lying about its own clock. `supervisor` (control-tower
 * phase 101, #145) is the supervisor's pass pressing a remedy: neither a clock
 * nor a request, and a reader of the journal must be able to tell its acts
 * from a person's and from a trigger's.
 *
 * For an HTTP request the transport is DERIVED, never supplied: the User-Agent
 * class decides `api` against `cli`, the Host header decides `origin`, and the
 * proxy's identity header fills `remoteUser` (`server/api/actor.ts`).
 */
export const ACTOR_VIAS = Object.freeze(
  /** @type {const} */ ([
    'api',
    'cli',
    'signal',
    'timer',
    'boot',
    'hook',
    'event',
    'supervisor',
  ]),
);

/** @typedef {(typeof ACTOR_VIAS)[number]} ActorVia */

/**
 * The one door that is not automatic: a person pressed Start, Retry, Recover
 * or Continue. Deliberately NOT a member of `START_DOORS` — that list is the
 * census of starts nobody asked for, and the per-instance start ceiling
 * (`server/start-ceiling.ts`) counts exactly its members — but it is still a
 * word the `door` field carries, because the lint that holds every
 * `startRun(` site to a door has to accept the press sites too.
 */
export const OPERATOR_DOOR = 'operator';

/** @typedef {StartDoor | typeof OPERATOR_DOOR} AnyDoor */

/**
 * Who classified a phase — the `by` on `phase.situation` and `phase.rung`
 * (chapter 05 RCV-9: 1 249 of 1 332 situation lines and 132 of 170 rung lines
 * carried none). One vocabulary for both writers: the runner's drive loop
 * (`drive`), its outcome and closed-session arms (`outcome`, `closed`), and
 * the convergence loop's healer (`heal`). The watch clock and the outcome
 * inbox RESUME a phase and never classify one, so they have no word here —
 * a member nobody writes is the shape LFC-5 spent a phase removing.
 */
export const CLASSIFIED_BY = Object.freeze(/** @type {const} */ (['drive', 'outcome', 'closed', 'heal']));

/** @typedef {(typeof CLASSIFIED_BY)[number]} ClassifiedBy */

/**
 * The one attribution shape every verb that acts on a run records —
 * `run.start`, `run.stop-requested`, `shutdown.requested`, `restart.requested`,
 * `run.account-switch`, `phase.situation`, `phase.rung`, `phase.waiting` — so
 * that "who did this, from where, through which door" is one question with one
 * answer wherever it is asked (chapter 02 SLF-1, chapter 01 LFC-6).
 *
 *   - `by` — who: `operator`, `console`, `watchdog`, `autopilot`, a session id.
 *   - `via` — the transport, one of `ACTOR_VIAS`.
 *   - `origin` — where it came from: a remote address, a hostname, `local`, or
 *     the timer's or hook's own name.
 *   - `remoteUser` — the authenticated remote user when the access layer knows
 *     one, else `null` — never omitted, so a record with no user is
 *     distinguishable from a record written before the field.
 *   - `door` — for a start, one of `START_DOORS`, or `OPERATOR_DOOR` when a
 *     person pressed it.
 *   - `trigger` — what fired the door: a converge trigger, a timer's name, a
 *     watch ref, an inbox file.
 *   - `guard` — the predicate that let it through, by name.
 *   - `counter` — the bound it spent (`MAX_BOOT_RESUMES`, a rung cap, the
 *     per-instance ceiling), with the count after this start.
 *   - `reason` — WHY, in the words of the person who pressed it (control-tower
 *     phase 96, #142): optional, absent unless a request body carried one, and
 *     capped by `actorOfRequest`. It rides the actor rather than each verb's
 *     own payload because every line that spreads the actor then carries it —
 *     a verb cannot drop the why its caller gave without dropping the who.
 *
 * The field names are ALSO an array, not only a typedef, because a typedef in
 * a `.js` file is invisible to a source scan and this shape is a vocabulary
 * with one owner that a test can hold emitters to.
 *
 * @typedef {{ by: string, via: ActorVia, origin: string, remoteUser: string|null,
 *             door?: AnyDoor, trigger?: string, guard?: string, counter?: string,
 *             reason?: string }} Actor
 */
/**
 * What a `run:progress` frame carries, and therefore what a surface may move on
 * between phase boundaries.
 *
 * The problem this names: while a phase is actually working, the only event
 * arriving is `run:stream`, and `run:stream` invalidates nothing on purpose —
 * routing a firehose through the query cache would refetch the whole run object
 * per streamed line. The events that DO invalidate fire at phase boundaries,
 * and on a long plan that is once an hour, so every cache-backed surface was
 * correct at boot and then again up to an hour later.
 *
 * So: a small frame, at most one per live lane per three seconds, applied as a
 * PATCH and never as an invalidation — no round trip per line, and the Runs
 * list, the plan's Run tab and the Now lanes move while a phase talks.
 *
 * The field names are an array and not only a typedef, for `ACTOR_FIELDS`'
 * reason: a typedef in a `.js` file is invisible to a source scan, and this is
 * a vocabulary with one owner that a test can hold both ends of the wire to.
 * `liveness()` supplies only half of it — it knows output, tools, stalls,
 * tokens and this session's dollars, and nothing about phase status, the
 * attempt or the task counts — so a frame joins the run's own record beside it.
 *
 * `phaseClocks` (#28, `shared/phase-clocks.js`) rides the frame as the labelled
 * clocks at the moment it was built; the digest reads only their stable half,
 * so a clock that merely ticked never re-sends a frame.
 *
 * @typedef {{ phase: number, status: string, attempt: number, attemptStartedAt: string|null,
 *             tasks: {total: number, done: number, active: number}|null,
 *             spentUsd: number|null, contextTokens: number|null, stall: string|null,
 *             phaseClocks: import('./phase-clocks.js').PhaseClocks|null }} RunProgress
 */
export const RUN_PROGRESS_FIELDS = Object.freeze(
  /** @type {const} */ ([
    'phase',
    'status',
    'attempt',
    'attemptStartedAt',
    'tasks',
    'spentUsd',
    'contextTokens',
    'stall',
    'phaseClocks',
  ]),
);

export const ACTOR_FIELDS = Object.freeze(
  /** @type {const} */ ([
    'by',
    'via',
    'origin',
    'remoteUser',
    'door',
    'trigger',
    'guard',
    'counter',
    'reason',
  ]),
);

/* ------------------------------------------------------------------ *
 * How a session ended, what it was for, and where its caps came from
 * ------------------------------------------------------------------ */

/**
 * Who ended a `claude -p` session — the `endedBy` every `phase.session` record
 * carries (the sep-review audit's chapter 03, SES-1 and SES-11).
 *
 * The CLI books a session's turns and dollars on its `result` message, and
 * until zero-touch-console phase 4 every ending the console caused was a bare
 * SIGTERM — which leaves the turn unfinished and writes no `result` at all. In
 * the audit's six plans 27 of 88 records read 0 turns and $0 for 18.99 hours of
 * work, and nothing said why. A record now names its ending instead of leaving
 * an absent `subtype` to imply one:
 *
 *   - `exit` — nothing in the console ended it: the CLI finished its turn and
 *     left, failed on its own, or never started.
 *   - `stop` — an operator's Stop, of the whole run or of this lane.
 *   - `checkpoint` — the console checkpointed a live lane to resume it later: a
 *     freeze past its escalation clock, a usage wall under `pause`.
 *   - `shutdown` — the console shut down or restarted with the lane live.
 *   - `account-switch` — checkpointed to carry on under another account.
 *   - `watchdog` — the runner's liveness remedies: a silent-lane recycle, a
 *     retry-storm recycle or park, a stall park, an external-wait park.
 *   - `spawn-watchdog` — `spawn.ts`'s own clocks, which need no runner behind
 *     them: the first-event backstop and the init→first-result bound.
 */
export const ENDED_BY = Object.freeze(
  /** @type {const} */ ([
    'exit',
    'stop',
    'checkpoint',
    'shutdown',
    'account-switch',
    'watchdog',
    'spawn-watchdog',
  ]),
);

/** @typedef {(typeof ENDED_BY)[number]} EndedBy */

/**
 * What a spawned session was for — `phase.session.mode`. Every site under
 * `server/runner/` that starts a `claude -p` goes through one door
 * (`RunnerBase.spawnSession`) and names its purpose with one of these, so the
 * ledger's spend reads per purpose instead of being lumped into the phase — and
 * a session no census could see (a resume wrote three fields; a closeout, a QA
 * round, a PR session and the reviewer wrote none) has a record like the rest.
 *
 *   - `phase` — a phase attempt: a fresh boot, a wait-resume, a ladder brief, a
 *     checkpoint resume.
 *   - `resume` — `resumeWithInstruction`: the phase's own session resumed with
 *     an operator's or a rung's instruction.
 *   - `repair` — a repair session briefed for one recovery class.
 *   - `qa` — a QA round: the finish-time verdict or a `qa-recover` round.
 *   - `closeout` — the phase's own session resumed to finish its paperwork.
 *   - `pr` — the session that opens the run's pull request or settles its merge
 *     queue.
 *   - `landing` (Pro) — the session that opens ONE phase's pull request after
 *     the console pushed its branch, and records the landing ledger row.
 *   - `review` — the automatic reviewer over a finished phase.
 */
export const SESSION_MODES = Object.freeze(
  /** @type {const} */ ([
    'phase',
    'resume',
    'repair',
    'qa',
    'closeout',
    'pr',
    'review',
  ]),
);

/** @typedef {(typeof SESSION_MODES)[number]} SessionMode */

/**
 * Where a session's turn cap or dollar cap came from — the `source` beside
 * `phase.session.maxTurns` and `.maxBudgetUsd` (SES-8, LFC-8). Every spawn
 * carries both `--max-turns` and `--max-budget-usd`, and a spent cap is only
 * distinguishable from a crash when the record says which policy set it:
 *
 *   - `run` — the run's own `phaseBudgetUsd`, whole or a quarter of it.
 *   - `measured` — a mode's p99 plus headroom over the console's own
 *     `phase.session` lines, or the table shipped with the release, measured
 *     the same way (control-tower phase 59, #83); the cap carries its
 *     `derivation` — percentile, headroom, window, samples.
 *   - `size` — the phase's `Size:` in the plan, through the console's
 *     per-size defaults. Written before 6.0 only: the size tag did not
 *     separate an M's spend from an L's, so no cap reads it now.
 *   - `closeout` — `CLOSEOUT_MAX_TURNS`: a closeout, a closeout brief, a QA
 *     round, a landing, a PR or review session — paperwork and bounded reviews.
 *   - `remaining` — a session that CONTINUES the phase's work (a resume with an
 *     instruction, a wait-resume): the size row's turns minus the turns the
 *     phase already spent, never under `RESUME_MIN_TURNS` (control-tower
 *     phase 46, #61).
 *   - `repair` — `REPAIR_MAX_TURNS`.
 *   - `qa-round` — a `qa-recover` round's own budget.
 *   - `raise` — doubled after the CLI reported the cap spent and the session
 *     was resumed to carry on.
 *   - `caller` — a number handed to `spawnClaude` with no source named; no
 *     runner spawn writes it.
 *   - `spawn-default` — nothing was handed in, so `spawn.ts` applied its own
 *     floor; no runner spawn writes it either.
 *   - `chat` — the supervisor chat's own caps (Pro, control-tower phase 27).
 */
export const CAP_SOURCES = Object.freeze(
  /** @type {const} */ ([
    'run',
    'measured',
    'size',
    'closeout',
    'remaining',
    'repair',
    'qa-round',
    'raise',
    'caller',
    'spawn-default',
  ]),
);

/** @typedef {(typeof CAP_SOURCES)[number]} CapSource */

/**
 * What the console decided about an in-session usage warning —
 * `run.usage-decision.action` (SES-9). The CLI's `rate_limit_event` says
 * `allowed_warning` with the window's utilization long before it says
 * `rejected`; past the alert threshold the run's `onLimit` picks one of these:
 *
 *   - `throttle` — `wait` with automatic account switching off: hold new work
 *     for the window.
 *   - `switch` — `switch`, or `wait` with automatic switching on: move to an
 *     account with headroom.
 *   - `park` — `pause`: checkpoint the lane for a person.
 *   - `none` — nothing can act on it (no other account, a lane standing down).
 *
 * The switch and the park are carried out at the wall by the live wall. What the
 * decision itself enacts (autopilot-token-drain phase 6) is the usage brake —
 * no new lane on the account while one is live — unless a `switch` has an
 * account with headroom; so `enacted` is true only for a `throttle`, which the
 * brake carries out, and `brake` says whether the account is braked.
 */
export const USAGE_DECISION_ACTIONS = Object.freeze(
  /** @type {const} */ (['throttle', 'switch', 'park', 'none']),
);

/** @typedef {(typeof USAGE_DECISION_ACTIONS)[number]} UsageDecisionAction */

/* ------------------------------------------------------------------ *
 * The seven policy words an operator sets
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
 * What a run may do to a phase's model (control-tower phase 54, #91).
 *
 * `ladder` is the default and today's behaviour: a per-model wall steps down,
 * `--fallback-model` demotes in-process, an `escalate: model` rung steps up.
 * `pinned` is "this model, or wait": none of those, and a session the CLI
 * starts on another model is parked before it spends. The bash twin is
 * `scripts/models.env`'s `MODEL_POLICIES`, which `**Model policy:**` is read
 * against.
 */
export const MODEL_POLICIES = Object.freeze(/** @type {const} */ (['ladder', 'pinned']));

/** @typedef {(typeof MODEL_POLICIES)[number]} ModelPolicy */

/** What a run that names no policy does — the behaviour before the word existed. */
export const DEFAULT_MODEL_POLICY = /** @type {const} */ ('ladder');

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
 * What a PHASE RECORD is. Eight words against `PHASE_STATUSES`' twelve.
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
    // A lifecycle stored `paused` beside a clock nobody paused is what the
    // writer before control-tower phase 88 left (#148) — every run reconciled
    // off a wait — and nothing rewrites it until its next status write. The
    // run's own facts outrank that stale axis; every other stored answer stands.
    if (stored.state !== 'paused' || !pausedWaitOf(run)) return stored;
  }
  const status = /** @type {RunStatus} */ (run?.status ?? '');
  // A word the vocabulary does not hold folds to `waiting`, and the choice is
  // forced rather than aesthetic: `status-vocab.js` paints an unrecognised word
  // as `UNKNOWN_STATE`, which IS `waiting`, so any other fallback would repaint
  // it. (This comment used to cite "two run files on this machine reading
  // `status: "complete"`" as live data needing the fold. Under the loader's own
  // pattern — `run-<8 hex>.json`, `state.ts` `listRuns` — no such file exists;
  // the three that say `complete` are `run-<id>-p<N>-outcome.json`
  // declarations, where `complete` is a legal `OUTCOME_STATUSES` member, and
  // `listRuns` never loads them. The fold stands on the paint argument alone: a
  // justification citing live data has to cite files the loader accepts —
  // LFC-5, LFC-10.)
  //
  // A `paused` run asleep on a clock nobody paused is a WAIT (#148): the word
  // stays `paused` because the resume machinery keys on it, and the lifecycle
  // says what the run is — which is what every surface paints from.
  const held = status === 'paused' ? pausedWaitOf(run) : null;
  const state = held ? 'waiting' : (RUN_STATE_FOLD[status] ?? 'waiting');
  /** @type {RunLifecycle} */
  const lifecycle = { state };

  const pending = RUN_PENDING_FOLD[status];
  if (pending) lifecycle.pending = pending;
  if (status === 'frozen' || Boolean(run?.freeze)) lifecycle.frozen = true;

  if (state === 'waiting') {
    const kind = held ? held.kind : waitKindOf(run, status);
    lifecycle.wait = { kind, until: run?.waitUntil ?? null };
    // What a writer said the wait is ON survives a re-read of the same wait.
    if (stored?.wait?.on && stored.wait.kind === kind) lifecycle.wait.on = stored.wait.on;
  }
  return lifecycle;
}

/**
 * Which wait a run's `status` word stands for — the kind axis of the fold.
 *
 * @param {{ waitReason?: string|null, phases?: Record<string, {status?: string}> }|null|undefined} run
 * @param {string} status
 * @returns {string}
 */
function waitKindOf(run, status) {
  // `queued` is the one wait whose reason the status itself carries: the run
  // is in `admit()`, behind somebody else's scope. Every other wait reads the
  // recorded reason, and falls back the way `waitReasonOf` does — which is
  // the only answer a run written before that field can be given.
  const recorded = run?.waitReason;
  return status === 'queued'
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
        recorded === 'schedule' ||
        recorded === 'person' ||
        recorded === 'connectivity' ||
        recorded === 'engine-busy'
      ? recorded
      : Object.values(run?.phases ?? {}).some((record) => record?.status === 'waiting')
        ? 'external'
        : 'usage-limit';
}

/**
 * The wait a `paused` run is really asleep on — or null when somebody paused
 * it (control-tower phase 88, #148).
 *
 * Reconcile keeps a run whose console died mid-wait as `paused` WITH its clock
 * (`waitUntil`), and the unsupervised-outcome path mints one that way: the word
 * is what the resume machinery keys on (`resumeLimitPaused`, the converge
 * relaunch, the owed-clock inventory), while nobody paused it — the service
 * re-arms the clock and resumes it by itself. Painted `paused`, two such runs
 * read exactly like an operator's "Pause after this phase", and the operator
 * had to ask why both plans had stopped.
 *
 * The rule is `waitHoldWhy`'s (`server/converge.ts`) turned around, because the
 * two must never disagree about one run — `test/waiting-status.test.ts` holds
 * them together: an operator's stop (and a run written before `stoppedBy`,
 * which that reader counts as one), a resolved run, and a usage window under
 * `onLimit: pause` are pauses; every other clocked `paused` run is a wait.
 *
 * @param {{ status?: string, waitUntil?: string|null, waitReason?: string|null,
 *           stoppedBy?: string|null, resolved?: unknown, onLimit?: string|null,
 *           phases?: Record<string, {status?: string}> }|null|undefined} run
 * @returns {{ kind: string, until: string }|null}
 */
export function pausedWaitOf(run) {
  if (!run || run.status !== 'paused') return null;
  const until = run.waitUntil;
  if (typeof until !== 'string' || !Number.isFinite(Date.parse(until))) return null;
  // `stoppedBy` is written by every console stop; its absence is a run from
  // before the field, which `stoppedByOperator` reads as the operator's.
  if (run.stoppedBy !== 'system' || run.resolved) return null;
  const kind = waitKindOf(run, 'paused');
  if (kind === 'usage-limit' && (run.onLimit ?? 'wait') === 'pause') return null;
  return { kind, until };
}

/**
 * What a run's wait is ON, in words an operator recognises (control-tower
 * phase 88, #148) — or null when the run itself does not say.
 *
 * `external`: the soonest waiting phase and what it watches — its first
 * declared ref, else its park's reason — and, when the console parked it
 * (`declared.by: 'watchdog'`), that it is waiting on its own job; so a card
 * reads "phase 28 · gh:acme/web#run/…" rather than "external work".
 * `usage-limit`: whose window. Every other kind is named by its writer (a
 * person's card) or by its phrase.
 *
 * @param {{ accountId?: string|null, phases?: Record<string, { phase?: number|string, status?: string,
 *           parkedUntil?: string, watch?: string[], parkReason?: string,
 *           declared?: { by?: string }|null }|undefined> }|null|undefined} run
 * @param {string} kind
 * @returns {string|null}
 */
export function waitOnOf(run, kind) {
  if (kind === 'usage-limit') return run?.accountId ? `${run.accountId}'s usage window` : null;
  if (kind !== 'external') return null;
  const waiting = Object.values(run?.phases ?? {}).filter((record) => record?.status === 'waiting');
  if (!waiting.length) return null;
  const clock = (/** @type {{ parkedUntil?: string }|undefined} */ record) =>
    Date.parse(record?.parkedUntil ?? '') || Infinity;
  waiting.sort((a, b) => clock(a) - clock(b) || Number(a?.phase) - Number(b?.phase));
  const first = /** @type {NonNullable<(typeof waiting)[number]>} */ (waiting[0]);
  const ref = Array.isArray(first.watch) ? first.watch.find((w) => typeof w === 'string' && w) : undefined;
  const what =
    first.declared?.by === 'watchdog'
      ? `its own job${ref ? ` (${ref})` : ''}`
      : (ref ?? first.parkReason ?? null);
  const more = waiting.length > 1 ? ` (+${waiting.length - 1} more)` : '';
  return `phase ${first.phase}${what ? ` · ${what}` : ''}${more}`;
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

/* ------------------------------------------------------------------ *
 * Undriven — one named state (control-tower phase 79, #114)
 * ------------------------------------------------------------------ */

/**
 * The record statuses an `undriven` stamp can stand on: the ones nothing drives
 * by being them. Everything in flight has a lane, a `waiting` record a clock, a
 * `parked` or `gated` one a person's card, and a `done` or `skipped` one no
 * work left.
 */
export const UNDRIVEN_STATUSES = Object.freeze(
  /** @type {const} */ (['pending', 'queued', 'failed', 'interrupted']),
);

/**
 * @typedef {object} UndrivenPhase
 * @property {number} phase
 * @property {string} since    When the episode began (ISO) — the inbox row's clock.
 * @property {string} board    The board's word: `in-progress` or `stuck`.
 * @property {string|null} situation  The last situation it was classified in.
 * @property {string} why      Why nothing drives it.
 * @property {{ next: string|null, remaining: string[], situation: string, reason: string, at: string }} [deferred]
 */

/**
 * A live run's undriven phases, worst-kept first by phase number — the ONE
 * reader of `PhaseRecord.undriven`, for `/api/runs`, the Runs page and the
 * inbox. The drive tick writes the stamp (`Runner.noteUndriven`); this only
 * reads it, and only for a run a loop is behind: a stopped run drives nothing,
 * and what its phases are waiting on is its halt's story, not this state.
 *
 * @param {{ status?: string, lifecycle?: unknown, waitReason?: string|null,
 *           phases?: Readonly<Record<string, { phase?: number, status?: string, undriven?: any }|undefined>> }|null|undefined} run
 * @returns {UndrivenPhase[]}
 */
export function undrivenPhases(run) {
  if (!run || !isRunLive(/** @type {any} */ (run))) return [];
  /** @type {UndrivenPhase[]} */
  const out = [];
  for (const record of Object.values(run.phases ?? {})) {
    const stamp = record?.undriven;
    if (!stamp || typeof stamp.since !== 'string') continue;
    if (!(/** @type {readonly string[]} */ (UNDRIVEN_STATUSES).includes(record.status ?? ''))) continue;
    out.push({
      phase: Number(record.phase),
      since: stamp.since,
      board: String(stamp.board ?? ''),
      situation: stamp.situation ?? null,
      why: String(stamp.why ?? ''),
      ...(stamp.deferred ? { deferred: stamp.deferred } : {}),
    });
  }
  return out.sort((a, b) => a.phase - b.phase);
}

/**
 * @typedef {{ phase: number, since: string, rung: string, brief: string|null, by: string|null,
 *             serialBehind?: number }} HintedPhase
 */

/**
 * A live run's HINTED-NOT-QUEUED phases, oldest hint first (control-tower phase
 * 86, #128 #114 #135) — the ONE reader, for `/api/queue` and the Runs page. A
 * phase a wrap-up, a Retry, the ladder or a person re-boarded carries a
 * `boardingHint` from that moment; until a lane takes it, it holds no
 * scheduler entry (it is serial behind its own run's lane, or the run's lanes
 * are full), and nothing on the queue page used to say it existed at all. A
 * `queued` record is on the scheduler's list already, and a stopped run drives
 * nothing, so neither is listed.
 *
 * @param {{ status?: string, lifecycle?: unknown, waitReason?: string|null,
 *           phases?: Readonly<Record<string, { phase?: number, status?: string, serialBehind?: number|null,
 *             boardingHint?: { at?: string, rung?: string, brief?: string, by?: string } }|undefined>> }|null|undefined} run
 * @returns {HintedPhase[]}
 */
export function hintedPhases(run) {
  if (!run || !isRunLive(/** @type {any} */ (run))) return [];
  /** @type {HintedPhase[]} */
  const out = [];
  for (const record of Object.values(run.phases ?? {})) {
    const hint = record?.boardingHint;
    if (!hint || typeof hint.at !== 'string' || record.status !== 'pending') continue;
    out.push({
      phase: Number(record.phase),
      since: hint.at,
      rung: String(hint.rung ?? ''),
      brief: hint.brief ?? null,
      by: hint.by ?? null,
      ...(record.serialBehind != null ? { serialBehind: record.serialBehind } : {}),
    });
  }
  return out.sort((a, b) => Date.parse(a.since) - Date.parse(b.since) || a.phase - b.phase);
}
