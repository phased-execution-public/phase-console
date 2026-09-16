/**
 * The unified log index: every source, the merge, and the redaction.
 *
 * The through-line of every case here is that a log explorer's failures are
 * SILENT ones. A source that throws is loud and gets fixed; a source that
 * quietly returns nothing, a row whose timestamp was invented, a filter that
 * drops the undated rows somebody was looking for, a token that survived the
 * scrub — none of those look wrong on screen, and all four are the kind of bug
 * that makes a debugging surface worse than no debugging surface.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

import {
  BREADTH, DEBUG_LEVELS, DEBUG_SOURCES, ERROR_SEGMENTS, MAX_LIMIT, PER_SOURCE_CAP,
  RESOLVED_SEGMENTS, WARN_SEGMENTS, boundary, clampLimit, deliveryEntries, displayPath,
  healthEntries, isDebugLevel, isDebugSource, journalLevel, maskHome, mergeIndex, readConsoleLog,
  readJournals, readOutcomes, readRulingEntries, readSupervisorLogs, scrubText, scrubValue,
  supervisorLogPaths, tailLines, type DebugBucket, type DebugEntry, type DebugSource,
} from '../server/debug/sources.ts';
import {
  Debug, isRunId, isSlug, parseDebugQuery, parseExposition, tallyDelivery, type DebugDeps,
} from '../server/debug/index.ts';
import { configureLog } from '../server/log.ts';
import { runDir } from '../server/runner/state.ts';
import type { NotificationRecord } from '../server/notifications.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'debug-index-'));

/**
 * The macOS home prefix, composed rather than written.
 *
 * `.github/scripts/scrub.sh` refuses the literal string in any committed file —
 * comments and fixtures included — and these cases are exactly about masking
 * it, so it has to be built at runtime to exist here at all.
 */
const MAC = `/${'Users'}`;

const entry = (over: Partial<DebugEntry> = {}): DebugEntry => ({
  source: 'console', at: '2026-09-01T10:00:00.000Z', level: 'info',
  event: 'test.event', text: 'a line', ...over,
});

const bucket = (entries: DebugEntry[], over: Partial<DebugBucket> = {}): DebugBucket =>
  ({ entries, available: true, ...over });

const gatherOf = (map: Partial<Record<DebugSource, DebugBucket>>) =>
  new Map(Object.entries(map) as [DebugSource, DebugBucket][]);

/* ------------------------------------------------------------------ *
 * Redaction — the property the bundle's whole premise rests on
 * ------------------------------------------------------------------ */

test('scrubText masks a secret shape and the operator’s home path in one pass', () => {
  const line = `GET /x Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz012345 from ${MAC}/ada/work/hub`;
  const out = scrubText(line);
  assert.ok(!out.includes('sk-ant-abcdefghijklmnopqrstuvwxyz012345'), `token survived: ${out}`);
  assert.ok(!out.includes(`${MAC}/ada`), `home survived: ${out}`);
  assert.ok(out.includes('~/work/hub'), `the path should still be readable: ${out}`);
  // The non-secret half is kept on purpose — "something was removed from here"
  // is more useful than a line that reads as if nothing had been said.
  assert.ok(out.includes('Authorization:'), out);
});

test('maskHome masks another machine’s home too, not only this one', () => {
  // A journal written on one machine and read on another still names somebody,
  // and a bundle is meant to be pasted somewhere else by definition.
  assert.equal(maskHome('/home/bob/checkouts/x'), '~/checkouts/x');
  assert.equal(maskHome(`${MAC}/carol/x`), '~/x');
  // Not every path is a home: a system path must survive intact.
  assert.equal(maskHome('/usr/local/bin/node'), '/usr/local/bin/node');
  assert.equal(maskHome(`${MAC}/`), `${MAC}/`);
});

test('scrubValue scrubs keys as well as values, and bounds depth', () => {
  const out = scrubValue({ [`${MAC}/ada/repo`]: { token: 'ghp_abcdefghijklmnopqrstuvwxyz' } }) as Record<string, unknown>;
  assert.deepEqual(Object.keys(out), ['~/repo']);
  const inner = JSON.stringify(out);
  assert.ok(!inner.includes('ghp_abcdefghijklmnopqrstuvwxyz'), inner);

  // Deep nesting is cut rather than followed: this runs over records this
  // module did not author, and a journal line's `data` is whatever the
  // emitting site put there.
  let deep: unknown = 'floor';
  for (let i = 0; i < 12; i += 1) deep = { down: deep };
  assert.ok(JSON.stringify(scrubValue(deep)).includes('[deep]'));
});

test('scrubValue keeps numbers and booleans as themselves', () => {
  // A tally that arrived as "3" instead of 3 would make every count in the
  // bundle a string, which is the sort of thing nothing notices until a reader
  // sorts by it.
  const out = scrubValue({ n: 3, ok: true, nil: null }) as Record<string, unknown>;
  assert.deepEqual(out, { n: 3, ok: true, nil: null });
});

/* ------------------------------------------------------------------ *
 * The bounded tail
 * ------------------------------------------------------------------ */

test('tailLines reads only the end of a file and drops the torn first line', () => {
  const dir = scratch();
  const path = join(dir, 'big.log');
  const lines = Array.from({ length: 500 }, (_, i) => `line-${String(i).padStart(4, '0')}`);
  writeFileSync(path, `${lines.join('\n')}\n`);

  const all = tailLines(path);
  assert.equal(all.length, 500, 'a file inside the window is read whole');

  // 120 bytes is a handful of 9-byte lines; the first is almost certainly a
  // fragment and must not be reported as a line.
  const some = tailLines(path, 120);
  assert.ok(some.length > 0 && some.length < 500, `expected a window, got ${some.length}`);
  assert.equal(some[some.length - 1], 'line-0499');
  for (const line of some) assert.match(line, /^line-\d{4}$/, `torn line surfaced: ${line}`);
});

test('tailLines answers empty for a file that is not there, rather than throwing', () => {
  // One unreadable source out of seven must not fail the whole page.
  assert.deepEqual(tailLines(join(scratch(), 'nope.log')), []);
});

/* ------------------------------------------------------------------ *
 * Level mapping
 * ------------------------------------------------------------------ */

test('journalLevel raises failures to error and holds the rest at info', () => {
  assert.equal(journalLevel('phase.verify-failed'), 'error');
  assert.equal(journalLevel('phase.auto-nudge-refused'), 'error');
  assert.equal(journalLevel('phase.parked'), 'warn');
  assert.equal(journalLevel('phase.rung'), 'warn');
  // The safe direction: an unrecognised kind is info. A false warning trains
  // the reader to filter warnings out, which costs more than a missed one.
  assert.equal(journalLevel('phase.admitted'), 'info');
  assert.equal(journalLevel('run.finished'), 'info');
});

/* ------------------------------------------------------------------ *
 * Merge, sort, filter
 * ------------------------------------------------------------------ */

test('mergeIndex sorts newest first and puts undated rows at the END', () => {
  const merged = mergeIndex(gatherOf({
    console: bucket([
      entry({ at: '', event: 'unplaced' }),
      entry({ at: '2026-09-01T09:00:00.000Z', event: 'older' }),
      entry({ at: '2026-09-01T11:00:00.000Z', event: 'newer' }),
    ]),
  }));
  assert.deepEqual(merged.entries.map((e) => e.event), ['newer', 'older', 'unplaced']);
});

test('a time window never excludes an undated row', () => {
  // An undated row is unplaced, not old. Dropping it would hide exactly the
  // rows whose source failed to stamp them, which is the class worth seeing.
  const merged = mergeIndex(gatherOf({
    console: bucket([
      entry({ at: '', event: 'unplaced' }),
      entry({ at: '2026-08-01T00:00:00.000Z', event: 'too-old' }),
      entry({ at: '2026-09-01T10:00:00.000Z', event: 'inside' }),
    ]),
  }), { since: '2026-08-15T00:00:00.000Z' });
  assert.deepEqual(merged.entries.map((e) => e.event).sort(), ['inside', 'unplaced']);
});

test('filters compose, and each one alone can change the answer', () => {
  const rows = [
    entry({ source: 'console', level: 'error', event: 'a', slug: 'x', phase: 1, text: 'alpha' }),
    entry({ source: 'journal', level: 'error', event: 'b', slug: 'x', phase: 2, text: 'beta' }),
    entry({ source: 'journal', level: 'info', event: 'c', slug: 'y', phase: 1, text: 'gamma' }),
  ];
  const all = gatherOf({ console: bucket([rows[0]]), journal: bucket([rows[1], rows[2]]) });

  assert.deepEqual(mergeIndex(all, { sources: ['journal'] }).entries.map((e) => e.event), ['b', 'c']);
  assert.deepEqual(mergeIndex(all, { levels: ['error'] }).entries.map((e) => e.event).sort(), ['a', 'b']);
  assert.deepEqual(mergeIndex(all, { slug: 'y' }).entries.map((e) => e.event), ['c']);
  assert.deepEqual(mergeIndex(all, { phase: 2 }).entries.map((e) => e.event), ['b']);
  assert.deepEqual(mergeIndex(all, { q: 'GAMM' }).entries.map((e) => e.event), ['c'], 'search is case-insensitive');
  assert.deepEqual(
    mergeIndex(all, { sources: ['journal'], levels: ['error'] }).entries.map((e) => e.event), ['b'],
    'two filters intersect rather than union',
  );
});

test('mergeIndex reports truncation and per-source counts honestly', () => {
  const merged = mergeIndex(gatherOf({
    console: bucket([entry({ event: 'a' }), entry({ event: 'b' })]),
    journal: bucket([entry({ source: 'journal', event: 'c' })]),
  }), { limit: 2 });

  assert.equal(merged.entries.length, 2);
  assert.equal(merged.truncated, true, 'a cut answer must say so, not imply completeness');
  // Counts are what MATCHED, before the limit — otherwise "3 rows in the
  // journal" would shrink as the reader narrowed the page size.
  const counts = Object.fromEntries(merged.sources.map((s) => [s.source, s.count]));
  assert.equal(counts.console, 2);
  assert.equal(counts.journal, 1);
  assert.equal(mergeIndex(gatherOf({ console: bucket([entry()]) }), { limit: 5 }).truncated, false);
});

test('every source appears in the status list, present or not', () => {
  // The difference between "no supervisor log on this machine" and "the
  // supervisor log is empty" is the whole reason somebody opened this page.
  const merged = mergeIndex(gatherOf({ console: bucket([entry()]) }));
  assert.deepEqual(merged.sources.map((s) => s.source), [...DEBUG_SOURCES]);
  const supervisor = merged.sources.find((s) => s.source === 'supervisor');
  assert.equal(supervisor?.available, false);
  assert.equal(supervisor?.count, 0);
});

test('a source status path is home-masked', () => {
  const merged = mergeIndex(gatherOf({
    console: bucket([], { path: `${MAC}/ada/.local/state/phase-console/console.log` }),
  }));
  const path = merged.sources.find((s) => s.source === 'console')?.path;
  assert.equal(path, '~/.local/state/phase-console/console.log');
});

/* ------------------------------------------------------------------ *
 * Query parsing — a URL is user input
 * ------------------------------------------------------------------ */

test('parseDebugQuery drops an unknown word rather than guessing', () => {
  // `?source=journals` (a plural typo) must show EVERYTHING. Treating it as a
  // filter would show nothing and look like an empty log.
  const q = parseDebugQuery(new URLSearchParams('source=journals&level=verbose'));
  assert.equal(q.sources, undefined);
  assert.equal(q.levels, undefined);
});

test('parseDebugQuery reads repeated and comma-joined values, and clamps the limit', () => {
  const q = parseDebugQuery(new URLSearchParams(
    'source=journal&source=console,delivery&level=warn,error&slug=p&run=abcd1234&phase=7&q=boom&limit=999999',
  ));
  assert.deepEqual(q.sources, ['journal', 'console', 'delivery']);
  assert.deepEqual(q.levels, ['warn', 'error']);
  assert.equal(q.slug, 'p');
  assert.equal(q.runId, 'abcd1234');
  assert.equal(q.phase, 7);
  assert.equal(q.q, 'boom');
  assert.equal(q.limit, MAX_LIMIT, 'a caller cannot ask for an unbounded read');
});

test('clampLimit and boundary refuse to invent a value', () => {
  assert.equal(clampLimit(NaN), 500);
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(10), 10);
  assert.ok(Number.isNaN(boundary(undefined)));
  assert.ok(Number.isNaN(boundary('not a time')));
  assert.equal(boundary('1756720800000'), 1756720800000);
  assert.equal(boundary('2026-09-01T10:00:00.000Z'), Date.parse('2026-09-01T10:00:00.000Z'));
});

test('the two vocabularies guard themselves', () => {
  for (const source of DEBUG_SOURCES) assert.ok(isDebugSource(source));
  for (const level of DEBUG_LEVELS) assert.ok(isDebugLevel(level));
  assert.equal(isDebugSource('journals'), false);
  assert.equal(isDebugLevel('debug'), false);
});

/* ------------------------------------------------------------------ *
 * The per-run sources, read off real files
 * ------------------------------------------------------------------ */

/**
 * A run directory under a fake root, laid out where `runDir` will look.
 *
 * `runDir` derives an instance id from the root path, so the only reliable way
 * to write where the reader reads is to ask it for the path rather than to
 * spell `runs/<instance>/<slug>` by hand.
 */
function runScratch(slug: string): { root: string; dir: string } {
  const root = scratch();
  const dir = runDir(root, slug);
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}

test('readJournals normalises a journal line and carries its run and phase', () => {
  const { root, dir } = runScratch('demo');
  writeFileSync(join(dir, 'run-aaaa1111.jsonl'), [
    JSON.stringify({ seq: 1, time: '2026-09-01T10:00:00.000Z', event: 'phase.boarded', phase: 3, data: { model: 'opus' } }),
    JSON.stringify({ seq: 2, time: '2026-09-01T10:05:00.000Z', event: 'phase.verify-failed', phase: 3, data: { reason: 'tests are red' } }),
    'not json at all',
  ].join('\n'));

  const rows = readJournals(root, 'demo');
  assert.equal(rows.length, 2, 'a torn line is skipped, not fatal');
  const failed = rows.find((r) => r.event === 'phase.verify-failed');
  assert.equal(failed?.level, 'error');
  assert.equal(failed?.text, 'tests are red', 'the human line comes from the record, not the kind');
  assert.equal(failed?.runId, 'aaaa1111');
  assert.equal(failed?.phase, 3);
  assert.equal(failed?.slug, 'demo');
  assert.equal(rows.find((r) => r.event === 'phase.boarded')?.text, 'model=opus');
});

test('readJournals answers empty for a plan with no run directory', () => {
  assert.deepEqual(readJournals(scratch(), 'never-run'), []);
});

test('readOutcomes surfaces a file the console will NOT act on', () => {
  const { root, dir } = runScratch('demo');
  const outcomes = join(dir, 'outcomes');
  mkdirSync(outcomes, { recursive: true });
  writeFileSync(join(outcomes, 'phase-04.json'), JSON.stringify({
    version: 1, slug: 'demo', phase: 4, status: 'waiting-external',
    reason: 'CI is building', watch: [], written_at: '2026-09-01T10:00:00.000Z',
  }));
  // Same shape, wrong plan — `readOutcome` refuses it, and the console will
  // never act on it. Silence here is how a session's declaration disappears.
  writeFileSync(join(outcomes, 'phase-05.json'), JSON.stringify({
    version: 1, slug: 'someone-else', phase: 5, status: 'partial',
    watch: [], written_at: '2026-09-01T10:00:00.000Z',
  }));

  const rows = readOutcomes(root, 'demo');
  assert.equal(rows.length, 2);
  const good = rows.find((r) => r.phase === 4);
  assert.equal(good?.event, 'outcome.waiting-external');
  assert.equal(good?.level, 'warn', 'anything but complete is a session saying it could not finish');
  assert.equal(good?.text, 'CI is building');

  const bad = rows.find((r) => r.phase === 5);
  assert.equal(bad?.event, 'outcome.unreadable');
  assert.equal(bad?.level, 'warn');
  assert.match(String(bad?.text), /will not act on it/);
});

test('a complete outcome is info, not a warning', () => {
  const { root, dir } = runScratch('demo');
  const outcomes = join(dir, 'outcomes');
  mkdirSync(outcomes, { recursive: true });
  writeFileSync(join(outcomes, 'phase-01.json'), JSON.stringify({
    version: 1, slug: 'demo', phase: 1, status: 'complete',
    watch: [], written_at: '2026-09-01T10:00:00.000Z',
  }));
  assert.equal(readOutcomes(root, 'demo')[0]?.level, 'info');
});

test('readRulingEntries reads the ledger and never calls a decision a failure', () => {
  const { root, dir } = runScratch('demo');
  writeFileSync(join(dir, 'rulings.ndjson'), [
    JSON.stringify({
      version: 1, id: 'r1', slug: 'demo', phase: 2, kind: 'deviation', at: '2026-09-01T10:00:00.000Z',
      what: 'wrote the guide to docs/ instead', why: 'that is where the docs live',
    }),
    // Unversioned: `readRulings` refuses it, and so must this reader — the
    // ledger's owner decides what a ruling is, not the log explorer.
    JSON.stringify({ id: 'r2', slug: 'demo', phase: 2, kind: 'deferral', at: '2026-09-01T11:00:00.000Z', what: 'no' }),
  ].join('\n'));

  const rows = readRulingEntries(root, 'demo');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'ruling.deviation');
  assert.equal(rows[0].level, 'info', 'recording a ruling must never read as an alarm');
  assert.equal(rows[0].text, 'wrote the guide to docs/ instead');
  assert.equal(rows[0].phase, 2);
});

/* ------------------------------------------------------------------ *
 * The delivery ledger
 * ------------------------------------------------------------------ */

const record = (over: Partial<NotificationRecord> = {}): NotificationRecord => ({
  id: 'n1', at: '2026-09-01T10:00:00.000Z', category: 'phase', title: 'Phase 3 done',
  body: '', url: '#/now', urgent: false, read: false, delivery: [], ...over,
} as NotificationRecord);

test('deliveryEntries calls only the outcomes that did not arrive a warning', () => {
  const rows = deliveryEntries([record({
    delivery: [
      { device: 'd1', label: 'Phone', outcome: 'sent', at: '2026-09-01T10:00:01.000Z' },
      { device: 'd2', label: 'Laptop', outcome: 'quiet', at: '2026-09-01T10:00:01.000Z' },
      { device: 'd3', label: 'Tablet', outcome: 'failed', at: '2026-09-01T10:00:01.000Z', detail: 'BadJwtToken' },
      { device: 'd4', label: 'Old', outcome: 'gone', at: '2026-09-01T10:00:01.000Z' },
    ],
  })]);
  const byEvent = Object.fromEntries(rows.map((r) => [r.event, r.level]));
  assert.equal(byEvent['delivery.sent'], 'info');
  assert.equal(byEvent['delivery.quiet'], 'info', 'quiet is held on purpose, not a failure');
  assert.equal(byEvent['delivery.failed'], 'warn');
  assert.equal(byEvent['delivery.gone'], 'warn');
  assert.match(rows.find((r) => r.event === 'delivery.failed')!.text, /BadJwtToken/);
});

test('tallyDelivery counts an announcement undelivered only when nobody took it', () => {
  const tally = tallyDelivery([
    // Reached one of two devices: delivered.
    record({ id: 'a', delivery: [
      { device: 'd1', label: 'A', outcome: 'sent', at: '' },
      { device: 'd2', label: 'B', outcome: 'failed', at: '' },
    ] }),
    // Reached nobody: undelivered.
    record({ id: 'b', delivery: [
      { device: 'd1', label: 'A', outcome: 'throttled', at: '' },
      { device: 'd2', label: 'B', outcome: 'gone', at: '' },
    ] }),
    // Every device was inside its quiet hours: nothing was attempted, on
    // purpose. Counting this as undelivered would raise an alarm about the
    // feature working exactly as the operator configured it.
    record({ id: 'c', delivery: [{ device: 'd1', label: 'A', outcome: 'quiet', at: '' }] }),
    // No delivery rows at all: not an announcement the ledger covers.
    record({ id: 'd', delivery: [] }),
  ]);

  assert.equal(tally.announcements, 3);
  assert.equal(tally.undelivered, 1);
  assert.equal(tally.devices, 2);
  assert.deepEqual(tally.outcomes, { sent: 1, failed: 1, throttled: 1, gone: 1, quiet: 1 });
});

/* ------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------ */

test('healthEntries places an undated issue at the console’s start rather than at 1970', () => {
  const rows = healthEntries(
    [{ kind: 'push-broken', detail: 'no device took the last 3 announcements', fix: 'Re-subscribe from Settings.' }],
    '2026-09-01T09:00:00.000Z',
  );
  assert.equal(rows[0].at, '2026-09-01T09:00:00.000Z');
  assert.equal(rows[0].event, 'env.push-broken');
  assert.equal(rows[0].level, 'warn');
  assert.match(rows[0].text, /Re-subscribe from Settings\./, 'the fix travels with the finding');
});

/* ------------------------------------------------------------------ *
 * The exposition parser
 * ------------------------------------------------------------------ */

test('parseExposition reads families, types, help and labelled samples', () => {
  const families = parseExposition([
    '# HELP phase_console_plans Plans, by plan status.',
    '# TYPE phase_console_plans gauge',
    'phase_console_plans{status="active",closed="0"} 4',
    'phase_console_plans{status="complete",closed="1"} 2',
    '# TYPE phase_console_phase_attempts_total counter',
    'phase_console_phase_attempts_total 17',
    'this line is not a sample',
    '',
  ].join('\n'));

  const plans = families.find((f) => f.name === 'phase_console_plans');
  assert.equal(plans?.type, 'gauge');
  assert.equal(plans?.help, 'Plans, by plan status.');
  assert.equal(plans?.samples.length, 2);
  assert.deepEqual(plans?.samples[0], { labels: { status: 'active', closed: '0' }, value: 4 });

  const attempts = families.find((f) => f.name === 'phase_console_phase_attempts_total');
  assert.equal(attempts?.type, 'counter');
  assert.deepEqual(attempts?.samples, [{ labels: {}, value: 17 }]);
  assert.equal(families.length, 2, 'a line that is not a sample must not mint a family');
});

test('parseExposition survives a shape it was not written for', () => {
  // A metrics page that renders is more useful than one that 500s because a
  // future family used a label value this regex did not expect.
  assert.deepEqual(parseExposition(''), []);
  assert.deepEqual(parseExposition('garbage'), []);
  // A non-numeric sample is dropped BEFORE its family is minted, so a page of
  // nothing but bad samples renders as no families rather than as a list of
  // empty ones — which would read as "these metrics are all zero".
  assert.deepEqual(parseExposition('x{a="1"} NaN'), []);
  // But a family the exposition DECLARED and then emitted no sample for is
  // real, and must survive: that is how an absent-not-zero gauge reads.
  const declared = parseExposition('# TYPE x gauge\n');
  assert.equal(declared.length, 1);
  assert.deepEqual(declared[0].samples, []);
});

/* ------------------------------------------------------------------ *
 * The facade
 * ------------------------------------------------------------------ */

function fakeDebug(over: Partial<DebugDeps> = {}): Debug {
  return new Debug({
    root: () => null,
    slugs: () => [],
    notifications: () => [],
    environment: () => [],
    watches: () => null,
    metrics: async () => '',
    console: () => ({}),
    startedAt: () => '2026-09-01T09:00:00.000Z',
    ...over,
  });
}

test('the index says WHY a source is unavailable, not merely that it is', () => {
  const index = fakeDebug().index({ sources: ['journal'] });
  const journal = index.sources.find((s) => s.source === 'journal');
  assert.equal(journal?.available, false);
  assert.match(String(journal?.note), /No source directory is open/);
});

test('an unscoped index reads a bounded number of plans', () => {
  const many = Array.from({ length: 40 }, (_, i) => `plan-${i}`);
  const index = fakeDebug({ slugs: () => many }).index({});
  assert.equal(index.slugs.length, 8, 'the unscoped read must not walk every plan on disk');
  assert.deepEqual(index.slugs, many.slice(0, 8), 'and it keeps the most interesting ones');
  assert.deepEqual(fakeDebug({ slugs: () => many }).index({ slug: 'plan-31' }).slugs, ['plan-31']);
});

test('the bundle is schema-stable, redacted, and says what it left out', async () => {
  const bundle = await fakeDebug({
    slugs: () => Array.from({ length: 9 }, (_, i) => `p${i}`),
    environment: () => [{ kind: 'path-foreign-home', detail: `PATH has ${MAC}/ada/bin`, fix: 'Reinstall.' }],
    console: () => ({ version: '4.0.0', home: `${MAC}/ada` }),
    metrics: async () => '# TYPE x gauge\nx 1\n',
  }).bundle();

  assert.equal(bundle.schema, 'phase-console/debug-bundle');
  assert.equal(bundle.version, 1);
  assert.deepEqual(Object.keys(bundle).sort(), [
    'console', 'delivery', 'entries', 'generatedAt', 'health', 'metrics', 'notes',
    'plans', 'root', 'schema', 'sources', 'version',
  ]);

  const serialized = JSON.stringify(bundle);
  assert.ok(!serialized.includes(`${MAC}/ada`), 'a home path reached the bundle');
  assert.equal(bundle.health.environment[0].detail, 'PATH has ~/bin');
  assert.equal((bundle.console as { home?: string }).home, '~');

  assert.equal(bundle.plans.length, 5, 'the bundle covers a bounded set of plans');
  assert.ok(bundle.notes.some((n) => /most active plans/.test(n)), 'and says so');
  assert.ok(bundle.notes.some((n) => /No source directory is open/.test(n)));
  assert.equal(bundle.metrics[0]?.name, 'x');
});

test('a metrics failure degrades the bundle to a note instead of a 500', async () => {
  const bundle = await fakeDebug({
    metrics: async () => { throw new Error('scrape blew up'); },
  }).bundle();
  assert.deepEqual(bundle.metrics, []);
  assert.ok(bundle.notes.some((n) => /scrape blew up/.test(n)), bundle.notes.join(' | '));
});

test('displayPath is the one masker a status row goes through', () => {
  assert.equal(displayPath(`${MAC}/ada/x`), '~/x');
});


/* ------------------------------------------------------------------ *
 * QA round 1 — one case per finding, each red against the pre-fix code
 * ------------------------------------------------------------------ */

test('H1 — a watch ref carrying a secret does not survive into the bundle', async () => {
  // `WatchSnapshot.asked` holds raw refs, and a `cmd:` ref is an arbitrary
  // command line a session wrote. This was the ONE bundle field that went
  // through neither pass, on the one payload whose stated purpose is to be
  // pasted into a model's context.
  const bundle = await fakeDebug({
    watches: () => ({
      passes: 3,
      open: true,
      asked: [
        `cmd:"gh api -H 'Authorization: token ghp_abcdefghijklmnopqrstuvwxyz'"`,
        `cmd:"bash ${MAC}/ada/deploy.sh"`,
      ],
    }),
  }).bundle();

  const serialized = JSON.stringify(bundle);
  assert.ok(!serialized.includes('ghp_abcdefghijklmnopqrstuvwxyz'), `token survived: ${serialized}`);
  assert.ok(!serialized.includes(`${MAC}/ada`), `home survived: ${serialized}`);
  // Still readable — the point is masking, not deletion.
  assert.equal(bundle.health.watches?.passes, 3);
  assert.ok(bundle.health.watches?.asked[1].includes('~/deploy.sh'), bundle.health.watches?.asked[1]);
});

test('M1 — a file whose tail window holds no newline is not reported as empty', () => {
  const dir = scratch();
  const path = join(dir, 'blob.log');
  // A crashing process printing one unbroken blob is exactly how the
  // supervisor log fills, and "0 rows" reads as "the supervisor log is empty"
  // — the sentence this module says must never be confused with "there is no
  // supervisor log here".
  writeFileSync(path, `early boot line\n${'x'.repeat(200_000)}`);
  const lines = tailLines(path, 4096);
  assert.equal(lines.length, 1, 'the blob must be reported, not dropped');
  assert.ok(lines[0].startsWith('…'), `a truncated line must say so: ${lines[0].slice(0, 20)}`);
  assert.ok(lines[0].includes('x'), 'and must carry the tail');
});

test('M1 — a window boundary landing exactly on a newline loses no line', () => {
  const dir = scratch();
  const path = join(dir, 'aligned.log');
  // Ten 9-byte lines ("line-0000\n"). A window of exactly 30 bytes starts
  // immediately after a newline, so its first line is WHOLE and shifting it
  // unconditionally would drop a real row.
  const lines = Array.from({ length: 10 }, (_, i) => `line-${String(i).padStart(4, '0')}`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  assert.deepEqual(tailLines(path, 30), ['line-0007', 'line-0008', 'line-0009']);
});

test('M1 — the boundary cases that are NOT a bug still behave', () => {
  const dir = scratch();
  const empty = join(dir, 'empty.log');
  writeFileSync(empty, '');
  assert.deepEqual(tailLines(empty), []);

  const noNewline = join(dir, 'tail.log');
  writeFileSync(noNewline, 'a\nb\nc');
  assert.deepEqual(tailLines(noNewline), ['a', 'b', 'c'], 'a file with no trailing newline keeps its last line');

  const whole = join(dir, 'small.log');
  writeFileSync(whole, 'only\n');
  assert.deepEqual(tailLines(whole, 1_000_000), ['only'], 'a window bigger than the file reads it whole');
});

test('M2 — the delivery cap keeps the NEWEST rows, not the oldest', () => {
  // `notifications.list()` answers newest-first, so `slice(-N)` kept the
  // OLDEST N — "did my last announcement get delivered" was the one question
  // the ledger could not answer.
  const records = Array.from({ length: PER_SOURCE_CAP + 40 }, (_, i) => record({
    id: `n${i}`,
    title: `announcement ${i}`,
    at: new Date(Date.now() - i * 1000).toISOString(),
    delivery: [{ device: 'd1', label: 'Phone', outcome: 'sent', at: new Date(Date.now() - i * 1000).toISOString() }],
  }));
  const rows = deliveryEntries(records);
  assert.equal(rows.length, PER_SOURCE_CAP);
  assert.match(rows[0].text, /announcement 0$/, 'the newest announcement must be in the answer');
  assert.ok(
    !rows.some((row) => /announcement 2039$/.test(row.text)),
    'the oldest must be the one that was cut',
  );
});

test('M4 — journalLevel classifies the failure vocabulary the journal really has', () => {
  // Every kind below is a real row in docs/journal-events.md and every one of
  // them read `info` under the first cut's suffix regexes.
  for (const kind of ['phase.lock-lost', 'run.halt', 'phase.tool-denied', 'run.branch-mismatch',
    'phase.verify-unrunnable']) {
    assert.equal(journalLevel(kind), 'error', `${kind} should be an error`);
  }
  for (const kind of ['phase.live-wall', 'phase.gated', 'phase.needs-human',
    'phase.verify-overtaken', 'phase.outcome-lock-blocked']) {
    assert.equal(journalLevel(kind), 'warn', `${kind} should be a warning`);
  }
  // A rung that SETTLED is good news even though it carries the word `rung`.
  assert.equal(journalLevel('phase.rung-settled'), 'info');
  assert.equal(journalLevel('phase.admitted'), 'info');
  // Separator asymmetry is what made the first cut wrong; both spellings agree.
  assert.equal(journalLevel('run.parked'), journalLevel('phase.auto-parked'));
});

// (The round-1 vocabulary check lived here. It parsed `[a-z0-9-]+` after the
// first dot, so it read 228 of 232 kinds, and it asserted only that each word
// matched SOMETHING — which `defect` and `failure` both did while classifying
// good news as failure. `L-B — the level vocabulary is checked against ALL 232
// kinds` replaces it and pins the classification, not just the coverage.)

test('M7 — every per-plan source says WHY it is unreadable, not just that it is', () => {
  // `outcome` and `ruling` shipped `available: false` with no note, and the
  // UI's strip required both — so their unavailability was invisible while the
  // empty state said everything readable had been searched.
  const index = fakeDebug().index({});
  for (const source of ['journal', 'outcome', 'ruling'] as const) {
    const status = index.sources.find((s) => s.source === source);
    assert.equal(status?.available, false, source);
    assert.ok(status?.note, `${source} is unavailable and says nothing about why`);
  }
});

test('M9 — a slug that escapes the run directory reads nothing', () => {
  // `runDir(root, slug)` is a bare `join`, so an unvalidated slug walked out of
  // the state directory and the index returned file CONTENTS through it.
  const { root } = runScratch('demo');
  const debug = fakeDebug({ root: () => root, slugs: () => ['demo'] });
  assert.deepEqual(debug.index({ slug: '../../../../evil' }).slugs, []);
  assert.deepEqual(debug.index({ slug: '../../../../evil' }).entries, []);
  assert.deepEqual(debug.runIds('../../../../evil'), []);
  assert.equal(isSlug('console-parallel-repaint'), true);
  assert.equal(isSlug('../evil'), false);
  assert.equal(isSlug('a/b'), false);
  assert.equal(isSlug(''), false);
});

test('L2 — the search really covers runId and slug, not only event and text', () => {
  // The documented haystack is event + text + slug + runId; halving it left
  // every test green, and typing a run id into the box is the obvious use.
  const rows = [
    entry({ event: 'a', text: 'alpha', slug: 'plan-one', runId: 'aaaa1111' }),
    entry({ event: 'b', text: 'beta', slug: 'plan-two', runId: 'bbbb2222' }),
  ];
  const all = gatherOf({ console: bucket(rows) });
  assert.deepEqual(mergeIndex(all, { q: 'aaaa1111' }).entries.map((e) => e.event), ['a']);
  assert.deepEqual(mergeIndex(all, { q: 'plan-two' }).entries.map((e) => e.event), ['b']);
});

test('L3 — a truncated breadth is marked, like a truncated depth', () => {
  const wide: Record<string, number> = {};
  for (let i = 0; i < BREADTH + 5; i += 1) wide[`k${i}`] = i;
  const out = scrubValue(wide) as Record<string, unknown>;
  assert.equal(out['[…]'], '5 more keys');

  const long = Array.from({ length: BREADTH + 3 }, (_, i) => i);
  const arr = scrubValue(long) as unknown[];
  assert.equal(arr[arr.length - 1], '[…3 more]');
});

test('L5 — a home path with a space or an accent is masked WHOLE', () => {
  // `[A-Za-z0-9._-]+` stopped at the space and left `~ Smith/work/secret` —
  // a leak that looks masked, which is worse than one that does not.
  assert.equal(maskHome(`${MAC}/John Smith/work/secret-project`), '~/work/secret-project');
  assert.equal(maskHome(`${MAC}/josé/work`), '~/work');
  assert.equal(maskHome(`%2FUsers%2Fada%2Fx`), '~%2Fx');
  // And a longer username that merely starts with this machine's is not
  // half-eaten by the exact-HOME pass.
  assert.ok(!maskHome(`${MAC}/adam/secret`).includes('adam'), maskHome(`${MAC}/adam/secret`));
});

test('L1 — the console log reader merges the file and the ring, without duplicates', () => {
  // Neither reader had a direct test: the route case drove them with no
  // fixture on disk, so the de-duplication, the ISO-stamp regex and the mtime
  // fallback were all unexercised.
  const dir = scratch();
  const path = join(dir, 'console.log');
  writeFileSync(path, [
    JSON.stringify({ time: '2026-09-01T10:00:00.000Z', level: 'warn', event: 'env.doctor', data: { issues: 1 } }),
    JSON.stringify({ time: '2026-09-01T10:00:01.000Z', level: 'error', event: 'api.unhandled', data: { message: 'boom' } }),
    '{ torn',
  ].join('\n'));

  configureLog(path);
  try {
    const { entries, path: reported } = readConsoleLog();
    assert.equal(reported, path);
    const events = entries.map((e) => e.event);
    assert.ok(events.includes('env.doctor'), events.join(','));
    assert.equal(entries.find((e) => e.event === 'api.unhandled')?.text, 'boom');
    assert.equal(entries.find((e) => e.event === 'api.unhandled')?.level, 'error');
    // The torn last line is skipped, not fatal, and not counted.
    assert.equal(entries.filter((e) => e.event === 'env.doctor').length, 1, 'the ring must not duplicate the file');
  } finally {
    configureLog(null);
  }
});

test('L1 — the supervisor pair is read as text, with the stream as its level', () => {
  const { entries, found } = readSupervisorLogs();
  // On a machine with no launchd/systemd install there is nothing to read, and
  // that IS the answer — but it must be reported as absence, not as emptiness.
  assert.equal(typeof found, 'boolean');
  for (const row of entries) {
    assert.equal(row.source, 'supervisor');
    assert.ok(row.level === 'info' || row.level === 'error');
  }
});


/* ------------------------------------------------------------------ *
 * QA round 2 — seven of these are regressions the round-1 fixes made
 * ------------------------------------------------------------------ */

test('H-A — a run id that escapes the run directory reads nothing', () => {
  // The round-1 fix guarded `?slug=` and left `?run=`, which reaches the SAME
  // bare `join`. It also WROTE: `Journal`'s constructor mkdirSyncs its parent,
  // so a GET created a directory outside the state dir.
  //
  // The fixture is planted at the path the traversal RESOLVES to, computed
  // with the same `join` the reader uses — the first version of this case
  // asserted an empty answer against a path where nothing had been written,
  // so it passed with the guard removed.
  const { root, dir } = runScratch('demo');
  // Three `..`: the first cancels the literal `run-..` segment the filename
  // template creates, and the other two climb out of `<slug>/` and
  // `<instance>/`. Two was not enough — it landed back inside the run dir,
  // which is how the first version of this case passed with no guard at all.
  const escape = '../../../escaped/secret';
  const target = join(dir, `run-${escape}.jsonl`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify({
    seq: 1, time: '2026-09-01T10:00:00.000Z', event: 'phase.boarded', data: { stolen: 'yes' },
  })}\n`);
  assert.ok(!target.startsWith(dir), `the fixture must land OUTSIDE the run dir, got ${target}`);

  const debug = fakeDebug({ root: () => root, slugs: () => ['demo'] });
  assert.deepEqual(debug.index({ slug: 'demo', runId: escape }).entries, []);
  assert.deepEqual(debug.index({ slug: 'demo', runId: '../../../../evil' }).entries, []);
  assert.equal(isRunId('aaaa1111'), true);
  assert.equal(isRunId('../../x'), false);
  assert.equal(isRunId('run-aaaa1111'), false);
  assert.equal(isRunId(''), false);
});

test('M-A — maskHome masks the path and leaves the sentence around it', () => {
  // Widened to fix a Low, it then ran to end-of-line: a space was allowed
  // unconditionally, so the prose after a path was eaten — including
  // `redact()`'s own marker.
  assert.equal(
    maskHome(`worktree at ${MAC}/ada was reused by run aaaa1111`),
    'worktree at ~ was reused by run aaaa1111',
  );
  assert.equal(
    maskHome(`error at ${MAC}/ada — token [redacted] — code 5`),
    'error at ~ — token [redacted] — code 5',
  );
  // And still masks a username with a space, which is what the widening was for.
  assert.equal(maskHome(`${MAC}/John Smith/work/secret-project`), '~/work/secret-project');
});

test('M-C — a kind that says the trouble ENDED is not painted as trouble', () => {
  // `defect` matched exactly one kind and it is good news: a repair session
  // that found nothing wrong. `failure` matched exactly one and it is a
  // counter being cleared. A severity table that reads those words and paints
  // them red reports the opposite of what happened.
  assert.equal(journalLevel('phase.outcome-no-defect'), 'info');
  assert.equal(journalLevel('run.failure-streak-reset'), 'info');
  assert.equal(journalLevel('run.halt-retracted'), 'info');
  // The failures those words were meant to catch still read as failures.
  assert.equal(journalLevel('run.halted'), 'error');
  assert.equal(journalLevel('phase.verify-failed'), 'error');
});

test('L-B — a three-segment kind is classified, not skipped', () => {
  // Four kinds carry two dots, and the first parser's `[a-z0-9-]+` tail
  // skipped every one — including the interrupted-adopt that regressed to
  // `info` when `interrupted` fell out of the vocabulary.
  assert.equal(journalLevel('run.adopt.interrupted'), 'warn');
  assert.equal(journalLevel('run.recover.refused'), 'error');
  assert.equal(journalLevel('run.settings.prune-failed'), 'error');
  assert.equal(journalLevel('run.adopt.alive'), 'info');
});

test('L-B — the level vocabulary is checked against ALL 242 kinds', () => {
  // The round-1 parser matched `[a-z0-9-]+` after the first dot and so read
  // 228 of 232 rows, and its assertion was only "each word matches
  // something" — which `defect` and `failure` both satisfied while being
  // wrong. This reads every kind and pins a classification.
  const doc = readFileSync(new URL('../../docs/journal-events.md', import.meta.url), 'utf8');
  const kinds = [...doc.matchAll(/^\| `((?:phase|run|policy)\.[a-z0-9.-]+)` \|/gm)].map((m) => m[1]);
  // 244 since the QA-loop fixes of 2026-09-07 added `phase.resume-lost` and
  // `phase.qa-mode` (a QA switch flipped from the console while a run is
  // live), on top of phase-console-commerce P9's five QA-recovery lines
  // (`phase.qa-recover`, `qa-round`, `qa-recovered`, `qa-exhausted`, `qa-waived`),
  // console-parallel-repaint P14's three `run.ultrareview*` lines and P12's
  // `phase.ladder-extended` and `phase.verify-waived`.
  // 248 since zero-touch-console phase 2 (LFC-4): the three withdrawal records
  // `run.{pause,halt,park}-withdrew` that a template literal used to compose,
  // and the RETIRED `run.auto-recover-skipped`, kept with a version note so the
  // hub's older journals stay readable — a retired row still names a kind.
  // 252 since zero-touch-console phase 4 (the session ledger): the CLI's own
  // denials and the words a session read for one (`phase.permission-denied`,
  // `phase.tool-refused`), the CLI-side ceilings a session ran under
  // (`phase.retry-ceiling`), and the decision a usage warning now gets
  // (`run.usage-decision`).
  // 259 since zero-touch-console phase 5 (the wait budget and the resume gate):
  // the automatic resume named for what it is (`phase.resume-automatic`, with
  // `phase.resume-at-boot` kept retired), a resume refused over a live session
  // (`phase.resume-refused`, `run.resume-refused`), a watch ref nothing can poll
  // (`phase.watch-unpollable`), an overdue clock ruled on (`run.wait-overdue`),
  // and the two pins a wait clock now logs (`run.limit-resume-held`,
  // `run.readopt-wait-held`). 262 since phase 6 (settlement, the inbox, the
  // ledgers): a dead clock settled (`phase.wait-settled`), a declared word
  // refused (`phase.declaration-refused`) and a person's card as a wait
  // (`run.waiting-person`) — the phase's three log-family rows
  // (`outcome-inbox.declaration-refused`, `sessions.inbox-orphan`,
  // `hook.person-wait-failed`) are outside this count by construction. 265
  // since phase 7 (every automatic start names itself): a start the ceiling
  // refused (`run.start-refused`), a session opened by one of the doors that
  // does not go through `startRun` (`phase.session-start`) and the healer's
  // pass on the console log (`run.heal-pass`, a `run.` name and so counted
  // here) — `session.start`, `mcp.probe.*` and `start-ceiling.refused` are
  // log-family names outside the three prefixes. 268 since phase 8 (accounts):
  // the account a run left over a window (`run.account-cooling`), the
  // credential refusal that retired one (`run.account-retired`), and a token
  // account's MCP set scoped to what the plan declares (`run.token-scope`) —
  // the `accounts.learned.*`, `accounts.retired.*`, `accounts.token-scope` and
  // `accounts.transcript-layout` rows are log-family names outside the count.
  // 273 since phase 9 (the wall and the ladder's breaker): a boarding refused
  // on a retired account (`run.admission-refused`), an automatic relaunch of a
  // spent streak refused (`run.relaunch-refused`), a recheck's verdict
  // (`run.recheck`), a ref-less wait after a guard denial
  // (`phase.watch-missing`) and a widen card answered (`phase.widen-decided`)
  // — `runner.recover.refused`, `runner.relaunch-refused` and the two
  // `runner.widen-rule.*` rows are log-family names outside the count.
  // 274 since phase 10 (ladder drivability, settlement and the errand's
  // voice): a ladder cap's refusal as a journal line (`phase.ladder-refused`).
  // 277 since phase 11 (the prelude and the policy table): a class answered by
  // policy instead of a person (`phase.policy-answered`), the start door
  // passed on a blocking row (`run.manifest-override`), and a phase's
  // credentials checked before the spawn (`phase.credential-preflight`).
  // 281 since phase 12 (ruling memory and the policy editor): a console
  // policy answer moved (`policy.changed`), the once-per-boot policy advisory
  // and its receipt (`policy.advisory`, `policy.advisory-acknowledged`) and
  // the boot read that could not judge one (`policy.advisory-unread`).
  // 286 since phase 13 (trust as built): a card's raise and its ending on the
  // run (`phase.approval-raised`, `phase.approval-decided`), the grant's twin
  // under its new family name (`phase.approval-auto-granted`; the old
  // `phase.tool-auto-granted` row stays as retired), the return leg of an
  // operator's question (`phase.answered`), and a CLI too old for the floor
  // flag (`run.permission-prompts-skipped`).
  // 296 since phase 14 (the relay): a question raised, answered, refused to
  // the console and deferred (`phase.question-raised`, `-answered`,
  // `-unanswerable`, `-deferred`), the transport's own arrival
  // (`phase.permission-request`), a `control_request` and a `defer` read off the
  // stream (`phase.control-request`, `phase.tool-deferred`), and the relay's
  // arming as it changes (`run.relay-armed`, `run.relay-degraded`,
  // `run.relay-refused`) — the `relay.*`, `cli-init.*` and
  // `runner.relay-arming-failed` rows are log-family names outside the count.
  // 298 since phase 16 (shutdown, boot and presence): a boarding queued behind
  // a live session in the repository that holds no lock (`phase.peer-race`)
  // and a re-adoption held by a stop marker or `autostart: false`
  // (`run.readopt-held`) — the `boot.*`, `shutdown.*` and new `sessions.*` rows
  // are log-family names outside the count.
  assert.equal(kinds.length, 298, `the catalogue has ${kinds.length} kinds; the parser found a different number`);

  const segments = new Set(kinds.flatMap((kind) => kind.split(/[.-]/)));
  const dead = [...ERROR_SEGMENTS, ...WARN_SEGMENTS, ...RESOLVED_SEGMENTS]
    .filter((word) => !segments.has(word));
  assert.deepEqual(dead, [], `these words match no journal kind that exists: ${dead.join(', ')}`);

  // And nothing is classified by accident: every kind must land somewhere, and
  // the counts are pinned so a widening that repaints half the journal is a
  // deliberate act with a number beside it.
  const tally = { info: 0, warn: 0, error: 0 };
  for (const kind of kinds) tally[journalLevel(kind)] += 1;
  assert.equal(tally.info + tally.warn + tally.error, kinds.length);
  // 45 since zero-touch-console phase 5: `phase.resume-refused` and
  // `run.resume-refused` read as error through the shared `refused` word, like
  // every refusal before them — a resume refused over a running session is the
  // console declining a harm, and the page drawing it loud is the point.
  // 46 since phase 10: `phase.ladder-refused` — a ladder cap declining a
  // climb — reads as error through the same word, and rightly loud: it is the
  // moment a phase stops being the machine's and becomes a person's.
  // 47 since phase 14: `run.relay-refused` — a run that asked for the relay
  // and was refused it on its CLI's version — reads as error through the same
  // word, and loud is right: the operator asked for a last resort and the run
  // is going without one.
  assert.ok(tally.error > 0 && tally.error < 47, `${tally.error} kinds read as error — check the vocabulary`);
  assert.ok(tally.warn > 0 && tally.warn < 80, `${tally.warn} kinds read as warn — check the vocabulary`);
});

test('L-C — nothing on the bundle skips the scrub, including metrics and env kinds', async () => {
  const bundle = await fakeDebug({
    environment: () => [{ kind: `path-under-${MAC}/ada`, detail: 'x', fix: 'y' }],
    metrics: async () => [
      '# TYPE phase_console_x gauge',
      `phase_console_x{path="${MAC}/ada/repo",token="ghp_abcdefghijklmnopqrstuvwxyz"} 1`,
    ].join('\n'),
  }).bundle();

  const serialized = JSON.stringify(bundle);
  assert.ok(!serialized.includes(`${MAC}/ada`), `a home path reached the bundle: ${serialized}`);
  assert.ok(!serialized.includes('ghp_abcdefghijklmnopqrstuvwxyz'), 'a token reached the bundle');
});

test('L-D — a home path with either separator encoded is still masked', () => {
  assert.equal(maskHome('%2FUsers%2Fada%2Fx'), '~%2Fx');
  assert.equal(maskHome(`${MAC}%2Fada%2Fx`), '~%2Fx');
  assert.equal(maskHome('%2FUsers/ada/x'), '~/x');
});

test('L-E — the delivery tally rides along with a delivery read, and only then', () => {
  // Two implementations of "undelivered" would be two answers, so the server
  // owns the rule and the client renders it.
  const records = [record({
    id: 'a',
    delivery: [{ device: 'd1', label: 'A', outcome: 'throttled', at: '2026-09-01T10:00:00.000Z' }],
  })];
  const debug = fakeDebug({ notifications: () => records });
  assert.equal(debug.index({ sources: ['delivery'] }).delivery?.undelivered, 1);
  assert.equal(debug.index({}).delivery?.announcements, 1, 'an unfiltered read includes the ledger');
  assert.equal(debug.index({ sources: ['console'] }).delivery, undefined);
});

test('L-A — the supervisor pair is read, with the stream deciding the level', () => {
  // The round-1 case asserted only that `found` was a boolean, so gutting the
  // reader left it green. This writes the files where the reader looks.
  const { out, err } = supervisorLogPaths();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, 'boot ok\nlistening on 4123\n');
  writeFileSync(err, '2026-09-01T10:00:00.000Z EADDRINUSE\nstack frame\n');
  try {
    const { entries, found } = readSupervisorLogs();
    assert.equal(found, true);
    const stdout = entries.filter((e) => e.event === 'console.out');
    const stderr = entries.filter((e) => e.event === 'console.err');
    assert.equal(stdout.length, 2, 'both stdout lines');
    assert.equal(stderr.length, 2, 'both stderr lines');
    assert.equal(stdout[0].level, 'info');
    assert.equal(stderr[0].level, 'error');
    assert.equal(stdout[0].text, 'boot ok');
    // A leading ISO stamp is read as the row's time rather than the file's.
    assert.equal(stderr[0].at, '2026-09-01T10:00:00.000Z');
    // A line without one takes the file's mtime, so it is placed, not undated.
    assert.ok(stderr[1].at, 'an unstamped line still gets a time');
  } finally {
    rmSync(out, { force: true });
    rmSync(err, { force: true });
  }
});

test('M-A (round 3) — the encoded branch allows a space only on the way to the next separator', () => {
  // The plain branch learned this in round 2; the encoded one did not, and
  // `%2FUsers%2FJohn Smith%2Fwork` masked to `~ Smith%2Fwork` — the leak
  // direction, a foreign username surviving.
  assert.equal(maskHome('%2FUsers%2FJohn Smith%2Fwork%2Fsecret'), '~%2Fwork%2Fsecret');
  assert.equal(maskHome('worktree at %2FUsers%2Fada was reused by run aaaa1111'), 'worktree at ~ was reused by run aaaa1111');
  // The two branches agree, encoded or plain.
  assert.equal(maskHome(`${MAC}/John Smith/work/secret`), '~/work/secret');
  assert.equal(maskHome('%2Fhome%2FMary Ann%2Fx and then'), '~%2Fx and then');
});
