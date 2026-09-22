/**
 * The engine wrapper.
 *
 * `scripts/phase-graph.sh` is the only source of truth for done / ready /
 * waiting, session batches, boot prompts, QA regime and lint — the console
 * never recomputes any of that in JavaScript. Everything here shells out to
 * the skill's own scripts and reports what they said.
 *
 * Runs are capped (8 concurrent), time-limited (45 s — see TIMEOUT_MS, whose
 * own comment says why that ceiling) and cached per plan revision; the file
 * watcher bumps a plan's revision, which invalidates every cached answer for it
 * at once. `--git` is never passed, so nothing here can commit or push.
 *
 * The subprocess environment is built by DENIAL, not by inheritance — see
 * `scriptEnv`. A `PE_*`/`PHASE_*` variable the console happened to inherit is
 * never an answer about the plan in front of it.
 */

import { join } from 'node:path';

import { BOARD_BUCKETS } from '../shared/status-vocab.js';
import { QA_MODES } from '../shared/plan-vocab.js';
import type { McpPolicy } from '../shared/run-lifecycle.js';
import { parseDecisionsTsv } from '../shared/decisions-model.js';
import type { DecisionRow } from '../shared/decisions-model.js';
import { LANDING_STATES } from '../shared/landing-model.js';
import type { LandingRow } from './parse/folder.ts';
import { NOTE_KINDS, type Note } from './parse/notes.ts';
import { shell } from './shell.ts';
import { envCarrier } from './trace.ts';

export type EngineResult = {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
  /** The run was killed by the timeout — a non-zero code here means nothing. */
  timedOut: boolean;
  /**
   * The run was killed because it wrote more than `maxBuffer`, which is a
   * different fact from a timeout: the script ANSWERED, at length, and we threw
   * the answer away. Kept separate because `timedOut` is read as "proves
   * nothing" while an overflow proves the opposite — there was plenty to say.
   */
  overflow?: boolean;
};

export type EngineOptions = {
  scriptsDir: string;
  root: string;
  /**
   * The MCP servers this console has registered, for F15.
   *
   * The engine cannot read the registry — it is a JSON file under the
   * instance's state dir and the scripts target bash 3.2 — so it is TOLD, via
   * `PE_MCP_SERVERS`. Absent (not empty: absent) means "no console here" and
   * disables the check, which is what a bare skill install gets.
   *
   * It joins the cache key because it changes the answer: a plan that lints
   * clean against one registry warns against another.
   */
  mcpServers?: string[];
  /**
   * The console's RUN-LEVEL default MCP policy, for F15 — the same "told, not
   * asked" arrangement as `mcpServers`, and for the same reason.
   *
   * F15 warns that a plan names a server this machine has not registered, and
   * it names the CONSEQUENCE. The consequence depends on the policy, and the
   * policy has three levels: the phase's bullet, the plan's §Session budget
   * line, then the run's setting. bash can read the first two out of the plan
   * in front of it and has no way at all to know the third — so a console set
   * to `require` against a plan that says nothing was told "phases will run
   * without them and report it", while what would actually happen is every
   * phase parking at boarding. A lint that describes behaviour the console does
   * not have is worse than no lint.
   *
   * Absent means "no console here" and the script falls back to its own
   * default, exactly as `PE_MCP_SERVERS` absent turns F15 off: `validate.sh`
   * run by hand has no console default to state, and inventing one would be the
   * same lie in the other direction.
   *
   * It joins the cache key for the same reason `mcpServers` does — it changes
   * the answer.
   */
  mcpPolicy?: McpPolicy;
  /**
   * The credential ids this console currently HOLDS and the account ids it has
   * REGISTERED, for the F15 family's other two advisories (phase 11, ZTD-4 /
   * ACT-9): a plan naming a credential nobody holds, or an account nobody
   * registered, is told so at plan time and still lints `OK`. The same "told,
   * not asked" arrangement as `mcpServers` — bash cannot probe `gh` on every
   * lint and must not read the registry — and the same absent/empty rule:
   * absent turns the check off (`validate.sh` by hand), set-but-empty is a
   * real answer (a console holding nothing warns on everything named). Both
   * join the cache key: they change the answer.
   */
  credentials?: string[];
  accounts?: string[];
};

// validate.sh walks every phase of a plan, which is 13 s on a 31-phase graph;
// phase-graph.sh answers in a fifth of a second. The ceiling has to clear the
// slow one, or a big plan silently reports a lint failure it does not have.
const TIMEOUT_MS = 45_000;
const MAX_CONCURRENT = 8;

let active = 0;
const queue: (() => void)[] = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise((release) => queue.push(() => { active++; release(); }));
}

function release(): void {
  active--;
  queue.shift()?.();
}

/**
 * Console-vocabulary variables an engine subprocess must never INHERIT.
 *
 * `PE_*` and `PHASE_*` are the words the scripts themselves speak, so whatever
 * launched the console gets a vote on the engine's answers the moment they are
 * spread through: a `PE_MCP_SERVERS` inherited from a runner's shell decides
 * F15 for a plan that never asked, and an inherited `PHASE_EXEC_GATES=1` turns
 * the runner's deliberate, audited opt-in into the default — `--gate-status`
 * would EXECUTE a plan's `cmd` gate on an ordinary display read.
 *
 * The list is a PREFIX rule rather than the four names known to matter today,
 * because the failure is silent and the next `PE_` variable to be added would
 * inherit the bug for free. Anything the engine legitimately needs is passed
 * deliberately, below or through `extra.env`; the opt-in still works because it
 * is applied AFTER this filter, which is the whole point of the distinction.
 *
 * `CLAUDE_CODE_SESSION_ID` rides along for the same reason: the console's own
 * session is never the session a script it shells should claim to be.
 */
const NEVER_INHERIT = /^(?:PE_|PHASE_)/;
const NEVER_INHERIT_EXACT = new Set(['CLAUDE_CODE_SESSION_ID']);

/**
 * The environment an engine script runs in — built by denial, then by
 * deliberate statement. Exported so a test can assert the absence directly
 * rather than by inference from a subprocess's behaviour.
 */
export function scriptEnv(
  opts: EngineOptions,
  extra?: { env?: Record<string, string> },
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (NEVER_INHERIT.test(name) || NEVER_INHERIT_EXACT.has(name)) continue;
    env[name] = value;
  }
  env.DOCS_ROOT = opts.root;
  env.NO_COLOR = '1';
  env.TERM = 'dumb';
  // Set-but-empty is a real answer (a console with nothing registered); absent
  // turns F15 off entirely. So this is assigned conditionally rather than
  // defaulted to '' — and after the filter above, `absent` now genuinely means
  // "this console said nothing", not "something upstream did".
  if (opts.mcpServers) env.PE_MCP_SERVERS = opts.mcpServers.join(' ');
  // A DELIBERATE STATEMENT, like the line above it — never an inheritance. The
  // filter at the top of this function denies every `PE_*` the console happened
  // to be started with, which is what makes an assignment here mean "this
  // console said so" rather than "something upstream did".
  if (opts.mcpPolicy) env.PE_MCP_POLICY = opts.mcpPolicy;
  // The credentials held and the accounts registered — the F15 family's other
  // two inputs, stated the same way (phase 11).
  if (opts.credentials) env.PE_CREDENTIALS = opts.credentials.join(' ');
  if (opts.accounts) env.PE_ACCOUNTS = opts.accounts.join(' ');
  // AFTER the denial filter, and for the same reason the four lines above are
  // assignments rather than inheritances: the filter denies every `PE_*` this
  // console happened to be STARTED with, and two of these begin `PE_`. Stating
  // them here is what makes them mean "this console said so". The cache key is
  // built in `run()` from script, slug, revision, args and root — never from
  // the env — so a span cannot turn every engine call into a cache miss.
  return { ...env, ...(extra?.env ?? {}), ...envCarrier() };
}

/* ------------------------------------------------------------------ *
 * The result cache — single-flight, bounded by age and by size
 * ------------------------------------------------------------------ */

/**
 * The cache holds the **promise**, not the result, and that is what makes it a
 * single-flight.
 *
 * Ten browsers opening one uncached plan at the same moment used to miss the
 * cache ten times, because the entry was only written once the first run had
 * FINISHED: every one of them looked, saw nothing, and spawned its own
 * `phase-graph.sh`. Storing the in-flight promise the moment the run starts
 * collapses that to one process the other nine await. The semaphore above
 * bounded the damage at eight concurrent; it never removed the duplicate work.
 *
 * A REJECTED promise is evicted rather than kept. `run` resolves for every
 * outcome the engine itself can produce — a non-zero exit is a result, not a
 * throw — so a rejection here is something structural, and caching it would
 * make one bad moment permanent for the whole of that plan's revision.
 */
type CacheEntry = {
  /** When the entry was created — the age half of eviction. */
  at: number;
  /** Bytes of stdout+stderr, once known. An in-flight entry counts as 0. */
  bytes: number;
  promise: Promise<EngineResult>;
};

/**
 * Eviction limits.
 *
 * One entry can hold up to `maxBuffer` (8 MB) of stdout, and before this the
 * map was only ever emptied by an explicit `invalidate()`: a console left open
 * for a week accumulated an entry per (script, slug, revision, args) tuple it
 * had ever been asked for, and nothing dropped a plan nobody had looked at
 * since Tuesday. Both bounds are needed — a size cap alone keeps a stale answer
 * for a plan whose revision never moves, and an age cap alone cannot stop a
 * hundred 8 MB lints that all arrive inside the TTL.
 */
export type EngineCacheLimits = { ttlMs: number; maxBytes: number; maxEntries: number };

const DEFAULT_LIMITS: EngineCacheLimits = {
  // Comfortably longer than one page's own request wave, and far shorter than
  // the "open for a week" case. A plan whose files change is invalidated by
  // revision long before this matters; the TTL is for the ones that do not.
  ttlMs: 10 * 60_000,
  // 8 MB is one entry's ceiling, so this is "a few of the worst case" rather
  // than a count of plans.
  maxBytes: 48 * 1024 * 1024,
  maxEntries: 512,
};

let limits: EngineCacheLimits = { ...DEFAULT_LIMITS };

/**
 * Test seam: narrow the limits so a suite can overfill the cache without
 * producing 48 MB of engine output. Returns the previous limits, to restore.
 */
export function setEngineCacheLimits(next: Partial<EngineCacheLimits> | null): EngineCacheLimits {
  const previous = limits;
  limits = next ? { ...limits, ...next } : { ...DEFAULT_LIMITS };
  return previous;
}

/** Insertion-ordered, which is what makes the sweep below oldest-first. */
const cache = new Map<string, CacheEntry>();
let cachedBytes = 0;

function drop(key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  cachedBytes -= entry.bytes;
  cache.delete(key);
}

/** Evict by AGE first, then by size and by count — oldest insertion first. */
function evict(now: number): void {
  for (const [key, entry] of [...cache]) {
    if (now - entry.at >= limits.ttlMs) drop(key);
  }
  // `cache.keys()` yields in insertion order and an entry is never re-inserted
  // on a hit, so the head of the map is always the oldest thing in it.
  while (cache.size > limits.maxEntries || cachedBytes > limits.maxBytes) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    drop(oldest.value);
  }
}

/** What the cache is holding right now — for the eviction test. */
export function engineCacheStats(): { entries: number; bytes: number; limits: EngineCacheLimits } {
  return { entries: cache.size, bytes: cachedBytes, limits: { ...limits } };
}

export function invalidate(slug?: string): void {
  if (!slug) { cache.clear(); cachedBytes = 0; return; }
  for (const key of [...cache.keys()]) if (key.includes(`\u0000${slug}\u0000`)) drop(key);
}

export async function run(
  opts: EngineOptions,
  script: string,
  args: string[],
  cacheKey?: { slug: string; revision: number },
  extra?: { env?: Record<string, string> },
): Promise<EngineResult> {
  if (args.includes('--git')) throw new Error('refusing to run a script with --git');

  // An env-bearing run (e.g. the runner's PHASE_EXEC_GATES=1 gate check) never
  // shares the cache with plain runs — the answer can legitimately differ.
  const key = cacheKey && !extra?.env
    // The registry joins the key because it changes the answer: a plan that
    // lints clean against one set of registered servers warns against another.
    ? `${script}\u0000${cacheKey.slug}\u0000${cacheKey.revision}\u0000${args.join(' ')}`
      + (opts.mcpServers ? `\u0000mcp:${[...opts.mcpServers].sort().join(',')}` : '')
      + (opts.mcpPolicy ? `\u0000mcppolicy:${opts.mcpPolicy}` : '')
      + (opts.credentials ? `\u0000cred:${[...opts.credentials].sort().join(',')}` : '')
      + (opts.accounts ? `\u0000acct:${[...opts.accounts].sort().join(',')}` : '')
      // The ROOT joins the key for the same reason the registry does: it changes the
      // answer. `<slug>` at `<revision>` under one source directory is a different plan
      // from the same name under another, and `invalidate(slug)` cannot help — nothing
      // about the plan changed, only which tree is being asked about. Appended AFTER the
      // args so `invalidate`'s `\u0000<slug>\u0000` match still holds.
      + `\u0000root:${opts.root}`
    : null;
  const now = Date.now();
  if (key) {
    const hit = cache.get(key);
    // The in-flight promise IS the hit. Everything else about this function is
    // unchanged; what moved is the moment the entry appears.
    //
    // A hit is checked for age on its own rather than by sweeping the map: a
    // warm console serves these constantly, and a full sweep per read would put
    // the eviction cost on the path this whole change exists to make cheap.
    // The sweep runs on INSERT, which is the only moment the map can grow.
    if (hit && now - hit.at < limits.ttlMs) return hit.promise;
    if (hit) drop(key);
  }

  const promise = spawn(opts, script, args, extra);
  if (key) {
    const entry: CacheEntry = { at: now, bytes: 0, promise };
    cache.set(key, entry);
    evict(now);
    promise.then(
      (result) => {
        // Only account for the entry that is still ours: an `invalidate()` (or
        // an eviction) between the spawn and the resolve has already subtracted
        // this entry's bytes, and adding to `cachedBytes` afterwards would leak
        // the counter upward until the cache evicted itself empty.
        if (cache.get(key) !== entry) return;
        entry.bytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
        cachedBytes += entry.bytes;
        evict(Date.now());
      },
      () => { if (cache.get(key) === entry) drop(key); },
    );
  }
  return promise;
}

/** One engine subprocess, from `acquire()` to `release()`. */
async function spawn(
  opts: EngineOptions,
  script: string,
  args: string[],
  extra?: { env?: Record<string, string> },
): Promise<EngineResult> {
  await acquire();
  try {
    const run = await shell('bash', [join(opts.scriptsDir, script), ...args], {
      channel: 'engine',
      intent: script,
      timeout: TIMEOUT_MS,
      cwd: opts.root,
      // `scriptEnv` has already applied the denial filter; the seam's trace
      // carrier is spread AFTER it, so the four ids reach the script even
      // though two of them begin `PE_`. The cache key is computed in `run()`
      // and is untouched by any of this.
      env: scriptEnv(opts, extra) as NodeJS.ProcessEnv,
      // `head`: every reader below parses this output line by line.
      capture: { keep: 8 * 1024 * 1024, mode: 'head' },
      // A non-zero exit is how the engine says `LINT FAIL`, `--closed`, or
      // "this gate is blocked". Every one of them is read as a value.
      expectFailure: true,
    });
    // An overflow is NOT a timeout, and the difference decides the verdict: a
    // killed-at-45 s run proves nothing, while a run that overran 8 MB of
    // output proves there was a great deal to report. Reporting the second as
    // the first turned the loudest possible lint failure into `ok: true`.
    // Under the seam the two are separate facts rather than one `killed` flag
    // that had to be disambiguated by an error code string.
    return {
      code: run.code ?? 1,
      stdout: run.stdout,
      stderr: run.stderr,
      ms: run.ms,
      timedOut: run.timedOut,
      overflow: run.truncatedBytes > 0,
    };
  } finally {
    release();
  }
}

/* ------------------------------------------------------------------ *
 * Typed readings of the machine modes
 * ------------------------------------------------------------------ */

/**
 * The five board buckets `phase-graph.sh --memory-block` emits, as a type.
 * Members come from `shared/status-vocab.js`'s `BOARD_BUCKETS`, which is the
 * one place they are written down; the parser below accepts exactly these.
 */
export type PhaseState = (typeof BOARD_BUCKETS)[number];

export type Board = {
  /** False when the plan has no parsable `## Phase graph` — a document, not a plan. */
  phased: boolean;
  error?: string;
  states: Record<number, PhaseState>;
  done: number[];
  inProgress: number[];
  stuck: number[];
  ready: number[];
  waiting: number[];
  /**
   * Per waiting phase, the dependencies that are NOT yet satisfied. The board's
   * five buckets say a phase waits; this says on what — the difference between
   * "waiting on work that is about to happen" and "waiting for ever".
   */
  blockedBy: Record<number, number[]>;
  /**
   * Per BLOCKING phase, the QA verdict that is holding it back (`fail`,
   * `pending`, `none`, …). Keyed by the phase whose verdict is the problem, not
   * by the phase it blocks — a single failed verdict usually holds several.
   */
  qa: Record<number, string>;
};

const EMPTY_BOARD: Board = {
  phased: false, states: {}, done: [], inProgress: [], stuck: [], ready: [], waiting: [],
  blockedBy: {}, qa: {},
};

function numbers(csv: string): number[] {
  return csv.split(',').map((s) => Number.parseInt(s.trim(), 10)).filter(Number.isFinite);
}

/**
 * One `blocked:` entry: `4<-2(not-done),3(qa:pending)`.
 *
 * Parsed defensively and independently per entry — this line is additive, and a
 * board that cannot read it must still be a board. Anything unparsable is
 * dropped rather than thrown: losing the reason costs a worse message, losing
 * the board costs the run.
 */
function readBlocked(spec: string, blockedBy: Record<number, number[]>, qa: Record<number, string>): void {
  for (const entry of spec.trim().split(/\s+/).filter(Boolean)) {
    const [left, right] = entry.split('<-');
    const phase = Number.parseInt((left ?? '').trim(), 10);
    if (!Number.isFinite(phase) || !right) continue;
    const deps: number[] = [];
    for (const part of right.split(',')) {
      const m = /^\s*(\d+)\s*(?:\(([^)]*)\))?\s*$/.exec(part);
      if (!m) continue;
      const dep = Number.parseInt(m[1], 10);
      if (!Number.isFinite(dep)) continue;
      deps.push(dep);
      // `qa:<verdict>` is the only reason that names a fact about the DEP
      // rather than about the board; `not-done` is already the board's word.
      const reason = m[2] ?? '';
      if (reason.startsWith('qa:')) qa[dep] = reason.slice(3);
    }
    if (deps.length) blockedBy[phase] = deps;
  }
}

/**
 * `--memory-block` is the whole live classification in one run:
 *   done: 1, 2 / in-progress: 3 / stuck: 4 / ready: 5 / waiting: 6
 *   blocked: 2<-1(qa:fail) 4<-2(not-done),3(qa:pending)
 */
export function readMemoryBlock(result: EngineResult): Board {
  if (result.timedOut) return { ...EMPTY_BOARD, error: 'the engine timed out reading this plan' };
  if (result.code !== 0) {
    return { ...EMPTY_BOARD, error: (result.stderr.split('\n')[0] || 'engine error').replace(/^ERROR:\s*/, '') };
  }
  const board: Board = {
    ...EMPTY_BOARD, phased: true, states: {}, done: [], inProgress: [], stuck: [], ready: [], waiting: [],
    blockedBy: {}, qa: {},
  };
  for (const line of result.stdout.split('\n')) {
    const blocked = /^blocked:\s*(.*)$/.exec(line.trim());
    if (blocked) { readBlocked(blocked[1], board.blockedBy, board.qa); continue; }
    const m = /^(done|in-progress|stuck|ready|waiting):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const phases = numbers(m[2]);
    const bucket = m[1] as PhaseState;
    for (const p of phases) board.states[p] = bucket;
    if (bucket === 'done') board.done = phases;
    else if (bucket === 'in-progress') board.inProgress = phases;
    else if (bucket === 'stuck') board.stuck = phases;
    else if (bucket === 'ready') board.ready = phases;
    else board.waiting = phases;
  }
  return board;
}

/**
 * `unknown` is a FOURTH answer, and the reason this type is not three words.
 *
 * Every other reader in this file already guards the two ways a script can fail
 * to answer — `readMemoryBlock` returns an `error` board, `readLint` refuses to
 * call a killed run a failure, `readGateStatus` clears only on code 0. This one
 * looked at stdout alone, so a timeout, a crash, or a plan the engine could not
 * parse all came back as the confident, load-bearing word `off`: QA does not
 * gate here, dependents may proceed, no reviewer is owed. That is the most
 * permissive answer in the vocabulary, produced by the absence of an answer.
 */
export type QaMode = { mode: (typeof QA_MODES)[number]; reason?: string; error?: string };

export function readQaMode(result: EngineResult): QaMode {
  if (result.timedOut) {
    return { mode: 'unknown', error: 'the engine timed out reading this plan’s QA regime' };
  }
  if (result.code !== 0) {
    const why = (result.stderr.split('\n')[0] || 'engine error').replace(/^ERROR:\s*/, '');
    return { mode: 'unknown', error: why };
  }
  const line = result.stdout.trim();
  const m = /^(off|on|waived)(?:\s*\((.*)\))?$/.exec(line);
  // A zero exit that said nothing we recognise is still not `off` — the engine
  // answers this mode with one of three words and no others.
  if (!m) return { mode: 'unknown', error: line ? `unrecognised QA regime: ${line}` : 'the engine said nothing' };
  return { mode: m[1] as QaMode['mode'], reason: m[2] };
}

/**
 * `--decisions [N]` — one TSV row per decision that holds, in `DECISION_KEYS`
 * order (see `shared/decisions-model.js` for the merge the engine performs).
 * A failed or timed-out read is an EMPTY manifest with an `error`, never a
 * silent `[]`: phase 11's prelude must not read "nothing outstanding" out of
 * an engine that could not answer.
 */
export type Decisions = { rows: DecisionRow[]; error?: string };

export function readDecisions(result: EngineResult, phase: number | null = null): Decisions {
  if (result.timedOut) return { rows: [], error: 'the engine timed out reading this plan’s decisions' };
  if (result.code !== 0) {
    const why = (result.stderr.split('\n')[0] || 'engine error').replace(/^ERROR:\s*/, '');
    return { rows: [], error: why };
  }
  return { rows: parseDecisionsTsv(result.stdout, phase) };
}

/**
 * `--wait-budget [N]` — `minutes<TAB>phase|plan`, or undefined for silence (the
 * console's own default then applies) and for an engine that could not answer.
 */
export function readWaitBudget(result: EngineResult): { minutes: number; source: 'phase' | 'plan' } | undefined {
  if (result.timedOut || result.code !== 0) return undefined;
  const [minutesText, source] = result.stdout.trim().split('\t');
  const minutes = Number(minutesText);
  if (!Number.isSafeInteger(minutes) || minutes <= 0) return undefined;
  return source === 'phase' || source === 'plan' ? { minutes, source } : undefined;
}

/** `--waits-on N` — the refs the phase's `Waits on:` bullet names, one per line; empty when none. */
export function readWaitsOn(result: EngineResult): string[] {
  if (result.timedOut || result.code !== 0) return [];
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** `--credentials [N]` — the csv the engine prints, as ids; empty when it names none. */
export function readCredentials(result: EngineResult): string[] {
  if (result.timedOut || result.code !== 0) return [];
  return result.stdout.trim().split(',').map((s) => s.trim()).filter(Boolean);
}

/** A resolved 5.1.0 directive: the word, and which level of the plan said it. */
export type Directive = { value: string; source: 'phase' | 'plan' | 'default' };

/**
 * `--land [N]` / `--gitlink [N]` / `--isolation [N]` / `--issues [N]` /
 * `--conflict-policy` / `--messaging` / `--base-branch` — one
 * `value<TAB>source` line, or nothing.
 *
 * `undefined` on a failed read AND on an empty one, which is the same answer
 * on purpose: both mean "the engine did not tell me", and the caller's
 * fallback is its own default either way. That is honest here, unlike
 * `readDecisions`, because these directives HAVE defaults — there is nothing a
 * caller could do differently with the distinction, and inventing an `error`
 * field nobody branches on is how a shape that looks careful stops being read.
 * `--isolation` legitimately prints nothing (the run decides), so a silent
 * `undefined` is the expected answer there rather than a degraded one.
 */
export function readDirective(result: EngineResult): Directive | undefined {
  if (result.timedOut || result.code !== 0) return undefined;
  const [value, source] = result.stdout.trim().split('\t');
  if (!value) return undefined;
  return source === 'phase' || source === 'plan' || source === 'default'
    ? { value, source }
    : { value, source: 'default' };
}

/** `--land [N]`, named for its caller — the same read, so the shape cannot drift. */
export const readLand = readDirective;
/** `--issues [N]`. */
export const readIssues = readDirective;

/**
 * `--landing N` — the landing LEDGER's rows for one phase, as TSV in
 * `LANDING_COLUMNS` order.
 *
 * An empty array from a SUCCESSFUL read is the load-bearing answer here: it is
 * what "this phase has not landed" looks like, and it is what a `landed N`
 * gate blocks on. A failed read returns the same empty array rather than an
 * error object because the gate is evaluated by the engine itself — this
 * reader feeds display, and a display that invents rows is worse than one that
 * shows none.
 */
export function readLanding(result: EngineResult): LandingRow[] {
  if (result.timedOut || result.code !== 0) return [];
  const out: LandingRow[] = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const cells = line.split('\t');
    const phase = Number(cells[0]);
    if (!Number.isInteger(phase)) continue;
    const at = (i: number) => (cells[i] ?? '').trim().replace(/^-$/, '');
    const state = at(2).toLowerCase();
    out.push({
      phase,
      repo: at(1),
      state: (LANDING_STATES as readonly string[]).includes(state) ? (state as LandingRow['state']) : 'unknown',
      policy: at(3),
      ref: at(4),
      sha: at(5),
      pr: at(6),
      by: at(7),
      recorded: at(8),
      note: at(9),
    });
  }
  return out;
}

/**
 * `--notes N` — `source<TAB>kind<TAB>id<TAB>at<TAB>text` per line.
 *
 * All three sources, in the order the phase should read them: urgent mail
 * first, then oldest to newest, bounded, with a `trailer` row when the bound
 * dropped anything. The row type is `parse/notes.ts`'s, which is the JS twin
 * of this arm — `viewer/test/notes-boot-parity.test.ts` holds the two to each
 * other, so there is exactly one shape and one order in the system.
 */
export function readNotes(result: EngineResult): Note[] {
  if (result.timedOut || result.code !== 0) return [];
  return result.stdout.split('\n')
    .map((line) => line.split('\t'))
    .filter((cells) => cells.length >= 5 && cells[4].trim())
    .map((cells) => ({
      source: cells[0].trim(),
      kind: (NOTE_KINDS as readonly string[]).includes(cells[1].trim())
        ? (cells[1].trim() as Note['kind'])
        : 'handoff',
      id: cells[2].trim(),
      at: cells[3].trim(),
      text: cells.slice(4).join('\t').trim(),
    }));
}

export type SessionGroup = {
  index: number;
  phases: number[];
  kind: 'solo' | 'batch';
  weight?: string;
  gated: boolean;
  note?: string;
};

export type SessionPlan = {
  budget?: string;
  excluded: number[];
  groups: SessionGroup[];
  raw: string;
};

/** Parse `--session-plan` output into groups. */
export function readSessionPlan(result: EngineResult): SessionPlan {
  const raw = result.stdout;
  const plan: SessionPlan = { excluded: [], groups: [], raw };
  plan.budget = /budget ~([^\s·)]+)/i.exec(raw)?.[1];

  const excluded = /already done, excluded:\s*([^)]*)\)/i.exec(raw)?.[1];
  if (excluded) plan.excluded = numbers(excluded);

  for (const line of raw.split('\n')) {
    const m = /^\s*Session (\d+)\s+(batch|solo)\s*\(~([^)]*)\):\s*(.*)$/.exec(line);
    if (!m) continue;
    const body = m[4];
    // The group's MEMBERS end where the flags begin.
    //
    // phase-graph.sh builds each line as `<members><flags>`, and every flag it
    // appends starts with two spaces and a glyph (`  ⚠ waiting on: 2`,
    // `  🔒 GATED — …`, `  ⚠ over budget — split`). Sweeping the whole line for
    // digits therefore read the UNMET DEPENDENCY numbers as members of the
    // batch: a solo session for phase 3 that is waiting on phase 2 came back as
    // `phases: [3, 2]`, and the route map drew its session line straight through
    // phase 2 — a bystander that is not in the batch at all, which is the exact
    // failure the dag component's own comment says it exists to avoid.
    const head = body.split(/\s{2}[⚠🔒]/)[0];
    const phases = [...head.matchAll(/(?:Phase\s*)?(\d+)/g)]
      .map((x) => Number(x[1]))
      .filter((n, i, arr) => arr.indexOf(n) === i);
    // `gated` and `note` are properties of the FLAGS, so they keep reading the
    // whole line — the em-dash they look for only ever appears in a flag.
    plan.groups.push({
      index: Number(m[1]),
      kind: m[2] as 'solo' | 'batch',
      weight: m[3],
      phases,
      gated: /GATED/.test(body),
      note: /—\s*(.*)$/.exec(body)?.[1]?.trim(),
    });
  }
  return plan;
}

export type LintResult = { ok: boolean; issues: string[]; summary: string; timedOut: boolean };

export function readLint(result: EngineResult): LintResult {
  const text = `${result.stdout}\n${result.stderr}`.trim();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  // The LAST verdict line, not the first: `validate.sh` prints the plan's
  // `LINT OK` before it reads the handoffs and its `VALIDATE FAIL` after, and
  // a halt that quoted the first told the operator a parked run was fine
  // (many-plans-one-repo phase 17, live rehearsal 4).
  const verdicts = lines.filter((l) => /^(LINT|VALIDATE)\s+(OK|FAIL)/.test(l));
  const summary = verdicts.at(-1) ?? lines.at(-1) ?? '';
  // An overflow is NOT a timeout, and the difference decides the verdict: a
  // killed-at-45 s run proves nothing, while a run that overran 8 MB of output
  // proves there was a great deal to report. Reporting the second as the first
  // turned the loudest possible lint failure into `ok: true`.
  if (result.overflow) {
    return {
      ok: false,
      issues: lines.filter((l) => !/^(LINT|VALIDATE)\s+(OK|FAIL)/.test(l)),
      summary: 'validation produced more output than the console can hold — run scripts/validate.sh yourself',
      timedOut: false,
    };
  }
  return {
    // A killed run proves nothing either way — never report it as a failure.
    ok: result.timedOut ? true : result.code === 0,
    issues: result.timedOut ? [] : lines.filter((l) => !/^(LINT|VALIDATE)\s+(OK|FAIL)/.test(l)),
    summary: result.timedOut ? 'validation timed out — run scripts/validate.sh yourself' : summary,
    timedOut: result.timedOut,
  };
}

export type GateStatus = { clear: boolean; kind: string; detail: string };

export function readGateStatus(result: EngineResult): GateStatus {
  const text = (result.stdout || result.stderr).trim();
  if (result.code === 0) {
    // Every clear verdict is `clear (<reason>)`, sometimes with a trailing
    // `: <cmd>`. Fold the reason into detail so `kind` stays a clean token —
    // `clear (cmd ok): true` used to leak the parenthetical into kind and the
    // phase page rendered it twice.
    const reason = /^clear\s*\(([^)]*)\)/.exec(text)?.[1];
    return { clear: true, kind: 'clear', detail: (reason ?? text).trim() };
  }
  const [kind, ...rest] = text.split(':');
  return { clear: false, kind: (kind || 'none').trim(), detail: rest.join(':').trim() || text };
}

/**
 * Boot prompts and the end-of-phase banner, exactly as the script printed
 * them — never rewritten. The only change is the trailing newline, dropped so
 * a pasted prompt does not carry a blank line into whatever receives it.
 */
export function readText(result: EngineResult): string {
  return (result.stdout || result.stderr).replace(/\s+$/, '');
}

/** The human board, kept for the "what the terminal shows" panel. */
export function readBoardText(result: EngineResult): string {
  return result.code === 0 ? result.stdout.replace(/\s+$/, '') : readText(result);
}
