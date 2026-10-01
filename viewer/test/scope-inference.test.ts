/**
 * `TranscriptReader` — one reader of a session's own log, two questions
 * (control-tower phases 82 and 95).
 *
 * Phase 82 built it to answer what a terminal TOUCHED (`read`, an incremental
 * forward tail); phase 95 asks the same reader what a lane DID lately
 * (`activity`, from the log's end — #138). These pin that the two answers come
 * from one object without disturbing each other, and that a line still being
 * written is never read as an event.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TranscriptReader, activityOf, touchesOf } from '../server/sessions/scope-inference.ts';

const at = (min: number): string => new Date(Date.parse('2026-09-26T10:00:00Z') + min * 60_000).toISOString();
const edit = (min: number, id: string, path: string): string => JSON.stringify({
  type: 'assistant', uuid: `u-${id}`, timestamp: at(min),
  message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: path, old_string: 'a', new_string: 'b' } }] },
});
const result = (min: number, id: string): string => JSON.stringify({
  type: 'user', uuid: `r-${id}`, timestamp: at(min),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false }] },
});

test('one reader answers both questions — touches forward and incrementally, activity from the end — and neither disturbs the other', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'p95-reader-')), 'session.jsonl');
  writeFileSync(path, [edit(0, 't1', '/repo/app/a.ts'), result(1, 't1')].join('\n') + '\n');
  const reader = new TranscriptReader();

  assert.deepEqual(reader.read(path)?.paths.map((p) => p.path), ['/repo/app/a.ts']);
  const first = reader.activity(path, { limit: 10 })!;
  assert.deepEqual(first.events.map((e) => e.kind === 'tool' && [e.name, e.summary, e.exit]), [['Edit', '/repo/app/a.ts', 'ok']]);

  appendFileSync(path, [edit(2, 't2', '/repo/app/b.ts'), result(3, 't2')].join('\n') + '\n');
  // The touches read only the bytes appended since — and still see both edits.
  assert.deepEqual(reader.read(path)?.paths.map((p) => p.path), ['/repo/app/a.ts', '/repo/app/b.ts']);
  assert.deepEqual(reader.activity(path, { limit: 10 })!.events.map((e) => e.line), ['u-t1', 'u-t2']);
});

test('a line still being written is not an event, and the same bytes read the same as the touches parser reads them', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'p95-partial-')), 'session.jsonl');
  const whole = [edit(0, 't1', '/repo/app/a.ts'), result(1, 't1')].join('\n') + '\n';
  writeFileSync(path, whole + edit(2, 't2', '/repo/app/b.ts').slice(0, 40));
  const reader = new TranscriptReader();
  const events = reader.activity(path, { limit: 10 })!.events;
  assert.equal(events.length, 1, 'the torn tail is skipped, not parsed as garbage');
  assert.deepEqual(touchesOf(whole).paths.map((p) => p.path), ['/repo/app/a.ts']);
  // …and as replay lines, the call and its result, stamped with the phase.
  const lines = activityOf(events, 9);
  assert.deepEqual(lines.map((l) => [l.data.kind, l.data.phase, l.data.source]), [['tool', 9, 'session-log'], ['tool-result', 9, 'session-log']]);
});
