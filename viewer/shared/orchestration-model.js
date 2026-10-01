/**
 * The words the operator steers the queue in, owned once.
 *
 * `worktree-model.js` owns how a run is CHECKED OUT; this file owns the
 * orthogonal question of what runs FIRST. Three knobs, and they are deliberately
 * three rather than one number:
 *
 *   RUN_PRIORITIES        which class an admission is scanned in  (a setting)
 *   ORCHESTRATION_VERBS   what an operator can do to the queue    (an action)
 *   the hold/chain holders   why an entry is not moving           (a reason)
 *
 * None of them reorders anything by itself. Priority is an INPUT to the same
 * deterministic first-fit scan the scheduler has always run; hold and the
 * `startAfter` chain are pseudo-holders that make an entry skip, in exactly the
 * vocabulary the queue page already renders a throttle or a boarding window in.
 * The scheduler never invents an order — that is the whole reason this is data
 * and not a heuristic, and it is why the aging/starvation promotion survives
 * priority unchanged: a class is a preference, and starvation is a bug.
 *
 * ⚠️ Data only, no imports — the client bundles this module and `node --test`
 * imports it directly, so it must stay free of anything either cannot resolve.
 * `test/vocab-owners.test.ts` registers every list here: a second spelling of
 * one anywhere under `shared/`, `server/` or `client/src/` fails that scan.
 */

/**
 * Which class an admission is scanned in.
 *
 * Ordered most-urgent first, and that order IS the scan order — `indexOf` on
 * this array is the rank, so adding a class between two others is one edit
 * here rather than a comparator somewhere else.
 *
 * **Absent means `normal`**, the same omission convention `isolation` and
 * `gitMode` use and for the same reason: every run file written before
 * priorities existed must keep meaning exactly what it meant, and the safe
 * answer must be the one you get by saying nothing.
 * @typedef {'high'|'normal'|'low'} RunPriority
 * @type {readonly RunPriority[]}
 */
export const RUN_PRIORITIES = Object.freeze(/** @type {const} */ (['high', 'normal', 'low']));

/** The class a run is in when it never said. Named, so no reader re-types it. */
export const DEFAULT_PRIORITY = /** @type {const} */ ('normal');

/** What the operator reads next to each choice. */
export const PRIORITY_LABELS = Object.freeze({
  high: 'High — scanned before everything that is not starving',
  normal: 'Normal — the shipped behaviour, first come first served',
  low: 'Low — yields to everything until it starves, then it does not',
});

/**
 * Coerce anything at all to a class, by EXACT literal.
 *
 * The `isolationMode()` rule, for the same reason: a typo in a run file, a
 * stale client or a hand-edited checkpoint must never be what moves a run to
 * the front of the queue. Only the three words, spelled exactly; everything
 * else — including `'High'`, `1`, `true` and `undefined` — reads as `normal`.
 * @param {unknown} value
 * @returns {RunPriority}
 */
export function runPriority(value) {
  return RUN_PRIORITIES.includes(/** @type {never} */ (value))
    ? /** @type {RunPriority} */ (value)
    : DEFAULT_PRIORITY;
}

/**
 * Where a class sits in the scan. Lower is scanned first.
 *
 * A free function rather than a comparator so both languages of this codebase
 * — the scheduler's sort and the client's queue rendering — rank identically
 * without either owning the rule.
 * @param {unknown} value
 * @returns {number}
 */
export function priorityRank(value) {
  return RUN_PRIORITIES.indexOf(runPriority(value));
}

/**
 * What an operator may do to the queue, by name.
 *
 * `hold`/`release` are RUN-level and durable — they live on the run's
 * checkpoint, so a held run is still held after a console restart. `bump` is
 * PHASE-level, and durable too since control-tower phase 99 (#135): it names
 * one phase, and its mark lives on that phase's record rather than on the
 * queue entry, so the entry a restart or a retry re-creates is born bumped.
 * `QUEUE_VERBS` below is these three reaching one phase, and four more.
 * @typedef {'hold'|'release'|'bump'} OrchestrationVerb
 * @type {readonly OrchestrationVerb[]}
 */
export const ORCHESTRATION_VERBS = Object.freeze(/** @type {const} */ (['hold', 'release', 'bump']));

/**
 * The pseudo-holder `slug` a held run's entries wait on.
 *
 * A held entry is not blocked by scope, so it must not be described as if it
 * were — the queue page reads `slug`/`owner` off a holder and would otherwise
 * say a plan was waiting for itself.
 */
export const HOLD_HOLDER = /** @type {const} */ ('hold');

/** The pseudo-holder `slug` an entry chained behind another plan waits on. */
export const CHAIN_HOLDER = /** @type {const} */ ('chain');

/**
 * The pseudo-holder `slug` every entry waits on while the whole fleet is frozen.
 *
 * A third holder rather than a wider reading of the first two, because it
 * answers a different question: `hold` is about ONE plan standing aside,
 * `chain` is about one plan following another, and this is about the console as
 * a whole having been switched off at the wall. The queue page has to be able
 * to say which of the three it is — an operator reading "held" against eleven
 * queued entries goes looking for eleven holds they never set.
 */
export const FLEET_HOLDER = /** @type {const} */ ('fleet freeze');

/**
 * The sentence every entry shows while the fleet is frozen. One function, for
 * the reason `chainReason` is one: the server writes it into the holder and the
 * client renders it, and two spellings of it would be a fourth vocabulary.
 * @param {string|undefined} by
 * @returns {string}
 */
export function fleetFreezeReason(by) {
  return by ? `the console is frozen by ${by}` : 'the console is frozen';
}

/**
 * The promise a run stopped by the console's own shutdown makes: nothing needs
 * doing, it continues once the console is back. The runner writes it into
 * `finishedReason`, and it is true only while no hold that outlives the process
 * binds the run — so a card never shows it except through `heldStopReason`
 * (control-tower phase 81, #93).
 */
export const SHUTDOWN_CONTINUES = 'it continues by itself once the console is back';

/**
 * A hold named the way a stopped run must name it: who, when, and the one act
 * that ends it. The console's own freeze (no `scope`) is thawed here; the fleet
 * supervisor's machine hold is released there; a restart's hold lifts by itself
 * with the process.
 *
 * Measured 2026-09-24 (#93): a freeze survived a launchd restart while every
 * run's card said it "continues by itself", a Resume answered 200 and changed
 * nothing, and an agent spent seven minutes finding the console-wide flag.
 * @param {{ at?: string | null, by?: string | null, scope?: string } | null | undefined} hold
 * @returns {string}
 */
export function fleetHoldSentence(hold) {
  const by = hold?.by ? ` by ${hold.by}` : '';
  const at = hold?.at ? ` at ${hold.at}` : '';
  if (hold?.scope === 'machine') return `held machine-wide${by}${at} — release the hold to continue`;
  if (hold?.scope === 'restart') return `held${by}${at} — that hold lifts by itself once the restart is done`;
  return `frozen console-wide${by}${at} — thaw to continue`;
}

/**
 * A stored stop reason, read through the hold that binds its run now. While a
 * hold binds, the `SHUTDOWN_CONTINUES` promise is replaced by the hold's own
 * sentence; a restart's hold lifts with the process, so under it the promise
 * stands — it is true. A reason that promised nothing keeps its own words.
 * @param {string} reason
 * @param {{ at?: string | null, by?: string | null, scope?: string } | null | undefined} hold
 * @returns {string}
 */
export function heldStopReason(reason, hold) {
  if (
    !hold ||
    hold.scope === 'restart' ||
    typeof reason !== 'string' ||
    !reason.includes(SHUTDOWN_CONTINUES)
  ) {
    return reason;
  }
  return reason.replace(SHUTDOWN_CONTINUES, fleetHoldSentence(hold));
}

/**
 * The sentence a chained entry shows. One function, because the server writes
 * it into the holder and the client renders it, and a chain that said two
 * different things on two surfaces would be a fourth vocabulary.
 * @param {string} slug
 * @returns {string}
 */
export function chainReason(slug) {
  return `waiting for ${slug} to settle`;
}

/**
 * The sentence a held run's entries show.
 * @param {string|undefined} by
 * @returns {string}
 */
export function holdReason(by) {
  return by ? `held by ${by}` : 'held';
}

/**
 * What an operator may do to ONE phase's place in the queue (control-tower
 * phase 99, #135 B and E) — `POST /api/queue/<verb>`, each naming an entry by
 * id or a phase by `{slug, phase}`.
 *
 * The run-level three above, reaching an entry, and four more. Every one is
 * DURABLE, unlike the bump `ORCHESTRATION_VERBS` describes: the mark lives on
 * the phase's own record (`PhaseRecord.queueControl`), so it survives the
 * entry being re-created — a retry, a wrap-up, a relaunch, a restart — until
 * the operator changes it or the phase boards.
 *
 *   - `bump`     to the front of its class, most recent first; spent when it boards;
 *   - `hold`     stays in the queue, never admitted, until `release`;
 *   - `release`  lifts a hold and a deferral;
 *   - `defer`    a hold that ends by itself at `until`;
 *   - `withdraw` out of the queue: the run boards its other phases instead;
 *   - `requeue`  back in, at its seniority — or at the front (`position: 'front'`);
 *   - `reorder`  a plan's phases as a list: the listed ones first, in that order.
 */
export const QUEUE_VERBS = Object.freeze(
  /** @type {const} */ ([...ORCHESTRATION_VERBS, 'defer', 'withdraw', 'requeue', 'reorder']),
);

/** @typedef {(typeof QUEUE_VERBS)[number]} QueueVerb */

/**
 * WHY an entry sits where it does (control-tower phase 99, #135 A.2) — the
 * scan's own keys, most significant first, which is the order the queue page
 * names them in: a dependency before its dependants, an aged-out reservation,
 * the class, an operator's bump, and then seniority — the oldest of queue
 * age, hint time and park expiry (phase 86), which is first come first served.
 * @type {readonly string[]}
 */
export const QUEUE_ORDER_KEYS = Object.freeze([
  'dependency',
  'reserved',
  'class',
  'pinned',
  'bumped',
  'policy',
  'share',
  'seniority',
]);

/** The pseudo-holder `slug` an entry an operator HELD waits on — its own, not its run's (`HOLD_HOLDER`). */
export const ENTRY_HOLD_HOLDER = /** @type {const} */ ('held entry');

/** The pseudo-holder `slug` a DEFERRED entry waits on until its clock passes. */
export const DEFER_HOLDER = /** @type {const} */ ('deferred');

/**
 * The words an operator's queue mark is shown in: who, and why when they said.
 * @param {{ by?: string, reason?: string }|null|undefined} mark
 * @returns {string}
 */
function markWords(mark) {
  const by = mark?.by ? ` by ${mark.by}` : '';
  return `${by}${mark?.reason ? ` — ${mark.reason}` : ''}`;
}

/**
 * The sentence an entry an operator held shows.
 * @param {{ by?: string, reason?: string }|null|undefined} mark
 * @returns {string}
 */
export function entryHoldReason(mark) {
  return `held in the queue${markWords(mark)}`;
}

/**
 * The sentence a deferred entry shows.
 * @param {{ until: string, by?: string, reason?: string }} mark
 * @returns {string}
 */
export function deferReason(mark) {
  return `deferred until ${mark.until}${markWords(mark)}`;
}

/**
 * The sentence a bumped entry shows — "moved ahead by …".
 * @param {{ by?: string, reason?: string }|null|undefined} mark
 * @returns {string}
 */
export function bumpReason(mark) {
  return `moved ahead${markWords(mark)}`;
}

/**
 * The sentence a withdrawn phase shows.
 * @param {{ by?: string, reason?: string }|null|undefined} mark
 * @returns {string}
 */
export function withdrawnReason(mark) {
  return `withdrawn from the queue${markWords(mark)}`;
}

/* ------------------------------------------------------------------ *
 * Lanes, policies and capacity (control-tower phase 100, #135 C D F G)
 * ------------------------------------------------------------------ */

/**
 * What an operator may do to a LANE — rows of the one operator verb table
 * (`verb-model.js`), beside phase 90's isolation verbs, and each a
 * `POST /api/lane/<verb>` naming `{slug, phase}`:
 *
 *   - `pin`           the phase takes its plan's NEXT lane: while it waits in
 *                     the queue for a lane, none of its run's other entries
 *                     boards ahead of it; spent when it boards;
 *   - `unpin`         lifts a pin;
 *   - `reserve`       the next lane on its scope is KEPT for it — when the lane
 *                     named in `lane` ends, or at once — even while it is
 *                     parked or not yet queued: nothing else on that scope, and
 *                     nothing into the freed slot, boards until it does;
 *   - `unreserve`     lifts a reservation;
 *   - `yield`         a live lane hands off at its next safe point and its
 *                     lane goes, reserved, to the named phase or the head of
 *                     the queue — no sibling re-board can take it in between;
 *   - `isolate-phase` one phase runs in a worktree of its own (phase 90);
 *   - `isolate`       the run switches to isolation at its next boundary.
 *
 * A pin and a reservation are marks on the phase's RECORD, like phase 99's
 * words, so they survive a pause, a retry, a wrap-up and a restart. Neither
 * widens a scoped run (`onlyPhases`): a phase outside its run's scope is
 * refused, so a pin never breaks `honestScopedFinish`.
 */
export const LANE_VERBS = Object.freeze(
  /** @type {const} */ (['pin', 'unpin', 'reserve', 'unreserve', 'yield', 'isolate-phase', 'isolate']),
);

/** The lane verbs that are marks on a phase's record — applied by `applyQueueControl`, like phase 99's. */
export const LANE_MARK_VERBS = Object.freeze(/** @type {const} */ (['pin', 'unpin', 'reserve', 'unreserve']));

/** @typedef {(typeof LANE_VERBS)[number]} LaneVerb */
/** @typedef {(typeof LANE_MARK_VERBS)[number]} LaneMarkVerb */

/** The pseudo-holder `slug` a run's other entries wait on while one of its phases is pinned. */
export const PIN_HOLDER = /** @type {const} */ ('pinned');

/** The pseudo-holder `slug` an entry waits on while a lane on its scope is reserved for another phase. */
export const RESERVATION_HOLDER = /** @type {const} */ ('lane reservation');

/** The pseudo-holder `slug` every NEW admission waits on while the machine is loaded. */
export const LOAD_HOLDER = /** @type {const} */ ('machine load');

/**
 * The sentence a run's other entry shows while one of its phases is pinned.
 * @param {string} slug
 * @param {number} phase
 * @param {{ by?: string, reason?: string }|null|undefined} mark
 * @returns {string}
 */
export function pinHoldReason(slug, phase, mark) {
  return `${slug} P${phase} is pinned next${markWords(mark)} — it takes its plan's next lane`;
}

/**
 * The sentence an entry shows while a lane on its scope is reserved for another phase.
 * @param {{ slug: string, phase: number, lane?: { slug: string, phase: number|null }|null, by?: string, reason?: string }} r
 * @returns {string}
 */
export function reservationReason(r) {
  const from = r.lane
    ? ` (the lane ${r.lane.slug}${r.lane.phase != null ? ` P${r.lane.phase}` : ''} gave up)`
    : '';
  return `a lane is reserved for ${r.slug} P${r.phase}${from}${markWords(r)} — nothing else on its scope boards until it does`;
}

/**
 * The scheduling policies (#135 F.24; #128 asks 2–3) — per console, and per
 * plan over the console's. Each orders ONLY what the classes and an
 * operator's word leave tied: a policy promotes an entry within its class,
 * behind a pin and a bump, ahead of the fair-share turn and seniority.
 *
 *   - `seniority`      the default (phase 86): first come, first served;
 *   - `blocker-first`  a phase a sibling declared itself `blocked` on, or one
 *                      whose committed WIP is red on the shared branch
 *                      (`wipRed`), goes first — and a red WIP's owner holds
 *                      its siblings until it boards (their gate is its red);
 *   - `critical-path`  a phase on its plan's critical path goes first, the
 *                      longest remaining chain first.
 */
export const SCHEDULING_POLICIES = Object.freeze(
  /** @type {const} */ (['seniority', 'blocker-first', 'critical-path']),
);

/** @typedef {(typeof SCHEDULING_POLICIES)[number]} SchedulingPolicy */

export const DEFAULT_SCHEDULING_POLICY = /** @type {const} */ ('seniority');

/** How a policy is named on the queue page and in Settings. */
export const SCHEDULING_POLICY_LABELS = Object.freeze({
  seniority: 'Seniority — first come, first served',
  'blocker-first': 'Blocker first — what siblings wait on goes first',
  'critical-path': 'Critical path — the longest remaining chain first',
});

/**
 * A stored or requested policy word, or the default for anything else.
 * @param {unknown} value
 * @returns {SchedulingPolicy}
 */
export function schedulingPolicy(value) {
  return /** @type {readonly unknown[]} */ (SCHEDULING_POLICIES).includes(value)
    ? /** @type {SchedulingPolicy} */ (value)
    : DEFAULT_SCHEDULING_POLICY;
}

/** Is this word a scheduling policy? @param {unknown} value @returns {value is SchedulingPolicy} */
export function isSchedulingPolicy(value) {
  return /** @type {readonly unknown[]} */ (SCHEDULING_POLICIES).includes(value);
}

/**
 * The machine-load guard (#135 G.27): ON by default, holding NEW admissions
 * while the 5-minute load average is above `factor` × the machine's cores.
 * Live lanes are never touched. `loadGuardFactor: 0` switches it off.
 */
export const DEFAULT_LOAD_FACTOR = 1.5;

/**
 * The guard's setting from the console's preferences: its factor, or null when off.
 * @param {{ loadGuardFactor?: unknown }|null|undefined} prefs
 * @returns {number|null}
 */
export function loadGuardFactor(prefs) {
  const raw = prefs?.loadGuardFactor;
  if (raw === undefined || raw === null) return DEFAULT_LOAD_FACTOR;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LOAD_FACTOR;
  return n === 0 ? null : n;
}

/**
 * One reading of the machine's load against the guard — what the scheduler
 * holds on and the queue page shows.
 * @param {{ avg5: number, cores: number, factor: number|null }} sample
 * @returns {{ avg5: number, cores: number, factor: number|null, threshold: number|null, holding: boolean }}
 */
export function loadReading(sample) {
  const cores = Math.max(1, Math.round(sample.cores || 1));
  const avg5 = Math.round((Number(sample.avg5) || 0) * 100) / 100;
  const threshold = sample.factor ? Math.round(sample.factor * cores * 100) / 100 : null;
  return {
    avg5,
    cores,
    factor: sample.factor ?? null,
    threshold,
    holding: threshold !== null && avg5 > threshold,
  };
}

/**
 * The sentence every held admission shows while the machine is loaded.
 * @param {{ avg5: number, cores: number, factor: number|null, threshold: number|null }} reading
 * @returns {string}
 */
export function loadReason(reading) {
  return (
    `the machine is loaded — 5-min load ${reading.avg5} over ${reading.threshold} (${reading.factor} × ${reading.cores} cores); ` +
    'new work boards when it drops, and live lanes carry on'
  );
}
