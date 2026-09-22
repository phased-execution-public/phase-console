/**
 * The wait procedure — one exact rule in every place a session can meet it,
 * and the console behind it (autopilot-token-drain phase 1, H1).
 *
 * Run `deadaff9` spent 79 % of one phase's context tokens on 311 status-only
 * calls — `ListAgents` and `date` every four seconds, at 790k–947k of context —
 * and the console had told it to: "poll it with a SINGLE bounded check per
 * turn", in five places, while its own guard denied the wait that costs
 * nothing (one foreground loop on the session's own job) and its Stop hook
 * refused the other (ending the turn while a subagent works in the background).
 *
 * What a `-p` session can really do was measured on CLI 2.1.273 under the
 * runner's own framing (plan §Context, E1–E6):
 *
 *   E1  a background Bash is STOPPED about five seconds after the turn ends;
 *   E3  an Agent running in the background keeps the process alive, stdin
 *       closed or not, and its completion starts a new turn;
 *   E4  so does a Monitor;
 *   E5  a foreground bounded `until … sleep` loop is not blocked by the CLI;
 *   E6  a foreground Agent costs zero parent API calls while it runs;
 *   E7  (CLI 2.1.274, phase 7) the process stays alive for that Agent only up to
 *       the background-wait ceiling: at 15 s it was stopped 15 s after the turn
 *       ended ("Background tasks still running after 15s; terminating") and no
 *       turn read it, while under 600 000 ms it woke the session (E7c);
 *
 * and across those turns `num_turns` restarts (2 → 1) while `total_cost_usd`
 * stays cumulative.
 *
 * So: the same rule sentences everywhere (a); a wait on the session's own job
 * is allowed while somebody else's clock is still refused (b); a turn may end
 * while agents or monitors are outstanding, and not while only shells are (c);
 * and a session that turns more than once is booked every turn (d).
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { LOCAL_JOB_NUDGE, WAIT_PROCEDURE_RULES, unattendedDirective, waitProcedure } =
  await import('../server/runner/runner-core.ts');
const { BG_WAIT_CEILING_MS } = await import('../server/runner/errors.ts');
const { awaitingBackground, applyEvent, evaluateStall, newLaneSignals, stallThresholds } =
  await import('../server/runner/liveness.ts');
const { Service } = await import('../server/service.ts');
const { spawnClaude } = await import('../server/runner/spawn.ts');
import type { StreamEvent } from '../server/runner/spawn.ts';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

/** Formatting is voice, not rule: backticks, bold and line wrapping are folded away. */
const plain = (text: string): string => text.replace(/[`*]/g, '').replace(/\s+/g, ' ');

function assertCarriesProcedure(where: string, text: string): void {
  const folded = plain(text);
  for (const rule of WAIT_PROCEDURE_RULES) {
    assert.ok(folded.includes(plain(rule)), `${where} is missing the rule: ${rule}`);
  }
  assert.ok(!/SINGLE bounded check/i.test(folded), `${where} still prescribes "a SINGLE bounded check per turn"`);
}

/** A copy of the linear fixture, QA on, under its own DOCS_ROOT. */
function docsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-waitproc-'));
  TRASH.push(root);
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  const linear = readFileSync(join(SKILL_DIR, 'tests', 'fixtures', 'plans', 'linear.md'), 'utf8');
  writeFileSync(join(root, 'docs', 'plans', 'linear.md'),
    linear.replace('## Phase graph', '## Session budget\n\n**QA gate:** on\n\n## Phase graph'));
  return root;
}

const bootPrompt = (root: string, phase: number): string => String(execFileSync('/bin/bash',
  [join(SCRIPTS, 'phase-graph.sh'), 'linear', '--boot-prompt', String(phase)],
  { encoding: 'utf8', env: { ...process.env, DOCS_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] }));

const flags = {
  port: 0, host: '127.0.0.1', open: false, allowWrites: false, scriptsDir: SCRIPTS, logFile: null,
};

type Noted = { event: string; data: Record<string, unknown>; phase?: number };

/** A service driving one run on phase 2, whose runner records what the guard tells it. */
function laned(profile: string) {
  const service = new Service(flags as never);
  const noted: Noted[] = [];
  const denials: { phase: number; command: string; matched: string }[] = [];
  (service as unknown as { runners: Map<string, unknown> }).runners.set('demo', {
    busy: () => true,
    current: () => ({ id: 'r1', slug: 'demo', activePhase: 2, permissionProfile: profile, phases: {} }),
    note: (event: string, data: Record<string, unknown>, phase?: number) => noted.push({ event, data, phase }),
    noteWaitDenied: (phase: number, denial: { command: string; matched: string }) => denials.push({ phase, ...denial }),
    park: () => {},
  });
  return { service, noted, denials };
}

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });
const hookDecision = (reply: Record<string, unknown>) =>
  (reply as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string } }).hookSpecificOutput;

/* ------------------------------------------------------------------ *
 * (a) One procedure, the same rule sentences in every site
 * ------------------------------------------------------------------ */

test('(a) the procedure is stated once, as rules a session can follow', () => {
  assert.ok(WAIT_PROCEDURE_RULES.length >= 8, 'the preamble and all five cases are rules');
  for (const rule of WAIT_PROCEDURE_RULES) {
    assert.equal(rule, rule.trim(), 'a rule is a sentence, not a fragment of whitespace');
    assert.ok(!/[`*]/.test(rule), 'a rule carries no formatting, so every voice can quote it');
  }
});

test('(a) every site a session meets the rule in carries the procedure — and none says "a SINGLE bounded check"', async () => {
  assertCarriesProcedure('SKILL.md', readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8'));
  assertCarriesProcedure('references/console-surface.md',
    readFileSync(join(SKILL_DIR, 'references', 'console-surface.md'), 'utf8'));
  assertCarriesProcedure('the engine boot prompt', bootPrompt(docsRoot(), 1));
  assertCarriesProcedure('LOCAL_JOB_NUDGE', LOCAL_JOB_NUDGE);

  const { service } = laned('guarded');
  const denied = hookDecision(await service.decideToolUse(bash('gh run watch 123'), 'r1'));
  assert.equal(denied.permissionDecision, 'deny');
  assertCarriesProcedure('the in-turn-wait deny reason', denied.permissionDecisionReason ?? '');
  service.close();
});

test('(a) nothing the skill ships still prescribes polling', () => {
  // The five sites are the known ones; a sixth written from memory of the old
  // wording is exactly how the rule came to be stated in five places.
  const roots = ['SKILL.md', 'references', 'scripts', join('viewer', 'server'), join('viewer', 'README.md'),
    join('viewer', 'README.fa.md'), 'docs'];
  const offenders: string[] = [];
  const walk = (path: string): void => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) if (name !== 'node_modules') walk(join(path, name));
      return;
    }
    if (!/\.(md|sh|ts|js|mjs|env)$/.test(path)) return;
    if (/SINGLE bounded check|bounded check per turn/i.test(readFileSync(path, 'utf8'))) offenders.push(path);
  };
  for (const root of roots) walk(join(SKILL_DIR, root));
  assert.deepEqual(offenders.map((path) => path.slice(SKILL_DIR.length + 1)), []);
});

test('(a) the QA duty tells a session to dispatch its reviewer in the FOREGROUND — never that a subagent dies with the turn', async () => {
  const root = docsRoot();
  mkdirSync(join(root, 'docs', 'handoffs', 'linear'), { recursive: true });
  writeFileSync(join(root, 'docs', 'handoffs', 'linear', 'phase-01-alpha.md'),
    '---\nplan: docs/plans/linear.md\nphase: 1\ntitle: alpha\nstatus: complete\n---\n# done\n');
  writeFileSync(join(root, 'docs', 'handoffs', 'linear', 'test-status.md'), [
    '# QA / test status — linear', '', '## QA status', '',
    '| Phase | Result | Report | Round |', '|------:|--------|--------|------:|',
    '| 1 | pass | reports/phase-01-qa.md | 1 |', '',
  ].join('\n'));
  const text = plain(bootPrompt(root, 2));
  const duty = text.slice(text.indexOf('This plan runs QA ON'), text.indexOf('THEN stop.') + 'THEN stop.'.length);
  const after = text.slice(text.indexOf('THEN stop.'));
  const qa = `${duty} ${after.slice(0, after.indexOf('Waiting on something OUTSIDE'))}`;
  assert.match(qa, /in the FOREGROUND/, 'the reviewer is dispatched in the foreground');
  assert.doesNotMatch(qa, /dies with the turn/, 'E3: a subagent in the background outlives the turn that dispatched it');

  // The Stop hook's own QA block names the same way to wait.
  const stop = new Service(flags as never);
  const state = { id: 'r1', slug: 'demo', root: '/tmp/nowhere', activePhase: 2, phases: { 2: { phase: 2, sessionId: 's' } } };
  (stop as unknown as { runners: Map<string, unknown> }).runners.set('demo', { busy: () => true, current: () => state, note: () => {} });
  (stop as unknown as { root: unknown }).root = { ok: true, path: '/tmp/nowhere' };
  (stop as unknown as { board: () => Promise<unknown> }).board = async () =>
    ({ phased: true, states: { 2: 'done' }, done: [], inProgress: [], stuck: [], ready: [], waiting: [], blockedBy: {}, qa: {} });
  (stop as unknown as { qaMode: () => Promise<unknown> }).qaMode = async () => ({ mode: 'on' });
  (stop as unknown as { qaVerdict: () => Promise<string> }).qaVerdict = async () => 'pending';
  const block = await stop.decideStop({ session_id: 's' }, 'r1') as { hookSpecificOutput?: { reason: string } };
  assert.match(plain(block.hookSpecificOutput?.reason ?? ''), /in the FOREGROUND/);
  stop.close();
});

test('(a) what survives a turn is stated as measured: shells die, agents and monitors wake the session', () => {
  const directive = plain(unattendedDirective(SCRIPTS, 'demo', 2));
  assert.doesNotMatch(directive, /process EXITS when your turn ends/i, 'E3/E4: the process stays alive for an agent or a monitor');
  assert.doesNotMatch(directive, /Monitor, and backgrounded watcher loops do not survive/i);
  assert.ok(directive.includes(plain(WAIT_PROCEDURE_RULES.find((rule) => /SHELL dies/.test(rule))!)),
    'the one thing that does die when the turn ends is named');

  const skill = plain(readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8'));
  assert.doesNotMatch(skill, /Monitor\/backgrounded loops die with it/);
  const surface = plain(readFileSync(join(SKILL_DIR, 'references', 'console-surface.md'), 'utf8'));
  assert.doesNotMatch(surface, /no background watcher survives it/);
  const errors = plain(readFileSync(join(SKILL_DIR, 'viewer', 'server', 'runner', 'errors.ts'), 'utf8'));
  assert.doesNotMatch(errors, /work the model can no longer read/);
});

test('(a) rule 4 says for how long the session stays alive — the ceiling the console sets (E7)', () => {
  // "The session stays alive" with no bound is how a reviewer left running in the
  // background past the ceiling is stopped with nobody to read it: the Stop hook
  // lets that turn end, and E7 measured the CLI ending the work at the ceiling.
  assert.equal(BG_WAIT_CEILING_MS, 10 * 60_000, 'the rule says ten minutes because the console sets ten minutes');
  const bound = 'They are stopped ten minutes after your turn ends — dispatch a subagent that may take longer in the FOREGROUND.';
  assert.ok(WAIT_PROCEDURE_RULES.includes(bound), 'the bound is a rule sentence, so every site carries it');
  const sites: [string, string][] = [
    ['waitProcedure()', waitProcedure()],
    ['SKILL.md', readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8')],
    ['references/console-surface.md', readFileSync(join(SKILL_DIR, 'references', 'console-surface.md'), 'utf8')],
    ['the engine boot prompt', bootPrompt(docsRoot(), 1)],
    ['LOCAL_JOB_NUDGE', LOCAL_JOB_NUDGE],
  ];
  for (const [where, text] of sites) {
    const folded = plain(text);
    const at = folded.indexOf(plain('Only subagents or monitors running in the background are left'));
    assert.ok(at >= 0, `${where} states rule 4`);
    assert.ok(folded.slice(at, at + 400).includes(plain(bound)), `${where} bounds rule 4 by the ceiling`);
  }
});

/* ------------------------------------------------------------------ *
 * (b) The guard: your own job may be waited on, somebody else's clock may not
 * ------------------------------------------------------------------ */

test('(b) a foreground wait on the session\'s own job is allowed, on every profile, and written down nowhere', async () => {
  for (const profile of ['guarded', 'trusted', 'bypass']) {
    for (const command of [
      'until [ -f /tmp/x.done ]; do sleep 10; done',
      'until grep -q DONE build.log; do sleep 10; done',
    ]) {
      const { service, noted, denials } = laned(profile);
      const answer = hookDecision(await service.decideToolUse(bash(command), 'r1'));
      assert.equal(answer.permissionDecision, 'allow', `${profile} refused a wait on its own job: ${command}`);
      assert.ok(!noted.some((n) => n.event === 'phase.tool-denied'), 'an allowed wait is no refusal');
      assert.deepEqual(denials, [], 'and the lane is told of no denial');
      service.close();
    }
  }
});

test('(b) a wait on somebody else\'s clock is still refused, with the procedure as the reason', async () => {
  for (const profile of ['guarded', 'trusted', 'bypass']) {
    for (const command of [
      'gh run watch 123',
      'sleep 600',
      'until gh run view 1 --exit-status; do sleep 30; done',
    ]) {
      const { service, noted, denials } = laned(profile);
      const answer = hookDecision(await service.decideToolUse(bash(command), 'r1'));
      assert.equal(answer.permissionDecision, 'deny', `${profile} allowed an external wait: ${command}`);
      assertCarriesProcedure(`the deny reason for ${command}`, answer.permissionDecisionReason ?? '');
      const denied = noted.find((n) => n.event === 'phase.tool-denied');
      assert.equal(denied?.data.rule, 'in-turn-wait');
      assert.deepEqual(denials.map((d) => d.command), [command]);
      service.close();
    }
  }
});

/* ------------------------------------------------------------------ *
 * (c) The Stop hook: a turn may end while an agent or a monitor works
 * ------------------------------------------------------------------ */

/** The stream a lane saw, folded through the real liveness reducer. */
function laneWith(events: StreamEvent[]) {
  const signals = newLaneSignals(0);
  let at = 1;
  for (const event of events) applyEvent(signals, event, at++);
  return signals;
}

const started = (taskId: string, taskType: string, tool: string): StreamEvent =>
  ({ kind: 'background', op: 'started', taskId, taskType, tool, description: `${tool} task` });

function serviceForStop(awaiting: ReturnType<typeof laneWith>) {
  const service = new Service(flags as never);
  const state = {
    id: 'r1', slug: 'demo', root: '/tmp/nowhere', activePhase: 2,
    phases: { 2: { phase: 2, sessionId: 'sess-stop', startedAt: '2026-01-01T00:00:00Z' } },
  };
  (service as unknown as { runners: Map<string, unknown> }).runners.set('demo', {
    busy: () => true,
    current: () => state,
    note: () => {},
    awaitingBackground: (phase: number) => (phase === 2 ? awaitingBackground(awaiting) : []),
  });
  (service as unknown as { root: unknown }).root = { ok: true, path: '/tmp/nowhere' };
  (service as unknown as { board: () => Promise<unknown> }).board = async () =>
    ({ phased: true, states: { 2: 'ready' }, done: [], inProgress: [], stuck: [], ready: [], waiting: [], blockedBy: {}, qa: {} });
  (service as unknown as { qaMode: () => Promise<unknown> }).qaMode = async () => ({ mode: 'off' });
  return service;
}

test('(c) a turn may end with no outcome while a subagent is outstanding in the background', async () => {
  const service = serviceForStop(laneWith([started('a1', 'local_agent', 'Agent')]));
  assert.deepEqual(await service.decideStop({ session_id: 'sess-stop' }, 'r1'), {},
    'E3: the agent keeps the process alive and its notification wakes the session');
  service.close();
});

test('(c) …or a monitor — which the CLI reports as a `local_bash` task started by the Monitor tool', async () => {
  const service = serviceForStop(laneWith([started('b1', 'local_bash', 'Monitor')]));
  assert.deepEqual(await service.decideStop({ session_id: 'sess-stop' }, 'r1'), {}, 'E4: a monitor wakes the session too');
  service.close();
});

test('(c) a turn is still held when only background SHELLS, or nothing, are outstanding', async () => {
  for (const events of [
    [started('b2', 'local_bash', 'Bash')],
    [],
    // An agent that has already reported is not outstanding.
    [started('a2', 'local_agent', 'Agent'), { kind: 'background', op: 'ended', taskId: 'a2', status: 'completed' } as StreamEvent],
  ]) {
    const service = serviceForStop(laneWith(events));
    const decision = await service.decideStop({ session_id: 'sess-stop' }, 'r1') as {
      hookSpecificOutput?: { decision: string };
    };
    assert.equal(decision.hookSpecificOutput?.decision, 'block', `let go with ${JSON.stringify(events)}`);
    service.close();
  }
});

test('(c) a lane whose turn ended with an agent outstanding reads as waiting on its own work, not silent', () => {
  const thresholds = stallThresholds({});
  const agent = laneWith([started('a3', 'local_agent', 'Agent')]);
  const quiet = thresholds.stallSilentMs + 60_000;
  assert.equal(evaluateStall(agent, thresholds, quiet), null, 'the session is between two halves of its own work');
  // Bounded: an agent that never reports is silence after all, on the local-job clock.
  assert.equal(evaluateStall(agent, thresholds, thresholds.stallLocalJobMs + 60_000)?.signal, 'silent');
  // And a background SHELL is no reason to be quiet — it died with the turn.
  const shell = laneWith([started('b3', 'local_bash', 'Bash')]);
  assert.equal(evaluateStall(shell, thresholds, quiet)?.signal, 'silent');
});

/* ------------------------------------------------------------------ *
 * (d) A session that turns more than once is booked every turn
 * ------------------------------------------------------------------ */

/**
 * E3, as the stream carries it: the boot turn dispatches an Agent in the
 * background and ends (two API turns); the runner closes stdin; the agent's completion
 * starts a second turn (ONE API turn — `num_turns` restarts); then it exits.
 */
const E3_STUB = `#!/usr/bin/env node
'use strict';
const sid = 'sess-e3';
const say = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
say({ type: 'system', subtype: 'init', session_id: sid, model: 'stub-1', tools: [] });
let booted = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => {
  if (booted) return;
  booted = true;
  say({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { id: 'msg_1', role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'review', run_in_background: true } }] } });
  say({ type: 'system', subtype: 'task_started', task_id: 'a1b2c3d4', tool_use_id: 'toolu_agent', description: 'review',
    task_type: 'local_agent', is_backgrounded: true, session_id: sid });
  say({ type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'launched in the background' }] } });
  say({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { id: 'msg_2', role: 'assistant',
    stop_reason: 'end_turn', content: [{ type: 'text', text: 'waiting for the reviewer' }] } });
  say({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.025, result: 'waiting', session_id: sid });
});
process.stdin.on('end', () => {
  setTimeout(() => {
    say({ type: 'system', subtype: 'task_notification', task_id: 'a1b2c3d4', tool_use_id: 'toolu_agent', status: 'completed',
      summary: 'review done', session_id: sid });
    say({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { id: 'msg_3', role: 'assistant',
      stop_reason: 'end_turn', content: [{ type: 'text', text: 'NOTIFIED' }] } });
    say({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.0468, result: 'NOTIFIED', session_id: sid });
    process.exit(0);
  }, 50);
});
`;

test('(d) a later result whose num_turns restarts is a new turn, and turns sum across them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-e3-'));
  TRASH.push(dir);
  writeFileSync(join(dir, 'claude'), E3_STUB, 'utf8');
  chmodSync(join(dir, 'claude'), 0o755);
  const events: StreamEvent[] = [];
  const outcome = await spawnClaude({
    prompt: 'BOOT phase 1', cwd: dir,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
    onEvent: (event) => events.push(event),
  });
  const results = events.filter((event): event is Extract<StreamEvent, { kind: 'result' }> => event.kind === 'result');
  assert.deepEqual(results.map((event) => event.turns), [2, 3], 'the second turn is booked, not read as a duplicate');
  assert.equal(outcome.turns, 3);
  assert.equal(outcome.costUsd, 0.0468, 'cost stays cumulative: the last total wins');
  assert.equal(outcome.turnsSource, 'result');

  // The background task, as the Stop hook and liveness need it: its type and the tool that started it.
  const background = events.filter((event) => event.kind === 'background');
  assert.deepEqual(background, [
    { kind: 'background', op: 'started', taskId: 'a1b2c3d4', taskType: 'local_agent', tool: 'Agent', description: 'review' },
    { kind: 'background', op: 'ended', taskId: 'a1b2c3d4', status: 'completed' },
  ]);
  assert.equal(outcome.signal.backgroundTasks, undefined, 'a task that reported is not left open at exit');
});
