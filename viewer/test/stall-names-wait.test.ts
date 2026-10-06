/**
 * The stall detector names WHAT a quiet lane is waiting on (control-tower
 * phase 95, #138 AC-4).
 *
 * `silent` said "the oldest open tool call is Bash" — and a Bash call inside
 * `npm test`, inside `gh run watch` and inside a hung `ssh` are the same five
 * words. The call's own command is on the signals already (`spawn.ts`'s
 * summary); with nothing open, the last command is on the finished-call ring.
 * The episode now carries both, in its sentence and as a field, and the inbox
 * row a person reads names the command too.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildInbox, type InboxFacts } from '../server/inbox.ts';
import {
  applyEvent, creditHeldTime, evaluateStall, livenessOf, newLaneSignals, stallThresholds,
} from '../server/runner/liveness.ts';
import { VERIFY_ENV_FALLBACK } from '../server/runner/verify-env.ts';
import type { StreamEvent } from '../server/runner/spawn.ts';

const T0 = Date.parse('2026-09-26T10:00:00Z');
const MIN = 60_000;

function fold(events: [StreamEvent, number][]): ReturnType<typeof newLaneSignals> {
  const signals = newLaneSignals(T0);
  for (const [event, at] of events) applyEvent(signals, event, at);
  return signals;
}

test('AC-4: a lane silent inside an open call names the call\'s own command, in its sentence and as a field', () => {
  const signals = fold([
    [{ kind: 'tool', id: 't1', name: 'Bash', summary: 'npm --prefix viewer run test:client' }, T0 + MIN],
  ]);
  const stall = evaluateStall(signals, stallThresholds(), T0 + 16 * MIN);
  assert.equal(stall?.signal, 'silent');
  // The old words stay — surfaces match them — and the command follows.
  assert.match(stall!.detail, /oldest open tool call is Bash, out for 15 min/);
  assert.match(stall!.detail, /npm --prefix viewer run test:client/);
  assert.deepEqual(stall!.waitingOn, {
    tool: 'Bash', summary: 'npm --prefix viewer run test:client', open: true, since: new Date(T0 + MIN).toISOString(),
  });
});

test('AC-4: a lane silent with nothing open names the LAST command it ran and how that came back', () => {
  const signals = fold([
    [{ kind: 'tool', id: 't1', name: 'Bash', summary: 'git status' }, T0],
    [{ kind: 'tool-result', id: 't1', ok: true, detail: 'clean' }, T0 + 1000],
    [{ kind: 'tool', id: 't2', name: 'Bash', summary: 'git push origin pe/control-tower' }, T0 + MIN],
    [{ kind: 'tool-result', id: 't2', ok: false, detail: 'rejected' }, T0 + 2 * MIN],
  ]);
  const stall = evaluateStall(signals, stallThresholds(), T0 + 14 * MIN);
  assert.equal(stall?.signal, 'silent');
  assert.match(stall!.detail, /no tool call is open/);
  assert.match(stall!.detail, /git push origin pe\/control-tower/);
  assert.match(stall!.detail, /failed/);
  assert.deepEqual(stall!.waitingOn, {
    tool: 'Bash', summary: 'git push origin pe/control-tower', open: false, since: new Date(T0 + MIN).toISOString(), ok: false,
  });
});

test('AC-4: a lane that has run nothing at all says so, and invents no call', () => {
  const signals = fold([[{ kind: 'text', text: 'thinking out loud' }, T0]]);
  const stall = evaluateStall(signals, stallThresholds(), T0 + 11 * MIN);
  assert.match(stall!.detail, /no tool call is open/);
  assert.equal(stall!.waitingOn, undefined);
});

test('AC-4: the lane\'s wire view carries the last finished call, so a card can name it before any stall', () => {
  const signals = fold([
    [{ kind: 'tool', id: 't1', name: 'Bash', summary: 'npm ci', }, T0],
    [{ kind: 'tool-result', id: 't1', ok: true, detail: 'added 400 packages' }, T0 + MIN],
  ]);
  const view = livenessOf(3, signals);
  assert.deepEqual(view.lastCall, { tool: 'Bash', summary: 'npm ci', since: new Date(T0).toISOString(), ok: true });
});

test('#206: a call held on a person\'s card names its wait from when the card let it go, not from when it was asked', () => {
  const env = VERIFY_ENV_FALLBACK;
  const signals = newLaneSignals(T0);
  applyEvent(signals, {
    kind: 'tool', id: 't1', name: 'Bash', summary: 'until gh run view 77 --json status | grep -q completed; do sleep 30; done',
  }, T0, env);
  creditHeldTime(signals, { toolUseId: 't1', since: T0, until: T0 + 3 * MIN });
  const thresholds = stallThresholds();
  assert.notEqual(evaluateStall(signals, thresholds, T0 + 6 * MIN, { verifyEnv: env })?.signal, 'external-wait',
    'three of its six minutes were spent on the card');
  const stall = evaluateStall(signals, thresholds, T0 + 9 * MIN, { verifyEnv: env });
  assert.equal(stall?.signal, 'external-wait');
  assert.equal(stall!.since, new Date(T0 + 3 * MIN).toISOString(), 'the wait began when the card let the call go');
  assert.match(stall!.detail, /open for 6 min/);
  assert.match(stall!.detail, /gh run view 77/);
});

test('AC-4: the inbox row a person reads names the command the silent lane is inside', () => {
  const NOW = T0 + 60 * MIN;
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const facts = {
    runs: [{
      id: 'run-s', slug: 'demo', status: 'running',
      phases: {
        1: {
          phase: 1, status: 'running',
          liveness: {
            lastOutputAt: ago(40 * MIN), turnsSinceLastTool: 3,
            openTool: { id: 't9', name: 'Bash', since: ago(41 * MIN), summary: 'xcrun simctl io booted recordVideo sweep.mp4' },
          },
          stall: { signal: 'silent', since: ago(40 * MIN), detail: 'no output for 40 min' },
        },
      },
    }],
    plans: [{ slug: 'demo', updatedAt: ago(MIN) }],
    stalledPlans: [],
    flags: { allowWrites: true, allowRun: true },
    acks: {},
  } as unknown as InboxFacts;
  const { items } = buildInbox(facts, NOW);
  const silent = items.find((i) => i.kind === 'stall' && i.id.endsWith('session-silent'));
  assert.ok(silent, 'the silent row is raised');
  assert.match(silent!.need, /oldest open tool call is Bash/);
  assert.match(silent!.need, /xcrun simctl io booted recordVideo sweep\.mp4/);
});
