/**
 * The gate vocabulary must mean the same thing to bash and to the console.
 *
 * `scripts/gates.env` is an F5 single source like `sizing.env`:
 * `phase-graph.sh` sources it and `server/analysis/gates.ts` regex-parses the
 * same lines. The module's own docstring names its pin — "Parity with
 * `--gate-kind` is pinned per phase by test/engine-parity.test.ts" — and until
 * now that file skipped in every environment that ran the suite, so
 * `gateKindOf` and `loadGateVocab` had close to no executed assertions
 * (coverage-4). Separately, the hardcoded FALLBACK duplicating `gates.env` was
 * asserted by nothing at all (xcut-9).
 *
 * The failure that motivates this: add a type to `gates.env`, say
 * `GATE_TYPES_AI="ai review"`. The engine answers `ai` for a
 * `- **Gate-check:** review …` line, and so does any console that can read the
 * file. On an install where `scriptsDir` does not resolve — a packed npm
 * install whose skill tree lives elsewhere — `loadGateVocab` throws, returns
 * FALLBACK, and `gateKindOf` answers `human` for every `review` gate. The Gate
 * card then demands an operator approval for a gate the engine would have let
 * an AI session clear, and an unattended run parks until somebody notices.
 *
 * Needs no environment and no plan library: it runs on a bare clone.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SKILL_DIR } from '../server/config.ts';
import { loadGateVocab, gateKindOf, GATES_ENV_FALLBACK, type GateKind } from '../server/analysis/gates.ts';

const SCRIPTS = join(SKILL_DIR, 'scripts');

test('the shipped fallback is identical to scripts/gates.env', () => {
  const file = loadGateVocab(SCRIPTS);
  assert.deepEqual([...file.types].sort(), [...GATES_ENV_FALLBACK.types].sort());
  assert.deepEqual([...file.human].sort(), [...GATES_ENV_FALLBACK.human].sort());
  assert.deepEqual([...file.ai].sort(), [...GATES_ENV_FALLBACK.ai].sort());
});

test('every key the reader looks for is actually present in the file', () => {
  const text = readFileSync(join(SCRIPTS, 'gates.env'), 'utf8');
  for (const key of ['GATE_TYPES', 'GATE_TYPES_HUMAN', 'GATE_TYPES_AI']) {
    assert.match(text, new RegExp(`^${key}="`, 'm'), `${key} is missing from gates.env`);
  }
});

test('the human and ai categories are drawn from the type list', () => {
  const vocab = loadGateVocab(SCRIPTS);
  for (const type of [...vocab.human, ...vocab.ai]) {
    assert.ok(
      vocab.types.includes(type),
      `"${type}" is categorised but is not in GATE_TYPES, so --gate-status would not recognise it`,
    );
  }
  // A type in neither list is `auto` by construction — the engine evaluates it
  // itself. Assert at least one exists, or the category split is meaningless.
  const auto = vocab.types.filter((t) => !vocab.human.includes(t) && !vocab.ai.includes(t));
  assert.ok(auto.length > 0, 'no self-evaluating gate types left — check gates.env');
});

test('an unreadable scripts directory falls back rather than throwing', () => {
  assert.deepEqual(loadGateVocab(join(SKILL_DIR, 'no-such-directory')), GATES_ENV_FALLBACK);
});

/**
 * The category table, stated once so a change to `gate_kind` has to change a
 * test rather than only a behaviour.
 */
test('gateKindOf answers the same category the engine\'s gate_kind does', () => {
  const vocab = loadGateVocab(SCRIPTS);
  const cases: [string | undefined, boolean, GateKind, string][] = [
    ['manual the operator flips the flag', true, 'human', 'manual is a person'],
    ['ai verify the image published', true, 'ai', 'ai is a session'],
    ['phase 4', true, 'auto', 'the engine evaluates phase completion'],
    ['phases 4, 5', true, 'auto', 'and the plural form'],
    ['plan other-plan', true, 'auto', 'and a whole plan'],
    ['cmd test -f dist/app.js', true, 'auto', 'and a read-only command'],
    ['date 2026-01-01', true, 'auto', 'and a date'],
    ['deadline 2026-01-01', true, 'auto', 'and a deadline'],
    ['by 2026-01-01', true, 'auto', 'and its synonym'],
    ['Date 2026-01-01', true, 'human', 'CASE-SENSITIVE: capital-D Date is an unknown type'],
    ['review the design', true, 'human', 'an unknown type is a person, fail-safe'],
    [undefined, true, 'human', 'a GATED phase with no Gate-check line at all is a person'],
    ['', true, 'human', 'and so is an empty one'],
    ['manual the operator flips the flag', false, 'none', 'not gated is not a gate'],
    [undefined, false, 'none', 'and neither is nothing'],
  ];
  for (const [gateCheck, gated, expected, why] of cases) {
    assert.equal(
      gateKindOf(gateCheck, gated, vocab), expected,
      `${JSON.stringify(gateCheck)} (gated: ${gated}) should be ${expected} — ${why}`,
    );
  }
});

test('the category is read from the FIRST token, whatever follows it', () => {
  const vocab = loadGateVocab(SCRIPTS);
  assert.equal(gateKindOf('manual', true, vocab), 'human');
  assert.equal(gateKindOf('  manual   with leading space', true, vocab), 'human');
  assert.equal(gateKindOf('ai\tverify with a tab', true, vocab), 'ai');
  // A type name appearing later in the line is not the type.
  assert.equal(gateKindOf('phase 4 — then manual approval', true, vocab), 'auto');
});
