/**
 * A run's hook token lives while its child does (control-tower phase 49, #74).
 *
 * The token is baked into a session's `--settings` at spawn and cannot be
 * reloaded. When a run's loop ended while a recovery's resumed session still
 * ran, the loop-end path disarmed the token under it: for an hour every
 * PreToolUse call that session made was answered 401 — and the CLI does not
 * treat a failed hook as a refusal, so it worked with no policy at all.
 *
 *   TL-1 — the token stays armed while any child launched under it lives, and
 *          is retired once the last one has gone;
 *   TL-2 — the loop that ends ADOPTS that child: the one release every ending
 *          calls keeps the token, and journals it once;
 *   TL-3 — a 401 from a known session is a run-level fault: journalled on the
 *          run once, and standing in the inbox as a health row.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildInbox } from '../server/inbox.ts';
import { Approvals, type TokenHolder } from '../server/runner/approvals.ts';
import { RunnerControl } from '../server/runner/runner-control.ts';
import { ServiceBase } from '../server/service-base.ts';

const SERVER = fileURLToPath(new URL('../server/', import.meta.url));

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-token-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function sleeper(): { pid: number; stop: () => Promise<void> } {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return { pid: child.pid!, stop: async () => { child.kill('SIGKILL'); await exited; } };
}

/* ---------------- TL-1 ---------------- */

test('TL-1: a released token stays armed while a holder lives, and the sweep retires it when the last one goes', () => {
  const { dir, cleanup } = scratch();
  try {
    const living = new Set([101]);
    const approvals = new Approvals({ holderAlive: (holder: TokenHolder) => living.has(holder.pid) }, join(dir, 'pending.json'));
    const token = approvals.arm('r1');
    assert.equal(approvals.release('r1', [{ pid: 101 }, { pid: 102 }]), 'kept');
    assert.ok(approvals.verify(`Bearer ${token}`), 'the child still holding it is still answered');
    assert.deepEqual(approvals.heldTokens(), [{ runId: 'r1', pids: [101] }], 'only the living hold it');
    assert.deepEqual(approvals.sweepHeld(), [], 'nothing retired while 101 lives');

    living.delete(101);
    assert.deepEqual(approvals.sweepHeld(), ['r1']);
    assert.equal(approvals.verify(`Bearer ${token}`), false, 'retired with its last holder');
    assert.deepEqual(approvals.heldTokens(), []);

    // No holder at all is the ending it always was.
    const other = approvals.arm('r2');
    assert.equal(approvals.release('r2', []), 'disarmed');
    assert.equal(approvals.verify(`Bearer ${other}`), false);

    // A run a loop drives again owns its token once more: the sweep leaves it to that loop.
    living.add(103);
    const again = approvals.arm('r3');
    approvals.release('r3', [{ pid: 103 }]);
    living.delete(103);
    assert.deepEqual(approvals.sweepHeld(new Set(['r3'])), []);
    assert.ok(approvals.verify(`Bearer ${again}`));
    assert.deepEqual(approvals.heldTokens(), [], 'and forgets the hold');
  } finally { cleanup(); }
});

test('TL-1: on a real process — kept while it runs, retired once it has exited', async () => {
  const { dir, cleanup } = scratch();
  const child = sleeper();
  try {
    const approvals = new Approvals(() => {}, join(dir, 'pending.json'));
    const token = approvals.arm('r1');
    assert.equal(approvals.release('r1', [{ pid: child.pid }]), 'kept');
    assert.deepEqual(approvals.sweepHeld(), []);
    assert.ok(approvals.verify(`Bearer ${token}`));
    await child.stop();
    assert.deepEqual(approvals.sweepHeld(), ['r1']);
    assert.equal(approvals.verify(`Bearer ${token}`), false);
  } finally { await child.stop().catch(() => {}); cleanup(); }
});

/* ---------------- TL-2 ---------------- */

type Releaser = { releaseRunToken: (state: unknown) => void };
const releaseRunToken = (RunnerControl.prototype as unknown as Releaser).releaseRunToken;

test('TL-2: the loop that ends adopts a surviving child — its token is kept and journalled once, however many endings run', async () => {
  const { dir, cleanup } = scratch();
  const child = sleeper();
  try {
    const approvals = new Approvals(() => {}, join(dir, 'pending.json'));
    const token = approvals.arm('run-a');
    const journal: { event: string; data: Record<string, unknown> }[] = [];
    const runner = { deps: { approvals }, record: (event: string, data: Record<string, unknown>) => journal.push({ event, data }) };
    const state = { id: 'run-a', children: { 9: { pid: child.pid, phase: 9 } } };
    // The loop's own ending, then `drive().finally` — both release; one line.
    releaseRunToken.call(runner, state);
    releaseRunToken.call(runner, state);
    assert.ok(approvals.verify(`Bearer ${token}`), 'the adopted child keeps its hooks');
    assert.deepEqual(journal, [{ event: 'run.token-kept', data: { pids: [child.pid] } }]);

    // Nothing survives: the ending is the old one, and says nothing.
    await child.stop();
    const quiet = { id: 'run-a', children: {} };
    releaseRunToken.call(runner, quiet);
    assert.equal(approvals.verify(`Bearer ${token}`), false);
    assert.equal(journal.length, 1);
  } finally { await child.stop().catch(() => {}); cleanup(); }
});

test('TL-2: every loop ending releases through the one helper — no bare disarm is left on a runner path', () => {
  const read = (name: string) => readFileSync(join(SERVER, 'runner', name), 'utf8');
  for (const name of ['runner-loop.ts', 'runner-control.ts', 'runner-attempt.ts', 'runner.ts']) {
    assert.doesNotMatch(read(name), /approvals\??\.disarm\(/, `${name} must release, never disarm, a run's token`);
  }
  const control = read('runner-control.ts');
  assert.match(control, /protected disarmRecovery\(state: RunState\): void \{[\s\S]{0,200}this\.releaseRunToken\(state\)/, 'a recovery\'s ending');
  assert.match(control, /this\.driving = this\.drive\(\)\.finally\([\s\S]{0,700}this\.releaseRunToken\(this\.state\)/, 'drive().finally');
  assert.match(read('runner-loop.ts'), /this\.releaseRunToken\(state\);/, 'the loop\'s own ending');
});

/* ---------------- TL-3 ---------------- */

type FaultService = {
  noteHookUnauthorised: (hook: string, body: unknown, reason: string) => void;
  hookFaultFacts: () => { runId: string; sessionId: string; count: number; phase?: number }[];
};
const service = ServiceBase.prototype as unknown as FaultService;

function faultHost(presence: { value: string }) {
  const notes: { event: string; data: Record<string, unknown>; phase?: number }[] = [];
  const state = { id: 'run-obs', slug: 'observability-plane', phases: { 9: { phase: 9, sessionId: 'a8cb9a15-resumed' } } };
  const host = {
    hookFaults: new Map(),
    hookStrangers: new Set<string>(),
    sessions: {
      get: (id: string) => (id === 'owned-only' ? { owner: 'autopilot/run-obs' } : undefined),
      presence: () => presence.value,
    },
    runners: new Map([['observability-plane', {
      current: () => state,
      note: (event: string, data: Record<string, unknown>, phase?: number) => notes.push({ event, data, phase }),
    }]]),
    approvals: { liveToken: () => null },
    root: null,
    emit: () => {},
  };
  return { host, notes };
}

test('TL-3: a 401 from a session one of our runs launched is a run-level fault — journalled once, counted, and gone when the session ends', () => {
  const presence = { value: 'live' };
  const { host, notes } = faultHost(presence);
  for (let i = 0; i < 3; i++) service.noteHookUnauthorised.call(host, 'pre-tool-use', { session_id: 'a8cb9a15-resumed', tool_name: 'Bash' }, 'bad token');
  assert.deepEqual(notes, [{
    event: 'run.hook-unauthorised',
    data: { sessionId: 'a8cb9a15-resumed', hook: 'pre-tool-use', reason: 'bad token', armed: false },
    phase: 9,
  }], 'journalled on the run once, at its phase');
  const facts = service.hookFaultFacts.call(host);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].count, 3, 'every refusal counted');
  assert.equal(facts[0].runId, 'run-obs');

  // Known by its owner alone (the registry's `autopilot/<runId>`), with no phase record naming it.
  service.noteHookUnauthorised.call(host, 'stop', { session_id: 'owned-only' }, 'no run is armed');
  assert.equal(notes.length, 2);
  assert.equal(notes[1].phase, undefined);

  // A session nobody here launched stays the log line it was.
  service.noteHookUnauthorised.call(host, 'pre-tool-use', { session_id: 'somebody-else' }, 'bad token');
  service.noteHookUnauthorised.call(host, 'pre-tool-use', { tool_name: 'Bash' }, 'bad token');
  assert.equal(notes.length, 2);
  assert.equal(service.hookFaultFacts.call(host).length, 2);

  presence.value = 'ended';
  assert.deepEqual(service.hookFaultFacts.call(host), [], 'an ended session takes its row with it');
});

test('TL-3: the fault stands in the inbox as a health row naming the run, the session and the count', () => {
  const view = buildInbox({
    hookFaults: [{
      runId: 'run-obs', slug: 'observability-plane', phase: 9, sessionId: 'a8cb9a15-resumed',
      hook: 'pre-tool-use', count: 57, since: '2026-09-23T09:12:21.000Z',
    }],
  }, Date.parse('2026-09-23T10:12:41.000Z'));
  const row = view.items.find((item) => item.kind === 'health');
  assert.ok(row, 'a health row');
  assert.equal(row!.severity, 'needs-you');
  assert.match(row!.title, /observability-plane/);
  assert.match(String(row!.need), /a8cb9a15 \(phase 9\).*57 times/);
});
