/**
 * The settle strategy's trunk — one field, an older field beside it, one rule.
 *
 * `settle` is the second setting in this plan to be decided in more than one
 * place (`newRun`, `applySettings`, `Runner.start`'s resume branch), and the
 * first to arrive on top of a field that already means part of what it means.
 * `openPr` is on thousands of run files, and a run that said `openPr: false`
 * asked for exactly what `keep` means. So there are two rules rather than one,
 * and both are stated here because the isolation trunk's lesson was that a
 * predicate narrowed in ONE of its readers ships the fix and its own undoing in
 * the same commit.
 *
 *   1. **`settle` wins where it is present; `openPr` answers where it is not.**
 *      `settleOf()` is the single fold, and no reader tests either field
 *      directly. That is what lets a run file written before this feature keep
 *      meaning exactly what it meant.
 *   2. **The two are kept in step wherever either is written.** `openPr ===
 *      (settle === 'pr')` on every fresh run and after every patch, so a reader
 *      that still consults the older field cannot disagree with the newer one —
 *      and the form sends the same mirror, so a payload cannot contradict
 *      itself either.
 *   3. **Both ways, unlike isolation.** Isolation is one-way down because a
 *      run's commits are already in the checkout it started in. Settle governs
 *      what happens when the run ENDS, which has not happened yet, so there is
 *      no impossible direction and no 409 at the door.
 *
 * The FOURTH rule is about the push wall and lives in `SETTLE_PUSHES`: two of
 * the four strategies end at a remote, and only those two may open the
 * carve-out. `never-push.test.ts` guards the wall itself; this file guards the
 * membership, because a strategy quietly added to that set is a `git push`
 * granted by a data change nobody reviews as one.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { newRun } from '../server/runner/state.ts';
import { applySettings } from '../server/runner/runner-core.ts';
import {
  DEFAULT_SETTLE, SETTLE_PUSHES, SETTLE_STRATEGIES, settleOf, settleStrategy,
} from '../shared/worktree-model.js';

const base = { slug: 'demo', root: '/tmp/demo' };
const branched = { ...base, gitMode: 'new-branch' as const };

/* ------------------------------------------------------------------ *
 * settleOf — the fold, and the whole back-compatibility story
 * ------------------------------------------------------------------ */

test('a run file with no `settle` is read through `openPr`, exactly as it always was', () => {
  // The two shapes every pre-P12 run file has.
  assert.equal(settleOf({ openPr: true }), 'pr');
  assert.equal(settleOf({ openPr: false }), 'keep');
  // …and the shape a default-branch run has: no branch, no PR flag, and the
  // answer is still the one that costs nothing to be wrong about.
  assert.equal(settleOf({}), 'pr');
});

test('`settle` outranks `openPr` — it is the newer and more specific instruction', () => {
  for (const strategy of SETTLE_STRATEGIES) {
    assert.equal(settleOf({ settle: strategy, openPr: true }), strategy);
    assert.equal(settleOf({ settle: strategy, openPr: false }), strategy);
  }
});

test('a typo folds to `pr`, which is the SAFE direction and not merely the tidy one', () => {
  // The failure that costs something is a misspelled setting silently ending
  // pull requests — a feature going missing with no error anywhere. Folding
  // the other way would do exactly that.
  for (const junk of ['PR', 'Pull request', 'mergequeue', '', 1, null, undefined, {}]) {
    assert.equal(settleStrategy(junk), DEFAULT_SETTLE);
    assert.equal(settleOf({ settle: junk }), DEFAULT_SETTLE);
  }
  // …and an unrecognised `settle` does NOT swallow a legacy `openPr: false`.
  assert.equal(settleOf({ settle: 'nonsense', openPr: false }), 'keep');
});

/* ------------------------------------------------------------------ *
 * newRun — written under a branch only, and mirrored into `openPr`
 * ------------------------------------------------------------------ */

test('a fresh run records `settle` ONLY when it has a branch to settle', () => {
  for (const strategy of SETTLE_STRATEGIES) {
    assert.equal(newRun({ ...branched, settle: strategy }).settle, strategy);
    // A run with no branch of its own has nothing to settle, so a stored
    // strategy would read as configured and do nothing — the shape of setting
    // this codebase keeps deciding not to have.
    assert.equal(newRun({ ...base, settle: strategy }).settle, undefined);
  }
  assert.equal(newRun({ ...base, settle: 'integration' }).openPr, undefined);
});

test('`openPr` is written as the MIRROR of the strategy, and the two legacy cases are unchanged', () => {
  assert.equal(newRun(branched).openPr, true, 'saying nothing still opens a PR');
  assert.equal(newRun(branched).settle, 'pr');
  assert.equal(newRun({ ...branched, openPr: false }).openPr, false, 'the old flag still means what it meant');
  assert.equal(newRun({ ...branched, openPr: false }).settle, 'keep');

  // The mirror holds for all four, so no reader of the older field can
  // disagree with a reader of the newer one.
  for (const strategy of SETTLE_STRATEGIES) {
    const run = newRun({ ...branched, settle: strategy });
    assert.equal(run.openPr, strategy === 'pr', `openPr must mirror ${strategy}`);
  }
});

test('an explicit strategy beats a stale client\'s `openPr` on the same launch', () => {
  // An updated form sends both; the strategy is the answer, and `openPr` is
  // rewritten to agree rather than left to contradict it.
  const run = newRun({ ...branched, settle: 'merge-queue', openPr: true });
  assert.equal(run.settle, 'merge-queue');
  assert.equal(run.openPr, false);
  assert.equal(settleOf(run), 'merge-queue');
});

/* ------------------------------------------------------------------ *
 * applySettings — both ways, and the mirror survives every patch
 * ------------------------------------------------------------------ */

test('a settings patch moves the strategy in BOTH directions, unlike isolation', () => {
  const run = newRun(branched);
  for (const strategy of [...SETTLE_STRATEGIES, ...SETTLE_STRATEGIES].reverse()) {
    applySettings(run, { settle: strategy });
    assert.equal(run.settle, strategy);
    assert.equal(run.openPr, strategy === 'pr', 'the mirror must survive every patch');
    assert.equal(settleOf(run), strategy);
  }
});

test('patching the older `openPr` flag moves the strategy with it, between the two legacy words', () => {
  const run = newRun({ ...branched, settle: 'integration' });
  applySettings(run, { openPr: false });
  assert.equal(run.settle, 'keep', 'unticking "open a PR" means keep, not integration');
  applySettings(run, { openPr: true });
  assert.equal(run.settle, 'pr');
  assert.equal(run.openPr, true);
});

test('giving up the branch takes the strategy with it', () => {
  const run = newRun({ ...branched, settle: 'merge-queue' });
  applySettings(run, { gitMode: 'default-branch' });
  assert.equal(run.settle, undefined);
  assert.equal(run.openPr, undefined);
  assert.equal(run.gitMode, undefined);
  // And a patch on a branchless run stores nothing — same rule as `openPr`.
  applySettings(run, { settle: 'integration' });
  assert.equal(run.settle, undefined);
});

test('a run GIVEN a branch mid-run is given a strategy to settle it with', () => {
  const run = newRun(base);
  applySettings(run, { gitMode: 'new-branch', settle: 'integration' });
  assert.equal(run.settle, 'integration');
  // …and one given a branch with nothing else said falls back through the
  // same fold rather than being left with no answer at all.
  const bare = newRun(base);
  applySettings(bare, { gitMode: 'new-branch' });
  assert.equal(settleOf(bare), 'pr');
  assert.notEqual(bare.settle, undefined);
});

/* ------------------------------------------------------------------ *
 * The push wall's membership list
 * ------------------------------------------------------------------ */

test('exactly two strategies may open the push carve-out, and they are named', () => {
  // Stated as a list rather than derived, because this IS the review: adding a
  // strategy to this set grants a `git push` the deny wall otherwise refuses,
  // and it must not be possible to do that as a quiet data change.
  assert.deepEqual([...SETTLE_PUSHES].sort(), ['merge-queue', 'pr']);
  assert.equal(SETTLE_PUSHES.has('integration'), false, 'an integration settle touches no remote');
  assert.equal(SETTLE_PUSHES.has('keep'), false, 'a keep settle does nothing at all');
  // Every member is a real strategy — a set holding a word the vocabulary does
  // not know would be a carve-out nothing can ever reach, or worse, a typo
  // standing in for one that can.
  for (const strategy of SETTLE_PUSHES) {
    assert.ok(SETTLE_STRATEGIES.includes(strategy), `${strategy} is not a settle strategy`);
  }
});
