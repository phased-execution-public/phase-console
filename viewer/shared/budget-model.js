/**
 * The budgets that can stop a run — their words, where each is raised, and the
 * one line that says how much of one is gone (control-tower phase 14, #40).
 *
 * Every budget in the console could stop a run and not one of them said so: a
 * spent wait budget parked a phase under a card describing CI, a spent run
 * budget halted under the generic "Run halted", and the only way to raise any
 * of them was to hand-edit plan markdown or find the right settings box. The
 * console knew precisely which budget, the limit and the remedy every time.
 * This module is where those facts get one shape — `BudgetFact` — so the halt,
 * the errand, the push and the card all read the same numbers.
 *
 * ⚠️ Data and pure functions only, no imports — the client bundles this module
 * and `node --test` imports it directly. `test/vocab-owners.test.ts` registers
 * `BUDGET_KINDS`: a second spelling of it under `shared/`, `server/` or
 * `client/src/` fails that scan.
 */

/**
 * Every budget that can stop work, in the order a person meets them.
 *
 * `wait` — how long ONE phase may stay parked on its declared waits (the
 * plan's `Waits on:` max, else its `Wait budget:`, else the console default).
 * `phase-usd` — one phase's dollar cap (`phaseBudgetUsd`, doubled on each
 * resume until the attempts run out). `run-usd` — the run's dollar budget
 * (`runBudgetUsd`, auto-raised once by `budgetAutoRaisePct`). `ladder` — a cap
 * on automatic recovery (`ladderPerRunRungs` and its siblings). `streak` — the
 * failure streak (`maxConsecutiveFailures`): not raised but cleared.
 * @typedef {(typeof BUDGET_KINDS)[number]} BudgetKind
 */
export const BUDGET_KINDS = Object.freeze(
  /** @type {const} */ (['wait', 'phase-usd', 'run-usd', 'ladder', 'streak']),
);

/**
 * The share of a budget, in percent, at which the console warns ONCE per
 * budget per attempt (`phase.budget-approaching`) — the `usage-climbing`
 * precedent: a long CI wait can be extended before it parks, not after.
 */
export const BUDGET_WARN_PCT = 80;

/** What a `budget` push says a budget is: nearing its line, or gone. */
export const BUDGET_STATES = Object.freeze(/** @type {const} */ (['approaching', 'spent']));

/** The unit each budget counts in, for the arithmetic. */
export const BUDGET_UNITS = Object.freeze({
  wait: 'minutes',
  'phase-usd': 'usd',
  'run-usd': 'usd',
  ladder: 'rungs',
  streak: 'phases',
});

/** How each budget reads in a sentence. */
export const BUDGET_LABELS = Object.freeze({
  wait: 'wait budget',
  'phase-usd': 'phase budget',
  'run-usd': 'run budget',
  ladder: 'recovery budget',
  streak: 'failure streak',
});

/**
 * Where a raise is WRITTEN: `plan` — the plan's own line, because the engine
 * re-reads the plan on every board and a run-local override would be silently
 * lost (`scripts/wait-budget.sh`, needs `--allow-writes`); `run` — the run's
 * settings, through the ordinary settings patch; `reset` — nothing is raised,
 * the counter is cleared (`clearStreak`).
 */
export const BUDGET_HOME = Object.freeze({
  wait: 'plan',
  'phase-usd': 'run',
  'run-usd': 'run',
  ladder: 'run',
  streak: 'reset',
});

/** The run setting a `run`-homed raise patches. */
export const BUDGET_SETTING = Object.freeze({
  'phase-usd': 'phaseBudgetUsd',
  'run-usd': 'runBudgetUsd',
  ladder: 'ladderPerRunRungs',
});

/** The ladder settings a raise may name — the cap errand's `setting` picks one. */
export const LADDER_RAISE_SETTINGS = Object.freeze(
  /** @type {const} */ (['ladderPerRunRungs', 'ladderPerPhaseRungs']),
);

/** The steps the card offers for a wait, in minutes; any other amount is typed. */
export const WAIT_RAISE_STEPS_MIN = Object.freeze([30, 60]);

/** The step the card offers for a dollar cap, in dollars. */
export const USD_RAISE_STEP = 10;

/** The largest single raise the route accepts, per unit — a typo, not a budget. */
export const RAISE_MAX = Object.freeze({ minutes: 7 * 24 * 60, usd: 10_000, rungs: 1000 });

/** @param {unknown} value @returns {value is BudgetKind} */
export function isBudgetKind(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (BUDGET_KINDS).includes(value);
}

/**
 * Is a budget at its warning line — `BUDGET_WARN_PCT` or more gone, and not
 * yet all of it? A limit that is not a positive number has no line.
 * @param {number} spent @param {number} limit
 */
export function budgetApproaching(spent, limit) {
  if (!(limit > 0) || !Number.isFinite(spent)) return false;
  return spent * 100 >= limit * BUDGET_WARN_PCT && spent < limit;
}

const round1 = (n) => {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

/**
 * An amount in its budget's unit, short: `45m`, `2.5h`, `$12.50`, `3 rungs`,
 * `2 phases`. Minutes read as minutes under two hours and as hours above,
 * because "720m" is a number a person has to divide. `unitOverride` is for the
 * one budget that counts in two units: a ladder cap is rungs or dollars.
 * @param {BudgetKind} kind @param {number} n @param {string} [unitOverride]
 */
export function budgetAmount(kind, n, unitOverride) {
  const unit = unitOverride ?? BUDGET_UNITS[kind];
  const v = Math.max(0, Number(n) || 0);
  if (unit === 'minutes') return v < 120 ? `${round1(v)}m` : `${round1(v / 60)}h`;
  if (unit === 'waits') return `${Math.round(v)} declared wait${Math.round(v) === 1 ? '' : 's'}`;
  if (unit === 'usd') return `$${v.toFixed(2)}`;
  const whole = Math.round(v);
  return `${whole} ${unit === 'rungs' ? 'rung' : 'phase'}${whole === 1 ? '' : 's'}`;
}

/**
 * The arithmetic, in the one shape every surface prints:
 * `60m wait budget · 39.7m accrued · 20.3m left · asked for 90m`.
 * `asked` is what the phase asked for when it hit the line (a wait's window),
 * named only when there is one.
 * @param {{ budget: BudgetKind, limit: number, spent: number, asked?: number | null, unit?: string }} fact
 */
export function budgetArithmetic(fact) {
  const left = Math.max(0, fact.limit - fact.spent);
  const unit = fact.unit ?? BUDGET_UNITS[fact.budget];
  const accrued =
    fact.budget === 'streak'
      ? 'in a row'
      : fact.budget === 'ladder' && unit === 'rungs'
        ? 'climbed'
        : 'accrued';
  const amount = (n) => budgetAmount(fact.budget, n, unit);
  // The wait budget's OTHER ledger: the count of declared waits, not their
  // minutes — said as a count, so a phase stopped by it is never told it ran
  // out of time it still has.
  if (unit === 'waits') {
    return `${amount(fact.limit)} allowed · ${Math.round(fact.spent)} declared · ${Math.round(left)} left`;
  }
  return (
    `${amount(fact.limit)} ${BUDGET_LABELS[fact.budget]}` +
    ` · ${amount(fact.spent)} ${accrued}` +
    ` · ${amount(left)} left` +
    (typeof fact.asked === 'number' && fact.asked > 0 ? ` · asked for ${amount(fact.asked)}` : '')
  );
}

/**
 * The first line of any card, errand or push about a budget: it says BUDGET,
 * then the arithmetic — never the sentence of whatever the budget stopped
 * (a phase parked on a spent wait budget is not "waiting on CI").
 * @param {{ budget: BudgetKind, limit: number, spent: number, asked?: number | null, unit?: string }} fact
 * @param {'approaching' | 'spent'} [state]
 */
export function budgetHeadline(fact, state = 'spent') {
  const label = BUDGET_LABELS[fact.budget];
  const head =
    fact.budget === 'streak'
      ? state === 'spent'
        ? 'Failure streak reached its limit'
        : 'Failure streak nearing its limit'
      : `${label[0].toUpperCase()}${label.slice(1)} ${state === 'spent' ? 'spent' : `${BUDGET_WARN_PCT}% spent`}`;
  return `${head} — ${budgetArithmetic(fact)}`;
}

/**
 * The shape every surface reads (the halt's and the errand's `budget`, the
 * `budget` push, the card). `spentOn` says what the budget went on — the parks
 * and their clocks, the attempts and their dollars, the rungs, the phases — so
 * a person can tell an under-declaration from an accounting fault.
 * @typedef {{
 *   budget: BudgetKind,
 *   phase: number | null,
 *   limit: number,
 *   spent: number,
 *   left: number,
 *   asked?: number | null,
 *   unit: string,
 *   spentOn: { what: string, amount?: number }[],
 *   setting?: string | null,
 *   source?: string | null,
 *   at: string,
 * }} BudgetFact
 */

/**
 * Build a `BudgetFact`, clamping what a caller may get wrong (a negative
 * spend, an unrounded dollar) so every reader meets the same numbers.
 * @param {{ budget: BudgetKind, phase?: number | null, limit: number, spent: number, asked?: number | null, unit?: string,
 *   spentOn?: { what: string, amount?: number }[], setting?: string | null, source?: string | null, at?: string }} input
 * @returns {BudgetFact}
 */
export function budgetFact(input) {
  const unit = input.unit ?? BUDGET_UNITS[input.budget];
  const money = unit === 'usd';
  const tidy = (n) => (money ? Math.round(Math.max(0, n) * 100) / 100 : Math.round(Math.max(0, n) * 10) / 10);
  const limit = tidy(input.limit);
  const spent = tidy(input.spent);
  return {
    budget: input.budget,
    phase: typeof input.phase === 'number' ? input.phase : null,
    limit,
    spent,
    left: tidy(limit - spent),
    ...(typeof input.asked === 'number' && input.asked > 0 ? { asked: tidy(input.asked) } : {}),
    unit,
    spentOn: (input.spentOn ?? []).slice(0, 12).map((s) => ({
      what: String(s.what).slice(0, 160),
      ...(typeof s.amount === 'number' ? { amount: tidy(s.amount) } : {}),
    })),
    ...(input.setting ? { setting: input.setting } : {}),
    ...(input.source ? { source: input.source } : {}),
    at: input.at ?? new Date().toISOString(),
  };
}
