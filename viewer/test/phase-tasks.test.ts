/**
 * The task-list channel, end to end — `scripts/phase-tasks.sh` → `runner/tasks.ts`.
 *
 * The wire format between them is a CONTRACT, and this file is where it is
 * enforced: the bash writer really runs here and the real parser reads what it
 * wrote, so a field renamed on one side fails the suite instead of failing an
 * operator with a permanently empty panel. `tests/unit/phase-tasks.bats` pins
 * the exact bytes the script emits; this pins what they MEAN.
 *
 * Why the channel exists at all: the CLI stopped provisioning TodoWrite /
 * TaskCreate / TaskUpdate to `claude -p` sessions around 2026-08-14 — measured
 * across 946 machine transcripts, not one call since — so the fold was correct
 * and starved. A shell script cannot be un-provisioned.
 */

// Redirects XDG_STATE_HOME before anything resolves it.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PHASE_CONSOLE_LOG = '';

const {
  consumeTasks, foldInboxTasks, foldTasks, inboxTasksFile, inboxTasksPhase, readInboxTasks, readTaskEvents, taskInboxDir,
  tasksFileFor,
} = await import('../server/runner/tasks.ts');
const {
  MAX_TASKS, TASK_TOOLS, adoptTaskId, foldTaskEvent, taskSummary, tasksFromList,
} = await import('../shared/task-model.js');
const { phaseRecord, newRun, resetForRetry } = await import('../server/runner/state.ts');
const { Transcript } = await import('../server/runner/transcript.ts');
const { DEFAULT_ALLOW } = await import('../server/runner/approvals.ts');

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(repoRoot, 'scripts', 'phase-tasks.sh');

/** Run the real script under the real target runtime (macOS system bash 3.2). */
function publish(file: string, slug: string, phase: number | string, ...args: string[]): void {
  execFileSync('/bin/bash', [script, slug, String(phase), ...args], {
    env: {
      ...process.env,
      PE_TASKS_FILE: file,
      PE_NOW: '2026-08-24T00:10:00Z',
      PE_SESSION_ID: 'sess-1',
    },
    encoding: 'utf8',
  });
}

function tmp(): string {
  return join(mkdtempSync(join(tmpdir(), 'pc-tasks-')), 'tasks.ndjson');
}

const forDemo = { slug: 'demo', phase: 8 };

test('the script writes what the parser reads — a whole list, end to end', () => {
  const file = tmp();
  publish(file, 'demo', 8, 'reset');
  publish(file, 'demo', 8, 'create', '--subject', 'p8.task1 — write it');
  publish(file, 'demo', 8, 'create', '--subject', 'p8.task2 — wire it', '--active-form', 'Wiring it');
  publish(file, 'demo', 8, 'update', '--id', 'p8.task1', '--status', 'completed');
  publish(file, 'demo', 8, 'update', '--id', 'p8.task2', '--status', 'in_progress');

  const { events } = readTaskEvents(file, forDemo);
  assert.equal(events.length, 5);
  assert.deepEqual(events[0], { op: 'reset' });
  assert.deepEqual(events[1], {
    op: 'create', taskId: 'p8.task1', content: 'p8.task1 — write it', status: 'pending',
  });

  const list = foldTasks(undefined, events);
  assert.deepEqual(list, [
    { id: 'p8.task1', content: 'p8.task1 — write it', status: 'completed' },
    { id: 'p8.task2', content: 'p8.task2 — wire it', activeForm: 'Wiring it', status: 'in_progress' },
  ]);
  // The one line every surface renders.
  assert.deepEqual(taskSummary(list), {
    total: 2, done: 1, active: 'Wiring it', label: '1/2 · Wiring it',
  });
});

test('the tail is incremental: the offset advances only over complete lines', () => {
  const file = tmp();
  publish(file, 'demo', 8, 'create', '--subject', 'one');
  const first = readTaskEvents(file, forDemo);
  assert.equal(first.events.length, 1);

  // Nothing new: the same offset, no events, no re-fold. This is what keeps a
  // console restart from doubling every task on a list it already holds.
  assert.deepEqual(readTaskEvents(file, forDemo, first.at), { events: [], at: first.at });

  publish(file, 'demo', 8, 'create', '--subject', 'two');
  const second = readTaskEvents(file, forDemo, first.at);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0]!.content, 'two');
  assert.ok(second.at > first.at);
});

test('a write caught mid-append is re-read whole, never parsed as a truncated record', () => {
  const file = tmp();
  publish(file, 'demo', 8, 'create', '--subject', 'one');
  const first = readTaskEvents(file, forDemo);

  // The writer, halfway through its line.
  appendFileSync(file, '{"version":1,"type":"task","slug":"demo","phase":8,"op":"crea');
  const torn = readTaskEvents(file, forDemo, first.at);
  assert.deepEqual(torn, { events: [], at: first.at }, 'the partial line is left for next time');

  // …and now it finishes.
  appendFileSync(file, 'te","id":"p8.task2","status":"pending","subject":"two","written_at":"2026-08-24T00:10:00Z"}\n');
  const whole = readTaskEvents(file, forDemo, first.at);
  assert.equal(whole.events.length, 1);
  assert.equal(whole.events[0]!.content, 'two');
});

test('a file that SHRANK is a different file — the offset restarts rather than reading mid-line', () => {
  const file = tmp();
  publish(file, 'demo', 8, 'create', '--subject', 'one');
  publish(file, 'demo', 8, 'create', '--subject', 'two');
  const { at } = readTaskEvents(file, forDemo);

  consumeTasks(file);
  publish(file, 'demo', 8, 'create', '--subject', 'fresh');
  const after = readTaskEvents(file, forDemo, at);
  assert.equal(after.events.length, 1);
  assert.equal(after.events[0]!.content, 'fresh');
});

test('nothing not to be trusted survives the parser', () => {
  const file = tmp();
  writeFileSync(file, [
    'not json at all',
    '{"version":2,"type":"task","slug":"demo","phase":8,"op":"create","id":"a","subject":"x","written_at":"2026-08-24T00:10:00Z"}',
    '{"version":1,"type":"ruling","slug":"demo","phase":8,"op":"create","id":"b","subject":"x","written_at":"2026-08-24T00:10:00Z"}',
    '{"version":1,"type":"task","slug":"other","phase":8,"op":"create","id":"c","subject":"x","written_at":"2026-08-24T00:10:00Z"}',
    '{"version":1,"type":"task","slug":"demo","phase":9,"op":"create","id":"d","subject":"x","written_at":"2026-08-24T00:10:00Z"}',
    '{"version":1,"type":"task","slug":"demo","phase":8,"op":"bogus","id":"e","subject":"x","written_at":"2026-08-24T00:10:00Z"}',
    '{"version":1,"type":"task","slug":"demo","phase":8,"op":"create","id":"f","subject":"x"}',
    '{"version":1,"type":"task","slug":"demo","phase":8,"op":"create","id":"good","subject":"kept","written_at":"2026-08-24T00:10:00Z"}',
    '',
  ].join('\n'));
  const { events } = readTaskEvents(file, forDemo);
  assert.deepEqual(events.map((e) => e.taskId), ['good']);
});

test('staleness: a list written before THIS attempt does not speak for it', () => {
  const file = tmp();
  publish(file, 'demo', 8, 'create', '--subject', 'from the last attempt');

  // Written at 00:10:00Z; an attempt that started a minute later must not read it.
  assert.equal(
    readTaskEvents(file, { ...forDemo, notBefore: '2026-08-24T00:11:00.000Z' }).events.length, 0,
  );
  // …and the whole-second floor the outcome protocol learned the hard way: a
  // line written IN the second the attempt started is this attempt's own.
  assert.equal(
    readTaskEvents(file, { ...forDemo, notBefore: '2026-08-24T00:10:00.500Z' }).events.length, 1,
  );
});

test('the paths: one per run+phase, one inbox per plan', () => {
  assert.equal(
    tasksFileFor('/root', 'demo', 'r1', 8).endsWith('run-r1-p8-tasks.ndjson'), true,
  );
  assert.equal(taskInboxDir('/root', 'demo').endsWith('/tasks'), true);
  assert.equal(inboxTasksFile('/root', 'demo', 8).endsWith('/tasks/phase-08.ndjson'), true);
  assert.equal(inboxTasksPhase('/x/tasks/phase-08.ndjson'), 8);
  assert.equal(inboxTasksPhase('/x/tasks/phase-8.ndjson'), null);
  assert.equal(inboxTasksPhase('/x/tasks/rulings.ndjson'), null);
});

test('a padded phase is normalised on the way out — `08` is not a JSON number', () => {
  const file = tmp();
  // The exact shape that silently discarded a session's declared outcome once:
  // a session copies the padded number off its own handoff filename.
  publish(file, 'demo', '08', 'create', '--subject', 'one');
  const { events } = readTaskEvents(file, forDemo);
  assert.equal(events.length, 1, 'phase 08 parses as phase 8');
  assert.equal(events[0]!.taskId, 'p8.task1');
});

test('the fold: one function, three producers, and the identity contract', () => {
  // Reset on an empty list changes nothing, so the array comes back unchanged —
  // which is what lets `activity()` hand the same state to React and bail out.
  const empty: unknown[] = [];
  assert.equal(foldTaskEvent(empty, { op: 'reset' }), empty);

  let list = foldTaskEvent([], { op: 'create', taskId: 'a', content: 'one' });
  assert.equal(foldTaskEvent(list, { op: 'update', taskId: 'a' }), list, 'an update stating nothing');
  assert.equal(foldTaskEvent(list, { op: 'create' }), list, 'a create with no subject');
  assert.equal(foldTaskEvent(list, { op: 'update', taskId: 'ghost', status: 'completed' }), list,
    'an orphan update with no subject: we do not know what the task IS');

  // …but an orphan that carries its subject is adopted — a row late beats a row
  // lost. (The real fix for orphans is seeding from the record; this is the rest.)
  const adopted = foldTaskEvent(list, { op: 'update', taskId: 'ghost', content: 'late', status: 'completed' });
  assert.deepEqual(adopted.map((t: { id: string | null }) => t.id), ['a', 'ghost']);

  // A status the console does not know reads as `pending`: an unknown word must
  // never be what closes a row nobody closed.
  list = foldTaskEvent(list, { op: 'update', taskId: 'a', status: 'sideways' });
  assert.equal(list[0]!.status, 'pending');

  // `deleted` is a tombstone, not a state.
  assert.deepEqual(foldTaskEvent(list, { op: 'update', taskId: 'a', status: 'deleted' }), []);

  // The cap is the shared one, and it is the newest rows that survive.
  let big: unknown[] = [];
  for (let i = 0; i < MAX_TASKS + 10; i++) {
    big = foldTaskEvent(big, { op: 'create', taskId: `t${i}`, content: `task ${i}` });
  }
  assert.equal(big.length, MAX_TASKS);
  assert.equal((big[0] as { id: string }).id, 't10');
});

test('a whole-list rewrite REPLACES, and an empty one is a real write (r2 client-15)', () => {
  assert.equal(tasksFromList('not an array'), null, 'only a non-array means "not a task write"');
  assert.deepEqual(tasksFromList([]), [], 'an empty list is a list, not a silence');
  assert.deepEqual(
    tasksFromList([{ content: 'a', status: 'completed' }, { content: '', status: 'pending' }]),
    [{ id: null, content: 'a', status: 'completed' }],
    'rows without a subject are not rows',
  );
});

test('a TaskCreate learns its id from its own RESULT, in one place', () => {
  const created = foldTaskEvent([], { op: 'create', call: 'toolu_1', content: 'do it' });
  assert.equal(created[0]!.id, null);
  assert.equal(created[0]!.key, 'toolu_1');
  assert.equal(adoptTaskId(created, 'toolu_1', 'no id in here'), created, 'identity when nothing matches');

  const bound = adoptTaskId(created, 'toolu_1', 'Task #4 created successfully: do it');
  assert.equal(bound[0]!.id, '4');
  // …which is the whole point: every later update can now find it.
  assert.equal(foldTaskEvent(bound, { op: 'update', taskId: '4', status: 'completed' })[0]!.status, 'completed');
});

test('the summary never claims work that has not started', () => {
  const pending = foldTaskEvent([], { op: 'create', taskId: 'a', content: 'not started' });
  assert.deepEqual(taskSummary(pending), { total: 1, done: 0, active: null, label: '0/1' });
  assert.deepEqual(taskSummary([]), { total: 0, done: 0, active: null, label: null });
  assert.deepEqual(taskSummary(undefined), { total: 0, done: 0, active: null, label: null });
});

test('the tools whose absence started all this are named, not counted', () => {
  assert.deepEqual(TASK_TOOLS, ['TodoWrite', 'TaskCreate', 'TaskUpdate']);
});

test('a retry starts a fresh list — the fold and its offset are cleared together', () => {
  const state = newRun({ slug: 'demo', root: '/tmp/demo' } as never);
  const record = phaseRecord(state, 1);
  record.tasks = [{ id: 'a', content: 'from the last attempt', status: 'completed' }];
  record.tasksAt = 512;

  resetForRetry(record);

  // Both, or neither. Keeping the offset while deleting the file would leave
  // the tail reading past the end of a shorter one for ever; keeping the list
  // while resetting the offset would double every row the next attempt writes.
  assert.equal(record.tasks, undefined);
  assert.equal(record.tasksAt, undefined);
});

test('the transcript sheds its noise before it stops, and says so both times', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-transcript-'));
  const transcript = new Transcript(root, 'demo', 'r1');

  // Small file: everything is kept, noise included.
  assert.equal(transcript.append('stream', { kind: 'partial', text: 'a fragment' }), true);
  assert.equal(transcript.append('stream', { kind: 'tool', name: 'Bash', summary: 'ls' }), true);
  // …and only the three replayable events are candidates at all.
  assert.equal(transcript.append('run', { kind: 'text' }), false);

  const pad = (bytes: number) => appendFileSync(transcript.path, `${'x'.repeat(bytes)}\n`);

  // Past 4 MB the cheap content goes and the expensive content stays. What
  // filled those bytes was overwhelmingly `partial`, every fragment of which is
  // superseded by the `text` block that follows it — so a long run used to lose
  // its tool calls and its task list to make room for deltas already redundant.
  pad(4 * 1024 * 1024);
  assert.equal(transcript.append('stream', { kind: 'partial', text: 'a fragment' }), false);
  assert.equal(transcript.append('stream', { kind: 'thinking', text: 'working' }), false);
  assert.equal(transcript.append('stream', { kind: 'step', tools: 1 }), false);
  assert.equal(transcript.append('stream', { kind: 'hook', name: 'h', event: 'PreToolUse' }), false);
  assert.equal(transcript.append('stream', { kind: 'task', op: 'create', taskId: 'a' }), true);
  assert.equal(transcript.append('stream', { kind: 'tool', name: 'Bash', summary: 'ls' }), true);

  const shedNotice = readFileSync(transcript.path, 'utf8')
    .split('\n').filter((l) => l.includes('"notice"'));
  assert.equal(shedNotice.length, 1, 'said once, not once per event');
  assert.match(shedNotice[0]!, /streamed fragments/);

  // Past 16 MB it stops, and leaves the one line that explains why the replay
  // ends here — the old rule crossed a single wall in silence.
  pad(12 * 1024 * 1024);
  assert.equal(transcript.append('stream', { kind: 'tool', name: 'Bash', summary: 'ls' }), false);
  assert.equal(transcript.append('stream', { kind: 'tool', name: 'Bash', summary: 'ls' }), false);
  const full = readFileSync(transcript.path, 'utf8').split('\n').filter((l) => l.includes('transcript full'));
  assert.equal(full.length, 1, 'the wall is announced once and the transcript is closed');

  rmSync(root, { recursive: true, force: true });
});

test('the three task tools are pre-approved together, not one of them', () => {
  // `TodoWrite` was on the list from the start and its two successors were not,
  // so on any CLI that provisions them a session's every task write round-
  // tripped to the approval hook — for a call that writes a list into a panel.
  for (const tool of TASK_TOOLS) assert.ok(DEFAULT_ALLOW.includes(tool), `${tool} is not pre-approved`);
});

test('the unsupervised inbox is READ: a hand session\'s list folds from the file it wrote', () => {
  // `inboxTasksFile` was write-only — `phase-tasks.sh` wrote it with no
  // `PE_TASKS_FILE`, and no server code ever folded it. A person driving a
  // phase by hand (or the pty reviewer) got no panel at all.
  const root = mkdtempSync(join(tmpdir(), 'pc-inbox-'));
  try {
    const file = inboxTasksFile(root, 'demo', 8);
    publish(file, 'demo', 8, 'reset');
    publish(file, 'demo', 8, 'create', '--subject', 'p8.task1 — read the diff');
    publish(file, 'demo', 8, 'create', '--subject', 'p8.task2 — run the suite', '--status', 'in_progress');
    publish(file, 'demo', 8, 'update', '--id', 'p8.task1', '--status', 'completed');

    const tasks = readInboxTasks(root, 'demo', 8);
    assert.deepEqual(tasks.map((t) => [t.id, t.status]), [['p8.task1', 'completed'], ['p8.task2', 'in_progress']]);
    // A phase nobody published for reads as nothing, never as an error.
    assert.deepEqual(readInboxTasks(root, 'demo', 9), []);
    // A `reset` starts the list over — the same word it has in every channel.
    publish(file, 'demo', 8, 'reset');
    publish(file, 'demo', 8, 'create', '--subject', 'p8.task1 — again');
    assert.deepEqual(readInboxTasks(root, 'demo', 8).map((t) => t.content), ['p8.task1 — again']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the terminal state folds each QA reviewer\'s inbox onto its session — and onto nothing else', () => {
  // The other half of the channel: `agent.ts` hands a "QA this phase" session
  // `PE_TASKS_FILE`, and this is where `GET /api/terminal` reads it back, so
  // the reviewer's row on the Sessions page carries the same task line a lane
  // does. Structural over the session shape — a test needs no Terminals.
  const root = mkdtempSync(join(tmpdir(), 'pc-inbox-'));
  try {
    const file = inboxTasksFile(root, 'demo', 8);
    publish(file, 'demo', 8, 'create', '--subject', 'p8.task1 — read the diff', '--status', 'in_progress');
    const qa = { slug: 'demo', phase: 8 };
    const sessions = [
      { id: 'reviewer', kind: 'claude', meta: { qa } },
      // Ended: the record outlives the process so the page can say what it
      // did — its last list is part of that.
      { id: 'ended', kind: 'claude', exited: { code: 0 }, meta: { qa } },
      { id: 'wizard', kind: 'claude', meta: { intent: 'plan' } },
      { id: 'shell', kind: 'shell' },
      // A reviewer of a phase nobody published for: no key at all, never `[]`.
      { id: 'quiet', kind: 'claude', meta: { qa: { slug: 'demo', phase: 9 } } },
    ];
    const folded = foldInboxTasks(sessions, root);
    assert.deepEqual(
      folded.map((s) => [s.id, s.tasks?.map((t) => [t.id, t.status]) ?? null]),
      [
        ['reviewer', [['p8.task1', 'in_progress']]],
        ['ended', [['p8.task1', 'in_progress']]],
        ['wizard', null],
        ['shell', null],
        ['quiet', null],
      ],
    );
    assert.equal('tasks' in folded[4], false, 'absent, not empty — the row builder tests `tasks?.length`');
    // No open root: nothing to read from, every session passes through as it was.
    assert.deepEqual(foldInboxTasks(sessions, undefined), sessions);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
