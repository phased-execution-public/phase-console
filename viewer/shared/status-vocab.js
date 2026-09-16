/**
 * The status vocabulary — every word the console can show, mapped to exactly
 * one of EIGHT UI states, each with a label, a hue, a tone and an icon.
 *
 * Four vocabularies exist by necessity and used to be painted by five tone
 * tables that agreed with each other only by luck: a RUN's status (what the
 * autopilot is doing), a PHASE RECORD's status (what happened to a phase in a
 * run), the BOARD's state (what is true of a phase on disk), and a SITUATION
 * (why a stopped phase is stopped, `situation-model.js`). This module is the
 * one place each of those words becomes a colour and an icon. Hue and icon are
 * then READ in exactly two places — `StatusBadge` and the `.state-<ui>` CSS
 * classes — so a chip, a row, a strip and a map station cannot disagree.
 *
 * Dependency-free ESM: the client imports it through `lib/status-vocab.ts`,
 * the node suite imports it directly, and `test/status-vocab.test.ts` holds
 * them identical by import identity and the tables total.
 *
 * @typedef {'needs-you'|'failed'|'running'|'verifying'|'waiting'|'queued'|'skipped'|'done'} UiState
 * @typedef {import('./run-lifecycle.js').RunStatus} RunStatus
 * @typedef {import('./run-lifecycle.js').PhaseStatus} PhaseStatus
 * @typedef {{ label: string, hue: UiState, tone: 'accent'|'bad'|'live'|'wait'|'neutral'|'ok', icon: string }} StateMeta
 */

// The actor table is IMPORTED, never copied: `situation-model.js` owns who a
// situation is for, beside the classifier that decides it.
import { SITUATION_ACTOR } from './situation-model.js';
import { RUN_STATUSES } from './run-lifecycle.js';

/**
 * The eight, WORST FIRST. The order is the sort order of every list that
 * groups by state and the precedence `worstOf`/`uiState` decide with: a thing
 * that is several states at once is the one that needs a person soonest.
 * @type {readonly UiState[]}
 */
export const UI_STATES = Object.freeze(
  /** @type {const} */ ([
    'needs-you',
    'failed',
    'running',
    'verifying',
    'waiting',
    'queued',
    'skipped',
    'done',
  ]),
);

/**
 * What each state is called, which hue token paints it (`--status-<hue>`),
 * which tone family it belongs to, and its icon (a lucide name; `StatusBadge`
 * resolves it — this file stays dependency-free).
 *
 * `running` is the only state that may pulse; `verifying` is its family, told
 * apart by a dashed line-style on a map or strip and by its own icon here.
 * @type {Readonly<Record<UiState, StateMeta>>}
 */
export const STATE_META = Object.freeze({
  'needs-you': { label: 'Needs you', hue: 'needs-you', tone: 'accent', icon: 'hand' },
  failed: { label: 'Failed', hue: 'failed', tone: 'bad', icon: 'circle-x' },
  running: { label: 'Running', hue: 'running', tone: 'live', icon: 'circle-play' },
  verifying: { label: 'Verifying', hue: 'verifying', tone: 'live', icon: 'search-check' },
  waiting: { label: 'Waiting', hue: 'waiting', tone: 'wait', icon: 'hourglass' },
  queued: { label: 'Queued', hue: 'queued', tone: 'neutral', icon: 'circle-dashed' },
  skipped: { label: 'Skipped', hue: 'skipped', tone: 'neutral', icon: 'circle-slash' },
  done: { label: 'Done', hue: 'done', tone: 'ok', icon: 'circle-check' },
});

/**
 * The word an unrecognised status paints as. Never amber (it cannot be
 * mistaken for something to act on) and never green (it cannot be mistaken
 * for finished): "waiting" is the honest "we do not know that this can move".
 * @type {UiState}
 */
export const UNKNOWN_STATE = 'waiting';

/**
 * A RUN's status (`server/runner/state.ts` `RunStatus`, twelve words) → UI
 * state. A halt, a park and an interruption all need a person; a pause, a
 * freeze, a usage-window sleep and a stop-in-progress are all waits.
 * @type {Readonly<Record<RunStatus, UiState>>}
 */
export const RUN_STATUS_UI = Object.freeze({
  running: 'running',
  halting: 'needs-you',
  halted: 'needs-you',
  parked: 'needs-you',
  interrupted: 'needs-you',
  waiting: 'waiting',
  paused: 'waiting',
  pausing: 'waiting',
  frozen: 'waiting',
  stopping: 'waiting',
  queued: 'queued',
  finished: 'done',
});

/**
 * A PHASE RECORD's status (`PhaseStatus`, twelve words) → UI state. `pending`
 * is queued (the loop has not reached it); `gated`, `parked`, `interrupted`
 * and `awaiting-verification` all wait on a person.
 * @type {Readonly<Record<PhaseStatus, UiState>>}
 */
export const PHASE_STATUS_UI = Object.freeze({
  running: 'running',
  verifying: 'verifying',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
  queued: 'queued',
  pending: 'queued',
  waiting: 'waiting',
  gated: 'needs-you',
  parked: 'needs-you',
  'awaiting-verification': 'needs-you',
  interrupted: 'needs-you',
});

/**
 * THE BOARD'S BUCKET VOCABULARY — the engine's truth, and the one place its
 * members are written down.
 *
 * `phase-graph.sh` is the authority, and what it actually emits is five
 * BUCKETS: `--memory-block` prints `done:`, `in-progress:`, `stuck:`, `ready:`
 * and `waiting:` (`scripts/phase-graph.sh:1825-1829`) and `engine.ts`'s parser
 * accepts exactly those five. Every phase is in exactly one of them.
 *
 * Two words that LOOK like board states are not buckets, which is why they are
 * `BOARD_OVERLAY_STATES` below and not here:
 *
 * - **`blocked`** is a HANDOFF status, not a bucket. `phase_status()` folds it
 *   to `stuck` before the board ever sees it (`phase-graph.sh:560`). The
 *   `blocked:` line in the machine block is a different field entirely — the
 *   blockedBy pairs saying WHY a waiting phase waits.
 * - **`gated`** is a per-phase FLAG, orthogonal to the bucket: `is_gated()`
 *   answers independently, so a phase can be `ready` AND gated, or `done` and
 *   still carry its cleared gate.
 *
 * Called BUCKETS, not "board states": the client already uses
 * `BOARD_STATES` for the seven PAINT keys below, and two different lists
 * sharing one name is the exact defect this phase exists to remove.
 *
 * Adding a sixth bucket word means editing this array and nothing else — the
 * paint table below, `phase-model.js`'s `BOARD_ORDER`, `evidence-model.js`'s
 * `BOARD_WORDS`, `engine.ts`'s `PhaseState` and `analysis/metrics.ts`'s
 * `PHASE_STATES` all derive from it, and `test/vocab-owners.test.ts` fails if
 * any of them drifts back into a copy.
 * @type {readonly ('done'|'in-progress'|'stuck'|'ready'|'waiting')[]}
 */
export const BOARD_BUCKETS = Object.freeze(
  /** @type {const} */ (['done', 'in-progress', 'stuck', 'ready', 'waiting']),
);

/**
 * The two words the CONSOLE paints as board states although the engine never
 * emits them as buckets — a handoff that says `blocked` (before the board
 * folds it to `stuck`) and a phase whose gate is unmet. Console-only overlays:
 * real things to show, but not buckets, and never parsed from a board.
 * @type {readonly ('gated'|'blocked')[]}
 */
export const BOARD_OVERLAY_STATES = Object.freeze(/** @type {const} */ (['gated', 'blocked']));

/**
 * The BOARD's state → UI state: the PAINT table, over the five buckets plus
 * the two overlays. `ready` is "next up" — in line, not asking for anything —
 * and every flavour of stopped (gated, blocked, stuck) needs a person.
 *
 * Its keys are `BOARD_BUCKETS` ∪ `BOARD_OVERLAY_STATES`, held to that by
 * `test/vocab-owners.test.ts`; the superset is deliberate, not drift.
 * @type {Readonly<Record<'done'|'in-progress'|'ready'|'waiting'|'gated'|'blocked'|'stuck', UiState>>}
 */
export const BOARD_STATE_UI = Object.freeze({
  done: 'done',
  'in-progress': 'running',
  ready: 'queued',
  waiting: 'waiting',
  gated: 'needs-you',
  blocked: 'needs-you',
  stuck: 'needs-you',
});

/**
 * The one board word that reads differently from its UI state's label: a
 * ready phase is not merely "queued", it is what happens next.
 * @type {Readonly<Record<string, string>>}
 */
export const BOARD_LABELS = Object.freeze({ ready: 'Next up' });

/**
 * Who a situation is for → UI state. Imported, never copied: the actor table
 * lives in `situation-model.js` beside the classifier that writes it.
 * @type {Readonly<Record<'machine'|'person'|'wait'|'none', UiState>>}
 */
export const ACTOR_UI = Object.freeze({
  person: 'needs-you',
  machine: 'running',
  wait: 'waiting',
  none: 'done',
});

/* ------------------------------------------------------------------ *
 * Phase actors — WHO is driving a live phase
 * ------------------------------------------------------------------ */

/**
 * The three vehicles a live phase can be driven by. A different axis from
 * `ACTOR_UI`'s situation actor (who must act NEXT) and from the session
 * registry's own kind (whose third word is `foreign`, and which the sessions
 * page has already had to rename around once): `autopilot` is a run lane a
 * console spawned — this one's or another's — `agent` is an interactive
 * session a console minted, `external` is a session outside every console,
 * someone's own CLI. Painted BESIDE a status, never instead of one.
 * @type {readonly PhaseActor[]}
 */
export const PHASE_ACTORS = Object.freeze(/** @type {const} */ (['autopilot', 'agent', 'external']));

/** @typedef {'autopilot'|'agent'|'external'} PhaseActor */

/**
 * The shipped wording, verbatim from the Pulse and the sessions page —
 * `foreignVehicle()` has said these exact words since 3.0.
 * @type {Readonly<Record<PhaseActor, string>>}
 */
export const PHASE_ACTOR_LABELS = Object.freeze({
  autopilot: 'Autopilot session',
  agent: 'Console agent',
  external: 'Terminal session',
});

/** @param {unknown} value @returns {value is PhaseActor} */
export function isPhaseActor(value) {
  return typeof value === 'string' && PHASE_ACTORS.includes(/** @type {PhaseActor} */ (value));
}

/** @param {unknown} value @returns {value is UiState} */
export function isUiState(value) {
  return typeof value === 'string' && UI_STATES.includes(/** @type {UiState} */ (value));
}

/**
 * What an act landing on a running run paints as.
 *
 * The three transition words fold to ONE lifecycle state — a halting run is a
 * running run with a halt pending — so the state alone cannot reproduce the
 * colours the status table gave them, and they were never one colour: a pause
 * or a stop is somebody's request landing (`waiting`), a halt is something
 * having gone wrong (`needs-you`). The corpus test caught this by folding the
 * six live `stopping` runs on this machine and finding they would repaint.
 * @type {Readonly<Record<string, UiState>>}
 */
const PENDING_ACT_UI = Object.freeze({ pause: 'waiting', stop: 'waiting', halt: 'needs-you' });

/**
 * The UI state of a run status word; unknown words read as `UNKNOWN_STATE`.
 *
 * @param {string|null|undefined} status
 * @param {{ pending?: string }|null} [lifecycle] `run.lifecycle` — the act
 *   landing on it, when one is. Absent paints from the word alone, which is
 *   every reader before 3.5.0 and the fallback for every run file older than it.
 * @returns {UiState}
 */
export function runUiState(status, lifecycle = null) {
  // Guarded, because the commonest way to call this wrongly is `.map(runUiState)`
  // — `map` hands the INDEX as the second argument, which is a number where a
  // lifecycle belongs. TypeScript catches it at every typed call site; this is
  // what stops a plain-JS one from silently reading `undefined.pending`.
  const pending = lifecycle && typeof lifecycle === 'object' ? lifecycle.pending : undefined;
  if (pending && pending in PENDING_ACT_UI) {
    return /** @type {UiState} */ (PENDING_ACT_UI[pending]);
  }
  return (
    /** @type {UiState|undefined} */ (
      RUN_STATUS_UI[/** @type {keyof typeof RUN_STATUS_UI} */ (status ?? '')]
    ) ?? UNKNOWN_STATE
  );
}

/**
 * The run statuses that have a LOOP behind them — the client's notion of live.
 *
 * Deliberately not the server's `IN_FLIGHT`, and the difference is `queued`: a
 * queued run holds no child and no lock, which is exactly why the server keeps
 * it out of its own list, but a loop IS behind it sitting in `admit()`. Left
 * out, a queued run falls through the status mapping's tail and the fleet calls
 * it *interrupted* while its plan offers a Start button the server 409s.
 *
 * One definition because three surfaces ask the question — the fleet row's
 * pulse, Now's lanes, and the plan pulse — and they had a copy each. Three lists
 * that agree today are three lists that disagree the day a status word is added,
 * and the disagreement shows up as a finished run painted as running on one page
 * and settled on another.
 * @type {readonly string[]}
 */
export const LIVE_RUN_STATUSES = Object.freeze(
  RUN_STATUSES.filter(
    (status) => !['paused', 'parked', 'halted', 'interrupted', 'finished'].includes(status),
  ),
);

/** Is a loop behind this run status? @param {string|null|undefined} status @returns {boolean} */
export function isLiveStatus(status) {
  return LIVE_RUN_STATUSES.includes(status ?? '');
}

/**
 * Two of the eight parks are not an ask, and until 3.5.0 nothing could say so.
 *
 * `PHASE_STATUS_UI` paints `parked` as `needs-you`, which is right for a gate,
 * a declaration or a spent ladder and wrong for the two parks where nobody is
 * owed anything: a phase behind another lane's scope, and a phase whose MCP
 * server would not connect. Both are expected back on their own, and both spent
 * the whole of 3.4 on the inbox with a red dot, which is how an operator learns
 * to stop reading it.
 *
 * The stop kind is consulted for `parked` and for nothing else, so passing one
 * can never change any other status's colour — asserted in
 * `test/run-lifecycle.test.ts` over every member of `PHASE_STATUSES`.
 * @type {ReadonlySet<string>}
 */
const STOPS_NOBODY_IS_ASKED_ABOUT = new Set(['scope-cap', 'mcp']);

/**
 * The UI state of a phase record status word.
 *
 * @param {string|null|undefined} status
 * @param {{ kind?: string }|null} [stop] `lifecycle.stop` — why it is stopped.
 *   Absent means "no reason recorded", which for a park is still an ask.
 * @returns {UiState}
 */
export function phaseUiState(status, stop = null) {
  if (status === 'parked' && stop?.kind && STOPS_NOBODY_IS_ASKED_ABOUT.has(stop.kind)) {
    return 'waiting';
  }
  return (
    /** @type {UiState|undefined} */ (
      PHASE_STATUS_UI[/** @type {keyof typeof PHASE_STATUS_UI} */ (status ?? '')]
    ) ?? UNKNOWN_STATE
  );
}

/** The UI state of a board state word. @param {string|null|undefined} state @returns {UiState} */
export function boardUiState(state) {
  return (
    /** @type {UiState|undefined} */ (
      BOARD_STATE_UI[/** @type {keyof typeof BOARD_STATE_UI} */ (state ?? '')]
    ) ?? UNKNOWN_STATE
  );
}

/**
 * What a board state is called on a badge — the UI state's label, except
 * `ready`, which is "Next up".
 * @param {string|null|undefined} state @returns {string}
 */
export function boardLabel(state) {
  return BOARD_LABELS[state ?? ''] ?? STATE_META[boardUiState(state)].label;
}

/**
 * The UI state of a situation: its actor, with one refinement — a machine's
 * situation that has produced an errand is no longer the machine's problem.
 * @param {string|null|undefined} actor one of `situation-model.js` `SITUATION_ACTOR`'s values
 * @param {{ errand?: unknown }} [opts]
 * @returns {UiState}
 */
export function actorUiState(actor, opts = {}) {
  if (actor === 'machine' && opts.errand) return 'needs-you';
  return (
    /** @type {UiState|undefined} */ (ACTOR_UI[/** @type {keyof typeof ACTOR_UI} */ (actor ?? '')]) ??
    UNKNOWN_STATE
  );
}

/**
 * The UI state of a SITUATION id (`situation-model.js` `SITUATIONS`) — its
 * actor's state, refined by whether an errand has been written for it.
 * @param {string|null|undefined} id
 * @param {{ errand?: unknown }} [opts]
 * @returns {UiState}
 */
export function situationUiState(id, opts = {}) {
  const actor = SITUATION_ACTOR[/** @type {keyof typeof SITUATION_ACTOR} */ (id ?? '')];
  return actorUiState(actor, opts);
}

/**
 * The worst of several UI states, by the order of `UI_STATES`.
 * @param {readonly (UiState|null|undefined)[]} states @returns {UiState}
 */
export function worstOf(states) {
  for (const state of UI_STATES) if (states.includes(state)) return state;
  return UNKNOWN_STATE;
}

/**
 * One UI state for a thing that several vocabularies describe at once.
 *
 * Precedence is "worst first" across whatever the caller knows — with one
 * rule above it: the BOARD saying `done` wins, because the board is the one
 * source of truth for done (a run record the board has overtaken is history,
 * never a state). Open approvals or an errand are a person's, whatever else
 * is true. Nothing known reads as `UNKNOWN_STATE`.
 *
 * @param {{
 *   run?: string|null,
 *   record?: string|null,
 *   board?: string|null,
 *   situation?: { id?: string|null, actor?: string|null }|string|null,
 *   errand?: unknown,
 *   approvals?: number|boolean|null,
 * }} [facts]
 * @returns {UiState}
 */
export function uiState(facts = {}) {
  const { run, record, board, situation, errand, approvals } = facts;
  if (board != null && BOARD_STATE_UI[/** @type {keyof typeof BOARD_STATE_UI} */ (board)] === 'done')
    return 'done';
  /** @type {UiState[]} */
  const states = [];
  if (approvals) states.push('needs-you');
  if (errand) states.push('needs-you');
  if (situation != null) {
    if (typeof situation === 'string') {
      // A situation id, or a bare actor word — ids win, actors are the fallback.
      states.push(
        situation in SITUATION_ACTOR
          ? situationUiState(situation, { errand })
          : actorUiState(situation, { errand }),
      );
    } else if (situation.actor != null) {
      states.push(actorUiState(situation.actor, { errand }));
    } else if (situation.id != null) {
      states.push(situationUiState(situation.id, { errand }));
    }
  }
  if (record != null) states.push(phaseUiState(record));
  if (board != null) states.push(boardUiState(board));
  if (run != null) states.push(runUiState(run));
  return states.length ? worstOf(states) : UNKNOWN_STATE;
}

/**
 * The UI state a bare status WORD would paint as, whichever vocabulary it
 * belongs to — for the Guide's glossary, where the words are inline code in
 * markdown. A UI state's own name answers as itself; an unknown word answers
 * null, never a guess.
 * @param {string} word @returns {UiState|null}
 */
export function wordUiState(word) {
  if (isUiState(word)) return word;
  if (word in RUN_STATUS_UI) return RUN_STATUS_UI[/** @type {keyof typeof RUN_STATUS_UI} */ (word)];
  if (word in PHASE_STATUS_UI) return PHASE_STATUS_UI[/** @type {keyof typeof PHASE_STATUS_UI} */ (word)];
  if (word in BOARD_STATE_UI) return BOARD_STATE_UI[/** @type {keyof typeof BOARD_STATE_UI} */ (word)];
  return null;
}

/** The label for a UI state. @param {UiState|string} state @returns {string} */
export function uiLabel(state) {
  return (STATE_META[/** @type {UiState} */ (state)] ?? STATE_META[UNKNOWN_STATE]).label;
}

/* ------------------------------------------------------------------ *
 * Which wait a run is on
 * ------------------------------------------------------------------ */

/**
 * Why a run is sleeping on `waitUntil` — the fact the clock never carried.
 *
 * Two unrelated things put a run on a clock: a usage window it must sit out,
 * and a phase that declared itself waiting on work outside the session (a CI
 * run, a build, an approval). They want opposite advice — one says "continue
 * under another account", the other says "nothing is wrong, it resumes by
 * itself" — and every reader used to re-derive which was which. Three scanned
 * the phase records for a `waiting` one (a heuristic over records the settle
 * path rewrites), one ran a regex over `finishedReason`, and the client did not
 * derive it at all: it said "usage limit", full stop. That is how
 * console-speed-and-sync run 5aa1945c came to read "Stopped on a usage limit"
 * while its account sat at 72% of a seven-day window, with the run's own
 * `finishedReason` reading "waiting on external work" the whole time.
 *
 * `usage-limit` is the default because it is what the clock nearly always was:
 * absent on every run written before the field, and the record scan behind
 * `waitReasonOf` is the only answer those runs can be given.
 *
 * 3.5.0 adds the two waits that were never on a clock at all and so were never
 * asked about: `scope`, which is a run sitting in `admit()` behind another
 * lane's repository — the status word `queued`, whose reason had nowhere to
 * live — and `schedule`, a run held outside its boarding window. Both used to
 * paint as a stop; both are pipelining, and `run.lifecycle.wait.kind` is where
 * they say so.
 *
 * 5.0.0 adds `person`: a run whose loop is holding a card open for somebody —
 * a verification check only a person can make, a relay question — was the one
 * wait with no word, because its status stayed `running` while the loop
 * awaited the answer. The reason is recorded when the card goes up and cleared
 * when it is answered (`runner.ts`, the human-verify path); zero-touch-console
 * phase 6 moves the status with it (ACC-4.8). Every member has a production
 * writer under `server/` and `test/vocab-owners.test.ts` keeps it so — two of
 * the four above had none for a release (LFC-5).
 * @type {readonly ('usage-limit'|'external'|'scope'|'schedule'|'person')[]}
 */
export const WAIT_REASONS = Object.freeze(
  /** @type {const} */ (['usage-limit', 'external', 'scope', 'schedule', 'person']),
);

/** @typedef {(typeof WAIT_REASONS)[number]} WaitReason */

/**
 * Which wait this run is on, from a state file alone. The RECORDED reason wins;
 * the record scan behind it is the pre-field fallback and nothing more.
 * @param {{ waitReason?: string|null, phases?: Record<string, {status?: string}> }} run
 * @returns {WaitReason}
 */
export function waitReasonOf(run) {
  // ANY recorded member, not just the original two. The list grew to four in
  // 3.5.0 and this reader knowing only half of it would be the drift the
  // vocabulary owner exists to prevent — a stored `scope` would have fallen
  // through to the phase scan and been reported as a usage limit, which is the
  // exact lie the field was added to stop.
  //
  // Every caller asks "is it exactly X?", and a scope or schedule wait is
  // honestly neither of the two they ask about, so each gets a better answer
  // than the fallback gave it: `service-recovery.ts` stops telling a resumed
  // session its stop was quota when it was not.
  if (WAIT_REASONS.includes(/** @type {WaitReason} */ (run.waitReason))) {
    return /** @type {WaitReason} */ (run.waitReason);
  }
  return Object.values(run.phases ?? {}).some((record) => record?.status === 'waiting')
    ? 'external'
    : 'usage-limit';
}
