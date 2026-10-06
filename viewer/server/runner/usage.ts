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
  /**
   * The FIRST call's context (control-tower phase 59, #83): for a fresh session,
   * its boot — the system prompt, tools, CLAUDE.md, rules, memory and boot
   * prompt, read before any work. Kept for a resumed session too, where it is
   * the conversation re-read, and never taken as a boot there
   * (`analysis/sizing-model.ts` `bootFloorOf`). Zero on a line written before it.
   */
  firstContext: number;
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

/**
 * A threshold the console acted on, on the record: which session, at what
 * context, when. For the wrap-up, whether the steer reached the session, how
 * many usage events it was tried on, and — while it has not — the steer's own
 * refusal (control-tower phase 46, #79: it was marked spent "whether or not it
 * arrived", and the reason was thrown away).
 */
export type ContextMark = {
  sessionId: string | null; at: string; context: number; window: number;
  delivered?: boolean; attempts?: number; reason?: string;
};

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
/*
 * How far below the wrap-up line a session may have ended and still be resumed,
 * as a fraction of its window (control-tower phase 46, #79). A resume re-reads
 * the whole conversation and adds the instruction, so a session that ended at or
 * past `CONTEXT_WRAPUP_FRACTION − this` × its window starts inside the wrap-up
 * zone and runs to the checkpoint: many-plans P15 was resumed "cache-warm" at
 * 578,475 of 1M, told to wrap up six seconds later, and checkpointed at 801,938.
 */
export const RESUME_WRAPUP_MARGIN = 0.05;

export type ResumeChoice = 'resume' | 'fresh';
export type ResumePolicyReason =
  | 'context-checkpoint' | 'partial-budget' | 'partial-context' | 'context-wrapup' | 'account-changed' | 'cache-cold'
  | 'cache-warm' | 'small' | 'unmeasured'
  // The supervisor chat's two (control-tower phase 27): past the context rule a
  // chat starts a visible new thread, and an idle one is resumed however cold.
  | 'context-rule' | 'cold-exempt';

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
 * budget|context`, when it ended at ≥ RESUME_FRESH_MIN_CONTEXT and is cold or
 * under another account, or when it ended at or past its window's wrap-up line
 * less `RESUME_WRAPUP_MARGIN` (`context-wrapup` — judged against the session's
 * own window, so a 200k session past its line is fresh even under the "small"
 * size). `paying` is the account that would pay for the resume, or null when the
 * caller cannot say — the account is then not judged. A session with no
 * counters is resumed as it always was.
 */
/**
 * **The documented cold-rule exemption** (control-tower phase 27, §Architecture
 * 8): `exempt: 'cold'` is the supervisor chat's, and nothing else passes it. A
 * chat is the operator's own conversation, not a phase with a brief to board
 * fresh from — a fresh boot would lose the thread, not save a bootstrap — so
 * it is resumed however long it sat idle. The context rule still holds, and
 * holds harder: a chat that ended at ≥ RESUME_FRESH_MIN_CONTEXT, warm or cold,
 * starts a visible NEW THREAD (`context-rule`) rather than re-reading it all
 * on every message; one under another account starts one too, since its
 * transcript is not ported.
 */
export function resumePolicy(
  record: ResumeFacts, sessionId: string, opts: { now: number; paying: string | null; exempt?: 'cold' },
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
  const window = typeof entry.window === 'number' && entry.window > 0 ? entry.window : null;
  const pastWrapup = window !== null && entry.lastContext >= (CONTEXT_WRAPUP_FRACTION - RESUME_WRAPUP_MARGIN) * window;
  if (opts.exempt === 'cold') {
    if (entry.lastContext >= RESUME_FRESH_MIN_CONTEXT) return { choice: 'fresh', reason: 'context-rule', ...measured };
    if (accountChanged) return { choice: 'fresh', reason: 'account-changed', ...measured };
    if (pastWrapup) return { choice: 'fresh', reason: 'context-wrapup', ...measured };
    const cold = idleMs !== null && idleMs >= RESUME_CACHE_COLD_MS;
    return { choice: 'resume', reason: cold ? 'cold-exempt' : 'small', ...measured };
  }
  if (entry.lastContext < RESUME_FRESH_MIN_CONTEXT) {
    return pastWrapup ? { choice: 'fresh', reason: 'context-wrapup', ...measured } : { choice: 'resume', reason: 'small', ...measured };
  }
  if (accountChanged) return { choice: 'fresh', reason: 'account-changed', ...measured };
  if (idleMs !== null && idleMs >= RESUME_CACHE_COLD_MS) return { choice: 'fresh', reason: 'cache-cold', ...measured };
  if (pastWrapup) return { choice: 'fresh', reason: 'context-wrapup', ...measured };
  return { choice: 'resume', reason: 'cache-warm', ...measured };
}

/* ---- what a session's own calls are worth (control-tower phase 46, #62, CC-5; phase 109, #202) ---- */

/*
 * USD per token, by MODEL VERSION, for the four counters a call reports — each
 * version at its own list rates. Only what was MEASURED:
 *  - `claude-opus-5`: the audit week priced every non-resumed Opus 5 session
 *    (n = 126) at a median of exactly 1.000 × what the CLI reported — a cache
 *    write at twice input (the one-hour cache), a read at a tenth;
 *  - `claude-opus-5-5` (control-tower phase 109, #202): 389 fresh Opus 5.5
 *    sessions, 2026-09-25 → 10-03, at a median of 1.000 and 291 of them within
 *    ±2 % — a write at twice input, a read at a TWENTIETH. Until this row
 *    existed the one row was `opus`, found by substring, so every 5.5 session
 *    was priced as Opus 5 and read `under` at ≈ 0.54: 347 false findings, and a
 *    doubled booking on the default model read as agreement.
 * A version with no measured row is not priced — an alias (`opus`) names no
 * version at all — and an unpriced session is simply not corroborated: a
 * guessed price would journal a mismatch for every session it got wrong.
 */
export const TOKEN_PRICES_USD: Readonly<Record<string, Readonly<{ input: number; cacheWrite: number; cacheRead: number; output: number }>>> = Object.freeze({
  'claude-opus-5': Object.freeze({ input: 5e-6, cacheWrite: 10e-6, cacheRead: 0.5e-6, output: 25e-6 }),
  'claude-opus-5-5': Object.freeze({ input: 4e-6, cacheWrite: 8e-6, cacheRead: 0.2e-6, output: 20e-6 }),
});

/**
 * The row of `TOKEN_PRICES_USD` a model id names, or null — matched by the
 * WHOLE id (#202), never by a family substring, which priced
 * `claude-opus-5-5[1m]` as `claude-opus-5`. Two spellings are the same model:
 * the window suffix (it selects a context window, and the measured sessions
 * show no long-context rate) and a trailing date stamp (`-20251001`, how the
 * CLI ships a dated id).
 */
export function priceRowOf(model: string | null | undefined): string | null {
  const id = (model ?? '').trim().toLowerCase();
  const base = (id.endsWith(MODELS_ENV_FALLBACK.oneM) ? id.slice(0, -MODELS_ENV_FALLBACK.oneM.length) : id).replace(/-\d{8}$/, '');
  return Object.prototype.hasOwnProperty.call(TOKEN_PRICES_USD, base) ? base : null;
}

/** A session's own calls, priced — null when its model has no measured row. */
export function priceUsage(model: string | null | undefined, counters: Pick<TokenCounters, 'input' | 'cacheWrite' | 'cacheRead' | 'output'>): number | null {
  const row = priceRowOf(model);
  if (!row) return null;
  const rate = TOKEN_PRICES_USD[row];
  return counters.input * rate.input + counters.cacheWrite * rate.cacheWrite
    + counters.cacheRead * rate.cacheRead + counters.output * rate.output;
}

/*
 * A drifting rate, noticed once (control-tower phase 109, #202). When fresh
 * sessions of one model book the same fraction of their price, session after
 * session, the PRICE is what is wrong — a lineup change, a new cache rate — not
 * the bookings: three such sessions within a day, their ratios within ±5 % of
 * their median and on one side, are announced once (`phase.cost-drift`), and
 * for the rest of that day a session at that ratio is explained by it. A
 * session OFF the ratio is still a finding, so a re-reported total (#62) is
 * caught on a drifting model too.
 */
export const COST_DRIFT_SESSIONS = 3;
export const COST_DRIFT_BAND = 0.05;
export const COST_DRIFT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type CostDriftVerdict =
  | { kind: 'mismatch' }
  | { kind: 'drift'; ratio: number; sessions: number; since: string }
  | { kind: 'explained'; ratio: number; since: string };

/**
 * One console's memory of its models' mismatches (#202): the service hands
 * every runner the same one, so a drift announced in one run is not announced
 * again by the next run of the same day.
 */
export class CostDrift {
  private readonly samples = new Map<string, { ratio: number; at: number; direction: 'over' | 'under' }[]>();
  private readonly announced = new Map<string, { ratio: number; at: number; direction: 'over' | 'under' }>();

  /** What one mismatching session is: a finding, the drift's announcement, or the drift already announced. */
  note(input: { model: string; ratio: number; direction: 'over' | 'under'; fresh: boolean; at: number }): CostDriftVerdict {
    const { model, ratio, direction, at } = input;
    const told = this.announced.get(model);
    if (told && at - told.at < COST_DRIFT_WINDOW_MS) {
      const onIt = told.direction === direction && Math.abs(ratio - told.ratio) <= COST_DRIFT_BAND * told.ratio;
      return onIt ? { kind: 'explained', ratio: told.ratio, since: new Date(told.at).toISOString() } : { kind: 'mismatch' };
    }
    if (told) this.announced.delete(model);
    // A resumed session books a delta against a mark; only a fresh one's ratio
    // is the price's evidence. A session that booked NOTHING is no price at all
    // (a lost total, a crashed CLI): ratio 0 is a finding, never a drift.
    if (!input.fresh || ratio <= 0) return { kind: 'mismatch' };
    const kept = (this.samples.get(model) ?? []).filter((sample) => at - sample.at < COST_DRIFT_WINDOW_MS);
    kept.push({ ratio, at, direction });
    this.samples.set(model, kept.slice(-COST_DRIFT_SESSIONS));
    const recent = kept.slice(-COST_DRIFT_SESSIONS);
    if (recent.length < COST_DRIFT_SESSIONS || recent.some((sample) => sample.direction !== direction)) return { kind: 'mismatch' };
    const median = recent.map((sample) => sample.ratio).sort((a, b) => a - b)[Math.floor(recent.length / 2)];
    if (recent.some((sample) => Math.abs(sample.ratio - median) > COST_DRIFT_BAND * median)) return { kind: 'mismatch' };
    this.announced.set(model, { ratio: median, at, direction });
    this.samples.delete(model);
    return { kind: 'drift', ratio: median, sessions: recent.length, since: new Date(recent[0].at).toISOString() };
  }
}

/*
 * When a booked figure disagrees with its priced usage: by more than a quarter
 * of the priced figure AND by more than half a dollar — the absolute floor keeps
 * a two-call session's rounding from reading as a finding. The audit's
 * per-session scatter around the fit was well inside both; a re-reported total
 * is many times outside them (P14's 7-call resume: $26.01 booked, $1.65 priced).
 */
export const COST_MISMATCH_TOLERANCE = 0.25;
export const COST_MISMATCH_FLOOR_USD = 0.5;

/**
 * Does a booked figure disagree with its priced usage past tolerance? `over`
 * when it books more than the calls explain, `under` when less. A session that
 * started a subagent pays for calls the stream never shows this console (a
 * subagent's context is its own), so an excess is explained there — a shortfall
 * never is. Null when it agrees, or when there is nothing priced to compare.
 */
export function costMismatch(input: { booked: number; priced: number | null; delegated: boolean }): { direction: 'over' | 'under'; ratio: number } | null {
  const { booked, priced } = input;
  if (priced === null || !Number.isFinite(priced) || !Number.isFinite(booked)) return null;
  const gap = booked - priced;
  if (Math.abs(gap) <= Math.max(COST_MISMATCH_FLOOR_USD, COST_MISMATCH_TOLERANCE * priced)) return null;
  if (gap > 0 && input.delegated) return null;
  return { direction: gap > 0 ? 'over' : 'under', ratio: priced > 0 ? Math.round((booked / priced) * 100) / 100 : 0 };
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
  return { calls: 0, firstContext: 0, lastContext: 0, peakContext: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, rebuilds: 0 };
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
  seen: Map<string, { call: CallUsage; build: boolean; rebuild: boolean; first: boolean }>;
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
    const first = counters.calls === 0;
    const build = first && !tracker.resumed;
    const rebuild = !build && isCacheRebuild(usage);
    if (first) counters.firstContext = usage.context;
    counters.calls += 1;
    counters.input += usage.input;
    counters.cacheWrite += usage.cacheWrite;
    counters.cacheRead += usage.cacheRead;
    counters.output += usage.output;
    counters.lastContext = usage.context;
    counters.peakContext = Math.max(counters.peakContext, usage.context);
    if (rebuild) counters.rebuilds += 1;
    if (id) {
      tracker.seen.set(id, { call: usage, build, rebuild, first });
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
  // A later block of the first call: the boot, now known better.
  if (before.first) counters.firstContext = call.context;
  const rebuild = before.rebuild || (!before.build && isCacheRebuild(call));
  if (rebuild && !before.rebuild) counters.rebuilds += 1;
  tracker.seen.set(id!, { call, build: before.build, rebuild, first: before.first });
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
