/**
 * Token telemetry: what each API call of a session cost in CONTEXT, folded per
 * attempt (autopilot-token-drain phase 3).
 *
 * The runner used to know one number about a session's spend — the dollars the
 * CLI's `result` reports — and nothing about what drives it. Every call re-reads
 * the whole conversation, so a session at 900k context pays for 900k on each
 * tool call whatever that call does; run `deadaff9`'s phases peaked at
 * 471k–957k with nothing on any surface saying so, and a resume that rewrote a
 * 554k cache looked, from outside, exactly like one that read it warm.
 *
 * Pure and clock-free: `spawn.ts` folds the stream through it, the lane keeps
 * the newest totals, and the THRESHOLDS below are the one place the runner's
 * wrap-up and checkpoint read their numbers from.
 */
import { budgetClassOf, MODELS_ENV_FALLBACK, type ModelsEnv } from './models.ts';

/** One API call's `message.usage`, and the context it read (input + cache write + cache read). */
export type CallUsage = { input: number; cacheWrite: number; cacheRead: number; output: number; context: number };

/** A session's calls, folded. `lastContext` is the newest call's; the four token fields are sums. */
export type TokenCounters = {
  calls: number;
  lastContext: number;
  peakContext: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  rebuilds: number;
};

/*
 * A call REBUILT the cache when it wrote at least max(100k, half its context):
 * the prefix it could have read warm was written again. Measured on P8's resume
 * (554,419 of 564,547, then 621,999 of 632,127 thirty-six seconds after a warm
 * hit); the ordinary append of a working turn is a few thousand.
 */
export const CACHE_REBUILD_MIN_TOKENS = 100_000;
export const CACHE_REBUILD_FRACTION = 0.5;

/*
 * The context window a session runs in. `scripts/models.env` says which class a
 * model is in — `[1m]` and the big families get the 1M window, everything else
 * the 200k one — and these are what the classes are worth (the same split
 * `scripts/sizing.env`'s budgets are 0.2 × of).
 */
export const CONTEXT_WINDOW_1M = 1_000_000;
export const CONTEXT_WINDOW_DEFAULT = 200_000;

/*
 * At 0.6 × the window the session is told, once, to finish its step, commit,
 * hand off `in-progress` and declare `partial --reason context`. At 0.8 × the
 * console checkpoints the lane itself and boards the next attempt fresh — below
 * the CLI's own auto-compaction (~83 %), and past the point where every further
 * call costs most of a window.
 */
export const CONTEXT_WRAPUP_FRACTION = 0.6;
export const CONTEXT_CHECKPOINT_FRACTION = 0.8;

export type ContextStage = 'ok' | 'wrap-up' | 'checkpoint';

/**
 * One session's counters as the phase record keeps them (`PhaseRecord.tokens`,
 * newest last) and as `phase.tokens` journals them when the session ends.
 *
 * What Phase 4's resume gate reads: the context a session ended at, whether it
 * had continued a conversation, and when it ended — the idle clock starts there.
 * Every session of the phase is kept, `mode` telling the phase's own attempts
 * from its QA rounds, closeouts and repairs.
 */
export type TokenAttempt = TokenCounters & {
  /** The session ledger's word — `phase`, `qa`, `closeout`, `repair`, `resume`, `pr`, `review`. */
  mode: string;
  /** The phase attempt the session ran as, when it was one. */
  attempt?: number;
  sessionId: string | null;
  /** It continued a conversation (`--resume`). */
  resumed: boolean;
  model: string | null;
  /** The context window it was judged against; null when no model was known. */
  window: number | null;
  /** Status checks the poll-loop guard counted during it — the phase's own sessions only. */
  pollCalls?: number;
  pollDenied?: number;
  /**
   * The account it was spawned under (`default` for the machine login) — whose
   * prompt cache it wrote. Absent on counters written before phase 4.
   */
  account?: string;
  endedAt: string;
};

/** How many sessions a phase record keeps counters for; older ones stay in the journal. */
export const MAX_TOKEN_ATTEMPTS = 20;

/** A threshold the console acted on, on the record: which session, at what context, when. */
export type ContextMark = { sessionId: string | null; at: string; context: number; window: number; delivered?: boolean };

/** The newest `partial` declared for a phase, on the record: which session, why, when. */
export type PartialMark = { sessionId: string | null; reason: string | null; at: string };

/*
 * Whether a session is worth resuming (autopilot-token-drain phase 4). A resume
 * re-reads the whole conversation: warm, a cache hit; cold — the prompt cache
 * outlived (the usage shows a one-hour cache, so 55 minutes leaves the boarding
 * its margin) or the account paying is not the one that wrote it — the first
 * call writes all of it again. P8's resume after 3 h 55 m wrote 554,419; P3's
 * account-switch port wrote 824,343. Past RESUME_FRESH_MIN_CONTEXT a cold resume
 * costs more than a fresh boot (a 105–115k bootstrap) and the resume brief.
 */
export const RESUME_FRESH_MIN_CONTEXT = 250_000;
export const RESUME_CACHE_COLD_MS = 55 * 60_000;
/** A session that declared `partial` for one of these said itself that it is spent. */
export const RESUME_FRESH_PARTIAL_REASONS: readonly string[] = ['budget', 'context'];

export type ResumeChoice = 'resume' | 'fresh';
export type ResumePolicyReason =
  | 'context-checkpoint' | 'partial-budget' | 'partial-context' | 'account-changed' | 'cache-cold'
  | 'cache-warm' | 'small' | 'unmeasured';

/** The policy's answer, in the shape `phase.resume-policy` journals it. */
export type ResumePolicy = {
  choice: ResumeChoice;
  reason: ResumePolicyReason;
  /** The context the session last ended at — what a resume re-reads; null when never measured. */
  contextTokens: number | null;
  /** Since it last ended; null when never measured. */
  idleMs: number | null;
  accountChanged: boolean;
};

/** What the policy reads off a phase record. */
export type ResumeFacts = {
  tokens?: readonly TokenAttempt[];
  contextCheckpoint?: ContextMark;
  lastPartial?: PartialMark;
  sessionAccountId?: string;
};

/**
 * Resume `sessionId`, or board fresh with the resume brief? Fresh when the
 * console checkpointed that session, when it declared `partial --reason
 * budget|context`, or when it ended at ≥ RESUME_FRESH_MIN_CONTEXT and is cold or
 * under another account. `paying` is the account that would pay for the resume,
 * or null when the caller cannot say — the account is then not judged. A session
 * with no counters is resumed as it always was.
 */
export function resumePolicy(
  record: ResumeFacts, sessionId: string, opts: { now: number; paying: string | null },
): ResumePolicy {
  const entry = [...(record.tokens ?? [])].reverse().find((row) => row.sessionId === sessionId);
  const ended = entry ? Date.parse(entry.endedAt) : NaN;
  const idleMs = Number.isFinite(ended) ? Math.max(0, opts.now - ended) : null;
  const wrote = entry?.account ?? record.sessionAccountId ?? 'default';
  const accountChanged = opts.paying !== null && wrote !== opts.paying;
  const measured = { contextTokens: entry?.lastContext ?? null, idleMs, accountChanged };
  if (record.contextCheckpoint?.sessionId === sessionId) {
    return { choice: 'fresh', reason: 'context-checkpoint', ...measured, contextTokens: entry?.lastContext ?? record.contextCheckpoint.context };
  }
  const partial = record.lastPartial;
  if (partial?.sessionId === sessionId && partial.reason && RESUME_FRESH_PARTIAL_REASONS.includes(partial.reason)) {
    return { choice: 'fresh', reason: partial.reason === 'budget' ? 'partial-budget' : 'partial-context', ...measured };
  }
  if (!entry) return { choice: 'resume', reason: 'unmeasured', ...measured };
  if (entry.lastContext < RESUME_FRESH_MIN_CONTEXT) return { choice: 'resume', reason: 'small', ...measured };
  if (accountChanged) return { choice: 'fresh', reason: 'account-changed', ...measured };
  if (idleMs !== null && idleMs >= RESUME_CACHE_COLD_MS) return { choice: 'fresh', reason: 'cache-cold', ...measured };
  return { choice: 'resume', reason: 'cache-warm', ...measured };
}

/** `612k`, `1M`, `1.25M` — a token count for a sentence. */
export function tokensLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** A counter as the wire gives it: a non-negative finite number, else zero. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * `message.usage` as a call, or null when it is not one.
 *
 * All four counters zero is the CLI's own synthetic message (`model:
 * "<synthetic>"` — "No response requested."), which no API call produced.
 */
export function usageOf(raw: unknown): CallUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const usage = raw as Record<string, unknown>;
  const input = count(usage.input_tokens);
  const cacheWrite = count(usage.cache_creation_input_tokens);
  const cacheRead = count(usage.cache_read_input_tokens);
  const output = count(usage.output_tokens);
  if (input + cacheWrite + cacheRead + output === 0) return null;
  return { input, cacheWrite, cacheRead, output, context: input + cacheWrite + cacheRead };
}

/** Did this call write the cache again rather than read it? See `CACHE_REBUILD_MIN_TOKENS`. */
export function isCacheRebuild(call: CallUsage): boolean {
  return call.cacheWrite >= Math.max(CACHE_REBUILD_MIN_TOKENS, CACHE_REBUILD_FRACTION * call.context);
}

export function newTokenCounters(): TokenCounters {
  return { calls: 0, lastContext: 0, peakContext: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, rebuilds: 0 };
}

/**
 * One session's fold. `resumed` is whether it continued a conversation: a fresh
 * session's first call BUILDS its cache (P8's boot wrote 101,653 of 111,781 —
 * over the rebuild line on this repo's bootstrap alone), and counting that would
 * put a rebuild on every lane that ever booted.
 */
export type UsageTracker = {
  counters: TokenCounters;
  resumed: boolean;
  /** Recent calls by message id, so a call's later content blocks are not counted again. */
  seen: Map<string, { call: CallUsage; build: boolean; rebuild: boolean }>;
};

/**
 * The CLI emits one assistant line per content block and every line of one API
 * call carries its usage; the lines of a call arrive together, so a short
 * memory is enough to recognise them.
 */
const MAX_SEEN_CALLS = 32;

export function newUsageTracker(opts: { resumed?: boolean } = {}): UsageTracker {
  return { counters: newTokenCounters(), resumed: opts.resumed === true, seen: new Map() };
}

/**
 * Fold one line's usage in. A new id (or none — a line that cannot be matched
 * is its own call) counts a call; a repeat of an id adds only what grew, field
 * by field, so nothing is counted twice. `changed` says whether the counters
 * moved; `call` is the call as now known.
 */
export function foldUsage(
  tracker: UsageTracker, id: string | undefined, usage: CallUsage,
): { changed: boolean; rebuild: boolean; call: CallUsage } {
  const counters = tracker.counters;
  const before = id ? tracker.seen.get(id) : undefined;
  if (!before) {
    // The first call of a session that continued nothing is the build.
    const build = counters.calls === 0 && !tracker.resumed;
    const rebuild = !build && isCacheRebuild(usage);
    counters.calls += 1;
    counters.input += usage.input;
    counters.cacheWrite += usage.cacheWrite;
    counters.cacheRead += usage.cacheRead;
    counters.output += usage.output;
    counters.lastContext = usage.context;
    counters.peakContext = Math.max(counters.peakContext, usage.context);
    if (rebuild) counters.rebuilds += 1;
    if (id) {
      tracker.seen.set(id, { call: usage, build, rebuild });
      if (tracker.seen.size > MAX_SEEN_CALLS) tracker.seen.delete(tracker.seen.keys().next().value!);
    }
    return { changed: true, rebuild, call: usage };
  }

  const prev = before.call;
  const input = Math.max(prev.input, usage.input);
  const cacheWrite = Math.max(prev.cacheWrite, usage.cacheWrite);
  const cacheRead = Math.max(prev.cacheRead, usage.cacheRead);
  const output = Math.max(prev.output, usage.output);
  const call: CallUsage = { input, cacheWrite, cacheRead, output, context: input + cacheWrite + cacheRead };
  const changed = call.input !== prev.input || call.cacheWrite !== prev.cacheWrite
    || call.cacheRead !== prev.cacheRead || call.output !== prev.output;
  if (!changed) return { changed: false, rebuild: before.rebuild, call: prev };
  counters.input += call.input - prev.input;
  counters.cacheWrite += call.cacheWrite - prev.cacheWrite;
  counters.cacheRead += call.cacheRead - prev.cacheRead;
  counters.output += call.output - prev.output;
  counters.lastContext = call.context;
  counters.peakContext = Math.max(counters.peakContext, call.context);
  const rebuild = before.rebuild || (!before.build && isCacheRebuild(call));
  if (rebuild && !before.rebuild) counters.rebuilds += 1;
  tracker.seen.set(id!, { call, build: before.build, rebuild });
  return { changed: true, rebuild, call };
}

/**
 * The context window for a session, from every name known for its model — the
 * one the phase asked for and the one the session's `init` reported — or null
 * when none is known.
 *
 * The LARGEST wins. The two can disagree (a mode alias, a suffix one of them
 * drops), and the errors are not symmetric: a window guessed too large lets a
 * session run on as it always did, one guessed too small tells a healthy session
 * to wrap up the moment its bootstrap has loaded.
 */
export function contextWindowOf(
  models: ReadonlyArray<string | null | undefined>, env: ModelsEnv = MODELS_ENV_FALLBACK,
): number | null {
  let window: number | null = null;
  for (const model of models) {
    if (!model || !model.trim()) continue;
    const cls = budgetClassOf(model, env);
    const size = cls === '1m' || cls === 'big' ? CONTEXT_WINDOW_1M : CONTEXT_WINDOW_DEFAULT;
    window = Math.max(window ?? 0, size);
  }
  return window;
}

/** Where a context stands against its window. Nothing acts without a window. */
export function contextStage(context: number, window: number | null | undefined): ContextStage {
  if (!window || window <= 0) return 'ok';
  if (context >= CONTEXT_CHECKPOINT_FRACTION * window) return 'checkpoint';
  if (context >= CONTEXT_WRAPUP_FRACTION * window) return 'wrap-up';
  return 'ok';
}
