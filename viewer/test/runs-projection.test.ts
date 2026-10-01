/**
 * `GET /api/runs` is bounded (control-tower phase 98; #75's 2026-09-24T17:08:10Z
 * comment).
 *
 * The runs list answers every run of every plan, whole: on the hub 4.9 MB,
 * because a record carries each phase's attempts, rungs, liveness snapshots,
 * notes and manifest. The supervising scripts of #137 read it every 20 seconds
 * to learn one word — is the run paused yet? — and #75's close left it so.
 *
 * RB-1: `?latest=1&slug=<slug>` answers that plan's LATEST run only, and
 *       `?latest=1` one row per plan — in the slim projection.
 * RB-2: the slim projection is status, halt, children, liveness and one word
 *       per phase — a small fraction of the whole list's bytes — and it is what
 *       the long poll answers with, so `run status` and `run wait` print one
 *       shape.
 * RB-3: the slim row carries the run's lifecycle, so `runStatusWord` reads a
 *       paused run asleep on a clock nobody paused as `waiting` off it — the
 *       word every other surface prints since phase 88.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { call, scratch, service } from './verb-harness.ts';

process.env.PHASE_CONSOLE_LOG = '';

const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { SLIM_RUN_FIELDS } = await import('../server/runs-projection.ts');
const { runStatusWord } = await import('../shared/status-vocab.js');

const BETA = `---
slug: beta
created: 2026-09-27
status: active
phases: 1
---

# beta

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | only | — | — | app | it works |

## Phases

### Phase 1 — only
- **Size:** S
`;

/** `count` stored runs of `slug`, oldest first, each record carrying the bulk a real one does. */
function history(root: string, slug: string, count: number, lastStatus: string) {
  const runs = [];
  for (let i = 0; i < count; i += 1) {
    const state = newRun({ slug, root });
    const at = new Date(Date.UTC(2026, 8, 20, 8, i)).toISOString();
    state.createdAt = at;
    state.updatedAt = at;
    state.status = i === count - 1 ? (lastStatus as typeof state.status) : 'finished';
    for (const phase of [1, 2, 3]) {
      const record = phaseRecord(state, phase);
      record.status = 'done';
      // What makes the real list heavy: every record's own history.
      record.note = `attempt notes ${'x'.repeat(4_000)}`;
    }
    saveRun(state);
    runs.push(state);
  }
  return runs;
}

test('RB-1: ?latest=1&slug=<slug> answers that plan\'s latest run alone; ?latest=1 one row per plan', async () => {
  const root = scratch({ beta: BETA });
  const svc = await service(root);
  try {
    const alpha = history(root, 'alpha', 12, 'paused');
    const beta = history(root, 'beta', 3, 'halted');

    const one = await call(svc, 'GET', '/api/runs?latest=1&slug=alpha');
    assert.equal(one.status, 200);
    assert.equal(one.body.length, 1, 'one plan, one row');
    assert.equal(one.body[0].id, alpha.at(-1)!.id, 'the newest run of the plan');
    assert.equal(one.body[0].status, 'paused');

    const each = await call(svc, 'GET', '/api/runs?latest=1');
    assert.deepEqual(
      each.body.map((row: { slug: string; id: string }) => [row.slug, row.id]).sort(),
      [['alpha', alpha.at(-1)!.id], ['beta', beta.at(-1)!.id]].sort(),
      'the latest run of every plan, and nothing older',
    );

    const none = await call(svc, 'GET', '/api/runs?latest=1&slug=nobody');
    assert.deepEqual(none.body, [], 'a plan with no run is an empty list, not an error');
  } finally {
    svc.close();
  }
});

test('RB-2: the slim projection is status, halt, children, liveness and a word per phase — a fraction of the whole list', async () => {
  const root = scratch();
  const svc = await service(root);
  try {
    const runs = history(root, 'alpha', 12, 'halted');
    const latest = runs.at(-1)!;
    latest.halt = { reason: 'verification failed', phase: 2, kind: 'verify-failed' } as typeof latest.halt;
    saveRun(latest);

    const whole = await call(svc, 'GET', '/api/runs');
    const started = performance.now();
    const slim = await call(svc, 'GET', '/api/runs?latest=1&slug=alpha');
    const tookMs = performance.now() - started;

    const row = slim.body[0];
    assert.deepEqual(Object.keys(row).sort(), [...SLIM_RUN_FIELDS].sort(), 'the slim shape, exactly');
    assert.equal(row.status, 'halted');
    assert.equal(row.halt.kind, 'verify-failed');
    assert.deepEqual(row.children, {});
    assert.ok(Array.isArray(row.liveness));
    assert.deepEqual(row.phases, { 1: 'done', 2: 'done', 3: 'done' }, 'one word per phase — not the phase records');
    assert.equal(JSON.stringify(row).includes('attempt notes'), false, 'no record bulk rides the slim row');

    assert.ok(whole.bytes > 100_000, `the whole list is the heavy one (${whole.bytes} B)`);
    assert.ok(slim.bytes * 50 < whole.bytes, `slim ${slim.bytes} B against the whole ${whole.bytes} B`);
    assert.ok(tookMs < 500, `the bounded read answered in ${tookMs.toFixed(1)} ms`);

    // `?view=slim` is the same shape over every run.
    const every = await call(svc, 'GET', '/api/runs?view=slim');
    assert.equal(every.body.length, 12);
    for (const one of every.body) assert.deepEqual(Object.keys(one).sort(), [...SLIM_RUN_FIELDS].sort());

    // The long poll answers with the very same row.
    const waited = await call(svc, 'GET', '/api/run/alpha/wait?for=status:halted&timeout=1');
    assert.equal(waited.status, 200);
    assert.deepEqual(waited.body.run, row, 'run wait prints what run status prints');
  } finally {
    svc.close();
  }
});

test('RB-3: a paused run asleep on a clock nobody paused reads `waiting` off its slim row through runStatusWord — the word every surface prints (phase 88, #148)', async () => {
  const root = scratch({ beta: BETA });
  const svc = await service(root);
  try {
    const [asleep] = history(root, 'alpha', 1, 'paused');
    asleep.stoppedBy = 'system';
    asleep.waitReason = 'usage-limit';
    asleep.waitUntil = new Date(Date.now() + 3_600_000).toISOString();
    saveRun(asleep);
    const [held] = history(root, 'beta', 1, 'paused');
    held.stoppedBy = 'operator';
    saveRun(held);

    const slim = await call(svc, 'GET', '/api/runs?view=slim');
    const rowOf = (id: string) => slim.body.find((one: { id: string }) => one.id === id);
    assert.equal(rowOf(asleep.id).status, 'paused', 'the stored word stands — the resume machinery keys on it');
    assert.equal(rowOf(asleep.id).lifecycle.state, 'waiting');
    assert.equal(runStatusWord(rowOf(asleep.id)), 'waiting');
    assert.equal(runStatusWord(rowOf(held.id)), 'paused', "a person's pause is still a pause");
  } finally {
    svc.close();
  }
});
