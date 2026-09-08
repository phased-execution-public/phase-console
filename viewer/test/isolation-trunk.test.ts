/**
 * The isolation setting's trunk — three readers, one rule.
 *
 * `isolation` is stored in one place and decided in three: `newRun` (what a
 * fresh run records), `applySettings` (what a mid-run patch may change), and
 * `Runner.start`'s resume branch (what survives a restart). Phase 1 of this
 * plan was defeated by exactly this shape — a predicate narrowed in ONE of its
 * two readers, so the fix and its own undoing shipped in the same commit, and
 * only a reviewer noticed. This file exists so that cannot happen here.
 *
 * The rule, stated once:
 *
 *   1. **Absent means `queue`.** Every run file written before this feature
 *      existed keeps meaning what it meant, so `queue` is written as an
 *      omission and the only isolation state anything tests is `=== 'worktree'`.
 *   2. **Isolation needs a branch.** A run on the default branch has nothing
 *      to check out, so `isolation` is never written without `gitMode:
 *      'new-branch'` and is deleted when the branch is given up.
 *   3. **One way, downward.** A run may be dropped back to the shared checkout
 *      at any moment; it may never be raised into its own mid-run, because its
 *      commits are on the branch in the checkout it started in.
 *
 * Nothing here tests the ROUTE's 409 — that is `routes.test.ts`, where the
 * status code lives. This is the state layer, which must hold the same rule
 * even when the door is bypassed (the on-disk `configureRun` path is a caller
 * of `applySettings` with no HTTP anywhere near it).
 *
 * **The third reader is pinned in `test/git-strategy.test.ts`**, whose harness
 * drives ONE `Runner` twice over a real repository — the shape a resume has and
 * this file cannot build. `Runner.start`'s resume branch (`runner-control.ts`)
 * is covered there on every arm: a resume that says nothing keeps isolation
 * (`isolation is STICKY across a resume…`), one that drops it drops it (`a
 * resume that DROPS isolation…`), and — the two arms nobody had written down
 * until console-parallel-repaint P1 (W2) — a resume can never RAISE it, and
 * giving up the branch on a resume gives up isolation with it (`P1/W2 — …`).
 * This file keeps the state-layer half, which holds even when the door is
 * bypassed.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { newRun } from '../server/runner/state.ts';
import { applySettings } from '../server/runner/runner-core.ts';
import { ISOLATED } from '../shared/worktree-model.js';

const base = { slug: 'demo', root: '/tmp/demo' };

/* ------------------------------------------------------------------ *
 * newRun — absent means queue, and isolation needs a branch
 * ------------------------------------------------------------------ */

test('a fresh run records isolation ONLY as a work-branch run asking for it', () => {
  // The one case that writes the key.
  const isolated = newRun({ ...base, gitMode: 'new-branch', isolation: ISOLATED });
  assert.equal(isolated.isolation, ISOLATED);

  // Everything else omits it. `queue` on disk and no key at all must not be
  // two different things to read.
  for (const opts of [
    { ...base },
    { ...base, isolation: ISOLATED },                                  // no branch to check out
    { ...base, gitMode: 'new-branch' as const },                       // branch, but not asked for
    { ...base, gitMode: 'new-branch' as const, isolation: 'queue' as const },
    { ...base, gitMode: 'default-branch' as const, isolation: ISOLATED },
  ]) {
    const state = newRun(opts);
    assert.equal('isolation' in state, false, `${JSON.stringify(opts)} must not write the key`);
  }
});

/* ------------------------------------------------------------------ *
 * applySettings — one way, downward, and it goes with the branch
 * ------------------------------------------------------------------ */

test('a patch may drop isolation and may never raise it', () => {
  const isolated = () => newRun({ ...base, gitMode: 'new-branch', isolation: ISOLATED });

  // Down: the key is DELETED rather than set to `queue`, so a run switched
  // back reads identically to one that never left.
  const dropped = applySettings(isolated(), { isolation: 'queue' });
  assert.equal('isolation' in dropped, false, 'a drop is a delete, not a stored `queue`');

  // Up: ignored at this layer. The route answers 409 so a person is told;
  // here — where the on-disk path also lands — it simply cannot happen.
  const plain = newRun({ ...base, gitMode: 'new-branch' });
  assert.equal('isolation' in applySettings(plain, { isolation: ISOLATED }), false,
    'no patch may mint isolation on a running run');

  // Re-asserting what a run already is changes nothing and breaks nothing.
  assert.equal(applySettings(isolated(), { isolation: ISOLATED }).isolation, ISOLATED);

  // And a patch that says nothing about it leaves it exactly as it was.
  assert.equal(applySettings(isolated(), { model: 'sonnet' }).isolation, ISOLATED);
});

test('giving up the branch gives up isolation with it', () => {
  // Isolation without a branch of the run's own is a setting that reads as
  // configured and does nothing — the shape this codebase keeps refusing.
  const state = applySettings(
    newRun({ ...base, gitMode: 'new-branch', isolation: ISOLATED }),
    { gitMode: 'default-branch' },
  );
  assert.equal('gitMode' in state, false);
  assert.equal('openPr' in state, false);
  assert.equal('isolation' in state, false, 'the checkout request goes with the branch');
});
