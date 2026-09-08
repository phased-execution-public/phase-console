/**
 * `engine.ts`'s module-level result cache — what its key must and must not join.
 *
 * This exists because the fix it pins was landed once (`4864db8`), reverted once
 * (`c67624b`) on a measurement that was later RETRACTED, and re-instated in P10.
 * A one-line change with that history needs a witness that fails without it, or
 * the next reader re-litigates it from the comment alone.
 *
 * The witness is OBJECT IDENTITY, not a stopwatch: `run()` returns the very
 * object it cached, so `===` says precisely whether a subprocess was skipped.
 * That is the same instrument P9 used to settle the retraction, and it is immune
 * to the machine load that produced the wrong answer the first time.
 *
 * No fixture plan is needed. `run()` caches its result regardless of exit code,
 * so a slug nobody has still proves the mechanism — and keeps this file fast.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run, invalidate } from '../server/engine.ts';
import { SKILL_DIR } from '../server/config.ts';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const KEY = { slug: 'no-such-plan-engine-cache', revision: 1 };
const ARGS = [KEY.slug, '--qa-mode'];

/** Two roots that really exist, because `run` sets them as the subprocess cwd. */
function roots(): { a: string; b: string; drop: () => void } {
  const a = mkdtempSync(join(tmpdir(), 'pc-cache-a-'));
  const b = mkdtempSync(join(tmpdir(), 'pc-cache-b-'));
  return { a, b, drop: () => { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); } };
}

test('two reads under the SAME root still share — the hit that matters is not lost', async () => {
  invalidate();
  const { a, drop } = roots();
  try {
    const first = await run({ scriptsDir: SCRIPTS, root: a }, 'phase-graph.sh', ARGS, KEY);
    const second = await run({ scriptsDir: SCRIPTS, root: a }, 'phase-graph.sh', ARGS, KEY);
    assert.equal(
      second,
      first,
      'same root, same slug, same revision, same args: the second read must be the cached object. '
        + 'Adding a field to a cache key can only split entries that DIFFER in that field, so if '
        + 'this fails the key is carrying something that is not stable across two identical reads.',
    );
  } finally {
    drop();
  }
});

test('two reads under DIFFERENT roots do not share — this is the bug the root in the key closes', async () => {
  invalidate();
  const { a, b, drop } = roots();
  try {
    const underA = await run({ scriptsDir: SCRIPTS, root: a }, 'phase-graph.sh', ARGS, KEY);
    const underB = await run({ scriptsDir: SCRIPTS, root: b }, 'phase-graph.sh', ARGS, KEY);
    assert.notEqual(
      underB,
      underA,
      'root B was handed root A\'s answer. `<slug>` at `<revision>` under one source directory is a '
        + 'different plan from the same name under another, and `invalidate(slug)` cannot help — '
        + 'nothing about the plan changed, only which tree is being asked about. Put `opts.root` '
        + 'back in the key in engine.ts.',
    );
  } finally {
    drop();
  }
});

test('invalidate(slug) still matches after the root joined the key — that is why it was appended LAST', async () => {
  invalidate();
  const { a, drop } = roots();
  try {
    const first = await run({ scriptsDir: SCRIPTS, root: a }, 'phase-graph.sh', ARGS, KEY);
    invalidate(KEY.slug);
    const afterDrop = await run({ scriptsDir: SCRIPTS, root: a }, 'phase-graph.sh', ARGS, KEY);
    assert.notEqual(
      afterDrop,
      first,
      'the entry survived `invalidate(<slug>)`. That match is a substring scan for the slug between '
        + 'its two NUL separators, so the root MUST be appended after the args — prepend it, or put '
        + 'it between the slug and its separator, and every plan becomes uninvalidatable.',
    );
  } finally {
    drop();
  }
});
