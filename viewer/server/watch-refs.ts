/**
 * Machine-checkable watch refs — the `watch` list a session declares with
 * `phase-outcome.sh … --watch gh:owner/repo#run/123`.
 *
 * The ladder has promised this since the rung table was written
 * (`blocked-declared:external` → "Park and poll the refs … resumes the own
 * session when they land. Free."), and until now the promise was a stub: the
 * healer had no way to READ a ref, so an elapsed wait's only move was to board
 * a $10 session to run `gh run view` by hand — measured at three sessions in
 * one night re-confirming the same production outage, then the ladder budget
 * "spent" on a phase nothing was wrong with.
 *
 * ## The scheme table — what each one means by LANDED, and what it trusts
 *
 * | scheme | shape | landed when | trust |
 * |---|---|---|---|
 * | `gh:` | `gh:owner/repo#run/<id>` · `gh:owner/repo#pr/<n>` | the run reaches `completed` (whatever its conclusion) · the PR leaves `OPEN` | fixed argv, never a shell |
 * | `date:` / `until:` | `date:<ISO8601>` | `now ≥ t` | arithmetic; nothing is executed |
 * | `lock:` | `lock:<slug>/<phase>` | nothing holds the phase's scope any more | the console's own lock store — NOT a grant |
 * | `phase:` | `phase:<slug>/<phase>` | the console's RECORD of that phase reads `done` — after its own §Verification, which re-opens a red one | the console's own run state; nothing is executed |
 * | `verify:` | `verify:<slug>/<phase>` (the declaring phase) | its red §Verification lines, re-run when the branch head moves, all pass | the policy §Verification gets, only on a new head |
 * | `cmd:` | `cmd:<command>` or `cmd:"<command>"` | the command exits 0 | the policy §Verification gets, 60 s, off-switchable, run-bounded |
 *
 * `lock:` is true of a sibling that is merely QUEUED, so it cannot say "that
 * phase is done" — `phase:` can (control-tower phase 88, #129), and it is
 * re-probed the moment the board moves (`WatchScheduler.boardMoved`). A
 * `phase:` ref UN-lands when its phase is re-opened.
 *
 * "Landed" always means the thing CONCLUDED. A run merely starting is not a
 * landing; a session resumed to watch a progress bar is the burn this exists
 * to stop. A failure IS a landing — the wait is over and the session must look.
 *
 * ## Three states, and the fourth that is not a state
 *
 * A probe that cannot answer (no `gh`, no auth, a deleted run, no resolver
 * wired) is `unknown`, and the caller treats unknown exactly as it behaved
 * before this module existed. Degrading to the old behaviour is the failure
 * mode. `refused` is different and it is terminal: the read-only policy — or
 * the operator's `watchCmdRefs` switch — said this console will never run this
 * command, and re-asking every minute would be the console arguing with its own
 * policy. It is journalled once and the ref is dropped from the rotation.
 *
 * ## `cmd:` is an execution surface, and it is the only one here
 *
 * Until 2026-08-30 this module deliberately refused to run recorded shell
 * strings on a timer. What changed is not the judgement but the machinery: the
 * command goes through the SAME policy and the same spawn `verify.ts` uses for
 * a plan's §Verification (`runSingleCommand`) — a denylist of mutating verbs, an
 * inverted allowlist for the verbs that reach off this machine, no shell
 * metacharacter it cannot read, a process GROUP kill on the timeout — so a
 * `cmd:` ref can do nothing a §Verification bullet in the same plan could not
 * already do, unattended, on the same clock.
 *
 * ⚠️ That is NOT the same as "read-only", and the difference matters here in a
 * way it does not for a §Verification block: `npm ci`, `cargo build` and
 * `uv sync` all pass the policy and all write, and a §Verification runs once
 * where a `cmd:` ref runs for as long as the phase is parked. So it carries
 * gates that nothing else here does — `--allow-run`, the `watchCmdRefs` pref,
 * a cadence that backs off (`WATCH_CMD_BACKOFF_MS`), the phase's wait budget
 * and a `MAX_CMD_RUNS_PER_PHASE` backstop — because it is the one scheme whose
 * refs are WRITTEN by a session rather than read by one.
 */

import type { WatchStateWord } from '../shared/run-lifecycle.js';
import { budgetClause } from '../shared/ci-refusal.js';
import { waitBudgetEndOf } from './runner/wait-budget.ts';
import { shell } from './shell.ts';
import { parseUnitRef, UNIT_POLL_MS, type UnitTarget } from './watch-unit.ts';

/**
 * Every scheme this console will poll. The list is written here and nowhere
 * else. `unit` (control-tower phase 121, #181) is a systemd unit on another
 * machine, read over ssh (`watch-unit.ts`).
 */
export const WATCH_SCHEMES = ['gh-run', 'gh-pr', 'date', 'lock', 'phase', 'verify', 'cmd', 'unit'] as const;
export type WatchScheme = (typeof WATCH_SCHEMES)[number];

export type WatchRefTarget =
  | { kind: 'gh-run'; repo: string; id: string; ref: string }
  | { kind: 'gh-pr'; repo: string; number: string; ref: string }
  /** `at` is epoch ms — parsed once here so no consumer re-parses a string. */
  | { kind: 'date'; at: number; ref: string }
  | { kind: 'lock'; slug: string; phase: number; ref: string }
  | { kind: 'phase'; slug: string; phase: number; ref: string }
  | { kind: 'verify'; slug: string; phase: number; ref: string }
  | { kind: 'cmd'; command: string; ref: string }
  /** `unit:<host>/<unit>` — the host is a NAME the machine profile resolves, never an address. */
  | UnitTarget;

export type WatchState = {
  ref: string;
  state: WatchStateWord;
  /** What the probe saw, for the journal and the resume brief ("completed: failure"). */
  detail?: string;
  /**
   * A merged pull request's merge commit — what the landing ledger's
   * `pr-merged --sha` records (many-plans-one-repo phase 8). Only a `gh-pr`
   * probe that saw `MERGED` sets it.
   */
  mergeCommit?: string;
  /**
   * A `gh-run` GitHub never started (control-tower phase 111, #166): every
   * failed job with no runner and no step, under the "job was not started"
   * annotation. The verdict is then a wait, never a landing — there is no
   * result to read — and the row keeps this, which the errand, the landing
   * on room and the Tower's one-per-repository state all read.
   */
  notRun?: CiNotRun;
  /**
   * How a `unit:` ref's job ended (control-tower phase 121) — `Result=` and the
   * exit time, which the wait history keeps (`recordUnitExit`). Only a landed
   * `unit:` verdict carries it, and it never names the host's address or user.
   */
  unit?: { result: string; exitedAt?: string };
};

/** An Actions budget the token could read for a refused run's repository. */
export type CiBudget = {
  scope: 'repository' | 'organization';
  /** `owner/name` for a repository budget, the organization's login for its own. */
  name: string;
  /** Dollars. */
  amount: number;
  consumed: number;
  /** `prevent_further_usage` — the budget stops jobs at the limit rather than alerting. */
  stops: boolean;
};

/** Why GitHub did not start a watched run — what the probe read (#166). */
export type CiNotRun = {
  /** One word (`CI_NOT_RUN_CAUSES`, `shared/ci-refusal.js`). */
  cause: 'billing';
  repo: string;
  /** The workflow run id. */
  run: string;
  /** The run attempt the refusal was read on, when the jobs say. */
  attempt?: number;
  /** Failed jobs with no runner and no step. */
  jobs: number;
  /** GitHub's own sentence, from the first such job's annotation. */
  annotation: string;
  /** The Actions budgets naming this repository or its organization, repository first. */
  budgets?: CiBudget[];
  /** Why no budget could be read — the endpoint and its answer. */
  unreadable?: string;
  /**
   * Every stopping budget read has room (true); one is spent (false); absent
   * when nothing could be read. A landing is the move from false to true —
   * room at first sight says the budget is not what refused the run.
   */
  headroom?: boolean;
};

/**
 * How often each scheme is worth re-asking, in ms.
 *
 * `date` is absent on purpose: its due time IS its instant, so the scheduler
 * schedules it exactly once (see `nextDueFor`). The others are chosen against
 * what they cost — `gh` is a network round trip and a rate-limited one, `cmd`
 * may be a whole test command, and a lock is a file read. `cmd` is the FIRST
 * step of its back-off (`WATCH_CMD_BACKOFF_MS`), not a flat cadence.
 */
export const WATCH_POLL_MS: Readonly<Record<WatchScheme, number>> = Object.freeze({
  'gh-run': 120_000,
  'gh-pr': 300_000,
  date: 0,
  lock: 60_000,
  // A read of the console's own run record — and a board transition asks it
  // at once besides (`WatchScheduler.boardMoved`), so the minute is a backstop.
  phase: 60_000,
  // A `git rev-parse` per ask; the lines themselves run only on a new head.
  verify: 120_000,
  cmd: 300_000,
  // One `systemctl show` over the host's multiplexed ssh — a fixed cadence.
  unit: UNIT_POLL_MS,
});

/**
 * Phase statuses the watch clock will never probe — and therefore statuses whose
 * stored rows nothing will ever advance.
 *
 * It lives HERE, not in `watch-scheduler.ts`, because `converge.ts` needs the
 * same answer and importing the scheduler would be a cycle. Two readers, one
 * list: the scheduler skips these phases, and the evidence fingerprint skips
 * their rows — without which a `pending` row left on a phase that moved to
 * `done` makes the fingerprint change every minute for ever and defeats the
 * healer's noop latch permanently (QA F3).
 *
 * Written as the words that are NOT watchable because that half is short and
 * stable: a running phase has its own session looking, and a finished one has
 * nothing left to resume. Everything else — `parked` (what a `needs-human`
 * declaration leaves), `pending` (a `blocked`+`lock:` one), `waiting`, `failed`,
 * `interrupted`, `queued` — is watched.
 */
export const WATCH_INELIGIBLE_STATUSES: ReadonlySet<string> =
  new Set(['done', 'skipped', 'running', 'verifying', 'gated']);

/**
 * Is this phase watchable — its status not on the list above, OR a DONE phase
 * whose landing is waiting on its pull request (many-plans-one-repo phase 8)?
 * The one exception to "a finished phase has nothing left to resume": the
 * work is done and what is still open is the world's answer to `gh:…#pr/<n>`,
 * which the landing ledger records the moment it lands. Both readers of the
 * status set — the scheduler and the evidence fingerprint — ask this, so a
 * landing's row is probed and its due time is counted, or neither is.
 */
export function watchEligible(record: { status: string; landing?: { step?: string } }): boolean {
  if (!WATCH_INELIGIBLE_STATUSES.has(record.status)) return true;
  return record.status === 'done' && record.landing?.step === 'watch';
}

/**
 * Row STATES the scheduler never advances — the row-level twin of
 * `WATCH_INELIGIBLE_STATUSES`, which lists phase statuses (SLF-7). A `refused`
 * row is terminal: the policy, the operator's switch or the run cap said this
 * console will never probe it again, so nothing moves its `nextDueAt`. Left in
 * the evidence fingerprint's `soonest` scan, a refused `cmd:` row past its due
 * read as "due" on every pass and moved the term every minute for ever — on a
 * still-parked phase the healer converged once a minute indefinitely.
 */
export const WATCH_INELIGIBLE_ROW_STATES: ReadonlySet<string> = new Set(['refused']);

/**
 * How soon a fresh LANDING is re-offered to the healer — the first step of
 * `WATCH_REDELIVER_SERIES_MS`. See `nextDueFor` and `redeliverAfter`.
 */
export const WATCH_REDELIVER_MS = 60_000;

/**
 * The re-offer clock after the healer's drive REJECTED a landing (SLF-8, RCV-8):
 * one minute, two, five, fifteen, thirty — indexed by how many times this
 * landing's drive has rejected. A flat minute retried a foreign-lock rejection
 * sixty times an hour for the whole lease (134 warnings in 108 minutes); the
 * series is the floor, and a rejection that names its own clock (a lease's end)
 * waits for that instead when it is later — `redeliverAfter`.
 */
export const WATCH_REDELIVER_SERIES_MS: readonly number[] = Object.freeze([60_000, 120_000, 300_000, 900_000, 1_800_000]);

/**
 * When a rejected landing is next offered: the series step for this many
 * rejections (the last step repeats), or the rejection's own clock when that is
 * later — a foreign lock's `lease_until` is the moment the rejection stops
 * being true, and a minute before it is a minute wasted.
 */
export function redeliverAfter(rejections: number, now: number, until?: number | null): number {
  const step = WATCH_REDELIVER_SERIES_MS[Math.min(Math.max(rejections, 1), WATCH_REDELIVER_SERIES_MS.length) - 1];
  const due = now + step;
  return typeof until === 'number' && Number.isFinite(until) && until > due ? until : due;
}

/** The floor the scheduler's own timer never goes below, however near a ref is due. */
export const WATCH_FLOOR_MS = 60_000;

/** How long a `cmd:` ref's command may run before it is killed and read as unknown. */
export const WATCH_CMD_TIMEOUT_MS = 60_000;

/**
 * The `cmd:` cadence: five minutes after the first run, fifteen after the
 * second, an hour after the third, then six hours for as long as the phase's
 * wait budget lasts (control-tower phase 6, #19). Indexed by how many times
 * the command has RUN — a probe that executed nothing stays on the first step.
 *
 * This replaced a flat five minutes capped at twelve runs, which was one hour
 * of watching: the measured case was an organisation's plan restored after a
 * day, a `cmd:` ref refused after its twelfth run, and the one probe that
 * would have noticed the fix gone before the fix arrived. A wait that is an
 * external WALL is measured in days, and what keeps a days-long `cmd:` ref
 * cheap is the cadence, not a count — a day costs seven runs.
 */
export const WATCH_CMD_BACKOFF_MS: readonly number[] = Object.freeze([300_000, 900_000, 3_600_000, 21_600_000]);

/** The back-off step after `runs` executions — the last step repeats. */
export function cmdBackoffMs(runs: number): number {
  return WATCH_CMD_BACKOFF_MS[Math.min(Math.max(runs, 1), WATCH_CMD_BACKOFF_MS.length) - 1];
}

/**
 * The back-off step `elapsedMs` after the declared window ENDED — the same
 * steps, anchored at the window's end rather than counted in runs (#87). A
 * window asked often by design, so the runs it made say how busy it was and
 * nothing about how long the wait has been overdue: the next probe after an
 * hour-long window is five minutes out, not the six hours its twelfth run
 * would read. The steps fall on +5, +20, +80 and +440 minutes past the end,
 * then every six hours — phase 6's schedule, moved to where it belongs.
 */
export function cmdBackoffAfterMs(elapsedMs: number): number {
  let edge = 0;
  for (const step of WATCH_CMD_BACKOFF_MS) {
    edge += step;
    if (elapsedMs < edge) return step;
  }
  return WATCH_CMD_BACKOFF_MS[WATCH_CMD_BACKOFF_MS.length - 1];
}

/**
 * How often a `cmd:` ref that wraps `gh run` or `gh pr` is asked inside its
 * window (#87): a workflow or a pull request is the one thing such a ref
 * reads, and it moves on `gh`'s clock, not on a back-off's.
 */
export const WATCH_CMD_GH_MS = 300_000;

/**
 * Does this command ask `gh` about a run or a pull request? Read as a word at
 * a command boundary — the start, after a separator, or inside a quoted
 * `bash -c` — so `gh api …` and `echo gh-runner` are not.
 */
export function cmdWrapsGh(command: string): boolean {
  return /(^|[\s;&|(`$'"])gh\s+(run|pr)\b/.test(command);
}

/** A declaration's window: its own instant to the clock it asked for, epoch ms. */
export type DeclaredWindow = { from: number; until: number };

/**
 * The window a phase's declaration asked for (#87) — from the declaration's
 * own instant to the instant it named (`declared.requested`, what
 * `--wait-minutes`/`--until` wrote), else to the clock the park wrote
 * (`parkedUntil`). Null when either end is missing or the window is empty: a
 * park whose budget is spent waits with no clock (rule 7), and its refs keep
 * the plain run-count back-off.
 *
 * CLAMPED to the wait budget's end (control-tower phase 87, #126): P41 asked
 * for twelve hours against an eight-hour budget, so its `cmd:` step was a sixth
 * of twelve hours, and the probe that should have run before the budget ended
 * fell after it — refused, the ref retired. The window a park is watched in is
 * the one it can actually have: what it asked, or the budget's end, whichever
 * comes first. A spent-budget park and a wait on console state alone have no
 * budget end (`waitBudgetEndOf`), so nothing clamps them.
 */
export function declaredWindowOf(record: {
  parkedUntil?: string | null;
  declared?: { at?: string; requested?: string; budgetSpent?: unknown; status?: string; step?: { until?: string } | null } | null;
}): DeclaredWindow | null {
  const from = Date.parse(record.declared?.at ?? '');
  let until = Date.parse(record.declared?.requested ?? record.parkedUntil ?? '');
  if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from) return null;
  // The stored record carries everything `waitBudgetEndOf` reads; a caller
  // holding only the two stamps gets the console default, which is what an
  // unstamped declaration was judged against. A park on a HUMAN STEP has no
  // budget (control-tower phase 43): its window's end is the clamp.
  const stepUntil = record.declared?.status === 'needs-human' ? Date.parse(record.declared.step?.until ?? '') : NaN;
  const end = record.declared?.budgetSpent ? null
    : Number.isFinite(stepUntil) ? stepUntil
      : waitBudgetEndOf(record as Parameters<typeof waitBudgetEndOf>[0]);
  if (end !== null && end < until) until = end;
  return until > from ? { from, until } : null;
}

/**
 * The next step of one `cmd:` ref (#87). Inside the declared window it is at
 * most a sixth of the window — six looks at least, so a landing near the end
 * is still seen before the window resumes the session anyway — and at most
 * five minutes for a ref that wraps `gh run`/`gh pr`; never more than the
 * back-off step, and never under the scheduler's own floor. After the window,
 * the back-off, counted from the window's end. With no window, the run-count
 * back-off phase 6 wrote.
 */
export function cmdStepMs(command: string, runs: number, now: number, window?: DeclaredWindow | null): number {
  if (!window) return cmdBackoffMs(runs);
  if (now >= window.until) return cmdBackoffAfterMs(now - window.until);
  const sixth = Math.max(WATCH_FLOOR_MS, Math.floor((window.until - window.from) / 6));
  const step = Math.min(cmdBackoffMs(runs), sixth);
  return cmdWrapsGh(command) ? Math.min(step, WATCH_CMD_GH_MS) : step;
}

/**
 * The BACKSTOP on one `cmd:` ref's executions for one phase — not the bound a
 * wait normally meets.
 *
 * The other four schemes read something; this one RUNS something, and the
 * policy it goes through is not "read-only" in the strict sense (`npm ci`,
 * `cargo build` and `uv sync` all pass it and all write). What bounds it in
 * the ordinary case is the back-off above and the phase's WAIT BUDGET: past the
 * budget the ref reads `refused` with words saying so (`watch-scheduler.ts`).
 * Two hundred runs is seven weeks at the six-hour step — a number only a
 * runaway reaches (a budget nobody meant, a record from a console that never
 * wrote one), and past it the ref reads `refused` too, which is a state the
 * operator can see rather than a silence. Until control-tower phase 6 this was
 * twelve, and terminal: an hour of watching for a wait measured in days.
 */
export const MAX_CMD_RUNS_PER_PHASE = 200;

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A ref's ISO instant, or NaN.
 *
 * `Date.parse` accepts a great deal that is not an instant at all (`Date.parse('run')`
 * is NaN, but `Date.parse('2026')` is a year), so the shape is checked first:
 * a `date:` ref is an ISO8601 timestamp, which is what `phase-outcome.sh --until`
 * writes and what the script's own bash-3.2 check accepts.
 */
function parseInstant(text: string): number {
  const shape = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(text);
  if (!shape) return NaN;
  const at = Date.parse(text.replace(' ', 'T'));
  if (!Number.isFinite(at)) return NaN;
  // Shape is not sense, and V8 will not tell you: an out-of-range ISO day falls
  // through to the legacy parser and ROLLS OVER, so `date:2026-09-31` (September
  // has thirty days) silently becomes October 1st and the phase waits a day
  // longer than the session asked for — with nothing anywhere saying why. Read
  // the calendar's answer back and refuse a ref that did not survive the trip.
  //
  // A bare `HH:MM` with no zone is LOCAL time, deliberately: it is what a
  // person means by "not before 09:00", and it is what `Date` does. The
  // round-trip below is done in the same frame the parse used, so it agrees
  // either way.
  //
  // Read back in the ref's OWN frame, which is the whole difficulty. A bare
  // `HH:MM` is local; a `Z` is UTC; and `+03:00` is neither — comparing its UTC
  // components against a wall clock three hours ahead refused
  // `date:2026-09-15T01:00:00+03:00` outright, with no journal and no errand,
  // which is precisely the silence this check was added to end (QA F5). So the
  // offset is applied first and the comparison is done once, in UTC, against
  // the same instant the string names.
  const zone = /([Zz])$|([+-])(\d{2}):?(\d{2})$/.exec(text);
  let shifted = at;
  if (zone && !zone[1]) {
    const sign = zone[2] === '-' ? -1 : 1;
    shifted = at + sign * (Number(zone[3]) * 60 + Number(zone[4])) * 60_000;
  }
  const back = new Date(shifted);
  const local = !zone;
  const [y, mo, d] = local
    ? [back.getFullYear(), back.getMonth() + 1, back.getDate()]
    : [back.getUTCFullYear(), back.getUTCMonth() + 1, back.getUTCDate()];
  if (y !== Number(shape[1]) || mo !== Number(shape[2]) || d !== Number(shape[3])) return NaN;
  return at;
}

/** One declared ref, parsed — or null for anything this console will not poll. */
export function parseWatchRef(ref: string): WatchRefTarget | null {
  if (typeof ref !== 'string') return null;
  if (ref.startsWith('gh:')) {
    const body = ref.slice(3);
    const hash = body.indexOf('#');
    if (hash <= 0) return null;
    const repo = body.slice(0, hash);
    if (!REPO_RE.test(repo)) return null;
    const rest = body.slice(hash + 1);
    const run = /^run\/(\d+)$/.exec(rest);
    if (run) return { kind: 'gh-run', repo, id: run[1], ref };
    const pr = /^pr\/(\d+)$/.exec(rest);
    if (pr) return { kind: 'gh-pr', repo, number: pr[1], ref };
    return null;
  }
  // Two spellings of one scheme. `--until` writes an instant and a session
  // declaring "not before 09:00" writes the same thing; making them two
  // vocabularies would only mean two of everything below.
  if (ref.startsWith('date:') || ref.startsWith('until:')) {
    const at = parseInstant(ref.slice(ref.indexOf(':') + 1).trim());
    return Number.isFinite(at) ? { kind: 'date', at, ref } : null;
  }
  for (const kind of ['lock', 'phase', 'verify'] as const) {
    if (!ref.startsWith(`${kind}:`)) continue;
    const m = /^([^/]+)\/(\d+)$/.exec(ref.slice(kind.length + 1).trim());
    if (!m || !SLUG_RE.test(m[1])) return null;
    const phase = Number(m[2]);
    return Number.isSafeInteger(phase) && phase > 0 ? { kind, slug: m[1], phase, ref } : null;
  }
  if (ref.startsWith('unit:')) return parseUnitRef(ref);
  if (ref.startsWith('cmd:')) {
    // The conventional spelling quotes the command (`cmd:"npm test"`), because
    // that is what reads well in a `--watch` argument; the quotes are the
    // ref's punctuation and never part of what runs.
    let command = ref.slice(4).trim();
    if (command.length >= 2 && /^(["']).*\1$/.test(command)) command = command.slice(1, -1).trim();
    return command ? { kind: 'cmd', command, ref } : null;
  }
  return null;
}

/**
 * A declaration's BACKSTOP (control-tower phase 121, #181's cheaper variant):
 * a `date:` beside at least one LIVE ref. The live refs wake the phase the
 * moment one lands; the date — the latest, when there are several — only
 * bounds the wait. Null when the declaration is a date alone (a clock) or has
 * no date (nothing bounds it but the budget).
 */
export function backstopOf(refs: readonly string[]): { backstop: string; live: string[] } | null {
  const targets = pollableRefs(refs);
  const live = liveRefs(refs).map((target) => target.ref);
  let latest: Extract<WatchRefTarget, { kind: 'date' }> | undefined;
  for (const target of targets) {
    if (target.kind === 'date' && (!latest || target.at > latest.at)) latest = target;
  }
  return latest && live.length ? { backstop: latest.ref, live } : null;
}

/**
 * A backstop that PASSED with its live refs still out is not the thing the
 * phase waited for: its landing says so — the date, and each live ref that has
 * not landed with what it last read — so the resumed session is never told
 * "the wait is over" about a job that is still running.
 */
export function backstopVerdict(
  record: { declared?: { watch?: readonly string[] } | null; watchState?: { refs: readonly { ref: string; state: string; detail?: string }[] } | null },
  target: WatchRefTarget,
  verdict: WatchState,
): WatchState {
  if (target.kind !== 'date' || verdict.state !== 'landed') return verdict;
  const pair = backstopOf(record.declared?.watch ?? []);
  if (!pair || pair.backstop !== target.ref) return verdict;
  const rows = record.watchState?.refs ?? [];
  const out = pair.live.filter((ref) => rows.find((row) => row.ref === ref)?.state !== 'landed');
  if (!out.length) return verdict;
  const said = out.map((ref) => {
    const detail = rows.find((row) => row.ref === ref)?.detail;
    return `${ref} has NOT landed${detail ? ` (${detail})` : ''}`;
  }).join('; ');
  return { ...verdict, detail: `the backstop passed (${verdict.detail ?? new Date(target.at).toISOString()}) — ${said}`.slice(0, 400) };
}

/** The shapes, in words — what a person needs beside a ref nothing can poll. */
export const WATCH_REF_SHAPES =
  'gh:<owner/repo>#run/<id> · gh:<owner/repo>#pr/<n> · date:<ISO8601> · lock:<slug>/<phase> · phase:<slug>/<phase> · verify:<slug>/<phase> · cmd:"<command>" · unit:<host>/<unit>';

/**
 * Why `parseWatchRef` would not poll this ref, or null when it would.
 *
 * `parseWatchRef` answers null for every refusal and its readers need nothing
 * more; the park needs the REASON, because a declared ref that nothing will ever
 * probe used to be dropped without a word (WAI-11) — a session that said exactly
 * how to know its wait was over got silence and a clock instead.
 */
export function watchRefProblem(ref: string): string | null {
  if (typeof ref !== 'string' || !ref.trim()) return 'an empty ref';
  if (parseWatchRef(ref)) return null;
  if (ref.startsWith('gh:')) return 'a gh: ref is gh:<owner/repo>#run/<id> or gh:<owner/repo>#pr/<n>';
  if (ref.startsWith('date:') || ref.startsWith('until:')) return 'not a real ISO8601 instant (date:2026-09-20T06:00:00Z)';
  for (const kind of ['lock', 'phase', 'verify']) {
    if (ref.startsWith(`${kind}:`)) return `a ${kind}: ref is ${kind}:<slug>/<phase>`;
  }
  if (ref.startsWith('cmd:')) return 'a cmd: ref names no command';
  return `no watch scheme — the console polls ${WATCH_REF_SHAPES}`;
}

/** The longest ref `phase-outcome.sh` records (`WATCH_REF_MAX`) — a longer one is refused, never cut (#125). */
export const WATCH_REF_MAX = 1000;

/**
 * The first word of a command that is a path relative to the working
 * directory, or null — `phase-outcome.sh` `_relative_path_in`'s twin (#152).
 * The console runs a `cmd:` ref from ITS root, so a path relative to the
 * session's cwd names another file there, or none. Words are read with the
 * quotes dropped; a flag, a URL, an assignment, `owner/repo` after `-R`/
 * `--repo` and a sed expression are not paths.
 */
export function relativePathIn(command: string): string | null {
  const words = command.replace(/["']/g, ' ').split(/\s+/).filter(Boolean);
  let prev = '';
  for (const word of words) {
    const after = prev;
    prev = word;
    if (after === '-R' || after === '--repo') { prev = word; continue; }
    if (word.startsWith('./') || word.startsWith('../')) return word;
    if (/^(\/|~|-)/.test(word) || word.includes('://') || word.includes('=') || /^[sy]\//.test(word)) continue;
    if (!word.includes('/') || /[^A-Za-z0-9._/@+-]/.test(word)) continue;
    if (/\/.*\//.test(word) || /\.[A-Za-z0-9]{1,8}$/.test(word)) return word;
  }
  return null;
}

/**
 * Why the console could not run a `cmd:` ref AS WRITTEN, or null — the
 * shapes `phase-outcome.sh` refuses with exit 2 (`_cmd_ref_problem`) and the
 * console never MINTS (control-tower phase 88, #125, #152, #121 item 3). A
 * `cmd:` ref is self-contained: absolute paths, no shell variable, no
 * substitution, every quote closed. The run policy (`verify.ts`) is the second
 * judge, asked at declaration by the ingest probe.
 */
export function cmdRefProblem(command: string): string | null {
  if (command.includes('$')) {
    return 'it carries a shell variable or substitution ($) — the console runs a cmd: ref in a shell of its own, where the session\'s variables do not exist';
  }
  if (command.includes('`')) return 'it carries a command substitution (a backtick) whose inner command the console cannot judge';
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (!quote) {
      if (c === '\\') i++;
      else if (c === '\'' || c === '"') quote = c;
    } else if (quote === '\'') {
      if (c === '\'') quote = '';
    } else if (c === '\\') i++;
    else if (c === '"') quote = '';
  }
  if (quote) return 'its quoting does not balance (a quote never closes) — the console would refuse it as unreadable';
  const rel = relativePathIn(command);
  return rel ? `it names a relative path (${rel}) — the console runs a cmd: ref from its own root, not the session's working directory` : null;
}

/** The declared refs nothing will poll, each with why — in declaration order, deduped. */
export function unpollableRefs(refs: readonly string[] | undefined | null): { ref: string; reason: string }[] {
  const seen = new Set<string>();
  const out: { ref: string; reason: string }[] = [];
  for (const ref of refs ?? []) {
    const reason = watchRefProblem(ref);
    if (!reason || seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, reason });
  }
  return out;
}

/** A `date:`/`until:` ref's instant, or null for any other ref — what a countersign reads. */
export function dateOfRef(ref: string): number | null {
  const target = parseWatchRef(ref);
  return target?.kind === 'date' ? target.at : null;
}

/**
 * The same bound `phase-outcome.sh` puts on `--watch`, enforced on the read
 * side too: the scheduler polls the first eight pollable refs and no more.
 * Written here, beside the parser, so the summary below counts exactly what the
 * scheduler watches; `watch-scheduler.ts` re-exports it.
 */
export const MAX_WATCH_REFS = 8;

/** What a phase's declared refs are, as the watch clock has actually found them. */
export type WatchSummary = {
  /** Refs the console has asked and been told "not yet" — a `pending` row. */
  live: string[];
  /** Refs whose landing is being delivered. */
  landed: string[];
  /** Refs this console will never run again — the policy, the backstop, the wait budget — with why. */
  refused: { ref: string; detail?: string }[];
  /**
   * Refs with no answer: never probed yet (no row), or asked and unanswerable
   * (an `unknown` row — no `gh` auth, `watchCmdRefs` off, a minted ref held).
   * Until control-tower phase 88 (#125) these counted as `live`, so an errand
   * composed before the first probe promised a resume the probe then refused.
   */
  unknown: string[];
};

/**
 * Which of a phase's declared refs the console is actually WATCHING, read from
 * `watchState` and `watchRetired` rather than from the declaration alone
 * (control-tower phase 6, #19 ask 4).
 *
 * Every "the console is watching its refs" sentence used to be written from the
 * declaration: a ref that had been refused an hour earlier still read as
 * watched, and a halt card said "watching its refs" for a day with nothing
 * behind it. The heal's refusal, the errand's `how` and the plan-recover
 * answer now say what this finds (`watchClause`).
 */
export function watchSummary(record: {
  declared?: { watch?: string[] };
  watch?: string[];
  watchState?: { refs: readonly { ref: string; state: string; detail?: string }[] };
  watchRetired?: readonly string[];
}): WatchSummary {
  const declared = record.declared?.watch?.length ? record.declared.watch : record.watch ?? [];
  const rows = record.watchState?.refs ?? [];
  const retired = new Set(record.watchRetired ?? []);
  const summary: WatchSummary = { live: [], landed: [], refused: [], unknown: [] };
  for (const target of pollableRefs(declared).slice(0, MAX_WATCH_REFS)) {
    const row = rows.find((r) => r.ref === target.ref);
    if (row?.state === 'refused' || retired.has(target.ref)) {
      summary.refused.push({ ref: target.ref, ...(row?.detail ? { detail: row.detail } : {}) });
    } else if (row?.state === 'landed') summary.landed.push(target.ref);
    else if (row?.state === 'pending') summary.live.push(target.ref);
    else summary.unknown.push(target.ref);
  }
  return summary;
}

/**
 * The clause a sentence about a declared park ends with — naming the live refs
 * and the refused ones, and never claiming to be watching when nothing is live.
 * Empty when the phase declared no pollable ref at all: the caller's own words
 * ("a person's to settle") are the whole story then. With `phase`, a park whose
 * every ref was refused says what a person does about it (#125 ask 4).
 */
export function watchClause(summary: WatchSummary, phase?: number): string {
  const refused = summary.refused.length
    ? `refused, not watched: ${summary.refused.map((r) => r.ref).join(', ')}`
    : '';
  const unknown = summary.unknown.length ? `no answer yet about ${summary.unknown.join(', ')}` : '';
  const also = [unknown, refused].filter(Boolean).join('; ');
  if (summary.live.length) {
    return `the console is watching ${summary.live.length === 1 ? 'one live ref' : `${summary.live.length} live refs`} `
      + `(${summary.live.join(', ')}) and resumes the session when one lands${also ? `; ${also}` : ''}`;
  }
  if (summary.landed.length) {
    return `${summary.landed.join(', ')} landed — the console is resuming the session${also ? `; ${also}` : ''}`;
  }
  if (unknown) return `the console is asking, with ${unknown}${refused ? `; ${refused}` : ''}`;
  if (refused) {
    return `none of its refs is live (${refused}) — nothing will resume it by itself`
      + (phase !== undefined ? `: do the errand, then press Retry on phase ${phase}` : '');
  }
  return '';
}

/**
 * An errand's "how", as it is TRUE now (control-tower phase 88, #125): the
 * errand's own words, then — for an errand the runner marked `watching` — the
 * clause over the record's live `watchState`. The runner used to freeze the
 * clause into `how` when it composed the errand, before the first probe, so a
 * ref refused three seconds later went on being "watched" on every card, halt
 * and push for as long as the errand stood. Nothing stores the derived text.
 */
export function liveErrandHow(
  errand: { phase: number; how: string; watching?: boolean },
  record: Parameters<typeof watchSummary>[0] | null | undefined,
): string {
  if (!errand.watching || !record) return errand.how;
  const clause = watchClause(watchSummary(record), errand.phase);
  return clause ? `${errand.how} ${clause[0].toUpperCase()}${clause.slice(1)}.` : errand.how;
}

/**
 * The run as a page should see it: every standing errand's `how` derived from
 * its phase's record now (`liveErrandHow`). A projection onto a COPY — the
 * stored run keeps the errand's own words — applied where `/api/runs` and
 * `/api/run/:slug` answer, beside the wall readings.
 */
export function withLiveErrands<T extends { phases?: Record<string, unknown>; recoveries?: Record<string, { errand?: { phase: number; how: string; watching?: boolean } | null } | undefined> } | null | undefined>(run: T): T {
  const recoveries = run?.recoveries;
  if (!run) return run;
  if (!recoveries || !Object.values(recoveries).some((slot) => slot?.errand?.watching)) return run;
  const next: Record<string, unknown> = {};
  for (const [phase, slot] of Object.entries(recoveries)) {
    const errand = slot?.errand;
    next[phase] = errand?.watching
      ? { ...slot, errand: { ...errand, how: liveErrandHow(errand, run.phases?.[phase] as Parameters<typeof watchSummary>[0]) } }
      : slot;
  }
  return { ...run, recoveries: next };
}

/** The pollable subset of a declared watch list, in declaration order, deduped. */
/**
 * The refs that WATCH something (control-tower phase 121, #40): every one the
 * clock can poll but a `date:`, which is a clock of its own. A park on a spent
 * wait budget is a wait only while one of these is out — a date alone would
 * hold it, unannounced, until that instant, so it still files the errand.
 */
export function liveRefs(refs: readonly string[] | undefined | null): WatchRefTarget[] {
  return pollableRefs(refs).filter((target) => target.kind !== 'date');
}

/**
 * The live refs a park still waits on: `liveRefs`, less each one the watch
 * clock has REFUSED — a refusal is final (the clock never asks that ref
 * again), so a spent park whose live refs are all refused waits on nothing
 * and is a person's again (control-tower phase 121).
 */
export function stillLiveRefs(record: {
  watch?: readonly string[] | null;
  watchState?: { refs?: readonly { ref: string; state: string }[] } | null;
}): WatchRefTarget[] {
  const refused = new Set((record.watchState?.refs ?? []).filter((row) => row.state === 'refused').map((row) => row.ref));
  return liveRefs(record.watch).filter((target) => !refused.has(target.ref));
}

export function pollableRefs(refs: readonly string[] | undefined | null): WatchRefTarget[] {
  const seen = new Set<string>();
  const out: WatchRefTarget[] = [];
  for (const ref of refs ?? []) {
    const target = parseWatchRef(ref);
    if (!target || seen.has(target.ref)) continue;
    seen.add(target.ref);
    out.push(target);
  }
  return out;
}

/**
 * When this ref should next be looked at, given the answer just received.
 *
 * Three regimes, and the middle one is the subtle one:
 *
 *   - **`refused` has no next.** Nothing about the console's own policy changes
 *     between two ticks, so re-asking would be the console arguing with itself.
 *   - **`landed` is due again on a SHORT clock — but it is never re-PROBED.**
 *     The world has answered and that answer is final; what is not final is
 *     whether the healer managed to act on it. A landing used to be handed over
 *     exactly once, which made three things impossible at a stroke: a freeze, a
 *     capped admission or a failed spawn lost it permanently, and the
 *     `MAX_BOOT_RESUMES` bound and its errand — the second half of an exit
 *     criterion — were unreachable code (QA F2). So a landed row keeps a due
 *     time and the scheduler re-DELIVERS the stored verdict from memory; the
 *     bound lives where it was always written, on `record.watchResumes`, and
 *     the row retires when the declaration it answers is spent.
 *   - **everything else is a cadence**, except a pending `date:`, which has
 *     exactly one interesting moment and is scheduled at it, and a `cmd:`,
 *     whose cadence backs off with the number of times it has RUN (`runs`,
 *     the row's own count after this verdict — `cmdBackoffMs`) — and, since
 *     control-tower phase 50 (#87), only once the declaration's `window` is
 *     over: inside it the step is held to a sixth of the window (`cmdStepMs`).
 */
export function nextDueFor(
  target: WatchRefTarget, state: WatchState['state'], now: number, runs = 0, window?: DeclaredWindow | null,
): number | null {
  if (state === 'refused') return null;
  if (state === 'landed') return now + WATCH_REDELIVER_MS;
  if (target.kind === 'date') return Math.max(now, target.at);
  if (target.kind === 'cmd') return now + cmdStepMs(target.command, runs, now, window);
  return now + WATCH_POLL_MS[target.kind];
}

/**
 * What a resumed session is actually being asked to do, given HOW the thing it
 * waited on ended.
 *
 * "Landed" is one word for four outcomes and they call for different next
 * moves. The instruction used to say "re-check it now" for all of them, which
 * is wrong in the case that costs the most: a workflow run that ended
 * `cancelled` (the measured p12 shape — a `workflow_run` cancelled at its 24 h
 * expiry) is not a result to read, it is a run that never produced one, and a
 * session told to "re-check it" reads a cancelled run, finds nothing, and
 * declares the same wait again. Naming the conclusion is the difference
 * between resuming a session and resuming a loop.
 *
 * Deliberately a directive and not a decision: none of these tells the session
 * what the answer is, only which question it is now looking at. A failure is
 * still possibly expected; a cancellation is still possibly fine.
 *
 * Lives here, beside the landing it reads, since control-tower phase 6: the
 * healer's resume and the runner's live-lane resume (`waitResumePrompt`,
 * cause `landed`) both say it.
 */
export function landingDirective(landed: { detail?: string; notRun?: CiNotRun }): string {
  // A run GitHub never started, whose budget has room again (#166): there is
  // nothing to read — the jobs never ran — so the act is the re-run, on the
  // same ref, which reads the run's newest attempt.
  if (landed.notRun) {
    return `GitHub never started its jobs (billing), and the Actions budget has room again — re-run the failed jobs `
      + `(\`${rerunCommand(landed.notRun)}\`), then declare waiting-external on the same ref: the watch follows the new attempt;`;
  }
  const detail = (landed.detail ?? '').toLowerCase();
  if (detail.includes('cancelled') || detail.includes('canceled')) {
    return 'It was CANCELLED, so there is no result to read — decide whether to re-run it (`gh run rerun <id>`) or to proceed without it;';
  }
  if (detail.includes('failure') || detail.includes('timed_out')) {
    return 'It FAILED, so read why before anything else — a green step is not waiting for you;';
  }
  if (detail.includes('closed') && !detail.includes('merged')) {
    return 'It was CLOSED rather than merged — check whether the work it carried still needs a home;';
  }
  return 'Re-check it now,';
}

/** A workflow run's answer. `completed` is the only landing — see the module comment. */
export function runLanded(json: { status?: unknown; conclusion?: unknown }): WatchState['state'] {
  const status = typeof json.status === 'string' ? json.status : '';
  if (!status) return 'unknown';
  return status === 'completed' ? 'landed' : 'pending';
}

/** A PR's answer. OPEN is pending; MERGED and CLOSED are both landings. */
export function prLanded(json: { state?: unknown }): WatchState['state'] {
  const state = typeof json.state === 'string' ? json.state : '';
  if (!state) return 'unknown';
  return state === 'OPEN' ? 'pending' : 'landed';
}

/**
 * What a `lock:` or `cmd:` ref needs from the console to be answerable at all.
 *
 * Both are optional and both default to `unknown` rather than to an assumption:
 * a console with no scheduler cannot know whether a scope is free, and one with
 * `watchCmdRefs` off has decided not to ask. "I could not check" and "it has not
 * landed" are the same to the caller — neither resumes anything — but only the
 * first is honest about why.
 */
export type WatchProbeDeps = {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Is nothing holding `slug`'s phase any more? `null` means no answer.
   *
   * Answered from the console's own LOCK STORE (`service-base.ts`), which is
   * the same evidence `phase-lock.sh conflicts` reads, and which sees three
   * distinct ways to be free: no lock at all, a lapsed lease, or a holder whose
   * session the registry reports ENDED. ⚠️ It does NOT see a foreign run's
   * standing GRANT — a phase blocked by one is not answered by this scheme.
   * Narrower than the scheduler's `wouldBlock`, and narrower in the safe
   * direction: it never reports free when something is holding.
   */
  lockFree?: (slug: string, phase: number) => Promise<boolean | null> | boolean | null;
  /**
   * Run one command through `verify.ts`'s read-only policy. `refused` carries
   * the policy's own words. Absent means the pref is off or no runner is
   * wired — `unknown`, never `refused`: the console has not judged the
   * command, it simply did not ask.
   */
  runCommand?: (command: string) => Promise<{ refused?: string; ok: boolean; detail?: string }>;
  /**
   * `phase:<slug>/<N>` — what the console's own RECORD of that phase says
   * (control-tower phase 88, #129): `landed` once it reads `done`, which a phase
   * reaches only after the console's §Verification (a red final verdict re-opens
   * it — phase 62); `pending` otherwise. `null` means no answer.
   */
  phaseDone?: (slug: string, phase: number) => { state: 'landed' | 'pending' | 'unknown'; detail?: string } | null;
  /** `verify:<slug>/<N>` — the declaring phase's red lines, re-run on a new head (`verify-watch.ts`). */
  verifyProbe?: (target: Extract<WatchRefTarget, { kind: 'verify' }>) => Promise<WatchState>;
  /** `unit:<host>/<unit>` — one `systemctl show` over the host's ssh master (`watch-unit.ts` `UnitProber`). */
  unitProbe?: (target: UnitTarget) => Promise<WatchState>;
};

/**
 * Ask about one target. Every failure is `unknown` with the reason in `detail`;
 * the only `refused` comes from the command policy, which is a verdict rather
 * than a failure.
 */
export async function probeWatchRef(
  target: WatchRefTarget,
  opts: WatchProbeDeps & { now?: number } = {},
): Promise<WatchState> {
  if (target.kind === 'date') {
    const now = opts.now ?? Date.now();
    return now >= target.at
      ? { ref: target.ref, state: 'landed', detail: new Date(target.at).toISOString() }
      : { ref: target.ref, state: 'pending', detail: `not before ${new Date(target.at).toISOString()}` };
  }
  if (target.kind === 'lock') {
    if (!opts.lockFree) return { ref: target.ref, state: 'unknown', detail: 'no lock oracle wired' };
    let free: boolean | null;
    try { free = await opts.lockFree(target.slug, target.phase); } catch { free = null; }
    if (free === null) return { ref: target.ref, state: 'unknown', detail: 'the lock could not be read' };
    return free
      ? { ref: target.ref, state: 'landed', detail: 'nothing holds its scope any more' }
      : { ref: target.ref, state: 'pending', detail: 'still held' };
  }
  if (target.kind === 'phase') {
    let answer: ReturnType<NonNullable<WatchProbeDeps['phaseDone']>> = null;
    try { answer = opts.phaseDone?.(target.slug, target.phase) ?? null; } catch { answer = null; }
    if (!answer) return { ref: target.ref, state: 'unknown', detail: opts.phaseDone ? `no record of ${target.slug} phase ${target.phase}` : 'no run-state oracle wired' };
    return { ref: target.ref, state: answer.state, ...(answer.detail ? { detail: answer.detail.slice(0, 160) } : {}) };
  }
  if (target.kind === 'verify') {
    if (!opts.verifyProbe) return { ref: target.ref, state: 'unknown', detail: 'no verification oracle wired' };
    try { return await opts.verifyProbe(target); } catch (error) {
      return { ref: target.ref, state: 'unknown', detail: String((error as Error)?.message ?? error).slice(0, 160) };
    }
  }
  if (target.kind === 'unit') {
    if (!opts.unitProbe) return { ref: target.ref, state: 'unknown', detail: 'no unit prober wired' };
    try { return await opts.unitProbe(target); } catch (error) {
      return { ref: target.ref, state: 'unknown', detail: String((error as Error)?.message ?? error).slice(0, 160) };
    }
  }
  if (target.kind === 'cmd') {
    if (!opts.runCommand) return { ref: target.ref, state: 'unknown', detail: 'cmd refs are not being run' };
    let answer: { refused?: string; ok: boolean; detail?: string };
    try { answer = await opts.runCommand(target.command); } catch (error) {
      return { ref: target.ref, state: 'unknown', detail: String((error as Error)?.message ?? error).slice(0, 160) };
    }
    if (answer.refused) return { ref: target.ref, state: 'refused', detail: answer.refused.slice(0, 160) };
    return {
      ref: target.ref,
      state: answer.ok ? 'landed' : 'pending',
      ...(answer.detail ? { detail: answer.detail.slice(0, 160) } : {}),
    };
  }
  return probeGh(target, opts);
}

/**
 * Ask `gh` about one target. Fixed argv, bounded, never a shell; every
 * failure is `unknown` with the reason in `detail`.
 */
function probeGh(
  target: Extract<WatchRefTarget, { kind: 'gh-run' | 'gh-pr' }>,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<WatchState> {
  const argv = target.kind === 'gh-run'
    ? ['run', 'view', target.id, '--repo', target.repo, '--json', 'status,conclusion']
    : ['pr', 'view', target.number, '--repo', target.repo, '--json', 'state,mergedAt,mergeCommit'];
  return probe();

  async function probe(): Promise<WatchState> {
    const run = await shell('gh', argv, {
      channel: 'shell',
      intent: 'watch-ref',
      timeout: opts.timeoutMs ?? 10_000,
      env: opts.env ?? process.env,
      capture: { keep: 256 * 1024, mode: 'head' },
      // A ref the watcher cannot read yet answers `unknown`, and the scheduler
      // simply asks again — that is the whole design of a watch.
      expectFailure: true,
    });

    if (!run.ok) {
      const detail = run.error?.message || run.stderr || `gh exited ${run.code}`;
      return { ref: target.ref, state: 'unknown', detail: String(detail).slice(0, 160) };
    }
    try {
      const json = JSON.parse(run.stdout);
      if (target.kind === 'gh-run') {
        const detail = [json.status, json.conclusion].filter(Boolean).join(': ');
        // A failure in seconds may be a run GitHub never started (#166): read
        // its jobs before calling it red. Any read that fails keeps the plain
        // verdict — this can only ever make the answer more exact.
        if (json.status === 'completed' && FAILED_CONCLUSIONS.has(String(json.conclusion))) {
          const notRun = await readNotStarted(target, opts).catch(() => null);
          if (notRun) return { ref: target.ref, state: 'pending', detail: notRunDetail(notRun), notRun };
        }
        return { ref: target.ref, state: runLanded(json), ...(detail ? { detail } : {}) };
      }
      // `mergeCommit` is an object (`{oid}`) in gh's JSON; carried as the sha
      // alone, and only on a MERGED answer, for the landing ledger's row.
      const merge = json.mergeCommit;
      const oid = merge && typeof merge === 'object' ? (merge as { oid?: unknown }).oid : merge;
      return {
        ref: target.ref,
        state: prLanded(json),
        ...(json.state ? { detail: String(json.state) } : {}),
        ...(json.state === 'MERGED' && typeof oid === 'string' && oid ? { mergeCommit: oid } : {}),
      };
    } catch {
      return { ref: target.ref, state: 'unknown', detail: 'unparseable gh output' };
    }
  }
}

/* ------------------------------------------------------------------ *
 * A run GitHub never started (control-tower phase 111, #166)
 * ------------------------------------------------------------------ */

/** The conclusions a refused run ends with; anything else ran. */
const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set(['failure', 'startup_failure']);

/**
 * GitHub's own sentence on a job it refused for money: "The job was not
 * started because recent account payments have failed or your spending limit
 * needs to be increased." Matched on its two halves, so a rewording of either
 * still reads.
 */
export const NOT_STARTED_BILLING = /job was not started because .*(payments? (have|has) failed|spending limit)/i;

type GhRead = { ok: true; json: unknown } | { ok: false; why: string };

/**
 * One `gh api` read, bounded like the probe it serves; every failure is a reason.
 * A GET that says so — the JSON `Accept` header and none of the flags that turn
 * `api` into a write — which is the shape `issues-readonly.test.ts` admits here.
 */
async function ghApi(path: string, opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<GhRead> {
  const run = await shell('gh', ['api', path, '-H', 'Accept: application/vnd.github+json'], {
    channel: 'shell', intent: 'watch-ref', timeout: opts.timeoutMs ?? 10_000, env: opts.env ?? process.env,
    capture: { keep: 512 * 1024, mode: 'head' }, expectFailure: true,
  });
  if (!run.ok) return { ok: false, why: String(run.error?.message || run.stderr || `gh exited ${run.code}`).trim().slice(0, 120) };
  try { return { ok: true, json: JSON.parse(run.stdout) }; } catch { return { ok: false, why: 'unparseable gh output' }; }
}

type GhJob = { id?: unknown; conclusion?: unknown; runner_id?: unknown; runner_name?: unknown; steps?: unknown; run_attempt?: unknown };

/**
 * Was this completed, failed run never started? Its jobs first — every failed
 * job with no runner and no step — then the first such job's annotations for
 * GitHub's sentence, then the budgets the token can read. Null when it ran.
 */
async function readNotStarted(
  target: Extract<WatchRefTarget, { kind: 'gh-run' }>,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<CiNotRun | null> {
  const jobsRead = await ghApi(`repos/${target.repo}/actions/runs/${target.id}/jobs?per_page=100`, opts);
  if (!jobsRead.ok) return null;
  const jobs = (jobsRead.json as { jobs?: GhJob[] } | null)?.jobs;
  if (!Array.isArray(jobs)) return null;
  const failed = jobs.filter((job) => FAILED_CONCLUSIONS.has(String(job?.conclusion)));
  const unstarted = (job: GhJob) => !job.runner_id && !job.runner_name && !(Array.isArray(job.steps) && job.steps.length);
  if (!failed.length || !failed.every(unstarted)) return null;
  const first = failed[0];
  const notes = await ghApi(`repos/${target.repo}/check-runs/${String(first.id)}/annotations`, opts);
  if (!notes.ok || !Array.isArray(notes.json)) return null;
  const sentence = (notes.json as { message?: unknown }[])
    .map((note) => String(note?.message ?? ''))
    .find((message) => NOT_STARTED_BILLING.test(message));
  if (!sentence) return null;
  const attempt = Number(first.run_attempt);
  const budget = await readBudgets(target.repo, opts);
  return {
    cause: 'billing', repo: target.repo, run: target.id,
    ...(Number.isInteger(attempt) && attempt > 0 ? { attempt } : {}),
    jobs: failed.length,
    annotation: sentence.replace(/\s+/g, ' ').trim().slice(0, 240),
    ...budget,
  };
}

type GhBudget = {
  id?: unknown; budget_scope?: unknown; budget_entity_name?: unknown; budget_amount?: unknown;
  consumed_amount?: unknown; prevent_further_usage?: unknown;
  budget_product_sku?: unknown; budget_product_skus?: unknown; budget_type?: unknown;
};

/**
 * The Actions budgets that bind this repository — its own, then its
 * organization's — with what each has consumed, as far as the token can read
 * them. The list endpoint may omit `consumed_amount`; a budget that does is
 * read again by id. Bounded at two budgets, three calls.
 */
async function readBudgets(
  repo: string, opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<Pick<CiNotRun, 'budgets' | 'unreadable' | 'headroom'>> {
  const owner = repo.split('/')[0];
  const path = `organizations/${owner}/settings/billing/budgets`;
  const listed = await ghApi(path, opts);
  if (!listed.ok) return { unreadable: `${path}: ${listed.why}` };
  const all = (listed.json as { budgets?: GhBudget[] } | null)?.budgets;
  if (!Array.isArray(all)) return { unreadable: `${path}: no budgets in the answer` };
  const actions = (b: GhBudget) => /actions/i.test(JSON.stringify([b.budget_product_sku, b.budget_product_skus, b.budget_type]));
  const mine = all.filter((b) => actions(b) && (
    (b.budget_scope === 'repository' && (b.budget_entity_name === repo || b.budget_entity_name === repo.split('/')[1]))
    || b.budget_scope === 'organization'));
  mine.sort((a, b) => (a.budget_scope === 'repository' ? 0 : 1) - (b.budget_scope === 'repository' ? 0 : 1));
  const budgets: CiBudget[] = [];
  for (const b of mine.slice(0, 2)) {
    let consumed = Number(b.consumed_amount);
    if (!Number.isFinite(consumed) && typeof b.id === 'string' && /^[\w-]+$/.test(b.id)) {
      const one = await ghApi(`${path}/${b.id}`, opts);
      consumed = one.ok ? Number((one.json as GhBudget | null)?.consumed_amount) : Number.NaN;
    }
    const amount = Number(b.budget_amount);
    if (!Number.isFinite(consumed) || !Number.isFinite(amount)) continue;
    budgets.push({
      scope: b.budget_scope === 'repository' ? 'repository' : 'organization',
      name: b.budget_scope === 'repository' ? repo : owner,
      amount, consumed, stops: b.prevent_further_usage === true,
    });
  }
  if (!budgets.length) return { unreadable: `${path}: no Actions budget with a consumed amount names ${repo}` };
  const stopping = budgets.filter((b) => b.stops);
  return { budgets, ...(stopping.length ? { headroom: stopping.every((b) => b.consumed < b.amount) } : {}) };
}

/** The sentence a refused run's row carries — the brief, the card and the journal all read it. */
export function notRunDetail(notRun: CiNotRun, landed = false): string {
  const jobs = `${notRun.jobs} job${notRun.jobs === 1 ? '' : 's'}`;
  if (landed) return `not-run (billing) — the Actions budget has room again (${budgetClause(notRun)}): re-run the failed jobs`;
  if (notRun.headroom === true) {
    return `not-run (billing): GitHub did not start ${jobs}, though ${budgetClause(notRun)} — `
      + 'the account\'s payment method or spending limit is the likelier cause';
  }
  return `not-run (billing): GitHub did not start ${jobs} — ${budgetClause(notRun)}`;
}

/** `gh run rerun <id> --repo <repo> --failed` — the act that follows the room. */
export function rerunCommand(notRun: Pick<CiNotRun, 'run' | 'repo'>): string {
  return `gh run rerun ${notRun.run} --repo ${notRun.repo} --failed`;
}

/**
 * The ONE errand a refused run files on its phase: what GitHub refused, the
 * budget as read, where to raise it, and what happens after — the watch sees
 * the room and resumes the phase to re-run the failed jobs.
 */
export function ciRefusedErrand(notRun: CiNotRun, ref: string): { need: string; how: string } {
  const owner = notRun.repo.split('/')[0];
  const why = notRun.headroom === true
    ? `${budgetClause(notRun)}, so the budget is not what stopped it — the account's payment method or spending limit is`
    : budgetClause(notRun);
  return {
    need: `GitHub Actions refused to start the jobs of ${ref} (${notRun.repo}): "${notRun.annotation.slice(0, 160)}" — ${why}.`,
    how: notRun.headroom === true
      ? `Fix the account's payment method or spending limit (https://github.com/organizations/${owner}/settings/billing), `
        + `then re-run the failed jobs: ${rerunCommand(notRun)} — the watch follows the new attempt.`
      : `Raise the Actions budget (https://github.com/organizations/${owner}/settings/billing/budgets; read it with `
        + `gh api organizations/${owner}/settings/billing/budgets). The watch sees the room and resumes the phase to re-run `
        + `the failed jobs (${rerunCommand(notRun)}); it follows the new attempt on the same ref.`,
  };
}

/* ------------------------------------------------------------------ *
 * How long the workflow behind a `gh:…#run/<id>` ref may run
 * (control-tower phase 14, #40 — told to F36 `wait-window-short`)
 * ------------------------------------------------------------------ */

/** GitHub's own ceiling for a job that states no `timeout-minutes`. */
export const GH_DEFAULT_JOB_TIMEOUT_MIN = 360;

/**
 * The longest a workflow's jobs may run, read from its YAML: each job's own
 * `timeout-minutes`, and GitHub's 360 for a job that states none. Job level
 * only — a step's timeout bounds nothing its job does not already bound. Null
 * when the file has no `jobs:` block. Read by indentation, not parsed: the
 * console ships no YAML parser, and the job keys under `jobs:` are the one
 * shape every workflow file shares.
 */
export function workflowTimeoutOf(yaml: string): number | null {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^jobs:\s*(#.*)?$/.test(line));
  if (start < 0) return null;
  let jobIndent: number | null = null;
  const jobs: { timeout: number | null; child: number | null }[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break; // the next top-level key ends `jobs:`
    jobIndent ??= indent;
    if (indent === jobIndent) {
      if (/^\s*[\w.-]+:\s*(#.*)?$/.test(line)) jobs.push({ timeout: null, child: null });
      continue;
    }
    const job = jobs.at(-1);
    if (!job) continue;
    job.child ??= indent;
    if (indent !== job.child) continue;
    const own = /^\s*timeout-minutes:\s*(\d+)\s*(#.*)?$/.exec(line);
    if (own) job.timeout = Number(own[1]);
  }
  if (!jobs.length) return null;
  return Math.max(...jobs.map((job) => job.timeout ?? GH_DEFAULT_JOB_TIMEOUT_MIN));
}

/** One answer per run id: a day for a timeout, ten minutes for "could not ask". */
const workflowTimeouts = new Map<string, { at: number; minutes: number | null }>();
const WORKFLOW_TIMEOUT_TTL_MS = 24 * 60 * 60_000;
const WORKFLOW_TIMEOUT_MISS_TTL_MS = 10 * 60_000;

type GhAsk = (argv: string[]) => Promise<{ ok: boolean; stdout: string }>;

const askGh: GhAsk = async (argv) => {
  const run = await shell('gh', argv, {
    channel: 'shell',
    intent: 'workflow-timeout',
    timeout: 10_000,
    capture: { keep: 512 * 1024, mode: 'head' },
    // Signed out, a deleted run, no network: the advisory stays silent.
    expectFailure: true,
  });
  return { ok: run.ok, stdout: run.stdout };
};

/**
 * Ask GitHub, once per run id, how long the workflow behind a
 * `gh:<repo>#run/<id>` ref may run: the run names its workflow file and the
 * commit it ran at, and that file's jobs name their timeouts. Null when it
 * cannot be known; remembered either way, so a lint never asks twice.
 */
export async function resolveWorkflowTimeout(
  ref: string, opts: { gh?: GhAsk; now?: () => number } = {},
): Promise<number | null> {
  const target = parseWatchRef(ref);
  if (!target || target.kind !== 'gh-run') return null;
  const now = opts.now?.() ?? Date.now();
  const hit = workflowTimeouts.get(ref);
  if (hit && now - hit.at < (hit.minutes === null ? WORKFLOW_TIMEOUT_MISS_TTL_MS : WORKFLOW_TIMEOUT_TTL_MS)) return hit.minutes;
  const gh = opts.gh ?? askGh;
  let minutes: number | null = null;
  try {
    const run = await gh(['api', `repos/${target.repo}/actions/runs/${target.id}`, '--jq', '[.path, .head_sha] | @tsv']);
    const [path, sha] = run.ok ? run.stdout.trim().split('\t') : [];
    if (path && sha && /^[\w./-]+$/.test(path) && /^[0-9a-f]{7,40}$/.test(sha)) {
      const file = await gh(['api', `repos/${target.repo}/contents/${path}?ref=${sha}`, '-H', 'Accept: application/vnd.github.raw']);
      if (file.ok) minutes = workflowTimeoutOf(file.stdout);
    }
  } catch {
    minutes = null;
  }
  workflowTimeouts.set(ref, { at: now, minutes });
  return minutes;
}

/**
 * Learn the timeouts of these refs, bounded by `budgetMs` so a slow GitHub
 * never holds a lint: answers whether anything new was learned (the caller
 * then re-lints, since the engine is told what it knows).
 */
export async function learnWorkflowTimeouts(refs: readonly string[], budgetMs = 5_000): Promise<boolean> {
  const fresh = [...new Set(refs)].filter((ref) => !workflowTimeouts.has(ref) && parseWatchRef(ref)?.kind === 'gh-run');
  if (!fresh.length) return false;
  await Promise.race([
    Promise.all(fresh.map((ref) => resolveWorkflowTimeout(ref))),
    new Promise((resolve) => { setTimeout(resolve, budgetMs).unref?.(); }),
  ]);
  return fresh.some((ref) => typeof workflowTimeouts.get(ref)?.minutes === 'number');
}

/** What this console has learned, as `PE_WAIT_TIMEOUTS` pairs: `<ref>=<minutes>`. */
export function waitTimeoutsCached(): string[] {
  return [...workflowTimeouts.entries()]
    .filter(([, value]) => typeof value.minutes === 'number')
    .map(([ref, value]) => `${ref}=${value.minutes}`);
}

/** Tests only: forget every learned timeout. */
export function forgetWorkflowTimeouts(): void {
  workflowTimeouts.clear();
}
