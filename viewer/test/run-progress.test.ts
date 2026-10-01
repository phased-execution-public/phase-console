/**
 * The frame that lets a surface move while a phase is working.
 *
 * Measured on a live console with two lanes mid-phase: 45 seconds of `/events`
 * carried 40 `run:stream` frames and nothing else that changes a cached view.
 * `run:stream` invalidates nothing on purpose — routing a firehose through the
 * query cache would refetch the whole run object per streamed line — and the
 * events that DO invalidate fire at phase boundaries, which on a plan like this
 * one is every twenty to seventy minutes. So the Runs list, the plan's Run tab,
 * the boards, the spend counters and the ETAs were correct at boot and then
 * again up to an hour later, and a reload "fixed" it because the server had
 * been right the whole time.
 *
 * The fix is not to invalidate on the firehose. It is a second, small, slow
 * event carrying exactly what those surfaces render, applied as a PATCH: no
 * round trip per line, and no surface that cannot move.
 *
 * Three claims, and the third is the one that keeps it cheap:
 *
 *   **RP-1** — the frame is the vocabulary, whole and nothing else, joined from
 *   the two halves that have it. `liveness()` knows output, tools, stalls,
 *   tokens and this session's dollars; the phase record knows its status, its
 *   attempt and its task counts. Neither alone is a progress frame.
 *
 *   **RP-2** — at most one per live lane per tick.
 *
 *   **RP-3** — and only when something actually moved. A lane that is thinking
 *   produces an identical digest every three seconds, and a run with no live
 *   lane at all produces nothing whatsoever.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RUN_PROGRESS_FIELDS } from '../shared/run-lifecycle.js';
import { progressDigest, progressFrame } from '../server/runner/runner-base.ts';
import type { LaneLiveness } from '../server/runner/liveness.ts';
import type { PhaseRecord } from '../server/runner/state.ts';

const liveness = (over: Partial<LaneLiveness> = {}): LaneLiveness => ({
  phase: 3,
  lastOutputAt: '2026-09-22T10:00:00.000Z',
  turnsSinceLastTool: 0,
  commitsSinceStart: 1,
  treeDirty: true,
  ...over,
});

const record = (over: Partial<PhaseRecord> = {}): PhaseRecord => ({
  phase: 3,
  status: 'running',
  attempts: 2,
  costUsd: 4.5,
  attemptStartedAt: '2026-09-22T09:40:00.000Z',
  tasks: [
    { id: 'p3.task1', content: 'read the snapshots', status: 'completed' },
    { id: 'p3.task2', content: 'cap the writer', status: 'in_progress' },
    { id: 'p3.task3', content: 'cache the parse', status: 'pending' },
  ],
  ...over,
} as PhaseRecord);

test('RP-1: a frame is the vocabulary, joined from the two halves that have it', () => {
  const frame = progressFrame(
    liveness({ spentUsd: 1.25, tokens: { context: 84_000 } as LaneLiveness['tokens'] }),
    record(),
  );

  assert.deepEqual(
    Object.keys(frame).sort(),
    [...RUN_PROGRESS_FIELDS].sort(),
    'the wire is the vocabulary — no field a reader has to guess at, none it cannot use',
  );
  assert.equal(frame.phase, 3);
  // From the record, which `liveness()` does not carry:
  assert.equal(frame.status, 'running');
  assert.equal(frame.attempt, 2);
  assert.equal(frame.attemptStartedAt, '2026-09-22T09:40:00.000Z');
  assert.deepEqual(
    frame.tasks,
    { total: 3, done: 1, active: 'cap the writer' },
    'the counts AND the line a surface prints — "1/3 · cap the writer" is what goes stale',
  );
  // …and from liveness, which the record does not carry live:
  assert.equal(frame.spentUsd, 1.25, 'this session\'s unbooked dollars, not the checkpoint\'s');
  assert.equal(frame.contextTokens, 84_000);
  assert.equal(frame.stall, null);

  const stalled = progressFrame(
    liveness({ stall: { signal: 'silent', since: '2026-09-22T09:58:00.000Z' } as LaneLiveness['stall'] }),
    record(),
  );
  assert.equal(stalled.stall, 'silent', 'the signal alone — the episode itself has its own event');
});

test('RP-2 / RP-3: the digest moves only when the frame does', () => {
  const before = progressFrame(liveness({ spentUsd: 1 }), record());
  const same = progressFrame(liveness({ spentUsd: 1 }), record());
  assert.equal(
    progressDigest(before),
    progressDigest(same),
    'a lane that is thinking produces an identical frame every three seconds, and it is not news',
  );

  // `lastOutputAt` is deliberately NOT in the frame: it moves on every line,
  // and a digest that moved with it would emit on every tick forever, which is
  // the firehose again under a slower name.
  const talking = progressFrame(
    liveness({ spentUsd: 1, lastOutputAt: '2026-09-22T10:00:03.000Z' }),
    record(),
  );
  assert.equal(progressDigest(talking), progressDigest(before), 'output alone is not progress');

  for (const [what, moved] of [
    ['a task finished', progressFrame(liveness({ spentUsd: 1 }), record({
      tasks: [
        { id: 'p3.task1', content: 'read the snapshots', status: 'completed' },
        { id: 'p3.task2', content: 'cap the writer', status: 'completed' },
        { id: 'p3.task3', content: 'cache the parse', status: 'in_progress' },
      ],
    } as Partial<PhaseRecord>))],
    ['it spent something', progressFrame(liveness({ spentUsd: 1.5 }), record())],
    ['the attempt changed', progressFrame(liveness({ spentUsd: 1 }), record({ attempts: 3 }))],
    ['the status changed', progressFrame(liveness({ spentUsd: 1 }), record({ status: 'verifying' }))],
    ['a stall opened', progressFrame(
      liveness({ spentUsd: 1, stall: { signal: 'silent', since: 'x' } as LaneLiveness['stall'] }),
      record(),
    )],
  ] as const) {
    assert.notEqual(progressDigest(moved), progressDigest(before), `${what} IS news`);
  }
});
