/**
 * `/api/metrics` — the console's numbers in Prometheus text exposition format.
 *
 * Pure: facts in, one string out. No file is opened, no clock is read, nothing
 * is cached — `server/service-live.ts` assembles the facts from the same
 * `planStats` / `spendSummary` / `planCost` calls every page already uses, so a
 * scrape and a screen can never disagree about a number.
 *
 * ## The names are a CONTRACT
 *
 * The moment an operator points a scraper at this endpoint, every name and
 * label below is load-bearing: renaming one silently breaks their dashboards
 * and alerts, and a metric that changes meaning without changing name is worse
 * than one that disappears. So:
 *
 *   - **Never rename or repurpose a family.** Add a new one and leave the old
 *     one reporting what it always reported.
 *   - **Never add a label to an existing family.** Every label is part of a
 *     series' identity; adding one splits history at the upgrade.
 *   - `_total` means a COUNTER — monotonically non-decreasing for as long as
 *     the run files it is read from survive. Deleting a run file resets it, the
 *     one way this can go backwards, and `rate()` handles that as it handles
 *     any counter reset.
 *   - Everything else is a GAUGE and may move in either direction.
 *
 * The full family list, with what each one answers, is in `docs/metrics.md` —
 * and `viewer/test/metrics.test.ts` pins the names against this file so the
 * document cannot drift away from the endpoint.
 *
 * ## Cardinality
 *
 * Labelled by `slug`, never by run id: a run id is minted per boarding, so a
 * console driven for a year would mint thousands of dead series that a scraper
 * keeps forever. Per-plan is the granularity an operator asks questions at, and
 * a plan count is bounded by a directory somebody maintains by hand.
 *
 * ## Exposure
 *
 * Unauthenticated on `127.0.0.1`, exactly like every other read on this server
 * — the console binds to loopback and has no other posture to weaken. Nothing
 * here carries a note, a title, a path or an owner: a scrape is numbers and
 * slugs, which is what makes it safe to leave open on a laptop.
 */

import { BOARD_BUCKETS } from '../../shared/status-vocab.js';
import type { PhaseState } from '../engine.ts';
import { read as readCounter, type CounterFamily } from '../counters.ts';

/** One plan, as the board sees it. A subset of `analysis/stats.ts` `PlanStats`. */
export type MetricsPlan = {
  slug: string;
  status?: string;
  closed: boolean;
  phases: number;
  done: number;
  ready: number;
  waiting: number;
  inProgress: number;
  stuck: number;
  remainingWeight: number;
  /** 0-100, as `planStats` reports it. Emitted as a 0-1 ratio, the Prometheus convention. */
  percent: number;
};

/** One run, already rolled up. */
export type MetricsRun = {
  slug: string;
  status: string;
  spentUsd: number;
  /** Sum of `PhaseRecord.attempts` over this run — sessions the console launched. */
  attempts: number;
  /** Sum of `PhaseRecord.durationMs` over this run, in seconds. */
  phaseSeconds: number;
  /**
   * The WALL-CLOCK this run had a phase waiting in the admission queue, by the
   * class of what held it (`HOLDER_CLASSES`, control-tower phase 60, #64), in
   * seconds — `RunState.blockedMs`, closed stretches only. Each instant counts
   * once however many phases waited through it: never the phases' lane-time
   * summed. Absent on a run older than the split.
   */
  blockedSeconds?: Partial<Record<string, number>>;
};

/** Per-plan money, from `analysis/spend.ts` `planCost`. */
export type MetricsCost = {
  slug: string;
  totalUsd: number;
  attributedUsd: number;
  residualUsd: number;
  ladderUsd: number;
};

/**
 * One ISOLATED run's checkout load, from the runner's own git probe.
 *
 * Only a run with a checkout of its own contributes an entry — `runGit()`
 * answers `null` for every shared run — which is what makes the three families
 * below ABSENT rather than zero on a console that has never isolated anything.
 * That distinction is the point: `0` says "measured, and there are none",
 * absent says "nothing here measures this", and an alert written against the
 * first would fire forever on a console that means the second.
 */
export type MetricsGit = {
  slug: string;
  /** Console-managed checkouts of this plan's run, live ones only. */
  worktrees: number;
  /**
   * Bytes those checkouts occupy. ABSENT when `du` could not answer for any of
   * them — a machine without `du` reports no disk rather than none used.
   */
  diskBytes?: number;
  /** Distinct files named by this run's `conflicted` radar pairs. */
  conflictedFiles: number;
};

/**
 * What this console's own process is doing.
 *
 * Absent rather than zeroed when a count is not knowable: a gauge saying zero
 * SSE clients and one saying "this build cannot tell you" are different facts,
 * and the second is the honest one on a console whose surface does not report
 * it yet. `family()` drops a non-finite sample for the same reason.
 */
export type MetricsProcess = {
  heapUsedBytes: number;
  heapLimitBytes: number;
  residentBytes: number;
  externalBytes: number;
  eventLoopDelaySeconds?: number;
  /** The last complete window's worst delay (`runtime-probe.ts`, #75). */
  eventLoopDelayMaxSeconds?: number;
  /** …and its 99th percentile. */
  eventLoopDelayP99Seconds?: number;
  handles?: number;
  uptimeSeconds: number;
  sseClients?: number;
  sessions?: number;
  ptySessions?: number;
};

export type MetricsFacts = {
  plans: readonly MetricsPlan[];
  runs: readonly MetricsRun[];
  cost: readonly MetricsCost[];
  /** One entry per isolated run. Absent or empty ⇒ the three git families emit nothing. */
  git?: readonly MetricsGit[];
  /** Every ladder rung this console has recorded, for the tally. */
  rungs: readonly { rung: string; outcome?: string }[];
  /** Today's money — `spendSummary().today`. */
  today: { settledUsd: number; ladderUsd: number; capUsd: number | null };
  version?: string;
  instanceId?: string;
  /** How long assembling these facts took, in seconds. */
  scrapeSeconds?: number;
  /** This console's own runtime. Absent ⇒ the ten process families emit nothing. */
  process?: MetricsProcess;
  /** Every account window's forecast (control-tower phase 92, #141). Absent or empty ⇒ the forecast family emits nothing. */
  accounts?: readonly MetricsAccountWindow[];
  /** Each account's credit spend this month (control-tower phase 93); absent or empty ⇒ the family emits nothing. */
  credits?: readonly MetricsAccountCredit[];
  /** The machine-load guard's reading (control-tower phase 100). Absent ⇒ both load families emit nothing. */
  load?: { avg5: number; threshold: number | null };
  /** The lanes kept for a phase (control-tower phase 100), armed or waiting for their lane. Absent ⇒ nothing. */
  reservations?: { armed: number; waiting: number };
};

/**
 * One account window's forecast (control-tower phase 92, #141), labelled by the
 * account's ID — never its email, which a scrape must not carry. `burnPctPerHour`
 * is null until measured; `wallsInSeconds` null when the window is flat,
 * unmeasured, or resets before it walls.
 */
/** One account's credit spend (control-tower phase 93, #146). */
export type MetricsAccountCredit = { account: string; currency: string; used: number };

export type MetricsAccountWindow = {
  account: string;
  window: string;
  utilization: number;
  burnPctPerHour: number | null;
  wallsInSeconds: number | null;
};

/**
 * The board states a phase can be in — the label values of
 * `phase_console_phases`.
 *
 * MEMBERS from `shared/status-vocab.js`'s `BOARD_BUCKETS` (the one owner);
 * only the EMISSION ORDER is decided here, because these become metric lines
 * and reordering them churns every scrape diff for no reason.
 */
const EMIT_RANK: Record<string, number> = {
  done: 0, ready: 1, 'in-progress': 2, waiting: 3, stuck: 4,
};
export const PHASE_STATES: readonly PhaseState[] = Object.freeze(
  [...BOARD_BUCKETS].sort((a, b) => (EMIT_RANK[a] ?? 99) - (EMIT_RANK[b] ?? 99)),
);

/**
 * Every family this endpoint emits, in the order it emits them.
 *
 * Exported because it IS the contract: `test/metrics.test.ts` asserts the
 * rendered text carries exactly these families and no others, so a family
 * added without a line here — or a line added without an emitter — fails.
 */
export const METRIC_FAMILIES: readonly (readonly [string, 'gauge' | 'counter', string])[] = [
  ['phase_console_build_info', 'gauge', 'Console version and instance, always 1.'],
  ['phase_console_scrape_duration_seconds', 'gauge', 'Seconds spent assembling this response.'],
  ['phase_console_plans', 'gauge', 'Plans, by plan status and whether the operator has closed them.'],
  ['phase_console_phases', 'gauge', 'Phases per plan, by board state.'],
  ['phase_console_plan_progress_ratio', 'gauge', 'Done phases over total phases, 0 to 1.'],
  ['phase_console_plan_remaining_weight', 'gauge', 'Unfinished phase weight, in the plan sizing units.'],
  ['phase_console_runs', 'gauge', 'Autopilot runs per plan, by run status.'],
  ['phase_console_phase_attempts_total', 'counter', 'Sessions the console has launched for a plan.'],
  ['phase_console_phase_seconds_total', 'counter', 'Wall-clock seconds phases of a plan have run for.'],
  ['phase_console_run_blocked_seconds_total', 'counter',
    'Wall-clock seconds a plan\'s runs had a phase waiting in the admission queue, by the class of what held it: other-run, hand, clock or own-run. Each second counts once, however many phases waited.'],
  ['phase_console_spend_usd_total', 'counter', 'USD every session of a plan has cost (the run total).'],
  ['phase_console_phase_spend_usd_total', 'counter', 'USD attributed to a numbered phase of a plan.'],
  ['phase_console_spend_residual_usd', 'gauge',
    'Run total minus what is attributed to phases. Non-zero means a run file disagrees with itself.'],
  ['phase_console_ladder_spend_usd_total', 'counter',
    'USD the remediation ladder was charged on a plan. A SUBSET of the run total.'],
  ['phase_console_ladder_rungs_total', 'counter', 'Ladder rungs climbed, by rung and how each ended.'],
  ['phase_console_settled_usd_today', 'gauge',
    "USD settled by phases that ended today, in the operator's zone."],
  ['phase_console_ladder_usd_today', 'gauge',
    'USD the ladder was charged today - the figure the day cap refuses a rung against.'],
  ['phase_console_day_cap_usd', 'gauge', "The ladder's per-day USD cap. Absent when no cap is set."],
  // Appended at the END rather than grouped with the other per-plan gauges: the
  // emission order is a scrape's line order, and reordering it churns every
  // diff of a saved scrape for no gain. All three are absent — not zero — on a
  // console with no isolated run.
  ['phase_console_worktrees', 'gauge',
    'Console-managed checkouts a plan\'s isolated run holds. Absent when no isolated run exists.'],
  ['phase_console_worktree_disk_bytes', 'gauge',
    'Bytes those checkouts occupy. Absent where du could not answer.'],
  ['phase_console_branch_conflicted_files', 'gauge',
    'Files a plan\'s run branch already conflicts on with another live branch.'],
  // The account forecast (control-tower phase 92, #141): per account id and
  // window, the reading, the measured burn and the time to the projected wall.
  ['phase_console_account_usage_ratio', 'gauge',
    'An account window\'s utilization, 0 to 1, by account id and window.'],
  ['phase_console_account_burn_ratio_per_hour', 'gauge',
    'An account window\'s measured burn, utilization per hour, from a line through the last hour\'s readings. Absent until measured.'],
  ['phase_console_account_wall_seconds', 'gauge',
    'Seconds until an account window walls at its measured burn. Absent when it is flat, unmeasured, or resets first.'],
  // Account credits (control-tower phase 93, #146): what each account has
  // spent this month past its plan windows, in its own currency.
  ['phase_console_account_credit_used', 'gauge',
    'Credits an account has used this month, in its currency\'s major unit, by account id and currency. Absent while its credit state is unknown.'],
  // Lanes, policies and capacity (control-tower phase 100, #135 D and G): the
  // load the guard reads, the line it holds new admissions at, and the lanes
  // kept for a phase.
  ['phase_console_load_average', 'gauge',
    'The machine\'s 5-minute load average — the reading the load guard holds new admissions on.'],
  ['phase_console_load_guard_threshold', 'gauge',
    'The 5-minute load above which new admissions wait: the guard\'s factor times the machine\'s cores. Absent when the guard is off.'],
  ['phase_console_lane_reservations', 'gauge',
    'Lanes kept for a phase, by `armed` — `yes` once the lane each waits for has ended and it is holding its scope and slot.'],
  // The console's OWN runtime (control-tower phase 7). Every family above is
  // about the WORK; none of them was about the supervisor, which is how a
  // console climbed to a 4 GB heap over 23.7 hours with no sample anywhere
  // that would have shown the climb, and then took two live runs down with it.
  // Cheapest gauges here by a distance — `process.memoryUsage()` and three
  // counters the process already holds.
  ['phase_console_process_heap_used_bytes', 'gauge', 'V8 heap in use by this console process.'],
  ['phase_console_process_heap_limit_bytes', 'gauge',
    'The heap this console may grow to — what `--max-old-space-size` set, as V8 reports it. The ratio against heap_used is the series worth alerting on.'],
  ['phase_console_process_resident_bytes', 'gauge', 'Resident set size of this console process.'],
  ['phase_console_process_external_bytes', 'gauge',
    'Memory held outside V8\'s heap by this process — buffers, and the SSE write buffers a slow client fills.'],
  ['phase_console_process_event_loop_delay_seconds', 'gauge',
    'How late this console\'s event loop is running — the mean over the last complete one-minute window. A supervisor that cannot answer promptly is one nothing else can either.'],
  ['phase_console_process_event_loop_delay_max_seconds', 'gauge',
    'The worst event-loop delay in the last complete one-minute window. A stall shows here for a whole window; a mean would average it away.'],
  ['phase_console_process_event_loop_delay_p99_seconds', 'gauge',
    'The 99th-percentile event-loop delay in the last complete one-minute window — the tail every request and hook waited behind.'],
  ['phase_console_process_handles', 'gauge', 'Open handles this process holds — sockets, timers, child processes.'],
  ['phase_console_process_uptime_seconds', 'gauge',
    'Seconds since this console process started. A series that keeps resetting is a crash loop, whatever the other gauges say.'],
  ['phase_console_process_sse_clients', 'gauge', 'Event-stream clients this console is writing to.'],
  ['phase_console_process_sessions', 'gauge', 'Claude sessions this console has live right now.'],
  ['phase_console_process_pty_sessions', 'gauge', 'Terminal (pty) sessions this console is holding open.'],
  // The process-lifetime counters (5.1.0, `server/counters.ts`). Appended for
  // the same reason as the three above, and monotonic WITHIN a process: a
  // restart resets them, which is what a Prometheus counter is. `build_info`
  // already carries the identity a scraper needs to tell one process's series
  // from the next.
  ['phase_console_log_lines_total', 'counter', 'Console log lines written, by level. A line the level dropped is not counted.'],
  ['phase_console_journal_appends_total', 'counter', 'Journal lines appended across every run this process drove.'],
  ['phase_console_journal_overflow_total', 'counter', 'Journals that crossed the soft cap and fell back to the terminal reserve.'],
  ['phase_console_transcript_shed_total', 'counter', 'Transcript records dropped rather than stored, by kind.'],
  ['phase_console_git_commands_total', 'counter', 'Git commands run through the seam, by verb and whether they exited 0.'],
  ['phase_console_git_command_seconds_total', 'counter', 'Seconds spent inside git, by verb.'],
  ['phase_console_engine_calls_total', 'counter', 'Bash engine calls, by script and whether the answer was cached.'],
  ['phase_console_http_requests_total', 'counter', 'HTTP requests answered, by status class.'],
  ['phase_console_shell_commands_total', 'counter', 'Other child processes run through the seam, by binary and whether they exited 0.'],
  ['phase_console_retention_removed_total', 'counter', 'Files retention deleted, by sink.'],
  // The check (control-tower phase 134): checks by who wrote the verdict and
  // what it was (`none` — the checker produced none), and what the checking
  // sessions cost, by model.
  ['phase_console_turn_checks_total', 'counter', 'Checks of a person\'s items, by who wrote the verdict and what it was.'],
  ['phase_console_turn_check_usd_total', 'counter', 'USD the checking sessions cost, by model.'],
  ['phase_console_turn_rounds_total', 'counter', 'Rounds that changed Your turn, by what woke them (the clock or a journal line).'],
  ['phase_console_turn_handled_total', 'counter', 'Things the AI handled instead of asking a person, by source.'],
];

/** The counter families, in emission order, with the labels each is keyed by. */
const COUNTER_FAMILIES: readonly (readonly [CounterFamily, string, readonly string[]])[] = [
  ['log_lines_total', 'phase_console_log_lines_total', ['level']],
  ['journal_appends_total', 'phase_console_journal_appends_total', []],
  ['journal_overflow_total', 'phase_console_journal_overflow_total', []],
  ['transcript_shed_total', 'phase_console_transcript_shed_total', ['kind']],
  ['git_commands_total', 'phase_console_git_commands_total', ['verb', 'ok']],
  ['git_command_seconds_total', 'phase_console_git_command_seconds_total', ['verb']],
  ['engine_calls_total', 'phase_console_engine_calls_total', ['script', 'cache']],
  ['http_requests_total', 'phase_console_http_requests_total', ['status']],
  ['shell_commands_total', 'phase_console_shell_commands_total', ['command', 'ok']],
  ['retention_removed_total', 'phase_console_retention_removed_total', ['sink']],
  ['turn_checks_total', 'phase_console_turn_checks_total', ['by', 'verdict']],
  ['turn_check_usd_total', 'phase_console_turn_check_usd_total', ['model']],
  ['turn_rounds_total', 'phase_console_turn_rounds_total', ['trigger']],
  ['turn_handled_total', 'phase_console_turn_handled_total', ['source']],
];

/**
 * A label value, escaped as the exposition format requires.
 *
 * Backslash, double quote and newline are the three characters that can end a
 * label early and turn the rest of the line into something a parser will refuse
 * — and a plan slug comes off a filesystem, so none of them is impossible.
 */
export function escapeLabel(value: string): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

/**
 * A sample value.
 *
 * A non-finite number is DROPPED by the caller rather than printed: Prometheus
 * accepts `NaN`, but a NaN in a dashboard is indistinguishable from a broken
 * query, and every quantity here has an honest zero.
 */
function num(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e6) / 1e6);
}

type Sample = { labels?: Record<string, string>; value: number };

/** One family: its HELP, its TYPE, and its samples. Emits nothing at all when it has none. */
function family(name: string, type: string, help: string, samples: Sample[]): string[] {
  const usable = samples.filter((s) => Number.isFinite(s.value));
  if (!usable.length) return [];
  const lines = [`# HELP ${name} ${help.replace(/\n/g, ' ')}`, `# TYPE ${name} ${type}`];
  for (const sample of usable) {
    const pairs = Object.entries(sample.labels ?? {})
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}="${escapeLabel(String(v))}"`);
    lines.push(`${name}${pairs.length ? `{${pairs.join(',')}}` : ''} ${num(sample.value)}`);
  }
  return lines;
}

/** Tally a list into `key -> count`, sorted by key so a scrape is byte-stable. */
function tally<T>(list: readonly T[], key: (item: T) => string): [string, number][] {
  const counts = new Map<string, number>();
  for (const item of list) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** Sum a per-plan quantity, one entry per slug that has any, slug-sorted. */
function bySlug<T>(list: readonly T[], slug: (item: T) => string, value: (item: T) => number): Sample[] {
  const sums = new Map<string, number>();
  for (const item of list) sums.set(slug(item), (sums.get(slug(item)) ?? 0) + value(item));
  return [...sums.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, total]) => ({ labels: { slug: name }, value: total }));
}

/** Index into `METRIC_FAMILIES` by name, so an emitter cannot drift from its own HELP text. */
function help(name: string): string {
  const row = METRIC_FAMILIES.find(([id]) => id === name);
  if (!row) throw new Error(`metrics: ${name} has no METRIC_FAMILIES entry`);
  return row[2];
}

/**
 * The whole response body.
 *
 * Deterministic: every list is sorted, so two scrapes of an unchanged console
 * are byte-identical and a diff of them is a diff of the console's state.
 * Ends with a newline, which the format requires and which a `curl` without
 * one makes very annoying to read.
 */
export function renderMetrics(facts: MetricsFacts): string {
  const plans = facts?.plans ?? [];
  const runs = facts?.runs ?? [];
  const cost = facts?.cost ?? [];
  const rungs = facts?.rungs ?? [];
  const today = facts?.today ?? { settledUsd: 0, ladderUsd: 0, capUsd: null };
  const out: string[] = [];
  const emit = (name: string, type: 'gauge' | 'counter', samples: Sample[]): void => {
    out.push(...family(name, type, help(name), samples));
  };

  // Last, so nothing above it moves: a scrape's line order is what a saved
  // diff is read against.
  const emitCounters = () => {
    for (const [family, name, labelNames] of COUNTER_FAMILIES) {
      const rows = readCounter(family);
      if (!rows.length) continue; // absent is honest; a zero would be a claim
      emit(name, 'counter', rows.map(([values, value]) => ({
        labels: Object.fromEntries(labelNames.map((label, i) => [label, values[i] ?? ''])),
        value,
      })));
    }
  };

  emit('phase_console_build_info', 'gauge', [{
    labels: { version: facts?.version ?? 'unknown', instance: facts?.instanceId ?? 'unknown' },
    value: 1,
  }]);

  if (typeof facts?.scrapeSeconds === 'number') {
    emit('phase_console_scrape_duration_seconds', 'gauge', [{ value: facts.scrapeSeconds }]);
  }

  // The console's own process. Unlabelled scalars: there is exactly one of it,
  // and a label would invite a second series that cannot exist.
  const proc = facts?.process;
  if (proc) {
    const scalar = (name: string, value: number | undefined): void => {
      if (typeof value !== 'number') return;
      emit(name, 'gauge', [{ value }]);
    };
    scalar('phase_console_process_heap_used_bytes', proc.heapUsedBytes);
    scalar('phase_console_process_heap_limit_bytes', proc.heapLimitBytes);
    scalar('phase_console_process_resident_bytes', proc.residentBytes);
    scalar('phase_console_process_external_bytes', proc.externalBytes);
    scalar('phase_console_process_event_loop_delay_seconds', proc.eventLoopDelaySeconds);
    scalar('phase_console_process_event_loop_delay_max_seconds', proc.eventLoopDelayMaxSeconds);
    scalar('phase_console_process_event_loop_delay_p99_seconds', proc.eventLoopDelayP99Seconds);
    scalar('phase_console_process_handles', proc.handles);
    scalar('phase_console_process_uptime_seconds', proc.uptimeSeconds);
    scalar('phase_console_process_sse_clients', proc.sseClients);
    scalar('phase_console_process_sessions', proc.sessions);
    scalar('phase_console_process_pty_sessions', proc.ptySessions);
  }

  emit('phase_console_plans', 'gauge',
    tally(plans, (p) => `${p.status ?? 'unknown'} ${p.closed ? '1' : '0'}`).map(([key, count]) => {
      const [status, closed] = key.split(' ');
      return { labels: { status: status ?? 'unknown', closed: closed ?? '0' }, value: count };
    }));

  const sorted = [...plans].sort((a, b) => a.slug.localeCompare(b.slug));

  emit('phase_console_phases', 'gauge',
    sorted.flatMap((p) => PHASE_STATES.map((state) => ({
      labels: { slug: p.slug, state },
      value: state === 'done' ? p.done
        : state === 'ready' ? p.ready
        : state === 'in-progress' ? p.inProgress
        : state === 'waiting' ? p.waiting
        : p.stuck,
    }))));

  emit('phase_console_plan_progress_ratio', 'gauge',
    sorted.map((p) => ({ labels: { slug: p.slug }, value: p.phases > 0 ? p.done / p.phases : 0 })));
  emit('phase_console_plan_remaining_weight', 'gauge',
    sorted.map((p) => ({ labels: { slug: p.slug }, value: p.remainingWeight })));

  emit('phase_console_runs', 'gauge',
    tally(runs, (r) => `${r.slug} ${r.status}`).map(([key, count]) => {
      const [slug, status] = key.split(' ');
      return { labels: { slug: slug ?? '', status: status ?? 'unknown' }, value: count };
    }));

  emit('phase_console_phase_attempts_total', 'counter', bySlug(runs, (r) => r.slug, (r) => r.attempts));
  emit('phase_console_phase_seconds_total', 'counter', bySlug(runs, (r) => r.slug, (r) => r.phaseSeconds));
  // The WALL-CLOCK a run was blocked, by WHOSE claim held it (#64): blocked by
  // others is the `other-run`, `hand` and `clock` series; `own-run` is
  // pipelining, and a phase behind its own live lane is not queued at all.
  // Never the phases' queued lane-time summed — three siblings behind one
  // stranger for an hour are one hour here.
  const blocked = new Map<string, number>();
  for (const run of runs) {
    for (const [klass, seconds] of Object.entries(run.blockedSeconds ?? {})) {
      if (!seconds) continue;
      const key = `${run.slug} ${klass}`;
      blocked.set(key, (blocked.get(key) ?? 0) + seconds);
    }
  }
  emit('phase_console_run_blocked_seconds_total', 'counter', [...blocked.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => {
      const [slug, klass] = key.split(' ');
      return { labels: { slug: slug ?? '', class: klass ?? '' }, value };
    }));

  emit('phase_console_spend_usd_total', 'counter', bySlug(cost, (c) => c.slug, (c) => c.totalUsd));
  emit('phase_console_phase_spend_usd_total', 'counter', bySlug(cost, (c) => c.slug, (c) => c.attributedUsd));
  emit('phase_console_spend_residual_usd', 'gauge', bySlug(cost, (c) => c.slug, (c) => c.residualUsd));
  emit('phase_console_ladder_spend_usd_total', 'counter', bySlug(cost, (c) => c.slug, (c) => c.ladderUsd));

  emit('phase_console_ladder_rungs_total', 'counter',
    tally(rungs, (r) => `${r.rung} ${r.outcome ?? 'running'}`).map(([key, count]) => {
      const [rung, outcome] = key.split(' ');
      return { labels: { rung: rung ?? 'unknown', outcome: outcome ?? 'running' }, value: count };
    }));

  emit('phase_console_settled_usd_today', 'gauge', [{ value: today.settledUsd }]);
  emit('phase_console_ladder_usd_today', 'gauge', [{ value: today.ladderUsd }]);
  // Absent, not zero: no cap set and a cap of zero are opposite facts, and a
  // zero here would alert as "the ladder can never spend again". ONE decision
  // point on purpose — a redundant `typeof` guard upstream of the non-finite
  // filter would be a rule no test could prove is doing anything.
  emit('phase_console_day_cap_usd', 'gauge', today.capUsd == null ? [] : [{ value: today.capUsd }]);

  // The isolated runs' checkout load. `bySlug` is not used: these are per-run
  // measurements of a directory, not sums of a per-run quantity, and two runs
  // of one plan cannot both hold the plan's managed trees.
  const git = [...(facts?.git ?? [])].sort((a, b) => a.slug.localeCompare(b.slug));
  emit('phase_console_worktrees', 'gauge',
    git.map((entry) => ({ labels: { slug: entry.slug }, value: entry.worktrees })));
  // A `du` that could not answer is DROPPED by the non-finite filter in
  // `family()`, one slug at a time: a console where one checkout is unmeasurable
  // still reports the others rather than losing the family.
  emit('phase_console_worktree_disk_bytes', 'gauge',
    git.map((entry) => ({ labels: { slug: entry.slug }, value: entry.diskBytes ?? NaN })));
  emit('phase_console_branch_conflicted_files', 'gauge',
    git.map((entry) => ({ labels: { slug: entry.slug }, value: entry.conflictedFiles })));

  // The account forecast, account- then window-sorted. An unmeasured burn or a
  // wall that is not projected is DROPPED by `family()`'s non-finite filter:
  // absent is "nothing measured", never a zero nobody read.
  const windows = [...(facts?.accounts ?? [])]
    .sort((a, b) => a.account.localeCompare(b.account) || a.window.localeCompare(b.window));
  const labelled = (entry: MetricsAccountWindow, value: number): Sample =>
    ({ labels: { account: entry.account, window: entry.window }, value });
  emit('phase_console_account_usage_ratio', 'gauge', windows.map((entry) => labelled(entry, entry.utilization / 100)));
  emit('phase_console_account_burn_ratio_per_hour', 'gauge',
    windows.map((entry) => labelled(entry, entry.burnPctPerHour === null ? NaN : entry.burnPctPerHour / 100)));
  emit('phase_console_account_wall_seconds', 'gauge',
    windows.map((entry) => labelled(entry, entry.wallsInSeconds ?? NaN)));
  emit('phase_console_account_credit_used', 'gauge', [...(facts?.credits ?? [])]
    .sort((a, b) => a.account.localeCompare(b.account))
    .map((entry) => ({ labels: { account: entry.account, currency: entry.currency }, value: entry.used })));
  // Lanes, policies and capacity (control-tower phase 100).
  emit('phase_console_load_average', 'gauge', facts?.load ? [{ value: facts.load.avg5 }] : []);
  emit('phase_console_load_guard_threshold', 'gauge',
    facts?.load && facts.load.threshold !== null ? [{ value: facts.load.threshold }] : []);
  emit('phase_console_lane_reservations', 'gauge', facts?.reservations
    ? [{ labels: { armed: 'yes' }, value: facts.reservations.armed }, { labels: { armed: 'no' }, value: facts.reservations.waiting }]
    : []);

  emitCounters();

  return `${out.join('\n')}\n`;
}

/** What `Content-Type` a Prometheus scraper expects. */
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
