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
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SKILL_DIR } from '../server/config.ts';
import { loadGateVocab, gateKindOf, GATES_ENV_FALLBACK, type GateKind } from '../server/analysis/gates.ts';
import {
  LAND_POLICIES, DEFAULT_LAND, GITLINK_POLICIES, DEFAULT_GITLINK,
  CONFLICT_POLICIES, DEFAULT_CONFLICT, BASE_BRANCH_WORDS, DEFAULT_BASE_BRANCH,
  LANDING_STATES, LANDED_BY_POLICY, PR_MERGED_STATES, landPolicyOf,
} from '../shared/landing-model.js';
import {
  MESSAGE_KINDS, MESSAGE_SCHEMES, MESSAGE_DELIVER, MESSAGE_PRIORITIES,
  MESSAGE_STATES, MESSAGE_VIAS, MESSAGE_REFUSALS,
  MESSAGE_MAX_BYTES, MESSAGE_MAX_PER_PHASE, MESSAGING_WORDS, DEFAULT_MESSAGING,
  parseAddress, formatAddress,
} from '../shared/message-model.js';
import {
  ISSUE_MODES, DEFAULT_ISSUES, ISSUE_ACTIONS, ISSUE_STATES, ISSUE_BUDGETS,
  ISSUE_FIELDS, issueFingerprint,
} from '../shared/issues-model.js';
import {
  ISOLATION_DIRECTIVES, WORKTREE_RETENTION, DEFAULT_RETENTION, WORKTREE_LOCK_PREFIXES,
  DEFAULT_ISOLATION_FOR_NEW_BRANCH, retentionOf, retentionTtlHours,
} from '../shared/worktree-model.js';

const SCRIPTS = join(SKILL_DIR, 'scripts');

/** One variable out of one `.env`, exactly as `phase-graph.sh` would read it. */
function fromBash(file: string, name: string): string {
  return execFileSync('bash', ['-c', `. "${join(SCRIPTS, file)}"; printf '%s' "$${name}"`], {
    encoding: 'utf8',
  });
}

test('the shipped fallback is identical to scripts/gates.env', () => {
  const file = loadGateVocab(SCRIPTS);
  assert.deepEqual([...file.types].sort(), [...GATES_ENV_FALLBACK.types].sort());
  assert.deepEqual([...file.human].sort(), [...GATES_ENV_FALLBACK.human].sort());
  assert.deepEqual([...file.ai].sort(), [...GATES_ENV_FALLBACK.ai].sort());
  assert.equal(file.default, GATES_ENV_FALLBACK.default);
  assert.equal(file.default, 'ai', 'operator decision 7 / ZTD-5: an undeclared gate is an AI gate');
  assert.ok(file.ai.includes(file.default), 'the default must be a type that classifies as ai, or the audit\'s bias is not what ships');
});

test('every key the reader looks for is actually present in the file', () => {
  const text = readFileSync(join(SCRIPTS, 'gates.env'), 'utf8');
  for (const key of ['GATE_TYPES', 'GATE_TYPES_HUMAN', 'GATE_TYPES_AI', 'GATE_DEFAULT']) {
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
    ['review the design', true, 'human', 'an unknown type is a person, fail-safe (and lint F24)'],
    [undefined, true, 'ai', 'a GATED phase with no Gate-check line at all reads as GATE_DEFAULT — ai since 5.0.0 (ZTD-5; and lint F24)'],
    ['', true, 'ai', 'and so does an empty one'],
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

/**
 * The two landing gate kinds. They are `auto` — the engine reads the landing
 * ledger and answers by itself — which is the whole reason they exist: a plan
 * that had to say "the operator confirms phase 8's PR merged" spent a person
 * on a fact `gh` already knows and the ledger already records.
 */
test('landed and pr-merged are gate types, and both are self-evaluating', () => {
  const vocab = loadGateVocab(SCRIPTS);
  for (const type of ['landed', 'pr-merged']) {
    assert.ok(vocab.types.includes(type), `${type} is missing from GATE_TYPES`);
    assert.ok(GATES_ENV_FALLBACK.types.includes(type), `${type} is missing from the shipped fallback`);
    assert.equal(gateKindOf(`${type} 8`, true, vocab), 'auto', `${type} must not demand a person`);
    assert.ok(!vocab.human.includes(type), `${type} is categorised human`);
    assert.ok(!vocab.ai.includes(type), `${type} is categorised ai`);
  }
});

// ---------------------------------------------------------------------------
// The three new vocabularies and their bash twins
// ---------------------------------------------------------------------------

/**
 * Every `.env` under `scripts/` is the bash twin of a JS owner under
 * `shared/`, and this is where the two are held together — the same pin
 * `decisions-model.test.ts` puts on `decisions.env`, for the three
 * vocabularies phase 2 adds. A word that exists on one side only is a board
 * that answers one way to the engine and another to the console.
 */
test('scripts/landing.env is landing-model.js, word for word', () => {
  const pairs: [string, readonly string[]][] = [
    ['LAND_POLICIES', LAND_POLICIES],
    ['GITLINK_POLICIES', GITLINK_POLICIES],
    ['CONFLICT_POLICIES', CONFLICT_POLICIES],
    ['BASE_BRANCH_WORDS', BASE_BRANCH_WORDS],
    ['LANDING_STATES', LANDING_STATES],
    ['PR_MERGED_STATES', PR_MERGED_STATES],
    ['ISOLATION_DIRECTIVES', ISOLATION_DIRECTIVES],
    ['WORKTREE_RETENTION', WORKTREE_RETENTION],
    ['WORKTREE_LOCK_PREFIXES', WORKTREE_LOCK_PREFIXES],
  ];
  for (const [name, list] of pairs) {
    const bash = fromBash('landing.env', name);
    assert.ok(bash.length > 0, `${name}: bash read an empty list — a typo in landing.env`);
    assert.equal(bash, list.join(' '), `${name} drifted between landing.env and landing-model.js`);
  }
  for (const [name, word] of [
    ['DEFAULT_LAND', DEFAULT_LAND],
    ['DEFAULT_GITLINK', DEFAULT_GITLINK],
    ['DEFAULT_CONFLICT', DEFAULT_CONFLICT],
    ['DEFAULT_BASE_BRANCH', DEFAULT_BASE_BRANCH],
    ['DEFAULT_RETENTION', DEFAULT_RETENTION],
  ] as const) {
    assert.equal(fromBash('landing.env', name), word, `${name} drifted`);
  }
  // bash 3.2 has no associative arrays, so the map is `policy:state` pairs.
  assert.equal(
    fromBash('landing.env', 'LANDED_BY_POLICY'),
    Object.entries(LANDED_BY_POLICY).map(([k, v]) => `${k}:${v}`).join(' '),
    'LANDED_BY_POLICY drifted between landing.env and landing-model.js',
  );
});

test('scripts/messages.env is message-model.js, word for word', () => {
  const pairs: [string, readonly string[]][] = [
    ['MESSAGE_KINDS', MESSAGE_KINDS],
    ['MESSAGE_SCHEMES', MESSAGE_SCHEMES],
    ['MESSAGE_DELIVER', MESSAGE_DELIVER],
    ['MESSAGE_PRIORITIES', MESSAGE_PRIORITIES],
    ['MESSAGE_STATES', MESSAGE_STATES],
    ['MESSAGE_VIAS', MESSAGE_VIAS],
    ['MESSAGE_REFUSALS', MESSAGE_REFUSALS],
    ['MESSAGING_WORDS', MESSAGING_WORDS],
  ];
  for (const [name, list] of pairs) {
    const bash = fromBash('messages.env', name);
    assert.ok(bash.length > 0, `${name}: bash read an empty list — a typo in messages.env`);
    assert.equal(bash, list.join(' '), `${name} drifted between messages.env and message-model.js`);
  }
  assert.equal(fromBash('messages.env', 'DEFAULT_MESSAGING'), DEFAULT_MESSAGING);
  assert.equal(fromBash('messages.env', 'MESSAGE_MAX_BYTES'), String(MESSAGE_MAX_BYTES));
  assert.equal(fromBash('messages.env', 'MESSAGE_MAX_PER_PHASE'), String(MESSAGE_MAX_PER_PHASE));
});

test('scripts/issues.env is issues-model.js, word for word', () => {
  const pairs: [string, readonly string[]][] = [
    ['ISSUE_MODES', ISSUE_MODES],
    ['ISSUE_ACTIONS', ISSUE_ACTIONS],
    ['ISSUE_STATES', ISSUE_STATES],
    ['ISSUE_FIELDS', ISSUE_FIELDS],
  ];
  for (const [name, list] of pairs) {
    const bash = fromBash('issues.env', name);
    assert.ok(bash.length > 0, `${name}: bash read an empty list — a typo in issues.env`);
    assert.equal(bash, list.join(' '), `${name} drifted between issues.env and issues-model.js`);
  }
  assert.equal(fromBash('issues.env', 'DEFAULT_ISSUES'), DEFAULT_ISSUES);
  assert.equal(fromBash('issues.env', 'ISSUE_BUDGET_PHASE'), String(ISSUE_BUDGETS.phase));
  assert.equal(fromBash('issues.env', 'ISSUE_BUDGET_RUN'), String(ISSUE_BUDGETS.run));
});

test('every key the readers look for is present in each new .env', () => {
  const wanted: Record<string, string[]> = {
    'landing.env': [
      'LAND_POLICIES', 'DEFAULT_LAND', 'GITLINK_POLICIES', 'DEFAULT_GITLINK',
      'CONFLICT_POLICIES', 'DEFAULT_CONFLICT', 'BASE_BRANCH_WORDS', 'DEFAULT_BASE_BRANCH',
      'LANDING_STATES', 'LANDED_BY_POLICY', 'PR_MERGED_STATES',
      'ISOLATION_DIRECTIVES', 'WORKTREE_RETENTION', 'DEFAULT_RETENTION', 'WORKTREE_LOCK_PREFIXES',
    ],
    'messages.env': [
      'MESSAGE_KINDS', 'MESSAGE_SCHEMES', 'MESSAGE_DELIVER', 'MESSAGE_PRIORITIES',
      'MESSAGE_STATES', 'MESSAGE_VIAS', 'MESSAGE_REFUSALS', 'MESSAGING_WORDS', 'DEFAULT_MESSAGING',
    ],
    'issues.env': ['ISSUE_MODES', 'DEFAULT_ISSUES', 'ISSUE_ACTIONS', 'ISSUE_STATES', 'ISSUE_FIELDS'],
  };
  for (const [file, keys] of Object.entries(wanted)) {
    const text = readFileSync(join(SCRIPTS, file), 'utf8');
    for (const key of keys) {
      assert.match(text, new RegExp(`^${key}=`, 'm'), `${key} is missing from ${file}`);
    }
  }
});

// ---------------------------------------------------------------------------
// What the words mean
// ---------------------------------------------------------------------------

test('landPolicyOf coerces to a policy and never invents one', () => {
  for (const word of LAND_POLICIES) assert.equal(landPolicyOf(word), word);
  assert.equal(landPolicyOf('PR'), 'pr', 'case is not a different policy');
  assert.equal(landPolicyOf('  trunk '), 'trunk');
  for (const nonsense of ['sometimes', '', undefined, null, 42, {}]) {
    assert.equal(landPolicyOf(nonsense as never), DEFAULT_LAND, `${JSON.stringify(nonsense)} is not a policy`);
  }
  assert.equal(DEFAULT_LAND, 'hold', 'a plan that says nothing lands nothing — the option table');
});

test('every policy names the landing state that satisfies a `landed` gate', () => {
  assert.deepEqual(Object.keys(LANDED_BY_POLICY).sort(), [...LAND_POLICIES].sort(),
    'a policy with no landed-state would make `landed N` unanswerable for it');
  for (const [policy, state] of Object.entries(LANDED_BY_POLICY)) {
    assert.ok(LANDING_STATES.includes(state as never), `${policy} lands in "${state}", which is not a landing state`);
  }
  for (const state of PR_MERGED_STATES) {
    assert.ok(LANDING_STATES.includes(state as never), `${state} is not a landing state`);
  }
});

test('an address round-trips, and an unknown scheme is not one', () => {
  for (const scheme of MESSAGE_SCHEMES) {
    const address = formatAddress({ scheme, target: '4' });
    assert.deepEqual(parseAddress(address), { scheme, target: '4' }, `${scheme} did not round-trip`);
  }
  assert.deepEqual(parseAddress('phase:4'), { scheme: 'phase', target: '4' });
  assert.equal(parseAddress('operator'), undefined, 'a bare word names no scheme');
  assert.equal(parseAddress('carrier-pigeon:4'), undefined, 'an unknown scheme is refused, never guessed');
  assert.equal(parseAddress(''), undefined);
  // `all` and `operator` address nobody in particular; the target may be empty.
  assert.deepEqual(parseAddress('all:'), { scheme: 'all', target: '' });
});

test('an issue fingerprint is stable, and different issues differ', () => {
  const draft = { repo: 'phased-execution', action: 'file' as const, title: 'the lock leaks', body: 'a body' };
  assert.equal(issueFingerprint(draft), issueFingerprint({ ...draft }), 'the same draft twice is one issue');
  assert.notEqual(issueFingerprint(draft), issueFingerprint({ ...draft, title: 'something else' }));
  assert.notEqual(issueFingerprint(draft), issueFingerprint({ ...draft, repo: 'phase-console-site' }));
  assert.equal(issueFingerprint(draft), issueFingerprint({ ...draft, body: 'a different body' }),
    'the BODY is not part of the identity — a session rewording the same finding must dedupe');
  assert.match(issueFingerprint(draft), /^[0-9a-f]{12}$/, 'a short hex digest, like a ruling id');
  assert.deepEqual(ISSUE_BUDGETS, { phase: 3, run: 10 }, 'the option table names these numbers');
});

test('worktree retention reads its words and its ttl', () => {
  for (const word of WORKTREE_RETENTION) assert.equal(retentionOf(word), word);
  assert.equal(retentionOf(undefined), DEFAULT_RETENTION);
  assert.equal(retentionOf('nonsense'), DEFAULT_RETENTION, 'an unknown word keeps the default, never a stricter one');
  assert.equal(DEFAULT_RETENTION, 'keep-on-failure', 'the option table');
  assert.equal(retentionOf('ttl:48'), 'ttl:48', 'the one parameterised member');
  assert.equal(retentionTtlHours('ttl:48'), 48);
  assert.equal(retentionTtlHours('ttl:0'), undefined, 'zero hours is not a lifetime');
  assert.equal(retentionTtlHours('ttl:-3'), undefined);
  assert.equal(retentionTtlHours('ttl:soon'), undefined);
  assert.equal(retentionOf('ttl:soon'), DEFAULT_RETENTION, 'an unreadable ttl is not a retention');
  assert.equal(retentionTtlHours('keep'), undefined);
  assert.equal(DEFAULT_ISOLATION_FOR_NEW_BRANCH, true, 'decision 13: a new-branch run is isolated by default');
  assert.deepEqual([...ISOLATION_DIRECTIVES], ['shared', 'worktree'], 'the per-phase words of the option table');
});
