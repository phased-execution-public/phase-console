/**
 * The outcome protocol's reader — the session→runner channel, guarded twice.
 *
 * `readOutcome` had no test of its own, which is how its staleness guard came
 * to compare a bash timestamp against a JavaScript one as STRINGS. Everything
 * here is about the two guards: does this file belong to this run and phase,
 * and was it written by THIS attempt rather than the one before it.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { consumeOutcome, ignoreOutcome, peekWrittenAt, readOutcome, OUTCOME_IGNORE_REASONS } = await import('../server/runner/outcome.ts');

function outcomeFile(over: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'pc-outcome-'));
  const path = join(dir, 'phase-04.json');
  writeFileSync(path, JSON.stringify({
    version: 1, slug: 'demo', phase: 4, status: 'complete',
    written_at: '2026-08-21T10:00:00Z', watch: [],
    ...over,
  }));
  return path;
}

test('readOutcome: the file has to be this run\'s, this phase\'s, and a status we know', () => {
  const expect = { slug: 'demo', phase: 4 };
  assert.equal(readOutcome(outcomeFile(), expect)?.status, 'complete');
  assert.equal(readOutcome(join(tmpdir(), 'pc-outcome-nope', 'missing.json'), expect), null, 'no file');
  assert.equal(readOutcome(outcomeFile({ version: 2 }), expect), null, 'a version we do not speak');
  assert.equal(readOutcome(outcomeFile({ slug: 'other' }), expect), null, 'another plan');
  assert.equal(readOutcome(outcomeFile({ phase: 5 }), expect), null, 'another phase');
  assert.equal(readOutcome(outcomeFile({ status: 'invented' }), expect), null, 'a status nobody defined');
  assert.equal(readOutcome(outcomeFile({ written_at: '' }), expect), null, 'no timestamp at all');

  const dir = mkdtempSync(join(tmpdir(), 'pc-outcome-junk-'));
  const junk = join(dir, 'x.json');
  writeFileSync(junk, 'not json{');
  assert.equal(readOutcome(junk, expect), null, 'not JSON');
  rmSync(dir, { recursive: true, force: true });
});

/**
 * xcut-11 — and the trap inside it.
 *
 * `phase-outcome.sh` writes `written_at` with `date -u +%Y-%m-%dT%H:%M:%SZ`,
 * whole seconds; `notBefore` is the attempt's `new Date().toISOString()`,
 * carrying milliseconds. The two were compared as STRINGS, which is not an
 * ordering at all once the formats differ — `…10:00:00Z` and `…10:00:00.500Z`
 * sort on `Z` against `.`.
 *
 * The obvious repair — `Date.parse` on both sides — is WRONG, and this test
 * exists mostly to stop someone making it. A session that declares in the same
 * second its attempt began (a closeout does exactly that) writes
 * `10:00:00Z` = 10:00:00.000 against a floor of 10:00:00.100, and naive
 * parsing calls that stale: the declaration is discarded, the runner reads
 * "the session declared nothing", and the phase halts instead of parking. The
 * floor is therefore truncated to whole seconds before the comparison — the
 * precision the writer actually has. The guard against a genuinely stale file
 * is the pre-spawn deletion (`armOutcomeFile`), which is the half that can be
 * exact; this half only has to avoid throwing away the truth.
 */
test('readOutcome: a declaration made in the attempt\'s own second is not stale (xcut-11)', () => {
  const expect = { slug: 'demo', phase: 4 };
  const sameSecond = { ...expect, notBefore: '2026-08-21T10:00:00.500Z' };
  assert.equal(
    readOutcome(outcomeFile({ written_at: '2026-08-21T10:00:00Z' }), sameSecond)?.status,
    'complete',
    'a whole-second bash timestamp inside the floor\'s own second is THIS attempt\'s — '
    + 'comparing the two with a plain Date.parse discards it',
  );

  // The guard still guards: a file written a second before the attempt began
  // belongs to the attempt before it.
  assert.equal(
    readOutcome(outcomeFile({ written_at: '2026-08-21T09:59:59Z' }), sameSecond),
    null,
    'genuinely older than this attempt',
  );
  // And one written later is plainly this attempt's.
  assert.equal(
    readOutcome(outcomeFile({ written_at: '2026-08-21T10:05:00Z' }), sameSecond)?.status,
    'complete',
  );
  // A timestamp we cannot place is not evidence that it belongs to us.
  assert.equal(readOutcome(outcomeFile({ written_at: 'yesterday-ish' }), sameSecond), null);
});

test('readOutcome: `needs`, `rule` and `command` ride the declaration — and their absence is tolerated', () => {
  const expect = { slug: 'demo', phase: 4 };
  const full = readOutcome(outcomeFile({ status: 'blocked', needs: 'credential', rule: 'Bash(ssh *)', command: 'ssh deploy@box' }), expect);
  assert.equal(full?.needs, 'credential');
  assert.equal(full?.rule, 'Bash(ssh *)');
  assert.equal(full?.command, 'ssh deploy@box');
  // A 4.1.0 session's file: blocked, no key. Still a declaration — the
  // classifier falls back to the prose; the rollout must not drop the park.
  const legacy = readOutcome(outcomeFile({ status: 'blocked', reason: 'no SSH key' }), expect);
  assert.equal(legacy?.status, 'blocked');
  assert.equal('needs' in (legacy ?? {}), false, 'absent, not an empty string');
  // A word, never a sentence; a decision key with dots and hyphens is a word.
  assert.equal(readOutcome(outcomeFile({ status: 'blocked', needs: 'resume.on-restart' }), expect)?.needs, 'resume.on-restart');
  assert.equal(readOutcome(outcomeFile({ status: 'blocked', needs: 'the SSH key please' }), expect)?.needs, undefined);
  assert.equal(readOutcome(outcomeFile({ status: 'blocked', needs: 42 }), expect)?.needs, undefined);
  // Sliced, not refused: a 600-character command is still a declaration.
  assert.equal(readOutcome(outcomeFile({ status: 'blocked', needs: 'permission', command: 'x'.repeat(600) }), expect)?.command?.length, 500);
});

test('consumeOutcome removes the file and never throws on one that is not there', () => {
  const path = outcomeFile();
  consumeOutcome(path);
  assert.equal(readOutcome(path, { slug: 'demo', phase: 4 }), null, 'consumed means gone');
  consumeOutcome(path); // again, and on a path that never existed
  consumeOutcome(join(tmpdir(), 'pc-outcome-never', 'nothing.json'));
});

test('WAI-7: ignoreOutcome sets a declaration aside under ignored/<name>.<reason>, bytes intact, and never overwrites', () => {
  const path = outcomeFile({ status: 'nonsense' });
  const bytes = readFileSync(path, 'utf8');
  assert.equal(readOutcome(path, { slug: 'demo', phase: 4 }), null, 'the reader rejects it');
  const kept = ignoreOutcome(path, 'invalid');
  assert.ok(kept);
  assert.ok(!existsSync(path), 'gone from the inbox');
  assert.equal(kept, join(path, '..', 'ignored', 'phase-04.json.invalid'));
  assert.equal(readFileSync(kept!, 'utf8'), bytes, 'the evidence is intact');
  // The same name again is suffixed, not clobbered.
  writeFileSync(path, 'second');
  const again = ignoreOutcome(path, 'invalid');
  assert.equal(again, `${kept}.1`);
  writeFileSync(path, 'third');
  assert.equal(ignoreOutcome(path, 'invalid'), `${kept}.2`);
  assert.equal(readFileSync(kept!, 'utf8'), bytes, 'the first is untouched');
  // A missing file cannot be set aside: null, and the caller falls back to consuming.
  assert.equal(ignoreOutcome(join(tmpdir(), 'pc-outcome-never', 'nothing.json'), 'stale'), null);
  assert.deepEqual([...OUTCOME_IGNORE_REASONS], ['stale', 'invalid', 'failed']);
});

test('WAI-7: peekWrittenAt reads the stamp off a declaration the strict reader rejected — or null', () => {
  const rejected = outcomeFile({ version: 9, written_at: '2026-09-13T15:55:39Z' });
  assert.equal(readOutcome(rejected, { slug: 'demo', phase: 4 }), null);
  assert.equal(peekWrittenAt(rejected), '2026-09-13T15:55:39Z');
  const junk = join(mkdtempSync(join(tmpdir(), 'pc-outcome-')), 'phase-04.json');
  writeFileSync(junk, 'not json');
  assert.equal(peekWrittenAt(junk), null);
  assert.equal(peekWrittenAt(join(tmpdir(), 'pc-outcome-never', 'nothing.json')), null);
});

// ── S9-a — the inbox name, and the order a backlog is read in ────────────────
// A session nobody supervises writes `runs/<instance>/<slug>/outcomes/…`, and
// that name used to be `phase-NN.json` — one per phase, written with `mv`. A
// second declaration destroyed an unread first, which is the one thing a
// channel replacing prose must not do. The name now carries the `written_at`
// stamp in basic ISO form: legal on every filesystem, and sorting as a plain
// string IS sorting chronologically, which is what lets a backlog be ingested
// oldest-first without opening anything.
const { inboxOutcomeFile, inboxOutcomePhase } = await import('../server/runner/outcome.ts');

test('S9-a: an inbox name carries the phase AND the written_at stamp', () => {
  const file = inboxOutcomeFile('/root', 'demo', 8, '2026-08-10T21:10:03Z');
  assert.equal(file.endsWith('/outcomes/phase-08-20260810T211003Z.json'), true, file);
  assert.equal(inboxOutcomePhase(file), 8);
});

test('S9-a: the bare legacy name still addresses its phase', () => {
  // A 5.0.0 `phase-outcome.sh` writing into a 5.1.0 console's inbox — and every
  // file already sitting in one at upgrade.
  assert.equal(inboxOutcomePhase('/x/outcomes/phase-08.json'), 8);
  assert.equal(inboxOutcomePhase('/x/outcomes/phase-114.json'), 114);
});

test('S9-a: a name that is not an outcome is still not one', () => {
  assert.equal(inboxOutcomePhase('/x/outcomes/ignored'), null);
  assert.equal(inboxOutcomePhase('/x/outcomes/phase-8.json'), null, 'one digit was never the shape');
  assert.equal(inboxOutcomePhase('/x/outcomes/phase-08-.json'), null, 'an empty stamp is not a stamp');
  assert.equal(inboxOutcomePhase('/x/outcomes/phase-08.json.tmp.91'), null);
});

test('S9-a: stamped names sort oldest-first as plain strings', () => {
  const names = [
    'phase-08-20260810T214409Z.json',
    'phase-08-20260810T211003Z.json',
    'phase-08-20260809T235959Z.json',
  ];
  assert.deepEqual([...names].sort(), [
    'phase-08-20260809T235959Z.json',
    'phase-08-20260810T211003Z.json',
    'phase-08-20260810T214409Z.json',
  ]);
  // …and a legacy file sorts before every stamped one, which is the right
  // order: it was written by an older script, so it is the oldest there is.
  assert.deepEqual(['phase-08-20260809T235959Z.json', 'phase-08.json'].sort(),
    ['phase-08-20260809T235959Z.json', 'phase-08.json']);
});
