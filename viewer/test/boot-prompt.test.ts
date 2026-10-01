/**
 * What a mirror session is told about the repositories it was NOT given
 * (control-tower phase 90, #139 — GD-3).
 *
 * Measured on hub 4123 (observability-plane P28): the session needed to read
 * seven repositories outside its phase's scope, found their mount paths EMPTY,
 * and cloned them there — a clone at a mount path is what broke the run's own
 * checkout at the next rebuild. Its boot prompt said to read unlisted
 * repositories at the shared root, and said nothing against a clone or a
 * `git submodule update --init` in the tree it stood in.
 *
 *  - GD-3 the mirror paragraph names the root checkout for out-of-scope reads
 *    (read-only) and forbids `git clone` and `git submodule update --init` in
 *    the integration tree, saying why and what the console does about each.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { drive, harness, superRoot } from './lane-harness.ts';

for (const key of ['PE_WORKTREE', 'PE_BRANCH', 'PE_SCOPE', 'PE_OWNER', 'PE_LOCK_MIRROR']) delete process.env[key];

test('GD-3 — a mirror session is told to read other repositories at the root, and never to clone or init them here', async () => {
  const { root } = superRoot();
  // A mirror of `web` alone: `api` lives only at the shared root.
  const h = harness(root, { 1: 'web', 2: 'web' }, { planScope: () => ['web'] });
  const state = await drive(h, { onlyPhases: [1] });
  assert.equal(state.checkout, 'worktree');
  const prompt = String(h.requests[0]?.prompt ?? '');
  assert.match(prompt, /console-built MIRROR/);
  assert.ok(prompt.includes(`read it there if you need\n  it (\`${root}/<repo>\`, READ-ONLY)`),
    'the out-of-scope read path is not named');
  assert.match(prompt, /NEVER `git clone` \(or `gh repo clone`\) into this tree/);
  assert.match(prompt, /NEVER\n  run `git submodule update --init` in it/);
  assert.match(prompt, /the console refuses the first and\n  asks a person about the second/);
});
