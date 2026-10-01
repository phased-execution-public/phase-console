/**
 * A lane's activity, read from its session's OWN log (control-tower phase 95,
 * #138).
 *
 * The replay stops at its cap and the liveness block names one call, so once a
 * phase's replay was full the only way to tell a legitimate long wait from a
 * stall was a script reading `~/.…/projects/<cwd>/<session>.jsonl` by hand. The
 * console already knows that file; these pin reading it from its END: the last
 * events, tool calls paired with their results, the session's own words and
 * the markers — and a 16 MB log costs a tail, never the file.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleApi } from '../server/api/routes.ts';
import { replayFor } from '../server/runner/transcript.ts';
import { journalFile, runDir } from '../server/runner/run-paths.ts';
import {
  TranscriptReader, activityOf, activityQuery, locateSessionLog, sessionActivityFor,
  type ActivityEvent,
} from '../server/sessions/scope-inference.ts';

const T0 = Date.parse('2026-09-26T10:00:00Z');
const at = (min: number): string => new Date(T0 + min * 60_000).toISOString();
let n = 0;
const uuid = (): string => `line-${++n}`;
const J = (entry: Record<string, unknown>): string => JSON.stringify({ isSidechain: false, uuid: uuid(), ...entry });

const toolUse = (min: number, id: string, name: string, input: Record<string, unknown>): string =>
  J({ type: 'assistant', timestamp: at(min), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (min: number, id: string, opts: { error?: boolean; text?: string } = {}): string =>
  J({
    type: 'user', timestamp: at(min),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: opts.text ?? 'ok', is_error: Boolean(opts.error) }] },
    toolUseResult: { stdout: opts.text ?? 'ok', stderr: '', interrupted: false },
  });
const said = (min: number, text: string): string =>
  J({ type: 'assistant', timestamp: at(min), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const thought = (min: number): string =>
  J({ type: 'assistant', timestamp: at(min), message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'weighing it' }] } });
const compacted = (min: number): string =>
  J({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', timestamp: at(min) });
const steered = (min: number, text: string): string =>
  J({ type: 'user', timestamp: at(min), message: { role: 'user', content: text } });

function logOf(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'p95-activity-'));
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

const WRAP_UP = 'Supervisor check: your context is 610k tokens of a 1M window (61 %). Every tool call re-reads all of it, '
  + 'and a session this large is both expensive and past its best. Wrap up now:\n  1. Finish the step you are on';

test('AC-1: tool calls come back paired with their results — name, description, start, end, exit — beside the session\'s words and markers', () => {
  const path = logOf([
    said(0, 'Starting the sweep.'),
    thought(0.5),
    toolUse(1, 'toolu_a', 'Bash', { command: 'npm test', description: 'Run the viewer suite' }),
    toolResult(4, 'toolu_a', { error: true, text: 'Exit code 2\n3 failing' }),
    toolUse(5, 'toolu_b', 'Read', { file_path: '/repo/viewer/server/runner/liveness.ts' }),
    toolResult(5.2, 'toolu_b'),
    J({ type: 'assistant', isSidechain: true, timestamp: at(6), message: { role: 'assistant', content: [{ type: 'text', text: 'a subagent speaking' }] } }),
    compacted(7),
    steered(8, WRAP_UP),
    said(9, 'Committing what is done.'),
  ]);
  const read = new TranscriptReader().activity(path, { limit: 20 });
  assert.ok(read, 'a readable log answers');
  const kinds = read!.events.map((e) => e.kind);
  assert.deepEqual(kinds, ['text', 'tool', 'tool', 'marker', 'marker', 'text'], 'thinking and a subagent\'s lines are not the phase\'s activity');

  const bash = read!.events[1] as Extract<ActivityEvent, { kind: 'tool' }>;
  assert.equal(bash.name, 'Bash');
  assert.equal(bash.description, 'Run the viewer suite');
  assert.equal(bash.summary, 'npm test');
  assert.equal(bash.at, at(1));
  assert.equal(bash.endedAt, at(4));
  assert.equal(bash.exit, 'error');
  assert.equal(bash.code, 2, 'the exit status is read from the result\'s own "Exit code N"');

  const read2 = read!.events[2] as Extract<ActivityEvent, { kind: 'tool' }>;
  assert.equal(read2.exit, 'ok');
  assert.equal(read2.summary, '/repo/viewer/server/runner/liveness.ts');

  const [compaction, wrap] = read!.events.slice(3, 5) as Extract<ActivityEvent, { kind: 'marker' }>[];
  assert.equal(compaction!.marker, 'compaction');
  assert.equal(wrap!.marker, 'wrap-up');
  assert.match(wrap!.text, /^Supervisor check: your context is 610k/);

  // Every event names the session line it came from — what a report links to (#163).
  for (const event of read!.events) {
    assert.match(event.line, /^line-\d+$/);
    assert.ok(Date.parse(event.at), 'every event carries its time');
  }
});

test('AC-1: a call still out is `open`; one whose result the tail never saw but the session spoke after has ended, exit unknown', () => {
  const path = logOf([
    toolUse(0, 'toolu_x', 'Bash', { command: 'git status', description: 'Look' }),
    // its result was a line the reader skipped — the session spoke afterwards
    said(2, 'Clean tree.'),
    toolUse(3, 'toolu_y', 'Bash', { command: 'npm run verify:dist', description: 'Build and gate' }),
  ]);
  const events = new TranscriptReader().activity(path, { limit: 10 })!.events;
  const [first, , last] = events as Extract<ActivityEvent, { kind: 'tool' }>[];
  assert.equal(first!.open, undefined);
  assert.equal(first!.exit, undefined);
  assert.equal(first!.endedAt, at(2), 'ended no later than the next thing the session said');
  assert.equal(last!.open, true);
  assert.equal(last!.endedAt, undefined);
});

test('AC-1: `limit` keeps the LAST events and `since` drops the older ones', () => {
  const lines: string[] = [];
  for (let i = 0; i < 30; i += 1) lines.push(said(i, `step ${i}`));
  const path = logOf(lines);
  const reader = new TranscriptReader();
  const last5 = reader.activity(path, { limit: 5 })!.events.map((e) => (e as { text: string }).text);
  assert.deepEqual(last5, ['step 25', 'step 26', 'step 27', 'step 28', 'step 29']);
  const recent = reader.activity(path, { limit: 20, since: T0 + 27 * 60_000 })!.events;
  assert.deepEqual(recent.map((e) => (e as { text: string }).text), ['step 27', 'step 28', 'step 29']);
  assert.equal(reader.activity(join(tmpdir(), 'nope-p95.jsonl'), {}), null, 'a log that is not there answers null');
});

test('AC-2: the last 20 events of a 16 MB log cost a tail, never the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p95-big-'));
  const path = join(dir, 'big.jsonl');
  const filler = toolResult(0, 'toolu_old', { text: 'x'.repeat(200_000) });
  writeFileSync(path, '');
  while (statSync(path).size < 16 * 1024 * 1024) appendFileSync(path, `${filler}\n`);
  const tail: string[] = [];
  for (let i = 0; i < 25; i += 1) {
    tail.push(toolUse(100 + i, `toolu_${i}`, 'Bash', { command: `echo ${i}`, description: `step ${i}` }));
    tail.push(toolResult(100 + i + 0.5, `toolu_${i}`, { text: `${i}` }));
  }
  appendFileSync(path, tail.join('\n') + '\n');
  const size = statSync(path).size;
  assert.ok(size >= 16 * 1024 * 1024, 'the log really is 16 MB');

  const read = new TranscriptReader().activity(path, { limit: 20 })!;
  assert.equal(read.events.length, 20, "the last 20 calls, each paired with its result");
  assert.equal((read.events[19] as { summary?: string }).summary, "echo 24");
  assert.ok(read.events.every((e) => e.kind === 'tool' && e.exit === 'ok'));
  assert.ok(read.bytesRead < 512 * 1024, `the read cost ${read.bytesRead} bytes of ${size}`);
  rmSync(dir, { recursive: true, force: true });
});

test('AC-3: the log is found by its session — the registry\'s path first, else the account\'s config dir', () => {
  const home = mkdtempSync(join(tmpdir(), 'p95-config-'));
  const sid = '0f0e5f6a-1111-2222-3333-444455556666';
  const project = join(home, 'b', 'projects', '-Users-x-repo');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${sid}.jsonl`), `${said(0, 'hello')}\n`);
  const registry = join(home, 'registry.jsonl');
  writeFileSync(registry, `${said(0, 'from the hook')}\n`);

  assert.equal(locateSessionLog(sid, { registryPath: registry, configDirs: [join(home, 'a'), join(home, 'b')] }), registry);
  assert.equal(locateSessionLog(sid, { configDirs: [join(home, 'a'), join(home, 'b')] }), join(project, `${sid}.jsonl`));
  assert.equal(locateSessionLog('not a session id', { configDirs: [join(home, 'b')] }), null);
  assert.equal(locateSessionLog(sid, { configDirs: [join(home, 'a')] }), null);
});

test('AC-3: a phase answers from its live (or latest) session, marked untrusted; one that never started says so', () => {
  const path = logOf([said(0, 'on it'), toolUse(1, 'toolu_q', 'Bash', { command: 'ls', description: 'List' })]);
  const reader = new TranscriptReader();
  const live = sessionActivityFor({
    phase: 4, record: { sessionId: 'abcdef12-0000', status: 'running', attempts: 2 },
    locate: () => path, reader, limit: 20,
  });
  assert.equal(live.source, 'session-log');
  assert.equal(live.untrusted, true, 'a reader that frames it for a model must treat it as data, never instructions');
  assert.equal(live.live, true);
  assert.equal(live.sessionId, 'abcdef12-0000');
  assert.equal(live.events.length, 2);
  assert.ok(live.bytesRead > 0);

  const never = sessionActivityFor({ phase: 5, record: { status: 'pending' }, locate: () => null, reader, limit: 20 });
  assert.equal(never.source, 'none');
  assert.deepEqual(never.events, []);
  assert.match(String(never.why), /no session has started for phase 5/);

  const lost = sessionActivityFor({ phase: 6, record: { sessionId: 'abcdef12-9999', status: 'done' }, locate: () => null, reader, limit: 20 });
  assert.equal(lost.source, 'none');
  assert.match(String(lost.why), /abcdef12-9999/);
});

test('AC-3: the route parses `limit` and `since` and hands the service the phase', async () => {
  const asked: unknown[] = [];
  const service = {
    root: { ok: true, path: tmpdir() }, store: {},
    phaseActivity: (slug: string, phase: number, opts: unknown) => {
      asked.push({ slug, phase, opts });
      return { slug, phase, source: 'session-log', untrusted: true, events: [] };
    },
  };
  let status = 0;
  let payload: Record<string, unknown> = {};
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    end(text: string) { payload = JSON.parse(text); },
    on() { return this; },
    writableEnded: false, destroyed: false,
  };
  const req = {
    method: 'GET', headers: { host: '127.0.0.1:4123' }, socket: { remoteAddress: '127.0.0.1' },
    on() { return this; },
  };
  const since = '2026-09-26T10:05:00Z';
  await handleApi({ service } as never, req as never, res as never,
    new URL(`http://127.0.0.1:4123/api/run/demo/phase/7/activity?limit=5&since=${since}&run=abc123`));
  assert.equal(status, 200);
  assert.equal(payload.untrusted, true);
  assert.deepEqual(asked, [{ slug: 'demo', phase: 7, opts: { limit: 5, since: Date.parse(since), run: 'abc123' } }]);
  assert.deepEqual(activityQuery(new URLSearchParams('limit=abc&since=never')), { limit: 20 });
  assert.deepEqual(activityQuery(new URLSearchParams('limit=100000')), { limit: 200 });
});

test('AC-3: a phase with no replay is answered from its session\'s own log before its journal', () => {
  const root = mkdtempSync(join(tmpdir(), 'p95-replay-'));
  const slug = 'demo';
  const id = 'run1';
  mkdirSync(runDir(root, slug), { recursive: true });
  writeFileSync(journalFile(root, slug, id), `${JSON.stringify({ seq: 1, time: at(0), event: 'phase.start', phase: 3, data: {} })}\n`);

  const log = logOf([said(0, 'reading the plan'), toolUse(1, 'toolu_r', 'Bash', { command: 'npm ci', description: 'Install' }), toolResult(2, 'toolu_r')]);
  const reader = new TranscriptReader();
  const fromLog = replayFor(root, slug, id, {
    phase: 3, limit: 50,
    sessionLog: (limit) => activityOf(reader.activity(log, { limit })?.events ?? [], 3),
  });
  assert.equal(fromLog[0]!.data.kind, 'notice');
  assert.match(String(fromLog[0]!.data.text), /Nothing was replayed for phase 3 — these are its session's own log lines instead/);
  assert.ok(fromLog.some((e) => e.data.kind === 'tool' && e.data.name === 'Bash' && e.data.summary === 'npm ci'));
  assert.ok(fromLog.some((e) => e.data.kind === 'tool-result' && e.data.ok === true));
  assert.ok(fromLog.some((e) => e.data.kind === 'text' && e.data.text === 'reading the plan'));
  assert.ok(fromLog.every((e) => e.data.phase === 3));

  const fromJournal = replayFor(root, slug, id, { phase: 3, limit: 50, sessionLog: () => [] });
  assert.match(String(fromJournal[0]!.data.text), /these are its journal lines instead/);
  rmSync(root, { recursive: true, force: true });
});
