/**
 * Correlation ids — the one thing that makes a run's evidence findable.
 *
 * "What happened to run X" used to be a six-step walk: find the run id, open
 * its journal, find the attempt, read the session id out of it, grep the
 * console log for that, then guess which of the console's git commands belonged
 * to the phase. Every step was a join a person did by eye, and the last one was
 * not possible at all. One id carried from the HTTP request through the drive,
 * the attempt, the spawned session, the bash scripts, the presence hook and
 * every git command turns the walk into a `grep`.
 *
 * Two decisions here are load-bearing.
 *
 * **A run's trace id is DERIVED, never minted.** A console that restarts and
 * resumes a run has no memory of what it allocated before — a random id would
 * split one run's evidence in two at every restart, which is precisely when
 * somebody is looking. `runTraceId(instanceId, slug, runId)` is a pure function
 * of three facts the resumed console re-reads from disk, so the second half of
 * a run joins the first by construction.
 *
 * **`envCarrier()` outside a context states every key as `undefined` rather
 * than returning `{}`.** A console started from a shell that already exports
 * `TRACEPARENT` (a CI runner, another tracing tool, a previous session) would
 * otherwise hand that stranger's id to every child it spawns, and this run's
 * evidence would join a trace that has nothing to do with it. Node omits an env
 * key whose value is `undefined`, so stating the key is how it gets deleted;
 * omitting the key is how it gets inherited.
 *
 * This module imports nothing but node builtins on purpose: `log.ts` reads
 * `current()` on every write, so anything this file imported would be loaded
 * before logging could work.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';

/** A span's live facts. Everything but `traceId`/`spanId`/`name` is inherited. */
export type TraceContext = {
  /** 32 lowercase hex — the w3c width, one per run (or per process). */
  readonly traceId: string;
  /** 16 lowercase hex — one per span. */
  readonly spanId: string;
  readonly parentSpanId?: string;
  /** `run.drive`, `phase.attempt`, `http.request`, … */
  readonly name: string;
  readonly phase?: number;
  readonly attempt?: number;
  readonly sessionId?: string;
  readonly actor?: string;
};

/** What `enter()` accepts: a context with everything optional but the name. */
export type SpanInit = Partial<Omit<TraceContext, 'spanId' | 'parentSpanId'>> & { name: string };

/** w3c reserves the all-zero id for "no trace"; ours must never collide with it. */
const NO_TRACE = '0'.repeat(32);
const NO_SPAN = '0'.repeat(16);

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const storage = new AsyncLocalStorage<TraceContext>();

function hexOf(input: string, bytes: number): string {
  const digest = createHash('sha256').update(input).digest('hex').slice(0, bytes * 2);
  // A sha256 prefix is never all-zero in practice; the guard costs nothing and
  // means no caller has to wonder whether it could be.
  return /^0+$/.test(digest) ? '1'.padStart(bytes * 2, '0') : digest;
}

/**
 * The trace every line of a run's evidence carries.
 *
 * Pure in its three arguments, so a resumed run recomputes the same id rather
 * than remembering one. Each argument alone changes the answer: two runs of one
 * plan, one run under two consoles, and two plans' runs are three different
 * traces.
 */
export function runTraceId(instanceId: string, slug: string, runId: string): string {
  return hexOf(`phase-console\u0000${instanceId}\u0000${slug}\u0000${runId}`, 16);
}

/**
 * The trace for work that belongs to no run — a boot, a route, a sweep.
 *
 * Derived once per process from facts that differ between processes, so two
 * consoles on one machine never share it.
 */
export const PROCESS_TRACE_ID = hexOf(
  `process\u0000${process.pid}\u0000${Date.now()}\u0000${randomBytes(8).toString('hex')}`,
  16,
);

function newSpanId(): string {
  for (;;) {
    const id = randomBytes(8).toString('hex');
    if (id !== NO_SPAN) return id;
  }
}

/** The span this code is running inside, or `undefined` outside every span. */
export function current(): TraceContext | undefined {
  return storage.getStore();
}

/**
 * Run `fn` inside a span.
 *
 * The trace is the one stated, else the one inherited, else the process's. A
 * child points at its parent only when they share a trace — an `enter()` that
 * states a *different* trace is deliberately starting a new one (the journal
 * records the crossing as `viaTraceId`), and a parent span id from the other
 * trace would be a dangling pointer.
 */
export function enter<T>(init: SpanInit, fn: () => T): T {
  const parent = current();
  const traceId = init.traceId ?? parent?.traceId ?? PROCESS_TRACE_ID;
  const context: TraceContext = {
    traceId,
    spanId: newSpanId(),
    ...(parent && parent.traceId === traceId ? { parentSpanId: parent.spanId } : {}),
    name: init.name,
    ...pick('phase', init.phase, parent?.phase),
    ...pick('attempt', init.attempt, parent?.attempt),
    ...pick('sessionId', init.sessionId, parent?.sessionId),
    ...pick('actor', init.actor, parent?.actor),
  };
  return storage.run(context, fn);
}

/** What the span states wins; what it leaves out it inherits; absent stays absent. */
function pick<K extends string, V>(key: K, own: V | undefined, inherited: V | undefined): Record<K, V> | object {
  const value = own ?? inherited;
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * A child span of whatever is current.
 *
 * Returns the callback's value unchanged — including a promise, which the
 * AsyncLocalStorage keeps the context alive across. A throw unwinds the context
 * like any other exception, which is why nothing here has a `finally`.
 */
export function withSpan<T>(name: string, attrs: Omit<SpanInit, 'name'>, fn: () => T): T {
  return enter({ ...attrs, name }, fn);
}

/**
 * Capture the current context for a callback that will run outside it.
 *
 * For the callback-shaped seams the console is full of — a timer, an event
 * listener, a promise resolved from somewhere else. Binding outside every span
 * is not an error; the callback simply runs with no context, exactly as it
 * would have.
 */
export function bind<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const captured = current();
  if (!captured) return fn;
  return (...args: A) => storage.run(captured, () => fn(...args));
}

/** The w3c `traceparent` header for a context, or `undefined` outside one. */
export function traceparent(context: TraceContext | undefined = current()): string | undefined {
  return context ? `00-${context.traceId}-${context.spanId}-01` : undefined;
}

/**
 * Read a `traceparent` back.
 *
 * Strict on purpose: this is the one place an id from OUTSIDE the console
 * enters it (an `x-request-id`-style header, a resumed session's env), and an
 * id that is not well-formed is worse than none — it joins this run's evidence
 * to a trace nobody can find. The two reserved all-zero ids are refused for the
 * same reason.
 */
export function parseTraceparent(raw: string | undefined | null): { traceId: string; spanId: string } | null {
  if (!raw) return null;
  const match = TRACEPARENT_RE.exec(raw);
  if (!match) return null;
  const [, traceId, spanId] = match;
  if (traceId === NO_TRACE || spanId === NO_SPAN) return null;
  return { traceId, spanId };
}

/** The env keys a child process reads to join this trace. */
export type TraceCarrier = {
  TRACEPARENT: string | undefined;
  PE_TRACE_ID: string | undefined;
  PE_SPAN_ID: string | undefined;
  GIT_TRACE2_PARENT_SID: string | undefined;
};

/**
 * The four env keys to spread into any child's environment.
 *
 * **Every key is always present.** Outside a context each is `undefined`, which
 * Node treats as "not set" — so `{...process.env, ...envCarrier()}` DELETES an
 * inherited `TRACEPARENT` rather than passing a stranger's trace on. Returning
 * `{}` there would have been the bug.
 *
 * `GIT_TRACE2_PARENT_SID` names both ids because git forms its child's sid as
 * `<parent>/<own>`: the raw Trace2 file is then joinable back to the span that
 * ran the command, with no other record needed.
 */
export function envCarrier(context: TraceContext | undefined = current()): TraceCarrier {
  if (!context) {
    return {
      TRACEPARENT: undefined,
      PE_TRACE_ID: undefined,
      PE_SPAN_ID: undefined,
      GIT_TRACE2_PARENT_SID: undefined,
    };
  }
  return {
    TRACEPARENT: traceparent(context),
    PE_TRACE_ID: context.traceId,
    PE_SPAN_ID: context.spanId,
    GIT_TRACE2_PARENT_SID: `pc-${context.traceId}-${context.spanId}`,
  };
}

/** Read a `GIT_TRACE2_PARENT_SID` (or a child sid built from one) back. */
export function parseGitSid(sid: string | undefined | null): { traceId: string; spanId: string } | null {
  if (!sid) return null;
  // Git appends its own sid after a '/', so only the first segment is ours.
  const match = /^pc-([0-9a-f]{32})-([0-9a-f]{16})/.exec(sid.split('/')[0]);
  return match ? { traceId: match[1], spanId: match[2] } : null;
}
