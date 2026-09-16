/**
 * `claude ultrareview` — the CLI's cloud multi-agent review, as a run tier.
 *
 * The subcommand clones the checkout into a cloud sandbox, fans a review out
 * across agents there, blocks until it finishes and prints what it found. That
 * makes it a very different animal from the auto reviewer next door: it is one
 * child process rather than a session, it is billed on the operator's cloud
 * budget rather than metered in `costUsd`, and it takes tens of minutes. Three
 * consequences shape everything in this file.
 *
 * **The runner spawns it, never a phase session.** A thirty-minute foreground
 * wait inside a session's turn is precisely what the wait-denial exists to
 * stop: the turn produces nothing and the phase's exclusive lock is held for
 * the whole wait. So this module is called from the drive loop, on the
 * console's own clock, with the run's account environment.
 *
 * **A tool that is not there is a fact, not a park.** Feature detection, a
 * non-zero exit, a timeout, an unreadable payload — every one of them ends as
 * `unknown` with the reason attached, the run CONTINUES, and nothing is
 * recorded as a verdict. The failure mode this rules out is the expensive one:
 * a review that did not happen reading as `approved`, which is a clean bill of
 * health manufactured by an absent binary.
 *
 * **The payload is parsed tolerantly and read strictly.** `--json` prints the
 * raw bugs.json, whose exact schema this console has not pinned against a live
 * run (it is billed work — see the phase handoff's errand). So the reader
 * accepts several spellings of the same field, keeps what it does not
 * recognise out of its way, and — the load-bearing half — returns `null` rather
 * than a verdict whenever it cannot find a findings container at all. An empty
 * container it DID find is an approval; a container it could not find is not.
 *
 * ## Feature detection reads the help TEXT, not the exit code
 *
 * Measured on `claude` 2.1.258: `claude nosuchsubcommand --help` also exits 0,
 * printing the top-level usage, because an unknown word is taken as a prompt.
 * Exit status alone would therefore report the capability present on every CLI
 * version ever shipped, including the ones that never had it. So the probe
 * matches the subcommand's own usage line, and anything else is `unavailable`.
 */

import { spawn as spawnChild } from 'node:child_process';

import {
  applyVerdictPolicy, MAX_REVIEWER_COMMENTS,
  type ReviewerFinding, type ReviewerReport, type ReviewerVerdictPolicy,
} from '../reviewer.ts';
import { isReviewVerdict, type ReviewVerdict } from '../review.ts';
import { killLadder, type LadderEnding } from './signals.ts';

/** The subcommand, spelled once. */
export const ULTRAREVIEW_SUBCOMMAND = 'ultrareview';

/**
 * How long the console waits, in minutes.
 *
 * The CLI's own default is 30 and this matches it deliberately: a shorter
 * console-side clock would kill reviews the tool considers still in progress
 * and bill the operator for nothing. The child gets the same number through
 * `--timeout`, so the two clocks agree, and the process ladder below is the
 * backstop for a child that ignores its own.
 */
export const ULTRAREVIEW_TIMEOUT_MINUTES = 30;

/** Grace between SIGTERM and SIGKILL when the backstop fires. */
const KILL_GRACE_MS = 15_000;

/** The probe is a help screen; it must never take this long. */
const PROBE_TIMEOUT_MS = 20_000;

/** Keep the tail of a chatty child rather than the whole of it. */
const MAX_OUTPUT = 4 * 1024 * 1024;
const KEEP_OUTPUT = 64 * 1024;

/**
 * Where a run reaches for this — the resolved moment, not the setting.
 *
 * `each-phase` and `at-settle` are the operator's words (`ULTRA_REVIEW_MODES`);
 * `on-demand` is the one-click verb, which runs the at-settle shape whenever a
 * person asks for it and is therefore not a mode anybody can leave switched on.
 */
export type UltraReviewOccasion = 'each-phase' | 'at-settle' | 'on-demand';

export type UltraReviewOptions = {
  /** The checkout to review — the lane worktree, or the run root at settle. */
  cwd: string;
  /** The run's account environment, from `sessionEnv`. */
  env?: NodeJS.ProcessEnv;
  /** What the verdict may DO. Same policy the session reviewer obeys. */
  policy: ReviewerVerdictPolicy;
  /** A PR number or base branch. Absent reviews the current branch. */
  target?: string;
  timeoutMinutes?: number;
  /** Paths the caller can anchor a comment to. Absent keeps every path. */
  knownPaths?: readonly string[];
  /** Test seam: the child spawner. */
  spawn?: typeof spawnChild;
  signal?: AbortSignal;
};

/**
 * What happened, in the three-state shape `watch-refs.ts` established.
 *
 * `landed` carries a report. `unknown` carries a reason and nothing else — and
 * the caller treats `unknown` exactly as it behaved before this tier existed,
 * which is the whole degradation contract.
 */
export type UltraReviewResult =
  | { state: 'landed'; report: ReviewerReport; ms: number; findings: number }
  | { state: 'unknown'; reason: string; ms: number; code?: number; how?: LadderEnding };

/**
 * The argv, built once so the test and the runner cannot disagree about it.
 *
 * `--no-post` is passed explicitly even though it is the CLI's default: this
 * console never writes to a pull request on a run's behalf, and a default is a
 * thing that can change under you. `--json` is what makes the output readable
 * at all. The target, when there is one, comes last — it is positional.
 */
export function ultraReviewArgv(opts: { target?: string; timeoutMinutes?: number } = {}): string[] {
  const minutes = Math.max(1, Math.round(opts.timeoutMinutes ?? ULTRAREVIEW_TIMEOUT_MINUTES));
  const argv = [ULTRAREVIEW_SUBCOMMAND, '--json', '--no-post', '--timeout', String(minutes)];
  const target = opts.target?.trim();
  if (target) argv.push(target);
  return argv;
}

/** The usage line the real subcommand prints, and nothing else does. */
const USAGE_LINE = /^\s*Usage:\s+claude\s+ultrareview\b/m;

/**
 * Is the subcommand here at all?
 *
 * Answers a REASON on the way down, because every door that has to say
 * "unavailable" has to say why, and "the CLI on this machine has no
 * `ultrareview` subcommand" is a different errand from "`claude` is not on
 * PATH".
 */
export async function probeUltraReview(
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; spawn?: typeof spawnChild } = {},
): Promise<{ available: boolean; reason?: string }> {
  const run = await runChild(
    [ULTRAREVIEW_SUBCOMMAND, '--help'],
    { cwd: opts.cwd, env: opts.env, spawn: opts.spawn, timeoutMs: PROBE_TIMEOUT_MS },
  );
  if (run.spawnError) {
    return {
      available: false,
      reason: /ENOENT/.test(run.spawnError)
        ? 'the `claude` CLI is not on this console\'s PATH'
        : `the \`claude\` CLI could not be started: ${run.spawnError}`,
    };
  }
  if (USAGE_LINE.test(run.stdout) || USAGE_LINE.test(run.stderr)) return { available: true };
  return {
    available: false,
    // Deliberately not "it exited non-zero": it usually exits ZERO. An unknown
    // word is taken as a prompt and the top-level usage is printed instead.
    reason: 'this `claude` CLI has no `ultrareview` subcommand — its help names no such command',
  };
}

/**
 * Run one cloud review and turn it into a report the review store can hold.
 *
 * Every exit is a value, never a throw: the caller is a drive loop that must
 * keep driving whatever this answers.
 */
export async function runUltraReview(opts: UltraReviewOptions): Promise<UltraReviewResult> {
  const started = Date.now();
  const probe = await probeUltraReview({ cwd: opts.cwd, env: opts.env, spawn: opts.spawn });
  if (!probe.available) {
    return { state: 'unknown', reason: probe.reason ?? 'unavailable', ms: Date.now() - started };
  }

  const minutes = opts.timeoutMinutes ?? ULTRAREVIEW_TIMEOUT_MINUTES;
  const run = await runChild(ultraReviewArgv({ target: opts.target, timeoutMinutes: minutes }), {
    cwd: opts.cwd,
    env: opts.env,
    spawn: opts.spawn,
    // A minute of slack past the child's own clock: the console's ladder is the
    // backstop for a child that ignored `--timeout`, not a second deadline
    // racing the first one.
    timeoutMs: (minutes + 1) * 60_000,
    signal: opts.signal,
  });
  const ms = Date.now() - started;

  if (run.spawnError) {
    return { state: 'unknown', reason: `the review could not be started: ${run.spawnError}`, ms };
  }
  if (run.cut) {
    return {
      state: 'unknown',
      reason: run.cut === 'timeout'
        ? `the review did not finish within ${minutes + 1} minutes`
        : 'the run was stopped before the review finished',
      ms, ...(run.how ? { how: run.how } : {}),
    };
  }
  if (run.code !== 0) {
    // stderr is where the CLI puts its refusals — "needs a git repository",
    // an auth wall, a cloud outage. Carried verbatim, condensed, because the
    // operator errand is the reason to keep it at all.
    return {
      state: 'unknown',
      reason: condense(run.stderr || run.stdout) || `the review exited ${run.code}`,
      ms, code: run.code,
    };
  }

  const report = parseUltraReviewPayload(run.stdout, opts.policy, opts.knownPaths);
  if (!report) {
    return {
      state: 'unknown',
      reason: 'the review produced no payload this console could read',
      ms, code: run.code,
    };
  }
  return { state: 'landed', report, ms, findings: report.findings.length };
}

/**
 * The three journal lines this tier writes, spelled once.
 *
 * `documented in docs/journal-events.md` is not a courtesy here —
 * `test/docs-parity.test.ts` scans every string literal under `server/` for an
 * event name and fails on one with no row.
 */
export const ULTRAREVIEW_EVENTS = Object.freeze({
  started: 'run.ultrareview',
  done: 'run.ultrareview-done',
  skipped: 'run.ultrareview-skipped',
});

export type UltraReviewJob = UltraReviewOptions & {
  occasion: UltraReviewOccasion;
  slug: string;
  /** The phase the findings hang on — the one that finished, or the run's last. */
  phase: number;
  /** The run journal. Same `(event, data, phase)` order the runner's own uses. */
  record: (event: string, data: Record<string, unknown>, phase?: number) => void;
  /** The review store. Absent means nowhere to put a verdict — a skip, not a run. */
  store?: (slug: string, phase: number, report: ReviewerReport) => void;
};

/**
 * One cloud review, start to journalled finish — the whole path both callers
 * take.
 *
 * The runner reaches it at a phase-finish and before a settle; the on-demand
 * verb reaches it from the Service, which has neither a lane nor a loop. What
 * they genuinely differ about is the checkout, the environment and the phase;
 * everything after that — the announcement, the degradation, the recording, the
 * words in the journal — is this function, so the two cannot drift into
 * disagreeing about what a cloud review DID.
 */
export async function ultraReviewJob(job: UltraReviewJob): Promise<UltraReviewResult> {
  const { occasion, slug, phase, record, store, ...options } = job;
  if (!store) {
    const reason = 'no review surface is wired to this console';
    record(ULTRAREVIEW_EVENTS.skipped, { occasion, reason }, phase);
    return { state: 'unknown', reason, ms: 0 };
  }
  record(ULTRAREVIEW_EVENTS.started, {
    occasion, policy: options.policy, cwd: options.cwd,
    ...(options.target ? { target: options.target } : {}),
  }, phase);

  const result = await runUltraReview(options);
  if (result.state === 'unknown') {
    // The honest degradation, and the whole reason this tier is safe to leave
    // switched on: no verdict is recorded, the reason is, and the run drives on.
    record(ULTRAREVIEW_EVENTS.done, {
      occasion, ok: false, reason: result.reason, ms: result.ms,
      ...(result.code != null ? { code: result.code } : {}),
      ...(result.how ? { how: result.how } : {}),
    }, phase);
    return result;
  }

  try {
    store(slug, phase, result.report);
  } catch (error) {
    const reason = `the verdict could not be stored: ${(error as Error)?.message ?? String(error)}`;
    record(ULTRAREVIEW_EVENTS.done, { occasion, ok: false, reason, ms: result.ms }, phase);
    return { state: 'unknown', reason, ms: result.ms };
  }

  record(ULTRAREVIEW_EVENTS.done, {
    occasion, ok: true, verdict: result.report.verdict,
    findings: result.findings, ms: result.ms,
    // Present only when the run's policy overrode what the tool asked for — the
    // one line that explains a `commented` chip on a review that plainly says
    // the code must change.
    ...(result.report.askedFor
      ? { askedFor: result.report.askedFor, downgradedBy: options.policy }
      : {}),
  }, phase);
  return result;
}

/**
 * One call at a time per key, sharing the answer with everyone who asked.
 *
 * A double-tapped button, or two people on one console, would otherwise buy two
 * identical cloud reviews of one branch — and the second's findings would land
 * on top of the first's, so nobody would even see what they paid for. Keyed
 * rather than global: two plans reviewing at once is two branches, which is two
 * reviews somebody meant to buy.
 */
export function singleFlight<T>(
  inFlight: Map<string, Promise<T>>, key: string, start: () => Promise<T>,
): Promise<T> {
  const running = inFlight.get(key);
  if (running) return running;
  // The promise STORED is the one returned, chain and all: hand out `start()`'s
  // own promise and the two callers would hold different objects that merely
  // settle alike, which is a single-flight nothing can assert. `finally` rather
  // than a try/finally around an await, so the key clears when the work ends
  // and not when the first caller happens to look.
  const shared = start().finally(() => { inFlight.delete(key); });
  inFlight.set(key, shared);
  return shared;
}

/**
 * The phase a run-wide review hangs its findings on.
 *
 * The highest-numbered phase this run finished, which on a DAG is the closest
 * thing there is to "the end of the work" — and, more practically, the row an
 * operator opening the run looks at first. `null` when the run finished none,
 * which is a skip: a review with nowhere to be recorded has not been done.
 */
export function lastFinishedPhase(
  records: Record<string, { phase: number; status: string }> | undefined,
): number | null {
  let best: number | null = null;
  for (const record of Object.values(records ?? {})) {
    if (record.status !== 'done') continue;
    if (best == null || record.phase > best) best = record.phase;
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * The payload
 * ------------------------------------------------------------------ */

/** Every spelling of "the list of things found" this reader will accept. */
const FINDING_CONTAINERS = ['bugs', 'findings', 'issues', 'comments', 'problems', 'results'];

/** Every spelling of a finding's file, its line, and what is wrong with it. */
const PATH_KEYS = ['path', 'file', 'filename', 'file_path', 'filePath'];
const LINE_KEYS = ['line', 'start_line', 'startLine', 'line_number', 'lineNumber'];
const BODY_KEYS = ['body', 'description', 'message', 'text', 'detail', 'explanation'];
const TITLE_KEYS = ['title', 'summary', 'headline'];

/**
 * Read `bugs.json` into a `ReviewerReport`, or answer that it could not.
 *
 * Two rules, and the second is the one that keeps this honest.
 *
 * **Unknown fields are kept out of the way, not guessed at.** A payload that
 * grows a column reads exactly as it did before; a finding that spells its file
 * `file` rather than `path` is still a finding.
 *
 * **A container it could not find is `null`, never an approval.** Zero findings
 * inside a list this reader recognised is a clean bill of health and is
 * recorded as one. Zero findings because the schema moved is a parser bug, and
 * a parser bug must never be able to say the code is fine.
 */
export function parseUltraReviewPayload(
  text: string, policy: ReviewerVerdictPolicy, knownPaths?: readonly string[],
): ReviewerReport | null {
  const parsed = readJson(text);
  if (parsed == null) return null;

  let raw: unknown[] | null = null;
  let note: string | undefined;
  let asked: ReviewVerdict | null = null;

  if (Array.isArray(parsed)) {
    // The bare-array shape: the payload IS the finding list.
    raw = parsed;
  } else if (typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    for (const key of FINDING_CONTAINERS) {
      if (Array.isArray(obj[key])) { raw = obj[key] as unknown[]; break; }
    }
    for (const key of [...TITLE_KEYS, 'note']) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) { note = value.trim(); break; }
    }
    // Honoured only when the tool spells a verdict this console already knows.
    // Anything else is left to the finding count, which is a fact rather than
    // a translation of somebody else's vocabulary into ours.
    if (isReviewVerdict(obj.verdict)) asked = obj.verdict;
  }
  if (!raw) return null;

  const allowed = knownPaths?.length ? new Set(knownPaths) : null;
  const findings: ReviewerFinding[] = [];
  for (const item of raw) {
    const finding = readFinding(item, allowed);
    if (!finding) continue;
    findings.push(finding);
    if (findings.length >= MAX_REVIEWER_COMMENTS) break;
  }

  // No stated verdict: the finding count decides, and it decides in the safe
  // direction. Something found is changes requested (the policy may downgrade
  // it); nothing found in a list we really read is an approval.
  const { verdict, askedFor } = applyVerdictPolicy(
    asked ?? (findings.length ? 'requested-changes' : 'approved'), policy,
  );
  return {
    verdict,
    ...(note ? { note: note.slice(0, 8_000) } : {}),
    findings,
    ...(askedFor ? { askedFor } : {}),
  };
}

/** One finding, in whichever of the accepted spellings it arrived. */
function readFinding(item: unknown, allowed: Set<string> | null): ReviewerFinding | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const row = item as Record<string, unknown>;
  const nested = (row.location && typeof row.location === 'object' && !Array.isArray(row.location))
    ? row.location as Record<string, unknown>
    : {};

  const path = firstString(row, PATH_KEYS) ?? firstString(nested, PATH_KEYS);
  if (!path) return null;
  // A path the caller cannot anchor is dropped rather than rendered against a
  // file nobody changed — the same rule the session reviewer's parser obeys.
  if (allowed && !allowed.has(path)) return null;

  const title = firstString(row, TITLE_KEYS);
  const detail = firstString(row, BODY_KEYS);
  // Both, when both are there: a headline with no explanation is a label, and
  // an explanation with no headline is a wall.
  const body = [title, detail].filter(Boolean).join(' — ').trim();
  if (!body) return null;

  const line = firstInteger(row, LINE_KEYS) ?? firstInteger(nested, LINE_KEYS);
  const side = row.side === 'old' ? 'old' as const : row.side === 'new' ? 'new' as const : undefined;
  return {
    path, body: body.slice(0, 4_000),
    ...(line != null ? { line } : {}),
    ...(side ? { side } : {}),
  };
}

function firstString(row: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function firstInteger(row: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

/**
 * The JSON in the child's stdout, whatever it is wrapped in.
 *
 * The CLI prints a payload; a future one might print a progress line first.
 * Whole-string parse, then the last top-level object or array — never a
 * fragment, because a fragment that happens to parse is a finding list nobody
 * wrote.
 */
function readJson(text: string): unknown {
  const body = (text ?? '').trim();
  if (!body) return null;
  try { return JSON.parse(body); } catch { /* keep looking */ }
  for (const open of ['{', '[']) {
    const at = body.indexOf(open);
    if (at < 0) continue;
    const close = body.lastIndexOf(open === '{' ? '}' : ']');
    if (close <= at) continue;
    try { return JSON.parse(body.slice(at, close + 1)); } catch { /* not that one */ }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The child
 * ------------------------------------------------------------------ */

type ChildRun = {
  code: number;
  stdout: string;
  stderr: string;
  cut: 'timeout' | 'abort' | null;
  how?: LadderEnding;
  spawnError?: string;
};

/**
 * Run `claude <argv>` and come back with everything it said.
 *
 * `detached: true` and `killLadder` together are the whole teardown story, and
 * they are not optional: the CLI starts a shell and cloud plumbing of its own,
 * so a bare kill on the pid leaves the group behind. There is no `.kill(` here
 * for exactly that reason — `server/runner/signals.ts` is the only place in
 * `server/` that signals a process, and `test/invariants.test.ts` holds that
 * set fixed in both directions.
 */
function runChild(
  argv: string[],
  opts: {
    cwd?: string; env?: NodeJS.ProcessEnv; spawn?: typeof spawnChild;
    timeoutMs: number; signal?: AbortSignal;
  },
): Promise<ChildRun> {
  const launch = opts.spawn ?? spawnChild;
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let bytes = 0;
    let cut: 'timeout' | 'abort' | null = null;
    let how: LadderEnding | undefined;
    let settled = false;

    const child = launch('claude', argv, {
      cwd: opts.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...(opts.env ?? process.env), NO_COLOR: '1', TERM: 'dumb' },
    });

    const take = (chunk: string, into: 'out' | 'err'): void => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) {
        const keep = chunk.slice(-KEEP_OUTPUT);
        if (into === 'out') out = (out + keep).slice(-KEEP_OUTPUT);
        else err = (err + keep).slice(-KEEP_OUTPUT);
        return;
      }
      if (into === 'out') out += chunk; else err += chunk;
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => take(chunk, 'out'));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => take(chunk, 'err'));

    // Held so `finish` can WAIT for it — resolving while the ladder is still
    // chasing the group would claim a child was cleaned up that is not.
    let ending: Promise<void> | null = null;
    const end = (reason: 'timeout' | 'abort'): void => {
      if (settled || cut) return;
      cut = reason;
      if (child.pid == null) return;
      ending = killLadder(child.pid, { killAfterMs: KILL_GRACE_MS }).then((verdict) => {
        how = verdict;
      }, () => { /* it vanished mid-ladder; `how` stays unset */ });
    };

    const timer = setTimeout(() => { end('timeout'); }, opts.timeoutMs);
    timer.unref?.();
    const onAbort = (): void => { end('abort'); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = async (code: number, spawnError?: string): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ending) await ending;
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        code, stdout: out, stderr: err, cut,
        ...(how ? { how } : {}),
        ...(spawnError ? { spawnError } : {}),
      });
    };

    // `close`, not `exit`: the payload must be drained before it is read.
    child.on('close', (code) => { void finish(typeof code === 'number' ? code : 1); });
    child.on('error', (error: Error) => { void finish(1, error.message); });
  });
}

/** One line, for a journal entry and an operator errand. */
function condense(text: string): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
}
