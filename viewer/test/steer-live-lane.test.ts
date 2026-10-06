/**
 * A live lane keeps its handle (control-tower phase 109, #170).
 *
 * hub 0598886e, tamagui-upgrade P6 and ai-builder-v7 P7/P10: `POST
 * /api/run/<slug>/steer` answered 409 "no session is running just now — the
 * run is between phases, or verifying" while `/api/runs` showed the phase's
 * child alive and working. The handle was closed on purpose: `spawn.ts` closed
 * stdin at the FIRST `result` whenever nothing of the operator's was in flight
 * — but a session that ended its turn to wait on its own background agent (wait
 * rule 4) runs on, each notification a new turn doing real work, deaf to every
 * steer, ask, peer message and wrap-up notice. Nothing journalled the close.
 *
 *   LL-1  a steer, ask or message to a lane whose child lives is delivered, or
 *         refused naming the real state — "phase 6's session (pid 7529) is
 *         running, but its input closed at <t> (<cause>)" — never "no session
 *         is running"; a child another console started is "adopted … with no
 *         input pipe";
 *   LL-2  the moment a lane's input closes the stream says so with its cause
 *         (`input-closed`: turn-end, idle, epipe, abort, background-ceiling),
 *         and the runner journals `phase.input-closed`;
 *   LL-3  the input is HELD open past a turn while the session's own agent
 *         works, so a steer reaches it; the turn after the agent reports closes
 *         it; the Pro mailbox reaches a closed lane over the CLI inbox it polls
 *         (`mailbox.test.ts`), and the lane view marks it unreachable.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { spawnClaude, INPUT_CLOSE_CAUSES } = await import('../server/runner/spawn.ts');
const { frameSteer } = await import('../server/runner/runner-core.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { newRun, phaseRecord } = await import('../server/runner/state.ts');
const { newLaneSignals } = await import('../server/runner/liveness.ts');
import type { SpawnHandle, StreamEvent } from '../server/runner/spawn.ts';

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

/**
 * A `claude` that speaks the stream: init, then one turn per user line. With
 * `PC_STUB_BG` its first turn starts a background agent (`system/task_started`,
 * `local_agent`) and ends; the agent reports `PC_STUB_BG_MS` later, which
 * starts the next turn. It exits when its stdin ends — exactly the CLI's `-p`
 * shape, which is why the console's close decides when a session may end.
 */
const STUB = `#!/usr/bin/env node
'use strict';
const sid = '66666666-0000-0000-0000-000000007529';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let turn = 0;
const result = () => say({ type: 'result', subtype: 'success', is_error: false, num_turns: turn, total_cost_usd: 0.01, session_id: sid, result: 'ok' });
say({ type: 'system', subtype: 'init', session_id: sid, model: 'stub-1', tools: [] });
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let message; try { message = JSON.parse(line); } catch { continue; }
    const text = (message.message && message.message.content || []).map((b) => b.text).join('');
    turn += 1;
    say({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'text', text }] } });
    if (turn === 1 && process.env.PC_STUB_BG) {
      say({ type: 'assistant', session_id: sid, message: { id: 'm1', role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_bg', name: 'Agent', input: { description: 'free the simulator', run_in_background: true } }] } });
      say({ type: 'system', subtype: 'task_started', task_id: 'task-bg', task_type: 'local_agent', tool_use_id: 'toolu_bg', description: 'free the simulator', session_id: sid });
      // A background agent that keeps talking: its lines carry its parent call.
      if (process.env.PC_STUB_BG_CHATTER) {
        let n = 0;
        setInterval(() => say({ type: 'assistant', session_id: sid, parent_tool_use_id: 'toolu_bg',
          message: { id: 'sub' + (n += 1), role: 'assistant', content: [{ type: 'text', text: 'still freeing it' }] } }), 40);
      }
      setTimeout(() => {
        say({ type: 'system', subtype: 'task_notification', task_id: 'task-bg', status: 'completed', session_id: sid });
        turn += 1;
        say({ type: 'assistant', session_id: sid, message: { id: 'm9', role: 'assistant', content: [{ type: 'text', text: 'the agent reported' }] } });
        result();
      }, Number(process.env.PC_STUB_BG_MS || 400));
    }
    say({ type: 'assistant', session_id: sid, message: { id: 'm' + turn, role: 'assistant', content: [{ type: 'text', text: 'turn ' + turn }] } });
    result();
  }
});
process.stdin.on('end', () => process.exit(0));
`;

function bench(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-ll-'));
  TRASH.push(dir);
  writeFileSync(join(dir, 'claude'), STUB, 'utf8');
  chmodSync(join(dir, 'claude'), 0o755);
  return { dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, ...extra } };
}

const closed = (events: StreamEvent[]) => events.filter((e) => e.kind === 'input-closed') as Extract<StreamEvent, { kind: 'input-closed' }>[];

/* ------------------------------------------------------------------ *
 * LL-2 / LL-3 — the input, held and closed, with its cause
 * ------------------------------------------------------------------ */

test('LL-2: a session whose first turn leaves nothing behind has its input closed at that result — and says so, cause turn-end', async () => {
  const b = bench();
  const events: StreamEvent[] = [];
  const outcome = await spawnClaude({ prompt: 'BOOT phase 6', cwd: b.dir, env: b.env, onEvent: (e) => events.push(e) });
  assert.equal(outcome.signal.subtype, 'success');
  const close = closed(events);
  assert.equal(close.length, 1, 'said once');
  assert.equal(close[0]!.cause, 'turn-end');
  assert.ok(Number.isFinite(Date.parse(close[0]!.at)), 'with the moment it closed');
  assert.deepEqual([...INPUT_CLOSE_CAUSES], ['turn-end', 'idle', 'epipe', 'abort', 'background-ceiling', 'adopted']);
});

test('LL-3: the input is held while the session\'s own agent works — a steer sent after the first result is DELIVERED, and the turn after the agent reports closes it', async () => {
  const b = bench({ PC_STUB_BG: '1', PC_STUB_BG_MS: '700' });
  const events: StreamEvent[] = [];
  let handle: SpawnHandle | undefined;
  let sentAfterFirstResult: boolean | undefined;
  let openAfterFirstResult: boolean | undefined;
  const outcome = await spawnClaude({
    prompt: 'BOOT phase 6', cwd: b.dir, env: b.env,
    onHandle: (h) => { handle = h; },
    onEvent: (e) => {
      events.push(e);
      if (e.kind === 'result' && openAfterFirstResult === undefined) {
        // The boot turn's result: the session is now waiting on its agent.
        setImmediate(() => {
          openAfterFirstResult = handle!.open();
          sentAfterFirstResult = handle!.send(frameSteer('free the iOS simulator before the Android sweep', '[[steer:ab12cd34]]'));
        });
      }
    },
  });
  assert.equal(openAfterFirstResult, true, 'the first result did NOT close the input: the session\'s own agent is still working');
  assert.equal(sentAfterFirstResult, true, 'the steer was written to the live session');
  const echoed = events.filter((e) => e.kind === 'injected' && e.mark === 'steer:ab12cd34');
  assert.equal(echoed.length, 1, 'the CLI echoed it back: it arrived');
  const close = closed(events);
  assert.equal(close.length, 1);
  assert.equal(close[0]!.cause, 'turn-end', 'closed by the turn after the agent reported, nothing left to wake it');
  assert.ok(events.findIndex((e) => e.kind === 'background' && e.op === 'ended') < events.indexOf(close[0]!), 'and only after it reported');
  assert.equal(outcome.signal.subtype, 'success', 'the session then ended by itself');
});

test('LL-3: the hold is bounded — no new turn within the CLI\'s background ceiling closes the input as `background-ceiling`', async () => {
  const b = bench({ PC_STUB_BG: '1', PC_STUB_BG_MS: '60000' });
  const events: StreamEvent[] = [];
  const outcome = spawnClaude({ prompt: 'BOOT phase 6', cwd: b.dir, env: b.env, bgWaitCeilingMs: 300, onEvent: (e) => events.push(e) });
  const settled = await outcome;
  const close = closed(events);
  assert.equal(close.length, 1);
  assert.equal(close[0]!.cause, 'background-ceiling');
  assert.equal(settled.signal.subtype, 'success');
});

test('LL-3: a background agent\'s own chatter does not stretch the hold — its clock closes the input at the ceiling all the same', async () => {
  const b = bench({ PC_STUB_BG: '1', PC_STUB_BG_MS: '60000', PC_STUB_BG_CHATTER: '1' });
  const events: StreamEvent[] = [];
  const settled = await spawnClaude({ prompt: 'BOOT phase 6', cwd: b.dir, env: b.env, bgWaitCeilingMs: 300, onEvent: (e) => events.push(e) });
  assert.ok(events.filter((e) => e.kind === 'subagent').length >= 3, 'the agent was talking the whole time');
  const close = closed(events);
  assert.equal(close.length, 1);
  assert.equal(close[0]!.cause, 'background-ceiling', 'an agent that never stops talking cannot hold a session open for ever');
  assert.equal(settled.signal.subtype, 'success');
});

test('LL-3: a frozen lane\'s hold does not run out under the freeze — its clock starts again at the thaw', async () => {
  const b = bench({ PC_STUB_BG: '1', PC_STUB_BG_MS: '60000' });
  const events: StreamEvent[] = [];
  let handle: SpawnHandle | undefined;
  let openThroughFreeze: boolean | undefined;
  const done = spawnClaude({
    prompt: 'BOOT phase 6', cwd: b.dir, env: b.env, bgWaitCeilingMs: 250,
    onHandle: (h) => { handle = h; },
    onEvent: (e) => {
      events.push(e);
      if (e.kind === 'result' && !handle?.['frozenOnce' as never]) {
        (handle as unknown as Record<string, unknown>).frozenOnce = true;
        handle!.setFrozen(true);
        setTimeout(() => { openThroughFreeze = handle!.open() && !closed(events).length; handle!.setFrozen(false); }, 600);
      }
    },
  });
  const settled = await done;
  assert.equal(openThroughFreeze, true, 'past the ceiling while frozen, and the input still open');
  const close = closed(events);
  assert.equal(close.length, 1);
  assert.equal(close[0]!.cause, 'background-ceiling', 'closed by the clock that restarted at the thaw');
  assert.equal(settled.signal.subtype, 'success');
});

/* ------------------------------------------------------------------ *
 * LL-1 — a refusal names the session's real state
 * ------------------------------------------------------------------ */

type Probe = InstanceType<typeof Runner> & Record<string, unknown>;

/** A runner driving one run, its lanes written by the test. */
function driving(): Probe {
  const runner = new Runner({ scriptsDir: '/nonexistent', spawn: async () => { throw new Error('no spawn'); }, verificationText: () => '' } as never) as Probe;
  const state = newRun({ slug: 'tamagui-upgrade', root: '/tmp/nowhere' } as never);
  state.status = 'running';
  state.activePhase = 6;
  phaseRecord(state, 6).status = 'running';
  runner.state = state;
  runner.record = () => {};
  runner.persist = () => {};
  runner.emit = () => {};
  (runner as unknown as { driving: boolean }).driving = true;
  return runner;
}

const closedHandle = (pid: number): SpawnHandle => ({ pid, open: () => false, send: () => false } as unknown as SpawnHandle);

test('LL-1: a steer, an ask and a message to a live lane whose input closed are refused with its real state — never "no session is running"', () => {
  const runner = driving();
  const lanes = (runner as unknown as { lanes: Map<number, Record<string, unknown>> }).lanes;
  lanes.set(6, { phase: 6, pid: 7529, handle: closedHandle(7529), inputClosed: { at: '2026-09-28T07:12:04.000Z', cause: 'turn-end' }, grant: null });
  const steer = runner.steer('free the simulator', 'watchdog', undefined, 6);
  assert.equal(steer.ok, false);
  assert.equal(steer.unreachable, true);
  assert.equal(steer.reason,
    'phase 6\'s session (pid 7529) is running, but its input closed at 07:12:04Z (its turn ended with nothing outstanding and nothing of its own in the background) — it cannot take messages now, and ends at the end of its turn');
  const ask = runner.ask('are you on the Android sweep?', 'operator', undefined, 6);
  assert.match(ask.reason ?? '', /^phase 6's session \(pid 7529\) is running, but its input closed/);
  assert.equal(runner.tellMessage(6, '[[msg:abc]] a peer note'), false, 'a peer message is not written either');
  for (const answer of [steer, ask]) assert.doesNotMatch(answer.reason ?? '', /no session is running/);
  // Each cause in its own words.
  lanes.set(6, { phase: 6, pid: 7529, handle: closedHandle(7529), inputClosed: { at: '2026-09-28T07:40:00.000Z', cause: 'idle' }, grant: null });
  assert.match(runner.steer('x', 'watchdog', undefined, 6).reason ?? '', /\(the idle closer: it stopped streaming with its input open\)/);
  lanes.set(6, { phase: 6, pid: 7529, handle: closedHandle(7529), inputClosed: { at: '2026-09-28T07:40:00.000Z', cause: 'epipe' }, grant: null });
  assert.match(runner.steer('x', 'watchdog', undefined, 6).reason ?? '', /\(the pipe broke \(EPIPE\)\)/);
});

test('LL-1: a lane still starting says so; a live child another console started is named "adopted … with no input pipe"', () => {
  const runner = driving();
  const lanes = (runner as unknown as { lanes: Map<number, Record<string, unknown>> }).lanes;
  lanes.set(6, { phase: 6, pid: 7529, handle: null, grant: null });
  assert.equal(runner.steer('x', 'watchdog', undefined, 6).reason, 'phase 6\'s session (pid 7529) is starting — its input is not open yet; send it again in a moment');
  // Between sessions — verifying, a closeout to come, a retry's back-off — the
  // lane stands with no process, and the old words are the true ones.
  lanes.set(6, { phase: 6, pid: null, handle: null, grant: null, inputClosed: { at: '2026-09-28T07:12:04.000Z', cause: 'turn-end' } });
  assert.equal(runner.steer('x', 'watchdog', undefined, 6).reason, 'no session is running just now — the run is between phases, or verifying');
  lanes.delete(6);
  const state = runner.state as ReturnType<typeof newRun>;
  // This test process is the "live child": a process that exists, with no pipe of ours.
  state.children = { 6: { pid: process.pid, phase: 6, sessionId: '3cd07c6e', startedAt: '2026-09-27T21:32:59.550Z' } as never };
  const adopted = runner.steer('free the simulator', 'watchdog', undefined, 6);
  assert.equal(adopted.unreachable, true);
  assert.equal(adopted.reason, `phase 6's session (pid ${process.pid}) is running, but this console did not start it — it was adopted from the run record `
    + 'with no input pipe (adopted without a pipe), so it cannot take messages; it ends at the end of its turn');
});

test('LL-1: with nothing of the phase alive, the old words stand — the run is between phases', () => {
  const runner = driving();
  const answer = runner.steer('x', 'watchdog', undefined, 6);
  assert.equal(answer.reason, 'no session is running just now — the run is between phases, or verifying');
  assert.equal(answer.unreachable, undefined);
});

/* ------------------------------------------------------------------ *
 * LL-2 / LL-3 through the runner — journalled, and marked on the lane
 * ------------------------------------------------------------------ */

test('LL-2: the runner journals phase.input-closed with its cause and pid, and marks the lane view unreachable', () => {
  const runner = driving();
  const lines: { event: string; data: Record<string, unknown>; phase?: number }[] = [];
  runner.record = (event: string, data: Record<string, unknown>, phase?: number) => { lines.push({ event, data, phase }); };
  const lanes = (runner as unknown as { lanes: Map<number, Record<string, unknown>> }).lanes;
  lanes.set(6, { phase: 6, pid: 7529, handle: closedHandle(7529), grant: null, signals: newLaneSignals(Date.now()) });
  (runner as unknown as { onStream(phase: number, event: StreamEvent): void }).onStream(6, { kind: 'input-closed', cause: 'idle', at: '2026-09-28T07:40:00.000Z' });
  const journal = lines.filter((line) => line.event === 'phase.input-closed');
  assert.equal(journal.length, 1);
  assert.equal(journal[0]!.phase, 6);
  assert.equal(journal[0]!.data.cause, 'idle');
  assert.equal(journal[0]!.data.pid, 7529);
  const view = runner.liveness().find((one) => one.phase === 6);
  assert.deepEqual(view?.input, { open: false, closedAt: '2026-09-28T07:40:00.000Z', cause: 'idle' }, 'running, unreachable — said up front');
});
