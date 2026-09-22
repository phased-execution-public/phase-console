/**
 * Lane liveness: is the session that is nominally working actually working?
 *
 * The runner has always known whether a child process EXISTS. It has never
 * known whether that child is doing anything — and the two look identical from
 * every surface the console has: a lane reading `running` at $0.04 a minute
 * with a wedged `Bash` call, a lane reasoning in circles, and a lane about to
 * commit are one word and one spinner. Three real shapes, measured:
 *
 *   - a session whose `Bash` call was waiting on a prompt nobody would ever
 *     type, silent for 51 minutes;
 *   - a session that produced eleven turns of prose in a row because the file
 *     it needed was not there, calling nothing;
 *   - a phase re-attempted three times, each attempt exiting clean, each
 *     leaving the tree exactly as it found it.
 *
 * This file is the part of noticing all three that can be decided from
 * numbers, so it can be tested from numbers. It reads no clock, opens no file
 * and spawns nothing: `applyEvent` folds the stream the runner is already
 * reading into an accumulator, and `evaluateStall` turns an accumulator plus
 * three thresholds into a signal or nothing at all. Everything that needs the
 * world — the 60-second ticker, `git status`, the journal, the announcement —
 * lives in `runner.ts`, which is why that side is fake-clocked in the tests
 * and this side needs no fake at all.
 *
 * The vocabulary (`STALL_SIGNALS`, their labels and the shipped thresholds) is
 * `shared/attention-model.js`, imported rather than restated: the inbox row, the
 * Settings card and this detector must agree about what "ten minutes" is.
 */

import { createHash } from 'node:crypto';

import { LOCAL_JOB_GRACE_MS, STALL_DEFAULTS, STALL_LOCAL_JOB_MS, STALL_SIGNALS } from '../../shared/attention-model.js';

import { externalWaitHit, externalWaitMatch, foldWhitespace, type VerifyEnv } from './verify-env.ts';

import type { StreamEvent } from './spawn.ts';
import { contextStage, type TokenCounters } from './usage.ts';
import { isStatusCapable, newPollLoop, observeCall, type PollLoopState } from '../../shared/poll-loop.js';

export type StallSignal = (typeof STALL_SIGNALS)[number];

/** The knobs, as `config.ts` spells them — one per `STALL_SIGNAL`, plus the local-job clock. */
export type StallThresholds = {
  /** No PRODUCTIVE output for this long — `silent`. See `lastProductiveAt`. */
  stallSilentMs: number;
  /** This many consecutive turns with no tool call — `spinning`. */
  stallSpinTurns: number;
  /** This many consecutive attempts that changed nothing — `stalemate`. */
  stallStalemateAttempts: number;
  /** This many API retries in a row with nothing productive between — `retrying`. */
  stallRetryBurst: number;
  /** An external-clock Bash call open this long — `external-wait`. */
  stallExternalWaitMs: number;
  /**
   * How long a wait on the session's OWN background job may stay open before
   * the park applies to it too — 45 minutes.
   *
   * Far longer than `stallExternalWaitMs` on purpose, and the whole reason the
   * two scopes are told apart: a session watching `gh run watch` is holding a
   * lock for somebody else's clock and the remedy is to let go of it, while a
   * session watching its own 40-minute suite IS the work. Parking the second
   * one on the first one's clock is what produced 26 checkpoint→park→resume
   * cycles at a median of 70 minutes each (register R26) — the console
   * interrupting a lane that was doing exactly what it was asked to do.
   */
  stallLocalJobMs: number;
  /** This many identical failing tool calls in a row — `looping`. */
  stallLoopRun: number;
};

/**
 * What `evaluateStall` needs from the world that is not a number.
 *
 * Exactly one thing, and it is passed in rather than imported so this file
 * keeps its defining property: it reads no clock, opens no file and spawns
 * nothing. `EXTERNAL_WAIT` lives in `scripts/verify.env` and reaches here
 * through `verify-env.ts`, whose job IS reading that file — doing the read
 * here would give this module a filesystem dependency for one regex and make
 * every test that drives it need a scripts directory on disk.
 */
export type StallContext = {
  /**
   * The shared external-clock vocabulary, loaded. Omitted — by a caller with
   * no scripts directory, or by a test not asking about it — means the
   * `external-wait` signal never fires, which is the right degradation: a
   * missing vocabulary must lose the detector, never invent one.
   *
   * The whole `VerifyEnv` rather than the one `RegExp` it used to be, because
   * matching is no longer a single `exec`: the text is folded first and the
   * carve-out (`EXTERNAL_WAIT_ALLOW`) is removed from it. Handing the regex
   * alone would let a caller match without the fold and get a different answer
   * from the one lint F16 gives about the same command — the exact drift
   * `verify.env` exists to prevent.
   */
  verifyEnv?: VerifyEnv;
};

/**
 * Whose clock a wait is on.
 *
 * `external` — somebody else's: a CI run, a deploy, a rollout. The session
 * cannot make it go faster, and while it watches it holds an exclusive lock.
 * Letting go is strictly better, which is what the park does.
 *
 * `local` — its own: a background suite, a build, a log it started. The session
 * is not idle, it is between two halves of one job, and taking the lane away
 * from it throws that job away. The remedy here is a nudge (do it in the
 * background and carry on), and the park only much later, once even a generous
 * local job has had its time.
 */
export type WaitScope = 'local' | 'external';

/**
 * Text that names something on THIS machine, produced by THIS session.
 *
 * Text alone, and deliberately no process probe. The plan sketched one — "a
 * child of the lane's pgid" — and it cannot work: while ANY Bash tool call is
 * open there is at least one process in the lane's group running it, so a
 * probe that asks "are there children" answers yes for `gh run watch` too and
 * would classify every wait as local, disabling the external park that
 * `external-wait` exists for. A shape that discriminates has to look at what
 * is being waited ON, and that is in the command.
 */
const LOCAL_JOB = new RegExp(
  '(^|[\\s\'"(&|;])(pgrep|pkill|jobs -p|wait \\$|wait %)'
  + '|/tmp/|/var/folders/|tasks/[^\\s]*\\.output|\\.claude/jobs/|\\$CLAUDE_JOB_DIR'
  + '|\\[ -[a-z] |test -[a-z] '
  + '|\\.log($|[^a-z])|\\.out($|[^a-z])'
  // A `--watch` flag, a `watch -n` loop and a `tail -f` are a session
  // supervising something IT started — a test runner re-running, a build
  // re-building, a log it is reading — and were the commonest refusal in the
  // corpus (`--watch` ×16 of 37). `REMOTE_WAIT` is asked first, so
  // `gh pr checks --watch` and `kubectl … --watch` stay somebody else's clock
  // (zero-touch-console phase 9, RCV-5).
  + '| --watch([^A-Za-z]|$)|(^|[\\s;&|])watch -n|(^|[\\s;&|])tail -[a-zA-Z]*f',
);

/**
 * Text that names somebody else's machine, and OUTRANKS `LOCAL_JOB`.
 *
 * Checked first because the two overlap in the shape that matters most:
 * `gh run watch … > /tmp/ci.log` names a local path and is still a wait on
 * GitHub's clock. Whose clock it is, is decided by the thing being waited on,
 * never by where the output happens to land.
 */
const REMOTE_WAIT = new RegExp(
  '(^|[\\s\'"(&|;])(gh|aws|kubectl|ssh|scp|rsync|vercel|terraform|flyctl|fly|gcloud|az|doctl|heroku)\\s'
  // The verb set is `MUTATION_DENY`'s, not a shorter guess. `task deploy` alone
  // missed `task hetzner:update` — this fleet's actual production deploy verb —
  // which, piped to a log in /tmp, then read as LOCAL and would have been given
  // 45 minutes of exclusive lock instead of the five-minute park.
  + '|task [a-z:]*(deploy|ship|update|apply|destroy|release)'
  + '|(npm|pnpm|yarn) run [a-z:_-]*(deploy|ship|release|publish|promote)'
  + '|make [a-z:_-]*(deploy|ship|release|publish|promote)'
  // And a script named for a verb of consequence, the same signal
  // `MUTATING_SCRIPT` reads: `bash scripts/ship.sh > /tmp/ship.log` is a deploy
  // however its output is redirected.
  + '|[a-z0-9_./-]*(deploy|ship|release|provision|rollout)[a-z0-9_.-]*\\.(sh|bash|py)'
  + '|https?://',
);

/**
 * A poll loop's own condition, as a `cmd:` watch ref — or null.
 *
 * A park has to say what it is waiting FOR, and for a local job the answer is
 * already written in the command: `until test -f /tmp/suite.done; do sleep 30;
 * done` is a session saying, in shell, "resume me when that file exists". So
 * the park lifts the condition out and hands it to the watch scheduler, which
 * runs it on a timer under the same read-only policy a §Verification command
 * gets — bounded at 60 s, capped at 12 runs per phase. The lane is released
 * and comes back the moment the job it was watching is genuinely done, instead
 * of at the end of a window somebody guessed.
 *
 * Only two shapes produce a ref, and the restraint is the point:
 *
 *   `until <cond>; do …`      → `cmd:"<cond>"`      — landing IS the condition
 *   `while ! <cond>; do …`    → `cmd:"<cond>"`      — same, once the `!` is lifted
 *
 * A bare `while <cond>` lands when the condition goes FALSE, and the only way
 * to say that is a leading `!`, which is not one of the verbs the runner's
 * read-only allowlist will execute. A ref that is certain to be refused is
 * worse than no ref: it spends a journal line and a rotation slot to tell the
 * operator nothing. `[ x ]` is rewritten to `test x` for the same reason —
 * `test` is on the allowlist and `[` is not, and they are the same program.
 *
 * And the condition's LEAD must be a probe (`WATCH_REF_PROBES`). This ref is
 * different in kind from every other one the scheduler runs: those were written
 * by a session declaring its own wait, and this one is MINTED BY THE CONSOLE
 * out of text it found. QA's cases: `until ./scripts/import.sh`,
 * `until python3 seed.py`, `until npm run db:wipe`,
 * `until bash ./drop-and-recreate.sh` — every one of them a command the verify
 * policy will happily run, on a timer, up to twelve times, because nothing in
 * that policy knows the difference between a command a person asked for and one
 * this function invented. The policy stays the second gate; this is the first.
 */
export function localWatchRef(summary: string): string | null {
  const hit = /(^|[\s;&|])(until|while)\s+(.+?)\s*;?\s*\bdo\b/.exec(foldWhitespace(summary));
  if (!hit) return null;
  let cond = hit[3].trim();
  if (hit[2] === 'while') {
    if (!cond.startsWith('!')) return null;
    cond = cond.slice(1).trim();
  }
  const bracket = /^\[\s+(.*?)\s+\]$/.exec(cond);
  if (bracket) cond = `test ${bracket[1]}`;
  if (!cond || cond.startsWith('!')) return null;
  const lead = cond.split(/\s+/)[0]?.replace(/^.*\//, '') ?? '';
  if (!WATCH_REF_PROBES.has(lead)) return null;
  return `cmd:"${cond.replace(/"/g, "'")}"`;
}

/**
 * The ref the console mints for a wait it refused or found open — the whole
 * family, where `localWatchRef` is the poll-loop arm (phase 9, RCV-5/TRS-3).
 * Every shape answers with what the session was actually waiting FOR:
 *
 *   `until <c>; do …` / `while ! <c>; do …`   → `cmd:"<c>"`     (`localWatchRef`)
 *   `<cmd> --watch …`                         → `cmd:"<cmd …>"` — the flag and any
 *                                               redirection stripped; the lead must be a
 *                                               probe or a `WATCH_ONESHOT_LEADS` runner
 *   `watch -n N <cmd>`                        → `cmd:"<cmd>"`   (same lead rule)
 *   `sleep N`                                 → `date:<now + N s>` — a clock, not a probe
 *   `gh run watch <id> [-R o/r]`              → `gh:o/r#run/<id>` when the repo is named
 *   `gh pr checks <n> --watch [-R o/r]`       → `gh:o/r#pr/<n>`  — else `cmd:"gh …"` one-shot
 *
 * Null for anything else (`tail -f`, `docker compose logs -f`, a bare `while
 * true`): a ref that cannot be honest is worse than none. `at` is the clock
 * a `sleep` is measured from — the caller's `now`, never `Date.now()`, so a
 * test's fake clock and the park agree.
 */
export function mintWatchRef(command: string, at: number = Date.now()): string | null {
  const loop = localWatchRef(command);
  if (loop) return loop;
  const text = foldWhitespace(command);
  // A `sleep` is the wait's whole duration only when it IS the statement — a
  // `while true; do sleep 30; done` sleeps thirty seconds for ever, and a
  // clock minted from its body would resume the lane into the same loop.
  const sleep = /\b(until|while)\b/.test(text) ? null : /(^|[\s;&|])sleep\s+(\d+)([smh])?(?=$|[\s;&|])/.exec(text);
  if (sleep) {
    const unit = sleep[3] === 'm' ? 60_000 : sleep[3] === 'h' ? 3_600_000 : 1_000;
    return `date:${new Date(at + Number(sleep[2]) * unit).toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
  }
  const repo = /(?:^|\s)(?:-R|--repo)[= ]([\w.-]+\/[\w.-]+)(?=$|\s)/.exec(text)?.[1] ?? null;
  const ghRun = /(^|[\s;&|])gh run watch\s+(\d+)/.exec(text);
  if (ghRun) return repo ? `gh:${repo}#run/${ghRun[2]}` : `cmd:"gh run view ${ghRun[2]} --exit-status${repo ? ` -R ${repo}` : ''}"`;
  const ghPr = /(^|[\s;&|])gh pr checks\s+(\d+)/.exec(text);
  if (ghPr && / --watch(?=$|[^A-Za-z])/.test(text)) {
    return repo ? `gh:${repo}#pr/${ghPr[2]}` : `cmd:"gh pr checks ${ghPr[2]}${repo ? ` -R ${repo}` : ''}"`;
  }
  // `watch -n N <cmd>` — the watched command is the probe.
  const watched = /(^|[\s;&|])watch\s+(?:-n\s*\d+(?:\.\d+)?\s+|--interval[= ]\d+\s+)?(?:-[a-z]+\s+)*(.+)$/.exec(text);
  if (watched && /(^|[\s;&|])watch\s/.test(text) && !/ --watch/.test(text)) {
    return oneShot(watched[2]);
  }
  // `<cmd> --watch` — the one-shot form of the same command.
  if (/ --watch(?=$|[^A-Za-z])/.test(text)) {
    return oneShot(text.replace(/ --watch(?:=[^\s]*)?(?=$|[^A-Za-z])/g, ''));
  }
  return null;
}

/** A command as a `cmd:` ref when its lead is one the console will mint for — redirections dropped. */
function oneShot(command: string): string | null {
  const bare = command
    .replace(/\s*\d*>>?\s*(?:&\d|[^\s;&|]+)/g, '')   // `> /tmp/x.log`, `2>&1`, `2> file`
    .replace(/\s*&\s*$/, '')
    .replace(/\s+--\s*$/, '')                           // `npm test -- --watch` → `npm test`
    .trim();
  if (!bare) return null;
  const lead = bare.split(/\s+/)[0]?.replace(/^.*\//, '') ?? '';
  if (!WATCH_REF_PROBES.has(lead) && !WATCH_ONESHOT_LEADS.has(lead)) return null;
  return `cmd:"${bare.replace(/"/g, "'")}"`;
}

/**
 * The only leads a console-minted `cmd:` ref may carry.
 *
 * Every one of them ASKS something and changes nothing, which is the property
 * that makes minting a ref out of found text defensible at all. Deliberately
 * short: a lead that is not obviously a probe belongs off the list, and the
 * cost of leaving one off is a park with no ref — today's behaviour for every
 * external wait — rather than a command run on a timer with nobody watching.
 */
export const WATCH_REF_PROBES = new Set([
  'test', 'grep', 'rg', 'ls', 'stat', 'cat', 'head', 'tail', 'wc',
  'jq', 'curl', 'docker', 'diff',
]);

/**
 * The leads a `--watch` / `watch -n` command may be minted from, beside the
 * probes above (phase 9, RCV-5): a test runner, a build, a type-checker —
 * commands whose ONE-SHOT form is its own landing probe (`vitest --watch`
 * re-runs the suite on every change; `vitest` runs it once and exits 0 when
 * it is green). The verify policy stays the second gate and
 * `watchMintedCmdRefs` (off by default) the third: a minted ref is held on
 * the record, never run, until an operator says minted refs may run.
 */
export const WATCH_ONESHOT_LEADS = new Set([
  'node', 'npm', 'pnpm', 'yarn', 'npx', 'bun', 'deno',
  'vitest', 'jest', 'mocha', 'tsc', 'cargo', 'go', 'pytest', 'bats', 'swift', 'xcodebuild',
]);

/*
 * Three leads were on this list and are not any more, for two different
 * reasons, and both reasons are the docstring above taken seriously.
 *
 * `find` ASKS and can also DELETE: `until find /tmp -name '*.tmp' -delete`
 * mints a ref the verify policy runs, because ` -delete` is not `delete-` and
 * `MUTATION_DENY` never sees it. A probe that can destroy is not a probe.
 *
 * `pgrep` and `nc`/`wget` are read-only and are not in the runner's `VERBS`,
 * so a ref built from one is REFUSED the first time the scheduler looks at it
 * — journalled, dropped, and worth nothing. That is exactly the "a ref certain
 * to be refused is worse than no ref" case this function already argues, and
 * it applied to two of its own entries.
 */

/**
 * Whose clock this open call is on.
 *
 * Known limit, stated rather than hidden: a wait on a path that LOOKS local but
 * is a shared mount — `until [ -f /mnt/shared/ci-done.flag ]` — reads local, and
 * costs 45 minutes of lock instead of 5. Nothing in the command distinguishes
 * it, and the alternative (dropping the path evidence entirely) would lose the
 * commonest real case this split exists for. `REMOTE_WAIT` is checked first
 * precisely so that a redirect target can never outvote a named remote verb.
 *
 * Defaults to `external`, which is what the detector did before the split
 * existed: an unfamiliar wait keeps today's behaviour, and only a command that
 * positively names something local earns the longer clock. The two errors are
 * not symmetric — calling a local job external parks a lane that was working
 * (the status quo, no regression), while calling an external wait local costs
 * one nudge and a delay before the same park.
 */
export function waitScope(summary: string): WaitScope {
  const folded = foldWhitespace(summary);
  if (REMOTE_WAIT.test(folded)) return 'external';
  return LOCAL_JOB.test(folded) ? 'local' : 'external';
}

/**
 * The fragment of the external-clock vocabulary a command about to RUN
 * matches, or null — the PreToolUse half of the same question
 * `externalWaitTool` asks about a call already open.
 *
 * Judged per STATEMENT, and a statement is a structure, not a spelling.
 * Three QA rounds in a row bypassed this guard, each through the gap between
 * what a scan over characters believed a statement was and what bash makes
 * of the same text; a fourth round found the model's own doors. So the
 * command is SPLIT the way bash splits it — `splitStatements` — and every
 * statement is judged on its own:
 *
 *  - a statement ending in a single `&` is backgrounded and never a wait —
 *    the one before it is in the foreground and still is — unless a later
 *    `wait` re-foregrounds the jobs this command started;
 *  - a compound (`until … done`, `if … fi`, `case … esac`) is one statement
 *    while the command is split, so a loop never becomes three non-waits; a
 *    GROUP (`( … )`, `{ … }`, a function body) is then looked INTO;
 *  - a `$(…)` or backtick substitution is judged on its own, before the
 *    statement holding it: a substitution that waits is a wait, whatever
 *    prints it;
 *  - data that reaches a shell is code. A statement whose lead RUNS what it is
 *    handed — `bash -c`, `eval`, `ssh`, `xargs`, `git submodule foreach`,
 *    `docker exec`, `find -exec` — or one piped into such a lead, is judged
 *    on its whole text with nothing masked and nothing exempt;
 *  - for every other statement, substitutions are masked to `$(…)` and quoted
 *    strings to `""` — a quoted string is data to the command that receives
 *    it, unless that command is one of the vocabulary's own (`sleep "90"`) or
 *    a compound — and the match is EXEMPT only if the statement's own lead
 *    carries the vocabulary as data (`leadIsExempt`) AND the statement is
 *    well-formed. An unterminated quote, substitution, group or compound can
 *    hide a separator, so it fails CLOSED: never exempt;
 *  - a here-doc body is data to the command that reads it and is not scanned
 *    — unless a shell reads it: the owner itself (`bash <<EOF`, `/bin/bash`,
 *    `sudo bash`), a shell started for it (`docker exec … bash <<EOF`,
 *    `kubectl exec … sh <<EOF`, `ssh host <<EOF`) or one it is piped into
 *    (`cat <<EOF | bash`). Decided at the END of the line, once the pipe
 *    target is known. On this repository a session can write a file only
 *    through a here-doc, and a test that MENTIONS a poll loop is not a wait.
 *
 * Bounded and total: nesting stops at `MAX_NESTING` (matched flat, never
 * exempt), and a command the splitter cannot read is DENIED rather than
 * thrown — a throw here reaches the CLI as a failed hook, and a failed hook
 * is fail-open.
 */
export function inTurnWait(command: string, env: VerifyEnv | undefined): string | null {
  if (!env || !command.trim()) return null;
  try {
    return waitInStatements(splitStatements(command), env, 0);
  } catch (error) {
    const name = error instanceof Error ? error.name : 'error';
    return `a command the guard could not read (${name})`;
  }
}

/**
 * How many levels of group / substitution / here-doc the guard takes apart
 * before it stops and judges the text as it stands. Deeper than any command a
 * session writes; a bound at all so a pathological input cannot recurse for
 * ever. At the bound the text is matched flat and is never exempt.
 */
const MAX_NESTING = 8;

function waitInStatements(
  statements: Statement[], env: VerifyEnv, depth: number, waitFollows = false,
): string | null {
  // A pipeline backgrounds as ONE: `A | B &` returns at once, whatever A is.
  const backgrounded: boolean[] = statements.map((statement) => statement.backgrounded);
  for (let i = statements.length - 2; i >= 0; i -= 1) {
    if (statements[i]?.pipedInto && backgrounded[i + 1]) backgrounded[i] = true;
  }
  // `wait` re-foregrounds the jobs started BEFORE it — never the ones after.
  const waitAfter: boolean[] = statements.map(() => waitFollows);
  let seenWait = waitFollows;
  for (let i = statements.length - 1; i >= 0; i -= 1) {
    waitAfter[i] = seenWait;
    if (basename(leadWords(statements[i]?.text ?? '')[0] ?? '') === 'wait') seenWait = true;
  }
  // A statement piped into an executor — directly, or through statements that
  // are not one — is code on its way to a shell.
  const feeds: boolean[] = statements.map(() => false);
  for (let i = statements.length - 2; i >= 0; i -= 1) {
    const here = statements[i];
    const next = statements[i + 1];
    if (!here?.pipedInto || !next) continue;
    feeds[i] = executes(next.text) || feeds[i + 1] === true;
  }
  for (let i = 0; i < statements.length; i += 1) {
    const statement = statements[i];
    if (!statement) continue;
    if (backgrounded[i] && !waitAfter[i]) continue;
    const matched = waitInStatement(statement, env, depth, feeds[i] === true, waitAfter[i] === true);
    if (matched) return matched;
  }
  return null;
}

function waitInStatement(
  statement: Statement, env: VerifyEnv, depth: number, fedToExecutor: boolean, waitFollows = false,
): string | null {
  if (depth >= MAX_NESTING) return externalWaitHit(env, statement.text)?.matched ?? null;
  // Code, wherever it comes from: a shell's argument, a shell's stdin, a
  // command that runs what it is handed. The whole text, nothing masked,
  // nothing exempt.
  if (fedToExecutor || executes(statement.text)) {
    return externalWaitHit(env, statement.text)?.matched ?? null;
  }
  if (statement.inner !== undefined) {
    // A brace group's jobs are the shell's own, so an outer `wait` reaches
    // into it; a subshell's — and a function's, run later if at all — are not.
    const follows = statement.innerKind === 'brace' ? waitFollows : false;
    const inside = waitInStatements(splitStatements(statement.inner, depth + 1), env, depth + 1, follows);
    if (inside) return inside;
    return statement.tail ? (externalWaitHit(env, statement.tail)?.matched ?? null) : null;
  }
  for (const substitution of statement.substitutions) {
    const inside = waitInStatements(splitStatements(substitution.body, depth + 1), env, depth + 1);
    if (inside) return inside;
  }
  const masked = maskData(statement);
  const hit = externalWaitHit(env, masked);
  if (!hit) return null;
  if (!statement.malformed && leadIsExempt(masked)) return null;
  return hit.matched;
}

/**
 * Leads whose quoted arguments are NOT data: `sleep "90"` waits exactly as
 * long as `sleep 90`, and `wait` takes job ids. Every other arm of the
 * vocabulary matches on a subcommand or a flag (`gh run watch`, `tail -f`,
 * `watch -n`), never on a quoted value — so `gh pr comment --body "sleep 90"`
 * is prose. The compounds keep their quotes too: a body is code however it
 * is quoted.
 */
const WAIT_LEAD = /^(sleep|wait)$/;
const COMPOUND_LEAD = /^(until|while|for|if|select|case)$/;

/**
 * The statement with every substitution replaced by `$(…)` and every quoted
 * string either UNWRAPPED — for a lead that runs quoted text, so `sleep "90"`
 * reads `sleep 90`, which is what bash hands it — or replaced by its empty
 * self, so the statement's own text is judged alone.
 */
function maskData(statement: Statement): string {
  const lead = basename(leadWords(statement.text)[0] ?? '');
  const unwrap = WAIT_LEAD.test(lead) || COMPOUND_LEAD.test(lead);
  const spans = [
    ...statement.substitutions.map((s) => ({ start: s.start, end: s.end, mask: '$(…)' })),
    ...statement.quotes.map((q) => {
      const open = statement.text[q.start] === '$' ? 2 : 1;
      const close = statement.text[q.end - 1] ?? '"';
      return {
        start: q.start,
        end: q.end,
        mask: unwrap ? statement.text.slice(q.start + open, q.end - 1) : `${close}…${close}`,
      };
    }),
  ].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    out += statement.text.slice(cursor, span.start) + span.mask;
    cursor = span.end;
  }
  return out + statement.text.slice(cursor);
}

/** The last path segment of a word: `/bin/bash` is `bash`, `.` is `.`. */
function basename(word: string): string {
  return word.replace(/^.*\//, '');
}

/**
 * A word that names a file or a program rather than a command: nothing in it a
 * shell would re-read. The judge for "is this pager/editor/env value a command
 * the lead will run" — `core.pager=cat` names a program; `core.pager=sleep
 * 600` (ONE word once quotes are resolved) is a command.
 */
const PLAIN_WORD = /^[\w./:@-]*$/;

/**
 * Split a statement into shell WORDS: quotes resolved (content kept, marks
 * dropped — `X='a b'` is ONE word), `$(…)` and backticks carried whole,
 * escapes applied, a line continuation read as whitespace. The splitter the
 * LEAD analysis reads: round 5 proved a raw whitespace split breaks on the
 * first assignment with a quoted space, and every unlisted spelling of a
 * shell then fell to the masked path where its payload is data.
 */
function shellWords(text: string): string[] {
  const src = text.replace(/\\\r?\n/g, ' ');
  const out: string[] = [];
  let current = '';
  let started = false;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i] ?? '';
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      current += src.slice(i + 1, end < 0 ? n : end);
      started = true;
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\') { current += src[i + 1] ?? ''; i += 2; continue; }
        current += src[i];
        i += 1;
      }
      i += 1;
      started = true;
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      current += src.slice(i, end < 0 ? n : end + 1);
      started = true;
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      let depth = 0;
      let j = i + 1;
      while (j < n) {
        const d = src[j] ?? '';
        if (d === '(') depth += 1;
        else if (d === ')') { depth -= 1; if (depth === 0) { j += 1; break; } }
        j += 1;
      }
      current += src.slice(i, j);
      started = true;
      i = j;
      continue;
    }
    if (c === '\\') { current += src[i + 1] ?? ''; started = true; i += 2; continue; }
    if (/\s/.test(c)) {
      if (started || current) { out.push(current); current = ''; started = false; }
      i += 1;
      continue;
    }
    current += c;
    started = true;
    i += 1;
  }
  if (started || current) out.push(current);
  return out;
}

/**
 * Leads that RUN what they are handed — as an argument (`bash -c`, `eval`),
 * as their input (`bash` at the end of a pipe), on another machine (`ssh`),
 * per line or per file (`xargs`, `find -exec`), or in a container (`docker
 * exec`). A shell executes its ARGUMENTS only with `-c` (or reading stdin);
 * `bash scripts/x.sh --subject "…"` runs the SCRIPT, and its arguments are
 * the script's business. `git` only for the verbs that execute their argument
 * and for a pager, editor or hook whose value is not a plain program name.
 * A lead the guard cannot resolve — `$SHELL`, `$(which bash)` — fails CLOSED.
 */
const SHELL_LEAD = /^(bash|sh|zsh|dash|ksh|fish|source|\.)$/;
const RUNS_ITS_ARGUMENT = /^(ssh|xargs|parallel|flock|setsid|expect|su|chroot|nsenter|unshare|systemd-run|watch)$/;
const CONTAINER_LEAD = /^(docker|podman|nerdctl|docker-compose|kubectl|oc)$/;
const GIT_EXECUTES = /^(submodule|rebase|bisect|filter-branch|difftool|mergetool)$/;
/** A pager/editor/ssh/hook option — a command when its value is not a plain word. */
const GIT_EXECUTING_OPTION = /^core\.(pager|editor|sshCommand|hooksPath|fsmonitor)=/;
/**
 * Env names whose value the command will RUN. A plain program name or path is
 * fine (`GIT_PAGER=cat`, `GIT_ASKPASS=/usr/bin/askpass`); a value with a
 * space, a quote or a substitution is a command (`PAGER='sleep 600'`).
 */
const COMMAND_VALUED_ENV =
  /^(GIT_PAGER|PAGER|MANPAGER|EDITOR|VISUAL|GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_SSH|GIT_SSH_COMMAND|GIT_EXTERNAL_DIFF|SHELL|BROWSER|SUDO_EDITOR|FCEDIT|LESSOPEN|SYSTEMD_EDITOR|GIT_ASKPASS|SSH_ASKPASS|GIT_PROXY_COMMAND|PROMPT_COMMAND)$/;

/** Only `-c` makes a shell's arguments code; bare (or `-`/stdin) reads its input. */
function shellRunsItsArgument(words: string[]): boolean {
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i] ?? '';
    if (word === '-c') return true;
    if (word === '-' || word === '/dev/stdin' || word === '/dev/fd/0') return true;
    if (word.startsWith('-')) continue;
    return false; // the first operand is a script from disk — its text is not here
  }
  return true; // bare, or flags only: stdin is the program
}

function executes(text: string): boolean {
  const raw = shellWords(text.trim().replace(/^[({!\s]+/, ''));
  for (const word of raw) {
    const assign = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(word);
    if (!assign) break;
    if (COMMAND_VALUED_ENV.test(assign[1] ?? '') && !PLAIN_WORD.test(assign[2] ?? '')) return true;
  }
  const words = leadWords(text);
  const first = words[0] ?? '';
  if (!first) return false;
  if (first.startsWith('$') || first.includes('`')) return true;
  const lead = basename(first);
  if (lead === 'eval') return true;
  if (SHELL_LEAD.test(lead)) return shellRunsItsArgument(words);
  if (RUNS_ITS_ARGUMENT.test(lead)) return true;
  if (lead === 'git') {
    const { sub, options } = gitParts(words);
    if (GIT_EXECUTES.test(sub)) return true;
    return options.some((option) =>
      GIT_EXECUTING_OPTION.test(option) && !PLAIN_WORD.test(option.slice(option.indexOf('=') + 1)));
  }
  if (CONTAINER_LEAD.test(lead)) return words.slice(1).some((word) => word === 'exec' || word === 'run');
  if (lead === 'find') return words.some((word) => /^-(exec|execdir|ok|okdir)$/.test(word));
  return false;
}

/** `git [-C dir] [-c k=v] <sub> …`: the subcommand, and the option values before it. */
function gitParts(words: string[]): { sub: string; options: string[] } {
  const options: string[] = [];
  let i = 1;
  while (i < words.length && (words[i] ?? '').startsWith('-')) {
    const flag = words[i] ?? '';
    if (flag === '-C' || flag === '-c') {
      options.push(words[i + 1] ?? '');
      i += 2;
    } else {
      options.push(flag);
      i += 1;
    }
  }
  return { sub: words[i] ?? '', options };
}

/**
 * Leads that carry the vocabulary as DATA rather than running it.
 *
 * A search matches its own pattern; an `echo` prints it. Neither waits. `git`
 * only for the verbs that search or print — `git submodule foreach` and
 * `git rebase --exec` run whatever they are handed, and were exempt while the
 * lead was the whole word. Patterns, not argument lists: nothing here RUNS
 * `git grep`, and a string array starting with a git verb reads to
 * `never-push.test.ts` as an argv.
 */
const GUARD_EXEMPT_LEADS = /^(grep|rg|ag|ack|echo|printf)$/;
const GUARD_EXEMPT_GIT = /^(grep|log|show|diff|blame|status)$/;

/**
 * Words that stand in front of a lead without being it: `approvals.ts`'s
 * wrapper list, plus the two a rule never sees through and this guard must —
 * `env` and `sudo` — because an exemption read off `env` instead of the
 * `grep` behind it was measured as a false positive. The value lists say
 * which of a wrapper's flags take an argument, so `sudo -u app grep …` is
 * read as `grep` and `time -p grep …` is too.
 */
const LEAD_WRAPPERS: Record<string, Set<string>> = {
  env: new Set(['-u', '-C', '-S']),
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U']),
  timeout: new Set(['-s', '-k']),
  time: new Set(),
  nice: new Set(['-n']),
  nohup: new Set(),
  stdbuf: new Set(['-i', '-o', '-e']),
  command: new Set(),
  builtin: new Set(),
  noglob: new Set(),
  xargs: new Set(['-I', '-n', '-P', '-L', '-d', '-a', '-E', '-s']),
  exec: new Set(),
};

/** Leads that run their first operand: step over them to it. */
const RUNNER_LEADS = /^(uv|uvx|npx|bunx|pipx|poetry|pdm|hatch)$/;
const RUNNER_SUBCOMMANDS = new Set(['run', 'exec', 'dlx', 'x', 'tool']);

/**
 * The words of a statement from its real lead on: assignments, wrappers and
 * runners stepped over, quotes resolved, a line continuation read as the
 * whitespace it is.
 */
function leadWords(text: string): string[] {
  const words = shellWords(text.trim().replace(/^[({!\s]+/, ''));
  let i = 0;
  while (i < words.length) {
    const word = words[i] ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { i += 1; continue; }
    const name = basename(word);
    if (RUNNER_LEADS.test(name)) {
      i += 1;
      if (RUNNER_SUBCOMMANDS.has(words[i] ?? '')) i += 1;
      while (i < words.length && (words[i] ?? '').startsWith('-')) i += 1;
      continue;
    }
    const valued = LEAD_WRAPPERS[name];
    if (!valued) break;
    i += 1;
    // The wrapper's own arguments: flags, a flag's value, `timeout 30s`.
    while (i < words.length) {
      const arg = words[i] ?? '';
      if (/^\d+[smhd]?$/.test(arg)) { i += 1; continue; }
      if (!arg.startsWith('-')) break;
      i += valued.has(arg) ? 2 : 1;
    }
  }
  return words.slice(i);
}

function leadIsExempt(text: string): boolean {
  const words = leadWords(text);
  const lead = basename(words[0] ?? '');
  if (!lead) return false;
  if (lead !== 'git') return GUARD_EXEMPT_LEADS.test(lead);
  return GUARD_EXEMPT_GIT.test(gitParts(words).sub);
}

/** One statement of a shell command, as the guard judges it. */
export type Statement = {
  /** The statement's own text, trimmed. A compound or a group is ONE statement. */
  text: string;
  /** Ended by a single `&` — bash returns at once, so it is never a wait. */
  backgrounded: boolean;
  /** Ended by `|` or `|&`: its output is the next statement's input. */
  pipedInto: boolean;
  /**
   * An unterminated quote, substitution, group or compound reached the end of
   * the command inside this statement. It can be hiding a separator, so it is
   * never exempt: the guard fails closed on it.
   */
  malformed: boolean;
  /** For `( … )`, `{ … }` and a function body: what the brackets hold, to be split again. */
  inner?: string;
  /** Which brackets: a subshell's jobs are its own; a brace group's are the shell's. */
  innerKind?: 'paren' | 'brace' | 'function';
  /** For a group: what follows its closing bracket (redirections), judged as text. */
  tail?: string;
  /** `$(…)` / backtick bodies at this statement's own level, and where they sit in `text`. */
  substitutions: { start: number; end: number; body: string }[];
  /** Quoted strings at this statement's own level — data, to most commands. */
  quotes: { start: number; end: number }[];
};

/** What the scanner is inside of. Only the last entry decides what a character means. */
type Context = 'sq' | 'dq' | 'ansi' | 'backtick' | 'subst' | 'param' | 'paren' | 'brace' | 'case' | 'arith';

/** Words that open a compound at a statement's lead, and the ones that close it. */
const COMPOUND_OPEN = new Set(['until', 'while', 'for', 'select', 'if']);
const COMPOUND_CLOSE = new Set(['done', 'fi']);
/** Words that may stand before a statement's lead without being it. */
const LEAD_PREFIX = new Set(['do', 'then', 'else', '!', 'time', '-p']);
/** `f() {` / `function f {` — the brace that follows is a body, not a word. */
const FUNCTION_HEAD = /^\s*(function\s+)?[\w.:-]+\s*(\(\s*\))?\s*$/;
/** Bash allows several here-docs on one line; more than this is not a command. */
const MAX_HEREDOCS_PER_LINE = 8;
/**
 * A shell on the line that announces a here-doc — the owner (`bash <<EOF`,
 * `/bin/bash`), a shell a wrapper starts (`sudo bash`, `docker exec … sh`),
 * or the far end of a pipe (`cat <<EOF | bash`) — means the body is CODE.
 */
const LINE_SHELL_WORD =
  /(?:^|[\s|;&(])(?:[^\s|;&()]*\/)?(?:bash|sh|zsh|dash|ksh|fish|eval|source|ssh|\.)(?=$|[\s|;&)])/;

/**
 * Split a command into the statements bash would run, in order.
 *
 * Not a shell parser — it builds no AST and evaluates nothing — but it does
 * know every construct that decides where one statement ends and the next
 * begins: single, double and `$'…'` quotes with their escapes; backslash
 * escapes and line continuations; `$(…)`, backtick, `${…}` and `$((…))`
 * bodies; `( … )`, `{ … }` and function-body groups; `until|while|for|if …
 * done|fi` and `case … esac` compounds; comments; and here-docs. Separators
 * are `;`, a newline, `&&`, `||`, `|`, `|&` and a single `&` (never the `&`
 * of `2>&1` or `&>`), and only at the top level: inside a group, a
 * substitution or a compound they start a new statement THERE without ending
 * this one.
 *
 * Bounded and total: every character is visited once, here-doc bodies nest
 * at most `MAX_NESTING` deep, and text that never closes what it opened comes
 * back as one `malformed` statement rather than an exception or a silent
 * exemption.
 */
export function splitStatements(text: string, depth = 0): Statement[] {
  const out: Statement[] = [];
  const stack: Context[] = [];
  const top = (): Context | undefined => stack[stack.length - 1];
  const n = text.length;
  let i = 0;
  /** Where the statement being read began. */
  let start = 0;
  /** True until the statement's first word has been seen. */
  let atStart = true;
  /** Top-level compound depth: while > 0 a separator does not end the statement. */
  let compound = 0;
  /** The bracket a group statement opened with, once it is known to be one. */
  let group: { open: number; close: number } | null = null;
  /** Outermost substitution spans of the statement being read, absolute. */
  const spans: { start: number; end: number }[] = [];
  /** Outermost quoted strings of the statement being read, absolute. */
  const quotes: { start: number; end: number }[] = [];
  /** Comment and here-doc-body spans — blanked out of the statement's text. */
  const blanks: { start: number; end: number }[] = [];
  /** Open substitutions: the start index of an outermost one, -1 for a nested one. */
  const openSubs: number[] = [];
  /** The start of the outermost quote being read, or -1. */
  let openQuote = -1;
  /** Parentheses open inside `$((…))` / `((…))`. */
  let arithDepth = 0;
  /** Here-docs announced on the current line, consumed at its end. */
  let heredocs: { terminator: string; strip: boolean }[] = [];
  /** Here-doc bodies a shell will read, split after the command itself. */
  const codeBodies: string[] = [];

  const isWs = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\r';
  const nested = (): boolean => stack.some((c) => c !== 'dq' && c !== 'param' && c !== 'arith');
  // The first word inside a substitution starts a statement THERE — which is
  // how `$(case y in a) …)` keeps its pattern's `)` from closing the `$(`.
  const openSub = (at: number): void => { openSubs.push(nested() ? -1 : at); atStart = true; };
  const closeSub = (at: number): void => {
    const from = openSubs.pop();
    if (from !== undefined && from >= 0) spans.push({ start: from, end: at + 1 });
  };
  const openQuoted = (at: number): void => { if (openQuote < 0 && !nested()) openQuote = at; };
  const closeQuoted = (at: number): void => {
    if (openQuote >= 0) { quotes.push({ start: openQuote, end: at + 1 }); openQuote = -1; }
  };
  const wordAt = (from: number): string => {
    let j = from;
    while (j < n) {
      const c = text[j] ?? '';
      if (isWs(c) || c === '\n' || ';&|()<>'.includes(c)) break;
      j += 1;
    }
    return text.slice(from, j);
  };

  const emit = (end: number, backgrounded: boolean, piped: boolean, malformed = false): void => {
    let from = start;
    let to = end;
    while (from < to && (isWs(text[from]) || text[from] === '\n')) from += 1;
    while (to > from && (isWs(text[to - 1]) || text[to - 1] === '\n')) to -= 1;
    // A comment or a here-doc body is not part of the statement. Blanked
    // rather than cut, so every offset recorded against the original text
    // still holds.
    let body = text.slice(from, to);
    for (const blank of blanks) {
      if (blank.end <= from || blank.start >= to) continue;
      const a = Math.max(blank.start, from) - from;
      const b = Math.min(blank.end, to) - from;
      body = body.slice(0, a) + ' '.repeat(b - a) + body.slice(b);
    }
    const lead = body.length - body.trimStart().length;
    if (body.trim()) {
      const statement: Statement = {
        text: body.trim(), backgrounded, pipedInto: piped, malformed, substitutions: [], quotes: [],
      };
      if (group && group.close > group.open && group.close < to
        && (group.open === from || FUNCTION_HEAD.test(text.slice(from, group.open)))) {
        statement.inner = text.slice(group.open + 1, group.close);
        statement.innerKind = text[group.open] === '(' ? 'paren'
          : group.open > from ? 'function' : 'brace';
        const tail = text.slice(group.close + 1, to).trim();
        if (tail) statement.tail = tail;
      }
      for (const span of spans) {
        if (span.start < from || span.end > to) continue;
        const bodyFrom = span.start + (text[span.start] === '$' ? 2 : 1);
        statement.substitutions.push({
          start: span.start - from - lead,
          end: span.end - from - lead,
          body: text.slice(bodyFrom, span.end - 1),
        });
      }
      for (const quote of quotes) {
        if (quote.start < from || quote.end > to) continue;
        statement.quotes.push({ start: quote.start - from - lead, end: quote.end - from - lead });
      }
      out.push(statement);
    }
    spans.length = 0;
    quotes.length = 0;
    blanks.length = 0;
    start = end;
    atStart = true;
    group = null;
  };

  /**
   * A separator at `i`, `width` characters wide. At the top level it ends the
   * statement (a single `&` ends it backgrounded, a pipe ends it piped);
   * inside a group, a substitution or a compound it only starts the next
   * statement THERE.
   */
  const separator = (width: number, backgrounded: boolean, piped: boolean): void => {
    if (stack.length === 0 && compound === 0) {
      emit(i, backgrounded, piped);
      i += width;
      start = i;
    } else {
      atStart = true;
      i += width;
    }
  };

  const consumeHeredocs = (newline: number): void => {
    if (!heredocs.length) return;
    const pending = heredocs;
    heredocs = [];
    // Whether a shell reads the body is decided by the whole line, now that
    // the line is known: the owner, a wrapper's shell, or a pipe's far end.
    const line = text.slice(text.lastIndexOf('\n', newline - 1) + 1, newline);
    const code = LINE_SHELL_WORD.test(line);
    const nothingYet = text.slice(start, i).trim() === '';
    const bodyStart = i;
    for (const doc of pending) {
      const lines: string[] = [];
      while (i < n) {
        let eol = text.indexOf('\n', i);
        if (eol < 0) eol = n;
        const lineText = text.slice(i, eol).replace(/\r$/, '');
        i = Math.min(n, eol + 1);
        if ((doc.strip ? lineText.replace(/^\t+/, '') : lineText) === doc.terminator) break;
        lines.push(lineText);
      }
      if (code && lines.length) codeBodies.push(lines.join('\n'));
    }
    blanks.push({ start: bodyStart, end: i });
    if (nothingYet) start = i;
  };

  while (i < n) {
    const c = text[i] ?? '';
    const t = top();

    if (t === 'sq') {
      if (c === "'") { closeQuoted(i); stack.pop(); }
      i += 1;
      continue;
    }
    if (t === 'ansi') {
      if (c === '\\') { i += 2; continue; }
      if (c === "'") { closeQuoted(i); stack.pop(); }
      i += 1;
      continue;
    }
    if (t === 'dq') {
      if (c === '\\') { i += 2; continue; }
      if (c === '"') { closeQuoted(i); stack.pop(); i += 1; continue; }
      if (c === '$' && text[i + 1] === '(' && text[i + 2] === '(') { stack.push('arith'); arithDepth = 0; i += 3; continue; }
      if (c === '$' && text[i + 1] === '(') { openSub(i); stack.push('subst'); i += 2; continue; }
      if (c === '$' && text[i + 1] === '{') { stack.push('param'); i += 2; continue; }
      if (c === '`') { openSub(i); stack.push('backtick'); i += 1; continue; }
      i += 1;
      continue;
    }
    if (t === 'backtick') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { closeSub(i); stack.pop(); i += 1; continue; }
      if (c === "'") { stack.push('sq'); i += 1; continue; }
      if (c === '"') { stack.push('dq'); i += 1; continue; }
      if (c === '$' && text[i + 1] === '(') { openSub(i); stack.push('subst'); i += 2; continue; }
      i += 1;
      continue;
    }
    if (t === 'param') {
      if (c === '\\') { i += 2; continue; }
      if (c === '}') { stack.pop(); i += 1; continue; }
      if (c === "'") { stack.push('sq'); i += 1; continue; }
      if (c === '"') { stack.push('dq'); i += 1; continue; }
      if (c === '$' && text[i + 1] === '(' && text[i + 2] === '(') { stack.push('arith'); arithDepth = 0; i += 3; continue; }
      if (c === '$' && text[i + 1] === '(') { openSub(i); stack.push('subst'); i += 2; continue; }
      if (c === '$' && text[i + 1] === '{') { stack.push('param'); i += 2; continue; }
      if (c === '`') { openSub(i); stack.push('backtick'); i += 1; continue; }
      i += 1;
      continue;
    }
    if (t === 'arith') {
      // Arithmetic: `<<` is a shift, `)` closes only in pairs.
      if (c === '\\') { i += 2; continue; }
      if (c === '(') { arithDepth += 1; i += 1; continue; }
      if (c === ')') {
        if (arithDepth > 0) { arithDepth -= 1; i += 1; continue; }
        stack.pop();
        i += text[i + 1] === ')' ? 2 : 1;
        continue;
      }
      if (c === '$' && text[i + 1] === '(') { openSub(i); stack.push('subst'); i += 2; continue; }
      if (c === "'") { stack.push('sq'); i += 1; continue; }
      if (c === '"') { stack.push('dq'); i += 1; continue; }
      i += 1;
      continue;
    }

    // Code: the top level, a `$(…)`, a `( … )`, a `{ … }` or a `case … esac`.
    // A line continuation is the whitespace it stands for — never a word.
    if (c === '\\' && (text[i + 1] === '\n' || (text[i + 1] === '\r' && text[i + 2] === '\n'))) {
      i += text[i + 1] === '\r' ? 3 : 2;
      continue;
    }
    const wasStart = atStart && !isWs(c) && c !== '\n';
    if (wasStart) {
      atStart = false;
      // The statement's lead decides whether a compound opens or closes here.
      let j = i;
      let word = wordAt(j);
      while (word && LEAD_PREFIX.has(word)) {
        j += word.length;
        while (j < n && isWs(text[j])) j += 1;
        word = wordAt(j);
      }
      if (t === 'case' && word === 'esac') stack.pop();
      else if (word === 'case') stack.push('case');
      else if (stack.length === 0) {
        if (COMPOUND_OPEN.has(word)) compound += 1;
        else if (COMPOUND_CLOSE.has(word)) compound = Math.max(0, compound - 1);
      }
    }

    if (c === '\\') { i += 2; continue; }
    if (c === "'") { openQuoted(i); stack.push('sq'); i += 1; continue; }
    if (c === '"') { openQuoted(i); stack.push('dq'); i += 1; continue; }
    if (c === '$' && text[i + 1] === "'") { openQuoted(i); stack.push('ansi'); i += 2; continue; }
    if (c === '$' && text[i + 1] === '"') { openQuoted(i); stack.push('dq'); i += 2; continue; }
    if (c === '$' && text[i + 1] === '(' && text[i + 2] === '(') { stack.push('arith'); arithDepth = 0; i += 3; continue; }
    if (c === '$' && text[i + 1] === '(') { openSub(i); stack.push('subst'); i += 2; continue; }
    if (c === '$' && text[i + 1] === '{') { stack.push('param'); i += 2; continue; }
    if (c === '`') { openSub(i); stack.push('backtick'); i += 1; continue; }
    if (c === '#' && (i === 0 || isWs(text[i - 1]) || text[i - 1] === '\n' || ';&|('.includes(text[i - 1] ?? 'x'))) {
      // A comment runs to the end of its line; the newline itself is a separator.
      const from = i;
      while (i < n && text[i] !== '\n') i += 1;
      blanks.push({ start: from, end: i });
      continue;
    }
    if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<'
      && (i === 0 || isWs(text[i - 1]) || text[i - 1] === '\n' || ';&|('.includes(text[i - 1] ?? 'x'))) {
      const doc = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z_][A-Za-z0-9_.-]*))/.exec(text.slice(i, i + 200));
      if (doc) {
        if (heredocs.length < MAX_HEREDOCS_PER_LINE) {
          heredocs.push({ terminator: doc[2] ?? doc[3] ?? doc[4] ?? '', strip: doc[1] === '-' });
        }
        i += doc[0].length;
        continue;
      }
    }
    if (c === '(' && text[i + 1] === '(') {
      stack.push('arith');
      arithDepth = 0;
      i += 2;
      continue;
    }
    if (c === '(') {
      if (wasStart && stack.length === 0 && compound === 0) group = { open: i, close: -1 };
      stack.push('paren');
      atStart = true;
      i += 1;
      continue;
    }
    if (c === ')') {
      if (t === 'paren') {
        stack.pop();
        if (group && group.close < 0 && stack.length === 0) group.close = i;
      } else if (t === 'subst') {
        closeSub(i);
        stack.pop();
      }
      // A `)` that closes nothing — a `case` pattern's — is nothing.
      i += 1;
      continue;
    }
    if (c === '{' && (i + 1 >= n || isWs(text[i + 1]) || text[i + 1] === '\n')) {
      if (stack.length === 0 && compound === 0
        && (wasStart || FUNCTION_HEAD.test(text.slice(start, i)))) {
        group = { open: i, close: -1 };
      }
      stack.push('brace');
      atStart = true;
      i += 1;
      continue;
    }
    if (c === '}' && t === 'brace'
      && (i === 0 || isWs(text[i - 1]) || text[i - 1] === '\n' || text[i - 1] === ';')
      && (i + 1 >= n || isWs(text[i + 1]) || text[i + 1] === '\n' || ';&|)'.includes(text[i + 1] ?? 'x'))) {
      stack.pop();
      if (group && group.close < 0 && stack.length === 0) group.close = i;
      i += 1;
      continue;
    }

    // Separators — see `separator` for what one does at each level.
    if (c === '\n') {
      const newline = i;
      separator(1, false, false);
      consumeHeredocs(newline);
      continue;
    }
    if (c === ';') { separator(1, false, false); continue; }
    if (c === '&' && text[i + 1] === '&') { separator(2, false, false); continue; }
    if (c === '|') { separator(text[i + 1] === '|' ? 2 : text[i + 1] === '&' ? 2 : 1, false, text[i + 1] !== '|'); continue; }
    if (c === '&' && text[i + 1] !== '>' && text[i - 1] !== '>' && text[i - 1] !== '<') {
      separator(1, true, false);
      continue;
    }

    i += 1;
  }
  emit(n, false, false, stack.length > 0 || compound > 0);
  for (const body of codeBodies) {
    if (depth < MAX_NESTING) out.push(...splitStatements(body, depth + 1));
    else out.push({ text: body, backgrounded: false, pipedInto: false, malformed: true, substitutions: [], quotes: [] });
  }
  return out;
}

/** One stall episode: what it is, when it started, and the sentence a person reads. */
export type StallState = {
  signal: StallSignal;
  /** ISO — when the condition BECAME true, not when it was noticed. */
  since: string;
  /** One line of evidence: the clock that ran out and, for `silent`, the open call. */
  detail: string;
  /**
   * `external-wait` only: whose clock. Absent on every other signal, and absent
   * on an `external-wait` written by a build before the split — which reads as
   * `external`, the behaviour those checkpoints were written under.
   */
  scope?: WaitScope;
  /**
   * `external-wait` only: what the evidence is. `open` — a Bash call matching
   * the vocabulary is still out. `denied` — the console's own in-turn-wait
   * guard refused one, so no call ever opened, and the lane is reached through
   * `LaneSignals.waitDenied` instead (RCV-5). Absent reads as `open`.
   */
  source?: 'open' | 'denied';
};

/**
 * What a `loop` suspicion is evidence OF — which call, how many, what came back.
 *
 * The three suspicion shapes live here rather than in `runner/suspect.ts`,
 * which is where the detectors live, for the rule this tree already follows
 * with `RunnerDeps`: the TYPE is free and only the implementation is Pro. A
 * `PhaseRecord` carries one of these and `state.ts` is free, so a shape the
 * free tree could not name would take the whole record type with it.
 */
export type LoopEvidence = {
  tool: string;
  /** The call's own one-line summary — for a `Bash` call, the command. */
  summary: string;
  /** `callHash` of the words that came back. */
  hash: string;
  count: number;
  /** The calls' own ids, oldest first. */
  ids: string[];
};

/** A phase the console suspects of going round in circles. Never acted on. */
export type PhaseSuspect = {
  kind: 'loop';
  /** ISO — when the first call of the run went out. */
  since: string;
  detail: string;
  evidence: LoopEvidence;
};

/** A session the console suspects has stopped, without being able to prove it. */
export type SessionSuspect = {
  kind: 'stuck';
  sessionId: string;
  /** ISO — the last thing it wrote. */
  since: string;
  detail: string;
};

/**
 * A tool call that went out and has not come back.
 *
 * `summary` is the call's own one-line summary as `spawn.ts` built it — for a
 * `Bash` call, the command itself, whitespace-collapsed and capped at 240
 * characters. It is here because the strongest available evidence about a lane
 * that has gone quiet is WHAT it is quiet inside: `gh run watch` and a 2000-line
 * `Read` are the same silence and completely different problems.
 */
export type OpenTool = { id: string; name: string; since: string; summary?: string };

/**
 * What a lane looks like from outside, on the run payload.
 *
 * `commitsSinceStart` and `treeDirty` are the only two fields that cost a
 * subprocess, so they are refreshed on a slower cadence than the rest and are
 * allowed to be a few minutes stale — they answer "has THIS ATTEMPT produced
 * anything at all", which does not change per turn.
 *
 * The attempt, not the phase, and the name is the older of the two: the window
 * is `record.attemptStartedAt`, because the silent watchdog reads this to
 * decide whether a session has anything to lose, and a phase-wide count is
 * permanently non-zero for every attempt after the one that committed.
 */
export type LaneLiveness = {
  phase: number;
  /**
   * ISO — the last stream event of any kind, retries included. "When did we
   * last hear from it", which is NOT the clock `silent` runs on: see
   * `LaneSignals.lastProductiveAt`. A stall episode carries its own `since`,
   * so nothing on the wire has to re-derive the productive clock from this.
   */
  lastOutputAt: string;
  /** ISO — the last tool call that went out. Absent until one has. */
  lastToolUseAt?: string;
  turnsSinceLastTool: number;
  commitsSinceStart: number;
  treeDirty: boolean;
  /** The call that has been open longest, when one is. */
  openTool?: OpenTool;
  /** The episode in progress, when the lane is in one. */
  stall?: StallState;
  /**
   * API retries since the last productive event, and when the burst started.
   *
   * On the wire because 450 `phase.api-retry` events were journalled and
   * NOTHING read them: a lane retrying every ~16 minutes looks, on every
   * surface an operator has, exactly like a lane that is quietly thinking.
   * One run died to a quota climb without a single stall ever being raised.
   * Absent while the count is zero — the overwhelmingly common case, and a
   * `retries: 0` on every lane row is noise.
   *
   * The same counter `retrying` is judged on (`stallRetryBurst`), so the chip
   * and the stall agree by construction rather than by two derivations.
   */
  retries?: { count: number; since: string };
  /**
   * What this attempt's session has cost in context so far (autopilot-token-drain
   * phase 3). Absent until its first API call.
   */
  tokens?: LaneTokens;
  /**
   * What the session in flight on this lane has cost so far, in dollars — the
   * CLI's own running `total_cost_usd` from its latest `result`, so it moves
   * once per turn rather than per call (autopilot-token-drain phase 6, H7).
   * NOT yet in `RunState.spentUsd`, which books a session only when it ends:
   * the two sum to what the run has really spent, and a run view showing only
   * the booked half once read $266.34 while $111.87 was live. Absent until the
   * session's first `result`. Filled by `RunnerBase.liveness()` from
   * `Lane.spentUsd`, not by `livenessOf`, which reads only the signals.
   */
  spentUsd?: number;
};

/**
 * A live lane's context and caching, as the run payload carries it.
 *
 * `context` is the newest call's — what every further call re-reads — and
 * `peak` the largest; the four token fields are this attempt's sums. `rebuilds`
 * counts calls that wrote the cache again rather than reading it
 * (`runner/usage.ts`), and `pollCalls` the status checks the poll-loop guard
 * counted (phase 2). `window` is the context window the thresholds were judged
 * against, when the model is known, and `stage` the line `context` has passed
 * — absent under the wrap-up line, so no surface has to know the fractions.
 */
export type LaneTokens = {
  context: number;
  peak: number;
  calls: number;
  rebuilds: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  pollCalls: number;
  window?: number;
  stage?: 'wrap-up' | 'checkpoint';
};

/**
 * The accumulator `applyEvent` folds the stream into.
 *
 * Milliseconds rather than ISO strings throughout: this is arithmetic, and a
 * type that has to `Date.parse` on every comparison is a type that will
 * eventually compare two strings by accident.
 */
export type LaneSignals = {
  /** When this ATTEMPT's session started — the window `spinning` counts in. */
  startedAt: number;
  /**
   * The last stream event of ANY kind, retries and rate-limit heartbeats
   * included. This is the DISPLAY clock — "when did we last hear from it" —
   * and it is deliberately not the one `silent` reads.
   */
  lastOutputAt: number;
  /**
   * The last event that was the session doing something: everything except
   * `retry` and `limits`.
   *
   * The distinction is the whole of the wall this file was rewritten for. A
   * session pinned in a 429 loop emits `api_retry` roughly every thirty
   * seconds forever; folding those into `lastOutputAt` and asking `silent`
   * about `lastOutputAt` meant the retry cadence refreshed the session's own
   * silence clock, and a lane that had produced nothing for three and a half
   * hours never once read as quiet. Both clocks are kept because both are
   * true: the console DID hear from it, and it produced nothing.
   */
  lastProductiveAt: number;
  /**
   * Consecutive `retry` events with nothing productive between them — the
   * `retrying` counter. Reset by anything that stamps `lastProductiveAt`.
   */
  retriesSinceProgress: number;
  /** When the current retry burst began (ms). Undefined between bursts. */
  retryBurstSince?: number;
  /** The category the newest retry named (`rate_limit`, `overloaded`, …). */
  lastRetryCategory?: string;
  lastToolUseAt?: number;
  turnsSinceLastTool: number;
  /** Insertion-ordered, so index 0 is the oldest unanswered call. */
  openTools: OpenToolAt[];
  /**
   * The last `LOOP_WINDOW` FINISHED calls of the lane's own conversation,
   * oldest first — what `looping` is read from.
   *
   * Optional only for a signals object built by hand; `newLaneSignals` gives a
   * lane one. Deliberately not merged into `openTools`, which is a set of calls
   * still outstanding and is read by three other things: a call belongs to
   * exactly one of the two lists at any moment, and conflating them would make
   * `oldestOpenTool` report a call that has already come back.
   */
  recentCalls?: ToolOutcome[];
  /** Refreshed on the slow cadence; see `LaneLiveness`. */
  commitsSinceStart: number;
  treeDirty: boolean;
  /** Consecutive attempts of THIS phase that committed nothing and left a clean tree. */
  idleAttempts: number;
  /** True while the phase's own §Verification is running — every signal is suppressed. */
  verifying: boolean;
  /**
   * True while the operator holds this lane under SIGSTOP — every signal is
   * suppressed, for the same reason `verifying` is.
   *
   * A frozen session produces nothing BY CONSTRUCTION, so every silence
   * detector fires on it within a minute or two: the operator pressed Freeze
   * and the console answered with a stall card, a `needs-you` inbox row and a
   * lane ranked as if something had gone wrong. Nothing HAS gone wrong — the
   * absence of output is the feature working. A deliberate act must never be
   * reported as a failure.
   */
  frozen: boolean;
  /** The episode in progress, so a transition can be told from a repeat. */
  stall: StallState | null;
  /**
   * The wait the console REFUSED on this lane (`noteWaitDenied`) — the signal
   * the plan calls `lane.wait-denied`. `externalWaitTool` sees only a call that
   * is still open, and the in-turn-wait guard denies the call before it opens,
   * so the local-job ladder — nudge, then park with a `cmd:` ref at
   * `stallLocalJobMs` — could never reach exactly the wait it was built for
   * (RCV-5; measured: `until ! pgrep …` and `--watch` denied, then the session
   * declared somebody else's clock with prose for refs). One episode: `since`
   * is the first denial and holds while denials keep coming; durable progress
   * (a commit, a declared outcome) ends it.
   */
  waitDenied?: { since: number; lastAt: number; command: string; matched: string; scope: WaitScope; count: number };
  /**
   * The background tasks the CLI is holding open for this session, oldest
   * first — the stream's `background` events, folded. Optional because a lane
   * that has started none carries none; `awaitingBackground` reads it.
   */
  backgroundTasks?: BackgroundTask[];
  /**
   * The poll-loop guard's tracker for this session (autopilot-token-drain
   * phase 2, `shared/poll-loop.js`): the PreToolUse hook folds in the calls it
   * can judge (`Runner.observeToolCall`), and `applyEvent` every other call the
   * session makes, which is what breaks a streak. Optional only for a signals
   * object built by hand; `newLaneSignals` always gives a lane one.
   */
  pollLoop?: PollLoopState;
  /** The one poll-loop notice this lane may be sent has been spent (`Runner.nudgePollLoop`). */
  pollNudged?: boolean;
  /**
   * The newest totals the session's `usage` events reported — replaced, never
   * added to, because each event already carries the whole fold. Absent until
   * the first API call (autopilot-token-drain phase 3).
   */
  tokens?: TokenCounters;
  /** The context window this lane's thresholds are judged against, once the runner knows the model. */
  contextWindow?: number;
};

/**
 * One background task the CLI started for this session and has not reported
 * finished (autopilot-token-drain phase 1).
 *
 * The API later phases build on: `spawn.ts` emits the `background` event,
 * `applyEvent` keeps these, `awaitingBackground` answers which of them wake the
 * session, and `Runner.awaitingBackground(phase)` hands that to the Stop hook.
 */
export type BackgroundTask = {
  id: string;
  /** `system/task_started.task_type` — `local_bash`, `local_agent`, `remote_agent`, `monitor_mcp`, … */
  taskType?: string;
  /** The tool call that started it, paired by `tool_use_id` — how a `Monitor` is told from a background `Bash`. */
  tool?: string;
  description?: string;
  /** Started by a subagent rather than by the phase's own conversation. */
  ownedBySubagent?: boolean;
  /** When the task started (ms). */
  since: number;
};

type OpenToolAt = { id: string; name: string; since: number; summary?: string };

/**
 * One FINISHED tool call of the lane's own conversation.
 *
 * The ring of these is what the `looping` signal is read from, and the shape is
 * chosen so the comparison is a tuple equality rather than a judgement: a tool
 * name, the call's own one-line summary (for a `Bash` call, the command), and a
 * digest of the words that came back. Two calls are "the same call, failing the
 * same way" exactly when all three match — which is what separates a session
 * going round in circles from one working through a list of real problems, and
 * why the detector is not fooled by a retry that fails differently.
 *
 * The result's own words are DIGESTED rather than kept. A tool result is
 * unbounded and this ring lives on every lane's signals, which are
 * checkpointed: keeping ten full results per lane would put a session's stderr
 * into every run file. The digest answers the only question asked of it.
 */
export type ToolOutcome = {
  ok: boolean;
  tool: string;
  /** The call's own summary, as `spawn.ts` built it — capped there at 240. */
  summary: string;
  /** `callHash` of the result's detail. */
  hash: string;
  /** When the call went OUT, not when it came back — see `loopRun`. */
  at: number;
  id?: string;
};

/**
 * How many finished calls the ring keeps.
 *
 * Ten, which is the window the loop is looked for in. Deliberately small: the
 * ring is checkpointed with the lane, and a longer memory buys nothing — a
 * loop is by definition consecutive, so anything before the last break is
 * already irrelevant.
 */
export const LOOP_WINDOW = 10;

/** How much of a result's own words the digest reads. */
const HASH_READ = 4_000;

/**
 * A short, stable digest of what a tool result said.
 *
 * Whitespace-folded first, so the same failure reported with a different line
 * wrap is the same failure. Twelve hex characters is the same width the message
 * ledger uses for an id and is far more than enough for an equality test over
 * ten values.
 *
 * Absent and empty are deliberately the same digest: both are "the call came
 * back with no words", which is one fact, and a detector that told them apart
 * would never match two of the many results that carry nothing.
 */
export function callHash(detail: string | undefined | null): string {
  return createHash('sha256').update(foldWhitespace(String(detail ?? '')).slice(0, HASH_READ)).digest('hex').slice(0, 12);
}

/**
 * The consecutive identical FAILURES at the end of the ring, if any.
 *
 * From the end, because the question is about now: a lane that failed the same
 * way three times an hour ago and has been fine since is not looping. The run
 * is broken by anything at all — a success, a different tool, a different
 * command, different words back — which is what makes "a differing hash resets"
 * true without a second rule.
 *
 * `head` is the OLDEST call of the run, so an episode's clock starts when the
 * loop started rather than when a tick noticed it. That is the same rule every
 * other stall signal follows, and it is why `ToolOutcome.at` is the moment the
 * call went out.
 */
export function loopRun(
  calls: readonly ToolOutcome[],
): { count: number; head: ToolOutcome; ids: string[] } | null {
  const last = calls.at(-1);
  if (!last || last.ok) return null;
  let i = calls.length - 1;
  while (i > 0) {
    const previous = calls[i - 1]!;
    if (previous.ok || previous.tool !== last.tool || previous.summary !== last.summary
      || previous.hash !== last.hash) break;
    i--;
  }
  const run = calls.slice(i);
  return {
    count: run.length,
    head: run[0]!,
    ids: run.map((call) => call.id).filter((id): id is string => Boolean(id)),
  };
}

/**
 * The same ceiling `spawn.ts` puts on its pending-tool map, and for the same
 * reason: a session that leaks call ids must cost memory that is bounded.
 */
const MAX_OPEN_TOOLS = 64;

/** A fresh accumulator for a lane that has just been spawned. */
export function newLaneSignals(startedAt: number, carry?: { idleAttempts?: number }): LaneSignals {
  return {
    startedAt,
    lastOutputAt: startedAt,
    lastProductiveAt: startedAt,
    retriesSinceProgress: 0,
    turnsSinceLastTool: 0,
    openTools: [],
    recentCalls: [],
    commitsSinceStart: 0,
    treeDirty: false,
    idleAttempts: carry?.idleAttempts ?? 0,
    verifying: false,
    frozen: false,
    stall: null,
    pollLoop: newPollLoop(),
  };
}

/**
 * Fold one stream event in.
 *
 * Mutates rather than returning a new object, deliberately: this runs on every
 * `partial` delta of every lane, and the alternative is an allocation per
 * character. It is still a pure reducer in the sense that matters — `at` is
 * passed in, nothing here reads a clock, and a test drives it by handing it
 * numbers.
 */
/**
 * Was this event the session WORKING, as opposed to the plumbing around it?
 *
 * The one definition of the distinction, exported because two callers need
 * the same answer and a second copy of the list would drift: `applyEvent`
 * below decides `lastProductiveAt` and the retry counter by it, and
 * `runner.ts`'s live wall clears its own rate-limit evidence by it, so a 429
 * the CLI absorbs can never accumulate toward an account switch.
 *
 * `retry` is the CLI's watchdog reporting what it is absorbing on our behalf;
 * `limits` is the account's usage window arriving out of band. Everything
 * else — a token, a turn, a tool call, a line of stderr, an operator's nudge —
 * is the session doing something.
 */
export function isProductiveEvent(event: StreamEvent): boolean {
  return event.kind !== 'retry' && event.kind !== 'limits';
}

/**
 * Did the session say something DURABLE about where the phase stands — a commit,
 * or an outcome declared through `phase-outcome.sh`?
 *
 * Narrower than `isProductiveEvent` on purpose. A declared wait is the session's
 * testimony about the world, and it used to be spent by the first productive
 * event of the resume — a single `git status` — so a resume that did nothing
 * but look left a record that could no longer say what it was waiting for
 * (WAI-4; measured: spent 0.8 s into a resume that then produced nothing). A
 * denied in-turn wait's episode ends on the same evidence (`noteWaitDenied`):
 * the session moved on only when it did something that lasts.
 */
export function isDurableProgress(event: StreamEvent): boolean {
  if (event.kind !== 'tool' || event.name !== 'Bash') return false;
  const command = event.summary ?? '';
  return /\bgit\b[^;&|\n]*\bcommit\b/.test(command) || /phase-outcome\.sh\b/.test(command);
}

export function applyEvent(signals: LaneSignals, event: StreamEvent, at: number): void {
  // Every event is output. `stderr` included: a session writing to stderr is a
  // session doing something, and a lane that only ever complained is not
  // silent — it is failing, which is a different card.
  signals.lastOutputAt = at;

  // ...but only some events are the session WORKING. `retry` is the CLI's own
  // watchdog reporting what it is absorbing on our behalf, and `limits` is
  // the account's usage window arriving out of band; neither is a turn, a
  // token or a tool call. Stamping the productive clock for them is what let
  // a 429 loop hold its own silence clock below threshold every thirty
  // seconds for three and a half hours. The stamp is below the switch on
  // purpose — `break` above it would have skipped it.
  if (!isProductiveEvent(event)) {
    if (event.kind === 'retry') {
      signals.retriesSinceProgress += 1;
      signals.retryBurstSince ??= at;
      if (event.category) signals.lastRetryCategory = event.category;
    }
    return;
  }

  signals.lastProductiveAt = at;
  // A denied wait's episode ends when the session does something that lasts —
  // the rule a declaration is spent by (`isDurableProgress`).
  if (signals.waitDenied && isDurableProgress(event)) delete signals.waitDenied;
  // The burst is consecutive by definition: one real event ends it. Left
  // as-is when nothing productive has happened, so a burst's `since` is when
  // the FIRST retry landed rather than when the tick noticed the fifth.
  signals.retriesSinceProgress = 0;
  delete signals.retryBurstSince;
  delete signals.lastRetryCategory;

  switch (event.kind) {
    case 'tool': {
      // A subagent's calls are its own. They are the phase's spend, but they
      // are not evidence that the phase's own conversation is acting — a
      // delegating turn that then waits is exactly the case `spinning` exists
      // to catch.
      if (event.parent) break;
      signals.lastToolUseAt = at;
      signals.turnsSinceLastTool = 0;
      // Any call the hook does not judge is the session doing something else,
      // so it breaks a poll streak. The four the guard reads are the hook's to
      // count, with the input the stream no longer carries.
      if (!isStatusCapable(event.name)) observeCall((signals.pollLoop ??= newPollLoop()), { name: event.name }, at);
      if (event.id) {
        // `summary` is already whitespace-collapsed and capped by `summarise`;
        // carried verbatim so the external-clock vocabulary — which spells its
        // one whitespace requirement as a literal space — matches against the
        // same normalisation the bash side gets from `tr`.
        signals.openTools.push({
          id: event.id, name: event.name, since: at,
          ...(event.summary ? { summary: event.summary } : {}),
        });
        if (signals.openTools.length > MAX_OPEN_TOOLS) signals.openTools.shift();
      }
      break;
    }
    case 'tool-result': {
      if (event.parent) break;
      const i = signals.openTools.findIndex((tool) => tool.id === event.id);
      // The call that went out is where the tool's NAME and its summary live —
      // a result carries neither — so the outcome can only be assembled here,
      // while the pair is still together. A result whose call the ring never
      // saw (the tail cut it off, or the id was never emitted) is dropped
      // rather than recorded with an invented name: a tuple with a guessed
      // member would match another guess and report a loop that never happened.
      if (i >= 0) {
        const call = signals.openTools[i]!;
        signals.openTools.splice(i, 1);
        const calls = (signals.recentCalls ??= []);
        calls.push({
          ok: event.ok,
          tool: call.name,
          summary: call.summary ?? '',
          hash: callHash(event.detail),
          at: call.since,
          ...(call.id ? { id: call.id } : {}),
        });
        if (calls.length > LOOP_WINDOW) calls.splice(0, calls.length - LOOP_WINDOW);
      }
      break;
    }
    case 'step': {
      // `spawn.ts` emits this only for the phase's own turns, so there is no
      // parent to check. A turn that carried tool calls has already reset the
      // counter above; one that carried none advances it.
      if (event.tools > 0) signals.turnsSinceLastTool = 0;
      else signals.turnsSinceLastTool += 1;
      break;
    }
    case 'injected': {
      // An operator steering the session is the strongest possible evidence
      // that somebody is on it. Reset the spin counter so the nudge gets a
      // fair hearing instead of tripping the same card on the next turn.
      signals.turnsSinceLastTool = 0;
      break;
    }
    case 'usage': {
      // The session's whole fold rides every event, so the newest one replaces.
      signals.tokens = { ...event.totals };
      break;
    }
    case 'background': {
      const tasks = (signals.backgroundTasks ??= []);
      const i = tasks.findIndex((task) => task.id === event.taskId);
      if (i >= 0) tasks.splice(i, 1);
      if (event.op === 'started') {
        tasks.push({
          id: event.taskId, since: at,
          ...(event.taskType ? { taskType: event.taskType } : {}),
          ...(event.tool ? { tool: event.tool } : {}),
          ...(event.description ? { description: event.description } : {}),
          ...(event.ownedBySubagent ? { ownedBySubagent: true } : {}),
        });
        if (tasks.length > MAX_OPEN_TOOLS) tasks.shift();
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Does this outstanding task wake the session when it finishes — so that a
 * turn ending while it runs is a WAIT rather than an exit?
 *
 * Measured, not assumed (autopilot-token-drain §Context E1–E6, CLI 2.1.273,
 * this runner's framing): after the turn ends, an Agent (`local_agent`) and a
 * Monitor running in the background keep the `-p` process alive and their
 * completion starts a new turn — stdin closed or not — while a background Bash
 * is stopped about five seconds later. A Monitor reaches the stream as
 * `task_type: local_bash`, exactly like a background Bash: the CLI registers
 * both through one shell-task path and keeps its `kind: "monitor"` off the
 * wire. So a monitor is told apart by the tool call that started it.
 *
 * Everything else does not count, and the direction of that error is chosen:
 * a type nobody measured (`remote_agent`, `local_workflow`, the CLI's own MCP
 * and websocket monitors), or a task a subagent owns, leaves the Stop hook
 * holding the turn exactly as it did before this existed.
 */
export function wakesTheSession(task: Pick<BackgroundTask, 'taskType' | 'tool' | 'ownedBySubagent'>): boolean {
  if (task.ownedBySubagent) return false;
  if (task.taskType === 'local_agent') return true;
  return task.taskType === 'local_bash' && task.tool === 'Monitor';
}

/** The outstanding background tasks that will wake the session, oldest first. */
export function awaitingBackground(signals: Pick<LaneSignals, 'backgroundTasks'>): BackgroundTask[] {
  return (signals.backgroundTasks ?? []).filter(wakesTheSession);
}

/** The oldest unanswered call, as it goes on the wire. */
export function oldestOpenTool(signals: LaneSignals): OpenTool | undefined {
  const tool = signals.openTools[0];
  return tool
    ? {
      id: tool.id, name: tool.name, since: new Date(tool.since).toISOString(),
      ...(tool.summary ? { summary: tool.summary } : {}),
    }
    : undefined;
}

/**
 * The tool name an external wait can be hiding in.
 *
 * Only `Bash`, and narrowly on purpose. The vocabulary is command-shaped, so
 * matching it against a `Read`'s file path or a `Grep`'s pattern could only
 * ever produce a false positive — and a false positive here does not raise a
 * card, it ENDS A LIVE SESSION and parks the phase. The cost of missing a wait
 * hidden in some other tool is one more `silent` card ten minutes later; the
 * cost of the reverse is a session killed for reading a file called
 * `tail -f.md`.
 */
const EXTERNAL_WAIT_TOOL = 'Bash';

/**
 * The oldest open call that is a wait on somebody else's clock, with the
 * fragment of the vocabulary that says so — or nothing.
 *
 * Oldest rather than first-matching because `openTools` is insertion-ordered
 * and the age is the whole question: a session with two poll loops open (the
 * measured incident had exactly two) should be judged on the one that has been
 * running longest, not on whichever the CLI happened to emit first.
 */
export function externalWaitTool(
  signals: LaneSignals, at: number, thresholdMs: number, env?: VerifyEnv,
): { tool: OpenToolAt; matched: string; scope: WaitScope } | null {
  // Zero is "never": `stallExternalWaitMs: 0` switches the signal off.
  if (!env || thresholdMs <= 0) return null;
  for (const tool of signals.openTools) {
    if (tool.name !== EXTERNAL_WAIT_TOOL || !tool.summary) continue;
    if (at - tool.since < thresholdMs) continue;
    // Through `externalWaitMatch` rather than a bare `exec`: the fold and the
    // `docker compose up -d` carve-out are part of what the vocabulary MEANS,
    // and a second reader applying them differently is the drift `verify.env`
    // exists to prevent. The matched fragment is returned because it is the
    // evidence a person reads on the card.
    const matched = externalWaitMatch(env, tool.summary);
    if (matched) return { tool, matched, scope: waitScope(tool.summary) };
  }
  return null;
}

/**
 * Record a wait the console's in-turn-wait guard refused on this lane — see
 * `LaneSignals.waitDenied`. A denial more than `episodeMs` after the last one
 * starts a new episode; one inside it keeps `since` and counts.
 */
export function noteWaitDenied(
  signals: LaneSignals, denial: { command: string; matched: string }, at: number, episodeMs: number,
): void {
  const prior = signals.waitDenied;
  const continuing = Boolean(prior) && at - prior!.lastAt < episodeMs;
  signals.waitDenied = {
    since: continuing ? prior!.since : at,
    lastAt: at,
    command: denial.command,
    matched: denial.matched,
    scope: waitScope(denial.command),
    count: continuing ? prior!.count + 1 : 1,
  };
}

/**
 * Is a refused wait still the lane's story? Only while the session is either
 * PRESSING — refused again inside the external-wait threshold — or has gone
 * quiet for that long since; a session that took the refusal, backgrounded its
 * job and went on working is left alone. A refusal older than the local budget
 * plus that threshold has been over for a while, whatever the lane does now.
 */
function deniedWait(
  signals: LaneSignals, thresholds: StallThresholds, now: number,
): NonNullable<LaneSignals['waitDenied']> | null {
  const denied = signals.waitDenied;
  if (!denied || thresholds.stallExternalWaitMs <= 0) return null;
  if (now - denied.lastAt > thresholds.stallLocalJobMs + thresholds.stallExternalWaitMs) return null;
  if (now - denied.since < thresholds.stallExternalWaitMs) return null;
  const pressing = denied.count >= 2 && now - denied.lastAt < thresholds.stallExternalWaitMs;
  const stalled = now - signals.lastProductiveAt >= thresholds.stallExternalWaitMs;
  return pressing || stalled ? denied : null;
}

/** Fall back to the shipped numbers for anything a caller left out or spelled wrong. */
/**
 * When the local-job nudge may fire: the larger of the `external-wait` signal's
 * own threshold and the ten minutes the wait procedure grants a session on its
 * own job. An operator who widens the signal past ten minutes is honoured; one
 * who leaves it at the 5-minute default no longer nudges inside the allowance.
 * (console-open-findings O6.)
 */
export function localNudgeAfterMs(stallExternalWaitMs: number): number {
  return Math.max(stallExternalWaitMs, LOCAL_JOB_GRACE_MS);
}

export function stallThresholds(prefs?: Partial<StallThresholds> | null): StallThresholds {
  const positive = (value: unknown, fallback: number): number =>
    (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback);
  return {
    stallSilentMs: positive(prefs?.stallSilentMs, STALL_DEFAULTS.stallSilentMs),
    stallSpinTurns: positive(prefs?.stallSpinTurns, STALL_DEFAULTS.stallSpinTurns),
    stallStalemateAttempts: positive(prefs?.stallStalemateAttempts, STALL_DEFAULTS.stallStalemateAttempts),
    stallRetryBurst: positive(prefs?.stallRetryBurst, STALL_DEFAULTS.stallRetryBurst),
    // Zero is kept: it means "never call a lane waiting" (SLF-9) — the one
    // detector threshold where a zero is a setting rather than nonsense.
    stallExternalWaitMs: typeof prefs?.stallExternalWaitMs === 'number' && Number.isFinite(prefs.stallExternalWaitMs)
      && prefs.stallExternalWaitMs >= 0 ? prefs.stallExternalWaitMs : STALL_DEFAULTS.stallExternalWaitMs,
    stallLocalJobMs: positive(prefs?.stallLocalJobMs, STALL_LOCAL_JOB_MS),
    stallLoopRun: positive(prefs?.stallLoopRun, STALL_DEFAULTS.stallLoopRun),
  };
}

/** Whole minutes, rounded down, for a sentence rather than a chart. */
function minutes(ms: number): number {
  return Math.max(0, Math.floor(ms / 60_000));
}

/**
 * Which signal, if any, holds right now.
 *
 * Worst-first over `STALL_SIGNALS`, returning the first that holds — so a lane
 * that is both spinning and now silent reports `silent`, which is the newer
 * and harder fact, and one that is both silent and retrying reports
 * `retrying`, which is the same fact with its cause attached.
 *
 * **`verifying` suppresses everything**, and that is not a nicety. The runner
 * sets `verifying` while it runs the phase's own §Verification commands, which
 * is precisely the stretch where the session has exited and produced nothing
 * for as long as the test suite takes. A `npm test` that runs for twelve
 * minutes is silent and completely fine, and a console that raised a card for
 * it would raise one on every phase of every plan with a real suite.
 *
 * Returns null when nothing holds; the caller compares that against the
 * episode it already had to tell a clear from a quiet.
 */
export function evaluateStall(
  signals: LaneSignals,
  thresholds: StallThresholds,
  now: number,
  context: StallContext = {},
): StallState | null {
  // A deliberate freeze and a running §Verification are the same case: the
  // session is silent because the console arranged for it to be.
  if (signals.verifying || signals.frozen) return null;

  if (signals.idleAttempts >= thresholds.stallStalemateAttempts) {
    return {
      signal: 'stalemate',
      // The episode starts when the attempt that made it true ended, which is
      // the last thing that happened on this lane.
      since: new Date(signals.lastOutputAt).toISOString(),
      detail: `${signals.idleAttempts} attempts in a row ended with nothing committed and a clean tree`,
    };
  }

  // Before `silent`, because a retrying lane IS silent and this says why. The
  // clock is a COUNT rather than a duration on purpose: what makes a retry
  // storm a storm is that nothing got between the retries, and the CLI's
  // cadence is its own business.
  if (signals.retriesSinceProgress >= thresholds.stallRetryBurst) {
    const since = signals.retryBurstSince ?? signals.lastProductiveAt;
    return {
      signal: 'retrying',
      since: new Date(since).toISOString(),
      detail: `${signals.retriesSinceProgress} API retries in a row`
        + (signals.lastRetryCategory ? ` (${signals.lastRetryCategory})` : '')
        + `, nothing produced for ${minutes(now - signals.lastProductiveAt)} min`,
    };
  }

  // Before `silent`, and on a SHORTER clock, because this is the same silence
  // with its cause visible in the command itself. A lane inside `gh run watch`
  // is not working and is not broken — it is waiting, which has a remedy
  // (`waiting-external`: park, release the lock, resume when the window
  // elapses) that `silent`'s "go and look at it" does not name.
  //
  // The threshold is the tool's OWN age, not the productive clock: a session
  // that opened a poll loop three seconds after its last token is waiting from
  // the moment the call went out, and measuring from the last event would just
  // add whatever the session happened to be doing before it.
  const waiting = externalWaitTool(
    signals, now, thresholds.stallExternalWaitMs, context.verifyEnv,
  );
  if (waiting) {
    return {
      signal: 'external-wait',
      // When the call went out — the moment the waiting began.
      since: new Date(waiting.tool.since).toISOString(),
      detail: `a Bash call matching \`${waiting.matched}\` has been open for `
        + `${minutes(now - waiting.tool.since)} min — it waits on `
        + (waiting.scope === 'local'
          ? 'a background job this session started'
          : 'a clock outside this session'),
      scope: waiting.scope,
      source: 'open',
    };
  }

  // The same signal with no call open, because the console refused it (RCV-5):
  // the lane asked to wait inside its turn, was told no, and is still acting on
  // that wait — asking again, or gone quiet. The local-job ladder reaches it
  // exactly as it reaches an open poll loop.
  const denied = deniedWait(signals, thresholds, now);
  if (denied) {
    return {
      signal: 'external-wait',
      since: new Date(denied.since).toISOString(),
      detail: `the console refused ${denied.count} in-turn wait(s) matching \`${denied.matched}\` since `
        + `${minutes(now - denied.since)} min ago — it waits on `
        + (denied.scope === 'local' ? 'a background job this session started' : 'a clock outside this session'),
      scope: denied.scope,
      source: 'denied',
    };
  }

  // Measured from the PRODUCTIVE clock: a session pinned in a retry loop is
  // heard from constantly and is producing nothing, and it is the second of
  // those that this signal is about.
  //
  // Not while the session's turn has ended on its own subagents or monitors
  // running in the background (no call open, a waker outstanding): it is between two halves of
  // its own work, and their notification starts its next turn. Bounded by the
  // local-job clock, the same allowance a wait on its own job gets — an agent
  // that never reports is silence after all.
  const quietFor = now - signals.lastProductiveAt;
  const awaitingOwnWork = signals.openTools.length === 0
    && quietFor < thresholds.stallLocalJobMs
    && awaitingBackground(signals).length > 0;
  if (quietFor >= thresholds.stallSilentMs && !awaitingOwnWork) {
    const open = signals.openTools[0];
    return {
      signal: 'silent',
      // When the silence began, not when the tick noticed it — otherwise the
      // card's clock restarts every minute and the episode never ages.
      since: new Date(signals.lastProductiveAt).toISOString(),
      detail: `no output for ${minutes(quietFor)} min`
        + (open
          ? `; the oldest open tool call is ${open.name}, out for ${minutes(now - open.since)} min`
          : '; no tool call is open'),
    };
  }

  if (signals.turnsSinceLastTool >= thresholds.stallSpinTurns) {
    return {
      signal: 'spinning',
      since: new Date(signals.lastToolUseAt ?? signals.startedAt).toISOString(),
      detail: `${signals.turnsSinceLastTool} turns with no tool call`,
    };
  }

  // Last, and that is the rank rather than an afterthought. A looping lane is
  // producing output the whole time, so it is neither silent nor spinning and
  // in practice no other signal competes with it — but if one ever does, the
  // other one is the harder fact: silence and a retry storm say the session
  // cannot work at all, while this says it is working on the wrong thing.
  const loop = loopRun(signals.recentCalls ?? []);
  if (loop && loop.count >= thresholds.stallLoopRun) {
    return {
      signal: 'looping',
      // When the FIRST of the run went out — the moment the loop began.
      since: new Date(loop.head.at).toISOString(),
      detail: `${loop.count} identical failing ${loop.head.tool} calls in a row`
        + (loop.head.summary ? `: ${loop.head.summary.slice(0, 120)}` : '')
        + ', each answered the same way',
    };
  }

  return null;
}

/**
 * The wire view of a lane. Kept beside the evaluator so the two can never
 * disagree about which fields exist.
 */
export function livenessOf(phase: number, signals: LaneSignals): LaneLiveness {
  const open = oldestOpenTool(signals);
  const tokens = signals.tokens;
  const stage = tokens ? contextStage(tokens.lastContext, signals.contextWindow) : 'ok';
  return {
    phase,
    lastOutputAt: new Date(signals.lastOutputAt).toISOString(),
    ...(signals.lastToolUseAt ? { lastToolUseAt: new Date(signals.lastToolUseAt).toISOString() } : {}),
    turnsSinceLastTool: signals.turnsSinceLastTool,
    commitsSinceStart: signals.commitsSinceStart,
    treeDirty: signals.treeDirty,
    ...(open ? { openTool: open } : {}),
    ...(signals.stall ? { stall: signals.stall } : {}),
    ...(signals.retriesSinceProgress > 0
      ? {
        retries: {
          count: signals.retriesSinceProgress,
          since: new Date(signals.retryBurstSince ?? signals.lastProductiveAt).toISOString(),
        },
      }
      : {}),
    ...(tokens && tokens.calls > 0
      ? {
        tokens: {
          context: tokens.lastContext,
          peak: tokens.peakContext,
          calls: tokens.calls,
          rebuilds: tokens.rebuilds,
          input: tokens.input,
          cacheRead: tokens.cacheRead,
          cacheWrite: tokens.cacheWrite,
          output: tokens.output,
          pollCalls: signals.pollLoop?.counts.status ?? 0,
          ...(signals.contextWindow ? { window: signals.contextWindow } : {}),
          ...(stage !== 'ok' ? { stage } : {}),
        },
      }
      : {}),
  };
}
