/**
 * The policy table (phase 11, ZTD-10 / QRL-3): 19 classes, each tied to one
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
  TRUNK_BRANCHES, answerOf, decisionKeyOfSituation, destructiveCommandExceptions, destructiveExceptions, destructivePushBranches, exceptionPhases, isAnswerWord, isAutomaticAnswer, policyRowOf, releasePhasesOf, resolvePolicy, unresolvedPhaseSets,
  sanitisePolicyPrefs,
} from '../shared/policy-model.js';
import { keyedAsks } from '../server/runner/ladder.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

test('19 classes, each with one manifest key, in the audit\'s order; the vocabularies are what the plan format documents', () => {
  assert.equal(POLICY_TABLE.length, 19);
  assert.deepEqual(POLICY_TABLE.map((r) => r.class), [...POLICY_CLASSES]);
  assert.equal(new Set(POLICY_CLASSES).size, 19);
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

test('#112 (control-tower phase 84): a row names push branches narrowly — never a trunk, never after a refusal — and the clause split still reads its exceptions', () => {
  assert.deepEqual([...TRUNK_BRANCHES], ['main', 'master', 'trunk']);
  const row = 'deny; allow `Bash(gh pr create:*)`; may publish: branch pushes to `pe/demo` + `main`, and never push to `release/1.0`';
  assert.deepEqual(destructivePushBranches(row), ['pe/demo'], 'the trunk and the refused branch are not read');
  assert.deepEqual(destructiveExceptions(row), ['Bash(gh pr create:*)'], 'the exception reader is unchanged by the shared splitter');
  assert.deepEqual(destructivePushBranches('deny — may publish: branch pushes to `pe/demo`'), ['pe/demo'],
    'a policy word far from the phrase does not negate it');
});

test('#205 (control-tower phase 107): a row\'s exceptions are read PER PHASE — a phase-qualified list, named options, and the clause that ends it', () => {
  // ai-builder-v7's row, verbatim: the opener is "with these allow rows:", which the classic reader never saw.
  const row = 'deny, with these allow rows: Phase 1 — `gh label create`, `gh issue create`; Phases 4/17/22 — `gh pr create`, `gh pr merge --squash --delete-branch`, `gh issue close`, `gh issue comment`, the direct pathspec pushes …; every phase — `git push` of `pe/ai-builder-v7` as a backup …';
  const entries = destructiveCommandExceptions(row);
  const of = (verb: string) => entries.find((e) => e.verb.join(' ') === verb);
  assert.deepEqual(of('gh label create')?.phases, [1]);
  assert.deepEqual(of('gh pr create')?.phases, [4, 17, 22]);
  assert.deepEqual(of('gh pr merge')?.options, ['--squash', '--delete-branch'], 'the options a named command must carry');
  assert.equal(of('gh pr create')?.rule, 'Bash(gh pr create:*)');
  assert.equal(of('git push'), undefined, 'a push in a list is never a whole rule: its BRANCH is what the clause names');
  assert.deepEqual(destructiveExceptions(row, { phase: 4 }).sort(),
    ['Bash(gh issue close:*)', 'Bash(gh issue comment:*)', 'Bash(gh pr create:*)', 'Bash(gh pr merge --squash --delete-branch:*)']);
  assert.deepEqual(destructiveExceptions(row, { phase: 1 }).sort(), ['Bash(gh issue create:*)', 'Bash(gh label create:*)']);
  assert.deepEqual(destructiveExceptions(row, { phase: 9 }), [], 'phase 9 is named by no list');
  assert.deepEqual(destructivePushBranches(row, { phase: 9 }), ['pe/ai-builder-v7'], 'every phase — the backup push');

  // Phase lists as rows write them.
  for (const [value, phases] of [
    ['deny, with these allow rows: Phases 4, 17 and 22 — `gh pr create`', [4, 17, 22]],
    ['deny, with these allow rows: Phases 4–6: `gh pr create`', [4, 5, 6]],
    ['deny; allow `gh release create` in phases 1 and 35', [1, 35]],
    ['deny; allow `Bash(npm publish:*)` — phase 74 ONLY', [74]],
    ['deny; allow `gh pr create`', null],
  ] as [string, number[] | null][]) {
    assert.deepEqual(destructiveCommandExceptions(value)[0]?.phases, phases, value);
  }
  // A list runs on across `;` only into clauses that open with a phase and refuse nothing.
  const refusing = 'deny, with these allow rows: Phases 4/17 — `gh pr create`; Phase 9 — never `gh pr merge`; `gh issue close` later';
  assert.deepEqual(destructiveCommandExceptions(refusing).map((e) => e.verb.join(' ')), ['gh pr create']);
  const ended = 'deny, with these allow rows: Phase 2 — `gh pr create`. Phase 3 — `gh pr merge`';
  assert.deepEqual(destructiveCommandExceptions(ended).map((e) => e.verb.join(' ')), ['gh pr create'], 'a full stop ends the list');
  // A branch or a path in the list is not a command.
  assert.deepEqual(destructiveCommandExceptions('deny, with these allow rows: every phase — `pe/x`, `docs/`, `gh pr create`')
    .map((e) => e.verb.join(' ')), ['gh pr create']);
  // The classic opener keeps TRS-4's reading: `git push` there IS the whole rule.
  assert.deepEqual(destructiveExceptions('deny; allow `git push`'), ['Bash(git push:*)']);
});

test('issues-sweep-hub-tb-hz Phase 30 (2026-10-06): a row that allows a command "in the release phases" names those phases once the plan resolves them — and nothing more until it does', () => {
  // The sweep plan's row, verbatim, and a phase graph with two release phases (titles opening with `Release`).
  const row = 'deny; allow `git push` of `pe/issues-sweep-hub-tb-hz`, of an annotated `archive/*` tag and (Phase 21) of the SDK tag and the release-please branch, always as `git -C <absolute repo path> push origin <branch>` alone in its call; allow `gh pr create`, `gh pr merge --squash --delete-branch` and `gh pr close --delete-branch` in the release phases and in Phases 13, 15, 16, 21, 33, 40 and 41; allow `gh issue edit`, `gh issue comment`, `gh issue close` and `gh label create` on the ten repos; never force-push, never move a tag';
  const graph = [
    { phase: 24, title: 'Hetzner wave B — register-lint, pre-push, pin-bot cadence' },
    { phase: 30, title: 'Release B1 — aws → hetzner (box #1)' },
    { phase: 31, title: 'Release B2 — backend → frontend → root (box #2)' },
    { phase: 33, title: 'Owner sitting: aws #253 #262' },
  ];
  const releasePhases = releasePhasesOf(graph);
  assert.deepEqual(releasePhases, [30, 31]);
  const publishing = ['Bash(gh pr create:*)', 'Bash(gh pr merge --squash --delete-branch:*)', 'Bash(gh pr close --delete-branch:*)'];
  const named = (phase: number, ctx: { releasePhases?: number[] } = {}) =>
    publishing.filter((rule) => destructiveExceptions(row, { phase, ...ctx }).includes(rule));
  assert.deepEqual(named(30, { releasePhases }), publishing, 'Phase 30 is a release phase');
  assert.deepEqual(named(33, { releasePhases }), publishing, 'Phase 33 is named by number');
  assert.deepEqual(named(30), [], 'unresolved, the words name nothing — narrower, never wider');
  assert.deepEqual(named(24, { releasePhases }), [], 'a build phase is neither');
  const entry = destructiveCommandExceptions(row).find((e) => e.rule === 'Bash(gh pr create:*)')!;
  assert.deepEqual(entry.phases, [13, 15, 16, 21, 33, 40, 41], 'the numbers, as the old reader had them');
  assert.deepEqual(entry.sets, ['release'], 'and the set it also wrote');
  assert.deepEqual(exceptionPhases(entry, { releasePhases }), [13, 15, 16, 21, 30, 31, 33, 40, 41]);
  assert.deepEqual(unresolvedPhaseSets(row, { releasePhases: [] }), ['release'], 'what a lint names: a set the plan resolves to nothing');
  assert.deepEqual(unresolvedPhaseSets(row, { releasePhases }), []);
  assert.ok(destructiveExceptions(row, { phase: 24 }).includes('Bash(git push:*)'), 'the classic push rule is every phase\'s, as before');
  // The leading form, `every release phase`, two lists in one clause (the union, where the first alone was read), a qualified push.
  assert.deepEqual(destructiveCommandExceptions('deny, with these allow rows: the release phases — `gh pr merge --squash`; Phase 2 — `gh issue close`')
    .map((e) => [e.rule, e.phases, e.sets]), [['Bash(gh pr merge --squash:*)', [], ['release']], ['Bash(gh issue close:*)', [2], []]]);
  assert.deepEqual(destructiveExceptions('deny; allow `gh pr create` in every release phase', { phase: 7, releasePhases: [7] }), ['Bash(gh pr create:*)']);
  assert.deepEqual(destructiveExceptions('deny; allow `gh pr create` in every release phase', { phase: 7, releasePhases: [8] }), []);
  assert.deepEqual(destructiveCommandExceptions('deny; allow `gh pr create` in phases 4 and 5 and in phases 7 and 8')[0]?.phases, [4, 5, 7, 8]);
  assert.deepEqual(destructivePushBranches('deny; in the release phases push to `rel/x`', { phase: 30, releasePhases: [30] }), ['rel/x']);
  assert.deepEqual(destructivePushBranches('deny; in the release phases push to `rel/x`', { phase: 30 }), []);
});
