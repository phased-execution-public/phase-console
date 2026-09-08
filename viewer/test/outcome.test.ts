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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { consumeOutcome, readOutcome } = await import('../server/runner/outcome.ts');

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

test('consumeOutcome removes the file and never throws on one that is not there', () => {
  const path = outcomeFile();
  consumeOutcome(path);
  assert.equal(readOutcome(path, { slug: 'demo', phase: 4 }), null, 'consumed means gone');
  consumeOutcome(path); // again, and on a path that never existed
  consumeOutcome(join(tmpdir(), 'pc-outcome-never', 'nothing.json'));
});
