/**
 * The labelled clocks of a phase, and the start of a plan (#28).
 *
 * A phase record carries five stamps — `startedAt`, `attemptStartedAt`,
 * `attemptEndedAt`, `endedAt`, `durationMs` — and every surface used to
 * subtract the pair of its choosing. Measured: three answers 47 seconds apart
 * for one finished phase, two answers 11.7 minutes apart for one running
 * phase, and nothing on the wire saying which a surface should print. This
 * module names each difference ONCE, and the server ships the result as
 * `phaseClocks` on the run payloads and on `run:progress`:
 *
 * - `sinceFirstBoardedMs` — the phase: from its first boarding to its end, or
 *   to now while it has not ended. The drawer's figure (`PHASE_TOTAL_CLOCK`).
 * - `sinceThisAttemptMs` — the attempt: from the start of the latest attempt
 *   window to its end, or to now while its session runs. What a phase row
 *   prints (`PHASE_ROW_CLOCK`), because it is what an operator can act on.
 * - `workedMs` — the sum of the attempt windows minus `frozenMs`. This IS
 *   `durationMs`: the payload projection writes one over the other, so the
 *   wire has one definition and the stored process-lifetime figure stops
 *   being a sixth answer.
 * - `queuedMs` — time spent waiting for admission (scope, lock, branch),
 *   including a wait still open.
 * - `attemptWindows[]` — each session's window, `{attempt, startedAt,
 *   endedAt?, firstToolAt?, mode?}`; the open one has no `endedAt`. A window
 *   with a `mode` was opened by a session that is not one of the phase's own
 *   attempts — a resume, a repair, a QA round, a closeout, a landing, a review
 *   (control-tower phase 58, #66): each worked the phase, so each is worked
 *   time, and the ETA is fitted on the sum.
 * - `timeToFirstToolMs` — the latest window's first tool call, from its start.
 *
 * A clock nobody measured is `null`, never `0`: "no queue was recorded" and
 * "it waited no time" are different facts.
 *
 * The runner keeps the windows with `openAttemptWindow`, `closeAttemptWindow`
 * and `noteFirstTool`, which live here beside the reader so the two cannot
 * disagree about the shape. Dependency-free ESM; the client may call
 * `phaseClocks` itself to tick a clock between frames.
 */

import { LIVE_RUN_STATUSES } from './status-vocab.js';
import { SESSION_MODES } from './run-lifecycle.js';

/**
 * The session modes whose wall-clock is a phase's WORK: every mode but the
 * pull-request session, which opens the RUN's pull request and is anchored on
 * a phase only because every session needs one (#66). `phase` is the attempt's
 * own mode — its window is opened by the attempt, not by the door.
 */
export const PHASE_WORK_MODES = Object.freeze(SESSION_MODES.filter((mode) => mode !== 'pr'));

/**
 * @typedef {{ attempt: number, startedAt: string, endedAt?: string, firstToolAt?: string, legacy?: true, mode?: string }} AttemptWindow
 * @typedef {{
 *   sinceFirstBoardedMs: number | null,
 *   sinceThisAttemptMs: number | null,
 *   workedMs: number | null,
 *   queuedMs: number | null,
 *   attemptWindows: AttemptWindow[],
 *   timeToFirstToolMs: number | null,
 * }} PhaseClocks
 * @typedef {'sinceFirstBoardedMs'|'sinceThisAttemptMs'|'workedMs'|'queuedMs'|'attemptWindows'|'timeToFirstToolMs'} PhaseClockField
 */

/** The `phaseClocks` object's fields, in wire order. */
/** @type {readonly PhaseClockField[]} */
export const PHASE_CLOCK_FIELDS = Object.freeze(
  /** @type {const} */ ([
    'sinceFirstBoardedMs',
    'sinceThisAttemptMs',
    'workedMs',
    'queuedMs',
    'attemptWindows',
    'timeToFirstToolMs',
  ]),
);

/** What each clock is called wherever it is printed — two surfaces, one sentence. */
export const PHASE_CLOCK_LABELS = Object.freeze({
  sinceFirstBoardedMs: 'since first boarded',
  sinceThisAttemptMs: 'this attempt',
  workedMs: 'worked',
  queuedMs: 'queued',
  attemptWindows: 'attempts',
  timeToFirstToolMs: 'to first tool',
});

/** The clock a phase row prints. */
export const PHASE_ROW_CLOCK = 'sinceThisAttemptMs';
/** The clock the phase drawer adds beside it. */
export const PHASE_TOTAL_CLOCK = 'sinceFirstBoardedMs';

/** The clocks that move with the reader's clock — never part of a digest. */
const TICKING = Object.freeze(['sinceFirstBoardedMs', 'sinceThisAttemptMs', 'workedMs', 'queuedMs']);

/** @param {unknown} iso */
const ms = (iso) => (typeof iso === 'string' ? Date.parse(iso) : Number.NaN);
/** @param {number} value */
const iso = (value) => new Date(value).toISOString();

/**
 * The instant a window with no end last showed work: the attempt's own end
 * stamp, else the last output the lane was heard from, else its start. Used
 * for a window a dead console left open — downtime is not work.
 *
 * @param {any} record
 * @param {AttemptWindow} window
 */
function lastEvidence(record, window) {
  const start = ms(window.startedAt);
  for (const candidate of [record?.attemptEndedAt, record?.liveness?.lastOutputAt]) {
    const value = ms(candidate);
    if (Number.isFinite(value) && value >= start) return value;
  }
  return start;
}

/**
 * The record's attempt windows, oldest first, with any window that cannot be
 * open any more closed at its last evidence. A record written before windows
 * existed yields the one window its stamps describe.
 *
 * @param {any} record
 * @returns {{ windows: AttemptWindow[], complete: boolean }}
 */
function windowsOf(record) {
  const running = record?.status === 'running';
  /** @type {AttemptWindow[]} */
  let windows;
  let complete = true;
  if (Array.isArray(record?.attemptWindows) && record.attemptWindows.length) {
    windows = record.attemptWindows.map((/** @type {AttemptWindow} */ w) => ({ ...w }));
  } else if (typeof record?.attemptStartedAt === 'string') {
    const start = ms(record.attemptStartedAt);
    const end = ms(record.attemptEndedAt);
    /** @type {AttemptWindow} */
    const only = { attempt: Math.max(1, record.attempts ?? 1), startedAt: record.attemptStartedAt };
    if (Number.isFinite(end) && end >= start) only.endedAt = record.attemptEndedAt;
    windows = [only];
    // Before windows, earlier attempts left no stamps: the one window above
    // is all that is known, so the worked figure falls back to the record's.
    complete = (record.attempts ?? 0) <= 1;
  } else {
    return { windows: [], complete: true };
  }
  windows.forEach((window, index) => {
    if (window.endedAt) return;
    if (index === windows.length - 1 && running) return;
    window.endedAt = iso(lastEvidence(record, window));
  });
  return { windows, complete };
}

/**
 * @param {AttemptWindow} window
 * @param {number} nowMs
 */
const windowLength = (window, nowMs) => {
  const end = window.endedAt ? ms(window.endedAt) : nowMs;
  return Math.max(0, end - ms(window.startedAt));
};

/**
 * The clocks of one phase record at `nowMs`.
 *
 * @param {any} record
 * @param {number} nowMs
 * @returns {PhaseClocks}
 */
export function phaseClocks(record, nowMs) {
  const { windows, complete } = windowsOf(record);
  const latest = windows.at(-1);

  const first = ms(record?.startedAt);
  let sinceFirstBoardedMs = null;
  if (Number.isFinite(first)) {
    const ended = ms(record.endedAt);
    const boarded = ms(record.attemptStartedAt ?? record.startedAt);
    // An `endedAt` older than the latest boarding belongs to an earlier stretch.
    const end = Number.isFinite(ended) && !(ended < boarded) ? ended : nowMs;
    sinceFirstBoardedMs = Math.max(0, end - first);
  }

  const sinceThisAttemptMs = latest ? windowLength(latest, nowMs) : null;

  let workedMs = null;
  if (windows.length) {
    const frozen = typeof record.frozenMs === 'number' ? record.frozenMs : 0;
    workedMs = complete
      ? Math.max(0, windows.reduce((sum, w) => sum + windowLength(w, nowMs), 0) - frozen)
      : (typeof record.durationMs === 'number' ? record.durationMs : 0) +
        (latest && !latest.endedAt ? windowLength(latest, nowMs) : 0);
  } else if (typeof record?.durationMs === 'number') {
    workedMs = record.durationMs;
  }

  let queuedMs = typeof record?.queuedMs === 'number' ? record.queuedMs : null;
  // The open interval counts only while the phase still reads queued: a run
  // stopped mid-wait leaves the stamp behind, and it must not grow for ever.
  const queuedAt = ms(record?.queuedAt);
  if (Number.isFinite(queuedAt) && record.status === 'queued') {
    queuedMs = (queuedMs ?? 0) + Math.max(0, nowMs - queuedAt);
  }

  const firstTool = latest ? ms(latest.firstToolAt) : Number.NaN;
  const timeToFirstToolMs =
    latest && Number.isFinite(firstTool) ? Math.max(0, firstTool - ms(latest.startedAt)) : null;

  return {
    sinceFirstBoardedMs,
    sinceThisAttemptMs,
    workedMs,
    queuedMs,
    attemptWindows: windows,
    timeToFirstToolMs,
  };
}

/**
 * The half of a clocks object that does not tick: what `run:progress`'s
 * digest may read. A frame whose only change is that time passed is not news
 * — the reader has the anchors and its own clock — while a window opening or
 * closing, or a first tool call, is.
 *
 * @param {PhaseClocks | null | undefined} clocks
 * @returns {string}
 */
export function clocksDigest(clocks) {
  if (!clocks) return 'null';
  const stable = Object.fromEntries(Object.entries(clocks).filter(([key]) => !TICKING.includes(key)));
  return JSON.stringify(stable);
}

/**
 * Open a window for a session the runner is about to spawn. The first session
 * of a boarding owns the stretch its boarding began (the window starts at
 * `attemptStartedAt`); a later session of the same boarding starts at `atIso`.
 * A window a dead console left open is closed at its last evidence first. A
 * phase that already ran before windows existed gets a seed window whose
 * LENGTH is its old worked figure, so the sum stays exact across the upgrade.
 *
 * @param {any} record the phase record, mutated
 * @param {number} attempt the attempt number this session is
 * @param {string} atIso
 */
export function openAttemptWindow(record, attempt, atIso) {
  if (!Array.isArray(record.attemptWindows)) {
    record.attemptWindows = [];
    const priorMs = (record.durationMs ?? 0) + (record.frozenMs ?? 0);
    if (attempt > 1) {
      const seedStart = ms(record.startedAt ?? record.attemptStartedAt ?? atIso);
      record.attemptWindows.push({
        attempt: attempt - 1,
        startedAt: iso(seedStart),
        endedAt: iso(seedStart + priorMs),
        legacy: true,
      });
    }
  }
  /** @type {AttemptWindow[]} */
  const windows = record.attemptWindows;
  const last = windows.at(-1);
  if (last && !last.endedAt) last.endedAt = iso(lastEvidence(record, last));
  const boarded = ms(record.attemptStartedAt);
  const firstOfBoarding = Number.isFinite(boarded) && (!last || boarded > ms(last.startedAt));
  windows.push({ attempt, startedAt: firstOfBoarding ? record.attemptStartedAt : atIso });
}

/**
 * Give a record written before windows existed the one window its worked
 * figure describes, so a window appended to it adds to that figure instead of
 * replacing it. The seed's LENGTH is the old worked time plus the frozen time
 * the sum subtracts again; where it sits is a fiction (from the attempt's
 * start), and nothing reads a legacy window's position.
 *
 * @param {any} record the phase record, mutated
 * @param {string} atIso
 */
function seedLegacyWindow(record, atIso) {
  if (Array.isArray(record.attemptWindows)) return;
  const frozen = typeof record.frozenMs === 'number' ? record.frozenMs : 0;
  const priorMs = (phaseClocks(record, ms(atIso)).workedMs ?? 0) + frozen;
  record.attemptWindows = [];
  if (!(priorMs > 0)) return;
  const seedStart = ms(record.attemptStartedAt ?? record.startedAt ?? atIso);
  if (!Number.isFinite(seedStart)) return;
  record.attemptWindows.push({
    attempt: Math.max(1, record.attempts ?? 1),
    startedAt: iso(seedStart),
    endedAt: iso(seedStart + priorMs),
    legacy: true,
  });
}

/**
 * Open a window for a session that is NOT one of the phase's own attempts — a
 * resume with an instruction, a repair, a QA round, a closeout, a landing, a
 * review (#66). Before this only an attempt opened one, so a phase finished by
 * its resume or its closeout was recorded as far faster than it was, and taught
 * the ETA a rate nobody worked at. The window starts at the spawn: the time
 * before it (a park, a queue, a halt) was not this session's.
 *
 * @param {any} record the phase record, mutated
 * @param {string} mode the session's mode (`SESSION_MODES`)
 * @param {string} atIso
 */
export function openSessionWindow(record, mode, atIso) {
  seedLegacyWindow(record, atIso);
  /** @type {AttemptWindow[]} */
  const windows = record.attemptWindows;
  const last = windows.at(-1);
  if (last && !last.endedAt) last.endedAt = iso(lastEvidence(record, last));
  windows.push({ attempt: Math.max(1, record.attempts ?? 1), startedAt: atIso, mode });
}

/**
 * A session the journal saw and the record did not — a `phase.session` line
 * of a non-attempt mode, written before the door opened windows — as a closed
 * window (`remeasureFromLedger`). Null when the record already holds a window
 * of that mode ending within `toleranceMs` of it: the door measured it.
 *
 * @param {any} record the phase record, mutated
 * @param {string} mode
 * @param {number} startMs
 * @param {number} endMs
 * @param {number} [toleranceMs]
 * @returns {boolean} whether a window was added
 */
export function addSessionWindow(record, mode, startMs, endMs, toleranceMs = 10_000) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return false;
  const known = Array.isArray(record.attemptWindows) ? record.attemptWindows : [];
  if (
    known.some(
      (/** @type {AttemptWindow} */ w) => w.mode === mode && Math.abs(ms(w.endedAt) - endMs) <= toleranceMs,
    )
  ) {
    return false;
  }
  seedLegacyWindow(record, iso(startMs));
  /** @type {AttemptWindow[]} */
  const windows = record.attemptWindows;
  windows.push({
    attempt: Math.max(1, record.attempts ?? 1),
    startedAt: iso(startMs),
    endedAt: iso(endMs),
    mode,
  });
  // Oldest first, as every reader expects: the latest window is "this attempt".
  windows.sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
  return true;
}

/**
 * Close the open window when its session ends.
 *
 * @param {any} record the phase record, mutated
 * @param {string} atIso
 */
export function closeAttemptWindow(record, atIso) {
  const last = Array.isArray(record.attemptWindows) ? record.attemptWindows.at(-1) : undefined;
  if (last && !last.endedAt) last.endedAt = atIso;
}

/**
 * Stamp the open window's first tool call; later calls change nothing.
 *
 * @param {any} record the phase record, mutated
 * @param {string} atIso
 */
export function noteFirstTool(record, atIso) {
  const last = Array.isArray(record.attemptWindows) ? record.attemptWindows.at(-1) : undefined;
  if (last && !last.endedAt && !last.firstToolAt) last.firstToolAt = atIso;
}

/**
 * A run with `phaseClocks` on every phase and `durationMs` equal to
 * `workedMs` — a copy for a payload, never a write: the object handed in may
 * be a live runner's own state.
 *
 * @template {{ phases?: Record<string, any> } | null | undefined} R
 * @param {R} run
 * @param {number} nowMs
 * @returns {R}
 */
export function withPhaseClocks(run, nowMs) {
  if (!run || !run.phases) return run;
  const phases = Object.fromEntries(
    Object.entries(run.phases).map(([key, record]) => {
      const clocks = phaseClocks(record, nowMs);
      return [
        key,
        {
          ...record,
          phaseClocks: clocks,
          ...(clocks.workedMs !== null ? { durationMs: clocks.workedMs } : {}),
        },
      ];
    }),
  );
  return { ...run, phases };
}

/**
 * When work on a plan began, and how long it has run: the earliest boarding
 * any of its runs recorded (ISO, with time — the plan file's `created` is an
 * authoring date to the day), and the span from it to now while a run is live,
 * else to the last recorded end. `{}` when no run ever boarded a phase.
 *
 * @param {ReadonlyArray<{ status: string, phases?: Record<string, any> }>} runs
 * @param {number} nowMs
 * @returns {{ startedAt?: string, spanMs?: number }}
 */
export function planSpan(runs, nowMs) {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  let live = false;
  for (const run of runs ?? []) {
    if (LIVE_RUN_STATUSES.includes(/** @type {any} */ (run.status))) live = true;
    for (const record of Object.values(run.phases ?? {})) {
      const started = ms(record?.startedAt);
      if (Number.isFinite(started)) first = Math.min(first, started);
      for (const end of [record?.endedAt, record?.attemptEndedAt]) {
        const value = ms(end);
        if (Number.isFinite(value)) last = Math.max(last, value);
      }
    }
  }
  if (!Number.isFinite(first)) return {};
  const end = live ? nowMs : Math.max(first, last);
  return { startedAt: iso(first), spanMs: Math.max(0, end - first) };
}
