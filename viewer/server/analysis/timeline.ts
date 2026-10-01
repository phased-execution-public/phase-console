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
 * ## Every bar is held to a journal line
 *
 * Nothing here is modelled. A bar opens on an event and closes on an event —
 * or, for the two things the runner journals only when they END, it is
 * measured back from that line's own clock: a `working` bar is a session, from
 * `phase.session`'s time back its `ms`, and an automatic `verifying` bar is the
 * verdict, from `phase.verify`'s time back the sum of its commands' `ms`. A
 * bracketed guess (an opener to a closer) stands only where no measurement
 * does — a session still running, or a journal from before `ms` existed.
 *
 * Until control-tower phase 61 (#76) everything between a boarding and a
 * terminal line was `working`, so a phase settled by reconcile, a halted,
 * parked or stopped run and every automatic proof were drawn as work — 903
 * hours of it on hub against 134 hours of sessions. Now queueing, a run that
 * was down (with its cause) and verification are drawn as themselves, and a
 * stretch nothing claims is a gap: the phase was in nobody's hands.
 *
 * One exception is stated rather than hidden: a bar still open when the
 * journal ends is closed at the horizon and flagged `open`, which the client
 * draws hatched. That is the difference between "this phase worked for 40
 * minutes" and "this phase has been working for 40 minutes so far", and a
 * Gantt that cannot tell them apart is worse than no Gantt.
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
 * Since control-tower phase 89 (#130) a boarding ends when its SESSION does —
 * a declared `partial`, `blocked`, `needs-human` or `waiting-external`, or a
 * phase-level halt, ends it at the session's end rather than leaving it open
 * for the next boarding to settle across the queue wait — and it carries the
 * phase-wide number its first session took: `phase.start`'s `attempt`, the
 * number `phase.session`, `phase.tokens` and `record.attempts` carry. A
 * boarding whose inner loop spawned twice is followed by attempt 3.
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
import { PHASE_WORK_MODES } from '../../shared/phase-clocks.js';
import type { OutcomeStatus } from '../../shared/run-lifecycle.js';

/* ------------------------------------------------------------------ *
 * The shapes the client draws
 * ------------------------------------------------------------------ */

/**
 * What a lane was doing. Six states, because they have six different fixes.
 *
 * `working` is a SESSION — a `claude -p` child that was running — and nothing
 * else (control-tower phase 61, #76): the audit replayed hub's journals through
 * the four-state projection and drew 903 working hours against 134 hours of
 * sessions, because the time a phase spent queued, parked, proved, or held by a
 * run that had gone down was all painted as work. `queued` is a queue episode,
 * `down` the run itself stopped (halted, parked, paused, stopped, shut down)
 * while this phase was in flight, with its cause on the bar's `note`, and
 * `verifying` every §Verification — the automatic one too, measured from the
 * verdict's own commands.
 */
export type BarKind = 'working' | 'verifying' | 'queued' | 'waiting' | 'down' | 'frozen';

export const BAR_KINDS: readonly BarKind[] = ['working', 'verifying', 'queued', 'waiting', 'down', 'frozen'];

export type TimelineBar = {
  kind: BarKind;
  /** Milliseconds since the run's first entry — the client does no date maths. */
  startMs: number;
  endMs: number;
  /** Which boarding this belongs to, 1-based. `0` = before any boarding was seen. */
  attempt: number;
  /** Still open when the journal ends: drawn hatched, never as a finished bar. */
  open: boolean;
  /** Why — a `down` bar's cause (`halted: plan-lint`, `stopped by operator`). */
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
  | 'start'
  // Control-tower phase 96 (#142): a person's note — on its phase's lane when
  // that phase has one on this run, else on the axis.
  | 'note';

/**
 * The mark vocabulary, as a value.
 *
 * Exported for the same reason `REVIEW_VERDICTS` is: the guide documents these
 * names, and a doc that lists five of six glyphs is worse than one that lists
 * none. `docs-parity.test.ts` holds the two to each other.
 */
export const MARK_KINDS: readonly MarkKind[] = [
  'board', 'verify', 'rung', 'park', 'wall', 'outcome', 'session', 'ask', 'policy', 'start', 'note',
];

/** A session's ending — its one `phase.session` line (zero-touch phase 4's shape). */
const SESSION_END = 'phase.session';

/** What a session's calls cost in context — the series' other half. */
const TOKENS = 'phase.tokens';

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

/** A person's note on the run or one of its phases (control-tower phase 96). */
const RUN_NOTE = 'run.note';

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
  queuedMs: number;
  waitingMs: number;
  downMs: number;
  frozenMs: number;
  /**
   * Session and verification time on CLOSED bars — what this phase measurably
   * took, and the only weight the critical path is allowed (#76). An open bar
   * is a claim still being made, not a measurement.
   */
  measuredMs: number;
  attempts: number;
  /** The journal's tail cut this lane's opening off — bars begin mid-flight. */
  partial: boolean;
  /** On the measured critical path. */
  critical: boolean;
};

/**
 * One value over one attempt window, on the SAME axis as the bars.
 *
 * The question an operator has at minute 40 of a phase — *is this one burning
 * faster than the last three?* — had no picture anywhere: the Gantt answers
 * "when did each phase hold the lane" and nothing answers "what did it cost to
 * hold it". Both facts were already journalled; only the axis was missing.
 */
export type TimelineSeriesPoint = {
  phase: number;
  /** The boarding this window is, 1-based — the same number `TimelineBar.attempt` carries. */
  attempt: number;
  /** Milliseconds from the axis's left edge, so the client does no date maths. */
  startMs: number;
  endMs: number;
  value: number;
  /** The window is still open: `value` is what it has spent SO FAR. */
  open: boolean;
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
  /** Phases on the longest dependency chain, weighted by each lane's `measuredMs`. */
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
  /**
   * Cost and context on the bars' own axis, one point per attempt window.
   *
   * `cost` sums the `phase.session` entries inside each window — the one event
   * carrying an attempt's OWN dollars rather than the phase's running total —
   * and `tokens` takes the peak context any session in it reached. An OPEN
   * window is the live lane's figure rather than the journal's, because the
   * journal only learns what a session spent when it ends, and "$0.00 so far"
   * about a session that has been working for forty minutes is the one reading
   * that is certainly wrong.
   */
  series: { cost: TimelineSeriesPoint[]; tokens: TimelineSeriesPoint[] };
  /**
   * ISO — when this projection was taken.
   *
   * The axis is honest about its right edge (`horizonAt`) and was not honest
   * about its own age: a cached or slow answer drew "now" wherever the reader
   * assumed it was. A series that moves needs a stamp that moves with it.
   */
  asOf: string;
};

/* ------------------------------------------------------------------ *
 * The event vocabulary
 *
 * Named as sets rather than a switch so a new runner event shows up in
 * `unmapped` instead of silently changing a bar's meaning.
 * ------------------------------------------------------------------ */

/** Opens a boarding. */
const BOARD = 'phase.start';

/**
 * Ends a boarding, and with it whatever bar was open. `phase.verification-failed`
 * is the attempt a red FINAL verdict re-opened (control-tower phase 62, #68):
 * the phase is not done and boards again for its fix, but THIS boarding ended
 * red, exactly as `phase.failed` ends one.
 */
const TERMINAL = new Set([
  'phase.done', 'phase.failed', 'phase.stopped', 'phase.skip', 'phase.gated', 'phase.not-started',
  'phase.verification-failed',
]);

/**
 * A settle the BOARD vouches for: the record was corrected against it (#76).
 * Terminal like the six above — before phase 61 it was not, so a phase closed
 * by reconcile kept its bar open and growing to "now" (tfar P1: 71 hours drawn
 * for a 51-minute phase).
 */
const RECONCILED = 'phase.reconciled';

/** The phase is parked on something outside itself. */
const PARK_START = new Set([
  'phase.waiting', 'phase.mcp-preflight-parked', 'phase.verify-preflight-parked',
  // A §Verification its clock cut twice parks for a person (control-tower
  // phase 83, #95) — parked on its verification, like the preflight's park.
  'phase.verify-timeout',
]);

/** A session starts again: a parked phase boards, a `--resume`, a closeout. */
const PARK_END = new Set(['phase.wait-resume', 'phase.resume', 'phase.closeout']);

/**
 * The person-check path's verification: `awaiting-verification` opens it,
 * `verify` closes it. The AUTOMATIC one has no opener — the runner writes only
 * its verdict — so it is measured back from the verdict's own commands.
 */
const VERIFY_START = 'phase.awaiting-verification';
const VERIFY_END = 'phase.verify';

/**
 * A queue episode (control-tower phase 60): `phase.queued` opens it and
 * `phase.queue-closed` ends it — where it was last seen, for a `restarted`
 * close. `phase.admitted` ends one too, for journals written before the close
 * line existed.
 */
const QUEUE_OPEN = 'phase.queued';
const QUEUE_CLOSE = 'phase.queue-closed';
const ADMITTED = 'phase.admitted';

/**
 * Where a queue episode ended. A `restarted` close is written by the NEXT
 * console, so the episode ended where it was last seen waiting — `since` +
 * `ms` — not at that boot. `openedMs` and `closedMs` are on the axis `t0`
 * measures from (absolute when it is 0).
 */
function queueEndMs(entry: JournalEntry, openedMs: number, closedMs: number, t0 = 0): number {
  if (entry.data?.outcome !== 'restarted') return closedMs;
  const since = Date.parse(String(entry.data.since ?? ''));
  const ms = num(entry.data.ms);
  return Number.isFinite(since) && ms !== null ? Math.min(closedMs, Math.max(openedMs, since - t0 + ms)) : closedMs;
}

/**
 * A session's declared outcome, journalled when the runner reads it — and
 * the declared statuses that END the boarding it was declared in (control-
 * tower phase 89, #130). The session said how it stopped; what the console
 * does next — a park, a queue, the wrap-up's fresh boarding, a halt — happens
 * after the boarding. Before this they ended nothing, so a boarding that
 * declared `partial` or `blocked` stayed `open` until the NEXT `phase.start`
 * settled it `superseded` at that boarding's time: hub's P43 read 5 h 43 min
 * for a 57-minute session. `complete` and `no-defect` are deliberately absent —
 * after either the console's §Verification still runs inside the boarding, and
 * `phase.done` or `phase.verification-failed` ends it.
 */
const DECLARED = 'phase.outcome';
const DECLARED_ENDS: ReadonlySet<string> = new Set<OutcomeStatus>(['partial', 'blocked', 'needs-human', 'waiting-external']);

/**
 * A phase-level stop (`Runner.settlePhase`). It ends a BOARDING (`attemptsOf`)
 * and nothing on the lane: the lane is the phase's time on the run, and after
 * a halt it goes on drawing what the run does with the phase — the run going
 * down with it, its queue, its next boarding.
 */
const HALTED = 'phase.halted';

/**
 * How a boarding ended when its SESSION's ending is what ended it (#130): a
 * declared status from `DECLARED_ENDS` names itself, and `phase.halted` is
 * `halted`. Null for every other line — and for a declaration read from the
 * ARMED outcome file (`via: 'armed-file'`), which speaks for an EARLIER
 * session and is journalled when the next spawn arms the file, inside the
 * boarding after the one it is about.
 */
function sessionEnding(entry: JournalEntry): string | null {
  if (entry.event === HALTED) return 'halted';
  if (entry.event !== DECLARED || entry.data?.via === 'armed-file') return null;
  const status = entry.data?.status;
  return typeof status === 'string' && DECLARED_ENDS.has(status) ? status : null;
}

/**
 * The run went DOWN: nothing it holds moves until a start lifts it. Written by
 * the run, not by a lane — so each takes down every lane in flight, and each
 * lane keeps the first cause it was taken down by. (`run.waiting-external` and
 * a `run.parked` can name a phase; the run is down all the same.)
 */
const STOP_REQUESTED = 'run.stop-requested';
const RUN_DOWN = new Set([
  'run.halt', 'run.parked', 'run.paused', STOP_REQUESTED, 'run.console-shutdown', 'run.waiting-external',
]);

/** The run came back up: a start of it, or a wait clock resuming it. */
const RUN_UP = new Set([RUN_START, 'run.limit-resume']);

/**
 * The session modes that are a phase's WORK — every mode but the pull-request
 * session, which opens the run's pull request and is anchored on a phase only
 * because every session needs one (phase 58's rule, from its one owner).
 */
const WORK_MODES: ReadonlySet<string> = new Set(PHASE_WORK_MODES);

/**
 * Where two claims about one stretch of a lane overlap, the stronger paints it.
 *
 * A freeze outranks a session because a stopped process is not working; a
 * session outranks everything the run or the queue says, because it is the
 * one measured fact — a stop that reaches a session still running does not
 * end its work until the session says it ended; and a declared park outranks
 * the run being down, because the phase's own reason is the truer one.
 */
const PRIORITY: Record<BarKind, number> = { frozen: 6, working: 5, verifying: 4, queued: 3, waiting: 2, down: 1 };

/** A lane's own kinds — what an ATTEMPT window spans. Queueing and down time belong to no boarding's bill. */
const ATTEMPT_KINDS: ReadonlySet<BarKind> = new Set<BarKind>(['working', 'verifying', 'waiting', 'frozen']);

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
 *
 * `phase.serial-behind` is the third (control-tower phase 61): a phase behind
 * a live lane of its OWN run is ready, not queued — phase 60 made that the
 * rule — so its stretch is deliberately no bar at all, never a `queued` one.
 */
export const KNOWN_NO_BAR = new Set([
  'phase.resources', 'phase.suspect', 'phase.serial-behind',
  // A person's bump of a queued phase and press of Resume (control-tower phase
  // 96): acts with an author and a why, which the journal reader shows; the
  // queue episode and the boarding they lead to are what the bars draw.
  'phase.queue-bumped', 'phase.resume-pressed',
  // Notes on a verification the `phase.verify` line already draws, and a hold
  // on a phase that has not boarded (control-tower phase 62).
  'phase.verify-proven', 'phase.verify-disagreed', 'phase.verification-held',
  // The baseline a phase took at boarding, the reds it inherited from it and
  // what their owners owe (control-tower phase 83, #103): notes on the
  // verification, not stretches.
  'phase.verify-baseline', 'phase.verify-inherited', 'phase.verify-owed',
  // What became of the run once a rung fixed this phase (control-tower phase
  // 81, #105): a continue is drawn by the `run.start` that follows it, and a
  // park by the run's own stop — the line itself is the decision's reason.
  'run.recovery-continue', 'run.recovery-parked',
  // The wrap-up's fast gate on the committed WIP and a verification run in
  // place (control-tower phase 89): notes on a verification, not stretches.
  'phase.wip-gate', 'phase.verify-in-place',
]);

/* ------------------------------------------------------------------ *
 * Projection
 * ------------------------------------------------------------------ */

const timeOf = (entry: JournalEntry): number => Date.parse(entry.time);

/**
 * One claim about a stretch of a lane. Claims may overlap — a stop lands while
 * a session is still running, a freeze lands inside one — and `paint` settles
 * each stretch by `PRIORITY`, so the projection never has to guess an order.
 */
type Span = {
  kind: BarKind;
  startMs: number;
  endMs: number;
  attempt: number;
  open: boolean;
  note?: string;
  /**
   * A `working` stretch bracketed by an opener and a closer rather than
   * measured: the only evidence for a session still running, or for one a
   * journal from before `phase.session` carried `ms`. A measured session it
   * overlaps REPLACES it — the boarding's preflight is not the session.
   */
  provisional?: boolean;
};

/** One lane, mid-projection. */
type Building = {
  phase: number;
  spans: Span[];
  /** The one bracketed state open now: a session in flight, a person's proof, a park, a freeze. */
  ctx: { kind: BarKind; startMs: number; attempt: number } | null;
  /** A queue episode still open. Parallel to `ctx`: the painter decides what shows. */
  queue: { startMs: number; attempt: number } | null;
  /** The run is down with this lane in flight, since when and why. */
  down: { startMs: number; attempt: number; note: string } | null;
  attempt: number;
  /** Boarded and not yet settled — the lanes a run going down takes down with it. */
  inFlight: boolean;
  firstMs: number;
  lastMs: number;
  /**
   * Whether the first span this lane opened began at a boarding or a queue
   * line; `null` until one opens. Anything else first means the tail cut the
   * lane's beginning off.
   */
  began: boolean | null;
  /** Each attempt's settle, so its window ends where the phase left the lane. */
  settled: Map<number, number>;
};

/** Settles overlapping claims into bars: each stretch goes to its strongest claim. */
function paint(spans: readonly Span[]): TimelineBar[] {
  const cuts = [...new Set(spans.flatMap((span) => [span.startMs, span.endMs]))].sort((a, b) => a - b);
  const bars: TimelineBar[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const from = cuts[i]!;
    const to = cuts[i + 1]!;
    let best: Span | null = null;
    for (const span of spans) {
      if (span.startMs > from || span.endMs < to) continue;
      if (!best || PRIORITY[span.kind] > PRIORITY[best.kind]) best = span;
    }
    if (!best) continue;                           // a gap: nothing was claimed, so nothing is drawn
    const last = bars.at(-1);
    if (last && last.endMs === from && last.kind === best.kind && last.attempt === best.attempt
      && last.open === best.open && last.note === best.note) {
      last.endMs = to;
      continue;
    }
    bars.push({
      kind: best.kind, startMs: from, endMs: to, attempt: best.attempt, open: best.open,
      ...(best.note ? { note: best.note } : {}),
    });
  }
  return bars;
}

/** Why the run went down, in the words a bar's tooltip can carry. */
function downCause(entry: JournalEntry): string {
  const data = entry.data ?? {};
  const word = (key: string): string | null => {
    const value = data[key];
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null;
  };
  switch (entry.event) {
    case 'run.halt': return word('kind') ? `halted: ${word('kind')}` : 'halted';
    case 'run.parked': return word('reason') ? `parked: ${word('reason')}` : 'parked';
    case 'run.paused': return 'paused';
    case 'run.stop-requested': return word('by') ? `stopped by ${word('by')}` : 'stopped';
    case 'run.console-shutdown': return word('intent') ? `console shut down (${word('intent')})` : 'console shut down';
    default: return 'waiting on an outside clock';
  }
}

export type ProjectOptions = {
  /** The right edge for a run still going. Defaults to the last entry. */
  now?: number;
  /** Phase → its dependencies, for the critical path. Absent ⇒ no overlay. */
  deps?: ReadonlyMap<number, readonly number[]>;
  /** The read was a tail, not the whole file. */
  truncated?: boolean;
  /**
   * What the LIVE lanes report right now, for the open windows.
   *
   * The journal cannot answer for a session still running — `phase.session` is
   * written when one ENDS — so without this every open bar's cost point would
   * read zero for as long as the attempt lasts, which is exactly the minute an
   * operator is asking about.
   */
  live?: readonly { phase: number; spentUsd?: number; contextTokens?: number }[];
};

/**
 * The journal as lanes on one axis.
 *
 * Pure: entries in, projection out. Every timestamp in the result is derived
 * from an entry's own `time`, which is what makes exit criterion 1 checkable
 * — the bars can be held to the journal rather than to a second model of it.
 */
/**
 * Cost and context per attempt window, on the bars' own axis.
 *
 * Both facts were already in the journal and neither had a picture. `cost`
 * sums the `phase.session` entries that fall inside a window — the one event
 * carrying an attempt's OWN dollars, since `record.costUsd` accumulates across
 * attempts by design — and `tokens` takes the highest context any session in
 * it reached, because a window's peak is what says whether it was near the
 * wall and a mean says nothing at all.
 *
 * An OPEN window takes the live lane's figures instead. The journal learns
 * what a session spent when it ENDS, so an open window read from it alone is
 * always `$0.00`, which is the one number that is certainly wrong about a
 * session that has been working for forty minutes.
 */
type SeriesWindow = { phase: number; attempt: number; startMs: number; endMs: number; open: boolean };

/**
 * A lane's attempt windows: each boarding's own bars, ending where the phase
 * settled. Queued and down bars belong to no boarding's bill — a window drawn
 * across a thirty-hour stop would spread one attempt's dollars over the stop.
 */
function attemptWindows(lane: TimelineLane, settled: ReadonlyMap<number, number>): SeriesWindow[] {
  const byAttempt = new Map<number, SeriesWindow>();
  for (const bar of lane.bars) {
    if (!ATTEMPT_KINDS.has(bar.kind)) continue;
    const held = byAttempt.get(bar.attempt);
    if (held) {
      held.startMs = Math.min(held.startMs, bar.startMs);
      held.endMs = Math.max(held.endMs, bar.endMs);
      held.open = held.open || bar.open;
    } else {
      byAttempt.set(bar.attempt, {
        phase: lane.phase, attempt: bar.attempt, startMs: bar.startMs, endMs: bar.endMs, open: bar.open,
      });
    }
  }
  for (const window of byAttempt.values()) {
    const end = settled.get(window.attempt);
    if (end !== undefined && !window.open && end > window.endMs) window.endMs = end;
  }
  return [...byAttempt.values()];
}

function projectSeries(
  windows: SeriesWindow[],
  entries: readonly JournalEntry[],
  t0: number,
  live: readonly { phase: number; spentUsd?: number; contextTokens?: number }[],
): { cost: TimelineSeriesPoint[]; tokens: TimelineSeriesPoint[] } {
  type Window = SeriesWindow;
  windows.sort((a, b) => a.phase - b.phase || a.attempt - b.attempt);

  const find = (phase: number, atMs: number): Window | undefined =>
    windows.find((w) => w.phase === phase && atMs >= w.startMs && atMs <= w.endMs)
    // A session that ended a breath after its last bar still belongs to it.
    ?? [...windows].reverse().find((w) => w.phase === phase && atMs >= w.startMs);

  const cost = new Map<Window, number>();
  const tokens = new Map<Window, number>();
  for (const entry of entries) {
    const phase = typeof entry.phase === 'number' ? entry.phase : null;
    if (phase === null) continue;
    const atMs = timeOf(entry) - t0;
    if (!Number.isFinite(atMs)) continue;
    const window = find(phase, atMs);
    if (!window) continue;
    if (entry.event === SESSION_END) {
      const usd = (entry.data as { costUsd?: unknown } | undefined)?.costUsd;
      if (typeof usd === 'number' && Number.isFinite(usd)) {
        cost.set(window, (cost.get(window) ?? 0) + usd);
      }
    } else if (entry.event === TOKENS) {
      const data = entry.data as { peakContext?: unknown; lastContext?: unknown } | undefined;
      const peak = typeof data?.peakContext === 'number' ? data.peakContext
        : typeof data?.lastContext === 'number' ? data.lastContext : null;
      if (peak !== null && Number.isFinite(peak)) {
        tokens.set(window, Math.max(tokens.get(window) ?? 0, peak));
      }
    }
  }

  const liveFor = new Map(live.map((lane) => [lane.phase, lane]));
  const point = (window: Window, value: number): TimelineSeriesPoint => ({
    phase: window.phase, attempt: window.attempt,
    startMs: window.startMs, endMs: window.endMs, value, open: window.open,
  });

  return {
    cost: windows
      .map((window) => {
        const booked = cost.get(window) ?? 0;
        const now = window.open ? liveFor.get(window.phase)?.spentUsd : undefined;
        return point(window, typeof now === 'number' ? booked + now : booked);
      })
      .filter((p) => p.value > 0 || p.open),
    tokens: windows
      .map((window) => {
        const seen = tokens.get(window) ?? 0;
        const now = window.open ? liveFor.get(window.phase)?.contextTokens : undefined;
        return point(window, typeof now === 'number' ? Math.max(seen, now) : seen);
      })
      .filter((p) => p.value > 0 || p.open),
  };
}

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
      series: { cost: [], tokens: [] }, asOf: at,
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
  const phaseNotes: TimelineMark[] = [];
  const marks: TimelineMark[] = [];
  let unmapped = 0;

  const laneOf = (phase: number, atMs: number): Building => {
    let lane = lanes.get(phase);
    if (!lane) {
      lane = {
        phase, spans: [], ctx: null, queue: null, down: null, attempt: 0, inFlight: false,
        firstMs: atMs, lastMs: atMs, began: null, settled: new Map(),
      };
      lanes.set(phase, lane);
    }
    return lane;
  };

  /** Record a claim, discarding a zero-width one nobody can see. */
  const claim = (lane: Building, span: Span): void => {
    if (span.endMs > span.startMs) lane.spans.push(span);
  };

  /** The first span a lane opens says whether we saw its beginning. */
  const begin = (lane: Building, clean: boolean): void => {
    if (lane.began === null) lane.began = clean;
  };

  const closeCtx = (lane: Building, atMs: number, open = false): void => {
    if (!lane.ctx) return;
    const { kind, startMs, attempt } = lane.ctx;
    claim(lane, { kind, startMs, endMs: Math.max(startMs, atMs), attempt, open, ...(kind === 'working' ? { provisional: true } : {}) });
    lane.ctx = null;
  };

  const openCtx = (lane: Building, kind: BarKind, atMs: number, clean = false): void => {
    begin(lane, clean);
    closeCtx(lane, atMs);
    lane.ctx = { kind, startMs: atMs, attempt: lane.attempt };
  };

  const closeQueue = (lane: Building, atMs: number, open = false): void => {
    if (!lane.queue) return;
    const { startMs, attempt } = lane.queue;
    claim(lane, { kind: 'queued', startMs, endMs: Math.max(startMs, atMs), attempt, open });
    lane.queue = null;
  };

  const closeDown = (lane: Building, atMs: number, open = false): void => {
    if (!lane.down) return;
    const { startMs, attempt, note } = lane.down;
    claim(lane, { kind: 'down', startMs, endMs: Math.max(startMs, atMs), attempt, open, note });
    lane.down = null;
  };

  /** The phase left the lane: everything it held ends here. */
  const settle = (lane: Building, atMs: number): void => {
    closeCtx(lane, atMs);
    closeQueue(lane, atMs);
    closeDown(lane, atMs);
    lane.inFlight = false;
    lane.settled.set(lane.attempt, atMs);
  };

  for (const entry of usable) {
    const atMs = timeOf(entry) - t0;
    const phase = typeof entry.phase === 'number' ? entry.phase : undefined;

    if (RUN_DOWN.has(entry.event)) {
      // The run is down, and every lane still in the air goes down with it —
      // under the FIRST cause, since a park that follows a halt did not take
      // anything down that was still up. A queue is withdrawn (phase 60 writes
      // the close line too; whichever lands first closes it).
      const note = downCause(entry);
      for (const lane of lanes.values()) {
        if (!lane.inFlight && !lane.queue && !lane.ctx) continue;
        closeQueue(lane, atMs);
        // A stop ends a frozen child too — continued and then killed — so its
        // freeze ends here, not whenever somebody next looks at the run.
        if (entry.event === STOP_REQUESTED && lane.ctx?.kind === 'frozen') closeCtx(lane, atMs);
        lane.down ??= { startMs: atMs, attempt: lane.attempt, note };
      }
      continue;
    }

    if (RUN_UP.has(entry.event)) {
      for (const lane of lanes.values()) {
        // A session a previous console never reported: a new START proves that
        // console's loop is gone, and the lane's last line is the last moment
        // anything saw it alive. It ended there, and the run was down until now.
        if (entry.event === RUN_START && lane.ctx && (lane.ctx.kind === 'working' || lane.ctx.kind === 'verifying')) {
          const seen = Math.max(lane.ctx.startMs, Math.min(lane.lastMs, atMs));
          closeCtx(lane, seen);
          if (seen < atMs) lane.down ??= { startMs: seen, attempt: lane.attempt, note: 'no console' };
        }
        closeDown(lane, atMs);
      }
      if (entry.event !== RUN_START) continue;
    }

    if (entry.event === RUN_NOTE) {
      // A note is a tick, never a bar, and never a reason to open a lane: a
      // note about a phase that has not boarded on this run would otherwise
      // invent one. Where it is drawn is decided once every lane is known.
      const data = entry.data ?? {};
      const by = typeof data.by === 'string' && data.by ? data.by : 'operator';
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      const mark: TimelineMark = {
        kind: 'note', atMs, label: `${data.pinned === true ? 'pinned · ' : ''}${by}: ${text}`.slice(0, 160),
        ...(phase !== undefined ? { phase } : {}),
      };
      marks.push(mark);
      if (phase !== undefined) phaseNotes.push(mark);
      continue;
    }

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
      // A boarding ends a park, a queue and a down stretch as well as any stale
      // bar: the phase is running again, whatever it was doing before.
      closeQueue(lane, atMs);
      closeDown(lane, atMs);
      lane.attempt++;
      lane.inFlight = true;
      openCtx(lane, 'working', atMs, true);
      marks.push({ kind: 'board', atMs, phase, label: labelOf(entry, `attempt ${lane.attempt}`) });
      continue;
    }

    if (entry.event === QUEUE_OPEN) {
      // A re-sighting of the same episode keeps the entry it already has.
      begin(lane, true);
      lane.queue ??= { startMs: atMs, attempt: lane.attempt };
      continue;
    }

    if (entry.event === QUEUE_CLOSE || entry.event === ADMITTED) {
      // A `restarted` close is written by the NEXT console: the episode ended
      // where it was last seen waiting, `since` + `ms`, not at that boot.
      closeQueue(lane, lane.queue ? queueEndMs(entry, lane.queue.startMs, atMs, t0) : atMs);
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
      // …and the bar (#76): a session IS the work, and its line says exactly
      // when it ended and how long it ran. The bracket its opener started is
      // replaced, not extended — the boarding's preflight was not the session.
      if (typeof data.mode === 'string' && !WORK_MODES.has(data.mode)) continue;
      const ms = num(data.ms);
      if (ms !== null && ms > 0) {
        begin(lane, false);
        if (lane.ctx?.kind === 'working') lane.ctx = null;
        claim(lane, { kind: 'working', startMs: Math.max(0, atMs - ms), endMs: atMs, attempt: lane.attempt, open: false });
      } else if (lane.ctx?.kind === 'working') {
        // A line from before `ms` was journalled: the bracket is all there is.
        closeCtx(lane, atMs);
      }
      continue;
    }

    if (entry.event === VERIFY_START) { openCtx(lane, 'verifying', atMs); continue; }

    if (entry.event === VERIFY_END) {
      if (lane.ctx?.kind === 'verifying') {
        closeCtx(lane, atMs);
      } else {
        // The automatic proof: the runner writes only its verdict, and the
        // verdict carries every command's own time. They ran one after another
        // and ended here, so that is where the bar goes. Nothing reopens after
        // it — the session that wrote the handoff had already ended.
        const ran = Array.isArray(entry.data?.ran) ? entry.data.ran as Record<string, unknown>[] : [];
        const spent = ran.reduce((total, row) => total + Math.max(0, num(row?.ms) ?? 0), 0);
        const fromMs = Math.max(0, atMs - spent);
        if (lane.ctx?.kind === 'working') closeCtx(lane, fromMs);
        if (spent > 0) {
          begin(lane, false);
          claim(lane, { kind: 'verifying', startMs: fromMs, endMs: atMs, attempt: lane.attempt, open: false });
        }
      }
      const ok = entry.data?.ok === true;
      marks.push({ kind: 'verify', atMs, phase, ok, label: ok ? 'verification passed' : 'verification failed' });
      continue;
    }

    if (PARK_START.has(entry.event)) {
      openCtx(lane, 'waiting', atMs);
      marks.push({ kind: 'park', atMs, phase, label: labelOf(entry, 'parked') });
      continue;
    }

    if (PARK_END.has(entry.event)) { closeDown(lane, atMs); openCtx(lane, 'working', atMs); continue; }

    if (entry.event === FREEZE_START) { openCtx(lane, 'frozen', atMs); continue; }

    if (entry.event === FREEZE_END) { openCtx(lane, 'working', atMs); continue; }

    if (TERMINAL.has(entry.event)) {
      settle(lane, atMs);
      marks.push({
        kind: 'outcome', atMs, phase,
        ok: entry.event === 'phase.done',
        label: entry.event.replace(/^phase\./, ''),
      });
      continue;
    }

    if (entry.event === RECONCILED) {
      settle(lane, atMs);
      const outcome = typeof entry.data?.outcome === 'string' ? entry.data.outcome : '';
      marks.push({ kind: 'outcome', atMs, phase, ok: outcome === 'done', label: `reconciled ${outcome}`.trim() });
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

  // A note about a phase with no lane on this run ticks the axis, and says
  // which phase it was about.
  for (const mark of phaseNotes) {
    if (mark.phase === undefined || lanes.has(mark.phase)) continue;
    mark.label = `phase ${mark.phase} · ${mark.label}`.slice(0, 160);
    delete mark.phase;
  }

  const windows: SeriesWindow[] = [];
  const built: TimelineLane[] = [...lanes.values()]
    .map((lane) => {
      // Whatever is still open when the journal ends is open, not finished.
      const horizonMs = horizon - t0;
      closeCtx(lane, horizonMs, true);
      closeQueue(lane, horizonMs, true);
      closeDown(lane, horizonMs, true);
      // A bracket a measured session overlaps was never the session's edge.
      const measured = lane.spans.filter((span) => span.kind === 'working' && !span.provisional);
      const bars = paint(lane.spans.filter((span) => !span.provisional
        || !measured.some((m) => m.startMs < span.endMs && span.startMs < m.endMs)));
      const sum = (kind: BarKind): number =>
        bars.filter((bar) => bar.kind === kind).reduce((total, bar) => total + (bar.endMs - bar.startMs), 0);
      const out: TimelineLane = {
        phase: lane.phase,
        bars,
        startMs: bars.length ? Math.min(...bars.map((bar) => bar.startMs)) : lane.firstMs,
        endMs: bars.length ? Math.max(...bars.map((bar) => bar.endMs)) : lane.lastMs,
        totalMs: bars.reduce((total, bar) => total + (bar.endMs - bar.startMs), 0),
        workingMs: sum('working'),
        verifyingMs: sum('verifying'),
        queuedMs: sum('queued'),
        waitingMs: sum('waiting'),
        downMs: sum('down'),
        frozenMs: sum('frozen'),
        measuredMs: bars
          .filter((bar) => !bar.open && (bar.kind === 'working' || bar.kind === 'verifying'))
          .reduce((total, bar) => total + (bar.endMs - bar.startMs), 0),
        attempts: lane.attempt,
        partial: lane.began !== true,
        critical: false,
      };
      windows.push(...attemptWindows(out, lane.settled));
      return out;
    })
    .sort((a, b) => a.phase - b.phase);

  // Weighted by what each phase measurably took (#76) — never by a bar left
  // open, which on a halted run nobody restarted would grow for as long as
  // anyone kept looking at it.
  const critical = options.deps
    ? criticalLane(options.deps, new Map(built.map((lane) => [lane.phase, lane.measuredMs])))
    : { phases: [], ms: 0 };
  const onPath = new Set(critical.phases);
  for (const lane of built) lane.critical = onPath.has(lane.phase);

  const series = projectSeries(windows, usable, t0, options.live ?? []);

  return {
    startedAt: new Date(t0).toISOString(),
    endedAt: finished ? new Date(lastMs).toISOString() : null,
    horizonAt: new Date(horizon).toISOString(),
    spanMs: Math.max(0, horizon - t0),
    lanes: built,
    marks: marks.sort((a, b) => a.atMs - b.atMs || (a.phase ?? 0) - (b.phase ?? 0)),
    criticalPath: critical.phases,
    criticalMs: critical.ms,
    series,
    asOf: new Date(options.now ?? lastMs).toISOString(),
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
  /**
   * The phase's attempt number: its `phase.start`'s `attempt` — the number its
   * first session takes, and the one `phase.session`, `phase.tokens` and
   * `record.attempts` carry (control-tower phase 89, #130). A journal written
   * before `phase.start` carried it numbers its boardings 1, 2, 3.
   */
  attempt: number;
  startedAt: string;
  /**
   * `null` while the boarding is still in the lane. A boarding its session's
   * own ending ended (#130) ended when that session did: its newest
   * `phase.session` line, or the verdict of a §Verification the console ran
   * after it — the instant the record's `attemptWindows` close on.
   */
  endedAt: string | null;
  /** The boarding's wall clock, less any time the phase spent queued inside it (#130). */
  durationMs: number;
  /**
   * How the boarding left the lane: the terminal event's own name (`done`,
   * `failed`, `gated`, …); the status its session declared when that ended
   * the work (`partial`, `blocked`, `needs-human`, `waiting-external`);
   * `halted` for a phase-level halt; `parked` for a boarding that filed a wait;
   * `superseded` for one the next boarding displaced with nothing ending it;
   * or `open` for one still running. Never invented — `open` is a fact about
   * the journal, not a guess about the phase.
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
    /** The trees that verdict read (`phase.verify` `trees`, phase 40) — its `{repo, branch, head}` line (phase 24, #41). */
    trees: { repo: string; branch: string | null; head: string | null; role?: string }[];
  } | null;
  /** The session's closing words, when it left any. */
  said: string | null;
};

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/**
 * A phase's boardings, oldest first.
 *
 * A boarding runs from its `phase.start` to whichever comes first: its
 * session's own ending (a declared status that stops the work, or a
 * phase-level halt — settled at the session's end, #130), a terminal event, a
 * park, or the next `phase.start`. That last clause is what makes the function
 * total — a journal whose tail was cut mid-boarding still yields a well-formed
 * list, with the unfinished one marked `open`. A boarding that has settled
 * stays settled: the lines between it and the next boarding (the resume the
 * wrap-up armed, the park after a declared wait, the halt after a declared
 * block) are not placed, and the next `phase.start` settles nothing.
 */
export function attemptsOf(entries: readonly JournalEntry[], phase: number): AttemptSummary[] {
  const mine = entries.filter((entry) => entry.phase === phase && Number.isFinite(timeOf(entry)));
  const out: AttemptSummary[] = [];
  let current: AttemptSummary | null = null;
  let cost = 0;
  let turns = 0;
  let sawSession = false;
  /** Where the open boarding's work last ended: its newest session, or a verdict after it. */
  let workEndedAt: string | null = null;
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
  /**
   * The phase's queue episodes — the ones the lane draws as `queued` bars —
   * and the one still open. Time spent queued is no attempt's (#130): a
   * boarding's clock is its wall time less every episode inside it.
   */
  const queued: { fromMs: number; toMs: number }[] = [];
  let queueFromMs: number | null = null;

  /** A boarding's clock over `[startedAt, toMs]`: the wall less the queue inside it, an open episode running to `toMs`. */
  const clockOf = (startedAt: string, toMs: number): number => {
    const fromMs = Date.parse(startedAt);
    const episodes = queueFromMs === null ? queued : [...queued, { fromMs: queueFromMs, toMs }];
    const waited = episodes.reduce((total, e) => total + Math.max(0, Math.min(e.toMs, toMs) - Math.max(e.fromMs, fromMs)), 0);
    return Math.max(0, toMs - fromMs - waited);
  };

  const settle = (endedAt: string | null, outcome: string): void => {
    if (!current) return;
    current.endedAt = endedAt;
    current.outcome = outcome;
    current.durationMs = endedAt ? clockOf(current.startedAt, Date.parse(endedAt)) : current.durationMs;
    current.costUsd = sawSession ? cost : null;
    current.turns = sawSession ? turns : null;
    out.push(current);
    current = null;
  };

  for (const entry of mine) {
    // A queue episode is the phase's, whether or not a boarding is open: it
    // opens before a boarding, between two, and — rarely — inside one.
    if (entry.event === QUEUE_OPEN) {
      queueFromMs ??= timeOf(entry);                // a re-sighting keeps the episode it has
      continue;
    }
    if (entry.event === QUEUE_CLOSE || entry.event === ADMITTED) {
      if (queueFromMs !== null) {
        queued.push({ fromMs: queueFromMs, toMs: queueEndMs(entry, queueFromMs, timeOf(entry)) });
        queueFromMs = null;
      }
      continue;
    }

    if (entry.event === BOARD) {
      // A boarding nothing ended ran until this one displaced it.
      settle(entry.time, 'superseded');
      // …and a boarding ends a queue, as it does on the lane.
      if (queueFromMs !== null) {
        queued.push({ fromMs: queueFromMs, toMs: timeOf(entry) });
        queueFromMs = null;
      }
      cost = 0; turns = 0; sawSession = false; workEndedAt = null;
      // The number the runner journalled (#130), else — a journal from before
      // it did — one past the boarding before.
      const numbered = num(entry.data?.attempt);
      current = {
        phase,
        attempt: numbered !== null && Number.isInteger(numbered) && numbered > 0 ? numbered : (out.at(-1)?.attempt ?? 0) + 1,
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
      workEndedAt = entry.time;
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
        trees: (Array.isArray(entry.data?.trees) ? entry.data.trees as Record<string, unknown>[] : [])
          .filter((tree) => typeof tree?.repo === 'string')
          .map((tree) => ({
            repo: String(tree.repo),
            branch: str(tree.branch),
            head: str(tree.head),
            ...(typeof tree.role === 'string' ? { role: tree.role } : {}),
          })),
      };
      // The console's §Verification runs inside the boarding, after its session.
      workEndedAt = entry.time;
      continue;
    }

    if (PARK_START.has(entry.event)) { settle(entry.time, 'parked'); continue; }
    if (TERMINAL.has(entry.event)) { settle(entry.time, entry.event.replace(/^phase\./, '')); continue; }
    // A settle the board vouches for ends the boarding like any terminal line (#76).
    if (entry.event === RECONCILED) { settle(entry.time, 'reconciled'); continue; }
    // The session's own ending (#130): a declared status that stops the work,
    // or a phase-level halt. Whichever lands first names the attempt — the
    // runner journals a declaration as it reads it, before it routes it, so
    // P50's `blocked` precedes the `phase.halted` the ladder's deferral wrote,
    // and what the session said happened is what the attempt reads. It ended
    // when its work did, not when the console finished deciding about it.
    const ended = sessionEnding(entry);
    if (ended) { settle(workEndedAt ?? entry.time, ended); continue; }
  }

  // Whatever is still running is reported as running, with the clock it has.
  if (current) {
    const last = mine.at(-1);
    current.durationMs = last ? clockOf(current.startedAt, timeOf(last)) : 0;
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
