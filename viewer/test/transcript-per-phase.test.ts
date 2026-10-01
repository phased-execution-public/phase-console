/**
 * The replay is kept per PHASE (control-tower phase 94, #133).
 *
 * It was one file per run with a 16 MB hard stop. A long run crossed it within
 * days, and from then on every later phase of that run replayed nothing: the
 * operator watching trade P43 saw one line, "transcript full", six times, and
 * could not tell a working session from a dead one. The four runs watched on
 * 2026-09-25 were all at or near the cap.
 *
 * Now each phase appends to `run-<id>.p<N>.log.jsonl`, capped on its own, so a
 * phase that fills its file silences only itself; `seq` still runs across the
 * whole run, so the run-wide read merges the files in the order things
 * happened; 80 % of a phase's cap is journalled and carried on its record for
 * the card; and a phase whose replay has nothing answers from the journal and
 * says so, never with an empty pane.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { Journal } from '../server/runner/journal.ts';
import { runDir } from '../server/runner/run-paths.ts';
import type { StreamEvent } from '../server/runner/spawn.ts';
import {
  MAX_BYTES,
  NEAR_FULL_BYTES,
  type ReplayLimit,
  Transcript,
  readRunTranscript,
  replayFor,
  transcriptFile,
} from '../server/runner/transcript.ts';
import { boardHarness, journalled } from './lane-harness.ts';

const ID = 'abcd1234';
const trash: string[] = [];
test.after(() => { for (const dir of trash) rmSync(dir, { recursive: true, force: true }); });

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p94-per-phase-'));
  trash.push(dir);
  return dir;
}

/** Grow a file by `bytes` of lines no reader parses — what a long phase's history is, to the writer. */
function pad(path: string, bytes: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const row = `${'x'.repeat(64 * 1024 - 1)}\n`;
  let left = bytes;
  while (left > 0) {
    appendFileSync(path, left >= row.length ? row : `${'x'.repeat(Math.max(0, left - 1))}\n`);
    left -= row.length;
  }
}

const text = (entries: { data: Record<string, unknown> }[]) => entries.map((entry) => entry.data.text ?? entry.data.status);

test('RP-1 — each phase replays from its own file, and seq runs across the run', () => {
  const root = tmp();
  const writer = new Transcript(root, 'demo', ID);
  writer.append('phase', { phase: 1, status: 'running' });
  writer.append('stream', { phase: 2, kind: 'text', text: 'two' });
  writer.append('stream', { phase: 1, kind: 'text', text: 'one' });
  writer.append('verify', { phase: 2, command: 'npm test', index: 1, total: 1 });

  const names = readdirSync(runDir(root, 'demo')).filter((name) => name.includes('.log.jsonl')).sort();
  assert.deepEqual(names, [`run-${ID}.p1.log.jsonl`, `run-${ID}.p2.log.jsonl`], 'one file per phase, none for the run');

  assert.deepEqual(readRunTranscript(root, 'demo', ID, { phase: 1 }).map((entry) => entry.seq), [1, 3]);
  assert.deepEqual(text(readRunTranscript(root, 'demo', ID, { phase: 1 })), ['running', 'one']);
  assert.deepEqual(readRunTranscript(root, 'demo', ID, { phase: 2 }).map((entry) => entry.seq), [2, 4]);
  // The whole run, in the order it happened — what the Run tab and a finished
  // run's replay read.
  assert.deepEqual(readRunTranscript(root, 'demo', ID).map((entry) => entry.seq), [1, 2, 3, 4]);
  assert.deepEqual(readRunTranscript(root, 'demo', ID, { limit: 2 }).map((entry) => entry.seq), [3, 4], 'the run-wide tail');

  // A line with no phase still has a home: the run's own file, read with every phase.
  writer.append('stream', { kind: 'text', text: 'the run itself' });
  assert.ok(existsSync(transcriptFile(root, 'demo', ID)));
  assert.deepEqual(text(readRunTranscript(root, 'demo', ID, { phase: 2 })), ['two', undefined, 'the run itself']);
});

test('RP-1b — a run written before the split still replays each phase from the one old file', () => {
  // A run already under way when this console updates has every line in
  // `run-<id>.log.jsonl`. Its phases' replays are read from there, filtered.
  const root = tmp();
  const legacy = transcriptFile(root, 'demo', ID);
  mkdirSync(dirname(legacy), { recursive: true });
  const old = (seq: number, phase: number, text: string) =>
    `${JSON.stringify({ seq, at: '2026-09-25T07:00:00.000Z', event: 'stream', data: { phase, kind: 'text', text } })}\n`;
  appendFileSync(legacy, old(1, 1, 'old one') + old(2, 2, 'old two') + old(3, 1, 'old one again'));
  const writer = new Transcript(root, 'demo', ID);
  writer.append('stream', { phase: 1, kind: 'text', text: 'new one' });
  assert.deepEqual(text(readRunTranscript(root, 'demo', ID, { phase: 1 })), ['old one', 'old one again', 'new one']);
  assert.deepEqual(readRunTranscript(root, 'demo', ID, { phase: 1 }).map((entry) => entry.seq), [1, 3, 4], 'seq carries on from the old file');
  assert.deepEqual(text(readRunTranscript(root, 'demo', ID, { phase: 2 })), ['old two']);
});

test('RP-2 — a phase that filled its replay does not silence the phases after it', () => {
  const root = tmp();
  const writer = new Transcript(root, 'demo', ID);
  writer.append('stream', { phase: 3, kind: 'text', text: 'early' });
  pad(transcriptFile(root, 'demo', ID, 3), MAX_BYTES);
  assert.equal(writer.append('stream', { phase: 3, kind: 'text', text: 'past the cap' }), false);
  assert.equal(writer.append('stream', { phase: 7, kind: 'text', text: 'the phase being watched now' }), true);
  assert.deepEqual(text(readRunTranscript(root, 'demo', ID, { phase: 7 })), ['the phase being watched now']);
  // Phase 3's replay ends with the line that says why, and only once.
  const three = readRunTranscript(root, 'demo', ID, { phase: 3 });
  assert.match(String(three.at(-1)?.data.text), /transcript full/);

  // A re-drive is a new writer: phase 3 stays full, the next phase is not.
  const again = new Transcript(root, 'demo', ID);
  assert.equal(again.append('stream', { phase: 3, kind: 'text', text: 'still full' }), false);
  assert.equal(again.append('stream', { phase: 8, kind: 'text', text: 'the next phase' }), true);
  assert.deepEqual(text(readRunTranscript(root, 'demo', ID, { phase: 8 })), ['the next phase']);
  assert.equal(readRunTranscript(root, 'demo', ID, { phase: 3 }).filter((entry) => entry.data.marker === 'full').length, 1);
});

test('RP-4a — the writer reports a phase’s 80 % line and its cap, once per file', () => {
  const root = tmp();
  const limits: ReplayLimit[] = [];
  const writer = new Transcript(root, 'demo', ID, { onLimit: (limit) => limits.push(limit) });
  writer.append('stream', { phase: 5, kind: 'text', text: 'first' });
  const path = transcriptFile(root, 'demo', ID, 5);
  pad(path, NEAR_FULL_BYTES - statSync(path).size - 16);
  assert.deepEqual(limits, [], 'under the line, nothing to say');
  writer.append('stream', { phase: 5, kind: 'text', text: 'this line crosses 80 %' });
  writer.append('stream', { phase: 5, kind: 'text', text: 'and this one is past it' });
  assert.deepEqual(limits.map((limit) => [limit.phase, limit.state, limit.cap]), [[5, 'near-full', MAX_BYTES]]);
  assert.ok(limits[0]!.bytes >= NEAR_FULL_BYTES);

  // A new writer over the same file does not say it again.
  const again = new Transcript(root, 'demo', ID, { onLimit: (limit) => limits.push(limit) });
  again.append('stream', { phase: 5, kind: 'text', text: 'a re-drive' });
  assert.equal(limits.length, 1);

  pad(path, MAX_BYTES);
  assert.equal(again.append('stream', { phase: 5, kind: 'text', text: 'over the cap' }), false);
  assert.equal(again.append('stream', { phase: 5, kind: 'text', text: 'still over' }), false);
  assert.deepEqual(limits.map((limit) => limit.state), ['near-full', 'full']);
});

test('RP-4b — the runner journals the 80 % line and the phase record carries it for the card', async () => {
  const h = boardHarness({
    states: { 1: 'ready' },
    onSpawn: (phase, request, board) => {
      const id = (board.runner.current() as { id: string }).id;
      const path = transcriptFile(board.root, 'demo', id, phase);
      const size = existsSync(path) ? statSync(path).size : 0;
      pad(path, NEAR_FULL_BYTES - size - 16);
      request.onEvent?.({ kind: 'text', text: 'the line that crosses 80 % of the replay' } as StreamEvent);
      return undefined;
    },
  });
  await h.runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going', autoRecover: false } as never);
  await h.runner.wait();

  const rows = journalled(h, 'phase.replay-limit');
  assert.equal(rows.length, 1, 'journalled once');
  assert.equal(rows[0]!.phase, 1);
  assert.equal(rows[0]!.state, 'near-full');
  assert.equal(rows[0]!.cap, MAX_BYTES);
  const record = (h.runner.current() as { phases: Record<string, { replay?: { state: string; bytes: number; cap: number } }> })
    .phases['1'];
  assert.equal(record?.replay?.state, 'near-full', 'the phase record carries it — the card reads it from there');
  assert.equal(record?.replay?.cap, MAX_BYTES);
});

test('RP-6 — a phase whose replay has nothing answers from the journal, and says so', () => {
  const root = tmp();
  const journal = Journal.for(root, 'demo', ID);
  journal.append('phase.start', { attempt: 1 }, 4);
  journal.append('phase.parked', { reason: 'usage window spent' }, 4);
  journal.append('phase.start', { attempt: 1 }, 5);

  const four = replayFor(root, 'demo', ID, { phase: 4 });
  assert.equal(four[0]?.data.source, 'journal');
  assert.match(String(four[0]?.data.text), /nothing was replayed for phase 4/i, 'the pane says where its lines come from');
  assert.deepEqual(four.slice(1).map((entry) => entry.data.text), ['phase.start', 'phase.parked — usage window spent']);
  assert.ok(four.every((entry) => entry.data.phase === 4 && entry.event === 'stream'));

  // A phase that HAS a replay answers from it, and only from it.
  new Transcript(root, 'demo', ID).append('stream', { phase: 5, kind: 'text', text: 'live' });
  assert.deepEqual(replayFor(root, 'demo', ID, { phase: 5 }).map((entry) => entry.data.text), ['live']);
  // Nothing anywhere is an empty answer, not an invented one.
  assert.deepEqual(replayFor(root, 'demo', ID, { phase: 9 }), []);
});
