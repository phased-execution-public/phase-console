/**
 * The in-turn wait guard tells the session's OWN job from somebody else's clock
 * (one-pool phase 24, #260 #292; the class of the closed #121 and #179).
 *
 * #260 — control-tower P131 and P134, 2026-10-07: a session waited on its
 * validator with `while pgrep -f 'validate.sh control-tower'; do sleep 10;
 * done`. `-f` matches every process's full argument list, and the loop's own
 * shell carries that text, so the loop could never see zero matches: two loops
 * outlived the validator by eleven minutes, until a steer.
 *
 * #292 — ai-builder-v8 P29, 2026-10-09: a session started `task verify:local`
 * DETACHED, its exit code to `/tmp/ai-builder-v8-p29/ve.exit`, and waited with
 * bounded `until [ -f … ]` calls. At 45 minutes the console checkpointed it and
 * parked the run on a fixed 30-minute window; the job finished green a minute
 * later, and the run sat parked on a window it no longer needed.
 *
 *   IG-1  a wait on the session's own job — a sentinel file, its own pid — is
 *         allowed; a wait on somebody else's clock is refused;
 *   IG-2  a wait loop whose `pgrep -f` pattern matches its own command line is
 *         refused with the pid and sentinel forms that end, and the classic
 *         `[v]alidate.sh` spelling, a one-shot probe and a pid wait pass;
 *   IG-3  a DETACHED job's sentinel is worth a watch at the park — the job
 *         outlives the checkpoint — and a plain `&` job's is not (#121).
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const {
  applyEvent, detachedPathsOf, inTurnWait, mintWatchRef, newLaneSignals, selfMatchingProbe, waitScope, watchesDetachedJob,
} = await import('../server/runner/liveness.ts');
const { VERIFY_ENV_FALLBACK } = await import('../server/runner/verify-env.ts');
const { Service } = await import('../server/service.ts');

const flags = { port: 0, host: '127.0.0.1', open: false, allowWrites: false, scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null };
const ENV = VERIFY_ENV_FALLBACK;

/** The two command lines of #260, as the sessions ran them. */
const P131 = "while pgrep -f 'validate.sh control-tower'; do sleep 10; done";
const P134 = 'until ! pgrep -f "validate.sh control-tower" >/dev/null; do sleep 10; done; cat /tmp/bgqa4bsiz.output';
/** #292's bounded own-job wait, and the detached launch before it. */
const P29_WAIT = 'until [ -f /tmp/ai-builder-v8-p29/ve.exit ]; do sleep 10; done';
const P29_LAUNCH = 'nohup sh -c \'task verify:local > /tmp/ai-builder-v8-p29/ve.log 2>&1; echo $? > /tmp/ai-builder-v8-p29/ve.exit\' >/dev/null 2>&1 &';

type Noted = { event: string; data: Record<string, unknown>; phase?: number };

function laned(): { service: InstanceType<typeof Service>; noted: Noted[] } {
  const service = new Service(flags as never);
  const noted: Noted[] = [];
  (service as unknown as { runners: Map<string, unknown> }).runners.set('demo', {
    busy: () => true,
    current: () => ({ id: 'r1', slug: 'demo', activePhase: 2, permissionProfile: 'trusted', phases: {} }),
    note: (event: string, data: Record<string, unknown>, phase?: number) => noted.push({ event, data, phase }),
    noteWaitDenied: () => {},
    park: () => {},
    isSpending: () => false,
  });
  return { service, noted };
}

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });
async function decide(command: string): Promise<{ decision: string; reason: string; noted: Noted[] }> {
  const { service, noted } = laned();
  try {
    const reply = await service.decideToolUse(bash(command), 'r1') as { hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason?: string } };
    return { decision: reply.hookSpecificOutput?.permissionDecision ?? 'none', reason: reply.hookSpecificOutput?.permissionDecisionReason ?? '', noted };
  } finally {
    service.close();
  }
}

test('IG-1: a wait on the session’s own job is allowed; somebody else’s clock is refused', async () => {
  for (const own of [P29_WAIT, 'while kill -0 "$(cat /tmp/job.pid)"; do sleep 10; done', 'until grep -q "^EXIT=" /tmp/job.log; do sleep 10; done']) {
    assert.equal(waitScope(own), 'local', own);
    const { decision } = await decide(own);
    assert.notEqual(decision, 'deny', `the guard refused an own-job wait: ${own}`);
  }
  for (const theirs of ['gh run watch 42', 'until gh run view 1 --exit-status; do sleep 30; done']) {
    assert.ok(inTurnWait(theirs, ENV), theirs);
    assert.equal(waitScope(theirs), 'external', theirs);
    const { decision, reason } = await decide(theirs);
    assert.equal(decision, 'deny', theirs);
    assert.match(reason, /somebody else's clock/);
  }
});

test('IG-2: a wait loop whose pgrep -f matches its own command line is refused, with the forms that end (#260)', async () => {
  assert.equal(selfMatchingProbe(P131), 'validate.sh control-tower');
  assert.equal(selfMatchingProbe(P134), 'validate.sh control-tower');
  assert.equal(selfMatchingProbe('until ! pgrep -af -u me "npm test"; do sleep 3; done'), 'npm test', 'combined flags, and a flag that takes a value');
  // Neither of these can see itself.
  assert.equal(selfMatchingProbe("while pgrep -f '[v]alidate.sh control-tower'; do sleep 10; done"), null, 'the bracket spelling does not match its own text');
  assert.equal(selfMatchingProbe('while pgrep -x node; do sleep 5; done'), null, 'no -f: the process name, not its arguments');
  assert.equal(selfMatchingProbe('pgrep -f validate.sh'), null, 'a one-shot probe answers once and moves on');
  assert.equal(selfMatchingProbe('while kill -0 1234; do sleep 10; done'), null);

  for (const command of [P131, P134]) {
    const { decision, reason, noted } = await decide(command);
    assert.equal(decision, 'deny', command);
    assert.match(reason, /can never end/);
    assert.match(reason, /kill -0/, 'names the pid form');
    assert.match(reason, /until \[ -f \/tmp\/job\.exit \]/, 'and the sentinel form');
    const denied = noted.find((n) => n.event === 'phase.tool-denied');
    assert.equal(denied?.data.rule, 'in-turn-wait');
    assert.equal(denied?.data.selfMatch, true);
  }
  // The fixed spelling of the same wait passes the guard.
  const fixed = await decide("while pgrep -f '[v]alidate.sh control-tower' >/dev/null; do sleep 10; done");
  assert.notEqual(fixed.decision, 'deny');
});

test('IG-3: a detached job’s sentinel is worth a watch at the park; a plain & job’s is not (#292, #121)', () => {
  assert.deepEqual(detachedPathsOf(P29_LAUNCH).sort(), ['/tmp/ai-builder-v8-p29/ve.exit', '/tmp/ai-builder-v8-p29/ve.log']);
  assert.deepEqual(detachedPathsOf('task verify:local > /tmp/x.log 2>&1 &'), [], 'a plain & job dies with the session’s group');

  const minted = mintWatchRef(P29_WAIT);
  assert.equal(minted, 'cmd:"test -f /tmp/ai-builder-v8-p29/ve.exit"');

  // The launch's call comes back; its paths are the lane's.
  const signals = newLaneSignals(Date.parse('2026-10-09T07:50:00Z'));
  applyEvent(signals, { kind: 'tool', id: 't1', name: 'Bash', summary: P29_LAUNCH }, Date.parse('2026-10-09T07:50:01Z'), ENV);
  applyEvent(signals, { kind: 'tool-result', id: 't1', ok: true }, Date.parse('2026-10-09T07:50:02Z'), ENV);
  assert.equal(watchesDetachedJob(minted, signals), '/tmp/ai-builder-v8-p29/ve.exit');
  assert.equal(watchesDetachedJob('cmd:"test -f /tmp/other.exit"', signals), null, 'a file no detached job of its own names');

  const plain = newLaneSignals(Date.parse('2026-10-09T07:50:00Z'));
  applyEvent(plain, { kind: 'tool', id: 't1', name: 'Bash', summary: 'task verify:local > /tmp/ai-builder-v8-p29/ve.log 2>&1; echo $? > /tmp/ai-builder-v8-p29/ve.exit &' }, Date.parse('2026-10-09T07:50:01Z'), ENV);
  applyEvent(plain, { kind: 'tool-result', id: 't1', ok: true }, Date.parse('2026-10-09T07:50:02Z'), ENV);
  assert.equal(watchesDetachedJob(minted, plain), null, 'the checkpoint ends a plain background job — no watch on a file nothing will write');
});
