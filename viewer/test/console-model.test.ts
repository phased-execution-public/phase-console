/**
 * How a session's stream reads once it is on screen.
 *
 * The behaviour worth pinning down is the folding. Turning on
 * `--include-partial-messages` means the same sentence arrives twice — once as
 * a stream of token-sized deltas, then again as a finished block — and the
 * naive handling of that is a console that stutters every paragraph and holds
 * fifty rows where it should hold one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { toLine, fold, activity, NO_ACTIVITY, QUIET, KIND_LABEL, MAX_TOOLS } =
  await import('../shared/console-model.js');
const { TASK_STATUSES, TASK_STATUS_META } = await import('../shared/task-model.js');

const stream = (data: Record<string, unknown>) => toLine('stream', data);

/** Push a list of events through fold the way the console does. */
function play(events: Record<string, unknown>[]): { kind: string; text: string }[] {
  let lines: { kind: string; text: string }[] = [];
  let id = 0;
  for (const data of events) {
    const line = stream(data);
    if (line?.text) lines = fold(lines, line, ++id, 1000 + id);
  }
  return lines;
}

test('streamed fragments become one growing line, not one line each', () => {
  const lines = play([
    { kind: 'partial', text: 'Wiring ' },
    { kind: 'partial', text: 'the new ' },
    { kind: 'partial', text: 'endpoint' },
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Wiring the new endpoint');
});

test('the finished block replaces the fragments rather than repeating them', () => {
  const lines = play([
    { kind: 'partial', text: 'Wiring ' },
    { kind: 'partial', text: 'the new endpoint' },
    { kind: 'text', text: 'Wiring the new endpoint' },
  ]);
  assert.equal(lines.length, 1, 'the same sentence must not appear twice');
  assert.equal(lines[0].kind, 'text');
  assert.equal(lines[0].text, 'Wiring the new endpoint');
});

test('a finished block with nothing streamed before it is still shown', () => {
  const lines = play([
    { kind: 'tool', name: 'Read', summary: 'src/a.ts' },
    { kind: 'text', text: 'Done.' },
  ]);
  assert.deepEqual(lines.map((l) => l.kind), ['tool', 'text']);
});

test('a subagent keeps its own line and does not absorb the phase text', () => {
  const lines = play([
    { kind: 'partial', text: 'delegating' },
    { kind: 'subagent', text: 'searched 40 files' },
    { kind: 'partial', text: 'back' },
  ]);
  assert.deepEqual(lines.map((l) => l.kind), ['partial', 'subagent', 'partial']);
  assert.equal(lines[2].text, 'back', 'the phase resumed its own voice');
});

test('thinking is folded separately from the answer', () => {
  const lines = play([
    { kind: 'thinking', text: 'the user wants ' },
    { kind: 'thinking', text: 'an endpoint' },
    { kind: 'partial', text: 'Adding it now' },
  ]);
  assert.deepEqual(lines.map((l) => l.kind), ['thinking', 'partial']);
  assert.equal(lines[0].text, 'the user wants an endpoint');
});

test('the noisy kinds are the ones hidden by default, and only those', () => {
  assert.ok(QUIET.has('thinking'));
  assert.ok(QUIET.has('hook'));
  assert.ok(!QUIET.has('text'), 'the answer is never hidden');
  assert.ok(!QUIET.has('subagent'), 'delegated work is the gap this was built to close');
  assert.ok(!QUIET.has('injected'), "the operator's own question is never hidden");
});

test('an operator question reads as one, and every kind has a label', () => {
  const line = stream({ kind: 'injected', text: 'why did you skip the cache?' })!;
  assert.equal(line.kind, 'injected');
  assert.equal(KIND_LABEL[line.kind], 'btw');
  for (const kind of ['partial', 'thinking', 'subagent', 'hook', 'limits', 'injected']) {
    assert.ok(KIND_LABEL[kind], `${kind} has no label, so it would show its raw name`);
  }
});

test('one `/btw` renders once, and gains a tick when the session echoes it', () => {
  // Three renders of one write is what this stops. The client's own optimistic
  // echo is gone; the server's `injected` event and the CLI's replay of the
  // framed text both carry the same mark, so the second updates the first.
  const lines = play([
    { kind: 'injected', text: 'why did you skip the cache?', mark: 'ask:aaaa1111' },
    { kind: 'tool', name: 'Read', summary: 'src/index.ts' },
    // The echo carries the FRAMED text — the preamble the session actually saw.
    { kind: 'injected', text: 'An out-of-band question… why did you skip the cache?', mark: 'ask:aaaa1111', delivered: true },
  ]) as { kind: string; text: string; delivered?: boolean }[];

  const asked = lines.filter((l) => l.kind === 'injected');
  assert.equal(asked.length, 1, 'the question appears exactly once');
  assert.equal(asked[0].text, 'why did you skip the cache?', 'and in the operator\'s own words, not the frame');
  assert.equal(asked[0].delivered, true, 'with the delivery confirmed');
  assert.equal(lines.length, 2, 'the tool call between them was not disturbed');
});

test('a steer is not folded into a question that happens to be nearby', () => {
  const lines = play([
    { kind: 'injected', text: 'why?', mark: 'ask:aaaa1111' },
    { kind: 'injected', text: 'use the existing helper', mark: 'steer:bbbb2222', steer: true },
  ]);
  assert.equal(lines.length, 2, 'different marks, different lines');
  assert.deepEqual(lines.map((l) => l.kind), ['injected', 'steer']);
  assert.equal(KIND_LABEL.steer, 'steer');
});

test('the session\'s answer is attributed rather than lost in the phase text', () => {
  const lines = play([
    { kind: 'partial', text: 'yes, because ' },
    { kind: 'partial', text: 'the cache was cold' },
    { kind: 'answer', text: 'yes, because the cache was cold', mark: 'ask:aaaa1111' },
  ]) as { kind: string; text: string; mark?: string }[];
  // It supersedes its own fragments for the same reason a finished text block
  // does: those words already streamed, and repeating them under a new label is
  // the stutter twice over.
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'answer');
  assert.equal(lines[0].mark, 'ask:aaaa1111');
  assert.equal(KIND_LABEL.answer, 'answers');
});

test('a watchdog close says how long the silence was and what was missing', () => {
  const line = stream({ kind: 'idle', afterMs: 600_000, reason: '1 operator message(s) were never echoed back' })!;
  assert.match(line.text, /stdin closed after 600s of silence/);
  assert.match(line.text, /never echoed back/);
  assert.equal(KIND_LABEL.idle, 'idle');
});

test('the usage window is reported as a percentage a person can act on', () => {
  const line = stream({ kind: 'limits', status: 'allowed_warning', window: 'seven_day', utilization: 0.81 })!;
  assert.match(line.text, /81% of the seven day window used/);
  // No figure means nothing to say — better silent than "undefined%".
  assert.equal(stream({ kind: 'limits', status: 'allowed' }), null);
});

test('a phase line says the effort it started at, when there is one', () => {
  assert.match(
    toLine('phase', { status: 'running', phase: 3, model: 'opus', effort: 'xhigh' })!.text,
    /phase 3 started on opus at xhigh effort/,
  );
  assert.match(
    toLine('phase', { status: 'running', phase: 3, model: 'opus' })!.text,
    /phase 3 started on opus$/,
  );
});

test('the window is capped, and caps by dropping the oldest', () => {
  let lines: { text: string }[] = [];
  for (let i = 0; i < 700; i++) lines = fold(lines, { kind: 'tool', text: `t${i}` }, i + 1, i);
  assert.equal(lines.length, 600);
  assert.equal(lines[0].text, 't100', 'the oldest went, not the newest');
});

test('two subagents talking at once never share a line', () => {
  // Every subagent fragment shares `kind: 'subagent'` and `partial: true`, so
  // the old fold merged whichever arrived adjacently — which on two concurrent
  // agents is a sentence belonging to neither. Fragments still fold, but only
  // into the agent they came from; a change of speaker starts a new line, the
  // way a change of speaker does.
  const lines = play([
    { kind: 'subagent', text: 'reading ', parent: 'toolu_a' },
    { kind: 'subagent', text: 'src/index.ts', parent: 'toolu_a' },
    { kind: 'subagent', text: 'the schema ', parent: 'toolu_b' },
    { kind: 'subagent', text: 'has 40 tables', parent: 'toolu_b' },
    { kind: 'subagent', text: 'done', parent: 'toolu_a' },
  ]) as { kind: string; text: string; parent?: string }[];

  assert.deepEqual(
    lines.map((l) => [l.parent, l.text]),
    [['toolu_a', 'reading src/index.ts'], ['toolu_b', 'the schema has 40 tables'], ['toolu_a', 'done']],
    'each agent\'s own fragments joined; neither absorbed the other',
  );
});

test('the phase\'s own streamed text still folds, having no parent at all', () => {
  const lines = play([
    { kind: 'partial', text: 'one ' },
    { kind: 'partial', text: 'line' },
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'one line');
});

test('a tool line names the agent a delegation is handing to, when it said', () => {
  const named = stream({ kind: 'tool', name: 'Agent', summary: 'find the callers', id: 'toolu_1', delegates: true, agent: 'Explore' })!;
  assert.match(named.text, /Agent → Explore {2}find the callers/);
  // Unnamed is the ordinary case, and must not read as "Agent → undefined".
  const bare = stream({ kind: 'tool', name: 'Agent', summary: 'count them', id: 'toolu_2', delegates: true })!;
  assert.equal(bare.text, 'Agent  count them');
});

test('a successful tool result is not a second console line; a failure is', () => {
  // The call already printed a line going out. Repeating every success doubles
  // the console and says nothing; a failure is the thing being looked for.
  assert.equal(stream({ kind: 'tool-result', id: 'toolu_1', ok: true, ms: 120 }), null);
  const bad = stream({ kind: 'tool-result', id: 'toolu_1', ok: false, detail: 'no such file' })!;
  assert.equal(bad.kind, 'tool-fail');
  assert.equal(bad.text, 'no such file');
  assert.equal(KIND_LABEL['tool-fail'], 'failed');
});

test('a todo write is state, not a line', () => {
  assert.equal(stream({ kind: 'todos', items: [{ content: 'wire it', status: 'pending' }] }), null);
});

/* ---------------- the activity panels ---------------- */

/** Push events through the activity reducer the way the console does. */
function panels(events: [string, Record<string, unknown>][], at = 1000): Record<string, any> {
  let state = NO_ACTIVITY;
  for (const [event, data] of events) state = activity(state, event, data, at);
  return state;
}

test('a tool call is outstanding until its result comes back, then timed', () => {
  const started = panels([['stream', { kind: 'tool', name: 'Bash', summary: 'npm test', id: 'toolu_1' }]]);
  assert.equal(started.tools.length, 1);
  assert.equal(started.tools[0].ms, null, 'no result yet means still running, not "instant"');
  assert.equal(started.tools[0].ok, null);

  const finished = panels([
    ['stream', { kind: 'tool', name: 'Bash', summary: 'npm test', id: 'toolu_1' }],
    ['stream', { kind: 'tool-result', id: 'toolu_1', ok: true, ms: 94_000 }],
  ]);
  assert.equal(finished.tools[0].ms, 94_000);
  assert.equal(finished.tools[0].ok, true);
});

test('a failing result carries its reason onto the call it belongs to', () => {
  const state = panels([
    ['stream', { kind: 'tool', name: 'Read', summary: 'src/gone.ts', id: 'toolu_9' }],
    ['stream', { kind: 'tool-result', id: 'toolu_9', ok: false, detail: 'no such file' }],
  ]);
  assert.equal(state.tools[0].ok, false);
  assert.equal(state.tools[0].detail, 'no such file');
});

test('a result for a call nobody saw is dropped rather than invented', () => {
  const state = panels([['stream', { kind: 'tool-result', id: 'toolu_gone', ok: true, ms: 10 }]]);
  assert.equal(state.tools.length, 0);
});

test('the task list is the latest one, not every rewrite of it', () => {
  const state = panels([
    ['stream', { kind: 'todos', items: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }] }],
    ['stream', { kind: 'todos', items: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] }],
  ]);
  assert.equal(state.todos.length, 2);
  assert.deepEqual(state.todos.map((t: { status: string }) => t.status), ['completed', 'in_progress']);
});

test('the task list is also built one row at a time, which is what the CLI does', () => {
  // Measured, not assumed: a real run emits `TaskCreate`/`TaskUpdate` and never
  // `TodoWrite` — so a panel that only understood the whole-list spelling would
  // be permanently empty against a live session.
  const state = panels([
    ['stream', { kind: 'tool', name: 'TaskCreate', summary: 'wire it', id: 'toolu_c1' }],
    ['stream', { kind: 'task', op: 'create', call: 'toolu_c1', content: 'wire the endpoint' }],
    // The id comes back in the RESULT of the create, never in its input.
    ['stream', { kind: 'tool-result', id: 'toolu_c1', ok: true, detail: 'Task #1 created successfully: wire it' }],
    ['stream', { kind: 'task', op: 'update', taskId: '1', status: 'in_progress', activeForm: 'Wiring the endpoint' }],
  ]);

  assert.equal(state.todos.length, 1);
  assert.equal(state.todos[0].id, '1', 'the created row learned its id from its own result');
  assert.equal(state.todos[0].status, 'in_progress');
  assert.equal(state.todos[0].activeForm, 'Wiring the endpoint');
});

test('an update for a task that was never created changes nothing', () => {
  const state = panels([['stream', { kind: 'task', op: 'update', taskId: '7', status: 'completed' }]]);
  assert.deepEqual(state.todos, []);
});

test('a deleted task leaves the list rather than lingering as done', () => {
  const state = panels([
    ['stream', { kind: 'task', op: 'create', call: 'toolu_c1', content: 'a' }],
    ['stream', { kind: 'tool-result', id: 'toolu_c1', ok: true, detail: 'Task #1 created successfully: a' }],
    ['stream', { kind: 'task', op: 'create', call: 'toolu_c2', content: 'b' }],
    ['stream', { kind: 'tool-result', id: 'toolu_c2', ok: true, detail: 'Task #2 created successfully: b' }],
    ['stream', { kind: 'task', op: 'update', taskId: '1', status: 'deleted' }],
  ]);
  assert.deepEqual(state.todos.map((t: { content: string }) => t.content), ['b']);
});

test('two creates in flight bind to their own results, not to each other', () => {
  const state = panels([
    ['stream', { kind: 'task', op: 'create', call: 'toolu_a', content: 'first' }],
    ['stream', { kind: 'task', op: 'create', call: 'toolu_b', content: 'second' }],
    ['stream', { kind: 'tool-result', id: 'toolu_b', ok: true, detail: 'Task #9 created successfully: second' }],
    ['stream', { kind: 'tool-result', id: 'toolu_a', ok: true, detail: 'Task #8 created successfully: first' }],
  ]);
  assert.deepEqual(state.todos.map((t: { content: string; id: string }) => [t.content, t.id]),
    [['first', '8'], ['second', '9']]);
});

test('a subagent gets a lane named after the call that started it', () => {
  const state = panels([
    ['stream', { kind: 'tool', name: 'Agent', summary: 'map the callers', id: 'toolu_a', delegates: true, agent: 'Explore' }],
    ['stream', { kind: 'subagent', text: 'searched 40 files', parent: 'toolu_a' }],
  ]);
  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0].agent, 'Explore');
  assert.equal(state.agents[0].title, 'map the callers');
  assert.equal(state.agents[0].text, 'searched 40 files');
  assert.equal(state.agents[0].done, false);
});

test('a delegation with no type stated still opens a lane', () => {
  // `subagent_type` is optional on the tool. Opening the lane only when it is
  // present is how a real delegation ends up with its words in the log and no
  // lane to put them in.
  const state = panels([
    ['stream', { kind: 'tool', name: 'Agent', summary: 'count the widgets', id: 'toolu_a', delegates: true }],
    ['stream', { kind: 'subagent', text: 'six', parent: 'toolu_a' }],
  ]);
  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0].agent, '');
  assert.equal(state.agents[0].text, 'six');
});

test('an ordinary tool call opens no lane at all', () => {
  const state = panels([['stream', { kind: 'tool', name: 'Bash', summary: 'ls', id: 'toolu_b' }]]);
  assert.deepEqual(state.agents, []);
});

test('two concurrent agents are two lanes, and each closes on its own result', () => {
  const state = panels([
    ['stream', { kind: 'tool', name: 'Agent', summary: 'one', id: 'toolu_a', delegates: true, agent: 'Explore' }],
    ['stream', { kind: 'tool', name: 'Agent', summary: 'two', id: 'toolu_b', delegates: true, agent: 'Plan' }],
    ['stream', { kind: 'subagent', text: 'A says', parent: 'toolu_a' }],
    ['stream', { kind: 'subagent', text: 'B says', parent: 'toolu_b' }],
    ['stream', { kind: 'tool-result', id: 'toolu_a', ok: true, ms: 5000 }],
  ]);
  assert.equal(state.agents.length, 2);
  assert.deepEqual(state.agents.map((a: { text: string }) => a.text), ['A says', 'B says']);
  assert.deepEqual(state.agents.map((a: { done: boolean }) => a.done), [true, false]);
});

test('an agent heard before its Task call still gets a lane', () => {
  // A replay that starts mid-phase has the words and not the call.
  const state = panels([['stream', { kind: 'subagent', text: 'mid-sentence', parent: 'toolu_x' }]]);
  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0].agent, '', 'unnamed rather than absent');
  assert.equal(state.agents[0].text, 'mid-sentence');
});

test('a new phase starts with empty panels rather than the last one\'s work', () => {
  const state = panels([
    ['stream', { kind: 'todos', items: [{ content: 'old', status: 'completed' }] }],
    ['stream', { kind: 'tool', name: 'Bash', summary: 'old', id: 'toolu_old' }],
    ['phase', { status: 'running', phase: 5, model: 'opus' }],
  ]);
  assert.deepEqual(state.todos, []);
  assert.deepEqual(state.tools, []);
});

test('the tool list is capped, and caps by dropping the oldest', () => {
  const events: [string, Record<string, unknown>][] = [];
  for (let i = 0; i < MAX_TOOLS + 40; i++) events.push(['stream', { kind: 'tool', name: 'Read', summary: `f${i}`, id: `t${i}` }]);
  const state = panels(events);
  assert.equal(state.tools.length, MAX_TOOLS);
  assert.equal(state.tools[0].summary, 'f40', 'the oldest went, not the newest');
});

test('an event the panels do not care about leaves them untouched, by identity', () => {
  // Returning a fresh object for every delta would re-render three panels sixty
  // times a second for nothing.
  const before = panels([['stream', { kind: 'tool', name: 'Read', summary: 'a', id: 't1' }]]);
  assert.equal(activity(before, 'stream', { kind: 'partial', text: 'hello' }), before);
  // A verify event with no index is not addressable to a row, so it cannot
  // change the checklist — the identity contract holds for it too.
  assert.equal(activity(before, 'verify', { command: 'npm test' }), before);
});

/* ---------------- the verification, as it happens ---------------- */

test('a start opens a row and its result closes the SAME row', () => {
  const state = panels([
    ['verify', { phase: 3, command: 'npm test', index: 0, total: 2 }],
    ['verify', { phase: 3, command: 'npm run lint', index: 1, total: 2 }],
    ['verify', { phase: 3, command: 'npm test', index: 0, total: 2, ok: true, code: 0, ms: 4200 }],
  ]);
  assert.equal(state.verify.commands.length, 2, 'two commands, not three rows');
  assert.equal(state.verify.commands[0].state, 'passed');
  assert.equal(state.verify.commands[0].ms, 4200);
  assert.equal(state.verify.commands[1].state, 'running', 'the one still in flight says so');
});

test('two identical commands in one bullet are two rows — the index is what pairs them', () => {
  const state = panels([
    ['verify', { phase: 3, command: 'npm test', index: 0, total: 2 }],
    ['verify', { phase: 3, command: 'npm test', index: 1, total: 2 }],
    ['verify', { phase: 3, command: 'npm test', index: 1, total: 2, ok: false, code: 1, ms: 90 }],
  ]);
  assert.equal(state.verify.commands.length, 2);
  assert.equal(state.verify.commands[0].state, 'running');
  assert.equal(state.verify.commands[1].state, 'failed');
  assert.equal(state.verify.commands[1].code, 1);
});

test('a failed command carries a tail; a green one does not', () => {
  const state = panels([
    ['verify', { phase: 3, command: 'a', index: 0, total: 2, ok: false, code: 1, ms: 5, tail: 'AssertionError' }],
    ['verify', { phase: 3, command: 'b', index: 1, total: 2, ok: true, code: 0, ms: 5 }],
  ]);
  assert.equal(state.verify.commands[0].tail, 'AssertionError');
  assert.equal(state.verify.commands[1].tail, undefined);
});

test('the skips arrive before anything runs, and are their own list', () => {
  const state = panels([
    ['verify', { phase: 3, skipped: [{ command: 'rg foo', lead: 'rg', reason: '`rg` is not installed' }] }],
    ['verify', { phase: 3, command: 'npm test', index: 0, total: 1 }],
  ]);
  assert.equal(state.verify.skipped.length, 1);
  assert.equal(state.verify.skipped[0].lead, 'rg');
  assert.equal(state.verify.commands.length, 1, 'a skip is not a command that ran');
});

test('the verdict closes the list, and anything still running is not called a pass', () => {
  const state = panels([
    ['verify', { phase: 3, command: 'a', index: 0, total: 2 }],
    ['verify', { phase: 3, command: 'b', index: 1, total: 2 }],
    ['verify', { phase: 3, command: 'a', index: 0, total: 2, ok: true, code: 0, ms: 5 }],
    ['verify', { phase: 3, summary: { ok: false, reason: 'the run was stopped mid-verification', ran: 1, notRun: 1, skipped: 0 } }],
  ]);
  assert.equal(state.verify.summary.ok, false);
  assert.equal(state.verify.commands[0].state, 'passed');
  assert.equal(state.verify.commands[1].state, 'unknown', 'never a guess — it reported nothing');
});

test('a new phase starting clears the previous phase’s checklist', () => {
  const state = panels([
    ['verify', { phase: 3, command: 'a', index: 0, total: 1, ok: true, code: 0, ms: 5 }],
    ['phase', { phase: 4, status: 'running' }],
  ]);
  assert.deepEqual(state.verify.commands, []);
});

test('a phase leaving flight closes a checklist nothing else closed (QA r1 M4)', () => {
  // Every transcript recorded before the settled/summary events existed carries
  // ONLY starts. Without this the replay drew a card claiming both commands
  // were still running on a run that ended days ago — permanently, for every
  // historical run in an operator's console.
  const old = panels([
    ['verify', { phase: 3, command: 'npm test', index: 0, total: 2 }],
    ['verify', { phase: 3, command: 'npm run lint', index: 1, total: 2 }],
    ['phase', { phase: 3, status: 'done' }],
  ]);
  assert.deepEqual(old.verify.commands.map((c: { state: string }) => c.state), ['unknown', 'unknown']);

  // …and a phase still IN flight keeps its running row.
  const live = panels([
    ['verify', { phase: 3, command: 'npm test', index: 0, total: 1 }],
    ['phase', { phase: 3, status: 'verifying' }],
  ]);
  assert.equal(live.verify.commands[0].state, 'running');
});

test('the verify fold honours the identity contract (QA r1 L3)', () => {
  // Roughly nine in ten events change nothing, and this file's whole header is
  // about the React bail-out that depends on the same reference coming back.
  const started = panels([['verify', { phase: 3, command: 'a', index: 0, total: 1 }]]);
  assert.equal(activity(started, 'verify', { phase: 3, command: 'a', index: 0, total: 1 }, 1000), started);

  const settled = activity(started, 'verify', { phase: 3, command: 'a', index: 0, total: 1, ok: true, code: 0, ms: 5 }, 1000);
  assert.notEqual(settled, started, 'a real result IS news');
  assert.equal(activity(settled, 'verify', { phase: 3, command: 'a', index: 0, total: 1, ok: true, code: 0, ms: 5 }, 1000), settled);

  const skips = { phase: 3, skipped: [{ command: 'rg x', lead: 'rg', reason: 'no rg' }] };
  const once = activity(settled, 'verify', skips, 1000);
  assert.notEqual(once, settled);
  assert.equal(activity(once, 'verify', skips, 1000), once, 'a re-sent skip list is the replay, not news');

  const verdict = { phase: 3, summary: { ok: true, reason: '1 command green', ran: 1, notRun: 0, skipped: 1 } };
  const closed = activity(once, 'verify', verdict, 1000);
  assert.equal(activity(closed, 'verify', verdict, 1000), closed);

  // A phase event with nothing open changes nothing either.
  assert.equal(activity(closed, 'phase', { phase: 3, status: 'done' }, 1000), closed);

  // …and the short-circuit is asked WHATEVER the summary says. Guarded on
  // `summary === null` it was disarmed the moment a verdict landed, and the
  // next re-sent identical result fell through and cleared it (QA r2 F4).
  const again = activity(closed, 'verify', { phase: 3, command: 'a', index: 0, total: 1, ok: true, code: 0, ms: 5 }, 2000);
  assert.equal(again, closed, 'a replayed result does not wipe a verdict that has landed');
  assert.ok(again.verify.summary, 'the verdict survives');
});

test('a row that genuinely changes after the verdict drops it', () => {
  // The other half of the same rule: a re-verification is news, and a summary
  // describing the previous pass must not sit over it.
  const closed = panels([
    ['verify', { phase: 3, command: 'a', index: 0, total: 1, ok: false, code: 1, ms: 5 }],
    ['verify', { phase: 3, summary: { ok: false, reason: '`a` exited 1', ran: 1, notRun: 0, skipped: 0 } }],
  ]);
  assert.equal(closed.verify.summary.ok, false);
  const rerun = activity(closed, 'verify', { phase: 3, command: 'a', index: 0, total: 1, ok: true, code: 0, ms: 7 }, 2000);
  assert.equal(rerun.verify.commands[0].state, 'passed');
  assert.equal(rerun.verify.summary, null, 'the stale verdict goes with it');
});

test('the task paint table is TOTAL — every status has a mark (QA r1 M2)', () => {
  // The guarantee `task-model.js` states. It named a test file that did not
  // exist; this is that file's job, here, where the vocabulary's other rules
  // are already pinned.
  assert.deepEqual(Object.keys(TASK_STATUS_META), [...TASK_STATUSES]);
  for (const status of TASK_STATUSES) {
    const meta = TASK_STATUS_META[status as keyof typeof TASK_STATUS_META];
    assert.ok(meta.label, `${status} needs a label`);
    assert.ok(meta.ui, `${status} needs a UI state`);
    assert.ok(meta.mark, `${status} needs a mark`);
  }
  // Distinct on BOTH channels — the whole point of #9.2 was that two statuses
  // differing by colour alone, on an aria-hidden dot, is not a difference.
  const uis = TASK_STATUSES.map((s: string) => TASK_STATUS_META[s as keyof typeof TASK_STATUS_META].ui);
  const marks = TASK_STATUSES.map((s: string) => TASK_STATUS_META[s as keyof typeof TASK_STATUS_META].mark);
  assert.equal(new Set(uis).size, TASK_STATUSES.length, 'no two statuses share a hue');
  assert.equal(new Set(marks).size, TASK_STATUSES.length, 'nor a shape');
});

test('every verify shape reads as a console line too, and the START shape is unchanged', () => {
  assert.deepEqual(toLine('verify', { command: 'npm test', index: 0, total: 2 }), {
    kind: 'verify', text: '[1/2] npm test',
  });
  assert.match(
    toLine('verify', { command: 'npm test', index: 0, total: 2, ok: false, code: 1, ms: 4200 })!.text,
    /\[1\/2\] failed, exit 1 in 4\.2 s/,
  );
  assert.match(
    toLine('verify', { command: 'npm test', index: 1, total: 2, ok: true, code: 0, ms: 500 })!.text,
    /\[2\/2\] passed in 500 ms/,
  );
  assert.match(
    toLine('verify', { skipped: [{ command: 'rg x', lead: 'rg', reason: 'no rg' }] })!.text,
    /1 command skipped — not installed on this machine \(rg\)/,
  );
  assert.match(
    toLine('verify', { summary: { ok: true, reason: '2 commands green' } })!.text,
    /verification passed — 2 commands green/,
  );
});
