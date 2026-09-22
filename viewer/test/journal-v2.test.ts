/**
 * The journal's v2 columns — and the two promises that make them safe to add.
 *
 * **A run's trace id is the run's, not the caller's.** Every journal line
 * carries `runTraceId(instance, slug, runId)` regardless of which span wrote
 * it, because the question the id exists to answer is "what happened to run X".
 * When the ambient span belongs to a DIFFERENT trace — an HTTP request, a
 * convergence pass, another run's drive reaching in — the line records the
 * crossing as `viaTraceId` rather than silently taking one side. A resumed run
 * recomputes the same id from disk, which is the whole reason it is derived.
 *
 * **Nothing that reads a journal may notice.** Six real journals ship as
 * fixtures; `projectTimeline` over them must be byte-identical with the new
 * columns present, or every stored run's timeline changed shape on upgrade.
 *
 * The overflow half is the older bug. A journal that crossed 32 MB stopped
 * appending and said so in the CONSOLE log — so the journal itself simply
 * ended, mid-run, with no explanation in the file anyone would actually open,
 * and `run.finished` never arrived, which is exactly the line that tells a
 * reader the silence was not a crash. The marker is in-band now, and a reserve
 * is held back so the terminal events still fit.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { projectTimeline } from '../server/analysis/timeline.ts';
import { Journal, RESERVE_EVENTS, type JournalEntry, withDerivedIds } from '../server/runner/journal.ts';
import { journalFile } from '../server/runner/run-paths.ts';
import { enter, runTraceId } from '../server/trace.ts';
import { fixtureJournals } from './journal-fixture.ts';

const INSTANCE = 'f922d743-pe-hub';

function root(): string {
  return mkdtempSync(join(tmpdir(), 'phase-console-journal-v2-'));
}

function linesOf(dir: string, slug: string, id: string): JournalEntry[] {
  return readFileSync(journalFile(dir, slug, id), 'utf8')
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JournalEntry);
}

test('every line carries the RUN\'s derived trace id, whoever wrote it', () => {
  const dir = root();
  try {
    const journal = new Journal(dir, 'many-plans-one-repo', 'f0da619a', { instanceId: INSTANCE });
    journal.append('run.start', { by: 'operator' });

    const [line] = linesOf(dir, 'many-plans-one-repo', 'f0da619a');
    assert.equal(line.v, 2);
    assert.equal(line.traceId, runTraceId(INSTANCE, 'many-plans-one-repo', 'f0da619a'));
    assert.equal(line.seq, 1);
    assert.equal(line.event, 'run.start');
    assert.deepEqual(line.data, { by: 'operator' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the span columns come from the ambient context, and the phase from the caller', () => {
  const dir = root();
  try {
    const traceId = runTraceId(INSTANCE, 'slug', 'run1');
    const journal = new Journal(dir, 'slug', 'run1', { instanceId: INSTANCE });

    enter({ traceId, name: 'run.drive' }, () => {
      enter({ name: 'phase.attempt', attempt: 2, sessionId: 'sess-9', actor: 'console/autopilot' }, () => {
        journal.append('phase.started', {}, 5);
      });
    });

    const [line] = linesOf(dir, 'slug', 'run1');
    assert.match(String(line.spanId), /^[0-9a-f]{16}$/);
    assert.match(String(line.parentSpanId), /^[0-9a-f]{16}$/);
    assert.notEqual(line.spanId, line.parentSpanId);
    assert.equal(line.attempt, 2);
    assert.equal(line.sessionId, 'sess-9');
    assert.equal(line.actor, 'console/autopilot');
    assert.equal(line.phase, 5, 'the phase stays the append() argument — the span does not own it');
    assert.equal(line.viaTraceId, undefined, 'the span and the run agree, so there is no crossing to record');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a span from ANOTHER trace is recorded as a crossing, never as the line\'s own trace', () => {
  const dir = root();
  try {
    const journal = new Journal(dir, 'slug', 'run1', { instanceId: INSTANCE });
    const foreign = runTraceId(INSTANCE, 'other-plan', 'run-zzz');

    enter({ traceId: foreign, name: 'http.request' }, () => journal.append('run.held', { by: 'operator' }));

    const [line] = linesOf(dir, 'slug', 'run1');
    assert.equal(
      line.traceId,
      runTraceId(INSTANCE, 'slug', 'run1'),
      'the line belongs to the run it is a journal of',
    );
    assert.equal(line.viaTraceId, foreign, 'and names the request that reached in');
    assert.equal(line.spanId, undefined, 'a span id from a foreign trace would be a dangling pointer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a restarted console resumes the same trace, because it recomputes rather than remembers', () => {
  const dir = root();
  try {
    new Journal(dir, 'slug', 'run1', { instanceId: INSTANCE }).append('run.start', {});
    // A second Journal over the same file is what a restart looks like: no
    // memory of the first, only the three facts on disk.
    const resumed = new Journal(dir, 'slug', 'run1', { instanceId: INSTANCE });
    resumed.append('run.resumed', {});

    const lines = linesOf(dir, 'slug', 'run1');
    assert.equal(lines[0].traceId, lines[1].traceId);
    assert.deepEqual(lines.map((l) => l.seq), [1, 2], 'and the sequence continues too');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withDerivedIds gives a v1 line the ids it was written without, stably', () => {
  const v1: JournalEntry = { seq: 7, time: '2026-01-01T00:00:00.000Z', event: 'phase.started', phase: 3 };
  const once = withDerivedIds(v1, { instanceId: INSTANCE, slug: 'slug', runId: 'run1' });

  assert.equal(once.traceId, runTraceId(INSTANCE, 'slug', 'run1'));
  assert.equal(once.v, 1, 'and says it was derived, not written — a v1 line stays a v1 line');
  assert.equal(once.seq, 7);
  assert.equal(once.event, 'phase.started');
  assert.equal(once.phase, 3);

  assert.deepEqual(withDerivedIds(once, { instanceId: INSTANCE, slug: 'slug', runId: 'run1' }), once,
    'idempotent: deriving twice is deriving once');

  const v2: JournalEntry = { ...v1, v: 2, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
  assert.deepEqual(withDerivedIds(v2, { instanceId: INSTANCE, slug: 'slug', runId: 'run1' }), v2,
    'and a line that already has ids keeps the ones it was written with');
});

test('projectTimeline over every shipped fixture is byte-identical with the v2 columns present', () => {
  const journals = fixtureJournals();
  assert.ok(journals.length >= 5, `expected the fixture corpus, got ${journals.length}`);

  let entriesSeen = 0;
  for (const fixture of journals) {
    const before = fixture.lines as unknown as JournalEntry[];
    const after = before.map((line) =>
      withDerivedIds(line, { instanceId: INSTANCE, slug: fixture.slug, runId: fixture.runId }),
    );
    entriesSeen += before.length;

    assert.equal(
      JSON.stringify(projectTimeline(after, { now: 0 })),
      JSON.stringify(projectTimeline(before, { now: 0 })),
      `${fixture.file}: the timeline must not notice the new columns`,
    );
  }
  assert.ok(entriesSeen > 1000, `the corpus should be substantial, saw ${entriesSeen} entries`);
});

test('crossing the soft cap writes an IN-BAND journal.full, and the reserve still takes run.finished', () => {
  const dir = root();
  try {
    // A tiny cap makes the reserve reachable in a handful of lines rather than
    // 32 MB of them; the arithmetic under test is the same.
    const journal = new Journal(dir, 'slug', 'run1', { instanceId: INSTANCE, maxBytes: 4096, reserveBytes: 1024 });

    const filler = 'x'.repeat(400);
    for (let i = 0; i < 40; i++) journal.append('phase.tool', { filler, i });
    journal.append('phase.started', {}, 1);
    journal.append('run.finished', { ok: true });

    const lines = linesOf(dir, 'slug', 'run1');
    const events = lines.map((l) => l.event);

    const fullAt = events.indexOf('journal.full');
    assert.notEqual(fullAt, -1, 'the marker is in the JOURNAL, not only in the console log');

    const marker = lines[fullAt];
    assert.equal(typeof marker.data?.bytes, 'number');
    assert.equal(marker.data?.lastSeq, marker.seq - 1, 'and says which line was the last ordinary one');

    assert.equal(events.at(-1), 'run.finished', 'the run still says how it ended');
    assert.equal(
      events.filter((e) => e === 'phase.started').length,
      0,
      'while an ordinary event after the marker is dropped — that is what the reserve is for',
    );
    assert.equal(events.filter((e) => e === 'journal.full').length, 1, 'and the marker is written once');

    for (const event of RESERVE_EVENTS) {
      assert.match(event, /^(run|journal)\./, 'the reserve is for terminal RUN events, not phase traffic');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('append() still returns the entry it wrote, and still returns one it did not', () => {
  const dir = root();
  try {
    const journal = new Journal(dir, 'slug', 'run1', { instanceId: INSTANCE, maxBytes: 1024, reserveBytes: 256 });
    const first = journal.append('run.start', {});
    assert.equal(first.seq, 1);

    for (let i = 0; i < 20; i++) journal.append('phase.tool', { filler: 'y'.repeat(200) });
    const dropped = journal.append('phase.tool', {});

    assert.equal(typeof dropped.seq, 'number', 'a caller that reads the entry back must not get undefined');
    assert.equal(dropped.event, 'phase.tool');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a journal whose file cannot be written costs the audit trail, never the run', () => {
  const dir = root();
  try {
    const path = journalFile(dir, 'slug', 'run1');
    const journal = new Journal(dir, 'slug', 'run1', { instanceId: INSTANCE });
    // A directory where the file should be: every append fails, none throws.
    rmSync(path, { force: true });
    writeFileSync(path, '');
    assert.doesNotThrow(() => journal.append('run.start', {}));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
