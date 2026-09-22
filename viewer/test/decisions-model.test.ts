/**
 * The decision manifest's vocabulary and parser (chapter 13 §1.1): the
 * seventeen keys owned once in `shared/decisions-model.js`, the bash twin
 * `scripts/decisions.env` held to it word for word by asking BASH (not by
 * reading the file a second time in JS), the table parser both engines' rows
 * are compared through, the merge order (plan → twin → phase rows) and the
 * TSV wire shape `phase-graph.sh --decisions` prints. `engine-parity.test.ts`
 * holds the bash engine to these same functions over the fixture corpus.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import {
  DECISION_KEYS,
  DECISION_STATES,
  DECISION_SOURCES,
  NEED_CLASSES,
  DECISION_KEY_OF_NEED,
  decisionKeyOfNeed,
  isNeedWord,
  parseDecisionsTable,
  decisionRowsFromCells,
  mergeDecisions,
  formatDecisionsTsv,
  parseDecisionsTsv,
  type DecisionRow,
} from '../shared/decisions-model.js';
import { SKILL_DIR } from '../server/config.ts';

const SCRIPTS = join(SKILL_DIR, 'scripts');

function fromBash(name: string): string {
  return execFileSync('bash', ['-c', `. "${SCRIPTS}/decisions.env"; printf '%s' "$${name}"`], {
    encoding: 'utf8',
  });
}

test('scripts/decisions.env is the JS owner, word for word — every list', () => {
  const pairs: [string, readonly string[]][] = [
    ['DECISION_KEYS', DECISION_KEYS],
    ['DECISION_STATES', DECISION_STATES],
    ['DECISION_SOURCES', DECISION_SOURCES],
    ['NEED_CLASSES', NEED_CLASSES],
  ];
  for (const [name, list] of pairs) {
    const bash = fromBash(name);
    assert.ok(bash.length > 0, `${name}: bash read an empty list — a typo in decisions.env would silence --needs`);
    assert.equal(bash, list.join(' '), `${name} drifted between decisions.env and decisions-model.js`);
  }
});

test('the vocabulary is closed and its members are well-formed', () => {
  assert.equal(DECISION_KEYS.length, 18, 'chapter 13 §1.1\'s seventeen keys, plus `issues` (5.1.0)');
  assert.ok(
    (DECISION_KEYS as readonly string[]).includes('issues'),
    'whether a session may open an issue is a decision a run needs and nobody was asking',
  );
  assert.equal(new Set(DECISION_KEYS).size, DECISION_KEYS.length, 'no key twice');
  for (const k of DECISION_KEYS) assert.match(k, /^[a-z][a-z0-9.-]*$/, `key "${k}" is not a bare lower-case word`);
  for (const c of NEED_CLASSES) {
    assert.ok(c in DECISION_KEY_OF_NEED, `blocker class "${c}" points at no row`);
    const key = DECISION_KEY_OF_NEED[c];
    if (key !== null) assert.ok((DECISION_KEYS as readonly string[]).includes(key), `${c} → ${key} is not a key`);
    assert.ok(!(DECISION_KEYS as readonly string[]).includes(c), `"${c}" is both a class and a key — ambiguous`);
  }
});

test('--needs words: a key answers itself, a class answers its row, lock answers nothing', () => {
  assert.equal(decisionKeyOfNeed('credential'), 'credentials');
  assert.equal(decisionKeyOfNeed('credentials'), 'credentials');
  assert.equal(decisionKeyOfNeed('permission'), 'permission.policy');
  assert.equal(decisionKeyOfNeed('gate'), 'gates');
  assert.equal(decisionKeyOfNeed('external'), 'waits');
  assert.equal(decisionKeyOfNeed('lock'), null);
  assert.equal(decisionKeyOfNeed('unknown'), null, '`unknown` is what the classifier says, never a need');
  assert.equal(decisionKeyOfNeed(undefined), null);
  assert.equal(isNeedWord('lock'), true);
  assert.equal(isNeedWord('budgets'), true);
  assert.equal(isNeedWord('unknown'), false);
  assert.equal(isNeedWord(''), false);
});

const TABLE = [
  'This plan\'s manifest. Prose above the table is ignored.',
  '',
  '| key | value | owner | state | blocking | source | evidence |',
  '|---|---|---|---|---|---|---|',
  '| `credentials` | `gh` and the machine `claude` login | operator | answered | yes | plan | errand E7 |',
  '| **`gates`** | `Gate-check` on 22 and 23 | operator | **answered** | no | plan | phases 22–23 |',
  '| `waits` | | dev-lead | outstanding | yes | plan | |',
  '| `qa.exhausted` | QA is off | operator | waived | no | plan | decision 4 |',
  '| `relay` | off | operator | answered | TRUE | plan | |',
  '| `made-up` | ? | | outstanding | no | | |',
  '',
  'A sentence after the table, and a second table that must NOT be read:',
  '',
  '| key | state |',
  '|---|---|',
  '| `stop` | answered |',
].join('\n');

test('parseDecisionsTable: columns by name, bold and backticks stripped, first table only', () => {
  const rows = parseDecisionsTable(TABLE);
  assert.deepEqual(
    rows.map((r) => r.key),
    ['credentials', 'gates', 'waits', 'qa.exhausted', 'relay', 'made-up'],
  );
  const gates = rows.find((r) => r.key === 'gates')!;
  assert.equal(gates.state, 'answered', 'bold stripped from the state');
  assert.equal(gates.value, '`Gate-check` on 22 and 23', 'the value keeps its backticks');
  assert.equal(gates.evidence, 'phases 22–23');
  const waits = rows.find((r) => r.key === 'waits')!;
  assert.deepEqual([waits.owner, waits.state, waits.blocking, waits.value], ['dev-lead', 'outstanding', 'yes', '']);
  assert.equal(rows.find((r) => r.key === 'relay')!.blocking, 'yes', 'TRUE normalises to yes');
  assert.equal(rows.find((r) => r.key === 'qa.exhausted')!.blocking, 'no');
  const unknown = rows.find((r) => r.key === 'made-up')!;
  assert.deepEqual([unknown.owner, unknown.source, unknown.state], ['', '', 'outstanding'], 'an unknown key is kept for the lint to name');
  for (const r of rows) assert.equal(r.phase, null, 'no phase column ⇒ plan-wide');
});

test('parseDecisionsTable: `after` finds the table under a heading, and a fenced example is skipped', () => {
  const doc = [
    '# Decisions — demo',
    '',
    '```',
    '| key | state |',
    '|---|---|',
    '| `stop` | answered |',
    '```',
    '',
    '## Decisions',
    '',
    '| key | value | owner | state | blocking | source | evidence | phase |',
    '|---|---|---|---|---|---|---|---|',
    '| `credentials` | `gh` | op | answered | yes | run | decisions.sh | — |',
    '| `credentials` | `gh`, `npm` | op | answered | yes | run | decisions.sh | 4 |',
  ].join('\n');
  const rows = parseDecisionsTable(doc, { after: /^##\s+Decisions/i });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].phase, null, '— is plan-wide');
  assert.equal(rows[1].phase, 4);
  assert.deepEqual(parseDecisionsTable(doc, { after: /^##\s+Nothing/ }), [], 'no heading ⇒ no rows');
  assert.deepEqual(parseDecisionsTable('just prose\n\n- a bullet\n'), []);
});

test('decisionRowsFromCells: no key column ⇒ nothing; a blank key row is skipped; a missing column reads empty', () => {
  assert.deepEqual(decisionRowsFromCells(['value', 'owner'], [['x', 'y']]), []);
  const rows = decisionRowsFromCells(['key', 'state'], [['`gates`', 'answered'], ['', 'answered'], ['---', '---']]);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    [rows[0].value, rows[0].owner, rows[0].blocking, rows[0].source, rows[0].evidence, rows[0].phase],
    ['', '', 'no', '', '', null],
  );
});

function row(over: Partial<DecisionRow> & { key: string }): DecisionRow {
  return {
    value: '',
    owner: 'operator',
    state: 'answered',
    blocking: 'no',
    source: 'plan',
    evidence: '',
    phase: null,
    ...over,
  };
}

test('mergeDecisions: twin over plan, phase rows over both, DECISION_KEYS order, unknown keys last', () => {
  const plan = [
    row({ key: 'relay', value: 'off' }),
    row({ key: 'credentials', value: 'gh', state: 'outstanding', blocking: 'yes' }),
    row({ key: 'zzz-custom', value: 'plan-custom' }),
    row({ key: 'credentials', value: 'gh + npm (plan, phase 4)', phase: 4 }),
  ];
  const twin = [
    row({ key: 'credentials', value: 'gh (answered at run)', source: 'run' }),
    row({ key: 'accounts', value: 'default:20', source: 'run' }),
    row({ key: 'credentials', value: 'gh + npm (twin, phase 4)', source: 'run', phase: 4 }),
    row({ key: 'waits', value: 'phase 6 only', source: 'run', phase: 6 }),
  ];
  const planWide = mergeDecisions(plan, twin);
  assert.deepEqual(
    planWide.map((r) => `${r.key}=${r.value}`),
    ['credentials=gh (answered at run)', 'accounts=default:20', 'relay=off', 'zzz-custom=plan-custom'],
    'plan-wide: twin replaces the plan row whole; phase-scoped rows are excluded; keys in vocabulary order',
  );
  assert.equal(planWide[0].source, 'run', 'the whole row is replaced, not merged field by field');
  const p4 = mergeDecisions(plan, twin, 4);
  assert.equal(p4.find((r) => r.key === 'credentials')!.value, 'gh + npm (twin, phase 4)');
  assert.equal(p4.find((r) => r.key === 'waits'), undefined, 'phase 6\'s row is not phase 4\'s');
  const p6 = mergeDecisions(plan, twin, 6);
  assert.equal(p6.find((r) => r.key === 'waits')!.value, 'phase 6 only');
  assert.equal(p6.find((r) => r.key === 'credentials')!.value, 'gh (answered at run)', 'no phase-6 row ⇒ the plan-wide answer');
  assert.deepEqual(mergeDecisions([], []), []);
});

test('the TSV wire shape round-trips, and tabs in a value never become a seventh column', () => {
  const rows = [
    row({ key: 'credentials', value: 'gh\tand\nclaude', owner: 'operator', state: 'answered', blocking: 'yes', source: 'plan', evidence: 'kept off the wire' }),
    row({ key: 'stop', value: 'keep-going' }),
  ];
  const tsv = formatDecisionsTsv(rows);
  assert.equal(tsv, 'credentials\tanswered\toperator\tyes\tplan\tgh and claude\nstop\tanswered\toperator\tno\tplan\tkeep-going');
  const back = parseDecisionsTsv(tsv + '\n', 3);
  assert.equal(back.length, 2);
  assert.deepEqual(
    [back[0].key, back[0].state, back[0].owner, back[0].blocking, back[0].source, back[0].value, back[0].evidence, back[0].phase],
    ['credentials', 'answered', 'operator', 'yes', 'plan', 'gh and claude', '', 3],
  );
  assert.deepEqual(parseDecisionsTsv(''), []);
  assert.equal(formatDecisionsTsv([]), '');
});

test('subKindOfNeed: a class is its own sub-kind, a key answers through its class, the rest fall to prose', async () => {
  const { subKindOfNeed } = await import('../shared/decisions-model.js');
  const { SUB_KINDS } = await import('../shared/situation-model.js');
  assert.deepEqual([...NEED_CLASSES], SUB_KINDS['blocked-declared'].filter((k) => k !== 'unknown'), 'derived, never re-spelled');
  assert.equal(subKindOfNeed('credential'), 'credential');
  assert.equal(subKindOfNeed('credentials'), 'credential');
  assert.equal(subKindOfNeed('permission.policy'), 'permission');
  assert.equal(subKindOfNeed('permission.destructive'), 'permission');
  assert.equal(subKindOfNeed('gates'), 'gate');
  assert.equal(subKindOfNeed('waits'), 'external');
  assert.equal(subKindOfNeed('lock'), 'lock');
  assert.equal(subKindOfNeed('budgets'), null, 'no class points at budgets — prose decides');
  assert.equal(subKindOfNeed('unknown'), null);
  assert.equal(subKindOfNeed(undefined), null);
});
