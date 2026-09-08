/**
 * Watch refs — the pure half: which declared refs the console will poll, and
 * what counts as a landing. The `gh` half is deliberately not run here — tests
 * never shell out — so the parse and the verdict predicates carry the contract
 * for those two schemes.
 *
 * The three schemes added in 2026-08-30 (`date:`, `lock:`, `cmd:`), the
 * scheduler that polls them and the `cmd:` execution gate live in
 * `the-clock-is-evidence.test.ts` beside the rest of that phase's proofs.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseWatchRef, pollableRefs, prLanded, runLanded } from '../server/watch-refs.ts';

test('the gh shapes parse, and a malformed one stays unpollable rather than guessed at', () => {
  assert.deepEqual(parseWatchRef('gh:acme/app#run/33123610977'), {
    kind: 'gh-run', repo: 'acme/app', id: '33123610977', ref: 'gh:acme/app#run/33123610977',
  });
  assert.deepEqual(parseWatchRef('gh:acme/web-admin#pr/77'), {
    kind: 'gh-pr', repo: 'acme/web-admin', number: '77', ref: 'gh:acme/web-admin#pr/77',
  });
  // `url:` is still another subsystem's. `cmd:` and `lock:` USED to be here —
  // this module refused to run a recorded shell string on a timer, and could
  // not see a lock at all. Both are now schemes of their own; what changed is
  // not the judgement about executing a session's command but the machinery
  // (`verify.ts`'s read-only policy, and an operator switch). See
  // `the-clock-is-evidence.test.ts`.
  assert.equal(parseWatchRef('url:https://ci.example.com/build/9'), null);
  assert.equal(parseWatchRef('gh:acme#run/1'), null, 'no repo half');
  assert.equal(parseWatchRef('gh:acme/app#run/abc'), null, 'a run id is digits');
  assert.equal(parseWatchRef('gh:acme/app#job/12'), null, 'only run and pr shapes');
  assert.equal(parseWatchRef('gh:../../etc#run/1'), null, 'a repo is owner/name, not a path');
});

test('pollableRefs keeps declaration order, drops the rest, and dedupes', () => {
  const targets = pollableRefs([
    'url:https://ci.example.com/9',
    'gh:acme/app#run/123',
    'nonsense',
    'gh:acme/app#pr/9',
    'gh:acme/app#run/123',
  ]);
  assert.deepEqual(targets.map((t) => t.ref), ['gh:acme/app#run/123', 'gh:acme/app#pr/9'],
    'a ref declared twice is one probe, not two — the scheduler keys its rows on the ref');
  assert.deepEqual(pollableRefs(undefined), []);
});

test('a run lands only when it CONCLUDES — a failure ends the wait too, a start does not', () => {
  assert.equal(runLanded({ status: 'queued' }), 'pending');
  assert.equal(runLanded({ status: 'in_progress' }), 'pending', 'a session resumed to watch a progress bar is the burn this stops');
  assert.equal(runLanded({ status: 'completed', conclusion: 'success' }), 'landed');
  assert.equal(runLanded({ status: 'completed', conclusion: 'failure' }), 'landed', 'the session must look at a failure');
  assert.equal(runLanded({}), 'unknown');
});

test('a PR lands when it leaves OPEN, whichever door it takes', () => {
  assert.equal(prLanded({ state: 'OPEN' }), 'pending');
  assert.equal(prLanded({ state: 'MERGED' }), 'landed');
  assert.equal(prLanded({ state: 'CLOSED' }), 'landed');
  assert.equal(prLanded({}), 'unknown');
});
