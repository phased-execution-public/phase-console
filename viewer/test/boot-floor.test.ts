/**
 * The boot floor (control-tower phase 59, #83, AUD-25 SIZ-2 and SIZ-6): the
 * context a session's FIRST API call reads — the system prompt, the tool
 * listing, CLAUDE.md, the rules, the memory index, the boot prompt — paid by
 * every session before it has done any work.
 *
 * The audit measured it from transcripts because nothing the console recorded
 * held it: `phase.tokens` kept the last and the peak context of a session, never
 * the first. Median 120k on hub and 82k on pe-hub over the week, 35.6 % of every
 * cache-read token booked, and on no surface at all. This file holds the fold
 * that now records it (`firstContext`), and the reading that turns the recorded
 * first calls into one line per repository (`bootFloorOf`), which is what makes
 * shrinking a repository's prefix — its instructions, rules, memory, tool
 * listing — a visible saving.
 *
 * The corpus is the two consoles of this machine, anonymised
 * (`fixtures/sizing/sessions-corpus.json`): console-a is the smaller prefix,
 * console-b the larger.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { foldUsage, newTokenCounters, newUsageTracker, usageOf } from '../server/runner/usage.ts';
import {
  BOOT_FLOOR_MIN_SAMPLES, bootFloorLine, bootFloorOf, bootFloorsByInstance, type SizingSession,
} from '../server/analysis/sizing-model.ts';

const wire = (input: number, cacheWrite: number, cacheRead: number, output: number) => ({
  input_tokens: input, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, output_tokens: output,
});

type Corpus = { sessions: (SizingSession & { instance: string })[] };
const CORPUS: Corpus = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'sizing', 'sessions-corpus.json'), 'utf8'));

test('BF-1: the fold records the first call\'s context, and no later call moves it', () => {
  const tracker = newUsageTracker();
  // P8's boot on hub: the first call builds a 111,781-token prefix.
  foldUsage(tracker, 'msg_boot', usageOf(wire(2, 101_653, 10_126, 409))!);
  assert.equal(tracker.counters.firstContext, 111_781);
  foldUsage(tracker, 'msg_2', usageOf(wire(2, 3_000, 111_781, 900))!);
  foldUsage(tracker, 'msg_3', usageOf(wire(2, 40_000, 114_781, 900))!);
  assert.equal(tracker.counters.firstContext, 111_781, 'the boot is the first call, whatever follows');
  assert.equal(tracker.counters.lastContext, 154_783);
  assert.equal(tracker.counters.peakContext, 154_783);
});

test('BF-2: the first call is the first call however many blocks carry it; a later call\'s blocks never touch it', () => {
  const tracker = newUsageTracker();
  foldUsage(tracker, 'msg_1', usageOf(wire(2, 90_000, 0, 10))!);
  // A later block of the SAME call reports more — still the first call, now known better.
  foldUsage(tracker, 'msg_1', usageOf(wire(2, 90_500, 0, 400))!);
  assert.equal(tracker.counters.firstContext, 90_502);
  foldUsage(tracker, 'msg_2', usageOf(wire(2, 1_000, 90_502, 10))!);
  foldUsage(tracker, 'msg_2', usageOf(wire(2, 2_000, 90_502, 10))!);
  assert.equal(tracker.counters.firstContext, 90_502, 'msg_2 grew; the boot did not');
});

test('BF-3: a session that made no call has no boot, and a resumed one\'s first call is not a boot', () => {
  assert.equal(newTokenCounters().firstContext, 0);
  const resumed = newUsageTracker({ resumed: true });
  foldUsage(resumed, 'msg_1', usageOf(wire(2, 554_419, 10_126, 1_292))!);
  // Recorded — it is what the call read — but the reading below never takes it
  // as a boot: a resume's first call re-reads the whole conversation.
  assert.equal(resumed.counters.firstContext, 564_547);
  const floor = bootFloorOf([
    ...Array.from({ length: BOOT_FLOOR_MIN_SAMPLES }, (_, i) => ({ firstContext: 100_000 + i, resumed: false, at: `2026-09-2${i}T00:00:00Z` })),
    { firstContext: 564_547, resumed: true, at: '2026-09-25T00:00:00Z' },
  ]);
  assert.ok(floor);
  assert.equal(floor.samples, BOOT_FLOOR_MIN_SAMPLES);
  assert.ok(floor.tokens < 110_000, 'the resumed first call is not in the median');
});

test('BF-4: the floor is a median with its evidence — and below the sample floor it is unmeasured, never a guess', () => {
  const sessions = [88_000, 91_000, 79_500, 93_000, 89_000].map((firstContext, i) => ({
    firstContext, resumed: false, at: `2026-09-${String(17 + i).padStart(2, '0')}T08:00:00Z`,
  }));
  const floor = bootFloorOf(sessions);
  assert.deepEqual(floor, {
    tokens: 89_000, samples: 5, min: 79_500, max: 93_000,
    from: '2026-09-17T08:00:00Z', to: '2026-09-21T08:00:00Z',
  });
  assert.equal(bootFloorOf(sessions.slice(0, BOOT_FLOOR_MIN_SAMPLES - 1)), null);
  // A session that recorded no first call (a line written before this phase) is not evidence.
  assert.equal(bootFloorOf([...sessions.slice(0, BOOT_FLOOR_MIN_SAMPLES - 1), { resumed: false, at: '2026-09-25T00:00:00Z' }]), null);
});

test('BF-5: the corpus — one boot floor per repository, and the larger prefix is ~30k larger (the audit read ~38k)', () => {
  const floors = bootFloorsByInstance(CORPUS.sessions);
  const a = floors.get('console-a');
  const b = floors.get('console-b');
  assert.ok(a && b, 'both consoles measured');
  assert.ok(a.tokens > 75_000 && a.tokens < 100_000, `console-a boots at ${a.tokens}`);
  assert.ok(b.tokens > 105_000 && b.tokens < 135_000, `console-b boots at ${b.tokens}`);
  const gap = b.tokens - a.tokens;
  assert.ok(gap > 20_000 && gap < 45_000, `the prefixes differ by ${gap}`);
  assert.ok(b.samples > 100, 'console-b is measured over its whole window');
});

test('BF-6: the boot floor is reported as its own line — what it is, where it was measured, how sure', () => {
  const measured = bootFloorLine({ tokens: 121_144, samples: 195, min: 69_980, max: 131_320, from: '2026-09-16T00:00:00Z', to: '2026-09-25T00:00:00Z' });
  assert.equal(measured, 'Boot floor: 121K per session — the first call\'s context on this repository, measured over 195 sessions (70K–131K)');
  assert.equal(
    bootFloorLine(null, 121_000),
    'Boot floor: 121K per session — shipped default; this repository has fewer than 3 measured sessions',
  );
});
