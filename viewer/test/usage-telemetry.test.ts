/**
 * Token telemetry (autopilot-token-drain phase 3): what each API call of a
 * session cost in context, folded per attempt — parsed from the stream,
 * deduplicated by message id, cache rebuilds counted, and the two context
 * thresholds a lane is wrapped up and checkpointed at.
 *
 * The runner never read `message.usage` before this, so the only cost it knew
 * was dollars, and only when a turn closed: run `deadaff9`'s phases peaked at
 * 471k–957k context with nothing on any surface saying so. The numbers below
 * are measured, not invented — P8's resumed session (`43da8e77`) wrote 554,419
 * on the first call of its resume and 621,999 again 36 s after a warm hit.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CACHE_REBUILD_FRACTION, CACHE_REBUILD_MIN_TOKENS, CONTEXT_CHECKPOINT_FRACTION, CONTEXT_WINDOW_1M,
  CONTEXT_WINDOW_DEFAULT, CONTEXT_WRAPUP_FRACTION, contextStage, contextWindowOf, foldUsage, isCacheRebuild,
  newUsageTracker, usageOf,
} from '../server/runner/usage.ts';
import { spawnClaude, type StreamEvent } from '../server/runner/spawn.ts';
import { applyEvent, livenessOf, newLaneSignals } from '../server/runner/liveness.ts';
import { observeCall } from '../shared/poll-loop.js';

/** One call as the CLI reports it: `message.usage`. */
const wire = (input: number, cacheWrite: number, cacheRead: number, output: number) => ({
  input_tokens: input, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, output_tokens: output,
});

/**
 * P8's resumed attempt, call by call (input, cache write, cache read, output) —
 * hub run `deadaff9`, session `43da8e77`, 16:30:20 → 16:33:31 on 2026-09-16.
 * An excerpt: calls 202–208 are left out, and none of them wrote more than
 * 49,979.
 */
const P8_RESUME: [number, number, number, number][] = [
  [2, 554_419, 10_126, 1_292], // the resume's first call rebuilds the whole context
  [2, 2_731, 564_545, 809],
  [2, 1_358, 567_276, 804],
  [2, 49_979, 576_088, 907], // a large write, but under half the context — not a rebuild
  [2, 3_214, 626_067, 1_941],
  [2, 621_999, 10_126, 3_124], // the second full rebuild, 36 s after a warm hit (CLI-side)
  [2, 6_226, 629_281, 1_291],
];

/** P8's boot call: a fresh session's first write is the build, and it is over 100k on this repo. */
const P8_BOOT: [number, number, number, number] = [2, 101_653, 10_126, 409];

test('the thresholds are the plan\'s numbers, in one place', () => {
  assert.equal(CONTEXT_WRAPUP_FRACTION, 0.6);
  assert.equal(CONTEXT_CHECKPOINT_FRACTION, 0.8);
  assert.equal(CONTEXT_WINDOW_1M, 1_000_000);
  assert.equal(CONTEXT_WINDOW_DEFAULT, 200_000);
  assert.equal(CACHE_REBUILD_MIN_TOKENS, 100_000);
  assert.equal(CACHE_REBUILD_FRACTION, 0.5);
});

test('usageOf reads the four counters and the context they add up to', () => {
  assert.deepEqual(usageOf(wire(2, 554_419, 10_126, 1_292)), {
    input: 2, cacheWrite: 554_419, cacheRead: 10_126, output: 1_292, context: 564_547,
  });
  assert.deepEqual(usageOf({ input_tokens: 5, output_tokens: 7 }), {
    input: 5, cacheWrite: 0, cacheRead: 0, output: 7, context: 5,
  }, 'a missing cache field is zero, not a reason to drop the call');
  assert.deepEqual(usageOf({ input_tokens: -3, cache_read_input_tokens: 'many', output_tokens: 4 }), {
    input: 0, cacheWrite: 0, cacheRead: 0, output: 4, context: 0,
  }, 'a counter that is not a non-negative number reads as zero');
  assert.equal(usageOf(wire(0, 0, 0, 0)), null, 'an all-zero usage is the CLI\'s synthetic message, not an API call');
  assert.equal(usageOf(undefined), null);
  assert.equal(usageOf('usage'), null);
});

test('a rebuild is a write of at least max(100k, half the context)', () => {
  const [call1, , , large, , call6] = P8_RESUME.map(([i, w, r, o]) => usageOf(wire(i, w, r, o))!);
  assert.equal(isCacheRebuild(call1), true, '554,419 of 564,547');
  assert.equal(isCacheRebuild(call6), true, '621,999 of 632,127');
  assert.equal(isCacheRebuild(large), false, '49,979 is under 100k');
  assert.equal(isCacheRebuild(usageOf(wire(2, 120_000, 400_000, 1))!), false, 'over 100k, but under half of 520k');
  assert.equal(isCacheRebuild(usageOf(wire(2, 60_000, 50_000, 1))!), false, 'over half, but under 100k');
});

test('P8\'s resumed attempt folds to 7 calls, 2 rebuilds and a 635k peak', () => {
  const tracker = newUsageTracker({ resumed: true });
  P8_RESUME.forEach(([i, w, r, o], n) => foldUsage(tracker, `msg_${n}`, usageOf(wire(i, w, r, o))!));
  const sum = (k: 0 | 1 | 2 | 3) => P8_RESUME.reduce((total, row) => total + row[k], 0);
  assert.deepEqual(tracker.counters, {
    calls: 7,
    lastContext: 635_509,
    peakContext: 635_509,
    input: sum(0),
    cacheWrite: sum(1),
    cacheRead: sum(2),
    output: sum(3),
    rebuilds: 2,
  });
});

test('a fresh session\'s first write is the build, not a rebuild — a resumed session\'s is', () => {
  const fresh = newUsageTracker({ resumed: false });
  const booted = foldUsage(fresh, 'msg_boot', usageOf(wire(...P8_BOOT))!);
  assert.equal(booted.rebuild, false, 'nothing existed to rebuild');
  assert.equal(fresh.counters.rebuilds, 0);
  // …and a later full write in the same session is one.
  assert.equal(foldUsage(fresh, 'msg_2', usageOf(wire(2, 554_419, 10_126, 1))!).rebuild, true);
  assert.equal(fresh.counters.rebuilds, 1);

  const resumed = newUsageTracker({ resumed: true });
  assert.equal(foldUsage(resumed, 'msg_boot', usageOf(wire(...P8_BOOT))!).rebuild, true, 'a resume re-writes a cache that existed');
  assert.equal(resumed.counters.rebuilds, 1);
});

test('one API call is one call however many content blocks carry it', () => {
  const tracker = newUsageTracker();
  const call = usageOf(wire(2, 13_315, 111_779, 983))!;
  // The CLI emits one assistant line per content block — thinking, then text,
  // then a tool call — and every one of them carries the same usage.
  const first = foldUsage(tracker, 'msg_1', call);
  const second = foldUsage(tracker, 'msg_1', call);
  const third = foldUsage(tracker, 'msg_1', call);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false, 'a repeat changes nothing');
  assert.equal(third.changed, false);
  assert.equal(tracker.counters.calls, 1);
  assert.equal(tracker.counters.cacheRead, 111_779);

  // A repeat that reports MORE (a later block with the final output count) adds
  // only what is new, so no field is ever counted twice.
  const grown = foldUsage(tracker, 'msg_1', usageOf(wire(2, 13_315, 111_779, 1_500))!);
  assert.equal(grown.changed, true);
  assert.equal(tracker.counters.calls, 1);
  assert.equal(tracker.counters.output, 1_500);
  assert.equal(tracker.counters.cacheRead, 111_779);

  // A line with no id cannot be matched to anything, so each one is a call.
  foldUsage(tracker, undefined, usageOf(wire(1, 0, 125_094, 10))!);
  foldUsage(tracker, undefined, usageOf(wire(1, 0, 125_094, 10))!);
  assert.equal(tracker.counters.calls, 3);
  assert.equal(tracker.counters.lastContext, 125_095);
  assert.equal(tracker.counters.peakContext, 125_096, 'msg_1 read 125,096, one more than either line after it');
});

test('last context follows the newest call; peak never goes down', () => {
  const tracker = newUsageTracker();
  foldUsage(tracker, 'a', usageOf(wire(2, 5_000, 900_000, 1))!);
  foldUsage(tracker, 'b', usageOf(wire(2, 40_000, 10_126, 1))!); // compacted
  assert.equal(tracker.counters.lastContext, 50_128);
  assert.equal(tracker.counters.peakContext, 905_002);
});

test('the window: 1M for [1m] and the big families, 200k otherwise, the largest of what is known', () => {
  assert.equal(contextWindowOf(['claude-opus-5[1m]']), CONTEXT_WINDOW_1M);
  assert.equal(contextWindowOf(['opus']), CONTEXT_WINDOW_1M);
  assert.equal(contextWindowOf(['claude-fable-5']), CONTEXT_WINDOW_1M);
  assert.equal(contextWindowOf(['sonnet']), CONTEXT_WINDOW_1M);
  assert.equal(contextWindowOf(['haiku']), CONTEXT_WINDOW_DEFAULT);
  assert.equal(contextWindowOf(['claude-haiku-4-5-20251001']), CONTEXT_WINDOW_DEFAULT);
  assert.equal(contextWindowOf(['stub-1']), CONTEXT_WINDOW_DEFAULT, 'an unrecognised name gets the plan\'s 200k');
  // The request and the session's own init can disagree — a mode alias, a
  // suffix the init drops. The larger window wins: guessing SMALL would wrap a
  // healthy session up the moment its bootstrap loaded.
  assert.equal(contextWindowOf(['haiku', 'claude-opus-5[1m]']), CONTEXT_WINDOW_1M);
  assert.equal(contextWindowOf([undefined, 'claude-opus-5']), CONTEXT_WINDOW_1M);
  assert.equal(contextWindowOf([undefined, null, '']), null, 'no model known, no window — and no threshold acts');
});

test('the stage: wrap-up from 0.6 × the window, checkpoint from 0.8 ×, nothing without a window', () => {
  assert.equal(contextStage(599_999, CONTEXT_WINDOW_1M), 'ok');
  assert.equal(contextStage(600_000, CONTEXT_WINDOW_1M), 'wrap-up');
  assert.equal(contextStage(799_999, CONTEXT_WINDOW_1M), 'wrap-up');
  assert.equal(contextStage(800_000, CONTEXT_WINDOW_1M), 'checkpoint');
  assert.equal(contextStage(957_000, CONTEXT_WINDOW_1M), 'checkpoint', 'P3 of deadaff9 ran on to 957k');
  assert.equal(contextStage(119_999, CONTEXT_WINDOW_DEFAULT), 'ok');
  assert.equal(contextStage(120_000, CONTEXT_WINDOW_DEFAULT), 'wrap-up');
  assert.equal(contextStage(160_000, CONTEXT_WINDOW_DEFAULT), 'checkpoint');
  assert.equal(contextStage(900_000, null), 'ok');
  assert.equal(contextStage(900_000, undefined), 'ok');
});

/**
 * A CLI stand-in that streams usage the way the real one does (measured on the
 * live CLI, 2026-09-17): with partial messages on, a call opens with a
 * `message_start` stream event carrying its id and usage — input and cache
 * exact, `output_tokens` a snapshot of 2–4 — its content blocks follow as
 * assistant lines carrying that SAME snapshot, and a `message_delta` closes it
 * with the final output count (142 where the lines said 4). Here: a boot call
 * streamed that way whose thinking and tool call are two lines of ONE message; a
 * subagent's call (its own context, not the phase's); the CLI's synthetic
 * zero-usage message; and a second call as it arrives with partial messages off
 * — whole lines only.
 */
const USAGE_STUB = `#!/usr/bin/env node
'use strict';
const sid = 'sess-usage';
const say = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const usage = (i, w, r, o) => ({ input_tokens: i, cache_creation_input_tokens: w, cache_read_input_tokens: r, output_tokens: o });
say({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5[1m]', tools: [] });
process.stdin.setEncoding('utf8');
let booted = false;
process.stdin.on('data', () => {
  if (booted) return;
  booted = true;
  say({ type: 'stream_event', session_id: sid, parent_tool_use_id: null,
    event: { type: 'message_start', message: { id: 'msg_1', role: 'assistant', usage: usage(2, 101653, 10126, 4) } } });
  say({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { id: 'msg_1', role: 'assistant',
    usage: usage(2, 101653, 10126, 4), content: [{ type: 'thinking', thinking: 'plan' }] } });
  say({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { id: 'msg_1', role: 'assistant',
    usage: usage(2, 101653, 10126, 4), content: [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { description: 'look' } }] } });
  say({ type: 'stream_event', session_id: sid, parent_tool_use_id: null,
    event: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: usage(2, 101653, 10126, 409) } });
  say({ type: 'stream_event', session_id: sid, parent_tool_use_id: 'toolu_1',
    event: { type: 'message_start', message: { id: 'msg_sub', role: 'assistant', usage: usage(3, 40000, 0, 1) } } });
  say({ type: 'assistant', session_id: sid, parent_tool_use_id: 'toolu_1', message: { id: 'msg_sub', role: 'assistant',
    usage: usage(3, 40000, 0, 1), content: [{ type: 'text', text: 'found it' }] } });
  say({ type: 'stream_event', session_id: sid, parent_tool_use_id: 'toolu_1',
    event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: usage(3, 40000, 0, 50) } });
  say({ type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'found it' }] } });
  say({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { id: 'msg_syn', role: 'assistant',
    model: '<synthetic>', usage: usage(0, 0, 0, 0), content: [{ type: 'text', text: 'No response requested.' }] } });
  say({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { id: 'msg_2', role: 'assistant',
    stop_reason: 'end_turn', usage: usage(2, 13315, 111779, 983), content: [{ type: 'text', text: 'done' }] } });
  say({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.4, result: 'done', session_id: sid });
  process.exit(0);
});
`;

test('the stream: one usage event per API call of the phase\'s own conversation, and the attempt\'s counters on the outcome', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-usage-'));
  try {
    writeFileSync(join(dir, 'claude'), USAGE_STUB, 'utf8');
    chmodSync(join(dir, 'claude'), 0o755);
    const events: StreamEvent[] = [];
    const outcome = await spawnClaude({
      prompt: 'BOOT phase 1', cwd: dir,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
      onEvent: (event) => events.push(event),
    });
    const usages = events.filter((event): event is Extract<StreamEvent, { kind: 'usage' }> => event.kind === 'usage');
    assert.deepEqual(usages.map((event) => event.id), ['msg_1', 'msg_1', 'msg_2'],
      'msg_1 is announced at its start and again when its final output lands; its two lines add nothing; '
      + 'the subagent and the synthetic message are not the phase\'s');
    assert.deepEqual(usages[0].call, { input: 2, cacheWrite: 101_653, cacheRead: 10_126, output: 4, context: 111_781 },
      'known the moment the call starts: the context is exact, the output a snapshot');
    assert.equal(usages[0].rebuild, false, 'the boot of a fresh session builds its cache');
    assert.equal(usages[0].totals.calls, 1);
    assert.deepEqual(usages[1].call, { input: 2, cacheWrite: 101_653, cacheRead: 10_126, output: 409, context: 111_781 },
      'the message_delta brings the final output count — the same call, not a second one');
    assert.equal(usages[1].totals.calls, 1);
    assert.equal(usages[1].totals.output, 409);
    assert.deepEqual(usages[2].totals, {
      calls: 2, lastContext: 125_096, peakContext: 125_096,
      input: 4, cacheWrite: 114_968, cacheRead: 121_905, output: 1_392, rebuilds: 0,
    });
    assert.deepEqual(outcome.tokens, usages[2].totals, 'the outcome carries what the stream last said');

    // Emitted before the turn's `step`, so a listener that reacts to the step
    // already sees the counters it produced.
    const firstUsage = events.findIndex((event) => event.kind === 'usage');
    const firstStep = events.findIndex((event) => event.kind === 'step');
    assert.ok(firstUsage >= 0 && firstUsage < firstStep, `usage precedes the step (${firstUsage} vs ${firstStep})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lane keeps the newest counters and shows them — with its status checks and its window', () => {
  const signals = newLaneSignals(1_000);
  assert.equal(livenessOf(1, signals).tokens, undefined, 'no call yet, nothing to show');

  const totals = {
    calls: 312, lastContext: 412_300, peakContext: 455_000,
    input: 900, cacheWrite: 700_000, cacheRead: 60_000_000, output: 90_000, rebuilds: 2,
  };
  applyEvent(signals, {
    kind: 'usage', id: 'msg_312', call: { input: 2, cacheWrite: 1_000, cacheRead: 411_298, output: 300, context: 412_300 },
    rebuild: false, totals,
  }, 2_000);
  signals.contextWindow = CONTEXT_WINDOW_1M;
  // Two status checks the poll-loop tracker counted for this lane.
  observeCall(signals.pollLoop!, { name: 'ListAgents', input: {} }, 3_000);
  observeCall(signals.pollLoop!, { name: 'ListAgents', input: {} }, 4_000);

  assert.deepEqual(livenessOf(1, signals).tokens, {
    context: 412_300, peak: 455_000, calls: 312, rebuilds: 2,
    input: 900, cacheRead: 60_000_000, cacheWrite: 700_000, output: 90_000,
    pollCalls: 2, window: CONTEXT_WINDOW_1M,
  }, 'under the wrap-up line the wire carries no stage');

  // A usage event is the session working: it stamps the productive clock.
  assert.equal(signals.lastProductiveAt, 2_000);

  // Past a line the wire names the stage, so no surface has to know the fractions.
  const at = (context: number): StreamEvent => ({
    kind: 'usage', id: `msg_${context}`, rebuild: false,
    call: { input: 2, cacheWrite: 1_000, cacheRead: context - 1_002, output: 300, context },
    totals: { ...totals, calls: totals.calls + 1, lastContext: context, peakContext: Math.max(context, totals.peakContext) },
  });
  applyEvent(signals, at(612_000), 5_000);
  assert.equal(livenessOf(1, signals).tokens?.stage, 'wrap-up');
  applyEvent(signals, at(812_000), 6_000);
  assert.equal(livenessOf(1, signals).tokens?.stage, 'checkpoint');
  signals.contextWindow = undefined;
  assert.equal(livenessOf(1, signals).tokens?.stage, undefined, 'no window, no stage');
  assert.equal(livenessOf(1, signals).tokens?.window, undefined);
});
