/**
 * When this console is allowed to board a phase.
 *
 * Admission had exactly two clocks: the account's usage window, and nothing.
 * Everything else — the cap, the scopes, the locks — answers "is it safe right
 * now", never "is right now a time this operator wants sessions to start". So a
 * plan boarded at 03:40 on a laptop nobody was near, spent a rung failing at
 * something a person would have caught in a sentence, and was still going at
 * breakfast. This module is the missing answer, as a pure function of a policy
 * object and a timestamp.
 *
 * Three ways to say it, and they compose in one order that never changes:
 *
 *   1. `windows` — an ALLOW-list. Empty means every hour is allowed, which is
 *      what the console has always done and stays the default.
 *   2. `cron` — openings expressed as five-field cron, each lasting
 *      `cronMinutes`. The same allow-list, said in the vocabulary a person who
 *      already has a crontab knows.
 *   3. `quiet` — a DENY-list, and it wins. Quiet hours are the promise that is
 *      worth something precisely because nothing overrides it.
 *
 * Local time throughout, because the console is a localhost application: its
 * clock IS the operator's clock, and a timezone field would be a second source
 * of truth for a fact the process already has. `nowMs` is passed in rather than
 * read, so every decision is reproducible under a fake clock.
 *
 * ⚠️ Data and pure functions only, no imports — the client bundles this and
 * `node --test` imports it directly, exactly like `shared/run-settings.js`.
 */

/** How far ahead `nextOpening` will look before answering "I cannot say". */
export const SCAN_DAYS = 8;
const MINUTE_MS = 60_000;

/** Default life of a cron opening, in minutes, when the policy names none. */
export const DEFAULT_CRON_MINUTES = 60;

/**
 * @typedef {Object} BoardingWindow
 * @property {number[]} [days] Days the window may START on: 0=Sun … 6=Sat.
 *   Absent or empty means every day.
 * @property {string} from `HH:MM`, local, inclusive.
 * @property {string} to `HH:MM`, local, EXCLUSIVE. `to <= from` wraps past
 *   midnight — and the wrap belongs to the day it STARTED on, so a Friday
 *   22:00→06:00 window is open at 02:00 on Saturday and closed at 02:00 on
 *   Friday. Anything else would make "Friday night" unsayable.
 */

/**
 * @typedef {Object} SchedulePolicy
 * @property {boolean} [enabled] Off — the default — means every hour boards,
 *   which is what this console did before the policy existed. A disabled policy
 *   keeps its windows: turning the schedule off for an afternoon must not cost
 *   the operator the schedule.
 * @property {BoardingWindow[]} [windows]
 * @property {string[]} [cron] Five-field expressions; each match opens a window
 *   of `cronMinutes`.
 * @property {number} [cronMinutes]
 * @property {BoardingWindow[]} [quiet]
 */

/** `HH:MM` → minutes past midnight, or null if it is not a time. */
export function parseHhMm(text) {
  if (typeof text !== 'string') return null;
  const m = /^([0-9]{1,2}):([0-9]{2})$/.exec(text.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Minutes past midnight → `HH:MM`. The inverse, for the settings form. */
export function formatHhMm(minutes) {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Is `at` inside this window?
 *
 * Written against a Date rather than the raw ms so the wrap rule above can be
 * expressed once: a wrapping window is tested on TODAY's start day and again on
 * YESTERDAY's, and the second test is the whole reason "Friday night" works.
 */
export function windowCovers(window, at) {
  const from = parseHhMm(window?.from);
  const to = parseHhMm(window?.to);
  if (from === null || to === null) return false;
  const days = Array.isArray(window.days) && window.days.length ? window.days : null;
  const minute = at.getHours() * 60 + at.getMinutes();
  const today = at.getDay();
  const dayBefore = (today + 6) % 7;
  if (to > from) {
    if (days && !days.includes(today)) return false;
    return minute >= from && minute < to;
  }
  // Wrapping (or a zero-length `from === to`, which we read as "all day from
  // `from`" — the same thing 22:00→22:00 means to a person saying "overnight").
  if (minute >= from) return !days || days.includes(today);
  if (minute < to) return !days || days.includes(dayBefore);
  return false;
}

/* ------------------------------------------------------------------ *
 * cron
 * ------------------------------------------------------------------ */

const CRON_RANGES = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week, 0 and 7 both Sunday
];

/**
 * One cron field → the set of numbers it names, or null if it is malformed.
 *
 * A malformed field makes the whole expression null rather than "matches
 * everything": a typo must never silently widen a boarding window, which is the
 * failure direction that costs money.
 */
export function cronField(text, index) {
  const range = CRON_RANGES[index];
  if (!range || typeof text !== 'string' || !text.length) return null;
  const [lo, hi] = range;
  const out = new Set();
  for (const part of text.split(',')) {
    const slashed = part.split('/');
    if (slashed.length > 2) return null;
    const [spec, stepText] = slashed;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;
    let start;
    let end;
    if (spec === '*') {
      start = lo;
      end = hi;
    } else if (spec.includes('-')) {
      // Exactly two non-empty halves. `Number('')` is 0, so a bare `-1` used to
      // parse as the range 0–1 and a leading minus quietly widened the field to
      // include midnight — found by the test that asserts a typo can only ever
      // narrow. `1-2-3` is refused here for the same reason: silently reading
      // the first two parts is how a nonsense expression gets a meaning.
      const halves = spec.split('-');
      if (halves.length !== 2 || !halves[0].length || !halves[1].length) return null;
      start = Number(halves[0]);
      end = Number(halves[1]);
    } else {
      if (!/^[0-9]+$/.test(spec)) return null;
      start = Number(spec);
      end = stepText === undefined ? start : hi;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < lo || end > hi || start > end) return null;
    for (let value = start; value <= end; value += step) out.add(value);
  }
  return out;
}

/** A five-field expression → its five sets, or null if any field is malformed. */
export function parseCron(expression) {
  if (typeof expression !== 'string') return null;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets = fields.map((field, index) => cronField(field, index));
  if (sets.some((set) => set === null)) return null;
  return /** @type {Set<number>[]} */ (sets);
}

/**
 * Does this expression fire at `at` (to the minute)?
 *
 * The day-of-month / day-of-week rule is Vixie cron's, and it is the one thing
 * about cron that surprises everybody: when BOTH are restricted the match is a
 * UNION, not an intersection — `0 0 1 * 1` is the first of the month AND every
 * Monday. Copying the surprise is right; a console that quietly disagreed with
 * the crontab a person already has would be worse than one that has no cron.
 */
export function cronMatches(parsed, at) {
  if (!parsed) return false;
  const [minutes, hours, doms, months, dows] = parsed;
  if (!minutes.has(at.getMinutes())) return false;
  if (!hours.has(at.getHours())) return false;
  if (!months.has(at.getMonth() + 1)) return false;
  const day = at.getDay();
  const domRestricted = doms.size !== 31;
  const dowRestricted = dows.size !== 8;
  const domHit = doms.has(at.getDate());
  const dowHit = dows.has(day) || (day === 0 && dows.has(7));
  if (domRestricted && dowRestricted) return domHit || dowHit;
  if (domRestricted) return domHit;
  if (dowRestricted) return dowHit;
  return true;
}

/**
 * Parsed expressions, memoized by their text.
 *
 * `nextOpening` evaluates `openAt` once per minute for eight days, and each of
 * those looks back over the opening's life — so a policy with one cron line and
 * a sixty-minute opening asks this question about 690,000 times. Parsing per
 * call turned a millisecond answer into a second-long one; the expressions are
 * a handful of short strings that never change, so the cache is unbounded on
 * purpose and holds nothing worth evicting.
 */
const CRON_CACHE = new Map();

function cronSets(policy) {
  const out = [];
  for (const expression of policy.cron ?? []) {
    if (typeof expression !== 'string') continue;
    if (!CRON_CACHE.has(expression)) CRON_CACHE.set(expression, parseCron(expression));
    const parsed = CRON_CACHE.get(expression);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Is a cron opening live at `at`? An opening that fired `cronMinutes` ago is
 * still open, so the answer looks backwards over that many minutes rather than
 * only at this exact minute — otherwise a policy would admit for one minute a
 * day and every phase not already queued at that second would miss it.
 *
 * One Date, moved with `setTime`, rather than one per minute looked at: this is
 * the hot loop of the forward scan, and the allocations were most of its cost.
 */
function cronOpen(policy, at) {
  const expressions = cronSets(policy);
  if (!expressions.length) return false;
  const life = cronMinutesOf(policy);
  const cursor = new Date(at.getTime());
  for (let back = 0; back < life; back++) {
    cursor.setTime(at.getTime() - back * MINUTE_MS);
    for (const parsed of expressions) if (cronMatches(parsed, cursor)) return true;
  }
  return false;
}

/** The opening length, coerced: a non-positive or absent value is the default. */
export function cronMinutesOf(policy) {
  const raw = policy?.cronMinutes;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_CRON_MINUTES;
}

/* ------------------------------------------------------------------ *
 * The question the scheduler asks
 * ------------------------------------------------------------------ */

/** Does this policy say anything at all? An empty one is not a schedule. */
export function policyStated(policy) {
  if (!policy || policy.enabled !== true) return false;
  return Boolean(policy.windows?.length || policy.cron?.length || policy.quiet?.length);
}

/** Open at this instant, ignoring what happens next. Pure, no allocation of dates beyond one. */
export function openAt(policy, nowMs) {
  if (!policyStated(policy)) return true;
  const at = new Date(nowMs);
  for (const window of policy.quiet ?? []) if (windowCovers(window, at)) return false;
  const allow = policy.windows ?? [];
  const hasAllow = allow.length > 0 || (policy.cron ?? []).length > 0;
  if (!hasAllow) return true;
  for (const window of allow) if (windowCovers(window, at)) return true;
  return cronOpen(policy, at);
}

/**
 * The next minute this policy is open, or null if there is none within
 * `SCAN_DAYS`.
 *
 * A forward minute scan rather than arithmetic over the windows: the three
 * rules already compose in `openAt`, and asking it repeatedly cannot disagree
 * with itself the way a second implementation of the same rules would. Eight
 * days is 11,520 evaluations — about a millisecond — and the cases it cannot
 * answer (a monthly cron) get a null, which the caller reads as "no timer, the
 * idle poll will find it" rather than as "never".
 */
export function nextOpening(policy, nowMs) {
  if (!policyStated(policy)) return nowMs;
  const start = Math.ceil(nowMs / MINUTE_MS) * MINUTE_MS;
  const limit = SCAN_DAYS * 24 * 60;
  for (let step = 0; step <= limit; step++) {
    const when = start + step * MINUTE_MS;
    if (openAt(policy, when)) return when;
  }
  return null;
}

/**
 * The whole answer, in the shape the queue page renders: whether a phase may
 * board, and when it may if it may not.
 *
 * `reason` is a sentence, not a code — it is shown verbatim beside a phase that
 * is not starting, and "outside the boarding window" with no time attached is
 * exactly the unhelpful half-answer this feature exists to replace.
 *
 * @returns {{ open: boolean, opensAt: number|null, reason: string|null }}
 */
export function scheduleState(policy, nowMs) {
  if (!policyStated(policy)) return { open: true, opensAt: nowMs, reason: null };
  if (openAt(policy, nowMs)) return { open: true, opensAt: nowMs, reason: null };
  const opensAt = nextOpening(policy, nowMs);
  const quiet = (policy.quiet ?? []).some((window) => windowCovers(window, new Date(nowMs)));
  const what = quiet ? 'quiet hours' : 'the boarding schedule';
  return {
    open: false,
    opensAt,
    reason:
      opensAt === null
        ? `${what} — nothing opens in the next ${SCAN_DAYS} days`
        : `${what} — boarding opens ${describeOpening(opensAt, nowMs)}`,
  };
}

/** Day names, for an opening that is not today. Indexed by `Date.getDay()`. */
export const DAY_NAMES = Object.freeze([
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]);

/**
 * "09:00", "tomorrow 09:00", "Monday 09:00" — the opening as a person reads it.
 *
 * A bare time is a real ambiguity here and not a cosmetic one: an operator who
 * reads "boarding opens 09:00" at 09:30 on Saturday, against a weekdays-only
 * window, concludes the console is broken. The day is the difference between a
 * queue that explains itself and one that appears stuck.
 */
export function describeOpening(opensAt, nowMs) {
  const at = new Date(opensAt);
  const clock = formatHhMm(at.getHours() * 60 + at.getMinutes());
  const now = new Date(nowMs);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.floor((at.getTime() - midnight) / 86_400_000);
  if (days <= 0) return clock;
  if (days === 1) return `tomorrow ${clock}`;
  if (days < 7) return `${DAY_NAMES[at.getDay()]} ${clock}`;
  return `${DAY_NAMES[at.getDay()]} ${clock}, ${days} days from now`;
}

/**
 * Coerce whatever was in `config.json` into a policy, dropping what cannot be
 * read. The same discipline as `sanitiseAutomation`: a malformed window is
 * DROPPED rather than defaulted, because a window nobody can parse must never
 * become a window that admits everything.
 *
 * @param {unknown} value
 * @returns {Required<SchedulePolicy>}
 */
export function sanitiseSchedule(value) {
  const raw = value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
  /**
   * A `for` loop rather than `map().filter(Boolean)`: the filter is invisible to
   * the type checker, so the array kept a `| null` member and every consumer
   * had to re-narrow a thing that cannot be null.
   * @param {unknown} list
   * @returns {BoardingWindow[]}
   */
  const windows = (list) => {
    /** @type {BoardingWindow[]} */
    const out = [];
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry || typeof entry !== 'object') continue;
      const from = parseHhMm(/** @type {{from?: unknown}} */ (entry).from);
      const to = parseHhMm(/** @type {{to?: unknown}} */ (entry).to);
      if (from === null || to === null) continue;
      const days = /** @type {{days?: unknown}} */ (entry).days;
      const clean = Array.isArray(days)
        ? [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
        : [];
      out.push({ ...(clean.length ? { days: clean } : {}), from: formatHhMm(from), to: formatHhMm(to) });
    }
    return out;
  };
  /** @type {string[]} */
  const cron = [];
  for (const expression of Array.isArray(raw.cron) ? raw.cron : []) {
    if (parseCron(expression) === null) continue;
    cron.push(String(expression).trim().split(/\s+/).join(' '));
  }
  return {
    enabled: raw.enabled === true,
    windows: windows(raw.windows),
    quiet: windows(raw.quiet),
    cron,
    cronMinutes: cronMinutesOf(raw),
  };
}
