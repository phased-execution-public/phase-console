/**
 * The SSE writer — what a client that stops reading costs this process.
 *
 * `res.write()` returning false is node telling you the socket is full and the
 * bytes are now yours to hold. The `/events` handler ignored that return for as
 * long as it existed, which is correct for a browser and catastrophic for a
 * phone on a sleeping tailnet: every serialized event stays in the write buffer
 * for as long as the socket lives, and a run streaming Opus output for a day
 * put four gigabytes there. The last GCs before the measured crash freed 28–43
 * MB of ~4 GB — the heap was RETAINED, not churning, which is the signature of
 * a buffer nobody drains rather than of allocation pressure.
 *
 * Two separate facts follow, and they need separate tests. The CAP (SSE-1..3)
 * bounds the damage a slow client can do: past four mebibytes of
 * `writableLength` the listener is retired, said once, and a browser reconnects
 * with `Last-Event-ID` and gets the replay it was designed for. The OPT-IN
 * (SSE-4..5) removes the source: a partial `run:stream` frame is interesting to
 * the one view that renders a transcript and to nobody else, so it now reaches
 * only a listener that asked for it, coalesced to one frame per lane per tick,
 * while everyone else moves on the 3-second `run:progress` instead.
 *
 * The fake response here is deliberately not a socket. `writableLength` is the
 * only property under test and a real socket drains on its own schedule, which
 * would make "did it drop at the cap" a race. A test that cannot say when the
 * buffer is full cannot prove a cap.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SSE_MAX_BUFFERED_BYTES,
  SSE_STREAM_COALESCE_MS,
  createSseWriter,
  type SseSink,
} from '../server/api/sse.ts';

const VIEWER = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A response that never drains: every chunk stays in `writableLength` until the
 * test says otherwise. That is exactly the client the cap exists for.
 */
function fakeRes(): SseSink & { chunks: string[]; drain(): void; ended: boolean } {
  const res = {
    chunks: [] as string[],
    writableLength: 0,
    writableEnded: false,
    destroyed: false,
    ended: false,
    write(chunk: string): boolean {
      res.chunks.push(chunk);
      res.writableLength += Buffer.byteLength(chunk);
      return res.writableLength < SSE_MAX_BUFFERED_BYTES;
    },
    end(): void {
      res.ended = true;
      res.writableEnded = true;
    },
    destroy(): void {
      res.destroyed = true;
    },
    drain(): void {
      res.writableLength = 0;
    },
  };
  return res;
}

test('SSE-1: a client that never reads is dropped once it passes the cap', () => {
  const res = fakeRes();
  let dropped: string | null = null;
  const writer = createSseWriter(res, { label: 'events', onDrop: (why) => { dropped = why; } });

  const chunk = `data: ${'x'.repeat(64 * 1024)}\n\n`;
  // Under the cap nothing is retired, whatever the client does with the bytes.
  for (let i = 0; i < 16; i++) writer.send(chunk);
  assert.equal(writer.dropped, false, 'a client under the cap is still a client');
  assert.equal(dropped, null);

  // And past it, exactly once.
  for (let i = 0; i < 64; i++) writer.send(chunk);
  assert.equal(writer.dropped, true, `${res.writableLength} buffered bytes and still writing`);
  assert.equal(dropped, 'slow-client');
  assert.ok(res.writableLength > SSE_MAX_BUFFERED_BYTES, 'the cap is measured, not assumed');
});

test('SSE-2: a dropped client is retired once — the listener goes and nothing more is written', () => {
  const res = fakeRes();
  let drops = 0;
  const writer = createSseWriter(res, { label: 'events', onDrop: () => { drops += 1; } });

  const chunk = `data: ${'x'.repeat(256 * 1024)}\n\n`;
  for (let i = 0; i < 64; i++) writer.send(chunk);
  assert.equal(writer.dropped, true);
  assert.equal(drops, 1, 'the listener is removed once, not once per further event');

  const written = res.chunks.length;
  res.drain();
  for (let i = 0; i < 10; i++) writer.send(chunk);
  assert.equal(res.chunks.length, written, 'a retired writer writes nothing, even to a drained socket');
  assert.equal(drops, 1);
  assert.equal(res.destroyed || res.ended, true, 'the socket is let go, not left half-open');
});

test('SSE-3: both event streams write through the one writer', () => {
  const routes = readFileSync(join(VIEWER, 'server/api/routes.ts'), 'utf8');
  const constructions = routes.match(/createSseWriter\(/g) ?? [];
  assert.equal(constructions.length, 2, '/events and the debug tail each build one writer');
  assert.equal(
    (routes.match(/\bres\.write\(/g) ?? []).length,
    0,
    'a raw res.write in a route is a second, uncapped sink — route it through the writer',
  );
  assert.equal(SSE_MAX_BUFFERED_BYTES, 4 * 1024 * 1024, 'the cap is four mebibytes per client');
});

test('SSE-4: a partial stream frame reaches only a listener that asked for it', () => {
  const plainA = fakeRes();
  const plainB = fakeRes();
  const asker = fakeRes();

  const writers = [
    createSseWriter(plainA, { label: 'events' }),
    createSseWriter(plainB, { label: 'events' }),
    createSseWriter(asker, { label: 'events' }),
  ];
  writers[2].subscribe('run-1');

  const before = [plainA.writableLength, plainB.writableLength];
  let id = 0;
  // A thousand partials across three lanes, the shape a run with three live
  // lanes produces in well under a minute.
  for (let i = 0; i < 1000; i++) {
    writers.forEach((w) => w.event('run:stream', {
      runId: 'run-1', phase: (i % 3) + 1, text: 'x'.repeat(512),
    }, ++id));
  }

  assert.deepEqual(
    [plainA.writableLength, plainB.writableLength],
    before,
    'a listener that did not ask for partials buffers not one byte of them',
  );
  assert.equal(asker.chunks.length, 0, 'the asker\'s frames are coalesced, not written per partial');

  writers[2].flushStream();
  const frames = asker.chunks.filter((c) => c.includes('event: run:stream'));
  assert.equal(frames.length, 3, 'one frame per lane per tick, not one per partial');
  assert.ok(frames.some((c) => c.includes('"phase":1')), 'every lane is represented');
  assert.ok(frames.some((c) => c.includes('"phase":3')));
  assert.ok(SSE_STREAM_COALESCE_MS > 0 && SSE_STREAM_COALESCE_MS <= 1000, 'a tick a person would call live');
});

test('SSE-5: a listener that asked for no partials still gets the coalesced progress', () => {
  const plain = fakeRes();
  const writer = createSseWriter(plain, { label: 'events' });

  writer.event('run:progress', { runId: 'run-1', phase: 2, spentUsd: 1.25 }, 1);
  writer.event('run:phase', { runId: 'run-1', phase: 2 }, 2);

  const names = plain.chunks.join('');
  assert.ok(names.includes('event: run:progress'), 'progress is how a plain listener moves');
  assert.ok(names.includes('event: run:phase'), 'and every coarse event still arrives as it did');
  assert.ok(names.includes('id: 1\n'), 'ids ride the frame so Last-Event-ID can replay');
});
