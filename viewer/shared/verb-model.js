/**
 * The console's operator verbs — ONE table (control-tower phase 98, #137 #144).
 *
 * Supervising four runs for two days, every correction was "press this verb",
 * and every press came from a different door: a button on the run page, a
 * hand-written `curl` with the console's header, a polling shell script, a
 * Python one-liner that parsed `/api/runs`. Each door had its own idea of which
 * verbs exist, what they take and who they are recorded as. This file is the
 * list they all read:
 *
 *   - the ROUTES (`server/api/routes.ts`) — every case of the run-verb switch is
 *     a row here and every row's route is dispatched there
 *     (`test/verb-model.test.ts`, VT-1);
 *   - the CLI (`bin/run-verb.mjs`, `phase-console run <verb>`) — its words,
 *     arguments, routes and exit codes are read from here and nowhere else;
 *   - the stored TRIGGERS (`server/triggers.ts`) — a trigger may press exactly
 *     the rows marked `trigger`, through the same `Service` method the route
 *     calls (`method`), under an actor of its own door;
 *   - the long poll (`GET /api/run/:slug/wait`) and the triggers' `when` — one
 *     predicate grammar, `parseWhen`.
 *
 * A row:
 *
 *   - `name` — the verb, as the CLI spells it.
 *   - `kind` — `read` (answers, changes nothing) or `act`.
 *   - `route` — `METHOD /path`; `:slug`, `:phase` and `:id` are filled from the
 *     positional arguments, everything else rides the body or the query.
 *   - `edition` — which edition's `phase-console run` may press it: every READ
 *     is `free`, every ACT is `pro` and is asked of the license first (phase
 *     67's gate). The console's own buttons are the page's, not this field's.
 *   - `actor` — how the route attributes the press, one of `VERB_ACTOR_CLASSES`:
 *     `press` (a person's press through `OPERATOR_DOOR`, `pressActor`),
 *     `request` (the request's derived actor, reason included —
 *     `actorOfRequest`), `label` (the actor's `by` alone: the reason a caller
 *     sends is dropped — the verbs phase 96 left for this table to name), and
 *     `none` (a read, or an act that records no actor at all).
 *   - `method` — the `Service` method the route calls, which is also the one a
 *     trigger calls: the same door, in-process.
 *   - `trigger` — a stored trigger may fire it.
 *   - `cli` — `null`, or `{ args, flags }`: `args` the positional words in
 *     order, `flags` `--flag` → body field (`true` for a switch).
 *
 * ⚠️ Data only, like every `shared/` vocabulary: the client bundles it and
 * `node --test` imports it directly. Free-safe — no Pro module is named here,
 * and a Pro verb is a row marked `pro`, never an absent one — except `message`,
 * whose route only the Pro tree has: its row is a `!pro:` region.
 */

import { RUN_STATUSES } from './run-lifecycle.js';

/** How a route attributes a press — see the header. */
export const VERB_ACTOR_CLASSES = Object.freeze(/** @type {const} */ (['press', 'request', 'label', 'none']));

/** @typedef {(typeof VERB_ACTOR_CLASSES)[number]} VerbActorClass */

/** A verb reads or acts. */
export const VERB_KINDS = Object.freeze(/** @type {const} */ (['read', 'act']));

/** Where the CLI may press a verb from. */
export const VERB_EDITIONS = Object.freeze(/** @type {const} */ (['free', 'pro']));

/**
 * @typedef {{
 *   name: string, kind: (typeof VERB_KINDS)[number], route: string,
 *   edition: (typeof VERB_EDITIONS)[number], actor: VerbActorClass,
 *   method: string|null, trigger: boolean, inSwitch?: boolean,
 *   cli: null | { args: readonly string[], flags: Readonly<Record<string, string|true>> },
 *   summary: string,
 * }} OperatorVerb
 */

/**
 * @param {string} name
 * @param {'read'|'act'} kind
 * @param {string} route
 * @param {Partial<OperatorVerb>} [rest]
 * @returns {Readonly<OperatorVerb>}
 */
function verb(name, kind, route, rest = {}) {
  return Object.freeze({
    name,
    kind,
    route,
    edition: kind === 'read' ? 'free' : 'pro',
    actor: kind === 'read' ? 'none' : 'request',
    method: null,
    trigger: false,
    cli: null,
    summary: '',
    ...rest,
  });
}

/** A CLI shape: positional words, then `--flag` → body field. */
const cli = (args = [], flags = {}) =>
  Object.freeze({ args: Object.freeze(args), flags: Object.freeze(flags) });

/** The reason every act may carry (control-tower phase 96, #142). */
const WHY = { '--reason': 'reason' };

/**
 * Every operator verb. Order: the reads a terminal needs, the acts #144 asked
 * for, then the rest of the run-verb switch in its own order.
 * @type {readonly Readonly<OperatorVerb>[]}
 */
export const OPERATOR_VERBS = Object.freeze([
  /* ---- reads: both editions ---- */
  verb('runs', 'read', 'GET /api/runs', { cli: cli(), summary: 'every run of this console, slim' }),
  verb('status', 'read', 'GET /api/runs', {
    cli: cli(['slug']),
    summary: "one plan's latest run: status, halt, lanes, liveness (the slim projection)",
  }),
  verb('queue', 'read', 'GET /api/queue', {
    cli: cli(),
    summary: 'the admission queue, with what each entry waits on',
  }),
  verb('accounts', 'read', 'GET /api/accounts', { cli: cli(), summary: 'the accounts and their headroom' }),
  verb('approvals', 'read', 'GET /api/approvals', {
    cli: cli(),
    summary: 'the permission cards waiting on a person',
  }),
  verb('journal', 'read', 'GET /api/run/:slug/journal', {
    cli: cli(['slug'], { '--limit': 'limit', '--since': 'since' }),
    summary: "the run's journal, newest last",
  }),
  verb('tail', 'read', 'GET /api/run/:slug/phase/:phase/activity', {
    cli: cli(['slug', 'phase'], { '--limit': 'limit' }),
    summary: "a phase's last events, from its own session log",
  }),
  verb('explain', 'read', 'GET /api/run/:slug/phase/:phase/report', {
    cli: cli(['slug', 'phase']),
    summary: "a phase's report: doing, done and left, waiting on, why slow, when",
  }),
  verb('plan-text', 'read', 'GET /api/run/:slug/plan-text', {
    summary: 'the plan a plan-mode phase presented',
  }),
  verb('triggers', 'read', 'GET /api/run/:slug/triggers', {
    cli: cli(['slug']),
    summary: "the plan's stored triggers",
  }),

  /* ---- acts: Pro from the CLI ---- */
  verb('wait', 'read', 'GET /api/run/:slug/wait', {
    edition: 'pro',
    cli: cli(['slug'], { '--for': 'for', '--timeout': 'timeout' }),
    summary: 'wait until a predicate holds (status:<word>, run-paused, phase-done:N, …)',
  }),
  verb('pause', 'act', 'POST /api/run/:slug/pause', {
    method: 'pauseRun',
    trigger: true,
    cli: cli(['slug'], WHY),
    summary: 'pause at the next boundary',
  }),
  verb('start', 'act', 'POST /api/run/:slug/start', {
    actor: 'press',
    method: 'startRun',
    cli: cli(['slug'], {
      '--resume': 'resumeRunId',
      '--account': 'accountId',
      '--on-limit': 'onLimit',
      ...WHY,
    }),
    summary: 'start the plan, or continue a stored run (--resume <runId>)',
  }),
  verb('resume', 'act', 'POST /api/run/:slug/resume', {
    actor: 'press',
    method: 'resumeRun',
    trigger: true,
    cli: cli(['slug'], WHY),
    summary: 'lift a pause',
  }),
  verb('resume-phase', 'act', 'POST /api/run/:slug/resume-phase', {
    actor: 'press',
    method: 'pressResume',
    trigger: true,
    cli: cli(['slug', 'phase'], { '--note': 'instruction', ...WHY }),
    summary: 'resume a stopped phase with an instruction',
  }),
  verb('retry', 'act', 'POST /api/run/:slug/retry', {
    actor: 'press',
    method: 'pressRetry',
    trigger: true,
    cli: cli(['slug', 'phase'], { '--addendum': 'addendum', ...WHY }),
    summary: 'retry a phase from the top',
  }),
  verb('steer', 'act', 'POST /api/run/:slug/steer', {
    method: 'steerRun',
    trigger: true,
    cli: cli(['slug', 'phase'], { '--text': 'instruction', ...WHY }),
    summary: "write to a live phase's session",
  }),
  verb('bump', 'act', 'POST /api/queue/bump', {
    method: 'bumpQueueEntry',
    trigger: true,
    cli: cli(['slug', 'phase'], WHY),
    summary: "move a phase's queue entry to the front of its class",
  }),
  // The lane verbs (control-tower phase 100, #135 B.8, D.15–16) — the same
  // table as phase 90's `isolate-phase` and `isolate` below (`LANE_VERBS`).
  verb('pin', 'act', 'POST /api/lane/pin', {
    method: 'queueControl',
    cli: cli(['slug', 'phase'], WHY),
    summary: "pin a phase next in its plan: its run's other phases wait for it to take the next lane",
  }),
  verb('unpin', 'act', 'POST /api/lane/unpin', {
    method: 'queueControl',
    cli: cli(['slug', 'phase'], WHY),
    summary: 'lift a pin',
  }),
  verb('reserve', 'act', 'POST /api/lane/reserve', {
    method: 'queueControl',
    cli: cli(['slug', 'phase'], WHY),
    summary: 'keep the next lane on its scope for a phase — even while it is parked — until it boards',
  }),
  verb('unreserve', 'act', 'POST /api/lane/unreserve', {
    method: 'queueControl',
    cli: cli(['slug', 'phase'], WHY),
    summary: 'lift a kept lane',
  }),
  verb('yield', 'act', 'POST /api/lane/yield', {
    method: 'yieldLane',
    cli: cli(['slug', 'phase'], { '--to': 'to', ...WHY }),
    summary: 'hand a live lane over at its next safe point, to --to <slug>/<N> or the head of the queue',
  }),
  verb('queue-policy', 'act', 'POST /api/queue/policy', {
    method: 'setSchedulingPolicy',
    cli: cli([], { '--policy': 'policy', '--slug': 'slug', '--load-factor': 'loadFactor', ...WHY }),
    summary: "choose the scheduling policy (the console's, or --slug one plan's) and the load guard's factor",
  }),
  verb('raise-budget', 'act', 'POST /api/run/:slug/raise-budget', {
    method: 'raiseBudget',
    summary: 'raise the budget that stopped the work, where it was declared, and retry',
  }),
  verb('clear-streak', 'act', 'POST /api/run/:slug/clear-streak', {
    method: 'clearFailureStreak',
    trigger: true,
    cli: cli(['slug'], WHY),
    summary: 'zero the failure streak',
  }),
  verb('board-at-boundary', 'act', 'POST /api/run/:slug/board-at-boundary', {
    actor: 'press',
    method: 'boardAtBoundary',
    trigger: true,
    cli: cli(['slug', 'phase'], { '--note': 'instruction', ...WHY }),
    summary: 'board a phase at the next boundary, ahead of every other candidate',
  }),
  verb('hold', 'act', 'POST /api/run/:slug/hold', {
    method: 'holdRun',
    trigger: true,
    cli: cli(['slug'], WHY),
    summary: 'refuse the next admission; running phases finish',
  }),
  verb('release', 'act', 'POST /api/run/:slug/release', {
    method: 'releaseRun',
    trigger: true,
    cli: cli(['slug'], WHY),
    summary: 'lift a hold',
  }),
  verb('switch-account', 'act', 'POST /api/run/:slug/switch-account', {
    method: 'switchAccountRun',
    trigger: true,
    cli: cli(['slug', 'accountId'], { '--when': 'when', ...WHY }),
    summary: 'move the run to another account (--when boundary cuts no live lane)',
  }),
  verb('note', 'act', 'POST /api/run/:slug/notes', {
    method: 'noteRun',
    trigger: true,
    cli: cli(['slug'], { '--text': 'text', '--pin': 'pinned', '--phase': 'phase' }),
    summary: 'write a note on the run (--pin reads it into every boarding)',
  }),
  verb('trigger', 'act', 'POST /api/run/:slug/triggers', {
    method: 'armTrigger',
    cli: cli(['slug'], {
      '--when': 'when',
      '--then': 'verb',
      '--body': 'body',
      '--every': 'every',
      '--expires': 'expiresAt',
      '--note': 'note',
    }),
    summary: 'arm a verb to fire when an event happens',
  }),
  verb('cancel-trigger', 'act', 'POST /api/run/:slug/triggers/:id/cancel', {
    method: 'cancelTrigger',
    cli: cli(['slug', 'id'], WHY),
    summary: 'cancel a stored trigger',
  }),
  verb('approve', 'act', 'POST /api/approvals/:id', {
    method: 'decideApproval',
    cli: cli(['id'], WHY),
    summary: 'allow a waiting permission card',
  }),
  verb('deny', 'act', 'POST /api/approvals/:id', {
    method: 'decideApproval',
    cli: cli(['id'], WHY),
    summary: 'deny a waiting permission card',
  }),

  /* ---- the rest of the run-verb switch: the page's, not the terminal's ---- */
  verb('ask', 'act', 'POST /api/run/:slug/ask', { actor: 'label', method: 'askRun' }),
  verb('answer', 'act', 'POST /api/run/:slug/answer', { actor: 'label', method: 'answerQuestion' }),
  verb('identity', 'act', 'POST /api/run/:slug/identity', { actor: 'press', method: 'answerIdentity' }),
  verb('freeze', 'act', 'POST /api/run/:slug/freeze', { actor: 'label', method: 'freezeRun' }),
  verb('thaw', 'act', 'POST /api/run/:slug/thaw', { actor: 'none', method: 'thawRun' }),
  verb('stop', 'act', 'POST /api/run/:slug/stop', { method: 'stopRun' }),
  verb('resolve', 'act', 'POST /api/run/:slug/resolve', { method: 'resolveRun' }),
  verb('unresolve', 'act', 'POST /api/run/:slug/unresolve', { actor: 'none', method: 'unresolveRun' }),
  verb('skip', 'act', 'POST /api/run/:slug/skip', { actor: 'none', method: 'skipPhase' }),
  verb('recover', 'act', 'POST /api/run/:slug/recover', { actor: 'press', method: 'recoverPlan' }),
  verb('verify-command', 'act', 'POST /api/run/:slug/verify-command', {
    actor: 'none',
    method: 'verifyInTerminal',
  }),
  verb('mcp-continue', 'act', 'POST /api/run/:slug/mcp-continue', {
    actor: 'press',
    method: 'continueWithoutMcp',
  }),
  verb('qa-recover', 'act', 'POST /api/run/:slug/qa-recover', { method: 'qaRecover' }),
  verb('qa-rerun', 'act', 'POST /api/run/:slug/qa-rerun', { method: 'qaRecover' }),
  verb('ultrareview', 'act', 'POST /api/run/:slug/ultrareview', { actor: 'none', method: 'ultraReviewNow' }),
  verb('recheck', 'act', 'POST /api/run/:slug/recheck', { actor: 'label', method: 'recoverPhase' }),
  verb('closeout', 'act', 'POST /api/run/:slug/closeout', { actor: 'press', method: 'pressResume' }),
  verb('repair-checkout', 'act', 'POST /api/run/:slug/repair-checkout', {
    actor: 'press',
    method: 'repairCheckout',
  }),
  verb('isolate', 'act', 'POST /api/run/:slug/isolate', { actor: 'label', method: 'isolateRun' }),
  verb('isolate-phase', 'act', 'POST /api/run/:slug/isolate-phase', {
    actor: 'label',
    method: 'isolatePhase',
  }),
  verb('errand-tree', 'act', 'POST /api/run/:slug/errand-tree', {
    actor: 'label',
    method: 'errandTree',
    cli: cli(['slug', 'phase']),
    summary: "a checkout at the pushed run branch for a phase's errand, which no prune takes",
  }),
  verb('delegate', 'act', 'POST /api/run/:slug/delegate', { actor: 'press', method: 'delegatePhase' }),
  verb('errand-answered', 'act', 'POST /api/run/:slug/phase/:n/errand-answered', {
    // Dispatched by its own `if` before `switch (verb)` even runs (routes.ts,
    // right after `guardRun`) — its first path segment is `phase`, not a run
    // verb, so it is its own door above the switch, like `message`'s.
    actor: 'press',
    method: 'answerErrand',
    inSwitch: false,
    summary: 'Done — continue: a person did the errand; record the answer and its note, re-board the phase',
  }),
  verb('plan-approval', 'act', 'POST /api/run/:slug/plan-approval', { actor: 'label', method: 'decidePlan' }),
  verb('settings', 'act', 'POST /api/run/:slug/settings', { actor: 'label', method: 'configureRun' }),
]);

/** The verbs by name — derived, never re-typed. */
export const VERB_NAMES = Object.freeze(OPERATOR_VERBS.map((row) => row.name));

/** One row by name, or `undefined`. */
export function verbNamed(name) {
  return OPERATOR_VERBS.find((row) => row.name === name);
}

/**
 * The run-verb switch's `case` for a row — the first segment after
 * `/api/run/:slug/` of a POST route — or `null` for a row the switch does not
 * dispatch (a read, a queue or approval route, the mailbox's own door).
 */
export function runSwitchWord(row) {
  const [method, path] = row.route.split(' ');
  const m = /^\/api\/run\/:slug\/([a-z-]+)/.exec(path ?? '');
  return method === 'POST' && m && row.inSwitch !== false ? m[1] : null;
}

/** Every word the run-verb switch answers, once each, in the table's order. */
export const RUN_SWITCH_WORDS = Object.freeze([
  ...new Set(OPERATOR_VERBS.map(runSwitchWord).filter((word) => word !== null)),
]);

/* ------------------------------------------------------------------ *
 * The CLI's exit codes — "refused, not found and console down" told apart (#144)
 * ------------------------------------------------------------------ */

/**
 * What `phase-console run` exits with. `usage` is also the license gate's
 * refusal, as every gated verb's is; `timed-out` is a `wait` whose predicate
 * never held.
 */
export const CLI_EXIT = Object.freeze({
  ok: 0,
  refused: 1,
  usage: 2,
  'not-found': 3,
  'console-down': 4,
  'timed-out': 5,
});

/* ------------------------------------------------------------------ *
 * When: the event grammar triggers and the long poll share
 * ------------------------------------------------------------------ */

/**
 * What a stored trigger may wait for (#137 item 1):
 *
 *   - `phase-boarded:N` — phase N boards (its `phase.start`).
 *   - `phase-done:N` — the board reads N done after the console's own
 *     §Verification (its `phase.done`).
 *   - `phase-settled:N` — N leaves flight, whatever the outcome.
 *   - `run-paused` — the run actually paused (`run.paused`, or a run found
 *     reading `paused`).
 *   - `entry-queued:N` — N waits in the admission queue.
 *   - `lane-boundary` — any lane of the run ends.
 *   - `at:<ISO time>` — that instant passes.
 */
export const TRIGGER_EVENTS = Object.freeze(
  /** @type {const} */ ([
    'phase-boarded',
    'phase-done',
    'phase-settled',
    'run-paused',
    'entry-queued',
    'lane-boundary',
    'at',
  ]),
);

/** The events that name a phase. */
export const PHASE_TRIGGER_EVENTS = Object.freeze(
  TRIGGER_EVENTS.filter((event) => event.startsWith('phase-') || event === 'entry-queued'),
);

/** `once` is consumed by its first firing; `every` fires until cancelled or expired. */
export const TRIGGER_MODES = Object.freeze(/** @type {const} */ (['once', 'every']));

/** A trigger's life: armed, then one of the three ends. */
export const TRIGGER_STATES = Object.freeze(
  /** @type {const} */ (['armed', 'fired', 'expired', 'cancelled']),
);

/** A trigger is refused past this many armed per plan — a trigger is a correction, not a program. */
export const TRIGGERS_PER_PLAN = 32;

/** The longest a trigger may stay armed: a week, the longest any wait in this system may run. */
export const TRIGGER_MAX_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** The long poll's bounds, in seconds: the default, and the most one request may hold. */
export const WAIT_DEFAULT_S = 60;
export const WAIT_MAX_S = 600;

/**
 * `when` → its parts, or `{ error }`. The long poll's `for` takes the same
 * words plus `status:<run status>`, which only a wait can use — a trigger on a
 * status would fire on every write of it.
 *
 * @param {unknown} text
 * @param {{ wait?: boolean }} [opts]
 * @returns {{ event: string, phase?: number, at?: string, status?: string } | { error: string }}
 */
export function parseWhen(text, opts = {}) {
  if (typeof text !== 'string' || !text.trim()) return { error: 'name an event: ' + whenGrammar(opts) };
  const raw = text.trim();
  const at = raw.indexOf(':');
  const event = (at < 0 ? raw : raw.slice(0, at)).toLowerCase();
  const arg = at < 0 ? '' : raw.slice(at + 1).trim();
  if (opts.wait && event === 'status') {
    return RUN_STATUSES.includes(/** @type {never} */ (arg))
      ? { event, status: arg }
      : { error: `status:<word> takes a run status — one of ${RUN_STATUSES.join(', ')}` };
  }
  if (!TRIGGER_EVENTS.includes(/** @type {never} */ (event)))
    return { error: `unknown event "${event}" — ${whenGrammar(opts)}` };
  if (event === 'at') {
    const ms = Date.parse(arg);
    return Number.isFinite(ms)
      ? { event, at: new Date(ms).toISOString() }
      : { error: 'at:<time> takes an ISO 8601 time' };
  }
  if (PHASE_TRIGGER_EVENTS.includes(/** @type {never} */ (event))) {
    const phase = Number(arg);
    return /^\d+$/.test(arg) && Number.isSafeInteger(phase) && phase > 0
      ? { event, phase }
      : { error: `${event}:<N> takes a phase number` };
  }
  return arg ? { error: `${event} takes no argument` } : { event };
}

/** The grammar, as one line for a refusal. */
export function whenGrammar(opts = {}) {
  const words = TRIGGER_EVENTS.map((event) =>
    event === 'at'
      ? 'at:<ISO time>'
      : PHASE_TRIGGER_EVENTS.includes(/** @type {never} */ (event))
        ? `${event}:<N>`
        : event,
  );
  return (
    opts.wait
      ? ['status:<run status>', ...words.filter((w) => !w.startsWith('at:') && w !== 'lane-boundary')]
      : words
  ).join(' · ');
}
