/**
 * The replay's writer and reader (control-tower phase 94, #133).
 *
 * Two defects, measured on 2026-09-25/26:
 *
 *   - **A notice per writer.** `full` and `shedding` were flags on the
 *     `Transcript` INSTANCE, and every re-drive, restart or relaunch makes a new
 *     one — so each wrote "transcript full" again (8 on the trade run) and, once
 *     latched, an instance stayed full even after the file was moved aside. The
 *     state now comes from the FILE: its last line is the marker.
 *   - **A whole-file read per question.** `readTranscript` read and split up to
 *     16 MB to answer a 400-line tail, on every request, and the constructor did
 *     the same to recover `seq`. Both now read from the END.
 *
 * The "from the end" proof is a sparse file past 2 GiB: it costs no disk, and
 * nothing can read it whole (`readFileSync` refuses a file that size), so a
 * reader that answers from it cannot have read it whole.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { MAX_BYTES, SHED_BYTES, Transcript, readTranscript, transcriptFile, transcriptQuery } from '../server/runner/transcript.ts';

const ID = 'abcd1234';
const trash: string[] = [];
test.after(() => { for (const dir of trash) rmSync(dir, { recursive: true, force: true }); });

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p94-transcript-'));
  trash.push(dir);
  return dir;
}

/** A replay line exactly as the writer frames one. */
function line(seq: number, phase = 1): string {
  return `${JSON.stringify({ seq, at: '2026-09-26T07:00:00.000Z', event: 'stream', data: { phase, kind: 'text', text: `line ${seq}` } })}\n`;
}

/** Bytes that are not a replay line — what an external writer (or a test) grows a file by. */
function pad(path: string, bytes: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const row = `${'x'.repeat(64 * 1024 - 1)}\n`;
  let left = bytes;
  while (left > 0) {
    appendFileSync(path, left >= row.length ? row : `${'x'.repeat(Math.max(0, left - 1))}\n`);
    left -= row.length;
  }
}

/** A file past 2 GiB whose only content is `count` replay lines at its end. */
function sparse(path: string, count: number, phase = 1): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
  truncateSync(path, 2 ** 31 + 4096);
  let body = '\n';
  for (let seq = 1; seq <= count; seq++) body += line(seq, phase);
  appendFileSync(path, body);
}

const rows = (path: string): string[] => readFileSync(path, 'utf8').split('\n').filter(Boolean);

test('RP-5a — readTranscript answers a tail from the END of the file, never the whole of it', () => {
  const path = join(tmp(), 'sparse.log.jsonl');
  sparse(path, 50);
  const started = Date.now();
  const tail = readTranscript(path, 20);
  assert.deepEqual(tail.map((entry) => entry.seq), Array.from({ length: 20 }, (_, i) => 31 + i), 'the last twenty, oldest first');
  assert.ok(Date.now() - started < 2_000, 'a tail of a 2 GiB file is one short read, not a scan');
});

test('RP-5b — a new writer recovers seq from the ends of the run’s files, never by parsing one whole', () => {
  const root = tmp();
  // Phase 1's replay is the huge one; phase 2 is where the next line goes.
  sparse(transcriptFile(root, 'demo', ID, 1), 50);
  const writer = new Transcript(root, 'demo', ID);
  assert.equal(writer.append('stream', { phase: 2, kind: 'text', text: 'next' }), true);
  const [next] = readTranscript(transcriptFile(root, 'demo', ID, 2), 1);
  assert.equal(next?.seq, 51, 'seq runs on across the run’s files, from the largest one’s last line');
});

test('RP-5c — a half-written last line is skipped, and the limit is honoured', () => {
  const path = join(tmp(), 'torn.log.jsonl');
  writeFileSync(path, line(1) + line(2) + line(3) + line(4) + '{"seq":5,"at":"2026-09-26T07:0');
  assert.deepEqual(readTranscript(path, 2).map((entry) => entry.seq), [3, 4]);
  assert.deepEqual(readTranscript(path).map((entry) => entry.seq), [1, 2, 3, 4]);
  assert.deepEqual(readTranscript(join(tmp(), 'missing.log.jsonl')), []);
});

test('RP-5d — the route’s query is bounded: a bad limit is the default, a huge one is clamped, a phase parses', () => {
  // `Number('abc')` is NaN, and the old reader treated a falsy limit as "the
  // whole file" — so `?limit=abc` returned all 16 MB.
  const q = (search: string) => transcriptQuery(new URLSearchParams(search));
  assert.deepEqual(q(''), { limit: 400 });
  assert.deepEqual(q('limit=abc'), { limit: 400 });
  assert.deepEqual(q('limit=0'), { limit: 400 });
  assert.deepEqual(q('limit=-5'), { limit: 400 });
  assert.deepEqual(q('limit=50&phase=7'), { limit: 50, phase: 7 });
  assert.equal(q('limit=999999').limit, 2_000);
  assert.deepEqual(q('phase=seven'), { limit: 400 });
  assert.deepEqual(q('phase=-1'), { limit: 400 });
});

test('RP-3a — the full notice is written once per FILE, however many writers meet it', () => {
  const root = tmp();
  const path = transcriptFile(root, 'demo', ID, 3);
  new Transcript(root, 'demo', ID).append('stream', { phase: 3, kind: 'text', text: 'hello' });
  pad(path, MAX_BYTES);
  // Eight writers: a re-drive, a restart, a relaunch each make a new one.
  for (let i = 0; i < 8; i++) {
    const writer = new Transcript(root, 'demo', ID);
    assert.equal(writer.append('stream', { phase: 3, kind: 'tool', name: 'Bash', summary: 'ls' }), false);
    assert.equal(writer.append('stream', { phase: 3, kind: 'tool', name: 'Bash', summary: 'ls' }), false);
  }
  const notices = rows(path).filter((row) => row.includes('transcript full'));
  assert.equal(notices.length, 1, 'said once per file, not once per writer');
  const marker = JSON.parse(notices[0]!) as { data: Record<string, unknown> };
  assert.equal(marker.data.marker, 'full');
  assert.equal(marker.data.phase, 3, 'the notice belongs to the phase whose replay it ends');
  assert.equal(rows(path).at(-1), notices[0], 'and it is the file’s last line — the marker the next writer reads');
});

test('RP-3b — the shedding notice is written once per file across writers too', () => {
  const root = tmp();
  const path = transcriptFile(root, 'demo', ID, 4);
  new Transcript(root, 'demo', ID).append('stream', { phase: 4, kind: 'text', text: 'hello' });
  pad(path, SHED_BYTES);
  for (let i = 0; i < 5; i++) {
    const writer = new Transcript(root, 'demo', ID);
    assert.equal(writer.append('stream', { phase: 4, kind: 'partial', text: 'a fragment' }), false, 'noise is shed');
    assert.equal(writer.append('stream', { phase: 4, kind: 'tool', name: 'Bash', summary: 'ls' }), true, 'tools are kept');
  }
  const notices = rows(path).filter((row) => row.includes('"notice"'));
  assert.equal(notices.length, 1, 'said once per file, not once per writer');
  assert.match(notices[0]!, /streamed fragments/);
});

test('RP-3c — no latch: a full file moved aside starts a fresh replay on the SAME writer', () => {
  // The 2026-09-26 workaround moved a full file aside and found a latched writer
  // stayed full for the life of its instance (#133's comment).
  const root = tmp();
  const path = transcriptFile(root, 'demo', ID, 6);
  const writer = new Transcript(root, 'demo', ID);
  writer.append('stream', { phase: 6, kind: 'text', text: 'before' });
  pad(path, MAX_BYTES);
  assert.equal(writer.append('stream', { phase: 6, kind: 'text', text: 'past the cap' }), false);
  renameSync(path, `${path}.full-20260926T070000Z`);
  assert.equal(writer.append('stream', { phase: 6, kind: 'text', text: 'after' }), true);
  assert.deepEqual(readTranscript(path).map((entry) => entry.data.text), ['after'], 'a fresh file, with no notice in it');
});
