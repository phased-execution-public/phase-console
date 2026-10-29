/**
 * Where a decision's answer is written (2026-10-20) — every `^<key>:` grep a
 * plan's proof spells, read through the proof's own pattern.
 *
 *   AT-1  the value shape (`grep -Eq '^k: *[a-z]'`, how a plan with an answers
 *         file asks each owner decision) takes `k: <option id>`: the plan's own
 *         convention, which its gate tool reads WHOLE, so the note never rides
 *         the line.
 *   AT-2  #368's `answered` shape still takes `k: answered — <label>[: <note>]`.
 *   AT-3  flags and dialects: -i, -E/egrep, a BRE's operators, POSIX classes,
 *         -x, -w, -F, -e and -qe.
 *   AT-4  a pattern no answer of the decision can say writes nothing; an
 *         inverted, counted or pattern-file grep, a second file, a relative
 *         path or a pipe names no place at all.
 *   AT-5  the translator refuses what it does not know, and the key reader
 *         finds no key where a pattern names none.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { answerLineFor, answerTargetOf, grepMatcher, keyOf } from '../server/turn/answer-target.ts';

/** Never written by these tests: the readers are pure. */
const FILE = '/nowhere/docs/handoffs/alpha/owner-answers.md';

const target = (command: string) => answerTargetOf(`cmd:"${command}"`);

test('AT-1 — the value shape takes `<key>: <option id>`, and the note never rides the line', () => {
  const at = target(`grep -Eq '^deprecations: *[a-z]' ${FILE}`);
  assert.ok(at && at.mode === 'append-line', JSON.stringify(at));
  assert.equal(at.key, 'deprecations');
  assert.equal(answerLineFor(at, { option: 'deprecate', label: 'Deprecate with migrations', note: 'go' }), 'deprecations: deprecate');
  assert.equal(answerLineFor(at, { option: 'keep-and-wire', label: 'Keep and wire' }), 'deprecations: keep-and-wire');
  // An answer in words alone is #368's line, which the value shape accepts too.
  assert.equal(answerLineFor(at, { note: 'decide it' }), 'deprecations: answered — decide it');
});

test('AT-2 — the `answered` shape keeps #368\'s line', () => {
  const at = target(`grep -qi '^store: answered' ${FILE}`)!;
  assert.equal(answerLineFor(at, { option: 'prune', label: 'Prune once', note: 'go ahead' }), 'store: answered — Prune once: go ahead');
  assert.equal(answerLineFor(at, { label: 'Prune once' }), 'store: answered — Prune once');
});

test('AT-3 — flags and dialects', () => {
  const line = (command: string, answer: { option?: string; label?: string; note?: string }) =>
    answerLineFor(target(command)!, answer);
  assert.equal(line(`grep -E -q '^k:[[:space:]]*[a-z]' ${FILE}`, { option: 'yes' }), 'k: yes');
  assert.equal(line(`grep -q '^k: \\(yes\\|no\\)$' ${FILE}`, { option: 'no' }), 'k: no', "a BRE's \\( \\| \\) are operators");
  assert.equal(line(`grep -q '^k: (a)' ${FILE}`, { option: 'a' }), null, "a BRE's bare ( ) are characters");
  assert.equal(line(`egrep -q '^k: (a|b)$' ${FILE}`, { option: 'b' }), 'k: b');
  assert.equal(line(`grep -qx 'k: yes' ${FILE}`, { option: 'yes' }), 'k: yes');
  assert.equal(line(`grep -qx 'k: yes' ${FILE}`, { option: 'yes-please' }), null, '-x matches the whole line');
  assert.equal(line(`grep -qw 'k: yes' ${FILE}`, { option: 'yes' }), 'k: yes');
  assert.equal(line(`grep -qF 'k: yes' ${FILE}`, { option: 'yes' }), 'k: yes');
  assert.equal(line(`grep -q -e '^k: [a-z]' ${FILE}`, { option: 'go' }), 'k: go');
  assert.equal(line(`grep -qe '^k: [a-z]' ${FILE}`, { option: 'go' }), 'k: go');
  assert.equal(line(`grep -qi '^K: [A-Z]' ${FILE}`, { option: 'go' }), 'K: go', '-i folds case; the key is written as the plan spells it');
  assert.equal(line(`grep -q '^k: [[:lower:]][[:lower:]]*' ${FILE}`, { option: 'go' }), 'k: go');
});

test('AT-4 — what no answer can say writes nothing, and some greps name no place', () => {
  const alternation = target(`grep -Eq '^k: *(yes|no)' ${FILE}`)!;
  assert.equal(answerLineFor(alternation, { option: 'ship', label: 'Ship it' }), null);
  // An option id that is no lower-case word is never written as a value.
  assert.equal(answerLineFor(target(`grep -Eq '^k: *[A-Za-z]' ${FILE}`)!, { option: 'Ship It', label: 'Ship it' }), 'k: answered — Ship it');
  for (const command of [
    `grep -vq '^k:' ${FILE}`,
    `grep -cq '^k:' ${FILE}`,
    `grep -q -f patterns.txt ${FILE}`,
    `grep -Pq '^k: \\d' ${FILE}`,
    `grep -q '^k: x' ${FILE} ${FILE}`,
    "grep -q '^k: x' docs/handoffs/alpha/owner-answers.md",
    `grep -q '^k: x' ${FILE} | head`,
    `grep -q 'me/profile 200' ${FILE}`,
    `grep -Eq '^[|] *16 *[|]' ${FILE}`,
  ]) {
    assert.equal(target(command), null, command);
  }
});

test('AT-5 — the translator refuses what it does not know', () => {
  assert.equal(grepMatcher('\\<k'), null, 'GNU word edges are not read here');
  assert.equal(grepMatcher('[[:punct:]]'), null);
  assert.equal(grepMatcher('[[=a=]]'), null);
  assert.equal(grepMatcher('[abc'), null, 'an unclosed bracket');
  assert.ok(grepMatcher('^k: [a-z]', { ere: true }) instanceof RegExp);
  assert.equal(grepMatcher('a.b', { fixed: true })!.test('axb'), false, '-F reads a dot as a dot');
  assert.equal(grepMatcher('[]x]')!.test(']'), true, 'a leading ] is a member');
  assert.equal(keyOf('^[|] *16 *[|]'), null);
  assert.equal(keyOf('^  login:'), 'login');
  assert.equal(keyOf('^clock-migration: *[a-z]'), 'clock-migration');
});
