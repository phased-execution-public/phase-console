/**
 * The policy table (phase 11, ZTD-10 / QRL-3): 18 classes, each tied to one
 * manifest key; every ask the ladder can raise governed by exactly one class;
 * every journal name in the table a real row of `docs/journal-events.md`;
 * the answer vocabularies the plan format documents; the resolution order
 * run → plan → console → shipped default; and the shipped defaults the
 * operator chose (decision 11).
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DECISION_KEYS } from '../shared/decisions-model.js';
import { MCP_POLICIES } from '../shared/run-lifecycle.js';
import { RELAY_MODES, RELAY_CLI_FLOOR } from '../shared/run-settings.js';
import { PROBE_STATUSES } from '../shared/ops-vocab.js';
import { SITUATIONS, SUB_KINDS, situationKey } from '../shared/situation-model.js';
import {
  DECISION_ANSWERS, MANIFEST_BLOCKING, OWNER_KEYS, POLICY_CLASSES, POLICY_DEFAULTS, POLICY_SOURCES, POLICY_TABLE,
  answerOf, decisionKeyOfSituation, destructiveExceptions, isAnswerWord, isAutomaticAnswer, policyRowOf, resolvePolicy,
  sanitisePolicyPrefs,
} from '../shared/policy-model.js';
import { keyedAsks } from '../server/runner/ladder.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

test('18 classes, each with one manifest key, in the audit\'s order; the vocabularies are what the plan format documents', () => {
  assert.equal(POLICY_TABLE.length, 18);
  assert.deepEqual(POLICY_TABLE.map((r) => r.class), [...POLICY_CLASSES]);
  assert.equal(new Set(POLICY_CLASSES).size, 18);
  for (const row of POLICY_TABLE) {
    assert.ok((DECISION_KEYS as readonly string[]).includes(row.decisionKey), `${row.class} → ${row.decisionKey}`);
    assert.ok(row.blurb.length > 20, `${row.class} blurb`);
    const answers = DECISION_ANSWERS[row.decisionKey];
    for (const word of row.automatic) {
      assert.ok(answers?.includes(word), `${row.class}: automatic word ${word} is not an answer of ${row.decisionKey}`);
    }
  }
  assert.deepEqual(Object.keys(DECISION_ANSWERS).sort(), [...DECISION_KEYS].sort());
  assert.equal(DECISION_ANSWERS.credentials, MCP_POLICIES, 'credentials answers ARE the MCP policies, by identity');
  assert.equal(DECISION_ANSWERS.mcp, MCP_POLICIES);
  assert.equal(DECISION_ANSWERS.relay, RELAY_MODES);
  assert.deepEqual([...RELAY_MODES], ['off', 'last-resort']);
  assert.match(RELAY_CLI_FLOOR, /^2\.1\.268$/);
  assert.deepEqual([...PROBE_STATUSES], ['ok', 'fail', 'skip']);
  assert.deepEqual([...POLICY_SOURCES], ['run', 'plan', 'console', 'default']);
  assert.deepEqual([...OWNER_KEYS], ['qa.exhausted', 'verification.person-check']);
  // Decision 11, verbatim.
  assert.equal(POLICY_DEFAULTS.gates, 'delegated');
  assert.equal(POLICY_DEFAULTS['qa.exhausted'], 'waive');
  assert.equal(POLICY_DEFAULTS['resume.on-restart'], 'continue');
  assert.equal(POLICY_DEFAULTS.ambiguity, 'ruling');
  for (const [key, word] of Object.entries(POLICY_DEFAULTS)) {
    assert.ok(isAnswerWord(key as (typeof DECISION_KEYS)[number], word), `default ${key}=${word} is not an answer word`);
  }
});

test('every ask the ladder can raise is governed by exactly one class, and every situation resolves to a key', () => {
  const seen = new Map<string, string>();
  for (const row of POLICY_TABLE) {
    for (const entry of row.situations) {
      const key = typeof entry === 'string' ? entry : entry[0];
      assert.ok(!seen.has(key), `${key} is governed by both ${seen.get(key)} and ${row.class}`);
      seen.set(key, row.class);
    }
  }
  for (const key of Object.keys(keyedAsks())) {
    assert.ok(seen.has(key), `ask ${key} is governed by no class`);
  }
  for (const id of SITUATIONS) {
    for (const key of [id, ...(SUB_KINDS[id] ?? []).map((sub) => situationKey(id, sub))]) {
      assert.ok((DECISION_KEYS as readonly string[]).includes(decisionKeyOfSituation(key)), key);
    }
  }
  // A situation the table never met files as plan health, never throws.
  assert.equal(decisionKeyOfSituation('something:new'), 'plan-health');
  assert.equal(policyRowOf('something:new').row.class, 'plan-health');
  // The two tuple overrides: the budget wall and the ladder-exhausted phases.
  assert.equal(decisionKeyOfSituation('resource-wall:budget'), 'budgets');
  assert.equal(decisionKeyOfSituation('resource-wall:usage'), 'accounts');
  assert.equal(decisionKeyOfSituation('work-in-progress'), 'budgets');
  assert.equal(decisionKeyOfSituation('never-started:refusal'), 'plan-health');
});

test('every journal name the table carries is a row of docs/journal-events.md', () => {
  const doc = readFileSync(join(REPO, 'docs', 'journal-events.md'), 'utf8');
  const rows = new Set([...doc.matchAll(/^\| `((?:phase|run|policy)\.[a-z0-9.-]+)` \|/gm)].map((m) => m[1]));
  for (const row of POLICY_TABLE) {
    assert.ok(rows.has(row.journal), `${row.class} names ${row.journal}, which docs/journal-events.md does not list`);
  }
});

test('MANIFEST_BLOCKING is the plan template\'s blocking set', () => {
  const template = readFileSync(join(REPO, 'templates', 'plan.md'), 'utf8');
  const blocking = [...template.matchAll(/^\| `([a-z.-]+)` \|[^|]*\|[^|]*\|[^|]*\| yes \|/gm)].map((m) => m[1]);
  assert.deepEqual([...MANIFEST_BLOCKING].sort(), blocking.sort());
});

test('answerOf reads the word a row states — first member, an owner only when the value IS one name', () => {
  assert.equal(answerOf('credentials', '`gh` (signed in) and the machine `claude` login; `credential policy: require`'), 'require');
  assert.equal(answerOf('gates', '`Gate-check` on phases 22 (`cmd`) and 23 (`cmd`); `Gates: delegated`'), 'delegated');
  assert.equal(answerOf('qa.exhausted', 'n/a — QA off'), null, 'four tokens, no member, no owner');
  assert.equal(answerOf('qa.exhausted', 'dev-lead'), 'dev-lead');
  assert.equal(answerOf('qa.exhausted', '**waive**'), 'waive');
  assert.equal(answerOf('verification.person-check', 'halt — every §Verification line is runnable'), 'halt');
  assert.equal(answerOf('resume.on-restart', 'continue'), 'continue');
  assert.equal(answerOf('budgets', 'per phase ≤ $150, per session ≤ $300'), 'per phase ≤ $150, per session ≤ $300');
  assert.equal(answerOf('relay', 'off — every phase is hand-driven'), 'off');
  assert.equal(answerOf('gates', ''), null);
  assert.equal(answerOf('gates', undefined), null);
  assert.equal(isAnswerWord('ambiguity', 'ruling'), true);
  assert.equal(isAnswerWord('ambiguity', 'shrug'), false);
  assert.equal(isAnswerWord('qa.exhausted', 'someone@example.com'), true);
  assert.equal(isAnswerWord('gates', 'someone'), false, 'gates takes no owner');
});

test('resolvePolicy: run → plan → console → shipped default → null', () => {
  const plan = [
    { key: 'gates', state: 'answered', value: 'operator' },
    { key: 'qa.exhausted', state: 'outstanding', value: 'halt' },
    { key: 'resume.on-restart', state: 'answered', value: 'hold' },
  ];
  assert.deepEqual(resolvePolicy('gates', { plan }), { decisionKey: 'gates', answer: 'operator', source: 'plan' });
  // An outstanding row answers nothing — the console, then the default.
  assert.deepEqual(resolvePolicy('qa.exhausted', { plan }), { decisionKey: 'qa.exhausted', answer: 'waive', source: 'default' });
  assert.deepEqual(resolvePolicy('qa.exhausted', { plan, prefs: { policy: { 'qa.exhausted': 'halt' } } }),
    { decisionKey: 'qa.exhausted', answer: 'halt', source: 'console' });
  // The run's own answer outranks the plan row.
  assert.deepEqual(resolvePolicy('resume.on-restart', { plan, run: { resumeOnRestart: true } }),
    { decisionKey: 'resume.on-restart', answer: 'continue', source: 'run' });
  assert.deepEqual(resolvePolicy('resume.on-restart', { plan }),
    { decisionKey: 'resume.on-restart', answer: 'hold', source: 'plan' });
  assert.deepEqual(resolvePolicy('relay', { run: { relay: 'last-resort' } }),
    { decisionKey: 'relay', answer: 'last-resort', source: 'run' });
  assert.deepEqual(resolvePolicy('relay', { run: { relay: 'sideways' } }),
    { decisionKey: 'relay', answer: 'off', source: 'default' });
  // The legacy gates switch is the console's answer when no `policy.gates` is set…
  assert.deepEqual(resolvePolicy('gates', { prefs: { delegateHumanGates: false } }),
    { decisionKey: 'gates', answer: 'operator', source: 'console' });
  // …and `policy.gates` beats it.
  assert.deepEqual(resolvePolicy('gates', { prefs: { delegateHumanGates: false, policy: { gates: 'delegated' } } }),
    { decisionKey: 'gates', answer: 'delegated', source: 'console' });
  // A pref word outside the vocabulary is dropped, never believed.
  assert.deepEqual(resolvePolicy('ambiguity', { prefs: { policy: { ambiguity: 'whatever' } } }),
    { decisionKey: 'ambiguity', answer: 'ruling', source: 'default' });
  // A free-text key with nothing anywhere resolves to nothing.
  assert.equal(resolvePolicy('budgets', {}), null);
  assert.equal(resolvePolicy('human-acts', { plan: [{ key: 'human-acts', state: 'answered', value: 'E1, E2' }] })?.answer, 'E1, E2');
});

test('sanitisePolicyPrefs keeps legal words for closed keys, owner names for the owner keys, one line for the free-text keys, drops the rest', () => {
  assert.deepEqual(sanitisePolicyPrefs({
    gates: 'operator', 'qa.exhausted': 'dev-lead', budgets: 'phase ≤ $150', relay: 'nope', mcp: 'require', bogus: 'ruling',
  }), { mcp: 'require', gates: 'operator', 'qa.exhausted': 'dev-lead', budgets: 'phase ≤ $150' });
  assert.deepEqual(sanitisePolicyPrefs(null), {});
  assert.deepEqual(sanitisePolicyPrefs(['gates']), {});
  assert.deepEqual(sanitisePolicyPrefs({ gates: 7 }), {});
  // A free-text answer (phase 12's editor answers every row) is ONE line of at
  // most 200 characters, trimmed; blank, multi-line or longer is dropped.
  assert.deepEqual(sanitisePolicyPrefs({ stop: '  keep-going; page me  ', announce: 'a\nb', 'human-acts': 'x'.repeat(201), 'plan-health': '   ' }),
    { stop: 'keep-going; page me' });
});

test('isAutomaticAnswer: the class decides, the pinned class never answers', () => {
  assert.equal(isAutomaticAnswer('qa-failed', 'waive'), true);
  assert.equal(isAutomaticAnswer('qa-failed', 'halt'), false);
  assert.equal(isAutomaticAnswer('foreign-live', 'window'), true);
  assert.equal(isAutomaticAnswer('waiting-external', 'window'), false);
  assert.equal(isAutomaticAnswer('blocked-declared:unknown', 'ruling'), false);
  assert.equal(isAutomaticAnswer('blocked-declared', 'ask'), false);
  assert.equal(isAutomaticAnswer('gated-manual', 'delegated'), false);
  assert.equal(isAutomaticAnswer('gated-manual', null), false);
});

test('TRS-4: destructiveExceptions reads only a clause OPENED by allow — a refusal is never read as a permission', () => {
  // The exceptions a plan grants: backticked rules, whole or as a command prefix.
  assert.deepEqual(destructiveExceptions('deny; allow `Bash(gh pr create:*)`'), ['Bash(gh pr create:*)']);
  assert.deepEqual(destructiveExceptions('deny, allow `gh pr create`'), ['Bash(gh pr create:*)']);
  assert.deepEqual(destructiveExceptions('allow `git push`, `gh pr create`'), ['Bash(git push:*)', 'Bash(gh pr create:*)']);
  // A rule may carry a `.`, `,` or `;` inside its backticks.
  assert.deepEqual(destructiveExceptions('deny. Allow `Bash(./scripts/publish.sh:*)` in this phase'), ['Bash(./scripts/publish.sh:*)']);
  // What must name NOTHING: prose that merely contains the word, and the defaults.
  for (const value of [
    'deny — the wall does not allow `git push`',
    'deny, but never allow `git push`',
    'deny — the deny wall holds on every profile; no phase publishes',
    "deny; no phase publishes — the release is the operator's (E5)",
    'allow nothing here',
    '',
    null,
    undefined,
  ]) {
    assert.deepEqual(destructiveExceptions(value as never), [], `${JSON.stringify(value)} grants no exception`);
  }
});
