/**
 * The one process probe — a fact, asked once, answered four ways.
 *
 * The console used to hold two of these. `state.ts:pidAlive` was bare
 * `kill(pid, 0)`, and `registry.ts:claudePidAlive` added a `ps -o comm=` check
 * against pid reuse. Neither read the process STATE, so both called a
 * `SIGSTOP`ped process alive — which is how a frozen child that outlived its
 * console was reported `live` on the Sessions page for three hours while the
 * run that owned it had already been parked and its lock released as debris.
 *
 * Three answers were missing, and each one changes what a caller should do:
 *
 *   `running`  the process exists and is scheduled. Wait for it.
 *   `stopped`  it exists and is NOT scheduled (`T`/`t` — SIGSTOP, or a
 *              debugger). Nothing will ever move it on its own, so a caller
 *              that "waits for it to finish" waits forever. This is evidence,
 *              not a queue to join.
 *   `zombie`   it has exited and nobody has reaped it (`Z`). Its work is over;
 *              only its parent's `wait()` is outstanding.
 *   `gone`     no such process — or the pid now belongs to something else.
 *
 * **Identity, not just existence.** macOS has no `pidfd`, so a pid is only as
 * good as the tuple `(pid, start-time)`. `ps -o lstart=` gives the second half
 * for free in the same call, and comparing it is what stops a recycled pid
 * from pinning a run forever against an innocent process. Callers that know
 * when they started their child pass `startedAt`; callers that only know what
 * they started pass `expect`.
 *
 * **Failing to ask is not an answer.** Every path that cannot reach `ps` falls
 * back to what `kill(0)` alone can prove, and `kill(0)` proving existence
 * reads as `running` — the safe direction for a probe whose main use is to
 * decide whether something may be taken away.
 *
 * **Asking must not stop the server.** `ps` used to be shelled with
 * `execFileSync`, and `processState` is reached from a read path: `listRuns`
 * settles every record it loads, and settling asks about every lane's child. A
 * plan detail therefore blocked the event loop on one subprocess per lane
 * before it could render anything — every other request on the console waited
 * behind it. The `ps` read is now asynchronous, and the synchronous entry point
 * answers from the sample cache while a refresh runs behind it. That is a
 * change of TIMING, not of vocabulary: a pid the cache has never seen falls
 * back to exactly the `kill(0)` answer documented above, which is the same
 * answer it has always given when `ps` could not be reached, and the real state
 * lands before the next read.
 */

import { execFile } from 'node:child_process';

export type ProcessState = 'running' | 'stopped' | 'zombie' | 'gone';

export type ProbeOptions = {
  /**
   * When the caller believes this process started. Compared against the
   * kernel's own start time with a tolerance; a mismatch means the pid was
   * recycled and the answer is `gone`.
   */
  startedAt?: string | number | Date;
  /**
   * What the caller believes it started, matched against `ps -o comm=`.
   * A mismatch means the pid was recycled and the answer is `gone`.
   */
  expect?: RegExp;
};

/**
 * How far apart the caller's idea of a start time and the kernel's may be
 * before the pid is judged recycled.
 *
 * Generous on purpose: `lstart` has one-second resolution, a caller's
 * timestamp is taken around the spawn rather than inside it, and the cost of
 * the two errors is wildly asymmetric — calling a live child `gone` lets a
 * second session start beside it, while calling a recycled pid `running`
 * merely leaves a run parked until a person looks.
 */
const START_SLACK_MS = 120_000;

/** `ps` is a subprocess, and the scheduler asks per lock per scan. */
const CACHE_MS = 5_000;

/** Above this many samples, a write sweeps the ones past their freshness window. */
const PID_CACHE_SOFT = 256;

/** A hard ceiling for the case where every sample is genuinely fresh. */
const PID_CACHE_MAX = 1024;

type Sample = {
  at: number;
  state: ProcessState;
  comm: string;
  startedMs: number | null;
  rss?: number;
  pcpu?: number;
};

/** What a process is COSTING, as the one `ps` reports it. */
export type ProcessResources = { rssKb: number; cpuPct: number };

const cache = new Map<number, Sample>();

/**
 * Probes in flight, so N callers asking about one pid inside one tick share a
 * single `ps` — the same single-flight the engine cache now uses, for the same
 * reason. `settle` asks per lane, and a plan with several runs asks about the
 * same child from several of them.
 */
const inflight = new Map<number, Promise<Sample | null>>();

/**
 * `comm`, and NOT `ucomm` — measured, not assumed.
 *
 * `ucomm` is the accounting name, and for the Claude CLI that is the versioned
 * binary it execs: `ps -o ucomm= -p <a live session>` answers `2.1.239`, which
 * matches no sensible expectation and would make every real child fail its own
 * identity check. `comm` answers `claude` for the same pid.
 *
 * The caveat that goes with it: in a multi-column `ps`, `comm` is truncated to
 * `MAXCOMLEN` (16) characters, and for a process whose `comm` is a full path
 * (a `node` under a long nvm prefix, say) that leaves `/home/someone/.n` —
 * a prefix, matching nothing. So `expect` may produce a false `gone` for such
 * a process, which is why no caller deciding whether to RECLAIM something
 * passes it. See `reconcileRun`.
 */

export type PsRow = {
  stat: string;
  comm: string;
  lstart: string;
  /** Resident set size in KB, as `ps` reports it. */
  rss?: number;
  /** Percentage of one CPU, as `ps` reports it. */
  pcpu?: number;
};

/**
 * Test seam: the raw `ps` read, so a suite can answer without a real process.
 *
 * A reader may answer synchronously OR with a promise. The shipped one is
 * asynchronous — that is the whole point of this file's `ps` change — while
 * every test seam returns a plain row, and a plain row is used the instant it
 * is produced. So a suite that installs a reader and asks `processState` on the
 * next line still gets that reader's answer, exactly as it did when the shell
 * was synchronous.
 */
export type PsReader = (pid: number) => PsRow | null | Promise<PsRow | null>;

let readPs: PsReader = defaultReadPs;

/**
 * Replace the `ps` reader (tests). Returns the previous one so a suite can
 * restore it; clearing the cache is part of the swap, or the next call would
 * answer from a sample the old reader took.
 */
export function setPsReader(reader: PsReader | null): PsReader {
  const previous = readPs;
  readPs = reader ?? defaultReadPs;
  cache.clear();
  inflight.clear();
  return previous;
}

function defaultReadPs(pid: number): Promise<PsRow | null> {
  return new Promise((resolve) => {
    // `'ps'` stays on the same line as the call, deliberately:
    // `invariants.test.ts` greps for `('ps',` and asserts it appears exactly
    // once in `server/`. A line break between them would make the one reader
    // invisible to the lint that exists to keep it the only one.
    // `rss` and `pcpu` ride the ONE `ps` this console is allowed to shell —
    // they are free here and a second probe for them would be a second reader,
    // which `invariants.test.ts` clause 1 refuses and which is exactly how two
    // answers about one process came to disagree. They sit BEFORE `lstart`
    // because `lstart` is the only column with spaces in it and so must stay
    // last for `parsePs` to split on whitespace at all.
    execFile('ps', ['-o', 'stat=,comm=,rss=,pcpu=,lstart=', '-p', String(pid)],
      { encoding: 'utf8', timeout: 1_000 },
      // A non-zero exit is `ps` saying "no such process" — but so is a missing
      // `ps`. The caller separates them with `kill(0)`; here, "could not read"
      // is null and is never an answer.
      (error, stdout) => resolve(error ? null : parsePs(String(stdout))),
    );
  });
}

function parsePs(out: string): PsRow | null {
  const line = out.split('\n').find((row) => row.trim() !== '');
  if (!line) return null;
  // `stat`, `comm`, `rss` and `pcpu` are single tokens; `lstart` is the rest,
  // and it contains spaces ("Sat Aug 22 20:30:07 2026"), so it cannot be split
  // on whitespace and has to stay last.
  const wide = /^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
  if (wide) {
    const rss = Number(wide[3]);
    const pcpu = Number(wide[4]);
    return {
      stat: wide[1], comm: wide[2], lstart: wide[5].trim(),
      ...(Number.isFinite(rss) ? { rss } : {}),
      ...(Number.isFinite(pcpu) ? { pcpu } : {}),
    };
  }
  // A reader that answers the three-column shape — every test seam written
  // before the two columns were added, and any `ps` that will not print them.
  // Kept rather than migrated: the resources are a decoration, and losing the
  // state, the identity and the start time to gain them would be a bad trade.
  const narrow = /^\s*(\S+)\s+(\S+)\s+(.*)$/.exec(line);
  if (!narrow) return null;
  return { stat: narrow[1], comm: narrow[2], lstart: narrow[3].trim() };
}

/** Does the process exist at all? `EPERM` means it does and is not ours. */
function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The first character of `ps -o stat=` is the state; the rest are flags
 * (`s` session leader, `+` foreground, `N` niced, `<` high priority).
 * `T` is stopped by a signal and `t` is stopped by a tracer — both mean "not
 * scheduled". `Z` is a zombie. Everything else (`R` `S` `I` `D` `U`) runs.
 */
function stateOf(stat: string): ProcessState {
  const head = stat.charAt(0);
  if (head === 'T' || head === 't') return 'stopped';
  if (head === 'Z') return 'zombie';
  return 'running';
}

/** macOS `lstart` ("Sat Aug 22 20:30:07 2026") parses directly. */
function parseStart(lstart: string): number | null {
  const ms = Date.parse(lstart);
  return Number.isFinite(ms) ? ms : null;
}

function store(pid: number, now: number, raw: PsRow | null): Sample | null {
  if (!raw) return null;
  const sample: Sample = {
    at: now,
    state: stateOf(raw.stat),
    comm: raw.comm,
    startedMs: parseStart(raw.lstart),
    ...(raw.rss === undefined ? {} : { rss: raw.rss }),
    ...(raw.pcpu === undefined ? {} : { pcpu: raw.pcpu }),
  };
  cache.set(pid, sample);
  evictStale(now);
  return sample;
}

/**
 * Drop samples nothing will read again.
 *
 * Every entry here is freshness-checked at read time, so a stale one was never
 * *wrong* — it was simply immortal. A pid is a small key and a `Sample` a small
 * value, but the map gained one entry per process this console ever probed:
 * every session, every child, every lane, for the life of the process, and the
 * scheduler probes per lock per scan. Swept on write rather than on a timer, so
 * it costs nothing on an idle console and cannot be a clock that keeps one up.
 */
function evictStale(now: number): void {
  if (cache.size <= PID_CACHE_SOFT) return;
  for (const [pid, sample] of cache) {
    // Anything past its freshness window would be re-probed on the next read
    // anyway; keeping it buys nothing.
    if (now - sample.at > CACHE_MS) cache.delete(pid);
  }
  // Every sample fresh and still over the cap means a genuine burst of live
  // pids. Insertion-order-oldest go, and they simply re-probe if asked again.
  while (cache.size > PID_CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/**
 * Take a sample, synchronously if the reader can and in the background if not.
 *
 * Returns the sample when it was available without waiting (a test seam), and
 * `null` when a probe is now in flight — the caller falls back to whatever it
 * already knows, which is what keeps this off the event loop.
 */
function refresh(pid: number, now: number): Sample | null {
  const raw = readPs(pid);
  if (!isThenable(raw)) return store(pid, now, raw);

  if (!inflight.has(pid)) {
    const settled = raw.then(
      (row) => store(pid, Date.now(), row),
      // A reader that threw is a reader that could not answer, which is the
      // same fact as `ps` failing: null, never a state.
      () => null,
    ).finally(() => { inflight.delete(pid); });
    inflight.set(pid, settled);
  }
  return null;
}

function isThenable(value: unknown): value is Promise<PsRow | null> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

/** Apply the caller's identity checks to a sample. */
function judge(sample: Sample, options: ProbeOptions): ProcessState {
  if (options.expect && sample.comm !== '' && !options.expect.test(sample.comm)) return 'gone';
  if (options.startedAt != null && sample.startedMs != null) {
    const raw = options.startedAt;
    const claimed = typeof raw === 'number' ? raw
      : raw instanceof Date ? raw.getTime()
      : Date.parse(String(raw));
    if (Number.isFinite(claimed) && Math.abs(claimed - sample.startedMs) > START_SLACK_MS) return 'gone';
  }
  return sample.state;
}

/**
 * The awaited probe — the accurate one, for any caller that can afford to wait.
 *
 * `processState` below is the same question asked without blocking, and answers
 * from the cache this fills. Prefer this one wherever the call site is already
 * asynchronous; the synchronous one exists because dozens of call sites are not.
 */
export async function processStateAsync(pid: number, options: ProbeOptions = {}): Promise<ProcessState> {
  if (!Number.isInteger(pid) || pid <= 0) return 'gone';
  if (!exists(pid)) return 'gone';

  const now = Date.now();
  const hit = cache.get(pid);
  if (hit && now - hit.at < CACHE_MS) return judge(hit, options);

  const immediate = refresh(pid, now);
  const sample = immediate ?? (await (inflight.get(pid) ?? Promise.resolve(null)));
  // `kill(0)` says it is there; `ps` could not say more. Existence is the most
  // the probe can prove, and `running` is the safe direction for it.
  return sample ? judge(sample, options) : 'running';
}

/**
 * Warm the sample cache for a set of pids, concurrently, without blocking.
 *
 * The read path's companion to `processState`: a caller that is about to make
 * many synchronous probes can await this first and have every one of them hit
 * a fresh sample. Never throws — a pid that cannot be read is simply not warmed.
 */
export async function warmPids(pids: Iterable<number>): Promise<void> {
  const unique = [...new Set([...pids].filter((pid) => Number.isInteger(pid) && pid > 0))];
  await Promise.all(unique.map((pid) => processStateAsync(pid).catch(() => 'gone' as const)));
}

/**
 * What is this pid doing?
 *
 * The single implementation. `state.ts:pidAlive` and
 * `registry.ts:claudePidAlive` are re-exports built on it, and nothing else in
 * `server/` may call `kill(pid, 0)` or shell `ps` — `test/invariants.test.ts`
 * greps for both.
 */
export function processState(pid: number, options: ProbeOptions = {}): ProcessState {
  if (!Number.isInteger(pid) || pid <= 0) return 'gone';
  if (!exists(pid)) return 'gone';

  const now = Date.now();
  const hit = cache.get(pid);
  if (hit && now - hit.at < CACHE_MS) return judge(hit, options);

  // Stale or missing: start a refresh and answer from what is already known.
  // The previous sample is used even past its TTL — a five-second-old reading
  // of a process that still exists is a far better answer than the `kill(0)`
  // floor, and the fresh one lands before the next read.
  const immediate = refresh(pid, now);
  const sample = immediate ?? hit;
  // `kill(0)` says it is there; `ps` could not say more. Existence is the most
  // the probe can prove, and `running` is the safe direction for it.
  if (!sample) return 'running';
  return judge(sample, options);
}

/**
 * Is there a process to talk to at all?
 *
 * `stopped` counts: a stopped process is very much still there, still holds
 * its files and its session, and must never be treated as free. Callers that
 * need the difference — and every caller deciding whether to WAIT for one does
 * — ask `processState` directly.
 */
export function pidAlive(pid: number, options?: ProbeOptions): boolean {
  return processState(pid, options) !== 'gone';
}

/**
 * Is this process still holding WORK — a session that could still be editing
 * the tree, or one that could be made to?
 *
 * The other half of `pidAlive`, and the difference is the zombie. Every caller
 * asking "is a lane still in flight" wrote `processState(...) !== 'gone'`,
 * which answers a question about EXISTENCE, and a `Z` process very much still
 * exists: it has exited, its files are closed, its work is over, and all that
 * is outstanding is its parent's `wait()`. Counting that as work in flight is
 * how a phase whose session had already exited went on reading `running` — the
 * claim outliving the fact, which is the whole of B2.
 *
 *   `running`  yes — it is scheduled and working.
 *   `stopped`  yes — it is NOT scheduled, but it still holds its files, its
 *              cwd and its session id, and a single `kill -CONT` puts it back
 *              to work. Settling its record would contradict the `kill -CONT`
 *              advice the console prints on the same screen (`orphanAdvice`).
 *   `zombie`   NO — it has exited. Nothing it holds can change again.
 *   `gone`     no.
 *
 * Deliberately NOT the probe used to decide whether something can be SIGNALLED
 * (`signals.ts`) or whether a pid exists at all (`pidAlive`): a zombie is still
 * a member of its process group and its reaping is still someone's job. Those
 * two ask about existence and must keep asking about existence.
 */
export function pidHoldsWork(pid: number, options?: ProbeOptions): boolean {
  const state = processState(pid, options);
  return state === 'running' || state === 'stopped';
}

/**
 * What this process is costing, from the sample the state probe already took.
 *
 * Never shells anything of its own — it reads the cache `processState` fills,
 * so asking is free and asking about a pid nobody has probed answers `null`
 * rather than starting a subprocess on a read path. "I have not looked" and
 * "it is using nothing" are different facts and this returns the first as
 * absence, which is the same posture the rest of this file takes.
 */
export function processResources(pid: number): ProcessResources | null {
  const sample = cache.get(pid);
  if (!sample || sample.rss === undefined || sample.pcpu === undefined) return null;
  return { rssKb: sample.rss, cpuPct: sample.pcpu };
}

/** The CLI's own processes, for a probe that only knows what it started. */
export const CLAUDE_COMM = /claude|node|bun/i;

/** Drop cached samples (tests, and any caller that has just signalled a pid). */
export function forgetPid(pid?: number): void {
  if (pid == null) { cache.clear(); inflight.clear(); return; }
  cache.delete(pid);
  inflight.delete(pid);
}
