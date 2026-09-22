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
 * | `cmd:` | `cmd:<command>` or `cmd:"<command>"` | the command exits 0 | the policy §Verification gets, 60 s, off-switchable, run-bounded |
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
 * where a `cmd:` ref runs every five minutes for as long as the phase is parked.
 * So it carries three gates that nothing else here does — `--allow-run`, the
 * `watchCmdRefs` pref, and `MAX_CMD_RUNS_PER_PHASE` — because it is the one
 * scheme whose refs are WRITTEN by a session rather than read by one.
 */

import type { WatchStateWord } from '../shared/run-lifecycle.js';
import { shell } from './shell.ts';

/** Every scheme this console will poll. The list is written here and nowhere else. */
export const WATCH_SCHEMES = ['gh-run', 'gh-pr', 'date', 'lock', 'cmd'] as const;
export type WatchScheme = (typeof WATCH_SCHEMES)[number];

export type WatchRefTarget =
  | { kind: 'gh-run'; repo: string; id: string; ref: string }
  | { kind: 'gh-pr'; repo: string; number: string; ref: string }
  /** `at` is epoch ms — parsed once here so no consumer re-parses a string. */
  | { kind: 'date'; at: number; ref: string }
  | { kind: 'lock'; slug: string; phase: number; ref: string }
  | { kind: 'cmd'; command: string; ref: string };

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
};

/**
 * How often each scheme is worth re-asking, in ms.
 *
 * `date` is absent on purpose: its due time IS its instant, so the scheduler
 * schedules it exactly once (see `nextDueFor`). The others are chosen against
 * what they cost — `gh` is a network round trip and a rate-limited one, `cmd`
 * may be a whole test command, and a lock is a file read.
 */
export const WATCH_POLL_MS: Readonly<Record<WatchScheme, number>> = Object.freeze({
  'gh-run': 120_000,
  'gh-pr': 300_000,
  date: 0,
  lock: 60_000,
  cmd: 300_000,
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
 * How many times ONE `cmd:` ref may be executed for one phase before the
 * console stops running it.
 *
 * The other four schemes read something; this one RUNS something, every five
 * minutes, for as long as the phase is parked — which is days, not minutes. The
 * policy it goes through is not "read-only" in the strict sense (`npm ci`,
 * `cargo build` and `uv sync` all pass it and all write), so an unbounded
 * `cmd:` ref is an unbounded number of side effects nobody is watching. Twelve
 * is two hours at the `cmd:` cadence: long enough to be the useful answer to
 * "has the deploy finished", short enough that a ref nobody meant to leave
 * running stops on its own. Past it the ref reads `refused`, with words saying
 * so, which is a state the operator can see rather than a silence.
 */
export const MAX_CMD_RUNS_PER_PHASE = 12;

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
  if (ref.startsWith('lock:')) {
    const m = /^([^/]+)\/(\d+)$/.exec(ref.slice(5).trim());
    if (!m || !SLUG_RE.test(m[1])) return null;
    const phase = Number(m[2]);
    return Number.isSafeInteger(phase) && phase > 0 ? { kind: 'lock', slug: m[1], phase, ref } : null;
  }
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

/** The five shapes, in words — what a person needs beside a ref nothing can poll. */
export const WATCH_REF_SHAPES =
  'gh:<owner/repo>#run/<id> · gh:<owner/repo>#pr/<n> · date:<ISO8601> · lock:<slug>/<phase> · cmd:"<command>"';

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
  if (ref.startsWith('lock:')) return 'a lock: ref is lock:<slug>/<phase>';
  if (ref.startsWith('cmd:')) return 'a cmd: ref names no command';
  return `no watch scheme — the console polls ${WATCH_REF_SHAPES}`;
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

/** The pollable subset of a declared watch list, in declaration order, deduped. */
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
 *     exactly one interesting moment and is scheduled at it.
 */
export function nextDueFor(target: WatchRefTarget, state: WatchState['state'], now: number): number | null {
  if (state === 'refused') return null;
  if (state === 'landed') return now + WATCH_REDELIVER_MS;
  if (target.kind === 'date') return Math.max(now, target.at);
  return now + WATCH_POLL_MS[target.kind];
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
