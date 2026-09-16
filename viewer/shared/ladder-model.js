/**
 * The ladder's vocabulary: every vehicle a rung may name, the rung table per
 * situation (climb order, labels, blurbs, whether a rung spends), and the
 * caps' shipped defaults — ONE table, read by three layers by import identity:
 *
 *   - `server/runner/ladder.ts` climbs it (`nextRung`, the caps, the errand
 *     word-book — the logic stays there; this file is the data);
 *   - `client/src/lib/ladder.ts` re-exports it so Ways forward can say what was
 *     tried and what the machine tries next in the SAME words the journal and
 *     the server's errand carry;
 *   - the node tests hold the two identical (`test/ladder.test.ts`).
 *
 * Dependency-free ESM (`.js` + JSDoc), the `situation-model.js` precedent:
 * the client imports it relatively (node resolves no Vite alias in the test
 * suite), the server as `../../shared/ladder-model.js`.
 */

import { parseSituationKey } from './situation-model.js';

/* ------------------------------------------------------------------ *
 * Vehicles
 * ------------------------------------------------------------------ */

/**
 * Every vehicle a rung may name. The vocabulary is the design's, not the
 * console's current ability: a vehicle the console cannot drive yet is simply
 * never `available`, and the ladder skips it — so the tables below can state
 * the full ladder while the vehicles land one by one.
 */
export const RUNG_VEHICLES = Object.freeze(
  /** @type {const} */ ([
    /** Reset the record and board the phase fresh from the engine's boot prompt (`retryPhase`). */
    'reboard-fresh',
    /** `claude -p --resume` the phase's own session through the runner, with an instruction. */
    'resume-own-session',
    /** Board fresh with a runner-appended resume brief (SKILL.md Mode 2 "RESUMING" + evidence). */
    'reboard-resume-brief',
    /** One bounded session explicitly allowed to do the work that unblocks a declared blocker. */
    'unblock-session',
    /** The phase's own session, asked only to verify, commit and write the handoff. */
    'closeout-own-session',
    /** A fresh briefed agent writing the handoff the phase never wrote. */
    'closeout-agent',
    /** A fresh briefed agent at a stronger model/effort fixing the failing verification. */
    'fix-agent',
    /** `scripts/repair-artefacts.sh` — deterministic plan/handoff/INDEX/lock-debris repair. */
    'plan-repair-script',
    /** The plan-repair agent (exists). */
    'plan-repair-agent',
    /** Continue under another registered account with headroom (`trySwitchAccount`). */
    'switch-account',
    /** Continue on the next model in the fallback chain. */
    'switch-model',
    /** Sleep until the usage window (or the first model's window) reopens. */
    'wait-window',
    /** Raise the phase/run budget once, within the policy cap. */
    'raise-budget',
    /** Take over an expired foreign claim (`stale-claim-takeover` agent class). */
    'stale-claim-takeover',
    /** Re-board and let the scheduler queue behind the lock holder. */
    'queue',
    /** Park and poll machine-checkable watch refs (`gh run`, PR state). */
    'poll-park',
    /** Park for a bounded time, then re-evaluate. */
    'timed-park',
    /**
     * The watch clock — `watch-scheduler.ts` — polling the declared refs on its
     * own cadence and resuming the phase's own session the moment one lands.
     * Named as the mechanism it is (zero-touch-console phase 10, RCV-10): the
     * row used to read `recheck-watch`, a rung no driver owned, while the work
     * it promised was done out of band — 0 climbs against 222
     * `phase.watch-checked`. A table must not print a rung nothing owns.
     */
    'watch-clock',
    /** Wait a bounded time for an MCP server to heal. */
    'wait-heal',
    /** Set the run's MCP policy to continue and re-board the parked phases (exists). */
    'mcp-continue',
    /**
     * Offer the deny rule that refused a tool call as an approval card; an
     * approval strikes that rule for this plan and resumes the phase's own
     * session with the command to re-run. Nothing spends until a person
     * answers (zero-touch-console phase 9, TRS-10/LFC-3).
     */
    'widen-rule',
  ]),
);

/** @typedef {(typeof RUNG_VEHICLES)[number]} RungVehicle */

/**
 * @typedef {Object} Rung
 * @property {RungVehicle} vehicle
 * @property {Record<string, string|number|boolean>} [params]  What distinguishes two rungs on the same vehicle (an escalation step, a mode).
 * @property {string} label   What the rung is called on a card and in the journal.
 * @property {string} blurb   The promise: what starts, on what, roughly what it costs.
 * @property {boolean} spends Whether climbing it spends a session (counts against the USD caps' intent).
 */

/**
 * @param {RungVehicle} vehicle
 * @param {string} label
 * @param {string} blurb
 * @param {boolean} spends
 * @param {Rung['params']} [params]
 * @returns {Rung}
 */
const R = (vehicle, label, blurb, spends, params) =>
  Object.freeze({ vehicle, label, blurb, spends, ...(params ? { params: Object.freeze(params) } : {}) });

/* ------------------------------------------------------------------ *
 * Who can drive a vehicle
 * ------------------------------------------------------------------ */

/**
 * Who drives a vehicle, in one word — the ladder's drivability column
 * (zero-touch-console phase 10, LFC-2/RCV-10). The audit found half the
 * vehicles never climbed and six whole tables undrivable, while every surface
 * printed them as the ladder; a row now states its driver, so no surface
 * promises a rung nothing owns:
 *
 *   - `console` — the console itself: the runner's own boarding or resume,
 *     a park on a clock it arms, an account it picks, a card it offers.
 *     Costs nothing beyond the phase's own session (`--allow-run`).
 *   - `writes`  — the console, but only started with `--allow-writes`: the
 *     deterministic repair edits work-state.
 *   - `agent`   — a fresh briefed session or pty agent (`--allow-run`, else
 *     `--allow-agent`): the "new agent" rungs and the stale-claim takeover.
 *   - `never`   — operator-only: no console drives it; the table row is a
 *     person's instruction, and `VEHICLE_DRIVERS[vehicle].how` says why.
 */
export const RUNG_DRIVERS = Object.freeze(/** @type {const} */ (['console', 'writes', 'agent', 'never']));

/** @typedef {(typeof RUNG_DRIVERS)[number]} RungDriver */

/** The driver words as a card prints them. */
export const RUNG_DRIVER_LABELS = Object.freeze({
  console: 'the console drives it',
  writes: 'the console drives it under --allow-writes',
  agent: 'a fresh session or agent drives it (--allow-run, else --allow-agent)',
  never: 'operator-only — no console drives it',
});

/**
 * Every vehicle's driver and HOW it is driven — one row per `RUNG_VEHICLES`
 * member, held total by `test/ladder.test.ts`. `how` is the mechanism in a
 * sentence: what the console actually does when the rung is climbed, or, for
 * `never`, why only a person can.
 * @type {Readonly<Record<RungVehicle, Readonly<{ by: RungDriver, how: string }>>>}
 */
export const VEHICLE_DRIVERS = Object.freeze({
  'reboard-fresh': Object.freeze({
    by: 'console',
    how: 'the runner resets the record and boards the phase from its boot prompt (`retryPhase`)',
  }),
  'resume-own-session': Object.freeze({
    by: 'console',
    how: "the runner resumes the phase's own session with an instruction (`claude -p --resume`)",
  }),
  'reboard-resume-brief': Object.freeze({
    by: 'console',
    how: 'the runner boards fresh with the resume brief appended to the boot prompt',
  }),
  'unblock-session': Object.freeze({
    by: 'console',
    how: 'the runner resumes (or boards fresh with) an unblock brief — one bounded session, `unblockAttempts` permitting',
  }),
  'closeout-own-session': Object.freeze({
    by: 'console',
    how: "the runner resumes the phase's own session to verify, commit and write the handoff",
  }),
  'closeout-agent': Object.freeze({
    by: 'agent',
    how: 'a fresh briefed repair session (or pty agent) writes the handoff the phase never wrote',
  }),
  'fix-agent': Object.freeze({
    by: 'agent',
    how: 'a fresh briefed repair session (or pty agent) at a stronger model fixes what is red; the QA review rides the QA loop',
  }),
  'plan-repair-script': Object.freeze({
    by: 'writes',
    how: 'the console runs scripts/repair-artefacts.sh --apply, which edits INDEX.md, handoff frontmatter and lock files',
  }),
  'plan-repair-agent': Object.freeze({
    by: 'agent',
    how: 'a fresh briefed repair session (or pty agent) edits the plan until validate.sh passes',
  }),
  'switch-account': Object.freeze({
    by: 'console',
    how: 'the runner continues under the registered account with the most headroom (`pickAccount`); on a stopped run the healer moves the run and relaunches it',
  }),
  'switch-model': Object.freeze({
    by: 'console',
    how: 'the runner fails over to the next model in the fallback chain at the wall, in the attempt loop (`phase.model-switch`)',
  }),
  'wait-window': Object.freeze({
    by: 'console',
    how: "the runner parks the phase on the window's reset at the wall; on a stopped run the healer parks the run on the account's recorded reset and re-arms the clock",
  }),
  'raise-budget': Object.freeze({
    by: 'console',
    how: 'the run budget is raised once by `budgetAutoRaisePct` within the per-run ladder cap — inline at the wall, or by the healer on a halted run',
  }),
  'stale-claim-takeover': Object.freeze({
    by: 'agent',
    how: 'a fresh briefed repair session (or pty agent) takes the expired claim, `staleClaimTakeover` permitting',
  }),
  queue: Object.freeze({
    by: 'console',
    how: 'the runner re-boards the phase and the scheduler queues it behind the lock holder',
  }),
  'poll-park': Object.freeze({
    by: 'console',
    how: 'the healer parks the phase on its machine-checkable refs; the watch clock polls them and resumes the own session when they land',
  }),
  'timed-park': Object.freeze({
    by: 'console',
    how: "the healer parks the phase on a bounded clock and re-arms the resume; at the clock the phase's own session re-checks its blocker",
  }),
  'watch-clock': Object.freeze({
    by: 'console',
    how: 'the watch scheduler polls the declared refs on its own cadence and resumes the own session on a landing; a re-check runs one pass now',
  }),
  'wait-heal': Object.freeze({
    by: 'console',
    how: 'the console holds the `require` park on its clock (`mcpRequireTimeoutMs`) and continues without the server when it runs out',
  }),
  'mcp-continue': Object.freeze({
    by: 'console',
    how: "the run's MCP policy is set to continue and the parked phases re-board without the server",
  }),
  'widen-rule': Object.freeze({
    by: 'console',
    how: 'the console offers the deny rule on a standing approval card; Allow strikes it for the plan and resumes the own session',
  }),
});

/**
 * Who drives `vehicle` — `never` for a vehicle the table does not know, so a
 * rung written by a newer console reads as nobody's rather than as free.
 * @param {string} vehicle
 * @returns {RungDriver}
 */
export function drivableBy(vehicle) {
  return VEHICLE_DRIVERS[/** @type {RungVehicle} */ (vehicle)]?.by ?? 'never';
}

/**
 * The tables no console drives — every rung `never` — with the reason, for the
 * ladder card and the errand (RCV-10). Empty today: every table has a driver
 * since phase 10, and the registry exists so that a future operator-only row
 * has one place to say why. Held against `VEHICLE_DRIVERS` by
 * `test/ladder.test.ts`.
 * @returns {Record<string, string>} situation key → why only a person can
 */
export function operatorOnlyTables() {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, rungs] of Object.entries(RUNGS_BY_SITUATION)) {
    if (!rungs.length || !rungs.every((rung) => drivableBy(rung.vehicle) === 'never')) continue;
    out[key] = rungs.map((rung) => `${rung.label}: ${VEHICLE_DRIVERS[rung.vehicle].how}`).join(' · ');
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

/**
 * The ladder, per situation (or `situation:sub`). Order is the climb order.
 * An empty list means the situation has no automatic rung: the errand is
 * written at once (a person's), or nothing is done (a wait's).
 * @type {Readonly<Record<string, readonly Rung[]>>}
 */
export const RUNGS_BY_SITUATION = Object.freeze({
  superseded: Object.freeze([]),
  // A recorded failure against work believed done. The session that built it
  // still has the context to fix what the report named — and the report is
  // specific, which is exactly the input a resume needs. A fresh agent takes
  // over when that session is gone.
  'qa-failed': Object.freeze([
    R(
      'resume-own-session',
      'Fix what QA found, then re-record',
      "Resumes the phase's own session with the QA report: fix what it named, re-run the verification, " +
        'dispatch a fresh-context QA subagent again and record the new verdict. Costs a session.',
      true,
      { mode: 'qa-fix' },
    ),
    R(
      'fix-agent',
      'Fix what QA found with a new agent',
      'Briefs a fresh agent with the QA report and the phase, at a stronger model, to clear the findings ' +
        'and re-record the verdict. Costs a session.',
      true,
    ),
  ]),
  // No verdict at all — the phase finished and nobody reviewed it. This is the
  // chore nobody scheduled, and it holds every dependent exactly as hard as a
  // failure does.
  'qa-pending': Object.freeze([
    R(
      'resume-own-session',
      'Run QA and record the verdict',
      "Resumes the phase's own session and asks it to dispatch the fresh-context QA subagent the plan's " +
        'QA gate requires, then record pass, fail or waived with qa-record.sh. Costs a session.',
      true,
      { mode: 'qa-verdict' },
    ),
    // The phase's own session is gone — its transcript is not under the
    // account paying, or the CLI has no conversation under that id — so a
    // session boarded fresh from the boot prompt reviews the phase and
    // records the verdict (the QA loop's `qa-rerun`, strategy `fresh`).
    // Without this second rung the table ended in an errand telling the
    // operator to run QA from the phase page: a review the console can board.
    R(
      'fix-agent',
      'Review with a fresh session',
      "Boards a fresh session from the phase's boot prompt to dispatch the fresh-context QA subagent " +
        'and record pass, fail or waived with qa-record.sh — for a phase whose own session cannot be ' +
        'resumed. Costs a session.',
      true,
      { mode: 'qa-review' },
    ),
  ]),
  'foreign-live': Object.freeze([]),
  'foreign-stale': Object.freeze([
    R(
      'stale-claim-takeover',
      'Take over the stale claim',
      'Takes the expired claim and continues the unfinished work — then the work-in-progress ladder applies. Costs a session.',
      true,
    ),
  ]),
  // A `wait` actor's table: the clock owns it, and the one row NAMES the clock
  // rather than promising a rung (RCV-10). The healer never climbs a wait —
  // `nextRung` is not asked for one — so the row is what a card says about
  // who is working, in the mechanism's own words.
  'waiting-external': Object.freeze([
    R(
      'watch-clock',
      'Watched by the clock',
      "The watch clock polls the declared refs on its own cadence and resumes the phase's own session the moment " +
        'one lands — a re-check on demand runs one pass now. Not a session; nothing spends. Free.',
      false,
    ),
  ]),
  'gated-manual': Object.freeze([]),
  'plan-broken': Object.freeze([
    R(
      'plan-repair-script',
      'Deterministic repair',
      'Runs scripts/repair-artefacts.sh: depends_on from the graph, missing INDEX rows, dead-run lock debris. No session. Free.',
      false,
    ),
    R(
      'plan-repair-agent',
      'Repair the plan with a new agent',
      'Briefs a fresh agent with the lint/health findings and lets it edit the plan, handoffs or INDEX until validate.sh passes. Costs a session.',
      true,
    ),
  ]),
  'mcp-unavailable': Object.freeze([
    R(
      'wait-heal',
      'Wait for the server',
      'Holds the phase a bounded time for the unreachable MCP server to come back. Free.',
      false,
    ),
    R(
      'mcp-continue',
      'Continue without it',
      "Sets this run's MCP policy to continue and re-boards the parked phases without the server; the session is told and records an errand. Costs the phase's own session.",
      true,
    ),
  ]),
  'resource-wall:usage': Object.freeze([
    R(
      'switch-account',
      'Switch to an account with headroom',
      'Continues at once under the registered account whose usage window has the most room — same session when its transcript came along. Free to switch; the phase still costs.',
      false,
    ),
    R(
      'switch-model',
      'Switch model',
      'Continues on the next model in the fallback chain. Free to switch; the phase still costs.',
      false,
    ),
    R(
      'wait-window',
      'Wait for the window',
      'Sleeps until the usage window reopens, then continues. Free.',
      false,
    ),
  ]),
  'resource-wall:auth': Object.freeze([
    R(
      'switch-account',
      'Switch to a signed-in account',
      'Continues under a registered account that is signed in. Free to switch; the phase still costs.',
      false,
    ),
  ]),
  'resource-wall:budget': Object.freeze([
    R(
      'raise-budget',
      'Raise the budget once',
      'Raises the spent budget once, within the policy cap, and continues. The raise is the cost.',
      true,
    ),
  ]),
  'resource-wall:model': Object.freeze([
    R(
      'wait-window',
      "Wait for the first model's window",
      "Sleeps until the first model's own limit resets, then continues on it. Free.",
      false,
    ),
  ]),
  'blocked-declared:lock': Object.freeze([
    R(
      'queue',
      'Queue behind the lock',
      'Re-boards the phase and lets the scheduler wait for the holder — woken by the docs watcher, the lease expiry and the idle poll. Free until it boards.',
      false,
    ),
  ]),
  'blocked-declared:credential': Object.freeze([]),
  // A tool the run's permission policy refused. ONE rung, and a free one
  // (zero-touch-console phase 9, TRS-10): the console puts the deny rule and
  // the command it stopped on an approval card. Approving strikes that rule
  // for this plan — the explicit confirm a deny-strike takes — and resumes the
  // phase's own session; denying leaves the errand. It used to be empty, on
  // the reasoning that the wall is the operator's, and it still is: the rung
  // spends nothing and asks THEM. What it stops is the shape measured on
  // console-parallel-repaint P12 and 267 times since — a permission wall read
  // as `:unknown`, answered with an unblock session into the same wall.
  'blocked-declared:permission': Object.freeze([
    R(
      'widen-rule',
      'Offer the rule to widen',
      'Puts the denied rule and the command it stopped on an approval card. Approving strikes that one rule for ' +
        "this plan and resumes the phase's own session with the command to re-run; denying leaves the errand. " +
        'Nothing spends until a person answers. Free.',
      false,
    ),
  ]),
  'blocked-declared:gate': Object.freeze([]),
  'blocked-declared:external': Object.freeze([
    R(
      'poll-park',
      'Park and poll the refs',
      'Parks the phase and polls its machine-checkable watch refs (a gh run, a PR); resumes the own session when they land. Free until then.',
      false,
    ),
    R('timed-park', 'Park for a while', 'Parks the phase for a bounded time and re-evaluates. Free.', false),
  ]),
  'blocked-declared:unknown': Object.freeze([
    R(
      'unblock-session',
      'One bounded unblock session',
      "Resumes the phase's own session (or boards fresh with an unblock brief) carrying the Outstanding text, explicitly allowed to do the work that unblocks it. One try; costs a session.",
      true,
    ),
  ]),
  'verify-red': Object.freeze([
    R(
      'resume-own-session',
      'Resume with the failure',
      "Resumes the phase's own session with the failing commands and their output, asking it to fix the cause and finish. Costs a session.",
      true,
      { mode: 'fix-verification' },
    ),
    R(
      'fix-agent',
      'Fix with a stronger new agent',
      'Briefs a fresh agent at a stronger model/effort with the evidence and lets it fix and finish the phase. Costs a full session.',
      true,
      { escalate: 'model' },
    ),
  ]),
  'done-unrecorded': Object.freeze([
    R(
      'closeout-own-session',
      'Finish in its own session',
      "Resumes the phase's own session and asks it to verify, commit and write the handoff — nothing else. Costs little; its context is intact.",
      true,
    ),
    R(
      'closeout-agent',
      'Close out with a new agent',
      'Briefs a fresh agent to check the phase against the repository and write the handoff it never wrote. Costs a full session.',
      true,
    ),
  ]),
  'work-in-progress': Object.freeze([
    R(
      'resume-own-session',
      'Continue in its own session',
      'Resumes the phase\'s own session: "you are RESUMING — read git status and git diff first, then carry the phase to its exit criteria". Costs a session.',
      true,
      { mode: 'continue' },
    ),
    R(
      'reboard-resume-brief',
      'Board fresh with a resume brief',
      "Boards a fresh session from the engine's boot prompt plus a runner-appended resume brief (the evidence, SKILL.md Mode 2 RESUMING). Costs a full session.",
      true,
    ),
    R(
      'reboard-resume-brief',
      'Board fresh, stronger',
      'The same resume brief at the next model/effort step. Costs a full session.',
      true,
      { escalate: 'model' },
    ),
  ]),
  'never-started': Object.freeze([
    R(
      'reboard-fresh',
      'Re-board fresh',
      'Resets the record to pending and boards the phase from its boot prompt under normal admission — no closeout, no agent, no person. Costs the phase itself.',
      true,
    ),
  ]),
  /*
   * The three zero-turn exits that name their own cause (D26). Each one is
   * here because `reboard-fresh` is the WRONG act for it, and the ladder was
   * doing it anyway.
   */
  'never-started:sleep': Object.freeze([
    R(
      'resume-own-session',
      'Resume the same session',
      'The machine slept mid-response, so nothing is wrong with the phase and the transcript is intact. Resumes THAT session rather than boarding a fresh one, which would throw the context away. Costs a session.',
      true,
      { mode: 'continue' },
    ),
    R(
      'reboard-fresh',
      'Re-board fresh',
      'The resume did not take (the session is gone, or its transcript is unreadable). Boards the phase from its boot prompt as before. Costs the phase itself.',
      true,
    ),
  ]),
  // Empty on purpose, twice: an errand at once, like `blocked-declared:gate`.
  // A refusal is the same answer to the same prompt however many times it is
  // asked, and a skill that will not load on this machine will not load on the
  // next attempt either. Both need a person, and spending on either is the
  // defect this sub-kind exists to stop.
  'never-started:refusal': Object.freeze([]),
  'never-started:skill-missing': Object.freeze([]),
  unknown: Object.freeze([]),
});

/**
 * The rung list for a situation, by `id:sub` first and then by `id`.
 * @param {string} situationKeyOrId
 * @returns {readonly Rung[]}
 */
export function rungsFor(situationKeyOrId) {
  if (situationKeyOrId in RUNGS_BY_SITUATION) return RUNGS_BY_SITUATION[situationKeyOrId];
  const { id } = parseSituationKey(situationKeyOrId);
  return RUNGS_BY_SITUATION[id] ?? [];
}

/**
 * The identity a "same rung" is judged by: situation key + vehicle + params.
 * @param {string} situation
 * @param {{ vehicle: string, params?: Rung['params'] }} rung
 */
export function rungKey(situation, rung) {
  const params = rung.params
    ? Object.entries(rung.params)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
    : '';
  return `${situation}|${rung.vehicle}${params ? `|${params}` : ''}`;
}

/**
 * @typedef {Object} RungRecordLike
 * @property {string} situation
 * @property {string} rung
 * @property {Rung['params']} [params]
 * @property {string} [outcome]
 */

/**
 * The rungs of a situation's table not yet climbed on a phase, in climb order
 * — the first is what the autopilot tries next, caps and availability
 * permitting (those are the server's to judge; `server/runner/ladder.ts`
 * `nextRung`). A display helper: a card says "next: …" from this.
 * @param {string} situationKeyOrId
 * @param {readonly RungRecordLike[]} history  Every rung already climbed on the phase, any situation.
 * @returns {readonly Rung[]}
 */
export function untriedRungs(situationKeyOrId, history) {
  const key =
    situationKeyOrId in RUNGS_BY_SITUATION ? situationKeyOrId : parseSituationKey(situationKeyOrId).id;
  // An `interrupted` rung was cut off before it effectively ran — it does not
  // consume the same-rung-once rule, so it is still "untried" here — ONCE.
  // `triedRungKeys` is the one reading of that rule; the server's `nextRung`
  // and the runner's own exhaustion reason read the same helper, so a card's
  // "next: …" is never a rung the autopilot then refuses.
  const tried = triedRungKeys(history);
  return rungsFor(key).filter((rung) => !tried.has(rungKey(key, rung)));
}

/**
 * How many times in a row one rung may be cut short before it counts as tried.
 *
 * "Cut short — it can run again" was unbounded, and the measured cost was a
 * `resume-own-session` rung climbed nineteen times in forty-seven minutes
 * (run 31285928, phase 3): every `--resume` failed in three seconds because
 * the transcript was under another account's config dir, every settle read
 * `interrupted` (zero turns), and `interrupted` was exempt from BOTH the
 * same-rung-once rule and the numeric caps. One interruption is the console
 * restarting under a rung, which is what the exemption was written for; two
 * in a row on the same rung is a rung that cannot run, and a rung that cannot
 * run has been tried.
 */
export const MAX_RUNG_INTERRUPTIONS = 2;

/**
 * The records that COUNT — toward the same-rung-once rule and the numeric caps.
 *
 * Every record that ran (any outcome but `interrupted`) counts. An interrupted
 * record counts only once its rung has been cut short `MAX_RUNG_INTERRUPTIONS`
 * times in a row (records of OTHER rungs in between do not break the run, a
 * record of this rung that ran does): from that point every record of the
 * streak counts, so the numeric caps see the spend that the loop really made.
 * Monotonic — adding a record never lowers the count.
 *
 * @param {readonly RungRecordLike[]} history
 * @returns {RungRecordLike[]}
 */
export function countedRungs(history) {
  /** @type {Map<string, RungRecordLike[]>} */
  const streaks = new Map();
  /** @type {Set<RungRecordLike>} */
  const counted = new Set();
  for (const record of history) {
    const key = rungKey(record.situation, { vehicle: record.rung, params: record.params });
    if (record.outcome !== 'interrupted') {
      counted.add(record);
      streaks.delete(key);
      continue;
    }
    const streak = streaks.get(key) ?? [];
    streak.push(record);
    streaks.set(key, streak);
    if (streak.length >= MAX_RUNG_INTERRUPTIONS) for (const cut of streak) counted.add(cut);
  }
  return history.filter((record) => counted.has(record));
}

/**
 * The rung keys the same-rung-once rule holds as TRIED on this phase — the
 * keys of `countedRungs`. One helper for the three readers: `nextRung`, the
 * runner's exhaustion reason, and `untriedRungs` above.
 *
 * @param {readonly RungRecordLike[]} history
 * @returns {Set<string>}
 */
export function triedRungKeys(history) {
  return new Set(
    countedRungs(history).map((r) => rungKey(r.situation, { vehicle: r.rung, params: r.params })),
  );
}

/* ------------------------------------------------------------------ *
 * Words for a rung that has already been climbed
 * ------------------------------------------------------------------ */

/**
 * A readable name for a vehicle when no table row matches (a rung written by
 * a newer console, a vehicle the table lists in no situation): the id with
 * its dashes opened up.
 * @param {string} vehicle
 */
const humanised = (vehicle) => vehicle.replace(/-/g, ' ');

/**
 * The label a climbed rung is called by — the table row's own label when the
 * vehicle and params match one (in ANY situation's table, the situation the
 * record carries first), else the vehicle's name opened up.
 * @param {string} vehicle
 * @param {Rung['params']} [params]
 * @param {string} [situation]  The situation the rung was climbed for, when known.
 */
export function rungLabel(vehicle, params, situation) {
  const same = (/** @type {Rung} */ rung) =>
    rung.vehicle === vehicle && rungKey('x', { vehicle, params }) === rungKey('x', rung);
  const loose = (/** @type {Rung} */ rung) => rung.vehicle === vehicle;

  // The caller's own situation is resolved COMPLETELY first — exact params, then
  // the vehicle alone — before any other table is consulted.
  //
  // It used to run the exact pass across EVERY table before the loose one, which
  // let a paramless rung in an earlier situation steal the label from the
  // params-bearing rung of the situation actually being described. Latent until
  // two situations shared a vehicle: `verify-red`'s `fix-agent` carries
  // `{escalate:'model'}`, so a call passing no params skipped it, matched
  // `qa-failed`'s paramless `fix-agent` — earlier in the object — and the Pulse
  // read "Fix what QA found" about a red verification.
  if (situation) {
    const own = rungsFor(situation);
    const row = own.find(same) ?? own.find(loose);
    if (row) return row.label;
  }
  for (const table of Object.values(RUNGS_BY_SITUATION)) {
    const row = table.find(same);
    if (row) return row.label;
  }
  // A looser match — same vehicle, whatever the params — still beats the raw id.
  for (const table of Object.values(RUNGS_BY_SITUATION)) {
    const row = table.find(loose);
    if (row) return row.label;
  }
  return humanised(vehicle);
}

/**
 * How a rung ended, in a word a card can show beside its label.
 * @type {Readonly<Record<string, string>>}
 */
export const RUNG_OUTCOME_LABELS = Object.freeze({
  running: 'running',
  fixed: 'fixed it',
  'no-defect': 'found nothing wrong',
  superseded: 'overtaken by the board',
  failed: 'did not hold',
  interrupted: 'cut short — it can run again',
  'work-in-progress': 'still going — it asked to be resumed',
});

/* ------------------------------------------------------------------ *
 * Caps
 * ------------------------------------------------------------------ */

/**
 * The shipped caps — 3 rungs & $100 per phase · 10 & $400 per run · $600 per
 * day per console. Every one is a preference (`ladder*` keys, Settings ▸
 * Automation); these are what an unset preference means.
 */
export const DEFAULT_LADDER_CAPS = Object.freeze({
  perPhaseRungs: 3,
  perPhaseUsd: 100,
  perRunRungs: 10,
  perRunUsd: 400,
  perDayUsd: 600,
});

/**
 * Has today's LADDER spend reached the day cap?
 *
 * Here, in the ladder's own vocabulary, because the question is asked on both
 * sides and the two sides had different answers. `perDayUsd` gates the
 * REMEDIATION LADDER and nothing else — `nextRung` refuses a rung when the
 * ladder has spent it — but three client surfaces added the runs' settled
 * spend in before comparing, so a normal day that settled $640 with $4 of
 * ladder rendered "at the cap, the ladder will refuse the next rung", while
 * the runner would have climbed happily. An operator either raises a cap that
 * was never reached or stops believing the panel.
 *
 * `>=`, not `>`, and no cap at all when `capUsd` is null — the way `nextRung`
 * answers it. A cap of exactly zero is reached the instant it is set, which is
 * what setting it to zero means.
 *
 * @param {{ capUsd: number | null; ladderUsd: number }} today
 * @returns {boolean}
 */
export function overDayCap(today) {
  return today.capUsd !== null && today.ladderUsd >= today.capUsd;
}

/** The preference key behind each cap, for a Settings card and its docs. */
export const LADDER_CAP_PREFS = Object.freeze({
  perPhaseRungs: 'ladderPerPhaseRungs',
  perPhaseUsd: 'ladderPerPhaseUsd',
  perRunRungs: 'ladderPerRunRungs',
  perRunUsd: 'ladderPerRunUsd',
  perDayUsd: 'ladderPerDayUsd',
});
