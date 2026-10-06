/**
 * The wait budget: how long a phase may stay parked on somebody else's clock,
 * and the ONE expression that answers "may it park again?" and "is it still
 * inside its allowance?" — at park and at resume alike.
 *
 * Zero-touch-console phase 5 (the sep-review audit's chapter 04). The defects
 * met here were all one arithmetic spread over four sites:
 *
 *   **The window was cut and nobody said so (WAI-1).** `parkWaiting` clamped
 *   every declared window to what was left of an eight-hour budget and wrote
 *   only the clamped instant. Five of 22 declared windows were cut to exactly
 *   8.00 h; one soak was halted with 2 377 of its 2 880 minutes still to run,
 *   and a change window was woken 51 h early at $107.10. A declared window past
 *   the budget is now ANSWERED — a halt that states the arithmetic, or a park
 *   the plan countersigned — never shortened in silence.
 *
 *   **Parked time was a sample (WAI-3).** `record.parkedMs` accrued only when a
 *   park was resumed, measured from `record.endedAt` (which also meant "the
 *   attempt ended"), so a superseded park cost nothing and one phase spent
 *   116.67 h parked against 8. It is now derived from the park's own stamps
 *   (`record.waitHistory`), correct with no resume at all.
 *
 *   **The budget was checked on the way out, never on the way back (WAI-4).**
 *   A resume boarded with 11.76 h of an 8 h budget spent. `evaluateWait` runs
 *   at resume too — the boarding and the boot's overdue ruling call it.
 *
 *   **The watchdog spent the session's allowance (WAI-5).** The console's own
 *   automatic park counted against the waits the session may declare. Its
 *   parks now spend a ledger of their own (`WATCHDOG_PARKS_MAX_PER_PHASE`).
 *
 * A leaf on purpose — type-only imports — so the runner, the service's
 * unsupervised twin and the boot ruling can all reach it without a cycle.
 * Pure on purpose: every caller passes `now`, so the arithmetic is testable
 * to the millisecond and a caller's clock is its own business.
 */

import type { PhaseRecord } from './state.ts';
import type { PhaseOutcome } from './outcome.ts';
import type { WaitAuthor as WaitAuthorWord } from '../../shared/run-lifecycle.js';
import {
  BUDGET_WARN_PCT, budgetArithmetic, budgetFact, type BudgetFact, type BudgetKind,
} from '../../shared/budget-model.js';

/* ---- the knobs (console-runtime; bash never reads them) ------------------ */

/** A park that names no window: check back in half an hour. */
export const WAIT_DEFAULT_MS = 30 * 60_000;

/**
 * The shortest park the console arms. A requested instant already in the past
 * (the closeout itself outlasted the wait) means "as soon as sensible", and a
 * floor keeps that resume from chasing its own tail.
 */
export const WAIT_FLOOR_MS = 60_000;

/**
 * How many waiting-external parks one phase may DECLARE. A phase that keeps
 * re-filing the same wait is not waiting, it is stuck — the cap turns that
 * into an honest halt instead of an infinite quiet loop.
 */
export const WAIT_MAX_PER_PHASE = 4;

/**
 * Total wall-clock one phase may spend parked across its declared waits, when
 * the plan says nothing. A DEFAULT, not a ceiling: `**Wait budget:**` in
 * §Session budget and `- **Waits on:** <ref> · <max>` on the phase override it
 * (`phase-graph.sh --wait-budget N`).
 */
export const DEFAULT_WAIT_BUDGET_MS = 8 * 60 * 60_000;

/**
 * How many times the console may park a phase BY ITSELF — the stall
 * watchdog's automatic park, for a Bash call waiting inside the turn. Its own
 * ledger (WAI-5): four automatic parks leave the session's four declared waits
 * untouched, and running out says which ledger ran out.
 */
export const WATCHDOG_PARKS_MAX_PER_PHASE = 4;

/**
 * Lateness past which an overdue wait is announced, once. A console restart
 * that took five minutes is not news; the audit's five late resumes were 64 to
 * 581 minutes past their clocks, and each read as an on-time resume.
 */
export const WAIT_OVERDUE_ANNOUNCE_MS = 30 * 60_000;

/**
 * How long a refused resume waits before the console asks again whether the
 * session it would resume is still live (REG-1). Short, because the common
 * case is a hand session that declared its wait and is about to exit.
 */
export const RESUME_REFUSED_RECHECK_MS = 5 * 60_000;

/** How many wait entries a record keeps; older ones fold into `parkedMsCarried`. */
export const WAIT_HISTORY_MAX = 16;

/** `st`, `nd`, `rd`, `th` — for a sentence about the Nth declaration. */
export function ordinalSuffix(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return 'th';
  return (['th', 'st', 'nd', 'rd'] as const)[n % 10] ?? 'th';
}

/** What `declaredClock` armed: the clock, what was asked, and whether the ceiling cut it. */
export type DeclaredClock = { until: string; requested: string; capped: boolean };

/**
 * The resume clock a `blocked` / `needs-human` declaration asked for
 * (`--until`, `--wait-minutes`), floored and CAPPED — one arithmetic for the
 * supervised arm (`armDeclaredClock`), the live twin (`declareOutcome`) and the
 * stored twin (`applyUnsupervisedOutcome`), WAI-8. Floored exactly as
 * `parkWaiting` floors: a moment already past means "as soon as sensible".
 * Capped at `DECLARED_CLOCK_MAX_MS`: the two words carry an errand a person
 * settles, and the clock only decides when the console next brings the phase
 * up; a month out is a phase forgotten. `capped` says the ceiling applied, so
 * the caller journals it — the ask is never cut in silence. Null when no
 * usable moment was asked for.
 */
export function declaredClock(
  resumeAfter: string | undefined, opts: { now?: number; floorMs?: number; maxMs?: number } = {},
): DeclaredClock | null {
  if (!resumeAfter) return null;
  const requested = Date.parse(resumeAfter);
  if (!Number.isFinite(requested)) return null;
  const now = opts.now ?? Date.now();
  const floor = opts.floorMs ?? WAIT_FLOOR_MS;
  const max = opts.maxMs ?? DECLARED_CLOCK_MAX_MS;
  const wanted = Math.max(requested, now + floor);
  const until = Math.min(wanted, now + max);
  return { until: new Date(until).toISOString(), requested: new Date(requested).toISOString(), capped: until < wanted };
}

/**
 * How long past its own `parkedUntil` a `waiting` record whose clock nothing
 * will fire is left standing before `settleWaitingRecords` settles it (WAI-6).
 * The same ten minutes after which the inbox raises `park-overdue`: the row and
 * the settlement are two readings of one fact, and should agree on when it
 * became one. Two hub records read "waiting until eight days ago" because no
 * pass ever asked.
 */
export const WAIT_SETTLE_GRACE_MS = 10 * 60_000;

/**
 * The ceiling on a `blocked` / `needs-human` resume clock (`--until`,
 * `--wait-minutes`), WAI-8. Those two words carry an errand a person settles;
 * the clock only says when the console next brings the phase up, and a month
 * out is a phase forgotten, not scheduled. A window past this is granted the
 * ceiling and the cap is journalled; the ask is never cut in silence.
 */
export const DECLARED_CLOCK_MAX_MS = 7 * 24 * 60 * 60_000;

/**
 * How many times ONE status may be declared for one phase before a further
 * declaration is recorded as evidence and not acted on (WAI-8, SLF-4). The same
 * four as `WAIT_MAX_PER_PHASE`, which keeps bounding `waiting-external` on its
 * own ledger; this bounds the other five words, including the one that spawns a
 * paid session each time (`partial`). An operator's Retry clears the count.
 */
export const DECLARATIONS_MAX_PER_PHASE = 4;

/**
 * Two `partial` declarations for one phase inside this window collapse into
 * one act (SLF-4) — on the UNSUPERVISED paths, where a hand session (or a loop
 * in one) can re-run `phase-outcome.sh` for free, and `partial` is the one
 * word whose act is a paid boarding. The other five have no spend to collapse:
 * a wait has its own floor and budget, a blocker rewrites an errand, `complete`
 * and `no-defect` act on nothing. The supervised path reads one file per
 * attempt by construction and needs no cooldown at all.
 */
export const DECLARATION_COOLDOWN_MS = 5 * 60_000;

/** The cooldown a declared word gets on the unsupervised paths — `partial`'s, or none. */
export function declarationCooldownFor(status: string): number | undefined {
  return status === 'partial' ? DECLARATION_COOLDOWN_MS : undefined;
}

/* ---- the shapes --------------------------------------------------------- */

/**
 * How long a run waiting on refs ALONE — a phase whose wait budget is spent
 * but whose ref still polls (control-tower phase 121, #40) — holds before its
 * loop looks again. The ref's landing is what resumes the phase; this clock
 * only keeps the run a `waiting` run with a clock, so a reader that finds no
 * live loop reads it paused with its clock intact rather than interrupted.
 */
export const REF_WAIT_LOOK_AGAIN_MS = 6 * 60 * 60_000;

/** Who parked the phase — `shared/run-lifecycle.js` `WAIT_AUTHORS`, the owner. */
export type WaitAuthor = WaitAuthorWord;

/** One park, from its own stamps. */
export type WaitEntry = {
  /** When the park began. */
  parkedFrom: string;
  /** The clock it was armed on. */
  parkedUntil: string;
  /** The instant the session asked for, when it named one. */
  requested?: string;
  /** When the park ended — resumed, superseded, closed. Absent while it holds. */
  resumedAt?: string;
  by: WaitAuthor;
  /**
   * A park on refs read from this console's own state alone (`spendsWaitBudget`
   * false, control-tower phase 87): shown in the history, never summed into the
   * budget — the thing waited on is another phase's work, which the queue, not
   * the clock, decides.
   */
  unbudgeted?: true;
  /**
   * What the park waits on, when it is not somebody else's clock: `person` —
   * a declared human step (control-tower phase 41, `parkOnStep`). Always
   * UNBUDGETED: a person's time is not the external-wait budget's to charge.
   */
  kind?: 'person';
  /**
   * How the job a `unit:` ref watched ENDED (control-tower phase 121, #181):
   * the ref, systemd's `Result=` and the exit time — written when the ref
   * lands (`recordUnitExit`), never the host's address, user or key.
   */
  unit?: { ref: string; result: string; exitedAt?: string };
};

/**
 * Watch-ref schemes read from THIS console's own state (control-tower phase
 * 87, #126): `phase:<slug>/<N>` — a sibling phase's completion — and
 * `verify:<slug>/<N>` — a phase's own red lines going green — both parsed and
 * probed by phase 88. Waiting on one spends no wait budget: #126 measured P41's
 * eight hours running down while the sibling it waited on had not yet had a
 * lane, and the budget ended before the sibling began. A `cmd:` ref keeps its
 * budget — it RUNS something on every pass — as do `gh:`, `date:` and `lock:`.
 */
export const BUDGET_FREE_SCHEMES = Object.freeze(['phase', 'verify'] as const);

/**
 * Does a park on these refs spend the phase's wait budget? True unless every
 * ref is read from console state (`BUDGET_FREE_SCHEMES`) — and true for a park
 * naming none, whose clock is the only thing ending it.
 */
export function spendsWaitBudget(refs: readonly string[] | null | undefined): boolean {
  const list = (refs ?? []).map((ref) => ref.trim()).filter(Boolean);
  if (!list.length) return true;
  return list.some((ref) => !(BUDGET_FREE_SCHEMES as readonly string[]).includes(ref.slice(0, Math.max(0, ref.indexOf(':')))));
}

/** Where a phase's allowance came from. */
export type WaitBudgetSource = 'phase' | 'plan' | 'default';

export type WaitBudget = {
  budgetMs: number;
  source: WaitBudgetSource;
  /**
   * The latest `date:` instant the plan's own `- **Waits on:**` bullet names
   * for this phase, or null. The versioned plan COUNTERSIGNS a wait up to it:
   * a declared window ending on or before this instant is honoured past the
   * budget, because the plan author already said the phase waits that long.
   */
  countersignedUntil: number | null;
  /** The bullet's refs, verbatim — what the halt sentence and the prompt name. */
  refs: string[];
  /**
   * How many waits the phase may DECLARE (control-tower phase 121, #40): the
   * phase's `- **Wait count:**`, else the plan's `**Wait count:**`, else the
   * console's own `WAIT_MAX_PER_PHASE`. Absent reads as the console's four.
   */
  waitsMax?: number;
  /** Which line said so — the refusal names it as the way to raise the count. */
  waitsSource?: WaitBudgetSource;
};

export type WaitAsk = {
  /**
   * `park` asks "may it park, and until when?"; `resume` asks "is a park that is
   * ending still inside its allowance?" — the boarding and the boot's overdue
   * ruling, where the answer is resume-or-halt and no new window is asked for.
   */
  purpose?: 'park' | 'resume';
  now: number;
  /** The instant the declaration asked for (`resume_after`), or undefined/NaN when it named none. */
  requestedUntil?: number;
  /** Parked time already spent on the DECLARED ledger (`parkedMsOf`). */
  parkedMs: number;
  /** Parks already taken on this ask's ledger. */
  waits: number;
  budget: WaitBudget;
  /** Which ledger this park spends: the session's declared waits, or the watchdog's own. */
  ledger: 'session' | 'watchdog';
  floorMs?: number;
  defaultWindowMs?: number;
  /** The declaration's own `date:` refs, as `[ref, instant]` — a date later than the window extends the park to it. */
  dates?: readonly (readonly [string, number])[];
  /**
   * Does the declaration name at least one ref the watch clock can POLL
   * (`pollableRefs(...).length > 0`)? Then a window past the budget is granted
   * what is left rather than refused (rule 7): the ref's landing, not the
   * window, is what ends the wait. Passed in, so this leaf imports nothing.
   */
  pollable?: boolean;
  /**
   * Does the declaration wait on console state alone (`spendsWaitBudget`
   * false)? Then the park is granted as asked and spends nothing (rule 0).
   */
  unbudgeted?: boolean;
};

export type WaitGrant = {
  verdict: 'park';
  until: number;
  requested: number;
  requestedSource: 'declared' | 'default';
  /** Milliseconds granted from `now`. */
  granted: number;
  /**
   * True when the window was shortened to what was left of the budget: a
   * DEFAULT window (rule 6), or a declared one naming a pollable ref (rule 7,
   * control-tower phase 45) — never a declared window nothing can end sooner.
   */
  capped: boolean;
  budgetMs: number;
  budgetSource: WaitBudgetSource;
  budgetRemainingMs: number;
  parkedMs: number;
  /** What moved the clock past the requested window or the budget: a declared `date:` ref, or the plan's countersign. */
  extendedBy?: string;
};

export type WaitRefusal = {
  verdict: 'timeout';
  /** Which ledger ran out — the halt sentence names it. */
  ledger: 'waits' | 'budget' | 'watchdog';
  requested: number;
  requestedSource: 'declared' | 'default';
  budgetMs: number;
  budgetSource: WaitBudgetSource;
  budgetRemainingMs: number;
  parkedMs: number;
  /** A declared `date:` ref the budget could not reach, named in `reason`. */
  overriddenRef?: string;
  /** The arithmetic, in words, for the halt. */
  reason: string;
};

/** A park that is ending, inside its allowance: resume it. */
export type WaitResume = {
  verdict: 'resume';
  budgetMs: number;
  budgetSource: WaitBudgetSource;
  budgetRemainingMs: number;
  parkedMs: number;
  /** Set when only the plan's countersign keeps an over-budget park resumable. */
  extendedBy?: string;
};

export type WaitVerdict = WaitGrant | WaitRefusal | WaitResume;

/* ---- the one expression ------------------------------------------------- */

const HOUR = 60 * 60_000;
const MINUTE = 60_000;

/** Hours for a sentence: one decimal under ten, whole above. */
export function hoursText(ms: number): string {
  const h = Math.max(0, ms) / HOUR;
  return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
}

const SOURCE_WORDS: Record<WaitBudgetSource, string> = {
  phase: "this phase's `Waits on:` bullet",
  plan: "the plan's `Wait budget:` line",
  default: 'the console default',
};

/** Where a phase's COUNT came from, in the refusal's words (control-tower phase 121). */
const COUNT_SOURCE_WORDS: Record<WaitBudgetSource, string> = {
  phase: "this phase's `Wait count:` bullet",
  plan: "the plan's `Wait count:` line",
  default: 'the console default',
};

/** How many waits a phase may declare — the plan's count, else the console's four. */
export function waitsMaxOf(budget: Pick<WaitBudget, 'waitsMax'>): number {
  return typeof budget.waitsMax === 'number' && Number.isInteger(budget.waitsMax) && budget.waitsMax > 0
    ? budget.waitsMax : WAIT_MAX_PER_PHASE;
}

/**
 * May this phase park, and until when?
 *
 * The ONE place the wait budget is evaluated — at park (`parkWaiting`, the
 * unsupervised twin) and at resume (the boarding, the boot's overdue ruling).
 * `test/invariants.test.ts` holds the callers to that shape.
 *
 * The rules, in order:
 *  1. A ledger with no parks left refuses (`waits`, or `watchdog` for the
 *     console's own).
 *  2. A declared `date:` ref later than the requested window extends the ask
 *     to its instant (WAI-11): it is the session saying exactly when the wait
 *     ends.
 *  3. The watchdog's park is bounded by its count alone — it never spends, or
 *     is refused by, the declared budget.
 *  4. Inside the remaining budget: granted as asked.
 *  5. Past it, a window the plan countersigned (`Waits on:` naming a `date:`
 *     at or after the ask) is granted as asked.
 *  6. Past it with no countersign, a DEFAULT window is shortened to what is
 *     left (`capped`) — the session named no window to cut.
 *  7. Past it, a DECLARED window naming a POLLABLE ref is granted
 *     `min(asked, remaining)` (`capped`) — the ref's landing decides, not the
 *     window (control-tower phase 45, #59: an all-or-nothing refusal halted one
 *     phase three times while the builds it waited on finished inside the
 *     remainder). With no pollable ref, or less than the floor left, it is
 *     refused with the arithmetic — and a refusal is a BUDGET event: the runner
 *     parks the phase `waiting` on its refs with a `budgets` errand
 *     (`parkOnSpentBudget`), never a failure.
 *
 * At resume (`purpose: 'resume'`) only the allowance is asked: a declared park
 * whose parked time is past the budget — the console's own outage counts, it is
 * time the phase spent parked — halts rather than boarding, unless the plan
 * countersigned a wait reaching `now`. The watchdog's parks always resume.
 */
export function evaluateWait(ask: WaitAsk & { purpose: 'resume' }): WaitResume | WaitRefusal;
export function evaluateWait(ask: WaitAsk & { purpose?: 'park' }): WaitGrant | WaitRefusal;
export function evaluateWait(ask: WaitAsk): WaitVerdict {
  if (ask.purpose === 'resume') return evaluateResume(ask);
  const floor = ask.floorMs ?? WAIT_FLOOR_MS;
  const window = ask.defaultWindowMs ?? WAIT_DEFAULT_MS;
  const declaredInstant = typeof ask.requestedUntil === 'number' && Number.isFinite(ask.requestedUntil);
  const requestedSource: 'declared' | 'default' = declaredInstant ? 'declared' : 'default';
  let requested = declaredInstant ? Math.max(ask.requestedUntil!, ask.now + floor) : ask.now + window;
  let extendedBy: string | undefined;
  let latestDate: readonly [string, number] | undefined;
  for (const date of ask.dates ?? []) {
    if (!latestDate || date[1] > latestDate[1]) latestDate = date;
  }
  if (latestDate && latestDate[1] > requested) {
    requested = latestDate[1];
    extendedBy = latestDate[0];
  }
  const budgetMs = ask.budget.budgetMs;
  const parkedMs = Math.max(0, ask.parkedMs);
  const budgetRemainingMs = Math.max(0, budgetMs - parkedMs);
  const base = {
    requested, requestedSource, budgetMs, budgetSource: ask.budget.source, budgetRemainingMs, parkedMs,
  };

  if (ask.ledger === 'watchdog') {
    if (ask.waits >= WATCHDOG_PARKS_MAX_PER_PHASE) {
      return {
        verdict: 'timeout', ledger: 'watchdog', ...base,
        reason: `the console has already parked this phase ${ask.waits} time(s) by itself for waiting `
          + `inside the turn — its automatic-park allowance (${WATCHDOG_PARKS_MAX_PER_PHASE}) is spent. `
          + `The session's own wait allowance is untouched (${hoursText(parkedMs)} of `
          + `${hoursText(budgetMs)} parked, ${SOURCE_WORDS[ask.budget.source]}).`,
      };
    }
    return { verdict: 'park', until: requested, granted: requested - ask.now, capped: false, ...base };
  }

  const maxWaits = waitsMaxOf(ask.budget);
  if (ask.waits >= maxWaits) {
    return {
      verdict: 'timeout', ledger: 'waits', ...base,
      reason: `the phase has already declared ${ask.waits} wait(s) — the most one phase may `
        + `(${maxWaits}, ${COUNT_SOURCE_WORDS[ask.budget.waitsSource ?? 'default']}); ${hoursText(parkedMs)} of its `
        + `${hoursText(budgetMs)} wait budget (${SOURCE_WORDS[ask.budget.source]}) is spent.`,
    };
  }
  const wanted = requested - ask.now;
  // Rule 0 (control-tower phase 87, #126): a wait on this console's own state
  // (a sibling's completion, a phase's red lines) is granted as asked and
  // spends nothing — its end is the queue's to decide, not the clock's.
  if (ask.unbudgeted) {
    return {
      verdict: 'park', until: requested, granted: wanted, capped: false, ...base,
      ...(extendedBy ? { extendedBy } : {}),
    };
  }
  if (budgetRemainingMs >= floor && wanted <= budgetRemainingMs) {
    return {
      verdict: 'park', until: requested, granted: wanted, capped: false, ...base,
      ...(extendedBy ? { extendedBy } : {}),
    };
  }
  const countersigned = ask.budget.countersignedUntil;
  if (countersigned !== null && requested <= countersigned) {
    return {
      verdict: 'park', until: requested, granted: wanted, capped: false, ...base,
      extendedBy: extendedBy ?? `the plan's Waits on: (${new Date(countersigned).toISOString()})`,
    };
  }
  if (requestedSource === 'default' && !extendedBy && budgetRemainingMs >= floor) {
    const until = ask.now + budgetRemainingMs;
    return { verdict: 'park', ...base, until, granted: budgetRemainingMs, capped: true };
  }
  if (ask.pollable && budgetRemainingMs >= floor) {
    const until = ask.now + budgetRemainingMs;
    return {
      verdict: 'park', ...base, until, granted: budgetRemainingMs, capped: true,
      ...(extendedBy ? { extendedBy } : {}),
    };
  }
  const asked = declaredInstant || extendedBy
    ? `asked to wait until ${new Date(requested).toISOString()} (${hoursText(wanted)} from now)`
    : `needs another ${hoursText(wanted)} parked`;
  // The arithmetic FIRST (control-tower phase 14, #40): every surface that
  // quotes this refusal — the errand, the park note, the push — now opens on
  // the budget and its numbers rather than on the thing it stopped.
  const arithmetic = budgetArithmetic({
    budget: 'wait', limit: budgetMs / MINUTE, spent: parkedMs / MINUTE, asked: wanted / MINUTE,
  });
  return {
    verdict: 'timeout', ledger: 'budget', ...base,
    ...(extendedBy ? { overriddenRef: extendedBy } : {}),
    reason: `${arithmetic} — the phase ${asked}`
      + (extendedBy ? ` — its declaration names \`${extendedBy}\`` : '')
      + `; its wait budget is ${hoursText(budgetMs)} (${SOURCE_WORDS[ask.budget.source]}) with `
      + `${hoursText(parkedMs)} already parked, so ${hoursText(budgetRemainingMs)} remain`
      + (ask.pollable
        ? ' — the budget is spent, so the phase waits on its refs with no clock of its own. Raise it with '
        : '. The console does not cut a declared window short when no ref it can watch would end it sooner: '
          + 'name one with `--watch`, or raise the budget with ')
      + '`- **Waits on:** <ref> · <max>` on this phase (or `**Wait budget:**` in §Session budget), then Retry.',
  };
}

function evaluateResume(ask: WaitAsk): WaitResume | WaitRefusal {
  const budgetMs = ask.budget.budgetMs;
  const parkedMs = Math.max(0, ask.parkedMs);
  const budgetRemainingMs = Math.max(0, budgetMs - parkedMs);
  const base = { budgetMs, budgetSource: ask.budget.source, budgetRemainingMs, parkedMs };
  if (ask.ledger === 'watchdog' || parkedMs <= budgetMs) return { verdict: 'resume', ...base };
  const countersigned = ask.budget.countersignedUntil;
  if (countersigned !== null && ask.now <= countersigned) {
    return { verdict: 'resume', ...base, extendedBy: `the plan's Waits on: (${new Date(countersigned).toISOString()})` };
  }
  return {
    verdict: 'timeout', ledger: 'budget', ...base, requested: ask.now, requestedSource: 'default',
    reason: `the phase has been parked ${hoursText(parkedMs)} against its ${hoursText(budgetMs)} wait `
      + `budget (${SOURCE_WORDS[ask.budget.source]}) — the budget ran out before anything resumed it, `
      + 'so the console will not board it on a stale clock. Re-check the external work by hand, then '
      + 'Retry — or extend this phase with `- **Waits on:** <ref> · <max>`.',
  };
}

/* ---- parked time, from the park's own stamps ----------------------------- */

/**
 * Wall-clock this phase has spent parked on its DECLARED ledger — the session's
 * own waits and the unsupervised ones, never the watchdog's.
 *
 * `Σ min(now, end) − parkedFrom` over the history, where an entry's end is its
 * `resumedAt`, or `now` while it is the park still holding, or its own clock
 * when it was left without a stamp (a console that died mid-park): a park that
 * never resumed still counts, which is the defect this replaces. A record
 * written before the history existed reads its legacy accrual.
 */
export function parkedMsOf(
  record: Pick<PhaseRecord, 'waitHistory' | 'parkedMs' | 'parkedMsCarried' | 'status'>,
  now: number,
): number {
  const history = record.waitHistory;
  if (!history?.length) return Math.max(0, record.parkedMs ?? 0);
  let total = Math.max(0, record.parkedMsCarried ?? 0);
  history.forEach((entry, index) => {
    if (consoleOwnPark(entry) || entry.unbudgeted) return;
    total += entryMs(entry, now, index === history.length - 1 && record.status === 'waiting');
  });
  return total;
}

/**
 * A park the CONSOLE made — the stall watchdog's, or the ladder's (phase 10) —
 * as opposed to one the session declared: shown, never budgeted, because the
 * declared budget bounds the session's testimony and charging it for the
 * console's own remedy would spend the phase's allowance on the console.
 */
export function consoleOwnPark(entry: Pick<WaitEntry, 'by'>): boolean {
  return entry.by === 'watchdog' || entry.by === 'ladder';
}

/** Wall-clock the console's OWN parks have held this phase — shown, never budgeted. */
export function watchdogParkedMsOf(record: Pick<PhaseRecord, 'waitHistory' | 'status'>, now: number): number {
  const history = record.waitHistory ?? [];
  return history.reduce((sum, entry, index) => (consoleOwnPark(entry)
    ? sum + entryMs(entry, now, index === history.length - 1 && record.status === 'waiting')
    : sum), 0);
}

function entryMs(entry: WaitEntry, now: number, open: boolean): number {
  const from = Date.parse(entry.parkedFrom);
  if (!Number.isFinite(from)) return 0;
  const stamped = entry.resumedAt ? Date.parse(entry.resumedAt) : NaN;
  const clock = Date.parse(entry.parkedUntil);
  const end = Number.isFinite(stamped)
    ? stamped
    : open ? now : (Number.isFinite(clock) ? Math.min(now, clock) : now);
  return Math.max(0, Math.min(now, end) - from);
}

/**
 * Close the park still holding, if any: it ended at `at`. Called when a park is
 * resumed, superseded by a new one, or its declaration is spent — so the next
 * `parkedMsOf` measures a finished park from its own two stamps.
 */
export function closeWaitEntry(record: Pick<PhaseRecord, 'waitHistory'>, at: string): void {
  const last = record.waitHistory?.[record.waitHistory.length - 1];
  if (last && !last.resumedAt) last.resumedAt = at;
}

/**
 * Open a park: close whatever held before it, append this one, and fold the
 * oldest entries into `parkedMsCarried` past `WAIT_HISTORY_MAX` so a phase
 * that parks for a week does not grow its record for ever. A record from
 * before the history carries its legacy `parkedMs` in, once.
 */
export function openWaitEntry(
  record: Pick<PhaseRecord, 'waitHistory' | 'parkedMs' | 'parkedMsCarried'>, entry: WaitEntry, now: number,
): void {
  if (!record.waitHistory) {
    record.waitHistory = [];
    if (record.parkedMs) record.parkedMsCarried = record.parkedMs;
  }
  closeWaitEntry(record, entry.parkedFrom);
  record.waitHistory.push(entry);
  while (record.waitHistory.length > WAIT_HISTORY_MAX) {
    const oldest = record.waitHistory.shift()!;
    if (!consoleOwnPark(oldest)) record.parkedMsCarried = (record.parkedMsCarried ?? 0) + entryMs(oldest, now, false);
  }
}

/* ---- the plan's word, read through the engine ---------------------------- */


/**
 * A phase's wait budget from the engine's two answers: `--wait-budget N`
 * (`minutes<TAB>phase|plan`, or nothing) and `--waits-on N` (refs, one per
 * line). `dateOf` turns a `date:` ref into an instant — `watch-refs.ts`'s
 * parser, passed in so this leaf imports nothing.
 */
export function waitBudgetFrom(
  budgetLine: string, refsText: string, dateOf: (ref: string) => number | null, countLine = '',
): WaitBudget {
  // `--wait-count N` (control-tower phase 121): `n<TAB>phase|plan`, or nothing.
  const [countText, countSourceText] = countLine.trim().split('\t');
  const count = Number(countText);
  const counted = Number.isInteger(count) && count >= 1 && count <= 99
    && (countSourceText === 'phase' || countSourceText === 'plan');
  const waits = counted
    ? { waitsMax: count, waitsSource: countSourceText as WaitBudgetSource }
    : { waitsMax: WAIT_MAX_PER_PHASE, waitsSource: 'default' as WaitBudgetSource };
  const [minutesText, sourceText] = budgetLine.trim().split('\t');
  const minutes = Number(minutesText);
  const source: WaitBudgetSource = sourceText === 'phase' || sourceText === 'plan' ? sourceText : 'default';
  const refs = refsText.split('\n').map((line) => line.trim()).filter(Boolean);
  let countersignedUntil: number | null = null;
  for (const ref of refs) {
    const at = dateOf(ref);
    if (at !== null && (countersignedUntil === null || at > countersignedUntil)) countersignedUntil = at;
  }
  return Number.isSafeInteger(minutes) && minutes > 0 && source !== 'default'
    ? { budgetMs: minutes * 60_000, source, countersignedUntil, refs, ...waits }
    : { budgetMs: DEFAULT_WAIT_BUDGET_MS, source: 'default', countersignedUntil, refs, ...waits };
}

/**
 * The instant this phase's wait budget runs out for the declaration it is
 * parked on, or null when it is parked on none.
 *
 * The budget is a TOTAL over the phase's declared parks, so the end is the
 * declaration's own instant plus what the budget still had then — the parked
 * time spent BEFORE it is `parkedMsOf` read at that instant. The budget is the
 * one the park stamped on the declaration (`declared.budget`, read through the
 * engine at park time); a declaration written before that stamp existed reads
 * the console default, which is what its park was judged against anyway.
 *
 * Synchronous on purpose: the watch clock (`cmd:` refs run until this instant,
 * control-tower phase 6) and the scope fence (it lifts at this instant) both
 * ask it on a pass that must not wait on an engine. The declared window ends
 * here too (`declaredWindowOf`, control-tower phase 87). None for a declaration
 * waiting on console state alone (`spendsWaitBudget`), which spends no budget.
 */
export function waitBudgetEndOf(
  record: Pick<PhaseRecord, 'declared' | 'waitHistory' | 'parkedMs' | 'parkedMsCarried' | 'status'>,
): number | null {
  const declared = record.declared;
  if (!declared?.at) return null;
  if (declared.watch?.length && !spendsWaitBudget(declared.watch)) return null;
  const at = Date.parse(declared.at);
  if (!Number.isFinite(at)) return null;
  const budgetMs = typeof declared.budget?.ms === 'number' && declared.budget.ms > 0
    ? declared.budget.ms : DEFAULT_WAIT_BUDGET_MS;
  return at + Math.max(0, budgetMs - parkedMsOf(record, at));
}

/** The budget when the engine could not be asked — the console default, nothing countersigned. */
export const DEFAULT_WAIT_BUDGET: WaitBudget = Object.freeze({
  budgetMs: DEFAULT_WAIT_BUDGET_MS, source: 'default', countersignedUntil: null, refs: [],
}) as WaitBudget;

/* ------------------------------------------------------------------ *
 * What a declaration may NOT ask for (#42)
 * ------------------------------------------------------------------ */

/**
 * The `--needs` words that mean a PERSON settles the block: a judgement, which
 * no ref can prove and no clock can bring forward (#42's third ask). A phase
 * declaring one takes no watch and no wait clock — it parks, and a person
 * answers. `ambiguity` is the one a run meets today; phase 41's human-step
 * kinds are where the others get words of their own.
 */
export const PERSON_NEEDS = Object.freeze(['ambiguity'] as const);

/**
 * Is `ref` a `lock:` ref naming the declaring phase's OWN lock? The grammar is
 * `phase-outcome.sh`'s (`lock:<slug>/<phase>`, leading zeros allowed), so a ref
 * the script let through and one written by hand read the same.
 */
export function isOwnLockRef(ref: string, slug: string, phase: number): boolean {
  const match = /^lock:([A-Za-z0-9][A-Za-z0-9._-]*)\/0*([1-9][0-9]*)$/.exec(String(ref ?? '').trim());
  return !!match && match[1] === slug && Number(match[2]) === phase;
}

export type ScreenedDeclaration = {
  /** The declaration as it may be acted on: own-lock refs gone, a person-block's watch and clock gone. */
  outcome: PhaseOutcome;
  /** The refs refused because they name the declarer's own lock (`OWN_LOCK_WATCH_REFUSAL`). */
  ownLock: string[];
  /** A block on a person (`PERSON_NEEDS`) — it takes no watch and no wait clock. */
  person: boolean;
  /** What a person-block asked for and does not get, when it asked for anything. */
  dropped?: { watch: string[]; resumeAfter: string | null };
};

/**
 * Screen a declaration before anything acts on it — one rule for the three
 * doors a declaration comes through (the runner's own file, the live twin, the
 * unsupervised inbox), so a declaration an older script wrote is refused
 * exactly as `phase-outcome.sh` now refuses it at the flag.
 *
 *   - A `lock:` ref naming the declarer's own lock is refused (#42's first ask):
 *     the console holds that lock for the phase and releases it at the
 *     session's closeout, so the watch would fire on the phase's own teardown.
 *     `outcome.refused` carries it, so the router can tell a lock block that
 *     named only itself from one behind somebody else.
 *   - A `blocked`/`needs-human` on a person keeps no watch and no clock (#42's
 *     third ask): nothing it could watch would answer a judgement.
 */
export function screenDeclaration(outcome: PhaseOutcome, slug: string, phase: number): ScreenedDeclaration {
  const ownLock = outcome.watch.filter((ref) => isOwnLockRef(ref, slug, phase));
  const watch = outcome.watch.filter((ref) => !ownLock.includes(ref));
  const person = (outcome.status === 'blocked' || outcome.status === 'needs-human')
    && (PERSON_NEEDS as readonly string[]).includes(outcome.needs ?? '');
  const { resume_after: resumeAfter, ...rest } = outcome;
  const next: PhaseOutcome = person
    ? { ...rest, watch: [] }
    : { ...outcome, watch };
  if (ownLock.length) next.refused = [...(outcome.refused ?? []), ...ownLock];
  const dropped = person && (watch.length || resumeAfter)
    ? { watch, resumeAfter: resumeAfter ?? null }
    : undefined;
  return { outcome: next, ownLock, person, ...(dropped ? { dropped } : {}) };
}

/**
 * What a screened declaration's `phase.outcome` line adds: the refs refused
 * (`refused`), and — for a block on a person — `person: true`, that it takes
 * no watch and no clock (`watch: []`, `resumeAfter: null` beside it), and what
 * it asked for that it did not get (`dropped`). Nothing for a declaration the
 * screen did not touch, so every other line keeps its old shape.
 */
export function screenedFields(screened: ScreenedDeclaration): Record<string, unknown> {
  return {
    ...(screened.ownLock.length ? { refused: [...screened.ownLock] } : {}),
    ...(screened.person
      ? { person: true, clock: 'none — a person settles this; no watch, no wait clock', ...(screened.dropped ? { dropped: screened.dropped } : {}) }
      : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Budget facts (control-tower phase 14, #40)
 * ------------------------------------------------------------------ */

/**
 * The wait budget as a `BudgetFact`: the limit, the parked time that counts
 * against it and each park it went on — so "245m accrued, 205m of it while the
 * run was halted" is a line a person can read rather than a sum they cannot.
 * `askedMs` is the window the phase asked for when it met the line.
 */
export function waitBudgetFact(
  record: Pick<PhaseRecord, 'phase' | 'waitHistory' | 'parkedMs' | 'parkedMsCarried' | 'status'>,
  budget: Pick<WaitBudget, 'budgetMs' | 'source'>,
  opts: { now: number; askedMs?: number | null; at?: string },
): BudgetFact {
  const history = record.waitHistory ?? [];
  const spentOn = history.flatMap((entry, index) => {
    if (consoleOwnPark(entry) || entry.unbudgeted) return [];
    const ms = entryMs(entry, opts.now, index === history.length - 1 && record.status === 'waiting');
    const from = entry.parkedFrom.slice(11, 16);
    const to = (entry.resumedAt ?? entry.parkedUntil).slice(11, 16);
    return [{ what: `parked ${from}–${to} UTC (${entry.by})`, amount: ms / MINUTE }];
  });
  if ((record.parkedMsCarried ?? 0) > 0) {
    spentOn.unshift({ what: 'earlier parks, folded', amount: (record.parkedMsCarried ?? 0) / MINUTE });
  }
  return budgetFact({
    budget: 'wait',
    phase: record.phase,
    limit: budget.budgetMs / MINUTE,
    spent: parkedMsOf(record, opts.now) / MINUTE,
    asked: typeof opts.askedMs === 'number' ? opts.askedMs / MINUTE : null,
    spentOn,
    source: budget.source,
    at: opts.at ?? new Date(opts.now).toISOString(),
  });
}

/**
 * Will this grant carry the phase past `BUDGET_WARN_PCT` of its wait budget —
 * and how far into the park? `crossesInMs` is 0 when it is past the line
 * already; null when the park ends under it, or the budget is already gone
 * (that is a spent budget, said by the refusal, not a warning). Said at the
 * GRANT, the moment the console knows, so a long CI wait can be extended
 * before it parks on a spent budget rather than after.
 */
export function waitApproaching(opts: { parkedMs: number; grantedMs: number; budget: Pick<WaitBudget, 'budgetMs'> }):
  { crossesInMs: number } | null {
  const budgetMs = opts.budget.budgetMs;
  if (!(budgetMs > 0)) return null;
  const parked = Math.max(0, opts.parkedMs);
  if (parked >= budgetMs) return null;
  const line = (budgetMs * BUDGET_WARN_PCT) / 100;
  if (parked + Math.max(0, opts.grantedMs) < line) return null;
  return { crossesInMs: Math.max(0, line - parked) };
}

/** The run's dollars as a `BudgetFact` — what each phase spent, the dearest first. */
export function runBudgetFact(
  state: { runBudgetUsd?: number | null; spentUsd: number; phases: Record<string, { costUsd?: number }> },
  at?: string,
): BudgetFact {
  const spentOn = Object.entries(state.phases)
    .map(([phase, record]) => ({ what: `phase ${phase}`, amount: record.costUsd ?? 0 }))
    .filter((row) => row.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  return budgetFact({
    budget: 'run-usd', phase: null, limit: state.runBudgetUsd ?? 0, spent: state.spentUsd, spentOn,
    setting: 'runBudgetUsd', ...(at ? { at } : {}),
  });
}

/** One phase's dollars against its cap as a `BudgetFact`, each session's share named. */
export function phaseBudgetFact(
  phase: number, capUsd: number, spentUsd: number,
  sessions: readonly { what: string; amount: number }[] = [], at?: string,
): BudgetFact {
  return budgetFact({
    budget: 'phase-usd', phase, limit: capUsd, spent: spentUsd, spentOn: [...sessions],
    setting: 'phaseBudgetUsd', ...(at ? { at } : {}),
  });
}

/** The failure streak as a `BudgetFact`: the phases that failed in a row, in order. */
export function streakFact(
  state: { maxConsecutiveFailures: number; consecutiveFailures: number; failureStreak?: number[] },
  phase?: number | null, at?: string,
): BudgetFact {
  return budgetFact({
    budget: 'streak', phase: typeof phase === 'number' ? phase : null,
    limit: state.maxConsecutiveFailures, spent: state.consecutiveFailures,
    spentOn: (state.failureStreak ?? []).map((p) => ({ what: `phase ${p}` })),
    ...(at ? { at } : {}),
  });
}

/**
 * Claim the one warning a budget gets per `key` (the attempt and the limit it
 * was measured against): true the first time, false after — so a budget warns
 * once per attempt, and once more after a raise moves its limit. The stamp
 * rides the record, so a restart does not warn twice.
 */
export function claimBudgetWarning(holder: { budgetWarned?: Record<string, string> }, budget: BudgetKind, key: string): boolean {
  if (holder.budgetWarned?.[budget] === key) return false;
  holder.budgetWarned = { ...(holder.budgetWarned ?? {}), [budget]: key };
  return true;
}
