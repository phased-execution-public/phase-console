/**
 * Status model v2 — what a status IS, beside the untouched paint owner.
 *
 * `status-vocab.js` answers one question with one enum: which of the UI hues a
 * word paints. That answer could not tell a paused run that is waiting for its
 * operator from a paused run whose plan closed a month ago (both "Waiting"), a
 * stale stop nobody will ever answer from a live summons (both amber), or a
 * finished run from a finished run holding failures (both green). The
 * 2026-09-21 audit measured each of those on the operator's machine; the cases
 * are `test/fixtures/live-status-corpus.json`.
 *
 * This module answers three questions instead of one:
 *
 *   - TENSE — is it happening (`live`), standing still (`standing`), or over
 *     (`settled`)? Settled things go quiet: they lose their colour.
 *   - OUTCOME — for a settled thing, how it ended.
 *   - ATTENTION — does a person have to do something? `none` plus the inbox's
 *     own severities, so a badge and the inbox cannot disagree about loudness.
 *
 * and paints through the SAME hues (`paint` is a `UI_STATES` member, worn as a
 * `.state-<paint>` class), so nothing about the palette changes here.
 *
 * **The law.** Amber is never derived from a status word. It comes from an open
 * inbox item, or from a word that IS a person-actor situation — each listed in
 * `PERSON_WORDS` with the reason a person, and only a person, can move it.
 * `test/status-model.test.ts` holds the paint, the attention and that list to
 * each other.
 *
 * Dependency-free ESM, imported by identity by the client (the typed badge
 * family under `client/src/components/ui/status/`) and the node suite. Every
 * word table is keyed by exactly its owner list's members — the test imports
 * the owners and holds the keys to them, so the owners stay the only place a
 * member is written.
 *
 * @typedef {import('./status-vocab.js').UiState} UiState
 * @typedef {(typeof TENSES)[number]} Tense
 * @typedef {(typeof OUTCOMES)[number]} Outcome
 * @typedef {(typeof ATTENTION_LEVELS)[number]} AttentionLevel
 * @typedef {(typeof BAYS)[number]} Bay
 * @typedef {(typeof FACT_KINDS)[number]} FactKind
 * @typedef {(typeof NOTE_SEVERITIES)[number]} NoteSeverity
 * @typedef {keyof typeof WORD_ROWS} StatusVocab
 * @typedef {{ label: string, icon: string, paint: UiState, tense: Tense,
 *             attention: AttentionLevel, outcome?: Outcome }} StatusRow
 * @typedef {{ kind: FactKind, text: string, count?: number, paint?: UiState }} StatusFact
 * @typedef {{ vocab: string, word: string|null, known: boolean, label: string,
 *             icon: string, paint: UiState, tense: Tense, attention: AttentionLevel,
 *             outcome?: Outcome, note?: StatusFact, staleSince?: string }} StatusView
 * @typedef {{ kind?: string, severity?: string, runId?: string, slug?: string,
 *             phase?: number|string|null, ack?: unknown }} InboxLike
 */

import { countsTowardAttention, INBOX_SEVERITIES } from './attention-model.js';
import { phaseLifecycle, phaseSettledWell, runLifecycle, waitOnOf } from './run-lifecycle.js';
import { NOTE_ROWS, NOTE_SEVERITIES } from './status-notes.js';
import { BAYS } from './bays.js';

/* ------------------------------------------------------------------ *
 * The axes
 * ------------------------------------------------------------------ */

/** Is it happening, standing still, or over? */
export const TENSES = Object.freeze(/** @type {const} */ (['live', 'standing', 'settled']));

/**
 * How a settled thing ended. `stopped` is a person's deliberate stop or skip,
 * `superseded` is overtaken by something else (a closed plan, a newer run, a
 * resolution), and `unknown` is a thing that went quiet without ever saying.
 */
export const OUTCOMES = Object.freeze(
  /** @type {const} */ (['ok', 'partial', 'failed', 'stopped', 'superseded', 'unknown']),
);

/**
 * How much a person is needed, quietest first — `none` and then the inbox's
 * severities in rising order. Derived from `INBOX_SEVERITIES`, never re-spelled:
 * a severity added to the inbox is an attention level here the same day.
 * @type {readonly ('none'|import('./attention-model.js').InboxSeverity)[]}
 */
export const ATTENTION_LEVELS = /* @__PURE__ */ Object.freeze(['none', ...[...INBOX_SEVERITIES].reverse()]);

/**
 * The bays of the Tower, most urgent first (§Architecture 5) — owned by the
 * leaf `bays.js` so first paint can read `?bay=` without this module, and
 * re-exported here as the very same object.
 */
export { BAYS };

/** A stop nobody has touched for this long is dormant: quiet, and settled. */
export const STALE_AFTER_MS = 7 * 864e5;

/** The icon of the first-class Unknown — never Waiting's hourglass. */
export const UNKNOWN_ICON = 'circle-question-mark';

/**
 * The words that ARE a person-actor situation, and why only a person moves each.
 * These, and nothing else, may paint amber from the word alone.
 * @type {Readonly<Record<string, string>>}
 */
export const PERSON_WORDS = Object.freeze({
  'phase:awaiting-verification':
    'the machine checks passed and the sign-off on the rest can only come from a person',
  'mcp:needs-auth': 'an MCP server signs in through a browser, and only a person can complete that',
  'auth:expired': 'an expired login is renewed by signing in again, which a session cannot do',
  'auth:signed-out': 'a signed-out account stays unusable until a person signs it in',
  'auth:unusable': 'the API refused this credential on a ground no re-login mends; a person clears it',
  'entitlement:retired': 'a retired credential excludes its whole organisation until a person clears it',
  'decision:outstanding': 'a decision the plan asks for is owed by a person, and the run cannot guess it',
  'verification:human': 'a verification line only a person can check is waiting for that person',
  'landing:conflict': 'a landing git could not merge stays put until a person resolves the conflict',
});

/* ------------------------------------------------------------------ *
 * The word tables
 * ------------------------------------------------------------------ */

/**
 * One row. `attention` defaults to `none`; `outcome` is given only when the
 * tense is `settled`.
 * @param {string} label @param {string} icon @param {UiState} paint @param {Tense} tense
 * @param {{ attention?: AttentionLevel, outcome?: Outcome }} [more]
 * @returns {StatusRow}
 */
function row(label, icon, paint, tense, more = {}) {
  return Object.freeze({
    label,
    icon,
    paint,
    tense,
    attention: more.attention ?? 'none',
    ...(more.outcome ? { outcome: more.outcome } : {}),
  });
}
const PERSON = /** @type {const} */ ({ attention: 'needs-you' });
const FYI = /** @type {const} */ ({ attention: 'fyi' });
const OK = /** @type {const} */ ({ outcome: 'ok' });
const FAILED = /** @type {const} */ ({ outcome: 'failed' });
const STOPPED = /** @type {const} */ ({ outcome: 'stopped' });
const SUPERSEDED = /** @type {const} */ ({ outcome: 'superseded' });

/**
 * The note severities and their rows live in `shared/status-notes.js`, which
 * owns them: the first-paint barrel (`StatusStack`, the toast) imports that
 * module and never this one, so these tables stay out of first paint. Held
 * here by identity, as `WORD_ROWS.note`.
 */
export { NOTE_ROWS, NOTE_SEVERITIES };

/**
 * Every vocabulary the console paints, one row per word. Keyed by each owner's
 * members (the test imports the owners), so a word added to an owner without a
 * row here fails `status-model.test.ts` rather than reaching a page as grey text.
 *
 * `run`, `phase` and `board` rows are the BARE word — what `describeRun` and
 * `describePhase` start from before the context (a closed plan, an inbox item,
 * a live session) refines them.
 */
export const WORD_ROWS = Object.freeze({
  run: Object.freeze({
    running: row('Running', 'circle-play', 'running', 'live'),
    halting: row('Halting', 'octagon-pause', 'running', 'live'),
    halted: row('Halted', 'octagon-alert', 'waiting', 'standing', FYI),
    parked: row('Parked', 'circle-parking', 'waiting', 'standing', FYI),
    interrupted: row('Interrupted', 'unplug', 'waiting', 'standing', FYI),
    waiting: row('Waiting', 'hourglass', 'waiting', 'standing'),
    paused: row('Paused', 'pause', 'waiting', 'standing', FYI),
    pausing: row('Pausing', 'circle-pause', 'running', 'live'),
    frozen: row('Frozen', 'snowflake', 'waiting', 'standing'),
    stopping: row('Stopping', 'square', 'running', 'live'),
    queued: row('Queued', 'circle-dashed', 'queued', 'standing'),
    finished: row('Finished', 'flag', 'done', 'settled', OK),
  }),
  phase: Object.freeze({
    running: row('Running', 'circle-play', 'running', 'live'),
    verifying: row('Verifying', 'search-check', 'verifying', 'live'),
    'awaiting-verification': row('Awaiting sign-off', 'clipboard-check', 'needs-you', 'standing', PERSON),
    queued: row('Queued', 'circle-dashed', 'queued', 'standing'),
    pending: row('Not started', 'circle', 'queued', 'standing'),
    waiting: row('Waiting', 'hourglass', 'waiting', 'standing'),
    gated: row('Gated', 'lock', 'waiting', 'standing', FYI),
    parked: row('Parked', 'circle-parking', 'waiting', 'standing', FYI),
    interrupted: row('Interrupted', 'unplug', 'waiting', 'standing', FYI),
    skipped: row('Skipped', 'circle-slash', 'skipped', 'settled', STOPPED),
    failed: row('Failed', 'circle-x', 'failed', 'settled', FAILED),
    done: row('Done', 'circle-check', 'done', 'settled', OK),
  }),
  board: Object.freeze({
    done: row('Done', 'circle-check', 'done', 'settled', OK),
    'in-progress': row('In progress', 'circle-play', 'running', 'live'),
    stuck: row('Stuck', 'circle-alert', 'waiting', 'standing', FYI),
    ready: row('Next up', 'circle-arrow-right', 'queued', 'standing'),
    waiting: row('Waiting', 'hourglass', 'waiting', 'standing'),
    gated: row('Gated', 'lock', 'waiting', 'standing', FYI),
    blocked: row('Blocked', 'octagon-x', 'waiting', 'standing', FYI),
  }),
  plan: Object.freeze({
    active: row('Active', 'circle-dot', 'running', 'standing'),
    approved: row('Approved', 'badge-check', 'queued', 'standing'),
    proposal: row('Proposal', 'scroll-text', 'queued', 'standing'),
    backlog: row('Backlog', 'list-todo', 'queued', 'standing'),
    complete: row('Complete', 'circle-check', 'done', 'settled', OK),
    abandoned: row('Abandoned', 'ban', 'skipped', 'settled', STOPPED),
    superseded: row('Superseded', 'fast-forward', 'skipped', 'settled', SUPERSEDED),
  }),
  handoff: Object.freeze({
    absent: row('No handoff', 'file-minus', 'skipped', 'standing'),
    pending: row('Pending', 'file-clock', 'queued', 'standing'),
    'in-progress': row('In progress', 'file-pen-line', 'running', 'standing'),
    blocked: row('Blocked', 'file-warning', 'waiting', 'standing', FYI),
    complete: row('Complete', 'file-check', 'done', 'settled', OK),
    unknown: row('Unreadable', 'file-question', 'skipped', 'standing'),
  }),
  'qa-result': Object.freeze({
    pass: row('QA pass', 'badge-check', 'done', 'settled', OK),
    fail: row('QA fail', 'badge-x', 'failed', 'settled', FAILED),
    waived: row('QA waived', 'badge-minus', 'skipped', 'settled', STOPPED),
    pending: row('QA pending', 'clock', 'queued', 'standing'),
    unknown: row('QA unreadable', 'badge-question-mark', 'skipped', 'standing'),
  }),
  'qa-mode': Object.freeze({
    off: row('QA off', 'shield-off', 'skipped', 'standing'),
    on: row('QA on', 'shield-check', 'verifying', 'standing'),
    waived: row('QA released', 'shield-minus', 'skipped', 'standing'),
    unknown: row('QA unreadable', 'shield-question-mark', 'skipped', 'standing'),
  }),
  gate: Object.freeze({
    human: row('Person', 'user-round', 'queued', 'standing'),
    ai: row('Session', 'bot', 'queued', 'standing'),
    auto: row('Automatic', 'zap', 'queued', 'standing'),
    none: row('No gate', 'minus', 'skipped', 'standing'),
  }),
  mcp: Object.freeze({
    connected: row('Connected', 'plug', 'done', 'standing'),
    'needs-auth': row('Needs sign-in', 'key-round', 'needs-you', 'standing', PERSON),
    pending: row('Connecting', 'plug-zap', 'running', 'live'),
    failed: row('Failed', 'unplug', 'failed', 'standing'),
    unknown: row('Unchecked', 'circle-dashed', 'skipped', 'standing'),
  }),
  auth: Object.freeze({
    ok: row('Signed in', 'shield-check', 'done', 'standing'),
    expiring: row('Expiring', 'timer', 'waiting', 'standing', FYI),
    refreshable: row('Idle, renews at next session', 'refresh-cw', 'done', 'standing'),
    expired: row('Expired', 'timer-off', 'needs-you', 'standing', PERSON),
    'signed-out': row('Signed out', 'log-out', 'needs-you', 'standing', PERSON),
    unknown: row('Not checked', 'circle-dashed', 'skipped', 'standing'),
    unusable: row('Unusable', 'shield-x', 'needs-you', 'standing', PERSON),
  }),
  entitlement: Object.freeze({
    unknown: row('Not yet proven', 'circle-dashed', 'skipped', 'standing'),
    entitled: row('Entitled', 'badge-check', 'done', 'standing'),
    cooling: row('Cooling', 'thermometer-snowflake', 'waiting', 'standing'),
    suspect: row('Suspect', 'timer', 'waiting', 'standing', FYI),
    retired: row('Retired', 'archive-x', 'needs-you', 'standing', PERSON),
  }),
  delivery: Object.freeze({
    sent: row('Sent', 'send', 'done', 'settled', OK),
    throttled: row('Throttled', 'timer', 'waiting', 'settled', STOPPED),
    failed: row('Failed', 'mail-x', 'failed', 'settled', FAILED),
    gone: row('Device gone', 'bell-off', 'failed', 'settled', FAILED),
    quiet: row('Quiet hours', 'moon', 'skipped', 'settled', STOPPED),
    skipped: row('Skipped', 'circle-slash', 'skipped', 'settled', STOPPED),
    'no-device': row('No device', 'smartphone', 'skipped', 'settled', STOPPED),
  }),
  watch: Object.freeze({
    pending: row('Watching', 'eye', 'waiting', 'standing'),
    landed: row('Landed', 'plane-landing', 'done', 'settled', OK),
    unknown: row('Unreadable', 'eye-off', 'skipped', 'standing'),
    refused: row('Refused', 'ban', 'failed', 'settled', FAILED),
  }),
  decision: Object.freeze({
    answered: row('Answered', 'message-circle-check', 'done', 'settled', OK),
    outstanding: row('Outstanding', 'message-circle-question', 'needs-you', 'standing', PERSON),
    waived: row('Waived', 'message-circle-x', 'skipped', 'settled', STOPPED),
  }),
  presence: Object.freeze({
    live: row('Live', 'radio', 'running', 'live'),
    ended: row('Ended', 'circle-stop', 'skipped', 'settled', OK),
    unknown: row('Unknown', 'radio-tower', 'skipped', 'standing'),
  }),
  terminal: Object.freeze({
    running: row('Running', 'circle-play', 'running', 'live'),
    frozen: row('Frozen', 'snowflake', 'waiting', 'standing'),
    stopping: row('Stopping', 'square', 'running', 'live'),
    exited: row('Exited', 'circle-stop', 'skipped', 'settled', OK),
    failed: row('Exited with an error', 'circle-x', 'failed', 'settled', FAILED),
  }),
  liveness: Object.freeze({
    running: row('Running', 'circle-play', 'running', 'live'),
    stopped: row('Stopped', 'power-off', 'skipped', 'standing'),
    orphaned: row('Directory gone', 'folder-x', 'failed', 'standing'),
    'port-taken': row('Port taken', 'ethernet-port', 'failed', 'standing'),
    unknown: row('No heartbeat', 'heart-off', 'skipped', 'standing'),
  }),
  rung: Object.freeze({
    running: row('Running', 'circle-play', 'running', 'live'),
    fixed: row('Fixed', 'wrench', 'done', 'settled', OK),
    'no-defect': row('Nothing wrong', 'circle-check', 'done', 'settled', OK),
    superseded: row('Superseded', 'fast-forward', 'skipped', 'settled', SUPERSEDED),
    withdrawn: row('Withdrawn', 'undo-2', 'skipped', 'settled', STOPPED),
    failed: row('Failed', 'circle-x', 'failed', 'settled', FAILED),
    interrupted: row('Interrupted', 'unplug', 'skipped', 'settled', { outcome: 'unknown' }),
    'work-in-progress': row('Work in progress', 'construction', 'waiting', 'standing'),
  }),
  // Why a settled rung ended as it did (`RUNG_FAILURE_CAUSES`, control-tower
  // phases 5 and 24): a verdict about the remedy, the machine, or no run at all.
  rungCause: Object.freeze({
    merit: row('On its merits', 'scale', 'queued', 'settled'),
    environment: row('The machine', 'cloud-off', 'skipped', 'settled'),
    'never-ran': row('Never ran', 'circle-dashed', 'skipped', 'settled'),
  }),
  health: Object.freeze({
    error: row('Error', 'circle-x', 'failed', 'standing'),
    warning: row('Warning', 'triangle-alert', 'queued', 'standing'),
    info: row('Info', 'info', 'skipped', 'standing'),
  }),
  probe: Object.freeze({
    ok: row('OK', 'circle-check', 'done', 'settled', OK),
    fail: row('Fail', 'circle-x', 'failed', 'settled', FAILED),
    skip: row('Not asked', 'circle-slash', 'skipped', 'settled', STOPPED),
  }),
  restart: Object.freeze({
    waiting: row('Waiting for a quiet point', 'hourglass', 'waiting', 'standing'),
    running: row('Updating', 'download', 'running', 'live'),
    restarting: row('Restarting', 'refresh-cw', 'running', 'live'),
    stopped: row('Did not restart', 'circle-stop', 'skipped', 'settled', STOPPED),
  }),
  checkout: Object.freeze({
    shared: row('Shared checkout', 'folder-git-2', 'queued', 'standing'),
    worktree: row('Own worktree', 'git-branch', 'done', 'standing'),
    refused: row('Isolation refused', 'git-branch-minus', 'skipped', 'standing', FYI),
  }),
  radar: Object.freeze({
    clean: row('Clean', 'git-merge', 'done', 'standing'),
    overlap: row('Overlap', 'git-compare', 'queued', 'standing'),
    conflicted: row('Conflicted', 'git-pull-request-closed', 'failed', 'standing'),
    unknown: row('Not checked', 'circle-dashed', 'skipped', 'standing'),
  }),
  // A settle-history row (control-tower phase 26): how a run's work reached, or
  // failed to reach, the trunk. `pending` and `unsupported` are not failures —
  // one has not happened yet, the other is a standing fact about the repository.
  settle: Object.freeze({
    settled: row('Settled', 'git-merge', 'done', 'settled', OK),
    landed: row('Landed', 'plane-landing', 'done', 'settled', OK),
    pushed: row('Pushed', 'cloud-upload', 'done', 'settled', OK),
    pending: row('Pending', 'hourglass', 'queued', 'standing'),
    unsupported: row('Not supported here', 'circle-slash', 'skipped', 'standing'),
    failed: row('Failed', 'circle-x', 'failed', 'settled', FAILED),
    released: row('Released', 'undo-2', 'skipped', 'settled', OK),
    pruned: row('Pruned', 'scissors', 'skipped', 'settled', OK),
  }),
  // What a working tree IS to the console (control-tower phase 26). A role, not
  // a health: debris asks to be read before anything is reclaimed, nothing more.
  'checkout-role': Object.freeze({
    root: row('Root', 'house', 'skipped', 'standing'),
    run: row('Run', 'folder-git-2', 'queued', 'standing'),
    lane: row('Lane', 'git-branch', 'queued', 'standing'),
    staging: row('Staging', 'layers', 'done', 'standing'),
    operator: row('By hand', 'hand', 'skipped', 'standing'),
    debris: row('Debris', 'folder-x', 'waiting', 'standing'),
  }),
  // A phase's landing, one station of its journey (control-tower phase 26):
  // `pushed → pr-open → pr-merged` is travel, `held` is a settled choice and
  // never a failure, and a conflict waits for the person who resolves it.
  landing: Object.freeze({
    held: row('Held', 'circle-pause', 'skipped', 'settled', STOPPED),
    integrated: row('Integrated', 'git-merge', 'done', 'settled', OK),
    pushed: row('Pushed', 'cloud-upload', 'running', 'standing'),
    'pr-open': row('PR open', 'git-pull-request-arrow', 'waiting', 'standing'),
    'pr-merged': row('PR merged', 'git-merge', 'done', 'settled', OK),
    landed: row('Landed', 'plane-landing', 'done', 'settled', OK),
    conflict: row('Conflict', 'git-pull-request-closed', 'needs-you', 'standing', PERSON),
    failed: row('Failed', 'circle-x', 'failed', 'settled', FAILED),
  }),
  verification: Object.freeze({
    none: row('Not run', 'list', 'skipped', 'standing'),
    red: row('Red', 'list-x', 'failed', 'settled', FAILED),
    skipped: row('Skipped', 'list-minus', 'skipped', 'settled', STOPPED),
    human: row('Needs a person', 'user-round-check', 'needs-you', 'standing', PERSON),
    green: row('Green', 'list-checks', 'done', 'settled', OK),
  }),
  note: NOTE_ROWS,
});

/** The vocabularies, in the order the Guide lists them. */
export const STATUS_VOCABS = /* @__PURE__ */ Object.freeze(
  /** @type {StatusVocab[]} */ (Object.keys(WORD_ROWS)),
);

/* ------------------------------------------------------------------ *
 * Facts beside a status — the qualifier a precise word sometimes needs
 * ------------------------------------------------------------------ */

/**
 * What a view's `note` can be: the reason a stopped thing is quiet, the count
 * behind a partial finish, what a wait is waiting on. Rendered by `FactBadge`,
 * beside the status and never instead of it.
 */
export const FACT_KINDS = Object.freeze(
  /** @type {const} */ ([
    'plan-closed',
    'resolved',
    'overtaken',
    'failed-count',
    'recovering',
    'dormant',
    'waiting-on',
    'no-session',
  ]),
);

/** @type {Readonly<Record<FactKind, { icon: string, paint: UiState }>>} */
export const FACT_META = Object.freeze({
  'plan-closed': { icon: 'archive', paint: 'skipped' },
  resolved: { icon: 'check-check', paint: 'skipped' },
  overtaken: { icon: 'git-commit-horizontal', paint: 'skipped' },
  'failed-count': { icon: 'circle-x', paint: 'failed' },
  recovering: { icon: 'life-buoy', paint: 'running' },
  dormant: { icon: 'moon', paint: 'skipped' },
  'waiting-on': { icon: 'hourglass', paint: 'waiting' },
  'no-session': { icon: 'unplug', paint: 'skipped' },
});

/** What an attention level is called and drawn with — `AttentionMark`'s table. */
export const ATTENTION_META = Object.freeze({
  none: { label: 'Nothing to do', icon: 'minus' },
  fyi: { label: 'Worth a look', icon: 'info' },
  'needs-you': { label: 'Needs you', icon: 'hand' },
  urgent: { label: 'Urgent', icon: 'siren' },
});

/**
 * What a wait is on, in the words a `waiting-on` note says. Keyed by
 * `WAIT_REASONS` (`status-vocab.js`); a reason with no phrase says "a clock".
 * @type {Readonly<Record<string, string>>}
 */
const WAIT_PHRASES = Object.freeze({
  'usage-limit': 'the usage window',
  external: 'external work',
  scope: 'another lane’s scope',
  schedule: 'the schedule',
  person: 'you',
  connectivity: 'the network',
  'engine-busy': 'a busy engine',
});

/** How long an `on` may run in a note before it is cut — a `cmd:` ref may be a thousand characters. */
const WAIT_ON_MAX = 80;

const MONTHS = Object.freeze([
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]);

/**
 * A wait's clock as a note says it: `08:57Z` on the day it is read, `Sep 27
 * 06:00Z` on any other. UTC, and marked so — a badge has no idea whose clock
 * the reader keeps, and #148's operator read both waits in it.
 * @param {string} iso @param {number} now @returns {string}
 */
function clockWords(iso, now) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const d = new Date(at);
  const n = new Date(now);
  const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
  const sameDay =
    d.getUTCFullYear() === n.getUTCFullYear() &&
    d.getUTCMonth() === n.getUTCMonth() &&
    d.getUTCDate() === n.getUTCDate();
  return sameDay ? hm : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${hm}`;
}

/**
 * What a wait is on and when it ends, as one `waiting-on` note (#148): the
 * writer's `on`, else what the run itself says (`waitOnOf` — a waiting phase's
 * watch ref or reason, a window's account), else the kind's phrase; then its
 * clock — a usage window RESETS, everything else RESUMES.
 * @param {RunLike} run @param {{ kind?: string, until?: string|null, on?: string }|undefined} wait
 * @param {string} kind @param {number} now @returns {string}
 */
function waitWords(run, wait, kind, now) {
  const said =
    wait?.on ??
    waitOnOf(/** @type {Parameters<typeof waitOnOf>[0]} */ (run), kind) ??
    WAIT_PHRASES[kind] ??
    'a clock';
  const on = said.length > WAIT_ON_MAX ? `${said.slice(0, WAIT_ON_MAX - 1)}…` : said;
  const until = run.waitUntil ?? wait?.until ?? null;
  const when = until ? clockWords(until, now) : '';
  return `on ${on}${when ? ` · ${kind === 'usage-limit' ? 'resets' : 'resumes'} ${when}` : ''}`;
}

/**
 * Every icon name the model can hand a badge. The client's `status-icons.ts`
 * maps each one to its component, and `family.test.tsx` holds that map total
 * against this list.
 * @type {readonly string[]}
 */
export const STATUS_ICON_NAMES = /* @__PURE__ */ (() =>
  Object.freeze([
    ...new Set([
      UNKNOWN_ICON,
      ...Object.values(WORD_ROWS).flatMap((rows) => Object.values(rows).map((r) => r.icon)),
      ...Object.values(FACT_META).map((m) => m.icon),
      ...Object.values(ATTENTION_META).map((m) => m.icon),
    ]),
  ]))();

/* ------------------------------------------------------------------ *
 * describeWord — document and ops words: a pure lookup
 * ------------------------------------------------------------------ */

/**
 * @param {string} vocab
 * @param {string|null|undefined} word
 * @returns {StatusView}
 */
function unknownView(vocab, word) {
  return {
    vocab,
    word: word ?? null,
    known: false,
    label: 'Unknown',
    icon: UNKNOWN_ICON,
    paint: 'skipped',
    tense: 'standing',
    attention: 'none',
  };
}

/**
 * The view of one word of one vocabulary. A word the vocabulary does not hold —
 * including `null`, an empty string, and a word ANOTHER vocabulary owns — is
 * the first-class Unknown: its own icon, no colour, and never "Waiting".
 * @param {StatusVocab|string} vocab
 * @param {string|null|undefined} word
 * @returns {StatusView}
 */
export function describeWord(vocab, word) {
  const rows = /** @type {Record<string, Record<string, StatusRow>>} */ (WORD_ROWS)[vocab];
  const hit = rows && typeof word === 'string' && Object.hasOwn(rows, word) ? rows[word] : undefined;
  if (!hit) return unknownView(String(vocab), word);
  return { vocab: String(vocab), word: /** @type {string} */ (word), known: true, ...hit };
}

/* ------------------------------------------------------------------ *
 * The inbox, read for one subject
 * ------------------------------------------------------------------ */

/**
 * The loudest attention the open inbox holds for a subject, `fyi` items aside.
 * @param {readonly InboxLike[]|undefined} inbox
 * @param {(item: InboxLike) => boolean} mine
 * @returns {'urgent'|'needs-you'|null}
 */
function summonsFor(inbox, mine) {
  let loudest = /** @type {'urgent'|'needs-you'|null} */ (null);
  for (const item of inbox ?? []) {
    if (!item || !mine(item) || !countsTowardAttention(item.severity)) continue;
    if (item.severity === 'urgent') return 'urgent';
    loudest = 'needs-you';
  }
  return loudest;
}

/**
 * Does an open person's turn stand on this run — a `human-step` row, not
 * acknowledged, matched the way every other item is (control-tower phase 42)?
 * @param {readonly InboxLike[]|undefined} inbox
 * @param {{ id?: string, slug?: string }} run
 * @returns {boolean}
 */
function stepSummons(inbox, run) {
  return (inbox ?? []).some(
    (item) =>
      item?.kind === 'human-step' &&
      !item.ack &&
      (item.runId ? item.runId === run.id : Boolean(run.slug) && item.slug === run.slug),
  );
}

/**
 * Paint a view as a summons: amber, or red when the item is urgent.
 * @param {StatusView} view @param {'urgent'|'needs-you'} level @returns {StatusView}
 */
function summoned(view, level) {
  // A summons is standing, and a standing thing has no outcome yet.
  /** @type {StatusView} */
  const next = {
    ...view,
    paint: level === 'urgent' ? 'failed' : 'needs-you',
    tense: 'standing',
    attention: level,
  };
  delete next.outcome;
  return next;
}

/**
 * Settle a view as overtaken by something else — quiet, colourless, with the
 * reason as its fact.
 * @param {StatusView} view @param {StatusFact} note @returns {StatusView}
 */
function superseded(view, note) {
  return { ...view, paint: 'skipped', tense: 'settled', attention: 'none', outcome: 'superseded', note };
}

/* ------------------------------------------------------------------ *
 * describeRun — the first-match table (§Architecture 3)
 * ------------------------------------------------------------------ */

/**
 * @typedef {{ id?: string, slug?: string, status?: string, lifecycle?: object,
 *   waitReason?: string|null, waitUntil?: string|null, stoppedBy?: string|null,
 *   resolved?: unknown, updatedAt?: string|null, halt?: { kind?: string }|null,
 *   freeze?: unknown, phases?: Record<string, { status?: string }>,
 *   onLimit?: string|null, accountId?: string|null,
 *   recoveries?: Record<string, { errand?: unknown }|undefined> }} RunLike
 * @typedef {{ planClosed?: boolean, newerRunId?: string|null,
 *   inbox?: readonly InboxLike[], now?: number, rungsLeft?: boolean|number }} RunCtx
 */

/** The run statuses a stop is spelled with — the rows the inbox and the clock decide. */
const STOP_WORDS = new Set(['halted', 'parked', 'interrupted', 'paused']);

/**
 * The phases a finished run left unsettled, as a red count: "1 failed, 2 parked".
 * A phase the run never touched (`pending`) is not counted — it asked nothing of
 * the run. Settled-well is `phaseSettledWell`'s answer, never re-derived here.
 * @param {RunLike} run @returns {StatusFact|undefined}
 */
function unsettledCount(run) {
  /** @type {Map<string, number>} */
  const by = new Map();
  for (const [phase, record] of Object.entries(run.phases ?? {})) {
    const status = record?.status ?? '';
    if (status === 'pending') continue;
    if (phaseSettledWell(record, run.recoveries?.[phase]?.errand)) continue;
    // A done phase that still holds an errand is owed something: say so as such.
    const word = status === 'done' || status === 'skipped' ? 'owed' : status;
    by.set(word, (by.get(word) ?? 0) + 1);
  }
  const count = [...by.values()].reduce((a, b) => a + b, 0);
  if (!count) return undefined;
  const text = [...by].map(([word, n]) => `${n} ${word}`).join(', ');
  return { kind: 'failed-count', text, count, paint: 'failed' };
}

/**
 * What a run IS, in context. First match wins:
 *
 *   1. It did not finish, and its plan closed, it was resolved, or a newer run
 *      of the slug overtook it → settled, superseded, quiet.
 *   2. Finished, and every phase it touched settled well → done.
 *   3. Finished holding a phase that did not → partial, with a red count.
 *   4. Stopped by the operator → queued, "Paused by you" / "Stopped by you".
 *   5. A live loop (running, pausing, stopping, halting) → running, the act
 *      landing on it as the label; frozen → a wait on the person who froze it.
 *   6. A wait, by its kind: a person → amber; a usage window, external work,
 *      the schedule, the network → waiting, saying on what and when it ends;
 *      scope → queued. A `paused` run asleep on a clock nobody paused IS a
 *      wait (its lifecycle says so — #148) and reads "Waiting", never "Paused".
 *   7. A stop (halted, parked, interrupted, paused by the console) with an open
 *      inbox item → amber, red when urgent. A pause the console took names
 *      who took it: "Paused by its limit rule" (`onLimit: pause`, with the
 *      wall's clock), else "Paused by the console".
 *   8. …without one but with ladder rungs left → running, "recovering".
 *   9. …otherwise waiting and `fyi`; dormant after `STALE_AFTER_MS`.
 *  10. A status outside the vocabulary → Unknown.
 *
 * @param {RunLike|null|undefined} run
 * @param {RunCtx} [ctx]
 * @returns {StatusView}
 */
export function describeRun(run, ctx = {}) {
  const status = run?.status ?? null;
  const base = describeWord('run', status);
  if (!base.known || !run) return base;
  const finished = status === 'finished';

  // 1
  if (!finished) {
    if (ctx.planClosed) return superseded(base, { kind: 'plan-closed', text: 'plan closed' });
    if (run.resolved) return superseded(base, { kind: 'resolved', text: 'resolved' });
    if (ctx.newerRunId) return superseded(base, { kind: 'overtaken', text: 'a newer run' });
  }

  // 2, 3
  if (finished) {
    const count = unsettledCount(run);
    if (!count) return base;
    return {
      ...base,
      paint: 'skipped',
      tense: 'settled',
      attention: 'none',
      outcome: 'partial',
      note: count,
    };
  }

  // 4
  if (run.stoppedBy === 'operator' && STOP_WORDS.has(status ?? '')) {
    return {
      ...base,
      label: status === 'paused' ? 'Paused by you' : 'Stopped by you',
      paint: 'queued',
      tense: 'standing',
      attention: 'none',
    };
  }

  const life = runLifecycle(/** @type {Parameters<typeof runLifecycle>[0]} */ (run));

  // 5
  if (life.state === 'running') {
    if (life.frozen && !life.pending) return base; // the `frozen` row: a wait on whoever froze it
    // A person's turn summons its run even while another lane works
    // (control-tower phase 42): the step is waiting on somebody now, and the
    // lane beside it running does not make that any less true.
    if (stepSummons(ctx.inbox, run))
      return summoned({ ...base, paint: 'running', tense: 'live', attention: 'none' }, 'needs-you');
    return { ...base, paint: 'running', tense: 'live', attention: 'none' };
  }

  // 6
  if (life.state === 'waiting') {
    const kind = life.wait?.kind ?? 'usage-limit';
    // A clocked `paused` run folds here (#148): it reads as the wait it is, in
    // the wait's own row, and keeps its stored word as `word`.
    const view = status === 'paused' ? { ...describeWord('run', 'waiting'), word: status } : base;
    /** @type {StatusFact} */
    const note = { kind: 'waiting-on', text: waitWords(run, life.wait, kind, ctx.now ?? Date.now()) };
    if (kind === 'person')
      return { ...view, paint: 'needs-you', tense: 'standing', attention: 'needs-you', note };
    // …and while it waits on something else: the step is the wait a person can end.
    if (stepSummons(ctx.inbox, run)) return summoned({ ...view, note }, 'needs-you');
    if (kind === 'scope') return { ...view, paint: 'queued', tense: 'standing', attention: 'none' };
    return { ...view, paint: 'waiting', tense: 'standing', attention: 'none', note };
  }

  // 7 — a pause nobody pressed names who took it (#148).
  /** @type {StatusView} */
  let stopped = base;
  if (status === 'paused' && run.stoppedBy === 'system') {
    const rule = life.wait?.kind === 'usage-limit' || (run.waitReason === 'usage-limit' && run.waitUntil);
    stopped =
      rule && run.onLimit === 'pause'
        ? {
            ...base,
            label: 'Paused by its limit rule',
            note: {
              kind: 'waiting-on',
              text: waitWords(run, life.wait, 'usage-limit', ctx.now ?? Date.now()),
            },
          }
        : { ...base, label: 'Paused by the console' };
  }
  const level = summonsFor(ctx.inbox, (item) =>
    item.runId ? item.runId === run.id : Boolean(run.slug) && item.slug === run.slug,
  );
  if (level) return summoned(stopped, level);

  // 8
  if (ctx.rungsLeft) {
    return {
      ...stopped,
      paint: 'running',
      tense: 'live',
      attention: 'none',
      note: { kind: 'recovering', text: 'recovering' },
    };
  }

  // 9
  const touched = run.updatedAt ? Date.parse(run.updatedAt) : NaN;
  const now = ctx.now ?? Date.now();
  if (Number.isFinite(touched) && now - touched > STALE_AFTER_MS) {
    return {
      ...stopped,
      paint: 'skipped',
      tense: 'settled',
      attention: 'none',
      outcome: 'unknown',
      note: { kind: 'dormant', text: 'dormant' },
      staleSince: /** @type {string} */ (run.updatedAt),
    };
  }
  return { ...stopped, paint: 'waiting', tense: 'standing', attention: 'fyi' };
}

/**
 * What a waiting run waits on and when it resumes — "on phase 28 ·
 * gh:acme/web#run/1 · resumes 08:57Z" — or null when the run is not waiting
 * (control-tower phase 88, #148). The words are `describeRun`'s own note, so
 * the run header, the Runs rows and the pushes say one thing; a pause somebody
 * took is not a wait, even one with a clock.
 *
 * @param {RunLike} run @param {number} [now] @returns {string|null}
 */
export function waitNote(run, now = Date.now()) {
  if (runLifecycle(run).state !== 'waiting') return null;
  const note = describeRun(run, { now }).note;
  return note?.kind === 'waiting-on' ? note.text : null;
}

/**
 * `waitNote` as a sentence of its own, for a surface with no badge beside it —
 * a push: "Waiting on phase 28 · gh:acme/web#run/1 · resumes 08:57Z".
 *
 * @param {RunLike} run @param {number} [now] @returns {string|null}
 */
export function waitSentence(run, now = Date.now()) {
  const note = waitNote(run, now);
  return note ? `Waiting ${note}` : null;
}

/* ------------------------------------------------------------------ *
 * describePhase
 * ------------------------------------------------------------------ */

/**
 * @typedef {{ status?: string, lifecycle?: object, declared?: { status?: string }|null,
 *   mcpPark?: unknown, lockWaitSince?: unknown, verification?: { ok?: boolean }|null }} PhaseRecordLike
 * @typedef {{ boardState?: string|null, planClosed?: boolean, inbox?: readonly InboxLike[],
 *   live?: boolean, slug?: string, phase?: number|string|null, errand?: unknown }} PhaseCtx
 */

/**
 * What a phase IS, from its run record (when a run has one) and its board word.
 *
 *   1. The board says done → done. The board is the one source of truth for done.
 *   2. The plan is closed → settled, superseded, quiet.
 *   3. The record settled well → its own row (done, skipped).
 *   4. A session is on it → live; a record claiming one with none behind it
 *      (`live: false`) is a claim, not a session.
 *   5. A sign-off a person owes → amber (a `PERSON_WORDS` word).
 *   6. An open inbox item for this phase → amber, red when urgent.
 *   7. Otherwise its own row: a failure stays failed, a stop is a quiet wait,
 *      a queue is a queue.
 *   8. No record: the board word, refined the same way. A word outside both
 *      vocabularies → Unknown.
 *
 * @param {PhaseRecordLike|null|undefined} record
 * @param {PhaseCtx} [ctx]
 * @returns {StatusView}
 */
export function describePhase(record, ctx = {}) {
  const board = ctx.boardState ?? null;
  const boardView = board != null ? describeWord('board', board) : null;
  const status = record?.status ?? null;
  const own = status != null ? describeWord('phase', status) : null;

  // 1
  if (boardView?.known && board === 'done') return boardView;
  const view = own ?? boardView ?? unknownView('phase', null);
  if (!view.known) return view;

  // 2
  if (ctx.planClosed) return superseded(view, { kind: 'plan-closed', text: 'plan closed' });

  // 3
  if (own && phaseSettledWell(record, ctx.errand)) return own;

  // 4
  if (view.tense === 'live') {
    if (ctx.live === false) {
      return {
        ...view,
        paint: 'waiting',
        tense: 'standing',
        attention: 'fyi',
        note: { kind: 'no-session', text: 'no session' },
      };
    }
    return view;
  }

  // 5
  if (view.attention === 'needs-you') return view;

  // 6
  const phaseKey = ctx.phase == null ? null : String(ctx.phase);
  const level = summonsFor(
    ctx.inbox,
    (item) =>
      Boolean(ctx.slug) &&
      item.slug === ctx.slug &&
      phaseKey != null &&
      String(item.phase ?? '') === phaseKey,
  );
  if (level) return summoned(view, level);

  // 7, 8 — a parked phase says why it waits when the record knows.
  if (own && record) {
    const stop = /** @type {{ stop?: { kind?: string } }} */ (phaseLifecycle(/** @type {never} */ (record)))
      .stop;
    if (stop?.kind === 'scope-cap' || stop?.kind === 'mcp') return { ...view, attention: 'none' };
  }
  return view;
}

/* ------------------------------------------------------------------ *
 * bayOf
 * ------------------------------------------------------------------ */

/**
 * Which bay of the Tower a view belongs in. Urgency first: anything a person is
 * summoned to is in Needs you whatever else it is.
 * @param {StatusView} view
 * @returns {Bay}
 */
export function bayOf(view) {
  if (view.attention === 'needs-you' || view.attention === 'urgent') return 'needs-you';
  if (view.tense === 'live') return 'live';
  if (view.tense === 'settled') return 'settled';
  if (view.vocab === 'board' && view.word === 'ready') return 'ready';
  if (view.paint === 'queued') return 'queued';
  return 'waiting';
}
