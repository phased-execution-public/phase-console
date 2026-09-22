/**
 * The address parser, at the edges phase 10's decider actually meets.
 *
 * `gates-vocab.test.ts` already holds every LIST in `message-model.js` to its
 * bash twin word for word, and round-trips one address per scheme. This file is
 * deliberately the other half — the inputs a real sender produces that a
 * round-trip never exercises, because every one of them is a way for a message
 * to reach the wrong session:
 *
 *   a bare word            would silently become a session id
 *   a scheme with padding  arrives from a shell that quoted generously
 *   an empty target        is legal for `all:` and `operator:` and for nobody else
 *   a colon in the target  is what a session id looks like on some machines
 *
 * `parseAddress` is the ONLY thing standing between those and a delivery, and
 * `decideDelivery` reads its three answers as three different facts
 * (`undefined` → `unknown-scheme`, `[]` → `no-recipient`, a list → deliver), so
 * a parser that guessed would turn a refusal into somebody else's mail.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MESSAGING, MESSAGE_DELIVER, MESSAGE_KINDS, MESSAGE_MAX_BYTES, MESSAGE_MAX_PER_PHASE,
  MESSAGE_PRIORITIES, MESSAGE_REFUSALS, MESSAGE_SCHEMES, MESSAGE_STATES, MESSAGE_VIAS,
  formatAddress, parseAddress,
} from '../shared/message-model.js';
import { RUN_PRIORITIES } from '../shared/orchestration-model.js';

/* ------------------------------------------------------------------ *
 * The parser's refusals
 * ------------------------------------------------------------------ */

test('a bare word is refused — it is exactly what a session id looks like', () => {
  // The failure this prevents: `--to operator` (no colon) parsed as a session
  // whose id happens to be "operator", and a message to a person delivered to
  // nobody with no refusal. The SCRIPT expands the sugar; the model never guesses.
  for (const bare of ['operator', 'all', 'next', 'run', 'repo', 'phase7', '7', 'sess-abc']) {
    assert.equal(parseAddress(bare), undefined, `${bare} parsed as an address`);
  }
});

test('an unknown scheme is refused rather than passed through', () => {
  for (const bad of ['carrier:pigeon', 'http://x', 'PHASE7:x', 'phases:7']) {
    assert.equal(parseAddress(bad), undefined, `${bad} parsed as an address`);
  }
});

test('a non-string is refused without throwing', () => {
  for (const bad of [undefined, null, 7, {}, [], true]) {
    assert.equal(parseAddress(bad), undefined);
  }
});

test('an empty string is refused', () => {
  assert.equal(parseAddress(''), undefined);
  assert.equal(parseAddress(':'), undefined, 'a lone colon names no scheme');
});

/* ------------------------------------------------------------------ *
 * The parser's tolerances — and their limits
 * ------------------------------------------------------------------ */

test('the scheme is case-insensitive and trimmed, because a shell quotes generously', () => {
  assert.deepEqual(parseAddress(' PHASE : 7 '), { scheme: 'phase', target: '7' });
  assert.deepEqual(parseAddress('Operator:'), { scheme: 'operator', target: '' });
});

test('an empty target is legal — `all:` and `operator:` address nobody in particular', () => {
  for (const scheme of ['all', 'operator', 'run', 'repo', 'next'] as const) {
    assert.deepEqual(parseAddress(`${scheme}:`), { scheme, target: '' });
  }
});

test('only the FIRST colon splits, so a session id may contain one', () => {
  // Some machines' ids do. Splitting on every colon would lose the tail and
  // deliver to a different session, or to none.
  assert.deepEqual(parseAddress('session:a:b:c'), { scheme: 'session', target: 'a:b:c' });
});

test('a phase address keeps its whole target, slug and all', () => {
  // The ledger holds `phase:<slug>/<N>` and the resolver reads the number off
  // the tail: a parser that split the slug out would make one plan's phase 7
  // indistinguishable from another's.
  assert.deepEqual(parseAddress('phase:many-plans-one-repo/7'),
    { scheme: 'phase', target: 'many-plans-one-repo/7' });
});

/* ------------------------------------------------------------------ *
 * The inverse
 * ------------------------------------------------------------------ */

test('formatAddress never produces a string parseAddress would refuse', () => {
  for (const scheme of MESSAGE_SCHEMES) {
    for (const target of ['', '7', 'plan/7', 'a:b']) {
      const address = formatAddress({ scheme, target });
      assert.deepEqual(parseAddress(address), { scheme, target }, `${address} did not round-trip`);
    }
  }
});

test('formatAddress treats a missing target as an empty one', () => {
  assert.equal(formatAddress({ scheme: 'operator' }), 'operator:');
});

/* ------------------------------------------------------------------ *
 * The shapes the delivery engine depends on
 * ------------------------------------------------------------------ */

test('the priorities are the run vocabulary BY IDENTITY, not an equal copy', () => {
  // The whole reason the alias exists: "how urgent is this" has one answer in
  // this system, and two copies that agree today are two that disagree the day
  // a fourth word is added.
  assert.equal(MESSAGE_PRIORITIES, RUN_PRIORITIES);
});

test('every list is frozen — a reader cannot edit the vocabulary it was handed', () => {
  for (const [name, list] of Object.entries({
    MESSAGE_KINDS, MESSAGE_SCHEMES, MESSAGE_DELIVER, MESSAGE_STATES, MESSAGE_VIAS, MESSAGE_REFUSALS,
  })) {
    assert.ok(Object.isFrozen(list), `${name} is not frozen`);
  }
});

test('the states are in lifecycle order, and the two settled-but-unreached ones come last', () => {
  // `readMailbox` folds last-state-wins and the decider reads `SETTLED` off
  // these words; the ORDER is what a surface renders a progress line from.
  assert.deepEqual([...MESSAGE_STATES], [
    'queued', 'held', 'delivering', 'delivered', 'acked', 'expired', 'refused', 'failed',
  ]);
});

test('`delivered` and `acked` are two words, because the socket answers nothing', () => {
  // Phase 1, arm S-B: the CLI's inbox writes zero bytes back on every outcome.
  // "The bytes went in" is all a sender can learn from the connection, so a
  // model with one word for both would make every send look read.
  assert.ok(MESSAGE_STATES.includes('delivered'));
  assert.ok(MESSAGE_STATES.includes('acked'));
  assert.ok(MESSAGE_STATES.indexOf('delivered') < MESSAGE_STATES.indexOf('acked'));
});

test('`boot` is the only delivery request that can name a phase which has not started', () => {
  assert.deepEqual([...MESSAGE_DELIVER], ['now', 'next-turn', 'boot']);
  assert.equal(MESSAGE_DELIVER[MESSAGE_DELIVER.length - 1], 'boot');
});

test('the caps are numbers a reader can act on, not strings', () => {
  assert.equal(typeof MESSAGE_MAX_BYTES, 'number');
  assert.equal(typeof MESSAGE_MAX_PER_PHASE, 'number');
  assert.equal(MESSAGE_MAX_BYTES, 8192);
  assert.equal(MESSAGE_MAX_PER_PHASE, 16);
});

test('messaging is on by default — it costs nothing unused', () => {
  assert.equal(DEFAULT_MESSAGING, 'on');
});
