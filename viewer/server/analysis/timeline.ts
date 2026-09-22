/**
 * The run, on a time axis — and any two attempts of a phase, side by side.
 *
 * The run page already answers "what did this cost" (`analysis/spend.ts`) and
 * "where did each phase's wall clock go" (the client `Timeline`, a bar per
 * phase scaled against the longest). Neither answers the question a four-hour
 * run actually raises: **what was happening at 14:20, and what was the run
 * waiting for while it happened.** A per-phase bar chart cannot answer it,
 * because every bar starts at the same left edge — the shared axis is exactly
 * the information it throws away.
 *
 * So this module projects the JOURNAL — not the checkpoint — into lanes on one
 * absolute axis. The journal is the right source for three reasons:
 *
 *   1. It is the only per-EVENT record. A `PhaseRecord` holds `attempts: 4`
 *      and one `verification`; it cannot say when attempt 2 started or what
 *      attempt 3's verification did differently.
 *   2. Its timestamps are the ones a person is trying to line up against
 *      something else (a CI run, a deploy, a wall). Anything modelled here
 *      would be a second opinion about a clock we already have.
 *   3. It survives the run. A checkpoint is rewritten in place; the journal is
 *      append-only, so a finished run stays readable months later.
 *
 * ## Every bar is bracketed by two journal entries
 *
 * Nothing here is inferred from a duration field. A bar opens on an event and
 * closes on an event, and the one exception is stated rather than hidden: a bar
 * still open when the journal ends is closed at the horizon and flagged
 * `open`, which the client draws hatched. That is the difference between "this
 * phase worked for 40 minutes" and "this phase has been working for 40 minutes
 * so far", and a Gantt that cannot tell them apart is worse than no Gantt.
 *
 * ## Truncation is reported, never smoothed
 *
 * `Journal.read(limit)` returns the LAST n lines. Handed a truncated tail, a
 * projection would draw every early lane starting at the first entry it
 * happened to see — a confident, wrong picture. So a lane whose first event is
 * not a boarding is marked `partial`, the whole projection carries
 * `truncated`, and the client says so. Same posture as the diff cap in
 * `review.ts`: the cap is REPORTED.
 *
 * ## What an "attempt" is
 *
 * Deliberately a BOARDING — one `phase.start` and everything until the phase
 * leaves the lane — not the inner retry counter. The runner has both: an inner
 * `for (attempt = 1; attempt <= MAX_ATTEMPTS)` loop that re-spawns a session
 * after a transport error, and the outer boarding the ladder and the operator
 * actually reason about. The inner one answers "how many times did the CLI
 * fail to start", which nobody compares; the outer one is the thing that
 * produces an outcome, a verification and a bill.
 *
 * A boarding's money and turns come from the `phase.session` entries inside it
 * — the ONE event carrying an attempt's own `costUsd` rather than the phase's
 * cumulative total. `record.costUsd` accumulates across attempts by design
 * (`runner-attempt.ts`), so differencing it is the only way to get a per-
 * attempt figure out of the checkpoint, and it is unavailable for any attempt
 * that did not end with a `phase.done`. Reading `phase.session` instead means
 * the comparison never has to guess, and never double-counts: the sum of an
 * attempt's sessions is what that attempt spent, and the sum over attempts is
 * the phase total the cost table already shows.
 */

import type { JournalEntry } from '../runner/journal.ts';

/* ------------------------------------------------------------------ *
 * The shapes the client draws
 * ------------------------------------------------------------------ */

/** What a lane was doing. Four states, because they have four different fixes. */
export type BarKind = 'working' | 'verifying' | 'waiting' | 'frozen';

export const BAR_KINDS: readonly BarKind[] = ['working', 'verifying', 'waiting', 'frozen'];

export type TimelineBar = {
  kind: BarKind;
  /** Milliseconds since the run's first entry — the client does no date maths. */
  startMs: number;
  endMs: number;
  /** Which boarding this belongs to, 1-based. `0` = before any boarding was seen. */
  attempt: number;
  /** Still open when the journal ends: drawn hatched, never as a finished bar. */
  open: boolean;
  note?: string;
};

/** A moment worth a tick on the axis, as opposed to a span. */
export type MarkKind =
  | 'board'
  | 'verify'
  | 'rung'
  | 'park'
  | 'wall'
  | 'outcome'
  // Zero-touch phase 19: the ledgers on the axis — a session ending with what it
  // cost, a question or card raised or answered, an answer the policy table gave
  // by itself, and (run-level, no lane) each start of the run with its door.
  | 'session'
  | 'ask'
  | 'policy'
  | 'start';

/**
 * The mark vocabulary, as a value.
 *
 * Exported for the same reason `REVIEW_VERDICTS` is: the guide documents these
 * names, and a doc that lists five of six glyphs is worse than one that lists
 * none. `docs-parity.test.ts` holds the two to each other.
 */
export const MARK_KINDS: readonly MarkKind[] = [
  'board', 'verify', 'rung', 'park', 'wall', 'outcome', 'session', 'ask', 'policy', 'start',
];

/** A session's ending — its one `phase.session` line (zero-touch phase 4's shape). */
const SESSION_END = 'phase.session';

/** Somebody was asked, or answered: a question, a card, a relayed window (phases 13 and 14). */
const ASK = new Set([
  'phase.asked', 'phase.answered',
  'phase.question-raised', 'phase.question-answered', 'phase.question-deferred', 'phase.question-unanswerable',
  'phase.approval-raised', 'phase.approval-decided', 'phase.approval-auto-granted',
]);

/** An answer the policy table gave by itself (phase 11). */
const POLICY_ANSWERED = 'phase.policy-answered';

/** A start of the run — run-level, so it is drawn on the axis rather than in a lane (phase 7's actor). */
const RUN_START = 'run.start';

export type TimelineMark = {
  kind: MarkKind;
  atMs: number;
  phase?: number;
  label: string;
  /** `verify` and `outcome` carry a verdict so the client can colour the tick. */
  ok?: boolean;
};

export type TimelineLane = {
  phase: number;
  bars: TimelineBar[];
  /** First and last entry for this phase, ms from the horizon's left edge. */
  startMs: number;
  endMs: number;
  /** Sums over the bars, so the client never re-adds them. */
  totalMs: number;
  workingMs: number;
  verifyingMs: number;
  waitingMs: number;
  frozenMs: number;
  attempts: number;
  /** The journal's tail cut this lane's opening off — bars begin mid-flight. */
  partial: boolean;
  /** On the measured critical path. */
  critical: boolean;
};

export type RunTimeline = {
  /** ISO of the axis's left edge — the run's first journal entry. */
  startedAt: string | null;
  /**
   * ISO of the moment the run ENDED, or `null` while it is still going.
   * Deliberately distinct from `horizonAt`: a live run has a right edge to
   * draw against and no end, and collapsing the two would have every live
   * Gantt claim the run finished at whatever time it was last looked at.
   */
  endedAt: string | null;
  /** ISO of the axis's right edge — `endedAt` for a finished run, else now. */
  horizonAt: string;
  /** Width of the axis in ms. Never zero for a run with two entries. */
  spanMs: number;
  lanes: TimelineLane[];
  marks: TimelineMark[];
  /** Phases on the longest dependency chain, weighted by MEASURED lane time. */
  criticalPath: number[];
  criticalMs: number;
  /** The journal was read as a tail: early lanes may be `partial`. */
  truncated: boolean;
  /**
   * PHASE entries that moved no bar — reported, never dropped silently.
   *
   * Deliberately excludes run-level lines, which have no lane and never could:
   * counting them would bury a genuinely unmodelled phase event under
   * `run.settings` and friends.
   */
  unmapped: number;
};

/* ------------------------------------------------------------------ *
 * The event vocabulary
 *
 * Named as sets rather than a switch so a new runner event shows up in
 * `unmapped` instead of silently changing a bar's meaning.
 * ------------------------------------------------------------------ */

/** Opens a boarding. */
const BOARD = 'phase.start';

/** Ends a boarding, and with it whatever bar was open. */
const TERMINAL = new Set([
  'phase.done', 'phase.failed', 'phase.stopped', 'phase.skip', 'phase.gated', 'phase.not-started',
]);

/** The phase is parked on something outside itself. */
const PARK_START = new Set([
  'phase.waiting', 'phase.mcp-preflight-parked', 'phase.verify-preflight-parked',
]);

const PARK_END = new Set(['phase.wait-resume', 'phase.resume']);

/** Verification is running: `awaiting-verification` opens it, `verify` closes it. */
const VERIFY_START = 'phase.awaiting-verification';
const VERIFY_END = 'phase.verify';

/** An operator freeze (SIGSTOP) — recorded against the lane it stopped. */
const FREEZE_START = 'run.frozen';
const FREEZE_END = 'run.thawed';

/** A usage wall: the phase stopped because the account could not pay. */
const WALL = new Set(['phase.live-wall', 'run.limit-paused', 'phase.model-window-wait']);

// `phase.rung-unavailable` rides with `phase.rung`: it names a rung the console
// could NOT drive, which is exactly as much a part of "what was tried on this
// phase" as one it did — and a kind no reader touches is a kind nothing can
// tell has stopped working.
export const RUNG_EVENTS = new Set(['phase.rung', 'phase.rung-unavailable']);
const RUNG = RUNG_EVENTS;

/**
 * Phase events that move no bar and are KNOWN not to — so they are not counted
 * as `unmapped`.
 *
 * `unmapped` exists to say "a phase event landed that this projection does not
 * understand", and it is only worth reading while it stays small. Two of the
 * events many-plans-one-repo phase 13 adds are high-volume by construction:
 * `phase.resources` lands up to once a minute per live lane for the whole run,
 * and `phase.suspect` lands per loop. Neither is a span or a tick — a memory
 * reading is a COUNTER, drawn as one by the Chrome export, and a suspicion is
 * an annotation on a lane that is already drawn — so folding them into
 * `unmapped` would have a healthy four-hour run report two hundred
 * "unmodelled" events and make the number useless for the one thing it is for.
 *
 * The rule for adding a name here: it must be an event a reader has ALREADY
 * decided the timeline should not draw. An event nobody has thought about
 * belongs in `unmapped`, which is exactly the point of the counter.
 */
export const KNOWN_NO_BAR = new Set(['phase.resources', 'phase.suspect']);

/* ------------------------------------------------------------------ *
 * Projection
 * ------------------------------------------------------------------ */

const timeOf = (entry: JournalEntry): number => Date.parse(entry.time);

/** One lane, mid-projection. */
type Building = {
  phase: number;
  bars: TimelineBar[];
  open: { kind: BarKind; startMs: number } | null;
  attempt: number;
  firstMs: number;
  lastMs: number;
  /** Saw a boarding before anything else — otherwise the tail cut us off. */
  sawBoard: boolean;
};

export type ProjectOptions = {
  /** The right edge for a run still going. Defaults to the last entry. */
  now?: number;
  /** Phase → its dependencies, for the critical path. Absent ⇒ no overlay. */
  deps?: ReadonlyMap<number, readonly number[]>;
  /** The read was a tail, not the whole file. */
  truncated?: boolean;
};

/**
 * The journal as lanes on one axis.
 *
 * Pure: entries in, projection out. Every timestamp in the result is derived
 * from an entry's own `time`, which is what makes exit criterion 1 checkable
 * — the bars can be held to the journal rather than to a second model of it.
 */
export function projectTimeline(
  entries: readonly JournalEntry[],
  options: ProjectOptions = {},
): RunTimeline {
  const usable = entries.filter((entry) => Number.isFinite(timeOf(entry)));
  if (!usable.length) {
    const at = new Date(options.now ?? 0).toISOString();
    return {
      startedAt: null, endedAt: null, horizonAt: at, spanMs: 0, lanes: [], marks: [],
      criticalPath: [], criticalMs: 0, truncated: Boolean(options.truncated), unmapped: 0,
    };
  }

  // The axis's left edge is the first entry we have — NOT `run.start`, which a
  // truncated tail may not contain and a resumed run may repeat.
  const t0 = Math.min(...usable.map(timeOf));
  const lastMs = Math.max(...usable.map(timeOf));
  const finished = usable.some((entry) => entry.event === 'run.finished');
  // A finished run's axis stops at its last entry. A live one runs to `now` —
  // clamped up, never down: a clock that reads behind the journal must not
  // shorten a bar that is demonstrably still open.
  const horizon = finished ? lastMs : Math.max(lastMs, options.now ?? lastMs);

  const lanes = new Map<number, Building>();
  const marks: TimelineMark[] = [];
  let unmapped = 0;

  const laneOf = (phase: number, atMs: number): Building => {
    let lane = lanes.get(phase);
    if (!lane) {
      lane = { phase, bars: [], open: null, attempt: 0, firstMs: atMs, lastMs: atMs, sawBoard: false };
      lanes.set(phase, lane);
    }
    return lane;
  };

  /** Close whatever is open, discarding a zero-width bar nobody can see. */
  const close = (lane: Building, atMs: number): void => {
    if (!lane.open) return;
    const endMs = Math.max(lane.open.startMs, atMs);
    if (endMs > lane.open.startMs) {
      lane.bars.push({ kind: lane.open.kind, startMs: lane.open.startMs, endMs, attempt: lane.attempt, open: false });
    }
    lane.open = null;
  };

  const open = (lane: Building, kind: BarKind, atMs: number): void => {
    close(lane, atMs);
    lane.open = { kind, startMs: atMs };
  };

  for (const entry of usable) {
    const atMs = timeOf(entry) - t0;
    const phase = typeof entry.phase === 'number' ? entry.phase : undefined;

    if (phase === undefined) {
      // Run-level entries have no lane and are not candidates for one, so they
      // never count as unmapped. Counting them would bury the signal the field
      // exists for — a PHASE event the projection did not understand — under
      // `run.settings`, `run.paused` and every other structurally lane-less
      // line, and a number that always looks alarming is not read.
      if (entry.event === RUN_START) {
        // A start of the run belongs to no lane, so it ticks the axis itself —
        // with its door, which is the answer to "why did this start".
        const data = entry.data ?? {};
        const door = typeof data.door === 'string' && data.door ? data.door : 'start';
        const by = typeof data.by === 'string' && data.by ? ` · ${data.by}` : '';
        marks.push({ kind: 'start', atMs, label: `${door}${data.resumed === true ? ' (resumed)' : ''}${by}` });
      }
      continue;
    }

    const lane = laneOf(phase, atMs);
    lane.lastMs = Math.max(lane.lastMs, atMs);

    if (entry.event === BOARD) {
      // A boarding ends a park as well as any stale bar: the phase is running
      // again, whatever it was doing before.
      close(lane, atMs);
      lane.attempt++;
      if (lane.bars.length === 0) lane.sawBoard = true;
      lane.open = { kind: 'working', startMs: atMs };
      marks.push({ kind: 'board', atMs, phase, label: labelOf(entry, `attempt ${lane.attempt}`) });
      continue;
    }

    if (entry.event === VERIFY_START) { open(lane, 'verifying', atMs); continue; }

    if (entry.event === VERIFY_END) {
      close(lane, atMs);
      // The phase is still in the lane after verifying — it writes a handoff,
      // records an outcome — so working resumes until something terminal.
      lane.open = { kind: 'working', startMs: atMs };
      const ok = entry.data?.ok === true;
      marks.push({ kind: 'verify', atMs, phase, ok, label: ok ? 'verification passed' : 'verification failed' });
      continue;
    }

    if (PARK_START.has(entry.event)) {
      open(lane, 'waiting', atMs);
      marks.push({ kind: 'park', atMs, phase, label: labelOf(entry, 'parked') });
      continue;
    }

    if (PARK_END.has(entry.event)) { close(lane, atMs); lane.open = { kind: 'working', startMs: atMs }; continue; }

    if (entry.event === FREEZE_START) { open(lane, 'frozen', atMs); continue; }

    if (entry.event === FREEZE_END) { close(lane, atMs); lane.open = { kind: 'working', startMs: atMs }; continue; }

    if (TERMINAL.has(entry.event)) {
      close(lane, atMs);
      marks.push({
        kind: 'outcome', atMs, phase,
        ok: entry.event === 'phase.done',
        label: entry.event.replace(/^phase\./, ''),
      });
      continue;
    }

    if (RUNG.has(entry.event)) {
      // A rung the console could NOT drive is labelled as such: rendered with
      // the same word as one it climbed, the timeline would show a remedy that
      // never ran as a remedy that did.
      const rung = String(entry.data?.rung ?? 'rung');
      marks.push({
        kind: 'rung', atMs, phase,
        label: entry.event === 'phase.rung-unavailable' ? `${rung} (unavailable)` : rung,
      });
      continue;
    }

    if (WALL.has(entry.event)) {
      marks.push({ kind: 'wall', atMs, phase, label: labelOf(entry, 'usage wall') });
      continue;
    }

    if (entry.event === SESSION_END) {
      // The session ledger on the axis (phase 19): where each session ended,
      // how, and what it said it cost — `unknown` rather than $0 when it never said.
      const data = entry.data ?? {};
      const cost = data.costSource !== 'none' && typeof data.costUsd === 'number'
        ? ` · $${data.costUsd.toFixed(2)}`
        : ' · cost unknown';
      marks.push({
        kind: 'session', atMs, phase, ok: data.isError !== true,
        label: `${String(data.mode ?? 'session')} · ended by ${String(data.endedBy ?? 'exit')}${cost}`,
      });
      continue;
    }

    if (ASK.has(entry.event)) {
      marks.push({ kind: 'ask', atMs, phase, label: labelOf(entry, entry.event.replace(/^phase\./, '')) });
      continue;
    }

    if (entry.event === POLICY_ANSWERED) {
      const data = entry.data ?? {};
      marks.push({
        kind: 'policy', atMs, phase,
        label: `${String(data.decisionKey ?? 'policy')} → ${String(data.answer ?? '?')} (${String(data.source ?? 'default')})`,
      });
      continue;
    }

    // Everything else is real journal traffic that simply does not move a bar —
    // except the names we have already decided do not move one.
    if (!KNOWN_NO_BAR.has(entry.event)) unmapped++;
  }

  const built: TimelineLane[] = [...lanes.values()]
    .map((lane) => {
      // A bar still open when the journal ends is open, not finished.
      if (lane.open) {
        const endMs = Math.max(lane.open.startMs, horizon - t0);
        lane.bars.push({
          kind: lane.open.kind, startMs: lane.open.startMs, endMs, attempt: lane.attempt, open: true,
        });
        lane.open = null;
      }
      const sum = (kind: BarKind): number =>
        lane.bars.filter((bar) => bar.kind === kind).reduce((total, bar) => total + (bar.endMs - bar.startMs), 0);
      const workingMs = sum('working');
      const verifyingMs = sum('verifying');
      const waitingMs = sum('waiting');
      const frozenMs = sum('frozen');
      return {
        phase: lane.phase,
        bars: lane.bars,
        startMs: lane.bars.length ? Math.min(...lane.bars.map((bar) => bar.startMs)) : lane.firstMs,
        endMs: lane.bars.length ? Math.max(...lane.bars.map((bar) => bar.endMs)) : lane.lastMs,
        totalMs: workingMs + verifyingMs + waitingMs + frozenMs,
        workingMs, verifyingMs, waitingMs, frozenMs,
        attempts: lane.attempt,
        partial: !lane.sawBoard,
        critical: false,
      };
    })
    .sort((a, b) => a.phase - b.phase);

  const critical = options.deps
    ? criticalLane(options.deps, new Map(built.map((lane) => [lane.phase, lane.totalMs])))
    : { phases: [], ms: 0 };
  const onPath = new Set(critical.phases);
  for (const lane of built) lane.critical = onPath.has(lane.phase);

  return {
    startedAt: new Date(t0).toISOString(),
    endedAt: finished ? new Date(lastMs).toISOString() : null,
    horizonAt: new Date(horizon).toISOString(),
    spanMs: Math.max(0, horizon - t0),
    lanes: built,
    marks: marks.sort((a, b) => a.atMs - b.atMs || (a.phase ?? 0) - (b.phase ?? 0)),
    criticalPath: critical.phases,
    criticalMs: critical.ms,
    truncated: Boolean(options.truncated),
    unmapped,
  };
}

/** A one-line label off whatever the entry carried, else a stated fallback. */
function labelOf(entry: JournalEntry, fallback: string): string {
  const data = entry.data ?? {};
  for (const key of ['reason', 'detail', 'note', 'title', 'action', 'gate']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 120);
  }
  return fallback;
}

/**
 * The longest dependency chain through the run, weighted by MEASURED lane time.
 *
 * Deliberately NOT `analysis/graph.ts` `criticalPath`, which weights by
 * estimated phase SIZE over what is left to do — the right answer for "how much
 * work remains", the wrong one for "which chain made this run as long as it
 * was". Same longest-path walk, a different cost function, and both are worth
 * having: the estimate is what you plan with, the measurement is what you
 * learn from.
 *
 * A phase with no lane costs 0 rather than being excluded, so a dependency that
 * did not run in this run can still LINK two that did.
 */
export function criticalLane(
  deps: ReadonlyMap<number, readonly number[]>,
  durations: ReadonlyMap<number, number>,
): { phases: number[]; ms: number } {
  const dependents = new Map<number, number[]>();
  const all = new Set<number>([...deps.keys(), ...durations.keys()]);
  for (const [phase, list] of deps) for (const dep of list) all.add(dep);
  for (const phase of all) dependents.set(phase, []);
  for (const [phase, list] of deps) {
    for (const dep of list) if (dependents.has(dep)) dependents.get(dep)!.push(phase);
  }

  const best = new Map<number, { ms: number; path: number[] }>();
  const walk = (phase: number, seen: Set<number>): { ms: number; path: number[] } => {
    const cached = best.get(phase);
    if (cached) return cached;
    if (seen.has(phase)) return { ms: 0, path: [] };      // a cycle is lint's business, not a hang
    const own = durations.get(phase) ?? 0;
    let winner = { ms: own, path: [phase] };
    for (const next of dependents.get(phase) ?? []) {
      const sub = walk(next, new Set([...seen, phase]));
      if (own + sub.ms > winner.ms) winner = { ms: own + sub.ms, path: [phase, ...sub.path] };
    }
    best.set(phase, winner);
    return winner;
  };

  let overall = { ms: 0, path: [] as number[] };
  for (const phase of [...all].sort((a, b) => a - b)) {
    const candidate = walk(phase, new Set());
    if (candidate.ms > overall.ms) overall = candidate;
  }
  // A chain of one phase that never ran is not a critical path.
  return overall.ms > 0 ? { phases: overall.path, ms: overall.ms } : { phases: [], ms: 0 };
}

/* ------------------------------------------------------------------ *
 * Attempts, and what changed between two of them
 * ------------------------------------------------------------------ */

/** One §Verification command's result, as the journal recorded it. */
export type AttemptVerification = { command: string; ok: boolean; code: number; ms: number };

export type AttemptSummary = {
  phase: number;
  /** 1-based boarding index within this journal. */
  attempt: number;
  startedAt: string;
  /** `null` while the boarding is still in the lane. */
  endedAt: string | null;
  durationMs: number;
  /**
   * How the boarding left the lane: the terminal event's own name (`done`,
   * `failed`, `gated`, …), `parked` for a boarding that filed a wait, or
   * `open` for one still running. Never invented — `open` is a fact about the
   * journal, not a guess about the phase.
   */
  outcome: string;
  model: string | null;
  effort: string | null;
  /**
   * What THIS boarding spent, summed from its own `phase.session` entries.
   * `null` means no session entry was recorded inside it — a boarding that
   * parked at the gate or died before the CLI reported, which is a different
   * statement from `$0`.
   */
  costUsd: number | null;
  turns: number | null;
  /** How many sessions ran inside the boarding (the inner retry loop). */
  sessions: number;
  /** Ladder rungs climbed during this boarding, in order. */
  rungs: string[];
  /** The verdict that stood — the LAST verification inside the boarding. */
  verification: {
    ok: boolean;
    reason: string | null;
    cwd: string | null;
    ran: AttemptVerification[];
    notRun: number;
    skipped: number;
  } | null;
  /** The session's closing words, when it left any. */
  said: string | null;
};

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/**
 * A phase's boardings, oldest first.
 *
 * A boarding runs from its `phase.start` to whichever comes first: a terminal
 * event, a park, or the next `phase.start`. That last clause is what makes the
 * function total — a journal whose tail was cut mid-boarding still yields a
 * well-formed list, with the unfinished one marked `open`.
 */
export function attemptsOf(entries: readonly JournalEntry[], phase: number): AttemptSummary[] {
  const mine = entries.filter((entry) => entry.phase === phase && Number.isFinite(timeOf(entry)));
  const out: AttemptSummary[] = [];
  let current: AttemptSummary | null = null;
  let cost = 0;
  let turns = 0;
  let sawSession = false;
  /**
   * Rungs journalled while no boarding is open.
   *
   * The ladder CHOOSES a rung and then boards — `phase.rung` lands just before
   * the `phase.start` it caused. Attributing rungs only to an already-open
   * boarding therefore drops exactly the interesting one: the rung that
   * produced the attempt you are looking at. So a rung with no boarding open
   * is held and attaches to the next one.
   */
  let pending: string[] = [];

  const settle = (endedAt: string | null, outcome: string): void => {
    if (!current) return;
    current.endedAt = endedAt;
    current.outcome = outcome;
    current.durationMs = endedAt
      ? Math.max(0, Date.parse(endedAt) - Date.parse(current.startedAt))
      : current.durationMs;
    current.costUsd = sawSession ? cost : null;
    current.turns = sawSession ? turns : null;
    out.push(current);
    current = null;
  };

  for (const entry of mine) {
    if (entry.event === BOARD) {
      // A boarding with no terminal event ran until this one displaced it.
      settle(entry.time, 'superseded');
      cost = 0; turns = 0; sawSession = false;
      current = {
        phase,
        attempt: out.length + 1,
        startedAt: entry.time,
        endedAt: null,
        durationMs: 0,
        outcome: 'open',
        model: str(entry.data?.model),
        effort: str(entry.data?.effort),
        costUsd: null,
        turns: null,
        sessions: 0,
        rungs: pending,
        verification: null,
        said: null,
      };
      // The new boarding OWNS the held rungs — rebind rather than clear, since
      // the array above is the same reference the attempt now carries.
      pending = [];
      continue;
    }
    if (!current) {
      // The one entry that matters between boardings: see `pending` above.
      if (entry.event === 'phase.rung') {
        const rung = str(entry.data?.rung);
        if (rung) pending.push(rung);
      }
      continue;                                   // everything else is traffic we cannot place
    }

    if (entry.event === 'phase.session') {
      sawSession = true;
      current.sessions++;
      cost += num(entry.data?.costUsd) ?? 0;
      turns += num(entry.data?.turns) ?? 0;
      current.said = str(entry.data?.said) ?? current.said;
      current.model = str(entry.data?.model) ?? current.model;
      current.effort = str(entry.data?.effort) ?? current.effort;
      continue;
    }

    if (entry.event === 'phase.rung') {
      const rung = str(entry.data?.rung);
      if (rung) current.rungs.push(rung);
      continue;
    }

    if (entry.event === VERIFY_END) {
      const ran = Array.isArray(entry.data?.ran) ? entry.data.ran as Record<string, unknown>[] : [];
      current.verification = {
        ok: entry.data?.ok === true,
        reason: str(entry.data?.reason),
        cwd: str(entry.data?.cwd),
        ran: ran.map((row) => ({
          command: String(row.command ?? ''),
          // The journal records the exit code, not a verdict — 0 IS the verdict.
          ok: num(row.code) === 0,
          code: num(row.code) ?? -1,
          ms: num(row.ms) ?? 0,
        })),
        notRun: Array.isArray(entry.data?.notRun) ? entry.data.notRun.length : 0,
        skipped: Array.isArray(entry.data?.skipped) ? entry.data.skipped.length : 0,
      };
      continue;
    }

    if (PARK_START.has(entry.event)) { settle(entry.time, 'parked'); continue; }
    if (TERMINAL.has(entry.event)) { settle(entry.time, entry.event.replace(/^phase\./, '')); continue; }
  }

  // Whatever is still running is reported as running, with the clock it has.
  if (current) {
    const last = mine.at(-1);
    current.durationMs = last ? Math.max(0, timeOf(last) - Date.parse(current.startedAt)) : 0;
    current.costUsd = sawSession ? cost : null;
    current.turns = sawSession ? turns : null;
    out.push(current);
  }
  return out;
}

/** How one command's result moved between two attempts. */
export type VerificationFlip = {
  command: string;
  from: 'pass' | 'fail' | 'absent';
  to: 'pass' | 'fail' | 'absent';
  fromCode: number | null;
  toCode: number | null;
  fromMs: number | null;
  toMs: number | null;
};

export type AttemptComparison = {
  phase: number;
  from: number;
  to: number;
  outcome: { from: string; to: string; changed: boolean };
  model: { from: string | null; to: string | null; changed: boolean };
  verification: {
    from: boolean | null;
    to: boolean | null;
    /** Only commands whose RESULT moved — the point of the comparison. */
    flips: VerificationFlip[];
    /** Commands that ran in both and did the same thing. */
    unchanged: number;
  };
  rungs: { from: string[]; to: string[] };
  durationMs: { from: number; to: number; deltaMs: number };
  /** `deltaUsd` is `null` when either side has no figure — never 0 by default. */
  costUsd: { from: number | null; to: number | null; deltaUsd: number | null };
  turns: { from: number | null; to: number | null };
};

const verdictOf = (run: AttemptVerification | undefined): 'pass' | 'fail' | 'absent' =>
  run === undefined ? 'absent' : run.ok ? 'pass' : 'fail';

/**
 * What changed between two boardings of one phase.
 *
 * The comparison is by COMMAND, not by index: a phase whose §Verification
 * gained or lost a command between attempts would otherwise line up
 * `npm test` against `npm run lint` and report both as flipped. A command
 * present on one side only is a flip to/from `absent`, which is a real and
 * frequently interesting change — it is what a repaired §Verification looks
 * like.
 */
export function compareAttempts(from: AttemptSummary, to: AttemptSummary): AttemptComparison {
  const left = new Map((from.verification?.ran ?? []).map((run) => [run.command, run]));
  const right = new Map((to.verification?.ran ?? []).map((run) => [run.command, run]));
  const commands = [...new Set([...left.keys(), ...right.keys()])].sort();

  const flips: VerificationFlip[] = [];
  let unchanged = 0;
  for (const command of commands) {
    const a = left.get(command);
    const b = right.get(command);
    const before = verdictOf(a);
    const after = verdictOf(b);
    if (before === after) { unchanged++; continue; }
    flips.push({
      command,
      from: before, to: after,
      fromCode: a ? a.code : null, toCode: b ? b.code : null,
      fromMs: a ? a.ms : null, toMs: b ? b.ms : null,
    });
  }

  return {
    phase: to.phase,
    from: from.attempt,
    to: to.attempt,
    outcome: { from: from.outcome, to: to.outcome, changed: from.outcome !== to.outcome },
    model: { from: from.model, to: to.model, changed: from.model !== to.model },
    verification: {
      from: from.verification ? from.verification.ok : null,
      to: to.verification ? to.verification.ok : null,
      flips,
      unchanged,
    },
    rungs: { from: from.rungs, to: to.rungs },
    durationMs: { from: from.durationMs, to: to.durationMs, deltaMs: to.durationMs - from.durationMs },
    costUsd: {
      from: from.costUsd, to: to.costUsd,
      deltaUsd: from.costUsd === null || to.costUsd === null ? null : to.costUsd - from.costUsd,
    },
    turns: { from: from.turns, to: to.turns },
  };
}

/** Every consecutive pair, which is the comparison an operator actually reads. */
export function compareConsecutive(attempts: readonly AttemptSummary[]): AttemptComparison[] {
  const out: AttemptComparison[] = [];
  for (let i = 1; i < attempts.length; i++) out.push(compareAttempts(attempts[i - 1]!, attempts[i]!));
  return out;
}
