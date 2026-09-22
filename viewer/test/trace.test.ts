/**
 * The trace context — the ids that make one run's evidence findable.
 *
 * The question this phase exists to answer is "what happened to run X", and the
 * answer used to be a six-step walk: find the run id, find its journal, find
 * the attempt, find the session id, grep the console log for it, then guess
 * which git commands belonged to it. One id carried end to end replaces the
 * walk with a `grep`.
 *
 * Two properties are load-bearing and are what most of this file pins.
 * **The run's id is DERIVED, not minted** — a console that restarts and resumes
 * a run has no memory of the id it used before, so an id allocated at random
 * would split one run's evidence in two at every restart. And **`envCarrier()`
 * outside a context states every key as `undefined` rather than returning an
 * empty object** — a console started from a shell that already exports
 * `TRACEPARENT` would otherwise hand that stranger's id to every child it
 * spawns, and the evidence would join a trace that has nothing to do with it.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROCESS_TRACE_ID,
  bind,
  current,
  enter,
  envCarrier,
  parseTraceparent,
  runTraceId,
  traceparent,
  withSpan,
} from '../server/trace.ts';

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

test('runTraceId is derived, so a restarted console rejoins the same trace', () => {
  const a = runTraceId('f922d743-pe-hub', 'many-plans-one-repo', 'f0da619a');
  const b = runTraceId('f922d743-pe-hub', 'many-plans-one-repo', 'f0da619a');

  assert.match(a, HEX32, 'a trace id is 32 lowercase hex, the w3c width');
  assert.equal(a, b, 'the same three facts must always answer the same id — this is the whole point');

  // Each of the three facts alone changes the answer, or two runs would share a trace.
  assert.notEqual(a, runTraceId('other-instance', 'many-plans-one-repo', 'f0da619a'));
  assert.notEqual(a, runTraceId('f922d743-pe-hub', 'other-plan', 'f0da619a'));
  assert.notEqual(a, runTraceId('f922d743-pe-hub', 'many-plans-one-repo', 'deadbeef'));
});

test('runTraceId is never the all-zero id, which w3c reserves as "no trace"', () => {
  assert.notEqual(runTraceId('i', 's', 'r'), '0'.repeat(32));
});

test('PROCESS_TRACE_ID is a well-formed id for work that belongs to no run', () => {
  assert.match(PROCESS_TRACE_ID, HEX32);
  assert.notEqual(PROCESS_TRACE_ID, '0'.repeat(32));
});

test('current() is undefined outside any span', () => {
  assert.equal(current(), undefined);
});

test('withSpan makes a context current and restores the absence afterwards', () => {
  const seen = withSpan('run.drive', {}, () => current());

  assert.ok(seen, 'the callback runs inside the span');
  assert.equal(seen.name, 'run.drive');
  assert.match(seen.traceId, HEX32);
  assert.match(seen.spanId, HEX16);
  assert.equal(seen.parentSpanId, undefined, 'a root span has no parent');
  assert.equal(seen.traceId, PROCESS_TRACE_ID, 'a root span with no stated trace belongs to the process');
  assert.equal(current(), undefined, 'and the context does not leak past the call');
});

test('a nested span inherits the trace and points at its parent', () => {
  const traceId = runTraceId('inst', 'slug', 'run1');

  const { outer, inner } = enter({ traceId, name: 'run.drive' }, () => {
    const outer = current();
    const inner = withSpan('phase.attempt', { phase: 3 }, () => current());
    return { outer: outer, inner: inner };
  });

  assert.ok(outer && inner);
  assert.equal(outer.traceId, traceId, 'enter() honours a stated trace id rather than minting one');
  assert.equal(inner.traceId, traceId, 'the child stays in the same trace');
  assert.notEqual(inner.spanId, outer.spanId, 'but gets a span of its own');
  assert.equal(inner.parentSpanId, outer.spanId);
  assert.equal(inner.phase, 3);
});

test('span attributes are inherited and may be overridden by a child', () => {
  const read = enter(
    { traceId: runTraceId('i', 's', 'r'), name: 'run.drive', attempt: 1, sessionId: 'sess-a', actor: 'console/autopilot' },
    () => withSpan('phase.attempt', { attempt: 2 }, () => current()),
  );

  assert.ok(read);
  assert.equal(read.sessionId, 'sess-a', 'what the child does not restate, it inherits');
  assert.equal(read.actor, 'console/autopilot');
  assert.equal(read.attempt, 2, 'and what it restates, it owns — a retry is a new attempt inside one run');
});

test('an async span survives an await, and two concurrent spans do not leak into each other', async () => {
  const first = runTraceId('i', 's', 'one');
  const second = runTraceId('i', 's', 'two');

  const read = async (traceId: string, delay: number) =>
    enter({ traceId, name: 'run.drive' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      const after = current();
      return after?.traceId;
    });

  // The slower one is started first on purpose: an implementation using a
  // module-level "current" variable instead of AsyncLocalStorage passes the
  // sequential case and fails exactly here.
  const [a, b] = await Promise.all([read(first, 20), read(second, 1)]);

  assert.equal(a, first);
  assert.equal(b, second);
  assert.equal(current(), undefined);
});

test('withSpan returns the callback value and propagates a rejection, still unwinding', async () => {
  assert.equal(await withSpan('engine.call', {}, async () => 'value'), 'value');

  await assert.rejects(
    withSpan('engine.call', {}, async () => { throw new Error('boom'); }),
    /boom/,
  );
  assert.equal(current(), undefined, 'a throwing span must not strand the context');
});

test('bind captures the context for a callback that runs outside it', async () => {
  const traceId = runTraceId('i', 's', 'bound');
  const later = enter({ traceId, name: 'run.drive' }, () => bind(() => current()?.traceId));

  assert.equal(current(), undefined, 'we are outside every span here');
  assert.equal(later(), traceId, 'but the bound callback is not');
});

test('traceparent is the w3c header, and parseTraceparent reads it back', () => {
  const header = enter({ traceId: runTraceId('i', 's', 'r'), name: 'x' }, () => traceparent());

  assert.ok(header);
  assert.match(header, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

  const parsed = parseTraceparent(header);
  assert.ok(parsed);
  assert.equal(parsed.traceId, runTraceId('i', 's', 'r'));
  assert.match(parsed.spanId, HEX16);

  assert.equal(traceparent(), undefined, 'there is no header outside a context');
});

test('parseTraceparent refuses anything that is not one', () => {
  for (const bad of [
    '',
    'nonsense',
    '00-tooshort-0000000000000001-01',
    `01-${'a'.repeat(32)}-${'b'.repeat(16)}-01`, // a version we do not speak
    `00-${'0'.repeat(32)}-${'b'.repeat(16)}-01`, // the reserved all-zero trace
    `00-${'a'.repeat(32)}-${'0'.repeat(16)}-01`, // the reserved all-zero span
    `00-${'A'.repeat(32)}-${'b'.repeat(16)}-01`, // hex is lowercase in this header
  ]) {
    assert.equal(parseTraceparent(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('envCarrier hands a child the four keys a child can read', () => {
  const carrier = enter({ traceId: runTraceId('i', 's', 'r'), name: 'phase.spawn' }, () => envCarrier());

  assert.equal(carrier.PE_TRACE_ID, runTraceId('i', 's', 'r'));
  assert.match(String(carrier.PE_SPAN_ID), HEX16);
  assert.equal(carrier.TRACEPARENT, `00-${carrier.PE_TRACE_ID}-${carrier.PE_SPAN_ID}-01`);
  assert.ok(carrier.GIT_TRACE2_PARENT_SID, 'git needs a parent sid of its own shape to fold a child under');
  assert.ok(
    String(carrier.GIT_TRACE2_PARENT_SID).includes(String(carrier.PE_SPAN_ID)),
    'and that sid must name the span, or the folded git.trace line cannot be joined back',
  );
});

test('envCarrier outside a context STATES every key as undefined, so an inherited one is deleted', () => {
  const carrier = envCarrier();
  const keys = ['TRACEPARENT', 'PE_TRACE_ID', 'PE_SPAN_ID', 'GIT_TRACE2_PARENT_SID'];

  assert.deepEqual(Object.keys(carrier).sort(), [...keys].sort(), 'the keys are PRESENT…');
  for (const key of keys) assert.equal(carrier[key as keyof typeof carrier], undefined, `…and ${key} is undefined`);

  // This is the property that matters, spelled as the call sites use it: a
  // console launched from a shell that exports TRACEPARENT must not hand that
  // stranger's id to its children. Node drops an env key whose value is
  // undefined, so the spread must overwrite rather than be absent.
  const childEnv = { ...{ TRACEPARENT: 'inherited-from-the-operators-shell', PATH: '/usr/bin' }, ...carrier };
  assert.equal(childEnv.TRACEPARENT, undefined);
  assert.equal(childEnv.PATH, '/usr/bin', 'and nothing else in the env is touched');
});
