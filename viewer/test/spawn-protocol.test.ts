/**
 * The wire protocol between the runner and a session.
 *
 * Every other test fakes `spawnClaude` away, which is right for testing the
 * loop and useless for testing the thing the loop stands on. The parts most
 * able to break are exactly the parts a fake hides: whether the boot prompt
 * reaches the child at all, whether a flag we think we pass is in argv,
 * whether an injected message becomes a turn, whether the process ever exits.
 *
 * So this runs the real `spawnClaude` against a stub `claude` on a temporary
 * PATH that speaks the same NDJSON both directions. The stub's behaviour is
 * copied from a real session observed at CLI v2.1.220 — one `result` per turn,
 * a cumulative `total_cost_usd`, `--replay-user-messages` echoing our own
 * messages back, `stream_event` deltas carrying `parent_tool_use_id`.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { spawnClaude, markFor } = await import('../server/runner/spawn.ts');
const { SPAWN_DEFAULT_CAPS, permissionPromptsFor, relayArmingFor } = await import('../server/runner/session-record.ts');
const { PERMISSION_PROMPTS_CLI_FLOOR, RELAY_CLI_FLOOR } = await import('../shared/run-settings.js');
const { RELAY_HOST_TOOL } = await import('../server/relay-host.ts');
const { INT_GRACE_MS } = await import('../server/runner/signals.ts');
import type { SpawnHandle, StreamEvent } from '../server/runner/spawn.ts';
// The REAL framing, not a copy of it. This file used to build its operator
// messages by hand, and the hand-copy had already drifted from `frameQuestion`
// — so the one test proving a message reaches the child was proving it about a
// string the runner has not sent in months. Importing the functions the runner
// actually calls is what makes this a protocol test rather than a test of its
// own fixture.
const { frameQuestion, frameSteer } = await import('../server/runner/runner-core.ts');

/* ------------------------------------------------------------------ *
 * A `claude` that is not claude
 * ------------------------------------------------------------------ */

const STUB = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (process.env.PC_STUB_ARGV) fs.writeFileSync(process.env.PC_STUB_ARGV, JSON.stringify(argv));
// The account vars, dumped for the test that proves credentials arrive as
// ENVIRONMENT and never as argv.
if (process.env.PC_STUB_ENV) {
  fs.writeFileSync(process.env.PC_STUB_ENV, JSON.stringify({
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
    // The session id the console tells the child about itself (Phase 5).
    PE_SESSION_ID: process.env.PE_SESSION_ID ?? null,
    // The CLI-side ceilings the console sets on every child (zero-touch-console
    // phase 4, SES-12 and DOC-2).
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS ?? null,
    CLAUDE_CODE_MAX_RETRIES: process.env.CLAUDE_CODE_MAX_RETRIES ?? null,
  }));
}

// D21 — the two shapes that produce NO usable stream event and then live for
// ever. \`armIdle\` cannot see either: it refuses to arm until the phase's turn
// has produced a result, and neither of these ever does. Both stay alive on a
// held-open stdin, which is exactly what the incident's child did.
if (process.env.PC_STUB_MUTE === '1') {
  process.stdin.resume(); setInterval(() => {}, 1000); return;
}
// The third shape, and the one that survived both watchdogs above for eleven
// hours: a session that emits a STREAM — retry after retry, with a category the
// CLI often does not send — and never a turn, a tool call or a result.
if (process.env.PC_STUB_RETRIES === '1') {
  let n = 0;
  const t = setInterval(() => {
    n += 1;
    process.stdout.write(JSON.stringify({
      type: 'system', subtype: 'api_retry', attempt: n, error: 'Error: 429 Too Many Requests',
    }) + '\\n');
  }, 20);
  t.unref && t.unref();
  process.stdin.resume(); setInterval(() => {}, 1000); return;
}
if (process.env.PC_STUB_GARBAGE === '1') {
  // Output, but nothing this build can read — the case a bare \`catch { return }\`
  // used to make indistinguishable from silence.
  process.stdout.write('this is not json\\n');
  process.stdout.write('{"half of an object\\n');
  process.stdin.resume(); setInterval(() => {}, 1000); return;
}

const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sid = '11111111-2222-3333-4444-555555555555';

// Zero-touch-console phase 4 — the session ledger. A session that STARTED WORK
// and then was ended: its init, one API turn (thinking and a tool call, as TWO
// assistant lines sharing a message id — measured on CLI 2.1.270), and then
// nothing, with the Bash call still running. What happens on SIGINT is the knob:
//   STEP_HANG      no handler — SIGINT's default kills it with nothing written
//   SIGINT_RESULT  the measured CLI: the interrupted call's result, the
//                  interrupt line, then a \`result\` (test/fixtures/spikes/sigint.md)
//   IGNORE_SIGINT  a child that will not go on SIGINT — only SIGTERM ends it
const hang = process.env.PC_STUB_STEP_HANG === '1' || process.env.PC_STUB_SIGINT_RESULT === '1'
  || process.env.PC_STUB_IGNORE_SIGINT === '1';
if (hang) {
  say({ type: 'system', subtype: 'init', session_id: sid, model: 'stub-1', tools: [] });
  say({ type: 'assistant', session_id: sid, parent_tool_use_id: null,
        message: { id: 'msg_turn_1', role: 'assistant', content: [{ type: 'thinking', thinking: 'run it' }] } });
  say({ type: 'assistant', session_id: sid, parent_tool_use_id: null,
        message: { id: 'msg_turn_1', role: 'assistant', content: [
          { type: 'tool_use', id: 'toolu_sleep', name: 'Bash', input: { command: 'sleep 20' } }] } });
  if (process.env.PC_STUB_SIGINT_RESULT === '1') {
    process.on('SIGINT', () => {
      say({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'tool_result',
        tool_use_id: 'toolu_sleep', is_error: true,
        content: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file)." }] } });
      say({ type: 'user', session_id: sid, message: { role: 'user', content: [
        { type: 'text', text: '[Request interrupted by user for tool use]' }] } });
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true,
        terminal_reason: 'aborted_tools', stop_reason: 'tool_use', num_turns: 3, total_cost_usd: 0.0114327,
        permission_denials: [], session_id: sid }) + '\\n', () => process.exit(0));
    });
  }
  if (process.env.PC_STUB_IGNORE_SIGINT === '1') process.on('SIGINT', () => {});
  process.stdin.resume(); setInterval(() => {}, 1000); return;
}
// Initialised, said one line on stderr, then wedged before its first result —
// the stretch the first-event backstop cannot see (SES-10).
if (process.env.PC_STUB_INIT_STDERR === '1') {
  say({ type: 'system', subtype: 'init', session_id: sid, model: 'stub-1', tools: [] });
  process.stderr.write('warming a cache\\n');
  process.stdin.resume(); setInterval(() => {}, 1000); return;
}

// Turns whose result is withheld, so the NEXT turn's result covers both — this
// is the CLI folding two injected messages into one turn, which is what the old
// counter could not survive.
const noResult = new Set((process.env.PC_STUB_NO_RESULT || '').split(',').filter(Boolean).map(Number));
// A history replayed on --resume: user echoes for turns that are not ours.
const replayHistory = Number(process.env.PC_STUB_REPLAY_HISTORY || 0);
// A duplicate result for a turn already reported, which the CLI has been seen
// to emit and which used to decrement the counter a second time.
const extraResult = new Set((process.env.PC_STUB_EXTRA_RESULT || '').split(',').filter(Boolean).map(Number));
// Answer an operator message by repeating its tag, as the frame asks.
const answering = process.env.PC_STUB_ANSWER === '1';
// Say nothing at all after the boot turn: never echo, never result.
const goSilent = process.env.PC_STUB_SILENT === '1';
// The tool traffic a real session makes: a call and its result, a task list,
// and a Task whose subagent makes a call of its own and fails it.
const tools = process.env.PC_STUB_TOOLS === '1';
const tag = (text) => (/\\[\\[(ask|steer):[0-9a-z]{4,16}\\]\\]/i.exec(text) || [])[0];

// The init a real 2.1.270 session prints (phase 1, spike S1): \`AskUserQuestion\`
// is offered ONLY when a permission host is attached, and the host's own status
// rides \`mcp_servers\`. The version is \`claude_code_version\`; \`capabilities\` is
// an open set that names nothing about hooks — a stub can put a lie in it.
const hosted = argv.includes('--permission-prompt-tool');
say({
  type: 'system', subtype: 'init', session_id: sid, model: process.env.PC_STUB_MODEL || 'stub-1',
  tools: hosted ? ['Bash', 'Read', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'] : [],
  ...(process.env.PC_STUB_CLI_VERSION ? { claude_code_version: process.env.PC_STUB_CLI_VERSION } : {}),
  capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1',
    ...(process.env.PC_STUB_CAPABILITY ? [process.env.PC_STUB_CAPABILITY] : [])],
  mcp_servers: hosted ? [{ name: 'pcrelay', status: process.env.PC_STUB_HOST_STATUS || 'connected' }] : [],
});
// The CLI asking its host over the stream (TRS-2), and a turn ended on \`defer\` (S3).
if (process.env.PC_STUB_CONTROL_REQUEST === '1') {
  say({ type: 'control_request', request_id: 'req_1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion' } });
}
if (process.env.PC_STUB_DEFER === '1') {
  say({ type: 'result', subtype: 'success', stop_reason: 'tool_deferred', terminal_reason: 'tool_deferred', is_error: false,
    num_turns: 1, total_cost_usd: 0.004587, permission_denials: [], session_id: sid, result: '',
    deferred_tool_use: { id: 'toolu_deferred', name: 'AskUserQuestion', input: { questions: [] } } });
  process.exit(0);
}
// The CLI's retry line in its DOCUMENTED shape (chapter 09 rows 31–32): the
// category is \`error\`, and four numbers ride beside it.
if (process.env.PC_STUB_DOC_RETRY === '1') {
  say({ type: 'system', subtype: 'api_retry', attempt: 3, max_retries: 15, retry_delay_ms: 2000,
        error_status: 500, error: 'server_error', session_id: sid });
}
// A usage warning at 99 % of a window, as a fraction on the wire.
if (process.env.PC_STUB_RATE_LIMIT === '1') {
  say({ type: 'rate_limit_event', session_id: sid, rate_limit_info: {
    status: 'allowed_warning', utilization: 0.99, rateLimitType: 'seven_day', resetsAt: 1789956000 } });
}
for (let i = 0; i < replayHistory; i++) {
  say({ type: 'user', session_id: sid,
        message: { role: 'user', content: [{ type: 'text', text: 'replayed history ' + i }] } });
}

let buffer = '';
let turn = 0;
// API turns since the last result. The CLI's \`num_turns\` counts the turn a
// result closes, from one — it restarts every turn (measured 2 → 1, CLI
// 2.1.273, autopilot-token-drain) — so a turn folded into the next result is
// counted there, and a running count across the session would double-book.
let sinceResult = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const text = (message.message && message.message.content || []).map((b) => b.text).join('');
    turn += 1;
    // NUL-delimited, not newline-delimited: a real operator message is MULTI-LINE
// (see \`frameQuestion\`/\`frameSteer\`), so a newline separator counted one
// message as four, and every "how many did the child hear" assertion was
// silently measuring lines. NUL cannot occur in the framing.
if (process.env.PC_STUB_HEARD) fs.appendFileSync(process.env.PC_STUB_HEARD, text + '\\u0000');
    // The turn that ends on a usage wall: the limit text as the result, a
    // non-zero exit — the shape the classifier reads off a real limited session.
    if (process.env.PC_STUB_LIMIT_EXIT) {
      say({ type: 'result', subtype: 'error_during_execution', total_cost_usd: 0,
            result: process.env.PC_STUB_LIMIT_EXIT, num_turns: turn, session_id: sid });
      process.exit(1);
    }
    if (goSilent && turn > 1) continue;

    if (argv.includes('--replay-user-messages')) {
      say({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'text', text }] } });
    }
    if (argv.includes('--include-partial-messages')) {
      for (const piece of ['answer ', 'in ', 'pieces']) {
        say({ type: 'stream_event', session_id: sid, parent_tool_use_id: null,
              event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
      }
      say({ type: 'stream_event', session_id: sid, parent_tool_use_id: 'toolu_sub',
            event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'from a subagent' } } });
    }
    if (tools && turn === 1) {
      say({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'npm test -- --run' } },
        { type: 'tool_use', id: 'toolu_todo', name: 'TodoWrite', input: { todos: [
          { content: 'wire the endpoint', status: 'completed', activeForm: 'Wiring the endpoint' },
          { content: 'add the test', status: 'in_progress', activeForm: 'Adding the test' },
        ] } },
        { type: 'tool_use', id: 'toolu_task', name: 'Task',
          input: { subagent_type: 'Explore', description: 'map the callers' } },
        // The CLI's own name for the same tool, and with no type stated —
        // which is legal, and still a delegation.
        { type: 'tool_use', id: 'toolu_agent', name: 'Agent',
          input: { description: 'count the widgets' } },
        // What the CLI ACTUALLY calls for a task list — one row per call, with
        // the id coming back in the result rather than going out in the input.
        { type: 'tool_use', id: 'toolu_new', name: 'TaskCreate',
          input: { subject: 'wire the endpoint', description: 'the long brief', activeForm: 'Wiring it' } },
        { type: 'tool_use', id: 'toolu_upd', name: 'TaskUpdate',
          input: { taskId: '1', status: 'in_progress' } },
      ] } });
      // Results come back as USER messages, which is why they were being
      // dropped: the old handler joined \`.text\` and a tool_result has none.
      say({ type: 'user', session_id: sid, message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_bash', is_error: false,
          content: [{ type: 'text', text: '40 tests passed' }] },
      ] } });
      // The subagent's own call, parented — and failing.
      say({ type: 'assistant', session_id: sid, parent_tool_use_id: 'toolu_task',
            message: { role: 'assistant', content: [
              { type: 'tool_use', id: 'toolu_inner', name: 'Grep', input: { pattern: 'createOrder' } },
            ] } });
      say({ type: 'user', session_id: sid, parent_tool_use_id: 'toolu_task',
            message: { role: 'user', content: [
              { type: 'tool_result', tool_use_id: 'toolu_inner', is_error: true, content: 'no matches' },
            ] } });
      say({ type: 'user', session_id: sid, message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_task', is_error: false, content: 'found 3 callers' },
      ] } });
    }
    // A tool call the CLI's permission system refuses. \`stream\`: the measured
    // CLI 2.1.270 trio (test/fixtures/spikes/permissionrequest.md) — the
    // announcement, the refused result, the result's authoritative ledger.
    // \`result\`: no announcement, and the CLI's own refusal sentence.
    if (process.env.PC_STUB_DENIED && turn === 1) {
      const streamed = process.env.PC_STUB_DENIED === 'stream';
      // \`sensitive\`: the audit's Q-08e shape — an Edit of a file the CLI
      // guards, refused in its own words (43 of the 155 lifetime refusals).
      const sensitive = process.env.PC_STUB_DENIED === 'sensitive';
      const call = sensitive
        ? { type: 'tool_use', id: 'toolu_deny', name: 'Edit',
            input: { file_path: '/home/someone/.claude/rules/house-rules.md', old_string: 'a', new_string: 'b' } }
        : { type: 'tool_use', id: 'toolu_deny', name: 'Bash', input: { command: 'touch spike-s2-marker.txt' } };
      say({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { id: 'msg_deny', role: 'assistant',
        content: [call] } });
      if (streamed) {
        say({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'toolu_deny',
              decision_reason_type: 'hook', decision_reason: 'spike listener: deny', message: 'spike listener: deny',
              session_id: sid });
      }
      say({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'tool_result',
        tool_use_id: 'toolu_deny', is_error: true,
        content: streamed ? 'spike listener: deny'
          : sensitive ? 'Claude requested permissions to edit /home/someone/.claude/rules/house-rules.md which is a sensitive file.'
            : "Claude requested permissions to use Bash, but you haven't granted it yet." }] } });
      say({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.0126,
            permission_denials: [{ tool_name: call.name, tool_use_id: 'toolu_deny', tool_input: call.input }],
            result: 'DENIED', session_id: sid });
      continue;
    }
    // A backgrounded job the CLI's ceiling killed when the run ended (SES-12):
    // the task starts, never reports, and the CLI's own sentence lands on stderr.
    if (process.env.PC_STUB_BG_TASK === '1' && turn === 1) {
      say({ type: 'system', subtype: 'task_started', task_id: 'bash_7', description: 'npm test -- --run',
            session_id: sid });
      process.stderr.write('Background tasks still running after 600s; terminating. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.\\n');
      say({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.5,
            result: 'all done', session_id: sid });
      continue;
    }
    const mark = answering ? tag(text) : undefined;
    say({ type: 'assistant', session_id: sid,
          message: { role: 'assistant', stop_reason: 'end_turn',
                     content: [{ type: 'text', text: mark ? mark + ' yes, because the cache was cold' : 'turn ' + turn }] } });
    sinceResult += 1;
    if (noResult.has(turn)) continue;
    // total_cost_usd is the SESSION total, not this turn's share.
    const reported = sinceResult;
    sinceResult = 0;
    say({ type: 'result', subtype: 'success', session_id: sid, num_turns: reported,
          total_cost_usd: turn, is_error: false, result: 'done ' + turn });
    if (extraResult.has(turn)) {
      // The same result again, with nothing between: a duplicate, not a new turn.
      say({ type: 'result', subtype: 'success', session_id: sid, num_turns: reported,
            total_cost_usd: turn, is_error: false, result: 'done ' + turn + ' (again)' });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

type Bench = {
  dir: string;
  env: NodeJS.ProcessEnv;
  argvFile: string;
  heardFile: string;
  argv: () => string[];
  heard: () => string[];
  cleanup: () => void;
};

function bench(): Bench {
  const dir = mkdtempSync(join(tmpdir(), 'pc-stub-'));
  const bin = join(dir, 'claude');
  writeFileSync(bin, STUB, 'utf8');
  chmodSync(bin, 0o755);
  const argvFile = join(dir, 'argv.json');
  const heardFile = join(dir, 'heard.txt');
  return {
    dir,
    argvFile,
    heardFile,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      PC_STUB_ARGV: argvFile,
      PC_STUB_HEARD: heardFile,
      PC_STUB_ENV: join(dir, 'env.json'),
    },
    argv: () => JSON.parse(readFileSync(argvFile, 'utf8')) as string[],
    // One entry per MESSAGE the child heard — see the stub's NUL note. Splitting
    // on newlines made one multi-line operator message read as several.
    heard: () => (existsSync(heardFile) ? readFileSync(heardFile, 'utf8').split('\u0000').filter(Boolean) : []),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/* ------------------------------------------------------------------ *
 * The prompt
 * ------------------------------------------------------------------ */

test('the boot prompt reaches the session on stdin, and never as argv', async () => {
  const b = bench();
  const outcome = await spawnClaude({ prompt: 'BOOT phase 3', cwd: b.dir, env: b.env });

  assert.deepEqual(b.heard(), ['BOOT phase 3'], 'the session was told what to do');
  // In streaming-input mode the CLI ignores a positional prompt entirely, so a
  // prompt passed there would look right on screen and run nothing at all.
  assert.ok(!b.argv().includes('BOOT phase 3'), 'the prompt is not in argv');
  assert.equal(outcome.signal.subtype, 'success');
  assert.equal(outcome.sessionId, '11111111-2222-3333-4444-555555555555');
  b.cleanup();
});

test('account credentials arrive as ENVIRONMENT, and never appear in argv', async () => {
  const b = bench();
  const envFile = join(b.dir, 'env.json');
  await spawnClaude({
    prompt: 'BOOT phase 1',
    cwd: b.dir,
    env: {
      ...b.env,
      PC_STUB_ENV: envFile,
      CLAUDE_CONFIG_DIR: '/tmp/pc-profile-a/config',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-testtoken',
    },
  });
  const seen = JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string | null>;
  assert.equal(seen.CLAUDE_CONFIG_DIR, '/tmp/pc-profile-a/config');
  assert.equal(seen.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-testtoken');
  const argv = b.argv().join(' ');
  assert.ok(!argv.includes('testtoken'), 'a credential in argv is a credential in `ps` output');
  assert.ok(!argv.includes('pc-profile-a'), 'the config dir is env, not a flag');
  b.cleanup();
});

test('a limit exit carries the wall text in the result and a non-zero code', async () => {
  const b = bench();
  const outcome = await spawnClaude({
    prompt: 'BOOT phase 1',
    cwd: b.dir,
    env: { ...b.env, PC_STUB_LIMIT_EXIT: "You've hit your session limit · resets 3:45pm" },
  });
  assert.equal(outcome.signal.subtype, 'error_during_execution');
  assert.match(outcome.signal.text ?? '', /hit your session limit/);
  assert.equal(outcome.sessionId, '11111111-2222-3333-4444-555555555555',
    'the session id survives the wall — it is what a switch resumes');
  b.cleanup();
});

test('the session ends by itself once its turn is answered', async () => {
  const b = bench();
  // Nothing kills this child: stdin closes when the last turn is answered and
  // the process exits on its own. If that logic is wrong the test hangs, which
  // is exactly the failure it needs to catch.
  const outcome = await spawnClaude({ prompt: 'BOOT phase 1', cwd: b.dir, env: b.env });
  assert.equal(outcome.turns, 1);
  assert.ok(outcome.durationMs >= 0);
  b.cleanup();
});

/* ------------------------------------------------------------------ *
 * The flags we believe we are passing
 * ------------------------------------------------------------------ */

test('effort, model, fallback chain and name all reach the child', async () => {
  const b = bench();
  await spawnClaude({
    prompt: 'BOOT phase 1',
    cwd: b.dir,
    env: b.env,
    model: 'fable',
    effort: 'max',
    fallbackModels: ['opus', 'sonnet'],
    name: 'demo p1',
  });
  const argv = b.argv();
  assert.equal(argv[argv.indexOf('--model') + 1], 'fable');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'max');
  assert.equal(argv[argv.indexOf('--fallback-model') + 1], 'opus,sonnet');
  assert.equal(argv[argv.indexOf('--name') + 1], 'demo p1');
  b.cleanup();
});

test('an effort the CLI would only warn about never leaves this process', async () => {
  const b = bench();
  await spawnClaude({ prompt: 'BOOT phase 1', cwd: b.dir, env: b.env, effort: 'ludicrous' });
  assert.ok(!b.argv().includes('--effort'));
  b.cleanup();
});

test('a caller cannot smuggle the guard rails off through the tool list', async () => {
  const b = bench();
  await spawnClaude({
    prompt: 'BOOT phase 1',
    cwd: b.dir,
    env: b.env,
    permissionMode: 'bypassPermissions' as never,
  });
  const argv = b.argv();
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'acceptEdits');
  b.cleanup();
});

/* ------------------------------------------------------------------ *
 * Talking to a session that is already running
 * ------------------------------------------------------------------ */

/** A tagged operator question, framed by the function the runner calls. */
function tagged(id: string, body: string): string {
  return frameQuestion(body, markFor('ask', id));
}

/** A tagged course correction, framed by the function the runner calls. */
function steered(id: string, body: string): string {
  return frameSteer(body, markFor('steer', id));
}

test('an injected message becomes a second turn in the same session', async () => {
  const b = bench();
  const events: StreamEvent[] = [];
  let handle: SpawnHandle | null = null;
  let asked = false;

  const outcome = await spawnClaude({
    prompt: 'BOOT phase 2',
    cwd: b.dir,
    env: b.env,
    onHandle: (h) => { handle = h; },
    onEvent: (event) => {
      events.push(event);
      // Ask the moment the phase's own turn lands. The send has to be seen
      // BEFORE stdin is closed, which is why the result event is emitted
      // before the close decision is taken — load-bearing ordering.
      if (event.kind === 'result' && !asked) {
        asked = true;
        assert.equal(handle!.send(tagged('aaaa1111', 'by the way, why?')), true);
      }
    },
  });

  assert.equal(b.heard().length, 2);
  assert.equal(outcome.injected, 1);
  assert.equal(outcome.turns, 2, 'the question was a turn of its own');
  // Cumulative, not summed: the stub reports 1 then 2, and the session cost 2.
  assert.equal(outcome.costUsd, 2, 'per-turn totals must not be added together');

  const injected = events.filter((e) => e.kind === 'injected') as { mark?: string; delivered?: boolean }[];
  assert.equal(injected.length, 1, 'the echo is the only proof it landed');
  assert.equal(injected[0].mark, 'ask:aaaa1111', 'and it is attributable to the message that caused it');
  assert.equal(injected[0].delivered, true);
  b.cleanup();
});

test('a steer reaches the live session as its own turn, framed as an instruction and attributed', async () => {
  const b = bench();
  const events: StreamEvent[] = [];
  let handle: SpawnHandle | null = null;
  let sent = false;

  const outcome = await spawnClaude({
    prompt: 'BOOT phase 4',
    cwd: b.dir,
    env: { ...b.env, PC_STUB_ANSWER: '1' },
    onHandle: (h) => { handle = h; },
    onEvent: (event) => {
      events.push(event);
      if (event.kind !== 'result' || sent) return;
      sent = true;
      assert.equal(handle!.send(steered('bbbb2222', 'use the existing helper rather than a new one')), true);
    },
  });

  // The wire half: it became a turn of its own in the SAME session, which is
  // the whole point of steering rather than stopping and restarting.
  assert.equal(outcome.injected, 1);
  assert.equal(outcome.turns, 2, 'the instruction was a turn, not an append to the boot turn');

  // The framing half, read off what the child actually received. `runner.test.ts`
  // pins these words against a FAKE handle; this is the same words arriving over
  // a real pipe, at the other end of a real process.
  const heard = b.heard();
  assert.equal(heard.length, 2, 'one boot prompt and one instruction');
  assert.match(heard[1], /course correction/i);
  assert.match(heard[1], /this IS an instruction/);
  assert.match(heard[1], /verification commands still decide/);
  assert.match(heard[1], /Instruction: use the existing helper rather than a new one$/);
  // And NOT the other frame — an instruction delivered through the question
  // wording is the bug `frameSteer` exists to fix, and it would still look like
  // a delivered message from out here.
  assert.doesNotMatch(heard[1], /It is NOT a change to the phase/);

  // The attribution half: the echo carries the steer mark, so the console can
  // show a course correction as a course correction rather than as a question.
  const injected = events.filter((e) => e.kind === 'injected') as { mark?: string; delivered?: boolean }[];
  assert.equal(injected.length, 1);
  assert.equal(injected[0].mark, 'steer:bbbb2222');
  assert.equal(injected[0].delivered, true);

  const answers = events.filter((e) => e.kind === 'answer') as { mark: string }[];
  assert.equal(answers.length, 1, 'the acknowledgement is not lost in the phase output');
  assert.equal(answers[0].mark, 'steer:bbbb2222', 'and it is an acknowledgement, not an answer to a question');
  b.cleanup();
});

test('steering a session that has settled is refused at the pipe, not written into a void', async () => {
  const b = bench();
  let handle: SpawnHandle | null = null;
  await spawnClaude({ prompt: 'BOOT phase 1', cwd: b.dir, env: b.env, onHandle: (h) => { handle = h; } });

  assert.equal(handle!.open(), false, 'a settled lane says it is settled');
  assert.equal(
    handle!.send(steered('cccc3333', 'change course')), false,
    'and refuses the instruction rather than accepting it nowhere',
  );
  assert.deepEqual(b.heard(), ['BOOT phase 1'], 'nothing reached the child after it settled');
  b.cleanup();
});

test('the boot prompt is not echoed back as if the operator had said it', async () => {
  const b = bench();
  const events: StreamEvent[] = [];
  await spawnClaude({ prompt: 'BOOT phase 1', cwd: b.dir, env: b.env, onEvent: (e) => events.push(e) });
  assert.equal(events.filter((e) => e.kind === 'injected').length, 0);
  b.cleanup();
});

test('a replayed history is not mistaken for messages the operator just sent', async () => {
  const b = bench();
  const events: StreamEvent[] = [];
  // A session started with `--resume` replays its history as `user` messages.
  // The old rule was positional — "the first echo is the boot prompt" — so
  // every replayed turn after it was shown as something the operator had
  // supposedly just typed, and the count was wrong from then on.
  await spawnClaude({
    prompt: 'BOOT phase 1',
    cwd: b.dir,
    env: { ...b.env, PC_STUB_REPLAY_HISTORY: '3' },
    onEvent: (e) => events.push(e),
  });
  assert.equal(events.filter((e) => e.kind === 'injected').length, 0);
  b.cleanup();
});

/* ------------------------------------------------------------------ *
 * When stdin closes — the wedge, and the two ways of causing it
 * ------------------------------------------------------------------ */

test('two messages folded into one turn still let the session end', async () => {
  const b = bench();
  let handle: SpawnHandle | null = null;
  let asked = false;

  // The measured wedge. `outstanding` went up twice and down once — the CLI
  // answered both messages in a single turn — so it never reached zero, stdin
  // never closed, and the child sat blocked on it at 0.1% CPU with the phase
  // still reading `running` 80 minutes later. If this regresses, this test does
  // not fail: it hangs, which is the honest shape of the bug.
  const outcome = await spawnClaude({
    prompt: 'BOOT phase 2',
    cwd: b.dir,
    env: { ...b.env, PC_STUB_NO_RESULT: '2' },
    onHandle: (h) => { handle = h; },
    onEvent: (event) => {
      if (event.kind !== 'result' || asked) return;
      asked = true;
      assert.equal(handle!.send(tagged('bbbb2222', 'first question')), true);
      assert.equal(handle!.send(tagged('cccc3333', 'second question')), true);
    },
  });

  assert.equal(outcome.injected, 2, 'both were written');
  assert.equal(b.heard().length, 3, 'and both reached the session, after the boot prompt');
  // Two questions, three turns, two results. The session ended anyway.
  assert.equal(outcome.turns, 3);
  b.cleanup();
});

test('an extra result for a turn already counted does not close stdin early', async () => {
  const b = bench();
  let handle: SpawnHandle | null = null;
  let asked = false;
  const outcome = await spawnClaude({
    prompt: 'BOOT phase 2',
    cwd: b.dir,
    // A duplicate result for turn 1, reporting the same `num_turns`. The
    // counter treated it as an answer and decremented to zero, closing stdin
    // with a question still in flight.
    env: { ...b.env, PC_STUB_EXTRA_RESULT: '1' },
    onHandle: (h) => { handle = h; },
    onEvent: (event) => {
      if (event.kind !== 'result' || asked) return;
      asked = true;
      assert.equal(handle!.send(tagged('dddd4444', 'still there?')), true);
    },
  });

  assert.equal(b.heard().length, 2, 'the question was written');
  assert.equal(outcome.turns, 2, 'and got a turn of its own rather than a closed pipe');
  b.cleanup();
});

test('a session that goes silent with stdin open is closed by the watchdog', async () => {
  const b = bench();
  const events: StreamEvent[] = [];
  let handle: SpawnHandle | null = null;
  let asked = false;

  const outcome = await spawnClaude({
    prompt: 'BOOT phase 1',
    cwd: b.dir,
    // Never echoes and never results after the boot turn, so nothing the close
    // rule waits for will ever arrive. Without the watchdog this hangs.
    env: { ...b.env, PC_STUB_SILENT: '1' },
    idleCloseMs: 250,
    onHandle: (h) => { handle = h; },
    onEvent: (event) => {
      events.push(event);
      if (event.kind !== 'result' || asked) return;
      asked = true;
      handle!.send(tagged('eeee5555', 'anyone home?'));
    },
  });

  const idle = events.filter((e) => e.kind === 'idle') as { reason: string; afterMs: number }[];
  assert.equal(idle.length, 1, 'the close is announced, not silent');
  assert.match(idle[0].reason, /never echoed back/, 'and says which evidence never came');
  assert.ok(idle[0].afterMs >= 200);
  assert.ok(outcome.durationMs >= 200);
  b.cleanup();
});

/**
 * D21 — the bound that exists when no other clock in this file can arm.
 *
 * The measured hole: `armIdle` bails unless `phaseTurnDone`, which is set
 * exactly once inside the `result` handler, so a child hung BEFORE its first
 * result had no timer at all — not on a fresh attempt, not on a retry, not on a
 * recovery or a resume. Seven of eight boarding gaps over fifteen minutes in the
 * incident were that shape.
 *
 * `idleCloseMs: 0` in both tests is doing real work: it switches the OTHER
 * watchdog off, so a green here cannot be the idle close taking the credit.
 * Failing-before: with the backstop removed, `spawnClaude` never resolves and
 * the test times out rather than failing — the signature of this defect class.
 */
test('a session that never says anything at all is ended by the first-event backstop', async () => {
  const b = bench();
  const events: StreamEvent[] = [];

  const outcome = await spawnClaude({
    prompt: 'BOOT phase 1',
    cwd: b.dir,
    env: { ...b.env, PC_STUB_MUTE: '1' },
    idleCloseMs: 0,
    firstEventMs: 250,
    onEvent: (event) => events.push(event),
  });

  const idle = events.filter((e) => e.kind === 'idle') as { reason: string; afterMs: number }[];
  assert.equal(idle.length, 1, 'the kill is announced, not silent');
  assert.match(idle[0].reason, /no output at all/, 'and says exactly what was observed');
  assert.ok(idle[0].afterMs >= 200);
  // Ended through the ordinary teardown, so the attempt settles as a session
  // exit that the normal machinery already knows how to classify — the whole
  // reason this reuses `onAbort` instead of a kill path of its own.
  assert.ok(outcome.durationMs >= 200);
  assert.equal(outcome.turns, 0);
  assert.equal(outcome.costUsd, 0);
  // …and the outcome says the SPAWN's own clock ended it, with the diagnosis
  // (SES-11): read as the external SIGTERM it used to arrive as, it halted the
  // run for a person who had pressed nothing.
  assert.equal(outcome.endedBy, 'spawn-watchdog');
  assert.match(outcome.endedReason ?? '', /no output at all/);
  assert.equal(outcome.signal.endedBy, 'spawn-watchdog');
  b.cleanup();
});

test('a session that emits nothing but API retries is NOT productive — the backstop still fires', async () => {
  // The eleven-hour lane. `emit` used to clear the first-event timer on the
  // first event of ANY kind, and a retry is an event — so the one clock that
  // would ever have ended this lane disarmed itself on the first symptom of the
  // thing it exists to catch. `sawProductive` is the split: `isProductiveEvent`
  // (runner/liveness.ts) is the codebase's single definition of the
  // distinction, and this is the second reader of it.
  const b = bench();
  const events: StreamEvent[] = [];

  await spawnClaude({
    prompt: 'BOOT phase 1',
    cwd: b.dir,
    env: { ...b.env, PC_STUB_RETRIES: '1' },
    idleCloseMs: 0,
    // Long enough for the child to boot and emit a dozen retries first: at a
    // shorter bound this could go green on "no output at all", which is the
    // very claim it exists to disprove.
    //
    // 10s, not the 1.5s this used to be. The bound races node's process boot,
    // and boot is what stretches under a loaded suite: at 1.5s this file was
    // one of the handful the phase 3 and 5 handoffs recorded flaking, and it
    // failed again on a full paced run (`expected /nothing but API retries/,
    // actual "no output at all"`) — the backstop reading the counter before
    // the child had written to it. Nothing here is timing-sensitive in the
    // other direction, so the margin is free: the test still ends the moment
    // the backstop fires, and only a genuinely regressed backstop waits 10s.
    firstEventMs: 10_000,
    onEvent: (event) => events.push(event),
  });

  const retries = events.filter((e) => e.kind === 'retry') as { category?: string; inferred?: boolean }[];
  assert.ok(retries.length >= 2, `the retries were streamed and parsed (${retries.length})`);
  // Inferred, because the CLI sent no category field — and marked as inferred,
  // so nothing downstream can mistake a guess for the CLI's own verdict.
  assert.equal(retries[0].category, 'rate_limit', 'read out of "429 Too Many Requests"');
  assert.equal(retries[0].inferred, true);

  const idle = events.filter((e) => e.kind === 'idle') as { reason: string }[];
  assert.equal(idle.length, 1, 'the backstop fired despite the stream');
  assert.match(
    idle[0].reason, /nothing but API retries/,
    'and says what it actually saw — "no output at all" would send a person looking for a dead process',
  );
  b.cleanup();
});

test('output nobody can parse is not silence — it is counted, and it is said', async () => {
  // Before: a bare `catch { return; }` with no log and no counter, so "the
  // session produced nothing" and "the session produced output this build
  // cannot read" were the same observation with opposite remedies.
  const b = bench();
  const events: StreamEvent[] = [];

  await spawnClaude({
    prompt: 'BOOT phase 1',
    cwd: b.dir,
    env: { ...b.env, PC_STUB_GARBAGE: '1' },
    idleCloseMs: 0,
    // Longer than the mute test's, and deliberately: this child has to be
    // STARTED and have written its two lines before the backstop reads the
    // counter. At 250 ms the bound fired while node was still booting and the
    // test went green for the wrong reason — "no output at all", which is the
    // very claim it exists to disprove.
    //
    // 1.5s was not enough either. Same failure, same cause, one order of
    // magnitude further out: see the sibling retries test above.
    firstEventMs: 10_000,
    onEvent: (event) => events.push(event),
  });

  const idle = events.filter((e) => e.kind === 'idle') as { reason: string }[];
  assert.equal(idle.length, 1);
  assert.match(
    idle[0].reason, /could not parse/,
    'the two lines the child DID write are named, rather than reported as silence',
  );
  b.cleanup();
});

/**
 * D12 — a freeze SUSPENDS the idle watchdog, and thawing forgives the silence.
 *
 * Held frozen for longer than `idleCloseMs`, this session would have had its
 * stdin closed by the watchdog: a SIGSTOPped child emits nothing, and to a clock
 * that measures silence a freeze and a wedged session look identical. That made
 * the lane card's promise — "continues mid-token, in the same process" — false
 * for any freeze longer than ten minutes, five minutes BEFORE the 15-minute
 * escalation that is supposed to be the only clock allowed to end one.
 *
 * The proportions are the real ones, scaled: the freeze here outlasts the idle
 * window by the same ratio a 12-minute freeze outlasts the 10-minute default.
 * Failing-before: with `setFrozen` a no-op, `send()` after the thaw returns
 * false and an `idle` event is on the wire.
 */
test('a frozen session is not idle-closed, and carries on after the thaw', async () => {
  const b = bench();
  const idleAt: number[] = [];
  let handle: SpawnHandle | null = null;
  let started = false;
  let thawedAt = 0;
  let resendOk: boolean | null = null;

  const outcome = await spawnClaude({
    prompt: 'BOOT phase 1',
    cwd: b.dir,
    env: { ...b.env, PC_STUB_SILENT: '1' },
    idleCloseMs: 200,
    onHandle: (h) => { handle = h; },
    onEvent: (event) => {
      if (event.kind === 'idle') { idleAt.push(Date.now()); return; }
      if (event.kind !== 'result' || started) return;
      started = true;
      // An outstanding question first, so the close rule cannot settle this
      // session by itself: from here the watchdog is the ONLY thing that can
      // close stdin, which is exactly the collision this test is about.
      handle!.send(tagged('c0c0feed', 'anyone home?'));
      handle!.setFrozen(true);
      // Held longer than the whole idle window — the stretch that used to close
      // it, in the same proportion a 12-minute freeze outlasts the 10-minute
      // default.
      setTimeout(() => {
        handle!.setFrozen(false);
        thawedAt = Date.now();
        // Mid-token resumption, as far as this stub can stand for it: the pipe
        // is still there and still takes a write.
        resendOk = handle!.send(tagged('c0c0feed', 'still there?'));
      }, 400);
    },
  });

  assert.equal(resendOk, true, 'stdin was never closed under the freeze');
  // The watchdog is not disabled, only suspended: it may still close this
  // session AFTER the thaw, and that is the behaviour being preserved.
  for (const at of idleAt) {
    assert.ok(at > thawedAt, 'no idle-close landed while the session was frozen');
  }
  assert.ok(outcome.durationMs >= 400, 'the freeze really did outlast the idle window');
  b.cleanup();
});

test('the session answers a tagged question, and the answer is attributed', async () => {
  const b = bench();
  const events: StreamEvent[] = [];
  let handle: SpawnHandle | null = null;
  let asked = false;

  await spawnClaude({
    prompt: 'BOOT phase 1',
    cwd: b.dir,
    env: { ...b.env, PC_STUB_ANSWER: '1' },
    onHandle: (h) => { handle = h; },
    onEvent: (event) => {
      events.push(event);
      if (event.kind !== 'result' || asked) return;
      asked = true;
      handle!.send(tagged('ffff6666', 'why was it cold?'));
    },
  });

  const answers = events.filter((e) => e.kind === 'answer') as { text: string; mark: string }[];
  assert.equal(answers.length, 1, 'the reply is not lost in the phase\'s own output');
  assert.equal(answers[0].mark, 'ask:ffff6666');
  // The tag is plumbing. It belongs in the correlation, not on the screen.
  assert.equal(answers[0].text, 'yes, because the cache was cold');
  b.cleanup();
});

test('a message sent after the session has finished is refused, not lost', async () => {
  const b = bench();
  let handle: SpawnHandle | null = null;
  await spawnClaude({ prompt: 'BOOT phase 1', cwd: b.dir, env: b.env, onHandle: (h) => { handle = h; } });

  assert.equal(handle!.open(), false, 'the session is gone and says so');
  assert.equal(handle!.send('too late'), false, 'refusing beats accepting into a void');
  assert.deepEqual(b.heard(), ['BOOT phase 1']);
  b.cleanup();
});

/* ------------------------------------------------------------------ *
 * What the console gets to show
 * ------------------------------------------------------------------ */

test('streamed deltas are coalesced, and a subagent keeps its own voice', async () => {
  const b = bench();
  const events: StreamEvent[] = [];
  await spawnClaude({
    prompt: 'BOOT phase 1', cwd: b.dir, env: b.env,
    partialMessages: true,
    onEvent: (event) => events.push(event),
  });

  const partial = events.filter((e) => e.kind === 'partial') as { text: string }[];
  assert.ok(partial.length >= 1, 'the words arrived as they were written');
  assert.equal(partial.map((p) => p.text).join(''), 'answer in pieces');
  assert.ok(partial.length < 3, 'and were gathered rather than sent one frame per token');

  const sub = events.filter((e) => e.kind === 'subagent') as { text: string; parent: string }[];
  assert.equal(sub.length, 1, 'a subagent is not interleaved into the phase text');
  assert.equal(sub[0].parent, 'toolu_sub');
  b.cleanup();
});

test('a tool call and its result are joined by id, and timed', async () => {
  const b = bench();
  const events: StreamEvent[] = [];
  await spawnClaude({
    prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_TOOLS: '1' },
    onEvent: (event) => events.push(event),
  });

  const call = events.find((e) => e.kind === 'tool' && e.id === 'toolu_bash') as
    { name: string; summary: string; id: string } | undefined;
  assert.ok(call, 'the tool_use id is captured — without it nothing can be correlated');
  assert.equal(call.name, 'Bash');
  assert.equal(call.summary, 'npm test -- --run');

  const result = events.find((e) => e.kind === 'tool-result' && e.id === 'toolu_bash') as
    { ok: boolean; ms?: number; detail?: string } | undefined;
  assert.ok(result, 'the result was dropped entirely before this');
  assert.equal(result.ok, true);
  assert.equal(typeof result.ms, 'number', 'a call with no duration is a name and nothing else');
  assert.ok(result.ms! >= 0);
  assert.match(result.detail ?? '', /40 tests passed/);
  b.cleanup();
});

test("every turn of the phase's own conversation is a step, and a subagent's never is", async () => {
  // The stream already said everything a turn CONTAINS; what it never said is
  // that a turn happened at all — and counting turns is the only way to see a
  // session reasoning in circles. `tool` events cannot be counted for it (one
  // turn calling three tools emits three) and `result` fires per turn only
  // after the stdin dance.
  const b = bench();
  const events: StreamEvent[] = [];
  await spawnClaude({
    prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_TOOLS: '1' },
    onEvent: (event) => events.push(event),
  });

  const steps = events.filter((e) => e.kind === 'step') as { tools: number }[];
  // Two turns of the phase's own: the one that called six tools, and the one
  // that only spoke. The subagent's turn — parented to `toolu_task`, and one
  // tool call of its own — is deliberately NOT among them: a delegating phase
  // sits with its own conversation stopped while the agent works, and counting
  // that as activity would hide exactly the stretch worth asking about.
  assert.deepEqual(steps.map((s) => s.tools), [6, 0]);

  // ...and the step for a turn arrives AFTER what that turn contained, so a
  // listener that counts steps and reacts to tools sees them in order.
  const firstStep = events.findIndex((e) => e.kind === 'step');
  const bashCall = events.findIndex((e) => e.kind === 'tool' && e.id === 'toolu_bash');
  assert.ok(bashCall >= 0 && bashCall < firstStep, 'the turn is reported once its contents have been');
  b.cleanup();
});

test('a session that only talks still reports its turn, with no tools in it', async () => {
  const b = bench();
  const events: StreamEvent[] = [];
  await spawnClaude({
    prompt: 'BOOT phase 1', cwd: b.dir, env: b.env, onEvent: (event) => events.push(event),
  });
  assert.deepEqual((events.filter((e) => e.kind === 'step') as { tools: number }[]).map((s) => s.tools), [0]);
  b.cleanup();
});

test('a Task names the agent it hands to, and its subagent\'s failures stay its own', async () => {
  const b = bench();
  const events: StreamEvent[] = [];
  await spawnClaude({
    prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_TOOLS: '1' },
    onEvent: (event) => events.push(event),
  });

  const task = events.find((e) => e.kind === 'tool' && e.id === 'toolu_task') as
    { agent?: string; delegates?: boolean; summary: string } | undefined;
  assert.equal(task?.agent, 'Explore', '"agent" as a label says nothing when three are running');
  assert.equal(task?.delegates, true);
  assert.equal(task?.summary, 'map the callers');

  // Measured, not assumed: the current CLI calls this `Agent`, and matching
  // only `Task` is silent — the subagent's words still arrive carrying a
  // parent, so the lane simply never opens and nothing says why.
  const agentCall = events.find((e) => e.kind === 'tool' && e.id === 'toolu_agent') as
    { agent?: string; delegates?: boolean } | undefined;
  assert.equal(agentCall?.delegates, true, 'a delegation under the CLI\'s own name for it');
  assert.equal(agentCall?.agent, undefined, 'and `subagent_type` is optional, so it may be unnamed');

  // A subagent's own calls used to be invisible: the whole `user` branch was
  // skipped whenever `parent_tool_use_id` was set.
  const inner = events.find((e) => e.kind === 'tool-result' && e.id === 'toolu_inner') as
    { ok: boolean; parent?: string; detail?: string } | undefined;
  assert.ok(inner, 'the subagent\'s result reached the console');
  assert.equal(inner.ok, false);
  assert.equal(inner.parent, 'toolu_task', 'attributed to the agent, not to the phase');
  assert.match(inner.detail ?? '', /no matches/);
  b.cleanup();
});

test('a TodoWrite surfaces the whole list, not a sentence about it', async () => {
  const b = bench();
  const events: StreamEvent[] = [];
  await spawnClaude({
    prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_TOOLS: '1' },
    onEvent: (event) => events.push(event),
  });

  const todos = events.find((e) => e.kind === 'todos') as
    { items: { content: string; status: string; activeForm?: string }[] } | undefined;
  assert.ok(todos, 'the array was being discarded one function call before it was kept');
  assert.equal(todos.items.length, 2);
  assert.deepEqual(todos.items.map((t) => t.status), ['completed', 'in_progress']);
  assert.equal(todos.items[1].activeForm, 'Adding the test');

  // And the console line for the same call says something rather than nothing.
  const line = events.find((e) => e.kind === 'tool' && e.id === 'toolu_todo') as { summary: string };
  assert.match(line.summary, /1\/2 done · Adding the test/);
  b.cleanup();
});

test('the task list the CLI really keeps — one row per call — reaches the client', async () => {
  // The plan for this phase said the list arrives as `TodoWrite`'s array. It
  // does not: a real run emits `TaskCreate` and `TaskUpdate`, one task at a
  // time. Both spellings are carried, because only one of them ever fires.
  const b = bench();
  const events: StreamEvent[] = [];
  await spawnClaude({
    prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_TOOLS: '1' },
    onEvent: (event) => events.push(event),
  });

  const created = events.find((e) => e.kind === 'task' && e.op === 'create') as
    { call?: string; content?: string; activeForm?: string } | undefined;
  assert.equal(created?.content, 'wire the endpoint', 'the title, not the brief');
  assert.equal(created?.activeForm, 'Wiring it');
  assert.equal(created?.call, 'toolu_new', 'carries its own call id, so its result can name it');

  const updated = events.find((e) => e.kind === 'task' && e.op === 'update') as
    { taskId?: string; status?: string } | undefined;
  assert.deepEqual([updated?.taskId, updated?.status], ['1', 'in_progress']);

  // A TaskUpdate's input has no summarisable key at all, so its console line
  // used to be the bare word "TaskUpdate".
  const line = events.find((e) => e.kind === 'tool' && e.id === 'toolu_upd') as { summary: string };
  assert.equal(line.summary, '#1 → in_progress');
  b.cleanup();
});

test('tool results do not disturb the close rule or the operator echo', async () => {
  // Both live in the same `user` branch now. If a result were mistaken for an
  // echo the phase would wedge, which is the bug this whole protocol exists to
  // have stopped — so it is worth asserting rather than assuming.
  const b = bench();
  const events: StreamEvent[] = [];
  let handle: SpawnHandle | null = null;
  let sent = false;
  const outcome = await spawnClaude({
    prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_TOOLS: '1' },
    onHandle: (h) => { handle = h; },
    onEvent: (event) => {
      events.push(event);
      // Send amid turn 1's tool traffic — after a tool event, before the
      // turn's result — which is the situation under test. This was a 60ms
      // wall-clock delay once, and a fast machine finished the whole stub
      // session inside it: a send after exit is a send to nobody.
      if (event.kind === 'tool' && !sent) {
        sent = true;
        handle!.send(tagged('bbbb2222', 'and this?'));
      }
    },
  });

  const injected = events.filter((e) => e.kind === 'injected') as { mark?: string; delivered?: boolean }[];
  assert.equal(injected.length, 1, 'the operator message was still recognised');
  assert.equal(injected[0].delivered, true);
  assert.equal(outcome.turns, 2, 'and the session ended by itself, both turns answered');
  b.cleanup();
});

test('a missing claude is reported as a missing claude', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-nostub-'));
  const outcome = await spawnClaude({
    prompt: 'BOOT phase 1', cwd: dir,
    env: { ...process.env, PATH: dir },
  });
  assert.match(outcome.resultText, /not on PATH/);
  assert.equal(outcome.costUsd, 0, 'a session that never started spent nothing');
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * The session id the child is told about itself (Phase 5)
 * ------------------------------------------------------------------ */

test('PE_SESSION_ID rides into the child\'s environment — the minted --session-id for a fresh session, the --resume id for a resumed one', async () => {
  const b = bench();
  try {
    await spawnClaude({ prompt: 'BOOT phase 1', cwd: b.dir, env: b.env });
    const argv = b.argv();
    const minted = argv[argv.indexOf('--session-id') + 1];
    assert.match(minted, /^[0-9a-f-]{36}$/, 'a fresh session gets a minted uuid');
    const seen = JSON.parse(readFileSync(join(b.dir, 'env.json'), 'utf8')) as { PE_SESSION_ID: string | null };
    assert.equal(seen.PE_SESSION_ID, minted, `the child knows its own id — phase-lock.sh and phase-outcome.sh read it (seen=${JSON.stringify(seen)} argv=${JSON.stringify(argv)})`);

    await spawnClaude({ prompt: 'go on', cwd: b.dir, env: b.env, resume: '11111111-2222-3333-4444-555555555555' });
    const again = JSON.parse(readFileSync(join(b.dir, 'env.json'), 'utf8')) as { PE_SESSION_ID: string | null };
    assert.equal(again.PE_SESSION_ID, '11111111-2222-3333-4444-555555555555');
    assert.ok(b.argv().includes('--resume'));

    // A caller that fixed the id ahead of time is honoured, not re-minted.
    await spawnClaude({ prompt: 'BOOT phase 2', cwd: b.dir, env: b.env, sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    const fixed = JSON.parse(readFileSync(join(b.dir, 'env.json'), 'utf8')) as { PE_SESSION_ID: string | null };
    assert.equal(fixed.PE_SESSION_ID, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.equal(b.argv()[b.argv().indexOf('--session-id') + 1], 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  } finally { b.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The session ledger (zero-touch-console phase 4, chapter 03 SES-1…SES-12)
 * ------------------------------------------------------------------ */

type RetryEvent = Extract<StreamEvent, { kind: 'retry' }>;
type DeniedEvent = Extract<StreamEvent, { kind: 'permission-denied' }>;
type ToolResultEvent = Extract<StreamEvent, { kind: 'tool-result' }>;

test('a session aborted after one API turn and no result is still booked — turns from the stream, and who ended it', async () => {
  // SES-1: `turns` and `costUsd` came from the `result` alone, and every
  // ending the console caused was a SIGTERM, which writes none — 27 of 88
  // records read 0 turns / $0 for 18.99 hours. This child has no SIGINT
  // handler, so it dies writing nothing: the stream is the only witness.
  const b = bench();
  try {
    const controller = new AbortController();
    const outcome = await spawnClaude({
      prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_STEP_HANG: '1' }, idleCloseMs: 0,
      signal: controller.signal,
      onEvent: (event) => { if (event.kind === 'tool') controller.abort('stop'); },
    });
    assert.equal(outcome.turns, 1,
      'one API turn — its thinking and its tool call arrive as two lines sharing a message id, and are one turn');
    assert.equal(outcome.turnsSource, 'stream');
    assert.equal(outcome.midTurn, true);
    assert.equal(outcome.steps, 1);
    assert.equal(outcome.endedBy, 'stop', 'the abort named its reason, and the outcome carries it');
    assert.equal(outcome.signal.endedBy, 'stop');
    assert.equal(outcome.costSource, 'none', 'no total_cost_usd ever arrived: unknown, not a measured zero');
    assert.equal(outcome.signal.code, 130, 'SIGINT, not SIGTERM, is what the abort sent first');
  } finally { b.cleanup(); }
});

test('SIGINT closes the turn: the interrupted session writes its result, and its dollars and turns are booked', async () => {
  // The measured CLI (test/fixtures/spikes/sigint.md): mid-tool SIGINT → the
  // interrupted call's result, the interrupt line, a `result` 10 ms later, a
  // clean exit. That result is the ledger a SIGTERM never let the CLI write.
  const b = bench();
  try {
    const controller = new AbortController();
    let abortedAt = 0;
    const outcome = await spawnClaude({
      prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_SIGINT_RESULT: '1' }, idleCloseMs: 0,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.kind === 'tool') { abortedAt = Date.now(); controller.abort('shutdown'); }
      },
    });
    assert.ok(outcome.costUsd > 0, `the interrupted turn's result booked the session's dollars (${outcome.costUsd})`);
    assert.equal(outcome.costSource, 'result');
    assert.equal(outcome.turns, 3, 'the CLI\'s own count, which covers more than the stream showed');
    assert.equal(outcome.turnsSource, 'result');
    assert.equal(outcome.midTurn, true, 'an aborted turn stopped — it did not finish');
    assert.equal(outcome.endedBy, 'shutdown');
    assert.equal(outcome.signal.terminalReason, 'aborted_tools');
    assert.equal(outcome.signal.isError, true);
    assert.equal(outcome.signal.code, 0, 'a clean exit: no SIGTERM was ever needed');
    assert.ok(Date.now() - abortedAt < INT_GRACE_MS, 'it left inside the interrupt\'s grace');
  } finally { b.cleanup(); }
});

test('a child that ignores SIGINT is termed after the interrupt grace — the backstop is still there', async () => {
  const b = bench();
  try {
    const controller = new AbortController();
    const outcome = await spawnClaude({
      prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_IGNORE_SIGINT: '1' }, idleCloseMs: 0,
      signal: controller.signal, interruptGraceMs: 300,
      onEvent: (event) => { if (event.kind === 'tool') controller.abort('stop'); },
    });
    assert.equal(outcome.signal.code, 143, 'SIGTERM ended it, once SIGINT had not');
    assert.equal(outcome.endedBy, 'stop', 'and the ending is still the one the abort named');
    assert.equal(outcome.turns, 1);
  } finally { b.cleanup(); }
});

test('system/api_retry is read from its documented field — the category and all four numbers', async () => {
  // SES-7 / DOC-1: the category was read from four field names the CLI has
  // never sent, so `server_error` was filed as free text and the retry arm
  // that acts on it could not be reached.
  const b = bench();
  try {
    const events: StreamEvent[] = [];
    const outcome = await spawnClaude({
      prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_DOC_RETRY: '1' },
      onEvent: (event) => events.push(event),
    });
    const retry = events.find((event) => event.kind === 'retry') as RetryEvent | undefined;
    assert.ok(retry, 'the retry was parsed');
    assert.equal(retry.category, 'server_error');
    assert.equal(retry.inferred, undefined, 'the CLI said it; nothing was guessed');
    assert.equal(retry.attempt, 3);
    assert.equal(retry.maxRetries, 15);
    assert.equal(retry.retryDelayMs, 2000);
    assert.equal(retry.errorStatus, 500);
    assert.deepEqual(outcome.signal.retryCategories, ['server_error'], 'and it reaches the classifier');
  } finally { b.cleanup(); }
});

test('every spawn carries both caps: the floor when none were named, the named ones otherwise, a bare number as `caller`', async () => {
  // SES-8: 0 of 507 lifetime argvs carried `--max-budget-usd`.
  const b = bench();
  try {
    const bare = await spawnClaude({ prompt: 'BOOT phase 1', cwd: b.dir, env: b.env });
    let argv = b.argv();
    assert.equal(argv[argv.indexOf('--max-budget-usd') + 1], String(SPAWN_DEFAULT_CAPS.maxBudgetUsd.value));
    assert.equal(argv[argv.indexOf('--max-turns') + 1], String(SPAWN_DEFAULT_CAPS.maxTurns.value));
    assert.equal(bare.caps?.maxBudgetUsd.source, 'spawn-default');
    assert.equal(bare.caps?.maxTurns.source, 'spawn-default');

    const named = await spawnClaude({
      prompt: 'BOOT phase 1', cwd: b.dir, env: b.env,
      caps: { maxTurns: { value: 150, source: 'size', basis: 'S' }, maxBudgetUsd: { value: 25, source: 'size', basis: 'S' } },
    });
    argv = b.argv();
    assert.equal(argv[argv.indexOf('--max-budget-usd') + 1], '25');
    assert.equal(argv[argv.indexOf('--max-turns') + 1], '150');
    assert.deepEqual(named.caps?.maxTurns, { value: 150, source: 'size', basis: 'S' });

    const numbers = await spawnClaude({ prompt: 'BOOT phase 1', cwd: b.dir, env: b.env, budgetUsd: 3, maxTurns: 7 });
    argv = b.argv();
    assert.equal(argv[argv.indexOf('--max-budget-usd') + 1], '3');
    assert.equal(numbers.caps?.maxBudgetUsd.source, 'caller');
  } finally { b.cleanup(); }
});

test('a session that initialised and then went silent before its first result is ended by the init→result bound', async () => {
  // SES-10: the first-event backstop is cleared by the `init` every session
  // emits at once, and the idle close waits for a result — so this child, a
  // stderr line and then nothing, had no clock inside spawn.ts at all.
  const b = bench();
  try {
    const events: StreamEvent[] = [];
    const outcome = await spawnClaude({
      prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_INIT_STDERR: '1' }, idleCloseMs: 0,
      initIdleMs: 400, onEvent: (event) => events.push(event),
    });
    const idle = events.filter((event) => event.kind === 'idle') as { reason: string; afterMs: number }[];
    assert.equal(idle.length, 1, 'the kill is announced');
    assert.match(idle[0].reason, /no result after init/);
    assert.ok(idle[0].afterMs >= 350, `measured from the last productive event (${idle[0].afterMs} ms)`);
    assert.equal(outcome.endedBy, 'spawn-watchdog');
    assert.match(outcome.endedReason ?? '', /no result after init/);
  } finally { b.cleanup(); }
});

test('the init→result bound never touches a session whose result came first', async () => {
  const b = bench();
  try {
    const events: StreamEvent[] = [];
    const outcome = await spawnClaude({
      prompt: 'BOOT phase 1', cwd: b.dir, env: b.env, initIdleMs: 2_000, onEvent: (event) => events.push(event),
    });
    assert.equal(events.filter((event) => event.kind === 'idle').length, 0);
    assert.equal(outcome.endedBy, 'exit', 'nothing in the console ended it');
    assert.equal(outcome.midTurn, false);
    assert.equal(outcome.signal.subtype, 'success');
  } finally { b.cleanup(); }
});

test('a denial the CLI announced is ONE event with its reason — the result\'s ledger adds no duplicate — and the refused result is marked', async () => {
  // The measured CLI 2.1.270 trio (test/fixtures/spikes/permissionrequest.md,
  // arm s2a-deny): `system/permission_denied`, the refused `tool_result`, and
  // the result's `permission_denials` naming the same call.
  const b = bench();
  try {
    const events: StreamEvent[] = [];
    const outcome = await spawnClaude({
      prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_DENIED: 'stream' },
      onEvent: (event) => events.push(event),
    });
    const denied = events.filter((event) => event.kind === 'permission-denied') as DeniedEvent[];
    assert.equal(denied.length, 1, 'one denial, one event');
    assert.deepEqual(denied[0], {
      kind: 'permission-denied', tool: 'Bash', toolUseId: 'toolu_deny', target: 'touch spike-s2-marker.txt',
      reason: 'spike listener: deny', reasonType: 'hook', source: 'stream',
    });
    const refused = events.filter((event) => event.kind === 'tool-result' && event.refused) as ToolResultEvent[];
    assert.equal(refused.length, 1, 'the words the session read are marked as a refusal');
    assert.equal(refused[0].tool, 'Bash');
    assert.equal(outcome.signal.permissionDenials?.length, 1, 'and the authoritative ledger reaches the classifier');
  } finally { b.cleanup(); }
});

test('a denial only the result\'s ledger records is announced from it, with its aim — and the CLI\'s refusal sentence marks the result', async () => {
  const b = bench();
  try {
    const events: StreamEvent[] = [];
    await spawnClaude({
      prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_DENIED: 'result' },
      onEvent: (event) => events.push(event),
    });
    const denied = events.filter((event) => event.kind === 'permission-denied') as DeniedEvent[];
    assert.equal(denied.length, 1);
    assert.equal(denied[0].source, 'result');
    assert.equal(denied[0].target, 'touch spike-s2-marker.txt');
    assert.equal(denied[0].reason, undefined, 'the ledger carries no reason, and none is invented');
    const refused = events.filter((event) => event.kind === 'tool-result' && event.refused);
    assert.equal(refused.length, 1, '"Claude requested permissions to use Bash…" is the CLI\'s own refusal');
  } finally { b.cleanup(); }
});

test('ACC-8.11 (TRS-8): the Q-08e refusal — a sensitive file the CLI will not let the session edit — journals as two DISTINCT events, each naming the target', async () => {
  const b = bench();
  try {
    const events: StreamEvent[] = [];
    await spawnClaude({
      prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_DENIED: 'sensitive' },
      onEvent: (event) => events.push(event),
    });
    const denied = events.filter((event) => event.kind === 'permission-denied') as DeniedEvent[];
    assert.equal(denied.length, 1, 'the result\'s authoritative ledger');
    assert.equal(denied[0].tool, 'Edit');
    assert.equal(denied[0].source, 'result');
    assert.match(String(denied[0].target), /house-rules\.md$/);
    const refused = events.filter((event) => event.kind === 'tool-result' && event.refused) as ToolResultEvent[];
    assert.equal(refused.length, 1, '"…which is a sensitive file." is the CLI\'s own refusal, not a failed command');
    assert.equal(refused[0].tool, 'Edit');
    assert.match(String(refused[0].target), /house-rules\.md$/, 'and it names what was refused, as the ledger does');
    assert.match(String(refused[0].detail), /which is a sensitive file/);
    assert.notEqual(denied[0].kind, refused[0].kind, 'two events, not one generic tool result');
  } finally { b.cleanup(); }
});

test('ACC-8.11 (QRL-9): --permission-prompts none rides a relay-off session and is absent from a relay-on one; a CLI known to predate it is refused the flag', async () => {
  for (const [prompts, expect] of [['none', true], [undefined, false]] as const) {
    const b = bench();
    try {
      await spawnClaude({ prompt: 'BOOT phase 1', cwd: b.dir, env: b.env, ...(prompts ? { permissionPrompts: prompts } : {}) });
      const argv = b.argv();
      assert.equal(argv.includes('--permission-prompts'), expect, `permissionPrompts ${prompts ?? 'absent'}`);
      if (expect) assert.equal(argv[argv.indexOf('--permission-prompts') + 1], 'none');
    } finally { b.cleanup(); }
  }
  assert.equal(PERMISSION_PROMPTS_CLI_FLOOR, '2.1.259');
  assert.deepEqual(permissionPromptsFor('off', '2.1.270'), { flag: 'none' }, 'relay off: the floor');
  assert.deepEqual(permissionPromptsFor(undefined, '2.1.259'), { flag: 'none' }, 'a run with no relay answer is off, and the floor version itself qualifies');
  assert.deepEqual(permissionPromptsFor('last-resort', '2.1.270'), { flag: null }, 'relay on: the relay answers prompts, so the flag would take them away');
  assert.deepEqual(permissionPromptsFor('off', undefined), { flag: 'none' }, 'an unknown version still gets the floor — an old CLI then fails loudly');
  assert.deepEqual(permissionPromptsFor('off', '2.1.258'), {
    flag: null, refused: { reason: 'below-floor', version: '2.1.258', floor: '2.1.259' },
  }, 'a known older CLI would reject the flag as an unknown option');
});

test('an interrupted call\'s "the tool use was rejected" is NOT a refusal — a stop is not a permission wall', async () => {
  const b = bench();
  try {
    const controller = new AbortController();
    const events: StreamEvent[] = [];
    await spawnClaude({
      prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_SIGINT_RESULT: '1' }, idleCloseMs: 0,
      signal: controller.signal,
      onEvent: (event) => { events.push(event); if (event.kind === 'tool') controller.abort('stop'); },
    });
    const results = events.filter((event) => event.kind === 'tool-result') as ToolResultEvent[];
    assert.equal(results.length, 1, 'the interrupted call\'s result arrived');
    assert.equal(results[0].ok, false);
    assert.equal(results[0].refused, undefined);
    assert.equal(events.filter((event) => event.kind === 'permission-denied').length, 0);
  } finally { b.cleanup(); }
});

test('a usage reading carries its unit: the wire\'s fraction and the meters\' percent, side by side', async () => {
  const b = bench();
  try {
    const events: StreamEvent[] = [];
    await spawnClaude({
      prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_RATE_LIMIT: '1' },
      onEvent: (event) => events.push(event),
    });
    const limits = events.find((event) => event.kind === 'limits') as Extract<StreamEvent, { kind: 'limits' }> | undefined;
    assert.ok(limits);
    assert.equal(limits.status, 'allowed_warning');
    assert.equal(limits.utilization, 0.99, 'the fraction every journal row and client read has always held');
    assert.equal(limits.utilizationPct, 99, 'the percent a threshold is compared against');
    assert.equal(limits.window, 'seven_day');
  } finally { b.cleanup(); }
});

test('the background-task ceiling is set explicitly on the child, and the tasks it killed are named on the signal', async () => {
  // SES-12: the CLI waits 600 s for background tasks at the end of a -p run
  // and then kills them; the console set neither the ceiling nor a reader.
  const b = bench();
  try {
    const env = { ...b.env, PC_STUB_BG_TASK: '1' };
    delete env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS;
    delete env.CLAUDE_CODE_MAX_RETRIES;
    const events: StreamEvent[] = [];
    const outcome = await spawnClaude({ prompt: 'BOOT phase 1', cwd: b.dir, env, onEvent: (event) => events.push(event) });
    assert.deepEqual(outcome.signal.backgroundTasks, [{ id: 'bash_7', description: 'npm test -- --run' }]);
    assert.match(outcome.signal.text ?? '', /Background tasks still running after 600s/);
    // …and a task the process took down with it is announced ended when the
    // process closes, so a lane the runner reuses for a closeout or a resume
    // never carries a dead session's task as outstanding (autopilot-token-drain P1).
    assert.deepEqual(events.filter((event) => event.kind === 'background'), [
      { kind: 'background', op: 'started', taskId: 'bash_7', description: 'npm test -- --run' },
      { kind: 'background', op: 'ended', taskId: 'bash_7', status: 'process-exited' },
    ]);
    const seen = JSON.parse(readFileSync(join(b.dir, 'env.json'), 'utf8')) as Record<string, string | null>;
    assert.equal(seen.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '600000', 'the documented default, set on purpose');
    assert.equal(seen.CLAUDE_CODE_MAX_RETRIES, '15');
  } finally { b.cleanup(); }
});

test('ACC-8.11 (AC-13): the floor and the relay never share an argv — a relay-on session carries the host and no --permission-prompts, a relay-off one the reverse', async () => {
  for (const [shape, expectHost, expectFloor] of [
    [{ permissionPromptTool: RELAY_HOST_TOOL }, true, false],
    [{ permissionPrompts: 'none' as const }, false, true],
    // A caller that set both gets the floor alone: `none` would take the prompt from the host anyway.
    [{ permissionPrompts: 'none' as const, permissionPromptTool: RELAY_HOST_TOOL }, false, true],
  ] as const) {
    const b = bench();
    try {
      await spawnClaude({ prompt: 'BOOT phase 1', cwd: b.dir, env: b.env, ...shape });
      const argv = b.argv();
      assert.equal(argv.includes('--permission-prompt-tool'), expectHost, JSON.stringify(shape));
      assert.equal(argv.includes('--permission-prompts'), expectFloor, JSON.stringify(shape));
      if (expectHost) assert.equal(argv[argv.indexOf('--permission-prompt-tool') + 1], 'mcp__pcrelay__hold');
    } finally { b.cleanup(); }
  }
});

test('ACC-8.11 (AC-13, QRL-5): the relay arms only at system/init.claude_code_version >= 2.1.268 — read from that field, never from capabilities, never on a version nobody read', async () => {
  assert.equal(RELAY_CLI_FLOOR, '2.1.268');
  assert.deepEqual(relayArmingFor('last-resort', '2.1.270'), { armed: true, version: '2.1.270', floor: '2.1.268' });
  assert.deepEqual(relayArmingFor('last-resort', '2.1.268'), { armed: true, version: '2.1.268', floor: '2.1.268' }, 'the floor itself arms');
  assert.deepEqual(relayArmingFor('last-resort', '2.1.267'), { armed: false, version: '2.1.267', floor: '2.1.268', refused: 'below-floor' });
  assert.deepEqual(relayArmingFor('last-resort', null), { armed: false, version: null, floor: '2.1.268', refused: 'version-unknown' });
  assert.deepEqual(relayArmingFor('off', '2.1.270'), { armed: false, version: '2.1.270', floor: '2.1.268' }, 'a relay-off run is simply not armed');

  // The reading a spawn hands the arming: `claude_code_version`, even when the
  // open `capabilities` set carries a member that sounds like permission.
  const b = bench();
  try {
    const events: StreamEvent[] = [];
    await spawnClaude({
      prompt: 'BOOT phase 1', cwd: b.dir,
      env: { ...b.env, PC_STUB_CLI_VERSION: '2.1.260', PC_STUB_CAPABILITY: 'permission_request_print_v1' },
      onEvent: (event) => events.push(event),
    });
    const init = events.find((event) => event.kind === 'init') as Extract<StreamEvent, { kind: 'init' }>;
    assert.equal(init.version, '2.1.260');
    assert.equal(relayArmingFor('last-resort', init.version).armed, false, 'a capability that names permission arms nothing');
  } finally { b.cleanup(); }
});

test('ACC-8.4 (TRS-2, S1): a -p run with the presence-only host is OFFERED AskUserQuestion in system/init.tools, and one without is not — the host\'s status rides mcp_servers', async () => {
  for (const [host, offered] of [[true, true], [false, false]] as const) {
    const b = bench();
    try {
      const events: StreamEvent[] = [];
      await spawnClaude({
        prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_HOST_STATUS: 'connected' },
        ...(host ? { permissionPromptTool: RELAY_HOST_TOOL } : { permissionPrompts: 'none' as const }),
        onEvent: (event) => events.push(event),
      });
      const init = events.find((event) => event.kind === 'init') as Extract<StreamEvent, { kind: 'init' }>;
      assert.equal(init.toolNames?.includes('AskUserQuestion'), offered, host ? 'with the host' : 'host-less');
      if (host) assert.deepEqual(init.mcpServers, [{ name: 'pcrelay', status: 'connected' }]);
    } finally { b.cleanup(); }
  }
});

test('ACC-8.4 (TRS-2): a control_request line is an event of its own — and a result ended on defer names the call it kept', async () => {
  const b = bench();
  try {
    const events: StreamEvent[] = [];
    await spawnClaude({ prompt: 'BOOT phase 1', cwd: b.dir, env: { ...b.env, PC_STUB_CONTROL_REQUEST: '1' }, onEvent: (event) => events.push(event) });
    const request = events.find((event) => event.kind === 'control-request');
    assert.deepEqual(request, { kind: 'control-request', requestId: 'req_1', subtype: 'can_use_tool', tool: 'AskUserQuestion' });
  } finally { b.cleanup(); }
  const d = bench();
  try {
    const events: StreamEvent[] = [];
    const outcome = await spawnClaude({ prompt: 'BOOT phase 1', cwd: d.dir, env: { ...d.env, PC_STUB_DEFER: '1' }, onEvent: (event) => events.push(event) });
    assert.deepEqual(events.find((event) => event.kind === 'deferred'), { kind: 'deferred', toolUseId: 'toolu_deferred', tool: 'AskUserQuestion' });
    assert.equal(outcome.signal.terminalReason, 'tool_deferred');
  } finally { d.cleanup(); }
});
