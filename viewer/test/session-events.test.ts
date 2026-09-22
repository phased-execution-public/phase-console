/**
 * `sessions/<id>.events.ndjson` — the RAW hook payloads, in arrival order.
 *
 * The record (`<id>.json`) is a projection: `applyEvent` folds every hook into
 * one current state, which is what every view wants and what no post-mortem
 * can use. "Why does this session read `unknown`" and "did the Stop hook fire
 * before or after the outcome landed" are both questions about the SEQUENCE,
 * and the sequence was thrown away the instant it was folded. Phase 13's
 * timeline is built on this file; so is any future argument about a presence
 * bug, which until now was unfalsifiable.
 *
 * Two properties are load-bearing.
 *
 * **The secret never reaches the file.** `HookPayload` carries
 * `messaging_token` — the CLI's cross-session inbox token, a real credential —
 * and `messaging_socket` with it. The whole reason `SessionView` is
 * `Omit<SessionRecord,'messaging'>` is that this must not be shown; writing the
 * raw payload to a durable, greppable, bundle-exported NDJSON would hand it
 * back through a different door. So the write is filtered, and the test plants
 * a token and asserts its absence rather than asserting on the filter.
 *
 * **The cap is a stop, not a truncation.** A session that loops writes events
 * forever. Past 1 MB the file stops with ONE `sessions.events-capped` line, so
 * a reader can tell "this session was quiet" from "we stopped listening" —
 * which is the distinction a silently-truncated file destroys.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  SESSION_EVENTS_CAP,
  SessionRegistry,
  readSessionEvents,
  sessionEventsFile,
} from '../server/sessions/registry.ts';

let seq = 0;
function registry(over: Record<string, unknown> = {}): { reg: SessionRegistry; dir: string } {
  seq += 1;
  const dir = mkdtempSync(join(tmpdir(), `phase-console-session-events-${seq}-`));
  mkdirSync(dir, { recursive: true });
  const reg = new SessionRegistry({ dir, ...over } as never);
  return { reg, dir };
}

function hook(over: Record<string, unknown> = {}): never {
  return {
    session_id: 'sess-1',
    event: 'SessionStart',
    cwd: '/repo',
    at: '2026-09-18T12:00:00.000Z',
    ...over,
  } as never;
}

test.after(() => {
  /* each fixture directory is under tmpdir and is swept with it */
});

test('SEV-1 — every ingested hook is one line, in arrival order', () => {
  const { reg, dir } = registry();
  reg.ingest(hook({ event: 'SessionStart' }));
  reg.ingest(hook({ event: 'Stop' }));
  reg.ingest(hook({ event: 'SessionEnd', reason: 'clear' }));

  const lines = readSessionEvents(dir, 'sess-1');
  assert.deepEqual(lines.map((one) => one.event), ['SessionStart', 'Stop', 'SessionEnd']);
  assert.equal(lines[2].payload.reason, 'clear', 'the raw payload is what is kept, not the projection');
  rmSync(dir, { recursive: true, force: true });
});

test('SEV-2 — the line shape phase 13 reads: v, at, appliedAt, via, lateMs, event, payload', () => {
  const { reg, dir } = registry({ now: () => new Date('2026-09-18T12:00:05.000Z') });
  reg.ingest(hook({ at: '2026-09-18T12:00:00.000Z' }), 'inbox');

  const raw = readFileSync(sessionEventsFile(dir, 'sess-1'), 'utf8').trim().split('\n');
  assert.equal(raw.length, 1);
  const line = JSON.parse(raw[0]) as Record<string, unknown>;
  assert.deepEqual(Object.keys(line).sort(), ['appliedAt', 'at', 'event', 'lateMs', 'payload', 'v', 'via'].sort());
  assert.equal(line.v, 1);
  assert.equal(line.via, 'inbox', 'which door the payload came through');
  assert.equal(line.at, '2026-09-18T12:00:00.000Z', 'the hook’s own clock');
  assert.equal(line.appliedAt, '2026-09-18T12:00:05.000Z', 'the console’s clock');
  assert.equal(line.lateMs, 5000, 'the gap between them — how far behind the inbox drain was');
  assert.equal((line.payload as Record<string, unknown>).via, undefined, 'via is a column, never buried in the payload');
  rmSync(dir, { recursive: true, force: true });
});

test('SEV-3 — the messaging token and socket never reach the file', () => {
  const { reg, dir } = registry();
  reg.ingest(
    hook({
      messaging_token: 'sk-live-do-not-write-this-anywhere',
      messaging_socket: '/tmp/claude-inbox-9f3a.sock',
    }),
  );

  const text = readFileSync(sessionEventsFile(dir, 'sess-1'), 'utf8');
  assert.ok(!text.includes('sk-live-do-not-write-this-anywhere'), 'the token is a credential');
  assert.ok(!text.includes('claude-inbox-9f3a.sock'), 'the socket names the token’s door');
  // …and the fact that there WAS one is kept, because that is the thing a
  // post-mortem needs to know and it is not itself a secret.
  const [line] = readSessionEvents(dir, 'sess-1');
  assert.equal((line.payload as Record<string, unknown>).messaging_token, '[redacted]');
  rmSync(dir, { recursive: true, force: true });
});

test('SEV-4 — past the cap the file stops with one capped line and no more', () => {
  const { reg, dir } = registry();
  const big = 'y'.repeat(4096);
  // Comfortably past 1 MB of payload, and then some more after the stop, so
  // "nothing is written after the marker" is a claim with evidence behind it.
  for (let i = 0; i < 400; i += 1) reg.ingest(hook({ event: 'Stop', reason: `${big}-${i}` }));
  const text = readFileSync(sessionEventsFile(dir, 'sess-1'), 'utf8');
  assert.ok(statSync(sessionEventsFile(dir, 'sess-1')).size < SESSION_EVENTS_CAP * 2, 'the cap bounds the file');
  const capped = text.split('\n').filter((line) => line.includes('sessions.events-capped'));
  assert.equal(capped.length, 1, `exactly one marker, got ${capped.length}`);
  assert.ok(text.trimEnd().endsWith(capped[0]), 'and it is the LAST line — nothing is written after the stop');
  rmSync(dir, { recursive: true, force: true });
});

test('SEV-5 — a session that never ingested has no file and reads as an empty list', () => {
  const { dir } = registry();
  assert.equal(existsSync(sessionEventsFile(dir, 'nobody')), false);
  assert.deepEqual(readSessionEvents(dir, 'nobody'), []);
  rmSync(dir, { recursive: true, force: true });
});

test('SEV-6 — an events log is pruned WITH its record, never left behind', () => {
  const { reg, dir } = registry({
    now: () => new Date('2026-09-18T12:00:00.000Z'),
  });
  reg.ingest(hook({ event: 'SessionEnd', at: '2026-09-01T00:00:00.000Z' }));
  assert.equal(existsSync(sessionEventsFile(dir, 'sess-1')), true);

  // Long enough that both retention floors are past. `load()` prunes as part
  // of reading, so the sweep has already happened by the time it returns.
  const later = new SessionRegistry({ dir, now: () => new Date('2026-11-01T00:00:00.000Z') } as never);
  later.load();
  assert.deepEqual(later.list(), [], 'the record was due and went');
  assert.equal(existsSync(join(dir, 'sess-1.json')), false);
  assert.equal(
    existsSync(sessionEventsFile(dir, 'sess-1')),
    false,
    'the events log outlived the record it belongs to',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('SEV-7 — the events file is not mistaken for a session record on load', () => {
  const { reg, dir } = registry();
  reg.ingest(hook());

  const warnings: string[] = [];
  const fresh = new SessionRegistry({ dir, onWarn: (event: string) => warnings.push(event) } as never);
  fresh.load();
  assert.deepEqual(warnings, [], `the loader read the NDJSON as a record: ${warnings.join(', ')}`);
  assert.equal(fresh.list().length, 1, 'exactly one session, not two');
  rmSync(dir, { recursive: true, force: true });
});

test('SEV-8 — an unmapped Notification changes no record, so it writes no line', () => {
  const { reg, dir } = registry();
  reg.ingest(hook({ event: 'Notification', notification_type: 'something-new-in-the-cli' }));
  assert.deepEqual(readSessionEvents(dir, 'sess-1'), [], 'a payload that moved nothing is not evidence of anything');
  rmSync(dir, { recursive: true, force: true });
});

test('SEV-9 — a heartbeat is recorded at most once a minute', () => {
  let clock = Date.parse('2026-09-18T12:00:00.000Z');
  const { reg, dir } = registry({ now: () => new Date(clock) });
  reg.ingest(hook());
  // Fifty beats inside one minute, then one after it.
  for (let i = 0; i < 50; i += 1) {
    clock += 1_000;
    reg.heartbeat('sess-1');
  }
  clock += 61_000;
  reg.heartbeat('sess-1');

  const beats = readSessionEvents(dir, 'sess-1').filter((one) => one.event === 'heartbeat');
  assert.equal(beats.length, 2, `a beat per stream event would be thousands a run; got ${beats.length}`);
  rmSync(dir, { recursive: true, force: true });
});

test('SEV-10 — the reader returns the newest lines when a limit is given', () => {
  const { reg, dir } = registry();
  for (let i = 0; i < 10; i += 1) reg.ingest(hook({ event: 'Stop', reason: `r${i}` }));
  const tail = readSessionEvents(dir, 'sess-1', 3);
  assert.equal(tail.length, 3);
  assert.deepEqual(
    tail.map((one) => (one.payload as Record<string, unknown>).reason),
    ['r7', 'r8', 'r9'],
  );
  rmSync(dir, { recursive: true, force: true });
});
