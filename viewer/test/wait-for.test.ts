/**
 * The long poll: `GET /api/run/:slug/wait?for=<predicate>&timeout=<s>`
 * (control-tower phase 98, #137 item 4, #144's `wait`).
 *
 * "There is no wait primitive": every verb acted at once, and the only
 * wait-like channel was the SSE stream — so each of the seven scripts of #137
 * polled `/api/runs` every 20 s for up to six hours. One request now answers
 * when the predicate holds, or when the timeout passes, whichever is first.
 *
 * BB-2: the wait answers the moment the predicate becomes true (not on a poll
 *       interval), at once when it already holds, `timedOut` when the clock
 *       runs out, and refuses a predicate it cannot judge by naming the
 *       grammar — the same grammar a trigger's `when` is written in.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { call, scratch, service } from './verb-harness.ts';

process.env.PHASE_CONSOLE_LOG = '';

const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');

function storedRun(root: string, status: string) {
  const state = newRun({ slug: 'alpha', root });
  state.status = status as typeof state.status;
  phaseRecord(state, 1).status = 'done';
  phaseRecord(state, 2).status = 'running';
  saveRun(state);
  return state;
}

test('BB-2: the wait answers when the predicate becomes true — not on the next poll', async () => {
  const root = scratch();
  const svc = await service(root);
  try {
    const run = storedRun(root, 'pausing');
    const waiting = call(svc, 'GET', '/api/run/alpha/wait?for=status:paused&timeout=20');
    await new Promise((resolve) => setTimeout(resolve, 150));
    run.status = 'paused';
    saveRun(run);
    svc.emit('run:run', { slug: 'alpha', state: run });
    const answer = await waiting;
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.held, true);
    assert.equal(answer.body.timedOut, false);
    assert.equal(answer.body.run.status, 'paused', 'the answer carries the run as it now stands');
    assert.ok(answer.body.waitedMs >= 100 && answer.body.waitedMs < 1_500, `answered after ${answer.body.waitedMs} ms`);
  } finally {
    svc.close();
  }
});

test('BB-2: a predicate already true answers at once; one that never holds times out', async () => {
  const root = scratch();
  const svc = await service(root);
  try {
    storedRun(root, 'paused');
    const now = await call(svc, 'GET', '/api/run/alpha/wait?for=run-paused&timeout=20');
    assert.equal(now.body.held, true);
    assert.ok(now.body.waitedMs < 500, `already true, answered after ${now.body.waitedMs} ms`);

    const done = await call(svc, 'GET', '/api/run/alpha/wait?for=phase-done:1&timeout=5');
    assert.equal(done.body.held, true, 'phase 1 reads done');
    const boarded = await call(svc, 'GET', '/api/run/alpha/wait?for=phase-boarded:2&timeout=5');
    assert.equal(boarded.body.held, true, 'phase 2 is running, so it has boarded');

    const started = Date.now();
    const never = await call(svc, 'GET', '/api/run/alpha/wait?for=phase-done:3&timeout=1');
    assert.equal(never.status, 200);
    assert.equal(never.body.held, false);
    assert.equal(never.body.timedOut, true);
    assert.ok(Date.now() - started >= 900, 'it waited out its timeout');
  } finally {
    svc.close();
  }
});

test('BB-2: a predicate the wait cannot judge is refused by name, with the grammar', async () => {
  const root = scratch();
  const svc = await service(root);
  try {
    storedRun(root, 'running');
    const bad = await call(svc, 'GET', '/api/run/alpha/wait?for=whenever&timeout=1');
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /unknown event "whenever"/);
    assert.match(bad.body.error, /status:<run status>/, 'the refusal names the grammar');

    const status = await call(svc, 'GET', '/api/run/alpha/wait?for=status:napping&timeout=1');
    assert.equal(status.status, 400);
    assert.match(status.body.error, /run status/);

    const edge = await call(svc, 'GET', '/api/run/alpha/wait?for=lane-boundary&timeout=1');
    assert.equal(edge.status, 400, 'an event is not a state to wait on');

    const phase = await call(svc, 'GET', '/api/run/alpha/wait?for=phase-done:x&timeout=1');
    assert.equal(phase.status, 400);

    const nobody = await call(svc, 'GET', '/api/run/nobody/wait?for=run-paused&timeout=1');
    assert.equal(nobody.status, 404);
  } finally {
    svc.close();
  }
});
